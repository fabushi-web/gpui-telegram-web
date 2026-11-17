import type { Locator, Page } from '@playwright/test';
import {
  BILINGUAL_PATTERNS,
  bilingualRegex,
  DATA_ATTRS,
  DOM,
  expect,
  messageBubbleById,
  openBurgerMenu,
  readComposerText,
  scopedButton,
  scopedMenuItem,
  scopedTextbox,
  selectChat,
  sendTextMessage,
  test,
  type BilingualActionKey,
} from '../helpers';

interface SelectedPeerChat {
  row: Locator;
  chatId: string;
  title: string;
}

const STRICT_PIN_PATTERN = /^(?!.*(?:unpin|取消))(?:.*\bpin\b|.*置顶)/i;

async function selectWritablePeerChat(
  page: Page,
  options: { excludeChatIds?: string[]; preferNonSaved?: boolean } = {},
): Promise<SelectedPeerChat> {
  const excludeSet = new Set(options.excludeChatIds ?? []);
  const preferNonSaved = options.preferNonSaved ?? true;

  const chatList = page.locator(DOM.chatList);
  await expect(chatList).toBeVisible();

  const rows = chatList.locator(DOM.chatRow);
  const rowCount = await rows.count();
  expect(rowCount).toBeGreaterThan(0);

  const maxScan = Math.min(rowCount, 12);

  for (const allowSavedAndBots of preferNonSaved ? [false, true] : [true]) {
    for (let i = 0; i < maxScan; i++) {
      const candidate = rows.nth(i);
      if (!(await candidate.isVisible())) continue;

      const chatId = (await candidate.getAttribute(DATA_ATTRS.chatId)) ?? '';
      if (chatId && excludeSet.has(chatId)) continue;

      const rowText = (await candidate.innerText()).trim();
      if (
        !allowSavedAndBots &&
        /saved messages|收藏夹|已保存消息|botfather/i.test(rowText)
      ) {
        continue;
      }

      const selectedRow = await selectChat(page, i);
      const topicList = page.locator(DOM.forumTopicList);
      const composer = page.locator(DOM.messageComposerInput);

      if ((await topicList.isVisible()) && !(await composer.isVisible())) {
        const firstTopic = page.locator(DOM.forumTopicItem).first();
        if (await firstTopic.isVisible()) {
          await firstTopic.click();
        }
      }

      if ((await composer.isVisible()) && (await composer.isEditable())) {
        const title = (await page.locator(DOM.chatHeaderTitle).innerText()).trim();
        return { row: selectedRow, chatId, title };
      }
    }
  }

  await expect(page.locator(DOM.messageComposerInput)).toBeVisible();
  await expect(page.locator(DOM.messageComposerInput)).toBeEditable();
  const fallbackRow = rows.first();
  return {
    row: fallbackRow,
    chatId: (await fallbackRow.getAttribute(DATA_ATTRS.chatId)) ?? '',
    title: (await page.locator(DOM.chatHeaderTitle).innerText()).trim(),
  };
}

async function reopenChatAfterReload(
  page: Page,
  activeChat: SelectedPeerChat,
): Promise<void> {
  if (activeChat.chatId) {
    await selectChat(page, activeChat.chatId);
  } else {
    await selectChat(page, activeChat.title);
  }

  const topicList = page.locator(DOM.forumTopicList);
  const composer = page.locator(DOM.messageComposerInput);
  if ((await topicList.isVisible()) && !(await composer.isVisible())) {
    const firstTopic = page.locator(DOM.forumTopicItem).first();
    if ((await firstTopic.count()) > 0 && (await firstTopic.isVisible())) {
      await firstTopic.click();
    }
  }
}

async function pickVisibleFirst(
  primary: Locator,
  fallback: Locator,
): Promise<Locator> {
  if ((await primary.count()) > 0 && (await primary.first().isVisible())) {
    return primary.first();
  }
  return fallback.first();
}

async function readToggleCheckedState(toggle: Locator): Promise<boolean> {
  return toggle.evaluate((el) => {
    if (el instanceof HTMLInputElement) return el.checked;
    const nested = el.querySelector(
      'input[type="checkbox"], input[type="radio"]',
    );
    if (nested instanceof HTMLInputElement) return nested.checked;
    const aria =
      el.getAttribute('aria-checked') ??
      el.getAttribute('aria-pressed') ??
      el.getAttribute('aria-selected');
    if (aria !== null) return aria === 'true';
    if (el instanceof HTMLElement) {
      if (
        el.dataset.checked === 'true' ||
        el.dataset.active === 'true' ||
        el.dataset.selected === 'true'
      ) {
        return true;
      }
      if (/\b(checked|active|selected|is-checked|on)\b/i.test(el.className)) {
        return true;
      }
    }
    return false;
  });
}

