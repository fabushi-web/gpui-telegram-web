import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  isReadOnlyRemoteComputerOp,
  type AssistStartResponse,
  type BotComputerProfileDto,
  type BotRegistryEntry,
  type ComputerNodeDto,
  type ComputerRunPolicy,
  type PendingComputerCommandDto,
  type RemoteAssistConfigDto,
  type RemoteComputerOp,
  type RemoteControlMode,
  type RemoteControllerKind,
  type RemoteSessionDto,
  type TailnetRelayMode,
} from '@gpui-telegram/protocol';
import type { ServerConfig } from '../config.js';
import {
  constantTimeHexEquals,
  encryptSecretAtRest,
  sha256Hex,
} from '../utils/crypto.js';

function parsePositiveIdStr(raw: unknown): number | undefined {
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    const n = Number(raw.trim());
    return Number.isSafeInteger(n) && n >= 1 ? n : undefined;
  }
  return undefined;
}
import {
  ApiError,
  authenticateToken,
  extractBearerToken,
  readJsonBody,
  requireAuth,
  sendJson,
  type HttpRouter,
  type RequestContext,
} from '../utils/http.js';
import type { RealtimeGatewayHub } from '../ws/hub.js';

const TEMP_CODE_TTL_MS = 15 * 60_000;
const LOCKOUT_DURATION_MS = 5 * 60_000;
const MAX_FAILED_ATTEMPTS = 5;
const LOCAL_HEARTBEAT_STALE_MS = 90_000;
const CUSTOM_CODE_RE = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9]{8,16}$/;
const MAX_COMMAND_BODY_BYTES = 32 * 1024 * 1024;

const VALID_REMOTE_CONTROL_MODES = new Set<RemoteControlMode>([
  'desktop',
  'terminal',
  'file_transfer',
  'ai_control',
]);

const VALID_RUN_POLICIES = new Set<ComputerRunPolicy>([
  'ask_every_time',
  'allow_read_only',
  'always_allow_authorized',
  'disabled',
]);

function parseOptionalRunPolicy(
  raw: unknown,
  fieldName = 'run_policy',
): ComputerRunPolicy | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' || !VALID_RUN_POLICIES.has(raw.trim() as ComputerRunPolicy)) {
    throw new ApiError(
      400,
      'invalid_run_policy',
      `${fieldName} must be one of: ask_every_time, allow_read_only, always_allow_authorized, disabled`,
    );
  }
  return raw.trim() as ComputerRunPolicy;
}

export interface McpKillSwitchHooks {
  terminateSession(sessionId: string, reason: string): boolean;
  terminateAllForUser(userId: number, reason: string): number;
  terminateByFamilyId(userId: number, familyId: string, reason: string): number;
}

interface QueuedLocalCommand {
  command_id: string;
  id: string;
  node_id: string;
  device_id: string;
  user_id: number;
  caller_label: string;
  operation: Record<string, unknown>;
  op: Record<string, unknown>;
  created_at_ms: number;
}

