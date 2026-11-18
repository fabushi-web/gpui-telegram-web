import React, { useMemo } from 'react';

export interface QrMatrixSvgProps {
  id?: string;
  value: string;
  size?: number;
  foreground?: string;
  background?: string;
  accentColor?: string;
  className?: string;
}

const MATRIX_DIM = 25;
const QUIET_ZONE = 2;

function hashSeed(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0 || 0x9e3779b9;
}

function nextXorShift(state: number): number {
  let x = state >>> 0 || 1;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return x >>> 0;
}

function isInFinderZone(r: number, c: number, top: number, left: number): boolean {
  return r >= top - 1 && r <= top + 7 && c >= left - 1 && c <= left + 7;
}

function finderModuleDark(r: number, c: number, top: number, left: number): { dark: boolean; center: boolean } {
  const dr = r - top;
  const dc = c - left;
  if (dr < 0 || dr > 6 || dc < 0 || dc > 6) {
    return { dark: false, center: false };
  }
  if (dr === 0 || dr === 6 || dc === 0 || dc === 6) {
    return { dark: true, center: false };
  }
  if (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4) {
    return { dark: true, center: true };
  }
  return { dark: false, center: false };
}

export function buildDeterministicQrMatrix(
  payload: string,
): Array<Array<{ dark: boolean; accent: boolean }>> {
  const grid: Array<Array<{ dark: boolean; accent: boolean }>> = Array.from(
    { length: MATRIX_DIM },
    () => Array.from({ length: MATRIX_DIM }, () => ({ dark: false, accent: false })),
  );

  let rng = hashSeed(payload || 'gpui-telegram-qr');

  for (let r = 0; r < MATRIX_DIM; r += 1) {
    for (let c = 0; c < MATRIX_DIM; c += 1) {
      // Three 7x7 finder patterns with 1-cell quiet separator
      if (isInFinderZone(r, c, 0, 0)) {
        const m = finderModuleDark(r, c, 0, 0);
        grid[r][c] = { dark: m.dark, accent: m.center };
        continue;
      }
      if (isInFinderZone(r, c, 0, MATRIX_DIM - 7)) {
        const m = finderModuleDark(r, c, 0, MATRIX_DIM - 7);
        grid[r][c] = { dark: m.dark, accent: m.center };
        continue;
      }
      if (isInFinderZone(r, c, MATRIX_DIM - 7, 0)) {
        const m = finderModuleDark(r, c, MATRIX_DIM - 7, 0);
        grid[r][c] = { dark: m.dark, accent: m.center };
        continue;
      }

      // Timing lines on row 6 and column 6
      if (r === 6) {
        grid[r][c] = { dark: c % 2 === 0, accent: false };
        continue;
      }
      if (c === 6) {
        grid[r][c] = { dark: r % 2 === 0, accent: false };
        continue;
      }

      // 5x5 alignment square at (16..20, 16..20)
      if (r >= 16 && r <= 20 && c >= 16 && c <= 20) {
        const ar = r - 16;
        const ac = c - 16;
        const border = ar === 0 || ar === 4 || ac === 0 || ac === 4;
        const center = ar === 2 && ac === 2;
        grid[r][c] = { dark: border || center, accent: center };
        continue;
      }

      // Deterministic payload bit mixing
      const charBit =
        payload.length > 0
          ? (payload.charCodeAt((r * MATRIX_DIM + c) % payload.length) >> ((r + c) % 7)) & 1
          : 0;
      rng = nextXorShift(rng ^ ((r + 1) * 73856093) ^ ((c + 1) * 19349663));
      const dark = ((rng & 1) ^ charBit) === 1;
      grid[r][c] = { dark, accent: false };
    }
  }

  return grid;
}

export const QrMatrixSvg: React.FC<QrMatrixSvgProps> = ({
  id,
  value,
  size = 200,
  foreground = '#0F172A',
  background = '#FFFFFF',
  accentColor = '#3390EC',
  className,
}) => {
  const matrix = useMemo(() => buildDeterministicQrMatrix(value), [value]);
  const totalView = MATRIX_DIM + QUIET_ZONE * 2;

  return (
    <svg
      id={id}
      className={className}
      width={size}
      height={size}
      viewBox={`0 0 ${totalView} ${totalView}`}
      role="img"
      aria-label="QR Pairing Code"
      data-qr-value={value}
      style={{
        display: 'block',
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: '12px',
        boxShadow: '0 4px 18px rgba(0, 0, 0, 0.16)',
        shapeRendering: 'crispEdges',
      }}
    >
      <rect x={0} y={0} width={totalView} height={totalView} fill={background} rx={1.5} />
      {matrix.map((row, r) =>
        row.map((cell, c) =>
          cell.dark ? (
            <rect
              key={`${r}-${c}`}
              x={c + QUIET_ZONE}
              y={r + QUIET_ZONE}
              width={1}
              height={1}
              fill={cell.accent ? accentColor : foreground}
            />
          ) : null,
        ),
      )}
    </svg>
  );
};
