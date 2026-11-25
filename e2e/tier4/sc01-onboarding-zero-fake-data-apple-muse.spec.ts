import { test, expect } from '../helpers/fixtures';
import { API_PATHS, DOM } from '../helpers/selectors';
import {
  apiUrl,
  authHeaders,
  clearClientState,
  createRealConversationFixture,
  generateUniqueUsername,
  getBaseUrl,
  loginUserViaApi,
} from '../helpers/server';
import {
  assertEmptyTruthfulWorkspace,
  assertNoDemoAuthControls,
  bilingualRegex,
  BILINGUAL_PATTERNS,
  ensureDarkThemeAndAssertNoPurple,
  openBurgerMenu,
  openContextMenuAndClick,
  openSettings,
  readComposerText,
  registerAndLoginUser,
  scopedButton,
  selectChat,
  sendTextMessage,
  simulateCjkImeComposition,
} from '../helpers/ui';

test.describe('Tier 4 — SC-01: Truthful Onboarding, Zero Fake Data, Apple/Muse Themes & Daily Messaging', () => {
  test('SC-01: Clean reset -> zero demo controls -> real onboarding -> empty truthful workspace -> 2FA + Passcode -> Fabushi v1.6.11 & Apple Dark -> CJK IME, reply, reaction, voice note & reload unlock', async ({
    page,
    request,
  }) => {
    await clearClientState(page);
    await page.goto(`${getBaseUrl()}/`, { waitUntil: 'domcontentloaded' });

    // 1. Verify zero demo/QR-sim controls on #auth-screen & register genuine account
    await assertNoDemoAuthControls(page);
    const uiCreds = await registerAndLoginUser(page, {
      username: generateUniqueUsername('sc01user'),
      password: 'Sc01RealUser!2026',
      firstName: 'Journey Primary',
    });

    // 2. Verify truthful empty initial state (0 chats, 0 fake wallet/providers)
    await assertEmptyTruthfulWorkspace(page);
    expect(await page.title()).toMatch(/Fabushi/i);

    const apiSession = await loginUserViaApi(request, uiCreds.username, uiCreds.password);
    const headers = authHeaders(apiSession.token);
    const chatsRes = await request.get(apiUrl(API_PATHS.chats), { headers });
    expect(chatsRes.status()).toBe(200);
    const chatsBody = (await chatsRes.json()) as { chats?: unknown };
    expect(Array.isArray(chatsBody.chats)).toBe(true);
    expect(chatsBody.chats as unknown[]).toHaveLength(0);

    const magpieRes = await request.get(apiUrl(API_PATHS.magpieState), { headers });
    expect(magpieRes.status()).toBe(200);
    const magpieBody = (await magpieRes.json()) as { has_configured_provider?: unknown };
    expect(magpieBody.has_configured_provider).toBe(false);

    // 3. Configure Cloud 2FA via API & Local Passcode Lock via Settings
    const set2fa = await request.post(apiUrl(API_PATHS.auth2faSet), {
      headers,
      data: { new_password: 'Sc01Cloud2FA!2026', hint: 'Journey Hint' },
    });
    expect(set2fa.status()).toBe(200);

    const settings = await openSettings(page);
    await expect(settings).toContainText(/1\.6\.11/);
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
      await inputs.nth(i).fill('4321');
    }
    await scopedButton(
      page.locator(`${DOM.settingsPanel}, [role="dialog"]`).first(),
      BILINGUAL_PATTERNS.confirm,
    )
      .first()
      .click();
    await page.keyboard.press('Escape');

    // 4. Unconditionally guarantee dark theme & verify Apple Dark zero-purple invariant + switch language
    await ensureDarkThemeAndAssertNoPurple(page);
    await openBurgerMenu(page);
    await page.locator(DOM.menuToggleLanguage).click();

    // 5. Establish real conversation with a 2nd registered user and perform daily CJK messaging
    const conv = await createRealConversationFixture(request, apiSession.token, {
      peerFirstName: 'Journey Peer',
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    const lockScreen = page.locator(DOM.passcodeLockScreen);
    if (await lockScreen.isVisible()) {
      await page.locator(DOM.passcodeUnlockInput).fill('4321');
      await page.locator(DOM.passcodeUnlockInput).press('Enter');
      await expect(lockScreen).toBeHidden();
    } else {
      await expect(page.locator(DOM.appShell)).toBeVisible();
    }
    await selectChat(page, conv.dmTitle);

    const composer = page.locator(DOM.messageComposerInput);
    const bubbles = page.locator(DOM.messageList).locator(DOM.messageBubble);
    const beforeCount = await bubbles.count();
    await simulateCjkImeComposition(composer, 'fabushi', '法布施端到端旅程消息', {
      simulateTrailingPostCompositionEnter: true,
    });
    expect(await bubbles.count()).toBe(beforeCount);
    expect(await readComposerText(composer)).toContain('法布施端到端旅程消息');
    await composer.press('Enter');
    const cjkBubble = bubbles.filter({ hasText: '法布施端到端旅程消息' }).last();
    await expect(cjkBubble).toBeVisible();

    // Hover reaction on CJK bubble
    await cjkBubble.hover();
    const reactTrigger = cjkBubble
      .locator('[data-testid*="reaction" i], button[aria-label*="react" i], [data-reaction-bar] button')
      .or(page.locator('[data-testid="reaction-quick-bar"] button').first())
      .first();
    await expect(reactTrigger).toBeVisible();
    await reactTrigger.click();
    const quickEmoji = page
      .locator('[data-testid="reaction-quick-bar"] button, [data-testid="reaction-picker"] button')
      .filter({ hasText: /👍|❤️|🔥/ })
      .first();
    await expect(quickEmoji).toBeVisible();
    await quickEmoji.click();
    await expect(
      cjkBubble.locator('[data-testid="reaction-chip"], button').filter({ hasText: /👍|❤️|🔥/ }).first(),
    ).toBeVisible();

    // Reply + real Chromium fake-mic voice note
    await openContextMenuAndClick(page, cjkBubble, BILINGUAL_PATTERNS.reply);
    await sendTextMessage(page, 'Quoted follow-up confirmed');

    const recordBtn = page.locator(DOM.btnRecordVoice);
    await recordBtn.click();
    await page.waitForTimeout(900);
    await page.locator(`${DOM.btnSendMessage}:visible, ${DOM.btnRecordVoice}:visible`).first().click();

    const voiceBubble = page
      .locator(DOM.messageList)
      .locator(DOM.messageBubble)
      .filter({ has: page.locator('audio, canvas, [data-waveform], [data-testid*="voice" i]') })
      .last();
    await expect(voiceBubble).toBeVisible({ timeout: 10_000 });

    // 6. Lock, reload, unlock, and verify messages survived in SQLite
    await page.keyboard.press('Control+Shift+L');
    await expect(lockScreen).toBeVisible();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(lockScreen).toBeVisible();
    await page.locator(DOM.passcodeUnlockInput).fill('4321');
    await page.locator(DOM.passcodeUnlockInput).press('Enter');
    await expect(page.locator(DOM.appShell)).toBeVisible();
    await selectChat(page, conv.dmTitle);
    await expect(page.locator(DOM.messageList)).toContainText('法布施端到端旅程消息');
  });
});
