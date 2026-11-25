import { test, expect } from '../helpers/fixtures';
import { API_PATHS, DOM } from '../helpers/selectors';
import {
  apiUrl,
  authHeaders,
  createRealConversationFixture,
  registerUserViaApi,
} from '../helpers/server';
import {
  BILINGUAL_PATTERNS,
  openContextMenuAndClick,
  selectChat,
} from '../helpers/ui';

test.describe('Tier 2 — A04: Contacts Anti-Fabrication, Search Metacharacters, Forum RBAC & Chat Selection Boundaries', () => {
  test('A04-T2-01: POST /api/v1/contacts with non-existent user returns 404 and does NOT fabricate an offline synthetic user', async ({
    request,
  }) => {
    const user = await registerUserViaApi(request);
    const res = await request.post(apiUrl(API_PATHS.contacts), {
      headers: authHeaders(user.token),
      data: {
        username: 'nonexistent_ghost_handle_998877',
        phone: '+19995550199',
        first_name: 'Ghost User',
      },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(404);

    // Contacts list remains truthfully empty
    const listRes = await request.get(apiUrl(API_PATHS.contacts), {
      headers: authHeaders(user.token),
    });
    expect(listRes.status()).toBe(200);
    const body = (await listRes.json()) as { contacts?: unknown } | unknown[];
    const list = Array.isArray(body) ? body : body.contacts;
    expect(Array.isArray(list)).toBe(true);
    expect(list as unknown[]).toHaveLength(0);
  });

  test('A04-T2-02: Archiving and unarchiving last chat updates #archived-chats-row dynamically', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token);
    await page.reload({ waitUntil: 'domcontentloaded' });

    const row = page
      .locator(DOM.chatList)
      .locator(DOM.chatRow)
      .filter({ hasText: conv.dmTitle })
      .first();
    await openContextMenuAndClick(page, row, BILINGUAL_PATTERNS.archive);

    const archivedRow = page.locator(DOM.archivedChatsRow);
    await expect(archivedRow).toBeVisible();
    await archivedRow.click();

    const archivedItem = page
      .locator(DOM.chatList)
      .locator(DOM.chatRow)
      .filter({ hasText: conv.dmTitle })
      .first();
    await expect(archivedItem).toBeVisible();
    await openContextMenuAndClick(page, archivedItem, BILINGUAL_PATTERNS.unarchive);

    await expect(page.locator(DOM.chatList)).toContainText(conv.dmTitle);
  });

  test('A04-T2-03: Search queries with regex/SQL/HTML metacharacters return clean zero-match state with zero XSS or 500 errors', async ({
    authSession,
  }) => {
    const { page } = authSession;
    const serverErrors: number[] = [];
    page.on('response', (res) => {
      if (res.status() >= 500) serverErrors.push(res.status());
    });

    const hostileQuery = `.*+?[]'";<img src=x onerror="window.__searchXss=1">`;
    const searchInput = page.locator(DOM.globalSearchInput);
    await searchInput.fill(hostileQuery);
    await page.waitForTimeout(400);

    const xssTriggered = await page.evaluate(
      () => (window as unknown as { __searchXss?: number }).__searchXss,
    );
    expect(xssTriggered).toBeUndefined();
    expect(serverErrors).toEqual([]);
    await expect(page.locator(DOM.chatList).locator(DOM.chatRow)).toHaveCount(0);
  });

  test('A04-T2-04: Non-admin user blocked from creating/closing restricted Forum Topics (403)', async ({
    request,
  }) => {
    const owner = await registerUserViaApi(request);
    const conv = await createRealConversationFixture(request, owner.token, {
      includeGroup: true,
      isForumGroup: true,
      groupTitle: 'Restricted Forum',
    });

    // 1. Prove Topics endpoint is live for admin owner
    const ownerTopicRes = await request.post(
      apiUrl(`${API_PATHS.chats}/${conv.groupChatId}/topics`),
      {
        headers: authHeaders(owner.token),
        data: { title: 'Admin Release Topic' },
      },
    );
    expect([200, 201]).toContain(ownerTopicRes.status());
    const ownerTopicBody = (await ownerTopicRes.json()) as {
      topic_id?: number;
      id?: number;
      topic?: { id?: number; topic_id?: number };
    };
    const topicId = Number(
      ownerTopicBody.topic_id ??
        ownerTopicBody.id ??
        ownerTopicBody.topic?.topic_id ??
        ownerTopicBody.topic?.id,
    );
    expect(topicId).toBeGreaterThan(0);

    // 2. Non-admin peer creating topic MUST get strictly 403 (NOT 404)
    const createTopicRes = await request.post(
      apiUrl(`${API_PATHS.chats}/${conv.groupChatId}/topics`),
      {
        headers: authHeaders(conv.peer.token),
        data: { title: 'Unauthorized Member Topic' },
        failOnStatusCode: false,
      },
    );
    expect(createTopicRes.status()).toBe(403);

    // 3. Non-admin peer closing owner's topic MUST get strictly 403
    const closeTopicRes = await request.patch(
      apiUrl(`${API_PATHS.chats}/${conv.groupChatId}/topics/${topicId}`),
      {
        headers: authHeaders(conv.peer.token),
        data: { closed: true },
        failOnStatusCode: false,
      },
    );
    expect(closeTopicRes.status()).toBe(403);
  });

  test('A04-T2-05: Deleting the currently selected chat transitions cleanly to empty stage without selecting arbitrary peer', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.dmTitle);

    const row = page
      .locator(DOM.chatList)
      .locator(DOM.chatRow)
      .filter({ hasText: conv.dmTitle })
      .first();
    await openContextMenuAndClick(page, row, BILINGUAL_PATTERNS.delete);

    const confirmDialog = page.locator('[role="dialog"]').first();
    await expect(confirmDialog).toBeVisible();
    await confirmDialog
      .getByRole('button', { name: BILINGUAL_PATTERNS.delete })
      .or(confirmDialog.getByRole('button', { name: BILINGUAL_PATTERNS.confirm }))
      .first()
      .click();

    await expect(page.locator(DOM.chatList).locator(DOM.chatRow)).toHaveCount(0);
    await expect(page.locator(DOM.messageComposerInput)).toBeHidden();
  });

  test('A04-T2-06: Escape clears global & in-chat search and restores real chat list without race corruption under rapid typing', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token);
    await page.reload({ waitUntil: 'domcontentloaded' });

    const searchInput = page.locator(DOM.globalSearchInput);
    for (const term of ['z', 'zz', 'zzz_no_match_ever']) {
      await searchInput.fill(term);
    }
    await searchInput.press('Escape');
    await expect(page.locator(DOM.chatList)).toContainText(conv.dmTitle);

    // Also verify Escape clears/closes in-chat search cleanly
    await selectChat(page, conv.dmTitle);
    await page.locator(DOM.btnInChatSearch).click();
    const inChatInput = page.locator(DOM.inChatSearchInput);
    await expect(inChatInput).toBeVisible();
    await inChatInput.fill('rapid_in_chat_needle');
    await inChatInput.press('Escape');
    await expect(inChatInput).toBeHidden();
  });
});
