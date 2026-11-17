/**
 * Cross-Runtime WebCrypto E2EE Helpers (`ECDH P-256 + HKDF-SHA256 + AES-256-GCM`)
 * & 4-Emoji Key Verification Safety Fingerprint.
 *
 * Uses standard `globalThis.crypto.subtle` identically in Node.js 24 and browsers.
 */

import { base64ToBytes, bytesToBase64 } from './waveform.js';

export const E2EE_SAFETY_EMOJIS = [
  '🔐', '🛡️', '🗝️', '🦊', '🐋', '🦉', '🐢', '🐬',
  '🦅', '🐝', '🌵', '🌻', '🍄', '🌊', '🔥', '❄️',
  '⚡', '🌙', '⭐', '💎', '🧭', '⚓', '🎯', '🧩',
  '🎻', '🚀', '🛸', '🏔️', '🌋', '🍀', '🍁', '🪷',
] as const;

export const E2EE_HKDF_INFO = 'gpui-telegram-web-e2ee-v1';
export const E2EE_SPK_SIGN_DOMAIN = 'gpui-telegram-x3dh-spk-v1';
export const E2EE_SAFETY_DOMAIN = 'gpui-e2ee-safety-v1';

export interface SignedPreKeyDto {
  key_id: number;
  public_key: string;
  signature: string;
  created_at_ms: number;
}

export interface OneTimePreKeyDto {
  key_id: number;
  public_key: string;
}

export interface PublishPreKeysRequest {
  device_id: string;
  device_name?: string;
  identity_key: string;
  identity_signing_key: string;
  signed_prekey: SignedPreKeyDto;
  one_time_prekeys: OneTimePreKeyDto[];
}

export interface PublishPreKeysResponse {
  success: boolean;
  user_id: number;
  device_id: string;
  remaining_one_time_prekeys: number;
  updated_at_ms: number;
}

export interface DevicePreKeyBundle {
  user_id: number;
  device_id: string;
  device_name?: string;
  identity_key: string;
  identity_signing_key: string;
  signed_prekey: SignedPreKeyDto;
  one_time_prekey?: OneTimePreKeyDto;
}

export interface UserPreKeyBundlesResponse {
  user_id: number;
  devices: DevicePreKeyBundle[];
}

export interface PreKeyCountResponse {
  user_id: number;
  device_id: string;
  remaining_one_time_prekeys: number;
  has_signed_prekey: boolean;
}

export interface RatchetHeaderDto {
  dh_pub: string;
  prev_chain_len: number;
  msg_num: number;
}

export interface PerDeviceCiphertext {
  recipient_user_id: number;
  recipient_device_id: string;
  ephemeral_key?: string;
  used_signed_prekey_id?: number;
  used_one_time_prekey_id?: number;
  header: RatchetHeaderDto;
  ciphertext: string; // base64(iv_12_bytes || aes_gcm_ciphertext_and_tag)
}

export interface SenderKeyDistributionMessage {
  chat_id: number;
  sender_user_id: number;
  sender_device_id: string;
  chain_id: number;
  iteration: number;
  chain_key: string;
  signing_public_key: string;
}

export interface GroupCiphertext {
  chat_id: number;
  chain_id: number;
  iteration: number;
  ciphertext: string;
  signature: string;
}

export type EncryptedPayloadKind =
  | { kind: 'PairwiseFanout'; payload: { recipients: PerDeviceCiphertext[] } }
  | { kind: 'SenderKeyDistribution'; payload: { recipients: PerDeviceCiphertext[] } }
  | { kind: 'GroupSenderKey'; payload: GroupCiphertext };

export interface EncryptedEnvelope {
  version: number;
  sender_user_id: number;
  sender_device_id: string;
  sender_identity_key: string;
  sender_signing_key: string;
  kind: EncryptedPayloadKind;
}

export interface E2eeKeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicKeyBase64: string;
  publicKeyJwk: JsonWebKey;
  privateKeyJwk: JsonWebKey;
}

export interface E2eeDeviceIdentity {
  deviceId: string;
  dhKeyPair: E2eeKeyPair;
  signingKeyPair: E2eeKeyPair;
}

