/**
 * Split-Key V2 Zero-Knowledge Auth, Per-User E2EE Vault & X25519 Device Trust Ring Contracts
 * aligned with desktop `bhrumom/gpui-telegram` v1.6.11 (`user_vault.rs` & `e2ee_sync.rs`).
 *
 * Pure ES2023 + DOM isomorphic module (zero `node:*` imports or Node globals).
 */

export const USER_VAULT_CATEGORY_PASSWORD = 'password' as const;
export const USER_VAULT_CATEGORY_BROWSER_COOKIE = 'browser_cookie' as const;
export const USER_VAULT_CATEGORY_AI_OAUTH = 'ai_oauth' as const;
export const USER_VAULT_CATEGORIES = [
  USER_VAULT_CATEGORY_PASSWORD,
  USER_VAULT_CATEGORY_BROWSER_COOKIE,
  USER_VAULT_CATEGORY_AI_OAUTH,
] as const;

export const USER_VAULT_KDF_ALG_ARGON2ID = 'argon2id' as const;
export const USER_VAULT_KDF_ALG_SPLIT_KEY_V2 = 'split_key_v2' as const;
export const USER_VAULT_KDF_ALG_DEVICE_KEYCHAIN_V2 = 'device_keychain_v2' as const;
export const USER_VAULT_KDF_ALGS = [
  USER_VAULT_KDF_ALG_SPLIT_KEY_V2,
  USER_VAULT_KDF_ALG_DEVICE_KEYCHAIN_V2,
  USER_VAULT_KDF_ALG_ARGON2ID,
] as const;

export const DEVICE_SYNC_CODE_DOMAIN_V1 = 'gpui-telegram/device-sync-code/v1';

export const MAX_VAULT_CIPHERTEXT_BYTES = 24 * 1024 * 1024;
export const MAX_VAULT_NONCE_BYTES = 128;
export const MAX_VAULT_ITEM_KEY_LEN = 128;
export const DEVICE_SYNC_TTL_SECS = 600;
export const MAX_DEVICE_NAME_LEN = 128;

export const ARGON2_KDF_BOUNDS = {
  m_cost_kib_min: 1024,
  m_cost_kib_max: 1_048_576,
  t_cost_min: 1,
  t_cost_max: 64,
  p_cost_min: 1,
  p_cost_max: 16,
} as const;

export type AuthVersion = 1 | 2;
export type VaultItemCategory = (typeof USER_VAULT_CATEGORIES)[number];
export type VaultKdfAlg = (typeof USER_VAULT_KDF_ALGS)[number];
export type DeviceSyncStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'consumed';

export interface Argon2KdfParamsDto {
  m_cost_kib: number;
  t_cost: number;
  p_cost: number;
}

export const DEFAULT_ARGON2_KDF_PARAMS: Argon2KdfParamsDto = {
  m_cost_kib: 65_536,
  t_cost: 3,
  p_cost: 1,
};

export interface KdfParamsQuery {
  username_or_email?: string;
  username?: string;
}

export interface KdfParamsResponse {
  auth_version: AuthVersion;
  auth_salt_b64: string;
  kdf_params: Argon2KdfParamsDto;
}

export interface SplitKeyRegisterRequest {
  username: string;
  password?: string;
  first_name?: string;
  last_name?: string;
  device_name?: string;
  auto_welcome?: boolean;
  auth_version?: AuthVersion;
  auth_salt_b64?: string;
  auth_verifier_b64?: string;
  kdf_params?: Argon2KdfParamsDto;
}

export interface SplitKeyEmailRegisterRequest {
  email: string;
  code: string;
  username: string;
  password?: string;
  first_name?: string;
  last_name?: string;
  device_name?: string;
  auth_version?: AuthVersion;
  auth_salt_b64?: string;
  auth_verifier_b64?: string;
  kdf_params?: Argon2KdfParamsDto;
}

