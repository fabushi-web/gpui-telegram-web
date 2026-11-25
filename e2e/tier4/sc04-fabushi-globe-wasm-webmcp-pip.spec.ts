import * as crypto from 'node:crypto';
import { test, expect } from '../helpers/fixtures';
import { API_PATHS, DOM, MINIAPP_PIP_OVERLAY } from '../helpers/selectors';
import { apiUrl, authHeaders } from '../helpers/server';
import {
  buildMiniAppTakeoverStateFrame,
  buildMiniAppWebMcpResultFrame,
  extractRawInitData,
  extractUpdateEvent,
  OpaqueWsClient,
} from '../helpers/api';
import { bilingualRegex, scopedButton, selectChat } from '../helpers/ui';

const EXPECTED_WASM_BYTE_LENGTH = 837_676;
const EXPECTED_WASM_SHA256 =
  'a074f76cc3f6a274e485920587adb1794050bf0cdb737ebdb2f7ac3fdcb046d1';

test.describe('Tier 4 — SC-04: Fresh v1.6.11 fabushi-globe WASM, navigator.modelContext WebMCP & PiP Restore-in-Place', () => {
  test('SC-04: Verify SDK zero fake initData -> verify 837,676B WASM SHA-256 -> launch fabushi-globe -> WebMCP tools + WS bridge -> PiP minimize & restore-in-place -> CloudStorage & send-data card', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const headers = authHeaders(user.token);

    // 1. Verify /js/telegram-web-app.js SDK embeds ZERO fake initData or hardcoded hash
    const sdkRes = await request.get(apiUrl(API_PATHS.telegramWebAppSdk));
    expect(sdkRes.status()).toBe(200);
    const sdkText = await sdkRes.text();
    expect(sdkText).not.toContain('89d6079ad6762351f38c6dbbc41bb53048019256a9443988af7a48bcad16ba31');

    const sdkBlankPage = await page.context().newPage();
    try {
      await sdkBlankPage.setContent(
        `<!doctype html><html><head><script src="${apiUrl(API_PATHS.telegramWebAppSdk)}"></script></head><body></body></html>`,
      );
      const sdkSnapshot = await sdkBlankPage.evaluate(() => {
        const wa = (
          window as unknown as {
            Telegram?: { WebApp?: { initData?: string; initDataUnsafe?: { user?: unknown } } };
          }
        ).Telegram?.WebApp;
        return {
          exists: Boolean(wa),
          initData: wa ? wa.initData : undefined,
          user: wa?.initDataUnsafe?.user,
        };
      });
      expect(sdkSnapshot.exists).toBe(true);
      expect(sdkSnapshot.initData).toBe('');
      expect(sdkSnapshot.user).toBeUndefined();
    } finally {
      await sdkBlankPage.close();
    }

    // 2. Verify exact v1.6.11 WASM binary digest and byte length
    const wasmRes = await request.get(apiUrl(API_PATHS.fabushiMiniAppWasm));
    expect(wasmRes.status()).toBe(200);
    const wasmBuf = await wasmRes.body();
    expect(wasmBuf.length).toBe(EXPECTED_WASM_BYTE_LENGTH);
    expect([...wasmBuf.subarray(0, 4)]).toEqual([0x00, 0x61, 0x73, 0x6d]);
    expect(crypto.createHash('sha256').update(wasmBuf).digest('hex')).toBe(EXPECTED_WASM_SHA256);

    // 3. Verify catalog + real HMAC init_data launch context
    const catalogRes = await request.get(apiUrl(API_PATHS.miniappsCatalog), { headers });
    expect(catalogRes.status()).toBe(200);
    const catalog = (await catalogRes.json()) as {
      apps?: Array<{ bot_username: string; short_name: string }>;
    };
    expect(Array.isArray(catalog.apps)).toBe(true);
    const app =
      catalog.apps!.find(
        (a) => /fabushi/i.test(a.short_name) || /fabushi/i.test(a.bot_username),
      ) ?? catalog.apps![0];
    expect(app).toBeTruthy();

    const launchRes = await request.post(
      apiUrl(`${API_PATHS.miniapps}/${app.bot_username}/${app.short_name}/launch`),
      { headers, data: { launch_mode: 'full' } },
    );
    expect(launchRes.status()).toBe(200);
    const launchCtx = (await launchRes.json()) as {
      init_data?: string | { raw_query_string?: string; hmac_verified?: boolean };
      companion_chat_id: number;
    };
    const rawInitData = extractRawInitData(launchCtx.init_data);
    expect(rawInitData.length).toBeGreaterThan(0);
    expect(decodeURIComponent(rawInitData)).toContain(user.username);
    const hmacValid =
      typeof launchCtx.init_data === 'object' && launchCtx.init_data !== null
        ? launchCtx.init_data.hmac_verified === true
        : rawInitData.includes('hash=');
    expect(hmacValid).toBe(true);

    const valRes = await request.post(
      apiUrl(`${API_PATHS.miniapps}/${app.bot_username}/${app.short_name}/validate-init-data`),
      { headers, data: { init_data: rawInitData } },
    );
    expect(valRes.status()).toBe(200);

    // 4. Open fabushi-globe in #miniapp-modal, inspect WebMCP tools & plant PiP survival sentinel
    const launchTrigger = page
      .locator('[data-testid*="miniapp" i], [data-miniapp-short-name*="fabushi" i]')
      .or(scopedButton(page, bilingualRegex('fabushi|mini\\s*app|法布施', '法布施|小程序')))
      .first();
    await expect(launchTrigger).toBeVisible();
    await launchTrigger.click();

    const modal = page.locator(DOM.miniappModal);
    await expect(modal).toBeVisible();
    const iframe = page.locator(DOM.miniappIframe);
    await expect(iframe).toBeVisible();
    const handle = await iframe.elementHandle();
    const frame = await handle?.contentFrame();
    expect(frame).not.toBeNull();

    await expect
      .poll(
        () =>
          frame!.evaluate(() => {
            const bridge = (
              window as unknown as {
                __GPUI_WEBMCP__?: { discover?: () => Array<{ name: string }> };
              }
            ).__GPUI_WEBMCP__;
            return typeof bridge?.discover === 'function'
              ? bridge.discover().map((t) => t.name)
              : [];
          }),
        { timeout: 10_000, message: 'Expected WebMCP built-in + Fabushi tools inside iframe' },
      )
      .toEqual(
        expect.arrayContaining(['get_state', 'page_inspect', 'fabushi_get_status']),
      );

    const sentinel = `sc04_pip_live_${Date.now()}`;
    const mcCheck = await frame!.evaluate((s) => {
      (window as unknown as { __sc04Sentinel?: string }).__sc04Sentinel = s;
      const mc = (
        navigator as Navigator & {
          modelContext?: { registerTool?: unknown; reportStatus?: unknown };
        }
      ).modelContext;
      return {
        hasModelContext: Boolean(mc),
        hasRegisterTool: typeof mc?.registerTool === 'function',
        hasReportStatus: typeof mc?.reportStatus === 'function',
      };
    }, sentinel);
    expect(mcCheck).toEqual({
      hasModelContext: true,
      hasRegisterTool: true,
      hasReportStatus: true,
    });

    // 5. Minimize into floating #miniapp-pip-overlay while verifying WS WebMCP Takeover broadcast, then restore in-place
    const wsA = await OpaqueWsClient.connect(user.token);
    const wsB = await OpaqueWsClient.connect(user.token);
    try {
      await scopedButton(
        modal,
        bilingualRegex('minimize|pip|picture|float', '最小化|画中画|悬浮'),
      )
        .first()
        .click();
      const pip = page.locator(MINIAPP_PIP_OVERLAY);
      await expect(pip).toBeVisible();

      wsA.send(
        buildMiniAppTakeoverStateFrame({
          bot_username: app.bot_username,
          short_name: app.short_name,
          chat_id: launchCtx.companion_chat_id,
          bot_user_id: 0,
          mode: 'user_takeover',
          user_note: 'SC04 PiP check',
          state_snapshot: { tab: 'zen', merit: 324 },
        }),
      );
      const statusFrame = await wsB.waitForFrame(
        (f) => {
          const ev = extractUpdateEvent(f, 'MiniAppControlStatus');
          return (
            ev !== null &&
            ev.short_name === app.short_name &&
            ev.mode === 'user_takeover'
          );
        },
        6_000,
        'UpdateEvent::MiniAppControlStatus during SC-04 PiP',
      );
      expect(extractUpdateEvent(statusFrame, 'MiniAppControlStatus')?.mode).toBe('user_takeover');

      wsA.send(
        buildMiniAppWebMcpResultFrame({
          request_id: `sc04_${crypto.randomBytes(4).toString('hex')}`,
          ok: true,
          result: { tab: 'zen', merit: 324 },
          error: null,
          tools: [
            {
              name: 'fabushi_get_status',
              description: 'Read current Fabushi Mini App runtime status',
              input_schema: { type: 'object', properties: {} },
              read_only: true,
            },
          ],
          state_summary: { kind: 'fabushi', status_text: 'Zen tab active' },
          control_mode: 'ai_controlling',
        }),
      );

      const restoreBtn = scopedButton(
        pip,
        bilingualRegex('restore|expand|open', '恢复|展开|放大'),
      ).first();
      await expect(restoreBtn).toBeVisible();
      await restoreBtn.click();
      await expect(modal).toBeVisible();

      const restoredFrame = await (
        await page.locator(DOM.miniappIframe).elementHandle()
      )?.contentFrame();
      expect(restoredFrame).not.toBeNull();
      const survived = await restoredFrame!.evaluate(
        () => (window as unknown as { __sc04Sentinel?: string }).__sc04Sentinel,
      );
      expect(survived).toBe(sentinel);
    } finally {
      wsA.close();
      wsB.close();
    }

    // 6. Persist CloudStorage (with readback) & post dedication card back to companion chat
    const storageUrl = apiUrl(
      `${API_PATHS.miniapps}/${app.bot_username}/${app.short_name}/storage`,
    );
    const storeRes = await request.put(storageUrl, {
      headers,
      data: { key: 'sc04_merit', value: '324' },
    });
    expect(storeRes.status()).toBe(200);
    const readBackRes = await request.get(storageUrl, { headers });
    expect(readBackRes.status()).toBe(200);
    const readBackText = await readBackRes.text();
    expect(readBackText).toContain('sc04_merit');
    expect(readBackText).toContain('324');

    const cardRes = await request.post(
      apiUrl(`${API_PATHS.miniapps}/${app.bot_username}/${app.short_name}/send-data`),
      {
        headers,
        data: {
          chat_id: launchCtx.companion_chat_id,
          data: JSON.stringify({ event: 'sc04_dedication', merit: 324 }),
        },
      },
    );
    expect([200, 201]).toContain(cardRes.status());

    await page.keyboard.press('Escape');
    await selectChat(page, String(launchCtx.companion_chat_id));
    await expect(page.locator(DOM.messageList)).toContainText(/324|sc04_dedication/);
  });
});
