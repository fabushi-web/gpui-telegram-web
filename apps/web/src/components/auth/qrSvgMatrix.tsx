import React, { useMemo } from 'react';
import { encodeQrMatrix } from '@gpui-telegram/protocol';

export interface QrMatrixSvgProps {
  id?: string;
  value: string;
  size?: number;
  foreground?: string;
  background?: string;
  accentColor?: string;
  badge?: 'alipay' | 'telegram' | 'none';
  className?: string;
}

const QUIET_ZONE = 4;

/**
 * Generates a genuine ISO/IEC 18004 scannable QR code matrix with Error Correction Level Q (25%),
 * matching the GPUI desktop client's `QrCode::with_error_correction_level(..., EcLevel::Q)`.
 */
export function buildDeterministicQrMatrix(
  payload: string,
): Array<Array<{ dark: boolean; accent: boolean }>> {
  const { size, modules } = encodeQrMatrix(payload, 'Q');
  const isFinderCenter = (r: number, c: number): boolean => {
    const inTopLeft = r >= 2 && r <= 4 && c >= 2 && c <= 4;
    const inTopRight = r >= 2 && r <= 4 && c >= size - 5 && c <= size - 3;
    const inBottomLeft = r >= size - 5 && r <= size - 3 && c >= 2 && c <= 4;
    return inTopLeft || inTopRight || inBottomLeft;
  };

  return modules.map((row, r) =>
    row.map((dark, c) => ({
      dark,
      accent: dark && isFinderCenter(r, c),
    })),
  );
}

export const QrMatrixSvg: React.FC<QrMatrixSvgProps> = ({
  id,
  value,
  size = 216,
  foreground = '#0F172A',
  background = '#FFFFFF',
  accentColor = '#0F172A',
  badge = 'none',
  className,
}) => {
  const { matrixDim, pathD, accentPathD } = useMemo(() => {
    const grid = buildDeterministicQrMatrix(value);
    const dim = grid.length;
    const mainParts: string[] = [];
    const accentParts: string[] = [];
    for (let r = 0; r < dim; r += 1) {
      const row = grid[r]!;
      for (let c = 0; c < dim; c += 1) {
        const cell = row[c]!;
        if (!cell.dark) continue;
        const cmd = `M${c + QUIET_ZONE},${r + QUIET_ZONE}h1v1h-1z`;
        if (cell.accent && accentColor !== foreground) {
          accentParts.push(cmd);
        } else {
          mainParts.push(cmd);
        }
      }
    }
    return {
      matrixDim: dim,
      pathD: mainParts.join(''),
      accentPathD: accentParts.join(''),
    };
  }, [value, accentColor, foreground]);

  const totalView = matrixDim + QUIET_ZONE * 2;
  const center = totalView / 2;
  const badgeBox = Math.max(5, Math.round(matrixDim * 0.2));

  return (
    <svg
      id={id}
      className={className}
      width={size}
      height={size}
      viewBox={`0 0 ${totalView} ${totalView}`}
      role="img"
      aria-label={badge === 'alipay' ? 'Alipay OAuth QR Code' : 'QR Pairing Code'}
      data-qr-value={value}
      data-qr-standard="ISO-18004"
      data-qr-ec="Q"
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
      <path d={pathD} fill={foreground} />
      {accentPathD && <path d={accentPathD} fill={accentColor} />}
      {badge === 'alipay' && (
        <g shapeRendering="geometricPrecision">
          <rect
            x={center - badgeBox / 2 - 0.8}
            y={center - badgeBox / 2 - 0.8}
            width={badgeBox + 1.6}
            height={badgeBox + 1.6}
            rx={1.8}
            fill="#FFFFFF"
          />
          <rect
            x={center - badgeBox / 2}
            y={center - badgeBox / 2}
            width={badgeBox}
            height={badgeBox}
            rx={1.4}
            fill="#1677FF"
          />
          <text
            x={center}
            y={center + badgeBox * 0.26}
            textAnchor="middle"
            fill="#FFFFFF"
            fontFamily="system-ui, -apple-system, 'PingFang SC', sans-serif"
            fontSize={badgeBox * 0.68}
            fontWeight={700}
          >
            支
          </text>
        </g>
      )}
    </svg>
  );
};
