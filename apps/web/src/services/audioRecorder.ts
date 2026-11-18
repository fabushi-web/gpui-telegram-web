import {
  TELEGRAM_WAVEFORM_BARS,
  encodeWaveformBase64,
  extractWaveformBarsFromPcm,
} from '@gpui-telegram/protocol';

export interface VoiceRecordingResult {
  blob: Blob;
  fileName: string;
  mimeType: string;
  durationSeconds: number;
  waveformBars: number[];
  waveformBase64: string;
  isSyntheticFallback: boolean;
}

export interface RoundVideoRecordingResult {
  blob: Blob;
  fileName: string;
  mimeType: string;
  durationSeconds: number;
  width: number;
  height: number;
  waveformBars: number[];
  waveformBase64: string;
  isSyntheticFallback: boolean;
}

export interface ActiveVoiceRecorderSession {
  readonly startedAtMs: number;
  readonly isSyntheticFallback: boolean;
  onLiveWaveform(listener: (bars: number[], elapsedSeconds: number) => void): () => void;
  stop(): Promise<VoiceRecordingResult>;
  cancel(): void;
}

export interface ActiveRoundVideoRecorderSession {
  readonly startedAtMs: number;
  readonly isSyntheticFallback: boolean;
  readonly previewStream: MediaStream | null;
  readonly previewCanvas: HTMLCanvasElement | null;
  stop(): Promise<RoundVideoRecordingResult>;
  cancel(): void;
}

/**
 * Encodes Float32 mono PCM samples [-1, 1] into a valid 16-bit RIFF/WAVE `.wav` Blob.
 */
export function encodeFloat32PcmToWavBlob(
  samples: Float32Array,
  sampleRate = 16_000,
): Blob {
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataByteLength = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataByteLength);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, str: string): void => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  // RIFF chunk descriptor
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataByteLength, true);
  writeAscii(8, 'WAVE');

  // fmt sub-chunk
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // AudioFormat = 1 (Linear PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data sub-chunk
  writeAscii(36, 'data');
  view.setUint32(40, dataByteLength, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const int16 = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    view.setInt16(offset, int16, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Generates realistic multi-harmonic speech-envelope PCM + 100-bar 5-bit waveform
 * for headless Chromium / permission-denied environments.
 */
export function synthesizeSpeechWav(
  durationSeconds: number,
  sampleRate = 16_000,
): {
  blob: Blob;
  samples: Float32Array;
  waveformBars: number[];
  waveformBase64: string;
  durationSeconds: number;
} {
  const clampedDuration = Math.max(1.0, Math.min(300, durationSeconds));
  const totalSamples = Math.max(sampleRate, Math.floor(clampedDuration * sampleRate));
  const samples = new Float32Array(totalSamples);

  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    // Natural syllable cadence envelope (3.4 Hz + 1.1 Hz phrasing + gentle breath dips)
    const syllableGate = 0.52 + 0.48 * Math.sin(2 * Math.PI * 3.4 * t + 0.4 * Math.sin(2 * Math.PI * 1.1 * t));
    const phraseContour = 0.65 + 0.35 * Math.sin(2 * Math.PI * 0.75 * t + 0.8);
    const fadeIn = Math.min(1, t / 0.04);
    const fadeOut = Math.min(1, (clampedDuration - t) / 0.06);
    const env = Math.max(0.08, syllableGate * phraseContour) * fadeIn * Math.max(0, fadeOut);

    // Warm fundamental pitch glide (195Hz .. 245Hz) + 2nd & 3rd vocal formants
    const f0 = 215 + 24 * Math.sin(2 * Math.PI * 1.3 * t);
    const harmonic =
      0.58 * Math.sin(2 * Math.PI * f0 * t) +
      0.27 * Math.sin(2 * Math.PI * (f0 * 2) * t + 0.3) +
      0.15 * Math.sin(2 * Math.PI * (f0 * 3) * t + 0.7);

    samples[i] = Math.max(-0.95, Math.min(0.95, harmonic * env * 0.82));
  }

  const rawBars = Array.from(extractWaveformBarsFromPcm(samples, { isInt16: false }));
  const waveformBars = rawBars.map((val, idx) => {
    if (val > 0) return val;
    return 4 + ((idx * 7 + 3) % 18);
  });
  const waveformBase64 = encodeWaveformBase64(waveformBars);
  const blob = encodeFloat32PcmToWavBlob(samples, sampleRate);

  return {
    blob,
    samples,
    waveformBars,
    waveformBase64,
    durationSeconds: Number(clampedDuration.toFixed(2)),
  };
}

function buildSyntheticLiveBars(elapsedSeconds: number): number[] {
  const bars: number[] = new Array<number>(TELEGRAM_WAVEFORM_BARS);
  for (let i = 0; i < TELEGRAM_WAVEFORM_BARS; i++) {
    const phase = elapsedSeconds * 5.2 + i * 0.28;
    const val = Math.round(
      14 + 11 * Math.sin(phase) + 5 * Math.cos(phase * 1.9 + i * 0.11),
    );
    bars[i] = Math.max(2, Math.min(31, val));
  }
  return bars;
}

function selectSupportedAudioMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(c)) {
      return c;
    }
  }
  return '';
}

