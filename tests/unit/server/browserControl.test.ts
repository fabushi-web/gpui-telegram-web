import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DOM_IDS,
  type BrowserCommandResult,
  type BrowserTargetDescriptor,
  type DesktopPairingTicketDto,
  type McpJsonRpcResponse,
} from '@gpui-telegram/protocol';
import {
  REPO_ROOT_DIR,
  closeAllHeadlessSessions,
  createTelegramServer,
  type TelegramServerInstance,
} from '@gpui-telegram/server';
import { registerTestUser } from './_helpers.js';

const TEST_TMP_ROOT = path.join(REPO_ROOT_DIR, '.test-tmp');

async function reqJson<T = any>(
  baseUrl: string,
  method: string,
  route: string,
  opts: {
    token?: string;
    desktopHeaderToken?: string;
    body?: unknown;
  } = {},
): Promise<{ status: number; data: T; headers: Headers }> {
  const headers: Record<string, string> = {};
  if (opts.token) {
    headers.Authorization = `Bearer ${opts.token}`;
  }
  if (opts.desktopHeaderToken) {
    headers['X-Desktop-Browser-Token'] = opts.desktopHeaderToken;
  }
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  return {
    status: res.status,
    data: (text ? JSON.parse(text) : {}) as T,
    headers: res.headers,
  };
}

function openWsClient(wsUrl: string, headers?: Record<string, string>): Promise<{
  ws: WebSocket;
  frames: any[];
  waitForFrame: (pred: (f: any) => boolean, timeoutMs?: number) => Promise<any>;
}> {
  return new Promise((resolve, reject) => {
    const frames: any[] = [];
    const waiters: Array<{ pred: (f: any) => boolean; res: (f: any) => void }> = [];
    const ws = new WebSocket(wsUrl, headers ? { headers } : undefined);

    ws.on('message', (raw) => {
      const parsed = JSON.parse(raw.toString('utf8'));
      frames.push(parsed);
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i]!;
        if (w.pred(parsed)) {
          waiters.splice(i, 1);
          w.res(parsed);
        }
      }
    });

    const helper = {
      ws,
      frames,
      waitForFrame(pred: (f: any) => boolean, timeoutMs = 5000): Promise<any> {
        const idx = frames.findIndex(pred);
        if (idx !== -1) {
          const matched = frames[idx]!;
          return Promise.resolve(matched);
        }
        return new Promise((resWait, rejWait) => {
          const timer = setTimeout(
            () => rejWait(new Error(`Timed out waiting for WS frame (${wsUrl})`)),
            timeoutMs,
          );
          waiters.push({
            pred,
            res: (f) => {
              clearTimeout(timer);
              resWait(f);
            },
          });
        });
      },
    };

    ws.once('open', () => resolve(helper));
    ws.once('error', reject);
  });
}

