/**
 * Mini App WebMCP (`navigator.modelContext`), Fabushi Bots CRUD & Grok Bot 0.18
 * Deterministic UTF-16 FNV-1a Avatar Hash Contracts aligned with desktop
 * `bhrumom/gpui-telegram` v1.6.11 (`miniapp_contracts.rs`, `grok_bot_avatar.rs`, `hermes_im_bridge.rs`).
 *
 * Pure ES2023 + DOM isomorphic module (zero `node:*` imports or Node globals).
 */

import type { BotRegistryEntry } from './aiContracts.js';
import type { CodingAgentBotConfig } from './codingAgents.js';

export const BOTFATHER_USER_ID = 777_001;
export const BOTFATHER_USERNAME = 'BotFather';
export const CLASSIC_INITIALS_AVATAR_SHAPE = 'classic' as const;

/** Exact canonical order for `grokShippedShapeHash % 8` (`miniapp_contracts.rs:62-71`) */
export const GROK_AVATAR_SHAPES = [
  'blob',
  'pebble',
  'squircle',
  'tablet',
  'wedge',
  'hex',
  'cloud',
  'teardrop',
] as const;

export type GrokAvatarShape = (typeof GROK_AVATAR_SHAPES)[number];
export type GrokResolvedAvatarShape = GrokAvatarShape | typeof CLASSIC_INITIALS_AVATAR_SHAPE;

/** Exact 11 canonical color IDs (`miniapp_contracts.rs:74-86`) */
export const GROK_AVATAR_COLOR_IDS = [
  'black',
  'brown',
  'red',
  'orange',
  'yellow',
  'green',
  'cyan',
  'blue',
  'violet',
  'magenta',
  'gray',
] as const;

export type GrokAvatarColor = (typeof GROK_AVATAR_COLOR_IDS)[number];

/** Exact 10 deterministic fallback colors (excludes `'black'`, `miniapp_contracts.rs:89-100`) */
export const GROK_AVATAR_FALLBACK_COLOR_IDS: readonly GrokAvatarColor[] = [
  'brown',
  'red',
  'orange',
  'yellow',
  'green',
  'cyan',
  'blue',
  'violet',
  'magenta',
  'gray',
] as const;

export interface GrokColorSpec {
  id: GrokAvatarColor;
  label_en: string;
  label_zh: string;
  swatch_hex: string;
  grad_light_hex: string;
  grad_dark_hex: string;
}

/** Exact 11-color Grok Bot 0.18 hex palette (`grok_bot_avatar.rs:458-547`) */
export const GROK_COLOR_PALETTE: readonly GrokColorSpec[] = [
  {
    id: 'black',
    label_en: 'Black',
    label_zh: '曜石黑',
    swatch_hex: '#111114',
    grad_light_hex: '#323238',
    grad_dark_hex: '#050507',
  },
  {
    id: 'brown',
    label_en: 'Brown',
    label_zh: '琥珀棕',
    swatch_hex: '#936439',
    grad_light_hex: '#A27952',
    grad_dark_hex: '#855C36',
  },
  {
    id: 'red',
    label_en: 'Red',
    label_zh: '炽焰红',
    swatch_hex: '#FF263C',
    grad_light_hex: '#FF3E51',
    grad_dark_hex: '#E02135',
  },
  {
    id: 'orange',
    label_en: 'Orange',
    label_zh: '活力橙',
    swatch_hex: '#FF6700',
    grad_light_hex: '#FF781C',
    grad_dark_hex: '#FF6700',
  },
  {
    id: 'yellow',
    label_en: 'Yellow',
    label_zh: '暖阳金',
    swatch_hex: '#FF9800',
    grad_light_hex: '#FFAF38',
    grad_dark_hex: '#FF9800',
  },
  {
    id: 'green',
    label_en: 'Green',
    label_zh: '翡翠绿',
    swatch_hex: '#00C972',
    grad_light_hex: '#00C972',
    grad_dark_hex: '#009957',
  },
  {
    id: 'cyan',
    label_en: 'Cyan',
    label_zh: '青碧蓝',
    swatch_hex: '#00BCA6',
    grad_light_hex: '#1CC3B0',
    grad_dark_hex: '#00A592',
  },
  {
    id: 'blue',
    label_en: 'Blue',
    label_zh: '星辰蓝',
    swatch_hex: '#1084FE',
    grad_light_hex: '#2A92FE',
    grad_dark_hex: '#0E74E0',
  },
  {
    id: 'violet',
    label_en: 'Violet',
    label_zh: '极光紫',
    swatch_hex: '#9159FE',
    grad_light_hex: '#A97EFE',
    grad_dark_hex: '#804EE0',
  },
  {
    id: 'magenta',
    label_en: 'Magenta',
    label_zh: '品红',
    swatch_hex: '#FF309B',
    grad_light_hex: '#FF5EB1',
    grad_dark_hex: '#E02A88',
  },
  {
    id: 'gray',
    label_en: 'Gray',
    label_zh: '星际灰',
    swatch_hex: '#777777',
    grad_light_hex: '#959595',
    grad_dark_hex: '#777777',
  },
] as const;

