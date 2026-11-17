import type { Locator, Page } from '@playwright/test';
import {
  assertNoPurpleOnDark,
  closeRightInspector,
  CSS_VARS,
  DATA_ATTRS,
  DOM,
  expect,
  openBurgerMenu,
  openNavDestination,
  openRightInspector,
  openSettings,
  parseCssRgba,
  rgbToHsl,
  scopedButton,
  scopedMenuItem,
  selectChat,
  sendTextMessage,
  test,
  themeRootSelector,
  THEMES,
  type NavDestination,
  type ThemeName,
  VIEWPORTS,
} from '../helpers';

const THEME_LABEL_PATTERNS: Record<ThemeName, RegExp> = {
  night: /\bnight\b|夜间|暗夜/i,
  tinted: /\btinted\b|深邃|海洋|暗调/i,
  day: /\bday\b|\blight\b|日间|浅色|明亮/i,
  classic: /\bclassic\b|经典/i,
};

async function selectWritableChat(
  page: Page,
  excludeChatIds: ReadonlySet<string> = new Set(),
): Promise<{ row: Locator; chatId: string; title: string }> {
  const chatList = page.locator(DOM.chatList);
  if (!(await chatList.isVisible())) {
    const backBtn = page.locator(DOM.btnBackToChats);
    if (await backBtn.isVisible()) {
      await backBtn.click();
    }
  }
  await expect(chatList).toBeVisible();

  const rows = chatList.locator(DOM.chatRow);
  await expect(rows.first()).toBeVisible();
  const total = await rows.count();

  for (let i = 0; i < total; i++) {
    const candidate = rows.nth(i);
    const id = (await candidate.getAttribute(DATA_ATTRS.chatId)) ?? '';
    if (!id || excludeChatIds.has(id)) {
      continue;
    }
    const row = await selectChat(page, id);
    const composer = page.locator(DOM.messageComposerInput);
    if ((await composer.isVisible()) && (await composer.isEditable())) {
      const title =
        ((await page.locator(DOM.chatHeaderTitle).textContent()) ?? '').trim();
      return { row, chatId: id, title };
    }
  }

  throw new Error(
    'Expected at least one writable chat with #message-composer-input in #chat-list',
  );
}

async function readCurrentTheme(page: Page): Promise<string> {
  return page.evaluate(() => {
    const shell = document.querySelector('#app-shell');
    return (
      document.documentElement.getAttribute('data-theme') ||
      document.body.getAttribute('data-theme') ||
      shell?.getAttribute('data-theme') ||
      ''
    );
  });
}

async function openAppearanceSettings(page: Page): Promise<Locator> {
  const panel = await openSettings(page);
  const appearanceTrigger = panel
    .locator(
      '[data-settings-section*="appearance" i], [data-settings-section*="theme" i], [data-settings-section*="general" i], [data-settings-section*="chat" i]',
    )
    .or(
      scopedMenuItem(
        panel,
        /appearance|general|theme|chat\s*settings|外观|通用|主题|聊天设置/i,
      ),
    );

  if (
    (await appearanceTrigger.count()) > 0 &&
    (await appearanceTrigger.first().isVisible())
  ) {
    await appearanceTrigger.first().click();
  }
  await expect(panel).toBeVisible();
  return panel;
}

