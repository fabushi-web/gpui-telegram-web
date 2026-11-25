import crypto from 'node:crypto';
import type { MagpieMaskingConfig, MagpieMaskingPreviewResult } from '@gpui-telegram/protocol';
import { renderQrCodeSvg } from '@gpui-telegram/protocol';

const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS: crypto.ScryptOptions = { N: 16384, r: 8, p: 1 };

const RUNTIME_MASK_SALT = crypto.randomBytes(32);

/**
 * Salted `node:crypto.scryptSync` password / 2FA cloud password hashing.
 */
export function hashSecretScrypt(secret: string): { saltHex: string; hashHex: string } {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(secret, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return {
    saltHex: salt.toString('hex'),
    hashHex: derived.toString('hex'),
  };
}

/**
 * Constant-time verification of a `scrypt` hashed password / 2FA secret.
 */
export function verifySecretScrypt(
  candidate: string,
  saltHex: string,
  expectedHashHex: string,
): boolean {
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(expectedHashHex, 'hex');
    if (salt.length === 0 || expected.length !== SCRYPT_KEYLEN) {
      return false;
    }
    const actual = crypto.scryptSync(candidate, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function sha256Hex(data: Buffer | Uint8Array | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function generateSessionToken(): {
  sessionId: string;
  rawToken: string;
  tokenHash: string;
} {
  const sessionId = `sess_${crypto.randomBytes(8).toString('hex')}`;
  const secret = crypto.randomBytes(24).toString('hex');
  const rawToken = `${sessionId}.${secret}`;
  const tokenHash = sha256Hex(rawToken);
  return { sessionId, rawToken, tokenHash };
}

export function constantTimeHexEquals(hexA: string, hexB: string): boolean {
  try {
    const a = Buffer.from(hexA, 'hex');
    const b = Buffer.from(hexB, 'hex');
    if (a.length === 0 || a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Encrypts sensitive credentials at rest (cloud SSH secrets, upstream LLM API keys)
 * using `HKDF-SHA256` + `AES-256-GCM`.
 */
export function encryptSecretAtRest(
  masterSecret: Buffer,
  contextInfo: string,
  plaintext: string,
): { ciphertextB64: string; nonceB64: string } {
  const keyBuf = Buffer.from(
    crypto.hkdfSync('sha256', masterSecret, Buffer.alloc(16), Buffer.from(contextInfo, 'utf8'), 32),
  );
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertextB64: Buffer.concat([encrypted, tag]).toString('base64'),
    nonceB64: nonce.toString('base64'),
  };
}

export function decryptSecretAtRest(
  masterSecret: Buffer,
  contextInfo: string,
  ciphertextB64: string,
  nonceB64: string,
): string {
  const keyBuf = Buffer.from(
    crypto.hkdfSync('sha256', masterSecret, Buffer.alloc(16), Buffer.from(contextInfo, 'utf8'), 32),
  );
  const nonce = Buffer.from(nonceB64, 'base64');
  const combined = Buffer.from(ciphertextB64, 'base64');
  if (combined.length < 16) {
    throw new Error('Encrypted secret truncated');
  }
  const body = combined.subarray(0, combined.length - 16);
  const tag = combined.subarray(combined.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

export function maskApiKey(rawKey: string | null | undefined): string | null {
  if (!rawKey) return null;
  const trimmed = rawKey.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 8) return `${trimmed.slice(0, 2)}***`;
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

export function redactHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (
      lower.includes('authorization') ||
      lower.includes('api-key') ||
      lower.includes('token') ||
      lower.includes('secret')
    ) {
      out[k] = v.toLowerCase().startsWith('bearer ') ? 'Bearer ***' : '***';
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ============================================================================
// Telegram Mini App `WebAppData` HMAC-SHA256 Signing & Validation
// ============================================================================

export function signMiniAppInitData(
  botToken: string,
  fields: Record<string, string>,
): { initData: string; hash: string } {
  const entries = Object.entries(fields).filter(([k]) => k !== 'hash');
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const params = new URLSearchParams();
  for (const [k, v] of entries) {
    params.set(k, v);
  }
  params.set('hash', hash);

  return {
    initData: params.toString(),
    hash,
  };
}

export function verifyMiniAppInitData(
  botToken: string,
  initDataRaw: string,
): { valid: boolean; params: Record<string, string>; user?: Record<string, unknown> } {
  try {
    const searchParams = new URLSearchParams(initDataRaw);
    const providedHash = searchParams.get('hash');
    if (!providedHash) {
      return { valid: false, params: {} };
    }

    const pairs: Array<[string, string]> = [];
    const paramsObj: Record<string, string> = {};
    for (const [k, v] of searchParams.entries()) {
      paramsObj[k] = v;
      if (k !== 'hash') {
        pairs.push([k, v]);
      }
    }

    pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (!constantTimeHexEquals(providedHash, expectedHash)) {
      return { valid: false, params: paramsObj };
    }

    let user: Record<string, unknown> | undefined;
    if (paramsObj.user) {
      try {
        user = JSON.parse(paramsObj.user) as Record<string, unknown>;
      } catch {
        // Ignore non-JSON user field
      }
    }

    return { valid: true, params: paramsObj, user };
  } catch {
    return { valid: false, params: {} };
  }
}

// ============================================================================
// Standards-Compliant ISO/IEC 18004 QR Code SVG Generator (EcLevel Q)
// ============================================================================

export function generateQrCodeSvg(payload: string, sizePx = 220): string {
  return renderQrCodeSvg(payload, { sizePx, ecLevel: 'Q', quietZone: 4 });
}

// ============================================================================
// 5-Field POSIX Cron & `@every` Next-Run Evaluator
// ============================================================================

function parseCronField(field: string, min: number, max: number): Set<number> {
  const allowed = new Set<number>();
  const parts = field.trim().split(',');

  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) continue;

    const [rangePart, stepPart] = part.split('/');
    const step = stepPart ? Number.parseInt(stepPart, 10) : 1;
    if (!Number.isFinite(step) || step <= 0) {
      throw new Error(`Invalid cron step in "${field}"`);
    }

    let start = min;
    let end = max;
    if (rangePart !== '*') {
      if (rangePart?.includes('-')) {
        const [sRaw, eRaw] = rangePart.split('-');
        start = Number.parseInt(sRaw ?? '', 10);
        end = Number.parseInt(eRaw ?? '', 10);
      } else {
        const single = Number.parseInt(rangePart ?? '', 10);
        start = single;
        end = stepPart ? max : single;
      }
    }

    // Normalize Sunday = 7 -> 0 for day-of-week
    if (max === 6 && start === 7) start = 0;
    if (max === 6 && end === 7) end = 0;

    if (!Number.isFinite(start) || !Number.isFinite(end) || start < min || end > max || start > end) {
      throw new Error(`Invalid cron range "${part}" (bounds ${min}..${max})`);
    }

    for (let v = start; v <= end; v += step) {
      allowed.add(v);
    }
  }

  if (allowed.size === 0) {
    throw new Error(`Empty cron field "${field}"`);
  }
  return allowed;
}

/**
 * Computes the next scheduled execution timestamp in milliseconds after `fromMs`.
 * Supports:
 * - `@every 30s`, `every 5m`, `@every 2h`, `@hourly`, `@daily`, `@weekly`
 * - Standard 5-field cron: `minute hour dayOfMonth month dayOfWeek`
 */
export function computeNextCronRunMs(scheduleExpr: string, fromMs = Date.now()): number {
  const expr = scheduleExpr.trim();
  const everyMatch = /^(?:@?every\s+)(\d+)\s*(ms|s|m|h|d)$/i.exec(expr);
  if (everyMatch) {
    const qty = Number.parseInt(everyMatch[1]!, 10);
    const unit = everyMatch[2]!.toLowerCase();
    const mult =
      unit === 'ms'
        ? 1
        : unit === 's'
          ? 1000
          : unit === 'm'
            ? 60_000
            : unit === 'h'
              ? 3_600_000
              : 86_400_000;
    if (qty <= 0) throw new Error('Interval must be positive');
    return fromMs + qty * mult;
  }

  const normalized =
    expr === '@hourly'
      ? '0 * * * *'
      : expr === '@daily' || expr === '@midnight'
        ? '0 0 * * *'
        : expr === '@weekly'
          ? '0 0 * * 0'
          : expr;

  const fields = normalized.split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Expected 5-field cron expression, received "${scheduleExpr}"`);
  }

  const minutes = parseCronField(fields[0]!, 0, 59);
  const hours = parseCronField(fields[1]!, 0, 23);
  const doms = parseCronField(fields[2]!, 1, 31);
  const months = parseCronField(fields[3]!, 1, 12);
  const dows = parseCronField(fields[4]!, 0, 6);

  // Start searching from the next whole UTC minute
  const candidate = new Date(Math.floor(fromMs / 60_000) * 60_000 + 60_000);
  const maxIterations = 525_960; // 1 year in minutes

  for (let i = 0; i < maxIterations; i++) {
    const m = candidate.getUTCMonth() + 1;
    if (!months.has(m)) {
      candidate.setUTCMonth(candidate.getUTCMonth() + 1, 1);
      candidate.setUTCHours(0, 0, 0, 0);
      continue;
    }

    const dom = candidate.getUTCDate();
    const dow = candidate.getUTCDay();
    if (!doms.has(dom) || !dows.has(dow)) {
      candidate.setUTCDate(candidate.getUTCDate() + 1);
      candidate.setUTCHours(0, 0, 0, 0);
      continue;
    }

    const h = candidate.getUTCHours();
    if (!hours.has(h)) {
      candidate.setUTCHours(h + 1, 0, 0, 0);
      continue;
    }

    const min = candidate.getUTCMinutes();
    if (!minutes.has(min)) {
      candidate.setUTCMinutes(min + 1, 0, 0);
      continue;
    }

    return candidate.getTime();
  }

  throw new Error(`No matching execution time within 366 days for "${scheduleExpr}"`);
}

// ============================================================================
// Magpie Privacy & Secret Masking Engine
// ============================================================================

function passesLuhnCheck(digitsOnly: string): boolean {
  if (digitsOnly.length < 13 || digitsOnly.length > 19) return false;
  let sum = 0;
  let shouldDouble = false;
  for (let i = digitsOnly.length - 1; i >= 0; i--) {
    let digit = digitsOnly.charCodeAt(i) - 48;
    if (digit < 0 || digit > 9) return false;
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

function makeMaskTag(kind: string, rawValue: string): string {
  const shortTag = crypto
    .createHmac('sha256', RUNTIME_MASK_SALT)
    .update(`${kind}:${rawValue}`)
    .digest('hex')
    .slice(0, 8);
  const label = kind.toUpperCase();
  return `[REDACTED_${label}_${shortTag}]`;
}

export function runPrivacyMasking(
  inputText: string,
  config: MagpieMaskingConfig,
): MagpieMaskingPreviewResult & { reverseMap: Map<string, string> } {
  const reverseMap = new Map<string, string>();
  if (!config.enabled || !inputText) {
    return {
      masked_text: inputText,
      hits: [],
      hit_count: 0,
      blocked: false,
      reverseMap,
    };
  }

  const allowSet = new Set(config.allow_list.map((w) => w.trim().toLowerCase()).filter(Boolean));
  const hits: MagpieMaskingPreviewResult['hits'] = [];
  let working = inputText;

  const applyPattern = (
    kind: MagpieMaskingPreviewResult['hits'][number]['kind'],
    regex: RegExp,
    validator?: (match: string) => boolean,
  ): void => {
    working = working.replace(regex, (matched) => {
      if (allowSet.has(matched.trim().toLowerCase())) {
        return matched;
      }
      if (validator && !validator(matched)) {
        return matched;
      }
      const placeholder = makeMaskTag(kind, matched);
      reverseMap.set(placeholder, matched);
      const action = config.default_action ?? 'mask';
      hits.push({
        kind,
        placeholder,
        action,
        preview_hint:
          matched.length > 8 ? `${matched.slice(0, 3)}***${matched.slice(-2)}` : '***',
      });
      return action === 'warn' ? matched : placeholder;
    });
  };

  if (config.mask_secrets) {
    applyPattern(
      'private_key',
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    );
    applyPattern(
      'jwt',
      /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    );
    applyPattern(
      'api_key',
      /\b(?:sk-[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g,
    );
  }

  if (config.mask_personal) {
    applyPattern(
      'email',
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    );
    applyPattern(
      'card',
      /\b(?:\d[ -]*?){13,19}\b/g,
      (m) => passesLuhnCheck(m.replace(/\D/g, '')),
    );
    applyPattern(
      'phone',
      /(?<!\d)(?:\+\d{1,3}[\s-]?)?(?:1[3-9]\d{9}|\(\d{3}\)[\s-]?\d{3}[\s-]?\d{4}|\d{3}[\s-]\d{3}[\s-]\d{4})(?!\d)/g,
    );
  }

  for (const word of config.custom_words) {
    const trimmed = word.trim();
    if (!trimmed) continue;
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    applyPattern('custom', new RegExp(escaped, 'gi'));
  }

  const blocked = config.default_action === 'block' && hits.length > 0;
  return {
    masked_text: working,
    hits,
    hit_count: hits.length,
    blocked,
    block_reason: blocked ? `Blocked due to ${hits.length} sensitive item(s) detected` : undefined,
    reverseMap,
  };
}

export function unmaskPlaceholders(text: string, reverseMap: Map<string, string>): string {
  if (!text || reverseMap.size === 0) return text;
  let out = text;
  for (const [placeholder, original] of reverseMap.entries()) {
    out = out.split(placeholder).join(original);
  }
  return out;
}

// ============================================================================
// Constant-Time UTF-8 Equality, Strict Base64 & X25519 Validation
// ============================================================================

export function constantTimeUtf8Equals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still execute timingSafeEqual on equal-sized digests to avoid short-circuit timing signal
    const ha = crypto.createHash('sha256').update(bufA).digest();
    const hb = crypto.createHash('sha256').update(bufB).digest();
    crypto.timingSafeEqual(ha, hb);
    return false;
  }
  if (bufA.length === 0) return true;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Strict canonical RFC 4648 standard Base64 decoder (rejects stripped chars and non-canonical padding bits).
 */
export function decodeStandardBase64Strict(raw: string): Buffer {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return Buffer.alloc(0);
  }
  if (trimmed.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(trimmed)) {
    throw new Error('Invalid standard base64 encoding');
  }
  const decoded = Buffer.from(trimmed, 'base64');
  if (decoded.toString('base64') !== trimmed) {
    throw new Error('Non-canonical standard base64 encoding');
  }
  return decoded;
}

/**
 * Strict decoder accepting either RFC 4648 base64url (with or without padding) or standard base64.
 */
export function decodeBase64AnyStrict(raw: string): Buffer {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return Buffer.alloc(0);
  }
  if (trimmed.length % 4 === 1) {
    throw new Error('Invalid base64 length');
  }
  // Reject mixed standard + url-safe characters
  const hasStdOnly = trimmed.includes('+') || trimmed.includes('/');
  const hasUrlOnly = trimmed.includes('-') || trimmed.includes('_');
  if (hasStdOnly && hasUrlOnly) {
    throw new Error('Mixed standard and base64url alphabet');
  }
  if (trimmed.includes('=') && trimmed.length % 4 !== 0) {
    throw new Error('Invalid base64 padding');
  }
  const normalized = trimmed.replace(/-/g, '+').replace(/_/g, '/');
  const padded =
    normalized.length % 4 === 0
      ? normalized
      : normalized + '='.repeat(4 - (normalized.length % 4));
  return decodeStandardBase64Strict(padded);
}

// RFC 7748 Section 6.1 canonical low-order Curve25519 points (with MSB of byte 31 cleared)
const X25519_LOW_ORDER_HEX = new Set([
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800',
  '5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
]);

const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
let cachedX25519ProbeKey: crypto.KeyObject | null = null;

function getX25519ProbePrivateKey(): crypto.KeyObject {
  if (!cachedX25519ProbeKey) {
    cachedX25519ProbeKey = crypto.generateKeyPairSync('x25519').privateKey;
  }
  return cachedX25519ProbeKey;
}

/**
 * Validates that a 32-byte X25519 public key is non-zero and contributory
 * (rejects all RFC 7748 low-order points both statically and via OpenSSL ECDH).
 */
export function isContributoryX25519PublicKey(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  if (!bytes.some((b) => b !== 0)) return false;

  const masked = Buffer.from(bytes);
  masked[31] = masked[31]! & 0x7f;
  if (X25519_LOW_ORDER_HEX.has(masked.toString('hex'))) {
    return false;
  }

  try {
    const spki = Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(bytes)]);
    const publicKey = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
    const shared = crypto.diffieHellman({
      privateKey: getX25519ProbePrivateKey(),
      publicKey,
    });
    return shared.length === 32 && shared.some((b) => b !== 0);
  } catch {
    return false;
  }
}

// ============================================================================
// Minimal Bounded RFC 8949 CBOR Decoder & WebAuthn COSE / SPKI Verification
// ============================================================================

const CBOR_MAX_DEPTH = 16;
const CBOR_MAX_COLLECTION_LEN = 4096;
const CBOR_MAX_BYTES_LEN = 1_048_576;

function readCborUint(buf: Buffer, offset: number, ai: number): { val: number; nextOffset: number } {
  if (ai < 24) {
    return { val: ai, nextOffset: offset };
  }
  if (ai === 24) {
    if (offset + 1 > buf.length) throw new Error('CBOR truncated 1-byte uint');
    return { val: buf[offset]!, nextOffset: offset + 1 };
  }
  if (ai === 25) {
    if (offset + 2 > buf.length) throw new Error('CBOR truncated 2-byte uint');
    return { val: buf.readUInt16BE(offset), nextOffset: offset + 2 };
  }
  if (ai === 26) {
    if (offset + 4 > buf.length) throw new Error('CBOR truncated 4-byte uint');
    return { val: buf.readUInt32BE(offset), nextOffset: offset + 4 };
  }
  if (ai === 27) {
    if (offset + 8 > buf.length) throw new Error('CBOR truncated 8-byte uint');
    const big = buf.readBigUInt64BE(offset);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('CBOR 8-byte uint exceeds safe integer range');
    }
    return { val: Number(big), nextOffset: offset + 8 };
  }
  throw new Error(`Unsupported CBOR additional info ${ai}`);
}

export function decodeCborItem(
  buf: Buffer,
  startOffset = 0,
  depth = 0,
): { value: unknown; nextOffset: number } {
  if (depth > CBOR_MAX_DEPTH) {
    throw new Error('CBOR nesting depth exceeded');
  }
  if (startOffset < 0 || startOffset >= buf.length) {
    throw new Error('CBOR unexpected end of buffer');
  }

  const initial = buf[startOffset]!;
  const major = initial >>> 5;
  const ai = initial & 0x1f;
  const afterHeader = startOffset + 1;

  if (ai === 31) {
    throw new Error('CBOR indefinite-length items are not supported');
  }

  switch (major) {
    case 0: {
      const { val, nextOffset } = readCborUint(buf, afterHeader, ai);
      return { value: val, nextOffset };
    }
    case 1: {
      const { val, nextOffset } = readCborUint(buf, afterHeader, ai);
      return { value: -1 - val, nextOffset };
    }
    case 2: {
      const { val: len, nextOffset: dataStart } = readCborUint(buf, afterHeader, ai);
      if (len > CBOR_MAX_BYTES_LEN || dataStart + len > buf.length) {
        throw new Error('CBOR byte string out of bounds');
      }
      return {
        value: Buffer.from(buf.subarray(dataStart, dataStart + len)),
        nextOffset: dataStart + len,
      };
    }
    case 3: {
      const { val: len, nextOffset: dataStart } = readCborUint(buf, afterHeader, ai);
      if (len > CBOR_MAX_BYTES_LEN || dataStart + len > buf.length) {
        throw new Error('CBOR text string out of bounds');
      }
      return {
        value: buf.subarray(dataStart, dataStart + len).toString('utf8'),
        nextOffset: dataStart + len,
      };
    }
    case 4: {
      const { val: count, nextOffset } = readCborUint(buf, afterHeader, ai);
      if (count > CBOR_MAX_COLLECTION_LEN) {
        throw new Error('CBOR array exceeds maximum element limit');
      }
      const arr: unknown[] = [];
      let cursor = nextOffset;
      for (let i = 0; i < count; i++) {
        const item = decodeCborItem(buf, cursor, depth + 1);
        arr.push(item.value);
        cursor = item.nextOffset;
      }
      return { value: arr, nextOffset: cursor };
    }
    case 5: {
      const { val: count, nextOffset } = readCborUint(buf, afterHeader, ai);
      if (count > CBOR_MAX_COLLECTION_LEN) {
        throw new Error('CBOR map exceeds maximum entry limit');
      }
      const map = new Map<unknown, unknown>();
      const seenBufKeys = new Set<string>();
      let cursor = nextOffset;
      for (let i = 0; i < count; i++) {
        const k = decodeCborItem(buf, cursor, depth + 1);
        if (Buffer.isBuffer(k.value)) {
          const hexKey = k.value.toString('hex');
          if (seenBufKeys.has(hexKey)) {
            throw new Error('Duplicate CBOR map key');
          }
          seenBufKeys.add(hexKey);
        } else if (map.has(k.value)) {
          throw new Error('Duplicate CBOR map key');
        }
        const v = decodeCborItem(buf, k.nextOffset, depth + 1);
        map.set(k.value, v.value);
        cursor = v.nextOffset;
      }
      return { value: map, nextOffset: cursor };
    }
    case 6: {
      const { nextOffset } = readCborUint(buf, afterHeader, ai);
      return decodeCborItem(buf, nextOffset, depth + 1);
    }
    case 7: {
      if (ai === 20) return { value: false, nextOffset: afterHeader };
      if (ai === 21) return { value: true, nextOffset: afterHeader };
      if (ai === 22) return { value: null, nextOffset: afterHeader };
      if (ai === 23) return { value: undefined, nextOffset: afterHeader };
      if (ai === 24) {
        if (afterHeader + 1 > buf.length) throw new Error('CBOR truncated simple value');
        return { value: buf[afterHeader], nextOffset: afterHeader + 1 };
      }
      if (ai === 25) {
        if (afterHeader + 2 > buf.length) throw new Error('CBOR truncated float16');
        return { value: buf.readUInt16BE(afterHeader), nextOffset: afterHeader + 2 };
      }
      if (ai === 26) {
        if (afterHeader + 4 > buf.length) throw new Error('CBOR truncated float32');
        return { value: buf.readFloatBE(afterHeader), nextOffset: afterHeader + 4 };
      }
      if (ai === 27) {
        if (afterHeader + 8 > buf.length) throw new Error('CBOR truncated float64');
        return { value: buf.readDoubleBE(afterHeader), nextOffset: afterHeader + 8 };
      }
      throw new Error(`Unsupported CBOR simple/float value ${ai}`);
    }
    default:
      throw new Error(`Invalid CBOR major type ${major}`);
  }
}

export interface ParsedWebAuthnPublicKey {
  keyObject: crypto.KeyObject;
  alg: number;
  normalizedPublicKeyB64: string;
}

function stripLeadingZeroBytes(buf: Buffer): Buffer {
  let idx = 0;
  while (idx < buf.length - 1 && buf[idx] === 0) {
    idx++;
  }
  return idx > 0 ? buf.subarray(idx) : buf;
}

function parseStrictCoseAlg(map: Map<unknown, unknown>, defaultAlg: number): number {
  if (!map.has(3)) return defaultAlg;
  const rawAlg = map.get(3);
  if (typeof rawAlg !== 'number' || !Number.isInteger(rawAlg)) {
    throw new Error(`Invalid COSE alg type: ${typeof rawAlg}`);
  }
  return rawAlg;
}

function assertValidRsaExponentBytes(eClean: Buffer): void {
  if (
    eClean.length < 1 ||
    (eClean[eClean.length - 1]! & 1) !== 1 ||
    (eClean.length === 1 && eClean[0] === 1)
  ) {
    throw new Error('RSA public exponent must be an odd integer >= 3');
  }
}

function assertExactDerSequenceLength(bytes: Buffer): void {
  if (bytes.length < 2 || bytes[0] !== 0x30) {
    throw new Error('SPKI DER must begin with an ASN.1 SEQUENCE (0x30)');
  }
  const lenByte = bytes[1]!;
  let headerLen: number;
  let contentLen: number;
  if ((lenByte & 0x80) === 0) {
    headerLen = 2;
    contentLen = lenByte;
  } else {
    const numLenBytes = lenByte & 0x7f;
    if (numLenBytes === 0) {
      throw new Error('SPKI DER indefinite length is not allowed');
    }
    if (numLenBytes > 4 || bytes.length < 2 + numLenBytes) {
      throw new Error('SPKI DER length header truncated or out of range');
    }
    if (bytes[2] === 0x00) {
      throw new Error('SPKI DER non-minimal length encoding');
    }
    contentLen = 0;
    for (let i = 0; i < numLenBytes; i++) {
      contentLen = contentLen * 256 + bytes[2 + i]!;
    }
    if (contentLen < 128) {
      throw new Error('SPKI DER non-minimal long-form length');
    }
    headerLen = 2 + numLenBytes;
  }
  if (headerLen + contentLen !== bytes.length) {
    throw new Error('SPKI DER has trailing or truncated bytes');
  }
}

/**
 * Parses a WebAuthn public key encoded as either RFC 8152 CBOR COSE_Key or X.509 SPKI DER
 * for ES256 (-7), ES384 (-35), ES512 (-36), EdDSA/Ed25519 (-8), and RS256 (-257).
 */
export function parseWebAuthnPublicKey(input: Buffer | string): ParsedWebAuthnPublicKey {
  const bytes = typeof input === 'string' ? decodeBase64AnyStrict(input) : Buffer.from(input);
  if (bytes.length === 0) {
    throw new Error('Public key bytes cannot be empty');
  }

  // Path 1: CBOR COSE_Key map
  try {
    const decoded = decodeCborItem(bytes, 0, 0);
    if (decoded.nextOffset === bytes.length && decoded.value instanceof Map) {
      const map = decoded.value as Map<unknown, unknown>;
      const kty = map.get(1);

      if (kty === 2) {
        // EC2
        const crv = map.get(-1);
        const x = map.get(-2);
        const y = map.get(-3);
        const curveInfo =
          crv === 1
            ? { name: 'P-256', coordLen: 32, expectedAlg: -7 }
            : crv === 2
              ? { name: 'P-384', coordLen: 48, expectedAlg: -35 }
              : crv === 3
                ? { name: 'P-521', coordLen: 66, expectedAlg: -36 }
                : null;
        if (!curveInfo) {
          throw new Error(`Unsupported COSE EC2 curve: ${String(crv)}`);
        }
        const alg = parseStrictCoseAlg(map, curveInfo.expectedAlg);
        if (alg !== curveInfo.expectedAlg) {
          throw new Error(`COSE EC2 alg ${alg} does not match curve ${curveInfo.name}`);
        }
        if (
          !Buffer.isBuffer(x) ||
          x.length !== curveInfo.coordLen ||
          !Buffer.isBuffer(y) ||
          y.length !== curveInfo.coordLen
        ) {
          throw new Error(`Invalid COSE EC2 coordinate lengths for ${curveInfo.name}`);
        }
        const keyObject = crypto.createPublicKey({
          key: {
            kty: 'EC',
            crv: curveInfo.name,
            x: x.toString('base64url'),
            y: y.toString('base64url'),
          },
          format: 'jwk',
        });
        return {
          keyObject,
          alg,
          normalizedPublicKeyB64: bytes.toString('base64'),
        };
      }

      if (kty === 1) {
        // OKP (Ed25519)
        const crv = map.get(-1);
        const x = map.get(-2);
        const alg = parseStrictCoseAlg(map, -8);
        if (crv !== 6 || alg !== -8) {
          throw new Error(`Unsupported COSE OKP curve=${String(crv)} alg=${alg}`);
        }
        if (!Buffer.isBuffer(x) || x.length !== 32) {
          throw new Error('Invalid COSE Ed25519 public key length');
        }
        const keyObject = crypto.createPublicKey({
          key: {
            kty: 'OKP',
            crv: 'Ed25519',
            x: x.toString('base64url'),
          },
          format: 'jwk',
        });
        return {
          keyObject,
          alg: -8,
          normalizedPublicKeyB64: bytes.toString('base64'),
        };
      }

      if (kty === 3) {
        // RSA (RS256)
        const n = map.get(-1);
        const e = map.get(-2);
        const alg = parseStrictCoseAlg(map, -257);
        if (alg !== -257) {
          throw new Error(`Unsupported COSE RSA algorithm ${alg}`);
        }
        if (!Buffer.isBuffer(n) || !Buffer.isBuffer(e)) {
          throw new Error('Invalid COSE RSA modulus or exponent');
        }
        const nClean = stripLeadingZeroBytes(n);
        const eClean = stripLeadingZeroBytes(e);
        if (nClean.length < 256) {
          throw new Error('COSE RSA modulus must be at least 2048 bits');
        }
        assertValidRsaExponentBytes(eClean);
        const keyObject = crypto.createPublicKey({
          key: {
            kty: 'RSA',
            n: nClean.toString('base64url'),
            e: eClean.toString('base64url'),
          },
          format: 'jwk',
        });
        if ((keyObject.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
          throw new Error('COSE RSA modulus must be at least 2048 bits');
        }
        return {
          keyObject,
          alg: -257,
          normalizedPublicKeyB64: bytes.toString('base64'),
        };
      }
    }
  } catch (coseErr) {
    // Fall through to SPKI DER only when bytes are not a valid CBOR map; if it was a malformed COSE key, SPKI will also reject cleanly.
    void coseErr;
  }

  // Path 2: X.509 SPKI DER (e.g., browser `AuthenticatorAttestationResponse.getPublicKey()`)
  assertExactDerSequenceLength(bytes);
  let keyObject: crypto.KeyObject;
  try {
    keyObject = crypto.createPublicKey({ key: bytes, format: 'der', type: 'spki' });
  } catch {
    throw new Error('Unsupported or malformed WebAuthn public key (expected COSE_Key CBOR or SPKI DER)');
  }
  const canonicalDer = keyObject.export({ type: 'spki', format: 'der' });
  if (!canonicalDer.equals(bytes)) {
    throw new Error('SPKI DER is non-canonical or contains trailing bytes');
  }

  let alg: number;
  if (keyObject.asymmetricKeyType === 'ec') {
    const curve = keyObject.asymmetricKeyDetails?.namedCurve;
    if (curve === 'prime256v1' || curve === 'P-256') {
      alg = -7;
    } else if (curve === 'secp384r1' || curve === 'P-384') {
      alg = -35;
    } else if (curve === 'secp521r1' || curve === 'P-521') {
      alg = -36;
    } else {
      throw new Error(`Unsupported SPKI EC curve: ${String(curve)}`);
    }
  } else if (keyObject.asymmetricKeyType === 'ed25519') {
    alg = -8;
  } else if (keyObject.asymmetricKeyType === 'rsa') {
    const modLen = keyObject.asymmetricKeyDetails?.modulusLength ?? 0;
    if (modLen < 2048) {
      throw new Error(`SPKI RSA modulus length ${modLen} is below minimum 2048 bits`);
    }
    const jwk = keyObject.export({ format: 'jwk' }) as { e?: string };
    const eClean = jwk.e ? stripLeadingZeroBytes(Buffer.from(jwk.e, 'base64url')) : Buffer.alloc(0);
    assertValidRsaExponentBytes(eClean);
    alg = -257;
  } else {
    throw new Error(`Unsupported SPKI key type: ${String(keyObject.asymmetricKeyType)}`);
  }

  return {
    keyObject,
    alg,
    normalizedPublicKeyB64: canonicalDer.toString('base64'),
  };
}

export interface ParsedWebAuthnAuthenticatorData {
  rpIdHash: Buffer;
  flags: number;
  up: boolean;
  uv: boolean;
  at: boolean;
  ed: boolean;
  signCount: number;
  aaguid?: Buffer;
  credentialId?: Buffer;
  credentialPublicKeyBytes?: Buffer;
}

export function parseWebAuthnAuthenticatorData(authData: Buffer): ParsedWebAuthnAuthenticatorData {
  if (authData.length < 37) {
    throw new Error('authenticatorData must be at least 37 bytes');
  }
  const rpIdHash = Buffer.from(authData.subarray(0, 32));
  const flags = authData[32]!;
  const up = (flags & 0x01) !== 0;
  const uv = (flags & 0x04) !== 0;
  const at = (flags & 0x40) !== 0;
  const ed = (flags & 0x80) !== 0;
  const signCount = authData.readUInt32BE(33);

  const parsed: ParsedWebAuthnAuthenticatorData = {
    rpIdHash,
    flags,
    up,
    uv,
    at,
    ed,
    signCount,
  };

  let offset = 37;
  if (at) {
    if (authData.length < 55) {
      throw new Error('attestedCredentialData truncated');
    }
    parsed.aaguid = Buffer.from(authData.subarray(37, 53));
    const credIdLen = authData.readUInt16BE(53);
    const credEnd = 55 + credIdLen;
    if (credIdLen === 0 || credEnd >= authData.length) {
      throw new Error('attestedCredentialData credentialId length out of bounds');
    }
    parsed.credentialId = Buffer.from(authData.subarray(55, credEnd));
    const pubKeyDecoded = decodeCborItem(authData, credEnd, 0);
    parsed.credentialPublicKeyBytes = Buffer.from(
      authData.subarray(credEnd, pubKeyDecoded.nextOffset),
    );
    offset = pubKeyDecoded.nextOffset;
  }

  if (ed) {
    if (offset >= authData.length) {
      throw new Error('authenticatorData ED flag set but extension data missing');
    }
    const extDecoded = decodeCborItem(authData, offset, 0);
    if (!(extDecoded.value instanceof Map) || extDecoded.nextOffset !== authData.length) {
      throw new Error(
        'authenticatorData extensions must be a single CBOR map consuming all remaining bytes',
      );
    }
  } else if (offset !== authData.length) {
    throw new Error('Unexpected trailing bytes in authenticatorData');
  }

  return parsed;
}

export function parseWebAuthnAttestationObject(attObjBuf: Buffer): {
  fmt: string;
  authData: ParsedWebAuthnAuthenticatorData;
  rawAuthData: Buffer;
} {
  const decoded = decodeCborItem(attObjBuf, 0, 0);
  if (decoded.nextOffset !== attObjBuf.length || !(decoded.value instanceof Map)) {
    throw new Error('attestationObject must be a CBOR map');
  }
  const map = decoded.value as Map<unknown, unknown>;
  const fmt = typeof map.get('fmt') === 'string' ? String(map.get('fmt')) : 'none';
  const rawAuthData = map.get('authData');
  if (!Buffer.isBuffer(rawAuthData)) {
    throw new Error('attestationObject missing authData bytes');
  }
  const authData = parseWebAuthnAuthenticatorData(rawAuthData);
  if (!authData.at || !authData.credentialId || !authData.credentialPublicKeyBytes) {
    throw new Error('attestationObject missing attested credential data');
  }
  return { fmt, authData, rawAuthData };
}

export function verifyWebAuthnSignature(
  keyObject: crypto.KeyObject,
  alg: number,
  authenticatorData: Buffer,
  clientDataBytes: Buffer,
  signature: Buffer,
): boolean {
  if (signature.length === 0) return false;
  try {
    const keyType = keyObject.asymmetricKeyType;
    const curve = keyObject.asymmetricKeyDetails?.namedCurve;
    const clientDataHash = crypto.createHash('sha256').update(clientDataBytes).digest();
    const signedData = Buffer.concat([authenticatorData, clientDataHash]);

    switch (alg) {
      case -7:
        if (keyType !== 'ec' || (curve !== 'prime256v1' && curve !== 'P-256')) {
          return false;
        }
        return (
          crypto.verify('sha256', signedData, keyObject, signature) ||
          (signature.length === 64 &&
            crypto.verify(
              'sha256',
              signedData,
              { key: keyObject, dsaEncoding: 'ieee-p1363' },
              signature,
            ))
        );
      case -35:
        if (keyType !== 'ec' || (curve !== 'secp384r1' && curve !== 'P-384')) {
          return false;
        }
        return (
          crypto.verify('sha384', signedData, keyObject, signature) ||
          (signature.length === 96 &&
            crypto.verify(
              'sha384',
              signedData,
              { key: keyObject, dsaEncoding: 'ieee-p1363' },
              signature,
            ))
        );
      case -36:
        if (keyType !== 'ec' || (curve !== 'secp521r1' && curve !== 'P-521')) {
          return false;
        }
        return (
          crypto.verify('sha512', signedData, keyObject, signature) ||
          (signature.length === 132 &&
            crypto.verify(
              'sha512',
              signedData,
              { key: keyObject, dsaEncoding: 'ieee-p1363' },
              signature,
            ))
        );
      case -8:
        if (keyType !== 'ed25519') {
          return false;
        }
        return crypto.verify(null, signedData, keyObject, signature);
      case -257:
        if (keyType !== 'rsa') {
          return false;
        }
        return crypto.verify('sha256', signedData, keyObject, signature);
      default:
        return false;
    }
  } catch {
    return false;
  }
}
