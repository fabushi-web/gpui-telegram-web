import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
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
    if (Buffer.isBuffer(opts.body) || opts.body instanceof Uint8Array) {
      payload = new Uint8Array(opts.body);
    } else {
      headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
      payload = JSON.stringify(opts.body);
    }
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
    // Keep text when non-JSON (HTML/SVG/SSE)
  }
  return { status: res.status, data: data as T, headers: res.headers };
}

function connectWsAuthenticated(
  wsUrl: string,
  token: string,
): Promise<{
  ws: WebSocket;
  frames: any[];
  waitForFrame: (predicate: (f: any) => boolean, timeoutMs?: number) => Promise<any>;
}> {
  return new Promise((resolve, reject) => {
    const frames: any[] = [];
    const waiters: Array<{ pred: (f: any) => boolean; res: (f: any) => void }> = [];
    const ws = new WebSocket(`${wsUrl}?token=${encodeURIComponent(token)}`);

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
      if (parsed.type === 'AuthOk') {
        resolve({
          ws,
          frames,
          waitForFrame(predicate, timeoutMs = 4000) {
            const existing = frames.find(predicate);
            if (existing) return Promise.resolve(existing);
            return new Promise((resWait, rejWait) => {
              const timer = setTimeout(
                () => rejWait(new Error('Timed out waiting for WS frame')),
                timeoutMs,
              );
              waiters.push({
                pred: predicate,
                res: (f) => {
                  clearTimeout(timer);
                  resWait(f);
                },
              });
            });
          },
        });
      }
    });

    ws.once('error', reject);
  });
}