describe('@gpui-telegram/server — F17 Browser Control Bridge, Headless CDP/Fallback & MCP JSON-RPC 2.0', () => {
  let server: TelegramServerInstance;
  let baseUrl = '';
  let wsUrl = '';
  let dataDir = '';

  let fixtureHttpServer: http.Server;
  let fixtureBaseUrl = '';

  beforeAll(async () => {
    const suffix = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    dataDir = path.join(TEST_TMP_ROOT, `f17-bctrl-${suffix}`);
    fs.mkdirSync(dataDir, { recursive: true });

    server = createTelegramServer({
      port: 0,
      host: '127.0.0.1',
      dataDir,
      enableTestReset: true,
    });
    const info = await server.start();
    baseUrl = info.baseUrl;
    wsUrl = info.wsUrl;

    // Spin up a local fixture web app to test real Headless Chromium CDP & HTTP DOM Fallback
    fixtureHttpServer = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (req.url?.startsWith('/second')) {
        res.end(`<!doctype html>
          <html data-theme="night">
            <head><title>Fixture Second Page</title></head>
            <body>
              <h1>Arrived on Second Page</h1>
              <button id="btn-back" data-testid="back-btn">Return Home</button>
            </body>
          </html>`);
        return;
      }
      res.end(`<!doctype html>
        <html data-theme="day">
          <head><title>GPUI Automation Fixture</title></head>
          <body style="height: 2000px; font-family: sans-serif;">
            <h1>Browser Bridge Fixture Portal</h1>
            <p id="status-banner">Status: Idle</p>
            <input id="search-box" data-testid="fixture-input" placeholder="Type query..." value="" />
            <button id="run-btn" data-testid="fixture-submit" onclick="
              var v = document.getElementById('search-box').value;
              document.getElementById('status-banner').textContent = 'Submitted: ' + v;
            ">Execute Search</button>
            <a id="next-link" href="/second">Go To Second Page</a>
            <script>
              document.getElementById('search-box').addEventListener('keydown', function(ev) {
                if (ev.key === 'Enter') {
                  document.getElementById('status-banner').textContent = 'EnterPressed: ' + ev.target.value;
                }
              });
            </script>
          </body>
        </html>`);
    });
    await new Promise<void>((resolve) =>
      fixtureHttpServer.listen(0, '127.0.0.1', () => resolve()),
    );
    const fixPort = (fixtureHttpServer.address() as { port: number }).port;
    fixtureBaseUrl = `http://127.0.0.1:${fixPort}`;
  });

  afterAll(async () => {
    await closeAllHeadlessSessions();
    await server.close();
    fixtureHttpServer.closeAllConnections?.();
    await new Promise<void>((resolve) => fixtureHttpServer.close(() => resolve()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('pairs desktop controller via 6-char pair_code, enforces X-Desktop-Browser-Token & cross-user isolation, and routes live WS tab commands', async () => {
    await reqJson(baseUrl, 'POST', '/api/v1/test/reset');

    expect(DOM_IDS.NAV_DEST_BROWSER).toBe('nav-dest-browser');
    expect(DOM_IDS.BROWSER_CONTROL_WORKSPACE).toBe('browser-control-workspace');

    const aliceAuth = (await registerTestUser(baseUrl, 'bctrl_alice')).token;
    const bobAuth = (await registerTestUser(baseUrl, 'bctrl_bob')).token;

    // CORS preflight allows X-Desktop-Browser-Token
    const preflight = await fetch(`${baseUrl}/api/v1/browser/targets`, { method: 'OPTIONS' });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toContain(
      'X-Desktop-Browser-Token',
    );

    // 1. Alice creates a desktop pairing ticket
    const pairCreate = await reqJson<DesktopPairingTicketDto>(
      baseUrl,
      'POST',
      '/api/v1/browser/pair/create',
      {
        token: aliceAuth,
        body: { label: 'Alice GPUI Desktop', ttl_secs: 300 },
      },
    );
    expect(pairCreate.status).toBe(200);
    expect(pairCreate.data.pair_code).toMatch(/^[A-Z0-9]{6}$/);
    expect(pairCreate.data.desktop_token.startsWith('bctrl_')).toBe(true);
    expect(pairCreate.data.mcp_rpc_url).toContain('/api/v1/mcp/rpc');

    // 2. Desktop client claims the pair_code WITHOUT prior auth
    const pairClaim = await reqJson<DesktopPairingTicketDto>(
      baseUrl,
      'POST',
      '/api/v1/browser/pair/claim',
      {
        body: {
          pair_code: pairCreate.data.pair_code.toLowerCase(),
          controller_label: 'GPUI Native macOS Client',
        },
      },
    );
    expect(pairClaim.status).toBe(200);
    expect(pairClaim.data.desktop_token).toBe(pairCreate.data.desktop_token);

    // Re-claiming the same pair_code is blocked with 409!
    const replayClaim = await reqJson(baseUrl, 'POST', '/api/v1/browser/pair/claim', {
      body: { pair_code: pairCreate.data.pair_code },
    });
    expect(replayClaim.status).toBe(409);

    const desktopToken = pairClaim.data.desktop_token;

    // 3. Alice's live browser tab connects via /api/v1/ws and sends BrowserRegister
    const tabWs = await openWsClient(`${wsUrl}?token=${encodeURIComponent(aliceAuth)}`);
    await tabWs.waitForFrame((f) => f.type === 'AuthOk');

    tabWs.ws.send(
      JSON.stringify({
        type: 'BrowserRegister',
        payload: {
          target_id: 'tab_alice_main',
          title: 'GPUI Telegram Web — Saved Messages',
          url: `${baseUrl}/`,
          viewport: { width: 1440, height: 900 },
          theme: 'night',
          active_chat_id: 101,
          active_nav_dest: 'chats',
          allow_remote_control: true,
        },
      }),
    );

    const regFrame = await tabWs.waitForFrame((f) => f.type === 'BrowserRegistered');
    expect(regFrame.payload.target_id).toBe('tab_alice_main');
    expect(regFrame.payload.control_generation).toBe(1);

    // Attach simulated live-tab command executor on tabWs
    tabWs.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString('utf8'));
      if (msg.type === 'BrowserCommand') {
        const cmd = msg.payload;
        if (cmd.app_action === 'simulate_hang') {
          // Intentionally hold open for revoke test
          return;
        }
        const reply: BrowserCommandResult = {
          ok: true,
          command_id: cmd.command_id,
          target_id: cmd.target_id,
          generation: cmd.generation,
          action: cmd.action,
          snapshot: {
            target_id: cmd.target_id,
            url: `${baseUrl}/#chat/102`,
            title: 'GPUI Telegram Web — Engineering',
            timestamp_ms: Date.now(),
            viewport: { width: 1440, height: 900 },
            theme: 'night',
            active_chat_id: 102,
            active_nav_dest: 'chats',
            text_excerpt: `Executed ${cmd.action} (${cmd.text ?? cmd.ref ?? 'ok'})`,
            elements: [
              {
                ref: 'e1',
                selector: '#message-composer-input',
                tag: 'textarea',
                text: cmd.text ?? '',
                id: 'message-composer-input',
                value: cmd.text ?? '',
              },
            ],
          },
          data: { handled_by: 'live_tab_ws' },
          latency_ms: 3,
        };
        tabWs.ws.send(JSON.stringify({ type: 'BrowserCommandResult', payload: reply }));
      }
    });

    try {
      // 4. Desktop queries /api/v1/browser/targets using X-Desktop-Browser-Token header!
      const targetsRes = await reqJson<{
        targets: BrowserTargetDescriptor[];
        control_generation: number;
      }>(baseUrl, 'GET', '/api/v1/browser/targets', {
        desktopHeaderToken: desktopToken,
      });
      expect(targetsRes.status).toBe(200);
      expect(targetsRes.data.targets.some((t) => t.target_id === 'tab_alice_main')).toBe(true);

      // Bob CANNOT see or command Alice's tab!
      const bobTargets = await reqJson<{ targets: BrowserTargetDescriptor[] }>(
        baseUrl,
        'GET',
        '/api/v1/browser/targets',
        { token: bobAuth },
      );
      expect(bobTargets.data.targets.length).toBe(0);

      const bobHijack = await reqJson(baseUrl, 'POST', '/api/v1/browser/command', {
        token: bobAuth,
        body: { target_id: 'tab_alice_main', action: 'snapshot' },
      });
      expect(bobHijack.status).toBe(403);

      // 5. Desktop executes live command via REST Bearer `bctrl_...`
      const fillCmd = await reqJson<BrowserCommandResult>(
        baseUrl,
        'POST',
        '/api/v1/browser/command',
        {
          token: desktopToken,
          body: {
            target_id: 'tab_alice_main',
            action: 'fill',
            ref: 'e1',
            text: 'Hello from GPUI Desktop Bridge!',
          },
        },
      );
      expect(fillCmd.status).toBe(200);
      expect(fillCmd.data.ok).toBe(true);
      expect(fillCmd.data.snapshot?.active_chat_id).toBe(102);
      expect(fillCmd.data.snapshot?.elements[0]?.value).toBe('Hello from GPUI Desktop Bridge!');

      // 6. Desktop connects via WebSocket `/api/v1/browser/ws?role=controller&token=bctrl_...`
      const browserWsBase = baseUrl.replace(/^http/, 'ws');
      const ctrlWs = await openWsClient(
        `${browserWsBase}/api/v1/browser/ws?role=controller&token=${encodeURIComponent(desktopToken)}`,
      );
      await ctrlWs.waitForFrame((f) => f.type === 'AuthOk');
      const initialTargetsFrame = await ctrlWs.waitForFrame(
        (f) => f.type === 'BrowserTargetsUpdated',
      );
      expect(initialTargetsFrame.payload.targets.length).toBe(1);

      // Privilege separation: `bctrl_...` WS controller CANNOT send chat SendMessage frames!
      ctrlWs.ws.send(
        JSON.stringify({
          type: 'SendMessage',
          payload: { chat_id: 101, client_nonce: 99, text: 'Unauthorized chat attempt' },
        }),
      );
      const scopeErr = await ctrlWs.waitForFrame((f) => f.type === 'Error' && f.payload.code === 403);
      expect(scopeErr.payload.code).toBe(403);

      // WS controller CAN send BrowserCommand and receive BrowserCommandResult!
      ctrlWs.ws.send(
        JSON.stringify({
          type: 'BrowserCommand',
          payload: {
            command_id: 'ws_cmd_1',
            target_id: 'tab_alice_main',
            action: 'click',
            ref: 'e1',
          },
        }),
      );
      const wsCmdRes = await ctrlWs.waitForFrame(
        (f) => f.type === 'BrowserCommandResult' && f.payload.command_id === 'ws_cmd_1',
      );
      expect(wsCmdRes.payload.ok).toBe(true);

      // 7. Toggle allow_remote_control = false via BrowserStateReport -> commands rejected with 403!
      tabWs.ws.send(
        JSON.stringify({
          type: 'BrowserStateReport',
          payload: {
            target_id: 'tab_alice_main',
            allow_remote_control: false,
          },
        }),
      );
      await ctrlWs.waitForFrame(
        (f) =>
          f.type === 'BrowserTargetsUpdated' &&
          f.payload.targets[0]?.allow_remote_control === false,
      );

      const blockedCmd = await reqJson(baseUrl, 'POST', '/api/v1/browser/command', {
        token: desktopToken,
        body: { target_id: 'tab_alice_main', action: 'snapshot' },
      });
      expect(blockedCmd.status).toBe(403);

      // Re-enable remote control for `<10ms` emergency revoke test!
      tabWs.ws.send(
        JSON.stringify({
          type: 'BrowserStateReport',
          payload: {
            target_id: 'tab_alice_main',
            allow_remote_control: true,
          },
        }),
      );
      await ctrlWs.waitForFrame(
        (f) =>
          f.type === 'BrowserTargetsUpdated' &&
          f.payload.targets[0]?.allow_remote_control === true,
      );

      // 8. `<10ms` Emergency Revoke: aborts in-flight hanging command with 409, increments generation, revokes bctrl_ token!
      const hangingPromise = reqJson(baseUrl, 'POST', '/api/v1/browser/command', {
        token: desktopToken,
        body: {
          target_id: 'tab_alice_main',
          action: 'app_action',
          app_action: 'simulate_hang',
          timeout_ms: 15000,
        },
      });

      // Give HTTP request 40ms to reach server and register in pendingCommands
      await new Promise((r) => setTimeout(r, 40));

      const revokeRes = await reqJson(baseUrl, 'POST', '/api/v1/browser/revoke', {
        token: aliceAuth,
        body: {},
      });
      expect(revokeRes.status).toBe(200);
      expect(revokeRes.data.ok).toBe(true);
      expect(revokeRes.data.control_generation).toBe(2);
      expect(revokeRes.data.latency_sub10ms).toBe(true);
      expect(revokeRes.data.aborted_commands_count).toBe(1);

      const abortedCmd = await hangingPromise;
      expect(abortedCmd.status).toBe(409);
      expect(abortedCmd.data.error).toBe('control_revoked_by_user');

      // Live tab received BrowserControlRevoked WS broadcast
      const tabRevokedFrame = await tabWs.waitForFrame((f) => f.type === 'BrowserControlRevoked');
      expect(tabRevokedFrame.payload.control_generation).toBe(2);

      // Revoked desktopToken now immediately returns 401!
      const afterRevoke = await reqJson(baseUrl, 'GET', '/api/v1/browser/targets', {
        token: desktopToken,
      });
      expect(afterRevoke.status).toBe(401);

      // Audit log recorded ok, rejected, and revoked events!
      const auditRes = await reqJson(baseUrl, 'GET', '/api/v1/browser/audit?limit=20', {
        token: aliceAuth,
      });
      expect(auditRes.status).toBe(200);
      const statuses = new Set(auditRes.data.entries.map((e: any) => e.status));
      expect(statuses.has('ok')).toBe(true);
      expect(statuses.has('rejected')).toBe(true);
      expect(statuses.has('revoked')).toBe(true);

      ctrlWs.ws.close();
    } finally {
      tabWs.ws.close();
    }
  });

  it('drives real Headless Chromium CDP (`/usr/lib/chromium/chromium`) AND deterministic `http_dom_fallback` sessions end-to-end', async () => {
    const aliceAuth = (await registerTestUser(baseUrl, 'bctrl_cdp_alice')).token;

    //Unsafe URL schemes (file://, javascript:) must be rejected with 400!
    const unsafeOpen = await reqJson(baseUrl, 'POST', '/api/v1/browser/headless/open', {
      token: aliceAuth,
      body: { url: 'file:///etc/passwd' },
    });
    expect(unsafeOpen.status).toBe(400);

    // 1. Real Chromium CDP session (`/usr/lib/chromium/chromium` is installed in VM)
    const openCdp = await reqJson(baseUrl, 'POST', '/api/v1/browser/headless/open', {
      token: aliceAuth,
      body: {
        url: fixtureBaseUrl,
        viewport: { width: 1280, height: 800 },
      },
    });
    expect(openCdp.status).toBe(200);
    expect(openCdp.data.ok).toBe(true);
    expect(openCdp.data.session.backend).toBe('chromium_cdp');
    expect(openCdp.data.snapshot.title).toBe('GPUI Automation Fixture');
    expect(openCdp.data.snapshot.elements.length).toBeGreaterThanOrEqual(3);

    const cdpSessionId = openCdp.data.session.session_id as string;
    const inputRef = openCdp.data.snapshot.elements.find((e: any) => e.id === 'search-box')?.ref;
    const btnRef = openCdp.data.snapshot.elements.find((e: any) => e.id === 'run-btn')?.ref;
    expect(inputRef).toBeTruthy();
    expect(btnRef).toBeTruthy();

    try {
      // Fill #search-box by ref (`e1`)
      const fillRes = await reqJson<BrowserCommandResult>(
        baseUrl,
        'POST',
        `/api/v1/browser/headless/${cdpSessionId}/action`,
        {
          token: aliceAuth,
          body: { action: 'fill', ref: inputRef, text: 'CDP Real Query 42' },
        },
      );
      expect(fillRes.status).toBe(200);
      expect(
        fillRes.data.snapshot?.elements.find((e) => e.id === 'search-box')?.value,
      ).toBe('CDP Real Query 42');

      // Click #run-btn -> onclick handler mutates #status-banner text in real Chromium DOM!
      const clickRes = await reqJson<BrowserCommandResult>(
        baseUrl,
        'POST',
        `/api/v1/browser/headless/${cdpSessionId}/action`,
        {
          token: aliceAuth,
          body: { action: 'click', ref: btnRef },
        },
      );
      expect(clickRes.status).toBe(200);
      expect(clickRes.data.snapshot?.text_excerpt).toContain('Submitted: CDP Real Query 42');

      // Press Enter inside #search-box -> keydown listener updates #status-banner!
      const pressRes = await reqJson<BrowserCommandResult>(
        baseUrl,
        'POST',
        `/api/v1/browser/headless/${cdpSessionId}/action`,
        {
          token: aliceAuth,
          body: { action: 'press', ref: inputRef, key: 'Enter' },
        },
      );
      expect(pressRes.status).toBe(200);
      expect(pressRes.data.snapshot?.text_excerpt).toContain('EnterPressed: CDP Real Query 42');

      // Scroll & evaluate_query
      const scrollRes = await reqJson<BrowserCommandResult>(
        baseUrl,
        'POST',
        `/api/v1/browser/headless/${cdpSessionId}/action`,
        {
          token: aliceAuth,
          body: { action: 'scroll', delta_y: 420 },
        },
      );
      expect(scrollRes.status).toBe(200);

      const evalRes = await reqJson<BrowserCommandResult>(
        baseUrl,
        'POST',
        `/api/v1/browser/headless/${cdpSessionId}/action`,
        {
          token: aliceAuth,
          body: { action: 'evaluate_query', text: 'window.scrollY' },
        },
      );
      expect(evalRes.status).toBe(200);
      expect(Number(evalRes.data.data?.value)).toBeGreaterThanOrEqual(400);

      // Real PNG screenshot via CDP Page.captureScreenshot!
      const shotRes = await reqJson(
        baseUrl,
        'GET',
        `/api/v1/browser/headless/${cdpSessionId}/screenshot`,
        { token: aliceAuth },
      );
      expect(shotRes.status).toBe(200);
      expect(shotRes.data.mime_type).toBe('image/png');
      expect(shotRes.data.screenshot_data_url.startsWith('data:image/png;base64,')).toBe(true);
      const pngBytes = Buffer.from(
        shotRes.data.screenshot_data_url.slice('data:image/png;base64,'.length),
        'base64',
      );
      // Check PNG magic header: 89 50 4E 47
      expect(pngBytes[0]).toBe(0x89);
      expect(pngBytes[1]).toBe(0x50);
      expect(pngBytes[2]).toBe(0x4e);
      expect(pngBytes[3]).toBe(0x47);
    } finally {
      const closeRes = await reqJson(
        baseUrl,
        'POST',
        `/api/v1/browser/headless/${cdpSessionId}/close`,
        { token: aliceAuth, body: {} },
      );
      expect(closeRes.status).toBe(200);
    }

    // 2. Fallback SVG driver is permanently purged -> prefer_fallback MUST return 400 unsupported_backend!
    const openFallback = await reqJson(baseUrl, 'POST', '/api/v1/browser/headless/open', {
      token: aliceAuth,
      body: {
        url: fixtureBaseUrl,
        prefer_fallback: true,
      },
    });
    expect(openFallback.status).toBe(400);
    expect(openFallback.data.error).toBe('unsupported_backend');

    const openExplicitFallback = await reqJson(baseUrl, 'POST', '/api/v1/browser/headless/open', {
      token: aliceAuth,
      body: {
        url: fixtureBaseUrl,
        backend: 'http_dom_fallback',
      },
    });
    expect(openExplicitFallback.status).toBe(400);
    expect(openExplicitFallback.data.error).toBe('unsupported_backend');
  }, 30000);

  it('implements MCP JSON-RPC 2.0 (`/api/v1/mcp/manifest`, `/api/v1/mcp/rpc`) and Web UI `/api/v1/mcp/invoke` browser_* tools over real Chromium CDP', async () => {
    const aliceAuth = (await registerTestUser(baseUrl, 'bctrl_mcp_alice')).token;

    // 1. Manifest discovery
    const manifest = await reqJson(baseUrl, 'GET', '/api/v1/mcp/manifest', { token: aliceAuth });
    expect(manifest.status).toBe(200);
    expect(manifest.data.name).toBe('gpui-telegram-web-browser-bridge');
    expect(manifest.data.tools.length).toBe(9);

    // 2. MCP JSON-RPC 2.0: initialize, ping, tools/list
    const initRpc = await reqJson<McpJsonRpcResponse<any>>(baseUrl, 'POST', '/api/v1/mcp/rpc', {
      token: aliceAuth,
      body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    });
    expect(initRpc.status).toBe(200);
    expect(initRpc.data.result.protocolVersion).toBe('2024-11-05');
    expect(initRpc.data.result.serverInfo.name).toBe('gpui-telegram-web-browser-bridge');

    const pingRpc = await reqJson<McpJsonRpcResponse>(baseUrl, 'POST', '/api/v1/mcp/rpc', {
      token: aliceAuth,
      body: { jsonrpc: '2.0', id: 2, method: 'ping' },
    });
    expect(pingRpc.data.result).toEqual({});

    const listRpc = await reqJson<McpJsonRpcResponse<any>>(baseUrl, 'POST', '/api/v1/mcp/rpc', {
      token: aliceAuth,
      body: { jsonrpc: '2.0', id: 3, method: 'tools/list' },
    });
    const toolNames = listRpc.data.result.tools.map((t: any) => t.name);
    expect(toolNames).toEqual([
      'browser_list_targets',
      'browser_tab_command',
      'browser_headless_open',
      'browser_headless_action',
      'browser_headless_screenshot',
      'browser_snapshot',
      'browser_act',
      'browser_open_headless',
      'browser_headless_close',
    ]);

    // Fresh user with zero active targets/pairings receives empty /api/v1/mcp/tools (ZERO fake mcp_filesystem!)
    const freshDock = await reqJson(baseUrl, 'GET', '/api/v1/mcp/tools', { token: aliceAuth });
    expect(freshDock.status).toBe(200);
    expect(freshDock.data.tools).toEqual([]);

    // 3. MCP JSON-RPC 2.0 `tools/call`: open REAL Chromium CDP -> action -> real PNG screenshot -> close
    const openCall = await reqJson<McpJsonRpcResponse<any>>(baseUrl, 'POST', '/api/v1/mcp/rpc', {
      token: aliceAuth,
      body: {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'browser_headless_open',
          arguments: {
            url: 'data:text/html,<title>MCP Inline Page</title><input id="mcp-in" value="init"/><button id="mcp-btn">Run</button>',
          },
        },
      },
    });
    expect(openCall.data.result.isError).toBe(false);
    const openedParsed = JSON.parse(openCall.data.result.content[0].text);
    expect(openedParsed.session.backend).toBe('chromium_cdp');
    expect(openedParsed.snapshot.title).toBe('MCP Inline Page');
    const mcpSid = openedParsed.session.session_id as string;

    try {
      // With an active headless session, Web UI `/api/v1/mcp/tools` truthfully exposes browser_* tools!
      const activeDock = await reqJson(baseUrl, 'GET', '/api/v1/mcp/tools', { token: aliceAuth });
      expect(activeDock.status).toBe(200);
      expect(activeDock.data.tools.some((t: any) => t.name === 'browser_list_targets')).toBe(true);

      const actCall = await reqJson<McpJsonRpcResponse<any>>(baseUrl, 'POST', '/api/v1/mcp/rpc', {
        token: aliceAuth,
        body: {
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: {
            name: 'browser_headless_action',
            arguments: {
              session_id: mcpSid,
              action: 'fill',
              ref: 'e1',
              text: 'Updated via MCP JSON-RPC',
            },
          },
        },
      });
      expect(actCall.data.result.isError).toBe(false);
      const actParsed = JSON.parse(actCall.data.result.content[0].text);
      expect(actParsed.snapshot.elements[0].value).toBe('Updated via MCP JSON-RPC');

      const shotCall = await reqJson<McpJsonRpcResponse<any>>(baseUrl, 'POST', '/api/v1/mcp/rpc', {
        token: aliceAuth,
        body: {
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/call',
          params: {
            name: 'browser_headless_screenshot',
            arguments: { session_id: mcpSid },
          },
        },
      });
      expect(shotCall.data.result.isError).toBe(false);
      expect(shotCall.data.result.content.some((c: any) => c.type === 'text')).toBe(true);
      const imgItem = shotCall.data.result.content.find((c: any) => c.type === 'image');
      expect(imgItem).toBeDefined();
      expect(imgItem.mimeType).toBe('image/png');
      const pngHeader = Buffer.from(imgItem.data, 'base64').subarray(0, 4);
      expect(Array.from(pngHeader)).toEqual([0x89, 0x50, 0x4e, 0x47]);
    } finally {
      const closeCall = await reqJson<McpJsonRpcResponse<any>>(baseUrl, 'POST', '/api/v1/mcp/rpc', {
        token: aliceAuth,
        body: {
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: {
            name: 'browser_headless_close',
            arguments: { session_id: mcpSid },
          },
        },
      });
      expect(closeCall.data.result.isError).toBe(false);
    }

    // Unknown JSON-RPC method returns -32601
    const unknownRpc = await reqJson<McpJsonRpcResponse>(baseUrl, 'POST', '/api/v1/mcp/rpc', {
      token: aliceAuth,
      body: { jsonrpc: '2.0', id: 8, method: 'nonexistent/method' },
    });
    expect(unknownRpc.data.error?.code).toBe(-32601);

    // 4. Web UI MCP Tools Invoke (`/api/v1/mcp/invoke`)
    const dockInvoke = await reqJson(baseUrl, 'POST', '/api/v1/mcp/invoke', {
      token: aliceAuth,
      body: { tool_name: 'browser_list_targets', arguments: {} },
    });
    expect(dockInvoke.status).toBe(200);
    expect(dockInvoke.data.status).toBe('completed');
    expect(Array.isArray(dockInvoke.data.output.targets)).toBe(true);
  }, 30000);
});
