import type { Locator, Page } from '@playwright/test';
import {
  assertNoPurpleOnDark,
  bilingualRegex,
  clearClientState,
  DOM,
  expect,
  getBaseUrl,
  loginViaDemo,
  openBurgerMenu,
  openNavDestination,
  openRightInspector,
  resetTestServer,
  scopedButton,
  scopedMenuItem,
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

interface E2eWindowCryptoProbe {
  __e2eWebCryptoAlgos?: string[];
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

async function selectCallableDirectPeerChat(page: Page): Promise<Locator> {
  if (!(await page.locator(DOM.chatList).isVisible())) {
    await openNavDestination(page, 'chats');
  }

  const allFolderTab = page
    .locator(`${DOM.chatFolderTabs} [data-folder-id="all"]`)
    .first();
  if ((await allFolderTab.count()) > 0 && (await allFolderTab.isVisible())) {
    await allFolderTab.click();
  }

  const chatList = page.locator(DOM.chatList);
  await expect(chatList).toBeVisible();
  const rows = chatList.locator(DOM.chatRow);
  const count = await rows.count();
  const maxScan = Math.min(count, 12);

  for (let i = 0; i < maxScan; i++) {
    const row = rows.nth(i);
    if (!(await row.isVisible())) continue;
    const label = (await row.innerText()).trim();
    if (
      /botfather|\bbot\b|saved messages|收藏夹|已保存消息|channel|频道|supergroup|forum|群/i.test(
        label,
      )
    ) {
      continue;
    }

    const selected = await selectChat(page, i);
    const audioBtn = page.locator(DOM.btnStartAudioCall);
    const videoBtn = page.locator(DOM.btnStartVideoCall);
    const statusText = (await page.locator(DOM.chatHeaderStatus).innerText()).trim();

    if (
      !/subscriber|订阅|members|成员/i.test(statusText) &&
      (await audioBtn.isVisible()) &&
      (await audioBtn.isEnabled()) &&
      (await videoBtn.isVisible())
    ) {
      return selected;
    }
  }

  // Fallback: open #modal-contacts and select or add a direct human contact
  await openBurgerMenu(page);
  await page.locator(DOM.menuItemContacts).click();
  const contactsModal = page.locator(DOM.modalContacts);
  await expect(contactsModal).toBeVisible();

  const existingContact = contactsModal
    .locator('[role="option"], [data-peer-id], [data-user-id], li button')
    .filter({ hasNotText: /botfather|\bbot\b/i })
    .first();

  if (
    (await existingContact.count()) > 0 &&
    (await existingContact.isVisible())
  ) {
    await existingContact.click();
  } else {
    const addBtn = scopedButton(
      contactsModal,
      bilingualRegex('add\\s*contact|new\\s*contact', '添加联系人|新建联系人'),
    ).first();
    if ((await addBtn.count()) > 0 && (await addBtn.isVisible())) {
      await addBtn.click();
    }
    const inputs = contactsModal.locator(
      'input[type="text"]:not([placeholder*="search" i]):not([aria-label*="search" i]):not([placeholder*="搜索"]):not([aria-label*="搜索"]), input[type="tel"]',
    );
    if ((await inputs.count()) >= 1) {
      await inputs.nth(0).fill('Elena Rostova');
    }
    if ((await inputs.count()) >= 2) {
      await inputs.nth(1).fill('+14155550142');
    }
    await scopedButton(contactsModal, 'confirm').last().click();
  }

  if (await contactsModal.isVisible()) {
    await page.keyboard.press('Escape');
  }

  await expect(page.locator(DOM.btnStartAudioCall)).toBeVisible();
  await expect(page.locator(DOM.btnStartAudioCall)).toBeEnabled();
  await expect(page.locator(DOM.btnStartVideoCall)).toBeVisible();
  return rows.first();
}

async function selectCallableGroupChat(page: Page): Promise<void> {
  if (!(await page.locator(DOM.chatList).isVisible())) {
    await openNavDestination(page, 'chats');
  }

  const rows = page.locator(DOM.chatList).locator(DOM.chatRow);
  const count = await rows.count();
  for (let i = 0; i < Math.min(count, 12); i++) {
    await selectChat(page, i);
    const statusText = (await page.locator(DOM.chatHeaderStatus).innerText()).trim();
    const audioBtn = page.locator(DOM.btnStartAudioCall);
    const videoBtn = page.locator(DOM.btnStartVideoCall);
    const callable =
      ((await audioBtn.isVisible()) && (await audioBtn.isEnabled())) ||
      ((await videoBtn.isVisible()) && (await videoBtn.isEnabled()));

    if (/members|成员/i.test(statusText) && callable) {
      return;
    }
  }

  // Fallback: create a fresh Group chat via #modal-create-group
  await openBurgerMenu(page);
  await page.locator(DOM.menuItemNewGroup).click();
  const modal = page.locator(DOM.modalCreateGroup);
  await expect(modal).toBeVisible();

  const peerRows = modal.locator(
    'input[type="checkbox"], [role="checkbox"], [role="option"], [data-peer-id], [data-user-id], li button',
  );
  const pCount = await peerRows.count();
  for (let i = 0; i < Math.min(pCount, 2); i++) {
    if (await peerRows.nth(i).isVisible()) {
      await peerRows.nth(i).click();
    }
  }

  const explicitTitleInput = scopedTextbox(
    modal,
    bilingualRegex(
      'group\\s*name|group\\s*title|title|name',
      '群组名称|群名称|标题|名称',
    ),
  ).filter({
    hasNot: modal.locator(
      '[placeholder*="search" i], [aria-label*="search" i], [placeholder*="搜索"], [aria-label*="搜索"]',
    ),
  });

  if (
    (await explicitTitleInput.count()) === 0 ||
    !(await explicitTitleInput.first().isVisible())
  ) {
    const nextBtn = scopedButton(modal, 'next').first();
    if ((await nextBtn.count()) > 0 && (await nextBtn.isVisible())) {
      await nextBtn.click();
    }
  }

  const nonSearchInput = modal.locator(
    'input[type="text"]:not([placeholder*="search" i]):not([aria-label*="search" i]):not([placeholder*="搜索"]):not([aria-label*="搜索"])',
  );
  const titleInput =
    (await explicitTitleInput.count()) > 0 &&
    (await explicitTitleInput.first().isVisible())
      ? explicitTitleInput.first()
      : nonSearchInput.first();

  await expect(titleInput).toBeVisible();
  await titleInput.fill('E2E VoIP Standup');
  await scopedButton(modal, 'confirm').last().click();

  await expect(modal).toBeHidden();
  await expect(page.locator(DOM.chatHeaderTitle)).toContainText(
    'E2E VoIP Standup',
  );
}

function locateEndCallButton(overlay: Locator): Locator {
  return scopedButton(
    overlay,
    bilingualRegex('end|hang\\s*up|leave|decline', '挂断|结束|离开'),
  )
    .or(
      overlay.locator(
        'button[id*="end" i], button[id*="hang" i], button[data-testid*="end" i], button[data-testid*="hang" i], button[title*="end" i], button[title*="挂断" i]',
      ),
    )
    .first();
}

test.describe(
  'F15 — WebRTC Audio/Video Calls, Screen Share & WebCrypto E2EE Secret Chats',
  () => {
    test('F15-T1: #btn-start-audio-call opens #call-overlay with 4-emoji E2EE key fingerprint & mic mute toggle', async ({
      authPage,
    }) => {
      const pageErrors: Error[] = [];
      authPage.on('pageerror', (e) => pageErrors.push(e));

      await selectCallableDirectPeerChat(authPage);
      const peerName = (
        await authPage.locator(DOM.chatHeaderTitle).innerText()
      ).trim();
      expect(peerName.length).toBeGreaterThan(0);

      await authPage.locator(DOM.btnStartAudioCall).click();

      const overlay = authPage.locator(DOM.callOverlay);
      await expect(overlay).toBeVisible();

      // Await connected/active signaling state
      await expect
        .poll(
          async () => {
            const text = await overlay.innerText();
            return (
              /\b\d{1,2}:\d{2}\b/.test(text) ||
              /connected|active|encrypted|e2ee|通话中|已连接|加密/i.test(text)
            );
          },
          {
            message:
              'Expected #call-overlay to transition via CallSignal + peer responder to connected state',
            timeout: 8_000,
          },
        )
        .toBe(true);

      // Verify 4-emoji E2EE key verification fingerprint via unique non-button text nodes
      const readFingerprintEmojis = async (): Promise<string[]> => {
        return authPage.evaluate(() => {
          const emojiRe = /\p{Extended_Pictographic}/gu;
          const scopes = [
            document.querySelector('#call-overlay'),
            ...Array.from(
              document.querySelectorAll(
                '[role="dialog"], [role="tooltip"], [data-popover]',
              ),
            ).filter((el) => el.querySelector('#chat-list') === null),
          ].filter((s): s is Element => s !== null);

          for (const scope of scopes) {
            const explicitFp = scope.querySelector(
              '[id*="fingerprint" i], [data-testid*="fingerprint" i], [aria-label*="fingerprint" i], [title*="指纹" i], [data-fingerprint]',
            );
            if (explicitFp) {
              const explicitMatches = Array.from(
                (explicitFp.textContent ?? '').matchAll(emojiRe),
              ).map((m) => m[0]);
              if (explicitMatches.length >= 4) {
                return explicitMatches;
              }
            }
          }

          const collected: string[] = [];
          for (const scope of scopes) {
            const walker = document.createTreeWalker(
              scope,
              NodeFilter.SHOW_TEXT,
            );
            let node = walker.nextNode();
            while (node) {
              const parent = node.parentElement;
              if (parent) {
                const st = window.getComputedStyle(parent);
                const visible =
                  st.display !== 'none' && st.visibility !== 'hidden';
                const insideActionBtn =
                  parent.closest('button, [role="button"]') !== null;
                if (visible && !insideActionBtn) {
                  const matches = Array.from(
                    (node.textContent ?? '').matchAll(emojiRe),
                  ).map((m) => m[0]);
                  collected.push(...matches);
                }
              }
              node = walker.nextNode();
            }
          }
          return collected;
        });
      };

      let fpEmojis = await readFingerprintEmojis();
      if (fpEmojis.length < 4) {
        const lockBadge = overlay
          .locator(
            'button[aria-label*="encrypt" i], button[aria-label*="key" i], button[aria-label*="fingerprint" i], button[aria-label*="加密" i], button[aria-label*="指纹" i], [data-testid*="encrypt" i], [data-testid*="lock" i], [data-testid*="fingerprint" i]',
          )
          .first();
        if ((await lockBadge.count()) > 0 && (await lockBadge.isVisible())) {
          await lockBadge.click();
          await authPage.waitForTimeout(150);
          fpEmojis = await readFingerprintEmojis();
        }
      }
      expect(fpEmojis.length).toBeGreaterThanOrEqual(4);

      // Microphone Mute / Unmute toggle
      const muteBtn = scopedButton(
        overlay,
        bilingualRegex('mute|unmute|mic|microphone', '静音|取消静音|麦克风'),
      )
        .or(
          overlay.locator(
            'button[id*="mute" i], button[id*="mic" i], button[data-testid*="mute" i], button[data-testid*="mic" i], button[title*="mute" i], button[title*="静音" i]',
          ),
        )
        .first();

      await expect(muteBtn).toBeVisible();
      await expect(muteBtn).toBeEnabled();

      const snapshotMuteSig = async (): Promise<string> => {
        return muteBtn.evaluate((el) => {
          if (!(el instanceof HTMLElement)) return '';
          return JSON.stringify({
            ariaPressed: el.getAttribute('aria-pressed'),
            ariaLabel: el.getAttribute('aria-label'),
            title: el.getAttribute('title'),
            dataMuted: el.dataset.muted,
            dataActive: el.dataset.active,
            cls: el.className,
            txt: (el.textContent ?? '').trim(),
          });
        });
      };

      const sigUnmuted = await snapshotMuteSig();
      await muteBtn.click();

      await expect
        .poll(async () => (await snapshotMuteSig()) !== sigUnmuted, {
          message: 'Expected clicking mic mute button to mutate muted state',
          timeout: 5_000,
        })
        .toBe(true);

      const sigMuted = await snapshotMuteSig();
      await muteBtn.click();

      await expect
        .poll(async () => (await snapshotMuteSig()) !== sigMuted, {
          message: 'Expected clicking mic mute button again to unmute',
          timeout: 5_000,
        })
        .toBe(true);

      // Clean hang up
      const endBtn = locateEndCallButton(overlay);
      if ((await endBtn.count()) > 0 && (await endBtn.isVisible())) {
        await endBtn.click();
      }
      expect(pageErrors).toEqual([]);
    });

    test('F15-T2: #btn-start-video-call renders headless Canvas/WebAudio stream fallback & toggles Screen Share', async ({
      authPage,
    }) => {
      const pageErrors: Error[] = [];
      authPage.on('pageerror', (e) => pageErrors.push(e));

      await selectCallableDirectPeerChat(authPage);
      await authPage.locator(DOM.btnStartVideoCall).click();

      const overlay = authPage.locator(DOM.callOverlay);
      await expect(overlay).toBeVisible();

      // Verify headless <video> MediaStream or <canvas> fallback viewport
      await expect
        .poll(
          async () => {
            const videoLoc = overlay.locator('video').first();
            if ((await videoLoc.count()) > 0 && (await videoLoc.isVisible())) {
              const hasStream = await videoLoc.evaluate((el) => {
                if (!(el instanceof HTMLVideoElement)) return false;
                const r = el.getBoundingClientRect();
                if (r.width < 60 || r.height < 45) return false;
                if (
                  el.srcObject instanceof MediaStream &&
                  el.srcObject.getTracks().length >= 1
                ) {
                  return true;
                }
                return el.readyState >= 1 || Boolean(el.currentSrc);
              });
              if (hasStream) return true;
            }

            const canvasLoc = overlay.locator('canvas').first();
            if ((await canvasLoc.count()) > 0 && (await canvasLoc.isVisible())) {
              const sample = await sampleCanvasVisuals(canvasLoc);
              return (
                sample.width >= 60 &&
                sample.height >= 45 &&
                sample.nonTransparentPixels > 0 &&
                sample.distinctColorBuckets >= 2
              );
            }
            return false;
          },
          {
            message:
              'Expected #call-overlay to render active headless video stream or non-blank canvas stage',
            timeout: 8_000,
          },
        )
        .toBe(true);

      // Screen Share toggle
      const screenBtn = scopedButton(
        overlay,
        bilingualRegex(
          'screen|share|present|stop\\s*shar',
          '屏幕|共享|投屏|停止共享|结束投屏',
        ),
      )
        .or(
          overlay.locator(
            'button[id*="screen" i], button[data-testid*="screen" i], button[title*="screen" i], button[title*="共享" i], button[title*="屏幕" i]',
          ),
        )
        .first();

      await expect(screenBtn).toBeVisible();
      await expect(screenBtn).toBeEnabled();

      const snapshotScreenSig = async (): Promise<string> => {
        const btnSig =
          (await screenBtn.count()) > 0
            ? await screenBtn.evaluate((el) => {
                if (!(el instanceof HTMLElement)) return '';
                return JSON.stringify({
                  ariaPressed: el.getAttribute('aria-pressed'),
                  ariaChecked: el.getAttribute('aria-checked'),
                  ariaLabel: el.getAttribute('aria-label'),
                  title: el.getAttribute('title'),
                  sharing: el.dataset.sharing,
                  active: el.dataset.active,
                  cls: el.className,
                  txt: (el.textContent ?? '').trim(),
                });
              })
            : 'unmounted';

        const overlaySig = await overlay.evaluate((ovEl) => {
          const mediaCount = ovEl.querySelectorAll('video, canvas').length;
          const hasShareBadge =
            ovEl.querySelector('[data-screen-share], [data-sharing="true"]') !==
              null ||
            /sharing\s*screen|you\s*are\s*sharing|stop\s*sharing|共享中|正在共享|停止共享|结束投屏/i.test(
              ovEl.textContent ?? '',
            );
          return `${mediaCount}:${String(hasShareBadge)}`;
        });

        return `${btnSig}::${overlaySig}`;
      };

      const sigBeforeShare = await snapshotScreenSig();
      await screenBtn.click();
      await expect(overlay).toBeVisible();

      await expect
        .poll(async () => (await snapshotScreenSig()) !== sigBeforeShare, {
          message: 'Expected Screen Share button click to activate screen sharing in #call-overlay',
          timeout: 6_000,
        })
        .toBe(true);

      const sigDuringShare = await snapshotScreenSig();
      await screenBtn.click();
      await expect(overlay).toBeVisible();

      await expect
        .poll(async () => (await snapshotScreenSig()) !== sigDuringShare, {
          message: 'Expected clicking Screen Share again to stop screen sharing cleanly',
          timeout: 6_000,
        })
        .toBe(true);

      expect(pageErrors).toEqual([]);
    });

    test('F15-T3: minimizes active call from #call-overlay to #top-call-bar and restores back to #call-overlay', async ({
      authPage,
    }) => {
      await selectCallableDirectPeerChat(authPage);
      const peerName = (
        await authPage.locator(DOM.chatHeaderTitle).innerText()
      ).trim();

      await authPage.locator(DOM.btnStartAudioCall).click();
      const overlay = authPage.locator(DOM.callOverlay);
      await expect(overlay).toBeVisible();

      const minimizeBtn = scopedButton(
        overlay,
        bilingualRegex(
          'minimize|collapse|pip|shrink|back to chat|hide',
          '最小化|收起|悬浮|返回聊天',
        ),
      )
        .or(
          overlay.locator(
            'button[id*="minimize" i], button[data-testid*="minimize" i], button[aria-label*="minimize" i], button[title*="minimize" i], button[title*="最小化" i], button[title*="收起" i]',
          ),
        )
        .first();

      await expect(minimizeBtn).toBeVisible();
      await minimizeBtn.click();

      await expect(overlay).toBeHidden();
      const topCallBar = authPage.locator(DOM.topCallBar);
      await expect(topCallBar).toBeVisible();

      const barText = (await topCallBar.innerText()).trim();
      expect(
        barText.includes(peerName) ||
          /\b\d{1,2}:\d{2}\b|call|通话/i.test(barText),
      ).toBe(true);

      // Verify #middle-column composer remains fully interactive while call is minimized in #top-call-bar
      const liveMsg = await sendTextMessage(
        authPage,
        'Message sent during minimized call F15-T3',
      );
      await expect(liveMsg).toBeVisible();
      await expect(topCallBar).toBeVisible();

      // Restore back to #call-overlay
      const restoreBtn = scopedButton(
        topCallBar,
        bilingualRegex('restore|expand|return|open', '恢复|展开|返回通话'),
      ).first();
      if ((await restoreBtn.count()) > 0 && (await restoreBtn.isVisible())) {
        await restoreBtn.click();
      } else {
        await topCallBar.click();
      }

      await expect(overlay).toBeVisible();
      await expect(locateEndCallButton(overlay)).toBeVisible();
    });

    test('F15-T4: ends call, submits post-call 1-5 star rating, and logs Call history item', async ({
      authPage,
    }) => {
      await selectCallableDirectPeerChat(authPage);

      const messageList = authPage.locator(DOM.messageList);
      const countBefore = await messageList.locator(DOM.messageBubble).count();
      const listTextBefore = (await messageList.innerText()).trim();

      await authPage.locator(DOM.btnStartAudioCall).click();
      const overlay = authPage.locator(DOM.callOverlay);
      await expect(overlay).toBeVisible();

      // Wait briefly so active call connects before hanging up
      await expect
        .poll(
          async () =>
            /\b\d{1,2}:\d{2}\b|connected|active|通话中|已连接/i.test(
              await overlay.innerText(),
            ),
          { timeout: 8_000 },
        )
        .toBe(true);

      const endBtn = locateEndCallButton(overlay);
      await expect(endBtn).toBeVisible();
      await endBtn.click();

      // Locate 5-star post-call rating UI across #call-overlay, [role="dialog"], or newest Call bubble
      const findFifthStarControl = async (): Promise<Locator | null> => {
        const directFifth = authPage
          .locator(
            '[data-rating="5"], [data-star="5"], [data-value="5"], button[aria-label*="5 star" i], button[aria-label*="star 5" i], button[aria-label*="5星" i], button[aria-label*="五星" i]',
          )
          .first();
        if ((await directFifth.count()) > 0 && (await directFifth.isVisible())) {
          return directFifth;
        }

        const ratingContainers = authPage.locator(
          '#call-overlay, [role="dialog"], [id*="rating" i], [data-testid*="rating" i], #message-list [data-testid="message-bubble"]',
        );
        const cCount = await ratingContainers.count();
        for (let i = cCount - 1; i >= 0; i--) {
          const cont = ratingContainers.nth(i);
          if (!(await cont.isVisible())) continue;
          const starBtns = cont
            .locator('button, [role="radio"]')
            .filter({ hasText: /^[★☆⭐1-5]$/ });
          if ((await starBtns.count()) >= 5) {
            return starBtns.nth(4);
          }
        }
        return null;
      };

      await expect
        .poll(async () => (await findFifthStarControl()) !== null, {
          message: 'Expected post-call 1-5 star rating controls to appear after ending call',
          timeout: 8_000,
        })
        .toBe(true);

      const fifthStar = await findFifthStarControl();
      expect(fifthStar).not.toBeNull();
      await fifthStar!.click();

      const ratingDialog = authPage
        .locator(
          '#call-overlay, [role="dialog"], [id*="rating" i], [data-testid*="rating" i]',
        )
        .filter({ hasNot: authPage.locator(DOM.chatList) })
        .first();
      if (await ratingDialog.isVisible()) {
        const submitRatingBtn = scopedButton(
          ratingDialog,
          bilingualRegex(
            'submit|rate|send|done|confirm',
            '提交|评价|评分|确定|完成',
          ),
        ).last();
        if (
          (await submitRatingBtn.count()) > 0 &&
          (await submitRatingBtn.isVisible())
        ) {
          await submitRatingBtn.click();
        }
      }

      await expect(overlay).toBeHidden();
      await expect(authPage.locator(DOM.topCallBar)).toBeHidden();

      await expect
        .poll(
          async () => {
            const countAfter = await messageList
              .locator(DOM.messageBubble)
              .count();
            if (countAfter > countBefore) return true;
            const listTextAfter = (await messageList.innerText()).trim();
            return (
              listTextAfter !== listTextBefore &&
              /\bcall\b|通话|★|5\s*\/\s*5|rated/i.test(listTextAfter)
            );
          },
          {
            message: 'Expected completed call and rating to appear in #message-list history',
            timeout: 6_000,
          },
        )
        .toBe(true);
    });

    test('F15-T5: renders Group Audio/Video Call grid in #call-overlay and passes assertNoPurpleOnDark', async ({
      authPage,
    }) => {
      await selectCallableGroupChat(authPage);

      const videoCallBtn = authPage.locator(DOM.btnStartVideoCall);
      if ((await videoCallBtn.isVisible()) && (await videoCallBtn.isEnabled())) {
        await videoCallBtn.click();
      } else {
        const audioCallBtn = authPage.locator(DOM.btnStartAudioCall);
        await expect(audioCallBtn).toBeVisible();
        await audioCallBtn.click();
      }

      const overlay = authPage.locator(DOM.callOverlay);
      await expect(overlay).toBeVisible();

      // Verify Group Call participant grid / stage
      await expect
        .poll(
          async () =>
            overlay.evaluate((el) => {
              const tiles = el.querySelectorAll(
                '[data-testid*="participant" i], [data-participant-id], [class*="grid" i] > *, [class*="tile" i], [class*="participant" i], video, canvas',
              );
              const hasGroupCopy =
                /participant|member|speaking|voice chat|group call|成员|参与者|语音聊天|群组通话|通话/i.test(
                  el.textContent ?? '',
                );
              return tiles.length >= 1 && (hasGroupCopy || tiles.length >= 2);
            }),
          {
            message: 'Expected Group Call participant grid inside #call-overlay',
            timeout: 8_000,
          },
        )
        .toBe(true);

      // Verify zero purple/violet hues on dark theme while #call-overlay is mounted
      await assertNoPurpleOnDark(authPage);

      const endBtn = locateEndCallButton(overlay);
      await expect(endBtn).toBeVisible();
      await endBtn.click();
    });

    test('F15-T6: creates WebCrypto E2EE Secret Chat (ECDH + HKDF + AES-256-GCM), inspects key fingerprint, sends encrypted message & sets self-destruct TTL', async ({
      page,
      request,
    }) => {
      await clearClientState(page);
      await resetTestServer(request);

      // Register transparent SubtleCrypto observer before app loads
      await page.addInitScript(() => {
        const win = window as unknown as E2eWindowCryptoProbe;
        win.__e2eWebCryptoAlgos = [];
        const recordAlgo = (alg: unknown): void => {
          if (!alg) return;
          const name =
            typeof alg === 'string'
              ? alg
              : typeof alg === 'object' && 'name' in alg
                ? String((alg as { name: unknown }).name)
                : '';
          if (name && win.__e2eWebCryptoAlgos) {
            win.__e2eWebCryptoAlgos.push(name.toUpperCase());
          }
        };

        const subtle = window.crypto?.subtle;
        if (subtle) {
          const origGenerateKey = subtle.generateKey.bind(subtle);
          subtle.generateKey = ((...args: Parameters<SubtleCrypto['generateKey']>) => {
            recordAlgo(args[0]);
            return origGenerateKey(...args);
          }) as SubtleCrypto['generateKey'];

          const origImportKey = subtle.importKey.bind(subtle);
          subtle.importKey = ((...args: Parameters<SubtleCrypto['importKey']>) => {
            recordAlgo(args[2]);
            return origImportKey(...args);
          }) as SubtleCrypto['importKey'];

          const origDeriveKey = subtle.deriveKey.bind(subtle);
          subtle.deriveKey = ((...args: Parameters<SubtleCrypto['deriveKey']>) => {
            recordAlgo(args[0]);
            recordAlgo(args[2]);
            return origDeriveKey(...args);
          }) as SubtleCrypto['deriveKey'];

          const origDeriveBits = subtle.deriveBits.bind(subtle);
          subtle.deriveBits = ((...args: Parameters<SubtleCrypto['deriveBits']>) => {
            recordAlgo(args[0]);
            return origDeriveBits(...args);
          }) as SubtleCrypto['deriveBits'];

          const origEncrypt = subtle.encrypt.bind(subtle);
          subtle.encrypt = ((...args: Parameters<SubtleCrypto['encrypt']>) => {
            recordAlgo(args[0]);
            return origEncrypt(...args);
          }) as SubtleCrypto['encrypt'];

          const origDecrypt = subtle.decrypt.bind(subtle);
          subtle.decrypt = ((...args: Parameters<SubtleCrypto['decrypt']>) => {
            recordAlgo(args[0]);
            return origDecrypt(...args);
          }) as SubtleCrypto['decrypt'];
        }
      });

      await page.goto(`${getBaseUrl()}/`, { waitUntil: 'domcontentloaded' });
      await loginViaDemo(page);
      await selectCallableDirectPeerChat(page);

      const secretTriggerPattern = bilingualRegex(
        'secret\\s*chat|start\\s*secret|encrypted\\s*chat|new\\s*secret',
        '加密聊天|私密聊天|发起加密|新建加密',
      );

      let startedSecretChat = false;

      // Path A: #right-column profile action
      const rightCol = await openRightInspector(page);
      const rightSecretBtn = scopedButton(rightCol, secretTriggerPattern)
        .or(scopedMenuItem(rightCol, secretTriggerPattern))
        .first();
      if (
        (await rightSecretBtn.count()) > 0 &&
        (await rightSecretBtn.isVisible())
      ) {
        await rightSecretBtn.click();
        startedSecretChat = true;
      }

      // Path B: #btn-chat-more header menu
      if (!startedSecretChat && (await page.locator(DOM.btnChatMore).isVisible())) {
        await page.locator(DOM.btnChatMore).click();
        const menu = page
          .locator('[role="menu"], [data-testid="context-menu"]')
          .first();
        if (await menu.isVisible()) {
          const item = scopedMenuItem(menu, secretTriggerPattern).first();
          if ((await item.count()) > 0 && (await item.isVisible())) {
            await item.click();
            startedSecretChat = true;
          } else {
            await page.keyboard.press('Escape');
          }
        }
      }

      const pickPeerInModalIfShown = async (): Promise<void> => {
        const pickerDialog = page
          .locator('[role="dialog"]')
          .filter({ hasNot: page.locator(DOM.chatList) })
          .first();
        if (await pickerDialog.isVisible()) {
          const firstPeer = pickerDialog
            .locator('[role="option"], [data-peer-id], [data-user-id], li button')
            .filter({ hasNotText: /botfather|\bbot\b/i })
            .first();
          if ((await firstPeer.count()) > 0 && (await firstPeer.isVisible())) {
            await firstPeer.click();
          }
        }
      };

      // Path C: #btn-new-chat-fab
      if (
        !startedSecretChat &&
        (await page.locator(DOM.btnNewChatFab).isVisible())
      ) {
        await page.locator(DOM.btnNewChatFab).click();
        const fabItem = scopedMenuItem(page, secretTriggerPattern).first();
        if ((await fabItem.count()) > 0 && (await fabItem.isVisible())) {
          await fabItem.click();
          await pickPeerInModalIfShown();
          startedSecretChat = true;
        } else {
          await page.keyboard.press('Escape');
        }
      }

      // Path D: Burger Menu drawer (also handling contact picker modal if opened)
      if (!startedSecretChat) {
        const drawer = await openBurgerMenu(page);
        const drawerSecret = scopedMenuItem(drawer, secretTriggerPattern).first();
        await expect(drawerSecret).toBeVisible();
        await drawerSecret.click();
        await pickPeerInModalIfShown();
      }

      // Confirm start-secret-chat dialog if shown
      const confirmDialog = page
        .locator('[role="dialog"], [role="alertdialog"]')
        .filter({ hasNot: page.locator(DOM.chatList) })
        .first();
      if (await confirmDialog.isVisible()) {
        const confirmBtn = scopedButton(confirmDialog, 'confirm').last();
        if ((await confirmBtn.count()) > 0 && (await confirmBtn.isVisible())) {
          await confirmBtn.click();
        }
      }

      // Verify Secret Chat E2EE active indicator
      await expect
        .poll(
          async () => {
            const headerTxt = await page.locator(DOM.chatHeader).innerText();
            const inspectorTxt = (await page.locator(DOM.rightColumn).isVisible())
              ? await page.locator(DOM.rightColumn).innerText()
              : '';
            const msgListTxt = await page.locator(DOM.messageList).innerText();
            return /secret|e2ee|end-to-end|aes-256|ecdh|🔒|加密|私密|端到端/i.test(
              `${headerTxt} ${inspectorTxt} ${msgListTxt}`,
            );
          },
          {
            message: 'Expected Secret Chat E2EE indicator in #chat-header, #right-column, or #message-list',
            timeout: 8_000,
          },
        )
        .toBe(true);

      // Inspect E2EE Key Fingerprint
      const inspector = await openRightInspector(page);
      const fpTrigger = scopedButton(
        inspector,
        bilingualRegex(
          'fingerprint|encryption\\s*key|verify\\s*key',
          '密钥指纹|加密密钥|验证密钥|指纹',
        ),
      ).first();
      if ((await fpTrigger.count()) > 0 && (await fpTrigger.isVisible())) {
        await fpTrigger.click();
      }

      const hasKeyFingerprint = await page.evaluate(() => {
        const scopes = [
          document.querySelector('#right-column'),
          document.querySelector('#chat-header'),
          ...Array.from(document.querySelectorAll('[role="dialog"]')).filter(
            (d) => d.querySelector('#chat-list') === null,
          ),
        ].filter((s): s is Element => s !== null);

        const nonBtnPieces: string[] = [];
        for (const scope of scopes) {
          const walker = document.createTreeWalker(
            scope,
            NodeFilter.SHOW_TEXT,
          );
          let node = walker.nextNode();
          while (node) {
            const parent = node.parentElement;
            if (parent) {
              const st = window.getComputedStyle(parent);
              const visible =
                st.display !== 'none' && st.visibility !== 'hidden';
              const insideExplicitFp =
                parent.closest(
                  '[data-testid*="fingerprint" i], [id*="fingerprint" i], [aria-label*="fingerprint" i]',
                ) !== null;
              const insideBtn =
                parent.closest('button, [role="button"]') !== null;
              if (visible && (!insideBtn || insideExplicitFp)) {
                nonBtnPieces.push(node.textContent ?? '');
              }
            }
            node = walker.nextNode();
          }
        }

        const nonBtnText = nonBtnPieces.join(' ');
        const hasHexBlocks = /[0-9a-f]{4}[\s:-][0-9a-f]{4}/i.test(nonBtnText);
        const emojiCount = Array.from(
          nonBtnText.matchAll(/\p{Extended_Pictographic}/gu),
        ).length;
        const hasKeyGrid = scopes.some(
          (s) =>
            s.querySelector(
              '[data-testid*="fingerprint" i], [id*="fingerprint" i], canvas',
            ) !== null,
        );
        return (
          hasHexBlocks ||
          emojiCount >= 4 ||
          (hasKeyGrid && /fingerprint|encryption\s*key|ecdh|aes|指纹|加密密钥/i.test(nonBtnText))
        );
      });
      expect(hasKeyFingerprint).toBe(true);

      // Close any fingerprint modal before sending message
      const openFpModal = page
        .locator('[role="dialog"]')
        .filter({ hasNot: page.locator(DOM.chatList) })
        .first();
      if (await openFpModal.isVisible()) {
        await page.keyboard.press('Escape');
      }

      // Exchange encrypted E2EE message
      const secretPlaintext = 'E2EE-Oak-Cipher-7749';
      const secretBubble = await sendTextMessage(page, secretPlaintext);
      await expect(secretBubble).toBeVisible();
      await expect(secretBubble).toContainText(secretPlaintext);

      // Fail-closed WebCrypto verification: require real SubtleCrypto invocation (ECDH / HKDF / AES-GCM)
      await expect
        .poll(
          async () =>
            page.evaluate(() => {
              const win = window as unknown as E2eWindowCryptoProbe;
              const algos = win.__e2eWebCryptoAlgos ?? [];
              return algos.some((a) => /ECDH|HKDF|AES-GCM/i.test(a));
            }),
          {
            message:
              'Expected Secret Chat E2EE to invoke WebCrypto SubtleCrypto (ECDH / HKDF / AES-GCM)',
            timeout: 6_000,
          },
        )
        .toBe(true);

      // Configure Self-Destruct TTL Timer
      const ttlPattern = bilingualRegex(
        'self-destruct|auto-delete|timer|\\bttl\\b',
        '阅后即焚|自动删除|定时销毁|自毁',
      );
      let openedTtlPicker = false;

      const directTtlBtn = page
        .locator(
          'button[id*="ttl" i], button[data-testid*="ttl" i], button[aria-label*="timer" i], button[aria-label*="destruct" i], button[title*="ttl" i], button[title*="阅后即焚" i], button[title*="销毁" i]',
        )
        .or(scopedButton(page.locator(DOM.chatHeader), ttlPattern))
        .or(scopedButton(inspector, ttlPattern))
        .first();

      if ((await directTtlBtn.count()) > 0 && (await directTtlBtn.isVisible())) {
        await directTtlBtn.click();
        openedTtlPicker = true;
      } else if (await page.locator(DOM.btnChatMore).isVisible()) {
        await page.locator(DOM.btnChatMore).click();
        const moreMenu = page
          .locator('[role="menu"], [data-testid="context-menu"]')
          .first();
        if (await moreMenu.isVisible()) {
          const ttlMenuItem = scopedMenuItem(moreMenu, ttlPattern).first();
          if (
            (await ttlMenuItem.count()) > 0 &&
            (await ttlMenuItem.isVisible())
          ) {
            await ttlMenuItem.click();
            openedTtlPicker = true;
          }
        }
      }

      expect(openedTtlPicker).toBe(true);

      const ttlPresetOption = page
        .locator('[role="menuitem"], [role="option"], [role="radio"], button, label')
        .filter({
          hasText:
            /^(?:5\s*s|10\s*s|15\s*s|30\s*s|1\s*m|5\s*sec(?:onds?)?|10\s*sec(?:onds?)?|30\s*sec(?:onds?)?|1\s*min(?:ute)?|5\s*秒|10\s*秒|15\s*秒|30\s*秒|1\s*分钟)$/i,
        })
        .first();

      if (
        (await ttlPresetOption.count()) > 0 &&
        (await ttlPresetOption.isVisible())
      ) {
        await ttlPresetOption.click();
      } else {
        const selectEl = page
          .locator('#right-column select, #chat-header select, [role="dialog"] select')
          .first();
        if ((await selectEl.count()) > 0 && (await selectEl.isVisible())) {
          await selectEl.selectOption({ index: 1 });
        }
      }

      const ttlDialog = page
        .locator('[role="dialog"]')
        .filter({ hasNot: page.locator(DOM.chatList) })
        .first();
      if (await ttlDialog.isVisible()) {
        const saveTtlBtn = scopedButton(ttlDialog, 'confirm').last();
        if ((await saveTtlBtn.count()) > 0 && (await saveTtlBtn.isVisible())) {
          await saveTtlBtn.click();
        }
      }

      // Use message copy with zero digits and zero 'ttl'/'s'/'m' tokens so it can never self-match TTL regex
      const ttlPlaintext = 'Confidential-Oak-Ciphertext';
      const ttlMsg = await sendTextMessage(page, ttlPlaintext);
      await expect(ttlMsg).toBeVisible();

      await expect
        .poll(
          async () => {
            const hasAttrMarker = await page.evaluate(() => {
              return (
                document.querySelector(
                  '[data-ttl]:not([data-ttl="0"]):not([data-ttl="off"]), [data-self-destruct="true"], [data-testid*="ttl" i]',
                ) !== null
              );
            });
            if (hasAttrMarker) return true;

            const combined = [
              await page.locator(DOM.chatHeader).innerText(),
              await page.locator(DOM.messageList).innerText(),
            ]
              .join(' ')
              .split(ttlPlaintext)
              .join(' ')
              .replace(/\b\d{1,2}:\d{2}(?:\s*[AP]M)?\b/gi, ' ');

            return /\b\d+\s*(?:s|sec|seconds?|m|min|minutes?|秒|分钟?)\b|self-destruct|auto-delete|阅后即焚|自动删除|定时销毁|自毁|⏱|🔥/i.test(
              combined,
            );
          },
          {
            message: 'Expected active self-destruct TTL countdown/badge after configuring TTL',
            timeout: 6_000,
          },
        )
        .toBe(true);
    });
  },
);
