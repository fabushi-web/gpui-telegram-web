import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import {
  extractPlainTextFromContent,
  fromWireMessageEntity,
  parseMarkdownEntities,
  toWireMessageEntity,
  type ChatDetailDto,
  type DeleteTombstone,
  type MessageContent,
  type MessageEntity,
  type MessageFlags,
  type MessageItem,
  type PollData,
  type PollOption,
  type PtsUpdate,
  type ReactionCount,
  type ReactionDetail,
  type ReplyHeader,
  type SyncGetDifferenceRequest,
  type SyncGetDifferenceResponse,
  type UpdateEvent,
  type UserProfileDto,
  type WebPagePreview,
  type WireDraftDto,
  type WireMessageEntity,
  type WirePeerId,
} from '@gpui-telegram/protocol';
import { ApiError } from '../utils/http.js';

export function parseOptionalPositiveInt(
  val: unknown,
  errorCode: string,
  message: string,
): number | undefined {
  if (val === undefined || val === null) {
    return undefined;
  }
  if (
    typeof val !== 'number' ||
    !Number.isInteger(val) ||
    val < 1 ||
    val > Number.MAX_SAFE_INTEGER
  ) {
    throw new ApiError(400, errorCode, message);
  }
  return val;
}

export function parseOptionalNonNegativeInt(
  val: unknown,
  errorCode: string,
  message: string,
): number | undefined {
  if (val === undefined || val === null) {
    return undefined;
  }
  if (
    typeof val !== 'number' ||
    !Number.isInteger(val) ||
    val < 0 ||
    val > Number.MAX_SAFE_INTEGER
  ) {
    throw new ApiError(400, errorCode, message);
  }
  return val;
}

export function parseBoundedQueryInt(
  raw: string | null,
  defaultVal: number,
  min: number,
  max: number,
): number {
  const parsed = raw !== null && raw.trim() !== '' ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.trunc(parsed))) : defaultVal;
}

export function validateWireMessageContent(raw: unknown): MessageContent {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ApiError(400, 'invalid_content', 'Message content must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.type !== 'string' || !obj.type.trim()) {
    throw new ApiError(
      400,
      'invalid_content',
      'Message content.type must be a non-empty string',
    );
  }
  if (!obj.data || typeof obj.data !== 'object' || Array.isArray(obj.data)) {
    throw new ApiError(400, 'invalid_content', 'Message content.data must be a JSON object');
  }
  if (obj.type === 'Text') {
    const dataObj = obj.data as Record<string, unknown>;
    if (typeof dataObj.text !== 'string') {
      throw new ApiError(400, 'invalid_content', 'Text content data.text must be a string');
    }
    if (
      dataObj.entities !== undefined &&
      dataObj.entities !== null &&
      !Array.isArray(dataObj.entities)
    ) {
      throw new ApiError(400, 'invalid_content', 'Text content data.entities must be an array');
    }
  }
  return obj as unknown as MessageContent;
}

export function safeExtractPlainTextFromContent(content: unknown): string {
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    return '';
  }
  const obj = content as { type?: unknown; data?: unknown };
  if (typeof obj.type !== 'string') {
    return '';
  }
  if (!obj.data || typeof obj.data !== 'object' || Array.isArray(obj.data)) {
    return '';
  }
  try {
    const extracted = extractPlainTextFromContent(content as MessageContent);
    return typeof extracted === 'string' ? extracted : '';
  } catch {
    return '';
  }
}

export function peerIdForChat(chatId: number, chatType: number, peerUserId?: number | null): WirePeerId {
  if (chatType === 0 && peerUserId) {
    return { User: peerUserId };
  }
  if (chatType === 3) {
    return { Channel: Math.abs(chatId) };
  }
  return { Chat: chatId };
}

