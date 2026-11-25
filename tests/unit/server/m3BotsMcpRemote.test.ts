import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createTelegramServer, type TelegramServerInstance } from '../../../apps/server/src/index.js';
import { sha256Hex } from '../../../apps/server/src/utils/crypto.js';

async function apiJson(
  baseUrl: string,
  method: string,
  urlPath: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body:
      opts.body !== undefined
        ? typeof opts.body === 'string'
          ? opts.body
          : JSON.stringify(opts.body)
        : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, headers: res.headers, data, rawText: text };
}

async function registerUser(baseUrl: string, username: string) {
  const res = await apiJson(baseUrl, 'POST', '/api/v1/auth/register', {
    body: { username, password: 'TestPassword123!', first_name: username },
  });
  expect(res.status).toBe(201);
  return { token: res.data.token as string, userId: Number(res.data.user.user_id), username };
}

describe('M3 Domain 2 — Decoupled MiniApps & WebMCP, UU-Parity Remote Assist, Official OAuth 2.1 MCP & Zero-Fake Workspace', () => {
  let srv: TelegramServerInstance;
  let baseUrl = '';
  let wsUrl = '';
  let tmpDir = '';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabushi-m3-d2-'));
    srv = createTelegramServer({
      port: 0,
      host: '127.0.0.1',
      dataDir: tmpDir,
      enableTestReset: true,
    });
    const started = await srv.start();
    baseUrl = started.baseUrl;
    wsUrl = started.wsUrl;
  });

  afterAll(async () => {
    await srv.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enforces decoupled MiniApps, Bot permissions, safe web_url validation, WebMCP WS relay & honest /js/telegram-web-app.js SDK', async () => {
    const alice = await registerUser(baseUrl, 'm3_mini_alice');
    const bob = await registerUser(baseUrl, 'm3_mini_bob');

    // 1. Official WebApp v8.0 + WebMCP SDK has ZERO fake Alice/1001 initData & targets /storage!
    const sdkRes = await fetch(`${baseUrl}/js/telegram-web-app.js`);
    expect(sdkRes.status).toBe(200);
    const sdkText = await sdkRes.text();
    expect(sdkText).not.toContain('Alice');
    expect(sdkText).not.toContain('1001');
    expect(sdkText).toContain('navigator');
    expect(sdkText).toContain('modelContext');
    expect(sdkText).toContain('__GPUI_WEBMCP__');
    expect(sdkText).toContain('/storage');

    // 2. Create custom bot + verify Bot HTTP API 404 on unknown method & 403 when blocked
    const createdBot = await apiJson(baseUrl, 'POST', '/api/v1/bots', {
      token: alice.token,
      body: { display_name: 'Shop Bot', username: 'shop_m3_test_bot' },
    });
    expect(createdBot.status).toBe(201);
    const botId = createdBot.data.bot.bot_user_id as number;
    const botToken = createdBot.data.bot_token as string;
    expect(createdBot.data.bot.avatar_shape).toBeTruthy();

    const unkMethod = await apiJson(baseUrl, 'POST', `/bot${botToken}/unknownMethodName`, { body: {} });
    expect(unkMethod.status).toBe(404);
    expect(unkMethod.data.ok).toBe(false);

    // Bob has NOT started chat or allowed DM -> Bot sendMessage to Bob MUST return 403!
    const blockedDm = await apiJson(baseUrl, 'POST', `/bot${botToken}/sendMessage`, {
      body: { chat_id: bob.userId, text: 'Unsolicited spam' },
    });
    expect(blockedDm.status).toBe(403);

    // Bob allows write access -> Bot sendMessage succeeds -> Bob blocks bot -> Bot sendMessage 403!
    expect((await apiJson(baseUrl, 'POST', `/api/v1/bots/${botId}/allow-send-message`, { token: bob.token })).status).toBe(200);
    expect((await apiJson(baseUrl, 'POST', `/bot${botToken}/sendMessage`, { body: { chat_id: bob.userId, text: 'Allowed update' } })).status).toBe(200);
    expect((await apiJson(baseUrl, 'POST', `/api/v1/bots/${botId}/block`, { token: bob.token, body: {} })).status).toBe(200);
    expect((await apiJson(baseUrl, 'POST', `/bot${botToken}/sendMessage`, { body: { chat_id: bob.userId, text: 'Blocked now' } })).status).toBe(403);

    // 3. Mini App web_url XSS/SSRF validation
    for (const badUrl of ['javascript:alert(1)', 'data:text/html,hi', '//evil.test/x', '/../../etc/passwd', 'http://evil.test/app']) {
      const badApp = await apiJson(baseUrl, 'POST', '/api/v1/miniapps', {
        token: alice.token,
        body: { bot_user_id: botId, short_name: 'badapp', web_url: badUrl },
      });
      expect(badApp.status).toBe(400);
    }

    // Create valid Mini App, install, launch, check /recent, and test WebMCP WS relay + anti-hallucination warning!
    const goodApp = await apiJson(baseUrl, 'POST', '/api/v1/miniapps', {
      token: alice.token,
      body: { bot_user_id: botId, short_name: 'shopfront', title: 'Shop Front' },
    });
    expect(goodApp.status).toBe(201);
    expect(goodApp.data.install_count).toBe(0);

    const inst = await apiJson(baseUrl, 'POST', '/api/v1/miniapps/shop_m3_test_bot/shopfront/install', {
      token: alice.token,
      body: {},
    });
    expect(inst.status).toBe(200);
    expect(inst.data.app.install_count).toBe(1);

    const launched = await apiJson(baseUrl, 'POST', '/api/v1/miniapps/shop_m3_test_bot/shopfront/launch', {
      token: alice.token,
      body: {},
    });
    expect(launched.status).toBe(200);
    const recent = await apiJson(baseUrl, 'GET', '/api/v1/miniapps/recent', { token: alice.token });
    expect(recent.data.apps.some((a: any) => a.short_name === 'shopfront')).toBe(true);

    // WebMCP WS relay with page error -> triggers anti-hallucination warning!
    const aliceWs = new WebSocket(`${wsUrl}?token=${encodeURIComponent(alice.token)}`);
    await new Promise<void>((resolve, reject) => {
      aliceWs.once('error', reject);
      aliceWs.on('message', (raw) => {
        const frame = JSON.parse(raw.toString('utf8'));
        if (frame.type === 'AuthOk') {
          resolve();
        } else if (frame.type === 'Update' && frame.payload?.type === 'MiniAppWebMcpCommand') {
          aliceWs.send(
            JSON.stringify({
              type: 'MiniAppWebMcpResult',
              payload: {
                request_id: frame.payload.data.request_id,
                ok: true,
                result: { clicked: true },
                error: null,
                tools: [],
                state_summary: { ok: false, visible_toast: 'Checkout failed: payment declined' },
                control_mode: 'ai_controlling',
              },
            }),
          );
        }
      });
    });

    try {
      const actionRes = await apiJson(baseUrl, 'POST', '/api/v1/miniapps/shop_m3_test_bot/shopfront/action', {
        token: alice.token,
        body: { action_type: 'webmcp_get_state', timeout_ms: 4000 },
      });
      expect(actionRes.status).toBe(200);
      expect(actionRes.data.page_error).toBeDefined();
      expect(String(actionRes.data.warning)).toContain('Do NOT claim Mini App actions succeeded');
    } finally {
      aliceWs.close();
    }
  });

  it('implements UU-Parity Remote Assist (9-digit ID, lockout, relay token) and real Local Computer poll/complete bridge', async () => {
    const host = await registerUser(baseUrl, 'm3_assist_host');
    const guest = await registerUser(baseUrl, 'm3_assist_guest');

    // 1. Remote Assist info -> custom code validation -> 5 failures trigger 429 -> reset-code -> start -> WebRTC signal
    const info = await apiJson(baseUrl, 'GET', '/api/v1/remote/assist/info', { token: host.token });
    expect(info.status).toBe(200);
    expect(info.data.assist_id).toMatch(/^\d{9}$/);
    expect(info.data.current_code).toMatch(/^[A-Za-z0-9]{8}$/);

    const weakCode = await apiJson(baseUrl, 'POST', '/api/v1/remote/assist/set-code', {
      token: host.token,
      body: { code: '12345678' }, // digits only -> invalid!
    });
    expect(weakCode.status).toBe(400);

    const strongCode = await apiJson(baseUrl, 'POST', '/api/v1/remote/assist/set-code', {
      token: host.token,
      body: { code: 'AbCd1234' },
    });
    expect(strongCode.status).toBe(200);
    expect(strongCode.data.code_mode).toBe('custom');
    expect(strongCode.data.current_code).toBeNull();

    for (let i = 0; i < 4; i++) {
      const fail = await apiJson(baseUrl, 'POST', '/api/v1/remote/assist/start', {
        token: guest.token,
        body: { assist_id: info.data.assist_id, access_code: 'Wrong999' },
      });
      expect(fail.status).toBe(401);
    }
    const lockout = await apiJson(baseUrl, 'POST', '/api/v1/remote/assist/start', {
      token: guest.token,
      body: { assist_id: info.data.assist_id, access_code: 'Wrong999' },
    });
    expect(lockout.status).toBe(429);

    const reset = await apiJson(baseUrl, 'POST', '/api/v1/remote/assist/reset-code', {
      token: host.token,
      body: {},
    });
    expect(reset.status).toBe(200);

    const started = await apiJson(baseUrl, 'POST', '/api/v1/remote/assist/start', {
      token: guest.token,
      body: { assist_id: info.data.assist_id, access_code: reset.data.current_code },
    });
    expect(started.status).toBe(200);
    expect(String(started.data.temp_relay_token).startsWith('fbrelay_')).toBe(true);

    // WebRTC relay token REQUIRES session_id!
    const missingSid = await apiJson(baseUrl, 'POST', '/api/v1/remote/webrtc/signal', {
      token: started.data.temp_relay_token,
      body: { sender_device_id: 'guest_1', frame: { type: 'offer' } },
    });
    expect(missingSid.status).toBe(400);

    const okSig = await apiJson(baseUrl, 'POST', '/api/v1/remote/webrtc/signal', {
      token: started.data.temp_relay_token,
      body: {
        sender_device_id: 'guest_1',
        session_id: started.data.session_id,
        frame: { type: 'offer', sdp: 'v=0' },
      },
    });
    expect(okSig.status).toBe(200);

    // Disabling allow_assist disconnects guest session
    await apiJson(baseUrl, 'POST', '/api/v1/remote/assist/allow', {
      token: host.token,
      body: { allow_assist: false },
    });
    const afterDisallow = await apiJson(baseUrl, 'GET', '/api/v1/remote/sessions', { token: host.token });
    expect(afterDisallow.data.sessions).toEqual([]);

    // 2. Local Computer Register + Poll + Execute + Complete round-trip!
    const regNode = await apiJson(baseUrl, 'POST', '/api/v1/computers/local/register', {
      token: host.token,
      body: {
        device_id: 'workstation_1',
        display_name: 'Linux Workstation',
        os_name: 'Linux',
        run_policy: 'always_allow_authorized',
      },
    });
    expect(regNode.status).toBe(201);
    const nodeId = regNode.data.node_id as string;

    const pollPromise = apiJson(baseUrl, 'POST', '/api/v1/computers/local/poll', {
      token: host.token,
      body: { node_id: nodeId, timeout_ms: 4000 },
    });
    await new Promise((r) => setTimeout(r, 30));
    const execPromise = apiJson(baseUrl, 'POST', `/api/v1/computers/${encodeURIComponent(nodeId)}/commands`, {
      token: host.token,
      body: { operation: { op: 'system_info' }, timeout_ms: 4000 },
    });

    const polled = await pollPromise;
    expect(polled.status).toBe(200);
    expect(polled.data.commands.length).toBe(1);
    const cmdId = polled.data.commands[0].command_id as string;

    const completeRes = await apiJson(baseUrl, 'POST', `/api/v1/computers/commands/${cmdId}/complete`, {
      token: host.token,
      body: { ok: true, hostname: 'linux-box', cpu_cores: 8 },
    });
    expect(completeRes.status).toBe(200);

    const executed = await execPromise;
    expect(executed.status).toBe(200);
    expect(executed.data.result.hostname).toBe('linux-box');

    // Cloud node starts offline -> command returns 503 no_host_online!
    const cloudNode = await apiJson(baseUrl, 'POST', '/api/v1/computers/cloud', {
      token: host.token,
      body: { display_name: 'Prod SSH', host: '198.51.100.10' },
    });
    expect(cloudNode.status).toBe(201);
    expect(cloudNode.data.online).toBe(false);
    const offlineCmd = await apiJson(
      baseUrl,
      'POST',
      `/api/v1/computers/${encodeURIComponent(cloudNode.data.node_id)}/commands`,
      { token: host.token, body: { operation: { op: 'system_info' } } },
    );
    expect(offlineCmd.status).toBe(503);
  });

  it('runs full Official OAuth 2.1 + PKCE S256 + Rotating Refresh + 31-Tool /mcp + Kill Switch 410 (preserving grants until DELETE)', async () => {
    const user = await registerUser(baseUrl, 'm3_mcp_user');

    // 1. RFC 9728 / RFC 8414 discovery
    const prMeta = await apiJson(baseUrl, 'GET', '/.well-known/oauth-protected-resource');
    expect(prMeta.status).toBe(200);
    expect(prMeta.data.resource).toBe(`${baseUrl}/mcp`);

    const asMeta = await apiJson(baseUrl, 'GET', '/.well-known/oauth-authorization-server');
    expect(asMeta.status).toBe(200);
    expect(asMeta.data.code_challenge_methods_supported).toEqual(['S256']);

    // 2. Dynamic Client Registration (SSRF & redirect URI hardening)
    const badReg = await apiJson(baseUrl, 'POST', '/oauth/register', {
      body: { client_name: 'Bad', redirect_uris: ['http://evil.example/cb'] },
    });
    expect(badReg.status).toBe(400);

    const reg = await apiJson(baseUrl, 'POST', '/oauth/register', {
      body: { client_name: 'Claude Desktop', redirect_uris: ['http://127.0.0.1:9876/cb'] },
    });
    expect(reg.status).toBe(201);
    const clientId = reg.data.client_id as string;

    // Missing PKCE -> direct HTTP 400 (NOT 302!)
    const noPkce = await apiJson(
      baseUrl,
      'GET',
      `/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent('http://127.0.0.1:9876/cb')}&response_type=code&scope=devices:read`,
    );
    expect(noPkce.status).toBe(400);

    // Full PKCE S256 authorize -> login -> approve -> code -> token
    const verifier = crypto.randomBytes(36).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

    const authPage = await apiJson(
      baseUrl,
      'GET',
      `/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent('http://127.0.0.1:9876/cb')}&response_type=code&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256&scope=${encodeURIComponent('devices:read chats:read')}&state=st_123&resource=${encodeURIComponent(`${baseUrl}/mcp`)}`,
    );
    expect(authPage.status).toBe(200);
    const oauthCookie = (authPage.headers.get('set-cookie') ?? '').split(';')[0]!;
    const txId = /name="tx_id" value="([^"]+)"/.exec(authPage.rawText)![1]!;
    const csrf1 = /name="csrf_token" value="([^"]+)"/.exec(authPage.rawText)![1]!;

    const loginRes = await apiJson(baseUrl, 'POST', '/oauth/authorize/login', {
      headers: { Cookie: oauthCookie, Accept: 'application/json' },
      body: { tx_id: txId, csrf_token: csrf1, username: user.username, password: 'TestPassword123!' },
    });
    expect(loginRes.status).toBe(200);
    const csrf2 = loginRes.data.csrf_token as string;

    const approveRes = await apiJson(baseUrl, 'POST', '/oauth/authorize/approve', {
      headers: { Cookie: oauthCookie },
      body: { tx_id: txId, csrf_token: csrf2, decision: 'approve' },
    });
    expect(approveRes.status).toBe(302);
    const loc = new URL(approveRes.headers.get('location')!);
    const authCode = loc.searchParams.get('code')!;
    expect(loc.searchParams.get('state')).toBe('st_123');

    const tokRes = await apiJson(baseUrl, 'POST', '/oauth/token', {
      body: {
        grant_type: 'authorization_code',
        code: authCode,
        client_id: clientId,
        redirect_uri: 'http://127.0.0.1:9876/cb',
        code_verifier: verifier,
      },
    });
    expect(tokRes.status).toBe(200);
    const accessToken = tokRes.data.access_token as string;
    const refreshToken1 = tokRes.data.refresh_token as string;

    // 3. /mcp protocol checks: 401 without token, initialize, 31 tools, 3 resources, 403 insufficient_scope, 404 unknown tool
    const noAuthMcp = await apiJson(baseUrl, 'POST', '/mcp', {
      body: { jsonrpc: '2.0', id: 1, method: 'ping' },
    });
    expect(noAuthMcp.status).toBe(401);
    expect(noAuthMcp.headers.get('www-authenticate')).toContain('oauth-protected-resource');

    const initMcp = await apiJson(baseUrl, 'POST', '/mcp', {
      token: accessToken,
      body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    });
    expect(initMcp.status).toBe(200);
    const mcpSessionId = initMcp.headers.get('mcp-session-id')!;
    expect(mcpSessionId.startsWith('mcp_sess_')).toBe(true);

    const listTools = await apiJson(baseUrl, 'POST', '/mcp', {
      token: accessToken,
      headers: { 'Mcp-Session-Id': mcpSessionId },
      body: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    });
    expect(listTools.status).toBe(200);
    expect(listTools.data.result.tools.length).toBe(31);

    const listRes = await apiJson(baseUrl, 'POST', '/mcp', {
      token: accessToken,
      headers: { 'Mcp-Session-Id': mcpSessionId },
      body: { jsonrpc: '2.0', id: 3, method: 'resources/list' },
    });
    expect(listRes.data.result.resources.length).toBe(3);

    // Scope enforcement: send_message requires messaging:write -> 403 insufficient_scope + audit log entry!
    const deniedTool = await apiJson(baseUrl, 'POST', '/mcp', {
      token: accessToken,
      headers: { 'Mcp-Session-Id': mcpSessionId },
      body: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'send_message', arguments: { chat_id: 1, text: 'hi' } } },
    });
    expect(deniedTool.status).toBe(403);
    expect(deniedTool.headers.get('www-authenticate')).toContain('insufficient_scope');

    // Permitted tool: list_devices -> 200
    const okTool = await apiJson(baseUrl, 'POST', '/mcp', {
      token: accessToken,
      headers: { 'Mcp-Session-Id': mcpSessionId },
      body: { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'list_devices', arguments: {} } },
    });
    expect(okTool.status).toBe(200);

    const auditRes = await apiJson(baseUrl, 'GET', '/api/v1/mcp/audit', { token: user.token });
    expect(auditRes.status).toBe(200);
    expect(auditRes.data.entries.length).toBeGreaterThanOrEqual(2);

    // 4. Emergency Kill Switch (`disconnect-all`) -> `/mcp` returns 410 Gone, while grants STAY active until explicit DELETE!
    const killRes = await apiJson(baseUrl, 'POST', '/api/v1/remote/sessions/disconnect-all', {
      token: user.token,
    });
    expect(killRes.status).toBe(200);
    expect(killRes.data.disconnected_count).toBeGreaterThanOrEqual(1);

    const afterKillMcp = await apiJson(baseUrl, 'POST', '/mcp', {
      token: accessToken,
      headers: { 'Mcp-Session-Id': mcpSessionId },
      body: { jsonrpc: '2.0', id: 6, method: 'ping' },
    });
    expect(afterKillMcp.status).toBe(410);

    const grantsAfterKill = await apiJson(baseUrl, 'GET', '/api/v1/mcp/grants', { token: user.token });
    expect(grantsAfterKill.status).toBe(200);
    expect(grantsAfterKill.data.grants.length).toBe(1);
    const familyId = grantsAfterKill.data.grants[0].family_id as string;

    // Refresh token rotation + replay attack revokes family!
    const rot = await apiJson(baseUrl, 'POST', '/oauth/token', {
      body: { grant_type: 'refresh_token', refresh_token: refreshToken1, client_id: clientId },
    });
    expect(rot.status).toBe(200);
    const replay = await apiJson(baseUrl, 'POST', '/oauth/token', {
      body: { grant_type: 'refresh_token', refresh_token: refreshToken1, client_id: clientId },
    });
    expect(replay.status).toBe(400);

    // After replay revocation, the whole family is revoked -> grants list is empty and new token returns 401!
    const grantsAfterReplay = await apiJson(baseUrl, 'GET', '/api/v1/mcp/grants', { token: user.token });
    expect(grantsAfterReplay.data.grants.find((g: any) => g.family_id === familyId)).toBeUndefined();
    const revokedCall = await apiJson(baseUrl, 'POST', '/mcp', {
      token: rot.data.access_token,
      body: { jsonrpc: '2.0', id: 7, method: 'ping' },
    });
    expect(revokedCall.status).toBe(401);
  });

  it('enforces zero fake data across Workspace (Tailnet, Talk, Tasks, MCP Dock) and gates Fabushi VIP behind verified redeem/payment', async () => {
    const user = await registerUser(baseUrl, 'm3_truth_user');

    // Tailnet honest disconnected state (ZERO 100.64.0.1!)
    const tailnet = await apiJson(baseUrl, 'GET', '/api/v1/tailnet/status', { token: user.token });
    expect(tailnet.status).toBe(200);
    expect(tailnet.data.connected).toBe(false);
    expect(tailnet.data.self_peer.ipv4).toBe('');

    // Talk Mode honest 503 (ZERO "Heard ..." echo!)
    const talkAudio = await apiJson(baseUrl, 'POST', '/api/v1/talk/audio', {
      token: user.token,
      body: { transcript: 'hello' },
    });
    expect(talkAudio.status).toBe(503);
    expect(talkAudio.data.error).toBe('talk_pipeline_unconfigured');

    // Tasks honest progress: 0 & logs: [] (ZERO synthetic 35/40 progress!)
    const task = await apiJson(baseUrl, 'POST', '/api/v1/tasks', {
      token: user.token,
      body: { title: 'Truthful Task', state: 'running' },
    });
    expect(task.status).toBe(201);
    expect(task.data.progress).toBe(0);
    expect(task.data.logs).toEqual([]);

    // MCP server registration honest disconnected & 0 tools
    const mcpSrv = await apiJson(baseUrl, 'POST', '/api/v1/mcp/servers', {
      token: user.token,
      body: { name: 'Custom MCP', transport: 'stdio', endpoint: 'npx server' },
    });
    expect(mcpSrv.status).toBe(201);
    expect(mcpSrv.data.status).toBe('disconnected');
    expect(mcpSrv.data.tools_count).toBe(0);

    // Fabushi MiniApp VIP requires verified order/redeem code (402 otherwise), and AI chat returns 503 when unconfigured!
    const vipNoPay = await apiJson(baseUrl, 'POST', '/api/v1/fabushi-miniapp/membership', {
      token: user.token,
      body: { plan: 'yearly' },
    });
    expect(vipNoPay.status).toBe(402);

    const rawCode = 'FABUSHI-VIP-TEST-2026';
    srv.db
      .prepare(
        `INSERT INTO redeem_codes (code_hash, kind, vip_plan, vip_days, stars_amount, created_at_ms)
         VALUES (?, 'vip', 'yearly', 365, 0, ?)`,
      )
      .run(sha256Hex(rawCode), Date.now());
    const vipPaid = await apiJson(baseUrl, 'POST', '/api/v1/fabushi-miniapp/membership', {
      token: user.token,
      body: { redeem_code: rawCode },
    });
    expect(vipPaid.status).toBe(200);
    expect(vipPaid.data.profile.is_vip).toBe(true);

    const aiChat = await apiJson(baseUrl, 'POST', '/api/v1/fabushi-miniapp/ai-chat', {
      token: user.token,
      body: { message: '什么是般若？' },
    });
    expect(aiChat.status).toBe(503);
    expect(aiChat.data.error).toBe('provider_not_configured');

    // Fabushi MiniApp non-scalar & Date RangeError validation returns clean 400 (ZERO 500s!)
    expect(
      (
        await apiJson(baseUrl, 'POST', '/api/v1/fabushi-miniapp/practice/session', {
          token: user.token,
          body: { sutra: '心经', start_time_ms: 1e20 },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await apiJson(baseUrl, 'PUT', '/api/v1/fabushi-miniapp/profile', {
          token: user.token,
          body: { bio: { bad: true } },
        })
      ).status,
    ).toBe(400);
  });

  it('enforces Domain 2 security hardening: VETO-1 request_human_takeover, confidential OAuth refresh secret, bot visibility/redaction, wallet chat RBAC & CloudStorage quota', async () => {
    const alice = await registerUser(baseUrl, 'm3_d2_alice');
    const bob = await registerUser(baseUrl, 'm3_d2_bob');

    // 1. Private bot visibility & redaction + PATCH field whitelist (cannot escalate is_official or inject javascript:)
    const privBot = await apiJson(baseUrl, 'POST', '/api/v1/bots', {
      token: alice.token,
      body: { display_name: 'Alice Secret Bot', username: 'alice_sec_d2_bot', description: 'Private' },
    });
    expect(privBot.status).toBe(201);
    const privBotId = privBot.data.bot.bot_user_id as number;

    const patchPersona = await apiJson(baseUrl, 'PATCH', `/api/v1/bots/${privBotId}`, {
      token: alice.token,
      body: { ai_persona: 'TOP_SECRET_PERSONA', display_name: 'Alice Renamed Bot' },
    });
    expect(patchPersona.status).toBe(200);
    expect(patchPersona.data.ai_persona).toBe('TOP_SECRET_PERSONA');

    // Escalating is_official -> 403, unsafe menu_button_url -> 400
    expect(
      (
        await apiJson(baseUrl, 'PATCH', `/api/v1/bots/${privBotId}`, {
          token: alice.token,
          body: { is_official: true },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await apiJson(baseUrl, 'PATCH', `/api/v1/bots/${privBotId}`, {
          token: alice.token,
          body: { menu_button_url: 'javascript:alert(1)' },
        })
      ).status,
    ).toBe(400);

    // Bob cannot see Alice's private bot in GET /api/v1/bots or GET /api/v1/bots/:botId!
    const bobBots = await apiJson(baseUrl, 'GET', '/api/v1/bots', { token: bob.token });
    expect(bobBots.data.bots.some((b: any) => b.bot_user_id === privBotId)).toBe(false);
    expect((await apiJson(baseUrl, 'GET', `/api/v1/bots/${privBotId}`, { token: bob.token })).status).toBe(404);

    // 2. Register Alice & Bob computers for VETO-1 request_human_takeover & OAuth node ownership tests
    const aliceNode = await apiJson(baseUrl, 'POST', '/api/v1/computers/local/register', {
      token: alice.token,
      body: { device_id: 'dev_d2_alice', display_name: 'Alice Workstation', os_name: 'Linux' },
    });
    expect(aliceNode.status).toBe(201);
    const aliceNodeId = aliceNode.data.node_id as string;
    const bobNode = await apiJson(baseUrl, 'POST', '/api/v1/computers/local/register', {
      token: bob.token,
      body: { device_id: 'dev_d2_bob', display_name: 'Bob Workstation', os_name: 'Linux' },
    });
    expect(bobNode.status).toBe(201);
    const bobNodeId = bobNode.data.node_id as string;

    // Invalid run_policy (including legacy non-canonical 'allow_all') rejected 400
    for (const badPolicy of ['invalid_policy', 'allow_all']) {
      const badPolicyRes = await apiJson(
        baseUrl,
        'PATCH',
        `/api/v1/computers/${encodeURIComponent(aliceNodeId)}/policy`,
        {
          token: alice.token,
          body: { run_policy: badPolicy },
        },
      );
      expect(badPolicyRes.status).toBe(400);
      expect(badPolicyRes.data.error).toBe('invalid_run_policy');
    }

    // Approving a pending computer command enqueues it for local polling
    const setAskPolicy = await apiJson(
      baseUrl,
      'PATCH',
      `/api/v1/computers/${encodeURIComponent(aliceNodeId)}/policy`,
      {
        token: alice.token,
        body: { run_policy: 'ask_every_time' },
      },
    );
    expect(setAskPolicy.status).toBe(200);
    const pendingExec = await apiJson(
      baseUrl,
      'POST',
      `/api/v1/computers/${encodeURIComponent(aliceNodeId)}/commands`,
      {
        token: alice.token,
        body: { operation: { op: 'shell_exec', command: 'echo hello' } },
      },
    );
    expect(pendingExec.status).toBe(202);
    const cmdId = pendingExec.data.command_id as string;
    const approveExec = await apiJson(baseUrl, 'POST', `/api/v1/computers/commands/${cmdId}/approve`, {
      token: alice.token,
      body: { approved: true },
    });
    expect(approveExec.status).toBe(200);
    expect(approveExec.data.enqueued).toBe(true);
    const polled = await apiJson(
      baseUrl,
      'GET',
      `/api/v1/computers/local/poll?node_id=${encodeURIComponent(aliceNodeId)}&timeout_ms=0`,
      { token: alice.token },
    );
    expect(polled.status).toBe(200);
    expect(polled.data.commands.some((c: any) => c.command_id === cmdId)).toBe(true);

    // 3. Confidential OAuth client (`client_secret_post`) + VETO-1 request_human_takeover + single-string allowed_node_ids guard + MCP-Protocol-Version on GET/DELETE
    const confReg = await apiJson(baseUrl, 'POST', '/oauth/register', {
      body: {
        client_name: 'Confidential Agent',
        redirect_uris: ['http://127.0.0.1:9888/cb'],
        token_endpoint_auth_method: 'client_secret_post',
      },
    });
    expect(confReg.status).toBe(201);
    const confClientId = confReg.data.client_id as string;
    const confClientSecret = confReg.data.client_secret as string;
    expect(confClientSecret).toBeTruthy();

    const verifier = 'confidential_verifier_abcdefghijklmnopqrstuvwxyz_0123456789';
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const authPage = await apiJson(
      baseUrl,
      'GET',
      `/oauth/authorize?client_id=${encodeURIComponent(confClientId)}&redirect_uri=${encodeURIComponent('http://127.0.0.1:9888/cb')}&response_type=code&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256&scope=${encodeURIComponent('devices:read devices:connect chats:read messaging:read')}&resource=${encodeURIComponent(`${baseUrl}/mcp`)}`,
    );
    expect(authPage.status).toBe(200);
    const oauthCookie = (authPage.headers.get('set-cookie') ?? '').split(';')[0]!;
    const txId = /name="tx_id" value="([^"]+)"/.exec(authPage.rawText)![1]!;
    const csrf1 = /name="csrf_token" value="([^"]+)"/.exec(authPage.rawText)![1]!;

    // Foreign pair_token in qr-poll MUST be rejected 403 invalid_pair_token
    const badPoll = await apiJson(
      baseUrl,
      'GET',
      `/oauth/authorize/qr-poll?tx_id=${encodeURIComponent(txId)}&pair_token=foreign_pair_token_xyz`,
      { headers: { Cookie: oauthCookie } },
    );
    expect(badPoll.status).toBe(403);
    expect(badPoll.data.error).toBe('invalid_pair_token');

    const loginRes = await apiJson(baseUrl, 'POST', '/oauth/authorize/login', {
      headers: { Cookie: oauthCookie, Accept: 'application/json' },
      body: { tx_id: txId, csrf_token: csrf1, username: alice.username, password: 'TestPassword123!' },
    });
    expect(loginRes.status).toBe(200);
    const csrf2 = loginRes.data.csrf_token as string;

    // Cross-tenant single-string allowed_node_ids MUST be rejected 403 forbidden_node!
    const badNodeApprove = await apiJson(baseUrl, 'POST', '/oauth/authorize/approve', {
      headers: { Cookie: oauthCookie },
      body: { tx_id: txId, csrf_token: csrf2, decision: 'approve', allowed_node_ids: bobNodeId },
    });
    expect(badNodeApprove.status).toBe(403);
    expect(badNodeApprove.data.error).toBe('forbidden_node');

    // Valid approval with Alice's own node succeeds
    const goodApprove = await apiJson(baseUrl, 'POST', '/oauth/authorize/approve', {
      headers: { Cookie: oauthCookie },
      body: { tx_id: txId, csrf_token: csrf2, decision: 'approve', allowed_node_ids: aliceNodeId },
    });
    expect(goodApprove.status).toBe(302);
    const authCode = new URL(goodApprove.headers.get('location')!).searchParams.get('code')!;

    const tokRes = await apiJson(baseUrl, 'POST', '/oauth/token', {
      body: {
        grant_type: 'authorization_code',
        code: authCode,
        client_id: confClientId,
        client_secret: confClientSecret,
        redirect_uri: 'http://127.0.0.1:9888/cb',
        code_verifier: verifier,
      },
    });
    expect(tokRes.status).toBe(200);
    const mcpToken = tokRes.data.access_token as string;
    const mcpRefresh = tokRes.data.refresh_token as string;

    // Confidential refresh_token MUST reject missing or wrong client_secret with 401 (without revoking token!)
    const noSecretRefresh = await apiJson(baseUrl, 'POST', '/oauth/token', {
      body: { grant_type: 'refresh_token', refresh_token: mcpRefresh, client_id: confClientId },
    });
    expect(noSecretRefresh.status).toBe(401);
    const badSecretRefresh = await apiJson(baseUrl, 'POST', '/oauth/token', {
      body: {
        grant_type: 'refresh_token',
        refresh_token: mcpRefresh,
        client_id: confClientId,
        client_secret: 'wrong_secret',
      },
    });
    expect(badSecretRefresh.status).toBe(401);

    // Unsupported MCP-Protocol-Version rejected 400 on GET /mcp and DELETE /mcp
    expect(
      (
        await apiJson(baseUrl, 'GET', '/mcp', {
          token: mcpToken,
          headers: { 'MCP-Protocol-Version': '1999-01-01' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await apiJson(baseUrl, 'DELETE', '/mcp', {
          token: mcpToken,
          headers: { 'MCP-Protocol-Version': '1999-01-01' },
        })
      ).status,
    ).toBe(400);

    // VETO-1: request_human_takeover mutates real lease_generation & lease_state in SQLite and disconnects active assist guest!
    const assistInfo = await apiJson(baseUrl, 'GET', '/api/v1/remote/assist/info?device_id=dev_d2_alice', {
      token: alice.token,
    });
    await apiJson(baseUrl, 'POST', '/api/v1/remote/assist/allow', {
      token: alice.token,
      body: { device_id: 'dev_d2_alice', allow_assist: true },
    });
    // Invalid assist mode rejected 400
    expect(
      (
        await apiJson(baseUrl, 'POST', '/api/v1/remote/assist/start', {
          token: bob.token,
          body: {
            assist_id: assistInfo.data.assist_id,
            access_code: assistInfo.data.current_code,
            mode: 'invalid_mode',
          },
        })
      ).status,
    ).toBe(400);
    const assistConn = await apiJson(baseUrl, 'POST', '/api/v1/remote/assist/start', {
      token: bob.token,
      body: {
        assist_id: assistInfo.data.assist_id,
        access_code: assistInfo.data.current_code,
        mode: 'desktop',
      },
    });
    expect(assistConn.status).toBe(200);

    const beforeRow = srv.db
      .prepare(`SELECT node_json FROM computer_nodes WHERE node_id = ?`)
      .get(aliceNodeId) as { node_json: string };
    const beforeNode = JSON.parse(beforeRow.node_json) as { lease_generation: number; lease_state: string };

    const takeoverCall = await apiJson(baseUrl, 'POST', '/mcp', {
      token: mcpToken,
      body: {
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: {
          name: 'request_human_takeover',
          arguments: { node_id: aliceNodeId, reason: 'CAPTCHA requires human' },
        },
      },
    });
    expect(takeoverCall.status).toBe(200);
    expect(takeoverCall.data.result.isError).toBeUndefined();
    const takeoverPayload = JSON.parse(takeoverCall.data.result.content[0].text);
    expect(takeoverPayload.ok).toBe(true);
    expect(takeoverPayload.lease_state).toBe('human_takeover');
    expect(takeoverPayload.new_generation).toBe(Number(beforeNode.lease_generation) + 1);
    expect(takeoverPayload.disconnected_guests).toBeGreaterThanOrEqual(1);

    const afterRow = srv.db
      .prepare(`SELECT node_json FROM computer_nodes WHERE node_id = ?`)
      .get(aliceNodeId) as { node_json: string };
    const afterNode = JSON.parse(afterRow.node_json) as { lease_generation: number; lease_state: string };
    expect(Number(afterNode.lease_generation)).toBe(Number(beforeNode.lease_generation) + 1);
    expect(afterNode.lease_state).toBe('human_takeover');

    // Valid refresh with correct secret succeeds after failed-secret attempts!
    const validRefresh = await apiJson(baseUrl, 'POST', '/oauth/token', {
      body: {
        grant_type: 'refresh_token',
        refresh_token: mcpRefresh,
        client_id: confClientId,
        client_secret: confClientSecret,
      },
    });
    expect(validRefresh.status).toBe(200);

    // 4. MCP get_chat_history on inaccessible chat returns structured JSON-RPC error (no unhandled throw!)
    const bobChat = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
      token: bob.token,
      body: { kind: 'group', title: 'Bob Only Chat' },
    });
    const bobChatId = bobChat.data.chat_id as number;

    const deniedHist = await apiJson(baseUrl, 'POST', '/mcp', {
      token: validRefresh.data.access_token,
      body: {
        jsonrpc: '2.0',
        id: 22,
        method: 'tools/call',
        params: { name: 'get_chat_history', arguments: { chat_id: bobChatId } },
      },
    });
    expect(deniedHist.status).toBe(403);
    expect(deniedHist.data.error.code).toBe(-32003);

    // 5. Wallet gift with inaccessible chat_id returns 403 BEFORE debiting sender's Stars!
    srv.db
      .prepare(
        `INSERT OR REPLACE INTO wallet_accounts (user_id, stars_balance, ton_nano, updated_at_ms)
         VALUES (?, 500, 0, ?)`,
      )
      .run(alice.userId, Date.now());
    const badGift = await apiJson(baseUrl, 'POST', '/api/v1/wallet/gift', {
      token: alice.token,
      body: { to_user_id: bob.userId, amount_stars: 100, chat_id: bobChatId },
    });
    expect(badGift.status).toBe(403);
    const aliceWallet = await apiJson(baseUrl, 'GET', '/api/v1/wallet', { token: alice.token });
    expect(aliceWallet.data.stars_balance).toBe(500);

    // 6. CloudStorage 1024-key quota counts only NEW keys (updating existing key at 1024 succeeds, 1025th fails!)
    const seedItems: Record<string, string> = {};
    for (let i = 0; i < 1024; i++) seedItems[`k_${i}`] = `v_${i}`;
    const fill1024 = await apiJson(baseUrl, 'PUT', '/api/v1/miniapps/FabushiBot/fabushi/storage', {
      token: alice.token,
      body: { items: seedItems },
    });
    expect(fill1024.status).toBe(200);
    const updateExisting = await apiJson(baseUrl, 'PUT', '/api/v1/miniapps/FabushiBot/fabushi/storage', {
      token: alice.token,
      body: { key: 'k_0', value: 'updated_v0' },
    });
    expect(updateExisting.status).toBe(200);
    const exceed1025 = await apiJson(baseUrl, 'PUT', '/api/v1/miniapps/FabushiBot/fabushi/storage', {
      token: alice.token,
      body: { key: 'k_1025', value: 'overflow' },
    });
    expect(exceed1025.status).toBe(400);
    expect(exceed1025.data.error).toBe('cloud_storage_quota_exceeded');
  });
});
