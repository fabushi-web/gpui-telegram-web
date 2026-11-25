import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_ARGON2_KDF_PARAMS,
  DEVICE_SYNC_TTL_SECS,
  formatDeviceSyncCode,
  isValidArgon2KdfParams,
  isValidVaultCategory,
  isValidVaultItemKey,
  MAX_DEVICE_NAME_LEN,
  MAX_VAULT_CIPHERTEXT_BYTES,
  MAX_VAULT_NONCE_BYTES,
  USER_VAULT_KDF_ALGS,
  USER_VAULT_KDF_ALG_DEVICE_KEYCHAIN_V2,
  type Argon2KdfParamsDto,
  type AuthCustodyUpdateResponse,
  type DeviceSyncActionResponse,
  type DeviceSyncApproveRequest,
  type DeviceSyncRequestDto,
  type DeviceSyncRequestResponse,
  type DeviceSyncStatus,
  type DeviceSyncStatusResponse,
  type KdfParamsResponse,
  type PendingDeviceSyncItem,
  type UpsertUserVaultItemRequest,
  type UpsertUserVaultItemResponse,
  type UserVaultItemDto,
  type UserVaultKeyEnvelopeDto,
  type UserVaultSyncPullResponse,
} from '@gpui-telegram/protocol';
import type { ServerConfig } from '../config.js';
import {
  decodeStandardBase64Strict,
  hashSecretScrypt,
  isContributoryX25519PublicKey,
  verifySecretScrypt,
} from '../utils/crypto.js';
import {
  ApiError,
  readJsonBody,
  requireAuth,
  sendJson,
  type HttpRouter,
  type RequestContext,
} from '../utils/http.js';

const MAX_VAULT_ITEM_BODY_BYTES = 36 * 1024 * 1024; // 36 MiB JSON body -> supports up to 24 MiB decoded ciphertext
const MAX_VERIFIER_UTF8_BYTES = 1024;
const SPLIT_KEY_SALT_BYTES = 16;
const MIN_VERIFIER_BYTES = 32;
const MAX_VERIFIER_BYTES = 128;
const MIN_WRAPPED_KEY_BYTES = 16;
const MAX_WRAPPED_KEY_BYTES = 256;
const MIN_ENVELOPE_SALT_BYTES = 8;
const MAX_ENVELOPE_SALT_BYTES = 64;
const DEVICE_SYNC_NONCE_BYTES = 12;

function resolveKdfFakeSaltSecret(config: ServerConfig): Buffer {
  const envVal = process.env.GPUI_KDF_FAKE_SALT_SECRET?.trim();
  if (envVal) {
    return crypto.createHash('sha256').update(envVal, 'utf8').digest();
  }
  return crypto
    .createHmac('sha256', config.masterSecret)
    .update('gpui-kdf-fake-salt-secret-v1')
    .digest();
}

function decodeB64Bounded(
  raw: unknown,
  field: string,
  minBytes: number,
  maxBytes: number,
): Buffer {
  if (typeof raw !== 'string') {
    throw new ApiError(400, 'invalid_base64', `${field} must be a base64 string`);
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    if (minBytes === 0) return Buffer.alloc(0);
    throw new ApiError(400, 'invalid_payload_size', `${field} cannot be empty`);
  }
  let buf: Buffer;
  try {
    buf = decodeStandardBase64Strict(trimmed);
  } catch {
    throw new ApiError(400, 'invalid_base64', `${field} is not valid standard base64`);
  }
  if (buf.length < minBytes || buf.length > maxBytes) {
    throw new ApiError(
      400,
      'invalid_payload_size',
      `${field} decoded length (${buf.length}) must be within ${minBytes}..=${maxBytes} bytes`,
    );
  }
  return buf;
}

export function validateKdfParams(params: unknown): Argon2KdfParamsDto {
  if (!params || typeof params !== 'object') {
    throw new ApiError(400, 'invalid_kdf_params', 'Argon2id KDF parameters are required');
  }
  const candidate = params as Argon2KdfParamsDto;
  if (!isValidArgon2KdfParams(candidate)) {
    throw new ApiError(
      400,
      'invalid_kdf_params',
      'Argon2id KDF parameters out of allowed safety bounds (m_cost_kib: 1024..1048576, t_cost: 1..64, p_cost: 1..16)',
    );
  }
  return {
    m_cost_kib: candidate.m_cost_kib,
    t_cost: candidate.t_cost,
    p_cost: candidate.p_cost,
  };
}

export function validateSplitKeySaltB64(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new ApiError(400, 'missing_auth_salt', 'auth_salt_b64 is required for Split-Key V2');
  }
  decodeB64Bounded(raw, 'auth_salt_b64', SPLIT_KEY_SALT_BYTES, SPLIT_KEY_SALT_BYTES);
  return raw.trim();
}

export function validateSplitKeyVerifierB64(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new ApiError(
      400,
      'missing_auth_verifier',
      'auth_verifier_b64 is required for Split-Key V2',
    );
  }
  const trimmed = raw.trim();
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_VERIFIER_UTF8_BYTES) {
    throw new ApiError(
      400,
      'invalid_auth_verifier',
      `auth_verifier_b64 exceeds ${MAX_VERIFIER_UTF8_BYTES} bytes`,
    );
  }
  decodeB64Bounded(trimmed, 'auth_verifier_b64', MIN_VERIFIER_BYTES, MAX_VERIFIER_BYTES);
  return trimmed;
}

