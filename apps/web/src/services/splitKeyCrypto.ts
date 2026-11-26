import {
  DEFAULT_ARGON2_KDF_PARAMS,
  formatDeviceSyncCode,
  type Argon2KdfParamsDto,
  type DeviceSyncApproveRequest,
} from '@gpui-telegram/protocol';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(bytes.length, i + chunkSize));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const normalized = b64.trim().replace(/-/g, '+').replace(/_/g, '/');
  const padded =
    normalized.length % 4 === 0
      ? normalized
      : normalized + '='.repeat(4 - (normalized.length % 4));
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function getSubtleCrypto(): SubtleCrypto {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('WebCrypto subtle API is unavailable (requires HTTPS or localhost)');
  }
  return crypto.subtle;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

function isAllZero(bytes: Uint8Array): boolean {
  let acc = 0;
  for (let i = 0; i < bytes.byteLength; i++) {
    acc |= bytes[i] ?? 0;
  }
  return acc === 0;
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrays) total += a.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.byteLength;
  }
  return out;
}

function readU32LE(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset] ?? 0) |
      ((buf[offset + 1] ?? 0) << 8) |
      ((buf[offset + 2] ?? 0) << 16) |
      ((buf[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

function writeU32LE(buf: Uint8Array, offset: number, val: number): void {
  buf[offset] = val & 0xff;
  buf[offset + 1] = (val >>> 8) & 0xff;
  buf[offset + 2] = (val >>> 16) & 0xff;
  buf[offset + 3] = (val >>> 24) & 0xff;
}

function writeU64LE(buf: Uint8Array, offset: number, val: number): void {
  const lo = val >>> 0;
  const hi = Math.floor(val / 0x100000000) >>> 0;
  writeU32LE(buf, offset, lo);
  writeU32LE(buf, offset + 4, hi);
}

// ============================================================================
// RFC 8439 ChaCha20-Poly1305 AEAD (Pure TypeScript, Zero External Dependencies)
// ============================================================================

function rotl32(v: number, n: number): number {
  return ((v << n) | (v >>> (32 - n))) >>> 0;
}

function chacha20QuarterRound(s: Uint32Array, a: number, b: number, c: number, d: number): void {
  s[a] = ((s[a] ?? 0) + (s[b] ?? 0)) >>> 0;
  s[d] = rotl32((s[d] ?? 0) ^ (s[a] ?? 0), 16);

  s[c] = ((s[c] ?? 0) + (s[d] ?? 0)) >>> 0;
  s[b] = rotl32((s[b] ?? 0) ^ (s[c] ?? 0), 12);

  s[a] = ((s[a] ?? 0) + (s[b] ?? 0)) >>> 0;
  s[d] = rotl32((s[d] ?? 0) ^ (s[a] ?? 0), 8);

  s[c] = ((s[c] ?? 0) + (s[d] ?? 0)) >>> 0;
  s[b] = rotl32((s[b] ?? 0) ^ (s[c] ?? 0), 7);
}

function chacha20Block(key: Uint8Array, counter: number, nonce: Uint8Array): Uint8Array {
  const initial = new Uint32Array(16);
  initial[0] = 0x61707865;
  initial[1] = 0x3320646e;
  initial[2] = 0x79622d32;
  initial[3] = 0x6b206574;
  for (let i = 0; i < 8; i++) {
    initial[4 + i] = readU32LE(key, i * 4);
  }
  initial[12] = counter >>> 0;
  initial[13] = readU32LE(nonce, 0);
  initial[14] = readU32LE(nonce, 4);
  initial[15] = readU32LE(nonce, 8);

  const working = new Uint32Array(initial);
  for (let i = 0; i < 10; i++) {
    // Column rounds
    chacha20QuarterRound(working, 0, 4, 8, 12);
    chacha20QuarterRound(working, 1, 5, 9, 13);
    chacha20QuarterRound(working, 2, 6, 10, 14);
    chacha20QuarterRound(working, 3, 7, 11, 15);
    // Diagonal rounds
    chacha20QuarterRound(working, 0, 5, 10, 15);
    chacha20QuarterRound(working, 1, 6, 11, 12);
    chacha20QuarterRound(working, 2, 7, 8, 13);
    chacha20QuarterRound(working, 3, 4, 9, 14);
  }

  const out = new Uint8Array(64);
  for (let i = 0; i < 16; i++) {
    writeU32LE(out, i * 4, ((working[i] ?? 0) + (initial[i] ?? 0)) >>> 0);
  }
  return out;
}

function chacha20Xor(
  key: Uint8Array,
  initialCounter: number,
  nonce: Uint8Array,
  input: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(input.byteLength);
  let counter = initialCounter >>> 0;
  for (let offset = 0; offset < input.byteLength; offset += 64) {
    const keystream = chacha20Block(key, counter, nonce);
    counter = (counter + 1) >>> 0;
    const len = Math.min(64, input.byteLength - offset);
    for (let i = 0; i < len; i++) {
      out[offset + i] = (input[offset + i] ?? 0) ^ (keystream[i] ?? 0);
    }
  }
  return out;
}

const POLY1305_P = (1n << 130n) - 5n;
const POLY1305_MASK128 = (1n << 128n) - 1n;

function leBytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = bytes.byteLength - 1; i >= 0; i--) {
    result = (result << 8n) | BigInt(bytes[i] ?? 0);
  }
  return result;
}

function poly1305Mac(otk32: Uint8Array, msg: Uint8Array): Uint8Array {
  const rBytes = new Uint8Array(otk32.subarray(0, 16));
  // RFC 8439 §2.5 clamp r
  rBytes[3] = (rBytes[3] ?? 0) & 15;
  rBytes[7] = (rBytes[7] ?? 0) & 15;
  rBytes[11] = (rBytes[11] ?? 0) & 15;
  rBytes[15] = (rBytes[15] ?? 0) & 15;
  rBytes[4] = (rBytes[4] ?? 0) & 252;
  rBytes[8] = (rBytes[8] ?? 0) & 252;
  rBytes[12] = (rBytes[12] ?? 0) & 252;

  const r = leBytesToBigInt(rBytes);
  const s = leBytesToBigInt(otk32.subarray(16, 32));

  let acc = 0n;
  for (let offset = 0; offset < msg.byteLength; offset += 16) {
    const chunk = msg.subarray(offset, Math.min(msg.byteLength, offset + 16));
    const n = leBytesToBigInt(chunk) + (1n << BigInt(chunk.byteLength * 8));
    acc = ((acc + n) * r) % POLY1305_P;
  }

  let tagBig = (acc + s) & POLY1305_MASK128;
  const tag = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    tag[i] = Number(tagBig & 0xffn);
    tagBig >>= 8n;
  }
  return tag;
}

function buildPoly1305AeadInput(aad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  const aadPad = (16 - (aad.byteLength % 16)) % 16;
  const ctPad = (16 - (ciphertext.byteLength % 16)) % 16;
  const macData = new Uint8Array(
    aad.byteLength + aadPad + ciphertext.byteLength + ctPad + 16,
  );
  let pos = 0;
  macData.set(aad, pos);
  pos += aad.byteLength + aadPad;
  macData.set(ciphertext, pos);
  pos += ciphertext.byteLength + ctPad;
  writeU64LE(macData, pos, aad.byteLength);
  writeU64LE(macData, pos + 8, ciphertext.byteLength);
  return macData;
}

/**
 * Genuine RFC 8439 IETF ChaCha20-Poly1305 AEAD encryption.
 * Returns `ciphertext || tag16`.
 */
