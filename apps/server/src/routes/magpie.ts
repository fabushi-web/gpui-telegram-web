import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  MagpieMaskingConfig,
  MagpieProviderView,
  MagpieRoutingGroup,
  MagpieUsageLedgerSummary,
} from '@gpui-telegram/protocol';
import type { ServerConfig } from '../config.js';
import { MAGPIE_BUILTIN_PRESETS } from '../db/seed.js';
import {
  decryptSecretAtRest,
  encryptSecretAtRest,
  maskApiKey,
  redactHeaders,
  runPrivacyMasking,
  unmaskPlaceholders,
} from '../utils/crypto.js';
import {
  ApiError,
  authenticateToken,
  beginSseStream,
  extractBearerToken,
  readJsonBody,
  requireAuth,
  sendJson,
  type HttpRouter,
  type RequestContext,
} from '../utils/http.js';

interface MagpieStateBlob {
  active_provider: string;
  active_model: string;
  allow_local_fallback: boolean;
  routing_strategy: string;
  routing_groups: MagpieRoutingGroup[];
  masking: MagpieMaskingConfig;
  subscriptions: Array<Record<string, unknown>>;
}

function getMagpieState(db: DatabaseSync, userId: number): MagpieStateBlob {
  const row = db
    .prepare(`SELECT state_json FROM magpie_state WHERE user_id = ?`)
    .get(userId) as { state_json: string } | undefined;
  if (row) {
    return JSON.parse(row.state_json) as MagpieStateBlob;
  }
  return {
    active_provider: 'local_hermes',
    active_model: 'hermes-local-v1',
    allow_local_fallback: true,
    routing_strategy: 'smart',
    routing_groups: [
      {
        id: 'default-smart',
        name: 'Smart Default Pool',
        strategy: 'smart',
        members: [{ target: 'local_hermes', weight: 100, enabled: true, free: true }],
        sticky_ttl_ms: 300_000,
      },
    ],
    masking: {
      enabled: true,
      mask_secrets: true,
      mask_personal: true,
      custom_words: [],
      allow_list: [],
      default_action: 'mask',
    },
    subscriptions: [],
  };
}

function saveMagpieState(db: DatabaseSync, userId: number, state: MagpieStateBlob): void {
  db.prepare(`
    INSERT OR REPLACE INTO magpie_state (user_id, state_json, updated_at_ms)
    VALUES (?, ?, ?)
  `).run(userId, JSON.stringify(state), Date.now());
}

