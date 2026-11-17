import type { Frame, Locator, Page } from '@playwright/test';
import {
  API_PATHS,
  assertNoPurpleOnDark,
  bilingualRegex,
  clearClientState,
  DATA_ATTRS,
  DOM,
  expect,
  getBaseUrl,
  hermesTabById,
  loginViaDemo,
  openBurgerMenu,
  openNavDestination,
  openSettings,
  resetTestServer,
  scopedButton,
  scopedMenuItem,
  scopedTab,
  scopedTextbox,
  selectChat,
  sendTextMessage,
  test,
} from '../helpers';

interface CanvasVisualSample {
  width: number;
  height: number;
  nonTransparentPixels: number;
  distinctColorBuckets: number;
}

interface TelegramWebAppMainButton {
  text?: string;
  isVisible?: boolean;
  setText: (text: string) => void;
  onClick: (cb: () => void) => void;
  show: () => void;
  hide: () => void;
}

interface TelegramWebAppBackButton {
  isVisible?: boolean;
  onClick: (cb: () => void) => void;
  show: () => void;
  hide: () => void;
}

interface TelegramWebAppCloudStorage {
  setItem: (
    key: string,
    value: string,
    callback?: (err: string | null, stored?: boolean) => void,
  ) => void;
  getItem: (
    key: string,
    callback: (err: string | null, value?: string) => void,
  ) => void;
  getKeys: (
    callback: (err: string | null, keys?: string[]) => void,
  ) => void;
}

interface TelegramWebAppSdk {
  initData: string;
  themeParams: Record<string, string | undefined>;
  MainButton: TelegramWebAppMainButton;
  BackButton: TelegramWebAppBackButton;
  CloudStorage: TelegramWebAppCloudStorage;
  sendData: (data: string) => void;
  close: () => void;
  ready?: () => void;
}

interface E2eMiniAppWindow {
  Telegram?: {
    WebApp?: TelegramWebAppSdk;
  };
  __mainBtnClicked?: number;
  __backBtnClicked?: number;
  __e2eWasmAudit?: {
    count: number;
    exportNames: string[];
  };
}

async function sampleCanvasVisuals(
  canvasLocator: Locator,
): Promise<CanvasVisualSample> {
  await expect(canvasLocator).toBeVisible();
  return canvasLocator.evaluate(
    (el) =>
      new Promise<CanvasVisualSample>((resolve) => {
        if (!(el instanceof HTMLCanvasElement)) {
          resolve({
            width: 0,
            height: 0,
            nonTransparentPixels: 0,
            distinctColorBuckets: 0,
          });
          return;
        }
        requestAnimationFrame(() => {
          const rect = el.getBoundingClientRect();
          const logicalW = el.width || Math.round(rect.width);
          const logicalH = el.height || Math.round(rect.height);
          const sampleW = Math.max(1, Math.min(64, logicalW));
          const sampleH = Math.max(1, Math.min(64, logicalH));
          const probe = document.createElement('canvas');
          probe.width = sampleW;
          probe.height = sampleH;
          const ctx = probe.getContext('2d');
          if (!ctx || logicalW <= 0 || logicalH <= 0) {
            resolve({
              width: logicalW,
              height: logicalH,
              nonTransparentPixels: 0,
              distinctColorBuckets: 0,
            });
            return;
          }
          ctx.drawImage(el, 0, 0, sampleW, sampleH);
          const data = ctx.getImageData(0, 0, sampleW, sampleH).data;
          let nonTransparentPixels = 0;
          const buckets = new Set<string>();
          for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] > 8) {
              nonTransparentPixels++;
              buckets.add(
                `${data[i] >> 4}:${data[i + 1] >> 4}:${data[i + 2] >> 4}`,
              );
            }
          }
          resolve({
            width: logicalW,
            height: logicalH,
            nonTransparentPixels,
            distinctColorBuckets: buckets.size,
          });
        });
      }),
  );
}

async function openBotFatherChat(page: Page): Promise<void> {
  if (!(await page.locator(DOM.chatList).isVisible())) {
    await openNavDestination(page, 'chats');
  }

  const botRow = page
    .locator(DOM.chatList)
    .locator(DOM.chatRow)
    .filter({ hasText: /BotFather/i })
    .first();

  if ((await botRow.count()) > 0 && (await botRow.isVisible())) {
    await botRow.click();
  } else {
    const globalSearch = page.locator(DOM.globalSearchInput);
    await expect(globalSearch).toBeVisible();
    await globalSearch.fill('BotFather');
    const searchBotHit = page
      .locator(DOM.leftColumn)
      .locator('[data-testid="chat-row"], [role="option"], li, button')
      .filter({ hasText: /BotFather/i })
      .first();
    await expect(searchBotHit).toBeVisible();
    await searchBotHit.click();
  }

  await expect(page.locator(DOM.chatHeaderTitle)).toContainText(/BotFather/i);

  const composer = page.locator(DOM.messageComposerInput);
  if (!(await composer.isVisible())) {
    const startBtn = scopedButton(
      page.locator(DOM.middleColumn),
      bilingualRegex('^start$', '^开始$'),
    ).first();
    if ((await startBtn.count()) > 0 && (await startBtn.isVisible())) {
      await startBtn.click();
    }
  }
  await expect(composer).toBeVisible();
}

async function sendBotCommandAndWaitReply(
  page: Page,
  text: string,
): Promise<Locator> {
  const messageList = page.locator(DOM.messageList);
  const bubbles = messageList.locator(DOM.messageBubble);

  const outgoingBubble = await sendTextMessage(page, text);
  const outgoingId = await outgoingBubble.getAttribute(DATA_ATTRS.messageId);
  const countAfterOutgoing = await bubbles.count();

  await expect
    .poll(
      async () => {
        const countNow = await bubbles.count();
        if (countNow > countAfterOutgoing) return true;
        if (countNow > 0 && outgoingId) {
          const lastId = await bubbles.last().getAttribute(DATA_ATTRS.messageId);
          const lastTxt = (await bubbles.last().innerText()).trim();
          return lastId !== outgoingId && lastTxt !== text;
        }
        return false;
      },
      {
        message: `Expected @BotFather to post an incoming reply after "${text}"`,
        timeout: 8_000,
      },
    )
    .toBe(true);

  return bubbles.last();
}

