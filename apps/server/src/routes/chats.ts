import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  E2EE_SAFETY_EMOJIS,
  escapeHtml,
  renderEntitiesToSafeHtml,
  type AdminLogEventDto,
  type ChannelStatisticsDto,
  type ChatDetailDto,
  type ChatFolderDto,
  type ChatMemberDto,
  type ForumTopicDto,
  type InviteLinkDto,
  type WireDraftDto,
} from '@gpui-telegram/protocol';
import { ensureSavedMessagesChat } from './auth.js';
import {
  ensureChatAdminAccess,
  ensureChatMembership,
  ensureChatReadAccess,
  getChatDetailDto,
  getUserProfileDto,
  hydrateMessageRow,
  mapUserRowToDto,
  parseBoundedQueryInt,
  parseOptionalNonNegativeInt,
  parseOptionalPositiveInt,
  purgeExpiredTtlMessages,
  recordChatAdminLog,
  refreshChatLastMessage,
  validateSendAsPeerId,
} from '../db/queries.js';
import {
  ApiError,
  readJsonBody,
  requireAuth,
  sendJson,
  type HttpRouter,
  type RequestContext,
} from '../utils/http.js';
import type { RealtimeGatewayHub } from '../ws/hub.js';

function containsCjk(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x3040 && cp <= 0x30ff) ||
      (cp >= 0xac00 && cp <= 0xd7af)
    ) {
      return true;
    }
  }
  return false;
}

function truncateTitleChars(raw: string, maxChars = 72): string {
  const chars = Array.from(raw.trim());
  if (chars.length <= maxChars) return chars.join('');
  const sliced = chars
    .slice(0, maxChars - 1)
    .join('')
    .replace(/[\s,、&·]+$/u, '');
  return `${sliced}…`;
}

function autoGenerateGroupTitleFromMembers(
  db: DatabaseSync,
  creatorId: number,
  memberIds: number[],
): string {
  const names: string[] = [];
  const seenLower = new Set<string>();
  const pushName = (uid: number): void => {
    const u = getUserProfileDto(db, uid);
    const display = u
      ? [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.username || `User ${uid}`
      : `User ${uid}`;
    const key = display.toLowerCase();
    if (!seenLower.has(key)) {
      seenLower.add(key);
      names.push(display);
    }
  };

  for (const uid of memberIds) {
    pushName(uid);
  }
  if (names.length === 1) {
    pushName(creatorId);
  }
  if (names.length === 0) {
    return 'Group Chat';
  }
  const sep = names.some(containsCjk) ? '、' : ', ';
  return truncateTitleChars(names.join(sep), 72);
}

const ALLOWED_MEMBER_ROLES = new Set(['owner', 'admin', 'member', 'restricted', 'banned']);

function readOptionalTrimmedString(
  val: unknown,
  errorCode: string,
  message: string,
): string {
  if (val === undefined || val === null) {
    return '';
  }
  if (typeof val !== 'string') {
    throw new ApiError(400, errorCode, message);
  }
  return val.trim();
}

function parseOptionalPositiveIntArray(
  val: unknown,
  errorCode: string,
  message: string,
): number[] | undefined {
  if (val === undefined || val === null) {
    return undefined;
  }
  if (!Array.isArray(val)) {
    throw new ApiError(400, errorCode, message);
  }
  const out: number[] = [];
  for (const item of val) {
    if (
      typeof item !== 'number' ||
      !Number.isInteger(item) ||
      item < 1 ||
      item > Number.MAX_SAFE_INTEGER
    ) {
      throw new ApiError(400, errorCode, message);
    }
    out.push(item);
  }
  return out;
}

function validateChatUsername(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new ApiError(
      400,
      'invalid_username',
      'Username must be 5–32 alphanumeric/underscore characters',
    );
  }
  const clean = raw.trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{5,32}$/.test(clean)) {
    throw new ApiError(
      400,
      'invalid_username',
      'Username must be 5–32 alphanumeric/underscore characters',
    );
  }
  return clean;
}

function getNextChatId(db: DatabaseSync): number {
  const row = db.prepare(`SELECT COALESCE(MAX(chat_id), 500) AS mx FROM chats`).get() as { mx: number };
  return Math.max(501, Number(row.mx) + 1);
}

