import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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
  maskApiKey,
  redactHeaders,
  runPrivacyMasking,
  unmaskPlaceholders,
} from '../utils/crypto.js';
import {
  ApiError,
  beginSseStream,
  readJsonBody,
  requireAuth,
  sendJson,
  type HttpRouter,
  type RequestContext,
} from '../utils/http.js';

// ============================================================================
// Types & Constants
// ============================================================================

const HKDF_SALT = Buffer.from('fabushi-user-provider-vault-v1', 'utf8');
const VAULT_PREFIX = 'enc:v1:';
const MODELS_CATALOG_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MODELS_CATALOG_MAX_PER_PROVIDER = 32;
const MODELS_CATALOG_CACHE_FILE = 'models_dev_catalog_cache.json';

const ALLOWED_API_MODES = new Set<string>([
  'chat_completions',
  'anthropic_messages',
  'gemini_generate_content',
  'codex_responses',
]);

const NON_CHAT_MODEL_SUBSTRINGS = [
  'embedding',
  'embed-',
  'text-embedding',
  'whisper',
  'tts-',
  'dall-e',
  'imagen',
  'veo-',
  'lyria-',
  'gpt-image',
  'imagine-video',
  'imagine-image',
  '-image',
  'moderation',
  'transcribe',
  'realtime',
  'audio-preview',
  'babbage',
  'davinci',
  'aqa',
];

export interface LlmToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  thought_signature?: string;
}

export interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | string;
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: LlmToolCall[];
}

export interface LlmCompletionResult {
  text: string;
  usedUpstream: boolean;
  providerId: string;
  model: string;
  unconfigured?: boolean;
  error?: string;
  reasoning?: string;
  finishReason?: string;
  toolCalls?: LlmToolCall[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    reasoning_tokens: number;
    total_tokens: number;
  };
}

interface StoredVaultProvider {
  provider_id: string;
  preset_id?: string;
  name: string;
  api_mode: 'chat_completions' | 'anthropic_messages' | 'gemini_generate_content' | 'codex_responses';
  base_url: string;
  default_model: string;
  enabled: boolean;
  no_key_required: boolean;
  api_key?: string;
  custom_headers: Record<string, string>;
  models?: string[];
  updated_at_ms: number;
}

interface StoredSubscriptionAccount {
  id: string;
  kind: string;
  label: string;
  active?: boolean;
  base_url?: string;
  protocol?: string;
  default_model?: string;
  source_path?: string;
  plan?: string;
  account_id?: string;
  email?: string;
}

interface StoredVaultSubscription {
  sub_id: string;
  provider_id: string;
  account: StoredSubscriptionAccount;
  plan_name: string;
  active: boolean;
  access_token?: string;
  raw_headers?: Record<string, string>;
  vertex_adc?: unknown;
  codex_oauth?: unknown;
  region_id?: string;
  available_models?: string[];
  detected_at_ms: number;
}

interface RouteTraceEntry {
  trace_id: string;
  provider_id: string;
  model: string;
  ok: boolean;
  latency_ms: number;
  status_code?: number;
  error?: string;
  timestamp_ms: number;
}

interface UserProviderVaultState {
  active_provider: string;
  active_model: string;
  allow_local_fallback: boolean;
  routing_strategy: string;
  routing_groups: MagpieRoutingGroup[];
  masking: MagpieMaskingConfig;
  providers: StoredVaultProvider[];
  subscriptions: StoredVaultSubscription[];
  recent_route_traces: RouteTraceEntry[];
}

export interface RedactedSubscriptionDto {
  sub_id: string;
  id: string;
  provider_id: string;
  kind: string;
  label: string;
  plan_name: string;
  active: boolean;
  base_url?: string;
  protocol?: string;
  default_model?: string;
  plan?: string;
  account_id?: string;
  email?: string;
  region_id?: string;
  available_models?: string[];
  has_access_token: boolean;
  has_credentials: boolean;
  raw_headers: Record<string, string>;
  detected_at_ms: number;
  account: StoredSubscriptionAccount;
}

interface ModelsCatalogCache {
  fetched_at_ms: number;
  source: 'models.dev';
  providers: Record<string, string[]>;
}

const memoryCatalogCache = new Map<string, ModelsCatalogCache>();

// ============================================================================
// Per-User ChaCha20-Poly1305 Vault Encryption (`enc:v1:<base64>`)
// ============================================================================

function resolveProviderMasterKey(config: ServerConfig): Buffer {
  const envKey = process.env.FABUSHI_PROVIDER_MASTER_KEY?.trim();
  if (envKey) {
    return crypto
      .createHash('sha256')
      .update(`fabushi-provider-master-key-env-v1:${envKey}`)
      .digest();
  }
  return config.masterSecret;
}

function deriveUserVaultKey(masterKey: Buffer, userId: number): Buffer {
  return Buffer.from(
    crypto.hkdfSync('sha256', masterKey, HKDF_SALT, Buffer.from(`user:${userId}`, 'utf8'), 32),
  );
}

export function sealUserProviderState(
  masterKey: Buffer,
  userId: number,
  state: unknown,
): string {
  const userKey = deriveUserVaultKey(masterKey, userId);
  const nonce = crypto.randomBytes(12);
  const aad = Buffer.from(`user_providers_state:${userId}`, 'utf8');
  const plaintextBuf = Buffer.from(JSON.stringify(state), 'utf8');
  const cipher = crypto.createCipheriv('chacha20-poly1305', userKey, nonce, {
    authTagLength: 16,
  });
  cipher.setAAD(aad, { plaintextLength: plaintextBuf.length });
  const ct = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VAULT_PREFIX}${Buffer.concat([nonce, ct, tag]).toString('base64')}`;
}

export function openUserProviderState<T = UserProviderVaultState>(
  masterKey: Buffer,
  userId: number,
  sealed: string,
): T {
  if (typeof sealed !== 'string' || !sealed.startsWith(VAULT_PREFIX)) {
    throw new Error('Invalid encrypted provider vault prefix');
  }
  const combined = Buffer.from(sealed.slice(VAULT_PREFIX.length), 'base64');
  if (combined.length < 28) {
    throw new Error('Encrypted provider vault truncated');
  }
  const nonce = combined.subarray(0, 12);
  const ct = combined.subarray(12, combined.length - 16);
  const tag = combined.subarray(combined.length - 16);
  const userKey = deriveUserVaultKey(masterKey, userId);
  const aad = Buffer.from(`user_providers_state:${userId}`, 'utf8');
  const decipher = crypto.createDecipheriv('chacha20-poly1305', userKey, nonce, {
    authTagLength: 16,
  });
  decipher.setAAD(aad, { plaintextLength: ct.length });
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  return JSON.parse(plaintext) as T;
}

export function rekeyUserProviderVaults(
  db: DatabaseSync,
  oldMasterKey: Buffer,
  newMasterKey: Buffer,
): number {
  const rows = db
    .prepare(`SELECT user_id, encrypted_state FROM user_provider_vaults`)
    .all() as Array<{ user_id: number; encrypted_state: string }>;
  const now = Date.now();
  const updateStmt = db.prepare(
    `UPDATE user_provider_vaults SET encrypted_state = ?, updated_at_ms = ? WHERE user_id = ?`,
  );
  let count = 0;
  db.exec('BEGIN IMMEDIATE;');
  try {
    for (const row of rows) {
      const uid = Number(row.user_id);
      const state = openUserProviderState(oldMasterKey, uid, row.encrypted_state);
      const resealed = sealUserProviderState(newMasterKey, uid, state);
      updateStmt.run(resealed, now, uid);
      count += 1;
    }
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
  return count;
}

// ============================================================================
// Vault Load / Save / Legacy Migration / Redaction Helpers
// ============================================================================

function defaultMaskingConfig(): MagpieMaskingConfig {
  return {
    enabled: true,
    mask_secrets: true,
    mask_personal: true,
    custom_words: [],
    allow_list: [],
    default_action: 'mask',
  };
}

function defaultVaultState(): UserProviderVaultState {
  return {
    active_provider: '',
    active_model: '',
    allow_local_fallback: false,
    routing_strategy: 'smart',
    routing_groups: [],
    masking: defaultMaskingConfig(),
    providers: [],
    subscriptions: [],
    recent_route_traces: [],
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function sanitizeHeadersRecord(raw: unknown): Record<string, string> {
  if (!isPlainObject(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = k.trim();
    if (!key || key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (typeof v === 'string') {
      out[key] = v;
    }
  }
  return out;
}

function normalizeBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(trimmed)) {
    throw new ApiError(400, 'invalid_base_url', 'Provider base_url must be a valid http(s) URL');
  }
  return trimmed;
}

function joinUpstreamPath(baseUrl: string, suffix: string): string {
  const cleanBase = baseUrl.replace(/\/+$/, '');
  const cleanSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`;
  // Avoid doubling /v1/v1 or /v1beta/v1beta
  if (cleanBase.endsWith('/v1') && cleanSuffix.startsWith('/v1/')) {
    return `${cleanBase}${cleanSuffix.slice(3)}`;
  }
  if (cleanBase.endsWith('/v1beta') && cleanSuffix.startsWith('/v1beta/')) {
    return `${cleanBase}${cleanSuffix.slice(7)}`;
  }
  return `${cleanBase}${cleanSuffix}`;
}

function normalizeVaultState(raw: Partial<UserProviderVaultState>): UserProviderVaultState {
  const base = defaultVaultState();
  const providers = Array.isArray(raw.providers)
    ? raw.providers.filter(
        (p) =>
          isPlainObject(p) &&
          typeof p.provider_id === 'string' &&
          p.provider_id !== 'local_hermes' &&
          (p.api_mode as string) !== 'local_hermes',
      )
    : [];
  const activeProvider =
    typeof raw.active_provider === 'string' && raw.active_provider !== 'local_hermes'
      ? raw.active_provider
      : '';
  const activeModel =
    typeof raw.active_model === 'string' &&
    raw.active_model !== 'hermes-local-v1' &&
    raw.active_model !== 'hermes-fast-v1'
      ? raw.active_model
      : '';

  return {
    active_provider: activeProvider,
    active_model: activeModel,
    allow_local_fallback: Boolean(raw.allow_local_fallback),
    routing_strategy: typeof raw.routing_strategy === 'string' ? raw.routing_strategy : base.routing_strategy,
    routing_groups: Array.isArray(raw.routing_groups)
      ? raw.routing_groups
          .filter(
            (g): g is MagpieRoutingGroup =>
              isPlainObject(g) && typeof g.id === 'string' && g.id.trim().length > 0,
          )
          .map((g) => ({
            ...g,
            members: Array.isArray(g.members)
              ? g.members.filter(
                  (m): m is MagpieRoutingGroup['members'][number] =>
                    isPlainObject(m) &&
                    typeof m.target === 'string' &&
                    m.target.trim().length > 0 &&
                    m.target !== 'local_hermes',
                )
              : [],
          }))
      : [],
    masking: isPlainObject(raw.masking)
      ? {
          enabled: raw.masking.enabled !== undefined ? Boolean(raw.masking.enabled) : true,
          mask_secrets: raw.masking.mask_secrets !== undefined ? Boolean(raw.masking.mask_secrets) : true,
          mask_personal: raw.masking.mask_personal !== undefined ? Boolean(raw.masking.mask_personal) : true,
          custom_words: Array.isArray(raw.masking.custom_words)
            ? raw.masking.custom_words.filter((w): w is string => typeof w === 'string')
            : [],
          allow_list: Array.isArray(raw.masking.allow_list)
            ? raw.masking.allow_list.filter((w): w is string => typeof w === 'string')
            : [],
          default_action:
            raw.masking.default_action === 'block' || raw.masking.default_action === 'warn'
              ? raw.masking.default_action
              : 'mask',
        }
      : base.masking,
    providers,
    subscriptions: Array.isArray(raw.subscriptions)
      ? raw.subscriptions.filter((s) => isPlainObject(s) && isPlainObject(s.account))
      : [],
    recent_route_traces: Array.isArray(raw.recent_route_traces)
      ? raw.recent_route_traces.filter((t) => isPlainObject(t)).slice(-50)
      : [],
  };
}

