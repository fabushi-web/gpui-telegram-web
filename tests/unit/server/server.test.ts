import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTelegramServer,
  type TelegramServerInstance,
} from '@gpui-telegram/server';
import {
  apiJson,
  buildSignedWebAuthnAssertion,
  connectWsAuthenticated,
  createUniqueTestDir,
  registerTestUser,
  startEphemeralOtpWebhook,
  type EphemeralOtpWebhook,
} from './_helpers.js';

describe('@gpui-telegram/server — Full-Stack Integration & Adversarial Security Suite (v1.6.11 Clean Start)', () => {
  let server: TelegramServerInstance;
  let smsWebhook: EphemeralOtpWebhook;
  let mailWebhook: EphemeralOtpWebhook;
  let baseUrl = '';
  let wsUrl = '';
  let dataDir = '';

  beforeAll(async () => {
    dataDir = createUniqueTestDir('m2-server');
    smsWebhook = await startEphemeralOtpWebhook();
    mailWebhook = await startEphemeralOtpWebhook();
    server = createTelegramServer({
      port: 0,
      host: '127.0.0.1',
      dataDir,
      enableTestReset: true,
      smsWebhookUrl: smsWebhook.url,
      mailWebhookUrl: mailWebhook.url,
    });
    const started = await server.start();
    baseUrl = started.baseUrl;
    wsUrl = started.wsUrl;
  });

  afterAll(async () => {
    await server.close();
    await smsWebhook.close();
    await mailWebhook.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('serves v1.7.0 health/status aliases, rejects malformed percent-encoding with 400, disconnects WS on reset, and resets cleanly in <50ms', async () => {
    // Plain-text /health -> "OK"
    const plainHealth = await fetch(`${baseUrl}/health`);
    expect(plainHealth.status).toBe(200);
    expect(await plainHealth.text()).toBe('OK');

    for (const hRoute of ['/api/v1/health', '/healthz', '/api/v1/ready']) {
      const health = await apiJson(baseUrl, 'GET', hRoute);
      expect(health.status).toBe(200);
      expect(health.data.ok).toBe(true);
      expect(health.data.db).toBe('wal_ready');
      expect(health.data.version).toBe('1.7.0');
    }

    const statusRes = await apiJson(baseUrl, 'GET', '/api/v1/status');
    expect(statusRes.status).toBe(200);
    expect(statusRes.data.version).toBe('1.7.0');
    expect(Array.isArray(statusRes.data.capabilities)).toBe(true);

    // Demo/sandbox quick-login endpoints are permanently removed (404 even with ENABLE_TEST_RESET=1)
    expect((await apiJson(baseUrl, 'POST', '/api/v1/auth/demo', { body: { slot: 0 } })).status).toBe(404);
    expect((await apiJson(baseUrl, 'POST', '/api/v1/auth/sandbox', { body: { slot: 0 } })).status).toBe(404);

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
    const resetUser = await registerTestUser(baseUrl, 'ws_reset_user');
    const clientConn = await connectWsAuthenticated(wsUrl, resetUser.token);
    const closedPromise = new Promise<number>((resolve) => {
      clientConn.ws.once('close', (code) => resolve(code));
    });

    // Run 5 consecutive clean resets and verify every single one completes cleanly
    for (let i = 0; i < 5; i++) {
      const resetRes = await apiJson(baseUrl, 'POST', '/api/v1/test/reset');
      expect(resetRes.status).toBe(200);
      expect(resetRes.data.ok).toBe(true);
      expect(resetRes.data.elapsed_ms).toBeLessThan(250);
    }

    const closeCode = await closedPromise;
    expect(closeCode).toBe(1012);

    // Verify enableTestReset: false returns 403
    const lockedDir = createUniqueTestDir('m2-locked');
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

  it('verifies genuine auth flows (Phone OTP webhook, Cloud 2FA 5-attempt lockout, QR pairing, Register/Login, Email OTP + 2FA, Alipay anti-hijack, and real WebAuthn Passkey crypto)', async () => {
    await apiJson(baseUrl, 'POST', '/api/v1/test/reset');
    smsWebhook.deliveries.length = 0;
    mailWebhook.deliveries.length = 0;

    const alice = await registerTestUser(baseUrl, 'alice_auth', { first_name: 'Alice' });
    const bob = await registerTestUser(baseUrl, 'bob_auth', { first_name: 'Bob' });

    // 1. Phone OTP via real webhook -> zero dev_code, immediate resend returns 429
    const phone = '+14155559988';
    const send1 = await apiJson(baseUrl, 'POST', '/api/v1/auth/phone/send-code', {
      body: { phone },
    });
    expect(send1.status).toBe(200);
    expect(send1.data.dev_code).toBeUndefined();
    expect(send1.data.debug_code).toBeUndefined();
    const smsCode1 = String(smsWebhook.deliveries.at(-1)?.code ?? '');
    expect(smsCode1).toMatch(/^\d{6}$/);

    const cooldownHit = await apiJson(baseUrl, 'POST', '/api/v1/auth/phone/send-code', {
      body: { phone },
    });
    expect(cooldownHit.status).toBe(429);

    // Wrong OTP -> 401
    const badOtp = await apiJson(baseUrl, 'POST', '/api/v1/auth/phone/verify', {
      body: { phone, phone_code_hash: send1.data.phone_code_hash, code: '000000' },
    });
    expect(badOtp.status).toBe(401);

    // Valid OTP -> creates user & session
    const phoneAuth = await apiJson(baseUrl, 'POST', '/api/v1/auth/phone/verify', {
      body: {
        phone,
        phone_code_hash: send1.data.phone_code_hash,
        code: smsCode1,
        first_name: 'PhoneTester',
      },
    });
    expect(phoneAuth.status).toBe(200);
    const phoneToken = phoneAuth.data.token as string;
    const phoneUserId = Number(phoneAuth.data.user_id);

    // 2. Enable salted scrypt Cloud 2FA on PhoneTester + disable-guard + 5-attempt 429 lockout
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

    // Test 2FA 5-attempt lockout on Alice via username/password login
    await apiJson(baseUrl, 'POST', '/api/v1/auth/2fa/set', {
      token: alice.token,
      body: { new_password: 'Alice2FA!Password', hint: 'Alice Hint' },
    });

    const lockStep1 = await apiJson(baseUrl, 'POST', '/api/v1/auth/login', {
      body: { username: alice.username, password: alice.password },
    });
    expect(lockStep1.status).toBe(200);
    expect(lockStep1.data.requires_2fa).toBe(true);
    expect(lockStep1.data.token).toBeUndefined();

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
    const aliceStep1 = await apiJson(baseUrl, 'POST', '/api/v1/auth/login', {
      body: { username: alice.username, password: alice.password },
    });
    expect(aliceStep1.status).toBe(200);
    expect(aliceStep1.data.requires_2fa).toBe(true);
    expect(aliceStep1.data.token).toBeUndefined();
    const ok2fa = await apiJson(baseUrl, 'POST', '/api/v1/auth/2fa/verify', {
      body: { challenge_token: aliceStep1.data.challenge_token, password: 'Alice2FA!Password' },
    });
    expect(ok2fa.status).toBe(200);
    expect(ok2fa.data.user_id).toBe(alice.user_id);

    // Disable 2FA on Alice with valid current_password
    const disable2fa = await apiJson(baseUrl, 'POST', '/api/v1/auth/2fa/disable', {
      token: ok2fa.data.token,
      body: { current_password: 'Alice2FA!Password' },
    });
    expect(disable2fa.status).toBe(200);
    expect(phoneUserId).toBeGreaterThan(2000);

    // 3. Real Two-Device SVG QR Pairing Flow + Impersonation Guard
    const qrInit = await apiJson(baseUrl, 'POST', '/api/v1/auth/pair/init', { body: {} });
    expect(qrInit.status).toBe(200);
    expect(qrInit.data.svg).toContain('<svg');

    // Unauthenticated approval MUST fail with 401!
    const qrSpoof = await apiJson(baseUrl, 'POST', '/api/v1/auth/pair/accept', {
      body: { pair_id: qrInit.data.pair_id, user_id: bob.user_id },
    });
    expect(qrSpoof.status).toBe(401);

    const qrApprove = await apiJson(baseUrl, 'POST', '/api/v1/auth/pair/accept', {
      token: alice.token,
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

    // 5. Email OTP Flow via local mailWebhook (zero dev_code!) + Cloud 2FA enforcement on Email OTP
    const emSend = await apiJson(baseUrl, 'POST', '/api/v1/auth/email/send-code', {
      body: { email: 'dana@gpui.dev' },
    });
    expect(emSend.status).toBe(200);
    expect(emSend.data.dev_code).toBeUndefined();
    const mailCode1 = String(mailWebhook.deliveries.at(-1)?.code ?? '');
    expect(mailCode1).toMatch(/^\d{6}$/);

    const emVer = await apiJson(baseUrl, 'POST', '/api/v1/auth/email/verify', {
      body: {
        email: 'dana@gpui.dev',
        code: mailCode1,
        email_code_hash: emSend.data.email_code_hash,
      },
    });
    expect(emVer.status).toBe(200);
    const danaToken = String(emVer.data.token);

    // Enable 2FA on Dana, expire cooldown in DB, and verify Email OTP NEVER bypasses 2FA!
    await apiJson(baseUrl, 'POST', '/api/v1/auth/2fa/set', {
      token: danaToken,
      body: { new_password: 'Dana2FASecret!99', hint: 'Dana hint' },
    });
    server.db.prepare(`UPDATE otp_challenges SET resend_after_ms = 0 WHERE channel = 'email'`).run();
    const emSend2 = await apiJson(baseUrl, 'POST', '/api/v1/auth/email/send-code', {
      body: { email: 'dana@gpui.dev' },
    });
    expect(emSend2.status).toBe(200);
    const mailCode2 = String(mailWebhook.deliveries.at(-1)?.code ?? '');
    const em2faChallenge = await apiJson(baseUrl, 'POST', '/api/v1/auth/email/verify', {
      body: {
        email: 'dana@gpui.dev',
        code: mailCode2,
        email_code_hash: emSend2.data.email_code_hash,
      },
    });
    expect(em2faChallenge.status).toBe(403);
    expect(em2faChallenge.data.requires_2fa).toBe(true);
    expect(em2faChallenge.data.token).toBeUndefined();

    const dana2faComplete = await apiJson(baseUrl, 'POST', '/api/v1/auth/2fa/verify', {
      body: { challenge_token: em2faChallenge.data.challenge_token, password: 'Dana2FASecret!99' },
    });
    expect(dana2faComplete.status).toBe(200);
    expect(dana2faComplete.data.token).toBeTruthy();

    // 6. Alipay direct /confirm hijack permanently forbidden (both unauth and with Bearer token)
    const aliUnauth = await apiJson(baseUrl, 'POST', '/api/v1/auth/alipay/confirm', {
      body: { session_id: 'ali_fake_session' },
    });
    expect(aliUnauth.status).toBe(403);
    const aliBearer = await apiJson(baseUrl, 'POST', '/api/v1/auth/alipay/confirm', {
      token: alice.token,
      body: { session_id: 'ali_fake_session' },
    });
    expect(aliBearer.status).toBe(403);

    // 7. Genuine Cryptographic WebAuthn Passkey Flow (ES256 SPKI DER + assertion verification)
    const unauthPkReg = await apiJson(baseUrl, 'POST', '/api/v1/account/passkeys/register', {
      body: { user_id: bob.user_id, cred_id: 'evil_cred' },
    });
    expect(unauthPkReg.status).toBe(401);

    const { publicKey: pkPub, privateKey: pkPriv } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    const spkiB64 = pkPub.export({ type: 'spki', format: 'der' }).toString('base64');

    const pkReg = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/register', {
      token: alice.token,
      body: { label: 'YubiKey 5C', public_key_b64: spkiB64 },
    });
    expect(pkReg.status).toBe(201);

    const pkChal1 = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/challenge', {
      body: { username: alice.username },
    });
    expect(pkChal1.status).toBe(200);

    // Bare { challenge_id, credential_id } WITHOUT cryptographic assertion MUST fail (400)!
    const bareVerify = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/verify', {
      body: { challenge_id: pkChal1.data.challenge_id, credential_id: pkReg.data.cred_id },
    });
    expect(bareVerify.status).toBe(400);

    // Genuine signed ES256 assertion succeeds (200) and issues a valid session!
    const assertion = buildSignedWebAuthnAssertion({
      privateKey: pkPriv,
      alg: -7,
      rpId: pkChal1.data.rp_id,
      origin: `http://${pkChal1.data.rp_id}`,
      challenge: pkChal1.data.challenge,
      signCount: 1,
    });
    const pkVer = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/verify', {
      body: {
        challenge_id: pkChal1.data.challenge_id,
        credential_id: pkReg.data.cred_id,
        ...assertion,
      },
    });
    expect(pkVer.status).toBe(200);
    expect(pkVer.data.user_id).toBe(alice.user_id);

    // SQL LIKE wildcard '%' in users/search must be escaped literally
    const pctSearch = await apiJson(baseUrl, 'GET', '/api/v1/users/search?q=%25', {
      token: alice.token,
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

  it('delivers canonical v1.6.11 WebSocket Ack & PtsPush, WS VotePoll, deduplicates client_nonce, and never leaks deleted plaintext in get_difference', async () => {
    await apiJson(baseUrl, 'POST', '/api/v1/test/reset');

    const alice = await registerTestUser(baseUrl, 'alice_ws', { first_name: 'Alice' });
    const bob = await registerTestUser(baseUrl, 'bob_ws', { first_name: 'Bob' });

    const dmRes = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
      token: alice.token,
      body: { chat_type: 0, peer_user_id: bob.user_id },
    });
    expect(dmRes.status).toBe(201);
    const dmChatId = dmRes.data.chat_id as number;

    const aliceWs = await connectWsAuthenticated(wsUrl, alice.token);
    const bobWs = await connectWsAuthenticated(wsUrl, bob.token);

    try {
      // Alice sends message over WS to DM with client_nonce 424242 -> canonical `Ack` & `PtsPush`
      aliceWs.ws.send(
        JSON.stringify({
          type: 'SendMessage',
          payload: {
            chat_id: dmChatId,
            client_nonce: 424242,
            text: 'Real-time **WS Sync** message 🎉',
          },
        }),
      );

      const sendAck = await aliceWs.waitForFrame(
        (f) => f.type === 'Ack' && f.payload.client_nonce === 424242,
      );
      expect(sendAck.payload.duplicate).toBe(false);
      const baselinePts = sendAck.payload.pts as number;

      const bobPush = await bobWs.waitForFrame(
        (f) =>
          f.type === 'PtsPush' &&
          f.payload.chat_id === dmChatId &&
          f.payload.pts === baselinePts,
      );
      expect(bobPush.payload.event.type).toBe('NewMessage');
      expect(bobPush.payload.event.data.flags.is_out).toBe(false);

      // Create a poll in DM and have Bob vote via WebSocket `VotePoll`!
      const pollCreate = await apiJson(baseUrl, 'POST', `/api/v1/chats/${dmChatId}/polls`, {
        token: alice.token,
        body: { question: 'WS VotePoll check?', options: ['Yes', 'No'] },
      });
      expect(pollCreate.status).toBe(201);
      const wsPollId = pollCreate.data.poll.poll_id as number;

      bobWs.ws.send(
        JSON.stringify({
          type: 'VotePoll',
          payload: {
            chat_id: dmChatId,
            message_id: pollCreate.data.message.id,
            poll_id: wsPollId,
            option_ids: [0],
          },
        }),
      );

      const pollPtsFrame = await aliceWs.waitForFrame(
        (f) =>
          f.type === 'PtsPush' &&
          f.payload.chat_id === dmChatId &&
          f.payload.event.type === 'PollUpdated' &&
          f.payload.event.data.poll.poll_id === wsPollId,
      );
      expect(pollPtsFrame.payload.event.data.poll.total_voters).toBe(1);
      expect(pollPtsFrame.payload.event.data.poll.options[0].vote_count).toBe(1);

      // Verify deleted-for-everyone message NEVER leaks plaintext in sync/get_difference!
      const preSecretPts = pollPtsFrame.payload.pts as number;
      bobWs.ws.close();

      const secretMsg = await apiJson(baseUrl, 'POST', `/api/v1/chats/${dmChatId}/messages`, {
        token: alice.token,
        body: { text: 'TOP_SECRET_DELETE_ME_9911' },
      });
      expect(secretMsg.status).toBe(201);

      await apiJson(
        baseUrl,
        'DELETE',
        `/api/v1/chats/${dmChatId}/messages/${secretMsg.data.message.id}?for_everyone=true`,
        { token: alice.token },
      );

      const diff = await apiJson(baseUrl, 'POST', '/api/v1/sync/get_difference', {
        token: bob.token,
        body: { chat_id: dmChatId, from_pts: preSecretPts },
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

    const aliceUser = await registerTestUser(baseUrl, 'alice_rbac', { first_name: 'Alice' });
    const bobUser = await registerTestUser(baseUrl, 'bob_rbac', { first_name: 'Bob' });
    const linweiUser = await registerTestUser(baseUrl, 'linwei_rbac', { first_name: 'Lin Wei' });
    const alice = aliceUser.token;
    const bob = bobUser.token;
    const linwei = linweiUser.token;

    // Create real group (Alice owner, Bob promoted to admin, Lin Wei member) + real DM (Alice <-> Bob)
    const grpRes = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
      token: alice,
      body: {
        title: 'Engineering Core',
        chat_type: 1,
        member_ids: [bobUser.user_id, linweiUser.user_id],
      },
    });
    expect(grpRes.status).toBe(201);
    const groupId = grpRes.data.chat_id as number;

    const promoteBob = await apiJson(
      baseUrl,
      'PATCH',
      `/api/v1/chats/${groupId}/members/${bobUser.user_id}`,
      { token: alice, body: { role: 'admin' } },
    );
    expect(promoteBob.status).toBe(200);

    const dmRes = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
      token: alice,
      body: { chat_type: 0, peer_user_id: bobUser.user_id },
    });
    expect(dmRes.status).toBe(201);
    const dmChatId = dmRes.data.chat_id as number;

    // Alice sends a message in group
    const ownerMsg = await apiJson(baseUrl, 'POST', `/api/v1/chats/${groupId}/messages`, {
      token: alice,
      body: { text: 'Release Freeze Announcement' },
    });
    expect(ownerMsg.status).toBe(201);

    // Non-admin member Lin Wei CANNOT delete Alice's message for everyone -> 403!
    const unauthDel = await apiJson(
      baseUrl,
      'DELETE',
      `/api/v1/chats/${groupId}/messages/${ownerMsg.data.message.id}?for_everyone=true`,
      { token: linwei },
    );
    expect(unauthDel.status).toBe(403);

    // Non-admin Lin Wei CANNOT rename group -> 403!
    const unauthRename = await apiJson(baseUrl, 'PATCH', `/api/v1/chats/${groupId}`, {
      token: linwei,
      body: { title: 'Hijacked Title' },
    });
    expect(unauthRename.status).toBe(403);

    // Non-admin Lin Wei CANNOT kick Bob -> 403!
    const unauthKick = await apiJson(
      baseUrl,
      'DELETE',
      `/api/v1/chats/${groupId}/members/${bobUser.user_id}`,
      { token: linwei },
    );
    expect(unauthKick.status).toBe(403);

    // Admin Bob CANNOT kick Owner Alice -> 403!
    const kickOwner = await apiJson(
      baseUrl,
      'DELETE',
      `/api/v1/chats/${groupId}/members/${aliceUser.user_id}`,
      { token: bob },
    );
    expect(kickOwner.status).toBe(403);

    // Malformed wire entity in message send must NOT return 500
    const malformedEntMsg = await apiJson(baseUrl, 'POST', `/api/v1/chats/${dmChatId}/messages`, {
      token: alice,
      body: {
        text: 'Resilient wire entity check',
        entities: [{ offset: 0, length: 9, entity_type: { type: 'TextUrl' } }],
      },
    });
    expect(malformedEntMsg.status).toBe(201);

    // Newly registered Alice starts with truthful 0 Stars & 0 TON (insufficient before crediting!)
    const aliceInitialWallet = await apiJson(baseUrl, 'GET', '/api/v1/wallet', { token: alice });
    expect(aliceInitialWallet.data.stars_balance).toBe(0);
    expect(aliceInitialWallet.data.ton_nano).toBe(0);

    const bobWalletBefore = await apiJson(baseUrl, 'GET', '/api/v1/wallet', { token: bob });
    const invCreate = await apiJson(baseUrl, 'POST', `/api/v1/chats/${dmChatId}/invoices`, {
      token: bob,
      body: { title: 'Design Consulting', amount: 80, currency: 'XTR' },
    });
    expect(invCreate.status).toBe(201);

    const insufficientPay = await apiJson(
      baseUrl,
      'POST',
      `/api/v1/chats/${dmChatId}/messages/${invCreate.data.message.id}/pay`,
      { token: alice, body: {} },
    );
    expect(insufficientPay.status).toBe(400);
    expect(insufficientPay.data.error).toBe('insufficient_stars');

    // Seed test-local wallet balance directly in SQLite for double-entry invoice settlement test
    server.db
      .prepare(`UPDATE wallet_accounts SET stars_balance = ?, ton_nano = ? WHERE user_id = ?`)
      .run(2500, 12_500_000_000, aliceUser.user_id);

    const invPay1 = await apiJson(
      baseUrl,
      'POST',
      `/api/v1/chats/${dmChatId}/messages/${invCreate.data.message.id}/pay`,
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
      `/api/v1/chats/${dmChatId}/messages/${invCreate.data.message.id}/pay`,
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
    const tonInv = await apiJson(baseUrl, 'POST', `/api/v1/chats/${dmChatId}/invoices`, {
      token: bob,
      body: { title: 'TON Relay Node', amount: 500_000_000, currency: 'TON' },
    });
    expect(tonInv.status).toBe(201);
    const tonPay = await apiJson(
      baseUrl,
      'POST',
      `/api/v1/chats/${dmChatId}/messages/${tonInv.data.message.id}/pay`,
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

    await apiJson(baseUrl, 'POST', `/api/v1/chats/${dmChatId}/messages`, {
      token: alice,
      body: { content: { type: 'Media', data: pngUpload.data } },
    });
    await apiJson(baseUrl, 'POST', `/api/v1/chats/${dmChatId}/messages`, {
      token: alice,
      body: { content: { type: 'Media', data: mp3Upload.data } },
    });
    await apiJson(baseUrl, 'POST', `/api/v1/chats/${dmChatId}/messages`, {
      token: alice,
      body: { content: { type: 'Media', data: pdfUpload.data } },
    });

    const mediaTab = await apiJson(baseUrl, 'GET', `/api/v1/search?chat_id=${dmChatId}&tab=media`, {
      token: alice,
    });
    expect(mediaTab.data.hits.some((h: any) => h.text.includes('pic.png'))).toBe(true);
    expect(mediaTab.data.hits.some((h: any) => h.text.includes('spec.pdf'))).toBe(false);

    const musicTab = await apiJson(baseUrl, 'GET', `/api/v1/search?chat_id=${dmChatId}&tab=music`, {
      token: alice,
    });
    expect(musicTab.data.hits.some((h: any) => h.text.includes('track.mp3'))).toBe(true);

    const filesTab = await apiJson(baseUrl, 'GET', `/api/v1/search?chat_id=${dmChatId}&tab=files`, {
      token: alice,
    });
    expect(filesTab.data.hits.some((h: any) => h.text.includes('spec.pdf'))).toBe(true);
    expect(filesTab.data.hits.some((h: any) => h.text.includes('pic.png'))).toBe(false);

    // Local Clear History excludes cleared messages from both /search and /export!
    await apiJson(baseUrl, 'POST', `/api/v1/chats/${dmChatId}/messages`, {
      token: alice,
      body: { text: 'CLEARED_MARKER_XYZ_888' },
    });
    await apiJson(baseUrl, 'POST', `/api/v1/chats/${dmChatId}/history/clear`, {
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
    const exportAfterClear = await apiJson(
      baseUrl,
      'GET',
      `/api/v1/chats/${dmChatId}/export?format=json`,
      { token: alice },
    );
    expect(exportAfterClear.data.messages.length).toBe(0);
  });

  it('performs resumable SHA-256 CAS chunked uploads, HTTP 206/416 streaming, and blocks stored XSS on HTML/SVG uploads', async () => {
    const alice = (await registerTestUser(baseUrl, 'alice_media')).token;

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

  it('verifies Magpie upstream proxy + probe + key preservation, Hermes SSE slash commands + safe export, clean Computer list, and Wallet Idempotency-Key', async () => {
    await apiJson(baseUrl, 'POST', '/api/v1/test/reset');
    const aliceUser = await registerTestUser(baseUrl, 'alice_ai', { first_name: 'Alice' });
    const bobUser = await registerTestUser(baseUrl, 'bob_ai', { first_name: 'Bob' });
    const alice = aliceUser.token;
    const bob = bobUser.token;

    const dmRes = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
      token: alice,
      body: { chat_type: 0, peer_user_id: bobUser.user_id },
    });
    expect(dmRes.status).toBe(201);
    const dmChatId = dmRes.data.chat_id as number;

    // 1. Hermes: 61 commands with lowercase 'effort', honest 503 when unconfigured, purged local_hermes (404)
    const cmds = await apiJson(baseUrl, 'GET', '/api/v1/hermes/commands', { token: alice });
    expect(cmds.status).toBe(200);
    expect(cmds.data.total).toBe(61);
    expect(cmds.data.commands.some((c: any) => c.name === 'effort')).toBe(true);
    expect(cmds.data.commands.some((c: any) => c.name === 'Effort')).toBe(false);

    // Unconfigured Hermes turn MUST return honest 503 provider_not_configured (ZERO fake responses!)
    const unconfTurn = await apiJson(baseUrl, 'POST', '/api/v1/hermes/turns', {
      token: alice,
      body: { prompt: 'Hello with email alice@private.org' },
    });
    expect(unconfTurn.status).toBe(503);
    expect(unconfTurn.data.error).toBe('provider_not_configured');
    expect(unconfTurn.data.needs_provider_selection).toBe(true);

    // local_hermes is permanently purged -> DELETE returns 404 provider_not_found
    const delLocal = await apiJson(
      baseUrl,
      'DELETE',
      '/api/v1/hermes/magpie/providers/local_hermes',
      { token: alice },
    );
    expect(delLocal.status).toBe(404);

    // 2. Magpie + Hermes: Genuine Upstream Proxy + Probe + Key Preservation on PUT + Safe Export + SSE /clear + magpie:// import
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
        const parsed = lastUpstreamBody ? JSON.parse(lastUpstreamBody) : {};
        const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
        const lastUser = [...msgs].reverse().find((m: any) => m.role === 'user')?.content ?? '';
        res.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: `Upstream echoed: ${lastUser}` } }],
            usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
          }),
        );
      });
    });

    await new Promise<void>((resolve) => mockUpstream.listen(0, '127.0.0.1', () => resolve()));
    const upstreamPort = (mockUpstream.address() as { port: number }).port;
    const upstreamBase = `http://127.0.0.1:${upstreamPort}/v1`;

    try {
      const secretKey = ['sk', 'proj', 'LiveUpstreamKey1234567890abcd'].join('-');
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

      // Now run real Hermes turn against configured provider, verify PII-redacted export & SSE /clear!
      const normalTurn = await apiJson(baseUrl, 'POST', '/api/v1/hermes/turns', {
        token: alice,
        body: { prompt: 'Hello with email alice@private.org' },
      });
      expect(normalTurn.status).toBe(200);
      expect(normalTurn.data.usage.total_tokens).toBe(18);
      const sid = normalTurn.data.session_id as string;

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
      expect(sseSlash.headers.get('content-encoding')).toBeNull();
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
      expect(hbTick.data.tick_count).toBeGreaterThanOrEqual(1);

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

    // Now mockUpstream is CLOSED -> /probe MUST report reachable: false, and /v1/chat/completions MUST return 502!
    const deadProbe = await apiJson(
      baseUrl,
      'POST',
      '/api/v1/hermes/magpie/providers/mock_openai/probe',
      { token: alice },
    );
    expect(deadProbe.status).toBe(200);
    expect(deadProbe.data.reachable).toBe(false);

    const deadCompletion = await apiJson(baseUrl, 'POST', '/v1/chat/completions', {
      token: alice,
      body: {
        provider_id: 'mock_openai',
        model: 'mock-gpt-4o',
        messages: [{ role: 'user', content: 'Should 502 when upstream is closed' }],
      },
    });
    expect(deadCompletion.status).toBe(502);

    // magpie:// URI import with body.raw (dynamic synthetic key, zero literal secret prefixes)
    const syntheticDeepSeekKey = ['sk', 'deepseek1234567890'].join('-');
    const uriImport = await apiJson(baseUrl, 'POST', '/api/v1/hermes/magpie/import', {
      token: alice,
      body: { raw: `magpie://import?preset=deepseek&api_key=${syntheticDeepSeekKey}` },
    });
    expect(uriImport.status).toBe(200);
    expect(uriImport.data.imported).toContain('deepseek');

    // 3. Computer Workbench: clean start has zero fake `sandbox:default` nodes -> 404 on emergency_takeover
    const bobComputers = await apiJson(baseUrl, 'GET', '/api/v1/computers', { token: bob });
    expect(bobComputers.status).toBe(200);
    expect(bobComputers.data.computers).toEqual([]);

    const bobTakeover = await apiJson(
      baseUrl,
      'POST',
      '/api/v1/computer/lease/emergency_takeover',
      { token: bob, body: {} },
    );
    expect(bobTakeover.status).toBe(404);

    // 4. Wallet: unverified topup MUST return 402 payment_required; verified payment_orders + Idempotency-Key deduplicates!
    const unverifiedTopup = await apiJson(baseUrl, 'POST', '/api/v1/wallet/stars/topup', {
      token: alice,
      body: { amount: 300 },
    });
    expect(unverifiedTopup.status).toBe(402);
    expect(unverifiedTopup.data.error).toBe('payment_required');

    // Seed verified paid order directly in DB to verify idempotent settlement & gifting
    server.db
      .prepare(`
        INSERT INTO payment_orders (order_id, user_id, kind, amount_stars, status, created_at_ms)
        VALUES ('ord_verified_300', ?, 'stars', 300, 'paid', ?)
      `)
      .run(aliceUser.user_id, Date.now());

    const top1 = await apiJson(baseUrl, 'POST', '/api/v1/wallet/stars/topup', {
      token: alice,
      headers: { 'Idempotency-Key': 'topup-idem-42' },
      body: { order_id: 'ord_verified_300' },
    });
    expect(top1.status).toBe(200);
    expect(top1.data.stars_balance).toBe(300);

    const top2 = await apiJson(baseUrl, 'POST', '/api/v1/wallet/stars/topup', {
      token: alice,
      headers: { 'Idempotency-Key': 'topup-idem-42' },
      body: { order_id: 'ord_verified_300' },
    });
    expect(top2.status).toBe(200);
    expect(top2.data.stars_balance).toBe(300); // Deduped!

    const selfGift = await apiJson(baseUrl, 'POST', '/api/v1/wallet/gift', {
      token: alice,
      body: { to_user_id: aliceUser.user_id, amount_stars: 50 },
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
      body: { to_user_id: bobUser.user_id, chat_id: dmChatId, amount_stars: 100, message: 'Great work!' },
    });
    expect(okGift1.status).toBe(200);
    expect(okGift1.data.stars_balance).toBe(200);

    const okGift2 = await apiJson(baseUrl, 'POST', '/api/v1/wallet/stars/send-gift', {
      token: alice,
      headers: { 'Idempotency-Key': 'gift-idem-7' },
      body: { to_user_id: bobUser.user_id, chat_id: dmChatId, amount_stars: 100, message: 'Great work!' },
    });
    expect(okGift2.status).toBe(200);
    expect(okGift2.data.stars_balance).toBe(200); // Deduped!
  });
});