export function validateX25519PubkeyB64(raw: unknown, field: string): Buffer {
  const bytes = decodeB64Bounded(raw, field, 32, 32);
  if (!bytes.some((b) => b !== 0)) {
    throw new ApiError(400, 'invalid_public_key', `${field} cannot be all zeros`);
  }
  if (!isContributoryX25519PublicKey(bytes)) {
    throw new ApiError(
      400,
      'invalid_public_key',
      `${field} is a non-contributory low-order X25519 public key`,
    );
  }
  return bytes;
}

export function validateVaultEnvelope(raw: unknown): UserVaultKeyEnvelopeDto {
  if (!raw || typeof raw !== 'object') {
    throw new ApiError(400, 'invalid_envelope', 'Vault key envelope payload is required');
  }
  const env = raw as Partial<UserVaultKeyEnvelopeDto>;
  if (
    typeof env.key_version !== 'number' ||
    !Number.isInteger(env.key_version) ||
    env.key_version < 1
  ) {
    throw new ApiError(400, 'invalid_key_version', 'key_version must be an integer >= 1');
  }

  const kdfAlg = typeof env.kdf_alg === 'string' ? env.kdf_alg.trim() : '';
  if (!(USER_VAULT_KDF_ALGS as readonly string[]).includes(kdfAlg)) {
    throw new ApiError(
      400,
      'invalid_kdf_alg',
      `Unsupported kdf_alg "${kdfAlg}"; expected one of ${USER_VAULT_KDF_ALGS.join(', ')}`,
    );
  }

  const kdf = validateKdfParams({
    m_cost_kib: env.kdf_m_cost_kib,
    t_cost: env.kdf_t_cost,
    p_cost: env.kdf_p_cost,
  });

  const saltTrimmed = typeof env.kdf_salt_b64 === 'string' ? env.kdf_salt_b64.trim() : '';
  const wrappedTrimmed =
    typeof env.wrapped_root_key_b64 === 'string' ? env.wrapped_root_key_b64.trim() : '';
  const recoveryTrimmed =
    typeof env.recovery_wrapped_root_key_b64 === 'string'
      ? env.recovery_wrapped_root_key_b64.trim()
      : '';

  if (kdfAlg === USER_VAULT_KDF_ALG_DEVICE_KEYCHAIN_V2) {
    if (saltTrimmed) {
      decodeB64Bounded(saltTrimmed, 'kdf_salt_b64', MIN_ENVELOPE_SALT_BYTES, MAX_ENVELOPE_SALT_BYTES);
    }
    if (wrappedTrimmed) {
      decodeB64Bounded(
        wrappedTrimmed,
        'wrapped_root_key_b64',
        MIN_WRAPPED_KEY_BYTES,
        MAX_WRAPPED_KEY_BYTES,
      );
    }
    if (!recoveryTrimmed) {
      throw new ApiError(
        400,
        'missing_recovery_wrapped_root_key',
        'device_keychain_v2 envelope requires recovery_wrapped_root_key_b64',
      );
    }
    decodeB64Bounded(
      recoveryTrimmed,
      'recovery_wrapped_root_key_b64',
      MIN_WRAPPED_KEY_BYTES,
      MAX_WRAPPED_KEY_BYTES,
    );
  } else {
    decodeB64Bounded(saltTrimmed, 'kdf_salt_b64', MIN_ENVELOPE_SALT_BYTES, MAX_ENVELOPE_SALT_BYTES);
    decodeB64Bounded(
      wrappedTrimmed,
      'wrapped_root_key_b64',
      MIN_WRAPPED_KEY_BYTES,
      MAX_WRAPPED_KEY_BYTES,
    );
    if (recoveryTrimmed) {
      decodeB64Bounded(
        recoveryTrimmed,
        'recovery_wrapped_root_key_b64',
        MIN_WRAPPED_KEY_BYTES,
        MAX_WRAPPED_KEY_BYTES,
      );
    }
  }

  return {
    key_version: env.key_version,
    kdf_alg: kdfAlg,
    kdf_salt_b64: saltTrimmed,
    kdf_m_cost_kib: kdf.m_cost_kib,
    kdf_t_cost: kdf.t_cost,
    kdf_p_cost: kdf.p_cost,
    wrapped_root_key_b64: wrappedTrimmed,
    ...(recoveryTrimmed ? { recovery_wrapped_root_key_b64: recoveryTrimmed } : {}),
  };
}