function saveUserProviderVault(
  db: DatabaseSync,
  config: ServerConfig,
  userId: number,
  state: UserProviderVaultState,
): void {
  const masterKey = resolveProviderMasterKey(config);
  const sealed = sealUserProviderState(masterKey, userId, state);
  db.prepare(`
    INSERT OR REPLACE INTO user_provider_vaults (user_id, encrypted_state, updated_at_ms)
    VALUES (?, ?, ?)
  `).run(userId, sealed, Date.now());
}

function loadUserProviderVault(
  db: DatabaseSync,
  config: ServerConfig,
  userId: number,
): UserProviderVaultState {
  const masterKey = resolveProviderMasterKey(config);
  const row = db
    .prepare(`SELECT encrypted_state FROM user_provider_vaults WHERE user_id = ?`)
    .get(userId) as { encrypted_state: string } | undefined;

  if (row) {
    const opened = openUserProviderState<Partial<UserProviderVaultState>>(
      masterKey,
      userId,
      row.encrypted_state,
    );
    return normalizeVaultState(opened);
  }

  // One-time migration from legacy magpie_providers + magpie_state tables (skipping local_hermes)
  const legacyProvRows = db
    .prepare(
      `SELECT provider_id, provider_json, encrypted_api_key, key_nonce
       FROM magpie_providers WHERE user_id = ? ORDER BY updated_at_ms ASC`,
    )
    .all(userId) as Array<{
      provider_id: string;
      provider_json: string;
      encrypted_api_key: string | null;
      key_nonce: string | null;
    }>;
  const legacyStateRow = db
    .prepare(`SELECT state_json FROM magpie_state WHERE user_id = ?`)
    .get(userId) as { state_json: string } | undefined;

  if (legacyProvRows.length === 0 && !legacyStateRow) {
    return defaultVaultState();
  }

  const migrated = defaultVaultState();
  if (legacyStateRow) {
    try {
      const parsed = JSON.parse(legacyStateRow.state_json) as Partial<UserProviderVaultState>;
      const norm = normalizeVaultState(parsed);
      migrated.active_provider = norm.active_provider;
      migrated.active_model = norm.active_model;
      migrated.allow_local_fallback = norm.allow_local_fallback;
      migrated.routing_strategy = norm.routing_strategy;
      migrated.routing_groups = norm.routing_groups;
      migrated.masking = norm.masking;
    } catch {
      // Ignore corrupt legacy state
    }
  }

  for (const r of legacyProvRows) {
    if (r.provider_id === 'local_hermes') continue;
    try {
      const view = JSON.parse(r.provider_json) as MagpieProviderView;
      if ((view.api_mode as string) === 'local_hermes') continue;
      let rawKey: string | undefined;
      if (r.encrypted_api_key && r.key_nonce) {
        try {
          rawKey = decryptSecretAtRest(
            config.masterSecret,
            `magpie:${userId}:${r.provider_id}`,
            r.encrypted_api_key,
            r.key_nonce,
          );
        } catch {
          rawKey = undefined;
        }
      }
      migrated.providers.push({
        provider_id: r.provider_id,
        preset_id: view.preset_id,
        name: view.name || r.provider_id,
        api_mode: ALLOWED_API_MODES.has(view.api_mode)
          ? (view.api_mode as StoredVaultProvider['api_mode'])
          : 'chat_completions',
        base_url: view.base_url || 'https://api.openai.com/v1',
        default_model: view.default_model || '',
        enabled: view.enabled !== false,
        no_key_required: Boolean(view.no_key_required),
        api_key: rawKey,
        custom_headers: sanitizeHeadersRecord(view.custom_headers),
        updated_at_ms: Number(view.updated_at_ms || Date.now()),
      });
    } catch {
      // Ignore corrupt legacy row
    }
  }

  saveUserProviderVault(db, config, userId, migrated);
  db.prepare(`DELETE FROM magpie_providers WHERE user_id = ?`).run(userId);
  db.prepare(`DELETE FROM magpie_state WHERE user_id = ?`).run(userId);
  return migrated;
}

const SENSITIVE_HEADER_NAME_RE = /auth|cookie|token|secret|key|session|credential|passwd|password/i;

function redactSensitiveHeaders(headers: Record<string, string> | undefined, redactAll = false): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (redactAll || SENSITIVE_HEADER_NAME_RE.test(k)) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = v;
    }
  }
  return out;
}

function toProviderView(prov: StoredVaultProvider): MagpieProviderView & { id: string } {
  const hasKey = Boolean(prov.api_key && prov.api_key.trim().length > 0);
  return {
    id: prov.provider_id,
    provider_id: prov.provider_id,
    preset_id: prov.preset_id,
    name: prov.name,
    api_mode: prov.api_mode,
    base_url: prov.base_url,
    default_model: prov.default_model,
    enabled: prov.enabled,
    no_key_required: prov.no_key_required,
    has_api_key: hasKey,
    masked_key: hasKey ? maskApiKey(prov.api_key) : null,
    custom_headers: redactSensitiveHeaders(prov.custom_headers, false),
    updated_at_ms: prov.updated_at_ms,
  };
}

function toRedactedSubscription(sub: StoredVaultSubscription): RedactedSubscriptionDto {
  const hasToken = Boolean(sub.access_token && sub.access_token.trim().length > 0);
  const hasCreds = Boolean(
    hasToken ||
      sub.vertex_adc ||
      sub.codex_oauth ||
      (sub.raw_headers && Object.keys(sub.raw_headers).length > 0),
  );
  return {
    sub_id: sub.sub_id,
    id: sub.account.id,
    provider_id: sub.provider_id,
    kind: sub.account.kind,
    label: sub.account.label,
    plan_name: sub.plan_name,
    active: sub.active,
    base_url: sub.account.base_url,
    protocol: sub.account.protocol,
    default_model: sub.account.default_model,
    plan: sub.account.plan,
    account_id: sub.account.account_id,
    email: sub.account.email,
    region_id: sub.region_id,
    available_models: sub.available_models ?? [],
    has_access_token: hasToken,
    has_credentials: hasCreds,
    raw_headers: redactSensitiveHeaders(sub.raw_headers, true),
    detected_at_ms: sub.detected_at_ms,
    account: {
      id: sub.account.id,
      kind: sub.account.kind,
      label: sub.account.label,
      active: sub.active,
      base_url: sub.account.base_url,
      protocol: sub.account.protocol,
      default_model: sub.account.default_model,
      plan: sub.account.plan,
      account_id: sub.account.account_id,
      email: sub.account.email,
    },
  };
}

function buildStatePayload(vault: UserProviderVaultState) {
  const providers = vault.providers.map(toProviderView);
  const subscriptions = vault.subscriptions.map(toRedactedSubscription);
  const enabledProviders = vault.providers.filter((p) => p.enabled !== false);
  const hasActiveSubscription = vault.subscriptions.some((s) => s.active);
  const hasConfiguredProvider = enabledProviders.length > 0 || hasActiveSubscription;

  return {
    presets: MAGPIE_BUILTIN_PRESETS,
    providers,
    active_provider: vault.active_provider,
    active_model: vault.active_model,
    allow_local_fallback: vault.allow_local_fallback,
    has_active_subscription: hasActiveSubscription,
    has_configured_provider: hasConfiguredProvider,
    needs_provider_selection: !hasConfiguredProvider,
    subscriptions,
    routing_groups: vault.routing_groups,
    routing_strategy: vault.routing_strategy,
    masking: vault.masking,
    recent_route_traces: vault.recent_route_traces,
    user_scoped: true,
  };
}

export function getUserMagpieStateSnapshot(
  db: DatabaseSync,
  config: ServerConfig,
  userId: number,
) {
  const vault = loadUserProviderVault(db, config, userId);
  return buildStatePayload(vault);
}

export function getUserMaskingConfig(
  db: DatabaseSync,
  config: ServerConfig,
  userId: number,
): MagpieMaskingConfig {
  return loadUserProviderVault(db, config, userId).masking;
}

export function upsertUserMagpieProvider(
  db: DatabaseSync,
  config: ServerConfig,
  userId: number,
  body: Record<string, unknown>,
  explicitProviderId?: string,
  requireExisting = false,
): MagpieProviderView & { id: string } {
  const vault = loadUserProviderVault(db, config, userId);

  const presetIdRaw =
    typeof body.preset_id === 'string'
      ? body.preset_id.trim()
      : typeof body.kind === 'string'
        ? body.kind.trim()
        : undefined;
  const preset = presetIdRaw
    ? MAGPIE_BUILTIN_PRESETS.find((p) => p.id === presetIdRaw)
    : undefined;

  if (body.provider_id !== undefined && body.provider_id !== null && typeof body.provider_id !== 'string') {
    throw new ApiError(400, 'invalid_provider', 'provider_id must be a string');
  }
  if (body.id !== undefined && body.id !== null && typeof body.id !== 'string') {
    throw new ApiError(400, 'invalid_provider', 'id must be a string');
  }
  if (body.base_url !== undefined && body.base_url !== null && typeof body.base_url !== 'string') {
    throw new ApiError(400, 'invalid_provider', 'base_url must be a string');
  }
  if (body.api_key !== undefined && body.api_key !== null && typeof body.api_key !== 'string') {
    throw new ApiError(400, 'invalid_provider', 'api_key must be a string');
  }
  if (
    body.default_model !== undefined &&
    body.default_model !== null &&
    typeof body.default_model !== 'string'
  ) {
    throw new ApiError(400, 'invalid_provider', 'default_model must be a string');
  }

  const providerIdRaw =
    explicitProviderId ??
    (typeof body.provider_id === 'string' ? body.provider_id.trim() : undefined) ??
    (typeof body.id === 'string' ? body.id.trim() : undefined) ??
    preset?.id ??
    `prov_${crypto.randomBytes(4).toString('hex')}`;

  if (!providerIdRaw || providerIdRaw === 'local_hermes') {
    throw new ApiError(400, 'invalid_provider', 'Invalid or unsupported provider_id');
  }

  if (body.api_mode !== undefined) {
    if (typeof body.api_mode !== 'string' || !ALLOWED_API_MODES.has(body.api_mode)) {
      throw new ApiError(
        400,
        'invalid_provider',
        `Unsupported api_mode: ${String(body.api_mode)}`,
      );
    }
  }

  const existingIdx = vault.providers.findIndex((p) => p.provider_id === providerIdRaw);
  const existing = existingIdx >= 0 ? vault.providers[existingIdx] : undefined;

  if (requireExisting && !existing) {
    throw new ApiError(404, 'provider_not_found', `Provider '${providerIdRaw}' not found`);
  }

  const nextBaseUrlRaw =
    typeof body.base_url === 'string' && body.base_url.trim().length > 0
      ? body.base_url.trim()
      : existing?.base_url ?? preset?.base_url ?? 'https://api.openai.com/v1';
  const baseUrl = normalizeBaseUrl(nextBaseUrlRaw);

  let nextApiKey = existing?.api_key;
  if (typeof body.api_key === 'string' && body.api_key.trim().length > 0) {
    nextApiKey = body.api_key.trim();
  } else if (body.clear_api_key === true) {
    nextApiKey = undefined;
  }

  const nextHeaders =
    body.custom_headers !== undefined
      ? sanitizeHeadersRecord(body.custom_headers)
      : existing?.custom_headers ?? {};

  const nextMode = (
    typeof body.api_mode === 'string'
      ? body.api_mode
      : existing?.api_mode ?? preset?.api_mode ?? 'chat_completions'
  ) as StoredVaultProvider['api_mode'];

  const nextDefaultModel =
    typeof body.default_model === 'string'
      ? body.default_model.trim()
      : typeof body.model === 'string'
        ? body.model.trim()
        : existing?.default_model ?? preset?.default_model ?? 'gpt-4o';

  const nextEnabled =
    body.enabled !== undefined ? Boolean(body.enabled) : existing?.enabled ?? true;

  const updated: StoredVaultProvider = {
    provider_id: providerIdRaw,
    preset_id: presetIdRaw ?? existing?.preset_id ?? preset?.id,
    name:
      typeof body.name === 'string' && body.name.trim().length > 0
        ? body.name.trim()
        : existing?.name ?? preset?.name ?? providerIdRaw,
    api_mode: nextMode,
    base_url: baseUrl,
    default_model: nextDefaultModel,
    enabled: nextEnabled,
    no_key_required: existing?.no_key_required ?? preset?.no_key_required ?? false,
    api_key: nextApiKey,
    custom_headers: nextHeaders,
    models: Array.isArray(body.models)
      ? body.models.filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
      : existing?.models,
    updated_at_ms: Date.now(),
  };

  if (existingIdx >= 0) {
    vault.providers[existingIdx] = updated;
  } else {
    vault.providers.push(updated);
  }

  const shouldActivate =
    body.activate === true ||
    body.set_active === true ||
    (body.activate !== false && !vault.active_provider && updated.enabled);

  if (shouldActivate) {
    vault.active_provider = updated.provider_id;
    if (updated.default_model) {
      vault.active_model = updated.default_model;
    }
  } else if (vault.active_provider === updated.provider_id && !updated.enabled) {
    const nextEnabledProv = vault.providers.find((p) => p.enabled);
    vault.active_provider = nextEnabledProv?.provider_id ?? '';
    vault.active_model = nextEnabledProv?.default_model ?? '';
  }

  saveUserProviderVault(db, config, userId, vault);
  return toProviderView(updated);
}

