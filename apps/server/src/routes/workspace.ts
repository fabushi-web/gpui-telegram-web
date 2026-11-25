import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  McpPendingApprovalDto,
  McpServerDto,
  McpToolDto,
  TailnetPeerDescriptor,
  TailnetStatusDto,
  TalkSessionDto,
  TaskFsmState,
  TaskItemDto,
  WalletStateDto,
  WalletTransactionDto,
} from '@gpui-telegram/protocol';
import type { ServerConfig } from '../config.js';
import {
  createMessageAtomic,
  ensureChatWriteAccess,
  getUserProfileDto,
  lookupWalletIdempotency,
  parseOptionalPositiveInt,
  storeWalletIdempotency,
} from '../db/queries.js';
import { computeNextCronRunMs, sha256Hex } from '../utils/crypto.js';
import {
  ApiError,
  readJsonBody,
  readRawBody,
  requireAuth,
  sendJson,
  type HttpRouter,
  type RequestContext,
} from '../utils/http.js';
import type { RealtimeGatewayHub } from '../ws/hub.js';
import { BROWSER_MCP_DOCK_TOOLS, type BrowserControlBridge } from './browserControl.js';
import { getHermesMemoryState } from './hermes.js';
import { runConfiguredLlmCompletion } from './magpie.js';

const VALID_TASK_STATES = new Set<TaskFsmState>([
  'draft',
  'queued',
  'running',
  'waiting_approval',
  'paused',
  'completed',
  'failed',
  'cancelled',
]);

const VALID_MCP_TRANSPORTS = new Set<McpServerDto['transport']>(['stdio', 'sse', 'http']);

