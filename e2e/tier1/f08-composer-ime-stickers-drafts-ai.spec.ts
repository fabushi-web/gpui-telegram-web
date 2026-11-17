import type { Locator, Page } from '@playwright/test';
import {
  bilingualRegex,
  BILINGUAL_PATTERNS,
  chatRowById,
  DATA_ATTRS,
  DOM,
  expect,
  parseCssRgba,
  readComposerText,
  scopedButton,
  scopedMenuItem,
  scopedTab,
  scopedTextbox,
  selectChat,
  simulateCjkImeComposition,
  test,
} from '../helpers';

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

async function selectAllComposerText(composer: Locator): Promise<void> {
  await composer.focus();
  await composer.evaluate((el: Element) => {
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      el.focus();
      el.setSelectionRange(0, el.value.length);
      return;
    }
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
  });
}

async function submitCurrentComposer(page: Page): Promise<void> {
  const sendBtn = page.locator(DOM.btnSendMessage);
  if ((await sendBtn.isVisible()) && (await sendBtn.isEnabled())) {
    await sendBtn.click();
  } else {
    await page.locator(DOM.messageComposerInput).press('Enter');
  }
}

test.describe('F8 — Canonical Composer, 3-State CJK IME Safety FSM, Formatting, Stickers/GIFs & Drafts', () => {
  test('F8-1: #message-composer-input auto-expanding [44px..192px] height and Shift+Enter newline vs Enter send', async ({
    authPage,
  }) => {
    await selectWritableChat(authPage);

    const composer = authPage.locator(DOM.messageComposerInput);
    const msgList = authPage.locator(DOM.messageList);
    await expect(composer).toBeVisible();
    await composer.fill('');
    await composer.focus();

    const measureComposerMetrics = async () =>
      composer.evaluate((el: Element) => {
        const selfRect = el.getBoundingClientRect();
        const parentRect = el.parentElement?.getBoundingClientRect();
        // Account for <textarea> hosted inside a 44px..192px wrapper shell
        const effectiveHeight =
          selfRect.height >= 36
            ? selfRect.height
            : parentRect?.height ?? selfRect.height;
        const hasScrollOverflow =
          el.scrollHeight > el.clientHeight + 2 ||
          (el.parentElement
            ? el.parentElement.scrollHeight > el.parentElement.clientHeight + 2
            : false);
        return {
          height: effectiveHeight,
          hasScrollOverflow,
        };
      });

    const initialMetrics = await measureComposerMetrics();
    expect(initialMetrics.height).toBeGreaterThanOrEqual(36);
    expect(initialMetrics.height).toBeLessThanOrEqual(64);

    const countBefore = await msgList.locator(DOM.messageBubble).count();

    // Type 5 lines separated by Shift+Enter -> must NOT send prematurely
    await composer.pressSequentially('Line 1');
    for (let line = 2; line <= 5; line++) {
      await composer.press('Shift+Enter');
      await composer.pressSequentially(`Line ${line}`);
    }

    expect(await msgList.locator(DOM.messageBubble).count()).toBe(countBefore);
    const fiveLineText = await readComposerText(composer);
    expect(fiveLineText).toContain('Line 1\nLine 2\nLine 3\nLine 4\nLine 5');

    const fiveLineMetrics = await measureComposerMetrics();
    expect(fiveLineMetrics.height).toBeGreaterThan(initialMetrics.height + 20);
    expect(fiveLineMetrics.height).toBeLessThanOrEqual(194);

    // Append 12 additional lines (17 total) -> capped at <= 192px (+2px border subpixel tolerance) with scroll overflow
    for (let line = 6; line <= 17; line++) {
      await composer.press('Shift+Enter');
      await composer.pressSequentially(`Line ${line}`);
    }

    const cappedMetrics = await measureComposerMetrics();
    expect(cappedMetrics.height).toBeLessThanOrEqual(194);
    expect(cappedMetrics.hasScrollOverflow).toBe(true);

    // Plain Enter sends the multi-line message and shrinks composer back near baseline height
    await composer.press('Enter');

    const sentMultiLine = msgList
      .locator(DOM.messageBubble)
      .filter({ hasText: 'Line 17' })
      .last();
    await expect(sentMultiLine).toBeVisible();
    await expect(sentMultiLine).toContainText('Line 1');

    expect(await readComposerText(composer)).toBe('');
    const resetMetrics = await measureComposerMetrics();
    expect(Math.abs(resetMetrics.height - initialMetrics.height)).toBeLessThanOrEqual(
      10,
    );
  });

  test('F8-2: 3-state CJK IME happy-path composition commit and send via simulateCjkImeComposition', async ({
    authPage,
  }) => {
    await selectWritableChat(authPage);

    const composer = authPage.locator(DOM.messageComposerInput);
    const msgList = authPage.locator(DOM.messageList);
    const targetPhrase = '你好世界，欢迎体验网页版';

    await composer.fill('');
    const matchingBubbles = msgList
      .locator(DOM.messageBubble)
      .filter({ hasText: '你好世界' });
    const countBefore = await matchingBubbles.count();

    // Phrase 1: Idle -> Composing(nihaoshijie) -> Enter(229, isComposing: true) -> Committed(你好世界)
    await simulateCjkImeComposition(composer, 'nihaoshijie', '你好世界');
    expect(await matchingBubbles.count()).toBe(countBefore);
    expect(await readComposerText(composer)).toBe('你好世界');

    // Phrase 2 chained at caret end: Composing -> Committed(，欢迎体验网页版)
    await simulateCjkImeComposition(
      composer,
      'huanyingtiyanwangyeban',
      '，欢迎体验网页版',
    );
    expect(await matchingBubbles.count()).toBe(countBefore);
    expect(await readComposerText(composer)).toBe(targetPhrase);

    // Subsequent Idle Enter genuinely sends the composed CJK message
    await composer.press('Enter');

    await expect
      .poll(async () => matchingBubbles.count(), {
        message: 'Expected Idle Enter after IME composition to send exactly 1 bubble',
      })
      .toBe(countBefore + 1);

    await expect(matchingBubbles.last()).toContainText(targetPhrase);
    expect(await readComposerText(composer)).toBe('');
  });

  test('F8-3: #btn-formatting-toolbar and keyboard shortcuts (Ctrl+B/I/U/Shift+X/Shift+M/Shift+P/K) applying rich formatting', async ({
    authPage,
  }) => {
    await selectWritableChat(authPage);

    const composer = authPage.locator(DOM.messageComposerInput);
    const fmtBtn = authPage.locator(DOM.btnFormattingToolbar);
    const msgList = authPage.locator(DOM.messageList);

    await expect(fmtBtn).toBeVisible();
    await fmtBtn.click();

    const middleCol = authPage.locator(DOM.middleColumn);
    const boldToolbarBtn = scopedButton(
      middleCol,
      bilingualRegex('\\bbold\\b', '粗体|加粗'),
    ).first();
    await expect(boldToolbarBtn).toBeVisible();

    // 1. Toolbar button click -> Bold
    await composer.fill('ToolbarBoldToken');
    await selectAllComposerText(composer);
    await boldToolbarBtn.click();
    await submitCurrentComposer(authPage);

    const toolbarBubble = msgList
      .locator(DOM.messageBubble)
      .filter({ hasText: 'ToolbarBoldToken' })
      .last();
    await expect(toolbarBubble).toBeVisible();
    await expect(
      toolbarBubble
        .locator('strong, b, [data-entity-type*="bold" i]')
        .filter({ hasText: 'ToolbarBoldToken' })
        .first(),
    ).toBeVisible();

    // 2. All 6 inline keyboard shortcuts: Ctrl+B, Ctrl+I, Ctrl+U, Ctrl+Shift+X, Ctrl+Shift+M, Ctrl+Shift+P
    const shortcutSpecs = [
      {
        chord: 'Control+b',
        token: 'KeyBoldSeg',
        selector: 'strong, b, [data-entity-type*="bold" i]',
      },
      {
        chord: 'Control+i',
        token: 'KeyItalicSeg',
        selector: 'em, i, [data-entity-type*="italic" i]',
      },
      {
        chord: 'Control+u',
        token: 'KeyUnderlineSeg',
        selector: 'u, ins, [data-entity-type*="underline" i], [style*="underline"]',
      },
      {
        chord: 'Control+Shift+X',
        token: 'KeyStrikeSeg',
        selector: 's, del, strike, [data-entity-type*="strike" i], [style*="line-through"]',
      },
      {
        chord: 'Control+Shift+M',
        token: 'KeyMonoSeg',
        selector: 'code, [data-entity-type*="code" i]',
      },
      {
        chord: 'Control+Shift+P',
        token: 'KeySpoilerSeg',
        selector: '[data-spoiler], [data-entity-type*="spoiler" i], [class*="spoiler" i]',
      },
    ] as const;

    for (const spec of shortcutSpecs) {
      await composer.fill(spec.token);
      await selectAllComposerText(composer);
      await authPage.keyboard.press(spec.chord);
      await submitCurrentComposer(authPage);

      const b = msgList
        .locator(DOM.messageBubble)
        .filter({ hasText: spec.token })
        .last();
      await expect(b).toBeVisible();
      await expect(b.locator(spec.selector).first()).toBeVisible();
    }

    // 3. Ctrl+K Insert Link shortcut
    await composer.fill('KeyLinkAnchor');
    await selectAllComposerText(composer);
    await authPage.keyboard.press('Control+k');

    const linkDialog = authPage.locator('[role="dialog"]:visible').first();
    if ((await linkDialog.count()) > 0) {
      const urlInput = scopedTextbox(
        linkDialog,
        bilingualRegex('url|link|http', '链接|网址|地址'),
      )
        .or(linkDialog.locator('input:visible').last())
        .first();
      await expect(urlInput).toBeVisible();
      await urlInput.fill('https://telegram.org');
      const applyLinkBtn = scopedButton(
        linkDialog,
        BILINGUAL_PATTERNS.confirm,
      ).first();
      await expect(applyLinkBtn).toBeVisible();
      await applyLinkBtn.click();
    } else {
      const currentVal = await readComposerText(composer);
      if (currentVal.includes('(') && currentVal.includes(')')) {
        const replaced = currentVal.replace(
          /\((?:url|https?:\/\/[^)]*)?\)/i,
          '(https://telegram.org)',
        );
        await composer.fill(replaced);
      }
    }

    await submitCurrentComposer(authPage);
    const linkBubble = msgList
      .locator(DOM.messageBubble)
      .filter({ hasText: 'KeyLinkAnchor' })
      .last();
    await expect(linkBubble).toBeVisible();
    await expect(
      linkBubble.locator('a[href^="https://telegram.org"]').first(),
    ).toBeVisible();
  });

  test('F8-4: #btn-emoji-picker opening #emoji-sticker-gif-popover 3-tab (Emoji, Stickers, GIFs) insertion and media send', async ({
    authPage,
  }) => {
    await selectWritableChat(authPage);

    const emojiBtn = authPage.locator(DOM.btnEmojiPicker);
    const popover = authPage.locator(DOM.emojiStickerGifPopover);
    const composer = authPage.locator(DOM.messageComposerInput);
    const msgList = authPage.locator(DOM.messageList);

    await composer.fill('');
    await expect(emojiBtn).toBeVisible();
    await emojiBtn.click();
    await expect(popover).toBeVisible();

    // 1. Tab 1: Emoji
    const emojiTab = scopedTab(
      popover,
      bilingualRegex('emoji', '表情'),
    ).first();
    await expect(emojiTab).toBeVisible();
    await emojiTab.click();

    const emojiCandidates = popover.locator('button:visible');
    const emojiBtnCount = await emojiCandidates.count();
    let clickedEmoji = false;
    for (let i = 0; i < emojiBtnCount; i++) {
      const btn = emojiCandidates.nth(i);
      const role = await btn.getAttribute('role');
      if (role === 'tab') continue;
      const label = ((await btn.textContent()) ?? '').trim();
      if (/\p{Extended_Pictographic}/u.test(label) && label.length <= 8) {
        await btn.click();
        clickedEmoji = true;
        break;
      }
    }
    expect(clickedEmoji).toBe(true);

    const composedEmoji = await readComposerText(composer);
    expect(composedEmoji).toMatch(/\p{Extended_Pictographic}/u);
    await submitCurrentComposer(authPage);

    await expect(msgList.locator(DOM.messageBubble).last()).toContainText(
      composedEmoji.trim(),
    );

    // 2. Tab 2: Stickers
    if (!(await popover.isVisible())) {
      await emojiBtn.click();
      await expect(popover).toBeVisible();
    }
    const stickersTab = scopedTab(
      popover,
      bilingualRegex('stickers?', '贴纸|贴图'),
    ).first();
    await expect(stickersTab).toBeVisible();
    await stickersTab.click();

    const headerBtnExclusion =
      ':not([role="tab"]):not([role="tabpanel"]):not([role="tablist"]):not([aria-label*="close" i]):not([aria-label*="search" i]):not([aria-label*="back" i]):not([aria-label*="关闭"]):not([aria-label*="搜索"]):not([aria-label*="返回"]):not([title*="close" i]):not([title*="search" i]):not([title*="back" i]):not([title*="关闭"]):not([title*="搜索"]):not([title*="返回"])';
    const nonItemTextFilter =
      /^[×✕]$|emoji|stickers?|gifs?|表情|贴纸|贴图|动图|clear|close|search|back|清除|关闭|搜索|返回/i;

    const countBeforeSticker = await msgList.locator(DOM.messageBubble).count();
    const explicitStickerItems = popover
      .locator(
        `[data-sticker-id]:visible${headerBtnExclusion}, [data-testid*="sticker-item" i]:visible${headerBtnExclusion}, [data-testid*="sticker" i]:visible${headerBtnExclusion}`,
      )
      .filter({ hasNotText: nonItemTextFilter });
    const fallbackStickerItems = popover
      .locator(
        `[role="tabpanel"] button:visible${headerBtnExclusion}, button:visible${headerBtnExclusion}`,
      )
      .filter({ hasNotText: nonItemTextFilter });
    const stickerItem =
      (await explicitStickerItems.count()) > 0
        ? explicitStickerItems.first()
        : fallbackStickerItems.first();
    await expect(stickerItem).toBeVisible();
    await stickerItem.click();

    await expect
      .poll(async () => msgList.locator(DOM.messageBubble).count(), {
        message: 'Expected clicking a Sticker item to send a sticker message bubble',
      })
      .toBeGreaterThan(countBeforeSticker);

    const stickerBubble = msgList.locator(DOM.messageBubble).last();
    const hasStickerVisual =
      (await stickerBubble
        .locator(
          'img, canvas, svg, [data-testid*="sticker" i], [class*="sticker" i]',
        )
        .count()) > 0 ||
      /\p{Extended_Pictographic}/u.test(await stickerBubble.innerText());
    expect(hasStickerVisual).toBe(true);

    // 3. Tab 3: GIFs
    if (!(await popover.isVisible())) {
      await emojiBtn.click();
      await expect(popover).toBeVisible();
    }
    const gifsTab = scopedTab(
      popover,
      bilingualRegex('\\bgifs?\\b', '动图'),
    ).first();
    await expect(gifsTab).toBeVisible();
    await gifsTab.click();

    const countBeforeGif = await msgList.locator(DOM.messageBubble).count();
    const explicitGifItems = popover
      .locator(
        `[data-gif-id]:visible${headerBtnExclusion}, [data-testid*="gif-item" i]:visible${headerBtnExclusion}, [data-testid*="gif" i]:visible${headerBtnExclusion}`,
      )
      .filter({ hasNotText: nonItemTextFilter });
    const fallbackGifItems = popover
      .locator(
        `[role="tabpanel"] button:visible${headerBtnExclusion}, video:visible, img:visible, button:visible${headerBtnExclusion}`,
      )
      .filter({ hasNotText: nonItemTextFilter });
    const gifItem =
      (await explicitGifItems.count()) > 0
        ? explicitGifItems.first()
        : fallbackGifItems.first();
    await expect(gifItem).toBeVisible();
    await gifItem.click();

    await expect
      .poll(async () => msgList.locator(DOM.messageBubble).count(), {
        message: 'Expected clicking a GIF item to send a GIF message bubble',
      })
      .toBeGreaterThan(countBeforeGif);

    const gifBubble = msgList.locator(DOM.messageBubble).last();
    expect(
      await gifBubble
        .locator('video, img, canvas, [data-testid*="gif" i], [class*="gif" i]')
        .count(),
    ).toBeGreaterThan(0);
  });

  test('F8-5: /slash and @mention autocomplete popups plus Silent and Scheduled send on #btn-send-message', async ({
    authPage,
  }) => {
    // 1. /slash command autocomplete (select @BotFather if present, else writable chat)
    const botFatherRows = authPage
      .locator(`${DOM.chatList} ${DOM.chatRow}`)
      .filter({ hasText: /BotFather|Hermes/i });
    if ((await botFatherRows.count()) > 0) {
      await selectChat(authPage, /BotFather|Hermes/i);
    } else {
      await selectWritableChat(authPage);
    }

    const composer = authPage.locator(DOM.messageComposerInput);
    await expect(composer).toBeVisible();
    await composer.fill('');
    await composer.focus();
    await composer.pressSequentially('/');

    const slashPopup = authPage
      .locator(
        '[role="listbox"]:visible, [role="menu"]:visible, [data-testid*="autocomplete" i]:visible, [data-testid*="slash" i]:visible, [data-testid*="command" i]:visible',
      )
      .first();
    await expect(slashPopup).toBeVisible();
    await expect(slashPopup).toContainText(/\/\w+/);

    const firstSlashOption = slashPopup
      .locator('[role="option"], [role="menuitem"], button, li')
      .filter({ hasText: /\/\w+/ })
      .first();
    await expect(firstSlashOption).toBeVisible();
    await firstSlashOption.click();
    await composer.fill('');

    // 2. @mention autocomplete (prefer a group chat with members)
    const rows = authPage.locator(`${DOM.chatList} ${DOM.chatRow}`);
    const totalRows = await rows.count();
    let selectedGroup = false;
    for (let i = 0; i < Math.min(totalRows, 10); i++) {
      const id = await rows.nth(i).getAttribute(DATA_ATTRS.chatId);
      if (!id) continue;
      await selectChat(authPage, id);
      const statusTxt =
        (await authPage.locator(DOM.chatHeaderStatus).textContent()) ?? '';
      if (
        /members|成员/i.test(statusTxt) &&
        (await composer.isVisible()) &&
        (await composer.isEditable())
      ) {
        selectedGroup = true;
        break;
      }
    }
    if (!selectedGroup) {
      await selectWritableChat(authPage);
    }

    await composer.fill('');
    await composer.focus();
    await composer.pressSequentially('Hello @');

    const mentionPopup = authPage
      .locator(
        '[role="listbox"]:visible, [role="menu"]:visible, [data-testid*="autocomplete" i]:visible, [data-testid*="mention" i]:visible',
      )
      .first();
    await expect(mentionPopup).toBeVisible();

    const firstMentionOption = mentionPopup
      .locator('[role="option"], [role="menuitem"], button, li')
      .first();
    await expect(firstMentionOption).toBeVisible();
    await firstMentionOption.click();

    expect(await readComposerText(composer)).toMatch(/Hello\s+@\S+/);
    await composer.fill('');

    // 3. Silent ("Send Without Sound") & Scheduled ("Schedule Message") send options
    const sendBtn = authPage.locator(DOM.btnSendMessage);
    const msgList = authPage.locator(DOM.messageList);

    const silentPayload = 'Silent delivery payload 🔕';
    await composer.fill(silentPayload);
    await expect(sendBtn).toBeVisible();
    await sendBtn.click({ button: 'right' });

    const sendOptionsMenu = authPage
      .locator(
        '[role="menu"]:visible, [data-testid="context-menu"]:visible, [data-testid*="send-menu" i]:visible',
      )
      .first();
    await expect(sendOptionsMenu).toBeVisible();

    const silentItem = scopedMenuItem(
      sendOptionsMenu,
      bilingualRegex('without\\s*sound|silent', '无声|静音发送'),
    ).first();
    const scheduleItemCheck = scopedMenuItem(
      sendOptionsMenu,
      bilingualRegex('schedule', '定时|计划发送'),
    ).first();
    await expect(silentItem).toBeVisible();
    await expect(scheduleItemCheck).toBeVisible();

    await silentItem.click();
    await expect(
      msgList.locator(DOM.messageBubble).filter({ hasText: silentPayload }),
    ).toBeVisible();
    expect(await readComposerText(composer)).toBe('');

    // Scheduled Send
    const scheduledPayload = 'Scheduled delivery payload 🗓️';
    await composer.fill(scheduledPayload);
    await sendBtn.click({ button: 'right' });

    const sendMenu2 = authPage
      .locator(
        '[role="menu"]:visible, [data-testid="context-menu"]:visible, [data-testid*="send-menu" i]:visible',
      )
      .first();
    await expect(sendMenu2).toBeVisible();
    await scopedMenuItem(
      sendMenu2,
      bilingualRegex('schedule', '定时|计划发送'),
    )
      .first()
      .click();

    const scheduleDialog = authPage
      .locator(
        '[role="dialog"]:visible, [data-testid*="schedule" i]:visible',
      )
      .first();
    await expect(scheduleDialog).toBeVisible();

    const confirmScheduleBtn = scopedButton(
      scheduleDialog,
      bilingualRegex('schedule|send|confirm|save', '定时|发送|确认|保存'),
    ).first();
    await expect(confirmScheduleBtn).toBeVisible();
    await confirmScheduleBtn.click();

    await expect
      .poll(async () => readComposerText(composer), {
        message: 'Expected confirming Scheduled Message to clear composer',
      })
      .toBe('');
  });

  test('F8-6: Per-chat persisted draft across chat switch, red Draft: badge in #chat-list, and #btn-ai-compose rewrite & apply', async ({
    authPage,
  }) => {
    const chatA = await selectWritableChat(authPage);
    const composer = authPage.locator(DOM.messageComposerInput);

    const draftText = 'Unsent draft alpha 待完善方案';
    await composer.click();
    await composer.fill(draftText);

    // Switch to distinct writable Chat B -> verify zero cross-chat draft bleed
    const chatB = await selectWritableChat(authPage, new Set([chatA.chatId]));
    expect(chatB.chatId).not.toBe(chatA.chatId);
    expect(await readComposerText(composer)).toBe('');

    // Verify Chat A row in #chat-list renders red "Draft:" / "草稿:" badge + draft preview
    const chatARow = authPage
      .locator(DOM.chatList)
      .locator(chatRowById(chatA.chatId));
    await expect(chatARow).toBeVisible();
    await expect(chatARow).toContainText(
      bilingualRegex('Draft:', '草稿[:：]?'),
    );
    await expect(chatARow).toContainText('Unsent draft alpha');

    const draftBadgeColorRaw = await chatARow.evaluate((rowEl: Element) => {
      const draftRe = /^(?:draft:?|草稿[:：]?)/i;
      const descendants = Array.from(rowEl.querySelectorAll('*'));
      const exact = descendants.find((el) =>
        draftRe.test((el.textContent ?? '').trim()),
      );
      const fallback = descendants.find((el) =>
        /draft:|草稿/i.test(el.textContent ?? ''),
      );
      const target = exact ?? fallback ?? rowEl;
      return window.getComputedStyle(target).color;
    });

    const draftRgba = parseCssRgba(draftBadgeColorRaw);
    expect(draftRgba).not.toBeNull();
    expect(draftRgba!.r).toBeGreaterThanOrEqual(175);
    expect(draftRgba!.r).toBeGreaterThan(draftRgba!.g + 50);
    expect(draftRgba!.r).toBeGreaterThan(draftRgba!.b + 40);

    // Switch back to Chat A -> verify draft text is restored in #message-composer-input
    await selectChat(authPage, chatA.chatId);
    expect(await readComposerText(composer)).toBe(draftText);

    // Exercise #btn-ai-compose rewrite / translate preview & apply
    const originalPrompt =
      'hello team please review the architecture draft before friday release';
    await composer.fill(originalPrompt);

    const aiComposeBtn = authPage.locator(DOM.btnAiCompose);
    await expect(aiComposeBtn).toBeVisible();
    await aiComposeBtn.click();

    const aiSurface = authPage
      .locator(
        '[role="dialog"]:visible, [role="menu"]:visible, [data-testid*="ai-compose" i]:visible, [class*="ai-compose" i]:visible',
      )
      .first();
    await expect(aiSurface).toBeVisible();

    const transformBtn = scopedMenuItem(
      aiSurface,
      bilingualRegex(
        'formal|concise|friendly|grammar|proofread|rewrite|polish|translate|chinese|english',
        '正式|简洁|友好|语法|润色|纠错|改写|翻译|中文|英文',
      ),
    ).first();
    await expect(transformBtn).toBeVisible();
    await transformBtn.click();

    await authPage.waitForTimeout(350);

    // If a preview surface stays open with an explicit Apply/Replace button, click it
    if (await aiSurface.isVisible()) {
      const applyBtn = scopedButton(
        aiSurface,
        bilingualRegex('apply|replace|insert|use', '应用|替换|插入|采用'),
      ).first();
      if ((await applyBtn.count()) > 0 && (await applyBtn.isVisible())) {
        await applyBtn.click();
      }
    }

    await expect
      .poll(
        async () => {
          const current = (await readComposerText(composer)).trim();
          return current.length > 0 && current !== originalPrompt;
        },
        {
          message:
            'Expected #btn-ai-compose to replace composer text with transformed output',
        },
      )
      .toBe(true);
  });
});
