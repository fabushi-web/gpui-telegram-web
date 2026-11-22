import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  fromWireMessageEntity,
  parseMarkdownEntities,
  toWireMessageEntity,
  type GlobalSearchResponse,
  type InvoiceCard,
  type MessageContent,
  type MessageEntity,
  type MessageItem,
  type MiniAppEntry,
  type PollData,
  type PollOption,
  type SearchHitDto,
  type SearchTabCategory,
  type TodoListCard,
  type WireMessageEntity,
} from '@gpui-telegram/protocol';
import {
  castPollVoteAtomic,
  commitPtsEventAtomic,
  computeChatDifference,
  createMessageAtomic,
  deleteMessagesAtomic,
  editMessageAtomic,
  ensureChatMembership,
  getChatDetailDto,
  getMessageById,
  getMessageReactions,
  getUserProfileDto,
  hydrateMessageRow,
  lookupWalletIdempotency,
  mapUserRowToDto,
  purgeExpiredTtlMessages,
  recomputePollState,
  storeWalletIdempotency,
} from '../db/queries.js';
import {
  buildHighlightedSnippet,
  escapeSqlLikePattern,
  parseSearchQuery,
} from '../utils/cjkSearch.js';
import {
  ApiError,
  readJsonBody,
  requireAuth,
  sendJson,
  type HttpRouter,
  type RequestContext,
} from '../utils/http.js';
import type { ServerConfig } from '../config.js';
import type { RealtimeGatewayHub } from '../ws/hub.js';
import { runConfiguredLlmCompletion } from './magpie.js';

export type BotMessageInterceptor = (
  chatId: number,
  senderId: number,
  text: string,
) => void;

