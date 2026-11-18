import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  ComputerNodeDto,
  ComputerRunPolicy,
  McpPendingApprovalDto,
  McpServerDto,
  McpToolDto,
  PendingComputerCommandDto,
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
  getUserProfileDto,
  lookupWalletIdempotency,
  storeWalletIdempotency,
} from '../db/queries.js';
import { buildComputerViewportSvg } from '../db/seed.js';
import { computeNextCronRunMs, encryptSecretAtRest } from '../utils/crypto.js';
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

export const DEFAULT_MCP_TOOLS: McpToolDto[] = [
  { tool_id: 'fs_read_file', server_id: 'mcp_filesystem', name: 'read_file', description: 'Read UTF-8 file contents in workspace', risk_level: 'read_only', requires_approval: false },
  { tool_id: 'fs_list_dir', server_id: 'mcp_filesystem', name: 'list_directory', description: 'List files in a directory', risk_level: 'read_only', requires_approval: false },
  { tool_id: 'fs_write_file', server_id: 'mcp_filesystem', name: 'write_file', description: 'Write or overwrite a workspace file', risk_level: 'high', requires_approval: true },
  ...BROWSER_MCP_DOCK_TOOLS,
];

export function registerWorkspaceTailnetAndWalletRoutes(
  router: HttpRouter,
  db: DatabaseSync,
  config: ServerConfig,
  hub: RealtimeGatewayHub,
  browserBridge?: BrowserControlBridge,
): void {
  // ==========================================================================
  // 1. Global Task Center (7-State FSM + 5-Field Cron Next-Run Evaluator)
  // ==========================================================================
  router.get('/api/v1/tasks', (ctx) => {
    const auth = requireAuth(db, ctx);
    const stateFilter = ctx.query.get('state');
    const rows = db
      .prepare(`SELECT task_json FROM tasks WHERE user_id = ? ORDER BY updated_at_ms DESC`)
      .all(auth.userId) as Array<{ task_json: string }>;

    let tasks = rows.map((r) => JSON.parse(r.task_json) as TaskItemDto);
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
      cron_expr?: string;
      chat_id?: number;
    }>(ctx.req);

    const title = (body.title ?? '').trim();
    if (!title) throw new ApiError(400, 'invalid_task_title', 'Task title is required');

    let nextRunMs: number | null = null;
    if (body.cron_expr && body.cron_expr.trim()) {
      try {
        nextRunMs = computeNextCronRunMs(body.cron_expr.trim(), Date.now());
      } catch (err) {
        throw new ApiError(400, 'invalid_cron', err instanceof Error ? err.message : 'Invalid cron');
      }
    }

    const now = Date.now();
    const state: TaskFsmState = body.state && VALID_TASK_STATES.has(body.state) ? body.state : 'queued';
    const task: TaskItemDto = {
      task_id: `task_${crypto.randomBytes(6).toString('hex')}`,
      title,
      description: body.description ?? '',
      state,
      cron_expr: body.cron_expr?.trim() || null,
      next_run_ms: nextRunMs,
      chat_id: body.chat_id ?? null,
      progress: state === 'completed' ? 100 : state === 'running' ? 35 : 0,
      logs: [`[${new Date(now).toISOString()}] Task created in state "${state}"`],
      created_at_ms: now,
      updated_at_ms: now,
    };

    db.prepare(`INSERT INTO tasks (task_id, user_id, task_json, updated_at_ms) VALUES (?, ?, ?, ?)`).run(
      task.task_id,
      auth.userId,
      JSON.stringify(task),
      now,
    );
    sendJson(ctx.res, 201, task);
  });

  const handleUpdateTask = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const taskId = ctx.params.taskId!;
    const row = db
      .prepare(`SELECT task_json FROM tasks WHERE task_id = ? AND user_id = ?`)
      .get(taskId, auth.userId) as { task_json: string } | undefined;
    if (!row) throw new ApiError(404, 'task_not_found', 'Task not found');

    const task = JSON.parse(row.task_json) as TaskItemDto;
    const body = await readJsonBody<{
      title?: string;
      description?: string;
      state?: TaskFsmState;
      cron_expr?: string | null;
      progress?: number;
      log_line?: string;
    }>(ctx.req);

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
              : body.state;

    if (nextState) {
      if (!VALID_TASK_STATES.has(nextState)) {
        throw new ApiError(400, 'invalid_task_state', `Unsupported task state "${nextState}"`);
      }
      task.state = nextState;
      if (nextState === 'completed') task.progress = 100;
      else if (nextState === 'running' && task.progress === 0) task.progress = 40;
      task.logs.push(`[${new Date().toISOString()}] Transitioned -> ${nextState}`);
    }

    if (body.title !== undefined && body.title.trim()) task.title = body.title.trim();
    if (body.description !== undefined) task.description = body.description;
    if (body.progress !== undefined) task.progress = Math.max(0, Math.min(100, Number(body.progress)));
    if (body.log_line) task.logs.push(body.log_line);

    if (body.cron_expr !== undefined) {
      if (!body.cron_expr) {
        task.cron_expr = null;
        task.next_run_ms = null;
      } else {
        try {
          task.cron_expr = body.cron_expr.trim();
          task.next_run_ms = computeNextCronRunMs(task.cron_expr, Date.now());
        } catch (err) {
          throw new ApiError(400, 'invalid_cron', err instanceof Error ? err.message : 'Invalid cron');
        }
      }
    }

    task.updated_at_ms = Date.now();
    db.prepare(`UPDATE tasks SET task_json = ?, updated_at_ms = ? WHERE task_id = ?`).run(
      JSON.stringify(task),
      task.updated_at_ms,
      taskId,
    );
    sendJson(ctx.res, 200, task);
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
    const body = await readJsonBody<{ expr?: string; from_ms?: number }>(ctx.req);
    try {
      const nextMs = computeNextCronRunMs(body.expr ?? '* * * * *', body.from_ms ?? Date.now());
      sendJson(ctx.res, 200, { ok: true, next_run_ms: nextMs, next_run_iso: new Date(nextMs).toISOString() });
    } catch (err) {
      throw new ApiError(400, 'invalid_cron', err instanceof Error ? err.message : 'Invalid cron');
    }
  });

  // ==========================================================================
  // 2. MCP Tools & Permission Dock (`/api/v1/mcp/*`)
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
    const server: McpServerDto = {
      server_id: `mcp_${crypto.randomBytes(5).toString('hex')}`,
      name: body.name?.trim() || 'Custom MCP Server',
      transport: body.transport ?? 'stdio',
      endpoint: body.endpoint?.trim() || 'npx @modelcontextprotocol/server-memory',
      enabled: true,
      status: 'connected',
      tools_count: 2,
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

    sendJson(ctx.res, 200, {
      tools: DEFAULT_MCP_TOOLS,
      approvals: approvalRows.map((r) => JSON.parse(r.approval_json) as McpPendingApprovalDto),
    });
  });

  router.post('/api/v1/mcp/invoke', async (ctx) => {
    const auth = browserBridge ? browserBridge.requireBrowserAuth(ctx) : requireAuth(db, ctx);
    const body = await readJsonBody<{
      tool_id?: string;
      tool_name?: string;
      arguments?: Record<string, unknown>;
      force_approve?: boolean;
    }>(ctx.req);

    const tool =
      DEFAULT_MCP_TOOLS.find((t) => t.tool_id === body.tool_id || t.name === body.tool_name) ??
      DEFAULT_MCP_TOOLS[0]!;

    if (tool.requires_approval && !body.force_approve) {
      const reqId = `mcpa_${crypto.randomBytes(6).toString('hex')}`;
      const pending: McpPendingApprovalDto = {
        request_id: reqId,
        server_id: tool.server_id,
        tool_name: tool.name,
        arguments: body.arguments ?? {},
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

    if (tool.server_id === 'mcp_browser_bridge' && browserBridge) {
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
      const executed = await browserBridge.executeMcpTool(
        callerAuth,
        tool.name,
        body.arguments ?? {},
      );
      sendJson(ctx.res, 200, {
        status: 'completed',
        tool_name: tool.name,
        output: executed.result,
        screenshot_data_url: executed.screenshotDataUrl,
      });
      return;
    }

    sendJson(ctx.res, 200, {
      status: 'completed',
      tool_name: tool.name,
      output: { ok: true, result: `Executed MCP tool ${tool.name}` },
    });
  });

  const handleMcpApprovalDecision = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{ request_id?: string; allow?: boolean; approved?: boolean }>(ctx.req);
    const reqId = ctx.params.requestId ?? body.request_id ?? '';
    const row = db
      .prepare(`SELECT approval_json FROM mcp_approvals WHERE request_id = ? AND user_id = ?`)
      .get(reqId, auth.userId) as { approval_json: string } | undefined;
    if (!row) throw new ApiError(404, 'mcp_approval_not_found', 'MCP approval request not found');

    const item = JSON.parse(row.approval_json) as McpPendingApprovalDto;
    const allowed = body.allow ?? body.approved ?? true;
    item.status = allowed ? 'approved' : 'rejected';
    db.prepare(`UPDATE mcp_approvals SET approval_json = ? WHERE request_id = ?`).run(
      JSON.stringify(item),
      reqId,
    );
    sendJson(ctx.res, 200, item);
  };
  router.post('/api/v1/mcp/approve', handleMcpApprovalDecision);
  router.post('/api/v1/mcp/approvals/:requestId/resolve', handleMcpApprovalDecision);

  // ==========================================================================
  // 3. Full-Duplex Talk Mode (`/api/v1/talk/*`)
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
    await readJsonBody(ctx.req);
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
    let transcript = 'Hello Hermes voice assistant';
    if ((ctx.req.headers['content-type'] ?? '').includes('application/json') && raw.length > 0) {
      try {
        const parsed = JSON.parse(raw.toString('utf8')) as { transcript?: string };
        if (parsed.transcript) transcript = parsed.transcript;
      } catch {
        // Binary audio frame
      }
    }

    const cur = getOrInitTalkSession(auth.userId);
    const updated: TalkSessionDto = {
      ...cur,
      state: 'speaking',
      signal_seq: cur.signal_seq + 1,
      buffered_chunks: cur.buffered_chunks + 1,
      last_transcript: transcript,
      last_reply: `Voice reply (#${cur.generation}): Heard "${transcript}".`,
      tts_segments: [`Heard "${transcript}".`, 'Ready for follow-up or barge-in.'],
    };
    saveTalkSession(auth.userId, updated);
    sendJson(ctx.res, 200, updated);
  });

  router.post('/api/v1/talk/barge-in', (ctx) => {
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
  });

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
  // 4. Remote Computer Workbench & `<10ms` Emergency Lease Takeover
  // ==========================================================================
  const ensureDefaultComputerNode = (userId: number): void => {
    const existing = db
      .prepare(`SELECT 1 FROM computer_nodes WHERE user_id = ? AND node_id = 'sandbox:default'`)
      .get(userId);
    if (existing) return;
    const now = Date.now();
    const sandboxNode: ComputerNodeDto = {
      node_id: 'sandbox:default',
      display_name: 'Cloud Sandbox (Ubuntu 24.04)',
      kind: 'cloud_sandbox',
      tier_badge: '免费',
      host: '100.64.0.1',
      os_name: 'Linux 6.8 x86_64',
      resolution: '1280x720',
      online: true,
      run_policy: 'allow_read_only',
      has_saved_credential: false,
      lease_state: 'idle',
      lease_generation: 1,
      frame_svg_data_url: buildComputerViewportSvg(
        'sandbox:default — Cloud Workbench',
        'Ready · Policy: allow_read_only · Generation #1',
      ),
      updated_at_ms: now,
    };
    db.prepare(`
      INSERT OR IGNORE INTO computer_nodes (node_id, user_id, node_json, encrypted_secret, secret_nonce, updated_at_ms)
      VALUES ('sandbox:default', ?, ?, NULL, NULL, ?)
    `).run(userId, JSON.stringify(sandboxNode), now);
  };

  const handleListComputers = (ctx: RequestContext): void => {
    const auth = requireAuth(db, ctx);
    ensureDefaultComputerNode(auth.userId);
    const rows = db
      .prepare(`SELECT node_json FROM computer_nodes WHERE user_id = ? ORDER BY updated_at_ms ASC`)
      .all(auth.userId) as Array<{ node_json: string }>;
    const cmdRows = db
      .prepare(`SELECT cmd_json FROM computer_commands WHERE user_id = ? ORDER BY created_at_ms DESC LIMIT 50`)
      .all(auth.userId) as Array<{ cmd_json: string }>;

    const computers = rows.map((r) => JSON.parse(r.node_json) as ComputerNodeDto);
    const commands = cmdRows.map((r) => JSON.parse(r.cmd_json) as PendingComputerCommandDto);

    sendJson(ctx.res, 200, {
      computers,
      pending_approvals: commands.filter((c) => c.status === 'pending'),
    });
  };
  router.get('/api/v1/computers', handleListComputers);
  router.get('/api/v1/computer/state', handleListComputers);

  router.post('/api/v1/computers/cloud', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      display_name?: string;
      host?: string;
      ssh_user?: string;
      secret?: string;
      run_policy?: ComputerRunPolicy;
    }>(ctx.req);

    const nodeId = `cloud:${crypto.randomBytes(5).toString('hex')}`;
    const now = Date.now();
    let encSecret: string | null = null;
    let secretNonce: string | null = null;

    if (body.secret) {
      const enc = encryptSecretAtRest(
        config.masterSecret,
        `computer:${auth.userId}:${nodeId}`,
        body.secret,
      );
      encSecret = enc.ciphertextB64;
      secretNonce = enc.nonceB64;
    }

    const node: ComputerNodeDto = {
      node_id: nodeId,
      display_name: body.display_name?.trim() || `Cloud SSH (${body.host ?? '127.0.0.1'})`,
      kind: 'cloud_server',
      host: body.host ?? '127.0.0.1',
      os_name: 'Linux SSH Host',
      resolution: '1920x1080',
      online: true,
      run_policy: body.run_policy ?? 'ask_every_time',
      has_saved_credential: Boolean(body.secret),
      lease_state: 'idle',
      lease_generation: 1,
      frame_svg_data_url: buildComputerViewportSvg(nodeId, `Connected · Policy: ${body.run_policy ?? 'ask_every_time'}`),
      updated_at_ms: now,
    };

    db.prepare(`
      INSERT INTO computer_nodes (node_id, user_id, node_json, encrypted_secret, secret_nonce, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(nodeId, auth.userId, JSON.stringify(node), encSecret, secretNonce, now);

    // Response strictly omits raw SSH secret!
    sendJson(ctx.res, 201, node);
  });

  router.patch('/api/v1/computers/:nodeId/policy', async (ctx) => {
    const auth = requireAuth(db, ctx);
    ensureDefaultComputerNode(auth.userId);
    const nodeId = ctx.params.nodeId!;
    const body = await readJsonBody<{ run_policy?: ComputerRunPolicy }>(ctx.req);
    const row = db
      .prepare(`SELECT node_json FROM computer_nodes WHERE node_id = ? AND user_id = ?`)
      .get(nodeId, auth.userId) as { node_json: string } | undefined;
    if (!row) throw new ApiError(404, 'computer_not_found', 'Computer node not found');

    const node = JSON.parse(row.node_json) as ComputerNodeDto;
    node.run_policy = body.run_policy ?? 'ask_every_time';
    node.updated_at_ms = Date.now();
    db.prepare(`UPDATE computer_nodes SET node_json = ?, updated_at_ms = ? WHERE node_id = ? AND user_id = ?`).run(
      JSON.stringify(node),
      node.updated_at_ms,
      nodeId,
      auth.userId,
    );
    sendJson(ctx.res, 200, node);
  });

  const handleComputerCommand = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    ensureDefaultComputerNode(auth.userId);
    const body = await readJsonBody<{
      node_id?: string;
      caller_label?: string;
      operation?: Record<string, unknown>;
    }>(ctx.req);

    const nodeId = ctx.params.nodeId ?? body.node_id ?? 'sandbox:default';
    const row = db
      .prepare(`SELECT node_json FROM computer_nodes WHERE node_id = ? AND user_id = ?`)
      .get(nodeId, auth.userId) as { node_json: string } | undefined;
    if (!row) throw new ApiError(404, 'computer_not_found', 'Computer node not found');

    const node = JSON.parse(row.node_json) as ComputerNodeDto;
    if (node.run_policy === 'disabled') {
      sendJson(ctx.res, 403, { status: 'blocked', reason: 'Computer RunPolicy is disabled' });
      return;
    }

    const op = body.operation ?? { type: 'screenshot' };
    const isReadOnly = op.type === 'screenshot' || op.read_only === true;

    if (
      node.run_policy === 'ask_every_time' ||
      (node.run_policy === 'allow_read_only' && !isReadOnly)
    ) {
      const cmdId = `ccmd_${crypto.randomBytes(6).toString('hex')}`;
      const pending: PendingComputerCommandDto = {
        command_id: cmdId,
        node_id: nodeId,
        caller_label: body.caller_label ?? 'Hermes Agent',
        operation: op,
        status: 'pending',
        created_at_ms: Date.now(),
      };
      db.prepare(`
        INSERT INTO computer_commands (command_id, user_id, node_id, cmd_json, created_at_ms)
        VALUES (?, ?, ?, ?, ?)
      `).run(cmdId, auth.userId, nodeId, JSON.stringify(pending), pending.created_at_ms);

      sendJson(ctx.res, 202, { status: 'queued_for_approval', command_id: cmdId, command: pending });
      return;
    }

    node.lease_state = 'active_control';
    node.frame_svg_data_url = buildComputerViewportSvg(
      node.display_name,
      `Executed ${String(op.type ?? 'action')} · Generation #${node.lease_generation}`,
    );
    node.updated_at_ms = Date.now();
    db.prepare(`UPDATE computer_nodes SET node_json = ?, updated_at_ms = ? WHERE node_id = ? AND user_id = ?`).run(
      JSON.stringify(node),
      node.updated_at_ms,
      nodeId,
      auth.userId,
    );

    sendJson(ctx.res, 200, {
      status: 'completed',
      node_id: nodeId,
      lease_generation: node.lease_generation,
      frame_svg_data_url: node.frame_svg_data_url,
    });
  };
  router.post('/api/v1/computers/:nodeId/commands', handleComputerCommand);
  router.post('/api/v1/computer/action', handleComputerCommand);

  router.post('/api/v1/computers/commands/:commandId/decide', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{ approve?: boolean }>(ctx.req);
    const row = db
      .prepare(`SELECT cmd_json FROM computer_commands WHERE command_id = ? AND user_id = ?`)
      .get(ctx.params.commandId!, auth.userId) as { cmd_json: string } | undefined;
    if (!row) throw new ApiError(404, 'command_not_found', 'Pending command not found');

    const cmd = JSON.parse(row.cmd_json) as PendingComputerCommandDto;
    cmd.status = body.approve === false ? 'denied' : 'approved';
    db.prepare(`UPDATE computer_commands SET cmd_json = ? WHERE command_id = ?`).run(
      JSON.stringify(cmd),
      cmd.command_id,
    );
    sendJson(ctx.res, 200, cmd);
  });

  // `<10ms` Synchronous Atomic Emergency Lease Takeover!
  const handleEmergencyTakeover = async (ctx: RequestContext): Promise<void> => {
    const startHr = process.hrtime.bigint();
    const auth = requireAuth(db, ctx);
    ensureDefaultComputerNode(auth.userId);
    const body = await readJsonBody<{ node_id?: string }>(ctx.req);
    const nodeId = ctx.params.nodeId ?? body.node_id ?? 'sandbox:default';

    const row = db
      .prepare(`SELECT node_json FROM computer_nodes WHERE node_id = ? AND user_id = ?`)
      .get(nodeId, auth.userId) as { node_json: string } | undefined;
    if (!row) throw new ApiError(404, 'computer_not_found', 'Computer node not found');

    const node = JSON.parse(row.node_json) as ComputerNodeDto;
    node.lease_generation += 1;
    node.lease_state = 'human_takeover';
    node.frame_svg_data_url = buildComputerViewportSvg(
      node.display_name,
      `HUMAN TAKEOVER ACTIVE · Agent Preempted · Generation #${node.lease_generation}`,
    );
    node.updated_at_ms = Date.now();

    db.prepare(`UPDATE computer_nodes SET node_json = ?, updated_at_ms = ? WHERE node_id = ? AND user_id = ?`).run(
      JSON.stringify(node),
      node.updated_at_ms,
      nodeId,
      auth.userId,
    );

    const elapsedUs = Number((process.hrtime.bigint() - startHr) / 1000n);
    sendJson(ctx.res, 200, {
      status: 'human_takeover',
      node_id: nodeId,
      new_generation: node.lease_generation,
      elapsed_us: elapsedUs,
      latency_sub_10ms: elapsedUs < 10_000,
      node,
    });
  };
  router.post('/api/v1/computers/:nodeId/takeover', handleEmergencyTakeover);
  router.post('/api/v1/computer/takeover', handleEmergencyTakeover);
  router.post('/api/v1/computer/lease/emergency_takeover', handleEmergencyTakeover);

  const handleReleaseComputerLease = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    ensureDefaultComputerNode(auth.userId);
    const body = await readJsonBody<{ node_id?: string }>(ctx.req);
    const nodeId = ctx.params.nodeId ?? body.node_id ?? 'sandbox:default';
    const row = db
      .prepare(`SELECT node_json FROM computer_nodes WHERE node_id = ? AND user_id = ?`)
      .get(nodeId, auth.userId) as { node_json: string } | undefined;
    if (!row) throw new ApiError(404, 'computer_not_found', 'Computer node not found');

    const node = JSON.parse(row.node_json) as ComputerNodeDto;
    node.lease_state = 'idle';
    node.frame_svg_data_url = buildComputerViewportSvg(
      node.display_name,
      `Lease Released · Ready · Generation #${node.lease_generation}`,
    );
    node.updated_at_ms = Date.now();
    db.prepare(`UPDATE computer_nodes SET node_json = ?, updated_at_ms = ? WHERE node_id = ? AND user_id = ?`).run(
      JSON.stringify(node),
      node.updated_at_ms,
      nodeId,
      auth.userId,
    );
    sendJson(ctx.res, 200, { ok: true, status: 'idle', node });
  };
  router.post('/api/v1/computers/:nodeId/release', handleReleaseComputerLease);
  router.post('/api/v1/computer/lease/release', handleReleaseComputerLease);

  router.delete('/api/v1/computers/:nodeId', (ctx) => {
    const auth = requireAuth(db, ctx);
    const nodeId = ctx.params.nodeId!;
    if (nodeId === 'sandbox:default') {
      throw new ApiError(400, 'protected_node', 'Built-in sandbox:default node cannot be deleted');
    }
    db.prepare(`DELETE FROM computer_nodes WHERE node_id = ? AND user_id = ?`).run(nodeId, auth.userId);
    sendJson(ctx.res, 200, { ok: true });
  });

  router.get('/api/v1/computers/:nodeId/frame', (ctx) => {
    const auth = requireAuth(db, ctx);
    ensureDefaultComputerNode(auth.userId);
    const row = db
      .prepare(`SELECT node_json FROM computer_nodes WHERE node_id = ? AND user_id = ?`)
      .get(ctx.params.nodeId!, auth.userId) as { node_json: string } | undefined;
    if (!row) throw new ApiError(404, 'computer_not_found', 'Computer node not found');
    const node = JSON.parse(row.node_json) as ComputerNodeDto;
    sendJson(ctx.res, 200, {
      node_id: node.node_id,
      lease_generation: node.lease_generation,
      frame_svg_data_url: node.frame_svg_data_url,
    });
  });

  // ==========================================================================
  // 5. Tailnet Private Device Mesh (`/api/v1/tailnet/*`)
  // ==========================================================================
  const handleTailnetStatus = (ctx: RequestContext): void => {
    const auth = requireAuth(db, ctx);
    const rows = db
      .prepare(`SELECT peer_json FROM tailnet_peers WHERE user_id = ? ORDER BY updated_at_ms DESC`)
      .all(auth.userId) as Array<{ peer_json: string }>;

    const selfPeer: TailnetPeerDescriptor = {
      device_id: `web_${auth.sessionId.slice(-6)}`,
      display_name: 'Telegram Web Session (Primary)',
      ipv4: '100.64.0.1',
      relay_mode: 'direct',
      derp_region: 'primary',
      online: true,
      latency_ms: 1,
      last_seen_ms: Date.now(),
    };

    const peers = rows.map((r) => JSON.parse(r.peer_json) as TailnetPeerDescriptor);
    const dto: TailnetStatusDto = {
      owner_user_id: auth.userId,
      seq: peers.length + 1,
      connected: true,
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
    const body = await readJsonBody<{ device_id?: string; display_name?: string }>(ctx.req);
    const countRow = db
      .prepare(`SELECT COUNT(*) AS cnt FROM tailnet_peers WHERE user_id = ?`)
      .get(auth.userId) as { cnt: number };
    const octet = Math.min(254, Number(countRow.cnt) + 2);
    const peer: TailnetPeerDescriptor = {
      device_id: body.device_id || `dev_${crypto.randomBytes(4).toString('hex')}`,
      display_name: body.display_name?.trim() || `Node #${octet}`,
      ipv4: `100.64.0.${octet}`,
      relay_mode: 'direct',
      derp_region: 'primary',
      online: true,
      latency_ms: 4,
      last_seen_ms: Date.now(),
    };
    db.prepare(`
      INSERT OR REPLACE INTO tailnet_peers (user_id, device_id, peer_json, updated_at_ms)
      VALUES (?, ?, ?, ?)
    `).run(auth.userId, peer.device_id, JSON.stringify(peer), peer.last_seen_ms);

    handleTailnetStatus(ctx);
  });

  router.get('/api/v1/tailnet/stun', (ctx) => {
    const observedAddr = ctx.req.socket.remoteAddress ?? '127.0.0.1';
    const observedPort = ctx.req.socket.remotePort ?? 0;
    sendJson(ctx.res, 200, {
      observed_addr: `${observedAddr}:${observedPort}`,
      derp_region: 'primary',
      server_time_ms: Date.now(),
    });
  });

  // ==========================================================================
  // 6. Stars & TON Wallet Double-Entry Ledger (`/api/v1/wallet*` & `/stars*`)
  // ==========================================================================
  function buildWalletState(userId: number): WalletStateDto {
    const now = Date.now();
    db.prepare(`
      INSERT OR IGNORE INTO wallet_accounts (user_id, stars_balance, ton_nano, updated_at_ms)
      VALUES (?, 500, 1000000000, ?)
    `).run(userId, now);

    const acc = db
      .prepare(`SELECT stars_balance, ton_nano, updated_at_ms FROM wallet_accounts WHERE user_id = ?`)
      .get(userId) as { stars_balance: number; ton_nano: number; updated_at_ms: number };

    const txRows = db
      .prepare(`SELECT tx_json FROM wallet_transactions WHERE user_id = ? ORDER BY created_at_ms DESC LIMIT 50`)
      .all(userId) as Array<{ tx_json: string }>;

    const stars = Number(acc.stars_balance);
    const tonNano = Number(acc.ton_nano);
    return {
      user_id: userId,
      balance: stars,
      stars_balance: stars,
      ton_nano: tonNano,
      ton_balance: (tonNano / 1_000_000_000).toFixed(4),
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
      idempotency_key?: string;
    }>(ctx.req);

    const headerIdem = ctx.req.headers['idempotency-key'];
    const idempotencyKey =
      (typeof headerIdem === 'string' ? headerIdem.trim() : undefined) ?? body.idempotency_key?.trim();
    const cached = lookupWalletIdempotency<WalletStateDto>(db, auth.userId, idempotencyKey, 'wallet_topup');
    if (cached) {
      sendJson(ctx.res, 200, cached);
      return;
    }

    const amount = Math.trunc(Number(body.amount ?? body.amount_stars ?? body.stars ?? 0));
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) {
      throw new ApiError(400, 'invalid_topup_amount', 'Top-up amount must be a positive integer <= 1,000,000');
    }

    const now = Date.now();
    buildWalletState(auth.userId);
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.prepare(`
        UPDATE wallet_accounts SET stars_balance = stars_balance + ?, updated_at_ms = ? WHERE user_id = ?
      `).run(amount, now, auth.userId);

      const tx: WalletTransactionDto = {
        tx_id: `tx_${crypto.randomBytes(6).toString('hex')}`,
        kind: 'topup',
        amount_stars: amount,
        description: `Topped up +${amount} Telegram Stars`,
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
      db.exec('ROLLBACK;');
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
      to_user_id?: number;
      recipient_id?: number;
      chat_id?: number;
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
      (typeof headerIdem === 'string' ? headerIdem.trim() : undefined) ?? body.idempotency_key?.trim();
    const cached = lookupWalletIdempotency<WalletStateDto>(db, auth.userId, idempotencyKey, 'wallet_gift');
    if (cached) {
      sendJson(ctx.res, 200, cached);
      return;
    }

    const recipientId = Number(body.to_user_id ?? body.recipient_id ?? 1002);
    if (!Number.isInteger(recipientId) || recipientId <= 0) {
      throw new ApiError(400, 'invalid_recipient', 'Invalid recipient user ID');
    }
    if (recipientId === auth.userId) {
      throw new ApiError(400, 'self_transfer_not_allowed', 'Cannot transfer or gift Stars to yourself');
    }
    const recipientProfile = getUserProfileDto(db, recipientId);
    if (!recipientProfile) {
      throw new ApiError(404, 'recipient_not_found', 'Recipient user does not exist');
    }

    const amount = Math.trunc(Number(body.amount_stars ?? body.stars ?? body.amount ?? 50));
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ApiError(400, 'invalid_gift_amount', 'Gift amount must be positive');
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
        chat_id: body.chat_id,
        description: `Sent Star Gift (${amount} ⭐) to User #${recipientId}`,
        created_at_ms: now,
      };
      const recipientTx: WalletTransactionDto = {
        tx_id: `tx_${crypto.randomBytes(6).toString('hex')}`,
        kind: 'gift_received',
        amount_stars: amount,
        peer_user_id: auth.userId,
        chat_id: body.chat_id,
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

    if (body.chat_id) {
      createMessageAtomic(db, hub, {
        chatId: Number(body.chat_id),
        senderId: auth.userId,
        content: {
          type: 'Gift',
          data: {
            gift_id: body.gift_id ?? 'gift_star_crystal',
            emoji: body.emoji ?? '💎',
            title: body.title ?? 'Star Crystal Gift',
            stars: amount,
            from_user_id: auth.userId,
            to_user_id: recipientId,
            message: body.message,
          },
        },
      });
    }

    const nextState = buildWalletState(auth.userId);
    storeWalletIdempotency(db, auth.userId, idempotencyKey, 'wallet_gift', nextState);
    sendJson(ctx.res, 200, nextState);
  };
  router.post('/api/v1/wallet/gift', handleGiftOrTransferStars);
  router.post('/api/v1/wallet/transfer', handleGiftOrTransferStars);
  router.post('/api/v1/wallet/stars/send-gift', handleGiftOrTransferStars);
  router.post('/api/v1/wallet/send_stars', handleGiftOrTransferStars);
  router.post('/api/v1/stars/gift', handleGiftOrTransferStars);
}
