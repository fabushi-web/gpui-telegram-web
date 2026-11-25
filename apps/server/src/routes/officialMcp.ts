import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import type { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_MCP_PROTOCOL_VERSION,
  MCP_OAUTH_SCOPES,
  MCP_PROTOCOL_VERSIONS,
  escapeHtml,
  isSupportedMcpProtocolVersion,
  isSupportedMcpScope,
  type BotRegistryEntry,
  type McpAuditEntry,
  type OAuthAuthorizationServerMetadata,
  type OAuthDynamicClientRegisterResponse,
  type OAuthGrantSummary,
  type OAuthProtectedResourceMetadata,
  type OAuthTokenResponse,
} from '@gpui-telegram/protocol';
import type { ServerConfig } from '../config.js';
import {
  createMessageAtomic,
  ensureChatReadAccess,
  ensureChatWriteAccess,
  getChatDetailDto,
  isBlockedIpAddress,
  parseBoundedQueryInt,
} from '../db/queries.js';
import {
  constantTimeUtf8Equals,
  generateQrCodeSvg,
  sha256Hex,
  verifySecretScrypt,
} from '../utils/crypto.js';
import {
  ApiError,
  beginSseStream,
  extractBearerToken,
  readRawBody,
  requireAuth,
  sendJson,
  type HttpRouter,
  type RequestContext,
} from '../utils/http.js';
import type { RealtimeGatewayHub } from '../ws/hub.js';
import { isBotVisibleToUser, redactBotEntryForViewer } from './botsMiniApps.js';
import type { McpKillSwitchHooks, RemoteAssistRuntime } from './remoteAssist.js';

type SseStreamHandle = ReturnType<typeof beginSseStream>;

function parseStrictPositiveInt(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    const n = Number(raw.trim());
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  return null;
}

function parseStrictMcpLimit(raw: unknown, fallback: number, min: number, max: number): number | null {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    return Math.max(min, Math.min(max, Math.trunc(raw)));
  }
  if (typeof raw === 'string' && /^-?\d+$/.test(raw.trim())) {
    const n = Number(raw.trim());
    if (!Number.isFinite(n)) return null;
    return Math.max(min, Math.min(max, Math.trunc(n)));
  }
  return null;
}

function listUserDialogsForMcp(db: DatabaseSync, userId: number, limit = 50) {
  const rows = db
    .prepare(
      `SELECT c.chat_id
       FROM chats c
       INNER JOIN chat_members cm ON cm.chat_id = c.chat_id AND cm.user_id = ?
       WHERE cm.role != 'banned'
       ORDER BY c.last_message_date_ms DESC, c.chat_id DESC
       LIMIT ?`,
    )
    .all(userId, limit) as Array<{ chat_id: number }>;
  return rows
    .map((r) => getChatDetailDto(db, Number(r.chat_id), userId))
    .filter((d): d is NonNullable<typeof d> => d !== null);
}

// ============================================================================
// Constants & Upstream 31-Tool Catalog (`official_mcp.rs:2035-2361`)
// ============================================================================

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const AUTH_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const OAUTH_TX_TTL_MS = 15 * 60 * 1000; // 15 minutes
const USER_COOKIE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PKCE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

interface OfficialMcpToolDef {
  name: string;
  description: string;
  requiredScope: string;
  deviceOp?: boolean;
  inputSchema: Record<string, unknown>;
}

const OFFICIAL_MCP_TOOLS: readonly OfficialMcpToolDef[] = [
  // 1. Devices & Screen (5)
  {
    name: 'list_devices',
    description: 'List registered remote computer devices owned by the authorized user',
    requiredScope: 'devices:read',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_device_status',
    description: 'Get live status and policy of a specific remote computer device',
    requiredScope: 'devices:read',
    inputSchema: { type: 'object', properties: { node_id: { type: 'string' } }, required: ['node_id'] },
  },
  {
    name: 'capture_screen',
    description: 'Capture a live screenshot from an online remote device',
    requiredScope: 'screen:view',
    deviceOp: true,
    inputSchema: { type: 'object', properties: { node_id: { type: 'string' } }, required: ['node_id'] },
  },
  {
    name: 'get_accessibility_tree',
    description: 'Inspect semantic UI accessibility tree on an online remote device',
    requiredScope: 'screen:view',
    deviceOp: true,
    inputSchema: {
      type: 'object',
      properties: { node_id: { type: 'string' }, max_depth: { type: 'integer' } },
      required: ['node_id'],
    },
  },
  {
    name: 'semantic_ui_action',
    description: 'Invoke a semantic UI action on an accessibility node on a remote device',
    requiredScope: 'input:control',
    deviceOp: true,
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { type: 'string' },
        element_id: { type: 'string' },
        action: { type: 'string' },
        value: { type: 'string' },
      },
      required: ['node_id', 'element_id', 'action'],
    },
  },
  // 2. Input & Clipboard (5)
  {
    name: 'mouse_action',
    description: 'Perform mouse move/click/scroll action on an online remote device',
    requiredScope: 'input:control',
    deviceOp: true,
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { type: 'string' },
        action: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        button: { type: 'string' },
      },
      required: ['node_id', 'action'],
    },
  },
  {
    name: 'keyboard_type',
    description: 'Type UTF-8 text on an online remote device',
    requiredScope: 'input:control',
    deviceOp: true,
    inputSchema: {
      type: 'object',
      properties: { node_id: { type: 'string' }, text: { type: 'string' } },
      required: ['node_id', 'text'],
    },
  },
  {
    name: 'keyboard_hotkey',
    description: 'Send a keyboard shortcut chord on an online remote device',
    requiredScope: 'input:control',
    deviceOp: true,
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { type: 'string' },
        key: { type: 'string' },
        modifiers: { type: 'array', items: { type: 'string' } },
      },
      required: ['node_id', 'key'],
    },
  },
  {
    name: 'clipboard_get',
    description: 'Read current clipboard contents from an online remote device',
    requiredScope: 'files:read',
    deviceOp: true,
    inputSchema: { type: 'object', properties: { node_id: { type: 'string' } }, required: ['node_id'] },
  },
  {
    name: 'clipboard_set',
    description: 'Write text into the clipboard of an online remote device',
    requiredScope: 'files:write',
    deviceOp: true,
    inputSchema: {
      type: 'object',
      properties: { node_id: { type: 'string' }, text: { type: 'string' } },
      required: ['node_id', 'text'],
    },
  },
  // 3. Persistent Terminals (6)
  {
    name: 'terminal_list',
    description: 'List active terminal sessions on an online remote device',
    requiredScope: 'terminal:exec',
    deviceOp: true,
    inputSchema: { type: 'object', properties: { node_id: { type: 'string' } }, required: ['node_id'] },
  },
  {
    name: 'terminal_open',
    description: 'Open a new persistent terminal session on an online remote device',
    requiredScope: 'terminal:exec',
    deviceOp: true,
    inputSchema: {
      type: 'object',
      properties: { node_id: { type: 'string' }, session_name: { type: 'string' }, shell: { type: 'string' } },
      required: ['node_id'],
    },
  },
  {
    name: 'terminal_exec',
    description: 'Execute a shell command in a terminal on an online remote device',
    requiredScope: 'terminal:exec',
    deviceOp: true,
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { type: 'string' },
        command: { type: 'string' },
        session_name: { type: 'string' },
        timeout_ms: { type: 'integer' },
      },
      required: ['node_id', 'command'],
    },
  },
  {
    name: 'terminal_send',
    description: 'Send raw input to a persistent terminal session',
    requiredScope: 'terminal:exec',
    deviceOp: true,
    inputSchema: {
      type: 'object',
      properties: { node_id: { type: 'string' }, session_name: { type: 'string' }, input: { type: 'string' } },
      required: ['node_id', 'input'],
    },
  },
  {
    name: 'terminal_read',
    description: 'Read buffered output from a persistent terminal session',
    requiredScope: 'terminal:exec',
    deviceOp: true,
    inputSchema: {
      type: 'object',
      properties: { node_id: { type: 'string' }, session_name: { type: 'string' } },
      required: ['node_id'],
    },
  },
  {
    name: 'terminal_kill',
    description: 'Terminate a persistent terminal session',
    requiredScope: 'terminal:exec',
    deviceOp: true,
    inputSchema: {
      type: 'object',
      properties: { node_id: { type: 'string' }, session_name: { type: 'string' } },
      required: ['node_id', 'session_name'],
    },
  },
  // 4. File Transfer (3)
  {
    name: 'file_list',
    description: 'List directory entries on an online remote device',
    requiredScope: 'files:read',
    deviceOp: true,
    inputSchema: {
      type: 'object',
      properties: { node_id: { type: 'string' }, path: { type: 'string' } },
      required: ['node_id', 'path'],
    },
  },
  {
    name: 'file_read',
    description: 'Read a file from an online remote device',
    requiredScope: 'files:read',
    deviceOp: true,
    inputSchema: {
      type: 'object',
      properties: { node_id: { type: 'string' }, path: { type: 'string' }, max_bytes: { type: 'integer' } },
      required: ['node_id', 'path'],
    },
  },
  {
    name: 'file_write',
    description: 'Write a file to an online remote device',
    requiredScope: 'files:write',
    deviceOp: true,
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { type: 'string' },
        path: { type: 'string' },
        content: { type: 'string' },
        create_dirs: { type: 'boolean' },
      },
      required: ['node_id', 'path', 'content'],
    },
  },
  // 5. Remote Assist, Power & Takeover (4)
  {
    name: 'assist_get_info',
    description: 'Get permanent 9-digit Remote Assist ID and current temporary access code state',
    requiredScope: 'assist:manage',
    inputSchema: { type: 'object', properties: { device_id: { type: 'string' } } },
  },
  {
    name: 'assist_manage',
    description: 'Manage Remote Assist configuration (reset_code, allow, disallow)',
    requiredScope: 'assist:manage',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['reset_code', 'allow', 'disallow'] },
        device_id: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'device_power_action',
    description: 'Execute power action (lock/sleep/reboot/shutdown) on a remote device (requires confirm: true)',
    requiredScope: 'power:control',
    deviceOp: true,
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { type: 'string' },
        kind: { type: 'string' },
        confirm: { type: 'boolean' },
      },
      required: ['node_id', 'kind', 'confirm'],
    },
  },
  {
    name: 'request_human_takeover',
    description: 'Request immediate human operator takeover on a remote device',
    requiredScope: 'devices:connect',
    inputSchema: {
      type: 'object',
      properties: {
        node_id: { type: 'string' },
        reason: { type: 'string' },
        instructions: { type: 'string' },
      },
      required: ['node_id'],
    },
  },
  // 6. IM, Tasks, Bots & MiniApps (8)
  {
    name: 'list_dialogs',
    description: 'List chats/dialogs accessible to the authorized user',
    requiredScope: 'chats:read',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } },
  },
  {
    name: 'get_chat_history',
    description: 'Read recent message history from a chat accessible to the authorized user',
    requiredScope: 'messaging:read',
    inputSchema: {
      type: 'object',
      properties: { chat_id: { type: 'integer' }, limit: { type: 'integer' } },
      required: ['chat_id'],
    },
  },
  {
    name: 'send_message',
    description: 'Send a message to a chat on behalf of the authorized user',
    requiredScope: 'messaging:write',
    inputSchema: {
      type: 'object',
      properties: { chat_id: { type: 'integer' }, text: { type: 'string' } },
      required: ['chat_id', 'text'],
    },
  },
  {
    name: 'search_messages',
    description: 'Search messages across chats accessible to the authorized user',
    requiredScope: 'messaging:read',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'integer' } },
      required: ['query'],
    },
  },
  {
    name: 'list_tasks',
    description: 'List Global Task Center tasks owned by the authorized user',
    requiredScope: 'tasks:manage',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_task',
    description: 'Create a new task in the Global Task Center',
    requiredScope: 'tasks:manage',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, description: { type: 'string' } },
      required: ['title'],
    },
  },
  {
    name: 'list_bots',
    description: 'List registered bots visible to the authorized user',
    requiredScope: 'chats:read',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'miniapp_list',
    description: 'List available Mini Apps in the catalog',
    requiredScope: 'miniapp:control',
    inputSchema: { type: 'object', properties: {} },
  },
];

const OFFICIAL_MCP_TOOL_MAP = new Map<string, OfficialMcpToolDef>(
  OFFICIAL_MCP_TOOLS.map((t) => [t.name, t]),
);