// ============================================================================
// Gemini / Vertex Schema Sanitization & Parallel functionResponses Builder
// ============================================================================

const VERTEX_UNSUPPORTED_SCHEMA_KEYS = new Set([
  '$schema',
  'additionalProperties',
  'default',
  'title',
  'examples',
  '$defs',
  'definitions',
  '$id',
  'const',
]);

export function sanitizeSchemaForGemini(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => sanitizeSchemaForGemini(item));
  }
  if (!isPlainObject(schema)) {
    return schema;
  }
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(schema)) {
    if (VERTEX_UNSUPPORTED_SCHEMA_KEYS.has(key)) {
      continue;
    }
    if (key === 'type') {
      if (Array.isArray(val)) {
        const types = val.filter((t): t is string => typeof t === 'string');
        const hasNull = types.includes('null');
        const nonNull = types.find((t) => t !== 'null') ?? 'string';
        out.type = nonNull;
        if (hasNull) {
          out.nullable = true;
        }
        continue;
      }
      if (val === 'null') {
        out.type = 'string';
        out.nullable = true;
        continue;
      }
      out.type = val;
      continue;
    }
    if (key === 'properties' && isPlainObject(val)) {
      const cleanProps: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(val)) {
        cleanProps[pk] = sanitizeSchemaForGemini(pv);
      }
      out.properties = cleanProps;
      continue;
    }
    if (key === 'items' || key === 'anyOf' || key === 'oneOf' || key === 'allOf') {
      out[key] = sanitizeSchemaForGemini(val);
      continue;
    }
    out[key] = isPlainObject(val) || Array.isArray(val) ? sanitizeSchemaForGemini(val) : val;
  }
  return out;
}

function parseJsonObjectSafe(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isPlainObject(parsed)) return parsed;
    return { result: parsed };
  } catch {
    return { result: raw };
  }
}

export function buildGeminiGenerateContentPayload(
  messages: LlmChatMessage[],
  tools?: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const systemParts: Array<{ text: string }> = [];
  const contents: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }> = [];

  let pendingCallNames: Array<{ id?: string; name: string }> = [];
  let currentToolParts: Array<Record<string, unknown>> = [];

  const flushPendingTools = (): void => {
    if (pendingCallNames.length > 0) {
      for (const pending of pendingCallNames) {
        currentToolParts.push({
          functionResponse: {
            name: pending.name,
            response: {
              error: 'Tool execution interrupted or unavailable in prior turn',
            },
          },
        });
      }
      pendingCallNames = [];
    }
    if (currentToolParts.length > 0) {
      contents.push({ role: 'user', parts: currentToolParts });
      currentToolParts = [];
    }
  };

  for (const msg of messages) {
    if (msg.role === 'system') {
      if (typeof msg.content === 'string' && msg.content.trim()) {
        systemParts.push({ text: msg.content });
      }
      continue;
    }

    if (msg.role === 'tool') {
      let resolvedName = typeof msg.name === 'string' && msg.name.trim() ? msg.name.trim() : '';
      if (msg.tool_call_id) {
        const idxById = pendingCallNames.findIndex((p) => p.id === msg.tool_call_id);
        if (idxById >= 0) {
          resolvedName = resolvedName || pendingCallNames[idxById]!.name;
          pendingCallNames.splice(idxById, 1);
        } else if (resolvedName) {
          const idxByName = pendingCallNames.findIndex((p) => p.name === resolvedName);
          if (idxByName >= 0) pendingCallNames.splice(idxByName, 1);
        } else if (pendingCallNames.length > 0) {
          resolvedName = pendingCallNames.shift()!.name;
        }
      } else if (resolvedName) {
        const idxByName = pendingCallNames.findIndex((p) => p.name === resolvedName);
        if (idxByName >= 0) pendingCallNames.splice(idxByName, 1);
      } else if (pendingCallNames.length > 0) {
        resolvedName = pendingCallNames.shift()!.name;
      }

      currentToolParts.push({
        functionResponse: {
          name: resolvedName || 'unknown_tool',
          response: parseJsonObjectSafe(String(msg.content ?? '')),
        },
      });
      continue;
    }

    // Any non-tool turn flushes merged parallel functionResponses (plus interrupted pads)
    flushPendingTools();

    if (msg.role === 'assistant' || msg.role === 'model') {
      const parts: Array<Record<string, unknown>> = [];
      if (typeof msg.content === 'string' && msg.content.length > 0) {
        parts.push({ text: msg.content });
      }
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      const anyHasSig = calls.some(
        (c) => typeof c.thought_signature === 'string' && c.thought_signature.trim().length > 0,
      );
      calls.forEach((call, idx) => {
        const name = call.function?.name ?? 'unknown_tool';
        const argsObj = parseJsonObjectSafe(call.function?.arguments ?? '{}');
        const part: Record<string, unknown> = {
          functionCall: {
            name,
            args: argsObj,
          },
        };
        if (typeof call.thought_signature === 'string' && call.thought_signature.trim().length > 0) {
          part.thoughtSignature = call.thought_signature.trim();
        } else if (!anyHasSig && idx === 0) {
          part.thoughtSignature = 'skip_thought_signature_validator';
        }
        parts.push(part);
        pendingCallNames.push({ id: call.id, name });
      });
      if (parts.length === 0) {
        parts.push({ text: '' });
      }
      contents.push({ role: 'model', parts });
      continue;
    }

    // User turn
    contents.push({
      role: 'user',
      parts: [{ text: String(msg.content ?? '') }],
    });
  }

  flushPendingTools();

  const payload: Record<string, unknown> = { contents };
  if (systemParts.length > 0) {
    payload.systemInstruction = { parts: systemParts };
  }
  if (Array.isArray(tools) && tools.length > 0) {
    const declarations = tools
      .filter((t): t is Record<string, unknown> => isPlainObject(t))
      .map((t) => {
        const fn = isPlainObject(t.function) ? t.function : t;
        const name = typeof fn.name === 'string' ? fn.name : '';
        if (!name) return null;
        return {
          name,
          description: typeof fn.description === 'string' ? fn.description : '',
          ...(fn.parameters !== undefined
            ? { parameters: sanitizeSchemaForGemini(fn.parameters) }
            : {}),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (declarations.length > 0) {
      payload.tools = [{ functionDeclarations: declarations }];
    }
  }
  return payload;
}

// ============================================================================
// Live 2-Tier `models.dev` Catalog
// ============================================================================

function isChatModelId(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  if (lower === 'tts') return false;
  return !NON_CHAT_MODEL_SUBSTRINGS.some((sub) => lower.includes(sub));
}

function parseModelsDevPayload(raw: unknown): Record<string, string[]> {
  if (!isPlainObject(raw)) {
    throw new Error('Invalid models.dev payload');
  }
  const providers: Record<string, string[]> = {};
  for (const [providerKey, provVal] of Object.entries(raw)) {
    if (!isPlainObject(provVal) || !isPlainObject(provVal.models)) continue;
    const candidates: Array<{ id: string; releaseDate: string }> = [];
    const seen = new Set<string>();
    for (const [mKey, mVal] of Object.entries(provVal.models)) {
      const rec = isPlainObject(mVal) ? mVal : {};
      const modelId = typeof rec.id === 'string' && rec.id.trim() ? rec.id.trim() : mKey.trim();
      if (!modelId || seen.has(modelId) || !isChatModelId(modelId)) continue;
      seen.add(modelId);
      const releaseDate = typeof rec.release_date === 'string' ? rec.release_date : '';
      candidates.push({ id: modelId, releaseDate });
    }
    candidates.sort((a, b) => {
      if (a.releaseDate !== b.releaseDate) {
        return a.releaseDate < b.releaseDate ? 1 : -1;
      }
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
    if (candidates.length > 0) {
      providers[providerKey] = candidates
        .slice(0, MODELS_CATALOG_MAX_PER_PROVIDER)
        .map((c) => c.id);
    }
  }
  return providers;
}

function readDiskCatalogCache(dataDir: string): ModelsCatalogCache | null {
  const filePath = path.join(dataDir, MODELS_CATALOG_CACHE_FILE);
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as ModelsCatalogCache;
    if (
      raw &&
      typeof raw.fetched_at_ms === 'number' &&
      isPlainObject(raw.providers)
    ) {
      return raw;
    }
    return null;
  } catch {
    return null;
  }
}

function writeDiskCatalogCache(dataDir: string, cache: ModelsCatalogCache): void {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, MODELS_CATALOG_CACHE_FILE),
      JSON.stringify(cache),
      'utf8',
    );
  } catch {
    // Non-fatal disk cache write failure
  }
}

async function fetchModelsDevCatalog(
  config: ServerConfig,
  refresh: boolean,
): Promise<ModelsCatalogCache> {
  const now = Date.now();
  const mem = memoryCatalogCache.get(config.dataDir);
  if (!refresh && mem && now - mem.fetched_at_ms < MODELS_CATALOG_TTL_MS) {
    return mem;
  }

  const disk = !mem ? readDiskCatalogCache(config.dataDir) : mem;
  if (!refresh && disk && now - disk.fetched_at_ms < MODELS_CATALOG_TTL_MS) {
    memoryCatalogCache.set(config.dataDir, disk);
    return disk;
  }

  const catalogUrl = process.env.MODELS_DEV_CATALOG_URL?.trim() || 'https://models.dev/api.json';
  try {
    const res = await fetch(catalogUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`models.dev returned HTTP ${res.status}`);
    }
    const json = (await res.json()) as unknown;
    const providers = parseModelsDevPayload(json);
    const fresh: ModelsCatalogCache = {
      fetched_at_ms: now,
      source: 'models.dev',
      providers,
    };
    memoryCatalogCache.set(config.dataDir, fresh);
    writeDiskCatalogCache(config.dataDir, fresh);
    return fresh;
  } catch (err) {
    // Stale cache fallback ONLY when a real cached snapshot exists
    const stale = mem ?? disk ?? readDiskCatalogCache(config.dataDir);
    if (stale) {
      memoryCatalogCache.set(config.dataDir, stale);
      return stale;
    }
    throw new ApiError(
      502,
      'models_catalog_fetch_failed',
      err instanceof Error ? err.message : 'Failed to fetch live models.dev catalog',
    );
  }
}

