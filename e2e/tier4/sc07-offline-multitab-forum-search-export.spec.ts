import { test, expect } from '../helpers/fixtures';
import { DOM } from '../helpers/selectors';
import { createRealConversationFixture } from '../helpers/server';
import {
  bilingualRegex,
  BILINGUAL_PATTERNS,
  openRightInspector,
  scopedButton,
  selectChat,
  sendTextMessage,
} from '../helpers/ui';
import { createPngFilePayload } from '../helpers/media';

test.describe('Tier 4 — SC-07: Offline Commuter Sync, Multi-Tab BroadcastChannel, Forum Supergroup & Transcript Export', () => {
  test('SC-07: Open 2 synced tabs -> Forum Supergroup topic -> annotated Mosaic album + fenced code + Poll -> offline queue 3 messages across 2 chats -> reconnect idempotent flush -> Tab 2 live sync -> CJK Search -> JSON/HTML export', async ({
    authSession,
    openSecondTab,
    context,
    request,
  }) => {
    const { page: tab1, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token, {
      includeGroup: true,
      isForumGroup: true,
      groupTitle: 'SC07 Release War Room',
    });
    expect(conv.groupTitle).toBeTruthy();
    const groupTitle = conv.groupTitle!;
    await tab1.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(tab1, groupTitle);

    // 1. Open Tab 2 sharing BroadcastChannel context & create/select a Forum Topic
    const tab2 = await openSecondTab();
    await expect(tab2.locator(DOM.appShell)).toBeVisible();
    await selectChat(tab2, groupTitle);

    const topicList1 = tab1.locator(DOM.forumTopicList);
    await expect(topicList1).toBeVisible();
    const newTopicBtn = scopedButton(
      topicList1.or(tab1.locator(DOM.leftColumn)).first(),
      bilingualRegex('new\\s*topic|create\\s*topic|\\+', '新建话题|创建话题'),
    ).first();
    await expect(newTopicBtn).toBeVisible();
    await newTopicBtn.click();

    const topicDialog = tab1.locator('[role="dialog"]').first();
    await expect(topicDialog).toBeVisible();
    await topicDialog.locator('input').first().fill('SC07 Release Topic');
    await scopedButton(topicDialog, BILINGUAL_PATTERNS.confirm).first().click();
    await expect(topicDialog).toBeHidden();

    await topicList1.getByText('SC07 Release Topic').first().click();
    const topicList2 = tab2.locator(DOM.forumTopicList);
    await expect(topicList2.getByText('SC07 Release Topic').first()).toBeVisible({ timeout: 8_000 });
    await topicList2.getByText('SC07 Release Topic').first().click();

    // 2. Upload Mosaic album + fenced code snippet + Poll in Forum Topic
    await tab1.locator(DOM.fileUploadInput).setInputFiles([
      createPngFilePayload('sc07-arch-1.png', { r: 10, g: 132, b: 255 }),
      createPngFilePayload('sc07-arch-2.png', { r: 0, g: 186, b: 105 }),
    ]);
    const editor = tab1.locator(DOM.modalMediaEditor);
    await expect(editor).toBeVisible();
    await scopedButton(editor, BILINGUAL_PATTERNS.send)
      .or(scopedButton(editor, BILINGUAL_PATTERNS.confirm))
      .first()
      .click();
    await expect(editor).toBeHidden();
    expect(await tab1.locator(`${DOM.messageList} ${DOM.messageBubble} img`).count()).toBeGreaterThanOrEqual(2);

    const codeMarker = `SC07_发布检查_Code_${Date.now()}`;
    await sendTextMessage(tab1, `\`\`\`ts\nconst tag = "${codeMarker}";\n\`\`\``);
    await expect(tab2.locator(DOM.messageList)).toContainText(codeMarker, {
      timeout: 8_000,
    });

    // Create a real Poll inside the Forum Topic
    await tab1.locator(DOM.btnAttachMenu).click();
    const pollTrigger = tab1
      .getByRole('menuitem', { name: BILINGUAL_PATTERNS.poll })
      .or(tab1.getByRole('button', { name: BILINGUAL_PATTERNS.poll }))
      .first();
    await expect(pollTrigger).toBeVisible();
    await pollTrigger.click();
    const pollModal = tab1.locator(DOM.modalCreatePoll);
    await expect(pollModal).toBeVisible();
    const pollInputs = pollModal.locator('input[type="text"], textarea');
    await pollInputs.nth(0).fill('Ship v1.6.11?');
    await pollInputs.nth(1).fill('Yes');
    await pollInputs.nth(2).fill('Verify More');
    await scopedButton(pollModal, BILINGUAL_PATTERNS.confirm)
      .or(scopedButton(pollModal, BILINGUAL_PATTERNS.create))
      .first()
      .click();
    await expect(pollModal).toBeHidden();
    await expect(tab1.locator(DOM.messageList)).toContainText('Ship v1.6.11?');

    // 3. Go offline and queue 3 messages across 2 chats
    await context.setOffline(true);
    await expect(tab1.locator(DOM.connectionStatusBanner)).toBeVisible({ timeout: 8_000 });

    const offlineGroupMsg1 = `SC07_Offline_Group_1_${Date.now()}`;
    const offlineGroupMsg2 = `SC07_Offline_Group_2_${Date.now()}`;
    const composer = tab1.locator(DOM.messageComposerInput);
    await composer.fill(offlineGroupMsg1);
    await composer.press('Enter');
    await composer.fill(offlineGroupMsg2);
    await composer.press('Enter');

    await selectChat(tab1, conv.dmTitle);
    const offlineDmMsg = `SC07_Offline_DM_3_${Date.now()}`;
    await composer.fill(offlineDmMsg);
    await composer.press('Enter');

    // 4. Restore network & verify Tab 2 live sync + Tab 1 idempotent reload with zero duplicates
    await context.setOffline(false);
    await expect(tab1.locator(DOM.connectionStatusBanner)).toBeHidden({ timeout: 10_000 });

    await expect(tab2.locator(DOM.messageList)).toContainText(offlineGroupMsg1, { timeout: 10_000 });
    await expect(tab2.locator(DOM.messageList)).toContainText(offlineGroupMsg2, { timeout: 10_000 });

    await tab1.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(tab1, groupTitle);
    await tab1.locator(DOM.forumTopicList).getByText('SC07 Release Topic').first().click();
    await expect(
      tab1.locator(DOM.messageList).locator(DOM.messageBubble).filter({ hasText: offlineGroupMsg1 }),
    ).toHaveCount(1);
    await expect(
      tab1.locator(DOM.messageList).locator(DOM.messageBubble).filter({ hasText: offlineGroupMsg2 }),
    ).toHaveCount(1);

    // 5. Global CJK search locates the release check message
    await tab1.locator(DOM.globalSearchInput).fill('发布检查');
    await expect(tab1.locator(DOM.leftColumn)).toContainText(/发布检查|SC07/);
    await tab1.locator(DOM.globalSearchInput).press('Escape');

    // 6. Export real JSON & HTML transcripts containing flushed messages
    await openRightInspector(tab1);
    const jsonDlPromise = tab1.waitForEvent('download');
    await tab1.locator(DOM.btnExportChatJson).click();
    const jsonDl = await jsonDlPromise;
    const jStream = await jsonDl.createReadStream();
    expect(jStream).not.toBeNull();
    const jChunks: Buffer[] = [];
    for await (const c of jStream!) {
      jChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    }
    expect(Buffer.concat(jChunks).toString('utf8')).toContain(offlineGroupMsg1);

    const htmlDlPromise = tab1.waitForEvent('download');
    await tab1.locator(DOM.btnExportChatHtml).click();
    const htmlDl = await htmlDlPromise;
    const hStream = await htmlDl.createReadStream();
    expect(hStream).not.toBeNull();
    const hChunks: Buffer[] = [];
    for await (const c of hStream!) {
      hChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    }
    const htmlOut = Buffer.concat(hChunks).toString('utf8');
    expect(htmlOut.toLowerCase()).toContain('<html');
    expect(htmlOut).toContain(offlineGroupMsg2);

    // Ensure DM offline message also survived cleanly
    await selectChat(tab1, conv.dmTitle);
    await expect(
      tab1.locator(DOM.messageList).locator(DOM.messageBubble).filter({ hasText: offlineDmMsg }),
    ).toHaveCount(1);
  });
});
