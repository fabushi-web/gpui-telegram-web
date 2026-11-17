import type { Page } from '@playwright/test';
import {
  BILINGUAL_PATTERNS,
  chatRowById,
  createPngFilePayload,
  DATA_ATTRS,
  DOM,
  expect,
  folderTabById,
  messageBubbleById,
  openBurgerMenu,
  openContextMenuAndClick,
  openSettings,
  scopedButton,
  scopedMenuItem,
  scopedTextbox,
  selectChat,
  sendTextMessage,
  test,
  topicRowById,
} from '../helpers';

const STRICT_MENU_REGEX = {
  pin: /^(?!.*(?:unpin|取消|移出))(?:.*\bpin\b.*|.*置顶.*)$/is,
  unpin: /unpin|取消置顶/i,
  mute: /^(?!.*(?:unmute|取消|开启|解除))(?:.*\bmute\b.*|.*静音.*|.*免打扰.*)$/is,
  unmute: /unmute|取消静音|开启通知|解除静音/i,
  markRead:
    /^(?!.*(?:unread|未读))(?:.*\bmark\b.*\bread\b.*|.*标(?:记)?为?已读.*)$/is,
  markUnread: /\bunread\b|标(?:记)?为?未读/i,
  archive: /^(?!.*(?:unarchive|取消|移出))(?:.*\barchive\b.*|.*归档.*)$/is,
  unarchive: /unarchive|取消归档|移出归档/i,
} as const;

const ALL_CHATS_TAB_REGEX = /^(?:all(?:\s*chats)?|全部|所有聊天)(?:\s*\(?\d+\)?)?$/i;

async function ensureAllChatsFolderSelected(page: Page): Promise<void> {
  const folderTabs = page.locator(DOM.chatFolderTabs);
  if (await folderTabs.isVisible()) {
    const byDataId = folderTabs.locator('[data-folder-id="all"]').first();
    const byText = folderTabs
      .locator('[data-folder-id]')
      .filter({ hasText: ALL_CHATS_TAB_REGEX })
      .first();
    if ((await byDataId.count()) > 0 && (await byDataId.isVisible())) {
      await byDataId.click();
    } else if ((await byText.count()) > 0 && (await byText.isVisible())) {
      await byText.click();
    } else {
      await folderTabs.locator('[data-folder-id]').first().click();
    }
  }
}

async function dismissSettingsPanelBounded(page: Page): Promise<void> {
  const panel = page.locator(DOM.settingsPanel);
  for (let i = 0; i < 8 && (await panel.isVisible()); i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(80);
  }
  if (await panel.isVisible()) {
    const closeBtn = scopedButton(panel, BILINGUAL_PATTERNS.cancel)
      .or(scopedButton(panel, BILINGUAL_PATTERNS.back))
      .first();
    for (
      let i = 0;
      i < 4 &&
      (await panel.isVisible()) &&
      (await closeBtn.count()) > 0 &&
      (await closeBtn.isVisible());
      i++
    ) {
      await closeBtn.click();
      await page.waitForTimeout(80);
    }
  }
  await expect(panel).toBeHidden();
}

async function pickTwoNonSavedChats(
  page: Page,
): Promise<{
  chatAId: string;
  chatATitle: string;
  chatBId: string;
  chatBTitle: string;
}> {
  const rows = page.locator(`${DOM.chatList} ${DOM.chatRow}`);
  await expect(rows.first()).toBeVisible();
  const count = await rows.count();
  expect(count).toBeGreaterThanOrEqual(3);

  const candidates: Array<{ id: string; title: string }> = [];
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const id = (await row.getAttribute(DATA_ATTRS.chatId)) ?? '';
    const text = ((await row.innerText()) ?? '').trim();
    if (!id || BILINGUAL_PATTERNS.savedMessages.test(text)) {
      continue;
    }
    const firstLine = text.split('\n')[0]?.trim() ?? id;
    candidates.push({ id, title: firstLine });
  }

  expect(candidates.length).toBeGreaterThanOrEqual(2);
  // Pick lower unpinned chat as chatA so pinning produces a clear upward move
  const chatA = candidates[candidates.length - 1]!;
  const chatB = candidates[0]!;
  return {
    chatAId: chatA.id,
    chatATitle: chatA.title,
    chatBId: chatB.id,
    chatBTitle: chatB.title,
  };
}

