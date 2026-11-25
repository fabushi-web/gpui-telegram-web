import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import type { BotRegistryEntry, ServerStatusResponse } from '@gpui-telegram/protocol';
import { resolveServerConfig, type ServerConfig, type ServerConfigOverrides } from './config.js';
import { createMessageAtomic } from './db/queries.js';
import { openSqliteWalDatabase } from './db/schema.js';
import { resetDatabaseClean, seedDatabaseIfEmpty } from './db/seed.js';
import { registerAuthAndUserRoutes } from './routes/auth.js';
import { registerAutomationAppRoutes } from './routes/automationApps.js';
import {
  handleBotConversationTurn,
  MiniAppWebMcpBroker,
  registerBotsMiniAppsAndFabushiRoutes,
} from './routes/botsMiniApps.js';
import { registerChatAndSocialRoutes } from './routes/chats.js';
import {
  CodingAgentBroker,
  handleCodingCallback,
  registerCodingAgentRoutes,
} from './routes/codingAgents.js';
import { registerFabushiMiniAppRoutes } from './routes/fabushiMiniApp.js';
import {
  executeSlashCommandInternal,
  getHermesMemoryState,
  registerHermesStudioRoutes,
} from './routes/hermes.js';
import { registerMagpieGatewayRoutes, runConfiguredLlmCompletion } from './routes/magpie.js';
import { registerMediaStoriesE2eeAndCallRoutes } from './routes/media.js';
import { registerMessageAndSearchRoutes } from './routes/messages.js';
import { MultiAgentOrchestrator, registerMultiAgentRoutes } from './routes/multiAgent.js';
import { createOfficialMcpRuntime, registerOfficialMcpRoutes } from './routes/officialMcp.js';
import {
  createRemoteAssistRuntime,
  registerRemoteAssistAndComputerRoutes,
} from './routes/remoteAssist.js';
import {
  BrowserControlBridge,
  registerBrowserControlRoutes,
} from './routes/browserControl.js';
import {
  extractRawRequestPath,
  hasRawUpdateAssetTraversal,
  RAW_DOT_SEGMENT_OR_TRAVERSAL_RE,
  RAW_ENCODED_SLASH_RE,
  registerUpdatesRoutes,
  type UpdatesRouteOptions,
} from './routes/updates.js';
import { registerUserVaultRoutes } from './routes/userVault.js';
import { registerWorkspaceTailnetAndWalletRoutes } from './routes/workspace.js';
import {
  proxyHttpRequest,
  proxyWebSocketUpgrade,
  shouldProxyPathname,
  shouldProxyWebSocketPathname,
} from './proxy.js';
import { serveStaticSpa } from './staticHost.js';
import {
  ApiError,
  HttpRouter,
  markResponseAcceptsGzip,
  readRawBody,
  requireAuth,
  sendError,
  sendJson,
  sendText,
  setCorsHeaders,
  type RequestContext,
  type RouteHandler,
} from './utils/http.js';
import { RealtimeGatewayHub } from './ws/hub.js';

export interface TelegramServerInstance {
  readonly config: ServerConfig;
  readonly db: DatabaseSync;
  readonly hub: RealtimeGatewayHub;
  readonly browserBridge: BrowserControlBridge;
  readonly httpServer: http.Server;
  start(): Promise<{ port: number; host: string; baseUrl: string; wsUrl: string }>;
  close(): Promise<void>;
}

export interface CreateServerOptions {
  updates?: UpdatesRouteOptions;
}

const SERVER_STATUS_CAPABILITIES: readonly string[] = [
  'auth',
  'phone_otp',
  'email_otp',
  '2fa',
  'qr_pair',
  'passkey',
  'chats',
  'topics',
  'folders',
  'drafts',
  'invites',
  'pins',
  'messaging_pts',
  'reactions',
  'polls',
  'media_cas_206',
  'stickers',
  'gifs',
  'stories',
  'calls_webrtc',
  'tantivy_search',
  'statistics',
  'export',
  'wallet_stars',
  'acp_durable',
  'hermes_agent',
  'hermes_gateway',
  'openai_compat',
  'acp_json_rpc',
  'auto_update_relay',
  'official_mcp_oauth21',
  'remote_control',
  'remote_assist',
];

const RFC9110_HOST_HEADER_RE = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/;

