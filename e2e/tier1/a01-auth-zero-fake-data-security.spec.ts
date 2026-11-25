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
  assertEmptyTruthfulWorkspace,
  assertNoDemoAuthControls,
  bilingualRegex,
  BILINGUAL_PATTERNS,
  loginWithPassword,
  openBurgerMenu,
  openSettings,
  registerAndLoginUser,
  scopedButton,
  sendTextMessage,
} from '../helpers/ui';
import { OpaqueWsClient } from '../helpers/api';

test.describe('Tier 1 — A01: Real Auth, Zero Fake Data Invariants & Account Security', () => {
  test('A01-T1-01: Real username/password registration & login via #auth-screen with zero demo/QR-sim controls', async ({
    page,
  }) => {
    await clearClientState(page);
    await page.goto(`${getBaseUrl()}/`, { waitUntil: 'domcontentloaded' });

    await assertNoDemoAuthControls(page);
    const authText = await page.locator(DOM.authScreen).innerText();
    expect(authText.trim().length).toBeGreaterThan(0);
    expect(authText).not.toContain('34.46.77.133');

    const registered = await registerAndLoginUser(page, {
      username: generateUniqueUsername('realauth'),
      password: 'RealUserPass!2026',
      firstName: 'Verified Operator',
    });

    await assertEmptyTruthfulWorkspace(page);

    // Reload must preserve real authenticated session
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator(DOM.appShell)).toBeVisible();
    await expect(page.locator(DOM.authScreen)).toBeHidden();

    // Logout and sign back in with real credentials
    await openBurgerMenu(page);
    await page.locator(DOM.menuItemLogout).click();
    await expect(page.locator(DOM.authScreen)).toBeVisible();
    await assertNoDemoAuthControls(page);

    await loginWithPassword(page, registered.username, registered.password);
    await expect(page.locator(DOM.appShell)).toBeVisible();
  });

  test('A01-T1-02: Fresh authenticated account truthful empty initial state (chats: [], 0 contacts/stories/wallet/providers, is_premium: false)', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const headers = authHeaders(user.token);

    await assertEmptyTruthfulWorkspace(page);
    await expect(page.locator(DOM.rightColumn)).toBeHidden();

    const chatsRes = await request.get(apiUrl(API_PATHS.chats), { headers });
    expect(chatsRes.status()).toBe(200);
    const chatsBody = (await chatsRes.json()) as { chats?: unknown; total?: unknown };
    expect(Array.isArray(chatsBody.chats)).toBe(true);
    expect(chatsBody.chats as unknown[]).toHaveLength(0);
    expect(typeof chatsBody.total).toBe('number');
    expect(chatsBody.total).toBe(0);

    const contactsRes = await request.get(apiUrl(API_PATHS.contacts), { headers });
    expect(contactsRes.status()).toBe(200);
    const contactsBody = (await contactsRes.json()) as { contacts?: unknown } | unknown[];
    const contactsList = Array.isArray(contactsBody) ? contactsBody : contactsBody.contacts;
    expect(Array.isArray(contactsList)).toBe(true);
    expect(contactsList as unknown[]).toHaveLength(0);

    const storiesRes = await request.get(apiUrl(API_PATHS.stories), { headers });
    expect(storiesRes.status()).toBe(200);
    const storiesBody = (await storiesRes.json()) as { stories?: unknown } | unknown[];
    const storiesList = Array.isArray(storiesBody) ? storiesBody : storiesBody.stories;
    expect(Array.isArray(storiesList)).toBe(true);
    expect(storiesList as unknown[]).toHaveLength(0);

    const magpieRes = await request.get(apiUrl(API_PATHS.magpieState), { headers });
    expect(magpieRes.status()).toBe(200);
    const magpieBody = (await magpieRes.json()) as {
      has_configured_provider?: unknown;
      needs_provider_selection?: unknown;
      allow_local_fallback?: unknown;
      providers?: unknown;
    };
    expect(magpieBody.has_configured_provider).toBe(false);
    expect(magpieBody.needs_provider_selection).toBe(true);
    expect(magpieBody.allow_local_fallback).toBe(false);
    expect(Array.isArray(magpieBody.providers)).toBe(true);
    expect(magpieBody.providers as unknown[]).toHaveLength(0);

    const computersRes = await request.get(apiUrl(API_PATHS.computers), { headers });
    expect(computersRes.status()).toBe(200);
    const computersBody = (await computersRes.json()) as {
      computers?: unknown;
      nodes?: unknown;
    };
    const computersList = computersBody.computers ?? computersBody.nodes;
    expect(Array.isArray(computersList)).toBe(true);
    expect(computersList as unknown[]).toHaveLength(0);

    const mcpToolsRes = await request.get(apiUrl(API_PATHS.mcpTools), { headers });
    expect(mcpToolsRes.status()).toBe(200);
    const mcpToolsBody = (await mcpToolsRes.json()) as { tools?: unknown } | unknown[];
    const mcpToolsList = Array.isArray(mcpToolsBody) ? mcpToolsBody : mcpToolsBody.tools;
    expect(Array.isArray(mcpToolsList)).toBe(true);
    expect(mcpToolsList as unknown[]).toHaveLength(0);

    const walletRes = await request.get(apiUrl(API_PATHS.wallet), { headers });
    expect(walletRes.status()).toBe(200);
    const walletBody = (await walletRes.json()) as {
      stars?: unknown;
      stars_balance?: unknown;
      ton?: unknown;
      ton_balance?: unknown;
    };
    const starsBalance = walletBody.stars ?? walletBody.stars_balance;
    const tonBalance = walletBody.ton ?? walletBody.ton_balance;
    expect(typeof starsBalance).toBe('number');
    expect(starsBalance).toBe(0);
    expect(typeof tonBalance).toBe('number');
    expect(tonBalance).toBe(0);

    const meRes = await request.get(apiUrl(API_PATHS.accountMe), { headers });
    expect(meRes.status()).toBe(200);
    const meBody = (await meRes.json()) as {
      is_premium?: unknown;
      user?: { is_premium?: unknown };
    };
    const isPremium = meBody.is_premium ?? meBody.user?.is_premium;
    expect(typeof isPremium).toBe('boolean');
    expect(isPremium).toBe(false);
  });

  test('A01-T1-03: Cloud 2FA enablement and login challenge verification via #auth-2fa-input & #btn-auth-submit-2fa', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const cloudPass = 'CloudTwoFactor!889';

    // Enable Cloud 2FA via real server endpoint
    const setRes = await request.post(apiUrl(API_PATHS.auth2faSet), {
      headers: authHeaders(user.token),
      data: {
        new_password: cloudPass,
        hint: 'Release gate hint',
      },
    });
    expect(setRes.status()).toBe(200);

    const statusRes = await request.get(apiUrl(API_PATHS.auth2fa), {
      headers: authHeaders(user.token),
    });
    expect(statusRes.status()).toBe(200);
    const statusJson = (await statusRes.json()) as { has_password?: boolean };
    expect(statusJson.has_password).toBe(true);

    // Log out and sign in through UI to trigger real 2FA challenge
    await openBurgerMenu(page);
    await page.locator(DOM.menuItemLogout).click();
    await expect(page.locator(DOM.authScreen)).toBeVisible();

    await page.locator(DOM.tabAuthPassword).click();
    await page.locator(DOM.authUsernameInput).fill(user.username);
    await page.locator(DOM.authPasswordInput).fill(user.password);
    await page.locator(DOM.btnAuthPasswordSubmit).click();

    await expect(page.locator(DOM.auth2faInput)).toBeVisible();
    await page.locator(DOM.auth2faInput).fill(cloudPass);
    await page.locator(DOM.btnAuthSubmit2fa).click();

    await expect(page.locator(DOM.appShell)).toBeVisible();
    await expect(page.locator(DOM.authScreen)).toBeHidden();
  });

  test('A01-T1-04: Real two-device QR pairing flow (#qr-login-svg -> Device B POST /api/v1/auth/pair/accept -> Device A session)', async ({
    page,
    request,
  }) => {
    await clearClientState(page);
    const deviceB = await registerUserViaApi(request, {
      username: generateUniqueUsername('qrdeviceb'),
      firstName: 'Approving Device',
    });

    await page.goto(`${getBaseUrl()}/`, { waitUntil: 'domcontentloaded' });
    await assertNoDemoAuthControls(page);

    const [pairCreateRes] = await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes(API_PATHS.authPairCreate) &&
          res.request().method() === 'POST',
        { timeout: 8_000 },
      ),
      page.locator(DOM.btnQrLoginFallback).first().click(),
    ]);
    expect([200, 201]).toContain(pairCreateRes.status());
    const pairJson = (await pairCreateRes.json()) as { pair_token?: unknown };
    expect(typeof pairJson.pair_token).toBe('string');
    const capturedPairToken = pairJson.pair_token as string;
    expect(capturedPairToken.length).toBeGreaterThan(0);

    const qrSvg = page.locator(DOM.qrLoginSvg);
    await expect(qrSvg).toBeVisible();

    // Verify genuine ISO-18004 SVG matrix rendered with paths/rects
    const shapeCount = await qrSvg.locator('rect, path').count();
    expect(shapeCount).toBeGreaterThan(20);

    // Authenticated Device B authentically approves pairing token
    const acceptRes = await request.post(apiUrl(API_PATHS.authPairAccept), {
      headers: authHeaders(deviceB.token),
      data: { pair_token: capturedPairToken },
    });
    expect(acceptRes.status()).toBe(200);

    // Device A transitions cleanly into authenticated shell
    await expect(page.locator(DOM.appShell)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(DOM.authScreen)).toBeHidden();
  });

  test('A01-T1-05: Local Passcode Lock (#passcode-lock-screen, #passcode-unlock-input) and multi-account switching (#menu-account-switcher)', async ({
    authSession,
    request,
  }) => {
    const { page } = authSession;
    const secondUser = await registerUserViaApi(request, {
      username: generateUniqueUsername('accttwo'),
      firstName: 'Second Account',
    });

    // Save a unique marker in Account 1's Saved Messages
    const acct1Marker = 'Account1_Isolated_Marker_731';
    await openBurgerMenu(page);
    await page.locator(DOM.menuItemSavedMessages).click();
    await sendTextMessage(page, acct1Marker);
    await expect(
      page.locator(DOM.messageList).locator(DOM.messageBubble).filter({ hasText: acct1Marker }),
    ).toBeVisible();

    // Enable Local Passcode Lock in Settings -> Privacy & Security
    const settings = await openSettings(page);
    const privacyBtn = settings
      .locator('[data-settings-section*="privacy" i]')
      .or(scopedButton(settings, bilingualRegex('privacy', '隐私')))
      .first();
    await expect(privacyBtn).toBeVisible();
    await privacyBtn.click();

    const passcodeTrigger = settings
      .locator('[data-settings-section*="passcode" i], [data-testid*="passcode" i]')
      .or(scopedButton(settings, bilingualRegex('passcode\\s*lock|local\\s*passcode', '应用锁|本地密码')))
      .first();
    await expect(passcodeTrigger).toBeVisible();
    await passcodeTrigger.click();

    const passcodeInputs = page.locator(
      `${DOM.settingsPanel} input[type="password"], [role="dialog"] input[type="password"]`,
    );
    await expect(passcodeInputs.first()).toBeVisible();
    const inputCount = await passcodeInputs.count();
    for (let i = 0; i < Math.min(2, inputCount); i++) {
      await passcodeInputs.nth(i).fill('2468');
    }
    const savePasscodeBtn = scopedButton(
      page.locator(`${DOM.settingsPanel}, [role="dialog"]`).first(),
      BILINGUAL_PATTERNS.confirm,
    ).first();
    await expect(savePasscodeBtn).toBeVisible();
    await savePasscodeBtn.click();

    // Lock with Ctrl+Shift+L and verify #passcode-lock-screen protects the shell
    await page.keyboard.press('Control+Shift+L');
    await expect(page.locator(DOM.passcodeLockScreen)).toBeVisible();
    await page.locator(DOM.passcodeUnlockInput).fill('2468');
    await page.locator(DOM.passcodeUnlockInput).press('Enter');
    await expect(page.locator(DOM.passcodeLockScreen)).toBeHidden();
    await expect(page.locator(DOM.appShell)).toBeVisible();

    // Verify account switcher opens and can switch to Account 2 cleanly
    await openBurgerMenu(page);
    const switcher = page.locator(DOM.menuAccountSwitcher);
    await expect(switcher).toBeVisible();
    await switcher.click();

    const addAcctBtn = scopedButton(
      page.locator(`${DOM.mainMenuDrawer}, [role="dialog"]`).first(),
      bilingualRegex('add\\s*account', '添加账号'),
    ).first();
    await expect(addAcctBtn).toBeVisible();
    await addAcctBtn.click();

    await loginWithPassword(page, secondUser.username, secondUser.password);
    await assertEmptyTruthfulWorkspace(page);
    await expect(page.locator(DOM.messageList)).not.toContainText(acct1Marker);
  });

  test('A01-T1-06: Account logout (#menu-item-logout) and real DELETE /api/v1/account revoking Bearer token & disconnecting WS', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;

    // 1. Exercise UI #menu-item-logout first and confirm return to #auth-screen, then sign back in
    await openBurgerMenu(page);
    await page.locator(DOM.menuItemLogout).click();
    await expect(page.locator(DOM.authScreen)).toBeVisible();
    await loginWithPassword(page, user.username, user.password);
    await expect(page.locator(DOM.appShell)).toBeVisible();

    // 2. Verify API logout revokes Bearer token immediately on a second account
    const logoutUser = await registerUserViaApi(request, {
      username: generateUniqueUsername('logoutusr'),
    });
    const logoutRes = await request.post(apiUrl(API_PATHS.authLogout), {
      headers: authHeaders(logoutUser.token),
    });
    expect(logoutRes.status()).toBe(200);
    const afterLogoutRes = await request.get(apiUrl(API_PATHS.chats), {
      headers: authHeaders(logoutUser.token),
      failOnStatusCode: false,
    });
    expect(afterLogoutRes.status()).toBe(401);

    // 3. Open active WebSocket for primary user and delete account via DELETE /api/v1/account
    const ws = await OpaqueWsClient.connect(user.token);
    let wsClosed = false;
    try {
      const delRes = await request.delete(apiUrl(API_PATHS.account), {
        headers: authHeaders(user.token),
        failOnStatusCode: false,
      });
      expect([200, 204]).toContain(delRes.status());

      // Verify Bearer token is immediately revoked
      const postDeleteRes = await request.get(apiUrl(API_PATHS.chats), {
        headers: authHeaders(user.token),
        failOnStatusCode: false,
      });
      expect(postDeleteRes.status()).toBe(401);

      // Verify active WS disconnects cleanly after account deletion
      await expect
        .poll(
          async () => {
            try {
              ws.send({ type: 'Ping' });
              return false;
            } catch {
              wsClosed = true;
              return true;
            }
          },
          { timeout: 6_000, message: 'Expected WS connection to close after DELETE /api/v1/account' },
        )
        .toBe(true);
      expect(wsClosed).toBe(true);

      // UI logout returns to clean #auth-screen
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator(DOM.authScreen)).toBeVisible();
    } finally {
      ws.close();
    }
  });
});
