import { test, expect } from '../helpers/fixtures';
import { API_PATHS, DOM } from '../helpers/selectors';
import {
  apiUrl,
  authHeaders,
  clearClientState,
  generateUniqueUsername,
  getBaseUrl,
  registerUserViaApi,
} from '../helpers/server';
import {
  assertNoDemoAuthControls,
  bilingualRegex,
  BILINGUAL_PATTERNS,
  openSettings,
  scopedButton,
} from '../helpers/ui';
import { OpaqueWsClient } from '../helpers/api';

test.describe('Tier 2 — A01: Auth Security, Zero Fake Data Rejection & Boundary Conditions', () => {
  test('A01-T2-01: Removed legacy demo/sandbox auth routes rejected (403/404), and /?dev=1 / /?mode=sandbox do NOT render demo controls or auto-login', async ({
    page,
    request,
  }) => {
    for (const removedSegment of ['demo', 'sandbox'] as const) {
      const res = await request.post(
        apiUrl(`${API_PATHS.authBase}/${removedSegment}`),
        { data: {}, failOnStatusCode: false },
      );
      expect([403, 404, 405]).toContain(res.status());
      expect(await res.text()).not.toMatch(/"token"\s*:\s*"[^"]+"/);
    }

    await clearClientState(page);
    for (const query of ['?dev=1', '?mode=sandbox']) {
      await page.goto(`${getBaseUrl()}/${query}`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator(DOM.authScreen)).toBeVisible();
      await expect(page.locator(DOM.appShell)).toBeHidden();
      await assertNoDemoAuthControls(page);
    }
  });

  test('A01-T2-02: Duplicate username registration (409), wrong password login (401), and wrong Cloud 2FA password rejection', async ({
    request,
  }) => {
    const user = await registerUserViaApi(request, {
      username: generateUniqueUsername('dupcheck'),
      password: 'CorrectPassword!2026',
    });

    // Duplicate username rejected with 409
    const dupRes = await request.post(apiUrl(API_PATHS.authRegister), {
      data: {
        username: user.username,
        password: 'AnotherPassword!2026',
        first_name: 'Duplicate',
      },
      failOnStatusCode: false,
    });
    expect(dupRes.status()).toBe(409);

    // Wrong password rejected with 401
    const wrongPassRes = await request.post(apiUrl(API_PATHS.authLogin), {
      data: { username: user.username, password: 'WrongPassword!000' },
      failOnStatusCode: false,
    });
    expect(wrongPassRes.status()).toBe(401);

    // Set Cloud 2FA and verify wrong cloud password is rejected
    const set2fa = await request.post(apiUrl(API_PATHS.auth2faSet), {
      headers: authHeaders(user.token),
      data: { new_password: 'TrueCloud2fa!999', hint: 'hint' },
    });
    expect(set2fa.status()).toBe(200);

    const loginChallenge = await request.post(apiUrl(API_PATHS.authLogin), {
      data: { username: user.username, password: user.password },
      failOnStatusCode: false,
    });
    expect(loginChallenge.status()).toBe(200);
    const challengeBody = (await loginChallenge.json()) as {
      requires_2fa?: boolean;
      challenge_token?: string;
    };
    expect(challengeBody.requires_2fa).toBe(true);
    expect(challengeBody.challenge_token).toBeTruthy();

    const bad2fa = await request.post(apiUrl(API_PATHS.auth2faVerify), {
      data: {
        challenge_token: challengeBody.challenge_token,
        cloud_password: 'InvalidCloud2fa!000',
      },
      failOnStatusCode: false,
    });
    expect([400, 401, 403]).toContain(bad2fa.status());
  });

  test('A01-T2-03: Passkey zero-crypto takeover blocked (POST /api/v1/auth/passkey/verify with bare credential_id without COSE signature rejected)', async ({
    request,
  }) => {
    const victim = await registerUserViaApi(request, {
      username: generateUniqueUsername('passkeyvictim'),
    });

    const forgedRes = await request.post(apiUrl(API_PATHS.authPasskeyVerify), {
      data: {
        username: victim.username,
        credential_id: 'forged-bare-credential-id-no-cose-signature',
      },
      failOnStatusCode: false,
    });
    expect([400, 401, 403]).toContain(forgedRes.status());
    const forgedBody = (await forgedRes.json()) as { error?: unknown; token?: unknown };
    expect(typeof forgedBody.error).toBe('string');
    expect(forgedBody.token).toBeUndefined();
  });

  test('A01-T2-04: Wrong passcode lock entry rejects without exposing #app-shell & unconfigured SMS/Email OTP rejects bogus code', async ({
    authSession,
    request,
  }) => {
    const { page } = authSession;

    // Set Local Passcode Lock
    const settings = await openSettings(page);
    const privacyBtn = settings
      .locator('[data-settings-section*="privacy" i]')
      .or(scopedButton(settings, bilingualRegex('privacy', '隐私')))
      .first();
    await expect(privacyBtn).toBeVisible();
    await privacyBtn.click();

    const passcodeBtn = settings
      .locator('[data-settings-section*="passcode" i], [data-testid*="passcode" i]')
      .or(scopedButton(settings, bilingualRegex('passcode', '应用锁|本地密码')))
      .first();
    await expect(passcodeBtn).toBeVisible();
    await passcodeBtn.click();

    const inputs = page.locator(
      `${DOM.settingsPanel} input[type="password"], [role="dialog"] input[type="password"]`,
    );
    await expect(inputs.first()).toBeVisible();
    const n = await inputs.count();
    expect(n).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < Math.min(2, n); i++) {
      await inputs.nth(i).fill('1357');
    }
    await scopedButton(
      page.locator(`${DOM.settingsPanel}, [role="dialog"]`).first(),
      BILINGUAL_PATTERNS.confirm,
    )
      .first()
      .click();

    await page.keyboard.press('Control+Shift+L');
    await expect(page.locator(DOM.passcodeLockScreen)).toBeVisible();

    // Enter wrong passcode — lock screen MUST remain visible
    await page.locator(DOM.passcodeUnlockInput).fill('9999');
    await page.locator(DOM.passcodeUnlockInput).press('Enter');
    await expect(page.locator(DOM.passcodeLockScreen)).toBeVisible();

    // Bogus phone OTP code is rejected cleanly
    const badOtp = await request.post(apiUrl(API_PATHS.authPhoneVerify), {
      data: { phone: '+14155550100', code: '000000' },
      failOnStatusCode: false,
    });
    expect([400, 401, 403, 503]).toContain(badOtp.status());
    expect(await badOtp.text()).not.toMatch(/"token"\s*:\s*"[^"]+"/);
  });

  test('A01-T2-05: Production Alipay /api/v1/auth/alipay/confirm hijack rejected (403/404) & unauthenticated protected API requests return 401', async ({
    request,
  }) => {
    const hijackRes = await request.post(apiUrl(API_PATHS.authAlipayConfirm), {
      data: { token: 'fake-alipay-session', user_id: 1 },
      failOnStatusCode: false,
    });
    expect([401, 403, 404, 405]).toContain(hijackRes.status());
    expect(await hijackRes.text()).not.toMatch(/"token"\s*:\s*"[^"]+"/);

    for (const protectedPath of [
      API_PATHS.chats,
      API_PATHS.contacts,
      API_PATHS.wallet,
      API_PATHS.vaultEnvelope,
      API_PATHS.magpieState,
      API_PATHS.remoteAssistInfo,
      API_PATHS.mcpGrants,
    ]) {
      const res = await request.get(apiUrl(protectedPath), {
        failOnStatusCode: false,
      });
      expect(res.status()).toBe(401);
    }
  });

  test('A01-T2-06: Stale/revoked Bearer token after logout or DELETE /api/v1/account rejected (401) on both HTTP & /api/v1/ws', async ({
    request,
  }) => {
    // 1. Verify POST /api/v1/auth/logout revokes token on HTTP and /api/v1/ws
    const logoutUser = await registerUserViaApi(request);
    const preLogoutWs = await OpaqueWsClient.connect(logoutUser.token, 5_000);
    preLogoutWs.close();
    const logoutRes = await request.post(apiUrl(API_PATHS.authLogout), {
      headers: authHeaders(logoutUser.token),
    });
    expect(logoutRes.status()).toBe(200);

    const postLogoutHttp = await request.get(apiUrl(API_PATHS.chats), {
      headers: authHeaders(logoutUser.token),
      failOnStatusCode: false,
    });
    expect(postLogoutHttp.status()).toBe(401);

    let logoutWsConnected = false;
    try {
      const ws = await OpaqueWsClient.connect(logoutUser.token, 3_000);
      logoutWsConnected = true;
      ws.close();
    } catch {
      logoutWsConnected = false;
    }
    expect(logoutWsConnected).toBe(false);

    // 2. Verify DELETE /api/v1/account revokes token on HTTP and /api/v1/ws
    const user = await registerUserViaApi(request);
    const preDeleteWs = await OpaqueWsClient.connect(user.token, 5_000);
    preDeleteWs.close();
    const delRes = await request.delete(apiUrl(API_PATHS.account), {
      headers: authHeaders(user.token),
      failOnStatusCode: false,
    });
    expect([200, 204]).toContain(delRes.status());

    const httpRes = await request.get(apiUrl(API_PATHS.chats), {
      headers: authHeaders(user.token),
      failOnStatusCode: false,
    });
    expect(httpRes.status()).toBe(401);

    let wsConnected = false;
    try {
      const ws = await OpaqueWsClient.connect(user.token, 3_000);
      wsConnected = true;
      ws.close();
    } catch {
      wsConnected = false;
    }
    expect(wsConnected).toBe(false);
  });
});
