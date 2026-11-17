import type { Locator, Page } from '@playwright/test';
import {
  bilingualRegex,
  BILINGUAL_PATTERNS,
  chatRowById,
  DATA_ATTRS,
  DOM,
  expect,
  loginViaDemo,
  messageBubbleById,
  openBurgerMenu,
  openContextMenuAndClick,
  scopedButton,
  scopedTextbox,
  selectChat,
  sendTextMessage,
  test,
} from '../helpers';

const STRICT_MENU_REGEX = {
  pin: /^(?!.*(?:unpin|取消|移出))(?:.*\bpin\b.*|.*置顶.*)$/is,
  unpin: /unpin|取消置顶/i,
  markRead:
    /^(?!.*(?:unread|未读))(?:.*\bmark\b.*\bread\b.*|.*标(?:记)?为?已读.*)$/is,
  markUnread: /\bunread\b|标(?:记)?为?未读/i,
} as const;

const OUTGOING_DELIVERY_STATUS_SELECTOR = [
  '[data-status="sent"]',
  '[data-status="delivered"]',
  '[data-status="read"]',
  '[data-testid*="check" i]',
  '[data-testid*="status" i]:not([data-status="pending"]):not([data-status="sending"])',
  '[class*="check" i]',
  '[class*="receipt" i]',
  '[aria-label*="sent" i]:not([aria-label*="unsent" i])',
  '[aria-label*="delivered" i]',
  '[aria-label*="read" i]:not([aria-label*="unread" i])',
  '[aria-label*="已发送"]',
  '[aria-label*="已送达"]',
  '[aria-label*="已读"]',
].join(', ');

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

async function ensureScrollableTimeline(
  page: Page,
  minScrollablePx: number,
): Promise<void> {
  const msgList = page.locator(DOM.messageList);
  await expect(msgList).toBeVisible();

  for (let round = 1; round <= 18; round++) {
    const span = await msgList.evaluate(
      (el: Element) => el.scrollHeight - el.clientHeight,
    );
    if (span >= minScrollablePx) {
      return;
    }
    await sendTextMessage(
      page,
      `Timeline vertical spacer #${round}\nLine 2 padding\nLine 3 padding\nLine 4 padding`,
    );
  }

  const finalSpan = await msgList.evaluate(
    (el: Element) => el.scrollHeight - el.clientHeight,
  );
  expect(finalSpan).toBeGreaterThanOrEqual(minScrollablePx);
}

async function pinBubbleDeterministically(
  page: Page,
  bubble: Locator,
): Promise<void> {
  await openContextMenuAndClick(page, bubble, STRICT_MENU_REGEX.pin);
  const confirmDialog = page.locator('[role="dialog"]:visible').first();
  if ((await confirmDialog.count()) > 0) {
    const pinConfirmBtn = scopedButton(confirmDialog, STRICT_MENU_REGEX.pin)
      .or(scopedButton(confirmDialog, BILINGUAL_PATTERNS.confirm))
      .first();
    await expect(pinConfirmBtn).toBeVisible();
    await pinConfirmBtn.click();
  }
}