interface PendingCommandWaiter {
  userId: number;
  nodeId: string;
  resolve: (result: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface PollWaiter {
  userId: number;
  nodeId: string;
  deviceId: string;
  resolve: (commands: QueuedLocalCommand[]) => void;
  timer: NodeJS.Timeout;
}

function generateTempAssistCode(): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const all = letters + digits;
  const bytes = crypto.randomBytes(10);
  const chars: string[] = [
    letters[bytes[0]! % letters.length]!,
    digits[bytes[1]! % digits.length]!,
  ];
  for (let i = 2; i < 8; i++) {
    chars.push(all[bytes[i]! % all.length]!);
  }
  // Fisher-Yates shuffle
  for (let i = chars.length - 1; i > 0; i--) {
    const j = bytes[i % bytes.length]! % (i + 1);
    const tmp = chars[i]!;
    chars[i] = chars[j]!;
    chars[j] = tmp;
  }
  return chars.join('');
}

function generateUnique9DigitAssistId(db: DatabaseSync): string {
  for (let attempt = 0; attempt < 20; attempt++) {
    const num = 100_000_000 + crypto.randomInt(0, 900_000_000);
    const idStr = String(num);
    const exists = db
      .prepare(`SELECT 1 FROM remote_assist_devices WHERE assist_id = ?`)
      .get(idStr);
    if (!exists) return idStr;
  }
  return String(100_000_000 + (Date.now() % 899_999_999));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function isReadOnlyOpObject(op: Record<string, unknown>): boolean {
  const opName = typeof op.op === 'string' ? op.op : typeof op.type === 'string' ? op.type : '';
  if (opName === 'system_info' || opName === 'screenshot' || op.read_only === true) {
    return true;
  }
  if (typeof op.op === 'string') {
    return isReadOnlyRemoteComputerOp(op as unknown as RemoteComputerOp);
  }
  return false;
}

// ============================================================================
// RemoteAssistRuntime (Shared between `remoteAssist.ts` & `officialMcp.ts`)
// ============================================================================

export class RemoteAssistRuntime {
  private mcpKillHooks?: McpKillSwitchHooks;
  private readonly commandQueue = new Map<string, QueuedLocalCommand[]>();
  private readonly commandWaiters = new Map<string, PendingCommandWaiter>();
  private readonly pollWaiters = new Set<PollWaiter>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly hub: RealtimeGatewayHub,
  ) {}

  setMcpKillHooks(hooks: McpKillSwitchHooks): void {
    this.mcpKillHooks = hooks;
  }

  private notifyBanner(ownerUserId: number, state: string, detail: string | null): void {
    try {
      this.hub.sendToUser(ownerUserId, {
        type: 'Update',
        payload: {
          type: 'BotActivityChanged',
          data: {
            chat_id: 0,
            bot_user_id: ownerUserId,
            state,
            detail,
          },
        },
      });
    } catch {
      // Ignore if hub closed
    }
  }

  getOrInitAssistConfig(userId: number, deviceId = 'default'): RemoteAssistConfigDto {
    const cleanDev = deviceId.trim() || 'default';
    const now = Date.now();
    const row = this.db
      .prepare(`SELECT * FROM remote_assist_devices WHERE user_id = ? AND device_id = ?`)
      .get(userId, cleanDev) as Record<string, unknown> | undefined;

    if (!row) {
      const assistId = generateUnique9DigitAssistId(this.db);
      const tempCode = generateTempAssistCode();
      const expiresAt = now + TEMP_CODE_TTL_MS;
      this.db
        .prepare(`
          INSERT INTO remote_assist_devices (
            user_id, device_id, assist_id, allow_assist, code_mode, code_hash, temp_code,
            failed_attempts, locked_until_ms, expires_at_ms, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, 1, 'temporary', ?, ?, 0, NULL, ?, ?, ?)
        `)
        .run(userId, cleanDev, assistId, sha256Hex(tempCode), tempCode, expiresAt, now, now);

      return {
        assist_id: assistId,
        allow_assist: true,
        code_mode: 'temporary',
        current_code: tempCode,
        expires_at_ms: expiresAt,
      };
    }

    const codeMode = String(row.code_mode) === 'custom' ? 'custom' : 'temporary';
    let currentCode = codeMode === 'custom' ? null : (row.temp_code as string | null);
    let expiresAt = row.expires_at_ms !== null ? Number(row.expires_at_ms) : null;

    // Auto-refresh expired temporary code
    if (codeMode === 'temporary' && (!currentCode || !expiresAt || now > expiresAt)) {
      currentCode = generateTempAssistCode();
      expiresAt = now + TEMP_CODE_TTL_MS;
      this.db
        .prepare(`
          UPDATE remote_assist_devices
          SET code_hash = ?, temp_code = ?, expires_at_ms = ?, failed_attempts = 0, locked_until_ms = NULL, updated_at_ms = ?
          WHERE user_id = ? AND device_id = ?
        `)
        .run(sha256Hex(currentCode), currentCode, expiresAt, now, userId, cleanDev);
    }

    return {
      assist_id: String(row.assist_id),
      allow_assist: Boolean(Number(row.allow_assist)),
      code_mode: codeMode,
      current_code: codeMode === 'custom' ? null : currentCode,
      expires_at_ms: codeMode === 'custom' ? null : expiresAt,
    };
  }

  resetAssistCode(userId: number, deviceId = 'default'): RemoteAssistConfigDto {
    const cleanDev = deviceId.trim() || 'default';
    this.getOrInitAssistConfig(userId, cleanDev);
    const now = Date.now();
    const tempCode = generateTempAssistCode();
    const expiresAt = now + TEMP_CODE_TTL_MS;
    this.db
      .prepare(`
        UPDATE remote_assist_devices
        SET code_mode = 'temporary', code_hash = ?, temp_code = ?, expires_at_ms = ?,
            failed_attempts = 0, locked_until_ms = NULL, updated_at_ms = ?
        WHERE user_id = ? AND device_id = ?
      `)
      .run(sha256Hex(tempCode), tempCode, expiresAt, now, userId, cleanDev);
    return this.getOrInitAssistConfig(userId, cleanDev);
  }

  setCustomAssistCode(userId: number, code: string, deviceId = 'default'): RemoteAssistConfigDto {
    const trimmed = code.trim();
    if (!CUSTOM_CODE_RE.test(trimmed)) {
      throw new ApiError(
        400,
        'invalid_assist_code',
        'Access code must be 8-16 ASCII alphanumeric characters with at least one letter and one digit',
      );
    }
    const cleanDev = deviceId.trim() || 'default';
    this.getOrInitAssistConfig(userId, cleanDev);
    const now = Date.now();
    this.db
      .prepare(`
        UPDATE remote_assist_devices
        SET code_mode = 'custom', code_hash = ?, temp_code = NULL, expires_at_ms = NULL,
            failed_attempts = 0, locked_until_ms = NULL, updated_at_ms = ?
        WHERE user_id = ? AND device_id = ?
      `)
      .run(sha256Hex(trimmed), now, userId, cleanDev);
    return this.getOrInitAssistConfig(userId, cleanDev);
  }

  setAllowAssist(userId: number, allow: boolean, deviceId = 'default'): RemoteAssistConfigDto {
    const cleanDev = deviceId.trim() || 'default';
    this.getOrInitAssistConfig(userId, cleanDev);
    const now = Date.now();
    this.db
      .prepare(`
        UPDATE remote_assist_devices SET allow_assist = ?, updated_at_ms = ?
        WHERE user_id = ? AND device_id = ?
      `)
      .run(allow ? 1 : 0, now, userId, cleanDev);

    if (!allow) {
      if (cleanDev === 'default') {
        this.db
          .prepare(`
            UPDATE remote_sessions
            SET ended_at_ms = ?, end_reason = 'assist_disabled'
            WHERE owner_user_id = ? AND controller_kind = 'assist_guest' AND ended_at_ms IS NULL
          `)
          .run(now, userId);
      } else {
        this.db
          .prepare(`
            UPDATE remote_sessions
            SET ended_at_ms = ?, end_reason = 'assist_disabled'
            WHERE owner_user_id = ? AND target_device_id = ? AND controller_kind = 'assist_guest' AND ended_at_ms IS NULL
          `)
          .run(now, userId, cleanDev);
      }
      this.notifyBanner(userId, 'idle', 'remote_control_ended');
    }

    return this.getOrInitAssistConfig(userId, cleanDev);
  }

  registerRemoteSession(params: {
    sessionId: string;
    ownerUserId: number;
    controllerUserId?: number | null;
    controllerKind: RemoteControllerKind;
    controllerName: string;
    controllerPlatform?: string;
    controllerId: string;
    targetNodeId: string;
    targetDeviceId?: string;
    mode: RemoteControlMode;
    relayMode?: TailnetRelayMode;
    tempRelayTokenHash?: string | null;
  }): RemoteSessionDto {
    const now = Date.now();
    const relayMode = params.relayMode ?? 'http_fallback';
    this.db
      .prepare(`
        INSERT OR REPLACE INTO remote_sessions (
          session_id, owner_user_id, controller_user_id, controller_kind, controller_name,
          controller_platform, controller_id, target_node_id, target_device_id, mode,
          active_tool, relay_mode, rtt_ms, fps, temp_relay_token_hash, started_at_ms, last_activity_ms,
          ended_at_ms, end_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?, ?, NULL, NULL)
      `)
      .run(
        params.sessionId,
        params.ownerUserId,
        params.controllerUserId ?? null,
        params.controllerKind,
        params.controllerName,
        params.controllerPlatform ?? '',
        params.controllerId,
        params.targetNodeId,
        params.targetDeviceId ?? '',
        params.mode,
        relayMode,
        params.tempRelayTokenHash ?? null,
        now,
        now,
      );

    const bannerPrefix =
      params.controllerKind === 'ai_mcp'
        ? '本机被控中 (AI MCP)'
        : params.controllerKind === 'assist_guest'
          ? '本机被控中 (远程协助)'
          : '本机被控中';
    this.notifyBanner(params.ownerUserId, 'controlling', `${bannerPrefix}: ${params.controllerName}`);

    return {
      session_id: params.sessionId,
      controller_kind: params.controllerKind,
      controller_name: params.controllerName,
      controller_platform: params.controllerPlatform ?? '',
      controller_id: params.controllerId,
      target_node_id: params.targetNodeId,
      target_device_id: params.targetDeviceId ?? '',
      mode: params.mode,
      started_at_ms: now,
      last_activity_ms: now,
      active_tool: null,
      relay_mode: relayMode,
      rtt_ms: null,
      fps: null,
    };
  }

  listActiveSessions(ownerUserId: number): RemoteSessionDto[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM remote_sessions
         WHERE owner_user_id = ? AND ended_at_ms IS NULL
         ORDER BY started_at_ms DESC`,
      )
      .all(ownerUserId) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      session_id: String(r.session_id),
      controller_kind: String(r.controller_kind) as RemoteControllerKind,
      controller_name: String(r.controller_name),
      controller_platform: String(r.controller_platform ?? ''),
      controller_id: String(r.controller_id ?? ''),
      target_node_id: String(r.target_node_id),
      target_device_id: String(r.target_device_id ?? ''),
      mode: String(r.mode) as RemoteControlMode,
      started_at_ms: Number(r.started_at_ms),
      last_activity_ms: Number(r.last_activity_ms),
      active_tool: (r.active_tool as string | null) ?? null,
      relay_mode: String(r.relay_mode ?? 'http_fallback') as TailnetRelayMode,
      rtt_ms: r.rtt_ms !== null ? Number(r.rtt_ms) : null,
      fps: r.fps !== null ? Number(r.fps) : null,
    }));
  }

  disconnectSession(ownerUserId: number, sessionId: string, reason = 'user_disconnected'): boolean {
    const now = Date.now();
    const res = this.db
      .prepare(
        `UPDATE remote_sessions SET ended_at_ms = ?, end_reason = ?
         WHERE owner_user_id = ? AND session_id = ? AND ended_at_ms IS NULL`,
      )
      .run(now, reason, ownerUserId, sessionId);
    const mcpClosed = this.mcpKillHooks?.terminateSession(sessionId, reason) ?? false;
    const closed = Number(res.changes ?? 0) > 0 || mcpClosed;
    if (closed) {
      this.notifyBanner(ownerUserId, 'idle', 'remote_control_ended');
    }
    return closed;
  }

  disconnectByFamilyId(ownerUserId: number, familyId: string, reason = 'grant_revoked'): number {
    const now = Date.now();
    const res = this.db
      .prepare(
        `UPDATE remote_sessions SET ended_at_ms = ?, end_reason = ?
         WHERE owner_user_id = ? AND controller_id = ? AND ended_at_ms IS NULL`,
      )
      .run(now, reason, ownerUserId, familyId);
    const mcpCount = this.mcpKillHooks?.terminateByFamilyId(ownerUserId, familyId, reason) ?? 0;
    const total = Math.max(Number(res.changes ?? 0), mcpCount);
    if (total > 0) {
      this.notifyBanner(ownerUserId, 'idle', 'remote_control_ended');
    }
    return total;
  }

  disconnectAll(ownerUserId: number, reason = 'user_kill_switch'): number {
    const now = Date.now();
    const res = this.db
      .prepare(
        `UPDATE remote_sessions SET ended_at_ms = ?, end_reason = ?
         WHERE owner_user_id = ? AND ended_at_ms IS NULL`,
      )
      .run(now, reason, ownerUserId);
    const dbCount = Number(res.changes ?? 0);

    // Terminate active Official MCP sessions & mark seen tokens terminated WITHOUT deleting SQLite grants!
    const mcpKilled = this.mcpKillHooks?.terminateAllForUser(ownerUserId, reason) ?? 0;

    // Abort all pending local computer commands for ownerUserId
    for (const [cmdId, waiter] of Array.from(this.commandWaiters.entries())) {
      if (waiter.userId === ownerUserId) {
        clearTimeout(waiter.timer);
        this.commandWaiters.delete(cmdId);
        waiter.reject(new ApiError(410, 'command_aborted', 'Command aborted by emergency kill switch'));
      }
    }

    this.notifyBanner(ownerUserId, 'idle', 'remote_control_ended');
    return Math.max(dbCount, mcpKilled);
  }

  // ==========================================================================
  // Local Computer Node & Command Queue Broker
  // ==========================================================================

  listComputersForUser(userId: number): ComputerNodeDto[] {
    const rows = this.db
      .prepare(`SELECT node_json FROM computer_nodes WHERE user_id = ? ORDER BY updated_at_ms ASC`)
      .all(userId) as Array<{ node_json: string }>;
    const now = Date.now();
    return rows.map((r) => {
      const node = JSON.parse(r.node_json) as ComputerNodeDto & { last_heartbeat_ms?: number };
      if (node.kind === 'local_device') {
        const lastHb = Number(node.last_heartbeat_ms ?? node.updated_at_ms ?? 0);
        node.online = now - lastHb <= LOCAL_HEARTBEAT_STALE_MS;
      }
      return node;
    });
  }

  private getQueueKey(userId: number, nodeId: string): string {
    return `${userId}:${nodeId}`;
  }

  private deliverToPollWaiter(userId: number, nodeId: string, deviceId: string, cmd: QueuedLocalCommand): boolean {
    for (const waiter of Array.from(this.pollWaiters)) {
      if (
        waiter.userId === userId &&
        (waiter.nodeId === nodeId || (deviceId && waiter.deviceId === deviceId))
      ) {
        clearTimeout(waiter.timer);
        this.pollWaiters.delete(waiter);
        waiter.resolve([cmd]);
        return true;
      }
    }
    return false;
  }

  pollLocalCommands(
    userId: number,
    nodeId: string,
    deviceId: string,
    timeoutMs: number,
  ): Promise<QueuedLocalCommand[]> {
    const qKey = this.getQueueKey(userId, nodeId);
    const existing = this.commandQueue.get(qKey);
    if (existing && existing.length > 0) {
      this.commandQueue.set(qKey, []);
      return Promise.resolve(existing);
    }

    const clamped = Math.max(0, Math.min(25_000, Math.floor(timeoutMs)));
    if (clamped <= 0) {
      return Promise.resolve([]);
    }

    return new Promise((resolve) => {
      const waiter: PollWaiter = {
        userId,
        nodeId,
        deviceId,
        resolve,
        timer: setTimeout(() => {
          this.pollWaiters.delete(waiter);
          resolve([]);
        }, clamped),
      };
      waiter.timer.unref();
      this.pollWaiters.add(waiter);
    });
  }

  completeLocalCommand(
    userId: number,
    commandId: string,
    resultPayload: Record<string, unknown>,
  ): boolean {
    const row = this.db
      .prepare(`SELECT cmd_json FROM computer_commands WHERE command_id = ? AND user_id = ?`)
      .get(commandId, userId) as { cmd_json: string } | undefined;

    if (row) {
      const parsed = JSON.parse(row.cmd_json) as PendingComputerCommandDto & { result?: unknown };
      parsed.status = 'completed';
      parsed.result = resultPayload;
      this.db
        .prepare(`UPDATE computer_commands SET cmd_json = ? WHERE command_id = ?`)
        .run(JSON.stringify(parsed), commandId);
    }

    const waiter = this.commandWaiters.get(commandId);
    if (waiter && waiter.userId === userId) {
      clearTimeout(waiter.timer);
      this.commandWaiters.delete(commandId);
      waiter.resolve(resultPayload);
      return true;
    }

    return Boolean(row);
  }

  async executeComputerCommand(
    userId: number,
    nodeId: string,
    callerLabel: string,
    operation: Record<string, unknown>,
    opts?: { timeoutMs?: number; skipApprovalCheck?: boolean },
  ): Promise<
    | { status: 'queued_for_approval'; command_id: string; command: PendingComputerCommandDto }
    | { status: 'completed'; command_id: string; node_id: string; result: Record<string, unknown> }
  > {
    const row = this.db
      .prepare(`SELECT node_json FROM computer_nodes WHERE node_id = ? AND user_id = ?`)
      .get(nodeId, userId) as { node_json: string } | undefined;
    if (!row) {
      throw new ApiError(404, 'computer_not_found', `Computer node '${nodeId}' not found`);
    }

    const node = JSON.parse(row.node_json) as ComputerNodeDto & {
      device_id?: string;
      last_heartbeat_ms?: number;
    };
    const now = Date.now();
    if (node.kind === 'local_device') {
      const lastHb = Number(node.last_heartbeat_ms ?? node.updated_at_ms ?? 0);
      node.online = now - lastHb <= LOCAL_HEARTBEAT_STALE_MS;
    }

    if (node.run_policy === 'disabled') {
      throw new ApiError(403, 'computer_disabled', 'Computer RunPolicy is disabled');
    }

    if (!node.online) {
      throw new ApiError(503, 'no_host_online', `Target computer host '${nodeId}' is offline`);
    }

    const isReadOnly = isReadOnlyOpObject(operation);
    if (
      !opts?.skipApprovalCheck &&
      (node.run_policy === 'ask_every_time' ||
        (node.run_policy === 'allow_read_only' && !isReadOnly))
    ) {
      const cmdId = `ccmd_${crypto.randomBytes(6).toString('hex')}`;
      const pending: PendingComputerCommandDto = {
        command_id: cmdId,
        node_id: nodeId,
        caller_label: callerLabel,
        operation,
        status: 'pending',
        created_at_ms: now,
      };
      this.db
        .prepare(`
          INSERT INTO computer_commands (command_id, user_id, node_id, cmd_json, created_at_ms)
          VALUES (?, ?, ?, ?, ?)
        `)
        .run(cmdId, userId, nodeId, JSON.stringify(pending), now);
      return { status: 'queued_for_approval', command_id: cmdId, command: pending };
    }

    const cmdId = `ccmd_${crypto.randomBytes(6).toString('hex')}`;
    const cmdRecord: PendingComputerCommandDto = {
      command_id: cmdId,
      node_id: nodeId,
      caller_label: callerLabel,
      operation,
      status: 'approved',
      created_at_ms: now,
    };
    this.db
      .prepare(`
        INSERT INTO computer_commands (command_id, user_id, node_id, cmd_json, created_at_ms)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(cmdId, userId, nodeId, JSON.stringify(cmdRecord), now);

    const queued: QueuedLocalCommand = {
      command_id: cmdId,
      id: cmdId,
      node_id: nodeId,
      device_id: node.device_id ?? nodeId.replace(/^local:/, ''),
      user_id: userId,
      caller_label: callerLabel,
      operation,
      op: operation,
      created_at_ms: now,
    };

    const timeoutMs = Math.max(1000, Math.min(30_000, Math.floor(opts?.timeoutMs ?? 15_000)));
    const resultPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.commandWaiters.delete(cmdId);
        reject(new ApiError(504, 'command_timeout', `Computer command '${cmdId}' timed out`));
      }, timeoutMs);
      timer.unref();
      this.commandWaiters.set(cmdId, { userId, nodeId, resolve, reject, timer });
    });

    const delivered = this.deliverToPollWaiter(userId, nodeId, queued.device_id, queued);
    if (!delivered) {
      const qKey = this.getQueueKey(userId, nodeId);
      const q = this.commandQueue.get(qKey) ?? [];
      q.push(queued);
      this.commandQueue.set(qKey, q);
    }

    const result = await resultPromise;
    return {
      status: 'completed',
      command_id: cmdId,
      node_id: nodeId,
      result,
    };
  }

  requestHumanTakeover(
    ownerUserId: number,
    nodeId: string,
    opts?: {
      reason?: string;
      instructions?: string;
      sessionId?: string;
      clientName?: string;
    },
  ): { node: ComputerNodeDto; disconnectedGuests: number } | null {
    const cleanNodeId = nodeId.trim();
    if (!cleanNodeId) return null;

    const now = Date.now();
    let updatedNode: ComputerNodeDto | null = null;
    let disconnectedGuests = 0;

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const row = this.db
        .prepare(`SELECT node_json FROM computer_nodes WHERE node_id = ? AND user_id = ?`)
        .get(cleanNodeId, ownerUserId) as { node_json: string } | undefined;
      if (!row) {
        this.db.exec('ROLLBACK;');
        return null;
      }

      const node = JSON.parse(row.node_json) as ComputerNodeDto;
      node.lease_generation =
        (Number.isInteger(node.lease_generation) ? node.lease_generation : 0) + 1;
      node.lease_state = 'human_takeover';
      delete node.frame_svg_data_url;
      node.updated_at_ms = now;

      this.db
        .prepare(
          `UPDATE computer_nodes SET node_json = ?, updated_at_ms = ? WHERE node_id = ? AND user_id = ?`,
        )
        .run(JSON.stringify(node), now, cleanNodeId, ownerUserId);

      // Disconnect any active remote assist guest sessions targeting this node
      const guestRes = this.db
        .prepare(
          `UPDATE remote_sessions
           SET ended_at_ms = ?, end_reason = 'human_takeover'
           WHERE owner_user_id = ? AND target_node_id = ? AND controller_kind = 'assist_guest' AND ended_at_ms IS NULL`,
        )
        .run(now, ownerUserId, cleanNodeId);
      disconnectedGuests = Number(guestRes.changes ?? 0);

      this.db.exec('COMMIT;');
      updatedNode = node;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // Already rolled back
      }
      throw err;
    }

    // Abort any pending in-flight local computer commands for this node
    for (const [cmdId, waiter] of Array.from(this.commandWaiters.entries())) {
      if (waiter.userId === ownerUserId && waiter.nodeId === cleanNodeId) {
        clearTimeout(waiter.timer);
        this.commandWaiters.delete(cmdId);
        waiter.reject(
          new ApiError(410, 'human_takeover', 'Computer lease transferred to human operator'),
        );
      }
    }
    this.commandQueue.delete(this.getQueueKey(ownerUserId, cleanNodeId));

    // Emit real WebSocket takeover alert/banner to owner (upstream official_mcp.rs parity)
    this.notifyBanner(
      ownerUserId,
      `human_takeover_requested:${cleanNodeId}`,
      JSON.stringify({
        session_id: opts?.sessionId ?? '',
        node_id: cleanNodeId,
        client_name: opts?.clientName ?? '',
        new_generation: updatedNode.lease_generation,
        lease_state: updatedNode.lease_state,
        reason: opts?.reason ?? '',
        instructions: opts?.instructions ?? '',
        disconnected_guests: disconnectedGuests,
      }),
    );

    return { node: updatedNode, disconnectedGuests };
  }

  enqueueApprovedCommand(userId: number, cmd: PendingComputerCommandDto): boolean {
    const nodeRow = this.db
      .prepare(`SELECT node_json FROM computer_nodes WHERE node_id = ? AND user_id = ?`)
      .get(cmd.node_id, userId) as { node_json: string } | undefined;
    if (!nodeRow) return false;

    const node = JSON.parse(nodeRow.node_json) as ComputerNodeDto & { device_id?: string };
    const queued: QueuedLocalCommand = {
      command_id: cmd.command_id,
      id: cmd.command_id,
      node_id: cmd.node_id,
      device_id: node.device_id ?? cmd.node_id.replace(/^local:/, ''),
      user_id: userId,
      caller_label: cmd.caller_label,
      operation: cmd.operation,
      op: cmd.operation,
      created_at_ms: cmd.created_at_ms,
    };

    const delivered = this.deliverToPollWaiter(userId, cmd.node_id, queued.device_id, queued);
    if (!delivered) {
      const qKey = this.getQueueKey(userId, cmd.node_id);
      const q = this.commandQueue.get(qKey) ?? [];
      q.push(queued);
      this.commandQueue.set(qKey, q);
    }
    return true;
  }

  reset(): void {
    for (const w of this.commandWaiters.values()) {
      clearTimeout(w.timer);
      w.reject(new ApiError(503, 'server_reset', 'Server reset'));
    }
    this.commandWaiters.clear();
    for (const p of this.pollWaiters) {
      clearTimeout(p.timer);
      p.resolve([]);
    }
    this.pollWaiters.clear();
    this.commandQueue.clear();
  }

  close(): void {
    this.reset();
  }
}

