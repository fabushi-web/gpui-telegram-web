import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  DEFAULT_ARGON2_KDF_PARAMS,
  formatDeviceSyncCode,
} from '@gpui-telegram/protocol';
import {
  createTelegramServer,
  type TelegramServerInstance,
} from '@gpui-telegram/server';
import {
  fetchOpenGraphPreview,
  isBlockedIpAddress,
} from '../../../apps/server/src/db/queries.js';
import {
  extractRawRequestPath,
  hasRawUpdateAssetTraversal,
  isValidReleaseFilename,
  isValidReleaseTag,
} from '../../../apps/server/src/routes/updates.js';
import {
  decodeCborItem,
  parseWebAuthnAuthenticatorData,
  parseWebAuthnPublicKey,
  verifyWebAuthnSignature,
} from '../../../apps/server/src/utils/crypto.js';
import {
  apiJson,
  buildCoseKeyFromPublicKey,
  buildSignedWebAuthnAssertion,
  buildWebAuthnAttestationObject,
  connectWsAuthenticated,
  createUniqueTestDir,
  encodeCborValue,
  registerTestUser,
  sendRawHttpRequest,
  startEphemeralOtpWebhook,
  type EphemeralOtpWebhook,
} from './_helpers.js';

describe('@gpui-telegram/server — M2 Security, Split-Key V2, User Vault, Device Trust Ring, RBAC, Messaging v1.6.11 & Auto-Update Relay', () => {
  let server: TelegramServerInstance;
  let mailWebhook: EphemeralOtpWebhook;
  let baseUrl = '';
  let wsUrl = '';
  let serverPort = 0;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = createUniqueTestDir('m2-security');
    mailWebhook = await startEphemeralOtpWebhook();
    server = createTelegramServer({
      port: 0,
      host: '127.0.0.1',
      dataDir,
      enableTestReset: true,
      seedDemoData: false,
      allowDemoAuth: false,
      exposeDevOtpCode: false,
      mailWebhookUrl: mailWebhook.url,
    });
    const started = await server.start();
    baseUrl = started.baseUrl;
    wsUrl = started.wsUrl;
    serverPort = started.port;
  });

  afterAll(async () => {
    await server.close();
    await mailWebhook.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // ============================================================================
  // 1. WebAuthn Passkey COSE/SPKI Crypto, Email 2FA, Alipay Hijack & Account Delete
  // ============================================================================
  describe('1. WebAuthn Passkey COSE/SPKI Crypto, Email 2FA, Alipay Anti-Hijack & Account Deletion', () => {
    it('verifies ES256 (attestation + DER + P1363), EdDSA (COSE_Key), and RS256 (SPKI), and rejects forged/replayed/rolled-back assertions', async () => {
      await apiJson(baseUrl, 'POST', '/api/v1/test/reset');
      const user = await registerTestUser(baseUrl, 'pk_crypto_user', { first_name: 'Passkey' });

      // Missing public key on registration -> 400
      const noKeyReg = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/register', {
        token: user.token,
        body: { label: 'Missing Key' },
      });
      expect(noKeyReg.status).toBe(400);

      // (A) ES256 via full WebAuthn attestationObject + register/options
      const regOpts = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/register/options', {
        token: user.token,
      });
      expect(regOpts.status).toBe(200);
      const rpId = String(regOpts.data.rp_id);
      const origin = `http://${rpId}`;

      const es256 = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const es256CredId = crypto.randomBytes(16);
      const es256Cose = buildCoseKeyFromPublicKey(es256.publicKey, -7);
      const attObj = buildWebAuthnAttestationObject({
        rpId,
        credId: es256CredId,
        cosePublicKey: es256Cose,
        signCount: 3,
      });
      const regClientData = Buffer.from(
        JSON.stringify({
          type: 'webauthn.create',
          challenge: regOpts.data.challenge,
          origin,
        }),
        'utf8',
      ).toString('base64url');

      const esReg = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/register/verify', {
        token: user.token,
        body: {
          challenge_id: regOpts.data.challenge_id,
          label: 'ES256 Attested',
          attestationObject: attObj.toString('base64url'),
          clientDataJSON: regClientData,
        },
      });
      expect(esReg.status).toBe(201);
      expect(esReg.data.cose_alg).toBe(-7);
      const esCredIdStr = String(esReg.data.cred_id);

      // Verify ES256 with DER signature & advancing signCount=5
      const c1 = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/login/options', {
        body: { username: user.username },
      });
      const a1 = buildSignedWebAuthnAssertion({
        privateKey: es256.privateKey,
        alg: -7,
        rpId: c1.data.rp_id,
        origin: `http://${c1.data.rp_id}`,
        challenge: c1.data.challenge,
        signCount: 5,
        dsaEncoding: 'der',
      });
      const v1 = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/verify', {
        body: { challenge_id: c1.data.challenge_id, credential_id: esCredIdStr, ...a1 },
      });
      expect(v1.status).toBe(200);
      expect(v1.data.user_id).toBe(user.user_id);

      // Replaying same single-use challenge -> 401
      const replay = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/verify', {
        body: { challenge_id: c1.data.challenge_id, credential_id: esCredIdStr, ...a1 },
      });
      expect(replay.status).toBe(401);

      // Rolled-back signCount (stored=5, new=5 and new=4) -> 401 cloned_authenticator!
      for (const staleCount of [5, 4]) {
        const cStale = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/challenge', {
          body: { username: user.username },
        });
        const aStale = buildSignedWebAuthnAssertion({
          privateKey: es256.privateKey,
          alg: -7,
          rpId: cStale.data.rp_id,
          origin: `http://${cStale.data.rp_id}`,
          challenge: cStale.data.challenge,
          signCount: staleCount,
        });
        const vStale = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/verify', {
          body: { challenge_id: cStale.data.challenge_id, credential_id: esCredIdStr, ...aStale },
        });
        expect(vStale.status).toBe(401);
        expect(vStale.data.error).toBe('cloned_authenticator');
      }

      // ES256 with IEEE P1363 raw 64-byte signature & signCount=6 -> 200
      const cP1363 = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/challenge', {
        body: { username: user.username },
      });
      const aP1363 = buildSignedWebAuthnAssertion({
        privateKey: es256.privateKey,
        alg: -7,
        rpId: cP1363.data.rp_id,
        origin: `http://${cP1363.data.rp_id}`,
        challenge: cP1363.data.challenge,
        signCount: 6,
        dsaEncoding: 'ieee-p1363',
      });
      const vP1363 = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/verify', {
        body: { challenge_id: cP1363.data.challenge_id, credential_id: esCredIdStr, ...aP1363 },
      });
      expect(vP1363.status).toBe(200);

      // Negative assertions: tampered sig, wrong origin, wrong rpIdHash, UP=0 -> ALL 401!
      const badCases: Array<Partial<Parameters<typeof buildSignedWebAuthnAssertion>[0]> & { tamperSig?: boolean }> = [
        { tamperSig: true },
        { origin: 'https://evil.example.com' },
        { rpId: 'evil.example.com' },
        { flags: 0x00 }, // UP=0!
        { type: 'webauthn.create' },
      ];
      for (const bad of badCases) {
        const cBad = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/challenge', {
          body: { username: user.username },
        });
        const aBad = buildSignedWebAuthnAssertion({
          privateKey: es256.privateKey,
          alg: -7,
          rpId: bad.rpId ?? cBad.data.rp_id,
          origin: bad.origin ?? `http://${cBad.data.rp_id}`,
          challenge: cBad.data.challenge,
          signCount: 99,
          flags: bad.flags ?? 0x05,
          type: bad.type ?? 'webauthn.get',
        });
        if (bad.tamperSig) {
          const buf = Buffer.from(aBad.signature, 'base64url');
          buf[0] = buf[0]! ^ 0xff;
          aBad.signature = buf.toString('base64url');
        }
        const vBad = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/verify', {
          body: { challenge_id: cBad.data.challenge_id, credential_id: esCredIdStr, ...aBad },
        });
        expect(vBad.status).toBe(401);
      }

      // (B) EdDSA (Ed25519) via CBOR COSE_Key
      const ed = crypto.generateKeyPairSync('ed25519');
      const edCose = buildCoseKeyFromPublicKey(ed.publicKey, -8);
      const edReg = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/register', {
        token: user.token,
        body: { label: 'Ed25519 Key', public_key_b64: edCose.toString('base64') },
      });
      expect(edReg.status).toBe(201);
      expect(edReg.data.cose_alg).toBe(-8);

      const cEd = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/challenge', { body: {} });
      const aEd = buildSignedWebAuthnAssertion({
        privateKey: ed.privateKey,
        alg: -8,
        rpId: cEd.data.rp_id,
        origin: `http://${cEd.data.rp_id}`,
        challenge: cEd.data.challenge,
        signCount: 1,
      });
      const vEd = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/verify', {
        body: { challenge_id: cEd.data.challenge_id, credential_id: edReg.data.cred_id, ...aEd },
      });
      expect(vEd.status).toBe(200);
      expect(vEd.data.user_id).toBe(user.user_id);

      // (C) RS256 via SPKI DER
      const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const rsaSpki = rsa.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
      const rsaReg = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/register', {
        token: user.token,
        body: { label: 'RS256 Key', public_key_b64: rsaSpki },
      });
      expect(rsaReg.status).toBe(201);
      expect(rsaReg.data.cose_alg).toBe(-257);

      const cRsa = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/challenge', { body: {} });
      const aRsa = buildSignedWebAuthnAssertion({
        privateKey: rsa.privateKey,
        alg: -257,
        rpId: cRsa.data.rp_id,
        origin: `http://${cRsa.data.rp_id}`,
        challenge: cRsa.data.challenge,
        signCount: 1,
      });
      const vRsa = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/verify', {
        body: { challenge_id: cRsa.data.challenge_id, credential_id: rsaReg.data.cred_id, ...aRsa },
      });
      expect(vRsa.status).toBe(200);
      expect(vRsa.data.user_id).toBe(user.user_id);
    });

    it('closes active WS immediately on DELETE /api/v1/account and purges user & vault rows', async () => {
      const victim = await registerTestUser(baseUrl, 'delete_me_user');
      // Seed vault envelope & item so we confirm full purge
      const putEnv = await apiJson(baseUrl, 'PUT', '/api/v1/user-vault/envelope', {
        token: victim.token,
        body: {
          key_version: 1,
          kdf_alg: 'split_key_v2',
          kdf_salt_b64: crypto.randomBytes(16).toString('base64'),
          kdf_m_cost_kib: 65536,
          kdf_t_cost: 3,
          kdf_p_cost: 1,
          wrapped_root_key_b64: crypto.randomBytes(60).toString('base64'),
        },
      });
      expect(putEnv.status).toBe(200);

      const wsConn = await connectWsAuthenticated(wsUrl, victim.token);
      const closedPromise = new Promise<number>((resolve) => {
        wsConn.ws.once('close', (code) => resolve(code));
      });

      const delRes = await apiJson(baseUrl, 'DELETE', '/api/v1/account', {
        token: victim.token,
      });
      expect(delRes.status).toBe(200);
      expect(delRes.data.deleted).toBe(true);

      const closeCode = await closedPromise;
      expect(closeCode).toBe(4001);

      // Token is immediately rejected & login fails
      expect((await apiJson(baseUrl, 'GET', '/api/v1/auth/me', { token: victim.token })).status).toBe(401);
      expect(
        (
          await apiJson(baseUrl, 'POST', '/api/v1/auth/login', {
            body: { username: victim.username, password: victim.password },
          })
        ).status,
      ).toBe(401);

      // Verify SQLite rows purged
      const userRow = server.db
        .prepare(`SELECT 1 FROM users WHERE user_id = ?`)
        .get(victim.user_id);
      const envRow = server.db
        .prepare(`SELECT 1 FROM user_vault_envelopes WHERE user_id = ?`)
        .get(victim.user_id);
      expect(userRow).toBeUndefined();
      expect(envRow).toBeUndefined();
    });
  });

  // ============================================================================
  // 2. Split-Key V2 Zero-Knowledge Auth
  // ============================================================================
  describe('2. Split-Key V2 Zero-Knowledge Auth', () => {
    it('supports anti-enumeration kdf-params, V2 register/email-register/login, V1->V2 upgrade, and password rotation', async () => {
      await apiJson(baseUrl, 'POST', '/api/v1/test/reset');
      mailWebhook.deliveries.length = 0;

      // Anti-enumeration fake salt for unknown usernames (deterministic per username, distinct across usernames, 16 decoded bytes)
      const unkA1 = await apiJson(baseUrl, 'GET', '/api/v1/auth/kdf-params?username=ghost_alpha');
      const unkA2 = await apiJson(baseUrl, 'GET', '/api/v1/auth/kdf-params?username_or_email=ghost_alpha');
      const unkB = await apiJson(baseUrl, 'GET', '/api/v1/auth/kdf-params?username=ghost_beta');
      expect(unkA1.status).toBe(200);
      expect(unkA1.data.auth_version).toBe(2);
      expect(Buffer.from(unkA1.data.auth_salt_b64, 'base64').length).toBe(16);
      expect(unkA1.data.auth_salt_b64).toBe(unkA2.data.auth_salt_b64);
      expect(unkA1.data.auth_salt_b64).not.toBe(unkB.data.auth_salt_b64);

      // Register Split-Key V2 user
      const saltV2 = crypto.randomBytes(16).toString('base64');
      const verifierV2 = crypto.randomBytes(32).toString('base64');
      const regV2 = await apiJson(baseUrl, 'POST', '/api/v1/auth/register', {
        body: {
          username: 'splitkey_v2_user',
          first_name: 'SplitKey',
          auth_version: 2,
          auth_salt_b64: saltV2,
          auth_verifier_b64: verifierV2,
          kdf_params: { m_cost_kib: 32768, t_cost: 2, p_cost: 1 },
        },
      });
      expect(regV2.status).toBe(201);
      expect(regV2.data.auth_version).toBe(2);

      // kdf-params returns exact stored salt & params
      const kdfV2 = await apiJson(baseUrl, 'GET', '/api/v1/auth/kdf-params?username=splitkey_v2_user');
      expect(kdfV2.status).toBe(200);
      expect(kdfV2.data.auth_version).toBe(2);
      expect(kdfV2.data.auth_salt_b64).toBe(saltV2);
      expect(kdfV2.data.kdf_params).toEqual({ m_cost_kib: 32768, t_cost: 2, p_cost: 1 });

      // V2 login rejects raw password with 401, succeeds with auth_verifier_b64
      const badV2Login = await apiJson(baseUrl, 'POST', '/api/v1/auth/login', {
        body: { username: 'splitkey_v2_user', password: verifierV2 },
      });
      expect(badV2Login.status).toBe(401);

      const okV2Login = await apiJson(baseUrl, 'POST', '/api/v1/auth/login', {
        body: { username: 'splitkey_v2_user', auth_verifier_b64: verifierV2 },
      });
      expect(okV2Login.status).toBe(200);
      expect(okV2Login.data.auth_version).toBe(2);

      // Email V2 Register
      const sendEm = await apiJson(baseUrl, 'POST', '/api/v1/auth/email/send-code', {
        body: { email: 'v2mail@fabushi.test' },
      });
      expect(sendEm.status).toBe(200);
      const emCode = String(mailWebhook.deliveries.at(-1)?.code);
      const emV2Salt = crypto.randomBytes(16).toString('base64');
      const emV2Verifier = crypto.randomBytes(32).toString('base64');
      const emRegV2 = await apiJson(baseUrl, 'POST', '/api/v1/auth/email/register', {
        body: {
          email: 'v2mail@fabushi.test',
          code: emCode,
          username: 'email_v2_user',
          auth_version: 2,
          auth_salt_b64: emV2Salt,
          auth_verifier_b64: emV2Verifier,
          kdf_params: DEFAULT_ARGON2_KDF_PARAMS,
        },
      });
      expect(emRegV2.status).toBe(201);
      expect(emRegV2.data.auth_version).toBe(2);

      // V1 -> V2 Upgrade
      const v1User = await registerTestUser(baseUrl, 'legacy_v1_user');
      const kdfV1 = await apiJson(baseUrl, 'GET', '/api/v1/auth/kdf-params?username=legacy_v1_user');
      expect(kdfV1.data.auth_version).toBe(1);

      const badKdfUpgrade = await apiJson(baseUrl, 'POST', '/api/v1/auth/upgrade-split-key', {
        token: v1User.token,
        body: {
          old_password: v1User.password,
          auth_salt_b64: crypto.randomBytes(16).toString('base64'),
          auth_verifier_b64: crypto.randomBytes(32).toString('base64'),
          kdf_params: { m_cost_kib: 128, t_cost: 3, p_cost: 1 }, // below 1024 KiB minimum
        },
      });
      expect(badKdfUpgrade.status).toBe(400);

      const wrongPwdUpgrade = await apiJson(baseUrl, 'POST', '/api/v1/auth/upgrade-split-key', {
        token: v1User.token,
        body: {
          old_password: 'WrongPassword!',
          auth_salt_b64: crypto.randomBytes(16).toString('base64'),
          auth_verifier_b64: crypto.randomBytes(32).toString('base64'),
          kdf_params: DEFAULT_ARGON2_KDF_PARAMS,
        },
      });
      expect(wrongPwdUpgrade.status).toBe(401);

      const upgSalt = crypto.randomBytes(16).toString('base64');
      const upgVerifier = crypto.randomBytes(32).toString('base64');
      const okUpgrade = await apiJson(baseUrl, 'POST', '/api/v1/auth/upgrade-split-key', {
        token: v1User.token,
        body: {
          old_password: v1User.password,
          auth_salt_b64: upgSalt,
          auth_verifier_b64: upgVerifier,
          kdf_params: DEFAULT_ARGON2_KDF_PARAMS,
        },
      });
      expect(okUpgrade.status).toBe(200);
      expect(okUpgrade.data.auth_version).toBe(2);

      // Repeating upgrade returns 409 already_upgraded
      const dupUpgrade = await apiJson(baseUrl, 'POST', '/api/v1/auth/upgrade-split-key', {
        token: v1User.token,
        body: {
          old_password: v1User.password,
          auth_salt_b64: upgSalt,
          auth_verifier_b64: upgVerifier,
          kdf_params: DEFAULT_ARGON2_KDF_PARAMS,
        },
      });
      expect(dupUpgrade.status).toBe(409);
      expect(dupUpgrade.data.error).toBe('already_upgraded');

      // Change Password / Rotate Verifier
      const newSalt = crypto.randomBytes(16).toString('base64');
      const newVerifier = crypto.randomBytes(32).toString('base64');
      const wrongRotate = await apiJson(baseUrl, 'POST', '/api/v1/auth/change-password', {
        token: v1User.token,
        body: {
          old_secret: crypto.randomBytes(32).toString('base64'),
          auth_version: 2,
          new_auth_salt_b64: newSalt,
          new_auth_verifier_b64: newVerifier,
          new_kdf_params: DEFAULT_ARGON2_KDF_PARAMS,
        },
      });
      expect(wrongRotate.status).toBe(401);

      const okRotate = await apiJson(baseUrl, 'POST', '/api/v1/auth/change-password', {
        token: v1User.token,
        body: {
          old_secret: upgVerifier,
          auth_version: 2,
          new_auth_salt_b64: newSalt,
          new_auth_verifier_b64: newVerifier,
          new_kdf_params: DEFAULT_ARGON2_KDF_PARAMS,
        },
      });
      expect(okRotate.status).toBe(200);

      // Old verifier fails, new verifier succeeds
      expect(
        (
          await apiJson(baseUrl, 'POST', '/api/v1/auth/login', {
            body: { username: 'legacy_v1_user', auth_verifier_b64: upgVerifier },
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await apiJson(baseUrl, 'POST', '/api/v1/auth/login', {
            body: { username: 'legacy_v1_user', auth_verifier_b64: newVerifier },
          })
        ).status,
      ).toBe(200);
    });
  });

  // ============================================================================
  // 3. Per-User E2EE Vault Envelope, Revisioned Items & X25519 Device Trust Ring
  // ============================================================================
  describe('3. Per-User E2EE Vault Envelope, Revisioned Items (up to 24 MiB) & X25519 Device Trust Ring', () => {
    it('enforces envelope validation, monotonic revisions, 409 conflicts, 10 MiB payload support, cross-user isolation, and one-time Device Trust Ring consumption', async () => {
      await apiJson(baseUrl, 'POST', '/api/v1/test/reset');
      const userA = await registerTestUser(baseUrl, 'vault_user_a');
      const userB = await registerTestUser(baseUrl, 'vault_user_b');

      // Envelope initially null
      const initEnv = await apiJson(baseUrl, 'GET', '/api/v1/user-vault/envelope', {
        token: userA.token,
      });
      expect(initEnv.status).toBe(200);
      expect(initEnv.data.envelope).toBeNull();

      // Reject invalid key_version, invalid kdf_alg, out-of-bounds Argon2id, and device_keychain_v2 missing recovery key
      expect(
        (
          await apiJson(baseUrl, 'PUT', '/api/v1/user-vault/envelope', {
            token: userA.token,
            body: {
              key_version: 0,
              kdf_alg: 'split_key_v2',
              kdf_salt_b64: crypto.randomBytes(16).toString('base64'),
              kdf_m_cost_kib: 65536,
              kdf_t_cost: 3,
              kdf_p_cost: 1,
              wrapped_root_key_b64: crypto.randomBytes(60).toString('base64'),
            },
          })
        ).status,
      ).toBe(400);

      expect(
        (
          await apiJson(baseUrl, 'PUT', '/api/v1/user-vault/envelope', {
            token: userA.token,
            body: {
              key_version: 1,
              kdf_alg: 'pbkdf2_unsupported',
              kdf_salt_b64: crypto.randomBytes(16).toString('base64'),
              kdf_m_cost_kib: 65536,
              kdf_t_cost: 3,
              kdf_p_cost: 1,
              wrapped_root_key_b64: crypto.randomBytes(60).toString('base64'),
            },
          })
        ).status,
      ).toBe(400);

      expect(
        (
          await apiJson(baseUrl, 'PUT', '/api/v1/user-vault/envelope', {
            token: userA.token,
            body: {
              key_version: 1,
              kdf_alg: 'device_keychain_v2',
              kdf_salt_b64: '',
              kdf_m_cost_kib: 65536,
              kdf_t_cost: 3,
              kdf_p_cost: 1,
              wrapped_root_key_b64: '',
            },
          })
        ).status,
      ).toBe(400);

      // Valid 60-byte wrapped root key envelope succeeds
      const wrapped60 = crypto.randomBytes(60).toString('base64');
      const envSalt = crypto.randomBytes(16).toString('base64');
      const putEnv = await apiJson(baseUrl, 'PUT', '/api/v1/user-vault/envelope', {
        token: userA.token,
        body: {
          key_version: 1,
          kdf_alg: 'split_key_v2',
          kdf_salt_b64: envSalt,
          kdf_m_cost_kib: 65536,
          kdf_t_cost: 3,
          kdf_p_cost: 1,
          wrapped_root_key_b64: wrapped60,
        },
      });
      expect(putEnv.status).toBe(200);
      expect(putEnv.data.envelope.wrapped_root_key_b64).toBe(wrapped60);

      // Vault Items CRUD + optimistic concurrency + traversal/validation + 10 MiB payload (> 8 MiB!)
      const nonce12 = crypto.randomBytes(12).toString('base64');
      const ct1 = crypto.randomBytes(48).toString('base64');

      // Invalid category, traversal key (`..` via raw TCP!), invalid base64, oversized nonce -> 400
      expect(
        (
          await apiJson(baseUrl, 'PUT', '/api/v1/user-vault/items/bad_cat/entry1', {
            token: userA.token,
            body: { nonce_b64: nonce12, ciphertext_b64: ct1 },
          })
        ).status,
      ).toBe(400);

      const rawVaultTraversal = await sendRawHttpRequest(
        serverPort,
        'PUT',
        '/api/v1/user-vault/items/password/../escape',
        { Authorization: `Bearer ${userA.token}`, 'Content-Length': '0' },
      );
      expect(rawVaultTraversal.statusCode).toBe(400);

      expect(
        (
          await apiJson(baseUrl, 'PUT', '/api/v1/user-vault/items/password/bad..key', {
            token: userA.token,
            body: { nonce_b64: nonce12, ciphertext_b64: ct1 },
          })
        ).status,
      ).toBe(400);

      expect(
        (
          await apiJson(baseUrl, 'PUT', '/api/v1/user-vault/items/password/entry_bad_b64', {
            token: userA.token,
            body: { nonce_b64: 'not!valid!b64', ciphertext_b64: ct1 },
          })
        ).status,
      ).toBe(400);

      expect(
        (
          await apiJson(baseUrl, 'PUT', '/api/v1/user-vault/items/password/entry_big_nonce', {
            token: userA.token,
            body: { nonce_b64: crypto.randomBytes(129).toString('base64'), ciphertext_b64: ct1 },
          })
        ).status,
      ).toBe(400);

      const put1 = await apiJson(baseUrl, 'PUT', '/api/v1/user-vault/items/password/github:main', {
        token: userA.token,
        body: { expected_revision: 0, nonce_b64: nonce12, ciphertext_b64: ct1 },
      });
      expect(put1.status).toBe(200);
      expect(put1.data.revision).toBe(1);

      // Stale expected_revision -> 409 revision_conflict
      const conflict = await apiJson(
        baseUrl,
        'PUT',
        '/api/v1/user-vault/items/password/github:main',
        {
          token: userA.token,
          body: { expected_revision: 0, nonce_b64: nonce12, ciphertext_b64: ct1 },
        },
      );
      expect(conflict.status).toBe(409);
      expect(conflict.data.error).toBe('revision_conflict');

      // Large valid payload (10 MiB decoded ciphertext > 8 MiB default JSON cap!) succeeds without 413
      const tenMibCiphertextB64 = Buffer.alloc(10 * 1024 * 1024, 0xab).toString('base64');
      const putBig = await apiJson(
        baseUrl,
        'PUT',
        '/api/v1/user-vault/items/browser_cookie/large_jar_10m',
        {
          token: userA.token,
          body: { expected_revision: 0, nonce_b64: nonce12, ciphertext_b64: tenMibCiphertextB64 },
        },
      );
      expect(putBig.status).toBe(200);
      expect(putBig.data.revision).toBe(2);

      // Tombstone delete bumps revision to 3
      const delItem = await apiJson(
        baseUrl,
        'DELETE',
        '/api/v1/user-vault/items/password/github:main?expected_revision=1',
        { token: userA.token },
      );
      expect(delItem.status).toBe(200);
      expect(delItem.data.revision).toBe(3);

      // Incremental pull since_revision=2 returns ONLY tombstone rev 3; User B sees 0 items
      const deltaA = await apiJson(
        baseUrl,
        'GET',
        '/api/v1/user-vault/items?since_revision=2&category=password',
        { token: userA.token },
      );
      expect(deltaA.status).toBe(200);
      expect(deltaA.data.latest_revision).toBe(3);
      expect(deltaA.data.items).toHaveLength(1);
      expect(deltaA.data.items[0].deleted).toBe(true);

      const itemsB = await apiJson(baseUrl, 'GET', '/api/v1/user-vault/items', {
        token: userB.token,
      });
      expect(itemsB.status).toBe(200);
      expect(itemsB.data.items).toEqual([]);

      // X25519 Device Trust Ring
      // Reject all-zero & RFC 7748 low-order point pubkeys
      const zeroKeyB64 = Buffer.alloc(32, 0).toString('base64');
      const lowOrderB64 = Buffer.from(
        'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800',
        'hex',
      ).toString('base64');
      expect(
        (
          await apiJson(baseUrl, 'POST', '/api/v1/user-vault/device-sync/request', {
            token: userA.token,
            body: { device_name: 'Bad Zero', device_public_key_b64: zeroKeyB64 },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await apiJson(baseUrl, 'POST', '/api/v1/user-vault/device-sync/request', {
            token: userA.token,
            body: { device_name: 'Bad LowOrder', device_public_key_b64: lowOrderB64 },
          })
        ).status,
      ).toBe(400);

      // Real X25519 pubkey -> dsr_* + NNN-NNN matching formatDeviceSyncCode
      const reqKp = crypto.generateKeyPairSync('x25519');
      const reqPubRaw = reqKp.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
      const reqPubB64 = reqPubRaw.toString('base64');

      const dsReq = await apiJson(baseUrl, 'POST', '/api/v1/user-vault/device-sync/request', {
        token: userA.token,
        body: { device_name: 'MacBook Pro M4', device_public_key_b64: reqPubB64 },
      });
      expect(dsReq.status).toBe(200);
      expect(String(dsReq.data.request_id).startsWith('dsr_')).toBe(true);
      expect(dsReq.data.verification_code).toBe(formatDeviceSyncCode(reqPubRaw));
      const reqId = String(dsReq.data.request_id);

      const pending = await apiJson(baseUrl, 'GET', '/api/v1/user-vault/device-sync/pending', {
        token: userA.token,
      });
      expect(pending.status).toBe(200);
      expect(pending.data.items.some((i: any) => i.request_id === reqId)).toBe(true);

      // Cross-user isolation: User B gets 403 on status/approve/deny
      const apprKp = crypto.generateKeyPairSync('x25519');
      const apprPubB64 = apprKp.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
      const encRootB64 = crypto.randomBytes(48).toString('base64');
      const dsNonceB64 = crypto.randomBytes(12).toString('base64');

      expect(
        (
          await apiJson(baseUrl, 'GET', `/api/v1/user-vault/device-sync/${reqId}/status`, {
            token: userB.token,
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await apiJson(baseUrl, 'POST', `/api/v1/user-vault/device-sync/${reqId}/approve`, {
            token: userB.token,
            body: {
              approver_ephemeral_pub_b64: apprPubB64,
              encrypted_root_key_b64: encRootB64,
              nonce_b64: dsNonceB64,
            },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await apiJson(baseUrl, 'POST', `/api/v1/user-vault/device-sync/${reqId}/deny`, {
            token: userB.token,
          })
        ).status,
      ).toBe(403);

      // User A approves -> first status read returns ciphertext & atomically wipes SQLite columns!
      const apprOk = await apiJson(
        baseUrl,
        'POST',
        `/api/v1/user-vault/device-sync/${reqId}/approve`,
        {
          token: userA.token,
          body: {
            approver_ephemeral_pub_b64: apprPubB64,
            encrypted_root_key_b64: encRootB64,
            nonce_b64: dsNonceB64,
          },
        },
      );
      expect(apprOk.status).toBe(200);
      expect(apprOk.data.status).toBe('approved');

      const status1 = await apiJson(
        baseUrl,
        'GET',
        `/api/v1/user-vault/device-sync/${reqId}/status`,
        { token: userA.token },
      );
      expect(status1.status).toBe(200);
      expect(status1.data.status).toBe('approved');
      expect(status1.data.encrypted_root_key_b64).toBe(encRootB64);
      expect(status1.data.approver_ephemeral_pub_b64).toBe(apprPubB64);
      expect(status1.data.nonce_b64).toBe(dsNonceB64);

      // Second read returns `consumed` with zero ciphertext, AND DB columns are NULL!
      const status2 = await apiJson(
        baseUrl,
        'GET',
        `/api/v1/user-vault/device-sync/${reqId}/status`,
        { token: userA.token },
      );
      expect(status2.status).toBe(200);
      expect(status2.data.status).toBe('consumed');
      expect(status2.data.encrypted_root_key_b64).toBeUndefined();

      const dbDsRow = server.db
        .prepare(
          `SELECT status, approver_ephemeral_pub_b64, encrypted_root_key_b64, nonce_b64
           FROM vault_device_sync_requests WHERE request_id = ?`,
        )
        .get(reqId) as Record<string, unknown>;
      expect(dbDsRow.status).toBe('consumed');
      expect(dbDsRow.approver_ephemeral_pub_b64).toBeNull();
      expect(dbDsRow.encrypted_root_key_b64).toBeNull();
      expect(dbDsRow.nonce_b64).toBeNull();

      // Deny & Expiry checks
      const dsReq2 = await apiJson(baseUrl, 'POST', '/api/v1/user-vault/device-sync/request', {
        token: userA.token,
        body: { device_name: 'iPad Deny', device_public_key_b64: reqPubB64 },
      });
      const denyRes = await apiJson(
        baseUrl,
        'POST',
        `/api/v1/user-vault/device-sync/${dsReq2.data.request_id}/deny`,
        { token: userA.token },
      );
      expect(denyRes.status).toBe(200);
      expect(denyRes.data.status).toBe('denied');

      const dsReq3 = await apiJson(baseUrl, 'POST', '/api/v1/user-vault/device-sync/request', {
        token: userA.token,
        body: { device_name: 'Expired Device', device_public_key_b64: reqPubB64 },
      });
      server.db
        .prepare(`UPDATE vault_device_sync_requests SET expires_at = ? WHERE request_id = ?`)
        .run(Math.floor(Date.now() / 1000) - 10, dsReq3.data.request_id);
      const expiredApprove = await apiJson(
        baseUrl,
        'POST',
        `/api/v1/user-vault/device-sync/${dsReq3.data.request_id}/approve`,
        {
          token: userA.token,
          body: {
            approver_ephemeral_pub_b64: apprPubB64,
            encrypted_root_key_b64: encRootB64,
            nonce_b64: dsNonceB64,
          },
        },
      );
      expect(expiredApprove.status).toBe(410);
      expect(expiredApprove.data.error).toBe('request_expired');
    });
  });

  // ============================================================================
  // 4. Channel, Forum Topic, Message Edit, Pin, Invite, @username RBAC & WS Takeover
  // ============================================================================
  describe('4. Channel, Forum Topic, Edit/Delete/Pin/Invite & @username RBAC + WS Takeover', () => {
    it('enforces public vs private channel RBAC, forum closed-topic RBAC, message edit ownership, @username validation, and WS MiniAppTakeoverState broadcast', async () => {
      await apiJson(baseUrl, 'POST', '/api/v1/test/reset');
      const owner = await registerTestUser(baseUrl, 'rbac_owner', { first_name: 'Owner' });
      const subscriber = await registerTestUser(baseUrl, 'rbac_sub', { first_name: 'Subscriber' });
      const outsider = await registerTestUser(baseUrl, 'rbac_out', { first_name: 'Outsider' });

      // (A) Public channel (with @username)
      const pubChan = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
        token: owner.token,
        body: { title: 'Public Broadcast', chat_type: 3, username: 'pub_broadcast_chan' },
      });
      expect(pubChan.status).toBe(201);
      const pubId = pubChan.data.chat_id as number;

      const ownerPost = await apiJson(baseUrl, 'POST', `/api/v1/chats/${pubId}/messages`, {
        token: owner.token,
        body: { text: 'Official Announcement #1' },
      });
      expect(ownerPost.status).toBe(201);
      const postId = ownerPost.data.message.id as number;

      // Non-member can read public channel details & messages (200)
      expect((await apiJson(baseUrl, 'GET', `/api/v1/chats/${pubId}`, { token: outsider.token })).status).toBe(200);
      expect((await apiJson(baseUrl, 'GET', `/api/v1/chats/${pubId}/messages`, { token: outsider.token })).status).toBe(200);

      // Non-member CANNOT write, edit, delete, pin, or create invite -> 403!
      expect((await apiJson(baseUrl, 'POST', `/api/v1/chats/${pubId}/messages`, { token: outsider.token, body: { text: 'Spam' } })).status).toBe(403);
      expect((await apiJson(baseUrl, 'PATCH', `/api/v1/chats/${pubId}/messages/${postId}`, { token: outsider.token, body: { text: 'Hack' } })).status).toBe(403);
      expect((await apiJson(baseUrl, 'DELETE', `/api/v1/chats/${pubId}/messages/${postId}?for_everyone=true`, { token: outsider.token })).status).toBe(403);
      expect((await apiJson(baseUrl, 'POST', `/api/v1/chats/${pubId}/pins`, { token: outsider.token, body: { message_id: postId } })).status).toBe(403);

      // Subscriber joins public channel -> STILL gets 403 on write/edit/delete/pin/invite/patch-meta & WS SendMessage!
      const joinPub = await apiJson(baseUrl, 'POST', `/api/v1/chats/${pubId}/join`, { token: subscriber.token });
      expect(joinPub.status).toBe(200);

      expect((await apiJson(baseUrl, 'POST', `/api/v1/chats/${pubId}/messages`, { token: subscriber.token, body: { text: 'Sub post' } })).status).toBe(403);
      expect((await apiJson(baseUrl, 'PATCH', `/api/v1/chats/${pubId}/messages/${postId}`, { token: subscriber.token, body: { text: 'Sub edit' } })).status).toBe(403);
      expect((await apiJson(baseUrl, 'DELETE', `/api/v1/chats/${pubId}/messages/${postId}?for_everyone=true`, { token: subscriber.token })).status).toBe(403);
      expect((await apiJson(baseUrl, 'POST', `/api/v1/chats/${pubId}/pins`, { token: subscriber.token, body: { message_id: postId } })).status).toBe(403);
      expect((await apiJson(baseUrl, 'POST', `/api/v1/chats/${pubId}/invites`, { token: subscriber.token, body: {} })).status).toBe(403);
      expect((await apiJson(baseUrl, 'PATCH', `/api/v1/chats/${pubId}`, { token: subscriber.token, body: { title: 'Hijack' } })).status).toBe(403);

      // WS SendMessage into public channel as subscriber returns Error code 403
      const subWs = await connectWsAuthenticated(wsUrl, subscriber.token);
      try {
        subWs.ws.send(
          JSON.stringify({
            type: 'SendMessage',
            payload: { chat_id: pubId, client_nonce: 901, text: 'WS channel spam' },
          }),
        );
        const wsErr = await subWs.waitForFrame((f) => f.type === 'Error');
        expect(wsErr.payload.code).toBe(403);
      } finally {
        subWs.ws.close();
      }

      // (B) Private channel (no @username) -> non-member gets 403 on ALL reads & writes!
      const privChan = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
        token: owner.token,
        body: { title: 'Private Vault Channel', chat_type: 3 },
      });
      expect(privChan.status).toBe(201);
      const privId = privChan.data.chat_id as number;
      expect((await apiJson(baseUrl, 'GET', `/api/v1/chats/${privId}`, { token: outsider.token })).status).toBe(403);
      expect((await apiJson(baseUrl, 'GET', `/api/v1/chats/${privId}/messages`, { token: outsider.token })).status).toBe(403);
      expect((await apiJson(baseUrl, 'GET', `/api/v1/chats/${privId}/statistics`, { token: outsider.token })).status).toBe(403);
      expect((await apiJson(baseUrl, 'GET', `/api/v1/chats/${privId}/export`, { token: outsider.token })).status).toBe(403);
      expect((await apiJson(baseUrl, 'POST', `/api/v1/chats/${privId}/messages`, { token: outsider.token, body: { text: 'No' } })).status).toBe(403);

      // (C) Forum Supergroup: non-admin cannot create/close/delete topics or post in closed topic!
      const forum = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
        token: owner.token,
        body: { title: 'Forum RBAC', chat_type: 2, is_forum: true, member_ids: [subscriber.user_id] },
      });
      const forumId = forum.data.chat_id as number;
      expect((await apiJson(baseUrl, 'POST', `/api/v1/chats/${forumId}/topics`, { token: subscriber.token, body: { title: 'Sub topic' } })).status).toBe(403);

      const topic = await apiJson(baseUrl, 'POST', `/api/v1/chats/${forumId}/topics`, {
        token: owner.token,
        body: { title: 'Release Notes' },
      });
      expect(topic.status).toBe(201);
      const topicId = topic.data.topic_id as number;

      expect((await apiJson(baseUrl, 'PATCH', `/api/v1/chats/${forumId}/topics/${topicId}`, { token: subscriber.token, body: { is_closed: true } })).status).toBe(403);
      expect((await apiJson(baseUrl, 'DELETE', `/api/v1/chats/${forumId}/topics/${topicId}`, { token: subscriber.token })).status).toBe(403);

      // Owner closes topic -> non-admin posting into closed topic returns 403
      const closeRes = await apiJson(baseUrl, 'PATCH', `/api/v1/chats/${forumId}/topics/${topicId}`, {
        token: owner.token,
        body: { is_closed: true },
      });
      expect(closeRes.status).toBe(200);
      expect(
        (
          await apiJson(baseUrl, 'POST', `/api/v1/chats/${forumId}/messages`, {
            token: subscriber.token,
            body: { text: 'Posting into closed topic', topic_id: topicId },
          })
        ).status,
      ).toBe(403);

      // (D) DM Message Edit RBAC: neither peer nor DM creator can edit the other's message!
      const dm = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
        token: owner.token,
        body: { chat_type: 0, peer_user_id: subscriber.user_id },
      });
      const dmId = dm.data.chat_id as number;
      const mOwner = await apiJson(baseUrl, 'POST', `/api/v1/chats/${dmId}/messages`, {
        token: owner.token,
        body: { text: 'Owner msg' },
      });
      const mSub = await apiJson(baseUrl, 'POST', `/api/v1/chats/${dmId}/messages`, {
        token: subscriber.token,
        body: { text: 'Sub msg' },
      });
      expect((await apiJson(baseUrl, 'PATCH', `/api/v1/chats/${dmId}/messages/${mOwner.data.message.id}`, { token: subscriber.token, body: { text: 'Tamper' } })).status).toBe(403);
      expect((await apiJson(baseUrl, 'PATCH', `/api/v1/chats/${dmId}/messages/${mSub.data.message.id}`, { token: owner.token, body: { text: 'Tamper' } })).status).toBe(403);

      // (E) @username validation across chats & profile
      for (const badU of ['ab', 'bad user!', '@@double']) {
        expect((await apiJson(baseUrl, 'POST', '/api/v1/chats', { token: owner.token, body: { title: 'BadU', chat_type: 3, username: badU } })).status).toBe(400);
        expect((await apiJson(baseUrl, 'PATCH', `/api/v1/chats/${pubId}`, { token: owner.token, body: { username: badU } })).status).toBe(400);
        expect((await apiJson(baseUrl, 'PATCH', '/api/v1/users/me', { token: owner.token, body: { username: badU } })).status).toBe(400);
      }

      // (F) WS 2-client MiniAppTakeoverState -> Update(MiniAppControlStatus)
      const wsA = await connectWsAuthenticated(wsUrl, owner.token);
      const wsB = await connectWsAuthenticated(wsUrl, owner.token);
      try {
        wsA.ws.send(
          JSON.stringify({
            type: 'MiniAppTakeoverState',
            payload: {
              bot_username: 'FabushiBot',
              short_name: 'fabushi',
              chat_id: dmId,
              bot_user_id: 777002,
              mode: 'user_takeover',
              user_note: 'Manual review in progress',
            },
          }),
        );
        const ctrlFrame = await wsB.waitForFrame(
          (f) => f.type === 'Update' && f.payload?.type === 'MiniAppControlStatus',
        );
        expect(ctrlFrame.payload.data.bot_username).toBe('FabushiBot');
        expect(ctrlFrame.payload.data.mode).toBe('user_takeover');
        expect(ctrlFrame.payload.data.status_text).toBe('Manual review in progress');
      } finally {
        wsA.ws.close();
        wsB.ws.close();
      }
    });
  });

  // ============================================================================
  // 5. Messaging v1.6.11, archive-local-bot-reply, Polls, SSRF OpenGraph & Ed25519 PreKeys
  // ============================================================================
  describe('5. Messaging v1.6.11, archive-local-bot-reply, Polls, SSRF OpenGraph & Ed25519 PreKeys', () => {
    it('handles client_nonce chat dedup, CJK/Latin auto-title, strict message nonce, skip_server_bot_reply, archive-local-bot-reply, and Poll lifecycle', async () => {
      await apiJson(baseUrl, 'POST', '/api/v1/test/reset');
      const creator = await registerTestUser(baseUrl, 'msg_creator', { first_name: 'Alice' });
      const zh1 = await registerTestUser(baseUrl, 'zh_user_1', { first_name: '张伟' });
      const zh2 = await registerTestUser(baseUrl, 'zh_user_2', { first_name: '李娜' });
      const en1 = await registerTestUser(baseUrl, 'en_user_1', { first_name: 'Charlie' });
      const en2 = await registerTestUser(baseUrl, 'en_user_2', { first_name: 'Diana' });
      const long1 = await registerTestUser(baseUrl, 'long_u1', {
        first_name: 'AlexanderTheGreatLongFirstNameOne',
      });
      const long2 = await registerTestUser(baseUrl, 'long_u2', {
        first_name: 'BartholomewVeryLongFirstNameTwo',
      });
      const long3 = await registerTestUser(baseUrl, 'long_u3', {
        first_name: 'ConstantinopleExtraLongFirstNameThree',
      });

      // UUID client_nonce dedup on POST /api/v1/chats/create
      const nonceUuid = crypto.randomUUID();
      const c1 = await apiJson(baseUrl, 'POST', '/api/v1/chats/create', {
        token: creator.token,
        body: { chat_type: 1, member_ids: [zh1.user_id, zh2.user_id], client_nonce: nonceUuid },
      });
      expect(c1.status).toBe(201);
      expect(c1.data.title).toBe('张伟、李娜');

      const c1Dup = await apiJson(baseUrl, 'POST', '/api/v1/chats/create', {
        token: creator.token,
        body: { chat_type: 1, member_ids: [zh1.user_id, zh2.user_id], client_nonce: nonceUuid },
      });
      expect(c1Dup.status).toBe(201);
      expect(c1Dup.data.chat_id).toBe(c1.data.chat_id);

      // Latin auto-title & single-member includes creator & >72 char truncation
      const latinGrp = await apiJson(baseUrl, 'POST', '/api/v1/chats/create', {
        token: creator.token,
        body: { chat_type: 1, member_ids: [en1.user_id, en2.user_id] },
      });
      expect(latinGrp.status).toBe(201);
      expect(latinGrp.data.title).toBe('Charlie, Diana');

      const singleGrp = await apiJson(baseUrl, 'POST', '/api/v1/chats/create', {
        token: creator.token,
        body: { chat_type: 1, member_ids: [en1.user_id] },
      });
      expect(singleGrp.status).toBe(201);
      expect(singleGrp.data.title).toBe('Charlie, Alice');

      const longGrp = await apiJson(baseUrl, 'POST', '/api/v1/chats/create', {
        token: creator.token,
        body: { chat_type: 1, member_ids: [long1.user_id, long2.user_id, long3.user_id] },
      });
      expect(longGrp.status).toBe(201);
      expect(Array.from(String(longGrp.data.title)).length).toBeLessThanOrEqual(72);
      expect(String(longGrp.data.title).endsWith('…')).toBe(true);

      // Message client_nonce validation, idempotency, conflict & skip_server_bot_reply
      const chatId = c1.data.chat_id as number;
      for (const badNonce of [0, -1, 'abc', 1.5]) {
        const badRes = await apiJson(baseUrl, 'POST', `/api/v1/chats/${chatId}/messages`, {
          token: creator.token,
          body: { text: 'bad nonce', client_nonce: badNonce },
        });
        expect(badRes.status).toBe(400);
        expect(badRes.data.error).toBe('invalid_nonce');
      }

      const m1 = await apiJson(baseUrl, 'POST', `/api/v1/chats/${chatId}/messages`, {
        token: creator.token,
        body: { text: 'Idempotent payload', client_nonce: 777111 },
      });
      expect(m1.status).toBe(201);
      expect(m1.data.duplicate).toBe(false);

      const m1Dup = await apiJson(baseUrl, 'POST', `/api/v1/chats/${chatId}/messages`, {
        token: creator.token,
        body: { text: 'Idempotent payload', client_nonce: 777111 },
      });
      expect(m1Dup.status).toBe(200);
      expect(m1Dup.data.duplicate).toBe(true);
      expect(m1Dup.data.pts_count).toBe(0);
      expect(m1Dup.data.message_id).toBe(m1.data.message_id);

      // Same nonce + different text OR different chat -> 409 nonce_conflict
      expect(
        (
          await apiJson(baseUrl, 'POST', `/api/v1/chats/${chatId}/messages`, {
            token: creator.token,
            body: { text: 'Different text', client_nonce: 777111 },
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await apiJson(baseUrl, 'POST', `/api/v1/chats/${latinGrp.data.chat_id}/messages`, {
            token: creator.token,
            body: { text: 'Idempotent payload', client_nonce: 777111 },
          })
        ).status,
      ).toBe(409);

      // skip_server_bot_reply suppresses @BotFather server reply
      const bfChat = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
        token: creator.token,
        body: { chat_type: 0, peer_user_id: 777001 },
      });
      const bfChatId = bfChat.data.chat_id as number;
      await apiJson(baseUrl, 'POST', `/api/v1/chats/${bfChatId}/messages`, {
        token: creator.token,
        body: { text: '/start', skip_server_bot_reply: true },
      });
      await new Promise((r) => setTimeout(r, 120));
      const bfHist = await apiJson(baseUrl, 'GET', `/api/v1/chats/${bfChatId}/messages`, {
        token: creator.token,
      });
      expect(bfHist.data.messages).toHaveLength(1);
      expect(bfHist.data.messages[0].sender_id).toBe(creator.user_id);

      // archive-local-bot-reply: archives as 777000, emits PtsPush, isolated per-caller dedup, RBAC guards
      const creatorWs = await connectWsAuthenticated(wsUrl, creator.token);
      try {
        const arch1 = await apiJson(
          baseUrl,
          'POST',
          `/api/v1/chats/${chatId}/messages/archive-local-bot-reply`,
          {
            token: creator.token,
            body: {
              bot_user_id: 777000,
              text: 'Local Hermes archived summary',
              client_nonce: 555001,
            },
          },
        );
        expect(arch1.status).toBe(200);
        expect(arch1.data.message_id).toBeGreaterThan(0);

        const pushFrame = await creatorWs.waitForFrame(
          (f) =>
            f.type === 'PtsPush' &&
            f.payload.chat_id === chatId &&
            f.payload.event?.data?.id === arch1.data.message_id,
        );
        expect(pushFrame.payload.event.data.sender_id).toBe(777000);

        // Dedup same (caller, chat, bot, nonce)
        const archDup = await apiJson(
          baseUrl,
          'POST',
          `/api/v1/chats/${chatId}/messages/archive-local-bot-reply`,
          {
            token: creator.token,
            body: {
              bot_user_id: 777000,
              text: 'Local Hermes archived summary',
              client_nonce: 555001,
            },
          },
        );
        expect(archDup.status).toBe(200);
        expect(archDup.data.message_id).toBe(arch1.data.message_id);

        // User zh1 using the SAME client_nonce=555001 must NOT collide with creator's dedup!
        const archOtherUser = await apiJson(
          baseUrl,
          'POST',
          `/api/v1/chats/${chatId}/messages/archive-local-bot-reply`,
          {
            token: zh1.token,
            body: {
              bot_user_id: 777000,
              text: 'Second user archived reply',
              client_nonce: 555001,
            },
          },
        );
        expect(archOtherUser.status).toBe(200);
        expect(archOtherUser.data.message_id).not.toBe(arch1.data.message_id);

        // Rejects non-member (403), BotFather 777001 (403), human user (403), invalid text/nonce (400)
        expect(
          (
            await apiJson(
              baseUrl,
              'POST',
              `/api/v1/chats/${chatId}/messages/archive-local-bot-reply`,
              { token: en1.token, body: { bot_user_id: 777000, text: 'Not a member' } },
            )
          ).status,
        ).toBe(403);
        expect(
          (
            await apiJson(
              baseUrl,
              'POST',
              `/api/v1/chats/${chatId}/messages/archive-local-bot-reply`,
              { token: creator.token, body: { bot_user_id: 777001, text: 'BotFather forbidden' } },
            )
          ).status,
        ).toBe(403);
        expect(
          (
            await apiJson(
              baseUrl,
              'POST',
              `/api/v1/chats/${chatId}/messages/archive-local-bot-reply`,
              { token: creator.token, body: { bot_user_id: zh1.user_id, text: 'Human forbidden' } },
            )
          ).status,
        ).toBe(403);
        expect(
          (
            await apiJson(
              baseUrl,
              'POST',
              `/api/v1/chats/${chatId}/messages/archive-local-bot-reply`,
              { token: creator.token, body: { bot_user_id: 777000, text: '   ' } },
            )
          ).status,
        ).toBe(400);
      } finally {
        creatorWs.ws.close();
      }

      // Polls: vote, retract, GET /polls/:id, close, closed-poll reject, quiz re-vote reject
      const pollRes = await apiJson(baseUrl, 'POST', `/api/v1/chats/${chatId}/polls`, {
        token: creator.token,
        body: { question: 'Choose runtime', options: ['Rust', 'Node'] },
      });
      const pollId = pollRes.data.poll.poll_id as number;
      expect((await apiJson(baseUrl, 'POST', `/api/v1/polls/${pollId}/vote`, { token: zh1.token, body: { option_ids: [0] } })).data.total_voters).toBe(1);
      expect((await apiJson(baseUrl, 'POST', `/api/v1/polls/${pollId}/retract`, { token: zh1.token })).data.total_voters).toBe(0);
      expect((await apiJson(baseUrl, 'GET', `/api/v1/polls/${pollId}`, { token: zh1.token })).status).toBe(200);
      expect((await apiJson(baseUrl, 'POST', `/api/v1/polls/${pollId}/close`, { token: creator.token })).data.is_closed).toBe(true);
      const closedVote = await apiJson(baseUrl, 'POST', `/api/v1/polls/${pollId}/vote`, {
        token: zh1.token,
        body: { option_ids: [1] },
      });
      expect(closedVote.status).toBe(400);
      expect(closedVote.data.error).toBe('poll_closed');

      const quizRes = await apiJson(baseUrl, 'POST', `/api/v1/chats/${chatId}/polls`, {
        token: creator.token,
        body: { question: '2 + 2 = ?', options: ['3', '4'], is_quiz: true, correct_option_id: 1 },
      });
      const quizId = quizRes.data.poll.poll_id as number;
      expect((await apiJson(baseUrl, 'POST', `/api/v1/polls/${quizId}/vote`, { token: zh1.token, body: { option_ids: [1] } })).status).toBe(200);
      const quizRevote = await apiJson(baseUrl, 'POST', `/api/v1/polls/${quizId}/vote`, {
        token: zh1.token,
        body: { option_ids: [0] },
      });
      expect(quizRevote.status).toBe(400);
      expect(quizRevote.data.error).toBe('quiz_already_answered');
    });

    it('blocks all SSRF IPs/redirects/non-HTML and extracts genuine OpenGraph metadata via DI (zero bypass flags)', async () => {
      const blockedIps = [
        '0.0.0.0',
        '10.0.0.1',
        '100.64.0.1',
        '127.0.0.1',
        '169.254.169.254',
        '172.16.0.1',
        '192.168.1.1',
        '224.0.0.1',
        '::1',
        '::',
        '::ffff:127.0.0.1',
        '::ffff:7f00:1',
        'fc00::1',
        'fe80::1',
        '64:ff9b::127.0.0.1',
        'not-an-ip',
      ];
      for (const ip of blockedIps) {
        expect(isBlockedIpAddress(ip), `expected ${ip} to be blocked`).toBe(true);
      }
      expect(isBlockedIpAddress('93.184.216.34')).toBe(false);
      expect(isBlockedIpAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(false);

      // Direct SSRF URLs rejected without making network requests
      for (const badUrl of [
        'http://127.0.0.1/health',
        'http://169.254.169.254/latest/meta-data/',
        'http://10.0.0.1/internal',
        'http://[::1]/secret',
        'http://[::ffff:127.0.0.1]/secret',
        'http://localhost/admin',
        'file:///etc/passwd',
      ]) {
        expect(await fetchOpenGraphPreview(badUrl)).toBeUndefined();
      }

      // DNS resolving to private IP 10.0.0.5 is blocked BEFORE requestImpl is ever called
      let calledOnPrivateDns = false;
      const privDnsPreview = await fetchOpenGraphPreview('https://rebind.example.com/page', {
        lookup: async () => [{ address: '10.0.0.5', family: 4 }],
        requestImpl: async () => {
          calledOnPrivateDns = true;
          return { statusCode: 200, headers: { 'content-type': 'text/html' }, body: '<title>Bad</title>' };
        },
      });
      expect(privDnsPreview).toBeUndefined();
      expect(calledOnPrivateDns).toBe(false);

      // 302 redirect to loopback 127.0.0.1 is blocked
      const redirBlocked = await fetchOpenGraphPreview('https://public.example.com/start', {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        requestImpl: async () => ({
          statusCode: 302,
          headers: { location: 'http://127.0.0.1:4173/health' },
          body: '',
        }),
      });
      expect(redirBlocked).toBeUndefined();

      // Non-HTML application/json returns undefined
      const nonHtml = await fetchOpenGraphPreview('https://public.example.com/api.json', {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        requestImpl: async () => ({
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: '{"title":"Should not parse JSON"}',
        }),
      });
      expect(nonHtml).toBeUndefined();

      // Genuine public HTML with OG tags parses cleanly with instant_view_available: false
      const validOg = await fetchOpenGraphPreview('Check https://docs.example.org/release', {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        requestImpl: async ({ resolvedAddress }) => {
          expect(resolvedAddress).toBe('93.184.216.34');
          return {
            statusCode: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: `<!doctype html><html><head>
              <meta property="og:title" content="Fabushi &amp; GPUI v1.6.11" />
              <meta content="Zero-Knowledge Vault &amp; Real-Time Sync" property="og:description" />
              <meta property="og:site_name" content="Fabushi Docs" />
            </head><body>ok</body></html>`,
          };
        },
      });
      expect(validOg).toBeDefined();
      expect(validOg?.title).toBe('Fabushi & GPUI v1.6.11');
      expect(validOg?.description).toBe('Zero-Knowledge Vault & Real-Time Sync');
      expect(validOg?.site_name).toBe('Fabushi Docs');
      expect(validOg?.instant_view_available).toBe(false);
      expect(validOg?.instant_view_blocks).toBeUndefined();
    });

    it('enforces Ed25519 E2EE PreKeys contract (TEST_INFRA A07), OTPK pop, and device revocation', async () => {
      const alice = await registerTestUser(baseUrl, 'e2ee_ed_alice');
      const bob = await registerTestUser(baseUrl, 'e2ee_ed_bob');

      // Generate real 32B X25519 + 32B Ed25519 signing keypair
      const ikX25519 = crypto.generateKeyPairSync('x25519');
      const ikPub32 = ikX25519.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
      const spkX25519 = crypto.generateKeyPairSync('x25519');
      const spkPub32 = spkX25519.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
      const otpk1 = crypto.generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
      const otpk2 = crypto.generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);

      const edSign = crypto.generateKeyPairSync('ed25519');
      const edPub32 = edSign.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
      const sig64 = crypto.sign(
        null,
        Buffer.concat([Buffer.from('gpui-e2ee-spk-v1', 'utf8'), spkPub32]),
        edSign.privateKey,
      );

      const validPayload = {
        device_id: 'desktop-mac-ed25519',
        identity_key: ikPub32.toString('base64'),
        identity_signing_key: edPub32.toString('base64'),
        signed_prekey: {
          key_id: 1,
          public_key: spkPub32.toString('base64'),
          signature: sig64.toString('base64'),
        },
        one_time_prekeys: [
          { key_id: 10, public_key: otpk1.toString('base64') },
          { key_id: 11, public_key: otpk2.toString('base64') },
        ],
      };

      // Unauthenticated -> 401
      expect((await apiJson(baseUrl, 'POST', '/api/v1/e2ee/prekeys', { body: validPayload })).status).toBe(401);

      // Tampered signature -> 400
      const tamperedSig = Buffer.from(sig64);
      tamperedSig[0] = tamperedSig[0]! ^ 0xff;
      expect(
        (
          await apiJson(baseUrl, 'POST', '/api/v1/e2ee/prekeys', {
            token: bob.token,
            body: {
              ...validPayload,
              signed_prekey: { ...validPayload.signed_prekey, signature: tamperedSig.toString('base64') },
            },
          })
        ).status,
      ).toBe(400);

      // Bad key length -> 400
      expect(
        (
          await apiJson(baseUrl, 'POST', '/api/v1/e2ee/prekeys', {
            token: bob.token,
            body: { ...validPayload, identity_key: crypto.randomBytes(16).toString('base64') },
          })
        ).status,
      ).toBe(400);

      // Valid Ed25519 bundle -> 200
      const pubOk = await apiJson(baseUrl, 'POST', '/api/v1/e2ee/prekeys', {
        token: bob.token,
        body: validPayload,
      });
      expect(pubOk.status).toBe(200);
      expect(pubOk.data.remaining_one_time_prekeys).toBe(2);

      // Fetch via `/api/v1/e2ee/devices/:userId/prekeys` pops OTPK 10
      const fetched = await apiJson(baseUrl, 'GET', `/api/v1/e2ee/devices/${bob.user_id}/prekeys`, {
        token: alice.token,
      });
      expect(fetched.status).toBe(200);
      expect(fetched.data.devices[0].one_time_prekey.key_id).toBe(10);

      // Revoke device -> 200, second revoke -> 404
      const rev1 = await apiJson(
        baseUrl,
        'DELETE',
        '/api/v1/e2ee/devices/desktop-mac-ed25519',
        { token: bob.token },
      );
      expect(rev1.status).toBe(200);
      expect(rev1.data.revoked).toBe(true);
      const rev2 = await apiJson(
        baseUrl,
        'DELETE',
        '/api/v1/e2ee/devices/desktop-mac-ed25519',
        { token: bob.token },
      );
      expect(rev2.status).toBe(404);
    });
  });

  // ============================================================================
  // 6. Auto-Update Relay (`routes/updates.ts`)
  // ============================================================================
  describe('6. Auto-Update Relay (Allowlist, Raw Traversal 400, Caching & RFC 7233 206 Range)', () => {
    it('enforces tag/filename allowlists, blocks raw TCP .. traversal with 400, caches manifest & binary assets, and streams 206/416 byte ranges', async () => {
      // Allowlist unit checks
      expect(isValidReleaseTag('v1.6.11')).toBe(true);
      expect(isValidReleaseTag('V2.0.0-beta.1')).toBe(true);
      expect(isValidReleaseTag('macos-main-20261125')).toBe(true);
      expect(isValidReleaseTag('1.6.11')).toBe(true);
      expect(isValidReleaseTag('evil')).toBe(false);
      expect(isValidReleaseTag('../v1.6.11')).toBe(false);

      expect(isValidReleaseFilename('Fabushi-1.6.11-macos-arm64.zip')).toBe(true);
      expect(isValidReleaseFilename('gpui_telegram_1.6.11.dmg')).toBe(true);
      expect(isValidReleaseFilename('latest-mac.json')).toBe(true);
      expect(isValidReleaseFilename('SHA256SUMS')).toBe(true);
      expect(isValidReleaseFilename('secret.db')).toBe(false);
      expect(isValidReleaseFilename('gpui-tg-cli-v1.6.11.tar.gz')).toBe(false);
      expect(isValidReleaseFilename('../Fabushi-1.6.11.zip')).toBe(false);

      // Ephemeral mock upstream server for manifest & binary asset
      let manifestHits = 0;
      let assetHits = 0;
      const sampleZipBytes = Buffer.from(
        'PK\x03\x04-FABUSHI-RELEASE-BINARY-PAYLOAD-0123456789-ABCDEFGHIJKLMNO',
        'utf8',
      );
      expect(sampleZipBytes.length).toBe(62);

      const mockUpstream = http.createServer((req, res) => {
        if (req.url === '/latest-mac.json') {
          manifestHits += 1;
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              version: '1.6.11',
              tag: 'v1.6.11',
              asset: 'Fabushi-1.6.11-macos-arm64.zip',
            }),
          );
          return;
        }
        if (req.url === '/download/v1.6.11/Fabushi-1.6.11-macos-arm64.zip') {
          assetHits += 1;
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/octet-stream');
          res.setHeader('Content-Length', String(sampleZipBytes.length));
          res.end(sampleZipBytes);
          return;
        }
        res.statusCode = 404;
        res.end('Not found');
      });
      await new Promise<void>((resolve) => mockUpstream.listen(0, '127.0.0.1', () => resolve()));
      const upPort = (mockUpstream.address() as { port: number }).port;

      const updDir = createUniqueTestDir('m2-updates');
      const updServer = createTelegramServer(
        { port: 0, host: '127.0.0.1', dataDir: updDir, enableTestReset: false },
        {
          updates: {
            manifestUpstreamUrl: `http://127.0.0.1:${upPort}/latest-mac.json`,
            assetUpstreamBase: `http://127.0.0.1:${upPort}/download`,
          },
        },
      );
      const updInfo = await updServer.start();

      try {
        // Raw TCP `..` traversal, percent-encoded `..%2F`, disallowed tag, disallowed filename -> ALL strict 400!
        const rawDotDot = await sendRawHttpRequest(
          updInfo.port,
          'GET',
          '/api/v1/updates/assets/../etc/passwd',
        );
        expect(rawDotDot.statusCode).toBe(400);
        expect(rawDotDot.body).toContain('invalid_update_asset');

        const rawPct = await sendRawHttpRequest(
          updInfo.port,
          'GET',
          '/api/v1/updates/assets/v1.6.11/..%2Fsecret.db',
        );
        expect(rawPct.statusCode).toBe(400);

        expect(
          (await apiJson(updInfo.baseUrl, 'GET', '/api/v1/updates/assets/evil/Fabushi-1.6.11.zip'))
            .status,
        ).toBe(400);
        expect(
          (await apiJson(updInfo.baseUrl, 'GET', '/api/v1/updates/assets/v1.6.11/secret.db'))
            .status,
        ).toBe(400);
        expect(
          (
            await apiJson(
              updInfo.baseUrl,
              'GET',
              '/api/v1/updates/assets/v1.6.11/gpui-tg-cli-v1.6.11.tar.gz',
            )
          ).status,
        ).toBe(400);

        // Fetch manifest & binary asset from live mock upstream
        const man1 = await apiJson(updInfo.baseUrl, 'GET', '/api/v1/updates/latest-mac.json');
        expect(man1.status).toBe(200);
        expect(man1.data.version).toBe('1.6.11');
        expect(manifestHits).toBe(1);

        const assetFull = await fetch(
          `${updInfo.baseUrl}/api/v1/updates/assets/v1.6.11/Fabushi-1.6.11-macos-arm64.zip`,
          { headers: { 'Accept-Encoding': 'gzip' } },
        );
        expect(assetFull.status).toBe(200);
        expect(assetFull.headers.get('content-encoding')).toBeNull();
        expect(Buffer.from(await assetFull.arrayBuffer()).equals(sampleZipBytes)).toBe(true);
        expect(assetHits).toBe(1);

        // Shut down mock upstream server! Cached manifest (60s TTL) & cached binary asset MUST still serve cleanly!
        mockUpstream.closeAllConnections?.();
        await new Promise<void>((resolve) => mockUpstream.close(() => resolve()));

        const manCached = await apiJson(updInfo.baseUrl, 'GET', '/api/v1/updates/latest-mac.json');
        expect(manCached.status).toBe(200);
        expect(manCached.data.version).toBe('1.6.11');
        expect(manifestHits).toBe(1);

        // RFC 7233 206 Partial Content served directly from disk cache
        const range206 = await fetch(
          `${updInfo.baseUrl}/api/v1/updates/assets/v1.6.11/Fabushi-1.6.11-macos-arm64.zip`,
          { headers: { Range: 'bytes=10-19' } },
        );
        expect(range206.status).toBe(206);
        expect(range206.headers.get('content-range')).toBe('bytes 10-19/62');
        expect(Buffer.from(await range206.arrayBuffer()).equals(sampleZipBytes.subarray(10, 20))).toBe(true);

        // Out-of-range -> 416
        const range416 = await fetch(
          `${updInfo.baseUrl}/api/v1/updates/assets/v1.6.11/Fabushi-1.6.11-macos-arm64.zip`,
          { headers: { Range: 'bytes=500-600' } },
        );
        expect(range416.status).toBe(416);

        // Uncached asset against offline upstream -> graceful 502
        const offline502 = await apiJson(
          updInfo.baseUrl,
          'GET',
          '/api/v1/updates/assets/v1.6.12/Fabushi-1.6.12-macos-arm64.zip',
        );
        expect(offline502.status).toBe(502);
      } finally {
        await updServer.close();
        fs.rmSync(updDir, { recursive: true, force: true });
      }
    });
  });

  // ============================================================================
  // 7. M2 Iteration 2 Security & Spec-Fidelity Regressions (D-1..D-9 & H-1..H-4)
  // ============================================================================
  describe('7. Iteration 2 Regressions (Traversal, WebAuthn Hardening, Multi-User DM, WS Revocation, RBAC & Hardening)', () => {
    it('D-1 & D-9: blocks mixed %2e./.%2e and // raw TCP traversals with strict 400 and maps truncated update streams to 502', async () => {
      await apiJson(baseUrl, 'POST', '/api/v1/test/reset');
      const user = await registerTestUser(baseUrl, 'trav_guard_u');

      // Vault mixed dot-segment and leading // traversal MUST return 400 and MUST NOT hit /account or /envelope!
      const rawPaths = [
        { method: 'PUT', path: '/api/v1/user-vault/items/password/%2e./%2e./escape' },
        { method: 'PUT', path: '/api/v1/user-vault/items/password/.%2E/%2e./envelope' },
        { method: 'DELETE', path: '/api/v1/user-vault/items/password/%2e./%2e./%2e./account' },
        { method: 'DELETE', path: '//api/v1/user-vault/items/password/%2e./%2e./%2e./account' },
      ];
      for (const tc of rawPaths) {
        const res = await sendRawHttpRequest(serverPort, tc.method, tc.path, {
          Authorization: `Bearer ${user.token}`,
          'Content-Length': '0',
        });
        expect(res.statusCode, `expected 400 for ${tc.method} ${tc.path}`).toBe(400);
        expect(res.body).toContain('invalid_item_key');
      }
      // Account MUST still be alive!
      expect((await apiJson(baseUrl, 'GET', '/api/v1/auth/me', { token: user.token })).status).toBe(200);

      // Update assets mixed %2e./.%2e and leading // traversal -> strict 400
      for (const uPath of [
        '/api/v1/updates/assets/%2e./%2e./etc/passwd',
        '/api/v1/updates/assets/v1.6.11/.%2e/secret.db',
        '//api/v1/updates/assets/../etc/passwd',
        '//api/v1/updates/assets/%2e./%2e./etc/passwd',
      ]) {
        const res = await sendRawHttpRequest(serverPort, 'GET', uPath);
        expect(res.statusCode, `expected 400 for GET ${uPath}`).toBe(400);
        expect(res.body).toContain('invalid_update_asset');
      }

      // D-9: Truncated upstream asset stream MUST return 502 upstream_truncated (NEVER 500)
      const truncUpstream = http.createServer((req, res) => {
        if (req.url === '/download/v1.6.11/Fabushi-trunc.dmg') {
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': '1000',
          });
          res.flushHeaders();
          res.write('short', () => {
            setTimeout(() => {
              res.socket?.destroy();
            }, 15);
          });
          return;
        }
        res.statusCode = 404;
        res.end();
      });
      await new Promise<void>((resolve) => truncUpstream.listen(0, '127.0.0.1', () => resolve()));
      const upPort = (truncUpstream.address() as { port: number }).port;
      const truncDir = createUniqueTestDir('m2-upd-trunc');
      const truncServer = createTelegramServer(
        { port: 0, host: '127.0.0.1', dataDir: truncDir, enableTestReset: false },
        {
          updates: {
            manifestUpstreamUrl: `http://127.0.0.1:${upPort}/latest-mac.json`,
            assetUpstreamBase: `http://127.0.0.1:${upPort}/download`,
          },
        },
      );
      const truncInfo = await truncServer.start();
      try {
        const truncRes = await apiJson(
          truncInfo.baseUrl,
          'GET',
          '/api/v1/updates/assets/v1.6.11/Fabushi-trunc.dmg',
        );
        expect(truncRes.status).toBe(502);
        expect(truncRes.data.error).toBe('upstream_truncated');
      } finally {
        await truncServer.close();
        truncUpstream.closeAllConnections?.();
        await new Promise<void>((resolve) => truncUpstream.close(() => resolve()));
        fs.rmSync(truncDir, { recursive: true, force: true });
      }
    });

    it('D-2 & D-3: prevents WebAuthn algorithm confusion, weak RSA, SPKI trailing garbage, duplicate CBOR keys, bad origin/rpId, authData trailing bytes, and registration binding bypasses', async () => {
      await apiJson(baseUrl, 'POST', '/api/v1/test/reset');
      const user = await registerTestUser(baseUrl, 'webauthn_hard_u');

      // (1) Algorithm confusion unit checks on verifyWebAuthnSignature
      const rsa2048 = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const ec256 = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const ec384 = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
      const ed25519 = crypto.generateKeyPairSync('ed25519');
      const fakeAuthData = Buffer.alloc(37, 0);
      fakeAuthData[32] = 0x05;
      const fakeClientData = Buffer.from('{"type":"webauthn.get"}', 'utf8');
      const signedBuf = Buffer.concat([
        fakeAuthData,
        crypto.createHash('sha256').update(fakeClientData).digest(),
      ]);

      const rsaSig = crypto.sign('sha256', signedBuf, rsa2048.privateKey);
      const ec256Sig = crypto.sign('sha256', signedBuf, ec256.privateKey);
      const ec384Sha256Sig = crypto.sign('sha256', signedBuf, ec384.privateKey);
      const edSig = crypto.sign(null, signedBuf, ed25519.privateKey);

      expect(verifyWebAuthnSignature(rsa2048.publicKey, -257, fakeAuthData, fakeClientData, rsaSig)).toBe(true);
      expect(verifyWebAuthnSignature(rsa2048.publicKey, -7, fakeAuthData, fakeClientData, rsaSig)).toBe(false);
      expect(verifyWebAuthnSignature(ec256.publicKey, -257, fakeAuthData, fakeClientData, ec256Sig)).toBe(false);
      expect(verifyWebAuthnSignature(ec384.publicKey, -7, fakeAuthData, fakeClientData, ec384Sha256Sig)).toBe(false);
      expect(verifyWebAuthnSignature(ed25519.publicKey, -7, fakeAuthData, fakeClientData, edSig)).toBe(false);

      // (2) Duplicate CBOR map keys rejected
      const dupMapCbor = Buffer.from([0xa2, 0x01, 0x02, 0x01, 0x03]);
      expect(() => decodeCborItem(dupMapCbor)).toThrow(/Duplicate CBOR map key/);

      // (3) Weak RSA (1024-bit SPKI, zero-padded 512-bit COSE, even/trivial exponent, string alg) -> rejected
      const rsa1024 = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
      const rsa1024Spki = rsa1024.publicKey.export({ type: 'spki', format: 'der' });
      expect(() => parseWebAuthnPublicKey(rsa1024Spki)).toThrow();
      expect(
        (
          await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/register', {
            token: user.token,
            body: { label: 'Weak 1024', public_key_b64: rsa1024Spki.toString('base64') },
          })
        ).status,
      ).toBe(400);

      const paddedWeakMod = Buffer.concat([Buffer.alloc(200, 0), crypto.randomBytes(64)]);
      const weakCoseRsa = encodeCborValue(
        new Map<unknown, unknown>([
          [1, 3],
          [3, -257],
          [-1, paddedWeakMod],
          [-2, Buffer.from([0x01, 0x00, 0x01])],
        ]),
      );
      expect(() => parseWebAuthnPublicKey(weakCoseRsa)).toThrow();

      const evenExpCoseRsa = encodeCborValue(
        new Map<unknown, unknown>([
          [1, 3],
          [3, -257],
          [-1, Buffer.concat([Buffer.from([0x80]), crypto.randomBytes(255)])],
          [-2, Buffer.from([0x02])],
        ]),
      );
      expect(() => parseWebAuthnPublicKey(evenExpCoseRsa)).toThrow();

      const stringAlgCose = encodeCborValue(
        new Map<unknown, unknown>([
          [1, 1],
          [3, '-8'],
          [-1, 6],
          [-2, crypto.randomBytes(32)],
        ]),
      );
      expect(() => parseWebAuthnPublicKey(stringAlgCose)).toThrow();

      // (4) SPKI DER trailing garbage bytes rejected across ES256, Ed25519, RS256 -> 400
      for (const kp of [ec256, ed25519, rsa2048]) {
        const spkiDer = kp.publicKey.export({ type: 'spki', format: 'der' });
        for (const extra of [Buffer.from([0x00]), Buffer.from('EXTRA_GARBAGE')]) {
          const tainted = Buffer.concat([spkiDer, extra]);
          expect(() => parseWebAuthnPublicKey(tainted)).toThrow();
          const regRes = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/register/verify', {
            token: user.token,
            body: { label: 'Trailing SPKI', public_key_b64: tainted.toString('base64') },
          });
          expect(regRes.status).toBe(400);
        }
      }

      // (5) authenticatorData trailing garbage bytes rejected when at=false, ed=false
      const badAuthData = Buffer.concat([fakeAuthData, Buffer.alloc(16, 0xaa)]);
      expect(() => parseWebAuthnAuthenticatorData(badAuthData)).toThrow();
      const edAuthDataValid = Buffer.concat([
        Buffer.from(fakeAuthData.map((b, i) => (i === 32 ? 0x85 : b))),
        encodeCborValue(new Map<unknown, unknown>([['credProps', 1]])),
      ]);
      expect(parseWebAuthnAuthenticatorData(edAuthDataValid).ed).toBe(true);
      expect(() =>
        parseWebAuthnAuthenticatorData(Buffer.concat([edAuthDataValid, Buffer.from([0x00])])),
      ).toThrow();

      // (6) Register valid ES256 passkey and test origin userinfo/path, non-loopback http, IP-literal subdomain, authData trailing bytes, and stored cose_alg mismatch
      const esReg = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/register', {
        token: user.token,
        body: {
          label: 'Valid ES256',
          public_key_b64: ec256.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
        },
      });
      expect(esReg.status).toBe(201);
      const credId = String(esReg.data.cred_id);

      const badOrigins = [
        `http://evil.com@127.0.0.1:${serverPort}/evil`,
        `http://127.0.0.1:${serverPort}/`,
        `http://127.0.0.1:${serverPort}/path?q=1`,
        'http://example.com',
        'https://attacker.127.0.0.1',
      ];
      for (const badOrigin of badOrigins) {
        const ch = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/login/options', {
          body: { username: user.username },
        });
        const assn = buildSignedWebAuthnAssertion({
          privateKey: ec256.privateKey,
          alg: -7,
          rpId: ch.data.rp_id,
          origin: badOrigin,
          challenge: ch.data.challenge,
          signCount: 1,
        });
        const vRes = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/verify', {
          body: { challenge_id: ch.data.challenge_id, credential_id: credId, ...assn },
        });
        expect(vRes.status, `expected 401 for bad origin ${badOrigin}`).toBe(401);
        expect(vRes.data.error).toBe('invalid_origin');
      }

      // Trailing bytes in assertion authenticatorData -> 401
      const chTrail = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/login/options', {
        body: { username: user.username },
      });
      const rpIdHash = crypto.createHash('sha256').update(String(chTrail.data.rp_id), 'utf8').digest();
      const trailingAuthBuf = Buffer.concat([
        rpIdHash,
        Buffer.from([0x05, 0, 0, 0, 1]),
        Buffer.from('TRAILING_BYTES'),
      ]);
      const trailCdBuf = Buffer.from(
        JSON.stringify({
          type: 'webauthn.get',
          challenge: chTrail.data.challenge,
          origin: `http://${chTrail.data.rp_id}:${serverPort}`,
        }),
        'utf8',
      );
      const trailSig = crypto.sign(
        'sha256',
        Buffer.concat([trailingAuthBuf, crypto.createHash('sha256').update(trailCdBuf).digest()]),
        ec256.privateKey,
      );
      const vTrail = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/verify', {
        body: {
          challenge_id: chTrail.data.challenge_id,
          credential_id: credId,
          clientDataJSON: trailCdBuf.toString('base64url'),
          authenticatorData: trailingAuthBuf.toString('base64url'),
          signature: trailSig.toString('base64url'),
        },
      });
      expect(vTrail.status).toBe(401);

      // Stored cose_alg mismatch -> 401 invalid_passkey_credential
      server.db
        .prepare(`UPDATE account_passkeys SET cose_alg = -257 WHERE cred_id = ?`)
        .run(credId);
      const chAlg = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/login/options', {
        body: { username: user.username },
      });
      const assnAlg = buildSignedWebAuthnAssertion({
        privateKey: ec256.privateKey,
        alg: -7,
        rpId: chAlg.data.rp_id,
        origin: `http://${chAlg.data.rp_id}:${serverPort}`,
        challenge: chAlg.data.challenge,
        signCount: 2,
      });
      const vAlg = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/verify', {
        body: { challenge_id: chAlg.data.challenge_id, credential_id: credId, ...assnAlg },
      });
      expect(vAlg.status).toBe(401);
      expect(vAlg.data.error).toBe('invalid_passkey_credential');

      // (7) Registration binding: attestation cred_id mismatch -> 400; direct public_key_b64 + clientDataJSON without challenge_id validates & consumes challenge!
      const regOpts1 = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/register/options', {
        token: user.token,
      });
      const attObj = buildWebAuthnAttestationObject({
        rpId: regOpts1.data.rp_id,
        credId: crypto.randomBytes(16),
        cosePublicKey: buildCoseKeyFromPublicKey(ec256.publicKey, -7),
      });
      const regCd1 = Buffer.from(
        JSON.stringify({
          type: 'webauthn.create',
          challenge: regOpts1.data.challenge,
          origin: `http://${regOpts1.data.rp_id}:${serverPort}`,
        }),
        'utf8',
      ).toString('base64url');
      const mismatchReg = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/register/verify', {
        token: user.token,
        body: {
          challenge_id: regOpts1.data.challenge_id,
          cred_id: 'attacker_overwritten_cred_id',
          attestationObject: attObj.toString('base64url'),
          clientDataJSON: regCd1,
        },
      });
      expect(mismatchReg.status).toBe(400);
      expect(mismatchReg.data.error).toBe('credential_id_mismatch');

      // Direct public_key_b64 + clientDataJSON without challenge_id -> bogus challenge rejected (401); real challenge accepted & consumed!
      const bogusDirectCd = Buffer.from(
        JSON.stringify({
          type: 'webauthn.create',
          challenge: 'bogus_unissued_challenge',
          origin: `http://127.0.0.1:${serverPort}`,
        }),
        'utf8',
      ).toString('base64url');
      const badDirect = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/register', {
        token: user.token,
        body: {
          public_key_b64: ed25519.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
          clientDataJSON: bogusDirectCd,
        },
      });
      expect(badDirect.status).toBe(401);

      const regOpts2 = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/register/options', {
        token: user.token,
      });
      const goodDirectCd = Buffer.from(
        JSON.stringify({
          type: 'webauthn.create',
          challenge: regOpts2.data.challenge,
          origin: `http://${regOpts2.data.rp_id}:${serverPort}`,
        }),
        'utf8',
      ).toString('base64url');
      const okDirect = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/register', {
        token: user.token,
        body: {
          public_key_b64: ed25519.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
          clientDataJSON: goodDirectCd,
        },
      });
      expect(okDirect.status).toBe(201);
      // Replaying same clientDataJSON fails because challenge was consumed
      const replayDirect = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/register', {
        token: user.token,
        body: {
          public_key_b64: ed25519.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
          clientDataJSON: goodDirectCd,
        },
      });
      expect(replayDirect.status).toBe(401);
    });

    it('D-4, D-5, D-6, D-7 & D-8: fixes multi-user DMs, WS revocation, member/ban/invite/send_as/call RBAC, @username strictness, and read-only is_premium', async () => {
      await apiJson(baseUrl, 'POST', '/api/v1/test/reset');
      const owner = await registerTestUser(baseUrl, 'i2_owner', { first_name: 'Owner' });
      const admin = await registerTestUser(baseUrl, 'i2_admin', { first_name: 'Admin' });
      const member = await registerTestUser(baseUrl, 'i2_member', { first_name: 'Member' });
      const banned = await registerTestUser(baseUrl, 'i2_banned', { first_name: 'Banned' });
      const outsider = await registerTestUser(baseUrl, 'i2_outsider', { first_name: 'Outsider' });

      // D-4: Two distinct users can BOTH open DMs with @BotFather (777001), @HermesAgent (777000), and same human peer without HTTP 500!
      const dmBf1 = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
        token: owner.token,
        body: { chat_type: 0, peer_user_id: 777001 },
      });
      const dmBf2 = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
        token: admin.token,
        body: { chat_type: 0, peer_user_id: 777001 },
      });
      expect(dmBf1.status).toBe(201);
      expect(dmBf2.status).toBe(201);
      expect(dmBf1.data.chat_id).not.toBe(dmBf2.data.chat_id);
      expect(dmBf1.data.username).toBe('BotFather');
      expect(dmBf2.data.username).toBe('BotFather');

      const dmHermes1 = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
        token: owner.token,
        body: { chat_type: 0, peer_user_id: 777000 },
      });
      const dmHermes2 = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
        token: admin.token,
        body: { chat_type: 0, peer_user_id: 777000 },
      });
      expect(dmHermes1.status).toBe(201);
      expect(dmHermes2.status).toBe(201);

      const dmHuman1 = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
        token: owner.token,
        body: { chat_type: 0, peer_user_id: member.user_id },
      });
      const dmHuman2 = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
        token: admin.token,
        body: { chat_type: 0, peer_user_id: member.user_id },
      });
      expect(dmHuman1.status).toBe(201);
      expect(dmHuman2.status).toBe(201);
      expect(dmHuman1.data.username).toBe('i2_member');
      expect(dmHuman2.data.username).toBe('i2_member');

      // D-6 #1: Cannot inject 3rd user into 1-on-1 DM or Secret Chat -> 400
      expect(
        (
          await apiJson(baseUrl, 'POST', `/api/v1/chats/${dmHuman1.data.chat_id}/members`, {
            token: owner.token,
            body: { user_id: outsider.user_id },
          })
        ).status,
      ).toBe(400);

      // Group RBAC: member CANNOT demote owner/admin or unban banned user via POST /members
      const grp = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
        token: owner.token,
        body: {
          title: 'RBAC Group',
          chat_type: 1,
          member_ids: [admin.user_id, member.user_id, banned.user_id],
        },
      });
      expect(grp.status).toBe(201);
      const gid = grp.data.chat_id as number;
      expect(
        (
          await apiJson(baseUrl, 'PATCH', `/api/v1/chats/${gid}/members/${admin.user_id}`, {
            token: owner.token,
            body: { role: 'admin' },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await apiJson(baseUrl, 'PATCH', `/api/v1/chats/${gid}/members/${banned.user_id}`, {
            token: owner.token,
            body: { role: 'banned' },
          })
        ).status,
      ).toBe(200);

      // Member tries to demote Owner & Admin via POST /members -> roles preserved!
      const demoteAttempt = await apiJson(baseUrl, 'POST', `/api/v1/chats/${gid}/members`, {
        token: member.token,
        body: { user_ids: [owner.user_id, admin.user_id] },
      });
      expect(demoteAttempt.status).toBe(200);
      expect(demoteAttempt.data.added).toEqual([]);
      const ownerMemRow = server.db
        .prepare(`SELECT role, admin_rights FROM chat_members WHERE chat_id = ? AND user_id = ?`)
        .get(gid, owner.user_id) as { role: string; admin_rights: number };
      const adminMemRow = server.db
        .prepare(`SELECT role, admin_rights FROM chat_members WHERE chat_id = ? AND user_id = ?`)
        .get(gid, admin.user_id) as { role: string; admin_rights: number };
      expect(ownerMemRow.role).toBe('owner');
      expect(ownerMemRow.admin_rights).toBe(255);
      expect(adminMemRow.role).toBe('admin');
      expect(adminMemRow.admin_rights).toBe(127);

      // Member trying to re-add banned user -> 403 banned_in_chat
      const unbanAttempt = await apiJson(baseUrl, 'POST', `/api/v1/chats/${gid}/members`, {
        token: member.token,
        body: { user_id: banned.user_id },
      });
      expect(unbanAttempt.status).toBe(403);
      expect(unbanAttempt.data.error).toBe('banned_in_chat');

      // D-6 #2: Admin CANNOT self-promote to owner or modify owner; invalid role -> 400; non-member -> 404
      expect(
        (
          await apiJson(baseUrl, 'PATCH', `/api/v1/chats/${gid}/members/${admin.user_id}`, {
            token: admin.token,
            body: { role: 'owner' },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await apiJson(baseUrl, 'PATCH', `/api/v1/chats/${gid}/members/${owner.user_id}`, {
            token: admin.token,
            body: { role: 'member' },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await apiJson(baseUrl, 'PATCH', `/api/v1/chats/${gid}/members/${member.user_id}`, {
            token: owner.token,
            body: { role: 'superadmin' },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await apiJson(baseUrl, 'PATCH', `/api/v1/chats/${gid}/members/${outsider.user_id}`, {
            token: owner.token,
            body: { role: 'admin' },
          })
        ).status,
      ).toBe(404);

      // D-6 #3, #4, #5: Banned user CANNOT /leave, DELETE chat, or /invites/:code/join; non-admin CANNOT GET /invites
      expect(
        (await apiJson(baseUrl, 'POST', `/api/v1/chats/${gid}/leave`, { token: banned.token })).status,
      ).toBe(403);
      expect(
        (await apiJson(baseUrl, 'DELETE', `/api/v1/chats/${gid}`, { token: banned.token })).status,
      ).toBe(403);
      const invRes = await apiJson(baseUrl, 'POST', `/api/v1/chats/${gid}/invites`, {
        token: owner.token,
        body: { title: 'Private Invite' },
      });
      expect(invRes.status).toBe(201);
      expect(
        (await apiJson(baseUrl, 'GET', `/api/v1/chats/${gid}/invites`, { token: member.token })).status,
      ).toBe(403);
      expect(
        (await apiJson(baseUrl, 'GET', `/api/v1/chats/${gid}/invites`, { token: admin.token })).status,
      ).toBe(200);
      const bannedInvJoin = await apiJson(baseUrl, 'POST', `/api/v1/invites/${invRes.data.code}/join`, {
        token: banned.token,
      });
      expect(bannedInvJoin.status).toBe(403);
      expect(bannedInvJoin.data.error).toBe('banned_in_chat');
      const invRowAfter = server.db
        .prepare(`SELECT usage_count FROM chat_invite_links WHERE code = ?`)
        .get(invRes.data.code) as { usage_count: number };
      expect(invRowAfter.usage_count).toBe(0);

      // D-5: Real-time WS authorization revocation (ban/kick AND public->private transition)
      const privChan = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
        token: owner.token,
        body: { title: 'Secret Ops', chat_type: 3, member_ids: [member.user_id] },
      });
      const privChanId = privChan.data.chat_id as number;
      const pubToPriv = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
        token: owner.token,
        body: { title: 'Pub Then Priv', chat_type: 3, username: 'pub_then_priv' },
      });
      const pubToPrivId = pubToPriv.data.chat_id as number;

      const memberWs = await connectWsAuthenticated(wsUrl, member.token);
      const outsiderWs = await connectWsAuthenticated(wsUrl, outsider.token);
      try {
        // Outsider subscribes while channel is public
        outsiderWs.ws.send(JSON.stringify({ type: 'SubscribeChat', payload: { chat_id: pubToPrivId } }));
        await new Promise((r) => setTimeout(r, 80));

        // Ban & kick member from privChan, and privatize pubToPriv
        await apiJson(baseUrl, 'PATCH', `/api/v1/chats/${privChanId}/members/${member.user_id}`, {
          token: owner.token,
          body: { role: 'banned' },
        });
        await apiJson(baseUrl, 'DELETE', `/api/v1/chats/${privChanId}/members/${member.user_id}`, {
          token: owner.token,
        });
        await apiJson(baseUrl, 'PATCH', `/api/v1/chats/${pubToPrivId}`, {
          token: owner.token,
          body: { username: null },
        });

        memberWs.frames.length = 0;
        outsiderWs.frames.length = 0;

        await apiJson(baseUrl, 'POST', `/api/v1/chats/${privChanId}/messages`, {
          token: owner.token,
          body: { text: 'SECRET_AFTER_KICK' },
        });
        await apiJson(baseUrl, 'POST', `/api/v1/chats/${pubToPrivId}/messages`, {
          token: owner.token,
          body: { text: 'SECRET_AFTER_PRIVATIZE' },
        });
        await new Promise((r) => setTimeout(r, 150));

        expect(
          memberWs.frames.some((f) => JSON.stringify(f).includes('SECRET_AFTER_KICK')),
        ).toBe(false);
        expect(
          outsiderWs.frames.some((f) => JSON.stringify(f).includes('SECRET_AFTER_PRIVATIZE')),
        ).toBe(false);
      } finally {
        memberWs.ws.close();
        outsiderWs.ws.close();
      }

      // D-6 #6: send_as membership & peer ownership RBAC
      expect(
        (await apiJson(baseUrl, 'GET', `/api/v1/chats/${privChanId}/send_as`, { token: outsider.token })).status,
      ).toBe(403);
      expect(
        (
          await apiJson(baseUrl, 'PUT', `/api/v1/chats/${privChanId}/send_as`, {
            token: outsider.token,
            body: { send_as_peer_id: privChanId },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await apiJson(baseUrl, 'PUT', `/api/v1/chats/${gid}/send_as`, {
            token: member.token,
            body: { send_as_peer_id: privChanId },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await apiJson(baseUrl, 'POST', `/api/v1/chats/${gid}/messages`, {
            token: member.token,
            body: { text: 'Spoof send_as', send_as_peer_id: privChanId },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await apiJson(baseUrl, 'PUT', `/api/v1/chats/${gid}/send_as`, {
            token: owner.token,
            body: { send_as_peer_id: privChanId },
          })
        ).status,
      ).toBe(200);

      // D-6 #7: Call participant & chat membership RBAC
      expect(
        (
          await apiJson(baseUrl, 'POST', '/api/v1/calls/start', {
            token: outsider.token,
            body: { callee_id: member.user_id, chat_id: dmHuman1.data.chat_id },
          })
        ).status,
      ).toBe(403);
      const callStart = await apiJson(baseUrl, 'POST', '/api/v1/calls/start', {
        token: owner.token,
        body: { callee_id: member.user_id, chat_id: dmHuman1.data.chat_id },
      });
      expect(callStart.status).toBe(201);
      const callId = String(callStart.data.call_id);
      expect(
        (await apiJson(baseUrl, 'POST', `/api/v1/calls/${callId}/accept`, { token: outsider.token })).status,
      ).toBe(403);
      expect(
        (await apiJson(baseUrl, 'POST', `/api/v1/calls/${callId}/end`, { token: outsider.token, body: {} })).status,
      ).toBe(403);
      expect(
        (await apiJson(baseUrl, 'POST', `/api/v1/calls/${callId}/rate`, { token: outsider.token, body: { rating: 1 } })).status,
      ).toBe(403);
      expect(
        (
          await apiJson(baseUrl, 'POST', '/api/v1/calls/signal', {
            token: outsider.token,
            body: { call_id: callId, chat_id: dmHuman1.data.chat_id, signal_type: 'ice' },
          })
        ).status,
      ).toBe(403);

      const outsiderCallWs = await connectWsAuthenticated(wsUrl, outsider.token);
      try {
        outsiderCallWs.ws.send(
          JSON.stringify({
            type: 'CallSignal',
            payload: { call_id: callId, chat_id: dmHuman1.data.chat_id, signal_type: 'ice' },
          }),
        );
        const callErr = await outsiderCallWs.waitForFrame((f) => f.type === 'Error');
        expect(callErr.payload.code).toBe(403);
      } finally {
        outsiderCallWs.ws.close();
      }

      // D-7: @username strictness ("" / "   " / non-string -> 400, never 201 or 500)
      for (const invalidU of ['', '   ', 12345]) {
        expect(
          (
            await apiJson(baseUrl, 'POST', '/api/v1/chats', {
              token: owner.token,
              body: { title: 'BadU', chat_type: 3, username: invalidU },
            })
          ).status,
        ).toBe(400);
        expect(
          (
            await apiJson(baseUrl, 'PATCH', `/api/v1/chats/${privChanId}`, {
              token: owner.token,
              body: { username: invalidU },
            })
          ).status,
        ).toBe(400);
        expect(
          (
            await apiJson(baseUrl, 'PUT', '/api/v1/users/me', {
              token: owner.token,
              body: { username: invalidU },
            })
          ).status,
        ).toBe(400);
      }

      // D-8: PUT /api/v1/account/privacy strips is_premium and keeps truthful users.is_premium (false)
      const privPut = await apiJson(baseUrl, 'PUT', '/api/v1/account/privacy', {
        token: member.token,
        body: { is_premium: true, last_seen: 'contacts' },
      });
      expect(privPut.status).toBe(200);
      expect(privPut.data.is_premium).toBe(false);
      expect(privPut.data.last_seen).toBe('contacts');
      const privGet = await apiJson(baseUrl, 'GET', '/api/v1/account/privacy', {
        token: member.token,
      });
      expect(privGet.data.is_premium).toBe(false);
    });

    it('H-1..H-4: verifies device-sync /deny 410, change-password strictness, OpenGraph entity order & linear head scan, account purge completeness, pair poll expiry, poll nonce dedup, non-member ReadHistory, and channel invoice/pay RBAC', async () => {
      await apiJson(baseUrl, 'POST', '/api/v1/test/reset');
      const u1 = await registerTestUser(baseUrl, 'h_user_one', { first_name: 'HOne' });
      const u2 = await registerTestUser(baseUrl, 'h_user_two', { first_name: 'HTwo' });

      // H-1: device-sync /deny enforces expires_at -> 410 request_expired; /approve preserves terminal denied status
      const xKp = crypto.generateKeyPairSync('x25519');
      const xPubB64 = xKp.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
      const dsExp = await apiJson(baseUrl, 'POST', '/api/v1/user-vault/device-sync/request', {
        token: u1.token,
        body: { device_name: 'ExpDeny', device_public_key_b64: xPubB64 },
      });
      server.db
        .prepare(`UPDATE vault_device_sync_requests SET expires_at = ? WHERE request_id = ?`)
        .run(Math.floor(Date.now() / 1000) - 5, dsExp.data.request_id);
      const denyExpired = await apiJson(
        baseUrl,
        'POST',
        `/api/v1/user-vault/device-sync/${dsExp.data.request_id}/deny`,
        { token: u1.token },
      );
      expect(denyExpired.status).toBe(410);
      expect(denyExpired.data.error).toBe('request_expired');

      const dsDenied = await apiJson(baseUrl, 'POST', '/api/v1/user-vault/device-sync/request', {
        token: u1.token,
        body: { device_name: 'KeepDenied', device_public_key_b64: xPubB64 },
      });
      await apiJson(baseUrl, 'POST', `/api/v1/user-vault/device-sync/${dsDenied.data.request_id}/deny`, {
        token: u1.token,
      });
      server.db
        .prepare(`UPDATE vault_device_sync_requests SET expires_at = ? WHERE request_id = ?`)
        .run(Math.floor(Date.now() / 1000) - 5, dsDenied.data.request_id);
      const approveAfterDeny = await apiJson(
        baseUrl,
        'POST',
        `/api/v1/user-vault/device-sync/${dsDenied.data.request_id}/approve`,
        {
          token: u1.token,
          body: {
            approver_ephemeral_pub_b64: xPubB64,
            encrypted_root_key_b64: crypto.randomBytes(48).toString('base64'),
            nonce_b64: crypto.randomBytes(12).toString('base64'),
          },
        },
      );
      expect(approveAfterDeny.status).toBe(409);
      const deniedRow = server.db
        .prepare(`SELECT status FROM vault_device_sync_requests WHERE request_id = ?`)
        .get(dsDenied.data.request_id) as { status: string };
      expect(deniedRow.status).toBe('denied');

      // H-1: change-password requires auth_version === 2 and non-whitespace old_secret
      expect(
        (
          await apiJson(baseUrl, 'POST', '/api/v1/auth/change-password', {
            token: u1.token,
            body: {
              old_secret: u1.password,
              new_auth_salt_b64: crypto.randomBytes(16).toString('base64'),
              new_auth_verifier_b64: crypto.randomBytes(32).toString('base64'),
              new_kdf_params: DEFAULT_ARGON2_KDF_PARAMS,
            },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await apiJson(baseUrl, 'POST', '/api/v1/auth/change-password', {
            token: u1.token,
            body: {
              old_secret: '   ',
              auth_version: 2,
              new_auth_salt_b64: crypto.randomBytes(16).toString('base64'),
              new_auth_verifier_b64: crypto.randomBytes(32).toString('base64'),
              new_kdf_params: DEFAULT_ARGON2_KDF_PARAMS,
            },
          })
        ).status,
      ).toBe(400);

      // H-2: Teredo & 192.88.99.0/24 blocked + single-pass entity decode + linear-time 1-byte chunk </head> stop
      expect(isBlockedIpAddress('2001::1')).toBe(true);
      expect(isBlockedIpAddress('192.88.99.1')).toBe(true);
      let chunksYielded = 0;
      const ogChunked = await fetchOpenGraphPreview('https://stream.example.org/test', {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        requestImpl: async () => ({
          statusCode: 200,
          headers: { 'content-type': 'text/html' },
          body: (async function* () {
            const html = '<html><head><title>&amp;lt;Safe&amp;gt;</title></head>' + 'x'.repeat(2000);
            for (let i = 0; i < html.length; i++) {
              chunksYielded += 1;
              yield Buffer.from(html[i]!, 'utf8');
            }
          })(),
        }),
      });
      expect(ogChunked?.title).toBe('&lt;Safe&gt;');
      expect(chunksYielded).toBeLessThan(100);

      // H-3: Expired QR pair poll does not leak issued_token + oversized 2FA password rejected
      const pairInit = await apiJson(baseUrl, 'POST', '/api/v1/auth/pair/init', { body: {} });
      await apiJson(baseUrl, 'POST', '/api/v1/auth/pair/accept', {
        token: u1.token,
        body: { pair_id: pairInit.data.pair_id },
      });
      server.db
        .prepare(`UPDATE qr_pair_sessions SET expires_at_ms = ? WHERE pair_id = ?`)
        .run(Date.now() - 1000, pairInit.data.pair_id);
      const expiredPoll = await apiJson(baseUrl, 'GET', `/api/v1/auth/pair/poll/${pairInit.data.pair_id}`);
      expect(expiredPoll.status).toBe(200);
      expect(expiredPoll.data.status).toBe('expired');
      expect(expiredPoll.data.token).toBeUndefined();

      expect(
        (
          await apiJson(baseUrl, 'POST', '/api/v1/auth/2fa/set', {
            token: u1.token,
            body: { new_password: 'A'.repeat(1025) },
          })
        ).status,
      ).toBe(400);

      // H-4: Poll client_nonce validation + duplicate short-circuit, non-member ReadHistory pts guard, channel invoice/pay RBAC
      const pubChan = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
        token: u1.token,
        body: { title: 'H4 Channel', chat_type: 3, username: 'h4_public_chan' },
      });
      const cid = pubChan.data.chat_id as number;
      expect(
        (
          await apiJson(baseUrl, 'POST', `/api/v1/chats/${cid}/polls`, {
            token: u1.token,
            body: { question: 'Bad nonce?', options: ['A', 'B'], client_nonce: 'not_a_num' },
          })
        ).status,
      ).toBe(400);
      const poll1 = await apiJson(baseUrl, 'POST', `/api/v1/chats/${cid}/polls`, {
        token: u1.token,
        body: { question: 'Idem Poll?', options: ['Yes', 'No'], client_nonce: 888001 },
      });
      expect(poll1.status).toBe(201);
      const poll2 = await apiJson(baseUrl, 'POST', `/api/v1/chats/${cid}/polls`, {
        token: u1.token,
        body: { question: 'Idem Poll?', options: ['Yes', 'No'], client_nonce: 888001 },
      });
      expect(poll2.status).toBe(200);
      expect(poll2.data.duplicate).toBe(true);
      expect(poll2.data.poll.poll_id).toBe(poll1.data.poll.poll_id);
      const pollCountRow = server.db
        .prepare(`SELECT COUNT(*) AS cnt FROM polls WHERE chat_id = ?`)
        .get(cid) as { cnt: number };
      expect(pollCountRow.cnt).toBe(1);

      // Non-member ReadHistory on public channel must NOT bump pts
      const ptsBeforeRead = (
        server.db.prepare(`SELECT pts FROM chats WHERE chat_id = ?`).get(cid) as { pts: number }
      ).pts;
      const nonMemRead = await apiJson(baseUrl, 'POST', `/api/v1/chats/${cid}/read`, {
        token: u2.token,
        body: { max_id: 1 },
      });
      expect(nonMemRead.status).toBe(200);
      const ptsAfterRead = (
        server.db.prepare(`SELECT pts FROM chats WHERE chat_id = ?`).get(cid) as { pts: number }
      ).pts;
      expect(ptsAfterRead).toBe(ptsBeforeRead);

      // Channel invoice/pay: subscriber without write access -> 403
      const chInv = await apiJson(baseUrl, 'POST', `/api/v1/chats/${cid}/invoices`, {
        token: u1.token,
        body: { title: 'Channel Perk', amount: 10, currency: 'XTR' },
      });
      expect(chInv.status).toBe(201);
      await apiJson(baseUrl, 'POST', `/api/v1/chats/${cid}/join`, { token: u2.token });
      const subPay = await apiJson(
        baseUrl,
        'POST',
        `/api/v1/chats/${cid}/messages/${chInv.data.message.id}/pay`,
        { token: u2.token, body: {} },
      );
      expect(subPay.status).toBe(403);

      // H-3: Complete DELETE /api/v1/account purge of otp_challenges, call_sessions, story_views, and owned bots
      server.db
        .prepare(`UPDATE users SET email = ? WHERE user_id = ?`)
        .run('purge_me@fabushi.test', u1.user_id);
      server.db
        .prepare(
          `INSERT INTO otp_challenges (challenge_id, channel, target, code, attempts, resend_after_ms, expires_at_ms, created_at_ms)
           VALUES ('otp_del_1', 'email', 'purge_me@fabushi.test', '123456', 0, 0, ?, ?)`,
        )
        .run(Date.now() + 60_000, Date.now());
      const st = await apiJson(baseUrl, 'POST', '/api/v1/stories', {
        token: u1.token,
        body: { caption: 'My Story' },
      });
      await apiJson(baseUrl, 'POST', `/api/v1/stories/${st.data.storyId}/view`, { token: u2.token });
      const callRowRes = await apiJson(baseUrl, 'POST', '/api/v1/calls/start', {
        token: u1.token,
        body: { callee_id: u2.user_id },
      });
      expect(callRowRes.status).toBe(201);

      // Seed a user-owned bot, update, and mini app to verify full cleanup on account delete
      const botUid = 889901;
      const nowMs = Date.now();
      server.db
        .prepare(
          `INSERT INTO users (user_id, username, first_name, is_bot, is_verified, is_premium, status, last_seen_ms, created_at_ms, updated_at_ms)
           VALUES (?, 'u1_owned_bot', 'OwnedBot', 1, 0, 0, 'online', ?, ?, ?)`,
        )
        .run(botUid, nowMs, nowMs, nowMs);
      server.db
        .prepare(
          `INSERT INTO bots_registry (bot_user_id, owner_user_id, bot_token, bot_json, created_at_ms)
           VALUES (?, ?, '889901:TestOwnedBotToken', '{"username":"u1_owned_bot"}', ?)`,
        )
        .run(botUid, u1.user_id, nowMs);
      server.db
        .prepare(
          `INSERT INTO bot_api_updates (bot_user_id, payload_json, created_at_ms)
           VALUES (?, '{"update":1}', ?)`,
        )
        .run(botUid, nowMs);
      server.db
        .prepare(
          `INSERT INTO mini_apps (app_id, bot_user_id, bot_username, short_name, app_json, created_at_ms)
           VALUES ('app_u1_bot', ?, 'u1_owned_bot', 'tool', '{}', ?)`,
        )
        .run(botUid, nowMs);

      const delAcc = await apiJson(baseUrl, 'DELETE', '/api/v1/account', { token: u1.token });
      expect(delAcc.status).toBe(200);
      expect(
        server.db.prepare(`SELECT 1 FROM otp_challenges WHERE target = 'purge_me@fabushi.test'`).get(),
      ).toBeUndefined();
      expect(
        server.db.prepare(`SELECT 1 FROM call_sessions WHERE call_id = ?`).get(callRowRes.data.call_id),
      ).toBeUndefined();
      expect(
        server.db.prepare(`SELECT 1 FROM story_views WHERE story_id = ?`).get(st.data.storyId),
      ).toBeUndefined();
      expect(
        server.db.prepare(`SELECT 1 FROM bots_registry WHERE bot_user_id = ?`).get(botUid),
      ).toBeUndefined();
      expect(
        server.db.prepare(`SELECT 1 FROM bot_api_updates WHERE bot_user_id = ?`).get(botUid),
      ).toBeUndefined();
      expect(
        server.db.prepare(`SELECT 1 FROM mini_apps WHERE bot_user_id = ?`).get(botUid),
      ).toBeUndefined();
      expect(
        server.db.prepare(`SELECT 1 FROM users WHERE user_id = ?`).get(botUid),
      ).toBeUndefined();
    });

    it('Iter 3 (R1 / C2-I2-FAIL-1..3 + Polish): enforces Calls channel-write/restricted RBAC, callee membership & single call_ended idempotency, strict chat_type IN (1,2,3) on invites/meta/peers-resolve, non-string 400 guards, and single-pass numeric HTML entity decoding', async () => {
      await apiJson(baseUrl, 'POST', '/api/v1/test/reset');
      const owner = await registerTestUser(baseUrl, 'i3_owner', { first_name: 'Owner' });
      const sub = await registerTestUser(baseUrl, 'i3_sub', { first_name: 'Subscriber' });
      const outsider = await registerTestUser(baseUrl, 'i3_outsider', { first_name: 'Outsider' });

      // 1. R1 / C2-I2-FAIL-1: Broadcast channel subscriber blocked from chat-scoped calls & signals
      const bcastRes = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
        token: owner.token,
        body: { title: 'Iter3 Broadcast', chat_type: 3, username: 'iter3_bcast_chan' },
      });
      expect(bcastRes.status).toBe(201);
      const bcastId = Number(bcastRes.data.chat_id);
      expect(
        (await apiJson(baseUrl, 'POST', `/api/v1/chats/${bcastId}/join`, { token: sub.token })).status,
      ).toBe(200);

      const ownerWs = await connectWsAuthenticated(wsUrl, owner.token);
      const subWs = await connectWsAuthenticated(wsUrl, sub.token);
      try {
        ownerWs.ws.send(JSON.stringify({ type: 'SubscribeChats', payload: { chat_ids: [bcastId] } }));
        await new Promise((r) => setTimeout(r, 80));
        ownerWs.frames.length = 0;

        // Subscriber cannot start a chat-scoped call in a broadcast channel (even to another member)
        const subStart = await apiJson(baseUrl, 'POST', '/api/v1/calls/start', {
          token: sub.token,
          body: { callee_id: owner.user_id, chat_id: bcastId },
        });
        expect(subStart.status).toBe(403);
        expect(subStart.data.error).toBe('channel_write_forbidden');

        // Subscriber cannot send HTTP /calls/signal scoped to broadcast channel
        const subSigHttp = await apiJson(baseUrl, 'POST', '/api/v1/calls/signal', {
          token: sub.token,
          body: { chat_id: bcastId, signal_type: 'ice' },
        });
        expect(subSigHttp.status).toBe(403);

        // Subscriber cannot send WS CallSignal scoped to broadcast channel
        subWs.ws.send(
          JSON.stringify({
            type: 'CallSignal',
            payload: { chat_id: bcastId, signal_type: 'ice' },
          }),
        );
        const subWsErr = await subWs.waitForFrame((f) => f.type === 'Error');
        expect(subWsErr.payload.code).toBe(403);

        // Owner starting a chat-scoped call to an outsider (not a member of bcastId) -> 403
        const outsiderCalleeStart = await apiJson(baseUrl, 'POST', '/api/v1/calls/start', {
          token: owner.token,
          body: { callee_id: outsider.user_id, chat_id: bcastId },
        });
        expect(outsiderCalleeStart.status).toBe(403);

        // Owner starts legitimate call in bcastId with subscriber (who IS a member); subscriber still cannot end/post into channel
        const ownerCall = await apiJson(baseUrl, 'POST', '/api/v1/calls/start', {
          token: owner.token,
          body: { callee_id: sub.user_id, chat_id: bcastId },
        });
        expect(ownerCall.status).toBe(201);
        const chanCallId = String(ownerCall.data.call_id);
        const subEndForbidden = await apiJson(baseUrl, 'POST', `/api/v1/calls/${chanCallId}/end`, {
          token: sub.token,
          body: { duration_secs: 15 },
        });
        expect(subEndForbidden.status).toBe(403);
        expect(subEndForbidden.data.error).toBe('channel_write_forbidden');

        await new Promise((r) => setTimeout(r, 120));
        expect(
          ownerWs.frames.filter(
            (f) =>
              f.type === 'PtsPush' ||
              (f.type === 'Update' && f.payload?.type === 'CallSignal'),
          ).length,
        ).toBe(0);
        const injectedBeforeOwnerEnd = server.db
          .prepare(`SELECT COUNT(*) AS cnt FROM messages WHERE chat_id = ?`)
          .get(bcastId) as { cnt: number };
        expect(injectedBeforeOwnerEnd.cnt).toBe(0);

        // Ending a legitimate call TWICE produces strictly 1 call_ended service message (idempotent)
        const end1 = await apiJson(baseUrl, 'POST', `/api/v1/calls/${chanCallId}/end`, {
          token: owner.token,
          body: { duration_secs: 42 },
        });
        expect(end1.status).toBe(200);
        expect(end1.data.state).toBe('ended');
        const end2 = await apiJson(baseUrl, 'POST', `/api/v1/calls/${chanCallId}/end`, {
          token: owner.token,
          body: { duration_secs: 99 },
        });
        expect(end2.status).toBe(200);
        expect(end2.data.duration_secs).toBe(42);
        const endedMsgs = server.db
          .prepare(`SELECT content_json FROM messages WHERE chat_id = ?`)
          .all(bcastId) as Array<{ content_json: string }>;
        expect(endedMsgs.length).toBe(1);
        expect(endedMsgs[0]!.content_json).toContain('call_ended');

        // Muted restricted group member (banned_rights: 1) blocked on chat-scoped /calls/start, /calls/signal, WS CallSignal
        const grpRes = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
          token: owner.token,
          body: { title: 'Iter3 Group', chat_type: 1, member_ids: [sub.user_id] },
        });
        expect(grpRes.status).toBe(201);
        const grpId = Number(grpRes.data.chat_id);
        const restrictRes = await apiJson(
          baseUrl,
          'PATCH',
          `/api/v1/chats/${grpId}/members/${sub.user_id}`,
          { token: owner.token, body: { role: 'restricted', banned_rights: 1 } },
        );
        expect(restrictRes.status).toBe(200);

        expect(
          (
            await apiJson(baseUrl, 'POST', '/api/v1/calls/start', {
              token: sub.token,
              body: { callee_id: owner.user_id, chat_id: grpId },
            })
          ).status,
        ).toBe(403);
        expect(
          (
            await apiJson(baseUrl, 'POST', '/api/v1/calls/signal', {
              token: sub.token,
              body: { chat_id: grpId, signal_type: 'ice' },
            })
          ).status,
        ).toBe(403);
        subWs.frames.length = 0;
        subWs.ws.send(
          JSON.stringify({
            type: 'CallSignal',
            payload: { chat_id: grpId, signal_type: 'ice' },
          }),
        );
        const mutedWsErr = await subWs.waitForFrame((f) => f.type === 'Error');
        expect(mutedWsErr.payload.code).toBe(403);
      } finally {
        ownerWs.ws.close();
        subWs.ws.close();
      }

      // 2. C2-I2-FAIL-2 & C2-I2-FAIL-3: DM (0), Secret Chat (4), Saved Messages (5) reject invites & meta updates & peers/resolve
      const dmRes = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
        token: owner.token,
        body: { peer_user_id: sub.user_id },
      });
      expect(dmRes.status).toBe(201);
      const dmId = Number(dmRes.data.chat_id);
      await apiJson(baseUrl, 'POST', `/api/v1/chats/${dmId}/messages`, {
        token: owner.token,
        body: { text: 'PRIVATE_DM_TOP_SECRET' },
      });

      const secRes = await apiJson(baseUrl, 'POST', '/api/v1/secret-chats', {
        token: owner.token,
        body: { peer_user_id: sub.user_id, ttl_seconds: 60 },
      });
      expect(secRes.status).toBe(201);
      const secId = Number(secRes.data.chat.chat_id);

      const savedRes = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
        token: owner.token,
        body: { chat_type: 5 },
      });
      expect(savedRes.status).toBe(200);
      const savedId = Number(savedRes.data.chat_id);

      for (const nonGroupId of [dmId, secId, savedId]) {
        // Invite CRUD strictly 400 invalid_chat_type
        const getInv = await apiJson(baseUrl, 'GET', `/api/v1/chats/${nonGroupId}/invites`, {
          token: owner.token,
        });
        expect(getInv.status).toBe(400);
        expect(getInv.data.error).toBe('invalid_chat_type');

        const postInv = await apiJson(baseUrl, 'POST', `/api/v1/chats/${nonGroupId}/invites`, {
          token: owner.token,
          body: {},
        });
        expect(postInv.status).toBe(400);
        expect(postInv.data.error).toBe('invalid_chat_type');

        const delInv = await apiJson(
          baseUrl,
          'DELETE',
          `/api/v1/chats/${nonGroupId}/invites/anycode`,
          { token: owner.token },
        );
        expect(delInv.status).toBe(400);
        expect(delInv.data.error).toBe('invalid_chat_type');

        // Metadata update (PATCH & PUT) strictly 400 invalid_chat_type
        const patchMeta = await apiJson(baseUrl, 'PATCH', `/api/v1/chats/${nonGroupId}`, {
          token: owner.token,
          body: { username: `leak_handle_${nonGroupId}` },
        });
        expect(patchMeta.status).toBe(400);
        expect(patchMeta.data.error).toBe('invalid_chat_type');

        const putMeta = await apiJson(baseUrl, 'PUT', `/api/v1/chats/${nonGroupId}`, {
          token: owner.token,
          body: { title: 'Cannot Rename Private Chat' },
        });
        expect(putMeta.status).toBe(400);
        expect(putMeta.data.error).toBe('invalid_chat_type');
      }

      // Forged/pre-existing invite row pointing to a DM -> rejected 400 on /invites/:code/join without adding member or bumping usage_count
      server.db
        .prepare(
          `INSERT INTO chat_invite_links (code, invite_id, chat_id, creator_id, usage_count, request_needed, is_revoked, created_at_ms)
           VALUES ('forged_dm_inv', 'inv_forged_dm', ?, ?, 0, 0, 0, ?)`,
        )
        .run(dmId, owner.user_id, Date.now());
      const forgedJoin = await apiJson(baseUrl, 'POST', '/api/v1/invites/forged_dm_inv/join', {
        token: outsider.token,
      });
      expect(forgedJoin.status).toBe(400);
      expect(forgedJoin.data.error).toBe('invalid_chat_type');
      expect(
        server.db
          .prepare(`SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?`)
          .get(dmId, outsider.user_id),
      ).toBeUndefined();
      expect(
        (
          server.db
            .prepare(`SELECT usage_count FROM chat_invite_links WHERE code = 'forged_dm_inv'`)
            .get() as { usage_count: number }
        ).usage_count,
      ).toBe(0);

      // Even if a DM row somehow has a username in DB, GET /api/v1/peers/resolve NEVER returns chat_type = 0
      server.db
        .prepare(`UPDATE chats SET username = 'legacy_dm_handle' WHERE chat_id = ?`)
        .run(dmId);
      const resolveDm = await apiJson(
        baseUrl,
        'GET',
        '/api/v1/peers/resolve?username=legacy_dm_handle',
        { token: outsider.token },
      );
      expect(resolveDm.status).toBe(404);

      // Legitimate public broadcast channel still resolves cleanly via /peers/resolve
      const resolvePub = await apiJson(
        baseUrl,
        'GET',
        '/api/v1/peers/resolve?username=iter3_bcast_chan',
        { token: outsider.token },
      );
      expect(resolvePub.status).toBe(200);
      expect(resolvePub.data.peer_type).toBe('chat');
      expect(resolvePub.data.chat.chat_id).toBe(bcastId);

      // 3. Three Polish Items: non-string username & cred_id -> 400 (never 500); &#38;amp; decodes strictly once
      const badReg = await apiJson(baseUrl, 'POST', '/api/v1/auth/register', {
        body: { username: 12345, password: 'ValidPassword123!' },
      });
      expect(badReg.status).toBe(400);
      expect(badReg.data.error).toBe('invalid_username');

      const pkKp = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const pkSpkiB64 = pkKp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
      const badPasskeyCredId = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/register', {
        token: owner.token,
        body: { cred_id: 12345, public_key_b64: pkSpkiB64 },
      });
      expect(badPasskeyCredId.status).toBe(400);
      expect(badPasskeyCredId.data.error).toBe('invalid_credential_id');

      const singlePassOg = await fetchOpenGraphPreview('https://entities.example.org/once', {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        requestImpl: async () => ({
          statusCode: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: `<!doctype html><html><head>
            <meta property="og:title" content="&#38;amp; &amp;lt; &#x26;gt;" />
          </head><body></body></html>`,
        }),
      });
      expect(singlePassOg?.title).toBe('&amp; &lt; &gt;');
    });

    it('Iter 4 (C1-I3-FAIL-1..2, C2-I3-FAIL-1..3 + Surrogate Polish): blocks RFC 9112 absolute-form & dot-segment bypasses, malformed Host 400, non-string JSON 400 across auth/invites, early POST /chats username guard, call terminal-state immutability, and lone surrogate HTML entities', async () => {
      await apiJson(baseUrl, 'POST', '/api/v1/test/reset');

      const sendRawTcpHttp = (
        port: number,
        method: string,
        rawRequestTarget: string,
        opts: { hostHeader?: string; headers?: Record<string, string>; body?: string } = {},
      ): Promise<{ statusCode: number; body: string }> =>
        new Promise((resolve, reject) => {
          const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
            const payload = opts.body ?? '';
            const lines = [
              `${method} ${rawRequestTarget} HTTP/1.1`,
              `Host: ${opts.hostHeader ?? `127.0.0.1:${port}`}`,
              'Connection: close',
              ...Object.entries(opts.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
            ];
            if (payload.length > 0) {
              lines.push(`Content-Length: ${Buffer.byteLength(payload, 'utf8')}`);
            }
            lines.push('', payload);
            sock.write(lines.join('\r\n'));
          });
          const chunks: Buffer[] = [];
          sock.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          sock.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            const sep = raw.indexOf('\r\n\r\n');
            const head = sep >= 0 ? raw.slice(0, sep) : raw;
            const body = sep >= 0 ? raw.slice(sep + 4) : '';
            const statusLine = head.split('\r\n')[0] ?? '';
            const m = /HTTP\/1\.[01]\s+(\d+)/.exec(statusLine);
            resolve({ statusCode: m ? Number(m[1]) : 0, body });
          });
          sock.on('error', reject);
        });

      // 1. C1-I3-FAIL-1: Pure helper & live raw TCP RFC 9112 absolute-form + pre-prefix /./ & /%2e/ + single-dot guards
      expect(extractRawRequestPath('http://127.0.0.1:41234/api/v1/updates/latest-mac.json')).toBe(
        '/api/v1/updates/latest-mac.json',
      );
      expect(hasRawUpdateAssetTraversal('/api/v1/updates/latest-mac.json')).toBe(false);
      expect(
        hasRawUpdateAssetTraversal('/api/v1/updates/assets/v1.6.11/Fabushi-1.6.11-macos-arm64.zip'),
      ).toBe(false);
      expect(
        hasRawUpdateAssetTraversal(
          'http://127.0.0.1:41234/api/v1/updates/assets/v1.0.0/../../latest-mac.json',
        ),
      ).toBe(true);
      expect(
        hasRawUpdateAssetTraversal('/api/v1/updates/./assets/v1.0.0/../../latest-mac.json'),
      ).toBe(true);
      expect(
        hasRawUpdateAssetTraversal('/api/v1/updates/%2e/assets/v1.0.0/../../latest-mac.json'),
      ).toBe(true);
      expect(hasRawUpdateAssetTraversal('//api/v1/updates/assets/../etc/passwd')).toBe(true);

      const u1 = await registerTestUser(baseUrl, 'i4_vault_user', { first_name: 'VaultUser' });
      const u2 = await registerTestUser(baseUrl, 'i4_peer_user', { first_name: 'PeerUser' });

      const makeEnvelopeBody = (keyVersion: number) => ({
        key_version: keyVersion,
        kdf_alg: 'split_key_v2',
        kdf_salt_b64: crypto.randomBytes(16).toString('base64'),
        kdf_m_cost_kib: DEFAULT_ARGON2_KDF_PARAMS.m_cost_kib,
        kdf_t_cost: DEFAULT_ARGON2_KDF_PARAMS.t_cost,
        kdf_p_cost: DEFAULT_ARGON2_KDF_PARAMS.p_cost,
        wrapped_root_key_b64: crypto.randomBytes(60).toString('base64'),
      });

      const putEnv = await apiJson(baseUrl, 'PUT', '/api/v1/user-vault/envelope', {
        token: u1.token,
        body: makeEnvelopeBody(1),
      });
      expect(putEnv.status).toBe(200);

      // Valid dotted vault item key still succeeds cleanly (200)
      const validItem = await apiJson(
        baseUrl,
        'PUT',
        '/api/v1/user-vault/items/password/site.example.com:login',
        {
          token: u1.token,
          body: {
            ciphertext_b64: crypto.randomBytes(32).toString('base64'),
            nonce_b64: crypto.randomBytes(12).toString('base64'),
            key_version: 1,
          },
        },
      );
      expect(validItem.status).toBe(200);

      // Adversarial raw TCP vault traversal & dot-segment bypasses -> ALL 400 invalid_item_key; envelope stays key_version === 1
      const vaultBypassCases = [
        {
          method: 'PUT',
          target: `http://127.0.0.1:${serverPort}/api/v1/user-vault/items/password/../../envelope`,
          body: JSON.stringify(makeEnvelopeBody(77)),
        },
        {
          method: 'PUT',
          target: '/api/v1/user-vault/./items/password/../../envelope',
          body: JSON.stringify(makeEnvelopeBody(88)),
        },
        {
          method: 'PUT',
          target: '/api/v1/user-vault/%2e/items/password/../../envelope',
          body: JSON.stringify(makeEnvelopeBody(99)),
        },
        {
          method: 'PUT',
          target: '/./api/v1/user-vault/items/password/../../envelope',
          body: JSON.stringify(makeEnvelopeBody(66)),
        },
        {
          method: 'PUT',
          target: '/api/v1/user-vault/items/password/./site.example.com:login',
          body: JSON.stringify({
            ciphertext_b64: crypto.randomBytes(32).toString('base64'),
            nonce_b64: crypto.randomBytes(12).toString('base64'),
            key_version: 1,
          }),
        },
        {
          method: 'DELETE',
          target: '/api/v1/user-vault/items/password/%2e./%2e./%2e./account',
          body: '',
        },
      ];
      for (const tc of vaultBypassCases) {
        const res = await sendRawTcpHttp(serverPort, tc.method, tc.target, {
          headers: {
            Authorization: `Bearer ${u1.token}`,
            'Content-Type': 'application/json',
          },
          body: tc.body,
        });
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).error).toBe('invalid_item_key');
      }

      const envAfter = await apiJson(baseUrl, 'GET', '/api/v1/user-vault/envelope', {
        token: u1.token,
      });
      expect(envAfter.status).toBe(200);
      expect(envAfter.data.envelope.key_version).toBe(1);

      // Updates relay raw TCP absolute-form & pre-prefix dot-segments -> ALL 400 invalid_update_asset (manifest never reached)
      let manifestHits = 0;
      const stubUp = http.createServer((req, res) => {
        if (req.url === '/latest-mac.json') {
          manifestHits += 1;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ version: '1.6.11', stub_manifest: true }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
      await new Promise<void>((resolve) => stubUp.listen(0, '127.0.0.1', resolve));
      const stubUpPort = (stubUp.address() as net.AddressInfo).port;
      const updDir = createUniqueTestDir('m2-iter4-upd');
      const updServer = createTelegramServer(
        { port: 0, host: '127.0.0.1', dataDir: updDir, enableTestReset: false, seedDemoData: false },
        {
          updates: {
            manifestUpstreamUrl: `http://127.0.0.1:${stubUpPort}/latest-mac.json`,
            assetUpstreamBase: `http://127.0.0.1:${stubUpPort}/download`,
          },
        },
      );
      try {
        const updInfo = await updServer.start();
        const updTargets = [
          `http://127.0.0.1:${updInfo.port}/api/v1/updates/assets/v1.0.0/../../latest-mac.json`,
          '/api/v1/updates/./assets/v1.0.0/../../latest-mac.json',
          '/api/v1/updates/%2e/assets/v1.0.0/../../latest-mac.json',
          '/./api/v1/updates/assets/v1.0.0/../../latest-mac.json',
        ];
        for (const t of updTargets) {
          const r = await sendRawTcpHttp(updInfo.port, 'GET', t);
          expect(r.statusCode).toBe(400);
          expect(JSON.parse(r.body).error).toBe('invalid_update_asset');
        }
        expect(manifestHits).toBe(0);

        // Legitimate manifest still succeeds (200)
        const okManifest = await apiJson(updInfo.baseUrl, 'GET', '/api/v1/updates/latest-mac.json');
        expect(okManifest.status).toBe(200);
        expect(manifestHits).toBe(1);
      } finally {
        await updServer.close();
        await new Promise<void>((resolve) => stubUp.close(() => resolve()));
        fs.rmSync(updDir, { recursive: true, force: true });
      }

      // Global API dot-segment defense-in-depth & malformed Host header -> 400 (never 500)
      const apiDot = await sendRawTcpHttp(serverPort, 'GET', '/api/./v1/health');
      expect(apiDot.statusCode).toBe(400);
      expect(JSON.parse(apiDot.body).error).toBe('invalid_path');

      const leadingDotApi = await sendRawTcpHttp(serverPort, 'GET', '/./api/v1/health');
      expect(leadingDotApi.statusCode).toBe(400);
      expect(JSON.parse(leadingDotApi.body).error).toBe('invalid_path');

      const badHostRes = await sendRawTcpHttp(serverPort, 'GET', '/health', {
        hostHeader: 'bad host:99999',
      });
      expect(badHostRes.statusCode).toBe(400);
      expect(JSON.parse(badHostRes.body).error).toBe('invalid_request_url');

      // 2. C1-I3-FAIL-2 & C2-I3-FAIL-3: Non-string JSON inputs across auth, passkey, OTP, pair & invites -> 400 (zero 500s)
      const nonStringCases: Array<{ path: string; body: Record<string, unknown>; token?: string }> = [
        { path: '/api/v1/auth/login', body: { username: 12345, password: 'Password123!' } },
        { path: '/api/v1/auth/passkey/challenge', body: { username: 12345 } },
        { path: '/api/v1/auth/passkey/login/options', body: { username: 12345 } },
        {
          path: '/api/v1/auth/passkey/verify',
          body: { cred_id: 12345, clientDataJSON: '{}', authenticatorData: 'AAAA', signature: 'AAAA' },
        },
        {
          path: '/api/v1/auth/passkey/verify',
          body: {
            credential_id: 'c1',
            challenge_id: 12345,
            clientDataJSON: '{}',
            authenticatorData: 'AAAA',
            signature: 'AAAA',
          },
        },
        {
          path: '/api/v1/auth/passkey/verify',
          body: {
            credential_id: 'c1',
            clientDataJSON: 12345,
            authenticatorData: 'AAAA',
            signature: 'AAAA',
          },
        },
        { path: '/api/v1/auth/phone/send-code', body: { phone: 12345 } },
        { path: '/api/v1/auth/phone/verify', body: { phone: 12345, code: 123456 } },
        { path: '/api/v1/auth/phone/verify', body: { phone: '+14155551234', code: 123456 } },
        { path: '/api/v1/auth/email/send-code', body: { email: 12345 } },
        { path: '/api/v1/auth/email/verify', body: { email: 12345, code: 123456 } },
        { path: '/api/v1/auth/email/verify', body: { email: 'a@b.com', code: 123456 } },
        { path: '/api/v1/auth/email/register', body: { email: 12345, code: 123456, username: 12345 } },
        {
          path: '/api/v1/auth/email/register',
          body: { email: 'a@b.com', code: '123456', username: 12345 },
        },
        { path: '/api/v1/auth/pair/accept', body: { pair_id: 12345 }, token: u1.token },
        { path: '/api/v1/auth/pair/verify', body: { pair_token: 12345 }, token: u1.token },
        { path: '/api/v1/auth/pair/status', body: { pair_id: 12345 } },
        { path: '/api/v1/invites/join', body: { code: 12345 }, token: u1.token },
      ];
      for (const tc of nonStringCases) {
        const res = await apiJson(baseUrl, 'POST', tc.path, { token: tc.token, body: tc.body });
        expect(res.status, `Expected 400 for ${tc.path} ${JSON.stringify(tc.body)}`).toBe(400);
      }

      // 3. C2-I3-FAIL-1: POST /api/v1/chats non-group/channel username guard fires BEFORE all early returns
      const badChatPayloads = [
        { chat_type: 0, peer_user_id: u2.user_id, username: 'bad_dm_with_peer' },
        { peer_user_id: u2.user_id, username: 'bad_dm_inferred' },
        { chat_type: 0, username: 'bad_dm_minimal' },
        { chat_type: 4, username: 'bad_secret_chat' },
        { chat_type: 5, username: 'bad_saved_chat' },
        { chat_type: 'saved', username: 'bad_saved_str' },
      ];
      for (const payload of badChatPayloads) {
        const r = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
          token: u1.token,
          body: payload,
        });
        expect(r.status, `Expected 400 for ${JSON.stringify(payload)}`).toBe(400);
        expect(r.data.error).toBe('invalid_chat_type');
      }

      // 4. C2-I3-FAIL-2: Terminal 'ended' call state cannot be resurrected via /accept or /signal(accept|answer)
      // (a) DM call
      const dmCreate = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
        token: u1.token,
        body: { peer_user_id: u2.user_id },
      });
      expect(dmCreate.status).toBe(201);
      const dmChatId = Number(dmCreate.data.chat_id);

      const dmCallStart = await apiJson(baseUrl, 'POST', '/api/v1/calls/start', {
        token: u1.token,
        body: { callee_id: u2.user_id, chat_id: dmChatId },
      });
      expect(dmCallStart.status).toBe(201);
      const dmCallId = String(dmCallStart.data.call_id);
      expect(
        (await apiJson(baseUrl, 'POST', `/api/v1/calls/${dmCallId}/accept`, { token: u2.token }))
          .status,
      ).toBe(200);
      const dmEnd1 = await apiJson(baseUrl, 'POST', `/api/v1/calls/${dmCallId}/end`, {
        token: u1.token,
        body: { duration_secs: 25 },
      });
      expect(dmEnd1.status).toBe(200);

      const dmResurrectAccept = await apiJson(
        baseUrl,
        'POST',
        `/api/v1/calls/${dmCallId}/accept`,
        { token: u2.token },
      );
      expect(dmResurrectAccept.status).toBe(409);
      expect(dmResurrectAccept.data.error).toBe('call_already_ended');

      const dmResurrectAnswer = await apiJson(
        baseUrl,
        'POST',
        `/api/v1/calls/${dmCallId}/signal`,
        { token: u2.token, body: { signal_type: 'answer' } },
      );
      expect(dmResurrectAnswer.status).toBe(409);
      expect(dmResurrectAnswer.data.error).toBe('call_already_ended');

      const dmCallDbRow = server.db
        .prepare(`SELECT state, duration_secs FROM call_sessions WHERE call_id = ?`)
        .get(dmCallId) as { state: string; duration_secs: number };
      expect(dmCallDbRow.state).toBe('ended');
      expect(dmCallDbRow.duration_secs).toBe(25);

      const dmEnd2 = await apiJson(baseUrl, 'POST', `/api/v1/calls/${dmCallId}/end`, {
        token: u1.token,
        body: { duration_secs: 777 },
      });
      expect(dmEnd2.status).toBe(200);
      expect(dmEnd2.data.duration_secs).toBe(25);
      const dmCallEndedCount = server.db
        .prepare(`SELECT COUNT(*) AS cnt FROM messages WHERE chat_id = ?`)
        .get(dmChatId) as { cnt: number };
      expect(dmCallEndedCount.cnt).toBe(1);

      // (b) Broadcast channel call — non-admin subscriber callee cannot resurrect ended channel call
      const bcastCreate = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
        token: u1.token,
        body: { title: 'Iter4 Bcast', chat_type: 3, username: 'iter4_bcast_chan' },
      });
      expect(bcastCreate.status).toBe(201);
      const bcastChatId = Number(bcastCreate.data.chat_id);
      expect(
        (await apiJson(baseUrl, 'POST', `/api/v1/chats/${bcastChatId}/join`, { token: u2.token }))
          .status,
      ).toBe(200);

      const chanCallStart = await apiJson(baseUrl, 'POST', '/api/v1/calls/start', {
        token: u1.token,
        body: { callee_id: u2.user_id, chat_id: bcastChatId },
      });
      expect(chanCallStart.status).toBe(201);
      const chanCallId = String(chanCallStart.data.call_id);
      expect(
        (
          await apiJson(baseUrl, 'POST', `/api/v1/calls/${chanCallId}/end`, {
            token: u1.token,
            body: { duration_secs: 12 },
          })
        ).status,
      ).toBe(200);

      const subResurrectAccept = await apiJson(
        baseUrl,
        'POST',
        `/api/v1/calls/${chanCallId}/accept`,
        { token: u2.token },
      );
      expect(subResurrectAccept.status).toBe(409);
      expect(subResurrectAccept.data.error).toBe('call_already_ended');

      const subResurrectSignal = await apiJson(
        baseUrl,
        'POST',
        `/api/v1/calls/${chanCallId}/signal`,
        { token: u2.token, body: { signal_type: 'answer' } },
      );
      expect(subResurrectSignal.status).toBe(409);
      expect(subResurrectSignal.data.error).toBe('call_already_ended');

      const chanCallDbRow = server.db
        .prepare(`SELECT state FROM call_sessions WHERE call_id = ?`)
        .get(chanCallId) as { state: string };
      expect(chanCallDbRow.state).toBe('ended');

      expect(
        (
          await apiJson(baseUrl, 'POST', `/api/v1/calls/${chanCallId}/end`, {
            token: u1.token,
            body: { duration_secs: 12 },
          })
        ).status,
      ).toBe(200);
      const bcastCallEndedCount = server.db
        .prepare(`SELECT COUNT(*) AS cnt FROM messages WHERE chat_id = ?`)
        .get(bcastChatId) as { cnt: number };
      expect(bcastCallEndedCount.cnt).toBe(1);

      // 5. Lone UTF-16 surrogate exclusion in decodeHtmlEntities
      const surrogateOg = await fetchOpenGraphPreview('https://surrogate.example.org/test', {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        requestImpl: async () => ({
          statusCode: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: `<!doctype html><html><head>
            <meta property="og:title" content="Safe &#xD800; &#55296; &#xDFFF; &#57343; &#x1F680; OK" />
          </head><body></body></html>`,
        }),
      });
      expect(surrogateOg?.title).toBe('Safe 🚀 OK');
      expect(
        Array.from(surrogateOg?.title ?? '').every((ch) => {
          const cp = ch.codePointAt(0)!;
          return cp < 0xd800 || cp > 0xdfff;
        }),
      ).toBe(true);
    });
  });

  describe('9. Iteration 5 Surgical Hardening (readJsonBody Plain-Object, WebAuthn clientDataJSON & messages.ts Type Guards)', () => {
    it('rejects non-object JSON bodies, malformed/non-object/non-string WebAuthn clientDataJSON, and non-string messages.ts fields with 400 (zero 500s)', async () => {
      await apiJson(baseUrl, 'POST', '/api/v1/test/reset');
      const u1 = await registerTestUser(baseUrl, 'iter5_user', { first_name: 'Iter5' });

      // 1. C1-I4-FAIL-1: Raw JSON roots null, 12345, [], "abc", true -> strict 400 invalid_json everywhere
      const nonObjectBodies = ['null', '12345', '[]', '"abc"', 'true'];
      const endpoints: Array<{ method: 'POST' | 'PUT'; path: string; token?: string }> = [
        { method: 'POST', path: '/api/v1/auth/login' },
        { method: 'POST', path: '/api/v1/auth/passkey/challenge' },
        { method: 'POST', path: '/api/v1/auth/passkey/verify' },
        { method: 'POST', path: '/api/v1/auth/register' },
        { method: 'POST', path: '/api/v1/auth/passkey/register', token: u1.token },
        { method: 'POST', path: '/api/v1/auth/phone/send-code' },
        { method: 'POST', path: '/api/v1/auth/phone/verify' },
        { method: 'POST', path: '/api/v1/auth/email/send-code' },
        { method: 'POST', path: '/api/v1/auth/email/verify' },
        { method: 'POST', path: '/api/v1/auth/email/register' },
        { method: 'POST', path: '/api/v1/auth/pair/accept', token: u1.token },
        { method: 'PUT', path: '/api/v1/account/privacy', token: u1.token },
        { method: 'PUT', path: '/api/v1/user-vault/items/password/k1', token: u1.token },
        { method: 'POST', path: '/api/v1/user-vault/device-sync/request', token: u1.token },
      ];

      for (const ep of endpoints) {
        for (const rawBody of nonObjectBodies) {
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          if (ep.token) {
            headers.Authorization = `Bearer ${ep.token}`;
          }
          const resp = await fetch(`${baseUrl}${ep.path}`, {
            method: ep.method,
            headers,
            body: rawBody,
          });
          const data = (await resp.json()) as { error?: string };
          expect(
            resp.status,
            `Expected 400 invalid_json for ${ep.method} ${ep.path} with body=${rawBody}`,
          ).toBe(400);
          expect(data.error).toBe('invalid_json');
        }
      }

      // 2. C1-I4-FAIL-2: WebAuthn clientDataJSON non-null object & strict string guards
      const b64u = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
      const dummyAuthData = Buffer.alloc(37, 0x01).toString('base64url');
      const dummySig = Buffer.alloc(64, 0x02).toString('base64url');
      const ecKey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const spkiB64 = (
        ecKey.publicKey.export({ type: 'spki', format: 'der' }) as Buffer
      ).toString('base64');

      const badVerifyClientDataPayloads: unknown[] = [
        'bnVsbA==',
        b64u('[]'),
        b64u('123'),
        b64u(JSON.stringify({ type: 12345, challenge: 'abc', origin: baseUrl })),
        b64u(JSON.stringify({ type: 'webauthn.get', challenge: 12345, origin: baseUrl })),
        b64u(JSON.stringify({ type: 'webauthn.get', challenge: { x: 1 }, origin: baseUrl })),
        b64u(JSON.stringify({ type: 'webauthn.get', challenge: 'abc', origin: 12345 })),
      ];
      for (const cd of badVerifyClientDataPayloads) {
        const res = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/verify', {
          body: {
            credential_id: 'cred_fake_iter5',
            clientDataJSON: cd,
            authenticatorData: dummyAuthData,
            signature: dummySig,
          },
        });
        expect(res.status, `Expected 400 on /passkey/verify for clientDataJSON=${String(cd)}`).toBe(
          400,
        );
        expect(res.data.error).toBe('invalid_passkey_assertion');
      }

      const badRegisterClientDataPayloads: unknown[] = [
        'bnVsbA==',
        b64u('[]'),
        b64u('123'),
        12345,
        b64u(JSON.stringify({ type: 12345, challenge: 'abc', origin: baseUrl })),
        b64u(JSON.stringify({ type: 'webauthn.create', challenge: 12345, origin: baseUrl })),
        b64u(JSON.stringify({ type: 'webauthn.create', challenge: { x: 1 }, origin: baseUrl })),
        b64u(JSON.stringify({ type: 'webauthn.create', challenge: 'abc', origin: 12345 })),
      ];
      for (const cd of badRegisterClientDataPayloads) {
        // (a) Attestation registration branch
        const attRes = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/register', {
          token: u1.token,
          body: {
            attestationObject: 'oA',
            clientDataJSON: cd,
          },
        });
        expect(
          attRes.status,
          `Expected 400 on /passkey/register (attestation) for clientDataJSON=${String(cd)}`,
        ).toBe(400);
        expect(attRes.data.error).toBe('invalid_passkey_attestation');

        // (b) Direct SPKI public_key_b64 + clientDataJSON branch
        const directRes = await apiJson(baseUrl, 'POST', '/api/v1/auth/passkey/register', {
          token: u1.token,
          body: {
            public_key_b64: spkiB64,
            clientDataJSON: cd,
          },
        });
        expect(
          directRes.status,
          `Expected 400 on /passkey/register (direct SPKI) for clientDataJSON=${String(cd)}`,
        ).toBe(400);
        expect(directRes.data.error).toBe('invalid_passkey_attestation');
      }

      // 3. Bonus hygiene: Non-string / malformed fields on routes/messages.ts -> 400 (zero 500s)
      const grp = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
        token: u1.token,
        body: { title: 'Iter5 Messages Guard', chat_type: 1 },
      });
      expect(grp.status).toBe(201);
      const chatId = Number(grp.data.chat_id);

      const seedMsg = await apiJson(baseUrl, 'POST', `/api/v1/chats/${chatId}/messages`, {
        token: u1.token,
        body: { text: 'Valid baseline message' },
      });
      expect(seedMsg.status).toBe(201);
      const msgId = Number(seedMsg.data.message_id);

      const badMessageCases: Array<{
        method: 'POST' | 'PATCH';
        path: string;
        body: Record<string, unknown>;
      }> = [
        { method: 'POST', path: `/api/v1/chats/${chatId}/messages`, body: { text: 12345 } },
        {
          method: 'PATCH',
          path: `/api/v1/chats/${chatId}/messages/${msgId}`,
          body: { text: 12345 },
        },
        {
          method: 'POST',
          path: `/api/v1/chats/${chatId}/messages/forward`,
          body: { from_chat_id: chatId, to_chat_id: chatId, message_ids: [msgId], comment: 12345 },
        },
        {
          method: 'POST',
          path: `/api/v1/chats/${chatId}/callback`,
          body: { callback_data: 12345 },
        },
        {
          method: 'POST',
          path: `/api/v1/chats/${chatId}/messages/${msgId}/reactions`,
          body: { emoji: 12345 },
        },
        {
          method: 'POST',
          path: `/api/v1/chats/${chatId}/polls`,
          body: { question: 12345, options: ['A', 'B'] },
        },
        {
          method: 'POST',
          path: `/api/v1/chats/${chatId}/polls`,
          body: { question: 'Valid Q?', options: [12345, 'B'] },
        },
        {
          method: 'POST',
          path: `/api/v1/chats/${chatId}/polls`,
          body: { question: 'Valid Q?', options: 12345 },
        },
        {
          method: 'POST',
          path: `/api/v1/chats/${chatId}/todos`,
          body: { title: 12345, items: ['item 1'] },
        },
        {
          method: 'POST',
          path: `/api/v1/chats/${chatId}/todos`,
          body: { title: 'Valid Todo', items: [{ title: 12345 }] },
        },
        {
          method: 'POST',
          path: `/api/v1/chats/${chatId}/invoices`,
          body: { title: 12345 },
        },
        {
          method: 'POST',
          path: `/api/v1/chats/${chatId}/invoices`,
          body: { description: 12345 },
        },
        {
          method: 'POST',
          path: `/api/v1/chats/${chatId}/invoices`,
          body: { currency: 12345 },
        },
        {
          method: 'POST',
          path: `/api/v1/chats/${chatId}/messages/${msgId}/pay`,
          body: { idempotency_key: 12345 },
        },
        {
          method: 'POST',
          path: '/api/v1/messages/ai-compose',
          body: { text: 12345 },
        },
        {
          method: 'POST',
          path: '/api/v1/messages/ai-compose',
          body: { text: 'polish this', mode: 12345 },
        },
      ];

      for (const tc of badMessageCases) {
        const res = await apiJson(baseUrl, tc.method, tc.path, {
          token: u1.token,
          body: tc.body,
        });
        expect(
          res.status,
          `Expected 400 for ${tc.method} ${tc.path} ${JSON.stringify(tc.body)}`,
        ).toBe(400);
      }
    });
  });

  // ============================================================================
  // 10. Iteration 6 Surgical Hardening (C2-I5-FAIL-1..4 + RFC 9110 Host Guard)
  // ============================================================================
  describe('10. Iteration 6 Surgical Hardening (WS Frame Guard, Prototype-Safe Maps, Invoice NaN & SQLite Scalar Binding)', () => {
    const sendRawWsExpectError = async (
      endpointUrl: string,
      rawFrame: string,
    ): Promise<{ type: string; payload?: { code?: number; message?: string } }> => {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(endpointUrl);
        const timer = setTimeout(() => {
          ws.terminate();
          reject(new Error(`Timed out waiting for Error frame on ${endpointUrl} (${rawFrame})`));
        }, 4000);
        ws.once('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        ws.once('open', () => {
          ws.send(rawFrame);
        });
        ws.on('message', (data) => {
          let parsed: { type: string; payload?: { code?: number; message?: string } };
          try {
            parsed = JSON.parse(data.toString('utf8'));
          } catch (err) {
            clearTimeout(timer);
            ws.close();
            reject(err);
            return;
          }
          if (parsed.type === 'AuthOk') {
            return;
          }
          clearTimeout(timer);
          ws.close();
          resolve(parsed);
        });
      });
    };

    const expectWsUpgradeRejected401 = (endpointUrl: string): Promise<number> => {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(endpointUrl);
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          ws.terminate();
          reject(new Error(`Timed out waiting for 401 rejection on ${endpointUrl}`));
        }, 4000);
        ws.once('open', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ws.terminate();
          reject(new Error(`Expected 401 upgrade rejection on ${endpointUrl}, but connection opened`));
        });
        ws.once('unexpected-response', (_req, res) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          res.resume();
          ws.terminate();
          resolve(res.statusCode ?? 0);
        });
        ws.on('error', (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        });
      });
    };

    const sendRawHostRequest = async (
      port: number,
      targetPath: string,
      hostHeader: string,
    ): Promise<{ statusCode: number; body: string }> => {
      return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
          socket.write(
            `GET ${targetPath} HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`,
          );
        });
        const chunks: Buffer[] = [];
        socket.on('data', (chunk) => chunks.push(chunk));
        socket.on('error', reject);
        socket.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          const sep = raw.indexOf('\r\n\r\n');
          const head = sep >= 0 ? raw.slice(0, sep) : raw;
          const body = sep >= 0 ? raw.slice(sep + 4) : '';
          const statusMatch = /^HTTP\/1\.\d\s+(\d{3})/.exec(head);
          resolve({ statusCode: statusMatch ? Number(statusMatch[1]) : 0, body });
        });
      });
    };

    it('C2-I5-FAIL-1: rejects raw JSON null/12345/[]/{} WS frames with 400 without crashing on /ws, /tailnet/derp, and /browser/ws', async () => {
      await apiJson(baseUrl, 'POST', '/api/v1/test/reset');
      const u1 = await registerTestUser(baseUrl, 'iter6_ws_u', { first_name: 'WsGuard' });

      const wsOrigin = baseUrl.replace(/^http/, 'ws');

      // /api/v1/ws MUST fail-closed with 401 at HTTP upgrade when token is omitted or empty
      expect(await expectWsUpgradeRejected401(`${wsOrigin}/api/v1/ws`)).toBe(401);
      expect(await expectWsUpgradeRejected401(`${wsOrigin}/api/v1/ws?token=`)).toBe(401);
      expect(await expectWsUpgradeRejected401(`${wsOrigin}/api/v1/ws?mode=derp`)).toBe(401);

      const malformedFrameEndpoints = [
        `${wsOrigin}/api/v1/ws?token=${encodeURIComponent(u1.token)}`,
        `${wsOrigin}/api/v1/tailnet/derp`,
        `${wsOrigin}/api/v1/browser/ws`,
      ];
      const malformedFrames = ['null', '12345', '[]', '{}', '{"type":123}'];

      for (const ep of malformedFrameEndpoints) {
        for (const frame of malformedFrames) {
          const resp = await sendRawWsExpectError(ep, frame);
          expect(resp.type, `Expected Error frame on ${ep} for ${frame}`).toBe('Error');
          expect(resp.payload?.code, `Expected code 400 on ${ep} for ${frame}`).toBe(400);
        }
      }

      // Server MUST still be alive and healthy after all malformed unauthenticated WS frames
      const healthRes = await fetch(`${baseUrl}/health`);
      expect(healthRes.status).toBe(200);
      expect(await healthRes.text()).toBe('OK');

      // Authenticated WS malformed command payloads -> 400 Error (never crashes hub)
      const authedWs = await connectWsAuthenticated(wsUrl, u1.token);
      try {
        const badCmdFrames = [
          JSON.stringify({ type: 'SendMessage', payload: null }),
          JSON.stringify({ type: 'SendMessage', payload: 12345 }),
          JSON.stringify({ type: 'SendMessage', payload: [] }),
          JSON.stringify({ type: 'EditMessage', payload: null }),
          JSON.stringify({ type: 'SendReaction', payload: 'bad' }),
          JSON.stringify({ type: 'SendReaction', payload: { chat_id: 1, message_id: 1, emoji: { evil: 1 } } }),
          JSON.stringify({ type: 'CallSignal', payload: [] }),
        ];
        for (const badFrame of badCmdFrames) {
          const beforeCount = authedWs.frames.length;
          authedWs.ws.send(badFrame);
          const errFrame = await authedWs.waitForFrame(
            (m: { type?: string }) =>
              m.type === 'Error' && authedWs.frames.indexOf(m) >= beforeCount,
            3000,
          );
          expect(errFrame.payload?.code).toBe(400);
        }
      } finally {
        authedWs.ws.close();
      }

      const healthAfter = await fetch(`${baseUrl}/health`);
      expect(healthAfter.status).toBe(200);
      expect(await healthAfter.text()).toBe('OK');
    });

    it('C2-I5-FAIL-2, C2-I5-FAIL-3, C2-I5-FAIL-4 & Host guard: blocks prototype lookups, invoice NaN, all 19 SQLite binding crashes, and malformed Host headers', async () => {
      await apiJson(baseUrl, 'POST', '/api/v1/test/reset');
      const u1 = await registerTestUser(baseUrl, 'iter6_u1', { first_name: 'Iter6A' });
      const u2 = await registerTestUser(baseUrl, 'iter6_u2', { first_name: 'Iter6B' });

      const grp = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
        token: u1.token,
        body: { title: 'Iter6 Human Group', chat_type: 1, member_ids: [u2.user_id] },
      });
      expect(grp.status).toBe(201);
      const gid = Number(grp.data.chat_id);

      const baseMsg = await apiJson(baseUrl, 'POST', `/api/v1/chats/${gid}/messages`, {
        token: u1.token,
        body: { text: 'Iter6 baseline msg' },
      });
      expect(baseMsg.status).toBe(201);
      const msgId = Number(baseMsg.data.message_id);

      // 1. C2-I5-FAIL-2: Prototype-property lookup bypass on callback & ai-compose
      for (const protoKey of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
        const cbRes = await apiJson(baseUrl, 'POST', `/api/v1/chats/${gid}/callback`, {
          token: u1.token,
          body: { callback_data: protoKey },
        });
        expect(cbRes.status, `Expected 422 for callback_data=${protoKey}`).toBe(422);
        expect(cbRes.data.error).toBe('unknown_callback');
      }

      // Verify ai-compose with mode="toString" never passes Object.prototype.toString as system prompt
      let capturedSystemPrompt: unknown = null;
      const mockLlm = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const reqBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            messages?: Array<{ role: string; content: unknown }>;
          };
          capturedSystemPrompt = reqBody.messages?.find((m) => m.role === 'system')?.content ?? null;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              choices: [{ message: { content: 'Polished hi' } }],
            }),
          );
        });
      });
      await new Promise<void>((resolve) => mockLlm.listen(0, '127.0.0.1', resolve));
      const mockLlmPort = (mockLlm.address() as net.AddressInfo).port;
      try {
        const addProv = await apiJson(baseUrl, 'POST', '/api/v1/hermes/magpie/providers', {
          token: u1.token,
          body: {
            provider_id: 'iter6_mock_llm',
            name: 'Iter6 Mock LLM',
            base_url: `http://127.0.0.1:${mockLlmPort}/v1`,
            api_key: ['test', 'iter6', 'key'].join('-'),
            default_model: 'mock-model',
            enabled: true,
          },
        });
        expect([200, 201]).toContain(addProv.status);

        const aiComposeRes = await apiJson(baseUrl, 'POST', '/api/v1/messages/ai-compose', {
          token: u1.token,
          body: { text: 'hi', mode: 'toString' },
        });
        expect(aiComposeRes.status).toBe(200);
        expect(typeof capturedSystemPrompt).toBe('string');
        expect(String(capturedSystemPrompt)).toContain('Polish and improve');
        expect(String(capturedSystemPrompt)).not.toContain('native code');
      } finally {
        mockLlm.closeAllConnections?.();
        await new Promise<void>((resolve) => mockLlm.close(() => resolve()));
      }

      // 2. C2-I5-FAIL-3: Invoice amount validation (NaN, 0, negative, float, object) + /pay guard
      for (const badAmt of ['bad', 0, -5, 1.5, {}, true]) {
        const invRes = await apiJson(baseUrl, 'POST', `/api/v1/chats/${gid}/invoices`, {
          token: u1.token,
          body: { title: 'Bad Invoice', amount: badAmt, currency: 'XTR' },
        });
        expect(invRes.status, `Expected 400 for amount=${JSON.stringify(badAmt)}`).toBe(400);
        expect(invRes.data.error).toBe('invalid_invoice');
      }

      // Corrupt an existing invoice card's total_amount to null in DB and ensure /pay strictly rejects with 400
      const goodInv = await apiJson(baseUrl, 'POST', `/api/v1/chats/${gid}/invoices`, {
        token: u1.token,
        body: { title: 'Good Invoice', amount: 50, currency: 'XTR' },
      });
      expect(goodInv.status).toBe(201);
      const invMsgId = Number(goodInv.data.message.id);
      server.db
        .prepare(`UPDATE messages SET content_json = ? WHERE chat_id = ? AND message_id = ?`)
        .run(
          JSON.stringify({
            type: 'Invoice',
            data: { ...goodInv.data.invoice, total_amount: null, amount_cents: null },
          }),
          gid,
          invMsgId,
        );
      const selfPayCorrupt = await apiJson(
        baseUrl,
        'POST',
        `/api/v1/chats/${gid}/messages/${invMsgId}/pay`,
        { token: u1.token, body: { idempotency_key: 'pay-corrupt-self' } },
      );
      expect(selfPayCorrupt.status).toBe(400);
      expect(selfPayCorrupt.data.error).toBe('invalid_invoice');
      const crossPayCorrupt = await apiJson(
        baseUrl,
        'POST',
        `/api/v1/chats/${gid}/messages/${invMsgId}/pay`,
        { token: u2.token, body: { idempotency_key: 'pay-corrupt-cross' } },
      );
      expect(crossPayCorrupt.status).toBe(400);
      expect(crossPayCorrupt.data.error).toBe('invalid_invoice');

      // 3. C2-I5-FAIL-4: All 19 malformed-field / node:sqlite plain-object binding payloads -> strict 400 (zero 500s)
      const callStart = await apiJson(baseUrl, 'POST', '/api/v1/calls/start', {
        token: u1.token,
        body: { callee_id: u2.user_id, chat_id: gid },
      });
      expect(callStart.status).toBe(201);
      const callId = String(callStart.data.call_id);

      const fail4Cases: Array<{
        method: 'POST' | 'PATCH' | 'PUT';
        path: string;
        body: Record<string, unknown>;
      }> = [
        // Messages
        { method: 'POST', path: `/api/v1/chats/${gid}/messages`, body: { content: 12345 } },
        {
          method: 'POST',
          path: `/api/v1/chats/${gid}/messages`,
          body: { content: { type: 'Text', data: null } },
        },
        {
          method: 'POST',
          path: `/api/v1/chats/${gid}/messages`,
          body: { content: { type: 'Text', data: { text: 12345 } } },
        },
        { method: 'POST', path: `/api/v1/chats/${gid}/messages`, body: { text: 'hi', topic_id: {} } },
        { method: 'POST', path: `/api/v1/chats/${gid}/messages`, body: { text: 'hi', ttl_seconds: {} } },
        { method: 'POST', path: `/api/v1/chats/${gid}/messages`, body: { text: 'hi', ttl_seconds: true } },
        {
          method: 'POST',
          path: `/api/v1/chats/${gid}/messages`,
          body: { text: 'hi', reply_to: { reply_to_msg_id: {}, quote_text: 12345 } },
        },
        // Edit
        { method: 'PATCH', path: `/api/v1/chats/${gid}/messages/${msgId}`, body: { content: 12345 } },
        // Forward
        {
          method: 'POST',
          path: `/api/v1/chats/${gid}/messages/forward`,
          body: { from_chat_id: gid, to_chat_id: gid, message_ids: [], comment: 'hi', topic_id: {} },
        },
        // Polls
        {
          method: 'POST',
          path: `/api/v1/chats/${gid}/polls`,
          body: { question: 'Q', options: ['a', 'b'], topic_id: {} },
        },
        {
          method: 'POST',
          path: `/api/v1/chats/${gid}/polls`,
          body: { question: 'Q', options: ['a', 'b'], is_quiz: true, correct_option_id: {} },
        },
        // Todos
        {
          method: 'POST',
          path: `/api/v1/chats/${gid}/todos`,
          body: { title: 'T', items: ['a'], topic_id: {} },
        },
        // Invoices topic_id
        {
          method: 'POST',
          path: `/api/v1/chats/${gid}/invoices`,
          body: { title: 'Inv', amount: 10, topic_id: {} },
        },
        // Chats create
        {
          method: 'POST',
          path: '/api/v1/chats',
          body: { chat_type: 1, title: 'AdvGrp', member_ids: 12345 },
        },
        {
          method: 'POST',
          path: '/api/v1/chats',
          body: { chat_type: 1, title: 'AdvGrp2', member_usernames: 12345 },
        },
        // Chat members
        { method: 'POST', path: `/api/v1/chats/${gid}/members`, body: { user_ids: 12345 } },
        { method: 'POST', path: `/api/v1/chats/${gid}/members`, body: { user_id: { evil: 1 } } },
        // Chat PATCH metadata (non-empty and empty plain object!)
        { method: 'PATCH', path: `/api/v1/chats/${gid}`, body: { about: { evil: 1 } } },
        { method: 'PATCH', path: `/api/v1/chats/${gid}`, body: { about: {} } },
        { method: 'PATCH', path: `/api/v1/chats/${gid}`, body: { photo_file_id: { evil: 1 } } },
        { method: 'PATCH', path: `/api/v1/chats/${gid}`, body: { photo_file_id: {} } },
        // Invites
        { method: 'POST', path: `/api/v1/chats/${gid}/invites`, body: { title: { x: 1 } } },
        { method: 'POST', path: `/api/v1/chats/${gid}/invites`, body: { usage_limit: { x: 1 } } },
        { method: 'POST', path: `/api/v1/chats/${gid}/invites`, body: { expire_date_ms: { x: 1 } } },
        // Settings
        { method: 'POST', path: `/api/v1/chats/${gid}/settings`, body: { folder_id: { x: 1 } } },
        { method: 'POST', path: `/api/v1/chats/${gid}/settings`, body: { muted_until_ms: { x: 1 } } },
        // Draft / TTL / Folders siblings
        { method: 'PUT', path: `/api/v1/chats/${gid}/draft`, body: { text: { x: 1 } } },
        { method: 'PUT', path: `/api/v1/chats/${gid}/draft`, body: { text: 'ok', reply_to_msg_id: {} } },
        { method: 'POST', path: `/api/v1/chats/${gid}/ttl`, body: { ttl_seconds: { x: 1 } } },
        { method: 'POST', path: '/api/v1/folders', body: { title: 'F', icon: { x: 1 } } },
        { method: 'POST', path: '/api/v1/folders', body: { title: 'F', included_chat_ids: 12345 } },
        // Calls end & rate
        { method: 'POST', path: `/api/v1/calls/${callId}/end`, body: { rating: { evil: 1 } } },
        { method: 'POST', path: `/api/v1/calls/${callId}/end`, body: { duration_secs: { evil: 1 } } },
        { method: 'POST', path: `/api/v1/calls/${callId}/end`, body: { comment: { evil: 1 } } },
        { method: 'POST', path: `/api/v1/calls/${callId}/rate`, body: { rating: { evil: 1 } } },
        { method: 'POST', path: `/api/v1/calls/${callId}/rate`, body: { rating: 9 } },
        // Stories
        { method: 'POST', path: '/api/v1/stories', body: { caption: { x: 1 } } },
        { method: 'POST', path: '/api/v1/stories', body: { media_file_id: { x: 1 } } },
        { method: 'POST', path: '/api/v1/stories', body: { privacy: { x: 1 } } },
        { method: 'POST', path: '/api/v1/stories', body: { ttl_hours: { x: 1 } } },
      ];

      for (const tc of fail4Cases) {
        const res = await apiJson(baseUrl, tc.method, tc.path, {
          token: u1.token,
          body: tc.body,
        });
        expect(
          res.status,
          `Expected 400 for ${tc.method} ${tc.path} ${JSON.stringify(tc.body)} (got ${res.status}: ${res.rawText})`,
        ).toBe(400);
      }

      // 4. Bonus RFC 9110 §7.2 Host Header Syntax Guard
      const evilHostRes = await sendRawHostRequest(serverPort, '/health', 'http://evil.com');
      expect(evilHostRes.statusCode).toBe(400);
      expect(JSON.parse(evilHostRes.body).error).toBe('invalid_request_url');

      const slashHostRes = await sendRawHostRequest(serverPort, '/health', 'evil.com/path');
      expect(slashHostRes.statusCode).toBe(400);
      expect(JSON.parse(slashHostRes.body).error).toBe('invalid_request_url');

      const okHostRes = await sendRawHostRequest(serverPort, '/health', `127.0.0.1:${serverPort}`);
      expect(okHostRes.statusCode).toBe(200);
      expect(okHostRes.body).toBe('OK');
    });

    it('R2-I6-BLOCK-1 & P2-OBS-2: rejects omitted content.data, guards malformed Todo/Invoice cards, and safely clamps non-integer limit/offset query params', async () => {
      await apiJson(baseUrl, 'POST', '/api/v1/test/reset');
      const u1 = await registerTestUser(baseUrl, 'iter7_u1', { first_name: 'Iter7A' });
      const u2 = await registerTestUser(baseUrl, 'iter7_u2', { first_name: 'Iter7B' });

      const grp = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
        token: u1.token,
        body: { title: 'Iter7 Group', chat_type: 1, member_ids: [u2.user_id] },
      });
      expect(grp.status).toBe(201);
      const gid = Number(grp.data.chat_id);

      const baseMsg = await apiJson(baseUrl, 'POST', `/api/v1/chats/${gid}/messages`, {
        token: u1.token,
        body: { text: 'hi iter7 baseline' },
      });
      expect(baseMsg.status).toBe(201);
      const baseMsgId = Number(baseMsg.data.message_id);

      // 1. Omitted content.data rejected across all variants on POST and PATCH -> 400 invalid_content
      for (const contentType of ['Invoice', 'Todo', 'Photo']) {
        const postRes = await apiJson(baseUrl, 'POST', `/api/v1/chats/${gid}/messages`, {
          token: u1.token,
          body: { content: { type: contentType } },
        });
        expect(postRes.status, `Expected 400 for POST omitted data (${contentType})`).toBe(400);
        expect(postRes.data.error).toBe('invalid_content');

        const patchRes = await apiJson(
          baseUrl,
          'PATCH',
          `/api/v1/chats/${gid}/messages/${baseMsgId}`,
          {
            token: u1.token,
            body: { content: { type: contentType } },
          },
        );
        expect(patchRes.status, `Expected 400 for PATCH omitted data (${contentType})`).toBe(400);
        expect(patchRes.data.error).toBe('invalid_content');
      }

      // 2. Malformed Todo cards -> 400 invalid_todo (never 500)
      for (const badTodoData of [{}, { items: 'not-array' }, { items: [null] }]) {
        const todoMsg = await apiJson(baseUrl, 'POST', `/api/v1/chats/${gid}/messages`, {
          token: u1.token,
          body: { content: { type: 'Todo', data: badTodoData } },
        });
        expect(todoMsg.status).toBe(201);
        const todoRes = await apiJson(
          baseUrl,
          'POST',
          `/api/v1/chats/${gid}/messages/${todoMsg.data.message_id}/todo`,
          {
            token: u1.token,
            body: { item_id: 'item_1' },
          },
        );
        expect(todoRes.status, `Expected 400 for malformed Todo ${JSON.stringify(badTodoData)}`).toBe(
          400,
        );
        expect(todoRes.data.error).toBe('invalid_todo');
      }

      // 3. Malformed Invoice currency/title ({toString: null}) & legacy missing-data DB row -> 400 invalid_invoice
      const badInvMsg = await apiJson(baseUrl, 'POST', `/api/v1/chats/${gid}/messages`, {
        token: u1.token,
        body: {
          content: {
            type: 'Invoice',
            data: {
              is_paid: false,
              total_amount: 1,
              currency: { toString: null },
              title: { toString: null },
            },
          },
        },
      });
      expect(badInvMsg.status).toBe(201);
      const badInvPay = await apiJson(
        baseUrl,
        'POST',
        `/api/v1/chats/${gid}/messages/${badInvMsg.data.message_id}/pay`,
        {
          token: u1.token,
          body: {},
        },
      );
      expect(badInvPay.status).toBe(400);
      expect(badInvPay.data.error).toBe('invalid_invoice');

      // Direct DB corruption omitting data on Invoice -> 400 invalid_invoice before reading card.is_paid
      server.db
        .prepare(`UPDATE messages SET content_json = ? WHERE chat_id = ? AND message_id = ?`)
        .run(JSON.stringify({ type: 'Invoice' }), gid, badInvMsg.data.message_id);
      const missingDataInvPay = await apiJson(
        baseUrl,
        'POST',
        `/api/v1/chats/${gid}/messages/${badInvMsg.data.message_id}/pay`,
        {
          token: u1.token,
          body: {},
        },
      );
      expect(missingDataInvPay.status).toBe(400);
      expect(missingDataInvPay.data.error).toBe('invalid_invoice');

      // 4. P2-OBS-2: Non-integer / NaN / float / huge limit & offset query params -> clean 200 (zero 500s)
      const queryCases = [
        `/api/v1/chats/${gid}/messages?limit=abc`,
        `/api/v1/chats/${gid}/messages?limit=1.5`,
        `/api/v1/chats/${gid}/messages?limit=`,
        '/api/v1/search?q=hi&limit=abc&offset=abc',
        '/api/v1/search?q=hi&limit=1.5&offset=1e30',
        '/api/v1/users/search?limit=abc',
        '/api/v1/users/search?limit=1.5',
      ];
      for (const path of queryCases) {
        const res = await apiJson(baseUrl, 'GET', path, { token: u1.token });
        expect(res.status, `Expected 200 for GET ${path} (got ${res.status}: ${res.rawText})`).toBe(
          200,
        );
      }
    });

    it('Tier 5 Hardening: blocks cross-user WS disconnect IDOR on DELETE /auth/sessions/:id, strips unsafe TextUrl entities server-side, and purges M3 tables on DELETE /account', async () => {
      await apiJson(baseUrl, 'POST', '/api/v1/test/reset');
      const victim = await registerTestUser(baseUrl, 't5_victim', { first_name: 'T5Victim' });
      const attacker = await registerTestUser(baseUrl, 't5_attacker', { first_name: 'T5Attacker' });

      // 1. Cross-user WS disconnect IDOR guard on DELETE /api/v1/auth/sessions/:sessionId
      const victimWs = await connectWsAuthenticated(wsUrl, victim.token);
      let victimClosed = false;
      victimWs.ws.on('close', () => {
        victimClosed = true;
      });
      try {
        const idorRes = await apiJson(
          baseUrl,
          'DELETE',
          `/api/v1/auth/sessions/${encodeURIComponent(victim.session_id)}`,
          { token: attacker.token },
        );
        expect(idorRes.status).toBe(200);
        await new Promise((r) => setTimeout(r, 120));
        expect(victimClosed).toBe(false);
        expect(victimWs.ws.readyState).toBe(1);
      } finally {
        victimWs.ws.close();
      }

      // 2. Server-side TextUrl sanitization strips javascript: and data: while keeping https:
      const dmRes = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
        token: attacker.token,
        body: { chat_type: 1, title: 'T5 Link Sanitization', member_ids: [victim.user_id] },
      });
      expect([200, 201]).toContain(dmRes.status);
      const dmChatId = Number(dmRes.data.chat_id ?? dmRes.data.id);

      const sendRes = await apiJson(baseUrl, 'POST', `/api/v1/chats/${dmChatId}/messages`, {
        token: attacker.token,
        body: {
          text: 'bad1 bad2 good',
          entities: [
            {
              offset: 0,
              length: 4,
              entity_type: { type: 'TextUrl', value: { url: 'javascript:alert(1)' } },
            },
            {
              offset: 5,
              length: 4,
              entity_type: { type: 'TextUrl', value: { url: 'data:text/html,<h1>x</h1>' } },
            },
            {
              offset: 10,
              length: 4,
              entity_type: { type: 'TextUrl', value: { url: 'https://example.com/safe' } },
            },
          ],
        },
      });
      expect(sendRes.status).toBe(201);
      const persistedEntities = (sendRes.data.message?.entities ?? []) as Array<{
        url?: string;
        entity_type?: { type?: string; value?: { url?: string } };
      }>;
      expect(persistedEntities).toHaveLength(1);
      expect(persistedEntities[0]?.url ?? persistedEntities[0]?.entity_type?.value?.url).toBe(
        'https://example.com/safe',
      );

      // 3. DELETE /api/v1/account purges M3 tables (browser pairing tickets, remote assist, etc.)
      const pairRes = await apiJson(baseUrl, 'POST', '/api/v1/browser/pair/create', {
        token: victim.token,
        body: { label: 'Victim Browser' },
      });
      expect([200, 201]).toContain(pairRes.status);
      const assistRes = await apiJson(baseUrl, 'GET', '/api/v1/remote/assist/info', {
        token: victim.token,
      });
      expect(assistRes.status).toBe(200);

      const delRes = await apiJson(baseUrl, 'DELETE', '/api/v1/account', {
        token: victim.token,
      });
      expect(delRes.status).toBe(200);
      expect(
        server.db.prepare(`SELECT 1 FROM browser_pairing_tickets WHERE user_id = ?`).get(victim.user_id),
      ).toBeUndefined();
      expect(
        server.db.prepare(`SELECT 1 FROM browser_desktop_tokens WHERE user_id = ?`).get(victim.user_id),
      ).toBeUndefined();
      expect(
        server.db.prepare(`SELECT 1 FROM remote_assist_devices WHERE user_id = ?`).get(victim.user_id),
      ).toBeUndefined();
    });
  });
});