export function chacha20Poly1305Encrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array = new Uint8Array(0),
): Uint8Array {
  if (key.byteLength !== 32) {
    throw new Error(`ChaCha20-Poly1305 requires a 32-byte key, got ${key.byteLength}`);
  }
  if (nonce.byteLength !== 12) {
    throw new Error(`ChaCha20-Poly1305 requires a 12-byte nonce, got ${nonce.byteLength}`);
  }
  const otk = chacha20Block(key, 0, nonce).subarray(0, 32);
  const ciphertext = chacha20Xor(key, 1, nonce, plaintext);
  const macData = buildPoly1305AeadInput(aad, ciphertext);
  const tag = poly1305Mac(otk, macData);
  const out = new Uint8Array(ciphertext.byteLength + 16);
  out.set(ciphertext, 0);
  out.set(tag, ciphertext.byteLength);
  return out;
}

/**
 * Genuine RFC 8439 IETF ChaCha20-Poly1305 AEAD decryption with constant-time tag verification.
 * Expects `ciphertext || tag16`; throws on any tag, key, nonce, ciphertext, or AAD mismatch.
 */
export function chacha20Poly1305Decrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertextAndTag: Uint8Array,
  aad: Uint8Array = new Uint8Array(0),
): Uint8Array {
  if (key.byteLength !== 32) {
    throw new Error(`ChaCha20-Poly1305 requires a 32-byte key, got ${key.byteLength}`);
  }
  if (nonce.byteLength !== 12) {
    throw new Error(`ChaCha20-Poly1305 requires a 12-byte nonce, got ${nonce.byteLength}`);
  }
  if (ciphertextAndTag.byteLength < 16) {
    throw new Error('ChaCha20-Poly1305 ciphertext is truncated (< 16-byte tag)');
  }
  const ctLen = ciphertextAndTag.byteLength - 16;
  const ciphertext = ciphertextAndTag.subarray(0, ctLen);
  const tag = ciphertextAndTag.subarray(ctLen);

  const otk = chacha20Block(key, 0, nonce).subarray(0, 32);
  const macData = buildPoly1305AeadInput(aad, ciphertext);
  const expectedTag = poly1305Mac(otk, macData);
  if (!constantTimeEqual(tag, expectedTag)) {
    throw new Error('ChaCha20-Poly1305 authentication tag verification failed');
  }
  return chacha20Xor(key, 1, nonce, ciphertext);
}

// ============================================================================
// RFC 7693 BLAKE2b (64-bit BigInt) & RFC 9106 Argon2id v0x13 (32-bit Limb Fast)
// ============================================================================

const MASK64 = 0xffffffffffffffffn;

const BLAKE2B_IV: readonly bigint[] = [
  0x6a09e667f3bcc908n,
  0xbb67ae8584caa73bn,
  0x3c6ef372fe94f82bn,
  0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n,
  0x9b05688c2b3e6c1fn,
  0x1f83d9abfb41bd6bn,
  0x5be0cd19137e2179n,
];

const BLAKE2B_SIGMA: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

function rotr64Big(v: bigint, n: bigint): bigint {
  return ((v >> n) | ((v << (64n - n)) & MASK64)) & MASK64;
}

function blake2bG(
  v: bigint[],
  a: number,
  b: number,
  c: number,
  d: number,
  x: bigint,
  y: bigint,
): void {
  v[a] = ((v[a] ?? 0n) + (v[b] ?? 0n) + x) & MASK64;
  v[d] = rotr64Big((v[d] ?? 0n) ^ (v[a] ?? 0n), 32n);
  v[c] = ((v[c] ?? 0n) + (v[d] ?? 0n)) & MASK64;
  v[b] = rotr64Big((v[b] ?? 0n) ^ (v[c] ?? 0n), 24n);
  v[a] = ((v[a] ?? 0n) + (v[b] ?? 0n) + y) & MASK64;
  v[d] = rotr64Big((v[d] ?? 0n) ^ (v[a] ?? 0n), 16n);
  v[c] = ((v[c] ?? 0n) + (v[d] ?? 0n)) & MASK64;
  v[b] = rotr64Big((v[b] ?? 0n) ^ (v[c] ?? 0n), 63n);
}

function blake2bCompress(
  h: bigint[],
  block: Uint8Array,
  t: bigint,
  isLast: boolean,
): void {
  const m: bigint[] = new Array(16);
  for (let i = 0; i < 16; i++) {
    const lo = BigInt(readU32LE(block, i * 8));
    const hi = BigInt(readU32LE(block, i * 8 + 4));
    m[i] = lo | (hi << 32n);
  }
  const v: bigint[] = new Array(16);
  for (let i = 0; i < 8; i++) {
    v[i] = h[i] ?? 0n;
    v[i + 8] = BLAKE2B_IV[i] ?? 0n;
  }
  v[12] = (v[12] ?? 0n) ^ (t & MASK64);
  v[13] = (v[13] ?? 0n) ^ (t >> 64n);
  if (isLast) {
    v[14] = (v[14] ?? 0n) ^ MASK64;
  }

  for (let round = 0; round < 12; round++) {
    const s = BLAKE2B_SIGMA[round % 10]!;
    blake2bG(v, 0, 4, 8, 12, m[s[0]!]!, m[s[1]!]!);
    blake2bG(v, 1, 5, 9, 13, m[s[2]!]!, m[s[3]!]!);
    blake2bG(v, 2, 6, 10, 14, m[s[4]!]!, m[s[5]!]!);
    blake2bG(v, 3, 7, 11, 15, m[s[6]!]!, m[s[7]!]!);
    blake2bG(v, 0, 5, 10, 15, m[s[8]!]!, m[s[9]!]!);
    blake2bG(v, 1, 6, 11, 12, m[s[10]!]!, m[s[11]!]!);
    blake2bG(v, 2, 7, 8, 13, m[s[12]!]!, m[s[13]!]!);
    blake2bG(v, 3, 4, 9, 14, m[s[14]!]!, m[s[15]!]!);
  }

  for (let i = 0; i < 8; i++) {
    h[i] = (h[i] ?? 0n) ^ (v[i] ?? 0n) ^ (v[i + 8] ?? 0n);
  }
}

/**
 * Genuine RFC 7693 BLAKE2b hash (`outLen` in `1..64`, optional `key` up to 64 bytes).
 */
export function blake2b(
  input: Uint8Array,
  outLen = 64,
  key: Uint8Array = new Uint8Array(0),
): Uint8Array {
  if (outLen < 1 || outLen > 64) {
    throw new Error(`BLAKE2b outLen must be in 1..64, got ${outLen}`);
  }
  if (key.byteLength > 64) {
    throw new Error(`BLAKE2b key must be <= 64 bytes, got ${key.byteLength}`);
  }

  const h: bigint[] = [...BLAKE2B_IV];
  h[0] = (h[0] ?? 0n) ^ BigInt(0x01010000 ^ (key.byteLength << 8) ^ outLen);

  let data = input;
  if (key.byteLength > 0) {
    const paddedKey = new Uint8Array(128);
    paddedKey.set(key, 0);
    if (input.byteLength === 0) {
      blake2bCompress(h, paddedKey, 128n, true);
      return serializeBlake2bOutput(h, outLen);
    }
    const merged = new Uint8Array(128 + input.byteLength);
    merged.set(paddedKey, 0);
    merged.set(input, 128);
    data = merged;
  }

  const block = new Uint8Array(128);
  if (data.byteLength === 0) {
    blake2bCompress(h, block, 0n, true);
  } else {
    let offset = 0;
    while (data.byteLength - offset > 128) {
      block.set(data.subarray(offset, offset + 128), 0);
      offset += 128;
      blake2bCompress(h, block, BigInt(offset), false);
    }
    block.fill(0);
    const remaining = data.byteLength - offset;
    block.set(data.subarray(offset, data.byteLength), 0);
    blake2bCompress(h, block, BigInt(data.byteLength), true);
  }

  return serializeBlake2bOutput(h, outLen);
}