export function createRemoteAssistRuntime(
  db: DatabaseSync,
  hub: RealtimeGatewayHub,
): RemoteAssistRuntime {
  return new RemoteAssistRuntime(db, hub);
}

// ============================================================================
// Route Registration (MUST register BEFORE `workspace.ts`!)
// ============================================================================

export function registerRemoteAssistAndComputerRoutes(
  router: HttpRouter,
  db: DatabaseSync,
  config: ServerConfig,
  hub: RealtimeGatewayHub,
  runtime: RemoteAssistRuntime,
): void {
  // ==========================================================================
  // 1. UU-Parity Remote Assist Endpoints (`/api/v1/remote/assist/*`)
  // ==========================================================================
  const resolveDeviceId = (ctx: RequestContext, bodyDeviceId?: unknown): string => {
    if (typeof bodyDeviceId === 'string' && bodyDeviceId.trim()) return bodyDeviceId.trim();
    const q = ctx.query.get('device_id')?.trim();
    if (q) return q;
    const hdr = ctx.req.headers['x-device-id'];
    if (typeof hdr === 'string' && hdr.trim()) return hdr.trim();
    return 'default';
  };

  router.get('/api/v1/remote/assist/info', (ctx) => {
    const auth = requireAuth(db, ctx);
    const deviceId = resolveDeviceId(ctx);
    sendJson(ctx.res, 200, runtime.getOrInitAssistConfig(auth.userId, deviceId));
  });

  router.post('/api/v1/remote/assist/reset-code', async (ctx) => {
    const auth = requireAuth(db, ctx);
    let body: { device_id?: string } = {};
    try {
      body = await readJsonBody<{ device_id?: string }>(ctx.req);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 400)) throw err;
    }
    const deviceId = resolveDeviceId(ctx, body.device_id);
    sendJson(ctx.res, 200, runtime.resetAssistCode(auth.userId, deviceId));
  });

  router.post('/api/v1/remote/assist/set-code', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{ code?: string; device_id?: string }>(ctx.req);
    if (typeof body.code !== 'string') {
      throw new ApiError(400, 'invalid_assist_code', 'code must be a string');
    }
    const deviceId = resolveDeviceId(ctx, body.device_id);
    sendJson(ctx.res, 200, runtime.setCustomAssistCode(auth.userId, body.code, deviceId));
  });

  router.post('/api/v1/remote/assist/allow', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{ allow_assist?: unknown; device_id?: string }>(ctx.req);
    if (typeof body.allow_assist !== 'boolean') {
      throw new ApiError(400, 'invalid_allow_assist', 'allow_assist must be a boolean');
    }
    const deviceId = resolveDeviceId(ctx, body.device_id);
    sendJson(ctx.res, 200, runtime.setAllowAssist(auth.userId, body.allow_assist, deviceId));
  });

  router.post('/api/v1/remote/assist/start', async (ctx) => {
    const bearer = extractBearerToken(ctx.req, ctx.query);
    const guestSession = authenticateToken(db, bearer);

    const body = await readJsonBody<{
      assist_id?: string;
      access_code?: string;
      requester_device_id?: string | null;
      requester_name?: string | null;
      requester_platform?: string | null;
      mode?: RemoteControlMode;
    }>(ctx.req);

    const cleanAssistId = (typeof body.assist_id === 'string' ? body.assist_id : '').replace(/\D/g, '');
    const accessCode = typeof body.access_code === 'string' ? body.access_code.trim() : '';
    if (!cleanAssistId) {
      throw new ApiError(400, 'invalid_assist_id', 'assist_id is required');
    }

    let mode: RemoteControlMode = 'desktop';
    if (body.mode !== undefined && body.mode !== null) {
      if (
        typeof body.mode !== 'string' ||
        !VALID_REMOTE_CONTROL_MODES.has(body.mode.trim() as RemoteControlMode)
      ) {
        throw new ApiError(
          400,
          'invalid_mode',
          'mode must be one of: desktop, terminal, file_transfer, ai_control',
        );
      }
      mode = body.mode.trim() as RemoteControlMode;
    }

    const dev = db
      .prepare(`SELECT * FROM remote_assist_devices WHERE assist_id = ?`)
      .get(cleanAssistId) as Record<string, unknown> | undefined;
    if (!dev) {
      throw new ApiError(404, 'assist_not_found', `Assist ID ${cleanAssistId} not found`);
    }

    if (!Number(dev.allow_assist)) {
      throw new ApiError(403, 'assist_disabled', 'Remote assist is disabled on the target device');
    }

    const now = Date.now();
    const lockedUntil = dev.locked_until_ms !== null ? Number(dev.locked_until_ms) : null;
    if (lockedUntil && now < lockedUntil) {
      throw new ApiError(429, 'assist_rate_limited', 'Too many failed access code attempts', {
        locked_until_ms: lockedUntil,
      });
    }

    const codeMode = String(dev.code_mode);
    const expiresAt = dev.expires_at_ms !== null ? Number(dev.expires_at_ms) : null;
    if (codeMode === 'temporary' && expiresAt && now > expiresAt) {
      throw new ApiError(401, 'assist_code_expired', 'Temporary access code has expired');
    }

    const expectedHash = String(dev.code_hash ?? '');
    const providedHash = sha256Hex(accessCode);
    if (!accessCode || !constantTimeHexEquals(providedHash, expectedHash)) {
      const nextAttempts = Number(dev.failed_attempts ?? 0) + 1;
      if (nextAttempts >= MAX_FAILED_ATTEMPTS) {
        const nextLock = now + LOCKOUT_DURATION_MS;
        db.prepare(`
          UPDATE remote_assist_devices SET failed_attempts = ?, locked_until_ms = ?, updated_at_ms = ?
          WHERE assist_id = ?
        `).run(nextAttempts, nextLock, now, cleanAssistId);
        throw new ApiError(429, 'assist_rate_limited', 'Access code locked for 5 minutes due to repeated failures', {
          locked_until_ms: nextLock,
        });
      }
      db.prepare(`
        UPDATE remote_assist_devices SET failed_attempts = ?, updated_at_ms = ?
        WHERE assist_id = ?
      `).run(nextAttempts, now, cleanAssistId);
      throw new ApiError(401, 'invalid_assist_code', 'Invalid remote assist access code', {
        remaining_attempts: MAX_FAILED_ATTEMPTS - nextAttempts,
      });
    }

    // Valid code -> reset failure counter & create remote assist session
    db.prepare(`
      UPDATE remote_assist_devices SET failed_attempts = 0, locked_until_ms = NULL, updated_at_ms = ?
      WHERE assist_id = ?
    `).run(now, cleanAssistId);

    const ownerUserId = Number(dev.user_id);
    const targetDeviceId = String(dev.device_id);
    const targetNodeId = `local:${targetDeviceId}`;
    const sessionId = `rassist_${crypto.randomBytes(16).toString('hex')}`;
    const tempRelayToken = `fbrelay_${crypto.randomBytes(24).toString('hex')}`;
    const sessionExpiresAt = now + 2 * 60 * 60_000;

    runtime.registerRemoteSession({
      sessionId,
      ownerUserId,
      controllerUserId: guestSession?.userId ?? null,
      controllerKind: 'assist_guest',
      controllerName:
        (typeof body.requester_name === 'string' && body.requester_name.trim()) ||
        (guestSession ? `@${guestSession.username}` : 'Remote Guest'),
      controllerPlatform: typeof body.requester_platform === 'string' ? body.requester_platform : 'web',
      controllerId:
        (typeof body.requester_device_id === 'string' && body.requester_device_id.trim()) ||
        (guestSession ? `user:${guestSession.userId}` : 'guest'),
      targetNodeId,
      targetDeviceId,
      mode,
      tempRelayTokenHash: sha256Hex(tempRelayToken),
    });

    const resp: AssistStartResponse = {
      session_id: sessionId,
      target_node_id: targetNodeId,
      target_device_id: targetDeviceId,
      temp_relay_token: tempRelayToken,
      requires_host_confirm: false,
      expires_at_ms: sessionExpiresAt,
    };
    sendJson(ctx.res, 200, resp);
  });

  // ==========================================================================
  // 2. Active Remote Sessions & Emergency Kill Switch (`/api/v1/remote/sessions*`)
  // ==========================================================================
  router.get('/api/v1/remote/sessions', (ctx) => {
    const auth = requireAuth(db, ctx);
    const sessions = runtime.listActiveSessions(auth.userId);
    sendJson(ctx.res, 200, { sessions });
  });

  router.post('/api/v1/remote/sessions/disconnect', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{ session_id?: string }>(ctx.req);
    const sessionId = typeof body.session_id === 'string' ? body.session_id.trim() : '';
    if (!sessionId) throw new ApiError(400, 'invalid_session_id', 'session_id is required');
    const disconnected = runtime.disconnectSession(auth.userId, sessionId, 'user_disconnected');
    sendJson(ctx.res, 200, { disconnected, session_id: sessionId });
  });

  router.post('/api/v1/remote/sessions/disconnect-all', (ctx) => {
    const startHr = process.hrtime.bigint();
    const auth = requireAuth(db, ctx);
    const disconnectedCount = runtime.disconnectAll(auth.userId, 'user_kill_switch');
    const elapsedUs = Number((process.hrtime.bigint() - startHr) / 1000n);
    sendJson(ctx.res, 200, {
      disconnected_count: disconnectedCount,
      kill_switch: true,
      elapsed_us: elapsedUs,
      latency_ms: Number((elapsedUs / 1000).toFixed(3)),
    });
  });

  // ==========================================================================
  // 3. WebRTC Signaling Relay (`/api/v1/remote/webrtc/signal`)
  // ==========================================================================
  router.post('/api/v1/remote/webrtc/signal', async (ctx) => {
    const rawToken = extractBearerToken(ctx.req, ctx.query);
    if (!rawToken) {
      throw new ApiError(401, 'unauthorized', 'Bearer token or temp_relay_token is required');
    }

    const body = await readJsonBody<{
      sender_device_id?: string;
      target_device_id?: string | null;
      session_id?: string | null;
      frame?: unknown;
    }>(ctx.req);

    const userSession = authenticateToken(db, rawToken);
    let targetOwnerUserId: number;

    if (userSession) {
      targetOwnerUserId = userSession.userId;
    } else if (rawToken.startsWith('fbrelay_')) {
      const sid = typeof body.session_id === 'string' ? body.session_id.trim() : '';
      if (!sid) {
        throw new ApiError(400, 'missing_session_id', 'session_id is required when authenticating with a relay token');
      }
      const sessRow = db
        .prepare(
          `SELECT owner_user_id, temp_relay_token_hash FROM remote_sessions
           WHERE session_id = ? AND ended_at_ms IS NULL`,
        )
        .get(sid) as { owner_user_id: number; temp_relay_token_hash: string | null } | undefined;
      if (
        !sessRow ||
        !sessRow.temp_relay_token_hash ||
        !constantTimeHexEquals(sha256Hex(rawToken), sessRow.temp_relay_token_hash)
      ) {
        throw new ApiError(401, 'invalid_relay_token', 'Invalid or disconnected remote assist relay token');
      }
      targetOwnerUserId = Number(sessRow.owner_user_id);
      db.prepare(`UPDATE remote_sessions SET last_activity_ms = ? WHERE session_id = ?`).run(
        Date.now(),
        sid,
      );
    } else {
      throw new ApiError(401, 'unauthorized', 'Invalid Bearer token');
    }

    const senderDeviceId = typeof body.sender_device_id === 'string' ? body.sender_device_id.trim() : '';
    if (!senderDeviceId) {
      throw new ApiError(400, 'invalid_sender_device_id', 'sender_device_id is required');
    }
    if (!isPlainObject(body.frame)) {
      throw new ApiError(400, 'invalid_frame', 'frame must be a JSON object');
    }

    hub.sendToUser(targetOwnerUserId, {
      type: 'Update',
      payload: {
        type: 'CallSignal',
        data: {
          call_id: (typeof body.session_id === 'string' && body.session_id) || senderDeviceId,
          from_user_id: userSession?.userId ?? 0,
          signal: {
            kind: 'remote_webrtc',
            sender_device_id: senderDeviceId,
            target_device_id: typeof body.target_device_id === 'string' ? body.target_device_id : null,
            session_id: typeof body.session_id === 'string' ? body.session_id : null,
            frame: body.frame,
          },
        },
      },
    });

    sendJson(ctx.res, 200, { relayed: true });
  });

  // ==========================================================================
  // 4. Local Computer Agent Bridge (`/api/v1/computers/*` — static BEFORE `:nodeId`!)
  // ==========================================================================
  const handleListComputers = (ctx: RequestContext): void => {
    const auth = requireAuth(db, ctx);
    const computers = runtime.listComputersForUser(auth.userId);
    const cmdRows = db
      .prepare(`SELECT cmd_json FROM computer_commands WHERE user_id = ? ORDER BY created_at_ms DESC LIMIT 50`)
      .all(auth.userId) as Array<{ cmd_json: string }>;
    const commands = cmdRows.map((r) => JSON.parse(r.cmd_json) as PendingComputerCommandDto);

    sendJson(ctx.res, 200, {
      computers,
      pending_approvals: commands.filter((c) => c.status === 'pending'),
    });
  };
  router.get('/api/v1/computers', handleListComputers);
  router.get('/api/v1/computer/state', handleListComputers);

  router.post('/api/v1/computers/local/register', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      node_id?: string;
      device_id?: string;
      display_name?: string;
      hostname?: string;
      ip_address?: string;
      os_name?: string;
      platform?: string;
      resolution?: string;
      capabilities?: string[];
      run_policy?: ComputerRunPolicy;
    }>(ctx.req);

    const deviceId = (
      typeof body.device_id === 'string' && body.device_id.trim()
        ? body.device_id.trim()
        : typeof body.node_id === 'string' && body.node_id.trim()
          ? body.node_id.trim().replace(/^local:/, '')
          : ''
    );
    if (!deviceId) {
      throw new ApiError(400, 'invalid_device_id', 'device_id or node_id is required');
    }

    const nodeId =
      typeof body.node_id === 'string' && body.node_id.trim()
        ? body.node_id.trim()
        : `local:${deviceId}`;
    const existingRow = db
      .prepare(`SELECT node_json FROM computer_nodes WHERE node_id = ? AND user_id = ?`)
      .get(nodeId, auth.userId) as { node_json: string } | undefined;
    const existing = existingRow ? (JSON.parse(existingRow.node_json) as ComputerNodeDto) : null;

    const now = Date.now();
    const displayName =
      (typeof body.display_name === 'string' && body.display_name.trim()) ||
      (typeof body.hostname === 'string' && body.hostname.trim()) ||
      existing?.display_name ||
      deviceId;
    const osName =
      (typeof body.os_name === 'string' && body.os_name.trim()) ||
      (typeof body.platform === 'string' && body.platform.trim()) ||
      existing?.os_name ||
      'unknown';

    const node: ComputerNodeDto & {
      device_id: string;
      hostname?: string;
      platform?: string;
      capabilities?: string[];
      last_heartbeat_ms: number;
    } = {
      node_id: nodeId,
      device_id: deviceId,
      display_name: displayName,
      hostname: typeof body.hostname === 'string' ? body.hostname.trim() : displayName,
      platform: typeof body.platform === 'string' ? body.platform.trim() : osName,
      capabilities: Array.isArray(body.capabilities)
        ? body.capabilities.filter((c): c is string => typeof c === 'string')
        : [],
      kind: 'local_device',
      host: typeof body.ip_address === 'string' ? body.ip_address.trim() : '',
      os_name: osName,
      resolution: typeof body.resolution === 'string' ? body.resolution.trim() : '1920x1080',
      online: true,
      run_policy: parseOptionalRunPolicy(body.run_policy) ?? existing?.run_policy ?? 'allow_read_only',
      has_saved_credential: false,
      lease_state: existing?.lease_state ?? 'idle',
      lease_generation: existing?.lease_generation ?? 1,
      last_heartbeat_ms: now,
      updated_at_ms: now,
    };

    db.prepare(`
      INSERT OR REPLACE INTO computer_nodes (node_id, user_id, node_json, encrypted_secret, secret_nonce, updated_at_ms)
      VALUES (?, ?, ?, NULL, NULL, ?)
    `).run(nodeId, auth.userId, JSON.stringify(node), now);

    sendJson(ctx.res, existing ? 200 : 201, node);
  });

  const handleLocalPoll = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    let body: { node_id?: string; device_id?: string; timeout_ms?: number } = {};
    if (ctx.method === 'POST') {
      try {
        body = await readJsonBody<{ node_id?: string; device_id?: string; timeout_ms?: number }>(ctx.req);
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 400)) throw err;
      }
    }

    const deviceId =
      (typeof body.device_id === 'string' && body.device_id.trim()) ||
      ctx.query.get('device_id')?.trim() ||
      (typeof ctx.req.headers['x-device-id'] === 'string' ? ctx.req.headers['x-device-id'].trim() : '') ||
      '';
    const nodeId =
      (typeof body.node_id === 'string' && body.node_id.trim()) ||
      ctx.query.get('node_id')?.trim() ||
      (deviceId ? `local:${deviceId}` : '');

    if (!nodeId) {
      throw new ApiError(400, 'missing_node_id', 'node_id or device_id is required to poll');
    }

    // Refresh local heartbeat
    const row = db
      .prepare(`SELECT node_json FROM computer_nodes WHERE node_id = ? AND user_id = ?`)
      .get(nodeId, auth.userId) as { node_json: string } | undefined;
    if (row) {
      const node = JSON.parse(row.node_json) as ComputerNodeDto & { last_heartbeat_ms?: number };
      const now = Date.now();
      node.online = true;
      node.last_heartbeat_ms = now;
      node.updated_at_ms = now;
      db.prepare(`UPDATE computer_nodes SET node_json = ?, updated_at_ms = ? WHERE node_id = ? AND user_id = ?`).run(
        JSON.stringify(node),
        now,
        nodeId,
        auth.userId,
      );
    }

    const rawTimeout =
      typeof body.timeout_ms === 'number' || typeof body.timeout_ms === 'string'
        ? Number(body.timeout_ms)
        : ctx.query.get('timeout_ms') !== null
          ? Number(ctx.query.get('timeout_ms'))
          : 5000;
    const timeoutMs = Number.isFinite(rawTimeout) ? rawTimeout : 5000;

    const commands = await runtime.pollLocalCommands(
      auth.userId,
      nodeId,
      deviceId || nodeId.replace(/^local:/, ''),
      timeoutMs,
    );
    sendJson(ctx.res, 200, {
      commands,
      command: commands[0] ?? null,
    });
  };
  router.post('/api/v1/computers/local/poll', handleLocalPoll);
  router.get('/api/v1/computers/local/poll', handleLocalPoll);

  router.post('/api/v1/computers/commands/:commandId/complete', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const commandId = ctx.params.commandId!;
    const body = await readJsonBody<Record<string, unknown>>(ctx.req, MAX_COMMAND_BODY_BYTES);
    const found = runtime.completeLocalCommand(auth.userId, commandId, body);
    if (!found) {
      throw new ApiError(404, 'command_not_found', `Computer command '${commandId}' not found`);
    }
    sendJson(ctx.res, 200, { ok: true, command_id: commandId });
  });

  const handleDecideComputerCommand = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{ approve?: unknown; approved?: unknown }>(ctx.req);
    if (body.approve !== undefined && typeof body.approve !== 'boolean') {
      throw new ApiError(400, 'invalid_approve', 'approve must be a boolean');
    }
    if (body.approved !== undefined && typeof body.approved !== 'boolean') {
      throw new ApiError(400, 'invalid_approve', 'approved must be a boolean');
    }
    const row = db
      .prepare(`SELECT cmd_json FROM computer_commands WHERE command_id = ? AND user_id = ?`)
      .get(ctx.params.commandId!, auth.userId) as { cmd_json: string } | undefined;
    if (!row) throw new ApiError(404, 'command_not_found', 'Pending command not found');

    const cmd = JSON.parse(row.cmd_json) as PendingComputerCommandDto;
    const prevStatus = cmd.status;
    const isApproved = body.approve !== undefined ? body.approve !== false : body.approved !== false;
    cmd.status = isApproved ? 'approved' : 'denied';
    db.prepare(`UPDATE computer_commands SET cmd_json = ? WHERE command_id = ?`).run(
      JSON.stringify(cmd),
      cmd.command_id,
    );
    const enqueued =
      isApproved && prevStatus === 'pending'
        ? runtime.enqueueApprovedCommand(auth.userId, cmd)
        : false;
    sendJson(ctx.res, 200, { ...cmd, enqueued });
  };
  router.post('/api/v1/computers/commands/:commandId/decide', handleDecideComputerCommand);
  router.post('/api/v1/computers/commands/:commandId/approve', handleDecideComputerCommand);

  router.post('/api/v1/computers/cloud', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      display_name?: string;
      host?: string;
      port?: number;
      username?: string;
      ssh_user?: string;
      secret?: string;
      run_policy?: ComputerRunPolicy;
    }>(ctx.req);

    const host = typeof body.host === 'string' ? body.host.trim() : '';
    if (!host) {
      throw new ApiError(400, 'invalid_host', 'Cloud server host is required');
    }

    const nodeId = `cloud:${crypto.randomBytes(5).toString('hex')}`;
    const now = Date.now();
    let encSecret: string | null = null;
    let secretNonce: string | null = null;

    if (typeof body.secret === 'string' && body.secret.trim()) {
      const enc = encryptSecretAtRest(
        config.masterSecret,
        `computer:${auth.userId}:${nodeId}`,
        body.secret,
      );
      encSecret = enc.ciphertextB64;
      secretNonce = enc.nonceB64;
    }

    if (body.display_name !== undefined && body.display_name !== null && typeof body.display_name !== 'string') {
      throw new ApiError(400, 'invalid_display_name', 'display_name must be a string');
    }
    const displayName =
      (typeof body.display_name === 'string' && body.display_name.trim()) || `Cloud SSH (${host})`;

    // Honest `online: false` until verified connected; ZERO fake SVG viewport!
    const node: ComputerNodeDto = {
      node_id: nodeId,
      display_name: displayName,
      kind: 'cloud_server',
      host,
      os_name: 'Linux SSH Host',
      resolution: '1920x1080',
      online: false,
      run_policy: parseOptionalRunPolicy(body.run_policy) ?? 'ask_every_time',
      has_saved_credential: Boolean(encSecret),
      lease_state: 'idle',
      lease_generation: 1,
      updated_at_ms: now,
    };

    db.prepare(`
      INSERT INTO computer_nodes (node_id, user_id, node_json, encrypted_secret, secret_nonce, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(nodeId, auth.userId, JSON.stringify(node), encSecret, secretNonce, now);

    sendJson(ctx.res, 201, node);
  });

  const handleDispatchComputerCommand = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      node_id?: string;
      caller_label?: string;
      operation?: unknown;
      op?: unknown;
      timeout_ms?: number;
    }>(ctx.req, MAX_COMMAND_BODY_BYTES);

    const rawNodeId = ctx.params.nodeId ?? body.node_id;
    if (rawNodeId !== undefined && typeof rawNodeId !== 'string') {
      throw new ApiError(400, 'invalid_node_id', 'node_id must be a string');
    }
    const nodeId = typeof rawNodeId === 'string' ? rawNodeId.trim() : '';
    if (!nodeId) {
      throw new ApiError(400, 'missing_node_id', 'node_id is required');
    }

    const rawOp = body.operation ?? body.op;
    const operation: Record<string, unknown> =
      typeof rawOp === 'string'
        ? { op: rawOp }
        : isPlainObject(rawOp)
          ? rawOp
          : {};
    if (Object.keys(operation).length === 0) {
      throw new ApiError(400, 'invalid_operation', 'operation is required');
    }

    const executed = await runtime.executeComputerCommand(
      auth.userId,
      nodeId,
      typeof body.caller_label === 'string' && body.caller_label.trim()
        ? body.caller_label.trim()
        : `Web (@${auth.username})`,
      operation,
      {
        timeoutMs:
          typeof body.timeout_ms === 'number' && Number.isFinite(body.timeout_ms)
            ? body.timeout_ms
            : 15_000,
      },
    );

    if (executed.status === 'queued_for_approval') {
      sendJson(ctx.res, 202, executed);
      return;
    }

    sendJson(ctx.res, 200, {
      status: 'completed',
      command_id: executed.command_id,
      node_id: executed.node_id,
      ...executed.result,
      result: executed.result,
    });
  };
  router.post('/api/v1/computers/exec', handleDispatchComputerCommand);
  router.post('/api/v1/computer/action', handleDispatchComputerCommand);
  router.post('/api/v1/computers/:nodeId/commands', handleDispatchComputerCommand);

  router.patch('/api/v1/computers/:nodeId/policy', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const nodeId = ctx.params.nodeId!;
    const body = await readJsonBody<{ run_policy?: ComputerRunPolicy; display_name?: string }>(ctx.req);
    const row = db
      .prepare(`SELECT node_json FROM computer_nodes WHERE node_id = ? AND user_id = ?`)
      .get(nodeId, auth.userId) as { node_json: string } | undefined;
    if (!row) throw new ApiError(404, 'computer_not_found', 'Computer node not found');

    const node = JSON.parse(row.node_json) as ComputerNodeDto;
    const nextPolicy = parseOptionalRunPolicy(body.run_policy);
    if (nextPolicy !== undefined) node.run_policy = nextPolicy;
    if (body.display_name !== undefined && body.display_name !== null) {
      if (typeof body.display_name !== 'string') {
        throw new ApiError(400, 'invalid_display_name', 'display_name must be a string');
      }
      if (body.display_name.trim()) {
        node.display_name = body.display_name.trim();
      }
    }
    node.updated_at_ms = Date.now();
    db.prepare(`UPDATE computer_nodes SET node_json = ?, updated_at_ms = ? WHERE node_id = ? AND user_id = ?`).run(
      JSON.stringify(node),
      node.updated_at_ms,
      nodeId,
      auth.userId,
    );
    sendJson(ctx.res, 200, node);
  });

  router.post('/api/v1/computers/:nodeId/test', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const nodeId = ctx.params.nodeId!;
    const row = db
      .prepare(`SELECT node_json FROM computer_nodes WHERE node_id = ? AND user_id = ?`)
      .get(nodeId, auth.userId) as { node_json: string } | undefined;
    if (!row) throw new ApiError(404, 'computer_not_found', 'Computer node not found');
    const node = JSON.parse(row.node_json) as ComputerNodeDto;
    if (node.kind === 'local_device') {
      const executed = await runtime.executeComputerCommand(
        auth.userId,
        nodeId,
        `Web (@${auth.username})`,
        { op: 'test_connection' },
        { timeoutMs: 8000, skipApprovalCheck: true },
      );
      sendJson(ctx.res, 200, {
        ok: true,
        node_id: nodeId,
        online: true,
        result: executed.status === 'completed' ? executed.result : null,
        checked_at_ms: Date.now(),
      });
      return;
    }
    throw new ApiError(503, 'no_host_online', `Cloud computer node '${nodeId}' has no live agent connection`);
  });

  // Emergency Lease Takeover (ZERO `sandbox:default`, ZERO fake SVG, real un-clamped latency!)
  const handleEmergencyTakeover = async (ctx: RequestContext): Promise<void> => {
    const startHr = process.hrtime.bigint();
    const auth = requireAuth(db, ctx);
    let body: { node_id?: string } = {};
    try {
      body = await readJsonBody<{ node_id?: string }>(ctx.req);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 400)) throw err;
    }
    const rawNodeId = ctx.params.nodeId ?? body.node_id;
    if (rawNodeId !== undefined && typeof rawNodeId !== 'string') {
      throw new ApiError(400, 'invalid_node_id', 'node_id must be a string');
    }
    const nodeId = typeof rawNodeId === 'string' ? rawNodeId.trim() : '';
    if (!nodeId) {
      throw new ApiError(404, 'computer_not_found', 'No target computer node specified');
    }

    const takeover = runtime.requestHumanTakeover(auth.userId, nodeId, {
      reason: 'emergency_takeover',
      clientName: `Web (@${auth.username})`,
    });
    if (!takeover) throw new ApiError(404, 'computer_not_found', 'Computer node not found');

    const elapsedUs = Number((process.hrtime.bigint() - startHr) / 1000n);
    sendJson(ctx.res, 200, {
      status: 'human_takeover',
      node_id: nodeId,
      new_generation: takeover.node.lease_generation,
      elapsed_us: elapsedUs,
      latency_sub_10ms: elapsedUs < 10_000,
      node: takeover.node,
    });
  };
  router.post('/api/v1/computers/:nodeId/takeover', handleEmergencyTakeover);
  router.post('/api/v1/computer/takeover', handleEmergencyTakeover);
  router.post('/api/v1/computer/lease/emergency_takeover', handleEmergencyTakeover);

  const handleReleaseComputerLease = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    let body: { node_id?: unknown } = {};
    try {
      body = await readJsonBody<{ node_id?: unknown }>(ctx.req);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 400)) throw err;
    }
    const rawNodeId = ctx.params.nodeId ?? body.node_id;
    if (rawNodeId !== undefined && typeof rawNodeId !== 'string') {
      throw new ApiError(400, 'invalid_node_id', 'node_id must be a string');
    }
    const nodeId = typeof rawNodeId === 'string' ? rawNodeId.trim() : '';
    if (!nodeId) throw new ApiError(404, 'computer_not_found', 'No target computer node specified');

    const row = db
      .prepare(`SELECT node_json FROM computer_nodes WHERE node_id = ? AND user_id = ?`)
      .get(nodeId, auth.userId) as { node_json: string } | undefined;
    if (!row) throw new ApiError(404, 'computer_not_found', 'Computer node not found');

    const node = JSON.parse(row.node_json) as ComputerNodeDto;
    node.lease_state = 'idle';
    delete node.frame_svg_data_url;
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
    db.prepare(`DELETE FROM computer_nodes WHERE node_id = ? AND user_id = ?`).run(nodeId, auth.userId);
    sendJson(ctx.res, 200, { ok: true });
  });

  router.get('/api/v1/computers/:nodeId/frame', (ctx) => {
    const auth = requireAuth(db, ctx);
    const row = db
      .prepare(`SELECT node_json FROM computer_nodes WHERE node_id = ? AND user_id = ?`)
      .get(ctx.params.nodeId!, auth.userId) as { node_json: string } | undefined;
    if (!row) throw new ApiError(404, 'computer_not_found', 'Computer node not found');
    const node = JSON.parse(row.node_json) as ComputerNodeDto;
    if (!node.online) {
      throw new ApiError(503, 'no_host_online', `Target computer '${node.node_id}' is offline`);
    }
    sendJson(ctx.res, 200, {
      node_id: node.node_id,
      lease_generation: node.lease_generation,
      online: node.online,
      frame_data_url: null,
    });
  });

  // ==========================================================================
  // 5. Bot Computer Binding (`GET/PUT /api/v1/bots/:botId/computer`)
  // ==========================================================================
  router.get('/api/v1/bots/:botId/computer', (ctx) => {
    const auth = requireAuth(db, ctx);
    const botId = parsePositiveIdStr(ctx.params.botId);
    if (!botId) throw new ApiError(400, 'invalid_bot_id', 'Invalid botId');
    const botRow = db
      .prepare(`SELECT bot_json FROM bots_registry WHERE bot_user_id = ?`)
      .get(botId) as { bot_json: string } | undefined;
    if (!botRow) throw new ApiError(404, 'bot_not_found', 'Bot not found');

    const row = db
      .prepare(`SELECT profile_json FROM bot_computer_profiles WHERE user_id = ? AND bot_id = ?`)
      .get(auth.userId, botId) as { profile_json: string } | undefined;

    const profile: BotComputerProfileDto = row
      ? (JSON.parse(row.profile_json) as BotComputerProfileDto)
      : {
          bot_id: botId,
          bound_node_id: null,
          persona_prompt: '',
          preferred_model: '',
          approval_mode: 'ask_every_time',
          allow_cross_device_control: false,
          allow_cloud_self_config: false,
          updated_at_ms: Date.now(),
        };
    sendJson(ctx.res, 200, profile);
  });

  router.put('/api/v1/bots/:botId/computer', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const botId = parsePositiveIdStr(ctx.params.botId);
    if (!botId) throw new ApiError(400, 'invalid_bot_id', 'Invalid botId');
    const botRow = db
      .prepare(`SELECT owner_user_id, bot_json FROM bots_registry WHERE bot_user_id = ?`)
      .get(botId) as { owner_user_id: number; bot_json: string } | undefined;
    if (!botRow) throw new ApiError(404, 'bot_not_found', 'Bot not found');
    const botEntry = JSON.parse(botRow.bot_json) as BotRegistryEntry;
    if (!botEntry.is_official && Number(botRow.owner_user_id) !== auth.userId) {
      throw new ApiError(403, 'forbidden', 'Only the bot owner can update its computer binding');
    }

    const body = await readJsonBody<{
      bound_node_id?: string | null;
      clear_bound_node?: boolean;
      persona_prompt?: string;
      preferred_model?: string;
      approval_mode?: ComputerRunPolicy;
      allow_cross_device_control?: boolean;
      allow_cloud_self_config?: boolean;
    }>(ctx.req);

    const existingRow = db
      .prepare(`SELECT profile_json FROM bot_computer_profiles WHERE user_id = ? AND bot_id = ?`)
      .get(auth.userId, botId) as { profile_json: string } | undefined;
    const prev: BotComputerProfileDto = existingRow
      ? (JSON.parse(existingRow.profile_json) as BotComputerProfileDto)
      : {
          bot_id: botId,
          bound_node_id: null,
          persona_prompt: '',
          preferred_model: '',
          approval_mode: 'ask_every_time',
          allow_cross_device_control: false,
          allow_cloud_self_config: false,
          updated_at_ms: Date.now(),
        };

    if (
      body.bound_node_id !== undefined &&
      body.bound_node_id !== null &&
      typeof body.bound_node_id !== 'string'
    ) {
      throw new ApiError(400, 'invalid_node_id', 'bound_node_id must be a string or null');
    }

    const next: BotComputerProfileDto = {
      bot_id: botId,
      bound_node_id: body.clear_bound_node
        ? null
        : body.bound_node_id !== undefined
          ? (typeof body.bound_node_id === 'string' && body.bound_node_id.trim()
              ? body.bound_node_id.trim()
              : null)
          : prev.bound_node_id,
      persona_prompt: typeof body.persona_prompt === 'string' ? body.persona_prompt : prev.persona_prompt,
      preferred_model: typeof body.preferred_model === 'string' ? body.preferred_model : prev.preferred_model,
      approval_mode: parseOptionalRunPolicy(body.approval_mode, 'approval_mode') ?? prev.approval_mode,
      allow_cross_device_control:
        typeof body.allow_cross_device_control === 'boolean'
          ? body.allow_cross_device_control
          : prev.allow_cross_device_control,
      allow_cloud_self_config:
        typeof body.allow_cloud_self_config === 'boolean'
          ? body.allow_cloud_self_config
          : prev.allow_cloud_self_config,
      updated_at_ms: Date.now(),
    };

    db.prepare(`
      INSERT OR REPLACE INTO bot_computer_profiles (user_id, bot_id, profile_json, updated_at_ms)
      VALUES (?, ?, ?, ?)
    `).run(auth.userId, botId, JSON.stringify(next), next.updated_at_ms);

    sendJson(ctx.res, 200, next);
  });
}
