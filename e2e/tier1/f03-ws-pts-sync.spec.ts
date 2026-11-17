import type { Locator, Page } from '@playwright/test';
import {
  API_PATHS,
  BILINGUAL_PATTERNS,
  BROADCAST_CHANNEL_NAME,
  chatRowById,
  clearClientState,
  DATA_ATTRS,
  DOM,
  expect,
  getBaseUrl,
  loginViaDemo,
  openBurgerMenu,
  scopedButton,
  scopedTextbox,
  selectChat,
  sendTextMessage,
  test,
} from '../helpers';

interface SyncDifferenceResult {
  status: number;
  pts: number | null;
  hasItemsArray: boolean;
  payload: unknown;
}

const OUTGOING_DELIVERY_STATUS_SELECTOR = [
  '[data-status="sent"]',
  '[data-status="delivered"]',
  '[data-status="read"]',
  '[data-testid*="check" i]',
  '[data-testid*="status" i]:not([data-status="pending"]):not([data-status="sending"])',
  '[class*="check" i]',
  '[class*="receipt" i]',
  '[aria-label*="sent" i]:not([aria-label*="unsent" i])',
  '[aria-label*="delivered" i]',
  '[aria-label*="read" i]:not([aria-label*="unread" i])',
  '[aria-label*="已发送"]',
  '[aria-label*="已送达"]',
  '[aria-label*="已读"]',
].join(', ');

async function selectWritableChat(
  page: Page,
  excludeChatIds: ReadonlySet<string> = new Set(),
): Promise<{ row: Locator; chatId: string; title: string }> {
  const chatList = page.locator(DOM.chatList);
  if (!(await chatList.isVisible())) {
    const backBtn = page.locator(DOM.btnBackToChats);
    if (await backBtn.isVisible()) {
      await backBtn.click();
    }
  }
  await expect(chatList).toBeVisible();

  const rows = chatList.locator(DOM.chatRow);
  await expect(rows.first()).toBeVisible();
  const total = await rows.count();

  for (let i = 0; i < total; i++) {
    const candidate = rows.nth(i);
    const id = (await candidate.getAttribute(DATA_ATTRS.chatId)) ?? '';
    if (!id || excludeChatIds.has(id)) {
      continue;
    }
    const row = await selectChat(page, id);
    const composer = page.locator(DOM.messageComposerInput);
    if ((await composer.isVisible()) && (await composer.isEditable())) {
      const title =
        ((await page.locator(DOM.chatHeaderTitle).textContent()) ?? '').trim();
      return { row, chatId: id, title };
    }
  }

  throw new Error(
    'Expected at least one writable chat with #message-composer-input in #chat-list',
  );
}

function collectPtsNumbersFromJson(raw: string): number[] {
  const found: number[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return found;
  }

  const visit = (node: unknown, depth: number): void => {
    if (depth > 5 || node === null || typeof node !== 'object') {
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item, depth + 1);
      }
      return;
    }
    const obj = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      if (
        /^(?:pts|currentPts|newPts|maxPts|chatPts)$/i.test(k) &&
        typeof v === 'number' &&
        Number.isFinite(v)
      ) {
        found.push(v);
      } else if (v !== null && typeof v === 'object') {
        visit(v, depth + 1);
      }
    }
  };

  visit(parsed, 0);
  return found;
}