test.describe('F6 — Virtualized Date-Grouped Tail-Bubble Timeline, Pinned Banner & Read Receipts', () => {
  test('F6-1: Virtualized #message-list sticky date pills and <=900s sender-grouped [160px..480px] bubbles with SVG corner tail', async ({
    authPage,
  }) => {
    await selectWritableChat(authPage);

    const msg1 =
      'Timeline bubble geometry probe #1 — verifying 160px..480px width bounds in stage';
    const msg2 =
      'Timeline bubble geometry probe #2 — verifying <=900s sender group & SVG tail';

    const bubble1 = await sendTextMessage(authPage, msg1);
    const bubble2 = await sendTextMessage(authPage, msg2);

    const id1 = await bubble1.getAttribute(DATA_ATTRS.messageId);
    const id2 = await bubble2.getAttribute(DATA_ATTRS.messageId);
    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    expect(id1).not.toBe(id2);

    const msgList = authPage.locator(DOM.messageList);
    const overflowY = await msgList.evaluate(
      (el: Element) => window.getComputedStyle(el).overflowY,
    );
    expect(['auto', 'scroll', 'overlay']).toContain(overflowY);

    // 1. Sticky Date Group Pill inside #message-list
    const datePillCheck = await msgList.evaluate((listEl: Element) => {
      const dateRe =
        /\b(?:Today|Yesterday|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}|\d{4}[-/]\d{1,2}[-/]\d{1,2})\b|今天|昨天|\d{1,2}月\d{1,2}日/i;
      const nodes = Array.from(
        listEl.querySelectorAll(
          '[data-testid*="date" i], [class*="date" i], time, [role="separator"], div, span',
        ),
      );
      let foundText = false;
      let foundSticky = false;

      for (const node of nodes) {
        if (node.closest('[data-testid="message-bubble"]')) continue;
        const txt = (node.textContent ?? '').trim();
        if (txt.length > 0 && txt.length <= 40 && dateRe.test(txt)) {
          foundText = true;
          let cur: Element | null = node;
          while (cur && cur !== listEl) {
            const pos = window.getComputedStyle(cur).position;
            if (pos === 'sticky' || pos === '-webkit-sticky') {
              foundSticky = true;
              break;
            }
            cur = cur.parentElement;
          }
          if (foundSticky) break;
        }
      }
      return { foundText, foundSticky };
    });

    expect(datePillCheck.foundText).toBe(true);
    expect(datePillCheck.foundSticky).toBe(true);

    // 2. Bubble [160px..480px] width bounds & <=900s sender-grouped SVG tail appendix
    const geometryAndGrouping = await msgList.evaluate(
      (listEl: Element, args: { firstId: string; secondId: string }) => {
        const b1 = listEl.querySelector(
          `[data-testid="message-bubble"][data-message-id="${CSS.escape(args.firstId)}"]`,
        );
        const b2 = listEl.querySelector(
          `[data-testid="message-bubble"][data-message-id="${CSS.escape(args.secondId)}"]`,
        );
        if (!b1 || !b2) {
          return null;
        }

        const resolveBubbleCard = (el: Element): Element => {
          const r = el.getBoundingClientRect();
          if (r.width <= 482) return el;
          const inner = Array.from(el.querySelectorAll('*')).find((child) => {
            const cr = child.getBoundingClientRect();
            const bg = window.getComputedStyle(child).backgroundColor;
            return (
              cr.width >= 158 &&
              cr.width <= 482 &&
              bg !== 'rgba(0, 0, 0, 0)' &&
              bg !== 'transparent'
            );
          });
          return inner ?? el;
        };

        const card1 = resolveBubbleCard(b1);
        const card2 = resolveBubbleCard(b2);
        const rect1 = card1.getBoundingClientRect();
        const rect2 = card2.getBoundingClientRect();

        const explicitTailSvg = b2.querySelector(
          'svg[data-testid*="tail" i], svg[class*="tail" i], svg[class*="appendix" i], [data-testid*="tail" i] svg, [class*="tail" i] svg, [class*="appendix" i] svg',
        );
        const geometricTailSvg = Array.from(b2.querySelectorAll('svg')).find(
          (svg) => {
            if (
              svg.closest(
                '[data-status], [data-testid*="status" i], [data-testid*="check" i], [class*="status" i], [class*="check" i], [class*="receipt" i], [class*="meta" i], [class*="time" i], [aria-label*="sent" i], [aria-label*="delivered" i], [aria-label*="read" i], [aria-label*="已发送"], [aria-label*="已送达"], [aria-label*="已读"]',
              )
            ) {
              return false;
            }
            const sr = svg.getBoundingClientRect();
            if (
              sr.width <= 0 ||
              sr.height <= 0 ||
              sr.width > 18 ||
              sr.height > 20
            ) {
              return false;
            }
            const nearBottom = Math.abs(sr.bottom - rect2.bottom) <= 8;
            const nearLeftOuter =
              Math.abs(sr.left - rect2.left) <= 8 ||
              Math.abs(sr.right - rect2.left) <= 8;
            const nearRightOuter =
              Math.abs(sr.right - rect2.right) <= 8 ||
              Math.abs(sr.left - rect2.right) <= 8;
            return nearBottom && (nearLeftOuter || nearRightOuter);
          },
        );
        const hasTailSvgOnLast =
          explicitTailSvg !== null || geometricTailSvg !== undefined;
        const verticalGap = rect2.top - rect1.bottom;

        return {
          width2: rect2.width,
          hasTailSvgOnLast,
          verticalGap,
        };
      },
      { firstId: id1!, secondId: id2! },
    );

    expect(geometryAndGrouping).not.toBeNull();
    expect(geometryAndGrouping!.width2).toBeGreaterThanOrEqual(159.5);
    expect(geometryAndGrouping!.width2).toBeLessThanOrEqual(480.5);
    expect(geometryAndGrouping!.hasTailSvgOnLast).toBe(true);
    expect(geometryAndGrouping!.verticalGap).toBeLessThanOrEqual(14);
  });

  test('F6-2: 48px bottom stickiness on incoming message vs #btn-scroll-to-bottom FAB when scrolled up', async ({
    authPage,
    openSecondTab,
  }) => {
    const { chatId } = await selectWritableChat(authPage);
    await ensureScrollableTimeline(authPage, 420);

    const tab2 = await openSecondTab();
    await loginViaDemo(tab2);
    await selectChat(tab2, chatId);

    const msgList = authPage.locator(DOM.messageList);
    const scrollFab = authPage.locator(DOM.btnScrollToBottom);

    // Case A: Within 48px of bottom (distanceFromBottom = 24px) -> auto-sticks to bottom
    await msgList.evaluate((el: Element) => {
      el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 24);
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    const msgNearBottom = 'Stickiness near-bottom live arrival #A';
    await sendTextMessage(tab2, msgNearBottom);

    await expect(
      msgList.locator(DOM.messageBubble).filter({ hasText: msgNearBottom }),
    ).toBeVisible();

    await expect
      .poll(async () =>
        msgList.evaluate(
          (el: Element) => el.scrollHeight - el.scrollTop - el.clientHeight,
        ),
      )
      .toBeLessThanOrEqual(48);
    await expect(scrollFab).toBeHidden();

    // Case B: Scrolled far up (scrollTop = 0) -> #btn-scroll-to-bottom FAB appears and reading position is preserved
    await msgList.evaluate((el: Element) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    await expect(scrollFab).toBeVisible();

    const msgWhileScrolledUp = 'Scrolled-up non-hijack arrival #B';
    await sendTextMessage(tab2, msgWhileScrolledUp);

    await authPage.waitForTimeout(300);
    const distanceWhileUp = await msgList.evaluate(
      (el: Element) => el.scrollHeight - el.scrollTop - el.clientHeight,
    );
    expect(distanceWhileUp).toBeGreaterThan(200);
    await expect(scrollFab).toBeVisible();

    // Click #btn-scroll-to-bottom FAB -> smoothly lands at bottom and hides FAB
    await scrollFab.click();
    await expect
      .poll(async () =>
        msgList.evaluate((el: Element) =>
          Math.abs(el.scrollHeight - el.scrollTop - el.clientHeight),
        ),
      )
      .toBeLessThanOrEqual(16);

    await expect(scrollFab).toBeHidden();
    await expect(
      msgList
        .locator(DOM.messageBubble)
        .filter({ hasText: msgWhileScrolledUp }),
    ).toBeVisible();
  });

  test('F6-3: Exact per-chat scroll offset (scrollTop) preservation across Chat A -> Chat B -> Chat A', async ({
    authPage,
  }) => {
    const chatA = await selectWritableChat(authPage);
    await ensureScrollableTimeline(authPage, 520);

    const msgList = authPage.locator(DOM.messageList);
    const savedScrollTopA = await msgList.evaluate(async (el: Element) => {
      const maxScroll = el.scrollHeight - el.clientHeight;
      const target = Math.max(
        130,
        Math.min(maxScroll - 130, Math.round(maxScroll * 0.45)),
      );
      el.scrollTop = target;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      return el.scrollTop;
    });

    expect(savedScrollTopA).toBeGreaterThanOrEqual(120);

    // Switch to distinct writable Chat B and scroll Chat B to bottom
    const chatB = await selectWritableChat(authPage, new Set([chatA.chatId]));
    expect(chatB.chatId).not.toBe(chatA.chatId);
    await msgList.evaluate((el: Element) => {
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    // Return to Chat A and verify exact interior scrollTop restoration
    await selectChat(authPage, chatA.chatId);

    await expect
      .poll(
        async () => {
          const cur = await msgList.evaluate((el: Element) => el.scrollTop);
          return Math.abs(cur - savedScrollTopA);
        },
        {
          message: `Expected Chat A scrollTop to restore within 20px of ${savedScrollTopA}`,
        },
      )
      .toBeLessThanOrEqual(20);

    const restoredStats = await msgList.evaluate((el: Element) => ({
      top: el.scrollTop,
      distFromBottom: el.scrollHeight - el.clientHeight - el.scrollTop,
    }));
    expect(restoredStats.top).toBeGreaterThanOrEqual(100);
    expect(restoredStats.distFromBottom).toBeGreaterThanOrEqual(100);
  });

  test('F6-4: #pinned-message-banner multi-pin cycling and click-to-jump highlight', async ({
    authPage,
  }) => {
    await selectWritableChat(authPage);

    const pinnedBanner = authPage.locator(DOM.pinnedMessageBanner);
    const msgList = authPage.locator(DOM.messageList);

    const pin1Text = 'MultiPin Target #1 — Architecture Freeze';
    const bubble1 = await sendTextMessage(authPage, pin1Text);
    const msgId1 = await bubble1.getAttribute(DATA_ATTRS.messageId);
    expect(msgId1).toBeTruthy();

    await pinBubbleDeterministically(authPage, bubble1);
    await expect(pinnedBanner).toBeVisible();
    await expect(pinnedBanner).toContainText('MultiPin Target #1');

    const spacerNearPin1 = await sendTextMessage(
      authPage,
      'Pin baseline spacer near target #1\nLine 2\nLine 3\nLine 4',
    );
    const spacerNearPin1Id =
      (await spacerNearPin1.getAttribute(DATA_ATTRS.messageId)) ?? '';
    expect(spacerNearPin1Id).toBeTruthy();

    await ensureScrollableTimeline(authPage, 700);

    const pin2Text = 'MultiPin Target #2 — Release Signoff';
    const bubble2 = await sendTextMessage(authPage, pin2Text);
    const msgId2 = await bubble2.getAttribute(DATA_ATTRS.messageId);
    expect(msgId2).toBeTruthy();

    await pinBubbleDeterministically(authPage, bubble2);
    await expect(pinnedBanner).toBeVisible();

    // Ensure timeline is at bottom and assert targetBubble1 is genuinely offscreen above #message-list BEFORE clicking banner
    await msgList.evaluate((el: Element) => {
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    const targetBubble1 = msgList.locator(messageBubbleById(msgId1!));
    const isOffscreenBeforeJump = await authPage.evaluate((id: string) => {
      const listEl = document.querySelector('#message-list');
      if (!listEl) return false;
      const b1El = listEl.querySelector(
        `[data-testid="message-bubble"][data-message-id="${CSS.escape(id)}"]`,
      );
      if (!b1El) {
        return listEl.scrollTop > 300;
      }
      const lr = listEl.getBoundingClientRect();
      const br = b1El.getBoundingClientRect();
      return br.bottom <= lr.top + 4;
    }, msgId1!);
    expect(isOffscreenBeforeJump).toBe(true);

    const checkTarget1Highlight = async (): Promise<boolean> =>
      msgList.evaluate(
        (listEl: Element, args: { targetId: string; spacerId: string }) => {
          const el = listEl.querySelector(
            `[data-testid="message-bubble"][data-message-id="${CSS.escape(args.targetId)}"]`,
          );
          if (!el) return false;

          const allAttrs = Array.from(el.attributes)
            .map((a) => `${a.name}=${a.value}`)
            .join(' ');
          if (
            /highlight|flash|pulse|focus|active|jump|pinned/i.test(
              `${el.className} ${allAttrs}`,
            ) ||
            el.querySelector(
              '[class*="highlight" i], [class*="flash" i], [data-highlighted="true"]',
            ) !== null
          ) {
            return true;
          }

          const spacerEl =
            listEl.querySelector(
              `[data-testid="message-bubble"][data-message-id="${CSS.escape(args.spacerId)}"]`,
            ) ??
            Array.from(
              listEl.querySelectorAll('[data-testid="message-bubble"]'),
            ).find((b) =>
              (b.textContent ?? '').includes('Timeline vertical spacer'),
            );
          if (!spacerEl) return false;

          const resolveCard = (root: Element): Element => {
            const selfBg = window.getComputedStyle(root).backgroundColor;
            if (
              selfBg &&
              selfBg !== 'rgba(0, 0, 0, 0)' &&
              selfBg !== 'transparent'
            ) {
              return root;
            }
            return (
              Array.from(root.querySelectorAll('*')).find((child) => {
                const bg = window.getComputedStyle(child).backgroundColor;
                return bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';
              }) ?? root
            );
          };

          const stTarget = window.getComputedStyle(el);
          const stSpacer = window.getComputedStyle(spacerEl);
          const stTargetCard = window.getComputedStyle(resolveCard(el));
          const stSpacerCard = window.getComputedStyle(resolveCard(spacerEl));

          return (
            stTarget.backgroundColor !== stSpacer.backgroundColor ||
            stTarget.boxShadow !== stSpacer.boxShadow ||
            stTarget.outline !== stSpacer.outline ||
            stTarget.animationName !== stSpacer.animationName ||
            stTargetCard.backgroundColor !== stSpacerCard.backgroundColor ||
            stTargetCard.boxShadow !== stSpacerCard.boxShadow ||
            stTargetCard.outline !== stSpacerCard.outline ||
            stTargetCard.animationName !== stSpacerCard.animationName
          );
        },
        { targetId: msgId1!, spacerId: spacerNearPin1Id },
      );

    // Record banner snapshots strictly AFTER both pins are active and cycle via #pinned-message-banner
    const bannerTextsObserved = new Set<string>();
    bannerTextsObserved.add((await pinnedBanner.innerText()).trim());

    let jumpedToBubble1 = false;
    let highlightedBubble1 = false;

    for (let clickIdx = 0; clickIdx < 4; clickIdx++) {
      await pinnedBanner.click();
      await authPage.waitForTimeout(200);
      bannerTextsObserved.add((await pinnedBanner.innerText()).trim());

      if (await targetBubble1.isVisible()) {
        const listRect = await msgList.boundingBox();
        const b1Rect = await targetBubble1.boundingBox();
        if (
          listRect &&
          b1Rect &&
          b1Rect.y >= listRect.y - 24 &&
          b1Rect.y + b1Rect.height <= listRect.y + listRect.height + 24
        ) {
          jumpedToBubble1 = true;
          if (await checkTarget1Highlight()) {
            highlightedBubble1 = true;
          }
          if (bannerTextsObserved.size >= 2) {
            break;
          }
        }
      }
    }

    expect(jumpedToBubble1).toBe(true);
    expect(highlightedBubble1).toBe(true);

    // If an extra click after landing on targetBubble1 moved away to capture 2nd banner state, ensure targetBubble1 is still reachable
    if (!(await targetBubble1.isVisible())) {
      await pinnedBanner.click();
      await expect(targetBubble1).toBeVisible();
    }

    const listBox = await msgList.boundingBox();
    const b1Box = await targetBubble1.boundingBox();
    expect(listBox).not.toBeNull();
    expect(b1Box).not.toBeNull();
    expect(b1Box!.y).toBeGreaterThanOrEqual(listBox!.y - 24);
    expect(b1Box!.y + b1Box!.height).toBeLessThanOrEqual(
      listBox!.y + listBox!.height + 24,
    );

    const combinedBannerHistory = Array.from(bannerTextsObserved).join(' || ');
    expect(
      (combinedBannerHistory.includes('MultiPin Target #1') &&
        combinedBannerHistory.includes('MultiPin Target #2')) ||
        bannerTextsObserved.size >= 2,
    ).toBe(true);
  });

  test('F6-5: Channel post view counter (👁) and viewport IntersectionObserver read-receipt progression', async ({
    authPage,
  }) => {
    // Part A: Create broadcast channel via #modal-create-channel and verify post view counter (👁)
    await openBurgerMenu(authPage);
    await authPage.locator(DOM.menuItemNewChannel).click();

    const channelModal = authPage.locator(DOM.modalCreateChannel);
    await expect(channelModal).toBeVisible();

    const channelTitleInput = scopedTextbox(
      channelModal,
      bilingualRegex('name|title', '名称|标题'),
    )
      .or(
        channelModal
          .locator(
            'input[type="text"]:visible, input:not([type="checkbox"]):not([type="radio"]):visible',
          )
          .first(),
      )
      .first();
    await expect(channelTitleInput).toBeVisible();
    await channelTitleInput.fill('E2E Broadcast Pulse');

    const createChannelBtn = scopedButton(channelModal, BILINGUAL_PATTERNS.create)
      .or(scopedButton(channelModal, BILINGUAL_PATTERNS.confirm))
      .first();
    await expect(createChannelBtn).toBeVisible();
    await createChannelBtn.click();
    await expect(channelModal).toBeHidden();

    await expect(authPage.locator(DOM.chatHeaderTitle)).toContainText(
      'E2E Broadcast Pulse',
    );

    const channelPost = await sendTextMessage(
      authPage,
      'Channel announcement #1 — view counter check',
    );

    await expect
      .poll(
        async () => {
          const text = await channelPost.innerText();
          if (/👁|\bviews?\b|浏览|阅读/i.test(text) && /[1-9]\d*/.test(text)) {
            return true;
          }
          const viewBadge = channelPost.locator(
            '[data-testid*="view" i], [class*="view" i], [aria-label*="view" i], [aria-label*="浏览"]',
          );
          if ((await viewBadge.count()) > 0) {
            const badgeText = await viewBadge.first().innerText();
            return /[1-9]\d*/.test(badgeText);
          }
          return false;
        },
        { message: 'Expected channel post bubble to render 👁 view counter >= 1' },
      )
      .toBe(true);

    // Part B: Viewport IntersectionObserver read-receipt & unread badge progression
    const chatList = authPage.locator(DOM.chatList);
    const { chatId: targetChatId } = await selectWritableChat(authPage);
    const otherChat = await selectWritableChat(
      authPage,
      new Set([targetChatId]),
    );
    expect(otherChat.chatId).not.toBe(targetChatId);

    const targetRow = chatList.locator(chatRowById(targetChatId));
    await openContextMenuAndClick(
      authPage,
      targetRow,
      STRICT_MENU_REGEX.markUnread,
    );

    const unreadLoc = targetRow.locator(
      '[data-unread="true"], [data-unread-count], [data-testid*="unread" i], [class*="unread" i], [aria-label*="unread" i], [aria-label*="未读"]',
    );
    await expect(unreadLoc.first()).toBeVisible();

    // Open targetChatId and scroll #message-list to bottom so IntersectionObserver marks messages read
    await selectChat(authPage, targetChatId);
    const msgList = authPage.locator(DOM.messageList);
    await msgList.evaluate((el: Element) => {
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    await expect
      .poll(
        async () => {
          const c = await unreadLoc.count();
          if (c === 0) return true;
          const visible = await unreadLoc.first().isVisible();
          if (!visible) return true;
          const badgeTxt = ((await unreadLoc.first().textContent()) ?? '').trim();
          return badgeTxt === '0';
        },
        {
          message:
            'Expected viewport read receipt to clear unread badge on opened chat row',
        },
      )
      .toBe(true);

    const receiptBubble = await sendTextMessage(
      authPage,
      'Read receipt outgoing verification',
    );
    await expect(receiptBubble).not.toContainText('🕒');
    await expect
      .poll(
        async () => {
          const txt = await receiptBubble.innerText();
          if (/✓|✔/.test(txt)) return true;
          return (
            (await receiptBubble
              .locator(OUTGOING_DELIVERY_STATUS_SELECTOR)
              .count()) > 0
          );
        },
        {
          message:
            'Expected outgoing bubble to display ✓ / ✓✓ or delivered/read status indicator',
        },
      )
      .toBe(true);
  });
});