function upsertVaultEnvelopeRow(
  db: DatabaseSync,
  userId: number,
  env: UserVaultKeyEnvelopeDto,
  nowMs: number,
): UserVaultKeyEnvelopeDto {
  db.prepare(`
    INSERT OR REPLACE INTO user_vault_envelopes (
      user_id, key_version, kdf_alg, kdf_salt_b64,
      kdf_m_cost_kib, kdf_t_cost, kdf_p_cost,
      wrapped_root_key_b64, recovery_wrapped_root_key_b64, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    env.key_version,
    env.kdf_alg,
    env.kdf_salt_b64,
    env.kdf_m_cost_kib,
    env.kdf_t_cost,
    env.kdf_p_cost,
    env.wrapped_root_key_b64,
    env.recovery_wrapped_root_key_b64 ?? null,
    nowMs,
  );
  return {
    ...env,
    updated_at_ms: nowMs,
  };
}

function mapEnvelopeRow(row: Record<string, unknown>): UserVaultKeyEnvelopeDto {
  const dto: UserVaultKeyEnvelopeDto = {
    key_version: Number(row.key_version),
    kdf_alg: String(row.kdf_alg),
    kdf_salt_b64: String(row.kdf_salt_b64),
    kdf_m_cost_kib: Number(row.kdf_m_cost_kib),
    kdf_t_cost: Number(row.kdf_t_cost),
    kdf_p_cost: Number(row.kdf_p_cost),
    wrapped_root_key_b64: String(row.wrapped_root_key_b64),
    updated_at_ms: Number(row.updated_at_ms),
  };
  if (typeof row.recovery_wrapped_root_key_b64 === 'string' && row.recovery_wrapped_root_key_b64) {
    dto.recovery_wrapped_root_key_b64 = row.recovery_wrapped_root_key_b64;
  }
  return dto;
}

export function registerUserVaultRoutes(
  router: HttpRouter,
  db: DatabaseSync,
  config: ServerConfig,
): void {
  const fakeSaltSecret = resolveKdfFakeSaltSecret(config);

  // 1. Public Split-Key KDF Parameter Lookup (Anti-Enumeration Deterministic Fake Salt)
  router.get('/api/v1/auth/kdf-params', (ctx: RequestContext) => {
    const rawIdent = (
      ctx.query.get('username_or_email') ??
      ctx.query.get('username') ??
      ''
    )
      .trim()
      .replace(/^@/, '');
    if (!rawIdent || rawIdent.length > 256) {
      throw new ApiError(400, 'invalid_username', 'Query parameter ?username= or ?username_or_email= is required');
    }

    const row = db
      .prepare(
        `SELECT auth_version, auth_salt_b64, auth_kdf_m_kib, auth_kdf_t_cost, auth_kdf_p_cost
         FROM users
         WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)
         LIMIT 1`,
      )
      .get(rawIdent, rawIdent) as
      | {
          auth_version: number;
          auth_salt_b64: string | null;
          auth_kdf_m_kib: number | null;
          auth_kdf_t_cost: number | null;
          auth_kdf_p_cost: number | null;
        }
      | undefined;

    if (row) {
      if (Number(row.auth_version) === 2 && row.auth_salt_b64) {
        const resp: KdfParamsResponse = {
          auth_version: 2,
          auth_salt_b64: row.auth_salt_b64,
          kdf_params: {
            m_cost_kib: Number(row.auth_kdf_m_kib ?? DEFAULT_ARGON2_KDF_PARAMS.m_cost_kib),
            t_cost: Number(row.auth_kdf_t_cost ?? DEFAULT_ARGON2_KDF_PARAMS.t_cost),
            p_cost: Number(row.auth_kdf_p_cost ?? DEFAULT_ARGON2_KDF_PARAMS.p_cost),
          },
        };
        sendJson(ctx.res, 200, resp);
        return;
      }

      const v1Resp: KdfParamsResponse = {
        auth_version: 1,
        auth_salt_b64: '',
        kdf_params: { ...DEFAULT_ARGON2_KDF_PARAMS },
      };
      sendJson(ctx.res, 200, v1Resp);
      return;
    }

    // Unknown account -> deterministic 16-byte HMAC fake salt with auth_version: 2 (prevents account enumeration)
    const fakeSalt = crypto
      .createHmac('sha256', fakeSaltSecret)
      .update(`kdf-fake-salt:${rawIdent.toLowerCase()}`)
      .digest()
      .subarray(0, SPLIT_KEY_SALT_BYTES)
      .toString('base64');

    const unknownResp: KdfParamsResponse = {
      auth_version: 2,
      auth_salt_b64: fakeSalt,
      kdf_params: { ...DEFAULT_ARGON2_KDF_PARAMS },
    };
    sendJson(ctx.res, 200, unknownResp);
  });

  // 2. Atomic V1 -> Split-Key V2 Account Upgrade
  router.post('/api/v1/auth/upgrade-split-key', async (ctx: RequestContext) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      old_password?: string;
      auth_salt_b64?: string;
      auth_verifier_b64?: string;
      kdf_params?: Argon2KdfParamsDto;
      envelope?: UserVaultKeyEnvelopeDto;
    }>(ctx.req);

    const oldPassword = typeof body.old_password === 'string' ? body.old_password : '';
    if (!oldPassword || Buffer.byteLength(oldPassword, 'utf8') > MAX_VERIFIER_UTF8_BYTES) {
      throw new ApiError(400, 'invalid_credentials', 'Current password is required');
    }

    const saltB64 = validateSplitKeySaltB64(body.auth_salt_b64);
    const verifierB64 = validateSplitKeyVerifierB64(body.auth_verifier_b64);
    const kdfParams = validateKdfParams(body.kdf_params);
    const validatedEnvelope =
      body.envelope !== undefined && body.envelope !== null
        ? validateVaultEnvelope(body.envelope)
        : null;

    const userRow = db
      .prepare(
        `SELECT user_id, auth_version, password_salt, password_hash FROM users WHERE user_id = ?`,
      )
      .get(auth.userId) as
      | {
          user_id: number;
          auth_version: number;
          password_salt: string | null;
          password_hash: string | null;
        }
      | undefined;

    if (!userRow) {
      throw new ApiError(404, 'user_not_found', 'User account not found');
    }
    if (Number(userRow.auth_version) === 2) {
      throw new ApiError(409, 'already_upgraded', 'Account is already upgraded to Split-Key V2');
    }
    if (!userRow.password_salt || !userRow.password_hash) {
      throw new ApiError(400, 'no_password_configured', 'Account has no password configured');
    }
    if (!verifySecretScrypt(oldPassword, userRow.password_salt, userRow.password_hash)) {
      throw new ApiError(401, 'invalid_credentials', 'Current password is incorrect');
    }

    const { saltHex, hashHex } = hashSecretScrypt(verifierB64);
    const now = Date.now();

    db.exec('BEGIN IMMEDIATE;');
    try {
      const upd = db
        .prepare(
          `UPDATE users
           SET password_salt = ?,
               password_hash = ?,
               auth_version = 2,
               auth_salt_b64 = ?,
               auth_kdf_m_kib = ?,
               auth_kdf_t_cost = ?,
               auth_kdf_p_cost = ?,
               updated_at_ms = ?
           WHERE user_id = ? AND auth_version = 1`,
        )
        .run(
          saltHex,
          hashHex,
          saltB64,
          kdfParams.m_cost_kib,
          kdfParams.t_cost,
          kdfParams.p_cost,
          now,
          auth.userId,
        );
      if (Number(upd.changes) !== 1) {
        throw new ApiError(409, 'already_upgraded', 'Account is already upgraded to Split-Key V2');
      }
      if (validatedEnvelope) {
        upsertVaultEnvelopeRow(db, auth.userId, validatedEnvelope, now);
      }
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }

    const resp: AuthCustodyUpdateResponse = { ok: true, auth_version: 2 };
    sendJson(ctx.res, 200, resp);
  });

  // 3. Atomic Split-Key Password / Verifier Rotation
  router.post('/api/v1/auth/change-password', async (ctx: RequestContext) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      old_secret?: string;
      current_auth_verifier_b64?: string;
      current_password?: string;
      auth_version?: number;
      new_auth_salt_b64?: string;
      new_auth_verifier_b64?: string;
      new_kdf_params?: Argon2KdfParamsDto;
      envelope?: UserVaultKeyEnvelopeDto;
    }>(ctx.req);

    if (body.auth_version !== 2) {
      throw new ApiError(
        400,
        'invalid_auth_version',
        'Password rotation requires auth_version = 2 (Split-Key V2)',
      );
    }

    const rawOldSecret =
      body.old_secret ?? body.current_auth_verifier_b64 ?? body.current_password ?? '';
    if (
      typeof rawOldSecret !== 'string' ||
      rawOldSecret.trim().length === 0 ||
      Buffer.byteLength(rawOldSecret, 'utf8') > MAX_VERIFIER_UTF8_BYTES
    ) {
      throw new ApiError(400, 'invalid_credentials', 'Current password or auth verifier is required');
    }

    const newSaltB64 = validateSplitKeySaltB64(body.new_auth_salt_b64);
    const newVerifierB64 = validateSplitKeyVerifierB64(body.new_auth_verifier_b64);
    const newKdfParams = validateKdfParams(body.new_kdf_params);
    const validatedEnvelope =
      body.envelope !== undefined && body.envelope !== null
        ? validateVaultEnvelope(body.envelope)
        : null;

    const userRow = db
      .prepare(
        `SELECT user_id, auth_version, password_salt, password_hash FROM users WHERE user_id = ?`,
      )
      .get(auth.userId) as
      | {
          user_id: number;
          auth_version: number;
          password_salt: string | null;
          password_hash: string | null;
        }
      | undefined;

    if (!userRow) {
      throw new ApiError(404, 'user_not_found', 'User account not found');
    }
    if (!userRow.password_salt || !userRow.password_hash) {
      throw new ApiError(400, 'no_password_configured', 'Account has no password configured');
    }

    const secretToVerify = Number(userRow.auth_version) === 2 ? rawOldSecret.trim() : rawOldSecret;
    if (!verifySecretScrypt(secretToVerify, userRow.password_salt, userRow.password_hash)) {
      throw new ApiError(401, 'invalid_credentials', 'Current credential is incorrect');
    }

    const { saltHex, hashHex } = hashSecretScrypt(newVerifierB64);
    const now = Date.now();

    db.exec('BEGIN IMMEDIATE;');
    try {
      db.prepare(
        `UPDATE users
         SET password_salt = ?,
             password_hash = ?,
             auth_version = 2,
             auth_salt_b64 = ?,
             auth_kdf_m_kib = ?,
             auth_kdf_t_cost = ?,
             auth_kdf_p_cost = ?,
             updated_at_ms = ?
         WHERE user_id = ?`,
      ).run(
        saltHex,
        hashHex,
        newSaltB64,
        newKdfParams.m_cost_kib,
        newKdfParams.t_cost,
        newKdfParams.p_cost,
        now,
        auth.userId,
      );
      if (validatedEnvelope) {
        upsertVaultEnvelopeRow(db, auth.userId, validatedEnvelope, now);
      }
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }

    const resp: AuthCustodyUpdateResponse = { ok: true, auth_version: 2 };
    sendJson(ctx.res, 200, resp);
  });

  // 4. Per-User E2EE Vault Key Envelope (`GET` / `PUT`)
  router.get('/api/v1/user-vault/envelope', (ctx: RequestContext) => {
    const auth = requireAuth(db, ctx);
    const row = db
      .prepare(`SELECT * FROM user_vault_envelopes WHERE user_id = ?`)
      .get(auth.userId) as Record<string, unknown> | undefined;
    sendJson(ctx.res, 200, {
      envelope: row ? mapEnvelopeRow(row) : null,
    });
  });

  router.put('/api/v1/user-vault/envelope', async (ctx: RequestContext) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<UserVaultKeyEnvelopeDto>(ctx.req);
    const validated = validateVaultEnvelope(body);
    const saved = upsertVaultEnvelopeRow(db, auth.userId, validated, Date.now());
    sendJson(ctx.res, 200, { envelope: saved });
  });

  // 5. Revisioned E2EE Vault Items (`GET` delta pull, `PUT` upsert w/ 36 MiB body limit, `DELETE` tombstone)
  router.get('/api/v1/user-vault/items', (ctx: RequestContext) => {
    const auth = requireAuth(db, ctx);
    const rawSince = ctx.query.get('since_revision');
    let sinceRevision = 0;
    if (rawSince !== null && rawSince.trim() !== '') {
      if (!/^\d+$/.test(rawSince.trim())) {
        throw new ApiError(400, 'invalid_since_revision', 'since_revision must be a non-negative integer');
      }
      sinceRevision = Number.parseInt(rawSince.trim(), 10);
      if (!Number.isSafeInteger(sinceRevision) || sinceRevision < 0) {
        throw new ApiError(400, 'invalid_since_revision', 'since_revision must be a non-negative integer');
      }
    }

    const rawCategory = ctx.query.get('category')?.trim() ?? '';
    if (rawCategory && !isValidVaultCategory(rawCategory)) {
      throw new ApiError(400, 'invalid_category', `Invalid vault category "${rawCategory}"`);
    }

    const latestRow = db
      .prepare(`SELECT COALESCE(MAX(revision), 0) AS latest FROM user_vault_items WHERE user_id = ?`)
      .get(auth.userId) as { latest: number };
    const latestRevision = Number(latestRow?.latest ?? 0);

    const rows = (
      rawCategory
        ? db
            .prepare(
              `SELECT category, item_key, revision, nonce_b64, ciphertext_b64, deleted, updated_at_ms
               FROM user_vault_items
               WHERE user_id = ? AND revision > ? AND category = ?
               ORDER BY revision ASC`,
            )
            .all(auth.userId, sinceRevision, rawCategory)
        : db
            .prepare(
              `SELECT category, item_key, revision, nonce_b64, ciphertext_b64, deleted, updated_at_ms
               FROM user_vault_items
               WHERE user_id = ? AND revision > ?
               ORDER BY revision ASC`,
            )
            .all(auth.userId, sinceRevision)
    ) as Array<Record<string, unknown>>;

    const items: UserVaultItemDto[] = rows.map((r) => ({
      category: String(r.category),
      item_key: String(r.item_key),
      revision: Number(r.revision),
      nonce_b64: String(r.nonce_b64),
      ciphertext_b64: String(r.ciphertext_b64),
      deleted: Boolean(r.deleted),
      updated_at_ms: Number(r.updated_at_ms),
    }));

    const resp: UserVaultSyncPullResponse = {
      latest_revision: latestRevision,
      items,
    };
    sendJson(ctx.res, 200, resp);
  });

  router.put('/api/v1/user-vault/items/:category/:itemKey', async (ctx: RequestContext) => {
    const auth = requireAuth(db, ctx);
    const category = ctx.params.category ?? '';
    const itemKey = ctx.params.itemKey ?? '';
    if (!isValidVaultCategory(category)) {
      throw new ApiError(400, 'invalid_category', `Invalid vault category "${category}"`);
    }
    if (!isValidVaultItemKey(itemKey)) {
      throw new ApiError(400, 'invalid_item_key', `Invalid vault item_key "${itemKey}"`);
    }

    const body = await readJsonBody<UpsertUserVaultItemRequest>(ctx.req, MAX_VAULT_ITEM_BODY_BYTES);
    const expectedRev = body.expected_revision;
    if (expectedRev !== undefined && expectedRev !== null) {
      if (typeof expectedRev !== 'number' || !Number.isInteger(expectedRev) || expectedRev < 0) {
        throw new ApiError(
          400,
          'invalid_expected_revision',
          'expected_revision must be a non-negative integer',
        );
      }
    }

    const isDeleted = Boolean(body.deleted);
    let nonceB64 = '';
    let ciphertextB64 = '';

    if (isDeleted) {
      if (typeof body.nonce_b64 === 'string' && body.nonce_b64.trim()) {
        decodeB64Bounded(body.nonce_b64, 'nonce_b64', 0, MAX_VAULT_NONCE_BYTES);
        nonceB64 = body.nonce_b64.trim();
      }
      if (typeof body.ciphertext_b64 === 'string' && body.ciphertext_b64.trim()) {
        decodeB64Bounded(body.ciphertext_b64, 'ciphertext_b64', 0, MAX_VAULT_CIPHERTEXT_BYTES);
        ciphertextB64 = body.ciphertext_b64.trim();
      }
    } else {
      decodeB64Bounded(body.nonce_b64, 'nonce_b64', 1, MAX_VAULT_NONCE_BYTES);
      decodeB64Bounded(body.ciphertext_b64, 'ciphertext_b64', 1, MAX_VAULT_CIPHERTEXT_BYTES);
      nonceB64 = body.nonce_b64.trim();
      ciphertextB64 = body.ciphertext_b64.trim();
    }

    const now = Date.now();
    let nextRevision = 0;

    db.exec('BEGIN IMMEDIATE;');
    try {
      const existing = db
        .prepare(
          `SELECT revision FROM user_vault_items WHERE user_id = ? AND category = ? AND item_key = ?`,
        )
        .get(auth.userId, category, itemKey) as { revision: number } | undefined;
      const currentRevision = existing ? Number(existing.revision) : 0;

      if (expectedRev !== undefined && expectedRev !== null && expectedRev !== currentRevision) {
        throw new ApiError(
          409,
          'revision_conflict',
          `Expected revision ${expectedRev}, but current revision is ${currentRevision}`,
          { current_revision: currentRevision },
        );
      }

      const maxRow = db
        .prepare(`SELECT COALESCE(MAX(revision), 0) AS mx FROM user_vault_items WHERE user_id = ?`)
        .get(auth.userId) as { mx: number };
      nextRevision = Number(maxRow?.mx ?? 0) + 1;

      db.prepare(`
        INSERT OR REPLACE INTO user_vault_items (
          user_id, category, item_key, revision, nonce_b64, ciphertext_b64, deleted, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        auth.userId,
        category,
        itemKey,
        nextRevision,
        nonceB64,
        ciphertextB64,
        isDeleted ? 1 : 0,
        now,
      );
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }

    const resp: UpsertUserVaultItemResponse = {
      ok: true,
      category,
      item_key: itemKey,
      revision: nextRevision,
      updated_at_ms: now,
    };
    sendJson(ctx.res, 200, resp);
  });

  router.delete('/api/v1/user-vault/items/:category/:itemKey', (ctx: RequestContext) => {
    const auth = requireAuth(db, ctx);
    const category = ctx.params.category ?? '';
    const itemKey = ctx.params.itemKey ?? '';
    if (!isValidVaultCategory(category)) {
      throw new ApiError(400, 'invalid_category', `Invalid vault category "${category}"`);
    }
    if (!isValidVaultItemKey(itemKey)) {
      throw new ApiError(400, 'invalid_item_key', `Invalid vault item_key "${itemKey}"`);
    }

    let expectedRev: number | null = null;
    const rawExpected = ctx.query.get('expected_revision');
    if (rawExpected !== null && rawExpected.trim() !== '') {
      if (!/^\d+$/.test(rawExpected.trim())) {
        throw new ApiError(
          400,
          'invalid_expected_revision',
          'expected_revision must be a non-negative integer',
        );
      }
      expectedRev = Number.parseInt(rawExpected.trim(), 10);
      if (!Number.isSafeInteger(expectedRev) || expectedRev < 0) {
        throw new ApiError(
          400,
          'invalid_expected_revision',
          'expected_revision must be a non-negative integer',
        );
      }
    }

    const now = Date.now();
    let nextRevision = 0;

    db.exec('BEGIN IMMEDIATE;');
    try {
      const existing = db
        .prepare(
          `SELECT revision FROM user_vault_items WHERE user_id = ? AND category = ? AND item_key = ?`,
        )
        .get(auth.userId, category, itemKey) as { revision: number } | undefined;
      const currentRevision = existing ? Number(existing.revision) : 0;

      if (expectedRev !== null && expectedRev !== currentRevision) {
        throw new ApiError(
          409,
          'revision_conflict',
          `Expected revision ${expectedRev}, but current revision is ${currentRevision}`,
          { current_revision: currentRevision },
        );
      }

      const maxRow = db
        .prepare(`SELECT COALESCE(MAX(revision), 0) AS mx FROM user_vault_items WHERE user_id = ?`)
        .get(auth.userId) as { mx: number };
      nextRevision = Number(maxRow?.mx ?? 0) + 1;

      db.prepare(`
        INSERT OR REPLACE INTO user_vault_items (
          user_id, category, item_key, revision, nonce_b64, ciphertext_b64, deleted, updated_at_ms
        ) VALUES (?, ?, ?, ?, '', '', 1, ?)
      `).run(auth.userId, category, itemKey, nextRevision, now);
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }

    const resp: UpsertUserVaultItemResponse = {
      ok: true,
      category,
      item_key: itemKey,
      revision: nextRevision,
      updated_at_ms: now,
    };
    sendJson(ctx.res, 200, resp);
  });

  // Catch-all invalid vault item paths (e.g., extra nested segments) -> strict 400
  const rejectInvalidVaultItemPath = (ctx: RequestContext): void => {
    requireAuth(db, ctx);
    throw new ApiError(400, 'invalid_item_key', 'Invalid vault item path');
  };
  router.put('/api/v1/user-vault/items/*', rejectInvalidVaultItemPath);
  router.delete('/api/v1/user-vault/items/*', rejectInvalidVaultItemPath);

  // 6. X25519 Device Trust Ring (Zero-Password Root Key Handoff, Unix-Seconds TTL, Atomic Consume)
  router.post('/api/v1/user-vault/device-sync/request', async (ctx: RequestContext) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<DeviceSyncRequestDto>(ctx.req);

    const deviceName = typeof body.device_name === 'string' ? body.device_name.trim() : '';
    if (!deviceName || Array.from(deviceName).length > MAX_DEVICE_NAME_LEN) {
      throw new ApiError(
        400,
        'invalid_device_name',
        `device_name must be 1..=${MAX_DEVICE_NAME_LEN} characters`,
      );
    }

    const pubBytes = validateX25519PubkeyB64(body.device_public_key_b64, 'device_public_key_b64');
    const pubB64 = body.device_public_key_b64.trim();
    const verificationCode = formatDeviceSyncCode(pubBytes);
    const requestId = `dsr_${crypto.randomUUID().replace(/-/g, '')}`;
    const nowSecs = Math.floor(Date.now() / 1000);
    const expiresAt = nowSecs + DEVICE_SYNC_TTL_SECS;

    db.prepare(`
      INSERT INTO vault_device_sync_requests (
        request_id, user_id, device_name, device_public_key_b64, verification_code,
        status, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(requestId, auth.userId, deviceName, pubB64, verificationCode, nowSecs, expiresAt);

    const resp: DeviceSyncRequestResponse = {
      request_id: requestId,
      verification_code: verificationCode,
      expires_at: expiresAt,
    };
    sendJson(ctx.res, 200, resp);
  });

  router.get('/api/v1/user-vault/device-sync/pending', (ctx: RequestContext) => {
    const auth = requireAuth(db, ctx);
    const nowSecs = Math.floor(Date.now() / 1000);
    const rows = db
      .prepare(
        `SELECT request_id, device_name, device_public_key_b64, verification_code, status, created_at, expires_at
         FROM vault_device_sync_requests
         WHERE user_id = ? AND status = 'pending' AND expires_at > ?
         ORDER BY created_at ASC`,
      )
      .all(auth.userId, nowSecs) as Array<Record<string, unknown>>;

    const items: PendingDeviceSyncItem[] = rows.map((r) => ({
      request_id: String(r.request_id),
      device_name: String(r.device_name),
      device_public_key_b64: String(r.device_public_key_b64),
      verification_code: String(r.verification_code),
      status: String(r.status) as DeviceSyncStatus,
      created_at: Number(r.created_at),
      expires_at: Number(r.expires_at),
    }));
    sendJson(ctx.res, 200, { items });
  });

  router.post('/api/v1/user-vault/device-sync/:requestId/approve', async (ctx: RequestContext) => {
    const auth = requireAuth(db, ctx);
    const requestId = ctx.params.requestId ?? '';
    const body = await readJsonBody<DeviceSyncApproveRequest>(ctx.req);

    // Strictly validate cryptographic payload BEFORE opening DB transaction
    validateX25519PubkeyB64(body.approver_ephemeral_pub_b64, 'approver_ephemeral_pub_b64');
    decodeB64Bounded(body.nonce_b64, 'nonce_b64', DEVICE_SYNC_NONCE_BYTES, DEVICE_SYNC_NONCE_BYTES);
    decodeB64Bounded(
      body.encrypted_root_key_b64,
      'encrypted_root_key_b64',
      MIN_WRAPPED_KEY_BYTES,
      MAX_WRAPPED_KEY_BYTES,
    );

    const approverPubB64 = body.approver_ephemeral_pub_b64.trim();
    const encryptedRootKeyB64 = body.encrypted_root_key_b64.trim();
    const nonceB64 = body.nonce_b64.trim();
    const nowSecs = Math.floor(Date.now() / 1000);

    let expiredErr = false;
    db.exec('BEGIN IMMEDIATE;');
    try {
      const row = db
        .prepare(`SELECT user_id, status, expires_at FROM vault_device_sync_requests WHERE request_id = ?`)
        .get(requestId) as { user_id: number; status: string; expires_at: number } | undefined;

      if (!row) {
        throw new ApiError(404, 'not_found', 'Device sync request not found');
      }
      if (Number(row.user_id) !== auth.userId) {
        throw new ApiError(403, 'forbidden', 'Device sync request belongs to another user');
      }
      if (row.status === 'pending' && Number(row.expires_at) <= nowSecs) {
        db.prepare(
          `UPDATE vault_device_sync_requests
           SET status = 'expired',
               approver_ephemeral_pub_b64 = NULL,
               encrypted_root_key_b64 = NULL,
               nonce_b64 = NULL
           WHERE request_id = ?`,
        ).run(requestId);
        expiredErr = true;
        db.exec('COMMIT;');
      } else if (row.status !== 'pending') {
        throw new ApiError(
          409,
          'invalid_request_status',
          `Cannot approve device sync request in status "${row.status}"`,
        );
      } else {
        const upd = db
          .prepare(
            `UPDATE vault_device_sync_requests
             SET status = 'approved',
                 approver_ephemeral_pub_b64 = ?,
                 encrypted_root_key_b64 = ?,
                 nonce_b64 = ?
             WHERE request_id = ? AND status = 'pending'`,
          )
          .run(approverPubB64, encryptedRootKeyB64, nonceB64, requestId);
        if (Number(upd.changes) !== 1) {
          throw new ApiError(409, 'invalid_request_status', 'Device sync request is no longer pending');
        }
        db.exec('COMMIT;');
      }
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }

    if (expiredErr) {
      throw new ApiError(410, 'request_expired', 'Device sync request has expired');
    }

    const resp: DeviceSyncActionResponse = {
      ok: true,
      request_id: requestId,
      status: 'approved',
    };
    sendJson(ctx.res, 200, resp);
  });

  router.post('/api/v1/user-vault/device-sync/:requestId/deny', (ctx: RequestContext) => {
    const auth = requireAuth(db, ctx);
    const requestId = ctx.params.requestId ?? '';
    const nowSecs = Math.floor(Date.now() / 1000);

    let expiredErr = false;
    db.exec('BEGIN IMMEDIATE;');
    try {
      const row = db
        .prepare(`SELECT user_id, status, expires_at FROM vault_device_sync_requests WHERE request_id = ?`)
        .get(requestId) as { user_id: number; status: string; expires_at: number } | undefined;

      if (!row) {
        throw new ApiError(404, 'not_found', 'Device sync request not found');
      }
      if (Number(row.user_id) !== auth.userId) {
        throw new ApiError(403, 'forbidden', 'Device sync request belongs to another user');
      }
      if (
        (row.status === 'pending' || row.status === 'approved') &&
        Number(row.expires_at) <= nowSecs
      ) {
        db.prepare(
          `UPDATE vault_device_sync_requests
           SET status = 'expired',
               approver_ephemeral_pub_b64 = NULL,
               encrypted_root_key_b64 = NULL,
               nonce_b64 = NULL
           WHERE request_id = ?`,
        ).run(requestId);
        expiredErr = true;
        db.exec('COMMIT;');
      } else if (row.status === 'consumed' || row.status === 'expired') {
        throw new ApiError(
          409,
          'invalid_request_status',
          `Cannot deny device sync request in status "${row.status}"`,
        );
      } else {
        db.prepare(
          `UPDATE vault_device_sync_requests
           SET status = 'denied',
               approver_ephemeral_pub_b64 = NULL,
               encrypted_root_key_b64 = NULL,
               nonce_b64 = NULL
           WHERE request_id = ?`,
        ).run(requestId);
        db.exec('COMMIT;');
      }
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }

    if (expiredErr) {
      throw new ApiError(410, 'request_expired', 'Device sync request has expired');
    }

    const resp: DeviceSyncActionResponse = {
      ok: true,
      request_id: requestId,
      status: 'denied',
    };
    sendJson(ctx.res, 200, resp);
  });

  router.get('/api/v1/user-vault/device-sync/:requestId/status', (ctx: RequestContext) => {
    const auth = requireAuth(db, ctx);
    const requestId = ctx.params.requestId ?? '';
    const nowSecs = Math.floor(Date.now() / 1000);

    let resp: DeviceSyncStatusResponse;

    db.exec('BEGIN IMMEDIATE;');
    try {
      const row = db
        .prepare(
          `SELECT user_id, status, approver_ephemeral_pub_b64, encrypted_root_key_b64, nonce_b64, expires_at
           FROM vault_device_sync_requests
           WHERE request_id = ?`,
        )
        .get(requestId) as
        | {
            user_id: number;
            status: string;
            approver_ephemeral_pub_b64: string | null;
            encrypted_root_key_b64: string | null;
            nonce_b64: string | null;
            expires_at: number;
          }
        | undefined;

      if (!row) {
        throw new ApiError(404, 'not_found', 'Device sync request not found');
      }
      if (Number(row.user_id) !== auth.userId) {
        throw new ApiError(403, 'forbidden', 'Device sync request belongs to another user');
      }

      const expiresAt = Number(row.expires_at);

      if ((row.status === 'pending' || row.status === 'approved') && expiresAt <= nowSecs) {
        db.prepare(
          `UPDATE vault_device_sync_requests
           SET status = 'expired',
               approver_ephemeral_pub_b64 = NULL,
               encrypted_root_key_b64 = NULL,
               nonce_b64 = NULL
           WHERE request_id = ?`,
        ).run(requestId);
        db.exec('COMMIT;');
        resp = { status: 'expired', expires_at: expiresAt };
      } else if (row.status === 'approved') {
        // Atomic one-time consumption: return ciphertext ONLY on the first read, and wipe columns to NULL!
        const consumed = db
          .prepare(
            `UPDATE vault_device_sync_requests
             SET status = 'consumed',
                 approver_ephemeral_pub_b64 = NULL,
                 encrypted_root_key_b64 = NULL,
                 nonce_b64 = NULL
             WHERE request_id = ? AND status = 'approved'`,
          )
          .run(requestId);
        db.exec('COMMIT;');

        if (Number(consumed.changes) === 1) {
          resp = {
            status: 'approved',
            approver_ephemeral_pub_b64: row.approver_ephemeral_pub_b64,
            encrypted_root_key_b64: row.encrypted_root_key_b64,
            nonce_b64: row.nonce_b64,
            expires_at: expiresAt,
          };
        } else {
          resp = { status: 'consumed', expires_at: expiresAt };
        }
      } else {
        db.exec('COMMIT;');
        resp = {
          status: row.status as DeviceSyncStatus,
          expires_at: expiresAt,
        };
      }
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }

    sendJson(ctx.res, 200, resp);
  });
}
