import type { Download, Locator, Page } from '@playwright/test';
import {
  bilingualRegex,
  createPdfFilePayload,
  createPngBuffer,
  createPngFilePayload,
  DATA_ATTRS,
  DOM,
  expect,
  getBaseUrl,
  scopedButton,
  selectChat,
  test,
  type InMemoryFilePayload,
} from '../helpers';

async function selectWritablePeerChat(page: Page): Promise<void> {
  const chatList = page.locator(DOM.chatList);
  await expect(chatList).toBeVisible();

  const rows = chatList.locator(DOM.chatRow);
  const rowCount = await rows.count();
  expect(rowCount).toBeGreaterThan(0);

  const maxScan = Math.min(rowCount, 12);
  for (const allowSavedAndBots of [false, true]) {
    for (let i = 0; i < maxScan; i++) {
      const candidate = rows.nth(i);
      if (!(await candidate.isVisible())) continue;

      const rowText = (await candidate.innerText()).trim();
      if (
        !allowSavedAndBots &&
        /saved messages|收藏夹|已保存消息|botfather/i.test(rowText)
      ) {
        continue;
      }

      await selectChat(page, i);
      const topicList = page.locator(DOM.forumTopicList);
      const composer = page.locator(DOM.messageComposerInput);

      if ((await topicList.isVisible()) && !(await composer.isVisible())) {
        const firstTopic = page.locator(DOM.forumTopicItem).first();
        if (await firstTopic.isVisible()) {
          await firstTopic.click();
        }
      }

      if ((await composer.isVisible()) && (await composer.isEditable())) {
        return;
      }
    }
  }

  await expect(page.locator(DOM.messageComposerInput)).toBeVisible();
  await expect(page.locator(DOM.messageComposerInput)).toBeEditable();
}

async function ensureFileUploadInputMounted(page: Page): Promise<Locator> {
  const attachBtn = page.locator(DOM.btnAttachMenu);
  await expect(attachBtn).toBeVisible();

  const fileInput = page.locator(DOM.fileUploadInput);
  if ((await fileInput.count()) === 0) {
    await attachBtn.click();
  }
  expect(await fileInput.count()).toBeGreaterThan(0);
  return fileInput.first();
}

async function confirmPendingMediaSendIfNeeded(
  page: Page,
  countBefore: number,
): Promise<void> {
  await page.waitForTimeout(300);

  const editorModal = page.locator(DOM.modalMediaEditor);
  if (await editorModal.isVisible()) {
    const sendInEditor = scopedButton(editorModal, 'send')
      .or(scopedButton(editorModal, 'confirm'))
      .last();
    await expect(sendInEditor).toBeVisible();
    await sendInEditor.click();
    await expect(editorModal).toBeHidden();
    return;
  }

  const genericDialog = page
    .locator('[role="dialog"]')
    .filter({ hasNot: page.locator(DOM.chatList) })
    .first();
  if (await genericDialog.isVisible()) {
    const sendInDialog = scopedButton(genericDialog, 'send')
      .or(scopedButton(genericDialog, 'confirm'))
      .last();
    if ((await sendInDialog.count()) > 0 && (await sendInDialog.isVisible())) {
      await sendInDialog.click();
      return;
    }
  }

  const messageList = page.locator(DOM.messageList);
  const currentCount = await messageList.locator(DOM.messageBubble).count();
  if (currentCount <= countBefore) {
    const sendBtn = page.locator(DOM.btnSendMessage);
    if ((await sendBtn.isVisible()) && (await sendBtn.isEnabled())) {
      await sendBtn.click();
    }
  }
}

async function setFilesAndConfirmSendIfModalOpens(
  page: Page,
  files: InMemoryFilePayload | InMemoryFilePayload[],
): Promise<void> {
  const countBefore = await page
    .locator(DOM.messageList)
    .locator(DOM.messageBubble)
    .count();
  const fileInput = await ensureFileUploadInputMounted(page);
  await fileInput.setInputFiles(files);
  await confirmPendingMediaSendIfNeeded(page, countBefore);
}

function nonAvatarImagesInBubble(bubble: Locator): Locator {
  return bubble.locator(
    'img:not([data-avatar]):not([data-peer-avatar]):not([class*="avatar" i]):not([data-testid*="avatar" i])',
  );
}

