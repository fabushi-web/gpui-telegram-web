import { test, expect } from '../helpers/fixtures';
import {
  API_PATHS,
  AUTOMATION_APP_STORE_PANEL,
  BROWSER_INSPECTOR_TABS,
  DOM,
} from '../helpers/selectors';
import {
  apiUrl,
  authHeaders,
  registerUserViaApi,
} from '../helpers/server';
import {
  buildSampleBrowserActionTrace,
  buildValidAutomationAppManifest,
} from '../helpers/api';
import {
  bilingualRegex,
  openNavDestination,
  scopedTab,
} from '../helpers/ui';

test.describe('Tier 4 — SC-06: Built-in Interactive Browser, Script Distillation, Secret Leak Gate & Automation App Store', () => {
  test('SC-06: Open #browser-workspace (4 inspector tabs, 0 targets) -> desktop pairing -> distill BrowserActionTrace -> 422 secret_leak_detected -> clean publish (201 + 64-hex SHA256) -> User B discovers in #automation-app-store-panel, installs, records zero-LLM run & revokes pairing', async ({
    authSession,
    request,
  }) => {
    const { page, user: author } = authSession;
    const installer = await registerUserViaApi(request, { firstName: 'App Store User' });
    const authorHeaders = authHeaders(author.token);
    const installerHeaders = authHeaders(installer.token);

    // 1. Open v1.6.11 #browser-workspace & verify 4 inspector tabs + truthful 0 targets
    const workspace = await openNavDestination(page, 'browser');
    await expect(workspace).toBeVisible();
    const inspectorTabs = page.locator(BROWSER_INSPECTOR_TABS);
    await expect(inspectorTabs).toBeVisible();
    expect(await inspectorTabs.locator('[role="tab"], button').count()).toBeGreaterThanOrEqual(4);
    expect(await workspace.innerText()).not.toMatch(/Connected\s*Targets:\s*[1-9]/i);

    // 2. Desktop pairing create + claim (assert non-empty control_token!)
    const pairCreateRes = await request.post(apiUrl(API_PATHS.browserPairCreate), {
      headers: authorHeaders,
      data: { label: 'SC06 Desktop Chrome' },
    });
    expect([200, 201]).toContain(pairCreateRes.status());
    const pairCreate = (await pairCreateRes.json()) as {
      pairing_code?: unknown;
      code?: unknown;
    };
    const code = pairCreate.pairing_code ?? pairCreate.code;
    expect(typeof code).toBe('string');
    expect((code as string).length).toBeGreaterThanOrEqual(4);

    const pairClaim = await request.post(apiUrl(API_PATHS.browserPairClaim), {
      headers: authorHeaders,
      data: { pairing_code: code, code, device_name: 'SC06 Desktop Chrome' },
    });
    expect(pairClaim.status()).toBe(200);
    const claimBody = (await pairClaim.json()) as {
      control_token?: unknown;
      token?: unknown;
    };
    const controlToken = claimBody.control_token ?? claimBody.token;
    expect(typeof controlToken).toBe('string');
    expect((controlToken as string).length).toBeGreaterThan(0);

    // 3. Verify publishing a leaky manifest containing hardcoded API key fails 422 secret_leak_detected
    const leakyManifest = buildValidAutomationAppManifest({
      steps: [
        {
          kind: 'fill',
          locator: { css_selector: 'input[name="api_key"]' },
          value_template: 'sk-proj-leaktest9876543210abcdef9876543210',
        },
      ],
    });
    const leakRes = await request.post(apiUrl(API_PATHS.automationApps), {
      headers: authorHeaders,
      data: { manifest: leakyManifest, is_published: true },
      failOnStatusCode: false,
    });
    expect(leakRes.status()).toBe(422);
    expect(((await leakRes.json()) as { error: string }).error).toBe('secret_leak_detected');

    // 4. Distill recorded BrowserActionTrace -> vault-referenced clean AutomationScriptApp -> publish 201
    const distillRes = await request.post(apiUrl(API_PATHS.browserScriptsDistill), {
      headers: authorHeaders,
      data: {
        trace: buildSampleBrowserActionTrace(),
        metadata: {
          name: 'SC06 Deterministic Invoice Exporter',
          description: 'Zero-LLM compiled replay workflow',
          category: 'finance',
          target_domains: ['example.com'],
        },
      },
    });
    expect([200, 201]).toContain(distillRes.status());
    const distilled = (await distillRes.json()) as {
      manifest?: Record<string, unknown>;
      app?: Record<string, unknown>;
    };
    const cleanManifest = (distilled.manifest ?? distilled.app ?? distilled) as Record<
      string,
      unknown
    >;
    const cleanSerialized = JSON.stringify(cleanManifest);
    expect(cleanSerialized).not.toContain('RawRecordedCredential99!');
    expect(cleanSerialized).toContain('example_portal_password');

    const pubRes = await request.post(apiUrl(API_PATHS.automationApps), {
      headers: authorHeaders,
      data: {
        manifest: cleanManifest,
        is_published: true,
        changelog: 'SC06 initial release',
      },
    });
    expect(pubRes.status()).toBe(201);
    const detail = (await pubRes.json()) as {
      app_id: string;
      content_sha256: string;
    };
    expect(detail.content_sha256).toMatch(/^[a-f0-9]{64}$/i);

    // 5. User B searches, installs (proving idempotency on 2nd install), and records zero-LLM deterministic replay run
    const searchRes = await request.get(
      `${apiUrl(API_PATHS.automationApps)}?q=Deterministic%20Invoice`,
      { headers: installerHeaders },
    );
    expect(searchRes.status()).toBe(200);
    expect(await searchRes.text()).toContain(detail.app_id);

    const installUrl = apiUrl(`${API_PATHS.automationApps}/${detail.app_id}/install`);
    const inst1Res = await request.post(installUrl, { headers: installerHeaders });
    expect(inst1Res.status()).toBe(200);
    const inst1 = (await inst1Res.json()) as { newly_installed: boolean; install_count: number };
    expect(inst1.newly_installed).toBe(true);
    expect(inst1.install_count).toBe(1);

    const inst2Res = await request.post(installUrl, { headers: installerHeaders });
    expect(inst2Res.status()).toBe(200);
    const inst2 = (await inst2Res.json()) as { newly_installed: boolean; install_count: number };
    expect(inst2.newly_installed).toBe(false);
    expect(inst2.install_count).toBe(1);

    const runRes = await request.post(
      apiUrl(`${API_PATHS.automationApps}/${detail.app_id}/runs`),
      {
        headers: installerHeaders,
        data: {
          version: '1.0.0',
          success: true,
          steps_executed: 5,
          total_duration_ms: 290,
          used_llm: false,
        },
      },
    );
    expect(runRes.status()).toBe(200);
    expect(((await runRes.json()) as { run_count: number }).run_count).toBe(1);

    // 6. Verify #automation-app-store-panel displays the published app & deterministically revoke desktop pairing
    await scopedTab(
      inspectorTabs,
      bilingualRegex('app\\s*store', '应用商店|脚本商店'),
    )
      .first()
      .click();
    const storePanel = page.locator(AUTOMATION_APP_STORE_PANEL);
    await expect(storePanel).toBeVisible();
    await expect(storePanel).toContainText('SC06 Deterministic Invoice Exporter');

    const revokeBtn = page.locator(DOM.btnBrowserRevokeControl);
    await expect(revokeBtn).toBeVisible();
    const [revokeRes] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes('/api/v1/browser') && res.url().includes('revoke'),
        { timeout: 8_000 },
      ),
      revokeBtn.click(),
    ]);
    expect(revokeRes.status()).toBe(200);

    const postRevoke = await request.post(apiUrl(API_PATHS.browserCommand), {
      headers: { Authorization: `Bearer ${controlToken as string}` },
      data: { action: 'snapshot' },
      failOnStatusCode: false,
    });
    expect([401, 403, 409]).toContain(postRevoke.status());
  });
});
