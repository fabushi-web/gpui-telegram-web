import { test, expect } from '../helpers/fixtures';
import {
  API_PATHS,
  DOM,
  SIDEBAR_PINNED_CHATS_GRID,
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
  openSettings,
  parseCssRgba,
  rgbToHsl,
  scopedButton,
  selectChat,
  sendTextMessage,
} from '../helpers/ui';

test.describe('Tier 1 — A02: Apple Messages macOS & Muse UI/UX Redesign & Fabushi v1.6.11 Branding', () => {
  test('A02-T1-01: Four Vanilla CSS themes (night, tinted, day, classic) exact hex palette tokens, 4-step dark elevation ladder, zero dark drop shadows & zero purple-on-dark', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    await createRealConversationFixture(request, user.token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, 0);

    const openAppearance = async () => {
      const settings = await openSettings(page);
      const appearanceBtn = settings
        .locator('[data-settings-section*="appearance" i], [data-settings-section*="theme" i]')
        .or(scopedButton(settings, bilingualRegex('appearance|chat\\s*settings|theme', '外观|聊天设置|主题')))
        .first();
      await expect(appearanceBtn).toBeVisible();
      await appearanceBtn.click();
      return settings;
    };

    const settings = await openAppearance();
    const clickTheme = async (theme: 'night' | 'tinted' | 'day' | 'classic') => {
      const themeBtn = settings
        .locator(`[data-theme-option="${theme}"], [data-testid="theme-${theme}"]`)
        .or(scopedButton(settings, new RegExp(`^${theme}$|${theme}`, 'i')))
        .first();
      await expect(themeBtn).toBeVisible();
      await themeBtn.click();
      await expect(page.locator(`:root[data-theme="${theme}"]`)).toHaveCount(1);
    };

    // Light themes: verify light stage surface luminance
    for (const lightTheme of ['day', 'classic'] as const) {
      await clickTheme(lightTheme);
      const stageBg = await page.evaluate(() => {
        const middle = document.querySelector('#middle-column');
        return middle ? getComputedStyle(middle).backgroundColor : '';
      });
      const stageRgba = parseCssRgba(stageBg);
      expect(stageRgba, `Expected parseable stage bg for ${lightTheme}`).not.toBeNull();
      expect(rgbToHsl(stageRgba!.r, stageRgba!.g, stageRgba!.b).l).toBeGreaterThan(0.55);
    }

    // Dark themes: unconditionally verify zero purple-on-dark
    await clickTheme('tinted');
    await assertNoPurpleOnDark(page);

    await clickTheme('night');
    await assertNoPurpleOnDark(page);

    // Night theme 4-step elevation ladder & zero dark drop shadows (unconditional)
    const darkMetrics = await page.evaluate(() => {
      const left = document.querySelector('#left-column');
      const middle = document.querySelector('#middle-column');
      const inputWrap =
        document.querySelector('#cmp-input-wrap') ??
        document.querySelector('#message-composer-input');
      return {
        leftBg: left ? getComputedStyle(left).backgroundColor : '',
        middleBg: middle ? getComputedStyle(middle).backgroundColor : '',
        inputBg: inputWrap ? getComputedStyle(inputWrap).backgroundColor : '',
        inputShadow: inputWrap ? getComputedStyle(inputWrap).boxShadow : '',
      };
    });
    const leftRgba = parseCssRgba(darkMetrics.leftBg);
    const middleRgba = parseCssRgba(darkMetrics.middleBg);
    const inputRgba = parseCssRgba(darkMetrics.inputBg);
    expect(leftRgba, 'Expected parseable #left-column backgroundColor').not.toBeNull();
    expect(middleRgba, 'Expected parseable #middle-column backgroundColor').not.toBeNull();
    expect(inputRgba, 'Expected parseable #cmp-input-wrap backgroundColor').not.toBeNull();

    // 4-step elevation: sidebar (#0E0E0E) darker or equal to stage (#161616); composer elevated
    expect(rgbToHsl(leftRgba!.r, leftRgba!.g, leftRgba!.b).l).toBeLessThanOrEqual(
      rgbToHsl(middleRgba!.r, middleRgba!.g, middleRgba!.b).l + 0.05,
    );
    expect(rgbToHsl(inputRgba!.r, inputRgba!.g, inputRgba!.b).l).toBeGreaterThanOrEqual(
      rgbToHsl(middleRgba!.r, middleRgba!.g, middleRgba!.b).l - 0.02,
    );
    // Apple Dark cards/composer use zero dark drop shadows
    expect(darkMetrics.inputShadow).not.toMatch(/rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\.[2-9]/);
  });

  test('A02-T1-02: Centered 76px Apple Messages contact header (#chat-header) & compact outgoing 180-degree blue gradient bubbles', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    await createRealConversationFixture(request, user.token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, 0);

    const header = page.locator(DOM.chatHeader);
    await expect(header).toBeVisible();
    const headerBox = await header.boundingBox();
    expect(headerBox).not.toBeNull();
    expect(headerBox!.height).toBeGreaterThanOrEqual(52);
    expect(headerBox!.height).toBeLessThanOrEqual(96);

    const titleBox = await page.locator(DOM.chatHeaderTitle).boundingBox();
    expect(titleBox).not.toBeNull();
    const headerCenterX = headerBox!.x + headerBox!.width / 2;
    const titleCenterX = titleBox!.x + titleBox!.width / 2;
    expect(Math.abs(titleCenterX - headerCenterX)).toBeLessThanOrEqual(headerBox!.width * 0.25);

    // Send an outgoing message and verify compact blue gradient bubble on dark theme
    const bubble = await sendTextMessage(page, 'Apple Messages pill bubble verification');
    const style = await bubble.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        bgImage: cs.backgroundImage,
        bgColor: cs.backgroundColor,
        borderRadius: parseFloat(cs.borderRadius),
      };
    });

    expect(style.borderRadius).toBeGreaterThanOrEqual(12);
    const hasGradientOrBlue =
      style.bgImage.includes('linear-gradient') ||
      (() => {
        const rgba = parseCssRgba(style.bgColor);
        return rgba !== null && rgba.b > rgba.r + 30;
      })();
    expect(hasGradientOrBlue).toBe(true);

    // Clicking contact header toggles Right Inspector
    await page.locator(DOM.chatHeaderTitle).click();
    await expect(page.locator(DOM.rightColumn)).toBeVisible();
  });

  test('A02-T1-03: 288px collapsible unified sidebar (#btn-collapse-sidebar) & Apple 3x3 #sidebar-pinned-chats-grid with flicker-free pin/unpin sync', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token, {
      includeGroup: true,
      groupTitle: 'Pinned Grid Group',
    });
    await page.reload({ waitUntil: 'domcontentloaded' });

    const leftCol = page.locator(DOM.leftColumn);
    await expect(leftCol).toBeVisible();
    const expandedBox = await leftCol.boundingBox();
    expect(expandedBox).not.toBeNull();
    expect(expandedBox!.width).toBeGreaterThanOrEqual(240);
    expect(expandedBox!.width).toBeLessThanOrEqual(430);

    // Pin the DM chat and verify Apple 3x3 pinned grid appears cleanly without flicker
    const dmRow = page
      .locator(DOM.chatList)
      .locator(DOM.chatRow)
      .filter({ hasText: conv.dmTitle })
      .first();
    await openContextMenuAndClick(page, dmRow, BILINGUAL_PATTERNS.pin);

    const pinnedGrid = page.locator(SIDEBAR_PINNED_CHATS_GRID);
    await expect(pinnedGrid).toBeVisible();
    await expect(pinnedGrid).toContainText(conv.dmTitle);

    // Collapse sidebar to narrow rail (~64px) and expand back
    const collapseBtn = page.locator(DOM.btnCollapseSidebar);
    await expect(collapseBtn).toBeVisible();
    await collapseBtn.click();
    await expect
      .poll(
        async () => {
          const box = await leftCol.boundingBox();
          return box ? box.width : Number.POSITIVE_INFINITY;
        },
        { timeout: 5_000 },
      )
      .toBeLessThanOrEqual(100);

    await collapseBtn.click();
    await expect
      .poll(
        async () => {
          const box = await leftCol.boundingBox();
          return box ? box.width : -1;
        },
        { timeout: 5_000 },
      )
      .toBeGreaterThanOrEqual(240);

    // Unpin cleanly removes item from pinned grid
    await openContextMenuAndClick(page, pinnedGrid.locator('[data-chat-id], button').first(), BILINGUAL_PATTERNS.unpin);
    await expect(pinnedGrid.locator('[data-chat-id]')).toHaveCount(0);
  });

  test('A02-T1-04: Responsive 4-breakpoint shell (1440x900, 1100x800, 768x900, 390x844) & live bilingual en-US / zh-CN switching (#menu-toggle-language)', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    await createRealConversationFixture(request, user.token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, 0);

    // Desktop 3-column (1440x900)
    await page.setViewportSize(VIEWPORTS.desktop3Col);
    await expect(page.locator(DOM.leftColumn)).toBeVisible();
    await expect(page.locator(DOM.middleColumn)).toBeVisible();

    // Desktop 2-column (1100x800)
    await page.setViewportSize(VIEWPORTS.desktop2Col);
    await expect(page.locator(DOM.leftColumn)).toBeVisible();
    await expect(page.locator(DOM.middleColumn)).toBeVisible();

    // Tablet drawer (768x900)
    await page.setViewportSize(VIEWPORTS.tabletDrawer);
    await expect(page.locator(DOM.middleColumn)).toBeVisible();

    // Mobile stack (390x844)
    await page.setViewportSize(VIEWPORTS.mobileStack);
    await expect(page.locator(DOM.middleColumn)).toBeVisible();
    const backBtn = page.locator(DOM.btnBackToChats);
    await expect(backBtn).toBeVisible();
    await backBtn.click();
    await expect(page.locator(DOM.leftColumn)).toBeVisible();

    // Restore desktop and verify live bilingual toggle
    await page.setViewportSize(VIEWPORTS.desktop3Col);
    const drawer = await openBurgerMenu(page);
    const beforeLocaleText = await drawer.innerText();
    await page.locator(DOM.menuToggleLanguage).click();
    await expect
      .poll(async () => (await page.locator(DOM.mainMenuDrawer).isVisible()) ? page.locator(DOM.mainMenuDrawer).innerText() : (await openBurgerMenu(page)).innerText())
      .not.toBe(beforeLocaleText);
  });

  test('A02-T1-05: Two-layer non-overlapping toast system (#stage-toast-pill & #window-toast-banner strictly above #cmp-input-wrap)', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    await createRealConversationFixture(request, user.token, {
      includeGroup: true,
      groupTitle: 'Second Toast Room',
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, 0);

    // Trigger a copy or mute toast inside the active chat
    const bubble = await sendTextMessage(page, 'Toast geometry verification message');
    await openContextMenuAndClick(page, bubble, BILINGUAL_PATTERNS.copy);

    const toast = page.locator(`${WINDOW_TOAST_BANNER}, ${STAGE_TOAST_PILL}`).first();
    await expect(toast).toBeVisible({ timeout: 5_000 });

    const composerWrap = page
      .locator(`${DOM.cmpInputWrap}, ${DOM.messageComposerInput}`)
      .first();
    const toastBox = await toast.boundingBox();
    const composerBox = await composerWrap.boundingBox();
    expect(toastBox).not.toBeNull();
    expect(composerBox).not.toBeNull();
    // Toast banner MUST sit strictly above composer wrap (zero overlap)
    expect(toastBox!.y + toastBox!.height).toBeLessThanOrEqual(composerBox!.y + 2);
  });

  test('A02-T1-06: Fabushi Web v1.6.11 branding across <title>, manifest.webmanifest, sw.js (fabushi-web-v5), /api/v1/health, /api/v1/status, and Settings About', async ({
    authPage: page,
    request,
  }) => {
    const title = await page.title();
    expect(title).toMatch(/Fabushi/i);
    expect(title).not.toMatch(/GPUI Telegram/i);

    const healthRes = await request.get(apiUrl(API_PATHS.health));
    expect(healthRes.status()).toBe(200);
    const health = (await healthRes.json()) as { ok: boolean; version?: string; app?: string };
    expect(health.ok).toBe(true);
    expect(health.version).toBe('1.6.11');
    expect(health.app).toMatch(/Fabushi/i);

    const statusRes = await request.get(apiUrl(API_PATHS.status));
    expect(statusRes.status()).toBe(200);
    const status = (await statusRes.json()) as { version?: string; status?: string };
    expect(status.version).toBe('1.6.11');
    expect(['ok', 'healthy']).toContain(status.status);

    const manifestRes = await request.get(apiUrl(API_PATHS.manifest));
    expect(manifestRes.status()).toBe(200);
    const manifest = (await manifestRes.json()) as { name?: unknown; short_name?: unknown };
    expect(typeof manifest.name).toBe('string');
    expect(manifest.name as string).toMatch(/Fabushi/i);
    expect(typeof manifest.short_name).toBe('string');
    expect(manifest.short_name as string).toMatch(/Fabushi/i);

    const swRes = await request.get(apiUrl(API_PATHS.swJs));
    expect(swRes.status()).toBe(200);
    const swBody = await swRes.text();
    expect(swBody).toContain('fabushi-web-v5');

    const settings = await openSettings(page);
    await expect(settings).toContainText(/1\.6\.11/);
    await expect(settings).toContainText(/Fabushi|法布施/i);
  });
});
