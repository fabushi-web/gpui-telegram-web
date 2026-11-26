import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import type { DatabaseSync } from 'node:sqlite';
import { WebSocket, WebSocketServer } from 'ws';
import type {
  CodingHostCommand,
  CodingHostEvent,
  MiniAppControlStatus,
  MiniAppTakeoverState,
  MiniAppWebMcpCommand,
  MiniAppWebMcpResponse,
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
  enrichMessageWebPageAsync,
  ensureChatMembership,
  ensureChatReadAccess,
  ensureChatWriteAccess,
  getChatMemberIds,
  getMessageReactions,
  parseOptionalNonNegativeInt,
  parseOptionalPositiveInt,
  validateWireMessageContent,
  type PtsBroadcastSink,
} from '../db/queries.js';
import type { BrowserControlBridge } from '../routes/browserControl.js';

interface ConnectedClient {
  ws: WebSocket;
  userId: number | null;
  sessionId: string | null;
  tokenHash: string | null;
  subscribedChats: Set<number>;
  isAlive: boolean;
  mode: 'ws' | 'derp' | 'browser_tab' | 'browser_controller';
  deviceId?: string;
  desktopToken?: string;
}

export interface MiniAppWebMcpHubHandlers {
  onResult?: (userId: number, response: MiniAppWebMcpResponse) => void;
  onTakeover?: (userId: number, state: MiniAppTakeoverState) => void;
}

export interface CodingHostHubHandlers {
  onEvent?: (userId: number, sessionId: string | null, event: CodingHostEvent) => void;
  onSessionDisconnected?: (userId: number | null, sessionId: string | null) => void;
}

export class RealtimeGatewayHub implements PtsBroadcastSink {
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<ConnectedClient>();
  private readonly pingInterval: NodeJS.Timeout;
  private botTriggerHook?: (chatId: number, senderId: number, messageText: string) => void;
  private browserBridge?: BrowserControlBridge;
  private miniAppWebMcpHandlers?: MiniAppWebMcpHubHandlers;
  private codingHostHandlers?: CodingHostHubHandlers;
  private shutdownSignal?: AbortSignal;

  constructor(private readonly db: DatabaseSync) {
    this.wss = new WebSocketServer({ noServer: true });

    this.pingInterval = setInterval(() => {
      for (const client of Array.from(this.clients)) {
        if (!client.isAlive) {
          this.browserBridge?.unregisterSocket(client.ws);
          this.codingHostHandlers?.onSessionDisconnected?.(client.userId, client.sessionId);
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

  setMiniAppWebMcpHandlers(handlers: MiniAppWebMcpHubHandlers): void {
    this.miniAppWebMcpHandlers = handlers;
  }

  setCodingHostHandlers(handlers: CodingHostHubHandlers): void {
    this.codingHostHandlers = handlers;
  }

  setShutdownSignal(signal: AbortSignal): void {
    this.shutdownSignal = signal;
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

  hasConnectedUser(userId: number): boolean {
    for (const c of this.clients) {
      if (c.userId === userId && c.mode === 'ws' && c.ws.readyState === WebSocket.OPEN) {
        return true;
      }
    }
    return false;
  }

  attachToServer(server: HttpServer): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      this.handleUpgrade(req, socket, head);
    });
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    let reqUrl: URL;
    try {
      reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const isWs = reqUrl.pathname === '/api/v1/ws';
    const isDerp =
      reqUrl.pathname === '/api/v1/tailnet/derp' || reqUrl.searchParams.get('mode') === 'derp';
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
          tokenHash: null,
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
          this.codingHostHandlers?.onSessionDisconnected?.(client.userId, client.sessionId);
          this.clients.delete(client);
        });
        ws.on('error', () => {
          this.browserBridge?.unregisterSocket(ws);
          this.codingHostHandlers?.onSessionDisconnected?.(client.userId, client.sessionId);
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
          const text = Buffer.isBuffer(rawData)
            ? rawData.toString('utf8')
            : Array.isArray(rawData)
              ? Buffer.concat(rawData).toString('utf8')
              : Buffer.from(rawData).toString('utf8');
          this.handleIncomingMessage(client, text);
        });
      });
      return;
    }

