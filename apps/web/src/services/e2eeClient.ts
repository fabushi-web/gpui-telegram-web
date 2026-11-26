import {
  E2EE_HKDF_INFO,
  E2EE_SAFETY_EMOJIS,
  computeSafetyNumberEmojis,
  decryptSecretMessage,
  deriveSharedAesGcmKey,
  encryptSecretMessage,
  exportPublicKeyBase64,
  generateE2eeIdentity,
  generateEcdhKeyPair,
  importEcdhPrivateKeyJwk,
  importEcdhPublicKeyBase64,
  importEcdhPublicKeyJwk,
  signPreKeyPublic,
  verifyPreKeySignature as verifyLegacyP256PreKeySignature,
  type DevicePreKeyBundle,
  type E2eeDeviceIdentity,
  type EncryptedEnvelope,
  type GroupCiphertext,
  type PublishPreKeysRequest,
  type RatchetHeaderDto,
  type SenderKeyDistributionMessage,
} from '@gpui-telegram/protocol';
import {
  assertContributoryX25519Key,
  base64ToBytes,
  bytesToBase64,
  chacha20Poly1305Decrypt,
  chacha20Poly1305Encrypt,
} from './splitKeyCrypto';

const textEncoder = new TextEncoder();

export const DESKTOP_SPK_SIGN_DOMAIN = 'gpui-e2ee-spk-v1';
export const DESKTOP_X3DH_INFO = 'gpui-telegram-x3dh-v1';
export const DESKTOP_RATCHET_RK_INFO = 'gpui-e2ee-rk-v1';
export const DESKTOP_SENDER_KEY_SIGN_DOMAIN = 'gpui-e2ee-sk-v1';

export const RATCHET_MAX_SKIP = 256;
export const RATCHET_MAX_SKIPPED_STORAGE = 2000;
export const RATCHET_MAX_SEEN_X3DH_EKS = 128;

const E2EE_IDENTITY_STORAGE_PREFIX = 'gpui_tg_e2ee_identity_v2:';
const E2EE_CHAT_PEER_KEY_PREFIX = 'gpui_tg_e2ee_peer_pub_v2:';

export type E2eeKeySuite = 'x25519_ed25519' | 'p256';

export interface PersistedE2eeIdentityRecord {
  deviceId: string;
  keySuite?: E2eeKeySuite;
  dhPublicKeyBase64: string;
  dhPublicKeyJwk: JsonWebKey;
  dhPrivateKeyJwk: JsonWebKey;
  signingPublicKeyBase64: string;
  signingPublicKeyJwk: JsonWebKey;
  signingPrivateKeyJwk: JsonWebKey;
  signedPreKeyId: number;
  signedPreKeyPublicBase64: string;
  signedPreKeyPrivateJwk: JsonWebKey;
  signedPreKeySignature: string;
  oneTimePreKeys: Array<{
    keyId: number;
    publicKeyBase64: string;
    privateKeyJwk: JsonWebKey;
  }>;
  companionP256PublicBase64?: string;
  companionP256PrivateJwk?: JsonWebKey;
  companionX25519PublicBase64?: string;
  companionX25519PrivateJwk?: JsonWebKey;
  createdAtMs: number;
}

export interface DecryptedSecretPayload {
  text: string;
  mediaCaption?: string;
  ttlSeconds?: number;
  sentAtMs: number;
  nonce: string;
}

interface StoredSecretChatPeerState {
  chatId: number;
  peerUserId: number;
  peerPublicKeyBase64: string;
  peerPrivateJwkFallback?: JsonWebKey;
  safetyEmojis: [string, string, string, string];
  hexFingerprint: string;
  createdAtMs: number;
}

const identityMemoryCache = new Map<string, PersistedE2eeIdentityRecord>();
const peerStateMemoryCache = new Map<string, StoredSecretChatPeerState>();

function getSubtle(): SubtleCrypto {
  if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.subtle) {
    throw new Error('WebCrypto SubtleCrypto is unavailable');
  }
  return globalThis.crypto.subtle;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function assertUint32(value: number, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 0xffffffff
  ) {
    throw new Error(`Invalid uint32 ${label}: ${String(value)}`);
  }
  return value;
}

function u32BeBytes(n: number): Uint8Array {
  const out = new Uint8Array(4);
  const view = new DataView(out.buffer);
  view.setUint32(0, n >>> 0, false);
  return out;
}

function u64BeBytes(n: number | bigint): Uint8Array {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, BigInt(n) & 0xffffffffffffffffn, false);
  return out;
}

function i64BeBytes(n: number | bigint): Uint8Array {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setBigInt64(0, BigInt(n), false);
  return out;
}

function isAllZeroBytes(bytes: Uint8Array): boolean {
  let acc = 0;
  for (let i = 0; i < bytes.byteLength; i++) acc |= bytes[i] ?? 0;
  return acc === 0;
}

function getStorageItem(key: string): string | null {
  try {
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem(key);
    }
  } catch {
    // Ignore storage error
  }
  return null;
}

function setStorageItem(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, value);
    }
  } catch {
    // Ignore quota/sandbox error
  }
}

function inferKeySuite(record: PersistedE2eeIdentityRecord): E2eeKeySuite {
  if (record.keySuite === 'x25519_ed25519' || record.keySuite === 'p256') {
    return record.keySuite;
  }
  try {
    const pubLen = base64ToBytes(record.dhPublicKeyBase64).byteLength;
    return pubLen === 32 ? 'x25519_ed25519' : 'p256';
  } catch {
    return 'p256';
  }
}

export interface RawWebCryptoKeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicKeyBase64: string;
  publicKeyJwk: JsonWebKey;
  privateKeyJwk: JsonWebKey;
}