async function fetchSyncDifference(
  page: Page,
  pts: number,
  chatId: string,
): Promise<SyncDifferenceResult> {
  return page.evaluate(
    async (args: {
      endpoint: string;
      ptsVal: number;
      targetChatId: string;
    }) => {
      const discoverBearerToken = (): string | null => {
        const tokenKeyRe =
          /^(?:token|accessToken|sessionToken|authToken|jwt|bearer)$/i;
        const scanObject = (val: unknown, depth: number): string | null => {
          if (depth > 4 || val === null || typeof val !== 'object') {
            return null;
          }
          const rec = val as Record<string, unknown>;
          for (const [k, v] of Object.entries(rec)) {
            if (tokenKeyRe.test(k) && typeof v === 'string' && v.length >= 8) {
              return v;
            }
          }
          for (const v of Object.values(rec)) {
            if (v !== null && typeof v === 'object') {
              const nested = scanObject(v, depth + 1);
              if (nested) return nested;
            }
          }
          return null;
        };

        for (const storage of [window.localStorage, window.sessionStorage]) {
          for (let i = 0; i < storage.length; i++) {
            const key = storage.key(i);
            if (!key) continue;
            const rawVal = storage.getItem(key);
            if (!rawVal) continue;
            if (tokenKeyRe.test(key) && !rawVal.startsWith('{')) {
              return rawVal;
            }
            try {
              const parsed: unknown = JSON.parse(rawVal);
              const hit = scanObject(parsed, 0);
              if (hit) return hit;
            } catch {
              // Ignore non-JSON storage entries
            }
          }
        }
        return null;
      };

      const headers: Record<string, string> = {
        Accept: 'application/json',
      };
      const token = discoverBearerToken();
      if (token) {
        headers.Authorization = token.startsWith('Bearer ')
          ? token
          : `Bearer ${token}`;
      }

      const qs = new URLSearchParams({
        pts: String(args.ptsVal),
        chatId: args.targetChatId,
        chat_id: args.targetChatId,
      }).toString();

      let resp = await fetch(`${args.endpoint}?${qs}`, {
        method: 'GET',
        headers,
        credentials: 'include',
      });

      if (resp.status === 400 || resp.status === 404 || resp.status === 405) {
        resp = await fetch(args.endpoint, {
          method: 'POST',
          headers: {
            ...headers,
            'Content-Type': 'application/json',
          },
          credentials: 'include',
          body: JSON.stringify({
            pts: args.ptsVal,
            chatId: args.targetChatId,
            chat_id: args.targetChatId,
          }),
        });
      }

      const body: unknown = await resp.json().catch(() => null);
      let extractedPts: number | null = null;
      let hasItemsArray = false;

      const inspectRecord = (rec: Record<string, unknown>): void => {
        for (const pKey of ['pts', 'currentPts', 'newPts', 'maxPts']) {
          const val = rec[pKey];
          if (typeof val === 'number' && Number.isFinite(val)) {
            extractedPts =
              extractedPts === null ? val : Math.max(extractedPts, val);
          }
        }
        if (rec.state && typeof rec.state === 'object') {
          inspectRecord(rec.state as Record<string, unknown>);
        }
        if (rec.data && typeof rec.data === 'object') {
          inspectRecord(rec.data as Record<string, unknown>);
        }
        for (const arrKey of [
          'updates',
          'messages',
          'newMessages',
          'items',
          'events',
          'difference',
        ]) {
          const arr = rec[arrKey];
          if (Array.isArray(arr)) {
            hasItemsArray = true;
            for (const elem of arr) {
              if (elem && typeof elem === 'object') {
                const ePts = (elem as Record<string, unknown>).pts;
                if (typeof ePts === 'number' && Number.isFinite(ePts)) {
                  extractedPts =
                    extractedPts === null ? ePts : Math.max(extractedPts, ePts);
                }
              }
            }
          }
        }
      };

      if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
        inspectRecord(body as Record<string, unknown>);
      }

      return {
        status: resp.status,
        pts: extractedPts,
        hasItemsArray,
        payload: body,
      };
    },
    {
      endpoint: API_PATHS.syncGetDifference,
      ptsVal: pts,
      targetChatId: chatId,
    },
  );
}