function serializeBlake2bOutput(h: bigint[], outLen: number): Uint8Array {
  const full = new Uint8Array(64);
  for (let i = 0; i < 8; i++) {
    const w = h[i] ?? 0n;
    writeU32LE(full, i * 8, Number(w & 0xffffffffn));
    writeU32LE(full, i * 8 + 4, Number((w >> 32n) & 0xffffffffn));
  }
  return full.subarray(0, outLen);
}

/**
 * RFC 9106 §3.3 variable-length hash function `H'(X, tau)`.
 */
function argon2HPrime(input: Uint8Array, tau: number): Uint8Array {
  const prefixed = new Uint8Array(4 + input.byteLength);
  writeU32LE(prefixed, 0, tau);
  prefixed.set(input, 4);

  if (tau <= 64) {
    return blake2b(prefixed, tau);
  }

  const r = Math.ceil(tau / 32) - 2;
  const out = new Uint8Array(tau);
  let v = blake2b(prefixed, 64);
  out.set(v.subarray(0, 32), 0);
  for (let i = 2; i <= r; i++) {
    v = blake2b(v, 64);
    out.set(v.subarray(0, 32), (i - 1) * 32);
  }
  const finalLen = tau - 32 * r;
  const vLast = blake2b(v, finalLen);
  out.set(vLast, r * 32);
  return out;
}

/**
 * Exact 32x32 -> 64 unsigned multiplication returning high 32 bits (used for Argon2 index mapping).
 */
function mulU32Hi(a: number, b: number): number {
  const aL = a & 0xffff;
  const aH = a >>> 16;
  const bL = b & 0xffff;
  const bH = b >>> 16;
  const p0 = aL * bL;
  const p1 = aL * bH;
  const p2 = aH * bL;
  const p3 = aH * bH;
  const mid = (p0 >>> 16) + (p1 & 0xffff) + (p2 & 0xffff);
  return (p3 + (p1 >>> 16) + (p2 >>> 16) + (mid >>> 16)) >>> 0;
}

/**
 * BlaMka `G(a, b, c, d)` operating in-place on a `Uint32Array` of 256 words (128 64-bit LE words).
 * Each 64-bit word `idx` is stored at `(buf[idx*2] = lo, buf[idx*2 + 1] = hi)`.
 */
function argon2Gb(buf: Uint32Array, a: number, b: number, c: number, d: number): void {
  const a2 = a * 2;
  const b2 = b * 2;
  const c2 = c * 2;
  const d2 = d * 2;

  let aLo = buf[a2]!;
  let aHi = buf[a2 + 1]!;
  let bLo = buf[b2]!;
  let bHi = buf[b2 + 1]!;
  let cLo = buf[c2]!;
  let cHi = buf[c2 + 1]!;
  let dLo = buf[d2]!;
  let dHi = buf[d2 + 1]!;

  // Step 1: a = a + b + 2 * lo32(a) * lo32(b); d = rotr64(d ^ a, 32)
  {
    const xL = aLo & 0xffff;
    const xH = aLo >>> 16;
    const yL = bLo & 0xffff;
    const yH = bLo >>> 16;
    const p0 = xL * yL;
    const p1 = xL * yH;
    const p2 = xH * yL;
    const p3 = xH * yH;
    const mid = (p0 >>> 16) + (p1 & 0xffff) + (p2 & 0xffff);
    const mLo = ((p0 & 0xffff) | (mid << 16)) >>> 0;
    const mHi = (p3 + (p1 >>> 16) + (p2 >>> 16) + (mid >>> 16)) >>> 0;
    const tLo = (mLo << 1) >>> 0;
    const tHi = ((mHi << 1) | (mLo >>> 31)) >>> 0;
    const sumLo = aLo + bLo + tLo;
    const carry = Math.floor(sumLo / 0x100000000);
    aLo = sumLo >>> 0;
    aHi = (aHi + bHi + tHi + carry) >>> 0;

    const xLo = (dLo ^ aLo) >>> 0;
    const xHi = (dHi ^ aHi) >>> 0;
    dLo = xHi;
    dHi = xLo;
  }

  // Step 2: c = c + d + 2 * lo32(c) * lo32(d); b = rotr64(b ^ c, 24)
  {
    const xL = cLo & 0xffff;
    const xH = cLo >>> 16;
    const yL = dLo & 0xffff;
    const yH = dLo >>> 16;
    const p0 = xL * yL;
    const p1 = xL * yH;
    const p2 = xH * yL;
    const p3 = xH * yH;
    const mid = (p0 >>> 16) + (p1 & 0xffff) + (p2 & 0xffff);
    const mLo = ((p0 & 0xffff) | (mid << 16)) >>> 0;
    const mHi = (p3 + (p1 >>> 16) + (p2 >>> 16) + (mid >>> 16)) >>> 0;
    const tLo = (mLo << 1) >>> 0;
    const tHi = ((mHi << 1) | (mLo >>> 31)) >>> 0;
    const sumLo = cLo + dLo + tLo;
    const carry = Math.floor(sumLo / 0x100000000);
    cLo = sumLo >>> 0;
    cHi = (cHi + dHi + tHi + carry) >>> 0;

    const xLo = (bLo ^ cLo) >>> 0;
    const xHi = (bHi ^ cHi) >>> 0;
    bLo = ((xLo >>> 24) | (xHi << 8)) >>> 0;
    bHi = ((xHi >>> 24) | (xLo << 8)) >>> 0;
  }

  // Step 3: a = a + b + 2 * lo32(a) * lo32(b); d = rotr64(d ^ a, 16)
  {
    const xL = aLo & 0xffff;
    const xH = aLo >>> 16;
    const yL = bLo & 0xffff;
    const yH = bLo >>> 16;
    const p0 = xL * yL;
    const p1 = xL * yH;
    const p2 = xH * yL;
    const p3 = xH * yH;
    const mid = (p0 >>> 16) + (p1 & 0xffff) + (p2 & 0xffff);
    const mLo = ((p0 & 0xffff) | (mid << 16)) >>> 0;
    const mHi = (p3 + (p1 >>> 16) + (p2 >>> 16) + (mid >>> 16)) >>> 0;
    const tLo = (mLo << 1) >>> 0;
    const tHi = ((mHi << 1) | (mLo >>> 31)) >>> 0;
    const sumLo = aLo + bLo + tLo;
    const carry = Math.floor(sumLo / 0x100000000);
    aLo = sumLo >>> 0;
    aHi = (aHi + bHi + tHi + carry) >>> 0;

    const xLo = (dLo ^ aLo) >>> 0;
    const xHi = (dHi ^ aHi) >>> 0;
    dLo = ((xLo >>> 16) | (xHi << 16)) >>> 0;
    dHi = ((xHi >>> 16) | (xLo << 16)) >>> 0;
  }

  // Step 4: c = c + d + 2 * lo32(c) * lo32(d); b = rotr64(b ^ c, 63)
  {
    const xL = cLo & 0xffff;
    const xH = cLo >>> 16;
    const yL = dLo & 0xffff;
    const yH = dLo >>> 16;
    const p0 = xL * yL;
    const p1 = xL * yH;
    const p2 = xH * yL;
    const p3 = xH * yH;
    const mid = (p0 >>> 16) + (p1 & 0xffff) + (p2 & 0xffff);
    const mLo = ((p0 & 0xffff) | (mid << 16)) >>> 0;
    const mHi = (p3 + (p1 >>> 16) + (p2 >>> 16) + (mid >>> 16)) >>> 0;
    const tLo = (mLo << 1) >>> 0;
    const tHi = ((mHi << 1) | (mLo >>> 31)) >>> 0;
    const sumLo = cLo + dLo + tLo;
    const carry = Math.floor(sumLo / 0x100000000);
    cLo = sumLo >>> 0;
    cHi = (cHi + dHi + tHi + carry) >>> 0;

    const xLo = (bLo ^ cLo) >>> 0;
    const xHi = (bHi ^ cHi) >>> 0;
    bLo = ((xLo << 1) | (xHi >>> 31)) >>> 0;
    bHi = ((xHi << 1) | (xLo >>> 31)) >>> 0;
  }

  buf[a2] = aLo;
  buf[a2 + 1] = aHi;
  buf[b2] = bLo;
  buf[b2 + 1] = bHi;
  buf[c2] = cLo;
  buf[c2 + 1] = cHi;
  buf[d2] = dLo;
  buf[d2 + 1] = dHi;
}

