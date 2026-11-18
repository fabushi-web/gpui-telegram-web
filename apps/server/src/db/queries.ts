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

export function ensureChatMembership(db: DatabaseSync, chatId: number, userId: number): void {
  const chat = db.prepare(`SELECT chat_id, chat_type FROM chats WHERE chat_id = ?`).get(chatId) as
    | { chat_id: number; chat_type: number }
    | undefined;
  if (!chat) {
    throw new ApiError(404, 'chat_not_found', `Chat ${chatId} not found`);
  }
  const mem = db
    .prepare(`SELECT role, banned_rights FROM chat_members WHERE chat_id = ? AND user_id = ?`)
    .get(chatId, userId) as { role: string; banned_rights: number } | undefined;
  if (!mem) {
    // Allow public channels read/join or auto-enroll demo users in public channels
    if (Number(chat.chat_type) === 3) {
      return;
    }
    throw new ApiError(403, 'forbidden', 'You are not a member of this chat');
  }
  if (mem.role === 'banned') {
    throw new ApiError(403, 'banned_in_chat', 'You are banned from this chat');
  }
}

export function getChatMemberIds(db: DatabaseSync, chatId: number): number[] {
  const rows = db
    .prepare(`SELECT user_id FROM chat_members WHERE chat_id = ? AND role != 'banned'`)
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
    text: String(row.text_plain ?? extractPlainTextFromContent(content)),
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

export function synthesizeWebPagePreview(text: string): WebPagePreview | undefined {
  const m = /https?:\/\/[^\s<>()]+/i.exec(text);
  if (!m) return undefined;
  const rawUrl = m[0].replace(/[.,!?;:'"\]}]+$/, '');
  try {
    const parsed = new URL(rawUrl);
    return {
      url: rawUrl,
      display_url: `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`,
      site_name: parsed.hostname,
      title: `Article on ${parsed.hostname}`,
      description: `Preview & Instant View reader summary for ${rawUrl}`,
      instant_view_available: true,
      instant_view_blocks: [
        { kind: 'heading', text: `Instant View — ${parsed.hostname}` },
        { kind: 'paragraph', text: `Clean reader view generated for ${rawUrl}.` },
      ],
    };
  } catch {
    return undefined;
  }
}

export interface CreateMessageParams {
  chatId: number;
  senderId: number;
  sendAsPeerId?: number;
  text?: string;
  entities?: Array<MessageEntity | WireMessageEntity>;
  parseMarkdown?: boolean;
  content?: MessageContent;
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
 * advances `chats.pts` by 1, appends to `pts_events`, and broadcasts `PtsUpdate`.
 */
export function createMessageAtomic(
  db: DatabaseSync,
  sink: PtsBroadcastSink | null,
  params: CreateMessageParams,
): { message: MessageItem; pts: number; duplicate: boolean } {
  const now = Date.now();
  if (params.scheduleAtMs !== undefined && params.scheduleAtMs < now - 5000) {
    throw new ApiError(400, 'invalid_schedule_time', 'Scheduled timestamp cannot be in the past');
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
      const existingMsg = getMessageById(
        db,
        Number(existingDedup.chat_id),
        Number(existingDedup.message_id),
        params.senderId,
      );
      if (existingMsg) {
        return {
          message: existingMsg,
          pts: Number(existingDedup.pts),
          duplicate: true,
        };
      }
    }
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

  if (params.content) {
    content = params.content;
    if (content.type === 'Text') {
      plainText = content.data.text;
      wireEntities = content.data.entities ?? [];
    } else {
      plainText = params.text ?? extractPlainTextFromContent(content);
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

  const mediaType = classifyMessageMediaType(content, plainText);

  const webPage = content.type === 'Text' ? synthesizeWebPagePreview(plainText) : undefined;

  let replyHeader: ReplyHeader | undefined;
  if (params.replyToMsgId !== undefined) {
    const targetRow = db
      .prepare(`SELECT sender_id, text_plain FROM messages WHERE chat_id = ? AND message_id = ?`)
      .get(params.chatId, params.replyToMsgId) as { sender_id: number; text_plain: string } | undefined;
    const senderDto = targetRow ? getUserProfileDto(db, Number(targetRow.sender_id)) : null;
    replyHeader = {
      reply_to_msg_id: params.replyToMsgId,
      quote_text: params.quoteText,
      sender_name: senderDto ? [senderDto.first_name, senderDto.last_name].filter(Boolean).join(' ') : undefined,
      preview_text: targetRow?.text_plain?.slice(0, 100),
    };
  }

  const effectiveTtl =
    params.ttlSeconds !== undefined
      ? params.ttlSeconds
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
    is_scheduled: Boolean(params.scheduleAtMs),
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
      params.topicId ?? null,
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

    if (params.topicId) {
      db.prepare(
        `UPDATE forum_topics SET last_message_id = ? WHERE chat_id = ? AND topic_id = ?`,
      ).run(msgId, params.chatId, params.topicId);
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
  if (content.type === 'Text') {
    return plainText.includes('http://') || plainText.includes('https://') ? 'links' : null;
  }
  if (content.type === 'Media') {
    const mime = (content.data?.mime_type ?? '').toLowerCase();
    if (mime === 'image/gif') return 'gif';
    if (mime.startsWith('image/')) return 'photo';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    return 'document';
  }
  return content.type.toLowerCase();
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
  ensureChatMembership(db, params.chatId, params.editorUserId);
  const existing = getMessageById(db, params.chatId, params.messageId, params.editorUserId);
  if (!existing) {
    throw new ApiError(404, 'message_not_found', 'Message not found');
  }
  if (existing.sender_id !== params.editorUserId) {
    throw new ApiError(403, 'forbidden', 'Only the message author can edit this message');
  }

  let plainText = existing.text ?? '';
  let wireEntities: WireMessageEntity[] = (existing.entities ?? []).map(toWireMessageEntity);
  let newContent: MessageContent = existing.content;

  if (params.content) {
    newContent = params.content;
    if (newContent.type === 'Text') {
      plainText = newContent.data.text;
      wireEntities = (newContent.data.entities ?? []).map((e) =>
        toWireMessageEntity(fromWireMessageEntity(e)),
      );
    } else {
      plainText = params.text ?? extractPlainTextFromContent(newContent);
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
  const cleanIds = Array.from(
    new Set(messageIds.map((id) => Math.trunc(Number(id))).filter((id) => id > 0)),
  );
  const now = Date.now();

  if (forEveryone) {
    const chatMeta = db
      .prepare(`SELECT chat_type FROM chats WHERE chat_id = ?`)
      .get(chatId) as { chat_type: number } | undefined;
    if (!chatMeta) {
      throw new ApiError(404, 'chat_not_found', `Chat ${chatId} not found`);
    }

    // In group / supergroup / channel chats, non-admin members can ONLY delete their own messages for everyone!
    if ([1, 2, 3].includes(Number(chatMeta.chat_type))) {
      const memberRow = db
        .prepare(`SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?`)
        .get(chatId, userId) as { role: string } | undefined;
      const isAdminOrOwner = memberRow?.role === 'owner' || memberRow?.role === 'admin';
      if (!isAdminOrOwner) {
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
  ensureChatMembership(db, chatId, voterUserId);

  if (pollRow.is_closed) {
    throw new ApiError(400, 'poll_closed', 'Cannot vote on a closed poll');
  }

  const basePoll = JSON.parse(pollRow.poll_json) as PollData;
  const optionIds = Array.from(new Set((params.optionIds ?? []).map(Number)));

  for (const oid of optionIds) {
    if (!Number.isInteger(oid) || oid < 0 || oid >= basePoll.options.length) {
      throw new ApiError(400, 'invalid_option_id', `Invalid option_id ${oid}`);
    }
  }

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
  ensureChatMembership(db, chatId, userId);

  const chatRow = db.prepare(`SELECT pts FROM chats WHERE chat_id = ?`).get(chatId) as
    | { pts: number }
    | undefined;
  if (!chatRow) {
    throw new ApiError(404, 'chat_not_found', `Chat ${chatId} not found`);
  }

  const currentPts = Number(chatRow.pts);
  const fromPts = Math.max(0, Math.trunc(Number(req.from_pts ?? req.pts ?? 0)));
  const maxLimit = Math.min(500, Math.max(1, Number(req.limit ?? req.pts_total_limit ?? 200)));

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
