import { test, expect } from '../helpers/fixtures';
import { API_PATHS } from '../helpers/selectors';
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

test.describe('Tier 2 — A08: Split-Key V2 Anti-Enumeration, Vault Concurrency 409 & X25519 One-Time Read Security', () => {
  test('A08-T2-01: GET /api/v1/auth/kdf-params?username=unknown returns deterministic auth_version: 2 HMAC fake salt (anti-enumeration); empty username returns 400', async ({
    request,
  }) => {
    const emptyRes = await request.get(`${apiUrl(API_PATHS.authKdfParams)}?username=`, {
      failOnStatusCode: false,
    });
    expect(emptyRes.status()).toBe(400);

    const ghostUsername = `nonexistent_ghost_${Date.now()}`;
    const first = await request.get(
      `${apiUrl(API_PATHS.authKdfParams)}?username=${encodeURIComponent(ghostUsername)}`,
    );
    const second = await request.get(
      `${apiUrl(API_PATHS.authKdfParams)}?username=${encodeURIComponent(ghostUsername)}`,
    );
    expect(first.status()).toBe(200);
    expect(second.status()).toBe(200);

    const body1 = (await first.json()) as {
      auth_version: number;
      auth_salt_b64: string;
    };
    const body2 = (await second.json()) as {
      auth_version: number;
      auth_salt_b64: string;
    };
    expect(body1.auth_version).toBe(2);
    expect(body1.auth_salt_b64).toBe(body2.auth_salt_b64);
    expect(Buffer.from(body1.auth_salt_b64, 'base64').length).toBe(16);
  });

  test('A08-T2-02: Split-Key V2 account attempting raw password login returns 401 invalid_credentials; second upgrade-split-key returns 409 already_upgraded', async ({
    request,
  }) => {
    const user = await registerUserViaApi(request, {
      username: generateUniqueUsername('v2strict'),
      password: 'RawLegacyPass!2026',
    });
    const split = generateSplitKeyMaterial('strict-v2');

    const up1 = await request.post(apiUrl(API_PATHS.authUpgradeSplitKey), {
      headers: authHeaders(user.token),
      data: {
        old_password: user.password,
        auth_salt_b64: split.saltB64,
        auth_verifier_b64: split.verifierB64,
        kdf_params: split.kdfParams,
      },
    });
    expect(up1.status()).toBe(200);

    // Raw password login WITHOUT auth_verifier_b64 MUST fail 401 invalid_credentials
    const rawLogin = await request.post(apiUrl(API_PATHS.authLogin), {
      data: { username: user.username, password: user.password },
      failOnStatusCode: false,
    });
    expect(rawLogin.status()).toBe(401);
    const rawLoginBody = (await rawLogin.json()) as { error?: unknown };
    expect(typeof rawLoginBody.error).toBe('string');
    expect(rawLoginBody.error as string).toMatch(/invalid_credentials/i);

    // Second upgrade attempt MUST return 409 already_upgraded
    const up2 = await request.post(apiUrl(API_PATHS.authUpgradeSplitKey), {
      headers: authHeaders(user.token),
      data: {
        old_password: user.password,
        auth_salt_b64: split.saltB64,
        auth_verifier_b64: split.verifierB64,
        kdf_params: split.kdfParams,
      },
      failOnStatusCode: false,
    });
    expect(up2.status()).toBe(409);
    const up2Body = (await up2.json()) as { error?: unknown };
    expect(typeof up2Body.error).toBe('string');
    expect(up2Body.error as string).toMatch(/already_upgraded/i);
  });

  test('A08-T2-03: PUT and DELETE /api/v1/user-vault/items/:cat/:key with stale expected_revision return 409 revision_conflict', async ({
    request,
  }) => {
    const user = await registerUserViaApi(request);
    const headers = authHeaders(user.token);
    const itemUrl = apiUrl(`${API_PATHS.vaultItems}/password/bank_login`);

    const put1 = await request.put(itemUrl, {
      headers,
      data: { nonce_b64: generateRandomB64(12), ciphertext_b64: generateRandomB64(48) },
    });
    expect(put1.status()).toBe(200);
    const rev1 = ((await put1.json()) as { revision: number }).revision;
    expect(rev1).toBeGreaterThanOrEqual(1);

    const put2 = await request.put(itemUrl, {
      headers,
      data: {
        expected_revision: rev1,
        nonce_b64: generateRandomB64(12),
        ciphertext_b64: generateRandomB64(48),
      },
    });
    expect(put2.status()).toBe(200);

    // Stale expected_revision=rev1 MUST return 409 revision_conflict
    const stalePut = await request.put(itemUrl, {
      headers,
      data: {
        expected_revision: rev1,
        nonce_b64: generateRandomB64(12),
        ciphertext_b64: generateRandomB64(48),
      },
      failOnStatusCode: false,
    });
    expect(stalePut.status()).toBe(409);
    expect(((await stalePut.json()) as { error?: string }).error).toBe('revision_conflict');

    const staleDelete = await request.delete(`${itemUrl}?expected_revision=${rev1}`, {
      headers,
      failOnStatusCode: false,
    });
    expect(staleDelete.status()).toBe(409);
    expect(((await staleDelete.json()) as { error?: string }).error).toBe('revision_conflict');
  });

  test('A08-T2-04: Vault item path traversal (..), invalid category, out-of-range Argon2id m_cost_kib, and device_keychain_v2 without recovery wrap all return 400', async ({
    request,
  }) => {
    const user = await registerUserViaApi(request);
    const headers = authHeaders(user.token);

    // Segment containing '..' MUST hit item handler and return strictly 400 (ZERO 404 masking!)
    const badDotDot = await request.put(
      apiUrl(`${API_PATHS.vaultItems}/password/bad..key`),
      {
        headers,
        data: { nonce_b64: generateRandomB64(12), ciphertext_b64: generateRandomB64(32) },
        failOnStatusCode: false,
      },
    );
    expect(badDotDot.status()).toBe(400);

    const badCategory = await request.put(
      apiUrl(`${API_PATHS.vaultItems}/invalid_cat/key1`),
      {
        headers,
        data: { nonce_b64: generateRandomB64(12), ciphertext_b64: generateRandomB64(32) },
        failOnStatusCode: false,
      },
    );
    expect(badCategory.status()).toBe(400);

    const badKdf = await request.put(apiUrl(API_PATHS.vaultEnvelope), {
      headers,
      data: {
        key_version: 1,
        kdf_alg: 'split_key_v2',
        kdf_salt_b64: generateRandomB64(16),
        kdf_m_cost_kib: 64, // below minimum 1024
        kdf_t_cost: 3,
        kdf_p_cost: 1,
        wrapped_root_key_b64: generateWrappedRootKeyB64(),
      },
      failOnStatusCode: false,
    });
    expect(badKdf.status()).toBe(400);

    const missingRecovery = await request.put(apiUrl(API_PATHS.vaultEnvelope), {
      headers,
      data: {
        key_version: 1,
        kdf_alg: 'device_keychain_v2',
        kdf_salt_b64: generateRandomB64(16),
        kdf_m_cost_kib: 65536,
        kdf_t_cost: 3,
        kdf_p_cost: 1,
        wrapped_root_key_b64: generateWrappedRootKeyB64(),
      },
      failOnStatusCode: false,
    });
    expect(missingRecovery.status()).toBe(400);
  });

  test('A08-T2-05: X25519 Device Sync 2nd status poll returns status: "consumed" with ciphertext atomically wiped; all-zero pubkey rejected 400', async ({
    request,
  }) => {
    const user = await registerUserViaApi(request);
    const headers = authHeaders(user.token);

    // All-zero 32-byte X25519 pubkey rejected with 400
    const allZeroRes = await request.post(apiUrl(API_PATHS.vaultDeviceSyncRequest), {
      headers,
      data: {
        device_name: 'Malicious Zero Key Device',
        device_public_key_b64: Buffer.alloc(32, 0).toString('base64'),
      },
      failOnStatusCode: false,
    });
    expect(allZeroRes.status()).toBe(400);

    // Real request -> approve -> 1st poll succeeds -> 2nd poll returns atomic "consumed" with wiped ciphertext
    const keys = generateX25519KeyMaterial();
    const reqRes = await request.post(apiUrl(API_PATHS.vaultDeviceSyncRequest), {
      headers,
      data: { device_name: 'One-Time Poll Laptop', device_public_key_b64: keys.publicKeyB64 },
    });
    expect(reqRes.status()).toBe(200);
    const reqBody = (await reqRes.json()) as { request_id: string };
    expect(reqBody.request_id).toMatch(/^dsr_/);

    const ephem = generateX25519KeyMaterial();
    const approveRes = await request.post(
      apiUrl(`${API_PATHS.vaultDeviceSync}/${reqBody.request_id}/approve`),
      {
        headers,
        data: {
          approver_ephemeral_pub_b64: ephem.publicKeyB64,
          encrypted_root_key_b64: generateX25519SealedRootKeyB64(),
          nonce_b64: generateRandomB64(12),
        },
      },
    );
    expect(approveRes.status()).toBe(200);

    const statusUrl = apiUrl(`${API_PATHS.vaultDeviceSync}/${reqBody.request_id}/status`);
    const poll1Res = await request.get(statusUrl, { headers });
    expect(poll1Res.status()).toBe(200);
    const poll1 = (await poll1Res.json()) as {
      status: string;
      encrypted_root_key_b64?: string;
    };
    expect(poll1.status).toBe('approved');
    expect(poll1.encrypted_root_key_b64).toBeTruthy();

    const poll2Res = await request.get(statusUrl, { headers });
    expect(poll2Res.status()).toBe(200);
    const poll2 = (await poll2Res.json()) as {
      status: string;
      encrypted_root_key_b64?: string | null;
      nonce_b64?: string | null;
    };
    expect(poll2.status).toBe('consumed');
    expect(poll2.encrypted_root_key_b64 == null).toBe(true);
    expect(poll2.nonce_b64 == null).toBe(true);
  });

  test('A08-T2-06: Cross-user Device Sync approve/deny/status returns 403 forbidden; approving already-denied request returns 409', async ({
    request,
  }) => {
    const userA = await registerUserViaApi(request);
    const userB = await registerUserViaApi(request);
    const keys = generateX25519KeyMaterial();

    const reqRes = await request.post(apiUrl(API_PATHS.vaultDeviceSyncRequest), {
      headers: authHeaders(userA.token),
      data: { device_name: 'User A Device', device_public_key_b64: keys.publicKeyB64 },
    });
    expect(reqRes.status()).toBe(200);
    const reqBody = (await reqRes.json()) as { request_id: string };
    expect(reqBody.request_id).toMatch(/^dsr_/);

    const crossStatus = await request.get(
      apiUrl(`${API_PATHS.vaultDeviceSync}/${reqBody.request_id}/status`),
      { headers: authHeaders(userB.token), failOnStatusCode: false },
    );
    expect(crossStatus.status()).toBe(403);

    const crossEphem = generateX25519KeyMaterial();
    const crossApprove = await request.post(
      apiUrl(`${API_PATHS.vaultDeviceSync}/${reqBody.request_id}/approve`),
      {
        headers: authHeaders(userB.token),
        data: {
          approver_ephemeral_pub_b64: crossEphem.publicKeyB64,
          encrypted_root_key_b64: generateX25519SealedRootKeyB64(),
          nonce_b64: generateRandomB64(12),
        },
        failOnStatusCode: false,
      },
    );
    expect(crossApprove.status()).toBe(403);

    const crossDeny = await request.post(
      apiUrl(`${API_PATHS.vaultDeviceSync}/${reqBody.request_id}/deny`),
      { headers: authHeaders(userB.token), failOnStatusCode: false },
    );
    expect(crossDeny.status()).toBe(403);

    // Owner denies, then attempts to approve -> 409 invalid_request_status
    const ownerDeny = await request.post(
      apiUrl(`${API_PATHS.vaultDeviceSync}/${reqBody.request_id}/deny`),
      { headers: authHeaders(userA.token) },
    );
    expect(ownerDeny.status()).toBe(200);

    const ephem = generateX25519KeyMaterial();
    const lateApprove = await request.post(
      apiUrl(`${API_PATHS.vaultDeviceSync}/${reqBody.request_id}/approve`),
      {
        headers: authHeaders(userA.token),
        data: {
          approver_ephemeral_pub_b64: ephem.publicKeyB64,
          encrypted_root_key_b64: generateX25519SealedRootKeyB64(),
          nonce_b64: generateRandomB64(12),
        },
        failOnStatusCode: false,
      },
    );
    expect(lateApprove.status()).toBe(409);
  });
});