// ============================================================================
// Core Upstream Dispatch & Shared `runConfiguredLlmCompletion`
// ============================================================================

function providerNotConfiguredError(): ApiError {
  return new ApiError(
    503,
    'provider_not_configured',
    'No AI model provider is configured for your account. Configure an AI provider in Magpie LLM Gateway.',
    {
      needs_provider_selection: true,
      action: 'hermes:open_ai_providers',
    },
  );
}

interface ResolvedProviderTarget {
  providerId: string;
  apiMode: StoredVaultProvider['api_mode'];
  baseUrl: string;
  model: string;
  apiKey: string;
  customHeaders: Record<string, string>;
}

function resolveUserProviderTarget(
  vault: UserProviderVaultState,
  config: ServerConfig,
  opts?: { providerId?: string; model?: string },
): ResolvedProviderTarget | null {
  const requestedPid =
    opts?.providerId && opts.providerId !== 'local_hermes'
      ? opts.providerId.trim()
      : vault.active_provider;

  const findEnabledById = (pid: string): StoredVaultProvider | undefined =>
    vault.providers.find((p) => p.provider_id === pid && p.enabled !== false);

  let prov = requestedPid ? findEnabledById(requestedPid) : undefined;
  if (!prov && !opts?.providerId) {
    prov = vault.providers.find((p) => p.enabled !== false);
  }

  if (prov && /^https?:\/\//i.test(prov.base_url)) {
    const requestedModel =
      opts?.model &&
      opts.model.trim().length > 0 &&
      opts.model !== 'hermes-local-v1' &&
      opts.model !== 'hermes-fast-v1'
        ? opts.model.trim()
        : vault.active_provider === prov.provider_id && vault.active_model
          ? vault.active_model
          : prov.default_model;

    return {
      providerId: prov.provider_id,
      apiMode: prov.api_mode,
      baseUrl: prov.base_url,
      model: requestedModel || prov.default_model || 'gpt-4o',
      apiKey: prov.api_key?.trim() || '',
      customHeaders: prov.custom_headers ?? {},
    };
  }

  // Fallback to explicit server-configured AI Gateway env key (ONLY if explicitly configured)
  const gatewayKey = process.env.AI_GATEWAY_API_KEY?.trim();
  if (!opts?.providerId && gatewayKey && /^https?:\/\//i.test(config.aiGatewayUrl)) {
    const base = config.aiGatewayUrl.replace(/\/+$/, '');
    const effectiveModel =
      opts?.model && opts.model !== 'hermes-local-v1' && opts.model !== 'hermes-fast-v1'
        ? opts.model
        : process.env.AI_GATEWAY_MODEL?.trim() || 'gpt-4o-mini';
    return {
      providerId: 'ombhrum_gateway',
      apiMode: 'chat_completions',
      baseUrl: base.endsWith('/v1') ? base : `${base}/v1`,
      model: effectiveModel,
      apiKey: gatewayKey,
      customHeaders: {},
    };
  }

  return null;
}

async function executeUpstreamCall(
  target: ResolvedProviderTarget,
  messages: LlmChatMessage[],
  opts?: {
    tools?: Array<Record<string, unknown>>;
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<LlmCompletionResult> {
  const headers: Record<string, string> = {
    ...target.customHeaders,
    'Content-Type': 'application/json',
  };
  let upstreamUrl: string;
  let reqPayload: Record<string, unknown>;

  if (target.apiMode === 'anthropic_messages') {
    upstreamUrl = joinUpstreamPath(target.baseUrl, '/messages');
    if (target.apiKey) headers['x-api-key'] = target.apiKey;
    headers['anthropic-version'] = headers['anthropic-version'] ?? '2023-06-01';
    const sysText = messages
      .filter((m) => m.role === 'system' && typeof m.content === 'string')
      .map((m) => m.content)
      .join('\n\n');
    const anthropicMessages = messages
      .filter((m) => m.role !== 'system')
      .map((m) => {
        if (m.role === 'tool') {
          return {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: m.tool_call_id ?? 'tool_0',
                content: String(m.content ?? ''),
              },
            ],
          };
        }
        if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
          const blocks: Array<Record<string, unknown>> = [];
          if (m.content) blocks.push({ type: 'text', text: m.content });
          for (const tc of m.tool_calls) {
            blocks.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input: parseJsonObjectSafe(tc.function.arguments),
            });
          }
          return { role: 'assistant', content: blocks };
        }
        return {
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: String(m.content ?? ''),
        };
      });

    reqPayload = {
      model: target.model,
      max_tokens: opts?.maxTokens ?? 1024,
      ...(sysText ? { system: sysText } : {}),
      messages: anthropicMessages,
    };
    if (opts?.temperature !== undefined) reqPayload.temperature = opts.temperature;
    if (Array.isArray(opts?.tools) && opts.tools.length > 0) {
      reqPayload.tools = opts.tools
        .filter((t): t is Record<string, unknown> => isPlainObject(t))
        .map((t) => {
          const fn = isPlainObject(t.function) ? t.function : t;
          return {
            name: fn.name,
            description: fn.description ?? '',
            input_schema: fn.parameters ?? { type: 'object', properties: {} },
          };
        });
    }
  } else if (target.apiMode === 'gemini_generate_content') {
    upstreamUrl = joinUpstreamPath(
      target.baseUrl,
      `/models/${encodeURIComponent(target.model)}:generateContent${
        target.apiKey ? `?key=${encodeURIComponent(target.apiKey)}` : ''
      }`,
    );
    reqPayload = buildGeminiGenerateContentPayload(messages, opts?.tools);
  } else if (target.apiMode === 'codex_responses') {
    upstreamUrl = joinUpstreamPath(target.baseUrl, '/responses');
    if (target.apiKey) headers.Authorization = `Bearer ${target.apiKey}`;
    reqPayload = {
      model: target.model,
      input: messages,
      ...(Array.isArray(opts?.tools) && opts.tools.length > 0 ? { tools: opts.tools } : {}),
    };
  } else {
    upstreamUrl = joinUpstreamPath(target.baseUrl, '/chat/completions');
    if (target.apiKey) headers.Authorization = `Bearer ${target.apiKey}`;
    reqPayload = {
      model: target.model,
      messages,
      stream: false,
      ...(Array.isArray(opts?.tools) && opts.tools.length > 0 ? { tools: opts.tools } : {}),
      ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts?.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
    };
  }

  const timeoutSignal = AbortSignal.timeout(opts?.timeoutMs ?? 20_000);
  const signal = opts?.signal
    ? AbortSignal.any([opts.signal, timeoutSignal])
    : timeoutSignal;

  const upstreamRes = await fetch(upstreamUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(reqPayload),
    signal,
  });

  if (!upstreamRes.ok) {
    const errSnippet = await upstreamRes.text().catch(() => '');
    throw new Error(
      `Upstream ${target.providerId} returned HTTP ${upstreamRes.status}${
        errSnippet ? `: ${errSnippet.slice(0, 200)}` : ''
      }`,
    );
  }

  const json = (await upstreamRes.json()) as Record<string, unknown>;
  let text = '';
  let reasoning: string | undefined;
  let finishReason = 'stop';
  const toolCalls: LlmToolCall[] = [];
  let promptTokens = 0;
  let completionTokens = 0;
  let reasoningTokens = 0;
  let totalTokens = 0;

  if (Array.isArray(json.choices) && json.choices.length > 0) {
    const choice0 = json.choices[0] as Record<string, unknown>;
    const msg = isPlainObject(choice0.message) ? choice0.message : {};
    if (typeof msg.content === 'string') text = msg.content;
    if (typeof msg.reasoning_content === 'string') reasoning = msg.reasoning_content;
    if (typeof choice0.finish_reason === 'string') finishReason = choice0.finish_reason;
    if (Array.isArray(msg.tool_calls)) {
      for (const rawTc of msg.tool_calls) {
        if (!isPlainObject(rawTc) || !isPlainObject(rawTc.function)) continue;
        toolCalls.push({
          id: typeof rawTc.id === 'string' ? rawTc.id : `call_${crypto.randomBytes(4).toString('hex')}`,
          type: 'function',
          function: {
            name: String(rawTc.function.name ?? ''),
            arguments:
              typeof rawTc.function.arguments === 'string'
                ? rawTc.function.arguments
                : JSON.stringify(rawTc.function.arguments ?? {}),
          },
          ...(typeof rawTc.thought_signature === 'string'
            ? { thought_signature: rawTc.thought_signature }
            : {}),
        });
      }
    }
    if (isPlainObject(json.usage)) {
      promptTokens = Number(json.usage.prompt_tokens ?? 0) || 0;
      completionTokens = Number(json.usage.completion_tokens ?? 0) || 0;
      totalTokens = Number(json.usage.total_tokens ?? promptTokens + completionTokens) || 0;
      const details = isPlainObject(json.usage.completion_tokens_details)
        ? json.usage.completion_tokens_details
        : {};
      reasoningTokens = Number(details.reasoning_tokens ?? json.usage.reasoning_tokens ?? 0) || 0;
    }
  } else if (Array.isArray(json.content)) {
    // Anthropic Messages response
    const texts: string[] = [];
    for (const block of json.content) {
      if (!isPlainObject(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        texts.push(block.text);
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        reasoning = (reasoning ?? '') + block.thinking;
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        toolCalls.push({
          id: typeof block.id === 'string' ? block.id : `toolu_${crypto.randomBytes(4).toString('hex')}`,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
      }
    }
    text = texts.join('');
    finishReason = typeof json.stop_reason === 'string' ? json.stop_reason : 'stop';
    if (isPlainObject(json.usage)) {
      promptTokens = Number(json.usage.input_tokens ?? 0) || 0;
      completionTokens = Number(json.usage.output_tokens ?? 0) || 0;
      totalTokens = promptTokens + completionTokens;
    }
  } else if (Array.isArray(json.candidates)) {
    // Gemini generateContent response
    const cand0 = json.candidates[0] as Record<string, unknown> | undefined;
    const contentObj = cand0 && isPlainObject(cand0.content) ? cand0.content : {};
    const parts = Array.isArray(contentObj.parts) ? contentObj.parts : [];
    const texts: string[] = [];
    for (const part of parts) {
      if (!isPlainObject(part)) continue;
      if (typeof part.text === 'string') {
        texts.push(part.text);
      }
      if (isPlainObject(part.functionCall) && typeof part.functionCall.name === 'string') {
        const sig =
          typeof part.thoughtSignature === 'string'
            ? part.thoughtSignature
            : typeof part.thought_signature === 'string'
              ? part.thought_signature
              : undefined;
        toolCalls.push({
          id: `call_${crypto.randomBytes(4).toString('hex')}`,
          type: 'function',
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args ?? {}),
          },
          ...(sig ? { thought_signature: sig } : {}),
        });
      }
    }
    text = texts.join('');
    if (cand0 && typeof cand0.finishReason === 'string') {
      finishReason = cand0.finishReason.toLowerCase();
    }
    if (isPlainObject(json.usageMetadata)) {
      promptTokens = Number(json.usageMetadata.promptTokenCount ?? 0) || 0;
      completionTokens = Number(json.usageMetadata.candidatesTokenCount ?? 0) || 0;
      reasoningTokens = Number(json.usageMetadata.thoughtsTokenCount ?? 0) || 0;
      totalTokens =
        Number(json.usageMetadata.totalTokenCount ?? promptTokens + completionTokens) || 0;
    }
  } else if (typeof json.output_text === 'string' || Array.isArray(json.output)) {
    // OpenAI Responses API
    if (typeof json.output_text === 'string') {
      text = json.output_text;
    } else if (Array.isArray(json.output)) {
      const texts: string[] = [];
      for (const item of json.output) {
        if (!isPlainObject(item)) continue;
        if (item.type === 'function_call' && typeof item.name === 'string') {
          toolCalls.push({
            id: typeof item.call_id === 'string' ? item.call_id : `fc_${crypto.randomBytes(4).toString('hex')}`,
            type: 'function',
            function: {
              name: item.name,
              arguments:
                typeof item.arguments === 'string'
                  ? item.arguments
                  : JSON.stringify(item.arguments ?? {}),
            },
          });
        } else if (Array.isArray(item.content)) {
          for (const c of item.content) {
            if (isPlainObject(c) && typeof c.text === 'string') texts.push(c.text);
          }
        }
      }
      text = texts.join('');
    }
    if (isPlainObject(json.usage)) {
      promptTokens = Number(json.usage.input_tokens ?? json.usage.prompt_tokens ?? 0) || 0;
      completionTokens = Number(json.usage.output_tokens ?? json.usage.completion_tokens ?? 0) || 0;
      totalTokens = Number(json.usage.total_tokens ?? promptTokens + completionTokens) || 0;
    }
  }

  return {
    text,
    usedUpstream: true,
    providerId: target.providerId,
    model: target.model,
    ...(reasoning ? { reasoning } : {}),
    finishReason,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      reasoning_tokens: reasoningTokens,
      total_tokens: totalTokens || promptTokens + completionTokens,
    },
  };
}