function getSubtle(): SubtleCrypto {
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj || !cryptoObj.subtle) {
    throw new Error('WebCrypto SubtleCrypto is unavailable in this runtime');
  }
  return cryptoObj.subtle;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function compareBytesLexicographically(a: Uint8Array, b: Uint8Array): number {
  const minLen = Math.min(a.length, b.length);
  for (let i = 0; i < minLen; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

/**
 * Generates an extractable ECDH P-256 keypair with both raw base64 (65-byte uncompressed point)
 * and JWK representations.
 */
export async function generateEcdhKeyPair(): Promise<E2eeKeyPair> {
  const subtle = getSubtle();
  const pair = await subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits', 'deriveKey'],
  );
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

/**
 * Generates an extractable ECDSA P-256 signing keypair for X3DH signed prekeys.
 */
export async function generateEcdsaSigningKeyPair(): Promise<E2eeKeyPair> {
  const subtle = getSubtle();
  const pair = await subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
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

export async function generateE2eeIdentity(deviceId = 'web-primary'): Promise<E2eeDeviceIdentity> {
  const [dhKeyPair, signingKeyPair] = await Promise.all([
    generateEcdhKeyPair(),
    generateEcdsaSigningKeyPair(),
  ]);
  return {
    deviceId,
    dhKeyPair,
    signingKeyPair,
  };
}

export async function importEcdhPublicKeyBase64(pubBase64: string): Promise<CryptoKey> {
  const subtle = getSubtle();
  const bytes = base64ToBytes(pubBase64);
  return subtle.importKey(
    'raw',
    toArrayBuffer(bytes),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  );
}

export async function importEcdhPublicKeyJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  const subtle = getSubtle();
  return subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  );
}

export async function importEcdhPrivateKeyJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  const subtle = getSubtle();
  return subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits', 'deriveKey'],
  );
}

export async function exportPublicKeyBase64(publicKey: CryptoKey): Promise<string> {
  const subtle = getSubtle();
  const raw = new Uint8Array(await subtle.exportKey('raw', publicKey));
  return bytesToBase64(raw);
}

/**
 * Signs a signed-prekey public key using ECDSA P-256 + SHA-256.
 */
export async function signPreKeyPublic(
  signingPrivateKey: CryptoKey,
  preKeyPublicBase64: string,
): Promise<string> {
  const subtle = getSubtle();
  const prefix = new TextEncoder().encode(E2EE_SPK_SIGN_DOMAIN);
  const pubBytes = base64ToBytes(preKeyPublicBase64);
  const msg = new Uint8Array(prefix.length + pubBytes.length);
  msg.set(prefix, 0);
  msg.set(pubBytes, prefix.length);

  const sig = new Uint8Array(
    await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingPrivateKey, toArrayBuffer(msg)),
  );
  return bytesToBase64(sig);
}

export async function verifyPreKeySignature(
  signingPublicBase64: string,
  preKeyPublicBase64: string,
  signatureBase64: string,
): Promise<boolean> {
  try {
    const subtle = getSubtle();
    const pubKey = await subtle.importKey(
      'raw',
      toArrayBuffer(base64ToBytes(signingPublicBase64)),
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['verify'],
    );
    const prefix = new TextEncoder().encode(E2EE_SPK_SIGN_DOMAIN);
    const pubBytes = base64ToBytes(preKeyPublicBase64);
    const msg = new Uint8Array(prefix.length + pubBytes.length);
    msg.set(prefix, 0);
    msg.set(pubBytes, prefix.length);

    return await subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pubKey,
      toArrayBuffer(base64ToBytes(signatureBase64)),
      toArrayBuffer(msg),
    );
  } catch {
    return false;
  }
}

/**
 * Derives a shared 256-bit `AES-GCM` CryptoKey via `ECDH P-256` + `HKDF-SHA256`.
 */
