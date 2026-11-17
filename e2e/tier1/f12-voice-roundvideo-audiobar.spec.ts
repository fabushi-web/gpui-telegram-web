import type { Locator, Page } from '@playwright/test';
import {
  bilingualRegex,
  DATA_ATTRS,
  DOM,
  expect,
  messageBubbleById,
  scopedButton,
  scopedMenuItem,
  selectChat,
  test,
} from '../helpers';

interface SelectedWritableChat {
  row: Locator;
  chatId: string;
  title: string;
}

async function selectWritableChat(
  page: Page,
  skipChatIds: Set<string> = new Set(),
): Promise<SelectedWritableChat> {
  const chatList = page.locator(DOM.chatList);
  await expect(chatList).toBeVisible();

  const rows = chatList.locator(DOM.chatRow);
  const total = await rows.count();
  expect(total).toBeGreaterThan(0);

  const maxScan = Math.min(total, 12);
  for (const allowBotsAndSaved of [false, true]) {
    for (let i = 0; i < maxScan; i++) {
      const candidate = rows.nth(i);
      if (!(await candidate.isVisible())) continue;

      const chatId = (await candidate.getAttribute(DATA_ATTRS.chatId)) ?? '';
      if (chatId && skipChatIds.has(chatId)) continue;

      const text = (await candidate.innerText()).trim();
      if (!allowBotsAndSaved && /botfather/i.test(text)) {
        continue;
      }

      const selectedRow = await selectChat(page, i);
      const topicList = page.locator(DOM.forumTopicList);
      const composer = page.locator(DOM.messageComposerInput);

      if ((await topicList.isVisible()) && !(await composer.isVisible())) {
        const firstTopic = page.locator(DOM.forumTopicItem).first();
        if (await firstTopic.isVisible()) {
          await firstTopic.click();
        }
      }

      if ((await composer.isVisible()) && (await composer.isEditable())) {
        // Clear any draft so #btn-record-voice is exposed instead of #btn-send-message
        await composer.fill('');
        const title = (await page.locator(DOM.chatHeaderTitle).innerText()).trim();
        return { row: selectedRow, chatId, title };
      }
    }
  }

  const composer = page.locator(DOM.messageComposerInput);
  await expect(composer).toBeVisible();
  await composer.fill('');
  const fallbackRow = rows.first();
  return {
    row: fallbackRow,
    chatId: (await fallbackRow.getAttribute(DATA_ATTRS.chatId)) ?? '',
    title: (await page.locator(DOM.chatHeaderTitle).innerText()).trim(),
  };
}

async function locatePlayPauseBtn(container: Locator): Promise<Locator> {
  const semantic = scopedButton(
    container,
    bilingualRegex('play|pause|▶|⏸', '播放|暂停'),
  );
  if ((await semantic.count()) > 0 && (await semantic.first().isVisible())) {
    return semantic.first();
  }

  const attrMatch = container.locator(
    'button[aria-label*="play" i], button[aria-label*="pause" i], button[aria-label*="播放"], button[aria-label*="暂停"], [data-testid*="voice-play" i], [data-testid*="audio-play" i], [data-testid*="play" i]',
  );
  if ((await attrMatch.count()) > 0 && (await attrMatch.first().isVisible())) {
    return attrMatch.first();
  }

  return container
    .locator(
      'button:not([data-testid*="react" i]):not([aria-label*="react" i]):not([aria-label*="回应"]):not([aria-label*="表情"])',
    )
    .first();
}