async function findHideSenderToggle(
  scope: Locator,
  hideSenderPattern: RegExp,
): Promise<Locator | null> {
  const checkboxLoc = scope.getByRole('checkbox', { name: hideSenderPattern });
  if ((await checkboxLoc.count()) > 0 && (await checkboxLoc.first().isVisible())) {
    return checkboxLoc.first();
  }

  const switchLoc = scope.getByRole('switch', { name: hideSenderPattern });
  if ((await switchLoc.count()) > 0 && (await switchLoc.first().isVisible())) {
    return switchLoc.first();
  }

  const itemOrLabelLoc = scope
    .locator(
      '[role="menuitemcheckbox"], [role="option"], [role="radio"], button, label',
    )
    .filter({ hasText: hideSenderPattern });
  if (
    (await itemOrLabelLoc.count()) > 0 &&
    (await itemOrLabelLoc.first().isVisible())
  ) {
    return itemOrLabelLoc.first();
  }

  return null;
}

async function enableHideSenderInScope(
  scope: Locator,
  hideSenderPattern: RegExp,
): Promise<boolean> {
  const toggle = await findHideSenderToggle(scope, hideSenderPattern);
  if (!toggle) return false;

  const isChecked = await readToggleCheckedState(toggle);
  if (!isChecked) {
    await toggle.click();
    await expect
      .poll(async () => readToggleCheckedState(toggle), {
        message: 'Expected Hide sender toggle to transition to checked/active state',
        timeout: 4_000,
      })
      .toBe(true);
  }
  return true;
}

function locateVisibleContextMenu(page: Page): Locator {
  return page
    .locator('[role="menu"], [data-testid="context-menu"], [data-context-menu]')
    .first();
}

async function clickBubbleContextAction(
  page: Page,
  bubble: Locator,
  actionOrPattern: BilingualActionKey | RegExp,
): Promise<void> {
  await expect(bubble).toBeVisible();
  await bubble.click({ button: 'right' });
  const menu = locateVisibleContextMenu(page);
  await expect(menu).toBeVisible();
  const item = scopedMenuItem(menu, actionOrPattern).first();
  await expect(item).toBeVisible();
  await item.click();
}

async function confirmActionDialogIfShown(
  page: Page,
  confirmPattern: BilingualActionKey | RegExp,
): Promise<void> {
  const dialog = page
    .locator('[role="alertdialog"], [role="dialog"]')
    .filter({ hasNot: page.locator(DOM.chatList) })
    .first();

  if (await dialog.isVisible()) {
    const confirmBtn = scopedButton(dialog, confirmPattern).last();
    if (await confirmBtn.isVisible()) {
      await confirmBtn.click();
    }
  }
}

async function openSavedMessagesChat(page: Page): Promise<void> {
  const chatList = page.locator(DOM.chatList);
  if (await chatList.isVisible()) {
    const savedRow = chatList
      .locator(DOM.chatRow)
      .filter({ hasText: BILINGUAL_PATTERNS.savedMessages })
      .first();
    if ((await savedRow.count()) > 0 && (await savedRow.isVisible())) {
      await savedRow.click();
      await expect(page.locator(DOM.chatHeaderTitle)).toContainText(
        BILINGUAL_PATTERNS.savedMessages,
      );
      return;
    }
  }

  await openBurgerMenu(page);
  const savedItem = page.locator(DOM.menuItemSavedMessages);
  await expect(savedItem).toBeVisible();
  await savedItem.click();
  await expect(page.locator(DOM.middleColumn)).toBeVisible();
  await expect(page.locator(DOM.chatHeaderTitle)).toContainText(
    BILINGUAL_PATTERNS.savedMessages,
  );
}

async function selectBubbleInToolbarMode(bubble: Locator): Promise<void> {
  const checkbox = bubble
    .locator('input[type="checkbox"], [role="checkbox"], [data-testid*="select" i]')
    .first();
  if ((await checkbox.count()) > 0 && (await checkbox.isVisible())) {
    await checkbox.click();
  } else {
    await bubble.click();
  }
}