const SENSITIVE_ARG_KEYS = new Set([
  'code',
  'text',
  'content',
  'data',
  'password',
  'secret',
  'token',
  'access_code',
]);

// ============================================================================
// Runtime State & Session Registry (`OfficialMcpRuntime`)
// ============================================================================

interface PendingOAuthTx {
  txId: string;
  cookieHash: string;
  csrfToken: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  requestedScopes: string[];
  resource: string;
  authenticatedUserId: number | null;
  qrPairToken: string | null;
  expiresAtMs: number;
}

interface McpSessionEntry {
  sessionId: string;
  userId: number;
  clientId: string;
  clientName: string;
  familyId: string;
  protocolVersion: string;
  scopes: string[];
  allowedNodeIds: string[];
  createdAtMs: number;
  terminated: boolean;
  terminatedReason?: string;
  sseSubscribers: Set<{ sse: SseStreamHandle; keepalive: NodeJS.Timeout }>;
}

interface VerifiedMcpBearer {
  tokenId: string;
  tokenHash: string;
  familyId: string;
  clientId: string;
  clientName: string;
  userId: number;
  resource: string;
  scopes: string[];
  allowedNodeIds: string[];
}

interface StandaloneSseSub {
  userId: number;
  familyId: string;
  sse: SseStreamHandle;
  keepalive: NodeJS.Timeout;
}

export class OfficialMcpRuntime {
  readonly pendingTxs = new Map<string, PendingOAuthTx>();
  readonly userCookies = new Map<string, { userId: number; expiresAtMs: number }>();
  readonly sessions = new Map<string, McpSessionEntry>();
  readonly standaloneSseSubscribers = new Set<StandaloneSseSub>();
  readonly seenTokensByUser = new Map<number, Set<string>>();
  readonly terminatedTokenHashes = new Set<string>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly config: ServerConfig,
    private readonly remoteAssist: RemoteAssistRuntime,
  ) {}

  getKillHooks(): McpKillSwitchHooks {
    return {
      terminateSession: (sessionId, reason) => this.terminateSession(sessionId, reason),
      terminateAllForUser: (userId, reason) => this.terminateAllForUser(userId, reason),
      terminateByFamilyId: (userId, familyId, reason) =>
        this.terminateByFamilyId(userId, familyId, reason),
    };
  }

  recordSeenToken(userId: number, tokenHash: string): void {
    let set = this.seenTokensByUser.get(userId);
    if (!set) {
      set = new Set();
      this.seenTokensByUser.set(userId, set);
    }
    set.add(tokenHash);
  }

  private closeSessionSse(entry: McpSessionEntry, reason: string): void {
    for (const sub of Array.from(entry.sseSubscribers)) {
      clearInterval(sub.keepalive);
      try {
        sub.sse.sendEvent('message', {
          jsonrpc: '2.0',
          method: 'notifications/terminated',
          params: { session_id: entry.sessionId, reason },
        });
        sub.sse.end();
      } catch {
        // Ignore already-closed stream
      }
      entry.sseSubscribers.delete(sub);
    }
  }

  private closeStandaloneSub(sub: StandaloneSseSub, reason: string): void {
    clearInterval(sub.keepalive);
    try {
      sub.sse.sendEvent('message', {
        jsonrpc: '2.0',
        method: 'notifications/terminated',
        params: { session_id: null, reason },
      });
      sub.sse.end();
    } catch {
      // Ignore already-closed stream
    }
    this.standaloneSseSubscribers.delete(sub);
  }

  terminateSession(sessionId: string, reason: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.terminated) return false;
    entry.terminated = true;
    entry.terminatedReason = reason;
    this.closeSessionSse(entry, reason);
    return true;
  }

  terminateByFamilyId(userId: number, familyId: string, reason: string): number {
    let count = 0;
    for (const entry of this.sessions.values()) {
      if (entry.userId === userId && entry.familyId === familyId && !entry.terminated) {
        entry.terminated = true;
        entry.terminatedReason = reason;
        this.closeSessionSse(entry, reason);
        count += 1;
      }
    }
    for (const sub of Array.from(this.standaloneSseSubscribers)) {
      if (sub.userId === userId && sub.familyId === familyId) {
        this.closeStandaloneSub(sub, reason);
        count += 1;
      }
    }
    return count;
  }

  /**
   * Emergency Kill Switch (`disconnect-all`):
   * Terminates ALL active MCP sessions and marks ALL previously seen MCP access tokens
   * for `userId` as terminated (`410 Gone` on subsequent `/mcp` calls), WITHOUT deleting
   * SQLite `mcp_oauth_tokens` grant rows so `GET /api/v1/mcp/grants` remains inspectable
   * until explicit `DELETE /api/v1/mcp/grants/:familyId`!
   */
  terminateAllForUser(userId: number, reason: string): number {
    let count = 0;
    for (const entry of this.sessions.values()) {
      if (entry.userId === userId && !entry.terminated) {
        entry.terminated = true;
        entry.terminatedReason = reason;
        this.closeSessionSse(entry, reason);
        count += 1;
      }
    }
    for (const sub of Array.from(this.standaloneSseSubscribers)) {
      if (sub.userId === userId) {
        this.closeStandaloneSub(sub, reason);
        count += 1;
      }
    }
    const seen = this.seenTokensByUser.get(userId);
    if (seen) {
      for (const th of seen) {
        this.terminatedTokenHashes.add(th);
      }
    }
    return count;
  }

  reset(): void {
    for (const entry of this.sessions.values()) {
      this.closeSessionSse(entry, 'server_reset');
    }
    for (const sub of Array.from(this.standaloneSseSubscribers)) {
      this.closeStandaloneSub(sub, 'server_reset');
    }
    this.standaloneSseSubscribers.clear();
    this.sessions.clear();
    this.pendingTxs.clear();
    this.userCookies.clear();
    this.seenTokensByUser.clear();
    this.terminatedTokenHashes.clear();
  }

  close(): void {
    this.reset();
  }

  // Expose db/config/remoteAssist safely if needed
  getDb(): DatabaseSync {
    return this.db;
  }
  getConfig(): ServerConfig {
    return this.config;
  }
  getRemoteAssist(): RemoteAssistRuntime {
    return this.remoteAssist;
  }
}

export function createOfficialMcpRuntime(
  db: DatabaseSync,
  config: ServerConfig,
  remoteAssist: RemoteAssistRuntime,
): OfficialMcpRuntime {
  return new OfficialMcpRuntime(db, config, remoteAssist);
}

// ============================================================================
// Security & Parsing Helpers (SSRF-Hardened Redirect/CIMD, Cookies, Form/JSON)
// ============================================================================

function computeBaseUrl(ctx: RequestContext): string {
  const envBase = process.env.MCP_PUBLIC_BASE_URL?.trim();
  if (envBase && /^https?:\/\//i.test(envBase)) {
    return envBase.replace(/\/+$/, '');
  }
  const xfProto = typeof ctx.req.headers['x-forwarded-proto'] === 'string'
    ? ctx.req.headers['x-forwarded-proto'].split(',')[0]!.trim().toLowerCase()
    : '';
  const proto = xfProto === 'https' ? 'https' : 'http';
  const rawHost =
    (typeof ctx.req.headers['x-forwarded-host'] === 'string'
      ? ctx.req.headers['x-forwarded-host'].split(',')[0]!.trim()
      : '') ||
    (typeof ctx.req.headers.host === 'string' ? ctx.req.headers.host.trim() : '') ||
    '127.0.0.1';
  const cleanHost = rawHost.replace(/[\s/\\]/g, '');
  return `${proto}://${cleanHost}`;
}

function parseCookies(cookieHeader: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out.set(k, v);
  }
  return out;
}

async function parseFormOrJsonBody(ctx: RequestContext): Promise<Record<string, unknown>> {
  const rawBuf = await readRawBody(ctx.req, 256 * 1024);
  if (rawBuf.length === 0) return {};
  const rawText = rawBuf.toString('utf8').trim();
  if (!rawText) return {};
  const ct = String(ctx.req.headers['content-type'] ?? '').toLowerCase();
  if (ct.includes('application/json') || rawText.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new ApiError(400, 'invalid_request', 'Malformed JSON body');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ApiError(400, 'invalid_request', 'JSON body must be a plain object');
    }
    return parsed as Record<string, unknown>;
  }
  const params = new URLSearchParams(rawText);
  const obj: Record<string, unknown> = {};
  for (const [k, v] of params.entries()) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    const existing = obj[k];
    if (existing === undefined) {
      obj[k] = v;
    } else if (Array.isArray(existing)) {
      existing.push(v);
    } else {
      obj[k] = [existing, v];
    }
  }
  return obj;
}

function sha256B64Url(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('base64url');
}

export function validateRedirectUri(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new ApiError(400, 'invalid_redirect_uri', 'redirect_uri must be a string');
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048 || /[\x00-\x1f\x7f\s]/.test(trimmed)) {
    throw new ApiError(400, 'invalid_redirect_uri', 'Invalid redirect_uri format');
  }
  if (trimmed.includes('#')) {
    throw new ApiError(400, 'invalid_redirect_uri', 'Fragments are not allowed in redirect_uri');
  }
  // Pre-URL raw path traversal check across ALL schemes before `new URL()` normalizes dots!
  if (/(?:^|\/|\\)\.\.(?:\/|\\|$|\?|#)/.test(trimmed) || /%2e%2e/i.test(trimmed)) {
    throw new ApiError(400, 'invalid_redirect_uri', 'Path traversal is not allowed in redirect_uri');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ApiError(400, 'invalid_redirect_uri', 'Malformed redirect_uri');
  }

  if (parsed.hash !== '' || parsed.username !== '' || parsed.password !== '') {
    throw new ApiError(400, 'invalid_redirect_uri', 'Userinfo or fragments are not allowed in redirect_uri');
  }

  const proto = parsed.protocol.toLowerCase();
  if (proto === 'https:') {
    const host = parsed.hostname.toLowerCase();
    if (!host || host === '0.0.0.0' || host === '::' || host === '[::]') {
      throw new ApiError(400, 'invalid_redirect_uri', 'Invalid HTTPS redirect_uri host');
    }
    return trimmed;
  }

  if (proto === 'http:') {
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') {
      return trimmed;
    }
    throw new ApiError(
      400,
      'invalid_redirect_uri',
      'Plain HTTP redirect_uri is permitted only for loopback hosts (localhost, 127.0.0.1, [::1])',
    );
  }

  if (
    proto === 'cursor:' ||
    proto === 'vscode:' ||
    proto === 'antigravity:' ||
    proto === 'claude:'
  ) {
    if (!parsed.hostname && (!parsed.pathname || parsed.pathname === '/')) {
      throw new ApiError(400, 'invalid_redirect_uri', 'IDE scheme redirect_uri requires host or path');
    }
    return trimmed;
  }

  throw new ApiError(400, 'invalid_redirect_uri', `Unsupported redirect_uri scheme: ${proto}`);
}

interface OAuthClientRecord {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  client_secret_hash: string | null;
  is_cimd: boolean;
}