function argon2Permute16(
  buf: Uint32Array,
  i0: number,
  i1: number,
  i2: number,
  i3: number,
  i4: number,
  i5: number,
  i6: number,
  i7: number,
  i8: number,
  i9: number,
  i10: number,
  i11: number,
  i12: number,
  i13: number,
  i14: number,
  i15: number,
): void {
  argon2Gb(buf, i0, i4, i8, i12);
  argon2Gb(buf, i1, i5, i9, i13);
  argon2Gb(buf, i2, i6, i10, i14);
  argon2Gb(buf, i3, i7, i11, i15);
  argon2Gb(buf, i0, i5, i10, i15);
  argon2Gb(buf, i1, i6, i11, i12);
  argon2Gb(buf, i2, i7, i8, i13);
  argon2Gb(buf, i3, i4, i9, i14);
}

/**
 * RFC 9106 §3.5 Argon2 compression function `G(X, Y)` operating on 256-uint32 blocks.
 */
function argon2CompressBlock(
  xBuf: Uint32Array,
  xOff: number,
  yBuf: Uint32Array,
  yOff: number,
  outBuf: Uint32Array,
  outOff: number,
  xorIntoOut: boolean,
  tmpR: Uint32Array,
  tmpZ: Uint32Array,
): void {
  for (let i = 0; i < 256; i++) {
    const r = ((xBuf[xOff + i] ?? 0) ^ (yBuf[yOff + i] ?? 0)) >>> 0;
    tmpR[i] = r;
    tmpZ[i] = r;
  }

  // Row-wise P (8 rows of 16 uint64 words)
  for (let row = 0; row < 8; row++) {
    const base = row * 16;
    argon2Permute16(
      tmpZ,
      base,
      base + 1,
      base + 2,
      base + 3,
      base + 4,
      base + 5,
      base + 6,
      base + 7,
      base + 8,
      base + 9,
      base + 10,
      base + 11,
      base + 12,
      base + 13,
      base + 14,
      base + 15,
    );
  }

  // Column-wise P (8 columns of 8 pairs = 16 uint64 words each)
  for (let col = 0; col < 8; col++) {
    const c = col * 2;
    argon2Permute16(
      tmpZ,
      c,
      c + 1,
      16 + c,
      16 + c + 1,
      32 + c,
      32 + c + 1,
      48 + c,
      48 + c + 1,
      64 + c,
      64 + c + 1,
      80 + c,
      80 + c + 1,
      96 + c,
      96 + c + 1,
      112 + c,
      112 + c + 1,
    );
  }

  if (xorIntoOut) {
    for (let i = 0; i < 256; i++) {
      outBuf[outOff + i] = ((outBuf[outOff + i] ?? 0) ^ (tmpZ[i] ?? 0) ^ (tmpR[i] ?? 0)) >>> 0;
    }
  } else {
    for (let i = 0; i < 256; i++) {
      outBuf[outOff + i] = ((tmpZ[i] ?? 0) ^ (tmpR[i] ?? 0)) >>> 0;
    }
  }
}

function bytesToBlockU32(bytes: Uint8Array, dst: Uint32Array, dstOff: number): void {
  for (let i = 0; i < 256; i++) {
    dst[dstOff + i] = readU32LE(bytes, i * 4);
  }
}

function blockU32ToBytes(src: Uint32Array, srcOff: number): Uint8Array {
  const out = new Uint8Array(1024);
  for (let i = 0; i < 256; i++) {
    writeU32LE(out, i * 4, src[srcOff + i] ?? 0);
  }
  return out;
}

export interface Argon2DeriveOptions {
  secret?: Uint8Array;
  associatedData?: Uint8Array;
  /** 0 = Argon2d, 1 = Argon2i, 2 = Argon2id (default: 2) */
  type?: 0 | 1 | 2;
}

/**
 * Genuine RFC 9106 Argon2id v0x13 KDF (pure TypeScript, byte-for-byte compliant with RFC 9106 §5.3).
 */