export function registerWorkspaceTailnetAndWalletRoutes(
  router: HttpRouter,
  db: DatabaseSync,
  config: ServerConfig,
  hub: RealtimeGatewayHub,
  browserBridge?: BrowserControlBridge,
): void {
  // ==========================================================================
  // 1. Global Task Center (Truthful FSM — ZERO synthetic progress 35/40 or fake logs!)
  // ==========================================================================
  const withTaskAliases = (task: TaskItemDto) => ({
    ...task,
    id: task.task_id,
    status: task.state,
  });

  router.get('/api/v1/tasks', (ctx) => {
    const auth = requireAuth(db, ctx);
    const stateFilter = ctx.query.get('state') ?? ctx.query.get('status');
    const rows = db
      .prepare(`SELECT task_json FROM tasks WHERE user_id = ? ORDER BY updated_at_ms DESC`)
      .all(auth.userId) as Array<{ task_json: string }>;

    let tasks = rows.map((r) => withTaskAliases(JSON.parse(r.task_json) as TaskItemDto));
    if (stateFilter && stateFilter !== 'all') {
      tasks = tasks.filter((t) => t.state === stateFilter);
    }
    sendJson(ctx.res, 200, { tasks });
  });

  router.post('/api/v1/tasks', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      title?: string;
      description?: string;
      state?: TaskFsmState;
      status?: TaskFsmState;
      cron_expr?: string;
      chat_id?: unknown;
    }>(ctx.req);

    const title = (typeof body.title === 'string' ? body.title : '').trim();
    if (!title) throw new ApiError(400, 'invalid_task_title', 'Task title is required');

    let nextRunMs: number | null = null;
    if (body.cron_expr !== undefined && body.cron_expr !== null && typeof body.cron_expr !== 'string') {
      throw new ApiError(400, 'invalid_cron', 'cron_expr must be a string or null');
    }
    if (typeof body.cron_expr === 'string' && body.cron_expr.trim()) {
      try {
        nextRunMs = computeNextCronRunMs(body.cron_expr.trim(), Date.now());
      } catch (err) {
        throw new ApiError(400, 'invalid_cron', err instanceof Error ? err.message : 'Invalid cron');
      }
    }

    const rawState = body.state ?? body.status;
    if (rawState !== undefined && !VALID_TASK_STATES.has(rawState)) {
      throw new ApiError(400, 'invalid_task_state', `Unsupported task state "${String(rawState)}"`);
    }
    const state: TaskFsmState = rawState ?? 'queued';
    const chatId = parseOptionalPositiveInt(body.chat_id, 'invalid_chat_id', 'chat_id must be a positive integer');

    const now = Date.now();
    const task: TaskItemDto = {
      task_id: `task_${crypto.randomBytes(6).toString('hex')}`,
      title,
      description: typeof body.description === 'string' ? body.description : '',
      state,
      cron_expr: typeof body.cron_expr === 'string' && body.cron_expr.trim() ? body.cron_expr.trim() : null,
      next_run_ms: nextRunMs,
      chat_id: chatId ?? null,
      progress: state === 'completed' ? 100 : 0,
      logs: [],
      created_at_ms: now,
      updated_at_ms: now,
    };

    db.prepare(`INSERT INTO tasks (task_id, user_id, task_json, updated_at_ms) VALUES (?, ?, ?, ?)`).run(
      task.task_id,
      auth.userId,
      JSON.stringify(task),
      now,
    );
    sendJson(ctx.res, 201, withTaskAliases(task));
  });

  const handleUpdateTask = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const taskId = ctx.params.taskId!;
    const row = db
      .prepare(`SELECT task_json FROM tasks WHERE task_id = ? AND user_id = ?`)
      .get(taskId, auth.userId) as { task_json: string } | undefined;
    if (!row) throw new ApiError(404, 'task_not_found', 'Task not found');

    const task = JSON.parse(row.task_json) as TaskItemDto;
    let body: {
      title?: string;
      description?: string;
      state?: TaskFsmState;
      status?: TaskFsmState;
      cron_expr?: string | null;
      progress?: number;
      log_line?: string;
    } = {};
    try {
      body = await readJsonBody(ctx.req);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 400)) throw err;
    }

    const actionVerb = ctx.params.actionVerb;
    const nextState: TaskFsmState | undefined =
      actionVerb === 'start' || actionVerb === 'resume'
        ? 'running'
        : actionVerb === 'pause'
          ? 'paused'
          : actionVerb === 'cancel'
            ? 'cancelled'
            : actionVerb === 'complete'
              ? 'completed'
              : (body.state ?? body.status);

    if (nextState !== undefined) {
      if (!VALID_TASK_STATES.has(nextState)) {
        throw new ApiError(400, 'invalid_task_state', `Unsupported task state "${String(nextState)}"`);
      }
      task.state = nextState;
      if (nextState === 'completed') {
        task.progress = 100;
      }
      // ZERO fabricated progress = 40 and ZERO synthetic transition log lines!
    }

    if (typeof body.title === 'string' && body.title.trim()) task.title = body.title.trim();
    if (typeof body.description === 'string') task.description = body.description;
    if (typeof body.progress === 'number' && Number.isFinite(body.progress)) {
      task.progress = Math.max(0, Math.min(100, body.progress));
    }
    if (typeof body.log_line === 'string' && body.log_line.trim()) {
      task.logs.push(body.log_line);
    }

    if (body.cron_expr !== undefined) {
      if (body.cron_expr === null || body.cron_expr === '') {
        task.cron_expr = null;
        task.next_run_ms = null;
      } else if (typeof body.cron_expr !== 'string') {
        throw new ApiError(400, 'invalid_cron', 'cron_expr must be a string or null');
      } else {
        const trimmedCron = body.cron_expr.trim();
        if (!trimmedCron) {
          task.cron_expr = null;
          task.next_run_ms = null;
        } else {
          try {
            task.cron_expr = trimmedCron;
            task.next_run_ms = computeNextCronRunMs(task.cron_expr, Date.now());
          } catch (err) {
            throw new ApiError(400, 'invalid_cron', err instanceof Error ? err.message : 'Invalid cron');
          }
        }
      }
    }

    task.updated_at_ms = Date.now();
    db.prepare(`UPDATE tasks SET task_json = ?, updated_at_ms = ? WHERE task_id = ?`).run(
      JSON.stringify(task),
      task.updated_at_ms,
      taskId,
    );
    sendJson(ctx.res, 200, withTaskAliases(task));
  };
  router.patch('/api/v1/tasks/:taskId', handleUpdateTask);
  router.post('/api/v1/tasks/:taskId/:actionVerb', handleUpdateTask);

  router.delete('/api/v1/tasks/:taskId', (ctx) => {
    const auth = requireAuth(db, ctx);
    db.prepare(`DELETE FROM tasks WHERE task_id = ? AND user_id = ?`).run(ctx.params.taskId!, auth.userId);
    sendJson(ctx.res, 200, { ok: true });
  });

  router.post('/api/v1/cron/evaluate', async (ctx) => {
    requireAuth(db, ctx);
    const body = await readJsonBody<{ expr?: unknown; from_ms?: unknown }>(ctx.req);
    if (body.expr !== undefined && body.expr !== null && typeof body.expr !== 'string') {
      throw new ApiError(400, 'invalid_cron', 'expr must be a string');
    }
    try {
      const nextMs = computeNextCronRunMs(
        typeof body.expr === 'string' ? body.expr : '* * * * *',
        typeof body.from_ms === 'number' && Number.isFinite(body.from_ms) ? body.from_ms : Date.now(),
      );
      sendJson(ctx.res, 200, { ok: true, next_run_ms: nextMs, next_run_iso: new Date(nextMs).toISOString() });
    } catch (err) {
      throw new ApiError(400, 'invalid_cron', err instanceof Error ? err.message : 'Invalid cron');
    }
  });

  // ==========================================================================
  // 2. Truthful MCP Tools & Permission Dock (`/api/v1/mcp/*` — ZERO `mcp_filesystem`!)
  // ==========================================================================
  router.get('/api/v1/mcp/servers', (ctx) => {
    const auth = requireAuth(db, ctx);
    const rows = db
      .prepare(`SELECT server_json FROM mcp_servers WHERE user_id = ? ORDER BY updated_at_ms DESC`)
      .all(auth.userId) as Array<{ server_json: string }>;
    sendJson(ctx.res, 200, {
      servers: rows.map((r) => JSON.parse(r.server_json) as McpServerDto),
    });
  });

  router.post('/api/v1/mcp/servers', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      name?: string;
      transport?: McpServerDto['transport'];
      endpoint?: string;
    }>(ctx.req);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
    if (!name || !endpoint) {
      throw new ApiError(400, 'invalid_mcp_server', 'name and endpoint are required');
    }
    let transport: McpServerDto['transport'] = 'stdio';
    if (body.transport !== undefined && body.transport !== null) {
      if (
        typeof body.transport !== 'string' ||
        !VALID_MCP_TRANSPORTS.has(body.transport as McpServerDto['transport'])
      ) {
        throw new ApiError(400, 'invalid_transport', 'transport must be one of: stdio, sse, http');
      }
      transport = body.transport as McpServerDto['transport'];
    }
    const server: McpServerDto = {
      server_id: `mcp_${crypto.randomBytes(5).toString('hex')}`,
      name,
      transport,
      endpoint,
      enabled: true,
      // Honest initial state — NEVER fabricate `connected` or `tools_count: 2`!
      status: 'disconnected',
      tools_count: 0,
    };
    db.prepare(`INSERT INTO mcp_servers (server_id, user_id, server_json, updated_at_ms) VALUES (?, ?, ?, ?)`).run(
      server.server_id,
      auth.userId,
      JSON.stringify(server),
      Date.now(),
    );
    sendJson(ctx.res, 201, server);
  });

  router.delete('/api/v1/mcp/servers/:serverId', (ctx) => {
    const auth = requireAuth(db, ctx);
    db.prepare(`DELETE FROM mcp_servers WHERE server_id = ? AND user_id = ?`).run(
      ctx.params.serverId!,
      auth.userId,
    );
    sendJson(ctx.res, 200, { ok: true });
  });

  router.get('/api/v1/mcp/tools', (ctx) => {
    const auth = browserBridge ? browserBridge.requireBrowserAuth(ctx) : requireAuth(db, ctx);
    const approvalRows = db
      .prepare(`SELECT approval_json FROM mcp_approvals WHERE user_id = ? ORDER BY created_at_ms DESC`)
      .all(auth.userId) as Array<{ approval_json: string }>;

    // Fresh users with zero connected MCP servers & zero active browser targets/pairings get `tools: []`!
    const tools: McpToolDto[] =
      browserBridge && browserBridge.hasActiveControlForUser(auth.userId)
        ? [...BROWSER_MCP_DOCK_TOOLS]
        : [];

    sendJson(ctx.res, 200, {
      tools,
      approvals: approvalRows.map((r) => JSON.parse(r.approval_json) as McpPendingApprovalDto),
    });
  });

  const handleMcpInvoke = async (ctx: RequestContext): Promise<void> => {
    const auth = browserBridge ? browserBridge.requireBrowserAuth(ctx) : requireAuth(db, ctx);
    const body = await readJsonBody<{
      tool_id?: string;
      tool_name?: string;
      arguments?: Record<string, unknown>;
      force_approve?: boolean;
    }>(ctx.req);

    const tool = BROWSER_MCP_DOCK_TOOLS.find(
      (t) =>
        (typeof body.tool_id === 'string' && t.tool_id === body.tool_id) ||
        (typeof body.tool_name === 'string' && t.name === body.tool_name),
    );
    if (!tool) {
      throw new ApiError(
        404,
        'mcp_tool_not_found',
        `Unknown or unavailable MCP tool: ${String(body.tool_name ?? body.tool_id ?? '')}`,
      );
    }

    if (
      body.arguments !== undefined &&
      body.arguments !== null &&
      (typeof body.arguments !== 'object' || Array.isArray(body.arguments))
    ) {
      throw new ApiError(400, 'invalid_arguments', 'arguments must be a plain JSON object');
    }
    const safeArgs =
      body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments)
        ? body.arguments
        : {};

    if (tool.requires_approval && !body.force_approve) {
      const reqId = `mcpa_${crypto.randomBytes(6).toString('hex')}`;
      const pending: McpPendingApprovalDto = {
        request_id: reqId,
        server_id: tool.server_id,
        tool_name: tool.name,
        arguments: safeArgs,
        risk_level: tool.risk_level,
        status: 'pending',
        created_at_ms: Date.now(),
      };
      db.prepare(`INSERT INTO mcp_approvals (request_id, user_id, approval_json, created_at_ms) VALUES (?, ?, ?, ?)`).run(
        reqId,
        auth.userId,
        JSON.stringify(pending),
        pending.created_at_ms,
      );
      sendJson(ctx.res, 202, { status: 'approval_required', approval: pending });
      return;
    }

    if (!browserBridge) {
      throw new ApiError(503, 'mcp_server_disconnected', 'Browser MCP bridge is not available');
    }

    const callerAuth =
      'callerKind' in auth
        ? auth
        : {
            userId: auth.userId,
            callerKind: 'user_session' as const,
            callerLabel: `Web (@${auth.username})`,
            rawToken: auth.rawToken,
            generation: browserBridge.getGeneration(auth.userId),
          };
    const executed = await browserBridge.executeMcpTool(callerAuth, tool.name, safeArgs);
    sendJson(ctx.res, 200, {
      status: 'completed',
      tool_name: tool.name,
      output: executed.result,
      screenshot_data_url: executed.screenshotDataUrl,
    });
  };
  router.post('/api/v1/mcp/invoke', handleMcpInvoke);
  router.post('/api/v1/mcp/call', handleMcpInvoke);

  const handleMcpApprovalDecision = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{ request_id?: unknown; allow?: unknown; approved?: unknown }>(ctx.req);
    const rawReqId = ctx.params.requestId ?? body.request_id;
    if (typeof rawReqId !== 'string' || !rawReqId.trim()) {
      throw new ApiError(400, 'invalid_request_id', 'request_id must be a non-empty string');
    }
    const reqId = rawReqId.trim();
    const row = db
      .prepare(`SELECT approval_json FROM mcp_approvals WHERE request_id = ? AND user_id = ?`)
      .get(reqId, auth.userId) as { approval_json: string } | undefined;
    if (!row) throw new ApiError(404, 'mcp_approval_not_found', 'MCP approval request not found');

    const item = JSON.parse(row.approval_json) as McpPendingApprovalDto;
    const allowed =
      typeof body.allow === 'boolean'
        ? body.allow
        : typeof body.approved === 'boolean'
          ? body.approved
          : true;
    item.status = allowed ? 'approved' : 'rejected';
    db.prepare(`UPDATE mcp_approvals SET approval_json = ? WHERE request_id = ?`).run(
      JSON.stringify(item),
      reqId,
    );
    sendJson(ctx.res, 200, item);
  };
  router.post('/api/v1/mcp/approve', handleMcpApprovalDecision);
  router.post('/api/v1/mcp/permission/approve', handleMcpApprovalDecision);
  router.post('/api/v1/mcp/approvals/:requestId/resolve', handleMcpApprovalDecision);

  // ==========================================================================
  // 3. Full-Duplex Talk Mode (`/api/v1/talk/*` — ZERO fake `"Heard ..."` echo!)
  // ==========================================================================
  function getOrInitTalkSession(userId: number): TalkSessionDto {
    const row = db
      .prepare(`SELECT session_json FROM talk_sessions WHERE user_id = ?`)
      .get(userId) as { session_json: string } | undefined;
    if (row) return JSON.parse(row.session_json) as TalkSessionDto;
    return {
      session_id: `talk_${userId}`,
      state: 'idle',
      generation: 1,
      signal_seq: 1,
      buffered_chunks: 0,
    };
  }

  function saveTalkSession(userId: number, session: TalkSessionDto): void {
    db.prepare(`INSERT OR REPLACE INTO talk_sessions (user_id, session_json, updated_at_ms) VALUES (?, ?, ?)`).run(
      userId,
      JSON.stringify(session),
      Date.now(),
    );
  }

  router.get('/api/v1/talk/session', (ctx) => {
    const auth = requireAuth(db, ctx);
    sendJson(ctx.res, 200, getOrInitTalkSession(auth.userId));
  });

  const handleStartTalk = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    try {
      await readJsonBody(ctx.req);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 400)) throw err;
    }
    const cur = getOrInitTalkSession(auth.userId);
    const updated: TalkSessionDto = {
      ...cur,
      state: 'listening',
      signal_seq: cur.signal_seq + 1,
      buffered_chunks: 0,
    };
    saveTalkSession(auth.userId, updated);
    sendJson(ctx.res, 200, updated);
  };
  router.post('/api/v1/talk/session', handleStartTalk);
  router.post('/api/v1/talk/start', handleStartTalk);

  router.post('/api/v1/talk/audio', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const raw = await readRawBody(ctx.req);
    let transcript = '';
    if ((ctx.req.headers['content-type'] ?? '').includes('application/json') && raw.length > 0) {
      try {
        const parsed: unknown = JSON.parse(raw.toString('utf8'));
        if (
          parsed &&
          typeof parsed === 'object' &&
          !Array.isArray(parsed) &&
          typeof (parsed as { transcript?: unknown }).transcript === 'string'
        ) {
          transcript = ((parsed as { transcript: string }).transcript).trim();
        }
      } catch {
        // Binary audio frame
      }
    }

    if (!transcript) {
      throw new ApiError(
        503,
        'talk_pipeline_unconfigured',
        'No configured speech-to-text (STT) pipeline for raw audio frames',
      );
    }

    const mem = getHermesMemoryState(db, auth.userId);
    const llmRes = await runConfiguredLlmCompletion(db, config, auth.userId, [
      { role: 'system', content: mem.soul },
      { role: 'user', content: transcript },
    ]);
    if (llmRes.unconfigured) {
      throw new ApiError(
        503,
        'talk_pipeline_unconfigured',
        'No configured speech/LLM pipeline for Talk Mode',
        {
          needs_provider_selection: true,
          action: 'hermes:open_ai_providers',
        },
      );
    }
    if (!llmRes.usedUpstream) {
      throw new ApiError(502, 'upstream_unreachable', llmRes.error || 'Upstream LLM failed');
    }

    const cur = getOrInitTalkSession(auth.userId);
    const updated: TalkSessionDto = {
      ...cur,
      state: 'speaking',
      signal_seq: cur.signal_seq + 1,
      buffered_chunks: cur.buffered_chunks + 1,
      last_transcript: transcript,
      last_reply: llmRes.text,
      tts_segments: [llmRes.text],
    };
    saveTalkSession(auth.userId, updated);
    sendJson(ctx.res, 200, updated);
  });

  const handleTalkBargeIn = (ctx: RequestContext): void => {
    const auth = requireAuth(db, ctx);
    const cur = getOrInitTalkSession(auth.userId);
    const updated: TalkSessionDto = {
      ...cur,
      state: 'listening',
      generation: cur.generation + 1,
      signal_seq: cur.signal_seq + 1,
      buffered_chunks: 0,
      tts_segments: [],
    };
    saveTalkSession(auth.userId, updated);
    sendJson(ctx.res, 200, updated);
  };
  router.post('/api/v1/talk/barge-in', handleTalkBargeIn);
  router.post('/api/v1/talk/barge_in', handleTalkBargeIn);

  router.post('/api/v1/talk/stop', (ctx) => {
    const auth = requireAuth(db, ctx);
    const cur = getOrInitTalkSession(auth.userId);
    const updated: TalkSessionDto = {
      ...cur,
      state: 'idle',
      signal_seq: cur.signal_seq + 1,
      buffered_chunks: 0,
    };
    saveTalkSession(auth.userId, updated);
    sendJson(ctx.res, 200, updated);
  });

  // ==========================================================================
  // 4. Truthful Tailnet Private Device Mesh (`/api/v1/tailnet/*` — ZERO `100.64.0.1`!)
  // ==========================================================================
  const handleTailnetStatus = (ctx: RequestContext): void => {
    const auth = requireAuth(db, ctx);
    const rows = db
      .prepare(`SELECT peer_json FROM tailnet_peers WHERE user_id = ? ORDER BY updated_at_ms DESC`)
      .all(auth.userId) as Array<{ peer_json: string }>;

    const peers = rows.map((r) => JSON.parse(r.peer_json) as TailnetPeerDescriptor);
    const hasOnlinePeer = peers.some((p) => p.online);

    const selfPeer: TailnetPeerDescriptor = {
      device_id: `web_${auth.sessionId.slice(-6)}`,
      display_name: 'Fabushi Web Session',
      ipv4: '',
      relay_mode: 'derp',
      derp_region: 'primary',
      online: false,
      latency_ms: 0,
      last_seen_ms: Date.now(),
    };

    const dto: TailnetStatusDto = {
      owner_user_id: auth.userId,
      seq: peers.length,
      connected: hasOnlinePeer,
      derp_region: 'primary',
      derp_ws_path: '/api/v1/tailnet/derp',
      stun_http_path: '/api/v1/tailnet/stun',
      self_peer: selfPeer,
      peers,
    };
    sendJson(ctx.res, 200, dto);
  };
  router.get('/api/v1/tailnet/status', handleTailnetStatus);
  router.get('/api/v1/tailnet/netmap', handleTailnetStatus);

  router.post('/api/v1/tailnet/register', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      device_id?: string;
      display_name?: string;
      ipv4?: string;
    }>(ctx.req);
    const peer: TailnetPeerDescriptor = {
      device_id:
        typeof body.device_id === 'string' && body.device_id.trim()
          ? body.device_id.trim()
          : `dev_${crypto.randomBytes(4).toString('hex')}`,
      display_name:
        typeof body.display_name === 'string' && body.display_name.trim()
          ? body.display_name.trim()
          : 'Registered Peer',
      ipv4: typeof body.ipv4 === 'string' ? body.ipv4.trim() : '',
      relay_mode: 'derp',
      derp_region: 'primary',
      online: false,
      latency_ms: 0,
      last_seen_ms: Date.now(),
    };
    db.prepare(`
      INSERT OR REPLACE INTO tailnet_peers (user_id, device_id, peer_json, updated_at_ms)
      VALUES (?, ?, ?, ?)
    `).run(auth.userId, peer.device_id, JSON.stringify(peer), peer.last_seen_ms);

    handleTailnetStatus(ctx);
  });

  router.get('/api/v1/tailnet/stun', (ctx) => {
    const observedAddr = ctx.req.socket.remoteAddress ?? '';
    const observedPort = ctx.req.socket.remotePort ?? 0;
    sendJson(ctx.res, 200, {
      observed_addr: observedAddr ? `${observedAddr}:${observedPort}` : '',
      derp_region: 'primary',
      server_time_ms: Date.now(),
    });
  });

  // ==========================================================================
  // 5. Stars & TON Wallet Ledger (Truthful 0 balance + 402 payment_required gating!)
  // ==========================================================================
  function buildWalletState(userId: number): WalletStateDto & { stars: number; ton: number } {
    const now = Date.now();
    db.prepare(`
      INSERT OR IGNORE INTO wallet_accounts (user_id, stars_balance, ton_nano, updated_at_ms)
      VALUES (?, 0, 0, ?)
    `).run(userId, now);

    const acc = db
      .prepare(`SELECT stars_balance, ton_nano, updated_at_ms FROM wallet_accounts WHERE user_id = ?`)
      .get(userId) as { stars_balance: number; ton_nano: number; updated_at_ms: number };

    const txRows = db
      .prepare(`SELECT tx_json FROM wallet_transactions WHERE user_id = ? ORDER BY created_at_ms DESC LIMIT 50`)
      .all(userId) as Array<{ tx_json: string }>;

    const stars = Number(acc.stars_balance);
    const tonNano = Number(acc.ton_nano);
    const tonNum = Number((tonNano / 1_000_000_000).toFixed(4));
    return {
      user_id: userId,
      stars,
      balance: stars,
      stars_balance: stars,
      ton: tonNum,
      ton_nano: tonNano,
      ton_balance: tonNum.toFixed(4),
      updated_at_ms: Number(acc.updated_at_ms),
      transactions: txRows.map((r) => JSON.parse(r.tx_json) as WalletTransactionDto),
    };
  }

  const handleGetWallet = (ctx: RequestContext): void => {
    const auth = requireAuth(db, ctx);
    sendJson(ctx.res, 200, buildWalletState(auth.userId));
  };
  router.get('/api/v1/wallet', handleGetWallet);
  router.get('/api/v1/wallet/stars', handleGetWallet);
  router.get('/api/v1/wallet/balance', handleGetWallet);
  router.get('/api/v1/wallet/transactions', handleGetWallet);
  router.get('/api/v1/stars/balance', handleGetWallet);
  router.get('/api/v1/stars/transactions', handleGetWallet);

  const handleTopupStars = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      amount?: number;
      amount_stars?: number;
      stars?: number;
      order_id?: string;
      redeem_code?: string;
      idempotency_key?: string;
    }>(ctx.req);

    const headerIdem = ctx.req.headers['idempotency-key'];
    const idempotencyKey =
      (typeof headerIdem === 'string' ? headerIdem.trim() : undefined) ??
      (typeof body.idempotency_key === 'string' ? body.idempotency_key.trim() : undefined);
    const cached = lookupWalletIdempotency<WalletStateDto & { stars: number; ton: number }>(
      db,
      auth.userId,
      idempotencyKey,
      'wallet_topup',
    );
    if (cached) {
      sendJson(ctx.res, 200, cached);
      return;
    }

    const orderId = typeof body.order_id === 'string' ? body.order_id.trim() : '';
    const redeemCode = typeof body.redeem_code === 'string' ? body.redeem_code.trim() : '';
    if (!orderId && !redeemCode) {
      throw new ApiError(
        402,
        'payment_required',
        'Verified payment order (order_id) or admin-issued redeem_code is required for Stars top-up',
      );
    }

    const now = Date.now();
    buildWalletState(auth.userId);
    let creditedStars = 0;

    db.exec('BEGIN IMMEDIATE;');
    try {
      if (redeemCode) {
        const codeHash = sha256Hex(redeemCode);
        const codeRow = db
          .prepare(
            `SELECT kind, stars_amount, redeemed_at_ms, expires_at_ms
             FROM redeem_codes WHERE code_hash = ?`,
          )
          .get(codeHash) as
          | {
              kind: string;
              stars_amount: number;
              redeemed_at_ms: number | null;
              expires_at_ms: number | null;
            }
          | undefined;
        if (
          !codeRow ||
          codeRow.kind !== 'stars' ||
          codeRow.redeemed_at_ms !== null ||
          (codeRow.expires_at_ms !== null && Number(codeRow.expires_at_ms) < now) ||
          Number(codeRow.stars_amount) <= 0
        ) {
          db.exec('ROLLBACK;');
          throw new ApiError(402, 'payment_required', 'Invalid, expired, or already redeemed Stars code');
        }
        creditedStars = Math.trunc(Number(codeRow.stars_amount));
        db.prepare(
          `UPDATE redeem_codes SET redeemed_by_user_id = ?, redeemed_at_ms = ? WHERE code_hash = ?`,
        ).run(auth.userId, now, codeHash);
      } else {
        const orderRow = db
          .prepare(
            `SELECT user_id, kind, amount_stars, status, consumed_at_ms
             FROM payment_orders WHERE order_id = ?`,
          )
          .get(orderId) as
          | {
              user_id: number;
              kind: string;
              amount_stars: number;
              status: string;
              consumed_at_ms: number | null;
            }
          | undefined;
        if (
          !orderRow ||
          Number(orderRow.user_id) !== auth.userId ||
          orderRow.kind !== 'stars' ||
          orderRow.status !== 'paid' ||
          orderRow.consumed_at_ms !== null ||
          Number(orderRow.amount_stars) <= 0
        ) {
          db.exec('ROLLBACK;');
          throw new ApiError(402, 'payment_required', 'Verified paid Stars order is required');
        }
        creditedStars = Math.trunc(Number(orderRow.amount_stars));
        db.prepare(`UPDATE payment_orders SET consumed_at_ms = ? WHERE order_id = ?`).run(now, orderId);
      }

      db.prepare(`
        UPDATE wallet_accounts SET stars_balance = stars_balance + ?, updated_at_ms = ? WHERE user_id = ?
      `).run(creditedStars, now, auth.userId);

      const tx: WalletTransactionDto = {
        tx_id: `tx_${crypto.randomBytes(6).toString('hex')}`,
        kind: 'topup',
        amount_stars: creditedStars,
        description: `Verified credit +${creditedStars} Telegram Stars`,
        created_at_ms: now,
      };
      db.prepare(`INSERT INTO wallet_transactions (tx_id, user_id, tx_json, created_at_ms) VALUES (?, ?, ?, ?)`).run(
        tx.tx_id,
        auth.userId,
        JSON.stringify(tx),
        now,
      );
      db.exec('COMMIT;');
    } catch (err) {
      try {
        db.exec('ROLLBACK;');
      } catch {
        // Already rolled back
      }
      throw err;
    }

    const nextState = buildWalletState(auth.userId);
    storeWalletIdempotency(db, auth.userId, idempotencyKey, 'wallet_topup', nextState);
    sendJson(ctx.res, 200, nextState);
  };
  router.post('/api/v1/wallet/topup', handleTopupStars);
  router.post('/api/v1/wallet/stars/topup', handleTopupStars);
  router.post('/api/v1/stars/topup', handleTopupStars);

  const handleGiftOrTransferStars = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      to_user_id?: unknown;
      recipient_id?: unknown;
      chat_id?: unknown;
      amount_stars?: number;
      stars?: number;
      amount?: number;
      gift_id?: string;
      emoji?: string;
      title?: string;
      message?: string;
      idempotency_key?: string;
    }>(ctx.req);

    const headerIdem = ctx.req.headers['idempotency-key'];
    const idempotencyKey =
      (typeof headerIdem === 'string' ? headerIdem.trim() : undefined) ??
      (typeof body.idempotency_key === 'string' ? body.idempotency_key.trim() : undefined);
    const cached = lookupWalletIdempotency<WalletStateDto & { stars: number; ton: number }>(
      db,
      auth.userId,
      idempotencyKey,
      'wallet_gift',
    );
    if (cached) {
      sendJson(ctx.res, 200, cached);
      return;
    }

    const recipientId = parseOptionalPositiveInt(
      body.to_user_id ?? body.recipient_id,
      'invalid_recipient',
      'A valid recipient user ID is required',
    );
    if (!recipientId) {
      throw new ApiError(400, 'invalid_recipient', 'A valid recipient user ID is required');
    }
    if (recipientId === auth.userId) {
      throw new ApiError(400, 'self_transfer_not_allowed', 'Cannot transfer or gift Stars to yourself');
    }
    const recipientProfile = getUserProfileDto(db, recipientId);
    if (!recipientProfile) {
      throw new ApiError(404, 'recipient_not_found', 'Recipient user does not exist');
    }

    const rawAmount = body.amount_stars ?? body.stars ?? body.amount ?? 50;
    if (typeof rawAmount !== 'number' && typeof rawAmount !== 'string') {
      throw new ApiError(400, 'invalid_gift_amount', 'Gift amount must be a positive number');
    }
    const amount = Math.trunc(Number(rawAmount));
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ApiError(400, 'invalid_gift_amount', 'Gift amount must be positive');
    }

    const chatId = parseOptionalPositiveInt(body.chat_id, 'invalid_chat_id', 'chat_id must be a positive integer');
    if (chatId !== undefined) {
      ensureChatWriteAccess(db, chatId, auth.userId);
    }

    const senderState = buildWalletState(auth.userId);
    if (senderState.stars_balance < amount) {
      throw new ApiError(400, 'insufficient_stars', 'Insufficient Telegram Stars balance');
    }
    buildWalletState(recipientId);

    const now = Date.now();
    db.exec('BEGIN IMMEDIATE;');
    try {
      const freshSender = db
        .prepare(`SELECT stars_balance FROM wallet_accounts WHERE user_id = ?`)
        .get(auth.userId) as { stars_balance: number };
      if (Number(freshSender.stars_balance) < amount) {
        throw new ApiError(400, 'insufficient_stars', 'Insufficient Telegram Stars balance');
      }

      db.prepare(`UPDATE wallet_accounts SET stars_balance = stars_balance - ?, updated_at_ms = ? WHERE user_id = ?`).run(
        amount,
        now,
        auth.userId,
      );
      db.prepare(`UPDATE wallet_accounts SET stars_balance = stars_balance + ?, updated_at_ms = ? WHERE user_id = ?`).run(
        amount,
        now,
        recipientId,
      );

      const senderTx: WalletTransactionDto = {
        tx_id: `tx_${crypto.randomBytes(6).toString('hex')}`,
        kind: 'gift_sent',
        amount_stars: -amount,
        peer_user_id: recipientId,
        chat_id: chatId,
        description: `Sent Star Gift (${amount} ⭐) to User #${recipientId}`,
        created_at_ms: now,
      };
      const recipientTx: WalletTransactionDto = {
        tx_id: `tx_${crypto.randomBytes(6).toString('hex')}`,
        kind: 'gift_received',
        amount_stars: amount,
        peer_user_id: auth.userId,
        chat_id: chatId,
        description: `Received Star Gift (${amount} ⭐) from User #${auth.userId}`,
        created_at_ms: now,
      };

      db.prepare(`INSERT INTO wallet_transactions (tx_id, user_id, tx_json, created_at_ms) VALUES (?, ?, ?, ?)`).run(
        senderTx.tx_id,
        auth.userId,
        JSON.stringify(senderTx),
        now,
      );
      db.prepare(`INSERT INTO wallet_transactions (tx_id, user_id, tx_json, created_at_ms) VALUES (?, ?, ?, ?)`).run(
        recipientTx.tx_id,
        recipientId,
        JSON.stringify(recipientTx),
        now,
      );
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }

    if (chatId) {
      createMessageAtomic(db, hub, {
        chatId,
        senderId: auth.userId,
        content: {
          type: 'Gift',
          data: {
            gift_id: typeof body.gift_id === 'string' && body.gift_id.trim() ? body.gift_id : 'gift_star_crystal',
            emoji: typeof body.emoji === 'string' && body.emoji.trim() ? body.emoji : '💎',
            title: typeof body.title === 'string' && body.title.trim() ? body.title : 'Star Crystal Gift',
            stars: amount,
            from_user_id: auth.userId,
            to_user_id: recipientId,
            message: typeof body.message === 'string' ? body.message : undefined,
          },
        },
      });
    }

    const nextState = buildWalletState(auth.userId);
    storeWalletIdempotency(db, auth.userId, idempotencyKey, 'wallet_gift', nextState);
    sendJson(ctx.res, 200, nextState);
  };
  router.post('/api/v1/wallet/gift', handleGiftOrTransferStars);
  router.post('/api/v1/wallet/stars/send-gift', handleGiftOrTransferStars);
  router.post('/api/v1/stars/gift', handleGiftOrTransferStars);
  router.post('/api/v1/wallet/transfer', handleGiftOrTransferStars);
}