export const WEBMCP_PAGE_ERROR_INDICATORS = [
  '失败',
  'error',
  'exception',
  'compileerror',
  'wasm',
  '404',
  '500',
  '无法',
  '崩溃',
  'failed',
] as const;

export const WEBMCP_BUILTIN_TOOL_NAMES = [
  'get_state',
  'page_inspect',
  'page_click',
  'page_fill',
  'page_press_main_button',
  'page_press_secondary_button',
] as const;

export interface WebMcpToolDescriptor {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  read_only: boolean;
}

export interface WebMcpPageError {
  source: 'boot_error' | 'page_errors' | 'visible_toast';
  message: string;
  raw_errors?: string[];
}

export interface WebMcpStateReport {
  ok?: boolean;
  kind?: string;
  title?: string;
  url?: string;
  status_text?: string;
  boot_error?: string;
  visible_toast?: string;
  page_errors?: string[];
  state?: Record<string, unknown>;
  main_button?: { is_visible: boolean; text: string };
  secondary_button?: { is_visible: boolean; text: string };
  [key: string]: unknown;
}

export type MiniAppControlMode =
  | 'idle'
  | 'ai_controlling'
  | 'waiting_for_takeover'
  | 'user_takeover';

export type MiniAppWebMcpOperation =
  | 'discover'
  | 'call_tool'
  | 'get_state'
  | 'request_takeover';

export interface MiniAppWebMcpCommand {
  request_id: string;
  bot_username: string;
  short_name: string;
  chat_id: number;
  bot_user_id: number;
  app_title: string;
  operation: MiniAppWebMcpOperation | string;
  tool_name?: string | null;
  arguments: Record<string, unknown>;
  status_message?: string | null;
}

export interface MiniAppWebMcpResponse {
  request_id: string;
  ok: boolean;
  result: unknown;
  error?: string | null;
  tools: WebMcpToolDescriptor[];
  state_summary?: WebMcpStateReport | Record<string, unknown> | null;
  control_mode: MiniAppControlMode;
}

/** Rust name: `MiniAppTakeoverEvent` (`miniapp_contracts.rs:1698-1710`) */
export interface MiniAppTakeoverState {
  bot_username: string;
  short_name: string;
  chat_id: number;
  bot_user_id: number;
  mode: MiniAppControlMode;
  user_note?: string | null;
  state_snapshot?: WebMcpStateReport | Record<string, unknown> | null;
}
export type MiniAppTakeoverEvent = MiniAppTakeoverState;

