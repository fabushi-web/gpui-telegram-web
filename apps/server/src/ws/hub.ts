import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import type { DatabaseSync } from 'node:sqlite';
import { WebSocket, WebSocketServer } from 'ws';
import type {
  PtsUpdate,
  TypingAction,
  UpdateEvent,
  WsClientFrame,
  WsServerFrame,
} from '@gpui-telegram/protocol';
import { ApiError, authenticateToken, extractBearerToken } from '../utils/http.js';
import {
  castPollVoteAtomic,
  commitPtsEventAtomic,
  computeChatDifference,
  createMessageAtomic,
  deleteMessagesAtomic,
  editMessageAtomic,
  ensureChatMembership,
  getChatMemberIds,
  getMessageReactions,
  type PtsBroadcastSink,
} from '../db/queries.js';
import type { BrowserControlBridge } from '../routes/browserControl.js';

interface ConnectedClient {
  ws: WebSocket;
  userId: number | null;
  sessionId: string | null;
  subscribedChats: Set<number>;
  isAlive: boolean;
  mode: 'ws' | 'derp' | 'browser_tab' | 'browser_controller';
  deviceId?: string;
  desktopToken?: string;
}

export class RealtimeGatewayHub implements PtsBroadcastSink {
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<ConnectedClient>();
  private readonly pingInterval: NodeJS.Timeout;
  private botTriggerHook?: (chatId: number, senderId: number, messageText: string) => void;
  private browserBridge?: BrowserControlBridge;

