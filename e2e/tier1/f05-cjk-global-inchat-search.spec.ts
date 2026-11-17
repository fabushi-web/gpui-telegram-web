import type { Locator, Page } from '@playwright/test';
import {
  BILINGUAL_PATTERNS,
  createPdfFilePayload,
  createPngFilePayload,
  DATA_ATTRS,
  DOM,
  expect,
   type InMemoryFilePayload,
  messageBubbleById,
  scopedButton,
  scopedTab,
  selectChat,
  sendTextMessage,
  test,
} from '../helpers';

function parseInChatMatchCounter(
  rawText: string,
): { current: number; total: number } | null {
  const std = rawText.match(/\b([1-9]\d*)\s*(?:of|\/|之)\s*([1-9]\d*)\b/i);
  if (std) {
    return { current: Number(std[1]), total: Number(std[2]) };
  }
  const zh1 = rawText.match(
    /第\s*([1-9]\d*)\s*[条个项处]?[,，/\s]*共\s*([1-9]\d*)/,
  );
  if (zh1) {
    return { current: Number(zh1[1]), total: Number(zh1[2]) };
  }
  const zh2 = rawText.match(
    /共\s*([1-9]\d*)\s*[条个项处]?[,，/\s]*第\s*([1-9]\d*)/,
  );
  if (zh2) {
    return { current: Number(zh2[2]), total: Number(zh2[1]) };
  }
  return null;
}

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

async function uploadFileInActiveChat(
  page: Page,
  payload: InMemoryFilePayload,
  caption: string,
): Promise<void> {
  const bubblesBefore = await page
    .locator(`${DOM.messageList} ${DOM.messageBubble}`)
    .count();

  let fileInput = page.locator(DOM.fileUploadInput);
  if ((await fileInput.count()) === 0) {
    const attachBtn = page.locator(DOM.btnAttachMenu);
    await expect(attachBtn).toBeVisible();
    await attachBtn.click();
    fileInput = page.locator(DOM.fileUploadInput);
  }
  await expect(fileInput.first()).toBeAttached();
  await fileInput.first().setInputFiles(payload);

  await page.waitForTimeout(300);

  const mediaEditor = page.locator(DOM.modalMediaEditor);
  const genericDialog = page.locator('[role="dialog"]:visible').last();
  const uploadModal = (await mediaEditor.isVisible())
    ? mediaEditor
    : (await genericDialog.count()) > 0
      ? genericDialog
      : null;

  if (uploadModal) {
    const captionInput = uploadModal
      .locator(
        'textarea:visible, input[type="text"]:visible, [contenteditable="true"]:visible',
      )
      .first();
    if ((await captionInput.count()) > 0) {
      await captionInput.fill(caption);
    }
    const sendModalBtn = scopedButton(uploadModal, BILINGUAL_PATTERNS.send)
      .or(scopedButton(uploadModal, BILINGUAL_PATTERNS.confirm))
      .first();
    await expect(sendModalBtn).toBeVisible();
    await sendModalBtn.click();
  } else {
    const composer = page.locator(DOM.messageComposerInput);
    if ((await composer.isVisible()) && caption.length > 0) {
      await composer.fill(caption);
    }
    const sendBtn = page.locator(DOM.btnSendMessage);
    if (
      (await page.locator(`${DOM.messageList} ${DOM.messageBubble}`).count()) <=
        bubblesBefore &&
      (await sendBtn.isVisible()) &&
      (await sendBtn.isEnabled())
    ) {
      await sendBtn.click();
    }
  }

  await expect
    .poll(
      async () =>
        page.locator(`${DOM.messageList} ${DOM.messageBubble}`).count(),
      {
        message: `Expected uploaded attachment "${payload.name}" to create a message bubble`,
        timeout: 10_000,
      },
    )
    .toBeGreaterThan(bubblesBefore);
}

function locateInChatSearchContainer(page: Page): Locator {
  const input = page.locator(DOM.inChatSearchInput);
  const rightCol = page.locator(DOM.rightColumn);
  return rightCol
    .filter({ has: input })
    .or(
      input.locator(
        'xpath=ancestor::*[self::aside or self::header or contains(@id,"search") or contains(@class,"search")][1]',
      ),
    )
    .or(page.locator(DOM.middleColumn))
    .first();
}

