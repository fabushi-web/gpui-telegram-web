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
  openContextMenuAndClick,
  openRightInspector,
  scopedButton,
  selectChat,
} from '../helpers/ui';
import {
  createCorruptImageFilePayload,
  createPdfFilePayload,
  createPngFilePayload,
} from '../helpers/media';

test.describe('Tier 2 — A06: Media Error Honesty, Zero Synthetic WAV/Doc Fallbacks, Poll/Todo Limits & Payment Gating', () => {
  test('A06-T2-01: Explicit getUserMedia NotAllowedError rejection displays truthful microphone error and MUST NOT silently synthesize fake 440Hz WAV note', async ({
    page,
    request,
  }) => {
    await clearClientState(page);
    const user = await registerUserViaApi(request);
    const conv = await createRealConversationFixture(request, user.token);

    // Explicitly reject getUserMedia with NotAllowedError before page boot
    await page.addInitScript(() => {
      const rejectMic = () =>
        Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: rejectMic,
          enumerateDevices: () => Promise.resolve([]),
        },
      });
    });

    await page.goto(`${getBaseUrl()}/`, { waitUntil: 'domcontentloaded' });
    await loginWithPassword(page, user.username, user.password);
    await selectChat(page, conv.dmTitle);

    const beforeCount = await page.locator(DOM.messageList).locator(DOM.messageBubble).count();
    await page.locator(DOM.btnRecordVoice).click();
    await page.waitForTimeout(800);

    // Truthful permission error surfaced; zero fake audio message bubble synthesized
    const afterCount = await page.locator(DOM.messageList).locator(DOM.messageBubble).count();
    expect(afterCount).toBe(beforeCount);
    const errorToast = page
      .locator(`${DOM.windowToastBanner}, ${DOM.stageToastPill}, [role="alert"]`)
      .first();
    await expect(errorToast).toBeVisible();
    await expect(errorToast).toContainText(/microphone|permission|denied|录音|麦克风|权限|失败/i);
  });

  test('A06-T2-02: Corrupted non-image bytes uploaded as photo degrade safely without crash; cancelling #modal-media-editor leaves timeline untouched', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.dmTitle);

    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    const beforeCount = await page.locator(DOM.messageList).locator(DOM.messageBubble).count();
    await page.locator(DOM.fileUploadInput).setInputFiles(createPngFilePayload('cancel-me.png'));
    const editor = page.locator(DOM.modalMediaEditor);
    await expect(editor).toBeVisible();
    await scopedButton(editor, BILINGUAL_PATTERNS.cancel).first().click();
    await expect(editor).toBeHidden();
    expect(await page.locator(DOM.messageList).locator(DOM.messageBubble).count()).toBe(beforeCount);

    // Corrupt image bytes must not cause uncaught pageerror crash
    await page.locator(DOM.fileUploadInput).setInputFiles(createCorruptImageFilePayload());
    await page.waitForTimeout(500);
    expect(pageErrors).toEqual([]);
  });

  test('A06-T2-03: Failed shared document download (404/500) surfaces real error and MUST NOT fabricate "Shared document: ..." text download', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.dmTitle);

    // 1. Upload a real PDF document into the chat first
    const pdfPayload = createPdfFilePayload('failing-download-doc.pdf', 'Download Failure Audit');
    const [uploadRes] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes('/api/v1/media') && res.request().method() === 'POST',
      ),
      page.locator(DOM.fileUploadInput).setInputFiles(pdfPayload),
    ]);
    expect([200, 201]).toContain(uploadRes.status());

    const pdfBubble = page
      .locator(DOM.messageList)
      .locator(DOM.messageBubble)
      .filter({ hasText: /failing-download-doc\.pdf/i })
      .last();
    await expect(pdfBubble).toBeVisible();

    // 2. Intercept ALL GET /api/v1/media/** requests with 404 & observe any download events
    let interceptedMediaGets = 0;
    let downloadEvents = 0;
    const downloadedPayloads: string[] = [];
    const downloadTasks: Promise<void>[] = [];
    page.on('download', (dl) => {
      downloadEvents += 1;
      downloadTasks.push(
        (async () => {
          const stream = await dl.createReadStream();
          if (stream) {
            const chunks: Buffer[] = [];
            for await (const c of stream) {
              chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
            }
            downloadedPayloads.push(Buffer.concat(chunks).toString('utf8'));
          }
        })(),
      );
    });

    await page.route('**/api/v1/media/**', (route) => {
      if (route.request().method() === 'GET') {
        interceptedMediaGets += 1;
        return route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'media_not_found' }),
        });
      }
      return route.continue();
    });

    // 3. Trigger UI download from Shared Files tab
    const rightCol = await openRightInspector(page);
    await rightCol.locator(DOM.rightTabFiles).click();
    const sharedFileTrigger = rightCol
      .locator('a, button')
      .filter({ hasText: /failing-download-doc\.pdf|download|下载/i })
      .first();
    await expect(sharedFileTrigger).toBeVisible();
    await sharedFileTrigger.click();

    // 4. Prove browser attempted real GET /api/v1/media/**, surfaced honest error, and NEVER synthesized "Shared document:"
    await expect
      .poll(() => interceptedMediaGets, {
        timeout: 6_000,
        message: 'Expected UI document download to issue GET /api/v1/media/**',
      })
      .toBeGreaterThanOrEqual(1);

    const errorBanner = page
      .locator(`${DOM.windowToastBanner}, ${DOM.stageToastPill}, [role="alert"]`)
      .first();
    await expect(errorBanner).toBeVisible({ timeout: 5_000 });
    await expect(errorBanner).toContainText(/download|failed|not\s*found|error|下载|失败|错误/i);
    await page.waitForTimeout(300);
    await Promise.all(downloadTasks);
    expect(downloadEvents).toBe(0);
    expect(downloadedPayloads).toHaveLength(0);
    expect(downloadedPayloads.join('\n')).not.toContain('Shared document:');

    // 5. Direct API 404 check
    const missingRes = await request.get(apiUrl(`${API_PATHS.media}/nonexistent_file_id_999`), {
      headers: authHeaders(user.token),
      failOnStatusCode: false,
    });
    expect(missingRes.status()).toBe(404);
    expect(await missingRes.text()).not.toContain('Shared document:');
  });

  test('A06-T2-04: Poll blocks empty question / < 2 options; closed poll rejects votes & retract', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token, {
      includeGroup: true,
      groupTitle: 'Poll Validation Room',
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.groupTitle ?? 'Poll Validation Room');

    await page.locator(DOM.btnAttachMenu).click();
    const pollTrigger = page
      .getByRole('menuitem', { name: BILINGUAL_PATTERNS.poll })
      .or(page.getByRole('button', { name: BILINGUAL_PATTERNS.poll }))
      .first();
    await pollTrigger.click();

    const pollModal = page.locator(DOM.modalCreatePoll);
    await expect(pollModal).toBeVisible();

    // 1. Only fill question and 1 option -> submit must remain disabled or keep modal open
    const inputs = pollModal.locator('input[type="text"], textarea');
    await inputs.nth(0).fill('Incomplete poll');
    await inputs.nth(1).fill('Single Option Only');

    const submitBtn = scopedButton(pollModal, BILINGUAL_PATTERNS.confirm)
      .or(scopedButton(pollModal, BILINGUAL_PATTERNS.create))
      .first();
    if (await submitBtn.isEnabled()) {
      await submitBtn.click();
      await expect(pollModal).toBeVisible();
    } else {
      await expect(submitBtn).toBeDisabled();
    }

    // 2. Complete 2nd option, create poll, vote, close poll, and prove closed poll rejects votes & retract
    await inputs.nth(2).fill('Option Two');
    await expect(submitBtn).toBeEnabled();
    await submitBtn.click();
    await expect(pollModal).toBeHidden();

    const pollBubble = page
      .locator(DOM.messageList)
      .locator(DOM.messageBubble)
      .filter({ hasText: 'Incomplete poll' })
      .last();
    await expect(pollBubble).toBeVisible();

    await pollBubble.getByText('Single Option Only').first().click();
    await expect(pollBubble).toContainText(/100%|1\s*vote|1\s*票/i);

    await openContextMenuAndClick(page, pollBubble, BILINGUAL_PATTERNS.stopPoll);
    await expect(pollBubble).toContainText(/closed|final\s*results|已结束|最终结果/i);

    // Retract button must be absent or disabled on closed poll
    const retractBtn = scopedButton(pollBubble, BILINGUAL_PATTERNS.retractVote).first();
    if ((await retractBtn.count()) > 0) {
      await expect(retractBtn).toBeDisabled();
    } else {
      await expect(retractBtn).toHaveCount(0);
    }

    // Clicking Option Two on closed poll must NOT mutate vote tally
    await pollBubble.getByText('Option Two').first().click();
    await expect(pollBubble).toContainText(/100%|1\s*vote|1\s*票/i);
  });

  test('A06-T2-05: Todo checklist blocks blank item and #lightbox-viewer zoom clamps cleanly', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token, {
      includeGroup: true,
      groupTitle: 'Todo Validation Room',
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.groupTitle ?? 'Todo Validation Room');

    await page.locator(DOM.btnAttachMenu).click();
    const todoTrigger = page
      .getByRole('menuitem', { name: BILINGUAL_PATTERNS.todo })
      .or(page.getByRole('button', { name: BILINGUAL_PATTERNS.todo }))
      .first();
    await todoTrigger.click();

    const todoModal = page.locator(DOM.modalCreateTodo);
    await expect(todoModal).toBeVisible();
    const submitBtn = scopedButton(todoModal, BILINGUAL_PATTERNS.confirm)
      .or(scopedButton(todoModal, BILINGUAL_PATTERNS.create))
      .first();
    if (await submitBtn.isEnabled()) {
      await submitBtn.click();
      await expect(todoModal).toBeVisible();
    } else {
      await expect(submitBtn).toBeDisabled();
    }

    await scopedButton(todoModal, BILINGUAL_PATTERNS.cancel)
      .or(scopedButton(todoModal, bilingualRegex('close', '关闭')))
      .first()
      .click();
    await expect(todoModal).toBeHidden();

    // Upload image and verify #lightbox-viewer zoom clamps cleanly within bounded scale
    await page.locator(DOM.fileUploadInput).setInputFiles(createPngFilePayload('zoom-clamp.png'));
    const editor = page.locator(DOM.modalMediaEditor);
    await expect(editor).toBeVisible();
    await scopedButton(editor, BILINGUAL_PATTERNS.send)
      .or(scopedButton(editor, BILINGUAL_PATTERNS.confirm))
      .first()
      .click();
    await expect(editor).toBeHidden();

    const photoImg = page.locator(`${DOM.messageList} ${DOM.messageBubble} img`).last();
    await expect(photoImg).toBeVisible();
    await photoImg.click();

    const lightbox = page.locator(DOM.lightboxViewer);
    await expect(lightbox).toBeVisible();
    for (let i = 0; i < 8; i++) {
      await page.locator(DOM.lightboxZoomIn).click();
    }
    const scale = await lightbox.locator('img').first().evaluate((el) => {
      const transform = getComputedStyle(el).transform;
      if (!transform || transform === 'none') return 1;
      const m = transform.match(/matrix\(([^)]+)\)/);
      if (!m) return NaN;
      const parts = m[1].split(',').map((v) => Number(v.trim()));
      return Math.hypot(parts[0], parts[1]);
    });
    expect(Number.isFinite(scale)).toBe(true);
    expect(scale).toBeGreaterThan(1);
    expect(scale).toBeLessThanOrEqual(5);

    await page.locator(DOM.lightboxClose).click();
    await expect(lightbox).toBeHidden();
  });

  test('A06-T2-06: Unverified POST /api/v1/wallet/topup, /wallet/stars/topup, and /api/v1/fabushi-miniapp/membership rejected without verified payment/redeem', async ({
    request,
  }) => {
    const user = await registerUserViaApi(request);
    const headers = authHeaders(user.token);

    for (const path of [API_PATHS.walletTopup, API_PATHS.walletStarsTopup]) {
      const res = await request.post(apiUrl(path), {
        headers,
        data: { amount: 1000, currency: 'XTR' },
        failOnStatusCode: false,
      });
      expect([400, 402, 403]).toContain(res.status());
    }

    const vipRes = await request.post(apiUrl(API_PATHS.fabushiMiniAppMembership), {
      headers,
      data: { tier: 'vip', plan: 'annual' },
      failOnStatusCode: false,
    });
    expect([400, 402, 403]).toContain(vipRes.status());

    // Balance remains strictly 0 (explicit numeric type check without ?? 0 default)
    const walletRes = await request.get(apiUrl(API_PATHS.wallet), { headers });
    expect(walletRes.status()).toBe(200);
    const walletBody = (await walletRes.json()) as {
      stars?: unknown;
      stars_balance?: unknown;
    };
    const stars = walletBody.stars ?? walletBody.stars_balance;
    expect(typeof stars).toBe('number');
    expect(stars).toBe(0);
  });
});