export async function runConfiguredLlmCompletion(
  db: DatabaseSync,
  config: ServerConfig,
  userId: number,
  messages: LlmChatMessage[],
  opts?: {
    providerId?: string;
    model?: string;
    tools?: Array<Record<string, unknown>>;
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
  },
): Promise<LlmCompletionResult> {
  const vault = loadUserProviderVault(db, config, userId);
  const target = resolveUserProviderTarget(vault, config, opts);
  if (!target) {
    return {
      text: '',
      usedUpstream: false,
      unconfigured: true,
      providerId: '',
      model: '',
    };
  }

  const t0 = Date.now();
  try {
    const res = await executeUpstreamCall(target, messages, opts);
    const latencyMs = Math.max(0, Date.now() - t0);
    db.prepare(`
      INSERT INTO magpie_usage_ledger (
        entry_id, user_id, provider_id, model, prompt_tokens, completion_tokens, masked_hits, latency_ms, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      `use_${crypto.randomBytes(6).toString('hex')}`,
      userId,
      target.providerId,
      target.model,
      res.usage?.prompt_tokens ?? 0,
      res.usage?.completion_tokens ?? 0,
      latencyMs,
      Date.now(),
    );
    return res;
  } catch (err) {
    return {
      text: '',
      usedUpstream: false,
      providerId: target.providerId,
      model: target.model,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ============================================================================
// Route Registration (Dual `/api/v1/fabushi/magpie/*` & `/api/v1/hermes/magpie/*`)
// ============================================================================

export function registerMagpieGatewayRoutes(
  router: HttpRouter,
  db: DatabaseSync,
  config: ServerConfig,
): void {
  const mountDual = (
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    suffix: string,
    handler: (ctx: RequestContext) => void | Promise<void>,
  ): void => {
    router[method](`/api/v1/fabushi/magpie${suffix}`, handler);
    router[method](`/api/v1/hermes/magpie${suffix}`, handler);
  };

  // 1. Built-in Presets & Gateway State Snapshot
  mountDual('get', '/presets', (ctx) => {
    requireAuth(db, ctx);
    sendJson(ctx.res, 200, {
      total: MAGPIE_BUILTIN_PRESETS.length,
      presets: MAGPIE_BUILTIN_PRESETS,
    });
  });

  const handleGetState = (ctx: RequestContext): void => {
    const auth = requireAuth(db, ctx);
    const vault = loadUserProviderVault(db, config, auth.userId);
    sendJson(ctx.res, 200, buildStatePayload(vault));
  };
  mountDual('get', '/state', handleGetState);
  mountDual('get', '/config', handleGetState);
  mountDual('get', '', handleGetState);

  const handleUpdateState = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const patch = await readJsonBody<Record<string, unknown>>(ctx.req);
    const vault = loadUserProviderVault(db, config, auth.userId);

    const activeProv =
      patch.active_provider !== undefined
        ? patch.active_provider
        : patch.active_provider_id;
    if (activeProv !== undefined) {
      if (typeof activeProv !== 'string' || activeProv === 'local_hermes') {
        throw new ApiError(400, 'invalid_provider', 'Invalid active_provider');
      }
      vault.active_provider = activeProv.trim();
    }
    if (patch.active_model !== undefined) {
      if (
        typeof patch.active_model !== 'string' ||
        patch.active_model === 'hermes-local-v1' ||
        patch.active_model === 'hermes-fast-v1'
      ) {
        throw new ApiError(400, 'invalid_model', 'Invalid active_model');
      }
      vault.active_model = patch.active_model.trim();
    }
    if (patch.allow_local_fallback !== undefined) {
      vault.allow_local_fallback = Boolean(patch.allow_local_fallback);
    }
    if (patch.routing_strategy !== undefined) {
      if (typeof patch.routing_strategy !== 'string') {
        throw new ApiError(400, 'invalid_routing_strategy', 'routing_strategy must be a string');
      }
      if (patch.routing_strategy.trim()) {
        vault.routing_strategy = patch.routing_strategy.trim();
      }
    }
    if (patch.routing_groups !== undefined) {
      if (!Array.isArray(patch.routing_groups)) {
        throw new ApiError(400, 'invalid_routing_groups', 'routing_groups must be an array');
      }
      const validatedGroups: MagpieRoutingGroup[] = [];
      for (const rawG of patch.routing_groups) {
        if (!isPlainObject(rawG) || typeof rawG.id !== 'string' || !rawG.id.trim()) {
          throw new ApiError(
            400,
            'invalid_routing_groups',
            'Each routing group must be an object with a non-empty string id',
          );
        }
        const validatedMembers: MagpieRoutingGroup['members'] = [];
        if (rawG.members !== undefined) {
          if (!Array.isArray(rawG.members)) {
            throw new ApiError(400, 'invalid_routing_groups', 'routing group members must be an array');
          }
          for (const rawM of rawG.members) {
            if (!isPlainObject(rawM) || typeof rawM.target !== 'string' || !rawM.target.trim()) {
              throw new ApiError(
                400,
                'invalid_routing_groups',
                'Each routing group member must be an object with a non-empty string target',
              );
            }
            if (rawM.target.trim() === 'local_hermes') {
              throw new ApiError(400, 'invalid_routing_groups', 'local_hermes is not allowed in routing groups');
            }
            validatedMembers.push({
              target: rawM.target.trim(),
              weight:
                typeof rawM.weight === 'number' && Number.isFinite(rawM.weight)
                  ? Math.max(0, Math.floor(rawM.weight))
                  : 100,
              enabled: rawM.enabled !== false,
              free: Boolean(rawM.free),
            });
          }
        }
        validatedGroups.push({
          id: rawG.id.trim(),
          name: typeof rawG.name === 'string' && rawG.name.trim() ? rawG.name.trim() : rawG.id.trim(),
          strategy:
            typeof rawG.strategy === 'string' && rawG.strategy.trim()
              ? (rawG.strategy.trim() as MagpieRoutingGroup['strategy'])
              : 'smart',
          members: validatedMembers,
          sticky_ttl_ms:
            typeof rawG.sticky_ttl_ms === 'number' && Number.isFinite(rawG.sticky_ttl_ms)
              ? Math.max(0, Math.floor(rawG.sticky_ttl_ms))
              : 300_000,
        });
      }
      vault.routing_groups = validatedGroups;
    }
    if (patch.masking !== undefined) {
      if (!isPlainObject(patch.masking)) {
        throw new ApiError(400, 'invalid_masking', 'masking must be a JSON object');
      }
      vault.masking = normalizeVaultState({ masking: { ...vault.masking, ...patch.masking } as MagpieMaskingConfig }).masking;
    }

    saveUserProviderVault(db, config, auth.userId, vault);
    sendJson(ctx.res, 200, buildStatePayload(vault));
  };
  mountDual('put', '/config', handleUpdateState);
  mountDual('patch', '/config', handleUpdateState);
  mountDual('post', '/config', handleUpdateState);
  mountDual('put', '/state', handleUpdateState);

  // 2. Per-User Encrypted Providers CRUD (strict tenant isolation + redacted reads)
  mountDual('get', '/providers', (ctx) => {
    const auth = requireAuth(db, ctx);
    const vault = loadUserProviderVault(db, config, auth.userId);
    sendJson(ctx.res, 200, {
      providers: vault.providers.map(toProviderView),
    });
  });

  const handleCreateOrPutProvider = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<Record<string, unknown>>(ctx.req);
    const view = upsertUserMagpieProvider(
      db,
      config,
      auth.userId,
      body,
      ctx.params.providerId,
      false,
    );
    sendJson(ctx.res, ctx.method === 'POST' ? 201 : 200, view);
  };
  mountDual('post', '/providers', handleCreateOrPutProvider);
  mountDual('put', '/providers', handleCreateOrPutProvider);
  mountDual('put', '/providers/:providerId', handleCreateOrPutProvider);

  mountDual('get', '/providers/:providerId', (ctx) => {
    const auth = requireAuth(db, ctx);
    const providerId = ctx.params.providerId!;
    const vault = loadUserProviderVault(db, config, auth.userId);
    const prov = vault.providers.find((p) => p.provider_id === providerId);
    if (!prov) {
      throw new ApiError(404, 'provider_not_found', `Provider '${providerId}' not found`);
    }
    sendJson(ctx.res, 200, toProviderView(prov));
  });

  mountDual('patch', '/providers/:providerId', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<Record<string, unknown>>(ctx.req);
    const view = upsertUserMagpieProvider(
      db,
      config,
      auth.userId,
      body,
      ctx.params.providerId,
      true,
    );
    sendJson(ctx.res, 200, view);
  });

  mountDual('delete', '/providers/:providerId', (ctx) => {
    const auth = requireAuth(db, ctx);
    const providerId = ctx.params.providerId!;
    const vault = loadUserProviderVault(db, config, auth.userId);
    const idx = vault.providers.findIndex((p) => p.provider_id === providerId);
    if (idx < 0) {
      throw new ApiError(404, 'provider_not_found', `Provider '${providerId}' not found`);
    }
    vault.providers.splice(idx, 1);
    if (vault.active_provider === providerId) {
      const next = vault.providers.find((p) => p.enabled !== false);
      vault.active_provider = next?.provider_id ?? '';
      vault.active_model = next?.default_model ?? '';
    }
    saveUserProviderVault(db, config, auth.userId, vault);
    sendJson(ctx.res, 200, { ok: true, deleted: providerId });
  });

  mountDual('post', '/providers/:providerId/probe', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const providerId = ctx.params.providerId!;
    const vault = loadUserProviderVault(db, config, auth.userId);
    const prov = vault.providers.find((p) => p.provider_id === providerId);
    if (!prov) {
      throw new ApiError(404, 'provider_not_found', `Provider '${providerId}' not found`);
    }

    const t0 = performance.now();
    const apiKey = prov.api_key?.trim() || '';
    const probeUrl =
      prov.api_mode === 'gemini_generate_content' && apiKey
        ? joinUpstreamPath(prov.base_url, `/models?key=${encodeURIComponent(apiKey)}`)
        : joinUpstreamPath(prov.base_url, '/models');

    const headers: Record<string, string> = { ...prov.custom_headers };
    if (prov.api_mode === 'anthropic_messages') {
      if (apiKey) headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = headers['anthropic-version'] ?? '2023-06-01';
    } else if (apiKey && prov.api_mode !== 'gemini_generate_content') {
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

      let models: string[] = prov.default_model ? [prov.default_model] : [];
      try {
        const parsed: unknown = await probeRes.json();
        if (isPlainObject(parsed)) {
          if (Array.isArray(parsed.data) && parsed.data.length > 0) {
            models = parsed.data
              .filter((m): m is Record<string, unknown> => isPlainObject(m))
              .map((m) => (typeof m.id === 'string' ? m.id.trim() : ''))
              .filter(Boolean);
          } else if (Array.isArray(parsed.models) && parsed.models.length > 0) {
            models = parsed.models
              .filter((m): m is Record<string, unknown> => isPlainObject(m))
              .map((m) => (typeof m.name === 'string' ? m.name.trim().replace(/^models\//, '') : ''))
              .filter(Boolean);
          }
        }
      } catch {
        // Non-JSON /models body still proves reachability
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

  // 3. Live 2-Tier `models.dev` Catalog
  mountDual('get', '/models/catalog', async (ctx) => {
    requireAuth(db, ctx);
    const refreshRaw = (ctx.query.get('refresh') ?? '').trim().toLowerCase();
    const refresh = refreshRaw === 'true' || refreshRaw === '1';
    const catalog = await fetchModelsDevCatalog(config, refresh);
    sendJson(ctx.res, 200, catalog);
  });

  // 4. Routing Groups CRUD
  mountDual('get', '/groups', (ctx) => {
    const auth = requireAuth(db, ctx);
    const vault = loadUserProviderVault(db, config, auth.userId);
    sendJson(ctx.res, 200, { groups: vault.routing_groups });
  });

  const handleUpsertGroup = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      id?: unknown;
      group_id?: unknown;
      name?: unknown;
      strategy?: unknown;
      members?: unknown;
      models?: unknown;
      sticky_ttl_ms?: unknown;
    }>(ctx.req);
    if (body.id !== undefined && body.id !== null && typeof body.id !== 'string') {
      throw new ApiError(400, 'invalid_group_id', 'id must be a string');
    }
    if (body.group_id !== undefined && body.group_id !== null && typeof body.group_id !== 'string') {
      throw new ApiError(400, 'invalid_group_id', 'group_id must be a string');
    }
    const vault = loadUserProviderVault(db, config, auth.userId);
    const groupId =
      ctx.params.groupId ??
      (typeof body.id === 'string' && body.id.trim() ? body.id.trim() : undefined) ??
      (typeof body.group_id === 'string' && body.group_id.trim() ? body.group_id.trim() : undefined) ??
      `grp_${crypto.randomBytes(4).toString('hex')}`;
    const idx = vault.routing_groups.findIndex((g) => g.id === groupId);
    const existing = idx >= 0 ? vault.routing_groups[idx] : undefined;

    let members = existing?.members ?? [];
    if (body.members !== undefined) {
      if (!Array.isArray(body.members)) {
        throw new ApiError(400, 'invalid_group_members', 'members must be an array');
      }
      const nextMembers: MagpieRoutingGroup['members'] = [];
      for (const m of body.members) {
        if (!isPlainObject(m) || typeof m.target !== 'string' || !m.target.trim()) {
          throw new ApiError(400, 'invalid_group_members', 'Each member must be an object with a string target');
        }
        if (m.target.trim() === 'local_hermes') continue;
        nextMembers.push({
          target: m.target.trim(),
          weight:
            typeof m.weight === 'number' && Number.isFinite(m.weight)
              ? Math.max(0, Math.floor(m.weight))
              : 100,
          enabled: m.enabled !== false,
          free: Boolean(m.free),
        });
      }
      members = nextMembers;
    } else if (Array.isArray(body.models)) {
      members = body.models
        .filter((m): m is string => typeof m === 'string' && m.trim().length > 0 && m !== 'local_hermes')
        .map((m) => ({ target: m.trim(), weight: 100, enabled: true, free: false }));
    }

    const group: MagpieRoutingGroup = {
      id: groupId,
      name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : existing?.name || 'Routing Group',
      strategy:
        typeof body.strategy === 'string' && body.strategy.trim()
          ? (body.strategy.trim() as MagpieRoutingGroup['strategy'])
          : existing?.strategy ?? 'smart',
      members,
      sticky_ttl_ms:
        typeof body.sticky_ttl_ms === 'number' && Number.isFinite(body.sticky_ttl_ms)
          ? Math.max(0, Math.floor(body.sticky_ttl_ms))
          : existing?.sticky_ttl_ms ?? 300_000,
    };

    if (idx >= 0) vault.routing_groups[idx] = group;
    else vault.routing_groups.push(group);
    saveUserProviderVault(db, config, auth.userId, vault);
    sendJson(ctx.res, ctx.method === 'POST' ? 201 : 200, group);
  };
  mountDual('post', '/groups', handleUpsertGroup);
  mountDual('put', '/groups/:groupId', handleUpsertGroup);

  mountDual('delete', '/groups/:groupId', (ctx) => {
    const auth = requireAuth(db, ctx);
    const vault = loadUserProviderVault(db, config, auth.userId);
    vault.routing_groups = vault.routing_groups.filter((g) => g.id !== ctx.params.groupId);
    saveUserProviderVault(db, config, auth.userId, vault);
    sendJson(ctx.res, 200, { ok: true, groups: vault.routing_groups });
  });

  // 5. Client-Scoped Subscriptions Sync / Scan / Activate (NEVER reads server OS creds!)
  mountDual('get', '/subscriptions', (ctx) => {
    const auth = requireAuth(db, ctx);
    const vault = loadUserProviderVault(db, config, auth.userId);
    sendJson(ctx.res, 200, {
      subscriptions: vault.subscriptions.map(toRedactedSubscription),
    });
  });

  mountDual('post', '/subscriptions/sync', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      subscriptions?: unknown;
      auto_activate?: boolean;
    }>(ctx.req);

    if (!Array.isArray(body.subscriptions)) {
      throw new ApiError(400, 'invalid_subscriptions', 'subscriptions must be an array');
    }

    const vault = loadUserProviderVault(db, config, auth.userId);
    const now = Date.now();
    const synced: StoredVaultSubscription[] = [];

    for (const rawItem of body.subscriptions) {
      if (!isPlainObject(rawItem)) {
        throw new ApiError(400, 'invalid_subscription_item', 'Each subscription item must be an object');
      }
      const acctObj = isPlainObject(rawItem.account) ? rawItem.account : rawItem;
      const acctId =
        typeof acctObj.id === 'string' && acctObj.id.trim()
          ? acctObj.id.trim()
          : typeof rawItem.id === 'string' && rawItem.id.trim()
            ? rawItem.id.trim()
            : '';
      if (!acctId || acctId === 'local_hermes') {
        throw new ApiError(400, 'invalid_subscription_item', 'Subscription account.id is required');
      }

      const kind = typeof acctObj.kind === 'string' && acctObj.kind.trim() ? acctObj.kind.trim() : 'custom';
      const label =
        typeof acctObj.label === 'string' && acctObj.label.trim() ? acctObj.label.trim() : acctId;
      const rawProtocol =
        typeof acctObj.protocol === 'string' ? acctObj.protocol.trim().toLowerCase() : '';
      const apiMode: StoredVaultProvider['api_mode'] =
        rawProtocol === 'openai_responses' || rawProtocol === 'codex_responses'
          ? 'codex_responses'
          : rawProtocol === 'anthropic_messages'
            ? 'anthropic_messages'
            : rawProtocol === 'gemini_generate_content'
              ? 'gemini_generate_content'
              : 'chat_completions';

      const baseUrlRaw =
        typeof acctObj.base_url === 'string' && acctObj.base_url.trim()
          ? acctObj.base_url.trim()
          : 'https://api.openai.com/v1';
      const baseUrl = normalizeBaseUrl(baseUrlRaw);

      const defaultModel =
        typeof acctObj.default_model === 'string' && acctObj.default_model.trim()
          ? acctObj.default_model.trim()
          : 'gpt-4o';

      const accessToken =
        typeof rawItem.access_token === 'string' && rawItem.access_token.trim()
          ? rawItem.access_token.trim()
          : undefined;
      const rawHeaders = sanitizeHeadersRecord(rawItem.raw_headers);
      const availableModels = Array.isArray(rawItem.available_models)
        ? rawItem.available_models.filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
        : [];

      const sub: StoredVaultSubscription = {
        sub_id: acctId,
        provider_id: acctId,
        account: {
          id: acctId,
          kind,
          label,
          active: Boolean(acctObj.active),
          base_url: baseUrl,
          protocol: rawProtocol || apiMode,
          default_model: defaultModel,
          source_path: typeof acctObj.source_path === 'string' ? acctObj.source_path : undefined,
          plan: typeof acctObj.plan === 'string' ? acctObj.plan : undefined,
          account_id: typeof acctObj.account_id === 'string' ? acctObj.account_id : undefined,
          email: typeof acctObj.email === 'string' ? acctObj.email : undefined,
        },
        plan_name: typeof acctObj.plan === 'string' && acctObj.plan.trim() ? acctObj.plan.trim() : label,
        active: Boolean(acctObj.active),
        access_token: accessToken,
        raw_headers: rawHeaders,
        vertex_adc: rawItem.vertex_adc,
        codex_oauth: rawItem.codex_oauth,
        region_id: typeof rawItem.region_id === 'string' ? rawItem.region_id : undefined,
        available_models: availableModels,
        detected_at_ms: now,
      };
      synced.push(sub);

      // Upsert corresponding encrypted provider entry in user's vault
      const existingIdx = vault.providers.findIndex((p) => p.provider_id === acctId);
      const provEntry: StoredVaultProvider = {
        provider_id: acctId,
        preset_id: kind,
        name: label,
        api_mode: apiMode,
        base_url: baseUrl,
        default_model: defaultModel,
        enabled: true,
        no_key_required: false,
        api_key: accessToken ?? (existingIdx >= 0 ? vault.providers[existingIdx]!.api_key : undefined),
        custom_headers:
          Object.keys(rawHeaders).length > 0
            ? rawHeaders
            : existingIdx >= 0
              ? vault.providers[existingIdx]!.custom_headers
              : {},
        models: availableModels.length > 0 ? availableModels : [defaultModel],
        updated_at_ms: now,
      };
      if (existingIdx >= 0) vault.providers[existingIdx] = provEntry;
      else vault.providers.push(provEntry);
    }

    // Merge synced subscriptions into vault
    for (const sub of synced) {
      const idx = vault.subscriptions.findIndex(
        (existing) => existing.sub_id === sub.sub_id || existing.account.id === sub.account.id,
      );
      if (idx >= 0) vault.subscriptions[idx] = sub;
      else vault.subscriptions.push(sub);
    }

    const autoActivate = body.auto_activate !== false;
    if (autoActivate && synced.length > 0) {
      const target = synced[0]!;
      for (const s of vault.subscriptions) {
        s.active = s.sub_id === target.sub_id;
        s.account.active = s.active;
      }
      vault.active_provider = target.provider_id;
      vault.active_model = target.account.default_model || vault.active_model;
    }

    saveUserProviderVault(db, config, auth.userId, vault);
    const statePayload = buildStatePayload(vault);
    sendJson(ctx.res, 200, {
      ok: true,
      synced_count: synced.length,
      subscriptions: statePayload.subscriptions,
      scanned_at_ms: now,
      has_active_subscription: statePayload.has_active_subscription,
      has_configured_provider: statePayload.has_configured_provider,
      needs_provider_selection: statePayload.needs_provider_selection,
      state: statePayload,
    });
  });

  mountDual('post', '/subscriptions/scan', (ctx) => {
    const auth = requireAuth(db, ctx);
    // NEVER synthesize fake subscriptions from magpie_providers and NEVER read server OS credentials!
    const vault = loadUserProviderVault(db, config, auth.userId);
    sendJson(ctx.res, 200, {
      ok: true,
      subscriptions: vault.subscriptions.map(toRedactedSubscription),
      scanned_at_ms: Date.now(),
    });
  });

  mountDual('post', '/subscriptions/:subId/activate', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const subId = ctx.params.subId!;
    let body: { model?: string } = {};
    try {
      body = await readJsonBody<{ model?: string }>(ctx.req);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 400)) throw err;
    }

    const vault = loadUserProviderVault(db, config, auth.userId);
    const target = vault.subscriptions.find(
      (s) => s.sub_id === subId || s.account.id === subId,
    );
    if (!target) {
      throw new ApiError(404, 'subscription_not_found', `Subscription '${subId}' not found`);
    }

    for (const s of vault.subscriptions) {
      s.active = s.sub_id === target.sub_id;
      s.account.active = s.active;
    }
    vault.active_provider = target.provider_id;
    vault.active_model =
      (typeof body.model === 'string' && body.model.trim()) ||
      target.account.default_model ||
      vault.active_model;

    saveUserProviderVault(db, config, auth.userId, vault);
    sendJson(ctx.res, 200, {
      ok: true,
      active_provider: vault.active_provider,
      active_model: vault.active_model,
      subscription: toRedactedSubscription(target),
    });
  });

  // 6. Privacy Masking Config & Preview (both `/masking/preview` & `/mask-preview`)
  mountDual('get', '/masking', (ctx) => {
    const auth = requireAuth(db, ctx);
    sendJson(ctx.res, 200, loadUserProviderVault(db, config, auth.userId).masking);
  });

  const handleUpdateMasking = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const patch = await readJsonBody<Partial<MagpieMaskingConfig>>(ctx.req);
    const vault = loadUserProviderVault(db, config, auth.userId);
    vault.masking = normalizeVaultState({
      masking: { ...vault.masking, ...patch },
    }).masking;
    saveUserProviderVault(db, config, auth.userId, vault);
    sendJson(ctx.res, 200, vault.masking);
  };
  mountDual('put', '/masking', handleUpdateMasking);
  mountDual('post', '/masking', handleUpdateMasking);

  const handleMaskingPreview = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{ text?: unknown; config?: Partial<MagpieMaskingConfig> }>(ctx.req);
    if (body.text !== undefined && body.text !== null && typeof body.text !== 'string') {
      throw new ApiError(400, 'invalid_text', 'text must be a string');
    }
    const vault = loadUserProviderVault(db, config, auth.userId);
    const effectiveCfg: MagpieMaskingConfig = isPlainObject(body.config)
      ? normalizeVaultState({ masking: { ...vault.masking, ...body.config } }).masking
      : vault.masking;
    const res = runPrivacyMasking(typeof body.text === 'string' ? body.text : '', effectiveCfg);
    sendJson(ctx.res, 200, {
      masked_text: res.masked_text,
      masked: res.masked_text,
      hits: res.hits,
      hit_count: res.hit_count,
      blocked: res.blocked,
      block_reason: res.block_reason,
    });
  };
  mountDual('post', '/masking/preview', handleMaskingPreview);
  mountDual('post', '/mask-preview', handleMaskingPreview);

  // 7. `.env` / `magpie://` / `https://usemagpie.ai/import` / JSON Import (encrypted vault!)
  mountDual('post', '/import', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{ content?: string; raw?: string; uri?: string }>(ctx.req);
    const text = (
      typeof body.content === 'string'
        ? body.content
        : typeof body.raw === 'string'
          ? body.raw
          : typeof body.uri === 'string'
            ? body.uri
            : ''
    ).trim();
    if (!text) {
      throw new ApiError(400, 'empty_import', 'Import payload cannot be empty');
    }

    const imported: string[] = [];
    const saveImported = (spec: {
      providerId: string;
      presetId?: string;
      name?: string;
      apiMode?: string;
      baseUrl?: string;
      defaultModel?: string;
      rawKey?: string;
    }): void => {
      if (!spec.providerId || spec.providerId === 'local_hermes') return;
      const view = upsertUserMagpieProvider(
        db,
        config,
        auth.userId,
        {
          provider_id: spec.providerId,
          preset_id: spec.presetId,
          name: spec.name,
          api_mode: spec.apiMode,
          base_url: spec.baseUrl,
          default_model: spec.defaultModel,
          api_key: spec.rawKey,
          enabled: true,
        },
        spec.providerId,
        false,
      );
      imported.push(view.provider_id);
    };

    if (/^magpie:\/\//i.test(text) || /^https:\/\/usemagpie\.ai\/import/i.test(text)) {
      let parsedUri: URL;
      try {
        parsedUri = new URL(text);
      } catch {
        throw new ApiError(400, 'invalid_import_uri', 'Malformed import URI');
      }
      const sp = parsedUri.searchParams;
      const presetId =
        sp.get('preset') ??
        sp.get('preset_id') ??
        sp.get('provider') ??
        (parsedUri.protocol === 'magpie:' && parsedUri.hostname && parsedUri.hostname !== 'import'
          ? parsedUri.hostname
          : 'openai');
      const providerId = sp.get('provider_id') ?? presetId;
      saveImported({
        providerId,
        presetId,
        name: sp.get('name') ?? undefined,
        apiMode: sp.get('api_mode') ?? undefined,
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
        : isPlainObject(parsedJson) && Array.isArray(parsedJson.providers)
          ? parsedJson.providers
          : [parsedJson];
      for (const item of items) {
        if (!isPlainObject(item)) continue;
        const presetId =
          typeof item.preset_id === 'string'
            ? item.preset_id
            : typeof item.preset === 'string'
              ? item.preset
              : undefined;
        const providerId =
          typeof item.provider_id === 'string'
            ? item.provider_id
            : presetId ?? `prov_${crypto.randomBytes(4).toString('hex')}`;
        saveImported({
          providerId,
          presetId,
          name: typeof item.name === 'string' ? item.name : undefined,
          apiMode: typeof item.api_mode === 'string' ? item.api_mode : undefined,
          baseUrl: typeof item.base_url === 'string' ? item.base_url : undefined,
          defaultModel:
            typeof item.default_model === 'string'
              ? item.default_model
              : typeof item.model === 'string'
                ? item.model
                : undefined,
          rawKey: typeof item.api_key === 'string' ? item.api_key : undefined,
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

  // 8. Usage Ledger
  mountDual('get', '/usage', (ctx) => {
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

  // ============================================================================
  // 9. Authenticated Gateway Proxy (`/v1/*`, `/api/v1/magpie/v1/*`, `/api/v1/{fabushi,hermes}/magpie/v1/*`)
  // ============================================================================

  const mountGateway = (
    method: 'get' | 'post',
    suffix: string,
    handler: (ctx: RequestContext) => void | Promise<void>,
  ): void => {
    router[method](`/v1${suffix}`, handler);
    router[method](`/api/v1/magpie/v1${suffix}`, handler);
    router[method](`/api/v1/fabushi/magpie/v1${suffix}`, handler);
    router[method](`/api/v1/hermes/magpie/v1${suffix}`, handler);
  };

  // GET .../models (STRICTLY authenticated, returns ONLY user's enabled providers/subscriptions)
  const handleModels = (ctx: RequestContext): void => {
    const auth = requireAuth(db, ctx);
    const vault = loadUserProviderVault(db, config, auth.userId);
    const data: Array<{ id: string; object: 'model'; owned_by: string }> = [];
    const seen = new Set<string>();

    for (const prov of vault.providers) {
      if (prov.enabled === false) continue;
      const modelList =
        prov.models && prov.models.length > 0
          ? prov.models
          : prov.default_model
            ? [prov.default_model]
            : [];
      for (const m of modelList) {
        const key = `${prov.provider_id}:${m}`;
        if (!m || seen.has(key)) continue;
        seen.add(key);
        data.push({ id: m, object: 'model', owned_by: prov.provider_id });
      }
    }

    for (const sub of vault.subscriptions) {
      const modelList = [
        ...(sub.available_models ?? []),
        ...(sub.account.default_model ? [sub.account.default_model] : []),
      ];
      for (const m of modelList) {
        const key = `${sub.provider_id}:${m}`;
        if (!m || seen.has(key)) continue;
        seen.add(key);
        data.push({ id: m, object: 'model', owned_by: sub.provider_id });
      }
    }

    sendJson(ctx.res, 200, { object: 'list', data });
  };
  mountGateway('get', '/models', handleModels);

  const maskInputMessages = (
    rawMessages: LlmChatMessage[],
    maskingCfg: MagpieMaskingConfig,
  ): {
    maskedMessages: LlmChatMessage[];
    maskedHitsTotal: number;
    globalReverseMap: Map<string, string>;
  } => {
    let maskedHitsTotal = 0;
    const globalReverseMap = new Map<string, string>();
    const maskedMessages = rawMessages
      .filter((m): m is LlmChatMessage => isPlainObject(m))
      .map((m) => {
        if (typeof m.content !== 'string') return m;
        const masked = runPrivacyMasking(m.content, maskingCfg);
        if (masked.blocked) {
          throw new ApiError(400, 'privacy_blocked', masked.block_reason ?? 'Blocked by privacy policy');
        }
        maskedHitsTotal += masked.hit_count;
        for (const [k, v] of masked.reverseMap.entries()) {
          globalReverseMap.set(k, v);
        }
        return { ...m, content: masked.masked_text };
      });
    return { maskedMessages, maskedHitsTotal, globalReverseMap };
  };

  const recordUsageAndTrace = (
    userId: number,
    vault: UserProviderVaultState,
    target: ResolvedProviderTarget,
    res: LlmCompletionResult,
    maskedHitsTotal: number,
    latencyMs: number,
  ): void => {
    const promptTokens = res.usage?.prompt_tokens ?? 0;
    const completionTokens = res.usage?.completion_tokens ?? 0;
    const now = Date.now();
    db.prepare(`
      INSERT INTO magpie_usage_ledger (
        entry_id, user_id, provider_id, model, prompt_tokens, completion_tokens, masked_hits, latency_ms, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `use_${crypto.randomBytes(6).toString('hex')}`,
      userId,
      target.providerId,
      target.model,
      promptTokens,
      completionTokens,
      maskedHitsTotal,
      latencyMs,
      now,
    );

    vault.recent_route_traces.push({
      trace_id: `tr_${crypto.randomBytes(4).toString('hex')}`,
      provider_id: target.providerId,
      model: target.model,
      ok: true,
      latency_ms: latencyMs,
      status_code: 200,
      timestamp_ms: now,
    });
    if (vault.recent_route_traces.length > 50) {
      vault.recent_route_traces = vault.recent_route_traces.slice(-50);
    }
    saveUserProviderVault(db, config, userId, vault);
  };

  // POST .../chat/completions (STRICT auth, 503 when 0 providers configured BEFORE SSE!)
  const handleChatCompletions = async (ctx: RequestContext): Promise<void> => {
    const startMs = Date.now();
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      model?: unknown;
      messages?: unknown;
      stream?: unknown;
      provider_id?: unknown;
      tools?: unknown;
      temperature?: unknown;
      max_tokens?: unknown;
    }>(ctx.req);

    if (body.messages !== undefined) {
      if (!Array.isArray(body.messages) || body.messages.some((m) => !isPlainObject(m))) {
        throw new ApiError(400, 'invalid_messages', 'messages must be an array of message objects');
      }
    }
    if (body.tools !== undefined && body.tools !== null) {
      if (!Array.isArray(body.tools) || body.tools.some((t) => !isPlainObject(t))) {
        throw new ApiError(400, 'invalid_tools', 'tools must be an array of tool objects');
      }
    }

    const vault = loadUserProviderVault(db, config, auth.userId);
    const target = resolveUserProviderTarget(vault, config, {
      providerId: typeof body.provider_id === 'string' ? body.provider_id : undefined,
      model: typeof body.model === 'string' ? body.model : undefined,
    });

    // Resolve BEFORE starting SSE so 0-provider calls return honest HTTP 503 JSON!
    if (!target) {
      throw providerNotConfiguredError();
    }

    const rawMessages = Array.isArray(body.messages) ? (body.messages as LlmChatMessage[]) : [];
    const { maskedMessages, maskedHitsTotal, globalReverseMap } = maskInputMessages(
      rawMessages,
      vault.masking,
    );

    let result: LlmCompletionResult;
    try {
      result = await executeUpstreamCall(target, maskedMessages, {
        tools: Array.isArray(body.tools) ? (body.tools as Array<Record<string, unknown>>) : undefined,
        temperature:
          typeof body.temperature === 'number' && Number.isFinite(body.temperature)
            ? body.temperature
            : undefined,
        maxTokens:
          typeof body.max_tokens === 'number' && Number.isFinite(body.max_tokens)
            ? body.max_tokens
            : undefined,
      });
    } catch (err) {
      throw new ApiError(
        502,
        'upstream_unreachable',
        err instanceof Error ? err.message : `Upstream provider ${target.providerId} unreachable`,
      );
    }

    const assistantText = unmaskPlaceholders(result.text, globalReverseMap);
    const latencyMs = Math.max(0, Date.now() - startMs);
    recordUsageAndTrace(auth.userId, vault, target, result, maskedHitsTotal, latencyMs);

    const completionId = `chatcmpl_${crypto.randomBytes(8).toString('hex')}`;
    const promptTokens = result.usage?.prompt_tokens ?? 0;
    const completionTokens = result.usage?.completion_tokens ?? 0;
    const totalTokens = result.usage?.total_tokens ?? promptTokens + completionTokens;

    if (body.stream) {
      const sse = beginSseStream(ctx.res);
      try {
        if (assistantText.length > 0) {
          const half = Math.max(1, Math.floor(assistantText.length / 2));
          for (const piece of [assistantText.slice(0, half), assistantText.slice(half)]) {
            if (!piece) continue;
            sse.sendRawData(
              JSON.stringify({
                id: completionId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: target.model,
                choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
              }),
            );
          }
        }
        if (result.toolCalls && result.toolCalls.length > 0) {
          sse.sendRawData(
            JSON.stringify({
              id: completionId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: target.model,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: result.toolCalls.map((tc, index) => ({ ...tc, index })),
                  },
                  finish_reason: null,
                },
              ],
            }),
          );
        }
        sse.sendRawData(
          JSON.stringify({
            id: completionId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: target.model,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: result.toolCalls?.length ? 'tool_calls' : result.finishReason ?? 'stop',
              },
            ],
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: totalTokens,
            },
          }),
        );
        sse.sendRawData('[DONE]');
      } catch (err) {
        sse.sendRawData(
          JSON.stringify({
            error: {
              type: 'PROVIDER_ERROR',
              code: 'upstream_error',
              message: err instanceof Error ? err.message : 'Stream error',
            },
          }),
        );
      } finally {
        sse.end();
      }
      return;
    }

    sendJson(ctx.res, 200, {
      id: completionId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: target.model,
      provider: target.providerId,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: assistantText,
            ...(result.toolCalls?.length ? { tool_calls: result.toolCalls } : {}),
            ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
          },
          finish_reason: result.toolCalls?.length ? 'tool_calls' : result.finishReason ?? 'stop',
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
      },
    });
  };
  mountGateway('post', '/chat/completions', handleChatCompletions);

  // POST .../responses (OpenAI Responses API)
  const handleResponses = async (ctx: RequestContext): Promise<void> => {
    const startMs = Date.now();
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      model?: unknown;
      input?: unknown;
      instructions?: unknown;
      stream?: unknown;
      provider_id?: unknown;
      tools?: unknown;
    }>(ctx.req);

    if (body.tools !== undefined && body.tools !== null) {
      if (!Array.isArray(body.tools) || body.tools.some((t) => !isPlainObject(t))) {
        throw new ApiError(400, 'invalid_tools', 'tools must be an array of tool objects');
      }
    }

    const vault = loadUserProviderVault(db, config, auth.userId);
    const target = resolveUserProviderTarget(vault, config, {
      providerId: typeof body.provider_id === 'string' ? body.provider_id : undefined,
      model: typeof body.model === 'string' ? body.model : undefined,
    });
    if (!target) {
      throw providerNotConfiguredError();
    }

    const rawMessages: LlmChatMessage[] = [];
    if (typeof body.instructions === 'string' && body.instructions.trim()) {
      rawMessages.push({ role: 'system', content: body.instructions });
    }
    if (typeof body.input === 'string') {
      rawMessages.push({ role: 'user', content: body.input });
    } else if (Array.isArray(body.input)) {
      for (const item of body.input) {
        if (!isPlainObject(item)) {
          throw new ApiError(400, 'invalid_messages', 'input array items must be objects');
        }
        rawMessages.push({
          role: typeof item.role === 'string' ? item.role : 'user',
          content: typeof item.content === 'string' ? item.content : JSON.stringify(item.content ?? ''),
        });
      }
    }

    const { maskedMessages, maskedHitsTotal, globalReverseMap } = maskInputMessages(
      rawMessages,
      vault.masking,
    );

    let result: LlmCompletionResult;
    try {
      result = await executeUpstreamCall(target, maskedMessages, {
        tools: Array.isArray(body.tools) ? (body.tools as Array<Record<string, unknown>>) : undefined,
      });
    } catch (err) {
      throw new ApiError(
        502,
        'upstream_unreachable',
        err instanceof Error ? err.message : `Upstream provider ${target.providerId} unreachable`,
      );
    }

    const outputText = unmaskPlaceholders(result.text, globalReverseMap);
    const latencyMs = Math.max(0, Date.now() - startMs);
    recordUsageAndTrace(auth.userId, vault, target, result, maskedHitsTotal, latencyMs);

    const respId = `resp_${crypto.randomBytes(8).toString('hex')}`;
    const responsePayload = {
      id: respId,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'completed',
      model: target.model,
      output_text: outputText,
      output: [
        {
          id: `msg_${crypto.randomBytes(6).toString('hex')}`,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: outputText }],
        },
      ],
      usage: {
        input_tokens: result.usage?.prompt_tokens ?? 0,
        output_tokens: result.usage?.completion_tokens ?? 0,
        total_tokens: result.usage?.total_tokens ?? 0,
      },
    };

    if (body.stream) {
      const sse = beginSseStream(ctx.res);
      sse.sendEvent('response.output_text.delta', {
        type: 'response.output_text.delta',
        delta: outputText,
      });
      sse.sendEvent('response.completed', {
        type: 'response.completed',
        response: responsePayload,
      });
      sse.end();
      return;
    }

    sendJson(ctx.res, 200, responsePayload);
  };
  mountGateway('post', '/responses', handleResponses);

  // POST .../messages (Anthropic Messages API)
  const handleAnthropicMessages = async (ctx: RequestContext): Promise<void> => {
    const startMs = Date.now();
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      model?: unknown;
      system?: unknown;
      messages?: unknown;
      max_tokens?: unknown;
      stream?: unknown;
      provider_id?: unknown;
      tools?: unknown;
    }>(ctx.req);

    if (body.messages !== undefined) {
      if (!Array.isArray(body.messages) || body.messages.some((m) => !isPlainObject(m))) {
        throw new ApiError(400, 'invalid_messages', 'messages must be an array of message objects');
      }
    }
    if (body.tools !== undefined && body.tools !== null) {
      if (!Array.isArray(body.tools) || body.tools.some((t) => !isPlainObject(t))) {
        throw new ApiError(400, 'invalid_tools', 'tools must be an array of tool objects');
      }
    }

    const vault = loadUserProviderVault(db, config, auth.userId);
    const target = resolveUserProviderTarget(vault, config, {
      providerId: typeof body.provider_id === 'string' ? body.provider_id : undefined,
      model: typeof body.model === 'string' ? body.model : undefined,
    });
    if (!target) {
      throw providerNotConfiguredError();
    }

    const rawMessages: LlmChatMessage[] = [];
    if (typeof body.system === 'string' && body.system.trim()) {
      rawMessages.push({ role: 'system', content: body.system });
    }
    if (Array.isArray(body.messages)) {
      for (const m of body.messages) {
        if (isPlainObject(m)) {
          rawMessages.push({
            role: typeof m.role === 'string' ? m.role : 'user',
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
          });
        }
      }
    }

    const { maskedMessages, maskedHitsTotal, globalReverseMap } = maskInputMessages(
      rawMessages,
      vault.masking,
    );

    let result: LlmCompletionResult;
    try {
      result = await executeUpstreamCall(target, maskedMessages, {
        tools: Array.isArray(body.tools) ? (body.tools as Array<Record<string, unknown>>) : undefined,
        maxTokens:
          typeof body.max_tokens === 'number' && Number.isFinite(body.max_tokens)
            ? body.max_tokens
            : undefined,
      });
    } catch (err) {
      throw new ApiError(
        502,
        'upstream_unreachable',
        err instanceof Error ? err.message : `Upstream provider ${target.providerId} unreachable`,
      );
    }

    const outputText = unmaskPlaceholders(result.text, globalReverseMap);
    const latencyMs = Math.max(0, Date.now() - startMs);
    recordUsageAndTrace(auth.userId, vault, target, result, maskedHitsTotal, latencyMs);

    const msgId = `msg_${crypto.randomBytes(8).toString('hex')}`;
    const contentBlocks: Array<Record<string, unknown>> = [];
    if (outputText) {
      contentBlocks.push({ type: 'text', text: outputText });
    }
    if (result.toolCalls) {
      for (const tc of result.toolCalls) {
        contentBlocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: parseJsonObjectSafe(tc.function.arguments),
        });
      }
    }

    const anthropicPayload = {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model: target.model,
      content: contentBlocks,
      stop_reason: result.toolCalls?.length ? 'tool_use' : 'end_turn',
      usage: {
        input_tokens: result.usage?.prompt_tokens ?? 0,
        output_tokens: result.usage?.completion_tokens ?? 0,
      },
    };

    if (body.stream) {
      const sse = beginSseStream(ctx.res);
      sse.sendEvent('message_start', { type: 'message_start', message: anthropicPayload });
      sse.sendEvent('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: outputText },
      });
      sse.sendEvent('message_stop', { type: 'message_stop' });
      sse.end();
      return;
    }

    sendJson(ctx.res, 200, anthropicPayload);
  };
  mountGateway('post', '/messages', handleAnthropicMessages);
}