export function registerMessageAndSearchRoutes(
  router: HttpRouter,
  db: DatabaseSync,
  hub: RealtimeGatewayHub,
  onBotMessage: BotMessageInterceptor,
  config?: ServerConfig,
): void {
  // 1. Sync State & Difference Endpoints
  router.get('/api/v1/sync/state', (ctx) => {
    const auth = requireAuth(db, ctx);
    const rows = db
      .prepare(
        `SELECT c.chat_id, c.pts, c.last_message_id
         FROM chats c
         JOIN chat_members m ON m.chat_id = c.chat_id AND m.user_id = ? AND m.role != 'banned'`,
      )
      .all(auth.userId) as Array<{ chat_id: number; pts: number; last_message_id: number }>;
    sendJson(ctx.res, 200, {
      chats: rows,
      server_time_ms: Date.now(),
    });
  });

  const handleGetDifference = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const body =
      ctx.method === 'GET'
        ? {
            chat_id: Number(ctx.query.get('chat_id') ?? 0),
            from_pts: Number(ctx.query.get('from_pts') ?? ctx.query.get('pts') ?? 0),
            limit: ctx.query.get('limit') ? Number(ctx.query.get('limit')) : undefined,
          }
        : await readJsonBody<{
            chat_id: number;
            pts?: number;
            from_pts?: number;
            limit?: number;
            pts_total_limit?: number;
          }>(ctx.req);

    const diff = computeChatDifference(db, auth.userId, body);
    sendJson(ctx.res, 200, diff);
  };
  router.post('/api/v1/sync/get_difference', handleGetDifference);
  router.get('/api/v1/sync/get_difference', handleGetDifference);
  router.post('/api/v1/sync/difference', handleGetDifference);
  router.get('/api/v1/sync/difference', handleGetDifference);

  // 2. List Messages (`limit`, `before_id`, `after_id`, `around_id`, `topic_id`, `media_filter`)
  router.get('/api/v1/chats/:chatId/messages', (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    ensureChatMembership(db, chatId, auth.userId);
    purgeExpiredTtlMessages(db, chatId);

    const limit = Math.min(200, Math.max(1, Number(ctx.query.get('limit') ?? 50)));
    const beforeId = ctx.query.get('before_id') ? Number(ctx.query.get('before_id')) : undefined;
    const afterId = ctx.query.get('after_id') ? Number(ctx.query.get('after_id')) : undefined;
    const aroundId = ctx.query.get('around_id') ? Number(ctx.query.get('around_id')) : undefined;
    const topicId = ctx.query.get('topic_id') ? Number(ctx.query.get('topic_id')) : undefined;
    const mediaFilter = ctx.query.get('media_filter')?.toLowerCase();

    const settings = db
      .prepare(`SELECT cleared_up_to_msg_id FROM user_chat_settings WHERE user_id = ? AND chat_id = ?`)
      .get(auth.userId, chatId) as { cleared_up_to_msg_id: number } | undefined;
    const clearedUpTo = Number(settings?.cleared_up_to_msg_id ?? 0);

    const clauses: string[] = [
      'm.chat_id = ?',
      'm.message_id > ?',
      'm.deleted_for_everyone = 0',
      'NOT EXISTS (SELECT 1 FROM message_user_deletions d WHERE d.user_id = ? AND d.chat_id = m.chat_id AND d.message_id = m.message_id)',
    ];
    const args: Array<string | number> = [chatId, clearedUpTo, auth.userId];

    if (beforeId !== undefined) {
      clauses.push('m.message_id < ?');
      args.push(beforeId);
    }
    if (afterId !== undefined) {
      clauses.push('m.message_id > ?');
      args.push(afterId);
    }
    if (aroundId !== undefined) {
      clauses.push('m.message_id BETWEEN ? AND ?');
      args.push(Math.max(1, aroundId - Math.floor(limit / 2)), aroundId + Math.ceil(limit / 2));
    }
    if (topicId !== undefined) {
      clauses.push('COALESCE(m.topic_id, 1) = ?');
      args.push(topicId);
    }
    if (mediaFilter) {
      if (mediaFilter === 'link' || mediaFilter === 'links') {
        clauses.push(`(m.media_type = 'links' OR m.text_plain LIKE '%http://%' OR m.text_plain LIKE '%https://%')`);
      } else if (mediaFilter === 'file' || mediaFilter === 'files' || mediaFilter === 'document') {
        clauses.push(`m.media_type = 'document'`);
      } else if (mediaFilter === 'media') {
        clauses.push(`m.media_type IN ('photo', 'video', 'gif', 'album')`);
      } else if (mediaFilter === 'photo') {
        clauses.push(`m.media_type = 'photo'`);
      } else if (mediaFilter === 'music') {
        clauses.push(`m.media_type = 'audio'`);
      } else {
        clauses.push(`m.media_type = ?`);
        args.push(mediaFilter);
      }
    }

    const sql = `SELECT * FROM messages m WHERE ${clauses.join(' AND ')} ORDER BY m.message_id DESC LIMIT ?`;
    args.push(limit + 1);

    const rows = db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;
    sliced.reverse(); // Ascending chronological order

    const messages = sliced.map((r) => {
      const item = hydrateMessageRow(db, r, auth.userId);
      // Hydrate latest live poll votes if Poll card
      if (item.content.type === 'Poll') {
        const pollRow = db
          .prepare(`SELECT poll_id, poll_json, is_closed FROM polls WHERE chat_id = ? AND message_id = ?`)
          .get(chatId, item.id) as { poll_id: number; poll_json: string; is_closed: number } | undefined;
        if (pollRow) {
          const basePoll = JSON.parse(pollRow.poll_json) as PollData;
          basePoll.is_closed = Boolean(pollRow.is_closed);
          item.content = {
            type: 'Poll',
            data: recomputePollState(db, Number(pollRow.poll_id), basePoll, auth.userId),
          };
        }
      }
      return item;
    });

    const chatRow = db.prepare(`SELECT pts FROM chats WHERE chat_id = ?`).get(chatId) as { pts: number };
    sendJson(ctx.res, 200, {
      messages,
      pts: Number(chatRow.pts),
      has_more: hasMore,
    });
  });

  // 3. Send Message (`POST /api/v1/chats/:chatId/messages` & `POST /api/v1/messages`)
  const handleSendMessage = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      chat_id?: number;
      text?: string;
      entities?: Array<MessageEntity | WireMessageEntity>;
      parse_markdown?: boolean;
      content?: MessageContent;
      reply_to?: number | { reply_to_msg_id: number; quote_text?: string };
      reply_to_id?: number;
      quote_text?: string;
      forward_info?: MessageItem['forward_info'];
      topic_id?: number;
      client_nonce?: number;
      silent?: boolean;
      schedule_at_ms?: number;
      scheduled_at_ms?: number;
      ttl_seconds?: number;
      send_as_peer_id?: number;
    }>(ctx.req);

    const chatId = Number(ctx.params.chatId ?? body.chat_id);
    ensureChatMembership(db, chatId, auth.userId);

    let replyToMsgId: number | undefined;
    let quoteText = body.quote_text;
    if (typeof body.reply_to === 'number') {
      replyToMsgId = body.reply_to;
    } else if (body.reply_to && typeof body.reply_to === 'object') {
      replyToMsgId = body.reply_to.reply_to_msg_id;
      quoteText = quoteText ?? body.reply_to.quote_text;
    } else if (body.reply_to_id !== undefined) {
      replyToMsgId = body.reply_to_id;
    }

    const result = createMessageAtomic(db, hub, {
      chatId,
      senderId: auth.userId,
      sendAsPeerId: body.send_as_peer_id,
      text: body.text,
      entities: body.entities,
      parseMarkdown: body.parse_markdown,
      content: body.content,
      replyToMsgId,
      quoteText,
      forwardInfo: body.forward_info,
      topicId: body.topic_id,
      clientNonce: body.client_nonce,
      silent: body.silent,
      scheduleAtMs: body.schedule_at_ms ?? body.scheduled_at_ms,
      ttlSeconds: body.ttl_seconds,
    });

    if (!result.duplicate && result.message.text) {
      onBotMessage(chatId, auth.userId, result.message.text);
    }

    sendJson(ctx.res, result.duplicate ? 200 : 201, {
      message: result.message,
      message_id: result.message.id,
      id: result.message.id,
      pts: result.pts,
      pts_count: result.duplicate ? 0 : 1,
      duplicate: result.duplicate,
      date_ms: result.message.date_ms,
      date: result.message.date,
      sender_id: auth.userId,
      chat_id: chatId,
      text: result.message.text ?? '',
      client_nonce: body.client_nonce,
      status: 'sent',
    });
  };
  router.post('/api/v1/chats/:chatId/messages', handleSendMessage);
  router.post('/api/v1/messages', handleSendMessage);

  // 4. Edit Message (`PATCH` / `PUT`)
  const handleEditMessage = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    const messageId = Number(ctx.params.messageId);
    const body = await readJsonBody<{
      text?: string;
      entities?: Array<MessageEntity | WireMessageEntity>;
      content?: MessageContent;
    }>(ctx.req);

    const res = editMessageAtomic(db, hub, {
      chatId,
      messageId,
      editorUserId: auth.userId,
      text: body.text,
      entities: body.entities,
      content: body.content,
    });
    sendJson(ctx.res, 200, { message: res.message, pts: res.pts });
  };
  router.patch('/api/v1/chats/:chatId/messages/:messageId', handleEditMessage);
  router.put('/api/v1/chats/:chatId/messages/:messageId', handleEditMessage);

  // 5. Delete Single & Batch (`for_everyone=true` tombstone vs `for_everyone=false` per-user hide)
  router.delete('/api/v1/chats/:chatId/messages/:messageId', (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    const messageId = Number(ctx.params.messageId);
    ensureChatMembership(db, chatId, auth.userId);
    const forEveryone = ctx.query.get('for_everyone') === 'true' || ctx.query.get('revoke') === 'true';

    const res = deleteMessagesAtomic(db, hub, chatId, auth.userId, [messageId], forEveryone);
    sendJson(ctx.res, 200, { ok: true, pts: res.pts, tombstone: res.tombstone });
  });

  const handleDeleteBatch = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      chat_id?: number;
      message_ids?: number[];
      for_everyone?: boolean;
      revoke?: boolean;
    }>(ctx.req);
    const chatId = Number(ctx.params.chatId ?? body.chat_id);
    ensureChatMembership(db, chatId, auth.userId);
    const res = deleteMessagesAtomic(
      db,
      hub,
      chatId,
      auth.userId,
      body.message_ids ?? [],
      Boolean(body.for_everyone ?? body.revoke),
    );
    sendJson(ctx.res, 200, { ok: true, deleted_ids: res.deletedIds, pts: res.pts });
  };
  router.post('/api/v1/chats/:chatId/messages/delete-batch', handleDeleteBatch);
  router.post('/api/v1/messages/delete', handleDeleteBatch);

  // 6. Forward Messages (`hide_sender`, `comment`)
  const handleForwardMessages = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      from_chat_id?: number;
      to_chat_id?: number;
      message_ids?: number[];
      hide_sender?: boolean;
      hideSender?: boolean;
      comment?: string;
      topic_id?: number;
    }>(ctx.req);

    const fromChatId = Number(body.from_chat_id ?? ctx.params.chatId);
    const toChatId = Number(
      body.to_chat_id ?? (body.from_chat_id !== undefined ? ctx.params.chatId : undefined),
    );
    ensureChatMembership(db, fromChatId, auth.userId);
    ensureChatMembership(db, toChatId, auth.userId);

    const hideSender = Boolean(body.hide_sender ?? body.hideSender);
    const created: MessageItem[] = [];

    if (body.comment && body.comment.trim()) {
      const commentRes = createMessageAtomic(db, hub, {
        chatId: toChatId,
        senderId: auth.userId,
        text: body.comment.trim(),
        topicId: body.topic_id,
      });
      created.push(commentRes.message);
    }

    for (const rawId of body.message_ids ?? []) {
      const msgId = Number(rawId);
      const orig = getMessageById(db, fromChatId, msgId, auth.userId);
      if (!orig) continue;

      db.prepare(`UPDATE messages SET forwards = forwards + 1 WHERE chat_id = ? AND message_id = ?`).run(
        fromChatId,
        msgId,
      );

      const origAuthor = getUserProfileDto(db, orig.sender_id);
      const forwardInfo: MessageItem['forward_info'] = hideSender
        ? undefined
        : {
            from_id: { User: orig.sender_id },
            from_name: origAuthor
              ? [origAuthor.first_name, origAuthor.last_name].filter(Boolean).join(' ')
              : `User #${orig.sender_id}`,
            date: orig.date_ms ?? Date.now(),
            original_message_id: orig.id,
          };

      const fwdRes = createMessageAtomic(db, hub, {
        chatId: toChatId,
        senderId: auth.userId,
        content: orig.content,
        text: orig.text,
        forwardInfo,
        topicId: body.topic_id,
      });
      created.push(fwdRes.message);
    }

    sendJson(ctx.res, 201, { ok: true, messages: created });
  };
  router.post('/api/v1/chats/:chatId/messages/forward', handleForwardMessages);
  router.post('/api/v1/messages/forward', handleForwardMessages);

  // 7. Read Receipts (`POST /api/v1/chats/:chatId/read`)
  router.post('/api/v1/chats/:chatId/read', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    ensureChatMembership(db, chatId, auth.userId);
    const body = await readJsonBody<{ max_id?: number; topic_id?: number }>(ctx.req);
    const chatRow = db.prepare(`SELECT last_message_id FROM chats WHERE chat_id = ?`).get(chatId) as {
      last_message_id: number;
    };
    const maxId = Number(body.max_id ?? chatRow.last_message_id ?? 0);

    db.prepare(`
      INSERT INTO user_chat_settings (user_id, chat_id, read_inbox_max_id, unread_mark)
      VALUES (?, ?, ?, 0)
      ON CONFLICT(user_id, chat_id) DO UPDATE SET
        read_inbox_max_id = MAX(read_inbox_max_id, excluded.read_inbox_max_id),
        unread_mark = 0
    `).run(auth.userId, chatId, maxId);

    const detail = getChatDetailDto(db, chatId, auth.userId)!;
    const ptsUpdate = commitPtsEventAtomic(db, hub, chatId, {
      type: 'ReadHistory',
      data: {
        chat_id: chatId,
        max_id: maxId,
        is_outbox: false,
        unread_count: detail.unread_count,
      },
    });

    sendJson(ctx.res, 200, {
      ok: true,
      success: true,
      chat_id: chatId,
      pts: ptsUpdate.pts,
      read_inbox_max_id: detail.read_inbox_max_id,
      read_outbox_max_id: detail.read_outbox_max_id,
      unread_count: detail.unread_count,
    });
  });

  // 8. Pin / Unpin Messages
  router.get('/api/v1/chats/:chatId/pins', (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    ensureChatMembership(db, chatId, auth.userId);
    const topicId = ctx.query.get('topic_id') ? Number(ctx.query.get('topic_id')) : undefined;

    const rows = (
      topicId !== undefined
        ? db
            .prepare(`SELECT message_id FROM pinned_messages WHERE chat_id = ? AND topic_id = ? ORDER BY pinned_at_ms DESC`)
            .all(chatId, topicId)
        : db
            .prepare(`SELECT message_id FROM pinned_messages WHERE chat_id = ? ORDER BY pinned_at_ms DESC`)
            .all(chatId)
    ) as Array<{ message_id: number }>;

    const pinnedIds = rows.map((r) => Number(r.message_id));
    const messages = pinnedIds
      .map((mid) => getMessageById(db, chatId, mid, auth.userId))
      .filter(Boolean);

    sendJson(ctx.res, 200, { pinned_ids: pinnedIds, messages });
  });

  const handlePinMessage = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    ensureChatMembership(db, chatId, auth.userId);
    const body = await readJsonBody<{ message_id?: number }>(ctx.req);
    const messageId = Number(ctx.params.messageId ?? body.message_id);

    const msg = getMessageById(db, chatId, messageId, auth.userId);
    if (!msg) throw new ApiError(404, 'message_not_found', 'Message not found');

    db.prepare(`
      INSERT OR REPLACE INTO pinned_messages (chat_id, message_id, topic_id, pinned_by, pinned_at_ms)
      VALUES (?, ?, ?, ?, ?)
    `).run(chatId, messageId, msg.topic_id ?? 0, auth.userId, Date.now());

    const pinRows = db
      .prepare(`SELECT message_id FROM pinned_messages WHERE chat_id = ? ORDER BY pinned_at_ms DESC`)
      .all(chatId) as Array<{ message_id: number }>;
    const pinnedIds = pinRows.map((p) => Number(p.message_id));

    const ptsUpdate = commitPtsEventAtomic(db, hub, chatId, {
      type: 'PinnedMessagesChanged',
      data: { chat_id: chatId, pinned_ids: pinnedIds },
    });
    sendJson(ctx.res, 200, { ok: true, pinned_ids: pinnedIds, pts: ptsUpdate.pts });
  };
  router.post('/api/v1/chats/:chatId/messages/:messageId/pin', handlePinMessage);
  router.post('/api/v1/chats/:chatId/pins', handlePinMessage);

  const handleUnpinMessage = (ctx: RequestContext): void => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    const messageId = Number(ctx.params.messageId);
    ensureChatMembership(db, chatId, auth.userId);

    db.prepare(`DELETE FROM pinned_messages WHERE chat_id = ? AND message_id = ?`).run(chatId, messageId);
    const pinRows = db
      .prepare(`SELECT message_id FROM pinned_messages WHERE chat_id = ? ORDER BY pinned_at_ms DESC`)
      .all(chatId) as Array<{ message_id: number }>;
    const pinnedIds = pinRows.map((p) => Number(p.message_id));

    const ptsUpdate = commitPtsEventAtomic(db, hub, chatId, {
      type: 'PinnedMessagesChanged',
      data: { chat_id: chatId, pinned_ids: pinnedIds },
    });
    sendJson(ctx.res, 200, { ok: true, pinned_ids: pinnedIds, pts: ptsUpdate.pts });
  };
  router.delete('/api/v1/chats/:chatId/messages/:messageId/pin', handleUnpinMessage);
  router.delete('/api/v1/chats/:chatId/pins/:messageId', handleUnpinMessage);

  // Desktop inline keyboard callback query
  router.post('/api/v1/chats/:chatId/callback', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    ensureChatMembership(db, chatId, auth.userId);
    const body = await readJsonBody<{ message_id?: number; callback_data?: string; data?: string }>(ctx.req);
    const cbData = String(body.callback_data ?? body.data ?? '');
    sendJson(ctx.res, 200, {
      ok: true,
      chat_id: chatId,
      message_id: body.message_id ?? 0,
      callback_data: cbData,
      text: cbData ? `Callback "${cbData}" received` : 'OK',
      show_alert: false,
    });
  });

  // 9. Reactions (`GET` details & `POST` toggle/add/remove)
  router.get('/api/v1/chats/:chatId/messages/:messageId/reactions', (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    const messageId = Number(ctx.params.messageId);
    ensureChatMembership(db, chatId, auth.userId);

    const { reactions, details } = getMessageReactions(db, chatId, messageId, auth.userId);
    const reactors = details.flatMap((d) =>
      d.user_ids.map((uid) => ({
        emoji: d.emoji,
        user: getUserProfileDto(db, uid),
      })),
    );
    sendJson(ctx.res, 200, { reactions, details, reactors });
  });

  router.post('/api/v1/chats/:chatId/messages/:messageId/reactions', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    const messageId = Number(ctx.params.messageId);
    ensureChatMembership(db, chatId, auth.userId);

    const body = await readJsonBody<{ emoji?: string; action?: 'toggle' | 'add' | 'remove' }>(ctx.req);
    const emoji = (body.emoji ?? '').trim();
    if (!emoji) throw new ApiError(400, 'missing_emoji', 'Reaction emoji is required');

    const exists = db
      .prepare(
        `SELECT 1 FROM message_reactions WHERE chat_id = ? AND message_id = ? AND user_id = ? AND emoji = ?`,
      )
      .get(chatId, messageId, auth.userId, emoji);

    const action = body.action ?? 'toggle';
    const shouldAdd = action === 'add' ? true : action === 'remove' ? false : !exists;

    if (shouldAdd) {
      db.prepare(`
        INSERT OR IGNORE INTO message_reactions (chat_id, message_id, user_id, emoji, created_at_ms)
        VALUES (?, ?, ?, ?, ?)
      `).run(chatId, messageId, auth.userId, emoji, Date.now());
    } else {
      db.prepare(
        `DELETE FROM message_reactions WHERE chat_id = ? AND message_id = ? AND user_id = ? AND emoji = ?`,
      ).run(chatId, messageId, auth.userId, emoji);
    }

    const { reactions, details } = getMessageReactions(db, chatId, messageId, auth.userId);
    const ptsUpdate = commitPtsEventAtomic(db, hub, chatId, {
      type: 'ReactionUpdated',
      data: {
        chat_id: chatId,
        message_id: messageId,
        user_id: auth.userId,
        reactions,
      },
    });
    sendJson(ctx.res, 200, {
      success: true,
      chat_id: chatId,
      message_id: messageId,
      pts: ptsUpdate.pts,
      reactions,
      details,
    });
  });

  // 10. Polls & Quizzes (`create`, `vote`, `retract`, `close`, `results`)
  router.post('/api/v1/chats/:chatId/polls', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    ensureChatMembership(db, chatId, auth.userId);

    const body = await readJsonBody<{
      question?: string;
      options?: string[];
      is_anonymous?: boolean;
      allows_multiple_answers?: boolean;
      multiple_choice?: boolean;
      is_quiz?: boolean;
      correct_option_id?: number;
      solution?: string;
      explanation?: string;
      topic_id?: number;
      client_nonce?: number;
    }>(ctx.req);

    const question = (body.question ?? '').trim();
    const rawOptions = (body.options ?? []).map((o) => o.trim()).filter(Boolean);
    if (!question) throw new ApiError(400, 'invalid_question', 'Poll question cannot be empty');
    if (rawOptions.length < 2 || rawOptions.length > 12) {
      throw new ApiError(400, 'invalid_options', 'Polls require between 2 and 12 non-empty options');
    }

    const isQuiz = Boolean(body.is_quiz);
    if (
      isQuiz &&
      (body.correct_option_id === undefined ||
        body.correct_option_id < 0 ||
        body.correct_option_id >= rawOptions.length)
    ) {
      throw new ApiError(400, 'invalid_quiz_answer', 'Quiz mode requires a valid correct_option_id');
    }

    const tempPoll: PollData = {
      id: `poll_${crypto.randomBytes(6).toString('hex')}`,
      poll_id: 0,
      question,
      options: rawOptions.map((text, idx) => ({
        option_id: idx,
        text,
        vote_count: 0,
        is_chosen: false,
        percentage: 0,
      })),
      total_voters: 0,
      total_votes: 0,
      is_closed: false,
      is_anonymous: body.is_anonymous ?? true,
      allows_multiple_answers: isQuiz ? false : Boolean(body.allows_multiple_answers ?? body.multiple_choice),
      is_quiz: isQuiz,
      correct_option_id: isQuiz ? body.correct_option_id : undefined,
      solution: body.solution ?? body.explanation,
      explanation: body.explanation ?? body.solution,
    };

    const msgRes = createMessageAtomic(db, null, {
      chatId,
      senderId: auth.userId,
      content: { type: 'Poll', data: tempPoll },
      topicId: body.topic_id,
      clientNonce: body.client_nonce,
    });

    const insertRes = db
      .prepare(
        `INSERT INTO polls (chat_id, message_id, creator_id, poll_json, is_closed, created_at_ms)
         VALUES (?, ?, ?, ?, 0, ?)`,
      )
      .run(chatId, msgRes.message.id, auth.userId, JSON.stringify(tempPoll), Date.now());

    const pollId = Number(insertRes.lastInsertRowid);
    tempPoll.poll_id = pollId;
    tempPoll.id = `poll_${pollId}`;

    db.prepare(`UPDATE polls SET poll_json = ? WHERE poll_id = ?`).run(
      JSON.stringify(tempPoll),
      pollId,
    );
    db.prepare(`UPDATE messages SET content_json = ? WHERE chat_id = ? AND message_id = ?`).run(
      JSON.stringify({ type: 'Poll', data: tempPoll }),
      chatId,
      msgRes.message.id,
    );

    const hydrated = getMessageById(db, chatId, msgRes.message.id, auth.userId)!;
    hub.broadcastChatPtsUpdate(chatId, {
      chat_id: chatId,
      pts: msgRes.pts,
      pts_count: 1,
      event: { type: 'NewMessage', data: hydrated },
      timestamp_ms: Date.now(),
    });

    sendJson(ctx.res, 201, {
      message: hydrated,
      poll: tempPoll,
      pts: msgRes.pts,
    });
  });

  const handleVotePoll = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{ option_ids?: number[] }>(ctx.req);
    const updatedPoll = castPollVoteAtomic(db, hub, auth.userId, {
      pollId: ctx.params.pollId ? Number(ctx.params.pollId) : undefined,
      chatId: ctx.params.chatId ? Number(ctx.params.chatId) : undefined,
      messageId: ctx.params.messageId ? Number(ctx.params.messageId) : undefined,
      optionIds: body.option_ids ?? [],
    });
    sendJson(ctx.res, 200, updatedPoll);
  };
  router.post('/api/v1/polls/:pollId/vote', handleVotePoll);
  router.post('/api/v1/chats/:chatId/messages/:messageId/poll/vote', handleVotePoll);

  router.post('/api/v1/polls/:pollId/close', (ctx) => {
    const auth = requireAuth(db, ctx);
    const pollId = Number(ctx.params.pollId);
    const pollRow = db.prepare(`SELECT * FROM polls WHERE poll_id = ?`).get(pollId) as
      | { poll_id: number; chat_id: number; message_id: number; creator_id: number; poll_json: string }
      | undefined;
    if (!pollRow) throw new ApiError(404, 'poll_not_found', 'Poll not found');
    if (Number(pollRow.creator_id) !== auth.userId) {
      throw new ApiError(403, 'forbidden', 'Only the poll creator can close this poll');
    }

    const basePoll = JSON.parse(pollRow.poll_json) as PollData;
    basePoll.is_closed = true;
    db.prepare(`UPDATE polls SET is_closed = 1, poll_json = ? WHERE poll_id = ?`).run(
      JSON.stringify(basePoll),
      pollId,
    );

    const updatedPoll = recomputePollState(db, pollId, basePoll, auth.userId);
    db.prepare(`UPDATE messages SET content_json = ? WHERE chat_id = ? AND message_id = ?`).run(
      JSON.stringify({ type: 'Poll', data: updatedPoll }),
      Number(pollRow.chat_id),
      Number(pollRow.message_id),
    );
    commitPtsEventAtomic(db, hub, Number(pollRow.chat_id), {
      type: 'PollUpdated',
      data: { chat_id: Number(pollRow.chat_id), message_id: Number(pollRow.message_id), poll: updatedPoll },
    });
    sendJson(ctx.res, 200, updatedPoll);
  });

  router.get('/api/v1/polls/:pollId/results', (ctx) => {
    const auth = requireAuth(db, ctx);
    const pollId = Number(ctx.params.pollId);
    const pollRow = db.prepare(`SELECT * FROM polls WHERE poll_id = ?`).get(pollId) as
      | { poll_id: number; chat_id: number; poll_json: string; is_closed: number }
      | undefined;
    if (!pollRow) throw new ApiError(404, 'poll_not_found', 'Poll not found');
    ensureChatMembership(db, Number(pollRow.chat_id), auth.userId);

    const basePoll = JSON.parse(pollRow.poll_json) as PollData;
    basePoll.is_closed = Boolean(pollRow.is_closed);
    const computed = recomputePollState(db, pollId, basePoll, auth.userId);
    sendJson(ctx.res, 200, computed);
  });

  // 11. Collaborative Todo Checklists (`create` & `toggle`)
  router.post('/api/v1/chats/:chatId/todos', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    ensureChatMembership(db, chatId, auth.userId);
    const body = await readJsonBody<{
      title?: string;
      items?: Array<string | { id?: string; title: string; completed?: boolean }>;
      topic_id?: number;
    }>(ctx.req);

    const title = (body.title ?? '').trim();
    const rawItems = body.items ?? [];
    if (!title || rawItems.length === 0 || rawItems.length > 30) {
      throw new ApiError(400, 'invalid_todo', 'Todo checklist requires a title and 1–30 items');
    }

    const listId = `todo_${crypto.randomBytes(6).toString('hex')}`;
    const items = rawItems.map((it, idx) =>
      typeof it === 'string'
        ? { id: `item_${idx + 1}`, title: it.trim(), completed: false }
        : { id: it.id || `item_${idx + 1}`, title: it.title.trim(), completed: Boolean(it.completed) },
    );

    const card: TodoListCard = {
      id: listId,
      list_id: listId,
      title,
      items,
      completed_count: items.filter((i) => i.completed).length,
      action_buttons: [],
    };

    const res = createMessageAtomic(db, hub, {
      chatId,
      senderId: auth.userId,
      content: { type: 'Todo', data: card },
      topicId: body.topic_id,
    });
    sendJson(ctx.res, 201, { message: res.message, todo: card, pts: res.pts });
  });

  router.post('/api/v1/chats/:chatId/messages/:messageId/todo', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    const messageId = Number(ctx.params.messageId);
    ensureChatMembership(db, chatId, auth.userId);

    const existing = getMessageById(db, chatId, messageId, auth.userId);
    if (!existing || existing.content.type !== 'Todo') {
      throw new ApiError(404, 'todo_not_found', 'Todo checklist message not found');
    }

    const body = await readJsonBody<{ item_id?: string; completed?: boolean }>(ctx.req);
    const card = structuredClone(existing.content.data);
    const targetItem = card.items.find((i) => i.id === body.item_id);
    if (!targetItem) {
      throw new ApiError(404, 'todo_item_not_found', 'Checklist item not found');
    }

    targetItem.completed = body.completed !== undefined ? Boolean(body.completed) : !targetItem.completed;
    targetItem.completed_at_ms = targetItem.completed ? Date.now() : undefined;
    card.completed_count = card.items.filter((i) => i.completed).length;

    db.prepare(`UPDATE messages SET content_json = ? WHERE chat_id = ? AND message_id = ?`).run(
      JSON.stringify({ type: 'Todo', data: card }),
      chatId,
      messageId,
    );

    const updatedMsg = getMessageById(db, chatId, messageId, auth.userId)!;
    const ptsUpdate = commitPtsEventAtomic(db, hub, chatId, {
      type: 'TodoUpdated',
      data: { chat_id: chatId, message_id: messageId, todo: card },
    });
    sendJson(ctx.res, 200, { message: updatedMsg, todo: card, pts: ptsUpdate.pts });
  });

  // 12. Invoices & Checkout Payment (`create` & `pay`)
  router.post('/api/v1/chats/:chatId/invoices', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    ensureChatMembership(db, chatId, auth.userId);
    const body = await readJsonBody<{
      title?: string;
      description?: string;
      currency?: string;
      amount?: number;
      amount_cents?: number;
    }>(ctx.req);

    const amount = Math.max(1, Math.trunc(Number(body.amount ?? body.amount_cents ?? 100)));
    const invId = `inv_${crypto.randomBytes(6).toString('hex')}`;
    const card: InvoiceCard = {
      id: invId,
      invoice_id: invId,
      title: (body.title ?? 'Stars Invoice').trim(),
      description: (body.description ?? 'Instant checkout via GPUI Telegram Wallet').trim(),
      currency: (body.currency ?? 'XTR').toUpperCase(),
      amount_cents: amount,
      total_amount: amount,
      status: 'pending',
      is_paid: false,
      prices: [{ label: body.title ?? 'Item', amount_cents: amount }],
    };

    const res = createMessageAtomic(db, hub, {
      chatId,
      senderId: auth.userId,
      content: { type: 'Invoice', data: card },
    });
    sendJson(ctx.res, 201, { message: res.message, invoice: card, pts: res.pts });
  });

  router.post('/api/v1/chats/:chatId/messages/:messageId/pay', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    const messageId = Number(ctx.params.messageId);
    ensureChatMembership(db, chatId, auth.userId);
    const body = await readJsonBody<{ idempotency_key?: string }>(ctx.req);

    const headerIdem = ctx.req.headers['idempotency-key'];
    const idempotencyKey =
      (typeof headerIdem === 'string' ? headerIdem.trim() : undefined) ?? body.idempotency_key?.trim();
    const idemScope = `invoice_pay:${chatId}:${messageId}`;
    const cached = lookupWalletIdempotency(db, auth.userId, idempotencyKey, idemScope);
    if (cached) {
      sendJson(ctx.res, 200, cached);
      return;
    }

    const existing = getMessageById(db, chatId, messageId, auth.userId);
    if (!existing || existing.content.type !== 'Invoice') {
      throw new ApiError(404, 'invoice_not_found', 'Invoice message not found');
    }

    const card = structuredClone(existing.content.data);
    if (card.is_paid) {
      const wallet = db
        .prepare(`SELECT stars_balance, ton_nano FROM wallet_accounts WHERE user_id = ?`)
        .get(auth.userId) as { stars_balance: number; ton_nano: number } | undefined;
      const alreadyPaidPayload = {
        ok: true,
        paid: true,
        receipt_id: card.receipt_id,
        balance: Number(wallet?.stars_balance ?? 0),
        ton_nano: Number(wallet?.ton_nano ?? 0),
      };
      storeWalletIdempotency(db, auth.userId, idempotencyKey, idemScope, alreadyPaidPayload);
      sendJson(ctx.res, 200, alreadyPaidPayload);
      return;
    }

    let newBalance = 0;
    let newTonNano = 0;
    const now = Date.now();
    const receiptId = `rcpt_${crypto.randomBytes(6).toString('hex')}`;
    const payeeUserId = existing.sender_id;

    db.exec('BEGIN IMMEDIATE;');
    try {
      db.prepare(`
        INSERT OR IGNORE INTO wallet_accounts (user_id, stars_balance, ton_nano, updated_at_ms)
        VALUES (?, 0, 0, ?)
      `).run(auth.userId, now);
      db.prepare(`
        INSERT OR IGNORE INTO wallet_accounts (user_id, stars_balance, ton_nano, updated_at_ms)
        VALUES (?, 0, 0, ?)
      `).run(payeeUserId, now);

      const payerWallet = db
        .prepare(`SELECT stars_balance, ton_nano FROM wallet_accounts WHERE user_id = ?`)
        .get(auth.userId) as { stars_balance: number; ton_nano: number };

      newBalance = Number(payerWallet.stars_balance);
      newTonNano = Number(payerWallet.ton_nano);

      if (card.currency === 'TON') {
        if (newTonNano < card.total_amount) {
          throw new ApiError(400, 'insufficient_ton', 'Insufficient TON nano balance');
        }
        newTonNano -= card.total_amount;
        db.prepare(`UPDATE wallet_accounts SET ton_nano = ?, updated_at_ms = ? WHERE user_id = ?`).run(
          newTonNano,
          now,
          auth.userId,
        );
        const payerTxId = `tx_${crypto.randomBytes(6).toString('hex')}`;
        db.prepare(`INSERT INTO wallet_transactions (tx_id, user_id, tx_json, created_at_ms) VALUES (?, ?, ?, ?)`).run(
          payerTxId,
          auth.userId,
          JSON.stringify({
            tx_id: payerTxId,
            kind: 'invoice_payment',
            amount_stars: 0,
            ton_nano_delta: -card.total_amount,
            peer_user_id: payeeUserId,
            chat_id: chatId,
            description: `Paid TON invoice: ${card.title}`,
            created_at_ms: now,
          }),
          now,
        );
        if (payeeUserId !== auth.userId) {
          db.prepare(`UPDATE wallet_accounts SET ton_nano = ton_nano + ?, updated_at_ms = ? WHERE user_id = ?`).run(
            card.total_amount,
            now,
            payeeUserId,
          );
          const payeeTxId = `tx_${crypto.randomBytes(6).toString('hex')}`;
          db.prepare(`INSERT INTO wallet_transactions (tx_id, user_id, tx_json, created_at_ms) VALUES (?, ?, ?, ?)`).run(
            payeeTxId,
            payeeUserId,
            JSON.stringify({
              tx_id: payeeTxId,
              kind: 'invoice_received',
              amount_stars: 0,
              ton_nano_delta: card.total_amount,
              peer_user_id: auth.userId,
              chat_id: chatId,
              description: `Received TON invoice payment: ${card.title}`,
              created_at_ms: now,
            }),
            now,
          );
        }
      } else {
        // Default Stars (`XTR`) / integer invoice settlement
        if (newBalance < card.total_amount) {
          throw new ApiError(400, 'insufficient_stars', 'Insufficient Telegram Stars balance');
        }
        newBalance -= card.total_amount;
        db.prepare(`UPDATE wallet_accounts SET stars_balance = ?, updated_at_ms = ? WHERE user_id = ?`).run(
          newBalance,
          now,
          auth.userId,
        );
        const payerTxId = `tx_${crypto.randomBytes(6).toString('hex')}`;
        db.prepare(`INSERT INTO wallet_transactions (tx_id, user_id, tx_json, created_at_ms) VALUES (?, ?, ?, ?)`).run(
          payerTxId,
          auth.userId,
          JSON.stringify({
            tx_id: payerTxId,
            kind: 'invoice_payment',
            amount_stars: -card.total_amount,
            peer_user_id: payeeUserId,
            chat_id: chatId,
            description: `Paid invoice: ${card.title}`,
            created_at_ms: now,
          }),
          now,
        );
        if (payeeUserId !== auth.userId) {
          db.prepare(
            `UPDATE wallet_accounts SET stars_balance = stars_balance + ?, updated_at_ms = ? WHERE user_id = ?`,
          ).run(card.total_amount, now, payeeUserId);
          const payeeTxId = `tx_${crypto.randomBytes(6).toString('hex')}`;
          db.prepare(`INSERT INTO wallet_transactions (tx_id, user_id, tx_json, created_at_ms) VALUES (?, ?, ?, ?)`).run(
            payeeTxId,
            payeeUserId,
            JSON.stringify({
              tx_id: payeeTxId,
              kind: 'invoice_received',
              amount_stars: card.total_amount,
              peer_user_id: auth.userId,
              chat_id: chatId,
              description: `Received invoice payment: ${card.title}`,
              created_at_ms: now,
            }),
            now,
          );
        }
      }

      card.is_paid = true;
      card.status = 'paid';
      card.receipt_id = receiptId;

      db.prepare(`UPDATE messages SET content_json = ? WHERE chat_id = ? AND message_id = ?`).run(
        JSON.stringify({ type: 'Invoice', data: card }),
        chatId,
        messageId,
      );

      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }

    const updatedMsg = getMessageById(db, chatId, messageId, auth.userId)!;
    commitPtsEventAtomic(db, hub, chatId, {
      type: 'EditMessage',
      data: updatedMsg,
    });

    const receiptRes = createMessageAtomic(db, hub, {
      chatId,
      senderId: auth.userId,
      content: {
        type: 'Service',
        data: {
          kind: 'custom_text',
          text: `✅ Payment receipt #${receiptId}: ${card.total_amount} ${card.currency} for "${card.title}"`,
        },
      },
      replyToMsgId: messageId,
    });

    const responsePayload = {
      ok: true,
      paid: true,
      receipt_id: receiptId,
      balance: newBalance,
      ton_nano: newTonNano,
      invoice: card,
      receipt_message: receiptRes.message,
    };
    storeWalletIdempotency(db, auth.userId, idempotencyKey, idemScope, responsePayload);
    sendJson(ctx.res, 200, responsePayload);
  });

  // 13. CJK-Aware Full-Text Search (`/api/v1/search` & `/api/v1/search/messages`)
  const handleSearch = (ctx: RequestContext): void => {
    const auth = requireAuth(db, ctx);
    const rawQ = ctx.query.get('q') ?? ctx.query.get('query') ?? '';
    const tab = ((ctx.query.get('tab') ?? ctx.query.get('category') ?? 'messages').toLowerCase()) as SearchTabCategory;
    const chatIdFilter = ctx.query.get('chat_id') ? Number(ctx.query.get('chat_id')) : undefined;
    const topicIdFilter = ctx.query.get('topic_id') ? Number(ctx.query.get('topic_id')) : undefined;
    let senderIdFilter = ctx.query.get('sender_id') ? Number(ctx.query.get('sender_id')) : undefined;
    const minDate = ctx.query.get('min_date') ? Number(ctx.query.get('min_date')) : undefined;
    const maxDate = ctx.query.get('max_date') ? Number(ctx.query.get('max_date')) : undefined;
    const limit = Math.min(100, Math.max(1, Number(ctx.query.get('limit') ?? 50)));
    const offset = Math.max(0, Number(ctx.query.get('offset') ?? 0));

    const parsed = parseSearchQuery(rawQ);
    if (parsed.fromUsername && senderIdFilter === undefined) {
      const fromRow = db
        .prepare(`SELECT user_id FROM users WHERE LOWER(username) = ?`)
        .get(parsed.fromUsername) as { user_id: number } | undefined;
      if (fromRow) {
        senderIdFilter = Number(fromRow.user_id);
      } else {
        senderIdFilter = -999999; // Non-existent sender -> empty message hits
      }
    }

    // Matching Chats & Users
    const likeTerm = `%${escapeSqlLikePattern(parsed.cleanQuery.toLowerCase())}%`;
    const matchedChats = parsed.cleanQuery
      ? (
          db
            .prepare(
              `SELECT c.chat_id FROM chats c
               JOIN chat_members m ON m.chat_id = c.chat_id AND m.user_id = ? AND m.role != 'banned'
               WHERE LOWER(c.title) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(c.username, '')) LIKE ? ESCAPE '\\'
               LIMIT 20`,
            )
            .all(auth.userId, likeTerm, likeTerm) as Array<{ chat_id: number }>
        )
          .map((r) => getChatDetailDto(db, Number(r.chat_id), auth.userId))
          .filter((c): c is NonNullable<typeof c> => Boolean(c))
      : [];

    const matchedUsers = parsed.cleanQuery
      ? (
          db
            .prepare(
              `SELECT * FROM users
               WHERE LOWER(first_name || ' ' || COALESCE(last_name, '')) LIKE ? ESCAPE '\\'
                  OR LOWER(COALESCE(username, '')) LIKE ? ESCAPE '\\'
               LIMIT 20`,
            )
            .all(likeTerm, likeTerm) as Array<Record<string, unknown>>
        ).map(mapUserRowToDto)
      : [];

    // Matching Mini Apps
    const appRows = (
      parsed.cleanQuery
        ? db
            .prepare(
              `SELECT app_json FROM mini_apps
               WHERE LOWER(app_json) LIKE ? ESCAPE '\\'
               LIMIT 20`,
            )
            .all(likeTerm)
        : db.prepare(`SELECT app_json FROM mini_apps LIMIT 20`).all()
    ) as Array<{ app_json: string }>;
    const matchedApps = appRows.map((r) => {
      const a = JSON.parse(r.app_json) as MiniAppEntry;
      return {
        app_id: a.app_id,
        bot_username: a.bot_username,
        short_name: a.short_name,
        title: a.title,
        description: a.description,
      };
    });

    // Matching Messages (parameterized SQLite LIKE ... ESCAPE '\' supporting 1-char, 2-char, and phrase CJK!)
    const msgClauses: string[] = [
      'm.deleted_for_everyone = 0',
      'EXISTS (SELECT 1 FROM chat_members cm WHERE cm.chat_id = m.chat_id AND cm.user_id = ? AND cm.role != \'banned\')',
      'm.message_id > COALESCE((SELECT ucs.cleared_up_to_msg_id FROM user_chat_settings ucs WHERE ucs.user_id = ? AND ucs.chat_id = m.chat_id), 0)',
      'NOT EXISTS (SELECT 1 FROM message_user_deletions d WHERE d.user_id = ? AND d.chat_id = m.chat_id AND d.message_id = m.message_id)',
    ];
    const msgArgs: Array<string | number> = [auth.userId, auth.userId, auth.userId];

    for (const term of parsed.terms) {
      msgClauses.push(`LOWER(m.text_plain) LIKE ? ESCAPE '\\'`);
      msgArgs.push(`%${escapeSqlLikePattern(term.toLowerCase())}%`);
    }

    if (chatIdFilter !== undefined) {
      msgClauses.push('m.chat_id = ?');
      msgArgs.push(chatIdFilter);
    }
    if (topicIdFilter !== undefined) {
      msgClauses.push('COALESCE(m.topic_id, 1) = ?');
      msgArgs.push(topicIdFilter);
    }
    if (senderIdFilter !== undefined) {
      msgClauses.push('m.sender_id = ?');
      msgArgs.push(senderIdFilter);
    }
    if (minDate !== undefined) {
      msgClauses.push('m.date_ms >= ?');
      msgArgs.push(minDate);
    }
    if (maxDate !== undefined) {
      msgClauses.push('m.date_ms <= ?');
      msgArgs.push(maxDate);
    }

    if (tab === 'media') {
      msgClauses.push(`m.media_type IN ('photo', 'video', 'gif', 'album')`);
    } else if (tab === 'links') {
      msgClauses.push(`(m.media_type = 'links' OR m.text_plain LIKE '%http://%' OR m.text_plain LIKE '%https://%')`);
    } else if (tab === 'files') {
      msgClauses.push(`m.media_type = 'document'`);
    } else if (tab === 'music') {
      msgClauses.push(`m.media_type = 'audio'`);
    } else if (tab === 'voice') {
      msgClauses.push(`m.media_type IN ('voice', 'videonote')`);
    }

    const hits: SearchHitDto[] = [];
    if (parsed.terms.length > 0 || senderIdFilter !== undefined || minDate !== undefined || maxDate !== undefined || ['media', 'links', 'files', 'music', 'voice'].includes(tab)) {
      const sql = `
        SELECT m.chat_id, m.message_id, m.sender_id, m.topic_id, m.date_ms, m.text_plain, m.media_type, c.title AS chat_title
        FROM messages m
        JOIN chats c ON c.chat_id = m.chat_id
        WHERE ${msgClauses.join(' AND ')}
        ORDER BY m.date_ms DESC, m.message_id DESC
        LIMIT ? OFFSET ?
      `;
      const rows = db.prepare(sql).all(...msgArgs, limit, offset) as Array<Record<string, unknown>>;
      for (const r of rows) {
        const sender = getUserProfileDto(db, Number(r.sender_id));
        const text = String(r.text_plain ?? '');
        hits.push({
          chat_id: Number(r.chat_id),
          chat_title: String(r.chat_title ?? ''),
          message_id: Number(r.message_id),
          sender_id: Number(r.sender_id),
          sender_name: sender ? [sender.first_name, sender.last_name].filter(Boolean).join(' ') : undefined,
          topic_id: r.topic_id !== null && r.topic_id !== undefined ? Number(r.topic_id) : undefined,
          date_ms: Number(r.date_ms),
          text,
          snippet_html: buildHighlightedSnippet(text, parsed.terms),
          media_type: (r.media_type as string | null) ?? undefined,
        });
      }
    }

    const response: GlobalSearchResponse = {
      query: rawQ,
      tab,
      total: tab === 'chats' ? matchedChats.length : tab === 'apps' ? matchedApps.length : hits.length,
      chats: matchedChats,
      users: matchedUsers,
      apps: matchedApps,
      hits,
      messages: hits,
    };
    sendJson(ctx.res, 200, response);
  };
  router.get('/api/v1/search', handleSearch);
  router.get('/api/v1/search/messages', handleSearch);

  // AI Compose Assist Endpoint (uses real configured Magpie/Gateway LLM in production)
  router.post('/api/v1/messages/ai-compose', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{ text?: string; mode?: string }>(ctx.req);
    const text = (body.text ?? '').trim();
    const mode = body.mode ?? 'improve';
    if (!text) {
      throw new ApiError(400, 'empty_text', 'text is required');
    }

    const modeInstruction: Record<string, string> = {
      translate_zh: 'Translate the following message accurately into natural Simplified Chinese. Output only the translation.',
      translate_en: 'Translate the following message accurately into natural English. Output only the translation.',
      shorter: 'Rewrite the following message to be concise while preserving the original meaning and language. Output only the rewritten message.',
      formal: 'Rewrite the following message in a polite, professional tone in the same language. Output only the rewritten message.',
      improve: 'Polish and improve the clarity of the following message in the same language. Output only the improved message.',
    };

    if (config) {
      const llmRes = await runConfiguredLlmCompletion(
        db,
        config,
        auth.userId,
        [
          { role: 'system', content: modeInstruction[mode] ?? modeInstruction.improve },
          { role: 'user', content: text },
        ],
      );
      if (llmRes.usedUpstream && llmRes.text) {
        sendJson(ctx.res, 200, {
          ok: true,
          mode,
          original: text,
          result: llmRes.text.trim(),
          provider_id: llmRes.providerId,
          model: llmRes.model,
        });
        return;
      }
      if (!config.seedDemoData) {
        throw new ApiError(
          503,
          'ai_provider_unconfigured',
          llmRes.error
            ? `AI 写作助手调用模型失败：${llmRes.error}`
            : '请先在 Magpie LLM 网关配置并启用可用的模型提供商后再使用 AI 写作助手。',
        );
      }
    }

    let result = text;
    if (mode === 'translate_zh') {
      result = `[中文翻译] ${text}`;
    } else if (mode === 'translate_en') {
      result = `[EN Translation] ${text}`;
    } else if (mode === 'shorter') {
      result = text.length > 80 ? `${text.slice(0, 77)}...` : text;
    } else if (mode === 'formal') {
      result = `Dear colleague, ${text}`;
    } else {
      result = `${text} ✨`;
    }
    sendJson(ctx.res, 200, { ok: true, mode, original: text, result });
  });
}
