import { test, expect } from '../helpers/fixtures';
import {
  API_PATHS,
  DOM,
  STAGE_TOAST_PILL,
  VIEWPORTS,
  WINDOW_TOAST_BANNER,
} from '../helpers/selectors';
import {
  apiUrl,
  createRealConversationFixture,
} from '../helpers/server';
import {
  assertNoPurpleOnDark,
  bilingualRegex,
  BILINGUAL_PATTERNS,
  openBurgerMenu,
  openContextMenuAndClick,
  openNavDestination,
  openRightInspector,
  openSettings,
  scopedButton,
  selectChat,
  type NavDestination,
} from '../helpers/ui';

test.describe('Tier 2 — A02: Apple/Muse Theme Boundaries, Responsive Overflow, Layered Escape & Branding Hygiene', () => {
  test('A02-T2-01: Anti-purple dark-mode invariant holds across ALL open modals, drawers, and v1.6.11 workspaces under night and tinted', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    await createRealConversationFixture(request, user.token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, 0);

    for (const darkTheme of ['night', 'tinted'] as const) {
      const settings = await openSettings(page);
      const appearanceBtn = settings
        .locator('[data-settings-section*="appearance" i], [data-settings-section*="theme" i]')
        .or(scopedButton(settings, bilingualRegex('appearance|theme', '外观|主题')))
        .first();
      await appearanceBtn.click();

      const themeBtn = settings
        .locator(`[data-theme-option="${darkTheme}"], [data-testid="theme-${darkTheme}"]`)
        .or(scopedButton(settings, new RegExp(darkTheme, 'i')))
        .first();
      await themeBtn.click();
      await expect(page.locator(`:root[data-theme="${darkTheme}"]`)).toHaveCount(1);

      await assertNoPurpleOnDark(page);

      const workspaces: NavDestination[] = ['browser', 'mcp', 'computer', 'hermes', 'chats'];
      for (const ws of workspaces) {
        await openNavDestination(page, ws);
        await assertNoPurpleOnDark(page);
      }

      // Also verify open drawers (#main-menu-drawer) & right inspector (#right-column)
      await openBurgerMenu(page);
      await assertNoPurpleOnDark(page);
      await page.keyboard.press('Escape');

      await selectChat(page, 0);
      await openRightInspector(page);
      await assertNoPurpleOnDark(page);
      await page.keyboard.press('Escape');
    }
  });

  test('A02-T2-02: Mobile 390x844 single-pane stack (#left-column -> #middle-column -> #right-column -> #btn-back-to-chats) has zero horizontal scroll overflow', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token);
    await page.setViewportSize(VIEWPORTS.mobileStack);
    await page.reload({ waitUntil: 'domcontentloaded' });

    const checkNoOverflow = async () => {
      const dims = await page.evaluate(() => ({
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
      }));
      expect(dims.scrollW).toBeLessThanOrEqual(dims.clientW + 2);
    };

    await checkNoOverflow();
    await selectChat(page, conv.dmTitle);
    await checkNoOverflow();

    await page.locator(DOM.btnToggleRightColumn).click();
    await expect(page.locator(DOM.rightColumn)).toBeVisible();
    await checkNoOverflow();

    await page.keyboard.press('Escape');
    await page.locator(DOM.btnBackToChats).click();
    await expect(page.locator(DOM.leftColumn)).toBeVisible();
    await checkNoOverflow();
  });

  test('A02-T2-03: Layered Escape stack pops exactly 1 overlay per Esc press without accidentally closing parent views', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.dmTitle);

    // Open Right Inspector, then open Burger Menu on top
    await page.locator(DOM.btnToggleRightColumn).click();
    await expect(page.locator(DOM.rightColumn)).toBeVisible();

    await openBurgerMenu(page);
    await expect(page.locator(DOM.mainMenuDrawer)).toBeVisible();

    // First Escape closes only the top-most drawer while Right Inspector stays open
    await page.keyboard.press('Escape');
    await expect(page.locator(DOM.mainMenuDrawer)).toBeHidden();
    await expect(page.locator(DOM.rightColumn)).toBeVisible();

    // Second Escape closes Right Inspector
    await page.keyboard.press('Escape');
    await expect(page.locator(DOM.rightColumn)).toBeHidden();
  });

  test('A02-T2-04: Theme and locale selections persist cleanly across page.reload()', async ({
    authSession,
  }) => {
    const { page } = authSession;
    const drawerBefore = await openBurgerMenu(page);
    const localeBefore = await drawerBefore.innerText();
    await page.locator(DOM.menuToggleNightMode).click();
    const themeAfterToggle = await page.evaluate(() =>
      document.documentElement.getAttribute('data-theme'),
    );
    expect(typeof themeAfterToggle).toBe('string');
    expect(themeAfterToggle!.length).toBeGreaterThan(0);

    // Toggle locale and confirm change
    await openBurgerMenu(page);
    await page.locator(DOM.menuToggleLanguage).click();
    const drawerAfterToggle = await openBurgerMenu(page);
    const localeAfterToggle = await drawerAfterToggle.innerText();
    expect(localeAfterToggle).not.toBe(localeBefore);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator(DOM.appShell)).toBeVisible();
    const themeAfterReload = await page.evaluate(() =>
      document.documentElement.getAttribute('data-theme'),
    );
    expect(themeAfterReload).toBe(themeAfterToggle);

    const drawerAfterReload = await openBurgerMenu(page);
    const localeAfterReload = await drawerAfterReload.innerText();
    expect(localeAfterReload).not.toBe(localeBefore);
  });

  test('A02-T2-05: Chat-scoped #window-toast-banner and #stage-toast-pill clear on chat switch while multiline composer never overlaps toast', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token, {
      includeGroup: true,
      groupTitle: 'Toast Clear Target',
      initialDmMessages: [{ from: 'peer', text: 'Toast geometry anchor message' }],
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.dmTitle);

    // Grow composer to 4 lines and trigger a toast
    const composer = page.locator(DOM.messageComposerInput);
    await composer.fill('Line 1\nLine 2\nLine 3\nLine 4');
    const bubble = page.locator(DOM.messageList).locator(DOM.messageBubble).first();
    await openContextMenuAndClick(page, bubble, BILINGUAL_PATTERNS.copy);

    const toast = page.locator(`${WINDOW_TOAST_BANNER}, ${STAGE_TOAST_PILL}`).first();
    await expect(toast).toBeVisible();

    const toastBox = await toast.boundingBox();
    const cmpBox = await page.locator(`${DOM.cmpInputWrap}, ${DOM.messageComposerInput}`).first().boundingBox();
    expect(toastBox!.y + toastBox!.height).toBeLessThanOrEqual(cmpBox!.y + 2);

    // Switching chats clears chat-scoped #stage-toast-pill synchronously
    await selectChat(page, conv.groupTitle ?? 'Toast Clear Target');
    await expect(page.locator(STAGE_TOAST_PILL)).toBeHidden();
  });

  test('A02-T2-06: Zero stale GPUI Telegram Web or v1.3.0 strings in title, manifest, sw.js, /api/v1/health, and /api/v1/status', async ({
    authPage: page,
    request,
  }) => {
    expect(await page.title()).not.toMatch(/GPUI Telegram|1\.3\.0/i);

    for (const p of [API_PATHS.manifest, API_PATHS.swJs, API_PATHS.health, API_PATHS.status]) {
      const res = await request.get(apiUrl(p));
      expect(res.status()).toBe(200);
      const body = await res.text();
      expect(body).not.toContain('gpui-telegram-web-v3');
      expect(body).not.toContain('"1.3.0"');
    }
  });
});