test.describe('F4 — Virtualized Chat List, Chat Folders, Archive, Stories & Forum Topics', () => {
  test('F4-1: Virtualized #chat-list rows render deterministic peer avatars, unread pills, pin/mute indicators, and right-click context menu actions', async ({
    authPage,
  }) => {
    await ensureAllChatsFolderSelected(authPage);

    const chatList = authPage.locator(DOM.chatList);
    const rows = chatList.locator(DOM.chatRow);
    await expect(rows.first()).toBeVisible();
    const visibleCount = await rows.count();
    expect(visibleCount).toBeGreaterThanOrEqual(3);

    // 1. Verify unique data-chat-id, realistic row geometry, and deterministic gradient/colored avatars
    const seenIds: string[] = [];
    let hasStyledAvatarSurface = false;

    for (let i = 0; i < visibleCount; i++) {
      const row = rows.nth(i);
      const chatId = await row.getAttribute(DATA_ATTRS.chatId);
      expect(chatId).toBeTruthy();
      seenIds.push(chatId!);

      const box = await row.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeLessThanOrEqual(112);
      expect(box!.width).toBeGreaterThanOrEqual(200);

      const avatarCheck = await row.evaluate((el: Element) => {
        const avatarEl =
          el.querySelector(
            '[data-avatar], [data-peer-avatar], [data-testid*="avatar" i], [class*="avatar" i], img',
          ) ?? el.firstElementChild;
        if (!avatarEl) {
          return { exists: false, colored: false };
        }
        const rect = avatarEl.getBoundingClientRect();
        const st = window.getComputedStyle(avatarEl);
        const colored =
          avatarEl.tagName.toLowerCase() === 'img' ||
          st.backgroundImage.includes('gradient') ||
          (st.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
            st.backgroundColor !== 'transparent');
        return {
          exists: rect.width >= 28 && rect.height >= 28,
          colored,
        };
      });

      expect(avatarCheck.exists).toBe(true);
      if (avatarCheck.colored) {
        hasStyledAvatarSurface = true;
      }
    }

    expect(new Set(seenIds).size).toBe(seenIds.length);
    expect(hasStyledAvatarSurface).toBe(true);

    // 2. Select chatA to clear any initial unread state, then switch active stage to chatB
    const { chatAId, chatBId } = await pickTwoNonSavedChats(authPage);
    await selectChat(authPage, chatAId);
    await selectChat(authPage, chatBId);

    const rowA = chatList.locator(chatRowById(chatAId));
    await expect(rowA).toBeVisible();

    const unreadBadgeLoc = rowA.locator(
      '[data-unread="true"], [data-unread-count], [data-testid*="unread" i], [class*="unread" i], [aria-label*="unread" i], [aria-label*="未读"]',
    );

    // 3. Context Menu: Mark as Unread -> verify unread pill -> Mark as Read -> verify cleared
    await openContextMenuAndClick(authPage, rowA, STRICT_MENU_REGEX.markUnread);
    await expect(unreadBadgeLoc.first()).toBeVisible();

    await rowA.click({ button: 'right' });
    const ctxMenu = authPage
      .locator('[role="menu"], [data-testid="context-menu"]')
      .first();
    await expect(ctxMenu).toBeVisible();
    await expect(
      scopedMenuItem(ctxMenu, STRICT_MENU_REGEX.archive).first(),
    ).toBeVisible();
    const markReadItem = scopedMenuItem(
      ctxMenu,
      STRICT_MENU_REGEX.markRead,
    ).first();
    await expect(markReadItem).toBeVisible();
    await markReadItem.click();

    await expect
      .poll(
        async () => {
          const count = await unreadBadgeLoc.count();
          if (count === 0) return true;
          return !(await unreadBadgeLoc.first().isVisible());
        },
        { message: 'Expected unread badge on chatA to clear after Mark as Read' },
      )
      .toBe(true);

    // 4. Context Menu: Pin -> verify pinned ordering / pin indicator -> Unpin
    await rowA.click({ button: 'right' });
    const menuBeforePin = authPage
      .locator('[role="menu"], [data-testid="context-menu"]')
      .first();
    await expect(menuBeforePin).toBeVisible();
    const existingUnpin = scopedMenuItem(
      menuBeforePin,
      STRICT_MENU_REGEX.unpin,
    ).first();
    if (
      (await existingUnpin.count()) > 0 &&
      (await existingUnpin.isVisible())
    ) {
      await existingUnpin.click();
    } else {
      await authPage.keyboard.press('Escape');
    }

    const readRowIndex = async (targetId: string): Promise<number> => {
      const currentRows = chatList.locator(DOM.chatRow);
      const n = await currentRows.count();
      for (let i = 0; i < n; i++) {
        if ((await currentRows.nth(i).getAttribute(DATA_ATTRS.chatId)) === targetId) {
          return i;
        }
      }
      return -1;
    };

    const indexUnpinned = await readRowIndex(chatAId);
    expect(indexUnpinned).toBeGreaterThanOrEqual(0);

    await openContextMenuAndClick(authPage, rowA, STRICT_MENU_REGEX.pin);

    await expect
      .poll(
        async () => {
          const idxNow = await readRowIndex(chatAId);
          const hasPinAttrOrBadge =
            (await rowA.getAttribute('data-pinned')) === 'true' ||
            (await rowA
              .locator(
                '[data-pinned="true"], [data-testid*="pin" i], [class*="pin" i], [aria-label*="pin" i], [aria-label*="置顶"]',
              )
              .count()) > 0 ||
            /📌/.test(await rowA.innerText());
          return idxNow >= 0 && idxNow <= indexUnpinned && (idxNow < indexUnpinned || hasPinAttrOrBadge);
        },
        { message: 'Expected pinned chatA to move upward and/or render pin badge' },
      )
      .toBe(true);

    await openContextMenuAndClick(authPage, rowA, STRICT_MENU_REGEX.unpin);

    // 5. Context Menu: Mute -> verify mute indicator -> Unmute
    const svgCountBeforeMute = await rowA.locator('svg').count();
    await openContextMenuAndClick(authPage, rowA, STRICT_MENU_REGEX.mute);

    // Handle optional Mute duration submenu ("Mute forever" / "永久静音")
    await authPage.waitForTimeout(200);
    const maybeDurationMenu = authPage
      .locator('[role="menu"]:visible, [data-testid="context-menu"]:visible')
      .first();
    if ((await maybeDurationMenu.count()) > 0) {
      const foreverItem = scopedMenuItem(
        maybeDurationMenu,
        /forever|always|until|mute\s*notifications|永久|一直|关闭通知/i,
      ).first();
      if ((await foreverItem.count()) > 0 && (await foreverItem.isVisible())) {
        await foreverItem.click();
      }
    }

    await expect
      .poll(
        async () => {
          const mutedAttr = await rowA.getAttribute('data-muted');
          const muteNodeCount = await rowA
            .locator(
              '[data-muted="true"], [data-testid*="mute" i], [class*="mute" i], [aria-label*="mute" i], [aria-label*="静音"]',
            )
            .count();
          const svgCountNow = await rowA.locator('svg').count();
          const hasBellEmoji = /🔕/.test(await rowA.innerText());
          return (
            mutedAttr === 'true' ||
            muteNodeCount > 0 ||
            svgCountNow > svgCountBeforeMute ||
            hasBellEmoji
          );
        },
        { message: 'Expected muted indicator on chatA after Mute' },
      )
      .toBe(true);

    await openContextMenuAndClick(authPage, rowA, STRICT_MENU_REGEX.unmute);
  });

  test('F4-2: #chat-folder-tabs ([data-folder-id]) filters across built-in folders (All, Personal, Work, Bots, Unread) and supports Custom Folder CRUD', async ({
    authPage,
  }) => {
    const folderTabs = authPage.locator(DOM.chatFolderTabs);
    await expect(folderTabs).toBeVisible();
    const tabItems = folderTabs.locator('[data-folder-id]');
    expect(await tabItems.count()).toBeGreaterThanOrEqual(5);

    await ensureAllChatsFolderSelected(authPage);

    // Deterministically prepare 1 unread chat (chatA) and 1 read chat (chatB)
    const { chatAId, chatATitle, chatBId } = await pickTwoNonSavedChats(authPage);
    await selectChat(authPage, chatAId);
    await selectChat(authPage, chatBId);

    const chatList = authPage.locator(DOM.chatList);
    await openContextMenuAndClick(
      authPage,
      chatList.locator(chatRowById(chatAId)),
      STRICT_MENU_REGEX.markUnread,
    );

    const collectVisibleChatIds = async (): Promise<string[]> => {
      const r = chatList.locator(DOM.chatRow);
      const n = await r.count();
      const out: string[] = [];
      for (let i = 0; i < n; i++) {
        const id = await r.nth(i).getAttribute(DATA_ATTRS.chatId);
        if (id) out.push(id);
      }
      return out;
    };

    const allChatIds = await collectVisibleChatIds();
    expect(allChatIds.length).toBeGreaterThanOrEqual(3);

    const builtInFolders = [
      { key: 'all', pattern: ALL_CHATS_TAB_REGEX },
      { key: 'personal', pattern: /personal|private|个人|私聊/i },
      { key: 'work', pattern: /work|工作/i },
      { key: 'bots', pattern: /bots?|机器人/i },
      { key: 'unread', pattern: /unread|未读/i },
    ] as const;

    for (const folder of builtInFolders) {
      const explicitAllTab = folderTabs.locator('[data-folder-id="all"]').first();
      const tab =
        folder.key === 'all' &&
        (await explicitAllTab.count()) > 0 &&
        (await explicitAllTab.isVisible())
          ? explicitAllTab
          : tabItems.filter({ hasText: folder.pattern }).first();
      await tab.scrollIntoViewIfNeeded();
      await expect(tab).toBeVisible();
      const folderId = await tab.getAttribute(DATA_ATTRS.folderId);
      expect(folderId).toBeTruthy();

      await tab.click();

      if (folder.key === 'bots') {
        await expect
          .poll(async () => {
            const ids = await collectVisibleChatIds();
            return ids.length >= 1 && ids.length < allChatIds.length;
          })
          .toBe(true);
      } else if (folder.key === 'unread') {
        await expect(chatList.locator(chatRowById(chatAId))).toBeVisible();
        await expect(chatList.locator(chatRowById(chatBId))).toHaveCount(0);
      }
    }

    await ensureAllChatsFolderSelected(authPage);

    // Custom Folder CRUD: Create -> Filter -> Edit -> Delete
    const directAddFolderBtn = scopedButton(
      folderTabs,
      /create|new|add|\+|新建|创建|添加/i,
    ).first();

    let openedFolderModal = false;
    if (
      (await directAddFolderBtn.count()) > 0 &&
      (await directAddFolderBtn.isVisible())
    ) {
      await directAddFolderBtn.click();
      openedFolderModal = true;
    } else {
      await folderTabs.click({ button: 'right' });
      const ctx = authPage
        .locator('[role="menu"]:visible, [data-testid="context-menu"]:visible')
        .first();
      if ((await ctx.count()) > 0) {
        const createItem = scopedMenuItem(
          ctx,
          /create.*folder|new.*folder|add.*folder|manage.*folder|新建.*分组|创建.*分组|添加.*分组|文件夹/i,
        ).first();
        if ((await createItem.count()) > 0 && (await createItem.isVisible())) {
          await createItem.click();
          openedFolderModal = true;
        } else {
          await authPage.keyboard.press('Escape');
        }
      }
    }

    if (!openedFolderModal) {
      const settingsPanel = await openSettings(authPage);
      const foldersSection = settingsPanel
        .locator('[data-settings-section*="folder" i]')
        .or(scopedMenuItem(settingsPanel, /folders|分组|文件夹/i))
        .first();
      await expect(foldersSection).toBeVisible();
      await foldersSection.click();

      const createFolderBtn = scopedButton(
        settingsPanel,
        BILINGUAL_PATTERNS.create,
      ).first();
      await expect(createFolderBtn).toBeVisible();
      await createFolderBtn.click();
    }

    const folderForm = authPage
      .locator('[role="dialog"]:visible')
      .last()
      .or(authPage.locator(DOM.settingsPanel))
      .first();
    await expect(folderForm).toBeVisible();

    const folderNameInput = scopedTextbox(
      folderForm,
      /folder\s*name|name|title|分组名称|文件夹名称|名称|标题/i,
    )
      .or(folderForm.locator('input[type="text"]:visible').first())
      .first();
    await expect(folderNameInput).toBeVisible();
    await folderNameInput.fill('E2E 专注组 Alpha');

    // Include chatA in the custom folder
    const addChatsSubBtn = scopedButton(
      folderForm,
      /add\s*chats|include\s*chats|select\s*chats|添加聊天|包含聊天|选择会话/i,
    ).first();
    if (
      (await addChatsSubBtn.count()) > 0 &&
      (await addChatsSubBtn.isVisible())
    ) {
      await addChatsSubBtn.click();
      const pickerDialog = authPage.locator('[role="dialog"]:visible').last();
      const chatOption = pickerDialog
        .locator('[role="option"], [role="checkbox"], label, li, button')
        .filter({ hasText: chatATitle })
        .first();
      await expect(chatOption).toBeVisible();
      await chatOption.click();
      const confirmPicker = scopedButton(
        pickerDialog,
        BILINGUAL_PATTERNS.confirm,
      ).first();
      if (
        (await confirmPicker.count()) > 0 &&
        (await confirmPicker.isVisible())
      ) {
        await confirmPicker.click();
      }
    } else {
      const inlineOption = folderForm
        .locator('[role="option"], [role="checkbox"], label, li, button')
        .filter({ hasText: chatATitle })
        .first();
      if ((await inlineOption.count()) > 0 && (await inlineOption.isVisible())) {
        await inlineOption.click();
      }
    }

    const saveFolderBtn = scopedButton(
      folderForm,
      BILINGUAL_PATTERNS.confirm,
    ).first();
    await expect(saveFolderBtn).toBeVisible();
    await saveFolderBtn.click();

    await dismissSettingsPanelBounded(authPage);

    const customTab = folderTabs
      .locator('[data-folder-id]')
      .filter({ hasText: 'E2E 专注组 Alpha' })
      .first();
    await customTab.scrollIntoViewIfNeeded();
    await expect(customTab).toBeVisible();
    const customFolderId = await customTab.getAttribute(DATA_ATTRS.folderId);
    expect(customFolderId).toBeTruthy();

    await authPage.locator(folderTabById(customFolderId!)).click();
    await expect(chatList.locator(chatRowById(chatAId))).toBeVisible();
    const customFilteredIds = await collectVisibleChatIds();
    expect(customFilteredIds.length).toBeLessThan(allChatIds.length);

    // Edit Custom Folder -> rename to 'E2E 专注组 Beta'
    const customTabById = authPage.locator(folderTabById(customFolderId!));
    await customTabById.click({ button: 'right' });
    const tabCtx = authPage
      .locator('[role="menu"]:visible, [data-testid="context-menu"]:visible')
      .first();
    if ((await tabCtx.count()) > 0) {
      const editItem = scopedMenuItem(tabCtx, BILINGUAL_PATTERNS.edit).first();
      await expect(editItem).toBeVisible();
      await editItem.click();
    } else {
      const sPanel = await openSettings(authPage);
      const fSec = sPanel
        .locator('[data-settings-section*="folder" i]')
        .or(scopedMenuItem(sPanel, /folders|分组|文件夹/i))
        .first();
      if ((await fSec.count()) > 0 && (await fSec.isVisible())) {
        await fSec.click();
      }
      const editBtn = sPanel
        .locator('button, [role="button"], li')
        .filter({ hasText: 'E2E 专注组 Alpha' })
        .first();
      await expect(editBtn).toBeVisible();
      await editBtn.click();
    }

    const editForm = authPage
      .locator('[role="dialog"]:visible')
      .last()
      .or(authPage.locator(DOM.settingsPanel))
      .first();
    const editInput = scopedTextbox(
      editForm,
      /folder\s*name|name|title|分组名称|文件夹名称|名称|标题/i,
    )
      .or(editForm.locator('input[type="text"]:visible').first())
      .first();
    await expect(editInput).toBeVisible();
    await editInput.fill('E2E 专注组 Beta');
    await scopedButton(editForm, BILINGUAL_PATTERNS.confirm).first().click();

    await dismissSettingsPanelBounded(authPage);

    await expect(customTabById).toContainText('E2E 专注组 Beta');

    // Delete Custom Folder
    await customTabById.click({ button: 'right' });
    const delCtx = authPage
      .locator('[role="menu"]:visible, [data-testid="context-menu"]:visible')
      .first();
    if ((await delCtx.count()) > 0) {
      const delItem = scopedMenuItem(delCtx, BILINGUAL_PATTERNS.delete).first();
      await expect(delItem).toBeVisible();
      await delItem.click();
    } else {
      const sPanel = await openSettings(authPage);
      const fSec = sPanel
        .locator('[data-settings-section*="folder" i]')
        .or(scopedMenuItem(sPanel, /folders|分组|文件夹/i))
        .first();
      if ((await fSec.count()) > 0 && (await fSec.isVisible())) {
        await fSec.click();
      }
      const folderEntry = sPanel
        .locator('li, div, [data-folder-id]')
        .filter({ hasText: 'E2E 专注组 Beta' })
        .first();
      const delBtn = scopedButton(folderEntry, BILINGUAL_PATTERNS.delete)
        .or(scopedButton(sPanel, BILINGUAL_PATTERNS.delete))
        .first();
      await expect(delBtn).toBeVisible();
      await delBtn.click();
    }

    const confirmDelDialog = authPage.locator('[role="dialog"]:visible').first();
    if ((await confirmDelDialog.count()) > 0) {
      const confirmDelBtn = scopedButton(
        confirmDelDialog,
        BILINGUAL_PATTERNS.delete,
      )
        .or(scopedButton(confirmDelDialog, BILINGUAL_PATTERNS.confirm))
        .first();
      if (
        (await confirmDelBtn.count()) > 0 &&
        (await confirmDelBtn.isVisible())
      ) {
        await confirmDelBtn.click();
      }
    }

    await dismissSettingsPanelBounded(authPage);

    await expect(authPage.locator(folderTabById(customFolderId!))).toHaveCount(
      0,
    );
    await expect(folderTabs).not.toContainText('E2E 专注组 Beta');
  });

  test('F4-3: #archived-chats-row expand/collapse and archive/unarchive chat flow with #menu-item-archived and reload persistence', async ({
    authPage,
  }) => {
    await ensureAllChatsFolderSelected(authPage);

    const { chatAId } = await pickTwoNonSavedChats(authPage);
    const chatList = authPage.locator(DOM.chatList);
    const leftCol = authPage.locator(DOM.leftColumn);
    const targetRow = chatList.locator(chatRowById(chatAId));
    await expect(targetRow).toBeVisible();

    // Archive target chat via context menu
    await openContextMenuAndClick(authPage, targetRow, STRICT_MENU_REGEX.archive);

    // Assert removed from main unarchived #chat-list and #archived-chats-row is visible
    await expect(chatList.locator(chatRowById(chatAId))).toBeHidden();
    const archivedRow = authPage.locator(DOM.archivedChatsRow);
    await expect(archivedRow).toBeVisible();

    // Expand via #archived-chats-row -> verify archived chat row visible inside #left-column
    await archivedRow.click();
    const archivedTargetInLeft = leftCol.locator(chatRowById(chatAId));
    await expect(archivedTargetInLeft).toBeVisible();

    // Collapse / exit Archived view back to main #chat-list
    if (await archivedRow.isVisible()) {
      await archivedRow.click();
    } else {
      const backBtn = scopedButton(leftCol, BILINGUAL_PATTERNS.back)
        .or(
          leftCol.locator(
            'button[aria-label*="back" i], button[aria-label*="返回"]',
          ),
        )
        .first();
      if ((await backBtn.count()) > 0 && (await backBtn.isVisible())) {
        await backBtn.click();
      } else {
        await authPage.keyboard.press('Escape');
      }
    }

    await expect(archivedTargetInLeft).toBeHidden();
    await expect(chatList.locator(DOM.chatRow).first()).toBeVisible();

    // Re-open Archived view via #menu-item-archived and Unarchive target chat
    await openBurgerMenu(authPage);
    const menuArchived = authPage.locator(DOM.menuItemArchived);
    await expect(menuArchived).toBeVisible();
    await menuArchived.click();

    await expect(archivedTargetInLeft).toBeVisible();
    await openContextMenuAndClick(
      authPage,
      archivedTargetInLeft,
      STRICT_MENU_REGEX.unarchive,
    );

    if (!(await chatList.locator(chatRowById(chatAId)).isVisible())) {
      const backFromArchive = scopedButton(leftCol, BILINGUAL_PATTERNS.back)
        .or(
          leftCol.locator(
            'button[aria-label*="back" i], button[aria-label*="返回"]',
          ),
        )
        .first();
      if (
        (await backFromArchive.count()) > 0 &&
        (await backFromArchive.isVisible())
      ) {
        await backFromArchive.click();
      } else if (await archivedRow.isVisible()) {
        await archivedRow.click();
      }
    }

    await expect(chatList.locator(chatRowById(chatAId))).toBeVisible();

    // Verify reload persistence
    await authPage.reload({ waitUntil: 'domcontentloaded' });
    await expect(chatList).toBeVisible();
    await expect(chatList.locator(chatRowById(chatAId))).toBeVisible();
  });

  test('F4-4: #stories-bar avatar ring strip, fullscreen #stories-viewer playback/navigation, and Post Story flow', async ({
    authPage,
  }) => {
    const storiesBar = authPage.locator(DOM.storiesBar);
    const storiesViewer = authPage.locator(DOM.storiesViewer);

    await expect(storiesBar).toBeVisible();
    await expect(storiesViewer).toBeHidden();

    const barBox = await storiesBar.boundingBox();
    expect(barBox).not.toBeNull();
    expect(barBox!.width).toBeGreaterThanOrEqual(160);
    expect(barBox!.height).toBeGreaterThanOrEqual(36);

    const storyRings = storiesBar.locator(
      'button, [role="button"], [data-story-id], [data-peer-id], [data-testid*="story" i]',
    );
    const allRingsBefore = await storyRings.count();
    expect(allRingsBefore).toBeGreaterThanOrEqual(1);

    const peerRings = storyRings.filter({
      hasNotText: /^(?:\+|add(?:\s*story)?|post(?:\s*story)?|新建|发布(?:动态|故事)?)$/i,
    });
    const peerRingsBefore = await peerRings.count();

    // 1. Post Story flow
    const storyCaptionMarker = 'E2E_Story_禅定光束_2026';
    const postStoryBtn = storiesBar
      .locator(
        '[data-testid*="post-story" i], [data-testid*="add-story" i], [data-testid*="create-story" i]',
      )
      .or(
        scopedButton(
          storiesBar,
          /post|add|new|create|my\s*story|\+|发布|添加|新建|我的动态|我的故事/i,
        ),
      )
      .first();

    if ((await postStoryBtn.count()) > 0 && (await postStoryBtn.isVisible())) {
      await postStoryBtn.click();
    } else {
      const fab = authPage.locator(DOM.btnNewChatFab);
      await expect(fab).toBeVisible();
      await fab.click();
      const fabStoryItem = scopedMenuItem(
        authPage,
        /story|动态|故事/i,
      ).first();
      await expect(fabStoryItem).toBeVisible();
      await fabStoryItem.click();
    }

    // If clicking "My Story" opened #stories-viewer first, click its Add/Post Story trigger
    if (await storiesViewer.isVisible()) {
      const innerAddBtn = scopedButton(
        storiesViewer,
        /post|add|new|create|\+|发布|添加|新建/i,
      ).first();
      if ((await innerAddBtn.count()) > 0 && (await innerAddBtn.isVisible())) {
        await innerAddBtn.click();
      }
    }

    const standaloneComposer = authPage
      .locator(
        '[data-testid*="story-composer" i]:visible, [data-testid*="post-story" i]:visible, [role="dialog"]:visible:not(#stories-viewer)',
      )
      .last();
    const isSeparateStoryDialog = (await standaloneComposer.count()) > 0;
    const storyDialog = isSeparateStoryDialog
      ? standaloneComposer
      : storiesViewer;
    await expect(storyDialog).toBeVisible();

    const fileInput = storyDialog
      .locator('input[type="file"]')
      .or(authPage.locator('input[type="file"][accept*="image" i]').last())
      .first();
    if ((await fileInput.count()) > 0) {
      await fileInput.setInputFiles(
        createPngFilePayload('e2e-story.png', {
          width: 360,
          height: 640,
          r: 51,
          g: 144,
          b: 236,
          pattern: 'gradient',
        }),
      );
    }

    const storyCaption = storyDialog
      .locator(
        'textarea:visible, input[type="text"]:visible, [contenteditable="true"]:visible',
      )
      .first();
    const hasStoryCaptionInput = (await storyCaption.count()) > 0;
    if (hasStoryCaptionInput) {
      await storyCaption.fill(storyCaptionMarker);
    }

    const publishBtn = scopedButton(
      storyDialog,
      /post|publish|share|send|create|confirm|发布|分享|发送|创建|确定|确认/i,
    ).first();
    await expect(publishBtn).toBeVisible();
    await publishBtn.click();

    // Verify separate story composer dialog closed after publishing
    if (isSeparateStoryDialog) {
      await expect(standaloneComposer).toBeHidden();
    }

    let observedPostedStoryInViewer = false;
    const viewerContainsMarker = async (): Promise<boolean> => {
      if (!(await storiesViewer.isVisible())) return false;
      const txt = await storiesViewer.innerText();
      if (txt.includes(storyCaptionMarker)) return true;
      const html = await storiesViewer.innerHTML();
      return html.includes(storyCaptionMarker);
    };

    if (await storiesViewer.isVisible()) {
      if (await viewerContainsMarker()) {
        observedPostedStoryInViewer = true;
      }
      await authPage.keyboard.press('Escape');
      await expect(storiesViewer).toBeHidden();
    }

    // 2. Open fullscreen #stories-viewer from #stories-bar and verify posted story + playback + Next/Prev navigation
    const allRingsAfter = await storyRings.count();
    const peerRingsAfter = await peerRings.count();

    const ownStoryRing = storiesBar
      .locator('[data-own-story="true"], [data-is-self="true"]')
      .or(
        peerRings.filter({
          hasText: /my\s*story|you|me|我的动态|我的故事|我/i,
        }),
      )
      .first();

    const ringToOpen =
      (await ownStoryRing.count()) > 0 && (await ownStoryRing.isVisible())
        ? ownStoryRing
        : (await peerRings.count()) > 0
          ? peerRings.first()
          : storyRings.first();
    await expect(ringToOpen).toBeVisible();
    await ringToOpen.click();

    await expect(storiesViewer).toBeVisible();
    const viewerBox = await storiesViewer.boundingBox();
    expect(viewerBox).not.toBeNull();
    expect(viewerBox!.width).toBeGreaterThanOrEqual(360);
    expect(viewerBox!.height).toBeGreaterThanOrEqual(480);

    const playbackElements = storiesViewer.locator(
      '[role="progressbar"], progress, [class*="progress" i], [data-testid*="progress" i], img, video, canvas',
    );
    expect(await playbackElements.count()).toBeGreaterThan(0);

    const progressSegments = storiesViewer.locator(
      '[role="progressbar"], progress, [data-testid*="progress" i], [class*="segment" i]',
    );
    let maxSegmentsSeen = await progressSegments.count();

    if (await viewerContainsMarker()) {
      observedPostedStoryInViewer = true;
    }

    // Step forward across story segments/peers to verify navigation and locate posted story if on a later segment
    for (let step = 0; step < 6 && (await storiesViewer.isVisible()); step++) {
      const segs = await progressSegments.count();
      if (segs > maxSegmentsSeen) {
        maxSegmentsSeen = segs;
      }
      if (await viewerContainsMarker()) {
        observedPostedStoryInViewer = true;
        if (step >= 1) {
          break;
        }
      }
      const nextStoryBtn = scopedButton(
        storiesViewer,
        /next|下一|›|→/i,
      ).first();
      if ((await nextStoryBtn.count()) > 0 && (await nextStoryBtn.isVisible())) {
        await nextStoryBtn.click();
      } else {
        await authPage.keyboard.press('ArrowRight');
      }
      await authPage.waitForTimeout(150);
      if (await viewerContainsMarker()) {
        observedPostedStoryInViewer = true;
        break;
      }
    }

    if (
      !observedPostedStoryInViewer &&
      hasStoryCaptionInput &&
      peerRingsAfter > 1
    ) {
      if (await storiesViewer.isVisible()) {
        await authPage.keyboard.press('Escape');
        await expect(storiesViewer).toBeHidden();
      }
      await peerRings.last().click();
      await expect(storiesViewer).toBeVisible();
      if (await viewerContainsMarker()) {
        observedPostedStoryInViewer = true;
      }
    }

    if (hasStoryCaptionInput) {
      expect(observedPostedStoryInViewer).toBe(true);
    } else {
      expect(
        peerRingsAfter > peerRingsBefore ||
          allRingsAfter > allRingsBefore ||
          maxSegmentsSeen > 1,
      ).toBe(true);
    }

    if (await storiesViewer.isVisible()) {
      const prevStoryBtn = scopedButton(
        storiesViewer,
        /prev|previous|上一|‹|←/i,
      ).first();
      if (
        (await prevStoryBtn.count()) > 0 &&
        (await prevStoryBtn.isVisible())
      ) {
        await prevStoryBtn.click();
      } else {
        await authPage.keyboard.press('ArrowLeft');
      }

      await authPage.keyboard.press('Escape');
      if (await storiesViewer.isVisible()) {
        const closeViewerBtn = scopedButton(
          storiesViewer,
          BILINGUAL_PATTERNS.cancel,
        ).first();
        await expect(closeViewerBtn).toBeVisible();
        await closeViewerBtn.click();
      }
    }

    await expect(storiesViewer).toBeHidden();
  });

  test('F4-5: Saved Messages quick access via #menu-item-saved-messages and Ctrl+0 shortcut with reload persistence', async ({
    authPage,
  }) => {
    const { chatAId } = await pickTwoNonSavedChats(authPage);
    await selectChat(authPage, chatAId);
    await expect(authPage.locator(DOM.chatHeaderTitle)).not.toHaveText(
      BILINGUAL_PATTERNS.savedMessages,
    );

    // 1. Open Saved Messages via #menu-item-saved-messages
    await openBurgerMenu(authPage);
    const savedMenuItem = authPage.locator(DOM.menuItemSavedMessages);
    await expect(savedMenuItem).toBeVisible();
    await savedMenuItem.click();

    await expect(authPage.locator(DOM.chatHeaderTitle)).toHaveText(
      BILINGUAL_PATTERNS.savedMessages,
    );

    // 2. Send self-note
    const selfNote = 'SavedNote_云端收藏_Ctrl0_7788';
    const noteBubble = await sendTextMessage(authPage, selfNote);
    const noteMsgId = await noteBubble.getAttribute(DATA_ATTRS.messageId);
    expect(noteMsgId).toBeTruthy();

    // 3. Switch away to regular chat and jump back via Ctrl+0
    await selectChat(authPage, chatAId);
    await expect(authPage.locator(DOM.chatHeaderTitle)).not.toHaveText(
      BILINGUAL_PATTERNS.savedMessages,
    );
    await expect(
      authPage.locator(DOM.messageList).locator(messageBubbleById(noteMsgId!)),
    ).toHaveCount(0);

    await authPage.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.blur(),
    );
    await authPage.keyboard.press('Control+0');

    await expect(authPage.locator(DOM.chatHeaderTitle)).toHaveText(
      BILINGUAL_PATTERNS.savedMessages,
    );
    await expect(
      authPage.locator(DOM.messageList).locator(messageBubbleById(noteMsgId!)),
    ).toBeVisible();

    // 4. Reload and verify self-note persists in Saved Messages
    await authPage.reload({ waitUntil: 'domcontentloaded' });
    await expect(authPage.locator(DOM.chatList)).toBeVisible();
    if (
      !BILINGUAL_PATTERNS.savedMessages.test(
        (await authPage.locator(DOM.chatHeaderTitle).textContent()) ?? '',
      )
    ) {
      await authPage.keyboard.press('Control+0');
    }

    await expect(authPage.locator(DOM.chatHeaderTitle)).toHaveText(
      BILINGUAL_PATTERNS.savedMessages,
    );
    await expect(
      authPage.locator(DOM.messageList).locator(messageBubbleById(noteMsgId!)),
    ).toBeVisible();
  });

  test('F4-6: Supergroup #forum-topic-list ([data-topic-id]) selection, topic creation, and topic-scoped messaging', async ({
    authPage,
  }) => {
    const topicList = authPage.locator(DOM.forumTopicList);
    const rows = authPage.locator(`${DOM.chatList} ${DOM.chatRow}`);
    await expect(rows.first()).toBeVisible();

    // Scan seeded chats for an existing Forum Supergroup first
    const rowCount = await rows.count();
    let foundForum = false;

    for (let i = 0; i < rowCount; i++) {
      const r = rows.nth(i);
      const id = await r.getAttribute(DATA_ATTRS.chatId);
      const txt = await r.innerText();
      if (
        id &&
        /forum|topic|war.?room|engineering|community|讨论|话题|社区|工程/i.test(
          txt,
        )
      ) {
        await selectChat(authPage, id);
        if (await topicList.isVisible()) {
          foundForum = true;
          break;
        }
      }
    }

    if (!foundForum) {
      for (let i = 0; i < Math.min(rowCount, 8); i++) {
        const id = await rows.nth(i).getAttribute(DATA_ATTRS.chatId);
        if (!id) continue;
        await selectChat(authPage, id);
        if (await topicList.isVisible()) {
          foundForum = true;
          break;
        }
      }
    }

    if (!foundForum) {
      // Create a Forum Supergroup via #modal-create-group
      await openBurgerMenu(authPage);
      await authPage.locator(DOM.menuItemNewGroup).click();
      const groupModal = authPage.locator(DOM.modalCreateGroup);
      await expect(groupModal).toBeVisible();

      const groupNameInput = scopedTextbox(
        groupModal,
        /name|title|group|名称|群名|标题/i,
      )
        .or(groupModal.locator('input[type="text"]:visible').first())
        .first();
      await expect(groupNameInput).toBeVisible();
      await groupNameInput.fill('E2E Forum Hub 话题中心');

      const forumToggle = groupModal
        .getByRole('switch', { name: /forum|topics|话题|分区/i })
        .or(groupModal.getByRole('checkbox', { name: /forum|topics|话题|分区/i }))
        .or(
          groupModal
            .locator('label, button')
            .filter({ hasText: /forum|topics|话题|分区/i }),
        )
        .first();
      await expect(forumToggle).toBeVisible();
      await forumToggle.click();

      const submitGroupBtn = scopedButton(
        groupModal,
        BILINGUAL_PATTERNS.confirm,
      ).first();
      await expect(submitGroupBtn).toBeVisible();
      await submitGroupBtn.click();
      await expect(groupModal).toBeHidden();
    }

    await expect(topicList).toBeVisible();
    const topicItems = authPage.locator(DOM.forumTopicItem);
    await expect(topicItems.first()).toBeVisible();

    const topicAId = await topicItems.first().getAttribute(DATA_ATTRS.topicId);
    expect(topicAId).toBeTruthy();

    // Select Topic A and send Topic-A-scoped message
    await authPage.locator(topicRowById(topicAId!)).click();
    const msgTopicA = 'ForumScoped_TopicA_综合讨论_111';
    await sendTextMessage(authPage, msgTopicA);

    // Create New Topic B ('Architecture 架构评审')
    const createTopicBtn = topicList
      .locator('[data-testid*="create-topic" i], [data-testid*="new-topic" i]')
      .or(
        scopedButton(
          topicList,
          /create\s*topic|new\s*topic|add\s*topic|\+\s*topic|\+|新建话题|创建话题|添加话题/i,
        ),
      )
      .or(
        scopedButton(
          authPage.locator(DOM.leftColumn),
          /create\s*topic|new\s*topic|新建话题|创建话题/i,
        ),
      )
      .or(
        scopedButton(
          authPage.locator(DOM.chatHeader),
          /create\s*topic|new\s*topic|新建话题|创建话题/i,
        ),
      )
      .first();

    await expect(createTopicBtn).toBeVisible();
    await createTopicBtn.click();

    const topicModalOrInline = authPage
      .locator('[role="dialog"]:visible')
      .last()
      .or(topicList)
      .first();
    const topicTitleInput = scopedTextbox(
      topicModalOrInline,
      /topic|name|title|话题|名称|标题/i,
    )
      .or(topicModalOrInline.locator('input[type="text"]:visible').last())
      .first();
    await expect(topicTitleInput).toBeVisible();
    await topicTitleInput.fill('Architecture 架构评审');

    const confirmTopicBtn = scopedButton(
      topicModalOrInline,
      BILINGUAL_PATTERNS.confirm,
    ).first();
    if (
      (await confirmTopicBtn.count()) > 0 &&
      (await confirmTopicBtn.isVisible())
    ) {
      await confirmTopicBtn.click();
    } else {
      await topicTitleInput.press('Enter');
    }

    const topicBRow = topicItems
      .filter({ hasText: 'Architecture 架构评审' })
      .first();
    await expect(topicBRow).toBeVisible();
    const topicBId = await topicBRow.getAttribute(DATA_ATTRS.topicId);
    expect(topicBId).toBeTruthy();
    expect(topicBId).not.toBe(topicAId);

    // Select Topic B -> verify header updates, Topic A message is isolated, and Topic B message persists
    await authPage.locator(topicRowById(topicBId!)).click();
    await expect(authPage.locator(DOM.chatHeader)).toContainText(
      'Architecture 架构评审',
    );
    await expect(
      authPage
        .locator(DOM.messageList)
        .locator(DOM.messageBubble)
        .filter({ hasText: msgTopicA }),
    ).toHaveCount(0);

    const msgTopicB = 'ForumScoped_TopicB_架构评审_222';
    await sendTextMessage(authPage, msgTopicB);

    // Switch back to Topic A -> msgTopicA visible, msgTopicB hidden
    await authPage.locator(topicRowById(topicAId!)).click();
    await expect(
      authPage
        .locator(DOM.messageList)
        .locator(DOM.messageBubble)
        .filter({ hasText: msgTopicA }),
    ).toBeVisible();
    await expect(
      authPage
        .locator(DOM.messageList)
        .locator(DOM.messageBubble)
        .filter({ hasText: msgTopicB }),
    ).toHaveCount(0);

    // Switch back to Topic B -> msgTopicB still persisted
    await authPage.locator(topicRowById(topicBId!)).click();
    await expect(
      authPage
        .locator(DOM.messageList)
        .locator(DOM.messageBubble)
        .filter({ hasText: msgTopicB }),
    ).toBeVisible();
  });
});