export async function generateX25519KeyPair(): Promise<RawWebCryptoKeyPair> {
  const subtle = getSubtle();
  const pair = (await subtle.generateKey({ name: 'X25519' } as AlgorithmIdentifier, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const rawPub = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  assertContributoryX25519Key(rawPub, 'X25519 public key');
  const publicKeyJwk = await subtle.exportKey('jwk', pair.publicKey);
  const privateKeyJwk = await subtle.exportKey('jwk', pair.privateKey);
  return {
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    publicKeyBase64: bytesToBase64(rawPub),
    publicKeyJwk,
    privateKeyJwk,
  };
}

export async function generateEd25519KeyPair(): Promise<RawWebCryptoKeyPair> {
  const subtle = getSubtle();
  const pair = (await subtle.generateKey({ name: 'Ed25519' } as AlgorithmIdentifier, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const rawPub = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  const publicKeyJwk = await subtle.exportKey('jwk', pair.publicKey);
  const privateKeyJwk = await subtle.exportKey('jwk', pair.privateKey);
  return {
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    publicKeyBase64: bytesToBase64(rawPub),
    publicKeyJwk,
    privateKeyJwk,
  };
}

async function importX25519PrivateKeyJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  const subtle = getSubtle();
  return subtle.importKey('jwk', jwk, { name: 'X25519' } as AlgorithmIdentifier, true, [
    'deriveBits',
  ]);
}

async function importX25519PublicKeyBase64(pubB64: string): Promise<CryptoKey> {
  const subtle = getSubtle();
  const raw = base64ToBytes(pubB64);
  assertContributoryX25519Key(raw, 'X25519 public key');
  return subtle.importKey(
    'raw',
    toArrayBuffer(raw),
    { name: 'X25519' } as AlgorithmIdentifier,
    true,
    [],
  );
}

async function importEd25519PrivateKeyJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  const subtle = getSubtle();
  return subtle.importKey('jwk', jwk, { name: 'Ed25519' } as AlgorithmIdentifier, true, ['sign']);
}

async function importEd25519PublicKeyBase64(pubB64: string): Promise<CryptoKey> {
  const subtle = getSubtle();
  const raw = base64ToBytes(pubB64);
  if (raw.byteLength !== 32) {
    throw new Error(`Ed25519 public key must be 32 bytes, got ${raw.byteLength}`);
  }
  return subtle.importKey(
    'raw',
    toArrayBuffer(raw),
    { name: 'Ed25519' } as AlgorithmIdentifier,
    true,
    ['verify'],
  );
}

async function x25519Dh(privateKey: CryptoKey, remotePublicB64: string): Promise<Uint8Array> {
  const subtle = getSubtle();
  const remotePub = await importX25519PublicKeyBase64(remotePublicB64);
  const sharedBits = await subtle.deriveBits(
    { name: 'X25519', public: remotePub } as EcdhKeyDeriveParams,
    privateKey,
    256,
  );
  const shared = new Uint8Array(sharedBits);
  if (shared.byteLength !== 32 || isAllZeroBytes(shared)) {
    throw new Error('X25519 DH produced non-contributory all-zero shared secret');
  }
  return shared;
}

async function hkdfSha256Bytes(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array | string,
  outBytes: number,
): Promise<Uint8Array> {
  const subtle = getSubtle();
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
    outBytes * 8,
  );
  return new Uint8Array(bits);
}

async function hmacSha256Bytes(keyBytes: Uint8Array, msg: Uint8Array): Promise<Uint8Array> {
  const subtle = getSubtle();
  const key = await subtle.importKey(
    'raw',
    toArrayBuffer(keyBytes),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await subtle.sign('HMAC', key, toArrayBuffer(msg));
  return new Uint8Array(sig);
}

/**
 * Signs a 32-byte X25519 signed-prekey public key using Ed25519 over
 * `utf8("gpui-e2ee-spk-v1") || spkPub32Bytes` (desktop wire format).
 */
export async function signDesktopPreKeyPublic(
  ed25519PrivateKey: CryptoKey,
  spkPublicBase64: string,
): Promise<string> {
  const subtle = getSubtle();
  const spkBytes = base64ToBytes(spkPublicBase64);
  const msg = concatBytes(textEncoder.encode(DESKTOP_SPK_SIGN_DOMAIN), spkBytes);
  const sig = new Uint8Array(
    await subtle.sign({ name: 'Ed25519' } as AlgorithmIdentifier, ed25519PrivateKey, toArrayBuffer(msg)),
  );
  return bytesToBase64(sig);
}

/**
 * Verifies a signed prekey signature supporting BOTH desktop 32B Ed25519 (`gpui-e2ee-spk-v1`)
 * and legacy 65B ECDSA P-256 (`gpui-telegram-x3dh-spk-v1`).
 */
export async function verifyPreKeySignature(
  signingPublicBase64: string,
  preKeyPublicBase64: string,
  signatureBase64: string,
): Promise<boolean> {
  try {
    const signingPubBytes = base64ToBytes(signingPublicBase64);
    const sigBytes = base64ToBytes(signatureBase64);
    if (signingPubBytes.byteLength === 32 && sigBytes.byteLength === 64) {
      const subtle = getSubtle();
      const pubKey = await importEd25519PublicKeyBase64(signingPublicBase64);
      const spkBytes = base64ToBytes(preKeyPublicBase64);
      const msg = concatBytes(textEncoder.encode(DESKTOP_SPK_SIGN_DOMAIN), spkBytes);
      return await subtle.verify(
        { name: 'Ed25519' } as AlgorithmIdentifier,
        pubKey,
        toArrayBuffer(sigBytes),
        toArrayBuffer(msg),
      );
    }
    return await verifyLegacyP256PreKeySignature(
      signingPublicBase64,
      preKeyPublicBase64,
      signatureBase64,
    );
  } catch {
    return false;
  }
}

/**
 * Clears in-memory E2EE identity and peer caches for the specified account (or all accounts when omitted).
 */
export function clearE2eeCacheForAccount(userId?: number | string): void {
  if (userId === undefined) {
    identityMemoryCache.clear();
    peerStateMemoryCache.clear();
    return;
  }
  const idPrefix = `${userId}:`;
  for (const key of Array.from(identityMemoryCache.keys())) {
    if (key.startsWith(idPrefix)) {
      identityMemoryCache.delete(key);
    }
  }
  const peerPrefix = `${E2EE_CHAT_PEER_KEY_PREFIX}${userId}:`;
  for (const key of Array.from(peerStateMemoryCache.keys())) {
    if (key.startsWith(peerPrefix)) {
      peerStateMemoryCache.delete(key);
    }
  }
}

/**
 * Loads or generates a persistent desktop-aligned WebCrypto `X25519 + Ed25519` identity + prekey bundle
 * (falling back cleanly to `ECDH P-256 + ECDSA P-256` if the runtime lacks X25519/Ed25519).
 */
export async function generateIdentityKeyPair(
  userId: number | string = 'default',
  deviceId = 'web-primary',
): Promise<PersistedE2eeIdentityRecord> {
  const cacheKey = `${userId}:${deviceId}`;
  const mem = identityMemoryCache.get(cacheKey);
  if (mem) return mem;

  const storageKey = `${E2EE_IDENTITY_STORAGE_PREFIX}${cacheKey}`;
  const raw = getStorageItem(storageKey);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as PersistedE2eeIdentityRecord;
      if (
        parsed &&
        parsed.dhPublicKeyBase64 &&
        parsed.dhPrivateKeyJwk &&
        parsed.signingPublicKeyBase64 &&
        parsed.signedPreKeyPublicBase64
      ) {
        parsed.keySuite = inferKeySuite(parsed);
        identityMemoryCache.set(cacheKey, parsed);
        return parsed;
      }
    } catch {
      // Regenerate below
    }
  }

  let record: PersistedE2eeIdentityRecord;
  try {
    const [dhKeyPair, signingKeyPair, signedPreKeyPair] = await Promise.all([
      generateX25519KeyPair(),
      generateEd25519KeyPair(),
      generateX25519KeyPair(),
    ]);
    const signedPreKeySignature = await signDesktopPreKeyPublic(
      signingKeyPair.privateKey,
      signedPreKeyPair.publicKeyBase64,
    );

    const oneTimePreKeys: PersistedE2eeIdentityRecord['oneTimePreKeys'] = [];
    for (let i = 1; i <= 5; i++) {
      const otk = await generateX25519KeyPair();
      oneTimePreKeys.push({
        keyId: i,
        publicKeyBase64: otk.publicKeyBase64,
        privateKeyJwk: otk.privateKeyJwk,
      });
    }

    record = {
      deviceId,
      keySuite: 'x25519_ed25519',
      dhPublicKeyBase64: dhKeyPair.publicKeyBase64,
      dhPublicKeyJwk: dhKeyPair.publicKeyJwk,
      dhPrivateKeyJwk: dhKeyPair.privateKeyJwk,
      signingPublicKeyBase64: signingKeyPair.publicKeyBase64,
      signingPublicKeyJwk: signingKeyPair.publicKeyJwk,
      signingPrivateKeyJwk: signingKeyPair.privateKeyJwk,
      signedPreKeyId: 1,
      signedPreKeyPublicBase64: signedPreKeyPair.publicKeyBase64,
      signedPreKeyPrivateJwk: signedPreKeyPair.privateKeyJwk,
      signedPreKeySignature,
      oneTimePreKeys,
      createdAtMs: Date.now(),
    };
  } catch {
    // Graceful fallback to P-256 ECDH + ECDSA on older browsers without X25519/Ed25519
    const baseIdentity: E2eeDeviceIdentity = await generateE2eeIdentity(deviceId);
    const signedPreKeyPair = await generateEcdhKeyPair();
    const signedPreKeySignature = await signPreKeyPublic(
      baseIdentity.signingKeyPair.privateKey,
      signedPreKeyPair.publicKeyBase64,
    );

    const oneTimePreKeys: PersistedE2eeIdentityRecord['oneTimePreKeys'] = [];
    for (let i = 1; i <= 5; i++) {
      const otk = await generateEcdhKeyPair();
      oneTimePreKeys.push({
        keyId: i,
        publicKeyBase64: otk.publicKeyBase64,
        privateKeyJwk: otk.privateKeyJwk,
      });
    }

    record = {
      deviceId,
      keySuite: 'p256',
      dhPublicKeyBase64: baseIdentity.dhKeyPair.publicKeyBase64,
      dhPublicKeyJwk: baseIdentity.dhKeyPair.publicKeyJwk,
      dhPrivateKeyJwk: baseIdentity.dhKeyPair.privateKeyJwk,
      signingPublicKeyBase64: baseIdentity.signingKeyPair.publicKeyBase64,
      signingPublicKeyJwk: baseIdentity.signingKeyPair.publicKeyJwk,
      signingPrivateKeyJwk: baseIdentity.signingKeyPair.privateKeyJwk,
      signedPreKeyId: 1,
      signedPreKeyPublicBase64: signedPreKeyPair.publicKeyBase64,
      signedPreKeyPrivateJwk: signedPreKeyPair.privateKeyJwk,
      signedPreKeySignature,
      oneTimePreKeys,
      createdAtMs: Date.now(),
    };
  }

  identityMemoryCache.set(cacheKey, record);
  setStorageItem(storageKey, JSON.stringify(record));
  return record;
}

