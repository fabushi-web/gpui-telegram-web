import { test, expect } from '../helpers/fixtures';
import { DOM, VIEWPORTS } from '../helpers/selectors';
import { createRealConversationFixture } from '../helpers/server';
import {
  BILINGUAL_PATTERNS,
  openRightInspector,
  readComposerText,
  scopedButton,
  selectChat,
  simulateCjkImeComposition,
} from '../helpers/ui';
import { createPngFilePayload } from '../helpers/media';

test.describe('Tier 3 — PW02: Media Editor + Inspector Isolation, Voice Bar + Search & Mobile IME Stack', () => {
  test('PW-04 (A06 x A05 x A07): #modal-media-editor album -> #lightbox-viewer -> #right-tab-media strict per-chat isolation', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token, {
      includeGroup: true,
      groupTitle: 'No Media Group',
    });
    expect(conv.groupTitle).toBeTruthy();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.dmTitle);

    await page.locator(DOM.fileUploadInput).setInputFiles([
      createPngFilePayload('pw04-a.png', { r: 10, g: 132, b: 255 }),
      createPngFilePayload('pw04-b.png', { r: 0, g: 186, b: 105 }),
    ]);

    const editor = page.locator(DOM.modalMediaEditor);
    await expect(editor).toBeVisible();
    await scopedButton(editor, BILINGUAL_PATTERNS.send)
      .or(scopedButton(editor, BILINGUAL_PATTERNS.confirm))
      .first()
      .click();
    await expect(editor).toBeHidden();

    const albumImgs = page.locator(`${DOM.messageList} ${DOM.messageBubble} img`);
    await expect(albumImgs.first()).toBeVisible();
    expect(await albumImgs.count()).toBeGreaterThanOrEqual(2);

    await albumImgs.first().click();
    await expect(page.locator(DOM.lightboxViewer)).toBeVisible();
    await page.locator(DOM.lightboxClose).click();
    await expect(page.locator(DOM.lightboxViewer)).toBeHidden();

    // Check #right-tab-media in DM shows media, while Group has 0 media items
    const rightCol = await openRightInspector(page);
    await rightCol.locator(DOM.rightTabMedia).click();
    await expect(rightCol.locator('img:not([class*="avatar" i]):not([data-avatar])').first()).toBeVisible();

    await selectChat(page, conv.groupTitle!);
    await openRightInspector(page);
    await rightCol.locator(DOM.rightTabMedia).click();
    await expect(rightCol.locator('img:not([class*="avatar" i]):not([data-avatar])')).toHaveCount(0);
  });

  test('PW-05 (A06 x A04 x A07): Real Chromium fake mic Voice Note -> 1.5x playback -> switch chat keeping #top-audio-player-bar live -> run In-Chat Search', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token, {
      includeGroup: true,
      groupTitle: 'Searchable Target Group',
      initialGroupMessages: [{ from: 'primary', text: 'AudioBarSearchToken_PW05' }],
    });
    expect(conv.groupTitle).toBeTruthy();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.dmTitle);

    const recordBtn = page.locator(DOM.btnRecordVoice);
    await recordBtn.click();
    await page.waitForTimeout(1000);
    await page.locator(`${DOM.btnSendMessage}:visible, ${DOM.btnRecordVoice}:visible`).first().click();

    const voiceBubble = page
      .locator(DOM.messageList)
      .locator(DOM.messageBubble)
      .filter({ has: page.locator('audio, canvas, [data-waveform], [data-testid*="voice" i]') })
      .last();
    await expect(voiceBubble).toBeVisible({ timeout: 10_000 });
    await voiceBubble.locator('button').first().click();

    const topBar = page.locator(DOM.topAudioPlayerBar);
    await expect(topBar).toBeVisible();

    // Cycle playback speed to 1.5x / 2x and confirm persistence across chat switch
    const speedBtn = topBar.getByRole('button', { name: /1x|1\.5x|2x|speed|倍速/i }).first();
    await expect(speedBtn).toBeVisible();
    await speedBtn.click();
    await expect(topBar).toContainText(/1\.5x|2x/i);

    // Switch chat -> audio bar stays live at elevated speed while running In-Chat Search
    await selectChat(page, conv.groupTitle!);
    await expect(topBar).toBeVisible();
    await expect(topBar).toContainText(/1\.5x|2x/i);
    await page.locator(DOM.btnInChatSearch).click();
    await page.locator(DOM.inChatSearchInput).fill('AudioBarSearchToken_PW05');
    await expect(page.locator(DOM.messageList)).toContainText('AudioBarSearchToken_PW05');
  });

  test('PW-06 (A02 x A05 x A07): Mobile 390x844 single-pane stack + 3-state CJK IME commit + Right Inspector profile + #btn-back-to-chats', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token);
    await page.setViewportSize(VIEWPORTS.mobileStack);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.dmTitle);

    const composer = page.locator(DOM.messageComposerInput);
    const bubbles = page.locator(DOM.messageList).locator(DOM.messageBubble);
    const countBefore = await bubbles.count();

    await simulateCjkImeComposition(composer, 'yidongduan', '移动端测试消息', {
      simulateTrailingPostCompositionEnter: true,
    });
    expect(await bubbles.count()).toBe(countBefore);
    expect(await readComposerText(composer)).toContain('移动端测试消息');

    await composer.press('Enter');
    await expect(bubbles.filter({ hasText: '移动端测试消息' })).toBeVisible();

    await page.locator(DOM.btnToggleRightColumn).click();
    await expect(page.locator(DOM.rightColumn)).toBeVisible();
    await expect(page.locator(DOM.rightProfileInfo)).toContainText(conv.dmTitle);
    await page.keyboard.press('Escape');
    await expect(page.locator(DOM.rightColumn)).toBeHidden();
    await page.locator(DOM.btnBackToChats).click();
    await expect(page.locator(DOM.leftColumn)).toBeVisible();
  });
});