async function setRangeInputValue(
  slider: Locator,
  numericValue: number,
): Promise<void> {
  await expect(slider).toBeVisible();
  await slider.evaluate((el: Element, targetVal: number) => {
    const input = el as HTMLInputElement;
    const min = input.min !== '' ? Number(input.min) : null;
    const max = input.max !== '' ? Number(input.max) : null;
    let adjusted = targetVal;
    // Handle UI scale sliders parameterized either as 0.5..2.0 or 50..200
    if (max !== null && max <= 3 && targetVal > 3) {
      adjusted = Number((targetVal / 100).toFixed(2));
    } else if (min !== null && min >= 40 && targetVal <= 3) {
      adjusted = Math.round(targetVal * 100);
    }
    const descriptor = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    );
    if (descriptor?.set) {
      descriptor.set.call(input, String(adjusted));
    } else {
      input.value = String(adjusted);
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, numericValue);
}

test.describe('F2 — Responsive 4-Breakpoint 3-Column Shell, 4 Vanilla CSS Themes & Bilingual i18n', () => {
  test('F2-01: 4 responsive breakpoints (1440x900, 1100x800, 768x900, 390x844) geometry and navigation', async ({
    authPage: page,
  }) => {
    const leftCol = page.locator(DOM.leftColumn);
    const middleCol = page.locator(DOM.middleColumn);
    const rightCol = page.locator(DOM.rightColumn);

    // 1. >= 1276px (1440x900): 3-Column Docked
    await page.setViewportSize(VIEWPORTS.desktop3Col);
    await selectChat(page, 0);
    await openRightInspector(page);

    await expect(leftCol).toBeVisible();
    await expect(middleCol).toBeVisible();
    await expect(rightCol).toBeVisible();

    const left3 = await leftCol.boundingBox();
    const mid3 = await middleCol.boundingBox();
    const right3 = await rightCol.boundingBox();
    expect(left3).not.toBeNull();
    expect(mid3).not.toBeNull();
    expect(right3).not.toBeNull();

    expect(left3!.x).toBeGreaterThanOrEqual(0);
    expect(left3!.x).toBeLessThanOrEqual(84);
    expect(left3!.width).toBeGreaterThanOrEqual(250);
    expect(left3!.width).toBeLessThanOrEqual(490);
    expect(left3!.x + left3!.width).toBeLessThanOrEqual(mid3!.x + 2);
    expect(mid3!.x + mid3!.width).toBeLessThanOrEqual(right3!.x + 2);
    expect(right3!.width).toBeGreaterThanOrEqual(300);
    expect(right3!.width).toBeLessThanOrEqual(430);
    expect(right3!.x + right3!.width).toBeLessThanOrEqual(1442);

    // 2. 926px–1275px (1100x800): 2-Column Docked + Slide-Over RightColumn
    await page.setViewportSize(VIEWPORTS.desktop2Col);
    await openRightInspector(page);

    await expect(leftCol).toBeVisible();
    await expect(middleCol).toBeVisible();
    await expect(rightCol).toBeVisible();

    const left2 = await leftCol.boundingBox();
    const mid2 = await middleCol.boundingBox();
    const right2 = await rightCol.boundingBox();
    expect(left2).not.toBeNull();
    expect(mid2).not.toBeNull();
    expect(right2).not.toBeNull();

    expect(left2!.x + left2!.width).toBeLessThanOrEqual(mid2!.x + 2);
    expect(mid2!.x + mid2!.width).toBeGreaterThanOrEqual(1094);
    expect(right2!.x).toBeLessThan(mid2!.x + mid2!.width - 20);
    expect(Math.abs(right2!.x + right2!.width - 1100)).toBeLessThanOrEqual(6);

    await closeRightInspector(page);
    await expect(rightCol).toBeHidden();
    await expect(leftCol).toBeVisible();
    await expect(middleCol).toBeVisible();

    // 3. 601px–925px (768x900): Full-Width MiddleColumn + Slide-Over Left/Right Drawers
    await page.setViewportSize(VIEWPORTS.tabletDrawer);
    if (!(await middleCol.isVisible())) {
      await selectChat(page, 0);
    }
    await closeRightInspector(page);
    await expect(middleCol).toBeVisible();

    const midTablet = await middleCol.boundingBox();
    expect(midTablet).not.toBeNull();
    expect(midTablet!.width).toBeGreaterThanOrEqual(680);

    await openRightInspector(page);
    const rightTablet = await rightCol.boundingBox();
    expect(rightTablet).not.toBeNull();
    expect(rightTablet!.width).toBeGreaterThanOrEqual(260);
    expect(rightTablet!.width).toBeLessThanOrEqual(440);
    await closeRightInspector(page);

    const backOrDrawerBtn = page
      .locator(DOM.btnBackToChats)
      .or(
        scopedButton(
          page.locator(DOM.chatHeader),
          /chats|sidebar|drawer|menu|back|会话|列表|返回|侧栏/i,
        ),
      )
      .first();
    if (!(await leftCol.isVisible())) {
      await expect(backOrDrawerBtn).toBeVisible();
      await backOrDrawerBtn.click();
    }
    await expect(leftCol).toBeVisible();
    const leftTablet = await leftCol.boundingBox();
    expect(leftTablet).not.toBeNull();
    expect(leftTablet!.width).toBeGreaterThanOrEqual(240);
    expect(leftTablet!.width).toBeLessThanOrEqual(768);

    // 4. <= 600px (390x844): Mobile 100vw Slide-Stack
    await page.setViewportSize(VIEWPORTS.mobileStack);
    const backBtn = page.locator(DOM.btnBackToChats);
    if (await backBtn.isVisible()) {
      await backBtn.click();
    }
    await expect(leftCol).toBeVisible();
    const leftMob = await leftCol.boundingBox();
    expect(leftMob).not.toBeNull();
    expect(Math.abs(leftMob!.width - 390)).toBeLessThanOrEqual(6);

    await selectChat(page, 0);
    await expect(middleCol).toBeVisible();
    await expect(backBtn).toBeVisible();

    const midMob = await middleCol.boundingBox();
    expect(midMob).not.toBeNull();
    expect(Math.abs(midMob!.width - 390)).toBeLessThanOrEqual(6);

    const leftMobShifted = (await leftCol.isVisible())
      ? await leftCol.boundingBox()
      : null;
    expect(
      leftMobShifted === null ||
        leftMobShifted.x + leftMobShifted.width <= 4 ||
        leftMobShifted.x >= 386,
    ).toBe(true);

    await backBtn.click();
    await expect(page.locator(DOM.chatList)).toBeVisible();
    const leftMobReturned = await leftCol.boundingBox();
    expect(leftMobReturned).not.toBeNull();
    expect(leftMobReturned!.x).toBeGreaterThanOrEqual(-2);
    expect(leftMobReturned!.width).toBeGreaterThanOrEqual(380);
  });

  test('F2-02: #btn-collapse-sidebar + Ctrl+B 64px collapsed rail and unified #nav-rail destinations', async ({
    authPage: page,
  }) => {
    await page.setViewportSize(VIEWPORTS.desktop3Col);

    const leftCol = page.locator(DOM.leftColumn);
    const collapseBtn = page.locator(DOM.btnCollapseSidebar);
    const navRail = page.locator(DOM.navRail);

    await expect(leftCol).toBeVisible();
    await expect(collapseBtn).toBeVisible();

    const measureSidebarSpan = async (): Promise<number> => {
      if (await leftCol.isVisible()) {
        const box = await leftCol.boundingBox();
        if (box && box.width > 0) {
          return box.width;
        }
      }
      const railBox = await navRail.boundingBox();
      return railBox?.width ?? 0;
    };

    const expandedWidth = await measureSidebarSpan();
    expect(expandedWidth).toBeGreaterThanOrEqual(256);

    // Click #btn-collapse-sidebar -> collapses to ~64px rail
    await collapseBtn.click();
    await expect
      .poll(measureSidebarSpan, {
        message: 'Expected sidebar to collapse into ~64px rail',
      })
      .toBeLessThanOrEqual(88);
    const collapsedWidth = await measureSidebarSpan();
    expect(collapsedWidth).toBeGreaterThanOrEqual(48);
    expect(collapsedWidth).toBeLessThan(expandedWidth - 150);

    // Ctrl+B expands back, second Ctrl+B collapses, third Ctrl+B restores expanded
    await page.keyboard.press('Control+b');
    await expect
      .poll(measureSidebarSpan, {
        message: 'Expected Ctrl+B to expand #left-column back >= 256px',
      })
      .toBeGreaterThanOrEqual(256);

    await page.keyboard.press('Control+b');
    await expect.poll(measureSidebarSpan).toBeLessThanOrEqual(88);

    await page.keyboard.press('Control+b');
    await expect.poll(measureSidebarSpan).toBeGreaterThanOrEqual(256);

    // Verify #nav-rail and all 7 canonical unified destinations
    await expect(navRail).toBeVisible();
    const destinations: NavDestination[] = [
      'tasks',
      'mcp',
      'talk',
      'computer',
      'hermes',
      'settings',
      'chats',
    ];

    for (const dest of destinations) {
      const targetPanel = await openNavDestination(page, dest);
      await expect(targetPanel).toBeVisible();
      if (dest === 'talk' || dest === 'settings') {
        await page.keyboard.press('Escape');
      }
    }

    await expect(page.locator(DOM.chatList)).toBeVisible();
  });

  test('F2-03: #btn-main-menu and #main-menu-drawer 11 canonical items and Escape/modal dismissal', async ({
    authPage: page,
  }) => {
    const drawer = await openBurgerMenu(page);
    await expect(drawer).toBeVisible();

    const canonicalDrawerItems = [
      DOM.menuAccountSwitcher,
      DOM.menuItemSavedMessages,
      DOM.menuItemArchived,
      DOM.menuItemContacts,
      DOM.menuItemNewGroup,
      DOM.menuItemNewChannel,
      DOM.menuItemSettings,
      DOM.menuToggleNightMode,
      DOM.menuToggleLanguage,
      DOM.menuItemWallet,
      DOM.menuItemLogout,
    ];

    for (const selector of canonicalDrawerItems) {
      await expect(page.locator(selector)).toBeVisible();
    }

    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();

    await openBurgerMenu(page);
    await page.locator(DOM.menuItemContacts).click();
    const contactsModal = page.locator(DOM.modalContacts);
    await expect(contactsModal).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(contactsModal).toBeHidden();
  });

  test('F2-04: All 4 Vanilla CSS themes (night, tinted, day, classic), Ctrl+D, #menu-toggle-night-mode, and zero purple-on-dark invariant', async ({
    authPage: page,
  }) => {
    await selectWritableChat(page);
    const outBubble = await sendTextMessage(page, 'Theme color probe message');

    const initialTheme = await readCurrentTheme(page);
    expect(initialTheme.length).toBeGreaterThan(0);

    // Toggle via #menu-toggle-night-mode
    await openBurgerMenu(page);
    await page.locator(DOM.menuToggleNightMode).click();
    await expect
      .poll(() => readCurrentTheme(page), {
        message: 'Expected #menu-toggle-night-mode to flip data-theme',
      })
      .not.toBe(initialTheme);
    const afterMenuTheme = await readCurrentTheme(page);

    if (await page.locator(DOM.mainMenuDrawer).isVisible()) {
      await page.keyboard.press('Escape');
    }

    // Toggle via Ctrl+D shortcut
    await page.keyboard.press('Control+d');
    await expect
      .poll(() => readCurrentTheme(page), {
        message: 'Expected Ctrl+D to flip data-theme without reload',
      })
      .not.toBe(afterMenuTheme);

    // Cycle all 4 curated themes inside #settings-panel
    const panel = await openAppearanceSettings(page);
    const paletteSignatures = new Map<ThemeName, string>();

    for (const theme of THEMES) {
      const optionLocator = panel
        .locator(
          `[data-theme-option="${theme}"], [data-theme="${theme}"], [data-value="${theme}"]`,
        )
        .or(scopedButton(panel, THEME_LABEL_PATTERNS[theme]))
        .first();

      await expect(optionLocator).toBeVisible();
      await optionLocator.click();
      await expect(page.locator(themeRootSelector(theme))).toBeAttached();

      const sampledColors = await page.evaluate(() => {
        const shell = document.querySelector('#app-shell') ?? document.body;
        const left = document.querySelector('#left-column') ?? shell;
        return {
          shellBg: window.getComputedStyle(shell).backgroundColor,
          leftBg: window.getComputedStyle(left).backgroundColor,
        };
      });

      const bubbleBgRaw = await outBubble.evaluate((el: Element) => {
        const selfBg = window.getComputedStyle(el).backgroundColor;
        if (selfBg && selfBg !== 'rgba(0, 0, 0, 0)' && selfBg !== 'transparent') {
          return selfBg;
        }
        const inner = Array.from(el.querySelectorAll('*')).find((child) => {
          const bg = window.getComputedStyle(child).backgroundColor;
          return bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';
        });
        return inner ? window.getComputedStyle(inner).backgroundColor : selfBg;
      });

      const surfaceRgba =
        parseCssRgba(sampledColors.leftBg) ?? parseCssRgba(sampledColors.shellBg);
      expect(surfaceRgba).not.toBeNull();
      const surfaceHsl = rgbToHsl(
        surfaceRgba!.r,
        surfaceRgba!.g,
        surfaceRgba!.b,
      );

      if (theme === 'night' || theme === 'tinted') {
        expect(surfaceHsl.l).toBeLessThan(0.25);
        await assertNoPurpleOnDark(page);
      } else {
        expect(surfaceHsl.l).toBeGreaterThan(0.78);
        if (theme === 'classic') {
          const bubbleRgba = parseCssRgba(bubbleBgRaw);
          expect(bubbleRgba).not.toBeNull();
          expect(bubbleRgba!.g).toBeGreaterThan(bubbleRgba!.r);
          expect(bubbleRgba!.g).toBeGreaterThanOrEqual(bubbleRgba!.b);
        }
      }

      paletteSignatures.set(
        theme,
        `${sampledColors.shellBg}|${sampledColors.leftBg}|${bubbleBgRaw}`,
      );
    }

    expect(new Set(paletteSignatures.values()).size).toBeGreaterThanOrEqual(3);
    expect(paletteSignatures.get('night')).not.toBe(paletteSignatures.get('day'));
    expect(paletteSignatures.get('tinted')).not.toBe(
      paletteSignatures.get('classic'),
    );
  });

  test('F2-05: Appearance customization — accent swatches, wallpapers + blur, and runtime --tg-font-size, --tg-bubble-radius, --tg-ui-scale sliders', async ({
    authPage: page,
  }) => {
    await selectWritableChat(page);
    const probeBubble = await sendTextMessage(page, 'Appearance slider probe');
    const panel = await openAppearanceSettings(page);

    // 1. Accent Swatches
    const accentBefore = await page.evaluate(() => {
      const rootStyle = window.getComputedStyle(document.documentElement);
      const sendBtn = document.querySelector('#btn-send-message');
      return `${rootStyle.getPropertyValue('--tg-accent').trim()}|${sendBtn ? window.getComputedStyle(sendBtn).backgroundColor : ''}`;
    });

    const explicitSwatches = panel.locator(
      [
        '[data-accent-swatch]',
        '[data-accent]',
        '[data-testid*="accent" i]',
        'button[aria-label*="accent" i]',
        'button[title*="accent" i]',
        'button[aria-label*="强调色"]',
        'button[aria-label*="主题色"]',
        'button[aria-label*="配色"]',
        'button[title*="强调色"]',
        'button[title*="主题色"]',
        'button[title*="配色"]',
        '[role="radio"][aria-label*="accent" i]',
        '[role="radio"][aria-label*="强调色"]',
        '[role="radio"][aria-label*="主题色"]',
        '[role="radio"][aria-label*="配色"]',
      ].join(', '),
    );
    const sectionScopedSwatches = panel.locator(
      '[data-settings-section*="accent" i] button, button[class*="swatch" i], [role="button"][class*="swatch" i], [role="radio"][class*="swatch" i], [class*="accent" i] button',
    );
    const swatches =
      (await explicitSwatches.count()) >= 8
        ? explicitSwatches
        : (await sectionScopedSwatches.count()) >= 8
          ? sectionScopedSwatches
          : explicitSwatches.or(sectionScopedSwatches);
    await expect(swatches.first()).toBeVisible();
    const swatchCount = await swatches.count();
    expect(swatchCount).toBeGreaterThanOrEqual(8);

    // Click two distinct swatches to guarantee moving off any default active swatch
    await swatches.nth(swatchCount - 1).click();
    const afterLastSwatch = await page.evaluate(() => {
      const rootStyle = window.getComputedStyle(document.documentElement);
      const sendBtn = document.querySelector('#btn-send-message');
      return `${rootStyle.getPropertyValue('--tg-accent').trim()}|${sendBtn ? window.getComputedStyle(sendBtn).backgroundColor : ''}`;
    });
    if (afterLastSwatch === accentBefore) {
      await swatches.nth(1).click();
    }
    const accentAfter = await page.evaluate(() => {
      const rootStyle = window.getComputedStyle(document.documentElement);
      const sendBtn = document.querySelector('#btn-send-message');
      return `${rootStyle.getPropertyValue('--tg-accent').trim()}|${sendBtn ? window.getComputedStyle(sendBtn).backgroundColor : ''}`;
    });
    expect(accentAfter).not.toBe(accentBefore);

    // 2. Wallpaper Presets + Frosted Blur Toggle
    const readWallpaperSignature = async (): Promise<string> =>
      page.evaluate(() => {
        const mid = document.querySelector('#middle-column');
        if (!mid) return '';
        const layers = [mid, ...Array.from(mid.children)];
        return layers
          .map((el) => {
            const st = window.getComputedStyle(el);
            const attrs = Array.from(el.attributes)
              .filter((a) => a.name.includes('wallpaper') || a.name.includes('blur'))
              .map((a) => `${a.name}=${a.value}`)
              .join(',');
            return `${st.backgroundImage}|${st.backgroundColor}|${st.filter}|${st.backdropFilter}|${attrs}`;
          })
          .join('||');
      });

    const wpBefore = await readWallpaperSignature();
    const notUploadOrBlurAttr =
      ':not([aria-label*="upload" i]):not([aria-label*="blur" i]):not([title*="upload" i]):not([title*="blur" i]):not([aria-label*="上传"]):not([aria-label*="模糊"]):not([aria-label*="毛玻璃"]):not([data-testid*="upload" i]):not([data-testid*="blur" i])';
    const explicitWallpapers = panel
      .locator(
        [
          `[data-wallpaper]${notUploadOrBlurAttr}`,
          `[data-wallpaper-id]${notUploadOrBlurAttr}`,
          `[data-testid*="wallpaper" i]${notUploadOrBlurAttr}`,
          `button[aria-label*="wallpaper" i]${notUploadOrBlurAttr}`,
          `button[title*="wallpaper" i]${notUploadOrBlurAttr}`,
          `button[aria-label*="壁纸"]${notUploadOrBlurAttr}`,
          `button[aria-label*="聊天背景"]${notUploadOrBlurAttr}`,
          `button[aria-label*="背景"]${notUploadOrBlurAttr}`,
          `button[title*="壁纸"]${notUploadOrBlurAttr}`,
          `button[title*="聊天背景"]${notUploadOrBlurAttr}`,
          `button[title*="背景"]${notUploadOrBlurAttr}`,
          `[role="radio"][aria-label*="wallpaper" i]${notUploadOrBlurAttr}`,
          `[role="radio"][aria-label*="壁纸"]${notUploadOrBlurAttr}`,
          `[role="radio"][aria-label*="聊天背景"]${notUploadOrBlurAttr}`,
          `[role="radio"][aria-label*="背景"]${notUploadOrBlurAttr}`,
        ].join(', '),
      )
      .filter({
        hasNotText:
          /upload|custom\s*image|choose\s*file|blur|上传|自定义图片|选择文件|模糊|毛玻璃/i,
      });
    const sectionScopedWallpapers = panel
      .locator(
        `[data-settings-section*="wallpaper" i] button${notUploadOrBlurAttr}, [class*="wallpaper" i] button${notUploadOrBlurAttr}`,
      )
      .filter({
        hasNotText:
          /upload|custom\s*image|choose\s*file|blur|上传|自定义图片|选择文件|模糊|毛玻璃/i,
      });
    const wallpapers =
      (await explicitWallpapers.count()) >= 7
        ? explicitWallpapers
        : (await sectionScopedWallpapers.count()) >= 7
          ? sectionScopedWallpapers
          : explicitWallpapers.or(sectionScopedWallpapers);
    await expect(wallpapers.first()).toBeVisible();
    const wpCount = await wallpapers.count();
    expect(wpCount).toBeGreaterThanOrEqual(7);
    await wallpapers.nth(wpCount - 1).click();
    if ((await readWallpaperSignature()) === wpBefore) {
      await wallpapers.nth(1).click();
    }

    const blurControl = panel
      .getByRole('switch', { name: /blur|模糊|毛玻璃/i })
      .or(panel.getByRole('checkbox', { name: /blur|模糊|毛玻璃/i }))
      .or(
        panel.locator(
          '[data-testid*="blur" i], input[name*="blur" i], button[aria-label*="blur" i], button[aria-label*="模糊"], button[aria-label*="毛玻璃"]',
        ),
      )
      .first();
    await expect(blurControl).toBeVisible();
    await blurControl.click();

    const wpAfter = await readWallpaperSignature();
    expect(wpAfter).not.toBe(wpBefore);

    // 3. Runtime CSS Custom Property Sliders (--tg-font-size, --tg-bubble-radius, --tg-ui-scale)
    const rangeSliders = panel.locator('input[type="range"]');
    await expect(rangeSliders.first()).toBeVisible();
    expect(await rangeSliders.count()).toBeGreaterThanOrEqual(3);

    const fontSlider = panel
      .locator(
        'input[type="range"][name*="font" i], input[type="range"][id*="font" i], input[type="range"][aria-label*="font" i], input[type="range"][aria-label*="字号" i], input[type="range"][aria-label*="字体" i]',
      )
      .first();
    const radiusSlider = panel
      .locator(
        'input[type="range"][name*="radius" i], input[type="range"][id*="radius" i], input[type="range"][aria-label*="radius" i], input[type="range"][aria-label*="corner" i], input[type="range"][aria-label*="圆角" i]',
      )
      .first();
    const scaleSlider = panel
      .locator(
        'input[type="range"][name*="scale" i], input[type="range"][id*="scale" i], input[type="range"][aria-label*="scale" i], input[type="range"][aria-label*="zoom" i], input[type="range"][aria-label*="缩放" i]',
      )
      .first();

    const baselineScaleVar = await page.evaluate((varName: string) =>
      window.getComputedStyle(document.documentElement).getPropertyValue(varName).trim(),
    CSS_VARS.uiScale);

    await setRangeInputValue(
      (await fontSlider.count()) > 0 ? fontSlider : rangeSliders.nth(0),
      18,
    );
    await setRangeInputValue(
      (await radiusSlider.count()) > 0 ? radiusSlider : rangeSliders.nth(1),
      8,
    );
    await setRangeInputValue(
      (await scaleSlider.count()) > 0 ? scaleSlider : rangeSliders.nth(2),
      115,
    );

    const updatedVars = await page.evaluate(
      (vars: { fontSize: string; bubbleRadius: string; uiScale: string }) => {
        const root = window.getComputedStyle(document.documentElement);
        return {
          fontSizeVar: root.getPropertyValue(vars.fontSize).trim(),
          bubbleRadiusVar: root.getPropertyValue(vars.bubbleRadius).trim(),
          uiScaleVar: root.getPropertyValue(vars.uiScale).trim(),
        };
      },
      CSS_VARS,
    );

    const bubbleComputed = await probeBubble.evaluate((el: Element) => {
      const st = window.getComputedStyle(el);
      return {
        fontSize: st.fontSize,
        borderRadius: st.borderTopLeftRadius,
      };
    });

    expect(
      updatedVars.fontSizeVar.includes('18') ||
        bubbleComputed.fontSize === '18px',
    ).toBe(true);
    expect(
      updatedVars.bubbleRadiusVar.includes('8') ||
        bubbleComputed.borderRadius === '8px',
    ).toBe(true);
    expect(updatedVars.uiScaleVar.length).toBeGreaterThan(0);
    expect(updatedVars.uiScaleVar).not.toBe(baselineScaleVar);
  });

  test('F2-06: Live bilingual zh-CN <-> en-US i18n toggle (#menu-toggle-language and Ctrl+L) without page reload', async ({
    authPage: page,
  }) => {
    await page.evaluate(() => {
      (window as unknown as { __e2eSameDoc?: boolean }).__e2eSameDoc = true;
    });

    const readUiCopySnapshot = async (): Promise<string> => {
      const searchInput = page.locator(DOM.globalSearchInput);
      const placeholder = (await searchInput.getAttribute('placeholder')) ?? '';
      const ariaLabel = (await searchInput.getAttribute('aria-label')) ?? '';
      const folderTabsText = (
        (await page.locator(DOM.chatFolderTabs).textContent()) ?? ''
      ).trim();
      let drawerLabels = '';
      if (await page.locator(DOM.mainMenuDrawer).isVisible()) {
        drawerLabels = [
          await page.locator(DOM.menuItemSavedMessages).textContent(),
          await page.locator(DOM.menuItemContacts).textContent(),
          await page.locator(DOM.menuItemSettings).textContent(),
        ]
          .filter(Boolean)
          .join('|');
      }
      return `${placeholder}|${ariaLabel}|${folderTabsText}|${drawerLabels}`;
    };

    await openBurgerMenu(page);
    const snap0 = await readUiCopySnapshot();
    const initialHasCjk = /[\u4e00-\u9fff]/.test(snap0);

    await page.locator(DOM.menuToggleLanguage).click();

    await expect
      .poll(readUiCopySnapshot, {
        message: 'Expected #menu-toggle-language to update live UI locale strings',
      })
      .not.toBe(snap0);

    const snap1 = await readUiCopySnapshot();
    if (initialHasCjk) {
      expect(snap1).toMatch(/\b(?:Search|Settings|Contacts|Saved|All)\b/i);
    } else {
      expect(snap1).toMatch(/[\u4e00-\u9fff]/);
    }

    if (await page.locator(DOM.mainMenuDrawer).isVisible()) {
      await page.keyboard.press('Escape');
    }

    // Toggle back via Ctrl+L without reloading document
    await page.keyboard.press('Control+l');

    await expect
      .poll(
        async () => {
          const snap = await readUiCopySnapshot();
          return /[\u4e00-\u9fff]/.test(snap) === initialHasCjk;
        },
        {
          message: 'Expected Ctrl+L to flip UI locale back immediately',
        },
      )
      .toBe(true);

    const sameDoc = await page.evaluate(
      () => (window as unknown as { __e2eSameDoc?: boolean }).__e2eSameDoc === true,
    );
    expect(sameDoc).toBe(true);
  });
});
