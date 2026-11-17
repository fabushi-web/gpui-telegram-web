/**
 * 100-Bar 5-Bit Voice Waveform Codec & PCM Peak Extractor.
 *
 * Exact mirror of `crates/gpui_telegram_media/src/waveform/{encoder,decoder,normalizer}.rs`
 * and Telegram Desktop `documentWaveformEncode5bit` / `documentWaveformDecode`:
 * - 100 bars quantized in `0..=31` (`5` bits each = `500` bits -> `63` bytes `Uint8Array`,
 *   packed LSB-first across 16-bit little-endian byte pairs with 4 trailing zero bits in byte 62).
 */

export const TELEGRAM_WAVEFORM_BARS = 100;
export const WAVEFORM_BIT_WIDTH = 5;
export const WAVEFORM_MAX_VALUE = 31; // (1 << 5) - 1
export const TELEGRAM_WAVEFORM_BYTES = 63; // Math.ceil((100 * 5) / 8)
export const PEAK_AVERAGE_RATIO = 1.8;
export const MINIMAL_PEAK_FLOOR = 2500;

/**
 * Packs up to 100 5-bit bar amplitudes (`0..31`) LSB-first into a compact `Uint8Array`
 * (`63` bytes when `bars.length >= 100`). If fewer than 100 bars are provided and
 * `padTo100` is true (default when encoding canonical 100-bar voice notes if desired,
 * or exact length if `padTo100 = false`), encodes `count` bars into `ceil(count * 5 / 8)` bytes.
 */
export function encodeWaveform5Bit(
  bars: ArrayLike<number>,
  options: { padTo100?: boolean } = {},
): Uint8Array {
  const padTo100 = options.padTo100 ?? false;
  const rawCount = Math.min(bars.length, TELEGRAM_WAVEFORM_BARS);
  const count = padTo100 ? TELEGRAM_WAVEFORM_BARS : rawCount;
  if (count === 0) {
    return new Uint8Array(0);
  }

  const bitsCount = count * WAVEFORM_BIT_WIDTH;
  const bytesCount = Math.floor((bitsCount + 7) / 8);
  // Extra guard byte allows safe 16-bit LE read-modify-write at the tail byte.
  const buffer = new Uint8Array(bytesCount + 1);

  for (let i = 0; i < count; i++) {
    const rawVal = i < rawCount ? (bars[i] ?? 0) : 0;
    const clamped = Math.max(
      0,
      Math.min(WAVEFORM_MAX_VALUE, Number.isFinite(rawVal) ? Math.round(rawVal) : 0),
    );
    const byteIndex = Math.floor((i * WAVEFORM_BIT_WIDTH) / 8);
    const bitShift = (i * WAVEFORM_BIT_WIDTH) % 8;

    const shifted = (clamped & 0x1f) << bitShift;
    const previous = (buffer[byteIndex] ?? 0) | ((buffer[byteIndex + 1] ?? 0) << 8);
    const combined = previous | shifted;
    buffer[byteIndex] = combined & 0xff;
    buffer[byteIndex + 1] = (combined >> 8) & 0xff;
  }

  return buffer.slice(0, bytesCount);
}

/**
 * Unpacks a 5-bit LSB-first encoded waveform `Uint8Array` back into quantized bar amplitudes (`0..31`).
 * For a standard 63-byte Telegram waveform (`504` bits), `Math.floor(504 / 5) = 100` bars.
 */
export function decodeWaveform5Bit(encoded: ArrayLike<number>): Uint8Array {
  const byteLen = encoded.length;
  const bitsCount = byteLen * 8;
  const valuesCount = Math.floor(bitsCount / WAVEFORM_BIT_WIDTH);
  if (valuesCount === 0) {
    return new Uint8Array(0);
  }

  const result = new Uint8Array(valuesCount);
  for (let i = 0; i < valuesCount; i++) {
    const byteIndex = Math.floor((i * WAVEFORM_BIT_WIDTH) / 8);
    const bitShift = (i * WAVEFORM_BIT_WIDTH) % 8;
    const low = (encoded[byteIndex] ?? 0) & 0xff;
    const high = byteIndex + 1 < byteLen ? ((encoded[byteIndex + 1] ?? 0) & 0xff) : 0;
    const word16 = low | (high << 8);
    result[i] = (word16 >> bitShift) & 0x1f;
  }

  return result;
}

/**
 * Base64 helpers for JSON transport (`waveform_b64`).
 */
