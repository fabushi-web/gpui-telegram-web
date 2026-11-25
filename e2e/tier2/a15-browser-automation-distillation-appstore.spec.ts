import { test, expect } from '../helpers/fixtures';
import { API_PATHS, DOM } from '../helpers/selectors';
import {
  apiUrl,
  authHeaders,
  registerUserViaApi,
} from '../helpers/server';
import { buildValidAutomationAppManifest } from '../helpers/api';
import { openNavDestination } from '../helpers/ui';

test.describe('Tier 2 — A15: Automation App Store 422 Secret Leak Scanner, ID/Size/RBAC Guards & Browser Anti-Fudging', () => {
  test('A15-T2-01: POST /api/v1/automation-apps containing hardcoded Bearer token, sk-... API key, password, or secret in unknown field / changelog returns 422 secret_leak_detected', async ({
    request,
  }) => {
    const author = await registerUserViaApi(request);
    const headers = authHeaders(author.token);

    const leakPayloads = [
      // 1. OpenAI-style secret key inside step value_template
      {
        manifest: buildValidAutomationAppManifest({
          steps: [
            {
              kind: 'fill',
              locator: { css_selector: 'input[name="token"]' },
              value_template: 'sk-proj-1234567890abcdef1234567890abcdef',
            },
          ],
        }),
        changelog: 'clean changelog',
      },
      // 2. Bearer token hidden inside changelog
      {
        manifest: buildValidAutomationAppManifest(),
        changelog:
          'Tested with Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      },
      // 3. Hardcoded secret hidden inside unknown extra manifest field
      {
        manifest: buildValidAutomationAppManifest({
          custom_debug_meta: { api_key: 'ghp_1234567890abcdef1234567890abcdef1234' },
        }),
        changelog: 'normal update',
      },
      // 4. Hardcoded password literal inside custom config field
      {
        manifest: buildValidAutomationAppManifest({
          custom_config: { password: 'HardcodedProdPassword!99' },
        }),
        changelog: 'config update',
      },
    ];

    for (const payload of leakPayloads) {
      const res = await request.post(apiUrl(API_PATHS.automationApps), {
        headers,
        data: { ...payload, is_published: true },
        failOnStatusCode: false,
      });
      expect(res.status()).toBe(422);
      const body = (await res.json()) as { error?: unknown };
      expect(body.error).toBe('secret_leak_detected');
    }
  });

  test('A15-T2-02: Reserved app_id="installed" or invalid chars rejected 400 invalid_app_id; >200 steps rejected 400', async ({
    request,
  }) => {
    const author = await registerUserViaApi(request);
    const headers = authHeaders(author.token);

    for (const badId of ['installed', '../escape', 'bad id with spaces']) {
      const res = await request.post(apiUrl(API_PATHS.automationApps), {
        headers,
        data: {
          manifest: buildValidAutomationAppManifest({ app_id: badId, slug: badId }),
          is_published: true,
        },
        failOnStatusCode: false,
      });
      expect(res.status()).toBe(400);
      const body = (await res.json()) as { error?: unknown };
      expect(body.error).toBe('invalid_app_id');
    }

    const tooManySteps = Array.from({ length: 205 }, (_, i) => ({
      kind: 'click',
      locator: { test_id: `step-${i}` },
    }));
    const stepsRes = await request.post(apiUrl(API_PATHS.automationApps), {
      headers,
      data: {
        manifest: buildValidAutomationAppManifest({ steps: tooManySteps }),
        is_published: true,
      },
      failOnStatusCode: false,
    });
    expect(stepsRes.status()).toBe(400);
  });

  test('A15-T2-03: Unpublished automation app returns 404 not_found to non-author; author spoofing or non-owner update returns 403 forbidden', async ({
    request,
  }) => {
    const author = await registerUserViaApi(request);
    const otherUser = await registerUserViaApi(request);

    const draftManifest = buildValidAutomationAppManifest();
    const draftRes = await request.post(apiUrl(API_PATHS.automationApps), {
      headers: authHeaders(author.token),
      data: { manifest: draftManifest, is_published: false },
    });
    expect(draftRes.status()).toBe(201);

    // Non-author fetching or installing unpublished draft MUST get 404
    const nonAuthorGet = await request.get(
      apiUrl(`${API_PATHS.automationApps}/${draftManifest.app_id}`),
      { headers: authHeaders(otherUser.token), failOnStatusCode: false },
    );
    expect(nonAuthorGet.status()).toBe(404);

    const nonAuthorInstall = await request.post(
      apiUrl(`${API_PATHS.automationApps}/${draftManifest.app_id}/install`),
      { headers: authHeaders(otherUser.token), failOnStatusCode: false },
    );
    expect(nonAuthorInstall.status()).toBe(404);

    // Author spoofing via forged author_id field MUST return 403
    const spoofAuthor = await request.post(apiUrl(API_PATHS.automationApps), {
      headers: authHeaders(otherUser.token),
      data: {
        manifest: buildValidAutomationAppManifest({ author_id: String(author.userId) }),
        is_published: true,
      },
      failOnStatusCode: false,
    });
    expect(spoofAuthor.status()).toBe(403);

    // Non-owner attempting to publish a new version of author's app MUST get 403
    const hijackVersion = await request.post(apiUrl(API_PATHS.automationApps), {
      headers: authHeaders(otherUser.token),
      data: {
        manifest: { ...draftManifest, version: '1.0.1' },
        is_published: true,
      },
      failOnStatusCode: false,
    });
    expect(hijackVersion.status()).toBe(403);
  });

  test('A15-T2-04: Publishing duplicate (app_id, version) returns 409 version_conflict; recording run for unknown version returns 400 validation_error', async ({
    request,
  }) => {
    const author = await registerUserViaApi(request);
    const headers = authHeaders(author.token);
    const manifest = buildValidAutomationAppManifest({ version: '1.0.0' });

    const pub1 = await request.post(apiUrl(API_PATHS.automationApps), {
      headers,
      data: { manifest, is_published: true },
    });
    expect(pub1.status()).toBe(201);

    const pubDup = await request.post(apiUrl(API_PATHS.automationApps), {
      headers,
      data: { manifest, is_published: true },
      failOnStatusCode: false,
    });
    expect(pubDup.status()).toBe(409);
    expect(((await pubDup.json()) as { error?: string }).error).toBe('version_conflict');

    const badRunVersion = await request.post(
      apiUrl(`${API_PATHS.automationApps}/${manifest.app_id}/runs`),
      {
        headers,
        data: {
          version: '9.9.9-nonexistent',
          success: true,
          steps_executed: 1,
          total_duration_ms: 50,
          used_llm: false,
        },
        failOnStatusCode: false,
      },
    );
    expect(badRunVersion.status()).toBe(400);
    expect(((await badRunVersion.json()) as { error?: string }).error).toBe('validation_error');
  });

  test('A15-T2-05: Revoked desktop pairing token immediately rejected on /api/v1/browser/command & UI revoke latency is un-clamped (>= 15ms when delayed)', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const headers = authHeaders(user.token);

    const createPairRes = await request.post(apiUrl(API_PATHS.browserPairCreate), {
      headers,
      data: { label: 'Revoke Test Ext' },
    });
    expect([200, 201]).toContain(createPairRes.status());
    const createPair = (await createPairRes.json()) as { pairing_code?: unknown; code?: unknown };
    const code = createPair.pairing_code ?? createPair.code;
    expect(typeof code).toBe('string');
    expect((code as string).length).toBeGreaterThan(0);

    const claimRes = await request.post(apiUrl(API_PATHS.browserPairClaim), {
      headers,
      data: { pairing_code: code, code, device_name: 'Ext' },
    });
    expect(claimRes.status()).toBe(200);
    const claim = (await claimRes.json()) as { control_token?: unknown; token?: unknown };
    const controlToken = claim.control_token ?? claim.token;
    expect(typeof controlToken).toBe('string');
    expect((controlToken as string).length).toBeGreaterThan(0);

    let revokeIntercepted = false;
    await page.route('**/api/v1/browser/**revoke*', async (route) => {
      revokeIntercepted = true;
      await new Promise((r) => setTimeout(r, 40));
      await route.continue();
    });

    await openNavDestination(page, 'browser');
    const revokeBtn = page.locator(DOM.btnBrowserRevokeControl);
    await expect(revokeBtn).toBeVisible();

    const t0 = Date.now();
    const [revokeRes] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes('/api/v1/browser') && res.url().includes('revoke'),
        { timeout: 8_000 },
      ),
      revokeBtn.click(),
    ]);
    const elapsedMs = Date.now() - t0;
    expect(revokeIntercepted).toBe(true);
    expect(revokeRes.status()).toBe(200);
    expect(elapsedMs).toBeGreaterThanOrEqual(30);

    let msMatch: RegExpMatchArray | null = null;
    await expect
      .poll(
        async () => {
          const texts = await page
            .locator(
              `${DOM.browserWorkspaceAny}, ${DOM.windowToastBanner}, ${DOM.stageToastPill}`,
            )
            .allInnerTexts();
          msMatch = texts.join('\n').match(/(\d+(?:\.\d+)?)\s*ms/i);
          return msMatch !== null;
        },
        {
          timeout: 5_000,
          message:
            'Expected un-clamped browser revoke ms latency readout in workspace or toast banner',
        },
      )
      .toBe(true);

    expect(msMatch).not.toBeNull();
    const displayedMs = Number(msMatch![1]);
    expect(displayedMs).toBeGreaterThanOrEqual(15);
    expect(displayedMs).not.toBe(9.9);

    // Revoked token MUST fail closed on /api/v1/browser/command
    const cmdAfterRevoke = await request.post(apiUrl(API_PATHS.browserCommand), {
      headers: { Authorization: `Bearer ${controlToken as string}` },
      data: { action: 'snapshot' },
      failOnStatusCode: false,
    });
    expect([401, 403, 409]).toContain(cmdAfterRevoke.status());
  });

  test('A15-T2-06: Unconnected #browser-workspace reports truthful 0 targets (NOT inflated 1) and clean URL input (NO pre-filled test HTML)', async ({
    authSession,
  }) => {
    const { page } = authSession;
    const ws = await openNavDestination(page, 'browser');
    const wsText = await ws.innerText();
    expect(wsText).not.toMatch(/Connected\s*Targets:\s*[1-9]/i);

    const urlInput = page.locator(DOM.browserHeadlessUrlInput);
    await expect(urlInput).toBeVisible();
    const val = await urlInput.inputValue();
    expect(val).not.toContain('data:text/html');
    expect(val).not.toContain('Hello Desktop');
  });
});
