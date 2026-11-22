import QRCode from 'qrcode';
import { escapeHtml } from './entities.js';

export type QrErrorCorrectionLevel = 'L' | 'M' | 'Q' | 'H';

export interface QrMatrix {
  size: number;
  modules: boolean[][];
}

/**
 * Generates a real ISO/IEC 18004 scannable QR code matrix using Reed-Solomon error correction.
 * Defaults to error-correction level `Q` (25% recovery), matching the GPUI desktop client so
 * Alipay and device pairing QR codes remain reliably scannable even with a centered brand badge.
 */
export function encodeQrMatrix(
  payload: string,
  ecLevel: QrErrorCorrectionLevel = 'Q',
): QrMatrix {
  const safePayload = payload && payload.length > 0 ? payload : 'https://ombhrum.com';
  const qr = QRCode.create(safePayload, { errorCorrectionLevel: ecLevel });
  const size = qr.modules.size;
  const modules: boolean[][] = Array.from({ length: size }, (_, r) =>
    Array.from({ length: size }, (_, c) => Boolean(qr.modules.get(r, c))),
  );
  return { size, modules };
}

export interface RenderQrSvgOptions {
  sizePx?: number;
  foreground?: string;
  background?: string;
  ecLevel?: QrErrorCorrectionLevel;
  quietZone?: number;
}

/**
 * Renders a standards-compliant scannable ISO/IEC 18004 QR code as a crisp SVG string.
 */
export function renderQrCodeSvg(
  payload: string,
  opts: RenderQrSvgOptions = {},
): string {
  const sizePx = opts.sizePx ?? 220;
  const foreground = opts.foreground ?? '#0E1621';
  const background = opts.background ?? '#FFFFFF';
  const quietZone = opts.quietZone ?? 4;
  const { size, modules } = encodeQrMatrix(payload, opts.ecLevel ?? 'Q');
  const viewDim = size + quietZone * 2;

  const rects: string[] = [];
  for (let r = 0; r < size; r += 1) {
    const row = modules[r]!;
    for (let c = 0; c < size; c += 1) {
      if (row[c]) {
        rects.push(`M${c + quietZone},${r + quietZone}h1v1h-1z`);
      }
    }
  }

  const safeLabel = escapeHtml(payload || 'QR Code');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewDim} ${viewDim}" width="${sizePx}" height="${sizePx}" role="img" aria-label="QR Code for ${safeLabel}" shape-rendering="crispEdges"><rect width="100%" height="100%" rx="2" fill="${background}"/><path d="${rects.join('')}" fill="${foreground}"/></svg>`;
}
