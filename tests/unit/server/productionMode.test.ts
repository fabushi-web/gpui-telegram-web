import crypto from 'node:crypto';
import fs from 'node:fs';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTelegramServer,
  type TelegramServerInstance,
} from '@gpui-telegram/server';
import { shouldCompressContentType } from '../../../apps/server/src/utils/http.js';
import { apiJson, createUniqueTestDir } from './_helpers.js';

describe('@gpui-telegram/server — Clean Production Mode (Zero Fake Data, v1.6.11 Status/Health, Fabushi WASM & Reverse Proxy)', () => {
  let prodServer: TelegramServerInstance;
  let proxyServer: TelegramServerInstance;
  let prodBaseUrl = '';
  let proxyBaseUrl = '';
  let proxyWsUrl = '';
  let prodDataDir: string;
  let proxyDataDir: string;
  const explicitTurnSecret = 'coturn-static-auth-secret-m2-test';

  beforeAll(async () => {
    prodDataDir = createUniqueTestDir('prod-clean');
    prodServer = createTelegramServer({
      host: '127.0.0.1',
      port: 0,
      dataDir: prodDataDir,
      enableTestReset: false,
      turnSecret: explicitTurnSecret,
    });
    const startedProd = await prodServer.start();
    prodBaseUrl = startedProd.baseUrl;

    proxyDataDir = createUniqueTestDir('prod-proxy');
    proxyServer = createTelegramServer({
      host: '127.0.0.1',
      port: 0,
      dataDir: proxyDataDir,
      enableTestReset: false,
      upstreamServerUrl: prodBaseUrl,
      proxyBrowserWs: false,
    });
    const startedProxy = await proxyServer.start();
    proxyBaseUrl = startedProxy.baseUrl;
    proxyWsUrl = startedProxy.wsUrl;
  }, 30_000);

  afterAll(async () => {
    await proxyServer?.close();
    await prodServer?.close();
    fs.rmSync(proxyDataDir, { recursive: true, force: true });
    fs.rmSync(prodDataDir, { recursive: true, force: true });
  });

  it('boots cleanly at v1.7.0 with plain /health OK, 39 status capabilities, MCP CORS headers, compression exclusions, and zero fake data', async () => {
    // 1. Plain-text /health -> "OK"
    const plainHealth = await fetch(`${prodBaseUrl}/health`);
    expect(plainHealth.status).toBe(200);
    expect(plainHealth.headers.get('content-type')).toContain('text/plain');
    expect(await plainHealth.text()).toBe('OK');

    // 2. JSON /api/v1/health & /api/v1/status (v1.7.0 + all 39 capabilities + MCP CORS headers)
    const health = await apiJson(prodBaseUrl, 'GET', '/api/v1/health');
    expect(health.status).toBe(200);
    expect(health.data.ok).toBe(true);
    expect(health.data.app).toBe('Fabushi Web');
    expect(health.data.mode).toBe('production');
    expect(health.data.version).toBe('1.7.0');

    const status = await apiJson(prodBaseUrl, 'GET', '/api/v1/status');
    expect(status.status).toBe(200);
    expect(status.data.server).toBe('fabushi-web');
    expect(status.data.status).toBe('ok');
    expect(status.data.version).toBe('1.7.0');
    expect(status.data.capabilities).toContain('official_mcp_oauth21');
    expect(status.data.capabilities).toContain('auto_update_relay');
    expect(status.data.capabilities).toContain('remote_control');
    expect(status.data.capabilities).toContain('remote_assist');
    expect(status.data.capabilities).toContain('bot_inline_query');
    expect(status.data.capabilities).toContain('scheduled_messages');
    expect(status.data.capabilities).toContain('message_translate');
    expect(status.data.capabilities).toContain('admin_log');
    expect(status.data.capabilities).toContain('multi_agent_primary_fallback');
    expect(status.data.capabilities).toContain('protocol_v170_contracts');
    expect(status.data.capabilities.length).toBe(39);

    const exposeHeaders = status.headers.get('access-control-expose-headers') ?? '';
    expect(exposeHeaders).toContain('Mcp-Session-Id');
    expect(exposeHeaders).toContain('Mcp-Protocol-Version');
    expect(exposeHeaders).toContain('WWW-Authenticate');

    // 3. Compression exclusion rules
    expect(shouldCompressContentType('text/event-stream')).toBe(false);
    expect(shouldCompressContentType('application/octet-stream')).toBe(false);
    expect(shouldCompressContentType('application/wasm')).toBe(false);
    expect(shouldCompressContentType('application/json; charset=utf-8')).toBe(true);

    // 4. Demo & sandbox routes permanently removed -> 404
    const demoRes = await apiJson(prodBaseUrl, 'POST', '/api/v1/auth/demo', {
      body: { slot: 0 },
    });
    expect(demoRes.status).toBe(404);

    const sandboxRes = await apiJson(prodBaseUrl, 'POST', '/api/v1/auth/sandbox', {
      body: { slot: 0 },
    });
    expect(sandboxRes.status).toBe(404);

    const resetRes = await apiJson(prodBaseUrl, 'POST', '/api/v1/test/reset');
    expect(resetRes.status).toBe(403);

    // Phone & Email OTP honestly report 503 when unconfigured and NEVER leak dev_code
    const otpRes = await apiJson(prodBaseUrl, 'POST', '/api/v1/auth/phone/send-code', {
      body: { phone: '+8613800138000' },
    });
    expect(otpRes.status).toBe(503);
    expect(otpRes.data.dev_code).toBeUndefined();

    const emailOtpRes = await apiJson(prodBaseUrl, 'POST', '/api/v1/auth/email/send-code', {
      body: { email: 'operator@example.com' },
    });
    expect(emailOtpRes.status).toBe(503);
    expect(emailOtpRes.data.dev_code).toBeUndefined();

    // Unauthenticated QR pair approval rejected with 401
    const qrStart = await apiJson(prodBaseUrl, 'POST', '/api/v1/auth/pair/init', {
      body: { device_name: 'Web Browser' },
    });
    expect(qrStart.status).toBe(200);
    expect(String(qrStart.data.qr_svg ?? qrStart.data.svg ?? '')).toContain('<svg');
    const qrConfirm = await apiJson(prodBaseUrl, 'POST', '/api/v1/auth/pair/accept', {
      body: { pair_id: qrStart.data.pair_id },
    });
    expect(qrConfirm.status).toBe(401);

    // Register a real production user -> clean empty slate
    const reg = await apiJson(prodBaseUrl, 'POST', '/api/v1/auth/register', {
      body: {
        username: 'prod_real_user',
        password: 'StrongPassword#2026',
        first_name: 'Real',
        last_name: 'Operator',
      },
    });
    expect(reg.status).toBe(201);
    const token = String(reg.data.token);
    expect(token.length).toBeGreaterThan(10);

    // Zero fake chats (not even auto-created Saved Messages!), contacts, stories, or is_premium
    const chatsRes = await apiJson(prodBaseUrl, 'GET', '/api/v1/chats', { token });
    expect(chatsRes.status).toBe(200);
    expect(chatsRes.data.chats).toEqual([]);
    expect(chatsRes.data.total).toBe(0);

    const contactsRes = await apiJson(prodBaseUrl, 'GET', '/api/v1/contacts', { token });
    expect(contactsRes.status).toBe(200);
    expect(contactsRes.data.contacts).toEqual([]);

    const storiesRes = await apiJson(prodBaseUrl, 'GET', '/api/v1/stories', { token });
    expect(storiesRes.status).toBe(200);
    expect(storiesRes.data.stories).toEqual([]);

    const meRes = await apiJson(prodBaseUrl, 'GET', '/api/v1/users/me', { token });
    expect(meRes.status).toBe(200);
    expect(meRes.data.is_premium).toBe(false);

    const privRes = await apiJson(prodBaseUrl, 'GET', '/api/v1/account/privacy', { token });
    expect(privRes.status).toBe(200);
    expect(privRes.data.is_premium).toBe(false);

    // Zero fake wallet balances
    const walletRes = await apiJson(prodBaseUrl, 'GET', '/api/v1/wallet', { token });
    expect(walletRes.status).toBe(200);
    expect(walletRes.data.stars_balance).toBe(0);
    expect(walletRes.data.ton_nano).toBe(0);

    // Zero fake computers
    const compRes = await apiJson(prodBaseUrl, 'GET', '/api/v1/computers', { token });
    expect(compRes.status).toBe(200);
    expect(compRes.data.computers).toEqual([]);

    // Zero fake miniapp install counts or TaskBoardBot
    const miniAppsRes = await apiJson(prodBaseUrl, 'GET', '/api/v1/miniapps', { token });
    expect(miniAppsRes.status).toBe(200);
    const shortNames: string[] = (miniAppsRes.data.apps ?? []).map((a: any) => String(a.short_name));
    expect(shortNames).toContain('fabushi');
    expect(shortNames).not.toContain('taskboard');
    const fabushiApp = miniAppsRes.data.apps.find((a: any) => a.short_name === 'fabushi');
    expect(fabushiApp.install_count).toBe(0);

    // Zero fake GIF SVG / catalog, transcription 501, call missing callee 400, phantom contact 404
    const fakeSvg = await fetch(`${prodBaseUrl}/api/v1/gifs/svg/celebrate`);
    expect(fakeSvg.status).toBe(404);

    const gifsRes = await apiJson(prodBaseUrl, 'GET', '/api/v1/gifs/search?q=rocket', { token });
    expect(gifsRes.status).toBe(200);
    expect(gifsRes.data).toEqual({ gifs: [], results: [] });

    const audioUp = await apiJson(prodBaseUrl, 'POST', '/api/v1/media/upload?filename=voice.ogg', {
      token,
      body: Buffer.from('OggS-fake-voice'),
      headers: { 'Content-Type': 'audio/ogg' },
    });
    expect(audioUp.status).toBe(201);
    const transcribeRes = await apiJson(
      prodBaseUrl,
      'POST',
      `/api/v1/media/${audioUp.data.file_id}/transcribe`,
      { token },
    );
    expect(transcribeRes.status).toBe(501);

    // Binary stream never carries Content-Encoding: gzip even when Accept-Encoding: gzip is sent
    const binStream = await fetch(`${prodBaseUrl}/api/v1/media/${audioUp.data.file_id}`, {
      headers: { 'Accept-Encoding': 'gzip' },
    });
    expect(binStream.status).toBe(200);
    expect(binStream.headers.get('content-encoding')).toBeNull();

    const callEmpty = await apiJson(prodBaseUrl, 'POST', '/api/v1/calls/start', {
      token,
      body: {},
    });
    expect(callEmpty.status).toBe(400);

    const usersBeforeGhostContact = prodServer.db
      .prepare(`SELECT COUNT(*) AS cnt FROM users`)
      .get() as { cnt: number };
    const ghostContact = await apiJson(prodBaseUrl, 'POST', '/api/v1/contacts', {
      token,
      body: { username: 'totally_nonexistent_ghost_user', phone: '+19998887777' },
    });
    expect(ghostContact.status).toBe(404);
    const usersAfterGhostContact = prodServer.db
      .prepare(`SELECT COUNT(*) AS cnt FROM users`)
      .get() as { cnt: number };
    expect(Number(usersAfterGhostContact.cnt)).toBe(Number(usersBeforeGhostContact.cnt));

    // TURN HMAC-SHA1 uses explicit `turnSecret` (NOT `masterSecret`)
    const turnRes = await apiJson(prodBaseUrl, 'GET', '/api/v1/calls/turn-credentials', { token });
    expect(turnRes.status).toBe(200);
    const expectedTurnHmac = crypto
      .createHmac('sha1', Buffer.from(explicitTurnSecret, 'utf8'))
      .update(String(turnRes.data.username))
      .digest('base64');
    const wrongMasterHmac = crypto
      .createHmac('sha1', prodServer.config.masterSecret)
      .update(String(turnRes.data.username))
      .digest('base64');
    expect(turnRes.data.credential).toBe(expectedTurnHmac);
    expect(turnRes.data.credential).not.toBe(wrongMasterHmac);

    // AI Compose returns honest 503 when no LLM provider is configured
    const aiCompRes = await apiJson(prodBaseUrl, 'POST', '/api/v1/messages/ai-compose', {
      token,
      body: { text: 'Hello production', mode: 'translate_zh' },
    });
    expect(aiCompRes.status).toBe(503);

    // Real SQLite channel statistics + zero fabricated OpenGraph + zero stub callback echo
    const groupRes = await apiJson(prodBaseUrl, 'POST', '/api/v1/chats', {
      token,
      body: { title: 'Real Launch Channel', chat_type: 2 },
    });
    expect(groupRes.status).toBe(201);
    const groupId = Number(groupRes.data.chat?.chat_id ?? groupRes.data.chat_id);

    const urlMsg = await apiJson(prodBaseUrl, 'POST', `/api/v1/chats/${groupId}/messages`, {
      token,
      body: { text: 'Check https://example.invalid/no-og and http://127.0.0.1:4173/health' },
    });
    expect(urlMsg.status).toBe(201);
    expect(urlMsg.data.message.web_page).toBeUndefined();

    const unknownCb = await apiJson(prodBaseUrl, 'POST', `/api/v1/chats/${groupId}/callback`, {
      token,
      body: { message_id: 0, callback_data: 'unknown:noop' },
    });
    expect(unknownCb.status).toBe(422);
    expect(JSON.stringify(unknownCb.data)).not.toContain('Callback "unknown:noop" received');

    const statsRes = await apiJson(
      prodBaseUrl,
      'GET',
      `/api/v1/chats/${groupId}/statistics`,
      { token },
    );
    expect(statsRes.status).toBe(200);
    expect(statsRes.data.total_messages).toBe(1);
    expect(statsRes.data.boosts_count).toBe(0);
    expect(statsRes.data.total_reactions).toBe(0);
    expect(statsRes.data.member_count).toBe(1);
    expect(statsRes.data.daily_series).toHaveLength(14);
  });

  it('serves real 833KB Rust-compiled Fabushi WASM binary, textures, and SQLite-backed Fabushi MiniApp API', async () => {
    const login = await apiJson(prodBaseUrl, 'POST', '/api/v1/auth/login', {
      body: { username: 'prod_real_user', password: 'StrongPassword#2026' },
    });
    expect(login.status).toBe(200);
    const token = String(login.data.token);

    // Real WebAssembly magic bytes \0asm and >500KB size
    const wasmResp = await fetch(`${prodBaseUrl}/api/v1/fabushi-miniapp/app.wasm`);
    expect(wasmResp.status).toBe(200);
    expect(wasmResp.headers.get('content-type')).toContain('application/wasm');
    const wasmBuf = Buffer.from(await wasmResp.arrayBuffer());
    expect(wasmBuf.length).toBeGreaterThan(500_000);
    expect(wasmBuf.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d]))).toBe(true);

    // Real globe texture asset + static /miniapps/fabushi-globe/* assets (BEFORE /:botUsername/:shortName)
    const texResp = await fetch(`${prodBaseUrl}/api/v1/fabushi-miniapp/assets/earth_texture.jpg`);
    expect(texResp.status).toBe(200);
    expect(texResp.headers.get('content-type')).toContain('image/jpeg');
    expect((await texResp.arrayBuffer()).byteLength).toBeGreaterThan(10_000);

    const staticWasm = await fetch(`${prodBaseUrl}/miniapps/fabushi-globe/fabushi_miniapp.wasm`);
    expect(staticWasm.status).toBe(200);
    expect(staticWasm.headers.get('content-type')).toContain('application/wasm');
    const staticWasmBuf = Buffer.from(await staticWasm.arrayBuffer());
    expect(staticWasmBuf.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d]))).toBe(true);

    const staticTex = await fetch(`${prodBaseUrl}/miniapps/fabushi-globe/earth_texture.jpg`);
    expect(staticTex.status).toBe(200);
    expect(staticTex.headers.get('content-type')).toContain('image/jpeg');

    const staticIndex = await fetch(`${prodBaseUrl}/miniapps/fabushi-globe`);
    expect(staticIndex.status).toBe(200);
    expect(staticIndex.headers.get('content-type')).toContain('text/html');

    const staticTraversal = await fetch(`${prodBaseUrl}/miniapps/fabushi-globe/..%2fpackage.json`);
    expect([400, 404]).toContain(staticTraversal.status);

    const protoAsset = await fetch(`${prodBaseUrl}/api/v1/fabushi-miniapp/assets/constructor`);
    expect(protoAsset.status).toBe(404);

    // SQLite-backed Fabushi bootstrap -> transfer -> practice session -> leaderboard -> heartbeat
    const boot = await apiJson(prodBaseUrl, 'GET', '/api/v1/fabushi-miniapp/bootstrap', {
      token,
    });
    expect(boot.status).toBe(200);
    expect(boot.data.profile.display_name).toContain('Real');
    expect(boot.data.profile.total_transfer_count).toBe(0);
    expect(boot.data.profile.total_practice_sessions).toBe(0);

    const transferRes = await apiJson(prodBaseUrl, 'POST', '/api/v1/fabushi-miniapp/transfer', {
      token,
      body: {
        content_title: '金刚般若波罗蜜经',
        target_countries: ['CN', 'JP', 'US'],
        bytes_sent: 65536,
        beam_count: 3,
      },
    });
    expect(transferRes.status).toBe(200);
    expect(transferRes.data.type).toBe('transfer_recorded');
    expect(transferRes.data.total_transfer_count).toBe(1);
    expect(transferRes.data.total_transfer_bytes).toBe(65536);

    const sessionRes = await apiJson(
      prodBaseUrl,
      'POST',
      '/api/v1/fabushi-miniapp/practice/session',
      {
        token,
        body: { sutra: '般若波罗蜜多心经', duration_minutes: 15, chant_count: 108 },
      },
    );
    expect(sessionRes.status).toBe(200);
    expect(sessionRes.data.type).toBe('practice_session_saved');
    expect(sessionRes.data.profile.total_practice_sessions).toBe(1);
    expect(sessionRes.data.profile.total_practice_chants).toBe(108);

    const bootAfter = await apiJson(
      prodBaseUrl,
      'GET',
      '/api/v1/fabushi-miniapp/bootstrap',
      { token },
    );
    expect(bootAfter.status).toBe(200);
    expect(bootAfter.data.profile.total_transfer_count).toBe(1);
    expect(bootAfter.data.profile.total_practice_sessions).toBe(1);
    expect(bootAfter.data.practice_records.length).toBeGreaterThanOrEqual(1);

    const lb = await apiJson(
      prodBaseUrl,
      'GET',
      '/api/v1/fabushi-miniapp/leaderboard?kind=global',
      { token },
    );
    expect(lb.status).toBe(200);
    expect(lb.data.entries.length).toBeGreaterThanOrEqual(1);

    const hb = await apiJson(prodBaseUrl, 'POST', '/api/v1/fabushi-miniapp/heartbeat', {
      token,
      body: { activity_type: 'global_sending' },
    });
    expect(hb.status).toBe(200);
    expect(hb.data.online_count).toBeGreaterThanOrEqual(1);
  });

  it('transparently reverse-proxies /api/v1/ws to UPSTREAM_SERVER_URL while keeping /api/v1/browser/ws local by default', async () => {
    // Register & login through proxyServer -> persisted inside upstream prodServer!
    const regViaProxy = await apiJson(proxyBaseUrl, 'POST', '/api/v1/auth/register', {
      body: {
        username: 'proxied_operator',
        password: 'ProxyPassword#2026',
        first_name: 'Proxied',
      },
    });
    expect(regViaProxy.status).toBe(201);
    const proxyToken = String(regViaProxy.data.token);

    // Verify the exact same user can query prodServer directly using the token issued via proxy
    const meDirect = await apiJson(prodBaseUrl, 'GET', '/api/v1/users/me', {
      token: proxyToken,
    });
    expect(meDirect.status).toBe(200);
    expect(meDirect.data.username).toBe('proxied_operator');

    // Verify /api/v1/ws upgrade + Ping/Pong roundtrip through the reverse proxy!
    const pongNonce = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`${proxyWsUrl}?token=${encodeURIComponent(proxyToken)}`);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('WS proxy ping timed out'));
      }, 5000);
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'Ping', payload: { nonce: 4242 } }));
      });
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'Pong') {
          clearTimeout(timer);
          ws.close();
          resolve(Number(msg.payload?.nonce));
        }
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    expect(pongNonce).toBe(4242);

    // Verify /api/v1/browser/ws stays handled LOCALLY on proxyServer (not forwarded to upstream!)
    const browserWsUrl = `${proxyBaseUrl.replace(/^http/, 'ws')}/api/v1/browser/ws`;
    const localBrowserPong = await new Promise<number>((resolve, reject) => {
      const bws = new WebSocket(browserWsUrl);
      const timer = setTimeout(() => {
        bws.close();
        reject(new Error('Local browser WS ping timed out'));
      }, 5000);
      bws.on('open', () => {
        bws.send(JSON.stringify({ type: 'Ping', payload: { nonce: 9001 } }));
      });
      bws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'Pong') {
          clearTimeout(timer);
          bws.close();
          resolve(Number(msg.payload?.nonce));
        }
      });
      bws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    expect(localBrowserPong).toBe(9001);
  });

  it('enforces M3 zero-fake-data invariants across AI Vault/Magpie (F2-F5), Fabushi/Hermes (F6-F9), MCP/Talk/Computers/Tailnet/Tasks (F10-F14), Bots/VIP/Wallet (F15) & Browser CDP (F18)', async () => {
    const login = await apiJson(prodBaseUrl, 'POST', '/api/v1/auth/login', {
      body: { username: 'prod_real_user', password: 'StrongPassword#2026' },
    });
    expect(login.status).toBe(200);
    const token = String(login.data.token);

    // F2 / F3 / F4 / F5: Magpie & AI Gateway — require auth, zero local_hermes, honest 503 with zero [DONE] on error
    for (const [method, path, body] of [
      ['GET', '/v1/models', undefined],
      ['GET', '/api/v1/magpie/v1/models', undefined],
      ['POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] }],
      ['POST', '/api/v1/magpie/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] }],
    ] as const) {
      const unauth = await apiJson(prodBaseUrl, method, path, { body });
      expect(unauth.status).toBe(401);
    }

    const magpieState = await apiJson(prodBaseUrl, 'GET', '/api/v1/fabushi/magpie/state', { token });
    expect(magpieState.status).toBe(200);
    expect(magpieState.data.providers).toEqual([]);
    expect(magpieState.data.has_configured_provider).toBe(false);
    expect(magpieState.data.needs_provider_selection).toBe(true);
    expect(magpieState.data.allow_local_fallback).toBe(false);
    const stateSerialized = JSON.stringify(magpieState.data);
    expect(stateSerialized).not.toContain('local_hermes');
    expect(stateSerialized).not.toContain('hermes-local-v1');

    const badLocalProv = await apiJson(prodBaseUrl, 'POST', '/api/v1/fabushi/magpie/providers', {
      token,
      body: { provider_id: 'local_hermes', base_url: 'http://127.0.0.1:9999/v1' },
    });
    expect(badLocalProv.status).toBe(400);

    const noProvSync = await apiJson(prodBaseUrl, 'POST', '/api/v1/magpie/v1/chat/completions', {
      token,
      body: { messages: [{ role: 'user', content: 'hello' }], stream: false },
    });
    expect(noProvSync.status).toBe(503);
    expect(noProvSync.data.error).toBe('provider_not_configured');
    expect(noProvSync.data.needs_provider_selection).toBe(true);
    expect(noProvSync.data.action).toBe('hermes:open_ai_providers');

    const noProvStream = await apiJson(prodBaseUrl, 'POST', '/api/v1/magpie/v1/chat/completions', {
      token,
      body: { messages: [{ role: 'user', content: 'hello' }], stream: true },
    });
    expect(noProvStream.status).toBe(503);
    expect(noProvStream.rawText).not.toContain('data: [DONE]');
    expect(noProvStream.rawText).not.toContain('[Magpie');

    const scanSubs = await apiJson(prodBaseUrl, 'POST', '/api/v1/fabushi/magpie/subscriptions/scan', {
      token,
      body: {},
    });
    expect(scanSubs.status).toBe(200);
    expect(scanSubs.data.subscriptions).toEqual([]);

    // F6 / F7 / F8 / F9: Fabushi / Hermes Agent — zero local_hermes, zero "Executed /..." stubs, honest 503 cron trigger
    const hermesStatus = await apiJson(prodBaseUrl, 'GET', '/api/v1/fabushi/status', { token });
    expect(hermesStatus.status).toBe(200);
    expect(hermesStatus.data.has_configured_provider).toBe(false);
    expect(hermesStatus.data.active_provider).not.toBe('local_hermes');
    expect(hermesStatus.data.active_model).not.toBe('hermes-local-v1');
    expect(hermesStatus.data.chat_id).not.toBe(106);

    const badCmd = await apiJson(prodBaseUrl, 'POST', '/api/v1/fabushi/command', {
      token,
      body: { command: '/nonexistent_cmd' },
    });
    expect(badCmd.status).toBe(400);
    expect(JSON.stringify(badCmd.data)).not.toContain('Executed /');

    const unimplCmd = await apiJson(prodBaseUrl, 'POST', '/api/v1/fabushi/command', {
      token,
      body: { command: '/vision' },
    });
    expect(unimplCmd.status).toBe(501);
    expect(JSON.stringify(unimplCmd.data)).not.toContain('Executed /');

    const cronCreate = await apiJson(prodBaseUrl, 'POST', '/api/v1/fabushi/cron', {
      token,
      body: { name: 'Digest', schedule_expr: '*/15 * * * *', prompt: 'Summarize' },
    });
    expect(cronCreate.status).toBe(201);
    const cronJobId = String(cronCreate.data.job_id ?? cronCreate.data.id);
    const cronTrig = await apiJson(
      prodBaseUrl,
      'POST',
      `/api/v1/fabushi/cron/${encodeURIComponent(cronJobId)}/trigger`,
      { token },
    );
    expect(cronTrig.status).toBe(503);
    expect(cronTrig.data.error).toBe('provider_not_configured');

    // F10: MCP Tools & Official OAuth 2.1 MCP — zero fake mcp_filesystem tools, 401 WWW-Authenticate on /mcp
    const mcpTools = await apiJson(prodBaseUrl, 'GET', '/api/v1/mcp/tools', { token });
    expect(mcpTools.status).toBe(200);
    expect(mcpTools.data.tools).toEqual([]);

    const fakeToolInvoke = await apiJson(prodBaseUrl, 'POST', '/api/v1/mcp/invoke', {
      token,
      body: { tool_name: 'fs_read_file', arguments: {} },
    });
    expect([400, 404]).toContain(fakeToolInvoke.status);
    expect(JSON.stringify(fakeToolInvoke.data)).not.toContain('Executed MCP tool');

    const unauthMcp = await apiJson(prodBaseUrl, 'POST', '/mcp', {
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(unauthMcp.status).toBe(401);
    expect(unauthMcp.headers.get('www-authenticate') ?? '').toContain('resource_metadata=');

    // F11: Talk Mode — honest 503 when unconfigured (zero "Heard ..." echo)
    const talkRes = await apiJson(prodBaseUrl, 'POST', '/api/v1/talk/audio', {
      token,
      body: { transcript: 'hello' },
    });
    expect(talkRes.status).toBe(503);
    expect(JSON.stringify(talkRes.data)).not.toContain('Heard');

    // F12: Computer Workbench — cloud node starts offline (online: false), command returns 503 (zero SVG/sandbox:default)
    const cloudNode = await apiJson(prodBaseUrl, 'POST', '/api/v1/computers/cloud', {
      token,
      body: { display_name: 'Prod Cloud', host: '198.51.100.22' },
    });
    expect(cloudNode.status).toBe(201);
    expect(cloudNode.data.online).toBe(false);
    expect(cloudNode.data.frame_svg_data_url).toBeUndefined();
    const offlineExec = await apiJson(
      prodBaseUrl,
      'POST',
      `/api/v1/computers/${encodeURIComponent(String(cloudNode.data.node_id))}/commands`,
      { token, body: { operation: { op: 'system_info' } } },
    );
    expect(offlineExec.status).toBe(503);

    // F13: Tailnet — honest disconnected state (zero fake 100.64.0.1)
    const tailnet = await apiJson(prodBaseUrl, 'GET', '/api/v1/tailnet/status', { token });
    expect(tailnet.status).toBe(200);
    expect(tailnet.data.connected).toBe(false);
    expect(tailnet.data.peers).toEqual([]);
    expect(tailnet.data.self_peer?.ipv4).not.toBe('100.64.0.1');
    expect(tailnet.data.self_peer?.online).toBe(false);

    // F14: Task Center — honest progress 0 & empty logs (zero synthetic 35/40)
    const taskCreate = await apiJson(prodBaseUrl, 'POST', '/api/v1/tasks', {
      token,
      body: { title: 'Truthful task', state: 'running' },
    });
    expect(taskCreate.status).toBe(201);
    expect(taskCreate.data.progress).toBe(0);
    expect(taskCreate.data.logs).toEqual([]);

    // F15: SDK zero fake Alice/1001, VIP & Wallet topup strictly gated with 402 payment_required
    const sdkResp = await fetch(`${prodBaseUrl}/js/telegram-web-app.js`);
    expect(sdkResp.status).toBe(200);
    const sdkText = await sdkResp.text();
    expect(sdkText).not.toContain('Alice');
    expect(sdkText).not.toContain('1001');
    expect(sdkText).toContain('modelContext');

    const unpaidVip = await apiJson(prodBaseUrl, 'POST', '/api/v1/fabushi-miniapp/membership', {
      token,
      body: { plan: 'monthly' },
    });
    expect(unpaidVip.status).toBe(402);
    expect(unpaidVip.data.error).toBe('payment_required');

    const unpaidTopup = await apiJson(prodBaseUrl, 'POST', '/api/v1/wallet/topup', {
      token,
      body: { amount_stars: 500 },
    });
    expect(unpaidTopup.status).toBe(402);
    expect(unpaidTopup.data.error).toBe('payment_required');

    // F18: Browser CDP — zero HTTP DOM SVG fallback
    const fallbackPref = await apiJson(prodBaseUrl, 'POST', '/api/v1/browser/headless/open', {
      token,
      body: { url: 'about:blank', prefer_fallback: true },
    });
    expect(fallbackPref.status).toBe(400);
    expect(fallbackPref.data.error).toBe('unsupported_backend');

    const fallbackBackend = await apiJson(prodBaseUrl, 'POST', '/api/v1/browser/headless/open', {
      token,
      body: { url: 'about:blank', backend: 'http_dom_fallback' },
    });
    expect(fallbackBackend.status).toBe(400);
    expect(fallbackBackend.data.error).toBe('unsupported_backend');
  });
});