export function getUserProfileDto(db: DatabaseSync, userId: number): UserProfileDto | null {
  const row = db
    .prepare(`SELECT * FROM users WHERE user_id = ?`)
    .get(userId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapUserRowToDto(row);
}

export function mapUserRowToDto(row: Record<string, unknown>): UserProfileDto {
  return {
    user_id: Number(row.user_id),
    username: (row.username as string | null) ?? undefined,
    first_name: String(row.first_name ?? 'User'),
    last_name: (row.last_name as string | null) ?? undefined,
    bio: (row.bio as string | null) ?? undefined,
    phone: (row.phone as string | null) ?? undefined,
    avatar_media_id: (row.avatar_media_id as string | null) ?? undefined,
    photo_file_id: (row.avatar_media_id as string | null) ?? undefined,
    emoji_status: (row.emoji_status as string | null) ?? undefined,
    is_bot: Boolean(row.is_bot),
    is_verified: Boolean(row.is_verified),
    is_premium: Boolean(row.is_premium),
    status: String(row.status ?? 'recently'),
    last_seen_ms: row.last_seen_ms ? Number(row.last_seen_ms) : undefined,
  };
}

export interface ChatAccessContext {
  chatId: number;
  chatType: number;
  creatorId: number;
  username: string | null;
  role: string | null;
  adminRights: number;
  bannedRights: number;
  isMember: boolean;
  isOwner: boolean;
  isAdmin: boolean;
  isPublicChannel: boolean;
}

/**
 * Read access guard:
 * - Missing chat -> 404
 * - Banned user -> 403 (even on public channels)
 * - Public channel (chat_type === 3 with non-empty username) -> readable by non-members
 * - Private channel (no username) and all other chats -> strictly requires active membership (403)
 */
export function ensureChatReadAccess(
  db: DatabaseSync,
  chatId: number,
  userId: number,
): ChatAccessContext {
  const chat = db
    .prepare(`SELECT chat_id, chat_type, creator_id, username FROM chats WHERE chat_id = ?`)
    .get(chatId) as
    | { chat_id: number; chat_type: number; creator_id: number; username: string | null }
    | undefined;
  if (!chat) {
    throw new ApiError(404, 'chat_not_found', `Chat ${chatId} not found`);
  }

  const mem = db
    .prepare(
      `SELECT role, admin_rights, banned_rights FROM chat_members WHERE chat_id = ? AND user_id = ?`,
    )
    .get(chatId, userId) as
    | { role: string; admin_rights: number; banned_rights: number }
    | undefined;

  if (mem?.role === 'banned') {
    throw new ApiError(403, 'banned_in_chat', 'You are banned from this chat');
  }

  const chatType = Number(chat.chat_type);
  const creatorId = Number(chat.creator_id);
  const username = chat.username && String(chat.username).trim().length > 0 ? String(chat.username).trim() : null;
  const isMember = Boolean(mem && !['banned', 'left', 'kicked'].includes(mem.role));
  const isOwner =
    isMember &&
    (mem!.role === 'owner' || (creatorId === userId && [1, 2, 3].includes(chatType)));
  const isAdmin = isOwner || (isMember && mem!.role === 'admin');
  const isPublicChannel = chatType === 3 && username !== null;

  if (!isMember && !isPublicChannel) {
    throw new ApiError(403, 'forbidden', 'You are not a member of this chat');
  }

  return {
    chatId: Number(chat.chat_id),
    chatType,
    creatorId,
    username,
    role: mem?.role ?? null,
    adminRights: Number(mem?.admin_rights ?? 0),
    bannedRights: Number(mem?.banned_rights ?? 0),
    isMember,
    isOwner,
    isAdmin,
    isPublicChannel,
  };
}

/**
 * Strict active membership guard (zero non-member bypass, even for public channels).
 */
export function ensureChatMembership(
  db: DatabaseSync,
  chatId: number,
  userId: number,
): ChatAccessContext {
  const access = ensureChatReadAccess(db, chatId, userId);
  if (!access.isMember) {
    throw new ApiError(403, 'forbidden', 'You are not a member of this chat');
  }
  return access;
}

/**
 * Write access guard:
 * - Requires active membership
 * - Channels (chat_type === 3) strictly require owner/admin role (403 for subscribers/non-members)
 * - Restricted users with bit 0x01 cannot send messages (403)
 * - Blocked 1-on-1 / secret chats return 403 user_is_blocked
 */
export function ensureChatWriteAccess(
  db: DatabaseSync,
  chatId: number,
  userId: number,
): ChatAccessContext {
  const access = ensureChatMembership(db, chatId, userId);
  if (access.chatType === 3 && !access.isAdmin) {
    throw new ApiError(
      403,
      'channel_write_forbidden',
      'Only channel owners or admins can post in this channel',
    );
  }
  if (access.role === 'restricted' && (access.bannedRights & 1) !== 0) {
    throw new ApiError(403, 'forbidden', 'You are restricted from sending messages in this chat');
  }
  if (access.chatType === 0 || access.chatType === 4) {
    const peer = db
      .prepare(`SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id != ? LIMIT 1`)
      .get(chatId, userId) as { user_id: number } | undefined;
    if (peer) {
      const peerId = Number(peer.user_id);
      const blocked = db
        .prepare(
          `SELECT 1 FROM user_blocks
           WHERE (owner_user_id = ? AND blocked_user_id = ?)
              OR (owner_user_id = ? AND blocked_user_id = ?)
           LIMIT 1`,
        )
        .get(userId, peerId, peerId, userId);
      if (blocked) {
        throw new ApiError(403, 'user_is_blocked', 'Cannot send messages in a blocked chat');
      }
    }
  }
  return access;
}

/**
 * Admin access guard for groups, supergroups, and channels (`chat_type in [1, 2, 3]`).
 */
export function ensureChatAdminAccess(
  db: DatabaseSync,
  chatId: number,
  userId: number,
): ChatAccessContext {
  const access = ensureChatMembership(db, chatId, userId);
  if ([1, 2, 3].includes(access.chatType) && !access.isAdmin) {
    throw new ApiError(403, 'admin_required', 'Only chat owners or admins can perform this action');
  }
  return access;
}

export function validateSendAsPeerId(
  db: DatabaseSync,
  userId: number,
  rawPeerId: unknown,
): number | undefined {
  const peerId = parseOptionalPositiveInt(
    rawPeerId,
    'invalid_send_as_peer',
    'send_as_peer_id must be a positive integer',
  );
  if (peerId === undefined) {
    return undefined;
  }
  if (peerId === userId) {
    return peerId;
  }
  let peerAccess: ChatAccessContext;
  try {
    peerAccess = ensureChatAdminAccess(db, peerId, userId);
  } catch {
    throw new ApiError(403, 'forbidden', 'You are not allowed to send as this peer');
  }
  if (peerAccess.chatType !== 3 || !peerAccess.isAdmin) {
    throw new ApiError(
      403,
      'forbidden',
      'send_as_peer_id must be your own user ID or a channel you administer',
    );
  }
  return peerId;
}

export function getChatMemberIds(db: DatabaseSync, chatId: number): number[] {
  const rows = db
    .prepare(
      `SELECT user_id FROM chat_members WHERE chat_id = ? AND role NOT IN ('banned', 'left', 'kicked')`,
    )
    .all(chatId) as Array<{ user_id: number }>;
  return rows.map((r) => Number(r.user_id));
}

export function purgeExpiredTtlMessages(db: DatabaseSync, chatId?: number): number[] {
  const now = Date.now();
  const expiredRows = (
    chatId !== undefined
      ? db
          .prepare(
            `SELECT chat_id, message_id FROM messages
             WHERE chat_id = ? AND deleted_for_everyone = 0 AND expires_at_ms IS NOT NULL AND expires_at_ms <= ?`,
          )
          .all(chatId, now)
      : db
          .prepare(
            `SELECT chat_id, message_id FROM messages
             WHERE deleted_for_everyone = 0 AND expires_at_ms IS NOT NULL AND expires_at_ms <= ?`,
          )
          .all(now)
  ) as Array<{ chat_id: number; message_id: number }>;

  if (expiredRows.length === 0) return [];
  const delStmt = db.prepare(
    `UPDATE messages
     SET deleted_for_everyone = 1,
         text_plain = '',
         content_json = '{"type":"Text","data":{"text":"","entities":[]}}',
         entities_json = '[]'
     WHERE chat_id = ? AND message_id = ?`,
  );
  const purgedIds: number[] = [];
  const touchedChats = new Set<number>();
  for (const r of expiredRows) {
    delStmt.run(r.chat_id, r.message_id);
    purgedIds.push(Number(r.message_id));
    touchedChats.add(Number(r.chat_id));
  }
  for (const cid of touchedChats) {
    refreshChatLastMessage(db, cid);
  }
  return purgedIds;
}

export function refreshChatLastMessage(db: DatabaseSync, chatId: number): void {
  const latest = db
    .prepare(
      `SELECT message_id, date_ms, text_plain, media_type
       FROM messages
       WHERE chat_id = ? AND deleted_for_everyone = 0
       ORDER BY message_id DESC
       LIMIT 1`,
    )
    .get(chatId) as
    | { message_id: number; date_ms: number; text_plain: string | null; media_type: string | null }
    | undefined;

  if (latest) {
    db.prepare(
      `UPDATE chats
       SET last_message_id = ?, last_message_date_ms = ?, last_message_preview = ?, last_message_media_type = ?
       WHERE chat_id = ?`,
    ).run(
      Number(latest.message_id),
      Number(latest.date_ms),
      String(latest.text_plain ?? '').slice(0, 140),
      latest.media_type ?? null,
      chatId,
    );
  } else {
    db.prepare(
      `UPDATE chats
       SET last_message_id = 0, last_message_date_ms = 0, last_message_preview = '', last_message_media_type = NULL
       WHERE chat_id = ?`,
    ).run(chatId);
  }
}

export function getChatDetailDto(
  db: DatabaseSync,
  chatId: number,
  viewerUserId: number,
): ChatDetailDto | null {
  purgeExpiredTtlMessages(db, chatId);
  const row = db.prepare(`SELECT * FROM chats WHERE chat_id = ?`).get(chatId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;

  const settings = db
    .prepare(`SELECT * FROM user_chat_settings WHERE user_id = ? AND chat_id = ?`)
    .get(viewerUserId, chatId) as Record<string, unknown> | undefined;

  const chatType = Number(row.chat_type);
  const kind = String(row.kind);

  // Resolve dynamic title & peer_user_id for 1-on-1 private chats from viewer's perspective
  let title = String(row.title);
  let peerUserId = row.peer_user_id ? Number(row.peer_user_id) : undefined;
  let username = (row.username as string | null) ?? undefined;
  let isBot = kind === 'bot';

  if (chatType === 0 && kind !== 'saved') {
    const otherMember = db
      .prepare(`SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id != ? LIMIT 1`)
      .get(chatId, viewerUserId) as { user_id: number } | undefined;
    const resolvedPeerId = otherMember ? Number(otherMember.user_id) : peerUserId;
    if (resolvedPeerId) {
      peerUserId = resolvedPeerId;
      const peerUser = getUserProfileDto(db, resolvedPeerId);
      if (peerUser) {
        title = [peerUser.first_name, peerUser.last_name].filter(Boolean).join(' ').trim() || title;
        username = peerUser.username ?? username;
        isBot = peerUser.is_bot;
      }
    }
  }

  const readInboxMaxId = settings ? Number(settings.read_inbox_max_id ?? 0) : 0;
  const readOutboxMaxId = settings ? Number(settings.read_outbox_max_id ?? 0) : 0;
  const clearedUpTo = settings ? Number(settings.cleared_up_to_msg_id ?? 0) : 0;
  const minUnreadId = Math.max(readInboxMaxId, clearedUpTo);

  const unreadRow = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM messages m
       WHERE m.chat_id = ?
         AND m.message_id > ?
         AND m.sender_id != ?
         AND m.deleted_for_everyone = 0
         AND NOT EXISTS (
           SELECT 1 FROM message_user_deletions d
           WHERE d.user_id = ? AND d.chat_id = m.chat_id AND d.message_id = m.message_id
         )`,
    )
    .get(chatId, minUnreadId, viewerUserId, viewerUserId) as { cnt: number };

  const memberCountRow = db
    .prepare(`SELECT COUNT(*) AS cnt FROM chat_members WHERE chat_id = ? AND role != 'banned'`)
    .get(chatId) as { cnt: number };

  const pinnedRows = db
    .prepare(`SELECT message_id FROM pinned_messages WHERE chat_id = ? ORDER BY pinned_at_ms DESC`)
    .all(chatId) as Array<{ message_id: number }>;
  const pinnedIds = pinnedRows.map((p) => Number(p.message_id));

  let draft: WireDraftDto | null = null;
  if (settings?.draft_json) {
    try {
      draft = JSON.parse(String(settings.draft_json)) as WireDraftDto;
    } catch {
      draft = null;
    }
  }

  let emojiFingerprint: string[] | undefined;
  if (row.emoji_fingerprint_json) {
    try {
      emojiFingerprint = JSON.parse(String(row.emoji_fingerprint_json)) as string[];
    } catch {
      emojiFingerprint = undefined;
    }
  }

  const unreadCount =
    Number(unreadRow.cnt) + (settings?.unread_mark && Number(unreadRow.cnt) === 0 ? 1 : 0);

  return {
    chat_id: chatId,
    title,
    kind,
    chat_type: chatType,
    creator_id: Number(row.creator_id),
    peer_user_id: peerUserId,
    username,
    about: (row.about as string | null) ?? undefined,
    photo_file_id: (row.photo_file_id as string | null) ?? undefined,
    is_group: chatType === 1 || chatType === 2,
    is_supergroup: chatType === 2,
    is_channel: chatType === 3,
    is_bot: isBot,
    is_forum: Boolean(row.is_forum),
    is_secret: chatType === 4,
    is_saved_messages: kind === 'saved',
    is_verified: Boolean(row.is_verified),
    is_archived: Boolean(settings?.is_archived),
    is_pinned: Boolean(settings?.is_pinned),
    is_muted: Boolean(settings?.is_muted),
    mute_until_ms: settings?.mute_until_ms ? Number(settings.mute_until_ms) : undefined,
    unread_mark: Boolean(settings?.unread_mark),
    folder_id: settings?.folder_id !== null && settings?.folder_id !== undefined ? Number(settings.folder_id) : null,
    pts: Number(row.pts),
    last_message_id: Number(row.last_message_id),
    last_message_date_ms: Number(row.last_message_date_ms),
    last_message_preview: (row.last_message_preview as string | null) ?? undefined,
    last_message_media_type: (row.last_message_media_type as string | null) ?? undefined,
    unread_count: unreadCount,
    read_inbox_max_id: readInboxMaxId,
    read_outbox_max_id: readOutboxMaxId,
    member_count: Math.max(1, Number(memberCountRow.cnt)),
    pinned_message_id: pinnedIds[0],
    pinned_message_ids: pinnedIds,
    draft,
    ttl_seconds: Number(row.ttl_seconds ?? 0),
    slow_mode_seconds: Number(row.slow_mode_seconds ?? 0),
    send_as_peer_id: settings?.send_as_peer_id ? Number(settings.send_as_peer_id) : undefined,
    emoji_fingerprint: emojiFingerprint,
  };
}

export function getMessageReactions(
  db: DatabaseSync,
  chatId: number,
  messageId: number,
  viewerUserId: number,
): { reactions: ReactionCount[]; details: ReactionDetail[] } {
  const rows = db
    .prepare(
      `SELECT emoji, user_id FROM message_reactions
       WHERE chat_id = ? AND message_id = ?
       ORDER BY created_at_ms ASC`,
    )
    .all(chatId, messageId) as Array<{ emoji: string; user_id: number }>;

  const grouped = new Map<string, number[]>();
  for (const r of rows) {
    const list = grouped.get(r.emoji) ?? [];
    list.push(Number(r.user_id));
    grouped.set(r.emoji, list);
  }

  const reactions: ReactionCount[] = [];
  const details: ReactionDetail[] = [];
  for (const [emoji, userIds] of grouped.entries()) {
    const chosen = userIds.includes(viewerUserId);
    reactions.push({
      emoji,
      count: userIds.length,
      is_chosen_by_me: chosen,
      chosen,
      user_ids: userIds,
    });
    details.push({
      emoji,
      count: userIds.length,
      chosen,
      user_ids: userIds,
    });
  }
  return { reactions, details };
}

export function hydrateMessageRow(
  db: DatabaseSync,
  row: Record<string, unknown>,
  viewerUserId: number,
): MessageItem {
  const chatId = Number(row.chat_id);
  const messageId = Number(row.message_id);
  const senderId = Number(row.sender_id);
  const dateMs = Number(row.date_ms);

  const content = JSON.parse(String(row.content_json)) as MessageContent;
  const wireEntities = row.entities_json
    ? (JSON.parse(String(row.entities_json)) as WireMessageEntity[])
    : [];
  const entities: MessageEntity[] = wireEntities.map(fromWireMessageEntity);
  const baseFlags = JSON.parse(String(row.flags_json)) as MessageFlags;
  const { reactions } = getMessageReactions(db, chatId, messageId, viewerUserId);

  const isPinnedRow = db
    .prepare(`SELECT 1 FROM pinned_messages WHERE chat_id = ? AND message_id = ?`)
    .get(chatId, messageId);

  const flags: MessageFlags = {
    ...baseFlags,
    is_out: senderId === viewerUserId,
    is_pinned: Boolean(isPinnedRow),
    is_edited: Boolean(baseFlags.is_edited || row.edit_date_ms),
    has_reactions: reactions.length > 0,
  };

  let replyTo: ReplyHeader | undefined;
  if (row.reply_to_json) {
    replyTo = JSON.parse(String(row.reply_to_json)) as ReplyHeader;
  }

  const forwardInfo = row.forward_info_json
    ? (JSON.parse(String(row.forward_info_json)) as MessageItem['forward_info'])
    : undefined;

  const inlineKeyboard = row.inline_keyboard_json
    ? (JSON.parse(String(row.inline_keyboard_json)) as MessageItem['inline_keyboard'])
    : undefined;

  const webPage = row.web_page_json
    ? (JSON.parse(String(row.web_page_json)) as WebPagePreview)
    : undefined;

  return {
    id: messageId,
    chat_id: chatId,
    peer_id: { User: senderId },
    to_peer: { Chat: chatId },
    sender_id: senderId,
    send_as_peer_id: row.send_as_peer_id ? Number(row.send_as_peer_id) : undefined,
    topic_id: row.topic_id !== null && row.topic_id !== undefined ? Number(row.topic_id) : undefined,
    flags,
    date: new Date(dateMs).toISOString(),
    date_ms: dateMs,
    edit_date: row.edit_date_ms ? new Date(Number(row.edit_date_ms)).toISOString() : undefined,
    isEdited: flags.is_edited,
    text: String(row.text_plain ?? safeExtractPlainTextFromContent(content)),
    entities,
    content,
    reply_to: replyTo,
    forward_info: forwardInfo,
    reactions,
    client_nonce: row.client_nonce !== null && row.client_nonce !== undefined ? Number(row.client_nonce) : undefined,
    inline_keyboard: inlineKeyboard,
    web_page: webPage,
    views: Number(row.views ?? 1),
    forwards: Number(row.forwards ?? 0),
    ttl_seconds: row.ttl_seconds !== null && row.ttl_seconds !== undefined ? Number(row.ttl_seconds) : undefined,
    expires_at_ms: row.expires_at_ms !== null && row.expires_at_ms !== undefined ? Number(row.expires_at_ms) : undefined,
    delivery_status: 'sent',
  };
}

export function getMessageById(
  db: DatabaseSync,
  chatId: number,
  messageId: number,
  viewerUserId: number,
): MessageItem | null {
  const row = db
    .prepare(
      `SELECT * FROM messages m
       WHERE m.chat_id = ? AND m.message_id = ? AND m.deleted_for_everyone = 0
         AND m.message_id > COALESCE(
           (SELECT ucs.cleared_up_to_msg_id FROM user_chat_settings ucs WHERE ucs.user_id = ? AND ucs.chat_id = m.chat_id),
           0
         )
         AND NOT EXISTS (
           SELECT 1 FROM message_user_deletions d
           WHERE d.user_id = ? AND d.chat_id = m.chat_id AND d.message_id = m.message_id
         )`,
    )
    .get(chatId, messageId, viewerUserId, viewerUserId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return hydrateMessageRow(db, row, viewerUserId);
}

// ============================================================================
// Genuine SSRF-Hardened OpenGraph Link Preview Fetching (Zero Fabrication)
// ============================================================================

export function extractFirstHttpUrl(text: string): string | null {
  const m = /https?:\/\/[^\s<>()]+/i.exec(text);
  if (!m) return null;
  const cleaned = m[0].replace(/[.,!?;:'"\]})>]+$/, '');
  return cleaned.length > 0 ? cleaned : null;
}

function isBlockedIpv4Octets(a: number, b: number, c: number, _d: number): boolean {
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local / cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24
  if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24 (6to4 relay anycast)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

function parseIpv6ToGroups(raw: string): Uint16Array | null {
  const lower = raw.toLowerCase();
  const doubleColonParts = lower.split('::');
  if (doubleColonParts.length > 2) return null;

  const parseSegmentList = (seg: string): number[] | null => {
    if (!seg) return [];
    const tokens = seg.split(':');
    const out: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i]!;
      if (tok.includes('.')) {
        if (i !== tokens.length - 1) return null;
        const octets = tok.split('.').map((p) => Number.parseInt(p, 10));
        if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
          return null;
        }
        out.push(((octets[0]! << 8) | octets[1]!) >>> 0);
        out.push(((octets[2]! << 8) | octets[3]!) >>> 0);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(tok)) return null;
        out.push(Number.parseInt(tok, 16));
      }
    }
    return out;
  };

  const left = parseSegmentList(doubleColonParts[0] ?? '');
  if (!left) return null;

  if (doubleColonParts.length === 1) {
    if (left.length !== 8) return null;
    return Uint16Array.from(left);
  }

  const right = parseSegmentList(doubleColonParts[1] ?? '');
  if (!right) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;

  const groups = new Uint16Array(8);
  for (let i = 0; i < left.length; i++) groups[i] = left[i]!;
  for (let i = 0; i < right.length; i++) groups[left.length + missing + i] = right[i]!;
  return groups;
}

/**
 * Strictly fail-closed IPv4/IPv6 SSRF address filter.
 * Blocks all loopback, private, CGNAT, link-local, metadata, ULA, NAT64, multicast,
 * documentation, IPv4-mapped IPv6, and unparseable addresses.
 */
export function isBlockedIpAddress(rawIp: string): boolean {
  let ip = rawIp.trim();
  if (ip.startsWith('[') && ip.endsWith(']')) {
    ip = ip.slice(1, -1);
  }
  const zoneIdx = ip.indexOf('%');
  if (zoneIdx !== -1) {
    ip = ip.slice(0, zoneIdx);
  }
  const family = net.isIP(ip);
  if (family === 0) return true;

  if (family === 4) {
    const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return true;
    }
    return isBlockedIpv4Octets(parts[0]!, parts[1]!, parts[2]!, parts[3]!);
  }

  const g = parseIpv6ToGroups(ip);
  if (!g) return true;

  const g0 = g[0]!;
  const g1 = g[1]!;
  const g2 = g[2]!;
  const g3 = g[3]!;
  const g4 = g[4]!;
  const g5 = g[5]!;
  const g6 = g[6]!;
  const g7 = g[7]!;

  // ::/128, ::1/128, IPv4-compatible ::/96
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return true;
  }
  // IPv4-mapped IPv6 ::ffff:0:0/96 -> validate embedded IPv4
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isBlockedIpv4Octets(g6 >>> 8, g6 & 0xff, g7 >>> 8, g7 & 0xff);
  }
  // IPv4-translated ::ffff:0:0:0/96
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) {
    return true;
  }
  // NAT64 well-known & local-use prefixes 64:ff9b::/96, 64:ff9b:1::/48
  if (g0 === 0x0064 && g1 === 0xff9b) {
    return true;
  }
  // Discard 100::/64
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) {
    return true;
  }
  // Teredo 2001::/32
  if (g0 === 0x2001 && g1 === 0x0000) {
    return true;
  }
  // Documentation 2001:db8::/32
  if (g0 === 0x2001 && g1 === 0x0db8) {
    return true;
  }
  // 6to4 2002::/16
  if (g0 === 0x2002) {
    return true;
  }
  // Unique Local fc00::/7
  if ((g0 & 0xfe00) === 0xfc00) {
    return true;
  }
  // Link-local fe80::/10 & deprecated site-local fec0::/10
  if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0) {
    return true;
  }
  // Multicast ff00::/8
  if ((g0 & 0xff00) === 0xff00) {
    return true;
  }
  return false;
}

function isBlockedHostname(rawHostname: string): boolean {
  const host = rawHostname.trim().toLowerCase().replace(/\.+$/, '');
  if (!host) return true;
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata.google.internal'
  ) {
    return true;
  }
  return false;
}

function decodeHtmlEntities(input: string): string {
  return input.replace(
    /&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp);/gi,
    (_match, entity: string) => {
      const lower = entity.toLowerCase();
      switch (lower) {
        case 'amp':
          return '&';
        case 'lt':
          return '<';
        case 'gt':
          return '>';
        case 'quot':
          return '"';
        case 'apos':
          return "'";
        case 'nbsp':
          return ' ';
        default: {
          if (lower.startsWith('#x')) {
            const code = Number.parseInt(lower.slice(2), 16);
            return Number.isFinite(code) &&
              code > 0 &&
              code <= 0x10ffff &&
              (code < 0xd800 || code > 0xdfff)
              ? String.fromCodePoint(code)
              : '';
          }
          if (lower.startsWith('#')) {
            const code = Number.parseInt(lower.slice(1), 10);
            return Number.isFinite(code) &&
              code > 0 &&
              code <= 0x10ffff &&
              (code < 0xd800 || code > 0xdfff)
              ? String.fromCodePoint(code)
              : '';
          }
          return _match;
        }
      }
    },
  );
}

function parseHtmlAttributes(tagInner: string): Record<string, string> {
  const attrs: Record<string, string> = Object.create(null) as Record<string, string>;
  const attrRe = /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(tagInner)) !== null) {
    const key = m[1]!.toLowerCase();
    const val = m[2] ?? m[3] ?? m[4] ?? '';
    attrs[key] = val;
  }
  return attrs;
}

function parseOpenGraphFromHtml(html: string, finalUrl: URL): WebPagePreview | undefined {
  const metaByKey = new Map<string, string>();
  const metaRe = /<meta\b([^>]{1,4096})>/gi;
  let match: RegExpExecArray | null;
  while ((match = metaRe.exec(html)) !== null) {
    const attrs = parseHtmlAttributes(match[1]!);
    const key = (attrs.property ?? attrs.name ?? '').trim().toLowerCase();
    const content = attrs.content?.trim();
    if (key && content && !metaByKey.has(key)) {
      metaByKey.set(key, decodeHtmlEntities(content));
    }
  }

  let htmlTitle = '';
  const titleMatch = /<title\b[^>]*>([\s\S]{1,1024}?)<\/title>/i.exec(html);
  if (titleMatch?.[1]) {
    htmlTitle = decodeHtmlEntities(titleMatch[1]).replace(/\s+/g, ' ').trim();
  }

  const rawTitle = (
    metaByKey.get('og:title') ??
    metaByKey.get('twitter:title') ??
    htmlTitle
  )
    .replace(/\s+/g, ' ')
    .trim();
  const rawDescription = (
    metaByKey.get('og:description') ??
    metaByKey.get('twitter:description') ??
    metaByKey.get('description') ??
    ''
  )
    .replace(/\s+/g, ' ')
    .trim();

  // Zero-fabrication invariant: if neither genuine title nor description was found, return undefined!
  if (!rawTitle && !rawDescription) {
    return undefined;
  }

  const rawSiteName = (metaByKey.get('og:site_name') ?? finalUrl.hostname)
    .replace(/\s+/g, ' ')
    .trim();

  const title = rawTitle ? rawTitle.slice(0, 200) : undefined;
  const description = rawDescription ? rawDescription.slice(0, 400) : undefined;
  const siteName = rawSiteName ? rawSiteName.slice(0, 120) : finalUrl.hostname;
  const displayPath = finalUrl.pathname === '/' ? '' : finalUrl.pathname;

  return {
    url: finalUrl.toString(),
    display_url: `${finalUrl.host}${displayPath}`,
    site_name: siteName,
    title,
    description,
    instant_view_available: false,
  };
}

export interface OpenGraphHttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string | Buffer | AsyncIterable<Buffer | string>;
}

export interface OpenGraphFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
  lookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  requestImpl?: (params: {
    url: URL;
    resolvedAddress: string;
    resolvedFamily: number;
    headers: Record<string, string>;
    signal: AbortSignal;
  }) => Promise<OpenGraphHttpResponse>;
}

async function defaultPinnedOpenGraphRequest(params: {
  url: URL;
  resolvedAddress: string;
  resolvedFamily: number;
  headers: Record<string, string>;
  signal: AbortSignal;
}): Promise<OpenGraphHttpResponse> {
  const { url, resolvedAddress, resolvedFamily, headers, signal } = params;
  const isHttps = url.protocol === 'https:';
  const port = url.port ? Number(url.port) : isHttps ? 443 : 80;
  const pinnedLookup = (
    _hostname: string,
    optsOrCb: unknown,
    maybeCb?: (
      err: NodeJS.ErrnoException | null,
      address: string | dns.LookupAddress[],
      family?: number,
    ) => void,
  ) => {
    const cb =
      typeof optsOrCb === 'function'
        ? (optsOrCb as (
            err: NodeJS.ErrnoException | null,
            address: string | dns.LookupAddress[],
            family?: number,
          ) => void)
        : maybeCb!;
    const wantsAll =
      typeof optsOrCb === 'object' &&
      optsOrCb !== null &&
      Boolean((optsOrCb as { all?: boolean }).all);
    if (wantsAll) {
      cb(null, [{ address: resolvedAddress, family: resolvedFamily }]);
    } else {
      cb(null, resolvedAddress, resolvedFamily);
    }
  };

  return new Promise<OpenGraphHttpResponse>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('OpenGraph fetch aborted'));
      return;
    }
    const rawHost = url.hostname.replace(/^\[|\]$/g, '');
    const req = (isHttps ? https.request : http.request)(
      {
        protocol: url.protocol,
        hostname: rawHost,
        port,
        method: 'GET',
        path: `${url.pathname}${url.search}`,
        agent: false,
        headers: {
          ...headers,
          Host: url.host,
        },
        lookup: pinnedLookup as unknown as http.RequestOptions['lookup'],
        ...(isHttps ? { servername: net.isIP(rawHost) === 0 ? rawHost : undefined } : {}),
      },
      (res) => {
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body: res,
        });
      },
    );

    const onAbort = () => {
      req.destroy(new Error('OpenGraph fetch aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    req.on('close', () => {
      signal.removeEventListener('abort', onAbort);
    });
    req.on('error', (err) => {
      signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    req.end();
  });
}

async function readBoundedHtmlFromResponse(
  body: OpenGraphHttpResponse['body'],
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  if (typeof body === 'string') {
    const buf = Buffer.from(body, 'utf8');
    return buf.subarray(0, maxBytes).toString('utf8');
  }
  if (Buffer.isBuffer(body)) {
    return body.subarray(0, maxBytes).toString('utf8');
  }

  const chunks: Buffer[] = [];
  let total = 0;
  let prevTail = '';
  try {
    for await (const rawChunk of body) {
      if (signal.aborted) break;
      const buf = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk, 'utf8');
      const remaining = maxBytes - total;
      if (remaining <= 0) break;
      const slice = buf.length > remaining ? buf.subarray(0, remaining) : buf;
      chunks.push(slice);
      total += slice.length;

      // Linear-time overlap scan for </head> (avoids O(N^2) Buffer.concat per chunk)
      const windowStr = prevTail + slice.toString('latin1');
      const hitHeadEnd = /<\/head>/i.test(windowStr);
      prevTail = windowStr.length > 7 ? windowStr.slice(-7) : windowStr;

      if (hitHeadEnd || total >= maxBytes) {
        if ('destroy' in body && typeof (body as { destroy?: () => void }).destroy === 'function') {
          (body as { destroy: () => void }).destroy();
        }
        break;
      }
    }
  } catch {
    // Return partial head if already captured, otherwise empty
  }
  return chunks.length === 0 ? '' : Buffer.concat(chunks, total).toString('utf8');
}

/**
 * Fetches genuine OpenGraph HTML metadata with strict SSRF protection:
 * - Only `http:` / `https:` schemes, no embedded credentials
 * - Blocks localhost / `.local` / `.internal` and all private/reserved IPv4 & IPv6 ranges
 * - Resolves DNS and validates EVERY returned IP before connecting via an IP-pinned socket
 * - Re-validates every manual redirect hop (max 3)
 * - Enforces timeout, `text/html` content-type, and max byte cap
 * - NEVER fabricates titles, descriptions, or synthetic reader preview blocks
 */
export async function fetchOpenGraphPreview(
  textOrUrl: string,
  options: OpenGraphFetchOptions = {},
): Promise<WebPagePreview | undefined> {
  const extracted = extractFirstHttpUrl(textOrUrl);
  if (!extracted) return undefined;

  const timeoutMs = options.timeoutMs ?? 2500;
  const maxBytes = options.maxBytes ?? 256 * 1024;
  const maxRedirects = options.maxRedirects ?? 3;
  const lookupFn =
    options.lookup ??
    (async (hostname: string) => {
      const addrs = await dns.promises.lookup(hostname, { all: true, verbatim: true });
      return addrs.map((a) => ({ address: a.address, family: a.family }));
    });
  const requestFn = options.requestImpl ?? defaultPinnedOpenGraphRequest;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const onExternalAbort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) {
      clearTimeout(timer);
      return undefined;
    }
    options.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    let currentUrlStr = extracted;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      if (controller.signal.aborted) return undefined;

      let parsed: URL;
      try {
        parsed = new URL(currentUrlStr);
      } catch {
        return undefined;
      }

      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return undefined;
      }
      if (parsed.username || parsed.password) {
        return undefined;
      }

      const rawHost = parsed.hostname.replace(/^\[|\]$/g, '');
      if (isBlockedHostname(rawHost)) {
        return undefined;
      }

      let resolvedAddress: string;
      let resolvedFamily: number;
      const literalFamily = net.isIP(rawHost);
      if (literalFamily !== 0) {
        if (isBlockedIpAddress(rawHost)) {
          return undefined;
        }
        resolvedAddress = rawHost;
        resolvedFamily = literalFamily;
      } else {
        let addresses: Array<{ address: string; family: number }>;
        try {
          addresses = await lookupFn(rawHost);
        } catch {
          return undefined;
        }
        if (!addresses || addresses.length === 0) {
          return undefined;
        }
        for (const entry of addresses) {
          if (isBlockedIpAddress(entry.address)) {
            return undefined;
          }
        }
        resolvedAddress = addresses[0]!.address;
        resolvedFamily = addresses[0]!.family || net.isIP(resolvedAddress) || 4;
      }

      const response = await requestFn({
        url: parsed,
        resolvedAddress,
        resolvedFamily,
        headers: {
          'User-Agent': 'FabushiWeb-LinkPreview/1.6.11',
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
          'Accept-Encoding': 'identity',
        },
        signal: controller.signal,
      });

      const status = response.statusCode;
      if ([301, 302, 303, 307, 308].includes(status)) {
        if (
          typeof response.body === 'object' &&
          response.body !== null &&
          'destroy' in response.body &&
          typeof (response.body as { destroy?: () => void }).destroy === 'function'
        ) {
          (response.body as { destroy: () => void }).destroy();
        }
        if (hop === maxRedirects) {
          return undefined;
        }
        const rawLoc = response.headers.location;
        const location = Array.isArray(rawLoc) ? rawLoc[0] : rawLoc;
        if (!location || !location.trim()) {
          return undefined;
        }
        try {
          currentUrlStr = new URL(location.trim(), parsed).toString();
        } catch {
          return undefined;
        }
        continue;
      }

      if (status < 200 || status >= 300) {
        if (
          typeof response.body === 'object' &&
          response.body !== null &&
          'destroy' in response.body &&
          typeof (response.body as { destroy?: () => void }).destroy === 'function'
        ) {
          (response.body as { destroy: () => void }).destroy();
        }
        return undefined;
      }

      const rawCt = response.headers['content-type'];
      const ct = (Array.isArray(rawCt) ? rawCt[0] : rawCt ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      if (ct !== 'text/html' && ct !== 'application/xhtml+xml') {
        if (
          typeof response.body === 'object' &&
          response.body !== null &&
          'destroy' in response.body &&
          typeof (response.body as { destroy?: () => void }).destroy === 'function'
        ) {
          (response.body as { destroy: () => void }).destroy();
        }
        return undefined;
      }

      const html = await readBoundedHtmlFromResponse(response.body, maxBytes, controller.signal);
      if (!html) return undefined;
      return parseOpenGraphFromHtml(html, parsed);
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * Post-commit asynchronous OpenGraph enrichment for newly created text messages containing HTTP(S) URLs.
 * Never blocks message creation, never fabricates previews, and aborts cleanly during server shutdown.
 */
export function enrichMessageWebPageAsync(
  db: DatabaseSync,
  sink: PtsBroadcastSink | null,
  chatId: number,
  messageId: number,
  plainText: string,
  signal?: AbortSignal,
): void {
  if (signal?.aborted || !extractFirstHttpUrl(plainText)) {
    return;
  }
  void (async () => {
    try {
      const preview = await fetchOpenGraphPreview(plainText, { signal });
      if (!preview || signal?.aborted) return;

      const existing = db
        .prepare(
          `SELECT sender_id, deleted_for_everyone, web_page_json FROM messages WHERE chat_id = ? AND message_id = ?`,
        )
        .get(chatId, messageId) as
        | { sender_id: number; deleted_for_everyone: number; web_page_json: string | null }
        | undefined;
      if (!existing || existing.deleted_for_everyone || existing.web_page_json !== null) {
        return;
      }

      db.prepare(`UPDATE messages SET web_page_json = ? WHERE chat_id = ? AND message_id = ?`).run(
        JSON.stringify(preview),
        chatId,
        messageId,
      );
      const updated = getMessageById(db, chatId, messageId, Number(existing.sender_id));
      if (updated) {
        commitPtsEventAtomic(db, sink, chatId, {
          type: 'EditMessage',
          data: updated,
        });
      }
    } catch {
      // Swallow teardown/network errors cleanly
    }
  })();
}

export interface CreateMessageParams {
  chatId: number;
  senderId: number;
  sendAsPeerId?: number;
  text?: string;
  entities?: Array<MessageEntity | WireMessageEntity>;
  parseMarkdown?: boolean;
  content?: MessageContent;
  webPage?: WebPagePreview;
  replyToMsgId?: number;
  quoteText?: string;
  forwardInfo?: MessageItem['forward_info'];
  topicId?: number;
  clientNonce?: number;
  silent?: boolean;
  scheduleAtMs?: number;
  ttlSeconds?: number;
  inlineKeyboard?: MessageItem['inline_keyboard'];
}

export interface PtsBroadcastSink {
  broadcastChatPtsUpdate(chatId: number, ptsUpdate: PtsUpdate): void;
  broadcastChatEphemeral(chatId: number, event: UpdateEvent, excludeUserId?: number): void;
  sendToUser(userId: number, frame: unknown): void;
}

/**
 * Atomically persists a message (honoring `(user_id, client_nonce)` idempotent deduplication!),
 * advances `chats.pts` by 1, appends to `pts_events`, and broadcasts `PtsPush`.
 */
export function createMessageAtomic(
  db: DatabaseSync,
  sink: PtsBroadcastSink | null,
  params: CreateMessageParams,
): { message: MessageItem; pts: number; duplicate: boolean } {
  const now = Date.now();
  const scheduleAtMs = parseOptionalNonNegativeInt(
    params.scheduleAtMs,
    'invalid_schedule_time',
    'schedule_at_ms must be a non-negative integer',
  );
  if (scheduleAtMs !== undefined && scheduleAtMs < now - 5000) {
    throw new ApiError(400, 'invalid_schedule_time', 'Scheduled timestamp cannot be in the past');
  }
  const topicId = parseOptionalPositiveInt(
    params.topicId,
    'invalid_topic_id',
    'topic_id must be a positive integer',
  );
  const replyToMsgId = parseOptionalPositiveInt(
    params.replyToMsgId,
    'invalid_reply_to',
    'reply_to_msg_id must be a positive integer',
  );
  const ttlSeconds = parseOptionalNonNegativeInt(
    params.ttlSeconds,
    'invalid_ttl',
    'ttl_seconds must be a non-negative integer',
  );
  if (params.text !== undefined && params.text !== null && typeof params.text !== 'string') {
    throw new ApiError(400, 'invalid_text', 'Message text must be a string');
  }
  if (
    params.quoteText !== undefined &&
    params.quoteText !== null &&
    typeof params.quoteText !== 'string'
  ) {
    throw new ApiError(400, 'invalid_quote_text', 'quote_text must be a string');
  }
  if (
    params.entities !== undefined &&
    params.entities !== null &&
    !Array.isArray(params.entities)
  ) {
    throw new ApiError(400, 'invalid_entities', 'entities must be an array');
  }

  const chatRow = db
    .prepare(`SELECT chat_id, chat_type, pts, next_msg_id, ttl_seconds FROM chats WHERE chat_id = ?`)
    .get(params.chatId) as
    | { chat_id: number; chat_type: number; pts: number; next_msg_id: number; ttl_seconds: number }
    | undefined;
  if (!chatRow) {
    throw new ApiError(404, 'chat_not_found', `Chat ${params.chatId} does not exist`);
  }

  let content: MessageContent;
  let wireEntities: WireMessageEntity[] = [];
  let plainText = '';

  if (params.content !== undefined && params.content !== null) {
    content = validateWireMessageContent(params.content);
    if (content.type === 'Text') {
      plainText = content.data.text;
      wireEntities = Array.isArray(content.data.entities)
        ? content.data.entities.map((e) => toWireMessageEntity(fromWireMessageEntity(e)))
        : [];
    } else {
      plainText =
        typeof params.text === 'string' ? params.text : safeExtractPlainTextFromContent(content);
    }
  } else {
    const rawText = params.text ?? '';
    if (!rawText.trim()) {
      throw new ApiError(400, 'empty_message', 'Message text or media content is required');
    }
    if (params.entities && params.entities.length > 0) {
      plainText = rawText;
      wireEntities = params.entities.map((e) => toWireMessageEntity(fromWireMessageEntity(e)));
    } else if (params.parseMarkdown !== false) {
      const parsed = parseMarkdownEntities(rawText);
      plainText = parsed.text;
      wireEntities = parsed.entities.map(toWireMessageEntity);
    } else {
      plainText = rawText;
    }
    content = {
      type: 'Text',
      data: {
        text: plainText,
        entities: wireEntities,
      },
    };
  }

  // 1. Check idempotent `(senderId, clientNonce)` outbox deduplication BEFORE mutating state
  if (params.clientNonce !== undefined && Number.isFinite(params.clientNonce)) {
    const existingDedup = db
      .prepare(
        `SELECT chat_id, message_id, pts FROM outbox_dedup WHERE user_id = ? AND client_nonce = ?`,
      )
      .get(params.senderId, Math.trunc(params.clientNonce)) as
      | { chat_id: number; message_id: number; pts: number }
      | undefined;

    if (existingDedup) {
      if (Number(existingDedup.chat_id) !== params.chatId) {
        throw new ApiError(
          409,
          'nonce_conflict',
          'client_nonce was already used in another chat',
        );
      }
      const existingMsg = getMessageById(
        db,
        Number(existingDedup.chat_id),
        Number(existingDedup.message_id),
        params.senderId,
      );
      if (existingMsg) {
        const payloadMismatch =
          existingMsg.content.type !== content.type ||
          (content.type === 'Text' && (existingMsg.text ?? '') !== plainText);
        if (payloadMismatch) {
          throw new ApiError(
            409,
            'nonce_conflict',
            'client_nonce conflict with different message payload',
          );
        }
        return {
          message: existingMsg,
          pts: Number(existingDedup.pts),
          duplicate: true,
        };
      }
    }
  }

  const mediaType = classifyMessageMediaType(content, plainText);

  const webPage = params.webPage;

  let replyHeader: ReplyHeader | undefined;
  if (replyToMsgId !== undefined) {
    const targetRow = db
      .prepare(`SELECT sender_id, text_plain FROM messages WHERE chat_id = ? AND message_id = ?`)
      .get(params.chatId, replyToMsgId) as { sender_id: number; text_plain: string } | undefined;
    const senderDto = targetRow ? getUserProfileDto(db, Number(targetRow.sender_id)) : null;
    replyHeader = {
      reply_to_msg_id: replyToMsgId,
      quote_text: params.quoteText,
      sender_name: senderDto ? [senderDto.first_name, senderDto.last_name].filter(Boolean).join(' ') : undefined,
      preview_text: targetRow?.text_plain?.slice(0, 100),
    };
  }

  const effectiveTtl =
    ttlSeconds !== undefined
      ? ttlSeconds
      : Number(chatRow.ttl_seconds) > 0
        ? Number(chatRow.ttl_seconds)
        : undefined;
  const expiresAtMs =
    effectiveTtl && effectiveTtl > 0 ? now + effectiveTtl * 1000 : undefined;

  const nextPts = Number(chatRow.pts) + 1;
  const flags: MessageFlags = {
    is_out: true,
    is_pinned: false,
    is_silent: Boolean(params.silent),
    is_edited: false,
    is_scheduled: Boolean(scheduleAtMs),
    media_unread: content.type === 'Voice' || content.type === 'VideoNote',
    has_reactions: false,
    no_forwards: false,
    is_forwarded: Boolean(params.forwardInfo),
    is_post: Number(chatRow.chat_type) === 3,
  };

  db.exec('BEGIN IMMEDIATE;');
  let msgId = Number(chatRow.next_msg_id);
  try {
    const maxMsgRow = db
      .prepare(`SELECT COALESCE(MAX(message_id), 0) AS max_id FROM messages`)
      .get() as { max_id: number } | undefined;
    msgId = Math.max(msgId, Number(maxMsgRow?.max_id ?? 0) + 1);
    db.prepare(`
      INSERT INTO messages (
        chat_id, message_id, sender_id, send_as_peer_id, topic_id, date_ms,
        text_plain, media_type, content_json, entities_json, reply_to_json,
        forward_info_json, inline_keyboard_json, web_page_json, flags_json,
        views, forwards, ttl_seconds, expires_at_ms, client_nonce
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)
    `).run(
      params.chatId,
      msgId,
      params.senderId,
      params.sendAsPeerId ?? null,
      topicId ?? null,
      now,
      plainText,
      mediaType,
      JSON.stringify(content),
      JSON.stringify(wireEntities),
      replyHeader ? JSON.stringify(replyHeader) : null,
      params.forwardInfo ? JSON.stringify(params.forwardInfo) : null,
      params.inlineKeyboard ? JSON.stringify(params.inlineKeyboard) : null,
      webPage ? JSON.stringify(webPage) : null,
      JSON.stringify(flags),
      effectiveTtl ?? null,
      expiresAtMs ?? null,
      params.clientNonce !== undefined ? Math.trunc(params.clientNonce) : null,
    );

    db.prepare(`
      UPDATE chats
      SET pts = ?, next_msg_id = ?, last_message_id = ?, last_message_date_ms = ?,
          last_message_preview = ?, last_message_media_type = ?
      WHERE chat_id = ?
    `).run(
      nextPts,
      msgId + 1,
      msgId,
      now,
      plainText.slice(0, 140),
      mediaType,
      params.chatId,
    );

    // Advance sender's own read_inbox_max_id / read_outbox_max_id
    db.prepare(`
      INSERT INTO user_chat_settings (user_id, chat_id, read_inbox_max_id, read_outbox_max_id)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, chat_id) DO UPDATE SET
        read_inbox_max_id = MAX(read_inbox_max_id, excluded.read_inbox_max_id),
        read_outbox_max_id = MAX(read_outbox_max_id, excluded.read_outbox_max_id),
        draft_json = NULL
    `).run(params.senderId, params.chatId, msgId, msgId);

    if (topicId) {
      db.prepare(
        `UPDATE forum_topics SET last_message_id = ? WHERE chat_id = ? AND topic_id = ?`,
      ).run(msgId, params.chatId, topicId);
    }

    if (params.clientNonce !== undefined && Number.isFinite(params.clientNonce)) {
      db.prepare(`
        INSERT OR REPLACE INTO outbox_dedup (user_id, client_nonce, chat_id, message_id, pts, created_at_ms)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(params.senderId, Math.trunc(params.clientNonce), params.chatId, msgId, nextPts, now);
    }

    const insertedRow = db
      .prepare(`SELECT * FROM messages WHERE chat_id = ? AND message_id = ?`)
      .get(params.chatId, msgId) as Record<string, unknown>;
    const hydrated = hydrateMessageRow(db, insertedRow, params.senderId);

    const updateEvent: UpdateEvent = {
      type: 'NewMessage',
      data: hydrated,
    };

    db.prepare(`
      INSERT INTO pts_events (chat_id, pts, pts_count, created_at_ms, event_json)
      VALUES (?, ?, 1, ?, ?)
    `).run(params.chatId, nextPts, now, JSON.stringify(updateEvent));

    db.exec('COMMIT;');

    const ptsUpdate: PtsUpdate = {
      chat_id: params.chatId,
      pts: nextPts,
      pts_count: 1,
      event: updateEvent,
      timestamp_ms: now,
      date: new Date(now).toISOString(),
    };
    sink?.broadcastChatPtsUpdate(params.chatId, ptsUpdate);

    return {
      message: hydrated,
      pts: nextPts,
      duplicate: false,
    };
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

/**
 * Commits a non-message PTS mutation (`EditMessage`, `DeleteMessages`, `ReactionUpdated`,
 * `PinnedMessagesChanged`, `PollUpdated`, `TodoUpdated`, `ReadHistory`, etc.) inside a transaction.
 */
export function commitPtsEventAtomic(
  db: DatabaseSync,
  sink: PtsBroadcastSink | null,
  chatId: number,
  event: UpdateEvent,
): PtsUpdate {
  const now = Date.now();
  db.exec('BEGIN IMMEDIATE;');
  try {
    const chatRow = db.prepare(`SELECT pts FROM chats WHERE chat_id = ?`).get(chatId) as
      | { pts: number }
      | undefined;
    if (!chatRow) {
      throw new ApiError(404, 'chat_not_found', `Chat ${chatId} not found`);
    }
    const nextPts = Number(chatRow.pts) + 1;
    db.prepare(`UPDATE chats SET pts = ? WHERE chat_id = ?`).run(nextPts, chatId);
    db.prepare(
      `INSERT INTO pts_events (chat_id, pts, pts_count, created_at_ms, event_json) VALUES (?, ?, 1, ?, ?)`,
    ).run(chatId, nextPts, now, JSON.stringify(event));
    db.exec('COMMIT;');

    const ptsUpdate: PtsUpdate = {
      chat_id: chatId,
      pts: nextPts,
      pts_count: 1,
      event,
      timestamp_ms: now,
      date: new Date(now).toISOString(),
    };
    sink?.broadcastChatPtsUpdate(chatId, ptsUpdate);
    return ptsUpdate;
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

export function classifyMessageMediaType(
  content: MessageContent,
  plainText: string,
): string | null {
  const contentType =
    content && typeof content === 'object' && typeof content.type === 'string'
      ? content.type
      : '';
  if (!contentType) {
    return null;
  }
  const safeText = typeof plainText === 'string' ? plainText : '';
  if (contentType === 'Text') {
    return safeText.includes('http://') || safeText.includes('https://') ? 'links' : null;
  }
  if (contentType === 'Media') {
    const rawMime =
      content.data && typeof content.data === 'object'
        ? (content.data as { mime_type?: unknown }).mime_type
        : undefined;
    const mime = typeof rawMime === 'string' ? rawMime.toLowerCase() : '';
    if (mime === 'image/gif') return 'gif';
    if (mime.startsWith('image/')) return 'photo';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    return 'document';
  }
  return contentType.toLowerCase();
}

export function editMessageAtomic(
  db: DatabaseSync,
  sink: PtsBroadcastSink | null,
  params: {
    chatId: number;
    messageId: number;
    editorUserId: number;
    text?: string;
    entities?: Array<MessageEntity | WireMessageEntity>;
    content?: MessageContent;
  },
): { message: MessageItem; pts: number } {
  if (params.text !== undefined && params.text !== null && typeof params.text !== 'string') {
    throw new ApiError(400, 'invalid_text', 'Edited text must be a string');
  }
  if (
    params.entities !== undefined &&
    params.entities !== null &&
    !Array.isArray(params.entities)
  ) {
    throw new ApiError(400, 'invalid_entities', 'entities must be an array');
  }

  const access = ensureChatWriteAccess(db, params.chatId, params.editorUserId);
  const existing = getMessageById(db, params.chatId, params.messageId, params.editorUserId);
  if (!existing) {
    throw new ApiError(404, 'message_not_found', 'Message not found');
  }
  if (access.chatType !== 3 && existing.sender_id !== params.editorUserId) {
    throw new ApiError(403, 'forbidden', 'Only the message author can edit this message');
  }

  let plainText = existing.text ?? '';
  let wireEntities: WireMessageEntity[] = (existing.entities ?? []).map(toWireMessageEntity);
  let newContent: MessageContent = existing.content;

  if (params.content !== undefined && params.content !== null) {
    newContent = validateWireMessageContent(params.content);
    if (newContent.type === 'Text') {
      plainText = newContent.data.text;
      wireEntities = Array.isArray(newContent.data.entities)
        ? newContent.data.entities.map((e) => toWireMessageEntity(fromWireMessageEntity(e)))
        : [];
    } else {
      plainText =
        typeof params.text === 'string'
          ? params.text
          : safeExtractPlainTextFromContent(newContent);
    }
  } else if (params.text !== undefined) {
    if (!params.text.trim()) {
      throw new ApiError(400, 'empty_message', 'Edited text cannot be empty');
    }
    if (params.entities) {
      plainText = params.text;
      wireEntities = params.entities.map((e) => toWireMessageEntity(fromWireMessageEntity(e)));
    } else {
      const parsed = parseMarkdownEntities(params.text);
      plainText = parsed.text;
      wireEntities = parsed.entities.map(toWireMessageEntity);
    }
    newContent = {
      type: 'Text',
      data: { text: plainText, entities: wireEntities },
    };
  }

  const now = Date.now();
  const updatedFlags = { ...existing.flags, is_edited: true };
  const mediaType = classifyMessageMediaType(newContent, plainText);

  db.prepare(
    `UPDATE messages
     SET text_plain = ?, media_type = ?, content_json = ?, entities_json = ?, edit_date_ms = ?, flags_json = ?
     WHERE chat_id = ? AND message_id = ?`,
  ).run(
    plainText,
    mediaType,
    JSON.stringify(newContent),
    JSON.stringify(wireEntities),
    now,
    JSON.stringify(updatedFlags),
    params.chatId,
    params.messageId,
  );

  refreshChatLastMessage(db, params.chatId);

  const updated = getMessageById(db, params.chatId, params.messageId, params.editorUserId)!;
  const ptsUpdate = commitPtsEventAtomic(db, sink, params.chatId, {
    type: 'EditMessage',
    data: updated,
  });
  return { message: updated, pts: ptsUpdate.pts };
}

export function deleteMessagesAtomic(
  db: DatabaseSync,
  sink: PtsBroadcastSink | null,
  chatId: number,
  userId: number,
  messageIds: number[],
  forEveryone: boolean,
): { pts: number; deletedIds: number[]; tombstone: DeleteTombstone } {
  const access = ensureChatMembership(db, chatId, userId);
  if (access.chatType === 3 && !access.isAdmin) {
    throw new ApiError(
      403,
      'admin_required',
      'Only channel owners or admins can delete channel messages',
    );
  }

  if (!Array.isArray(messageIds)) {
    throw new ApiError(400, 'invalid_message_ids', 'message_ids must be an array');
  }
  const cleanIds = Array.from(
    new Set(messageIds.map((id) => Math.trunc(Number(id))).filter((id) => id > 0)),
  );
  const now = Date.now();

  if (forEveryone) {
    // In group / supergroup chats, non-admin members can ONLY delete their own messages for everyone!
    if ((access.chatType === 1 || access.chatType === 2) && !access.isAdmin) {
      for (const id of cleanIds) {
        const msgOwner = db
          .prepare(`SELECT sender_id FROM messages WHERE chat_id = ? AND message_id = ?`)
          .get(chatId, id) as { sender_id: number } | undefined;
        if (msgOwner && Number(msgOwner.sender_id) !== userId) {
          throw new ApiError(
            403,
            'forbidden',
            'Only chat admins or the message author can delete messages for everyone',
          );
        }
      }
    }

    const stmt = db.prepare(
      `UPDATE messages
       SET deleted_for_everyone = 1,
           text_plain = '',
           content_json = '{"type":"Text","data":{"text":"","entities":[]}}',
           entities_json = '[]'
       WHERE chat_id = ? AND message_id = ?`,
    );
    for (const id of cleanIds) {
      stmt.run(chatId, id);
      db.prepare(`DELETE FROM pinned_messages WHERE chat_id = ? AND message_id = ?`).run(chatId, id);
    }

    refreshChatLastMessage(db, chatId);

    const tombstone: DeleteTombstone = {
      chat_id: chatId,
      message_ids: cleanIds,
      deleted_at: new Date(now).toISOString(),
      for_everyone: true,
      timestamp_ms: now,
    };
    const ptsUpdate = commitPtsEventAtomic(db, sink, chatId, {
      type: 'DeleteMessages',
      data: tombstone,
    });
    return { pts: ptsUpdate.pts, deletedIds: cleanIds, tombstone };
  }

  // Per-user local visibility hide ("Delete for me") — other chat participants STILL see the message!
  const ins = db.prepare(
    `INSERT OR IGNORE INTO message_user_deletions (user_id, chat_id, message_id) VALUES (?, ?, ?)`,
  );
  for (const id of cleanIds) {
    ins.run(userId, chatId, id);
  }
  const chatRow = db.prepare(`SELECT pts FROM chats WHERE chat_id = ?`).get(chatId) as
    | { pts: number }
    | undefined;
  const currentPts = chatRow ? Number(chatRow.pts) : 0;
  const tombstone: DeleteTombstone = {
    chat_id: chatId,
    message_ids: cleanIds,
    deleted_at: new Date(now).toISOString(),
    for_everyone: false,
    timestamp_ms: now,
  };
  sink?.sendToUser(userId, {
    type: 'Update',
    payload: { type: 'DeleteMessages', data: tombstone },
  });
  return { pts: currentPts, deletedIds: cleanIds, tombstone };
}

export function recomputePollState(
  db: DatabaseSync,
  pollId: number,
  basePoll: PollData,
  viewerUserId: number,
): PollData {
  const voteRows = db
    .prepare(`SELECT user_id, option_ids_json FROM poll_votes WHERE poll_id = ?`)
    .all(pollId) as Array<{ user_id: number; option_ids_json: string }>;

  const optionVoters = new Map<number, number[]>();
  for (const opt of basePoll.options) {
    optionVoters.set(opt.option_id, []);
  }

  let totalVotes = 0;
  for (const vr of voteRows) {
    const chosenIds = JSON.parse(vr.option_ids_json) as number[];
    for (const oid of chosenIds) {
      const list = optionVoters.get(oid) ?? [];
      list.push(Number(vr.user_id));
      optionVoters.set(oid, list);
      totalVotes++;
    }
  }

  const totalVoters = voteRows.length;
  const options: PollOption[] = basePoll.options.map((opt) => {
    const voters = optionVoters.get(opt.option_id) ?? [];
    const pct = totalVotes > 0 ? Math.round((voters.length * 100) / totalVotes) : 0;
    return {
      option_id: opt.option_id,
      text: opt.text,
      vote_count: voters.length,
      is_chosen: voters.includes(viewerUserId),
      percentage: pct,
      voter_ids: basePoll.is_anonymous ? undefined : voters,
    };
  });

  return {
    ...basePoll,
    poll_id: pollId,
    options,
    total_voters: totalVoters,
    total_votes: totalVotes,
  };
}

export function castPollVoteAtomic(
  db: DatabaseSync,
  sink: PtsBroadcastSink | null,
  voterUserId: number,
  params: {
    pollId?: number;
    chatId?: number;
    messageId?: number;
    optionIds: number[];
  },
): PollData {
  const pollRow = (
    params.pollId !== undefined && Number.isFinite(params.pollId) && params.pollId > 0
      ? db.prepare(`SELECT * FROM polls WHERE poll_id = ?`).get(Number(params.pollId))
      : db
          .prepare(`SELECT * FROM polls WHERE chat_id = ? AND message_id = ?`)
          .get(Number(params.chatId), Number(params.messageId))
  ) as
    | { poll_id: number; chat_id: number; message_id: number; poll_json: string; is_closed: number }
    | undefined;

  if (!pollRow) {
    throw new ApiError(404, 'poll_not_found', 'Poll not found');
  }
  const pollId = Number(pollRow.poll_id);
  const chatId = Number(pollRow.chat_id);
  const messageId = Number(pollRow.message_id);
  ensureChatReadAccess(db, chatId, voterUserId);

  if (pollRow.is_closed) {
    throw new ApiError(400, 'poll_closed', 'Cannot vote on a closed poll');
  }

  const basePoll = JSON.parse(pollRow.poll_json) as PollData;
  if (!Array.isArray(params.optionIds)) {
    throw new ApiError(400, 'invalid_option_ids', 'option_ids must be an array');
  }
  const optionIdsSet = new Set<number>();
  for (const rawOid of params.optionIds) {
    if (
      typeof rawOid !== 'number' ||
      !Number.isInteger(rawOid) ||
      rawOid < 0 ||
      rawOid >= basePoll.options.length
    ) {
      throw new ApiError(400, 'invalid_option_id', `Invalid option_id ${String(rawOid)}`);
    }
    optionIdsSet.add(rawOid);
  }
  const optionIds = Array.from(optionIdsSet);

  if (!basePoll.allows_multiple_answers && optionIds.length > 1) {
    throw new ApiError(400, 'single_choice_poll', 'This poll allows only a single choice');
  }

  const existingVote = db
    .prepare(`SELECT option_ids_json FROM poll_votes WHERE poll_id = ? AND user_id = ?`)
    .get(pollId, voterUserId) as { option_ids_json: string } | undefined;

  if (basePoll.is_quiz && existingVote) {
    throw new ApiError(400, 'quiz_already_answered', 'Quiz answers cannot be retracted or changed');
  }

  if (optionIds.length === 0) {
    db.prepare(`DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?`).run(pollId, voterUserId);
  } else {
    db.prepare(
      `INSERT OR REPLACE INTO poll_votes (poll_id, user_id, option_ids_json, voted_at_ms)
       VALUES (?, ?, ?, ?)`,
    ).run(pollId, voterUserId, JSON.stringify(optionIds), Date.now());
  }

  const updatedPoll = recomputePollState(db, pollId, basePoll, voterUserId);
  db.prepare(`UPDATE messages SET content_json = ? WHERE chat_id = ? AND message_id = ?`).run(
    JSON.stringify({ type: 'Poll', data: updatedPoll }),
    chatId,
    messageId,
  );

  commitPtsEventAtomic(db, sink, chatId, {
    type: 'PollUpdated',
    data: { chat_id: chatId, message_id: messageId, poll: updatedPoll },
  });

  return updatedPoll;
}

export function lookupWalletIdempotency<T = unknown>(
  db: DatabaseSync,
  userId: number,
  key: string | undefined,
  endpoint: string,
): T | null {
  const cleanKey = key?.trim();
  if (!cleanKey) return null;
  const row = db
    .prepare(
      `SELECT endpoint, response_json FROM wallet_idempotency WHERE user_id = ? AND idempotency_key = ?`,
    )
    .get(userId, cleanKey) as { endpoint: string; response_json: string } | undefined;
  if (!row) return null;
  if (row.endpoint !== endpoint) {
    throw new ApiError(
      409,
      'idempotency_key_conflict',
      'Idempotency-Key was already used for a different wallet operation',
    );
  }
  return JSON.parse(row.response_json) as T;
}

export function storeWalletIdempotency(
  db: DatabaseSync,
  userId: number,
  key: string | undefined,
  endpoint: string,
  responsePayload: unknown,
): void {
  const cleanKey = key?.trim();
  if (!cleanKey) return;
  db.prepare(
    `INSERT OR REPLACE INTO wallet_idempotency (user_id, idempotency_key, endpoint, response_json, created_at_ms)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(userId, cleanKey, endpoint, JSON.stringify(responsePayload), Date.now());
}

export function computeChatDifference(
  db: DatabaseSync,
  userId: number,
  req: SyncGetDifferenceRequest,
): SyncGetDifferenceResponse {
  const chatId = Number(req.chat_id);
  ensureChatReadAccess(db, chatId, userId);

  const chatRow = db.prepare(`SELECT pts FROM chats WHERE chat_id = ?`).get(chatId) as
    | { pts: number }
    | undefined;
  if (!chatRow) {
    throw new ApiError(404, 'chat_not_found', `Chat ${chatId} not found`);
  }

  const currentPts = Number(chatRow.pts);
  const rawFromPts = Number(req.from_pts ?? req.pts ?? 0);
  const fromPts = Number.isFinite(rawFromPts) ? Math.max(0, Math.trunc(rawFromPts)) : 0;
  const rawLimit = Number(req.limit ?? req.pts_total_limit ?? 200);
  const maxLimit = Number.isFinite(rawLimit)
    ? Math.min(500, Math.max(1, Math.trunc(rawLimit)))
    : 200;

  if (fromPts >= currentPts) {
    return {
      status: 'UpToDate',
      chat_id: chatId,
      new_messages: [],
      other_updates: [],
      pts: currentPts,
      current_pts: currentPts,
      updates: [],
      has_more: false,
      snapshot_required: false,
    };
  }

  if (currentPts - fromPts > 500) {
    return {
      status: 'TooLong',
      chat_id: chatId,
      new_messages: [],
      other_updates: [],
      pts: currentPts,
      current_pts: currentPts,
      updates: [],
      has_more: false,
      snapshot_required: true,
    };
  }

  const rows = db
    .prepare(
      `SELECT pts, pts_count, created_at_ms, event_json
       FROM pts_events
       WHERE chat_id = ? AND pts > ?
       ORDER BY pts ASC
       LIMIT ?`,
    )
    .all(chatId, fromPts, maxLimit) as Array<{
    pts: number;
    pts_count: number;
    created_at_ms: number;
    event_json: string;
  }>;

  const updates: PtsUpdate[] = [];
  const newMessages: MessageItem[] = [];
  const otherUpdates: UpdateEvent[] = [];

  for (const r of rows) {
    const event = JSON.parse(r.event_json) as UpdateEvent;
    const ptsVal = Number(r.pts);
    const ts = Number(r.created_at_ms);

    // Re-hydrate fresh message state if NewMessage/EditMessage; NEVER leak tombstoned/deleted/cleared messages!
    if (event.type === 'NewMessage' || event.type === 'EditMessage') {
      const fresh = getMessageById(db, chatId, Number(event.data.id), userId);
      if (!fresh) {
        continue;
      }
      const refreshedEvent: UpdateEvent = { type: event.type, data: fresh };
      updates.push({
        chat_id: chatId,
        pts: ptsVal,
        pts_count: Number(r.pts_count),
        event: refreshedEvent,
        timestamp_ms: ts,
        date: new Date(ts).toISOString(),
      });
      if (event.type === 'NewMessage') {
        newMessages.push(fresh);
      } else {
        otherUpdates.push(refreshedEvent);
      }
      continue;
    }

    updates.push({
      chat_id: chatId,
      pts: ptsVal,
      pts_count: Number(r.pts_count),
      event,
      timestamp_ms: ts,
      date: new Date(ts).toISOString(),
    });
    otherUpdates.push(event);
  }

  const lastAppliedPts =
    rows.length > 0 ? Number(rows[rows.length - 1]!.pts) : currentPts;
  const hasMore = lastAppliedPts < currentPts;

  return {
    status: 'Updates',
    chat_id: chatId,
    new_messages: newMessages,
    other_updates: otherUpdates,
    pts: lastAppliedPts,
    current_pts: currentPts,
    updates,
    has_more: hasMore,
    snapshot_required: false,
  };
}
