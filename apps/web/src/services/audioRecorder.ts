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
}

export interface ActiveVoiceRecorderSession {
  readonly startedAtMs: number;
  onLiveWaveform(listener: (bars: number[], elapsedSeconds: number) => void): () => void;
  stop(): Promise<VoiceRecordingResult>;
  cancel(): void;
}

export interface ActiveRoundVideoRecorderSession {
  readonly startedAtMs: number;
  readonly previewStream: MediaStream | null;
  readonly previewCanvas: HTMLCanvasElement | null;
  stop(): Promise<RoundVideoRecordingResult>;
  cancel(): void;
}

/**
 * Pure PCM utility: encodes Float32 mono PCM samples [-1, 1] into a valid 16-bit RIFF/WAVE `.wav` Blob.
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

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataByteLength, true);
  writeAscii(8, 'WAVE');

  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  writeAscii(36, 'data');
  view.setUint32(40, dataByteLength, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    const int16 = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    view.setInt16(offset, int16, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
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

function buildWaveformFromRollingPeaks(rollingPeaks: number[]): number[] {
  const bars = new Array<number>(TELEGRAM_WAVEFORM_BARS);
  for (let i = 0; i < TELEGRAM_WAVEFORM_BARS; i++) {
    if (rollingPeaks.length === 0) {
      bars[i] = 1;
    } else {
      const idx = Math.floor((i / TELEGRAM_WAVEFORM_BARS) * rollingPeaks.length);
      bars[i] = Math.max(1, Math.min(31, rollingPeaks[idx] ?? 1));
    }
  }
  return bars;
}

/**
 * Starts recording a real voice note using `navigator.mediaDevices.getUserMedia`.
 * Never synthesizes fake audio when microphone access is denied or unavailable.
 */
export async function startVoiceRecording(): Promise<ActiveVoiceRecorderSession> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.getUserMedia !== 'function'
  ) {
    throw new Error('Microphone permission denied: MediaDevices API unavailable · 无法访问麦克风权限');
  }
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('Voice recording unsupported: MediaRecorder API unavailable · 当前浏览器不支持语音录制');
  }

  let mediaStream: MediaStream;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err || 'NotAllowedError');
    throw new Error(`Microphone permission denied: ${msg} · 无法访问麦克风权限`);
  }

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
    if (analyser && sampleBuf) {
      analyser.getFloatTimeDomainData(sampleBuf);
      let sumSq = 0;
      for (let i = 0; i < sampleBuf.length; i++) {
        const s = sampleBuf[i] ?? 0;
        sumSq += s * s;
      }
      const rms = Math.sqrt(sumSq / sampleBuf.length);
      const barVal = Math.min(31, Math.max(1, Math.round(Math.pow(Math.min(1, rms * 4.5), 0.65) * 31)));
      rollingPeaks.push(barVal);
      emitLive(buildWaveformFromRollingPeaks(rollingPeaks));
    } else {
      rollingPeaks.push(1);
      emitLive(buildWaveformFromRollingPeaks(rollingPeaks));
    }
  }, 90);

  recorder.start(120);

  const cleanupMedia = (): void => {
    globalThis.clearInterval(liveTimer);
    for (const track of mediaStream.getTracks()) {
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
    onLiveWaveform(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async stop(): Promise<VoiceRecordingResult> {
      const elapsedSec = Math.max(1, (Date.now() - startedAtMs) / 1000);

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

      if (recordedBlob.size === 0) {
        throw new Error('Voice recording failed: no audio data captured · 未采集到有效音频数据');
      }

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

      if (waveformBars.length !== TELEGRAM_WAVEFORM_BARS) {
        waveformBars = buildWaveformFromRollingPeaks(rollingPeaks);
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
 * Starts recording a circular Video Note (240x240) using real camera/microphone devices.
 * Never fabricates a synthetic canvas stream or WAV fallback when permissions are denied.
 */
export async function startRoundVideoRecording(): Promise<ActiveRoundVideoRecorderSession> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.getUserMedia !== 'function'
  ) {
    throw new Error('Camera/microphone permission denied: MediaDevices API unavailable · 无法访问摄像头/麦克风权限');
  }
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('Video recording unsupported: MediaRecorder API unavailable · 当前浏览器不支持视频录制');
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 240, height: 240, facingMode: 'user' },
      audio: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err || 'NotAllowedError');
    throw new Error(`Camera/microphone permission denied: ${msg} · 无法访问摄像头/麦克风权限`);
  }

  const startedAtMs = Date.now();
  const chunks: BlobPart[] = [];
  const videoMime =
    typeof MediaRecorder.isTypeSupported === 'function' &&
    MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
      ? 'video/webm;codecs=vp8'
      : typeof MediaRecorder.isTypeSupported === 'function' &&
          MediaRecorder.isTypeSupported('video/webm')
        ? 'video/webm'
        : '';

  const recorder = videoMime
    ? new MediaRecorder(stream, { mimeType: videoMime })
    : new MediaRecorder(stream);
  recorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) chunks.push(ev.data);
  };
  recorder.start(150);

  const cleanup = (): void => {
    for (const t of stream.getTracks()) {
      try {
        t.stop();
      } catch {
        // Ignore
      }
    }
  };

  return {
    startedAtMs,
    previewStream: stream,
    previewCanvas: null,
    async stop(): Promise<RoundVideoRecordingResult> {
      const elapsedSec = Math.max(1, (Date.now() - startedAtMs) / 1000);
      if (recorder.state !== 'inactive') {
        await new Promise<void>((resolve) => {
          recorder.addEventListener('stop', () => resolve(), { once: true });
          try {
            recorder.stop();
          } catch {
            resolve();
          }
        });
      }
      cleanup();

      const recordedMime = recorder.mimeType || videoMime || 'video/webm';
      const recordedVideo = new Blob(chunks, { type: recordedMime });
      if (recordedVideo.size === 0) {
        throw new Error('Video note recording failed: no video data captured · 未采集到有效视频数据');
      }

      const emptyBars = new Array<number>(TELEGRAM_WAVEFORM_BARS).fill(1);
      return {
        blob: recordedVideo,
        fileName: `round_video_${Date.now()}.webm`,
        mimeType: recordedMime,
        durationSeconds: Math.max(1, Math.round(elapsedSec)),
        width: 240,
        height: 240,
        waveformBars: emptyBars,
        waveformBase64: encodeWaveformBase64(emptyBars),
      };
    },
    cancel(): void {
      try {
        if (recorder.state !== 'inactive') recorder.stop();
      } catch {
        // Ignore
      }
      cleanup();
    },
  };
}