    const token = extractBearerToken(req, reqUrl.searchParams);
    const auth = authenticateToken(this.db, token);

    // /api/v1/ws MUST fail-closed on missing, empty, or invalid token at HTTP upgrade (401)
    // regardless of query parameters (e.g. ?mode=derp). DERP keeps explicit-invalid-token rejection.
    if ((isWs && !auth) || (token && !auth)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const client: ConnectedClient = {
        ws,
        userId: auth?.userId ?? null,
        sessionId: auth?.sessionId ?? null,
        tokenHash: auth?.tokenHash ?? null,
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
        this.codingHostHandlers?.onSessionDisconnected?.(client.userId, client.sessionId);
        this.clients.delete(client);
      });

      ws.on('error', () => {
        this.browserBridge?.unregisterSocket(ws);
        this.codingHostHandlers?.onSessionDisconnected?.(client.userId, client.sessionId);
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
        const text = Buffer.isBuffer(rawData)
          ? rawData.toString('utf8')
          : Array.isArray(rawData)
            ? Buffer.concat(rawData).toString('utf8')
            : Buffer.from(rawData).toString('utf8');
        this.handleIncomingMessage(client, text);
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

  sendToUserSession(userId: number, sessionId: string, frame: WsServerFrame): boolean {
    let sent = false;
    for (const c of this.clients) {
      if (
        c.userId === userId &&
        c.sessionId === sessionId &&
        c.mode === 'ws' &&
        c.ws.readyState === WebSocket.OPEN
      ) {
        this.sendFrame(c.ws, frame);
        sent = true;
      }
    }
    return sent;
  }

  disconnectSession(sessionIdOrTokenHash: string): void {
    for (const c of Array.from(this.clients)) {
      if (c.sessionId === sessionIdOrTokenHash || c.tokenHash === sessionIdOrTokenHash) {
        this.browserBridge?.unregisterSocket(c.ws);
        this.codingHostHandlers?.onSessionDisconnected?.(c.userId, c.sessionId);
        if (c.mode === 'ws' && c.ws.readyState === WebSocket.OPEN) {
          this.sendFrame(c.ws, {
            type: 'Error',
            payload: { code: 401, message: 'Session has been revoked' },
          });
        }
        try {
          c.ws.close(4001, 'Session revoked');
        } catch {
          // Ignore already-closed sockets
        }
        this.clients.delete(c);
      }
    }
  }

  disconnectUser(userId: number, reason = 'Account deleted'): number {
    let disconnected = 0;
    for (const c of Array.from(this.clients)) {
      if (c.userId === userId) {
        this.browserBridge?.unregisterSocket(c.ws);
        this.codingHostHandlers?.onSessionDisconnected?.(c.userId, c.sessionId);
        if (c.mode === 'ws' && c.ws.readyState === WebSocket.OPEN) {
          this.sendFrame(c.ws, {
            type: 'Error',
            payload: { code: 401, message: reason },
          });
        }
        try {
          c.ws.close(4001, reason);
        } catch {
          // Ignore already-closed sockets
        }
        this.clients.delete(c);
        disconnected += 1;
      }
    }
    return disconnected;
  }

  disconnectAllSessions(): void {
    for (const c of Array.from(this.clients)) {
      this.browserBridge?.unregisterSocket(c.ws);
      this.codingHostHandlers?.onSessionDisconnected?.(c.userId, c.sessionId);
      try {
        c.ws.close(1012, 'Server reset');
      } catch {
        // Ignore already-closed sockets
      }
    }
    this.clients.clear();
  }

  unsubscribeUserFromChat(userId: number, chatId: number): void {
    for (const client of this.clients) {
      if (client.userId === userId) {
        client.subscribedChats.delete(chatId);
      }
    }
  }

  private getChatBroadcastPolicy(chatId: number): {
    memberSet: Set<number>;
    bannedSet: Set<number>;
    isPublicChannel: boolean;
  } {
    const memberSet = new Set<number>(getChatMemberIds(this.db, chatId));
    const bannedRows = this.db
      .prepare(`SELECT user_id FROM chat_members WHERE chat_id = ? AND role = 'banned'`)
      .all(chatId) as Array<{ user_id: number }>;
    const bannedSet = new Set<number>(bannedRows.map((r) => Number(r.user_id)));
    const chatRow = this.db
      .prepare(`SELECT chat_type, username FROM chats WHERE chat_id = ?`)
      .get(chatId) as { chat_type: number; username: string | null } | undefined;
    const isPublicChannel =
      Number(chatRow?.chat_type) === 3 &&
      Boolean(chatRow?.username && String(chatRow.username).trim().length > 0);
    return { memberSet, bannedSet, isPublicChannel };
  }

  broadcastChatPtsUpdate(chatId: number, ptsUpdate: PtsUpdate): void {
    const { memberSet, bannedSet, isPublicChannel } = this.getChatBroadcastPolicy(chatId);
    for (const client of this.clients) {
      if (client.mode !== 'ws' || client.userId === null || client.ws.readyState !== WebSocket.OPEN) {
        continue;
      }
      if (!memberSet.has(client.userId)) {
        if (client.subscribedChats.has(chatId)) {
          if (!isPublicChannel || bannedSet.has(client.userId)) {
            client.subscribedChats.delete(chatId);
            continue;
          }
        } else {
          continue;
        }
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
        type: 'PtsPush',
        payload: tailoredUpdate,
      });
    }
  }

  broadcastChatEphemeral(chatId: number, event: UpdateEvent, excludeUserId?: number): void {
    const { memberSet, bannedSet, isPublicChannel } = this.getChatBroadcastPolicy(chatId);
    for (const client of this.clients) {
      if (client.mode !== 'ws' || client.userId === null || client.ws.readyState !== WebSocket.OPEN) {
        continue;
      }
      if (excludeUserId !== undefined && client.userId === excludeUserId) {
        continue;
      }
      if (!memberSet.has(client.userId)) {
        if (client.subscribedChats.has(chatId)) {
          if (!isPublicChannel || bannedSet.has(client.userId)) {
            client.subscribedChats.delete(chatId);
            continue;
          }
        } else {
          continue;
        }
      }
      this.sendFrame(client.ws, {
        type: 'Update',
        payload: event,
      });
    }
  }

  // ============================================================================
  // v1.6.11 Multi-Agent, MiniApp WebMCP & Coding Agent Host Fanout Helpers
  // ============================================================================

  broadcastAgentFloorChanged(
    chatId: number,
    data: Extract<UpdateEvent, { type: 'AgentFloorChanged' }>['data'],
  ): void {
    this.broadcastChatEphemeral(chatId, { type: 'AgentFloorChanged', data });
  }

  broadcastAgentWorkspaceUpdated(
    chatId: number,
    data: Extract<UpdateEvent, { type: 'AgentWorkspaceUpdated' }>['data'],
  ): PtsUpdate {
    return commitPtsEventAtomic(this.db, this, chatId, {
      type: 'AgentWorkspaceUpdated',
      data,
    });
  }

  broadcastAgentHandoff(
    chatId: number,
    data: Extract<UpdateEvent, { type: 'AgentHandoffEvent' }>['data'],
  ): void {
    this.broadcastChatEphemeral(chatId, { type: 'AgentHandoffEvent', data });
  }

  broadcastBotActivity(
    chatId: number,
    data: Extract<UpdateEvent, { type: 'BotActivityChanged' }>['data'],
  ): void {
    this.broadcastChatEphemeral(chatId, { type: 'BotActivityChanged', data });
  }

  sendMiniAppWebMcpCommand(userId: number, command: MiniAppWebMcpCommand): void {
    this.sendToUser(userId, {
      type: 'Update',
      payload: { type: 'MiniAppWebMcpCommand', data: command },
    });
  }

  broadcastMiniAppControlStatus(userId: number, status: MiniAppControlStatus): void {
    this.sendToUser(userId, {
      type: 'Update',
      payload: { type: 'MiniAppControlStatus', data: status },
    });
  }

  sendCodingHostCommand(
    userId: number,
    command: CodingHostCommand,
    targetSessionId?: string | null,
  ): boolean {
    const frame: WsServerFrame = {
      type: 'Update',
      payload: { type: 'CodingHostCommand', data: command },
    };
    if (targetSessionId) {
      return this.sendToUserSession(userId, targetSessionId, frame);
    }
    let delivered = false;
    for (const c of this.clients) {
      if (c.userId === userId && c.mode === 'ws' && c.ws.readyState === WebSocket.OPEN) {
        this.sendFrame(c.ws, frame);
        delivered = true;
      }
    }
    return delivered;
  }

  private handleIncomingMessage(client: ConnectedClient, rawText: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      this.sendFrame(client.ws, {
        type: 'Error',
        payload: { code: 400, message: 'Invalid JSON WebSocket frame' },
      });
      return;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.sendFrame(client.ws, {
        type: 'Error',
        payload: { code: 400, message: 'WebSocket frame must be a JSON object' },
      });
      return;
    }

    const rawFrame = parsed as Record<string, unknown>;
    if (typeof rawFrame.type !== 'string' || !rawFrame.type.trim()) {
      this.sendFrame(client.ws, {
        type: 'Error',
        payload: { code: 400, message: 'WebSocket frame must include string type' },
      });
      return;
    }

    const requirePlainPayload = (raw: unknown, label: string): Record<string, unknown> => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new ApiError(400, 'invalid_payload', `${label} payload must be a JSON object`);
      }
      return raw as Record<string, unknown>;
    };

    try {
      if (client.mode === 'derp') {
        this.handleDerpFrame(client, rawFrame);
        return;
      }

      const frame = parsed as WsClientFrame;

      if (frame.type === 'Ping') {
        const rawPayload = (rawFrame.payload ?? rawFrame.data) as unknown;
        const p =
          rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload)
            ? (rawPayload as { nonce?: number; client_ts?: number })
            : {};
        this.sendFrame(client.ws, {
          type: 'Pong',
          payload: {
            nonce: typeof p.nonce === 'number' ? p.nonce : undefined,
            client_ts: typeof p.client_ts === 'number' ? p.client_ts : undefined,
            server_ts: Date.now(),
          },
        });
        return;
      }

      if (frame.type === 'Auth') {
        const authPayload =
          rawFrame.payload && typeof rawFrame.payload === 'object' && !Array.isArray(rawFrame.payload)
            ? (rawFrame.payload as { token?: unknown })
            : null;
        const authToken = typeof authPayload?.token === 'string' ? authPayload.token : null;

        if (client.mode === 'browser_tab' || client.mode === 'browser_controller') {
          const bAuth = this.browserBridge?.authenticateTokenString(authToken) ?? null;
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

        const auth = authenticateToken(this.db, authToken);
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
        client.tokenHash = auth.tokenHash;
        client.subscribedChats.clear();
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
      if (client.desktopToken && frame.type !== 'BrowserCommand') {
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

      switch (frame.type) {
        case 'BrowserRegister': {
          if (!this.browserBridge) break;
          requirePlainPayload(rawFrame.payload, 'BrowserRegister');
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
          requirePlainPayload(rawFrame.payload, 'BrowserStateReport');
          this.browserBridge.reportTabState(client.userId, frame.payload);
          break;
        }
        case 'BrowserCommandResult': {
          if (!this.browserBridge) break;
          requirePlainPayload(rawFrame.payload, 'BrowserCommandResult');
          this.browserBridge.resolveTabCommandResult(client.userId, frame.payload);
          break;
        }
        case 'BrowserCommand': {
          if (!this.browserBridge) break;
          requirePlainPayload(rawFrame.payload, 'BrowserCommand');
          if (
            client.desktopToken &&
            !this.browserBridge.authenticateTokenString(client.desktopToken)
          ) {
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
              (typeof frame.payload.caller_label === 'string' && frame.payload.caller_label) ||
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
          const p = requirePlainPayload(rawFrame.payload, 'SubscribeChat');
          const cid = parseOptionalPositiveInt(
            p.chat_id,
            'invalid_chat_id',
            'chat_id must be a positive integer',
          );
          if (cid === undefined) {
            throw new ApiError(400, 'invalid_chat_id', 'chat_id is required');
          }
          ensureChatReadAccess(this.db, cid, client.userId);
          client.subscribedChats.add(cid);
          break;
        }
        case 'SubscribeChats': {
          const p = requirePlainPayload(rawFrame.payload, 'SubscribeChats');
          if (p.chat_ids !== undefined && !Array.isArray(p.chat_ids)) {
            throw new ApiError(400, 'invalid_chat_ids', 'chat_ids must be an array');
          }
          for (const rawCid of (p.chat_ids as unknown[] | undefined) ?? []) {
            const cid = parseOptionalPositiveInt(
              rawCid,
              'invalid_chat_id',
              'Each chat_id must be a positive integer',
            );
            if (cid === undefined) {
              throw new ApiError(400, 'invalid_chat_id', 'Each chat_id must be a positive integer');
            }
            ensureChatReadAccess(this.db, cid, client.userId);
            client.subscribedChats.add(cid);
          }
          break;
        }
        case 'UnsubscribeChat': {
          const p = requirePlainPayload(rawFrame.payload, 'UnsubscribeChat');
          const cid = parseOptionalPositiveInt(
            p.chat_id,
            'invalid_chat_id',
            'chat_id must be a positive integer',
          );
          if (cid !== undefined) {
            client.subscribedChats.delete(cid);
          }
          break;
        }
        case 'Sync':
        case 'GetDifference': {
          requirePlainPayload(rawFrame.payload, frame.type);
          const diff = computeChatDifference(this.db, client.userId, frame.payload);
          this.sendFrame(client.ws, {
            type: frame.type === 'Sync' ? 'SyncDiff' : 'Difference',
            payload: diff,
          });
          break;
        }
        case 'SendMessage': {
          requirePlainPayload(rawFrame.payload, 'SendMessage');
          const p = frame.payload;
          const chatId = parseOptionalPositiveInt(
            p.chat_id,
            'invalid_chat_id',
            'chat_id must be a positive integer',
          );
          if (chatId === undefined) {
            throw new ApiError(400, 'invalid_chat_id', 'chat_id is required');
          }
          const access = ensureChatWriteAccess(this.db, chatId, client.userId);
          const topicId = parseOptionalPositiveInt(
            p.topic_id,
            'invalid_topic_id',
            'topic_id must be a positive integer',
          );
          if (topicId !== undefined) {
            const topicRow = this.db
              .prepare(`SELECT is_closed FROM forum_topics WHERE chat_id = ? AND topic_id = ?`)
              .get(chatId, topicId) as { is_closed: number } | undefined;
            if (topicRow?.is_closed && !access.isAdmin) {
              throw new ApiError(403, 'topic_closed', 'This forum topic is closed');
            }
          }
          const clientNonce = parseOptionalPositiveInt(
            p.client_nonce,
            'invalid_nonce',
            'client_nonce must be a positive integer',
          );
          const replyToMsgId = parseOptionalPositiveInt(
            p.reply_to,
            'invalid_reply_to',
            'reply_to must be a positive integer',
          );
          const scheduleAtMs = parseOptionalNonNegativeInt(
            p.scheduled_at_ms,
            'invalid_schedule_time',
            'scheduled_at_ms must be a non-negative integer',
          );
          if (p.text !== undefined && p.text !== null && typeof p.text !== 'string') {
            throw new ApiError(400, 'invalid_text', 'Message text must be a string');
          }
          if (p.quote_text !== undefined && p.quote_text !== null && typeof p.quote_text !== 'string') {
            throw new ApiError(400, 'invalid_quote_text', 'quote_text must be a string');
          }
          if (p.entities !== undefined && p.entities !== null && !Array.isArray(p.entities)) {
            throw new ApiError(400, 'invalid_entities', 'entities must be an array');
          }
          const validatedContent =
            p.content !== undefined && p.content !== null
              ? validateWireMessageContent(p.content)
              : undefined;

          const result = createMessageAtomic(this.db, this, {
            chatId,
            senderId: client.userId,
            text: p.text ?? undefined,
            entities: p.entities ?? undefined,
            content: validatedContent,
            replyToMsgId,
            quoteText: p.quote_text ?? undefined,
            topicId,
            clientNonce,
            silent: p.silent,
            scheduleAtMs,
            inlineKeyboard: p.inline_keyboard,
          });
          const ackPayload = {
            correlation_id: clientNonce,
            client_nonce: clientNonce ?? 0,
            chat_id: chatId,
            message_id: result.message.id,
            pts: result.pts,
            duplicate: result.duplicate,
            date_ms: result.message.date_ms ?? Date.now(),
          };
          this.sendFrame(client.ws, { type: 'Ack', payload: ackPayload });
          if (
            !result.duplicate &&
            result.message.content.type === 'Text' &&
            result.message.text
          ) {
            enrichMessageWebPageAsync(
              this.db,
              this,
              chatId,
              result.message.id,
              result.message.text,
              this.shutdownSignal,
            );
          }
          if (
            !result.duplicate &&
            !p.skip_server_bot_reply &&
            result.message.text &&
            this.botTriggerHook
          ) {
            this.botTriggerHook(chatId, client.userId, result.message.text);
          }
          break;
        }
        case 'EditMessage': {
          requirePlainPayload(rawFrame.payload, 'EditMessage');
          const p = frame.payload;
          const chatId = parseOptionalPositiveInt(
            p.chat_id,
            'invalid_chat_id',
            'chat_id must be a positive integer',
          );
          const messageId = parseOptionalPositiveInt(
            p.message_id,
            'invalid_message_id',
            'message_id must be a positive integer',
          );
          if (chatId === undefined || messageId === undefined) {
            throw new ApiError(400, 'invalid_payload', 'chat_id and message_id are required');
          }
          if (p.text !== undefined && p.text !== null && typeof p.text !== 'string') {
            throw new ApiError(400, 'invalid_text', 'Edited text must be a string');
          }
          if (p.entities !== undefined && p.entities !== null && !Array.isArray(p.entities)) {
            throw new ApiError(400, 'invalid_entities', 'entities must be an array');
          }
          const validatedContent =
            p.content !== undefined && p.content !== null
              ? validateWireMessageContent(p.content)
              : undefined;
          editMessageAtomic(this.db, this, {
            chatId,
            messageId,
            editorUserId: client.userId,
            text: p.text ?? undefined,
            entities: p.entities ?? undefined,
            content: validatedContent,
          });
          break;
        }
        case 'DeleteMessages': {
          requirePlainPayload(rawFrame.payload, 'DeleteMessages');
          const p = frame.payload;
          const chatId = parseOptionalPositiveInt(
            p.chat_id,
            'invalid_chat_id',
            'chat_id must be a positive integer',
          );
          if (chatId === undefined) {
            throw new ApiError(400, 'invalid_chat_id', 'chat_id is required');
          }
          if (!Array.isArray(p.message_ids)) {
            throw new ApiError(400, 'invalid_message_ids', 'message_ids must be an array');
          }
          ensureChatMembership(this.db, chatId, client.userId);
          deleteMessagesAtomic(
            this.db,
            this,
            chatId,
            client.userId,
            p.message_ids,
            Boolean(p.for_everyone),
          );
          break;
        }
        case 'SendReaction':
        case 'Reaction': {
          requirePlainPayload(rawFrame.payload, frame.type);
          const p = frame.payload;
          const chatId = parseOptionalPositiveInt(
            p.chat_id,
            'invalid_chat_id',
            'chat_id must be a positive integer',
          );
          const msgId = parseOptionalPositiveInt(
            p.message_id,
            'invalid_message_id',
            'message_id must be a positive integer',
          );
          if (chatId === undefined || msgId === undefined) {
            throw new ApiError(400, 'invalid_payload', 'chat_id and message_id are required');
          }
          if (typeof p.emoji !== 'string' || !p.emoji.trim()) {
            throw new ApiError(400, 'invalid_emoji', 'Reaction emoji must be a non-empty string');
          }
          const emoji = p.emoji.trim();
          ensureChatReadAccess(this.db, chatId, client.userId);
          const existing = this.db
            .prepare(
              `SELECT 1 FROM message_reactions WHERE chat_id = ? AND message_id = ? AND user_id = ? AND emoji = ?`,
            )
            .get(chatId, msgId, client.userId, emoji);
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
              .run(chatId, msgId, client.userId, emoji, Date.now());
          } else {
            this.db
              .prepare(
                `DELETE FROM message_reactions WHERE chat_id = ? AND message_id = ? AND user_id = ? AND emoji = ?`,
              )
              .run(chatId, msgId, client.userId, emoji);
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
          requirePlainPayload(rawFrame.payload, 'ReadHistory');
          const p = frame.payload;
          const chatId = parseOptionalPositiveInt(
            p.chat_id,
            'invalid_chat_id',
            'chat_id must be a positive integer',
          );
          const maxId = parseOptionalNonNegativeInt(
            p.max_id,
            'invalid_max_id',
            'max_id must be a non-negative integer',
          );
          if (chatId === undefined || maxId === undefined) {
            throw new ApiError(400, 'invalid_payload', 'chat_id and max_id are required');
          }
          const access = ensureChatReadAccess(this.db, chatId, client.userId);
          if (!access.isMember) {
            break;
          }
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
          requirePlainPayload(rawFrame.payload, frame.type);
          const p = frame.payload;
          const chatId = parseOptionalPositiveInt(
            p.chat_id,
            'invalid_chat_id',
            'chat_id must be a positive integer',
          );
          if (chatId === undefined) {
            throw new ApiError(400, 'invalid_chat_id', 'chat_id is required');
          }
          ensureChatWriteAccess(this.db, chatId, client.userId);
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
          const rawSig = requirePlainPayload(rawFrame.payload, 'CallSignal');
          if (rawSig.call_id !== undefined && rawSig.call_id !== null && typeof rawSig.call_id !== 'string') {
            throw new ApiError(400, 'invalid_call_id', 'call_id must be a string');
          }
          const sigChatId = parseOptionalPositiveInt(
            rawSig.chat_id,
            'invalid_chat_id',
            'chat_id must be a positive integer',
          );
          const sigTargetUserId = parseOptionalPositiveInt(
            rawSig.target_user_id,
            'invalid_target_user_id',
            'target_user_id must be a positive integer',
          );
          const sig = {
            ...frame.payload,
            from_user_id: client.userId,
          };
          if (typeof rawSig.call_id === 'string' && rawSig.call_id.trim()) {
            const callRow = this.db
              .prepare(`SELECT caller_id, callee_id FROM call_sessions WHERE call_id = ?`)
              .get(rawSig.call_id.trim()) as { caller_id: number; callee_id: number } | undefined;
            if (!callRow) {
              throw new ApiError(404, 'call_not_found', 'Call session not found');
            }
            if (
              Number(callRow.caller_id) !== client.userId &&
              Number(callRow.callee_id) !== client.userId
            ) {
              throw new ApiError(403, 'forbidden', 'You are not a participant of this call');
            }
          }
          if (sigChatId !== undefined) {
            ensureChatWriteAccess(this.db, sigChatId, client.userId);
          }
          if (sigTargetUserId !== undefined) {
            this.sendToUser(sigTargetUserId, {
              type: 'Update',
              payload: { type: 'CallSignal', data: sig },
            });
          } else if (sigChatId !== undefined) {
            this.broadcastChatEphemeral(
              sigChatId,
              { type: 'CallSignal', data: sig },
              client.userId,
            );
          }
          break;
        }
        case 'VotePoll': {
          requirePlainPayload(rawFrame.payload, 'VotePoll');
          const p = frame.payload;
          if (p.option_ids !== undefined && !Array.isArray(p.option_ids)) {
            throw new ApiError(400, 'invalid_option_ids', 'option_ids must be an array');
          }
          castPollVoteAtomic(this.db, this, client.userId, {
            pollId: parseOptionalPositiveInt(p.poll_id, 'invalid_poll_id', 'poll_id must be a positive integer'),
            chatId: parseOptionalPositiveInt(p.chat_id, 'invalid_chat_id', 'chat_id must be a positive integer'),
            messageId: parseOptionalPositiveInt(p.message_id, 'invalid_message_id', 'message_id must be a positive integer'),
            optionIds: p.option_ids ?? [],
          });
          break;
        }
        case 'AckUpdates': {
          requirePlainPayload(rawFrame.payload, 'AckUpdates');
          const p = frame.payload;
          const chatId = parseOptionalNonNegativeInt(
            p.chat_id,
            'invalid_chat_id',
            'chat_id must be a non-negative integer',
          );
          const pts = parseOptionalNonNegativeInt(
            p.pts,
            'invalid_pts',
            'pts must be a non-negative integer',
          );
          this.sendFrame(client.ws, {
            type: 'Ack',
            payload: {
              correlation_id: 0,
              client_nonce: 0,
              chat_id: chatId ?? 0,
              message_id: 0,
              pts: pts ?? 0,
            },
          });
          break;
        }
        case 'MiniAppWebMcpResult': {
          requirePlainPayload(rawFrame.payload, 'MiniAppWebMcpResult');
          const p = frame.payload;
          if (!p || typeof p.request_id !== 'string' || !p.request_id.trim()) {
            throw new ApiError(400, 'invalid_webmcp_result', 'request_id is required');
          }
          this.miniAppWebMcpHandlers?.onResult?.(client.userId, p);
          break;
        }
        case 'MiniAppTakeoverState': {
          requirePlainPayload(rawFrame.payload, 'MiniAppTakeoverState');
          const p = frame.payload;
          if (!p || typeof p.bot_username !== 'string' || !p.mode) {
            throw new ApiError(
              400,
              'invalid_takeover_state',
              'bot_username and mode are required',
            );
          }
          if (this.miniAppWebMcpHandlers?.onTakeover) {
            this.miniAppWebMcpHandlers.onTakeover(client.userId, p);
          } else {
            const statusText =
              (typeof p.user_note === 'string' && p.user_note.trim()) ||
              (p.mode === 'user_takeover'
                ? '用户已接管 Mini App 操作'
                : p.mode === 'waiting_for_takeover'
                  ? '等待用户接管 Mini App'
                  : p.mode === 'ai_controlling'
                    ? 'AI 正在操控 Mini App'
                    : 'Mini App 已恢复空闲');
            this.broadcastMiniAppControlStatus(client.userId, {
              bot_username: p.bot_username,
              short_name: p.short_name ?? '',
              chat_id: Number(p.chat_id ?? 0),
              bot_user_id: Number(p.bot_user_id ?? 0),
              app_title: p.short_name || p.bot_username,
              mode: p.mode,
              status_text: statusText,
              active_tool: null,
            });
          }
          break;
        }
        case 'CodingHostEvent': {
          requirePlainPayload(rawFrame.payload, 'CodingHostEvent');
          const p = frame.payload;
          if (!p || typeof p.event !== 'string' || !p.event.trim()) {
            throw new ApiError(400, 'invalid_coding_host_event', 'event discriminator is required');
          }
          this.codingHostHandlers?.onEvent?.(client.userId, client.sessionId, p);
          break;
        }
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
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
      return;
    }
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
    for (const c of Array.from(this.clients)) {
      this.browserBridge?.unregisterSocket(c.ws);
      this.codingHostHandlers?.onSessionDisconnected?.(c.userId, c.sessionId);
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
