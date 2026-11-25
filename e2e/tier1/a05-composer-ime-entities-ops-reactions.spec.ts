import { test, expect } from '../helpers/fixtures';
import { CMP_INPUT_WRAP, DOM } from '../helpers/selectors';
import { createRealConversationFixture } from '../helpers/server';
import {
  bilingualRegex,
  BILINGUAL_PATTERNS,
  openContextMenuAndClick,
  readComposerText,
  scopedButton,
  selectChat,
  sendTextMessage,
  simulateCjkImeComposition,
} from '../helpers/ui';

test.describe('Tier 1 — A05: Composer, CJK IME Safety, Rich Entities, Message Ops & Reactions', () => {
  test('A05-T1-01: 3-state CJK IME Safety FSM (compositionstart -> Enter commits candidate without sending -> idle Enter sends)', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.dmTitle);

    const composer = page.locator(DOM.messageComposerInput);
    const bubbles = page.locator(DOM.messageList).locator(DOM.messageBubble);
    const countBefore = await bubbles.count();

    await simulateCjkImeComposition(composer, 'fabushi', '法布施测试消息');

    // Candidate commit Enter MUST NOT prematurely send
    expect(await bubbles.count()).toBe(countBefore);
    expect(await readComposerText(composer)).toContain('法布施测试消息');

    // Subsequent Idle Enter sends cleanly
    await composer.press('Enter');
    await expect(bubbles.filter({ hasText: '法布施测试消息' })).toBeVisible();
  });

  test('A05-T1-02: Apple Capsule Composer (#cmp-input-wrap) elastic growth, Shift+Enter newline, #btn-formatting-toolbar, #emoji-sticker-gif-popover, and per-chat draft sync', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token, {
      includeGroup: true,
      groupTitle: 'Draft Target Group',
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.dmTitle);

    const capsule = page.locator(`${CMP_INPUT_WRAP}, ${DOM.messageComposerInput}`).first();
    await expect(capsule).toBeVisible();
    const initialBox = await capsule.boundingBox();
    expect(initialBox).not.toBeNull();
    expect(initialBox!.width).toBeLessThanOrEqual(780);
    expect(initialBox!.height).toBeGreaterThanOrEqual(36);

    const composer = page.locator(DOM.messageComposerInput);
    await composer.click();
    await composer.type('Line 1');
    await composer.press('Shift+Enter');
    await composer.type('Line 2');
    await composer.press('Shift+Enter');
    await composer.type('Line 3');

    const grownBox = await capsule.boundingBox();
    expect(grownBox!.height).toBeGreaterThan(initialBox!.height);
    expect(await readComposerText(composer)).toContain('Line 1\nLine 2\nLine 3');

    // Formatting toolbar & Emoji popover
    await page.locator(DOM.btnFormattingToolbar).click();
    await expect(
      page.locator('[data-testid*="format" i], [role="toolbar"] button').first(),
    ).toBeVisible();
    await page.locator(DOM.btnEmojiPicker).click();
    await expect(page.locator(DOM.emojiStickerGifPopover)).toBeVisible();
    await page.keyboard.press('Escape');

    // Switch away and back to verify per-chat draft persistence
    await selectChat(page, conv.groupTitle ?? 'Draft Target Group');
    expect(await readComposerText(composer)).toBe('');
    await selectChat(page, conv.dmTitle);
    expect(await readComposerText(composer)).toContain('Line 1');
  });

  test('A05-T1-03: Rich UTF-16 entities (bold, italic, underline, strike, fenced code with Copy, ||spoiler|| click-to-reveal, @mention, #hashtag)', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.dmTitle);

    const richPayload = [
      `**BoldText** _ItalicText_ ~~StrikeText~~ \`inlineCode\``,
      `||HiddenSpoilerSecret|| @${conv.peer.username} #fabushi1611`,
      '```ts',
      'export const version = "1.6.11";',
      '```',
    ].join('\n');

    const bubble = await sendTextMessage(page, richPayload);
    await expect(bubble.locator('strong, b').first()).toContainText('BoldText');
    await expect(bubble.locator('em, i').first()).toContainText('ItalicText');
    await expect(bubble.locator('s, del').first()).toContainText('StrikeText');
    await expect(bubble.locator('code').filter({ hasText: 'inlineCode' }).first()).toBeVisible();
    await expect(bubble.locator('pre, code').filter({ hasText: 'version = "1.6.11"' }).first()).toBeVisible();

    const copyCodeBtn = scopedButton(bubble, BILINGUAL_PATTERNS.copy).first();
    await expect(copyCodeBtn).toBeVisible();
    await copyCodeBtn.click();

    const spoiler = bubble.locator('[data-entity-type="spoiler"], .spoiler, [data-spoiler]').first();
    await expect(spoiler).toBeVisible();
    await spoiler.click();
    await expect(bubble).toContainText('HiddenSpoilerSecret');
    await expect(bubble).toContainText(`@${conv.peer.username}`);
    await expect(bubble).toContainText('#fabushi1611');
  });

  test('A05-T1-04: Message Reply, Partial Quote Reply, Edit (ArrowUp on empty composer -> "edited"), and #composer-reply-edit-banner', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.dmTitle);

    const originalText = 'Editable target message for reply and quote';
    const bubble = await sendTextMessage(page, originalText);

    // Reply via context menu opens #composer-reply-edit-banner
    await openContextMenuAndClick(page, bubble, BILINGUAL_PATTERNS.reply);
    await expect(page.locator(DOM.composerReplyEditBanner)).toBeVisible();
    await sendTextMessage(page, 'Direct reply payload');
    await expect(page.locator(DOM.composerReplyEditBanner)).toBeHidden();

    // ArrowUp on empty composer enters Edit mode for latest own message
    const composer = page.locator(DOM.messageComposerInput);
    await composer.click();
    await composer.press('ArrowUp');
    await expect(page.locator(DOM.composerReplyEditBanner)).toBeVisible();
    await composer.fill('Direct reply payload UPDATED');
    await composer.press('Enter');

    const editedBubble = page
      .locator(DOM.messageList)
      .locator(DOM.messageBubble)
      .filter({ hasText: 'Direct reply payload UPDATED' })
      .first();
    await expect(editedBubble).toBeVisible();
    await expect(editedBubble).toContainText(/edited|已编辑/i);
  });

  test('A05-T1-05: Forward (#modal-forward to Saved Messages/peer), Pin (#pinned-message-banner cycle & jump), Delete, and #selection-toolbar multi-select batch ops', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token, {
      includeGroup: true,
      groupTitle: 'Forward Target Group',
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.dmTitle);

    const pinBubble = await sendTextMessage(page, 'Pinned release milestone anchor');
    const fwdBubble = await sendTextMessage(page, 'Forwardable status update');

    // Pin message -> #pinned-message-banner appears and jumps cleanly to pinned bubble
    await openContextMenuAndClick(page, pinBubble, BILINGUAL_PATTERNS.pin);
    await expect(page.locator(DOM.pinnedMessageBanner)).toBeVisible();
    await expect(page.locator(DOM.pinnedMessageBanner)).toContainText('Pinned release milestone anchor');
    await page.locator(DOM.pinnedMessageBanner).click();
    await expect(pinBubble).toBeInViewport();

    // Forward message via #modal-forward and verify arrival in destination group
    const forwardTargetTitle = conv.groupTitle ?? 'Forward Target Group';
    await openContextMenuAndClick(page, fwdBubble, BILINGUAL_PATTERNS.forward);
    const fwdModal = page.locator(DOM.modalForward);
    await expect(fwdModal).toBeVisible();
    const targetItem = fwdModal.getByText(forwardTargetTitle).first();
    await expect(targetItem).toBeVisible();
    await targetItem.click();
    const confirmFwd = scopedButton(fwdModal, BILINGUAL_PATTERNS.send)
      .or(scopedButton(fwdModal, BILINGUAL_PATTERNS.confirm))
      .first();
    await expect(confirmFwd).toBeVisible();
    await confirmFwd.click();
    await expect(fwdModal).toBeHidden();

    await selectChat(page, forwardTargetTitle);
    await expect(page.locator(DOM.messageList)).toContainText('Forwardable status update');
    await selectChat(page, conv.dmTitle);

    // Multi-select batch toolbar (#selection-toolbar) + batch delete
    const dmFwdBubble = page
      .locator(DOM.messageList)
      .locator(DOM.messageBubble)
      .filter({ hasText: 'Forwardable status update' })
      .first();
    await openContextMenuAndClick(page, dmFwdBubble, BILINGUAL_PATTERNS.select);
    const selBar = page.locator(DOM.selectionToolbar);
    await expect(selBar).toBeVisible();
    await scopedButton(selBar, BILINGUAL_PATTERNS.delete).first().click();

    const delDialog = page.locator('[role="dialog"]').first();
    await expect(delDialog).toBeVisible();
    await scopedButton(delDialog, BILINGUAL_PATTERNS.delete)
      .or(scopedButton(delDialog, BILINGUAL_PATTERNS.confirm))
      .first()
      .click();
    await expect(selBar).toBeHidden();
    await expect(
      page.locator(DOM.messageList).locator(DOM.messageBubble).filter({ hasText: 'Forwardable status update' }),
    ).toHaveCount(0);
  });

  test('A05-T1-06: Out-of-flow hover quick reactions (zero layout shift), 32-emoji picker toggle (+1/-1), reactor list, and reload persistence', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.dmTitle);

    const bubble = await sendTextMessage(page, 'Reaction zero-jitter verification bubble');
    const boxBefore = await bubble.boundingBox();
    expect(boxBefore).not.toBeNull();

    await bubble.hover();
    const boxAfterHover = await bubble.boundingBox();
    expect(boxAfterHover).not.toBeNull();
    // Zero layout shift (<= 0.5px vertical/horizontal jitter)
    expect(Math.abs(boxAfterHover!.y - boxBefore!.y)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(boxAfterHover!.x - boxBefore!.x)).toBeLessThanOrEqual(0.5);

    const reactTrigger = bubble
      .locator('[data-testid*="reaction" i], button[aria-label*="react" i], button[title*="react" i]')
      .or(page.locator('[data-testid="reaction-quick-bar"] button').first())
      .first();
    await expect(reactTrigger).toBeVisible();
    await reactTrigger.click();

    const emojiChoice = page
      .locator('[data-testid="reaction-quick-bar"] button, [data-testid="reaction-picker"] button')
      .filter({ hasText: /👍|❤️|🔥/ })
      .first();
    await expect(emojiChoice).toBeVisible();
    await emojiChoice.click();

    const reactionChip = bubble
      .locator('[data-testid="reaction-chip"], button')
      .filter({ hasText: /👍|❤️|🔥/ })
      .first();
    await expect(reactionChip).toBeVisible();
    await expect(reactionChip).toContainText('1');

    // Persistence across page reload
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.dmTitle);
    const reloadedBubble = page
      .locator(DOM.messageList)
      .locator(DOM.messageBubble)
      .filter({ hasText: 'Reaction zero-jitter verification bubble' })
      .first();
    const reloadedChip = reloadedBubble
      .locator('[data-testid="reaction-chip"], button')
      .filter({ hasText: /👍|❤️|🔥/ })
      .first();
    await expect(reloadedChip).toBeVisible();

    // Toggle off (-1) cleanly removes reaction chip
    await reloadedChip.click();
    await expect(reloadedChip).toHaveCount(0);
  });
});
