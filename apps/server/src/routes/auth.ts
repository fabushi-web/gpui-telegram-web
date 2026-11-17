import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  AuthResponse,
  ComputerNodeDto,
  SessionDto,
  TwoFactorStatusDto,
  UserPrivacySettingsDto,
} from '@gpui-telegram/protocol';
import { buildComputerViewportSvg, DEFAULT_PRIVACY_SETTINGS } from '../db/seed.js';
import { getChatDetailDto, getUserProfileDto, mapUserRowToDto } from '../db/queries.js';
import { escapeSqlLikePattern } from '../utils/cjkSearch.js';
import {
  generateQrCodeSvg,
  generateSessionToken,
  hashSecretScrypt,
  verifySecretScrypt,
} from '../utils/crypto.js';
import {
  ApiError,
  authenticateToken,
  extractBearerToken,
  readJsonBody,
  requireAuth,
  sendJson,
  type HttpRouter,
  type RequestContext,
} from '../utils/http.js';
import type { RealtimeGatewayHub } from '../ws/hub.js';

function issueSessionForUser(
  db: DatabaseSync,
  userId: number,
  deviceName = 'Telegram Web (Linux Chrome)',
  ipAddress = '127.0.0.1',
): AuthResponse {
  const userDto = getUserProfileDto(db, userId);
  if (!userDto) {
    throw new ApiError(404, 'user_not_found', `User ${userId} does not exist`);
  }

  const now = Date.now();
  const expiresAtMs = now + 30 * 24 * 3600 * 1000;
  const { sessionId, rawToken, tokenHash } = generateSessionToken();

  db.prepare(`
    INSERT INTO auth_sessions (
      session_id, user_id, token_hash, device_name, platform, ip_address,
      created_at_ms, last_active_ms, expires_at_ms, revoked
    ) VALUES (?, ?, ?, ?, 'web', ?, ?, ?, ?, 0)
  `).run(sessionId, userId, tokenHash, deviceName, ipAddress, now, now, expiresAtMs);

  // Ensure user has a Saved Messages self-chat & wallet account
  ensureUserBootstrapResources(db, userId);

  return {
    user_id: userId,
    username: userDto.username ?? `user${userId}`,
    session_id: sessionId,
    token: rawToken,
    first_name: userDto.first_name,
    last_name: userDto.last_name,
    expires_at_ms: expiresAtMs,
    user: userDto,
  };
}

export function ensureUserBootstrapResources(db: DatabaseSync, userId: number): number {
  const now = Date.now();
  const savedRow = db
    .prepare(`SELECT chat_id FROM chats WHERE kind = 'saved' AND creator_id = ? LIMIT 1`)
    .get(userId) as { chat_id: number } | undefined;

  let savedChatId: number;
  if (savedRow) {
    savedChatId = Number(savedRow.chat_id);
  } else {
    const maxRow = db.prepare(`SELECT COALESCE(MAX(chat_id), 1000) AS mx FROM chats`).get() as { mx: number };
    savedChatId = Number(maxRow.mx) + 1;
    db.prepare(`
      INSERT INTO chats (
        chat_id, title, kind, chat_type, creator_id, peer_user_id, is_forum, is_verified,
        pts, next_msg_id, last_message_id, last_message_date_ms, last_message_preview, created_at_ms
      ) VALUES (?, 'Saved Messages', 'saved', 0, ?, ?, 0, 0, 0, 1, 0, ?, '', ?)
    `).run(savedChatId, userId, userId, now, now);
    db.prepare(`
      INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, admin_rights, banned_rights, joined_at_ms)
      VALUES (?, ?, 'owner', 255, 0, ?)
    `).run(savedChatId, userId, now);
    db.prepare(`
      INSERT OR IGNORE INTO user_chat_settings (user_id, chat_id, is_pinned, is_archived, is_muted)
      VALUES (?, ?, 1, 0, 0)
    `).run(userId, savedChatId);
  }

  db.prepare(`
    INSERT OR IGNORE INTO wallet_accounts (user_id, stars_balance, ton_nano, updated_at_ms)
    VALUES (?, 500, 1000000000, ?)
  `).run(userId, now);

  db.prepare(`
    INSERT OR IGNORE INTO account_privacy (user_id, settings_json)
    VALUES (?, ?)
  `).run(userId, JSON.stringify(DEFAULT_PRIVACY_SETTINGS));

  const sandboxNode: ComputerNodeDto = {
    node_id: 'sandbox:default',
    display_name: 'Cloud Sandbox (Ubuntu 24.04)',
    kind: 'cloud_sandbox',
    tier_badge: '免费',
    host: '100.64.0.1',
    os_name: 'Linux 6.8 x86_64',
    resolution: '1280x720',
    online: true,
    run_policy: 'allow_read_only',
    has_saved_credential: false,
    lease_state: 'idle',
    lease_generation: 1,
    frame_svg_data_url: buildComputerViewportSvg(
      'sandbox:default — Cloud Workbench',
      'Ready · Policy: allow_read_only · Generation #1',
    ),
    updated_at_ms: now,
  };
  db.prepare(`
    INSERT OR IGNORE INTO computer_nodes (node_id, user_id, node_json, encrypted_secret, secret_nonce, updated_at_ms)
    VALUES ('sandbox:default', ?, ?, NULL, NULL, ?)
  `).run(userId, JSON.stringify(sandboxNode), now);

  return savedChatId;
}

function getNextUserId(db: DatabaseSync): number {
  const row = db
    .prepare(`SELECT COALESCE(MAX(user_id), 2000) AS mx FROM users WHERE user_id < 700000`)
    .get() as { mx: number };
  return Math.max(2001, Number(row.mx) + 1);
}

function getTwoFaRecord(db: DatabaseSync, userId: number): {
  salt_hex: string;
  hash_hex: string;
  hint: string | null;
  recovery_email: string | null;
  updated_at_ms: number;
} | null {
  const row = db
    .prepare(`SELECT * FROM twofa_secrets WHERE user_id = ?`)
    .get(userId) as
    | {
        salt_hex: string;
        hash_hex: string;
        hint: string | null;
        recovery_email: string | null;
        updated_at_ms: number;
      }
    | undefined;
  return row ?? null;
}

