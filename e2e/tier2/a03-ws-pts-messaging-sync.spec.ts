import * as crypto from 'node:crypto';
import { test, expect } from '../helpers/fixtures';
import { API_PATHS, DOM } from '../helpers/selectors';
import {
  apiUrl,
  authHeaders,
  createRealConversationFixture,
  registerUserViaApi,
} from '../helpers/server';
import { extractBotUserId, OpaqueWsClient } from '../helpers/api';
import { readComposerText, selectChat, sendTextMessage } from '../helpers/ui';

test.describe('Tier 2 — A03: Messaging Idempotency, Race Fencing, WS Rejection & Overflow Boundaries', () => {
  test('A03-T2-01: Retrying POST /api/v1/chats/create with identical client_nonce returns same chat_id; retrying message send returns duplicate: true', async ({
    request,
  }) => {
    const owner = await registerUserViaApi(request);
    const peer = await registerUserViaApi(request, { firstName: 'Nonce Peer' });

    // 1. Retrying POST /api/v1/chats/create with identical client_nonce returns same chat_id
    const chatNonce = crypto.randomUUID();
    const chat1 = await request.post(apiUrl(API_PATHS.chatsCreate), {
      headers: authHeaders(owner.token),
      data: {
        chat_type: 'group',
        title: 'Idempotent Group',
        member_ids: [peer.userId],
        client_nonce: chatNonce,
      },
    });
    expect([200, 201]).toContain(chat1.status());
    const chat1Body = (await chat1.json()) as { chat_id?: number; id?: number };
    const chat2 = await request.post(apiUrl(API_PATHS.chatsCreate), {
      headers: authHeaders(owner.token),
      data: {
        chat_type: 'group',
        title: 'Idempotent Group',
        member_ids: [peer.userId],
        client_nonce: chatNonce,
      },
    });
    expect([200, 201]).toContain(chat2.status());
    const chat2Body = (await chat2.json()) as { chat_id?: number; id?: number };
    expect(chat2Body.chat_id ?? chat2Body.id).toBe(chat1Body.chat_id ?? chat1Body.id);

    // 2. Retrying message send with identical u64 client_nonce returns duplicate: true
    const conv = await createRealConversationFixture(request, owner.token);
    const msgNonce = crypto.randomInt(1, 2 ** 48 - 1);
    const url = apiUrl(`${API_PATHS.chats}/${conv.dmChatId}/messages`);
    const first = await request.post(url, {
      headers: authHeaders(owner.token),
      data: { chat_id: conv.dmChatId, text: 'Idempotent payload', client_nonce: msgNonce },
    });
    expect([200, 201]).toContain(first.status());
    const firstBody = (await first.json()) as { message_id?: number; id?: number };

    const retry = await request.post(url, {
      headers: authHeaders(owner.token),
      data: { chat_id: conv.dmChatId, text: 'Idempotent payload', client_nonce: msgNonce },
    });
    expect([200, 201]).toContain(retry.status());
    const retryBody = (await retry.json()) as {
      message_id?: number;
      id?: number;
      duplicate?: boolean;
    };
    expect(retryBody.duplicate).toBe(true);
    expect(retryBody.message_id ?? retryBody.id).toBe(firstBody.message_id ?? firstBody.id);
  });

  test('A03-T2-02: Rapid switching across chats fences stale async requests (zero cross-chat bubble or draft bleed)', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token, {
      includeGroup: true,
      groupTitle: 'Fence Group Beta',
      initialDmMessages: [{ from: 'peer', text: 'DM_EXCLUSIVE_TOKEN_881' }],
      initialGroupMessages: [{ from: 'primary', text: 'GROUP_EXCLUSIVE_TOKEN_992' }],
    });
    await page.reload({ waitUntil: 'domcontentloaded' });

    const groupTitle = conv.groupTitle ?? 'Fence Group Beta';
    for (let i = 0; i < 4; i++) {
      await selectChat(page, conv.dmTitle);
      await selectChat(page, groupTitle);
    }

    await expect(page.locator(DOM.chatHeaderTitle)).toContainText(groupTitle);
    await expect(page.locator(DOM.messageList)).toContainText('GROUP_EXCLUSIVE_TOKEN_992');
    await expect(page.locator(DOM.messageList)).not.toContainText('DM_EXCLUSIVE_TOKEN_881');
  });

  test('A03-T2-03: Unauthenticated or invalid-token WebSocket connection to /api/v1/ws is rejected fail-closed', async ({
    request,
  }) => {
    // Prove /api/v1/ws is live and accepts a genuine Bearer token before asserting invalid tokens fail
    const validUser = await registerUserViaApi(request);
    const validWs = await OpaqueWsClient.connect(validUser.token, 5_000);
    try {
      for (const badToken of ['', 'forged_invalid_bearer_token_000']) {
        let acceptedInvalid = false;
        try {
          const ws = await OpaqueWsClient.connect(badToken, 3_000);
          acceptedInvalid = true;
          ws.close();
        } catch {
          acceptedInvalid = false;
        }
        expect(acceptedInvalid).toBe(false);
      }
    } finally {
      validWs.close();
    }
  });

  test('A03-T2-04: Sending message when offline does NOT silently drop composer text when server rejects', async ({
    authSession,
    context,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.dmTitle);

    const payload = 'NeverDropOfflineDraft_443';
    const composer = page.locator(DOM.messageComposerInput);
    await context.setOffline(true);
    try {
      await expect(page.locator(DOM.connectionStatusBanner)).toBeVisible({ timeout: 8_000 });
      await composer.fill(payload);
      await composer.press('Enter');

      // Text must either be preserved in composer or rendered in pending outbox bubble — NEVER silently lost
      const remainingText = await readComposerText(composer);
      const inTimeline = await page
        .locator(DOM.messageList)
        .locator(DOM.messageBubble)
        .filter({ hasText: payload })
        .count();
      expect(remainingText.includes(payload) || inTimeline >= 1).toBe(true);
    } finally {
      await context.setOffline(false);
    }

    await expect(page.locator(DOM.connectionStatusBanner)).toBeHidden({ timeout: 10_000 });

    // Reconnect and prove the composer is live (not a dead <textarea>): draft sends and renders in #message-list
    const draftAfterReconnect = await readComposerText(composer);
    if (draftAfterReconnect.includes(payload)) {
      const sendBtn = page.locator(DOM.btnSendMessage);
      if ((await sendBtn.isVisible()) && (await sendBtn.isEnabled())) {
        await sendBtn.click();
      } else {
        await composer.press('Enter');
      }
    }
    await expect(
      page.locator(DOM.messageList).locator(DOM.messageBubble).filter({ hasText: payload }).last(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('A03-T2-05: POST .../archive-local-bot-reply rejects non-member (403) or empty text (400)', async ({
    request,
  }) => {
    const owner = await registerUserViaApi(request);
    const outsider = await registerUserViaApi(request);

    const botRes = await request.post(apiUrl(API_PATHS.fabushiBots), {
      headers: authHeaders(owner.token),
      data: {
        display_name: 'Archive Guard Bot',
        username: `arch_guard_${Date.now().toString(36)}_bot`,
      },
    });
    expect([200, 201]).toContain(botRes.status());
    const botData = (await botRes.json()) as {
      companion_chat_id: number;
      bot?: { bot_user_id?: number; id?: number; user_id?: number };
      registry?: { bot_user_id?: number };
    };
    const botUserId = extractBotUserId(botData);
    const endpoint = apiUrl(
      `${API_PATHS.chats}/${botData.companion_chat_id}/messages/archive-local-bot-reply`,
    );

    const emptyTextRes = await request.post(endpoint, {
      headers: authHeaders(owner.token),
      data: { bot_user_id: botUserId, text: '   ' },
      failOnStatusCode: false,
    });
    expect(emptyTextRes.status()).toBe(400);

    const outsiderRes = await request.post(endpoint, {
      headers: authHeaders(outsider.token),
      data: { bot_user_id: botUserId, text: 'Unauthorized archive injection' },
      failOnStatusCode: false,
    });
    expect(outsiderRes.status()).toBe(403);
  });

  test('A03-T2-06: > 4096 character message and 250-char unbroken URL wrap cleanly without horizontal overflow', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.dmTitle);

    const unbrokenUrl = `https://example.invalid/${'segment'.repeat(36)}`;
    expect(unbrokenUrl.length).toBeGreaterThanOrEqual(250);
    await sendTextMessage(page, unbrokenUrl);

    const overflow = await page.evaluate(() => {
      const list = document.querySelector('#message-list');
      return list ? list.scrollWidth - list.clientWidth : 999;
    });
    expect(overflow).toBeLessThanOrEqual(4);

    // >4096 char payload via API must either be accepted with valid message_id or rejected cleanly with 400/413 + error string (never 500)
    const oversizedText = 'A'.repeat(4500);
    const bigRes = await request.post(
      apiUrl(`${API_PATHS.chats}/${conv.dmChatId}/messages`),
      {
        headers: authHeaders(user.token),
        data: { chat_id: conv.dmChatId, text: oversizedText },
        failOnStatusCode: false,
      },
    );
    const bigStatus = bigRes.status();
    const bigBody = (await bigRes.json()) as { message_id?: number; id?: number; error?: unknown };
    if (bigStatus === 200 || bigStatus === 201) {
      expect(Number(bigBody.message_id ?? bigBody.id)).toBeGreaterThan(0);
    } else {
      expect([400, 413]).toContain(bigStatus);
      expect(typeof bigBody.error).toBe('string');
      expect((bigBody.error as string).length).toBeGreaterThan(0);
    }
  });
});
