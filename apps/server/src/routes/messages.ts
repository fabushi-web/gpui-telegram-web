import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  type ArchiveLocalBotReplyRequest,
  type ArchiveLocalBotReplyResponse,
  type GlobalSearchResponse,
  type InvoiceCard,
  type MessageContent,
  type MessageEntity,
  type MessageItem,
  type MiniAppEntry,
  type PollData,
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
  enrichMessageWebPageAsync,
  ensureChatAdminAccess,
  ensureChatMembership,
  ensureChatReadAccess,
  ensureChatWriteAccess,
  getChatDetailDto,
  getMessageById,
  getMessageReactions,
  getUserProfileDto,
  hydrateMessageRow,
  lookupWalletIdempotency,
  mapUserRowToDto,
  parseBoundedQueryInt,
  parseOptionalNonNegativeInt,
  parseOptionalPositiveInt,
  purgeExpiredTtlMessages,
  recomputePollState,
  storeWalletIdempotency,
  validateSendAsPeerId,
  validateWireMessageContent,
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

function parsePositiveSafeIntNonce(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (
    typeof raw !== 'number' ||
    !Number.isInteger(raw) ||
    raw < 1 ||
    raw > Number.MAX_SAFE_INTEGER
  ) {
    throw new ApiError(400, 'invalid_nonce', 'client_nonce must be a positive safe integer');
  }
  return raw;
}

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