export interface SplitKeyLoginRequest {
  username: string;
  password?: string;
  device_name?: string;
  auth_verifier_b64?: string;
}

export interface UpgradeSplitKeyRequest {
  old_password: string;
  auth_salt_b64: string;
  auth_verifier_b64: string;
  kdf_params: Argon2KdfParamsDto;
}

export interface ChangePasswordRequest {
  old_secret: string;
  auth_version: AuthVersion;
  new_auth_salt_b64: string;
  new_auth_verifier_b64: string;
  new_kdf_params: Argon2KdfParamsDto;
}

export interface AuthCustodyUpdateResponse {
  ok: boolean;
  auth_version: AuthVersion;
}

export interface UserVaultKeyEnvelopeDto {
  key_version: number;
  kdf_alg: VaultKdfAlg | string;
  kdf_salt_b64: string;
  kdf_m_cost_kib: number;
  kdf_t_cost: number;
  kdf_p_cost: number;
  wrapped_root_key_b64: string;
  recovery_wrapped_root_key_b64?: string | null;
  updated_at_ms?: number;
}

export interface UserVaultEnvelopeResponse {
  envelope: UserVaultKeyEnvelopeDto | null;
}

export interface UserVaultItemDto {
  category: VaultItemCategory | string;
  item_key: string;
  revision: number;
  nonce_b64: string;
  ciphertext_b64: string;
  deleted?: boolean;
  updated_at_ms?: number;
}

export interface UserVaultSyncPullResponse {
  latest_revision: number;
  items: UserVaultItemDto[];
}

export interface UpsertUserVaultItemRequest {
  expected_revision?: number | null;
  nonce_b64: string;
  ciphertext_b64: string;
  deleted?: boolean;
}

export interface UpsertUserVaultItemResponse {
  ok: boolean;
  category: VaultItemCategory | string;
  item_key: string;
  revision: number;
  updated_at_ms: number;
}

export interface ArchiveLocalBotReplyRequest {
  bot_user_id: number;
  text: string;
  reply_to_msg_id?: number;
  client_nonce?: number;
}

export interface ArchiveLocalBotReplyResponse {
  message_id: number;
  pts: number;
  date_ms: number;
}

/** Rust name: `DeviceSyncRequestBody` */
export interface DeviceSyncRequestDto {
  device_name: string;
  device_public_key_b64: string;
}
export type DeviceSyncRequestBody = DeviceSyncRequestDto;

/** Timestamps (`expires_at`, `created_at`) are Unix epoch SECONDS (`i64`), NOT milliseconds. */
export interface DeviceSyncRequestResponse {
  request_id: string;
  verification_code: string;
  expires_at: number;
}

export interface PendingDeviceSyncItem {
  request_id: string;
  device_name: string;
  device_public_key_b64: string;
  verification_code: string;
  status: DeviceSyncStatus;
  created_at: number;
  expires_at: number;
}

export interface PendingDeviceSyncListResponse {
  items: PendingDeviceSyncItem[];
}

/** Rust name: `ApproveDeviceSyncRequest` */
export interface DeviceSyncApproveRequest {
  approver_ephemeral_pub_b64: string;
  encrypted_root_key_b64: string;
  nonce_b64: string;
}
export type ApproveDeviceSyncRequest = DeviceSyncApproveRequest;

export interface DeviceSyncActionResponse {
  ok: boolean;
  request_id: string;
  status: DeviceSyncStatus;
}

export interface DeviceSyncStatusResponse {
  status: DeviceSyncStatus;
  approver_ephemeral_pub_b64?: string | null;
  encrypted_root_key_b64?: string | null;
  nonce_b64?: string | null;
  expires_at: number;
}