async function recordAndSendVoiceNote(
  page: Page,
  durationMs = 2_600,
): Promise<Locator> {
  const composer = page.locator(DOM.messageComposerInput);
  await expect(composer).toBeVisible();
  await composer.fill('');

  const recordBtn = page.locator(DOM.btnRecordVoice);
  await expect(recordBtn).toBeVisible();
  await expect(recordBtn).toBeEnabled();

  const messageList = page.locator(DOM.messageList);
  const bubbles = messageList.locator(DOM.messageBubble);
  const countBefore = await bubbles.count();
  const lastIdBefore =
    countBefore > 0
      ? await bubbles.last().getAttribute(DATA_ATTRS.messageId)
      : null;

  // Primary flow: click-to-record -> wait >= durationMs -> click send/finish/record toggle
  await recordBtn.click();
  await page.waitForTimeout(durationMs);

  const hasAppended = async (): Promise<boolean> => {
    const countNow = await bubbles.count();
    if (countNow > countBefore) return true;
    if (countNow > 0 && lastIdBefore !== null) {
      const lastIdNow = await bubbles.last().getAttribute(DATA_ATTRS.messageId);
      return lastIdNow !== null && lastIdNow !== lastIdBefore;
    }
    return false;
  };

  if (!(await hasAppended())) {
    const sendBtn = page.locator(DOM.btnSendMessage);
    const finishSendBtn = page
      .locator(DOM.middleColumn)
      .getByRole('button', {
        name: bilingualRegex('send|finish|stop.*send|done', '发送|完成|结束并发送'),
      })
      .first();

    if ((await sendBtn.isVisible()) && (await sendBtn.isEnabled())) {
      await sendBtn.click();
    } else if (
      (await finishSendBtn.count()) > 0 &&
      (await finishSendBtn.isVisible())
    ) {
      await finishSendBtn.click();
    } else if (await recordBtn.isVisible()) {
      await recordBtn.click();
    }
  }

  await page.waitForTimeout(400);

  // Fallback flow: press-and-hold on #btn-record-voice for >= durationMs
  if (!(await hasAppended())) {
    await recordBtn.hover();
    await page.mouse.down();
    await page.waitForTimeout(durationMs);
    await page.mouse.up();

    const sendBtnAfterHold = page.locator(DOM.btnSendMessage);
    if (
      !(await hasAppended()) &&
      (await sendBtnAfterHold.isVisible()) &&
      (await sendBtnAfterHold.isEnabled())
    ) {
      await sendBtnAfterHold.click();
    }
  }

  await expect
    .poll(hasAppended, {
      message:
        'Expected #btn-record-voice headless Web Audio PCM synth fallback to append a voice message bubble',
      timeout: 10_000,
    })
    .toBe(true);

  const newest = bubbles.last();
  await expect(newest).toBeVisible();
  const msgId = await newest.getAttribute(DATA_ATTRS.messageId);
  if (msgId && msgId.length > 0) {
    return messageList.locator(messageBubbleById(msgId)).first();
  }
  return newest;
}

async function locateWaveformScrubber(voiceBubble: Locator): Promise<Locator> {
  const candidates = voiceBubble.locator(
    [
      '[data-testid*="waveform" i]',
      '[data-waveform]',
      '[role="slider"]',
      '[role="progressbar"]',
      'input[type="range"]',
      'canvas',
      'svg',
    ].join(', '),
  );
  const count = await candidates.count();
  for (let i = 0; i < count; i++) {
    const item = candidates.nth(i);
    if (!(await item.isVisible())) continue;
    const box = await item.boundingBox();
    if (box && box.width >= 60 && box.height >= 10) {
      return item;
    }
  }
  return candidates.first();
}

