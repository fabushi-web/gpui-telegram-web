import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { resolveServerConfig, type ServerConfig, type ServerConfigOverrides } from './config.js';
import { createMessageAtomic } from './db/queries.js';
import { openSqliteWalDatabase } from './db/schema.js';
import { resetAndSeedDatabase, seedDatabaseIfEmpty } from './db/seed.js';
import { registerAuthAndUserRoutes } from './routes/auth.js';
import {
  handleBotConversationTurn,
  registerBotsMiniAppsAndFabushiRoutes,
} from './routes/botsMiniApps.js';
import { registerChatAndSocialRoutes } from './routes/chats.js';
import { registerFabushiMiniAppRoutes } from './routes/fabushiMiniApp.js';
import {
  executeSlashCommandInternal,
  getHermesMemoryState,
  registerHermesStudioRoutes,
} from './routes/hermes.js';
import { registerMagpieGatewayRoutes, runConfiguredLlmCompletion } from './routes/magpie.js';
import { registerMediaStoriesE2eeAndCallRoutes } from './routes/media.js';
import { registerMessageAndSearchRoutes } from './routes/messages.js';
import {
  BrowserControlBridge,
  registerBrowserControlRoutes,
} from './routes/browserControl.js';
import { registerWorkspaceTailnetAndWalletRoutes } from './routes/workspace.js';
import { proxyHttpRequest, proxyWebSocketUpgrade, shouldProxyPathname } from './proxy.js';
import { serveStaticSpa } from './staticHost.js';
import {
  ApiError,
  HttpRouter,
  sendError,
  sendJson,
  setCorsHeaders,
  type RequestContext,
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

export function createTelegramServer(
  overrides: ServerConfigOverrides = {},
): TelegramServerInstance {
  const config = resolveServerConfig(overrides);
  const db = openSqliteWalDatabase(config.dataDir);
  seedDatabaseIfEmpty(db, { seedDemoData: config.seedDemoData });

  const hub = new RealtimeGatewayHub(db);
  const browserBridge = new BrowserControlBridge(db);
  hub.setBrowserControlBridge(browserBridge);

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

  // Bot & @HermesAgent conversational message hook (triggered from both HTTP and WS SendMessage!)
  const runBotReplyNow = (chatId: number, senderId: number, text: string): void => {
    try {
      // 1. Check @BotFather / @FabushiBot / custom bots
      if (handleBotConversationTurn(db, deferredBotSink, chatId, senderId, text)) {
        return;
      }

      // 2. Check @HermesAgent (`777000`) DM chat or `@HermesAgent` mention
      const hermesInChat = db
        .prepare(`SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = 777000`)
        .get(chatId);
      const chatMeta = db
        .prepare(`SELECT chat_type, peer_user_id FROM chats WHERE chat_id = ?`)
        .get(chatId) as { chat_type: number; peer_user_id: number | null } | undefined;

      const isDirectHermes = chatMeta?.chat_type === 0 && Number(chatMeta.peer_user_id) === 777000;
      const mentionsHermes = /@HermesAgent\b/i.test(text);

      if (isDirectHermes || (hermesInChat && mentionsHermes)) {
        const trimmed = text.trim();
        if (trimmed.startsWith('/')) {
          const slashRes = executeSlashCommandInternal(db, senderId, trimmed, undefined, chatId);
          createMessageAtomic(db, deferredBotSink, {
            chatId,
            senderId: 777000,
            text: slashRes.response_text,
          });
        } else if (config.seedDemoData) {
          // Preserve fast synchronous reply in automated test/sandbox mode
          createMessageAtomic(db, deferredBotSink, {
            chatId,
            senderId: 777000,
            text: `🤖 **Hermes AI**: Processed "${trimmed.slice(0, 160)}". Open **Hermes 6-Tab Studio** for full SSE reasoning & tool traces.`,
          });
        } else {
          // Real async LLM completion via user's Magpie provider or ombhrum.com AI gateway
          void (async () => {
            try {
              const mem = getHermesMemoryState(db, senderId);
              const llmRes = await runConfiguredLlmCompletion(db, config, senderId, [
                { role: 'system', content: mem.soul },
                { role: 'user', content: trimmed },
              ]);
              const replyText =
                llmRes.usedUpstream && llmRes.text
                  ? llmRes.text
                  : llmRes.error
                    ? `⚠️ **Hermes AI** 调用模型失败（${llmRes.providerId}）：${llmRes.error}。请检查 **Magpie LLM 网关** 配置。`
                    : `尚未配置可用的 AI 模型提供商。请点击左侧栏的 **Magpie LLM 网关** 添加并启用 API Key 后，即可与 @HermesAgent 进行真实对话。`;
              createMessageAtomic(db, hub, {
                chatId,
                senderId: 777000,
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
    if (senderId >= 777000) return;
    runBotReplyNow(chatId, senderId, text);
  };

  hub.setBotTriggerHook(dispatchBotReplyIfApplicable);

  // Health, Readiness, Status, Version & Deterministic Test Reset
  const handleHealth = (ctx: RequestContext): void => {
    const dbOk = Boolean(db.prepare(`SELECT 1 AS ok`).get());
    sendJson(ctx.res, 200, {
      ok: dbOk,
      status: 'ok',
      server: 'gpui_telegram_server',
      service: 'gpui-telegram-server',
      version: '1.3.0',
      mode: config.upstreamServerUrl ? 'proxy' : config.seedDemoData ? 'sandbox' : 'production',
      db: dbOk ? 'wal_ready' : 'error',
      uptime_secs: Math.floor((Date.now() - startedAtMs) / 1000),
      online_users: hub.getOnlineUsersCount(),
    });
  };
  router.get('/api/v1/health', handleHealth);
  router.get('/api/v1/status', handleHealth);
  router.get('/api/v1/ready', handleHealth);
  router.get('/healthz', handleHealth);
  router.get('/health', handleHealth);

  router.get('/api/v1/version', (ctx) => {
    sendJson(ctx.res, 200, {
      name: '@gpui-telegram/server',
      server: 'gpui_telegram_server',
      version: '1.3.0',
      node: process.version,
    });
  });

  router.post('/api/v1/test/reset', (ctx) => {
    if (!config.enableTestReset) {
      throw new ApiError(
        403,
        'test_reset_disabled',
        'Deterministic reset requires ENABLE_TEST_RESET=1',
      );
    }
    const t0 = performance.now();
    browserBridge.resetFastSync();
    hub.disconnectAllSessions();
    resetAndSeedDatabase(db, config.mediaDir, config.uploadsDir);
    const elapsedMs = Number((performance.now() - t0).toFixed(2));
    sendJson(ctx.res, 200, {
      ok: true,
      reset: true,
      elapsed_ms: elapsedMs,
    });
  });

  // Register all domain route suites
  registerAuthAndUserRoutes(router, db, hub, config);
  registerChatAndSocialRoutes(router, db, hub);
  registerMessageAndSearchRoutes(router, db, hub, dispatchBotReplyIfApplicable, config);
  registerMediaStoriesE2eeAndCallRoutes(router, db, config, hub);
  registerBotsMiniAppsAndFabushiRoutes(router, db, hub, config);
  registerFabushiMiniAppRoutes(router, db, config, hub);
  registerHermesStudioRoutes(router, db, config, hub);
  registerMagpieGatewayRoutes(router, db, config);
  registerWorkspaceTailnetAndWalletRoutes(router, db, config, hub, browserBridge);
  registerBrowserControlRoutes(router, db, browserBridge);

  const httpServer = http.createServer(async (req, res) => {
    setCorsHeaders(res);
    const allowHeaders = res.getHeader('Access-Control-Allow-Headers');
    if (typeof allowHeaders === 'string') {
      const extras = ['X-Desktop-Browser-Token', 'X-Telegram-Init-Data'].filter(
        (h) => !allowHeaders.includes(h),
      );
      if (extras.length > 0) {
        res.setHeader('Access-Control-Allow-Headers', `${allowHeaders}, ${extras.join(', ')}`);
      }
    }
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    try {
      const reqUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

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
      proxyWebSocketUpgrade(config.upstreamServerUrl!, req, socket, head);
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
        `[gpui-telegram-server] Listening on ${info.baseUrl} (WS: ${info.wsUrl}, DATA_DIR: ${instance.config.dataDir})`,
      );
    })
    .catch((err) => {
      console.error('[gpui-telegram-server] Failed to start:', err);
      process.exit(1);
    });

  const shutdown = async () => {
    await instance.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}
