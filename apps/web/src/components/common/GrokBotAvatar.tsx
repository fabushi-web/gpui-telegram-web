import React, { useId } from 'react';
import {
  CLASSIC_INITIALS_AVATAR_SHAPE,
  GROK_AVATAR_SHAPES,
  resolveGrokBotAvatar,
  type GrokAvatarShape,
} from '@gpui-telegram/protocol';
import { useSettingsStore } from '../../store/useSettingsStore';

export type GrokAvatarAnimationState = 'idle' | 'thinking' | 'executing' | 'blocked';

export interface GrokBotAvatarProps {
  sourceId: string;
  shape?: string | null;
  color?: string | null;
  sizePx?: number;
  state?: GrokAvatarAnimationState | string | null;
  initials?: string;
  className?: string;
  title?: string;
}

const GROK_AVATAR_CENTER = 114.2705;
const NORMALIZED_TARGET_EXTENT = 228.44;
const PI = Math.PI;
const TAU = Math.PI * 2;

type Pt = [number, number];
type PathCmd =
  | { kind: 'M'; x: number; y: number }
  | { kind: 'L'; x: number; y: number }
  | { kind: 'C'; c1: Pt; c2: Pt; to: Pt }
  | { kind: 'Z' };

function evalCubic1d(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
}

function extendBboxCubic1d(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  box: { min: number; max: number },
): void {
  box.min = Math.min(box.min, p0, p3);
  box.max = Math.max(box.max, p0, p3);

  const scale = Math.max(Math.abs(p0), Math.abs(p1), Math.abs(p2), Math.abs(p3), 1);
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;

  const checkT = (t: number): void => {
    if (t > 0 && t < 1) {
      const val = evalCubic1d(p0, p1, p2, p3, t);
      box.min = Math.min(box.min, val);
      box.max = Math.max(box.max, val);
    }
  };

  if (Math.abs(a) <= 1e-5 * scale) {
    if (Math.abs(b) > 1e-12 * scale) {
      checkT(-c / b);
    }
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const root = Math.sqrt(disc);
      if (Math.abs(b) > 1e-12 * scale) {
        const q = -0.5 * (b + Math.sign(b) * root);
        checkT(q / a);
        checkT(c / q);
      } else {
        checkT((-b + root) / (2 * a));
        checkT((-b - root) / (2 * a));
      }
    }
  }
}

function computeBbox(cmds: PathCmd[]): [number, number, number, number] {
  const bx = { min: Infinity, max: -Infinity };
  const by = { min: Infinity, max: -Infinity };
  let cur: Pt = [0, 0];
  let start: Pt = [0, 0];

  for (const cmd of cmds) {
    if (cmd.kind === 'M') {
      bx.min = Math.min(bx.min, cmd.x);
      bx.max = Math.max(bx.max, cmd.x);
      by.min = Math.min(by.min, cmd.y);
      by.max = Math.max(by.max, cmd.y);
      cur = [cmd.x, cmd.y];
      start = [cmd.x, cmd.y];
    } else if (cmd.kind === 'L') {
      bx.min = Math.min(bx.min, cmd.x);
      bx.max = Math.max(bx.max, cmd.x);
      by.min = Math.min(by.min, cmd.y);
      by.max = Math.max(by.max, cmd.y);
      cur = [cmd.x, cmd.y];
    } else if (cmd.kind === 'C') {
      extendBboxCubic1d(cur[0], cmd.c1[0], cmd.c2[0], cmd.to[0], bx);
      extendBboxCubic1d(cur[1], cmd.c1[1], cmd.c2[1], cmd.to[1], by);
      cur = cmd.to;
    } else {
      cur = start;
    }
  }
  if (!Number.isFinite(bx.min)) return [0, 0, 0, 0];
  return [bx.min, by.min, bx.max, by.max];
}

function normalizeArtifactCommands(cmds: PathCmd[]): PathCmd[] {
  const [minX, minY, maxX, maxY] = computeBbox(cmds);
  const w = Math.max(0, maxX - minX);
  const h = Math.max(0, maxY - minY);
  const maxDim = Math.max(w, h);
  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const scale =
    maxDim > 1e-4 ? Math.max(0.9, Math.min(1.35, NORMALIZED_TARGET_EXTENT / maxDim)) : 1;

  const mapPt = ([x, y]: Pt): Pt => [
    GROK_AVATAR_CENTER + (x - cx) * scale,
    GROK_AVATAR_CENTER + (y - cy) * scale,
  ];

  return cmds.map((cmd): PathCmd => {
    if (cmd.kind === 'M') {
      const [nx, ny] = mapPt([cmd.x, cmd.y]);
      return { kind: 'M', x: nx, y: ny };
    }
    if (cmd.kind === 'L') {
      const [nx, ny] = mapPt([cmd.x, cmd.y]);
      return { kind: 'L', x: nx, y: ny };
    }
    if (cmd.kind === 'C') {
      return {
        kind: 'C',
        c1: mapPt(cmd.c1),
        c2: mapPt(cmd.c2),
        to: mapPt(cmd.to),
      };
    }
    return cmd;
  });
}