async function readVoiceProgressRatio(
  voiceBubble: Locator,
  topBar: Locator,
): Promise<number> {
  const fromBubble = await voiceBubble.evaluate((el) => {
    const rangeInput = el.querySelector('input[type="range"]');
    if (rangeInput instanceof HTMLInputElement) {
      const min = Number(rangeInput.min || '0');
      const max = Number(rangeInput.max || '100');
      const val = Number(rangeInput.value);
      if (max > min && !Number.isNaN(val)) {
        return (val - min) / (max - min);
      }
    }

    const ariaBar = el.querySelector(
      '[role="slider"][aria-valuenow], [role="progressbar"][aria-valuenow]',
    );
    if (ariaBar instanceof HTMLElement) {
      const now = Number(ariaBar.getAttribute('aria-valuenow'));
      const min = Number(ariaBar.getAttribute('aria-valuemin') ?? '0');
      const max = Number(ariaBar.getAttribute('aria-valuemax') ?? '100');
      if (max > min && !Number.isNaN(now)) {
        return now > 1 || max > 1 ? (now - min) / (max - min) : now;
      }
    }

    const dataProgEl = el.querySelector('[data-progress]');
    if (dataProgEl instanceof HTMLElement) {
      const raw = Number(dataProgEl.dataset.progress);
      if (!Number.isNaN(raw)) {
        return raw > 1 ? raw / 100 : raw;
      }
    }

    // Check discrete waveform bars (>= 32 bars)
    const barSelectors = [
      '[data-waveform-bar]',
      '[data-bar]',
      '[class*="waveform" i] > span',
      '[class*="waveform" i] > div',
      '[class*="waveform" i] > i',
      'svg rect',
      'svg line',
    ];
    for (const sel of barSelectors) {
      const bars = Array.from(el.querySelectorAll(sel));
      if (bars.length >= 32) {
        const explicitPlayed = bars.filter(
          (b) =>
            b.getAttribute('data-active') === 'true' ||
            b.getAttribute('data-played') === 'true' ||
            /\b(played|active|filled)\b/i.test(b.getAttribute('class') ?? ''),
        );
        if (explicitPlayed.length > 0) {
          return explicitPlayed.length / bars.length;
        }

        const lastStyle = window.getComputedStyle(bars[bars.length - 1]);
        const unplayedSig = `${lastStyle.backgroundColor}|${lastStyle.fill}|${lastStyle.opacity}`;
        let diffCount = 0;
        for (const b of bars) {
          const st = window.getComputedStyle(b);
          const sig = `${st.backgroundColor}|${st.fill}|${st.opacity}`;
          if (sig !== unplayedSig) {
            diffCount++;
          }
        }
        if (diffCount > 0 && diffCount < bars.length) {
          return diffCount / bars.length;
        }
      }
    }

    const audio = el.querySelector('audio');
    if (
      audio instanceof HTMLAudioElement &&
      Number.isFinite(audio.duration) &&
      audio.duration > 0
    ) {
      return audio.currentTime / audio.duration;
    }

    const canvas = el.querySelector('canvas');
    if (canvas instanceof HTMLCanvasElement && canvas.width >= 60) {
      const probe = document.createElement('canvas');
      probe.width = canvas.width;
      probe.height = Math.max(1, canvas.height);
      const ctx = probe.getContext('2d');
      if (ctx) {
        ctx.drawImage(canvas, 0, 0);
        const midY = Math.floor(probe.height / 2);
        const row = ctx.getImageData(0, midY, probe.width, 1).data;
        const coloredCols: Array<{ x: number; rgb: string }> = [];
        for (let x = 0; x < probe.width; x++) {
          const idx = x * 4;
          if (row[idx + 3] > 20) {
            coloredCols.push({
              x,
              rgb: `${row[idx] >> 4}:${row[idx + 1] >> 4}:${row[idx + 2] >> 4}`,
            });
          }
        }
        if (coloredCols.length >= 10) {
          const tailRgb = coloredCols[coloredCols.length - 1].rgb;
          let lastPlayedX = 0;
          for (const col of coloredCols) {
            if (col.rgb !== tailRgb) {
              lastPlayedX = col.x;
            }
          }
          if (lastPlayedX > 0) {
            return lastPlayedX / probe.width;
          }
        }
      }
    }

    return -1;
  });

  if (fromBubble >= 0) {
    return fromBubble;
  }

  if (await topBar.isVisible()) {
    return topBar.evaluate((el) => {
      const range = el.querySelector('input[type="range"]');
      if (range instanceof HTMLInputElement) {
        const min = Number(range.min || '0');
        const max = Number(range.max || '100');
        const val = Number(range.value);
        if (max > min && !Number.isNaN(val)) return (val - min) / (max - min);
      }
      const aria = el.querySelector(
        '[role="slider"][aria-valuenow], [role="progressbar"][aria-valuenow]',
      );
      if (aria instanceof HTMLElement) {
        const now = Number(aria.getAttribute('aria-valuenow'));
        const max = Number(aria.getAttribute('aria-valuemax') ?? '100');
        if (max > 0 && !Number.isNaN(now)) return now / max;
      }
      return -1;
    });
  }

  return -1;
}