export function registerChatAndSocialRoutes(
  router: HttpRouter,
  db: DatabaseSync,
  hub: RealtimeGatewayHub,
): void {
  // 1. List Chats (supports `?archived=true|false` and `?folder_id=...`)
  router.get('/api/v1/chats', (ctx) => {
    const auth = requireAuth(db, ctx);
    const archivedFilter = ctx.query.get('archived');
    const folderFilter = ctx.query.get('folder_id');

    const memberRows = db
      .prepare(
        `SELECT chat_id FROM chat_members WHERE user_id = ? AND role != 'banned'`,
      )
      .all(auth.userId) as Array<{ chat_id: number }>;

    let folderDto: ChatFolderDto | null = null;
    if (folderFilter && folderFilter !== 'all') {
      const fRow = db
        .prepare(
          `SELECT folder_json FROM chat_folders
           WHERE user_id = ? AND (CAST(folder_id AS TEXT) = ? OR LOWER(title) = LOWER(?))`,
        )
        .get(auth.userId, folderFilter, folderFilter) as { folder_json: string } | undefined;
      if (fRow) {
        folderDto = JSON.parse(fRow.folder_json) as ChatFolderDto;
      }
    }

    const chats: ChatDetailDto[] = [];
    const peerIds = new Set<number>([auth.userId]);

    for (const m of memberRows) {
      const detail = getChatDetailDto(db, Number(m.chat_id), auth.userId);
      if (!detail) continue;

      if (archivedFilter === 'true' && !detail.is_archived) continue;
      if (archivedFilter === 'false' && detail.is_archived) continue;

      if (folderFilter === 'unread' && detail.unread_count === 0) continue;
      if (folderFilter === 'bots' && !detail.is_bot) continue;
      if (folderDto) {
        const inc = new Set(folderDto.include_chats ?? folderDto.included_chat_ids ?? []);
        const exc = new Set(folderDto.exclude_chats ?? folderDto.excluded_chat_ids ?? []);
        if (exc.has(detail.chat_id)) continue;
        const matchesExplicit = inc.has(detail.chat_id);
        const matchesType =
          (folderDto.include_bots && detail.is_bot) ||
          (folderDto.include_groups && detail.is_group) ||
          (folderDto.include_channels && detail.is_channel) ||
          (folderDto.include_contacts && detail.chat_type === 0 && !detail.is_bot);
        if (!matchesExplicit && !matchesType) continue;
      }

      if (detail.peer_user_id) {
        peerIds.add(detail.peer_user_id);
      }
      chats.push(detail);
    }

    chats.sort((a, b) => {
      if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1;
      return b.last_message_date_ms - a.last_message_date_ms;
    });

    const users = Array.from(peerIds)
      .map((uid) => getUserProfileDto(db, uid))
      .filter(Boolean);

    sendJson(ctx.res, 200, { chats, users, total: chats.length });
  });

  // 2. Saved Messages (explicit, idempotent)
  router.post('/api/v1/chats/saved', (ctx) => {
    const auth = requireAuth(db, ctx);
    const savedChatId = ensureSavedMessagesChat(db, auth.userId);
    const detail = getChatDetailDto(db, savedChatId, auth.userId)!;
    sendJson(ctx.res, 200, detail);
  });

  // 3. Create Secret Chat (`chat_type = 4`)
  router.post('/api/v1/secret-chats', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      peer_user_id?: unknown;
      ttl_seconds?: unknown;
    }>(ctx.req);

    const peerUserId = parseOptionalPositiveInt(
      body.peer_user_id,
      'invalid_peer_user_id',
      'peer_user_id must be a positive integer',
    );
    if (peerUserId === undefined) {
      throw new ApiError(400, 'invalid_peer_user_id', 'peer_user_id is required');
    }
    const peerUser = getUserProfileDto(db, peerUserId);
    if (!peerUser) {
      throw new ApiError(404, 'peer_not_found', 'Target user for secret chat not found');
    }

    const now = Date.now();
    const chatId = getNextChatId(db);
    const ttlSeconds =
      parseOptionalNonNegativeInt(
        body.ttl_seconds,
        'invalid_ttl',
        'ttl_seconds must be a non-negative integer',
      ) ?? 30;
    const hash = crypto.createHash('sha256').update(`secret:${auth.userId}:${peerUserId}:${chatId}`).digest();
    const emojiFp = [0, 1, 2, 3].map((i) => E2EE_SAFETY_EMOJIS[hash[i]! % 32]!);
    const title = `🔒 ${[peerUser.first_name, peerUser.last_name].filter(Boolean).join(' ')}`;

    db.prepare(`
      INSERT INTO chats (
        chat_id, title, kind, chat_type, creator_id, peer_user_id, is_forum, is_verified,
        pts, next_msg_id, last_message_id, last_message_date_ms, last_message_preview,
        ttl_seconds, emoji_fingerprint_json, created_at_ms
      ) VALUES (?, ?, 'secret', 4, ?, ?, 0, 0, 0, 1, 0, ?, 'Secret chat initialized', ?, ?, ?)
    `).run(chatId, title, auth.userId, peerUserId, now, ttlSeconds, JSON.stringify(emojiFp), now);

    db.prepare(`INSERT INTO chat_members (chat_id, user_id, role, admin_rights, joined_at_ms) VALUES (?, ?, 'owner', 255, ?)`).run(chatId, auth.userId, now);
    db.prepare(`INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, admin_rights, joined_at_ms) VALUES (?, ?, 'member', 0, ?)`).run(chatId, peerUserId, now);

    const detail = getChatDetailDto(db, chatId, auth.userId)!;
    sendJson(ctx.res, 201, {
      chat: detail,
      key_fingerprint: hash.subarray(0, 16).toString('hex'),
      emoji_fingerprint: emojiFp,
      ttl_seconds: ttlSeconds,
    });
  });

  // 4. Create Chat (Private DM, Group, Supergroup/Forum, Channel, Bot DM, Saved)
  const handleCreateChat = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      title?: unknown;
      chat_type?: unknown;
      kind?: unknown;
      peer_user_id?: unknown;
      user_id?: unknown;
      username?: unknown;
      about?: unknown;
      is_forum?: boolean;
      member_ids?: unknown;
      member_usernames?: unknown;
      client_nonce?: unknown;
    }>(ctx.req);

    if (
      body.client_nonce !== undefined &&
      body.client_nonce !== null &&
      typeof body.client_nonce !== 'string'
    ) {
      throw new ApiError(400, 'invalid_nonce', 'client_nonce must be a string');
    }
    const clientNonce =
      typeof body.client_nonce === 'string' && body.client_nonce.trim()
        ? body.client_nonce.trim()
        : undefined;

    if (clientNonce) {
      const existingNonce = db
        .prepare(
          `SELECT chat_id FROM chat_create_nonces WHERE creator_user_id = ? AND client_nonce = ?`,
        )
        .get(auth.userId, clientNonce) as { chat_id: number } | undefined;
      if (existingNonce) {
        const existingChatId = Number(existingNonce.chat_id);
        const existingMem = db
          .prepare(
            `SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ? AND role != 'banned'`,
          )
          .get(existingChatId, auth.userId);
        const existingDetail = existingMem ? getChatDetailDto(db, existingChatId, auth.userId) : null;
        if (existingDetail) {
          sendJson(ctx.res, 201, existingDetail);
          return;
        }
        db.prepare(
          `DELETE FROM chat_create_nonces WHERE creator_user_id = ? AND client_nonce = ?`,
        ).run(auth.userId, clientNonce);
      }
    }

    if (
      body.chat_type !== undefined &&
      body.chat_type !== null &&
      typeof body.chat_type !== 'number' &&
      typeof body.chat_type !== 'string'
    ) {
      throw new ApiError(400, 'invalid_chat_type', 'chat_type must be a number or string');
    }
    if (body.kind !== undefined && body.kind !== null && typeof body.kind !== 'string') {
      throw new ApiError(400, 'invalid_chat_type', 'kind must be a string');
    }

    const peerIdRaw = parseOptionalPositiveInt(
      body.peer_user_id ?? body.user_id,
      'invalid_peer_user_id',
      'peer_user_id must be a positive integer',
    );
    const rawType =
      body.chat_type ??
      body.kind ??
      (peerIdRaw !== undefined ? (peerIdRaw === auth.userId ? 5 : 0) : 1);
    const normalizedTypeStr = typeof rawType === 'string' ? rawType.trim().toLowerCase() : rawType;
    let chatType =
      normalizedTypeStr === 5 || normalizedTypeStr === 'saved' || normalizedTypeStr === 'saved_messages'
        ? 5
        : normalizedTypeStr === 'private' ||
            normalizedTypeStr === 'direct' ||
            normalizedTypeStr === 'dm' ||
            normalizedTypeStr === 'bot' ||
            normalizedTypeStr === 0
          ? 0
          : normalizedTypeStr === 'channel' || normalizedTypeStr === 3
            ? 3
            : normalizedTypeStr === 'supergroup' || normalizedTypeStr === 2 || body.is_forum
              ? 2
              : normalizedTypeStr === 'secret' || normalizedTypeStr === 4
                ? 4
                : 1;
    if (chatType === 0 && peerIdRaw !== undefined && Number(peerIdRaw) === auth.userId) {
      chatType = 5;
    }

    if (body.username !== undefined && body.username !== null && ![1, 2, 3].includes(chatType)) {
      throw new ApiError(
        400,
        'invalid_chat_type',
        'Only groups and channels can have a public username',
      );
    }

    const now = Date.now();
    const recordCreateNonce = (chatId: number): void => {
      if (!clientNonce) return;
      db.prepare(`
        INSERT OR REPLACE INTO chat_create_nonces (creator_user_id, client_nonce, chat_id, created_at_ms)
        VALUES (?, ?, ?, ?)
      `).run(auth.userId, clientNonce, chatId, now);
    };

    if (chatType === 5) {
      const savedChatId = ensureSavedMessagesChat(db, auth.userId);
      recordCreateNonce(savedChatId);
      sendJson(ctx.res, 200, getChatDetailDto(db, savedChatId, auth.userId));
      return;
    }

    if (chatType === 0 && peerIdRaw !== undefined) {
      const peerId = Number(peerIdRaw);
      if (peerId === auth.userId) {
        const savedId = ensureSavedMessagesChat(db, auth.userId);
        recordCreateNonce(savedId);
        sendJson(ctx.res, 200, getChatDetailDto(db, savedId, auth.userId));
        return;
      }
      const existingDm = db
        .prepare(
          `SELECT c.chat_id FROM chats c
           JOIN chat_members m1 ON m1.chat_id = c.chat_id AND m1.user_id = ?
           JOIN chat_members m2 ON m2.chat_id = c.chat_id AND m2.user_id = ?
           WHERE c.chat_type = 0 AND c.kind IN ('private', 'bot')
           LIMIT 1`,
        )
        .get(auth.userId, peerId) as { chat_id: number } | undefined;

      if (existingDm) {
        recordCreateNonce(Number(existingDm.chat_id));
        sendJson(ctx.res, 200, getChatDetailDto(db, Number(existingDm.chat_id), auth.userId));
        return;
      }

      const peer = getUserProfileDto(db, peerId);
      if (!peer) {
        throw new ApiError(404, 'user_not_found', 'Target peer user not found');
      }

      const chatId = getNextChatId(db);
      const kind = peer.is_bot ? 'bot' : 'private';
      const title = [peer.first_name, peer.last_name].filter(Boolean).join(' ') || peer.username || `User ${peerId}`;
      db.prepare(`
        INSERT INTO chats (
          chat_id, title, kind, chat_type, creator_id, peer_user_id, username, about,
          is_forum, is_verified, pts, next_msg_id, last_message_id, last_message_date_ms, created_at_ms
        ) VALUES (?, ?, ?, 0, ?, ?, NULL, ?, 0, ?, 0, 1, 0, ?, ?)
      `).run(
        chatId,
        title,
        kind,
        auth.userId,
        peerId,
        peer.bio ?? null,
        peer.is_verified ? 1 : 0,
        now,
        now,
      );

      db.prepare(`INSERT INTO chat_members (chat_id, user_id, role, joined_at_ms) VALUES (?, ?, 'member', ?)`).run(
        chatId,
        auth.userId,
        now,
      );
      db.prepare(`INSERT INTO chat_members (chat_id, user_id, role, joined_at_ms) VALUES (?, ?, 'member', ?)`).run(
        chatId,
        peerId,
        now,
      );
      recordCreateNonce(chatId);
      sendJson(ctx.res, 201, getChatDetailDto(db, chatId, auth.userId));
      return;
    }

    // Resolve and deduplicate group/channel member IDs from `member_ids` and `member_usernames`
    const resolvedMemberIds: number[] = [];
    const seenMembers = new Set<number>([auth.userId]);
    const parsedMemberIds = parseOptionalPositiveIntArray(
      body.member_ids,
      'invalid_members',
      'member_ids must be an array of positive integers',
    );
    for (const uid of parsedMemberIds ?? []) {
      if (!seenMembers.has(uid)) {
        seenMembers.add(uid);
        resolvedMemberIds.push(uid);
      }
    }
    if (body.member_usernames !== undefined && body.member_usernames !== null) {
      if (!Array.isArray(body.member_usernames)) {
        throw new ApiError(
          400,
          'invalid_members',
          'member_usernames must be an array of strings',
        );
      }
      for (const rawUname of body.member_usernames) {
        if (typeof rawUname !== 'string') {
          throw new ApiError(400, 'invalid_members', 'Each member username must be a string');
        }
        const clean = rawUname.trim().replace(/^@/, '');
        if (!clean) continue;
        const uRow = db
          .prepare(`SELECT user_id FROM users WHERE LOWER(username) = LOWER(?)`)
          .get(clean) as { user_id: number } | undefined;
        if (uRow) {
          const uid = Number(uRow.user_id);
          if (!seenMembers.has(uid)) {
            seenMembers.add(uid);
            resolvedMemberIds.push(uid);
          }
        }
      }
    }

    // Validate optional title or auto-generate CJK/Latin group title when omitted
    if (body.title !== undefined && body.title !== null && typeof body.title !== 'string') {
      throw new ApiError(400, 'invalid_title', 'Chat title must be a string');
    }
    let title = typeof body.title === 'string' ? body.title.trim() : '';
    if (Array.from(title).length > 255) {
      throw new ApiError(400, 'invalid_title', 'Chat title cannot exceed 255 characters');
    }
    if (!title) {
      if ((chatType === 1 || chatType === 2) && resolvedMemberIds.length > 0) {
        title = autoGenerateGroupTitleFromMembers(db, auth.userId, resolvedMemberIds);
      } else {
        throw new ApiError(400, 'invalid_title', 'Group or channel title cannot be empty');
      }
    }

    let cleanUsername: string | null = null;
    if (body.username !== undefined && body.username !== null) {
      if (![1, 2, 3].includes(chatType)) {
        throw new ApiError(
          400,
          'invalid_chat_type',
          'Only groups and channels can have a public username',
        );
      }
      cleanUsername = validateChatUsername(body.username);
      const dup = db
        .prepare(`SELECT chat_id FROM chats WHERE LOWER(username) = LOWER(?)`)
        .get(cleanUsername);
      if (dup) {
        throw new ApiError(409, 'username_taken', 'Chat username is already taken');
      }
    }

    if (body.about !== undefined && body.about !== null && typeof body.about !== 'string') {
      throw new ApiError(400, 'invalid_about', 'Chat about description must be a string');
    }

    const chatId = getNextChatId(db);
    const kind = chatType === 3 ? 'channel' : chatType === 2 ? 'supergroup' : 'group';
    const isForum = Boolean(body.is_forum && chatType === 2);

    db.prepare(`
      INSERT INTO chats (
        chat_id, title, kind, chat_type, creator_id, username, about, is_forum,
        pts, next_msg_id, last_message_id, last_message_date_ms, last_message_preview, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 0, ?, ?, ?)
    `).run(
      chatId,
      title,
      kind,
      chatType,
      auth.userId,
      cleanUsername,
      typeof body.about === 'string' ? body.about.trim() : null,
      isForum ? 1 : 0,
      now,
      `${kind === 'channel' ? 'Channel' : 'Group'} created`,
      now,
    );

    db.prepare(`
      INSERT INTO chat_members (chat_id, user_id, role, admin_rights, banned_rights, joined_at_ms)
      VALUES (?, ?, 'owner', 255, 0, ?)
    `).run(chatId, auth.userId, now);

    for (const uid of resolvedMemberIds) {
      db.prepare(`
        INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, admin_rights, banned_rights, joined_at_ms)
        VALUES (?, ?, 'member', 0, 0, ?)
      `).run(chatId, uid, now);
    }

    if (isForum) {
      db.prepare(`
        INSERT INTO forum_topics (
          chat_id, topic_id, title, icon_color, icon_emoji, creator_id, is_pinned, is_closed, is_hidden, created_at_ms
        ) VALUES (?, 1, 'General', 3379436, '💬', ?, 1, 0, 0, ?)
      `).run(chatId, auth.userId, now);
    }

    recordCreateNonce(chatId);

    const detail = getChatDetailDto(db, chatId, auth.userId)!;
    for (const uid of resolvedMemberIds) {
      const peerDetail = getChatDetailDto(db, chatId, uid);
      if (peerDetail) {
        hub.sendToUser(uid, {
          type: 'Update',
          payload: { type: 'ChatUpdated', data: peerDetail },
        });
      }
    }
    sendJson(ctx.res, 201, detail);
  };
  router.post('/api/v1/chats', handleCreateChat);
  router.post('/api/v1/chats/create', handleCreateChat);

  // 5. Single Chat Inspect, Join Public Chat, Patch, Delete/Leave, Settings, Draft, TTL, Clear History, Send-As
  router.get('/api/v1/chats/:chatId', (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    ensureChatReadAccess(db, chatId, auth.userId);
    const detail = getChatDetailDto(db, chatId, auth.userId);
    if (!detail) throw new ApiError(404, 'chat_not_found', 'Chat not found');
    sendJson(ctx.res, 200, detail);
  });

  router.post('/api/v1/chats/:chatId/join', (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    const chat = db
      .prepare(`SELECT chat_id, chat_type, username FROM chats WHERE chat_id = ?`)
      .get(chatId) as { chat_id: number; chat_type: number; username: string | null } | undefined;
    if (!chat) {
      throw new ApiError(404, 'chat_not_found', `Chat ${chatId} not found`);
    }
    const existingMem = db
      .prepare(`SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?`)
      .get(chatId, auth.userId) as { role: string } | undefined;
    if (existingMem?.role === 'banned') {
      throw new ApiError(403, 'banned_in_chat', 'You are banned from this chat');
    }
    const hasPublicUsername = Boolean(chat.username && String(chat.username).trim().length > 0);
    if (!existingMem && (!hasPublicUsername || ![1, 2, 3].includes(Number(chat.chat_type)))) {
      throw new ApiError(403, 'forbidden', 'Cannot join a private chat without an invite link');
    }
    db.prepare(`
      INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, admin_rights, banned_rights, joined_at_ms)
      VALUES (?, ?, 'member', 0, 0, ?)
    `).run(chatId, auth.userId, Date.now());
    sendJson(ctx.res, 200, getChatDetailDto(db, chatId, auth.userId));
  });

  const handleUpdateChatMeta = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    const access = ensureChatAdminAccess(db, chatId, auth.userId);
    if (![1, 2, 3].includes(access.chatType)) {
      throw new ApiError(
        400,
        'invalid_chat_type',
        'Only groups and channels support metadata updates',
      );
    }
    const body = await readJsonBody<{
      title?: unknown;
      about?: unknown;
      username?: unknown;
      photo_file_id?: unknown;
      slow_mode_seconds?: unknown;
      is_forum?: boolean;
    }>(ctx.req);

    if (body.title !== undefined) {
      if (typeof body.title !== 'string' || !body.title.trim()) {
        throw new ApiError(400, 'invalid_title', 'Title cannot be empty');
      }
      db.prepare(`UPDATE chats SET title = ? WHERE chat_id = ?`).run(body.title.trim(), chatId);
    }
    if (body.about !== undefined) {
      if (body.about !== null && typeof body.about !== 'string') {
        throw new ApiError(400, 'invalid_about', 'Chat about description must be a string or null');
      }
      db.prepare(`UPDATE chats SET about = ? WHERE chat_id = ?`).run(
        body.about === null ? null : body.about,
        chatId,
      );
    }
    if (body.username !== undefined) {
      if (body.username === null) {
        db.prepare(`UPDATE chats SET username = NULL WHERE chat_id = ?`).run(chatId);
      } else {
        const cleanU = validateChatUsername(body.username);
        const dup = db
          .prepare(`SELECT chat_id FROM chats WHERE LOWER(username) = LOWER(?) AND chat_id != ?`)
          .get(cleanU, chatId);
        if (dup) {
          throw new ApiError(409, 'username_taken', 'Chat username is already taken');
        }
        db.prepare(`UPDATE chats SET username = ? WHERE chat_id = ?`).run(cleanU, chatId);
      }
    }
    if (body.photo_file_id !== undefined) {
      if (body.photo_file_id !== null && typeof body.photo_file_id !== 'string') {
        throw new ApiError(
          400,
          'invalid_photo_file_id',
          'photo_file_id must be a string or null',
        );
      }
      db.prepare(`UPDATE chats SET photo_file_id = ? WHERE chat_id = ?`).run(
        body.photo_file_id === null ? null : body.photo_file_id,
        chatId,
      );
    }
    if (body.slow_mode_seconds !== undefined && body.slow_mode_seconds !== null) {
      const slowSecs = parseOptionalNonNegativeInt(
        body.slow_mode_seconds,
        'invalid_slow_mode',
        'slow_mode_seconds must be a non-negative integer',
      )!;
      db.prepare(`UPDATE chats SET slow_mode_seconds = ? WHERE chat_id = ?`).run(slowSecs, chatId);
    }
    if (body.is_forum !== undefined) {
      db.prepare(`UPDATE chats SET is_forum = ? WHERE chat_id = ?`).run(body.is_forum ? 1 : 0, chatId);
    }

    const changedFields: Record<string, unknown> = {};
    if (body.title !== undefined) changedFields.title = String(body.title).trim();
    if (body.about !== undefined) changedFields.about = body.about;
    if (body.username !== undefined) changedFields.username = body.username;
    if (body.photo_file_id !== undefined) changedFields.photo_file_id = body.photo_file_id;
    if (body.slow_mode_seconds !== undefined) changedFields.slow_mode_seconds = body.slow_mode_seconds;
    if (body.is_forum !== undefined) changedFields.is_forum = Boolean(body.is_forum);
    if (Object.keys(changedFields).length > 0) {
      recordChatAdminLog(db, {
        chatId,
        actorUserId: auth.userId,
        action: 'edit_chat_info',
        details: changedFields,
      });
    }

    const detail = getChatDetailDto(db, chatId, auth.userId)!;
    hub.broadcastChatEphemeral(chatId, { type: 'ChatUpdated', data: detail });
    sendJson(ctx.res, 200, detail);
  };
  router.patch('/api/v1/chats/:chatId', handleUpdateChatMeta);
  router.put('/api/v1/chats/:chatId', handleUpdateChatMeta);

  const handleLeaveOrDeleteChat = (ctx: RequestContext): void => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    const memRow = db
      .prepare(`SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?`)
      .get(chatId, auth.userId) as { role: string } | undefined;
    if (memRow?.role === 'banned') {
      throw new ApiError(403, 'banned_in_chat', 'Banned users cannot leave this chat');
    }
    db.prepare(`DELETE FROM chat_members WHERE chat_id = ? AND user_id = ? AND role != 'banned'`).run(
      chatId,
      auth.userId,
    );
    db.prepare(`DELETE FROM user_chat_settings WHERE chat_id = ? AND user_id = ?`).run(
      chatId,
      auth.userId,
    );
    hub.unsubscribeUserFromChat(auth.userId, chatId);
    sendJson(ctx.res, 200, { ok: true });
  };
  router.delete('/api/v1/chats/:chatId', handleLeaveOrDeleteChat);
  router.post('/api/v1/chats/:chatId/leave', handleLeaveOrDeleteChat);

  const handleUpdateChatSettings = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    ensureChatMembership(db, chatId, auth.userId);
    const body = await readJsonBody<{
      is_pinned?: boolean;
      is_archived?: boolean;
      is_muted?: boolean;
      mute_until_ms?: unknown;
      muted_until_ms?: unknown;
      unread_mark?: boolean;
      folder_id?: unknown;
      draft_text?: unknown;
    }>(ctx.req);

    const validatedMuteUntilMs = parseOptionalNonNegativeInt(
      body.mute_until_ms ?? body.muted_until_ms,
      'invalid_muted_until',
      'muted_until_ms must be a non-negative integer',
    );
    const hasFolderId = body.folder_id !== undefined;
    const validatedFolderId =
      hasFolderId && body.folder_id !== null
        ? parseOptionalNonNegativeInt(
            body.folder_id,
            'invalid_folder_id',
            'folder_id must be a non-negative integer or null',
          )!
        : null;
    if (
      body.draft_text !== undefined &&
      body.draft_text !== null &&
      typeof body.draft_text !== 'string'
    ) {
      throw new ApiError(400, 'invalid_draft', 'draft_text must be a string or null');
    }

    db.prepare(`INSERT OR IGNORE INTO user_chat_settings (user_id, chat_id) VALUES (?, ?)`).run(
      auth.userId,
      chatId,
    );

    if (body.is_pinned !== undefined) {
      db.prepare(`UPDATE user_chat_settings SET is_pinned = ? WHERE user_id = ? AND chat_id = ?`).run(
        body.is_pinned ? 1 : 0,
        auth.userId,
        chatId,
      );
    }
    if (body.is_archived !== undefined) {
      db.prepare(`UPDATE user_chat_settings SET is_archived = ? WHERE user_id = ? AND chat_id = ?`).run(
        body.is_archived ? 1 : 0,
        auth.userId,
        chatId,
      );
    }
    if (body.is_muted !== undefined || body.mute_until_ms !== undefined || body.muted_until_ms !== undefined) {
      if (body.is_muted !== undefined) {
        db.prepare(`UPDATE user_chat_settings SET is_muted = ?, mute_until_ms = ? WHERE user_id = ? AND chat_id = ?`).run(
          body.is_muted ? 1 : 0,
          validatedMuteUntilMs ?? null,
          auth.userId,
          chatId,
        );
      } else {
        db.prepare(`UPDATE user_chat_settings SET mute_until_ms = ? WHERE user_id = ? AND chat_id = ?`).run(
          validatedMuteUntilMs ?? null,
          auth.userId,
          chatId,
        );
      }
    }
    if (body.unread_mark !== undefined) {
      db.prepare(`UPDATE user_chat_settings SET unread_mark = ? WHERE user_id = ? AND chat_id = ?`).run(
        body.unread_mark ? 1 : 0,
        auth.userId,
        chatId,
      );
    }
    if (hasFolderId) {
      db.prepare(`UPDATE user_chat_settings SET folder_id = ? WHERE user_id = ? AND chat_id = ?`).run(
        validatedFolderId,
        auth.userId,
        chatId,
      );
    }
    if (body.draft_text !== undefined) {
      const draftObj: WireDraftDto | null =
        typeof body.draft_text === 'string' && body.draft_text.length > 0
          ? { chat_id: chatId, text: body.draft_text, entities: [], date_ms: Date.now() }
          : null;
      db.prepare(`UPDATE user_chat_settings SET draft_json = ? WHERE user_id = ? AND chat_id = ?`).run(
        draftObj ? JSON.stringify(draftObj) : null,
        auth.userId,
        chatId,
      );
    }

    const detail = getChatDetailDto(db, chatId, auth.userId)!;
    sendJson(ctx.res, 200, detail);
  };
  router.post('/api/v1/chats/:chatId/settings', handleUpdateChatSettings);
  router.patch('/api/v1/chats/:chatId/settings', handleUpdateChatSettings);
  router.post('/api/v1/chats/:chatId/pin', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    ensureChatMembership(db, chatId, auth.userId);
    const body = await readJsonBody<{ pinned?: boolean; is_pinned?: boolean }>(ctx.req);
    const pinned = body.pinned ?? body.is_pinned ?? true;
    db.prepare(`INSERT OR IGNORE INTO user_chat_settings (user_id, chat_id) VALUES (?, ?)`).run(auth.userId, chatId);
    db.prepare(`UPDATE user_chat_settings SET is_pinned = ? WHERE user_id = ? AND chat_id = ?`).run(pinned ? 1 : 0, auth.userId, chatId);
    sendJson(ctx.res, 200, getChatDetailDto(db, chatId, auth.userId));
  });
  router.post('/api/v1/chats/:chatId/archive', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    ensureChatMembership(db, chatId, auth.userId);
    const body = await readJsonBody<{ archived?: boolean; is_archived?: boolean }>(ctx.req);
    const archived = body.archived ?? body.is_archived ?? true;
    db.prepare(`INSERT OR IGNORE INTO user_chat_settings (user_id, chat_id) VALUES (?, ?)`).run(auth.userId, chatId);
    db.prepare(`UPDATE user_chat_settings SET is_archived = ? WHERE user_id = ? AND chat_id = ?`).run(archived ? 1 : 0, auth.userId, chatId);
    sendJson(ctx.res, 200, getChatDetailDto(db, chatId, auth.userId));
  });
  router.post('/api/v1/chats/:chatId/mute', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    ensureChatMembership(db, chatId, auth.userId);
    const body = await readJsonBody<{
      muted?: boolean;
      is_muted?: boolean;
      mute_until_ms?: unknown;
      muted_until_ms?: unknown;
    }>(ctx.req);
    const muteUntilMs = parseOptionalNonNegativeInt(
      body.mute_until_ms ?? body.muted_until_ms,
      'invalid_muted_until',
      'muted_until_ms must be a non-negative integer',
    );
    const muted = body.muted ?? body.is_muted ?? true;
    db.prepare(`INSERT OR IGNORE INTO user_chat_settings (user_id, chat_id) VALUES (?, ?)`).run(auth.userId, chatId);
    db.prepare(`UPDATE user_chat_settings SET is_muted = ?, mute_until_ms = ? WHERE user_id = ? AND chat_id = ?`).run(
      muted ? 1 : 0,
      muteUntilMs ?? null,
      auth.userId,
      chatId,
    );
    sendJson(ctx.res, 200, getChatDetailDto(db, chatId, auth.userId));
  });

  // Cloud Drafts CRUD
  router.get('/api/v1/chats/:chatId/draft', (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    ensureChatReadAccess(db, chatId, auth.userId);
    const detail = getChatDetailDto(db, chatId, auth.userId);
    sendJson(ctx.res, 200, { draft: detail?.draft ?? null });
  });

  router.put('/api/v1/chats/:chatId/draft', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    ensureChatMembership(db, chatId, auth.userId);
    const body = await readJsonBody<{
      text?: unknown;
      reply_to_msg_id?: unknown;
      quote_text?: unknown;
      topic_id?: unknown;
    }>(ctx.req);

    if (body.text !== undefined && body.text !== null && typeof body.text !== 'string') {
      throw new ApiError(400, 'invalid_draft', 'Draft text must be a string');
    }
    if (
      body.quote_text !== undefined &&
      body.quote_text !== null &&
      typeof body.quote_text !== 'string'
    ) {
      throw new ApiError(400, 'invalid_quote_text', 'quote_text must be a string');
    }
    const replyToMsgId = parseOptionalPositiveInt(
      body.reply_to_msg_id,
      'invalid_reply_to',
      'reply_to_msg_id must be a positive integer',
    );
    const topicId = parseOptionalPositiveInt(
      body.topic_id,
      'invalid_topic_id',
      'topic_id must be a positive integer',
    );

    const text = typeof body.text === 'string' ? body.text : '';
    const draft: WireDraftDto | null = text
      ? {
          chat_id: chatId,
          text,
          entities: [],
          reply_to_msg_id: replyToMsgId,
          quote_text: typeof body.quote_text === 'string' ? body.quote_text : undefined,
          topic_id: topicId,
          date_ms: Date.now(),
        }
      : null;

    db.prepare(`INSERT OR IGNORE INTO user_chat_settings (user_id, chat_id) VALUES (?, ?)`).run(
      auth.userId,
      chatId,
    );
    db.prepare(`UPDATE user_chat_settings SET draft_json = ? WHERE user_id = ? AND chat_id = ?`).run(
      draft ? JSON.stringify(draft) : null,
      auth.userId,
      chatId,
    );

    hub.sendToUser(auth.userId, {
      type: 'Update',
      payload: {
        type: 'DraftUpdated',
        data: { chat_id: chatId, topic_id: topicId ?? null, draft },
      },
    });
    sendJson(ctx.res, 200, { ok: true, draft });
  });

  router.delete('/api/v1/chats/:chatId/draft', (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    db.prepare(`UPDATE user_chat_settings SET draft_json = NULL WHERE user_id = ? AND chat_id = ?`).run(
      auth.userId,
      chatId,
    );
    sendJson(ctx.res, 200, { ok: true, draft: null });
  });

  // Per-chat TTL self-destruct timer & cleanup
  const handleSetChatTtl = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    ensureChatAdminAccess(db, chatId, auth.userId);
    const body = await readJsonBody<{ ttl_seconds?: unknown }>(ctx.req);
    const ttlSeconds =
      parseOptionalNonNegativeInt(
        body.ttl_seconds,
        'invalid_ttl',
        'ttl_seconds must be a non-negative integer',
      ) ?? 0;
    db.prepare(`UPDATE chats SET ttl_seconds = ? WHERE chat_id = ?`).run(ttlSeconds, chatId);
    recordChatAdminLog(db, {
      chatId,
      actorUserId: auth.userId,
      action: 'change_ttl',
      details: { ttl_seconds: ttlSeconds },
    });
    const purged = purgeExpiredTtlMessages(db, chatId);
    sendJson(ctx.res, 200, { ok: true, ttl_seconds: ttlSeconds, purged_count: purged.length });
  };
  router.post('/api/v1/chats/:chatId/ttl', handleSetChatTtl);
  router.put('/api/v1/chats/:chatId/ttl', handleSetChatTtl);

  const handleClearChatHistory = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    ensureChatMembership(db, chatId, auth.userId);
    const body = await readJsonBody<{ for_everyone?: boolean }>(ctx.req);
    if (body.for_everyone) {
      ensureChatAdminAccess(db, chatId, auth.userId);
      db.prepare(
        `UPDATE messages
         SET deleted_for_everyone = 1,
             text_plain = '',
             content_json = '{"type":"Text","data":{"text":"","entities":[]}}',
             entities_json = '[]'
         WHERE chat_id = ? AND scheduled_at_ms IS NULL`,
      ).run(chatId);
      refreshChatLastMessage(db, chatId);
      recordChatAdminLog(db, {
        chatId,
        actorUserId: auth.userId,
        action: 'clear_history',
        details: { for_everyone: true },
      });
    } else {
      const chatRow = db.prepare(`SELECT last_message_id FROM chats WHERE chat_id = ?`).get(chatId) as
        | { last_message_id: number }
        | undefined;
      db.prepare(`
        INSERT INTO user_chat_settings (user_id, chat_id, cleared_up_to_msg_id)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id, chat_id) DO UPDATE SET cleared_up_to_msg_id = excluded.cleared_up_to_msg_id
      `).run(auth.userId, chatId, Number(chatRow?.last_message_id ?? 0));
    }
    sendJson(ctx.res, 200, { ok: true });
  };
  router.post('/api/v1/chats/:chatId/history/clear', handleClearChatHistory);
  router.post('/api/v1/chats/:chatId/clear', handleClearChatHistory);

  // Send-As Identity
  router.get('/api/v1/chats/:chatId/send_as', (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    ensureChatMembership(db, chatId, auth.userId);
    const me = getUserProfileDto(db, auth.userId);
    const ownedChannels = db
      .prepare(
        `SELECT DISTINCT c.chat_id, c.title, c.username
         FROM chats c
         LEFT JOIN chat_members m ON m.chat_id = c.chat_id AND m.user_id = ?
         WHERE c.chat_type = 3
           AND (c.creator_id = ? OR m.role IN ('owner', 'admin'))`,
      )
      .all(auth.userId, auth.userId) as Array<{ chat_id: number; title: string; username: string | null }>;
    const detail = getChatDetailDto(db, chatId, auth.userId);
    sendJson(ctx.res, 200, {
      selected_peer_id: detail?.send_as_peer_id ?? auth.userId,
      options: [
        { peer_id: auth.userId, kind: 'user', title: [me?.first_name, me?.last_name].filter(Boolean).join(' ') },
        ...ownedChannels.map((ch) => ({ peer_id: ch.chat_id, kind: 'channel', title: ch.title, username: ch.username })),
      ],
    });
  });

  router.put('/api/v1/chats/:chatId/send_as', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    ensureChatMembership(db, chatId, auth.userId);
    const body = await readJsonBody<{ send_as_peer_id?: unknown }>(ctx.req);
    const peerId = validateSendAsPeerId(db, auth.userId, body.send_as_peer_id) ?? auth.userId;
    db.prepare(`
      INSERT INTO user_chat_settings (user_id, chat_id, send_as_peer_id)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, chat_id) DO UPDATE SET send_as_peer_id = excluded.send_as_peer_id
    `).run(auth.userId, chatId, peerId);
    sendJson(ctx.res, 200, { ok: true, selected_peer_id: peerId });
  });

  // 6. Chat Folders CRUD
  router.get('/api/v1/folders', (ctx) => {
    const auth = requireAuth(db, ctx);
    const rows = db
      .prepare(`SELECT folder_json FROM chat_folders WHERE user_id = ? ORDER BY sort_order ASC, folder_id ASC`)
      .all(auth.userId) as Array<{ folder_json: string }>;
    const folders = rows.map((r) => JSON.parse(r.folder_json) as ChatFolderDto);
    sendJson(ctx.res, 200, { folders });
  });

  const handleUpsertFolder = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<Record<string, unknown>>(ctx.req);
    if (body.title !== undefined && body.title !== null && typeof body.title !== 'string') {
      throw new ApiError(400, 'invalid_folder_title', 'Folder title must be a string');
    }
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) {
      throw new ApiError(400, 'invalid_folder_title', 'Folder title is required');
    }
    const rawIcon = body.emoticon ?? body.icon;
    if (rawIcon !== undefined && rawIcon !== null && typeof rawIcon !== 'string') {
      throw new ApiError(400, 'invalid_folder_icon', 'Folder icon must be a string');
    }
    const emoticon = typeof rawIcon === 'string' && rawIcon.trim() ? rawIcon.trim() : '📁';

    const includeChats =
      parseOptionalPositiveIntArray(
        body.include_chats ?? body.included_chat_ids,
        'invalid_folder_chats',
        'included_chat_ids must be an array of positive integers',
      ) ?? [];
    const excludeChats =
      parseOptionalPositiveIntArray(
        body.exclude_chats ?? body.excluded_chat_ids,
        'invalid_folder_chats',
        'excluded_chat_ids must be an array of positive integers',
      ) ?? [];
    const pinnedChats =
      parseOptionalPositiveIntArray(
        body.pinned_chats ?? body.pinned_chat_ids,
        'invalid_folder_chats',
        'pinned_chats must be an array of positive integers',
      ) ?? [];

    const sortOrderInput = parseOptionalNonNegativeInt(
      body.sort_order,
      'invalid_sort_order',
      'sort_order must be a non-negative integer',
    );

    let numericId = Number(ctx.params.folderId ?? body.id ?? body.folder_id);
    if (!Number.isFinite(numericId) || numericId <= 0) {
      const mx = db
        .prepare(`SELECT COALESCE(MAX(folder_id), 0) AS mx FROM chat_folders WHERE user_id = ?`)
        .get(auth.userId) as { mx: number };
      numericId = Number(mx.mx) + 1;
    }

    const dto: ChatFolderDto = {
      id: numericId,
      folder_id:
        typeof body.folder_id === 'string' || typeof body.folder_id === 'number'
          ? String(body.folder_id)
          : String(numericId),
      title,
      emoticon,
      include_chats: includeChats,
      included_chat_ids: includeChats,
      exclude_chats: excludeChats,
      excluded_chat_ids: excludeChats,
      pinned_chats: pinnedChats,
      include_contacts: Boolean(body.include_contacts),
      include_non_contacts: Boolean(body.include_non_contacts),
      include_groups: Boolean(body.include_groups),
      include_channels: Boolean(body.include_channels),
      include_bots: Boolean(body.include_bots),
      exclude_muted: Boolean(body.exclude_muted),
      exclude_read: Boolean(body.exclude_read),
      exclude_archived: body.exclude_archived !== undefined ? Boolean(body.exclude_archived) : true,
      sort_order: sortOrderInput ?? numericId,
    };

    db.prepare(`
      INSERT OR REPLACE INTO chat_folders (user_id, folder_id, title, emoticon, folder_json, sort_order)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(auth.userId, numericId, dto.title, dto.emoticon ?? null, JSON.stringify(dto), dto.sort_order);

    hub.sendToUser(auth.userId, {
      type: 'Update',
      payload: { type: 'FolderChanged', data: { folder: dto } },
    });
    sendJson(ctx.res, ctx.method === 'POST' ? 201 : 200, dto);
  };
  router.post('/api/v1/folders', handleUpsertFolder);
  router.put('/api/v1/folders/:folderId', handleUpsertFolder);
  router.patch('/api/v1/folders/:folderId', handleUpsertFolder);

  router.delete('/api/v1/folders/:folderId', (ctx) => {
    const auth = requireAuth(db, ctx);
    const fid = ctx.params.folderId!;
    db.prepare(
      `DELETE FROM chat_folders WHERE user_id = ? AND (CAST(folder_id AS TEXT) = ? OR LOWER(title) = LOWER(?))`,
    ).run(auth.userId, fid, fid);
    hub.sendToUser(auth.userId, {
      type: 'Update',
      payload: { type: 'FolderDeleted', data: { folder_id: fid } },
    });
    sendJson(ctx.res, 200, { ok: true });
  });

  // 7. Supergroup Forum Topics CRUD (non-admin create/update/close/delete strictly 403)
  router.get('/api/v1/chats/:chatId/topics', (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    ensureChatReadAccess(db, chatId, auth.userId);
    const rows = db
      .prepare(`SELECT * FROM forum_topics WHERE chat_id = ? ORDER BY is_pinned DESC, topic_id ASC`)
      .all(chatId) as Array<Record<string, unknown>>;

    const topics: ForumTopicDto[] = rows.map((r) => ({
      chat_id: chatId,
      topic_id: Number(r.topic_id),
      title: String(r.title),
      icon_color: Number(r.icon_color),
      icon_emoji: (r.icon_emoji as string | null) ?? undefined,
      creator_id: Number(r.creator_id),
      is_pinned: Boolean(r.is_pinned),
      is_closed: Boolean(r.is_closed),
      is_hidden: Boolean(r.is_hidden),
      last_message_id: r.last_message_id ? Number(r.last_message_id) : undefined,
      unread_count: 0,
      created_at_ms: Number(r.created_at_ms),
    }));
    sendJson(ctx.res, 200, { topics });
  });

  router.post('/api/v1/chats/:chatId/topics', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    ensureChatAdminAccess(db, chatId, auth.userId);
    const body = await readJsonBody<{ title?: unknown; icon_color?: unknown; icon_emoji?: unknown }>(ctx.req);
    if (body.title !== undefined && body.title !== null && typeof body.title !== 'string') {
      throw new ApiError(400, 'invalid_topic_title', 'Forum topic title must be a string');
    }
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) {
      throw new ApiError(400, 'invalid_topic_title', 'Forum topic title is required');
    }
    if (
      body.icon_emoji !== undefined &&
      body.icon_emoji !== null &&
      typeof body.icon_emoji !== 'string'
    ) {
      throw new ApiError(400, 'invalid_topic_emoji', 'icon_emoji must be a string');
    }
    const iconEmoji =
      typeof body.icon_emoji === 'string' && body.icon_emoji.trim() ? body.icon_emoji : '💬';
    const iconColor =
      parseOptionalNonNegativeInt(
        body.icon_color,
        'invalid_icon_color',
        'icon_color must be a non-negative integer',
      ) ?? 0x3390ec;

    const mx = db
      .prepare(`SELECT COALESCE(MAX(topic_id), 1) AS mx FROM forum_topics WHERE chat_id = ?`)
      .get(chatId) as { mx: number };
    const topicId = Number(mx.mx) + 1;
    const now = Date.now();

    db.prepare(`
      INSERT INTO forum_topics (
        chat_id, topic_id, title, icon_color, icon_emoji, creator_id, is_pinned, is_closed, is_hidden, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?)
    `).run(chatId, topicId, title, iconColor, iconEmoji, auth.userId, now);

    recordChatAdminLog(db, {
      chatId,
      actorUserId: auth.userId,
      action: 'create_topic',
      details: { topic_id: topicId, title },
    });

    const dto: ForumTopicDto = {
      chat_id: chatId,
      topic_id: topicId,
      title,
      icon_color: iconColor,
      icon_emoji: iconEmoji,
      creator_id: auth.userId,
      is_pinned: false,
      is_closed: false,
      is_hidden: false,
      unread_count: 0,
      created_at_ms: now,
    };
    hub.broadcastChatEphemeral(chatId, { type: 'ForumTopicChanged', data: { chat_id: chatId, topic: dto } });
    sendJson(ctx.res, 201, dto);
  });

  const handleUpdateTopic = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    const topicId = Number(ctx.params.topicId);
    ensureChatAdminAccess(db, chatId, auth.userId);
    const body = await readJsonBody<{ title?: unknown; is_closed?: boolean; is_pinned?: boolean }>(ctx.req);

    if (body.title !== undefined && body.title !== null) {
      if (typeof body.title !== 'string') {
        throw new ApiError(400, 'invalid_topic_title', 'Forum topic title must be a string');
      }
      if (body.title.trim()) {
        db.prepare(`UPDATE forum_topics SET title = ? WHERE chat_id = ? AND topic_id = ?`).run(
          body.title.trim(),
          chatId,
          topicId,
        );
      }
    }
    if (body.is_closed !== undefined) {
      db.prepare(`UPDATE forum_topics SET is_closed = ? WHERE chat_id = ? AND topic_id = ?`).run(
        body.is_closed ? 1 : 0,
        chatId,
        topicId,
      );
    }
    if (body.is_pinned !== undefined) {
      db.prepare(`UPDATE forum_topics SET is_pinned = ? WHERE chat_id = ? AND topic_id = ?`).run(
        body.is_pinned ? 1 : 0,
        chatId,
        topicId,
      );
    }

    const row = db
      .prepare(`SELECT * FROM forum_topics WHERE chat_id = ? AND topic_id = ?`)
      .get(chatId, topicId) as Record<string, unknown> | undefined;
    if (!row) throw new ApiError(404, 'topic_not_found', 'Forum topic not found');

    recordChatAdminLog(db, {
      chatId,
      actorUserId: auth.userId,
      action: 'edit_topic',
      details: {
        topic_id: topicId,
        title: String(row.title),
        is_closed: Boolean(row.is_closed),
        is_pinned: Boolean(row.is_pinned),
      },
    });

    const dto: ForumTopicDto = {
      chat_id: chatId,
      topic_id: topicId,
      title: String(row.title),
      icon_color: Number(row.icon_color),
      icon_emoji: (row.icon_emoji as string | null) ?? undefined,
      creator_id: Number(row.creator_id),
      is_pinned: Boolean(row.is_pinned),
      is_closed: Boolean(row.is_closed),
      is_hidden: Boolean(row.is_hidden),
      unread_count: 0,
      created_at_ms: Number(row.created_at_ms),
    };
    hub.broadcastChatEphemeral(chatId, { type: 'ForumTopicChanged', data: { chat_id: chatId, topic: dto } });
    sendJson(ctx.res, 200, dto);
  };
  router.patch('/api/v1/chats/:chatId/topics/:topicId', handleUpdateTopic);
  router.put('/api/v1/chats/:chatId/topics/:topicId', handleUpdateTopic);

  router.delete('/api/v1/chats/:chatId/topics/:topicId', (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    const topicId = Number(ctx.params.topicId);
    ensureChatAdminAccess(db, chatId, auth.userId);
    if (topicId === 1) {
      throw new ApiError(400, 'cannot_delete_general', 'Cannot delete #General forum topic');
    }
    db.prepare(`DELETE FROM forum_topics WHERE chat_id = ? AND topic_id = ?`).run(chatId, topicId);
    recordChatAdminLog(db, {
      chatId,
      actorUserId: auth.userId,
      action: 'delete_topic',
      details: { topic_id: topicId },
    });
    hub.broadcastChatEphemeral(chatId, { type: 'ForumTopicDeleted', data: { chat_id: chatId, topic_id: topicId } });
    sendJson(ctx.res, 200, { ok: true });
  });

  // 8. Contacts & `@username` Resolution (Zero phantom user fabrication)
  router.get('/api/v1/contacts', (ctx) => {
    const auth = requireAuth(db, ctx);
    const rows = db
      .prepare(
        `SELECT u.*, c.first_name AS contact_first_name, c.last_name AS contact_last_name
         FROM user_contacts c
         JOIN users u ON u.user_id = c.contact_user_id
         WHERE c.owner_user_id = ?
         ORDER BY c.first_name ASC`,
      )
      .all(auth.userId) as Array<Record<string, unknown>>;

    const contacts = rows.map((r) => ({
      ...mapUserRowToDto(r),
      first_name: String(r.contact_first_name ?? r.first_name),
      last_name: (r.contact_last_name as string | null) ?? (r.last_name as string | null) ?? undefined,
    }));
    sendJson(ctx.res, 200, { contacts, total: contacts.length });
  });

  const handleAddContact = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      user_id?: unknown;
      username?: unknown;
      phone?: unknown;
      first_name?: unknown;
      last_name?: unknown;
    }>(ctx.req);

    const parsedContactUserId = parseOptionalPositiveInt(
      body.user_id,
      'invalid_user_id',
      'user_id must be a positive integer',
    );
    let targetRow: Record<string, unknown> | undefined;
    if (parsedContactUserId !== undefined) {
      targetRow = db
        .prepare(`SELECT * FROM users WHERE user_id = ?`)
        .get(parsedContactUserId) as Record<string, unknown> | undefined;
    } else if (body.username !== undefined && body.username !== null) {
      if (typeof body.username !== 'string') {
        throw new ApiError(400, 'invalid_username', 'Contact username must be a string');
      }
      const clean = body.username.trim().replace(/^@/, '');
      if (clean) {
        targetRow = db
          .prepare(`SELECT * FROM users WHERE LOWER(username) = LOWER(?)`)
          .get(clean) as Record<string, unknown> | undefined;
      }
    } else if (body.phone !== undefined && body.phone !== null) {
      if (typeof body.phone !== 'string') {
        throw new ApiError(400, 'invalid_phone', 'Contact phone must be a string');
      }
      const cleanPhone = body.phone.trim();
      if (cleanPhone) {
        targetRow = db
          .prepare(`SELECT * FROM users WHERE phone = ?`)
          .get(cleanPhone) as Record<string, unknown> | undefined;
      }
    }

    if (!targetRow) {
      throw new ApiError(404, 'contact_target_not_found', 'Target user not found by ID, username, or phone');
    }

    const contactUserId = Number(targetRow.user_id);
    if (contactUserId === auth.userId) {
      throw new ApiError(400, 'cannot_add_self', 'Cannot add yourself as a contact');
    }

    if (body.first_name !== undefined && body.first_name !== null && typeof body.first_name !== 'string') {
      throw new ApiError(400, 'invalid_first_name', 'Contact first name must be a string');
    }
    if (body.last_name !== undefined && body.last_name !== null && typeof body.last_name !== 'string') {
      throw new ApiError(400, 'invalid_last_name', 'Contact last name must be a string');
    }
    const firstName =
      (typeof body.first_name === 'string' ? body.first_name.trim() : '') ||
      String(targetRow.first_name);
    const lastName =
      typeof body.last_name === 'string'
        ? body.last_name.trim()
        : ((targetRow.last_name as string | null) ?? null);

    db.prepare(`
      INSERT OR REPLACE INTO user_contacts (owner_user_id, contact_user_id, first_name, last_name, created_at_ms)
      VALUES (?, ?, ?, ?, ?)
    `).run(auth.userId, contactUserId, firstName, lastName, Date.now());

    sendJson(ctx.res, 201, {
      ...mapUserRowToDto(targetRow),
      first_name: firstName,
      last_name: lastName ?? undefined,
    });
  };
  router.post('/api/v1/contacts', handleAddContact);
  router.post('/api/v1/contacts/add', handleAddContact);

  router.delete('/api/v1/contacts/:contactId', (ctx) => {
    const auth = requireAuth(db, ctx);
    const contactId = Number(ctx.params.contactId);
    db.prepare(`DELETE FROM user_contacts WHERE owner_user_id = ? AND contact_user_id = ?`).run(
      auth.userId,
      contactId,
    );
    sendJson(ctx.res, 200, { ok: true });
  });

  router.get('/api/v1/peers/resolve', (ctx) => {
    const auth = requireAuth(db, ctx);
    const rawUsername = (ctx.query.get('username') ?? '').trim().replace(/^@/, '');
    if (!rawUsername) {
      throw new ApiError(400, 'missing_username', 'Query parameter ?username= is required');
    }

    const userRow = db
      .prepare(`SELECT * FROM users WHERE LOWER(username) = LOWER(?)`)
      .get(rawUsername) as Record<string, unknown> | undefined;
    if (userRow) {
      sendJson(ctx.res, 200, {
        peer_type: userRow.is_bot ? 'bot' : 'user',
        user: mapUserRowToDto(userRow),
      });
      return;
    }

    const chatRow = db
      .prepare(`SELECT chat_id FROM chats WHERE LOWER(username) = LOWER(?) AND chat_type IN (1, 2, 3)`)
      .get(rawUsername) as { chat_id: number } | undefined;
    if (chatRow) {
      sendJson(ctx.res, 200, {
        peer_type: 'chat',
        chat: getChatDetailDto(db, Number(chatRow.chat_id), auth.userId),
      });
      return;
    }

    throw new ApiError(404, 'username_not_found', `No user or public chat found for @${rawUsername}`);
  });

  // 9. Chat Members & Roles / Admin / Ban
  router.get('/api/v1/chats/:chatId/members', (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    ensureChatMembership(db, chatId, auth.userId);

    const rows = db
      .prepare(
        `SELECT m.*, u.username, u.first_name, u.last_name, u.avatar_media_id, u.is_bot, u.is_verified, u.is_premium, u.status, u.last_seen_ms
         FROM chat_members m
         JOIN users u ON u.user_id = m.user_id
         WHERE m.chat_id = ?
         ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.joined_at_ms ASC`,
      )
      .all(chatId) as Array<Record<string, unknown>>;

    const members: ChatMemberDto[] = rows.map((r) => ({
      user_id: Number(r.user_id),
      username: (r.username as string | null) ?? undefined,
      first_name: String(r.first_name),
      last_name: (r.last_name as string | null) ?? undefined,
      role: (r.role as ChatMemberDto['role']) ?? 'member',
      admin_rights: Number(r.admin_rights ?? 0),
      banned_rights: Number(r.banned_rights ?? 0),
      custom_title: (r.custom_title as string | null) ?? undefined,
      joined_at_ms: Number(r.joined_at_ms),
    }));

    const users = rows.map((r) => mapUserRowToDto(r));
    sendJson(ctx.res, 200, { members, users });
  });

  router.post('/api/v1/chats/:chatId/members', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    const access = ensureChatMembership(db, chatId, auth.userId);
    if (![1, 2, 3].includes(access.chatType)) {
      throw new ApiError(
        400,
        'invalid_chat_type',
        'Members can only be added to groups, supergroups, or channels',
      );
    }
    if (access.chatType === 3 && !access.isAdmin) {
      throw new ApiError(403, 'admin_required', 'Only channel owners or admins can add members');
    }
    const body = await readJsonBody<{ user_ids?: unknown; user_id?: unknown }>(ctx.req);
    const parsedUserIds = parseOptionalPositiveIntArray(
      body.user_ids,
      'invalid_user_ids',
      'user_ids must be an array of positive integers',
    );
    const parsedSingleUserId = parseOptionalPositiveInt(
      body.user_id,
      'invalid_user_id',
      'user_id must be a positive integer',
    );
    const ids = parsedUserIds ?? (parsedSingleUserId !== undefined ? [parsedSingleUserId] : []);
    const candidateIds: number[] = [];
    for (const uid of ids) {
      const u = getUserProfileDto(db, uid);
      if (!u) continue;
      const existing = db
        .prepare(`SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?`)
        .get(chatId, uid) as { role: string } | undefined;
      if (existing?.role === 'banned') {
        throw new ApiError(
          403,
          'banned_in_chat',
          `User ${uid} is banned in this chat; an admin must unban them first`,
        );
      }
      if (existing) {
        // Leave existing active member/admin/owner/restricted row untouched
        continue;
      }
      candidateIds.push(uid);
    }

    const added: number[] = [];
    const now = Date.now();
    for (const uid of candidateIds) {
      const res = db
        .prepare(`
          INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, admin_rights, banned_rights, joined_at_ms)
          VALUES (?, ?, 'member', 0, 0, ?)
        `)
        .run(chatId, uid, now);
      if (Number(res.changes) > 0) {
        added.push(uid);
      }
    }
    if (added.length > 0) {
      recordChatAdminLog(db, {
        chatId,
        actorUserId: auth.userId,
        action: 'add_members',
        targetUserId: added.length === 1 ? added[0]! : null,
        details: { user_ids: added },
      });
    }
    sendJson(ctx.res, 200, { ok: true, added });
  });

  const handleUpdateMemberRole = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    const targetUserId = Number(ctx.params.userId);
    const access = ensureChatAdminAccess(db, chatId, auth.userId);
    if (![1, 2, 3].includes(access.chatType)) {
      throw new ApiError(
        400,
        'invalid_chat_type',
        'Member roles can only be modified in groups, supergroups, or channels',
      );
    }
    if (!access.isAdmin) {
      throw new ApiError(403, 'admin_required', 'Only owners or admins can modify member roles');
    }

    const body = await readJsonBody<{
      role?: unknown;
      custom_title?: unknown;
      admin_rights?: unknown;
      banned_rights?: unknown;
    }>(ctx.req);

    if (
      body.custom_title !== undefined &&
      body.custom_title !== null &&
      typeof body.custom_title !== 'string'
    ) {
      throw new ApiError(400, 'invalid_custom_title', 'custom_title must be a string or null');
    }
    const customTitle = typeof body.custom_title === 'string' ? body.custom_title : null;
    const parsedAdminRights = parseOptionalNonNegativeInt(
      body.admin_rights,
      'invalid_admin_rights',
      'admin_rights must be a non-negative integer',
    );
    const parsedBannedRights = parseOptionalNonNegativeInt(
      body.banned_rights,
      'invalid_banned_rights',
      'banned_rights must be a non-negative integer',
    );

    const rawRole = body.role === undefined ? 'member' : body.role;
    if (typeof rawRole !== 'string' || !ALLOWED_MEMBER_ROLES.has(rawRole)) {
      throw new ApiError(
        400,
        'invalid_role',
        'Role must be one of: owner, admin, member, restricted, banned',
      );
    }
    const role = rawRole as ChatMemberDto['role'];

    if (role === 'owner' && !access.isOwner) {
      throw new ApiError(403, 'owner_required', 'Only the chat owner can assign the owner role');
    }

    const targetRoleRow = db
      .prepare(`SELECT role, joined_at_ms FROM chat_members WHERE chat_id = ? AND user_id = ?`)
      .get(chatId, targetUserId) as { role: string; joined_at_ms: number } | undefined;

    if ((targetRoleRow?.role === 'owner' || targetUserId === access.creatorId) && !access.isOwner) {
      throw new ApiError(403, 'owner_required', 'Admins cannot modify the chat owner');
    }

    const adminRights = parsedAdminRights ?? (role === 'owner' ? 255 : role === 'admin' ? 127 : 0);
    const bannedRights = parsedBannedRights ?? (role === 'banned' ? 255 : 0);
    const now = Date.now();

    if (!targetRoleRow) {
      if (role === 'banned') {
        const targetUser = getUserProfileDto(db, targetUserId);
        if (!targetUser) {
          throw new ApiError(404, 'member_not_found', 'Target user not found');
        }
        db.prepare(`
          INSERT INTO chat_members (chat_id, user_id, role, admin_rights, banned_rights, custom_title, joined_at_ms)
          VALUES (?, ?, 'banned', 0, ?, ?, ?)
        `).run(chatId, targetUserId, bannedRights, customTitle, now);
      } else {
        throw new ApiError(404, 'member_not_found', 'Target user is not a member of this chat');
      }
    } else {
      db.prepare(`
        UPDATE chat_members
        SET role = ?, custom_title = COALESCE(?, custom_title), admin_rights = ?, banned_rights = ?
        WHERE chat_id = ? AND user_id = ?
      `).run(role, customTitle, adminRights, bannedRights, chatId, targetUserId);
    }

    if (role === 'banned') {
      hub.unsubscribeUserFromChat(targetUserId, chatId);
    }

    recordChatAdminLog(db, {
      chatId,
      actorUserId: auth.userId,
      action: role === 'banned' ? 'ban_member' : 'update_member_role',
      targetUserId,
      details: {
        previous_role: targetRoleRow?.role ?? null,
        role,
        custom_title: customTitle ?? undefined,
      },
    });

    const u = getUserProfileDto(db, targetUserId);
    sendJson(ctx.res, 200, {
      user_id: targetUserId,
      username: u?.username,
      first_name: u?.first_name ?? 'User',
      last_name: u?.last_name,
      role,
      admin_rights: adminRights,
      banned_rights: bannedRights,
      custom_title: customTitle ?? undefined,
      joined_at_ms: targetRoleRow ? Number(targetRoleRow.joined_at_ms) : now,
    });
  };
  router.patch('/api/v1/chats/:chatId/members/:userId', handleUpdateMemberRole);
  router.put('/api/v1/chats/:chatId/members/:userId', handleUpdateMemberRole);

  router.delete('/api/v1/chats/:chatId/members/:userId', (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    const targetUserId = Number(ctx.params.userId);

    if (targetUserId === auth.userId) {
      const selfRow = db
        .prepare(`SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?`)
        .get(chatId, auth.userId) as { role: string } | undefined;
      if (selfRow?.role === 'banned') {
        throw new ApiError(403, 'banned_in_chat', 'Banned users cannot leave this chat');
      }
      ensureChatMembership(db, chatId, auth.userId);
      db.prepare(`DELETE FROM chat_members WHERE chat_id = ? AND user_id = ? AND role != 'banned'`).run(
        chatId,
        auth.userId,
      );
      hub.unsubscribeUserFromChat(auth.userId, chatId);
      sendJson(ctx.res, 200, { ok: true });
      return;
    }

    const access = ensureChatAdminAccess(db, chatId, auth.userId);
    if (![1, 2, 3].includes(access.chatType)) {
      throw new ApiError(
        400,
        'invalid_chat_type',
        'Members can only be removed from groups, supergroups, or channels',
      );
    }
    const targetRoleRow = db
      .prepare(`SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?`)
      .get(chatId, targetUserId) as { role: string } | undefined;
    if (!targetRoleRow) {
      throw new ApiError(404, 'member_not_found', 'Target user is not a member of this chat');
    }
    if ((targetRoleRow.role === 'owner' || targetUserId === access.creatorId) && !access.isOwner) {
      throw new ApiError(403, 'owner_required', 'Admins cannot remove the chat owner');
    }
    if (targetRoleRow.role === 'owner') {
      throw new ApiError(403, 'owner_required', 'Cannot remove the chat owner');
    }

    db.prepare(`DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?`).run(chatId, targetUserId);
    hub.unsubscribeUserFromChat(targetUserId, chatId);
    recordChatAdminLog(db, {
      chatId,
      actorUserId: auth.userId,
      action: 'remove_member',
      targetUserId,
      details: { previous_role: targetRoleRow.role },
    });
    sendJson(ctx.res, 200, { ok: true });
  });

  // 10. Invite Links (`create`, `list`, `revoke`, `join`)
  router.get('/api/v1/chats/:chatId/invites', (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    const access = ensureChatAdminAccess(db, chatId, auth.userId);
    if (![1, 2, 3].includes(access.chatType)) {
      throw new ApiError(
        400,
        'invalid_chat_type',
        'Invite links are only supported for groups and channels',
      );
    }
    const rows = db
      .prepare(`SELECT * FROM chat_invite_links WHERE chat_id = ? ORDER BY created_at_ms DESC`)
      .all(chatId) as Array<Record<string, unknown>>;

    const invites: InviteLinkDto[] = rows.map((r) => ({
      invite_id: String(r.invite_id),
      chat_id: Number(r.chat_id),
      creator_id: Number(r.creator_id),
      code: String(r.code),
      link: `https://t.me/+${r.code}`,
      title: (r.title as string | null) ?? undefined,
      usage_limit: r.usage_limit !== null ? Number(r.usage_limit) : null,
      usage_count: Number(r.usage_count),
      expire_date_ms: r.expire_date_ms !== null ? Number(r.expire_date_ms) : null,
      request_needed: Boolean(r.request_needed),
      is_revoked: Boolean(r.is_revoked),
      created_at_ms: Number(r.created_at_ms),
    }));
    sendJson(ctx.res, 200, { invites });
  });

  router.post('/api/v1/chats/:chatId/invites', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    const access = ensureChatAdminAccess(db, chatId, auth.userId);
    if (![1, 2, 3].includes(access.chatType)) {
      throw new ApiError(
        400,
        'invalid_chat_type',
        'Invite links are only supported for groups and channels',
      );
    }
    const body = await readJsonBody<{
      title?: unknown;
      usage_limit?: unknown;
      expire_at_ms?: unknown;
      expire_date_ms?: unknown;
      expires_in_secs?: unknown;
      creates_join_request?: boolean;
    }>(ctx.req);

    const inviteTitle = readOptionalTrimmedString(
      body.title,
      'invalid_invite_title',
      'Invite title must be a string',
    );
    const usageLimit = parseOptionalPositiveInt(
      body.usage_limit,
      'invalid_usage_limit',
      'usage_limit must be a positive integer',
    );
    const explicitExpireMs = parseOptionalPositiveInt(
      body.expire_at_ms ?? body.expire_date_ms,
      'invalid_expire_date',
      'expire_date_ms must be a positive integer',
    );
    const expiresInSecs = parseOptionalPositiveInt(
      body.expires_in_secs,
      'invalid_expire_date',
      'expires_in_secs must be a positive integer',
    );

    const code = crypto.randomBytes(8).toString('base64url');
    const inviteId = `inv_${code}`;
    const now = Date.now();
    const expireMs =
      explicitExpireMs ?? (expiresInSecs !== undefined ? now + expiresInSecs * 1000 : null);

    db.prepare(`
      INSERT INTO chat_invite_links (
        code, invite_id, chat_id, creator_id, title, usage_limit, usage_count,
        expire_date_ms, request_needed, is_revoked, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 0, ?)
    `).run(
      code,
      inviteId,
      chatId,
      auth.userId,
      inviteTitle || null,
      usageLimit ?? null,
      expireMs,
      body.creates_join_request ? 1 : 0,
      now,
    );

    recordChatAdminLog(db, {
      chatId,
      actorUserId: auth.userId,
      action: 'create_invite',
      details: { invite_id: inviteId, code, title: inviteTitle || undefined },
    });

    const dto: InviteLinkDto = {
      invite_id: inviteId,
      chat_id: chatId,
      creator_id: auth.userId,
      code,
      link: `https://t.me/+${code}`,
      title: inviteTitle || undefined,
      usage_limit: usageLimit ?? null,
      usage_count: 0,
      expire_date_ms: expireMs,
      request_needed: Boolean(body.creates_join_request),
      is_revoked: false,
      created_at_ms: now,
    };
    sendJson(ctx.res, 201, dto);
  });

  router.delete('/api/v1/chats/:chatId/invites/:code', (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    const access = ensureChatAdminAccess(db, chatId, auth.userId);
    if (![1, 2, 3].includes(access.chatType)) {
      throw new ApiError(
        400,
        'invalid_chat_type',
        'Invite links are only supported for groups and channels',
      );
    }
    const del = db
      .prepare(
        `UPDATE chat_invite_links SET is_revoked = 1 WHERE chat_id = ? AND code = ? AND is_revoked = 0`,
      )
      .run(chatId, ctx.params.code!);
    if (Number(del.changes) > 0) {
      recordChatAdminLog(db, {
        chatId,
        actorUserId: auth.userId,
        action: 'revoke_invite',
        details: { code: ctx.params.code! },
      });
    }
    sendJson(ctx.res, 200, { ok: true, revoked: true });
  });

  // 10b. Group / Channel Admin Log (`GET /api/v1/chats/:chatId/admin-log` & `/admin_log`)
  const handleGetAdminLog = (ctx: RequestContext): void => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId ?? 0);
    const access = ensureChatAdminAccess(db, chatId, auth.userId);
    if (![1, 2, 3].includes(access.chatType)) {
      throw new ApiError(
        400,
        'invalid_chat_type',
        'Admin log is only available for groups, supergroups, and channels',
      );
    }

    const limit = parseBoundedQueryInt(ctx.query.get('limit'), 50, 1, 100);
    const beforeIdRaw = ctx.query.get('before_id');
    const beforeId =
      beforeIdRaw !== null && beforeIdRaw.trim() !== ''
        ? parseOptionalPositiveInt(
            Number(beforeIdRaw),
            'invalid_before_id',
            'before_id must be a positive integer',
          )
        : undefined;
    const actionFilter = ctx.query.get('action')?.trim() || undefined;
    const actorIdRaw = ctx.query.get('actor_id');
    const actorId =
      actorIdRaw !== null && actorIdRaw.trim() !== ''
        ? parseOptionalPositiveInt(
            Number(actorIdRaw),
            'invalid_actor_id',
            'actor_id must be a positive integer',
          )
        : undefined;

    const clauses: string[] = ['chat_id = ?'];
    const args: Array<string | number> = [chatId];
    if (beforeId !== undefined) {
      clauses.push('event_id < ?');
      args.push(beforeId);
    }
    if (actionFilter) {
      clauses.push('action = ?');
      args.push(actionFilter);
    }
    if (actorId !== undefined) {
      clauses.push('actor_user_id = ?');
      args.push(actorId);
    }

    const totalRow = db
      .prepare(`SELECT COUNT(*) AS cnt FROM chat_admin_log WHERE ${clauses.join(' AND ')}`)
      .get(...args) as { cnt: number };

    const rows = db
      .prepare(
        `SELECT * FROM chat_admin_log
         WHERE ${clauses.join(' AND ')}
         ORDER BY event_id DESC
         LIMIT ?`,
      )
      .all(...args, limit) as Array<Record<string, unknown>>;

    const events: AdminLogEventDto[] = rows.map((r) => {
      const actorUserId = Number(r.actor_user_id);
      const targetUserId =
        r.target_user_id !== null && r.target_user_id !== undefined
          ? Number(r.target_user_id)
          : null;
      const targetMessageId =
        r.target_message_id !== null && r.target_message_id !== undefined
          ? Number(r.target_message_id)
          : null;
      let details: Record<string, unknown> = {};
      if (typeof r.details_json === 'string' && r.details_json) {
        try {
          const parsed = JSON.parse(r.details_json) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            details = parsed as Record<string, unknown>;
          }
        } catch {
          details = {};
        }
      }
      return {
        event_id: Number(r.event_id),
        chat_id: Number(r.chat_id),
        actor_user_id: actorUserId,
        actor: getUserProfileDto(db, actorUserId) ?? undefined,
        action: String(r.action),
        target_user_id: targetUserId,
        target_user: targetUserId ? getUserProfileDto(db, targetUserId) : null,
        target_message_id: targetMessageId,
        details,
        created_at_ms: Number(r.created_at_ms),
      };
    });

    sendJson(ctx.res, 200, {
      chat_id: chatId,
      events,
      total: Number(totalRow.cnt),
    });
  };
  router.get('/api/v1/chats/:chatId/admin-log', handleGetAdminLog);
  router.get('/api/v1/chats/:chatId/admin_log', handleGetAdminLog);

  const handleJoinByInvite = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    let rawCode = ctx.params.code ?? '';
    if (!rawCode) {
      const body = await readJsonBody<{
        invite_code?: unknown;
        code?: unknown;
        link?: unknown;
      }>(ctx.req);
      const candidate = body.invite_code ?? body.code ?? body.link;
      if (candidate !== undefined && candidate !== null && typeof candidate !== 'string') {
        throw new ApiError(400, 'invalid_invite_code', 'Invite code must be a string');
      }
      rawCode = typeof candidate === 'string' ? candidate.trim() : '';
    }
    const code = rawCode.replace(/^https?:\/\/[^/]+\//i, '').replace(/^\+/, '').trim();
    if (!code) {
      throw new ApiError(400, 'missing_invite_code', 'Invite code is required');
    }
    const inv = db
      .prepare(`SELECT * FROM chat_invite_links WHERE code = ?`)
      .get(code) as Record<string, unknown> | undefined;
    if (!inv) {
      throw new ApiError(404, 'invite_not_found', 'Invite link not found');
    }
    if (inv.is_revoked) {
      throw new ApiError(410, 'invite_revoked', 'Invite link has been revoked');
    }
    if (inv.expire_date_ms && Number(inv.expire_date_ms) < Date.now()) {
      throw new ApiError(410, 'invite_expired', 'Invite link has expired');
    }
    if (inv.usage_limit !== null && Number(inv.usage_count) >= Number(inv.usage_limit)) {
      throw new ApiError(400, 'invite_limit_reached', 'Invite link usage limit reached');
    }

    const chatId = Number(inv.chat_id);
    const chatRow = db
      .prepare(`SELECT chat_type FROM chats WHERE chat_id = ?`)
      .get(chatId) as { chat_type: number } | undefined;
    if (!chatRow || ![1, 2, 3].includes(Number(chatRow.chat_type))) {
      throw new ApiError(
        400,
        'invalid_chat_type',
        'Invite links are only supported for groups and channels',
      );
    }
    const existingMem = db
      .prepare(`SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?`)
      .get(chatId, auth.userId) as { role: string } | undefined;
    if (existingMem?.role === 'banned') {
      throw new ApiError(403, 'banned_in_chat', 'You are banned from this chat');
    }
    db.prepare(`
      INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, admin_rights, banned_rights, joined_at_ms)
      VALUES (?, ?, 'member', 0, 0, ?)
    `).run(chatId, auth.userId, Date.now());
    db.prepare(`UPDATE chat_invite_links SET usage_count = usage_count + 1 WHERE code = ?`).run(code);

    sendJson(ctx.res, 200, getChatDetailDto(db, chatId, auth.userId));
  };
  router.post('/api/v1/invites/:code/join', handleJoinByInvite);
  router.post('/api/v1/invites/join', handleJoinByInvite);
  router.post('/api/v1/chats/join/:code', handleJoinByInvite);

  // 11. Channel & Group Statistics Time-Series (Real SQLite Aggregates — zero fabricated stats)
  const handleChannelStats = (ctx: RequestContext): void => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    ensureChatMembership(db, chatId, auth.userId);
    const detail = getChatDetailDto(db, chatId, auth.userId);
    if (!detail) throw new ApiError(404, 'chat_not_found', 'Chat not found');

    const msgStats = db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(views), 0) AS sum_views,
                COALESCE(SUM(forwards), 0) AS sum_forwards
         FROM messages
         WHERE chat_id = ? AND deleted_for_everyone = 0 AND scheduled_at_ms IS NULL`,
      )
      .get(chatId) as { total: number; sum_views: number; sum_forwards: number };
    const reactionRows = db
      .prepare(
        `SELECT emoji, COUNT(*) AS cnt
         FROM message_reactions
         WHERE chat_id = ?
         GROUP BY emoji
         ORDER BY cnt DESC
         LIMIT 6`,
      )
      .all(chatId) as Array<{ emoji: string; cnt: number }>;

    const mutedCountRow = db
      .prepare(
        `SELECT COUNT(*) AS cnt
         FROM user_chat_settings
         WHERE chat_id = ? AND is_muted = 1`,
      )
      .get(chatId) as { cnt: number };

    const totalMessages = Number(msgStats.total);
    const viewsPerPost = totalMessages > 0 ? Math.round(Number(msgStats.sum_views) / totalMessages) : 0;
    const sharesPerPost = totalMessages > 0 ? Math.round(Number(msgStats.sum_forwards) / totalMessages) : 0;
    const nowDay = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    const windowStart = nowDay - 13 * 86_400_000;

    const msgDayRows = db
      .prepare(
        `SELECT (date_ms / 86400000) * 86400000 AS day_ms,
                COUNT(*) AS msgs,
                COALESCE(SUM(views), 0) AS views,
                COUNT(DISTINCT sender_id) AS active_senders
         FROM messages
         WHERE chat_id = ? AND deleted_for_everyone = 0 AND scheduled_at_ms IS NULL AND date_ms >= ?
         GROUP BY day_ms`,
      )
      .all(chatId, windowStart) as Array<{
      day_ms: number;
      msgs: number;
      views: number;
      active_senders: number;
    }>;

    const rxDayRows = db
      .prepare(
        `SELECT (created_at_ms / 86400000) * 86400000 AS day_ms, COUNT(*) AS cnt
         FROM message_reactions
         WHERE chat_id = ? AND created_at_ms >= ?
         GROUP BY day_ms`,
      )
      .all(chatId, windowStart) as Array<{ day_ms: number; cnt: number }>;

    const joinedRows = db
      .prepare(
        `SELECT joined_at_ms FROM chat_members WHERE chat_id = ? AND role != 'banned'`,
      )
      .all(chatId) as Array<{ joined_at_ms: number }>;

    const msgByDay = new Map<number, { msgs: number; views: number; active_senders: number }>();
    for (const r of msgDayRows) {
      msgByDay.set(Number(r.day_ms), {
        msgs: Number(r.msgs),
        views: Number(r.views),
        active_senders: Number(r.active_senders),
      });
    }
    const rxByDay = new Map<number, number>();
    for (const r of rxDayRows) {
      rxByDay.set(Number(r.day_ms), Number(r.cnt));
    }

    const dailySeries = Array.from({ length: 14 }, (_, idx) => {
      const ts = nowDay - (13 - idx) * 86_400_000;
      const dayEnd = ts + 86_400_000 - 1;
      const dayStr = new Date(ts).toISOString().slice(0, 10);
      const bucket = msgByDay.get(ts);
      const membersAtDay = joinedRows.filter((j) => Number(j.joined_at_ms) <= dayEnd).length;
      return {
        day: dayStr,
        date: dayStr,
        timestamp_ms: ts,
        messages: bucket?.msgs ?? 0,
        views: bucket?.views ?? 0,
        members: membersAtDay,
        reactions: rxByDay.get(ts) ?? 0,
        active_senders: bucket?.active_senders ?? 0,
      };
    });

    const sevenDaysAgo = nowDay - 6 * 86_400_000;
    const activePostersRow = db
      .prepare(
        `SELECT COUNT(DISTINCT sender_id) AS cnt
         FROM messages
         WHERE chat_id = ? AND deleted_for_everyone = 0 AND scheduled_at_ms IS NULL AND date_ms >= ?`,
      )
      .get(chatId, sevenDaysAgo) as { cnt: number };

    const members7dAgo = dailySeries[6]?.members ?? detail.member_count;
    const growthRatePct =
      members7dAgo > 0
        ? Number((((detail.member_count - members7dAgo) / members7dAgo) * 100).toFixed(1))
        : 0;
    const enabledNotifPct =
      detail.member_count > 0
        ? Number(
            (
              (Math.max(0, detail.member_count - Number(mutedCountRow.cnt)) /
                detail.member_count) *
              100
            ).toFixed(1),
          )
        : 0;

    const stats: ChannelStatisticsDto = {
      chat_id: chatId,
      title: detail.title,
      member_count: detail.member_count,
      total_messages: totalMessages,
      messages_last_7d: dailySeries.slice(-7).reduce((s, p) => s + p.messages, 0),
      views_per_post: viewsPerPost,
      shares_per_post: sharesPerPost,
      enabled_notifications_pct: enabledNotifPct,
      boosts_count: 0,
      total_reactions: reactionRows.reduce((s, r) => s + Number(r.cnt), 0),
      active_posters_7d: Number(activePostersRow.cnt),
      growth_rate_pct: growthRatePct,
      daily_series: dailySeries,
      daily_growth: dailySeries.map((d) => ({ date: d.day, members: d.members, views: d.views })),
      top_emojis: reactionRows.map((r) => [r.emoji, Number(r.cnt)]),
    };
    sendJson(ctx.res, 200, stats);
  };
  router.get('/api/v1/chats/:chatId/statistics', handleChannelStats);
  router.get('/api/v1/chats/:chatId/stats', handleChannelStats);

  // 12. JSON & Styled HTML Chat Export (`/api/v1/chats/:chatId/export?format=json|html`)
  router.get('/api/v1/chats/:chatId/export', (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    ensureChatMembership(db, chatId, auth.userId);
    const format = (ctx.query.get('format') ?? 'json').toLowerCase();

    const detail = getChatDetailDto(db, chatId, auth.userId);
    if (!detail) throw new ApiError(404, 'chat_not_found', 'Chat not found');

    const settings = db
      .prepare(`SELECT cleared_up_to_msg_id FROM user_chat_settings WHERE user_id = ? AND chat_id = ?`)
      .get(auth.userId, chatId) as { cleared_up_to_msg_id: number } | undefined;
    const clearedUpTo = Number(settings?.cleared_up_to_msg_id ?? 0);

    const msgRows = db
      .prepare(
        `SELECT * FROM messages m
         WHERE m.chat_id = ? AND m.message_id > ? AND m.deleted_for_everyone = 0 AND m.scheduled_at_ms IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM message_user_deletions d
             WHERE d.user_id = ? AND d.chat_id = m.chat_id AND d.message_id = m.message_id
           )
         ORDER BY m.message_id ASC`,
      )
      .all(chatId, clearedUpTo, auth.userId) as Array<Record<string, unknown>>;

    const messages = msgRows.map((r) => hydrateMessageRow(db, r, auth.userId));

    if (format === 'html') {
      const renderedItems = messages
        .map((m) => {
          const sender = getUserProfileDto(db, m.sender_id);
          const senderName = escapeHtml(
            sender ? [sender.first_name, sender.last_name].filter(Boolean).join(' ') : `User #${m.sender_id}`,
          );
          const bodyHtml = renderEntitiesToSafeHtml(m.text ?? '', m.entities ?? []);
          return `<article class="msg ${m.flags.is_out ? 'out' : 'in'}" data-message-id="${m.id}">
  <header><span class="author">${senderName}</span><time datetime="${escapeHtml(m.date)}">${escapeHtml(m.date)}</time></header>
  <div class="body">${bodyHtml}</div>
</article>`;
        })
        .join('\n');

      const htmlDoc = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(detail.title)} — Chat Export</title>
  <style>
    body { margin: 0; padding: 24px; background: #0E1621; color: #F5F5F5; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans SC", sans-serif; }
    main { max-width: 760px; margin: 0 auto; }
    h1 { font-size: 20px; margin: 0 0 16px; color: #3390EC; }
    .msg { padding: 12px 14px; border-radius: 12px; margin-bottom: 10px; background: #182533; }
    .msg.out { background: #2B5278; }
    .msg header { display: flex; justify-content: space-between; font-size: 12px; color: #8FA2B7; margin-bottom: 6px; }
    .msg .author { font-weight: 600; color: #64B5F6; }
    .msg .body { white-space: pre-wrap; line-height: 1.45; font-size: 14px; }
    code, pre { background: rgba(0, 0, 0, 0.28); border-radius: 4px; padding: 2px 5px; font-family: monospace; }
    blockquote { margin: 6px 0; padding-left: 10px; border-left: 3px solid #3390EC; }
    a { color: #64B5F6; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(detail.title)} (${messages.length} messages)</h1>
    ${renderedItems}
  </main>
</body>
</html>`;

      ctx.res.statusCode = 200;
      ctx.res.setHeader('Content-Type', 'text/html; charset=utf-8');
      ctx.res.setHeader(
        'Content-Disposition',
        `attachment; filename="chat-${chatId}-export.html"`,
      );
      ctx.res.end(htmlDoc);
      return;
    }

    ctx.res.statusCode = 200;
    ctx.res.setHeader('Content-Type', 'application/json; charset=utf-8');
    ctx.res.setHeader(
      'Content-Disposition',
      `attachment; filename="chat-${chatId}-export.json"`,
    );
    ctx.res.end(
      JSON.stringify(
        {
          exported_at: new Date().toISOString(),
          chat: detail,
          message_count: messages.length,
          messages,
        },
        null,
        2,
      ),
    );
  });
}