async function resolveOAuthClient(
  db: DatabaseSync,
  clientId: string,
  statusOnNotFound: 400 | 401 = 400,
): Promise<OAuthClientRecord> {
  const trimmed = clientId.trim();
  if (!trimmed) {
    throw new ApiError(statusOnNotFound, 'invalid_client', 'client_id is required');
  }

  const row = db
    .prepare(`SELECT * FROM mcp_oauth_clients WHERE client_id = ?`)
    .get(trimmed) as Record<string, unknown> | undefined;
  if (row) {
    return {
      client_id: String(row.client_id),
      client_name: String(row.client_name),
      redirect_uris: JSON.parse(String(row.redirect_uris_json)) as string[],
      token_endpoint_auth_method: String(row.token_endpoint_auth_method),
      client_secret_hash: (row.client_secret_hash as string | null) ?? null,
      is_cimd: Boolean(Number(row.is_cimd)),
    };
  }

  // SSRF-Hardened Client ID Metadata Document (CIMD) discovery for `https://` client_ids
  if (trimmed.startsWith('https://')) {
    if (
      trimmed.includes('#') ||
      /(?:^|\/)\.\.(?:\/|$|\?|#)/.test(trimmed) ||
      /%2e%2e/i.test(trimmed)
    ) {
      throw new ApiError(statusOnNotFound, 'invalid_client', 'Unsafe CIMD client_id URL');
    }
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new ApiError(statusOnNotFound, 'invalid_client', 'Malformed CIMD client_id URL');
    }
    if (parsed.protocol !== 'https:' || parsed.hash || parsed.username || parsed.password || !parsed.hostname) {
      throw new ApiError(statusOnNotFound, 'invalid_client', 'Invalid CIMD client_id URL');
    }
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      isBlockedIpAddress(hostname)
    ) {
      throw new ApiError(statusOnNotFound, 'invalid_client', 'CIMD client_id points to a blocked/private host');
    }

    let resolvedAddrs: Array<{ address: string }>;
    try {
      resolvedAddrs = await dns.lookup(hostname, { all: true });
    } catch {
      throw new ApiError(statusOnNotFound, 'invalid_client', 'Failed to resolve CIMD host');
    }
    if (!resolvedAddrs.length || resolvedAddrs.some((a) => isBlockedIpAddress(a.address))) {
      throw new ApiError(statusOnNotFound, 'invalid_client', 'CIMD host resolves to a blocked/private IP');
    }

    let metaText = '';
    try {
      const resp = await fetch(trimmed, {
        method: 'GET',
        redirect: 'error',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > 64 * 1024) {
        throw new Error('CIMD document exceeds 64 KiB');
      }
      metaText = buf.toString('utf8');
    } catch {
      throw new ApiError(statusOnNotFound, 'invalid_client', 'Failed to fetch CIMD metadata document');
    }

    let meta: Record<string, unknown>;
    try {
      const parsedMeta: unknown = JSON.parse(metaText);
      if (!parsedMeta || typeof parsedMeta !== 'object' || Array.isArray(parsedMeta)) {
        throw new Error('Not object');
      }
      meta = parsedMeta as Record<string, unknown>;
    } catch {
      throw new ApiError(statusOnNotFound, 'invalid_client', 'Invalid CIMD JSON metadata');
    }

    if (meta.client_id !== trimmed || !Array.isArray(meta.redirect_uris) || meta.redirect_uris.length === 0) {
      throw new ApiError(statusOnNotFound, 'invalid_client', 'CIMD client_id or redirect_uris invalid');
    }
    const validRedirects = meta.redirect_uris.slice(0, 16).map((u) => validateRedirectUri(u));
    const clientName =
      typeof meta.client_name === 'string' && meta.client_name.trim()
        ? meta.client_name.trim().slice(0, 128)
        : hostname;

    db.prepare(`
      INSERT OR REPLACE INTO mcp_oauth_clients (
        client_id, client_name, redirect_uris_json, token_endpoint_auth_method,
        client_secret_hash, is_cimd, created_at_ms
      ) VALUES (?, ?, ?, 'none', NULL, 1, ?)
    `).run(trimmed, clientName, JSON.stringify(validRedirects), Date.now());

    return {
      client_id: trimmed,
      client_name: clientName,
      redirect_uris: validRedirects,
      token_endpoint_auth_method: 'none',
      client_secret_hash: null,
      is_cimd: true,
    };
  }

  throw new ApiError(statusOnNotFound, 'invalid_client', `Unknown OAuth client: ${trimmed}`);
}

function summarizeArgsForAudit(args: Record<string, unknown>): string {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (SENSITIVE_ARG_KEYS.has(k.toLowerCase())) {
      const len = typeof v === 'string' ? v.length : JSON.stringify(v ?? '').length;
      safe[k] = `<${len} chars>`;
    } else if (typeof v === 'string' && v.length > 120) {
      safe[k] = `${v.slice(0, 120)}...`;
    } else {
      safe[k] = v;
    }
  }
  return JSON.stringify(safe).slice(0, 512);
}

function sendHtml(
  ctx: RequestContext,
  status: number,
  html: string,
  cookies?: string[],
): void {
  ctx.res.statusCode = status;
  ctx.res.setHeader('Content-Type', 'text/html; charset=utf-8');
  ctx.res.setHeader('Cache-Control', 'no-store');
  ctx.res.setHeader('X-Frame-Options', 'DENY');
  if (cookies && cookies.length > 0) {
    ctx.res.setHeader('Set-Cookie', cookies);
  }
  ctx.res.end(html);
}

