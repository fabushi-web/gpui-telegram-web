import type { AdminLogEventDto, ConnectionState } from '@gpui-telegram/protocol';

/**
 * Pure, framework-free M1B Core Parity helpers (`v1.6.12`–`v1.6.15` + Residual Core Parity).
 * Shared across React UI components, Zustand stores, and Node Vitest unit tests.
 */

export const CONNECTING_BANNER_GRACE_MS = 1200;
export const CONNECTING_BANNER_TIMER_BUFFER_MS = 50;

export type ConnectionBannerVisualState =
  | 'connected'
  | 'offline'
  | 'connecting'
  | 'reconnecting'
  | 'updating';

export interface ConnectionBannerEvaluationInput {
  connectionState: ConnectionState;
  browserOfflineEvent: boolean;
  transientStartedAtMs: number | null;
  nowMs: number;
  pendingOutboxCount?: number;
}

export interface ConnectionBannerEvaluationResult {
  visible: boolean;
  state: ConnectionBannerVisualState;
  immediate: boolean;
  remainingGraceMs: number;
}

/**
 * Desktop `v1.6.13` 1200ms grace-delayed connecting banner FSM (`window_connecting_widget.rs:11-66`):
 * - `connected && !browserOfflineEvent` -> hidden (`visible: false`).
 * - `browserOfflineEvent || (disconnected && pendingOutboxCount > 0)` -> visible IMMEDIATELY (`0ms` delay, `state: 'offline'`).
 * - cold-start / transient `'disconnected'` (with `!browserOfflineEvent && pendingOutboxCount === 0`)
 *   and `'connecting' | 'reconnecting' | 'updating'` -> visible ONLY once
 *   `(nowMs - transientStartedAtMs) >= CONNECTING_BANNER_GRACE_MS` (1200ms).
 */
export function evaluateConnectionBannerVisibility(
  input: ConnectionBannerEvaluationInput,
): ConnectionBannerEvaluationResult {
  const {
    connectionState,
    browserOfflineEvent,
    transientStartedAtMs,
    nowMs,
    pendingOutboxCount = 0,
  } = input;

  if (connectionState === 'connected' && !browserOfflineEvent) {
    return {
      visible: false,
      state: 'connected',
      immediate: false,
      remainingGraceMs: 0,
    };
  }

  if (browserOfflineEvent || (connectionState === 'disconnected' && pendingOutboxCount > 0)) {
    return {
      visible: true,
      state: 'offline',
      immediate: true,
      remainingGraceMs: 0,
    };
  }

  const elapsedMs =
    transientStartedAtMs !== null ? Math.max(0, nowMs - transientStartedAtMs) : 0;
  const visible =
    transientStartedAtMs !== null && elapsedMs >= CONNECTING_BANNER_GRACE_MS;
  const remainingGraceMs = visible
    ? 0
    : transientStartedAtMs !== null
      ? Math.max(0, CONNECTING_BANNER_GRACE_MS - elapsedMs)
      : CONNECTING_BANNER_GRACE_MS;

  return {
    visible,
    state: connectionState === 'disconnected' ? 'offline' : connectionState,
    immediate: false,
    remainingGraceMs,
  };
}

export interface MiniAppIframeFocusInput {
  hasLiveMiniApp: boolean;
  isPipMinimized: boolean;
  isReady: boolean;
  hasHigherPriorityModal: boolean;
  searchFocused: boolean;
}

/**
 * Desktop `v1.6.12` floating PiP focus-steal guard predicate (`bot_attach_web_view.rs:813-824`).
 * Minimized PiP iframes NEVER own keyboard focus while keeping WASM & WebMCP live.
 */
export function allowsMiniAppIframeFocus(input: MiniAppIframeFocusInput): boolean {
  return Boolean(
    input.hasLiveMiniApp &&
      !input.isPipMinimized &&
      input.isReady &&
      !input.hasHigherPriorityModal &&
      !input.searchFocused,
  );
}

export interface ParsedInlineBotQuery {
  botUsername: string;
  query: string;
}

/**
 * Parses leading `@<bot_username> <query>` input for inline bot queries.
 * Requires at least one whitespace character after the bot username so it never collides
 * with trailing `@mention` autocomplete.
 */
export function parseInlineBotQueryInput(text: string): ParsedInlineBotQuery | null {
  const match = text.match(/^@([a-zA-Z][a-zA-Z0-9_]{2,31})\s+(.*)$/s);
  if (!match) return null;
  const botUsername = match[1];
  const query = match[2] ?? '';
  if (!botUsername) return null;
  return { botUsername, query };
}