  constructor(private readonly db: DatabaseSync) {
    this.wss = new WebSocketServer({ noServer: true });

    this.pingInterval = setInterval(() => {
      for (const client of this.clients) {
        if (!client.isAlive) {
          this.browserBridge?.unregisterSocket(client.ws);
          client.ws.terminate();
          this.clients.delete(client);
          continue;
        }
        client.isAlive = false;
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.ping();
        }
      }
    }, 25_000);
    this.pingInterval.unref();
  }

  setBotTriggerHook(hook: (chatId: number, senderId: number, messageText: string) => void): void {
    this.botTriggerHook = hook;
  }

  setBrowserControlBridge(bridge: BrowserControlBridge): void {
    this.browserBridge = bridge;
  }

  getOnlineUsersCount(): number {
    const uids = new Set<number>();
    for (const c of this.clients) {
      if (c.userId !== null && c.mode === 'ws' && c.ws.readyState === WebSocket.OPEN) {
        uids.add(c.userId);
      }
    }
    return uids.size;
  }

  attachToServer(server: HttpServer): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      const isWs = reqUrl.pathname === '/api/v1/ws';
      const isDerp = reqUrl.pathname === '/api/v1/tailnet/derp' || reqUrl.searchParams.get('mode') === 'derp';
      const isBrowserWs = reqUrl.pathname === '/api/v1/browser/ws';

      if (!isWs && !isDerp && !isBrowserWs) {
        socket.destroy();
        return;
      }

      if (isBrowserWs) {
        const rawToken =
          this.browserBridge?.extractRequestToken(req, reqUrl.searchParams) ??
          extractBearerToken(req, reqUrl.searchParams);
        const browserAuth = this.browserBridge?.authenticateTokenString(rawToken) ?? null;

        if (rawToken && !browserAuth) {
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }

        const requestedRole = reqUrl.searchParams.get('role');
        const mode: ConnectedClient['mode'] =
          requestedRole === 'controller' || browserAuth?.callerKind === 'desktop_controller'
            ? 'browser_controller'
            : 'browser_tab';

        this.wss.handleUpgrade(req, socket, head, (ws) => {
          const client: ConnectedClient = {
            ws,
            userId: browserAuth?.userId ?? null,
            sessionId: browserAuth ? `bws_${browserAuth.userId}` : null,
            subscribedChats: new Set<number>(),
            isAlive: true,
            mode,
            deviceId: reqUrl.searchParams.get('device_id') ?? undefined,
            desktopToken:
              browserAuth?.callerKind === 'desktop_controller' ? browserAuth.rawToken : undefined,
          };
          this.clients.add(client);

          ws.on('pong', () => {
            client.isAlive = true;
          });
          ws.on('close', () => {
            this.browserBridge?.unregisterSocket(ws);
            this.clients.delete(client);
          });
          ws.on('error', () => {
            this.browserBridge?.unregisterSocket(ws);
            this.clients.delete(client);
          });

          if (browserAuth) {
            this.sendFrame(ws, {
              type: 'AuthOk',
              payload: {
                user_id: browserAuth.userId,
                session_id: client.sessionId ?? 'browser_ws',
                server_time_ms: Date.now(),
              },
            });
            if (mode === 'browser_controller') {
              this.browserBridge?.registerControllerSocket(
                ws,
                browserAuth.userId,
                client.desktopToken,
              );
            }
          }

          ws.on('message', (rawData) => {
            client.isAlive = true;
            this.handleIncomingMessage(client, rawData.toString('utf8'));
          });
        });
        return;
      }

      const token = extractBearerToken(req, reqUrl.searchParams);
      const auth = authenticateToken(this.db, token);

      // If a token was explicitly provided in query/header and is invalid, reject immediately with 401!
      if (token && !auth) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        const client: ConnectedClient = {
          ws,
          userId: auth?.userId ?? null,
          sessionId: auth?.sessionId ?? null,
          subscribedChats: new Set<number>(),
          isAlive: true,
          mode: isDerp ? 'derp' : 'ws',
          deviceId: reqUrl.searchParams.get('device_id') ?? undefined,
        };
        this.clients.add(client);

        ws.on('pong', () => {
          client.isAlive = true;
        });

        ws.on('close', () => {
          this.browserBridge?.unregisterSocket(ws);
          this.clients.delete(client);
        });

        ws.on('error', () => {
          this.browserBridge?.unregisterSocket(ws);
          this.clients.delete(client);
        });

        if (auth) {
          this.autoSubscribeUserChats(client, auth.userId);
          if (client.mode === 'derp') {
            this.sendJson(ws, {
              type: 'welcome',
              derp_region: 'primary',
              server_time_ms: Date.now(),
            });
          } else {
            this.sendFrame(ws, {
              type: 'AuthOk',
              payload: {
                user_id: auth.userId,
                session_id: auth.sessionId,
                server_time_ms: Date.now(),
              },
            });
          }
        }

        ws.on('message', (rawData) => {
          client.isAlive = true;
          this.handleIncomingMessage(client, rawData.toString('utf8'));
        });
      });
    });
  }

  private autoSubscribeUserChats(client: ConnectedClient, userId: number): void {
    const rows = this.db
      .prepare(`SELECT chat_id FROM chat_members WHERE user_id = ? AND role != 'banned'`)
      .all(userId) as Array<{ chat_id: number }>;
    for (const r of rows) {
      client.subscribedChats.add(Number(r.chat_id));
    }
  }

  private sendJson(ws: WebSocket, obj: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  private sendFrame(ws: WebSocket, frame: WsServerFrame): void {
    this.sendJson(ws, frame);
  }

  sendToUser(userId: number, frame: unknown): void {
    for (const c of this.clients) {
      if (c.userId === userId && c.mode === 'ws' && c.ws.readyState === WebSocket.OPEN) {
        this.sendJson(c.ws, frame);
      }
    }
  }

  disconnectSession(sessionId: string): void {
    for (const c of this.clients) {
      if (c.sessionId === sessionId) {
        c.ws.close(4001, 'Session revoked');
        this.clients.delete(c);
      }
    }
  }

  disconnectAllSessions(): void {
    for (const c of this.clients) {
      try {
        c.ws.close(1012, 'Server reset');
      } catch {
        // Ignore already-closed sockets
      }
    }
    this.clients.clear();
  }

  broadcastChatPtsUpdate(chatId: number, ptsUpdate: PtsUpdate): void {
    const memberSet = new Set<number>(getChatMemberIds(this.db, chatId));
    for (const client of this.clients) {
      if (client.mode !== 'ws' || client.userId === null || client.ws.readyState !== WebSocket.OPEN) {
        continue;
      }
      if (!memberSet.has(client.userId) && !client.subscribedChats.has(chatId)) {
        continue;
      }

      // Customize viewer-relative `is_out` on NewMessage/EditMessage per recipient
      let tailoredUpdate = ptsUpdate;
      if (
        (ptsUpdate.event.type === 'NewMessage' || ptsUpdate.event.type === 'EditMessage') &&
        ptsUpdate.event.data
      ) {
        const msg = ptsUpdate.event.data;
        tailoredUpdate = {
          ...ptsUpdate,
          event: {
            type: ptsUpdate.event.type,
            data: {
              ...msg,
              flags: {
                ...msg.flags,
                is_out: msg.sender_id === client.userId,
              },
            },
          },
        };
      }

      this.sendFrame(client.ws, {
        type: 'PtsUpdate',
        payload: tailoredUpdate,
      });
    }
  }

  broadcastChatEphemeral(chatId: number, event: UpdateEvent, excludeUserId?: number): void {
    const memberSet = new Set<number>(getChatMemberIds(this.db, chatId));
    for (const client of this.clients) {
      if (client.mode !== 'ws' || client.userId === null || client.ws.readyState !== WebSocket.OPEN) {
        continue;
      }
      if (excludeUserId !== undefined && client.userId === excludeUserId) {
        continue;
      }
      if (!memberSet.has(client.userId) && !client.subscribedChats.has(chatId)) {
        continue;
      }
      this.sendFrame(client.ws, {
        type: 'Update',
        payload: event,
      });
    }
  }

  private handleIncomingMessage(client: ConnectedClient, rawText: string): void {
    let parsed: WsClientFrame | Record<string, unknown>;
    try {
      parsed = JSON.parse(rawText) as WsClientFrame;
    } catch {
      this.sendFrame(client.ws, {
        type: 'Error',
        payload: { code: 400, message: 'Invalid JSON WebSocket frame' },
      });
      return;
    }

    if (client.mode === 'derp') {
      this.handleDerpFrame(client, parsed as Record<string, unknown>);
      return;
    }

    const frame = parsed as WsClientFrame;

    if (frame.type === 'Ping') {
      this.sendFrame(client.ws, {
        type: 'Pong',
        payload: {
          nonce: frame.payload?.nonce,
          client_ts: frame.payload?.client_ts,
          server_ts: Date.now(),
        },
      });
      return;
    }

    if (frame.type === 'Auth') {
      if (client.mode === 'browser_tab' || client.mode === 'browser_controller') {
        const bAuth = this.browserBridge?.authenticateTokenString(frame.payload?.token ?? null) ?? null;
        if (!bAuth) {
          this.sendFrame(client.ws, {
            type: 'AuthError',
            payload: { reason: 'Invalid, expired, or revoked browser bridge token' },
          });
          client.ws.close(4001, 'Unauthorized');
          return;
        }
        client.userId = bAuth.userId;
        client.sessionId = `bws_${bAuth.userId}`;
        if (bAuth.callerKind === 'desktop_controller') {
          client.mode = 'browser_controller';
          client.desktopToken = bAuth.rawToken;
        }
        this.sendFrame(client.ws, {
          type: 'AuthOk',
          payload: {
            user_id: bAuth.userId,
            session_id: client.sessionId,
            server_time_ms: Date.now(),
          },
        });
        if (client.mode === 'browser_controller') {
          this.browserBridge?.registerControllerSocket(
            client.ws,
            bAuth.userId,
            client.desktopToken,
          );
        }
        return;
      }

      const auth = authenticateToken(this.db, frame.payload?.token ?? null);
      if (!auth) {
        this.sendFrame(client.ws, {
          type: 'AuthError',
          payload: { reason: 'Invalid or expired token' },
        });
        client.ws.close(4001, 'Unauthorized');
        return;
      }
      client.userId = auth.userId;
      client.sessionId = auth.sessionId;
      this.autoSubscribeUserChats(client, auth.userId);
      this.sendFrame(client.ws, {
        type: 'AuthOk',
        payload: {
          user_id: auth.userId,
          session_id: auth.sessionId,
          server_time_ms: Date.now(),
        },
      });
      return;
    }

    if (client.userId === null) {
      this.sendFrame(client.ws, {
        type: 'Error',
        payload: { code: 401, message: 'WebSocket not authenticated' },
      });
      return;
    }

    // Enforce strict scope on desktop controller tokens (`bctrl_...`)
    if (
      client.desktopToken &&
      frame.type !== 'BrowserCommand'
    ) {
      // Also verify token has not been revoked mid-session
      if (!this.browserBridge?.authenticateTokenString(client.desktopToken)) {
        this.sendFrame(client.ws, {
          type: 'AuthError',
          payload: { reason: 'Desktop browser token was revoked' },
        });
        client.ws.close(4003, 'Revoked');
        return;
      }
      this.sendFrame(client.ws, {
        type: 'Error',
        payload: {
          code: 403,
          message: 'Desktop browser token is strictly scoped to BrowserCommand frames',
        },
      });
      return;
    }

    try {
      switch (frame.type) {
        case 'BrowserRegister': {
          if (!this.browserBridge) break;
          const desc = this.browserBridge.registerLiveTab(
            client.userId,
            frame.payload,
            client.ws,
          );
          this.sendFrame(client.ws, { type: 'BrowserRegistered', payload: desc });
          break;
        }
        case 'BrowserStateReport': {
          if (!this.browserBridge) break;
          this.browserBridge.reportTabState(client.userId, frame.payload);
          break;
        }
        case 'BrowserCommandResult': {
          if (!this.browserBridge) break;
          this.browserBridge.resolveTabCommandResult(client.userId, frame.payload);
          break;
        }
        case 'BrowserCommand': {
          if (!this.browserBridge) break;
          if (client.desktopToken && !this.browserBridge.authenticateTokenString(client.desktopToken)) {
            this.sendFrame(client.ws, {
              type: 'AuthError',
              payload: { reason: 'Desktop browser token was revoked' },
            });
            client.ws.close(4003, 'Revoked');
            return;
          }
          const uid = client.userId;
          const bridge = this.browserBridge;
          const callerAuth = {
            userId: uid,
            callerKind: client.desktopToken
              ? ('desktop_controller' as const)
              : ('user_session' as const),
            callerLabel:
              frame.payload.caller_label ||
              (client.desktopToken ? 'Desktop WS Bridge' : `Web WS (${uid})`),
            rawToken: client.desktopToken ?? '',
            generation: bridge.getGeneration(uid),
          };
          void bridge
            .dispatchCommand(callerAuth, frame.payload)
            .then((res) => {
              this.sendFrame(client.ws, { type: 'BrowserCommandResult', payload: res });
            })
            .catch((err) => {
              const code = err instanceof ApiError ? err.status : 500;
              const msg = err instanceof Error ? err.message : 'Browser command failed';
              this.sendFrame(client.ws, {
                type: 'BrowserCommandResult',
                payload: {
                  ok: false,
                  command_id: frame.payload.command_id ?? 'unknown',
                  target_id: frame.payload.target_id ?? 'unknown',
                  generation: bridge.getGeneration(uid),
                  action: frame.payload.action,
                  error: msg,
                  latency_ms: 0,
                },
              });
              this.sendFrame(client.ws, {
                type: 'Error',
                payload: { code, message: msg },
              });
            });
          break;
        }
        case 'SubscribeChat': {
          const cid = Number(frame.payload.chat_id);
          ensureChatMembership(this.db, cid, client.userId);
          client.subscribedChats.add(cid);
          break;
        }
        case 'SubscribeChats': {
          for (const cid of frame.payload.chat_ids ?? []) {
            ensureChatMembership(this.db, Number(cid), client.userId);
            client.subscribedChats.add(Number(cid));
          }
          break;
        }
        case 'UnsubscribeChat': {
          client.subscribedChats.delete(Number(frame.payload.chat_id));
          break;
        }
        case 'Sync':
        case 'GetDifference': {
          const diff = computeChatDifference(this.db, client.userId, frame.payload);
          this.sendFrame(client.ws, {
            type: frame.type === 'Sync' ? 'SyncDiff' : 'Difference',
            payload: diff,
          });
          break;
        }
        case 'SendMessage': {
          const p = frame.payload;
          ensureChatMembership(this.db, Number(p.chat_id), client.userId);
          const result = createMessageAtomic(this.db, this, {
            chatId: Number(p.chat_id),
            senderId: client.userId,
            text: p.text,
            entities: p.entities,
            content: p.content,
            replyToMsgId: p.reply_to,
            quoteText: p.quote_text,
            topicId: p.topic_id,
            clientNonce: p.client_nonce,
            silent: p.silent,
            scheduleAtMs: p.scheduled_at_ms,
            inlineKeyboard: p.inline_keyboard,
          });
          const ackPayload = {
            correlation_id: p.client_nonce,
            client_nonce: p.client_nonce,
            chat_id: Number(p.chat_id),
            message_id: result.message.id,
            pts: result.pts,
            duplicate: result.duplicate,
            date_ms: result.message.date_ms ?? Date.now(),
          };
          this.sendFrame(client.ws, { type: 'SendAck', payload: ackPayload });
          if (!result.duplicate && result.message.text && this.botTriggerHook) {
            this.botTriggerHook(Number(p.chat_id), client.userId, result.message.text);
          }
          break;
        }
        case 'EditMessage': {
          const p = frame.payload;
          editMessageAtomic(this.db, this, {
            chatId: Number(p.chat_id),
            messageId: Number(p.message_id),
            editorUserId: client.userId,
            text: p.text,
            entities: p.entities,
            content: p.content,
          });
          break;
        }
        case 'DeleteMessages': {
          const p = frame.payload;
          ensureChatMembership(this.db, Number(p.chat_id), client.userId);
          deleteMessagesAtomic(
            this.db,
            this,
            Number(p.chat_id),
            client.userId,
            p.message_ids,
            Boolean(p.for_everyone),
          );
          break;
        }
        case 'SendReaction':
        case 'Reaction': {
          const p = frame.payload;
          const chatId = Number(p.chat_id);
          const msgId = Number(p.message_id);
          ensureChatMembership(this.db, chatId, client.userId);
          const existing = this.db
            .prepare(
              `SELECT 1 FROM message_reactions WHERE chat_id = ? AND message_id = ? AND user_id = ? AND emoji = ?`,
            )
            .get(chatId, msgId, client.userId, p.emoji);
          const shouldAdd =
            p.add !== undefined
              ? Boolean(p.add)
              : p.action === 'add'
                ? true
                : p.action === 'remove'
                  ? false
                  : !existing;
          if (shouldAdd) {
            this.db
              .prepare(
                `INSERT OR IGNORE INTO message_reactions (chat_id, message_id, user_id, emoji, created_at_ms)
                 VALUES (?, ?, ?, ?, ?)`,
              )
              .run(chatId, msgId, client.userId, p.emoji, Date.now());
          } else {
            this.db
              .prepare(
                `DELETE FROM message_reactions WHERE chat_id = ? AND message_id = ? AND user_id = ? AND emoji = ?`,
              )
              .run(chatId, msgId, client.userId, p.emoji);
          }
          const { reactions } = getMessageReactions(this.db, chatId, msgId, client.userId);
          commitPtsEventAtomic(this.db, this, chatId, {
            type: 'ReactionUpdated',
            data: {
              chat_id: chatId,
              message_id: msgId,
              user_id: client.userId,
              reactions,
            },
          });
          break;
        }
        case 'ReadHistory': {
          const p = frame.payload;
          const chatId = Number(p.chat_id);
          const maxId = Number(p.max_id);
          ensureChatMembership(this.db, chatId, client.userId);
          this.db
            .prepare(
              `INSERT INTO user_chat_settings (user_id, chat_id, read_inbox_max_id, unread_mark)
               VALUES (?, ?, ?, 0)
               ON CONFLICT(user_id, chat_id) DO UPDATE SET
                 read_inbox_max_id = MAX(read_inbox_max_id, excluded.read_inbox_max_id),
                 unread_mark = 0`,
            )
            .run(client.userId, chatId, maxId);
          commitPtsEventAtomic(this.db, this, chatId, {
            type: 'ReadHistory',
            data: {
              chat_id: chatId,
              max_id: maxId,
              is_outbox: false,
              unread_count: 0,
            },
          });
          break;
        }
        case 'SendTyping':
        case 'Typing': {
          const p = frame.payload;
          const chatId = Number(p.chat_id);
          const action: TypingAction = p.action ?? 'typing';
          this.broadcastChatEphemeral(
            chatId,
            {
              type: 'UserTyping',
              data: {
                chat_id: chatId,
                user_id: client.userId,
                topic_id: p.topic_id,
                action,
                timestamp_ms: Date.now(),
              },
            },
            client.userId,
          );
          break;
        }
        case 'CallSignal': {
          const sig = {
            ...frame.payload,
            from_user_id: client.userId,
          };
          if (sig.target_user_id) {
            this.sendToUser(Number(sig.target_user_id), {
              type: 'Update',
              payload: { type: 'CallSignal', data: sig },
            });
          } else if (sig.chat_id) {
            this.broadcastChatEphemeral(
              Number(sig.chat_id),
              { type: 'CallSignal', data: sig },
              client.userId,
            );
          }
          break;
        }
        case 'VotePoll': {
          const p = frame.payload;
          castPollVoteAtomic(this.db, this, client.userId, {
            pollId: p.poll_id !== undefined ? Number(p.poll_id) : undefined,
            chatId: p.chat_id !== undefined ? Number(p.chat_id) : undefined,
            messageId: p.message_id !== undefined ? Number(p.message_id) : undefined,
            optionIds: p.option_ids ?? [],
          });
          break;
        }
        case 'AckUpdates':
          break;
      }
    } catch (err) {
      const code = err instanceof ApiError ? err.status : 400;
      const msg = err instanceof Error ? err.message : 'WebSocket command failed';
      this.sendFrame(client.ws, {
        type: 'Error',
        payload: { code, message: msg },
      });
    }
  }

  private handleDerpFrame(client: ConnectedClient, frame: Record<string, unknown>): void {
    const type = String(frame.type ?? '');
    if (type === 'keep_alive') {
      this.sendJson(client.ws, {
        type: 'keep_alive_ack',
        client_time_ms: frame.client_time_ms ?? Date.now(),
        server_time_ms: Date.now(),
      });
    } else if (type === 'send_packet' && client.userId !== null) {
      for (const peer of this.clients) {
        if (peer !== client && peer.mode === 'derp' && peer.userId === client.userId) {
          this.sendJson(peer.ws, {
            type: 'recv_packet',
            src_node_key: client.deviceId ?? 'unknown',
            packet_b64: frame.packet_b64,
          });
        }
      }
    }
  }

  async close(): Promise<void> {
    clearInterval(this.pingInterval);
    for (const c of this.clients) {
      try {
        c.ws.terminate();
      } catch {
        // Ignore termination error
      }
    }
    this.clients.clear();
    await new Promise<void>((resolve) => {
      this.wss.close(() => resolve());
    });
  }
}
