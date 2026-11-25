import { test, expect } from '../helpers/fixtures';
import { DOM, SIDEBAR_PINNED_CHATS_GRID } from '../helpers/selectors';
import {
  createRealConversationFixture,
  sendApiMessage,
} from '../helpers/server';
import {
  assertNoPurpleOnDark,
  bilingualRegex,
  BILINGUAL_PATTERNS,
  ensureDarkThemeAndAssertNoPurple,
  openBurgerMenu,
  openContextMenuAndClick,
  scopedButton,
  scopedTextbox,
  selectChat,
  sendTextMessage,
} from '../helpers/ui';

test.describe('Tier 3 — PW01: Cross-Feature Sync, Apple/Muse UI, Folders, Topics & Messaging', () => {
  test('PW-01 (A03 x A02 x A05): Multi-tab BroadcastChannel live sync of send, edit, hover reaction, and Apple Night/Day theme switch', async ({
    authSession,
    openSecondTab,
    request,
  }) => {
    const { page: tab1, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token);
    await tab1.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(tab1, conv.dmTitle);

    const tab2 = await openSecondTab();
    await expect(tab2.locator(DOM.appShell)).toBeVisible();
    await selectChat(tab2, conv.dmTitle);

    // 1. Send message in Tab 1 -> arrives live in Tab 2
    const marker = `PW01_LiveSync_${Date.now()}`;
    const bubble1 = await sendTextMessage(tab1, marker);
    await expect(
      tab2.locator(DOM.messageList).locator(DOM.messageBubble).filter({ hasText: marker }),
    ).toBeVisible({ timeout: 8_000 });

    // 2. Edit in Tab 1 -> propagates to Tab 2
    await openContextMenuAndClick(tab1, bubble1, BILINGUAL_PATTERNS.edit);
    const updatedText = `${marker}_EDITED`;
    const composer1 = tab1.locator(DOM.messageComposerInput);
    await composer1.fill(updatedText);
    await composer1.press('Enter');

    const editedBubble1 = tab1
      .locator(DOM.messageList)
      .locator(DOM.messageBubble)
      .filter({ hasText: updatedText })
      .first();
    const editedBubble2 = tab2
      .locator(DOM.messageList)
      .locator(DOM.messageBubble)
      .filter({ hasText: updatedText })
      .first();
    await expect(editedBubble1).toBeVisible({ timeout: 8_000 });
    await expect(editedBubble2).toBeVisible({ timeout: 8_000 });

    // 3. Hover reaction in Tab 1 -> syncs live onto Tab 2
    await editedBubble1.hover();
    const reactTrigger = editedBubble1
      .locator('[data-testid*="reaction" i], button[aria-label*="react" i], [data-reaction-bar] button')
      .or(tab1.locator('[data-testid="reaction-quick-bar"] button').first())
      .first();
    await expect(reactTrigger).toBeVisible();
    await reactTrigger.click();
    const emojiChoice = tab1
      .locator('[data-testid="reaction-quick-bar"] button, [data-testid="reaction-picker"] button')
      .filter({ hasText: /👍|❤️|🔥/ })
      .first();
    await expect(emojiChoice).toBeVisible();
    await emojiChoice.click();

    await expect(
      editedBubble1.locator('[data-testid="reaction-chip"], button').filter({ hasText: /👍|❤️|🔥/ }).first(),
    ).toBeVisible({ timeout: 6_000 });
    await expect(
      editedBubble2.locator('[data-testid="reaction-chip"], button').filter({ hasText: /👍|❤️|🔥/ }).first(),
    ).toBeVisible({ timeout: 8_000 });

    // 4. Theme toggle in Tab 1 -> syncs via BroadcastChannel to Tab 2 + unconditional dark anti-purple audit
    const readTheme = (p: typeof tab1) =>
      p.evaluate(() => (document.documentElement.getAttribute('data-theme') ?? '').toLowerCase());

    const initialTheme = await readTheme(tab1);
    expect(initialTheme.length).toBeGreaterThan(0);

    await openBurgerMenu(tab1);
    await tab1.locator(DOM.menuToggleNightMode).click();
    const toggledTheme = await readTheme(tab1);
    expect(toggledTheme.length).toBeGreaterThan(0);
    expect(toggledTheme).not.toBe(initialTheme);

    await expect
      .poll(() => readTheme(tab2), {
        timeout: 6_000,
        message: `Expected Tab 2 to sync data-theme="${toggledTheme}" via BroadcastChannel`,
      })
      .toBe(toggledTheme);

    const darkTheme = await ensureDarkThemeAndAssertNoPurple(tab1);
    await expect
      .poll(() => readTheme(tab2), {
        timeout: 6_000,
        message: `Expected Tab 2 to sync dark data-theme="${darkTheme}" via BroadcastChannel`,
      })
      .toBe(darkTheme);
    await assertNoPurpleOnDark(tab2);
  });

  test('PW-02 (A04 x A02 x A03): Custom Chat Folder + Apple 3x3 #sidebar-pinned-chats-grid + Global CJK Search snippet jump', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token, {
      includeGroup: true,
      groupTitle: '核心架构群',
      initialGroupMessages: [
        { from: 'peer', text: '法布施跨模块联合检索验证标记902' },
      ],
    });
    expect(conv.groupTitle).toBeTruthy();
    const groupTitle = conv.groupTitle!;
    await page.reload({ waitUntil: 'domcontentloaded' });

    // Pin group into Apple 3x3 pinned chats grid
    const grpRow = page
      .locator(DOM.chatList)
      .locator(DOM.chatRow)
      .filter({ hasText: groupTitle })
      .first();
    await openContextMenuAndClick(page, grpRow, BILINGUAL_PATTERNS.pin);
    await expect(page.locator(SIDEBAR_PINNED_CHATS_GRID)).toBeVisible();
    await expect(page.locator(SIDEBAR_PINNED_CHATS_GRID)).toContainText(groupTitle);

    // Create custom folder containing this group and verify folder tab filter
    const folderTabs = page.locator(DOM.chatFolderTabs);
    const addBtn = folderTabs
      .locator('[data-testid="btn-create-folder"], button[title*="folder" i]')
      .or(scopedButton(folderTabs, bilingualRegex('\\+|new\\s*folder|add\\s*folder', '新建分组|添加分组')))
      .first();
    await expect(addBtn).toBeVisible();
    await addBtn.click();

    const dialog = page.locator('[role="dialog"]').first();
    await expect(dialog).toBeVisible();
    await scopedTextbox(dialog, bilingualRegex('folder|name|title', '名称|分组')).first().fill('核心');
    const grpOpt = dialog.getByText(groupTitle).first();
    await expect(grpOpt).toBeVisible();
    await grpOpt.click();
    await scopedButton(dialog, BILINGUAL_PATTERNS.confirm).first().click();
    await expect(dialog).toBeHidden();

    const coreFolderTab = folderTabs.getByText('核心').first();
    await expect(coreFolderTab).toBeVisible();
    await coreFolderTab.click();
    await expect(page.locator(DOM.chatList)).toContainText(groupTitle);

    // Global CJK search jumps directly to the group
    await page.locator(DOM.globalSearchInput).fill('联合检索验证标记902');
    const hit = page.locator(DOM.leftColumn).getByText(/联合检索验证标记902|核心架构群/).first();
    await expect(hit).toBeVisible();
    await hit.click();
    await expect(page.locator(DOM.chatHeaderTitle)).toContainText(groupTitle);
  });

  test('PW-03 (A04 x A05 x A03): Supergroup Forum Topic + Reply + topic-scoped #pinned-message-banner + topic-scoped In-Chat Search', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token, {
      includeGroup: true,
      isForumGroup: true,
      groupTitle: 'PW03 Forum Room',
    });
    expect(conv.groupTitle).toBeTruthy();
    await sendApiMessage(request, user.token, conv.groupChatId!, 'General root post');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.groupTitle!);

    const topicList = page.locator(DOM.forumTopicList);
    await expect(topicList).toBeVisible();
    const newTopicBtn = scopedButton(
      topicList.or(page.locator(DOM.leftColumn)).first(),
      bilingualRegex('new\\s*topic|create\\s*topic|\\+', '新建话题|创建话题'),
    ).first();
    await expect(newTopicBtn).toBeVisible();
    await newTopicBtn.click();

    const dialog = page.locator('[role="dialog"]').first();
    await expect(dialog).toBeVisible();
    await dialog.locator('input').first().fill('QA Release Topic');
    await scopedButton(dialog, BILINGUAL_PATTERNS.confirm).first().click();
    await expect(dialog).toBeHidden();

    await topicList.getByText('QA Release Topic').first().click();
    await expect(page.locator(DOM.messageList)).not.toContainText('General root post');

    const anchorBubble = await sendTextMessage(page, 'TopicPinNeedle_PW03');

    await openContextMenuAndClick(page, anchorBubble, BILINGUAL_PATTERNS.pin);
    await expect(page.locator(DOM.pinnedMessageBanner)).toContainText('TopicPinNeedle_PW03');

    await openContextMenuAndClick(page, anchorBubble, BILINGUAL_PATTERNS.reply);
    await sendTextMessage(page, 'TopicReply_PW03');
    await expect(page.locator(DOM.messageList)).toContainText('TopicReply_PW03');

    await page.locator(DOM.btnInChatSearch).click();
    await page.locator(DOM.inChatSearchInput).fill('TopicPinNeedle_PW03');
    await expect(page.locator(DOM.messageList)).toContainText('TopicPinNeedle_PW03');
  });
});