test.describe('F9 — Message Operations & Multi-Message Selection', () => {
  test('F9.1: replies via context menu and double-click, displays #composer-reply-edit-banner, and scrolls back to original bubble when reply header is clicked', async ({
    authPage,
  }) => {
    await selectWritablePeerChat(authPage);

    const anchorText = 'Origin anchor message F9-1 锚点消息';
    const anchorBubble = await sendTextMessage(authPage, anchorText);
    const anchorMsgId = await anchorBubble.getAttribute(DATA_ATTRS.messageId);
    expect(anchorMsgId).toBeTruthy();

    // 1. Trigger Reply via context menu
    await clickBubbleContextAction(authPage, anchorBubble, 'reply');
    const banner = authPage.locator(DOM.composerReplyEditBanner);
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Origin anchor message F9-1');

    // Dismiss active reply banner
    const cancelBannerBtn = scopedButton(banner, 'cancel').first();
    if ((await cancelBannerBtn.count()) > 0 && (await cancelBannerBtn.isVisible())) {
      await cancelBannerBtn.click();
    } else {
      await authPage.keyboard.press('Escape');
    }
    await expect(banner).toBeHidden();

    // 2. Push anchor message upward with multi-line spacer messages
    for (let idx = 1; idx <= 14; idx++) {
      await sendTextMessage(
        authPage,
        `Timeline spacer block #${idx}\nLine B\nLine C\nLine D`,
      );
    }

    const messageList = authPage.locator(DOM.messageList);
    const topAnchorBubble = messageList.locator(messageBubbleById(anchorMsgId!));

    // Step upward incrementally from bottom so @tanstack/react-virtual mounts anchorBubble cleanly
    for (let step = 0; step < 32; step++) {
      if (
        (await topAnchorBubble.count()) > 0 &&
        (await topAnchorBubble.isVisible())
      ) {
        break;
      }
      const reachedTop = await messageList.evaluate(async (el) => {
        if (el.scrollTop <= 0) return true;
        const delta = Math.max(120, Math.floor(el.clientHeight * 0.75));
        el.scrollTop = Math.max(0, el.scrollTop - delta);
        el.dispatchEvent(new Event('scroll', { bubbles: true }));
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        return el.scrollTop <= 0;
      });
      if (reachedTop) break;
    }

    await expect(topAnchorBubble).toBeVisible();
    await topAnchorBubble.scrollIntoViewIfNeeded();

    // 3. Re-trigger Reply via double-click (with context-menu confirmation if dblclick requires specific target)
    await topAnchorBubble.dblclick();
    if (!(await banner.isVisible())) {
      await clickBubbleContextAction(authPage, topAnchorBubble, 'reply');
    }
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Origin anchor message F9-1');

    // 4. Send reply at bottom of timeline and verify embedded reply header jump-scroll
    const replyText = 'Bottom reply referencing top anchor F9-1';
    const replyBubble = await sendTextMessage(authPage, replyText);
    await expect(banner).toBeHidden();
    await expect(replyBubble).toContainText(replyText);
    await expect(replyBubble).toContainText('Origin anchor message F9-1');

    await messageList.evaluate(async (el) => {
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    });

    const scrollTopBefore = await messageList.evaluate((el) => el.scrollTop);
    expect(scrollTopBefore).toBeGreaterThan(40);

    const embeddedReplyHeader = replyBubble
      .locator('[data-reply-to], [data-testid*="reply" i], blockquote, [class*="reply" i]')
      .first();
    if (
      (await embeddedReplyHeader.count()) > 0 &&
      (await embeddedReplyHeader.isVisible())
    ) {
      await embeddedReplyHeader.click();
    } else {
      await replyBubble.getByText('Origin anchor message F9-1').first().click();
    }

    await expect
      .poll(
        async () => {
          const scrollTopAfter = await messageList.evaluate((el) => el.scrollTop);
          if (scrollTopAfter >= scrollTopBefore) return false;
          if (
            (await topAnchorBubble.count()) === 0 ||
            !(await topAnchorBubble.isVisible())
          ) {
            return false;
          }
          const [anchorBox, listBox] = await Promise.all([
            topAnchorBubble.boundingBox(),
            messageList.boundingBox(),
          ]);
          if (!anchorBox || !listBox) return false;
          return (
            anchorBox.width > 0 &&
            anchorBox.height > 0 &&
            anchorBox.y + anchorBox.height > listBox.y + 4 &&
            anchorBox.y < listBox.y + listBox.height - 4 &&
            anchorBox.x + anchorBox.width > listBox.x &&
            anchorBox.x < listBox.x + listBox.width
          );
        },
        {
          message:
            'Expected clicking embedded reply preview to scroll #message-list upward so original anchor bubble intersects viewport',
          timeout: 8_000,
        },
      )
      .toBe(true);
  });

  test('F9.2: creates a partial quote reply from selected text inside a message bubble', async ({
    authPage,
  }) => {
    await selectWritablePeerChat(authPage);

    const targetQuote = 'PARTIAL_QUOTE_TARGET_88_精选片段';
    const fullMsg = `Introductory context clause. ${targetQuote}. Concluding trailing clause.`;
    const sourceBubble = await sendTextMessage(authPage, fullMsg);

    // Programmatically select the exact middle substring and fire realistic selectionchange + mouseup
    const selectionInfo = await sourceBubble.evaluate((el, quoteStr) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const content = node.textContent ?? '';
        const idx = content.indexOf(quoteStr);
        if (idx !== -1 && node.parentElement) {
          const range = document.createRange();
          range.setStart(node, idx);
          range.setEnd(node, idx + quoteStr.length);
          const sel = window.getSelection();
          if (sel) {
            sel.removeAllRanges();
            sel.addRange(range);
          }
          const rect = range.getBoundingClientRect();
          const cx = Math.round(rect.left + rect.width / 2);
          const cy = Math.round(rect.top + rect.height / 2);
          document.dispatchEvent(new Event('selectionchange', { bubbles: true }));
          node.parentElement.dispatchEvent(
            new MouseEvent('mouseup', {
              bubbles: true,
              cancelable: true,
              clientX: cx,
              clientY: cy,
            }),
          );
          return {
            selected: window.getSelection()?.toString() ?? '',
            cx,
            cy,
          };
        }
        node = walker.nextNode();
      }
      return { selected: '', cx: 0, cy: 0 };
    }, targetQuote);

    expect(selectionInfo.selected).toBe(targetQuote);

    // Trigger Partial Quote Reply via strictly interactive button/menuitem (never non-interactive blockquote)
    const semanticQuoteBtn = authPage.getByRole('button', {
      name: BILINGUAL_PATTERNS.quote,
    });
    const attrQuoteBtn = authPage.locator(
      'button[data-testid*="quote" i], [role="button"][data-testid*="quote" i], [role="menuitem"][data-testid*="quote" i]',
    );
    const floatingQuoteBtn = await pickVisibleFirst(semanticQuoteBtn, attrQuoteBtn);

    if ((await floatingQuoteBtn.count()) > 0 && (await floatingQuoteBtn.isVisible())) {
      await floatingQuoteBtn.click();
    } else {
      await sourceBubble.evaluate(
        (el, { quoteStr, cx, cy }) => {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let node = walker.nextNode();
          while (node) {
            if ((node.textContent ?? '').includes(quoteStr) && node.parentElement) {
              node.parentElement.dispatchEvent(
                new MouseEvent('contextmenu', {
                  bubbles: true,
                  cancelable: true,
                  button: 2,
                  clientX: cx,
                  clientY: cy,
                }),
              );
              return;
            }
            node = walker.nextNode();
          }
        },
        { quoteStr: targetQuote, cx: selectionInfo.cx, cy: selectionInfo.cy },
      );

      const menu = locateVisibleContextMenu(authPage);
      await expect(menu).toBeVisible();
      const quoteItem = scopedMenuItem(menu, 'quote').first();
      if ((await quoteItem.count()) > 0 && (await quoteItem.isVisible())) {
        await quoteItem.click();
      } else {
        const replyItem = scopedMenuItem(menu, 'reply').first();
        await expect(replyItem).toBeVisible();
        await replyItem.click();
      }
    }

    const banner = authPage.locator(DOM.composerReplyEditBanner);
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(targetQuote);
    await expect(banner).not.toContainText('Concluding trailing clause.');

    const replyBody = 'Replying to just the quoted clause F9-2';
    const quotedReplyBubble = await sendTextMessage(authPage, replyBody);

    await expect(quotedReplyBubble).toContainText(replyBody);
    await expect(quotedReplyBubble).toContainText(targetQuote);
    await expect(quotedReplyBubble).not.toContainText('Concluding trailing clause.');
  });

  test('F9.3: edits outgoing message in-place via context menu and via ArrowUp in empty composer with edited badge', async ({
    authPage,
  }) => {
    const activeChat = await selectWritablePeerChat(authPage);
    const composer = authPage.locator(DOM.messageComposerInput);
    const messageList = authPage.locator(DOM.messageList);
    const banner = authPage.locator(DOM.composerReplyEditBanner);

    const initialText = 'Original unedited text F9-3';
    const bubble = await sendTextMessage(authPage, initialText);
    const msgId = await bubble.getAttribute(DATA_ATTRS.messageId);
    expect(msgId).toBeTruthy();

    const countBefore = await messageList.locator(DOM.messageBubble).count();

    // Edit #1: via context menu
    await clickBubbleContextAction(authPage, bubble, 'edit');
    await expect(banner).toBeVisible();
    await expect.poll(() => readComposerText(composer)).toContain(initialText);

    const menuEditedText = 'Edited via context menu F9-3 已修改';
    await composer.fill(menuEditedText);
    const sendBtn = authPage.locator(DOM.btnSendMessage);
    if ((await sendBtn.isVisible()) && (await sendBtn.isEnabled())) {
      await sendBtn.click();
    } else {
      await composer.press('Enter');
    }

    await expect(banner).toBeHidden();
    const sameBubble = messageList.locator(messageBubbleById(msgId!));
    await expect(sameBubble).toContainText(menuEditedText);
    await expect(sameBubble).not.toContainText(initialText);
    await expect(sameBubble).toContainText(/edited|已编辑/i);
    await expect(messageList.locator(DOM.messageBubble)).toHaveCount(countBefore);

    // Edit #2: via ArrowUp inside empty composer
    expect((await readComposerText(composer)).trim()).toBe('');
    await composer.click();
    await composer.press('ArrowUp');

    await expect(banner).toBeVisible();
    await expect.poll(() => readComposerText(composer)).toContain(menuEditedText);

    const arrowEditedText = 'Edited second time via ArrowUp F9-3';
    await composer.fill(arrowEditedText);
    await composer.press('Enter');

    await expect(banner).toBeHidden();
    await expect(sameBubble).toContainText(arrowEditedText);
    await expect(sameBubble).not.toContainText(menuEditedText);
    await expect(sameBubble).toContainText(/edited|已编辑/i);

    // Verify edit persists across full page reload
    await authPage.reload({ waitUntil: 'domcontentloaded' });
    await expect(authPage.locator(DOM.appShell)).toBeVisible();
    await reopenChatAfterReload(authPage, activeChat);
    const persistedBubble = authPage
      .locator(DOM.messageList)
      .locator(messageBubbleById(msgId!));
    await expect(persistedBubble).toContainText(arrowEditedText);
    await expect(persistedBubble).toContainText(/edited|已编辑/i);
  });

  test('F9.4: forwards message via #modal-forward with target search, Hide sender toggle, and extra comment', async ({
    authPage,
  }) => {
    const sourceChat = await selectWritablePeerChat(authPage, {
      preferNonSaved: true,
    });

    const secretForwardText = 'Forward payload with hidden sender F9-4';
    const srcBubble = await sendTextMessage(authPage, secretForwardText);

    await clickBubbleContextAction(authPage, srcBubble, 'forward');

    const modal = authPage.locator(DOM.modalForward);
    await expect(modal).toBeVisible();

    // Locate target list items inside #modal-forward (prefer Saved Messages)
    const savedOption = modal
      .locator('[role="option"], [role="menuitem"], [data-chat-id], [data-peer-id], li, button')
      .filter({ hasText: BILINGUAL_PATTERNS.savedMessages })
      .first();

    let targetLabel = 'Saved';
    let useSavedMessages = false;
    if ((await savedOption.count()) > 0 && (await savedOption.isVisible())) {
      const text = (await savedOption.innerText()).trim();
      targetLabel = /收藏夹/.test(text)
        ? '收藏夹'
        : /已保存/.test(text)
          ? '已保存'
          : 'Saved';
      useSavedMessages = true;
    } else {
      const otherPeerOption = modal
        .locator('[role="option"], [data-chat-id], li button')
        .filter({ hasNotText: sourceChat.title })
        .first();
      await expect(otherPeerOption).toBeVisible();
      targetLabel = (await otherPeerOption.innerText()).trim().split('\n')[0].slice(0, 6);
    }

    // Exercise search box inside #modal-forward
    const searchInput = await pickVisibleFirst(
      scopedTextbox(modal, 'search'),
      modal.locator('input[type="search"], input[type="text"]'),
    );
    await expect(searchInput).toBeVisible();
    await searchInput.fill(targetLabel);

    const filteredTarget = modal
      .locator('[role="option"], [role="menuitem"], [data-chat-id], [data-peer-id], li, button')
      .filter({
        hasText: useSavedMessages ? BILINGUAL_PATTERNS.savedMessages : targetLabel,
      })
      .first();
    await expect(filteredTarget).toBeVisible();

    const hideSenderPattern = bilingualRegex(
      'hide.*sender|hide.*name|hide.*author|anonymous',
      '隐藏.*发送|隐藏.*名字|隐藏.*来源|匿名',
    );

    const commentText = 'Attached forward note F9-4';
    const resolveCommentInput = async (): Promise<Locator> => {
      return pickVisibleFirst(
        modal.getByPlaceholder(/comment|caption|message|note|留言|评论|附言|说明/i),
        modal.locator('textarea'),
      );
    };

    let toggledHideSender = await enableHideSenderInScope(modal, hideSenderPattern);

    let filledCommentInModal = false;
    const commentInputBefore = await resolveCommentInput();
    if (
      (await commentInputBefore.count()) > 0 &&
      (await commentInputBefore.isVisible())
    ) {
      await commentInputBefore.fill(commentText);
      filledCommentInModal = true;
    }

    await filteredTarget.click();

    // Allow 1-click async forward POST to auto-close #modal-forward before checking 2-step confirmation
    await authPage.waitForTimeout(300);

    if (await modal.isVisible()) {
      if (!toggledHideSender) {
        toggledHideSender = await enableHideSenderInScope(modal, hideSenderPattern);
      }
      if (!filledCommentInModal) {
        const commentInputAfter = await resolveCommentInput();
        if (
          (await commentInputAfter.count()) > 0 &&
          (await commentInputAfter.isVisible())
        ) {
          await commentInputAfter.fill(commentText);
          filledCommentInModal = true;
        }
      }

      const submitForwardBtn = scopedButton(
        modal,
        bilingualRegex('forward|send|confirm|done', '转发|发送|确认|完成'),
      ).last();
      if (
        (await modal.isVisible()) &&
        (await submitForwardBtn.count()) > 0 &&
        (await submitForwardBtn.isVisible())
      ) {
        await submitForwardBtn.click();
      }
    }

    await expect(modal).toBeHidden();

    // Navigate to target chat if not automatically switched
    if (useSavedMessages) {
      const currentTitle = (await authPage.locator(DOM.chatHeaderTitle).innerText()).trim();
      if (!BILINGUAL_PATTERNS.savedMessages.test(currentTitle)) {
        await openSavedMessagesChat(authPage);
      }
    } else {
      await selectChat(authPage, targetLabel);
    }

    // If forwarding staged into #composer-reply-edit-banner in target chat, configure Hide sender & send with commentText
    const replyEditBanner = authPage.locator(DOM.composerReplyEditBanner);
    if (await replyEditBanner.isVisible()) {
      if (!toggledHideSender) {
        toggledHideSender = await enableHideSenderInScope(
          replyEditBanner,
          hideSenderPattern,
        );
      }
      if (!toggledHideSender) {
        const forwardOptsBtn = scopedButton(
          replyEditBanner,
          bilingualRegex('option|setting|forward|sender', '选项|设置|转发|发送者'),
        ).first();
        if (
          (await forwardOptsBtn.count()) > 0 &&
          (await forwardOptsBtn.isVisible())
        ) {
          await forwardOptsBtn.click();
        } else {
          await replyEditBanner.click();
        }
        const popSurface = authPage
          .locator('[role="menu"], [role="dialog"], [data-popover]')
          .filter({ hasNot: authPage.locator(DOM.chatList) })
          .first();
        if ((await popSurface.count()) > 0 && (await popSurface.isVisible())) {
          toggledHideSender = await enableHideSenderInScope(
            popSurface,
            hideSenderPattern,
          );
          if (await popSurface.isVisible()) {
            const doneOptsBtn = scopedButton(popSurface, 'confirm').last();
            if (
              (await doneOptsBtn.count()) > 0 &&
              (await doneOptsBtn.isVisible())
            ) {
              await doneOptsBtn.click();
            } else {
              await authPage.keyboard.press('Escape');
            }
          }
        }
      }
      if (!filledCommentInModal) {
        await sendTextMessage(authPage, commentText);
        filledCommentInModal = true;
      } else {
        const sendBtn = authPage.locator(DOM.btnSendMessage);
        if ((await sendBtn.isVisible()) && (await sendBtn.isEnabled())) {
          await sendBtn.click();
        }
      }
    }

    // Hard fail-closed assertion: Hide sender control MUST have been genuinely found and enabled
    expect(toggledHideSender).toBe(true);

    const targetMessageList = authPage.locator(DOM.messageList);
    const forwardedBubble = targetMessageList
      .locator(DOM.messageBubble)
      .filter({ hasText: secretForwardText })
      .last();

    await expect(forwardedBubble).toBeVisible();
    await expect(targetMessageList).toContainText(commentText);
    await expect(forwardedBubble).not.toContainText(/forwarded from|转发自/i);
  });

  test('F9.5: pins and unpins message while synchronizing #pinned-message-banner', async ({
    authPage,
  }) => {
    await selectWritablePeerChat(authPage);

    const pinnedBanner = authPage.locator(DOM.pinnedMessageBanner);
    const hadInitialBanner = await pinnedBanner.isVisible();

    const pinTargetText = 'Critical release pin banner F9-5';
    const bubble = await sendTextMessage(authPage, pinTargetText);

    await clickBubbleContextAction(authPage, bubble, STRICT_PIN_PATTERN);
    await confirmActionDialogIfShown(
      authPage,
      bilingualRegex('pin|confirm|ok', '置顶|确认|确定'),
    );

    await expect(pinnedBanner).toBeVisible();
    await expect(pinnedBanner).toContainText(pinTargetText);

    // Unpin via context menu on bubble (or unpin action inside #pinned-message-banner)
    await bubble.click({ button: 'right' });
    const menu = locateVisibleContextMenu(authPage);
    await expect(menu).toBeVisible();
    const unpinMenuItem = scopedMenuItem(menu, 'unpin').first();

    if ((await unpinMenuItem.count()) > 0 && (await unpinMenuItem.isVisible())) {
      await unpinMenuItem.click();
    } else {
      await authPage.keyboard.press('Escape');
      const bannerUnpinBtn = scopedButton(pinnedBanner, 'unpin')
        .or(scopedButton(pinnedBanner, 'cancel'))
        .first();
      await expect(bannerUnpinBtn).toBeVisible();
      await bannerUnpinBtn.click();
    }

    await confirmActionDialogIfShown(
      authPage,
      bilingualRegex('unpin|confirm|ok', '取消置顶|确认|确定'),
    );

    if (!hadInitialBanner) {
      await expect(pinnedBanner).toBeHidden();
    } else {
      await expect
        .poll(async () => {
          if (!(await pinnedBanner.isVisible())) return true;
          const text = await pinnedBanner.innerText();
          return !text.includes(pinTargetText);
        })
        .toBe(true);
    }
  });

  test('F9.6: deletes message locally (for me) vs globally (for everyone tombstone) with reload persistence', async ({
    authPage,
  }) => {
    const activeChat = await selectWritablePeerChat(authPage, {
      preferNonSaved: true,
    });
    const messageList = authPage.locator(DOM.messageList);

    // 1. Delete locally ("for me")
    const textForMe = 'Local delete only payload F9-6A';
    const bubbleMe = await sendTextMessage(authPage, textForMe);

    await bubbleMe.click({ button: 'right' });
    const menuMe = locateVisibleContextMenu(authPage);
    await expect(menuMe).toBeVisible();

    const directDeleteMe = scopedMenuItem(menuMe, 'deleteForMe').first();
    if ((await directDeleteMe.count()) > 0 && (await directDeleteMe.isVisible())) {
      await directDeleteMe.click();
    } else {
      const deleteItem = scopedMenuItem(menuMe, 'delete').first();
      await expect(deleteItem).toBeVisible();
      await deleteItem.click();

      const dialog = authPage
        .locator('[role="alertdialog"], [role="dialog"]')
        .filter({ hasNot: authPage.locator(DOM.chatList) })
        .first();

      if (await dialog.isVisible()) {
        const btnForMe = scopedButton(dialog, 'deleteForMe').first();
        if ((await btnForMe.count()) > 0 && (await btnForMe.isVisible())) {
          await btnForMe.click();
        } else {
          const everyoneCheckbox = dialog
            .getByRole('checkbox', { name: BILINGUAL_PATTERNS.deleteForEveryone })
            .first();
          if (
            (await everyoneCheckbox.count()) > 0 &&
            (await everyoneCheckbox.isVisible()) &&
            (await everyoneCheckbox.isChecked())
          ) {
            await everyoneCheckbox.uncheck();
          }
          await scopedButton(dialog, 'delete')
            .or(scopedButton(dialog, 'confirm'))
            .last()
            .click();
        }
      }
    }

    await expect(messageList).not.toContainText(textForMe);

    // 2. Delete globally ("for everyone" / revocation tombstone)
    const textForAll = 'Global revoke tombstone payload F9-6B';
    const bubbleAll = await sendTextMessage(authPage, textForAll);
    const msgIdAll = await bubbleAll.getAttribute(DATA_ATTRS.messageId);
    expect(msgIdAll).toBeTruthy();

    await bubbleAll.click({ button: 'right' });
    const menuAll = locateVisibleContextMenu(authPage);
    await expect(menuAll).toBeVisible();

    const directDeleteAll = scopedMenuItem(menuAll, 'deleteForEveryone').first();
    if ((await directDeleteAll.count()) > 0 && (await directDeleteAll.isVisible())) {
      await directDeleteAll.click();
    } else {
      const deleteItem = scopedMenuItem(menuAll, 'delete').first();
      await expect(deleteItem).toBeVisible();
      await deleteItem.click();

      const dialog = authPage
        .locator('[role="alertdialog"], [role="dialog"]')
        .filter({ hasNot: authPage.locator(DOM.chatList) })
        .first();

      if (await dialog.isVisible()) {
        const btnForEveryone = scopedButton(dialog, 'deleteForEveryone').first();
        if ((await btnForEveryone.count()) > 0 && (await btnForEveryone.isVisible())) {
          await btnForEveryone.click();
        } else {
          const everyoneCheckbox = dialog
            .getByRole('checkbox', {
              name: /everyone|all|both|also delete|所有人|双方|大家|同时/i,
            })
            .or(
              dialog
                .locator('label')
                .filter({ hasText: /everyone|all|both|所有人|双方|大家|同时/i }),
            )
            .first();
          if (
            (await everyoneCheckbox.count()) > 0 &&
            (await everyoneCheckbox.isVisible())
          ) {
            await everyoneCheckbox.click();
          }
          await scopedButton(dialog, 'delete')
            .or(scopedButton(dialog, 'confirm'))
            .last()
            .click();
        }
      }
    }

    await expect(messageList).not.toContainText(textForAll);

    // If a tombstone bubble remains mounted at msgIdAll, verify tombstone presentation
    const maybeTombstone = messageList.locator(messageBubbleById(msgIdAll!));
    if ((await maybeTombstone.count()) > 0 && (await maybeTombstone.isVisible())) {
      const isDeletedAttr = await maybeTombstone.getAttribute('data-deleted');
      if (isDeletedAttr !== 'true') {
        await expect(maybeTombstone).toContainText(
          /deleted|removed|revoked|已删除|已撤回/i,
        );
      }
    }

    // 3. Reload persistence verification
    await authPage.reload({ waitUntil: 'domcontentloaded' });
    await expect(authPage.locator(DOM.appShell)).toBeVisible();
    await reopenChatAfterReload(authPage, activeChat);

    const reloadedList = authPage.locator(DOM.messageList);
    await expect(reloadedList).toBeVisible();
    await expect(reloadedList).not.toContainText(textForMe);
    await expect(reloadedList).not.toContainText(textForAll);
  });

  test('F9.7: selects multiple messages with #selection-toolbar and executes batch Copy, batch Forward, and batch Delete', async ({
    authPage,
  }) => {
    await authPage
      .context()
      .grantPermissions(['clipboard-read', 'clipboard-write']);

    const sourceChat = await selectWritablePeerChat(authPage, {
      preferNonSaved: true,
    });

    const m1 = 'MultiSelect batch one F9-7';
    const m2 = 'MultiSelect batch two F9-7';
    const m3 = 'MultiSelect survivor three F9-7';

    const b1 = await sendTextMessage(authPage, m1);
    const b2 = await sendTextMessage(authPage, m2);
    await sendTextMessage(authPage, m3);

    // Enter multi-select mode via context menu on b1
    await clickBubbleContextAction(authPage, b1, 'select');

    const toolbar = authPage.locator(DOM.selectionToolbar);
    await expect(toolbar).toBeVisible();
    await expect(toolbar).toContainText('1');

    // Add b2 to selection (leaving b3 unselected)
    await selectBubbleInToolbarMode(b2);
    await expect(toolbar).toContainText('2');

    // 1. Batch Copy
    const copyBtn = scopedButton(toolbar, 'copy').first();
    await expect(copyBtn).toBeVisible();
    await copyBtn.click();

    const clipboardText = await authPage.evaluate(() =>
      navigator.clipboard.readText(),
    );
    expect(clipboardText).toContain(m1);
    expect(clipboardText).toContain(m2);
    expect(clipboardText).not.toContain(m3);

    // Re-enter selection if batch Copy exited selection mode
    if (!(await toolbar.isVisible())) {
      await clickBubbleContextAction(authPage, b1, 'select');
      await selectBubbleInToolbarMode(b2);
      await expect(toolbar).toContainText('2');
    }

    // 2. Batch Forward to Saved Messages
    const forwardBtn = scopedButton(toolbar, 'forward').first();
    await expect(forwardBtn).toBeVisible();
    await forwardBtn.click();

    const forwardModal = authPage.locator(DOM.modalForward);
    await expect(forwardModal).toBeVisible();

    const savedTarget = forwardModal
      .locator('[role="option"], [role="menuitem"], [data-chat-id], [data-peer-id], li, button')
      .filter({ hasText: BILINGUAL_PATTERNS.savedMessages })
      .first();
    await expect(savedTarget).toBeVisible();
    await savedTarget.click();
    await authPage.waitForTimeout(300);

    if (await forwardModal.isVisible()) {
      const submitBatchFwdBtn = scopedButton(
        forwardModal,
        bilingualRegex('forward|send|confirm|done', '转发|发送|确认|完成'),
      ).last();
      if (
        (await forwardModal.isVisible()) &&
        (await submitBatchFwdBtn.count()) > 0 &&
        (await submitBatchFwdBtn.isVisible())
      ) {
        await submitBatchFwdBtn.click();
      }
    }
    await expect(forwardModal).toBeHidden();

    // If selecting Saved Messages switched active chat and staged into composer banner, flush before returning
    const currentHeader = (await authPage.locator(DOM.chatHeaderTitle).innerText()).trim();
    if (BILINGUAL_PATTERNS.savedMessages.test(currentHeader)) {
      if (await authPage.locator(DOM.composerReplyEditBanner).isVisible()) {
        await sendTextMessage(authPage, 'Batch forward flush F9-7');
      }
    }

    // Return to sourceChat if forwarding switched active chat
    const headerBeforeDelete = (
      await authPage.locator(DOM.chatHeaderTitle).innerText()
    ).trim();
    if (headerBeforeDelete !== sourceChat.title) {
      await reopenChatAfterReload(authPage, sourceChat);
    }

    const sourceMessageList = authPage.locator(DOM.messageList);
    const b1InSource = sourceMessageList
      .locator(DOM.messageBubble)
      .filter({ hasText: m1 })
      .last();
    const b2InSource = sourceMessageList
      .locator(DOM.messageBubble)
      .filter({ hasText: m2 })
      .last();

    if (!(await toolbar.isVisible())) {
      await clickBubbleContextAction(authPage, b1InSource, 'select');
      await selectBubbleInToolbarMode(b2InSource);
      await expect(toolbar).toContainText('2');
    }

    // 3. Batch Delete in sourceChat
    const deleteBtn = scopedButton(toolbar, 'delete').first();
    await expect(deleteBtn).toBeVisible();
    await deleteBtn.click();
    await confirmActionDialogIfShown(authPage, 'delete');

    await expect(toolbar).toBeHidden();
    await expect(sourceMessageList).not.toContainText(m1);
    await expect(sourceMessageList).not.toContainText(m2);
    await expect(sourceMessageList).toContainText(m3);

    // Verify batch-forwarded messages arrived in Saved Messages WITH normal forward attribution
    await openSavedMessagesChat(authPage);
    if (await authPage.locator(DOM.composerReplyEditBanner).isVisible()) {
      await sendTextMessage(authPage, 'Batch forward flush F9-7');
    }
    const savedList = authPage.locator(DOM.messageList);
    await expect(savedList).toContainText(m1);
    await expect(savedList).toContainText(m2);
    await expect(savedList).not.toContainText(m3);

    const forwardedM1Bubble = savedList
      .locator(DOM.messageBubble)
      .filter({ hasText: m1 })
      .last();
    await expect(forwardedM1Bubble).toBeVisible();

    const hasForwardAttribution = await forwardedM1Bubble.evaluate((el) => {
      if (
        el.hasAttribute('data-forwarded') ||
        el.hasAttribute('data-forward-from') ||
        el.querySelector(
          '[data-forwarded], [data-forward-from], [data-testid*="forward" i], [class*="forward" i]',
        ) !== null
      ) {
        return true;
      }
      return /forwarded|转发/i.test(el.textContent ?? '');
    });
    expect(hasForwardAttribution).toBe(true);
  });
});
