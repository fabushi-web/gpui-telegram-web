import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import net from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_ARGON2_KDF_PARAMS,
  type Argon2KdfParamsDto,
  type AuthResponse,
  type AuthVersion,
  type SessionDto,
  type TwoFactorStatusDto,
  type UserPrivacySettingsDto,
} from '@gpui-telegram/protocol';
import type { ServerConfig } from '../config.js';
import { DEFAULT_PRIVACY_SETTINGS } from '../db/seed.js';
import {
  getChatDetailDto,
  getUserProfileDto,
  mapUserRowToDto,
  parseBoundedQueryInt,
} from '../db/queries.js';
import { escapeSqlLikePattern } from '../utils/cjkSearch.js';
import {
  constantTimeUtf8Equals,
  decodeBase64AnyStrict,
  generateQrCodeSvg,
  generateSessionToken,
  hashSecretScrypt,
  parseWebAuthnAttestationObject,
  parseWebAuthnAuthenticatorData,
  parseWebAuthnPublicKey,
  verifySecretScrypt,
  verifyWebAuthnSignature,
} from '../utils/crypto.js';
import {
  ApiError,
  readJsonBody,
  requireAuth,
  sendJson,
  type HttpRouter,
  type RequestContext,
} from '../utils/http.js';
import type { RealtimeGatewayHub } from '../ws/hub.js';
import {
  validateKdfParams,
  validateSplitKeySaltB64,
  validateSplitKeyVerifierB64,
} from './userVault.js';

const MAX_PASSWORD_UTF8_BYTES = 1024;
const OTP_COOLDOWN_MS = 60_000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function extractClientIp(req: IncomingMessage): string | null {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const remote = req.socket?.remoteAddress?.trim();
  if (!remote) return null;
  return remote.startsWith('::ffff:') ? remote.slice(7) : remote;
}

function stripBase64Padding(s: string): string {
  return s.trim().replace(/=+$/, '');
}

function resolveRequestRpId(req: IncomingMessage): string {
  const rawHost = String(req.headers.host ?? '').trim();
  if (!rawHost) return 'localhost';
  if (rawHost.startsWith('[')) {
    const end = rawHost.indexOf(']');
    if (end > 1) return rawHost.slice(1, end).toLowerCase();
  }
  return (rawHost.split(':')[0] ?? 'localhost').trim().toLowerCase() || 'localhost';
}

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

function isAllowedWebAuthnOriginAndRpId(
  originStr: string,
  reqOriginHeader: string | undefined,
  expectedRpId: string,
  rpIdHash?: Buffer,
): { ok: true } | { ok: false; code: 'invalid_origin' | 'invalid_rp_id_hash'; message: string } {
  let originUrl: URL;
  try {
    originUrl = new URL(originStr);
  } catch {
    return { ok: false, code: 'invalid_origin', message: 'Malformed WebAuthn clientDataJSON origin' };
  }
  // Exact W3C serialized origin check: rejects userinfo, paths, trailing slashes, queries, fragments
  if (originStr !== originUrl.origin) {
    return {
      ok: false,
      code: 'invalid_origin',
      message: 'WebAuthn clientDataJSON origin must be a canonical serialized origin',
    };
  }
  if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') {
    return { ok: false, code: 'invalid_origin', message: 'WebAuthn origin must be http or https' };
  }

  const originHost = originUrl.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (originUrl.protocol !== 'https:' && !isLoopbackHost(originHost)) {
    return {
      ok: false,
      code: 'invalid_origin',
      message: 'Non-loopback WebAuthn origin must use https',
    };
  }

  if (reqOriginHeader && reqOriginHeader.trim()) {
    try {
      const headerTrimmed = reqOriginHeader.trim();
      const headerUrl = new URL(headerTrimmed);
      if (headerTrimmed !== headerUrl.origin || originUrl.origin !== headerUrl.origin) {
        return {
          ok: false,
          code: 'invalid_origin',
          message: 'WebAuthn clientDataJSON origin does not match request Origin header',
        };
      }
    } catch {
      return { ok: false, code: 'invalid_origin', message: 'Invalid request Origin header' };
    }
  }

  const rpHost = expectedRpId.replace(/^\[|\]$/g, '').toLowerCase();
  const bothLoopback = isLoopbackHost(originHost) && isLoopbackHost(rpHost);
  const canSubdomainMatch = net.isIP(rpHost) === 0 && !isLoopbackHost(rpHost);
  const hostMatches =
    originHost === rpHost ||
    (canSubdomainMatch && originHost.endsWith(`.${rpHost}`)) ||
    bothLoopback;

  if (!hostMatches) {
    return {
      ok: false,
      code: 'invalid_origin',
      message: `WebAuthn origin host "${originHost}" does not match RP ID "${rpHost}"`,
    };
  }

  if (rpIdHash) {
    const expectedHash = crypto.createHash('sha256').update(rpHost, 'utf8').digest();
    if (rpIdHash.length === 32 && crypto.timingSafeEqual(rpIdHash, expectedHash)) {
      return { ok: true };
    }
    if (bothLoopback) {
      const originHostHash = crypto.createHash('sha256').update(originHost, 'utf8').digest();
      if (rpIdHash.length === 32 && crypto.timingSafeEqual(rpIdHash, originHostHash)) {
        return { ok: true };
      }
    }
    return {
      ok: false,
      code: 'invalid_rp_id_hash',
      message: 'WebAuthn authenticatorData rpIdHash mismatch',
    };
  }

  return { ok: true };
}

function decodeClientDataJsonBytes(
  raw: unknown,
  errorCode: 'invalid_passkey_attestation' | 'invalid_passkey_assertion' = 'invalid_passkey_assertion',
): Buffer {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new ApiError(400, errorCode, 'clientDataJSON is required');
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    return Buffer.from(trimmed, 'utf8');
  }
  try {
    return decodeBase64AnyStrict(trimmed);
  } catch {
    throw new ApiError(400, errorCode, 'clientDataJSON has invalid encoding');
  }
}

function parseWebAuthnClientDataJson(
  clientDataRaw: unknown,
  expectedType: 'webauthn.create' | 'webauthn.get',
  errorCode: 'invalid_passkey_attestation' | 'invalid_passkey_assertion',
): { bytes: Buffer; type: string; challenge: string; origin: string } {
  const bytes = decodeClientDataJsonBytes(clientDataRaw, errorCode);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ApiError(400, errorCode, 'clientDataJSON must be valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError(400, errorCode, 'clientDataJSON must be a JSON object');
  }
  const obj = parsed as { type?: unknown; challenge?: unknown; origin?: unknown };
  if (typeof obj.type !== 'string') {
    throw new ApiError(400, errorCode, 'clientDataJSON.type must be a string');
  }
  if (obj.type !== expectedType) {
    throw new ApiError(
      401,
      'invalid_client_data_type',
      `clientDataJSON.type must be "${expectedType}"`,
    );
  }
  if (
    typeof obj.challenge !== 'string' ||
    !obj.challenge.trim() ||
    typeof obj.origin !== 'string' ||
    !obj.origin.trim()
  ) {
    throw new ApiError(400, errorCode, 'clientDataJSON must include challenge and origin');
  }
  return {
    bytes,
    type: obj.type,
    challenge: obj.challenge,
    origin: obj.origin,
  };
}

function readOptionalTrimmedString(
  val: unknown,
  errorCode: string,
  message: string,
): string {
  if (val === undefined || val === null) {
    return '';
  }
  if (typeof val !== 'string') {
    throw new ApiError(400, errorCode, message);
  }
  return val.trim();
}

/**
 * Initializes ONLY non-chat bootstrap resources (0-balance wallet + truthful privacy defaults).
 * NEVER auto-creates Saved Messages or fake demo chats/balances so newly registered accounts
 * start truthfully with `GET /api/v1/chats -> { chats: [], total: 0 }`.
 */
export function ensureUserBootstrapResources(db: DatabaseSync, userId: number): void {
  const now = Date.now();
  db.prepare(`
    INSERT OR IGNORE INTO wallet_accounts (user_id, stars_balance, ton_nano, updated_at_ms)
    VALUES (?, 0, 0, ?)
  `).run(userId, now);

  db.prepare(`
    INSERT OR IGNORE INTO account_privacy (user_id, settings_json)
    VALUES (?, ?)
  `).run(userId, JSON.stringify(DEFAULT_PRIVACY_SETTINGS));
}

/**
 * Lazily ensures the user's explicit Saved Messages self-chat ONLY when explicitly requested
 * (`POST /api/v1/chats/saved`, `chat_type: 5 | 'saved'`, or self-DM).
 */
export function ensureSavedMessagesChat(db: DatabaseSync, userId: number): number {
  const now = Date.now();
  const savedRow = db
    .prepare(`SELECT chat_id FROM chats WHERE kind = 'saved' AND creator_id = ? LIMIT 1`)
    .get(userId) as { chat_id: number } | undefined;

  if (savedRow) {
    return Number(savedRow.chat_id);
  }

  const maxRow = db
    .prepare(`SELECT COALESCE(MAX(chat_id), 1000) AS mx FROM chats`)
    .get() as { mx: number };
  const savedChatId = Number(maxRow.mx) + 1;

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

  return savedChatId;
}

function issueSessionForUser(
  db: DatabaseSync,
  userId: number,
  deviceName = 'Fabushi Web (Browser)',
  ipAddress: string | null = null,
): AuthResponse {
  const userDto = getUserProfileDto(db, userId);
  if (!userDto) {
    throw new ApiError(404, 'user_not_found', `User ${userId} does not exist`);
  }

  const meta = db
    .prepare(`SELECT auth_version, account_generation FROM users WHERE user_id = ?`)
    .get(userId) as { auth_version: number; account_generation: number } | undefined;
  const authVersion: AuthVersion = Number(meta?.auth_version) === 2 ? 2 : 1;
  const accountGeneration = Number(meta?.account_generation ?? 1);

  const now = Date.now();
  const expiresAtMs = now + 30 * 24 * 3600 * 1000;
  const { sessionId, rawToken, tokenHash } = generateSessionToken();

  db.prepare(`
    INSERT INTO auth_sessions (
      session_id, user_id, token_hash, device_name, platform, ip_address,
      created_at_ms, last_active_ms, expires_at_ms, revoked
    ) VALUES (?, ?, ?, ?, 'web', ?, ?, ?, ?, 0)
  `).run(sessionId, userId, tokenHash, deviceName, ipAddress, now, now, expiresAtMs);

  ensureUserBootstrapResources(db, userId);

  return {
    user_id: userId,
    username: userDto.username ?? `user${userId}`,
    session_id: sessionId,
    token: rawToken,
    first_name: userDto.first_name,
    last_name: userDto.last_name,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(expiresAtMs).toISOString(),
    expires_at_ms: expiresAtMs,
    account_generation: accountGeneration,
    auth_version: authVersion,
    user: userDto,
  };
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

interface ResolvedRegisterAuth {
  authVersion: AuthVersion;
  secretToHash: string;
  authSaltB64: string | null;
  kdfParams: Argon2KdfParamsDto | null;
}

function resolveRegisterAuth(body: {
  auth_version?: number;
  password?: string;
  auth_salt_b64?: string;
  auth_verifier_b64?: string;
  kdf_params?: Argon2KdfParamsDto;
}): ResolvedRegisterAuth {
  const requestedVersion = body.auth_version ?? 1;
  if (requestedVersion === 1) {
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < 6) {
      throw new ApiError(400, 'weak_password', 'Password must be at least 6 characters');
    }
    if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_UTF8_BYTES) {
      throw new ApiError(400, 'invalid_password', 'Password exceeds maximum allowed length');
    }
    return {
      authVersion: 1,
      secretToHash: password,
      authSaltB64: null,
      kdfParams: null,
    };
  }
  if (requestedVersion === 2) {
    const saltB64 = validateSplitKeySaltB64(body.auth_salt_b64);
    const verifierB64 = validateSplitKeyVerifierB64(body.auth_verifier_b64);
    const kdfParams = validateKdfParams(body.kdf_params ?? DEFAULT_ARGON2_KDF_PARAMS);
    return {
      authVersion: 2,
      secretToHash: verifierB64,
      authSaltB64: saltB64,
      kdfParams,
    };
  }
  throw new ApiError(400, 'invalid_auth_version', 'auth_version must be 1 or 2');
}