export function argon2idDerive(
  password: Uint8Array | string,
  salt: Uint8Array,
  params: Partial<Argon2KdfParamsDto> = DEFAULT_ARGON2_KDF_PARAMS,
  tagLen = 32,
  opts: Argon2DeriveOptions = {},
): Uint8Array {
  const pwBytes = typeof password === 'string' ? textEncoder.encode(password) : password;
  const secret = opts.secret ?? new Uint8Array(0);
  const ad = opts.associatedData ?? new Uint8Array(0);
  const type = opts.type ?? 2; // Argon2id
  const version = 0x13;

  const p = Math.max(1, Math.floor(params.p_cost ?? DEFAULT_ARGON2_KDF_PARAMS.p_cost));
  const t = Math.max(1, Math.floor(params.t_cost ?? DEFAULT_ARGON2_KDF_PARAMS.t_cost));
  const mRequested = Math.max(
    8 * p,
    Math.floor(params.m_cost_kib ?? DEFAULT_ARGON2_KDF_PARAMS.m_cost_kib),
  );
  if (tagLen < 4) {
    throw new Error(`Argon2id tagLen must be >= 4, got ${tagLen}`);
  }
  if (salt.byteLength < 8) {
    throw new Error(`Argon2id salt must be >= 8 bytes, got ${salt.byteLength}`);
  }

  const segmentLength = Math.floor(mRequested / (4 * p));
  const laneLength = segmentLength * 4;
  const mPrime = laneLength * p;

  // Build H_0 input per RFC 9106 §3.2
  const h0Input = new Uint8Array(
    40 + pwBytes.byteLength + salt.byteLength + secret.byteLength + ad.byteLength,
  );
  let pos = 0;
  writeU32LE(h0Input, pos, p);
  pos += 4;
  writeU32LE(h0Input, pos, tagLen);
  pos += 4;
  writeU32LE(h0Input, pos, mRequested);
  pos += 4;
  writeU32LE(h0Input, pos, t);
  pos += 4;
  writeU32LE(h0Input, pos, version);
  pos += 4;
  writeU32LE(h0Input, pos, type);
  pos += 4;
  writeU32LE(h0Input, pos, pwBytes.byteLength);
  pos += 4;
  h0Input.set(pwBytes, pos);
  pos += pwBytes.byteLength;
  writeU32LE(h0Input, pos, salt.byteLength);
  pos += 4;
  h0Input.set(salt, pos);
  pos += salt.byteLength;
  writeU32LE(h0Input, pos, secret.byteLength);
  pos += 4;
  h0Input.set(secret, pos);
  pos += secret.byteLength;
  writeU32LE(h0Input, pos, ad.byteLength);
  pos += 4;
  h0Input.set(ad, pos);

  const h0 = blake2b(h0Input, 64);

  // Allocate memory buffer: mPrime blocks * 256 uint32 words
  const memory = new Uint32Array(mPrime * 256);
  const seedBuf = new Uint8Array(72);
  seedBuf.set(h0, 0);

  for (let lane = 0; lane < p; lane++) {
    writeU32LE(seedBuf, 64, 0);
    writeU32LE(seedBuf, 68, lane);
    bytesToBlockU32(argon2HPrime(seedBuf, 1024), memory, lane * laneLength * 256);

    writeU32LE(seedBuf, 64, 1);
    writeU32LE(seedBuf, 68, lane);
    bytesToBlockU32(argon2HPrime(seedBuf, 1024), memory, (lane * laneLength + 1) * 256);
  }

  const zeroBlock = new Uint32Array(256);
  const inputBlock = new Uint32Array(256);
  const addressBlock = new Uint32Array(256);
  const tmpR = new Uint32Array(256);
  const tmpZ = new Uint32Array(256);

  const nextAddresses = (): void => {
    // Increment 64-bit little-endian counter at word 6 (indices 12, 13)
    const nextLo = ((inputBlock[12] ?? 0) + 1) >>> 0;
    inputBlock[12] = nextLo;
    if (nextLo === 0) {
      inputBlock[13] = ((inputBlock[13] ?? 0) + 1) >>> 0;
    }
    argon2CompressBlock(zeroBlock, 0, inputBlock, 0, addressBlock, 0, false, tmpR, tmpZ);
    argon2CompressBlock(zeroBlock, 0, addressBlock, 0, addressBlock, 0, false, tmpR, tmpZ);
  };

  for (let pass = 0; pass < t; pass++) {
    for (let slice = 0; slice < 4; slice++) {
      for (let lane = 0; lane < p; lane++) {
        const dataIndependent = type === 1 || (type === 2 && pass === 0 && slice < 2);
        let startingIndex = 0;

        if (dataIndependent) {
          inputBlock.fill(0);
          inputBlock[0] = pass >>> 0;
          inputBlock[2] = lane >>> 0;
          inputBlock[4] = slice >>> 0;
          inputBlock[6] = mPrime >>> 0;
          inputBlock[8] = t >>> 0;
          inputBlock[10] = type >>> 0;
        }

        if (pass === 0 && slice === 0) {
          startingIndex = 2;
          if (dataIndependent) {
            nextAddresses();
          }
        }

        const laneBase = lane * laneLength;
        for (let index = startingIndex; index < segmentLength; index++) {
          const currIdx = slice * segmentLength + index;
          const prevIdx = currIdx === 0 ? laneLength - 1 : currIdx - 1;
          const prevOff = (laneBase + prevIdx) * 256;

          let j1: number;
          let j2: number;
          if (dataIndependent) {
            const addrSlot = index & 127;
            if (addrSlot === 0) {
              nextAddresses();
            }
            j1 = addressBlock[addrSlot * 2]!;
            j2 = addressBlock[addrSlot * 2 + 1]!;
          } else {
            j1 = memory[prevOff]!;
            j2 = memory[prevOff + 1]!;
          }

          const refLane = pass === 0 && slice === 0 ? lane : j2 % p;
          const sameLane = refLane === lane;

          let refAreaSize: number;
          if (pass === 0) {
            if (slice === 0) {
              refAreaSize = index - 1;
            } else if (sameLane) {
              refAreaSize = slice * segmentLength + index - 1;
            } else {
              refAreaSize = slice * segmentLength + (index === 0 ? -1 : 0);
            }
          } else if (sameLane) {
            refAreaSize = laneLength - segmentLength + index - 1;
          } else {
            refAreaSize = laneLength - segmentLength + (index === 0 ? -1 : 0);
          }

          const x = mulU32Hi(j1, j1);
          const y = mulU32Hi(refAreaSize >>> 0, x);
          const relativePos = refAreaSize - 1 - y;

          const startPos = pass === 0 || slice === 3 ? 0 : (slice + 1) * segmentLength;
          const refIdx = (startPos + relativePos) % laneLength;

          const refOff = (refLane * laneLength + refIdx) * 256;
          const currOff = (laneBase + currIdx) * 256;

          argon2CompressBlock(
            memory,
            prevOff,
            memory,
            refOff,
            memory,
            currOff,
            pass > 0,
            tmpR,
            tmpZ,
          );
        }
      }
    }
  }

  // Finalize: XOR last block of every lane, then H'(C, tagLen)
  const finalBlock = new Uint32Array(256);
  const firstLastOff = (laneLength - 1) * 256;
  for (let i = 0; i < 256; i++) {
    finalBlock[i] = memory[firstLastOff + i]!;
  }
  for (let lane = 1; lane < p; lane++) {
    const off = (lane * laneLength + laneLength - 1) * 256;
    for (let i = 0; i < 256; i++) {
      finalBlock[i] = ((finalBlock[i] ?? 0) ^ (memory[off + i] ?? 0)) >>> 0;
    }
  }

  return argon2HPrime(blockU32ToBytes(finalBlock, 0), tagLen);
}

// ============================================================================
// Split-Key V2 Derivation (Desktop Argon2id + Web Backwards-Compatible PBKDF2)
// ============================================================================

export function generateRandomSaltB64(byteLen = 16): string {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return bytesToBase64(bytes);
}

export function generateVaultRootKey(): Uint8Array {
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);
  return key;
}

export interface SplitKeyDerivationResult {
  authVerifierB64: string;
  vaultWrapKeyBytes: Uint8Array;
  kdfParams: Argon2KdfParamsDto;
}

export interface DeriveSplitKeyOptions {
  kdfEngine?: 'pbkdf2_web' | 'argon2id';
}

async function hkdfSha256DeriveBytes(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array | string,
  byteLen = 32,
): Promise<Uint8Array> {
  const subtle = getSubtleCrypto();
  const hkdfKey = await subtle.importKey('raw', toArrayBuffer(ikm), 'HKDF', false, ['deriveBits']);
  const infoBytes = typeof info === 'string' ? textEncoder.encode(info) : info;
  const bits = await subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toArrayBuffer(salt),
      info: toArrayBuffer(infoBytes),
    },
    hkdfKey,
    byteLen * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Exact Desktop Rust (`e2ee_sync.rs:466-504`) Split-Key V2 derivation:
 * - Runs RFC 9106 Argon2id v0x13 over `(utf8(password), raw16ByteSalt, kdfParams)` -> `masterKey[32]`
 * - Runs `HKDF-SHA256(salt = zero32, ikm = masterKey)` with exact desktop info strings:
 *   - `"gpui-telegram/auth-verifier/v2"` -> `authVerifierB64` (44-char standard base64)
 *   - `"gpui-telegram/vault-kek/v2"` -> `vaultWrapKeyBytes` (32-byte client-only KEK)
 */
export async function deriveSplitKeyV2Argon2id(
  password: string,
  saltB64: string,
  kdfParams: Argon2KdfParamsDto = DEFAULT_ARGON2_KDF_PARAMS,
): Promise<SplitKeyDerivationResult> {
  const normalizedParams: Argon2KdfParamsDto = {
    m_cost_kib: kdfParams.m_cost_kib,
    t_cost: kdfParams.t_cost,
    p_cost: kdfParams.p_cost,
  };
  const saltBytes = base64ToBytes(saltB64);
  const masterKey = argon2idDerive(password, saltBytes, normalizedParams, 32);
  const zeroSalt = new Uint8Array(32);

  const [verifierBytes, wrapKeyBytes] = await Promise.all([
    hkdfSha256DeriveBytes(masterKey, zeroSalt, 'gpui-telegram/auth-verifier/v2', 32),
    hkdfSha256DeriveBytes(masterKey, zeroSalt, 'gpui-telegram/vault-kek/v2', 32),
  ]);

  masterKey.fill(0);
  return {
    authVerifierB64: bytesToBase64(verifierBytes),
    vaultWrapKeyBytes: wrapKeyBytes,
    kdfParams: normalizedParams,
  };
}

