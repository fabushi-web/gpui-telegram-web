import { test, expect } from '../helpers/fixtures';
import { API_PATHS, DOM } from '../helpers/selectors';
import {
  apiUrl,
  authHeaders,
  clearClientState,
  createRealConversationFixture,
  getBaseUrl,
  registerUserViaApi,
} from '../helpers/server';
import {
  bilingualRegex,
  BILINGUAL_PATTERNS,
  loginWithPassword,
  openRightInspector,
  scopedButton,
  selectChat,
  sendTextMessage,
} from '../helpers/ui';
import { createPngFilePayload } from '../helpers/media';

interface CryptoAuditWindow {
  __sc08Algos?: string[];
}

test.describe('Tier 4 — SC-08: WebRTC Video Call, E2EE Secret Chat & Public Broadcast Channel RBAC', () => {
  test('SC-08: 1-on-1 WebRTC Video Call (Chromium fake media device) -> minimize to #top-call-bar -> WebCrypto E2EE Secret Chat round-trip -> hang up -> public Broadcast Channel non-admin 403 RBAC + owner Mosaic album + #right-tab-stats', async ({
    page,
    request,
  }) => {
    await clearClientState(page);
    const owner = await registerUserViaApi(request, { firstName: 'Broadcast Owner' });
    const conv = await createRealConversationFixture(request, owner.token, {
      includeChannel: true,
      channelTitle: 'SC08 Official Channel',
    });
    expect(conv.channelTitle).toBeTruthy();

    await page.addInitScript(() => {
      const win = window as unknown as CryptoAuditWindow;
      win.__sc08Algos = [];
      const subtle = window.crypto?.subtle;
      if (subtle) {
        const origEnc = subtle.encrypt.bind(subtle);
        subtle.encrypt = ((...args: Parameters<SubtleCrypto['encrypt']>) => {
          const alg = args[0];
          const name = typeof alg === 'string' ? alg : (alg as { name?: string })?.name ?? '';
          if (name) win.__sc08Algos?.push(name.toUpperCase());
          return origEnc(...args);
        }) as SubtleCrypto['encrypt'];
      }
    });

    await page.goto(`${getBaseUrl()}/`, { waitUntil: 'domcontentloaded' });
    await loginWithPassword(page, owner.username, owner.password);
    await selectChat(page, conv.dmTitle);

    // 1. Start 1-on-1 WebRTC Video Call with Chromium fake media device & minimize to #top-call-bar
    await page.locator(DOM.btnStartVideoCall).click();
    const callOverlay = page.locator(DOM.callOverlay);
    await expect(callOverlay).toBeVisible();
    await expect(callOverlay.locator('video').first()).toBeVisible();

    await scopedButton(callOverlay, bilingualRegex('minimize|collapse|back', '最小化|收起'))
      .first()
      .click();
    const topCallBar = page.locator(DOM.topCallBar);
    await expect(topCallBar).toBeVisible();

    // 2. Open E2EE Secret Chat while call stays active in top bar & send encrypted message
    const rightCol = await openRightInspector(page);
    const secretBtn = scopedButton(
      rightCol,
      bilingualRegex('secret\\s*chat|start\\s*secret|encrypted\\s*chat', '加密聊天|私密聊天|发起加密'),
    ).first();
    await expect(secretBtn).toBeVisible();
    await secretBtn.click();

    await sendTextMessage(page, 'SC08_Confidential_Secret_Credential');
    const algos = await page.evaluate(
      () => (window as unknown as CryptoAuditWindow).__sc08Algos,
    );
    expect(Array.isArray(algos)).toBe(true);
    expect(algos!.some((a) => a.includes('AES-GCM'))).toBe(true);

    // 3. Restore call from #top-call-bar & hang up cleanly
    await topCallBar.click();
    await expect(callOverlay).toBeVisible();
    await scopedButton(callOverlay, bilingualRegex('end|hang\\s*up|decline', '挂断|结束'))
      .first()
      .click();
    await expect(callOverlay).toBeHidden();
    await expect(topCallBar).toBeHidden();

    // 4. Broadcast Channel RBAC: non-admin peer receives 403 on write attempt
    const nonAdminPost = await request.post(
      apiUrl(`${API_PATHS.chats}/${conv.channelChatId}/messages`),
      {
        headers: authHeaders(conv.peer.token),
        data: { chat_id: conv.channelChatId, text: 'Unauthorized subscriber write' },
        failOnStatusCode: false,
      },
    );
    expect(nonAdminPost.status()).toBe(403);

    // 5. Channel owner publishes Mosaic album + post and verifies #right-tab-stats analytics
    await selectChat(page, conv.channelTitle!);
    await page.locator(DOM.fileUploadInput).setInputFiles([
      createPngFilePayload('sc08-banner-1.png', { r: 10, g: 132, b: 255 }),
      createPngFilePayload('sc08-banner-2.png', { r: 24, g: 132, b: 252 }),
    ]);
    const editor = page.locator(DOM.modalMediaEditor);
    await expect(editor).toBeVisible();
    await scopedButton(editor, BILINGUAL_PATTERNS.send)
      .or(scopedButton(editor, BILINGUAL_PATTERNS.confirm))
      .first()
      .click();
    await expect(editor).toBeHidden();
    expect(
      await page.locator(`${DOM.messageList} ${DOM.messageBubble} img`).count(),
    ).toBeGreaterThanOrEqual(2);

    await sendTextMessage(page, 'SC08 Broadcast Channel Official Release');

    const chanInspector = await openRightInspector(page);
    await expect(chanInspector.locator(DOM.rightTabStats)).toBeVisible();
    await chanInspector.locator(DOM.rightTabStats).click();
    await expect(chanInspector).toContainText(/views|subscribers|post|统计|浏览|订阅/i);
  });
});
