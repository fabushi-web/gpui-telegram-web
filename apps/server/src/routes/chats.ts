import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  E2EE_SAFETY_EMOJIS,
  escapeHtml,
  renderEntitiesToSafeHtml,
  type ChannelStatisticsDto,
  type ChatDetailDto,
  type ChatFolderDto,
  type ChatMemberDto,
  type ForumTopicDto,
  type InviteLinkDto,
  type WireDraftDto,
} from '@gpui-telegram/protocol';
import { ensureUserBootstrapResources } from './auth.js';
import {
  ensureChatMembership,
  getChatDetailDto,
  getUserProfileDto,
  hydrateMessageRow,
  mapUserRowToDto,
  purgeExpiredTtlMessages,
  refreshChatLastMessage,
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

    // Ensure demo/new users always have Saved Messages
    ensureUserBootstrapResources(db, auth.userId);

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

    sendJson(ctx.res, 200, { chats, users });
  });

  // 2. Saved Messages (idempotent)
  router.post('/api/v1/chats/saved', (ctx) => {
    const auth = requireAuth(db, ctx);
    const savedChatId = ensureUserBootstrapResources(db, auth.userId);
    const detail = getChatDetailDto(db, savedChatId, auth.userId)!;
    sendJson(ctx.res, 200, detail);
  });

  // 3. Create Secret Chat (`chat_type = 4`)
  router.post('/api/v1/secret-chats', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      peer_user_id?: number;
      ttl_seconds?: number;
    }>(ctx.req);

    const peerUserId = Number(body.peer_user_id);
    const peerUser = getUserProfileDto(db, peerUserId);
    if (!peerUser) {
      throw new ApiError(404, 'peer_not_found', 'Target user for secret chat not found');
    }

    const now = Date.now();
    const chatId = getNextChatId(db);
    const ttlSeconds = Math.max(0, Math.trunc(Number(body.ttl_seconds ?? 30)));
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

  // 4. Create Chat (Private DM, Group, Supergroup/Forum, Channel)
  router.post('/api/v1/chats', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      title?: string;
      chat_type?: number | string;
      peer_user_id?: number;
      username?: string;
      about?: string;
      is_forum?: boolean;
      member_ids?: number[];
    }>(ctx.req);

    const rawType = body.chat_type ?? 1;
    const chatType =
      rawType === 'private' || rawType === 0
        ? 0
        : rawType === 'channel' || rawType === 3
          ? 3
          : rawType === 'supergroup' || rawType === 2 || body.is_forum
            ? 2
            : rawType === 'secret' || rawType === 4
              ? 4
              : 1;

    const now = Date.now();

    if (chatType === 0 && body.peer_user_id) {
      const peerId = Number(body.peer_user_id);
      if (peerId === auth.userId) {
        const savedId = ensureUserBootstrapResources(db, auth.userId);
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
        sendJson(ctx.res, 200, getChatDetailDto(db, Number(existingDm.chat_id), auth.userId));
        return;
      }

      const peer = getUserProfileDto(db, peerId);
      if (!peer) {
        throw new ApiError(404, 'user_not_found', 'Target peer user not found');
      }

      const chatId = getNextChatId(db);
      const kind = peer.is_bot ? 'bot' : 'private';
      const title = [peer.first_name, peer.last_name].filter(Boolean).join(' ');
      db.prepare(`
        INSERT INTO chats (
          chat_id, title, kind, chat_type, creator_id, peer_user_id, username, about,
          is_forum, is_verified, pts, next_msg_id, last_message_id, last_message_date_ms, created_at_ms
        ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, 0, ?, 0, 1, 0, ?, ?)
      `).run(chatId, title, kind, auth.userId, peerId, peer.username ?? null, peer.bio ?? null, peer.is_verified ? 1 : 0, now, now);

      db.prepare(`INSERT INTO chat_members (chat_id, user_id, role, joined_at_ms) VALUES (?, ?, 'member', ?)`).run(chatId, auth.userId, now);
      db.prepare(`INSERT INTO chat_members (chat_id, user_id, role, joined_at_ms) VALUES (?, ?, 'member', ?)`).run(chatId, peerId, now);
      sendJson(ctx.res, 201, getChatDetailDto(db, chatId, auth.userId));
      return;
    }

    const title = (body.title ?? '').trim();
    if (!title) {
      throw new ApiError(400, 'missing_title', 'Group or channel title cannot be empty');
    }

    if (body.username) {
      const dup = db
        .prepare(`SELECT chat_id FROM chats WHERE LOWER(username) = LOWER(?)`)
        .get(body.username.trim());
      if (dup) {
        throw new ApiError(409, 'username_taken', 'Chat username is already taken');
      }
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
      body.username?.trim() ?? null,
      body.about?.trim() ?? null,
      isForum ? 1 : 0,
      now,
      `${kind === 'channel' ? 'Channel' : 'Group'} created`,
      now,
    );

    db.prepare(`
      INSERT INTO chat_members (chat_id, user_id, role, admin_rights, banned_rights, joined_at_ms)
      VALUES (?, ?, 'owner', 255, 0, ?)
    `).run(chatId, auth.userId, now);

    for (const memberId of body.member_ids ?? []) {
      const uid = Number(memberId);
      if (uid !== auth.userId) {
        db.prepare(`
          INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, admin_rights, banned_rights, joined_at_ms)
          VALUES (?, ?, 'member', 0, 0, ?)
        `).run(chatId, uid, now);
      }
    }

    if (isForum) {
      db.prepare(`
        INSERT INTO forum_topics (
          chat_id, topic_id, title, icon_color, icon_emoji, creator_id, is_pinned, is_closed, is_hidden, created_at_ms
        ) VALUES (?, 1, 'General', 3379436, '💬', ?, 1, 0, 0, ?)
      `).run(chatId, auth.userId, now);
    }

    const detail = getChatDetailDto(db, chatId, auth.userId)!;
    for (const memberId of body.member_ids ?? []) {
      const uid = Number(memberId);
      if (uid !== auth.userId) {
        const peerDetail = getChatDetailDto(db, chatId, uid);
        if (peerDetail) {
          hub.sendToUser(uid, {
            type: 'Update',
            payload: { type: 'ChatUpdated', data: peerDetail },
          });
        }
      }
    }
    sendJson(ctx.res, 201, detail);
  });

  // 5. Single Chat Inspect, Patch, Delete/Leave, Settings, Draft, TTL, Clear History, Send-As
  router.get('/api/v1/chats/:chatId', (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    ensureChatMembership(db, chatId, auth.userId);
    const detail = getChatDetailDto(db, chatId, auth.userId);
    if (!detail) throw new ApiError(404, 'chat_not_found', 'Chat not found');
    sendJson(ctx.res, 200, detail);
  });

  const requireGroupAdminIfApplicable = (chatId: number, userId: number): void => {
    const chatMeta = db
      .prepare(`SELECT chat_type FROM chats WHERE chat_id = ?`)
      .get(chatId) as { chat_type: number } | undefined;
    if (chatMeta && [1, 2, 3].includes(Number(chatMeta.chat_type))) {
      const mem = db
        .prepare(`SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?`)
        .get(chatId, userId) as { role: string } | undefined;
      if (!mem || (mem.role !== 'owner' && mem.role !== 'admin')) {
        throw new ApiError(403, 'admin_required', 'Only chat owners or admins can perform this action');
      }
    }
  };

  router.patch('/api/v1/chats/:chatId', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    ensureChatMembership(db, chatId, auth.userId);
    requireGroupAdminIfApplicable(chatId, auth.userId);
    const body = await readJsonBody<{
      title?: string;
      about?: string;
      username?: string;
      photo_file_id?: string;
      slow_mode_seconds?: number;
      is_forum?: boolean;
    }>(ctx.req);

    if (body.title !== undefined) {
      if (!body.title.trim()) throw new ApiError(400, 'invalid_title', 'Title cannot be empty');
      db.prepare(`UPDATE chats SET title = ? WHERE chat_id = ?`).run(body.title.trim(), chatId);
    }
    if (body.about !== undefined) {
      db.prepare(`UPDATE chats SET about = ? WHERE chat_id = ?`).run(body.about, chatId);
    }
    if (body.username !== undefined) {
      db.prepare(`UPDATE chats SET username = ? WHERE chat_id = ?`).run(body.username.trim() || null, chatId);
    }
    if (body.photo_file_id !== undefined) {
      db.prepare(`UPDATE chats SET photo_file_id = ? WHERE chat_id = ?`).run(body.photo_file_id, chatId);
    }
    if (body.slow_mode_seconds !== undefined) {
      db.prepare(`UPDATE chats SET slow_mode_seconds = ? WHERE chat_id = ?`).run(
        Math.max(0, Number(body.slow_mode_seconds)),
        chatId,
      );
    }
    if (body.is_forum !== undefined) {
      db.prepare(`UPDATE chats SET is_forum = ? WHERE chat_id = ?`).run(body.is_forum ? 1 : 0, chatId);
    }

    const detail = getChatDetailDto(db, chatId, auth.userId)!;
    hub.broadcastChatEphemeral(chatId, { type: 'ChatUpdated', data: detail });
    sendJson(ctx.res, 200, detail);
  });

  const handleLeaveOrDeleteChat = (ctx: RequestContext): void => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    db.prepare(`DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?`).run(chatId, auth.userId);
    db.prepare(`DELETE FROM user_chat_settings WHERE chat_id = ? AND user_id = ?`).run(chatId, auth.userId);
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
      mute_until_ms?: number | null;
      unread_mark?: boolean;
      folder_id?: number | null;
      draft_text?: string | null;
    }>(ctx.req);

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
    if (body.is_muted !== undefined) {
      db.prepare(`UPDATE user_chat_settings SET is_muted = ?, mute_until_ms = ? WHERE user_id = ? AND chat_id = ?`).run(
        body.is_muted ? 1 : 0,
        body.mute_until_ms ?? null,
        auth.userId,
        chatId,
      );
    }
    if (body.unread_mark !== undefined) {
      db.prepare(`UPDATE user_chat_settings SET unread_mark = ? WHERE user_id = ? AND chat_id = ?`).run(
        body.unread_mark ? 1 : 0,
        auth.userId,
        chatId,
      );
    }
    if (body.folder_id !== undefined) {
      db.prepare(`UPDATE user_chat_settings SET folder_id = ? WHERE user_id = ? AND chat_id = ?`).run(
        body.folder_id,
        auth.userId,
        chatId,
      );
    }
    if (body.draft_text !== undefined) {
      const draftObj: WireDraftDto | null =
        body.draft_text && body.draft_text.length > 0
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

  // Cloud Drafts CRUD
  router.get('/api/v1/chats/:chatId/draft', (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    const detail = getChatDetailDto(db, chatId, auth.userId);
    sendJson(ctx.res, 200, { draft: detail?.draft ?? null });
  });

  router.put('/api/v1/chats/:chatId/draft', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    ensureChatMembership(db, chatId, auth.userId);
    const body = await readJsonBody<{
      text?: string;
      reply_to_msg_id?: number;
      quote_text?: string;
      topic_id?: number;
    }>(ctx.req);

    const text = body.text ?? '';
    const draft: WireDraftDto | null = text
      ? {
          chat_id: chatId,
          text,
          entities: [],
          reply_to_msg_id: body.reply_to_msg_id,
          quote_text: body.quote_text,
          topic_id: body.topic_id,
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
        data: { chat_id: chatId, topic_id: body.topic_id ?? null, draft },
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
    ensureChatMembership(db, chatId, auth.userId);
    const body = await readJsonBody<{ ttl_seconds?: number }>(ctx.req);
    const ttlSeconds = Math.max(0, Math.trunc(Number(body.ttl_seconds ?? 0)));
    db.prepare(`UPDATE chats SET ttl_seconds = ? WHERE chat_id = ?`).run(ttlSeconds, chatId);
    const purged = purgeExpiredTtlMessages(db, chatId);
    sendJson(ctx.res, 200, { ok: true, ttl_seconds: ttlSeconds, purged_count: purged.length });
  };
  router.post('/api/v1/chats/:chatId/ttl', handleSetChatTtl);
  router.put('/api/v1/chats/:chatId/ttl', handleSetChatTtl);

  router.post('/api/v1/chats/:chatId/history/clear', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    ensureChatMembership(db, chatId, auth.userId);
    const body = await readJsonBody<{ for_everyone?: boolean }>(ctx.req);
    if (body.for_everyone) {
      requireGroupAdminIfApplicable(chatId, auth.userId);
      db.prepare(
        `UPDATE messages
         SET deleted_for_everyone = 1,
             text_plain = '',
             content_json = '{"type":"Text","data":{"text":"","entities":[]}}',
             entities_json = '[]'
         WHERE chat_id = ?`,
      ).run(chatId);
      refreshChatLastMessage(db, chatId);
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
  });

  // Send-As Identity
  router.get('/api/v1/chats/:chatId/send_as', (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    const me = getUserProfileDto(db, auth.userId);
    const ownedChannels = db
      .prepare(`SELECT chat_id, title, username FROM chats WHERE creator_id = ? AND chat_type = 3`)
      .all(auth.userId) as Array<{ chat_id: number; title: string; username: string | null }>;
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
    const body = await readJsonBody<{ send_as_peer_id?: number }>(ctx.req);
    const peerId = Number(body.send_as_peer_id ?? auth.userId);
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
    const body = await readJsonBody<Partial<ChatFolderDto> & { title?: string }>(ctx.req);
    const title = (body.title ?? '').trim();
    if (!title) {
      throw new ApiError(400, 'invalid_folder_title', 'Folder title is required');
    }

    let numericId = Number(ctx.params.folderId ?? body.id ?? body.folder_id);
    if (!Number.isFinite(numericId) || numericId <= 0) {
      const mx = db
        .prepare(`SELECT COALESCE(MAX(folder_id), 0) AS mx FROM chat_folders WHERE user_id = ?`)
        .get(auth.userId) as { mx: number };
      numericId = Number(mx.mx) + 1;
    }

    const dto: ChatFolderDto = {
      id: numericId,
      folder_id: String(body.folder_id ?? numericId),
      title,
      emoticon: body.emoticon ?? body.icon ?? '📁',
      include_chats: body.include_chats ?? body.included_chat_ids ?? [],
      included_chat_ids: body.included_chat_ids ?? body.include_chats ?? [],
      exclude_chats: body.exclude_chats ?? body.excluded_chat_ids ?? [],
      excluded_chat_ids: body.excluded_chat_ids ?? body.exclude_chats ?? [],
      pinned_chats: body.pinned_chats ?? body.pinned_chat_ids ?? [],
      include_contacts: Boolean(body.include_contacts),
      include_non_contacts: Boolean(body.include_non_contacts),
      include_groups: Boolean(body.include_groups),
      include_channels: Boolean(body.include_channels),
      include_bots: Boolean(body.include_bots),
      exclude_muted: Boolean(body.exclude_muted),
      exclude_read: Boolean(body.exclude_read),
      exclude_archived: body.exclude_archived ?? true,
      sort_order: Number(body.sort_order ?? numericId),
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

  // 7. Supergroup Forum Topics CRUD
  router.get('/api/v1/chats/:chatId/topics', (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    ensureChatMembership(db, chatId, auth.userId);
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
    ensureChatMembership(db, chatId, auth.userId);
    const body = await readJsonBody<{ title?: string; icon_color?: number; icon_emoji?: string }>(ctx.req);
    const title = (body.title ?? '').trim();
    if (!title) {
      throw new ApiError(400, 'invalid_topic_title', 'Forum topic title is required');
    }

    const mx = db
      .prepare(`SELECT COALESCE(MAX(topic_id), 1) AS mx FROM forum_topics WHERE chat_id = ?`)
      .get(chatId) as { mx: number };
    const topicId = Number(mx.mx) + 1;
    const now = Date.now();
    const iconColor = Number(body.icon_color ?? 0x3390ec);

    db.prepare(`
      INSERT INTO forum_topics (
        chat_id, topic_id, title, icon_color, icon_emoji, creator_id, is_pinned, is_closed, is_hidden, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?)
    `).run(chatId, topicId, title, iconColor, body.icon_emoji ?? '💬', auth.userId, now);

    const dto: ForumTopicDto = {
      chat_id: chatId,
      topic_id: topicId,
      title,
      icon_color: iconColor,
      icon_emoji: body.icon_emoji ?? '💬',
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

  router.patch('/api/v1/chats/:chatId/topics/:topicId', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    const topicId = Number(ctx.params.topicId);
    ensureChatMembership(db, chatId, auth.userId);
    const body = await readJsonBody<{ title?: string; is_closed?: boolean; is_pinned?: boolean }>(ctx.req);

    if (body.title !== undefined && body.title.trim()) {
      db.prepare(`UPDATE forum_topics SET title = ? WHERE chat_id = ? AND topic_id = ?`).run(
        body.title.trim(),
        chatId,
        topicId,
      );
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
  });

  router.delete('/api/v1/chats/:chatId/topics/:topicId', (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    const topicId = Number(ctx.params.topicId);
    ensureChatMembership(db, chatId, auth.userId);
    if (topicId === 1) {
      throw new ApiError(400, 'cannot_delete_general', 'Cannot delete #General forum topic');
    }
    db.prepare(`DELETE FROM forum_topics WHERE chat_id = ? AND topic_id = ?`).run(chatId, topicId);
    hub.broadcastChatEphemeral(chatId, { type: 'ForumTopicDeleted', data: { chat_id: chatId, topic_id: topicId } });
    sendJson(ctx.res, 200, { ok: true });
  });

  // 8. Contacts & `@username` Resolution
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
    sendJson(ctx.res, 200, { contacts });
  });

  router.post('/api/v1/contacts', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      user_id?: number;
      username?: string;
      phone?: string;
      first_name?: string;
      last_name?: string;
    }>(ctx.req);

    let targetRow: Record<string, unknown> | undefined;
    if (body.user_id) {
      targetRow = db.prepare(`SELECT * FROM users WHERE user_id = ?`).get(Number(body.user_id)) as Record<string, unknown> | undefined;
    } else if (body.username) {
      const clean = body.username.trim().replace(/^@/, '');
      targetRow = db.prepare(`SELECT * FROM users WHERE LOWER(username) = LOWER(?)`).get(clean) as Record<string, unknown> | undefined;
    } else if (body.phone) {
      targetRow = db.prepare(`SELECT * FROM users WHERE phone = ?`).get(body.phone.trim()) as Record<string, unknown> | undefined;
    }

    if (!targetRow && !body.user_id && (body.phone || body.username || body.first_name)) {
      const mx = db
        .prepare(`SELECT COALESCE(MAX(user_id), 2000) AS mx FROM users WHERE user_id < 700000`)
        .get() as { mx: number };
      const newUserId = Math.max(2001, Number(mx.mx) + 1);
      const cleanUsername = body.username ? body.username.trim().replace(/^@+/, '') : null;
      const cleanPhone = body.phone ? body.phone.trim() : null;
      const newFirst =
        body.first_name?.trim() || cleanUsername || cleanPhone || `Contact ${newUserId}`;
      const newLast = body.last_name?.trim() || null;
      const now = Date.now();

      db.prepare(`
        INSERT INTO users (
          user_id, username, phone, first_name, last_name, is_bot, is_verified, is_premium,
          status, last_seen_ms, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 'offline', ?, ?)
      `).run(newUserId, cleanUsername, cleanPhone, newFirst, newLast, now, now);

      targetRow = db
        .prepare(`SELECT * FROM users WHERE user_id = ?`)
        .get(newUserId) as Record<string, unknown> | undefined;
    }

    if (!targetRow) {
      throw new ApiError(404, 'contact_target_not_found', 'Target user not found by ID, username, or phone');
    }

    const contactUserId = Number(targetRow.user_id);
    const firstName = body.first_name?.trim() || String(targetRow.first_name);
    const lastName = body.last_name?.trim() ?? (targetRow.last_name as string | null);

    db.prepare(`
      INSERT OR REPLACE INTO user_contacts (owner_user_id, contact_user_id, first_name, last_name, created_at_ms)
      VALUES (?, ?, ?, ?, ?)
    `).run(auth.userId, contactUserId, firstName, lastName, Date.now());

    sendJson(ctx.res, 201, {
      ...mapUserRowToDto(targetRow),
      first_name: firstName,
      last_name: lastName ?? undefined,
    });
  });

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
      .prepare(`SELECT chat_id FROM chats WHERE LOWER(username) = LOWER(?)`)
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
    ensureChatMembership(db, chatId, auth.userId);
    const body = await readJsonBody<{ user_ids?: number[]; user_id?: number }>(ctx.req);
    const ids = body.user_ids ?? (body.user_id ? [body.user_id] : []);
    const added: number[] = [];
    const now = Date.now();

    for (const rawId of ids) {
      const uid = Number(rawId);
      const u = getUserProfileDto(db, uid);
      if (!u) continue;
      db.prepare(`
        INSERT OR REPLACE INTO chat_members (chat_id, user_id, role, admin_rights, banned_rights, joined_at_ms)
        VALUES (?, ?, 'member', 0, 0, ?)
      `).run(chatId, uid, now);
      added.push(uid);
    }
    sendJson(ctx.res, 200, { ok: true, added });
  });

  router.patch('/api/v1/chats/:chatId/members/:userId', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    const targetUserId = Number(ctx.params.userId);
    ensureChatMembership(db, chatId, auth.userId);

    const callerRoleRow = db
      .prepare(`SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?`)
      .get(chatId, auth.userId) as { role: string } | undefined;
    if (!callerRoleRow || (callerRoleRow.role !== 'owner' && callerRoleRow.role !== 'admin')) {
      throw new ApiError(403, 'admin_required', 'Only owners or admins can modify member roles');
    }

    const targetRoleRow = db
      .prepare(`SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?`)
      .get(chatId, targetUserId) as { role: string } | undefined;
    if (targetRoleRow?.role === 'owner' && callerRoleRow.role !== 'owner') {
      throw new ApiError(403, 'cannot_modify_owner', 'Admins cannot modify the chat owner');
    }

    const body = await readJsonBody<{
      role?: ChatMemberDto['role'];
      custom_title?: string;
      admin_rights?: number;
      banned_rights?: number;
    }>(ctx.req);

    const role = body.role ?? 'member';
    const adminRights = body.admin_rights ?? (role === 'admin' || role === 'owner' ? 127 : 0);
    const bannedRights = body.banned_rights ?? (role === 'banned' ? 255 : 0);

    db.prepare(`
      UPDATE chat_members
      SET role = ?, custom_title = COALESCE(?, custom_title), admin_rights = ?, banned_rights = ?
      WHERE chat_id = ? AND user_id = ?
    `).run(role, body.custom_title ?? null, adminRights, bannedRights, chatId, targetUserId);

    const u = getUserProfileDto(db, targetUserId);
    sendJson(ctx.res, 200, {
      user_id: targetUserId,
      username: u?.username,
      first_name: u?.first_name ?? 'User',
      last_name: u?.last_name,
      role,
      admin_rights: adminRights,
      banned_rights: bannedRights,
      custom_title: body.custom_title,
      joined_at_ms: Date.now(),
    });
  });

  router.delete('/api/v1/chats/:chatId/members/:userId', (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    const targetUserId = Number(ctx.params.userId);
    ensureChatMembership(db, chatId, auth.userId);

    if (targetUserId !== auth.userId) {
      const callerRoleRow = db
        .prepare(`SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?`)
        .get(chatId, auth.userId) as { role: string } | undefined;
      if (!callerRoleRow || (callerRoleRow.role !== 'owner' && callerRoleRow.role !== 'admin')) {
        throw new ApiError(403, 'admin_required', 'Only owners or admins can remove members');
      }
      const targetRoleRow = db
        .prepare(`SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?`)
        .get(chatId, targetUserId) as { role: string } | undefined;
      if (targetRoleRow?.role === 'owner') {
        throw new ApiError(403, 'cannot_remove_owner', 'Cannot remove the chat owner');
      }
    }

    db.prepare(`DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?`).run(chatId, targetUserId);
    sendJson(ctx.res, 200, { ok: true });
  });

  // 10. Invite Links (`create`, `list`, `revoke`, `join`)
  router.get('/api/v1/chats/:chatId/invites', (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    ensureChatMembership(db, chatId, auth.userId);
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
    ensureChatMembership(db, chatId, auth.userId);
    const body = await readJsonBody<{
      title?: string;
      usage_limit?: number;
      expire_at_ms?: number;
      expire_date_ms?: number;
      creates_join_request?: boolean;
    }>(ctx.req);

    const code = crypto.randomBytes(8).toString('base64url');
    const inviteId = `inv_${code}`;
    const now = Date.now();
    const expireMs = body.expire_at_ms ?? body.expire_date_ms ?? null;

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
      body.title ?? null,
      body.usage_limit ?? null,
      expireMs,
      body.creates_join_request ? 1 : 0,
      now,
    );

    const dto: InviteLinkDto = {
      invite_id: inviteId,
      chat_id: chatId,
      creator_id: auth.userId,
      code,
      link: `https://t.me/+${code}`,
      title: body.title,
      usage_limit: body.usage_limit ?? null,
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
    ensureChatMembership(db, chatId, auth.userId);
    db.prepare(`UPDATE chat_invite_links SET is_revoked = 1 WHERE chat_id = ? AND code = ?`).run(
      chatId,
      ctx.params.code!,
    );
    sendJson(ctx.res, 200, { ok: true, revoked: true });
  });

  const handleJoinByInvite = (ctx: RequestContext): void => {
    const auth = requireAuth(db, ctx);
    const code = ctx.params.code!.replace(/^\+/, '');
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
    db.prepare(`
      INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, admin_rights, banned_rights, joined_at_ms)
      VALUES (?, ?, 'member', 0, 0, ?)
    `).run(chatId, auth.userId, Date.now());
    db.prepare(`UPDATE chat_invite_links SET usage_count = usage_count + 1 WHERE code = ?`).run(code);

    sendJson(ctx.res, 200, getChatDetailDto(db, chatId, auth.userId));
  };
  router.post('/api/v1/invites/:code/join', handleJoinByInvite);
  router.post('/api/v1/chats/join/:code', handleJoinByInvite);

  // 11. Channel & Group Statistics Time-Series
  const handleChannelStats = (ctx: RequestContext): void => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    ensureChatMembership(db, chatId, auth.userId);
    const detail = getChatDetailDto(db, chatId, auth.userId);
    if (!detail) throw new ApiError(404, 'chat_not_found', 'Chat not found');

    const msgStats = db
      .prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(views), 0) AS sum_views FROM messages WHERE chat_id = ? AND deleted_for_everyone = 0`)
      .get(chatId) as { total: number; sum_views: number };
    const reactionRows = db
      .prepare(`SELECT emoji, COUNT(*) AS cnt FROM message_reactions WHERE chat_id = ? GROUP BY emoji ORDER BY cnt DESC LIMIT 6`)
      .all(chatId) as Array<{ emoji: string; cnt: number }>;

    const totalMessages = Number(msgStats.total);
    const viewsPerPost = totalMessages > 0 ? Math.round(Number(msgStats.sum_views) / totalMessages) : 0;
    const nowDay = Math.floor(Date.now() / 86_400_000) * 86_400_000;

    const dailySeries = Array.from({ length: 14 }, (_, idx) => {
      const ts = nowDay - (13 - idx) * 86_400_000;
      const dayStr = new Date(ts).toISOString().slice(0, 10);
      const msgs = Math.max(1, ((chatId + idx * 3) % 9) + 1);
      const views = msgs * Math.max(12, viewsPerPost || 45);
      const members = Math.max(1, detail.member_count - (13 - idx > detail.member_count ? 0 : Math.floor((13 - idx) / 4)));
      return {
        day: dayStr,
        date: dayStr,
        timestamp_ms: ts,
        messages: msgs,
        views,
        members,
        reactions: Math.max(0, msgs - 1),
        active_senders: Math.min(detail.member_count, 3),
      };
    });

    const stats: ChannelStatisticsDto = {
      chat_id: chatId,
      title: detail.title,
      member_count: detail.member_count,
      total_messages: totalMessages,
      messages_last_7d: dailySeries.slice(-7).reduce((s, p) => s + p.messages, 0),
      views_per_post: viewsPerPost,
      shares_per_post: Math.max(1, Math.floor(viewsPerPost / 18)),
      enabled_notifications_pct: 74.5,
      boosts_count: 12,
      total_reactions: reactionRows.reduce((s, r) => s + Number(r.cnt), 0),
      active_posters_7d: Math.min(detail.member_count, 4),
      growth_rate_pct: 8.4,
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
         WHERE m.chat_id = ? AND m.message_id > ? AND m.deleted_for_everyone = 0
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
