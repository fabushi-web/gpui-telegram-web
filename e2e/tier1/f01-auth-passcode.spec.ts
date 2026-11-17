import type { Locator, Page } from '@playwright/test';
import {
  BILINGUAL_PATTERNS,
  clearClientState,
  DOM,
  expect,
  getBaseUrl,
  openBurgerMenu,
  openSettings,
  scopedButton,
  scopedMenuItem,
  scopedTextbox,
  sendTextMessage,
  test,
} from '../helpers';

const OTP_KEY_REGEX =
  /^(?:code|otp|devCode|debugCode|demoCode|verificationCode|testCode|loginCode|tokenCode|emailCode|smsCode)$/i;

function findOtpInPayload(payload: unknown, depth = 0): string | null {
  if (depth > 3 || payload === null || payload === undefined) {
    return null;
  }
  if (typeof payload !== 'object') {
    return null;
  }
  const record = payload as Record<string, unknown>;
  for (const [key, val] of Object.entries(record)) {
    if (OTP_KEY_REGEX.test(key)) {
      const str = String(val ?? '').trim();
      if (/^\d{4,8}$/.test(str)) {
        return str;
      }
    }
  }
  for (const val of Object.values(record)) {
    if (val !== null && typeof val === 'object') {
      const nested = findOtpInPayload(val, depth + 1);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

async function extractOtpCandidates(
  page: Page,
  codeInput: Locator,
  responsePayload: unknown,
): Promise<string[]> {
  const candidates: string[] = [];

  const fromJson = findOtpInPayload(responsePayload);
  if (fromJson) {
    candidates.push(fromJson);
  }

  const authText = await page.locator(DOM.authScreen).innerText();
  const uiHintMatch = authText.match(
    /(?:code|otp|验证码|测试码|校验码)[^0-9]{0,24}(\b\d{4,8}\b)/i,
  );
  if (uiHintMatch?.[1] && !candidates.includes(uiHintMatch[1])) {
    candidates.push(uiHintMatch[1]);
  }

  const maxLen = await codeInput.getAttribute('maxLength');
  if (maxLen === '6') {
    candidates.push('123456', '12345');
  } else if (maxLen === '4') {
    candidates.push('1234', '12345');
  } else {
    candidates.push('12345', '123456');
  }

  return Array.from(new Set(candidates));
}

async function submitOtpIntoShell(
  page: Page,
  codeInput: Locator,
  responsePayload: unknown,
): Promise<void> {
  const candidates = await extractOtpCandidates(page, codeInput, responsePayload);
  const authScreen = page.locator(DOM.authScreen);
  const appShell = page.locator(DOM.appShell);

  for (const otp of candidates) {
    if (await appShell.isVisible()) {
      break;
    }
    await codeInput.fill(otp);
    const verifyBtn = scopedButton(
      authScreen,
      /verify|confirm|next|sign\s*in|log\s*in|submit|验证|确认|下一步|登录|提交/i,
    ).first();

    await page.waitForTimeout(250);
    if (!(await appShell.isVisible())) {
      if ((await verifyBtn.count()) > 0 && (await verifyBtn.isVisible())) {
        await verifyBtn.click();
      } else {
        await codeInput.press('Enter');
      }
      await page.waitForTimeout(350);
    }
    if (await appShell.isVisible()) {
      break;
    }
  }

  await expect(appShell).toBeVisible();
  await expect(page.locator(DOM.chatList)).toBeVisible();
  await expect(authScreen).toBeHidden();
}

function standaloneDialog(page: Page): Locator {
  return page
    .locator(
      '[role="dialog"]:visible:not(#main-menu-drawer):not(#settings-panel), [role="alertdialog"]:visible:not(#main-menu-drawer):not(#settings-panel)',
    )
    .last();
}

async function closeSettingsPanel(page: Page): Promise<void> {
  const panel = page.locator(DOM.settingsPanel);
  for (let i = 0; i < 6 && (await panel.isVisible()); i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(80);
  }
  if (await panel.isVisible()) {
    const closeOrBackBtn = scopedButton(
      panel,
      /close|done|back|关闭|完成|返回/i,
    )
      .or(
        panel.locator(
          'button[aria-label*="close" i], button[aria-label*="back" i], button[aria-label*="关闭"], button[aria-label*="返回"]',
        ),
      )
      .first();
    for (
      let i = 0;
      i < 4 &&
      (await panel.isVisible()) &&
      (await closeOrBackBtn.count()) > 0 &&
      (await closeOrBackBtn.isVisible());
      i++
    ) {
      await closeOrBackBtn.click();
      await page.waitForTimeout(80);
    }
  }
  await expect(panel).toBeHidden();
}

async function logoutToAuthScreen(page: Page): Promise<void> {
  await openBurgerMenu(page);
  const logoutItem = page.locator(DOM.menuItemLogout);
  await expect(logoutItem).toBeVisible();
  await logoutItem.click();

  const confirmDialog = standaloneDialog(page);
  if ((await confirmDialog.count()) > 0 && (await confirmDialog.isVisible())) {
    const confirmBtn = scopedButton(confirmDialog, 'logout')
      .or(scopedButton(confirmDialog, 'confirm'))
      .first();
    await expect(confirmBtn).toBeVisible();
    await confirmBtn.click();
  }

  await expect(page.locator(DOM.authScreen)).toBeVisible();
  await expect(page.locator(DOM.appShell)).toBeHidden();
}

async function ensurePasswordMode(
  page: Page,
  targetMode: 'register' | 'login',
): Promise<void> {
  const submitBtn = page.locator(DOM.btnAuthPasswordSubmit);
  const toggleBtn = page.locator(DOM.authModeRegisterToggle);
  await expect(submitBtn).toBeVisible();
  await expect(toggleBtn).toBeVisible();

  const submitLabel = `${(await submitBtn.innerText()).trim()} ${(await submitBtn.getAttribute('aria-label')) ?? ''}`;
  const submitSaysRegister =
    /register|sign\s*up|create\s*account|注册|创建账号/i.test(submitLabel);
  const submitSaysLogin = /sign\s*in|log\s*in|登录/i.test(submitLabel);

  let isCurrentlyRegister = false;
  if (submitSaysRegister && !submitSaysLogin) {
    isCurrentlyRegister = true;
  } else if (submitSaysLogin && !submitSaysRegister) {
    isCurrentlyRegister = false;
  } else {
    const ariaChecked = await toggleBtn.getAttribute('aria-checked');
    const ariaPressed = await toggleBtn.getAttribute('aria-pressed');
    const dataMode = await toggleBtn.getAttribute('data-mode');
    const toggleLabel = `${(await toggleBtn.innerText()).trim()} ${(await toggleBtn.getAttribute('aria-label')) ?? ''}`;

    if (
      ariaChecked === 'true' ||
      ariaPressed === 'true' ||
      dataMode === 'register'
    ) {
      isCurrentlyRegister = true;
    } else if (
      ariaChecked === 'false' ||
      ariaPressed === 'false' ||
      dataMode === 'login'
    ) {
      isCurrentlyRegister = false;
    } else if (
      /already|back\s*to\s*login|sign\s*in|已有账号|返回登录|去登录/i.test(
        toggleLabel,
      )
    ) {
      isCurrentlyRegister = true;
    } else if (
      /register|create\s*account|sign\s*up|注册|创建账号/i.test(toggleLabel)
    ) {
      isCurrentlyRegister = false;
    }
  }

  if (targetMode === 'register' && !isCurrentlyRegister) {
    await toggleBtn.click();
  } else if (targetMode === 'login' && isCurrentlyRegister) {
    await toggleBtn.click();
  }
}

async function fillPasswordAuthForm(
  page: Page,
  username: string,
  password: string,
): Promise<void> {
  const usernameInput = page.locator(DOM.authUsernameInput);
  const passwordInput = page.locator(DOM.authPasswordInput);
  await expect(usernameInput).toBeVisible();
  await expect(passwordInput).toBeVisible();

  await usernameInput.fill(username);
  await passwordInput.fill(password);

  const allPwdInputs = page
    .locator(DOM.authScreen)
    .locator('input[type="password"]:visible');
  const pwdCount = await allPwdInputs.count();
  for (let i = 1; i < pwdCount; i++) {
    await allPwdInputs.nth(i).fill(password);
  }
}

async function navigateToPrivacySecuritySettings(page: Page): Promise<Locator> {
  const panel = await openSettings(page);
  const sectionTrigger = panel
    .locator(
      '[data-settings-section*="privacy" i], [data-settings-section*="security" i]',
    )
    .or(
      panel
        .locator('[data-settings-section]')
        .filter({ hasText: /privacy|security|2fa|passcode|隐私|安全|两步|密码锁/i }),
    )
    .or(scopedMenuItem(panel, /privacy|security|隐私|安全/i));

  if ((await sectionTrigger.count()) > 0 && (await sectionTrigger.first().isVisible())) {
    await sectionTrigger.first().click();
  }

  await expect(panel).toBeVisible();
  return panel;
}

test.describe('F1 — Multi-Flow Auth, Adapter Switcher, Multi-Account & Passcode Lock', () => {
  test('F1-01: 1-Click Demo login, session persistence across page.reload(), and logout', async ({
    page,
  }) => {
    await clearClientState(page);
    await page.goto(`${getBaseUrl()}/`, { waitUntil: 'domcontentloaded' });

    const authScreen = page.locator(DOM.authScreen);
    const demoBtn = page.locator(DOM.btnDemoLogin);
    const appShell = page.locator(DOM.appShell);
    const chatList = page.locator(DOM.chatList);

    await expect(authScreen).toBeVisible();
    await expect(demoBtn).toBeVisible();
    await expect(demoBtn).toBeEnabled();
    await expect(appShell).toBeHidden();

    await demoBtn.click();

    await expect(appShell).toBeVisible();
    await expect(authScreen).toBeHidden();
    await expect(chatList).toBeVisible();
    await expect(chatList.locator(DOM.chatRow).first()).toBeVisible();

    // Reload and verify authenticated session survives without re-clicking Demo Login
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(appShell).toBeVisible();
    await expect(chatList).toBeVisible();
    await expect(chatList.locator(DOM.chatRow).first()).toBeVisible();
    await expect(authScreen).toBeHidden();

    // Logout and verify logged-out state persists across reload
    await logoutToAuthScreen(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(authScreen).toBeVisible();
    await expect(appShell).toBeHidden();
  });

  test('F1-02: Phone + searchable Country Code selector + OTP verification into #app-shell', async ({
    page,
  }) => {
    await clearClientState(page);
    await page.goto(`${getBaseUrl()}/`, { waitUntil: 'domcontentloaded' });

    await expect(page.locator(DOM.authScreen)).toBeVisible();
    const phoneTab = page.locator(DOM.tabAuthPhone);
    if (await phoneTab.isVisible()) {
      await phoneTab.click();
    }

    const countrySelect = page.locator(DOM.authCountrySelect);
    const phoneInput = page.locator(DOM.authPhoneInput);
    const sendCodeBtn = page.locator(DOM.btnAuthSendCode);

    await expect(countrySelect).toBeVisible();
    await expect(phoneInput).toBeVisible();
    await expect(sendCodeBtn).toBeVisible();

    const tagName = await countrySelect.evaluate((el: Element) =>
      el.tagName.toUpperCase(),
    );
    if (tagName === 'SELECT') {
      const optionsCount = await countrySelect.locator('option').count();
      expect(optionsCount).toBeGreaterThanOrEqual(2);
      const cnValue = await countrySelect.evaluate((el: Element) => {
        const sel = el as HTMLSelectElement;
        const match = Array.from(sel.options).find((opt) =>
          /\+86|china|中国|\bcn\b/i.test(`${opt.value} ${opt.textContent ?? ''}`),
        );
        return match ? match.value : sel.options[1]?.value ?? sel.options[0]?.value ?? '';
      });
      expect(cnValue.length).toBeGreaterThan(0);
      await countrySelect.selectOption(cnValue);
    } else {
      await countrySelect.click();
      const countrySearch = page
        .getByPlaceholder(/search|country|code|搜索|国家|区号/i)
        .or(
          page.locator(
            '[role="listbox"] input, [role="dialog"] input[type="search"], [data-testid*="country" i] input',
          ),
        )
        .first();
      if ((await countrySearch.count()) > 0 && (await countrySearch.isVisible())) {
        await countrySearch.fill('86');
      }
      const cnOption = page
        .getByRole('option', { name: /\+86|china|中国/i })
        .or(
          page
            .locator('[role="menuitem"], [role="option"], li, button')
            .filter({ hasText: /\+86|china|中国/i }),
        )
        .first();
      await expect(cnOption).toBeVisible();
      await cnOption.click();
    }

    const existingPrefix = await phoneInput.inputValue();
    if (existingPrefix.trim().startsWith('+86')) {
      await phoneInput.fill('+8613800138000');
    } else {
      await phoneInput.fill('13800138000');
    }

    const sendCodeRespPromise = page
      .waitForResponse(
        (res) =>
          res.url().includes('/api/v1/auth') && res.request().method() === 'POST',
        { timeout: 6_000 },
      )
      .catch(() => null);

    await sendCodeBtn.click();
    const sendCodeResp = await sendCodeRespPromise;
    const payload: unknown = sendCodeResp
      ? await sendCodeResp.json().catch(() => null)
      : null;

    const codeInput = page.locator(DOM.authCodeInput);
    await expect(codeInput).toBeVisible();

    await submitOtpIntoShell(page, codeInput, payload);
  });

  test('F1-03: Cloud 2FA password lifecycle — enable in Settings, logout, challenge via #auth-2fa-input + #btn-auth-submit-2fa, and disable', async ({
    page,
  }) => {
    await clearClientState(page);
    await page.goto(`${getBaseUrl()}/`, { waitUntil: 'domcontentloaded' });

    await expect(page.locator(DOM.authScreen)).toBeVisible();
    await page.locator(DOM.tabAuthPassword).click();
    await ensurePasswordMode(page, 'register');
    await fillPasswordAuthForm(page, 'sec_2fa_user', 'PrimaryPass!2026');
    await page.locator(DOM.btnAuthPasswordSubmit).click();

    await expect(page.locator(DOM.appShell)).toBeVisible();
    await expect(page.locator(DOM.chatList)).toBeVisible();

    // Enable Cloud 2FA in Settings -> Privacy & Security
    const settingsPanel = await navigateToPrivacySecuritySettings(page);
    const twoFaSubTrigger = settingsPanel
      .locator(
        '[data-settings-section*="2fa" i], [data-settings-section*="two-step" i], [data-testid*="2fa" i]',
      )
      .or(
        scopedMenuItem(
          settingsPanel,
          /two-step|cloud password|2fa|两步验证|双重验证|云密码/i,
        ),
      );

    if (
      (await twoFaSubTrigger.count()) > 0 &&
      (await twoFaSubTrigger.first().isVisible())
    ) {
      await twoFaSubTrigger.first().click();
    }

    const activeDialog = standaloneDialog(page);
    const twoFaContainer =
      (await activeDialog.count()) > 0 ? activeDialog : settingsPanel;

    const twoFaInputs = twoFaContainer
      .locator('input[type="password"]:visible')
      .or(
        scopedTextbox(
          twoFaContainer,
          /two-step|cloud password|2fa|new password|两步|云密码|新密码/i,
        ),
      );
    await expect(twoFaInputs.first()).toBeVisible();

    const inputCount = await twoFaInputs.count();
    await twoFaInputs.first().fill('CloudSecret#77');
    for (let i = 1; i < inputCount; i++) {
      const nth = twoFaInputs.nth(i);
      const placeholder = `${(await nth.getAttribute('placeholder')) ?? ''} ${(await nth.getAttribute('aria-label')) ?? ''}`;
      if (/hint|提示/i.test(placeholder)) {
        await nth.fill('E2E Hint');
      } else {
        await nth.fill('CloudSecret#77');
      }
    }

    const enable2faBtn = scopedButton(
      twoFaContainer,
      /enable|save|set|confirm|turn\s*on|update|开启|启用|保存|设置|确认|更新/i,
    ).first();
    await expect(enable2faBtn).toBeVisible();
    await enable2faBtn.click();

    // Dismiss multi-layer settings panel completely and logout
    await closeSettingsPanel(page);
    await logoutToAuthScreen(page);

    // Log back in with primary credentials -> MUST hit Cloud 2FA challenge gate
    await page.locator(DOM.tabAuthPassword).click();
    await ensurePasswordMode(page, 'login');
    await fillPasswordAuthForm(page, 'sec_2fa_user', 'PrimaryPass!2026');
    await page.locator(DOM.btnAuthPasswordSubmit).click();

    const auth2faInput = page.locator(DOM.auth2faInput);
    const submit2faBtn = page.locator(DOM.btnAuthSubmit2fa);
    await expect(auth2faInput).toBeVisible();
    await expect(submit2faBtn).toBeVisible();
    await expect(page.locator(DOM.appShell)).toBeHidden();

    await auth2faInput.fill('CloudSecret#77');
    await submit2faBtn.click();

    await expect(page.locator(DOM.appShell)).toBeVisible();
    await expect(page.locator(DOM.chatList)).toBeVisible();
    await expect(page.locator(DOM.authScreen)).toBeHidden();

    // Disable Cloud 2FA and verify direct login without 2FA challenge
    const settingsAgain = await navigateToPrivacySecuritySettings(page);
    const twoFaTriggerAgain = settingsAgain
      .locator(
        '[data-settings-section*="2fa" i], [data-settings-section*="two-step" i], [data-testid*="2fa" i]',
      )
      .or(
        scopedMenuItem(
          settingsAgain,
          /two-step|cloud password|2fa|两步验证|双重验证|云密码/i,
        ),
      );
    if (
      (await twoFaTriggerAgain.count()) > 0 &&
      (await twoFaTriggerAgain.first().isVisible())
    ) {
      await twoFaTriggerAgain.first().click();
    }

    const activeDisableDialog = standaloneDialog(page);
    const disableScope =
      (await activeDisableDialog.count()) > 0
        ? activeDisableDialog
        : settingsAgain;

    const current2faPwd = disableScope.locator('input[type="password"]:visible');
    if ((await current2faPwd.count()) > 0) {
      await current2faPwd.first().fill('CloudSecret#77');
    }

    const disableBtn = scopedButton(
      disableScope,
      /disable|turn\s*off|remove|clear|关闭|停用|移除|取消两步/i,
    ).first();
    await expect(disableBtn).toBeVisible();
    await disableBtn.click();

    const confirmDisableDialog = standaloneDialog(page);
    if ((await confirmDisableDialog.count()) > 0) {
      const modalPwd = confirmDisableDialog.locator('input[type="password"]:visible');
      if ((await modalPwd.count()) > 0) {
        await modalPwd.first().fill('CloudSecret#77');
      }
      const confirmBtn = scopedButton(
        confirmDisableDialog,
        /disable|confirm|ok|remove|关闭|停用|确认|确定|移除/i,
      ).first();
      if ((await confirmBtn.count()) > 0 && (await confirmBtn.isVisible())) {
        await confirmBtn.click();
      }
    }

    await closeSettingsPanel(page);
    await logoutToAuthScreen(page);

    await page.locator(DOM.tabAuthPassword).click();
    await ensurePasswordMode(page, 'login');
    await fillPasswordAuthForm(page, 'sec_2fa_user', 'PrimaryPass!2026');
    await page.locator(DOM.btnAuthPasswordSubmit).click();

    await expect(page.locator(DOM.appShell)).toBeVisible();
    await expect(page.locator(DOM.chatList)).toBeVisible();
    await expect(auth2faInput).toBeHidden();
  });

  test('F1-04: Real SVG QR code pairing (#qr-login-svg) and #btn-simulate-qr-scan', async ({
    page,
  }) => {
    await clearClientState(page);
    await page.goto(`${getBaseUrl()}/`, { waitUntil: 'domcontentloaded' });

    const qrTrigger = page.locator(DOM.btnQrLoginFallback).first();
    await expect(qrTrigger).toBeVisible();
    await qrTrigger.click();

    const qrSvg = page.locator(DOM.qrLoginSvg);
    await expect(qrSvg).toBeVisible();

    const qrBox = await qrSvg.boundingBox();
    expect(qrBox).not.toBeNull();
    expect(qrBox!.width).toBeGreaterThanOrEqual(80);
    expect(qrBox!.height).toBeGreaterThanOrEqual(80);

    const svgStats = await qrSvg.evaluate((el: Element) => {
      const svg = el.tagName.toLowerCase() === 'svg' ? el : el.querySelector('svg');
      if (!svg) {
        return { hasSvg: false, vectorCount: 0 };
      }
      const vectorCount = svg.querySelectorAll(
        'path, rect, polygon, circle, use',
      ).length;
      return { hasSvg: true, vectorCount };
    });

    expect(svgStats.hasSvg).toBe(true);
    expect(svgStats.vectorCount).toBeGreaterThan(0);

    const simulateScanBtn = page.locator(DOM.btnSimulateQrScan);
    await expect(simulateScanBtn).toBeVisible();
    await expect(simulateScanBtn).toBeEnabled();
    await simulateScanBtn.click();

    await expect(page.locator(DOM.appShell)).toBeVisible();
    await expect(page.locator(DOM.chatList)).toBeVisible();
    await expect(page.locator(DOM.authScreen)).toBeHidden();
  });

  test('F1-05: Username/password registration, logout, and subsequent login', async ({
    page,
  }) => {
    await clearClientState(page);
    await page.goto(`${getBaseUrl()}/`, { waitUntil: 'domcontentloaded' });

    const pwdTab = page.locator(DOM.tabAuthPassword);
    await expect(pwdTab).toBeVisible();
    await pwdTab.click();

    await ensurePasswordMode(page, 'register');
    await fillPasswordAuthForm(page, 'e2e_new_member', 'StrongPass!42');
    await page.locator(DOM.btnAuthPasswordSubmit).click();

    await expect(page.locator(DOM.appShell)).toBeVisible();
    await expect(page.locator(DOM.chatList)).toBeVisible();

    await logoutToAuthScreen(page);

    await pwdTab.click();
    await ensurePasswordMode(page, 'login');
    await fillPasswordAuthForm(page, 'e2e_new_member', 'StrongPass!42');
    await page.locator(DOM.btnAuthPasswordSubmit).click();

    await expect(page.locator(DOM.appShell)).toBeVisible();
    await expect(page.locator(DOM.chatList)).toBeVisible();
    await expect(page.locator(DOM.authScreen)).toBeHidden();
  });

  test('F1-06: Email OTP, Alipay QR, WebAuthn Passkey, editable Server URL (#auth-server-url-input), and MTProto config (#btn-mtproto-config)', async ({
    page,
  }) => {
    await clearClientState(page);
    await page.goto(`${getBaseUrl()}/`, { waitUntil: 'domcontentloaded' });

    const authScreen = page.locator(DOM.authScreen);
    await expect(authScreen).toBeVisible();

    // 1. Editable Server URL (#auth-server-url-input)
    const serverUrlInput = page.locator(DOM.authServerUrlInput);
    if (!(await serverUrlInput.isVisible())) {
      const serverToggle = scopedButton(
        authScreen,
        /server|endpoint|adapter|connection|服务器|节点|连接/i,
      ).first();
      await expect(serverToggle).toBeVisible();
      await serverToggle.click();
    }
    await expect(serverUrlInput).toBeVisible();
    const baseUrl = getBaseUrl();
    await serverUrlInput.fill(baseUrl);
    await expect(serverUrlInput).toHaveValue(baseUrl);

    // 2. MTProto Config (#btn-mtproto-config)
    const mtprotoBtn = page.locator(DOM.btnMtprotoConfig);
    await expect(mtprotoBtn).toBeVisible();
    await mtprotoBtn.click();

    const mtprotoScope = standaloneDialog(page).or(authScreen).first();
    const apiIdInput = mtprotoScope
      .locator(
        'input[name*="api_id" i], input[name*="apiId" i], input[id*="api-id" i], input[placeholder*="api_id" i], input[placeholder*="API ID" i]',
      )
      .or(scopedTextbox(mtprotoScope, /api[_\s-]*id/i))
      .first();
    const apiHashInput = mtprotoScope
      .locator(
        'input[name*="api_hash" i], input[name*="apiHash" i], input[id*="api-hash" i], input[placeholder*="api_hash" i], input[placeholder*="API Hash" i]',
      )
      .or(scopedTextbox(mtprotoScope, /api[_\s-]*hash/i))
      .first();

    await expect(apiIdInput).toBeVisible();
    await expect(apiHashInput).toBeVisible();
    await apiIdInput.fill('12345');
    await apiHashInput.fill('0123456789abcdef0123456789abcdef');
    await expect(apiIdInput).toHaveValue('12345');
    await expect(apiHashInput).toHaveValue('0123456789abcdef0123456789abcdef');

    // Close MTProto modal or toggle back to server mode cleanly
    if ((await standaloneDialog(page).count()) > 0) {
      await page.keyboard.press('Escape');
    } else if (await apiIdInput.isVisible()) {
      const serverModeBtn = scopedButton(
        authScreen,
        /server|self-hosted|cancel|back|close|服务器|返回|取消|关闭/i,
      ).first();
      if ((await serverModeBtn.count()) > 0 && (await serverModeBtn.isVisible())) {
        await serverModeBtn.click();
      } else {
        await mtprotoBtn.click();
      }
    }

    // 3. Email OTP (#tab-auth-email)
    const emailTab = page.locator(DOM.tabAuthEmail);
    await expect(emailTab).toBeVisible();
    await emailTab.click();

    const emailInput = authScreen
      .locator('input[type="email"]:visible')
      .or(scopedTextbox(authScreen, /email|邮箱|邮件/i))
      .first();
    await expect(emailInput).toBeVisible();
    await emailInput.fill('operator@example.com');

    const emailRespPromise = page
      .waitForResponse(
        (res) =>
          res.url().includes('/api/v1/auth') && res.request().method() === 'POST',
        { timeout: 6_000 },
      )
      .catch(() => null);

    const sendEmailCodeBtn = page
      .locator(DOM.btnAuthSendCode)
      .or(scopedButton(authScreen, /send|code|发送|验证码/i))
      .first();
    await expect(sendEmailCodeBtn).toBeVisible();
    await sendEmailCodeBtn.click();

    const emailResp = await emailRespPromise;
    const emailPayload: unknown = emailResp
      ? await emailResp.json().catch(() => null)
      : null;

    const emailCodeInput = page
      .locator(DOM.authCodeInput)
      .or(scopedTextbox(authScreen, /code|otp|验证码/i))
      .first();
    await expect(emailCodeInput).toBeVisible();
    await submitOtpIntoShell(page, emailCodeInput, emailPayload);
    await logoutToAuthScreen(page);

    // 4. Alipay QR (#tab-auth-alipay)
    const alipayTab = page.locator(DOM.tabAuthAlipay);
    await expect(alipayTab).toBeVisible();
    await alipayTab.click();

    const alipayGraphic = authScreen.locator('svg:visible, canvas:visible, img:visible').first();
    await expect(alipayGraphic).toBeVisible();
    const alipayBox = await alipayGraphic.boundingBox();
    expect(alipayBox).not.toBeNull();
    expect(alipayBox!.width).toBeGreaterThanOrEqual(60);
    expect(alipayBox!.height).toBeGreaterThanOrEqual(60);

    const alipaySimBtn = page
      .locator(DOM.btnSimulateQrScan)
      .or(scopedButton(authScreen, /simulate|scan|alipay|confirm|模拟|扫码|支付宝|确认/i))
      .first();
    await expect(alipaySimBtn).toBeVisible();
    await alipaySimBtn.click();

    await expect(page.locator(DOM.appShell)).toBeVisible();
    await expect(page.locator(DOM.chatList)).toBeVisible();
    await logoutToAuthScreen(page);

    // 5. WebAuthn Passkey (#btn-auth-passkey) with CDP Virtual Authenticator
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send('WebAuthn.enable');
      const { authenticatorId } = await cdp.send(
        'WebAuthn.addVirtualAuthenticator',
        {
          options: {
            protocol: 'ctap2',
            transport: 'internal',
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
          },
        },
      );

      const passkeyBtn = page.locator(DOM.btnAuthPasskey);
      await expect(passkeyBtn).toBeVisible();
      await passkeyBtn.click();

      await page.waitForTimeout(600);
      if (!(await page.locator(DOM.appShell).isVisible())) {
        // Register a passkey in Privacy & Security first if fresh DB requires prior registration
        await page.locator(DOM.btnDemoLogin).click();
        await expect(page.locator(DOM.appShell)).toBeVisible();
        const privPanel = await navigateToPrivacySecuritySettings(page);
        const credsBefore = (
          await cdp.send('WebAuthn.getCredentials', { authenticatorId })
        ).credentials.length;

        const passkeyTrigger = privPanel
          .locator(
            '[data-settings-section*="passkey" i], [data-testid*="passkey" i]',
          )
          .or(scopedMenuItem(privPanel, /passkey|webauthn|通行密钥/i))
          .or(
            scopedButton(
              privPanel,
              /passkey|webauthn|biometric|通行密钥|添加密钥|生物识别/i,
            ),
          )
          .first();
        await expect(passkeyTrigger).toBeVisible();
        await passkeyTrigger.click();
        await page.waitForTimeout(350);

        const credsAfterFirstClick = (
          await cdp.send('WebAuthn.getCredentials', { authenticatorId })
        ).credentials.length;
        if (credsAfterFirstClick === credsBefore) {
          const passkeyDialog = standaloneDialog(page);
          const passkeyScope =
            (await passkeyDialog.count()) > 0 ? passkeyDialog : privPanel;
          const addPasskeyBtn = scopedButton(
            passkeyScope,
            /add.*passkey|create.*passkey|register.*passkey|new.*passkey|passkey|webauthn|添加.*密钥|创建.*密钥|注册.*密钥|通行密钥/i,
          ).first();
          if (
            (await addPasskeyBtn.count()) > 0 &&
            (await addPasskeyBtn.isVisible())
          ) {
            await addPasskeyBtn.click();
            await page.waitForTimeout(400);
          }
        }

        await closeSettingsPanel(page);
        await logoutToAuthScreen(page);
        await expect(passkeyBtn).toBeVisible();
        await passkeyBtn.click();
      }

      await expect(page.locator(DOM.appShell)).toBeVisible();
      await expect(page.locator(DOM.chatList)).toBeVisible();
      await expect(authScreen).toBeHidden();
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  });

  test('F1-07: Multi-account switcher (#menu-account-switcher) and Local Passcode Lock (Ctrl+Shift+L, #passcode-lock-screen, #passcode-unlock-input)', async ({
    authPage: page,
  }) => {
    // 1. Seed a private vault marker in Account 1's Saved Messages to prove per-account state & switching
    const account1Marker = 'Account1_Private_Vault_Marker_901';
    await openBurgerMenu(page);
    await page.locator(DOM.menuItemSavedMessages).click();
    await expect(page.locator(DOM.chatHeaderTitle)).toHaveText(
      BILINGUAL_PATTERNS.savedMessages,
    );
    await sendTextMessage(page, account1Marker);
    await expect(
      page
        .locator(DOM.messageList)
        .locator(DOM.messageBubble)
        .filter({ hasText: account1Marker }),
    ).toBeVisible();

    // Add and switch to second account via #menu-account-switcher
    const drawer = await openBurgerMenu(page);
    const switcher = page.locator(DOM.menuAccountSwitcher);
    await expect(switcher).toBeVisible();
    await expect(switcher).not.toContainText(/second_operator/i);
    await switcher.click();

    const addAccountBtn = scopedButton(
      drawer,
      /add\s*account|new\s*account|another\s*account|添加账号|新增账号|添加账户/i,
    )
      .or(
        switcher
          .locator('button, [role="menuitem"]')
          .filter({ hasText: /add|new|\+|添加|新增/i }),
      )
      .first();

    if (
      !(await page.locator(DOM.authScreen).isVisible()) &&
      (await addAccountBtn.count()) > 0 &&
      (await addAccountBtn.isVisible())
    ) {
      await addAccountBtn.click();
    }

    const authContainer = page
      .locator(DOM.authScreen)
      .or(standaloneDialog(page))
      .first();
    await expect(authContainer).toBeVisible();

    const pwdTab = authContainer
      .locator(DOM.tabAuthPassword)
      .or(page.locator(DOM.tabAuthPassword))
      .first();
    await expect(pwdTab).toBeVisible();
    await pwdTab.click();

    await ensurePasswordMode(page, 'register');
    await fillPasswordAuthForm(page, 'second_operator', 'SecondPass!88');
    await page.locator(DOM.btnAuthPasswordSubmit).click();

    await expect(page.locator(DOM.appShell)).toBeVisible();
    await expect(page.locator(DOM.chatList)).toBeVisible();

    // Verify Account 2 ('second_operator') is active and isolated from Account 1's Saved Messages
    await openBurgerMenu(page);
    await page.locator(DOM.menuItemSavedMessages).click();
    await expect(page.locator(DOM.chatHeaderTitle)).toHaveText(
      BILINGUAL_PATTERNS.savedMessages,
    );
    await expect(
      page
        .locator(DOM.messageList)
        .locator(DOM.messageBubble)
        .filter({ hasText: account1Marker }),
    ).toHaveCount(0);

    // Open burger menu again and verify >= 2 accounts & switch back to Account 1
    const drawerAfterAdd = await openBurgerMenu(page);
    const switcherAfter = page.locator(DOM.menuAccountSwitcher);
    await expect(switcherAfter).toBeVisible();

    const accountItems = switcherAfter
      .locator('[data-account-id], [role="menuitem"], button, li')
      .or(drawerAfterAdd.locator('[data-account-id]'));

    if ((await accountItems.count()) < 2) {
      await switcherAfter.click();
    }

    await expect
      .poll(async () => accountItems.count(), {
        message: 'Expected >= 2 account entries in #menu-account-switcher',
      })
      .toBeGreaterThanOrEqual(2);
    await expect(drawerAfterAdd).toContainText(/second_operator/i);

    // Switch back to Account 1 (the entry not matching second_operator)
    const firstAccountOption = accountItems
      .filter({ hasNotText: /second_operator|add|new|\+|添加|新增/i })
      .first();
    await expect(firstAccountOption).toBeVisible();
    await firstAccountOption.click();

    await expect(page.locator(DOM.appShell)).toBeVisible();
    await expect(page.locator(DOM.chatList)).toBeVisible();

    if (await page.locator(DOM.mainMenuDrawer).isVisible()) {
      await page.keyboard.press('Escape');
    }

    // Prove Account 1 genuinely became the active account again by verifying Account 1's Saved Messages vault marker
    await openBurgerMenu(page);
    await page.locator(DOM.menuItemSavedMessages).click();
    await expect(page.locator(DOM.chatHeaderTitle)).toHaveText(
      BILINGUAL_PATTERNS.savedMessages,
    );
    await expect(
      page
        .locator(DOM.messageList)
        .locator(DOM.messageBubble)
        .filter({ hasText: account1Marker }),
    ).toBeVisible();

    // 2. Configure Local Passcode Lock and verify Ctrl+Shift+L lock + #passcode-unlock-input unlock
    const settingsPanel = await navigateToPrivacySecuritySettings(page);
    const passcodeSectionTrigger = settingsPanel
      .locator(
        '[data-settings-section*="passcode" i], [data-testid*="passcode" i]',
      )
      .or(
        scopedMenuItem(
          settingsPanel,
          /passcode|local\s*lock|screen\s*lock|密码锁|本地锁|锁屏密码/i,
        ),
      );

    if (
      (await passcodeSectionTrigger.count()) > 0 &&
      (await passcodeSectionTrigger.first().isVisible())
    ) {
      await passcodeSectionTrigger.first().click();
    }

    const passcodeDialog = standaloneDialog(page);
    const passcodeScope =
      (await passcodeDialog.count()) > 0 ? passcodeDialog : settingsPanel;

    const passcodeInputs = passcodeScope
      .locator(
        'input[name*="passcode" i], input[id*="passcode" i], input[placeholder*="passcode" i], input[placeholder*="密码锁" i], input[placeholder*="PIN" i]',
      )
      .or(passcodeScope.locator('input[type="password"]:visible'))
      .or(scopedTextbox(passcodeScope, /passcode|pin|密码锁|锁屏/i));

    await expect(passcodeInputs.first()).toBeVisible();
    const pcInputCount = await passcodeInputs.count();
    for (let i = 0; i < pcInputCount; i++) {
      await passcodeInputs.nth(i).fill('2580');
    }

    const savePasscodeBtn = scopedButton(
      passcodeScope,
      /enable|set|save|confirm|turn\s*on|开启|启用|设置|保存|确认/i,
    ).first();
    await expect(savePasscodeBtn).toBeVisible();
    await savePasscodeBtn.click();

    await closeSettingsPanel(page);

    await expect(page.locator(DOM.chatList)).toBeVisible();

    // Trigger Ctrl+Shift+L shortcut
    await page.keyboard.press('Control+Shift+L');

    const lockScreen = page.locator(DOM.passcodeLockScreen);
    const unlockInput = page.locator(DOM.passcodeUnlockInput);
    await expect(lockScreen).toBeVisible();
    await expect(unlockInput).toBeVisible();

    const lockBox = await lockScreen.boundingBox();
    expect(lockBox).not.toBeNull();
    expect(lockBox!.width).toBeGreaterThanOrEqual(800);
    expect(lockBox!.height).toBeGreaterThanOrEqual(500);

    await unlockInput.fill('2580');
    await unlockInput.press('Enter');

    await page.waitForTimeout(250);
    if (await lockScreen.isVisible()) {
      const unlockBtn = scopedButton(
        lockScreen,
        /unlock|confirm|enter|ok|解锁|确认|确定/i,
      ).first();
      if ((await unlockBtn.count()) > 0 && (await unlockBtn.isVisible())) {
        await unlockBtn.click();
      }
    }

    await expect(lockScreen).toBeHidden();
    await expect(page.locator(DOM.appShell)).toBeVisible();
    await expect(page.locator(DOM.chatList)).toBeVisible();
  });
});
