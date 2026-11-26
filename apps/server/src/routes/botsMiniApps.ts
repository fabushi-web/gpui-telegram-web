import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  escapeHtml,
  extractWebMcpPageError,
  resolveGrokBotAvatar,
  type BotRegistryEntry,
  type MiniAppControlMode,
  type MiniAppEntry,
  type MiniAppLaunchContext,
  type MiniAppTakeoverState,
  type MiniAppThemeParams,
  type MiniAppWebMcpCommand,
  type MiniAppWebMcpResponse,
} from '@gpui-telegram/protocol';
import type { ServerConfig } from '../config.js';
import {
  createMessageAtomic,
  deleteMessagesAtomic,
  editMessageAtomic,
  ensureChatMembership,
  ensureChatReadAccess,
  ensureChatWriteAccess,
  getChatDetailDto,
  getUserProfileDto,
  parseOptionalPositiveInt,
} from '../db/queries.js';

function parsePositiveIdParam(raw: unknown): number | undefined {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw >= 1 ? raw : undefined;
  }
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    const n = Number(raw.trim());
    return Number.isSafeInteger(n) && n >= 1 ? n : undefined;
  }
  return undefined;
}
import { signMiniAppInitData, verifyMiniAppInitData } from '../utils/crypto.js';
import {
  ApiError,
  authenticateToken,
  extractBearerToken,
  readJsonBody,
  requireAuth,
  sendJson,
  type HttpRouter,
  type RequestContext,
} from '../utils/http.js';
import type { RealtimeGatewayHub } from '../ws/hub.js';

const NIGHT_THEME_PARAMS: MiniAppThemeParams = {
  bg_color: '#17212B',
  text_color: '#F5F5F5',
  hint_color: '#7F91A4',
  link_color: '#3390EC',
  button_color: '#3390EC',
  button_text_color: '#FFFFFF',
  secondary_bg_color: '#0E1621',
  header_bg_color: '#17212B',
};

const DEFAULT_WEBMCP_RPC_TIMEOUT_MS = 18_000;

// ============================================================================
// WebMCP WebSocket Relay Broker (`MiniAppWebMcpBroker`)
// ============================================================================

interface PendingWebMcpCall {
  senderUserId: number;
  resolve: (res: MiniAppWebMcpResponse & { page_error?: unknown; warning?: string }) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class MiniAppWebMcpBroker {
  private readonly pendingCalls = new Map<string, PendingWebMcpCall>();
  private readonly takeoverStates = new Map<string, MiniAppTakeoverState>();
  private readonly takeoverWaiters = new Map<string, Array<(state: MiniAppTakeoverState) => void>>();

  constructor(private readonly hub: RealtimeGatewayHub) {}

  private appKey(userId: number, botUsername: string, shortName: string): string {
    return `${userId}:${botUsername.toLowerCase()}:${shortName.toLowerCase()}`;
  }

  handleResult(responderUserId: number, response: MiniAppWebMcpResponse): void {
    const pending = this.pendingCalls.get(response.request_id);
    if (!pending) return;
    // Strict tenant isolation: reject cross-user WebMCP responses
    if (pending.senderUserId !== responderUserId) return;

    clearTimeout(pending.timer);
    this.pendingCalls.delete(response.request_id);

    const pageErr = extractWebMcpPageError(response.state_summary);
    if (pageErr) {
      pending.resolve({
        ...response,
        page_error: pageErr,
        warning: `Mini App page reported an error: ${pageErr.message}. Do NOT claim Mini App actions succeeded; report this exact error to the user.`,
      });
      return;
    }
    pending.resolve(response);
  }

  handleTakeover(userId: number, state: MiniAppTakeoverState): void {
    const key = this.appKey(userId, state.bot_username, state.short_name);
    this.takeoverStates.set(key, state);

    const statusText =
      state.mode === 'user_takeover'
        ? state.user_note || '用户已接管小程序操作'
        : state.mode === 'waiting_for_takeover'
          ? state.user_note || '等待用户接管'
          : state.mode === 'ai_controlling'
            ? state.user_note || 'AI 正在控制小程序'
            : '已恢复空闲状态';

    this.hub.broadcastMiniAppControlStatus(userId, {
      bot_username: state.bot_username,
      short_name: state.short_name,
      chat_id: state.chat_id,
      bot_user_id: state.bot_user_id,
      app_title: state.short_name,
      mode: state.mode as MiniAppControlMode,
      status_text: statusText,
      active_tool: null,
    });

    if (state.mode === 'idle' || state.mode === 'ai_controlling') {
      const waiters = this.takeoverWaiters.get(key);
      if (waiters) {
        this.takeoverWaiters.delete(key);
        for (const fn of waiters) fn(state);
      }
    }
  }

  async dispatchWebMcpCommand(
    userId: number,
    command: MiniAppWebMcpCommand,
    timeoutMs = DEFAULT_WEBMCP_RPC_TIMEOUT_MS,
  ): Promise<MiniAppWebMcpResponse & { page_error?: unknown; warning?: string }> {
    if (!this.hub.hasConnectedUser(userId)) {
      return {
        request_id: command.request_id,
        ok: false,
        result: null,
        error: 'no_connected_client',
        tools: [],
        state_summary: null,
        control_mode: 'idle',
      };
    }

    this.hub.broadcastMiniAppControlStatus(userId, {
      bot_username: command.bot_username,
      short_name: command.short_name,
      chat_id: command.chat_id,
      bot_user_id: command.bot_user_id,
      app_title: command.app_title,
      mode: 'ai_controlling',
      status_text: command.status_message || `Executing ${command.tool_name || command.operation}`,
      active_tool: command.tool_name ?? null,
    });

    const clamped = Math.max(1000, Math.min(60_000, Math.floor(timeoutMs)));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCalls.delete(command.request_id);
        resolve({
          request_id: command.request_id,
          ok: false,
          result: null,
          error: `WebMCP RPC timed out after ${clamped}ms`,
          tools: [],
          state_summary: null,
          control_mode: 'idle',
        });
      }, clamped);
      timer.unref();

      this.pendingCalls.set(command.request_id, {
        senderUserId: userId,
        resolve,
        reject,
        timer,
      });

      this.hub.sendMiniAppWebMcpCommand(userId, command);
    });
  }

  reset(): void {
    for (const p of this.pendingCalls.values()) {
      clearTimeout(p.timer);
      p.resolve({
        request_id: '',
        ok: false,
        result: null,
        error: 'server_reset',
        tools: [],
        state_summary: null,
        control_mode: 'idle',
      });
    }
    this.pendingCalls.clear();
    this.takeoverStates.clear();
    this.takeoverWaiters.clear();
  }

  close(): void {
    this.reset();
  }
}

// ============================================================================
// Validation & Bot/MiniApp DB Helpers
// ============================================================================

function validateMiniAppWebUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 2048 || /[\x00-\x1f\x7f]/.test(trimmed)) {
    throw new ApiError(400, 'invalid_web_url', 'Invalid Mini App web_url');
  }
  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith('javascript:') ||
    lower.startsWith('data:') ||
    lower.startsWith('file:') ||
    lower.startsWith('vbscript:') ||
    lower.startsWith('blob:') ||
    lower.startsWith('about:') ||
    trimmed.startsWith('//')
  ) {
    throw new ApiError(400, 'invalid_web_url', 'Unsafe Mini App web_url scheme is forbidden');
  }
  if (trimmed.startsWith('/')) {
    if (/(?:^|\/)\.\.(?:\/|$|\?|#)/.test(trimmed) || /%2e%2e/i.test(trimmed)) {
      throw new ApiError(400, 'invalid_web_url', 'Path traversal is not allowed in web_url');
    }
    return trimmed;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ApiError(400, 'invalid_web_url', 'Malformed Mini App web_url');
  }
  if (parsed.username || parsed.password) {
    throw new ApiError(400, 'invalid_web_url', 'Userinfo is not allowed in Mini App web_url');
  }
  if (parsed.protocol === 'https:') {
    if (!parsed.hostname) {
      throw new ApiError(400, 'invalid_web_url', 'Missing host in HTTPS web_url');
    }
    return trimmed;
  }
  if (parsed.protocol === 'http:') {
    const h = parsed.hostname.toLowerCase();
    if (h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1') {
      return trimmed;
    }
    throw new ApiError(400, 'invalid_web_url', 'Non-loopback HTTP Mini App web_url is not allowed');
  }
  throw new ApiError(400, 'invalid_web_url', 'Unsupported Mini App web_url protocol');
}

function nextBotUserId(db: DatabaseSync): number {
  const row = db
    .prepare(`SELECT COALESCE(MAX(bot_user_id), 800000) AS mx FROM bots_registry WHERE bot_user_id >= 800000`)
    .get() as { mx: number };
  return Math.max(800_001, Number(row.mx) + 1);
}

function ensureCompanionDmChat(
  db: DatabaseSync,
  userId: number,
  botUserId: number,
  hub?: RealtimeGatewayHub,
): number {
  const existing = db
    .prepare(
      `SELECT c.chat_id FROM chats c
       JOIN chat_members m1 ON m1.chat_id = c.chat_id AND m1.user_id = ?
       JOIN chat_members m2 ON m2.chat_id = c.chat_id AND m2.user_id = ?
       WHERE c.chat_type = 0
       LIMIT 1`,
    )
    .get(userId, botUserId) as { chat_id: number } | undefined;

  if (existing) {
    return Number(existing.chat_id);
  }

  const botUser = getUserProfileDto(db, botUserId);
  const mx = db.prepare(`SELECT COALESCE(MAX(chat_id), 500) AS mx FROM chats`).get() as { mx: number };
  const chatId = Math.max(501, Number(mx.mx) + 1);
  const now = Date.now();

  db.prepare(`
    INSERT INTO chats (
      chat_id, title, kind, chat_type, creator_id, peer_user_id, username, about,
      is_forum, is_verified, pts, next_msg_id, last_message_id, last_message_date_ms, created_at_ms
    ) VALUES (?, ?, 'bot', 0, ?, ?, NULL, ?, 0, 1, 0, 1, 0, ?, ?)
  `).run(
    chatId,
    botUser?.first_name ?? `Bot ${botUserId}`,
    userId,
    botUserId,
    botUser?.bio ?? null,
    now,
    now,
  );
  db.prepare(`INSERT INTO chat_members (chat_id, user_id, role, joined_at_ms) VALUES (?, ?, 'member', ?)`).run(chatId, userId, now);
  db.prepare(`INSERT INTO chat_members (chat_id, user_id, role, joined_at_ms) VALUES (?, ?, 'owner', ?)`).run(chatId, botUserId, now);

  if (hub) {
    const detail = getChatDetailDto(db, chatId, userId);
    if (detail) {
      hub.sendToUser(userId, {
        type: 'Update',
        payload: { type: 'ChatUpdated', data: detail },
      });
    }
  }

  return chatId;
}

export function isBotVisibleToUser(
  db: DatabaseSync,
  viewerUserId: number,
  botUserId: number,
  ownerUserId: number,
  entry: BotRegistryEntry,
): boolean {
  if (entry.is_official || ownerUserId === viewerUserId) {
    return true;
  }
  const hasSharedChat = Boolean(
    db
      .prepare(
        `SELECT 1
         FROM chat_members m1
         INNER JOIN chat_members m2 ON m2.chat_id = m1.chat_id
         WHERE m1.user_id = ? AND m1.role != 'banned' AND m2.user_id = ?
         LIMIT 1`,
      )
      .get(viewerUserId, botUserId),
  );
  if (hasSharedChat) return true;
  return Boolean(
    db.prepare(`SELECT 1 FROM mini_apps WHERE bot_user_id = ? LIMIT 1`).get(botUserId),
  );
}

export function redactBotEntryForViewer(
  viewerUserId: number,
  ownerUserId: number,
  entry: BotRegistryEntry,
): BotRegistryEntry {
  if (ownerUserId === viewerUserId) {
    return entry;
  }
  const copy: BotRegistryEntry = { ...entry };
  delete copy.ai_persona;
  delete copy.coding_agent;
  delete copy.webhook_url;
  return copy;
}

function enrichBotEntryForViewer(
  db: DatabaseSync,
  viewerUserId: number,
  entry: BotRegistryEntry,
): BotRegistryEntry {
  const avatarKey = entry.agent_id || entry.username.toLowerCase();
  const resolvedAvatar = resolveGrokBotAvatar(avatarKey, {
    shape: entry.avatar_shape,
    color: entry.avatar_color,
  });
  const perm = db
    .prepare(
      `SELECT allows_write_to_pm, has_started_chat, app_tos_accepted_at
       FROM user_bot_permissions WHERE user_id = ? AND bot_user_id = ?`,
    )
    .get(viewerUserId, entry.bot_user_id) as
    | { allows_write_to_pm: number; has_started_chat: number; app_tos_accepted_at: number }
    | undefined;
  const blocked = Boolean(
    db
      .prepare(`SELECT 1 FROM user_blocks WHERE owner_user_id = ? AND blocked_user_id = ?`)
      .get(viewerUserId, entry.bot_user_id),
  );
  const mauRow = db
    .prepare(
      `SELECT COUNT(DISTINCT i.user_id) AS cnt
       FROM mini_app_installs i
       JOIN mini_apps m ON m.app_id = i.app_id
       WHERE m.bot_user_id = ?`,
    )
    .get(entry.bot_user_id) as { cnt: number };

  return {
    ...entry,
    avatar_shape: resolvedAvatar.shape,
    avatar_color: resolvedAvatar.color,
    allows_write_to_pm: Boolean(perm?.allows_write_to_pm) || entry.owner_user_id === viewerUserId,
    app_tos_accepted: Boolean(perm?.app_tos_accepted_at && Number(perm.app_tos_accepted_at) > 0),
    is_blocked_by_viewer: blocked,
    mau_count: Number(mauRow.cnt ?? 0),
  };
}

function createBotRecord(
  db: DatabaseSync,
  ownerUserId: number,
  displayName: string,
  rawUsername: string,
  description = '',
  opts?: { avatar_shape?: string; avatar_color?: string; hub?: RealtimeGatewayHub },
): { entry: BotRegistryEntry; botToken: string; companionChatId: number } {
  const cleanUsername = rawUsername.trim().replace(/^@/, '');
  if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(cleanUsername) || !/bot$/i.test(cleanUsername)) {
    throw new ApiError(
      400,
      'invalid_bot_username',
      'Bot username must be 5–32 characters and end in "bot" (e.g. DemoHelperBot)',
    );
  }

  const dup = db
    .prepare(`SELECT user_id FROM users WHERE LOWER(username) = LOWER(?)`)
    .get(cleanUsername);
  if (dup) {
    throw new ApiError(409, 'username_taken', `Bot username @${cleanUsername} is already taken`);
  }

  const botUserId = nextBotUserId(db);
  const secret = crypto.randomBytes(18).toString('base64url');
  const botToken = `${botUserId}:AA${secret}`;
  const now = Date.now();
  const resolvedAvatar = resolveGrokBotAvatar(cleanUsername.toLowerCase(), {
    shape: opts?.avatar_shape,
    color: opts?.avatar_color,
  });

  db.prepare(`
    INSERT INTO users (
      user_id, username, first_name, bio, emoji_status, is_bot, is_verified, is_premium,
      status, last_seen_ms, created_at_ms
    ) VALUES (?, ?, ?, ?, '🤖', 1, 0, 0, 'bot', ?, ?)
  `).run(botUserId, cleanUsername, displayName.trim() || cleanUsername, description || null, now, now);

  const entry: BotRegistryEntry = {
    bot_user_id: botUserId,
    owner_user_id: ownerUserId,
    username: cleanUsername,
    display_name: displayName.trim() || cleanUsername,
    description,
    about: description,
    commands: [{ command: 'start', description: 'Start interacting with this bot' }],
    is_official: false,
    is_inline: false,
    allow_attach_menu: false,
    menu_button_type: 'commands',
    has_main_app: false,
    agent_id: cleanUsername.toLowerCase(),
    avatar_shape: resolvedAvatar.shape,
    avatar_color: resolvedAvatar.color,
    allows_write_to_pm: true,
    created_at_ms: now,
  };

  db.prepare(`
    INSERT INTO bots_registry (bot_user_id, owner_user_id, bot_token, bot_json, created_at_ms)
    VALUES (?, ?, ?, ?, ?)
  `).run(botUserId, ownerUserId, botToken, JSON.stringify(entry), now);

  const companionChatId = ensureCompanionDmChat(db, ownerUserId, botUserId, opts?.hub);

  db.prepare(`
    INSERT OR REPLACE INTO user_bot_permissions (
      user_id, bot_user_id, allows_write_to_pm, has_started_chat, app_tos_accepted_at, updated_at_ms
    ) VALUES (?, ?, 1, 1, 0, ?)
  `).run(ownerUserId, botUserId, now);

  return { entry, botToken, companionChatId };
}

function enqueueBotApiUpdate(
  db: DatabaseSync,
  botUserId: number,
  payload: Record<string, unknown>,
): void {
  db.prepare(
    `INSERT INTO bot_api_updates (bot_user_id, payload_json, created_at_ms) VALUES (?, ?, ?)`,
  ).run(botUserId, JSON.stringify(payload), Date.now());
}

/**
 * Handles conversational `@BotFather` (`777001`) and `@FabushiBot` (`777002`) messages.
 * Custom bots (`>= 800000`) NEVER echo fake replies — they enqueue real `bot_api_updates`
 * and return `false` so Fabushi/Coding Agent hooks can handle them cleanly.
 */