function pushArcCubics(
  cmds: PathCmd[],
  cx: number,
  cy: number,
  r: number,
  startAngle: number,
  sweepAngle: number,
): void {
  const segments = Math.max(1, Math.ceil(Math.abs(sweepAngle) / (PI * 0.5)));
  const step = sweepAngle / segments;
  for (let i = 0; i < segments; i++) {
    const a0 = startAngle + step * i;
    const a1 = a0 + step;
    const k = (4 / 3) * Math.tan(step * 0.25);
    const s0 = Math.sin(a0);
    const c0 = Math.cos(a0);
    const s1 = Math.sin(a1);
    const c1 = Math.cos(a1);
    const p0: Pt = [cx + r * c0, cy + r * s0];
    const p3: Pt = [cx + r * c1, cy + r * s1];
    cmds.push({
      kind: 'C',
      c1: [p0[0] - k * r * s0, p0[1] + k * r * c0],
      c2: [p3[0] + k * r * s1, p3[1] - k * r * c1],
      to: p3,
    });
  }
}

function buildBlobCommands(): PathCmd[] {
  const anchors: Array<{ p: Pt; t: Pt; hIn: number; hOut: number }> = [
    { p: [118, 4], t: [0.996, 0.087], hIn: 38, hOut: 36 },
    { p: [196, 46], t: [0.616, 0.788], hIn: 34, hOut: 34 },
    { p: [224, 134], t: [-0.139, 0.99], hIn: 38, hOut: 36 },
    { p: [182, 208], t: [-0.799, 0.602], hIn: 34, hOut: 34 },
    { p: [108, 224.5], t: [-0.999, -0.052], hIn: 36, hOut: 38 },
    { p: [32, 194], t: [-0.643, -0.766], hIn: 34, hOut: 34 },
    { p: [3.5, 108], t: [0.105, -0.995], hIn: 38, hOut: 38 },
    { p: [42, 26], t: [0.766, -0.643], hIn: 34, hOut: 36 },
  ];
  const n = anchors.length;
  const cmds: PathCmd[] = [{ kind: 'M', x: anchors[0]!.p[0], y: anchors[0]!.p[1] }];
  for (let i = 0; i < n; i++) {
    const a = anchors[i]!;
    const b = anchors[(i + 1) % n]!;
    cmds.push({
      kind: 'C',
      c1: [a.p[0] + a.t[0] * a.hOut, a.p[1] + a.t[1] * a.hOut],
      c2: [b.p[0] - b.t[0] * b.hIn, b.p[1] - b.t[1] * b.hIn],
      to: b.p,
    });
  }
  cmds.push({ kind: 'Z' });
  return cmds;
}

