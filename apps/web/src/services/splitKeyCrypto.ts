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

/**
 * Deterministic Split-Key V2 WebCrypto derivation:
 * - Stretches `(password, salt, kdfParams)` via PBKDF2-HMAC-SHA256 into a 32-byte master secret
 * - Splits master secret via HKDF-SHA256 into two cryptographically independent 32-byte keys:
 *   1. `authVerifierB64` (sent to server for authentication; server never sees plaintext password)
 *   2. `vaultWrapKeyBytes` (stays strictly client-side to wrap/unwrap the E2EE User Vault root key)
 */
export async function deriveSplitKeyV2(
  password: string,
  saltB64: string,
  kdfParams: Argon2KdfParamsDto = DEFAULT_ARGON2_KDF_PARAMS,
): Promise<SplitKeyDerivationResult> {
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

async function importAes256GcmKey(keyBytes: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  if (keyBytes.byteLength !== 32) {
    throw new Error(`Expected 32-byte AES-256 key, received ${keyBytes.byteLength} bytes`);
  }
  return getSubtleCrypto().importKey(
    'raw',
    toArrayBuffer(keyBytes),
    { name: 'AES-GCM', length: 256 },
    false,
    usages,
  );
}

/**
 * Wraps a 32-byte Vault root key using AES-256-GCM: returns standard Base64 of
 * `12-byte nonce || 32-byte ciphertext || 16-byte auth tag` (60 bytes total).
 */
export async function wrapVaultRootKey(
  rootKey: Uint8Array,
  wrapKeyBytes: Uint8Array,
): Promise<string> {
  const subtle = getSubtleCrypto();
  const aesKey = await importAes256GcmKey(wrapKeyBytes, ['encrypt']);
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  const cipherBuf = await subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(nonce) },
    aesKey,
    toArrayBuffer(rootKey),
  );
  const cipherBytes = new Uint8Array(cipherBuf);
  const combined = new Uint8Array(nonce.length + cipherBytes.length);
  combined.set(nonce, 0);
  combined.set(cipherBytes, nonce.length);
  return bytesToBase64(combined);
}

export async function unwrapVaultRootKey(
  wrappedB64: string,
  wrapKeyBytes: Uint8Array,
): Promise<Uint8Array> {
  const subtle = getSubtleCrypto();
  const combined = base64ToBytes(wrappedB64);
  if (combined.byteLength < 28) {
    throw new Error('Wrapped vault root key payload is truncated');
  }
  const nonce = combined.subarray(0, 12);
  const ciphertext = combined.subarray(12);
  const aesKey = await importAes256GcmKey(wrapKeyBytes, ['decrypt']);
  const plainBuf = await subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(nonce) },
    aesKey,
    toArrayBuffer(ciphertext),
  );
  return new Uint8Array(plainBuf);
}

export async function encryptVaultItem(
  plaintext: string | Uint8Array,
  rootKey: Uint8Array,
  aad?: string,
): Promise<{ nonce_b64: string; ciphertext_b64: string }> {
  const subtle = getSubtleCrypto();
  const aesKey = await importAes256GcmKey(rootKey, ['encrypt']);
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  const plainBytes = typeof plaintext === 'string' ? textEncoder.encode(plaintext) : plaintext;
  const params: AesGcmParams = {
    name: 'AES-GCM',
    iv: toArrayBuffer(nonce),
    ...(aad ? { additionalData: toArrayBuffer(textEncoder.encode(aad)) } : {}),
  };
  const cipherBuf = await subtle.encrypt(params, aesKey, toArrayBuffer(plainBytes));
  return {
    nonce_b64: bytesToBase64(nonce),
    ciphertext_b64: bytesToBase64(new Uint8Array(cipherBuf)),
  };
}

export async function decryptVaultItem(
  nonceB64: string,
  ciphertextB64: string,
  rootKey: Uint8Array,
  aad?: string,
): Promise<string> {
  const subtle = getSubtleCrypto();
  const aesKey = await importAes256GcmKey(rootKey, ['decrypt']);
  const nonce = base64ToBytes(nonceB64);
  const ciphertext = base64ToBytes(ciphertextB64);
  const params: AesGcmParams = {
    name: 'AES-GCM',
    iv: toArrayBuffer(nonce),
    ...(aad ? { additionalData: toArrayBuffer(textEncoder.encode(aad)) } : {}),
  };
  const plainBuf = await subtle.decrypt(params, aesKey, toArrayBuffer(ciphertext));
  return textDecoder.decode(new Uint8Array(plainBuf));
}

// ============================================================================
// X25519 Device Trust Ring Helpers
// ============================================================================

export interface DeviceSyncKeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicKeyBytes: Uint8Array;
  publicKeyB64: string;
  verificationCode: string;
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
  const publicKeyB64 = bytesToBase64(publicKeyBytes);
  return {
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    publicKeyBytes,
    publicKeyB64,
    verificationCode: formatDeviceSyncCode(publicKeyBytes),
  };
}

async function deriveDeviceSyncAesKey(
  privateKey: CryptoKey,
  peerPublicKeyBytes: Uint8Array,
  saltBytes: Uint8Array,
): Promise<Uint8Array> {
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
  const hkdfKey = await subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveBits']);
  const derivedBits = await subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toArrayBuffer(saltBytes),
      info: toArrayBuffer(textEncoder.encode('fabushi/device-sync/v1')),
    },
    hkdfKey,
    256,
  );
  return new Uint8Array(derivedBits);
}

export async function sealRootKeyForDevice(
  rootKey: Uint8Array,
  requesterPublicKeyB64: string,
): Promise<DeviceSyncApproveRequest> {
  const subtle = getSubtleCrypto();
  const requesterPubBytes = base64ToBytes(requesterPublicKeyB64);
  const ephemeral = await generateDeviceSyncKeyPair();
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);

  const aesKeyBytes = await deriveDeviceSyncAesKey(
    ephemeral.privateKey,
    requesterPubBytes,
    nonce,
  );
  const aesKey = await importAes256GcmKey(aesKeyBytes, ['encrypt']);
  const cipherBuf = await subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(nonce) },
    aesKey,
    toArrayBuffer(rootKey),
  );

  return {
    approver_ephemeral_pub_b64: ephemeral.publicKeyB64,
    encrypted_root_key_b64: bytesToBase64(new Uint8Array(cipherBuf)),
    nonce_b64: bytesToBase64(nonce),
  };
}

export async function unsealRootKeyFromApprover(
  requesterPrivateKey: CryptoKey,
  approverEphemeralPubB64: string,
  encryptedRootKeyB64: string,
  nonceB64: string,
): Promise<Uint8Array> {
  const subtle = getSubtleCrypto();
  const approverPubBytes = base64ToBytes(approverEphemeralPubB64);
  const nonce = base64ToBytes(nonceB64);
  const ciphertext = base64ToBytes(encryptedRootKeyB64);

  const aesKeyBytes = await deriveDeviceSyncAesKey(
    requesterPrivateKey,
    approverPubBytes,
    nonce,
  );
  const aesKey = await importAes256GcmKey(aesKeyBytes, ['decrypt']);
  const plainBuf = await subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(nonce) },
    aesKey,
    toArrayBuffer(ciphertext),
  );
  return new Uint8Array(plainBuf);
}