export function registerAuthAndUserRoutes(
  router: HttpRouter,
  db: DatabaseSync,
  hub: RealtimeGatewayHub,
): void {
  // 1. 1-Click Demo / Sandbox Login
  const handleDemoLogin = async (ctx: RequestContext): Promise<void> => {
    const body = await readJsonBody<{ slot?: number; user_id?: number; device_name?: string }>(ctx.req);
    const slotMap = [1001, 1002, 1003, 1004];
    const targetUserId =
      body.user_id ?? (body.slot !== undefined ? (slotMap[body.slot % slotMap.length] ?? 1001) : 1001);
    const auth = issueSessionForUser(db, Number(targetUserId), body.device_name ?? 'Demo Web Client');
    sendJson(ctx.res, 200, auth);
  };
  router.post('/api/v1/auth/demo', handleDemoLogin);
  router.post('/api/v1/auth/sandbox', handleDemoLogin);

  // 2. Phone OTP Send Code + Rate Limit Cooldown
  const handlePhoneSendCode = async (ctx: RequestContext): Promise<void> => {
    const body = await readJsonBody<{ phone?: string; phone_number?: string; cooldown_ms?: number }>(ctx.req);
    const rawPhone = (body.phone ?? body.phone_number ?? '').trim();
    const normalizedPhone = rawPhone.replace(/[\s()-]/g, '');
    if (!/^\+?[1-9]\d{6,14}$/.test(normalizedPhone)) {
      throw new ApiError(400, 'invalid_phone', 'Valid E.164 phone number is required');
    }

    const phone = normalizedPhone.startsWith('+') ? normalizedPhone : `+${normalizedPhone}`;
    const now = Date.now();

    const latest = db
      .prepare(
        `SELECT challenge_id, resend_after_ms FROM otp_challenges
         WHERE channel = 'phone' AND target = ?
         ORDER BY created_at_ms DESC LIMIT 1`,
      )
      .get(phone) as { challenge_id: string; resend_after_ms: number } | undefined;

    if (latest && latest.resend_after_ms > now) {
      const retrySecs = Math.max(1, Math.ceil((latest.resend_after_ms - now) / 1000));
      throw new ApiError(429, 'rate_limited', `Retry after ${retrySecs}s`, {
        retry_after_secs: retrySecs,
      });
    }

    const challengeId = `pch_${crypto.randomBytes(10).toString('hex')}`;
    const code = '12345';
    const cooldownMs = body.cooldown_ms !== undefined ? Math.max(0, Number(body.cooldown_ms)) : 3000;
    const resendAfterMs = cooldownMs > 0 ? now + cooldownMs : now;
    const expiresAtMs = now + 120_000;

    db.prepare(`
      INSERT INTO otp_challenges (
        challenge_id, channel, target, code, attempts, resend_after_ms, expires_at_ms, created_at_ms
      ) VALUES (?, 'phone', ?, ?, 0, ?, ?, ?)
    `).run(challengeId, phone, code, resendAfterMs, expiresAtMs, now);

    sendJson(ctx.res, 200, {
      ok: true,
      sent: true,
      phone_code_hash: challengeId,
      timeout_secs: 120,
      code_length: 5,
      expires_at_ms: expiresAtMs,
      resend_after_ms: resendAfterMs,
      dev_code: code,
      debug_code: code,
    });
  };
  router.post('/api/v1/auth/phone/send-code', handlePhoneSendCode);
  router.post('/api/v1/auth/send-code', handlePhoneSendCode);

  // 3. Phone Verify / Sign-In (with auto-create + 2FA challenge support)
  const makePhoneVerifyHandler = (isLegacySignInPath: boolean) => async (ctx: RequestContext): Promise<void> => {
    const body = await readJsonBody<{
      phone?: string;
      phone_number?: string;
      phone_code_hash?: string;
      code?: string;
      phone_code?: string;
      password?: string;
      first_name?: string;
      last_name?: string;
      username?: string;
      device_name?: string;
    }>(ctx.req);

    const rawPhone = (body.phone ?? body.phone_number ?? '').trim().replace(/[\s()-]/g, '');
    const phone = rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`;
    const code = (body.code ?? body.phone_code ?? '').trim();
    const now = Date.now();

    if (!rawPhone || !code) {
      throw new ApiError(400, 'missing_fields', 'Phone number and verification code are required');
    }

    const challenge = (
      body.phone_code_hash
        ? db
            .prepare(`SELECT * FROM otp_challenges WHERE challenge_id = ? AND target = ?`)
            .get(body.phone_code_hash, phone)
        : db
            .prepare(
              `SELECT * FROM otp_challenges WHERE channel = 'phone' AND target = ? ORDER BY created_at_ms DESC LIMIT 1`,
            )
            .get(phone)
    ) as
      | { challenge_id: string; code: string; attempts: number; expires_at_ms: number }
      | undefined;

    if (!challenge || challenge.expires_at_ms < now) {
      throw new ApiError(401, 'code_expired', 'Verification code is invalid or expired');
    }
    if (challenge.attempts >= 5) {
      throw new ApiError(429, 'too_many_attempts', 'Too many failed OTP attempts');
    }
    if (challenge.code !== code) {
      db.prepare(`UPDATE otp_challenges SET attempts = attempts + 1 WHERE challenge_id = ?`).run(
        challenge.challenge_id,
      );
      throw new ApiError(401, 'invalid_code', 'Invalid phone verification code');
    }

    // Consume OTP challenge
    db.prepare(`DELETE FROM otp_challenges WHERE challenge_id = ?`).run(challenge.challenge_id);

    // Lookup or auto-create user by phone
    let userRow = db.prepare(`SELECT user_id FROM users WHERE phone = ?`).get(phone) as
      | { user_id: number }
      | undefined;

    if (!userRow) {
      const newUserId = getNextUserId(db);
      const firstName = body.first_name?.trim() || `User ${phone.slice(-4)}`;
      const username = body.username?.trim() || `u_${newUserId}`;
      db.prepare(`
        INSERT INTO users (
          user_id, username, first_name, last_name, phone, is_bot, is_verified, is_premium,
          status, last_seen_ms, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 'online', ?, ?)
      `).run(newUserId, username, firstName, body.last_name?.trim() ?? null, phone, now, now);
      userRow = { user_id: newUserId };
    }

    const userId = Number(userRow.user_id);
    const twoFa = getTwoFaRecord(db, userId);

    if (twoFa) {
      if (body.password) {
        if (!verifySecretScrypt(body.password, twoFa.salt_hex, twoFa.hash_hex)) {
          throw new ApiError(401, 'invalid_2fa_password', 'Incorrect Cloud 2FA password');
        }
      } else {
        const challengeToken = `2fa_${crypto.randomBytes(16).toString('hex')}`;
        db.prepare(`
          INSERT INTO twofa_challenges (challenge_token, user_id, device_name, expires_at_ms)
          VALUES (?, ?, ?, ?)
        `).run(challengeToken, userId, body.device_name ?? 'Web Client', now + 300_000);

        if (isLegacySignInPath) {
          sendJson(ctx.res, 403, {
            error: '2fa_required',
            message: 'Cloud Two-Step Verification password required',
            two_fa_required: true,
            requires_2fa: true,
            challenge_token: challengeToken,
            password_hint: twoFa.hint ?? '',
            hint: twoFa.hint ?? '',
          });
          return;
        }
        sendJson(ctx.res, 200, {
          requires_2fa: true,
          two_fa_required: true,
          challenge_token: challengeToken,
          hint: twoFa.hint ?? '',
          password_hint: twoFa.hint ?? '',
        });
        return;
      }
    }

    const auth = issueSessionForUser(db, userId, body.device_name ?? 'Telegram Web Phone');
    sendJson(ctx.res, 200, auth);
  };
  router.post('/api/v1/auth/phone/verify', makePhoneVerifyHandler(false));
  router.post('/api/v1/auth/sign-in', makePhoneVerifyHandler(true));

  // 4. Cloud 2FA Status, Set, Disable & Challenge Verify
  const handleGet2faStatus = (ctx: RequestContext): void => {
    const auth = requireAuth(db, ctx);
    const twoFa = getTwoFaRecord(db, auth.userId);
    const status: TwoFactorStatusDto = {
      enabled: Boolean(twoFa),
      has_password: Boolean(twoFa),
      hint: twoFa?.hint ?? '',
      recovery_email: twoFa?.recovery_email ?? null,
      updated_at_ms: twoFa?.updated_at_ms ?? 0,
    };
    sendJson(ctx.res, 200, status);
  };
  router.get('/api/v1/auth/2fa/status', handleGet2faStatus);
  router.get('/api/v1/auth/2fa', handleGet2faStatus);
  router.get('/api/v1/account/2fa', handleGet2faStatus);

  const handleSet2fa = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      current_password?: string;
      new_password?: string;
      password?: string;
      hint?: string;
      recovery_email?: string;
    }>(ctx.req);

    const newPwd = body.new_password ?? body.password ?? '';
    if (newPwd.length < 4) {
      throw new ApiError(400, 'weak_password', '2FA password must be at least 4 characters');
    }

    const existing = getTwoFaRecord(db, auth.userId);
    if (existing) {
      if (!body.current_password || !verifySecretScrypt(body.current_password, existing.salt_hex, existing.hash_hex)) {
        throw new ApiError(401, 'invalid_current_password', 'Current 2FA password is incorrect');
      }
    }

    const { saltHex, hashHex } = hashSecretScrypt(newPwd);
    const now = Date.now();
    db.prepare(`
      INSERT OR REPLACE INTO twofa_secrets (user_id, salt_hex, hash_hex, hint, recovery_email, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(auth.userId, saltHex, hashHex, body.hint ?? '', body.recovery_email ?? null, now);

    sendJson(ctx.res, 200, {
      ok: true,
      enabled: true,
      has_password: true,
      hint: body.hint ?? '',
      recovery_email: body.recovery_email ?? null,
      updated_at_ms: now,
    });
  };
  router.post('/api/v1/auth/2fa/set', handleSet2fa);
  router.post('/api/v1/auth/2fa', handleSet2fa);
  router.post('/api/v1/account/2fa', handleSet2fa);

  const handleDisable2fa = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{ current_password?: string; password?: string }>(ctx.req);
    const existing = getTwoFaRecord(db, auth.userId);
    if (existing) {
      const provided = body.current_password ?? body.password;
      if (!provided || !verifySecretScrypt(provided, existing.salt_hex, existing.hash_hex)) {
        throw new ApiError(401, 'invalid_current_password', 'Current 2FA password is incorrect');
      }
      db.prepare(`DELETE FROM twofa_secrets WHERE user_id = ?`).run(auth.userId);
    }
    sendJson(ctx.res, 200, { ok: true, enabled: false, has_password: false });
  };
  router.post('/api/v1/auth/2fa/disable', handleDisable2fa);
  router.delete('/api/v1/auth/2fa', handleDisable2fa);
  router.delete('/api/v1/account/2fa', handleDisable2fa);

  router.post('/api/v1/auth/2fa/verify', async (ctx) => {
    const body = await readJsonBody<{
      challenge_token?: string;
      password?: string;
      cloud_password?: string;
      device_name?: string;
    }>(ctx.req);
    const token = body.challenge_token ?? '';
    const pwd = body.password ?? body.cloud_password ?? '';

    const ch = db
      .prepare(`SELECT * FROM twofa_challenges WHERE challenge_token = ?`)
      .get(token) as
      | {
          challenge_token: string;
          user_id: number;
          device_name: string | null;
          attempts: number;
          expires_at_ms: number;
        }
      | undefined;

    if (!ch || ch.expires_at_ms < Date.now()) {
      throw new ApiError(401, 'invalid_challenge', '2FA challenge token is invalid or expired');
    }
    if (Number(ch.attempts ?? 0) >= 5) {
      db.prepare(`DELETE FROM twofa_challenges WHERE challenge_token = ?`).run(token);
      throw new ApiError(429, 'too_many_attempts', 'Too many failed Cloud 2FA attempts');
    }

    const twoFa = getTwoFaRecord(db, Number(ch.user_id));
    if (!twoFa || !verifySecretScrypt(pwd, twoFa.salt_hex, twoFa.hash_hex)) {
      const nextAttempts = Number(ch.attempts ?? 0) + 1;
      if (nextAttempts >= 5) {
        db.prepare(`DELETE FROM twofa_challenges WHERE challenge_token = ?`).run(token);
        throw new ApiError(429, 'too_many_attempts', 'Too many failed Cloud 2FA attempts');
      }
      db.prepare(`UPDATE twofa_challenges SET attempts = ? WHERE challenge_token = ?`).run(
        nextAttempts,
        token,
      );
      throw new ApiError(401, 'invalid_2fa_password', 'Incorrect Cloud 2FA password');
    }

    db.prepare(`DELETE FROM twofa_challenges WHERE challenge_token = ?`).run(token);
    const auth = issueSessionForUser(
      db,
      Number(ch.user_id),
      body.device_name ?? ch.device_name ?? 'Web Client',
    );
    sendJson(ctx.res, 200, auth);
  });

  // 5. Real SVG QR Pairing (`init`/`create`, `accept`/`approve`, `poll`/`status`)
  const handlePairInit = async (ctx: RequestContext): Promise<void> => {
    const body = await readJsonBody<{ device_name?: string }>(ctx.req);
    const pairId = `qr_${crypto.randomBytes(12).toString('hex')}`;
    const qrUrl = `tg://login?token=${pairId}`;
    const svg = generateQrCodeSvg(qrUrl);
    const now = Date.now();
    const expiresAtMs = now + 180_000;

    db.prepare(`
      INSERT INTO qr_pair_sessions (
        pair_id, qr_url, svg, device_name, status, expires_at_ms, created_at_ms
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `).run(pairId, qrUrl, svg, body.device_name ?? 'Telegram Web QR', expiresAtMs, now);

    sendJson(ctx.res, 200, {
      pair_id: pairId,
      pair_token: pairId,
      qr_url: qrUrl,
      svg,
      status: 'pending',
      expires_at_ms: expiresAtMs,
    });
  };
  router.post('/api/v1/auth/pair/init', handlePairInit);
  router.post('/api/v1/auth/pair/create', handlePairInit);

  const handlePairApprove = async (ctx: RequestContext): Promise<void> => {
    const body = await readJsonBody<{ pair_token?: string; pair_id?: string; user_id?: number }>(ctx.req);
    const pairId = ctx.params.pairId ?? body.pair_token ?? body.pair_id ?? '';
    const row = db
      .prepare(`SELECT * FROM qr_pair_sessions WHERE pair_id = ?`)
      .get(pairId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new ApiError(404, 'pair_not_found', 'QR pairing session not found');
    }
    if (Number(row.expires_at_ms) < Date.now()) {
      throw new ApiError(410, 'pair_expired', 'QR pairing session expired');
    }

    const bearer = extractBearerToken(ctx.req, ctx.query);
    const callerSession = authenticateToken(db, bearer);
    let approverUserId: number;
    if (callerSession) {
      if (body.user_id !== undefined && Number(body.user_id) !== callerSession.userId) {
        throw new ApiError(403, 'forbidden', 'Cannot approve QR session on behalf of another user');
      }
      approverUserId = callerSession.userId;
    } else {
      if (body.user_id !== undefined && Number(body.user_id) !== 1001) {
        throw new ApiError(
          401,
          'unauthorized',
          'Bearer authentication required to approve QR pairing for this account',
        );
      }
      if (getTwoFaRecord(db, 1001)) {
        throw new ApiError(
          401,
          'unauthorized',
          'Account has Cloud 2FA enabled; authenticated QR approval is required',
        );
      }
      approverUserId = 1001;
    }

    const auth = issueSessionForUser(
      db,
      approverUserId,
      String(row.device_name ?? 'Telegram Web QR'),
    );

    db.prepare(`
      UPDATE qr_pair_sessions
      SET status = 'approved', approved_user_id = ?, issued_token = ?, issued_session_id = ?
      WHERE pair_id = ?
    `).run(approverUserId, auth.token, auth.session_id, pairId);

    sendJson(ctx.res, 200, {
      ok: true,
      status: 'approved',
      pair_id: pairId,
      pair_token: pairId,
      token: auth.token,
      user_id: auth.user_id,
      session: auth,
      user: auth.user,
    });
  };
  router.post('/api/v1/auth/pair/accept', handlePairApprove);
  router.post('/api/v1/auth/pair/:pairId/approve', handlePairApprove);

  const handlePairPoll = (ctx: RequestContext): void => {
    const pairId =
      ctx.params.pairId ?? ctx.query.get('pair_token') ?? ctx.query.get('pair_id') ?? '';
    const row = db
      .prepare(`SELECT * FROM qr_pair_sessions WHERE pair_id = ?`)
      .get(pairId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new ApiError(404, 'pair_not_found', 'QR pairing session not found');
    }

    const now = Date.now();
    let status = String(row.status);
    if (status === 'pending' && Number(row.expires_at_ms) < now) {
      status = 'expired';
    }

    if (status === 'approved' && row.approved_user_id && row.issued_token) {
      const user = getUserProfileDto(db, Number(row.approved_user_id));
      const session: AuthResponse = {
        user_id: Number(row.approved_user_id),
        username: user?.username ?? `user${row.approved_user_id}`,
        session_id: String(row.issued_session_id ?? ''),
        token: String(row.issued_token),
        first_name: user?.first_name,
        last_name: user?.last_name,
        user: user ?? undefined,
      };
      sendJson(ctx.res, 200, {
        status: 'approved',
        pair_id: pairId,
        pair_token: pairId,
        qr_url: row.qr_url,
        svg: row.svg,
        expires_at_ms: Number(row.expires_at_ms),
        token: session.token,
        user_id: session.user_id,
        session,
        user,
      });
      return;
    }

    sendJson(ctx.res, 200, {
      status,
      pair_id: pairId,
      pair_token: pairId,
      qr_url: row.qr_url,
      svg: row.svg,
      expires_at_ms: Number(row.expires_at_ms),
    });
  };
  router.get('/api/v1/auth/pair/poll/:pairId', handlePairPoll);
  router.get('/api/v1/auth/pair/poll', handlePairPoll);
  router.get('/api/v1/auth/pair/:pairId/status', handlePairPoll);

  // 6. Username / Password Register & Login (salted scrypt + timingSafeEqual)
  router.post('/api/v1/auth/register', async (ctx) => {
    const body = await readJsonBody<{
      username?: string;
      password?: string;
      first_name?: string;
      last_name?: string;
      phone?: string;
      device_name?: string;
    }>(ctx.req);

    const username = (body.username ?? '').trim();
    const password = body.password ?? '';
    const firstName = (body.first_name ?? username).trim();

    if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) {
      throw new ApiError(400, 'invalid_username', 'Username must be 3–32 alphanumeric/underscore characters');
    }
    if (password.length < 6) {
      throw new ApiError(400, 'weak_password', 'Password must be at least 6 characters');
    }

    const dup = db
      .prepare(`SELECT user_id FROM users WHERE LOWER(username) = LOWER(?)`)
      .get(username);
    if (dup) {
      throw new ApiError(409, 'username_taken', `Username @${username} is already taken`);
    }

    const newUserId = getNextUserId(db);
    const { saltHex, hashHex } = hashSecretScrypt(password);
    const now = Date.now();

    db.prepare(`
      INSERT INTO users (
        user_id, username, first_name, last_name, phone, password_salt, password_hash,
        is_bot, is_verified, is_premium, status, last_seen_ms, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 'online', ?, ?)
    `).run(
      newUserId,
      username,
      firstName || username,
      body.last_name?.trim() ?? null,
      body.phone?.trim() ?? null,
      saltHex,
      hashHex,
      now,
      now,
    );

    const auth = issueSessionForUser(db, newUserId, body.device_name ?? 'Web Password Register');
    sendJson(ctx.res, 201, auth);
  });

  router.post('/api/v1/auth/login', async (ctx) => {
    const body = await readJsonBody<{
      username?: string;
      password?: string;
      two_fa_password?: string;
      device_name?: string;
    }>(ctx.req);

    const username = (body.username ?? '').trim().replace(/^@/, '');
    const password = body.password ?? '';
    const row = db
      .prepare(`SELECT user_id, password_salt, password_hash FROM users WHERE LOWER(username) = LOWER(?)`)
      .get(username) as
      | { user_id: number; password_salt: string | null; password_hash: string | null }
      | undefined;

    if (!row || !row.password_salt || !row.password_hash) {
      throw new ApiError(401, 'invalid_credentials', 'Invalid username or password');
    }
    if (!verifySecretScrypt(password, row.password_salt, row.password_hash)) {
      throw new ApiError(401, 'invalid_credentials', 'Invalid username or password');
    }

    const userId = Number(row.user_id);
    const twoFa = getTwoFaRecord(db, userId);
    if (twoFa) {
      if (!body.two_fa_password) {
        const chTok = `2fa_${crypto.randomBytes(16).toString('hex')}`;
        db.prepare(
          `INSERT INTO twofa_challenges (challenge_token, user_id, device_name, expires_at_ms) VALUES (?, ?, ?, ?)`,
        ).run(chTok, userId, body.device_name ?? 'Web Login', Date.now() + 300_000);
        sendJson(ctx.res, 403, {
          error: '2fa_required',
          two_fa_required: true,
          requires_2fa: true,
          challenge_token: chTok,
          password_hint: twoFa.hint ?? '',
        });
        return;
      }
      if (!verifySecretScrypt(body.two_fa_password, twoFa.salt_hex, twoFa.hash_hex)) {
        throw new ApiError(401, 'invalid_2fa_password', 'Incorrect Cloud 2FA password');
      }
    }

    const auth = issueSessionForUser(db, userId, body.device_name ?? 'Web Password Login');
    sendJson(ctx.res, 200, auth);
  });

  // 7. Email OTP Flow
  router.post('/api/v1/auth/email/send-code', async (ctx) => {
    const body = await readJsonBody<{ email?: string }>(ctx.req);
    const email = (body.email ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new ApiError(400, 'invalid_email', 'Valid email address is required');
    }
    const now = Date.now();
    const challengeId = `ech_${crypto.randomBytes(10).toString('hex')}`;
    const code = '123456';
    db.prepare(`
      INSERT INTO otp_challenges (
        challenge_id, channel, target, code, attempts, resend_after_ms, expires_at_ms, created_at_ms
      ) VALUES (?, 'email', ?, ?, 0, ?, ?, ?)
    `).run(challengeId, email, code, now, now + 300_000, now);

    sendJson(ctx.res, 200, {
      ok: true,
      email_code_hash: challengeId,
      timeout_secs: 300,
      dev_code: code,
    });
  });

  const handleEmailVerify = async (ctx: RequestContext): Promise<void> => {
    const body = await readJsonBody<{
      email?: string;
      code?: string;
      email_code_hash?: string;
      first_name?: string;
      device_name?: string;
    }>(ctx.req);
    const email = (body.email ?? '').trim().toLowerCase();
    const code = (body.code ?? '').trim();
    const now = Date.now();

    const ch = (
      body.email_code_hash
        ? db.prepare(`SELECT * FROM otp_challenges WHERE challenge_id = ? AND target = ?`).get(body.email_code_hash, email)
        : db.prepare(`SELECT * FROM otp_challenges WHERE channel = 'email' AND target = ? ORDER BY created_at_ms DESC LIMIT 1`).get(email)
    ) as { challenge_id: string; code: string; expires_at_ms: number } | undefined;

    if (!ch || ch.expires_at_ms < now || ch.code !== code) {
      throw new ApiError(401, 'invalid_email_code', 'Invalid or expired email verification code');
    }
    db.prepare(`DELETE FROM otp_challenges WHERE challenge_id = ?`).run(ch.challenge_id);

    let userRow = db.prepare(`SELECT user_id FROM users WHERE LOWER(email) = ?`).get(email) as
      | { user_id: number }
      | undefined;
    if (!userRow) {
      const newUserId = getNextUserId(db);
      const localPart = email.split('@')[0]?.replace(/[^A-Za-z0-9_]/g, '_') || `user_${newUserId}`;
      db.prepare(`
        INSERT INTO users (
          user_id, username, first_name, email, is_bot, is_verified, is_premium, status, last_seen_ms, created_at_ms
        ) VALUES (?, ?, ?, ?, 0, 0, 0, 'online', ?, ?)
      `).run(newUserId, `${localPart}_${newUserId}`, body.first_name?.trim() || localPart, email, now, now);
      userRow = { user_id: newUserId };
    }

    const auth = issueSessionForUser(db, Number(userRow.user_id), body.device_name ?? 'Web Email OTP');
    sendJson(ctx.res, 200, auth);
  };
  router.post('/api/v1/auth/email/verify', handleEmailVerify);
  router.post('/api/v1/auth/email/register', handleEmailVerify);

  // 8. Alipay QR Flow
  const handleAlipayStart = async (ctx: RequestContext): Promise<void> => {
    await readJsonBody(ctx.req);
    const sessionId = `ali_${crypto.randomBytes(10).toString('hex')}`;
    const qrUrl = `alipays://platformapi/startapp?appId=20000067&session=${sessionId}`;
    const svg = generateQrCodeSvg(qrUrl);
    const now = Date.now();
    const expiresAtMs = now + 180_000;

    db.prepare(`
      INSERT INTO alipay_sessions (
        session_id, qr_url, svg, status, expires_at_ms, created_at_ms
      ) VALUES (?, ?, ?, 'pending', ?, ?)
    `).run(sessionId, qrUrl, svg, expiresAtMs, now);

    sendJson(ctx.res, 200, {
      session_id: sessionId,
      qr_url: qrUrl,
      svg,
      status: 'pending',
      expires_at_ms: expiresAtMs,
    });
  };
  router.post('/api/v1/auth/alipay/start', handleAlipayStart);
  router.post('/api/v1/auth/alipay/qr', handleAlipayStart);

  const handleAlipayConfirm = async (ctx: RequestContext): Promise<void> => {
    const body = await readJsonBody<{ session_id?: string; user_id?: number }>(ctx.req);
    const sessionId = ctx.params.sessionId ?? body.session_id ?? '';
    const row = db
      .prepare(`SELECT * FROM alipay_sessions WHERE session_id = ?`)
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new ApiError(404, 'alipay_session_not_found', 'Alipay session not found');
    }
    if (Number(row.expires_at_ms) < Date.now()) {
      throw new ApiError(410, 'alipay_session_expired', 'Alipay session expired');
    }

    const bearer = extractBearerToken(ctx.req, ctx.query);
    const callerSession = authenticateToken(db, bearer);
    let targetUserId: number;
    if (callerSession) {
      if (body.user_id !== undefined && Number(body.user_id) !== callerSession.userId) {
        throw new ApiError(403, 'forbidden', 'Cannot confirm Alipay session on behalf of another user');
      }
      targetUserId = callerSession.userId;
    } else {
      if (body.user_id !== undefined && Number(body.user_id) !== 1001) {
        throw new ApiError(
          401,
          'unauthorized',
          'Bearer authentication required to confirm Alipay login for this account',
        );
      }
      if (getTwoFaRecord(db, 1001)) {
        throw new ApiError(401, 'unauthorized', 'Account has Cloud 2FA enabled');
      }
      targetUserId = 1001;
    }

    const auth = issueSessionForUser(db, targetUserId, 'Alipay Web Auth');
    db.prepare(`
      UPDATE alipay_sessions
      SET status = 'confirmed', approved_user_id = ?, issued_token = ?, issued_session_id = ?
      WHERE session_id = ?
    `).run(targetUserId, auth.token, auth.session_id, sessionId);

    sendJson(ctx.res, 200, auth);
  };
  router.post('/api/v1/auth/alipay/confirm', handleAlipayConfirm);
  router.post('/api/v1/auth/alipay/:sessionId/confirm', handleAlipayConfirm);

  const handleAlipayPoll = (ctx: RequestContext): void => {
    const sessionId = ctx.params.sessionId ?? ctx.query.get('session_id') ?? '';
    const row = db
      .prepare(`SELECT * FROM alipay_sessions WHERE session_id = ?`)
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new ApiError(404, 'alipay_session_not_found', 'Alipay session not found');
    }
    if (row.status === 'confirmed' && row.approved_user_id && row.issued_token) {
      const user = getUserProfileDto(db, Number(row.approved_user_id));
      sendJson(ctx.res, 200, {
        status: 'confirmed',
        token: row.issued_token,
        user_id: Number(row.approved_user_id),
        user,
      });
      return;
    }
    sendJson(ctx.res, 200, {
      status: Number(row.expires_at_ms) < Date.now() ? 'expired' : String(row.status),
      session_id: sessionId,
    });
  };
  router.get('/api/v1/auth/alipay/poll/:sessionId', handleAlipayPoll);
  router.get('/api/v1/auth/alipay/poll', handleAlipayPoll);
  router.get('/api/v1/auth/alipay/:sessionId/status', handleAlipayPoll);

  // 9. WebAuthn Passkey Flow
  router.post('/api/v1/auth/passkey/challenge', async (ctx) => {
    const body = await readJsonBody<{ username?: string }>(ctx.req);
    const challengeId = `pkc_${crypto.randomBytes(10).toString('hex')}`;
    const challenge = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    db.prepare(`
      INSERT INTO passkey_challenges (challenge_id, challenge, username, expires_at_ms)
      VALUES (?, ?, ?, ?)
    `).run(challengeId, challenge, body.username ?? null, now + 60_000);

    sendJson(ctx.res, 200, {
      challenge_id: challengeId,
      challenge,
      rp_id: 'localhost',
      timeout_ms: 60_000,
    });
  });

  const handlePasskeyRegister = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      cred_id?: string;
      label?: string;
      public_key_b64?: string;
    }>(ctx.req);
    const credId = body.cred_id?.trim() || `cred_${crypto.randomBytes(12).toString('hex')}`;
    const existingCred = db
      .prepare(`SELECT user_id FROM account_passkeys WHERE cred_id = ?`)
      .get(credId) as { user_id: number } | undefined;
    if (existingCred && Number(existingCred.user_id) !== auth.userId) {
      throw new ApiError(409, 'credential_conflict', 'Passkey credential ID already registered');
    }

    const label = body.label?.trim() || 'Platform Passkey';
    const now = Date.now();

    db.prepare(`
      INSERT OR REPLACE INTO account_passkeys (cred_id, user_id, label, public_key_b64, created_at_ms, last_used_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(credId, auth.userId, label, body.public_key_b64 ?? null, now, now);

    sendJson(ctx.res, 201, {
      cred_id: credId,
      label,
      created_at_ms: now,
      last_used_ms: now,
    });
  };
  router.post('/api/v1/auth/passkey/register', handlePasskeyRegister);
  router.post('/api/v1/account/passkeys/register', handlePasskeyRegister);

  router.post('/api/v1/auth/passkey/verify', async (ctx) => {
    const body = await readJsonBody<{
      challenge_id?: string;
      credential_id?: string;
      simulate?: boolean;
      device_name?: string;
    }>(ctx.req);
    const challengeId = body.challenge_id ?? '';
    const ch = db
      .prepare(`SELECT * FROM passkey_challenges WHERE challenge_id = ?`)
      .get(challengeId) as { challenge_id: string; username: string | null; expires_at_ms: number } | undefined;

    if (!ch || ch.expires_at_ms < Date.now()) {
      throw new ApiError(401, 'invalid_passkey_challenge', 'Passkey challenge expired or invalid');
    }
    db.prepare(`DELETE FROM passkey_challenges WHERE challenge_id = ?`).run(challengeId);

    const effectiveCredId =
      body.credential_id?.trim() || (body.simulate === true ? 'cred_alice_default' : '');
    if (!effectiveCredId) {
      throw new ApiError(401, 'invalid_passkey_credential', 'Registered passkey credential_id is required');
    }

    const pk = db
      .prepare(`SELECT user_id FROM account_passkeys WHERE cred_id = ?`)
      .get(effectiveCredId) as { user_id: number } | undefined;
    if (!pk) {
      throw new ApiError(401, 'invalid_passkey_credential', 'Unknown or unregistered passkey credential');
    }

    const targetUserId = Number(pk.user_id);
    if (ch.username) {
      const ownerRow = db
        .prepare(`SELECT username FROM users WHERE user_id = ?`)
        .get(targetUserId) as { username: string | null } | undefined;
      if (!ownerRow?.username || ownerRow.username.toLowerCase() !== ch.username.trim().toLowerCase()) {
        throw new ApiError(401, 'passkey_user_mismatch', 'Passkey credential does not match requested username');
      }
    }

    db.prepare(`UPDATE account_passkeys SET last_used_ms = ? WHERE cred_id = ?`).run(
      Date.now(),
      effectiveCredId,
    );

    const auth = issueSessionForUser(db, targetUserId, body.device_name ?? 'WebAuthn Passkey');
    sendJson(ctx.res, 200, auth);
  });

  const handleListPasskeys = (ctx: RequestContext): void => {
    const auth = requireAuth(db, ctx);
    const rows = db
      .prepare(`SELECT cred_id, label, created_at_ms, last_used_ms FROM account_passkeys WHERE user_id = ? ORDER BY created_at_ms DESC`)
      .all(auth.userId);
    sendJson(ctx.res, 200, { passkeys: rows });
  };
  router.get('/api/v1/auth/passkey/list', handleListPasskeys);
  router.get('/api/v1/account/passkeys', handleListPasskeys);

  router.delete('/api/v1/account/passkeys/:credId', (ctx) => {
    const auth = requireAuth(db, ctx);
    db.prepare(`DELETE FROM account_passkeys WHERE cred_id = ? AND user_id = ?`).run(
      ctx.params.credId!,
      auth.userId,
    );
    sendJson(ctx.res, 200, { ok: true });
  });

  // 10. Sessions, Me & Logout
  router.get('/api/v1/auth/me', (ctx) => {
    const auth = requireAuth(db, ctx);
    const user = getUserProfileDto(db, auth.userId);
    if (!user) throw new ApiError(404, 'user_not_found', 'User not found');
    sendJson(ctx.res, 200, user);
  });

  router.post('/api/v1/auth/logout', (ctx) => {
    const auth = requireAuth(db, ctx);
    db.prepare(`UPDATE auth_sessions SET revoked = 1 WHERE session_id = ?`).run(auth.sessionId);
    hub.disconnectSession(auth.sessionId);
    sendJson(ctx.res, 200, { ok: true });
  });

  router.get('/api/v1/auth/sessions', (ctx) => {
    const auth = requireAuth(db, ctx);
    const rows = db
      .prepare(
        `SELECT session_id, device_name, platform, ip_address, created_at_ms, last_active_ms, expires_at_ms
         FROM auth_sessions
         WHERE user_id = ? AND revoked = 0
         ORDER BY last_active_ms DESC`,
      )
      .all(auth.userId) as Array<Record<string, unknown>>;

    const sessions: SessionDto[] = rows.map((r) => ({
      session_id: String(r.session_id),
      device_name: String(r.device_name),
      platform: (r.platform as string | null) ?? 'web',
      ip_address: (r.ip_address as string | null) ?? '127.0.0.1',
      created_at_ms: Number(r.created_at_ms),
      last_active_ms: Number(r.last_active_ms),
      expires_at_ms: Number(r.expires_at_ms),
      is_current: String(r.session_id) === auth.sessionId,
    }));
    sendJson(ctx.res, 200, { sessions });
  });

  const handleRevokeOtherSessions = (ctx: RequestContext): void => {
    const auth = requireAuth(db, ctx);
    const others = db
      .prepare(`SELECT session_id FROM auth_sessions WHERE user_id = ? AND session_id != ? AND revoked = 0`)
      .all(auth.userId, auth.sessionId) as Array<{ session_id: string }>;

    db.prepare(
      `UPDATE auth_sessions SET revoked = 1 WHERE user_id = ? AND session_id != ? AND revoked = 0`,
    ).run(auth.userId, auth.sessionId);

    for (const o of others) {
      hub.disconnectSession(o.session_id);
    }
    sendJson(ctx.res, 200, { ok: true, revoked_count: others.length });
  };
  router.delete('/api/v1/auth/sessions/others', handleRevokeOtherSessions);
  router.delete('/api/v1/auth/sessions', handleRevokeOtherSessions);

  router.delete('/api/v1/auth/sessions/:sessionId', (ctx) => {
    const auth = requireAuth(db, ctx);
    const targetId = ctx.params.sessionId!;
    db.prepare(`UPDATE auth_sessions SET revoked = 1 WHERE session_id = ? AND user_id = ?`).run(
      targetId,
      auth.userId,
    );
    hub.disconnectSession(targetId);
    sendJson(ctx.res, 200, { ok: true });
  });

  router.delete('/api/v1/account', (ctx) => {
    const auth = requireAuth(db, ctx);
    db.prepare(`UPDATE auth_sessions SET revoked = 1 WHERE user_id = ?`).run(auth.userId);
    sendJson(ctx.res, 200, { ok: true });
  });

  // 11. Users, Profile, Privacy & Blocked Users
  router.get('/api/v1/users/me', (ctx) => {
    const auth = requireAuth(db, ctx);
    const user = getUserProfileDto(db, auth.userId);
    sendJson(ctx.res, 200, user);
  });

  router.patch('/api/v1/users/me', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      first_name?: string;
      last_name?: string;
      username?: string;
      bio?: string;
      photo_file_id?: string;
      avatar_media_id?: string;
      emoji_status?: string;
    }>(ctx.req);

    if (body.username !== undefined) {
      const cleanU = body.username.trim();
      if (cleanU && !/^[A-Za-z0-9_]{3,32}$/.test(cleanU)) {
        throw new ApiError(400, 'invalid_username', 'Username must be 3–32 alphanumeric/underscore characters');
      }
      if (cleanU) {
        const dup = db
          .prepare(`SELECT user_id FROM users WHERE LOWER(username) = LOWER(?) AND user_id != ?`)
          .get(cleanU, auth.userId);
        if (dup) {
          throw new ApiError(409, 'username_taken', 'Username is already taken');
        }
        db.prepare(`UPDATE users SET username = ? WHERE user_id = ?`).run(cleanU, auth.userId);
      }
    }

    if (body.first_name !== undefined) {
      if (!body.first_name.trim()) {
        throw new ApiError(400, 'invalid_first_name', 'First name cannot be empty');
      }
      db.prepare(`UPDATE users SET first_name = ? WHERE user_id = ?`).run(body.first_name.trim(), auth.userId);
    }
    if (body.last_name !== undefined) {
      db.prepare(`UPDATE users SET last_name = ? WHERE user_id = ?`).run(body.last_name, auth.userId);
    }
    if (body.bio !== undefined) {
      db.prepare(`UPDATE users SET bio = ? WHERE user_id = ?`).run(body.bio, auth.userId);
    }
    const avatarId = body.photo_file_id ?? body.avatar_media_id;
    if (avatarId !== undefined) {
      db.prepare(`UPDATE users SET avatar_media_id = ? WHERE user_id = ?`).run(avatarId, auth.userId);
    }
    if (body.emoji_status !== undefined) {
      db.prepare(`UPDATE users SET emoji_status = ? WHERE user_id = ?`).run(body.emoji_status, auth.userId);
    }

    const updated = getUserProfileDto(db, auth.userId)!;
    sendJson(ctx.res, 200, updated);
  });

  const handleGetPrivacy = (ctx: RequestContext): void => {
    const auth = requireAuth(db, ctx);
    const row = db
      .prepare(`SELECT settings_json FROM account_privacy WHERE user_id = ?`)
      .get(auth.userId) as { settings_json: string } | undefined;
    const settings: UserPrivacySettingsDto = row
      ? { ...DEFAULT_PRIVACY_SETTINGS, ...(JSON.parse(row.settings_json) as Partial<UserPrivacySettingsDto>) }
      : DEFAULT_PRIVACY_SETTINGS;
    sendJson(ctx.res, 200, settings);
  };
  router.get('/api/v1/account/privacy', handleGetPrivacy);
  router.get('/api/v1/users/me/privacy', handleGetPrivacy);

  const handleUpdatePrivacy = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const patch = await readJsonBody<Partial<UserPrivacySettingsDto>>(ctx.req);
    const row = db
      .prepare(`SELECT settings_json FROM account_privacy WHERE user_id = ?`)
      .get(auth.userId) as { settings_json: string } | undefined;
    const current = row
      ? (JSON.parse(row.settings_json) as UserPrivacySettingsDto)
      : DEFAULT_PRIVACY_SETTINGS;
    const merged: UserPrivacySettingsDto = { ...current, ...patch };
    db.prepare(`INSERT OR REPLACE INTO account_privacy (user_id, settings_json) VALUES (?, ?)`).run(
      auth.userId,
      JSON.stringify(merged),
    );
    sendJson(ctx.res, 200, merged);
  };
  router.put('/api/v1/account/privacy', handleUpdatePrivacy);
  router.put('/api/v1/users/me/privacy', handleUpdatePrivacy);

  router.get('/api/v1/users/search', (ctx) => {
    requireAuth(db, ctx);
    const q = (ctx.query.get('q') ?? '').trim().toLowerCase();
    const limit = Math.min(50, Math.max(1, Number(ctx.query.get('limit') ?? 20)));
    const likePattern = `%${escapeSqlLikePattern(q)}%`;
    const rows = (
      q
        ? db
            .prepare(
              `SELECT * FROM users
               WHERE LOWER(COALESCE(username, '')) LIKE ? ESCAPE '\\'
                  OR LOWER(first_name || ' ' || COALESCE(last_name, '')) LIKE ? ESCAPE '\\'
               LIMIT ?`,
            )
            .all(likePattern, likePattern, limit)
        : db.prepare(`SELECT * FROM users LIMIT ?`).all(limit)
    ) as Array<Record<string, unknown>>;
    sendJson(ctx.res, 200, { users: rows.map(mapUserRowToDto) });
  });

  const handleListBlocked = (ctx: RequestContext): void => {
    const auth = requireAuth(db, ctx);
    const rows = db
      .prepare(
        `SELECT u.*, b.blocked_at_ms
         FROM user_blocks b
         JOIN users u ON u.user_id = b.blocked_user_id
         WHERE b.owner_user_id = ?
         ORDER BY b.blocked_at_ms DESC`,
      )
      .all(auth.userId) as Array<Record<string, unknown>>;
    sendJson(ctx.res, 200, { blocked: rows.map(mapUserRowToDto) });
  };
  router.get('/api/v1/users/blocked', handleListBlocked);
  router.get('/api/v1/users/me/blocked', handleListBlocked);

  router.post('/api/v1/users/:userId/block', (ctx) => {
    const auth = requireAuth(db, ctx);
    const targetId = Number(ctx.params.userId);
    db.prepare(
      `INSERT OR REPLACE INTO user_blocks (owner_user_id, blocked_user_id, blocked_at_ms) VALUES (?, ?, ?)`,
    ).run(auth.userId, targetId, Date.now());
    sendJson(ctx.res, 200, { ok: true, blocked: true });
  });

  router.delete('/api/v1/users/:userId/block', (ctx) => {
    const auth = requireAuth(db, ctx);
    const targetId = Number(ctx.params.userId);
    db.prepare(`DELETE FROM user_blocks WHERE owner_user_id = ? AND blocked_user_id = ?`).run(
      auth.userId,
      targetId,
    );
    sendJson(ctx.res, 200, { ok: true, blocked: false });
  });

  router.get('/api/v1/users/:userId/common-chats', (ctx) => {
    const auth = requireAuth(db, ctx);
    const peerId = Number(ctx.params.userId);
    const rows = db
      .prepare(
        `SELECT c.chat_id FROM chats c
         JOIN chat_members m1 ON m1.chat_id = c.chat_id AND m1.user_id = ?
         JOIN chat_members m2 ON m2.chat_id = c.chat_id AND m2.user_id = ?
         WHERE c.chat_type IN (1, 2, 3)`,
      )
      .all(auth.userId, peerId) as Array<{ chat_id: number }>;
    const chats = rows
      .map((r) => getChatDetailDto(db, Number(r.chat_id), auth.userId))
      .filter(Boolean);
    sendJson(ctx.res, 200, { chats });
  });

  router.get('/api/v1/users/:userId', (ctx) => {
    requireAuth(db, ctx);
    const user = getUserProfileDto(db, Number(ctx.params.userId));
    if (!user) throw new ApiError(404, 'user_not_found', 'User not found');
    sendJson(ctx.res, 200, user);
  });
}