export function toPublishPreKeysRequest(
  identity: PersistedE2eeIdentityRecord,
  deviceName = 'Fabushi Web (Browser)',
): PublishPreKeysRequest {
  return {
    device_id: identity.deviceId,
    device_name: deviceName,
    identity_key: identity.dhPublicKeyBase64,
    identity_signing_key: identity.signingPublicKeyBase64,
    signed_prekey: {
      key_id: identity.signedPreKeyId,
      public_key: identity.signedPreKeyPublicBase64,
      signature: identity.signedPreKeySignature,
      created_at_ms: identity.createdAtMs,
    },
    one_time_prekeys: identity.oneTimePreKeys.map((otk) => ({
      key_id: otk.keyId,
      public_key: otk.publicKeyBase64,
    })),
  };
}

export async function ensureSecretChatKeyMaterial(params: {
  localUserId: number;
  chatId: number;
  peerUserId: number;
  remoteBundles?: DevicePreKeyBundle[];
}): Promise<{
  identity: PersistedE2eeIdentityRecord;
  peerPublicKeyBase64: string;
  safetyEmojis: [string, string, string, string];
  hexFingerprint: string;
}> {
  const { localUserId, chatId, peerUserId, remoteBundles } = params;
  const identity = await generateIdentityKeyPair(localUserId);
  const storageKey = `${E2EE_CHAT_PEER_KEY_PREFIX}${localUserId}:${chatId}`;

  const cached = peerStateMemoryCache.get(storageKey);
  if (cached) {
    return {
      identity,
      peerPublicKeyBase64: cached.peerPublicKeyBase64,
      safetyEmojis: cached.safetyEmojis,
      hexFingerprint: cached.hexFingerprint,
    };
  }

  const storedRaw = getStorageItem(storageKey);
  if (storedRaw) {
    try {
      const parsed = JSON.parse(storedRaw) as StoredSecretChatPeerState;
      if (parsed.peerPublicKeyBase64 && Array.isArray(parsed.safetyEmojis)) {
        peerStateMemoryCache.set(storageKey, parsed);
        return {
          identity,
          peerPublicKeyBase64: parsed.peerPublicKeyBase64,
          safetyEmojis: parsed.safetyEmojis,
          hexFingerprint: parsed.hexFingerprint || '',
        };
      }
    } catch {
      // Rebuild below
    }
  }

  let peerPublicKeyBase64 = '';
  let peerPrivateJwkFallback: JsonWebKey | undefined;
  const suite = inferKeySuite(identity);

  // Prefer remote bundle matching our curve suite if multiple devices exist
  const matchingBundle = remoteBundles?.find((b) => {
    const key = b.identity_key || b.signed_prekey?.public_key;
    if (!key) return false;
    try {
      const len = base64ToBytes(key).byteLength;
      return suite === 'x25519_ed25519' ? len === 32 : len === 65;
    } catch {
      return false;
    }
  });
  const validBundle =
    matchingBundle ??
    remoteBundles?.find((b) => Boolean(b.identity_key || b.signed_prekey?.public_key));

  if (validBundle) {
    peerPublicKeyBase64 = validBundle.identity_key || validBundle.signed_prekey.public_key;
  } else if (suite === 'x25519_ed25519') {
    const ephemeralPeer = await generateX25519KeyPair();
    peerPublicKeyBase64 = ephemeralPeer.publicKeyBase64;
    peerPrivateJwkFallback = ephemeralPeer.privateKeyJwk;
  } else {
    const ephemeralPeer = await generateEcdhKeyPair();
    peerPublicKeyBase64 = ephemeralPeer.publicKeyBase64;
    peerPrivateJwkFallback = ephemeralPeer.privateKeyJwk;
  }

  const fp = await computeSafetyNumberEmojis(identity.dhPublicKeyBase64, peerPublicKeyBase64);

  const state: StoredSecretChatPeerState = {
    chatId,
    peerUserId,
    peerPublicKeyBase64,
    peerPrivateJwkFallback,
    safetyEmojis: fp.emojis,
    hexFingerprint: fp.hexFingerprint,
    createdAtMs: Date.now(),
  };
  peerStateMemoryCache.set(storageKey, state);
  setStorageItem(storageKey, JSON.stringify(state));

  return {
    identity,
    peerPublicKeyBase64,
    safetyEmojis: fp.emojis,
    hexFingerprint: fp.hexFingerprint,
  };
}