test.describe('F3 — Real-Time WebSocket (/api/v1/ws), Monotonic PTS Sync & Multi-Tab Sync', () => {
  test('F3-01: GET /api/v1/health 200 OK JSON and live /api/v1/ws WebSocket session without offline banner', async ({
    page,
    request,
  }) => {
    const healthRes = await request.get(`${getBaseUrl()}${API_PATHS.health}`);
    expect(healthRes.status()).toBe(200);
    const healthBody: unknown = await healthRes.json();
    expect(healthBody).not.toBeNull();
    expect(typeof healthBody).toBe('object');
    const healthObj = healthBody as { ok?: unknown; version?: unknown };
    expect(healthObj.ok).toBe(true);
    expect(typeof healthObj.version).toBe('string');
    expect((healthObj.version as string).length).toBeGreaterThan(0);

    const wsConnections: Array<{
      url: string;
      closed: boolean;
      framesRx: number;
      framesTx: number;
    }> = [];

    page.on('websocket', (ws) => {
      if (ws.url().includes(API_PATHS.ws)) {
        const entry = {
          url: ws.url(),
          closed: ws.isClosed(),
          framesRx: 0,
          framesTx: 0,
        };
        ws.on('framereceived', () => {
          entry.framesRx++;
        });
        ws.on('framesent', () => {
          entry.framesTx++;
        });
        ws.on('close', () => {
          entry.closed = true;
        });
        wsConnections.push(entry);
      }
    });

    await clearClientState(page);
    await page.goto(`${getBaseUrl()}/`, { waitUntil: 'domcontentloaded' });
    await loginViaDemo(page);

    await expect
      .poll(() => wsConnections.some((conn) => !conn.closed), {
        message: 'Expected an active /api/v1/ws WebSocket connection after login',
        timeout: 8_000,
      })
      .toBe(true);

    const statusBanner = page.locator(DOM.connectionStatusBanner);
    const visibleBannerText = (await statusBanner.isVisible())
      ? (await statusBanner.innerText()).trim()
      : '';
    expect(visibleBannerText).not.toMatch(
      /offline|disconnected|reconnecting|connection\s*lost|离线|断开|重连/i,
    );
  });

  test('F3-02: Real-time message delivery over /api/v1/ws, monotonic pts progression, and delivery checkmarks', async ({
    page,
  }) => {
    const wsPtsObserved: number[] = [];

    page.on('websocket', (ws) => {
      if (!ws.url().includes(API_PATHS.ws)) {
        return;
      }
      ws.on('framereceived', (frame) => {
        if (typeof frame.payload === 'string') {
          wsPtsObserved.push(...collectPtsNumbersFromJson(frame.payload));
        }
      });
    });

    await clearClientState(page);
    await page.goto(`${getBaseUrl()}/`, { waitUntil: 'domcontentloaded' });
    await loginViaDemo(page);

    const { chatId } = await selectWritableChat(page);

    const b1 = await sendTextMessage(page, 'PTS monotonic msg 1');
    const diffAfter1 = await fetchSyncDifference(page, 0, chatId);

    const b2 = await sendTextMessage(page, 'PTS monotonic msg 2');
    const diffAfter2 = await fetchSyncDifference(page, 0, chatId);

    const b1PtsAttr = Number((await b1.getAttribute('data-pts')) ?? 'NaN');
    const b2PtsAttr = Number((await b2.getAttribute('data-pts')) ?? 'NaN');

    let pts1: number | null = Number.isFinite(b1PtsAttr)
      ? b1PtsAttr
      : diffAfter1.pts;
    let pts2: number | null = Number.isFinite(b2PtsAttr)
      ? b2PtsAttr
      : diffAfter2.pts;

    if ((pts1 === null || pts2 === null) && wsPtsObserved.length >= 2) {
      pts1 = wsPtsObserved[wsPtsObserved.length - 2] ?? null;
      pts2 = wsPtsObserved[wsPtsObserved.length - 1] ?? null;
    }

    expect(pts1).not.toBeNull();
    expect(pts2).not.toBeNull();
    expect(pts1!).toBeGreaterThanOrEqual(1);
    expect(pts2!).toBeGreaterThan(pts1!);

    // Verify outgoing delivery/read checkmark indicator (not stuck on pending clock 🕒)
    await expect(b2).not.toContainText('🕒');
    await expect
      .poll(
        async () => {
          const text = await b2.innerText();
          if (/✓|✔/.test(text)) {
            return true;
          }
          const statusElCount = await b2
            .locator(OUTGOING_DELIVERY_STATUS_SELECTOR)
            .count();
          return statusElCount > 0;
        },
        {
          message:
            'Expected outgoing bubble to display ✓ / ✓✓ or delivered/read status indicator',
        },
      )
      .toBe(true);
  });

  test('F3-03: /api/v1/sync/get_difference per-chat + global sync endpoint consistency and gap recovery', async ({
    authPage: page,
  }) => {
    const { chatId } = await selectWritableChat(page);

    const diffBefore = await fetchSyncDifference(page, 0, chatId);
    expect(diffBefore.status).toBe(200);
    expect(diffBefore.pts).not.toBeNull();
    expect(diffBefore.pts!).toBeGreaterThanOrEqual(0);
    expect(diffBefore.hasItemsArray).toBe(true);

    const ptsBefore = diffBefore.pts!;
    const gapMsg = `Gap sync probe ${Date.now()}`;
    await sendTextMessage(page, gapMsg);

    const diffAfter = await fetchSyncDifference(page, ptsBefore, chatId);
    expect(diffAfter.status).toBe(200);
    expect(diffAfter.pts).not.toBeNull();
    expect(diffAfter.pts!).toBeGreaterThan(ptsBefore);
    expect(diffAfter.hasItemsArray).toBe(true);
    expect(JSON.stringify(diffAfter.payload)).toContain(gapMsg);
  });

  test('F3-04: Live typing/recording indicator surfaced in #chat-header-status and #chat-list', async ({
    authPage: pageA,
    browser,
  }) => {
    const ctxB = await browser.newContext();
    try {
      const pageB = await ctxB.newPage();
      await pageB.goto(`${getBaseUrl()}/`, { waitUntil: 'domcontentloaded' });

      // Register User B in isolated BrowserContext
      await expect(pageB.locator(DOM.authScreen)).toBeVisible();
      await pageB.locator(DOM.tabAuthPassword).click();

      const submitBtnB = pageB.locator(DOM.btnAuthPasswordSubmit);
      const toggleBtnB = pageB.locator(DOM.authModeRegisterToggle);
      await expect(submitBtnB).toBeVisible();
      await expect(toggleBtnB).toBeVisible();
      const labelB = `${(await submitBtnB.innerText()).trim()} ${(await submitBtnB.getAttribute('aria-label')) ?? ''}`;
      const toggleLabelB = `${(await toggleBtnB.innerText()).trim()} ${(await toggleBtnB.getAttribute('aria-label')) ?? ''}`;
      const ariaCheckedB = await toggleBtnB.getAttribute('aria-checked');
      const ariaPressedB = await toggleBtnB.getAttribute('aria-pressed');
      const isRegisterB =
        /register|sign\s*up|create\s*account|注册|创建账号/i.test(labelB) ||
        ariaCheckedB === 'true' ||
        ariaPressedB === 'true' ||
        /already|back\s*to\s*login|sign\s*in|已有账号|返回登录|去登录/i.test(
          toggleLabelB,
        );
      if (!isRegisterB) {
        await toggleBtnB.click();
      }
      await pageB.locator(DOM.authUsernameInput).fill('typing_peer_b');
      await pageB.locator(DOM.authPasswordInput).fill('PeerPass!2026');
      const extraPwdB = pageB
        .locator(DOM.authScreen)
        .locator('input[type="password"]:visible');
      for (let i = 1; i < (await extraPwdB.count()); i++) {
        await extraPwdB.nth(i).fill('PeerPass!2026');
      }
      await submitBtnB.click();
      await expect(pageB.locator(DOM.appShell)).toBeVisible();
      await expect(pageB.locator(DOM.chatList)).toBeVisible();

      // Collect writable chat IDs on pageA and pageB to find or create a shared room
      const collectIds = async (p: Page): Promise<string[]> => {
        const r = p.locator(`${DOM.chatList} ${DOM.chatRow}`);
        const n = await r.count();
        const ids: string[] = [];
        for (let i = 0; i < n; i++) {
          const id = await r.nth(i).getAttribute(DATA_ATTRS.chatId);
          if (id) ids.push(id);
        }
        return ids;
      };

      const idsA = await collectIds(pageA);
      const idsBSet = new Set(await collectIds(pageB));
      let sharedChatId: string | null = null;

      for (const candidateId of idsA) {
        if (!idsBSet.has(candidateId)) continue;
        await selectChat(pageA, candidateId);
        const headerTitleA = (
          (await pageA.locator(DOM.chatHeaderTitle).textContent()) ?? ''
        ).trim();
        if (BILINGUAL_PATTERNS.savedMessages.test(headerTitleA)) {
          continue;
        }
        await selectChat(pageB, candidateId);
        if (
          (await pageA.locator(DOM.messageComposerInput).isVisible()) &&
          (await pageB.locator(DOM.messageComposerInput).isVisible())
        ) {
          sharedChatId = candidateId;
          break;
        }
      }

      if (!sharedChatId) {
        // Create a shared group from pageA inviting typing_peer_b (supporting 1-step and 2-step Next -> Create modals)
        await openBurgerMenu(pageA);
        await pageA.locator(DOM.menuItemNewGroup).click();
        const groupModal = pageA.locator(DOM.modalCreateGroup);
        await expect(groupModal).toBeVisible();

        const memberSearchSelector =
          'input[type="search"]:visible, input[placeholder*="search" i]:visible, input[placeholder*="搜索"]:visible, input[placeholder*="member" i]:visible, input[placeholder*="成员"]:visible';
        const nonSearchTitleSelector =
          'input[type="text"]:visible:not([placeholder*="search" i]):not([placeholder*="搜索"]):not([placeholder*="member" i]):not([placeholder*="成员"])';

        let filledTitle = false;
        let selectedPeerB = false;

        const applyModalStepFields = async (): Promise<void> => {
          const memberSearch = groupModal.locator(memberSearchSelector).first();
          if (
            !selectedPeerB &&
            (await memberSearch.count()) > 0 &&
            (await memberSearch.isVisible())
          ) {
            await memberSearch.fill('typing_peer_b');
            await pageA.waitForTimeout(250);
          }

          const peerOption = groupModal
            .locator(
              '[role="option"], [role="checkbox"], [data-user-id], [data-peer-id], label, li, button',
            )
            .filter({ hasText: /typing_peer_b/i })
            .first();
          if (
            !selectedPeerB &&
            (await peerOption.count()) > 0 &&
            (await peerOption.isVisible())
          ) {
            await peerOption.click();
            selectedPeerB = true;
          }

          const titleInput = scopedTextbox(
            groupModal,
            /group\s*name|chat\s*name|name|title|群名称|群聊名称|群名|名称|标题/i,
          )
            .or(groupModal.locator(nonSearchTitleSelector).first())
            .first();
          if (
            !filledTitle &&
            (await titleInput.count()) > 0 &&
            (await titleInput.isVisible())
          ) {
            await titleInput.fill('E2E Typing Sync Room');
            filledTitle = true;
          }
        };

        await applyModalStepFields();

        const nextStepBtn = scopedButton(
          groupModal,
          /^(?:next|continue|下一步|继续)$/i,
        ).first();
        if (
          (!filledTitle || !selectedPeerB) &&
          (await nextStepBtn.count()) > 0 &&
          (await nextStepBtn.isVisible())
        ) {
          await nextStepBtn.click();
          await pageA.waitForTimeout(200);
          await applyModalStepFields();
        }

        const createBtn = scopedButton(groupModal, BILINGUAL_PATTERNS.create)
          .or(scopedButton(groupModal, BILINGUAL_PATTERNS.confirm))
          .first();
        await expect(createBtn).toBeVisible();
        await createBtn.click();
        await expect(groupModal).toBeHidden();

        const newRowA = pageA
          .locator(`${DOM.chatList} ${DOM.chatRow}`)
          .filter({ hasText: 'E2E Typing Sync Room' })
          .first();
        await expect(newRowA).toBeVisible();
        sharedChatId = await newRowA.getAttribute(DATA_ATTRS.chatId);

        if (sharedChatId) {
          const rowOnBLive = pageB.locator(
            `${DOM.chatList} ${chatRowById(sharedChatId)}`,
          );
          if ((await rowOnBLive.count()) === 0) {
            await pageB.reload({ waitUntil: 'domcontentloaded' });
            await expect(pageB.locator(DOM.chatList)).toBeVisible();
          }
          if ((await rowOnBLive.count()) > 0) {
            await selectChat(pageB, sharedChatId);
          } else {
            // Public group global search lookup fallback on pageB
            const globalSearchB = pageB.locator(DOM.globalSearchInput);
            await globalSearchB.fill('E2E Typing Sync Room');
            await pageB.waitForTimeout(300);
            const searchHitB = pageB
              .locator(DOM.leftColumn)
              .locator(
                '[role="option"], [role="listitem"], [data-testid="chat-row"], button, li, a',
              )
              .filter({ hasText: 'E2E Typing Sync Room' })
              .first();
            if (
              (await searchHitB.count()) > 0 &&
              (await searchHitB.isVisible())
            ) {
              await searchHitB.click();
              const joinBtnB = scopedButton(
                pageB.locator(DOM.middleColumn),
                /join|加入/i,
              ).first();
              if (
                (await joinBtnB.count()) > 0 &&
                (await joinBtnB.isVisible())
              ) {
                await joinBtnB.click();
              }
            }
          }
        }
      }

      const sharedRoomFound =
        Boolean(sharedChatId) &&
        (await pageB.locator(DOM.messageComposerInput).isVisible());
      expect(sharedRoomFound).toBe(true);

      const typingRegex =
        /typing|recording|writing|composing|正在输入|输入中|正在录音/i;

      await selectChat(pageA, sharedChatId!);
      const composerB = pageB.locator(DOM.messageComposerInput);
      await composerB.focus();

      // Stream keystrokes slowly from User B while observing User A's header & chat row
      const typingPromise = composerB.pressSequentially(
        'Live typing indicator over WebSocket stream',
        { delay: 95 },
      );

      const headerStatusA = pageA.locator(DOM.chatHeaderStatus);
      const chatRowA = pageA
        .locator(DOM.chatList)
        .locator(chatRowById(sharedChatId!));

      await expect
        .poll(
          async () => {
            const statusText = (await headerStatusA.textContent()) ?? '';
            const statusAttr =
              (await headerStatusA.getAttribute('data-typing')) ?? '';
            const rowText = (await chatRowA.textContent()) ?? '';
            const rowTypingCount = await chatRowA
              .locator('[data-typing="true"], [data-testid*="typing" i]')
              .count();
            const headerShowsTyping =
              typingRegex.test(statusText) || statusAttr === 'true';
            const rowShowsTyping =
              typingRegex.test(rowText) || rowTypingCount > 0;
            return headerShowsTyping && rowShowsTyping;
          },
          {
            message:
              'Expected live typing indicator in both #chat-header-status and #chat-list row',
            timeout: 7_000,
          },
        )
        .toBe(true);

      await typingPromise;
    } finally {
      await ctxB.close();
    }
  });

  test('F3-05: BroadcastChannel("gpui-telegram-web-sync") live multi-tab synchronization via openSecondTab()', async ({
    authPage: tab1,
    openSecondTab,
  }) => {
    const { chatId } = await selectWritableChat(tab1);

    const tab2 = await openSecondTab();
    await expect(tab2.locator(DOM.appShell)).toBeVisible();
    await expect(tab2.locator(DOM.chatList)).toBeVisible();
    await selectChat(tab2, chatId);

    await tab2.evaluate((channelName: string) => {
      const win = window as unknown as {
        __bcEvents: unknown[];
        __tab2NoReload: boolean;
        __bcRef?: BroadcastChannel;
      };
      win.__bcEvents = [];
      win.__tab2NoReload = true;
      const bc = new BroadcastChannel(channelName);
      win.__bcRef = bc;
      bc.addEventListener('message', (ev: MessageEvent) => {
        win.__bcEvents.push(ev.data);
      });
    }, BROADCAST_CHANNEL_NAME);

    const syncText = `MultiTab Live Sync ${Date.now()}`;
    await sendTextMessage(tab1, syncText);

    // Verify tab2 receives live message bubble + chat list preview update WITHOUT reload
    await expect(
      tab2
        .locator(DOM.messageList)
        .locator(DOM.messageBubble)
        .filter({ hasText: syncText }),
    ).toBeVisible({ timeout: 8_000 });

    await expect(
      tab2.locator(DOM.chatList).locator(chatRowById(chatId)),
    ).toContainText(syncText);

    const tab2Probe = await tab2.evaluate(() => {
      const win = window as unknown as {
        __bcEvents?: unknown[];
        __tab2NoReload?: boolean;
      };
      return {
        bcCount: win.__bcEvents?.length ?? 0,
        noReload: win.__tab2NoReload === true,
      };
    });

    expect(tab2Probe.noReload).toBe(true);
    expect(tab2Probe.bcCount).toBeGreaterThan(0);
  });
});