async function readDownloadBuffer(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  if (!stream) {
    throw new Error(
      `Expected readable download stream for "${download.suggestedFilename()}"`,
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

test.describe(
  'F11 — Media Upload, Mosaic Albums, Media Editor, Files & Lightbox',
  () => {
    test('F11.1: uploads single PNG photo via #btn-attach-menu / #file-upload-input and verifies decoded <img> and HTTP 206 or Blob backing', async ({
      authPage,
    }) => {
      await selectWritablePeerChat(authPage);

      const messageList = authPage.locator(DOM.messageList);
      const countBefore = await messageList.locator(DOM.messageBubble).count();

      const capturedStreamUrls: string[] = [];
      let capturedAuthHeader = '';
      const baseUrl = getBaseUrl();

      authPage.on('response', (res) => {
        const reqHeaders = res.request().headers();
        const reqAuth =
          reqHeaders['authorization'] ?? reqHeaders['Authorization'] ?? '';
        if (reqAuth && !capturedAuthHeader) {
          capturedAuthHeader = reqAuth;
        }

        const url = res.url();
        if (/\/api\/v1\/media\//i.test(url)) {
          const reqMethod = res.request().method().toUpperCase();
          if (
            reqMethod === 'GET' &&
            !/\/(?:upload|init|chunk|complete)\b/i.test(url)
          ) {
            capturedStreamUrls.push(url);
          }
        }

        const locHeader =
          res.headers()['location'] ?? res.headers()['x-media-url'] ?? '';
        if (locHeader && /\/api\/v1\/media\//i.test(locHeader)) {
          const resolved = locHeader.startsWith('http')
            ? locHeader
            : `${baseUrl}${locHeader.startsWith('/') ? '' : '/'}${locHeader}`;
          capturedStreamUrls.push(resolved);
        }
      });

      const pngPayload = createPngFilePayload('system-topology.png', {
        width: 240,
        height: 160,
        r: 51,
        g: 144,
        b: 236,
        pattern: 'gradient',
      });

      await setFilesAndConfirmSendIfModalOpens(authPage, pngPayload);

      await expect
        .poll(async () => messageList.locator(DOM.messageBubble).count(), {
          message: 'Expected uploaded PNG to append a media message bubble',
          timeout: 10_000,
        })
        .toBeGreaterThan(countBefore);

      const newestBubble = messageList.locator(DOM.messageBubble).last();
      const photoImg = nonAvatarImagesInBubble(newestBubble).first();
      await expect(photoImg).toBeVisible();

      await expect
        .poll(
          async () =>
            photoImg.evaluate(
              (el) =>
                el instanceof HTMLImageElement &&
                el.complete &&
                el.naturalWidth >= 64 &&
                el.naturalHeight >= 40,
            ),
          {
            message: 'Expected uploaded PNG <img> to decode with naturalWidth >= 64',
            timeout: 8_000,
          },
        )
        .toBe(true);

      const imgMeta = await photoImg.evaluate((el) => {
        if (!(el instanceof HTMLImageElement)) {
          return { src: '', naturalWidth: 0, naturalHeight: 0 };
        }
        return {
          src: el.currentSrc || el.src,
          naturalWidth: el.naturalWidth,
          naturalHeight: el.naturalHeight,
        };
      });

      expect(imgMeta.src.length).toBeGreaterThan(0);
      expect(imgMeta.naturalWidth).toBe(240);
      expect(imgMeta.naturalHeight).toBe(160);

      let verifiedBackingCount = 0;

      // Verify BlobUrlRegistry blob: backing when src uses ObjectURL
      if (imgMeta.src.startsWith('blob:')) {
        const blobInspection = await authPage.evaluate(async (blobUrl) => {
          const response = await fetch(blobUrl);
          const blob = await response.blob();
          const buf = new Uint8Array(await blob.arrayBuffer());
          return {
            size: blob.size,
            type: blob.type,
            sig: Array.from(buf.slice(0, 4)),
          };
        }, imgMeta.src);

        expect(blobInspection.size).toBeGreaterThan(100);
        expect(blobInspection.type).toMatch(/^image\/png/i);
        expect(blobInspection.sig).toEqual([0x89, 0x50, 0x4e, 0x47]);
        verifiedBackingCount++;
      }

      // Verify HTTP 206 Partial Content Range streaming when /api/v1/media/* URL is exposed/captured
      const httpMediaUrl =
        imgMeta.src.startsWith('http://') || imgMeta.src.startsWith('https://')
          ? imgMeta.src
          : capturedStreamUrls[0] ?? '';

      if (httpMediaUrl) {
        if (!capturedAuthHeader) {
          capturedAuthHeader = await authPage.evaluate(() => {
            const stores = [window.localStorage, window.sessionStorage];
            for (const store of stores) {
              for (let i = 0; i < store.length; i++) {
                const key = store.key(i) ?? '';
                const raw = store.getItem(key) ?? '';
                if (/token|auth|session/i.test(key)) {
                  if (/^Bearer\s+\S+/i.test(raw)) return raw;
                  if (/^[A-Za-z0-9._-]{16,}$/.test(raw)) return `Bearer ${raw}`;
                  if (raw.startsWith('{')) {
                    const m = raw.match(
                      /"(?:accessToken|access_token|authToken|auth_token|token)"\s*:\s*"([^"]+)"/,
                    );
                    if (m && m[1]) {
                      return m[1].startsWith('Bearer ')
                        ? m[1]
                        : `Bearer ${m[1]}`;
                    }
                  }
                }
              }
            }
            return '';
          });
        }

        const rangeHeaders: Record<string, string> = { Range: 'bytes=0-63' };
        if (capturedAuthHeader) {
          rangeHeaders.Authorization = capturedAuthHeader;
        }

        const rangeRes = await authPage.request.get(httpMediaUrl, {
          headers: rangeHeaders,
        });
        expect(rangeRes.status()).toBe(206);
        expect(rangeRes.headers()['content-range']).toBeTruthy();
        const partialBytes = await rangeRes.body();
        expect(Array.from(partialBytes.subarray(0, 4))).toEqual([
          0x89, 0x50, 0x4e, 0x47,
        ]);
        verifiedBackingCount++;
      } else if (imgMeta.src.startsWith('data:image/png;base64,')) {
        const rawBytes = Buffer.from(
          imgMeta.src.slice('data:image/png;base64,'.length),
          'base64',
        );
        expect(Array.from(rawBytes.subarray(0, 4))).toEqual([
          0x89, 0x50, 0x4e, 0x47,
        ]);
        verifiedBackingCount++;
      }

      expect(verifiedBackingCount).toBeGreaterThanOrEqual(1);
    });

    test('F11.2: edits image in #modal-media-editor with crop, rotate, brush draw, spoiler toggle, and caption before sending', async ({
      authPage,
    }) => {
      await selectWritablePeerChat(authPage);

      const rawPng = createPngFilePayload('annotated-shot.png', {
        width: 320,
        height: 200,
        r: 28,
        g: 120,
        b: 200,
        pattern: 'solid',
      });

      const fileInput = await ensureFileUploadInputMounted(authPage);
      await fileInput.setInputFiles(rawPng);

      const editor = authPage.locator(DOM.modalMediaEditor);
      await authPage.waitForTimeout(250);

      // If attachment staged into composer/preview bar first, click its Edit button to open #modal-media-editor
      if (!(await editor.isVisible())) {
        const editTrigger = scopedButton(
          authPage.locator(DOM.middleColumn),
          'edit',
        )
          .or(
            authPage.locator(
              '[data-testid*="edit-media" i], [data-testid*="media-edit" i], button[aria-label*="edit" i], button[aria-label*="编辑" i]',
            ),
          )
          .first();
        if ((await editTrigger.count()) > 0 && (await editTrigger.isVisible())) {
          await editTrigger.click();
        }
      }

      await expect(editor).toBeVisible();

      // 1. Preview <canvas> — snapshot dimensions + pixel deviations from solid rgb(28, 120, 200) before edits
      const canvas = editor.locator('canvas').first();
      await expect(canvas).toBeVisible();

      const sampleEditorCanvas = async () => {
        return canvas.evaluate((el) => {
          if (!(el instanceof HTMLCanvasElement)) {
            return {
              width: 0,
              height: 0,
              rectW: 0,
              rectH: 0,
              cssTransform: '',
              nonOriginalPixels: 0,
            };
          }
          const r = el.getBoundingClientRect();
          const cssTransform = `${window.getComputedStyle(el).transform}|${el.parentElement ? window.getComputedStyle(el.parentElement).transform : ''}`;
          const sw = Math.max(1, Math.min(48, el.width || Math.round(r.width)));
          const sh = Math.max(1, Math.min(48, el.height || Math.round(r.height)));
          const probe = document.createElement('canvas');
          probe.width = sw;
          probe.height = sh;
          const ctx = probe.getContext('2d');
          let nonOriginalPixels = 0;
          if (ctx && sw > 0 && sh > 0) {
            ctx.drawImage(el, 0, 0, sw, sh);
            const data = ctx.getImageData(0, 0, sw, sh).data;
            for (let i = 0; i < data.length; i += 4) {
              const alpha = data[i + 3];
              if (alpha > 16) {
                const dr = Math.abs(data[i] - 28);
                const dg = Math.abs(data[i + 1] - 120);
                const db = Math.abs(data[i + 2] - 200);
                if (dr > 12 || dg > 12 || db > 12) {
                  nonOriginalPixels++;
                }
              }
            }
          }
          return {
            width: el.width,
            height: el.height,
            rectW: r.width,
            rectH: r.height,
            cssTransform,
            nonOriginalPixels,
          };
        });
      };

      // Allow initial image draw onto <canvas> to settle
      await authPage.waitForTimeout(120);
      const beforeCanvas = await sampleEditorCanvas();

      // 2. Rotate
      const rotateBtn = scopedButton(editor, bilingualRegex('rotate', '旋转'))
        .or(
          editor.locator(
            '[data-tool="rotate"], [data-testid*="rotate" i], button[title*="rotate" i], button[title*="旋转" i]',
          ),
        )
        .first();
      await expect(rotateBtn).toBeVisible();
      await rotateBtn.click();

      // 3. Crop
      const cropBtn = scopedButton(editor, bilingualRegex('crop', '裁剪'))
        .or(
          editor.locator(
            '[data-tool="crop"], [data-testid*="crop" i], button[title*="crop" i], button[title*="裁剪" i]',
          ),
        )
        .first();
      await expect(cropBtn).toBeVisible();
      await cropBtn.click();

      const applyCropBtn = scopedButton(
        editor,
        bilingualRegex('apply crop|done crop', '应用裁剪|完成裁剪'),
      ).first();
      if ((await applyCropBtn.count()) > 0 && (await applyCropBtn.isVisible())) {
        await applyCropBtn.click();
      }

      // 4. Brush Draw stroke across center of <canvas>
      const brushBtn = scopedButton(
        editor,
        bilingualRegex('draw|brush|pen', '涂鸦|画笔|绘制'),
      )
        .or(
          editor.locator(
            '[data-tool="draw"], [data-tool="brush"], [data-testid*="draw" i], [data-testid*="brush" i], button[title*="draw" i], button[title*="brush" i], button[title*="画笔" i], button[title*="涂鸦" i]',
          ),
        )
        .first();
      await expect(brushBtn).toBeVisible();
      await brushBtn.click();

      const canvasBox = await canvas.boundingBox();
      expect(canvasBox).not.toBeNull();
      const startX = canvasBox!.x + canvasBox!.width * 0.25;
      const startY = canvasBox!.y + canvasBox!.height * 0.35;
      const endX = canvasBox!.x + canvasBox!.width * 0.75;
      const endY = canvasBox!.y + canvasBox!.height * 0.65;

      await authPage.mouse.move(startX, startY);
      await authPage.mouse.down();
      await authPage.mouse.move(endX, endY, { steps: 8 });
      await authPage.mouse.up();

      // Hard-assert <canvas> inside #modal-media-editor mutated after Rotate + Crop + Brush
      await expect
        .poll(
          async () => {
            const afterCanvas = await sampleEditorCanvas();
            const dimsChanged =
              afterCanvas.width !== beforeCanvas.width ||
              afterCanvas.height !== beforeCanvas.height;
            const aspectBefore =
              beforeCanvas.rectW / Math.max(1, beforeCanvas.rectH);
            const aspectAfter =
              afterCanvas.rectW / Math.max(1, afterCanvas.rectH);
            const aspectChanged = Math.abs(aspectAfter - aspectBefore) > 0.08;
            const transformChanged =
              afterCanvas.cssTransform !== beforeCanvas.cssTransform;
            const pixelsChanged =
              afterCanvas.nonOriginalPixels > beforeCanvas.nonOriginalPixels;
            return (
              dimsChanged || aspectChanged || transformChanged || pixelsChanged
            );
          },
          {
            message:
              'Expected Rotate/Crop/Brush in #modal-media-editor to mutate preview <canvas> dimensions, transform, or pixels',
            timeout: 5_000,
          },
        )
        .toBe(true);

      // 5. Spoiler Toggle (prioritize checkbox/switch/button before label)
      const spoilerPattern = bilingualRegex(
        'spoiler|blur|hide media',
        '剧透|模糊|隐藏',
      );
      const spoilerCheckbox = editor.getByRole('checkbox', {
        name: spoilerPattern,
      });
      const spoilerSwitch = editor.getByRole('switch', { name: spoilerPattern });
      const spoilerBtn = scopedButton(editor, spoilerPattern);
      const spoilerFallback = editor.locator(
        '[data-tool="spoiler"], [data-testid*="spoiler" i], label:has-text("Spoiler"), label:has-text("剧透")',
      );

      let spoilerToggle = spoilerFallback.first();
      if (
        (await spoilerCheckbox.count()) > 0 &&
        (await spoilerCheckbox.first().isVisible())
      ) {
        spoilerToggle = spoilerCheckbox.first();
      } else if (
        (await spoilerSwitch.count()) > 0 &&
        (await spoilerSwitch.first().isVisible())
      ) {
        spoilerToggle = spoilerSwitch.first();
      } else if (
        (await spoilerBtn.count()) > 0 &&
        (await spoilerBtn.first().isVisible())
      ) {
        spoilerToggle = spoilerBtn.first();
      }
      await expect(spoilerToggle).toBeVisible();
      await spoilerToggle.click();

      // 6. Caption input
      const captionText = 'Spoiler annotated release chart F11-2';
      const explicitCaption = editor.getByPlaceholder(
        /caption|message|add a caption|说明|标题|描述|添加说明/i,
      );
      const captionInput =
        (await explicitCaption.count()) > 0 &&
        (await explicitCaption.first().isVisible())
          ? explicitCaption.first()
          : editor
              .locator('textarea, input[type="text"], [contenteditable="true"]')
              .first();
      await expect(captionInput).toBeVisible();
      await captionInput.fill(captionText);

      // Submit edited media
      const submitBtn = scopedButton(editor, 'send')
        .or(scopedButton(editor, 'confirm'))
        .last();
      await expect(submitBtn).toBeVisible();
      await submitBtn.click();
      await expect(editor).toBeHidden();

      // If applying inside #modal-media-editor returned to composer staging, press #btn-send-message
      const messageList = authPage.locator(DOM.messageList);
      const captionBubbleLocator = messageList
        .locator(DOM.messageBubble)
        .filter({ hasText: captionText });
      if ((await captionBubbleLocator.count()) === 0) {
        const sendBtn = authPage.locator(DOM.btnSendMessage);
        if ((await sendBtn.isVisible()) && (await sendBtn.isEnabled())) {
          await sendBtn.click();
        }
      }

      const editedBubble = captionBubbleLocator.last();
      await expect(editedBubble).toBeVisible();
      await expect(editedBubble).toContainText(captionText);

      // Verify Spoiler obfuscation is genuinely active prior to user click
      const inspectSpoilerState = async () => {
        return editedBubble.evaluate((el) => {
          const hasPositiveBlur = (cssFilter: string): boolean => {
            const m = cssFilter.match(/blur\(\s*([0-9.]+)/i);
            return Boolean(m && parseFloat(m[1]) > 0.5);
          };

          const allNodes = [el, ...Array.from(el.querySelectorAll('*'))];
          let anyActiveBlur = false;
          for (const node of allNodes) {
            if (!(node instanceof HTMLElement)) continue;
            const st = window.getComputedStyle(node);
            if (
              st.display === 'none' ||
              st.visibility === 'hidden' ||
              parseFloat(st.opacity || '1') <= 0.05
            ) {
              continue;
            }
            if (
              hasPositiveBlur(st.filter || '') ||
              hasPositiveBlur(
                (st as CSSStyleDeclaration & { backdropFilter?: string })
                  .backdropFilter || '',
              )
            ) {
              anyActiveBlur = true;
            }
          }

          const unrevealedOverlay = Array.from(
            el.querySelectorAll(
              '[data-spoiler], [data-testid*="spoiler" i], [class*="spoiler" i]',
            ),
          ).some((ov) => {
            if (!(ov instanceof HTMLElement)) return false;
            const st = window.getComputedStyle(ov);
            if (
              st.display === 'none' ||
              st.visibility === 'hidden' ||
              parseFloat(st.opacity || '1') <= 0.05
            ) {
              return false;
            }
            if (
              ov.dataset.spoiler === 'false' ||
              ov.dataset.revealed === 'true' ||
              ov.dataset.spoilerRevealed === 'true' ||
              /\b(revealed|is-revealed|unblurred)\b/i.test(ov.className)
            ) {
              return false;
            }
            return true;
          });

          return {
            anyActiveBlur,
            unrevealedOverlay,
            obfuscated: anyActiveBlur || unrevealedOverlay,
          };
        });
      };

      const stateBeforeReveal = await inspectSpoilerState();
      expect(stateBeforeReveal.obfuscated).toBe(true);

      // Click spoiler overlay / image to reveal clear edited image
      const explicitSpoilerOverlay = editedBubble.locator(
        '[data-spoiler], [data-testid*="spoiler" i], [class*="spoiler" i]',
      );
      const spoilerTarget =
        (await explicitSpoilerOverlay.count()) > 0 &&
        (await explicitSpoilerOverlay.first().isVisible())
          ? explicitSpoilerOverlay.first()
          : editedBubble.locator('img').first();
      await spoilerTarget.click();

      const revealedImg = nonAvatarImagesInBubble(editedBubble).first();

      // Hard-assert spoiler blur & unrevealed overlay BOTH cleared AND image decoded
      await expect
        .poll(
          async () => {
            const decoded = await revealedImg.evaluate(
              (el) =>
                el instanceof HTMLImageElement &&
                el.complete &&
                el.naturalWidth > 0 &&
                el.naturalHeight > 0,
            );
            if (!decoded) return false;
            const afterState = await inspectSpoilerState();
            return !afterState.anyActiveBlur && !afterState.unrevealedOverlay;
          },
          {
            message:
              'Expected clicking spoiler-flagged photo to clear blur/overlay and reveal the edited image',
            timeout: 6_000,
          },
        )
        .toBe(true);

      // Hard-assert sent timeline image reflects Media Editor mutations (dimensions or pixels changed from raw 320x200 rgb(28,120,200))
      const sentImageMutated = await revealedImg.evaluate((el) => {
        if (!(el instanceof HTMLImageElement)) return false;
        if (el.naturalWidth !== 320 || el.naturalHeight !== 200) {
          return true;
        }
        const sw = Math.max(1, Math.min(64, el.naturalWidth));
        const sh = Math.max(1, Math.min(64, el.naturalHeight));
        const probe = document.createElement('canvas');
        probe.width = sw;
        probe.height = sh;
        const ctx = probe.getContext('2d');
        if (!ctx) return false;
        ctx.drawImage(el, 0, 0, sw, sh);
        const data = ctx.getImageData(0, 0, sw, sh).data;
        let mutatedPixels = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] > 16) {
            const dr = Math.abs(data[i] - 28);
            const dg = Math.abs(data[i + 1] - 120);
            const db = Math.abs(data[i + 2] - 200);
            if (dr > 12 || dg > 12 || db > 12) {
              mutatedPixels++;
            }
          }
        }
        return mutatedPixels > 0;
      });
      expect(sentImageMutated).toBe(true);
    });

    test('F11.3: uploads 3 PNG images together into a single proportional 2D Mosaic Media Album bubble', async ({
      authPage,
    }) => {
      await selectWritablePeerChat(authPage);

      const messageList = authPage.locator(DOM.messageList);
      const bubblesBefore = await messageList.locator(DOM.messageBubble).count();

      const img1 = createPngFilePayload('album-1.png', {
        width: 320,
        height: 220,
        r: 45,
        g: 136,
        b: 228,
        pattern: 'gradient',
      });
      const img2 = createPngFilePayload('album-2.png', {
        width: 200,
        height: 200,
        r: 40,
        g: 185,
        b: 125,
        pattern: 'gradient',
      });
      const img3 = createPngFilePayload('album-3.png', {
        width: 200,
        height: 200,
        r: 225,
        g: 155,
        b: 45,
        pattern: 'gradient',
      });

      await setFilesAndConfirmSendIfModalOpens(authPage, [img1, img2, img3]);

      // Exactly 1 new album message bubble (not 3 separate bubbles)
      await expect
        .poll(async () => messageList.locator(DOM.messageBubble).count(), {
          message: 'Expected 3 simultaneous PNG uploads to group into 1 Mosaic Album bubble',
          timeout: 10_000,
        })
        .toBe(bubblesBefore + 1);

      const albumBubble = messageList.locator(DOM.messageBubble).last();
      const albumImgs = nonAvatarImagesInBubble(albumBubble);
      await expect(albumImgs).toHaveCount(3);

      await expect
        .poll(
          async () =>
            albumImgs.evaluateAll((els) =>
              els.every(
                (el) =>
                  el instanceof HTMLImageElement &&
                  el.complete &&
                  el.naturalWidth > 0 &&
                  el.naturalHeight > 0,
              ),
            ),
          { timeout: 8_000 },
        )
        .toBe(true);

      const bubbleBox = await albumBubble.boundingBox();
      expect(bubbleBox).not.toBeNull();
      expect(bubbleBox!.width).toBeLessThanOrEqual(500);

      const tileBoxes = await Promise.all([
        albumImgs.nth(0).boundingBox(),
        albumImgs.nth(1).boundingBox(),
        albumImgs.nth(2).boundingBox(),
      ]);

      for (const tb of tileBoxes) {
        expect(tb).not.toBeNull();
        expect(tb!.width).toBeGreaterThanOrEqual(40);
        expect(tb!.height).toBeGreaterThanOrEqual(40);
      }

      // Proportional 2D mosaic layout: at least two tiles sit horizontally side-by-side
      let hasHorizontalPair = false;
      for (let i = 0; i < tileBoxes.length; i++) {
        for (let j = i + 1; j < tileBoxes.length; j++) {
          if (Math.abs(tileBoxes[j]!.x - tileBoxes[i]!.x) >= 35) {
            hasHorizontalPair = true;
          }
        }
      }
      expect(hasHorizontalPair).toBe(true);
    });

    test('F11.4: uploads PDF document card displaying extension badge and byte size and triggers verified binary Blob download', async ({
      authPage,
    }) => {
      await selectWritablePeerChat(authPage);

      const pdfPayload = createPdfFilePayload(
        'Protocol-Contract-v2.pdf',
        'GPUI Telegram Hexagonal Spec',
      );

      await setFilesAndConfirmSendIfModalOpens(authPage, pdfPayload);

      const fileBubble = authPage
        .locator(DOM.messageList)
        .locator(DOM.messageBubble)
        .filter({ hasText: 'Protocol-Contract-v2.pdf' })
        .last();

      await expect(fileBubble).toBeVisible();
      await expect(fileBubble).toContainText('Protocol-Contract-v2.pdf');
      await expect(fileBubble).toContainText(/\bpdf\b/i);
      await expect(fileBubble).toContainText(
        /\b\d+(?:\.\d+)?\s*(?:B|bytes|KB|KiB)\b/i,
      );

      const explicitDownloadLink = fileBubble.locator(
        'a[download], [data-testid*="download" i]',
      );
      const explicitDownloadBtn = scopedButton(
        fileBubble,
        bilingualRegex('download|save', '下载|保存'),
      );

      let downloadTarget: Locator = fileBubble;
      if (
        (await explicitDownloadLink.count()) > 0 &&
        (await explicitDownloadLink.first().isVisible())
      ) {
        downloadTarget = explicitDownloadLink.first();
      } else if (
        (await explicitDownloadBtn.count()) > 0 &&
        (await explicitDownloadBtn.first().isVisible())
      ) {
        downloadTarget = explicitDownloadBtn.first();
      }

      const [download] = await Promise.all([
        authPage.waitForEvent('download', { timeout: 10_000 }),
        downloadTarget.click(),
      ]);

      expect(download.suggestedFilename().toLowerCase()).toMatch(/\.pdf$/);

      const downloadedBytes = await readDownloadBuffer(download);
      expect(downloadedBytes.byteLength).toBe(pdfPayload.buffer.byteLength);
      expect(downloadedBytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    });

    test('F11.5: opens #lightbox-viewer and exercises #lightbox-zoom-in, #lightbox-rotate, #lightbox-next, #lightbox-prev, #lightbox-download, and #lightbox-close', async ({
      authPage,
    }) => {
      await selectWritablePeerChat(authPage);

      const messageList = authPage.locator(DOM.messageList);
      const countBefore = await messageList.locator(DOM.messageBubble).count();

      const landscapePhoto = createPngFilePayload('gallery-landscape.png', {
        width: 240,
        height: 120,
        r: 40,
        g: 130,
        b: 230,
      });
      const portraitPhoto = createPngFilePayload('gallery-portrait.png', {
        width: 120,
        height: 240,
        r: 35,
        g: 185,
        b: 115,
      });

      await setFilesAndConfirmSendIfModalOpens(authPage, landscapePhoto);
      await expect
        .poll(async () => messageList.locator(DOM.messageBubble).count())
        .toBeGreaterThan(countBefore);
      const photo1Bubble = messageList.locator(DOM.messageBubble).last();
      const photo1MsgId = await photo1Bubble.getAttribute(DATA_ATTRS.messageId);

      const countAfterFirst = await messageList.locator(DOM.messageBubble).count();
      await setFilesAndConfirmSendIfModalOpens(authPage, portraitPhoto);
      await expect
        .poll(async () => messageList.locator(DOM.messageBubble).count())
        .toBeGreaterThan(countAfterFirst);

      // Click Photo 1 (landscape 240x120) to open #lightbox-viewer
      const firstPhotoTarget = photo1MsgId
        ? nonAvatarImagesInBubble(
            messageList.locator(
              `${DOM.messageBubble}[data-message-id="${photo1MsgId}"]`,
            ),
          ).first()
        : nonAvatarImagesInBubble(photo1Bubble).first();

      await expect(firstPhotoTarget).toBeVisible();
      await firstPhotoTarget.click();

      const lb = authPage.locator(DOM.lightboxViewer);
      await expect(lb).toBeVisible();

      const lbImg = lb.locator('img').first();
      await expect(lbImg).toBeVisible();

      await expect
        .poll(
          async () =>
            lbImg.evaluate((el) =>
              el instanceof HTMLImageElement
                ? `${el.naturalWidth}x${el.naturalHeight}`
                : '',
            ),
          { timeout: 6_000 },
        )
        .toBe('240x120');

      const boxInitial = await lbImg.boundingBox();
      expect(boxInitial).not.toBeNull();
      expect(boxInitial!.width).toBeGreaterThan(boxInitial!.height);

      // 1. Zoom In (#lightbox-zoom-in)
      const zoomInBtn = authPage.locator(DOM.lightboxZoomIn);
      await expect(zoomInBtn).toBeVisible();
      await zoomInBtn.click();

      await expect
        .poll(
          async () => {
            const b = await lbImg.boundingBox();
            return b ? b.width : 0;
          },
          { timeout: 5_000 },
        )
        .toBeGreaterThan(boxInitial!.width * 1.08);

      // 2. Rotate 90 degrees (#lightbox-rotate)
      const rotateStateBefore = await lbImg.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return {
          transform: window.getComputedStyle(el).transform,
          parentTransform: el.parentElement
            ? window.getComputedStyle(el.parentElement).transform
            : 'none',
          aspectLandscape: r.width > r.height,
        };
      });

      const rotateBtn = authPage.locator(DOM.lightboxRotate);
      await expect(rotateBtn).toBeVisible();
      await rotateBtn.click();

      await expect
        .poll(
          async () =>
            lbImg.evaluate((el, prev) => {
              const r = el.getBoundingClientRect();
              const curTransform = window.getComputedStyle(el).transform;
              const curParentTransform = el.parentElement
                ? window.getComputedStyle(el.parentElement).transform
                : 'none';
              const flippedAspect = r.height > r.width;
              const changedTransform =
                curTransform !== prev.transform ||
                curParentTransform !== prev.parentTransform;
              return flippedAspect || changedTransform;
            }, rotateStateBefore),
          { timeout: 5_000 },
        )
        .toBe(true);

      // 3. Gallery Next & Prev (#lightbox-next & #lightbox-prev)
      const nextBtn = authPage.locator(DOM.lightboxNext);
      const prevBtn = authPage.locator(DOM.lightboxPrev);
      await expect(nextBtn).toBeVisible();
      await expect(prevBtn).toBeVisible();

      const nextEnabledFirst = await nextBtn.isEnabled();
      if (nextEnabledFirst) {
        await nextBtn.click();
        await expect
          .poll(async () =>
            lbImg.evaluate((el) =>
              el instanceof HTMLImageElement
                ? `${el.naturalWidth}x${el.naturalHeight}`
                : '',
            ),
          )
          .toBe('120x240');

        await prevBtn.click();
        await expect
          .poll(async () =>
            lbImg.evaluate((el) =>
              el instanceof HTMLImageElement
                ? `${el.naturalWidth}x${el.naturalHeight}`
                : '',
            ),
          )
          .toBe('240x120');
      } else {
        await prevBtn.click();
        await expect
          .poll(async () =>
            lbImg.evaluate((el) =>
              el instanceof HTMLImageElement
                ? `${el.naturalWidth}x${el.naturalHeight}`
                : '',
            ),
          )
          .toBe('120x240');

        await nextBtn.click();
        await expect
          .poll(async () =>
            lbImg.evaluate((el) =>
              el instanceof HTMLImageElement
                ? `${el.naturalWidth}x${el.naturalHeight}`
                : '',
            ),
          )
          .toBe('240x120');
      }

      // 4. Download (#lightbox-download)
      const downloadBtn = authPage.locator(DOM.lightboxDownload);
      await expect(downloadBtn).toBeVisible();
      const [lbDownload] = await Promise.all([
        authPage.waitForEvent('download', { timeout: 10_000 }),
        downloadBtn.click(),
      ]);
      const lbBytes = await readDownloadBuffer(lbDownload);
      expect(lbBytes.byteLength).toBeGreaterThan(64);
      expect(Array.from(lbBytes.subarray(0, 4))).toEqual([
        0x89, 0x50, 0x4e, 0x47,
      ]);

      // 5. Close (#lightbox-close)
      const closeBtn = authPage.locator(DOM.lightboxClose);
      await expect(closeBtn).toBeVisible();
      await closeBtn.click();
      await expect(lb).toBeHidden();
    });

    test('F11.6: uploads images via Ctrl+V clipboard paste and HTML5 drag-and-drop', async ({
      authPage,
    }) => {
      await selectWritablePeerChat(authPage);

      const messageList = authPage.locator(DOM.messageList);
      const composer = authPage.locator(DOM.messageComposerInput);

      // Part A: Ctrl+V clipboard image paste
      const countBeforePaste = await messageList.locator(DOM.messageBubble).count();
      const pasteB64 = createPngBuffer({
        width: 180,
        height: 120,
        r: 30,
        g: 150,
        b: 235,
        pattern: 'gradient',
      }).toString('base64');

      await composer.focus();
      await composer.evaluate((el, b64) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) {
          bytes[i] = bin.charCodeAt(i);
        }
        const file = new File([bytes], 'pasted-shot.png', { type: 'image/png' });
        const dt = new DataTransfer();
        dt.items.add(file);

        el.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'v',
            code: 'KeyV',
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );

        const pasteEvt = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: dt,
        });
        if (!pasteEvt.clipboardData || pasteEvt.clipboardData.files.length === 0) {
          Object.defineProperty(pasteEvt, 'clipboardData', { value: dt });
        }
        el.dispatchEvent(pasteEvt);
      }, pasteB64);

      await confirmPendingMediaSendIfNeeded(authPage, countBeforePaste);

      await expect
        .poll(async () => messageList.locator(DOM.messageBubble).count(), {
          message: 'Expected Ctrl+V image paste to append a new media bubble',
          timeout: 10_000,
        })
        .toBe(countBeforePaste + 1);

      const pastedImg = nonAvatarImagesInBubble(
        messageList.locator(DOM.messageBubble).last(),
      ).first();
      await expect
        .poll(
          async () =>
            pastedImg.evaluate(
              (el) =>
                el instanceof HTMLImageElement &&
                el.complete &&
                el.naturalWidth > 0,
            ),
          { timeout: 6_000 },
        )
        .toBe(true);

      // Part B: HTML5 Drag-and-Drop image upload
      const countBeforeDrop = await messageList.locator(DOM.messageBubble).count();
      const dropB64 = createPngBuffer({
        width: 220,
        height: 150,
        r: 45,
        g: 190,
        b: 110,
        pattern: 'gradient',
      }).toString('base64');

      await messageList.evaluate(async (el, b64) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) {
          bytes[i] = bin.charCodeAt(i);
        }
        const file = new File([bytes], 'dropped-shot.png', {
          type: 'image/png',
        });
        const dt = new DataTransfer();
        dt.items.add(file);

        el.dispatchEvent(
          new DragEvent('dragenter', {
            bubbles: true,
            cancelable: true,
            dataTransfer: dt,
          }),
        );
        el.dispatchEvent(
          new DragEvent('dragover', {
            bubbles: true,
            cancelable: true,
            dataTransfer: dt,
          }),
        );

        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );

        const rect = el.getBoundingClientRect();
        const dropTarget =
          document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
          ) ?? el;

        dropTarget.dispatchEvent(
          new DragEvent('dragover', {
            bubbles: true,
            cancelable: true,
            dataTransfer: dt,
          }),
        );
        dropTarget.dispatchEvent(
          new DragEvent('drop', {
            bubbles: true,
            cancelable: true,
            dataTransfer: dt,
          }),
        );
      }, dropB64);

      await confirmPendingMediaSendIfNeeded(authPage, countBeforeDrop);

      await expect
        .poll(async () => messageList.locator(DOM.messageBubble).count(), {
          message: 'Expected HTML5 drag-and-drop image to append a new media bubble',
          timeout: 10_000,
        })
        .toBe(countBeforeDrop + 1);

      const droppedImg = nonAvatarImagesInBubble(
        messageList.locator(DOM.messageBubble).last(),
      ).first();
      await expect
        .poll(
          async () =>
            droppedImg.evaluate(
              (el) =>
                el instanceof HTMLImageElement &&
                el.complete &&
                el.naturalWidth > 0,
            ),
          { timeout: 6_000 },
        )
        .toBe(true);
    });
  },
);
