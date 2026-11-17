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
import {
  executeSlashCommandInternal,
  registerHermesStudioRoutes,
} from './routes/hermes.js';
import { registerMagpieGatewayRoutes } from './routes/magpie.js';
import { registerMediaStoriesE2eeAndCallRoutes } from './routes/media.js';
import { registerMessageAndSearchRoutes } from './routes/messages.js';
import { registerWorkspaceTailnetAndWalletRoutes } from './routes/workspace.js';
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
  readonly httpServer: http.Server;
  start(): Promise<{ port: number; host: string; baseUrl: string; wsUrl: string }>;
  close(): Promise<void>;
}

export function createTelegramServer(
  overrides: ServerConfigOverrides = {},
): TelegramServerInstance {
  const config = resolveServerConfig(overrides);
  const db = openSqliteWalDatabase(config.dataDir);
  seedDatabaseIfEmpty(db);

  const hub = new RealtimeGatewayHub(db);
  const router = new HttpRouter();
  const startedAtMs = Date.now();

  // Bot & @HermesAgent conversational message hook (triggered from both HTTP and WS SendMessage!)
  const dispatchBotReplyIfApplicable = (chatId: number, senderId: number, text: string): void => {
    // Ignore messages authored by bots themselves to prevent infinite loops
    if (senderId >= 777000) return;

    // 1. Check @BotFather / @FabushiBot / custom bots
    if (handleBotConversationTurn(db, hub, chatId, senderId, text)) {
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
        createMessageAtomic(db, hub, {
          chatId,
          senderId: 777000,
          text: slashRes.response_text,
        });
      } else {
        createMessageAtomic(db, hub, {
          chatId,
          senderId: 777000,
          text: `🤖 **Hermes AI**: Processed "${trimmed.slice(0, 160)}". Open **Hermes 6-Tab Studio** for full SSE reasoning & tool traces.`,
        });
      }
    }
  };

  hub.setBotTriggerHook(dispatchBotReplyIfApplicable);

  // Health, Readiness, Version & Deterministic Test Reset
  const handleHealth = (ctx: RequestContext): void => {
    const dbOk = Boolean(db.prepare(`SELECT 1 AS ok`).get());
    sendJson(ctx.res, 200, {
      ok: dbOk,
      status: 'ok',
      service: 'gpui-telegram-server',
      version: '1.2.0',
      db: dbOk ? 'wal_ready' : 'error',
      uptime_secs: Math.floor((Date.now() - startedAtMs) / 1000),
      online_users: hub.getOnlineUsersCount(),
    });
  };
  router.get('/api/v1/health', handleHealth);
  router.get('/api/v1/ready', handleHealth);
  router.get('/healthz', handleHealth);
  router.get('/health', handleHealth);

  router.get('/api/v1/version', (ctx) => {
    sendJson(ctx.res, 200, {
      name: '@gpui-telegram/server',
      version: '1.2.0',
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
  registerAuthAndUserRoutes(router, db, hub);
  registerChatAndSocialRoutes(router, db, hub);
  registerMessageAndSearchRoutes(router, db, hub, dispatchBotReplyIfApplicable);
  registerMediaStoriesE2eeAndCallRoutes(router, db, config, hub);
  registerBotsMiniAppsAndFabushiRoutes(router, db, hub);
  registerHermesStudioRoutes(router, db, hub);
  registerMagpieGatewayRoutes(router, db, config);
  registerWorkspaceTailnetAndWalletRoutes(router, db, config, hub);

  const httpServer = http.createServer(async (req, res) => {
    setCorsHeaders(res);
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    try {
      const reqUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
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

  hub.attachToServer(httpServer);

  let isClosed = false;

  return {
    config,
    db,
    hub,
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
