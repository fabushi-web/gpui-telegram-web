import { test, expect } from '../helpers/fixtures';
import { API_PATHS, DOM } from '../helpers/selectors';
import {
  apiUrl,
  authHeaders,
  registerUserViaApi,
} from '../helpers/server';
import {
  BILINGUAL_PATTERNS,
  openNavDestination,
  scopedButton,
} from '../helpers/ui';

test.describe('Tier 1 — A09: Per-User AI Provider Isolation, Magpie v1.6 & Live models.dev Catalog', () => {
  test('A09-T1-01: Fresh user truthful zero-provider Magpie state (has_configured_provider: false, needs_provider_selection: true, allow_local_fallback: false, user_scoped: true)', async ({
    request,
  }) => {
    const user = await registerUserViaApi(request);
    const res = await request.get(apiUrl(API_PATHS.magpieState), {
      headers: authHeaders(user.token),
    });
    expect(res.status()).toBe(200);
    const state = (await res.json()) as {
      has_configured_provider?: boolean;
      needs_provider_selection?: boolean;
      allow_local_fallback?: boolean;
      user_scoped?: boolean;
      providers?: unknown[];
    };
    expect(state.has_configured_provider).toBe(false);
    expect(state.needs_provider_selection).toBe(true);
    expect(state.allow_local_fallback).toBe(false);
    expect(state.user_scoped).toBe(true);
    expect(Array.isArray(state.providers)).toBe(true);
    expect(state.providers).toHaveLength(0);
  });

  test('A09-T1-02: Per-user ChaCha20-Poly1305 provider creation, secret header redaction on read, and strict isolation from User B', async ({
    request,
  }) => {
    const userA = await registerUserViaApi(request, { firstName: 'Provider Owner' });
    const userB = await registerUserViaApi(request, { firstName: 'Other Tenant' });

    const secretApiKey = 'sk-e2e-isolated-secret-key-99887766';
    const createRes = await request.post(apiUrl(API_PATHS.magpieProviders), {
      headers: authHeaders(userA.token),
      data: {
        provider_id: 'e2e_user_a_openai',
        name: 'User A Custom OpenAI',
        kind: 'openai',
        api_mode: 'chat_completions',
        base_url: 'https://api.openai.com/v1',
        api_key: secretApiKey,
        default_model: 'gpt-4o-mini',
        enabled: true,
        activate: true,
      },
    });
    expect([200, 201]).toContain(createRes.status());

    // User A sees the provider, but plaintext API key is strictly redacted on read
    const stateARes = await request.get(apiUrl(API_PATHS.magpieState), {
      headers: authHeaders(userA.token),
    });
    expect(stateARes.status()).toBe(200);
    const stateAText = await stateARes.text();
    const stateA = JSON.parse(stateAText) as {
      has_configured_provider?: boolean;
      providers?: Array<{ name?: string }>;
    };
    expect(stateA.has_configured_provider).toBe(true);
    expect(Array.isArray(stateA.providers)).toBe(true);
    expect(stateA.providers!.length).toBeGreaterThanOrEqual(1);
    expect(stateAText).not.toContain(secretApiKey);

    // User B MUST see zero providers belonging to User A
    const stateBRes = await request.get(apiUrl(API_PATHS.magpieState), {
      headers: authHeaders(userB.token),
    });
    expect(stateBRes.status()).toBe(200);
    const stateB = (await stateBRes.json()) as {
      has_configured_provider?: boolean;
      providers?: unknown[];
    };
    expect(stateB.has_configured_provider).toBe(false);
    expect(Array.isArray(stateB.providers)).toBe(true);
    expect(stateB.providers).toHaveLength(0);
  });

  test('A09-T1-03: Per-user subscription sync (POST /api/v1/fabushi/magpie/subscriptions/sync) & activation scoped strictly to authenticated caller', async ({
    request,
  }) => {
    const userA = await registerUserViaApi(request);
    const userB = await registerUserViaApi(request);

    const syncRes = await request.post(apiUrl(API_PATHS.magpieSubscriptionsSync), {
      headers: authHeaders(userA.token),
      data: {
        auto_activate: true,
        subscriptions: [
          {
            account: {
              id: 'sub_e2e_primary',
              kind: 'codex_chatgpt',
              label: 'User A Subscription',
              active: true,
              base_url: 'https://api.openai.com/v1',
              protocol: 'openai_responses',
              default_model: 'gpt-4o-mini',
              source_path: 'e2e',
            },
            access_token: 'sk-sub-user-a-0011223344',
          },
        ],
      },
    });
    expect(syncRes.status()).toBe(200);
    const syncBody = (await syncRes.json()) as {
      ok?: boolean;
      synced_count?: number;
      has_active_subscription?: boolean;
    };
    expect(syncBody.ok).toBe(true);
    expect(syncBody.synced_count).toBeGreaterThanOrEqual(1);
    expect(syncBody.has_active_subscription).toBe(true);

    // User B remains isolated with zero synced subscriptions
    const stateBRes = await request.get(apiUrl(API_PATHS.magpieState), {
      headers: authHeaders(userB.token),
    });
    expect(stateBRes.status()).toBe(200);
    const stateB = (await stateBRes.json()) as {
      has_configured_provider?: boolean;
      subscriptions?: unknown;
    };
    expect(stateB.has_configured_provider).toBe(false);
    expect(Array.isArray(stateB.subscriptions)).toBe(true);
    expect(stateB.subscriptions as unknown[]).toHaveLength(0);
  });

  test('A09-T1-04: Live models.dev catalog endpoint (GET /api/v1/fabushi/magpie/models/catalog) and #magpie-gateway-panel catalog selector UI', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const catRes = await request.get(
      `${apiUrl(API_PATHS.magpieModelsCatalog)}?refresh=false`,
      {
        headers: authHeaders(user.token),
        failOnStatusCode: false,
      },
    );
    // Accept either live 200 catalog from models.dev OR truthful 502 offline error (never fabricated fake provider)
    const catStatus = catRes.status();
    const catBody = (await catRes.json()) as Record<string, unknown>;
    if (catStatus === 200) {
      expect(catBody.source).toBe('models.dev');
      expect(typeof catBody.fetched_at_ms).toBe('number');
      expect(typeof catBody.providers).toBe('object');
      expect(catBody.providers).not.toBeNull();
      expect(Object.keys(catBody.providers as Record<string, unknown>).length).toBeGreaterThan(0);
    } else {
      expect(catStatus).toBe(502);
      expect(typeof catBody.error).toBe('string');
      expect(catBody.error as string).toMatch(/models_catalog|fetch|network|upstream/i);
    }

    await openNavDestination(page, 'hermes');
    const magpieTab = page
      .locator(DOM.hermesStudioPanel)
      .locator('[data-hermes-tab*="magpie" i], [data-hermes-tab*="provider" i]')
      .or(scopedButton(page.locator(DOM.hermesStudioPanel), /magpie|providers|模型网关|供应商/i))
      .first();
    await expect(magpieTab).toBeVisible();
    await magpieTab.click();
    await expect(page.locator(DOM.magpieGatewayPanel)).toBeVisible();
  });

  test('A09-T1-05: Magpie routing groups & server-backed PII privacy masking preview', async ({
    request,
  }) => {
    const user = await registerUserViaApi(request);
    const headers = authHeaders(user.token);

    const groupRes = await request.post(apiUrl(API_PATHS.magpieGroups), {
      headers,
      data: {
        name: 'Primary Code Routing',
        strategy: 'priority',
        models: ['gpt-4o-mini'],
      },
    });
    expect([200, 201]).toContain(groupRes.status());

    const listGroupsRes = await request.get(apiUrl(API_PATHS.magpieGroups), { headers });
    expect(listGroupsRes.status()).toBe(200);
    expect(await listGroupsRes.text()).toContain('Primary Code Routing');

    const rawPii =
      'Contact security@example.org or +1-415-555-0199 with key sk-live-secret1234567890abcd';
    const maskRes = await request.post(apiUrl(API_PATHS.magpieMaskingPreview), {
      headers,
      data: { text: rawPii },
    });
    expect(maskRes.status()).toBe(200);
    const maskBody = (await maskRes.json()) as {
      masked_text?: unknown;
      masked?: unknown;
    };
    const maskedOut = maskBody.masked_text ?? maskBody.masked;
    expect(typeof maskedOut).toBe('string');
    expect((maskedOut as string).length).toBeGreaterThan(0);
    expect(maskedOut as string).not.toContain('security@example.org');
    expect(maskedOut as string).not.toContain('sk-live-secret1234567890abcd');
  });

  test('A09-T1-06: Truthful 503 provider_not_configured inline PROVIDER_ERROR card with working "Configure AI Provider" CTA opening #magpie-gateway-panel', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;

    // Direct API proof: 0 configured providers -> truthful 503 provider_not_configured
    const turnRes = await request.post(apiUrl(API_PATHS.fabushiTurns), {
      headers: authHeaders(user.token),
      data: { prompt: 'Summarize today tasks' },
      failOnStatusCode: false,
    });
    expect(turnRes.status()).toBe(503);
    const turnBody = (await turnRes.json()) as {
      error?: string;
      needs_provider_selection?: boolean;
      action?: string;
    };
    expect(turnBody.error).toBe('provider_not_configured');
    expect(turnBody.needs_provider_selection).toBe(true);
    expect(turnBody.action).toBe('hermes:open_ai_providers');

    // UI proof: Hermes Studio surfaces PROVIDER_ERROR card & actionable CTA opening #magpie-gateway-panel
    const hermesPanel = await openNavDestination(page, 'hermes');
    const promptInput = hermesPanel.locator('textarea, input[type="text"]').first();
    await expect(promptInput).toBeVisible();
    await promptInput.fill('Summarize today tasks');
    await promptInput.press('Enter');

    await expect(hermesPanel).toContainText(
      /provider_not_configured|PROVIDER_ERROR|no\s*ai\s*provider|未配置.*模型|未配置.*供应商/i,
      { timeout: 8_000 },
    );
    await expect(hermesPanel).not.toContainText('[Magpie');

    const ctaBtn = scopedButton(
      hermesPanel,
      BILINGUAL_PATTERNS.configureAiProvider,
    ).first();
    await expect(ctaBtn).toBeVisible();
    await ctaBtn.click();
    await expect(page.locator(DOM.magpieGatewayPanel)).toBeVisible();
  });
});
