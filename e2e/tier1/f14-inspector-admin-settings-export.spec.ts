import type { Download, Locator, Page } from '@playwright/test';
import {
  bilingualRegex,
  closeRightInspector,
  createPdfFilePayload,
  createPngFilePayload,
  createWavFilePayload,
  DATA_ATTRS,
  DOM,
  escapeCssAttrValue,
  expect,
  openBurgerMenu,
  openContextMenuAndClick,
  openRightInspector,
  openSettings,
  RIGHT_TABS,
  scopedButton,
  scopedMenuItem,
  scopedTextbox,
  selectChat,
  sendTextMessage,
  test,
  type InMemoryFilePayload,
} from '../helpers';

async function readDownloadUtf8(download: Download): Promise<string> {
  const stream = await download.createReadStream();
  if (!stream) {
    throw new Error(
      `Expected readable download stream for "${download.suggestedFilename()}"`,
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function blurFocusedElement(page: Page): Promise<void> {
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      active.blur();
    }
  });
}

async function uploadPayloadToActiveChat(
  page: Page,
  payload: InMemoryFilePayload,
): Promise<void> {
  const attachBtn = page.locator(DOM.btnAttachMenu);
  await expect(attachBtn).toBeVisible();

  const fileInput = page.locator(DOM.fileUploadInput);
  if ((await fileInput.count()) === 0) {
    await attachBtn.click();
  }
  expect(await fileInput.count()).toBeGreaterThan(0);

  const countBefore = await page
    .locator(DOM.messageList)
    .locator(DOM.messageBubble)
    .count();

  await fileInput.first().setInputFiles(payload);
  await page.waitForTimeout(300);

  const editorModal = page.locator(DOM.modalMediaEditor);
  if (await editorModal.isVisible()) {
    await scopedButton(editorModal, 'send')
      .or(scopedButton(editorModal, 'confirm'))
      .last()
      .click();
    await expect(editorModal).toBeHidden();
  } else {
    const curCount = await page
      .locator(DOM.messageList)
      .locator(DOM.messageBubble)
      .count();
    if (curCount <= countBefore) {
      const sendBtn = page.locator(DOM.btnSendMessage);
      if ((await sendBtn.isVisible()) && (await sendBtn.isEnabled())) {
        await sendBtn.click();
      }
    }
  }

  await expect
    .poll(
      async () =>
        page.locator(DOM.messageList).locator(DOM.messageBubble).count(),
      { timeout: 10_000 },
    )
    .toBeGreaterThan(countBefore);
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

function nonSearchTextInputs(scope: Locator): Locator {
  return scope.locator(
    'input[type="text"]:not([placeholder*="search" i]):not([placeholder*="filter" i]):not([aria-label*="search" i]):not([aria-label*="filter" i]):not([placeholder*="搜索"]):not([placeholder*="查找"]):not([placeholder*="筛选"]):not([aria-label*="搜索"]):not([aria-label*="查找"])',
  );
}

async function createGroupViaModal(
  page: Page,
  groupTitle: string,
  maxMembersToPick = 2,
): Promise<void> {
  await openBurgerMenu(page);
  const newGroupItem = page.locator(DOM.menuItemNewGroup);
  await expect(newGroupItem).toBeVisible();
  await newGroupItem.click();

  const modal = page.locator(DOM.modalCreateGroup);
  await expect(modal).toBeVisible();

  const memberCandidates = modal.locator(
    'input[type="checkbox"], [role="checkbox"], [role="option"], [data-peer-id], [data-user-id], li button',
  );
  const memberCount = await memberCandidates.count();
  let picked = 0;
  for (let i = 0; i < memberCount && picked < maxMembersToPick; i++) {
    const item = memberCandidates.nth(i);
    if (await item.isVisible()) {
      await item.click();
      picked++;
    }
  }

  const explicitGroupNameInput = scopedTextbox(
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

  // Handle 2-step vs 1-step group creation modal without matching Step 1 search input
  if (
    (await explicitGroupNameInput.count()) === 0 ||
    !(await explicitGroupNameInput.first().isVisible())
  ) {
    const nextBtn = scopedButton(modal, 'next').first();
    if ((await nextBtn.count()) > 0 && (await nextBtn.isVisible())) {
      await nextBtn.click();
    }
  }

  const groupNameInput = await pickVisibleFirst(
    explicitGroupNameInput,
    nonSearchTextInputs(modal),
  );
  await expect(groupNameInput).toBeVisible();
  await groupNameInput.fill(groupTitle);

  const createBtn = scopedButton(
    modal,
    bilingualRegex('create|done|confirm|save', '创建|完成|确定|保存'),
  ).last();
  await expect(createBtn).toBeVisible();
  await createBtn.click();

  await expect(modal).toBeHidden();
  await expect(page.locator(DOM.chatHeaderTitle)).toContainText(groupTitle);
}

async function createChannelViaModal(
  page: Page,
  channelTitle: string,
  description: string,
): Promise<void> {
  await openBurgerMenu(page);
  const newChannelItem = page.locator(DOM.menuItemNewChannel);
  await expect(newChannelItem).toBeVisible();
  await newChannelItem.click();

  const modal = page.locator(DOM.modalCreateChannel);
  await expect(modal).toBeVisible();

  const titleInput = await pickVisibleFirst(
    scopedTextbox(
      modal,
      bilingualRegex('channel\\s*name|title|name', '频道名称|标题|名称'),
    ),
    nonSearchTextInputs(modal),
  );
  await expect(titleInput).toBeVisible();
  await titleInput.fill(channelTitle);

  const descInput = await pickVisibleFirst(
    scopedTextbox(
      modal,
      bilingualRegex('description|about|bio', '简介|描述|说明'),
    ),
    modal.locator('textarea'),
  );
  if ((await descInput.count()) > 0 && (await descInput.isVisible())) {
    await descInput.fill(description);
  }

  const linkInput = scopedTextbox(
    modal,
    bilingualRegex('link|username|handle|public', '链接|用户名|公开'),
  ).first();
  if (
    (await linkInput.count()) > 0 &&
    (await linkInput.isVisible()) &&
    (await linkInput.inputValue()).trim() === ''
  ) {
    await linkInput.fill(`f14_chan_${Date.now().toString().slice(-5)}`);
  }

  const stepOneSubmit = scopedButton(
    modal,
    bilingualRegex('create|next|done|confirm', '创建|下一步|完成|确定'),
  ).last();
  await expect(stepOneSubmit).toBeVisible();
  await stepOneSubmit.click();

  // Handle optional 2nd step (Add Subscribers / Skip)
  if (await modal.isVisible()) {
    const finishBtn = scopedButton(
      modal,
      bilingualRegex('skip|create|done|finish|confirm', '跳过|创建|完成|确定'),
    ).last();
    if ((await finishBtn.count()) > 0 && (await finishBtn.isVisible())) {
      await finishBtn.click();
    }
  }

  await expect(modal).toBeHidden();
  await expect(page.locator(DOM.chatHeaderTitle)).toContainText(channelTitle);
}

test.describe(
  'F14 — Right Context Inspector, Contacts/Groups/Channels Admin, Stats & 25-Page Settings + Export',
  () => {
    test('F14-01: #btn-toggle-right-column & Ctrl+I toggle #right-column showing #right-profile-info and all 6 #right-tabs including SVG/Canvas #right-tab-stats', async ({
      authPage,
    }) => {
      await createChannelViaModal(
        authPage,
        'F14 Stats Channel',
        'Analytics E2E verification channel',
      );

      // Seed real chat-scoped shared items so Media, Files, Links, Voice, and Stats all render authentic items
      await sendTextMessage(
        authPage,
        'Spec link https://example.org/f14-links',
      );
      await uploadPayloadToActiveChat(
        authPage,
        createPngFilePayload('f14-chart.png', {
          width: 160,
          height: 120,
          pattern: 'gradient',
        }),
      );
      await uploadPayloadToActiveChat(
        authPage,
        createPdfFilePayload('f14-spec.pdf', 'F14 Spec Document'),
      );
      await uploadPayloadToActiveChat(
        authPage,
        createWavFilePayload('f14-voice.wav', { durationMs: 1200 }),
      );

      // 1. Toggle #right-column via #btn-toggle-right-column and Ctrl+I
      await closeRightInspector(authPage);
      const rightCol = authPage.locator(DOM.rightColumn);
      await expect(rightCol).toBeHidden();

      await authPage.locator(DOM.btnToggleRightColumn).click();
      await expect(rightCol).toBeVisible();

      await authPage.locator(DOM.btnToggleRightColumn).click();
      await expect(rightCol).toBeHidden();

      await blurFocusedElement(authPage);
      await authPage.keyboard.press('Control+i');
      await expect(rightCol).toBeVisible();

      // 2. Verify #right-profile-info & #right-tabs scoping
      const profileInfo = authPage.locator(DOM.rightProfileInfo);
      await expect(profileInfo).toBeVisible();
      await expect(profileInfo).toContainText('F14 Stats Channel');
      await expect(authPage.locator(DOM.rightTabs)).toBeVisible();

      // 3. Exercise shared content tabs + #right-tab-stats SVG/Canvas analytics
      const mediaTab = authPage.locator(RIGHT_TABS.media);
      await expect(mediaTab).toBeVisible();
      await mediaTab.click();
      await expect(rightCol.locator('img, canvas').first()).toBeVisible();

      const filesTab = authPage.locator(RIGHT_TABS.files);
      await expect(filesTab).toBeVisible();
      await filesTab.click();
      await expect(rightCol).toContainText(/f14-spec\.pdf|pdf/i);

      const linksTab = authPage.locator(RIGHT_TABS.links);
      await expect(linksTab).toBeVisible();
      await linksTab.click();
      await expect(rightCol).toContainText(/example\.org/i);

      const voiceTab = authPage.locator(RIGHT_TABS.voice);
      await expect(voiceTab).toBeVisible();
      await voiceTab.click();
      await expect(rightCol).toBeVisible();

      const statsTab = authPage.locator(RIGHT_TABS.stats);
      await expect(statsTab).toBeVisible();
      await statsTab.click();

      // Verify genuine SVG or Canvas Channel Statistics chart (>= 80x40, not a tiny icon)
      const hasStatsChart = await rightCol.evaluate((el) => {
        const visuals = Array.from(el.querySelectorAll('svg, canvas'));
        const hasSizedChart = visuals.some((v) => {
          const r = v.getBoundingClientRect();
          return r.width >= 80 && r.height >= 40;
        });
        const hasStatsCopy =
          /statistic|growth|views|subscribers|followers|boost|overview|统计|增长|浏览|订阅|助力|概览/i.test(
            el.textContent ?? '',
          );
        return hasSizedChart && hasStatsCopy;
      });
      expect(hasStatsChart).toBe(true);

      // Verify #right-tab-members (on Channel if visible, otherwise on a Group chat)
      const membersTab = authPage.locator(RIGHT_TABS.members);
      if (!(await membersTab.isVisible())) {
        await createGroupViaModal(authPage, 'F14 Inspector Group', 1);
        await openRightInspector(authPage);
      }
      await expect(membersTab).toBeVisible();
      await membersTab.click();
      await expect(rightCol).toBeVisible();
    });

    test('F14-02: #modal-contacts, #modal-create-group, and #modal-create-channel wizards create peers and chats end-to-end', async ({
      authPage,
    }) => {
      // 1. #modal-contacts (Contacts & Add Contact)
      await openBurgerMenu(authPage);
      await authPage.locator(DOM.menuItemContacts).click();

      const contactsModal = authPage.locator(DOM.modalContacts);
      await expect(contactsModal).toBeVisible();

      const revealAddContactBtn = scopedButton(
        contactsModal,
        bilingualRegex('add\\s*contact|new\\s*contact', '添加联系人|新建联系人'),
      ).first();
      if (
        (await revealAddContactBtn.count()) > 0 &&
        (await revealAddContactBtn.isVisible())
      ) {
        await revealAddContactBtn.click();
      }

      const explicitNameInput = scopedTextbox(
        contactsModal,
        bilingualRegex('first\\s*name|name', '名字|姓名|名称'),
      ).filter({
        hasNot: contactsModal.locator(
          '[placeholder*="search" i], [aria-label*="search" i], [placeholder*="搜索"], [aria-label*="搜索"]',
        ),
      });
      const nameInput = await pickVisibleFirst(
        explicitNameInput,
        nonSearchTextInputs(contactsModal),
      );
      await expect(nameInput).toBeVisible();
      await nameInput.fill('Ada Lovelace');

      const explicitPhoneInput = scopedTextbox(
        contactsModal,
        bilingualRegex('phone|username|mobile', '手机|电话|号码|用户名'),
      );
      const fallbackPhoneInput = contactsModal
        .locator('input[type="tel"]')
        .or(nonSearchTextInputs(contactsModal))
        .last();
      const phoneOrHandleInput =
        (await explicitPhoneInput.count()) > 0 &&
        (await explicitPhoneInput.first().isVisible())
          ? explicitPhoneInput.first()
          : fallbackPhoneInput;
      if (
        (await phoneOrHandleInput.count()) > 0 &&
        (await phoneOrHandleInput.isVisible()) &&
        (await phoneOrHandleInput.inputValue()) !== 'Ada Lovelace'
      ) {
        await phoneOrHandleInput.fill('+14155552671');
      }

      const saveContactBtn = scopedButton(
        contactsModal,
        bilingualRegex('add|save|create|confirm|done', '添加|保存|创建|确定|完成'),
      ).last();
      await expect(saveContactBtn).toBeVisible();
      await saveContactBtn.click();

      await expect
        .poll(
          async () => {
            if (await contactsModal.isVisible()) {
              return (await contactsModal.innerText()).includes('Ada Lovelace');
            }
            return (await authPage.locator(DOM.chatHeaderTitle).innerText()).includes(
              'Ada Lovelace',
            );
          },
          { timeout: 6_000 },
        )
        .toBe(true);

      if (await contactsModal.isVisible()) {
        await authPage.keyboard.press('Escape');
        await expect(contactsModal).toBeHidden();
      }

      // 2. #modal-create-group
      await createGroupViaModal(authPage, 'F14 Engineering Group', 2);
      await expect(authPage.locator(DOM.chatList)).toContainText(
        'F14 Engineering Group',
      );
      await expect(authPage.locator(DOM.chatHeaderTitle)).toContainText(
        'F14 Engineering Group',
      );

      // 3. #modal-create-channel
      await createChannelViaModal(
        authPage,
        'F14 Release Channel',
        'Automated release announcements',
      );
      await expect(authPage.locator(DOM.chatList)).toContainText(
        'F14 Release Channel',
      );
      await expect(authPage.locator(DOM.chatHeaderTitle)).toContainText(
        'F14 Release Channel',
      );
    });

    test('F14-03: group admin promotes & removes members and manages invite links in #right-column', async ({
      authPage,
    }) => {
      await createGroupViaModal(authPage, 'F14 Admin Ops Group', 2);

      const rightCol = await openRightInspector(authPage);
      const membersTab = authPage.locator(RIGHT_TABS.members);
      await expect(membersTab).toBeVisible();
      await membersTab.click();

      // Ensure at least 2 peer members exist if creation picker had fewer than 2
      const addMemberBtn = scopedButton(
        rightCol,
        bilingualRegex('add\\s*member|invite\\s*member', '添加成员|邀请成员'),
      ).first();
      const memberRowsLocator = rightCol
        .locator('[data-member-id], [data-peer-id], [data-user-id], [role="listitem"], li')
        .filter({
          hasNotText: /^\s*(?:owner|creator|you|群主|创建者)\s*$/i,
        });

      if (
        (await memberRowsLocator.count()) < 2 &&
        (await addMemberBtn.count()) > 0 &&
        (await addMemberBtn.isVisible())
      ) {
        await addMemberBtn.click();
        const addDialog = authPage
          .locator('[role="dialog"]')
          .filter({ hasNot: authPage.locator(DOM.chatList) })
          .first();
        if (await addDialog.isVisible()) {
          const pickOpt = addDialog
            .locator('input[type="checkbox"], [role="checkbox"], [role="option"], li button')
            .first();
          if ((await pickOpt.count()) > 0 && (await pickOpt.isVisible())) {
            await pickOpt.click();
            await scopedButton(addDialog, 'confirm').last().click();
          } else {
            await authPage.keyboard.press('Escape');
          }
        }
      }

      // 1. Promote peer member to Admin (fail-closed pre/post role delta excluding Promote button labels)
      const promotePattern = bilingualRegex(
        'promote|make\\s*admin|grant\\s*admin',
        '设为管理员|提升.*管理员',
      );

      const countAdminBadgedRows = async (): Promise<number> => {
        return rightCol.evaluate((el) => {
          const rows = Array.from(
            el.querySelectorAll(
              '[data-member-id], [data-peer-id], [data-user-id], [role="listitem"], li',
            ),
          );
          const promoteVerbRe =
            /promote|make\s*admin|grant\s*admin|设为管理员|提升/i;
          const adminRoleRe = /\badmin\b|administrator|管理员/i;

          return rows.filter((row) => {
            if (!(row instanceof HTMLElement)) return false;
            if (row.dataset.role === 'admin' || row.dataset.isAdmin === 'true') {
              return true;
            }
            const clone = row.cloneNode(true) as HTMLElement;
            for (const btn of Array.from(
              clone.querySelectorAll('button, [role="button"]'),
            )) {
              if (promoteVerbRe.test(btn.textContent ?? '')) {
                btn.remove();
              }
            }
            return adminRoleRe.test(clone.textContent ?? '');
          }).length;
        });
      };

      const readPeerNonButtonRoleText = async (row: Locator): Promise<string> => {
        return row.evaluate((el) => {
          const clone = el.cloneNode(true) as HTMLElement;
          for (const btn of Array.from(
            clone.querySelectorAll('button, [role="button"]'),
          )) {
            if (
              /promote|make\s*admin|grant\s*admin|设为管理员|提升/i.test(
                btn.textContent ?? '',
              )
            ) {
              btn.remove();
            }
          }
          return `${el.getAttribute('data-role') ?? ''}|${(clone.textContent ?? '').trim()}`;
        });
      };

      const peerRow = rightCol
        .locator('[data-member-id], [data-peer-id], [data-user-id], [role="listitem"], li')
        .filter({ hasNotText: /\bowner\b|\bcreator\b|群主|创建者/i })
        .first();
      await expect(peerRow).toBeVisible();

      const adminRowsBefore = await countAdminBadgedRows();
      const peerRoleBefore = await readPeerNonButtonRoleText(peerRow);

      const inlinePromoteInRow = scopedButton(peerRow, promotePattern).first();
      const inlinePromoteInCol = scopedButton(rightCol, promotePattern).first();

      if (
        (await inlinePromoteInRow.count()) > 0 &&
        (await inlinePromoteInRow.isVisible())
      ) {
        await inlinePromoteInRow.click();
      } else if (
        (await inlinePromoteInCol.count()) > 0 &&
        (await inlinePromoteInCol.isVisible())
      ) {
        await inlinePromoteInCol.click();
      } else {
        const moreBtn = peerRow
          .locator(
            'button[aria-label*="more" i], button[aria-label*="更多" i], button',
          )
          .last();
        if ((await moreBtn.count()) > 0 && (await moreBtn.isVisible())) {
          await moreBtn.click();
          const menu = authPage
            .locator('[role="menu"], [data-testid="context-menu"]')
            .first();
          if (await menu.isVisible()) {
            await scopedMenuItem(menu, promotePattern).first().click();
          } else {
            await openContextMenuAndClick(authPage, peerRow, promotePattern);
          }
        } else {
          await openContextMenuAndClick(authPage, peerRow, promotePattern);
        }
      }

      const rightsDialog = authPage
        .locator('[role="dialog"]')
        .filter({ hasNot: authPage.locator(DOM.chatList) })
        .first();
      if (await rightsDialog.isVisible()) {
        await scopedButton(rightsDialog, 'confirm').last().click();
      }

      await expect
        .poll(
          async () => {
            const adminRowsAfter = await countAdminBadgedRows();
            if (adminRowsAfter > adminRowsBefore) return true;
            if ((await peerRow.count()) > 0 && (await peerRow.isVisible())) {
              const peerRoleAfter = await readPeerNonButtonRoleText(peerRow);
              return (
                peerRoleAfter !== peerRoleBefore &&
                /\badmin\b|administrator|管理员/i.test(peerRoleAfter)
              );
            }
            return false;
          },
          {
            message:
              'Expected promoting group peer member to increase admin badge count or update peer role to Admin',
            timeout: 6_000,
          },
        )
        .toBe(true);

      // 2. Remove / Ban peer member
      const textBeforeRemove = await rightCol.innerText();
      const removePattern = bilingualRegex(
        'remove|kick|ban',
        '移除|踢出|封禁',
      );
      const inlineRemoveBtn = scopedButton(rightCol, removePattern).first();

      if (
        (await inlineRemoveBtn.count()) > 0 &&
        (await inlineRemoveBtn.isVisible())
      ) {
        await inlineRemoveBtn.click();
      } else {
        const targetRow = rightCol
          .locator('[data-member-id], [data-peer-id], [data-user-id], [role="listitem"], li')
          .filter({ hasNotText: /\bowner\b|群主/i })
          .last();
        await expect(targetRow).toBeVisible();
        await openContextMenuAndClick(authPage, targetRow, removePattern);
      }

      const confirmRemoveDialog = authPage
        .locator('[role="alertdialog"], [role="dialog"]')
        .filter({ hasNot: authPage.locator(DOM.chatList) })
        .first();
      if (await confirmRemoveDialog.isVisible()) {
        await scopedButton(
          confirmRemoveDialog,
          bilingualRegex('remove|ban|delete|confirm|ok', '移除|封禁|删除|确认|确定'),
        )
          .last()
          .click();
      }

      await expect
        .poll(async () => (await rightCol.innerText()) !== textBeforeRemove, {
          timeout: 6_000,
        })
        .toBe(true);

      // 3. Invite Links management inside #right-column
      const inviteLinkRegex =
        /(?:https?:\/\/[^\s]+|t\.me\/\+?[A-Za-z0-9_-]+|\/(?:invite|join)\/[A-Za-z0-9_-]+)/i;
      if (!inviteLinkRegex.test(await rightCol.innerText())) {
        const openInviteBtn = scopedButton(
          rightCol,
          bilingualRegex(
            'invite\\s*link|create.*link|generate.*link',
            '邀请链接|创建.*链接|生成.*链接',
          ),
        ).first();
        if (
          (await openInviteBtn.count()) > 0 &&
          (await openInviteBtn.isVisible())
        ) {
          await openInviteBtn.click();
        }
      }

      await expect(rightCol).toContainText(inviteLinkRegex);

      const linkActionBtn = scopedButton(
        rightCol,
        bilingualRegex(
          'copy.*link|new.*link|create.*link|revoke|regenerate|copy',
          '复制.*链接|新链接|创建.*链接|撤销|重置|复制',
        ),
      ).first();
      await expect(linkActionBtn).toBeVisible();
      await linkActionBtn.click();
    });

    test('F14-04: #settings-panel navigates the 25-page left slide-stack ([data-settings-section]) with multi-level Back stack', async ({
      authPage,
    }) => {
      // Ensure #settings-panel starts closed and genuinely opens on openSettings()
      await expect(authPage.locator(DOM.settingsPanel)).toBeHidden();

      const settingsPanel = await openSettings(authPage);
      await expect(settingsPanel).toBeVisible();

      const visitedSections = new Set<string>(['main']);
      let pushedSubPagesCount = 0;
      let verifiedBackNavCount = 0;

      const snapshotPanelSignature = async () => {
        return settingsPanel.evaluate((panelEl, attrName) => {
          const pr = panelEl.getBoundingClientRect();
          const isUncovered = (node: HTMLElement): boolean => {
            let cur: HTMLElement | null = node;
            while (cur && cur !== panelEl) {
              const st = window.getComputedStyle(cur);
              if (
                st.display === 'none' ||
                st.visibility === 'hidden' ||
                parseFloat(st.opacity || '1') <= 0.05
              ) {
                return false;
              }
              cur = cur.parentElement;
            }
            const r = node.getBoundingClientRect();
            const ix1 = Math.max(r.left, pr.left + 6);
            const ix2 = Math.min(r.right, pr.right - 6);
            const iy1 = Math.max(r.top, pr.top + 4);
            const iy2 = Math.min(r.bottom, pr.bottom - 4);
            if (ix2 <= ix1 || iy2 <= iy1) return false;

            const hit = document.elementFromPoint(
              (ix1 + ix2) / 2,
              (iy1 + iy2) / 2,
            );
            return (
              hit === null || node.contains(hit) || hit.contains(node)
            );
          };

          const headings = Array.from(
            panelEl.querySelectorAll('h1, h2, h3, [role="heading"], header'),
          ).filter(
            (h): h is HTMLElement =>
              h instanceof HTMLElement && isUncovered(h),
          );
          const topHeading =
            headings.length > 0
              ? (headings[headings.length - 1].textContent ?? '').trim()
              : '';

          const backCandidates = Array.from(
            panelEl.querySelectorAll(
              'button, [role="button"]',
            ),
          ).filter((b): b is HTMLElement => {
            if (!(b instanceof HTMLElement) || !isUncovered(b)) return false;
            const meta = `${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''} ${b.getAttribute('data-testid') ?? ''} ${b.textContent ?? ''}`;
            return /\bback\b|返回|←|‹/i.test(meta);
          });

          const walker = document.createTreeWalker(
            panelEl,
            NodeFilter.SHOW_TEXT,
          );
          const visibleTexts: string[] = [];
          let tNode = walker.nextNode();
          while (tNode) {
            const val = (tNode.textContent ?? '').trim();
            const parent = tNode.parentElement;
            if (val.length > 0 && parent && isUncovered(parent)) {
              visibleTexts.push(val);
            }
            tNode = walker.nextNode();
          }

          const activeAttrSig = Array.from(
            panelEl.querySelectorAll(`[${attrName}]`),
          )
            .map(
              (n) =>
                `${n.getAttribute(attrName)}:${n.getAttribute('aria-selected') ?? ''}:${n.getAttribute('aria-current') ?? ''}:${n.getAttribute('data-active') ?? ''}`,
            )
            .join('|');

          return {
            visibleText: visibleTexts.join(' '),
            topHeading,
            visibleBackCount: backCandidates.length,
            activeAttrSig,
          };
        }, DATA_ATTRS.settingsSection);
      };

      const collectLeafSectionSlugs = async (): Promise<string[]> => {
        return settingsPanel.evaluate(async (panelEl, attrName) => {
          const pr = panelEl.getBoundingClientRect();
          const isUncovered = (node: HTMLElement): boolean => {
            let cur: HTMLElement | null = node;
            while (cur && cur !== panelEl) {
              const st = window.getComputedStyle(cur);
              if (
                st.display === 'none' ||
                st.visibility === 'hidden' ||
                parseFloat(st.opacity || '1') <= 0.05
              ) {
                return false;
              }
              cur = cur.parentElement;
            }
            const r = node.getBoundingClientRect();
            const ix1 = Math.max(r.left, pr.left + 6);
            const ix2 = Math.min(r.right, pr.right - 6);
            const iy1 = Math.max(r.top, pr.top + 4);
            const iy2 = Math.min(r.bottom, pr.bottom - 4);
            if (ix2 <= ix1 || iy2 <= iy1) return false;
            const hit = document.elementFromPoint(
              (ix1 + ix2) / 2,
              (iy1 + iy2) / 2,
            );
            return hit === null || node.contains(hit) || hit.contains(node);
          };

          const slugs: string[] = [];
          const recordVisibleLeaves = (): void => {
            const nodes = Array.from(panelEl.querySelectorAll(`[${attrName}]`));
            for (const node of nodes) {
              if (!(node instanceof HTMLElement)) continue;
              if (node.id === 'settings-panel') continue;
              if (node.querySelector(`[${attrName}]`) !== null) continue;
              if (!isUncovered(node)) continue;
              const rawSlug = (node.getAttribute(attrName) ?? '').trim();
              if (rawSlug.length > 0 && !slugs.includes(rawSlug)) {
                slugs.push(rawSlug);
              }
            }
          };

          const activeScrollables = [
            panelEl,
            ...Array.from(panelEl.querySelectorAll('*')).filter(
              (n): n is HTMLElement =>
                n instanceof HTMLElement &&
                n.scrollHeight > n.clientHeight + 8 &&
                isUncovered(n),
            ),
          ];

          recordVisibleLeaves();
          for (const sc of activeScrollables) {
            const maxScroll = sc.scrollHeight - sc.clientHeight;
            const stepSize = Math.max(100, Math.floor(sc.clientHeight * 0.7));
            for (let pos = stepSize; pos <= maxScroll + stepSize; pos += stepSize) {
              sc.scrollTop = Math.min(maxScroll, pos);
              sc.dispatchEvent(new Event('scroll', { bubbles: true }));
              await new Promise<void>((r) => requestAnimationFrame(() => r()));
              recordVisibleLeaves();
              if (sc.scrollTop >= maxScroll) break;
            }
            sc.scrollTop = 0;
            sc.dispatchEvent(new Event('scroll', { bubbles: true }));
          }
          await new Promise<void>((r) => requestAnimationFrame(() => r()));
          recordVisibleLeaves();
          return slugs;
        }, DATA_ATTRS.settingsSection);
      };

      const resolveUncoveredTrigger = async (
        slug: string,
      ): Promise<Locator | null> => {
        const triggerSelector = `[${DATA_ATTRS.settingsSection}="${escapeCssAttrValue(slug)}"]`;
        const idx = await settingsPanel.evaluate(async (panelEl, sel) => {
          const pr = panelEl.getBoundingClientRect();
          const isUncovered = (node: HTMLElement): boolean => {
            let cur: HTMLElement | null = node;
            while (cur && cur !== panelEl) {
              const st = window.getComputedStyle(cur);
              if (
                st.display === 'none' ||
                st.visibility === 'hidden' ||
                parseFloat(st.opacity || '1') <= 0.05
              ) {
                return false;
              }
              cur = cur.parentElement;
            }
            const r = node.getBoundingClientRect();
            const ix1 = Math.max(r.left, pr.left + 6);
            const ix2 = Math.min(r.right, pr.right - 6);
            const iy1 = Math.max(r.top, pr.top + 4);
            const iy2 = Math.min(r.bottom, pr.bottom - 4);
            if (ix2 <= ix1 || iy2 <= iy1) return false;
            const hit = document.elementFromPoint(
              (ix1 + ix2) / 2,
              (iy1 + iy2) / 2,
            );
            return hit === null || node.contains(hit) || hit.contains(node);
          };

          const allMatches = Array.from(panelEl.querySelectorAll(sel));
          for (let i = allMatches.length - 1; i >= 0; i--) {
            const candidate = allMatches[i];
            if (!(candidate instanceof HTMLElement)) continue;
            if (candidate.querySelector('[data-settings-section]') !== null) {
              continue;
            }
            const r = candidate.getBoundingClientRect();
            if (r.right <= pr.left + 6 || r.left >= pr.right - 6) {
              continue;
            }
            candidate.scrollIntoView({ block: 'nearest' });
            await new Promise<void>((res) => requestAnimationFrame(() => res()));
            if (isUncovered(candidate)) {
              return i;
            }
          }
          return -1;
        }, triggerSelector);

        if (idx < 0) return null;
        return settingsPanel.locator(triggerSelector).nth(idx);
      };

      const findTopmostBackBtn = async (): Promise<Locator | null> => {
        const candidates = scopedButton(settingsPanel, 'back').or(
          settingsPanel.locator(
            'button[aria-label*="back" i], button[aria-label*="返回" i], [data-testid*="back" i]',
          ),
        );
        const total = await candidates.count();
        for (let i = total - 1; i >= 0; i--) {
          const cand = candidates.nth(i);
          if (!(await cand.isVisible())) continue;
          const inActiveViewport = await cand.evaluate((btn) => {
            const panel = btn.closest('#settings-panel');
            if (!(panel instanceof HTMLElement)) return false;
            const pr = panel.getBoundingClientRect();
            const r = btn.getBoundingClientRect();
            const ix1 = Math.max(r.left, pr.left + 4);
            const ix2 = Math.min(r.right, pr.right - 4);
            const iy1 = Math.max(r.top, pr.top + 4);
            const iy2 = Math.min(r.bottom, pr.bottom - 4);
            if (ix2 <= ix1 || iy2 <= iy1) return false;
            const hit = document.elementFromPoint(
              (ix1 + ix2) / 2,
              (iy1 + iy2) / 2,
            );
            return hit === null || btn.contains(hit) || hit.contains(btn);
          });
          if (inActiveViewport) {
            return cand;
          }
        }
        return null;
      };

      const traverseSettingsStack = async (depth: number): Promise<void> => {
        if (depth > 3) return;
        const slugsHere = await collectLeafSectionSlugs();

        for (const slug of slugsHere) {
          const normalized = slug.toLowerCase();
          if (visitedSections.has(normalized)) continue;

          const trigger = await resolveUncoveredTrigger(slug);
          if (!trigger || !(await trigger.isVisible())) continue;

          const sigBefore = await snapshotPanelSignature();
          const triggerHandle = await trigger.elementHandle();

          await trigger.click();
          await expect(settingsPanel).toBeVisible();

          // Wait up to 360ms for React state / CSS slide-stack transition to commit
          for (let attempt = 0; attempt < 6; attempt++) {
            await authPage.waitForTimeout(60);
            const curSig = await snapshotPanelSignature();
            const movedNow = triggerHandle
              ? await settingsPanel.evaluate((panelEl, btn) => {
                  if (!(btn instanceof HTMLElement) || !btn.isConnected) {
                    return true;
                  }
                  const pr = panelEl.getBoundingClientRect();
                  const r = btn.getBoundingClientRect();
                  if (
                    r.width <= 0 ||
                    r.height <= 0 ||
                    r.right <= pr.left + 8 ||
                    r.left >= pr.right - 8
                  ) {
                    return true;
                  }
                  const cx = (Math.max(r.left, pr.left + 4) + Math.min(r.right, pr.right - 4)) / 2;
                  const cy = (Math.max(r.top, pr.top + 4) + Math.min(r.bottom, pr.bottom - 4)) / 2;
                  const hit = document.elementFromPoint(cx, cy);
                  return (
                    hit !== null && !btn.contains(hit) && !hit.contains(btn)
                  );
                }, triggerHandle)
              : false;
            if (
              movedNow ||
              curSig.visibleText !== sigBefore.visibleText ||
              curSig.topHeading !== sigBefore.topHeading ||
              curSig.visibleBackCount !== sigBefore.visibleBackCount ||
              curSig.activeAttrSig !== sigBefore.activeAttrSig
            ) {
              break;
            }
          }

          await settingsPanel.evaluate(
            () =>
              new Promise<void>((r) =>
                requestAnimationFrame(() => requestAnimationFrame(() => r())),
              ),
          );

          const sigAfter = await snapshotPanelSignature();
          const triggerMovedOrCovered = triggerHandle
            ? await settingsPanel.evaluate((panelEl, btn) => {
                if (!(btn instanceof HTMLElement) || !btn.isConnected) {
                  return true;
                }
                const st = window.getComputedStyle(btn);
                if (st.display === 'none' || st.visibility === 'hidden') {
                  return true;
                }
                const pr = panelEl.getBoundingClientRect();
                const r = btn.getBoundingClientRect();
                if (
                  r.width <= 0 ||
                  r.height <= 0 ||
                  r.right <= pr.left + 8 ||
                  r.left >= pr.right - 8
                ) {
                  return true;
                }
                const cx = (Math.max(r.left, pr.left + 4) + Math.min(r.right, pr.right - 4)) / 2;
                const cy = (Math.max(r.top, pr.top + 4) + Math.min(r.bottom, pr.bottom - 4)) / 2;
                const hit = document.elementFromPoint(cx, cy);
                return (
                  hit !== null && !btn.contains(hit) && !hit.contains(btn)
                );
              }, triggerHandle)
            : false;

          if (triggerHandle) {
            await triggerHandle.dispose();
          }

          const didMutate =
            triggerMovedOrCovered ||
            sigAfter.visibleText !== sigBefore.visibleText ||
            sigAfter.topHeading !== sigBefore.topHeading ||
            sigAfter.visibleBackCount !== sigBefore.visibleBackCount ||
            sigAfter.activeAttrSig !== sigBefore.activeAttrSig;

          // Fail-closed: dead static buttons that do not mutate panel view are NEVER counted
          if (didMutate && sigAfter.visibleText.length > 0) {
            visitedSections.add(normalized);
          }

          const didPushSubPage =
            triggerMovedOrCovered ||
            sigAfter.visibleBackCount > sigBefore.visibleBackCount ||
            (sigBefore.topHeading !== '' &&
              sigAfter.topHeading !== '' &&
              sigAfter.topHeading !== sigBefore.topHeading);

          // Explore nested child [data-settings-section] triggers on this sub-page, then pop via topmost Back button
          if (didPushSubPage) {
            pushedSubPagesCount++;
            await traverseSettingsStack(depth + 1);

            const sigOnSubPage = await snapshotPanelSignature();
            const backBtn = await findTopmostBackBtn();
            if (backBtn) {
              await backBtn.click();
              await authPage.waitForTimeout(120);
              if (!(await settingsPanel.isVisible())) {
                await openSettings(authPage);
              }
              await expect(settingsPanel).toBeVisible();
              const sigAfterBack = await snapshotPanelSignature();
              if (
                sigAfterBack.visibleText !== sigOnSubPage.visibleText ||
                sigAfterBack.topHeading !== sigOnSubPage.topHeading ||
                sigAfterBack.visibleBackCount < sigOnSubPage.visibleBackCount
              ) {
                verifiedBackNavCount++;
              }
            }
          }
        }
      };

      await traverseSettingsStack(0);

      expect(visitedSections.size).toBeGreaterThanOrEqual(25);
      expect(pushedSubPagesCount).toBeGreaterThanOrEqual(1);
      expect(verifiedBackNavCount).toBeGreaterThanOrEqual(1);

      // Dismiss #settings-panel from Main root
      await authPage.keyboard.press('Escape');
      if (await settingsPanel.isVisible()) {
        const cancelBtn = scopedButton(settingsPanel, 'cancel').first();
        if ((await cancelBtn.count()) > 0 && (await cancelBtn.isVisible())) {
          await cancelBtn.click();
        } else {
          const rootBackBtn = await findTopmostBackBtn();
          if (rootBackBtn) {
            await rootBackBtn.click();
          }
        }
      }
      await expect(settingsPanel).toBeHidden();
      await expect(authPage.locator(DOM.appShell)).toBeVisible();
    });

    test('F14-05: #btn-export-chat-json & #btn-export-chat-html trigger real browser downloads containing valid JSON and styled HTML chat transcripts', async ({
      authPage,
    }) => {
      // Select a writable chat and send deterministic export marker
      const rows = authPage.locator(DOM.chatList).locator(DOM.chatRow);
      const rowCount = await rows.count();
      expect(rowCount).toBeGreaterThan(0);

      for (let i = 0; i < Math.min(rowCount, 10); i++) {
        await selectChat(authPage, i);
        const composer = authPage.locator(DOM.messageComposerInput);
        if ((await composer.isVisible()) && (await composer.isEditable())) {
          break;
        }
      }

      const marker = 'F14_EXPORT_VERIFICATION_MARKER_8842 — 聊天导出校验';
      await sendTextMessage(authPage, marker);

      // Reveal #btn-export-chat-json & #btn-export-chat-html inside #settings-panel (or #btn-chat-more)
      const settingsPanel = await openSettings(authPage);
      const jsonBtn = authPage.locator(DOM.btnExportChatJson);
      const htmlBtn = authPage.locator(DOM.btnExportChatHtml);

      if (!(await jsonBtn.isVisible())) {
        const storageTrigger = settingsPanel
          .locator(DOM.settingsSectionItem)
          .filter({
            hasText: /storage|data|export|local|advanced|存储|数据|导出|高级/i,
          })
          .first();

        if (
          (await storageTrigger.count()) > 0 &&
          (await storageTrigger.isVisible())
        ) {
          await storageTrigger.click();
        } else {
          const allTriggers = settingsPanel.locator('[data-settings-section]');
          const tCount = await allTriggers.count();
          for (let i = 0; i < tCount; i++) {
            const trig = allTriggers.nth(i);
            const slug = (
              (await trig.getAttribute(DATA_ATTRS.settingsSection)) ?? ''
            ).toLowerCase();
            if (/storage|data|export|chat|advanced/.test(slug) && (await trig.isVisible())) {
              await trig.click();
              if (await jsonBtn.isVisible()) break;
            }
          }
        }
      }

      if (!(await jsonBtn.isVisible())) {
        await authPage.keyboard.press('Escape');
        await authPage.locator(DOM.btnChatMore).click();
        const menu = authPage
          .locator('[role="menu"], [data-testid="context-menu"]')
          .first();
        if (await menu.isVisible()) {
          const exportItem = scopedMenuItem(
            menu,
            bilingualRegex('export', '导出'),
          ).first();
          if (
            (await exportItem.count()) > 0 &&
            (await exportItem.isVisible())
          ) {
            await exportItem.click();
          }
        }
      }

      await expect(jsonBtn).toBeVisible();
      await expect(htmlBtn).toBeVisible();

      // 1. JSON Export
      const [jsonDownload] = await Promise.all([
        authPage.waitForEvent('download', { timeout: 10_000 }),
        jsonBtn.click(),
      ]);
      expect(jsonDownload.suggestedFilename()).toMatch(/\.json$/i);
      const jsonRaw = await readDownloadUtf8(jsonDownload);
      const parsedJson: unknown = JSON.parse(jsonRaw);
      expect(typeof parsedJson === 'object' && parsedJson !== null).toBe(true);
      expect(jsonRaw).toContain('F14_EXPORT_VERIFICATION_MARKER_8842');

      // 2. Styled HTML Export
      const [htmlDownload] = await Promise.all([
        authPage.waitForEvent('download', { timeout: 10_000 }),
        htmlBtn.click(),
      ]);
      expect(htmlDownload.suggestedFilename()).toMatch(/\.html?$/i);
      const htmlRaw = await readDownloadUtf8(htmlDownload);
      expect(htmlRaw).toMatch(/<!doctype html|<html/i);
      expect(htmlRaw).toMatch(/<style[\s>]/i);
      expect(htmlRaw).toMatch(/<\/html>/i);
      expect(htmlRaw).toContain('F14_EXPORT_VERIFICATION_MARKER_8842');
    });

    test('F14-06: #modal-shortcuts keyboard legend opens via ? & UI trigger, lists canonical shortcuts, and pops single layer on Escape', async ({
      authPage,
    }) => {
      await selectChat(authPage, 0);
      const activeTitle = (
        await authPage.locator(DOM.chatHeaderTitle).innerText()
      ).trim();
      expect(activeTitle.length).toBeGreaterThan(0);

      // 1. Open via '?' global keyboard shortcut
      await blurFocusedElement(authPage);
      await authPage.keyboard.press('?');
      await authPage.waitForTimeout(200);

      const shortcutsModal = authPage.locator(DOM.modalShortcuts);
      if (!(await shortcutsModal.isVisible())) {
        await authPage.keyboard.press('Shift+Slash');
      }
      await expect(shortcutsModal).toBeVisible();

      // 2. Verify canonical shortcut legend content
      const legendText = await shortcutsModal.innerText();
      expect(legendText).toMatch(/(?:ctrl|cmd|⌘)\s*\+?\s*k|\bsearch\b|搜索/i);
      expect(legendText).toMatch(/(?:ctrl|cmd|⌘)\s*\+?\s*[bdil]/i);
      expect(legendText).toMatch(/\besc\b|escape/i);

      const kbdOrRowCount = await shortcutsModal.evaluate((el) => {
        const kbds = el.querySelectorAll('kbd').length;
        const rows = el.querySelectorAll('li, tr, [role="listitem"], [data-shortcut]').length;
        return Math.max(kbds, rows);
      });
      expect(kbdOrRowCount).toBeGreaterThanOrEqual(5);

      // 3. Single-layer Escape pop preserves active chat stage underneath
      await authPage.keyboard.press('Escape');
      await expect(shortcutsModal).toBeHidden();
      await expect(authPage.locator(DOM.middleColumn)).toBeVisible();
      await expect(authPage.locator(DOM.chatHeaderTitle)).toContainText(
        activeTitle,
      );

      // 4. Re-open via UI trigger (#main-menu-drawer or #settings-panel)
      const drawer = await openBurgerMenu(authPage);
      const drawerShortcutItem = scopedMenuItem(
        drawer,
        bilingualRegex('shortcut|keyboard', '快捷键|键盘'),
      ).first();

      if (
        (await drawerShortcutItem.count()) > 0 &&
        (await drawerShortcutItem.isVisible())
      ) {
        await drawerShortcutItem.click();
        await expect(shortcutsModal).toBeVisible();
        await authPage.keyboard.press('Escape');
        await expect(shortcutsModal).toBeHidden();
      } else {
        const settings = await openSettings(authPage);
        const settingsShortcutItem = settings
          .locator('[data-settings-section], button, [role="menuitem"]')
          .filter({ hasText: /shortcut|keyboard|快捷键|键盘/i })
          .first();
        await expect(settingsShortcutItem).toBeVisible();
        await settingsShortcutItem.click();
        if (await shortcutsModal.isVisible()) {
          await authPage.keyboard.press('Escape');
          await expect(shortcutsModal).toBeHidden();
        } else {
          await expect(settings).toContainText(/(?:ctrl|cmd|⌘)\s*\+?\s*k/i);
          await authPage.keyboard.press('Escape');
        }
      }
    });
  },
);