export async function computeSafetyFingerprintEmojis(
  localKeyBase64: string,
  remoteKeyBase64: string,
): Promise<[string, string, string, string]> {
  const res = await computeSafetyNumberEmojis(localKeyBase64, remoteKeyBase64);
  return res.emojis;
}

async function deriveSharedWebAesGcmKeyForIdentity(
  localUserId: number,
  identity: PersistedE2eeIdentityRecord,
  remotePublicKeyBase64: string,
): Promise<{ aesKey: CryptoKey; senderDhPublicBase64: string }> {
  const remoteBytes = base64ToBytes(remotePublicKeyBase64);
  const suite = inferKeySuite(identity);

  if (remoteBytes.byteLength === 32 && suite === 'x25519_ed25519') {
    const localPriv = await importX25519PrivateKeyJwk(identity.dhPrivateKeyJwk);
    const shared = await x25519Dh(localPriv, remotePublicKeyBase64);
    try {
      const subtle = getSubtle();
      const hkdfKey = await subtle.importKey('raw', toArrayBuffer(shared), 'HKDF', false, [
        'deriveKey',
      ]);
      const aesKey = await subtle.deriveKey(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: toArrayBuffer(new Uint8Array(32)),
          info: toArrayBuffer(textEncoder.encode(E2EE_HKDF_INFO)),
        },
        hkdfKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
      return { aesKey, senderDhPublicBase64: identity.dhPublicKeyBase64 };
    } finally {
      shared.fill(0);
    }
  }

  if (remoteBytes.byteLength === 65 && suite === 'p256') {
    const localPrivKey = await importEcdhPrivateKeyJwk(identity.dhPrivateKeyJwk);
    const aesKey = await deriveSharedAesGcmKey(localPrivKey, remotePublicKeyBase64);
    return { aesKey, senderDhPublicBase64: identity.dhPublicKeyBase64 };
  }

  // Mixed-curve compatibility: local X25519 speaking with legacy 65-byte P-256 peer
  if (remoteBytes.byteLength === 65 && suite === 'x25519_ed25519') {
    if (!identity.companionP256PrivateJwk || !identity.companionP256PublicBase64) {
      const companion = await generateEcdhKeyPair();
      identity.companionP256PublicBase64 = companion.publicKeyBase64;
      identity.companionP256PrivateJwk = companion.privateKeyJwk;
      const cacheKey = `${localUserId}:${identity.deviceId}`;
      identityMemoryCache.set(cacheKey, identity);
      setStorageItem(`${E2EE_IDENTITY_STORAGE_PREFIX}${cacheKey}`, JSON.stringify(identity));
    }
    const compPriv = await importEcdhPrivateKeyJwk(identity.companionP256PrivateJwk);
    const aesKey = await deriveSharedAesGcmKey(compPriv, remotePublicKeyBase64);
    return { aesKey, senderDhPublicBase64: identity.companionP256PublicBase64 };
  }

  // Reverse mixed-curve compatibility: legacy local P-256 speaking with 32-byte X25519 peer
  if (remoteBytes.byteLength === 32 && suite === 'p256') {
    if (!identity.companionX25519PrivateJwk || !identity.companionX25519PublicBase64) {
      const companion = await generateX25519KeyPair();
      identity.companionX25519PublicBase64 = companion.publicKeyBase64;
      identity.companionX25519PrivateJwk = companion.privateKeyJwk;
      const cacheKey = `${localUserId}:${identity.deviceId}`;
      identityMemoryCache.set(cacheKey, identity);
      setStorageItem(`${E2EE_IDENTITY_STORAGE_PREFIX}${cacheKey}`, JSON.stringify(identity));
    }
    const compPriv = await importX25519PrivateKeyJwk(identity.companionX25519PrivateJwk);
    const shared = await x25519Dh(compPriv, remotePublicKeyBase64);
    try {
      const subtle = getSubtle();
      const hkdfKey = await subtle.importKey('raw', toArrayBuffer(shared), 'HKDF', false, [
        'deriveKey',
      ]);
      const aesKey = await subtle.deriveKey(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: toArrayBuffer(new Uint8Array(32)),
          info: toArrayBuffer(textEncoder.encode(E2EE_HKDF_INFO)),
        },
        hkdfKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
      return { aesKey, senderDhPublicBase64: identity.companionX25519PublicBase64 };
    } finally {
      shared.fill(0);
    }
  }

  throw new Error(
    `Incompatible E2EE key curve combination: local=${suite}, remoteBytes=${remoteBytes.byteLength}`,
  );
}

/**
 * Encrypts a Secret Chat message using WebCrypto `X25519` (or legacy `ECDH P-256`) +
 * `HKDF-SHA256` + `AES-256-GCM` (preserving full WebCrypto `AES-GCM` auditability).
 */
export async function encryptEnvelope(params: {
  localUserId: number;
  chatId: number;
  peerUserId: number;
  plaintext: string;
  mediaCaption?: string;
  ttlSeconds?: number;
  remoteBundles?: DevicePreKeyBundle[];
  msgNum?: number;
}): Promise<{
  envelope: EncryptedEnvelope;
  safetyEmojis: [string, string, string, string];
  hexFingerprint: string;
}> {
  const {
    localUserId,
    chatId,
    peerUserId,
    plaintext,
    mediaCaption,
    ttlSeconds,
    remoteBundles,
    msgNum,
  } = params;

  const { identity, peerPublicKeyBase64, safetyEmojis, hexFingerprint } =
    await ensureSecretChatKeyMaterial({
      localUserId,
      chatId,
      peerUserId,
      remoteBundles,
    });

  const { aesKey, senderDhPublicBase64 } = await deriveSharedWebAesGcmKeyForIdentity(
    localUserId,
    identity,
    peerPublicKeyBase64,
  );

  const payloadObj: DecryptedSecretPayload = {
    text: plaintext,
    mediaCaption,
    ttlSeconds,
    sentAtMs: Date.now(),
    nonce: globalThis.crypto.randomUUID(),
  };

  const envelope = await encryptSecretMessage({
    aesKey,
    plaintext: JSON.stringify(payloadObj),
    senderUserId: localUserId,
    senderDeviceId: identity.deviceId,
    senderIdentityKey: senderDhPublicBase64,
    senderSigningKey: identity.signingPublicKeyBase64,
    recipientUserId: peerUserId,
    recipientDeviceId: 'web-primary',
    dhPub: senderDhPublicBase64,
    msgNum: msgNum ?? 1,
  });

  return { envelope, safetyEmojis, hexFingerprint };
}

/**
 * Decrypts an `EncryptedEnvelope` using WebCrypto `X25519` (or legacy `ECDH P-256`) +
 * `HKDF-SHA256` + `AES-256-GCM`.
 */