// ============================================================================
// Pure-TS FIPS 180-4 SHA-256 & Validation Helpers (Browser + Node Isomorphic)
// ============================================================================

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr32(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

function sha256Bytes(input: Uint8Array): Uint8Array {
  const bitLen = input.length * 8;
  const paddedLen = (((input.length + 9 + 63) >> 6) << 6);
  const padded = new Uint8Array(paddedLen);
  padded.set(input);
  padded[input.length] = 0x80;

  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  const hiBits = Math.floor(bitLen / 0x100000000);
  const loBits = bitLen >>> 0;
  view.setUint32(paddedLen - 8, hiBits, false);
  view.setUint32(paddedLen - 4, loBits, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15]!;
      const w2 = w[i - 2]!;
      const s0 = (rotr32(w15, 7) ^ rotr32(w15, 18) ^ (w15 >>> 3)) >>> 0;
      const s1 = (rotr32(w2, 17) ^ rotr32(w2, 19) ^ (w2 >>> 10)) >>> 0;
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const s1 = (rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + s1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const s0 = (rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const digest = new Uint8Array(32);
  const outView = new DataView(digest.buffer);
  outView.setUint32(0, h0, false);
  outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false);
  outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false);
  outView.setUint32(20, h5, false);
  outView.setUint32(24, h6, false);
  outView.setUint32(28, h7, false);
  return digest;
}

const BASE64_DECODE_TABLE = (() => {
  const table = new Int16Array(128).fill(-1);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < alphabet.length; i++) {
    table[alphabet.charCodeAt(i)] = i;
  }
  return table;
})();

function decodeBase64Strict(raw: string): Uint8Array {
  const cleaned = raw.trim().replace(/-/g, '+').replace(/_/g, '/');
  if (cleaned.length === 0 || cleaned.length % 4 === 1) {
    throw new Error('Invalid base64 encoding for device public key');
  }
  if (cleaned.includes('=') && cleaned.length % 4 !== 0) {
    throw new Error('Invalid base64 padding for device public key');
  }
  const padded =
    cleaned.length % 4 === 0 ? cleaned : cleaned + '='.repeat(4 - (cleaned.length % 4));
  let padLen = 0;
  if (padded.endsWith('==')) {
    padLen = 2;
  } else if (padded.endsWith('=')) {
    padLen = 1;
  }
  const outLen = (padded.length / 4) * 3 - padLen;
  const out = new Uint8Array(outLen);
  let outIdx = 0;

  for (let i = 0; i < padded.length; i += 4) {
    const c0 = padded.charCodeAt(i);
    const c1 = padded.charCodeAt(i + 1);
    const c2 = padded.charCodeAt(i + 2);
    const c3 = padded.charCodeAt(i + 3);
    const v0 = c0 < 128 ? BASE64_DECODE_TABLE[c0]! : -1;
    const v1 = c1 < 128 ? BASE64_DECODE_TABLE[c1]! : -1;
    const isPad2 = c2 === 61 && i + 4 === padded.length && padLen === 2;
    const isPad3 = c3 === 61 && i + 4 === padded.length && padLen >= 1;
    const v2 = isPad2 ? 0 : c2 < 128 ? BASE64_DECODE_TABLE[c2]! : -1;
    const v3 = isPad3 ? 0 : c3 < 128 ? BASE64_DECODE_TABLE[c3]! : -1;

    if (v0 < 0 || v1 < 0 || v2 < 0 || v3 < 0) {
      throw new Error('Invalid base64 character in device public key');
    }
    if ((isPad2 && (v1 & 0x0f) !== 0) || (isPad3 && !isPad2 && (v2 & 0x03) !== 0)) {
      throw new Error('Invalid non-canonical base64 padding bits in device public key');
    }

    const triple = (v0 << 18) | (v1 << 12) | (v2 << 6) | v3;
    if (outIdx < outLen) out[outIdx++] = (triple >>> 16) & 0xff;
    if (outIdx < outLen) out[outIdx++] = (triple >>> 8) & 0xff;
    if (outIdx < outLen) out[outIdx++] = triple & 0xff;
  }
  return out;
}

