import { test, expect } from '../helpers/fixtures';
import { API_PATHS, DOM } from '../helpers/selectors';
import {
  apiUrl,
  authHeaders,
  createRealConversationFixture,
} from '../helpers/server';
import {
  BILINGUAL_PATTERNS,
  openContextMenuAndClick,
  readComposerText,
  selectChat,
  sendTextMessage,
  simulateCjkImeComposition,
} from '../helpers/ui';

test.describe('Tier 2 — A05: Anti-Fabricated OpenGraph, XSS Escaping, IME Guard, Edit RBAC & Reaction Edge Cases', () => {
  test('A05-T2-01: Bare URL lacking OpenGraph metadata MUST NOT fabricate fake OpenGraph preview cards or fake #instant-view-modal articles', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.dmTitle);

    const bareUrl = 'https://no-opengraph-metadata.invalid/plain-page';
    const bubble = await sendTextMessage(page, bareUrl);
    await page.waitForTimeout(400);

    const bubbleText = await bubble.innerText();
    expect(bubbleText).toContain(bareUrl);
    expect(bubbleText).not.toMatch(/Official Web Article|OpenGraph preview for|Article on no-opengraph/i);
    await expect(bubble.getByRole('button', { name: /instant view|即时预览/i })).toHaveCount(0);
    await expect(page.locator(DOM.instantViewModal)).toBeHidden();
  });

  test('A05-T2-02: XSS entity payloads (<img onerror>, <svg onload>, javascript:) strictly neutralized (window.__xss === undefined) & UTF-16 astral emoji offsets stay exact', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.dmTitle);

    const xssPayload =
      `<img src=x onerror="window.__xss=1"><svg onload="window.__xss=2">[click](javascript:window.__xss=3) 🚀 **AstralBold**`;
    const bubble = await sendTextMessage(page, xssPayload);

    const xssVal = await page.evaluate(
      () => (window as unknown as { __xss?: number }).__xss,
    );
    expect(xssVal).toBeUndefined();
    await expect(bubble.locator('a[href^="javascript:"]')).toHaveCount(0);
    await expect(bubble).toContainText('🚀');
    await expect(bubble.locator('strong, b').first()).toContainText('AstralBold');
  });

  test('A05-T2-03: Trailing post-composition same-frame Enter (Safari/macOS IME 3rd-state guard) does NOT prematurely send; whitespace-only messages blocked', async ({
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

    // Whitespace-only send MUST be blocked
    await composer.fill('    \n   ');
    await composer.press('Enter');
    expect(await bubbles.count()).toBe(countBefore);

    // Clear and simulate Safari/macOS same-frame trailing Enter after compositionend
    await composer.fill('');
    await simulateCjkImeComposition(composer, 'ceshi', '防误发验证', {
      simulateTrailingPostCompositionEnter: true,
    });
    expect(await bubbles.count()).toBe(countBefore);
    expect(await readComposerText(composer)).toContain('防误发验证');
  });

  test('A05-T2-04: ArrowUp in non-empty composer does NOT hijack caret into edit mode; editing another user incoming message rejected (403)', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token, {
      initialDmMessages: [{ from: 'peer', text: 'Peer immutable message 101' }],
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.dmTitle);

    const composer = page.locator(DOM.messageComposerInput);
    await composer.fill('Unsent draft text');
    await composer.press('ArrowUp');
    await expect(page.locator(DOM.composerReplyEditBanner)).toBeHidden();
    expect(await readComposerText(composer)).toBe('Unsent draft text');

    // 1. Prove PATCH endpoint is live for the message's actual author (conv.peer)
    const peerMsgId = conv.messages[0].messageId;
    const msgPatchUrl = apiUrl(`${API_PATHS.chats}/${conv.dmChatId}/messages/${peerMsgId}`);
    const ownerEditRes = await request.patch(msgPatchUrl, {
      headers: authHeaders(conv.peer.token),
      data: { text: 'Peer self-updated message 101' },
    });
    expect(ownerEditRes.status()).toBe(200);

    // 2. Primary user attempting to edit peer's message MUST return strictly 403 (NOT 404)
    const editRes = await request.patch(msgPatchUrl, {
      headers: authHeaders(user.token),
      data: { text: 'Tampered peer message' },
      failOnStatusCode: false,
    });
    expect(editRes.status()).toBe(403);
  });

  test('A05-T2-05: Rapid multi-click reaction toggling never leaves 0-count chip or negative count', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.dmTitle);

    const bubble = await sendTextMessage(page, 'Reaction toggle idempotency target');
    await bubble.hover();
    const reactTrigger = bubble
      .locator('[data-testid*="reaction" i], button[aria-label*="react" i]')
      .or(page.locator('[data-testid="reaction-quick-bar"] button').first())
      .first();
    await expect(reactTrigger).toBeVisible();
    await reactTrigger.click();

    const firstQuick = page
      .locator('[data-testid="reaction-quick-bar"] button, [data-testid="reaction-picker"] button')
      .filter({ hasText: /👍|❤️|🔥/ })
      .first();
    await expect(firstQuick).toBeVisible();
    await firstQuick.click();

    const chip = bubble
      .locator('[data-testid="reaction-chip"], button')
      .filter({ hasText: /👍|❤️|🔥/ })
      .first();
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('1');

    // Rapid toggle off cleanly removes chip with zero negative or 0-count ghosts
    await chip.click();
    await expect(chip).toHaveCount(0);

    const bubbleText = await bubble.innerText();
    expect(bubbleText).not.toMatch(/-\d+/);
    expect(bubbleText).not.toMatch(/(?:👍|❤️|🔥)\s*0\b/);
  });

  test('A05-T2-06: Deleting a pinned message removes/updates #pinned-message-banner', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.dmTitle);

    const bubble = await sendTextMessage(page, 'Ephemeral pinned message');
    await openContextMenuAndClick(page, bubble, BILINGUAL_PATTERNS.pin);
    await expect(page.locator(DOM.pinnedMessageBanner)).toBeVisible();

    await openContextMenuAndClick(page, bubble, BILINGUAL_PATTERNS.delete);
    const delDialog = page.locator('[role="dialog"]').first();
    await expect(delDialog).toBeVisible();
    await delDialog
      .getByRole('button', { name: BILINGUAL_PATTERNS.delete })
      .or(delDialog.getByRole('button', { name: BILINGUAL_PATTERNS.confirm }))
      .first()
      .click();

    await expect(
      page
        .locator(DOM.messageList)
        .locator(DOM.messageBubble)
        .filter({ hasText: 'Ephemeral pinned message' }),
    ).toHaveCount(0);
    await expect(page.locator(DOM.pinnedMessageBanner)).toBeHidden();
  });
});