export async function decryptEnvelope(params: {
  localUserId: number;
  chatId: number;
  peerUserId: number;
  envelope: EncryptedEnvelope;
}): Promise<DecryptedSecretPayload> {
  const { localUserId, chatId, peerUserId, envelope } = params;
  const { identity, peerPublicKeyBase64 } = await ensureSecretChatKeyMaterial({
    localUserId,
    chatId,
    peerUserId,
  });

  const remoteKeyForDerivation =
    envelope.sender_user_id === localUserId
      ? peerPublicKeyBase64
      : envelope.sender_identity_key || peerPublicKeyBase64;

  const expectedRecipientId =
    envelope.sender_user_id === localUserId ? peerUserId : localUserId;

  const { aesKey } = await deriveSharedWebAesGcmKeyForIdentity(
    localUserId,
    identity,
    remoteKeyForDerivation,
  );
  const rawJson = await decryptSecretMessage(aesKey, envelope, expectedRecipientId);

  try {
    const parsed = JSON.parse(rawJson) as Partial<DecryptedSecretPayload>;
    if (typeof parsed.text === 'string') {
      return {
        text: parsed.text,
        mediaCaption: parsed.mediaCaption,
        ttlSeconds: parsed.ttlSeconds,
        sentAtMs: parsed.sentAtMs ?? Date.now(),
        nonce: parsed.nonce ?? '',
      };
    }
  } catch {
    // Plain UTF-8 string sent directly by protocol encryptSecretMessage
  }

  return {
    text: rawJson,
    sentAtMs: Date.now(),
    nonce: '',
  };
}

// ============================================================================
// Desktop-Interoperable X3DH, Double Ratchet & Group Sender Keys
// Matches `bhrumom/gpui-telegram` `crates/gpui_telegram_client/src/e2ee/*.rs`
// ============================================================================

export interface X3dhInitiatorResult {
  sharedSecret: Uint8Array;
  associatedData: Uint8Array;
  ephemeralPublicBase64: string;
  usedSignedPreKeyId: number;
  usedOneTimePreKeyId?: number;
}

export async function x3dhInitiatorDerive(params: {
  initiatorIdentityPrivateJwk: JsonWebKey;
  initiatorIdentityPublicBase64: string;
  responderBundle: DevicePreKeyBundle;
}): Promise<X3dhInitiatorResult> {
  const { initiatorIdentityPrivateJwk, initiatorIdentityPublicBase64, responderBundle } = params;

  // Verify responder's Ed25519 SPK signature strictly BEFORE computing any DH
  const sigOk = await verifyPreKeySignature(
    responderBundle.identity_signing_key,
    responderBundle.signed_prekey.public_key,
    responderBundle.signed_prekey.signature,
  );
  if (!sigOk) {
    throw new Error('X3DH responder signed prekey signature verification failed');
  }

  const ikAPriv = await importX25519PrivateKeyJwk(initiatorIdentityPrivateJwk);
  const ekA = await generateX25519KeyPair();

  const dh1 = await x25519Dh(ikAPriv, responderBundle.signed_prekey.public_key);
  const dh2 = await x25519Dh(ekA.privateKey, responderBundle.identity_key);
  const dh3 = await x25519Dh(ekA.privateKey, responderBundle.signed_prekey.public_key);
  const dhParts: Uint8Array[] = [new Uint8Array(32).fill(0xff), dh1, dh2, dh3];

  let usedOneTimePreKeyId: number | undefined;
  if (responderBundle.one_time_prekey?.public_key) {
    const dh4 = await x25519Dh(ekA.privateKey, responderBundle.one_time_prekey.public_key);
    dhParts.push(dh4);
    usedOneTimePreKeyId = responderBundle.one_time_prekey.key_id;
  }

  const ikm = concatBytes(...dhParts);
  const sharedSecret = await hkdfSha256Bytes(ikm, new Uint8Array(32), DESKTOP_X3DH_INFO, 32);
  ikm.fill(0);

  const ikAPubBytes = base64ToBytes(initiatorIdentityPublicBase64);
  const ikBPubBytes = base64ToBytes(responderBundle.identity_key);
  const associatedData = concatBytes(ikAPubBytes, ikBPubBytes);

  return {
    sharedSecret,
    associatedData,
    ephemeralPublicBase64: ekA.publicKeyBase64,
    usedSignedPreKeyId: responderBundle.signed_prekey.key_id,
    usedOneTimePreKeyId,
  };
}

export async function x3dhResponderDerive(params: {
  responderIdentityPrivateJwk: JsonWebKey;
  responderIdentityPublicBase64: string;
  responderSignedPreKeyPrivateJwk: JsonWebKey;
  responderOneTimePreKeyPrivateJwk?: JsonWebKey;
  initiatorIdentityPublicBase64: string;
  initiatorEphemeralPublicBase64: string;
}): Promise<{ sharedSecret: Uint8Array; associatedData: Uint8Array }> {
  const ikBPriv = await importX25519PrivateKeyJwk(params.responderIdentityPrivateJwk);
  const spkBPriv = await importX25519PrivateKeyJwk(params.responderSignedPreKeyPrivateJwk);

  const dh1 = await x25519Dh(spkBPriv, params.initiatorIdentityPublicBase64);
  const dh2 = await x25519Dh(ikBPriv, params.initiatorEphemeralPublicBase64);
  const dh3 = await x25519Dh(spkBPriv, params.initiatorEphemeralPublicBase64);
  const dhParts: Uint8Array[] = [new Uint8Array(32).fill(0xff), dh1, dh2, dh3];

  if (params.responderOneTimePreKeyPrivateJwk) {
    const opkBPriv = await importX25519PrivateKeyJwk(params.responderOneTimePreKeyPrivateJwk);
    const dh4 = await x25519Dh(opkBPriv, params.initiatorEphemeralPublicBase64);
    dhParts.push(dh4);
  }

  const ikm = concatBytes(...dhParts);
  const sharedSecret = await hkdfSha256Bytes(ikm, new Uint8Array(32), DESKTOP_X3DH_INFO, 32);
  ikm.fill(0);

  const ikAPubBytes = base64ToBytes(params.initiatorIdentityPublicBase64);
  const ikBPubBytes = base64ToBytes(params.responderIdentityPublicBase64);
  const associatedData = concatBytes(ikAPubBytes, ikBPubBytes);

  return { sharedSecret, associatedData };
}

interface RatchetMutableState {
  rootKey: Uint8Array;
  localDhPublicB64: string;
  localDhPrivateJwk: JsonWebKey;
  remoteDhPublicB64: string | null;
  sendingChainKey: Uint8Array | null;
  receivingChainKey: Uint8Array | null;
  sendMsgNum: number;
  recvMsgNum: number;
  prevSendChainLen: number;
  skippedKeys: Map<string, Uint8Array>;
  seenMessages: Set<string>;
  seenX3dhEks: string[];
}

function cloneRatchetState(s: RatchetMutableState): RatchetMutableState {
  const skippedCopy = new Map<string, Uint8Array>();
  for (const [k, v] of s.skippedKeys.entries()) {
    skippedCopy.set(k, new Uint8Array(v));
  }
  return {
    rootKey: new Uint8Array(s.rootKey),
    localDhPublicB64: s.localDhPublicB64,
    localDhPrivateJwk: { ...s.localDhPrivateJwk },
    remoteDhPublicB64: s.remoteDhPublicB64,
    sendingChainKey: s.sendingChainKey ? new Uint8Array(s.sendingChainKey) : null,
    receivingChainKey: s.receivingChainKey ? new Uint8Array(s.receivingChainKey) : null,
    sendMsgNum: s.sendMsgNum,
    recvMsgNum: s.recvMsgNum,
    prevSendChainLen: s.prevSendChainLen,
    skippedKeys: skippedCopy,
    seenMessages: new Set(s.seenMessages),
    seenX3dhEks: [...s.seenX3dhEks],
  };
}