export function registerMessageAndSearchRoutes(
  router: HttpRouter,
  db: DatabaseSync,
  hub: RealtimeGatewayHub,
  onBotMessage: BotMessageInterceptor,
  config?: ServerConfig,
  shutdownSignal?: AbortSignal,
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
    let diffReq: {
      chat_id: number;
      pts?: number;
      from_pts?: number;
      limit?: number;
      pts_total_limit?: number;
    };
    if (ctx.method === 'GET') {
      diffReq = {
        chat_id: Number(ctx.query.get('chat_id') ?? 0),
        from_pts: Number(ctx.query.get('from_pts') ?? ctx.query.get('pts') ?? 0),
        limit: ctx.query.get('limit') ? Number(ctx.query.get('limit')) : undefined,
      };
    } else {
      const body = await readJsonBody<{
        chat_id?: unknown;
        pts?: unknown;
        from_pts?: unknown;
        limit?: unknown;
        pts_total_limit?: unknown;
      }>(ctx.req);
      const chatId = parseOptionalPositiveInt(
        body.chat_id,
        'invalid_chat_id',
        'chat_id must be a positive integer',
      );
      if (chatId === undefined) {
        throw new ApiError(400, 'invalid_chat_id', 'chat_id is required');
      }
      diffReq = {
        chat_id: chatId,
        pts: parseOptionalNonNegativeInt(body.pts, 'invalid_pts', 'pts must be a non-negative integer'),
        from_pts: parseOptionalNonNegativeInt(
          body.from_pts,
          'invalid_pts',
          'from_pts must be a non-negative integer',
        ),
        limit: parseOptionalPositiveInt(
          body.limit,
          'invalid_limit',
          'limit must be a positive integer',
        ),
        pts_total_limit: parseOptionalPositiveInt(
          body.pts_total_limit,
          'invalid_limit',
          'pts_total_limit must be a positive integer',
        ),
      };
    }

    const diff = computeChatDifference(db, auth.userId, diffReq);
    sendJson(ctx.res, 200, diff);
  };
  router.post('/api/v1/sync/get_difference', handleGetDifference);
  router.get('/api/v1/sync/get_difference', handleGetDifference);
  router.post('/api/v1/sync/difference', handleGetDifference);
  router.get('/api/v1/sync/difference', handleGetDifference);

  // 2. List Messages (`limit`, `before_id`, `after_id`, `around_id`, `topic_id`, `media_filter`)
  const handleListMessages = (ctx: RequestContext): void => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId ?? ctx.query.get('chat_id') ?? 0);
    ensureChatReadAccess(db, chatId, auth.userId);
    purgeExpiredTtlMessages(db, chatId);

    const limit = parseBoundedQueryInt(ctx.query.get('limit'), 50, 1, 200);
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
    const pts = Number(chatRow.pts);
    sendJson(ctx.res, 200, {
      chat_id: chatId,
      messages,
      pts,
      current_pts: pts,
      has_more: hasMore,
    });
  };
  router.get('/api/v1/chats/:chatId/messages', handleListMessages);
  router.get('/api/v1/messages/history', handleListMessages);

  // 3. Send Message (`POST /api/v1/chats/:chatId/messages`, `/api/v1/messages`, `/api/v1/messages/send`)
  const handleSendMessage = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      chat_id?: unknown;
      text?: unknown;
      entities?: unknown;
      parse_markdown?: boolean;
      content?: unknown;
      reply_to?: unknown;
      reply_to_id?: unknown;
      reply_to_msg_id?: unknown;
      quote_text?: unknown;
      forward_info?: unknown;
      topic_id?: unknown;
      client_nonce?: unknown;
      silent?: boolean;
      schedule_at_ms?: unknown;
      scheduled_at_ms?: unknown;
      ttl_seconds?: unknown;
      send_as_peer_id?: unknown;
      skip_server_bot_reply?: boolean;
    }>(ctx.req);

    const chatId =
      ctx.params.chatId !== undefined
        ? Number(ctx.params.chatId)
        : (parseOptionalPositiveInt(
            body.chat_id,
            'invalid_chat_id',
            'chat_id must be a positive integer',
          ) ?? 0);
    const access = ensureChatWriteAccess(db, chatId, auth.userId);
    const clientNonce = parsePositiveSafeIntNonce(body.client_nonce);

    if (body.text !== undefined && body.text !== null && typeof body.text !== 'string') {
      throw new ApiError(400, 'invalid_text', 'Message text must be a string');
    }
    if (
      body.quote_text !== undefined &&
      body.quote_text !== null &&
      typeof body.quote_text !== 'string'
    ) {
      throw new ApiError(400, 'invalid_quote_text', 'quote_text must be a string');
    }
    if (
      body.entities !== undefined &&
      body.entities !== null &&
      !Array.isArray(body.entities)
    ) {
      throw new ApiError(400, 'invalid_entities', 'entities must be an array');
    }

    const validatedContent =
      body.content !== undefined && body.content !== null
        ? validateWireMessageContent(body.content)
        : undefined;
    const topicId = parseOptionalPositiveInt(
      body.topic_id,
      'invalid_topic_id',
      'topic_id must be a positive integer',
    );
    const ttlSeconds = parseOptionalNonNegativeInt(
      body.ttl_seconds,
      'invalid_ttl',
      'ttl_seconds must be a non-negative integer',
    );
    const scheduleAtMs = parseOptionalNonNegativeInt(
      body.schedule_at_ms ?? body.scheduled_at_ms,
      'invalid_schedule_time',
      'schedule_at_ms must be a non-negative integer',
    );

    if (
      body.forward_info !== undefined &&
      body.forward_info !== null &&
      (typeof body.forward_info !== 'object' || Array.isArray(body.forward_info))
    ) {
      throw new ApiError(400, 'invalid_forward_info', 'forward_info must be a JSON object');
    }

    if (topicId !== undefined) {
      const topicRow = db
        .prepare(`SELECT is_closed FROM forum_topics WHERE chat_id = ? AND topic_id = ?`)
        .get(chatId, topicId) as { is_closed: number } | undefined;
      if (topicRow?.is_closed && !access.isAdmin) {
        throw new ApiError(403, 'topic_closed', 'Cannot post in a closed forum topic');
      }
    }

    let replyToMsgId = parseOptionalPositiveInt(
      body.reply_to_msg_id ?? body.reply_to_id,
      'invalid_reply_to',
      'reply_to_msg_id must be a positive integer',
    );
    let quoteText = typeof body.quote_text === 'string' ? body.quote_text : undefined;
    if (body.reply_to !== undefined && body.reply_to !== null) {
      if (typeof body.reply_to === 'number') {
        replyToMsgId = parseOptionalPositiveInt(
          body.reply_to,
          'invalid_reply_to',
          'reply_to must be a positive integer',
        );
      } else if (typeof body.reply_to === 'object' && !Array.isArray(body.reply_to)) {
        const rt = body.reply_to as { reply_to_msg_id?: unknown; quote_text?: unknown };
        replyToMsgId = parseOptionalPositiveInt(
          rt.reply_to_msg_id,
          'invalid_reply_to',
          'reply_to.reply_to_msg_id must be a positive integer',
        );
        const nestedQuote = readOptionalTrimmedString(
          rt.quote_text,
          'invalid_quote_text',
          'quote_text must be a string',
        );
        quoteText = quoteText ?? (nestedQuote || undefined);
      } else {
        throw new ApiError(
          400,
          'invalid_reply_to',
          'reply_to must be a message ID or reply object',
        );
      }
    }

    const validatedSendAsPeerId = validateSendAsPeerId(db, auth.userId, body.send_as_peer_id);

    const result = createMessageAtomic(db, hub, {
      chatId,
      senderId: auth.userId,
      sendAsPeerId: validatedSendAsPeerId,
      text: typeof body.text === 'string' ? body.text : undefined,
      entities: (body.entities as Array<MessageEntity | WireMessageEntity> | undefined) ?? undefined,
      parseMarkdown: body.parse_markdown,
      content: validatedContent,
      replyToMsgId,
      quoteText,
      forwardInfo: (body.forward_info as MessageItem['forward_info']) ?? undefined,
      topicId,
      clientNonce,
      silent: body.silent,
      scheduleAtMs,
      ttlSeconds,
    });

    if (!result.duplicate && result.message.content.type === 'Text' && result.message.text) {
      enrichMessageWebPageAsync(
        db,
        hub,
        chatId,
        result.message.id,
        result.message.text,
        shutdownSignal,
      );
    }

    if (!result.duplicate && !body.skip_server_bot_reply && result.message.text) {
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
      client_nonce: clientNonce,
      status: 'sent',
    });
  };
  router.post('/api/v1/chats/:chatId/messages', handleSendMessage);
  router.post('/api/v1/messages', handleSendMessage);
  router.post('/api/v1/messages/send', handleSendMessage);

  // 3b. Archive Local Fabushi Bot Reply (`v1.6.11` upstream `messages.rs:416-577`, isolated per-caller dedup)
  router.post('/api/v1/chats/:chatId/messages/archive-local-bot-reply', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    if (!Number.isInteger(chatId) || chatId <= 0) {
      throw new ApiError(400, 'invalid_chat_id', 'chatId must be a positive integer');
    }

    const body = await readJsonBody<Partial<ArchiveLocalBotReplyRequest>>(ctx.req);
    const botUserId = parseOptionalPositiveInt(
      body.bot_user_id,
      'invalid_bot_user_id',
      'bot_user_id must be a positive integer',
    );
    if (botUserId === undefined) {
      throw new ApiError(400, 'invalid_bot_user_id', 'bot_user_id must be a positive integer');
    }

    const trimmedText = typeof body.text === 'string' ? body.text.trim() : '';
    const textChars = Array.from(trimmedText).length;
    if (!trimmedText || textChars > 4096) {
      throw new ApiError(400, 'invalid_text', 'text must be 1..=4096 characters');
    }

    const replyToMsgId = parseOptionalPositiveInt(
      body.reply_to_msg_id,
      'invalid_reply_to',
      'reply_to_msg_id must be a positive integer',
    );

    const clientNonce = parsePositiveSafeIntNonce(body.client_nonce);

    // Caller must have write access in this chat (active member, and admin in channels)
    ensureChatWriteAccess(db, chatId, auth.userId);

    // Reject BotFather (777001), non-bot human accounts, and standard (non-Fabushi) bots
    if (botUserId === 777001) {
      throw new ApiError(403, 'invalid_fabushi_bot', 'Cannot archive local reply as BotFather');
    }
    const botUser = db
      .prepare(`SELECT user_id, is_bot FROM users WHERE user_id = ?`)
      .get(botUserId) as { user_id: number; is_bot: number } | undefined;
    if (!botUser || !botUser.is_bot) {
      throw new ApiError(403, 'invalid_fabushi_bot', 'Target bot_user_id is not a registered bot');
    }

    const botReg = db
      .prepare(`SELECT owner_user_id, bot_json FROM bots_registry WHERE bot_user_id = ?`)
      .get(botUserId) as { owner_user_id: number; bot_json: string } | undefined;
    if (botReg?.bot_json) {
      try {
        const parsedBot = JSON.parse(botReg.bot_json) as { is_standard_bot?: boolean };
        if (parsedBot.is_standard_bot === true) {
          throw new ApiError(
            403,
            'invalid_fabushi_bot',
            'Standard bots cannot archive local replies',
          );
        }
      } catch (err) {
        if (err instanceof ApiError) throw err;
      }
    }

    const isOfficialDefault = botUserId === 777000;
    const ownedByCaller = Boolean(botReg && Number(botReg.owner_user_id) === auth.userId);
    const botIsMember = Boolean(
      db
        .prepare(
          `SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ? AND role != 'banned'`,
        )
        .get(chatId, botUserId),
    );
    if (!isOfficialDefault && !ownedByCaller && !botIsMember) {
      throw new ApiError(
        403,
        'bot_not_authorized_in_chat',
        'Bot is not authorized to archive replies in this chat',
      );
    }

    // Per-(caller, chat, bot, nonce) idempotency preventing cross-user/cross-chat nonce leaks
    if (clientNonce !== undefined) {
      const existingArchive = db
        .prepare(
          `SELECT message_id, pts, date_ms
           FROM archive_bot_dedup
           WHERE caller_user_id = ? AND chat_id = ? AND bot_user_id = ? AND client_nonce = ?`,
        )
        .get(auth.userId, chatId, botUserId, clientNonce) as
        | { message_id: number; pts: number; date_ms: number }
        | undefined;
      if (existingArchive) {
        const existingRow = db
          .prepare(`SELECT text_plain FROM messages WHERE chat_id = ? AND message_id = ?`)
          .get(chatId, Number(existingArchive.message_id)) as { text_plain: string } | undefined;
        if (existingRow && existingRow.text_plain !== trimmedText) {
          throw new ApiError(
            409,
            'nonce_conflict',
            'client_nonce was already used with different archived reply text',
          );
        }
        const dupResp: ArchiveLocalBotReplyResponse = {
          message_id: Number(existingArchive.message_id),
          pts: Number(existingArchive.pts),
          date_ms: Number(existingArchive.date_ms),
        };
        sendJson(ctx.res, 200, dupResp);
        return;
      }
    }

    const res = createMessageAtomic(db, hub, {
      chatId,
      senderId: botUserId,
      text: trimmedText,
      parseMarkdown: false,
      replyToMsgId,
    });
    const dateMs = res.message.date_ms ?? Date.now();

    if (clientNonce !== undefined) {
      db.prepare(`
        INSERT OR IGNORE INTO archive_bot_dedup (
          caller_user_id, chat_id, bot_user_id, client_nonce, message_id, pts, date_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(auth.userId, chatId, botUserId, clientNonce, res.message.id, res.pts, dateMs);
    }

    const resp: ArchiveLocalBotReplyResponse = {
      message_id: res.message.id,
      pts: res.pts,
      date_ms: dateMs,
    };
    sendJson(ctx.res, 200, resp);
  });

  // 4. Edit Message (`PATCH` / `PUT`)
  const handleEditMessage = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    const messageId = Number(ctx.params.messageId);
    const body = await readJsonBody<{
      text?: unknown;
      entities?: unknown;
      content?: unknown;
    }>(ctx.req);

    if (body.text !== undefined && body.text !== null && typeof body.text !== 'string') {
      throw new ApiError(400, 'invalid_text', 'Edited text must be a string');
    }
    if (
      body.entities !== undefined &&
      body.entities !== null &&
      !Array.isArray(body.entities)
    ) {
      throw new ApiError(400, 'invalid_entities', 'entities must be an array');
    }
    const validatedContent =
      body.content !== undefined && body.content !== null
        ? validateWireMessageContent(body.content)
        : undefined;

    const res = editMessageAtomic(db, hub, {
      chatId,
      messageId,
      editorUserId: auth.userId,
      text: typeof body.text === 'string' ? body.text : undefined,
      entities: (body.entities as Array<MessageEntity | WireMessageEntity> | undefined) ?? undefined,
      content: validatedContent,
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
    if (body.message_ids !== undefined && !Array.isArray(body.message_ids)) {
      throw new ApiError(400, 'invalid_message_ids', 'message_ids must be an array');
    }
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
      from_chat_id?: unknown;
      to_chat_id?: unknown;
      message_ids?: unknown;
      hide_sender?: boolean;
      hideSender?: boolean;
      comment?: unknown;
      topic_id?: unknown;
    }>(ctx.req);

    const parsedFromChatId = parseOptionalPositiveInt(
      body.from_chat_id,
      'invalid_chat_id',
      'from_chat_id must be a positive integer',
    );
    const parsedToChatId = parseOptionalPositiveInt(
      body.to_chat_id,
      'invalid_chat_id',
      'to_chat_id must be a positive integer',
    );
    const fromChatId = parsedFromChatId ?? Number(ctx.params.chatId);
    const toChatId =
      parsedToChatId ?? (parsedFromChatId !== undefined ? Number(ctx.params.chatId) : NaN);
    ensureChatReadAccess(db, fromChatId, auth.userId);
    ensureChatWriteAccess(db, toChatId, auth.userId);

    const comment = readOptionalTrimmedString(
      body.comment,
      'invalid_comment',
      'comment must be a string',
    );
    const topicId = parseOptionalPositiveInt(
      body.topic_id,
      'invalid_topic_id',
      'topic_id must be a positive integer',
    );
    if (body.message_ids !== undefined && !Array.isArray(body.message_ids)) {
      throw new ApiError(400, 'invalid_message_ids', 'message_ids must be an array');
    }
    const messageIds: number[] = [];
    for (const rawId of (body.message_ids as unknown[] | undefined) ?? []) {
      const msgId = parseOptionalPositiveInt(
        rawId,
        'invalid_message_ids',
        'Each message_id must be a positive integer',
      );
      if (msgId === undefined) {
        throw new ApiError(400, 'invalid_message_ids', 'Each message_id must be a positive integer');
      }
      messageIds.push(msgId);
    }

    const hideSender = Boolean(body.hide_sender ?? body.hideSender);
    const created: MessageItem[] = [];

    if (comment) {
      const commentRes = createMessageAtomic(db, hub, {
        chatId: toChatId,
        senderId: auth.userId,
        text: comment,
        topicId,
      });
      created.push(commentRes.message);
    }

    for (const msgId of messageIds) {
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
        topicId,
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
    const access = ensureChatReadAccess(db, chatId, auth.userId);
    const body = await readJsonBody<{ max_id?: unknown; topic_id?: unknown }>(ctx.req);
    const providedMaxId = parseOptionalNonNegativeInt(
      body.max_id,
      'invalid_max_id',
      'max_id must be a non-negative integer',
    );
    parseOptionalPositiveInt(
      body.topic_id,
      'invalid_topic_id',
      'topic_id must be a positive integer',
    );
    const chatRow = db.prepare(`SELECT last_message_id, pts FROM chats WHERE chat_id = ?`).get(chatId) as {
      last_message_id: number;
      pts: number;
    };
    const maxId = providedMaxId ?? Number(chatRow.last_message_id ?? 0);

    if (!access.isMember) {
      sendJson(ctx.res, 200, {
        ok: true,
        success: true,
        chat_id: chatId,
        pts: Number(chatRow.pts ?? 0),
        read_inbox_max_id: maxId,
        read_outbox_max_id: 0,
        unread_count: 0,
      });
      return;
    }

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

  // 8. Pin / Unpin Messages (groups/supergroups/channels strictly require admin role)
  router.get('/api/v1/chats/:chatId/pins', (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    ensureChatReadAccess(db, chatId, auth.userId);
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
    ensureChatAdminAccess(db, chatId, auth.userId);
    const body = await readJsonBody<{ message_id?: unknown }>(ctx.req);
    const messageId =
      ctx.params.messageId !== undefined
        ? Number(ctx.params.messageId)
        : (parseOptionalPositiveInt(
            body.message_id,
            'invalid_message_id',
            'message_id must be a positive integer',
          ) ?? 0);

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
    ensureChatAdminAccess(db, chatId, auth.userId);

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

  // Real inline keyboard callback query dispatch (zero stub echo responses)
  router.post('/api/v1/chats/:chatId/callback', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    ensureChatMembership(db, chatId, auth.userId);
    const body = await readJsonBody<{ message_id?: unknown; callback_data?: unknown; data?: unknown }>(ctx.req);
    const cbData = readOptionalTrimmedString(
      body.callback_data ?? body.data,
      'invalid_callback',
      'callback_data must be a string',
    );
    if (!cbData) {
      throw new ApiError(400, 'invalid_callback', 'callback_data cannot be empty');
    }
    const msgId =
      parseOptionalNonNegativeInt(
        body.message_id,
        'invalid_message_id',
        'message_id must be a non-negative integer',
      ) ?? 0;
    const callbackQueryId = `cbq_${crypto.randomBytes(8).toString('hex')}`;

    // 1. Official BotFather menu callbacks (Map lookup prevents Object.prototype property bypass)
    const bfCommandMap = new Map<string, string>([
      ['bf:newbot', '/newbot'],
      ['bf:mybots', '/mybots'],
      ['bf:newapp', '/newapp'],
      ['bf:deletebot', '/deletebot'],
      ['bf:setdescription', '/setdescription'],
    ]);
    const mappedBfCmd = bfCommandMap.get(cbData);
    if (mappedBfCmd) {
      onBotMessage(chatId, auth.userId, mappedBfCmd);
      sendJson(ctx.res, 200, {
        ok: true,
        callback_query_id: callbackQueryId,
        companion_chat_id: chatId,
        chat_id: chatId,
        message_id: msgId,
        callback_data: cbData,
      });
      return;
    }

    // 2. Hermes provider CTA callback
    if (cbData === 'hermes:open_ai_providers') {
      sendJson(ctx.res, 200, {
        ok: true,
        callback_query_id: callbackQueryId,
        companion_chat_id: chatId,
        chat_id: chatId,
        message_id: msgId,
        callback_data: cbData,
        toast: '请打开「设置 → AI 订阅与模型供应商」选择或配置模型供应商',
      });
      return;
    }

    // 3. Hermes tool approval callback (`hermes:approve:<approvalId>:<decision>`)
    if (cbData.startsWith('hermes:approve:')) {
      const parts = cbData.split(':');
      const approvalId = parts[2]?.trim() ?? '';
      const decision = parts[3]?.trim() ?? '';
      const allowedDecisions = new Set(['approve_once', 'approve_session', 'approve_always', 'deny']);
      if (!approvalId || !allowedDecisions.has(decision)) {
        throw new ApiError(400, 'invalid_callback', 'Malformed Hermes approval callback_data');
      }
      const approvalRow = db
        .prepare(`SELECT approval_json FROM hermes_approvals WHERE approval_id = ? AND user_id = ?`)
        .get(approvalId, auth.userId) as { approval_json: string } | undefined;
      if (!approvalRow) {
        throw new ApiError(404, 'approval_not_found', 'Approval request not found');
      }
      const approvalObj = JSON.parse(approvalRow.approval_json) as Record<string, unknown>;
      approvalObj.status = decision === 'deny' ? 'denied' : 'approved';
      approvalObj.decision = decision;
      approvalObj.resolved_at_ms = Date.now();
      db.prepare(`UPDATE hermes_approvals SET approval_json = ? WHERE approval_id = ? AND user_id = ?`).run(
        JSON.stringify(approvalObj),
        approvalId,
        auth.userId,
      );
      sendJson(ctx.res, 200, {
        ok: true,
        callback_query_id: callbackQueryId,
        companion_chat_id: chatId,
        chat_id: chatId,
        message_id: msgId,
        callback_data: cbData,
        toast: decision === 'deny' ? '已拒绝工具执行请求' : '已批准工具执行请求',
      });
      return;
    }

    // 4. Real bot member in this chat -> persist callback_query into bot_api_updates & invoke bot turn if command
    const botMember = db
      .prepare(
        `SELECT u.user_id, u.username
         FROM chat_members cm
         JOIN users u ON u.user_id = cm.user_id
         WHERE cm.chat_id = ? AND u.is_bot = 1 AND cm.role != 'banned'
         LIMIT 1`,
      )
      .get(chatId) as { user_id: number; username: string | null } | undefined;

    if (botMember) {
      const botUserId = Number(botMember.user_id);
      const botUsername = botMember.username ?? `bot_${botUserId}`;
      const caller = getUserProfileDto(db, auth.userId);
      db.prepare(
        `INSERT INTO bot_api_updates (bot_user_id, payload_json, created_at_ms) VALUES (?, ?, ?)`,
      ).run(
        botUserId,
        JSON.stringify({
          callback_query: {
            id: callbackQueryId,
            from: caller ?? { user_id: auth.userId },
            chat_id: chatId,
            message_id: msgId,
            data: cbData,
          },
        }),
        Date.now(),
      );
      if (cbData.startsWith('/')) {
        onBotMessage(chatId, auth.userId, cbData);
      }
      sendJson(ctx.res, 200, {
        ok: true,
        callback_query_id: callbackQueryId,
        companion_chat_id: chatId,
        chat_id: chatId,
        message_id: msgId,
        callback_data: cbData,
        toast: `已发送回调至 @${botUsername}`,
      });
      return;
    }

    throw new ApiError(
      404,
      'unknown_callback',
      'No bot or callback handler registered for this chat',
    );
  });

  // 9. Reactions (`GET` details & `POST` toggle/add/remove)
  router.get('/api/v1/chats/:chatId/messages/:messageId/reactions', (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    const messageId = Number(ctx.params.messageId);
    ensureChatReadAccess(db, chatId, auth.userId);

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
    ensureChatReadAccess(db, chatId, auth.userId);

    const body = await readJsonBody<{ emoji?: unknown; action?: unknown }>(ctx.req);
    const emoji = readOptionalTrimmedString(
      body.emoji,
      'invalid_emoji',
      'Reaction emoji must be a string',
    );
    if (!emoji) throw new ApiError(400, 'missing_emoji', 'Reaction emoji is required');
    if (
      body.action !== undefined &&
      body.action !== null &&
      (typeof body.action !== 'string' || !['toggle', 'add', 'remove'].includes(body.action))
    ) {
      throw new ApiError(400, 'invalid_action', 'action must be one of toggle, add, remove');
    }

    const exists = db
      .prepare(
        `SELECT 1 FROM message_reactions WHERE chat_id = ? AND message_id = ? AND user_id = ? AND emoji = ?`,
      )
      .get(chatId, messageId, auth.userId, emoji);

    const action = (typeof body.action === 'string' ? body.action : 'toggle') as
      | 'toggle'
      | 'add'
      | 'remove';
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
    ensureChatWriteAccess(db, chatId, auth.userId);

    const body = await readJsonBody<{
      question?: unknown;
      options?: unknown;
      is_anonymous?: boolean;
      allows_multiple_answers?: boolean;
      multiple_choice?: boolean;
      is_quiz?: boolean;
      correct_option_id?: unknown;
      solution?: unknown;
      explanation?: unknown;
      topic_id?: unknown;
      client_nonce?: unknown;
    }>(ctx.req);

    const clientNonce = parsePositiveSafeIntNonce(body.client_nonce);
    const topicId = parseOptionalPositiveInt(
      body.topic_id,
      'invalid_topic_id',
      'topic_id must be a positive integer',
    );
    const correctOptionId = parseOptionalNonNegativeInt(
      body.correct_option_id,
      'invalid_quiz_answer',
      'correct_option_id must be a non-negative integer',
    );
    const question = readOptionalTrimmedString(
      body.question,
      'invalid_question',
      'Poll question must be a string',
    );
    if (body.options !== undefined && !Array.isArray(body.options)) {
      throw new ApiError(400, 'invalid_options', 'Poll options must be an array of strings');
    }
    const rawOptions = ((body.options as unknown[] | undefined) ?? [])
      .map((o) => {
        if (typeof o !== 'string') {
          throw new ApiError(400, 'invalid_options', 'Each poll option must be a string');
        }
        return o.trim();
      })
      .filter(Boolean);
    if (body.solution !== undefined && body.solution !== null && typeof body.solution !== 'string') {
      throw new ApiError(400, 'invalid_solution', 'Poll solution must be a string');
    }
    if (
      body.explanation !== undefined &&
      body.explanation !== null &&
      typeof body.explanation !== 'string'
    ) {
      throw new ApiError(400, 'invalid_explanation', 'Poll explanation must be a string');
    }
    if (!question) throw new ApiError(400, 'invalid_question', 'Poll question cannot be empty');
    if (rawOptions.length < 2 || rawOptions.length > 12) {
      throw new ApiError(400, 'invalid_options', 'Polls require between 2 and 12 non-empty options');
    }

    const isQuiz = Boolean(body.is_quiz);
    if (
      isQuiz &&
      (correctOptionId === undefined ||
        correctOptionId < 0 ||
        correctOptionId >= rawOptions.length)
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
      correct_option_id: isQuiz ? correctOptionId : undefined,
      solution: (body.solution as string | undefined) ?? (body.explanation as string | undefined),
      explanation: (body.explanation as string | undefined) ?? (body.solution as string | undefined),
    };

    const msgRes = createMessageAtomic(db, null, {
      chatId,
      senderId: auth.userId,
      content: { type: 'Poll', data: tempPoll },
      topicId,
      clientNonce,
    });

    if (msgRes.duplicate) {
      const hydratedExisting = getMessageById(db, chatId, msgRes.message.id, auth.userId)!;
      const existingPollRow = db
        .prepare(`SELECT poll_id, poll_json, is_closed FROM polls WHERE chat_id = ? AND message_id = ? LIMIT 1`)
        .get(chatId, msgRes.message.id) as
        | { poll_id: number; poll_json: string; is_closed: number }
        | undefined;
      let existingPoll: PollData;
      if (existingPollRow) {
        const basePoll = JSON.parse(existingPollRow.poll_json) as PollData;
        basePoll.is_closed = Boolean(existingPollRow.is_closed);
        existingPoll = recomputePollState(db, Number(existingPollRow.poll_id), basePoll, auth.userId);
      } else if (hydratedExisting.content.type === 'Poll') {
        existingPoll = hydratedExisting.content.data;
      } else {
        existingPoll = tempPoll;
      }
      sendJson(ctx.res, 200, {
        message: hydratedExisting,
        poll: existingPoll,
        pts: msgRes.pts,
        duplicate: true,
      });
      return;
    }

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
    const body = await readJsonBody<{ option_ids?: unknown }>(ctx.req);
    if (body.option_ids !== undefined && !Array.isArray(body.option_ids)) {
      throw new ApiError(400, 'invalid_option_ids', 'option_ids must be an array');
    }
    const updatedPoll = castPollVoteAtomic(db, hub, auth.userId, {
      pollId: ctx.params.pollId ? Number(ctx.params.pollId) : undefined,
      chatId: ctx.params.chatId ? Number(ctx.params.chatId) : undefined,
      messageId: ctx.params.messageId ? Number(ctx.params.messageId) : undefined,
      optionIds: (body.option_ids as number[] | undefined) ?? [],
    });
    sendJson(ctx.res, 200, updatedPoll);
  };
  router.post('/api/v1/polls/:pollId/vote', handleVotePoll);
  router.post('/api/v1/chats/:chatId/messages/:messageId/poll/vote', handleVotePoll);

  router.post('/api/v1/polls/:pollId/retract', (ctx) => {
    const auth = requireAuth(db, ctx);
    const updatedPoll = castPollVoteAtomic(db, hub, auth.userId, {
      pollId: Number(ctx.params.pollId),
      optionIds: [],
    });
    sendJson(ctx.res, 200, updatedPoll);
  });

  const handleClosePoll = (ctx: RequestContext): void => {
    const auth = requireAuth(db, ctx);
    const pollRow = (
      ctx.params.pollId
        ? db.prepare(`SELECT * FROM polls WHERE poll_id = ?`).get(Number(ctx.params.pollId))
        : db
            .prepare(`SELECT * FROM polls WHERE chat_id = ? AND message_id = ?`)
            .get(Number(ctx.params.chatId), Number(ctx.params.messageId))
    ) as
      | { poll_id: number; chat_id: number; message_id: number; creator_id: number; poll_json: string }
      | undefined;
    if (!pollRow) throw new ApiError(404, 'poll_not_found', 'Poll not found');
    const pollId = Number(pollRow.poll_id);
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
  };
  router.post('/api/v1/polls/:pollId/close', handleClosePoll);
  router.post('/api/v1/chats/:chatId/messages/:messageId/poll/close', handleClosePoll);

  const handleGetPoll = (ctx: RequestContext): void => {
    const auth = requireAuth(db, ctx);
    const pollId = Number(ctx.params.pollId);
    const pollRow = db.prepare(`SELECT * FROM polls WHERE poll_id = ?`).get(pollId) as
      | { poll_id: number; chat_id: number; poll_json: string; is_closed: number }
      | undefined;
    if (!pollRow) throw new ApiError(404, 'poll_not_found', 'Poll not found');
    ensureChatReadAccess(db, Number(pollRow.chat_id), auth.userId);

    const basePoll = JSON.parse(pollRow.poll_json) as PollData;
    basePoll.is_closed = Boolean(pollRow.is_closed);
    const computed = recomputePollState(db, pollId, basePoll, auth.userId);
    sendJson(ctx.res, 200, {
      ...computed,
      chat_id: Number(pollRow.chat_id),
      poll: computed,
    });
  };
  router.get('/api/v1/polls/:pollId/results', handleGetPoll);
  router.get('/api/v1/polls/:pollId', handleGetPoll);

  // 11. Collaborative Todo Checklists (`create` & `toggle`)
  router.post('/api/v1/chats/:chatId/todos', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    ensureChatWriteAccess(db, chatId, auth.userId);
    const body = await readJsonBody<{
      title?: unknown;
      items?: unknown;
      topic_id?: unknown;
    }>(ctx.req);

    const topicId = parseOptionalPositiveInt(
      body.topic_id,
      'invalid_topic_id',
      'topic_id must be a positive integer',
    );
    const title = readOptionalTrimmedString(
      body.title,
      'invalid_todo',
      'Todo title must be a string',
    );
    if (body.items !== undefined && !Array.isArray(body.items)) {
      throw new ApiError(400, 'invalid_todo', 'Todo items must be an array');
    }
    const rawItems = (body.items as unknown[] | undefined) ?? [];
    if (!title || rawItems.length === 0 || rawItems.length > 30) {
      throw new ApiError(400, 'invalid_todo', 'Todo checklist requires a title and 1–30 items');
    }

    const listId = `todo_${crypto.randomBytes(6).toString('hex')}`;
    const items = rawItems.map((it, idx) => {
      if (typeof it === 'string') {
        return { id: `item_${idx + 1}`, title: it.trim(), completed: false };
      }
      if (it && typeof it === 'object' && !Array.isArray(it)) {
        const obj = it as { id?: unknown; title?: unknown; completed?: unknown };
        if (typeof obj.title !== 'string') {
          throw new ApiError(400, 'invalid_todo', 'Each todo item title must be a string');
        }
        if (obj.id !== undefined && obj.id !== null && typeof obj.id !== 'string') {
          throw new ApiError(400, 'invalid_todo', 'Each todo item id must be a string');
        }
        return {
          id: (typeof obj.id === 'string' && obj.id) || `item_${idx + 1}`,
          title: obj.title.trim(),
          completed: Boolean(obj.completed),
        };
      }
      throw new ApiError(
        400,
        'invalid_todo',
        'Each todo item must be a string or an object with a string title',
      );
    });

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
      topicId,
    });
    sendJson(ctx.res, 201, { message: res.message, todo: card, pts: res.pts });
  });

  router.post('/api/v1/chats/:chatId/messages/:messageId/todo', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    const messageId = Number(ctx.params.messageId);
    ensureChatWriteAccess(db, chatId, auth.userId);

    const existing = getMessageById(db, chatId, messageId, auth.userId);
    if (!existing || existing.content.type !== 'Todo') {
      throw new ApiError(404, 'todo_not_found', 'Todo checklist message not found');
    }

    const body = await readJsonBody<{ item_id?: unknown; completed?: boolean }>(ctx.req);
    const itemId = readOptionalTrimmedString(
      body.item_id,
      'invalid_item_id',
      'item_id must be a string',
    );
    if (!itemId) {
      throw new ApiError(400, 'invalid_item_id', 'item_id is required');
    }
    const card = structuredClone(existing.content.data);
    if (
      !card ||
      typeof card !== 'object' ||
      Array.isArray(card) ||
      !Array.isArray(card.items) ||
      !card.items.every((i) => Boolean(i) && typeof i === 'object' && !Array.isArray(i))
    ) {
      throw new ApiError(400, 'invalid_todo', 'Todo checklist message has invalid items');
    }
    const targetItem = card.items.find((i) => i.id === itemId);
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
    ensureChatWriteAccess(db, chatId, auth.userId);
    const body = await readJsonBody<{
      title?: unknown;
      description?: unknown;
      currency?: unknown;
      amount?: unknown;
      amount_cents?: unknown;
      topic_id?: unknown;
    }>(ctx.req);

    const topicId = parseOptionalPositiveInt(
      body.topic_id,
      'invalid_topic_id',
      'topic_id must be a positive integer',
    );
    const rawTitle = readOptionalTrimmedString(
      body.title,
      'invalid_invoice',
      'Invoice title must be a string',
    );
    const rawDescription = readOptionalTrimmedString(
      body.description,
      'invalid_invoice',
      'Invoice description must be a string',
    );
    const rawCurrency = readOptionalTrimmedString(
      body.currency,
      'invalid_invoice',
      'Invoice currency must be a string',
    );
    const rawAmount = body.amount ?? body.amount_cents;
    let amount = 100;
    if (rawAmount !== undefined && rawAmount !== null) {
      if (
        typeof rawAmount !== 'number' ||
        !Number.isInteger(rawAmount) ||
        rawAmount < 1 ||
        rawAmount > Number.MAX_SAFE_INTEGER
      ) {
        throw new ApiError(400, 'invalid_invoice', 'amount must be a positive integer');
      }
      amount = rawAmount;
    }
    const invId = `inv_${crypto.randomBytes(6).toString('hex')}`;
    const card: InvoiceCard = {
      id: invId,
      invoice_id: invId,
      title: rawTitle || 'Stars Invoice',
      description: rawDescription || 'Instant checkout via GPUI Telegram Wallet',
      currency: (rawCurrency || 'XTR').toUpperCase(),
      amount_cents: amount,
      total_amount: amount,
      status: 'pending',
      is_paid: false,
      prices: [{ label: rawTitle || 'Item', amount_cents: amount }],
    };

    const res = createMessageAtomic(db, hub, {
      chatId,
      senderId: auth.userId,
      content: { type: 'Invoice', data: card },
      topicId,
    });
    sendJson(ctx.res, 201, { message: res.message, invoice: card, pts: res.pts });
  });

  router.post('/api/v1/chats/:chatId/messages/:messageId/pay', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const chatId = Number(ctx.params.chatId);
    const messageId = Number(ctx.params.messageId);
    const access = ensureChatReadAccess(db, chatId, auth.userId);
    if (access.chatType === 3) {
      ensureChatWriteAccess(db, chatId, auth.userId);
    }
    const body = await readJsonBody<{ idempotency_key?: unknown }>(ctx.req);
    const bodyIdempotencyKey = readOptionalTrimmedString(
      body.idempotency_key,
      'invalid_idempotency_key',
      'idempotency_key must be a string',
    );

    const headerIdem = ctx.req.headers['idempotency-key'];
    const idempotencyKey =
      (typeof headerIdem === 'string' && headerIdem.trim() ? headerIdem.trim() : undefined) ??
      (bodyIdempotencyKey || undefined);
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
    if (!card || typeof card !== 'object' || Array.isArray(card)) {
      throw new ApiError(400, 'invalid_invoice', 'Invoice message has invalid payload');
    }
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

    if (
      typeof card.total_amount !== 'number' ||
      !Number.isInteger(card.total_amount) ||
      card.total_amount < 1 ||
      card.total_amount > Number.MAX_SAFE_INTEGER ||
      typeof card.currency !== 'string' ||
      card.currency.trim().length === 0 ||
      typeof card.title !== 'string'
    ) {
      throw new ApiError(400, 'invalid_invoice', 'Invoice has an invalid payload');
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
    const limit = parseBoundedQueryInt(ctx.query.get('limit'), 50, 1, 100);
    const offset = parseBoundedQueryInt(ctx.query.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);

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
    const body = await readJsonBody<{ text?: unknown; mode?: unknown }>(ctx.req);
    const text = readOptionalTrimmedString(body.text, 'invalid_text', 'text must be a string');
    const mode =
      readOptionalTrimmedString(body.mode, 'invalid_mode', 'mode must be a string') || 'improve';
    if (!text) {
      throw new ApiError(400, 'empty_text', 'text is required');
    }

    const defaultInstruction =
      'Polish and improve the clarity of the following message in the same language. Output only the improved message.';
    const modeInstruction = new Map<string, string>([
      [
        'translate_zh',
        'Translate the following message accurately into natural Simplified Chinese. Output only the translation.',
      ],
      [
        'translate_en',
        'Translate the following message accurately into natural English. Output only the translation.',
      ],
      [
        'shorter',
        'Rewrite the following message to be concise while preserving the original meaning and language. Output only the rewritten message.',
      ],
      [
        'formal',
        'Rewrite the following message in a polite, professional tone in the same language. Output only the rewritten message.',
      ],
      ['improve', defaultInstruction],
    ]);
    const systemInstruction = modeInstruction.get(mode) ?? defaultInstruction;

    let llmError: string | undefined;
    if (config) {
      const llmRes = await runConfiguredLlmCompletion(
        db,
        config,
        auth.userId,
        [
          { role: 'system', content: systemInstruction },
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
      llmError = llmRes.error;
    }

    throw new ApiError(
      503,
      'ai_provider_unconfigured',
      llmError
        ? `AI 写作助手调用模型失败：${llmError}`
        : '请先在 Magpie LLM 网关配置并启用可用的模型提供商后再使用 AI 写作助手。',
    );
  });
}
