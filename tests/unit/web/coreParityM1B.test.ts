import crypto from 'node:crypto';
import fs from 'node:fs';
import { WebSocketServer } from 'ws';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTelegramServer, type TelegramServerInstance } from '@gpui-telegram/server';
import type { ChatSummary, MessageItem, TelegramClientPort, UpdateEvent } from '@gpui-telegram/protocol';
import {
  ALL_STORES,
  IDB_VERSION,
  IndexedDbCacheService,
  indexedDbCache,
} from '../../../apps/web/src/adapters/indexedDbCache';
import { HttpWsServerAdapter } from '../../../apps/web/src/adapters/httpWsServerAdapter';
import { getServerAdapter } from '../../../apps/web/src/adapters';
import {
  DesktopDoubleRatchetSession,
  DesktopSenderKeyState,
  clearE2eeCacheForAccount,
  decryptEnvelope,
  encryptEnvelope,
  generateEd25519KeyPair,
  generateIdentityKeyPair,
  toPublishPreKeysRequest,
  verifyPreKeySignature,
  x3dhInitiatorDerive,
  x3dhResponderDerive,
} from '../../../apps/web/src/services/e2eeClient';
import {
  argon2idDerive,
  base64ToBytes,
  blake2b,
  buildVaultItemAad,
  bytesToBase64,
  chacha20Poly1305Decrypt,
  chacha20Poly1305Encrypt,
  decryptVaultItem,
  deriveSplitKeyV2,
  deriveSplitKeyV2Argon2id,
  deriveVaultItemSubkey,
  encryptVaultItem,
  formatEmergencyKitKey,
  generateDeviceSyncKeyPair,
  generateVaultRootKey,
  parseRecoveryKey,
  sealRootKeyForDevice,
  unsealRootKeyFromApprover,
  unwrapRecoveryRootKey,
  unwrapVaultRootKey,
  wrapRecoveryRootKey,
  wrapVaultRootKey,
} from '../../../apps/web/src/services/splitKeyCrypto';
import {
  TOP_PREFETCH_DIALOG_LIMIT,
  clearFrame0Snapshot,
  readFrame0Snapshot,
  setTopPrefetchDelayMsForTest,
  subscribeRealtimeDomainEvent,
  useAuthStore,
  useChatStore,
  useSettingsStore,
  useUiStore,
  writeFrame0Snapshot,
} from '../../../apps/web/src/store';
import {
  CONNECTING_BANNER_GRACE_MS,
  allowsMiniAppIframeFocus,
  coalesceAdminLogDeletes,
  computeBt601Luma,
  ensureWhiteTextContrast,
  evaluateConnectionBannerVisibility,
  parseInlineBotQueryInput,
} from '../../../apps/web/src/utils/coreParityM1B';
import { apiJson, createUniqueTestDir, registerTestUser } from '../server/_helpers.js';

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (idx: number) => Array.from(map.keys())[idx] ?? null,
    removeItem: (k: string) => {
      map.delete(k);
    },
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
  };
}

function makeFakeChat(chatId: number, overrides: Partial<ChatSummary> = {}): ChatSummary {
  return {
    chatId,
    chatType: 0,
    creatorId: 1,
    colorIndex: chatId % 7,
    pts: 1,
    title: `Chat ${chatId}`,
    kind: 'private',
    peerUserId: 1000 + chatId,
    unreadCount: 0,
    unreadMentionsCount: 0,
    unreadReactionsCount: 0,
    isPinned: false,
    isMuted: false,
    isArchived: false,
    isBot: false,
    isSecret: false,
    isGroup: false,
    isSupergroup: false,
    isChannel: false,
    isForum: false,
    isSavedMessages: false,
    lastMessageId: 1,
    lastMessageDateMs: 1_700_000_000_000 + chatId * 1000,
    lastMessagePreview: `Hello ${chatId}`,
    readInboxMaxId: 0,
    readOutboxMaxId: 0,
    memberCount: 2,
    pinnedMessageIds: [],
    ...overrides,
  };
}

function makeFakeMessage(chatId: number, id: number, text = `msg-${id}`): MessageItem {
  return {
    id,
    chat_id: chatId,
    peer_id: { Chat: chatId },
    to_peer: { Chat: chatId },
    sender_id: 200,
    flags: {
      is_out: false,
      is_pinned: false,
      is_silent: false,
      is_edited: false,
      is_scheduled: false,
      media_unread: false,
      has_reactions: false,
      no_forwards: false,
      is_forwarded: false,
    },
    date: new Date(1_700_000_000_000 + id * 1000).toISOString(),
    date_ms: 1_700_000_000_000 + id * 1000,
    text,
    entities: [],
    content: { type: 'Text', data: { text, entities: [] } },
    reactions: [],
  };
}