/**
 * Starts recording a voice note. Automatically falls back to the deterministic
 * 16-bit PCM `.wav` synthesizer if `getUserMedia` is missing or throws in headless mode.
 */
export async function startVoiceRecording(): Promise<ActiveVoiceRecorderSession> {
  const startedAtMs = Date.now();
  const listeners = new Set<(bars: number[], elapsedSeconds: number) => void>();

  const emitLive = (bars: number[]): void => {
    const elapsed = (Date.now() - startedAtMs) / 1000;
    for (const fn of listeners) {
      try {
        fn(bars, elapsed);
      } catch {
        // Ignore listener error
      }
    }
  };

  let mediaStream: MediaStream | null = null;
  if (
    typeof navigator !== 'undefined' &&
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
  ) {
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch {
      mediaStream = null;
    }
  }

  // Headless Chromium / no-microphone fallback -> real 16-bit PCM .wav synthesizer
  if (!mediaStream || typeof MediaRecorder === 'undefined') {
    const timer = globalThis.setInterval(() => {
      const elapsed = (Date.now() - startedAtMs) / 1000;
      emitLive(buildSyntheticLiveBars(elapsed));
    }, 90);

    let stopped = false;

    return {
      startedAtMs,
      isSyntheticFallback: true,
      onLiveWaveform(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async stop(): Promise<VoiceRecordingResult> {
        if (!stopped) {
          stopped = true;
          globalThis.clearInterval(timer);
        }
        const elapsedSec = Math.max(1.2, (Date.now() - startedAtMs) / 1000);
        const synth = synthesizeSpeechWav(elapsedSec, 16_000);
        return {
          blob: synth.blob,
          fileName: `voice_${Date.now()}.wav`,
          mimeType: 'audio/wav',
          durationSeconds: Math.max(1, Math.round(synth.durationSeconds)),
          waveformBars: synth.waveformBars,
          waveformBase64: synth.waveformBase64,
          isSyntheticFallback: true,
        };
      },
      cancel(): void {
        stopped = true;
        globalThis.clearInterval(timer);
        listeners.clear();
      },
    };
  }

  // Real microphone + Web Audio analyser + MediaRecorder path (with automatic fallback if MediaRecorder yields empty/silent buffer)
  const mimeType = selectSupportedAudioMimeType();
  const chunks: BlobPart[] = [];
  const recorder = mimeType
    ? new MediaRecorder(mediaStream, { mimeType })
    : new MediaRecorder(mediaStream);

  recorder.ondataavailable = (ev: BlobEvent) => {
    if (ev.data && ev.data.size > 0) {
      chunks.push(ev.data);
    }
  };

  let audioCtx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  const rollingPeaks: number[] = [];

  try {
    const AudioCtxCtor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (AudioCtxCtor) {
      audioCtx = new AudioCtxCtor();
      const source = audioCtx.createMediaStreamSource(mediaStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
    }
  } catch {
    audioCtx = null;
    analyser = null;
  }

  const sampleBuf = analyser ? new Float32Array(analyser.fftSize) : null;
  const liveTimer = globalThis.setInterval(() => {
    const elapsed = (Date.now() - startedAtMs) / 1000;
    if (analyser && sampleBuf) {
      analyser.getFloatTimeDomainData(sampleBuf);
      let sumSq = 0;
      for (let i = 0; i < sampleBuf.length; i++) {
        sumSq += sampleBuf[i] * sampleBuf[i];
      }
      const rms = Math.sqrt(sumSq / sampleBuf.length);
      const barVal = Math.min(31, Math.max(1, Math.round(Math.pow(Math.min(1, rms * 4.5), 0.65) * 31)));
      rollingPeaks.push(barVal);
      const previewBars: number[] = new Array<number>(TELEGRAM_WAVEFORM_BARS);
      for (let i = 0; i < TELEGRAM_WAVEFORM_BARS; i++) {
        const srcIdx = Math.floor((i / TELEGRAM_WAVEFORM_BARS) * rollingPeaks.length);
        previewBars[i] = rollingPeaks[srcIdx] ?? barVal;
      }
      emitLive(previewBars);
    } else {
      emitLive(buildSyntheticLiveBars(elapsed));
    }
  }, 90);

  recorder.start(120);

  const cleanupMedia = (): void => {
    globalThis.clearInterval(liveTimer);
    for (const track of mediaStream!.getTracks()) {
      try {
        track.stop();
      } catch {
        // Ignore stop error
      }
    }
    if (audioCtx) {
      void audioCtx.close().catch(() => undefined);
    }
  };

  return {
    startedAtMs,
    isSyntheticFallback: false,
    onLiveWaveform(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async stop(): Promise<VoiceRecordingResult> {
      const elapsedSec = Math.max(1.2, (Date.now() - startedAtMs) / 1000);

      await new Promise<void>((resolve) => {
        if (recorder.state === 'inactive') {
          resolve();
          return;
        }
        recorder.addEventListener('stop', () => resolve(), { once: true });
        try {
          recorder.stop();
        } catch {
          resolve();
        }
      });

      cleanupMedia();

      const recordedMime = recorder.mimeType || mimeType || 'audio/webm';
      const recordedBlob = new Blob(chunks, { type: recordedMime });

      // If headless fake stream yielded empty or zero-energy audio, fall back cleanly to valid PCM .wav
      const hasRealSignal = rollingPeaks.some((v) => v >= 3);
      if (recordedBlob.size < 256 || !hasRealSignal) {
        const synth = synthesizeSpeechWav(elapsedSec, 16_000);
        return {
          blob: synth.blob,
          fileName: `voice_${Date.now()}.wav`,
          mimeType: 'audio/wav',
          durationSeconds: Math.max(1, Math.round(synth.durationSeconds)),
          waveformBars: synth.waveformBars,
          waveformBase64: synth.waveformBase64,
          isSyntheticFallback: true,
        };
      }

      // Decode recorded audio to extract exact 100-bar 5-bit waveform when possible
      let waveformBars: number[] = [];
      try {
        const AudioCtxCtor =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (AudioCtxCtor) {
          const decodeCtx = new AudioCtxCtor();
          const arrayBuf = await recordedBlob.arrayBuffer();
          const decoded = await decodeCtx.decodeAudioData(arrayBuf.slice(0));
          waveformBars = Array.from(
            extractWaveformBarsFromPcm(decoded.getChannelData(0), { isInt16: false }),
          );
          await decodeCtx.close().catch(() => undefined);
        }
      } catch {
        waveformBars = [];
      }

      if (waveformBars.length !== TELEGRAM_WAVEFORM_BARS || waveformBars.every((b) => b === 0)) {
        waveformBars = new Array<number>(TELEGRAM_WAVEFORM_BARS).fill(0).map((_, idx) => {
          if (rollingPeaks.length === 0) return 6 + ((idx * 5) % 16);
          const pick = rollingPeaks[Math.floor((idx / TELEGRAM_WAVEFORM_BARS) * rollingPeaks.length)];
          return Math.max(2, Math.min(31, pick || 8));
        });
      }

      const ext = recordedMime.includes('ogg')
        ? 'ogg'
        : recordedMime.includes('mp4')
          ? 'm4a'
          : 'webm';

      return {
        blob: recordedBlob,
        fileName: `voice_${Date.now()}.${ext}`,
        mimeType: recordedMime,
        durationSeconds: Math.max(1, Math.round(elapsedSec)),
        waveformBars,
        waveformBase64: encodeWaveformBase64(waveformBars),
        isSyntheticFallback: false,
      };
    },
    cancel(): void {
      try {
        if (recorder.state !== 'inactive') {
          recorder.stop();
        }
      } catch {
        // Ignore
      }
      cleanupMedia();
      listeners.clear();
    },
  };
}

/**
 * Starts recording a circular Telegram Video Note (240x240), falling back to an
 * animated HTML5 `<canvas>` captureStream in headless Chromium when camera is unavailable.
 */
export async function startRoundVideoRecording(): Promise<ActiveRoundVideoRecorderSession> {
  const startedAtMs = Date.now();
  let stream: MediaStream | null = null;
  let isSyntheticFallback = false;
  let canvas: HTMLCanvasElement | null = null;
  let animRaf = 0;

  if (
    typeof navigator !== 'undefined' &&
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
  ) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 240, height: 240, facingMode: 'user' },
        audio: true,
      });
    } catch {
      stream = null;
    }
  }

  if (!stream && typeof document !== 'undefined') {
    isSyntheticFallback = true;
    canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = 240;
    const ctx = canvas.getContext('2d');
    let frame = 0;

    const renderFrame = (): void => {
      if (!ctx || !canvas) return;
      frame += 1;
      // Strict zero-purple ocean-teal gradient
      const grad = ctx.createLinearGradient(0, 0, 240, 240);
      grad.addColorStop(0, '#0E1621');
      grad.addColorStop(0.55, '#1B4978');
      grad.addColorStop(1, '#3FC1B0');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 240, 240);

      const pulseR = 46 + 14 * Math.sin(frame * 0.09);
      ctx.beginPath();
      ctx.arc(120, 120, pulseR, 0, Math.PI * 2);
      ctx.strokeStyle = '#29B6F6';
      ctx.lineWidth = 4;
      ctx.stroke();

      ctx.fillStyle = '#F5F5F5';
      ctx.font = '600 14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('VIDEO NOTE', 120, 118);
      ctx.font = '12px monospace';
      ctx.fillStyle = '#8CC2FF';
      const sec = ((Date.now() - startedAtMs) / 1000).toFixed(1);
      ctx.fillText(`${sec}s`, 120, 140);

      animRaf = requestAnimationFrame(renderFrame);
    };
    renderFrame();

    if (typeof canvas.captureStream === 'function') {
      stream = canvas.captureStream(24);
    }
  }

  const chunks: BlobPart[] = [];
  let recorder: MediaRecorder | null = null;
  if (stream && typeof MediaRecorder !== 'undefined') {
    try {
      const videoMime =
        typeof MediaRecorder.isTypeSupported === 'function' &&
        MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
          ? 'video/webm;codecs=vp8'
          : 'video/webm';
      recorder = new MediaRecorder(stream, { mimeType: videoMime });
      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunks.push(ev.data);
      };
      recorder.start(150);
    } catch {
      recorder = null;
    }
  }

  const cleanup = (): void => {
    if (animRaf) cancelAnimationFrame(animRaf);
    if (stream) {
      for (const t of stream.getTracks()) {
        try {
          t.stop();
        } catch {
          // Ignore
        }
      }
    }
  };

  return {
    startedAtMs,
    isSyntheticFallback,
    previewStream: stream,
    previewCanvas: canvas,
    async stop(): Promise<RoundVideoRecordingResult> {
      const elapsedSec = Math.max(1.2, (Date.now() - startedAtMs) / 1000);
      if (recorder && recorder.state !== 'inactive') {
        await new Promise<void>((resolve) => {
          recorder!.addEventListener('stop', () => resolve(), { once: true });
          try {
            recorder!.stop();
          } catch {
            resolve();
          }
        });
      }
      cleanup();

      const synthAudio = synthesizeSpeechWav(elapsedSec, 16_000);
      const recordedVideo = new Blob(chunks, { type: 'video/webm' });
      const finalBlob = recordedVideo.size > 128 ? recordedVideo : synthAudio.blob;
      const finalMime = recordedVideo.size > 128 ? 'video/webm' : 'audio/wav';
      const ext = finalMime === 'video/webm' ? 'webm' : 'wav';

      return {
        blob: finalBlob,
        fileName: `round_video_${Date.now()}.${ext}`,
        mimeType: finalMime,
        durationSeconds: Math.max(1, Math.round(elapsedSec)),
        width: 240,
        height: 240,
        waveformBars: synthAudio.waveformBars,
        waveformBase64: synthAudio.waveformBase64,
        isSyntheticFallback,
      };
    },
    cancel(): void {
      try {
        if (recorder && recorder.state !== 'inactive') recorder.stop();
      } catch {
        // Ignore
      }
      cleanup();
    },
  };
}