/** Matches `UpdateEvent::MiniAppControlStatus` (`sync/events.rs:172-184`) */
export interface MiniAppControlStatus {
  bot_username: string;
  short_name: string;
  chat_id: number;
  bot_user_id: number;
  app_title: string;
  mode: MiniAppControlMode;
  status_text: string;
  active_tool?: string | null;
}

export interface FabushiBotSummaryDto {
  bot_user_id: number;
  owner_user_id: number;
  agent_id: string;
  username: string;
  display_name: string;
  description: string;
  title: string;
  avatar_shape: string;
  avatar_color: string;
  preferred_model: string;
  thinking_level: string;
  approval_mode: string;
  toolset_preset: string;
  notify_on_agent_updates: boolean;
  hidden_from_sidebar: boolean;
  memory_entries_count: number;
  skills_count: number;
  execution_state: string;
  companion_chat_id?: number | null;
  coding_agent?: CodingAgentBotConfig | null;
}

/** Rust name: `CreateFabushiBotRequest` (`miniapp_contracts.rs:1160-1184`) */
export interface FabushiBotCreateRequest {
  display_name: string;
  username?: string | null;
  agent_id?: string | null;
  description?: string;
  title?: string;
  avatar_shape?: string | null;
  avatar_color?: string | null;
  preferred_model?: string | null;
  thinking_level?: string | null;
  approval_mode?: string | null;
  toolset_preset?: string | null;
  coding_agent?: CodingAgentBotConfig | null;
}
export type CreateFabushiBotRequest = FabushiBotCreateRequest;

/** Rust name: `PatchFabushiBotRequest` (`miniapp_contracts.rs:1188-1213`) */
export interface FabushiBotPatchRequest {
  display_name?: string | null;
  description?: string | null;
  title?: string | null;
  avatar_shape?: string | null;
  avatar_color?: string | null;
  preferred_model?: string | null;
  thinking_level?: string | null;
  approval_mode?: string | null;
  toolset_preset?: string | null;
  notify_on_agent_updates?: boolean | null;
  hidden_from_sidebar?: boolean | null;
  coding_agent?: CodingAgentBotConfig | null;
}
export type PatchFabushiBotRequest = FabushiBotPatchRequest;

export interface FabushiBotCreateResponse {
  bot: FabushiBotSummaryDto;
  registry: BotRegistryEntry;
  bot_token: string;
  companion_chat_id: number;
}

export interface ResolvedGrokBotAvatar {
  shape: GrokResolvedAvatarShape;
  /** Either a canonical `GrokAvatarColor` ID (e.g. `'blue'`) or uppercase `#RRGGBB` hex */
  color: GrokAvatarColor | string;
  /** Resolved CSS swatch hex (from `GROK_COLOR_PALETTE` if named color, else `color`) */
  swatchHex: string;
  gradLightHex: string;
  gradDarkHex: string;
}

// ============================================================================
// Grok Bot 0.18 UTF-16 FNV-1a Hash & Avatar Resolution (`miniapp_contracts.rs:106-184`)
// ============================================================================

export function grokShippedHash(value: string): number {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < value.length; i++) {
    hash = Math.imul((hash ^ value.charCodeAt(i)) >>> 0, 16777619) >>> 0;
  }
  return hash >>> 0;
}

export function grokShippedColorIndex(value: string): number {
  const seed = (grokShippedHash(value) ^ 2654435769) >>> 0;
  const s2 = ((seed ^ 2654435769) + 1831565813) >>> 0;
  let next = Math.imul((s2 ^ (s2 >>> 15)) >>> 0, (1 | s2) >>> 0) >>> 0;
  next = (next ^ ((next + Math.imul((next ^ (next >>> 7)) >>> 0, (61 | next) >>> 0)) >>> 0)) >>> 0;
  const r = ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  return Math.min(9, Math.floor(r * 10));
}

export function grokShippedShapeHash(value: string): number {
  let hash = grokShippedHash(value);
  hash = Math.imul((hash ^ (hash >>> 16)) >>> 0, 73244475) >>> 0;
  hash = Math.imul((hash ^ (hash >>> 13)) >>> 0, 3266489909) >>> 0;
  return (hash ^ (hash >>> 16)) >>> 0;
}