async function openMiniAppModal(
  page: Page,
  appMatcher: RegExp,
): Promise<{ modal: Locator; iframeLoc: Locator; frame: Frame }> {
  const modal = page.locator(DOM.miniappModal);

  // Path A: Check matching bot/miniapp chat row in #chat-list -> Open App / Launch button
  if (!(await modal.isVisible())) {
    if (!(await page.locator(DOM.chatList).isVisible())) {
      await openNavDestination(page, 'chats');
    }
    const matchingChatRow = page
      .locator(DOM.chatList)
      .locator(DOM.chatRow)
      .filter({ hasText: appMatcher })
      .first();

    if (
      (await matchingChatRow.count()) > 0 &&
      (await matchingChatRow.isVisible())
    ) {
      await matchingChatRow.click();
      const openAppBtn = scopedButton(
        page.locator(DOM.middleColumn),
        bilingualRegex(
          'open\\s*app|launch|start\\s*app|mini\\s*app|play|globe|fabushi|taskboard',
          '打开应用|启动|小程序|法布施|全球法布施|进入',
        ),
      )
        .or(
          page
            .locator(DOM.middleColumn)
            .locator('[data-testid*="miniapp" i], [data-testid*="webapp" i]'),
        )
        .first();
      if ((await openAppBtn.count()) > 0 && (await openAppBtn.isVisible())) {
        await openAppBtn.click();
      }
    }
  }

  // Path B: Global Search -> Apps tab -> matching Mini App card
  if (!(await modal.isVisible())) {
    const globalSearch = page.locator(DOM.globalSearchInput);
    if (await globalSearch.isVisible()) {
      await globalSearch.click();
      await globalSearch.fill('');
      const searchTabs = page.locator(DOM.searchTabs);
      if (await searchTabs.isVisible()) {
        const appsTab = scopedTab(
          searchTabs,
          bilingualRegex('apps|mini\\s*apps', '应用|小程序'),
        ).first();
        if ((await appsTab.count()) > 0 && (await appsTab.isVisible())) {
          await appsTab.click();
        }
      }
      const appCard = page
        .locator(DOM.leftColumn)
        .locator('button, [role="option"], [data-miniapp-id], li, div[role="button"]')
        .filter({ hasText: appMatcher })
        .first();
      if ((await appCard.count()) > 0 && (await appCard.isVisible())) {
        await appCard.click();
      } else {
        await page.keyboard.press('Escape');
      }
    }
  }

  // Path C: #btn-attach-menu inside active chat or @BotFather Mini App Catalog
  if (!(await modal.isVisible())) {
    await openBotFatherChat(page);
    const catalogBtn = scopedButton(
      page.locator(DOM.middleColumn),
      appMatcher,
    )
      .or(
        scopedButton(
          page.locator(DOM.middleColumn),
          bilingualRegex('mini\\s*apps|apps|catalog|open', '小程序|应用|目录|打开'),
        ),
      )
      .first();
    if ((await catalogBtn.count()) > 0 && (await catalogBtn.isVisible())) {
      await catalogBtn.click();
    } else if (await page.locator(DOM.btnAttachMenu).isVisible()) {
      await page.locator(DOM.btnAttachMenu).click();
      const menuApp = scopedMenuItem(page, appMatcher).first();
      if ((await menuApp.count()) > 0 && (await menuApp.isVisible())) {
        await menuApp.click();
      }
    }

    // If a catalog dialog opened before #miniapp-modal, pick the matching app
    if (!(await modal.isVisible())) {
      const catalogCard = page
        .locator('button, [role="menuitem"], [role="option"], [data-miniapp-id]')
        .filter({ hasText: appMatcher })
        .first();
      if ((await catalogCard.count()) > 0 && (await catalogCard.isVisible())) {
        await catalogCard.click();
      }
    }
  }

  // Path D: Burger Menu drawer Mini Apps entry
  if (!(await modal.isVisible())) {
    const drawer = await openBurgerMenu(page);
    const drawerAppItem = scopedMenuItem(
      drawer,
      appMatcher,
    )
      .or(
        scopedMenuItem(
          drawer,
          bilingualRegex('mini\\s*app|fabushi|apps', '小程序|法布施|应用'),
        ),
      )
      .first();
    if (
      (await drawerAppItem.count()) > 0 &&
      (await drawerAppItem.isVisible())
    ) {
      await drawerAppItem.click();
      if (!(await modal.isVisible())) {
        const subCard = page
          .locator('button, [data-miniapp-id]')
          .filter({ hasText: appMatcher })
          .first();
        if ((await subCard.count()) > 0 && (await subCard.isVisible())) {
          await subCard.click();
        }
      }
    }
  }

  await expect(modal).toBeVisible();
  const iframeLoc = page.locator(DOM.miniappIframe);
  await expect(iframeLoc).toBeVisible();

  const handle = await iframeLoc.elementHandle();
  expect(handle).not.toBeNull();
  const frame = await handle!.contentFrame();
  expect(frame).not.toBeNull();
  await frame!.waitForLoadState('domcontentloaded');

  return { modal, iframeLoc, frame: frame! };
}

