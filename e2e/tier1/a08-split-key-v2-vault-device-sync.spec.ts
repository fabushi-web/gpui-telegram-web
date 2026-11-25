import { test, expect } from '../helpers/fixtures';
import { API_PATHS, VAULT_SETTINGS_PANEL } from '../helpers/selectors';
import {
  apiUrl,
  authHeaders,
  generateUniqueUsername,
  registerUserViaApi,
} from '../helpers/server';
import {
  generateRandomB64,
  generateSplitKeyMaterial,
  generateWrappedRootKeyB64,
  generateX25519KeyMaterial,
  generateX25519SealedRootKeyB64,
} from '../helpers/api';
import { bilingualRegex, openSettings, scopedButton } from '../helpers/ui';

test.describe('Tier 1 — A08: Split-Key V2 Zero-Knowledge Auth, E2EE User Vault & X25519 Device Trust Ring', () => {
  test('A08-T1-01: GET /api/v1/auth/kdf-params & Split-Key V2 registration (auth_version: 2) + V2 verifier login', async ({
    request,
  }) => {
    const username = generateUniqueUsername('splitv2');
    const split = generateSplitKeyMaterial('v2-secret-seed');

    const regRes = await request.post(apiUrl(API_PATHS.authRegister), {
      data: {
        username,
        first_name: 'SplitKey V2 User',
        auth_version: 2,
        auth_salt_b64: split.saltB64,
        auth_verifier_b64: split.verifierB64,
        kdf_params: split.kdfParams,
      },
    });
    expect([200, 201]).toContain(regRes.status());
    const regBody = (await regRes.json()) as { auth_version?: number; token?: string };
    expect(regBody.auth_version).toBe(2);
    expect(regBody.token).toBeTruthy();

    // KDF params lookup returns stored V2 salt and Argon2id params
    const kdfRes = await request.get(
      `${apiUrl(API_PATHS.authKdfParams)}?username=${encodeURIComponent(username)}`,
    );
    expect(kdfRes.status()).toBe(200);
    const kdfBody = (await kdfRes.json()) as {
      auth_version?: number;
      auth_salt_b64?: string;
      kdf_params?: { m_cost_kib: number; t_cost: number; p_cost: number };
    };
    expect(kdfBody.auth_version).toBe(2);
    expect(kdfBody.auth_salt_b64).toBe(split.saltB64);
    expect(kdfBody.kdf_params?.m_cost_kib).toBe(65536);

    // Login using V2 verifier succeeds cleanly
    const loginRes = await request.post(apiUrl(API_PATHS.authLogin), {
      data: {
        username,
        password: '',
        auth_verifier_b64: split.verifierB64,
        device_name: 'V2 Verifier Client',
      },
    });
    expect(loginRes.status()).toBe(200);
    const loginBody = (await loginRes.json()) as { auth_version?: number; token?: string };
    expect(loginBody.auth_version).toBe(2);
    expect(loginBody.token).toBeTruthy();
  });

  test('A08-T1-02: Silent V1 -> Split-Key V2 account upgrade (POST /api/v1/auth/upgrade-split-key) and V2 password rotation (POST /api/v1/auth/change-password)', async ({
    request,
  }) => {
    const user = await registerUserViaApi(request, {
      username: generateUniqueUsername('upgradev2'),
      password: 'LegacyV1Password!2026',
    });

    const split1 = generateSplitKeyMaterial('upgrade-v2-seed');
    const upRes = await request.post(apiUrl(API_PATHS.authUpgradeSplitKey), {
      headers: authHeaders(user.token),
      data: {
        old_password: user.password,
        auth_salt_b64: split1.saltB64,
        auth_verifier_b64: split1.verifierB64,
        kdf_params: split1.kdfParams,
      },
    });
    expect(upRes.status()).toBe(200);
    const upBody = (await upRes.json()) as { ok?: boolean; auth_version?: number };
    expect(upBody.ok).toBe(true);
    expect(upBody.auth_version).toBe(2);

    // Rotate V2 verifier via change-password
    const split2 = generateSplitKeyMaterial('rotated-v2-seed');
    const rotRes = await request.post(apiUrl(API_PATHS.authChangePassword), {
      headers: authHeaders(user.token),
      data: {
        old_secret: split1.verifierB64,
        auth_version: 2,
        new_auth_salt_b64: split2.saltB64,
        new_auth_verifier_b64: split2.verifierB64,
        new_kdf_params: split2.kdfParams,
      },
    });
    expect(rotRes.status()).toBe(200);
    const rotBody = (await rotRes.json()) as { ok?: boolean; auth_version?: number };
    expect(rotBody.ok).toBe(true);
    expect(rotBody.auth_version).toBe(2);

    // Login with new rotated verifier succeeds
    const loginRes = await request.post(apiUrl(API_PATHS.authLogin), {
      data: {
        username: user.username,
        password: '',
        auth_verifier_b64: split2.verifierB64,
      },
    });
    expect(loginRes.status()).toBe(200);
  });

  test('A08-T1-03: E2EE User Vault key envelope upsert & fetch (PUT/GET /api/v1/user-vault/envelope with split_key_v2 & recovery wrap)', async ({
    request,
  }) => {
    const user = await registerUserViaApi(request);
    const headers = authHeaders(user.token);

    const initialGet = await request.get(apiUrl(API_PATHS.vaultEnvelope), { headers });
    expect(initialGet.status()).toBe(200);
    const initialBody = (await initialGet.json()) as { envelope: unknown };
    expect(initialBody.envelope).toBeNull();

    const envelopePayload = {
      key_version: 1,
      kdf_alg: 'split_key_v2',
      kdf_salt_b64: generateRandomB64(16),
      kdf_m_cost_kib: 65536,
      kdf_t_cost: 3,
      kdf_p_cost: 1,
      wrapped_root_key_b64: generateWrappedRootKeyB64(),
      recovery_wrapped_root_key_b64: generateWrappedRootKeyB64(),
    };

    const putRes = await request.put(apiUrl(API_PATHS.vaultEnvelope), {
      headers,
      data: envelopePayload,
    });
    expect(putRes.status()).toBe(200);

    const fetchedRes = await request.get(apiUrl(API_PATHS.vaultEnvelope), { headers });
    expect(fetchedRes.status()).toBe(200);
    const fetchedBody = (await fetchedRes.json()) as {
      envelope: Record<string, unknown> | null;
    };
    expect(fetchedBody.envelope).not.toBeNull();
    expect(fetchedBody.envelope?.kdf_alg).toBe('split_key_v2');
    expect(fetchedBody.envelope?.wrapped_root_key_b64).toBe(
      envelopePayload.wrapped_root_key_b64,
    );
  });

  test('A08-T1-04: Incremental E2EE Vault items CRUD (PUT/GET/DELETE /api/v1/user-vault/items/:category/:itemKey) across password, browser_cookie, ai_oauth with since_revision', async ({
    request,
  }) => {
    const user = await registerUserViaApi(request);
    const headers = authHeaders(user.token);

    const categories = ['password', 'browser_cookie', 'ai_oauth'] as const;
    let lastRev = 0;

    for (const category of categories) {
      const putRes = await request.put(
        apiUrl(`${API_PATHS.vaultItems}/${category}/item_${category}`),
        {
          headers,
          data: {
            nonce_b64: generateRandomB64(12),
            ciphertext_b64: generateRandomB64(64),
          },
        },
      );
      expect(putRes.status()).toBe(200);
      const putBody = (await putRes.json()) as { ok?: boolean; revision: number };
      expect(putBody.ok).toBe(true);
      expect(putBody.revision).toBeGreaterThan(lastRev);
      lastRev = putBody.revision;
    }

    const listAllRes = await request.get(
      `${apiUrl(API_PATHS.vaultItems)}?since_revision=0`,
      { headers },
    );
    expect(listAllRes.status()).toBe(200);
    const listAll = (await listAllRes.json()) as {
      latest_revision: number;
      items: Array<{ category: string; item_key: string; revision: number }>;
    };
    expect(listAll.latest_revision).toBe(lastRev);
    expect(listAll.items).toHaveLength(3);

    // Tombstone delete with optimistic revision check
    const delRes = await request.delete(
      `${apiUrl(`${API_PATHS.vaultItems}/password/item_password`)}?expected_revision=${listAll.items.find((i) => i.category === 'password')!.revision}`,
      { headers },
    );
    expect(delRes.status()).toBe(200);
    const delBody = (await delRes.json()) as { ok?: boolean; revision: number };
    expect(delBody.ok).toBe(true);
    expect(delBody.revision).toBeGreaterThan(lastRev);

    // Incremental fetch since previous revision returns only the deleted tombstone
    const incRes = await request.get(
      `${apiUrl(API_PATHS.vaultItems)}?since_revision=${lastRev}`,
      { headers },
    );
    expect(incRes.status()).toBe(200);
    const incBody = (await incRes.json()) as {
      items: Array<{ category: string; deleted?: boolean }>;
    };
    expect(incBody.items).toHaveLength(1);
    expect(incBody.items[0].deleted).toBe(true);
  });

  test('A08-T1-05: X25519 Device Trust Ring full handshake (device-sync/request -> NNN-NNN code -> pending -> approve -> 1st status poll retrieves ciphertext)', async ({
    request,
  }) => {
    const user = await registerUserViaApi(request);
    const headers = authHeaders(user.token);

    const deviceBKeys = generateX25519KeyMaterial();
    const reqRes = await request.post(apiUrl(API_PATHS.vaultDeviceSyncRequest), {
      headers,
      data: {
        device_name: 'MacBook Pro Device B',
        device_public_key_b64: deviceBKeys.publicKeyB64,
      },
    });
    expect(reqRes.status()).toBe(200);
    const reqBody = (await reqRes.json()) as {
      request_id: string;
      verification_code: string;
      expires_at: number;
    };
    expect(reqBody.request_id).toMatch(/^dsr_/);
    expect(reqBody.verification_code).toMatch(/^\d{3}-\d{3}$/);

    // Approving device sees pending request with matching verification_code
    const pendingRes = await request.get(apiUrl(API_PATHS.vaultDeviceSyncPending), {
      headers,
    });
    expect(pendingRes.status()).toBe(200);
    const pendingBody = (await pendingRes.json()) as {
      items: Array<{ request_id: string; verification_code: string; status: string }>;
    };
    expect(
      pendingBody.items.some(
        (i) =>
          i.request_id === reqBody.request_id &&
          i.verification_code === reqBody.verification_code,
      ),
    ).toBe(true);

    // Device A approves with ephemeral X25519 pubkey + sealed root key
    const approverEphemeral = generateX25519KeyMaterial();
    const encryptedRootKey = generateX25519SealedRootKeyB64();
    const nonce = generateRandomB64(12);

    const approveRes = await request.post(
      apiUrl(`${API_PATHS.vaultDeviceSync}/${reqBody.request_id}/approve`),
      {
        headers,
        data: {
          approver_ephemeral_pub_b64: approverEphemeral.publicKeyB64,
          encrypted_root_key_b64: encryptedRootKey,
          nonce_b64: nonce,
        },
      },
    );
    expect(approveRes.status()).toBe(200);

    // First status poll returns sealed key material
    const statusRes = await request.get(
      apiUrl(`${API_PATHS.vaultDeviceSync}/${reqBody.request_id}/status`),
      { headers },
    );
    expect(statusRes.status()).toBe(200);
    const statusBody = (await statusRes.json()) as {
      status: string;
      approver_ephemeral_pub_b64?: string;
      encrypted_root_key_b64?: string;
      nonce_b64?: string;
    };
    expect(statusBody.status).toBe('approved');
    expect(statusBody.approver_ephemeral_pub_b64).toBe(approverEphemeral.publicKeyB64);
    expect(statusBody.encrypted_root_key_b64).toBe(encryptedRootKey);
    expect(statusBody.nonce_b64).toBe(nonce);
  });

  test('A08-T1-06: Vault & Device Trust Ring Settings UI (#vault-settings-panel) displaying real envelope & device-sync state', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const envPutRes = await request.put(apiUrl(API_PATHS.vaultEnvelope), {
      headers: authHeaders(user.token),
      data: {
        key_version: 1,
        kdf_alg: 'split_key_v2',
        kdf_salt_b64: generateRandomB64(16),
        kdf_m_cost_kib: 65536,
        kdf_t_cost: 3,
        kdf_p_cost: 1,
        wrapped_root_key_b64: generateWrappedRootKeyB64(),
      },
    });
    expect(envPutRes.status()).toBe(200);

    const settings = await openSettings(page);
    const vaultTrigger = settings
      .locator('[data-settings-section*="vault" i], [data-testid*="vault" i]')
      .or(scopedButton(settings, bilingualRegex('vault|encryption|device\\s*sync', '保险库|密钥库|设备同步')))
      .first();
    await expect(vaultTrigger).toBeVisible();
    await vaultTrigger.click();

    const vaultPanel = page.locator(VAULT_SETTINGS_PANEL);
    await expect(vaultPanel).toBeVisible();
    await expect(vaultPanel).toContainText(/split_key_v2|vault|device|同步|密钥/i);
  });
});
