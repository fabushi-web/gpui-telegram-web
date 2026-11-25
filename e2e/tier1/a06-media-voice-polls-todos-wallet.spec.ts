import { test, expect } from '../helpers/fixtures';
import { API_PATHS, DOM } from '../helpers/selectors';
import {
  apiUrl,
  authHeaders,
  createRealConversationFixture,
} from '../helpers/server';
import {
  bilingualRegex,
  BILINGUAL_PATTERNS,
  openBurgerMenu,
  openContextMenuAndClick,
  scopedButton,
  selectChat,
} from '../helpers/ui';
import {
  createPdfFilePayload,
  createPngFilePayload,
} from '../helpers/media';

test.describe('Tier 1 — A06: Media Upload/Editor/Lightbox, Real-Device Voice Notes, Polls, Todos & Truthful Wallet', () => {
  test('A06-T1-01: Resumable CAS photo upload (HTTP 206) & #modal-media-editor (crop/rotate/spoiler/caption)', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.dmTitle);

    const pngFile = createPngFilePayload('architecture-v1611.png', {
      width: 96,
      height: 64,
      pattern: 'gradient',
    });
    await page.locator(DOM.fileUploadInput).setInputFiles(pngFile);

    const mediaEditor = page.locator(DOM.modalMediaEditor);
    await expect(mediaEditor).toBeVisible();

    const rotateBtn = scopedButton(mediaEditor, bilingualRegex('rotate', '旋转')).first();
    await expect(rotateBtn).toBeVisible();
    await rotateBtn.click();

    const captionInput = mediaEditor.locator('input[type="text"], textarea').first();
    await expect(captionInput).toBeVisible();
    await captionInput.fill('Edited photo caption v1.6.11');

    const sendMediaBtn = scopedButton(mediaEditor, BILINGUAL_PATTERNS.send)
      .or(scopedButton(mediaEditor, BILINGUAL_PATTERNS.confirm))
      .first();
    const [uploadRes] = await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes('/api/v1/media') &&
          res.request().method() === 'POST',
      ),
      sendMediaBtn.click(),
    ]);
    expect([200, 201]).toContain(uploadRes.status());
    const uploadBody = (await uploadRes.json()) as { url?: string; id?: string };
    const uploadedMediaUrl =
      uploadBody.url ?? (uploadBody.id ? `/api/v1/media/${uploadBody.id}` : '');
    expect(uploadedMediaUrl.length).toBeGreaterThan(0);

    await expect(mediaEditor).toBeHidden();

    const photoBubble = page
      .locator(DOM.messageList)
      .locator(DOM.messageBubble)
      .filter({ has: page.locator('img') })
      .last();
    await expect(photoBubble).toBeVisible();
    await expect(photoBubble).toContainText('Edited photo caption v1.6.11');

    const rangeRes = await request.get(apiUrl(uploadedMediaUrl), {
      headers: { ...authHeaders(user.token), Range: 'bytes=0-31' },
    });
    expect(rangeRes.status()).toBe(206);
    const buf = await rangeRes.body();
    expect(buf.length).toBe(32);
    expect([...buf.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  test('A06-T1-02: Multi-image Mosaic Media Album, Document/PDF upload & real download, and #lightbox-viewer', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.dmTitle);

    // 1. Multi-photo album upload & Lightbox interaction
    await page.locator(DOM.fileUploadInput).setInputFiles([
      createPngFilePayload('album-1.png', { r: 10, g: 132, b: 255 }),
      createPngFilePayload('album-2.png', { r: 0, g: 186, b: 105 }),
      createPngFilePayload('album-3.png', { r: 255, g: 159, b: 10 }),
    ]);

    const mediaEditor = page.locator(DOM.modalMediaEditor);
    await expect(mediaEditor).toBeVisible();
    await scopedButton(mediaEditor, BILINGUAL_PATTERNS.send)
      .or(scopedButton(mediaEditor, BILINGUAL_PATTERNS.confirm))
      .first()
      .click();
    await expect(mediaEditor).toBeHidden();

    await expect(page.locator(`${DOM.messageList} ${DOM.messageBubble} img`)).toHaveCount(3);
    const imgInTimeline = page.locator(`${DOM.messageList} ${DOM.messageBubble} img`).first();
    await expect(imgInTimeline).toBeVisible();
    await imgInTimeline.click();

    await expect(page.locator(DOM.lightboxViewer)).toBeVisible();
    await page.locator(DOM.lightboxZoomIn).click();
    await page.locator(DOM.lightboxRotate).click();
    await page.locator(DOM.lightboxNext).click();
    await page.locator(DOM.lightboxClose).click();
    await expect(page.locator(DOM.lightboxViewer)).toBeHidden();

    // 2. Real PDF upload & verified %PDF- download
    const pdfPayload = createPdfFilePayload('fabushi-spec-1611.pdf', 'Fabushi Web 1.6.11');
    const [pdfUploadRes] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes('/api/v1/media') && res.request().method() === 'POST',
      ),
      page.locator(DOM.fileUploadInput).setInputFiles(pdfPayload),
    ]);
    expect([200, 201]).toContain(pdfUploadRes.status());

    const pdfBubble = page
      .locator(DOM.messageList)
      .locator(DOM.messageBubble)
      .filter({ hasText: /fabushi-spec-1611\.pdf/i })
      .last();
    await expect(pdfBubble).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await pdfBubble.locator('a, button').first().click();
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    expect(stream).not.toBeNull();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const downloadedBytes = Buffer.concat(chunks);
    expect(downloadedBytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  test('A06-T1-03: Real Chromium fake media device Voice Note recording (#btn-record-voice), 100-bar waveform playback, 1x/1.5x/2x speed, and persistent #top-audio-player-bar', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token, {
      includeGroup: true,
      groupTitle: 'Audio Switch Target',
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.dmTitle);

    const recordBtn = page.locator(DOM.btnRecordVoice);
    await expect(recordBtn).toBeVisible();
    await recordBtn.click();
    await page.waitForTimeout(1200);

    // Finish recording and send voice note
    await page.locator(`${DOM.btnSendMessage}:visible, ${DOM.btnRecordVoice}:visible`).first().click();

    const voiceBubble = page
      .locator(DOM.messageList)
      .locator(DOM.messageBubble)
      .filter({ has: page.locator('audio, canvas, [data-waveform], [data-testid*="voice" i]') })
      .last();
    await expect(voiceBubble).toBeVisible({ timeout: 10_000 });

    // Play voice note and verify #top-audio-player-bar speed cycling & persistence across chat switch
    const playBtn = voiceBubble.locator('button').first();
    await playBtn.click();
    const topBar = page.locator(DOM.topAudioPlayerBar);
    await expect(topBar).toBeVisible();

    const speedBtn = topBar.getByRole('button', { name: /1x|1\.5x|2x/i }).first();
    await expect(speedBtn).toBeVisible();
    await speedBtn.click();
    await expect(topBar).toContainText(/1\.5x|2x/i);

    await selectChat(page, conv.groupTitle ?? 'Audio Switch Target');
    await expect(topBar).toBeVisible();
  });

  test('A06-T1-04: Interactive Poll creation (#modal-create-poll), live percentage voting, retract vote, and close poll', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token, {
      includeGroup: true,
      groupTitle: 'Poll Group Room',
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.groupTitle ?? 'Poll Group Room');

    await page.locator(DOM.btnAttachMenu).click();
    const pollTrigger = page.getByRole('menuitem', { name: BILINGUAL_PATTERNS.poll })
      .or(page.getByRole('button', { name: BILINGUAL_PATTERNS.poll }))
      .first();
    await expect(pollTrigger).toBeVisible();
    await pollTrigger.click();

    const pollModal = page.locator(DOM.modalCreatePoll);
    await expect(pollModal).toBeVisible();
    const inputs = pollModal.locator('input[type="text"], textarea');
    await inputs.nth(0).fill('Which release target ships first?');
    await inputs.nth(1).fill('v1.6.11 Web');
    await inputs.nth(2).fill('v1.6.11 Desktop');

    await scopedButton(pollModal, BILINGUAL_PATTERNS.confirm)
      .or(scopedButton(pollModal, BILINGUAL_PATTERNS.create))
      .first()
      .click();
    await expect(pollModal).toBeHidden();

    const pollBubble = page
      .locator(DOM.messageList)
      .locator(DOM.messageBubble)
      .filter({ hasText: 'Which release target ships first?' })
      .last();
    await expect(pollBubble).toBeVisible();

    await pollBubble.getByText('v1.6.11 Web').first().click();
    await expect(pollBubble).toContainText(/100%|1\s*vote|1\s*票/i);

    const retractBtn = scopedButton(pollBubble, BILINGUAL_PATTERNS.retractVote).first();
    await expect(retractBtn).toBeVisible();
    await retractBtn.click();
    await expect(pollBubble).not.toContainText('100%');

    // Re-vote then close poll cleanly
    await pollBubble.getByText('v1.6.11 Desktop').first().click();
    await expect(pollBubble).toContainText(/100%|1\s*vote|1\s*票/i);
    await openContextMenuAndClick(page, pollBubble, BILINGUAL_PATTERNS.stopPoll);
    await expect(pollBubble).toContainText(/closed|final\s*results|已结束|最终结果/i);
  });

  test('A06-T1-05: Quiz Mode single-choice explanation feedback & collaborative Todo checklist (#modal-create-todo) item toggling', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token, {
      includeGroup: true,
      groupTitle: 'Quiz & Todo Group',
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.groupTitle ?? 'Quiz & Todo Group');

    // 1. Create Quiz Mode poll and verify explanation feedback
    await page.locator(DOM.btnAttachMenu).click();
    const pollTrigger = page
      .getByRole('menuitem', { name: BILINGUAL_PATTERNS.poll })
      .or(page.getByRole('button', { name: BILINGUAL_PATTERNS.poll }))
      .first();
    await expect(pollTrigger).toBeVisible();
    await pollTrigger.click();

    const pollModal = page.locator(DOM.modalCreatePoll);
    await expect(pollModal).toBeVisible();
    const quizToggle = pollModal
      .getByRole('checkbox', { name: bilingualRegex('quiz', '测验') })
      .or(pollModal.locator('[data-testid*="quiz" i], input[type="checkbox"]').last())
      .first();
    await expect(quizToggle).toBeVisible();
    await quizToggle.click();

    const quizInputs = pollModal.locator('input[type="text"], textarea');
    await quizInputs.nth(0).fill('Current Fabushi version?');
    await quizInputs.nth(1).fill('1.6.11');
    await quizInputs.nth(2).fill('1.3.0');

    const correctRadio = pollModal.locator('input[type="radio"], [role="radio"]').first();
    await expect(correctRadio).toBeVisible();
    await correctRadio.click();

    const explanationInput = pollModal
      .locator('textarea, input[placeholder*="explanation" i], input[placeholder*="解析"]')
      .last();
    await expect(explanationInput).toBeVisible();
    await explanationInput.fill('Fabushi Web 1.6.11 parity');

    await scopedButton(pollModal, BILINGUAL_PATTERNS.confirm)
      .or(scopedButton(pollModal, BILINGUAL_PATTERNS.create))
      .first()
      .click();
    await expect(pollModal).toBeHidden();

    const quizBubble = page
      .locator(DOM.messageList)
      .locator(DOM.messageBubble)
      .filter({ hasText: 'Current Fabushi version?' })
      .last();
    await expect(quizBubble).toBeVisible();
    await quizBubble.getByText('1.6.11').first().click();
    await expect(quizBubble).toContainText('Fabushi Web 1.6.11 parity');

    // 2. Create Todo checklist via #modal-create-todo
    await page.locator(DOM.btnAttachMenu).click();
    const todoTrigger = page
      .getByRole('menuitem', { name: BILINGUAL_PATTERNS.todo })
      .or(page.getByRole('button', { name: BILINGUAL_PATTERNS.todo }))
      .first();
    await expect(todoTrigger).toBeVisible();
    await todoTrigger.click();

    const todoModal = page.locator(DOM.modalCreateTodo);
    await expect(todoModal).toBeVisible();
    const todoInputs = todoModal.locator('input[type="text"], textarea');
    expect(await todoInputs.count()).toBeGreaterThanOrEqual(2);
    await todoInputs.nth(0).fill('v1.6.11 Launch Checklist');
    await todoInputs.nth(1).fill('Verify Zero Fake Data');
    await scopedButton(todoModal, BILINGUAL_PATTERNS.confirm)
      .or(scopedButton(todoModal, BILINGUAL_PATTERNS.create))
      .first()
      .click();
    await expect(todoModal).toBeHidden();

    const todoBubble = page
      .locator(DOM.messageList)
      .locator(DOM.messageBubble)
      .filter({ hasText: 'v1.6.11 Launch Checklist' })
      .last();
    await expect(todoBubble).toBeVisible();
    const checkbox = todoBubble.locator('input[type="checkbox"], [role="checkbox"]').first();
    await expect(checkbox).toBeVisible();
    await checkbox.click();
    await expect(todoBubble).toContainText(/1\s*\/\s*[12]|50%|100%/);
  });

  test('A06-T1-06: Truthful Wallet UI (#wallet-stars-modal) showing real 0 initial Stars/TON balance without unverified self-minting', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;

    const walletApiRes = await request.get(apiUrl(API_PATHS.wallet), {
      headers: authHeaders(user.token),
    });
    expect(walletApiRes.status()).toBe(200);
    const walletData = (await walletApiRes.json()) as {
      stars?: unknown;
      stars_balance?: unknown;
      ton?: unknown;
      ton_balance?: unknown;
    };
    const stars = walletData.stars ?? walletData.stars_balance;
    const ton = walletData.ton ?? walletData.ton_balance;
    expect(typeof stars).toBe('number');
    expect(stars).toBe(0);
    expect(typeof ton).toBe('number');
    expect(ton).toBe(0);

    await openBurgerMenu(page);
    await page.locator(DOM.menuItemWallet).click();
    const walletModal = page.locator(DOM.walletStarsModal);
    await expect(walletModal).toBeVisible();
    await expect(walletModal).toContainText(/\b0\b/);
    // Must not display fabricated 2,500 Stars or 12.5 TON welcome balance
    await expect(walletModal).not.toContainText('2,500');
    await expect(walletModal).not.toContainText('2500');
    await expect(walletModal).not.toContainText('12.5');
  });
});