async function kdfRatchetRoot(
  rootKey: Uint8Array,
  dhOut: Uint8Array,
): Promise<{ nextRootKey: Uint8Array; nextChainKey: Uint8Array }> {
  const derived = await hkdfSha256Bytes(dhOut, rootKey, DESKTOP_RATCHET_RK_INFO, 64);
  return {
    nextRootKey: derived.slice(0, 32),
    nextChainKey: derived.slice(32, 64),
  };
}

async function kdfRatchetChain(
  chainKey: Uint8Array,
): Promise<{ messageKey: Uint8Array; nextChainKey: Uint8Array }> {
  const [messageKey, nextChainKey] = await Promise.all([
    hmacSha256Bytes(chainKey, new Uint8Array([0x01])),
    hmacSha256Bytes(chainKey, new Uint8Array([0x02])),
  ]);
  return { messageKey, nextChainKey };
}

function buildRatchetNonce(msgNum: number): Uint8Array {
  const nonce = new Uint8Array(12);
  nonce.set(u32BeBytes(msgNum), 8);
  return nonce;
}

function buildRatchetAad(associatedData: Uint8Array, header: RatchetHeaderDto): Uint8Array {
  const dhPubBytes = base64ToBytes(header.dh_pub);
  return concatBytes(
    associatedData,
    dhPubBytes,
    u32BeBytes(header.prev_chain_len),
    u32BeBytes(header.msg_num),
  );
}

/**
 * Genuine Desktop-Interoperable Double Ratchet (`double_ratchet.rs:16-465`):
 * - `gpui-e2ee-rk-v1` HKDF-SHA256 root ratchet
 * - HMAC-SHA256 (`0x01` / `0x02`) symmetric chain ratchet
 * - ChaCha20-Poly1305 with deterministic nonce `[0;8] || u32_be(msg_num)` & header AAD
 * - Staged-clone AEAD verification (failed decrypt NEVER mutates session state)
 * - `MAX_SKIP=256`, `MAX_SKIPPED_STORAGE=2000`, `MAX_SEEN_X3DH_EKS=128`, replay rejection
 */
export class DesktopDoubleRatchetSession {
  private readonly associatedData: Uint8Array;
  private state: RatchetMutableState;

  private constructor(associatedData: Uint8Array, state: RatchetMutableState) {
    this.associatedData = new Uint8Array(associatedData);
    this.state = state;
  }

  static async initInitiator(
    sharedSecret32: Uint8Array,
    responderRatchetPublicBase64: string,
    associatedData64: Uint8Array,
  ): Promise<DesktopDoubleRatchetSession> {
    const localDh = await generateX25519KeyPair();
    const dhOut = await x25519Dh(localDh.privateKey, responderRatchetPublicBase64);
    const { nextRootKey, nextChainKey } = await kdfRatchetRoot(sharedSecret32, dhOut);
    dhOut.fill(0);
    return new DesktopDoubleRatchetSession(associatedData64, {
      rootKey: nextRootKey,
      localDhPublicB64: localDh.publicKeyBase64,
      localDhPrivateJwk: localDh.privateKeyJwk,
      remoteDhPublicB64: responderRatchetPublicBase64,
      sendingChainKey: nextChainKey,
      receivingChainKey: null,
      sendMsgNum: 0,
      recvMsgNum: 0,
      prevSendChainLen: 0,
      skippedKeys: new Map(),
      seenMessages: new Set(),
      seenX3dhEks: [],
    });
  }

  static initResponder(
    sharedSecret32: Uint8Array,
    responderRatchetPublicBase64: string,
    responderRatchetPrivateJwk: JsonWebKey,
    associatedData64: Uint8Array,
  ): DesktopDoubleRatchetSession {
    return new DesktopDoubleRatchetSession(associatedData64, {
      rootKey: new Uint8Array(sharedSecret32),
      localDhPublicB64: responderRatchetPublicBase64,
      localDhPrivateJwk: { ...responderRatchetPrivateJwk },
      remoteDhPublicB64: null,
      sendingChainKey: null,
      receivingChainKey: null,
      sendMsgNum: 0,
      recvMsgNum: 0,
      prevSendChainLen: 0,
      skippedKeys: new Map(),
      seenMessages: new Set(),
      seenX3dhEks: [],
    });
  }

  get skippedKeyCount(): number {
    return this.state.skippedKeys.size;
  }

  get sendMessageNumber(): number {
    return this.state.sendMsgNum;
  }

  get recvMessageNumber(): number {
    return this.state.recvMsgNum;
  }

  async encrypt(
    plaintext: Uint8Array | string,
  ): Promise<{ header: RatchetHeaderDto; ciphertextB64: string }> {
    if (!this.state.sendingChainKey) {
      throw new Error('Double Ratchet sending chain is not initialized yet');
    }
    const plainBytes = typeof plaintext === 'string' ? textEncoder.encode(plaintext) : plaintext;
    const { messageKey, nextChainKey } = await kdfRatchetChain(this.state.sendingChainKey);
    const header: RatchetHeaderDto = {
      dh_pub: this.state.localDhPublicB64,
      prev_chain_len: this.state.prevSendChainLen,
      msg_num: this.state.sendMsgNum,
    };
    const nonce = buildRatchetNonce(header.msg_num);
    const aad = buildRatchetAad(this.associatedData, header);
    const ctAndTag = chacha20Poly1305Encrypt(messageKey, nonce, plainBytes, aad);
    messageKey.fill(0);

    this.state.sendingChainKey = nextChainKey;
    this.state.sendMsgNum += 1;

    return {
      header,
      ciphertextB64: bytesToBase64(ctAndTag),
    };
  }

  async decrypt(
    header: RatchetHeaderDto,
    ciphertextB64: string,
    x3dhEphemeralKeyB64?: string,
  ): Promise<Uint8Array> {
    assertUint32(header.msg_num, 'Double Ratchet header.msg_num');
    assertUint32(header.prev_chain_len, 'Double Ratchet header.prev_chain_len');

    if (x3dhEphemeralKeyB64 && this.state.seenX3dhEks.includes(x3dhEphemeralKeyB64)) {
      throw new Error('Replayed X3DH ephemeral key rejected');
    }

    const msgKeyId = `${header.dh_pub}:${header.msg_num}`;
    if (this.state.seenMessages.has(msgKeyId)) {
      throw new Error(`Replayed Double Ratchet message rejected (${msgKeyId})`);
    }

    const ctAndTag = base64ToBytes(ciphertextB64);
    const nonce = buildRatchetNonce(header.msg_num);
    const aad = buildRatchetAad(this.associatedData, header);

    // Stage ALL state mutations on a deep clone; commit ONLY after ChaCha20-Poly1305 succeeds
    const staged = cloneRatchetState(this.state);
    let messageKey: Uint8Array;

    const existingSkipped = staged.skippedKeys.get(msgKeyId);
    if (existingSkipped) {
      messageKey = existingSkipped;
      staged.skippedKeys.delete(msgKeyId);
    } else {
      if (staged.remoteDhPublicB64 !== header.dh_pub) {
        if (staged.receivingChainKey && staged.remoteDhPublicB64) {
          await this.skipMessageKeysOnStaged(staged, header.prev_chain_len);
        }
        await this.dhRatchetStepOnStaged(staged, header.dh_pub);
      }
      await this.skipMessageKeysOnStaged(staged, header.msg_num);

      if (!staged.receivingChainKey) {
        throw new Error('Double Ratchet receiving chain not initialized');
      }
      const step = await kdfRatchetChain(staged.receivingChainKey);
      messageKey = step.messageKey;
      staged.receivingChainKey = step.nextChainKey;
      staged.recvMsgNum += 1;
    }

    const plaintext = chacha20Poly1305Decrypt(messageKey, nonce, ctAndTag, aad);
    messageKey.fill(0);

    // Commit staged state atomically AFTER authentication succeeds
    staged.seenMessages.add(msgKeyId);
    if (x3dhEphemeralKeyB64) {
      staged.seenX3dhEks.push(x3dhEphemeralKeyB64);
      if (staged.seenX3dhEks.length > RATCHET_MAX_SEEN_X3DH_EKS) {
        staged.seenX3dhEks.shift();
      }
    }
    this.state = staged;
    return plaintext;
  }