function renderOAuthLoginHtml(tx: PendingOAuthTx, errorMsg?: string): string {
  const qrSvg = tx.qrPairToken ? generateQrCodeSvg(`fabushi://pair?token=${tx.qrPairToken}`, 140) : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Sign in — Fabushi Official MCP OAuth 2.1</title>
</head>
<body>
  <h1>Authorize ${escapeHtml(tx.clientName)}</h1>
  ${errorMsg ? `<p role="alert">${escapeHtml(errorMsg)}</p>` : ''}
  <form method="post" action="/oauth/authorize/login">
    <input type="hidden" name="tx_id" value="${escapeHtml(tx.txId)}" />
    <input type="hidden" name="csrf_token" value="${escapeHtml(tx.csrfToken)}" />
    <label>Username <input name="username" required /></label>
    <label>Password <input name="password" type="password" required /></label>
    <label>2FA Password (optional) <input name="twofa_password" type="password" /></label>
    <button type="submit">Sign In</button>
  </form>
  ${qrSvg ? `<div id="qr-login">${qrSvg}</div>` : ''}
</body>
</html>`;
}

function renderOAuthConsentHtml(tx: PendingOAuthTx, userLabel: string, nodes: Array<{ node_id: string; display_name: string }>): string {
  const scopeInputs = tx.requestedScopes
    .map(
      (sc) =>
        `<label><input type="checkbox" name="scopes" value="${escapeHtml(sc)}" checked /> ${escapeHtml(sc)}</label>`,
    )
    .join('\n');
  const nodeInputs = nodes
    .map(
      (n) =>
        `<label><input type="checkbox" name="allowed_node_ids" value="${escapeHtml(n.node_id)}" checked /> ${escapeHtml(n.display_name)}</label>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Consent — Fabushi Official MCP OAuth 2.1</title>
</head>
<body>
  <h1>Authorize ${escapeHtml(tx.clientName)}</h1>
  <p>Signed in as ${escapeHtml(userLabel)}</p>
  <p>Resource: ${escapeHtml(tx.resource)}</p>
  <form method="post" action="/oauth/authorize/approve">
    <input type="hidden" name="tx_id" value="${escapeHtml(tx.txId)}" />
    <input type="hidden" name="csrf_token" value="${escapeHtml(tx.csrfToken)}" />
    <fieldset><legend>Requested Scopes</legend>${scopeInputs}</fieldset>
    ${nodeInputs ? `<fieldset><legend>Allowed Devices</legend>${nodeInputs}</fieldset>` : ''}
    <button type="submit" name="decision" value="approve">Approve</button>
    <button type="submit" name="decision" value="deny">Deny</button>
  </form>
</body>
</html>`;
}

// ============================================================================
// Route Registration
// ============================================================================

export function registerOfficialMcpRoutes(
  router: HttpRouter,
  db: DatabaseSync,
  config: ServerConfig,
  hub: RealtimeGatewayHub,
  runtime: OfficialMcpRuntime,
  remoteAssist: RemoteAssistRuntime,
): void {
  // ==========================================================================
  // 1. RFC 9728 / RFC 8414 / OIDC Discovery Endpoints
  // ==========================================================================
  const handleProtectedResourceMeta = (ctx: RequestContext): void => {
    const baseUrl = computeBaseUrl(ctx);
    ctx.res.setHeader('Cache-Control', 'no-store');
    const meta: OAuthProtectedResourceMetadata = {
      resource: `${baseUrl}/mcp`,
      authorization_servers: [baseUrl],
      bearer_methods_supported: ['header'],
      scopes_supported: [...MCP_OAUTH_SCOPES],
      resource_name: 'Fabushi Official MCP Server',
      resource_documentation: `${baseUrl}/.well-known/oauth-authorization-server`,
    };
    sendJson(ctx.res, 200, meta);
  };
  router.get('/.well-known/oauth-protected-resource', handleProtectedResourceMeta);
  router.get('/.well-known/oauth-protected-resource/mcp', handleProtectedResourceMeta);

  const handleAuthServerMeta = (ctx: RequestContext): void => {
    const baseUrl = computeBaseUrl(ctx);
    ctx.res.setHeader('Cache-Control', 'no-store');
    const meta: OAuthAuthorizationServerMetadata = {
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      revocation_endpoint: `${baseUrl}/oauth/revoke`,
      scopes_supported: [...MCP_OAUTH_SCOPES],
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
    };
    sendJson(ctx.res, 200, meta);
  };
  router.get('/.well-known/oauth-authorization-server', handleAuthServerMeta);
  router.get('/.well-known/openid-configuration', handleAuthServerMeta);

  // ==========================================================================
  // 2. RFC 7591 Dynamic Client Registration (`POST /oauth/register`)
  // ==========================================================================
  router.post('/oauth/register', async (ctx) => {
    ctx.res.setHeader('Cache-Control', 'no-store');
    const body = await parseFormOrJsonBody(ctx);
    const rawRedirects = body.redirect_uris;
    if (!Array.isArray(rawRedirects) || rawRedirects.length === 0 || rawRedirects.length > 16) {
      throw new ApiError(
        400,
        'invalid_redirect_uri',
        'redirect_uris must be a non-empty array of 1..16 URIs',
      );
    }
    const validRedirects = rawRedirects.map((u) => validateRedirectUri(u));

    if (
      body.token_endpoint_auth_method !== undefined &&
      typeof body.token_endpoint_auth_method !== 'string'
    ) {
      throw new ApiError(
        400,
        'invalid_client_metadata',
        'token_endpoint_auth_method must be "none" or "client_secret_post"',
      );
    }
    const authMethod =
      body.token_endpoint_auth_method === undefined ? 'none' : body.token_endpoint_auth_method;
    if (authMethod !== 'none' && authMethod !== 'client_secret_post') {
      throw new ApiError(
        400,
        'invalid_client_metadata',
        'token_endpoint_auth_method must be "none" or "client_secret_post"',
      );
    }

    const clientId = `fbmcp_cli_${crypto.randomBytes(12).toString('hex')}`;
    const clientName =
      typeof body.client_name === 'string' && body.client_name.trim()
        ? body.client_name.trim().slice(0, 128)
        : 'MCP Client';
    const now = Date.now();
    const rawSecret =
      authMethod === 'client_secret_post'
        ? `fbmcp_cs_${crypto.randomBytes(24).toString('base64url')}`
        : undefined;
    const secretHash = rawSecret ? sha256Hex(rawSecret) : null;

    db.prepare(`
      INSERT INTO mcp_oauth_clients (
        client_id, client_name, redirect_uris_json, token_endpoint_auth_method,
        client_secret_hash, is_cimd, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, 0, ?)
    `).run(clientId, clientName, JSON.stringify(validRedirects), authMethod, secretHash, now);

    const resp: OAuthDynamicClientRegisterResponse = {
      client_id: clientId,
      client_name: clientName,
      redirect_uris: validRedirects,
      token_endpoint_auth_method: authMethod,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_id_issued_at: Math.floor(now / 1000),
      ...(rawSecret ? { client_secret: rawSecret, client_secret_expires_at: 0 } : {}),
    };
    sendJson(ctx.res, 201, resp);
  });

  // ==========================================================================
  // 3. OAuth 2.1 Authorization Code + PKCE S256 Consent Flow (`/oauth/authorize*`)
  // ==========================================================================
  router.get('/oauth/authorize', async (ctx) => {
    const baseUrl = computeBaseUrl(ctx);
    const clientId = ctx.query.get('client_id')?.trim() ?? '';
    const redirectUri = ctx.query.get('redirect_uri')?.trim() ?? '';
    const responseType = ctx.query.get('response_type')?.trim() ?? '';
    const codeChallenge = ctx.query.get('code_challenge')?.trim() ?? '';
    const codeChallengeMethod = ctx.query.get('code_challenge_method')?.trim() ?? '';
    const rawScope = ctx.query.get('scope')?.trim() ?? 'devices:read';
    const state = ctx.query.get('state');
    const rawResource = ctx.query.get('resource')?.trim() ?? `${baseUrl}/mcp`;

    // Direct HTTP 400 validation (NEVER 302 on PKCE/client/redirect/scope/resource errors!)
    const client = await resolveOAuthClient(db, clientId, 400);
    if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
      throw new ApiError(400, 'invalid_redirect_uri', 'redirect_uri does not match registered client');
    }
    if (responseType !== 'code') {
      throw new ApiError(400, 'unsupported_response_type', 'Only response_type=code is supported');
    }
    if (!codeChallenge || codeChallengeMethod !== 'S256') {
      throw new ApiError(400, 'invalid_request', 'PKCE S256 code_challenge and code_challenge_method=S256 are required');
    }
    const scopes = rawScope.split(/\s+/).filter(Boolean);
    if (scopes.length === 0 || !scopes.every((s) => isSupportedMcpScope(s))) {
      throw new ApiError(400, 'invalid_scope', 'Requested scope contains unsupported MCP scopes');
    }
    const expectedResource = `${baseUrl}/mcp`;
    if (rawResource !== expectedResource && rawResource !== baseUrl) {
      throw new ApiError(400, 'invalid_target', `Resource must match ${expectedResource}`);
    }

    const cookies = parseCookies(ctx.req.headers.cookie);
    const userSessCookie = cookies.get('fbmcp_user_sess');
    let authUserId: number | null = null;
    if (userSessCookie) {
      const rec = runtime.userCookies.get(sha256Hex(userSessCookie));
      if (rec && rec.expiresAtMs > Date.now()) {
        authUserId = rec.userId;
      }
    }

    const now = Date.now();
    const txId = `otx_${crypto.randomBytes(16).toString('hex')}`;
    const cookieSecret = crypto.randomBytes(24).toString('hex');
    const csrfToken = crypto.randomBytes(24).toString('hex');
    let qrPairToken: string | null = null;
    if (authUserId === null) {
      qrPairToken = `mcpqr_${crypto.randomBytes(12).toString('hex')}`;
      const qrUrl = `fabushi://pair?token=${qrPairToken}`;
      const qrSvg = generateQrCodeSvg(qrUrl, 140);
      db.prepare(`
        INSERT OR REPLACE INTO qr_pair_sessions (
          pair_id, qr_url, svg, device_name, status, approved_user_id,
          issued_token, issued_session_id, expires_at_ms, created_at_ms
        ) VALUES (?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?)
      `).run(qrPairToken, qrUrl, qrSvg, `MCP OAuth (${client.client_name})`, now + OAUTH_TX_TTL_MS, now);
    }

    const tx: PendingOAuthTx = {
      txId,
      cookieHash: sha256Hex(cookieSecret),
      csrfToken,
      clientId: client.client_id,
      clientName: client.client_name,
      redirectUri,
      state,
      codeChallenge,
      codeChallengeMethod: 'S256',
      requestedScopes: scopes,
      resource: expectedResource,
      authenticatedUserId: authUserId,
      qrPairToken,
      expiresAtMs: now + OAUTH_TX_TTL_MS,
    };
    runtime.pendingTxs.set(txId, tx);

    const secureAttr = baseUrl.startsWith('https://') ? '; Secure' : '';
    const oauthCookie = `fbmcp_oauth_sess=${cookieSecret}; HttpOnly; SameSite=Lax; Path=/oauth; Max-Age=900${secureAttr}`;

    if (authUserId !== null) {
      const uRow = db
        .prepare(`SELECT username, first_name FROM users WHERE user_id = ?`)
        .get(authUserId) as { username: string | null; first_name: string } | undefined;
      const nodes = remoteAssist.listComputersForUser(authUserId);
      sendHtml(
        ctx,
        200,
        renderOAuthConsentHtml(tx, uRow?.username || uRow?.first_name || `User #${authUserId}`, nodes),
        [oauthCookie],
      );
      return;
    }

    sendHtml(ctx, 200, renderOAuthLoginHtml(tx), [oauthCookie]);
  });

  const verifyTxAndCookie = (ctx: RequestContext, txId: string, csrfToken: string): PendingOAuthTx => {
    const tx = runtime.pendingTxs.get(txId);
    if (!tx || tx.expiresAtMs < Date.now()) {
      runtime.pendingTxs.delete(txId);
      throw new ApiError(400, 'invalid_request', 'OAuth authorization transaction not found or expired');
    }
    const cookies = parseCookies(ctx.req.headers.cookie);
    const cookieVal = cookies.get('fbmcp_oauth_sess') ?? '';
    if (!cookieVal || !constantTimeUtf8Equals(sha256Hex(cookieVal), tx.cookieHash)) {
      throw new ApiError(403, 'invalid_csrf', 'OAuth session cookie mismatch');
    }
    if (!csrfToken || !constantTimeUtf8Equals(csrfToken, tx.csrfToken)) {
      throw new ApiError(403, 'invalid_csrf', 'Invalid CSRF token');
    }
    return tx;
  };

  router.post('/oauth/authorize/login', async (ctx) => {
    const baseUrl = computeBaseUrl(ctx);
    const body = await parseFormOrJsonBody(ctx);
    const rawTxId = body.tx_id ?? body.tx;
    const rawCsrf = body.csrf_token ?? body.csrf;
    const txId = typeof rawTxId === 'string' ? rawTxId.trim() : '';
    const csrf = typeof rawCsrf === 'string' ? rawCsrf.trim() : '';
    const tx = verifyTxAndCookie(ctx, txId, csrf);

    let authedUserId: number | null = null;
    if (body.pair_token !== undefined && (typeof body.pair_token !== 'string' || !body.pair_token.trim())) {
      throw new ApiError(400, 'invalid_request', 'pair_token must be a non-empty string');
    }
    const pairToken = typeof body.pair_token === 'string' ? body.pair_token.trim() : '';

    if (pairToken) {
      if (!tx.qrPairToken || !constantTimeUtf8Equals(pairToken, tx.qrPairToken)) {
        throw new ApiError(403, 'invalid_pair_token', 'pair_token does not match this OAuth transaction');
      }
      const qrRow = db
        .prepare(`SELECT status, approved_user_id, expires_at_ms FROM qr_pair_sessions WHERE pair_id = ?`)
        .get(tx.qrPairToken) as
        | { status: string; approved_user_id: number | null; expires_at_ms: number }
        | undefined;
      if (
        !qrRow ||
        (qrRow.status !== 'approved' && qrRow.status !== 'confirmed') ||
        !qrRow.approved_user_id ||
        !(Number(qrRow.expires_at_ms) > Date.now())
      ) {
        throw new ApiError(401, 'unauthorized', 'QR pair session is not approved or expired');
      }
      authedUserId = Number(qrRow.approved_user_id);
    } else {
      const username = typeof body.username === 'string' ? body.username.trim().replace(/^@/, '') : '';
      const password = typeof body.password === 'string' ? body.password : '';
      if (!username || !password) {
        throw new ApiError(401, 'unauthorized', 'Username and password are required');
      }
      const userRow = db
        .prepare(
          `SELECT user_id, password_salt, password_hash FROM users WHERE LOWER(username) = LOWER(?) AND is_bot = 0`,
        )
        .get(username) as
        | { user_id: number; password_salt: string | null; password_hash: string | null }
        | undefined;
      if (
        !userRow ||
        !userRow.password_salt ||
        !userRow.password_hash ||
        !verifySecretScrypt(password, userRow.password_salt, userRow.password_hash)
      ) {
        throw new ApiError(401, 'unauthorized', 'Invalid username or password');
      }
      // Enforce Cloud 2FA if configured on account
      const twofaRow = db
        .prepare(`SELECT salt_hex, hash_hex FROM twofa_secrets WHERE user_id = ?`)
        .get(userRow.user_id) as { salt_hex: string; hash_hex: string } | undefined;
      if (twofaRow) {
        const twofaPass = typeof body.twofa_password === 'string' ? body.twofa_password : '';
        if (!twofaPass || !verifySecretScrypt(twofaPass, twofaRow.salt_hex, twofaRow.hash_hex)) {
          throw new ApiError(401, 'twofa_required', 'Cloud 2FA password is required');
        }
      }
      authedUserId = Number(userRow.user_id);
    }

    tx.authenticatedUserId = authedUserId;
    tx.csrfToken = crypto.randomBytes(24).toString('hex');

    const userCookieVal = crypto.randomBytes(24).toString('hex');
    runtime.userCookies.set(sha256Hex(userCookieVal), {
      userId: authedUserId,
      expiresAtMs: Date.now() + USER_COOKIE_TTL_MS,
    });
    const secureAttr = baseUrl.startsWith('https://') ? '; Secure' : '';
    const userCookieHdr = `fbmcp_user_sess=${userCookieVal}; HttpOnly; SameSite=Lax; Path=/oauth; Max-Age=86400${secureAttr}`;

    const wantsJson = (ctx.req.headers.accept ?? '').includes('application/json');
    if (wantsJson) {
      ctx.res.setHeader('Cache-Control', 'no-store');
      ctx.res.setHeader('Set-Cookie', userCookieHdr);
      sendJson(ctx.res, 200, {
        ok: true,
        tx_id: tx.txId,
        csrf_token: tx.csrfToken,
        user_id: authedUserId,
        scopes: tx.requestedScopes,
      });
      return;
    }

    const uRow = db
      .prepare(`SELECT username, first_name FROM users WHERE user_id = ?`)
      .get(authedUserId) as { username: string | null; first_name: string } | undefined;
    const nodes = remoteAssist.listComputersForUser(authedUserId);
    sendHtml(
      ctx,
      200,
      renderOAuthConsentHtml(tx, uRow?.username || uRow?.first_name || `User #${authedUserId}`, nodes),
      [userCookieHdr],
    );
  });

  router.get('/oauth/authorize/qr-poll', (ctx) => {
    const baseUrl = computeBaseUrl(ctx);
    const txId = ctx.query.get('tx_id')?.trim() ?? '';
    const pairToken = ctx.query.get('pair_token')?.trim() ?? '';
    const tx = runtime.pendingTxs.get(txId);
    if (!tx || !(tx.expiresAtMs > Date.now())) {
      throw new ApiError(400, 'invalid_request', 'Unknown or expired OAuth transaction');
    }
    const cookies = parseCookies(ctx.req.headers.cookie);
    const cookieVal = cookies.get('fbmcp_oauth_sess') ?? '';
    if (!cookieVal || !constantTimeUtf8Equals(sha256Hex(cookieVal), tx.cookieHash)) {
      throw new ApiError(403, 'invalid_csrf', 'OAuth session cookie mismatch');
    }
    if (!tx.qrPairToken) {
      throw new ApiError(400, 'invalid_request', 'OAuth transaction does not have an active QR pair session');
    }
    if (pairToken && !constantTimeUtf8Equals(pairToken, tx.qrPairToken)) {
      throw new ApiError(403, 'invalid_pair_token', 'pair_token does not match this OAuth transaction');
    }
    const qrRow = db
      .prepare(`SELECT status, approved_user_id, expires_at_ms FROM qr_pair_sessions WHERE pair_id = ?`)
      .get(tx.qrPairToken) as
      | { status: string; approved_user_id: number | null; expires_at_ms: number }
      | undefined;
    if (!qrRow) {
      throw new ApiError(404, 'pair_not_found', 'QR pair session not found');
    }
    if (!(Number(qrRow.expires_at_ms) > Date.now())) {
      throw new ApiError(410, 'pair_expired', 'QR pair session has expired');
    }
    if ((qrRow.status === 'approved' || qrRow.status === 'confirmed') && qrRow.approved_user_id) {
      const uid = Number(qrRow.approved_user_id);
      tx.authenticatedUserId = uid;
      const userCookieVal = crypto.randomBytes(24).toString('hex');
      runtime.userCookies.set(sha256Hex(userCookieVal), {
        userId: uid,
        expiresAtMs: Date.now() + USER_COOKIE_TTL_MS,
      });
      const secureAttr = baseUrl.startsWith('https://') ? '; Secure' : '';
      ctx.res.setHeader(
        'Set-Cookie',
        `fbmcp_user_sess=${userCookieVal}; HttpOnly; SameSite=Lax; Path=/oauth; Max-Age=86400${secureAttr}`,
      );
      sendJson(ctx.res, 200, { status: 'confirmed', user_id: uid, csrf_token: tx.csrfToken });
      return;
    }
    sendJson(ctx.res, 200, { status: qrRow.status });
  });

  router.post('/oauth/authorize/approve', async (ctx) => {
    const body = await parseFormOrJsonBody(ctx);
    const rawTxId = body.tx_id ?? body.tx;
    const rawCsrf = body.csrf_token ?? body.csrf;
    const txId = typeof rawTxId === 'string' ? rawTxId.trim() : '';
    const csrf = typeof rawCsrf === 'string' ? rawCsrf.trim() : '';
    const tx = verifyTxAndCookie(ctx, txId, csrf);

    if (tx.authenticatedUserId === null) {
      throw new ApiError(401, 'unauthorized', 'Sign in before approving OAuth authorization');
    }

    const decision =
      typeof body.decision === 'string' && body.decision.trim()
        ? body.decision.trim().toLowerCase()
        : 'approve';
    const redirectUrl = new URL(tx.redirectUri);
    if (decision === 'deny' || decision === 'cancel') {
      runtime.pendingTxs.delete(txId);
      redirectUrl.searchParams.set('error', 'access_denied');
      if (tx.state !== null) redirectUrl.searchParams.set('state', tx.state);
      ctx.res.statusCode = 302;
      ctx.res.setHeader('Location', redirectUrl.toString());
      ctx.res.setHeader('Cache-Control', 'no-store');
      ctx.res.end();
      return;
    }

    let approvedScopes = tx.requestedScopes;
    const rawSubmittedScopes = body.scopes ?? body.scope;
    if (
      rawSubmittedScopes !== undefined &&
      !Array.isArray(rawSubmittedScopes) &&
      typeof rawSubmittedScopes !== 'string'
    ) {
      throw new ApiError(400, 'invalid_scope', 'scopes must be a string or string array');
    }
    if (Array.isArray(rawSubmittedScopes)) {
      const filtered = rawSubmittedScopes
        .filter((s): s is string => typeof s === 'string')
        .map((s) => s.trim())
        .filter((s) => isSupportedMcpScope(s));
      if (filtered.length > 0) approvedScopes = filtered;
    } else if (typeof rawSubmittedScopes === 'string' && rawSubmittedScopes.trim()) {
      const filtered = rawSubmittedScopes
        .trim()
        .split(/\s+/)
        .filter((s) => isSupportedMcpScope(s));
      if (filtered.length > 0) approvedScopes = filtered;
    }

    let allowedNodeIds: string[] = ['*'];
    if (body.allowed_node_ids !== undefined) {
      const rawNodes = Array.isArray(body.allowed_node_ids)
        ? body.allowed_node_ids
        : typeof body.allowed_node_ids === 'string'
          ? [body.allowed_node_ids]
          : null;
      if (!rawNodes || rawNodes.some((n) => typeof n !== 'string')) {
        throw new ApiError(400, 'invalid_request', 'allowed_node_ids must be a string or string array');
      }
      const normalized = rawNodes.map((n) => n.trim()).filter(Boolean);
      if (normalized.length > 0) {
        const ownedSet = new Set(
          remoteAssist.listComputersForUser(tx.authenticatedUserId).map((n) => n.node_id),
        );
        const invalidNodes = normalized.filter((n) => n !== '*' && !ownedSet.has(n));
        if (invalidNodes.length > 0) {
          throw new ApiError(
            403,
            'forbidden_node',
            `Requested device(s) are not owned by authenticated user: ${invalidNodes.join(', ')}`,
          );
        }
        allowedNodeIds = Array.from(new Set(normalized));
      }
    }

    // Single-use authorization transaction (consumed after validation passes)
    runtime.pendingTxs.delete(txId);

    const rawCode = `fbmcp_code_${crypto.randomBytes(24).toString('base64url')}`;
    const now = Date.now();
    db.prepare(`
      INSERT INTO mcp_oauth_codes (
        code_hash, client_id, user_id, redirect_uri, resource, code_challenge,
        code_challenge_method, scopes_json, allowed_node_ids_json, issued_family_id,
        expires_at_ms, consumed_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, 'S256', ?, ?, NULL, ?, NULL)
    `).run(
      sha256Hex(rawCode),
      tx.clientId,
      tx.authenticatedUserId,
      tx.redirectUri,
      tx.resource,
      tx.codeChallenge,
      JSON.stringify(approvedScopes),
      JSON.stringify(allowedNodeIds),
      now + AUTH_CODE_TTL_MS,
    );

    redirectUrl.searchParams.set('code', rawCode);
    if (tx.state !== null) redirectUrl.searchParams.set('state', tx.state);

    ctx.res.statusCode = 302;
    ctx.res.setHeader('Location', redirectUrl.toString());
    ctx.res.setHeader('Cache-Control', 'no-store');
    ctx.res.end();
  });

  // ==========================================================================
  // 4. Token Exchange, Rotation & Revocation (`POST /oauth/token`, `POST /oauth/revoke`)
  // ==========================================================================
  router.post('/oauth/token', async (ctx) => {
    ctx.res.setHeader('Cache-Control', 'no-store');
    ctx.res.setHeader('Pragma', 'no-cache');
    const body = await parseFormOrJsonBody(ctx);
    const grantType = typeof body.grant_type === 'string' ? body.grant_type.trim() : '';
    const now = Date.now();

    if (grantType === 'authorization_code') {
      const code = typeof body.code === 'string' ? body.code.trim() : '';
      const clientId = typeof body.client_id === 'string' ? body.client_id.trim() : '';
      const redirectUri = typeof body.redirect_uri === 'string' ? body.redirect_uri.trim() : '';
      const codeVerifier = typeof body.code_verifier === 'string' ? body.code_verifier.trim() : '';
      const resource = typeof body.resource === 'string' ? body.resource.trim() : '';

      const client = await resolveOAuthClient(db, clientId, 401);
      if (client.token_endpoint_auth_method === 'client_secret_post') {
        const providedSecret = typeof body.client_secret === 'string' ? body.client_secret : '';
        if (
          !client.client_secret_hash ||
          !providedSecret ||
          !constantTimeUtf8Equals(sha256Hex(providedSecret), client.client_secret_hash)
        ) {
          throw new ApiError(401, 'invalid_client', 'Client authentication failed');
        }
      }

      if (!code || !PKCE_VERIFIER_RE.test(codeVerifier)) {
        throw new ApiError(400, 'invalid_grant', 'Missing code or invalid PKCE code_verifier');
      }

      const codeHash = sha256Hex(code);
      let tokenResp: OAuthTokenResponse;

      db.exec('BEGIN IMMEDIATE;');
      try {
        const row = db
          .prepare(`SELECT * FROM mcp_oauth_codes WHERE code_hash = ?`)
          .get(codeHash) as Record<string, unknown> | undefined;
        if (!row || Number(row.expires_at_ms) < now) {
          db.exec('ROLLBACK;');
          throw new ApiError(400, 'invalid_grant', 'Authorization code is invalid or expired');
        }

        // Code replay attack -> revoke entire issued token family!
        if (row.consumed_at_ms !== null) {
          const famId = row.issued_family_id ? String(row.issued_family_id) : '';
          const uid = Number(row.user_id);
          if (famId) {
            db.prepare(
              `UPDATE mcp_oauth_tokens SET revoked_at_ms = ? WHERE family_id = ? AND revoked_at_ms IS NULL`,
            ).run(now, famId);
          }
          db.exec('COMMIT;');
          if (famId) {
            remoteAssist.disconnectByFamilyId(uid, famId, 'auth_code_replay');
          }
          throw new ApiError(400, 'invalid_grant', 'Authorization code reuse detected; token family revoked');
        }

        if (String(row.client_id) !== client.client_id || String(row.redirect_uri) !== redirectUri) {
          db.exec('ROLLBACK;');
          throw new ApiError(400, 'invalid_grant', 'client_id or redirect_uri mismatch');
        }
        if (resource && resource !== String(row.resource)) {
          db.exec('ROLLBACK;');
          throw new ApiError(400, 'invalid_target', 'Resource mismatch');
        }

        const expectedChallenge = String(row.code_challenge);
        const computedChallenge = sha256B64Url(codeVerifier);
        if (!constantTimeUtf8Equals(computedChallenge, expectedChallenge)) {
          db.exec('ROLLBACK;');
          throw new ApiError(400, 'invalid_grant', 'PKCE code_verifier mismatch');
        }

        const familyId = `fam_${crypto.randomBytes(12).toString('hex')}`;
        const rawAccess = `fbmcp_at_${crypto.randomBytes(32).toString('base64url')}`;
        const rawRefresh = `fbmcp_rt_${crypto.randomBytes(32).toString('base64url')}`;
        const accessId = `tok_${crypto.randomBytes(8).toString('hex')}`;
        const refreshId = `tok_${crypto.randomBytes(8).toString('hex')}`;
        const scopes = JSON.parse(String(row.scopes_json)) as string[];

        db.prepare(
          `UPDATE mcp_oauth_codes SET consumed_at_ms = ?, issued_family_id = ? WHERE code_hash = ?`,
        ).run(now, familyId, codeHash);

        const insertTok = db.prepare(`
          INSERT INTO mcp_oauth_tokens (
            token_id, family_id, token_kind, token_hash, client_id, user_id,
            resource, scopes_json, allowed_node_ids_json, created_at_ms, expires_at_ms,
            last_used_at_ms, revoked_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
        `);
        insertTok.run(
          accessId,
          familyId,
          'access',
          sha256Hex(rawAccess),
          client.client_id,
          Number(row.user_id),
          String(row.resource),
          String(row.scopes_json),
          String(row.allowed_node_ids_json),
          now,
          now + ACCESS_TOKEN_TTL_MS,
        );
        insertTok.run(
          refreshId,
          familyId,
          'refresh',
          sha256Hex(rawRefresh),
          client.client_id,
          Number(row.user_id),
          String(row.resource),
          String(row.scopes_json),
          String(row.allowed_node_ids_json),
          now,
          now + REFRESH_TOKEN_TTL_MS,
        );

        db.exec('COMMIT;');
        tokenResp = {
          access_token: rawAccess,
          token_type: 'Bearer',
          expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
          refresh_token: rawRefresh,
          scope: scopes.join(' '),
        };
      } catch (err) {
        try {
          db.exec('ROLLBACK;');
        } catch {
          // Already committed/rolled back
        }
        throw err;
      }

      sendJson(ctx.res, 200, tokenResp);
      return;
    }

    if (grantType === 'refresh_token') {
      const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token.trim() : '';
      const clientId = typeof body.client_id === 'string' ? body.client_id.trim() : '';
      const requestedScope = typeof body.scope === 'string' ? body.scope.trim() : '';
      if (!refreshToken) {
        throw new ApiError(400, 'invalid_grant', 'refresh_token is required');
      }

      const tokenHash = sha256Hex(refreshToken);
      let tokenResp: OAuthTokenResponse;

      db.exec('BEGIN IMMEDIATE;');
      try {
        const row = db
          .prepare(`SELECT * FROM mcp_oauth_tokens WHERE token_hash = ? AND token_kind = 'refresh'`)
          .get(tokenHash) as Record<string, unknown> | undefined;
        if (!row || Number(row.expires_at_ms) < now) {
          db.exec('ROLLBACK;');
          throw new ApiError(400, 'invalid_grant', 'Refresh token is invalid or expired');
        }
        const tokenClientId = String(row.client_id);
        if (clientId && clientId !== tokenClientId) {
          db.exec('ROLLBACK;');
          throw new ApiError(401, 'invalid_client', 'client_id mismatch');
        }
        const clientRow = db
          .prepare(
            `SELECT token_endpoint_auth_method, client_secret_hash FROM mcp_oauth_clients WHERE client_id = ?`,
          )
          .get(tokenClientId) as
          | { token_endpoint_auth_method: string; client_secret_hash: string | null }
          | undefined;
        if (clientRow?.token_endpoint_auth_method === 'client_secret_post') {
          const providedSecret = typeof body.client_secret === 'string' ? body.client_secret : '';
          if (
            !clientRow.client_secret_hash ||
            !providedSecret ||
            !constantTimeUtf8Equals(sha256Hex(providedSecret), clientRow.client_secret_hash)
          ) {
            db.exec('ROLLBACK;');
            throw new ApiError(401, 'invalid_client', 'Client authentication failed');
          }
        }

        const familyId = String(row.family_id);
        const uid = Number(row.user_id);

        // Refresh token replay detection -> revoke ENTIRE family & terminate sessions!
        if (row.revoked_at_ms !== null) {
          db.prepare(
            `UPDATE mcp_oauth_tokens SET revoked_at_ms = ? WHERE family_id = ? AND revoked_at_ms IS NULL`,
          ).run(now, familyId);
          db.exec('COMMIT;');
          remoteAssist.disconnectByFamilyId(uid, familyId, 'refresh_token_reuse');
          throw new ApiError(400, 'invalid_grant', 'Refresh token reuse detected');
        }

        const grantedScopes = JSON.parse(String(row.scopes_json)) as string[];
        let nextScopes = grantedScopes;
        if (requestedScope) {
          const reqList = requestedScope.split(/\s+/).filter(Boolean);
          if (reqList.some((s) => !grantedScopes.includes(s))) {
            db.exec('ROLLBACK;');
            throw new ApiError(400, 'invalid_scope', 'Requested scope exceeds originally granted scopes');
          }
          nextScopes = reqList;
        }

        // Rotate refresh token + mint fresh access token
        db.prepare(`UPDATE mcp_oauth_tokens SET revoked_at_ms = ? WHERE token_id = ?`).run(
          now,
          String(row.token_id),
        );

        const rawAccess = `fbmcp_at_${crypto.randomBytes(32).toString('base64url')}`;
        const rawRefresh = `fbmcp_rt_${crypto.randomBytes(32).toString('base64url')}`;
        const accessId = `tok_${crypto.randomBytes(8).toString('hex')}`;
        const refreshId = `tok_${crypto.randomBytes(8).toString('hex')}`;
        const nextScopesJson = JSON.stringify(nextScopes);

        const insertTok = db.prepare(`
          INSERT INTO mcp_oauth_tokens (
            token_id, family_id, token_kind, token_hash, client_id, user_id,
            resource, scopes_json, allowed_node_ids_json, created_at_ms, expires_at_ms,
            last_used_at_ms, revoked_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
        `);
        insertTok.run(
          accessId,
          familyId,
          'access',
          sha256Hex(rawAccess),
          String(row.client_id),
          uid,
          String(row.resource),
          nextScopesJson,
          String(row.allowed_node_ids_json),
          now,
          now + ACCESS_TOKEN_TTL_MS,
        );
        insertTok.run(
          refreshId,
          familyId,
          'refresh',
          sha256Hex(rawRefresh),
          String(row.client_id),
          uid,
          String(row.resource),
          nextScopesJson,
          String(row.allowed_node_ids_json),
          now,
          now + REFRESH_TOKEN_TTL_MS,
        );

        db.exec('COMMIT;');
        tokenResp = {
          access_token: rawAccess,
          token_type: 'Bearer',
          expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
          refresh_token: rawRefresh,
          scope: nextScopes.join(' '),
        };
      } catch (err) {
        try {
          db.exec('ROLLBACK;');
        } catch {
          // Already rolled back
        }
        throw err;
      }

      sendJson(ctx.res, 200, tokenResp);
      return;
    }

    throw new ApiError(400, 'unsupported_grant_type', `Unsupported grant_type: ${grantType}`);
  });

  router.post('/oauth/revoke', async (ctx) => {
    ctx.res.setHeader('Cache-Control', 'no-store');
    const body = await parseFormOrJsonBody(ctx);
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (token) {
      const row = db
        .prepare(`SELECT user_id, family_id FROM mcp_oauth_tokens WHERE token_hash = ?`)
        .get(sha256Hex(token)) as { user_id: number; family_id: string } | undefined;
      if (row) {
        const now = Date.now();
        db.prepare(
          `UPDATE mcp_oauth_tokens SET revoked_at_ms = ? WHERE family_id = ? AND revoked_at_ms IS NULL`,
        ).run(now, row.family_id);
        remoteAssist.disconnectByFamilyId(Number(row.user_id), row.family_id, 'token_revoked');
      }
    }
    sendJson(ctx.res, 200, { revoked: true });
  });

  // ==========================================================================
  // 5. Grant Management & Audit Log API (`/api/v1/mcp/{grants, grants/:familyId, audit}`)
  // ==========================================================================
  router.get('/api/v1/mcp/grants', (ctx) => {
    const auth = requireAuth(db, ctx);
    const now = Date.now();
    const rows = db
      .prepare(
        `SELECT t.family_id, t.client_id, COALESCE(c.client_name, t.client_id) AS client_name,
                t.scopes_json, t.allowed_node_ids_json,
                MIN(t.created_at_ms) AS created_at_ms,
                MAX(t.last_used_at_ms) AS last_used_ms,
                MAX(t.expires_at_ms) AS expires_at_ms
         FROM mcp_oauth_tokens t
         LEFT JOIN mcp_oauth_clients c ON c.client_id = t.client_id
         WHERE t.user_id = ? AND t.revoked_at_ms IS NULL AND t.expires_at_ms > ?
         GROUP BY t.family_id
         ORDER BY created_at_ms DESC`,
      )
      .all(auth.userId, now) as Array<Record<string, unknown>>;

    const grants: OAuthGrantSummary[] = rows.map((r) => ({
      family_id: String(r.family_id),
      client_id: String(r.client_id),
      client_name: String(r.client_name),
      scopes: JSON.parse(String(r.scopes_json)) as string[],
      allowed_node_ids: JSON.parse(String(r.allowed_node_ids_json)) as string[],
      created_at_ms: Number(r.created_at_ms),
      last_used_ms: r.last_used_ms !== null ? Number(r.last_used_ms) : null,
      expires_at_ms: Number(r.expires_at_ms),
    }));
    sendJson(ctx.res, 200, { grants });
  });

  router.delete('/api/v1/mcp/grants/:familyId', (ctx) => {
    const auth = requireAuth(db, ctx);
    const familyId = ctx.params.familyId!;
    const now = Date.now();
    const res = db
      .prepare(
        `UPDATE mcp_oauth_tokens SET revoked_at_ms = ?
         WHERE user_id = ? AND family_id = ? AND revoked_at_ms IS NULL`,
      )
      .run(now, auth.userId, familyId);
    if (Number(res.changes ?? 0) === 0) {
      throw new ApiError(404, 'grant_not_found', `OAuth grant family '${familyId}' not found`);
    }
    remoteAssist.disconnectByFamilyId(auth.userId, familyId, 'grant_revoked');
    sendJson(ctx.res, 200, { revoked: true, family_id: familyId });
  });

  router.get('/api/v1/mcp/audit', (ctx) => {
    const auth = requireAuth(db, ctx);
    const limit = parseBoundedQueryInt(ctx.query.get('limit'), 50, 1, 500);
    const rows = db
      .prepare(
        `SELECT * FROM mcp_tool_audit_log WHERE user_id = ? ORDER BY created_at_ms DESC LIMIT ?`,
      )
      .all(auth.userId, limit) as Array<Record<string, unknown>>;

    const entries: McpAuditEntry[] = rows.map((r) => ({
      audit_id: String(r.audit_id),
      user_id: Number(r.user_id),
      client_id: String(r.client_id),
      family_id: String(r.family_id),
      session_id: String(r.session_id),
      tool_name: String(r.tool_name),
      target_node_id: (r.target_node_id as string | null) ?? null,
      args_summary: String(r.args_summary),
      ok: Boolean(Number(r.ok)),
      error_code: (r.error_code as string | null) ?? null,
      duration_ms: Number(r.duration_ms),
      created_at_ms: Number(r.created_at_ms),
    }));
    sendJson(ctx.res, 200, { entries, total: entries.length });
  });

  // ==========================================================================
  // 6. Streamable HTTP & SSE Official MCP Endpoint (`POST / GET / DELETE /mcp`)
  // ==========================================================================
  const sendMcpRpcError = (
    ctx: RequestContext,
    httpStatus: number,
    rpcId: string | number | null,
    code: number,
    message: string,
    wwwAuthenticate?: string,
  ): void => {
    if (wwwAuthenticate) {
      ctx.res.setHeader('WWW-Authenticate', wwwAuthenticate);
    }
    sendJson(ctx.res, httpStatus, {
      jsonrpc: '2.0',
      id: rpcId,
      error: { code, message },
    });
  };

  const authenticateMcpBearer = (
    ctx: RequestContext,
    rpcId: string | number | null,
  ): VerifiedMcpBearer | null => {
    const baseUrl = computeBaseUrl(ctx);
    const wwwAuth = `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource", scope="devices:read devices:connect"`;
    const rawToken = extractBearerToken(ctx.req, ctx.query);
    if (!rawToken) {
      sendMcpRpcError(ctx, 401, rpcId, -32001, 'Missing OAuth 2.1 Bearer access token', wwwAuth);
      return null;
    }
    const tokenHash = sha256Hex(rawToken);
    const now = Date.now();
    const row = db
      .prepare(
        `SELECT t.*, COALESCE(c.client_name, t.client_id) AS client_name
         FROM mcp_oauth_tokens t
         LEFT JOIN mcp_oauth_clients c ON c.client_id = t.client_id
         WHERE t.token_hash = ? AND t.token_kind = 'access'`,
      )
      .get(tokenHash) as Record<string, unknown> | undefined;

    if (!row || row.revoked_at_ms !== null || Number(row.expires_at_ms) <= now) {
      sendMcpRpcError(ctx, 401, rpcId, -32001, 'Invalid, expired, or revoked Bearer access token', wwwAuth);
      return null;
    }

    const rowResource = String(row.resource ?? '');
    if (rowResource && rowResource !== `${baseUrl}/mcp` && rowResource !== baseUrl) {
      sendMcpRpcError(ctx, 401, rpcId, -32001, 'Bearer token audience/resource mismatch', wwwAuth);
      return null;
    }

    db.prepare(`UPDATE mcp_oauth_tokens SET last_used_at_ms = ? WHERE token_id = ?`).run(
      now,
      String(row.token_id),
    );

    const verified: VerifiedMcpBearer = {
      tokenId: String(row.token_id),
      tokenHash,
      familyId: String(row.family_id),
      clientId: String(row.client_id),
      clientName: String(row.client_name),
      userId: Number(row.user_id),
      resource: rowResource,
      scopes: JSON.parse(String(row.scopes_json)) as string[],
      allowedNodeIds: JSON.parse(String(row.allowed_node_ids_json)) as string[],
    };
    runtime.recordSeenToken(verified.userId, tokenHash);
    return verified;
  };

  const recordToolAudit = (params: {
    userId: number;
    clientId: string;
    familyId: string;
    sessionId: string;
    toolName: string;
    targetNodeId?: string | null;
    args: Record<string, unknown>;
    ok: boolean;
    errorCode?: string | null;
    durationMs: number;
  }): void => {
    db.prepare(`
      INSERT INTO mcp_tool_audit_log (
        audit_id, user_id, client_id, family_id, session_id, tool_name,
        target_node_id, args_summary, ok, error_code, duration_ms, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `maud_${crypto.randomBytes(8).toString('hex')}`,
      params.userId,
      params.clientId,
      params.familyId,
      params.sessionId,
      params.toolName,
      params.targetNodeId ?? null,
      summarizeArgsForAudit(params.args),
      params.ok ? 1 : 0,
      params.errorCode ?? null,
      params.durationMs,
      Date.now(),
    );
  };

  const executeOfficialTool = async (
    verified: VerifiedMcpBearer,
    tool: OfficialMcpToolDef,
    args: Record<string, unknown>,
    sessionId: string,
  ): Promise<{ isError?: boolean; content: Array<{ type: 'text'; text: string }> }> => {
    const textResult = (payload: unknown, isError = false) => ({
      ...(isError ? { isError: true } : {}),
      content: [{ type: 'text' as const, text: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
    });

    if (tool.deviceOp) {
      const nodeId = typeof args.node_id === 'string' ? args.node_id.trim() : '';
      if (!nodeId) {
        return textResult({ error: 'missing_node_id', message: 'node_id is required' }, true);
      }
      if (tool.name === 'device_power_action' && args.confirm !== true) {
        return textResult({ error: 'confirmation_required', message: 'device_power_action requires confirm: true' }, true);
      }
      const opMap = new Map<string, Record<string, unknown>>([
        ['capture_screen', { op: 'capture_screen' }],
        ['get_accessibility_tree', { op: 'accessibility_tree', max_depth: args.max_depth ?? 5 }],
        ['semantic_ui_action', { op: 'semantic_action', element_id: args.element_id, action: args.action, value: args.value }],
        ['mouse_action', { op: 'mouse_action', ...args }],
        ['keyboard_type', { op: 'keyboard_action', action: 'type', text: args.text }],
        ['keyboard_hotkey', { op: 'keyboard_action', action: 'hotkey', key: args.key, modifiers: args.modifiers ?? [] }],
        ['clipboard_get', { op: 'clipboard_get' }],
        ['clipboard_set', { op: 'clipboard_set', text: args.text }],
        ['terminal_list', { op: 'terminal_op', terminal_op: 'ls' }],
        ['terminal_open', { op: 'terminal_op', terminal_op: 'open', session_name: args.session_name, shell: args.shell }],
        ['terminal_exec', { op: 'shell_exec', command: args.command, timeout_ms: args.timeout_ms }],
        ['terminal_send', { op: 'terminal_op', terminal_op: 'send', session_name: args.session_name, input: args.input }],
        ['terminal_read', { op: 'terminal_op', terminal_op: 'read', session_name: args.session_name }],
        ['terminal_kill', { op: 'terminal_op', terminal_op: 'kill', session_name: args.session_name }],
        ['file_list', { op: 'list_dir', path: args.path }],
        ['file_read', { op: 'read_file', path: args.path, max_bytes: args.max_bytes }],
        ['file_write', { op: 'write_file', path: args.path, content: args.content, create_dirs: args.create_dirs }],
        ['device_power_action', { op: 'power_action', action: { kind: args.kind } }],
      ]);
      const opPayload = opMap.get(tool.name) ?? { op: tool.name, ...args };
      try {
        const res = await remoteAssist.executeComputerCommand(
          verified.userId,
          nodeId,
          `MCP (${verified.clientName})`,
          opPayload,
          { timeoutMs: 12_000 },
        );
        return textResult(res);
      } catch (err) {
        const code = err instanceof ApiError ? err.code : 'device_offline';
        const msg = err instanceof Error ? err.message : 'Device execution failed';
        return textResult({ ok: false, error: code, message: msg }, true);
      }
    }

    switch (tool.name) {
      case 'list_devices':
        return textResult({ devices: remoteAssist.listComputersForUser(verified.userId) });

      case 'get_device_status': {
        const nodeId = typeof args.node_id === 'string' ? args.node_id.trim() : '';
        const found = remoteAssist.listComputersForUser(verified.userId).find((n) => n.node_id === nodeId);
        if (!found) return textResult({ error: 'computer_not_found' }, true);
        return textResult(found);
      }

      case 'assist_get_info': {
        const devId = typeof args.device_id === 'string' ? args.device_id : 'default';
        return textResult(remoteAssist.getOrInitAssistConfig(verified.userId, devId));
      }

      case 'assist_manage': {
        const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : '';
        const devId = typeof args.device_id === 'string' ? args.device_id : 'default';
        if (action === 'reset_code') return textResult(remoteAssist.resetAssistCode(verified.userId, devId));
        if (action === 'allow') return textResult(remoteAssist.setAllowAssist(verified.userId, true, devId));
        if (action === 'disallow') return textResult(remoteAssist.setAllowAssist(verified.userId, false, devId));
        return textResult({ error: 'invalid_action' }, true);
      }

      case 'request_human_takeover': {
        const nodeId = typeof args.node_id === 'string' ? args.node_id.trim() : '';
        if (!nodeId) {
          return textResult(
            { ok: false, error: 'computer_not_found', message: 'node_id is required' },
            true,
          );
        }
        const reason = typeof args.reason === 'string' ? args.reason.trim().slice(0, 500) : '';
        const instructions =
          typeof args.instructions === 'string' ? args.instructions.trim().slice(0, 1000) : '';
        const takeover = remoteAssist.requestHumanTakeover(verified.userId, nodeId, {
          reason,
          instructions,
          sessionId,
          clientName: verified.clientName,
        });
        if (!takeover) {
          return textResult(
            {
              ok: false,
              error: 'computer_not_found',
              message: `Computer node '${nodeId}' not found for authorized user`,
            },
            true,
          );
        }
        return textResult({
          ok: true,
          node_id: takeover.node.node_id,
          new_generation: takeover.node.lease_generation,
          lease_state: takeover.node.lease_state,
          reason,
          disconnected_guests: takeover.disconnectedGuests,
        });
      }

      case 'list_dialogs': {
        const limit = parseStrictMcpLimit(args.limit, 50, 1, 200);
        if (limit === null) return textResult({ error: 'invalid_limit' }, true);
        const dialogs = listUserDialogsForMcp(db, verified.userId, limit);
        return textResult({ dialogs, total: dialogs.length });
      }

      case 'get_chat_history': {
        const chatId = parseStrictPositiveInt(args.chat_id);
        if (chatId === null) return textResult({ error: 'invalid_chat_id' }, true);
        ensureChatReadAccess(db, chatId, verified.userId);
        const limit = parseStrictMcpLimit(args.limit, 20, 1, 100);
        if (limit === null) return textResult({ error: 'invalid_limit' }, true);
        const rows = db
          .prepare(
            `SELECT message_id, sender_id, text_plain, date_ms FROM messages
             WHERE chat_id = ? ORDER BY message_id DESC LIMIT ?`,
          )
          .all(chatId, limit);
        return textResult({ chat_id: chatId, messages: rows });
      }

      case 'send_message': {
        const chatId = parseStrictPositiveInt(args.chat_id);
        const text = typeof args.text === 'string' ? args.text.trim() : '';
        if (chatId === null || !text) {
          return textResult({ error: 'invalid_params', message: 'chat_id and text are required' }, true);
        }
        ensureChatWriteAccess(db, chatId, verified.userId);
        const created = createMessageAtomic(db, hub, {
          chatId,
          senderId: verified.userId,
          text,
        });
        return textResult({ ok: true, chat_id: chatId, message_id: created.message.id, pts: created.pts });
      }

      case 'search_messages': {
        const q = typeof args.query === 'string' ? args.query.trim() : '';
        if (!q) return textResult({ error: 'invalid_query' }, true);
        const limit = parseStrictMcpLimit(args.limit, 20, 1, 100);
        if (limit === null) return textResult({ error: 'invalid_limit' }, true);
        const rows = db
          .prepare(
            `SELECT m.chat_id, m.message_id, m.sender_id, m.text_plain, m.date_ms
             FROM messages m
             INNER JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = ? AND cm.role != 'banned'
             WHERE m.text_plain LIKE ?
             ORDER BY m.date_ms DESC LIMIT ?`,
          )
          .all(verified.userId, `%${q}%`, limit);
        return textResult({ hits: rows, total: rows.length });
      }

      case 'list_tasks': {
        const rows = db
          .prepare(`SELECT task_json FROM tasks WHERE user_id = ? ORDER BY updated_at_ms DESC`)
          .all(verified.userId) as Array<{ task_json: string }>;
        return textResult({ tasks: rows.map((r) => JSON.parse(r.task_json)) });
      }

      case 'create_task': {
        const title = typeof args.title === 'string' ? args.title.trim() : '';
        if (!title) return textResult({ error: 'invalid_task_title' }, true);
        const now = Date.now();
        const taskId = `task_${crypto.randomBytes(6).toString('hex')}`;
        const task = {
          id: taskId,
          task_id: taskId,
          title,
          description: typeof args.description === 'string' ? args.description : '',
          state: 'queued',
          cron_expr: null,
          next_run_ms: null,
          chat_id: null,
          progress: 0,
          logs: [],
          created_at_ms: now,
          updated_at_ms: now,
        };
        db.prepare(`INSERT INTO tasks (task_id, user_id, task_json, updated_at_ms) VALUES (?, ?, ?, ?)`).run(
          taskId,
          verified.userId,
          JSON.stringify(task),
          now,
        );
        return textResult(task);
      }

      case 'list_bots': {
        const rows = db
          .prepare(`SELECT bot_user_id, owner_user_id, bot_json FROM bots_registry ORDER BY bot_user_id ASC`)
          .all() as Array<{ bot_user_id: number; owner_user_id: number; bot_json: string }>;
        const bots: BotRegistryEntry[] = [];
        for (const r of rows) {
          const entry = JSON.parse(r.bot_json) as BotRegistryEntry;
          if (!isBotVisibleToUser(db, verified.userId, Number(r.bot_user_id), Number(r.owner_user_id), entry)) {
            continue;
          }
          bots.push(redactBotEntryForViewer(verified.userId, Number(r.owner_user_id), entry));
        }
        return textResult({ bots });
      }

      case 'miniapp_list': {
        const rows = db
          .prepare(`SELECT app_json FROM mini_apps ORDER BY created_at_ms ASC`)
          .all() as Array<{ app_json: string }>;
        return textResult({ apps: rows.map((r) => JSON.parse(r.app_json)) });
      }

      default:
        return textResult({ error: 'unknown_tool' }, true);
    }
  };

  const validateMcpProtocolVersionHeader = (ctx: RequestContext): string | null => {
    const rawHeaderVer = ctx.req.headers['mcp-protocol-version'];
    const headerVer = typeof rawHeaderVer === 'string' ? rawHeaderVer.trim() : '';
    if (headerVer && !isSupportedMcpProtocolVersion(headerVer)) {
      sendMcpRpcError(
        ctx,
        400,
        null,
        -32600,
        `Unsupported MCP-Protocol-Version: ${headerVer}. Supported: ${MCP_PROTOCOL_VERSIONS.join(', ')}`,
      );
      return null;
    }
    return headerVer;
  };

  router.post('/mcp', async (ctx) => {
    const headerVer = validateMcpProtocolVersionHeader(ctx);
    if (headerVer === null) return;

    let body: {
      jsonrpc?: string;
      id?: unknown;
      method?: string;
      params?: Record<string, unknown>;
    };
    try {
      const rawBuf = await readRawBody(ctx.req, 2 * 1024 * 1024);
      const parsed: unknown = rawBuf.length > 0 ? JSON.parse(rawBuf.toString('utf8')) : null;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        sendMcpRpcError(ctx, 400, null, -32600, 'Invalid JSON-RPC request object');
        return;
      }
      body = parsed as typeof body;
    } catch {
      sendMcpRpcError(ctx, 400, null, -32700, 'JSON parse error');
      return;
    }

    const rpcId =
      typeof body.id === 'string' || typeof body.id === 'number' || body.id === null ? body.id : null;
    const method = typeof body.method === 'string' ? body.method : '';

    const verified = authenticateMcpBearer(ctx, rpcId);
    if (!verified) return;

    // Enforce Kill Switch on previously seen tokens (without deleting DB grants!)
    if (runtime.terminatedTokenHashes.has(verified.tokenHash)) {
      sendMcpRpcError(
        ctx,
        410,
        rpcId,
        -32001,
        'MCP session disconnected by host user kill-switch',
      );
      return;
    }

    const rawSessId = ctx.req.headers['mcp-session-id'];
    const sessionIdHdr = typeof rawSessId === 'string' ? rawSessId.trim() : '';
    let activeSession: McpSessionEntry | undefined;

    if (sessionIdHdr) {
      activeSession = runtime.sessions.get(sessionIdHdr);
      if (!activeSession) {
        sendMcpRpcError(ctx, 404, rpcId, -32001, `Unknown Mcp-Session-Id: ${sessionIdHdr}`);
        return;
      }
      if (activeSession.userId !== verified.userId) {
        sendMcpRpcError(ctx, 403, rpcId, -32001, 'Mcp-Session-Id belongs to a different user');
        return;
      }
      if (activeSession.terminated) {
        sendMcpRpcError(
          ctx,
          410,
          rpcId,
          -32001,
          `MCP session disconnected (${activeSession.terminatedReason || 'user_kill_switch'})`,
        );
        return;
      }
    }

    const negotiatedVersion = headerVer || activeSession?.protocolVersion || DEFAULT_MCP_PROTOCOL_VERSION;
    ctx.res.setHeader('MCP-Protocol-Version', negotiatedVersion);

    if (method === 'initialize') {
      const params =
        body.params && typeof body.params === 'object' && !Array.isArray(body.params)
          ? body.params
          : {};
      const reqVer = typeof params.protocolVersion === 'string' ? params.protocolVersion.trim() : '';
      const finalVer = isSupportedMcpProtocolVersion(reqVer)
        ? reqVer
        : DEFAULT_MCP_PROTOCOL_VERSION;
      const newSessionId = `mcp_sess_${crypto.randomBytes(16).toString('hex')}`;
      const entry: McpSessionEntry = {
        sessionId: newSessionId,
        userId: verified.userId,
        clientId: verified.clientId,
        clientName: verified.clientName,
        familyId: verified.familyId,
        protocolVersion: finalVer,
        scopes: verified.scopes,
        allowedNodeIds: verified.allowedNodeIds,
        createdAtMs: Date.now(),
        terminated: false,
        sseSubscribers: new Set(),
      };
      runtime.sessions.set(newSessionId, entry);

      // Register in RemoteSessionRegistry so `GET /api/v1/remote/sessions` & kill switch track it!
      remoteAssist.registerRemoteSession({
        sessionId: newSessionId,
        ownerUserId: verified.userId,
        controllerUserId: verified.userId,
        controllerKind: 'ai_mcp',
        controllerName: verified.clientName,
        controllerPlatform: 'mcp',
        controllerId: verified.familyId,
        targetNodeId: verified.allowedNodeIds[0] ?? '*',
        targetDeviceId: 'mcp',
        mode: 'ai_control',
      });

      ctx.res.setHeader('MCP-Protocol-Version', finalVer);
      ctx.res.setHeader('Mcp-Session-Id', newSessionId);
      sendJson(ctx.res, 200, {
        jsonrpc: '2.0',
        id: rpcId,
        result: {
          protocolVersion: finalVer,
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
          },
          serverInfo: {
            name: 'fabushi-official-mcp',
            version: config.appVersion,
            title: 'Fabushi Official MCP Server',
          },
        },
      });
      return;
    }

    if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
      ctx.res.statusCode = 202;
      ctx.res.end();
      return;
    }

    if (method === 'ping') {
      sendJson(ctx.res, 200, { jsonrpc: '2.0', id: rpcId, result: {} });
      return;
    }

    if (method === 'tools/list') {
      sendJson(ctx.res, 200, {
        jsonrpc: '2.0',
        id: rpcId,
        result: {
          tools: OFFICIAL_MCP_TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
      });
      return;
    }

    if (method === 'resources/list') {
      sendJson(ctx.res, 200, {
        jsonrpc: '2.0',
        id: rpcId,
        result: {
          resources: [
            {
              uri: 'fabushi://devices',
              name: 'devices',
              description: 'Registered remote computer devices for the authenticated user',
              mimeType: 'application/json',
            },
            {
              uri: 'fabushi://sessions',
              name: 'sessions',
              description: 'Active remote control and MCP sessions for the authenticated user',
              mimeType: 'application/json',
            },
            {
              uri: 'fabushi://dialogs',
              name: 'dialogs',
              description: 'Chats and dialogs accessible to the authenticated user',
              mimeType: 'application/json',
            },
          ],
        },
      });
      return;
    }

    if (method === 'resources/read') {
      const baseUrl = computeBaseUrl(ctx);
      const params =
        body.params && typeof body.params === 'object' && !Array.isArray(body.params)
          ? body.params
          : {};
      const uri = typeof params.uri === 'string' ? params.uri.trim() : '';

      const requireScope = (scope: string): boolean => {
        if (!verified.scopes.includes(scope)) {
          sendMcpRpcError(
            ctx,
            403,
            rpcId,
            -32002,
            `Insufficient scope: requires '${scope}'`,
            `Bearer error="insufficient_scope", scope="${scope}", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
          );
          return false;
        }
        return true;
      };

      if (uri === 'fabushi://devices') {
        if (!requireScope('devices:read')) return;
        const devices = remoteAssist.listComputersForUser(verified.userId);
        sendJson(ctx.res, 200, {
          jsonrpc: '2.0',
          id: rpcId,
          result: {
            contents: [{ uri, mimeType: 'application/json', text: JSON.stringify({ devices }) }],
          },
        });
        return;
      }

      if (uri === 'fabushi://sessions') {
        if (!requireScope('devices:read')) return;
        const sessions = remoteAssist.listActiveSessions(verified.userId);
        sendJson(ctx.res, 200, {
          jsonrpc: '2.0',
          id: rpcId,
          result: {
            contents: [{ uri, mimeType: 'application/json', text: JSON.stringify({ sessions }) }],
          },
        });
        return;
      }

      if (uri === 'fabushi://dialogs') {
        if (!requireScope('chats:read')) return;
        const dialogs = listUserDialogsForMcp(db, verified.userId, 100);
        sendJson(ctx.res, 200, {
          jsonrpc: '2.0',
          id: rpcId,
          result: {
            contents: [{ uri, mimeType: 'application/json', text: JSON.stringify({ dialogs }) }],
          },
        });
        return;
      }

      sendMcpRpcError(ctx, 404, rpcId, -32602, `Unknown resource URI: ${uri}`);
      return;
    }

    if (method === 'tools/call') {
      const baseUrl = computeBaseUrl(ctx);
      const t0 = Date.now();
      const params =
        body.params && typeof body.params === 'object' && !Array.isArray(body.params)
          ? body.params
          : {};
      const toolName = typeof params.name === 'string' ? params.name.trim() : '';
      const args =
        params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};

      const tool = OFFICIAL_MCP_TOOL_MAP.get(toolName);
      if (!tool) {
        sendMcpRpcError(ctx, 404, rpcId, -32601, `Unknown MCP tool: ${toolName}`);
        return;
      }

      const targetNodeId = typeof args.node_id === 'string' ? args.node_id.trim() : null;

      // Enforce OAuth 2.1 scope
      if (!verified.scopes.includes(tool.requiredScope)) {
        recordToolAudit({
          userId: verified.userId,
          clientId: verified.clientId,
          familyId: verified.familyId,
          sessionId: sessionIdHdr,
          toolName: tool.name,
          targetNodeId,
          args,
          ok: false,
          errorCode: 'insufficient_scope',
          durationMs: Math.max(0, Date.now() - t0),
        });
        sendMcpRpcError(
          ctx,
          403,
          rpcId,
          -32002,
          `Insufficient scope: tool '${tool.name}' requires '${tool.requiredScope}'`,
          `Bearer error="insufficient_scope", scope="${tool.requiredScope}", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
        );
        return;
      }

      // Enforce device allowlist if targeting a specific node_id
      if (
        targetNodeId &&
        !verified.allowedNodeIds.includes('*') &&
        !verified.allowedNodeIds.includes(targetNodeId)
      ) {
        recordToolAudit({
          userId: verified.userId,
          clientId: verified.clientId,
          familyId: verified.familyId,
          sessionId: sessionIdHdr,
          toolName: tool.name,
          targetNodeId,
          args,
          ok: false,
          errorCode: 'device_not_authorized',
          durationMs: Math.max(0, Date.now() - t0),
        });
        sendMcpRpcError(ctx, 403, rpcId, -32003, `Device '${targetNodeId}' is not authorized by this grant`);
        return;
      }

      let toolResult: { isError?: boolean; content: Array<{ type: 'text'; text: string }> };
      try {
        toolResult = await executeOfficialTool(verified, tool, args, sessionIdHdr);
      } catch (err) {
        const isApi = err instanceof ApiError;
        const httpStatus = isApi ? err.status : 500;
        const errCode = isApi ? err.code : 'internal_error';
        const rpcCode =
          httpStatus === 403
            ? -32003
            : httpStatus === 404
              ? -32004
              : httpStatus === 400
                ? -32602
                : -32603;
        const errMsg = err instanceof Error ? err.message : 'Tool execution failed';
        recordToolAudit({
          userId: verified.userId,
          clientId: verified.clientId,
          familyId: verified.familyId,
          sessionId: sessionIdHdr,
          toolName: tool.name,
          targetNodeId,
          args,
          ok: false,
          errorCode: errCode,
          durationMs: Math.max(0, Date.now() - t0),
        });
        sendMcpRpcError(ctx, httpStatus, rpcId, rpcCode, errMsg);
        return;
      }

      recordToolAudit({
        userId: verified.userId,
        clientId: verified.clientId,
        familyId: verified.familyId,
        sessionId: sessionIdHdr,
        toolName: tool.name,
        targetNodeId,
        args,
        ok: !toolResult.isError,
        errorCode: toolResult.isError ? 'tool_error' : null,
        durationMs: Math.max(0, Date.now() - t0),
      });

      sendJson(ctx.res, 200, {
        jsonrpc: '2.0',
        id: rpcId,
        result: toolResult,
      });
      return;
    }

    sendMcpRpcError(ctx, 404, rpcId, -32601, `Unknown JSON-RPC method: ${method}`);
  });

  // Streamable HTTP SSE stream (`GET /mcp`)
  router.get('/mcp', (ctx) => {
    const headerVer = validateMcpProtocolVersionHeader(ctx);
    if (headerVer === null) return;

    const verified = authenticateMcpBearer(ctx, null);
    if (!verified) return;

    if (runtime.terminatedTokenHashes.has(verified.tokenHash)) {
      sendMcpRpcError(ctx, 410, null, -32001, 'MCP session disconnected by host user kill-switch');
      return;
    }

    const rawSessId = ctx.req.headers['mcp-session-id'];
    const sessionIdHdr = typeof rawSessId === 'string' ? rawSessId.trim() : '';
    let sessionEntry: McpSessionEntry | undefined;

    if (sessionIdHdr) {
      sessionEntry = runtime.sessions.get(sessionIdHdr);
      if (!sessionEntry) {
        sendMcpRpcError(ctx, 404, null, -32001, `Unknown Mcp-Session-Id: ${sessionIdHdr}`);
        return;
      }
      if (sessionEntry.userId !== verified.userId) {
        sendMcpRpcError(ctx, 403, null, -32001, 'Mcp-Session-Id belongs to a different user');
        return;
      }
      if (sessionEntry.terminated) {
        sendMcpRpcError(ctx, 410, null, -32001, 'MCP session disconnected');
        return;
      }
    }

    ctx.res.setHeader(
      'MCP-Protocol-Version',
      headerVer || sessionEntry?.protocolVersion || DEFAULT_MCP_PROTOCOL_VERSION,
    );
    if (sessionEntry) {
      ctx.res.setHeader('Mcp-Session-Id', sessionEntry.sessionId);
    }

    const sse = beginSseStream(ctx.res);
    sse.sendEvent('message', {
      jsonrpc: '2.0',
      method: 'notifications/ready',
      params: { session_id: sessionEntry?.sessionId ?? null },
    });

    let sessionSub: { sse: SseStreamHandle; keepalive: NodeJS.Timeout } | undefined;
    let standaloneSub: StandaloneSseSub | undefined;

    const keepalive = setInterval(() => {
      try {
        ctx.res.write(': ping\n\n');
      } catch {
        clearInterval(keepalive);
        if (sessionEntry && sessionSub) {
          sessionEntry.sseSubscribers.delete(sessionSub);
        }
        if (standaloneSub) {
          runtime.standaloneSseSubscribers.delete(standaloneSub);
        }
      }
    }, 20_000);
    keepalive.unref();

    if (sessionEntry) {
      sessionSub = { sse, keepalive };
      sessionEntry.sseSubscribers.add(sessionSub);
    } else {
      standaloneSub = {
        userId: verified.userId,
        familyId: verified.familyId,
        sse,
        keepalive,
      };
      runtime.standaloneSseSubscribers.add(standaloneSub);
    }

    ctx.req.on('close', () => {
      clearInterval(keepalive);
      if (sessionEntry && sessionSub) {
        sessionEntry.sseSubscribers.delete(sessionSub);
      }
      if (standaloneSub) {
        runtime.standaloneSseSubscribers.delete(standaloneSub);
      }
    });
  });

  // Explicit MCP Session Teardown (`DELETE /mcp`)
  router.delete('/mcp', (ctx) => {
    const headerVer = validateMcpProtocolVersionHeader(ctx);
    if (headerVer === null) return;

    const verified = authenticateMcpBearer(ctx, null);
    if (!verified) return;

    const rawSessId = ctx.req.headers['mcp-session-id'];
    const sessionIdHdr = typeof rawSessId === 'string' ? rawSessId.trim() : '';
    if (!sessionIdHdr) {
      sendMcpRpcError(ctx, 400, null, -32600, 'Mcp-Session-Id header is required');
      return;
    }
    const entry = runtime.sessions.get(sessionIdHdr);
    if (!entry) {
      sendMcpRpcError(ctx, 404, null, -32001, `Unknown Mcp-Session-Id: ${sessionIdHdr}`);
      return;
    }
    if (entry.userId !== verified.userId) {
      sendMcpRpcError(ctx, 403, null, -32001, 'Mcp-Session-Id belongs to a different user');
      return;
    }

    ctx.res.setHeader(
      'MCP-Protocol-Version',
      headerVer || entry.protocolVersion || DEFAULT_MCP_PROTOCOL_VERSION,
    );
    remoteAssist.disconnectSession(verified.userId, sessionIdHdr, 'client_deleted_session');
    sendJson(ctx.res, 200, { closed: true, session_id: sessionIdHdr });
  });
}
