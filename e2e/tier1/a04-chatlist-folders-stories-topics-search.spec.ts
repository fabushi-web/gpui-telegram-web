import { test, expect } from '../helpers/fixtures';
import { DOM } from '../helpers/selectors';
import {
  createRealConversationFixture,
  generateUniqueUsername,
  registerUserViaApi,
  sendApiMessage,
} from '../helpers/server';
import {
  bilingualRegex,
  BILINGUAL_PATTERNS,
  openBurgerMenu,
  openContextMenuAndClick,
  scopedButton,
  scopedTextbox,
  selectChat,
  sendTextMessage,
} from '../helpers/ui';

test.describe('Tier 1 — A04: Virtualized Chat List, Folders, Archive, Stories, Topics & CJK Search', () => {
  test('A04-T1-01: Virtualized #chat-list rows with context menu Pin, Mute, Mark Unread, and Archive actions', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token, {
      includeGroup: true,
      groupTitle: 'Context Ops Room',
    });
    await page.reload({ waitUntil: 'domcontentloaded' });

    const targetRow = page
      .locator(DOM.chatList)
      .locator(DOM.chatRow)
      .filter({ hasText: conv.dmTitle })
      .first();
    await expect(targetRow).toBeVisible();

    // 1. Mute -> verify context menu flips to Unmute
    await openContextMenuAndClick(page, targetRow, BILINGUAL_PATTERNS.mute);
    await targetRow.click({ button: 'right' });
    const muteMenu = page.locator('[role="menu"], [data-testid="context-menu"]').first();
    await expect(muteMenu).toBeVisible();
    await expect(
      muteMenu
        .getByRole('menuitem', { name: BILINGUAL_PATTERNS.unmute })
        .or(muteMenu.getByRole('button', { name: BILINGUAL_PATTERNS.unmute }))
        .first(),
    ).toBeVisible();
    await page.keyboard.press('Escape');

    // 2. Mark Unread -> verify context menu flips to Mark Read
    await openContextMenuAndClick(page, targetRow, BILINGUAL_PATTERNS.markUnread);
    await targetRow.click({ button: 'right' });
    await expect(muteMenu).toBeVisible();
    await expect(
      muteMenu
        .getByRole('menuitem', { name: BILINGUAL_PATTERNS.markRead })
        .or(muteMenu.getByRole('button', { name: BILINGUAL_PATTERNS.markRead }))
        .first(),
    ).toBeVisible();
    await page.keyboard.press('Escape');

    // 3. Pin -> verify Apple 3x3 pinned grid displays pinned chat
    await openContextMenuAndClick(page, targetRow, BILINGUAL_PATTERNS.pin);
    await expect(page.locator(DOM.sidebarPinnedChatsGrid)).toBeVisible();
    await expect(page.locator(DOM.sidebarPinnedChatsGrid)).toContainText(conv.dmTitle);

    // 4. Archive -> verify #archived-chats-row appears and chat moves out of main list
    const archiveTarget = page
      .locator(`${DOM.sidebarPinnedChatsGrid} [data-chat-id], ${DOM.chatList} ${DOM.chatRow}`)
      .filter({ hasText: conv.dmTitle })
      .first();
    await openContextMenuAndClick(page, archiveTarget, BILINGUAL_PATTERNS.archive);
    await expect(page.locator(DOM.archivedChatsRow)).toBeVisible();
    await expect(page.locator(DOM.chatList)).not.toContainText(conv.dmTitle);
  });

  test('A04-T1-02: Custom Chat Folders CRUD (#chat-folder-tabs) filtering real chats and persisting across reload', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token, {
      includeGroup: true,
      groupTitle: 'Release War Room',
    });
    await page.reload({ waitUntil: 'domcontentloaded' });

    const folderTabs = page.locator(DOM.chatFolderTabs);
    await expect(folderTabs).toBeVisible();

    const addFolderBtn = folderTabs
      .locator('[data-testid="btn-create-folder"], button[title*="folder" i], button[aria-label*="folder" i]')
      .or(scopedButton(folderTabs, bilingualRegex('\\+|new\\s*folder|add\\s*folder|edit\\s*folder', '新建分组|添加分组|管理分组')))
      .first();
    await expect(addFolderBtn).toBeVisible();
    await addFolderBtn.click();

    const dialog = page.locator('[role="dialog"]').first();
    await expect(dialog).toBeVisible();
    const nameInput = scopedTextbox(dialog, bilingualRegex('folder\\s*name|title|name', '分组名称|名称')).first();
    await nameInput.fill('WorkOps');

    const groupOption = dialog.getByText(conv.groupTitle ?? 'Release War Room').first();
    await expect(groupOption).toBeVisible();
    await groupOption.click();
    await scopedButton(dialog, BILINGUAL_PATTERNS.confirm).first().click();

    const workTab = folderTabs.getByText('WorkOps').first();
    await expect(workTab).toBeVisible();
    await workTab.click();
    await expect(page.locator(DOM.chatList)).toContainText(conv.groupTitle ?? 'Release War Room');
    await expect(page.locator(DOM.chatList)).not.toContainText(conv.dmTitle);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator(DOM.chatFolderTabs).getByText('WorkOps')).toBeVisible();
  });

  test('A04-T1-03: #archived-chats-row expand/collapse, Saved Messages (#menu-item-saved-messages), and real Stories post/view (#stories-bar, #stories-viewer)', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token);
    await page.reload({ waitUntil: 'domcontentloaded' });

    const row = page.locator(DOM.chatList).locator(DOM.chatRow).filter({ hasText: conv.dmTitle }).first();
    await openContextMenuAndClick(page, row, BILINGUAL_PATTERNS.archive);
    const archivedRow = page.locator(DOM.archivedChatsRow);
    await expect(archivedRow).toBeVisible();
    await archivedRow.click();
    await expect(page.locator(DOM.chatList)).toContainText(conv.dmTitle);
    // Collapse archived drawer and verify archived chat is hidden again
    await archivedRow.click();
    await expect(page.locator(DOM.chatList)).not.toContainText(conv.dmTitle);

    // Saved Messages
    await openBurgerMenu(page);
    await page.locator(DOM.menuItemSavedMessages).click();
    await expect(page.locator(DOM.chatHeaderTitle)).toHaveText(BILINGUAL_PATTERNS.savedMessages);
    await sendTextMessage(page, 'Saved bookmark note');

    // Post and open a real Story
    const storiesBar = page.locator(DOM.storiesBar);
    await expect(storiesBar).toBeVisible();
    const postStoryBtn = scopedButton(
      storiesBar,
      bilingualRegex('add\\s*story|new\\s*story|my\\s*story|\\+', '发布动态|新建动态|我的动态'),
    ).first();
    await expect(postStoryBtn).toBeVisible();
    await postStoryBtn.click();

    const storyDialog = page.locator('[role="dialog"]').first();
    await expect(storyDialog).toBeVisible();
    const captionInput = storyDialog.locator('input, textarea').first();
    await captionInput.fill('Real E2E Story Update');
    await scopedButton(storyDialog, BILINGUAL_PATTERNS.confirm).first().click();

    const storyRing = storiesBar.locator('button, [data-story-id]').filter({ hasText: /story|my|动态|Real/i }).first();
    await expect(storyRing).toBeVisible();
    await storyRing.click();
    await expect(page.locator(DOM.storiesViewer)).toBeVisible();
    await expect(page.locator(DOM.storiesViewer)).toContainText('Real E2E Story Update');
  });

  test('A04-T1-04: Supergroup Forum Topics (#forum-topic-list) creation, switching, and topic-scoped message isolation', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token, {
      includeGroup: true,
      isForumGroup: true,
      groupTitle: 'Forum Engineering HQ',
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.groupTitle ?? 'Forum Engineering HQ');

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
    await dialog.locator('input').first().fill('Release Checklist');
    await scopedButton(dialog, BILINGUAL_PATTERNS.confirm).first().click();

    const newTopic = topicList.getByText('Release Checklist').first();
    await expect(newTopic).toBeVisible();
    await newTopic.click();

    const topicMarker = `Topic_Scoped_Only_${Date.now()}`;
    await sendTextMessage(page, topicMarker);

    // Switch back to General topic and confirm strict topic isolation
    const generalTopic = topicList.locator(DOM.forumTopicItem).first();
    await generalTopic.click();
    await expect(page.locator(DOM.messageList)).not.toContainText(topicMarker);
  });

  test('A04-T1-05: Global CJK full-text search (#global-search-input, #search-tabs) highlighting snippets and jumping to chat', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token, {
      initialDmMessages: [
        { from: 'peer', text: '季度架构评审会议纪要：法布施网页版全面对齐桌面端' },
      ],
    });
    await page.reload({ waitUntil: 'domcontentloaded' });

    const searchInput = page.locator(DOM.globalSearchInput);
    await expect(searchInput).toBeVisible();
    await searchInput.fill('法布施网页版');

    await expect(page.locator(DOM.searchTabs)).toBeVisible();
    const messagesTab = page
      .locator(DOM.searchTabs)
      .getByRole('tab', { name: bilingualRegex('messages', '消息') })
      .or(page.locator(DOM.searchTabs).getByRole('button', { name: bilingualRegex('messages', '消息') }))
      .first();
    await messagesTab.click();

    const hit = page.locator(DOM.leftColumn).getByText(/法布施网页版/).first();
    await expect(hit).toBeVisible();
    await hit.click();
    await expect(page.locator(DOM.chatHeaderTitle)).toContainText(conv.dmTitle);
  });

  test('A04-T1-06: In-chat search (#btn-in-chat-search, #in-chat-search-input, #in-chat-search-prev/next) & real contact lookup (#modal-contacts)', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token, {
      initialDmMessages: [
        { from: 'peer', text: 'First needle token AlphaSearch99' },
        { from: 'primary', text: 'Unrelated filler line' },
        { from: 'peer', text: 'Second needle token AlphaSearch99' },
      ],
    });
    const extraUser = await registerUserViaApi(request, {
      username: generateUniqueUsername('realcontact'),
      firstName: 'Verified Contact',
    });
    await sendApiMessage(request, user.token, conv.dmChatId, 'Third needle token AlphaSearch99');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.dmTitle);

    await page.locator(DOM.btnInChatSearch).click();
    const inChatInput = page.locator(DOM.inChatSearchInput);
    await expect(inChatInput).toBeVisible();
    await inChatInput.fill('AlphaSearch99');

    await expect(page.locator(DOM.inChatSearchPrev)).toBeVisible();
    await expect(page.locator(DOM.inChatSearchNext)).toBeVisible();
    await expect(page.locator(DOM.messageList)).toContainText('AlphaSearch99');
    await expect(page.locator('#in-chat-search-bar, #middle-column').first()).toContainText(
      /[123]\s*\/\s*3|\b3\b/i,
    );
    await page.locator(DOM.inChatSearchPrev).click();
    await page.locator(DOM.inChatSearchNext).click();

    // Real contact lookup in #modal-contacts (verified existing user)
    await openBurgerMenu(page);
    await page.locator(DOM.menuItemContacts).click();
    const contactsModal = page.locator(DOM.modalContacts);
    await expect(contactsModal).toBeVisible();

    const addBtn = scopedButton(contactsModal, bilingualRegex('add\\s*contact|new\\s*contact', '添加联系人|新建联系人')).first();
    await expect(addBtn).toBeVisible();
    await addBtn.click();

    await contactsModal.locator('input').first().fill(extraUser.username);
    await scopedButton(contactsModal, BILINGUAL_PATTERNS.confirm).first().click();
    await expect(contactsModal).toContainText(extraUser.firstName);
  });
});