  private async skipMessageKeysOnStaged(
    staged: RatchetMutableState,
    untilMsgNum: number,
  ): Promise<void> {
    if (!staged.receivingChainKey || !staged.remoteDhPublicB64) return;
    if (untilMsgNum < staged.recvMsgNum) {
      throw new Error(`Out-of-order message number ${untilMsgNum} behind ${staged.recvMsgNum}`);
    }
    const skipCount = untilMsgNum - staged.recvMsgNum;
    if (skipCount > RATCHET_MAX_SKIP) {
      throw new Error(`Exceeded Double Ratchet MAX_SKIP (${RATCHET_MAX_SKIP})`);
    }
    while (staged.recvMsgNum < untilMsgNum) {
      if (staged.skippedKeys.size >= RATCHET_MAX_SKIPPED_STORAGE) {
        const oldestKey = staged.skippedKeys.keys().next().value;
        if (oldestKey !== undefined) {
          staged.skippedKeys.delete(oldestKey);
        }
      }
      const { messageKey, nextChainKey } = await kdfRatchetChain(staged.receivingChainKey);
      staged.skippedKeys.set(`${staged.remoteDhPublicB64}:${staged.recvMsgNum}`, messageKey);
      staged.receivingChainKey = nextChainKey;
      staged.recvMsgNum += 1;
    }
  }

  private async dhRatchetStepOnStaged(
    staged: RatchetMutableState,
    newRemoteDhPubB64: string,
  ): Promise<void> {
    staged.prevSendChainLen = staged.sendMsgNum;
    staged.sendMsgNum = 0;
    staged.recvMsgNum = 0;
    staged.remoteDhPublicB64 = newRemoteDhPubB64;

    const currentPriv = await importX25519PrivateKeyJwk(staged.localDhPrivateJwk);
    const dhRecv = await x25519Dh(currentPriv, newRemoteDhPubB64);
    const recvStep = await kdfRatchetRoot(staged.rootKey, dhRecv);
    dhRecv.fill(0);
    staged.rootKey = recvStep.nextRootKey;
    staged.receivingChainKey = recvStep.nextChainKey;

    const nextLocalDh = await generateX25519KeyPair();
    staged.localDhPublicB64 = nextLocalDh.publicKeyBase64;
    staged.localDhPrivateJwk = nextLocalDh.privateKeyJwk;

    const dhSend = await x25519Dh(nextLocalDh.privateKey, newRemoteDhPubB64);
    const sendStep = await kdfRatchetRoot(staged.rootKey, dhSend);
    dhSend.fill(0);
    staged.rootKey = sendStep.nextRootKey;
    staged.sendingChainKey = sendStep.nextChainKey;
  }
}

interface SenderKeyMutableState {
  chainKey: Uint8Array;
  iteration: number;
  skippedKeys: Map<number, Uint8Array>;
  seenIterations: Set<number>;
}

/**
 * Genuine Desktop-Interoperable Group Sender Keys (`sender_keys.rs:15-290`):
 * - `mk = HMAC-SHA256(ck, "msg" || u32_be(iter))`, `nextCk = HMAC-SHA256(ck, "chain")`
 * - ChaCha20-Poly1305 with nonce `[0;8] || u32_be(iter)` & exact desktop AAD
 * - Ed25519 signature over `"gpui-e2ee-sk-v1" || i64_be(chat_id) || u32_be(chain_id) || u32_be(iter) || ct_and_tag`
 */
export class DesktopSenderKeyState {
  readonly chatId: number;
  readonly senderUserId: number;
  readonly senderDeviceId: string;
  readonly chainId: number;
  readonly signingPublicKeyBase64: string;
  private readonly signingPrivateKeyJwk?: JsonWebKey;
  private state: SenderKeyMutableState;

  private constructor(params: {
    chatId: number;
    senderUserId: number;
    senderDeviceId: string;
    chainId: number;
    chainKey: Uint8Array;
    iteration: number;
    signingPublicKeyBase64: string;
    signingPrivateKeyJwk?: JsonWebKey;
  }) {
    this.chatId = params.chatId;
    this.senderUserId = params.senderUserId;
    this.senderDeviceId = params.senderDeviceId;
    this.chainId = params.chainId;
    this.signingPublicKeyBase64 = params.signingPublicKeyBase64;
    this.signingPrivateKeyJwk = params.signingPrivateKeyJwk;
    this.state = {
      chainKey: new Uint8Array(params.chainKey),
      iteration: params.iteration,
      skippedKeys: new Map(),
      seenIterations: new Set(),
    };
  }

  static createSender(params: {
    chatId: number;
    senderUserId: number;
    senderDeviceId: string;
    signingPublicKeyBase64: string;
    signingPrivateKeyJwk: JsonWebKey;
    chainId?: number;
  }): DesktopSenderKeyState {
    const chainKey = new Uint8Array(32);
    crypto.getRandomValues(chainKey);
    const randChainBuf = new Uint32Array(1);
    crypto.getRandomValues(randChainBuf);
    return new DesktopSenderKeyState({
      chatId: params.chatId,
      senderUserId: params.senderUserId,
      senderDeviceId: params.senderDeviceId,
      chainId: params.chainId ?? ((randChainBuf[0] ?? 1) >>> 0),
      chainKey,
      iteration: 0,
      signingPublicKeyBase64: params.signingPublicKeyBase64,
      signingPrivateKeyJwk: params.signingPrivateKeyJwk,
    });
  }

  static fromDistribution(dist: SenderKeyDistributionMessage): DesktopSenderKeyState {
    assertUint32(dist.iteration, 'distribution.iteration');
    assertUint32(dist.chain_id, 'distribution.chain_id');
    const chainKey = base64ToBytes(dist.chain_key);
    if (chainKey.byteLength !== 32) {
      throw new Error(`Invalid sender chain key length: ${chainKey.byteLength}`);
    }
    return new DesktopSenderKeyState({
      chatId: dist.chat_id,
      senderUserId: dist.sender_user_id,
      senderDeviceId: dist.sender_device_id,
      chainId: dist.chain_id,
      chainKey,
      iteration: dist.iteration,
      signingPublicKeyBase64: dist.signing_public_key,
    });
  }

