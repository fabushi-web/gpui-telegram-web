import {
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
  verifyPreKeySignature,
  type DevicePreKeyBundle,
  type E2eeDeviceIdentity,
  type EncryptedEnvelope,
  type PublishPreKeysRequest,
} from '@gpui-telegram/protocol';

const E2EE_IDENTITY_STORAGE_PREFIX = 'gpui_tg_e2ee_identity_v2:';
const E2EE_CHAT_PEER_KEY_PREFIX = 'gpui_tg_e2ee_peer_pub_v2:';

export interface PersistedE2eeIdentityRecord {
  deviceId: string;
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

/**
 * Loads or generates a persistent WebCrypto ECDH P-256 + ECDSA P-256 identity + prekey bundle
 * for the given account (`userId`).
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
        identityMemoryCache.set(cacheKey, parsed);
        return parsed;
      }
    } catch {
      // Regenerate below
    }
  }

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

  const record: PersistedE2eeIdentityRecord = {
    deviceId,
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

  const validBundle = remoteBundles?.find((b) =>
    Boolean(b.identity_key || b.signed_prekey?.public_key),
  );
  if (validBundle) {
    peerPublicKeyBase64 = validBundle.identity_key || validBundle.signed_prekey.public_key;
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

/**
 * Encrypts a Secret Chat message using real WebCrypto ECDH P-256 + HKDF-SHA256 + AES-256-GCM.
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

  const localPrivKey = await importEcdhPrivateKeyJwk(identity.dhPrivateKeyJwk);
  const aesKey = await deriveSharedAesGcmKey(localPrivKey, peerPublicKeyBase64);

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
    senderIdentityKey: identity.dhPublicKeyBase64,
    senderSigningKey: identity.signingPublicKeyBase64,
    recipientUserId: peerUserId,
    recipientDeviceId: 'web-primary',
    dhPub: identity.dhPublicKeyBase64,
    msgNum: msgNum ?? 1,
  });

  return { envelope, safetyEmojis, hexFingerprint };
}

/**
 * Decrypts an `EncryptedEnvelope` using WebCrypto ECDH P-256 + HKDF-SHA256 + AES-256-GCM.
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

  const localPrivKey = await importEcdhPrivateKeyJwk(identity.dhPrivateKeyJwk);

  // Outgoing envelope sent by our own account -> derive shared key with peerPublicKeyBase64
  const remoteKeyForDerivation =
    envelope.sender_user_id === localUserId
      ? peerPublicKeyBase64
      : envelope.sender_identity_key || peerPublicKeyBase64;

  const expectedRecipientId =
    envelope.sender_user_id === localUserId ? peerUserId : localUserId;

  const aesKey = await deriveSharedAesGcmKey(localPrivKey, remoteKeyForDerivation);
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
  verifyPreKeySignature,
};