function buildPebbleCommands(): PathCmd[] {
  const c = GROK_AVATAR_CENTER;
  const ctrl: Pt[] = [
    [c - 6, c - 92],
    [c + 76, c - 66],
    [c + 114, c + 4],
    [c + 84, c + 72],
    [c + 2, c + 94],
    [c - 82, c + 74],
    [c - 112, c + 8],
    [c - 78, c - 64],
  ];
  const n = ctrl.length;
  const steps = 64;
  const cmds: PathCmd[] = [];
  for (let step = 0; step < steps; step++) {
    const u = (step / steps) * n;
    const seg = Math.floor(u) % n;
    const t = u - Math.floor(u);
    const t2 = t * t;
    const t3 = t2 * t;
    const p0 = ctrl[(seg + n - 1) % n]!;
    const p1 = ctrl[seg]!;
    const p2 = ctrl[(seg + 1) % n]!;
    const p3 = ctrl[(seg + 2) % n]!;
    const x =
      0.5 *
      (2 * p1[0] +
        (-p0[0] + p2[0]) * t +
        (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
        (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
    const y =
      0.5 *
      (2 * p1[1] +
        (-p0[1] + p2[1]) * t +
        (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
        (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
    cmds.push(step === 0 ? { kind: 'M', x, y } : { kind: 'L', x, y });
  }
  cmds.push({ kind: 'Z' });
  return cmds;
}

function buildSquircleCommands(): PathCmd[] {
  const c = GROK_AVATAR_CENTER;
  const r = 114;
  const power = 2 / 4.2;
  const steps = 64;
  const cmds: PathCmd[] = [];
  for (let step = 0; step < steps; step++) {
    const theta = (TAU * step) / steps;
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    const x = c + r * Math.sign(cosT) * Math.pow(Math.abs(cosT), power);
    const y = c + r * Math.sign(sinT) * Math.pow(Math.abs(sinT), power);
    cmds.push(step === 0 ? { kind: 'M', x, y } : { kind: 'L', x, y });
  }
  cmds.push({ kind: 'Z' });
  return cmds;
}

function buildTabletCommands(): PathCmd[] {
  const c = GROK_AVATAR_CENTER;
  const rx = 114;
  const ry = 74;
  const flatHalf = rx - ry;
  const cmds: PathCmd[] = [
    { kind: 'M', x: c - flatHalf, y: c - ry },
    { kind: 'L', x: c + flatHalf, y: c - ry },
  ];
  pushArcCubics(cmds, c + flatHalf, c, ry, -PI * 0.5, PI);
  cmds.push({ kind: 'L', x: c - flatHalf, y: c + ry });
  pushArcCubics(cmds, c - flatHalf, c, ry, PI * 0.5, PI);
  cmds.push({ kind: 'Z' });
  return cmds;
}

function buildRoundedPolygonCommands(
  cx: number,
  cy: number,
  sides: number,
  r: number,
  cr: number,
  startAngle: number,
): PathCmd[] {
  const verts: Pt[] = [];
  for (let i = 0; i < sides; i++) {
    const a = startAngle + (TAU * i) / sides;
    verts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  const cmds: PathCmd[] = [];
  for (let i = 0; i < sides; i++) {
    const prev = verts[(i + sides - 1) % sides]!;
    const curr = verts[i]!;
    const next = verts[(i + 1) % sides]!;
    const vin: Pt = [prev[0] - curr[0], prev[1] - curr[1]];
    const vout: Pt = [next[0] - curr[0], next[1] - curr[1]];
    const lin = Math.max(1e-4, Math.hypot(vin[0], vin[1]));
    const lout = Math.max(1e-4, Math.hypot(vout[0], vout[1]));
    const dIn = Math.min(cr, lin * 0.48);
    const dOut = Math.min(cr, lout * 0.48);
    const pIn: Pt = [curr[0] + (vin[0] / lin) * dIn, curr[1] + (vin[1] / lin) * dIn];
    const pOut: Pt = [curr[0] + (vout[0] / lout) * dOut, curr[1] + (vout[1] / lout) * dOut];
    const c1: Pt = [pIn[0] + (2 / 3) * (curr[0] - pIn[0]), pIn[1] + (2 / 3) * (curr[1] - pIn[1])];
    const c2: Pt = [
      pOut[0] + (2 / 3) * (curr[0] - pOut[0]),
      pOut[1] + (2 / 3) * (curr[1] - pOut[1]),
    ];
    cmds.push(i === 0 ? { kind: 'M', x: pIn[0], y: pIn[1] } : { kind: 'L', x: pIn[0], y: pIn[1] });
    cmds.push({ kind: 'C', c1, c2, to: pOut });
  }
  cmds.push({ kind: 'Z' });
  return cmds;
}

function buildCloudCommands(): PathCmd[] {
  const c = GROK_AVATAR_CENTER;
  const circles: Array<[number, number, number]> = [
    [c, c + 22, 78],
    [c - 62, c + 16, 52],
    [c + 62, c + 16, 52],
    [c - 28, c - 34, 62],
    [c + 32, c - 26, 56],
  ];
  const steps = 96;
  const cmds: PathCmd[] = [];
  for (let step = 0; step < steps; step++) {
    const theta = (TAU * step) / steps;
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    let bestT = 0;
    for (const [cx, cy, r] of circles) {
      const ox = c - cx;
      const oy = c - cy;
      const b = ox * cosT + oy * sinT;
      const q = ox * ox + oy * oy - r * r;
      const disc = b * b - q;
      if (disc >= 0) {
        const t = -b + Math.sqrt(disc);
        if (t > bestT) bestT = t;
      }
    }
    const x = c + bestT * cosT;
    const y = c + bestT * sinT;
    cmds.push(step === 0 ? { kind: 'M', x, y } : { kind: 'L', x, y });
  }
  cmds.push({ kind: 'Z' });
  return cmds;
}

function buildTeardropCommands(): PathCmd[] {
  const c = GROK_AVATAR_CENTER;
  const w = 88;
  const top = c - 114;
  const bottom = c + 26;
  const cr = 18;
  const cy1 = top + cr;
  const cy2 = bottom;
  const dy = cy2 - cy1;
  const dr = w - cr;
  const ny = Math.max(-0.999, Math.min(0.999, -(dr / dy)));
  const nx = Math.sqrt(1 - ny * ny);
  const p1Right: Pt = [c + cr * nx, cy1 + cr * ny];
  const p2Right: Pt = [c + w * nx, cy2 + w * ny];
  const thetaR = Math.atan2(ny, nx);
  const thetaL = PI - thetaR;
  const sweepBottom = thetaL - thetaR;
  const sweepTop = TAU + thetaR - thetaL;
  const p1Left: Pt = [c - cr * nx, cy1 + cr * ny];
  const cmds: PathCmd[] = [
    { kind: 'M', x: p1Right[0], y: p1Right[1] },
    { kind: 'L', x: p2Right[0], y: p2Right[1] },
  ];
  pushArcCubics(cmds, c, cy2, w, thetaR, sweepBottom);
  cmds.push({ kind: 'L', x: p1Left[0], y: p1Left[1] });
  pushArcCubics(cmds, c, cy1, cr, thetaL, sweepTop);
  cmds.push({ kind: 'Z' });
  return cmds;
}

function formatNum(n: number): string {
  return Number(n.toFixed(2)).toString();
}

function commandsToSvgPath(cmds: PathCmd[]): string {
  const parts: string[] = [];
  for (const cmd of cmds) {
    if (cmd.kind === 'M') {
      parts.push(`M${formatNum(cmd.x)} ${formatNum(cmd.y)}`);
    } else if (cmd.kind === 'L') {
      parts.push(`L${formatNum(cmd.x)} ${formatNum(cmd.y)}`);
    } else if (cmd.kind === 'C') {
      parts.push(
        `C${formatNum(cmd.c1[0])} ${formatNum(cmd.c1[1])} ${formatNum(cmd.c2[0])} ${formatNum(cmd.c2[1])} ${formatNum(cmd.to[0])} ${formatNum(cmd.to[1])}`,
      );
    } else {
      parts.push('Z');
    }
  }
  return parts.join(' ');
}

const CACHED_SHAPE_PATHS: Record<GrokAvatarShape, string> = (() => {
  const c = GROK_AVATAR_CENTER;
  return {
    blob: commandsToSvgPath(normalizeArtifactCommands(buildBlobCommands())),
    pebble: commandsToSvgPath(normalizeArtifactCommands(buildPebbleCommands())),
    squircle: commandsToSvgPath(normalizeArtifactCommands(buildSquircleCommands())),
    tablet: commandsToSvgPath(normalizeArtifactCommands(buildTabletCommands())),
    wedge: commandsToSvgPath(
      normalizeArtifactCommands(buildRoundedPolygonCommands(c, c, 3, 130, 60, -PI * 0.5)),
    ),
    hex: commandsToSvgPath(
      normalizeArtifactCommands(buildRoundedPolygonCommands(c, c, 6, 114, 20, PI / 6)),
    ),
    cloud: commandsToSvgPath(normalizeArtifactCommands(buildCloudCommands())),
    teardrop: commandsToSvgPath(normalizeArtifactCommands(buildTeardropCommands())),
  };
})();

export function normalizeGrokAvatarState(raw?: string | null): GrokAvatarAnimationState {
  const lower = (raw ?? '').trim().toLowerCase();
  if (
    lower.includes('block') ||
    lower.includes('approval') ||
    lower.includes('alert') ||
    lower.includes('error')
  ) {
    return 'blocked';
  }
  if (
    lower.includes('exec') ||
    lower.includes('tool') ||
    lower.includes('work') ||
    lower.includes('run') ||
    lower.includes('writ')
  ) {
    return 'executing';
  }
  if (
    lower.includes('think') ||
    lower.includes('typ') ||
    lower.includes('plan') ||
    lower.includes('stream')
  ) {
    return 'thinking';
  }
  return 'idle';
}

export function resolveBotHueName(sourceId: string, color?: string | null): string {
  const resolved = resolveGrokBotAvatar(sourceId || 'fabushi-bot', { color });
  switch (resolved.color) {
    case 'red':
    case 'green':
    case 'yellow':
    case 'orange':
    case 'cyan':
    case 'magenta':
    case 'brown':
    case 'blue':
      return resolved.color;
    case 'violet':
      return 'purple';
    default:
      return 'blue';
  }
}

export const GrokBotAvatar: React.FC<GrokBotAvatarProps> = ({
  sourceId,
  shape,
  color,
  sizePx = 44,
  state = 'idle',
  initials,
  className = '',
  title,
}) => {
  const reactId = useId();
  const theme = useSettingsStore((s) => s.theme);
  const isDarkSurface = theme === 'night' || theme === 'tinted';

  const resolved = resolveGrokBotAvatar(sourceId || 'fabushi-bot', { shape, color });
  const animState = normalizeGrokAvatarState(state);

  const isBlackFlipped = resolved.color === 'black' && isDarkSurface;
  const gradLight = isBlackFlipped ? '#FAFAFC' : resolved.gradLightHex;
  const gradDark = isBlackFlipped ? '#CECED6' : resolved.gradDarkHex;
  const featureHex = isBlackFlipped ? '#111318' : '#FFFFFF';

  const gradId = `grok-grad-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`;

  // Classic circular initials fallback when shape === 'classic'
  if (resolved.shape === CLASSIC_INITIALS_AVATAR_SHAPE) {
    const label = (initials ?? sourceId.slice(0, 2)).trim().slice(0, 2).toUpperCase() || 'AI';
    return (
      <span
        data-avatar="true"
        data-grok-shape="classic"
        data-grok-color={resolved.color}
        data-grok-state={animState}
        title={title}
        className={`tg-grok-avatar tg-avatar tg-grok-avatar--${animState} ${className}`.trim()}
        style={{
          width: `${sizePx}px`,
          height: `${sizePx}px`,
          fontSize: `${Math.max(10, Math.round(sizePx * 0.36))}px`,
          background: `linear-gradient(135deg, ${gradLight} 0%, ${gradDark} 100%)`,
          color: featureHex,
        }}
      >
        <span data-avatar="true" className="tg-grok-avatar-initials">
          {label}
        </span>
      </span>
    );
  }

  const shapeKey: GrokAvatarShape = (GROK_AVATAR_SHAPES as readonly string[]).includes(
    resolved.shape,
  )
    ? (resolved.shape as GrokAvatarShape)
    : 'blob';
  const pathD = CACHED_SHAPE_PATHS[shapeKey];

  const eyeScale =
    animState === 'blocked' ? 0.62 : animState === 'thinking' ? 0.75 : 1;
  const eyeRy = Number((7 * eyeScale).toFixed(2));
  const showEyes = sizePx >= 14;

  return (
    <span
      data-avatar="true"
      data-grok-shape={shapeKey}
      data-grok-color={resolved.color}
      data-grok-state={animState}
      title={title}
      className={`tg-grok-avatar tg-grok-avatar--${animState} ${className}`.trim()}
      style={{
        width: `${sizePx}px`,
        height: `${sizePx}px`,
        color: featureHex,
      }}
    >
      <svg
        data-avatar="true"
        className="tg-grok-avatar-svg"
        viewBox="-15 -15 259 259"
        width={sizePx}
        height={sizePx}
        aria-hidden="true"
      >
        <defs data-avatar="true">
          <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={gradLight} />
            <stop offset="100%" stopColor={gradDark} />
          </linearGradient>
        </defs>
        <g data-avatar="true" className="tg-grok-avatar-body">
          <path data-avatar="true" d={pathD} fill={`url(#${gradId})`} />
          {showEyes && (
            <g data-avatar="true" className="tg-grok-avatar-eyes">
              <ellipse
                data-avatar="true"
                cx="85.27"
                cy="106.27"
                rx="10"
                ry={eyeRy}
                fill={featureHex}
              />
              <ellipse
                data-avatar="true"
                cx="143.27"
                cy="106.27"
                rx="10"
                ry={eyeRy}
                fill={featureHex}
              />
            </g>
          )}
        </g>
      </svg>
      {animState !== 'idle' && sizePx >= 24 && (
        <span
          data-avatar="true"
          className={`tg-grok-avatar-status-dot tg-grok-avatar-status-dot--${animState}`}
        />
      )}
    </span>
  );
};

export default GrokBotAvatar;