describe('Fabushi v1.7.0 Web Core Parity M1B (`v1.6.12`–`v1.6.15` + Genuine Crypto)', () => {
  let server: TelegramServerInstance;
  let baseUrl = '';
  let dataDir = '';

  const origLocalStorage = (globalThis as Record<string, unknown>).localStorage;
  const origDocument = (globalThis as Record<string, unknown>).document;
  const origWindow = (globalThis as Record<string, unknown>).window;
  const origNotification = (globalThis as Record<string, unknown>).Notification;

  beforeAll(async () => {
    (globalThis as Record<string, unknown>).localStorage = createMemoryStorage();
    dataDir = createUniqueTestDir('m1b-web-parity');
    server = createTelegramServer({
      port: 0,
      host: '127.0.0.1',
      dataDir,
      enableTestReset: true,
    });
    const started = await server.start();
    baseUrl = started.baseUrl;
  });

  afterEach(() => {
    setTopPrefetchDelayMsForTest(250);
    vi.restoreAllMocks();
    (globalThis as Record<string, unknown>).document = origDocument;
    (globalThis as Record<string, unknown>).window = origWindow;
    (globalThis as Record<string, unknown>).Notification = origNotification;
  });

  afterAll(async () => {
    await server?.close().catch(() => undefined);
    if (dataDir && fs.existsSync(dataDir)) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
    (globalThis as Record<string, unknown>).localStorage = origLocalStorage;
  });

  // ==========================================================================
  // 1. Genuine RFC 8439 ChaCha20-Poly1305 + RFC 7693 BLAKE2b + RFC 9106 Argon2id
  // ==========================================================================
  describe('1. Genuine RFC 8439 ChaCha20-Poly1305 & RFC 9106 Argon2id v0x13', () => {
    it('matches RFC 8439 Section 2.8.2 official AEAD test vector byte-for-byte and rejects tampering', () => {
      const key = hexToBytes(
        '808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f',
      );
      const nonce = hexToBytes('070000004041424344454647');
      const aad = hexToBytes('50515253c0c1c2c3c4c5c6c7');
      const plaintext = new TextEncoder().encode(
        "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.",
      );
      const expectedCt = hexToBytes(
        'd31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d6' +
          '3dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b36' +
          '92ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc' +
          '3ff4def08e4b7a9de576d26586cec64b6116',
      );
      const expectedTag = hexToBytes('1ae10b594f09e26a7e902ecbd0600691');

      const sealed = chacha20Poly1305Encrypt(key, nonce, plaintext, aad);
      const actualCt = sealed.subarray(0, sealed.byteLength - 16);
      const actualTag = sealed.subarray(sealed.byteLength - 16);

      expect(bytesToHex(actualCt)).toBe(bytesToHex(expectedCt));
      expect(bytesToHex(actualTag)).toBe(bytesToHex(expectedTag));

      const opened = chacha20Poly1305Decrypt(key, nonce, sealed, aad);
      expect(new TextDecoder().decode(opened)).toBe(new TextDecoder().decode(plaintext));

      // Tamper ciphertext
      const tamperedCt = new Uint8Array(sealed);
      tamperedCt[0] ^= 0x01;
      expect(() => chacha20Poly1305Decrypt(key, nonce, tamperedCt, aad)).toThrow();

      // Tamper tag
      const tamperedTag = new Uint8Array(sealed);
      tamperedTag[tamperedTag.byteLength - 1] ^= 0x80;
      expect(() => chacha20Poly1305Decrypt(key, nonce, tamperedTag, aad)).toThrow();

      // Wrong AAD
      const badAad = new Uint8Array(aad);
      badAad[0] ^= 0xff;
      expect(() => chacha20Poly1305Decrypt(key, nonce, sealed, badAad)).toThrow();
    });

    it('matches RFC 7693 BLAKE2b("abc") and RFC 9106 Section 5.3 official Argon2id test vector', () => {
      // RFC 7693 Appendix A: BLAKE2b-512("abc")
      const b2 = blake2b(new TextEncoder().encode('abc'), 64);
      expect(bytesToHex(b2)).toBe(
        'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1' +
          '7d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923',
      );

      // RFC 9106 Section 5.3 Official Argon2id Test Vector:
      // p=4, T=32, m=32, t=3, v=0x13, P=0x01*32, S=0x02*16, K=0x03*8, X=0x04*12
      const tag = argon2idDerive(
        new Uint8Array(32).fill(0x01),
        new Uint8Array(16).fill(0x02),
        { m_cost_kib: 32, t_cost: 3, p_cost: 4 },
        32,
        {
          secret: new Uint8Array(8).fill(0x03),
          associatedData: new Uint8Array(12).fill(0x04),
        },
      );
      expect(bytesToHex(tag)).toBe(
        '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659',
      );
    });

    it('derives independent Split-Key V2 keys via desktop Argon2id and preserves default PBKDF2 parity', async () => {
      const saltB64 = bytesToBase64(new Uint8Array(16).fill(0x5a));
      const argonRes = await deriveSplitKeyV2Argon2id('StrongPass!2026', saltB64, {
        m_cost_kib: 64,
        t_cost: 2,
        p_cost: 1,
      });
      const argonViaFlag = await deriveSplitKeyV2(
        'StrongPass!2026',
        saltB64,
        { m_cost_kib: 64, t_cost: 2, p_cost: 1 },
        { kdfEngine: 'argon2id' },
      );
      expect(argonRes.authVerifierB64).toBe(argonViaFlag.authVerifierB64);
      expect(bytesToBase64(argonRes.vaultWrapKeyBytes)).toBe(
        bytesToBase64(argonViaFlag.vaultWrapKeyBytes),
      );
      expect(argonRes.authVerifierB64).not.toBe(bytesToBase64(argonRes.vaultWrapKeyBytes));
      expect(argonRes.vaultWrapKeyBytes.byteLength).toBe(32);

      // Default PBKDF2 web engine remains deterministic and distinct from Argon2id
      const webRes1 = await deriveSplitKeyV2('StrongPass!2026', saltB64, {
        m_cost_kib: 64,
        t_cost: 2,
        p_cost: 1,
      });
      const webRes2 = await deriveSplitKeyV2('StrongPass!2026', saltB64, {
        m_cost_kib: 64,
        t_cost: 2,
        p_cost: 1,
      });
      expect(webRes1.authVerifierB64).toBe(webRes2.authVerifierB64);
      expect(webRes1.authVerifierB64).not.toBe(argonRes.authVerifierB64);
    });
  });

  // ==========================================================================
  // 2. Vault Root Key, Emergency Kit, Per-Item Subkey & X25519 Device Sync
  // ==========================================================================
  describe('2. Vault ChaCha20-Poly1305 Wrapping, Emergency Kit, Subkeys & X25519 Device Sync', () => {
    it('wraps/unwraps 60B ChaCha20-Poly1305 vault root key and falls back to legacy AES-256-GCM', async () => {
      const rootKey = generateVaultRootKey();
      const wrapKey = generateVaultRootKey();

      const wrappedB64 = await wrapVaultRootKey(rootKey, wrapKey, 42);
      expect(base64ToBytes(wrappedB64).byteLength).toBe(60);

      const unwrapped = await unwrapVaultRootKey(wrappedB64, wrapKey, 42);
      expect(bytesToHex(unwrapped)).toBe(bytesToHex(rootKey));

      // Wrong userId AAD must reject
      await expect(unwrapVaultRootKey(wrappedB64, wrapKey, 999)).rejects.toThrow();

      // Legacy AES-256-GCM wrapped payload transparently unwraps
      const nonce = new Uint8Array(12).fill(0x22);
      const wrapBuf = new Uint8Array(wrapKey).buffer;
      const rootBuf = new Uint8Array(rootKey).buffer;
      const aesKey = await crypto.subtle.importKey('raw', wrapBuf, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, rootBuf));
      const legacyPacked = new Uint8Array(12 + ct.byteLength);
      legacyPacked.set(nonce, 0);
      legacyPacked.set(ct, 12);
      const legacyUnwrapped = await unwrapVaultRootKey(bytesToBase64(legacyPacked), wrapKey);
      expect(bytesToHex(legacyUnwrapped)).toBe(bytesToHex(rootKey));
    });

    it('formats/parses EK- Base32 Emergency Kit and wraps/unwraps recovery root key', async () => {
      const recoveryRaw = generateVaultRootKey();
      const rootKey = generateVaultRootKey();

      const formatted = formatEmergencyKitKey(recoveryRaw, true);
      expect(formatted.startsWith('EK-')).toBe(true);
      const parsed = parseRecoveryKey(formatted.toLowerCase());
      expect(bytesToHex(parsed)).toBe(bytesToHex(recoveryRaw));

      const wrapped = await wrapRecoveryRootKey(recoveryRaw, rootKey, 77);
      expect(base64ToBytes(wrapped).byteLength).toBe(60);
      const recovered = await unwrapRecoveryRootKey(parsed, wrapped, 77);
      expect(bytesToHex(recovered)).toBe(bytesToHex(rootKey));

      await expect(unwrapRecoveryRootKey(parsed, wrapped, 78)).rejects.toThrow();
    });

    it('encrypts/decrypts per-item vault payloads with desktop HKDF subkey & revision AAD', async () => {
      const rootKey = generateVaultRootKey();
      const sub1 = await deriveVaultItemSubkey(rootKey, 10, 'password', 'github.com');
      const sub2 = await deriveVaultItemSubkey(rootKey, 10, 'password', 'gitlab.com');
      expect(bytesToHex(sub1)).not.toBe(bytesToHex(sub2));
      expect(buildVaultItemAad(10, 'password', 'github.com', 3)).toBe(
        'gpui-user-vault:item:v1|10|password|github.com|3',
      );

      const meta = { userId: 10, category: 'password', itemKey: 'github.com', revision: 3 };
      const enc = await encryptVaultItem('{"user":"alice","pass":"s3cr3t"}', rootKey, meta);
      const dec = await decryptVaultItem(enc.nonce_b64, enc.ciphertext_b64, rootKey, meta);
      expect(dec).toBe('{"user":"alice","pass":"s3cr3t"}');

      await expect(
        decryptVaultItem(enc.nonce_b64, enc.ciphertext_b64, rootKey, { ...meta, revision: 4 }),
      ).rejects.toThrow();
    });

    it('seals/unseals root key over X25519 + ChaCha20-Poly1305 and rejects non-contributory points', async () => {
      const requester = await generateDeviceSyncKeyPair();
      const rootKey = generateVaultRootKey();
      const ctx = { requestId: 'sync_req_123', userId: 42 };

      const sealed = await sealRootKeyForDevice(rootKey, requester.publicKeyB64, ctx);
      expect(base64ToBytes(sealed.nonce_b64).byteLength).toBe(12);
      expect(base64ToBytes(sealed.encrypted_root_key_b64).byteLength).toBe(48);

      const unsealed = await unsealRootKeyFromApprover(
        requester.privateKey,
        sealed.approver_ephemeral_pub_b64,
        sealed.encrypted_root_key_b64,
        sealed.nonce_b64,
        ctx,
      );
      expect(bytesToHex(unsealed)).toBe(bytesToHex(rootKey));

      // Non-contributory all-zero public key MUST be rejected
      const allZeroPubB64 = bytesToBase64(new Uint8Array(32));
      await expect(sealRootKeyForDevice(rootKey, allZeroPubB64, ctx)).rejects.toThrow(/non-contributory|all-zero/i);

      // Low-order Curve25519 point (u=1) MUST be rejected
      const lowOrder = new Uint8Array(32);
      lowOrder[0] = 1;
      await expect(sealRootKeyForDevice(rootKey, bytesToBase64(lowOrder), ctx)).rejects.toThrow(
        /non-contributory|low-order/i,
      );
    });
  });

  // ==========================================================================
  // 3. E2EE X25519 + Ed25519 Prekeys, Desktop X3DH, Double Ratchet & Sender Keys
  // ==========================================================================
  describe('3. E2EE X25519+Ed25519 Prekeys, X3DH, Double Ratchet & Group Sender Keys', () => {
    it('generates X25519+Ed25519 prekeys accepted with HTTP 200 by live server and round-trips web secret chat', async () => {
      clearE2eeCacheForAccount();
      const alice = await registerTestUser(baseUrl, `e2ee_alice_${Date.now()}`);
      const bob = await registerTestUser(baseUrl, `e2ee_bob_${Date.now()}`);

      const aliceIdentity = await generateIdentityKeyPair(alice.user_id, 'web-primary');
      const bobIdentity = await generateIdentityKeyPair(bob.user_id, 'web-primary');
      expect(aliceIdentity.keySuite).toBe('x25519_ed25519');
      expect(base64ToBytes(aliceIdentity.dhPublicKeyBase64).byteLength).toBe(32);
      expect(base64ToBytes(aliceIdentity.signingPublicKeyBase64).byteLength).toBe(32);
      expect(base64ToBytes(aliceIdentity.signedPreKeySignature).byteLength).toBe(64);

      const sigValid = await verifyPreKeySignature(
        aliceIdentity.signingPublicKeyBase64,
        aliceIdentity.signedPreKeyPublicBase64,
        aliceIdentity.signedPreKeySignature,
      );
      expect(sigValid).toBe(true);
      expect(
        await verifyPreKeySignature(
          aliceIdentity.signingPublicKeyBase64,
          bobIdentity.signedPreKeyPublicBase64,
          aliceIdentity.signedPreKeySignature,
        ),
      ).toBe(false);

      // Publish to live server POST /api/v1/e2ee/prekeys -> HTTP 200
      const pubResA = await apiJson(baseUrl, 'POST', '/api/v1/e2ee/prekeys', {
        token: alice.token,
        body: toPublishPreKeysRequest(aliceIdentity),
      });
      expect(pubResA.status).toBe(200);
      expect(pubResA.data.success).toBe(true);

      const pubResB = await apiJson(baseUrl, 'POST', '/api/v1/e2ee/prekeys', {
        token: bob.token,
        body: toPublishPreKeysRequest(bobIdentity),
      });
      expect(pubResB.status).toBe(200);

      // Fetch Bob's bundle from live server & round-trip encryptEnvelope / decryptEnvelope
      const bundleRes = await apiJson(baseUrl, 'GET', `/api/v1/e2ee/users/${bob.user_id}/prekeys`, {
        token: alice.token,
      });
      expect(bundleRes.status).toBe(200);
      expect(bundleRes.data.devices.length).toBeGreaterThan(0);

      const { envelope } = await encryptEnvelope({
        localUserId: alice.user_id,
        chatId: 9901,
        peerUserId: bob.user_id,
        plaintext: 'Top secret X25519+AES-GCM payload',
        remoteBundles: bundleRes.data.devices,
      });
      const decryptedByBob = await decryptEnvelope({
        localUserId: bob.user_id,
        chatId: 9901,
        peerUserId: alice.user_id,
        envelope,
      });
      expect(decryptedByBob.text).toBe('Top secret X25519+AES-GCM payload');
    });

    it('runs desktop-interoperable X3DH + Double Ratchet (out-of-order, tamper-safe, replay-safe)', async () => {
      const aliceId = await generateIdentityKeyPair('x3dh_alice', 'dev-a');
      const bobId = await generateIdentityKeyPair('x3dh_bob', 'dev-b');

      const bobBundle = {
        user_id: 2,
        device_id: bobId.deviceId,
        identity_key: bobId.dhPublicKeyBase64,
        identity_signing_key: bobId.signingPublicKeyBase64,
        signed_prekey: {
          key_id: bobId.signedPreKeyId,
          public_key: bobId.signedPreKeyPublicBase64,
          signature: bobId.signedPreKeySignature,
          created_at_ms: bobId.createdAtMs,
        },
        one_time_prekey: {
          key_id: bobId.oneTimePreKeys[0]!.keyId,
          public_key: bobId.oneTimePreKeys[0]!.publicKeyBase64,
        },
      };

      // Forged SPK signature must be rejected before any DH
      await expect(
        x3dhInitiatorDerive({
          initiatorIdentityPrivateJwk: aliceId.dhPrivateKeyJwk,
          initiatorIdentityPublicBase64: aliceId.dhPublicKeyBase64,
          responderBundle: {
            ...bobBundle,
            signed_prekey: {
              ...bobBundle.signed_prekey,
              signature: bytesToBase64(new Uint8Array(64).fill(0xab)),
            },
          },
        }),
      ).rejects.toThrow(/signature/i);

      const init = await x3dhInitiatorDerive({
        initiatorIdentityPrivateJwk: aliceId.dhPrivateKeyJwk,
        initiatorIdentityPublicBase64: aliceId.dhPublicKeyBase64,
        responderBundle: bobBundle,
      });
      const resp = await x3dhResponderDerive({
        responderIdentityPrivateJwk: bobId.dhPrivateKeyJwk,
        responderIdentityPublicBase64: bobId.dhPublicKeyBase64,
        responderSignedPreKeyPrivateJwk: bobId.signedPreKeyPrivateJwk,
        responderOneTimePreKeyPrivateJwk: bobId.oneTimePreKeys[0]!.privateKeyJwk,
        initiatorIdentityPublicBase64: aliceId.dhPublicKeyBase64,
        initiatorEphemeralPublicBase64: init.ephemeralPublicBase64,
      });

      expect(bytesToHex(init.sharedSecret)).toBe(bytesToHex(resp.sharedSecret));
      expect(bytesToHex(init.associatedData)).toBe(bytesToHex(resp.associatedData));

      // Initialize Double Ratchet sessions
      const aliceSession = await DesktopDoubleRatchetSession.initInitiator(
        init.sharedSecret,
        bobId.signedPreKeyPublicBase64,
        init.associatedData,
      );
      const bobSession = DesktopDoubleRatchetSession.initResponder(
        resp.sharedSecret,
        bobId.signedPreKeyPublicBase64,
        bobId.signedPreKeyPrivateJwk,
        resp.associatedData,
      );

      const m0 = await aliceSession.encrypt('msg-0');
      const m1 = await aliceSession.encrypt('msg-1');
      const m2 = await aliceSession.encrypt('msg-2');

      // Out-of-order delivery: m2 before m0/m1
      expect(new TextDecoder().decode(await bobSession.decrypt(m2.header, m2.ciphertextB64, init.ephemeralPublicBase64))).toBe('msg-2');
      expect(bobSession.skippedKeyCount).toBe(2);

      // Replaying X3DH ephemeral key must be rejected
      await expect(
        bobSession.decrypt(m1.header, m1.ciphertextB64, init.ephemeralPublicBase64),
      ).rejects.toThrow(/replay/i);

      // Tampered ciphertext must throw AND NOT mutate session state
      const badCtBytes = base64ToBytes(m1.ciphertextB64);
      badCtBytes[0] ^= 0xff;
      await expect(bobSession.decrypt(m1.header, bytesToBase64(badCtBytes))).rejects.toThrow();

      // Genuine m1 & m0 still decrypt cleanly after failed tamper!
      expect(new TextDecoder().decode(await bobSession.decrypt(m1.header, m1.ciphertextB64))).toBe('msg-1');
      expect(new TextDecoder().decode(await bobSession.decrypt(m0.header, m0.ciphertextB64))).toBe('msg-0');

      // Replay of m0 rejected
      await expect(bobSession.decrypt(m0.header, m0.ciphertextB64)).rejects.toThrow(/replay/i);

      // Bidirectional DH ratchet turn: Bob replies to Alice
      const reply = await bobSession.encrypt('hello from bob');
      expect(new TextDecoder().decode(await aliceSession.decrypt(reply.header, reply.ciphertextB64))).toBe(
        'hello from bob',
      );
    });

    it('runs desktop-interoperable Group Sender Keys with Ed25519 signature verification & out-of-order', async () => {
      const edKey = await generateEd25519KeyPair();
      const sender = DesktopSenderKeyState.createSender({
        chatId: 5001,
        senderUserId: 101,
        senderDeviceId: 'web-primary',
        signingPublicKeyBase64: edKey.publicKeyBase64,
        signingPrivateKeyJwk: edKey.privateKeyJwk,
      });
      const receiver = DesktopSenderKeyState.fromDistribution(sender.toDistributionMessage());

      const g0 = await sender.encrypt('group-zero');
      const g1 = await sender.encrypt('group-one');

      // Tampered signature rejected without mutating state
      const badSig = base64ToBytes(g1.signature);
      badSig[0] ^= 0x01;
      await expect(
        receiver.decrypt({ ...g1, signature: bytesToBase64(badSig) }),
      ).rejects.toThrow(/signature/i);

      // Out-of-order decrypt succeeds
      expect(new TextDecoder().decode(await receiver.decrypt(g1))).toBe('group-one');
      expect(new TextDecoder().decode(await receiver.decrypt(g0))).toBe('group-zero');

      // Replay rejected
      await expect(receiver.decrypt(g0)).rejects.toThrow(/replay/i);
    });
  });

  // ==========================================================================
  // 4. Frame-0 Snapshot, IndexedDB v2, Single-Flight Bootstrap & Top-8 Prefetch
  // ==========================================================================
  describe('4. Frame-0 Snapshot, IndexedDB v2, Single-Flight Dedup & Top-8 Prefetch', () => {
    it('supports per-account Frame-0 snapshot isolation and IndexedDB v2 creations/community_cache', async () => {
      clearFrame0Snapshot();
      writeFrame0Snapshot('accA', {
        chats: [makeFakeChat(1)],
        activeChatId: 1,
        activeChatMessages: [makeFakeMessage(1, 10)],
        peers: [],
      });
      writeFrame0Snapshot('accB', {
        chats: [makeFakeChat(2)],
        activeChatId: 2,
        activeChatMessages: [makeFakeMessage(2, 20)],
        peers: [],
      });

      expect(readFrame0Snapshot('accA')?.chats[0]?.chatId).toBe(1);
      expect(readFrame0Snapshot('accB')?.chats[0]?.chatId).toBe(2);

      clearFrame0Snapshot('accA');
      expect(readFrame0Snapshot('accA')).toBeNull();
      expect(readFrame0Snapshot('accB')?.chats[0]?.chatId).toBe(2);

      clearFrame0Snapshot();
      expect(readFrame0Snapshot('accB')).toBeNull();

      // IndexedDB v2 schema & account cleanup
      expect(IDB_VERSION).toBe(2);
      expect(ALL_STORES).toContain('creations');
      expect(ALL_STORES).toContain('community_cache');

      const cache = new IndexedDbCacheService();
      await cache.saveCreations('accA', 'bots', [{ id: 'b1' }]);
      await cache.saveCommunityCache('accA', 'feed', [{ id: 'p1' }]);
      await cache.saveCreations('accB', 'bots', [{ id: 'b2' }]);
      await cache.saveCommunityCache('accB', 'feed', [{ id: 'p2' }]);

      expect(await cache.loadCreations('accA', 'bots')).toEqual([{ id: 'b1' }]);
      expect(await cache.loadCommunityCache('accA', 'feed')).toEqual([{ id: 'p1' }]);

      await cache.clearAccountData('accA');
      expect(await cache.loadCreations('accA', 'bots')).toBeUndefined();
      expect(await cache.loadCommunityCache('accA', 'feed')).toBeUndefined();
      expect(await cache.loadCreations('accB', 'bots')).toEqual([{ id: 'b2' }]);
      expect(await cache.loadCommunityCache('accB', 'feed')).toEqual([{ id: 'p2' }]);
    });

    it('hydrates Frame-0 synchronously, deduplicates concurrent bootstrapChats(), and bounds top-8 prefetch', async () => {
      setTopPrefetchDelayMsForTest(0);
      clearFrame0Snapshot();
      useAuthStore.setState({
        activeAccountId: 'acc_sf',
        isAuthenticated: true,
        currentUser: {
          userId: 700,
          firstName: 'SF',
          username: 'sf_user',
          isBot: false,
          isVerified: false,
          isPremium: false,
          status: 'online',
          colorIndex: 0,
        },
      });
      useChatStore.getState().resetChatStore();

      const chats12 = Array.from({ length: 12 }, (_, idx) =>
        makeFakeChat(idx + 1, { isPinned: idx < 2 }),
      );
      writeFrame0Snapshot('acc_sf', {
        chats: [chats12[0]!],
        activeChatId: 1,
        activeChatMessages: [makeFakeMessage(1, 101, 'cached-frame0')],
        peers: [],
      });

      let listChatsCalls = 0;
      const prefetchedChatIds: number[] = [];
      let resolveListChats!: () => void;
      const listChatsGate = new Promise<void>((r) => {
        resolveListChats = r;
      });

      const adapter = getServerAdapter();
      vi.spyOn(adapter, 'getConnectionState').mockReturnValue('connected');
      vi.spyOn(adapter, 'getDiscoveredPeers').mockReturnValue([]);
      vi.spyOn(adapter, 'listChats').mockImplementation(async () => {
        listChatsCalls += 1;
        await listChatsGate;
        return { chats: chats12, users: [] };
      });
      vi.spyOn(adapter, 'listFolders').mockResolvedValue([]);
      vi.spyOn(adapter, 'listStories').mockResolvedValue([]);
      vi.spyOn(adapter, 'listMessages').mockImplementation(async (chatId: number) => {
        prefetchedChatIds.push(chatId);
        return { messages: [makeFakeMessage(chatId, chatId * 10)], pts: 1, hasMore: false };
      });

      const p1 = useChatStore.getState().bootstrapChats();
      const p2 = useChatStore.getState().bootstrapChats();

      // Frame-0 MUST be hydrated synchronously BEFORE listChats resolves!
      expect(useChatStore.getState().chatsById[1]?.chatId).toBe(1);
      expect(useChatStore.getState().messagesByChat[1]?.[0]?.text).toBe('cached-frame0');

      resolveListChats();
      await Promise.all([p1, p2]);

      // Single-flight deduplication: strictly 1 listChats() call
      expect(listChatsCalls).toBe(1);

      // Wait briefly for microtask/chunked top-8 prefetch to complete
      await new Promise((r) => setTimeout(r, 40));

      expect(prefetchedChatIds.length).toBe(TOP_PREFETCH_DIALOG_LIMIT);
      // Active chat 1 was already loaded/active, so strictly skipped by top-8 prefetch
      expect(prefetchedChatIds).not.toContain(1);
      expect(useChatStore.getState().messagesByChat[prefetchedChatIds[0]!]?.length).toBeGreaterThan(0);

      // Reset wipes Frame-0
      useChatStore.getState().resetChatStore();
      expect(readFrame0Snapshot('acc_sf')).toBeNull();
    });
  });

  // ==========================================================================
  // 5. Compose Isolation Snapshot & Scheduled Message Isolation
  // ==========================================================================
  describe('5. ComposeIsolationSnapshot & Scheduled Message Isolation', () => {
    it('captures/clears active composer state on openAppleComposeStage and restores on cancel (not commit)', () => {
      useChatStore.getState().resetChatStore();
      useUiStore.getState().resetUiStore();

      const msg = makeFakeMessage(55, 501, 'Editable text');
      useChatStore.setState({
        activeChatId: 55,
        chatsById: { 55: makeFakeChat(55) },
        orderedChatIds: [55],
        replyTargetByChat: {
          55: { messageId: 500, senderName: 'Alice', previewText: 'Orig', quoteText: 'quoted' },
        },
        editingMessageByChat: { 55: msg },
        draftsByChat: { 55: { chatId: 55, text: 'unsent draft', entities: [], dateMs: Date.now() } },
      });

      useUiStore.getState().openAppleComposeStage();
      expect(useUiStore.getState().appleComposeStage.isOpen).toBe(true);
      expect(useUiStore.getState().composeIsolationSnapshot?.chatId).toBe(55);
      // Active chat reply/edit MUST be cleared while compose stage is open
      expect(useChatStore.getState().replyTargetByChat[55]).toBeNull();
      expect(useChatStore.getState().editingMessageByChat[55]).toBeNull();

      // Cancel restores replyTarget, editingMessage, and draftText
      useUiStore.getState().closeAppleComposeStage({ committed: false });
      expect(useChatStore.getState().replyTargetByChat[55]?.messageId).toBe(500);
      expect(useChatStore.getState().replyTargetByChat[55]?.quoteText).toBe('quoted');
      expect(useChatStore.getState().editingMessageByChat[55]?.id).toBe(501);
      expect(useChatStore.getState().draftsByChat[55]?.text).toBe('unsent draft');

      // Open again and COMMIT -> snapshot discarded, cleared state NOT overwritten back
      useUiStore.getState().openAppleComposeStage();
      useUiStore.getState().closeAppleComposeStage({ committed: true });
      expect(useUiStore.getState().composeIsolationSnapshot).toBeNull();
      expect(useChatStore.getState().replyTargetByChat[55]).toBeNull();
      expect(useChatStore.getState().editingMessageByChat[55]).toBeNull();
    });

    it('isolates scheduled messages strictly into scheduledMessagesByChat without polluting timeline', async () => {
      useChatStore.getState().resetChatStore();
      const chat = makeFakeChat(88, { lastMessagePreview: 'Initial preview', lastMessageId: 1 });
      useChatStore.setState({
        activeChatId: 88,
        chatsById: { 88: chat },
        orderedChatIds: [88],
        messagesByChat: { 88: [makeFakeMessage(88, 1, 'Initial preview')] },
      });

      const futureMs = Date.now() + 600_000;
      vi.spyOn(getServerAdapter(), 'sendMessage').mockImplementation(async (req) => {
        const msg = makeFakeMessage(req.chatId, 999, req.text ?? '');
        msg.flags.is_out = true;
        msg.flags.is_scheduled = Boolean(req.scheduleAtMs);
        msg.scheduled_at_ms = req.scheduleAtMs ?? null;
        return { message: msg, pts: 10 };
      });

      await useChatStore.getState().sendText(88, 'Scheduled reminder', { scheduleAtMs: futureMs });

      expect(useChatStore.getState().messagesByChat[88]?.map((m) => m.id)).toEqual([1]);
      expect(useChatStore.getState().chatsById[88]?.lastMessagePreview).toBe('Initial preview');
      expect(useChatStore.getState().scheduledMessagesByChat[88]?.length).toBe(1);
      expect(useChatStore.getState().scheduledMessagesByChat[88]?.[0]?.message_id).toBe(999);
    });
  });

  // ==========================================================================
  // 6. Live HttpWsServerAdapter Integration Against Ephemeral M1A Server
  // ==========================================================================
  describe('6. Live HttpWsServerAdapter Integration Against Ephemeral M1A Server', () => {
    it('exercises all 7 M1A optional TelegramClientPort methods end-to-end', async () => {
      const owner = await registerTestUser(baseUrl, `m1b_owner_${Date.now()}`);
      const member = await registerTestUser(baseUrl, `m1b_member_${Date.now()}`);

      const adapter = new HttpWsServerAdapter(baseUrl);
      adapter.configure({
        serverUrl: baseUrl,
        token: owner.token,
        accountId: String(owner.user_id),
        userId: owner.user_id,
      });

      // 1. Create a group chat so we can test scheduled messages, translate, and admin log
      const group = await adapter.createChat({
        chatType: 1,
        title: 'M1B Live Parity Group',
        memberIds: [member.user_id],
      });
      expect(group.chatId).toBeGreaterThan(0);

      // 2. Scheduled messages: schedule 2 messages, list, cancel one, send-now the other
      const futureA = Date.now() + 300_000;
      const futureB = Date.now() + 600_000;
      const schedA = await adapter.sendMessage({
        chatId: group.chatId,
        text: 'Scheduled A (cancel me)',
        scheduleAtMs: futureA,
      });
      const schedB = await adapter.sendMessage({
        chatId: group.chatId,
        text: 'Scheduled B (send now)',
        scheduleAtMs: futureB,
      });
      expect(schedA.message.flags.is_scheduled).toBe(true);
      expect(schedB.message.flags.is_scheduled).toBe(true);

      const scheduledList = await adapter.listScheduledMessages(group.chatId);
      expect(scheduledList.length).toBe(2);

      const cancelRes = await adapter.cancelScheduledMessage(group.chatId, schedA.message.id);
      expect(cancelRes.ok).toBe(true);

      const sentNow = await adapter.sendScheduledMessageNow(group.chatId, schedB.message.id);
      expect(sentNow.message.flags.is_scheduled).toBe(false);

      const remainingScheduled = await adapter.listScheduledMessages(group.chatId);
      expect(remainingScheduled.length).toBe(0);

      // 3. Translate message without Magpie provider configured -> honest 503 with err.details!
      let translateErr: (Error & { status?: number; code?: string; details?: Record<string, unknown> }) | null = null;
      try {
        await adapter.translateMessage(group.chatId, sentNow.message.id, 'zh-CN');
      } catch (err) {
        translateErr = err as Error & { status?: number; code?: string; details?: Record<string, unknown> };
      }
      expect(translateErr).not.toBeNull();
      expect(translateErr?.status).toBe(503);
      expect(translateErr?.code).toBe('provider_not_configured');
      expect(translateErr?.details).toBeTruthy();

      // 4. Admin Log: pin & delete a message in group, then fetch listAdminLog
      await adapter.pinMessage(group.chatId, sentNow.message.id, true);
      await adapter.deleteMessages(group.chatId, [sentNow.message.id], true);
      const adminLog = await adapter.listAdminLog(group.chatId, { limit: 20 });
      expect(adminLog.chat_id).toBe(group.chatId);
      expect(adminLog.events.length).toBeGreaterThan(0);

      // 5. Calls History: start & end a video call, then query listCallsHistory
      const call = await adapter.startCall(member.user_id, true);
      await adapter.endCall(call.call_id);
      const allCalls = await adapter.listCallsHistory({ limit: 10, filter: 'all' });
      expect(allCalls.calls.some((c) => c.call_id === call.call_id)).toBe(true);
      const videoCalls = await adapter.listCallsHistory({ limit: 10, filter: 'video' });
      expect(videoCalls.calls.some((c) => c.call_id === call.call_id && c.is_video)).toBe(true);

      // 6. Inline Bot Query: create an inline-enabled bot & queryBotInline
      const botSlug = `m1b_inline_${Date.now().toString().slice(-6)}_bot`;
      const createBot = await apiJson(baseUrl, 'POST', '/api/v1/bots', {
        token: owner.token,
        body: {
          username: botSlug,
          display_name: 'M1B Inline Bot',
          description: 'Inline parity test bot',
        },
      });
      expect(createBot.status).toBe(201);
      const botUserId = Number(createBot.data.bot.bot_user_id);
      const patchBot = await apiJson(baseUrl, 'PATCH', `/api/v1/bots/${botUserId}`, {
        token: owner.token,
        body: { is_inline: true },
      });
      expect(patchBot.status).toBe(200);
      const inlineRes = await adapter.queryBotInline({
        bot: `@${botSlug}`,
        query: 'hello world',
        chatId: group.chatId,
        limit: 5,
      });
      expect(inlineRes.bot_username).toBe(botSlug);
      expect(Array.isArray(inlineRes.results)).toBe(true);
      // Zero-leak no-echo invariant: raw query probe is not echoed back as a top-level query field
      expect((inlineRes as unknown as Record<string, unknown>).query).toBeUndefined();
    });

    it('fans out UserCreationChanged, PublicCatalogChanged, and community_event via realtime domain event bus', () => {
      const received: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const unsubDomain = subscribeRealtimeDomainEvent((ev) => {
        received.push({ type: ev.type, payload: ev.payload });
      });

      const listeners = new Set<(ev: UpdateEvent) => void>();
      const adapter = getServerAdapter();
      vi.spyOn(adapter, 'getConnectionState').mockReturnValue('connected');
      vi.spyOn(adapter, 'onUpdate').mockImplementation((fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      });
      vi.spyOn(adapter, 'onConnectionStateChange').mockImplementation(() => () => undefined);

      const unbind = useChatStore.getState().bindRealtimeEvents();

      for (const fn of listeners) {
        fn({
          type: 'UserCreationChanged',
          data: {
            action: 'created',
            creation_id: 'cr_1',
            owner_user_id: 101,
            kind: 'app',
            review_status: 'draft',
            cloud_revision: 1,
          },
        });
        fn({
          type: 'PublicCatalogChanged',
          data: {
            action: 'published',
            creation_id: 'pub_2',
            kind: 'app',
          },
        });
        fn({
          type: 'community_event',
          data: {
            event_kind: 'post_replied',
            post_id: 'post_3',
            payload_json: '{}',
            timestamp_ms: Date.now(),
          },
        });
      }

      expect(received.map((r) => r.type)).toEqual([
        'UserCreationChanged',
        'PublicCatalogChanged',
        'community_event',
      ]);
      expect(received[0]?.payload.creation_id).toBe('cr_1');
      expect(useChatStore.getState().lastRealtimeDomainEvent?.type).toBe('community_event');

      unbind();
      unsubDomain();
    });
  });

  // ==========================================================================
  // 7. Settings (System Theme, 50..300% Scale, BT.601 Luma Guard, Web Notification)
  // ==========================================================================
  describe('7. Settings Parity (ThemeMode::System, Scale 50..300%, BT.601 Contrast, Notification)', () => {
    it('resolves system theme via matchMedia, clamps scale 50..300%, and enforces BT.601 + anti-purple contrast', () => {
      const attrs = new Map<string, string>();
      const styles = new Map<string, string>();
      (globalThis as Record<string, unknown>).document = {
        documentElement: {
          lang: 'en-US',
          setAttribute: (k: string, v: string) => attrs.set(k, v),
          getAttribute: (k: string) => attrs.get(k) ?? null,
          style: {
            setProperty: (k: string, v: string) => styles.set(k, v),
            removeProperty: (k: string) => styles.delete(k),
          },
        },
        hidden: true,
      };

      let prefersDark = true;
      (globalThis as Record<string, unknown>).window = {
        matchMedia: () => ({
          matches: prefersDark,
          addEventListener: () => undefined,
        }),
      };

      useSettingsStore.getState().setTheme('system');
      expect(attrs.get('data-theme')).toBe('night');
      expect(attrs.get('data-theme-mode')).toBe('system');

      prefersDark = false;
      useSettingsStore.getState().setTheme('system');
      expect(attrs.get('data-theme')).toBe('day');
      expect(attrs.get('data-theme-mode')).toBe('system');

      // Scale clamping 50..300%
      useSettingsStore.getState().setInterfaceScalePct(350);
      expect(useSettingsStore.getState().interfaceScalePct).toBe(300);
      expect(useSettingsStore.getState().uiScale).toBe(300);
      expect(styles.get('--tg-ui-scale')).toBe('3');

      useSettingsStore.getState().setInterfaceScalePct(25);
      expect(useSettingsStore.getState().interfaceScalePct).toBe(50);
      expect(useSettingsStore.getState().uiScale).toBe(50);
      expect(styles.get('--tg-ui-scale')).toBe('0.5');

      // BT.601 luma contrast guard + anti-purple guard
      expect(ensureWhiteTextContrast('#9B51E0')).toBe('#0A84FF');
      expect(ensureWhiteTextContrast('#0A84FF')).toBe('#0A84FF'); // luma ~109.5 <= 138
      const darkenedYellow = ensureWhiteTextContrast('#FFFF00');
      expect(darkenedYellow).not.toBe('#FFFF00');
      expect(computeBt601Luma(darkenedYellow)).toBeLessThan(computeBt601Luma('#FFFF00'));
    });

    it('dispatches Web Notification on incoming unmuted message and suppresses when muted/disabled/outgoing', () => {
      const fired: Array<{ title: string; body?: string; tag?: string }> = [];
      class MockNotification {
        static permission: NotificationPermission = 'granted';
        static requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
        onclick: (() => void) | null = null;
        constructor(title: string, opts?: NotificationOptions) {
          fired.push({ title, body: opts?.body, tag: opts?.tag });
        }
      }
      (globalThis as Record<string, unknown>).Notification = MockNotification;
      (globalThis as Record<string, unknown>).document = {
        hidden: true,
        documentElement: {
          lang: 'en-US',
          setAttribute: () => undefined,
          style: {
            setProperty: () => undefined,
            removeProperty: () => undefined,
          },
        },
      };

      const listeners = new Set<(ev: UpdateEvent) => void>();
      const adapter = getServerAdapter();
      vi.spyOn(adapter, 'getConnectionState').mockReturnValue('connected');
      vi.spyOn(adapter, 'onUpdate').mockImplementation((fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      });
      vi.spyOn(adapter, 'onConnectionStateChange').mockImplementation(() => () => undefined);

      useChatStore.getState().resetChatStore();
      useChatStore.setState({
        activeChatId: 1,
        chatsById: {
          1: makeFakeChat(1, { title: 'Alice DM', isMuted: false }),
          2: makeFakeChat(2, { title: 'Muted Group', isMuted: true }),
        },
        orderedChatIds: [1, 2],
      });
      useSettingsStore.getState().setNotificationsEnabled(true);
      const unbind = useChatStore.getState().bindRealtimeEvents();

      const emit = (ev: UpdateEvent) => {
        for (const fn of listeners) fn(ev);
      };

      // 1. Incoming unmuted while document.hidden -> fires Notification
      emit({ type: 'NewMessage', data: makeFakeMessage(1, 10, 'Ping from Alice') });
      expect(fired.length).toBe(1);
      expect(fired[0]?.title).toBe('Alice DM');
      expect(fired[0]?.body).toBe('Ping from Alice');

      // 2. Muted chat -> suppressed
      emit({ type: 'NewMessage', data: makeFakeMessage(2, 11, 'Muted ping') });
      expect(fired.length).toBe(1);

      // 3. Outgoing message -> suppressed
      const outMsg = makeFakeMessage(1, 12, 'My outgoing msg');
      outMsg.flags.is_out = true;
      emit({ type: 'NewMessage', data: outMsg });
      expect(fired.length).toBe(1);

      // 4. Notifications disabled -> suppressed
      useSettingsStore.getState().setNotificationsEnabled(false);
      emit({ type: 'NewMessage', data: makeFakeMessage(1, 13, 'Should not notify') });
      expect(fired.length).toBe(1);

      unbind();
    });
  });

  // ==========================================================================
  // 8. Pure M1B Helpers (1200ms Grace Banner, PiP Focus Guard, Inline Parser, Admin Log Coalescing)
  // ==========================================================================
  describe('8. Pure M1B Helpers (Connection Grace FSM, PiP Focus Guard, Inline Parser, Admin Log Coalescing)', () => {
    it('evaluates 1200ms grace connecting banner FSM with 0ms immediate offline visibility', () => {
      const t0 = 10_000;
      // Connected -> hidden
      expect(
        evaluateConnectionBannerVisibility({
          connectionState: 'connected',
          browserOfflineEvent: false,
          transientStartedAtMs: null,
          nowMs: t0,
        }).visible,
      ).toBe(false);

      // Browser offline -> immediate (0ms)
      const offlineEval = evaluateConnectionBannerVisibility({
        connectionState: 'connected',
        browserOfflineEvent: true,
        transientStartedAtMs: null,
        nowMs: t0,
      });
      expect(offlineEval.visible).toBe(true);
      expect(offlineEval.state).toBe('offline');
      expect(offlineEval.immediate).toBe(true);

      // Transient connecting at 1199ms -> still hidden
      expect(
        evaluateConnectionBannerVisibility({
          connectionState: 'connecting',
          browserOfflineEvent: false,
          transientStartedAtMs: t0,
          nowMs: t0 + CONNECTING_BANNER_GRACE_MS - 1,
        }).visible,
      ).toBe(false);

      // Transient connecting at 1200ms -> visible
      const graceElapsed = evaluateConnectionBannerVisibility({
        connectionState: 'reconnecting',
        browserOfflineEvent: false,
        transientStartedAtMs: t0,
        nowMs: t0 + CONNECTING_BANNER_GRACE_MS,
      });
      expect(graceElapsed.visible).toBe(true);
      expect(graceElapsed.state).toBe('reconnecting');
    });

    it('enforces desktop v1.6.12 allowsMiniAppIframeFocus predicate', () => {
      expect(
        allowsMiniAppIframeFocus({
          hasLiveMiniApp: true,
          isPipMinimized: false,
          isReady: true,
          hasHigherPriorityModal: false,
          searchFocused: false,
        }),
      ).toBe(true);
      expect(
        allowsMiniAppIframeFocus({
          hasLiveMiniApp: true,
          isPipMinimized: true,
          isReady: true,
          hasHigherPriorityModal: false,
          searchFocused: false,
        }),
      ).toBe(false);
      expect(
        allowsMiniAppIframeFocus({
          hasLiveMiniApp: true,
          isPipMinimized: false,
          isReady: true,
          hasHigherPriorityModal: true,
          searchFocused: false,
        }),
      ).toBe(false);
      expect(
        allowsMiniAppIframeFocus({
          hasLiveMiniApp: true,
          isPipMinimized: false,
          isReady: true,
          hasHigherPriorityModal: false,
          searchFocused: true,
        }),
      ).toBe(false);
    });

    it('parses @botusername <query> without colliding with @mention autocomplete and coalesces 5s admin deletes', () => {
      expect(parseInlineBotQueryInput('@mybot hello world')).toEqual({
        botUsername: 'mybot',
        query: 'hello world',
      });
      expect(parseInlineBotQueryInput('@mybot ')).toEqual({
        botUsername: 'mybot',
        query: '',
      });
      expect(parseInlineBotQueryInput('@mention')).toBeNull();
      expect(parseInlineBotQueryInput('hello @mention')).toBeNull();

      const coalesced = coalesceAdminLogDeletes(
        [
          { event_id: 1, chat_id: 10, actor_user_id: 5, action: 'message_deleted', details: {}, created_at_ms: 10_000 },
          { event_id: 2, chat_id: 10, actor_user_id: 5, action: 'message_deleted', details: {}, created_at_ms: 13_000 },
          { event_id: 3, chat_id: 10, actor_user_id: 5, action: 'message_deleted', details: {}, created_at_ms: 25_000 },
          { event_id: 4, chat_id: 10, actor_user_id: 6, action: 'message_deleted', details: {}, created_at_ms: 26_000 },
        ],
        5,
      );
      expect(coalesced.length).toBe(3);
      expect(coalesced[0]?.coalescedCount).toBe(2);
      expect(coalesced[0]?.coalescedIds).toEqual([1, 2]);
      expect(coalesced[1]?.coalescedCount).toBe(1);
      expect(coalesced[2]?.coalescedCount).toBe(1);
    });
  });

  // ==========================================================================
  // 9. Iteration 2 Remediation Regression Tests
  // ==========================================================================
  describe('9. Iteration 2 Regression Tests (Frame-0 Lifecycle, WS Dedup, Epoch Fencing, Crypto Interop, WS Resilience)', () => {
    it('preserves Frame-0 state on cold reload (online & offline transient), preserves Account B on switchAccount(A->B), and purges removed accounts', async () => {
      localStorage.clear();
      clearFrame0Snapshot('all');
      useChatStore.getState().resetChatStore();

      const adapter = getServerAdapter();
      const userA = {
        userId: 42,
        firstName: 'Alice',
        lastName: 'Cold',
        username: 'alice_cold',
        phone: '+15550000042',
        isBot: false,
        isVerified: false,
        isPremium: false,
        status: 'online' as const,
        colorIndex: 1,
      };
      const userB = {
        userId: 99,
        firstName: 'Bob',
        lastName: 'Switch',
        username: 'bob_switch',
        phone: '+15550000099',
        isBot: false,
        isVerified: false,
        isPremium: false,
        status: 'online' as const,
        colorIndex: 2,
      };
      const userC = {
        userId: 105,
        firstName: 'Carol',
        lastName: 'Removed',
        username: 'carol_removed',
        phone: '+15550000105',
        isBot: false,
        isVerified: false,
        isPremium: false,
        status: 'offline' as const,
        colorIndex: 3,
      };

      const chatA = makeFakeChat(101, { title: 'Alice Chat' });
      const msgA = makeFakeMessage(101, 5001, 'Frame-0 persisted message');
      const chatB = makeFakeChat(202, { title: 'Bob Frame-0 Chat' });
      const msgB = makeFakeMessage(202, 6001, 'Bob cached message');
      const chatC = makeFakeChat(303, { title: 'Carol Chat' });

      writeFrame0Snapshot('accA', {
        chats: [chatA],
        activeChatId: 101,
        activeChatMessages: [msgA],
        peers: [userA],
      });
      writeFrame0Snapshot('accB', {
        chats: [chatB],
        activeChatId: 202,
        activeChatMessages: [msgB],
        peers: [userB],
      });
      writeFrame0Snapshot('accC', {
        chats: [chatC],
        activeChatId: 303,
        activeChatMessages: [],
        peers: [userC],
      });

      const authEnvelope = {
        accounts: [
          {
            accountId: 'accA',
            userId: 42,
            token: 'tok-a',
            sessionId: 'sess-a',
            expiresAtMs: Date.now() + 86_400_000,
            user: userA,
            adapterMode: 'server',
            serverUrl: baseUrl,
          },
          {
            accountId: 'accB',
            userId: 99,
            token: 'tok-b',
            sessionId: 'sess-b',
            expiresAtMs: Date.now() + 86_400_000,
            user: userB,
            adapterMode: 'server',
            serverUrl: baseUrl,
          },
          {
            accountId: 'accC',
            userId: 105,
            token: 'tok-c',
            sessionId: 'sess-c',
            expiresAtMs: Date.now() + 86_400_000,
            user: userC,
            adapterMode: 'server',
            serverUrl: baseUrl,
          },
        ],
        activeAccountId: 'accA',
        adapterMode: 'server',
        serverUrl: baseUrl,
        passcodeHash: null,
        isLocked: false,
      };
      localStorage.setItem('gpui_tg_auth_v1', JSON.stringify(authEnvelope));

      // Simulate Frame-0 hydrated state at module boot for accA
      useChatStore.setState({
        hydratedAccountId: 'accA',
        chatsById: { 101: chatA },
        orderedChatIds: [101],
        activeChatId: 101,
        messagesByChat: { 101: [msgA] },
        peersById: { 42: userA },
      });

      let resolveOnlineListChats!: (v: { chats: ChatSummary[]; users: typeof userA[] }) => void;
      vi.spyOn(adapter, 'connect').mockResolvedValue(undefined);
      const disconnectSpy = vi.spyOn(adapter, 'disconnect').mockResolvedValue(undefined);
      vi.spyOn(adapter, 'getMe').mockResolvedValue(userA);
      vi.spyOn(adapter, 'getConnectionState').mockReturnValue('connected');
      vi.spyOn(adapter, 'onUpdate').mockReturnValue(() => undefined);
      vi.spyOn(adapter, 'onConnectionStateChange').mockReturnValue(() => undefined);
      vi.spyOn(adapter, 'listFolders').mockResolvedValue([]);
      vi.spyOn(adapter, 'listStories').mockResolvedValue([]);
      vi.spyOn(adapter, 'listMessages').mockResolvedValue({ messages: [], pts: 1, hasMore: false });
      const listChatsSpy = vi.spyOn(adapter, 'listChats').mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveOnlineListChats = resolve;
          }),
      );

      // (a) Online cold reload via hydrateAuth() must NOT blank Frame-0 state or wipe localStorage
      await useAuthStore.getState().hydrateAuth();
      expect(readFrame0Snapshot('accA')).not.toBeNull();
      expect(useChatStore.getState().chatsById[101]?.title).toBe('Alice Chat');
      expect(useChatStore.getState().activeChatId).toBe(101);
      expect(useChatStore.getState().messagesByChat[101]?.[0]?.id).toBe(5001);
      await new Promise((r) => setTimeout(r, 15));
      expect(useChatStore.getState().chatsById[101]?.title).toBe('Alice Chat');
      resolveOnlineListChats({ chats: [chatA], users: [userA] });
      await new Promise((r) => setTimeout(r, 15));

      // (b) Offline transient cold reload via hydrateAuth() must ALSO preserve Frame-0 state & snapshot
      vi.spyOn(adapter, 'connect').mockRejectedValueOnce(new Error('network unreachable'));
      listChatsSpy.mockRejectedValueOnce(new Error('network unreachable'));
      await useAuthStore.getState().hydrateAuth();
      await new Promise((r) => setTimeout(r, 15));
      expect(readFrame0Snapshot('accA')).not.toBeNull();
      expect(useChatStore.getState().chatsById[101]?.title).toBe('Alice Chat');
      expect(useChatStore.getState().activeChatId).toBe(101);
      expect(useChatStore.getState().messagesByChat[101]?.[0]?.id).toBe(5001);

      // (c) switchAccount(accA -> accB) wipes accA snapshot while preserving & synchronously hydrating accB
      vi.spyOn(adapter, 'connect').mockResolvedValue(undefined);
      let resolveSwitchListChats!: (v: { chats: ChatSummary[]; users: typeof userB[] }) => void;
      listChatsSpy.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSwitchListChats = resolve;
          }),
      );
      await useAuthStore.getState().switchAccount('accB');
      expect(readFrame0Snapshot('accA')).toBeNull();
      expect(readFrame0Snapshot('accB')).not.toBeNull();
      expect(useChatStore.getState().chatsById[101]).toBeUndefined();
      expect(useChatStore.getState().chatsById[202]?.title).toBe('Bob Frame-0 Chat');
      expect(useChatStore.getState().activeChatId).toBe(202);
      expect(useChatStore.getState().messagesByChat[202]?.[0]?.id).toBe(6001);
      await new Promise((r) => setTimeout(r, 15));
      resolveSwitchListChats({ chats: [chatB], users: [userB] });
      await new Promise((r) => setTimeout(r, 15));

      // (c2) switchAccount(activeAccountId) is an idempotent no-op preserving active Frame-0 snapshot & state
      disconnectSpy.mockClear();
      await useAuthStore.getState().switchAccount('accB');
      expect(disconnectSpy).not.toHaveBeenCalled();
      expect(useAuthStore.getState().activeAccountId).toBe('accB');
      expect(readFrame0Snapshot('accB')).not.toBeNull();
      expect(useChatStore.getState().chatsById[202]?.title).toBe('Bob Frame-0 Chat');
      expect(useChatStore.getState().activeChatId).toBe(202);
      expect(useChatStore.getState().messagesByChat[202]?.[0]?.id).toBe(6001);

      // (d) removeAccount(non-active accC) purges accC Frame-0 cache while keeping accB intact
      expect(readFrame0Snapshot('accC')).not.toBeNull();
      await useAuthStore.getState().removeAccount('accC');
      expect(readFrame0Snapshot('accC')).toBeNull();
      expect(readFrame0Snapshot('accB')).not.toBeNull();

      // (e) Null-account resetChatStore() never wipes other accounts' Frame-0 snapshots
      useAuthStore.setState({ activeAccountId: null, isAuthenticated: false });
      useChatStore.setState({ hydratedAccountId: null });
      useChatStore.getState().resetChatStore();
      expect(readFrame0Snapshot('accB')).not.toBeNull();

      clearFrame0Snapshot('all');
    });

    it('safely tolerates poisoned Frame-0 localStorage entries without throwing in readFrame0Snapshot or bootstrapChats', async () => {
      const adapter = getServerAdapter();
      vi.spyOn(adapter, 'getConnectionState').mockReturnValue('connected');
      vi.spyOn(adapter, 'listChats').mockResolvedValue({ chats: [], users: [] });
      vi.spyOn(adapter, 'listFolders').mockResolvedValue([]);
      vi.spyOn(adapter, 'listStories').mockResolvedValue([]);
      vi.spyOn(adapter, 'getDiscoveredPeers').mockReturnValue([]);

      const validChat = makeFakeChat(7, { title: 'Healthy Chat' });
      const poisonedPayloads = [
        'not-valid-json{{{',
        JSON.stringify({ accountId: 'corrupt-acc', chats: [null, { bad: true }] }),
        JSON.stringify({
          accountId: 'corrupt-acc',
          chats: [validChat, null],
          peers: [null, { nope: 1 }],
          activeChatId: 'not-a-number',
          savedAtMs: 'NaN',
        }),
        JSON.stringify({
          accountId: 'corrupt-acc',
          chats: [validChat],
          activeChatId: 7,
          activeChatMessages: [null, { id: 1 }, { id: 2, content: {} }],
        }),
      ];

      for (const payload of poisonedPayloads) {
        useAuthStore.setState({ activeAccountId: 'corrupt-acc', isAuthenticated: true });
        useChatStore.getState().resetChatStore({ preserveFrame0: true });
        localStorage.setItem('gpui_tg_frame0_v1:corrupt-acc', payload);
        expect(() => readFrame0Snapshot('corrupt-acc')).not.toThrow();
        await expect(useChatStore.getState().bootstrapChats()).resolves.toBeUndefined();
      }

      clearFrame0Snapshot('corrupt-acc');
    });

    it('deduplicates initial WS open within 3s of bootstrapChats AND triggers bootstrapChats on disconnect -> reconnect after already-connected bind', async () => {
      const adapter = getServerAdapter();
      let connState: 'connecting' | 'connected' | 'reconnecting' | 'disconnected' = 'connecting';
      const connListeners = new Set<(st: 'connecting' | 'connected' | 'reconnecting' | 'disconnected') => void>();

      vi.spyOn(adapter, 'getConnectionState').mockImplementation(() => connState);
      vi.spyOn(adapter, 'onUpdate').mockReturnValue(() => undefined);
      vi.spyOn(adapter, 'onConnectionStateChange').mockImplementation((cb) => {
        connListeners.add(cb);
        return () => connListeners.delete(cb);
      });
      const listChatsSpy = vi
        .spyOn(adapter, 'listChats')
        .mockResolvedValue({ chats: [makeFakeChat(1)], users: [] });
      vi.spyOn(adapter, 'listFolders').mockResolvedValue([]);
      vi.spyOn(adapter, 'listStories').mockResolvedValue([]);
      vi.spyOn(adapter, 'listMessages').mockResolvedValue({ messages: [], pts: 1, hasMore: false });
      vi.spyOn(adapter, 'getDiscoveredPeers').mockReturnValue([]);

      const emitConn = (next: 'connecting' | 'connected' | 'reconnecting' | 'disconnected') => {
        connState = next;
        for (const fn of connListeners) fn(next);
      };

      // Case A: Initial WS open within 3s of bootstrapChats -> deduplicated (still 1 call)
      useAuthStore.setState({ activeAccountId: 'ws-dedup-a', isAuthenticated: true });
      useChatStore.getState().resetChatStore();
      let unbind = useChatStore.getState().bindRealtimeEvents();
      await useChatStore.getState().bootstrapChats();
      expect(listChatsSpy).toHaveBeenCalledTimes(1);
      emitConn('connected');
      await new Promise((r) => setTimeout(r, 20));
      expect(listChatsSpy).toHaveBeenCalledTimes(1);
      unbind();

      // Case B: bindRealtimeEvents when adapter is ALREADY connected -> first real disconnect -> reconnect MUST trigger bootstrapChats
      listChatsSpy.mockClear();
      connState = 'connected';
      useAuthStore.setState({ activeAccountId: 'ws-dedup-b', isAuthenticated: true });
      useChatStore.getState().resetChatStore();
      unbind = useChatStore.getState().bindRealtimeEvents();
      await useChatStore.getState().bootstrapChats();
      expect(listChatsSpy).toHaveBeenCalledTimes(1);

      emitConn('reconnecting');
      emitConn('connected');
      await new Promise((r) => setTimeout(r, 20));
      expect(listChatsSpy).toHaveBeenCalledTimes(2);
      unbind();
    });

    it('fences async sendText, translateMessage (resolve & reject), and loadOlderMessages against cross-account epoch resets', async () => {
      const adapter = getServerAdapter();
      useAuthStore.setState({ activeAccountId: 'epoch-a', isAuthenticated: true });
      useChatStore.getState().resetChatStore();
      useChatStore.setState({
        chatsById: { 50: makeFakeChat(50, { title: 'Account A Chat' }) },
        orderedChatIds: [50],
        activeChatId: 50,
      });

      let resolveSend!: (v: { message: MessageItem; pts: number }) => void;
      vi.spyOn(adapter, 'sendMessage').mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSend = resolve;
          }),
      );

      let resolveTranslate!: (v: {
        ok: boolean;
        chat_id: number;
        message_id: number;
        original_text: string;
        target_lang: string;
        translated_text: string;
        source_lang: string;
        provider: string;
      }) => void;
      vi.spyOn(adapter, 'translateMessage').mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveTranslate = resolve;
          }),
      );

      let rejectTranslate!: (err: Error) => void;
      vi.spyOn(adapter, 'translateMessage').mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectTranslate = reject;
          }),
      );

      let resolveOlder!: (v: { messages: MessageItem[]; pts: number; hasMore: boolean }) => void;
      vi.spyOn(adapter, 'listMessages').mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOlder = resolve;
          }),
      );

      const sendPromise = useChatStore.getState().sendText(50, 'Secret from Account A');
      const translateOkPromise = useChatStore.getState().translateMessage(50, 77, 'zh-CN');
      const translateErrPromise = useChatStore.getState().translateMessage(50, 78, 'zh-CN');
      const olderPromise = useChatStore.getState().loadOlderMessages(50);

      // Account switch / logout resets chat store & bumps epoch BEFORE in-flight requests settle
      useAuthStore.setState({ activeAccountId: 'epoch-b', isAuthenticated: true });
      useChatStore.getState().resetChatStore();

      resolveSend({ message: makeFakeMessage(50, 901, 'Secret from Account A'), pts: 10 });
      resolveTranslate({
        ok: true,
        chat_id: 50,
        message_id: 77,
        original_text: 'Secret A',
        target_lang: 'zh-CN',
        translated_text: '机密A',
        source_lang: 'en',
        provider: 'magpie',
      });
      rejectTranslate(Object.assign(new Error('provider_not_configured'), { status: 503 }));
      resolveOlder({ messages: [makeFakeMessage(50, 10, 'Older A')], pts: 1, hasMore: false });

      await sendPromise;
      await translateOkPromise;
      await expect(translateErrPromise).rejects.toThrow('provider_not_configured');
      const hasMoreRes = await olderPromise;
      expect(hasMoreRes).toBe(false);

      const stateB = useChatStore.getState();
      expect(stateB.messagesByChat[50]).toBeUndefined();
      expect(stateB.translatedMessagesByKey['50:77']).toBeUndefined();
      expect(stateB.translationErrorByKey['50:78']).toBeUndefined();
      expect(stateB.translatingMessageKeys['50:77']).toBeUndefined();
      expect(stateB.translatingMessageKeys['50:78']).toBeUndefined();
    });

    it('dispatches Web Notification for fast incoming peer/bot replies arriving <1500ms after local sendText', async () => {
      const fired: Array<{ title: string; body?: string }> = [];
      class MockNotification {
        static permission: NotificationPermission = 'granted';
        static requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
        onclick: (() => void) | null = null;
        constructor(title: string, opts?: NotificationOptions) {
          fired.push({ title, body: opts?.body });
        }
      }
      (globalThis as Record<string, unknown>).Notification = MockNotification;
      (globalThis as Record<string, unknown>).document = {
        hidden: true,
        documentElement: {
          lang: 'en-US',
          setAttribute: () => undefined,
          style: { setProperty: () => undefined, removeProperty: () => undefined },
        },
      };

      const listeners = new Set<(ev: UpdateEvent) => void>();
      const adapter = getServerAdapter();
      vi.spyOn(adapter, 'getConnectionState').mockReturnValue('connected');
      vi.spyOn(adapter, 'onUpdate').mockImplementation((fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      });
      vi.spyOn(adapter, 'onConnectionStateChange').mockReturnValue(() => undefined);
      vi.spyOn(adapter, 'sendMessage').mockResolvedValueOnce({
        message: {
          ...makeFakeMessage(1, 500, 'Ping bot'),
          flags: { ...makeFakeMessage(1, 500).flags, is_out: true },
        },
        pts: 2,
      });

      useChatStore.getState().resetChatStore();
      useChatStore.setState({
        activeChatId: 1,
        chatsById: { 1: makeFakeChat(1, { title: 'Fast Bot', isMuted: false }) },
        orderedChatIds: [1],
      });
      useSettingsStore.getState().setNotificationsEnabled(true);
      const unbind = useChatStore.getState().bindRealtimeEvents();

      // Send locally (sets localTabSendTimestampByChat within 1500ms window)
      await useChatStore.getState().sendText(1, 'Ping bot');

      // Fast incoming bot reply arrives immediately (<1500ms) with is_out=false -> MUST still notify!
      for (const fn of listeners) {
        fn({ type: 'NewMessage', data: makeFakeMessage(1, 501, 'Instant bot answer!') });
      }
      expect(fired.length).toBe(1);
      expect(fired[0]?.title).toBe('Fast Bot');
      expect(fired[0]?.body).toBe('Instant bot answer!');
      unbind();
    });

    it('unwraps pre-M1B no-AAD AES-256-GCM vault keys even when userId is passed AND matches Node pbkdf2Sync + hkdfSync for default deriveSplitKeyV2', async () => {
      // 1. Pre-M1B no-AAD AES-256-GCM envelope unwrapped WITH userId passed
      const rootKey = generateVaultRootKey();
      const wrapKey = generateVaultRootKey();
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', wrapKey, nonce);
      const enc = Buffer.concat([cipher.update(rootKey), cipher.final(), cipher.getAuthTag()]);
      const legacyNoAadB64 = bytesToBase64(new Uint8Array(Buffer.concat([nonce, enc])));

      const unwrappedWithUserId = await unwrapVaultRootKey(legacyNoAadB64, wrapKey, 1337);
      expect(bytesToHex(unwrappedWithUserId)).toBe(bytesToHex(rootKey));

      // Modern ChaCha20-Poly1305 wrapped root key STILL rejects wrong userId
      const modernWrapped = await wrapVaultRootKey(rootKey, wrapKey, 1337);
      await expect(unwrapVaultRootKey(modernWrapped, wrapKey, 9999)).rejects.toThrow();

      // 2. Byte-for-byte Node crypto.pbkdf2Sync + crypto.hkdfSync parity with e2e/helpers/server.ts:408-438
      const password = 'sc01-parity-passphrase!';
      const saltRaw = hexToBytes('00112233445566778899aabbccddeeff');
      const saltB64 = bytesToBase64(saltRaw);
      const params = { m_cost_kib: 65536, t_cost: 3, p_cost: 1 };

      const derived = await deriveSplitKeyV2(password, saltB64, params);
      const boundSalt = Buffer.concat([
        Buffer.from('fabushi/split-key-v2|65536|3|1|', 'utf8'),
        Buffer.from(saltRaw),
      ]);
      const masterBits = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), boundSalt, 10_000, 32, 'sha256');
      const expectedVerifier = Buffer.from(
        crypto.hkdfSync(
          'sha256',
          masterBits,
          Buffer.from(saltRaw),
          Buffer.from('fabushi/auth-verifier/v2', 'utf8'),
          32,
        ),
      ).toString('base64');
      expect(derived.authVerifierB64).toBe(expectedVerifier);
    });

    it('rejects NaN, negative, fractional, and >uint32 counters in DesktopDoubleRatchetSession and DesktopSenderKeyState without mutating state', async () => {
      // Double Ratchet setup
      const bobId = await generateIdentityKeyPair(9401);
      const aliceId = await generateIdentityKeyPair(9402);
      const bobPub = toPublishPreKeysRequest(bobId, 'Bob');
      const bobBundle = {
        user_id: 9401,
        device_id: bobId.deviceId,
        device_name: 'Bob',
        identity_key: bobPub.identity_key,
        identity_signing_key: bobPub.identity_signing_key,
        signed_prekey: bobPub.signed_prekey,
        one_time_prekey: bobPub.one_time_prekeys?.[0],
        updated_at_ms: Date.now(),
      };
      const x3dhInit = await x3dhInitiatorDerive({
        initiatorIdentityPrivateJwk: aliceId.dhPrivateKeyJwk,
        initiatorIdentityPublicBase64: aliceId.dhPublicKeyBase64,
        responderBundle: bobBundle,
      });
      const x3dhResp = await x3dhResponderDerive({
        responderIdentityPrivateJwk: bobId.dhPrivateKeyJwk,
        responderIdentityPublicBase64: bobId.dhPublicKeyBase64,
        responderSignedPreKeyPrivateJwk: bobId.signedPreKeyPrivateJwk,
        responderOneTimePreKeyPrivateJwk: bobId.oneTimePreKeys[0]!.privateKeyJwk,
        initiatorIdentityPublicBase64: aliceId.dhPublicKeyBase64,
        initiatorEphemeralPublicBase64: x3dhInit.ephemeralPublicBase64,
      });
      const alice = await DesktopDoubleRatchetSession.initInitiator(
        x3dhInit.sharedSecret,
        bobId.signedPreKeyPublicBase64,
        x3dhInit.associatedData,
      );
      const bob = DesktopDoubleRatchetSession.initResponder(
        x3dhResp.sharedSecret,
        bobId.signedPreKeyPublicBase64,
        bobId.signedPreKeyPrivateJwk,
        x3dhResp.associatedData,
      );
      const m0 = await alice.encrypt('valid-dr-0');

      const badCounters = [Number.NaN, -1, 1.5, 0x1_0000_0000, Number.POSITIVE_INFINITY];
      for (const bad of badCounters) {
        await expect(bob.decrypt({ ...m0.header, msg_num: bad }, m0.ciphertextB64)).rejects.toThrow(
          /Invalid uint32/i,
        );
        await expect(
          bob.decrypt({ ...m0.header, prev_chain_len: bad }, m0.ciphertextB64),
        ).rejects.toThrow(/Invalid uint32/i);
      }
      // Genuine m0 still decrypts cleanly afterward (state unmutated)
      expect(new TextDecoder().decode(await bob.decrypt(m0.header, m0.ciphertextB64))).toBe('valid-dr-0');

      // Group Sender Key setup
      const signPair = await generateEd25519KeyPair();
      const senderSk = DesktopSenderKeyState.createSender({
        chatId: -100999,
        senderUserId: 777,
        senderDeviceId: 'dev-sk',
        signingPublicKeyBase64: signPair.publicKeyBase64,
        signingPrivateKeyJwk: signPair.privateKeyJwk,
        chainId: 12,
      });
      const dist = senderSk.toDistributionMessage();
      for (const bad of badCounters) {
        expect(() => DesktopSenderKeyState.fromDistribution({ ...dist, iteration: bad })).toThrow(
          /Invalid uint32 distribution\.iteration/i,
        );
        expect(() => DesktopSenderKeyState.fromDistribution({ ...dist, chain_id: bad })).toThrow(
          /Invalid uint32 distribution\.chain_id/i,
        );
      }

      const recvSk = DesktopSenderKeyState.fromDistribution(dist);
      const g0 = await senderSk.encrypt('valid-sk-0');

      for (const bad of badCounters) {
        await expect(recvSk.decrypt({ ...g0, iteration: bad })).rejects.toThrow(/Invalid uint32/i);
        await expect(recvSk.decrypt({ ...g0, chain_id: bad })).rejects.toThrow(/Invalid uint32/i);
      }
      // Genuine g0 still decrypts cleanly afterward (state unmutated)
      expect(new TextDecoder().decode(await recvSk.decrypt(g0))).toBe('valid-sk-0');
    });

    it('ignores malformed/null WebSocket frames in HttpWsServerAdapter with zero unhandled rejections and zero malformed onUpdate leaks', async () => {
      const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
      const addr = wss.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      expect(port).toBeGreaterThan(0);

      const unhandledRejections: unknown[] = [];
      const onUnhandled = (reason: unknown) => {
        unhandledRejections.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);

      const receivedUpdates: unknown[] = [];
      const adapter = new HttpWsServerAdapter(`http://127.0.0.1:${port}`);
      adapter.configure({
        serverUrl: `http://127.0.0.1:${port}`,
        token: 'malformed-ws-test-token',
        accountId: 'ws-malformed-acc',
      });

      const unsub = adapter.onUpdate((ev) => {
        receivedUpdates.push(ev);
      });

      const sentinelReceived = new Promise<void>((resolve) => {
        const unsubSentinel = adapter.onUpdate((ev) => {
          if (ev && typeof ev === 'object' && (ev as { type?: string }).type === 'UserCreationChanged') {
            unsubSentinel();
            resolve();
          }
        });
      });

      wss.on('connection', (ws) => {
        const malformedFrames = [
          'null',
          '42',
          '{}',
          '{"type":"Update"}',
          '{"type":"Update","payload":null}',
          '{"type":"Update","payload":{}}',
          '{"type":"AuthOk"}',
          '{"type":"AuthError"}',
          '{"type":"Error"}',
          '{"type":"PtsUpdate"}',
          '{"type":"PtsUpdate","payload":null}',
          '{"type":"Ack"}',
          '{"type":"BrowserRegistered"}',
          '{"type":"BrowserCommand"}',
          '{"type":"BrowserControlRevoked"}',
        ];
        for (const raw of malformedFrames) {
          ws.send(raw);
        }
        // Valid sentinel after all malformed frames
        ws.send(
          JSON.stringify({
            type: 'Update',
            payload: { type: 'UserCreationChanged', data: { creation_id: 'sentinel-ok' } },
          }),
        );
      });

      try {
        await adapter.connect('malformed-ws-test-token');
        await Promise.race([
          sentinelReceived,
          new Promise<void>((_r, reject) =>
            setTimeout(() => reject(new Error('Timed out waiting for WS sentinel frame')), 5000),
          ),
        ]);
        await new Promise((r) => setTimeout(r, 30));

        expect(unhandledRejections).toEqual([]);
        expect(receivedUpdates.length).toBe(1);
        expect((receivedUpdates[0] as { type?: string }).type).toBe('UserCreationChanged');
      } finally {
        unsub();
        await adapter.disconnect().catch(() => undefined);
        process.off('unhandledRejection', onUnhandled);
        await new Promise<void>((resolve) => wss.close(() => resolve()));
      }
    });

    it('applies 1200ms grace period to cold-start disconnected state without browserOfflineEvent or pending outbox, while showing immediately on offline event or queued outbox', () => {
      const t0 = 50_000;
      // Cold-start initial disconnected with browser online and 0 queued outbox -> hidden at 0ms & 1199ms
      const cold0 = evaluateConnectionBannerVisibility({
        connectionState: 'disconnected',
        browserOfflineEvent: false,
        pendingOutboxCount: 0,
        transientStartedAtMs: t0,
        nowMs: t0,
      });
      expect(cold0.visible).toBe(false);
      expect(cold0.immediate).toBe(false);

      const cold1199 = evaluateConnectionBannerVisibility({
        connectionState: 'disconnected',
        browserOfflineEvent: false,
        pendingOutboxCount: 0,
        transientStartedAtMs: t0,
        nowMs: t0 + CONNECTING_BANNER_GRACE_MS - 1,
      });
      expect(cold1199.visible).toBe(false);

      // Genuinely disconnected for >= 1200ms -> visible as 'offline'
      const cold1200 = evaluateConnectionBannerVisibility({
        connectionState: 'disconnected',
        browserOfflineEvent: false,
        pendingOutboxCount: 0,
        transientStartedAtMs: t0,
        nowMs: t0 + CONNECTING_BANNER_GRACE_MS,
      });
      expect(cold1200.visible).toBe(true);
      expect(cold1200.state).toBe('offline');
      expect(cold1200.immediate).toBe(false);

      // Disconnected WITH pending outbox > 0 -> immediate 0ms visible
      const queuedOutbox = evaluateConnectionBannerVisibility({
        connectionState: 'disconnected',
        browserOfflineEvent: false,
        pendingOutboxCount: 2,
        transientStartedAtMs: t0,
        nowMs: t0,
      });
      expect(queuedOutbox.visible).toBe(true);
      expect(queuedOutbox.state).toBe('offline');
      expect(queuedOutbox.immediate).toBe(true);

      // Browser offline event -> immediate 0ms visible regardless of outbox count
      const browserOffline = evaluateConnectionBannerVisibility({
        connectionState: 'disconnected',
        browserOfflineEvent: true,
        pendingOutboxCount: 0,
        transientStartedAtMs: null,
        nowMs: t0,
      });
      expect(browserOffline.visible).toBe(true);
      expect(browserOffline.state).toBe('offline');
      expect(browserOffline.immediate).toBe(true);
    });

    it('guards PtsUpdate/PtsPush with missing or non-numeric pts so chatPtsMap and IndexedDB cursors are never corrupted', async () => {
      const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
      const addr = wss.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      expect(port).toBeGreaterThan(0);

      const unhandledRejections: unknown[] = [];
      const onUnhandled = (reason: unknown) => {
        unhandledRejections.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);

      const adapter = new HttpWsServerAdapter(`http://127.0.0.1:${port}`);
      adapter.configure({
        serverUrl: `http://127.0.0.1:${port}`,
        token: 'pts-guard-token',
        accountId: 'ws-pts-guard-acc',
      });

      const setPtsSpy = vi.spyOn(indexedDbCache, 'setPtsCursor');
      let resolveGapCheck!: () => void;
      const gapChecked = new Promise<void>((resolve) => {
        resolveGapCheck = resolve;
      });
      const getDiffSpy = vi.spyOn(adapter, 'getDifference').mockImplementation(async () => {
        resolveGapCheck();
        return {
          chat_id: 777,
          pts: 15,
          current_pts: 15,
          new_messages: [],
          other_updates: [],
          updates: [],
          has_more: false,
          snapshot_required: false,
        };
      });

      const sentinelReceived = new Promise<void>((resolve) => {
        const unsubSentinel = adapter.onUpdate((ev) => {
          if (ev && typeof ev === 'object' && (ev as { type?: string }).type === 'UserCreationChanged') {
            unsubSentinel();
            resolve();
          }
        });
      });

      wss.on('connection', (ws) => {
        // 1. Valid PtsUpdate seeds chatPtsMap[777] = 10
        ws.send(JSON.stringify({ type: 'PtsUpdate', payload: { chat_id: 777, pts: 10, pts_count: 1 } }));
        // 2. Malformed PtsUpdate/PtsPush frames missing or carrying non-numeric pts MUST NOT overwrite chatPtsMap[777]
        ws.send(JSON.stringify({ type: 'PtsUpdate', payload: { chat_id: 777 } }));
        ws.send(JSON.stringify({ type: 'PtsUpdate', payload: { chat_id: 777, pts: null } }));
        ws.send(JSON.stringify({ type: 'PtsPush', payload: { chat_id: 777, pts: 'corrupt' } }));
        ws.send(JSON.stringify({ type: 'PtsPush', payload: { chat_id: 777, pts: {} } }));
        // 3. Subsequent valid gap PtsUpdate MUST still observe localPts === 10 and invoke getDifference(from_pts: 10)
        ws.send(JSON.stringify({ type: 'PtsUpdate', payload: { chat_id: 777, pts: 15, pts_count: 1 } }));
        // 4. Valid sentinel
        ws.send(
          JSON.stringify({
            type: 'Update',
            payload: { type: 'UserCreationChanged', data: { creation_id: 'pts-guard-ok' } },
          }),
        );
      });

      try {
        await adapter.connect('pts-guard-token');
        await Promise.race([
          Promise.all([gapChecked, sentinelReceived]),
          new Promise<void>((_r, reject) =>
            setTimeout(() => reject(new Error('Timed out waiting for PtsUpdate guard test')), 5000),
          ),
        ]);
        await new Promise((r) => setTimeout(r, 30));

        expect(unhandledRejections).toEqual([]);
        expect(getDiffSpy).toHaveBeenCalledTimes(1);
        expect(getDiffSpy).toHaveBeenCalledWith({ chat_id: 777, from_pts: 10 });
        const ptsCallsFor777 = setPtsSpy.mock.calls.filter(
          (call) => call[0] === 'ws-pts-guard-acc' && call[2] === '777',
        );
        expect(ptsCallsFor777).toEqual([['ws-pts-guard-acc', 10, '777']]);
      } finally {
        await adapter.disconnect().catch(() => undefined);
        process.off('unhandledRejection', onUnhandled);
        await new Promise<void>((resolve) => wss.close(() => resolve()));
      }
    });
  });
});
