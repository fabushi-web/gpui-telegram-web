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