/**
 * Deterministic Split-Key V2 derivation:
 * - When `opts?.kdfEngine === 'argon2id'`, runs exact desktop RFC 9106 Argon2id + HKDF-SHA256.
 * - Default `'pbkdf2_web'` preserves existing PBKDF2-HMAC-SHA256(10_000) + HKDF-SHA256 wire parity
 *   with pre-existing web accounts and `e2e/helpers/server.ts`.
 */
export async function deriveSplitKeyV2(
  password: string,
  saltB64: string,
  kdfParams: Argon2KdfParamsDto = DEFAULT_ARGON2_KDF_PARAMS,
  opts?: DeriveSplitKeyOptions,
): Promise<SplitKeyDerivationResult> {
  if (opts?.kdfEngine === 'argon2id') {
    return deriveSplitKeyV2Argon2id(password, saltB64, kdfParams);
  }

  const subtle = getSubtleCrypto();
  const normalizedParams: Argon2KdfParamsDto = {
    m_cost_kib: kdfParams.m_cost_kib,
    t_cost: kdfParams.t_cost,
    p_cost: kdfParams.p_cost,
  };
  const saltBytes = base64ToBytes(saltB64);
  const domainPrefix = textEncoder.encode(
    `fabushi/split-key-v2|${normalizedParams.m_cost_kib}|${normalizedParams.t_cost}|${normalizedParams.p_cost}|`,
  );
  const boundSalt = new Uint8Array(domainPrefix.length + saltBytes.length);
  boundSalt.set(domainPrefix, 0);
  boundSalt.set(saltBytes, domainPrefix.length);

  const pwKey = await subtle.importKey(
    'raw',
    toArrayBuffer(textEncoder.encode(password)),
    'PBKDF2',
    false,
    ['deriveBits'],
  );

  const masterBits = await subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: toArrayBuffer(boundSalt),
      iterations: 10_000,
    },
    pwKey,
    256,
  );

  const hkdfKey = await subtle.importKey('raw', masterBits, 'HKDF', false, ['deriveBits']);

  const [verifierBits, wrapBits] = await Promise.all([
    subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: toArrayBuffer(saltBytes),
        info: toArrayBuffer(textEncoder.encode('fabushi/auth-verifier/v2')),
      },
      hkdfKey,
      256,
    ),
    subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: toArrayBuffer(saltBytes),
        info: toArrayBuffer(textEncoder.encode('fabushi/vault-wrap/v2')),
      },
      hkdfKey,
      256,
    ),
  ]);

  return {
    authVerifierB64: bytesToBase64(new Uint8Array(verifierBits)),
    vaultWrapKeyBytes: new Uint8Array(wrapBits),
    kdfParams: normalizedParams,
  };
}

// ============================================================================
// Vault Root Key Wrapping, Emergency Kit (`EK-` Base32) & Per-Item Subkeys
// ============================================================================

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Formats a 32-byte recovery key into desktop RFC 4648 Base32 nopad grouped in 4s (`e2ee_sync.rs:1418-1436`).
 * V2 prepends `"EK-"` (`EK-XXXX-XXXX-...`).
 */
export function formatEmergencyKitKey(raw32: Uint8Array, isV2 = true): string {
  if (raw32.byteLength !== 32) {
    throw new Error(`Emergency kit key must be 32 bytes, got ${raw32.byteLength}`);
  }
  let bits = 0;
  let value = 0;
  let b32 = '';
  for (let i = 0; i < raw32.byteLength; i++) {
    value = (value << 8) | (raw32[i] ?? 0);
    bits += 8;
    while (bits >= 5) {
      b32 += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]!;
      bits -= 5;
    }
  }
  if (bits > 0) {
    b32 += BASE32_ALPHABET[(value << (5 - bits)) & 31]!;
  }
  const grouped = b32.match(/.{1,4}/g)?.join('-') ?? b32;
  return isV2 ? `EK-${grouped}` : grouped;
}

/**
 * Parses a formatted Emergency Kit recovery key (`EK-XXXX-XXXX-...` or unprefixed Base32) back to 32 bytes.
 */