describe('@gpui-telegram/server — Full-Stack Integration & Adversarial Security Suite (F1–F16)', () => {
  let server: TelegramServerInstance;
  let baseUrl = '';
  let wsUrl = '';
  let dataDir = '';

  beforeAll(async () => {
    dataDir = createUniqueTestDir('m1a-server');
    server = createTelegramServer({
      port: 0,
      host: '127.0.0.1',
      dataDir,
      enableTestReset: true,
    });
    const started = await server.start();
    baseUrl = started.baseUrl;
    wsUrl = started.wsUrl;
  });

  afterAll(async () => {
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('serves health aliases, rejects malformed percent-encoding with 400, disconnects WS on reset, and resets consistently in <50ms', async () => {
    for (const hRoute of ['/api/v1/health', '/health', '/healthz', '/api/v1/ready']) {
      const health = await apiJson(baseUrl, 'GET', hRoute);
      expect(health.status).toBe(200);
      expect(health.data.ok).toBe(true);
      expect(health.data.db).toBe('wal_ready');
    }

    // Malformed percent-encoding must return 400 Bad Request and NEVER crash the HTTP server!
    for (const badPath of [
      '/%E0%A4%A',
      '/api/v1/media/%E0%A4%A',
      '/api/v1/chats/%E0%A4%A/messages',
    ]) {
      const badRes = await fetch(`${baseUrl}${badPath}`);
      expect(badRes.status).toBe(400);
    }

    // Active WebSocket connection is closed when /api/v1/test/reset runs
    const demoAuth = await apiJson(baseUrl, 'POST', '/api/v1/auth/demo', { body: { slot: 0 } });
    const clientConn = await connectWsAuthenticated(wsUrl, demoAuth.data.token);
    const closedPromise = new Promise<number>((resolve) => {
      clientConn.ws.once('close', (code) => resolve(code));
    });

    // Run 5 consecutive resets and verify every single one completes in <50ms!
    for (let i = 0; i < 5; i++) {
      const resetRes = await apiJson(baseUrl, 'POST', '/api/v1/test/reset');
      expect(resetRes.status).toBe(200);
      expect(resetRes.data.ok).toBe(true);
      expect(resetRes.data.elapsed_ms).toBeLessThan(50);
    }

    const closeCode = await closedPromise;
    expect(closeCode).toBe(1012);

    // Verify enableTestReset: false returns 403
    const lockedDir = createUniqueTestDir('m1a-locked');
    const lockedSrv = createTelegramServer({
      port: 0,
      host: '127.0.0.1',
      dataDir: lockedDir,
      enableTestReset: false,
    });
    const lockedInfo = await lockedSrv.start();
    try {
      const denied = await apiJson(lockedInfo.baseUrl, 'POST', '/api/v1/test/reset');
      expect(denied.status).toBe(403);
    } finally {
      await lockedSrv.close();
      fs.rmSync(lockedDir, { recursive: true, force: true });
    }
  });

  it('verifies all 7 auth flows, Cloud 2FA password enforcement & 5-attempt lockout, Passkey/QR/Alipay ATO guards, and default OTP cooldown', async () => {
    // 1. Demo / Sandbox login
    const demo = await apiJson(baseUrl, 'POST', '/api/v1/auth/demo', { body: { slot: 0 } });
    expect(demo.status).toBe(200);
    expect(demo.data.user_id).toBe(1001);
    expect(demo.data.token).toBeTruthy();

    // 2. Phone OTP default cooldown (without passing cooldown_ms!) -> immediate resend returns 429!
    const phone = '+14155559988';
    const send1 = await apiJson(baseUrl, 'POST', '/api/v1/auth/phone/send-code', {
      body: { phone },
    });
    expect(send1.status).toBe(200);
    expect(send1.data.dev_code).toBe('12345');

    const cooldownHit = await apiJson(baseUrl, 'POST', '/api/v1/auth/phone/send-code', {
      body: { phone },
    });
    expect(cooldownHit.status).toBe(429);

    // Wrong OTP -> 401
    const badOtp = await apiJson(baseUrl, 'POST', '/api/v1/auth/phone/verify', {
      body: { phone, phone_code_hash: send1.data.phone_code_hash, code: '99999' },
    });
    expect(badOtp.status).toBe(401);

    // Valid OTP -> creates user & session
    const phoneAuth = await apiJson(baseUrl, 'POST', '/api/v1/auth/phone/verify', {
      body: {
        phone,
        phone_code_hash: send1.data.phone_code_hash,
        code: '12345',
        first_name: 'PhoneTester',
      },
    });
    expect(phoneAuth.status).toBe(200);
    const phoneToken = phoneAuth.data.token as string;

    // Enable salted scrypt Cloud 2FA on PhoneTester
    const set2fa = await apiJson(baseUrl, 'POST', '/api/v1/auth/2fa/set', {
      token: phoneToken,
      body: { new_password: 'MyCloudSecret#42', hint: 'Answer to everything' },
    });
    expect(set2fa.status).toBe(200);
    expect(set2fa.data.enabled).toBe(true);

    // Attempting to disable 2FA with empty body `{}` MUST be rejected with 401!
    const bypassDisable = await apiJson(baseUrl, 'POST', '/api/v1/auth/2fa/disable', {
      token: phoneToken,
      body: {},
    });
    expect(bypassDisable.status).toBe(401);

    // Cloud 2FA challenge brute-force lockout after 5 wrong attempts!
    const phone2 = '+8613800138001'; // Alice
    await apiJson(baseUrl, 'POST', '/api/v1/auth/2fa/set', {
      token: demo.data.token,
      body: { new_password: 'Alice2FA!Password', hint: 'Alice Hint' },
    });

    const lockOtp = await apiJson(baseUrl, 'POST', '/api/v1/auth/phone/send-code', {
      body: { phone: phone2, cooldown_ms: 0 },
    });
    const lockStep1 = await apiJson(baseUrl, 'POST', '/api/v1/auth/phone/verify', {
      body: { phone: phone2, phone_code_hash: lockOtp.data.phone_code_hash, code: '12345' },
    });
    expect(lockStep1.data.requires_2fa).toBe(true);

    for (let attempt = 1; attempt <= 4; attempt++) {
      const wrong = await apiJson(baseUrl, 'POST', '/api/v1/auth/2fa/verify', {
        body: { challenge_token: lockStep1.data.challenge_token, password: `wrong-${attempt}` },
      });
      expect(wrong.status).toBe(401);
    }
    const fifthAttempt = await apiJson(baseUrl, 'POST', '/api/v1/auth/2fa/verify', {
      body: { challenge_token: lockStep1.data.challenge_token, password: 'wrong-5' },
    });
    expect(fifthAttempt.status).toBe(429);

    // Fresh 2FA login succeeds with right password
    const aliceOtp2 = await apiJson(baseUrl, 'POST', '/api/v1/auth/phone/send-code', {
      body: { phone: phone2, cooldown_ms: 0 },
    });
    const aliceStep1 = await apiJson(baseUrl, 'POST', '/api/v1/auth/phone/verify', {
      body: { phone: phone2, phone_code_hash: aliceOtp2.data.phone_code_hash, code: '12345' },
    });
    const ok2fa = await apiJson(baseUrl, 'POST', '/api/v1/auth/2fa/verify', {
      body: { challenge_token: aliceStep1.data.challenge_token, password: 'Alice2FA!Password' },
    });
    expect(ok2fa.status).toBe(200);
    expect(ok2fa.data.user_id).toBe(1001);

    // Disable 2FA on Alice with valid current_password
    const disable2fa = await apiJson(baseUrl, 'POST', '/api/v1/auth/2fa/disable', {
      token: ok2fa.data.token,
      body: { current_password: 'Alice2FA!Password' },
    });
    expect(disable2fa.status).toBe(200);

    // 3. SVG QR Pairing Flow + Impersonation Guard
    const qrInit = await apiJson(baseUrl, 'POST', '/api/v1/auth/pair/init', { body: {} });
    expect(qrInit.status).toBe(200);
    expect(qrInit.data.svg).toContain('<svg');

    // Unauthenticated impersonation of Bob (1002) MUST fail with 401!
    const qrSpoof = await apiJson(baseUrl, 'POST', '/api/v1/auth/pair/accept', {
      body: { pair_id: qrInit.data.pair_id, user_id: 1002 },
    });
    expect(qrSpoof.status).toBe(401);

    const qrApprove = await apiJson(baseUrl, 'POST', '/api/v1/auth/pair/accept', {
      token: demo.data.token,
      body: { pair_id: qrInit.data.pair_id },
    });
    expect(qrApprove.status).toBe(200);

    const qrPoll = await apiJson(baseUrl, 'GET', `/api/v1/auth/pair/poll/${qrInit.data.pair_id}`);
    expect(qrPoll.status).toBe(200);
    expect(qrPoll.data.status).toBe('approved');
    expect(qrPoll.data.token).toBeTruthy();

    // 4. Username / Password Register & Login
    const reg = await apiJson(baseUrl, 'POST', '/api/v1/auth/register', {
      body: { username: 'charlie_dev', password: 'CharliePassword99', first_name: 'Charlie' },
    });
    expect(reg.status).toBe(201);
    const dupReg = await apiJson(baseUrl, 'POST', '/api/v1/auth/register', {
      body: { username: 'charlie_dev', password: 'CharliePassword99' },
    });
    expect(dupReg.status).toBe(409);

    const okPwdLogin = await apiJson(baseUrl, 'POST', '/api/v1/auth/login', {
      body: { username: 'charlie_dev', password: 'CharliePassword99' },
    });
    expect(okPwdLogin.status).toBe(200);

    // 5. Email OTP Flow
    const emSend = await apiJson(baseUrl, 'POST', '/api/v1/auth/email/send-code', {
      body: { email: 'dana@gpui.dev' },
    });
    expect(emSend.status).toBe(200);
    const emVer = await apiJson(baseUrl, 'POST', '/api/v1/auth/email/verify', {
      body: {
        email: 'dana@gpui.dev',
        code: emSend.data.dev_code,
        email_code_hash: emSend.data.email_code_hash,
      },
    });
    expect(emVer.status).toBe(200);

    // 6. Alipay QR Flow + Impersonation Guard + /poll?session_id= alias
    const aliStart = await apiJson(baseUrl, 'POST', '/api/v1/auth/alipay/start', { body: {} });
    expect(aliStart.status).toBe(200);
    const aliSpoof = await apiJson(baseUrl, 'POST', '/api/v1/auth/alipay/confirm', {
      body: { session_id: aliStart.data.session_id, user_id: 1002 },
    });
    expect(aliSpoof.status).toBe(401);
    const aliConfirm = await apiJson(baseUrl, 'POST', '/api/v1/auth/alipay/confirm', {
      body: { session_id: aliStart.data.session_id },
    });
    expect(aliConfirm.status).toBe(200);
    const aliPoll = await apiJson(
      baseUrl,
      'GET',
      `/api/v1/auth/alipay/poll?session_id=${encodeURIComponent(aliStart.data.session_id)}`,
    );
    expect(aliPoll.status).toBe(200);
    expect(aliPoll.data.status).toBe('confirmed');

    // 7. WebAuthn Passkey Flow + ATO Protection
    const unauthPkReg = await apiJson(baseUrl, 'POST', '/api/v1/account/passkeys/register', {
      body: { user_id: 1002, cred_id: 'evil_cred' },
    });
    expect(unauthPkReg.status).toBe(401);

    const pkChal1 = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/challenge', {
      body: { username: 'charlie_dev' },
    });
    // Omitting credential_id on verify MUST return 401 (no username-only ATO!)
    const unverifiedPk = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/verify', {
      body: { challenge_id: pkChal1.data.challenge_id },
    });
    expect(unverifiedPk.status).toBe(401);

    const pkChal2 = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/challenge', {
      body: { username: 'alice' },
    });
    const pkReg = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/register', {
      token: demo.data.token,
      body: { label: 'YubiKey 5C' },
    });
    expect(pkReg.status).toBe(201);
    const pkVer = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/verify', {
      body: { challenge_id: pkChal2.data.challenge_id, credential_id: pkReg.data.cred_id },
    });
    expect(pkVer.status).toBe(200);

    // SQL LIKE wildcard '%' in users/search must be escaped literally
    const pctSearch = await apiJson(baseUrl, 'GET', '/api/v1/users/search?q=%25', {
      token: demo.data.token,
    });
    expect(pctSearch.status).toBe(200);
    expect(pctSearch.data.users.length).toBe(0);

    // Logout revokes token immediately
    const logoutRes = await apiJson(baseUrl, 'POST', '/api/v1/auth/logout', {
      token: pkVer.data.token,
    });
    expect(logoutRes.status).toBe(200);
    const afterLogout = await apiJson(baseUrl, 'GET', '/api/v1/auth/me', {
      token: pkVer.data.token,
    });
    expect(afterLogout.status).toBe(401);
  });

  it('delivers real-time WebSocket PtsUpdate, WS VotePoll, deduplicates client_nonce, and never leaks deleted plaintext in get_difference', async () => {
    await apiJson(baseUrl, 'POST', '/api/v1/test/reset');

    const aliceAuth = await apiJson(baseUrl, 'POST', '/api/v1/auth/demo', { body: { slot: 0 } });
    const bobAuth = await apiJson(baseUrl, 'POST', '/api/v1/auth/demo', { body: { slot: 1 } });

    const aliceWs = await connectWsAuthenticated(wsUrl, aliceAuth.data.token);
    const bobWs = await connectWsAuthenticated(wsUrl, bobAuth.data.token);

    try {
      // Alice sends message over WS to DM 101 with client_nonce 424242
      aliceWs.ws.send(
        JSON.stringify({
          type: 'SendMessage',
          payload: {
            chat_id: 101,
            client_nonce: 424242,
            text: 'Real-time **WS Sync** message 🎉',
          },
        }),
      );

      const sendAck = await aliceWs.waitForFrame(
        (f) => f.type === 'SendAck' && f.payload.client_nonce === 424242,
      );
      expect(sendAck.payload.duplicate).toBe(false);
      const baselinePts = sendAck.payload.pts as number;

      const bobPush = await bobWs.waitForFrame(
        (f) =>
          f.type === 'PtsUpdate' &&
          f.payload.chat_id === 101 &&
          f.payload.pts === baselinePts,
      );
      expect(bobPush.payload.event.type).toBe('NewMessage');
      expect(bobPush.payload.event.data.flags.is_out).toBe(false);

      // Create a poll in DM 101 and have Bob vote via WebSocket `VotePoll`!
      const pollCreate = await apiJson(baseUrl, 'POST', '/api/v1/chats/101/polls', {
        token: aliceAuth.data.token,
        body: { question: 'WS VotePoll check?', options: ['Yes', 'No'] },
      });
      expect(pollCreate.status).toBe(201);
      const wsPollId = pollCreate.data.poll.poll_id as number;

      bobWs.ws.send(
        JSON.stringify({
          type: 'VotePoll',
          payload: {
            chat_id: 101,
            message_id: pollCreate.data.message.id,
            poll_id: wsPollId,
            option_ids: [0],
          },
        }),
      );

      const pollPtsFrame = await aliceWs.waitForFrame(
        (f) =>
          f.type === 'PtsUpdate' &&
          f.payload.chat_id === 101 &&
          f.payload.event.type === 'PollUpdated' &&
          f.payload.event.data.poll.poll_id === wsPollId,
      );
      expect(pollPtsFrame.payload.event.data.poll.total_voters).toBe(1);
      expect(pollPtsFrame.payload.event.data.poll.options[0].vote_count).toBe(1);

      // Verify deleted-for-everyone message NEVER leaks plaintext in sync/get_difference!
      const preSecretPts = pollPtsFrame.payload.pts as number;
      bobWs.ws.close();

      const secretMsg = await apiJson(baseUrl, 'POST', '/api/v1/chats/101/messages', {
        token: aliceAuth.data.token,
        body: { text: 'TOP_SECRET_DELETE_ME_9911' },
      });
      expect(secretMsg.status).toBe(201);

      await apiJson(
        baseUrl,
        'DELETE',
        `/api/v1/chats/101/messages/${secretMsg.data.message.id}?for_everyone=true`,
        { token: aliceAuth.data.token },
      );

      const diff = await apiJson(baseUrl, 'POST', '/api/v1/sync/get_difference', {
        token: bobAuth.data.token,
        body: { chat_id: 101, from_pts: preSecretPts },
      });
      expect(diff.status).toBe(200);
      expect(JSON.stringify(diff.data)).not.toContain('TOP_SECRET_DELETE_ME_9911');
      expect(
        diff.data.other_updates.some((u: any) => u.type === 'DeleteMessages'),
      ).toBe(true);
    } finally {
      aliceWs.ws.close();
      bobWs.ws.close();
    }
  });

  it('enforces group RBAC on delete-for-everyone & member management, double-entry XTR/TON invoices, media search tabs, and cleared history exclusion', async () => {
    await apiJson(baseUrl, 'POST', '/api/v1/test/reset');

    const alice = (await apiJson(baseUrl, 'POST', '/api/v1/auth/demo', { body: { slot: 0 } })).data
      .token; // 1001 (owner of chat 102)
    const bob = (await apiJson(baseUrl, 'POST', '/api/v1/auth/demo', { body: { slot: 1 } })).data
      .token; // 1002 (admin of chat 102)
    const linwei = (await apiJson(baseUrl, 'POST', '/api/v1/auth/demo', { body: { slot: 2 } })).data
      .token; // 1003 (regular member of chat 102)

    // Alice sends a message in group 102
    const ownerMsg = await apiJson(baseUrl, 'POST', '/api/v1/chats/102/messages', {
      token: alice,
      body: { text: 'Release Freeze Announcement' },
    });
    expect(ownerMsg.status).toBe(201);

    // Non-admin member Lin Wei (1003) CANNOT delete Alice's message for everyone -> 403!
    const unauthDel = await apiJson(
      baseUrl,
      'DELETE',
      `/api/v1/chats/102/messages/${ownerMsg.data.message.id}?for_everyone=true`,
      { token: linwei },
    );
    expect(unauthDel.status).toBe(403);

    // Non-admin Lin Wei CANNOT rename group 102 -> 403!
    const unauthRename = await apiJson(baseUrl, 'PATCH', '/api/v1/chats/102', {
      token: linwei,
      body: { title: 'Hijacked Title' },
    });
    expect(unauthRename.status).toBe(403);

    // Non-admin Lin Wei CANNOT kick Bob -> 403!
    const unauthKick = await apiJson(baseUrl, 'DELETE', '/api/v1/chats/102/members/1002', {
      token: linwei,
    });
    expect(unauthKick.status).toBe(403);

    // Admin Bob (1002) CANNOT kick Owner Alice (1001) -> 403!
    const kickOwner = await apiJson(baseUrl, 'DELETE', '/api/v1/chats/102/members/1001', {
      token: bob,
    });
    expect(kickOwner.status).toBe(403);

    // Malformed wire entity in message send must NOT return 500
    const malformedEntMsg = await apiJson(baseUrl, 'POST', '/api/v1/chats/101/messages', {
      token: alice,
      body: {
        text: 'Resilient wire entity check',
        entities: [{ offset: 0, length: 9, entity_type: { type: 'TextUrl' } }],
      },
    });
    expect(malformedEntMsg.status).toBe(201);

    // Double-entry Invoice payment (Bob creates XTR invoice -> Alice pays with Idempotency-Key -> Bob's balance increases!)
    const bobWalletBefore = await apiJson(baseUrl, 'GET', '/api/v1/wallet', { token: bob });
    const invCreate = await apiJson(baseUrl, 'POST', '/api/v1/chats/101/invoices', {
      token: bob,
      body: { title: 'Design Consulting', amount: 80, currency: 'XTR' },
    });
    expect(invCreate.status).toBe(201);

    const invPay1 = await apiJson(
      baseUrl,
      'POST',
      `/api/v1/chats/101/messages/${invCreate.data.message.id}/pay`,
      {
        token: alice,
        headers: { 'Idempotency-Key': 'idem-inv-pay-1' },
        body: {},
      },
    );
    expect(invPay1.status).toBe(200);
    expect(invPay1.data.balance).toBe(2420);

    // Replaying same Idempotency-Key returns exact cached receipt without double debit!
    const invPay2 = await apiJson(
      baseUrl,
      'POST',
      `/api/v1/chats/101/messages/${invCreate.data.message.id}/pay`,
      {
        token: alice,
        headers: { 'Idempotency-Key': 'idem-inv-pay-1' },
        body: {},
      },
    );
    expect(invPay2.status).toBe(200);
    expect(invPay2.data.receipt_id).toBe(invPay1.data.receipt_id);
    expect(invPay2.data.balance).toBe(2420);

    const bobWalletAfter = await apiJson(baseUrl, 'GET', '/api/v1/wallet', { token: bob });
    expect(bobWalletAfter.data.stars_balance).toBe(bobWalletBefore.data.stars_balance + 80);

    // TON Invoice payment debits ton_nano and credits payee!
    const tonInv = await apiJson(baseUrl, 'POST', '/api/v1/chats/101/invoices', {
      token: bob,
      body: { title: 'TON Relay Node', amount: 500_000_000, currency: 'TON' },
    });
    expect(tonInv.status).toBe(201);
    const tonPay = await apiJson(
      baseUrl,
      'POST',
      `/api/v1/chats/101/messages/${tonInv.data.message.id}/pay`,
      { token: alice, body: {} },
    );
    expect(tonPay.status).toBe(200);
    expect(tonPay.data.ton_nano).toBe(12_000_000_000);

    // Media upload classification across photo / audio / document search tabs
    const pngUpload = await apiJson(baseUrl, 'POST', '/api/v1/media/upload?filename=pic.png', {
      token: alice,
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      headers: { 'Content-Type': 'image/png' },
    });
    const mp3Upload = await apiJson(baseUrl, 'POST', '/api/v1/media/upload?filename=track.mp3', {
      token: alice,
      body: Buffer.from('ID3-mock-mp3'),
      headers: { 'Content-Type': 'audio/mpeg' },
    });
    const pdfUpload = await apiJson(baseUrl, 'POST', '/api/v1/media/upload?filename=spec.pdf', {
      token: alice,
      body: Buffer.from('%PDF-1.7'),
      headers: { 'Content-Type': 'application/pdf' },
    });

    await apiJson(baseUrl, 'POST', '/api/v1/chats/101/messages', {
      token: alice,
      body: { content: { type: 'Media', data: pngUpload.data } },
    });
    await apiJson(baseUrl, 'POST', '/api/v1/chats/101/messages', {
      token: alice,
      body: { content: { type: 'Media', data: mp3Upload.data } },
    });
    await apiJson(baseUrl, 'POST', '/api/v1/chats/101/messages', {
      token: alice,
      body: { content: { type: 'Media', data: pdfUpload.data } },
    });

    const mediaTab = await apiJson(baseUrl, 'GET', '/api/v1/search?chat_id=101&tab=media', {
      token: alice,
    });
    expect(mediaTab.data.hits.some((h: any) => h.text.includes('pic.png'))).toBe(true);
    expect(mediaTab.data.hits.some((h: any) => h.text.includes('spec.pdf'))).toBe(false);

    const musicTab = await apiJson(baseUrl, 'GET', '/api/v1/search?chat_id=101&tab=music', {
      token: alice,
    });
    expect(musicTab.data.hits.some((h: any) => h.text.includes('track.mp3'))).toBe(true);

    const filesTab = await apiJson(baseUrl, 'GET', '/api/v1/search?chat_id=101&tab=files', {
      token: alice,
    });
    expect(filesTab.data.hits.some((h: any) => h.text.includes('spec.pdf'))).toBe(true);
    expect(filesTab.data.hits.some((h: any) => h.text.includes('pic.png'))).toBe(false);

    // Local Clear History excludes cleared messages from both /search and /export!
    await apiJson(baseUrl, 'POST', '/api/v1/chats/101/messages', {
      token: alice,
      body: { text: 'CLEARED_MARKER_XYZ_888' },
    });
    await apiJson(baseUrl, 'POST', '/api/v1/chats/101/history/clear', {
      token: alice,
      body: { for_everyone: false },
    });
    const searchAfterClear = await apiJson(
      baseUrl,
      'GET',
      '/api/v1/search?q=CLEARED_MARKER_XYZ_888',
      { token: alice },
    );
    expect(searchAfterClear.data.hits.length).toBe(0);
    const exportAfterClear = await apiJson(baseUrl, 'GET', '/api/v1/chats/101/export?format=json', {
      token: alice,
    });
    expect(exportAfterClear.data.messages.length).toBe(0);
  });

  it('performs resumable SHA-256 CAS chunked uploads, HTTP 206/416 streaming, and blocks stored XSS on HTML/SVG uploads', async () => {
    const alice = (await apiJson(baseUrl, 'POST', '/api/v1/auth/demo', { body: { slot: 0 } })).data
      .token;

    const payload = Buffer.alloc(16_384);
    for (let i = 0; i < payload.length; i++) {
      payload[i] = (i * 31 + 17) & 0xff;
    }
    const expectedSha = crypto.createHash('sha256').update(payload).digest('hex');

    const init = await apiJson(baseUrl, 'POST', '/api/v1/media/upload/init', {
      token: alice,
      body: {
        file_name: 'sample.mp4',
        mime_type: 'video/mp4',
        total_size: payload.length,
        part_size: 4096,
        expected_sha256: expectedSha,
      },
    });
    expect(init.status).toBe(201);
    const uploadId = init.data.upload_id as string;

    // Test both canonical `/part/:partIdx` and `/:uploadId/:partIdx` aliases
    for (let p = 0; p < 4; p++) {
      const slice = payload.subarray(p * 4096, (p + 1) * 4096);
      const route =
        p % 2 === 0
          ? `/api/v1/media/upload/${uploadId}/part/${p}`
          : `/api/v1/media/upload/${uploadId}/${p}`;
      const partRes = await apiJson(baseUrl, 'PUT', route, {
        token: alice,
        body: slice,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      expect(partRes.status).toBe(200);
    }

    const complete = await apiJson(baseUrl, 'POST', '/api/v1/media/upload/complete', {
      token: alice,
      body: { upload_id: uploadId, width: 1280, height: 720, duration_seconds: 8.5 },
    });
    expect(complete.status).toBe(200);
    expect(complete.data.sha256).toBe(expectedSha);
    const fileId = complete.data.file_id as string;

    // HTTP 206 Partial Content Range Request via `/api/v1/media/stream/:fileId` alias
    const rangeRes = await fetch(`${baseUrl}/api/v1/media/stream/${fileId}`, {
      headers: { Range: 'bytes=100-299' },
    });
    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers.get('content-range')).toBe('bytes 100-299/16384');

    // Out-of-bounds Range -> 416
    const invalidRange = await fetch(`${baseUrl}/api/v1/media/${fileId}`, {
      headers: { Range: 'bytes=50000-60000' },
    });
    expect(invalidRange.status).toBe(416);

    // Uploaded HTML/SVG files MUST serve with Content-Disposition: attachment and X-Content-Type-Options: nosniff!
    const htmlUp = await apiJson(baseUrl, 'POST', '/api/v1/media/upload?filename=evil.html', {
      token: alice,
      body: Buffer.from('<script>alert(document.cookie)</script>', 'utf8'),
      headers: { 'Content-Type': 'text/html' },
    });
    expect(htmlUp.status).toBe(201);
    const streamHtml = await fetch(`${baseUrl}/api/v1/media/stream/${htmlUp.data.file_id}`);
    expect(streamHtml.headers.get('x-content-type-options')).toBe('nosniff');
    expect(streamHtml.headers.get('content-disposition')).toContain('attachment;');
  });

  it('verifies F16: genuine Magpie upstream proxy + probe + key preservation, Hermes SSE slash commands + safe export, Computer per-user provisioning, and Wallet Idempotency-Key', async () => {
    await apiJson(baseUrl, 'POST', '/api/v1/test/reset');
    const alice = (await apiJson(baseUrl, 'POST', '/api/v1/auth/demo', { body: { slot: 0 } })).data
      .token;
    const bob = (await apiJson(baseUrl, 'POST', '/api/v1/auth/demo', { body: { slot: 1 } })).data
      .token;

    // 1. Hermes: 61 commands with lowercase 'effort', SSE slash command without trajectory pollution, safe export redaction
    const cmds = await apiJson(baseUrl, 'GET', '/api/v1/hermes/commands', { token: alice });
    expect(cmds.status).toBe(200);
    expect(cmds.data.total).toBe(61);
    expect(cmds.data.commands.some((c: any) => c.name === 'effort')).toBe(true);
    expect(cmds.data.commands.some((c: any) => c.name === 'Effort')).toBe(false);

    // Normal agent turn first, then SSE slash command `/clear` -> session messages must be cleared (`[]`), NOT polluted!
    const normalTurn = await apiJson(baseUrl, 'POST', '/api/v1/hermes/turns', {
      token: alice,
      body: { prompt: 'Hello with email alice@private.org' },
    });
    expect(normalTurn.status).toBe(200);
    const sid = normalTurn.data.session_id as string;

    // Configure custom masking word matching a JSON structural key ("role", "content") and verify /export still returns valid JSON!
    await apiJson(baseUrl, 'PUT', '/api/v1/hermes/magpie/masking', {
      token: alice,
      body: { custom_words: ['role', 'content'] },
    });
    const exportedSess = await apiJson(
      baseUrl,
      'GET',
      `/api/v1/hermes/sessions/${sid}/export`,
      { token: alice },
    );
    expect(exportedSess.status).toBe(200);
    expect(Array.isArray(exportedSess.data.messages)).toBe(true);
    expect(JSON.stringify(exportedSess.data)).not.toContain('alice@private.org');
    // Reset custom_words
    await apiJson(baseUrl, 'PUT', '/api/v1/hermes/magpie/masking', {
      token: alice,
      body: { custom_words: [] },
    });

    const sseSlash = await fetch(`${baseUrl}/api/v1/hermes/turns`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${alice}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ session_id: sid, prompt: '/clear', stream: true }),
    });
    expect(sseSlash.status).toBe(200);
    const sseSlashText = await sseSlash.text();
    expect(sseSlashText).toContain('event: done');

    const clearedSess = await apiJson(baseUrl, 'GET', `/api/v1/hermes/sessions/${sid}`, {
      token: alice,
    });
    expect(clearedSess.data.messages.length).toBe(0);

    // Kanban create + DELETE + Heartbeat tick
    const cardRes = await apiJson(baseUrl, 'POST', '/api/v1/hermes/kanban/cards', {
      token: alice,
      body: { title: 'Temporary Card' },
    });
    expect(cardRes.status).toBe(201);
    const delCard = await apiJson(
      baseUrl,
      'DELETE',
      `/api/v1/hermes/kanban/cards/${cardRes.data.card.card_id}`,
      { token: alice },
    );
    expect(delCard.status).toBe(200);

    const hbTick = await apiJson(baseUrl, 'POST', '/api/v1/hermes/heartbeat/tick', {
      token: alice,
    });
    expect(hbTick.status).toBe(200);
    expect(hbTick.data.tick_count).toBeGreaterThanOrEqual(2);

    // 2. Magpie: Genuine Upstream Proxy + Probe + Key Preservation on PUT + Protected local_hermes + magpie:// import
    const delLocal = await apiJson(
      baseUrl,
      'DELETE',
      '/api/v1/hermes/magpie/providers/local_hermes',
      { token: alice },
    );
    expect(delLocal.status).toBe(400);

    let lastUpstreamAuthHeader = '';
    let lastUpstreamBody = '';
    const mockUpstream = http.createServer((req, res) => {
      lastUpstreamAuthHeader = String(req.headers.authorization ?? '');
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        lastUpstreamBody = Buffer.concat(chunks).toString('utf8');
        res.setHeader('Content-Type', 'application/json');
        if (req.url?.startsWith('/v1/models')) {
          res.end(JSON.stringify({ data: [{ id: 'mock-gpt-4o' }] }));
          return;
        }
        // Echo back the masked message so Magpie must unmask placeholders back for the local caller!
        const parsed = lastUpstreamBody ? JSON.parse(lastUpstreamBody) : {};
        const userText = parsed.messages?.[0]?.content ?? '';
        res.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: `Upstream echoed: ${userText}` } }],
          }),
        );
      });
    });

    await new Promise<void>((resolve) => mockUpstream.listen(0, '127.0.0.1', () => resolve()));
    const upstreamPort = (mockUpstream.address() as { port: number }).port;
    const upstreamBase = `http://127.0.0.1:${upstreamPort}/v1`;

    try {
      const secretKey = 'sk-proj-LiveUpstreamKey1234567890abcd';
      const createProv = await apiJson(baseUrl, 'POST', '/api/v1/hermes/magpie/providers', {
        token: alice,
        body: {
          provider_id: 'mock_openai',
          name: 'Mock OpenAI',
          api_mode: 'chat_completions',
          base_url: upstreamBase,
          default_model: 'mock-gpt-4o',
          api_key: secretKey,
        },
      });
      expect(createProv.status).toBe(201);
      expect(createProv.data.has_api_key).toBe(true);

      // Update provider WITHOUT resending api_key -> MUST preserve encrypted key!
      const updateProv = await apiJson(
        baseUrl,
        'PUT',
        '/api/v1/hermes/magpie/providers/mock_openai',
        {
          token: alice,
          body: { default_model: 'mock-gpt-4o-updated' },
        },
      );
      expect(updateProv.status).toBe(200);
      expect(updateProv.data.has_api_key).toBe(true);
      expect(updateProv.data.masked_key).toBe('sk-p...abcd');

      // Genuine /probe against live mockUpstream -> reachable: true & model list!
      const liveProbe = await apiJson(
        baseUrl,
        'POST',
        '/api/v1/hermes/magpie/providers/mock_openai/probe',
        { token: alice },
      );
      expect(liveProbe.status).toBe(200);
      expect(liveProbe.data.reachable).toBe(true);
      expect(liveProbe.data.models).toContain('mock-gpt-4o');

      // Genuine /v1/chat/completions proxy: masks PII before upstream & unmasks placeholder in response!
      const proxied = await apiJson(baseUrl, 'POST', '/v1/chat/completions', {
        token: alice,
        body: {
          provider_id: 'mock_openai',
          model: 'mock-gpt-4o',
          messages: [{ role: 'user', content: 'Email dave@corp.io about launch' }],
        },
      });
      expect(proxied.status).toBe(200);
      expect(lastUpstreamAuthHeader).toBe(`Bearer ${secretKey}`);
      expect(lastUpstreamBody).not.toContain('dave@corp.io');
      expect(lastUpstreamBody).toContain('[REDACTED_EMAIL_');
      expect(proxied.data.choices[0].message.content).toContain('dave@corp.io');
    } finally {
      mockUpstream.closeAllConnections?.();
      await new Promise<void>((resolve) => mockUpstream.close(() => resolve()));
    }

    // Now mockUpstream is CLOSED -> /probe MUST report reachable: false, and /v1/chat/completions with allow_local_fallback: false MUST return 502!
    const deadProbe = await apiJson(
      baseUrl,
      'POST',
      '/api/v1/hermes/magpie/providers/mock_openai/probe',
      { token: alice },
    );
    expect(deadProbe.status).toBe(200);
    expect(deadProbe.data.reachable).toBe(false);

    await apiJson(baseUrl, 'PUT', '/api/v1/hermes/magpie/state', {
      token: alice,
      body: { allow_local_fallback: false },
    });
    const deadCompletion = await apiJson(baseUrl, 'POST', '/v1/chat/completions', {
      token: alice,
      body: {
        provider_id: 'mock_openai',
        model: 'mock-gpt-4o',
        messages: [{ role: 'user', content: 'Should 502 when fallback disabled' }],
      },
    });
    expect(deadCompletion.status).toBe(502);

    // magpie:// URI import with body.raw
    const uriImport = await apiJson(baseUrl, 'POST', '/api/v1/hermes/magpie/import', {
      token: alice,
      body: { raw: 'magpie://import?preset=deepseek&api_key=sk-deepseek1234567890' },
    });
    expect(uriImport.status).toBe(200);
    expect(uriImport.data.imported).toContain('deepseek');

    // 3. Computer Workbench: Bob (1002) ALSO has isolated sandbox:default & emergency_takeover alias works in <10ms!
    const bobComputers = await apiJson(baseUrl, 'GET', '/api/v1/computers', { token: bob });
    expect(bobComputers.status).toBe(200);
    expect(bobComputers.data.computers.some((c: any) => c.node_id === 'sandbox:default')).toBe(
      true,
    );

    const bobTakeover = await apiJson(
      baseUrl,
      'POST',
      '/api/v1/computer/lease/emergency_takeover',
      { token: bob, body: {} },
    );
    expect(bobTakeover.status).toBe(200);
    expect(bobTakeover.data.status).toBe('human_takeover');
    expect(bobTakeover.data.latency_sub_10ms).toBe(true);

    // 4. Wallet Idempotency-Key deduplication + recipient validation (404 non-existent, 400 self-transfer)
    const top1 = await apiJson(baseUrl, 'POST', '/api/v1/wallet/stars/topup', {
      token: alice,
      headers: { 'Idempotency-Key': 'topup-idem-42' },
      body: { amount: 300 },
    });
    expect(top1.status).toBe(200);
    expect(top1.data.stars_balance).toBe(2800);

    const top2 = await apiJson(baseUrl, 'POST', '/api/v1/wallet/stars/topup', {
      token: alice,
      headers: { 'Idempotency-Key': 'topup-idem-42' },
      body: { amount: 300 },
    });
    expect(top2.status).toBe(200);
    expect(top2.data.stars_balance).toBe(2800); // Deduped!

    const selfGift = await apiJson(baseUrl, 'POST', '/api/v1/wallet/gift', {
      token: alice,
      body: { to_user_id: 1001, amount_stars: 50 },
    });
    expect(selfGift.status).toBe(400);

    const ghostGift = await apiJson(baseUrl, 'POST', '/api/v1/wallet/gift', {
      token: alice,
      body: { to_user_id: 999999, amount_stars: 50 },
    });
    expect(ghostGift.status).toBe(404);

    const okGift1 = await apiJson(baseUrl, 'POST', '/api/v1/wallet/stars/send-gift', {
      token: alice,
      headers: { 'Idempotency-Key': 'gift-idem-7' },
      body: { to_user_id: 1002, chat_id: 101, amount_stars: 100, message: 'Great work!' },
    });
    expect(okGift1.status).toBe(200);
    expect(okGift1.data.stars_balance).toBe(2700);

    const okGift2 = await apiJson(baseUrl, 'POST', '/api/v1/wallet/stars/send-gift', {
      token: alice,
      headers: { 'Idempotency-Key': 'gift-idem-7' },
      body: { to_user_id: 1002, chat_id: 101, amount_stars: 100, message: 'Great work!' },
    });
    expect(okGift2.status).toBe(200);
    expect(okGift2.data.stars_balance).toBe(2700); // Deduped!
  });
});
