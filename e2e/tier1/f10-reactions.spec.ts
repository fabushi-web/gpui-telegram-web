import type { Locator, Page } from '@playwright/test';
import {
  bilingualRegex,
  DATA_ATTRS,
  DOM,
  expect,
  getBaseUrl,
  messageBubbleById,
  openBurgerMenu,
  scopedButton,
  scopedTextbox,
  selectChat,
  sendTextMessage,
  test,
} from '../helpers';

interface SelectedPeerChat {
  row: Locator;
  chatId: string;
  title: string;
}

const EXPAND_BUTTON_ATTR_RE =
  /\b(?:more|expand|extend|show[-_\s]*all|all[-_\s]*emojis|chevron)\b|更多|展开/i;
const EXPAND_BUTTON_TEXT_SET = new Set([
  '',
  '+',
  '➕',
  '...',
  '…',
  '▼',
  '▾',
  '⌄',
  '∨',
  '›',
  '»',
  '🔽',
  '🔼',
  '⬇',
  '⬇️',
]);

async function selectWritablePeerChat(page: Page): Promise<SelectedPeerChat> {
  const chatList = page.locator(DOM.chatList);
  await expect(chatList).toBeVisible();

  const rows = chatList.locator(DOM.chatRow);
  const rowCount = await rows.count();
  expect(rowCount).toBeGreaterThan(0);

  const maxScan = Math.min(rowCount, 12);
  for (const allowSavedAndBots of [false, true]) {
    for (let i = 0; i < maxScan; i++) {
      const candidate = rows.nth(i);
      if (!(await candidate.isVisible())) continue;

      const chatId = (await candidate.getAttribute(DATA_ATTRS.chatId)) ?? '';
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
  const firstRow = rows.first();
  return {
    row: firstRow,
    chatId: (await firstRow.getAttribute(DATA_ATTRS.chatId)) ?? '',
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

async function selectGroupPreferredChat(page: Page): Promise<SelectedPeerChat> {
  const chatList = page.locator(DOM.chatList);
  await expect(chatList).toBeVisible();

  const rows = chatList.locator(DOM.chatRow);
  const rowCount = await rows.count();
  const maxScan = Math.min(rowCount, 12);

  for (let i = 0; i < maxScan; i++) {
    const candidate = rows.nth(i);
    if (!(await candidate.isVisible())) continue;

    const chatId = (await candidate.getAttribute(DATA_ATTRS.chatId)) ?? '';
    const rowText = (await candidate.innerText()).trim();
    if (/saved messages|收藏夹|已保存消息|botfather/i.test(rowText)) {
      continue;
    }

    const selectedRow = await selectChat(page, i);
    const topicList = page.locator(DOM.forumTopicList);
    const composer = page.locator(DOM.messageComposerInput);

    if ((await topicList.isVisible()) && !(await composer.isVisible())) {
      const firstTopic = page.locator(DOM.forumTopicItem).first();
      if ((await firstTopic.count()) > 0 && (await firstTopic.isVisible())) {
        await firstTopic.click();
      }
    }

    const statusText = (await page.locator(DOM.chatHeaderStatus).innerText()).trim();
    if (
      /member|成员/i.test(statusText) &&
      (await composer.isVisible()) &&
      (await composer.isEditable())
    ) {
      const title = (await page.locator(DOM.chatHeaderTitle).innerText()).trim();
      return { row: selectedRow, chatId, title };
    }
  }

  return selectWritablePeerChat(page);
}

function reactionPillsOnBubble(bubble: Locator): Locator {
  const pillSelector =
    '[data-testid*="reaction-pill" i], [data-testid*="reaction-chip" i], [data-reaction], button';
  const nestedPillMatch = bubble
    .page()
    .locator(pillSelector)
    .filter({ hasText: /\p{Extended_Pictographic}/u })
    .filter({ hasText: /\d+/ });

  return bubble
    .locator(pillSelector)
    .filter({ hasText: /\p{Extended_Pictographic}/u })
    .filter({ hasText: /\d+/ })
    .filter({ hasNot: nestedPillMatch });
}

function quickStripCandidates(page: Page): Locator {
  return page.locator(
    [
      '[data-testid*="quick-reaction" i]',
      '[data-testid*="reaction-strip" i]',
      '[data-testid*="reaction-bar" i]',
      '[data-testid*="reaction-quick" i]',
      '[role="toolbar"][aria-label*="react" i]',
      '[role="toolbar"][aria-label*="回应" i]',
      '[role="toolbar"][aria-label*="表情" i]',
      '[role="menu"][aria-label*="react" i]',
      '[role="menu"][aria-label*="回应" i]',
    ].join(', '),
  );
}

async function findVisibleQuickStrip(page: Page, bubble: Locator): Promise<Locator | null> {
  const explicitCandidates = quickStripCandidates(page);
  const explicitCount = await explicitCandidates.count();
  for (let i = 0; i < explicitCount; i++) {
    const item = explicitCandidates.nth(i);
    if (await item.isVisible()) {
      return item;
    }
  }

  // Structural fallback: floating toolbar/menu/popover with >= 7 quick reaction buttons
  const structural = page
    .locator('[role="toolbar"], [role="menu"], [data-popover], [data-floating]')
    .filter({ hasNot: page.locator(DOM.messageComposerInput) });
  const structCount = await structural.count();
  for (let i = 0; i < structCount; i++) {
    const candidate = structural.nth(i);
    if (!(await candidate.isVisible())) continue;
    const btnCount = await candidate.locator('button, [role="button"], [role="menuitem"]').count();
    if (btnCount >= 7 && btnCount <= 12) {
      return candidate;
    }
  }

  // Also check bubble-local floating strip
  const insideBubble = bubble.locator(
    '[data-testid*="reaction" i], [role="toolbar"], [class*="reaction-strip" i], [class*="quick-reaction" i]',
  );
  const insideCount = await insideBubble.count();
  for (let i = 0; i < insideCount; i++) {
    const candidate = insideBubble.nth(i);
    if (!(await candidate.isVisible())) continue;
    const btnCount = await candidate.locator('button, [role="button"]').count();
    if (btnCount >= 7 && btnCount <= 12) {
      return candidate;
    }
  }

  return null;
}

async function openQuickReactionStrip(page: Page, bubble: Locator): Promise<Locator> {
  await expect(bubble).toBeVisible();
  await bubble.hover();

  const immediateStrip = await findVisibleQuickStrip(page, bubble);
  if (immediateStrip) {
    return immediateStrip;
  }

  // Two-stage flow: floating hover reaction button -> 7-emoji quick strip
  const hoverTrigger = bubble
    .locator(
      [
        'button[aria-label*="react" i]',
        'button[aria-label*="表情" i]',
        'button[aria-label*="回应" i]',
        'button[title*="react" i]',
        'button[title*="回应" i]',
        '[data-testid*="hover-react" i]',
        '[data-testid*="reaction-trigger" i]',
        '[data-testid*="react-btn" i]',
      ].join(', '),
    )
    .or(
      page.locator(
        [
          '[data-testid*="hover-react" i]',
          '[data-testid*="reaction-trigger" i]',
          'button[aria-label*="add reaction" i]',
          'button[aria-label*="添加回应" i]',
          'button[aria-label*="表情回应" i]',
        ].join(', '),
      ),
    )
    .first();

  if ((await hoverTrigger.count()) > 0 && (await hoverTrigger.isVisible())) {
    await hoverTrigger.click();
  } else {
    // Fallback right-click context menu reaction strip
    await bubble.click({ button: 'right' });
  }

  await expect
    .poll(async () => (await findVisibleQuickStrip(page, bubble)) !== null, {
      message: 'Expected 7-emoji quick reaction strip to open for hovered message bubble',
      timeout: 6_000,
    })
    .toBe(true);

  const opened = await findVisibleQuickStrip(page, bubble);
  expect(opened).not.toBeNull();
  return opened!;
}

interface QuickStripInspection {
  emojis: string[];
  buttonIndices: number[];
  isOutOfFlow: boolean;
}

async function inspectQuickStripButtons(strip: Locator): Promise<QuickStripInspection> {
  return strip.evaluate(
    (el, { expandReSource, excludedTexts }) => {
      const expandRe = new RegExp(expandReSource, 'i');
      const excludedSet = new Set(excludedTexts);
      const emojiRegex = /\p{Extended_Pictographic}/u;

      const rawButtons = Array.from(
        el.querySelectorAll('button, [role="button"], [role="menuitem"]'),
      );
      const emojis: string[] = [];
      const buttonIndices: number[] = [];

      rawButtons.forEach((btn, idx) => {
        if (!(btn instanceof HTMLElement)) return;
        const style = window.getComputedStyle(btn);
        if (style.display === 'none' || style.visibility === 'hidden') return;

        const trimmedText = (btn.textContent ?? '').trim();
        const reactionAttr = (
          btn.getAttribute('data-reaction') ??
          btn.getAttribute('data-emoji') ??
          ''
        ).trim();
        const text = reactionAttr || trimmedText;

        if (excludedSet.has(text) || excludedSet.has(trimmedText)) return;
        if (!emojiRegex.test(text)) return;

        // Avoid counting reaction counter pills with digits inside bubble
        if (/\d/.test(text) && !btn.hasAttribute('data-reaction')) return;

        // Never exclude a button whose trimmed text is an emoji outside EXPAND_BUTTON_TEXT_SET
        const isEmojiOutsideExpandSet =
          emojiRegex.test(trimmedText) &&
          !excludedSet.has(trimmedText) &&
          !/[A-Za-z0-9\u4e00-\u9fff]/.test(trimmedText);

        if (!isEmojiOutsideExpandSet) {
          const meta = [
            btn.getAttribute('aria-label') ?? '',
            btn.getAttribute('title') ?? '',
            btn.getAttribute('data-testid') ?? '',
          ].join(' ');
          if (expandRe.test(meta)) return;
        }

        emojis.push(text);
        buttonIndices.push(idx);
      });

      let isOutOfFlow = false;
      let cursor: HTMLElement | null = el instanceof HTMLElement ? el : null;
      while (cursor && cursor !== document.body && cursor.id !== 'message-list') {
        const pos = window.getComputedStyle(cursor).position;
        if (pos === 'absolute' || pos === 'fixed') {
          isOutOfFlow = true;
          break;
        }
        cursor = cursor.parentElement;
      }

      return { emojis, buttonIndices, isOutOfFlow };
    },
    {
      expandReSource: EXPAND_BUTTON_ATTR_RE.source,
      excludedTexts: Array.from(EXPAND_BUTTON_TEXT_SET),
    },
  );
}

test.describe(
  'F10 — Out-of-Flow Hover Quick Reactions, 32-Emoji Picker & Reactor List',
  () => {
    test('F10.1: renders out-of-flow hover reaction trigger and 7-emoji quick strip with zero bubble layout shift', async ({
      authPage,
    }) => {
      await selectWritablePeerChat(authPage);

      const targetBubble = await sendTextMessage(
        authPage,
        'Zero jitter hover target F10-1',
      );
      const belowBubble = await sendTextMessage(
        authPage,
        'Neighbor layout canary F10-1',
      );

      // Move pointer away to capture unhovered baseline geometry
      await authPage.locator(DOM.chatHeaderTitle).hover();

      const boxBefore = await targetBubble.boundingBox();
      const belowBefore = await belowBubble.boundingBox();
      expect(boxBefore).not.toBeNull();
      expect(belowBefore).not.toBeNull();
      expect(boxBefore!.width).toBeGreaterThanOrEqual(80);
      expect(boxBefore!.height).toBeGreaterThanOrEqual(20);

      // Hover target bubble and verify zero layout shift (<= 0.5px)
      await targetBubble.hover();
      const boxOnHover = await targetBubble.boundingBox();
      const belowOnHover = await belowBubble.boundingBox();
      expect(boxOnHover).not.toBeNull();
      expect(belowOnHover).not.toBeNull();

      expect(Math.abs(boxOnHover!.x - boxBefore!.x)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(boxOnHover!.y - boxBefore!.y)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(boxOnHover!.width - boxBefore!.width)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(boxOnHover!.height - boxBefore!.height)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(belowOnHover!.y - belowBefore!.y)).toBeLessThanOrEqual(0.5);

      // Open 7-emoji quick strip and verify zero layout shift continues
      const strip = await openQuickReactionStrip(authPage, targetBubble);
      await expect(strip).toBeVisible();

      const boxWithStrip = await targetBubble.boundingBox();
      const belowWithStrip = await belowBubble.boundingBox();
      expect(boxWithStrip).not.toBeNull();
      expect(belowWithStrip).not.toBeNull();

      expect(Math.abs(boxWithStrip!.x - boxBefore!.x)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(boxWithStrip!.y - boxBefore!.y)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(boxWithStrip!.width - boxBefore!.width)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(boxWithStrip!.height - boxBefore!.height)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(belowWithStrip!.y - belowBefore!.y)).toBeLessThanOrEqual(0.5);

      // Verify exactly 7 quick emojis (excluding expand/more button) and out-of-flow positioning
      const info = await inspectQuickStripButtons(strip);
      expect(info.emojis.length).toBe(7);
      expect(info.isOutOfFlow).toBe(true);

      const chosenEmoji = info.emojis[0];
      const allButtons = strip.locator('button, [role="button"], [role="menuitem"]');
      await allButtons.nth(info.buttonIndices[0]).click();

      const pills = reactionPillsOnBubble(targetBubble);
      await expect(pills).toHaveCount(1);
      await expect(pills.first()).toContainText(chosenEmoji);
      await expect(pills.first()).toContainText('1');
    });

    test('F10.2: opens the 8x4 32-emoji extended reaction picker and applies an extended emoji reaction', async ({
      authPage,
    }) => {
      await selectWritablePeerChat(authPage);

      const bubble = await sendTextMessage(
        authPage,
        'Extended 32-emoji picker target F10-2',
      );
      const strip = await openQuickReactionStrip(authPage, bubble);
      const quickInfo = await inspectQuickStripButtons(strip);
      const quickSet = new Set(quickInfo.emojis);

      // Click expand/more control on the quick strip
      const explicitExpandBtn = strip.locator(
        [
          'button[aria-label*="more" i]',
          'button[aria-label*="expand" i]',
          'button[aria-label*="all" i]',
          'button[aria-label*="更多" i]',
          'button[aria-label*="展开" i]',
          'button[title*="more" i]',
          'button[title*="更多" i]',
          '[data-testid*="more" i]',
          '[data-testid*="expand" i]',
        ].join(', '),
      );
      const expandBtn =
        (await explicitExpandBtn.count()) > 0 &&
        (await explicitExpandBtn.first().isVisible())
          ? explicitExpandBtn.first()
          : strip.locator('button, [role="button"]').last();

      await expect(expandBtn).toBeVisible();
      await expandBtn.click();

      // Locate visible extended picker containing >= 32 leaf emoji buttons
      const pickerCandidates = authPage
        .locator(
          [
            '[data-testid*="extended-reaction" i]',
            '[data-testid*="reaction-picker" i]',
            '[data-testid*="reaction-grid" i]',
            '[data-testid*="emoji-grid" i]',
            '[role="dialog"]',
            '[role="grid"]',
            '[role="listbox"]',
            '[role="menu"]',
          ].join(', '),
        )
        .filter({ hasNot: authPage.locator(DOM.chatList) });

      let extendedPicker: Locator | null = null;
      await expect
        .poll(
          async () => {
            const count = await pickerCandidates.count();
            for (let i = 0; i < count; i++) {
              const cand = pickerCandidates.nth(i);
              if (!(await cand.isVisible())) continue;
              const leafEmojiCount = await cand.evaluate((el) => {
                const emojiRe = /\p{Extended_Pictographic}/u;
                return Array.from(
                  el.querySelectorAll(
                    'button, [role="button"], [role="gridcell"], [role="option"]',
                  ),
                ).filter((node) => {
                  if (!(node instanceof HTMLElement)) return false;
                  if (node.querySelector('button, [role="button"]') !== null) {
                    return false;
                  }
                  const st = window.getComputedStyle(node);
                  if (st.display === 'none' || st.visibility === 'hidden') {
                    return false;
                  }
                  const txt = (node.textContent ?? '').trim();
                  return txt.length > 0 && txt.length <= 8 && emojiRe.test(txt);
                }).length;
              });
              if (leafEmojiCount >= 32) {
                extendedPicker = cand;
                return leafEmojiCount;
              }
            }
            return 0;
          },
          {
            message: 'Expected extended reaction picker with >= 32 emoji buttons to open',
            timeout: 6_000,
          },
        )
        .toBeGreaterThanOrEqual(32);

      expect(extendedPicker).not.toBeNull();

      // Verify 8x4 (8 columns x >= 4 rows) grid layout with ±5px row y tolerance using leaf buttons
      const gridMetrics = await extendedPicker!.evaluate((el) => {
        const emojiRe = /\p{Extended_Pictographic}/u;
        const buttons = Array.from(
          el.querySelectorAll(
            'button, [role="button"], [role="gridcell"], [role="option"]',
          ),
        ).filter((node): node is HTMLElement => {
          if (!(node instanceof HTMLElement)) return false;
          if (node.querySelector('button, [role="button"]') !== null) {
            return false;
          }
          const st = window.getComputedStyle(node);
          if (st.display === 'none' || st.visibility === 'hidden') return false;
          const txt = (node.textContent ?? '').trim();
          return txt.length > 0 && txt.length <= 8 && emojiRe.test(txt);
        });

        const items = buttons.slice(0, 32).map((btn, idx) => {
          const r = btn.getBoundingClientRect();
          return {
            idx,
            emoji: (btn.textContent ?? '').trim(),
            x: r.left,
            y: r.top,
          };
        });

        return {
          totalCount: buttons.length,
          items,
        };
      });

      expect(gridMetrics.totalCount).toBeGreaterThanOrEqual(32);
      expect(gridMetrics.items.length).toBe(32);

      // Row 1 (indices 0..7): same row within ±5px y tolerance and strictly increasing x
      const row0Y = gridMetrics.items[0].y;
      for (let col = 1; col < 8; col++) {
        expect(Math.abs(gridMetrics.items[col].y - row0Y)).toBeLessThanOrEqual(5);
        expect(gridMetrics.items[col].x).toBeGreaterThan(
          gridMetrics.items[col - 1].x,
        );
      }

      // Item 8 wraps to Row 2 Column 1
      expect(gridMetrics.items[8].y).toBeGreaterThan(row0Y + 10);
      expect(gridMetrics.items[8].x).toBeLessThan(gridMetrics.items[7].x);

      // Distinct rows across 32 items >= 4 (8x4 = 32)
      const rowClusters: number[] = [];
      for (const item of gridMetrics.items) {
        if (!rowClusters.some((ry) => Math.abs(ry - item.y) <= 5)) {
          rowClusters.push(item.y);
        }
      }
      expect(rowClusters.length).toBeGreaterThanOrEqual(4);

      // Pick an extended emoji at index >= 12 not in quickSet and click via matching text
      const targetEntry =
        gridMetrics.items
          .slice(12)
          .find((entry) => !quickSet.has(entry.emoji)) ?? gridMetrics.items[15];

      const targetEmojiBtn = extendedPicker!
        .locator('button, [role="button"]')
        .filter({ hasText: targetEntry.emoji })
        .first();

      if (
        (await targetEmojiBtn.count()) > 0 &&
        (await targetEmojiBtn.isVisible())
      ) {
        await targetEmojiBtn.click();
      } else {
        await extendedPicker!
          .locator('[role="gridcell"], [role="option"]')
          .filter({ hasText: targetEntry.emoji })
          .first()
          .click();
      }

      const pills = reactionPillsOnBubble(bubble);
      await expect(pills).toHaveCount(1);
      await expect(pills.first()).toContainText(targetEntry.emoji);
      await expect(pills.first()).toContainText('1');
    });

    test('F10.3: toggles own reaction pill incrementing and decrementing count with active is_chosen_by_me state', async ({
      authPage,
    }) => {
      const activeChat = await selectWritablePeerChat(authPage);

      const targetText = 'Toggle reaction chosen state F10-3';
      const bubble = await sendTextMessage(authPage, targetText);
      const msgId = await bubble.getAttribute(DATA_ATTRS.messageId);
      expect(msgId).toBeTruthy();

      await expect(reactionPillsOnBubble(bubble)).toHaveCount(0);

      // Toggle ON (0 -> 1)
      const strip = await openQuickReactionStrip(authPage, bubble);
      const info = await inspectQuickStripButtons(strip);
      expect(info.emojis.length).toBeGreaterThanOrEqual(1);
      const chosenEmoji = info.emojis[0];

      await strip
        .locator('button, [role="button"], [role="menuitem"]')
        .nth(info.buttonIndices[0])
        .click();

      const pills = reactionPillsOnBubble(bubble);
      await expect(pills).toHaveCount(1);

      const pill = pills.first();
      await expect(pill).toBeVisible();
      await expect(pill).toContainText(chosenEmoji);
      await expect(pill).toContainText('1');

      // Verify active is_chosen_by_me state and non-transparent pill fill (supporting wrapper or leaf button)
      const chosenState = await pill.evaluate((el) => {
        if (!(el instanceof HTMLElement)) {
          return { hasChosenMarker: false, hasBackground: false };
        }
        const wrapper = el.closest(
          '[data-testid*="reaction-pill" i], [data-testid*="reaction-chip" i], [data-reaction]',
        );
        const candidates = [
          el,
          ...(wrapper instanceof HTMLElement && wrapper !== el ? [wrapper] : []),
        ];
        const hasChosenMarker = candidates.some((node) => {
          const ariaPressed = node.getAttribute('aria-pressed') === 'true';
          const ariaChecked = node.getAttribute('aria-checked') === 'true';
          const dataChosen =
            node.dataset.chosen === 'true' ||
            node.dataset.chosenByMe === 'true' ||
            node.dataset.isChosen === 'true' ||
            node.dataset.isChosenByMe === 'true' ||
            node.dataset.active === 'true' ||
            node.dataset.selected === 'true';
          const classChosen = /\b(chosen|is-chosen|chosen-by-me|active|selected)\b/i.test(
            node.className,
          );
          return ariaPressed || ariaChecked || dataChosen || classChosen;
        });
        const hasBackground = candidates.some((node) => {
          const bg = window.getComputedStyle(node).backgroundColor;
          return Boolean(bg) && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)';
        });
        return {
          hasChosenMarker,
          hasBackground,
        };
      });

      expect(chosenState.hasChosenMarker).toBe(true);
      expect(chosenState.hasBackground).toBe(true);

      // Toggle OFF (1 -> 0) by clicking pill directly
      await pill.click();
      await expect(reactionPillsOnBubble(bubble)).toHaveCount(0);

      // Toggle ON again (0 -> 1) and verify reload persistence
      const stripAgain = await openQuickReactionStrip(authPage, bubble);
      const infoAgain = await inspectQuickStripButtons(stripAgain);
      await stripAgain
        .locator('button, [role="button"], [role="menuitem"]')
        .nth(infoAgain.buttonIndices[0])
        .click();

      await expect(reactionPillsOnBubble(bubble)).toHaveCount(1);

      await authPage.reload({ waitUntil: 'domcontentloaded' });
      await expect(authPage.locator(DOM.appShell)).toBeVisible();
      await reopenChatAfterReload(authPage, activeChat);

      const persistedBubble = authPage
        .locator(DOM.messageList)
        .locator(messageBubbleById(msgId!));
      await expect(persistedBubble).toBeVisible();
      const persistedPills = reactionPillsOnBubble(persistedBubble);
      await expect(persistedPills).toHaveCount(1);
      await expect(persistedPills.first()).toContainText(chosenEmoji);
      await expect(persistedPills.first()).toContainText('1');
    });

    test('F10.4: renders multiple distinct reaction emoji pills on a single message bubble', async ({
      authPage,
    }) => {
      // Prefer a shared Group chat so multi-user fallback can also join/open the same chat
      const activeGroupOrChat = await selectGroupPreferredChat(authPage);

      const messageList = authPage.locator(DOM.messageList);
      const targetMsgText = 'Multi-emoji reaction chips F10-4';
      const bubble = await sendTextMessage(authPage, targetMsgText);

      // Add first emoji reaction
      const strip1 = await openQuickReactionStrip(authPage, bubble);
      const info1 = await inspectQuickStripButtons(strip1);
      expect(info1.emojis.length).toBeGreaterThanOrEqual(4);
      const emojiA = info1.emojis[0];
      const emojiB = info1.emojis[2];

      await strip1
        .locator('button, [role="button"], [role="menuitem"]')
        .nth(info1.buttonIndices[0])
        .click();
      await expect(reactionPillsOnBubble(bubble)).toHaveCount(1);
      await expect(reactionPillsOnBubble(bubble).first()).toContainText(emojiA);

      // Add second distinct emoji reaction on the same bubble
      await authPage.locator(DOM.chatHeaderTitle).hover();
      const strip2 = await openQuickReactionStrip(authPage, bubble);
      const info2 = await inspectQuickStripButtons(strip2);
      const idxB = info2.emojis.indexOf(emojiB);
      const buttonIdxB = idxB >= 0 ? info2.buttonIndices[idxB] : info2.buttonIndices[2];

      await strip2
        .locator('button, [role="button"], [role="menuitem"]')
        .nth(buttonIdxB)
        .click();

      let currentPillCount = await reactionPillsOnBubble(bubble).count();
      let targetBubbleForMultiCheck = bubble;

      // If per-user reaction cap is 1 (replacing emojiA with emojiB), scan pre-reacted peer bubbles across chats first
      if (currentPillCount < 2) {
        const tryReactOnPreReactedBubble = async (): Promise<boolean> => {
          const existingReactedBubbles = messageList
            .locator(DOM.messageBubble)
            .filter({ hasNotText: targetMsgText });
          const existingCount = await existingReactedBubbles.count();
          for (let i = 0; i < existingCount; i++) {
            const cand = existingReactedBubbles.nth(i);
            const candPills = reactionPillsOnBubble(cand);
            if ((await candPills.count()) >= 1 && (await cand.isVisible())) {
              const existingPillText = await candPills.first().innerText();
              const s = await openQuickReactionStrip(authPage, cand);
              const sInfo = await inspectQuickStripButtons(s);
              const pickIdx = sInfo.emojis.findIndex(
                (em) => !existingPillText.includes(em),
              );
              if (pickIdx >= 0) {
                await s
                  .locator('button, [role="button"], [role="menuitem"]')
                  .nth(sInfo.buttonIndices[pickIdx])
                  .click();
                if ((await reactionPillsOnBubble(cand).count()) >= 2) {
                  targetBubbleForMultiCheck = cand;
                  currentPillCount = await reactionPillsOnBubble(cand).count();
                  return true;
                }
              }
            }
          }
          return false;
        };

        if (!(await tryReactOnPreReactedBubble())) {
          const chatRows = authPage.locator(DOM.chatList).locator(DOM.chatRow);
          const scanRows = Math.min(await chatRows.count(), 6);
          for (let rIdx = 0; rIdx < scanRows; rIdx++) {
            await selectChat(authPage, rIdx);
            const topicList = authPage.locator(DOM.forumTopicList);
            const composer = authPage.locator(DOM.messageComposerInput);
            if ((await topicList.isVisible()) && !(await composer.isVisible())) {
              const firstTopic = authPage.locator(DOM.forumTopicItem).first();
              if ((await firstTopic.count()) > 0 && (await firstTopic.isVisible())) {
                await firstTopic.click();
              }
            }
            if (await tryReactOnPreReactedBubble()) {
              break;
            }
          }
          if (currentPillCount < 2) {
            await reopenChatAfterReload(authPage, activeGroupOrChat);
            targetBubbleForMultiCheck = messageList
              .locator(DOM.messageBubble)
              .filter({ hasText: targetMsgText })
              .last();
          }
        }
      }

      if (currentPillCount < 2) {
        // Open second isolated BrowserContext, authenticate a second user, open the same shared Group chat, and react with a distinct emoji
        const browser = authPage.context().browser();
        expect(browser).not.toBeNull();
        const ctx2 = await browser!.newContext();
        try {
          const page2 = await ctx2.newPage();
          await page2.goto(`${getBaseUrl()}/`, { waitUntil: 'domcontentloaded' });
          const authScreen2 = page2.locator(DOM.authScreen);
          if (await authScreen2.isVisible()) {
            const pwdTab = page2.locator(DOM.tabAuthPassword);
            if (await pwdTab.isVisible()) {
              await pwdTab.click();
              const regToggle = page2.locator(DOM.authModeRegisterToggle);
              if (await regToggle.isVisible()) {
                await regToggle.click();
              }
              await page2.locator(DOM.authUsernameInput).fill('reactor_peer_f10');
              await page2.locator(DOM.authPasswordInput).fill('ValidPass#2026');
              await page2.locator(DOM.btnAuthPasswordSubmit).click();
            } else {
              await page2.locator(DOM.btnDemoLogin).click();
            }
          }
          await expect(page2.locator(DOM.appShell)).toBeVisible();
          await expect(page2.locator(DOM.chatList)).toBeVisible();

          let sharedChatTitle = activeGroupOrChat.title;
          let sharedMsgText = targetMsgText;

          const existingRowOnPage2 = page2
            .locator(DOM.chatList)
            .locator(DOM.chatRow)
            .filter({ hasText: sharedChatTitle });

          // If page2 is not yet in activeGroupOrChat, create a shared Group on authPage inviting reactor_peer_f10
          if ((await existingRowOnPage2.count()) === 0) {
            await openBurgerMenu(authPage);
            const newGroupItem = authPage.locator(DOM.menuItemNewGroup);
            if ((await newGroupItem.count()) > 0 && (await newGroupItem.isVisible())) {
              await newGroupItem.click();
              const groupModal = authPage.locator(DOM.modalCreateGroup);
              await expect(groupModal).toBeVisible();

              const searchMember = scopedTextbox(groupModal, 'search');
              if ((await searchMember.count()) > 0 && (await searchMember.first().isVisible())) {
                await searchMember.first().fill('reactor_peer_f10');
              }

              const peerOpt = groupModal
                .locator(
                  'input[type="checkbox"], [role="checkbox"], [role="option"], [data-peer-id], [data-user-id], li button',
                )
                .filter({ hasText: /reactor_peer_f10/i })
                .first();
              if ((await peerOpt.count()) > 0 && (await peerOpt.isVisible())) {
                await peerOpt.click();
              } else {
                const anyPeer = groupModal
                  .locator(
                    'input[type="checkbox"], [role="checkbox"], [role="option"], [data-peer-id], [data-user-id], li button',
                  )
                  .first();
                if ((await anyPeer.count()) > 0 && (await anyPeer.isVisible())) {
                  await anyPeer.click();
                }
              }

              const explicitGroupTitle = scopedTextbox(
                groupModal,
                bilingualRegex('group\\s*name|title|name', '群组名称|群名称|标题|名称'),
              ).filter({
                hasNot: groupModal.locator(
                  '[placeholder*="search" i], [aria-label*="search" i], [placeholder*="搜索"], [aria-label*="搜索"]',
                ),
              });
              if (
                (await explicitGroupTitle.count()) === 0 ||
                !(await explicitGroupTitle.first().isVisible())
              ) {
                const nextBtn = scopedButton(groupModal, 'next').first();
                if ((await nextBtn.count()) > 0 && (await nextBtn.isVisible())) {
                  await nextBtn.click();
                }
              }

              const nonSearchInput = groupModal.locator(
                'input[type="text"]:not([placeholder*="search" i]):not([aria-label*="search" i]):not([placeholder*="搜索"]):not([aria-label*="搜索"])',
              );
              const groupTitleField =
                (await explicitGroupTitle.count()) > 0 &&
                (await explicitGroupTitle.first().isVisible())
                  ? explicitGroupTitle.first()
                  : nonSearchInput.first();

              sharedChatTitle = 'F10 Shared Reactor Group';
              await expect(groupTitleField).toBeVisible();
              await groupTitleField.fill(sharedChatTitle);
              await scopedButton(groupModal, 'confirm').last().click();
              await expect(groupModal).toBeHidden();

              sharedMsgText = 'Shared group multi-emoji target F10-4B';
              targetBubbleForMultiCheck = await sendTextMessage(
                authPage,
                sharedMsgText,
              );
              const sAuth = await openQuickReactionStrip(
                authPage,
                targetBubbleForMultiCheck,
              );
              const sAuthInfo = await inspectQuickStripButtons(sAuth);
              await sAuth
                .locator('button, [role="button"], [role="menuitem"]')
                .nth(sAuthInfo.buttonIndices[0])
                .click();
            }
          }

          // Ensure page2 explicitly selects and opens the shared Group chat
          await selectChat(page2, sharedChatTitle);
          const topicList2 = page2.locator(DOM.forumTopicList);
          const composer2 = page2.locator(DOM.messageComposerInput);
          if ((await topicList2.isVisible()) && !(await composer2.isVisible())) {
            const firstTopic2 = page2.locator(DOM.forumTopicItem).first();
            if ((await firstTopic2.count()) > 0 && (await firstTopic2.isVisible())) {
              await firstTopic2.click();
            }
          }
          await expect(page2.locator(DOM.messageList)).toBeVisible();

          const activeAuthPillText = (
            await reactionPillsOnBubble(targetBubbleForMultiCheck)
              .first()
              .innerText()
          ).trim();

          const sharedBubble2 = page2
            .locator(DOM.messageList)
            .locator(DOM.messageBubble)
            .filter({ hasText: sharedMsgText })
            .last();
          await expect(sharedBubble2).toBeVisible();

          const s2 = await openQuickReactionStrip(page2, sharedBubble2);
          const s2Info = await inspectQuickStripButtons(s2);
          const distinctIdx = s2Info.emojis.findIndex(
            (em) => !activeAuthPillText.includes(em),
          );
          const pickButtonIdx =
            distinctIdx >= 0
              ? s2Info.buttonIndices[distinctIdx]
              : s2Info.buttonIndices[0];
          await s2
            .locator('button, [role="button"], [role="menuitem"]')
            .nth(pickButtonIdx)
            .click();
        } finally {
          await ctx2.close();
        }
      }

      const finalPills = reactionPillsOnBubble(targetBubbleForMultiCheck);
      await expect
        .poll(async () => finalPills.count(), {
          message: 'Expected >= 2 distinct reaction emoji pills on target message bubble',
          timeout: 6_000,
        })
        .toBeGreaterThanOrEqual(2);

      const pillDetails = await finalPills.evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          return {
            text: (el.textContent ?? '').trim(),
            x: r.left,
            y: r.top,
            width: r.width,
            height: r.height,
          };
        }),
      );

      expect(pillDetails.length).toBeGreaterThanOrEqual(2);
      expect(pillDetails[0].text).not.toBe(pillDetails[1].text);
      expect(pillDetails[0].width).toBeGreaterThan(16);
      expect(pillDetails[1].width).toBeGreaterThan(16);
    });

    test('F10.5: opens Reactor List popover and displays reactor avatars, names, and reacted emojis', async ({
      authPage,
    }) => {
      await selectWritablePeerChat(authPage);

      const bubble = await sendTextMessage(
        authPage,
        'Reactor list inspection F10-5',
      );
      const strip = await openQuickReactionStrip(authPage, bubble);
      const info = await inspectQuickStripButtons(strip);
      const reactedEmoji = info.emojis[0];

      await strip
        .locator('button, [role="button"], [role="menuitem"]')
        .nth(info.buttonIndices[0])
        .click();

      const pill = reactionPillsOnBubble(bubble).first();
      await expect(pill).toBeVisible();

      const inspectReactorSurface = async (surface: Locator) => {
        return surface.evaluate((el) => {
          const rawText = (el.textContent ?? '').trim();
          const hasExplicitReactorNode =
            el.matches('[data-testid*="reactor" i], [data-popover*="reactor" i]') ||
            el.querySelector(
              '[data-testid*="reactor" i], [data-reactor], [class*="reactor" i]',
            ) !== null;

          // Reject generic message context menus (Reply/Edit/Delete/Forward) lacking dedicated reactor entries
          const hasGenericMessageActions =
            /\b(?:reply|edit|delete|forward|pin|select)\b|回复|编辑|删除|转发|置顶|多选/i.test(
              rawText,
            );
          const isGenericActionMenu =
            hasGenericMessageActions && !hasExplicitReactorNode;

          // Require genuine avatar elements (NO raw 'svg' so 18x18 action menu icons cannot pass)
          const avatarCandidates = Array.from(
            el.querySelectorAll(
              'img, [data-avatar], [data-peer-avatar], [class*="avatar" i], [data-testid*="avatar" i]',
            ),
          );
          const hasSizedAvatar = avatarCandidates.some((av) => {
            const r = av.getBoundingClientRect();
            return r.width >= 16 && r.height >= 16;
          });

          const strippedNameText = rawText
            .replace(/\p{Extended_Pictographic}/gu, '')
            .replace(/\b\d+\b/g, '')
            .replace(
              /\b(?:reply|edit|delete|forward|pin|copy|select|reactions?)\b|回复|编辑|删除|转发|置顶|复制|多选|回应/gi,
              '',
            )
            .trim();
          const hasEmoji = /\p{Extended_Pictographic}/u.test(rawText);

          return {
            isGenericActionMenu,
            hasSizedAvatar,
            nameLength: strippedNameText.length,
            hasEmoji,
            rawText,
          };
        });
      };

      const reactorPopoverLocator = authPage
        .locator(
          [
            '[data-testid*="reactor" i]',
            '[data-popover*="reactor" i]',
            '[role="dialog"][aria-label*="react" i]',
            '[role="dialog"][aria-label*="回应" i]',
            '[role="tooltip"]',
          ].join(', '),
        )
        .filter({ hasNot: authPage.locator(DOM.chatList) });

      let reactorSurface: Locator | null = null;

      // Path A: Hover reaction pill — ONLY accept tooltip/popover if it contains a genuine avatar
      await pill.hover();
      await authPage.waitForTimeout(350);
      const hoverCount = await reactorPopoverLocator.count();
      for (let i = 0; i < hoverCount; i++) {
        const cand = reactorPopoverLocator.nth(i);
        if (!(await cand.isVisible())) continue;
        const check = await inspectReactorSurface(cand);
        if (!check.isGenericActionMenu && check.hasSizedAvatar) {
          reactorSurface = cand;
          break;
        }
      }

      // Path B: Context menu on bubble -> Reactions / Who Reacted item or embedded reactor rows
      if (!reactorSurface) {
        await bubble.click({ button: 'right' });
        const menu = authPage
          .locator('[role="menu"], [data-testid="context-menu"], [data-context-menu]')
          .first();
        if (await menu.isVisible()) {
          const reactionsItem = menu
            .locator('[role="menuitem"], button')
            .filter({
              hasText:
                /reaction|reactor|who reacted|\d+\s*reaction|回应|表态|查看.*回应/i,
            })
            .first();
          if ((await reactionsItem.count()) > 0 && (await reactionsItem.isVisible())) {
            await reactionsItem.click();
            if (
              (await reactorPopoverLocator.count()) > 0 &&
              (await reactorPopoverLocator.first().isVisible())
            ) {
              const popCand = reactorPopoverLocator.first();
              const popCheck = await inspectReactorSurface(popCand);
              if (!popCheck.isGenericActionMenu && popCheck.hasSizedAvatar) {
                reactorSurface = popCand;
              }
            }
            if (!reactorSurface && (await menu.isVisible())) {
              const menuCheck = await inspectReactorSurface(menu);
              if (!menuCheck.isGenericActionMenu && menuCheck.hasSizedAvatar) {
                reactorSurface = menu;
              }
            }
          } else {
            const menuCheck = await inspectReactorSurface(menu);
            if (!menuCheck.isGenericActionMenu && menuCheck.hasSizedAvatar) {
              reactorSurface = menu;
            } else {
              await authPage.keyboard.press('Escape');
            }
          }
        }
      }

      // Path C: Right-click directly on reaction pill
      if (!reactorSurface) {
        await pill.click({ button: 'right' });
        const explicitPop = reactorPopoverLocator.first();
        if ((await explicitPop.count()) > 0 && (await explicitPop.isVisible())) {
          reactorSurface = explicitPop;
        } else {
          reactorSurface = authPage
            .locator('[role="dialog"], [role="menu"]')
            .filter({ hasNot: authPage.locator(DOM.chatList) })
            .first();
        }
      }

      expect(reactorSurface).not.toBeNull();
      await expect(reactorSurface!).toBeVisible();

      const reactorValidation = await inspectReactorSurface(reactorSurface!);

      expect(reactorValidation.isGenericActionMenu).toBe(false);
      expect(reactorValidation.hasSizedAvatar).toBe(true);
      expect(reactorValidation.nameLength).toBeGreaterThanOrEqual(2);
      expect(reactorValidation.hasEmoji).toBe(true);
      expect(reactorValidation.rawText).toContain(reactedEmoji);

      await authPage.keyboard.press('Escape');
      await expect(reactorSurface!).toBeHidden();
    });
  },
);