export function registerAuthAndUserRoutes(
  router: HttpRouter,
  db: DatabaseSync,
  hub: RealtimeGatewayHub,
  config: ServerConfig,
): void {
  // 1. Phone OTP Send Code + Fixed 60s Rate Limit Cooldown (real random 6-digit OTP via webhook only)
  const handlePhoneSendCode = async (ctx: RequestContext): Promise<void> => {
    const body = await readJsonBody<{ phone?: unknown; phone_number?: unknown }>(ctx.req);
    const rawPhone = readOptionalTrimmedString(
      body.phone ?? body.phone_number,
      'invalid_phone',
      'Valid E.164 phone number is required',
    );
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

    if (!config.smsWebhookUrl) {
      throw new ApiError(
        503,
        'sms_gateway_not_configured',
        'SMS verification provider is not configured on this server. Please sign in with Password, Email, or Passkey.',
      );
    }

    const challengeId = `pch_${crypto.randomBytes(10).toString('hex')}`;
    const code = String(crypto.randomInt(100000, 1000000));
    const resendAfterMs = now + OTP_COOLDOWN_MS;
    const expiresAtMs = now + 300_000;

    const smsRes = await fetch(config.smsWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, code, expires_in_secs: 300 }),
      signal: AbortSignal.timeout(8000),
    });
    if (!smsRes.ok) {
      throw new ApiError(502, 'sms_delivery_failed', `SMS gateway returned HTTP ${smsRes.status}`);
    }

    db.prepare(`
      INSERT INTO otp_challenges (
        challenge_id, channel, target, code, attempts, resend_after_ms, expires_at_ms, created_at_ms
      ) VALUES (?, 'phone', ?, ?, 0, ?, ?, ?)
    `).run(challengeId, phone, code, resendAfterMs, expiresAtMs, now);

    sendJson(ctx.res, 200, {
      ok: true,
      sent: true,
      phone_code_hash: challengeId,
      timeout_secs: 300,
      code_length: code.length,
      expires_at_ms: expiresAtMs,
      resend_after_ms: resendAfterMs,
    });
  };
  router.post('/api/v1/auth/phone/send-code', handlePhoneSendCode);
  router.post('/api/v1/auth/send-code', handlePhoneSendCode);

  // 2. Phone Verify / Sign-In (with constant-time OTP check + Cloud 2FA enforcement)
  const makePhoneVerifyHandler =
    (isLegacySignInPath: boolean) =>
    async (ctx: RequestContext): Promise<void> => {
      const body = await readJsonBody<{
        phone?: unknown;
        phone_number?: unknown;
        phone_code_hash?: unknown;
        code?: unknown;
        phone_code?: unknown;
        password?: unknown;
        two_fa_password?: unknown;
        cloud_password?: unknown;
        first_name?: unknown;
        last_name?: unknown;
        username?: unknown;
        device_name?: unknown;
      }>(ctx.req);

      const rawPhone = readOptionalTrimmedString(
        body.phone ?? body.phone_number,
        'invalid_phone',
        'Phone number must be a string',
      ).replace(/[\s()-]/g, '');
      const phone = rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`;
      const code = readOptionalTrimmedString(
        body.code ?? body.phone_code,
        'invalid_code',
        'Verification code must be a string',
      );
      const phoneCodeHash = readOptionalTrimmedString(
        body.phone_code_hash,
        'invalid_phone_code_hash',
        'phone_code_hash must be a string',
      );
      const deviceName =
        readOptionalTrimmedString(
          body.device_name,
          'invalid_device_name',
          'device_name must be a string',
        ) || 'Fabushi Web Phone';
      const now = Date.now();

      if (!rawPhone || !code) {
        throw new ApiError(400, 'missing_fields', 'Phone number and verification code are required');
      }

      const challenge = (
        phoneCodeHash
          ? db
              .prepare(`SELECT * FROM otp_challenges WHERE challenge_id = ? AND target = ?`)
              .get(phoneCodeHash, phone)
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
      if (!constantTimeUtf8Equals(challenge.code, code)) {
        db.prepare(`UPDATE otp_challenges SET attempts = attempts + 1 WHERE challenge_id = ?`).run(
          challenge.challenge_id,
        );
        throw new ApiError(401, 'invalid_code', 'Invalid phone verification code');
      }

      db.prepare(`DELETE FROM otp_challenges WHERE challenge_id = ?`).run(challenge.challenge_id);

      let userRow = db.prepare(`SELECT user_id FROM users WHERE phone = ?`).get(phone) as
        | { user_id: number }
        | undefined;

      if (!userRow) {
        const newUserId = getNextUserId(db);
        const firstName =
          readOptionalTrimmedString(
            body.first_name,
            'invalid_first_name',
            'First name must be a string',
          ) || `User ${phone.slice(-4)}`;
        const lastName =
          readOptionalTrimmedString(
            body.last_name,
            'invalid_last_name',
            'Last name must be a string',
          ) || null;
        const username =
          readOptionalTrimmedString(
            body.username,
            'invalid_username',
            'Username must be 5–32 alphanumeric/underscore characters',
          ).replace(/^@/, '') || `u_${newUserId}`;
        if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) {
          throw new ApiError(
            400,
            'invalid_username',
            'Username must be 5–32 alphanumeric/underscore characters',
          );
        }
        db.prepare(`
          INSERT INTO users (
            user_id, username, first_name, last_name, phone, is_bot, is_verified, is_premium,
            status, last_seen_ms, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 'online', ?, ?, ?)
        `).run(newUserId, username, firstName, lastName, phone, now, now, now);
        userRow = { user_id: newUserId };
      }

      const userId = Number(userRow.user_id);
      const twoFa = getTwoFaRecord(db, userId);

      if (twoFa) {
        const providedTwoFa = body.two_fa_password ?? body.cloud_password ?? body.password;
        if (providedTwoFa) {
          if (
            typeof providedTwoFa !== 'string' ||
            Buffer.byteLength(providedTwoFa, 'utf8') > MAX_PASSWORD_UTF8_BYTES ||
            !verifySecretScrypt(providedTwoFa, twoFa.salt_hex, twoFa.hash_hex)
          ) {
            throw new ApiError(401, 'invalid_2fa_password', 'Incorrect Cloud 2FA password');
          }
        } else {
          const challengeToken = `2fa_${crypto.randomBytes(16).toString('hex')}`;
          db.prepare(`
            INSERT INTO twofa_challenges (challenge_token, user_id, device_name, expires_at_ms)
            VALUES (?, ?, ?, ?)
          `).run(challengeToken, userId, deviceName, now + 300_000);

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

      const auth = issueSessionForUser(
        db,
        userId,
        deviceName,
        extractClientIp(ctx.req),
      );
      sendJson(ctx.res, 200, auth);
    };
  router.post('/api/v1/auth/phone/verify', makePhoneVerifyHandler(false));
  router.post('/api/v1/auth/sign-in', makePhoneVerifyHandler(true));

  // 3. Cloud 2FA Status, Set, Disable & Challenge Verify
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
    if (typeof newPwd !== 'string' || newPwd.length < 4) {
      throw new ApiError(400, 'weak_password', '2FA password must be at least 4 characters');
    }
    if (Buffer.byteLength(newPwd, 'utf8') > MAX_PASSWORD_UTF8_BYTES) {
      throw new ApiError(400, 'password_too_long', '2FA password exceeds maximum allowed length');
    }

    const existing = getTwoFaRecord(db, auth.userId);
    if (existing) {
      if (
        typeof body.current_password !== 'string' ||
        !body.current_password ||
        Buffer.byteLength(body.current_password, 'utf8') > MAX_PASSWORD_UTF8_BYTES ||
        !verifySecretScrypt(body.current_password, existing.salt_hex, existing.hash_hex)
      ) {
        throw new ApiError(401, 'invalid_current_password', 'Current 2FA password is incorrect');
      }
    }

    const hint = readOptionalTrimmedString(body.hint, 'invalid_hint', '2FA hint must be a string');
    const recoveryEmail =
      readOptionalTrimmedString(
        body.recovery_email,
        'invalid_email',
        'Recovery email must be a string',
      ) || null;
    const { saltHex, hashHex } = hashSecretScrypt(newPwd);
    const now = Date.now();
    db.prepare(`
      INSERT OR REPLACE INTO twofa_secrets (user_id, salt_hex, hash_hex, hint, recovery_email, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(auth.userId, saltHex, hashHex, hint, recoveryEmail, now);

    sendJson(ctx.res, 200, {
      ok: true,
      enabled: true,
      has_password: true,
      hint,
      recovery_email: recoveryEmail,
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
      if (
        typeof provided !== 'string' ||
        !provided ||
        Buffer.byteLength(provided, 'utf8') > MAX_PASSWORD_UTF8_BYTES ||
        !verifySecretScrypt(provided, existing.salt_hex, existing.hash_hex)
      ) {
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
      challenge_token?: unknown;
      password?: unknown;
      cloud_password?: unknown;
      device_name?: unknown;
    }>(ctx.req);
    const token = readOptionalTrimmedString(
      body.challenge_token,
      'invalid_challenge',
      'challenge_token must be a string',
    );
    const pwd = body.password ?? body.cloud_password ?? '';
    const deviceName = readOptionalTrimmedString(
      body.device_name,
      'invalid_device_name',
      'device_name must be a string',
    );

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
    if (
      !twoFa ||
      typeof pwd !== 'string' ||
      Buffer.byteLength(pwd, 'utf8') > MAX_PASSWORD_UTF8_BYTES ||
      !verifySecretScrypt(pwd, twoFa.salt_hex, twoFa.hash_hex)
    ) {
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
      deviceName || ch.device_name || 'Fabushi Web Client',
      extractClientIp(ctx.req),
    );
    sendJson(ctx.res, 200, auth);
  });

  // 4. Two-Device Real SVG QR Pairing (strictly requires signed-in Bearer on approval)
  const handlePairInit = async (ctx: RequestContext): Promise<void> => {
    const body = await readJsonBody<{ device_name?: unknown }>(ctx.req);
    const deviceName =
      readOptionalTrimmedString(
        body.device_name,
        'invalid_device_name',
        'device_name must be a string',
      ) || 'Fabushi Web QR';
    const pairId = `qr_${crypto.randomBytes(12).toString('hex')}`;
    const qrUrl = `tg://login?token=${pairId}`;
    const svg = generateQrCodeSvg(qrUrl);
    const now = Date.now();
    const expiresAtMs = now + 180_000;

    db.prepare(`
      INSERT INTO qr_pair_sessions (
        pair_id, qr_url, svg, device_name, status, expires_at_ms, created_at_ms
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `).run(pairId, qrUrl, svg, deviceName, expiresAtMs, now);

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
    const callerSession = requireAuth(db, ctx);
    const body = await readJsonBody<{ pair_token?: unknown; pair_id?: unknown; user_id?: number }>(
      ctx.req,
    );
    const pairId = readOptionalTrimmedString(
      ctx.params.pairId ?? body.pair_token ?? body.pair_id,
      'invalid_pair_id',
      'pair_id or pair_token must be a string',
    );
    if (!pairId) {
      throw new ApiError(400, 'missing_pair_id', 'pair_id or pair_token is required');
    }
    if (body.user_id !== undefined && Number(body.user_id) !== callerSession.userId) {
      throw new ApiError(403, 'forbidden', 'Cannot approve QR session on behalf of another user');
    }

    const row = db
      .prepare(`SELECT * FROM qr_pair_sessions WHERE pair_id = ?`)
      .get(pairId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new ApiError(404, 'pair_not_found', 'QR pairing session not found');
    }
    if (Number(row.expires_at_ms) < Date.now()) {
      throw new ApiError(410, 'pair_expired', 'QR pairing session expired');
    }
    if (String(row.status) !== 'pending') {
      throw new ApiError(409, 'pair_already_used', 'QR pairing session has already been used');
    }

    const auth = issueSessionForUser(
      db,
      callerSession.userId,
      String(row.device_name ?? 'Fabushi Web QR'),
      extractClientIp(ctx.req),
    );

    const upd = db
      .prepare(`
        UPDATE qr_pair_sessions
        SET status = 'approved', approved_user_id = ?, issued_token = ?, issued_session_id = ?
        WHERE pair_id = ? AND status = 'pending'
      `)
      .run(callerSession.userId, auth.token, auth.session_id, pairId);

    if (Number(upd.changes) !== 1) {
      db.prepare(`UPDATE auth_sessions SET revoked = 1 WHERE session_id = ?`).run(auth.session_id);
      throw new ApiError(409, 'pair_already_used', 'QR pairing session has already been used');
    }

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
  router.post('/api/v1/auth/pair/verify', handlePairApprove);

  const handlePairPoll = async (ctx: RequestContext): Promise<void> => {
    let pairId = (
      ctx.params.pairId ??
      ctx.query.get('pair_token') ??
      ctx.query.get('pair_id') ??
      ''
    ).trim();
    if (!pairId && ctx.method === 'POST') {
      const body = await readJsonBody<{ pair_token?: unknown; pair_id?: unknown }>(ctx.req);
      pairId = readOptionalTrimmedString(
        body.pair_token ?? body.pair_id,
        'invalid_pair_id',
        'pair_id or pair_token must be a string',
      );
    }
    const row = db
      .prepare(`SELECT * FROM qr_pair_sessions WHERE pair_id = ?`)
      .get(pairId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new ApiError(404, 'pair_not_found', 'QR pairing session not found');
    }

    const now = Date.now();
    let status = String(row.status);
    if (Number(row.expires_at_ms) < now) {
      if (status === 'pending' || status === 'approved') {
        db.prepare(
          `UPDATE qr_pair_sessions
           SET status = 'expired', issued_token = NULL
           WHERE pair_id = ?`,
        ).run(pairId);
      }
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
  router.get('/api/v1/auth/pair/status', handlePairPoll);
  router.post('/api/v1/auth/pair/status', handlePairPoll);

  // 5. Username / Password & Split-Key V2 Register & Login
  const handleRegister = async (ctx: RequestContext): Promise<void> => {
    const body = await readJsonBody<{
      username?: unknown;
      password?: string;
      first_name?: unknown;
      last_name?: unknown;
      phone?: unknown;
      device_name?: string;
      auth_version?: number;
      auth_salt_b64?: string;
      auth_verifier_b64?: string;
      kdf_params?: Argon2KdfParamsDto;
    }>(ctx.req);

    if (typeof body.username !== 'string') {
      throw new ApiError(
        400,
        'invalid_username',
        'Username must be 5–32 alphanumeric/underscore characters',
      );
    }
    const username = body.username.trim().replace(/^@/, '');
    const firstName =
      typeof body.first_name === 'string' ? body.first_name.trim() : username;

    if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) {
      throw new ApiError(
        400,
        'invalid_username',
        'Username must be 5–32 alphanumeric/underscore characters',
      );
    }

    const resolvedAuth = resolveRegisterAuth(body);

    const dup = db
      .prepare(`SELECT user_id FROM users WHERE LOWER(username) = LOWER(?)`)
      .get(username);
    if (dup) {
      throw new ApiError(409, 'username_taken', `Username @${username} is already taken`);
    }

    const newUserId = getNextUserId(db);
    const { saltHex, hashHex } = hashSecretScrypt(resolvedAuth.secretToHash);
    const now = Date.now();

    db.prepare(`
      INSERT INTO users (
        user_id, username, first_name, last_name, phone, password_salt, password_hash,
        is_bot, is_verified, is_premium, status, last_seen_ms, created_at_ms,
        auth_version, auth_salt_b64, auth_kdf_m_kib, auth_kdf_t_cost, auth_kdf_p_cost,
        account_generation, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 'online', ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(
      newUserId,
      username,
      firstName || username,
      typeof body.last_name === 'string' ? body.last_name.trim() : null,
      typeof body.phone === 'string' ? body.phone.trim() || null : null,
      saltHex,
      hashHex,
      now,
      now,
      resolvedAuth.authVersion,
      resolvedAuth.authSaltB64,
      resolvedAuth.kdfParams?.m_cost_kib ?? null,
      resolvedAuth.kdfParams?.t_cost ?? null,
      resolvedAuth.kdfParams?.p_cost ?? null,
      now,
    );

    const deviceName =
      readOptionalTrimmedString(
        body.device_name,
        'invalid_device_name',
        'device_name must be a string',
      ) || 'Fabushi Web Register';

    const auth = issueSessionForUser(
      db,
      newUserId,
      deviceName,
      extractClientIp(ctx.req),
    );
    sendJson(ctx.res, 201, auth);
  };
  router.post('/api/v1/auth/register', handleRegister);
  router.post('/api/v1/auth/password/register', handleRegister);

  const handleLogin = async (ctx: RequestContext): Promise<void> => {
    const body = await readJsonBody<{
      username?: unknown;
      username_or_email?: unknown;
      password?: unknown;
      auth_verifier_b64?: unknown;
      two_fa_password?: unknown;
      cloud_password?: unknown;
      device_name?: unknown;
    }>(ctx.req);

    const ident = readOptionalTrimmedString(
      body.username ?? body.username_or_email,
      'invalid_username',
      'Username or email must be a string',
    ).replace(/^@/, '');
    if (
      body.password !== undefined &&
      body.password !== null &&
      typeof body.password !== 'string'
    ) {
      throw new ApiError(400, 'invalid_credentials', 'Password must be a string');
    }
    const password = typeof body.password === 'string' ? body.password : '';
    const authVerifier = readOptionalTrimmedString(
      body.auth_verifier_b64,
      'invalid_verifier',
      'auth_verifier_b64 must be a string',
    );
    const deviceName =
      readOptionalTrimmedString(
        body.device_name,
        'invalid_device_name',
        'device_name must be a string',
      ) || 'Fabushi Web Login';

    if (
      !ident ||
      ident.length > 128 ||
      Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_UTF8_BYTES ||
      Buffer.byteLength(authVerifier, 'utf8') > MAX_PASSWORD_UTF8_BYTES
    ) {
      throw new ApiError(401, 'invalid_credentials', 'Invalid username or password');
    }

    const row = db
      .prepare(
        `SELECT user_id, password_salt, password_hash, auth_version
         FROM users
         WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)
         LIMIT 1`,
      )
      .get(ident, ident) as
      | {
          user_id: number;
          password_salt: string | null;
          password_hash: string | null;
          auth_version: number;
        }
      | undefined;

    if (!row || !row.password_salt || !row.password_hash) {
      throw new ApiError(401, 'invalid_credentials', 'Invalid username or password');
    }

    if (Number(row.auth_version) === 2) {
      // Split-Key V2 accounts strictly reject raw plaintext password login
      if (!authVerifier || !verifySecretScrypt(authVerifier, row.password_salt, row.password_hash)) {
        throw new ApiError(401, 'invalid_credentials', 'Invalid username or password');
      }
    } else {
      if (!password || !verifySecretScrypt(password, row.password_salt, row.password_hash)) {
        throw new ApiError(401, 'invalid_credentials', 'Invalid username or password');
      }
    }

    const userId = Number(row.user_id);
    const twoFa = getTwoFaRecord(db, userId);
    if (twoFa) {
      const providedTwoFa = body.two_fa_password ?? body.cloud_password;
      if (!providedTwoFa) {
        const chTok = `2fa_${crypto.randomBytes(16).toString('hex')}`;
        db.prepare(
          `INSERT INTO twofa_challenges (challenge_token, user_id, device_name, expires_at_ms) VALUES (?, ?, ?, ?)`,
        ).run(chTok, userId, deviceName, Date.now() + 300_000);
        sendJson(ctx.res, 200, {
          requires_2fa: true,
          two_fa_required: true,
          challenge_token: chTok,
          hint: twoFa.hint ?? '',
          password_hint: twoFa.hint ?? '',
          user_id: userId,
        });
        return;
      }
      if (
        typeof providedTwoFa !== 'string' ||
        Buffer.byteLength(providedTwoFa, 'utf8') > MAX_PASSWORD_UTF8_BYTES ||
        !verifySecretScrypt(providedTwoFa, twoFa.salt_hex, twoFa.hash_hex)
      ) {
        throw new ApiError(401, 'invalid_2fa_password', 'Incorrect Cloud 2FA password');
      }
    }

    const auth = issueSessionForUser(
      db,
      userId,
      deviceName,
      extractClientIp(ctx.req),
    );
    sendJson(ctx.res, 200, auth);
  };
  router.post('/api/v1/auth/login', handleLogin);
  router.post('/api/v1/auth/password/login', handleLogin);

  // 6. Email OTP Flow (Real Delivery + Cooldown + Cloud 2FA Enforcement + Split-Key V2 Register)
  router.post('/api/v1/auth/email/send-code', async (ctx) => {
    const body = await readJsonBody<{ email?: unknown }>(ctx.req);
    const email = readOptionalTrimmedString(
      body.email,
      'invalid_email',
      'Valid email address is required',
    ).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new ApiError(400, 'invalid_email', 'Valid email address is required');
    }
    const now = Date.now();

    const latest = db
      .prepare(
        `SELECT challenge_id, resend_after_ms FROM otp_challenges
         WHERE channel = 'email' AND target = ?
         ORDER BY created_at_ms DESC LIMIT 1`,
      )
      .get(email) as { challenge_id: string; resend_after_ms: number } | undefined;

    if (latest && latest.resend_after_ms > now) {
      const retrySecs = Math.max(1, Math.ceil((latest.resend_after_ms - now) / 1000));
      throw new ApiError(429, 'rate_limited', `Retry after ${retrySecs}s`, {
        retry_after_secs: retrySecs,
      });
    }

    if (!config.mailWebhookUrl) {
      throw new ApiError(
        503,
        'email_gateway_not_configured',
        'Email OTP delivery is not configured on this server. Please configure AUTH_SYSTEM_MAIL_URL or connect UPSTREAM_SERVER_URL.',
      );
    }

    const challengeId = `ech_${crypto.randomBytes(10).toString('hex')}`;
    const code = String(crypto.randomInt(100000, 1000000));
    const resendAfterMs = now + OTP_COOLDOWN_MS;
    const expiresAtMs = now + 300_000;

    const mailRes = await fetch(config.mailWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code, expires_in_secs: 300 }),
      signal: AbortSignal.timeout(8000),
    });
    if (!mailRes.ok) {
      throw new ApiError(502, 'email_delivery_failed', `Mail gateway returned HTTP ${mailRes.status}`);
    }

    db.prepare(`
      INSERT INTO otp_challenges (
        challenge_id, channel, target, code, attempts, resend_after_ms, expires_at_ms, created_at_ms
      ) VALUES (?, 'email', ?, ?, 0, ?, ?, ?)
    `).run(challengeId, email, code, resendAfterMs, expiresAtMs, now);

    sendJson(ctx.res, 200, {
      ok: true,
      email_code_hash: challengeId,
      timeout_secs: 300,
      expires_at_ms: expiresAtMs,
      resend_after_ms: resendAfterMs,
    });
  });

  const verifyAndConsumeEmailOtp = (
    email: string,
    code: string,
    emailCodeHash?: string,
  ): void => {
    const now = Date.now();
    const ch = (
      emailCodeHash
        ? db
            .prepare(`SELECT * FROM otp_challenges WHERE challenge_id = ? AND target = ?`)
            .get(emailCodeHash, email)
        : db
            .prepare(
              `SELECT * FROM otp_challenges WHERE channel = 'email' AND target = ? ORDER BY created_at_ms DESC LIMIT 1`,
            )
            .get(email)
    ) as { challenge_id: string; code: string; attempts: number; expires_at_ms: number } | undefined;

    if (!ch || ch.expires_at_ms < now) {
      throw new ApiError(401, 'invalid_email_code', 'Invalid or expired email verification code');
    }
    if (Number(ch.attempts ?? 0) >= 5) {
      throw new ApiError(429, 'too_many_attempts', 'Too many failed verification attempts');
    }
    if (!constantTimeUtf8Equals(ch.code, code)) {
      db.prepare(`UPDATE otp_challenges SET attempts = attempts + 1 WHERE challenge_id = ?`).run(
        ch.challenge_id,
      );
      throw new ApiError(401, 'invalid_email_code', 'Invalid or expired email verification code');
    }
    db.prepare(`DELETE FROM otp_challenges WHERE challenge_id = ?`).run(ch.challenge_id);
  };

  router.post('/api/v1/auth/email/verify', async (ctx: RequestContext) => {
    const body = await readJsonBody<{
      email?: unknown;
      code?: unknown;
      email_code_hash?: unknown;
      username?: unknown;
      password?: string;
      two_fa_password?: unknown;
      cloud_password?: unknown;
      first_name?: unknown;
      last_name?: unknown;
      device_name?: unknown;
      auth_version?: number;
      auth_salt_b64?: string;
      auth_verifier_b64?: string;
      kdf_params?: Argon2KdfParamsDto;
    }>(ctx.req);

    const email = readOptionalTrimmedString(
      body.email,
      'invalid_email',
      'Valid email address is required',
    ).toLowerCase();
    const code = readOptionalTrimmedString(
      body.code,
      'invalid_code',
      'Verification code must be a string',
    );
    const emailCodeHash =
      readOptionalTrimmedString(
        body.email_code_hash,
        'invalid_email_code_hash',
        'email_code_hash must be a string',
      ) || undefined;
    const deviceName =
      readOptionalTrimmedString(
        body.device_name,
        'invalid_device_name',
        'device_name must be a string',
      ) || 'Fabushi Email OTP';
    if (!email || !code) {
      throw new ApiError(400, 'missing_fields', 'Email and verification code are required');
    }

    verifyAndConsumeEmailOtp(email, code, emailCodeHash);

    const now = Date.now();
    let userRow = db.prepare(`SELECT user_id FROM users WHERE LOWER(email) = ?`).get(email) as
      | { user_id: number }
      | undefined;

    if (userRow) {
      const existingUserId = Number(userRow.user_id);
      const twoFa = getTwoFaRecord(db, existingUserId);
      if (twoFa) {
        const providedTwoFa = body.two_fa_password ?? body.cloud_password;
        if (!providedTwoFa) {
          const challengeToken = `2fa_${crypto.randomBytes(16).toString('hex')}`;
          db.prepare(
            `INSERT INTO twofa_challenges (challenge_token, user_id, device_name, expires_at_ms) VALUES (?, ?, ?, ?)`,
          ).run(challengeToken, existingUserId, deviceName, now + 300_000);
          sendJson(ctx.res, 403, {
            error: '2fa_required',
            message: 'Cloud Two-Step Verification password required',
            requires_2fa: true,
            two_fa_required: true,
            challenge_token: challengeToken,
            hint: twoFa.hint ?? '',
            password_hint: twoFa.hint ?? '',
          });
          return;
        }
        if (
          typeof providedTwoFa !== 'string' ||
          Buffer.byteLength(providedTwoFa, 'utf8') > MAX_PASSWORD_UTF8_BYTES ||
          !verifySecretScrypt(providedTwoFa, twoFa.salt_hex, twoFa.hash_hex)
        ) {
          throw new ApiError(401, 'invalid_2fa_password', 'Incorrect Cloud 2FA password');
        }
      }
    } else {
      const newUserId = getNextUserId(db);
      const localPart = email.split('@')[0]?.replace(/[^A-Za-z0-9_]/g, '_') || `user_${newUserId}`;
      const desiredUsername =
        readOptionalTrimmedString(
          body.username,
          'invalid_username',
          'Username must be 5–32 alphanumeric/underscore characters',
        ).replace(/^@/, '') || `${localPart}_${newUserId}`;
      if (!/^[A-Za-z0-9_]{5,32}$/.test(desiredUsername)) {
        throw new ApiError(
          400,
          'invalid_username',
          'Username must be 5–32 alphanumeric/underscore characters',
        );
      }
      const dupU = db
        .prepare(`SELECT user_id FROM users WHERE LOWER(username) = LOWER(?)`)
        .get(desiredUsername);
      if (dupU) {
        throw new ApiError(409, 'username_taken', `Username @${desiredUsername} is already taken`);
      }

      const firstName =
        readOptionalTrimmedString(
          body.first_name,
          'invalid_first_name',
          'First name must be a string',
        ) || localPart;
      const lastName =
        readOptionalTrimmedString(
          body.last_name,
          'invalid_last_name',
          'Last name must be a string',
        ) || null;

      let saltHex: string | null = null;
      let hashHex: string | null = null;
      let authVersion: AuthVersion = 1;
      let authSaltB64: string | null = null;
      let kdfParams: Argon2KdfParamsDto | null = null;

      if (body.auth_version === 2) {
        const resolved = resolveRegisterAuth(body);
        const hashed = hashSecretScrypt(resolved.secretToHash);
        saltHex = hashed.saltHex;
        hashHex = hashed.hashHex;
        authVersion = 2;
        authSaltB64 = resolved.authSaltB64;
        kdfParams = resolved.kdfParams;
      } else if (typeof body.password === 'string' && body.password.length >= 6) {
        if (Buffer.byteLength(body.password, 'utf8') > MAX_PASSWORD_UTF8_BYTES) {
          throw new ApiError(400, 'password_too_long', 'Password exceeds maximum allowed length');
        }
        const hashed = hashSecretScrypt(body.password);
        saltHex = hashed.saltHex;
        hashHex = hashed.hashHex;
      }

      db.prepare(`
        INSERT INTO users (
          user_id, username, first_name, last_name, email, password_salt, password_hash,
          is_bot, is_verified, is_premium, status, last_seen_ms, created_at_ms,
          auth_version, auth_salt_b64, auth_kdf_m_kib, auth_kdf_t_cost, auth_kdf_p_cost,
          account_generation, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 'online', ?, ?, ?, ?, ?, ?, ?, 1, ?)
      `).run(
        newUserId,
        desiredUsername,
        firstName,
        lastName,
        email,
        saltHex,
        hashHex,
        now,
        now,
        authVersion,
        authSaltB64,
        kdfParams?.m_cost_kib ?? null,
        kdfParams?.t_cost ?? null,
        kdfParams?.p_cost ?? null,
        now,
      );
      userRow = { user_id: newUserId };
    }

    const auth = issueSessionForUser(
      db,
      Number(userRow.user_id),
      deviceName,
      extractClientIp(ctx.req),
    );
    sendJson(ctx.res, 200, auth);
  });

  // Dedicated Split-Key V2 / V1 Email Registration (`201 Created`)
  router.post('/api/v1/auth/email/register', async (ctx: RequestContext) => {
    const body = await readJsonBody<{
      email?: unknown;
      code?: unknown;
      email_code_hash?: unknown;
      username?: unknown;
      password?: string;
      first_name?: unknown;
      last_name?: unknown;
      device_name?: unknown;
      auth_version?: number;
      auth_salt_b64?: string;
      auth_verifier_b64?: string;
      kdf_params?: Argon2KdfParamsDto;
    }>(ctx.req);

    const email = readOptionalTrimmedString(
      body.email,
      'invalid_email',
      'Valid email address is required',
    ).toLowerCase();
    const code = readOptionalTrimmedString(
      body.code,
      'invalid_code',
      'Verification code must be a string',
    );
    const username = readOptionalTrimmedString(
      body.username,
      'invalid_username',
      'Username must be 5–32 alphanumeric/underscore characters',
    ).replace(/^@/, '');
    const emailCodeHash =
      readOptionalTrimmedString(
        body.email_code_hash,
        'invalid_email_code_hash',
        'email_code_hash must be a string',
      ) || undefined;
    const deviceName =
      readOptionalTrimmedString(
        body.device_name,
        'invalid_device_name',
        'device_name must be a string',
      ) || 'Fabushi Email Register';

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new ApiError(400, 'invalid_email', 'Valid email address is required');
    }
    if (!code) {
      throw new ApiError(400, 'missing_fields', 'Email verification code is required');
    }
    if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) {
      throw new ApiError(
        400,
        'invalid_username',
        'Username must be 5–32 alphanumeric/underscore characters',
      );
    }

    const firstName =
      readOptionalTrimmedString(
        body.first_name,
        'invalid_first_name',
        'First name must be a string',
      ) || (email.split('@')[0] || username);
    const lastName =
      readOptionalTrimmedString(
        body.last_name,
        'invalid_last_name',
        'Last name must be a string',
      ) || null;

    const resolvedAuth = resolveRegisterAuth(body);

    const existingEmail = db
      .prepare(`SELECT user_id FROM users WHERE LOWER(email) = ?`)
      .get(email);
    if (existingEmail) {
      throw new ApiError(409, 'email_already_registered', 'Email address is already registered');
    }

    const dupUsername = db
      .prepare(`SELECT user_id FROM users WHERE LOWER(username) = LOWER(?)`)
      .get(username);
    if (dupUsername) {
      throw new ApiError(409, 'username_taken', `Username @${username} is already taken`);
    }

    verifyAndConsumeEmailOtp(email, code, emailCodeHash);

    const newUserId = getNextUserId(db);
    const { saltHex, hashHex } = hashSecretScrypt(resolvedAuth.secretToHash);
    const now = Date.now();

    db.prepare(`
      INSERT INTO users (
        user_id, username, first_name, last_name, email, password_salt, password_hash,
        is_bot, is_verified, is_premium, status, last_seen_ms, created_at_ms,
        auth_version, auth_salt_b64, auth_kdf_m_kib, auth_kdf_t_cost, auth_kdf_p_cost,
        account_generation, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 'online', ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(
      newUserId,
      username,
      firstName,
      lastName,
      email,
      saltHex,
      hashHex,
      now,
      now,
      resolvedAuth.authVersion,
      resolvedAuth.authSaltB64,
      resolvedAuth.kdfParams?.m_cost_kib ?? null,
      resolvedAuth.kdfParams?.t_cost ?? null,
      resolvedAuth.kdfParams?.p_cost ?? null,
      now,
    );

    const auth = issueSessionForUser(
      db,
      newUserId,
      deviceName,
      extractClientIp(ctx.req),
    );
    sendJson(ctx.res, 201, auth);
  });

  // 7. Real Alipay OAuth QR Flow (bridged to official gateway; direct /confirm hijacking forbidden)
  const handleAlipayStart = async (ctx: RequestContext): Promise<void> => {
    await readJsonBody(ctx.req);
    const sessionId = `ali_${crypto.randomBytes(12).toString('hex')}`;
    const now = Date.now();
    const expiresAtMs = now + 600_000;

    const startEndpoint = `${config.oauthGatewayUrl}/api/auth/oauth/start`;
    let upstreamAttemptId: string;
    let qrUrl: string;
    try {
      const upRes = await fetch(startEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          provider: 'alipay',
          platform: 'web',
          deviceId: 'gpui-telegram-web',
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!upRes.ok) {
        throw new Error(`OAuth gateway returned HTTP ${upRes.status}`);
      }
      const val = (await upRes.json()) as {
        attemptId?: string;
        authorizationUrl?: string;
      };
      if (!val.attemptId || !val.authorizationUrl) {
        throw new Error('OAuth gateway returned incomplete Alipay authorization payload');
      }
      upstreamAttemptId = val.attemptId;
      const parsedAuth = new URL(val.authorizationUrl);
      const stateParam = parsedAuth.searchParams.get('state');
      qrUrl = stateParam
        ? `https://openauth.alipay.com/oauth2/publicAppAuthorize.htm?app_id=2021005193647715&scope=auth_user&redirect_uri=${encodeURIComponent(`${config.oauthGatewayUrl}/api/auth/alipay/callback`)}&state=${encodeURIComponent(stateParam)}`
        : val.authorizationUrl;
    } catch (err) {
      throw new ApiError(
        502,
        'alipay_oauth_unavailable',
        `Failed to initiate Alipay OAuth via ${config.oauthGatewayUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const svg = generateQrCodeSvg(qrUrl);

    db.prepare(`
      INSERT INTO alipay_sessions (
        session_id, qr_url, svg, status, expires_at_ms, created_at_ms, upstream_attempt_id
      ) VALUES (?, ?, ?, 'pending', ?, ?, ?)
    `).run(sessionId, qrUrl, svg, expiresAtMs, now, upstreamAttemptId);

    sendJson(ctx.res, 200, {
      session_id: sessionId,
      attempt_id: sessionId,
      auth_url: qrUrl,
      qr_url: qrUrl,
      qr_payload: qrUrl,
      svg,
      status: 'pending',
      expires_at_ms: expiresAtMs,
      poll_after_ms: 1000,
    });
  };
  router.post('/api/v1/auth/alipay/start', handleAlipayStart);
  router.post('/api/v1/auth/alipay/qr', handleAlipayStart);

  // Unconditionally forbid direct /alipay/confirm session hijacking!
  const handleAlipayConfirmForbidden = (): void => {
    throw new ApiError(
      403,
      'alipay_confirm_forbidden',
      'Direct Alipay confirmation is forbidden; Alipay OAuth must complete via verified OAuth callback.',
    );
  };
  router.post('/api/v1/auth/alipay/confirm', handleAlipayConfirmForbidden);
  router.post('/api/v1/auth/alipay/:sessionId/confirm', handleAlipayConfirmForbidden);

  const handleAlipayPoll = async (ctx: RequestContext): Promise<void> => {
    const sessionId = ctx.params.sessionId ?? ctx.query.get('session_id') ?? '';
    const row = db
      .prepare(`SELECT * FROM alipay_sessions WHERE session_id = ?`)
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new ApiError(404, 'alipay_session_not_found', 'Alipay session not found');
    }

    const now = Date.now();
    if (Number(row.expires_at_ms) < now && row.status === 'pending') {
      db.prepare(`UPDATE alipay_sessions SET status = 'expired' WHERE session_id = ?`).run(
        sessionId,
      );
      sendJson(ctx.res, 200, { status: 'expired', session_id: sessionId });
      return;
    }

    if (
      row.status === 'pending' &&
      typeof row.upstream_attempt_id === 'string' &&
      row.upstream_attempt_id
    ) {
      try {
        const pollRes = await fetch(
          `${config.oauthGatewayUrl}/api/auth/oauth/attempts/${encodeURIComponent(row.upstream_attempt_id)}`,
          { method: 'GET', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) },
        );
        if (pollRes.ok) {
          const val = (await pollRes.json()) as {
            status?: string;
            session?: { user?: Record<string, unknown> };
            user?: Record<string, unknown>;
          };
          if (val.status === 'completed' || val.status === 'complete') {
            const uObj = val.session?.user ?? val.user ?? {};
            const alipayUid = String(
              uObj.alipayUserId ?? uObj.id ?? `alipay_${row.upstream_attempt_id.slice(0, 12)}`,
            );
            const nickname =
              String(uObj.alipayNickname ?? uObj.nickname ?? uObj.username ?? '支付宝用户').trim() ||
              '支付宝用户';
            const cleanUsername = `ali_${alipayUid.replace(/[^A-Za-z0-9_]/g, '').slice(-16) || sessionId.slice(-8)}`;

            let userRow = db
              .prepare(`SELECT user_id FROM users WHERE LOWER(username) = LOWER(?)`)
              .get(cleanUsername) as { user_id: number } | undefined;
            if (!userRow) {
              const newUserId = getNextUserId(db);
              db.prepare(`
                INSERT INTO users (
                  user_id, username, first_name, is_bot, is_verified, is_premium,
                  status, last_seen_ms, created_at_ms, updated_at_ms
                ) VALUES (?, ?, ?, 0, 0, 0, 'online', ?, ?, ?)
              `).run(newUserId, cleanUsername, nickname, now, now, now);
              userRow = { user_id: newUserId };
            }

            const auth = issueSessionForUser(
              db,
              Number(userRow.user_id),
              'Alipay OAuth Web',
              extractClientIp(ctx.req),
            );
            db.prepare(`
              UPDATE alipay_sessions
              SET status = 'confirmed', approved_user_id = ?, issued_token = ?, issued_session_id = ?
              WHERE session_id = ?
            `).run(auth.user_id, auth.token, auth.session_id, sessionId);

            sendJson(ctx.res, 200, {
              status: 'completed',
              token: auth.token,
              user_id: auth.user_id,
              username: auth.username,
              session_id: auth.session_id,
              auth,
              session: auth,
              user: auth.user,
            });
            return;
          }
          if (val.status === 'expired' || val.status === 'failed' || val.status === 'cancelled') {
            db.prepare(`UPDATE alipay_sessions SET status = ? WHERE session_id = ?`).run(
              val.status,
              sessionId,
            );
            sendJson(ctx.res, 200, { status: val.status, session_id: sessionId });
            return;
          }
        }
      } catch {
        // Keep pending on transient upstream timeout
      }
    }

    if (
      (row.status === 'confirmed' || row.status === 'completed') &&
      row.approved_user_id &&
      row.issued_token
    ) {
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
        status: 'confirmed',
        token: session.token,
        user_id: session.user_id,
        username: session.username,
        session_id: session.session_id,
        auth: session,
        session,
        user,
      });
      return;
    }
    sendJson(ctx.res, 200, {
      status: String(row.status),
      session_id: sessionId,
    });
  };
  router.get('/api/v1/auth/alipay/poll/:sessionId', handleAlipayPoll);
  router.get('/api/v1/auth/alipay/poll', handleAlipayPoll);
  router.get('/api/v1/auth/alipay/:sessionId/status', handleAlipayPoll);

  // 8. Real Cryptographic WebAuthn Passkey Flow (COSE_Key CBOR + SPKI DER, ES256/EdDSA/RS256)
  router.post('/api/v1/auth/passkey/register/options', (ctx: RequestContext) => {
    const auth = requireAuth(db, ctx);
    const user = getUserProfileDto(db, auth.userId);
    if (!user) {
      throw new ApiError(404, 'user_not_found', 'User not found');
    }
    const challengeId = `pkr_${crypto.randomBytes(10).toString('hex')}`;
    const challenge = crypto.randomBytes(32).toString('base64url');
    const rpId = resolveRequestRpId(ctx.req);
    const now = Date.now();

    db.prepare(`
      INSERT INTO passkey_challenges (challenge_id, challenge, username, user_id, purpose, rp_id, expires_at_ms)
      VALUES (?, ?, ?, ?, 'register', ?, ?)
    `).run(challengeId, challenge, user.username ?? null, auth.userId, rpId, now + 60_000);

    const existingCreds = db
      .prepare(`SELECT cred_id FROM account_passkeys WHERE user_id = ?`)
      .all(auth.userId) as Array<{ cred_id: string }>;

    sendJson(ctx.res, 200, {
      challenge_id: challengeId,
      challenge,
      rp: { id: rpId, name: 'Fabushi Web' },
      rp_id: rpId,
      user: {
        id: Buffer.from(String(auth.userId), 'utf8').toString('base64url'),
        name: user.username ?? `user${auth.userId}`,
        displayName: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.first_name,
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -8 },
        { type: 'public-key', alg: -257 },
      ],
      excludeCredentials: existingCreds.map((c) => ({
        type: 'public-key',
        id: c.cred_id,
      })),
      timeout: 60_000,
      timeout_ms: 60_000,
    });
  });

  const handlePasskeyLoginOptions = async (ctx: RequestContext): Promise<void> => {
    const body = await readJsonBody<{ username?: unknown }>(ctx.req);
    const cleanUsername =
      readOptionalTrimmedString(
        body.username,
        'invalid_username',
        'Username must be a string',
      ).replace(/^@/, '') || null;
    const challengeId = `pkc_${crypto.randomBytes(10).toString('hex')}`;
    const challenge = crypto.randomBytes(32).toString('base64url');
    const rpId = resolveRequestRpId(ctx.req);
    const now = Date.now();

    db.prepare(`
      INSERT INTO passkey_challenges (challenge_id, challenge, username, user_id, purpose, rp_id, expires_at_ms)
      VALUES (?, ?, ?, NULL, 'auth', ?, ?)
    `).run(challengeId, challenge, cleanUsername, rpId, now + 60_000);

    let allowCredentials: Array<{ type: 'public-key'; id: string }> = [];
    if (cleanUsername) {
      const userRow = db
        .prepare(`SELECT user_id FROM users WHERE LOWER(username) = LOWER(?)`)
        .get(cleanUsername) as { user_id: number } | undefined;
      if (userRow) {
        const creds = db
          .prepare(`SELECT cred_id FROM account_passkeys WHERE user_id = ?`)
          .all(Number(userRow.user_id)) as Array<{ cred_id: string }>;
        allowCredentials = creds.map((c) => ({ type: 'public-key', id: c.cred_id }));
      }
    }

    sendJson(ctx.res, 200, {
      challenge_id: challengeId,
      challenge,
      rp_id: rpId,
      rpId,
      allowCredentials,
      userVerification: 'preferred',
      timeout: 60_000,
      timeout_ms: 60_000,
    });
  };
  router.post('/api/v1/auth/passkey/challenge', handlePasskeyLoginOptions);
  router.post('/api/v1/auth/passkey/login/options', handlePasskeyLoginOptions);

  const handlePasskeyRegister = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      challenge_id?: string;
      cred_id?: unknown;
      credential_id?: unknown;
      id?: unknown;
      rawId?: unknown;
      label?: unknown;
      device_name?: unknown;
      public_key_b64?: string;
      public_key?: string;
      attestationObject?: string;
      attestation_object?: string;
      clientDataJSON?: string;
      client_data_json?: string;
      response?: {
        attestationObject?: string;
        attestation_object?: string;
        clientDataJSON?: string;
        client_data_json?: string;
        publicKey?: string;
        public_key_b64?: string;
      };
    }>(ctx.req);

    const challengeId = readOptionalTrimmedString(
      body.challenge_id,
      'invalid_passkey_challenge',
      'challenge_id must be a string',
    );
    const rawCredId = body.cred_id ?? body.credential_id ?? body.id ?? body.rawId;
    if (rawCredId !== undefined && rawCredId !== null && typeof rawCredId !== 'string') {
      throw new ApiError(400, 'invalid_credential_id', 'Credential ID must be a string');
    }
    const normalizedSuppliedCredId = typeof rawCredId === 'string' ? rawCredId.trim() : '';

    const respObj =
      body.response && typeof body.response === 'object' && !Array.isArray(body.response)
        ? body.response
        : undefined;
    const attestationRaw = readOptionalTrimmedString(
      body.attestationObject ??
        body.attestation_object ??
        respObj?.attestationObject ??
        respObj?.attestation_object,
      'invalid_passkey_attestation',
      'attestationObject must be a string',
    );
    const clientDataRaw = readOptionalTrimmedString(
      body.clientDataJSON ??
        body.client_data_json ??
        respObj?.clientDataJSON ??
        respObj?.client_data_json,
      'invalid_passkey_attestation',
      'clientDataJSON must be a string',
    );
    const directPubKeyRaw =
      body.public_key_b64 ??
      body.public_key ??
      respObj?.public_key_b64 ??
      respObj?.publicKey;

    const rawLabel = body.label ?? body.device_name;
    const label = (typeof rawLabel === 'string' ? rawLabel.trim() : '') || 'Platform Passkey';
    const now = Date.now();
    const reqOriginHeader =
      typeof ctx.req.headers.origin === 'string' ? ctx.req.headers.origin : undefined;

    let credId: string;
    let storedPubKeyB64: string;
    let coseAlg: number;
    let initialSignCount = 0;

    if (attestationRaw) {
      if (!clientDataRaw) {
        throw new ApiError(
          400,
          'invalid_passkey_attestation',
          'clientDataJSON is required when registering via attestationObject',
        );
      }
      const clientData = parseWebAuthnClientDataJson(
        clientDataRaw,
        'webauthn.create',
        'invalid_passkey_attestation',
      );

      const ch = (
        challengeId
          ? db
              .prepare(`SELECT * FROM passkey_challenges WHERE challenge_id = ?`)
              .get(challengeId)
          : db
              .prepare(`SELECT * FROM passkey_challenges WHERE challenge = ?`)
              .get(stripBase64Padding(clientData.challenge))
      ) as
        | {
            challenge_id: string;
            challenge: string;
            user_id: number | null;
            purpose: string;
            rp_id: string | null;
            expires_at_ms: number;
          }
        | undefined;

      if (!ch || ch.purpose !== 'register' || ch.expires_at_ms < now) {
        throw new ApiError(401, 'invalid_passkey_challenge', 'Registration challenge is invalid or expired');
      }
      if (ch.user_id !== null && Number(ch.user_id) !== auth.userId) {
        throw new ApiError(403, 'forbidden', 'Registration challenge belongs to another user');
      }
      const del = db
        .prepare(`DELETE FROM passkey_challenges WHERE challenge_id = ?`)
        .run(ch.challenge_id);
      if (Number(del.changes) !== 1) {
        throw new ApiError(401, 'invalid_passkey_challenge', 'Registration challenge already consumed');
      }
      if (
        !constantTimeUtf8Equals(
          stripBase64Padding(clientData.challenge),
          stripBase64Padding(ch.challenge),
        )
      ) {
        throw new ApiError(401, 'invalid_passkey_challenge', 'Registration challenge mismatch');
      }

      let attObjBuf: Buffer;
      try {
        attObjBuf = decodeBase64AnyStrict(attestationRaw);
      } catch {
        throw new ApiError(400, 'invalid_passkey_attestation', 'Invalid attestationObject encoding');
      }

      let parsedAtt: ReturnType<typeof parseWebAuthnAttestationObject>;
      try {
        parsedAtt = parseWebAuthnAttestationObject(attObjBuf);
      } catch (err) {
        throw new ApiError(
          400,
          'invalid_passkey_attestation',
          err instanceof Error ? err.message : 'Invalid WebAuthn attestationObject',
        );
      }

      if (!parsedAtt.authData.up) {
        throw new ApiError(401, 'user_not_present', 'Authenticator UP flag must be set');
      }
      const expectedRpId = ch.rp_id || resolveRequestRpId(ctx.req);
      const originCheck = isAllowedWebAuthnOriginAndRpId(
        clientData.origin,
        reqOriginHeader,
        expectedRpId,
        parsedAtt.authData.rpIdHash,
      );
      if (!originCheck.ok) {
        throw new ApiError(401, originCheck.code, originCheck.message);
      }

      let parsedKey: ReturnType<typeof parseWebAuthnPublicKey>;
      try {
        parsedKey = parseWebAuthnPublicKey(parsedAtt.authData.credentialPublicKeyBytes!);
      } catch (err) {
        throw new ApiError(
          400,
          'invalid_public_key',
          err instanceof Error ? err.message : 'Unsupported WebAuthn credential public key',
        );
      }

      const attestedCredIdBuf = parsedAtt.authData.credentialId!;
      const attestedCredIdB64Url = attestedCredIdBuf.toString('base64url');
      const suppliedCredId = normalizedSuppliedCredId;
      if (suppliedCredId) {
        let matches = suppliedCredId === attestedCredIdB64Url;
        if (!matches) {
          try {
            matches = decodeBase64AnyStrict(suppliedCredId).equals(attestedCredIdBuf);
          } catch {
            matches = false;
          }
        }
        if (!matches) {
          throw new ApiError(
            400,
            'credential_id_mismatch',
            'Provided credential ID does not match attested credential ID in attestationObject',
          );
        }
      }

      credId = attestedCredIdB64Url;
      storedPubKeyB64 = parsedKey.normalizedPublicKeyB64;
      coseAlg = parsedKey.alg;
      initialSignCount = parsedAtt.authData.signCount;
    } else {
      if (typeof directPubKeyRaw !== 'string' || !directPubKeyRaw.trim()) {
        throw new ApiError(
          400,
          'invalid_public_key',
          'A valid COSE_Key or SPKI DER public_key_b64 (or attestationObject) is required',
        );
      }
      let parsedKey: ReturnType<typeof parseWebAuthnPublicKey>;
      try {
        parsedKey = parseWebAuthnPublicKey(directPubKeyRaw);
      } catch (err) {
        throw new ApiError(
          400,
          'invalid_public_key',
          err instanceof Error ? err.message : 'Invalid COSE_Key or SPKI DER public key',
        );
      }

      if (clientDataRaw) {
        const parsedCd = parseWebAuthnClientDataJson(
          clientDataRaw,
          'webauthn.create',
          'invalid_passkey_attestation',
        );

        const ch = (
          challengeId
            ? db
                .prepare(`SELECT * FROM passkey_challenges WHERE challenge_id = ?`)
                .get(challengeId)
            : db
                .prepare(`SELECT * FROM passkey_challenges WHERE challenge = ?`)
                .get(stripBase64Padding(parsedCd.challenge))
        ) as
          | {
              challenge_id: string;
              challenge: string;
              user_id: number | null;
              purpose: string;
              rp_id: string | null;
              expires_at_ms: number;
            }
          | undefined;

        if (!ch || ch.purpose !== 'register' || ch.expires_at_ms < now) {
          throw new ApiError(
            401,
            'invalid_passkey_challenge',
            'Registration challenge is invalid or expired',
          );
        }
        if (ch.user_id !== null && Number(ch.user_id) !== auth.userId) {
          throw new ApiError(403, 'forbidden', 'Registration challenge belongs to another user');
        }
        const del = db
          .prepare(`DELETE FROM passkey_challenges WHERE challenge_id = ?`)
          .run(ch.challenge_id);
        if (Number(del.changes) !== 1) {
          throw new ApiError(
            401,
            'invalid_passkey_challenge',
            'Registration challenge already consumed',
          );
        }
        if (
          !constantTimeUtf8Equals(
            stripBase64Padding(parsedCd.challenge),
            stripBase64Padding(ch.challenge),
          )
        ) {
          throw new ApiError(401, 'invalid_passkey_challenge', 'Registration challenge mismatch');
        }

        const expectedRpId = ch.rp_id || resolveRequestRpId(ctx.req);
        const originCheck = isAllowedWebAuthnOriginAndRpId(
          parsedCd.origin,
          reqOriginHeader,
          expectedRpId,
        );
        if (!originCheck.ok) {
          throw new ApiError(401, originCheck.code, originCheck.message);
        }
      } else if (challengeId) {
        const ch = db
          .prepare(`SELECT * FROM passkey_challenges WHERE challenge_id = ?`)
          .get(challengeId) as
          | {
              challenge_id: string;
              challenge: string;
              user_id: number | null;
              purpose: string;
              expires_at_ms: number;
            }
          | undefined;
        if (!ch || ch.purpose !== 'register' || ch.expires_at_ms < now) {
          throw new ApiError(
            401,
            'invalid_passkey_challenge',
            'Registration challenge is invalid or expired',
          );
        }
        if (ch.user_id !== null && Number(ch.user_id) !== auth.userId) {
          throw new ApiError(403, 'forbidden', 'Registration challenge belongs to another user');
        }
        const del = db
          .prepare(`DELETE FROM passkey_challenges WHERE challenge_id = ?`)
          .run(ch.challenge_id);
        if (Number(del.changes) !== 1) {
          throw new ApiError(
            401,
            'invalid_passkey_challenge',
            'Registration challenge already consumed',
          );
        }
      }

      credId =
        normalizedSuppliedCredId ||
        `cred_${crypto.randomBytes(12).toString('hex')}`;
      storedPubKeyB64 = parsedKey.normalizedPublicKeyB64;
      coseAlg = parsedKey.alg;
    }

    const existingCred = db
      .prepare(`SELECT user_id FROM account_passkeys WHERE cred_id = ?`)
      .get(credId) as { user_id: number } | undefined;
    if (existingCred && Number(existingCred.user_id) !== auth.userId) {
      throw new ApiError(409, 'credential_conflict', 'Passkey credential ID already registered');
    }

    db.prepare(`
      INSERT OR REPLACE INTO account_passkeys (
        cred_id, user_id, label, public_key_b64, cose_alg, sign_count, created_at_ms, last_used_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(credId, auth.userId, label, storedPubKeyB64, coseAlg, initialSignCount, now, now);

    sendJson(ctx.res, 201, {
      cred_id: credId,
      credential_id: credId,
      label,
      cose_alg: coseAlg,
      created_at_ms: now,
      last_used_ms: now,
    });
  };
  router.post('/api/v1/auth/passkey/register', handlePasskeyRegister);
  router.post('/api/v1/auth/passkey/register/verify', handlePasskeyRegister);
  router.post('/api/v1/account/passkeys/register', handlePasskeyRegister);

  router.post('/api/v1/auth/passkey/verify', async (ctx: RequestContext) => {
    const body = await readJsonBody<{
      challenge_id?: unknown;
      challenge?: unknown;
      credential_id?: unknown;
      cred_id?: unknown;
      id?: unknown;
      rawId?: unknown;
      clientDataJSON?: unknown;
      client_data_json?: unknown;
      authenticatorData?: unknown;
      authenticator_data?: unknown;
      signature?: unknown;
      device_name?: unknown;
      response?: {
        clientDataJSON?: unknown;
        client_data_json?: unknown;
        authenticatorData?: unknown;
        authenticator_data?: unknown;
        signature?: unknown;
      };
    }>(ctx.req);

    const credentialId = readOptionalTrimmedString(
      body.credential_id ?? body.cred_id ?? body.id ?? body.rawId,
      'invalid_credential_id',
      'Credential ID must be a string',
    );
    const challengeId = readOptionalTrimmedString(
      body.challenge_id,
      'invalid_passkey_assertion',
      'challenge_id must be a string',
    );
    if (
      body.challenge !== undefined &&
      body.challenge !== null &&
      typeof body.challenge !== 'string'
    ) {
      throw new ApiError(400, 'invalid_passkey_assertion', 'challenge must be a string');
    }
    const respObj =
      body.response && typeof body.response === 'object' && !Array.isArray(body.response)
        ? body.response
        : undefined;
    const clientDataRaw = readOptionalTrimmedString(
      body.clientDataJSON ??
        body.client_data_json ??
        respObj?.clientDataJSON ??
        respObj?.client_data_json,
      'invalid_passkey_assertion',
      'clientDataJSON must be a string',
    );
    const authDataRaw = readOptionalTrimmedString(
      body.authenticatorData ??
        body.authenticator_data ??
        respObj?.authenticatorData ??
        respObj?.authenticator_data,
      'invalid_passkey_assertion',
      'authenticatorData must be a string',
    );
    const signatureRaw = readOptionalTrimmedString(
      body.signature ?? respObj?.signature,
      'invalid_passkey_assertion',
      'signature must be a string',
    );
    const deviceName =
      readOptionalTrimmedString(
        body.device_name,
        'invalid_device_name',
        'device_name must be a string',
      ) || 'WebAuthn Passkey';

    // Step 1: Reject missing WebAuthn cryptographic assertion fields
    if (!credentialId || !clientDataRaw || !authDataRaw || !signatureRaw) {
      throw new ApiError(
        400,
        'invalid_passkey_assertion',
        'WebAuthn assertion requires credential_id, clientDataJSON, authenticatorData, and signature',
      );
    }

    // Step 2: Decode & validate clientDataJSON
    const clientData = parseWebAuthnClientDataJson(
      clientDataRaw,
      'webauthn.get',
      'invalid_passkey_assertion',
    );
    const clientDataBytes = clientData.bytes;

    // Step 3: Lookup & atomically consume single-use challenge
    const now = Date.now();
    const ch = (
      challengeId
        ? db
            .prepare(`SELECT * FROM passkey_challenges WHERE challenge_id = ?`)
            .get(challengeId)
        : db
            .prepare(`SELECT * FROM passkey_challenges WHERE challenge = ?`)
            .get(stripBase64Padding(clientData.challenge))
    ) as
      | {
          challenge_id: string;
          challenge: string;
          username: string | null;
          purpose: string;
          rp_id: string | null;
          expires_at_ms: number;
        }
      | undefined;

    if (!ch || ch.purpose !== 'auth' || ch.expires_at_ms < now) {
      throw new ApiError(401, 'invalid_passkey_challenge', 'Passkey challenge expired or invalid');
    }

    const consumed = db
      .prepare(`DELETE FROM passkey_challenges WHERE challenge_id = ?`)
      .run(ch.challenge_id);
    if (Number(consumed.changes) !== 1) {
      throw new ApiError(401, 'invalid_passkey_challenge', 'Passkey challenge already consumed');
    }

    if (
      !constantTimeUtf8Equals(
        stripBase64Padding(clientData.challenge),
        stripBase64Padding(ch.challenge),
      )
    ) {
      throw new ApiError(401, 'invalid_passkey_challenge', 'Passkey challenge mismatch');
    }

    // Step 4: Decode & parse authenticatorData
    let authDataBuf: Buffer;
    try {
      authDataBuf = decodeBase64AnyStrict(authDataRaw);
    } catch {
      throw new ApiError(401, 'invalid_authenticator_data', 'Malformed authenticatorData encoding');
    }
    let parsedAuthData: ReturnType<typeof parseWebAuthnAuthenticatorData>;
    try {
      parsedAuthData = parseWebAuthnAuthenticatorData(authDataBuf);
    } catch (err) {
      throw new ApiError(
        401,
        'invalid_authenticator_data',
        err instanceof Error ? err.message : 'Invalid authenticatorData',
      );
    }

    // Step 5: Verify origin and rpIdHash
    const expectedRpId = ch.rp_id || resolveRequestRpId(ctx.req);
    const reqOriginHeader =
      typeof ctx.req.headers.origin === 'string' ? ctx.req.headers.origin : undefined;
    const originCheck = isAllowedWebAuthnOriginAndRpId(
      clientData.origin,
      reqOriginHeader,
      expectedRpId,
      parsedAuthData.rpIdHash,
    );
    if (!originCheck.ok) {
      throw new ApiError(401, originCheck.code, originCheck.message);
    }

    // Step 6: Verify User Presence (UP) flag
    if (!parsedAuthData.up) {
      throw new ApiError(401, 'user_not_present', 'WebAuthn User Presence (UP) flag is not set');
    }

    // Step 7: Lookup stored credential & public key
    const pk = db
      .prepare(
        `SELECT user_id, public_key_b64, cose_alg, sign_count FROM account_passkeys WHERE cred_id = ?`,
      )
      .get(credentialId) as
      | {
          user_id: number;
          public_key_b64: string | null;
          cose_alg: number | null;
          sign_count: number | null;
        }
      | undefined;

    if (!pk || !pk.public_key_b64) {
      throw new ApiError(
        401,
        'invalid_passkey_credential',
        'Unknown or invalid passkey credential',
      );
    }

    const targetUserId = Number(pk.user_id);
    if (ch.username) {
      const ownerRow = db
        .prepare(`SELECT username FROM users WHERE user_id = ?`)
        .get(targetUserId) as { username: string | null } | undefined;
      if (
        !ownerRow?.username ||
        ownerRow.username.toLowerCase() !== ch.username.trim().toLowerCase()
      ) {
        throw new ApiError(
          401,
          'passkey_user_mismatch',
          'Passkey credential does not match requested username',
        );
      }
    }

    // Step 8: SignCount monotonicity / rollback check (WebAuthn L2 §7.2 step 17)
    const storedCount = Number(pk.sign_count ?? 0);
    if (storedCount > 0 && parsedAuthData.signCount <= storedCount) {
      throw new ApiError(
        401,
        'cloned_authenticator',
        'WebAuthn authenticator signCount did not advance',
      );
    }

    // Step 9: Real cryptographic signature verification over authenticatorData || SHA256(clientDataJSON)
    let parsedKey: ReturnType<typeof parseWebAuthnPublicKey>;
    try {
      parsedKey = parseWebAuthnPublicKey(pk.public_key_b64);
    } catch {
      throw new ApiError(
        401,
        'invalid_passkey_credential',
        'Stored passkey public key is invalid',
      );
    }

    let sigBuf: Buffer;
    try {
      sigBuf = decodeBase64AnyStrict(signatureRaw);
    } catch {
      throw new ApiError(401, 'invalid_passkey_signature', 'Malformed signature encoding');
    }

    if (pk.cose_alg !== null && pk.cose_alg !== undefined && Number(pk.cose_alg) !== parsedKey.alg) {
      throw new ApiError(
        401,
        'invalid_passkey_credential',
        'Stored passkey algorithm does not match credential public key',
      );
    }
    const effectiveAlg = parsedKey.alg;
    const validSig = verifyWebAuthnSignature(
      parsedKey.keyObject,
      effectiveAlg,
      authDataBuf,
      clientDataBytes,
      sigBuf,
    );
    if (!validSig) {
      throw new ApiError(401, 'invalid_passkey_signature', 'Passkey signature verification failed');
    }

    // Step 10: Update sign_count & last_used_ms and issue session
    const nextSignCount = Math.max(storedCount, parsedAuthData.signCount);
    db.prepare(
      `UPDATE account_passkeys SET last_used_ms = ?, sign_count = ? WHERE cred_id = ?`,
    ).run(now, nextSignCount, credentialId);

    const auth = issueSessionForUser(
      db,
      targetUserId,
      deviceName,
      extractClientIp(ctx.req),
    );
    sendJson(ctx.res, 200, auth);
  });

  const handleListPasskeys = (ctx: RequestContext): void => {
    const auth = requireAuth(db, ctx);
    const rows = db
      .prepare(
        `SELECT cred_id, label, cose_alg, sign_count, created_at_ms, last_used_ms
         FROM account_passkeys
         WHERE user_id = ?
         ORDER BY created_at_ms DESC`,
      )
      .all(auth.userId);
    sendJson(ctx.res, 200, { passkeys: rows });
  };
  router.get('/api/v1/auth/passkey/list', handleListPasskeys);
  router.get('/api/v1/account/passkeys', handleListPasskeys);

  const handleDeletePasskey = (ctx: RequestContext): void => {
    const auth = requireAuth(db, ctx);
    db.prepare(`DELETE FROM account_passkeys WHERE cred_id = ? AND user_id = ?`).run(
      ctx.params.credId!,
      auth.userId,
    );
    sendJson(ctx.res, 200, { ok: true });
  };
  router.delete('/api/v1/account/passkeys/:credId', handleDeletePasskey);
  router.delete('/api/v1/auth/passkey/:credId', handleDeletePasskey);

  // 9. Sessions, Me, Logout & Complete Account Deletion
  const handleGetMe = (ctx: RequestContext): void => {
    const auth = requireAuth(db, ctx);
    const user = getUserProfileDto(db, auth.userId);
    if (!user) throw new ApiError(404, 'user_not_found', 'User not found');
    sendJson(ctx.res, 200, user);
  };
  router.get('/api/v1/auth/me', handleGetMe);
  router.get('/api/v1/me', handleGetMe);
  router.get('/api/v1/account/me', handleGetMe);

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
      ip_address: (r.ip_address as string | null) ?? undefined,
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
      .prepare(
        `SELECT session_id FROM auth_sessions WHERE user_id = ? AND session_id != ? AND revoked = 0`,
      )
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
    const result = db
      .prepare(`UPDATE auth_sessions SET revoked = 1 WHERE session_id = ? AND user_id = ?`)
      .run(targetId, auth.userId);
    if (Number(result.changes ?? 0) > 0) {
      hub.disconnectSession(targetId);
    }
    sendJson(ctx.res, 200, { ok: true });
  });

  // Complete DELETE /api/v1/account: close active WS connections + purge user & private data atomically
  router.delete('/api/v1/account', (ctx) => {
    const auth = requireAuth(db, ctx);
    const uid = auth.userId;

    // Immediately terminate all open WebSocket connections for this user
    hub.disconnectUser(uid, 'Account deleted');

    db.exec('BEGIN IMMEDIATE;');
    try {
      const userRecord = db
        .prepare(`SELECT phone, email FROM users WHERE user_id = ?`)
        .get(uid) as { phone: string | null; email: string | null } | undefined;

      // Delete user's Saved Messages chat and its messages if present
      const savedChats = db
        .prepare(`SELECT chat_id FROM chats WHERE kind = 'saved' AND creator_id = ?`)
        .all(uid) as Array<{ chat_id: number }>;
      for (const sc of savedChats) {
        const cid = Number(sc.chat_id);
        db.prepare(`DELETE FROM messages WHERE chat_id = ?`).run(cid);
        db.prepare(`DELETE FROM pts_events WHERE chat_id = ?`).run(cid);
        db.prepare(`DELETE FROM pinned_messages WHERE chat_id = ?`).run(cid);
        db.prepare(`DELETE FROM message_reactions WHERE chat_id = ?`).run(cid);
        db.prepare(`DELETE FROM chat_members WHERE chat_id = ?`).run(cid);
        db.prepare(`DELETE FROM user_chat_settings WHERE chat_id = ?`).run(cid);
        db.prepare(`DELETE FROM chats WHERE chat_id = ?`).run(cid);
      }

      // Purge pending OTP challenges tied to deleted user's phone/email
      if (userRecord?.phone) {
        db.prepare(`DELETE FROM otp_challenges WHERE channel = 'phone' AND target = ?`).run(
          userRecord.phone,
        );
      }
      if (userRecord?.email) {
        db.prepare(
          `DELETE FROM otp_challenges WHERE channel = 'email' AND LOWER(target) = LOWER(?)`,
        ).run(userRecord.email);
      }

      // Purge user-owned bots, their updates, mini apps, and bot user rows
      const ownedBots = db
        .prepare(`SELECT bot_user_id FROM bots_registry WHERE owner_user_id = ?`)
        .all(uid) as Array<{ bot_user_id: number }>;
      for (const b of ownedBots) {
        const botUid = Number(b.bot_user_id);
        db.prepare(`DELETE FROM bot_api_updates WHERE bot_user_id = ?`).run(botUid);
        db.prepare(
          `DELETE FROM mini_app_installs WHERE app_id IN (SELECT app_id FROM mini_apps WHERE bot_user_id = ?)`,
        ).run(botUid);
        db.prepare(`DELETE FROM mini_apps WHERE bot_user_id = ?`).run(botUid);
        db.prepare(`DELETE FROM chat_members WHERE user_id = ?`).run(botUid);
        db.prepare(`DELETE FROM users WHERE user_id = ? AND is_bot = 1`).run(botUid);
      }
      db.prepare(`DELETE FROM bots_registry WHERE owner_user_id = ?`).run(uid);

      // Delete all user-owned private records & secrets across SQLite (Core + M2 + M3 tables)
      db.prepare(`DELETE FROM auth_sessions WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM twofa_challenges WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM twofa_secrets WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM passkey_challenges WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM account_passkeys WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM account_privacy WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM user_vault_envelopes WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM user_vault_items WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM vault_device_sync_requests WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM chat_create_nonces WHERE creator_user_id = ?`).run(uid);
      db.prepare(`DELETE FROM archive_bot_dedup WHERE caller_user_id = ?`).run(uid);
      db.prepare(`DELETE FROM user_provider_vaults WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM user_bot_permissions WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM mcp_oauth_codes WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM mcp_oauth_tokens WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM mcp_tool_audit_log WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM remote_assist_devices WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM remote_sessions WHERE owner_user_id = ? OR controller_user_id = ?`).run(uid, uid);
      db.prepare(`DELETE FROM bot_computer_profiles WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM payment_orders WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM browser_control_generations WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM browser_pairing_tickets WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM browser_desktop_tokens WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM browser_audit_logs WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM user_automation_apps WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM automation_app_runs WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM automation_apps WHERE author_user_id = ?`).run(uid);
      db.prepare(`DELETE FROM user_contacts WHERE owner_user_id = ? OR contact_user_id = ?`).run(uid, uid);
      db.prepare(`DELETE FROM user_blocks WHERE owner_user_id = ? OR blocked_user_id = ?`).run(uid, uid);
      db.prepare(`DELETE FROM user_chat_settings WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM chat_folders WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM chat_members WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM message_user_deletions WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM message_reactions WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM outbox_dedup WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM poll_votes WHERE user_id = ?`).run(uid);
      db.prepare(
        `DELETE FROM story_views WHERE viewer_user_id = ? OR story_id IN (SELECT story_id FROM stories WHERE user_id = ?)`,
      ).run(uid, uid);
      db.prepare(`DELETE FROM stories WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM call_sessions WHERE caller_id = ? OR callee_id = ?`).run(uid, uid);
      db.prepare(`DELETE FROM user_sticker_sets WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM e2ee_prekeys WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM mini_app_installs WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM mini_app_cloud_storage WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM fabushi_state WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM fabushi_profiles WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM fabushi_practice_records WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM fabushi_transfers WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM fabushi_follows WHERE follower_user_id = ? OR target_user_id = ?`).run(uid, uid);
      db.prepare(`DELETE FROM fabushi_online_heartbeats WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM hermes_sessions WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM hermes_turns WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM hermes_kv WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM hermes_skills WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM hermes_approvals WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM hermes_cron_jobs WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM hermes_kanban_boards WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM magpie_providers WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM magpie_state WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM magpie_usage_ledger WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM tasks WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM mcp_servers WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM mcp_approvals WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM talk_sessions WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM computer_commands WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM computer_nodes WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM tailnet_peers WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM wallet_idempotency WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM wallet_transactions WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM wallet_accounts WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM qr_pair_sessions WHERE approved_user_id = ?`).run(uid);
      db.prepare(`DELETE FROM alipay_sessions WHERE approved_user_id = ?`).run(uid);
      db.prepare(
        `DELETE FROM media_upload_parts WHERE upload_id IN (SELECT upload_id FROM media_uploads WHERE user_id = ?)`,
      ).run(uid);
      db.prepare(`DELETE FROM media_uploads WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM passkey_challenges WHERE LOWER(username) = LOWER(?)`).run(auth.username);
      db.prepare(`DELETE FROM botfather_wizards WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM users WHERE user_id = ?`).run(uid);

      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }

    sendJson(ctx.res, 200, { ok: true, deleted: true });
  });

  // 10. Users, Profile, Privacy & Blocked Users
  router.get('/api/v1/users/me', (ctx) => {
    const auth = requireAuth(db, ctx);
    const user = getUserProfileDto(db, auth.userId);
    if (!user) throw new ApiError(404, 'user_not_found', 'User not found');
    sendJson(ctx.res, 200, user);
  });

  const handleUpdateMe = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      first_name?: unknown;
      last_name?: string;
      username?: unknown;
      bio?: string;
      photo_file_id?: string;
      avatar_media_id?: string;
      emoji_status?: string;
    }>(ctx.req);

    if (body.username !== undefined) {
      if (typeof body.username !== 'string') {
        throw new ApiError(
          400,
          'invalid_username',
          'Username must be 5–32 alphanumeric/underscore characters',
        );
      }
      const cleanU = body.username.trim().replace(/^@/, '');
      if (!cleanU || !/^[A-Za-z0-9_]{5,32}$/.test(cleanU)) {
        throw new ApiError(
          400,
          'invalid_username',
          'Username must be 5–32 alphanumeric/underscore characters',
        );
      }
      const dup = db
        .prepare(`SELECT user_id FROM users WHERE LOWER(username) = LOWER(?) AND user_id != ?`)
        .get(cleanU, auth.userId);
      if (dup) {
        throw new ApiError(409, 'username_taken', 'Username is already taken');
      }
      db.prepare(`UPDATE users SET username = ?, updated_at_ms = ? WHERE user_id = ?`).run(
        cleanU,
        Date.now(),
        auth.userId,
      );
    }

    if (body.first_name !== undefined) {
      if (typeof body.first_name !== 'string' || !body.first_name.trim()) {
        throw new ApiError(400, 'invalid_first_name', 'First name cannot be empty');
      }
      db.prepare(`UPDATE users SET first_name = ?, updated_at_ms = ? WHERE user_id = ?`).run(
        body.first_name.trim(),
        Date.now(),
        auth.userId,
      );
    }
    if (body.last_name !== undefined) {
      if (body.last_name !== null && typeof body.last_name !== 'string') {
        throw new ApiError(400, 'invalid_last_name', 'Last name must be a string');
      }
      db.prepare(`UPDATE users SET last_name = ?, updated_at_ms = ? WHERE user_id = ?`).run(
        body.last_name,
        Date.now(),
        auth.userId,
      );
    }
    if (body.bio !== undefined) {
      if (body.bio !== null && typeof body.bio !== 'string') {
        throw new ApiError(400, 'invalid_bio', 'Bio must be a string');
      }
      db.prepare(`UPDATE users SET bio = ?, updated_at_ms = ? WHERE user_id = ?`).run(
        body.bio,
        Date.now(),
        auth.userId,
      );
    }
    const avatarId: unknown = body.photo_file_id ?? body.avatar_media_id;
    if (avatarId !== undefined) {
      if (avatarId !== null && typeof avatarId !== 'string') {
        throw new ApiError(400, 'invalid_avatar', 'Avatar media ID must be a string');
      }
      db.prepare(`UPDATE users SET avatar_media_id = ?, updated_at_ms = ? WHERE user_id = ?`).run(
        avatarId,
        Date.now(),
        auth.userId,
      );
    }
    if (body.emoji_status !== undefined) {
      if (body.emoji_status !== null && typeof body.emoji_status !== 'string') {
        throw new ApiError(400, 'invalid_emoji_status', 'Emoji status must be a string');
      }
      db.prepare(`UPDATE users SET emoji_status = ?, updated_at_ms = ? WHERE user_id = ?`).run(
        body.emoji_status,
        Date.now(),
        auth.userId,
      );
    }

    const updated = getUserProfileDto(db, auth.userId)!;
    sendJson(ctx.res, 200, updated);
  };
  router.patch('/api/v1/users/me', handleUpdateMe);
  router.put('/api/v1/users/me', handleUpdateMe);
  router.put('/api/v1/auth/profile', handleUpdateMe);

  const handleGetPrivacy = (ctx: RequestContext): void => {
    const auth = requireAuth(db, ctx);
    const userRow = db
      .prepare(`SELECT is_premium FROM users WHERE user_id = ?`)
      .get(auth.userId) as { is_premium: number } | undefined;
    const isPremium = Boolean(userRow?.is_premium);
    const row = db
      .prepare(`SELECT settings_json FROM account_privacy WHERE user_id = ?`)
      .get(auth.userId) as { settings_json: string } | undefined;
    const settings: UserPrivacySettingsDto = {
      ...(row
        ? {
            ...DEFAULT_PRIVACY_SETTINGS,
            ...(JSON.parse(row.settings_json) as Partial<UserPrivacySettingsDto>),
          }
        : DEFAULT_PRIVACY_SETTINGS),
      is_premium: isPremium,
    };
    sendJson(ctx.res, 200, settings);
  };
  router.get('/api/v1/account/privacy', handleGetPrivacy);
  router.get('/api/v1/users/me/privacy', handleGetPrivacy);
  router.get('/api/v1/users/me/settings', handleGetPrivacy);

  const handleUpdatePrivacy = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const rawPatch = await readJsonBody<Partial<UserPrivacySettingsDto>>(ctx.req);
    const { is_premium: _ignoredPremium, ...patch } = rawPatch;
    void _ignoredPremium;

    const userRow = db
      .prepare(`SELECT is_premium FROM users WHERE user_id = ?`)
      .get(auth.userId) as { is_premium: number } | undefined;
    const isPremium = Boolean(userRow?.is_premium);

    const row = db
      .prepare(`SELECT settings_json FROM account_privacy WHERE user_id = ?`)
      .get(auth.userId) as { settings_json: string } | undefined;
    const current: UserPrivacySettingsDto = row
      ? {
          ...DEFAULT_PRIVACY_SETTINGS,
          ...(JSON.parse(row.settings_json) as Partial<UserPrivacySettingsDto>),
        }
      : DEFAULT_PRIVACY_SETTINGS;
    const merged: UserPrivacySettingsDto = {
      ...current,
      ...patch,
      is_premium: isPremium,
    };
    db.prepare(`INSERT OR REPLACE INTO account_privacy (user_id, settings_json) VALUES (?, ?)`).run(
      auth.userId,
      JSON.stringify(merged),
    );
    sendJson(ctx.res, 200, merged);
  };
  router.put('/api/v1/account/privacy', handleUpdatePrivacy);
  router.put('/api/v1/users/me/privacy', handleUpdatePrivacy);
  router.put('/api/v1/users/me/settings', handleUpdatePrivacy);
  router.patch('/api/v1/users/me/settings', handleUpdatePrivacy);

  router.get('/api/v1/users/search', (ctx) => {
    requireAuth(db, ctx);
    const q = (ctx.query.get('q') ?? '').trim().toLowerCase();
    const limit = parseBoundedQueryInt(ctx.query.get('limit'), 20, 1, 50);
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