export function parseRecoveryKey(formatted: string): Uint8Array {
  let cleaned = formatted.replace(/[\s-]+/g, '').toUpperCase();
  if (cleaned.length === 54 && cleaned.startsWith('EK')) {
    cleaned = cleaned.slice(2);
  }
  if (cleaned.length !== 52) {
    throw new Error(`Invalid recovery key length: expected 52 Base32 chars, got ${cleaned.length}`);
  }
  const out = new Uint8Array(32);
  let bits = 0;
  let value = 0;
  let outIdx = 0;
  for (let i = 0; i < cleaned.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(cleaned[i]!);
    if (idx < 0) {
      throw new Error(`Invalid Base32 character '${cleaned[i]}' in recovery key`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out[outIdx++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  if (outIdx !== 32 || (value & ((1 << bits) - 1)) !== 0) {
    throw new Error('Malformed Base32 recovery key padding');
  }
  return out;
}

/**
 * Derives desktop Recovery KEK (`e2ee_sync.rs:1336-1347`):
 * `HKDF-SHA256(salt = "gpui-user-vault-recovery-hkdf-v1", ikm = recoveryRaw32, info = "gpui-user-vault:recovery-root-key:v1|${userId}", L = 32)`
 */
export async function deriveRecoveryKek(
  recoveryRaw32: Uint8Array,
  userId: number | string,
): Promise<Uint8Array> {
  if (recoveryRaw32.byteLength !== 32) {
    throw new Error(`Recovery key must be 32 bytes, got ${recoveryRaw32.byteLength}`);
  }
  return hkdfSha256DeriveBytes(
    recoveryRaw32,
    textEncoder.encode('gpui-user-vault-recovery-hkdf-v1'),
    `gpui-user-vault:recovery-root-key:v1|${userId}`,
    32,
  );
}

async function importAes256GcmKey(keyBytes: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  if (keyBytes.byteLength !== 32) {
    throw new Error(`Expected 32-byte key, received ${keyBytes.byteLength} bytes`);
  }
  return getSubtleCrypto().importKey(
    'raw',
    toArrayBuffer(keyBytes),
    { name: 'AES-GCM', length: 256 },
    false,
    usages,
  );
}

function buildWrappedRootKeyAad(userId?: number | string): Uint8Array {
  return userId !== undefined
    ? textEncoder.encode(`gpui-user-vault:wrapped-root-key:v1|${userId}`)
    : new Uint8Array(0);
}

/**
 * Wraps a 32-byte Vault root key using RFC 8439 ChaCha20-Poly1305:
 * returns standard Base64 of `12-byte nonce || 32-byte ciphertext || 16-byte tag` (exact 60 bytes).
 * When `userId` is provided, binds desktop AAD `"gpui-user-vault:wrapped-root-key:v1|${userId}"`.
 */
export async function wrapVaultRootKey(
  rootKey: Uint8Array,
  wrapKeyBytes: Uint8Array,
  userId?: number | string,
): Promise<string> {
  if (rootKey.byteLength !== 32) {
    throw new Error(`Expected 32-byte vault root key, received ${rootKey.byteLength} bytes`);
  }
  if (wrapKeyBytes.byteLength !== 32) {
    throw new Error(`Expected 32-byte wrap key, received ${wrapKeyBytes.byteLength} bytes`);
  }
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  const aad = buildWrappedRootKeyAad(userId);
  const cipherAndTag = chacha20Poly1305Encrypt(wrapKeyBytes, nonce, rootKey, aad);
  const combined = new Uint8Array(12 + cipherAndTag.byteLength);
  combined.set(nonce, 0);
  combined.set(cipherAndTag, 12);
  return bytesToBase64(combined);
}

/**
 * Unwraps a wrapped Vault root key (ChaCha20-Poly1305 primary, transparent legacy AES-256-GCM fallback).
 */
export async function unwrapVaultRootKey(
  wrappedB64: string,
  wrapKeyBytes: Uint8Array,
  userId?: number | string,
): Promise<Uint8Array> {
  const combined = base64ToBytes(wrappedB64);
  if (combined.byteLength < 28) {
    throw new Error('Wrapped vault root key payload is truncated');
  }
  const nonce = combined.subarray(0, 12);
  const ciphertext = combined.subarray(12);
  const aad = buildWrappedRootKeyAad(userId);

  try {
    return chacha20Poly1305Decrypt(wrapKeyBytes, nonce, ciphertext, aad);
  } catch (chachaErr) {
    // Transparent fallback to legacy AES-256-GCM envelopes (pre-M1B browser storage)
    try {
      const subtle = getSubtleCrypto();
      const aesKey = await importAes256GcmKey(wrapKeyBytes, ['decrypt']);
      if (aad.byteLength > 0) {
        try {
          const plainWithAad = await subtle.decrypt(
            {
              name: 'AES-GCM',
              iv: toArrayBuffer(nonce),
              additionalData: toArrayBuffer(aad),
            },
            aesKey,
            toArrayBuffer(ciphertext),
          );
          return new Uint8Array(plainWithAad);
        } catch {
          // Retry pre-M1B legacy AES-256-GCM format encrypted without AAD
        }
      }
      const plainBuf = await subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: toArrayBuffer(nonce),
        },
        aesKey,
        toArrayBuffer(ciphertext),
      );
      return new Uint8Array(plainBuf);
    } catch {
      throw chachaErr;
    }
  }
}

export async function wrapRecoveryRootKey(
  recoveryRaw32: Uint8Array,
  rootKey32: Uint8Array,
  userId: number | string,
): Promise<string> {
  const recoveryKek = await deriveRecoveryKek(recoveryRaw32, userId);
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  const aad = textEncoder.encode(`gpui-user-vault:recovery-root-key:v1|${userId}`);
  const ctAndTag = chacha20Poly1305Encrypt(recoveryKek, nonce, rootKey32, aad);
  recoveryKek.fill(0);
  return bytesToBase64(concatBytes(nonce, ctAndTag));
}

export async function unwrapRecoveryRootKey(
  recoveryRaw32: Uint8Array,
  wrappedB64: string,
  userId: number | string,
): Promise<Uint8Array> {
  const combined = base64ToBytes(wrappedB64);
  if (combined.byteLength < 28) {
    throw new Error('Recovery wrapped root key payload is truncated');
  }
  const recoveryKek = await deriveRecoveryKek(recoveryRaw32, userId);
  try {
    const nonce = combined.subarray(0, 12);
    const ctAndTag = combined.subarray(12);
    const aad = textEncoder.encode(`gpui-user-vault:recovery-root-key:v1|${userId}`);
    return chacha20Poly1305Decrypt(recoveryKek, nonce, ctAndTag, aad);
  } finally {
    recoveryKek.fill(0);
  }
}

export interface VaultItemCryptoMetadata {
  userId: number | string;
  category: string;
  itemKey: string;
  revision: number;
}

/**
 * Derives desktop per-item Vault subkey (`e2ee_sync.rs:1186-1201`):
 * `HKDF-SHA256(salt = "gpui-user-vault-item-hkdf-v1", ikm = rootKey32, info = "gpui-user-vault:subkey:v1|${userId}|${category}|${itemKey}", L = 32)`
 */
export async function deriveVaultItemSubkey(
  rootKey32: Uint8Array,
  userId: number | string,
  category: string,
  itemKey: string,
): Promise<Uint8Array> {
  if (rootKey32.byteLength !== 32) {
    throw new Error(`Expected 32-byte vault root key, got ${rootKey32.byteLength}`);
  }
  return hkdfSha256DeriveBytes(
    rootKey32,
    textEncoder.encode('gpui-user-vault-item-hkdf-v1'),
    `gpui-user-vault:subkey:v1|${userId}|${category}|${itemKey}`,
    32,
  );
}

/**
 * Builds canonical desktop per-item Vault AAD (`e2ee_sync.rs:1203-1213`).
 */
export function buildVaultItemAad(
  userId: number | string,
  category: string,
  itemKey: string,
  revision: number,
): string {
  return `gpui-user-vault:item:v1|${userId}|${category}|${itemKey}|${revision}`;
}

export async function encryptVaultItem(
  plaintext: string | Uint8Array,
  rootKey: Uint8Array,
  aadOrMeta?: string | VaultItemCryptoMetadata,
): Promise<{ nonce_b64: string; ciphertext_b64: string }> {
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  const plainBytes = typeof plaintext === 'string' ? textEncoder.encode(plaintext) : plaintext;

  let encKey = rootKey;
  let aadBytes = new Uint8Array(0);
  let shouldZeroKey = false;

  if (aadOrMeta && typeof aadOrMeta === 'object') {
    encKey = await deriveVaultItemSubkey(
      rootKey,
      aadOrMeta.userId,
      aadOrMeta.category,
      aadOrMeta.itemKey,
    );
    shouldZeroKey = true;
    aadBytes = textEncoder.encode(
      buildVaultItemAad(
        aadOrMeta.userId,
        aadOrMeta.category,
        aadOrMeta.itemKey,
        aadOrMeta.revision,
      ),
    );
  } else if (typeof aadOrMeta === 'string' && aadOrMeta.length > 0) {
    aadBytes = textEncoder.encode(aadOrMeta);
  }

  try {
    const ctAndTag = chacha20Poly1305Encrypt(encKey, nonce, plainBytes, aadBytes);
    return {
      nonce_b64: bytesToBase64(nonce),
      ciphertext_b64: bytesToBase64(ctAndTag),
    };
  } finally {
    if (shouldZeroKey) encKey.fill(0);
  }
}

export async function decryptVaultItem(
  nonceB64: string,
  ciphertextB64: string,
  rootKey: Uint8Array,
  aadOrMeta?: string | VaultItemCryptoMetadata,
): Promise<string> {
  const nonce = base64ToBytes(nonceB64);
  const ciphertext = base64ToBytes(ciphertextB64);

  let decKey = rootKey;
  let aadBytes = new Uint8Array(0);
  let shouldZeroKey = false;

  if (aadOrMeta && typeof aadOrMeta === 'object') {
    decKey = await deriveVaultItemSubkey(
      rootKey,
      aadOrMeta.userId,
      aadOrMeta.category,
      aadOrMeta.itemKey,
    );
    shouldZeroKey = true;
    aadBytes = textEncoder.encode(
      buildVaultItemAad(
        aadOrMeta.userId,
        aadOrMeta.category,
        aadOrMeta.itemKey,
        aadOrMeta.revision,
      ),
    );
  } else if (typeof aadOrMeta === 'string' && aadOrMeta.length > 0) {
    aadBytes = textEncoder.encode(aadOrMeta);
  }

  try {
    try {
      const plain = chacha20Poly1305Decrypt(decKey, nonce, ciphertext, aadBytes);
      return textDecoder.decode(plain);
    } catch (chachaErr) {
      // Transparent fallback to legacy AES-256-GCM items (only for non-subkey legacy callers)
      if (!shouldZeroKey) {
        try {
          const subtle = getSubtleCrypto();
          const aesKey = await importAes256GcmKey(rootKey, ['decrypt']);
          const params: AesGcmParams = {
            name: 'AES-GCM',
            iv: toArrayBuffer(nonce),
            ...(aadBytes.byteLength > 0 ? { additionalData: toArrayBuffer(aadBytes) } : {}),
          };
          const plainBuf = await subtle.decrypt(params, aesKey, toArrayBuffer(ciphertext));
          return textDecoder.decode(new Uint8Array(plainBuf));
        } catch {
          throw chachaErr;
        }
      }
      throw chachaErr;
    }
  } finally {
    if (shouldZeroKey) decKey.fill(0);
  }
}

// ============================================================================
// X25519 Device Trust Ring Helpers (Desktop ChaCha20-Poly1305 + Contributory Check)
// ============================================================================

/**
 * Known non-contributory low-order Curve25519 u-coordinates (RFC 7748 / Dalek contributory check).
 */
const LOW_ORDER_X25519_HEX: ReadonlySet<string> = new Set([
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800',
  '5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
]);

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  }
  return out;
}

