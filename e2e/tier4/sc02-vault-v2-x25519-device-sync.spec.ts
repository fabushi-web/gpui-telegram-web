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

test.describe('Tier 4 — SC-02: Split-Key V2 Auth, E2EE User Vault & X25519 Two-Device Trust Ring', () => {
  test('SC-02: V1 register -> silent upgrade to V2 -> raw-password 401 & anti-enumeration fake salt -> Vault envelope & revisioned items + 409 conflict -> X25519 two-device trust ring atomic one-time read -> #vault-settings-panel', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const headers = authHeaders(user.token);

    // 1. Silent upgrade V1 -> Split-Key V2
    const split = generateSplitKeyMaterial('sc02-v2-master');
    const upRes = await request.post(apiUrl(API_PATHS.authUpgradeSplitKey), {
      headers,
      data: {
        old_password: user.password,
        auth_salt_b64: split.saltB64,
        auth_verifier_b64: split.verifierB64,
        kdf_params: split.kdfParams,
      },
    });
    expect(upRes.status()).toBe(200);
    expect(((await upRes.json()) as { auth_version: number }).auth_version).toBe(2);

    // 2. Confirm raw-password login is now rejected 401 while V2 verifier succeeds
    const rawFail = await request.post(apiUrl(API_PATHS.authLogin), {
      data: { username: user.username, password: user.password },
      failOnStatusCode: false,
    });
    expect(rawFail.status()).toBe(401);

    const v2Ok = await request.post(apiUrl(API_PATHS.authLogin), {
      data: { username: user.username, password: '', auth_verifier_b64: split.verifierB64 },
    });
    expect(v2Ok.status()).toBe(200);

    // 3. Anti-enumeration fake salt consistency for unknown user
    const unknownUser = generateUniqueUsername('ghost');
    const kdfARes = await request.get(
      `${apiUrl(API_PATHS.authKdfParams)}?username=${encodeURIComponent(unknownUser)}`,
    );
    expect(kdfARes.status()).toBe(200);
    const kdfA = (await kdfARes.json()) as { auth_version: number; auth_salt_b64: string };

    const kdfBRes = await request.get(
      `${apiUrl(API_PATHS.authKdfParams)}?username=${encodeURIComponent(unknownUser)}`,
    );
    expect(kdfBRes.status()).toBe(200);
    const kdfB = (await kdfBRes.json()) as { auth_version: number; auth_salt_b64: string };
    expect(kdfA.auth_version).toBe(2);
    expect(kdfA.auth_salt_b64).toBe(kdfB.auth_salt_b64);

    // 4. Upload E2EE Vault key envelope (60B ChaCha20Poly1305 wrapped root keys) + revisioned items + 409 conflict
    const envRes = await request.put(apiUrl(API_PATHS.vaultEnvelope), {
      headers,
      data: {
        key_version: 1,
        kdf_alg: 'split_key_v2',
        kdf_salt_b64: generateRandomB64(16),
        kdf_m_cost_kib: 65536,
        kdf_t_cost: 3,
        kdf_p_cost: 1,
        wrapped_root_key_b64: generateWrappedRootKeyB64(),
        recovery_wrapped_root_key_b64: generateWrappedRootKeyB64(),
      },
    });
    expect(envRes.status()).toBe(200);

    const itemUrl = apiUrl(`${API_PATHS.vaultItems}/password/prod_portal`);
    const put1Res = await request.put(itemUrl, {
      headers,
      data: { nonce_b64: generateRandomB64(12), ciphertext_b64: generateRandomB64(64) },
    });
    expect(put1Res.status()).toBe(200);
    const rev1 = ((await put1Res.json()) as { revision: number }).revision;
    expect(rev1).toBeGreaterThanOrEqual(1);

    const put2Res = await request.put(itemUrl, {
      headers,
      data: {
        expected_revision: rev1,
        nonce_b64: generateRandomB64(12),
        ciphertext_b64: generateRandomB64(64),
      },
    });
    expect(put2Res.status()).toBe(200);

    const conflictRes = await request.put(itemUrl, {
      headers,
      data: {
        expected_revision: rev1,
        nonce_b64: generateRandomB64(12),
        ciphertext_b64: generateRandomB64(64),
      },
      failOnStatusCode: false,
    });
    expect(conflictRes.status()).toBe(409);
    expect(((await conflictRes.json()) as { error?: string }).error).toBe('revision_conflict');

    // 5. X25519 Device Trust Ring: Device B requests -> Device A sees NNN-NNN & approves -> 1st poll retrieves sealed root key -> 2nd poll atomic "consumed"
    const deviceBKeys = generateX25519KeyMaterial();
    const syncReqRes = await request.post(apiUrl(API_PATHS.vaultDeviceSyncRequest), {
      headers,
      data: { device_name: 'SC02 Secondary Desktop', device_public_key_b64: deviceBKeys.publicKeyB64 },
    });
    expect([200, 201]).toContain(syncReqRes.status());
    const syncReq = (await syncReqRes.json()) as { request_id: string; verification_code: string };
    expect(syncReq.verification_code).toMatch(/^\d{3}-\d{3}$/);

    const pendingRes = await request.get(apiUrl(API_PATHS.vaultDeviceSyncPending), { headers });
    expect(pendingRes.status()).toBe(200);
    const pending = (await pendingRes.json()) as {
      items: Array<{ request_id: string; verification_code: string }>;
    };
    expect(pending.items.some((i) => i.request_id === syncReq.request_id)).toBe(true);

    const approverEphem = generateX25519KeyMaterial();
    const sealedRoot = generateX25519SealedRootKeyB64();
    const sealedNonce = generateRandomB64(12);
    const approveRes = await request.post(
      apiUrl(`${API_PATHS.vaultDeviceSync}/${syncReq.request_id}/approve`),
      {
        headers,
        data: {
          approver_ephemeral_pub_b64: approverEphem.publicKeyB64,
          encrypted_root_key_b64: sealedRoot,
          nonce_b64: sealedNonce,
        },
      },
    );
    expect(approveRes.status()).toBe(200);

    const statusUrl = apiUrl(`${API_PATHS.vaultDeviceSync}/${syncReq.request_id}/status`);
    const firstPollRes = await request.get(statusUrl, { headers });
    expect(firstPollRes.status()).toBe(200);
    const firstPoll = (await firstPollRes.json()) as {
      status: string;
      encrypted_root_key_b64?: string;
    };
    expect(firstPoll.status).toBe('approved');
    expect(firstPoll.encrypted_root_key_b64).toBe(sealedRoot);

    const secondPollRes = await request.get(statusUrl, { headers });
    expect(secondPollRes.status()).toBe(200);
    const secondPoll = (await secondPollRes.json()) as {
      status: string;
      encrypted_root_key_b64?: string | null;
    };
    expect(secondPoll.status).toBe('consumed');
    expect(
      secondPoll.encrypted_root_key_b64 == null || secondPoll.encrypted_root_key_b64 === '',
    ).toBe(true);

    // 6. Verify #vault-settings-panel renders live vault status in Settings UI
    const settings = await openSettings(page);
    const vaultBtn = settings
      .locator('[data-settings-section*="vault" i], [data-testid*="vault" i]')
      .or(scopedButton(settings, bilingualRegex('vault|encryption|device\\s*sync', '保险库|密钥库|设备同步')))
      .first();
    await expect(vaultBtn).toBeVisible();
    await vaultBtn.click();
    await expect(page.locator(VAULT_SETTINGS_PANEL)).toBeVisible();

    // Confirm another user cannot inspect this user's vault
    const outsider = await registerUserViaApi(request);
    const outsiderEnvRes = await request.get(apiUrl(API_PATHS.vaultEnvelope), {
      headers: authHeaders(outsider.token),
    });
    expect(outsiderEnvRes.status()).toBe(200);
    const outsiderEnv = (await outsiderEnvRes.json()) as { envelope: unknown };
    expect(outsiderEnv.envelope).toBeNull();
  });
});
