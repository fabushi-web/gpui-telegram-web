import * as crypto from 'node:crypto';
import { test, expect } from '../helpers/fixtures';
import { API_PATHS, DOM } from '../helpers/selectors';
import {
  apiUrl,
  authHeaders,
  createRealConversationFixture,
  registerUserViaApi,
  sendApiMessage,
} from '../helpers/server';
import { selectChat, sendTextMessage } from '../helpers/ui';
import { extractBotUserId, OpaqueWsClient } from '../helpers/api';

test.describe('Tier 1 — A03: Real-Time WS PtsPush/Ack, Idempotent Messaging, Sync & Local Timestamps', () => {
  test('A03-T1-01: Real-time /api/v1/ws delivery with monotonic PtsPush/Ack and peer-to-peer live message arrival without reload', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.dmTitle);

    const ws = await OpaqueWsClient.connect(user.token);
    try {
      const liveText = `Live_WS_Peer_Delivery_${Date.now()}`;
      const sent = await sendApiMessage(request, conv.peer.token, conv.dmChatId, liveText);
      expect(sent.pts).toBeGreaterThan(0);

      const frame = await ws.waitForFrame(
        (f) => {
          const type = typeof f.type === 'string' ? f.type : '';
          const serialized = JSON.stringify(f);
          return (
            (type === 'PtsPush' || type === 'PtsUpdate' || type === 'MessageNew') &&
            serialized.includes(liveText)
          );
        },
        8_000,
        'PtsPush/PtsUpdate for live peer message',
      );
      expect(frame).toBeTruthy();

      // Browser UI renders the live incoming message without page reload
      await expect(
        page.locator(DOM.messageList).locator(DOM.messageBubble).filter({ hasText: liveText }),
      ).toBeVisible({ timeout: 8_000 });
    } finally {
      ws.close();
    }
  });

  test('A03-T1-02: CreateChatRequest.client_nonce idempotency and CJK (、) vs Latin (, ) auto-generated group titles', async ({
    request,
  }) => {
    const owner = await registerUserViaApi(request, { firstName: 'Owner' });
    const latinA = await registerUserViaApi(request, { firstName: 'Clara' });
    const latinB = await registerUserViaApi(request, { firstName: 'Devon' });
    const cjkA = await registerUserViaApi(request, { firstName: '明远' });
    const cjkB = await registerUserViaApi(request, { firstName: '知行' });

    const nonce = crypto.randomUUID();
    const createRoom = async (payload: Record<string, unknown>) => {
      const res = await request.post(apiUrl(API_PATHS.chatsCreate), {
        headers: authHeaders(owner.token),
        data: payload,
      });
      expect([200, 201]).toContain(res.status());
      return (await res.json()) as Record<string, unknown>;
    };

    const first = await createRoom({
      chat_type: 'group',
      title: '',
      member_ids: [latinA.userId, latinB.userId],
      client_nonce: nonce,
    });
    const retry = await createRoom({
      chat_type: 'group',
      title: '',
      member_ids: [latinA.userId, latinB.userId],
      client_nonce: nonce,
    });

    const firstId = Number(first.chat_id ?? first.id ?? (first.chat as Record<string, unknown> | undefined)?.chat_id);
    const retryId = Number(retry.chat_id ?? retry.id ?? (retry.chat as Record<string, unknown> | undefined)?.chat_id);
    expect(firstId).toBeGreaterThan(0);
    expect(retryId).toBe(firstId);

    const latinTitle = first.title ?? (first.chat as Record<string, unknown> | undefined)?.title;
    expect(typeof latinTitle).toBe('string');
    expect(latinTitle as string).toContain(', ');
    expect((latinTitle as string).length).toBeLessThanOrEqual(72);

    const cjkGroup = await createRoom({
      chat_type: 'group',
      title: '',
      member_ids: [cjkA.userId, cjkB.userId],
      client_nonce: crypto.randomUUID(),
    });
    const cjkTitle = cjkGroup.title ?? (cjkGroup.chat as Record<string, unknown> | undefined)?.title;
    expect(typeof cjkTitle).toBe('string');
    expect(cjkTitle as string).toContain('、');
    expect((cjkTitle as string).length).toBeLessThanOrEqual(72);
  });

  test('A03-T1-03: POST /api/v1/chats/:id/messages/archive-local-bot-reply & skip_server_bot_reply persistence with monotonic pts', async ({
    request,
  }) => {
    const owner = await registerUserViaApi(request, { firstName: 'Archive Owner' });
    const botRes = await request.post(apiUrl(API_PATHS.fabushiBots), {
      headers: authHeaders(owner.token),
      data: {
        display_name: 'Archive Helper Bot',
        username: `archive_helper_${Date.now().toString(36)}_bot`,
      },
    });
    expect([200, 201]).toContain(botRes.status());
    const botData = (await botRes.json()) as {
      companion_chat_id?: number;
      bot?: { bot_user_id?: number; id?: number; user_id?: number };
      registry?: { bot_user_id?: number };
    };
    const chatId = Number(botData.companion_chat_id);
    const botUserId = extractBotUserId(botData);
    expect(chatId).toBeGreaterThan(0);
    expect(botUserId).toBeGreaterThan(0);

    const userMsg = await sendApiMessage(
      request,
      owner.token,
      chatId,
      'Local handled prompt',
      { skip_server_bot_reply: true },
    );

    const archiveRes = await request.post(
      apiUrl(`${API_PATHS.chats}/${chatId}/messages/archive-local-bot-reply`),
      {
        headers: authHeaders(owner.token),
        data: {
          bot_user_id: botUserId,
          text: 'Archived local bot reply payload',
          reply_to_msg_id: userMsg.messageId,
          client_nonce: crypto.randomInt(1, 2 ** 48 - 1),
        },
      },
    );
    expect([200, 201]).toContain(archiveRes.status());
    const archived = (await archiveRes.json()) as { message_id?: number; pts?: number };
    expect(Number(archived.message_id)).toBeGreaterThan(0);
    expect(Number(archived.pts)).toBeGreaterThan(userMsg.pts);
  });

  test('A03-T1-04: /api/v1/sync/get_difference gap sync recovery & BroadcastChannel multi-tab live message synchronization', async ({
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

    const syncBeforeRes = await request.get(
      `${apiUrl(API_PATHS.syncGetDifference)}?pts=0`,
      { headers: authHeaders(user.token) },
    );
    expect(syncBeforeRes.status()).toBe(200);
    const syncBefore = (await syncBeforeRes.json()) as { current_pts?: unknown; pts?: unknown };
    const startPts = syncBefore.current_pts ?? syncBefore.pts;
    expect(typeof startPts).toBe('number');

    const broadcastMarker = `MultiTab_Broadcast_Msg_${Date.now()}`;
    await sendTextMessage(tab1, broadcastMarker);

    // Tab 2 receives live update via WS / BroadcastChannel
    await expect(
      tab2.locator(DOM.messageList).locator(DOM.messageBubble).filter({ hasText: broadcastMarker }),
    ).toBeVisible({ timeout: 8_000 });

    const diffRes = await request.get(
      `${apiUrl(API_PATHS.syncGetDifference)}?pts=${startPts as number}`,
      { headers: authHeaders(user.token) },
    );
    expect(diffRes.status()).toBe(200);
    const diffJson = (await diffRes.json()) as {
      current_pts?: unknown;
      pts?: unknown;
      events?: unknown;
      updates?: unknown;
    };
    const nextPts = diffJson.current_pts ?? diffJson.pts;
    expect(typeof nextPts).toBe('number');
    expect(nextPts as number).toBeGreaterThan(startPts as number);
    const diffEvents = diffJson.events ?? diffJson.updates;
    expect(Array.isArray(diffEvents)).toBe(true);
    expect(JSON.stringify(diffEvents)).toContain(broadcastMarker);
  });

  test('A03-T1-05: Offline outbox queue (setOffline(true)) -> #connection-status-banner -> reconnect idempotent flush with client_nonce', async ({
    authSession,
    context,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.dmTitle);

    await context.setOffline(true);
    await expect(page.locator(DOM.connectionStatusBanner)).toBeVisible({ timeout: 8_000 });

    const offlineMsg = `Offline_Queued_Message_${Date.now()}`;
    const composer = page.locator(DOM.messageComposerInput);
    await composer.fill(offlineMsg);
    await composer.press('Enter');

    await expect(
      page.locator(DOM.messageList).locator(DOM.messageBubble).filter({ hasText: offlineMsg }),
    ).toHaveCount(1);

    await context.setOffline(false);
    await expect(page.locator(DOM.connectionStatusBanner)).toBeHidden({ timeout: 10_000 });

    // Reload proves the offline outbox flushed cleanly to SQLite with zero duplicates
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.dmTitle);
    await expect(
      page.locator(DOM.messageList).locator(DOM.messageBubble).filter({ hasText: offlineMsg }),
    ).toHaveCount(1);
  });

  test('A03-T1-06: Local-timezone HH:MM bubble timestamps and page.reload() SQLite persistence survival', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.dmTitle);

    const marker = `Persisted_TZ_Timestamp_${Date.now()}`;
    const bubble = await sendTextMessage(page, marker);
    const expectedHm = await page.evaluate(() => {
      const now = new Date();
      return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    });

    await bubble.hover();
    const bubbleText = await bubble.innerText();
    expect(bubbleText).toMatch(/\b\d{1,2}:\d{2}\b/);
    // Allow 1-minute boundary rollover around minute ticks
    const [hh, mm] = expectedHm.split(':').map(Number);
    const prevMinute = new Date();
    prevMinute.setHours(hh, mm - 1);
    const prevHm = `${String(prevMinute.getHours()).padStart(2, '0')}:${String(prevMinute.getMinutes()).padStart(2, '0')}`;
    expect(bubbleText.includes(expectedHm) || bubbleText.includes(prevHm)).toBe(true);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.dmTitle);
    await expect(
      page.locator(DOM.messageList).locator(DOM.messageBubble).filter({ hasText: marker }),
    ).toBeVisible();
  });
});