export function assertContributoryX25519Key(bytes: Uint8Array, label = 'X25519 key'): void {
  if (bytes.byteLength !== 32) {
    throw new Error(`${label} must be 32 bytes, got ${bytes.byteLength}`);
  }
  if (isAllZero(bytes)) {
    throw new Error(`${label} is all-zero (non-contributory)`);
  }
  // Mask high bit per RFC 7748 §5 before checking low-order points
  const masked = new Uint8Array(bytes);
  masked[31] = (masked[31] ?? 0) & 0x7f;
  if (LOW_ORDER_X25519_HEX.has(bytesToHex(masked)) || LOW_ORDER_X25519_HEX.has(bytesToHex(bytes))) {
    throw new Error(`${label} is a low-order non-contributory X25519 point`);
  }
}

export interface DeviceSyncKeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicKeyBytes: Uint8Array;
  publicKeyB64: string;
  verificationCode: string;
}

export interface DeviceSyncTransferContext {
  requestId: string;
  userId: number | string;
}

export function computeDeviceSyncCode(pubkey: Uint8Array | string): string {
  return formatDeviceSyncCode(pubkey);
}

export async function generateDeviceSyncKeyPair(): Promise<DeviceSyncKeyPair> {
  const subtle = getSubtleCrypto();
  const pair = (await subtle.generateKey({ name: 'X25519' } as AlgorithmIdentifier, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const rawPubBuf = await subtle.exportKey('raw', pair.publicKey);
  const publicKeyBytes = new Uint8Array(rawPubBuf);
  assertContributoryX25519Key(publicKeyBytes, 'Generated X25519 public key');
  const publicKeyB64 = bytesToBase64(publicKeyBytes);
  return {
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    publicKeyBytes,
    publicKeyB64,
    verificationCode: formatDeviceSyncCode(publicKeyBytes),
  };
}

async function computeX25519SharedSecret(
  privateKey: CryptoKey,
  peerPublicKeyBytes: Uint8Array,
): Promise<Uint8Array> {
  assertContributoryX25519Key(peerPublicKeyBytes, 'Peer X25519 public key');
  const subtle = getSubtleCrypto();
  const peerPubKey = await subtle.importKey(
    'raw',
    toArrayBuffer(peerPublicKeyBytes),
    { name: 'X25519' } as AlgorithmIdentifier,
    false,
    [],
  );
  const sharedBits = await subtle.deriveBits(
    { name: 'X25519', public: peerPubKey } as EcdhKeyDeriveParams,
    privateKey,
    256,
  );
  const shared = new Uint8Array(sharedBits);
  if (shared.byteLength !== 32 || isAllZero(shared)) {
    throw new Error('X25519 shared secret is all-zero (non-contributory)');
  }
  return shared;
}

async function deriveDeviceSyncKey(
  privateKey: CryptoKey,
  peerPublicKeyBytes: Uint8Array,
  nonceBytes: Uint8Array,
  context?: DeviceSyncTransferContext,
): Promise<Uint8Array> {
  const shared = await computeX25519SharedSecret(privateKey, peerPublicKeyBytes);
  try {
    if (context) {
      return await hkdfSha256DeriveBytes(
        shared,
        new Uint8Array(32),
        `gpui-telegram/device-key-transfer/v1:${context.requestId}`,
        32,
      );
    }
    return await hkdfSha256DeriveBytes(shared, nonceBytes, 'fabushi/device-sync/v1', 32);
  } finally {
    shared.fill(0);
  }
}

export async function sealRootKeyForDevice(
  rootKey: Uint8Array,
  requesterPublicKeyB64: string,
  context?: DeviceSyncTransferContext,
): Promise<DeviceSyncApproveRequest> {
  if (rootKey.byteLength !== 32) {
    throw new Error(`Expected 32-byte root key, got ${rootKey.byteLength}`);
  }
  const requesterPubBytes = base64ToBytes(requesterPublicKeyB64);
  assertContributoryX25519Key(requesterPubBytes, 'Requester X25519 public key');

  const ephemeral = await generateDeviceSyncKeyPair();
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);

  const wrapKeyBytes = await deriveDeviceSyncKey(
    ephemeral.privateKey,
    requesterPubBytes,
    nonce,
    context,
  );
  try {
    const aad = context
      ? textEncoder.encode(`device-sync:${context.requestId}:${context.userId}`)
      : new Uint8Array(0);
    const ctAndTag = chacha20Poly1305Encrypt(wrapKeyBytes, nonce, rootKey, aad);
    return {
      approver_ephemeral_pub_b64: ephemeral.publicKeyB64,
      encrypted_root_key_b64: bytesToBase64(ctAndTag),
      nonce_b64: bytesToBase64(nonce),
    };
  } finally {
    wrapKeyBytes.fill(0);
  }
}

export async function unsealRootKeyFromApprover(
  requesterPrivateKey: CryptoKey,
  approverEphemeralPubB64: string,
  encryptedRootKeyB64: string,
  nonceB64: string,
  context?: DeviceSyncTransferContext,
): Promise<Uint8Array> {
  const approverPubBytes = base64ToBytes(approverEphemeralPubB64);
  assertContributoryX25519Key(approverPubBytes, 'Approver X25519 public key');
  const nonce = base64ToBytes(nonceB64);
  const ciphertext = base64ToBytes(encryptedRootKeyB64);

  const wrapKeyBytes = await deriveDeviceSyncKey(
    requesterPrivateKey,
    approverPubBytes,
    nonce,
    context,
  );
  try {
    const aad = context
      ? textEncoder.encode(`device-sync:${context.requestId}:${context.userId}`)
      : new Uint8Array(0);
    try {
      return chacha20Poly1305Decrypt(wrapKeyBytes, nonce, ciphertext, aad);
    } catch (chachaErr) {
      // Transparent fallback to legacy AES-256-GCM payloads when no desktop context provided
      if (!context) {
        try {
          const subtle = getSubtleCrypto();
          const aesKey = await importAes256GcmKey(wrapKeyBytes, ['decrypt']);
          const plainBuf = await subtle.decrypt(
            { name: 'AES-GCM', iv: toArrayBuffer(nonce) },
            aesKey,
            toArrayBuffer(ciphertext),
          );
          return new Uint8Array(plainBuf);
        } catch {
          throw chachaErr;
        }
      }
      throw chachaErr;
    }
  } finally {
    wrapKeyBytes.fill(0);
  }
}