const DOMAIN_BYTES_V1 = new TextEncoder().encode(DEVICE_SYNC_CODE_DOMAIN_V1);

/**
 * Formats a 6-digit `NNN-NNN` verification code from a precomputed SHA-256 digest
 * (`u32_be(digest[0..4]) % 1_000_000`).
 */
export function formatDeviceSyncCodeFromDigest(digest: Uint8Array): string {
  if (digest.length < 4) {
    throw new Error('Digest must contain at least 4 bytes');
  }
  const raw =
    (((digest[0]! << 24) | (digest[1]! << 16) | (digest[2]! << 8) | digest[3]!) >>> 0) %
    1_000_000;
  const hi = String(Math.floor(raw / 1000)).padStart(3, '0');
  const lo = String(raw % 1000).padStart(3, '0');
  return `${hi}-${lo}`;
}

/**
 * Computes the deterministic 6-digit `NNN-NNN` X25519 Device Trust Ring verification code
 * matching upstream Rust `compute_device_sync_verification_code`:
 * `SHA-256("gpui-telegram/device-sync-code/v1" || pubkey_bytes)` → `u32_be(digest[0..4]) % 1_000_000`.
 */
export function formatDeviceSyncCode(pubkey: Uint8Array | string): string {
  const pubkeyBytes = typeof pubkey === 'string' ? decodeBase64Strict(pubkey) : pubkey;
  const payload = new Uint8Array(DOMAIN_BYTES_V1.length + pubkeyBytes.length);
  payload.set(DOMAIN_BYTES_V1, 0);
  payload.set(pubkeyBytes, DOMAIN_BYTES_V1.length);
  const digest = sha256Bytes(payload);
  return formatDeviceSyncCodeFromDigest(digest);
}

/**
 * Validates that a decoded X25519 public key is exactly 32 non-all-zero bytes.
 */
export function isValidX25519PubkeyBytes(bytes: Uint8Array): boolean {
  return bytes.length === 32 && bytes.some((b) => b !== 0);
}

/**
 * Type guard checking whether a vault category matches one of the 3 canonical upstream categories.
 */
export function isValidVaultCategory(value: string): value is VaultItemCategory {
  return (
    value === USER_VAULT_CATEGORY_PASSWORD ||
    value === USER_VAULT_CATEGORY_BROWSER_COOKIE ||
    value === USER_VAULT_CATEGORY_AI_OAUTH
  );
}

/**
 * Validates a vault item key matching upstream `routes/user_vault.rs`:
 * - length `1..=128`
 * - must NOT contain `'..'`
 * - strictly ASCII `[A-Za-z0-9._:-]`
 */
export function isValidVaultItemKey(key: string): boolean {
  if (key.length < 1 || key.length > MAX_VAULT_ITEM_KEY_LEN) {
    return false;
  }
  if (key.includes('..')) {
    return false;
  }
  return /^[A-Za-z0-9._:-]+$/.test(key);
}

/**
 * Validates Argon2id KDF parameters against upstream safety bounds.
 */
export function isValidArgon2KdfParams(params: Argon2KdfParamsDto): boolean {
  if (!params || typeof params !== 'object') {
    return false;
  }
  return (
    Number.isInteger(params.m_cost_kib) &&
    params.m_cost_kib >= ARGON2_KDF_BOUNDS.m_cost_kib_min &&
    params.m_cost_kib <= ARGON2_KDF_BOUNDS.m_cost_kib_max &&
    Number.isInteger(params.t_cost) &&
    params.t_cost >= ARGON2_KDF_BOUNDS.t_cost_min &&
    params.t_cost <= ARGON2_KDF_BOUNDS.t_cost_max &&
    Number.isInteger(params.p_cost) &&
    params.p_cost >= ARGON2_KDF_BOUNDS.p_cost_min &&
    params.p_cost <= ARGON2_KDF_BOUNDS.p_cost_max
  );
}