test.describe('F5 — Global CJK Full-Text Search & In-Chat Search with Date Jump', () => {
  test('F5-1: #global-search-input (/ and Ctrl+K shortcuts) executes CJK full-text query, renders highlighted snippets, and jumps to target message', async ({
    authPage,
  }) => {
    const chatA = await selectWritableChat(authPage);
    const uniquePhrase = '里程碑核验：法布施全局搜索测试_Alpha 零误差通过';
    const seededBubble = await sendTextMessage(authPage, uniquePhrase);
    const seededMsgId = await seededBubble.getAttribute(DATA_ATTRS.messageId);
    expect(seededMsgId).toBeTruthy();

    // Switch to distinct writable Chat B so Chat A's message is not in stage
    const chatB = await selectWritableChat(authPage, new Set([chatA.chatId]));
    expect(chatB.chatId).not.toBe(chatA.chatId);
    await expect(
      authPage
        .locator(`${DOM.messageList} ${DOM.messageBubble}`)
        .filter({ hasText: '法布施全局搜索测试_Alpha' }),
    ).toHaveCount(0);

    const globalInput = authPage.locator(DOM.globalSearchInput);

    // 1. Shortcut '/' when unfocused focuses #global-search-input without typing literal '/'
    await authPage.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.blur(),
    );
    await authPage.keyboard.press('/');
    await expect(globalInput).toBeFocused();
    await expect(globalInput).toHaveValue('');

    await authPage.keyboard.press('Escape');
    await authPage.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.blur(),
    );

    // 2. Shortcut 'Ctrl+K' focuses #global-search-input
    await authPage.keyboard.press('Control+k');
    await expect(globalInput).toBeFocused();

    // 3. Execute CJK full-text query & verify #search-tabs + highlighted snippet
    await globalInput.fill('法布施全局搜索测试_Alpha');
    const searchTabs = authPage.locator(DOM.searchTabs);
    await expect(searchTabs).toBeVisible();

    const leftCol = authPage.locator(DOM.leftColumn);
    const hitInLeft = leftCol
      .locator('[role="option"], [role="listitem"], [data-testid*="search" i], [data-message-id], button, li, a, div[tabindex]')
      .filter({ hasText: '法布施全局搜索测试_Alpha' });

    if ((await hitInLeft.count()) === 0) {
      const messagesTab = scopedTab(searchTabs, /messages|消息|信息/i).first();
      await expect(messagesTab).toBeVisible();
      await messagesTab.click();
    }

    const hitRow = leftCol
      .locator(
        '[role="option"], [role="listitem"], [data-testid*="search" i], [data-testid="chat-row"], [data-message-id], button, li, a',
      )
      .filter({ hasText: '法布施全局搜索测试_Alpha' })
      .first();
    await expect(hitRow).toBeVisible();

    // Verify highlighted CJK snippet inside search hit
    const hasHighlight = await hitRow.evaluate((el: Element) => {
      const parentStyle = window.getComputedStyle(el);
      const candidates = el.querySelectorAll(
        'mark, [data-highlight], [class*="highlight" i], strong, em, span',
      );
      for (const child of Array.from(candidates)) {
        const txt = child.textContent ?? '';
        if (!txt.includes('法布施')) continue;
        if (child.tagName.toLowerCase() === 'mark') return true;
        if (
          child.hasAttribute('data-highlight') ||
          /highlight|match/i.test(child.className)
        ) {
          return true;
        }
        const st = window.getComputedStyle(child);
        if (
          st.color !== parentStyle.color ||
          (st.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
            st.backgroundColor !== 'transparent' &&
            st.backgroundColor !== parentStyle.backgroundColor) ||
          Number.parseInt(st.fontWeight, 10) >
            Number.parseInt(parentStyle.fontWeight, 10)
        ) {
          return true;
        }
      }
      return false;
    });
    expect(hasHighlight).toBe(true);

    // 4. Click search result -> jump back to Chat A and target message bubble
    await hitRow.click();
    await expect(authPage.locator(DOM.chatHeaderTitle)).toContainText(
      chatA.title,
    );
    await expect(
      authPage.locator(DOM.messageList).locator(messageBubbleById(seededMsgId!)),
    ).toBeVisible();
  });

  test('F5-2: #search-tabs category filtering across all 8 tabs (Chats, Messages, Apps, Media, Links, Files, Music, Voice)', async ({
    authPage,
  }) => {
    await selectWritableChat(authPage);

    await sendTextMessage(
      authPage,
      'OmniCat_全分类 规范链接 https://example.org/omnicat-doc',
    );
    await uploadFileInActiveChat(
      authPage,
      createPdfFilePayload('OmniCat_Spec.pdf', 'OmniCat PDF'),
      'OmniCat_全分类 文档',
    );
    await uploadFileInActiveChat(
      authPage,
      createPngFilePayload('OmniCat_Diagram.png'),
      'OmniCat_全分类 图片',
    );

    const globalInput = authPage.locator(DOM.globalSearchInput);
    await globalInput.click();
    await globalInput.fill('OmniCat');

    const searchTabs = authPage.locator(DOM.searchTabs);
    await expect(searchTabs).toBeVisible();
    const leftCol = authPage.locator(DOM.leftColumn);

    const allEightTabs = [
      { key: 'chats', regex: /chats|contacts|聊天|对话|会话|联系人/i },
      { key: 'messages', regex: /messages|消息|信息/i },
      { key: 'apps', regex: /apps|mini\s*apps|应用|小程序/i },
      { key: 'media', regex: /media|photos|媒体|图片|照片/i },
      { key: 'links', regex: /links|链接/i },
      { key: 'files', regex: /files|documents|文件|文档/i },
      { key: 'music', regex: /music|audio|音乐|音频/i },
      { key: 'voice', regex: /voice|语音/i },
    ] as const;

    for (const def of allEightTabs) {
      const tabLoc = scopedTab(searchTabs, def.regex).first();
      await tabLoc.scrollIntoViewIfNeeded();
      await expect(tabLoc).toBeVisible();
    }

    // Messages tab
    const msgTab = scopedTab(searchTabs, /messages|消息|信息/i).first();
    await msgTab.scrollIntoViewIfNeeded();
    await msgTab.click();
    await expect(leftCol).toContainText('OmniCat_全分类 规范链接');

    // Links tab
    const linksTab = scopedTab(searchTabs, /links|链接/i).first();
    await linksTab.scrollIntoViewIfNeeded();
    await linksTab.click();
    await expect(leftCol).toContainText(/example\.org\/omnicat-doc|OmniCat_全分类/i);

    // Files tab
    const filesTab = scopedTab(searchTabs, /files|documents|文件|文档/i).first();
    await filesTab.scrollIntoViewIfNeeded();
    await filesTab.click();
    await expect(leftCol).toContainText(/OmniCat_Spec\.pdf|OmniCat_全分类 文档/i);

    // Media tab — verify actual result outside #search-tabs, #stories-bar, and search header
    const mediaTab = scopedTab(searchTabs, /media|photos|媒体|图片|照片/i).first();
    await mediaTab.scrollIntoViewIfNeeded();
    await mediaTab.click();
    await expect
      .poll(
        async () =>
          leftCol.evaluate((colEl: Element) => {
            const tabsEl = colEl.querySelector('#search-tabs');
            const tabsBottom = tabsEl
              ? tabsEl.getBoundingClientRect().bottom
              : 0;
            const globalInputEl = colEl.querySelector('#global-search-input');
            const searchBarHeader = globalInputEl?.closest('header');

            const isInsideTopChrome = (node: Element): boolean => {
              if (
                node.closest(
                  '#search-tabs, #stories-bar, #chat-folder-tabs, #nav-rail, #main-menu-drawer',
                )
              ) {
                return true;
              }
              if (
                searchBarHeader &&
                searchBarHeader !== colEl &&
                !searchBarHeader.contains(tabsEl) &&
                searchBarHeader.contains(node)
              ) {
                return true;
              }
              const r = node.getBoundingClientRect();
              return tabsBottom > 0 && r.bottom <= tabsBottom - 2;
            };

            const thumbnails = Array.from(
              colEl.querySelectorAll(
                'img:not([data-avatar]):not([data-peer-avatar]):not([class*="avatar" i]), canvas, video',
              ),
            ).filter((el) => {
              if (isInsideTopChrome(el)) return false;
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            });
            if (thumbnails.length > 0) {
              return true;
            }

            const resultCandidates = Array.from(
              colEl.querySelectorAll(
                '[role="option"], [role="listitem"], [data-message-id], [data-testid*="result" i], [data-testid*="hit" i], [data-testid*="media-item" i], li, a, button, div',
              ),
            ).filter(
              (el) =>
                !isInsideTopChrome(el) &&
                !el.querySelector('#search-tabs') &&
                !el.querySelector('#global-search-input'),
            );

            return resultCandidates.some((el) => {
              const txt = el.textContent ?? '';
              return (
                txt.includes('OmniCat_Diagram') ||
                txt.includes('OmniCat_全分类 图片')
              );
            });
          }),
        {
          message:
            'Expected Media search results area (excluding #search-tabs, #stories-bar, and search header) to render uploaded media thumbnail or caption',
        },
      )
      .toBe(true);

    // Music & Voice tabs activate cleanly without leaking plain-text link item
    const musicTab = scopedTab(searchTabs, /music|audio|音乐|音频/i).first();
    await musicTab.scrollIntoViewIfNeeded();
    await musicTab.click();
    await expect(leftCol).not.toContainText('example.org/omnicat-doc');

    const voiceTab = scopedTab(searchTabs, /voice|语音/i).first();
    await voiceTab.scrollIntoViewIfNeeded();
    await voiceTab.click();
    await expect(leftCol).not.toContainText('example.org/omnicat-doc');

    // Chats tab discovers @BotFather
    await globalInput.fill('Bot');
    const chatsTab = scopedTab(
      searchTabs,
      /chats|contacts|聊天|对话|会话|联系人/i,
    ).first();
    await chatsTab.scrollIntoViewIfNeeded();
    await chatsTab.click();
    await expect(leftCol).toContainText(/BotFather|Bot/i);

    // Apps tab discovers flagship Mini App (全球法布施 / Fabushi / TaskBoard)
    const appsTab = scopedTab(
      searchTabs,
      /apps|mini\s*apps|应用|小程序/i,
    ).first();
    await appsTab.scrollIntoViewIfNeeded();
    await appsTab.click();
    await globalInput.fill('法布施');
    await authPage.waitForTimeout(250);
    if (!/法布施|fabushi|globe|task/i.test(await leftCol.innerText())) {
      await globalInput.fill('fabushi');
      await authPage.waitForTimeout(250);
    }
    await expect(leftCol).toContainText(/法布施|fabushi|globe/i);
  });

  test('F5-3: #btn-in-chat-search and #in-chat-search-input (Ctrl+F) open In-Chat Search and update live match counter', async ({
    authPage,
  }) => {
    await selectWritableChat(authPage);

    await sendTextMessage(authPage, '会话内计数词_Gamma 首条匹配 #A');
    await sendTextMessage(authPage, '完全不相关的噪声文本_Noise_Control');
    await sendTextMessage(authPage, '会话内计数词_Gamma 次条匹配 #B');
    await sendTextMessage(authPage, '会话内计数词_Gamma 末条匹配 #C');

    const inChatBtn = authPage.locator(DOM.btnInChatSearch);
    const inChatInput = authPage.locator(DOM.inChatSearchInput);

    // 1. Open via #btn-in-chat-search, then dismiss with Escape
    await expect(inChatBtn).toBeVisible();
    await inChatBtn.click();
    await expect(inChatInput).toBeVisible();
    await expect(inChatInput).toBeEditable();

    await authPage.keyboard.press('Escape');

    // 2. Open via Ctrl+F shortcut
    await authPage.locator(DOM.chatHeaderTitle).click();
    await authPage.keyboard.press('Control+f');
    await expect(inChatInput).toBeVisible();
    await expect(inChatInput).toBeFocused();

    // 3. Verify live match counter updates from total=3 -> narrowed total=1
    await inChatInput.fill('会话内计数词_Gamma');
    const searchContainer = locateInChatSearchContainer(authPage);

    await expect
      .poll(
        async () => {
          const parsed = parseInChatMatchCounter(
            await searchContainer.innerText(),
          );
          return parsed !== null &&
            parsed.total === 3 &&
            parsed.current >= 1 &&
            parsed.current <= 3
            ? parsed.total
            : -1;
        },
        { message: 'Expected In-Chat Search counter to report total === 3' },
      )
      .toBe(3);

    await inChatInput.fill('会话内计数词_Gamma 次条匹配 #B');
    await expect
      .poll(
        async () => {
          const parsed = parseInChatMatchCounter(
            await searchContainer.innerText(),
          );
          return parsed !== null && parsed.total === 1 && parsed.current === 1;
        },
        {
          message:
            'Expected narrowed In-Chat Search counter to report 1 of 1',
        },
      )
      .toBe(true);
  });

  test('F5-4: #in-chat-search-prev and #in-chat-search-next step through matches, scroll #message-list to offscreen bubble, and highlight target', async ({
    authPage,
  }) => {
    await selectWritableChat(authPage);

    const b1 = await sendTextMessage(
      authPage,
      '跨屏跳转锚点_Omega 顶部命中_01',
    );
    const id1 = await b1.getAttribute(DATA_ATTRS.messageId);
    expect(id1).toBeTruthy();

    let filler1Id = '';
    for (let i = 1; i <= 12; i++) {
      const fillerBubble = await sendTextMessage(
        authPage,
        `分隔填充块_Filler_${i}\n第二行高度填充\n第三行高度填充\n第四行高度填充`,
      );
      if (i === 1) {
        filler1Id = (await fillerBubble.getAttribute(DATA_ATTRS.messageId)) ?? '';
      }
    }
    expect(filler1Id).toBeTruthy();

    const b2 = await sendTextMessage(
      authPage,
      '跨屏跳转锚点_Omega 中部命中_02',
    );
    const id2 = await b2.getAttribute(DATA_ATTRS.messageId);
    expect(id2).toBeTruthy();

    for (let i = 13; i <= 24; i++) {
      await sendTextMessage(
        authPage,
        `分隔填充块_Filler_${i}\n第二行高度填充\n第三行高度填充\n第四行高度填充`,
      );
    }

    const b3 = await sendTextMessage(
      authPage,
      '跨屏跳转锚点_Omega 底部命中_03',
    );
    const id3 = await b3.getAttribute(DATA_ATTRS.messageId);
    expect(id3).toBeTruthy();

    const msgList = authPage.locator(DOM.messageList);
    const scrollTopBottom = await msgList.evaluate(
      (el: Element) => el.scrollTop,
    );
    expect(scrollTopBottom).toBeGreaterThan(400);

    await authPage.locator(DOM.btnInChatSearch).click();
    const inChatInput = authPage.locator(DOM.inChatSearchInput);
    await expect(inChatInput).toBeVisible();
    await inChatInput.fill('跨屏跳转锚点_Omega');

    const prevBtn = authPage.locator(DOM.inChatSearchPrev);
    const nextBtn = authPage.locator(DOM.inChatSearchNext);
    await expect(prevBtn).toBeVisible();
    await expect(nextBtn).toBeVisible();

    const searchContainer = locateInChatSearchContainer(authPage);
    await expect
      .poll(
        async () =>
          parseInChatMatchCounter(await searchContainer.innerText())?.total ??
          0,
      )
      .toBe(3);

    const target1 = msgList.locator(messageBubbleById(id1!));
    const target3 = msgList.locator(messageBubbleById(id3!));

    const isBubbleInListViewport = async (bubble: Locator): Promise<boolean> => {
      if ((await bubble.count()) === 0 || !(await bubble.isVisible())) {
        return false;
      }
      const lBox = await msgList.boundingBox();
      const bBox = await bubble.boundingBox();
      if (!lBox || !bBox) return false;
      return bBox.y + bBox.height > lBox.y && bBox.y < lBox.y + lBox.height;
    };

    let usedPrev = false;
    let usedNext = false;

    const clickStepBtn = async (which: 'prev' | 'next'): Promise<void> => {
      const btn = which === 'prev' ? prevBtn : nextBtn;
      await expect(btn).toBeEnabled();
      await btn.click();
      if (which === 'prev') {
        usedPrev = true;
      } else {
        usedNext = true;
      }
      await authPage.waitForTimeout(200);
    };

    // Boundary-safe stepping to offscreen top match id1 and back to bottom match id3
    let returnDirection: 'prev' | 'next' = 'next';

    if (await isBubbleInListViewport(target1)) {
      // Search auto-jumped to id1 on query: step to id2 then return to id1 to exercise opposite button
      const awayDir: 'prev' | 'next' = (await nextBtn.isEnabled())
        ? 'next'
        : 'prev';
      const backDir: 'prev' | 'next' = awayDir === 'next' ? 'prev' : 'next';
      await clickStepBtn(awayDir);
      await clickStepBtn(backDir);
      returnDirection = awayDir;
    } else if (!(await prevBtn.isEnabled())) {
      // Boundary-disabled prevBtn at newest match (1 of 3 -> nextBtn steps upward to 3 of 3)
      await clickStepBtn('next');
      await clickStepBtn('next');
      returnDirection = 'prev';
    } else if (!(await nextBtn.isEnabled())) {
      // Boundary-disabled nextBtn at newest match (3 of 3 -> prevBtn steps upward to 1 of 3)
      await clickStepBtn('prev');
      await clickStepBtn('prev');
      returnDirection = 'next';
    } else {
      // Both step buttons enabled (wrapping mode): probe 1 step on prevBtn and inspect scrollTop progression
      const scrollBeforeProbe = await msgList.evaluate(
        (el: Element) => el.scrollTop,
      );
      await clickStepBtn('prev');
      const scrollAfterProbe = await msgList.evaluate(
        (el: Element) => el.scrollTop,
      );
      if (await isBubbleInListViewport(target1)) {
        returnDirection = 'next';
      } else if (scrollAfterProbe < scrollBeforeProbe) {
        await clickStepBtn('prev');
        returnDirection = 'next';
      } else {
        await clickStepBtn('next');
        if (
          !(await isBubbleInListViewport(target1)) &&
          (await nextBtn.isEnabled())
        ) {
          await clickStepBtn('next');
        }
        returnDirection = 'prev';
      }
    }

    await expect(target1).toBeVisible();

    const scrollAtId1 = await msgList.evaluate((el: Element) => el.scrollTop);
    expect(scrollAtId1).toBeLessThan(scrollTopBottom);

    // Assert target1 intersects #message-list viewport AND carries active search highlight vs Filler_1 baseline
    const listBox = await msgList.boundingBox();
    const t1Box = await target1.boundingBox();
    expect(listBox).not.toBeNull();
    expect(t1Box).not.toBeNull();
    expect(t1Box!.y + t1Box!.height).toBeGreaterThan(listBox!.y);
    expect(t1Box!.y).toBeLessThan(listBox!.y + listBox!.height);

    const hasTargetHighlight = await msgList.evaluate(
      (listEl: Element, args: { activeId: string; baselineFillerId: string }) => {
        const el = listEl.querySelector(
          `[data-testid="message-bubble"][data-message-id="${CSS.escape(args.activeId)}"]`,
        );
        if (!el) return false;

        if (
          el.getAttribute('data-highlighted') === 'true' ||
          el.getAttribute('data-search-active') === 'true' ||
          el.getAttribute('data-active-match') === 'true' ||
          /highlight|active|focus|match|flash|pulse|selected/i.test(el.className)
        ) {
          return true;
        }
        if (
          el.querySelector(
            'mark, [data-highlight], [class*="highlight" i], [class*="match" i]',
          )
        ) {
          return true;
        }

        const fillerEl =
          listEl.querySelector(
            `[data-testid="message-bubble"][data-message-id="${CSS.escape(args.baselineFillerId)}"]`,
          ) ??
          Array.from(
            listEl.querySelectorAll('[data-testid="message-bubble"]'),
          ).find((b) => (b.textContent ?? '').includes('分隔填充块_Filler_'));
        if (!fillerEl) {
          return false;
        }

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
        const stFiller = window.getComputedStyle(fillerEl);
        const stTargetCard = window.getComputedStyle(resolveCard(el));
        const stFillerCard = window.getComputedStyle(resolveCard(fillerEl));

        return (
          stTarget.backgroundColor !== stFiller.backgroundColor ||
          stTarget.boxShadow !== stFiller.boxShadow ||
          stTarget.outline !== stFiller.outline ||
          stTargetCard.backgroundColor !== stFillerCard.backgroundColor ||
          stTargetCard.boxShadow !== stFillerCard.boxShadow ||
          stTargetCard.outline !== stFillerCard.outline
        );
      },
      { activeId: id1!, baselineFillerId: filler1Id },
    );
    expect(hasTargetHighlight).toBe(true);

    // Exercise opposite step button to return to bottom match id3
    const returnBtn = returnDirection === 'prev' ? prevBtn : nextBtn;
    for (let step = 0; step < 2; step++) {
      if (await isBubbleInListViewport(target3)) {
        break;
      }
      if (await returnBtn.isEnabled()) {
        await clickStepBtn(returnDirection);
      }
    }

    expect(usedPrev && usedNext).toBe(true);
    await expect(target3).toBeVisible();
    const scrollEnd = await msgList.evaluate((el: Element) => el.scrollTop);
    expect(scrollEnd).toBeGreaterThan(scrollAtId1);
  });

  test('F5-5: In-Chat Search sender filter and Jump-to-Date calendar jump', async ({
    authPage,
  }) => {
    // Find a writable chat that already has an incoming peer message (or trigger @BotFather reply)
    const rows = authPage.locator(`${DOM.chatList} ${DOM.chatRow}`);
    await expect(rows.first()).toBeVisible();
    const rowCount = await rows.count();

    let sharedTerm = '';
    for (let i = 0; i < Math.min(rowCount, 8); i++) {
      const id = await rows.nth(i).getAttribute(DATA_ATTRS.chatId);
      if (!id) continue;
      await selectChat(authPage, id);
      const composer = authPage.locator(DOM.messageComposerInput);
      if (!(await composer.isVisible()) || !(await composer.isEditable())) {
        continue;
      }
      const existingBubbles = authPage.locator(
        `${DOM.messageList} ${DOM.messageBubble}`,
      );
      const bCount = await existingBubbles.count();
      for (let j = 0; j < bCount; j++) {
        const raw = ((await existingBubbles.nth(j).innerText()) ?? '').trim();
        const tokenMatch = raw.match(/[A-Za-z]{4,14}|[\u4e00-\u9fff]{2,6}/);
        if (tokenMatch?.[0]) {
          sharedTerm = tokenMatch[0];
          break;
        }
      }
      if (sharedTerm) break;
    }

    if (!sharedTerm) {
      await selectChat(authPage, /BotFather/i);
      const countBefore = await authPage
        .locator(`${DOM.messageList} ${DOM.messageBubble}`)
        .count();
      await sendTextMessage(authPage, '/start');
      await expect
        .poll(async () =>
          authPage
            .locator(`${DOM.messageList} ${DOM.messageBubble}`)
            .count(),
        )
        .toBeGreaterThan(countBefore + 1);
      const botReply = (
        await authPage
          .locator(`${DOM.messageList} ${DOM.messageBubble}`)
          .last()
          .innerText()
      ).trim();
      const word = botReply.match(/[A-Za-z]{4,12}|[\u4e00-\u9fff]{2,6}/)?.[0];
      sharedTerm = word ?? 'BotFather';
    }

    await sendTextMessage(
      authPage,
      `${sharedTerm} — 本人发送的对照记录_MeSender`,
    );

    // 1. Open In-Chat Search and verify baselineTotal >= 2 across >= 2 senders
    await authPage.locator(DOM.btnInChatSearch).click();
    const inChatInput = authPage.locator(DOM.inChatSearchInput);
    await expect(inChatInput).toBeVisible();
    await inChatInput.fill(sharedTerm);

    const searchContainer = locateInChatSearchContainer(authPage);
    await expect
      .poll(
        async () =>
          parseInChatMatchCounter(await searchContainer.innerText())?.total ??
          0,
      )
      .toBeGreaterThanOrEqual(2);
    const baselineTotal =
      parseInChatMatchCounter(await searchContainer.innerText())?.total ?? 2;

    // Apply Sender Filter
    const senderSelect = searchContainer
      .locator(
        'select[name*="sender" i], select[name*="from" i], select[aria-label*="sender" i], select[aria-label*="发送" i], select[aria-label*="成员" i]',
      )
      .or(searchContainer.locator('select:visible'))
      .first();

    const senderBtn = searchContainer
      .locator(
        '[data-testid*="sender" i], [data-testid*="from" i], button[aria-label*="sender" i], button[aria-label*="from" i], button[aria-label*="发送者" i], button[aria-label*="成员" i]',
      )
      .or(
        scopedButton(
          searchContainer,
          /from|sender|member|author|all\s*members|all\s*senders|发送者|发言人|成员|来自|按成员/i,
        ),
      )
      .first();

    let usedSelect = false;
    if ((await senderSelect.count()) > 0 && (await senderSelect.isVisible())) {
      usedSelect = true;
      const optVal = await senderSelect.evaluate((el: Element) => {
        const sel = el as HTMLSelectElement;
        const nonAll = Array.from(sel.options).find(
          (o, idx) => idx > 0 && o.value !== '' && !/^all|全部$/i.test(o.text),
        );
        return nonAll?.value ?? sel.options[1]?.value ?? '';
      });
      expect(optVal.length).toBeGreaterThan(0);
      await senderSelect.selectOption(optVal);
    } else if ((await senderBtn.count()) > 0 && (await senderBtn.isVisible())) {
      await senderBtn.click();
      const senderOption = authPage
        .locator(
          '[role="listbox"]:visible [role="option"], [role="menu"]:visible [role="menuitem"], [role="dialog"]:visible button, [data-testid*="sender" i] button, [data-testid*="member" i] button',
        )
        .filter({ hasNotText: /^(?:all|all\s*members|all\s*senders|全部|所有)$/i })
        .first();
      await expect(senderOption).toBeVisible();
      await senderOption.click();
    } else {
      await inChatInput.fill(`from:me ${sharedTerm}`);
    }

    await expect
      .poll(
        async () => {
          const parsed = parseInChatMatchCounter(
            await searchContainer.innerText(),
          );
          return parsed !== null &&
            parsed.total >= 1 &&
            parsed.total < baselineTotal;
        },
        {
          message: `Expected Sender Filter to narrow matches strictly below baselineTotal=${baselineTotal}`,
        },
      )
      .toBe(true);

    // Reset sender filter and verify match total returns to baselineTotal
    if (usedSelect) {
      await senderSelect.selectOption({ index: 0 });
    } else {
      const clearSenderBtn = scopedButton(
        searchContainer,
        /clear\s*sender|all\s*members|all\s*senders|reset|全部成员|所有发送者|清除筛选/i,
      ).first();
      if (
        (await clearSenderBtn.count()) > 0 &&
        (await clearSenderBtn.isVisible())
      ) {
        await clearSenderBtn.click();
      } else {
        await authPage.keyboard.press('Escape');
        await authPage.locator(DOM.btnInChatSearch).click();
        await inChatInput.fill(sharedTerm);
      }
    }

    await expect
      .poll(
        async () =>
          parseInChatMatchCounter(await searchContainer.innerText())?.total ??
          0,
      )
      .toBe(baselineTotal);

    // 2. Verify Jump-to-Date Calendar Jump from interior midScroll
    const msgList = authPage.locator(DOM.messageList);
    for (let round = 1; round <= 18; round++) {
      const span = await msgList.evaluate(
        (el: Element) => el.scrollHeight - el.clientHeight,
      );
      if (span >= 600) {
        break;
      }
      await sendTextMessage(
        authPage,
        `日历滚动填充_${round}\n第二行内容\n第三行内容\n第四行内容`,
      );
    }
    await sendTextMessage(authPage, '今日底部定位锚点_CalendarToday');

    const maxScrollBeforeJump = await msgList.evaluate(
      (el: Element) => el.scrollHeight - el.clientHeight,
    );
    expect(maxScrollBeforeJump).toBeGreaterThanOrEqual(360);

    // Position #message-list at interior midScroll (>= 160px from both 0 and maxScroll)
    const midScroll = await msgList.evaluate(async (el: Element) => {
      const maxScroll = el.scrollHeight - el.clientHeight;
      const target = Math.round(maxScroll * 0.5);
      el.scrollTop = target;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      return el.scrollTop;
    });
    const maxScrollAtMid = await msgList.evaluate(
      (el: Element) => el.scrollHeight - el.clientHeight,
    );
    expect(midScroll).toBeGreaterThanOrEqual(160);
    expect(maxScrollAtMid - midScroll).toBeGreaterThanOrEqual(160);

    if (!(await inChatInput.isVisible())) {
      await authPage.locator(DOM.btnInChatSearch).click();
    }

    const todayIso = new Date().toISOString().slice(0, 10);
    const dateInput = searchContainer.locator('input[type="date"]').first();
    const calendarBtn = searchContainer
      .locator(
        '[data-testid*="date" i], [data-testid*="calendar" i], button[aria-label*="date" i], button[aria-label*="calendar" i], button[title*="date" i], button[title*="日期" i], button[aria-label*="日期" i]',
      )
      .or(scopedButton(searchContainer, /date|calendar|jump|日期|日历|跳转/i))
      .first();

    if ((await dateInput.count()) > 0 && (await dateInput.isVisible())) {
      await dateInput.fill(todayIso);
      await dateInput.dispatchEvent('change');
      const jumpConfirm = scopedButton(
        searchContainer,
        /jump|go|confirm|跳转|确定/i,
      ).first();
      if ((await jumpConfirm.count()) > 0 && (await jumpConfirm.isVisible())) {
        await jumpConfirm.click();
      }
    } else {
      await expect(calendarBtn).toBeVisible();
      await calendarBtn.click();

      const calDialog = authPage
        .locator('[role="dialog"]:visible')
        .last()
        .or(searchContainer)
        .first();
      const modalDateInput = calDialog.locator('input[type="date"]:visible').first();
      if ((await modalDateInput.count()) > 0) {
        await modalDateInput.fill(todayIso);
        await modalDateInput.dispatchEvent('change');
      } else {
        const dayStr = String(new Date().getDate());
        const exactDayRegex = new RegExp('^\\s*' + dayStr + '\\s*$');
        const explicitTodayCell = calDialog.locator(
          `[data-date="${todayIso}"], [aria-current="date"]`,
        );
        const todayCell =
          (await explicitTodayCell.count()) > 0 &&
          (await explicitTodayCell.first().isVisible())
            ? explicitTodayCell.first()
            : calDialog
                .locator(
                  'button:visible, [role="gridcell"]:visible, [role="button"]:visible',
                )
                .filter({ hasText: exactDayRegex })
                .first();
        await expect(todayCell).toBeVisible();
        await todayCell.click();
      }
      const confirmCalBtn = scopedButton(
        calDialog,
        /jump|go|confirm|ok|跳转|确定|确认/i,
      ).first();
      if (
        (await confirmCalBtn.count()) > 0 &&
        (await confirmCalBtn.isVisible())
      ) {
        await confirmCalBtn.click();
      }
    }

    await expect
      .poll(
        async () => {
          const topNow = await msgList.evaluate((el: Element) => el.scrollTop);
          const todayBubbleCount = await msgList
            .locator(DOM.messageBubble)
            .count();
          return Math.abs(topNow - midScroll) > 60 && todayBubbleCount > 0;
        },
        {
          message:
            'Expected Jump-to-Date to scroll #message-list away from interior midScroll to target date messages',
        },
      )
      .toBe(true);
  });
});