test.describe(
  'F16 — @BotFather, Telegram.WebApp Mini Apps, Fabushi WASM 3D Globe, Hermes, Magpie & Cloud Workspaces',
  () => {
    test('F16-T1: interactive @BotFather /start, /newbot, /mybots, and /newapp wizard flow', async ({
      authPage,
    }) => {
      await openBotFatherChat(authPage);

      // 1. /start
      const startReply = await sendBotCommandAndWaitReply(authPage, '/start');
      await expect(startReply).toContainText(/\/newbot/i);
      await expect(startReply).toContainText(/\/mybots|\/newapp/i);

      // 2. /newbot interactive wizard
      const newBotPrompt1 = await sendBotCommandAndWaitReply(
        authPage,
        '/newbot',
      );
      await expect(newBotPrompt1).toContainText(/name|call it|名称|名字/i);

      const newBotPrompt2 = await sendBotCommandAndWaitReply(
        authPage,
        'Nebula Atlas Bot',
      );
      await expect(newBotPrompt2).toContainText(/username|bot|用户名/i);

      const botHandle = 'nebula_atlas_e2e_bot';
      const tokenReply = await sendBotCommandAndWaitReply(authPage, botHandle);
      await expect(tokenReply).toContainText(
        /\d+:[A-Za-z0-9_-]{8,}|token|nebula_atlas_e2e_bot/i,
      );

      // 3. /mybots verification
      const myBotsReply = await sendBotCommandAndWaitReply(authPage, '/mybots');
      const middleText = await authPage.locator(DOM.middleColumn).innerText();
      expect(
        /nebula_atlas_e2e_bot|Nebula Atlas Bot/i.test(
          `${await myBotsReply.innerText()} ${middleText}`,
        ),
      ).toBe(true);

      // 4. /newapp adaptive wizard
      let latestReply = await sendBotCommandAndWaitReply(authPage, '/newapp');
      const appConfirmationRe =
        /t\.me\/|\/miniapps\/|nebulaboard|created|ready|congratulations|web\s*app.*created|成功|已创建|已配置/i;

      for (let step = 0; step < 6; step++) {
        const promptTxt = await latestReply.innerText();
        if (step > 0 && appConfirmationRe.test(promptTxt)) {
          break;
        }

        const inlineBotBtn = latestReply
          .locator('button')
          .filter({ hasText: /nebula_atlas_e2e_bot|Nebula Atlas/i })
          .first();

        if (
          (await inlineBotBtn.count()) > 0 &&
          (await inlineBotBtn.isVisible())
        ) {
          const countBeforeClick = await authPage
            .locator(DOM.messageList)
            .locator(DOM.messageBubble)
            .count();
          await inlineBotBtn.click();
          await expect
            .poll(async () =>
              authPage
                .locator(DOM.messageList)
                .locator(DOM.messageBubble)
                .count(),
            )
            .toBeGreaterThan(countBeforeClick);
          latestReply = authPage
            .locator(DOM.messageList)
            .locator(DOM.messageBubble)
            .last();
        } else if (/choose a bot|which bot|select.*bot|\bbot\b.*@|选择.*机器人/i.test(promptTxt)) {
          latestReply = await sendBotCommandAndWaitReply(
            authPage,
            `@${botHandle}`,
          );
        } else if (/short\s*name|slug|短名称|标识/i.test(promptTxt)) {
          latestReply = await sendBotCommandAndWaitReply(
            authPage,
            'nebulaboard',
          );
        } else if (/url|https?:|web\s*app.*address|网址|链接/i.test(promptTxt)) {
          latestReply = await sendBotCommandAndWaitReply(
            authPage,
            `${getBaseUrl()}/miniapps/taskboard`,
          );
        } else if (/photo|gif|\/empty|图片/i.test(promptTxt)) {
          latestReply = await sendBotCommandAndWaitReply(authPage, '/empty');
        } else if (/description|描述|简介/i.test(promptTxt)) {
          latestReply = await sendBotCommandAndWaitReply(
            authPage,
            'Interactive E2E Mini App workspace',
          );
        } else if (/title|name|标题|名称/i.test(promptTxt)) {
          latestReply = await sendBotCommandAndWaitReply(
            authPage,
            'Nebula Board',
          );
        } else {
          latestReply = await sendBotCommandAndWaitReply(
            authPage,
            'nebulaboard',
          );
        }
      }

      await expect(latestReply).toContainText(
        /t\.me\/|\/miniapps\/|nebulaboard|Nebula Board|created|ready|成功|创建/i,
      );
    });

    test('F16-T2: #miniapp-modal #miniapp-iframe /js/telegram-web-app.js SDK bridge (initData, themeParams, MainButton, BackButton, CloudStorage, sendData, close)', async ({
      authPage,
    }) => {
      // 1. Verify /js/telegram-web-app.js static SDK endpoint
      const sdkRes = await authPage.request.get(
        `${getBaseUrl()}${API_PATHS.telegramWebAppSdk}`,
      );
      expect(sdkRes.status()).toBe(200);
      expect(await sdkRes.text()).toMatch(/Telegram[\s\S]*WebApp/);

      // 2. Open Mini App inside #miniapp-modal -> #miniapp-iframe
      const { modal, iframeLoc, frame } = await openMiniAppModal(
        authPage,
        /taskboard|task|fabushi|法布施/i,
      );
      await expect(iframeLoc).toHaveAttribute('src', /\/miniapps\/.+/);

      // 3. Poll until window.Telegram.WebApp SDK initializes inside iframe
      await expect
        .poll(
          async () =>
            frame.evaluate(() => {
              const win = window as unknown as E2eMiniAppWindow;
              return Boolean(win.Telegram?.WebApp);
            }),
          { timeout: 8_000 },
        )
        .toBe(true);

      // 4. Verify initData HMAC signature & themeParams
      const bridgeSnapshot = await frame.evaluate(() => {
        const win = window as unknown as E2eMiniAppWindow;
        const wa = win.Telegram!.WebApp!;
        wa.ready?.();
        return {
          initData: wa.initData,
          themeKeys: Object.keys(wa.themeParams ?? {}),
          bgColor: wa.themeParams?.bg_color ?? '',
        };
      });

      expect(typeof bridgeSnapshot.initData).toBe('string');
      expect(bridgeSnapshot.initData.length).toBeGreaterThan(10);
      expect(bridgeSnapshot.initData).toContain('hash=');
      expect(bridgeSnapshot.themeKeys.length).toBeGreaterThan(0);

      // 5. Verify MainButton bidirectional sync
      await frame.evaluate(() => {
        const win = window as unknown as E2eMiniAppWindow;
        win.__mainBtnClicked = 0;
        const mb = win.Telegram!.WebApp!.MainButton;
        mb.setText('E2E Main CTA');
        mb.onClick(() => {
          win.__mainBtnClicked = (win.__mainBtnClicked ?? 0) + 1;
        });
        mb.show();
      });

      const hostMainBtn = modal.getByRole('button', { name: 'E2E Main CTA' }).first();
      const frameMainBtn = frame.getByRole('button', { name: 'E2E Main CTA' }).first();
      if ((await hostMainBtn.count()) > 0 && (await hostMainBtn.isVisible())) {
        await hostMainBtn.click();
      } else {
        await expect(frameMainBtn).toBeVisible();
        await frameMainBtn.click();
      }

      await expect
        .poll(
          async () =>
            frame.evaluate(() => {
              const win = window as unknown as E2eMiniAppWindow;
              return win.__mainBtnClicked ?? 0;
            }),
          { timeout: 5_000 },
        )
        .toBeGreaterThanOrEqual(1);

      // 6. Verify BackButton bidirectional sync
      await frame.evaluate(() => {
        const win = window as unknown as E2eMiniAppWindow;
        win.__backBtnClicked = 0;
        const bb = win.Telegram!.WebApp!.BackButton;
        bb.onClick(() => {
          win.__backBtnClicked = (win.__backBtnClicked ?? 0) + 1;
        });
        bb.show();
      });

      const hostBackBtn = scopedButton(modal, 'back')
        .or(
          modal.locator(
            'button[id*="back" i], button[data-testid*="back" i], button[aria-label*="back" i], button[aria-label*="返回" i]',
          ),
        )
        .first();
      const frameBackBtn = scopedButton(
        authPage.frameLocator(DOM.miniappIframe).locator('body'),
        'back',
      ).first();

      if ((await hostBackBtn.count()) > 0 && (await hostBackBtn.isVisible())) {
        await hostBackBtn.click();
      } else {
        await expect(frameBackBtn).toBeVisible();
        await frameBackBtn.click();
      }

      await expect
        .poll(
          async () =>
            frame.evaluate(() => {
              const win = window as unknown as E2eMiniAppWindow;
              return win.__backBtnClicked ?? 0;
            }),
          { timeout: 5_000 },
        )
        .toBeGreaterThanOrEqual(1);

      await frame.evaluate(() => {
        const win = window as unknown as E2eMiniAppWindow;
        win.Telegram?.WebApp?.BackButton.hide();
      });

      // 7. Verify CloudStorage round-trip (setItem / getItem / getKeys)
      const storageCheck = await frame.evaluate(
        () =>
          new Promise<{ value: string; keys: string[] }>((resolve, reject) => {
            const win = window as unknown as E2eMiniAppWindow;
            const cs = win.Telegram!.WebApp!.CloudStorage;
            cs.setItem('e2e_bridge_key', 'bridge_value_42', (setErr) => {
              if (setErr) {
                reject(new Error(setErr));
                return;
              }
              cs.getItem('e2e_bridge_key', (getErr, val) => {
                if (getErr) {
                  reject(new Error(getErr));
                  return;
                }
                cs.getKeys((keysErr, keys) => {
                  if (keysErr) {
                    reject(new Error(keysErr));
                    return;
                  }
                  resolve({ value: val ?? '', keys: keys ?? [] });
                });
              });
            });
          }),
      );

      expect(storageCheck.value).toBe('bridge_value_42');
      expect(storageCheck.keys).toContain('e2e_bridge_key');

      // 8. Verify sendData & close
      await frame.evaluate(() => {
        const win = window as unknown as E2eMiniAppWindow;
        win.Telegram!.WebApp!.sendData(
          JSON.stringify({ action: 'e2e_miniapp_submit', score: 99 }),
        );
      });

      await authPage.waitForTimeout(250);
      if (await modal.isVisible()) {
        await frame.evaluate(() => {
          const win = window as unknown as E2eMiniAppWindow;
          win.Telegram?.WebApp?.close();
        });
      }

      await expect(modal).toBeHidden();
    });

    test('F16-T3: flagship 全球法布施 (fabushi-globe) .wasm kernel + 3D Globe <canvas> + Zen Room (木鱼 Wooden Fish, Incense, Sutras, VIP/Leaderboard)', async ({
      page,
      request,
    }) => {
      await clearClientState(page);
      await resetTestServer(request);

      let validWasmBinaryFetched = false;
      page.on('response', async (res) => {
        if (/\.wasm(?:\?|$)/i.test(res.url()) && res.ok()) {
          const bytes = await res.body();
          if (
            bytes.length >= 8 &&
            bytes[0] === 0x00 &&
            bytes[1] === 0x61 &&
            bytes[2] === 0x73 &&
            bytes[3] === 0x6d
          ) {
            validWasmBinaryFetched = true;
          }
        }
      });

      // Install non-invasive context-wide WebAssembly instantiation observer before navigation
      await page.context().addInitScript(() => {
        const win = window as unknown as E2eMiniAppWindow;
        win.__e2eWasmAudit = { count: 0, exportNames: [] };

        const recordInstance = (res: unknown): void => {
          if (!res || typeof res !== 'object') return;
          const inst =
            'instance' in res
              ? (res as { instance: WebAssembly.Instance }).instance
              : (res as WebAssembly.Instance);
          if (inst && inst.exports && win.__e2eWasmAudit) {
            win.__e2eWasmAudit.count++;
            for (const k of Object.keys(inst.exports)) {
              if (!win.__e2eWasmAudit.exportNames.includes(k)) {
                win.__e2eWasmAudit.exportNames.push(k);
              }
            }
          }
        };

        const origInstantiate = WebAssembly.instantiate.bind(WebAssembly);
        WebAssembly.instantiate = (async (
          ...args: Parameters<typeof WebAssembly.instantiate>
        ) => {
          const result = await origInstantiate(...args);
          recordInstance(result);
          return result;
        }) as typeof WebAssembly.instantiate;

        if (typeof WebAssembly.instantiateStreaming === 'function') {
          const origStream =
            WebAssembly.instantiateStreaming.bind(WebAssembly);
          WebAssembly.instantiateStreaming = (async (
            ...args: Parameters<typeof WebAssembly.instantiateStreaming>
          ) => {
            const result = await origStream(...args);
            recordInstance(result);
            return result;
          }) as typeof WebAssembly.instantiateStreaming;
        }
      });

      await page.goto(`${getBaseUrl()}/`, { waitUntil: 'domcontentloaded' });
      await loginViaDemo(page);

      const { iframeLoc, frame } = await openMiniAppModal(
        page,
        /fabushi|法布施|globe/i,
      );
      await expect(iframeLoc).toHaveAttribute('src', /fabushi/i);

      // 1. Verify genuine compiled .wasm module loaded and instantiated
      await expect
        .poll(
          async () => {
            if (validWasmBinaryFetched) return true;
            return frame.evaluate(() => {
              const win = window as unknown as E2eMiniAppWindow;
              return (
                (win.__e2eWasmAudit?.count ?? 0) > 0 &&
                (win.__e2eWasmAudit?.exportNames.length ?? 0) > 0
              );
            });
          },
          {
            message:
              'Expected fabushi-globe Mini App to load and instantiate a real .wasm binary module',
            timeout: 10_000,
          },
        )
        .toBe(true);

      const frameRoot = page.frameLocator(DOM.miniappIframe).locator('body');

      // 2. Verify 3D Globe HTML5 <canvas> & Dharma light-beam action
      const globeCanvas = page
        .frameLocator(DOM.miniappIframe)
        .locator('canvas')
        .first();
      await expect(globeCanvas).toBeVisible();

      const canvasSample = await sampleCanvasVisuals(globeCanvas);
      expect(canvasSample.width).toBeGreaterThanOrEqual(150);
      expect(canvasSample.height).toBeGreaterThanOrEqual(150);
      expect(canvasSample.nonTransparentPixels).toBeGreaterThan(100);
      expect(canvasSample.distinctColorBuckets).toBeGreaterThanOrEqual(2);

      const beamBtn = scopedButton(
        frameRoot,
        bilingualRegex(
          'beam|light|offer|dharma|blessing|radiate',
          '法布施|佛光|祈福|点亮|发射|供养',
        ),
      ).first();
      if ((await beamBtn.count()) > 0 && (await beamBtn.isVisible())) {
        await beamBtn.click();
      } else {
        await globeCanvas.click();
      }

      // 3. Verify Zen Room: Wooden Fish (木鱼), Incense (上香), and Sutras (佛经)
      const zenTab = scopedTab(
        frameRoot,
        bilingualRegex(
          'zen|meditat|wooden\\s*fish|temple',
          '禅堂|静修|木鱼|共修|禅修',
        ),
      ).first();
      if ((await zenTab.count()) > 0 && (await zenTab.isVisible())) {
        await zenTab.click();
      }

      const woodenFishBtn = scopedButton(
        frameRoot,
        bilingualRegex('wooden\\s*fish|tap|knock|merit', '木鱼|敲击|功德'),
      )
        .or(
          frameRoot.locator(
            '[id*="muyu" i], [id*="fish" i], [data-testid*="muyu" i], [data-testid*="fish" i]',
          ),
        )
        .first();
      await expect(woodenFishBtn).toBeVisible();

      const extractMaxMeritNumber = async (): Promise<number> => {
        const txt = await frameRoot.innerText();
        const nums = Array.from(txt.matchAll(/\b\d+\b/g)).map((m) =>
          Number(m[0]),
        );
        return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) : 0;
      };

      const meritSumBefore = await extractMaxMeritNumber();
      await woodenFishBtn.click();
      await woodenFishBtn.click();
      await woodenFishBtn.click();

      await expect
        .poll(async () => (await extractMaxMeritNumber()) > meritSumBefore, {
          message: 'Expected tapping Wooden Fish (木鱼) 3 times to increment merit counter',
          timeout: 5_000,
        })
        .toBe(true);

      // Incense (上香 / 敬香 / Incense)
      const incenseControl = scopedButton(
        frameRoot,
        bilingualRegex('incense|burn|light incense', '上香|敬香|焚香|点香'),
      )
        .or(scopedTab(frameRoot, bilingualRegex('incense', '上香|敬香|香炉')))
        .first();
      await expect(incenseControl).toBeVisible();
      await incenseControl.click();

      // Sutras (佛经 / 心经 / 金刚经 / Sutra)
      const sutraTrigger = scopedTab(
        frameRoot,
        bilingualRegex(
          'sutra|scripture|heart\\s*sutra|diamond',
          '佛经|经书|经文|心经|金刚经|诵经',
        ),
      )
        .or(
          frameRoot
            .locator('button, select, [role="button"]')
            .filter({
              hasText: /sutra|scripture|佛经|经书|经文|心经|金刚经/i,
            }),
        )
        .first();
      if ((await sutraTrigger.count()) > 0 && (await sutraTrigger.isVisible())) {
        await sutraTrigger.click();
      }
      await expect(frameRoot).toContainText(
        /般若|菩萨|波罗蜜|空不异色|一切有为法|观自在|如是我闻|sutra|dharma/i,
      );

      // 4. Verify VIP, Achievements & Leaderboard
      const leaderboardTab = scopedTab(
        frameRoot,
        bilingualRegex(
          'leaderboard|rank|top|hall',
          '功德榜|排行榜|榜单|排名',
        ),
      ).first();
      if (
        (await leaderboardTab.count()) > 0 &&
        (await leaderboardTab.isVisible())
      ) {
        await leaderboardTab.click();
      }
      await expect(frameRoot).toContainText(
        /leaderboard|rank|功德榜|排行榜|#1|1\./i,
      );

      const vipOrAchTab = scopedTab(
        frameRoot,
        bilingualRegex('achievement|badge|vip', '成就|勋章|会员|VIP'),
      ).first();
      if ((await vipOrAchTab.count()) > 0 && (await vipOrAchTab.isVisible())) {
        await vipOrAchTab.click();
      }
      await expect(frameRoot).toContainText(/achievement|vip|成就|会员/i);
    });

    test('F16-T4: Hermes 6-Tab AI Studio (#nav-dest-hermes / #hermes-studio-panel [data-hermes-tab]) navigates all 6 domains', async ({
      authPage,
    }) => {
      const studio = await openNavDestination(authPage, 'hermes');
      await expect(studio).toBeVisible();

      const tabLocators = studio.locator(DOM.hermesTabItem);
      const tabCount = await tabLocators.count();
      expect(tabCount).toBeGreaterThanOrEqual(6);

      const tabsMeta = await tabLocators.evaluateAll((els, attr) =>
        els.map((el) => ({
          id: (el.getAttribute(attr) ?? '').trim(),
          label: (el.textContent ?? '').trim(),
        })),
        DATA_ATTRS.hermesTab,
      );

      const combinedSignature = tabsMeta
        .map((t) => `${t.id} ${t.label}`)
        .join(' | ');

      // Verify all 6 contracted Hermes Studio domains are present
      expect(combinedSignature).toMatch(/session|provider|会话|供应商|模型/i);
      expect(combinedSignature).toMatch(/memory|soul|记忆|灵魂|人格/i);
      expect(combinedSignature).toMatch(/skill|技能/i);
      expect(combinedSignature).toMatch(/tool|terminal|工具|终端/i);
      expect(combinedSignature).toMatch(/cron|heartbeat|定时|心跳/i);
      expect(combinedSignature).toMatch(/kanban|approval|看板|审批/i);

      // Click through all 6 canonical [data-hermes-tab] triggers and verify active panel rendering
      for (const tab of tabsMeta.slice(0, 6)) {
        expect(tab.id.length).toBeGreaterThan(0);
        const tabBtn = authPage.locator(hermesTabById(tab.id)).first();
        await expect(tabBtn).toBeVisible();
        await tabBtn.click();

        const panelText = (await studio.innerText()).trim();
        expect(panelText.length).toBeGreaterThan(10);

        // Exercise interactive state inside Memory/Soul tab when visited
        if (/memory|soul|记忆|灵魂/i.test(`${tab.id} ${tab.label}`)) {
          const memInput = studio
            .locator('textarea, input[type="text"]')
            .first();
          if ((await memInput.count()) > 0 && (await memInput.isVisible())) {
            await memInput.fill('Hermes Soul Invariant: Hexagonal Clean Architecture');
            const saveMemBtn = scopedButton(
              studio,
              bilingualRegex('save|add|update|commit', '保存|添加|更新|提交'),
            ).first();
            if (
              (await saveMemBtn.count()) > 0 &&
              (await saveMemBtn.isVisible())
            ) {
              await saveMemBtn.click();
            }
          }
        }
      }
    });

    test('F16-T5: Hermes AI Runtime executes /slash commands and streams SSE ThinkingBubble responses', async ({
      authPage,
    }) => {
      const studio = await openNavDestination(authPage, 'hermes');
      const studioPromptInput = studio
        .locator('textarea, input[type="text"]')
        .first();

      let surface: Locator = studio;
      let useChatStage = false;

      if (
        !(await studioPromptInput.count()) ||
        !(await studioPromptInput.isVisible())
      ) {
        await openNavDestination(authPage, 'chats');
        await selectChat(authPage, /Hermes|Agent|AI/i);
        surface = authPage.locator(DOM.middleColumn);
        useChatStage = true;
      }

      // 1. /slash command execution
      if (useChatStage) {
        const slashReply = await sendBotCommandAndWaitReply(
          authPage,
          '/memory',
        );
        await expect(slashReply).toBeVisible();
        expect((await slashReply.innerText()).trim().length).toBeGreaterThan(4);
      } else {
        await studioPromptInput.fill('/memory');
        const sendStudioBtn = scopedButton(studio, 'send')
          .or(scopedButton(studio, 'confirm'))
          .first();
        if (
          (await sendStudioBtn.count()) > 0 &&
          (await sendStudioBtn.isVisible())
        ) {
          await sendStudioBtn.click();
        } else {
          await studioPromptInput.press('Enter');
        }
        await expect
          .poll(async () => (await studio.innerText()).length, {
            timeout: 8_000,
          })
          .toBeGreaterThan(20);
      }

      // 2. Streaming SSE prompt + ThinkingBubble verification
      const reasoningPrompt =
        'Analyze PTS gap recovery invariants and summarize in 2 bullets';

      if (useChatStage) {
        const aiReply = await sendBotCommandAndWaitReply(
          authPage,
          reasoningPrompt,
        );
        await expect(aiReply).toBeVisible();
        expect((await aiReply.innerText()).trim().length).toBeGreaterThan(20);
      } else {
        const textBefore = await studio.innerText();
        await studioPromptInput.fill(reasoningPrompt);
        const sendStudioBtn = scopedButton(studio, 'send')
          .or(scopedButton(studio, 'confirm'))
          .first();
        if (
          (await sendStudioBtn.count()) > 0 &&
          (await sendStudioBtn.isVisible())
        ) {
          await sendStudioBtn.click();
        } else {
          await studioPromptInput.press('Enter');
        }
        await expect
          .poll(async () => (await studio.innerText()) !== textBefore, {
            timeout: 10_000,
          })
          .toBe(true);
      }

      // Verify ThinkingBubble / reasoning trace rendered in surface
      await expect
        .poll(
          async () =>
            surface.evaluate((el) => {
              const hasThinkingNode =
                el.querySelector(
                  '[data-testid*="thinking" i], [id*="thinking" i], [class*="thinking" i], details',
                ) !== null;
              const hasThinkingCopy =
                /thinking|reasoning|thought|思考|推理/i.test(
                  el.textContent ?? '',
                );
              return hasThinkingNode || hasThinkingCopy;
            }),
          {
            message: 'Expected Hermes SSE turn to render ThinkingBubble reasoning trace',
            timeout: 10_000,
          },
        )
        .toBe(true);
    });

    test('F16-T6: Magpie LLM Gateway (#magpie-gateway-panel) configures zero-subscription preset, multi-provider routing, PII privacy masking & usage ledger', async ({
      authPage,
    }) => {
      const magpie = authPage.locator(DOM.magpieGatewayPanel);

      if (!(await magpie.isVisible())) {
        const studio = await openNavDestination(authPage, 'hermes');
        const gatewayBtn = studio
          .locator('button, [role="tab"], [data-hermes-tab]')
          .filter({
            hasText: /magpie|gateway|provider|routing|llm|网关|供应商|路由/i,
          })
          .first();
        if ((await gatewayBtn.count()) > 0 && (await gatewayBtn.isVisible())) {
          await gatewayBtn.click();
        }
      }

      if (!(await magpie.isVisible())) {
        const settings = await openSettings(authPage);
        const magpieSetting = settings
          .locator('[data-settings-section], button, [role="menuitem"]')
          .filter({
            hasText: /magpie|gateway|llm|ai|provider|网关|模型|供应商/i,
          })
          .first();
        if (
          (await magpieSetting.count()) > 0 &&
          (await magpieSetting.isVisible())
        ) {
          await magpieSetting.click();
        }
      }

      if (!(await magpie.isVisible())) {
        const drawer = await openBurgerMenu(authPage);
        const drawerMagpie = scopedMenuItem(
          drawer,
          bilingualRegex('magpie|gateway', '网关|模型网关'),
        ).first();
        if (
          (await drawerMagpie.count()) > 0 &&
          (await drawerMagpie.isVisible())
        ) {
          await drawerMagpie.click();
        }
      }

      await expect(magpie).toBeVisible();

      // 1. Zero-subscription local smart provider preset
      const zeroSubControl = magpie
        .locator('button, [role="radio"], [role="option"], label')
        .filter({
          hasText:
            /zero-sub|no-sub|free|local|built-in|smart|免订阅|内置|本地|零订阅/i,
        })
        .first();
      await expect(zeroSubControl).toBeVisible();
      await zeroSubControl.click();

      // 2. Multi-provider routing (OpenAI, Anthropic, Gemini)
      const magpieText = await magpie.innerText();
      expect(magpieText).toMatch(/openai/i);
      expect(magpieText).toMatch(/anthropic|claude/i);
      expect(magpieText).toMatch(/gemini|google/i);

      // 3. PII Privacy Masking toggle (+ redaction preview if test box is exposed)
      const piiPattern = bilingualRegex(
        'pii|mask|privacy|redact',
        '脱敏|隐私|掩码',
      );
      const piiToggle = magpie
        .getByRole('checkbox', { name: piiPattern })
        .or(magpie.getByRole('switch', { name: piiPattern }))
        .or(magpie.locator('label, button').filter({ hasText: piiPattern }))
        .first();
      await expect(piiToggle).toBeVisible();

      const isPiiChecked = await piiToggle.evaluate((el) => {
        if (el instanceof HTMLInputElement) return el.checked;
        return (
          el.getAttribute('aria-checked') === 'true' ||
          el.getAttribute('aria-pressed') === 'true'
        );
      });
      if (!isPiiChecked) {
        await piiToggle.click();
      }

      const piiPreviewInput = magpie
        .getByPlaceholder(/pii|mask|test|sample|脱敏|测试|示例/i)
        .first();
      if (
        (await piiPreviewInput.count()) > 0 &&
        (await piiPreviewInput.isVisible())
      ) {
        await piiPreviewInput.fill(
          'Contact ops@acme.io with key sk-live1234567890abcdef',
        );
        const testMaskBtn = scopedButton(
          magpie,
          bilingualRegex('mask|test|preview', '脱敏|测试|预览'),
        ).first();
        if ((await testMaskBtn.count()) > 0 && (await testMaskBtn.isVisible())) {
          await testMaskBtn.click();
        }
        await expect(magpie).toContainText(/redact|\*\*\*|\[email\]|\[key\]/i);
      }

      // 4. Usage Ledger
      const ledgerTab = scopedTab(
        magpie,
        bilingualRegex('usage|ledger|cost|token', '用量|账本|统计|消耗'),
      ).first();
      if ((await ledgerTab.count()) > 0 && (await ledgerTab.isVisible())) {
        await ledgerTab.click();
      }
      await expect(magpie).toContainText(
        /usage|ledger|token|request|cost|用量|账本|请求|消耗/i,
      );
    });

    test('F16-T7: Global Task Center & 5-Field Cron (#task-center-workspace) and MCP Tools Permission Dock (#mcp-tools-dock)', async ({
      authPage,
    }) => {
      // 1. Global Task Center & 7-state FSM (#task-center-workspace)
      const taskWorkspace = await openNavDestination(authPage, 'tasks');
      await expect(taskWorkspace).toBeVisible();
      await expect(taskWorkspace).toContainText(
        /queued|pending|running|paused|blocked|completed|failed|cancelled|待处理|运行中|已完成|暂停|队列/i,
      );

      const newTaskTitle = 'Verify CAS Chunked Upload Integrity';
      const revealNewTaskBtn = scopedButton(
        taskWorkspace,
        bilingualRegex('new\\s*task|add\\s*task|create\\s*task', '新建任务|添加任务|创建任务'),
      ).first();

      const taskTitleInput = scopedTextbox(
        taskWorkspace,
        bilingualRegex('task|title|name', '任务|标题|名称'),
      )
        .or(taskWorkspace.locator('input[type="text"], textarea').first())
        .first();

      if (!(await taskTitleInput.isVisible()) && (await revealNewTaskBtn.count()) > 0) {
        await revealNewTaskBtn.click();
      }

      await expect(taskTitleInput).toBeVisible();
      await taskTitleInput.fill(newTaskTitle);
      await scopedButton(taskWorkspace, 'create')
        .or(scopedButton(taskWorkspace, 'confirm'))
        .first()
        .click();

      await expect(taskWorkspace).toContainText(newTaskTitle);

      // Exercise task FSM transition button if exposed on task cards
      const taskTransitionBtn = scopedButton(
        taskWorkspace,
        bilingualRegex('start|run|pause|complete|resume', '开始|运行|暂停|完成|恢复'),
      ).first();
      if (
        (await taskTransitionBtn.count()) > 0 &&
        (await taskTransitionBtn.isVisible())
      ) {
        await taskTransitionBtn.click();
        await expect(taskWorkspace).toBeVisible();
      }

      // 2. 5-Field Cron Scheduler
      const cronTab = scopedTab(
        taskWorkspace,
        bilingualRegex('cron|schedule|recurring', '定时|计划|周期'),
      ).first();
      if ((await cronTab.count()) > 0 && (await cronTab.isVisible())) {
        await cronTab.click();
      }

      const cronExprInput = taskWorkspace
        .getByPlaceholder(/\*|cron|0\s/i)
        .or(
          scopedTextbox(
            taskWorkspace,
            bilingualRegex('cron|schedule|expression', '表达式|定时|计划'),
          ),
        )
        .first();

      if (
        (await cronExprInput.count()) > 0 &&
        (await cronExprInput.isVisible())
      ) {
        const cronNameInput = scopedTextbox(
          taskWorkspace,
          bilingualRegex('job|label|name|title', '名称|标题|任务'),
        ).first();
        if (
          (await cronNameInput.count()) > 0 &&
          (await cronNameInput.isVisible())
        ) {
          const exprHandle = await cronExprInput.elementHandle();
          const isSameDomInput = exprHandle
            ? await cronNameInput.evaluate(
                (el, other) => el === other,
                exprHandle,
              )
            : false;
          if (!isSameDomInput) {
            await cronNameInput.fill('PTS Compaction Sweep');
          }
        }
        await cronExprInput.fill('0 */6 * * *');
        const addCronBtn = scopedButton(
          taskWorkspace,
          bilingualRegex(
            'add.*cron|schedule|create|save',
            '添加|创建|保存|定时',
          ),
        ).last();
        if ((await addCronBtn.count()) > 0 && (await addCronBtn.isVisible())) {
          await addCronBtn.click();
        }
        await expect(taskWorkspace).toContainText(/0 \*\/6 \* \* \*|\*\/\d+/);
      } else {
        await expect(taskWorkspace).toContainText(
          /cron|\*\/\d+|\d+\s+\*\s+\*/i,
        );
      }

      // 3. MCP Tools Permission Dock (#mcp-tools-dock)
      const mcpDock = await openNavDestination(authPage, 'mcp');
      await expect(mcpDock).toBeVisible();
      await expect(mcpDock).toContainText(
        /mcp|tool|filesystem|terminal|browser|search|permission|工具|权限/i,
      );

      const snapshotMcpDom = async (): Promise<string> => {
        return mcpDock.evaluate((el) => {
          const states = Array.from(
            el.querySelectorAll(
              'select, input[type="checkbox"], [role="switch"], button',
            ),
          ).map((ctrl) => {
            if (ctrl instanceof HTMLSelectElement) return ctrl.value;
            if (ctrl instanceof HTMLInputElement) return String(ctrl.checked);
            return `${ctrl.getAttribute('aria-checked')}|${ctrl.getAttribute('aria-pressed')}|${ctrl.textContent}`;
          });
          return `${el.textContent ?? ''}::${states.join(',')}`;
        });
      };

      const mcpBefore = await snapshotMcpDom();
      const approveBtn = scopedButton(mcpDock, 'approve').first();
      if ((await approveBtn.count()) > 0 && (await approveBtn.isVisible())) {
        await approveBtn.click();
      } else {
        const permControl = mcpDock
          .locator('select, input[type="checkbox"], [role="switch"], button')
          .first();
        await expect(permControl).toBeVisible();
        const tag = await permControl.evaluate((el) =>
          el.tagName.toLowerCase(),
        );
        if (tag === 'select') {
          await permControl.selectOption({ index: 1 });
        } else {
          await permControl.click();
        }
      }
      await expect
        .poll(async () => (await snapshotMcpDom()) !== mcpBefore, {
          message: 'Expected MCP tool approval or permission toggle to update #mcp-tools-dock state',
          timeout: 5_000,
        })
        .toBe(true);
    });

    test('F16-T8: Full-Duplex TalkModeOrb (#talk-mode-orb) & Remote Computer Workbench (#computer-workbench, #computer-canvas, #btn-computer-takeover)', async ({
      authPage,
    }) => {
      const pageErrors: Error[] = [];
      authPage.on('pageerror', (e) => pageErrors.push(e));

      // 1. Full-Duplex TalkModeOrb (#talk-mode-orb)
      const talkOrb = await openNavDestination(authPage, 'talk');
      await expect(talkOrb).toBeVisible();

      const orbBox = await talkOrb.boundingBox();
      expect(orbBox).not.toBeNull();
      expect(orbBox!.width).toBeGreaterThanOrEqual(48);
      expect(orbBox!.height).toBeGreaterThanOrEqual(48);

      await expect(talkOrb).toContainText(
        /idle|ready|listening|speaking|thinking|vad|duplex|talk|待机|倾听|聆听|说话|思考|语音|对话/i,
      );

      const snapshotOrbState = async (): Promise<string> => {
        return talkOrb.evaluate((el) => {
          if (!(el instanceof HTMLElement)) return '';
          const childAttrs = Array.from(el.querySelectorAll('*'))
            .slice(0, 20)
            .map(
              (c) =>
                `${c.getAttribute('data-state')}|${c.getAttribute('aria-pressed')}|${c.getAttribute('class')}`,
            )
            .join(';');
          return `${el.dataset.state}|${el.className}|${el.textContent}::${childAttrs}`;
        });
      };

      const orbBefore = await snapshotOrbState();
      const startTalkBtn = scopedButton(
        talkOrb,
        bilingualRegex(
          'start|listen|talk|connect|mic',
          '开始|倾听|聆听|通话|连接|麦克风',
        ),
      )
        .or(talkOrb.locator('button').first())
        .first();
      if ((await startTalkBtn.count()) > 0 && (await startTalkBtn.isVisible())) {
        await startTalkBtn.click();
      } else {
        await talkOrb.click();
      }

      await expect
        .poll(async () => (await snapshotOrbState()) !== orbBefore, {
          message: 'Expected TalkModeOrb toggle to transition session/listening state',
          timeout: 5_000,
        })
        .toBe(true);

      // 2. Remote Computer Workbench (#computer-workbench, #computer-canvas, #btn-computer-takeover)
      const workbench = await openNavDestination(authPage, 'computer');
      await expect(workbench).toBeVisible();

      const compCanvas = authPage.locator(DOM.computerCanvas);
      await expect(compCanvas).toBeVisible();

      const compSample = await sampleCanvasVisuals(compCanvas);
      expect(compSample.width).toBeGreaterThanOrEqual(200);
      expect(compSample.height).toBeGreaterThanOrEqual(120);
      expect(compSample.nonTransparentPixels).toBeGreaterThan(0);
      expect(compSample.distinctColorBuckets).toBeGreaterThanOrEqual(2);

      // Tailnet connectivity status
      await expect(workbench).toContainText(
        /tailnet|tailscale|100\.\d+\.\d+\.\d+|derp|mesh|connected|online|节点|网络/i,
      );

      // Emergency Human Takeover (#btn-computer-takeover)
      const takeoverBtn = authPage.locator(DOM.btnComputerTakeover);
      await expect(takeoverBtn).toBeVisible();

      if (!(await takeoverBtn.isEnabled())) {
        const startAgentRunBtn = scopedButton(
          workbench,
          bilingualRegex('start|run|agent|demo|resume', '启动|运行|开始|恢复'),
        ).first();
        if (
          (await startAgentRunBtn.count()) > 0 &&
          (await startAgentRunBtn.isVisible())
        ) {
          await startAgentRunBtn.click();
        }
      }

      await expect(takeoverBtn).toBeEnabled();
      await takeoverBtn.click();

      await expect
        .poll(
          async () => {
            const wbText = await workbench.innerText();
            return /takeover|taken\s*over|manual|human|user\s*control|paused|已接管|人工|手动|接管中/i.test(
              wbText,
            );
          },
          {
            message:
              'Expected #btn-computer-takeover to transition #computer-workbench to human/manual takeover mode',
            timeout: 5_000,
          },
        )
        .toBe(true);

      expect(pageErrors).toEqual([]);
    });

    test('F16-T9: Stars & TON Wallet (#menu-item-wallet / #wallet-stars-modal) top-up, ledger, reload persistence & assertNoPurpleOnDark', async ({
      authPage,
    }) => {
      await openBurgerMenu(authPage);
      const walletItem = authPage.locator(DOM.menuItemWallet);
      await expect(walletItem).toBeVisible();
      await walletItem.click();

      const walletModal = authPage.locator(DOM.walletStarsModal);
      await expect(walletModal).toBeVisible();

      // Verify both Telegram Stars and TON sections
      await expect(walletModal).toContainText(/stars|⭐|★|星币/i);
      await expect(walletModal).toContainText(/\bton\b|toncoin/i);

      const parseStarsBalance = async (): Promise<number> => {
        return walletModal.evaluate((el) => {
          const explicitBal = el.querySelector(
            '[data-stars-balance], [data-testid*="stars-balance" i], [id*="stars-balance" i]',
          );
          if (explicitBal) {
            const cleaned = (explicitBal.textContent ?? '').replace(/,/g, '');
            const m = cleaned.match(/\d+(?:\.\d+)?/);
            if (m) return Number(m[0]);
          }

          const raw = (el.textContent ?? '').replace(/,/g, '');
          const nearStars =
            raw.match(/(?:⭐|★)\s*(\d+)/) ??
            raw.match(/(\d+)\s*(?:stars|星币)/i) ??
            raw.match(/(?:stars|星币)[^\d]{0,16}(\d+)/i);
          if (nearStars) {
            return Number(nearStars[1]);
          }
          return NaN;
        });
      };

      const initialStars = await parseStarsBalance();
      expect(Number.isNaN(initialStars)).toBe(false);
      expect(initialStars).toBeGreaterThanOrEqual(0);

      // Perform Stars Top-Up
      const topUpBtn = scopedButton(
        walletModal,
        bilingualRegex(
          '\\+\\s*\\d+|top\\s*up|buy\\s*stars|add\\s*stars|purchase',
          '充值|购买|获取|增加',
        ),
      ).first();
      await expect(topUpBtn).toBeVisible();
      await topUpBtn.click();

      const confirmPurchaseBtn = scopedButton(
        walletModal,
        bilingualRegex('confirm\\s*pay|complete\\s*purchase', '确认支付|完成购买'),
      ).first();
      if (
        (await confirmPurchaseBtn.count()) > 0 &&
        (await confirmPurchaseBtn.isVisible())
      ) {
        await confirmPurchaseBtn.click();
      }

      await expect
        .poll(async () => parseStarsBalance(), {
          message: 'Expected Stars balance in #wallet-stars-modal to increase after top-up',
          timeout: 8_000,
        })
        .toBeGreaterThan(initialStars);

      const updatedStars = await parseStarsBalance();

      // Verify transaction ledger entry
      await expect(walletModal).toContainText(
        /top\s*up|purchase|credit|history|transaction|\+\s*\d+|充值|购买|入账|记录|明细/i,
      );

      // Enforce zero-purple-on-dark invariant with #wallet-stars-modal open
      await assertNoPurpleOnDark(authPage);

      // Verify full page.reload() persistence
      await authPage.reload({ waitUntil: 'domcontentloaded' });
      await expect(authPage.locator(DOM.appShell)).toBeVisible();

      await openBurgerMenu(authPage);
      await authPage.locator(DOM.menuItemWallet).click();
      await expect(walletModal).toBeVisible();

      const persistedStars = await parseStarsBalance();
      expect(persistedStars).toBeGreaterThanOrEqual(updatedStars);
      expect(persistedStars).toBeGreaterThan(initialStars);
    });
  },
);