export interface CoalescedAdminLogEvent extends AdminLogEventDto {
  coalescedCount: number;
  coalescedIds: number[];
}

/**
 * Coalesces consecutive `message_deleted` admin log events performed by the same `actor_user_id`
 * within `windowSec` seconds (desktop `K_DELETE_GROUP_TIME_WINDOW_SECS = 5`).
 */
export function coalesceAdminLogDeletes(
  events: AdminLogEventDto[],
  windowSec = 5,
): CoalescedAdminLogEvent[] {
  const windowMs = Math.max(0, windowSec) * 1000;
  const result: CoalescedAdminLogEvent[] = [];

  for (const ev of events) {
    const prev = result[result.length - 1];
    const isDelete =
      ev.action === 'message_deleted' || ev.action === 'messages_deleted';
    const prevIsDelete =
      prev !== undefined &&
      (prev.action === 'message_deleted' || prev.action === 'messages_deleted');

    if (
      prev &&
      isDelete &&
      prevIsDelete &&
      prev.actor_user_id === ev.actor_user_id &&
      Math.abs(prev.created_at_ms - ev.created_at_ms) <= windowMs
    ) {
      prev.coalescedCount += 1;
      prev.coalescedIds.push(ev.event_id);
    } else {
      result.push({
        ...ev,
        coalescedCount: 1,
        coalescedIds: [ev.event_id],
      });
    }
  }

  return result;
}

const DEFAULT_SAFE_ACCENT = '#0A84FF';

export function parseHexRgb(hex: string): { r: number; g: number; b: number } | null {
  const cleaned = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) return null;
  return {
    r: parseInt(cleaned.slice(0, 2), 16),
    g: parseInt(cleaned.slice(2, 4), 16),
    b: parseInt(cleaned.slice(4, 6), 16),
  };
}

export function formatRgbHex(r: number, g: number, b: number): string {
  const clamp = (n: number): string =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0')
      .toUpperCase();
  return `#${clamp(r)}${clamp(g)}${clamp(b)}`;
}

/**
 * Rejects forbidden purple/violet hues (`235°..315°`) to guarantee dark-theme
 * anti-purple compliance (`assertNoPurpleOnDark`).
 */
export function sanitizeNonPurpleHex(hex: string): string {
  const rgb = parseHexRgb(hex);
  if (!rgb) return DEFAULT_SAFE_ACCENT;
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return formatRgbHex(rgb.r, rgb.g, rgb.b);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  if (h >= 235 && h <= 315) {
    return DEFAULT_SAFE_ACCENT;
  }
  return formatRgbHex(rgb.r, rgb.g, rgb.b);
}

/**
 * Computes exact BT.601 luma in `[0..255]`: `0.299 * r + 0.587 * g + 0.114 * b`.
 */
export function computeBt601Luma(hex: string): number {
  const rgb = parseHexRgb(hex);
  if (!rgb) return 0;
  return 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
}

/**
 * Linearly mixes two `#RRGGBB` colors with factor `t` clamped to `[0, 1]`.
 */
export function mixRgbHex(hexA: string, hexB: string, t: number): string {
  const a = parseHexRgb(hexA);
  const b = parseHexRgb(hexB);
  if (!a || !b) return DEFAULT_SAFE_ACCENT;
  const clamped = Math.max(0, Math.min(1, t));
  return formatRgbHex(
    a.r + (b.r - a.r) * clamped,
    a.g + (b.g - a.g) * clamped,
    a.b + (b.b - a.b) * clamped,
  );
}

/**
 * Exact desktop `palette_presets.rs:276-287` white-text contrast guard combined with
 * the web anti-purple invariant (`235°..315°` forbidden):
 * 1. Sanitize purple hues (`235°..315°` -> `#0A84FF`).
 * 2. Compute BT.601 luma `0.299 * r + 0.587 * g + 0.114 * b`.
 * 3. If `luma <= 138.0`, return `safeHex` unchanged.
 * 4. Otherwise darken linearly toward `#111111` by `clamp((luma - 138.0) / 145.0, 0, 0.36)`.
 */
export function ensureWhiteTextContrast(hex: string): string {
  const safeHex = sanitizeNonPurpleHex(hex);
  const luma = computeBt601Luma(safeHex);
  if (luma <= 138.0) {
    return safeHex;
  }
  const darkenT = Math.max(0.0, Math.min(0.36, (luma - 138.0) / 145.0));
  const darkened = mixRgbHex(safeHex, '#111111', darkenT);
  return sanitizeNonPurpleHex(darkened);
}