export async function deriveSharedAesGcmKey(
  localPrivateKey: CryptoKey,
  remotePublicKey: CryptoKey | string,
  options: { salt?: Uint8Array; info?: string } = {},
): Promise<CryptoKey> {
  const subtle = getSubtle();
  const resolvedRemotePub =
    typeof remotePublicKey === 'string'
      ? await importEcdhPublicKeyBase64(remotePublicKey)
      : remotePublicKey;

  const sharedBits = await subtle.deriveBits(
    { name: 'ECDH', public: resolvedRemotePub },
    localPrivateKey,
    256,
  );

  const hkdfKey = await subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  const saltBytes = options.salt ?? new Uint8Array(32);
  const infoBytes = new TextEncoder().encode(options.info ?? E2EE_HKDF_INFO);

  return subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toArrayBuffer(saltBytes),
      info: toArrayBuffer(infoBytes),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Computes the canonical 4-emoji verification safety fingerprint from two identity public keys
 * (`SHA-256("gpui-e2ee-safety-v1" || sortedKeyA || sortedKeyB)` mapped into `E2EE_SAFETY_EMOJIS`).
 * Order-independent: Alice(A, B) === Bob(B, A).
 */
export async function computeSafetyNumberEmojis(
  keyA: Uint8Array | string,
  keyB: Uint8Array | string,
): Promise<{ emojis: [string, string, string, string]; text: string; hexFingerprint: string }> {
  const subtle = getSubtle();
  const bytesA = typeof keyA === 'string' ? base64ToBytes(keyA) : keyA;
  const bytesB = typeof keyB === 'string' ? base64ToBytes(keyB) : keyB;

  const [first, second] =
    compareBytesLexicographically(bytesA, bytesB) <= 0 ? [bytesA, bytesB] : [bytesB, bytesA];

  const domainBytes = new TextEncoder().encode(E2EE_SAFETY_DOMAIN);
  const concat = new Uint8Array(domainBytes.length + first.length + second.length);
  concat.set(domainBytes, 0);
  concat.set(first, domainBytes.length);
  concat.set(second, domainBytes.length + first.length);

  const digest = new Uint8Array(await subtle.digest('SHA-256', toArrayBuffer(concat)));
  const e0 = E2EE_SAFETY_EMOJIS[(digest[0] ?? 0) % 32]!;
  const e1 = E2EE_SAFETY_EMOJIS[(digest[1] ?? 0) % 32]!;
  const e2 = E2EE_SAFETY_EMOJIS[(digest[2] ?? 0) % 32]!;
  const e3 = E2EE_SAFETY_EMOJIS[(digest[3] ?? 0) % 32]!;
  const emojis: [string, string, string, string] = [e0, e1, e2, e3];

  let hexFingerprint = '';
  for (let i = 0; i < 16; i++) {
    hexFingerprint += (digest[i] ?? 0).toString(16).padStart(2, '0');
  }

  return {
    emojis,
    text: emojis.join(' '),
    hexFingerprint,
  };
}

export interface SecretMessageEncryptParams {
  aesKey: CryptoKey;
  plaintext: string;
  senderUserId: number;
  senderDeviceId?: string;
  senderIdentityKey: string;
  senderSigningKey?: string;
  recipientUserId: number;
  recipientDeviceId?: string;
  dhPub?: string;
  msgNum?: number;
  prevChainLen?: number;
}

function buildAdditionalData(
  senderUserId: number,
  recipientUserId: number,
  msgNum: number,
): Uint8Array {
  return new TextEncoder().encode(`gpui-e2ee-aad-v1:${senderUserId}:${recipientUserId}:${msgNum}`);
}

/**
 * Encrypts a UTF-8 plaintext into an `EncryptedEnvelope` using `AES-256-GCM` with a random 12-byte IV
 * and authenticated additional data (`senderUserId`, `recipientUserId`, `msgNum`).
 */
export async function encryptSecretMessage(
  params: SecretMessageEncryptParams,
): Promise<EncryptedEnvelope> {
  const subtle = getSubtle();
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);

  const msgNum = params.msgNum ?? 1;
  const aad = buildAdditionalData(params.senderUserId, params.recipientUserId, msgNum);
  const plainBytes = new TextEncoder().encode(params.plaintext);

  const cipherBuf = await subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(iv),
      additionalData: toArrayBuffer(aad),
      tagLength: 128,
    },
    params.aesKey,
    toArrayBuffer(plainBytes),
  );

  const cipherBytes = new Uint8Array(cipherBuf);
  const packed = new Uint8Array(iv.length + cipherBytes.length);
  packed.set(iv, 0);
  packed.set(cipherBytes, iv.length);

  return {
    version: 1,
    sender_user_id: params.senderUserId,
    sender_device_id: params.senderDeviceId ?? 'web-primary',
    sender_identity_key: params.senderIdentityKey,
    sender_signing_key: params.senderSigningKey ?? params.senderIdentityKey,
    kind: {
      kind: 'PairwiseFanout',
      payload: {
        recipients: [
          {
            recipient_user_id: params.recipientUserId,
            recipient_device_id: params.recipientDeviceId ?? 'web-primary',
            header: {
              dh_pub: params.dhPub ?? params.senderIdentityKey,
              prev_chain_len: params.prevChainLen ?? 0,
              msg_num: msgNum,
            },
            ciphertext: bytesToBase64(packed),
          },
        ],
      },
    },
  };
}

/**
 * Decrypts and authenticates an `EncryptedEnvelope` using `AES-256-GCM`.
 * Rejects tampered ciphertexts, IVs, tags, or mismatched AAD metadata cleanly by throwing.
 */
export async function decryptSecretMessage(
  aesKey: CryptoKey,
  envelope: EncryptedEnvelope,
  recipientUserId: number,
  recipientDeviceId?: string,
): Promise<string> {
  const subtle = getSubtle();
  if (envelope.kind.kind !== 'PairwiseFanout' && envelope.kind.kind !== 'SenderKeyDistribution') {
    throw new Error(`Unsupported envelope payload kind: ${envelope.kind.kind}`);
  }

  const target = envelope.kind.payload.recipients.find(
    (r) =>
      r.recipient_user_id === recipientUserId &&
      (recipientDeviceId === undefined || r.recipient_device_id === recipientDeviceId),
  );
  if (!target) {
    throw new Error(`No ciphertext found for recipient ${recipientUserId}`);
  }

  const packed = base64ToBytes(target.ciphertext);
  if (packed.length < 12 + 16) {
    throw new Error('Malformed E2EE ciphertext: shorter than IV + GCM tag');
  }

  const iv = packed.subarray(0, 12);
  const ciphertextAndTag = packed.subarray(12);
  const aad = buildAdditionalData(
    envelope.sender_user_id,
    target.recipient_user_id,
    target.header.msg_num,
  );

  const plainBuf = await subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(iv),
      additionalData: toArrayBuffer(aad),
      tagLength: 128,
    },
    aesKey,
    toArrayBuffer(ciphertextAndTag),
  );

  return new TextDecoder().decode(plainBuf);
}