  toDistributionMessage(): SenderKeyDistributionMessage {
    return {
      chat_id: this.chatId,
      sender_user_id: this.senderUserId,
      sender_device_id: this.senderDeviceId,
      chain_id: this.chainId,
      iteration: this.state.iteration,
      chain_key: bytesToBase64(this.state.chainKey),
      signing_public_key: this.signingPublicKeyBase64,
    };
  }

  private buildAad(iteration: number): Uint8Array {
    return concatBytes(
      i64BeBytes(this.chatId),
      u32BeBytes(this.chainId),
      u32BeBytes(iteration),
      u64BeBytes(this.senderUserId),
      textEncoder.encode(this.senderDeviceId),
    );
  }

  private buildSigningPayload(iteration: number, ctAndTag: Uint8Array): Uint8Array {
    return concatBytes(
      textEncoder.encode(DESKTOP_SENDER_KEY_SIGN_DOMAIN),
      i64BeBytes(this.chatId),
      u32BeBytes(this.chainId),
      u32BeBytes(iteration),
      ctAndTag,
    );
  }

  private async stepChain(
    ck: Uint8Array,
    iteration: number,
  ): Promise<{ messageKey: Uint8Array; nextChainKey: Uint8Array }> {
    const [messageKey, nextChainKey] = await Promise.all([
      hmacSha256Bytes(ck, concatBytes(textEncoder.encode('msg'), u32BeBytes(iteration))),
      hmacSha256Bytes(ck, textEncoder.encode('chain')),
    ]);
    return { messageKey, nextChainKey };
  }

  async encrypt(plaintext: Uint8Array | string): Promise<GroupCiphertext> {
    if (!this.signingPrivateKeyJwk) {
      throw new Error('Cannot encrypt with receiver-only DesktopSenderKeyState');
    }
    const plainBytes = typeof plaintext === 'string' ? textEncoder.encode(plaintext) : plaintext;
    const iter = this.state.iteration;
    const { messageKey, nextChainKey } = await this.stepChain(this.state.chainKey, iter);

    const nonce = buildRatchetNonce(iter);
    const aad = this.buildAad(iter);
    const ctAndTag = chacha20Poly1305Encrypt(messageKey, nonce, plainBytes, aad);
    messageKey.fill(0);

    const subtle = getSubtle();
    const privKey = await importEd25519PrivateKeyJwk(this.signingPrivateKeyJwk);
    const sigPayload = this.buildSigningPayload(iter, ctAndTag);
    const sig = new Uint8Array(
      await subtle.sign({ name: 'Ed25519' } as AlgorithmIdentifier, privKey, toArrayBuffer(sigPayload)),
    );

    this.state.chainKey = nextChainKey;
    this.state.iteration = iter + 1;

    return {
      chat_id: this.chatId,
      chain_id: this.chainId,
      iteration: iter,
      ciphertext: bytesToBase64(ctAndTag),
      signature: bytesToBase64(sig),
    };
  }

  async decrypt(groupCt: GroupCiphertext): Promise<Uint8Array> {
    assertUint32(groupCt.iteration, 'GroupSenderKey iteration');
    assertUint32(groupCt.chain_id, 'GroupSenderKey chain_id');

    if (groupCt.chat_id !== this.chatId || groupCt.chain_id !== this.chainId) {
      throw new Error('GroupCiphertext chat_id or chain_id mismatch');
    }
    if (this.state.seenIterations.has(groupCt.iteration)) {
      throw new Error(`Replayed GroupSenderKey iteration ${groupCt.iteration}`);
    }

    const ctAndTag = base64ToBytes(groupCt.ciphertext);
    const sigBytes = base64ToBytes(groupCt.signature);

    // Verify Ed25519 signature strictly BEFORE decrypting or mutating chain state
    const subtle = getSubtle();
    const pubKey = await importEd25519PublicKeyBase64(this.signingPublicKeyBase64);
    const sigPayload = this.buildSigningPayload(groupCt.iteration, ctAndTag);
    const sigValid = await subtle.verify(
      { name: 'Ed25519' } as AlgorithmIdentifier,
      pubKey,
      toArrayBuffer(sigBytes),
      toArrayBuffer(sigPayload),
    );
    if (!sigValid) {
      throw new Error('GroupSenderKey Ed25519 signature verification failed');
    }

    const stagedSkipped = new Map<number, Uint8Array>();
    for (const [k, v] of this.state.skippedKeys.entries()) {
      stagedSkipped.set(k, new Uint8Array(v));
    }
    let stagedCk: Uint8Array = new Uint8Array(this.state.chainKey);
    let stagedIter = this.state.iteration;

    let messageKey: Uint8Array;
    const savedSkipped = stagedSkipped.get(groupCt.iteration);
    if (savedSkipped) {
      messageKey = savedSkipped;
      stagedSkipped.delete(groupCt.iteration);
    } else {
      if (groupCt.iteration < stagedIter) {
        throw new Error(`Sender key iteration ${groupCt.iteration} already passed (${stagedIter})`);
      }
      const skipCount = groupCt.iteration - stagedIter;
      if (skipCount > RATCHET_MAX_SKIP) {
        throw new Error(`Exceeded GroupSenderKey MAX_SKIP (${RATCHET_MAX_SKIP})`);
      }
      while (stagedIter < groupCt.iteration) {
        if (stagedSkipped.size >= RATCHET_MAX_SKIPPED_STORAGE) {
          const oldest = stagedSkipped.keys().next().value;
          if (oldest !== undefined) stagedSkipped.delete(oldest);
        }
        const step = await this.stepChain(stagedCk, stagedIter);
        stagedSkipped.set(stagedIter, step.messageKey);
        stagedCk = step.nextChainKey;
        stagedIter += 1;
      }
      const step = await this.stepChain(stagedCk, stagedIter);
      messageKey = step.messageKey;
      stagedCk = step.nextChainKey;
      stagedIter += 1;
    }

    const nonce = buildRatchetNonce(groupCt.iteration);
    const aad = this.buildAad(groupCt.iteration);
    const plaintext = chacha20Poly1305Decrypt(messageKey, nonce, ctAndTag, aad);
    messageKey.fill(0);

    // Commit staged state AFTER AEAD succeeds
    const nextSeen = new Set(this.state.seenIterations);
    nextSeen.add(groupCt.iteration);
    this.state = {
      chainKey: stagedCk,
      iteration: stagedIter,
      skippedKeys: stagedSkipped,
      seenIterations: nextSeen,
    };
    return plaintext;
  }
}

export {
  E2EE_SAFETY_EMOJIS,
  computeSafetyNumberEmojis,
  decryptSecretMessage,
  deriveSharedAesGcmKey,
  encryptSecretMessage,
  exportPublicKeyBase64,
  generateE2eeIdentity,
  generateEcdhKeyPair,
  importEcdhPrivateKeyJwk,
  importEcdhPublicKeyBase64,
  importEcdhPublicKeyJwk,
  signPreKeyPublic,
};