export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const normalized = b64.replace(/-/g, '+').replace(/_/g, '/');
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(normalized, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const binary = atob(normalized);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function encodeWaveformBase64(bars: ArrayLike<number>): string {
  return bytesToBase64(encodeWaveform5Bit(bars, { padTo100: bars.length === TELEGRAM_WAVEFORM_BARS }));
}

export function decodeWaveformBase64(b64: string): Uint8Array {
  return decodeWaveform5Bit(base64ToBytes(b64));
}

/**
 * Normalizes 16-bit unsigned magnitude peaks into 5-bit `0..31` bars using Telegram's
 * dynamic ceiling compression (`PEAK_AVERAGE_RATIO = 1.8`, `MINIMAL_PEAK_FLOOR = 2500`).
 */
export function normalizePcmPeaks(peaks: ArrayLike<number>): Uint8Array {
  if (peaks.length === 0) {
    return new Uint8Array(0);
  }
  const count = Math.min(peaks.length, TELEGRAM_WAVEFORM_BARS);
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const p = peaks[i] ?? 0;
    sum += Number.isFinite(p) ? Math.max(0, p) : 0;
  }

  const avgScaled = (sum * PEAK_AVERAGE_RATIO) / count;
  const dynamicCeiling = Math.max(MINIMAL_PEAK_FLOOR, Math.round(avgScaled));

  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const raw = peaks[i] ?? 0;
    const clamped = Math.min(
      Math.max(0, Number.isFinite(raw) ? Math.round(raw) : 0),
      dynamicCeiling,
    );
    out[i] = Math.min(WAVEFORM_MAX_VALUE, Math.floor((clamped * WAVEFORM_MAX_VALUE) / dynamicCeiling));
  }
  return out;
}

/**
 * Resamples arbitrary-length PCM samples (`Float32Array` in `[-1.0, 1.0]` OR `Int16Array` in `[-32768, 32767]`)
 * into exactly 100 5-bit bars (`0..31`) using Bresenham peak accumulation + dynamic ceiling compression.
 */
export function extractWaveformBarsFromPcm(
  samples: Float32Array | Int16Array | ArrayLike<number>,
  options: { isInt16?: boolean } = {},
): Uint8Array {
  const len = samples.length;
  if (len === 0) {
    return new Uint8Array(TELEGRAM_WAVEFORM_BARS);
  }

  const isInt16 = options.isInt16 ?? samples instanceof Int16Array;
  const toAbs16 = (val: number): number => {
    if (!Number.isFinite(val)) return 0;
    if (isInt16) {
      return Math.min(32767, Math.abs(Math.round(val)));
    }
    return Math.min(32767, Math.round(Math.min(1, Math.abs(val)) * 32767));
  };

  const peaks16 = new Uint16Array(TELEGRAM_WAVEFORM_BARS);

  if (len < TELEGRAM_WAVEFORM_BARS) {
    for (let i = 0; i < TELEGRAM_WAVEFORM_BARS; i++) {
      const srcIdx = Math.floor((i * len) / TELEGRAM_WAVEFORM_BARS);
      peaks16[i] = toAbs16(samples[srcIdx] ?? 0);
    }
  } else {
    let bucketIdx = 0;
    let acc = 0;
    let currentPeak = 0;

    for (let i = 0; i < len; i++) {
      const mag = toAbs16(samples[i] ?? 0);
      if (mag > currentPeak) {
        currentPeak = mag;
      }
      acc += TELEGRAM_WAVEFORM_BARS;
      if (acc >= len) {
        acc -= len;
        if (bucketIdx < TELEGRAM_WAVEFORM_BARS) {
          peaks16[bucketIdx] = currentPeak;
          bucketIdx++;
        }
        currentPeak = 0;
      }
    }

    const fallbackPeak = bucketIdx > 0 ? (peaks16[bucketIdx - 1] ?? 0) : currentPeak;
    while (bucketIdx < TELEGRAM_WAVEFORM_BARS) {
      peaks16[bucketIdx] = fallbackPeak;
      bucketIdx++;
    }
  }

  return normalizePcmPeaks(peaks16);
}

/**
 * Convenience pipeline: Float32 PCM -> 100 normalized bars -> 63-byte 5-bit encoded `Uint8Array`.
 */
export function extractWaveformFromFloat32Pcm(samples: Float32Array): Uint8Array {
  const bars = extractWaveformBarsFromPcm(samples, { isInt16: false });
  return encodeWaveform5Bit(bars, { padTo100: true });
}

export function resampleAndNormalizeWaveform(peaks: ArrayLike<number>): Uint8Array {
  return extractWaveformBarsFromPcm(peaks, { isInt16: true });
}

export function encodeWaveformFromFloats(peaks: ArrayLike<number>): Uint8Array {
  const count = Math.min(peaks.length, TELEGRAM_WAVEFORM_BARS);
  const bars = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const p = peaks[i] ?? 0;
    const clamped = Number.isFinite(p) ? Math.max(0, Math.min(1, p)) : 0;
    bars[i] = Math.round(clamped * WAVEFORM_MAX_VALUE);
  }
  return encodeWaveform5Bit(bars);
}

export function decodeWaveformToFloats(
  encoded: ArrayLike<number>,
  count = TELEGRAM_WAVEFORM_BARS,
): Float32Array {
  const decoded = decodeWaveform5Bit(encoded);
  const out = new Float32Array(count);
  const limit = Math.min(decoded.length, count);
  for (let i = 0; i < limit; i++) {
    out[i] = (decoded[i] ?? 0) / WAVEFORM_MAX_VALUE;
  }
  return out;
}
