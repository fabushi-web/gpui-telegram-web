import { test, expect } from '../helpers/fixtures';
import { API_PATHS, DOM } from '../helpers/selectors';
import {
  apiUrl,
  authHeaders,
  createRealConversationFixture,
  registerUserViaApi,
} from '../helpers/server';
import { readComposerText, selectChat } from '../helpers/ui';

test.describe('Tier 2 — A09: AI Gateway Auth 401, Zero-Provider 503, SSE Anti-DONE & Multi-Tenant Isolation', () => {
  test('A09-T2-01: Unauthenticated /v1/chat/completions, /api/v1/magpie/v1/* and /v1/models ALL return 401', async ({
    request,
  }) => {
    for (const getPath of [API_PATHS.openaiV1Models, API_PATHS.magpieV1Models]) {
      const res = await request.get(apiUrl(getPath), { failOnStatusCode: false });
      expect(res.status()).toBe(401);
    }

    for (const postPath of [
      API_PATHS.openaiV1ChatCompletions,
      API_PATHS.magpieV1ChatCompletions,
      API_PATHS.magpieV1Responses,
      API_PATHS.magpieV1Messages,
    ]) {
      const res = await request.post(apiUrl(postPath), {
        data: {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'unauthenticated probe' }],
        },
        failOnStatusCode: false,
      });
      expect(res.status()).toBe(401);
    }
  });

  test('A09-T2-02: Authenticated /api/v1/fabushi/turns and /api/v1/magpie/v1/chat/completions with 0 providers return 503 provider_not_configured (NO fake echo)', async ({
    request,
  }) => {
    const user = await registerUserViaApi(request);
    const headers = authHeaders(user.token);

    const turnRes = await request.post(apiUrl(API_PATHS.fabushiTurns), {
      headers,
      data: { prompt: 'Write a poem' },
      failOnStatusCode: false,
    });
    expect(turnRes.status()).toBe(503);
    const turnBody = (await turnRes.json()) as {
      error?: string;
      needs_provider_selection?: boolean;
    };
    expect(turnBody.error).toBe('provider_not_configured');
    expect(turnBody.needs_provider_selection).toBe(true);

    const gwRes = await request.post(apiUrl(API_PATHS.magpieV1ChatCompletions), {
      headers,
      data: {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Hello gateway' }],
      },
      failOnStatusCode: false,
    });
    expect(gwRes.status()).toBe(503);
    const gwText = await gwRes.text();
    expect(gwText).not.toContain('[Magpie');
  });

  test('A09-T2-03: SSE gateway/turn error stream NEVER emits data: [DONE] and NEVER fabricates memory_lookup tool events', async ({
    request,
  }) => {
    const user = await registerUserViaApi(request);
    const headers = authHeaders(user.token);

    const streamRes = await request.post(apiUrl(API_PATHS.magpieV1ChatCompletions), {
      headers,
      data: {
        model: 'gpt-4o-mini',
        stream: true,
        messages: [{ role: 'user', content: 'Trigger zero-provider stream error' }],
      },
      failOnStatusCode: false,
    });
    expect([502, 503]).toContain(streamRes.status());
    const rawBody = await streamRes.text();
    expect(rawBody).not.toContain('data: [DONE]');
    expect(rawBody).not.toContain('memory_lookup');
  });

  test('A09-T2-04: User B cannot read, probe, update, or delete User A encrypted provider (403/404 isolation)', async ({
    request,
  }) => {
    const userA = await registerUserViaApi(request);
    const userB = await registerUserViaApi(request);
    const requestedProviderId = `e2e_priv_a_${Date.now().toString(36)}`;

    const createRes = await request.post(apiUrl(API_PATHS.magpieProviders), {
      headers: authHeaders(userA.token),
      data: {
        provider_id: requestedProviderId,
        name: 'Private Provider A',
        kind: 'openai',
        api_mode: 'chat_completions',
        base_url: 'https://api.openai.com/v1',
        api_key: 'sk-private-a-999111222',
        default_model: 'gpt-4o-mini',
        enabled: true,
        activate: true,
      },
    });
    expect([200, 201]).toContain(createRes.status());
    const created = (await createRes.json()) as {
      id?: unknown;
      provider_id?: unknown;
      provider?: { id?: unknown; provider_id?: unknown };
    };
    const providerId =
      created.id ?? created.provider_id ?? created.provider?.id ?? created.provider?.provider_id;
    expect(typeof providerId).toBe('string');
    expect((providerId as string).length).toBeGreaterThan(0);

    const providerUrl = apiUrl(`${API_PATHS.magpieProviders}/${providerId as string}`);

    // Prove route liveness: User A can update their own provider (200)
    const patchA = await request.patch(providerUrl, {
      headers: authHeaders(userA.token),
      data: { name: 'Private Provider A Updated' },
    });
    expect(patchA.status()).toBe(200);

    // User B cannot read, probe, update, or delete User A's provider
    const readB = await request.get(providerUrl, {
      headers: authHeaders(userB.token),
      failOnStatusCode: false,
    });
    expect([403, 404]).toContain(readB.status());

    const patchB = await request.patch(providerUrl, {
      headers: authHeaders(userB.token),
      data: { name: 'Hijacked Provider' },
      failOnStatusCode: false,
    });
    expect([403, 404]).toContain(patchB.status());

    const probeB = await request.post(`${providerUrl}/probe`, {
      headers: authHeaders(userB.token),
      failOnStatusCode: false,
    });
    expect([403, 404]).toContain(probeB.status());

    const deleteB = await request.delete(providerUrl, {
      headers: authHeaders(userB.token),
      failOnStatusCode: false,
    });
    expect([403, 404]).toContain(deleteB.status());

    // User A's provider still exists intact
    const stateA = await request.get(apiUrl(API_PATHS.magpieState), {
      headers: authHeaders(userA.token),
    });
    expect(stateA.status()).toBe(200);
    expect(await stateA.text()).toContain('Private Provider A Updated');
  });

  test('A09-T2-05: POST /api/v1/fabushi/magpie/providers/:id/probe with unreachable endpoint returns ok: false with real error (never fabricated reachable: true)', async ({
    request,
  }) => {
    const user = await registerUserViaApi(request);
    const headers = authHeaders(user.token);

    const createRes = await request.post(apiUrl(API_PATHS.magpieProviders), {
      headers,
      data: {
        provider_id: `e2e_unreachable_${Date.now().toString(36)}`,
        name: 'Unreachable Probe Provider',
        kind: 'openai',
        api_mode: 'chat_completions',
        base_url: 'http://127.0.0.1:1/v1',
        api_key: 'sk-invalid-probe-key',
        default_model: 'gpt-4o-mini',
        enabled: true,
        activate: false,
      },
    });
    expect([200, 201]).toContain(createRes.status());
    const created = (await createRes.json()) as {
      id?: unknown;
      provider_id?: unknown;
      provider?: { id?: unknown; provider_id?: unknown };
    };
    const providerId =
      created.id ?? created.provider_id ?? created.provider?.id ?? created.provider?.provider_id;
    expect(typeof providerId).toBe('string');
    expect((providerId as string).length).toBeGreaterThan(0);

    const probeRes = await request.post(
      apiUrl(`${API_PATHS.magpieProviders}/${providerId as string}/probe`),
      { headers, failOnStatusCode: false },
    );
    const probeStatus = probeRes.status();
    const probeBody = (await probeRes.json()) as {
      ok?: unknown;
      reachable?: unknown;
      error?: unknown;
      message?: unknown;
    };
    if (probeStatus === 200) {
      const reachFlag = probeBody.ok ?? probeBody.reachable;
      expect(typeof reachFlag).toBe('boolean');
      expect(reachFlag).toBe(false);
    } else {
      expect([502, 503]).toContain(probeStatus);
      expect(probeBody.ok).not.toBe(true);
      expect(probeBody.reachable).not.toBe(true);
    }
    const errText = probeBody.error ?? probeBody.message;
    expect(typeof errText).toBe('string');
    expect((errText as string).trim().length).toBeGreaterThan(0);
  });

  test('A09-T2-06: Composer #btn-ai-compose with 0 configured providers returns truthful error toast (NO fake "[formal] ..." client rewrite fallback)', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.dmTitle);

    const composer = page.locator(DOM.messageComposerInput);
    const originalDraft = 'Meet at 3pm to finalize release';
    await composer.fill(originalDraft);

    const aiBtn = page.locator(DOM.btnAiCompose);
    await expect(aiBtn).toBeVisible();
    await aiBtn.click();

    const menuChoice = page
      .locator('[role="menu"] button, [role="menuitem"]')
      .first();
    await expect(menuChoice).toBeVisible({ timeout: 5_000 });

    const [aiRes] = await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes('/ai-compose') ||
          res.url().includes('/fabushi/') ||
          res.url().includes('/magpie/'),
        { timeout: 8_000 },
      ),
      menuChoice.click(),
    ]);
    expect([502, 503]).toContain(aiRes.status());

    const errorToast = page
      .locator(`${DOM.windowToastBanner}, ${DOM.stageToastPill}, [role="alert"]`)
      .first();
    await expect(errorToast).toBeVisible({ timeout: 5_000 });
    await expect(errorToast).toContainText(
      /provider|configured|unavailable|failed|error|模型|供应商|未配置|失败/i,
    );

    const textAfter = await readComposerText(composer);
    // MUST NOT replace composer text with fabricated fake client-side "[formal]" prefix
    expect(textAfter).not.toMatch(/^\[(formal|friendly|concise|rewrite)\]/i);
    expect(textAfter).toBe(originalDraft);
  });
});