export function handleBotConversationTurn(
  db: DatabaseSync,
  hub: RealtimeGatewayHub,
  chatId: number,
  senderId: number,
  rawText: string,
): boolean {
  const chatMeta = db
    .prepare(`SELECT chat_type, peer_user_id FROM chats WHERE chat_id = ?`)
    .get(chatId) as { chat_type: number; peer_user_id: number | null } | undefined;

  // Only intercept 1:1 DM chats with official bots or enqueue updates for 1:1 custom bots
  if (!chatMeta || Number(chatMeta.chat_type) !== 0) {
    return false;
  }

  const botMember = db
    .prepare(
      `SELECT u.user_id, u.username
       FROM chat_members m
       JOIN users u ON u.user_id = m.user_id
       WHERE m.chat_id = ? AND u.is_bot = 1 AND u.user_id != ?
       LIMIT 1`,
    )
    .get(chatId, senderId) as { user_id: number; username: string | null } | undefined;

  if (!botMember) return false;
  const botId = Number(botMember.user_id);
  const text = rawText.trim();

  // Mark that the human has started chatting with this bot (allows bot DM replies)
  db.prepare(`
    INSERT INTO user_bot_permissions (user_id, bot_user_id, allows_write_to_pm, has_started_chat, app_tos_accepted_at, updated_at_ms)
    VALUES (?, ?, 1, 1, 0, ?)
    ON CONFLICT(user_id, bot_user_id) DO UPDATE SET has_started_chat = 1, updated_at_ms = excluded.updated_at_ms
  `).run(senderId, botId, Date.now());

  if (botId === 777001) {
    // @BotFather stateful wizard
    const wiz = db
      .prepare(`SELECT step, draft_json FROM botfather_wizards WHERE user_id = ?`)
      .get(senderId) as { step: string; draft_json: string } | undefined;

    if (/^\/cancel\b/i.test(text)) {
      db.prepare(`DELETE FROM botfather_wizards WHERE user_id = ?`).run(senderId);
      createMessageAtomic(db, hub, {
        chatId,
        senderId: 777001,
        text: 'Current command cancelled. Anything else I can do for you?',
      });
      return true;
    }

    if (/^\/start\b|^\/help\b/i.test(text)) {
      db.prepare(`DELETE FROM botfather_wizards WHERE user_id = ?`).run(senderId);
      createMessageAtomic(db, hub, {
        chatId,
        senderId: 777001,
        text: 'I can help you create and manage Telegram bots & Mini Apps:\n/newbot — create a new bot\n/mybots — list your bots\n/setdescription — change bot description\n/newapp — create a WebApp Mini App\n/deletebot — delete a bot\n/cancel — cancel current wizard',
        inlineKeyboard: [
          [
            { text: '➕ /newbot', callback_data: 'bf:newbot' },
            { text: '🤖 /mybots', callback_data: 'bf:mybots' },
          ],
          [
            { text: '🧩 /newapp', callback_data: 'bf:newapp' },
            { text: '🗑️ /deletebot', callback_data: 'bf:deletebot' },
          ],
        ],
      });
      return true;
    }

    if (/^\/newbot\b/i.test(text)) {
      db.prepare(`
        INSERT OR REPLACE INTO botfather_wizards (user_id, step, draft_json, updated_at_ms)
        VALUES (?, 'await_bot_name', '{}', ?)
      `).run(senderId, Date.now());
      createMessageAtomic(db, hub, {
        chatId,
        senderId: 777001,
        text: 'Alright, a new bot. How are we going to call it? Please choose a display name for your bot.',
      });
      return true;
    }

    if (/^\/mybots\b/i.test(text)) {
      const rows = db
        .prepare(`SELECT bot_json FROM bots_registry WHERE owner_user_id = ? ORDER BY created_at_ms DESC`)
        .all(senderId) as Array<{ bot_json: string }>;
      const list = rows.map((r) => {
        const b = JSON.parse(r.bot_json) as BotRegistryEntry;
        return `• **${b.display_name}** (@${b.username})`;
      });
      createMessageAtomic(db, hub, {
        chatId,
        senderId: 777001,
        text: list.length > 0 ? `Your bots:\n${list.join('\n')}` : 'You have no bots yet. Send /newbot to create one!',
      });
      return true;
    }

    if (/^\/newapp\b/i.test(text)) {
      db.prepare(`
        INSERT OR REPLACE INTO botfather_wizards (user_id, step, draft_json, updated_at_ms)
        VALUES (?, 'await_app_bot', '{}', ?)
      `).run(senderId, Date.now());
      createMessageAtomic(db, hub, {
        chatId,
        senderId: 777001,
        text: 'Alright, a new WebApp Mini App. Please choose a bot that will host the Mini App (send its `@username`):',
      });
      return true;
    }

    if (/^\/setdescription\b/i.test(text)) {
      const rest = text.replace(/^\/setdescription\s*/i, '').trim();
      const inlineMatch = /^@?([A-Za-z0-9_]+)\s+([\s\S]+)$/.exec(rest);
      if (inlineMatch) {
        const targetU = inlineMatch[1]!.toLowerCase();
        const desc = inlineMatch[2]!.trim();
        const rows = db
          .prepare(`SELECT bot_user_id, bot_json FROM bots_registry WHERE owner_user_id = ?`)
          .all(senderId) as Array<{ bot_user_id: number; bot_json: string }>;
        const target = rows
          .map((r) => JSON.parse(r.bot_json) as BotRegistryEntry)
          .find((b) => b.username.toLowerCase() === targetU);
        if (!target) {
          createMessageAtomic(db, hub, {
            chatId,
            senderId: 777001,
            text: `Bot @${inlineMatch[1]} not found among your bots.`,
          });
          return true;
        }
        target.description = desc;
        db.prepare(`UPDATE bots_registry SET bot_json = ? WHERE bot_user_id = ?`).run(
          JSON.stringify(target),
          target.bot_user_id,
        );
        db.prepare(`UPDATE users SET bio = ? WHERE user_id = ?`).run(desc, target.bot_user_id);
        createMessageAtomic(db, hub, {
          chatId,
          senderId: 777001,
          text: `Success! Description updated for @${target.username}.`,
        });
        return true;
      }

      db.prepare(`
        INSERT OR REPLACE INTO botfather_wizards (user_id, step, draft_json, updated_at_ms)
        VALUES (?, 'await_desc_bot', '{}', ?)
      `).run(senderId, Date.now());
      createMessageAtomic(db, hub, {
        chatId,
        senderId: 777001,
        text: 'Choose a bot to change description. Please send the `@username` of your bot.',
      });
      return true;
    }

    if (/^\/deletebot\b/i.test(text)) {
      const argU = text.replace(/^\/deletebot\s*/i, '').trim().replace(/^@/, '');
      if (argU) {
        const rows = db
          .prepare(`SELECT bot_user_id, bot_json FROM bots_registry WHERE owner_user_id = ?`)
          .all(senderId) as Array<{ bot_user_id: number; bot_json: string }>;
        const target = rows
          .map((r) => JSON.parse(r.bot_json) as BotRegistryEntry)
          .find((b) => b.username.toLowerCase() === argU.toLowerCase());
        if (!target || target.bot_user_id < 800_000) {
          createMessageAtomic(db, hub, {
            chatId,
            senderId: 777001,
            text: `Cannot delete @${argU}: bot not owned by you or protected system bot.`,
          });
          return true;
        }
        db.prepare(`DELETE FROM mini_apps WHERE bot_user_id = ?`).run(target.bot_user_id);
        db.prepare(`DELETE FROM bots_registry WHERE bot_user_id = ?`).run(target.bot_user_id);
        db.prepare(`DELETE FROM users WHERE user_id = ?`).run(target.bot_user_id);
        createMessageAtomic(db, hub, {
          chatId,
          senderId: 777001,
          text: `Done! The bot @${target.username} has been deleted.`,
        });
        return true;
      }

      db.prepare(`
        INSERT OR REPLACE INTO botfather_wizards (user_id, step, draft_json, updated_at_ms)
        VALUES (?, 'await_delete_bot', '{}', ?)
      `).run(senderId, Date.now());
      createMessageAtomic(db, hub, {
        chatId,
        senderId: 777001,
        text: 'Choose a bot to delete. Please send its `@username`.',
      });
      return true;
    }

    if (wiz?.step === 'await_bot_name') {
      db.prepare(`
        UPDATE botfather_wizards SET step = 'await_bot_username', draft_json = ?, updated_at_ms = ? WHERE user_id = ?
      `).run(JSON.stringify({ displayName: text }), Date.now(), senderId);
      createMessageAtomic(db, hub, {
        chatId,
        senderId: 777001,
        text: `Good. Now let's choose a username for your bot. It must end in \`bot\` (for example, \`TetrisBot\` or \`tetris_bot\`).`,
      });
      return true;
    }

    if (wiz?.step === 'await_bot_username') {
      const draft = JSON.parse(wiz.draft_json) as { displayName?: string };
      try {
        const created = createBotRecord(db, senderId, draft.displayName ?? text, text, '', { hub });
        db.prepare(`DELETE FROM botfather_wizards WHERE user_id = ?`).run(senderId);
        createMessageAtomic(db, hub, {
          chatId,
          senderId: 777001,
          text: `Done! Congratulations on your new bot **${created.entry.display_name}** (@${created.entry.username}).\n\nUse this token to access the HTTP API:\n\`${created.botToken}\``,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Invalid username';
        createMessageAtomic(db, hub, {
          chatId,
          senderId: 777001,
          text: `Sorry, ${msg}. Please try another username ending in \`bot\`:`,
        });
      }
      return true;
    }

    if (wiz?.step === 'await_app_bot') {
      const cleanU = text.replace(/^@/, '');
      const botRows = db
        .prepare(`SELECT bot_user_id, bot_json FROM bots_registry WHERE owner_user_id = ?`)
        .all(senderId) as Array<{ bot_user_id: number; bot_json: string }>;
      const found = botRows
        .map((r) => JSON.parse(r.bot_json) as BotRegistryEntry)
        .find((b) => b.username.toLowerCase() === cleanU.toLowerCase());
      if (!found) {
        createMessageAtomic(db, hub, {
          chatId,
          senderId: 777001,
          text: `Bot @${cleanU} not found among your bots. Please send a valid bot @username or /cancel.`,
        });
        return true;
      }
      db.prepare(`
        UPDATE botfather_wizards SET step = 'await_app_short_name', draft_json = ?, updated_at_ms = ? WHERE user_id = ?
      `).run(JSON.stringify({ botUserId: found.bot_user_id, botUsername: found.username }), Date.now(), senderId);
      createMessageAtomic(db, hub, {
        chatId,
        senderId: 777001,
        text: 'Great! Now please choose a short name (alphanumeric `short_name` slug, e.g. `dashboard`) for your Web App:',
      });
      return true;
    }

    if (wiz?.step === 'await_app_short_name') {
      const draft = JSON.parse(wiz.draft_json) as { botUserId: number; botUsername: string };
      const shortName = text.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'webapp';
      const appId = `app_${crypto.randomBytes(6).toString('hex')}`;
      const app: MiniAppEntry = {
        app_id: appId,
        bot_user_id: draft.botUserId,
        bot_username: draft.botUsername,
        short_name: shortName,
        title: `${draft.botUsername} · ${shortName}`,
        description: `Mini App created via @BotFather`,
        category: 'utilities',
        icon_emoji: '🧩',
        web_url: `/miniapps/${draft.botUsername}/${shortName}`,
        is_installed: false,
        install_count: 0,
        created_at_ms: Date.now(),
      };
      db.prepare(`
        INSERT OR REPLACE INTO mini_apps (app_id, bot_user_id, bot_username, short_name, app_json, html_bundle, created_at_ms)
        VALUES (?, ?, ?, ?, ?, NULL, ?)
      `).run(appId, app.bot_user_id, app.bot_username, app.short_name, JSON.stringify(app), app.created_at_ms);
      db.prepare(`DELETE FROM botfather_wizards WHERE user_id = ?`).run(senderId);
      createMessageAtomic(db, hub, {
        chatId,
        senderId: 777001,
        text: `Mini App created! Launch URL: \`/miniapps/${app.bot_username}/${app.short_name}\``,
      });
      return true;
    }

    if (wiz?.step === 'await_desc_bot') {
      const cleanU = text.replace(/^@/, '').toLowerCase();
      const rows = db
        .prepare(`SELECT bot_user_id, bot_json FROM bots_registry WHERE owner_user_id = ?`)
        .all(senderId) as Array<{ bot_user_id: number; bot_json: string }>;
      const target = rows
        .map((r) => JSON.parse(r.bot_json) as BotRegistryEntry)
        .find((b) => b.username.toLowerCase() === cleanU);
      if (!target) {
        createMessageAtomic(db, hub, {
          chatId,
          senderId: 777001,
          text: `Bot @${cleanU} not found among your bots. Send a valid @username or /cancel.`,
        });
        return true;
      }
      db.prepare(`
        UPDATE botfather_wizards SET step = 'await_desc_text', draft_json = ?, updated_at_ms = ? WHERE user_id = ?
      `).run(JSON.stringify({ botUserId: target.bot_user_id, botUsername: target.username }), Date.now(), senderId);
      createMessageAtomic(db, hub, {
        chatId,
        senderId: 777001,
        text: `OK. Send me the new description for @${target.username}.`,
      });
      return true;
    }

    if (wiz?.step === 'await_desc_text') {
      const draft = JSON.parse(wiz.draft_json) as { botUserId: number; botUsername: string };
      const row = db
        .prepare(`SELECT bot_json FROM bots_registry WHERE bot_user_id = ?`)
        .get(draft.botUserId) as { bot_json: string } | undefined;
      if (row) {
        const entry = JSON.parse(row.bot_json) as BotRegistryEntry;
        entry.description = text;
        db.prepare(`UPDATE bots_registry SET bot_json = ? WHERE bot_user_id = ?`).run(
          JSON.stringify(entry),
          draft.botUserId,
        );
        db.prepare(`UPDATE users SET bio = ? WHERE user_id = ?`).run(text, draft.botUserId);
      }
      db.prepare(`DELETE FROM botfather_wizards WHERE user_id = ?`).run(senderId);
      createMessageAtomic(db, hub, {
        chatId,
        senderId: 777001,
        text: `Success! Description updated for @${draft.botUsername}.`,
      });
      return true;
    }

    if (wiz?.step === 'await_delete_bot') {
      const cleanU = text.replace(/^@/, '').toLowerCase();
      const rows = db
        .prepare(`SELECT bot_user_id, bot_json FROM bots_registry WHERE owner_user_id = ?`)
        .all(senderId) as Array<{ bot_user_id: number; bot_json: string }>;
      const target = rows
        .map((r) => JSON.parse(r.bot_json) as BotRegistryEntry)
        .find((b) => b.username.toLowerCase() === cleanU);
      if (!target || target.bot_user_id < 800_000) {
        createMessageAtomic(db, hub, {
          chatId,
          senderId: 777001,
          text: `Cannot delete @${cleanU}: bot not owned by you or protected system bot.`,
        });
        return true;
      }
      db.prepare(`DELETE FROM mini_apps WHERE bot_user_id = ?`).run(target.bot_user_id);
      db.prepare(`DELETE FROM bots_registry WHERE bot_user_id = ?`).run(target.bot_user_id);
      db.prepare(`DELETE FROM users WHERE user_id = ?`).run(target.bot_user_id);
      db.prepare(`DELETE FROM botfather_wizards WHERE user_id = ?`).run(senderId);
      createMessageAtomic(db, hub, {
        chatId,
        senderId: 777001,
        text: `Done! The bot @${target.username} has been deleted.`,
      });
      return true;
    }

    createMessageAtomic(db, hub, {
      chatId,
      senderId: 777001,
      text: 'Unrecognized command. Send /newbot, /mybots, /setdescription, /newapp, /deletebot, or /help.',
    });
    return true;
  }

  if (botId === 777002) {
    // @FabushiBot — truthful welcome card on /start, ZERO hardcoded [STATE_PATCH]
    if (/^\/start\b|^\/help\b/i.test(text)) {
      createMessageAtomic(db, hub, {
        chatId,
        senderId: 777002,
        text: '🪷 欢迎来到 **全球法布施 (@FabushiBot)**。点击下方按钮打开 3D WASM 地球与禅室共修小程序。',
        inlineKeyboard: [
          [{ text: '🌏 打开全球法布施 3D Globe', web_app_url: '/miniapps/FabushiBot/fabushi-globe' }],
        ],
      });
      return true;
    }
    enqueueBotApiUpdate(db, 777002, {
      message: {
        chat: { id: chatId, type: 'private' },
        from: { id: senderId },
        date: Math.floor(Date.now() / 1000),
        text,
      },
    });
    return false;
  }

  // Custom bots (`botId >= 800000`): ZERO fabricated echo replies!
  // Queue real update into `bot_api_updates` for `getUpdates` / webhook polling.
  if (botId >= 800_000) {
    enqueueBotApiUpdate(db, botId, {
      message: {
        chat: { id: chatId, type: 'private' },
        from: { id: senderId },
        date: Math.floor(Date.now() / 1000),
        text,
      },
    });
    return false;
  }

  return false;
}

function getFabushiState(db: DatabaseSync, userId: number): {
  merit_total: number;
  wooden_fish_taps: number;
  incense_lit: boolean;
  beams: Array<{ id: string; from_city: string; to_city: string; sutra: string; created_at_ms: number }>;
  dedications: Array<{ text: string; created_at_ms: number }>;
} {
  const row = db
    .prepare(`SELECT state_json FROM fabushi_state WHERE user_id = ?`)
    .get(userId) as { state_json: string } | undefined;
  if (row) {
    return JSON.parse(row.state_json);
  }
  return {
    merit_total: 0,
    wooden_fish_taps: 0,
    incense_lit: false,
    beams: [],
    dedications: [],
  };
}

function saveFabushiState(
  db: DatabaseSync,
  userId: number,
  state: ReturnType<typeof getFabushiState>,
): void {
  db.prepare(`
    INSERT OR REPLACE INTO fabushi_state (user_id, state_json, updated_at_ms)
    VALUES (?, ?, ?)
  `).run(userId, JSON.stringify(state), Date.now());
}

// ============================================================================
// Route Registration
// ============================================================================

export function registerBotsMiniAppsAndFabushiRoutes(
  router: HttpRouter,
  db: DatabaseSync,
  hub: RealtimeGatewayHub,
  config: ServerConfig,
  webMcpBroker?: MiniAppWebMcpBroker,
  onCodingCallback?: (ctx: RequestContext, body: Record<string, unknown>) => Promise<void>,
): MiniAppWebMcpBroker {
  const broker = webMcpBroker ?? new MiniAppWebMcpBroker(hub);
  hub.setMiniAppWebMcpHandlers({
    onResult: (userId, response) => broker.handleResult(userId, response),
    onTakeover: (userId, state) => broker.handleTakeover(userId, state),
  });

  // ==========================================================================
  // 1. Bot Registry & Decoupled Parity REST Endpoints (Static BEFORE `:botId`!)
  // ==========================================================================
  router.get('/api/v1/bots', (ctx) => {
    const auth = requireAuth(db, ctx);
    const rows = db
      .prepare(`SELECT bot_user_id, owner_user_id, bot_json FROM bots_registry ORDER BY created_at_ms ASC`)
      .all() as Array<{ bot_user_id: number; owner_user_id: number; bot_json: string }>;
    const bots: BotRegistryEntry[] = [];
    for (const r of rows) {
      const entry = JSON.parse(r.bot_json) as BotRegistryEntry;
      const botUserId = Number(r.bot_user_id);
      const ownerUserId = Number(r.owner_user_id);
      if (!isBotVisibleToUser(db, auth.userId, botUserId, ownerUserId, entry)) {
        continue;
      }
      bots.push(
        redactBotEntryForViewer(
          auth.userId,
          ownerUserId,
          enrichBotEntryForViewer(db, auth.userId, entry),
        ),
      );
    }
    sendJson(ctx.res, 200, { bots, total: bots.length });
  });

  router.get('/api/v1/bots/my', (ctx) => {
    const auth = requireAuth(db, ctx);
    const rows = db
      .prepare(`SELECT bot_json FROM bots_registry WHERE owner_user_id = ? ORDER BY created_at_ms DESC`)
      .all(auth.userId) as Array<{ bot_json: string }>;
    const bots = rows.map((r) => enrichBotEntryForViewer(db, auth.userId, JSON.parse(r.bot_json)));
    sendJson(ctx.res, 200, { bots, total: bots.length });
  });

  router.get('/api/v1/bots/attach-menu', (ctx) => {
    const auth = requireAuth(db, ctx);
    const rows = db
      .prepare(`SELECT bot_user_id, owner_user_id, bot_json FROM bots_registry ORDER BY created_at_ms ASC`)
      .all() as Array<{ bot_user_id: number; owner_user_id: number; bot_json: string }>;
    const bots: BotRegistryEntry[] = [];
    for (const r of rows) {
      const entry = JSON.parse(r.bot_json) as BotRegistryEntry;
      if (entry.allow_attach_menu !== true) continue;
      const botUserId = Number(r.bot_user_id);
      const ownerUserId = Number(r.owner_user_id);
      if (!isBotVisibleToUser(db, auth.userId, botUserId, ownerUserId, entry)) {
        continue;
      }
      bots.push(
        redactBotEntryForViewer(
          auth.userId,
          ownerUserId,
          enrichBotEntryForViewer(db, auth.userId, entry),
        ),
      );
    }
    sendJson(ctx.res, 200, { bots, total: bots.length });
  });

  router.get('/api/v1/bots/profile/:target', (ctx) => {
    const auth = requireAuth(db, ctx);
    const param = ctx.params.target!.trim().replace(/^@/, '');
    const rows = db
      .prepare(`SELECT bot_user_id, owner_user_id, bot_json FROM bots_registry`)
      .all() as Array<{ bot_user_id: number; owner_user_id: number; bot_json: string }>;
    const found = rows
      .map((r) => ({
        botUserId: Number(r.bot_user_id),
        ownerUserId: Number(r.owner_user_id),
        entry: JSON.parse(r.bot_json) as BotRegistryEntry,
      }))
      .find(
        (b) =>
          String(b.entry.bot_user_id) === param ||
          b.entry.username.toLowerCase() === param.toLowerCase(),
      );
    if (
      !found ||
      !isBotVisibleToUser(db, auth.userId, found.botUserId, found.ownerUserId, found.entry)
    ) {
      throw new ApiError(404, 'bot_not_found', 'Bot not found');
    }

    const bot = redactBotEntryForViewer(
      auth.userId,
      found.ownerUserId,
      enrichBotEntryForViewer(db, auth.userId, found.entry),
    );

    const appRows = db
      .prepare(`SELECT app_json FROM mini_apps WHERE bot_user_id = ? ORDER BY created_at_ms ASC`)
      .all(bot.bot_user_id) as Array<{ app_json: string }>;
    const apps = appRows.map((r) => JSON.parse(r.app_json) as MiniAppEntry);
    const mainApp =
      (bot.main_app_short_name
        ? apps.find((a) => a.short_name === bot.main_app_short_name)
        : apps[0]) ?? null;

    const existingChat = db
      .prepare(
        `SELECT c.chat_id FROM chats c
         JOIN chat_members m1 ON m1.chat_id = c.chat_id AND m1.user_id = ?
         JOIN chat_members m2 ON m2.chat_id = c.chat_id AND m2.user_id = ?
         WHERE c.chat_type = 0 LIMIT 1`,
      )
      .get(auth.userId, bot.bot_user_id) as { chat_id: number } | undefined;

    const perm = db
      .prepare(
        `SELECT allows_write_to_pm, has_started_chat, app_tos_accepted_at
         FROM user_bot_permissions WHERE user_id = ? AND bot_user_id = ?`,
      )
      .get(auth.userId, bot.bot_user_id) as
      | { allows_write_to_pm: number; has_started_chat: number; app_tos_accepted_at: number }
      | undefined;

    sendJson(ctx.res, 200, {
      bot,
      main_app: mainApp,
      apps,
      existing_chat_id: existingChat ? Number(existingChat.chat_id) : null,
      has_started_chat: Boolean(perm?.has_started_chat),
      allows_write_to_pm: Boolean(bot.allows_write_to_pm),
      app_tos_accepted: Boolean(bot.app_tos_accepted),
      is_blocked: Boolean(bot.is_blocked_by_viewer),
      is_muted: false,
    });
  });

  router.post('/api/v1/bots', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      display_name?: unknown;
      name?: unknown;
      username?: unknown;
      description?: unknown;
      avatar_shape?: unknown;
      avatar_color?: unknown;
    }>(ctx.req);

    const rawDisplay = body.display_name !== undefined ? body.display_name : body.name;
    if (rawDisplay !== undefined && typeof rawDisplay !== 'string') {
      throw new ApiError(400, 'invalid_display_name', 'display_name must be a string');
    }
    if (body.username !== undefined && typeof body.username !== 'string') {
      throw new ApiError(400, 'invalid_bot_username', 'username must be a string');
    }
    if (body.description !== undefined && body.description !== null && typeof body.description !== 'string') {
      throw new ApiError(400, 'invalid_description', 'description must be a string');
    }
    if (body.avatar_shape !== undefined && body.avatar_shape !== null && typeof body.avatar_shape !== 'string') {
      throw new ApiError(400, 'invalid_avatar', 'avatar_shape must be a string');
    }
    if (body.avatar_color !== undefined && body.avatar_color !== null && typeof body.avatar_color !== 'string') {
      throw new ApiError(400, 'invalid_avatar', 'avatar_color must be a string');
    }

    const created = createBotRecord(
      db,
      auth.userId,
      typeof rawDisplay === 'string' ? rawDisplay : 'Custom Bot',
      typeof body.username === 'string' ? body.username : '',
      typeof body.description === 'string' ? body.description : '',
      {
        avatar_shape: typeof body.avatar_shape === 'string' ? body.avatar_shape : undefined,
        avatar_color: typeof body.avatar_color === 'string' ? body.avatar_color : undefined,
        hub,
      },
    );
    sendJson(ctx.res, 201, {
      bot: enrichBotEntryForViewer(db, auth.userId, created.entry),
      bot_token: created.botToken,
      chat_id: created.companionChatId,
      companion_chat_id: created.companionChatId,
    });
  });

  router.post('/api/v1/botfather/nl-create', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      prompt?: unknown;
      avatar_shape?: unknown;
      avatar_color?: unknown;
    }>(ctx.req);
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) {
      throw new ApiError(400, 'invalid_prompt', 'prompt is required for natural-language bot creation');
    }

    const words = prompt
      .replace(/[^A-Za-z0-9\u4e00-\u9fff\s]+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const asciiWords = words.map((w) => w.replace(/[^A-Za-z0-9]/g, '')).filter(Boolean);
    const slugBase = (asciiWords.slice(0, 2).join('_').toLowerCase() || 'nl_app').slice(0, 14);
    const prefix = /^[a-z]/.test(slugBase) ? slugBase : `b_${slugBase}`;
    const suffix = crypto.randomBytes(3).toString('hex');
    const username = `${prefix}_${suffix}_bot`;
    const displayName = words.slice(0, 4).join(' ').slice(0, 48) || 'Custom Bot';
    const shortName = `${prefix}_${suffix}`.slice(0, 28);

    const created = createBotRecord(db, auth.userId, displayName, username, prompt.slice(0, 200), {
      avatar_shape: typeof body.avatar_shape === 'string' ? body.avatar_shape : undefined,
      avatar_color: typeof body.avatar_color === 'string' ? body.avatar_color : undefined,
      hub,
    });

    const appId = `app_${crypto.randomBytes(6).toString('hex')}`;
    const now = Date.now();
    const app: MiniAppEntry = {
      app_id: appId,
      bot_user_id: created.entry.bot_user_id,
      bot_username: created.entry.username,
      short_name: shortName,
      title: `${displayName} App`,
      description: prompt.slice(0, 200),
      category: 'utilities',
      icon_emoji: '🧩',
      web_url: `/miniapps/${created.entry.username}/${shortName}`,
      is_installed: false,
      install_count: 0,
      created_by_nl: true,
      created_at_ms: now,
    };
    db.prepare(`
      INSERT INTO mini_apps (app_id, bot_user_id, bot_username, short_name, app_json, html_bundle, created_at_ms)
      VALUES (?, ?, ?, ?, ?, NULL, ?)
    `).run(appId, app.bot_user_id, app.bot_username, app.short_name, JSON.stringify(app), now);

    created.entry.has_main_app = true;
    created.entry.main_app_short_name = shortName;
    db.prepare(`UPDATE bots_registry SET bot_json = ? WHERE bot_user_id = ?`).run(
      JSON.stringify(created.entry),
      created.entry.bot_user_id,
    );

    sendJson(ctx.res, 201, {
      bot: enrichBotEntryForViewer(db, auth.userId, created.entry),
      app,
      bot_token: created.botToken,
      companion_chat_id: created.companionChatId,
      summary_markdown: `Created **${displayName}** (@${username}) with Mini App \`${shortName}\`.`,
    });
  });

  // Per-Bot Permissions & Blocking (`/:botId/*` before generic `/:botId`)
  router.get('/api/v1/bots/:botId/can-send-message', (ctx) => {
    const auth = requireAuth(db, ctx);
    const botId = parsePositiveIdParam(ctx.params.botId);
    if (!botId) throw new ApiError(400, 'invalid_bot_id', 'Invalid botId');
    const row = db
      .prepare(`SELECT owner_user_id FROM bots_registry WHERE bot_user_id = ?`)
      .get(botId) as { owner_user_id: number } | undefined;
    if (!row) throw new ApiError(404, 'bot_not_found', 'Bot not found');

    const isBlocked = Boolean(
      db
        .prepare(`SELECT 1 FROM user_blocks WHERE owner_user_id = ? AND blocked_user_id = ?`)
        .get(auth.userId, botId),
    );
    const perm = db
      .prepare(
        `SELECT allows_write_to_pm, has_started_chat FROM user_bot_permissions WHERE user_id = ? AND bot_user_id = ?`,
      )
      .get(auth.userId, botId) as { allows_write_to_pm: number; has_started_chat: number } | undefined;
    const allowsWrite = Boolean(perm?.allows_write_to_pm) || Number(row.owner_user_id) === auth.userId;
    const hasStarted = Boolean(perm?.has_started_chat);

    sendJson(ctx.res, 200, {
      can_send: !isBlocked && (allowsWrite || hasStarted),
      allows_write_to_pm: !isBlocked && allowsWrite,
      has_started_chat: hasStarted,
      is_blocked: isBlocked,
    });
  });

  router.post('/api/v1/bots/:botId/allow-send-message', (ctx) => {
    const auth = requireAuth(db, ctx);
    const botId = parsePositiveIdParam(ctx.params.botId);
    if (!botId) throw new ApiError(400, 'invalid_bot_id', 'Invalid botId');
    const row = db
      .prepare(`SELECT 1 FROM bots_registry WHERE bot_user_id = ?`)
      .get(botId);
    if (!row) throw new ApiError(404, 'bot_not_found', 'Bot not found');

    const now = Date.now();
    db.prepare(`DELETE FROM user_blocks WHERE owner_user_id = ? AND blocked_user_id = ?`).run(
      auth.userId,
      botId,
    );
    db.prepare(`
      INSERT INTO user_bot_permissions (user_id, bot_user_id, allows_write_to_pm, has_started_chat, app_tos_accepted_at, updated_at_ms)
      VALUES (?, ?, 1, 1, 0, ?)
      ON CONFLICT(user_id, bot_user_id) DO UPDATE SET allows_write_to_pm = 1, updated_at_ms = excluded.updated_at_ms
    `).run(auth.userId, botId, now);

    const companionChatId = ensureCompanionDmChat(db, auth.userId, botId, hub);
    sendJson(ctx.res, 200, {
      ok: true,
      allows_write_to_pm: true,
      companion_chat_id: companionChatId,
    });
  });

  router.post('/api/v1/bots/:botId/accept-app-tos', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const botId = parsePositiveIdParam(ctx.params.botId);
    if (!botId) throw new ApiError(400, 'invalid_bot_id', 'Invalid botId');
    const row = db.prepare(`SELECT 1 FROM bots_registry WHERE bot_user_id = ?`).get(botId);
    if (!row) throw new ApiError(404, 'bot_not_found', 'Bot not found');

    let body: { app_id?: string; allow_write_access?: boolean } = {};
    try {
      body = await readJsonBody<{ app_id?: string; allow_write_access?: boolean }>(ctx.req);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 400)) throw err;
    }

    const now = Date.now();
    const allowWrite = body.allow_write_access === true ? 1 : 0;
    db.prepare(`
      INSERT INTO user_bot_permissions (user_id, bot_user_id, allows_write_to_pm, has_started_chat, app_tos_accepted_at, updated_at_ms)
      VALUES (?, ?, ?, 0, ?, ?)
      ON CONFLICT(user_id, bot_user_id) DO UPDATE SET
        app_tos_accepted_at = excluded.app_tos_accepted_at,
        allows_write_to_pm = CASE WHEN excluded.allows_write_to_pm = 1 THEN 1 ELSE allows_write_to_pm END,
        updated_at_ms = excluded.updated_at_ms
    `).run(auth.userId, botId, allowWrite, now, now);

    sendJson(ctx.res, 200, { ok: true, app_tos_accepted: true });
  });

  router.post('/api/v1/bots/:botId/block', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const botId = parsePositiveIdParam(ctx.params.botId);
    if (!botId) throw new ApiError(400, 'invalid_bot_id', 'Invalid botId');
    const row = db.prepare(`SELECT 1 FROM bots_registry WHERE bot_user_id = ?`).get(botId);
    if (!row) throw new ApiError(404, 'bot_not_found', 'Bot not found');

    let body: { blocked?: boolean } = {};
    try {
      body = await readJsonBody<{ blocked?: boolean }>(ctx.req);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 400)) throw err;
    }
    const blocked = body.blocked !== false; // defaults to true when omitted
    const now = Date.now();

    if (blocked) {
      db.prepare(`
        INSERT OR REPLACE INTO user_blocks (owner_user_id, blocked_user_id, blocked_at_ms)
        VALUES (?, ?, ?)
      `).run(auth.userId, botId, now);
      db.prepare(`
        INSERT INTO user_bot_permissions (user_id, bot_user_id, allows_write_to_pm, has_started_chat, app_tos_accepted_at, updated_at_ms)
        VALUES (?, ?, 0, 0, 0, ?)
        ON CONFLICT(user_id, bot_user_id) DO UPDATE SET allows_write_to_pm = 0, updated_at_ms = excluded.updated_at_ms
      `).run(auth.userId, botId, now);
    } else {
      db.prepare(`DELETE FROM user_blocks WHERE owner_user_id = ? AND blocked_user_id = ?`).run(
        auth.userId,
        botId,
      );
    }

    sendJson(ctx.res, 200, { ok: true, blocked });
  });

  router.post('/api/v1/bots/:botId/regenerate-token', (ctx) => {
    const auth = requireAuth(db, ctx);
    const botId = parsePositiveIdParam(ctx.params.botId);
    if (!botId) throw new ApiError(400, 'invalid_bot_id', 'Invalid botId');
    const row = db
      .prepare(`SELECT owner_user_id FROM bots_registry WHERE bot_user_id = ?`)
      .get(botId) as { owner_user_id: number } | undefined;
    if (!row || Number(row.owner_user_id) !== auth.userId) {
      throw new ApiError(403, 'forbidden', 'Cannot regenerate token for this bot');
    }
    const newToken = `${botId}:AA${crypto.randomBytes(18).toString('base64url')}`;
    db.prepare(`UPDATE bots_registry SET bot_token = ? WHERE bot_user_id = ?`).run(newToken, botId);
    sendJson(ctx.res, 200, { ok: true, bot_token: newToken });
  });

  router.get('/api/v1/bots/:botId', (ctx) => {
    const auth = requireAuth(db, ctx);
    const param = ctx.params.botId!.replace(/^@/, '');
    const rows = db
      .prepare(`SELECT bot_user_id, owner_user_id, bot_json FROM bots_registry`)
      .all() as Array<{ bot_user_id: number; owner_user_id: number; bot_json: string }>;
    const found = rows
      .map((r) => ({
        botUserId: Number(r.bot_user_id),
        ownerUserId: Number(r.owner_user_id),
        entry: JSON.parse(r.bot_json) as BotRegistryEntry,
      }))
      .find(
        (b) =>
          String(b.entry.bot_user_id) === param ||
          b.entry.username.toLowerCase() === param.toLowerCase(),
      );
    if (
      !found ||
      !isBotVisibleToUser(db, auth.userId, found.botUserId, found.ownerUserId, found.entry)
    ) {
      throw new ApiError(404, 'bot_not_found', 'Bot not found');
    }
    sendJson(
      ctx.res,
      200,
      redactBotEntryForViewer(
        auth.userId,
        found.ownerUserId,
        enrichBotEntryForViewer(db, auth.userId, found.entry),
      ),
    );
  });

  router.patch('/api/v1/bots/:botId', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const botId = parsePositiveIdParam(ctx.params.botId);
    if (!botId) throw new ApiError(400, 'invalid_bot_id', 'Invalid botId');
    const row = db
      .prepare(`SELECT owner_user_id, bot_json FROM bots_registry WHERE bot_user_id = ?`)
      .get(botId) as { owner_user_id: number; bot_json: string } | undefined;
    if (!row) throw new ApiError(404, 'bot_not_found', 'Bot not found');
    if (Number(row.owner_user_id) !== auth.userId) {
      throw new ApiError(403, 'forbidden', 'Only the bot owner can update bot settings');
    }

    const patch = await readJsonBody<Record<string, unknown>>(ctx.req);
    const current = JSON.parse(row.bot_json) as BotRegistryEntry;

    if (patch.is_official !== undefined && patch.is_official !== current.is_official) {
      throw new ApiError(403, 'forbidden', 'Cannot modify is_official');
    }

    const updated: BotRegistryEntry = { ...current };
    let displayNameChanged = false;
    let descriptionChanged = false;

    if (patch.display_name !== undefined) {
      if (typeof patch.display_name !== 'string') {
        throw new ApiError(400, 'invalid_display_name', 'display_name must be a string');
      }
      const trimmed = patch.display_name.trim();
      if (trimmed.length < 1 || trimmed.length > 64) {
        throw new ApiError(400, 'invalid_display_name', 'display_name must be 1..64 characters');
      }
      updated.display_name = trimmed;
      displayNameChanged = true;
    }

    if (patch.description !== undefined) {
      if (typeof patch.description !== 'string') {
        throw new ApiError(400, 'invalid_description', 'description must be a string');
      }
      updated.description = patch.description;
      descriptionChanged = true;
    }

    if (patch.about !== undefined) {
      if (typeof patch.about !== 'string') {
        throw new ApiError(400, 'invalid_about', 'about must be a string');
      }
      updated.about = patch.about;
    }

    if (patch.ai_persona !== undefined) {
      if (patch.ai_persona === null) {
        delete updated.ai_persona;
      } else if (typeof patch.ai_persona === 'string') {
        updated.ai_persona = patch.ai_persona;
      } else {
        throw new ApiError(400, 'invalid_ai_persona', 'ai_persona must be a string or null');
      }
    }

    if (patch.commands !== undefined) {
      if (!Array.isArray(patch.commands)) {
        throw new ApiError(400, 'invalid_commands', 'commands must be an array');
      }
      const nextCmds: BotRegistryEntry['commands'] = [];
      for (const c of patch.commands) {
        if (
          !c ||
          typeof c !== 'object' ||
          Array.isArray(c) ||
          typeof (c as Record<string, unknown>).command !== 'string' ||
          typeof (c as Record<string, unknown>).description !== 'string'
        ) {
          throw new ApiError(
            400,
            'invalid_commands',
            'Each command must have string command and description',
          );
        }
        nextCmds.push({
          command: String((c as Record<string, unknown>).command).trim(),
          description: String((c as Record<string, unknown>).description).trim(),
        });
      }
      updated.commands = nextCmds;
    }

    if (patch.is_inline !== undefined) {
      if (typeof patch.is_inline !== 'boolean') {
        throw new ApiError(400, 'invalid_field', 'is_inline must be a boolean');
      }
      updated.is_inline = patch.is_inline;
    }

    if (patch.allow_attach_menu !== undefined) {
      if (typeof patch.allow_attach_menu !== 'boolean') {
        throw new ApiError(400, 'invalid_field', 'allow_attach_menu must be a boolean');
      }
      updated.allow_attach_menu = patch.allow_attach_menu;
    }

    if (patch.can_join_groups !== undefined) {
      if (typeof patch.can_join_groups !== 'boolean') {
        throw new ApiError(400, 'invalid_field', 'can_join_groups must be a boolean');
      }
      updated.can_join_groups = patch.can_join_groups;
    }

    if (patch.has_settings !== undefined) {
      if (typeof patch.has_settings !== 'boolean') {
        throw new ApiError(400, 'invalid_field', 'has_settings must be a boolean');
      }
      updated.has_settings = patch.has_settings;
    }

    if (patch.menu_button_type !== undefined) {
      if (
        patch.menu_button_type !== 'commands' &&
        patch.menu_button_type !== 'web_app' &&
        patch.menu_button_type !== 'default'
      ) {
        throw new ApiError(
          400,
          'invalid_menu_button',
          'menu_button_type must be commands, web_app, or default',
        );
      }
      updated.menu_button_type = patch.menu_button_type;
    }

    if (patch.menu_button_text !== undefined) {
      if (patch.menu_button_text === null) {
        delete updated.menu_button_text;
      } else if (typeof patch.menu_button_text === 'string') {
        updated.menu_button_text = patch.menu_button_text;
      } else {
        throw new ApiError(400, 'invalid_menu_button', 'menu_button_text must be a string or null');
      }
    }

    if (patch.menu_button_url !== undefined) {
      if (patch.menu_button_url === null || patch.menu_button_url === '') {
        delete updated.menu_button_url;
      } else if (typeof patch.menu_button_url === 'string') {
        updated.menu_button_url = validateMiniAppWebUrl(patch.menu_button_url);
      } else {
        throw new ApiError(400, 'invalid_web_url', 'menu_button_url must be a string or null');
      }
    }

    if (patch.privacy_policy_url !== undefined) {
      if (patch.privacy_policy_url === null || patch.privacy_policy_url === '') {
        delete updated.privacy_policy_url;
      } else if (typeof patch.privacy_policy_url === 'string') {
        updated.privacy_policy_url = validateMiniAppWebUrl(patch.privacy_policy_url);
      } else {
        throw new ApiError(400, 'invalid_web_url', 'privacy_policy_url must be a string or null');
      }
    }

    for (const key of ['preferred_model', 'thinking_level', 'toolset_preset'] as const) {
      if (patch[key] !== undefined) {
        if (patch[key] === null) {
          delete updated[key];
        } else if (typeof patch[key] === 'string') {
          updated[key] = patch[key] as string;
        } else {
          throw new ApiError(400, 'invalid_field', `${key} must be a string or null`);
        }
      }
    }

    if (patch.approval_mode !== undefined) {
      if (
        patch.approval_mode !== 'ask' &&
        patch.approval_mode !== 'read_only' &&
        patch.approval_mode !== 'yolo'
      ) {
        throw new ApiError(400, 'invalid_approval_mode', 'approval_mode must be ask, read_only, or yolo');
      }
      updated.approval_mode = patch.approval_mode;
    }

    if (patch.avatar_shape !== undefined && patch.avatar_shape !== null && typeof patch.avatar_shape !== 'string') {
      throw new ApiError(400, 'invalid_avatar', 'avatar_shape must be a string or null');
    }
    if (patch.avatar_color !== undefined && patch.avatar_color !== null && typeof patch.avatar_color !== 'string') {
      throw new ApiError(400, 'invalid_avatar', 'avatar_color must be a string or null');
    }
    const resolved = resolveGrokBotAvatar(current.agent_id || current.username.toLowerCase(), {
      shape:
        patch.avatar_shape === null
          ? undefined
          : typeof patch.avatar_shape === 'string'
            ? patch.avatar_shape
            : current.avatar_shape,
      color:
        patch.avatar_color === null
          ? undefined
          : typeof patch.avatar_color === 'string'
            ? patch.avatar_color
            : current.avatar_color,
    });

    // Enforce immutable fields strictly from `current`
    updated.bot_user_id = current.bot_user_id;
    updated.owner_user_id = current.owner_user_id;
    updated.username = current.username;
    updated.is_official = current.is_official;
    updated.is_fabushi_bot = current.is_fabushi_bot;
    updated.coding_agent = current.coding_agent;
    updated.created_at_ms = current.created_at_ms;
    updated.avatar_shape = resolved.shape;
    updated.avatar_color = resolved.color;

    db.prepare(`UPDATE bots_registry SET bot_json = ? WHERE bot_user_id = ?`).run(
      JSON.stringify(updated),
      botId,
    );
    if (displayNameChanged) {
      db.prepare(`UPDATE users SET first_name = ? WHERE user_id = ?`).run(updated.display_name, botId);
    }
    if (descriptionChanged) {
      db.prepare(`UPDATE users SET bio = ? WHERE user_id = ?`).run(updated.description, botId);
    }
    sendJson(ctx.res, 200, enrichBotEntryForViewer(db, auth.userId, updated));
  });

  router.delete('/api/v1/bots/:botId', (ctx) => {
    const auth = requireAuth(db, ctx);
    const botId = parsePositiveIdParam(ctx.params.botId);
    if (!botId) throw new ApiError(400, 'invalid_bot_id', 'Invalid botId');
    const row = db
      .prepare(`SELECT owner_user_id, bot_json FROM bots_registry WHERE bot_user_id = ?`)
      .get(botId) as { owner_user_id: number; bot_json: string } | undefined;
    if (!row) throw new ApiError(404, 'bot_not_found', 'Bot not found');
    const entry = JSON.parse(row.bot_json) as BotRegistryEntry;
    if (entry.is_official || Number(row.owner_user_id) !== auth.userId) {
      throw new ApiError(403, 'forbidden', 'Cannot delete official or unowned bot');
    }
    db.prepare(`DELETE FROM bots_registry WHERE bot_user_id = ?`).run(botId);
    sendJson(ctx.res, 200, { ok: true });
  });

  // ==========================================================================
  // 2. Telegram HTTP Bot API Compatibility (`/bot:botToken/:method` — 404 on unknown!)
  // ==========================================================================
  const handleBotHttpApi = async (ctx: RequestContext): Promise<void> => {
    const botToken = ctx.params.botToken ?? '';
    const method = ctx.params.method!;

    const botRow = db
      .prepare(`SELECT bot_user_id, owner_user_id, bot_json FROM bots_registry WHERE bot_token = ?`)
      .get(botToken) as { bot_user_id: number; owner_user_id: number; bot_json: string } | undefined;
    if (!botRow) {
      sendJson(ctx.res, 401, { ok: false, error_code: 401, description: 'Unauthorized bot token' });
      return;
    }

    const bot = JSON.parse(botRow.bot_json) as BotRegistryEntry;
    let body: Record<string, unknown> = {};
    if (ctx.method === 'POST') {
      try {
        body = await readJsonBody<Record<string, unknown>>(ctx.req);
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 400)) throw err;
      }
    }

    const checkBotCanDmUser = (targetUserId: number): { allowed: boolean; description?: string } => {
      const blocked = Boolean(
        db
          .prepare(`SELECT 1 FROM user_blocks WHERE owner_user_id = ? AND blocked_user_id = ?`)
          .get(targetUserId, bot.bot_user_id),
      );
      if (blocked) {
        return { allowed: false, description: 'Forbidden: bot was blocked by the user' };
      }
      if (targetUserId === Number(botRow.owner_user_id)) {
        return { allowed: true };
      }
      const perm = db
        .prepare(
          `SELECT allows_write_to_pm, has_started_chat FROM user_bot_permissions WHERE user_id = ? AND bot_user_id = ?`,
        )
        .get(targetUserId, bot.bot_user_id) as
        | { allows_write_to_pm: number; has_started_chat: number }
        | undefined;
      if (perm && (Number(perm.allows_write_to_pm) === 1 || Number(perm.has_started_chat) === 1)) {
        return { allowed: true };
      }
      return {
        allowed: false,
        description: "Forbidden: bot can't initiate conversation with a user",
      };
    };

    switch (method) {
      case 'getMe':
        sendJson(ctx.res, 200, {
          ok: true,
          result: {
            id: bot.bot_user_id,
            is_bot: true,
            first_name: bot.display_name,
            username: bot.username,
            can_join_groups: true,
            supports_inline_queries: bot.is_inline,
          },
        });
        return;

      case 'sendMessage': {
        const rawChatId = body.chat_id ?? ctx.query.get('chat_id');
        const targetId = Number(rawChatId);
        const rawText = body.text !== undefined ? body.text : ctx.query.get('text');
        const text = typeof rawText === 'string' ? rawText.trim() : '';
        if (!Number.isInteger(targetId) || targetId <= 0 || !text) {
          sendJson(ctx.res, 400, {
            ok: false,
            error_code: 400,
            description: 'Bad Request: valid chat_id and non-empty text are required',
          });
          return;
        }

        let resolvedChatId: number | null = null;
        const chatRow = db
          .prepare(`SELECT chat_id, chat_type, peer_user_id FROM chats WHERE chat_id = ?`)
          .get(targetId) as { chat_id: number; chat_type: number; peer_user_id: number | null } | undefined;

        if (chatRow) {
          if (Number(chatRow.chat_type) === 0) {
            const members = db
              .prepare(`SELECT user_id FROM chat_members WHERE chat_id = ?`)
              .all(targetId) as Array<{ user_id: number }>;
            const human = members.find((m) => Number(m.user_id) !== bot.bot_user_id);
            if (!human) {
              sendJson(ctx.res, 403, {
                ok: false,
                error_code: 403,
                description: 'Forbidden: bot is not a participant in this chat',
              });
              return;
            }
            const permCheck = checkBotCanDmUser(Number(human.user_id));
            if (!permCheck.allowed) {
              // Check if human has already sent a message in this DM chat
              const hasHumanMsg = Boolean(
                db
                  .prepare(`SELECT 1 FROM messages WHERE chat_id = ? AND sender_id = ? LIMIT 1`)
                  .get(targetId, Number(human.user_id)),
              );
              const blocked = Boolean(
                db
                  .prepare(`SELECT 1 FROM user_blocks WHERE owner_user_id = ? AND blocked_user_id = ?`)
                  .get(Number(human.user_id), bot.bot_user_id),
              );
              if (blocked || !hasHumanMsg) {
                sendJson(ctx.res, 403, {
                  ok: false,
                  error_code: 403,
                  description: blocked
                    ? 'Forbidden: bot was blocked by the user'
                    : permCheck.description!,
                });
                return;
              }
            }
          } else {
            const isMember = Boolean(
              db
                .prepare(`SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?`)
                .get(targetId, bot.bot_user_id),
            );
            if (!isMember) {
              sendJson(ctx.res, 403, {
                ok: false,
                error_code: 403,
                description: 'Forbidden: bot is not a member of the chat',
              });
              return;
            }
          }
          resolvedChatId = targetId;
        } else {
          // Support Telegram-standard user_id passed directly as chat_id
          const userRow = db
            .prepare(`SELECT user_id FROM users WHERE user_id = ?`)
            .get(targetId) as { user_id: number } | undefined;
          if (!userRow) {
            sendJson(ctx.res, 400, {
              ok: false,
              error_code: 400,
              description: 'Bad Request: chat not found',
            });
            return;
          }
          const permCheck = checkBotCanDmUser(targetId);
          if (!permCheck.allowed) {
            sendJson(ctx.res, 403, {
              ok: false,
              error_code: 403,
              description: permCheck.description!,
            });
            return;
          }
          resolvedChatId = ensureCompanionDmChat(db, targetId, bot.bot_user_id, hub);
        }

        const msgRes = createMessageAtomic(db, hub, {
          chatId: resolvedChatId,
          senderId: bot.bot_user_id,
          text,
        });
        sendJson(ctx.res, 200, {
          ok: true,
          result: {
            message_id: msgRes.message.id,
            chat: { id: resolvedChatId },
            date: Math.floor(Date.now() / 1000),
            text: msgRes.message.text,
          },
        });
        return;
      }

      case 'editMessageText': {
        const chatId = Number(body.chat_id ?? 0);
        const messageId = Number(body.message_id ?? 0);
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!chatId || !messageId || !text) {
          sendJson(ctx.res, 400, {
            ok: false,
            error_code: 400,
            description: 'Bad Request: chat_id, message_id, and text are required',
          });
          return;
        }
        const edited = editMessageAtomic(db, hub, {
          chatId,
          messageId,
          editorUserId: bot.bot_user_id,
          text,
        });
        sendJson(ctx.res, 200, {
          ok: true,
          result: { message_id: edited.message.id, chat: { id: chatId }, text: edited.message.text },
        });
        return;
      }

      case 'deleteMessage': {
        const chatId = Number(body.chat_id ?? 0);
        const messageId = Number(body.message_id ?? 0);
        if (!chatId || !messageId) {
          sendJson(ctx.res, 400, {
            ok: false,
            error_code: 400,
            description: 'Bad Request: chat_id and message_id are required',
          });
          return;
        }
        deleteMessagesAtomic(db, hub, chatId, bot.bot_user_id, [messageId], true);
        sendJson(ctx.res, 200, { ok: true, result: true });
        return;
      }

      case 'getUpdates': {
        const offset = Number(body.offset ?? ctx.query.get('offset') ?? 0);
        const updates = db
          .prepare(
            `SELECT update_id, payload_json FROM bot_api_updates
             WHERE bot_user_id = ? AND update_id >= ?
             ORDER BY update_id ASC LIMIT 50`,
          )
          .all(bot.bot_user_id, Number.isFinite(offset) ? Math.floor(offset) : 0) as Array<{
            update_id: number;
            payload_json: string;
          }>;
        sendJson(ctx.res, 200, {
          ok: true,
          result: updates.map((u) => ({
            update_id: u.update_id,
            ...(JSON.parse(u.payload_json) as Record<string, unknown>),
          })),
        });
        return;
      }

      case 'setWebhook': {
        const url = typeof body.url === 'string' ? body.url.trim() : '';
        bot.webhook_url = url || undefined;
        db.prepare(`UPDATE bots_registry SET bot_json = ? WHERE bot_user_id = ?`).run(
          JSON.stringify(bot),
          bot.bot_user_id,
        );
        sendJson(ctx.res, 200, { ok: true, result: true });
        return;
      }

      case 'deleteWebhook': {
        delete bot.webhook_url;
        db.prepare(`UPDATE bots_registry SET bot_json = ? WHERE bot_user_id = ?`).run(
          JSON.stringify(bot),
          bot.bot_user_id,
        );
        sendJson(ctx.res, 200, { ok: true, result: true });
        return;
      }

      case 'getWebhookInfo': {
        const pendingCnt = db
          .prepare(`SELECT COUNT(*) AS cnt FROM bot_api_updates WHERE bot_user_id = ?`)
          .get(bot.bot_user_id) as { cnt: number };
        sendJson(ctx.res, 200, {
          ok: true,
          result: {
            url: bot.webhook_url ?? '',
            has_custom_certificate: false,
            pending_update_count: Number(pendingCnt.cnt ?? 0),
          },
        });
        return;
      }

      case 'setMyCommands': {
        if (Array.isArray(body.commands)) {
          bot.commands = body.commands as BotRegistryEntry['commands'];
          db.prepare(`UPDATE bots_registry SET bot_json = ? WHERE bot_user_id = ?`).run(
            JSON.stringify(bot),
            bot.bot_user_id,
          );
        }
        sendJson(ctx.res, 200, { ok: true, result: true });
        return;
      }

      case 'getMyCommands':
        sendJson(ctx.res, 200, { ok: true, result: bot.commands ?? [] });
        return;

      case 'deleteMyCommands':
        bot.commands = [];
        db.prepare(`UPDATE bots_registry SET bot_json = ? WHERE bot_user_id = ?`).run(
          JSON.stringify(bot),
          bot.bot_user_id,
        );
        sendJson(ctx.res, 200, { ok: true, result: true });
        return;

      case 'setMyDescription':
        bot.description = typeof body.description === 'string' ? body.description : '';
        db.prepare(`UPDATE bots_registry SET bot_json = ? WHERE bot_user_id = ?`).run(
          JSON.stringify(bot),
          bot.bot_user_id,
        );
        sendJson(ctx.res, 200, { ok: true, result: true });
        return;

      case 'getMyDescription':
        sendJson(ctx.res, 200, { ok: true, result: { description: bot.description ?? '' } });
        return;

      case 'setMyShortDescription':
        bot.about = typeof body.short_description === 'string' ? body.short_description : '';
        db.prepare(`UPDATE bots_registry SET bot_json = ? WHERE bot_user_id = ?`).run(
          JSON.stringify(bot),
          bot.bot_user_id,
        );
        sendJson(ctx.res, 200, { ok: true, result: true });
        return;

      case 'getMyShortDescription':
        sendJson(ctx.res, 200, { ok: true, result: { short_description: bot.about ?? '' } });
        return;

      case 'setMyName':
        if (typeof body.name === 'string' && body.name.trim()) {
          bot.display_name = body.name.trim();
          db.prepare(`UPDATE bots_registry SET bot_json = ? WHERE bot_user_id = ?`).run(
            JSON.stringify(bot),
            bot.bot_user_id,
          );
          db.prepare(`UPDATE users SET first_name = ? WHERE user_id = ?`).run(
            bot.display_name,
            bot.bot_user_id,
          );
        }
        sendJson(ctx.res, 200, { ok: true, result: true });
        return;

      case 'getMyName':
        sendJson(ctx.res, 200, { ok: true, result: { name: bot.display_name } });
        return;

      case 'setChatMenuButton': {
        const mb = body.menu_button as Record<string, unknown> | undefined;
        if (mb && typeof mb === 'object' && !Array.isArray(mb)) {
          const t = typeof mb.type === 'string' ? mb.type : 'default';
          const nextType: BotRegistryEntry['menu_button_type'] =
            t === 'web_app' ? 'web_app' : t === 'commands' ? 'commands' : 'default';
          const wa = mb.web_app as Record<string, unknown> | undefined;
          let validatedUrl: string | undefined;
          if (wa && typeof wa === 'object' && !Array.isArray(wa) && wa.url !== undefined) {
            if (typeof wa.url !== 'string') {
              sendJson(ctx.res, 400, {
                ok: false,
                error_code: 400,
                description: 'Bad Request: menu_button.web_app.url must be a string',
              });
              return;
            }
            try {
              validatedUrl = validateMiniAppWebUrl(wa.url);
            } catch (err) {
              sendJson(ctx.res, 400, {
                ok: false,
                error_code: 400,
                description: `Bad Request: ${err instanceof Error ? err.message : 'Invalid web_app url'}`,
              });
              return;
            }
          }
          bot.menu_button_type = nextType;
          if (typeof mb.text === 'string') bot.menu_button_text = mb.text;
          if (validatedUrl !== undefined) bot.menu_button_url = validatedUrl;
          db.prepare(`UPDATE bots_registry SET bot_json = ? WHERE bot_user_id = ?`).run(
            JSON.stringify(bot),
            bot.bot_user_id,
          );
        }
        sendJson(ctx.res, 200, { ok: true, result: true });
        return;
      }

      case 'getChatMenuButton':
        sendJson(ctx.res, 200, {
          ok: true,
          result: {
            type: bot.menu_button_type,
            ...(bot.menu_button_text ? { text: bot.menu_button_text } : {}),
            ...(bot.menu_button_url ? { web_app: { url: bot.menu_button_url } } : {}),
          },
        });
        return;

      case 'answerCallbackQuery':
        sendJson(ctx.res, 200, { ok: true, result: true });
        return;

      case 'answerWebAppQuery':
        sendJson(ctx.res, 200, {
          ok: true,
          result: { inline_message_id: `imsg_${crypto.randomBytes(6).toString('hex')}` },
        });
        return;

      default:
        // ZERO stub `{ ok: true, result: true }` for unknown Bot API methods!
        sendJson(ctx.res, 404, {
          ok: false,
          error_code: 404,
          description: 'Method not found',
        });
    }
  };
  router.get('/bot:botToken/:method', handleBotHttpApi);
  router.post('/bot:botToken/:method', handleBotHttpApi);
  router.get('/bot/:botToken/:method', handleBotHttpApi);
  router.post('/bot/:botToken/:method', handleBotHttpApi);

  // Inline Keyboard Callback Query Endpoint (prototype-safe Map, ZERO silent stub on unknown!)
  const BF_CALLBACK_MAP = new Map<string, string>([
    ['bf:newbot', '/newbot'],
    ['bf:mybots', '/mybots'],
    ['bf:newapp', '/newapp'],
    ['bf:deletebot', '/deletebot'],
    ['bf:setdescription', '/setdescription'],
  ]);

  const handleInlineCallbackQuery = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      chat_id?: unknown;
      message_id?: unknown;
      callback_data?: string;
      data?: string;
    }>(ctx.req);

    const chatId = parsePositiveIdParam(ctx.params.chatId ?? body.chat_id) ?? 0;
    const messageId = Number(ctx.params.messageId ?? body.message_id ?? 0);
    const cbData = (typeof body.callback_data === 'string'
      ? body.callback_data
      : typeof body.data === 'string'
        ? body.data
        : ''
    ).trim();
    if (!chatId || !cbData) {
      throw new ApiError(400, 'invalid_callback', 'chat_id and callback_data are required');
    }
    ensureChatMembership(db, chatId, auth.userId);

    if (cbData.startsWith('coding:') && onCodingCallback) {
      await onCodingCallback(ctx, body as unknown as Record<string, unknown>);
      return;
    }

    const callbackQueryId = `cbq_${crypto.randomBytes(6).toString('hex')}`;
    const bfCmd = BF_CALLBACK_MAP.get(cbData);
    if (bfCmd) {
      handleBotConversationTurn(db, hub, chatId, auth.userId, bfCmd);
      sendJson(ctx.res, 200, {
        ok: true,
        callback_query_id: callbackQueryId,
        chat_id: chatId,
        message_id: messageId,
        data: cbData,
        answer_text: 'BotFather command triggered',
      });
      return;
    }

    // Check if chat has a custom bot to enqueue callback_query for polling/webhook
    const customBot = db
      .prepare(
        `SELECT br.bot_user_id FROM chat_members cm
         JOIN bots_registry br ON br.bot_user_id = cm.user_id
         WHERE cm.chat_id = ? AND br.bot_user_id >= 800000 LIMIT 1`,
      )
      .get(chatId) as { bot_user_id: number } | undefined;

    if (customBot) {
      enqueueBotApiUpdate(db, Number(customBot.bot_user_id), {
        callback_query: {
          id: callbackQueryId,
          from: { id: auth.userId },
          message: { message_id: messageId, chat: { id: chatId } },
          data: cbData,
        },
      });
      sendJson(ctx.res, 200, {
        ok: true,
        callback_query_id: callbackQueryId,
        chat_id: chatId,
        message_id: messageId,
        data: cbData,
        queued_for_bot: Number(customBot.bot_user_id),
      });
      return;
    }

    throw new ApiError(400, 'unknown_callback', `Unhandled callback_data: ${cbData}`);
  };
  router.post('/api/v1/chats/:chatId/messages/:messageId/callback', handleInlineCallbackQuery);
  router.post('/api/v1/bots/callback', handleInlineCallbackQuery);

  // ==========================================================================
  // 3. Decoupled Mini App Registry, Catalog, Recent, Install, Launch, Action & CloudStorage
  // ==========================================================================
  const handleListMiniApps = (ctx: RequestContext): void => {
    const auth = requireAuth(db, ctx);
    const q = (ctx.query.get('q') ?? '').trim().toLowerCase();
    const category = (ctx.query.get('category') ?? '').trim().toLowerCase();

    const rows = db
      .prepare(`SELECT app_json FROM mini_apps ORDER BY created_at_ms ASC`)
      .all() as Array<{ app_json: string }>;
    const installedRows = db
      .prepare(`SELECT app_id, companion_chat_id, last_launched_at_ms FROM mini_app_installs WHERE user_id = ?`)
      .all(auth.userId) as Array<{ app_id: string; companion_chat_id: number | null; last_launched_at_ms: number }>;
    const installMap = new Map(installedRows.map((i) => [i.app_id, i]));

    const countRows = db
      .prepare(`SELECT app_id, COUNT(*) AS cnt FROM mini_app_installs GROUP BY app_id`)
      .all() as Array<{ app_id: string; cnt: number }>;
    const countMap = new Map(countRows.map((c) => [c.app_id, Number(c.cnt)]));

    let apps = rows.map((r) => {
      const a = JSON.parse(r.app_json) as MiniAppEntry;
      const inst = installMap.get(a.app_id);
      return {
        ...a,
        install_count: countMap.get(a.app_id) ?? 0,
        is_installed: Boolean(inst),
        companion_chat_id: inst?.companion_chat_id ?? a.companion_chat_id,
        last_launched_at: inst?.last_launched_at_ms || undefined,
      };
    });

    if (q) {
      apps = apps.filter(
        (a) =>
          a.title.toLowerCase().includes(q) ||
          a.short_name.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q),
      );
    }
    if (category && category !== 'all') {
      apps = apps.filter((a) => a.category.toLowerCase() === category);
    }

    sendJson(ctx.res, 200, { apps, miniapps: apps, total: apps.length });
  };
  router.get('/api/v1/miniapps', handleListMiniApps);
  router.get('/api/v1/miniapps/catalog', handleListMiniApps);

  router.get('/api/v1/miniapps/installed', (ctx) => {
    const auth = requireAuth(db, ctx);
    const rows = db
      .prepare(
        `SELECT m.app_json, i.companion_chat_id, i.last_launched_at_ms
         FROM mini_app_installs i
         JOIN mini_apps m ON m.app_id = i.app_id
         WHERE i.user_id = ?
         ORDER BY i.installed_at_ms DESC`,
      )
      .all(auth.userId) as Array<{
        app_json: string;
        companion_chat_id: number | null;
        last_launched_at_ms: number;
      }>;

    const apps = rows.map((r) => ({
      ...(JSON.parse(r.app_json) as MiniAppEntry),
      is_installed: true,
      companion_chat_id: r.companion_chat_id ?? undefined,
      last_launched_at: r.last_launched_at_ms || undefined,
    }));
    sendJson(ctx.res, 200, { apps, total: apps.length });
  });

  router.get('/api/v1/miniapps/recent', (ctx) => {
    const auth = requireAuth(db, ctx);
    const rows = db
      .prepare(
        `SELECT m.app_json, i.companion_chat_id, i.last_launched_at_ms
         FROM mini_app_installs i
         JOIN mini_apps m ON m.app_id = i.app_id
         WHERE i.user_id = ? AND i.last_launched_at_ms > 0
         ORDER BY i.last_launched_at_ms DESC
         LIMIT 30`,
      )
      .all(auth.userId) as Array<{
        app_json: string;
        companion_chat_id: number | null;
        last_launched_at_ms: number;
      }>;

    const apps = rows.map((r) => ({
      ...(JSON.parse(r.app_json) as MiniAppEntry),
      is_installed: true,
      is_recent_used: true,
      companion_chat_id: r.companion_chat_id ?? undefined,
      last_launched_at: Number(r.last_launched_at_ms),
    }));
    sendJson(ctx.res, 200, { apps, total: apps.length });
  });

  router.post('/api/v1/miniapps', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      bot_username?: string;
      bot_user_id?: unknown;
      short_name?: string;
      title?: string;
      description?: string;
      category?: string;
      icon_emoji?: string;
      web_url?: string;
      html_bundle?: string;
    }>(ctx.req);

    const botUserIdParam = parseOptionalPositiveInt(body.bot_user_id, 'invalid_bot_id', 'bot_user_id must be a positive integer');
    let botRow: { bot_user_id: number; owner_user_id: number; bot_json: string } | undefined;
    if (botUserIdParam) {
      botRow = db
        .prepare(`SELECT bot_user_id, owner_user_id, bot_json FROM bots_registry WHERE bot_user_id = ?`)
        .get(botUserIdParam) as { bot_user_id: number; owner_user_id: number; bot_json: string } | undefined;
    } else if (typeof body.bot_username === 'string' && body.bot_username.trim()) {
      const cleanU = body.bot_username.trim().replace(/^@/, '').toLowerCase();
      const all = db
        .prepare(`SELECT bot_user_id, owner_user_id, bot_json FROM bots_registry`)
        .all() as Array<{ bot_user_id: number; owner_user_id: number; bot_json: string }>;
      botRow = all.find((r) => (JSON.parse(r.bot_json) as BotRegistryEntry).username.toLowerCase() === cleanU);
    } else {
      botRow = db
        .prepare(`SELECT bot_user_id, owner_user_id, bot_json FROM bots_registry WHERE owner_user_id = ? LIMIT 1`)
        .get(auth.userId) as { bot_user_id: number; owner_user_id: number; bot_json: string } | undefined;
    }

    if (!botRow) throw new ApiError(404, 'bot_not_found', 'Target bot not found');
    if (Number(botRow.owner_user_id) !== auth.userId) {
      throw new ApiError(403, 'forbidden', 'Only the bot owner can create Mini Apps for this bot');
    }

    const bot = JSON.parse(botRow.bot_json) as BotRegistryEntry;
    const shortName = (typeof body.short_name === 'string' ? body.short_name : '').trim();
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(shortName)) {
      throw new ApiError(400, 'invalid_short_name', 'short_name must be 1..32 alphanumeric, _ or - characters');
    }

    if (body.web_url !== undefined && body.web_url !== null && typeof body.web_url !== 'string') {
      throw new ApiError(400, 'invalid_web_url', 'web_url must be a string');
    }
    const webUrl =
      typeof body.web_url === 'string' && body.web_url.trim().length > 0
        ? validateMiniAppWebUrl(body.web_url)
        : `/miniapps/${bot.username}/${shortName}`;

    const appId = `app_${crypto.randomBytes(6).toString('hex')}`;
    const now = Date.now();

    const app: MiniAppEntry = {
      app_id: appId,
      bot_user_id: bot.bot_user_id,
      bot_username: bot.username,
      short_name: shortName,
      title: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : `${bot.display_name} App`,
      description: typeof body.description === 'string' ? body.description : '',
      category: typeof body.category === 'string' && body.category.trim() ? body.category.trim() : 'utilities',
      icon_emoji: typeof body.icon_emoji === 'string' && body.icon_emoji.trim() ? body.icon_emoji.trim() : '🧩',
      web_url: webUrl,
      is_installed: false,
      install_count: 0,
      created_at_ms: now,
    };

    db.prepare(`
      INSERT OR REPLACE INTO mini_apps (app_id, bot_user_id, bot_username, short_name, app_json, html_bundle, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      appId,
      app.bot_user_id,
      app.bot_username,
      app.short_name,
      JSON.stringify(app),
      typeof body.html_bundle === 'string' ? body.html_bundle : null,
      now,
    );

    sendJson(ctx.res, 201, app);
  });

  function resolveMiniAppRow(paramA: string, paramB?: string): {
    app: MiniAppEntry;
    botToken: string;
    htmlBundle: string | null;
  } {
    const cleanA = paramA.replace(/^@/, '');
    const numericBotId = /^\d+$/.test(cleanA) ? Number(cleanA) : -1;
    const row = (
      paramB
        ? db
            .prepare(
              `SELECT m.app_json, m.html_bundle, b.bot_token
               FROM mini_apps m
               JOIN bots_registry b ON b.bot_user_id = m.bot_user_id
               WHERE (LOWER(m.bot_username) = LOWER(?) OR m.bot_user_id = ?) AND LOWER(m.short_name) = LOWER(?)`,
            )
            .get(cleanA, numericBotId, paramB)
        : db
            .prepare(
              `SELECT m.app_json, m.html_bundle, b.bot_token
               FROM mini_apps m
               JOIN bots_registry b ON b.bot_user_id = m.bot_user_id
               WHERE m.app_id = ? OR LOWER(m.short_name) = LOWER(?) OR LOWER(m.bot_username) = LOWER(?) OR m.bot_user_id = ?
               ORDER BY m.created_at_ms ASC LIMIT 1`,
            )
            .get(paramA, cleanA, cleanA, numericBotId)
    ) as { app_json: string; html_bundle: string | null; bot_token: string } | undefined;

    if (!row) {
      throw new ApiError(404, 'miniapp_not_found', 'Mini App not found');
    }
    return {
      app: JSON.parse(row.app_json) as MiniAppEntry,
      botToken: row.bot_token,
      htmlBundle: row.html_bundle,
    };
  }

  // Install / Uninstall MiniApp
  router.post('/api/v1/miniapps/:botUsername/:shortName/install', async (ctx) => {
    const auth = requireAuth(db, ctx);
    let body: { allow_write_access?: boolean } = {};
    try {
      body = await readJsonBody<{ allow_write_access?: boolean }>(ctx.req);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 400)) throw err;
    }
    const resolved = resolveMiniAppRow(ctx.params.botUsername!, ctx.params.shortName!);
    const companionChatId = ensureCompanionDmChat(db, auth.userId, resolved.app.bot_user_id, hub);
    const now = Date.now();

    db.prepare(`
      INSERT INTO mini_app_installs (user_id, app_id, companion_chat_id, installed_at_ms, last_launched_at_ms)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, app_id) DO UPDATE SET
        companion_chat_id = excluded.companion_chat_id,
        last_launched_at_ms = CASE WHEN last_launched_at_ms > 0 THEN last_launched_at_ms ELSE excluded.last_launched_at_ms END
    `).run(auth.userId, resolved.app.app_id, companionChatId, now, now);

    if (body.allow_write_access !== false) {
      db.prepare(`
        INSERT INTO user_bot_permissions (user_id, bot_user_id, allows_write_to_pm, has_started_chat, app_tos_accepted_at, updated_at_ms)
        VALUES (?, ?, 1, 0, ?, ?)
        ON CONFLICT(user_id, bot_user_id) DO UPDATE SET allows_write_to_pm = 1, updated_at_ms = excluded.updated_at_ms
      `).run(auth.userId, resolved.app.bot_user_id, now, now);
    }

    const cntRow = db
      .prepare(`SELECT COUNT(*) AS cnt FROM mini_app_installs WHERE app_id = ?`)
      .get(resolved.app.app_id) as { cnt: number };

    sendJson(ctx.res, 200, {
      ok: true,
      app: {
        ...resolved.app,
        is_installed: true,
        install_count: Number(cntRow.cnt ?? 1),
        companion_chat_id: companionChatId,
      },
      companion_chat_id: companionChatId,
    });
  });

  router.delete('/api/v1/miniapps/:botUsername/:shortName/install', (ctx) => {
    const auth = requireAuth(db, ctx);
    const resolved = resolveMiniAppRow(ctx.params.botUsername!, ctx.params.shortName!);
    const res = db
      .prepare(`DELETE FROM mini_app_installs WHERE user_id = ? AND app_id = ?`)
      .run(auth.userId, resolved.app.app_id);
    sendJson(ctx.res, 200, { ok: Number(res.changes ?? 0) > 0, app_id: resolved.app.app_id });
  });

  // Launch MiniApp (signs real HMAC-SHA256 `WebAppData` & updates `last_launched_at_ms`)
  const handleLaunchMiniApp = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    let body: { chat_id?: unknown; start_param?: string } = {};
    if (ctx.method === 'POST') {
      try {
        body = await readJsonBody<{ chat_id?: unknown; start_param?: string }>(ctx.req);
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 400)) throw err;
      }
    }
    const resolved = ctx.params.botUsername
      ? resolveMiniAppRow(ctx.params.botUsername, ctx.params.shortName)
      : resolveMiniAppRow(ctx.params.appId!);

    const user = getUserProfileDto(db, auth.userId)!;
    const requestedChatId = parseOptionalPositiveInt(body.chat_id, 'invalid_chat_id', 'chat_id must be a positive integer');
    if (requestedChatId !== undefined) {
      ensureChatReadAccess(db, requestedChatId, auth.userId);
    }
    const companionChatId =
      requestedChatId ?? ensureCompanionDmChat(db, auth.userId, resolved.app.bot_user_id, hub);
    const now = Date.now();

    db.prepare(`
      INSERT INTO mini_app_installs (user_id, app_id, companion_chat_id, installed_at_ms, last_launched_at_ms)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, app_id) DO UPDATE SET
        companion_chat_id = excluded.companion_chat_id,
        last_launched_at_ms = excluded.last_launched_at_ms
    `).run(auth.userId, resolved.app.app_id, companionChatId, now, now);

    db.prepare(`
      INSERT INTO user_bot_permissions (user_id, bot_user_id, allows_write_to_pm, has_started_chat, app_tos_accepted_at, updated_at_ms)
      VALUES (?, ?, 1, 1, 0, ?)
      ON CONFLICT(user_id, bot_user_id) DO UPDATE SET has_started_chat = 1, updated_at_ms = excluded.updated_at_ms
    `).run(auth.userId, resolved.app.bot_user_id, now);

    const authDate = Math.floor(now / 1000);
    const queryId = `AA${crypto.randomBytes(8).toString('hex')}`;
    const userPayload = JSON.stringify({
      id: user.user_id,
      first_name: user.first_name,
      last_name: user.last_name ?? '',
      username: user.username ?? '',
      language_code: 'zh-hans',
      is_premium: user.is_premium,
    });

    const signed = signMiniAppInitData(resolved.botToken, {
      auth_date: String(authDate),
      query_id: queryId,
      start_param: typeof body.start_param === 'string' ? body.start_param : 'web_launch',
      user: userPayload,
    });

    const launchUrl = `${resolved.app.web_url}#tgWebAppData=${encodeURIComponent(signed.initData)}&tgWebAppVersion=8.0&tgWebAppPlatform=weba`;

    const cloudRows = db
      .prepare(`SELECT item_key, item_value FROM mini_app_cloud_storage WHERE user_id = ? AND scope_key = ?`)
      .all(auth.userId, resolved.app.app_id) as Array<{ item_key: string; item_value: string }>;
    const stateObj: Record<string, unknown> = {};
    for (const r of cloudRows) {
      stateObj[r.item_key] = r.item_value;
    }

    const cntRow = db
      .prepare(`SELECT COUNT(*) AS cnt FROM mini_app_installs WHERE app_id = ?`)
      .get(resolved.app.app_id) as { cnt: number };

    const launchCtx: MiniAppLaunchContext = {
      app: {
        ...resolved.app,
        is_installed: true,
        is_recent_used: true,
        last_launched_at: now,
        install_count: Number(cntRow.cnt ?? 1),
        companion_chat_id: companionChatId,
      },
      launch_url: launchUrl,
      init_data: signed.initData,
      query_id: queryId,
      auth_date: authDate,
      companion_chat_id: companionChatId,
      state: stateObj,
      theme_params: NIGHT_THEME_PARAMS,
    };
    sendJson(ctx.res, 200, launchCtx);
  };
  router.post('/api/v1/miniapps/:botUsername/:shortName/launch', handleLaunchMiniApp);
  router.get('/api/v1/miniapps/:botUsername/:shortName/launch', handleLaunchMiniApp);
  router.post('/api/v1/miniapps/:appId/launch', handleLaunchMiniApp);

  // Validate HMAC-SHA256 `WebAppData` init_data
  const handleVerifyInitData = async (ctx: RequestContext): Promise<void> => {
    let body: {
      init_data?: string;
      bot_username?: string;
      short_name?: string;
      app_id?: string;
    } = {};
    try {
      body = await readJsonBody(ctx.req);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 400)) throw err;
    }

    const headerInitData = ctx.req.headers['x-telegram-init-data'];
    const initData =
      typeof body.init_data === 'string'
        ? body.init_data
        : typeof headerInitData === 'string'
          ? headerInitData
          : '';
    let botToken: string | undefined;

    if (
      (body.bot_username !== undefined && typeof body.bot_username !== 'string') ||
      (body.short_name !== undefined && typeof body.short_name !== 'string') ||
      (body.app_id !== undefined && typeof body.app_id !== 'string')
    ) {
      throw new ApiError(400, 'invalid_request', 'bot_username, short_name, and app_id must be strings');
    }
    const botUsername = ctx.params.botUsername ?? body.bot_username;
    const shortName = ctx.params.shortName ?? body.short_name;
    const appId = ctx.params.appId ?? body.app_id;

    if (botUsername && shortName) {
      botToken = resolveMiniAppRow(botUsername, shortName).botToken;
    } else if (appId) {
      botToken = resolveMiniAppRow(appId).botToken;
    } else {
      const allBots = db.prepare(`SELECT bot_token FROM bots_registry`).all() as Array<{ bot_token: string }>;
      for (const b of allBots) {
        const check = verifyMiniAppInitData(b.bot_token, initData);
        if (check.valid) {
          sendJson(ctx.res, 200, { ok: true, valid: true, user: check.user, params: check.params });
          return;
        }
      }
      sendJson(ctx.res, 401, {
        ok: false,
        valid: false,
        error: 'invalid_init_data',
        message: 'HMAC-SHA256 verification failed',
      });
      return;
    }

    const verified = verifyMiniAppInitData(botToken, initData);
    if (!verified.valid) {
      sendJson(ctx.res, 401, {
        ok: false,
        valid: false,
        error: 'invalid_init_data',
        message: 'HMAC-SHA256 verification failed',
      });
      return;
    }
    sendJson(ctx.res, 200, { ok: true, valid: true, user: verified.user, params: verified.params });
  };
  router.post('/api/v1/miniapps/verify-init-data', handleVerifyInitData);
  router.post('/api/v1/miniapps/validate-init-data', handleVerifyInitData);
  router.post('/api/v1/miniapps/:botUsername/:shortName/validate-init-data', handleVerifyInitData);
  router.post('/api/v1/miniapps/:appId/validate-init-data', handleVerifyInitData);

  function resolveMiniAppCallerUserId(ctx: RequestContext, botToken: string): number {
    const initDataHeader = ctx.req.headers['x-telegram-init-data'];
    if (typeof initDataHeader === 'string' && initDataHeader.trim()) {
      const check = verifyMiniAppInitData(botToken, initDataHeader.trim());
      if (!check.valid || !check.user?.id) {
        throw new ApiError(401, 'invalid_init_data', 'Tampered or invalid X-Telegram-Init-Data HMAC');
      }
      return Number(check.user.id);
    }
    const auth = requireAuth(db, ctx);
    return auth.userId;
  }

  // CloudStorage CRUD (`1..128` key, `<= 4096` UTF-8 bytes, max `1024` keys)
  const handleGetCloudStorage = (ctx: RequestContext): void => {
    const resolved = ctx.params.botUsername
      ? resolveMiniAppRow(ctx.params.botUsername, ctx.params.shortName)
      : resolveMiniAppRow(ctx.params.appId!);
    const userId = resolveMiniAppCallerUserId(ctx, resolved.botToken);
    const scopeKey = resolved.app.app_id;

    const filterKeys = ctx.query.get('keys')
      ? ctx.query.get('keys')!.split(',').map((k) => k.trim()).filter(Boolean)
      : null;

    const rows = db
      .prepare(`SELECT item_key, item_value FROM mini_app_cloud_storage WHERE user_id = ? AND scope_key = ?`)
      .all(userId, scopeKey) as Array<{ item_key: string; item_value: string }>;

    const items: Record<string, string> = {};
    const keys: string[] = [];
    for (const r of rows) {
      keys.push(r.item_key);
      if (!filterKeys || filterKeys.includes(r.item_key)) {
        items[r.item_key] = r.item_value;
      }
    }
    sendJson(ctx.res, 200, { ok: true, items, entries: items, values: items, keys });
  };
  router.get('/api/v1/miniapps/:botUsername/:shortName/cloud-storage', handleGetCloudStorage);
  router.get('/api/v1/miniapps/:botUsername/:shortName/storage', handleGetCloudStorage);
  router.get('/api/v1/miniapps/:appId/state', handleGetCloudStorage);
  router.get('/api/v1/miniapps/:appId/storage', handleGetCloudStorage);

  const handleSetCloudStorage = async (ctx: RequestContext): Promise<void> => {
    const resolved = ctx.params.botUsername
      ? resolveMiniAppRow(ctx.params.botUsername, ctx.params.shortName)
      : resolveMiniAppRow(ctx.params.appId!);
    const userId = resolveMiniAppCallerUserId(ctx, resolved.botToken);
    const scopeKey = resolved.app.app_id;

    const body = await readJsonBody<{
      key?: unknown;
      value?: unknown;
      items?: unknown;
    }>(ctx.req);

    if (body.items !== undefined && (typeof body.items !== 'object' || body.items === null || Array.isArray(body.items))) {
      throw new ApiError(400, 'invalid_storage_items', 'items must be a plain object');
    }
    if (body.key !== undefined && typeof body.key !== 'string') {
      throw new ApiError(400, 'invalid_storage_key', 'key must be a string');
    }

    const deduped = new Map<string, string>();
    if (body.items && typeof body.items === 'object' && !Array.isArray(body.items)) {
      for (const [k, v] of Object.entries(body.items as Record<string, unknown>)) {
        deduped.set(k, String(v ?? ''));
      }
    } else if (typeof body.key === 'string') {
      deduped.set(body.key, String(body.value ?? ''));
    }

    for (const [k, v] of deduped.entries()) {
      if (k.length < 1 || k.length > 128) {
        throw new ApiError(400, 'invalid_storage_key', 'CloudStorage key must be 1..128 chars');
      }
      if (Buffer.byteLength(v, 'utf8') > 4096) {
        throw new ApiError(400, 'invalid_storage_value', 'CloudStorage value must be <= 4096 bytes');
      }
    }

    const now = Date.now();
    db.exec('BEGIN IMMEDIATE;');
    try {
      const existingRows = db
        .prepare(`SELECT item_key FROM mini_app_cloud_storage WHERE user_id = ? AND scope_key = ?`)
        .all(userId, scopeKey) as Array<{ item_key: string }>;
      const existingKeys = new Set(existingRows.map((r) => r.item_key));
      let newKeys = 0;
      for (const k of deduped.keys()) {
        if (!existingKeys.has(k)) newKeys += 1;
      }
      if (existingKeys.size + newKeys > 1024) {
        db.exec('ROLLBACK;');
        throw new ApiError(400, 'cloud_storage_quota_exceeded', 'CloudStorage exceeds 1024 keys');
      }

      const stmt = db.prepare(`
        INSERT OR REPLACE INTO mini_app_cloud_storage (user_id, scope_key, item_key, item_value, updated_at_ms)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const [k, v] of deduped.entries()) {
        stmt.run(userId, scopeKey, k, v, now);
      }
      db.exec('COMMIT;');
    } catch (err) {
      try {
        db.exec('ROLLBACK;');
      } catch {
        // Already rolled back
      }
      throw err;
    }

    sendJson(ctx.res, 200, { ok: true, updated: deduped.size });
  };
  router.put('/api/v1/miniapps/:botUsername/:shortName/cloud-storage', handleSetCloudStorage);
  router.post('/api/v1/miniapps/:botUsername/:shortName/cloud-storage', handleSetCloudStorage);
  router.put('/api/v1/miniapps/:botUsername/:shortName/storage', handleSetCloudStorage);
  router.post('/api/v1/miniapps/:botUsername/:shortName/storage', handleSetCloudStorage);
  router.put('/api/v1/miniapps/:appId/state', handleSetCloudStorage);
  router.post('/api/v1/miniapps/:appId/state', handleSetCloudStorage);
  router.put('/api/v1/miniapps/:appId/storage', handleSetCloudStorage);
  router.post('/api/v1/miniapps/:appId/storage', handleSetCloudStorage);

  const handleDeleteCloudStorage = async (ctx: RequestContext): Promise<void> => {
    const resolved = ctx.params.botUsername
      ? resolveMiniAppRow(ctx.params.botUsername, ctx.params.shortName)
      : resolveMiniAppRow(ctx.params.appId!);
    const userId = resolveMiniAppCallerUserId(ctx, resolved.botToken);
    const scopeKey = resolved.app.app_id;

    const queryKeys = ctx.query.get('keys')
      ? ctx.query.get('keys')!.split(',').map((k) => k.trim()).filter(Boolean)
      : [];
    let body: { keys?: string[]; key?: string } = {};
    try {
      body = await readJsonBody<{ keys?: string[]; key?: string }>(ctx.req);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 400)) throw err;
    }
    const keys = [
      ...(ctx.params.storageKey ? [ctx.params.storageKey] : []),
      ...queryKeys,
      ...(Array.isArray(body.keys) ? body.keys.filter((k): k is string => typeof k === 'string') : []),
      ...(typeof body.key === 'string' ? [body.key] : []),
    ];

    for (const k of keys) {
      db.prepare(
        `DELETE FROM mini_app_cloud_storage WHERE user_id = ? AND scope_key = ? AND item_key = ?`,
      ).run(userId, scopeKey, k);
    }
    sendJson(ctx.res, 200, { ok: true, deleted: keys.length });
  };
  router.delete('/api/v1/miniapps/:botUsername/:shortName/storage/:storageKey', handleDeleteCloudStorage);
  router.delete('/api/v1/miniapps/:botUsername/:shortName/cloud-storage', handleDeleteCloudStorage);
  router.delete('/api/v1/miniapps/:botUsername/:shortName/storage', handleDeleteCloudStorage);
  router.delete('/api/v1/miniapps/:appId/state', handleDeleteCloudStorage);
  router.delete('/api/v1/miniapps/:appId/storage', handleDeleteCloudStorage);

  // Mini App `WebApp.sendData` -> real companion chat service message + `bot_api_updates` (ZERO fake `[STATE_PATCH]` reply!)
  const dispatchSendData = (
    resolved: { app: MiniAppEntry; botToken: string },
    userId: number,
    data: unknown,
    requestedChatId?: number,
  ) => {
    const payloadStr = typeof data === 'string' ? data : JSON.stringify(data ?? {});
    if (requestedChatId !== undefined) {
      ensureChatWriteAccess(db, requestedChatId, userId);
    }
    const companionChatId =
      requestedChatId ?? ensureCompanionDmChat(db, userId, resolved.app.bot_user_id, hub);

    const userMsg = createMessageAtomic(db, hub, {
      chatId: companionChatId,
      senderId: userId,
      text: `🧩 [${resolved.app.title}] WebApp Data: ${payloadStr}`,
    });

    enqueueBotApiUpdate(db, resolved.app.bot_user_id, {
      message: {
        message_id: userMsg.message.id,
        from: { id: userId },
        chat: { id: companionChatId, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        web_app_data: {
          data: payloadStr,
          button_text: resolved.app.title,
        },
      },
    });

    return {
      ok: true,
      chat_id: companionChatId,
      service_message_id: userMsg.message.id,
    };
  };

  const handleMiniAppSendData = async (ctx: RequestContext): Promise<void> => {
    const resolved = ctx.params.botUsername
      ? resolveMiniAppRow(ctx.params.botUsername, ctx.params.shortName)
      : resolveMiniAppRow(ctx.params.appId!);
    const userId = resolveMiniAppCallerUserId(ctx, resolved.botToken);
    const body = await readJsonBody<{ data?: unknown; event_type?: string; chat_id?: unknown }>(ctx.req);
    const chatId = parseOptionalPositiveInt(body.chat_id, 'invalid_chat_id', 'chat_id must be a positive integer');
    const result = dispatchSendData(resolved, userId, body.data, chatId);
    sendJson(ctx.res, 200, result);
  };
  router.post('/api/v1/miniapps/:appId/send-data', handleMiniAppSendData);
  router.post('/api/v1/miniapps/:appId/event', handleMiniAppSendData);
  router.post('/api/v1/miniapps/:botUsername/:shortName/send-data', handleMiniAppSendData);

  // Decoupled MiniApp Action (`send_data`, `webmcp_discover`, `webmcp_get_state`, `webmcp_invoke`)
  router.post('/api/v1/miniapps/:botUsername/:shortName/action', async (ctx) => {
    const resolved = resolveMiniAppRow(ctx.params.botUsername!, ctx.params.shortName!);
    const userId = resolveMiniAppCallerUserId(ctx, resolved.botToken);
    const body = await readJsonBody<{
      action_type?: string;
      action?: string;
      data?: unknown;
      tool_name?: string;
      arguments?: Record<string, unknown>;
      chat_id?: unknown;
      timeout_ms?: number;
    }>(ctx.req);

    const rawActionType = body.action_type ?? body.action;
    const actionType = typeof rawActionType === 'string' ? rawActionType.trim().toLowerCase() : '';
    const requestedChatId = parseOptionalPositiveInt(
      body.chat_id,
      'invalid_chat_id',
      'chat_id must be a positive integer',
    );
    if (requestedChatId !== undefined) {
      if (actionType === 'send_data') {
        ensureChatWriteAccess(db, requestedChatId, userId);
      } else {
        ensureChatReadAccess(db, requestedChatId, userId);
      }
    }
    const chatId = requestedChatId ?? ensureCompanionDmChat(db, userId, resolved.app.bot_user_id, hub);

    if (actionType === 'send_data') {
      sendJson(ctx.res, 200, dispatchSendData(resolved, userId, body.data, requestedChatId));
      return;
    }

    if (
      actionType === 'webmcp_discover' ||
      actionType === 'webmcp_get_state' ||
      actionType === 'webmcp_invoke'
    ) {
      const op =
        actionType === 'webmcp_discover'
          ? 'discover'
          : actionType === 'webmcp_get_state'
            ? 'get_state'
            : 'call_tool';
      const rpcRes = await broker.dispatchWebMcpCommand(
        userId,
        {
          request_id: `wmcp_${crypto.randomBytes(6).toString('hex')}`,
          bot_username: resolved.app.bot_username,
          short_name: resolved.app.short_name,
          chat_id: chatId,
          bot_user_id: resolved.app.bot_user_id,
          app_title: resolved.app.title,
          operation: op,
          tool_name: typeof body.tool_name === 'string' ? body.tool_name : null,
          arguments:
            body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments)
              ? body.arguments
              : {},
        },
        typeof body.timeout_ms === 'number' ? body.timeout_ms : DEFAULT_WEBMCP_RPC_TIMEOUT_MS,
      );
      sendJson(ctx.res, rpcRes.ok ? 200 : 503, rpcRes);
      return;
    }

    throw new ApiError(400, 'invalid_action', `Unsupported MiniApp action_type: ${actionType}`);
  });

  // ==========================================================================
  // 4. Legacy Fabushi Globe Stateful Endpoints — STRICTLY on `/api/v1/fabushi-miniapp/*`
  //    (ZERO `/api/v1/fabushi/*` collision with Fabushi/Hermes Agent Runtime!)
  // ==========================================================================
  const resolveFabushiUserId = (ctx: RequestContext): number => {
    const initHeader = ctx.req.headers['x-telegram-init-data'];
    if (typeof initHeader === 'string' && initHeader.trim()) {
      const fabushiBot = db
        .prepare(`SELECT bot_token FROM bots_registry WHERE bot_user_id = 777002`)
        .get() as { bot_token: string } | undefined;
      if (fabushiBot) {
        const check = verifyMiniAppInitData(fabushiBot.bot_token, initHeader.trim());
        if (!check.valid || !check.user?.id) {
          throw new ApiError(401, 'invalid_init_data', 'Tampered or invalid X-Telegram-Init-Data HMAC');
        }
        return Number(check.user.id);
      }
    }
    const bearer = extractBearerToken(ctx.req, ctx.query);
    const session = authenticateToken(db, bearer);
    if (!session) {
      throw new ApiError(401, 'unauthorized', 'Authentication required');
    }
    return session.userId;
  };

  const handleFabushiGetState = (ctx: RequestContext): void => {
    const userId = resolveFabushiUserId(ctx);
    sendJson(ctx.res, 200, getFabushiState(db, userId));
  };
  router.get('/api/v1/fabushi-miniapp/state', handleFabushiGetState);

  const handleFabushiBeam = async (ctx: RequestContext): Promise<void> => {
    const userId = resolveFabushiUserId(ctx);
    const body = await readJsonBody<{ from_city?: string; to_city?: string; sutra?: string }>(ctx.req);

    const state = getFabushiState(db, userId);
    state.merit_total += 9;
    state.beams.unshift({
      id: `beam_${crypto.randomBytes(4).toString('hex')}`,
      from_city: typeof body.from_city === 'string' && body.from_city.trim() ? body.from_city.trim() : 'Shanghai',
      to_city: typeof body.to_city === 'string' && body.to_city.trim() ? body.to_city.trim() : 'Zurich',
      sutra: typeof body.sutra === 'string' && body.sutra.trim() ? body.sutra.trim() : '般若波罗蜜多心经',
      created_at_ms: Date.now(),
    });
    state.beams = state.beams.slice(0, 25);
    saveFabushiState(db, userId, state);
    sendJson(ctx.res, 201, state);
  };
  router.post('/api/v1/fabushi-miniapp/beam', handleFabushiBeam);

  const handleFabushiMuyu = async (ctx: RequestContext): Promise<void> => {
    const userId = resolveFabushiUserId(ctx);
    const body = await readJsonBody<{ count?: number }>(ctx.req);
    const delta = Math.max(1, Math.min(108, Math.trunc(Number(body.count ?? 1)) || 1));
    const state = getFabushiState(db, userId);
    state.wooden_fish_taps += delta;
    state.merit_total += delta;
    saveFabushiState(db, userId, state);
    sendJson(ctx.res, 200, state);
  };
  router.post('/api/v1/fabushi-miniapp/zen/muyu', handleFabushiMuyu);

  const handleFabushiIncense = async (ctx: RequestContext): Promise<void> => {
    const userId = resolveFabushiUserId(ctx);
    try {
      await readJsonBody(ctx.req);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 400)) throw err;
    }
    const state = getFabushiState(db, userId);
    state.incense_lit = true;
    state.merit_total += 3;
    saveFabushiState(db, userId, state);
    sendJson(ctx.res, 200, state);
  };
  router.post('/api/v1/fabushi-miniapp/zen/incense', handleFabushiIncense);

  const handleFabushiDedicate = async (ctx: RequestContext): Promise<void> => {
    const userId = resolveFabushiUserId(ctx);
    const body = await readJsonBody<{ text?: string }>(ctx.req);
    const state = getFabushiState(db, userId);
    const dedicationText = (typeof body.text === 'string' ? body.text : '愿以此功德，庄严佛净土').trim();
    state.dedications.unshift({ text: dedicationText, created_at_ms: Date.now() });
    state.merit_total += 18;
    saveFabushiState(db, userId, state);

    const companionChatId = ensureCompanionDmChat(db, userId, 777002, hub);
    createMessageAtomic(db, hub, {
      chatId: companionChatId,
      senderId: 777002,
      text: `🪷 功德回向圆满：「${dedicationText}」· 当前总功德 **${state.merit_total}**`,
    });

    sendJson(ctx.res, 200, state);
  };
  router.post('/api/v1/fabushi-miniapp/zen/dedicate', handleFabushiDedicate);

  // ==========================================================================
  // 5. Official `window.Telegram.WebApp` v8.0 + WebMCP (`navigator.modelContext`) SDK
  //    Zero fake `Alice`/`1001` initData, honest CloudStorage (`/storage`), origin-safe postMessage!
  // ==========================================================================
  router.get('/js/telegram-web-app.js', (ctx) => {
    const sdkJs = `(function () {
  var hashParams = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
  var searchParams = new URLSearchParams(window.location.search || '');
  var initData = '';
  if (typeof window.__TG_INIT_DATA__ === 'string' && window.__TG_INIT_DATA__.trim()) {
    initData = window.__TG_INIT_DATA__.trim();
  } else if (hashParams.get('tgWebAppData')) {
    initData = hashParams.get('tgWebAppData') || '';
  } else if (searchParams.get('tgWebAppData')) {
    initData = searchParams.get('tgWebAppData') || '';
  } else if (searchParams.get('init_data')) {
    initData = searchParams.get('init_data') || '';
  }

  var initDataUnsafe = {};
  if (initData) {
    var parsedInit = new URLSearchParams(initData);
    var parsedUser = undefined;
    try {
      var rawUser = parsedInit.get('user');
      if (rawUser) parsedUser = JSON.parse(rawUser);
    } catch (_) {}
    if (parsedInit.get('query_id')) initDataUnsafe.query_id = parsedInit.get('query_id');
    if (parsedUser !== undefined) initDataUnsafe.user = parsedUser;
    if (parsedInit.get('auth_date')) initDataUnsafe.auth_date = Number(parsedInit.get('auth_date'));
    if (parsedInit.get('hash')) initDataUnsafe.hash = parsedInit.get('hash');
    if (parsedInit.get('start_param')) initDataUnsafe.start_param = parsedInit.get('start_param');
  }

  var listeners = {};
  function emit(eventType, payload) {
    var list = listeners[eventType] || [];
    for (var i = 0; i < list.length; i++) {
      try { list[i](payload); } catch (_) {}
    }
  }

  function resolveTargetOrigin() {
    if (window.location && window.location.origin && window.location.origin !== 'null') {
      return window.location.origin;
    }
    return '*';
  }

  function postToHost(eventType, eventData) {
    var payload = { type: 'telegram_web_app_event', eventType: eventType, eventData: eventData || {} };
    var targetOrigin = resolveTargetOrigin();
    try {
      if (window.TelegramWebviewProxy && typeof window.TelegramWebviewProxy.postEvent === 'function') {
        window.TelegramWebviewProxy.postEvent(eventType, JSON.stringify(eventData || {}));
      } else if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.telegramWebApp) {
        window.webkit.messageHandlers.telegramWebApp.postMessage(payload);
      } else if (window.parent && window.parent !== window) {
        window.parent.postMessage(payload, targetOrigin);
      } else if (eventType === 'webmcp_response' || eventType === 'webmcp_state_update') {
        window.postMessage(payload, targetOrigin);
      }
    } catch (_) {}
  }

  function resolveMiniAppApiBase() {
    if (typeof window.__TG_API_BASE__ === 'string' && window.__TG_API_BASE__.trim()) {
      return window.__TG_API_BASE__.trim().replace(/\\/+$/, '');
    }
    var qBase = searchParams.get('api_base');
    if (qBase && qBase.trim()) {
      return qBase.trim().replace(/\\/+$/, '');
    }
    var parts = (window.location.pathname || '').split('/').filter(Boolean);
    if (parts[0] === 'miniapps' && parts[1] === 'fabushi-globe') {
      return '/api/v1/miniapps/FabushiBot/fabushi-globe';
    }
    if (parts[0] === 'miniapps' && parts[1] && parts[2] && !parts[2].endsWith('.html')) {
      return '/api/v1/miniapps/' + encodeURIComponent(parts[1]) + '/' + encodeURIComponent(parts[2]);
    }
    return '/api/v1/miniapps/FabushiBot/fabushi-globe';
  }

  var apiBase = resolveMiniAppApiBase();
  var storageUrl = apiBase + '/storage';
  var sendDataUrl = apiBase + '/send-data';

  function buildAuthHeaders(extra) {
    var headers = Object.assign({}, extra || {});
    if (initData) headers['X-Telegram-Init-Data'] = initData;
    if (typeof window.__TG_AUTH_TOKEN__ === 'string' && window.__TG_AUTH_TOKEN__.trim()) {
      headers['Authorization'] = 'Bearer ' + window.__TG_AUTH_TOKEN__.trim();
    }
    return headers;
  }

  var MainButton = {
    text: 'CONTINUE',
    color: '#3390EC',
    textColor: '#FFFFFF',
    isVisible: false,
    isActive: true,
    isProgressVisible: false,
    setText: function (t) { this.text = String(t); postToHost('web_app_setup_main_button', { text: this.text, is_visible: this.isVisible, is_active: this.isActive, color: this.color, text_color: this.textColor }); return this; },
    show: function () { this.isVisible = true; postToHost('web_app_setup_main_button', { text: this.text, is_visible: true, is_active: this.isActive, color: this.color, text_color: this.textColor }); return this; },
    hide: function () { this.isVisible = false; postToHost('web_app_setup_main_button', { text: this.text, is_visible: false, is_active: this.isActive }); return this; },
    enable: function () { this.isActive = true; return this; },
    disable: function () { this.isActive = false; return this; },
    showProgress: function () { this.isProgressVisible = true; return this; },
    hideProgress: function () { this.isProgressVisible = false; return this; },
    setParams: function (p) { if (!p) return this; if (p.text) this.text = String(p.text); if (p.color) this.color = String(p.color); if (p.text_color) this.textColor = String(p.text_color); if (p.is_visible !== undefined) this.isVisible = Boolean(p.is_visible); if (p.is_active !== undefined) this.isActive = Boolean(p.is_active); postToHost('web_app_setup_main_button', { text: this.text, is_visible: this.isVisible, is_active: this.isActive, color: this.color, text_color: this.textColor }); return this; },
    onClick: function (cb) { WebApp.onEvent('mainButtonClicked', cb); return this; },
    offClick: function (cb) { WebApp.offEvent('mainButtonClicked', cb); return this; }
  };

  var SecondaryButton = {
    text: '',
    color: '#242F3D',
    textColor: '#FFFFFF',
    isVisible: false,
    isActive: true,
    position: 'left',
    setText: function (t) { this.text = String(t); postToHost('web_app_setup_secondary_button', { text: this.text, is_visible: this.isVisible, is_active: this.isActive, color: this.color, text_color: this.textColor, position: this.position }); return this; },
    show: function () { this.isVisible = true; postToHost('web_app_setup_secondary_button', { text: this.text, is_visible: true, is_active: this.isActive, position: this.position }); return this; },
    hide: function () { this.isVisible = false; postToHost('web_app_setup_secondary_button', { text: this.text, is_visible: false, is_active: this.isActive }); return this; },
    setParams: function (p) { if (!p) return this; if (p.text) this.text = String(p.text); if (p.is_visible !== undefined) this.isVisible = Boolean(p.is_visible); postToHost('web_app_setup_secondary_button', { text: this.text, is_visible: this.isVisible, is_active: this.isActive }); return this; },
    onClick: function (cb) { WebApp.onEvent('secondaryButtonClicked', cb); return this; },
    offClick: function (cb) { WebApp.offEvent('secondaryButtonClicked', cb); return this; }
  };

  var BackButton = {
    isVisible: false,
    show: function () { this.isVisible = true; postToHost('web_app_setup_back_button', { is_visible: true }); return this; },
    hide: function () { this.isVisible = false; postToHost('web_app_setup_back_button', { is_visible: false }); return this; },
    onClick: function (cb) { WebApp.onEvent('backButtonClicked', cb); return this; },
    offClick: function (cb) { WebApp.offEvent('backButtonClicked', cb); return this; }
  };

  var SettingsButton = {
    isVisible: false,
    show: function () { this.isVisible = true; postToHost('web_app_setup_settings_button', { is_visible: true }); return this; },
    hide: function () { this.isVisible = false; postToHost('web_app_setup_settings_button', { is_visible: false }); return this; },
    onClick: function (cb) { WebApp.onEvent('settingsButtonClicked', cb); return this; },
    offClick: function (cb) { WebApp.offEvent('settingsButtonClicked', cb); return this; }
  };

  var CloudStorage = {
    setItem: function (key, value, cb) {
      return fetch(storageUrl, {
        method: 'PUT',
        headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ key: key, value: String(value) })
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        if (cb) cb(null, true);
        return true;
      }).catch(function (e) {
        if (cb) cb(String(e && e.message ? e.message : e), false);
        return false;
      });
    },
    getItem: function (key, cb) {
      return fetch(storageUrl + '?keys=' + encodeURIComponent(key), {
        headers: buildAuthHeaders()
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function (d) {
        var map = (d && (d.entries || d.items)) || {};
        var val = map[key] !== undefined ? map[key] : '';
        if (cb) cb(null, val);
        return val;
      }).catch(function (e) {
        if (cb) cb(String(e && e.message ? e.message : e), '');
        return '';
      });
    },
    getItems: function (keys, cb) {
      return fetch(storageUrl + '?keys=' + encodeURIComponent((keys || []).join(',')), {
        headers: buildAuthHeaders()
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function (d) {
        var map = (d && (d.entries || d.items)) || {};
        if (cb) cb(null, map);
        return map;
      }).catch(function (e) {
        if (cb) cb(String(e && e.message ? e.message : e), {});
        return {};
      });
    },
    removeItem: function (key, cb) {
      return fetch(storageUrl + '/' + encodeURIComponent(key), {
        method: 'DELETE',
        headers: buildAuthHeaders()
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        if (cb) cb(null, true);
        return true;
      }).catch(function (e) {
        if (cb) cb(String(e && e.message ? e.message : e), false);
        return false;
      });
    },
    removeItems: function (keys, cb) {
      return fetch(storageUrl, {
        method: 'DELETE',
        headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ keys: keys })
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        if (cb) cb(null, true);
        return true;
      }).catch(function (e) {
        if (cb) cb(String(e && e.message ? e.message : e), false);
        return false;
      });
    },
    getKeys: function (cb) {
      return fetch(storageUrl, { headers: buildAuthHeaders() })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function (d) {
          var keys = (d && d.keys) || [];
          if (cb) cb(null, keys);
          return keys;
        })
        .catch(function (e) {
          if (cb) cb(String(e && e.message ? e.message : e), []);
          return [];
        });
    }
  };

  var WebApp = {
    initData: initData,
    initDataUnsafe: initDataUnsafe,
    version: '8.0',
    platform: 'weba',
    colorScheme: 'dark',
    themeParams: ${JSON.stringify(NIGHT_THEME_PARAMS)},
    isExpanded: true,
    viewportHeight: window.innerHeight || 640,
    viewportStableHeight: window.innerHeight || 640,
    MainButton: MainButton,
    BottomButton: MainButton,
    SecondaryButton: SecondaryButton,
    BackButton: BackButton,
    SettingsButton: SettingsButton,
    HapticFeedback: {
      impactOccurred: function (style) { postToHost('web_app_trigger_haptic_feedback', { type: 'impact', impact_style: style }); },
      notificationOccurred: function (type) { postToHost('web_app_trigger_haptic_feedback', { type: 'notification', notification_type: type }); },
      selectionChanged: function () { postToHost('web_app_trigger_haptic_feedback', { type: 'selection_change' }); }
    },
    CloudStorage: CloudStorage,
    ready: function () { postToHost('web_app_ready', {}); },
    expand: function () { this.isExpanded = true; postToHost('web_app_expand', {}); },
    requestFullscreen: function () { postToHost('web_app_request_fullscreen', {}); },
    exitFullscreen: function () { postToHost('web_app_exit_fullscreen', {}); },
    close: function () { postToHost('web_app_close', {}); },
    setHeaderColor: function (c) { postToHost('web_app_set_header_color', { color: c }); },
    setBackgroundColor: function (c) { postToHost('web_app_set_background_color', { color: c }); },
    sendData: function (dataStr) {
      var str = typeof dataStr === 'string' ? dataStr : JSON.stringify(dataStr);
      postToHost('web_app_data_send', { data: str });
      return fetch(sendDataUrl, {
        method: 'POST',
        headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ data: str })
      });
    },
    requestWriteAccess: function (cb) { postToHost('web_app_request_write_access', {}); if (cb) cb(true); },
    openLink: function (url) { postToHost('web_app_open_link', { url: String(url) }); },
    openTelegramLink: function (url) { postToHost('web_app_open_tg_link', { url: String(url) }); },
    showPopup: function (params, cb) { postToHost('web_app_open_popup', params || {}); if (cb) cb('ok'); },
    showAlert: function (msg, cb) { postToHost('web_app_open_popup', { message: String(msg) }); if (cb) cb(); },
    showConfirm: function (msg, cb) { postToHost('web_app_open_popup', { message: String(msg) }); if (cb) cb(true); },
    onEvent: function (eventType, cb) {
      listeners[eventType] = listeners[eventType] || [];
      listeners[eventType].push(cb);
    },
    offEvent: function (eventType, cb) {
      listeners[eventType] = (listeners[eventType] || []).filter(function (fn) { return fn !== cb; });
    }
  };

  window.Telegram = window.Telegram || {};
  window.Telegram.WebApp = WebApp;

  // ========================================================================
  // WebMCP (navigator.modelContext + window.__GPUI_WEBMCP__)
  // ========================================================================
  var pageErrors = [];
  function pushPageError(msg) {
    if (!msg) return;
    pageErrors.push(String(msg).slice(0, 400));
    if (pageErrors.length > 5) pageErrors.shift();
  }
  window.addEventListener('error', function (ev) {
    pushPageError((ev && ev.message) || 'Runtime error');
  });
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev && ev.reason;
    pushPageError(r && r.message ? r.message : String(r || 'Unhandled rejection'));
  });

  function scrapeVisibleToast() {
    try {
      var sels = ['#toast', '[role="alert"]', '.toast', '.error-banner'];
      for (var i = 0; i < sels.length; i++) {
        var el = document.querySelector(sels[i]);
        if (el && el.offsetParent !== null) {
          var txt = (el.textContent || '').trim();
          if (txt) return txt.slice(0, 300);
        }
      }
    } catch (_) {}
    return undefined;
  }

  var registeredTools = new Map();
  var stateProviderFn = null;

  var builtinTools = [
    { name: 'get_state', description: 'Read current Mini App state summary', input_schema: { type: 'object', properties: {} }, read_only: true },
    { name: 'page_inspect', description: 'Inspect visible interactive elements on page', input_schema: { type: 'object', properties: {} }, read_only: true },
    { name: 'page_click', description: 'Click an element by CSS selector or text', input_schema: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' } } }, read_only: false },
    { name: 'page_fill', description: 'Fill an input element by CSS selector', input_schema: { type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string' } }, required: ['selector', 'value'] }, read_only: false },
    { name: 'page_press_main_button', description: 'Trigger Telegram WebApp MainButton click', input_schema: { type: 'object', properties: {} }, read_only: false },
    { name: 'page_press_secondary_button', description: 'Trigger Telegram WebApp SecondaryButton click', input_schema: { type: 'object', properties: {} }, read_only: false }
  ];

  function readStateSummary() {
    var customState = {};
    if (typeof stateProviderFn === 'function') {
      try { customState = stateProviderFn() || {}; } catch (e) { pushPageError(String(e)); }
    }
    var summary = {
      ok: pageErrors.length === 0,
      title: document.title || '',
      url: window.location.href || '',
      state: customState,
      main_button: { is_visible: MainButton.isVisible, text: MainButton.text },
      secondary_button: { is_visible: SecondaryButton.isVisible, text: SecondaryButton.text }
    };
    if (pageErrors.length > 0) summary.page_errors = pageErrors.slice();
    var toast = scrapeVisibleToast();
    if (toast) summary.visible_toast = toast;
    if (customState && typeof customState.boot_error === 'string' && customState.boot_error) {
      summary.boot_error = customState.boot_error;
      summary.ok = false;
    }
    return summary;
  }

  function discoverTools() {
    var list = builtinTools.slice();
    registeredTools.forEach(function (spec) {
      list.push({
        name: spec.name,
        description: spec.description || '',
        input_schema: spec.inputSchema || spec.input_schema || { type: 'object', properties: {} },
        read_only: Boolean(spec.readOnly || spec.read_only)
      });
    });
    return list;
  }

  function executeBuiltinTool(toolName, args) {
    args = args || {};
    if (toolName === 'get_state') return readStateSummary();
    if (toolName === 'page_inspect') {
      var nodes = Array.prototype.slice.call(document.querySelectorAll('button,a,input,select,textarea,[role="button"]')).slice(0, 40);
      return {
        title: document.title || '',
        elements: nodes.map(function (el) {
          return {
            tag: el.tagName.toLowerCase(),
            id: el.id || undefined,
            text: (el.textContent || '').trim().slice(0, 80),
            aria_label: el.getAttribute('aria-label') || undefined
          };
        })
      };
    }
    if (toolName === 'page_click') {
      var target = args.selector ? document.querySelector(args.selector) : null;
      if (!target && args.text) {
        var all = document.querySelectorAll('button,a,[role="button"]');
        for (var i = 0; i < all.length; i++) {
          if ((all[i].textContent || '').trim().indexOf(args.text) !== -1) { target = all[i]; break; }
        }
      }
      if (!target) throw new Error('Element not found');
      target.click();
      return { clicked: true };
    }
    if (toolName === 'page_fill') {
      var inp = args.selector ? document.querySelector(args.selector) : null;
      if (!inp) throw new Error('Input not found');
      inp.value = String(args.value || '');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      return { filled: true };
    }
    if (toolName === 'page_press_main_button') {
      emit('mainButtonClicked');
      return { pressed: 'main_button' };
    }
    if (toolName === 'page_press_secondary_button') {
      emit('secondaryButtonClicked');
      return { pressed: 'secondary_button' };
    }
    throw new Error('Unknown tool: ' + toolName);
  }

  var gpuiWebMcp = {
    _tools: registeredTools,
    _stateProvider: function () { return stateProviderFn; },
    _pageErrors: pageErrors,
    discover: discoverTools,
    readState: readStateSummary,
    invoke: function (requestId, operation, toolName, args) {
      var finish = function (ok, result, errMsg) {
        var resp = {
          request_id: requestId,
          ok: ok,
          result: result !== undefined ? result : null,
          error: errMsg || null,
          tools: discoverTools(),
          state_summary: readStateSummary(),
          control_mode: 'ai_controlling'
        };
        postToHost('webmcp_response', resp);
        return resp;
      };
      try {
        if (operation === 'discover') return Promise.resolve(finish(true, { tools: discoverTools() }, null));
        if (operation === 'get_state') return Promise.resolve(finish(true, readStateSummary(), null));
        if (operation === 'call_tool') {
          var custom = registeredTools.get(toolName);
          if (custom && typeof custom.execute === 'function') {
            return Promise.resolve(custom.execute(args || {})).then(
              function (r) { return finish(true, r, null); },
              function (e) { return finish(false, null, String(e && e.message ? e.message : e)); }
            );
          }
          return Promise.resolve(finish(true, executeBuiltinTool(toolName, args), null));
        }
        return Promise.resolve(finish(false, null, 'Unsupported operation: ' + operation));
      } catch (e) {
        return Promise.resolve(finish(false, null, String(e && e.message ? e.message : e)));
      }
    }
  };
  window.__GPUI_WEBMCP__ = gpuiWebMcp;

  var modelContext = {
    registerTool: function (spec) {
      if (!spec || typeof spec.name !== 'string' || !spec.name.trim()) return;
      registeredTools.set(spec.name.trim(), spec);
    },
    unregisterTool: function (name) { registeredTools.delete(String(name)); },
    provideContext: function (ctxObj) {
      registeredTools.clear();
      if (ctxObj && Array.isArray(ctxObj.tools)) {
        ctxObj.tools.forEach(function (t) { modelContext.registerTool(t); });
      }
    },
    clearContext: function () { registeredTools.clear(); },
    setStateProvider: function (fn) { stateProviderFn = typeof fn === 'function' ? fn : null; },
    reportStatus: function (statusOrObj) {
      var summary = readStateSummary();
      var payload;
      if (statusOrObj && typeof statusOrObj === 'object') {
        var merged = Object.assign({}, summary, statusOrObj);
        if (typeof statusOrObj.boot_error === 'string' && statusOrObj.boot_error) {
          merged.ok = false;
        }
        payload = Object.assign({}, statusOrObj, {
          status_text: typeof statusOrObj.status_text === 'string'
            ? statusOrObj.status_text
            : typeof statusOrObj.message === 'string'
              ? statusOrObj.message
              : typeof statusOrObj.boot_error === 'string'
                ? statusOrObj.boot_error
                : '',
          state_summary: merged
        });
      } else {
        payload = {
          status_text: typeof statusOrObj === 'string' ? statusOrObj : String(statusOrObj || ''),
          state_summary: summary
        };
      }
      postToHost('webmcp_state_update', payload);
    }
  };

  try {
    Object.defineProperty(navigator, 'modelContext', {
      value: modelContext,
      configurable: true,
      writable: true
    });
  } catch (_) {
    try { navigator.modelContext = modelContext; } catch (__) {}
  }

  window.addEventListener('message', function (ev) {
    if (window.location.origin !== 'null' && ev.origin && ev.origin !== window.location.origin) {
      return;
    }
    try {
      var msg = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
      if (!msg || !msg.eventType) return;
      if (msg.eventType === 'main_button_pressed') {
        emit('mainButtonClicked');
      } else if (msg.eventType === 'secondary_button_pressed') {
        emit('secondaryButtonClicked');
      } else if (msg.eventType === 'back_button_pressed') {
        emit('backButtonClicked');
      } else if (msg.eventType === 'settings_button_pressed') {
        emit('settingsButtonClicked');
      } else if (msg.eventType === 'theme_changed' && msg.eventData) {
        Object.assign(WebApp.themeParams, msg.eventData.theme_params || {});
        emit('themeChanged', msg.eventData);
      } else if (msg.eventType === 'webmcp_command' && msg.eventData) {
        var cmd = msg.eventData;
        gpuiWebMcp.invoke(cmd.request_id, cmd.operation, cmd.tool_name, cmd.arguments || {});
      } else {
        emit(msg.eventType, msg.eventData);
      }
    } catch (_) {}
  });
})();`;

    ctx.res.statusCode = 200;
    ctx.res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    ctx.res.setHeader('Cache-Control', 'no-cache');
    ctx.res.end(sdkJs);
  });

  // ==========================================================================
  // 6. Fabushi Globe Static Assets & Hosted Mini App Bundles
  //    Static `/miniapps/fabushi-globe*` MUST register BEFORE `/:botUsername/:shortName`!
  // ==========================================================================
  const FABUSHI_GLOBE_STATIC_ASSETS = new Map<string, string>([
    ['index.html', 'text/html; charset=utf-8'],
    ['fabushi_miniapp.wasm', 'application/wasm'],
    ['earth_texture.jpg', 'image/jpeg'],
    ['home_world_lightfield.webp', 'image/webp'],
    ['zen_room_backdrop_2d.webp', 'image/webp'],
    ['concap.csv', 'text/csv; charset=utf-8'],
    ['r2-files-list.json', 'application/json; charset=utf-8'],
  ]);

  const serveFabushiGlobeStaticAsset = (ctx: RequestContext, assetName: string): void => {
    const rawUrlPath = (ctx.req.url ?? '').split('?')[0] ?? '';
    if (
      /(?:^|\/|\\)\.\.(?:\/|\\|$)/.test(rawUrlPath) ||
      /%2e%2e|%2f|%5c|\\|\0/i.test(rawUrlPath) ||
      assetName.includes('/') ||
      assetName.includes('\\') ||
      assetName.includes('..') ||
      assetName.includes('\0')
    ) {
      throw new ApiError(400, 'invalid_asset_path', 'Path traversal is not allowed');
    }
    const contentType = FABUSHI_GLOBE_STATIC_ASSETS.get(assetName);
    if (!contentType) {
      throw new ApiError(404, 'asset_not_found', `Fabushi Globe asset "${assetName}" not found`);
    }
    const baseDir = path.resolve(config.fabushiAssetsDir);
    const filePath = path.resolve(baseDir, assetName);
    if (!filePath.startsWith(`${baseDir}${path.sep}`)) {
      throw new ApiError(400, 'invalid_asset_path', 'Path traversal is not allowed');
    }
    if (!fs.existsSync(filePath)) {
      throw new ApiError(404, 'asset_not_found', `Fabushi Globe asset "${assetName}" missing`);
    }
    const bytes = fs.readFileSync(filePath);
    ctx.res.statusCode = 200;
    ctx.res.setHeader('Content-Type', contentType);
    ctx.res.setHeader('Content-Length', String(bytes.length));
    ctx.res.setHeader(
      'Cache-Control',
      assetName === 'index.html' || assetName === 'fabushi_miniapp.wasm'
        ? 'no-cache'
        : 'public, max-age=300',
    );
    ctx.res.end(bytes);
  };

  router.get('/miniapps/fabushi-globe', (ctx) => {
    serveFabushiGlobeStaticAsset(ctx, 'index.html');
  });
  router.get('/miniapps/fabushi-globe/:assetName', (ctx) => {
    serveFabushiGlobeStaticAsset(ctx, ctx.params.assetName ?? '');
  });

  router.get('/miniapps/:botUsername/:shortName', (ctx) => {
    const resolved = resolveMiniAppRow(ctx.params.botUsername!, ctx.params.shortName!);
    if (resolved.htmlBundle) {
      ctx.res.statusCode = 200;
      ctx.res.setHeader('Content-Type', 'text/html; charset=utf-8');
      ctx.res.end(resolved.htmlBundle);
      return;
    }

    const shortLower = resolved.app.short_name.toLowerCase();
    let html: string;
    if (shortLower.includes('fabushi')) {
      const hostShellPath = path.join(config.fabushiAssetsDir, 'index.html');
      if (fs.existsSync(hostShellPath)) {
        html = fs.readFileSync(hostShellPath, 'utf8');
      } else {
        throw new ApiError(404, 'miniapp_bundle_missing', 'Fabushi WASM host shell index.html not found');
      }
    } else {
      html = renderMinimalMiniAppShellHtml(resolved.app);
    }

    ctx.res.statusCode = 200;
    ctx.res.setHeader('Content-Type', 'text/html; charset=utf-8');
    ctx.res.end(html);
  });

  return broker;
}

function renderMinimalMiniAppShellHtml(app: MiniAppEntry): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(app.title)}</title>
  <script src="/js/telegram-web-app.js"></script>
  <style>
    body { margin: 0; padding: 16px; background: #0E1621; color: #F5F5F5; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
    h1 { font-size: 18px; margin: 0 0 12px; }
    .row { display: flex; gap: 8px; margin-bottom: 12px; }
    input { flex: 1; padding: 8px 12px; border-radius: 8px; border: 1px solid #242F3D; background: #17212B; color: #F5F5F5; }
    button { padding: 8px 14px; border-radius: 8px; border: none; background: #3390EC; color: #FFFFFF; cursor: pointer; font-weight: 500; }
    ul { list-style: none; padding: 0; margin: 0; }
    li { padding: 10px 12px; border-radius: 8px; background: #17212B; border: 1px solid #242F3D; margin-bottom: 8px; }
  </style>
</head>
<body>
  <h1>${escapeHtml(app.icon_emoji || '🧩')} ${escapeHtml(app.title)}</h1>
  <div class="row">
    <input id="item-input" placeholder="Add item to CloudStorage…" />
    <button id="btn-add-item" type="button">Add</button>
  </div>
  <ul id="item-list"></ul>
  <script>
    (function () {
      var tg = window.Telegram && window.Telegram.WebApp;
      var items = [];
      function render() {
        var ul = document.getElementById('item-list');
        ul.innerHTML = '';
        items.forEach(function (t) {
          var li = document.createElement('li');
          li.textContent = t;
          ul.appendChild(li);
        });
      }
      if (tg) {
        tg.ready();
        tg.expand();
        tg.CloudStorage.getItem('app_items', function (err, val) {
          if (!err && val) {
            try {
              var parsed = JSON.parse(val);
              if (Array.isArray(parsed)) { items = parsed; render(); }
            } catch (_) {}
          }
        });
        tg.MainButton.setText('Send to Bot').show().onClick(function () {
          tg.sendData({ action: 'sync_items', count: items.length, items: items });
        });
      }
      document.getElementById('btn-add-item').addEventListener('click', function () {
        var inp = document.getElementById('item-input');
        var v = inp.value.trim();
        if (!v) return;
        items.push(v);
        inp.value = '';
        render();
        if (tg) tg.CloudStorage.setItem('app_items', JSON.stringify(items));
      });
      render();
    })();
  </script>
</body>
</html>`;
}
