import { crc32, deflateSync } from 'node:zlib';

export interface PngBufferOptions {
  width?: number;
  height?: number;
  r?: number;
  g?: number;
  b?: number;
  a?: number;
  pattern?: 'solid' | 'gradient';
}

export interface WavBufferOptions {
  durationMs?: number;
  frequencyHz?: number;
  sampleRate?: number;
}

export interface InMemoryFilePayload {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function buildPngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const lengthBuf = Buffer.alloc(4);
  lengthBuf.writeUInt32BE(data.length, 0);

  const crcInput = Buffer.concat([typeBuf, data]);
  const crcUnsigned = crc32(crcInput) >>> 0;
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crcUnsigned, 0);

  return Buffer.concat([lengthBuf, typeBuf, data, crcBuf]);
}

/**
 * Generates a valid CRC32-signed 8-bit RGBA PNG Buffer purely in memory via `node:zlib`.
 * Defaults to 64x64 Apple Blue (#0A84FF: r=10, g=132, b=255, a=255).
 */
export function createPngBuffer(options: PngBufferOptions = {}): Buffer {
  const width = Math.max(1, Math.min(4096, Math.floor(options.width ?? 64)));
  const height = Math.max(1, Math.min(4096, Math.floor(options.height ?? 64)));
  const baseR = (options.r ?? 10) & 0xff;
  const baseG = (options.g ?? 132) & 0xff;
  const baseB = (options.b ?? 255) & 0xff;
  const baseA = (options.a ?? 255) & 0xff;
  const pattern = options.pattern ?? 'solid';

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8-bit channel depth
  ihdr[9] = 6; // RGBA color type
  ihdr[10] = 0; // zlib deflate compression
  ihdr[11] = 0; // standard adaptive filtering
  ihdr[12] = 0; // non-interlaced

  const rowStride = 1 + width * 4;
  const rawScanlines = Buffer.alloc(rowStride * height);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowStride;
    rawScanlines[rowOffset] = 0;
    for (let x = 0; x < width; x++) {
      const px = rowOffset + 1 + x * 4;
      if (pattern === 'gradient') {
        rawScanlines[px] =
          (baseR + Math.floor((x / Math.max(1, width - 1)) * 40)) & 0xff;
        rawScanlines[px + 1] =
          (baseG + Math.floor((y / Math.max(1, height - 1)) * 40)) & 0xff;
        rawScanlines[px + 2] = baseB;
        rawScanlines[px + 3] = baseA;
      } else {
        rawScanlines[px] = baseR;
        rawScanlines[px + 1] = baseG;
        rawScanlines[px + 2] = baseB;
        rawScanlines[px + 3] = baseA;
      }
    }
  }

  const compressedIdat = deflateSync(rawScanlines);

  return Buffer.concat([
    PNG_SIGNATURE,
    buildPngChunk('IHDR', ihdr),
    buildPngChunk('IDAT', compressedIdat),
    buildPngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Generates a valid 16-bit mono PCM RIFF WAVE (.wav) Buffer purely in memory
 * with an amplitude-modulated sine envelope suitable for 100-bar 5-bit waveform extraction.
 */
export function createWavBuffer(options: WavBufferOptions = {}): Buffer {
  const durationMs = Math.max(50, Math.floor(options.durationMs ?? 1200));
  const frequencyHz = options.frequencyHz ?? 440;
  const sampleRate = Math.max(8000, Math.floor(options.sampleRate ?? 16000));

  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const numSamples = Math.max(1, Math.floor((sampleRate * durationMs) / 1000));
  const dataByteLength = numSamples * numChannels * bytesPerSample;

  const wav = Buffer.alloc(44 + dataByteLength);
  wav.write('RIFF', 0, 4, 'ascii');
  wav.writeUInt32LE(36 + dataByteLength, 4);
  wav.write('WAVE', 8, 4, 'ascii');
  wav.write('fmt ', 12, 4, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(numChannels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * numChannels * bytesPerSample, 28);
  wav.writeUInt16LE(numChannels * bytesPerSample, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write('data', 36, 4, 'ascii');
  wav.writeUInt32LE(dataByteLength, 40);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const envelope =
      0.35 + 0.65 * Math.abs(Math.sin(Math.PI * 3 * (i / numSamples)));
    const sample = Math.sin(2 * Math.PI * frequencyHz * t) * envelope;
    const pcm16 = Math.max(-32767, Math.min(32767, Math.round(sample * 24000)));
    wav.writeInt16LE(pcm16, 44 + i * 2);
  }

  return wav;
}

function escapePdfAsciiTitle(input: string): string {
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0x3f;
    if (ch === '\\') out += '\\\\';
    else if (ch === '(') out += '\\(';
    else if (ch === ')') out += '\\)';
    else if (code >= 0x20 && code <= 0x7e) out += ch;
    else out += `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

/**
 * Generates a valid single-page `%PDF-1.4` document Buffer purely in memory
 * with exact byte-offset 20-byte `xref` table entries.
 */
export function createPdfBuffer(
  title = 'Fabushi Web E2E Document',
): Buffer {
  const safeTitle = escapePdfAsciiTitle(title);
  const streamContent = `BT\n/F1 16 Tf\n50 740 Td\n(${safeTitle}) Tj\nET\n`;
  const streamBytes = Buffer.from(streamContent, 'ascii');

  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${streamBytes.length} >>\nstream\n${streamContent}endstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];

  const header = Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'binary');
  const chunks: Buffer[] = [header];
  const offsets: number[] = [0];
  let cursor = header.length;

  for (const objStr of objects) {
    offsets.push(cursor);
    const objBuf = Buffer.from(objStr, 'ascii');
    chunks.push(objBuf);
    cursor += objBuf.length;
  }

  const xrefOffset = cursor;
  const xrefLines = [
    `xref\n0 ${objects.length + 1}\n`,
    '0000000000 65535 f \n',
  ];
  for (let i = 1; i < offsets.length; i++) {
    xrefLines.push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  }

  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  chunks.push(Buffer.from(xrefLines.join('') + trailer, 'ascii'));
  return Buffer.concat(chunks);
}

/**
 * Generates a UTF-8 plain-text Buffer purely in memory.
 */
export function createTextBuffer(
  content = 'Fabushi Web E2E plain-text fixture\n你好世界 — CJK UTF-8 line\n',
): Buffer {
  return Buffer.from(content, 'utf8');
}

/**
 * Generates deterministic non-image header bytes (neither PNG, JPEG, GIF, nor WebP)
 * for negative media-upload tests.
 */
export function createCorruptImageBuffer(): Buffer {
  return Buffer.from([
    0x00, 0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe, 0xba,
    0xbe, 0x43, 0x4f, 0x52, 0x52, 0x55, 0x50, 0x54,
    0x5f, 0x49, 0x4d, 0x41, 0x47, 0x45, 0x00, 0xff,
  ]);
}

export function createPngFilePayload(
  name = 'diagram.png',
  options?: PngBufferOptions,
): InMemoryFilePayload {
  return {
    name,
    mimeType: 'image/png',
    buffer: createPngBuffer(options),
  };
}

export function createWavFilePayload(
  name = 'voice-note.wav',
  options?: WavBufferOptions,
): InMemoryFilePayload {
  return {
    name,
    mimeType: 'audio/wav',
    buffer: createWavBuffer(options),
  };
}

export function createPdfFilePayload(
  name = 'release-gate.pdf',
  title?: string,
): InMemoryFilePayload {
  return {
    name,
    mimeType: 'application/pdf',
    buffer: createPdfBuffer(title),
  };
}

export function createTextFilePayload(
  name = 'notes.txt',
  content?: string,
): InMemoryFilePayload {
  return {
    name,
    mimeType: 'text/plain',
    buffer: createTextBuffer(content),
  };
}

export function createCorruptImageFilePayload(
  name = 'corrupt-photo.png',
): InMemoryFilePayload {
  return {
    name,
    mimeType: 'image/png',
    buffer: createCorruptImageBuffer(),
  };
}
