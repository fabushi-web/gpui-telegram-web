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
  type ScriptParameterDto,
} from '../helpers/api';
import {
  bilingualRegex,
  openNavDestination,
  scopedTab,
} from '../helpers/ui';

test.describe('Tier 1 — A15: Built-in Interactive Browser, AI Automation, Script Distillation & Automation App Store (v1.6.11)', () => {
  test('A15-T1-01: v1.6.11 Built-in Interactive Browser workspace (#nav-dest-browser, #browser-workspace, #browser-inspector-tabs 4 tabs) with truthful 0 initial targets', async ({
    authSession,
  }) => {
    const { page } = authSession;
    const workspace = await openNavDestination(page, 'browser');
    await expect(workspace).toBeVisible();

    const inspectorTabs = page.locator(BROWSER_INSPECTOR_TABS);
    await expect(inspectorTabs).toBeVisible();
    for (const tabPattern of [
      bilingualRegex('copilot', '副驾|助手'),
      bilingualRegex('recorder', '录制'),
      bilingualRegex('session', '会话'),
      bilingualRegex('app\\s*store', '应用商店|脚本商店'),
    ]) {
      await expect(scopedTab(inspectorTabs, tabPattern).first()).toBeVisible();
    }

    // Truthful 0 connected targets (no Math.max(1, ...) inflation)
    const wsText = await workspace.innerText();
    expect(wsText).not.toMatch(/Connected\s*Targets:\s*[1-9]/i);

    const urlInput = page.locator(DOM.browserHeadlessUrlInput);
    await expect(urlInput).toBeVisible();
    const prefilled = await urlInput.inputValue();
    expect(prefilled).not.toContain('<h1>Hello Desktop</h1>');
    expect(prefilled).not.toContain('data:text/html');
  });

  test('A15-T1-02: Persisted Desktop Pairing (pair/create -> pair/claim), audit log, and truthful un-clamped revoke (#btn-browser-revoke-control)', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const headers = authHeaders(user.token);

    const createPairRes = await request.post(apiUrl(API_PATHS.browserPairCreate), {
      headers,
      data: { label: 'Desktop Chrome Extension' },
    });
    expect([200, 201]).toContain(createPairRes.status());
    const pairData = (await createPairRes.json()) as {
      pairing_code?: unknown;
      code?: unknown;
    };
    const pairingCode = pairData.pairing_code ?? pairData.code;
    expect(typeof pairingCode).toBe('string');
    expect((pairingCode as string).length).toBeGreaterThanOrEqual(4);

    const claimRes = await request.post(apiUrl(API_PATHS.browserPairClaim), {
      headers,
      data: {
        pairing_code: pairingCode,
        code: pairingCode,
        device_name: 'E2E Desktop Bridge',
      },
    });
    expect(claimRes.status()).toBe(200);
    const claimed = (await claimRes.json()) as {
      control_token?: string;
      token?: string;
    };
    expect(claimed.control_token ?? claimed.token).toBeTruthy();

    await openNavDestination(page, 'browser');
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
    const auditLog = page.locator(DOM.browserAuditLog);
    await expect(auditLog).toBeVisible();
    await expect(auditLog).toContainText(/revoke|撤销|回收/i);
  });

  test('A15-T1-03: Real Chromium CDP headless session launch, navigation, semantic DOM inspection, and BrowserControlMode controls', async ({
    authSession,
  }) => {
    const { page } = authSession;
    await openNavDestination(page, 'browser');

    const urlInput = page.locator(DOM.browserHeadlessUrlInput);
    const openBtn = page.locator(DOM.btnBrowserHeadlessOpen);
    await expect(urlInput).toBeVisible();
    await expect(openBtn).toBeVisible();

    const deterministicPage =
      'data:text/html,' +
      encodeURIComponent(
        '<!doctype html><html><body><h1 data-testid="cdp-heading">Fabushi CDP Live</h1><button>Inspect Me</button></body></html>',
      );
    await urlInput.fill(deterministicPage);
    const [openRes] = await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes('/api/v1/browser') &&
          res.request().method() === 'POST',
        { timeout: 12_000 },
      ),
      openBtn.click(),
    ]);
    expect([200, 201]).toContain(openRes.status());

    const viewport = page.locator(DOM.browserHeadlessViewport);
    await expect(viewport).toBeVisible({ timeout: 12_000 });

    // Strictly require real non-SVG CDP output (PNG/JPEG <img> or non-zero <canvas>)
    const visualFrame = viewport.locator('img[src], canvas').first();
    await expect(visualFrame).toBeVisible({ timeout: 12_000 });
    const frameCheck = await visualFrame.evaluate((el) => {
      if (el instanceof HTMLImageElement) {
        const src = el.getAttribute('src') || '';
        return {
          isSvg: src.startsWith('data:image/svg+xml'),
          validFrame:
            (src.startsWith('data:image/png') ||
              src.startsWith('data:image/jpeg') ||
              src.startsWith('blob:') ||
              src.startsWith('http')) &&
            el.naturalWidth > 0,
        };
      }
      const canvas = el as HTMLCanvasElement;
      return {
        isSvg: false,
        validFrame: canvas.width > 0 && canvas.height > 0,
      };
    });
    expect(frameCheck.isSvg).toBe(false);
    expect(frameCheck.validFrame).toBe(true);

    // Strictly assert semantic DOM inspection output contains real navigated content
    const semanticContainer = page
      .locator(`${DOM.browserSnapshotView}, ${DOM.browserHeadlessViewport}`)
      .first();
    await expect(semanticContainer).toContainText('Fabushi CDP Live', { timeout: 10_000 });
    await expect(semanticContainer).toContainText('Inspect Me');

    // Strictly assert BrowserControlMode controls are rendered
    const controlModeEl = page
      .locator(
        `${DOM.btnBrowserRevokeControl}, [data-testid*="control-mode" i], [data-browser-control-mode]`,
      )
      .first();
    await expect(controlModeEl).toBeVisible();
  });

  test('A15-T1-04: Script Distillation (POST /api/v1/browser/scripts/distill) compiling BrowserActionTrace into parameterized secret-free AutomationScriptApp', async ({
    request,
  }) => {
    const user = await registerUserViaApi(request);
    const trace = buildSampleBrowserActionTrace();

    const distillRes = await request.post(apiUrl(API_PATHS.browserScriptsDistill), {
      headers: authHeaders(user.token),
      data: {
        trace,
        metadata: {
          name: 'Portal Sign-In Exporter',
          description: 'Distilled deterministic browser script',
          category: 'productivity',
          target_domains: ['example.com'],
        },
      },
    });
    expect([200, 201]).toContain(distillRes.status());
    const distilled = (await distillRes.json()) as {
      manifest?: Record<string, unknown>;
      app?: Record<string, unknown>;
      schema_version?: number;
      steps?: Array<Record<string, unknown>>;
    };
    const manifest = (distilled.manifest ?? distilled.app ?? distilled) as {
      schema_version?: number;
      steps?: Array<{ kind: string; value_template?: string; secret_vault_key?: string }>;
      parameters?: Array<ScriptParameterDto>;
    };

    expect(manifest.schema_version).toBe(1);
    expect(Array.isArray(manifest.steps)).toBe(true);
    expect(manifest.steps!.length).toBeGreaterThanOrEqual(4);
    expect(Array.isArray(manifest.parameters)).toBe(true);
    expect(manifest.parameters!.some((p) => p.is_secret === true)).toBe(true);
    // Raw recorded password MUST be scrubbed and bound to vault key/template
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain('RawRecordedCredential99!');
    expect(serialized).toContain('example_portal_password');
  });

  test('A15-T1-05: Automation App Store publish (201 w/ 64-hex content_sha256), search/filter, detail, and #automation-app-store-panel UI listing', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const headers = authHeaders(user.token);
    const manifest = buildValidAutomationAppManifest({
      name: 'Release Audit Automation App',
      category: 'devtools',
    });

    const pubRes = await request.post(apiUrl(API_PATHS.automationApps), {
      headers,
      data: {
        manifest,
        is_published: true,
        changelog: 'Initial deterministic release v1.0.0',
      },
    });
    expect(pubRes.status()).toBe(201);
    const detail = (await pubRes.json()) as {
      app_id: string;
      content_sha256: string;
      latest_version: string;
      is_published: boolean;
    };
    expect(detail.app_id).toBe(manifest.app_id);
    expect(detail.content_sha256).toMatch(/^[a-f0-9]{64}$/i);
    expect(detail.latest_version).toBe('1.0.0');
    expect(detail.is_published).toBe(true);

    const searchRes = await request.get(
      `${apiUrl(API_PATHS.automationApps)}?q=Release%20Audit&category=devtools`,
      { headers },
    );
    expect(searchRes.status()).toBe(200);
    expect(await searchRes.text()).toContain(manifest.app_id);

    const detailRes = await request.get(
      apiUrl(`${API_PATHS.automationApps}/${manifest.app_id}`),
      { headers },
    );
    expect(detailRes.status()).toBe(200);

    // Verify #automation-app-store-panel lists published app in UI
    await openNavDestination(page, 'browser');
    const appStoreTab = scopedTab(
      page.locator(BROWSER_INSPECTOR_TABS),
      bilingualRegex('app\\s*store', '应用商店|脚本商店'),
    ).first();
    await appStoreTab.click();
    const storePanel = page.locator(AUTOMATION_APP_STORE_PANEL);
    await expect(storePanel).toBeVisible();
    await expect(storePanel).toContainText('Release Audit Automation App');
  });

  test('A15-T1-06: Automation App Store idempotent install/uninstall & deterministic zero-LLM run telemetry (used_llm: false)', async ({
    request,
  }) => {
    const author = await registerUserViaApi(request);
    const installer = await registerUserViaApi(request);
    const manifest = buildValidAutomationAppManifest();

    const pubRes = await request.post(apiUrl(API_PATHS.automationApps), {
      headers: authHeaders(author.token),
      data: { manifest, is_published: true },
    });
    expect(pubRes.status()).toBe(201);

    const installUrl = apiUrl(`${API_PATHS.automationApps}/${manifest.app_id}/install`);
    const firstInstall = await request.post(installUrl, {
      headers: authHeaders(installer.token),
    });
    expect(firstInstall.status()).toBe(200);
    const firstBody = (await firstInstall.json()) as {
      ok: boolean;
      install_count: number;
      newly_installed: boolean;
    };
    expect(firstBody.ok).toBe(true);
    expect(firstBody.newly_installed).toBe(true);
    expect(firstBody.install_count).toBe(1);

    // 2nd install MUST be idempotent without double-incrementing install_count
    const secondInstall = await request.post(installUrl, {
      headers: authHeaders(installer.token),
    });
    expect(secondInstall.status()).toBe(200);
    const secondBody = (await secondInstall.json()) as {
      newly_installed: boolean;
      install_count: number;
    };
    expect(secondBody.newly_installed).toBe(false);
    expect(secondBody.install_count).toBe(1);

    // Record deterministic zero-LLM replay run
    const runRes = await request.post(
      apiUrl(`${API_PATHS.automationApps}/${manifest.app_id}/runs`),
      {
        headers: authHeaders(installer.token),
        data: {
          version: '1.0.0',
          success: true,
          steps_executed: 5,
          total_duration_ms: 412,
          used_llm: false,
        },
      },
    );
    expect(runRes.status()).toBe(200);
    const runBody = (await runRes.json()) as { ok: boolean; run_count: number };
    expect(runBody.ok).toBe(true);
    expect(runBody.run_count).toBe(1);

    const installedRes = await request.get(apiUrl(API_PATHS.automationAppsInstalled), {
      headers: authHeaders(installer.token),
    });
    expect(installedRes.status()).toBe(200);
    expect(await installedRes.text()).toContain(manifest.app_id);

    const uninstallRes = await request.delete(installUrl, {
      headers: authHeaders(installer.token),
    });
    expect(uninstallRes.status()).toBe(200);
    expect(((await uninstallRes.json()) as { removed: boolean }).removed).toBe(true);
  });
});