export function createTelegramServer(
  overrides: ServerConfigOverrides = {},
  options: CreateServerOptions = {},
): TelegramServerInstance {
  const config = resolveServerConfig(overrides);
  const db = openSqliteWalDatabase(config.dataDir);
  seedDatabaseIfEmpty(db);

  const shutdownAbort = new AbortController();
  const hub = new RealtimeGatewayHub(db);
  hub.setShutdownSignal(shutdownAbort.signal);
  const browserBridge = new BrowserControlBridge(db, config.dataDir);
  hub.setBrowserControlBridge(browserBridge);

  const multiAgentOrchestrator = new MultiAgentOrchestrator(db, config, hub);
  const codingAgentBroker = new CodingAgentBroker(db, hub);
  const webMcpBroker = new MiniAppWebMcpBroker(hub);
  const remoteAssistRuntime = createRemoteAssistRuntime(db, hub);
  const officialMcpRuntime = createOfficialMcpRuntime(db, config, remoteAssistRuntime);
  remoteAssistRuntime.setMcpKillHooks(officialMcpRuntime.getKillHooks());

  hub.setCodingHostHandlers({
    onEvent: (userId, sessionId, event) => codingAgentBroker.handleHostEvent(userId, sessionId, event),
    onSessionDisconnected: (userId, sessionId) =>
      codingAgentBroker.markSessionDisconnected(userId, sessionId),
  });

  const router = new HttpRouter();
  const startedAtMs = Date.now();

  const deferredBotSink = Object.create(hub, {
    broadcastChatPtsUpdate: {
      value: (
        cId: number,
        ptsUpdate: Parameters<RealtimeGatewayHub['broadcastChatPtsUpdate']>[1],
      ) => {
        setTimeout(() => {
          try {
            hub.broadcastChatPtsUpdate(cId, ptsUpdate);
          } catch {
            // Ignore if hub closed during server teardown
          }
        }, 80).unref();
      },
    },
  }) as RealtimeGatewayHub;

  // Bot, Coding Agent, Multi-Agent Group & @HermesAgent conversational message hook
  const runBotReplyNow = (chatId: number, senderId: number, text: string): void => {
    try {
      const chatMeta = db
        .prepare(`SELECT chat_type, peer_user_id FROM chats WHERE chat_id = ?`)
        .get(chatId) as { chat_type: number; peer_user_id: number | null } | undefined;
      if (!chatMeta) return;

      // 1. Check Coding Agent Bots (1:1 DM or @mentioned in group chat)
      const memberBots = db
        .prepare(
          `SELECT br.bot_user_id, br.bot_json
           FROM chat_members cm
           INNER JOIN bots_registry br ON br.bot_user_id = cm.user_id
           WHERE cm.chat_id = ?`,
        )
        .all(chatId) as Array<{ bot_user_id: number; bot_json: string }>;

      const codingBots = memberBots
        .map((r) => JSON.parse(r.bot_json) as BotRegistryEntry)
        .filter((b) => Boolean(b.coding_agent));

      if (codingBots.length > 0) {
        if (Number(chatMeta.chat_type) === 0) {
          if (
            codingAgentBroker.handleIncomingMessage({
              bot: codingBots[0]!,
              chatId,
              senderId,
              text,
            })
          ) {
            return;
          }
        } else {
          const mentionTokens = Array.from(text.matchAll(/@([A-Za-z0-9_.-]+)/g)).map((m) =>
            m[1]!.toLowerCase(),
          );
          const targeted = codingBots.find((b) =>
            mentionTokens.includes(b.username.toLowerCase()),
          );
          if (targeted) {
            codingAgentBroker.handleIncomingMessage({
              bot: targeted,
              chatId,
              senderId,
              text,
            });
            return;
          }
        }
      }

      // 2. Check @BotFather / @FabushiBot / custom Bot API update queue (1:1 DM)
      if (handleBotConversationTurn(db, deferredBotSink, chatId, senderId, text)) {
        return;
      }

      // 3. Group Chat Multi-Agent Orchestration (FloorControl, 5-Hop Budget, Reply Gate, Shared Workspace)
      if (Number(chatMeta.chat_type) !== 0) {
        if (multiAgentOrchestrator.handleGroupMessage(chatId, senderId, text)) {
          return;
        }
        return;
      }

      // 4. Direct 1:1 DM with @HermesAgent (777000) or user-created Fabushi AI bot
      const peerBotId = chatMeta.peer_user_id ? Number(chatMeta.peer_user_id) : 0;
      const peerBotRow = peerBotId
        ? (db
            .prepare(`SELECT bot_json FROM bots_registry WHERE bot_user_id = ?`)
            .get(peerBotId) as { bot_json: string } | undefined)
        : undefined;
      const peerBot = peerBotRow ? (JSON.parse(peerBotRow.bot_json) as BotRegistryEntry) : null;
      const isDirectFabushiAiBot =
        peerBotId === 777000 || Boolean(peerBot?.is_fabushi_bot && !peerBot.coding_agent);

      if (isDirectFabushiAiBot) {
        const trimmed = text.trim();
        if (/^\/start(?:\s|@|$)/i.test(trimmed)) {
          const displayName =
            peerBot?.display_name || (peerBotId === 777000 ? 'Hermes Agent' : 'Fabushi AI');
          const handleSuffix = peerBot?.username ? ` (@${peerBot.username})` : '';
          const descText = (peerBot?.description || peerBot?.about || '').trim();
          const availableCmds =
            Array.isArray(peerBot?.commands) && peerBot.commands.length > 0
              ? peerBot.commands
              : [
                  { command: 'help', description: 'Show available slash commands' },
                  { command: 'status', description: 'Show runtime and model status' },
                  { command: 'new', description: 'Start a fresh session' },
                ];
          const cmdLines = availableCmds
            .slice(0, 8)
            .map((c) => `• \`/${String(c.command).replace(/^\//, '')}\` — ${c.description}`)
            .join('\n');
          const welcomeText = [
            `👋 **${displayName}**${handleSuffix}`,
            descText,
            cmdLines ? `**Available commands:**\n${cmdLines}` : '',
          ]
            .filter(Boolean)
            .join('\n\n');

          try {
            db.prepare(`
              INSERT INTO user_bot_permissions (
                user_id, bot_user_id, allows_write_to_pm, has_started_chat, app_tos_accepted_at, updated_at_ms
              ) VALUES (?, ?, 1, 1, 0, ?)
              ON CONFLICT(user_id, bot_user_id) DO UPDATE SET
                allows_write_to_pm = 1,
                has_started_chat = 1,
                updated_at_ms = excluded.updated_at_ms
            `).run(senderId, peerBotId, Date.now());
          } catch {
            // Non-fatal during teardown
          }

          createMessageAtomic(db, deferredBotSink, {
            chatId,
            senderId: peerBotId,
            text: welcomeText,
          });
        } else if (trimmed.startsWith('/')) {
          const slashRes = executeSlashCommandInternal(
            db,
            senderId,
            trimmed,
            undefined,
            chatId,
            config,
          );
          createMessageAtomic(db, deferredBotSink, {
            chatId,
            senderId: peerBotId,
            text: slashRes.response_text,
          });
        } else {
          void (async () => {
            try {
              if (shutdownAbort.signal.aborted) return;
              const mem = getHermesMemoryState(db, senderId);
              const llmRes = await runConfiguredLlmCompletion(
                db,
                config,
                senderId,
                [
                  { role: 'system', content: peerBot?.ai_persona || mem.soul },
                  { role: 'user', content: trimmed },
                ],
                { model: peerBot?.preferred_model || undefined },
              );
              if (shutdownAbort.signal.aborted) return;
              const replyText =
                llmRes.usedUpstream && llmRes.text
                  ? llmRes.text
                  : llmRes.error
                    ? `⚠️ **Fabushi AI** 调用模型失败（${llmRes.providerId}）：${llmRes.error}。请检查 **Magpie LLM 网关** 配置。`
                    : `尚未配置可用的 AI 模型提供商。请前往 **Magpie LLM 网关** 添加并启用 API Key 后，即可进行真实对话。`;
              createMessageAtomic(db, hub, {
                chatId,
                senderId: peerBotId,
                text: replyText,
              });
            } catch {
              // Ignore if DB closed during server teardown
            }
          })();
        }
      }
    } catch {
      // Ignore if DB closed during server teardown
    }
  };

  const dispatchBotReplyIfApplicable = (chatId: number, senderId: number, text: string): void => {
    // Ignore messages authored by bots themselves to prevent infinite loops
    try {
      const senderRow = db
        .prepare(`SELECT is_bot FROM users WHERE user_id = ?`)
        .get(senderId) as { is_bot: number } | undefined;
      if (senderRow?.is_bot) return;
    } catch {
      return;
    }
    runBotReplyNow(chatId, senderId, text);
  };

  hub.setBotTriggerHook(dispatchBotReplyIfApplicable);

  // Health, Readiness, Status (`v1.6.11`), Version & Clean Test Reset
  router.get('/health', (ctx: RequestContext) => {
    sendText(ctx.res, 200, 'OK');
  });

  const handleApiHealth = (ctx: RequestContext): void => {
    const dbOk = Boolean(db.prepare(`SELECT 1 AS ok`).get());
    sendJson(ctx.res, 200, {
      ok: dbOk,
      status: dbOk ? 'ok' : 'error',
      app: 'Fabushi Web',
      server: 'fabushi-web',
      service: 'fabushi-web-server',
      version: config.appVersion,
      mode: config.upstreamServerUrl ? 'proxy' : 'production',
      db: dbOk ? 'wal_ready' : 'error',
      uptime_secs: Math.floor((Date.now() - startedAtMs) / 1000),
      online_users: hub.getOnlineUsersCount(),
    });
  };
  router.get('/api/v1/health', handleApiHealth);
  router.get('/api/v1/ready', handleApiHealth);
  router.get('/healthz', handleApiHealth);

  router.get('/api/v1/status', (ctx: RequestContext) => {
    const statusPayload: ServerStatusResponse & { ok: boolean } = {
      ok: true,
      server: 'fabushi-web',
      status: 'ok',
      version: config.appVersion,
      capabilities: [...SERVER_STATUS_CAPABILITIES],
    };
    sendJson(ctx.res, 200, statusPayload);
  });

  router.get('/api/v1/version', (ctx) => {
    sendJson(ctx.res, 200, {
      name: '@gpui-telegram/server',
      server: 'fabushi-web',
      version: config.appVersion,
      node: process.version,
    });
  });

  router.post('/api/v1/test/reset', (ctx) => {
    if (!config.enableTestReset) {
      throw new ApiError(
        403,
        'test_reset_disabled',
        'Clean database reset requires ENABLE_TEST_RESET=1',
      );
    }
    const t0 = performance.now();
    multiAgentOrchestrator.reset();
    codingAgentBroker.reset();
    webMcpBroker.reset();
    officialMcpRuntime.reset();
    remoteAssistRuntime.reset();
    browserBridge.resetFastSync();
    hub.disconnectAllSessions();
    resetDatabaseClean(db, config.mediaDir, config.uploadsDir);
    const elapsedMs = Number((performance.now() - t0).toFixed(2));
    sendJson(ctx.res, 200, {
      ok: true,
      reset: true,
      elapsed_ms: elapsedMs,
    });
  });

  // Register all domain route suites (strict ordering: static/canonical before wildcard/legacy)
  registerAuthAndUserRoutes(router, db, hub, config);
  registerUserVaultRoutes(router, db, config);
  registerChatAndSocialRoutes(router, db, hub);
  const wrapChatCallbackHandler = (originalHandler: RouteHandler): RouteHandler => {
    return async (ctx) => {
      // Authenticate before buffering up to 8 MiB (both coding & message callbacks require auth)
      requireAuth(db, ctx);
      const rawBuf = await readRawBody(ctx.req, 8 * 1024 * 1024);

      let parsedBody: Record<string, unknown> | null = null;
      if (rawBuf.length > 0) {
        try {
          const parsed: unknown = JSON.parse(rawBuf.toString('utf8'));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            parsedBody = parsed as Record<string, unknown>;
          }
        } catch {
          // Delegate malformed JSON to originalHandler so membership/400 precedence is preserved
        }
      }

      const rawCbData = parsedBody
        ? (parsedBody.callback_data ?? parsedBody.data)
        : undefined;
      if (typeof rawCbData === 'string' && rawCbData.trim().startsWith('coding:')) {
        await handleCodingCallback(db, hub, codingAgentBroker, ctx, parsedBody!);
        return;
      }

      const replayReq = Object.create(ctx.req, {
        [Symbol.asyncIterator]: {
          value: async function* () {
            if (rawBuf.length > 0) {
              yield rawBuf;
            }
          },
          configurable: true,
        },
      }) as http.IncomingMessage;
      await originalHandler({ ...ctx, req: replayReq });
    };
  };

  const messageRoutesRouter = new Proxy(router, {
    get(target, prop) {
      if (prop === 'post') {
        return (pattern: string, handler: RouteHandler) => {
          target.post(
            pattern,
            pattern === '/api/v1/chats/:chatId/callback'
              ? wrapChatCallbackHandler(handler)
              : handler,
          );
        };
      }
      if (prop === 'register') {
        return (method: string, pattern: string, handler: RouteHandler) => {
          target.register(
            method,
            pattern,
            method.toUpperCase() === 'POST' && pattern === '/api/v1/chats/:chatId/callback'
              ? wrapChatCallbackHandler(handler)
              : handler,
          );
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  registerMessageAndSearchRoutes(
    messageRoutesRouter,
    db,
    hub,
    dispatchBotReplyIfApplicable,
    config,
    shutdownAbort.signal,
  );
  registerMediaStoriesE2eeAndCallRoutes(router, db, config, hub);
  registerUpdatesRoutes(router, config, options.updates);
  registerBotsMiniAppsAndFabushiRoutes(
    router,
    db,
    hub,
    config,
    webMcpBroker,
    (ctx, body) => handleCodingCallback(db, hub, codingAgentBroker, ctx, body),
  );
  registerFabushiMiniAppRoutes(router, db, config, hub);
  registerHermesStudioRoutes(router, db, config, hub);
  registerMagpieGatewayRoutes(router, db, config);
  registerMultiAgentRoutes(router, db, multiAgentOrchestrator);
  registerCodingAgentRoutes(router, db, codingAgentBroker);
  registerRemoteAssistAndComputerRoutes(router, db, config, hub, remoteAssistRuntime);
  registerOfficialMcpRoutes(router, db, config, hub, officialMcpRuntime, remoteAssistRuntime);
  registerWorkspaceTailnetAndWalletRoutes(router, db, config, hub, browserBridge);
  registerBrowserControlRoutes(router, db, browserBridge);
  registerAutomationAppRoutes(router, db);

  const httpServer = http.createServer(async (req, res) => {
    setCorsHeaders(res);
    markResponseAcceptsGzip(req, res);
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    try {
      // Raw URL traversal & dot-segment pre-check BEFORE `new URL(...)` collapses dot-segments!
      const normalizedRawPath = extractRawRequestPath(req.url);
      if (hasRawUpdateAssetTraversal(req.url)) {
        sendError(res, 400, 'invalid_update_asset', 'Path traversal is not allowed in update asset path');
        return;
      }
      if (
        normalizedRawPath.startsWith('/api/v1/user-vault/') &&
        (RAW_DOT_SEGMENT_OR_TRAVERSAL_RE.test(normalizedRawPath) ||
          RAW_ENCODED_SLASH_RE.test(normalizedRawPath))
      ) {
        sendError(res, 400, 'invalid_item_key', 'Path traversal is not allowed in vault item key');
        return;
      }
      if (
        (normalizedRawPath.startsWith('/api/') || normalizedRawPath.startsWith('/v1/')) &&
        RAW_DOT_SEGMENT_OR_TRAVERSAL_RE.test(normalizedRawPath)
      ) {
        sendError(
          res,
          400,
          'invalid_path',
          'Path traversal or dot-segments are not allowed in API paths',
        );
        return;
      }

      if (
        req.headers.host !== undefined &&
        (typeof req.headers.host !== 'string' || !RFC9110_HOST_HEADER_RE.test(req.headers.host))
      ) {
        sendError(res, 400, 'invalid_request_url', 'Malformed request URL or Host header');
        return;
      }

      let reqUrl: URL;
      try {
        reqUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      } catch {
        sendError(res, 400, 'invalid_request_url', 'Malformed request URL or Host header');
        return;
      }

      // Post-parse defense-in-depth for leading dot-segments/traversals (e.g., `/./api/...`, `/x/../api/...`)
      if (
        (reqUrl.pathname.startsWith('/api/v1/updates/') ||
          reqUrl.pathname === '/api/v1/updates') &&
        (RAW_DOT_SEGMENT_OR_TRAVERSAL_RE.test(normalizedRawPath) ||
          RAW_ENCODED_SLASH_RE.test(normalizedRawPath))
      ) {
        sendError(res, 400, 'invalid_update_asset', 'Path traversal is not allowed in update asset path');
        return;
      }
      if (
        (reqUrl.pathname.startsWith('/api/v1/user-vault/') ||
          reqUrl.pathname === '/api/v1/user-vault') &&
        (RAW_DOT_SEGMENT_OR_TRAVERSAL_RE.test(normalizedRawPath) ||
          RAW_ENCODED_SLASH_RE.test(normalizedRawPath))
      ) {
        sendError(res, 400, 'invalid_item_key', 'Path traversal is not allowed in vault item key');
        return;
      }
      if (
        (reqUrl.pathname.startsWith('/api/') || reqUrl.pathname.startsWith('/v1/')) &&
        RAW_DOT_SEGMENT_OR_TRAVERSAL_RE.test(normalizedRawPath)
      ) {
        sendError(
          res,
          400,
          'invalid_path',
          'Path traversal or dot-segments are not allowed in API paths',
        );
        return;
      }

      // Transparent reverse proxy to real upstream Rust `gpui_telegram_server` when UPSTREAM_SERVER_URL is set
      if (config.upstreamServerUrl && shouldProxyPathname(reqUrl.pathname)) {
        proxyHttpRequest(config.upstreamServerUrl, req, res);
        return;
      }

      const matched = router.match(req.method ?? 'GET', reqUrl.pathname);

      if (matched) {
        const ctx: RequestContext = {
          req,
          res,
          method: (req.method ?? 'GET').toUpperCase(),
          url: reqUrl,
          pathname: reqUrl.pathname,
          query: reqUrl.searchParams,
          params: matched.params,
        };
        await matched.handler(ctx);
        return;
      }

      // Fallback to static compiled `apps/web/dist` SPA co-hosting
      if (serveStaticSpa(req, res, reqUrl.pathname, config.webDistDir)) {
        return;
      }

      sendError(res, 404, 'not_found', `Route ${req.method} ${reqUrl.pathname} not found`);
    } catch (err) {
      if (err instanceof ApiError) {
        sendError(res, err.status, err.code, err.message, err.extra);
      } else if (err instanceof URIError) {
        sendError(res, 400, 'bad_request', 'Malformed URI encoding');
      } else {
        const message = err instanceof Error ? err.message : 'Internal server error';
        sendError(res, 500, 'internal_error', message);
      }
    }
  });

  if (config.upstreamServerUrl) {
    httpServer.on('upgrade', (req, socket, head) => {
      if (
        shouldProxyWebSocketPathname(req.url ?? '/', {
          proxyBrowserWs: config.proxyBrowserWs,
        })
      ) {
        proxyWebSocketUpgrade(config.upstreamServerUrl!, req, socket, head);
        return;
      }
      hub.handleUpgrade(req, socket, head);
    });
  } else {
    hub.attachToServer(httpServer);
  }

  let isClosed = false;

  return {
    config,
    db,
    hub,
    browserBridge,
    httpServer,
    async start() {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          httpServer.off('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          httpServer.off('error', onError);
          resolve();
        };
        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        httpServer.listen(config.port, config.host);
      });

      const addr = httpServer.address() as AddressInfo;
      const boundPort = addr.port;
      const connectHost = config.host === '::' ? '127.0.0.1' : config.host;
      return {
        port: boundPort,
        host: connectHost,
        baseUrl: `http://${connectHost}:${boundPort}`,
        wsUrl: `ws://${connectHost}:${boundPort}/api/v1/ws`,
      };
    },
    async close() {
      if (isClosed) return;
      isClosed = true;
      shutdownAbort.abort();
      multiAgentOrchestrator.dispose();
      codingAgentBroker.dispose();
      webMcpBroker.close();
      officialMcpRuntime.close();
      remoteAssistRuntime.close();
      await browserBridge.dispose();
      await hub.close();
      httpServer.closeAllConnections?.();
      await new Promise<void>((resolve) => {
        if (!httpServer.listening) {
          resolve();
          return;
        }
        httpServer.close(() => resolve());
      });
      try {
        db.close();
      } catch {
        // Already closed
      }
    },
  };
}

export * from './config.js';
export { closeAllHeadlessSessions } from './routes/browserControl.js';

// CLI Entrypoint when invoked directly via `node apps/server/dist/index.js` (`npm start`)
const isDirectMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectMain) {
  const instance = createTelegramServer();
  instance
    .start()
    .then((info) => {
      console.log(
        `[fabushi-web-server] Listening on ${info.baseUrl} (WS: ${info.wsUrl}, DATA_DIR: ${instance.config.dataDir})`,
      );
    })
    .catch((err) => {
      console.error('[fabushi-web-server] Failed to start:', err);
      process.exit(1);
    });

  const shutdown = async () => {
    await instance.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}
