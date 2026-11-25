import * as crypto from 'node:crypto';
import { test, expect } from '../helpers/fixtures';
import { API_PATHS, DOM, MINIAPP_PIP_OVERLAY } from '../helpers/selectors';
import {
  apiUrl,
  authHeaders,
  registerUserViaApi,
} from '../helpers/server';
import { bilingualRegex, scopedButton } from '../helpers/ui';
import {
  buildMiniAppTakeoverStateFrame,
  buildMiniAppWebMcpResultFrame,
  extractRawInitData,
  extractUpdateEvent,
  OpaqueWsClient,
} from '../helpers/api';

const EXPECTED_WASM_BYTE_LENGTH = 837_676;
const EXPECTED_WASM_SHA256 =
  'a074f76cc3f6a274e485920587adb1794050bf0cdb737ebdb2f7ac3fdcb046d1';

interface E2eWasmProbeWindow {
  __e2eWasmCount?: number;
  __e2ePipSentinel?: string;
}

test.describe('Tier 1 — A12: Decoupled Mini Apps, Fresh v1.6.11 Fabushi 3D WASM, WebMCP & PiP Restore-in-Place', () => {
  test('A12-T1-01: Decoupled /api/v1/miniapps/* catalog, install, recent & launch context with real HMAC init_data', async ({
    request,
  }) => {
    const user = await registerUserViaApi(request);
    const headers = authHeaders(user.token);

    const catalogRes = await request.get(apiUrl(API_PATHS.miniappsCatalog), { headers });
    expect(catalogRes.status()).toBe(200);
    const catalog = (await catalogRes.json()) as {
      apps?: Array<{ bot_username: string; short_name: string }>;
    };
    expect(Array.isArray(catalog.apps)).toBe(true);
    const apps = catalog.apps!;
    expect(apps.length).toBeGreaterThanOrEqual(1);
    const targetApp =
      apps.find((a) => /fabushi/i.test(a.short_name) || /fabushi/i.test(a.bot_username)) ??
      apps[0];

    const installRes = await request.post(
      apiUrl(`${API_PATHS.miniapps}/${targetApp.bot_username}/${targetApp.short_name}/install`),
      { headers },
    );
    expect([200, 201]).toContain(installRes.status());

    const launchRes = await request.post(
      apiUrl(`${API_PATHS.miniapps}/${targetApp.bot_username}/${targetApp.short_name}/launch`),
      { headers, data: { launch_mode: 'full' } },
    );
    expect(launchRes.status()).toBe(200);
    const launchCtx = (await launchRes.json()) as {
      init_data?: string | { raw_query_string?: string; hmac_verified?: boolean };
      companion_chat_id?: number;
      app?: { short_name?: string };
    };
    const rawInitData = extractRawInitData(launchCtx.init_data);
    expect(rawInitData.length).toBeGreaterThan(0);
    expect(decodeURIComponent(rawInitData)).toContain(user.username);
    const hmacValid =
      typeof launchCtx.init_data === 'object' && launchCtx.init_data !== null
        ? launchCtx.init_data.hmac_verified === true
        : rawInitData.includes('hash=');
    expect(hmacValid).toBe(true);
    expect(Number(launchCtx.companion_chat_id)).toBeGreaterThan(0);

    const recentRes = await request.get(apiUrl(API_PATHS.miniappsRecent), { headers });
    expect(recentRes.status()).toBe(200);
    expect(await recentRes.text()).toContain(targetApp.short_name);
  });

  test('A12-T1-02: Fresh v1.6.11 fabushi-globe WASM (\\0asm, 837,676 B, SHA-256 a074f76c...) & real 3D <canvas> rendering in #miniapp-iframe', async ({
    authSession,
    request,
  }) => {
    const { page } = authSession;

    // 1. Direct binary & SHA-256 integrity proof of fresh v1.6.11 WASM artifact
    const wasmRes = await request.get(apiUrl(API_PATHS.fabushiMiniAppWasm));
    expect(wasmRes.status()).toBe(200);
    const wasmBytes = await wasmRes.body();
    expect(wasmBytes.length).toBe(EXPECTED_WASM_BYTE_LENGTH);
    expect([...wasmBytes.subarray(0, 4)]).toEqual([0x00, 0x61, 0x73, 0x6d]);
    const actualSha256 = crypto.createHash('sha256').update(wasmBytes).digest('hex');
    expect(actualSha256).toBe(EXPECTED_WASM_SHA256);

    // Verify hosted HTML uses relative subpath-safe ../../js/telegram-web-app.js
    const indexRes = await request.get(apiUrl(API_PATHS.fabushiMiniAppIndex));
    expect(indexRes.status()).toBe(200);
    const html = await indexRes.text();
    expect(html).toContain('../../js/telegram-web-app.js');

    // 2. Live browser rendering of 3D Globe <canvas>
    await page.context().addInitScript(() => {
      const w = window as unknown as E2eWasmProbeWindow;
      w.__e2eWasmCount = 0;
      const origInst = WebAssembly.instantiate.bind(WebAssembly);
      WebAssembly.instantiate = (async (...args: Parameters<typeof WebAssembly.instantiate>) => {
        const res = await origInst(...args);
        w.__e2eWasmCount = (w.__e2eWasmCount as number) + 1;
        return res;
      }) as typeof WebAssembly.instantiate;
      if (typeof WebAssembly.instantiateStreaming === 'function') {
        const origStream = WebAssembly.instantiateStreaming.bind(WebAssembly);
        WebAssembly.instantiateStreaming = (async (
          ...args: Parameters<typeof WebAssembly.instantiateStreaming>
        ) => {
          const res = await origStream(...args);
          w.__e2eWasmCount = (w.__e2eWasmCount as number) + 1;
          return res;
        }) as typeof WebAssembly.instantiateStreaming;
      }
    });

    const gotoRes = await page.goto(apiUrl(API_PATHS.fabushiMiniAppIndex), {
      waitUntil: 'domcontentloaded',
    });
    expect(gotoRes?.status()).toBe(200);
    const canvas = page.locator('canvas').first();
    await expect(canvas).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const count = (window as unknown as E2eWasmProbeWindow).__e2eWasmCount;
            return typeof count === 'number' ? count : -1;
          }),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);

    const canvasDims = await canvas.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      return { w: c.width, h: c.height };
    });
    expect(canvasDims.w).toBeGreaterThanOrEqual(150);
    expect(canvasDims.h).toBeGreaterThanOrEqual(150);
  });

  test('A12-T1-03: /js/telegram-web-app.js SDK authenticated initData HMAC validation, themeParams, MainButton & CloudStorage persistence', async ({
    page,
    request,
  }) => {
    const user = await registerUserViaApi(request);
    const headers = authHeaders(user.token);

    const catalogRes = await request.get(apiUrl(API_PATHS.miniappsCatalog), { headers });
    expect(catalogRes.status()).toBe(200);
    const catalog = (await catalogRes.json()) as {
      apps?: Array<{ bot_username: string; short_name: string }>;
    };
    expect(Array.isArray(catalog.apps)).toBe(true);
    const app = catalog.apps![0];
    expect(app).toBeTruthy();

    const launchRes = await request.post(
      apiUrl(`${API_PATHS.miniapps}/${app.bot_username}/${app.short_name}/launch`),
      { headers, data: {} },
    );
    expect(launchRes.status()).toBe(200);
    const launchCtx = (await launchRes.json()) as {
      init_data?: string | { raw_query_string?: string; hmac_verified?: boolean };
    };
    const rawInitData = extractRawInitData(launchCtx.init_data);
    expect(rawInitData.length).toBeGreaterThan(0);
    const hmacValid =
      typeof launchCtx.init_data === 'object' && launchCtx.init_data !== null
        ? launchCtx.init_data.hmac_verified === true
        : rawInitData.includes('hash=');
    expect(hmacValid).toBe(true);

    // Validate genuine HMAC-SHA256 WebAppData signature
    const validateRes = await request.post(
      apiUrl(`${API_PATHS.miniapps}/${app.bot_username}/${app.short_name}/validate-init-data`),
      {
        headers,
        data: { init_data: rawInitData },
      },
    );
    expect(validateRes.status()).toBe(200);
    const valBody = (await validateRes.json()) as { ok?: boolean; valid?: boolean };
    expect(valBody.ok ?? valBody.valid).toBe(true);

    // Verify /js/telegram-web-app.js SDK exposes themeParams & MainButton in browser
    const gotoRes = await page.goto(apiUrl(API_PATHS.fabushiMiniAppIndex), {
      waitUntil: 'domcontentloaded',
    });
    expect(gotoRes?.status()).toBe(200);
    const sdkShape = await page.evaluate(() => {
      const wa = (
        window as unknown as {
          Telegram?: {
            WebApp?: {
              themeParams?: Record<string, unknown>;
              MainButton?: { setText?: unknown; show?: unknown };
            };
          };
        }
      ).Telegram?.WebApp;
      return {
        hasThemeParams: typeof wa?.themeParams === 'object' && wa.themeParams !== null,
        hasMainButtonSetText: typeof wa?.MainButton?.setText === 'function',
        hasMainButtonShow: typeof wa?.MainButton?.show === 'function',
      };
    });
    expect(sdkShape).toEqual({
      hasThemeParams: true,
      hasMainButtonSetText: true,
      hasMainButtonShow: true,
    });

    // CloudStorage real persistence round-trip
    const storageUrl = apiUrl(
      `${API_PATHS.miniapps}/${app.bot_username}/${app.short_name}/storage`,
    );
    const putStorage = await request.put(storageUrl, {
      headers,
      data: { key: 'merit_count', value: '108' },
    });
    expect(putStorage.status()).toBe(200);

    const getStorage = await request.get(storageUrl, { headers });
    expect(getStorage.status()).toBe(200);
    expect(await getStorage.text()).toContain('108');
  });

  test('A12-T1-04: navigator.modelContext WebMCP API exposes 6 built-in DOM tools + 6 Fabushi WebMCP tools & reportStatus telemetry', async ({
    page,
  }) => {
    const gotoRes = await page.goto(apiUrl(API_PATHS.fabushiMiniAppIndex), {
      waitUntil: 'domcontentloaded',
    });
    expect(gotoRes?.status()).toBe(200);

    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const bridge = (
              window as unknown as {
                __GPUI_WEBMCP__?: {
                  discover?: () => Array<{ name: string; description: string; read_only: boolean }>;
                };
              }
            ).__GPUI_WEBMCP__;
            const descriptors = typeof bridge?.discover === 'function' ? bridge.discover() : [];
            return descriptors.map((t) => t.name);
          }),
        { timeout: 10_000 },
      )
      .toEqual(
        expect.arrayContaining([
          // 6 built-in universal DOM tools
          'get_state',
          'page_inspect',
          'page_click',
          'page_fill',
          'page_press_main_button',
          'page_press_secondary_button',
          // 6 Fabushi custom WebMCP tools
          'fabushi_get_status',
          'fabushi_switch_tab',
          'fabushi_send_dharma',
          'fabushi_stop_dharma',
          'fabushi_record_practice',
          'fabushi_open_sheet',
        ]),
      );

    const webMcpState = await page.evaluate(() => {
      const nav = navigator as Navigator & {
        modelContext?: {
          registerTool?: unknown;
          unregisterTool?: unknown;
          provideContext?: unknown;
          clearContext?: unknown;
          setStateProvider?: unknown;
          reportStatus?: (status: Record<string, unknown>) => void;
        };
      };
      const bridge = (
        window as unknown as {
          __GPUI_WEBMCP__?: {
            discover?: unknown;
            readState?: unknown;
            invoke?: unknown;
          };
        }
      ).__GPUI_WEBMCP__;
      const mc = nav.modelContext;
      let reportedOk = false;
      if (typeof mc?.reportStatus === 'function') {
        mc.reportStatus({ ok: true, status_text: 'e2e_webmcp_ready' });
        reportedOk = true;
      }
      return {
        hasModelContext: Boolean(mc),
        methods: {
          registerTool: typeof mc?.registerTool === 'function',
          unregisterTool: typeof mc?.unregisterTool === 'function',
          provideContext: typeof mc?.provideContext === 'function',
          clearContext: typeof mc?.clearContext === 'function',
          setStateProvider: typeof mc?.setStateProvider === 'function',
          reportStatus: typeof mc?.reportStatus === 'function',
        },
        hasBridge: Boolean(bridge),
        hasDiscover: typeof bridge?.discover === 'function',
        hasReadState: typeof bridge?.readState === 'function',
        hasInvoke: typeof bridge?.invoke === 'function',
        reportedOk,
      };
    });

    expect(webMcpState.hasModelContext).toBe(true);
    expect(webMcpState.methods).toEqual({
      registerTool: true,
      unregisterTool: true,
      provideContext: true,
      clearContext: true,
      setStateProvider: true,
      reportStatus: true,
    });
    expect(
      webMcpState.hasBridge &&
        webMcpState.hasDiscover &&
        webMcpState.hasReadState &&
        webMcpState.hasInvoke,
    ).toBe(true);
    expect(webMcpState.reportedOk).toBe(true);
  });

  test('A12-T1-05: WS MiniAppWebMcpCommand (discover / call_tool / get_state) <-> MiniAppWebMcpResult & MiniAppTakeoverState broadcast live round-trip', async ({
    page,
    request,
  }) => {
    const user = await registerUserViaApi(request);
    const headers = authHeaders(user.token);

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
      companion_chat_id?: number;
    };
    const chatId = Number(launchCtx.companion_chat_id);
    expect(chatId).toBeGreaterThan(0);

    // Part A: 2-WS-client server broker broadcast verification (MiniAppTakeoverState -> UpdateEvent::MiniAppControlStatus)
    const wsClientA = await OpaqueWsClient.connect(user.token);
    const wsClientB = await OpaqueWsClient.connect(user.token);
    try {
      wsClientA.send(
        buildMiniAppTakeoverStateFrame({
          bot_username: app.bot_username,
          short_name: app.short_name,
          chat_id: chatId,
          bot_user_id: 0,
          mode: 'user_takeover',
          user_note: 'E2E takeover verify',
          state_snapshot: { active_tab: 'globe' },
        }),
      );

      const takeoverFrame = await wsClientB.waitForFrame(
        (f) => {
          const ev = extractUpdateEvent(f, 'MiniAppControlStatus');
          return (
            ev !== null &&
            ev.bot_username === app.bot_username &&
            ev.short_name === app.short_name &&
            ev.mode === 'user_takeover'
          );
        },
        6_000,
        'UpdateEvent::MiniAppControlStatus (user_takeover)',
      );
      expect(extractUpdateEvent(takeoverFrame, 'MiniAppControlStatus')?.mode).toBe('user_takeover');

      const cursorBeforeIdle = wsClientB.getFrameCount();
      wsClientA.send(
        buildMiniAppTakeoverStateFrame({
          bot_username: app.bot_username,
          short_name: app.short_name,
          chat_id: chatId,
          bot_user_id: 0,
          mode: 'idle',
          user_note: 'E2E takeover released',
          state_snapshot: { active_tab: 'globe' },
        }),
      );

      const idleFrame = await wsClientB.waitForFrame(
        (f) => {
          const ev = extractUpdateEvent(f, 'MiniAppControlStatus');
          return (
            ev !== null &&
            ev.bot_username === app.bot_username &&
            ev.short_name === app.short_name &&
            ev.mode === 'idle'
          );
        },
        6_000,
        'UpdateEvent::MiniAppControlStatus (idle)',
        cursorBeforeIdle,
      );
      expect(extractUpdateEvent(idleFrame, 'MiniAppControlStatus')?.mode).toBe('idle');

      // Part B: Live in-browser window.__GPUI_WEBMCP__.invoke() for discover, get_state, call_tool -> canonical MiniAppWebMcpResult
      const gotoRes = await page.goto(apiUrl(API_PATHS.fabushiMiniAppIndex), {
        waitUntil: 'domcontentloaded',
      });
      expect(gotoRes?.status()).toBe(200);

      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const bridge = (
                window as unknown as {
                  __GPUI_WEBMCP__?: { discover?: () => Array<{ name: string }> };
                }
              ).__GPUI_WEBMCP__;
              return typeof bridge?.discover === 'function' ? bridge.discover().length : 0;
            }),
          { timeout: 10_000 },
        )
        .toBeGreaterThanOrEqual(12);

      const invokeBridge = async (
        operation: 'discover' | 'get_state' | 'call_tool',
        toolName: string,
        args: Record<string, unknown>,
      ) => {
        const reqId = `wmcp_${operation}_${crypto.randomBytes(3).toString('hex')}`;
        const captured = await page.evaluate(
          ({ requestId, op, tool, toolArgs }) =>
            new Promise<Record<string, unknown>>((resolve, reject) => {
              const bridge = (
                window as unknown as {
                  __GPUI_WEBMCP__?: {
                    invoke?: (
                      id: string,
                      opName: string,
                      tName?: string,
                      tArgs?: Record<string, unknown>,
                    ) => void;
                  };
                }
              ).__GPUI_WEBMCP__;
              if (typeof bridge?.invoke !== 'function') {
                reject(new Error('Missing window.__GPUI_WEBMCP__.invoke'));
                return;
              }
              const timer = window.setTimeout(
                () => reject(new Error(`Timed out awaiting webmcp_response for ${requestId}`)),
                5_000,
              );
              const onMessage = (evt: MessageEvent) => {
                let parsed: unknown = evt.data;
                if (typeof parsed === 'string') {
                  try {
                    parsed = JSON.parse(parsed);
                  } catch {
                    return;
                  }
                }
                if (
                  parsed &&
                  typeof parsed === 'object' &&
                  (parsed as { eventType?: string }).eventType === 'webmcp_response'
                ) {
                  const data = (parsed as { eventData?: Record<string, unknown> }).eventData;
                  if (data && data.request_id === requestId) {
                    window.clearTimeout(timer);
                    window.removeEventListener('message', onMessage);
                    resolve(data);
                  }
                }
              };
              window.addEventListener('message', onMessage);
              bridge.invoke(requestId, op, tool, toolArgs);
            }),
          { requestId: reqId, op: operation, tool: toolName, toolArgs: args },
        );
        expect(captured.request_id).toBe(reqId);
        expect(captured.ok).toBe(true);
        expect(captured.error == null).toBe(true);
        return captured;
      };

      const discoverResp = await invokeBridge('discover', '', {});
      expect(Array.isArray(discoverResp.tools)).toBe(true);
      expect((discoverResp.tools as unknown[]).length).toBeGreaterThanOrEqual(12);

      const getStateResp = await invokeBridge('get_state', '', {});
      expect(getStateResp.state_summary ?? getStateResp.result).toBeTruthy();

      const callToolResp = await invokeBridge('call_tool', 'page_inspect', {});
      expect(callToolResp.result).toBeTruthy();

      // Send canonical MiniAppWebMcpResult frame over WS and assert zero server WS Error frames
      wsClientA.send(
        buildMiniAppWebMcpResultFrame({
          request_id: discoverResp.request_id,
          ok: true,
          result: callToolResp.result,
          error: null,
          tools: discoverResp.tools,
          state_summary: getStateResp.state_summary ?? { kind: 'fabushi', status_text: 'Ready' },
          control_mode: 'ai_controlling',
        }),
      );
      await page.waitForTimeout(300);
      const errorFrames = wsClientA.getFrames().filter((f) => f.type === 'Error');
      expect(errorFrames).toHaveLength(0);
    } finally {
      wsClientA.close();
      wsClientB.close();
    }
  });

  test('A12-T1-06: Floating PiP (#miniapp-pip-overlay) live telemetry & restore-in-place preserving live WASM/JS iframe instance without reload', async ({
    authSession,
  }) => {
    const { page } = authSession;

    // Launch Fabushi Mini App from UI
    const launchTrigger = page
      .locator('[data-testid*="miniapp" i], [data-miniapp-short-name*="fabushi" i]')
      .or(scopedButton(page, bilingualRegex('fabushi|mini\\s*app|法布施', '法布施|小程序')))
      .first();
    await expect(launchTrigger).toBeVisible();
    await launchTrigger.click();

    const modal = page.locator(DOM.miniappModal);
    await expect(modal).toBeVisible();
    const iframeLoc = page.locator(DOM.miniappIframe);
    await expect(iframeLoc).toBeVisible();

    const handle = await iframeLoc.elementHandle();
    const frame = await handle?.contentFrame();
    expect(frame).not.toBeNull();

    // Plant unique runtime sentinel inside iframe window; reload would wipe it
    const sentinelValue = `pip_alive_${Date.now()}`;
    await frame!.evaluate((val) => {
      (window as unknown as E2eWasmProbeWindow).__e2ePipSentinel = val;
    }, sentinelValue);

    // Minimize into floating #miniapp-pip-overlay and verify live telemetry text
    const minimizeBtn = scopedButton(
      modal,
      bilingualRegex('minimize|pip|picture|float', '最小化|画中画|悬浮'),
    ).first();
    await expect(minimizeBtn).toBeVisible();
    await minimizeBtn.click();

    const pipOverlay = page.locator(MINIAPP_PIP_OVERLAY);
    await expect(pipOverlay).toBeVisible();
    const pipText = await pipOverlay.innerText();
    expect(pipText.trim().length).toBeGreaterThan(0);

    // Restore in-place and assert identical iframe instance survived without reload
    const restoreBtn = scopedButton(
      pipOverlay,
      bilingualRegex('restore|expand|open', '恢复|展开|放大'),
    ).first();
    await expect(restoreBtn).toBeVisible();
    await restoreBtn.click();
    await expect(modal).toBeVisible();

    const restoredHandle = await page.locator(DOM.miniappIframe).elementHandle();
    const restoredFrame = await restoredHandle?.contentFrame();
    expect(restoredFrame).not.toBeNull();
    const survived = await restoredFrame!.evaluate(
      () => (window as unknown as E2eWasmProbeWindow).__e2ePipSentinel,
    );
    expect(survived).toBe(sentinelValue);
  });
});