function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

export function resolveGrokPersonaColor(agentId: string, color?: string | null): string {
  if (typeof color === 'string') {
    const trimmed = color.trim();
    if (trimmed.length > 0) {
      const lower = asciiLowercase(trimmed);
      if ((GROK_AVATAR_COLOR_IDS as readonly string[]).includes(lower)) {
        return lower;
      }
      if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) {
        return trimmed.toUpperCase();
      }
      if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
        const r = trimmed[1]!.toUpperCase();
        const g = trimmed[2]!.toUpperCase();
        const b = trimmed[3]!.toUpperCase();
        return `#${r}${r}${g}${g}${b}${b}`;
      }
    }
  }
  return GROK_AVATAR_FALLBACK_COLOR_IDS[grokShippedColorIndex(agentId)]!;
}

export function resolveGrokPersonaShape(
  agentId: string,
  shape?: string | null,
): GrokResolvedAvatarShape {
  if (typeof shape === 'string') {
    const normalized = asciiLowercase(shape.trim());
    if (normalized === CLASSIC_INITIALS_AVATAR_SHAPE) {
      return CLASSIC_INITIALS_AVATAR_SHAPE;
    }
    const mapped =
      normalized === 'circle' || normalized === 'round'
        ? 'blob'
        : normalized === 'rounded' || normalized === 'square' || normalized === 'box'
          ? 'squircle'
          : normalized === 'hexagon'
            ? 'hex'
            : normalized === 'shield' || normalized === 'diamond' || normalized === 'spark'
              ? 'wedge'
              : normalized;
    if ((GROK_AVATAR_SHAPES as readonly string[]).includes(mapped)) {
      return mapped as GrokAvatarShape;
    }
  }
  return GROK_AVATAR_SHAPES[grokShippedShapeHash(agentId) % GROK_AVATAR_SHAPES.length]!;
}

export function resolveGrokBotAvatar(
  agentId: string,
  opts?: { shape?: string | null; color?: string | null },
): ResolvedGrokBotAvatar {
  const shape = resolveGrokPersonaShape(agentId, opts?.shape);
  const color = resolveGrokPersonaColor(agentId, opts?.color);
  const spec = GROK_COLOR_PALETTE.find((c) => c.id === color);
  return {
    shape,
    color,
    swatchHex: spec ? spec.swatch_hex : color,
    gradLightHex: spec ? spec.grad_light_hex : color,
    gradDarkHex: spec ? spec.grad_dark_hex : color,
  };
}

/**
 * Extracts anti-hallucination page/boot errors from a WebMCP state summary
 * matching upstream `hermes_im_bridge.rs:29-72`.
 */
export function extractWebMcpPageError(
  summary?: WebMcpStateReport | Record<string, unknown> | null,
): WebMcpPageError | null {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    return null;
  }
  const obj = summary as Record<string, unknown>;

  if (typeof obj.boot_error === 'string' && obj.boot_error.trim().length > 0) {
    return {
      source: 'boot_error',
      message: obj.boot_error.trim(),
    };
  }

  if (Array.isArray(obj.page_errors)) {
    const msgs = obj.page_errors
      .filter((item): item is string => typeof item === 'string')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (msgs.length > 0) {
      return {
        source: 'page_errors',
        message: msgs.join('; '),
        raw_errors: msgs,
      };
    }
  }

  if (typeof obj.visible_toast === 'string' && obj.visible_toast.trim().length > 0) {
    const toast = obj.visible_toast.trim();
    const lower = toast.toLowerCase();
    if (WEBMCP_PAGE_ERROR_INDICATORS.some((ind) => lower.includes(ind))) {
      return {
        source: 'visible_toast',
        message: toast,
      };
    }
  }

  return null;
}
