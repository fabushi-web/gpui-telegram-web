import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  REPO_ROOT_DIR,
  createTelegramServer,
  type TelegramServerInstance,
} from '@gpui-telegram/server';

const TEST_TMP_ROOT = path.join(REPO_ROOT_DIR, '.test-tmp');

function createUniqueTestDir(prefix: string): string {
  const dir = path.join(
    TEST_TMP_ROOT,
    `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function apiJson<T = any>(
  baseUrl: string,
  method: string,
  route: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; data: T; headers: Headers }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) {
    headers.Authorization = `Bearer ${opts.token}`;
  }
  let payload: RequestInit['body'];
  if (opts.body !== undefined) {
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
    payload = JSON.stringify(opts.body);
  }
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: payload,
  });
  const text = await res.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    // Non-JSON payload
  }
  return { status: res.status, data: data as T, headers: res.headers };
}

describe('@gpui-telegram/server — Clean Production Mode (Zero Fake Data, Fabushi WASM & Reverse Proxy)', () => {
  let prodServer: TelegramServerInstance;
  let proxyServer: TelegramServerInstance;
  let prodBaseUrl = '';
  let proxyBaseUrl = '';
  let proxyWsUrl = '';
  let prodDataDir: string;
  let proxyDataDir: string;

  beforeAll(async () => {
    prodDataDir = createUniqueTestDir('prod-clean');
    prodServer = createTelegramServer({
      host: '127.0.0.1',
      port: 0,
      dataDir: prodDataDir,
      enableTestReset: false,
      seedDemoData: false,
      allowDemoAuth: false,
      exposeDevOtpCode: false,
    });
    const startedProd = await prodServer.start();
    prodBaseUrl = startedProd.baseUrl;

    proxyDataDir = createUniqueTestDir('prod-proxy');
    proxyServer = createTelegramServer({
      host: '127.0.0.1',
      port: 0,
      dataDir: proxyDataDir,
      enableTestReset: false,
      seedDemoData: false,
      allowDemoAuth: false,
      upstreamServerUrl: prodBaseUrl,
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

  it('boots cleanly with zero fake users/chats/wallets and blocks all demo/test auth shortcuts', async () => {
    const health = await apiJson(prodBaseUrl, 'GET', '/api/v1/health');
    expect(health.status).toBe(200);
    expect(health.data.ok).toBe(true);
    expect(health.data.mode).toBe('production');
    expect(health.data.version).toBe('1.3.0');

    // Demo login & test reset must be rejected in production
    const demoRes = await apiJson(prodBaseUrl, 'POST', '/api/v1/auth/demo', {
      body: { slot: 0 },
    });
    expect(demoRes.status).toBe(403);

    const resetRes = await apiJson(prodBaseUrl, 'POST', '/api/v1/test/reset');
    expect(resetRes.status).toBe(403);

    // Phone OTP request must honestly report 503 (no SMS gateway) and NEVER leak dev_code in production
    const otpRes = await apiJson(prodBaseUrl, 'POST', '/api/v1/auth/phone/send-code', {
      body: { phone: '+8613800138000' },
    });
    expect(otpRes.status).toBe(503);
    expect(otpRes.data.dev_code).toBeUndefined();

    // Unauthenticated QR pair approval must be rejected in production
    const qrStart = await apiJson(prodBaseUrl, 'POST', '/api/v1/auth/pair/init', {
      body: { device_name: 'Web Browser' },
    });
    expect(qrStart.status).toBe(200);
    expect(String(qrStart.data.qr_svg ?? qrStart.data.svg ?? '')).toContain('<svg');
    const qrConfirm = await apiJson(prodBaseUrl, 'POST', '/api/v1/auth/pair/accept', {
      body: { pair_id: qrStart.data.pair_id },
    });
    expect([401, 403]).toContain(qrConfirm.status);

    // Register a real production user
    const reg = await apiJson(prodBaseUrl, 'POST', '/api/v1/auth/register', {
      body: {
        username: 'prod_real_user',
        password: 'StrongPassword#2026',
        first_name: 'Real',
        last_name: 'Operator',
      },
    });
    expect([200, 201]).toContain(reg.status);
    const token = String(reg.data.token);
    expect(token.length).toBeGreaterThan(10);

    // Zero fake demo contacts (no Alice/Bob/Lin/Sara)
    const chatsRes = await apiJson(prodBaseUrl, 'GET', '/api/v1/chats', { token });
    expect(chatsRes.status).toBe(200);
    const chatTitles: string[] = (chatsRes.data.chats ?? []).map((c: any) => String(c.title));
    expect(chatTitles.some((t) => /Alice|Bob|Lin Chen|Sara/i.test(t))).toBe(false);

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

    // AI Compose returns honest 503 when no LLM provider is configured
    const aiCompRes = await apiJson(prodBaseUrl, 'POST', '/api/v1/messages/ai-compose', {
      token,
      body: { text: 'Hello production', mode: 'translate_zh' },
    });
    expect(aiCompRes.status).toBe(503);

    // Real SQLite channel statistics (zero fake 74.5% / 12 boosts / synthetic counts)
    const groupRes = await apiJson(prodBaseUrl, 'POST', '/api/v1/chats', {
      token,
      body: { title: 'Real Launch Channel', chat_type: 2 },
    });
    expect([200, 201]).toContain(groupRes.status);
    const groupId = Number(groupRes.data.chat?.chat_id ?? groupRes.data.chat_id);
    const statsRes = await apiJson(
      prodBaseUrl,
      'GET',
      `/api/v1/chats/${groupId}/statistics`,
      { token },
    );
    expect(statsRes.status).toBe(200);
    expect(statsRes.data.total_messages).toBe(0);
    expect(statsRes.data.boosts_count).toBe(0);
    expect(statsRes.data.total_reactions).toBe(0);
    expect(statsRes.data.member_count).toBe(1);
    expect(statsRes.data.daily_series).toHaveLength(14);
    expect(statsRes.data.daily_series.every((pt: any) => pt.messages === 0)).toBe(true);
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

    // Real globe texture asset
    const texResp = await fetch(`${prodBaseUrl}/api/v1/fabushi-miniapp/assets/earth_texture.jpg`);
    expect(texResp.status).toBe(200);
    expect(texResp.headers.get('content-type')).toContain('image/jpeg');
    expect((await texResp.arrayBuffer()).byteLength).toBeGreaterThan(10_000);

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

  it('transparently reverse-proxies HTTP API and WebSockets to UPSTREAM_SERVER_URL', async () => {
    // Register & login through proxyServer -> persisted inside upstream prodServer!
    const regViaProxy = await apiJson(proxyBaseUrl, 'POST', '/api/v1/auth/register', {
      body: {
        username: 'proxied_operator',
        password: 'ProxyPassword#2026',
        first_name: 'Proxied',
      },
    });
    expect([200, 201]).toContain(regViaProxy.status);
    const proxyToken = String(regViaProxy.data.token);

    // Verify the exact same user can query prodServer directly using the token issued via proxy
    const meDirect = await apiJson(prodBaseUrl, 'GET', '/api/v1/users/me', {
      token: proxyToken,
    });
    expect(meDirect.status).toBe(200);
    expect(meDirect.data.username).toBe('proxied_operator');

    // Verify WebSocket upgrade + Ping/Pong roundtrip through the reverse proxy!
    const pongReceived = await new Promise<boolean>((resolve, reject) => {
      const ws = new WebSocket(`${proxyWsUrl}?token=${encodeURIComponent(proxyToken)}`);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('WS proxy ping timed out'));
      }, 5000);
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'Ping', data: { nonce: 4242 } }));
      });
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'Pong') {
          clearTimeout(timer);
          ws.close();
          resolve(true);
        }
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    expect(pongReceived).toBe(true);
  });
});