export async function runConfiguredLlmCompletion(
  db: DatabaseSync,
  config: ServerConfig,
  userId: number,
  messages: Array<{ role: string; content: string }>,
  opts?: { providerId?: string; model?: string },
): Promise<{ text: string; usedUpstream: boolean; providerId: string; model: string; error?: string }> {
  const state = getMagpieState(db, userId);
  const providerId = opts?.providerId ?? state.active_provider;
  const model = opts?.model ?? state.active_model;

  // Try user's active configured provider first, or any enabled provider with a real upstream URL
  let provRow = db
    .prepare(
      `SELECT provider_id, provider_json, encrypted_api_key, key_nonce
       FROM magpie_providers
       WHERE user_id = ? AND provider_id = ?`,
    )
    .get(userId, providerId) as
    | { provider_id: string; provider_json: string; encrypted_api_key: string | null; key_nonce: string | null }
    | undefined;

  if (!provRow || provRow.provider_id === 'local_hermes') {
    provRow = db
      .prepare(
        `SELECT provider_id, provider_json, encrypted_api_key, key_nonce
         FROM magpie_providers
         WHERE user_id = ? AND provider_id != 'local_hermes'
         ORDER BY updated_at_ms DESC LIMIT 1`,
      )
      .get(userId) as
      | { provider_id: string; provider_json: string; encrypted_api_key: string | null; key_nonce: string | null }
      | undefined;
  }

  if (!provRow) {
    const gatewayKey = process.env.AI_GATEWAY_API_KEY?.trim();
    if (gatewayKey && /^https?:\/\//i.test(config.aiGatewayUrl)) {
      try {
        const base = config.aiGatewayUrl.replace(/\/+$/, '');
        const effectiveModel =
          opts?.model && opts.model !== 'hermes-local-v1'
            ? opts.model
            : process.env.AI_GATEWAY_MODEL?.trim() || 'gpt-4o-mini';
        const res = await fetch(`${base}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${gatewayKey}`,
          },
          body: JSON.stringify({ model: effectiveModel, messages, stream: false }),
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) {
          const json = (await res.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          const text = json.choices?.[0]?.message?.content ?? '';
          if (text) {
            return { text, usedUpstream: true, providerId: 'ombhrum_gateway', model: effectiveModel };
          }
        }
      } catch {
        // Fall through to unconfigured result
      }
    }
    return { text: '', usedUpstream: false, providerId, model };
  }

  const prov = JSON.parse(provRow.provider_json) as MagpieProviderView;
  if (prov.enabled === false || prov.api_mode === 'local_hermes' || !/^https?:\/\//i.test(prov.base_url)) {
    return { text: '', usedUpstream: false, providerId: prov.provider_id, model: prov.default_model };
  }

  try {
    const apiKey =
      provRow.encrypted_api_key && provRow.key_nonce
        ? decryptSecretAtRest(
            config.masterSecret,
            `magpie:${userId}:${prov.provider_id}`,
            provRow.encrypted_api_key,
            provRow.key_nonce,
          )
        : '';

    const effectiveModel = opts?.model && opts.model !== 'hermes-local-v1' ? opts.model : prov.default_model;
    const base = prov.base_url.replace(/\/+$/, '');
    let upstreamUrl = `${base}/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    let reqPayload: Record<string, unknown> = {
      model: effectiveModel,
      messages,
      stream: false,
    };

    if (prov.api_mode === 'anthropic_messages') {
      upstreamUrl = `${base}/messages`;
      if (apiKey) headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
      const sysMsg = messages.find((m) => m.role === 'system')?.content;
      reqPayload = {
        model: effectiveModel,
        max_tokens: 1024,
        ...(sysMsg ? { system: sysMsg } : {}),
        messages: messages.filter((m) => m.role !== 'system'),
      };
    } else if (prov.api_mode === 'gemini_generate_content') {
      upstreamUrl = `${base}/models/${encodeURIComponent(effectiveModel)}:generateContent${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ''}`;
      reqPayload = {
        contents: messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          })),
      };
    } else if (prov.api_mode === 'codex_responses') {
      upstreamUrl = `${base}/responses`;
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      reqPayload = { model: effectiveModel, input: messages };
    } else if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const upstreamRes = await fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(reqPayload),
      signal: AbortSignal.timeout(15_000),
    });
    if (!upstreamRes.ok) {
      return {
        text: '',
        usedUpstream: false,
        providerId: prov.provider_id,
        model: effectiveModel,
        error: `Upstream ${prov.provider_id} returned HTTP ${upstreamRes.status}`,
      };
    }

    const upstreamJson = (await upstreamRes.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      content?: Array<{ text?: string }>;
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      output_text?: string;
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    const text =
      upstreamJson.choices?.[0]?.message?.content ??
      upstreamJson.content?.[0]?.text ??
      upstreamJson.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ??
      upstreamJson.output_text ??
      upstreamJson.output?.[0]?.content?.[0]?.text ??
      '';

    return { text, usedUpstream: true, providerId: prov.provider_id, model: effectiveModel };
  } catch (err) {
    return {
      text: '',
      usedUpstream: false,
      providerId: prov.provider_id,
      model: prov.default_model,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function registerMagpieGatewayRoutes(
  router: HttpRouter,
  db: DatabaseSync,
  config: ServerConfig,
): void {
  // 1. 51 Built-in Presets & Gateway Config Snapshot
  router.get('/api/v1/hermes/magpie/presets', (ctx) => {
    requireAuth(db, ctx);
    sendJson(ctx.res, 200, {
      total: MAGPIE_BUILTIN_PRESETS.length,
      presets: MAGPIE_BUILTIN_PRESETS,
    });
  });

  const handleGetMagpieConfig = (ctx: RequestContext): void => {
    const auth = requireAuth(db, ctx);
    const state = getMagpieState(db, auth.userId);
    const provRows = db
      .prepare(`SELECT provider_json FROM magpie_providers WHERE user_id = ? ORDER BY updated_at_ms ASC`)
      .all(auth.userId) as Array<{ provider_json: string }>;
    const providers = provRows.map((r) => JSON.parse(r.provider_json) as MagpieProviderView);

    sendJson(ctx.res, 200, {
      presets: MAGPIE_BUILTIN_PRESETS,
      providers,
      active_provider: state.active_provider,
      active_model: state.active_model,
      allow_local_fallback: state.allow_local_fallback,
      routing_strategy: state.routing_strategy,
      routing_groups: state.routing_groups,
      masking: state.masking,
      subscriptions: state.subscriptions,
    });
  };
  router.get('/api/v1/hermes/magpie/config', handleGetMagpieConfig);
  router.get('/api/v1/hermes/magpie/state', handleGetMagpieConfig);
  router.get('/api/v1/hermes/magpie', handleGetMagpieConfig);

  const handleUpdateMagpieConfig = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const patch = await readJsonBody<Partial<MagpieStateBlob> & { active_provider_id?: string }>(ctx.req);
    const state = getMagpieState(db, auth.userId);

    if (patch.active_provider !== undefined) state.active_provider = patch.active_provider;
    if (patch.active_provider_id !== undefined) state.active_provider = patch.active_provider_id;
    if (patch.active_model !== undefined) state.active_model = patch.active_model;
    if (patch.allow_local_fallback !== undefined) state.allow_local_fallback = Boolean(patch.allow_local_fallback);
    if (patch.routing_strategy !== undefined) state.routing_strategy = patch.routing_strategy;
    if (patch.routing_groups !== undefined) state.routing_groups = patch.routing_groups;
    if (patch.masking !== undefined) state.masking = { ...state.masking, ...patch.masking };
    if (patch.subscriptions !== undefined) state.subscriptions = patch.subscriptions;

    saveMagpieState(db, auth.userId, state);
    handleGetMagpieConfig(ctx);
  };
  router.put('/api/v1/hermes/magpie/config', handleUpdateMagpieConfig);
  router.patch('/api/v1/hermes/magpie/config', handleUpdateMagpieConfig);
  router.post('/api/v1/hermes/magpie/config', handleUpdateMagpieConfig);
  router.put('/api/v1/hermes/magpie/state', handleUpdateMagpieConfig);

  // 2. Providers CRUD + Strictly Redacted API Keys (`has_api_key`, `masked_key`, `redactHeaders`)
  router.get('/api/v1/hermes/magpie/providers', (ctx) => {
    const auth = requireAuth(db, ctx);
    const rows = db
      .prepare(`SELECT provider_json FROM magpie_providers WHERE user_id = ? ORDER BY updated_at_ms ASC`)
      .all(auth.userId) as Array<{ provider_json: string }>;
    sendJson(ctx.res, 200, {
      providers: rows.map((r) => JSON.parse(r.provider_json) as MagpieProviderView),
    });
  });

  const handleUpsertProvider = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      provider_id?: string;
      preset_id?: string;
      name?: string;
      api_mode?: MagpieProviderView['api_mode'];
      base_url?: string;
      default_model?: string;
      api_key?: string;
      clear_api_key?: boolean;
      enabled?: boolean;
      custom_headers?: Record<string, string>;
    }>(ctx.req);

    const preset = body.preset_id
      ? MAGPIE_BUILTIN_PRESETS.find((p) => p.id === body.preset_id)
      : undefined;

    const providerId =
      ctx.params.providerId ??
      body.provider_id ??
      preset?.id ??
      `prov_${crypto.randomBytes(4).toString('hex')}`;

    const existingRow = db
      .prepare(
        `SELECT provider_json, encrypted_api_key, key_nonce
         FROM magpie_providers
         WHERE user_id = ? AND provider_id = ?`,
      )
      .get(auth.userId, providerId) as
      | { provider_json: string; encrypted_api_key: string | null; key_nonce: string | null }
      | undefined;
    const existingView = existingRow
      ? (JSON.parse(existingRow.provider_json) as MagpieProviderView)
      : undefined;

    const rawApiKey = body.api_key?.trim();
    let encryptedApiKey: string | null = existingRow?.encrypted_api_key ?? null;
    let keyNonce: string | null = existingRow?.key_nonce ?? null;
    let maskedKey: string | null = existingView?.masked_key ?? null;
    let hasApiKey = Boolean(existingView?.has_api_key);

    if (rawApiKey) {
      const enc = encryptSecretAtRest(
        config.masterSecret,
        `magpie:${auth.userId}:${providerId}`,
        rawApiKey,
      );
      encryptedApiKey = enc.ciphertextB64;
      keyNonce = enc.nonceB64;
      maskedKey = maskApiKey(rawApiKey);
      hasApiKey = true;
    } else if (body.clear_api_key === true) {
      encryptedApiKey = null;
      keyNonce = null;
      maskedKey = null;
      hasApiKey = false;
    }

    const now = Date.now();
    const view: MagpieProviderView = {
      provider_id: providerId,
      preset_id: body.preset_id ?? existingView?.preset_id ?? preset?.id,
      name: body.name ?? existingView?.name ?? preset?.name ?? providerId,
      api_mode: body.api_mode ?? existingView?.api_mode ?? preset?.api_mode ?? 'chat_completions',
      base_url: (body.base_url ?? existingView?.base_url ?? preset?.base_url ?? 'https://api.openai.com/v1').replace(/\/+$/, ''),
      default_model: body.default_model ?? existingView?.default_model ?? preset?.default_model ?? 'gpt-4o',
      enabled: body.enabled ?? existingView?.enabled ?? true,
      no_key_required: existingView?.no_key_required ?? preset?.no_key_required ?? providerId === 'local_hermes',
      has_api_key: hasApiKey,
      masked_key: maskedKey,
      custom_headers:
        body.custom_headers !== undefined
          ? redactHeaders(body.custom_headers)
          : (existingView?.custom_headers ?? {}),
      updated_at_ms: now,
    };

    db.prepare(`
      INSERT OR REPLACE INTO magpie_providers (
        user_id, provider_id, provider_json, encrypted_api_key, key_nonce, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(auth.userId, providerId, JSON.stringify(view), encryptedApiKey, keyNonce, now);

    sendJson(ctx.res, ctx.method === 'POST' ? 201 : 200, view);
  };
  router.post('/api/v1/hermes/magpie/providers', handleUpsertProvider);
  router.put('/api/v1/hermes/magpie/providers/:providerId', handleUpsertProvider);
  router.patch('/api/v1/hermes/magpie/providers/:providerId', handleUpsertProvider);

  router.delete('/api/v1/hermes/magpie/providers/:providerId', (ctx) => {
    const auth = requireAuth(db, ctx);
    const providerId = ctx.params.providerId!;
    if (providerId === 'local_hermes') {
      throw new ApiError(400, 'protected_provider', 'Built-in local_hermes provider cannot be deleted');
    }
    db.prepare(`DELETE FROM magpie_providers WHERE user_id = ? AND provider_id = ?`).run(
      auth.userId,
      providerId,
    );
    sendJson(ctx.res, 200, { ok: true });
  });

  router.post('/api/v1/hermes/magpie/providers/:providerId/probe', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const providerId = ctx.params.providerId!;
    const row = db
      .prepare(
        `SELECT provider_json, encrypted_api_key, key_nonce
         FROM magpie_providers
         WHERE user_id = ? AND provider_id = ?`,
      )
      .get(auth.userId, providerId) as
      | { provider_json: string; encrypted_api_key: string | null; key_nonce: string | null }
      | undefined;
    if (!row) throw new ApiError(404, 'provider_not_found', 'Provider not found');

    const view = JSON.parse(row.provider_json) as MagpieProviderView;
    const t0 = performance.now();

    if (providerId === 'local_hermes' || view.api_mode === 'local_hermes') {
      const latencyMs = Math.max(0, Math.round(performance.now() - t0));
      sendJson(ctx.res, 200, {
        ok: true,
        provider_id: providerId,
        reachable: true,
        status_code: 200,
        latency_ms: latencyMs,
        models: [view.default_model, 'hermes-fast-v1'],
      });
      return;
    }

    let apiKey = '';
    if (row.encrypted_api_key && row.key_nonce) {
      try {
        apiKey = decryptSecretAtRest(
          config.masterSecret,
          `magpie:${auth.userId}:${providerId}`,
          row.encrypted_api_key,
          row.key_nonce,
        );
      } catch {
        apiKey = '';
      }
    }

    const base = view.base_url.replace(/\/+$/, '');
    const probeUrl =
      view.api_mode === 'gemini_generate_content' && apiKey
        ? `${base}/models?key=${encodeURIComponent(apiKey)}`
        : `${base}/models`;
    const headers: Record<string, string> = {};
    if (view.api_mode === 'anthropic_messages') {
      if (apiKey) headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else if (apiKey && view.api_mode !== 'gemini_generate_content') {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    try {
      const probeRes = await fetch(probeUrl, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(3000),
      });
      const latencyMs = Math.max(1, Math.round(performance.now() - t0));
      if (!probeRes.ok) {
        sendJson(ctx.res, 200, {
          ok: false,
          provider_id: providerId,
          reachable: false,
          status_code: probeRes.status,
          latency_ms: latencyMs,
          error: `Upstream probe returned HTTP ${probeRes.status}`,
          models: [],
        });
        return;
      }

      let models: string[] = [view.default_model];
      try {
        const parsed = (await probeRes.json()) as {
          data?: Array<{ id?: string }>;
          models?: Array<{ name?: string }>;
        };
        if (Array.isArray(parsed.data) && parsed.data.length > 0) {
          models = parsed.data.map((m) => String(m.id ?? '')).filter(Boolean);
        } else if (Array.isArray(parsed.models) && parsed.models.length > 0) {
          models = parsed.models
            .map((m) => String(m.name ?? '').replace(/^models\//, ''))
            .filter(Boolean);
        }
      } catch {
        // Keep default_model if /models returns non-JSON
      }

      sendJson(ctx.res, 200, {
        ok: true,
        provider_id: providerId,
        reachable: true,
        status_code: probeRes.status,
        latency_ms: latencyMs,
        models,
      });
    } catch (err) {
      const latencyMs = Math.max(1, Math.round(performance.now() - t0));
      sendJson(ctx.res, 200, {
        ok: false,
        provider_id: providerId,
        reachable: false,
        status_code: 0,
        latency_ms: latencyMs,
        error: err instanceof Error ? err.message : 'Connection failed',
        models: [],
      });
    }
  });

  // Routing Groups CRUD (`/api/v1/hermes/magpie/groups*`)
  router.get('/api/v1/hermes/magpie/groups', (ctx) => {
    const auth = requireAuth(db, ctx);
    const state = getMagpieState(db, auth.userId);
    sendJson(ctx.res, 200, { groups: state.routing_groups });
  });

  const handleUpsertGroup = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<Partial<MagpieRoutingGroup> & { group_id?: string }>(ctx.req);
    const state = getMagpieState(db, auth.userId);
    const groupId =
      ctx.params.groupId ?? body.id ?? body.group_id ?? `grp_${crypto.randomBytes(4).toString('hex')}`;
    const idx = state.routing_groups.findIndex((g) => g.id === groupId);
    const existing = idx >= 0 ? state.routing_groups[idx] : undefined;

    const group: MagpieRoutingGroup = {
      id: groupId,
      name: body.name?.trim() || existing?.name || 'Routing Group',
      strategy: body.strategy ?? existing?.strategy ?? 'smart',
      members:
        body.members ??
        existing?.members ?? [{ target: 'local_hermes', weight: 100, enabled: true, free: true }],
      sticky_ttl_ms: body.sticky_ttl_ms ?? existing?.sticky_ttl_ms ?? 300_000,
    };

    if (idx >= 0) state.routing_groups[idx] = group;
    else state.routing_groups.push(group);
    saveMagpieState(db, auth.userId, state);
    sendJson(ctx.res, ctx.method === 'POST' ? 201 : 200, group);
  };
  router.post('/api/v1/hermes/magpie/groups', handleUpsertGroup);
  router.put('/api/v1/hermes/magpie/groups/:groupId', handleUpsertGroup);

  router.delete('/api/v1/hermes/magpie/groups/:groupId', (ctx) => {
    const auth = requireAuth(db, ctx);
    const state = getMagpieState(db, auth.userId);
    state.routing_groups = state.routing_groups.filter((g) => g.id !== ctx.params.groupId);
    saveMagpieState(db, auth.userId, state);
    sendJson(ctx.res, 200, { ok: true, groups: state.routing_groups });
  });

  // Subscriptions Scan & Activation (`/api/v1/hermes/magpie/subscriptions*`)
  router.get('/api/v1/hermes/magpie/subscriptions', (ctx) => {
    const auth = requireAuth(db, ctx);
    const state = getMagpieState(db, auth.userId);
    sendJson(ctx.res, 200, { subscriptions: state.subscriptions ?? [] });
  });

  router.post('/api/v1/hermes/magpie/subscriptions/scan', (ctx) => {
    const auth = requireAuth(db, ctx);
    const state = getMagpieState(db, auth.userId);
    const provRows = db
      .prepare(`SELECT provider_json FROM magpie_providers WHERE user_id = ?`)
      .all(auth.userId) as Array<{ provider_json: string }>;
    const now = Date.now();
    const subs = provRows.map((r) => {
      const p = JSON.parse(r.provider_json) as MagpieProviderView;
      return {
        sub_id: `sub_${p.provider_id}`,
        provider_id: p.provider_id,
        plan_name: p.provider_id === 'local_hermes' ? 'Built-in Local Runtime' : `${p.name} API Key`,
        active: state.active_provider === p.provider_id,
        detected_at_ms: now,
      };
    });
    state.subscriptions = subs;
    saveMagpieState(db, auth.userId, state);
    sendJson(ctx.res, 200, { ok: true, subscriptions: subs });
  });

  router.post('/api/v1/hermes/magpie/subscriptions/:subId/activate', (ctx) => {
    const auth = requireAuth(db, ctx);
    const state = getMagpieState(db, auth.userId);
    const subs = state.subscriptions ?? [];
    const target = subs.find((s) => String(s.sub_id) === ctx.params.subId);
    if (!target) throw new ApiError(404, 'subscription_not_found', 'Subscription not found');
    for (const s of subs) {
      s.active = String(s.sub_id) === String(target.sub_id);
    }
    state.active_provider = String(target.provider_id);
    state.subscriptions = subs;
    saveMagpieState(db, auth.userId, state);
    sendJson(ctx.res, 200, { ok: true, active_provider: state.active_provider, subscription: target });
  });

  // 3. Privacy Masking Config & Preview (`/masking` & `/masking/preview`)
  router.get('/api/v1/hermes/magpie/masking', (ctx) => {
    const auth = requireAuth(db, ctx);
    sendJson(ctx.res, 200, getMagpieState(db, auth.userId).masking);
  });

  router.put('/api/v1/hermes/magpie/masking', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const patch = await readJsonBody<Partial<MagpieMaskingConfig>>(ctx.req);
    const state = getMagpieState(db, auth.userId);
    state.masking = { ...state.masking, ...patch };
    saveMagpieState(db, auth.userId, state);
    sendJson(ctx.res, 200, state.masking);
  });

  router.post('/api/v1/hermes/magpie/masking/preview', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{ text?: string; config?: Partial<MagpieMaskingConfig> }>(ctx.req);
    const state = getMagpieState(db, auth.userId);
    const effectiveCfg: MagpieMaskingConfig = { ...state.masking, ...(body.config ?? {}) };
    const res = runPrivacyMasking(body.text ?? '', effectiveCfg);
    sendJson(ctx.res, 200, {
      masked_text: res.masked_text,
      hits: res.hits,
      hit_count: res.hit_count,
      blocked: res.blocked,
      block_reason: res.block_reason,
    });
  });

  // 4. `.env` / `magpie://` / JSON Import & Subscription Scan + Usage Ledger
  router.post('/api/v1/hermes/magpie/import', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{ content?: string; raw?: string; uri?: string }>(ctx.req);
    const text = (body.content ?? body.raw ?? body.uri ?? '').trim();
    if (!text) {
      throw new ApiError(400, 'empty_import', 'Import payload cannot be empty');
    }

    const imported: string[] = [];
    const now = Date.now();

    const saveImported = (spec: {
      providerId: string;
      presetId?: string;
      name?: string;
      apiMode?: MagpieProviderView['api_mode'];
      baseUrl?: string;
      defaultModel?: string;
      rawKey?: string;
    }): void => {
      const preset = MAGPIE_BUILTIN_PRESETS.find(
        (p) => p.id === (spec.presetId ?? spec.providerId),
      );
      const pid = spec.providerId;
      const key = spec.rawKey?.trim() || undefined;
      let encKey: string | null = null;
      let keyNonce: string | null = null;
      if (key) {
        const enc = encryptSecretAtRest(config.masterSecret, `magpie:${auth.userId}:${pid}`, key);
        encKey = enc.ciphertextB64;
        keyNonce = enc.nonceB64;
      }
      const view: MagpieProviderView = {
        provider_id: pid,
        preset_id: spec.presetId ?? preset?.id,
        name: spec.name ?? preset?.name ?? pid,
        api_mode: spec.apiMode ?? preset?.api_mode ?? 'chat_completions',
        base_url: (spec.baseUrl ?? preset?.base_url ?? 'https://api.openai.com/v1').replace(/\/+$/, ''),
        default_model: spec.defaultModel ?? preset?.default_model ?? 'gpt-4o',
        enabled: true,
        no_key_required: preset?.no_key_required ?? pid === 'local_hermes',
        has_api_key: Boolean(key),
        masked_key: maskApiKey(key),
        custom_headers: {},
        updated_at_ms: now,
      };
      db.prepare(`
        INSERT OR REPLACE INTO magpie_providers (user_id, provider_id, provider_json, encrypted_api_key, key_nonce, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(auth.userId, pid, JSON.stringify(view), encKey, keyNonce, now);
      imported.push(pid);
    };

    if (/^magpie:\/\//i.test(text)) {
      const parsedUri = new URL(text);
      const sp = parsedUri.searchParams;
      const presetId =
        sp.get('preset') ??
        sp.get('preset_id') ??
        sp.get('provider') ??
        (parsedUri.hostname && parsedUri.hostname !== 'import' ? parsedUri.hostname : 'openai');
      const providerId = sp.get('provider_id') ?? presetId;
      saveImported({
        providerId,
        presetId,
        name: sp.get('name') ?? undefined,
        apiMode: (sp.get('api_mode') as MagpieProviderView['api_mode'] | null) ?? undefined,
        baseUrl: sp.get('base_url') ?? undefined,
        defaultModel: sp.get('model') ?? sp.get('default_model') ?? undefined,
        rawKey: sp.get('api_key') ?? sp.get('key') ?? undefined,
      });
      sendJson(ctx.res, 200, { ok: true, imported_count: imported.length, imported });
      return;
    }

    if (text.startsWith('{') || text.startsWith('[')) {
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(text);
      } catch {
        throw new ApiError(400, 'invalid_import_json', 'Malformed JSON import payload');
      }
      const items = Array.isArray(parsedJson)
        ? parsedJson
        : Array.isArray((parsedJson as { providers?: unknown[] }).providers)
          ? (parsedJson as { providers: unknown[] }).providers
          : [parsedJson];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const rec = item as Record<string, unknown>;
        const presetId =
          typeof rec.preset_id === 'string'
            ? rec.preset_id
            : typeof rec.preset === 'string'
              ? rec.preset
              : undefined;
        const providerId =
          typeof rec.provider_id === 'string'
            ? rec.provider_id
            : presetId ?? `prov_${crypto.randomBytes(4).toString('hex')}`;
        saveImported({
          providerId,
          presetId,
          name: typeof rec.name === 'string' ? rec.name : undefined,
          apiMode:
            typeof rec.api_mode === 'string'
              ? (rec.api_mode as MagpieProviderView['api_mode'])
              : undefined,
          baseUrl: typeof rec.base_url === 'string' ? rec.base_url : undefined,
          defaultModel:
            typeof rec.default_model === 'string'
              ? rec.default_model
              : typeof rec.model === 'string'
                ? rec.model
                : undefined,
          rawKey: typeof rec.api_key === 'string' ? rec.api_key : undefined,
        });
      }
      sendJson(ctx.res, 200, { ok: true, imported_count: imported.length, imported });
      return;
    }

    const envMap: Array<[RegExp, string]> = [
      [/OPENAI_API_KEY\s*=\s*["']?([^\s"']+)/i, 'openai'],
      [/ANTHROPIC_API_KEY\s*=\s*["']?([^\s"']+)/i, 'anthropic'],
      [/(?:GEMINI|GOOGLE)_API_KEY\s*=\s*["']?([^\s"']+)/i, 'google'],
      [/DEEPSEEK_API_KEY\s*=\s*["']?([^\s"']+)/i, 'deepseek'],
      [/OPENROUTER_API_KEY\s*=\s*["']?([^\s"']+)/i, 'openrouter'],
      [/GROQ_API_KEY\s*=\s*["']?([^\s"']+)/i, 'groq'],
      [/MISTRAL_API_KEY\s*=\s*["']?([^\s"']+)/i, 'mistral'],
      [/XAI_API_KEY\s*=\s*["']?([^\s"']+)/i, 'xai'],
    ];

    for (const [re, presetId] of envMap) {
      const m = re.exec(text);
      if (m && m[1]) {
        saveImported({ providerId: presetId, presetId, rawKey: m[1] });
      }
    }

    sendJson(ctx.res, 200, { ok: true, imported_count: imported.length, imported });
  });

  router.get('/api/v1/hermes/magpie/usage', (ctx) => {
    const auth = requireAuth(db, ctx);
    const rows = db
      .prepare(`SELECT * FROM magpie_usage_ledger WHERE user_id = ? ORDER BY created_at_ms DESC LIMIT 100`)
      .all(auth.userId) as Array<Record<string, unknown>>;

    let promptTokens = 0;
    let completionTokens = 0;
    let maskedCount = 0;
    const entries = rows.map((r) => {
      const pt = Number(r.prompt_tokens);
      const ct = Number(r.completion_tokens);
      const mh = Number(r.masked_hits);
      promptTokens += pt;
      completionTokens += ct;
      maskedCount += mh;
      return {
        id: String(r.entry_id),
        provider_id: String(r.provider_id),
        model: String(r.model),
        prompt_tokens: pt,
        completion_tokens: ct,
        masked_hits: mh,
        latency_ms: Number(r.latency_ms),
        created_at_ms: Number(r.created_at_ms),
      };
    });

    const summary: MagpieUsageLedgerSummary = {
      total_requests: entries.length,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      masked_pii_count: maskedCount,
      estimated_cost_usd: 0,
      entries,
    };
    sendJson(ctx.res, 200, summary);
  });

  // 5. OpenAI-Compatible Gateway Proxy (`/v1/models`, `/v1/chat/completions`, `/api/v1/magpie/v1/*`)
  const handleModels = (ctx: RequestContext): void => {
    sendJson(ctx.res, 200, {
      object: 'list',
      data: [
        { id: 'hermes-local-v1', object: 'model', owned_by: 'local_hermes' },
        { id: 'hermes-fast-v1', object: 'model', owned_by: 'local_hermes' },
        ...MAGPIE_BUILTIN_PRESETS.slice(0, 10).map((p) => ({
          id: p.default_model,
          object: 'model',
          owned_by: p.id,
        })),
      ],
    });
  };
  router.get('/v1/models', handleModels);
  router.get('/api/v1/magpie/v1/models', handleModels);

  const handleChatCompletions = async (ctx: RequestContext): Promise<void> => {
    const startMs = Date.now();
    const bearer = extractBearerToken(ctx.req, ctx.query);
    const session = authenticateToken(db, bearer);
    const userId = session?.userId ?? 1001;

    const body = await readJsonBody<{
      model?: string;
      messages?: Array<{ role: string; content: string }>;
      stream?: boolean;
      provider_id?: string;
    }>(ctx.req);

    const state = getMagpieState(db, userId);
    const providerId = body.provider_id ?? state.active_provider ?? 'local_hermes';
    const model = body.model ?? state.active_model ?? 'hermes-local-v1';

    const rawMessages = body.messages ?? [];
    let maskedHitsTotal = 0;
    const globalReverseMap = new Map<string, string>();

    const maskedMessages = rawMessages.map((m) => {
      const masked = runPrivacyMasking(String(m.content ?? ''), state.masking);
      if (masked.blocked) {
        throw new ApiError(400, 'privacy_blocked', masked.block_reason ?? 'Blocked by privacy policy');
      }
      maskedHitsTotal += masked.hit_count;
      for (const [k, v] of masked.reverseMap.entries()) {
        globalReverseMap.set(k, v);
      }
      return { role: m.role, content: masked.masked_text };
    });

    // Execute genuine upstream HTTP provider dispatch across all 4 API modes (unless local_hermes)
    let assistantText = '';
    let usedUpstream = false;
    const provRow = db
      .prepare(`SELECT provider_json, encrypted_api_key, key_nonce FROM magpie_providers WHERE user_id = ? AND provider_id = ?`)
      .get(userId, providerId) as
      | { provider_json: string; encrypted_api_key: string | null; key_nonce: string | null }
      | undefined;

    if (provRow && providerId !== 'local_hermes') {
      const prov = JSON.parse(provRow.provider_json) as MagpieProviderView;
      if (prov.enabled !== false && prov.api_mode !== 'local_hermes' && /^https?:\/\//i.test(prov.base_url)) {
        try {
          const apiKey =
            provRow.encrypted_api_key && provRow.key_nonce
              ? decryptSecretAtRest(
                  config.masterSecret,
                  `magpie:${userId}:${providerId}`,
                  provRow.encrypted_api_key,
                  provRow.key_nonce,
                )
              : '';

          const base = prov.base_url.replace(/\/+$/, '');
          let upstreamUrl = `${base}/chat/completions`;
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          let reqPayload: Record<string, unknown> = {
            model,
            messages: maskedMessages,
            stream: false,
          };

          if (prov.api_mode === 'anthropic_messages') {
            upstreamUrl = `${base}/messages`;
            if (apiKey) headers['x-api-key'] = apiKey;
            headers['anthropic-version'] = '2023-06-01';
            const sysMsg = maskedMessages.find((m) => m.role === 'system')?.content;
            reqPayload = {
              model,
              max_tokens: 1024,
              ...(sysMsg ? { system: sysMsg } : {}),
              messages: maskedMessages.filter((m) => m.role !== 'system'),
            };
          } else if (prov.api_mode === 'gemini_generate_content') {
            upstreamUrl = `${base}/models/${encodeURIComponent(model)}:generateContent${apiKey ? `?key=${encodeURIComponent(apiKey)}` : ''}`;
            reqPayload = {
              contents: maskedMessages.map((m) => ({
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: m.content }],
              })),
            };
          } else if (prov.api_mode === 'codex_responses') {
            upstreamUrl = `${base}/responses`;
            if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
            reqPayload = {
              model,
              input: maskedMessages,
            };
          } else if (apiKey) {
            headers.Authorization = `Bearer ${apiKey}`;
          }

          const upstreamRes = await fetch(upstreamUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(reqPayload),
            signal: AbortSignal.timeout(8000),
          });
          if (!upstreamRes.ok) {
            throw new Error(`Upstream provider ${providerId} returned HTTP ${upstreamRes.status}`);
          }

          const upstreamJson = (await upstreamRes.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
            content?: Array<{ text?: string }>;
            candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
            output_text?: string;
            output?: Array<{ content?: Array<{ text?: string }> }>;
          };
          assistantText =
            upstreamJson.choices?.[0]?.message?.content ??
            upstreamJson.content?.[0]?.text ??
            upstreamJson.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ??
            upstreamJson.output_text ??
            upstreamJson.output?.[0]?.content?.[0]?.text ??
            '';
          usedUpstream = true;
        } catch (err) {
          if (!state.allow_local_fallback) {
            throw new ApiError(
              502,
              'upstream_unreachable',
              err instanceof Error ? err.message : `Upstream provider ${providerId} unreachable`,
            );
          }
        }
      }
    }

    if (!usedUpstream) {
      const lastUser = [...maskedMessages].reverse().find((m) => m.role === 'user')?.content ?? '';
      assistantText = `[Magpie · ${providerId}/${model}] Processed: ${lastUser}`;
    }

    // Always restore reversible PII/secret placeholders on BOTH upstream and local responses!
    assistantText = unmaskPlaceholders(assistantText, globalReverseMap);

    const promptTokens = Math.max(4, Math.ceil(JSON.stringify(maskedMessages).length / 4));
    const completionTokens = Math.max(6, Math.ceil(assistantText.length / 4));
    const latencyMs = Math.max(1, Date.now() - startMs);

    db.prepare(`
      INSERT INTO magpie_usage_ledger (
        entry_id, user_id, provider_id, model, prompt_tokens, completion_tokens, masked_hits, latency_ms, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `use_${crypto.randomBytes(6).toString('hex')}`,
      userId,
      providerId,
      model,
      promptTokens,
      completionTokens,
      maskedHitsTotal,
      latencyMs,
      Date.now(),
    );

    const completionId = `chatcmpl_${crypto.randomBytes(8).toString('hex')}`;
    if (body.stream) {
      const sse = beginSseStream(ctx.res);
      const half = Math.max(1, Math.floor(assistantText.length / 2));
      for (const piece of [assistantText.slice(0, half), assistantText.slice(half)]) {
        if (!piece) continue;
        sse.sendRawData(
          JSON.stringify({
            id: completionId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
          }),
        );
      }
      sse.sendRawData(
        JSON.stringify({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        }),
      );
      sse.sendRawData('[DONE]');
      sse.end();
      return;
    }

    sendJson(ctx.res, 200, {
      id: completionId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      provider: providerId,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: assistantText },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    });
  };
  router.post('/v1/chat/completions', handleChatCompletions);
  router.post('/api/v1/magpie/v1/chat/completions', handleChatCompletions);
  router.post('/api/v1/hermes/magpie/v1/chat/completions', handleChatCompletions);
}