test.describe(
  'F12 — 100-Bar 5-Bit Voice Notes, Round Video, Persistent Audio Bar & Headless Synth Fallback',
  () => {
    test('F12-01: #btn-record-voice records via headless Web Audio PCM .wav synthesizer fallback and sends a playable voice message bubble', async ({
      authPage,
    }) => {
      const pageErrors: Error[] = [];
      authPage.on('pageerror', (err) => pageErrors.push(err));

      await selectWritableChat(authPage);

      const voiceBubble = await recordAndSendVoiceNote(authPage);
      expect(pageErrors).toEqual([]);
      await expect(voiceBubble).toBeVisible();

      const playPauseBtn = await locatePlayPauseBtn(voiceBubble);
      await expect(playPauseBtn).toBeVisible();

      // Verify formatted duration (e.g. 0:02, 00:03)
      await expect(voiceBubble).toContainText(/\b\d{1,2}:\d{2}\b/);

      const waveform = await locateWaveformScrubber(voiceBubble);
      await expect(waveform).toBeVisible();
      const waveBox = await waveform.boundingBox();
      expect(waveBox).not.toBeNull();
      expect(waveBox!.width).toBeGreaterThanOrEqual(60);
      expect(waveBox!.height).toBeGreaterThanOrEqual(12);
    });

    test('F12-02: 100-bar 5-bit waveform bubble supports play/pause toggling and click-to-scrub seek progress updates', async ({
      authPage,
    }) => {
      await selectWritableChat(authPage);
      const voiceBubble = await recordAndSendVoiceNote(authPage, 2_800);

      // 1. Verify 100-bar 5-bit waveform structure (discrete >= 50 bars OR rendered waveform canvas)
      const hasValidWaveformStructure = await voiceBubble.evaluate((el) => {
        const barCounts = [
          el.querySelectorAll('[data-waveform-bar], [data-bar]').length,
          el.querySelectorAll('[class*="waveform" i] > span, [class*="waveform" i] > div, [class*="waveform" i] > i').length,
          el.querySelectorAll('svg rect, svg line').length,
        ];
        if (barCounts.some((c) => c >= 50)) {
          return true;
        }
        const canvas = el.querySelector('canvas');
        if (canvas instanceof HTMLCanvasElement && canvas.width >= 60) {
          const probe = document.createElement('canvas');
          probe.width = Math.min(64, canvas.width);
          probe.height = Math.max(1, Math.min(32, canvas.height));
          const ctx = probe.getContext('2d');
          if (!ctx) return false;
          ctx.drawImage(canvas, 0, 0, probe.width, probe.height);
          const data = ctx.getImageData(0, 0, probe.width, probe.height).data;
          for (let i = 3; i < data.length; i += 4) {
            if (data[i] > 10) return true;
          }
        }
        return false;
      });
      expect(hasValidWaveformStructure).toBe(true);

      // 2. Play toggle
      const playPauseBtn = await locatePlayPauseBtn(voiceBubble);
      await expect(playPauseBtn).toBeVisible();
      await playPauseBtn.click();

      const topBar = authPage.locator(DOM.topAudioPlayerBar);
      await expect
        .poll(
          async () => {
            if (await topBar.isVisible()) return true;
            return playPauseBtn.evaluate((el) => {
              if (!(el instanceof HTMLElement)) return false;
              const label = `${el.getAttribute('aria-label') ?? ''} ${el.textContent ?? ''}`;
              return (
                /\bpause\b|暂停|⏸/i.test(label) ||
                el.getAttribute('aria-pressed') === 'true' ||
                el.dataset.playing === 'true'
              );
            });
          },
          { timeout: 6_000 },
        )
        .toBe(true);

      // 3. Click-to-scrub seek at 15% vs 65% (with >= 2.8s duration leaving ~1s playback headroom)
      const waveform = await locateWaveformScrubber(voiceBubble);
      const box = await waveform.boundingBox();
      expect(box).not.toBeNull();

      await authPage.mouse.click(
        box!.x + box!.width * 0.15,
        box!.y + box!.height / 2,
      );
      await authPage.waitForTimeout(120);
      const ratioLow = await readVoiceProgressRatio(voiceBubble, topBar);

      await authPage.mouse.click(
        box!.x + box!.width * 0.65,
        box!.y + box!.height / 2,
      );
      await expect
        .poll(async () => readVoiceProgressRatio(voiceBubble, topBar), {
          message: 'Expected scrubbing waveform at 65% to advance playback progress ratio',
          timeout: 5_000,
        })
        .toBeGreaterThan(Math.max(0.35, ratioLow + 0.2));

      const ratioHigh = await readVoiceProgressRatio(voiceBubble, topBar);
      expect(ratioLow).toBeGreaterThanOrEqual(0);
      expect(ratioHigh).toBeGreaterThanOrEqual(0.4);
      expect(ratioHigh).toBeLessThanOrEqual(0.98);

      // 4. Pause toggle
      await playPauseBtn.click();
      await expect
        .poll(
          async () =>
            playPauseBtn.evaluate((el) => {
              if (!(el instanceof HTMLElement)) return false;
              const label = `${el.getAttribute('aria-label') ?? ''} ${el.textContent ?? ''}`;
              if (/\bplay\b|播放|▶/i.test(label) && !/\bpause\b|暂停/i.test(label)) {
                return true;
              }
              if (
                el.getAttribute('aria-pressed') === 'false' ||
                el.dataset.playing === 'false'
              ) {
                return true;
              }
              const docAudio = document.querySelector('audio');
              return docAudio instanceof HTMLAudioElement ? docAudio.paused : false;
            }),
          { timeout: 5_000 },
        )
        .toBe(true);
    });

    test('F12-03: voice note playback speed pill cycles 1x -> 1.5x -> 2x', async ({
      authPage,
    }) => {
      await selectWritableChat(authPage);
      const voiceBubble = await recordAndSendVoiceNote(authPage);

      const playBtn = await locatePlayPauseBtn(voiceBubble);
      await expect(playBtn).toBeVisible();
      await playBtn.click();

      const topBar = authPage.locator(DOM.topAudioPlayerBar);
      const speedScope = voiceBubble.or(topBar);
      const speedBtn = speedScope
        .getByRole('button', {
          name: /^(?:1(?:\.0)?x|1\.5x|2(?:\.0)?x)$/i,
        })
        .or(
          speedScope.getByRole('button', {
            name: bilingualRegex('speed|rate|playback', '倍速|语速|速度'),
          }),
        )
        .or(
          speedScope.locator(
            '[data-testid*="speed" i], [data-testid*="rate" i]',
          ),
        )
        .first();

      await expect(speedBtn).toBeVisible();
      await expect(speedBtn).toContainText(/1(?:\.0)?x/i);

      await speedBtn.click();
      await expect(speedBtn).toContainText(/1\.5x/i);

      await speedBtn.click();
      await expect(speedBtn).toContainText(/2(?:\.0)?x/i);

      const activeAudioRate = await authPage.evaluate(() => {
        const audio = document.querySelector('audio');
        return audio instanceof HTMLAudioElement ? audio.playbackRate : null;
      });
      if (activeAudioRate !== null) {
        expect(activeAudioRate).toBe(2);
      }
    });

    test('F12-04: ->A Voice-to-Text transcription toggle renders transcript text inside the voice bubble', async ({
      authPage,
    }) => {
      await selectWritableChat(authPage);
      const voiceBubble = await recordAndSendVoiceNote(authPage);

      const initialText = (await voiceBubble.innerText()).trim();

      const transcribeBtn = voiceBubble
        .getByRole('button', {
          name: /->\s*A|→\s*A|➔\s*A|transcribe|transcription|voice.*text|speech.*text|转文字|语音转文字|识别/i,
        })
        .or(
          voiceBubble.locator(
            '[data-testid*="transcribe" i], button[title*="transcribe" i], button[title*="转文字" i]',
          ),
        )
        .first();

      await expect(transcribeBtn).toBeVisible();
      await expect(transcribeBtn).toBeEnabled();
      await transcribeBtn.click();

      await expect
        .poll(
          async () => {
            const dedicatedTranscript = voiceBubble
              .locator(
                '[data-testid*="transcript" i], [data-transcription], [class*="transcript" i]',
              )
              .first();
            if (
              (await dedicatedTranscript.count()) > 0 &&
              (await dedicatedTranscript.isVisible())
            ) {
              const txt = (await dedicatedTranscript.innerText()).trim();
              if (
                txt.length >= 4 &&
                !/^(?:transcribing|converting|loading|\.\.\.|转换中|识别中|正在转)$/i.test(
                  txt,
                )
              ) {
                return true;
              }
            }

            const currentText = (await voiceBubble.innerText()).trim();
            return (
              currentText.length >= initialText.length + 4 &&
              !/transcribing\.\.\.|正在转文字\.\.\./i.test(currentText)
            );
          },
          {
            message:
              'Expected ->A Voice-to-Text toggle to render non-empty transcript inside voice bubble',
            timeout: 10_000,
          },
        )
        .toBe(true);
    });

    test('F12-05: 240px circular Round Video note renders circular geometry and plays inline', async ({
      authPage,
    }) => {
      const chatList = authPage.locator(DOM.chatList);
      await expect(chatList).toBeVisible();

      const findCircularRoundVideoInCurrentChat = async (): Promise<Locator | null> => {
        const candidates = authPage
          .locator(DOM.messageList)
          .locator(DOM.messageBubble)
          .locator(
            'video, [data-testid*="round-video" i], [data-testid*="video-note" i], [data-media-type*="round" i], [data-media-type*="video_note" i], [class*="round-video" i], [class*="video-note" i]',
          );
        const cnt = await candidates.count();
        for (let i = 0; i < cnt; i++) {
          const el = candidates.nth(i);
          if (!(await el.isVisible())) continue;
          const isCircular240 = await el.evaluate((node) => {
            const checkNode = (target: Element): boolean => {
              const r = target.getBoundingClientRect();
              if (
                r.width < 160 ||
                r.width > 300 ||
                Math.abs(r.width - r.height) > 8
              ) {
                return false;
              }
              const st = window.getComputedStyle(target);
              const radRaw = st.borderTopLeftRadius;
              const isPctCircle =
                radRaw.includes('%') && parseFloat(radRaw) >= 45;
              const isPxCircle = parseFloat(radRaw) >= r.width * 0.42;
              const isClipCircle = (st.clipPath || '').includes('circle');
              return isPctCircle || isPxCircle || isClipCircle;
            };
            return (
              checkNode(node) ||
              (node.parentElement !== null && checkNode(node.parentElement))
            );
          });
          if (isCircular240) {
            return el;
          }
        }
        return null;
      };

      let roundVideoEl: Locator | null = null;

      // 1. Check seeded chats for an existing circular Round Video note
      const rowCount = await chatList.locator(DOM.chatRow).count();
      const scanLimit = Math.min(rowCount, 7);
      for (let i = 0; i < scanLimit; i++) {
        await selectChat(authPage, i);
        roundVideoEl = await findCircularRoundVideoInCurrentChat();
        if (roundVideoEl) break;
      }

      // 2. If not pre-seeded, record a Round Video note in a writable chat
      if (!roundVideoEl) {
        await selectWritableChat(authPage);
        const messageList = authPage.locator(DOM.messageList);
        const countBefore = await messageList.locator(DOM.messageBubble).count();

        const roundModeSwitch = authPage
          .locator(DOM.middleColumn)
          .getByRole('button', {
            name: /round\s*video|video\s*note|video\s*message|switch.*video|camera|圆形视频|视频消息|视频留言|切换.*视频/i,
          })
          .or(
            authPage.locator(
              '[data-testid*="round-video" i], [data-testid*="video-mode" i]',
            ),
          )
          .first();

        if (
          (await roundModeSwitch.count()) > 0 &&
          (await roundModeSwitch.isVisible())
        ) {
          await roundModeSwitch.click();
          await recordAndSendVoiceNote(authPage);
        } else {
          // Check #btn-attach-menu for Round Video / Video Note option
          await authPage.locator(DOM.btnAttachMenu).click();
          const attachMenu = authPage
            .locator('[role="menu"], [role="dialog"], [data-testid*="attach" i]')
            .filter({ hasNot: authPage.locator(DOM.chatList) })
            .first();
          const roundVideoLabelRe =
            /round\s*video|video\s*note|video\s*message|圆形视频|视频消息|视频留言/i;
          const roundMenuItem = scopedMenuItem(attachMenu, roundVideoLabelRe)
            .or(scopedMenuItem(authPage, roundVideoLabelRe))
            .first();

          if (
            (await roundMenuItem.count()) > 0 &&
            (await roundMenuItem.isVisible())
          ) {
            await roundMenuItem.click();
            await authPage.waitForTimeout(1_250);
            const sendModalBtn = scopedButton(
              authPage,
              bilingualRegex('send|stop.*send|finish', '发送|完成'),
            ).last();
            if (
              (await sendModalBtn.count()) > 0 &&
              (await sendModalBtn.isVisible())
            ) {
              await sendModalBtn.click();
            }
          } else {
            await authPage.keyboard.press('Escape');
            // Short tap (<150ms) on #btn-record-voice switches mic -> camera mode in Telegram Web
            await authPage.locator(DOM.btnRecordVoice).click({ delay: 40 });
            await authPage.waitForTimeout(150);
            await recordAndSendVoiceNote(authPage);
          }
        }

        await expect
          .poll(async () => messageList.locator(DOM.messageBubble).count(), {
            timeout: 10_000,
          })
          .toBeGreaterThan(countBefore);

        roundVideoEl = await findCircularRoundVideoInCurrentChat();
      }

      expect(roundVideoEl).not.toBeNull();
      await expect(roundVideoEl!).toBeVisible();

      const geometry = await roundVideoEl!.evaluate((node) => {
        const inspect = (target: Element) => {
          const r = target.getBoundingClientRect();
          const st = window.getComputedStyle(target);
          const radRaw = st.borderTopLeftRadius;
          const isCircular =
            (radRaw.includes('%') && parseFloat(radRaw) >= 45) ||
            parseFloat(radRaw) >= r.width * 0.42 ||
            (st.clipPath || '').includes('circle');
          return { width: r.width, height: r.height, isCircular };
        };
        const selfGeom = inspect(node);
        if (selfGeom.isCircular) return selfGeom;
        if (node.parentElement) return inspect(node.parentElement);
        return selfGeom;
      });

      expect(Math.abs(geometry.width - geometry.height)).toBeLessThanOrEqual(6);
      expect(geometry.width).toBeGreaterThanOrEqual(180);
      expect(geometry.width).toBeLessThanOrEqual(280);
      expect(geometry.isCircular).toBe(true);

      // Click Round Video player and verify inline playback engages
      await roundVideoEl!.click();
      await expect
        .poll(
          async () =>
            roundVideoEl!.evaluate((node) => {
              const bubble = node.closest('[data-testid="message-bubble"]') ?? node;
              const video =
                node instanceof HTMLVideoElement
                  ? node
                  : bubble.querySelector('video');
              if (
                video instanceof HTMLVideoElement &&
                (!video.paused || video.currentTime > 0)
              ) {
                return true;
              }
              return (
                bubble.querySelector('[data-playing="true"], [aria-pressed="true"]') !==
                  null ||
                /\bpause\b|暂停|⏸/i.test(bubble.textContent ?? '')
              );
            }),
          { timeout: 6_000 },
        )
        .toBe(true);
    });

    test('F12-06: persistent #top-audio-player-bar remains active and interactive across chat switches', async ({
      authPage,
    }) => {
      const chatA = await selectWritableChat(authPage);
      const voiceBubble = await recordAndSendVoiceNote(authPage, 2_800);

      const playBtn = await locatePlayPauseBtn(voiceBubble);
      await expect(playBtn).toBeVisible();
      await playBtn.click();

      const topBar = authPage.locator(DOM.topAudioPlayerBar);
      await expect(topBar).toBeVisible();

      // Switch to a distinct Chat B
      const chatList = authPage.locator(DOM.chatList);
      const rows = chatList.locator(DOM.chatRow);
      const rowCount = await rows.count();
      expect(rowCount).toBeGreaterThanOrEqual(2);

      let switchedTitle = chatA.title;
      for (let i = 0; i < Math.min(rowCount, 10); i++) {
        const candidate = rows.nth(i);
        const cid = (await candidate.getAttribute(DATA_ATTRS.chatId)) ?? '';
        if (chatA.chatId && cid === chatA.chatId) continue;
        await selectChat(authPage, i);
        switchedTitle = (await authPage.locator(DOM.chatHeaderTitle).innerText()).trim();
        if (switchedTitle !== chatA.title) break;
      }

      expect(switchedTitle).not.toBe(chatA.title);
      await expect(topBar).toBeVisible();

      // Toggle Play/Pause directly on #top-audio-player-bar while viewing Chat B
      const topToggleBtn = await locatePlayPauseBtn(topBar);
      await expect(topToggleBtn).toBeVisible();
      await topToggleBtn.click();
      await expect(topBar).toBeVisible();

      // Dismiss #top-audio-player-bar via its Close button (prioritizing semantic close button)
      const semanticCloseBtn = scopedButton(
        topBar,
        bilingualRegex('close|dismiss|stop', '关闭|停止|取消'),
      );
      const attrCloseBtn = topBar.locator(
        'button[aria-label*="close" i], button[aria-label*="关闭" i], [data-testid*="close" i]',
      );
      let closeBarBtn = topBar.locator('button').last();
      if (
        (await semanticCloseBtn.count()) > 0 &&
        (await semanticCloseBtn.first().isVisible())
      ) {
        closeBarBtn = semanticCloseBtn.first();
      } else if (
        (await attrCloseBtn.count()) > 0 &&
        (await attrCloseBtn.first().isVisible())
      ) {
        closeBarBtn = attrCloseBtn.first();
      }
      await expect(closeBarBtn).toBeVisible();
      await closeBarBtn.click();
      await expect(topBar).toBeHidden();
    });
  },
);
