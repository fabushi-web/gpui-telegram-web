import * as crypto from 'node:crypto';
import { test, expect } from '../helpers/fixtures';
import {
  API_PATHS,
  DOM,
  MINIAPP_PIP_OVERLAY,
} from '../helpers/selectors';
import {
  apiUrl,
  authHeaders,
  createRealConversationFixture,
  registerUserViaApi,
} from '../helpers/server';
import {
  buildMiniAppTakeoverStateFrame,
  buildMiniAppWebMcpResultFrame,
  callOfficialMcpJsonRpc,
  completeOfficialMcpOAuthFlow,
  extractUpdateEvent,
  OpaqueWsClient,
} from '../helpers/api';
import {
  bilingualRegex,
  BILINGUAL_PATTERNS,
  openContextMenuAndClick,
  scopedButton,
  selectChat,
} from '../helpers/ui';

test.describe('Tier 3 — PW05: Fabushi WASM + CloudStorage + Forward, PiP + WebMCP & OAuth 2.1 MCP + Remote Assist Kill Switch', () => {
  test('PW-13 (A12 x A05 x A04): Fresh v1.6.11 fabushi-globe WASM + CloudStorage + send-data -> chat card -> Forward into Forum Group', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const headers = authHeaders(user.token);
    const conv = await createRealConversationFixture(request, user.token, {
      includeGroup: true,
      isForumGroup: true,
      groupTitle: 'Dharma Dedication Forum',
    });
    expect(conv.groupTitle).toBeTruthy();

    // Verify genuine v1.6.11 WASM binary magic bytes (\0asm)
    const wasmRes = await request.get(apiUrl(API_PATHS.fabushiMiniAppWasm));
    expect(wasmRes.status()).toBe(200);
    const wasmBytes = await wasmRes.body();
    expect([...wasmBytes.subarray(0, 4)]).toEqual([0x00, 0x61, 0x73, 0x6d]);

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

    // Persist merit in CloudStorage, verify readback, and send data card back to companion chat
    const storageUrl = apiUrl(
      `${API_PATHS.miniapps}/${app.bot_username}/${app.short_name}/storage`,
    );
    const storageRes = await request.put(storageUrl, {
      headers,
      data: { key: 'pw13_merit', value: '216' },
    });
    expect(storageRes.status()).toBe(200);
    const storageGetRes = await request.get(storageUrl, { headers });
    expect(storageGetRes.status()).toBe(200);
    const storageText = await storageGetRes.text();
    expect(storageText).toContain('pw13_merit');
    expect(storageText).toContain('216');

    const launchRes = await request.post(
      apiUrl(`${API_PATHS.miniapps}/${app.bot_username}/${app.short_name}/launch`),
      { headers, data: {} },
    );
    expect(launchRes.status()).toBe(200);
    const launchBody = (await launchRes.json()) as { companion_chat_id: number };
    expect(launchBody.companion_chat_id).toBeGreaterThan(0);

    const sendDataRes = await request.post(
      apiUrl(`${API_PATHS.miniapps}/${app.bot_username}/${app.short_name}/send-data`),
      {
        headers,
        data: {
          chat_id: launchBody.companion_chat_id,
          data: JSON.stringify({ event: 'merit_dedication', count: 216 }),
        },
      },
    );
    expect([200, 201]).toContain(sendDataRes.status());

    // Forward the dedication message into the Forum Supergroup via UI
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, String(launchBody.companion_chat_id));
    const cardBubble = page
      .locator(DOM.messageList)
      .locator(DOM.messageBubble)
      .filter({ hasText: /216|merit_dedication/i })
      .last();
    await expect(cardBubble).toBeVisible();

    await openContextMenuAndClick(page, cardBubble, BILINGUAL_PATTERNS.forward);
    const fwdModal = page.locator(DOM.modalForward);
    await expect(fwdModal).toBeVisible();
    await fwdModal.getByText(conv.groupTitle!).first().click();

    const confirm = scopedButton(fwdModal, BILINGUAL_PATTERNS.send)
      .or(scopedButton(fwdModal, BILINGUAL_PATTERNS.confirm))
      .first();
    if (await confirm.isVisible()) {
      await confirm.click();
      await expect(fwdModal).toBeHidden();
    } else {
      await expect(fwdModal).toBeHidden();
    }

    // Verify forwarded card actually landed inside the Forum Supergroup
    await selectChat(page, conv.groupTitle!);
    await expect(page.locator(DOM.messageList)).toContainText(/216|merit_dedication/i);
  });

  test('PW-14 (A12 x A10 x A02): fabushi-globe minimized to #miniapp-pip-overlay while WS WebMCP runs -> restore-in-place preserves live WASM instance', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
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
    const launchCtx = (await launchRes.json()) as { companion_chat_id: number };
    expect(launchCtx.companion_chat_id).toBeGreaterThan(0);

    const wsA = await OpaqueWsClient.connect(user.token);
    const wsB = await OpaqueWsClient.connect(user.token);
    try {
      const launchTrigger = page
        .locator('[data-testid*="miniapp" i], [data-miniapp-short-name*="fabushi" i]')
        .or(scopedButton(page, bilingualRegex('fabushi|mini\\s*app|法布施', '法布施|小程序')))
        .first();
      await expect(launchTrigger).toBeVisible();
      await launchTrigger.click();

      const modal = page.locator(DOM.miniappModal);
      await expect(modal).toBeVisible();
      const handle = await page.locator(DOM.miniappIframe).elementHandle();
      const frame = await handle?.contentFrame();
      expect(frame).not.toBeNull();

      // Verify WebMCP navigator.modelContext + window.__GPUI_WEBMCP__.discover() inside iframe
      await expect
        .poll(
          () =>
            frame!.evaluate(() => {
              const nav = navigator as Navigator & {
                modelContext?: { registerTool?: unknown; reportStatus?: unknown };
              };
              const bridge = (
                window as unknown as {
                  __GPUI_WEBMCP__?: { discover?: () => Array<{ name: string }> };
                }
              ).__GPUI_WEBMCP__;
              const tools = typeof bridge?.discover === 'function' ? bridge.discover().map((t) => t.name) : [];
              return (
                typeof nav.modelContext?.registerTool === 'function' &&
                typeof nav.modelContext?.reportStatus === 'function' &&
                tools.includes('fabushi_get_status')
              );
            }),
          { timeout: 10_000, message: 'Expected WebMCP bridge & fabushi_get_status inside iframe' },
        )
        .toBe(true);

      const sentinel = `pw14_wasm_sentinel_${Date.now()}`;
      await frame!.evaluate((v) => {
        (window as unknown as { __pw14Sentinel?: string }).__pw14Sentinel = v;
      }, sentinel);

      // Minimize to floating PiP
      await scopedButton(
        modal,
        bilingualRegex('minimize|pip|picture|float', '最小化|画中画|悬浮'),
      )
        .first()
        .click();
      const pipOverlay = page.locator(MINIAPP_PIP_OVERLAY);
      await expect(pipOverlay).toBeVisible();

      // Emit canonical MiniAppTakeoverState while minimized and await genuine server broadcast
      wsA.send(
        buildMiniAppTakeoverStateFrame({
          bot_username: app.bot_username,
          short_name: app.short_name,
          chat_id: launchCtx.companion_chat_id,
          bot_user_id: 0,
          mode: 'user_takeover',
          user_note: 'PW14 PiP WebMCP check',
          state_snapshot: { status: 'active_in_pip' },
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
        'UpdateEvent::MiniAppControlStatus while minimized in PiP',
      );
      expect(extractUpdateEvent(statusFrame, 'MiniAppControlStatus')?.mode).toBe('user_takeover');

      wsA.send(
        buildMiniAppWebMcpResultFrame({
          request_id: `pw14_${crypto.randomBytes(4).toString('hex')}`,
          ok: true,
          result: { status: 'active_in_pip' },
          error: null,
          tools: [
            {
              name: 'fabushi_get_status',
              description: 'Read current Fabushi Mini App runtime status',
              input_schema: { type: 'object', properties: {} },
              read_only: true,
            },
          ],
          state_summary: { kind: 'fabushi', status_text: 'Active in PiP' },
          control_mode: 'ai_controlling',
        }),
      );

      // Restore in-place and confirm sentinel survived (zero unmount/reload)
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
        () => (window as unknown as { __pw14Sentinel?: string }).__pw14Sentinel,
      );
      expect(survived).toBe(sentinel);
    } finally {
      wsA.close();
      wsB.close();
    }
  });

  test('PW-15 (A14 x A13 x A02): Official OAuth 2.1 MCP session + UU Remote Assist session -> Emergency Kill Switch (disconnect-all) terminates BOTH sessions', async ({
    request,
  }) => {
    const hostUser = await registerUserViaApi(request);
    const guestUser = await registerUserViaApi(request);
    const hostHeaders = authHeaders(hostUser.token);

    // 1. Establish active Official OAuth 2.1 MCP session using canonical scopes
    const oauth = await completeOfficialMcpOAuthFlow(request, hostUser, {
      clientName: 'KillSwitch MCP Client',
      scope: 'devices:read devices:connect chats:read',
    });
    const init = await callOfficialMcpJsonRpc(
      request,
      'initialize',
      {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'pw15-mcp', version: '1.0' },
      },
      { accessToken: oauth.accessToken },
    );
    expect(init.status).toBe(200);
    const mcpSessionId = init.headers['mcp-session-id'];
    expect(mcpSessionId).toMatch(/^mcp_sess_/);

    // 2. Simultaneously establish active UU Remote Assist session
    const allowRes = await request.post(apiUrl(API_PATHS.remoteAssistAllow), {
      headers: hostHeaders,
      data: { allow_assist: true },
    });
    expect(allowRes.status()).toBe(200);

    const resetRes = await request.post(apiUrl(API_PATHS.remoteAssistResetCode), {
      headers: hostHeaders,
      data: {},
    });
    expect(resetRes.status()).toBe(200);
    const info = (await resetRes.json()) as { assist_id: string; current_code: string };

    const startAssist = await request.post(apiUrl(API_PATHS.remoteAssistStart), {
      headers: authHeaders(guestUser.token),
      data: {
        assist_id: info.assist_id,
        access_code: info.current_code,
        mode: 'desktop',
      },
    });
    expect(startAssist.status()).toBe(200);

    // 3. Fire Emergency Kill Switch -> disconnects ALL remote + MCP sessions
    const killRes = await request.post(apiUrl(API_PATHS.remoteSessionsDisconnectAll), {
      headers: hostHeaders,
      data: {},
    });
    expect(killRes.status()).toBe(200);
    const killBody = (await killRes.json()) as {
      disconnected_count: number;
      kill_switch: boolean;
    };
    expect(killBody.kill_switch).toBe(true);
    expect(killBody.disconnected_count).toBeGreaterThanOrEqual(1);

    // Remote sessions list is now empty
    const remSessionsRes = await request.get(apiUrl(API_PATHS.remoteSessions), {
      headers: hostHeaders,
    });
    expect(remSessionsRes.status()).toBe(200);
    const remSessions = (await remSessionsRes.json()) as { sessions?: unknown[] };
    expect(Array.isArray(remSessions.sessions)).toBe(true);
    expect(remSessions.sessions).toHaveLength(0);

    // MCP session previously established is terminated / rejected (401/404/410 Gone with JSON-RPC error)
    const postKillMcp = await callOfficialMcpJsonRpc(
      request,
      'tools/list',
      {},
      { accessToken: oauth.accessToken, sessionId: mcpSessionId },
    );
    expect([401, 404, 410]).toContain(postKillMcp.status);
    expect(postKillMcp.body?.error).toBeTruthy();
  });
});
