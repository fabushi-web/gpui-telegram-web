import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  CODING_AGENT_OWNER_ONLY_MSG,
  CODING_PROVIDER_META,
  CODING_SLASH_COMMANDS,
  parseCodingPermissionMode,
  type BotRegistryEntry,
  type CodingAgentBotConfig,
  type CodingApprovalDecision,
  type CodingControlAction,
  type CodingHostEvent,
  type CodingPermissionMode,
  type CodingProviderKind,
  type DetectedCodingProvider,
  type InlineKeyboardButton,
} from '@gpui-telegram/protocol';
import {
  createMessageAtomic,
  editMessageAtomic,
  ensureChatMembership,
} from '../db/queries.js';

function parsePositiveIdStr(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw >= 1 ? raw : undefined;
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    const n = Number(raw.trim());
    return Number.isSafeInteger(n) && n >= 1 ? n : undefined;
  }
  return undefined;
}
import {
  ApiError,
  readJsonBody,
  requireAuth,
  sendJson,
  type HttpRouter,
  type RequestContext,
} from '../utils/http.js';
import type { RealtimeGatewayHub } from '../ws/hub.js';

// ============================================================================
// 1. Real Local PATH Binary Probe (ZERO fabricated installs!)
// ============================================================================

const LOCAL_BINARY_CANDIDATES: Array<{
  kind: CodingProviderKind;
  binaries: string[];
  loginHint: string;
}> = [
  { kind: 'claude_code', binaries: ['claude'], loginHint: 'Run `claude login` in terminal' },
  { kind: 'codex', binaries: ['codex'], loginHint: 'Run `codex login` in terminal' },
  { kind: 'open_code', binaries: ['opencode'], loginHint: 'Configure OpenCode credentials' },
  { kind: 'cursor_cli', binaries: ['cursor-agent', 'cursor'], loginHint: 'Run `cursor-agent login`' },
  { kind: 'antigravity', binaries: ['agy', 'antigravity'], loginHint: 'Sign in via Antigravity CLI' },
  { kind: 'acp_custom', binaries: [], loginHint: 'Configure executable_override in Bot settings' },
];

function findExecutableInPath(binaryName: string): string | null {
  const pathEnv = process.env.PATH ?? '';
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, binaryName);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {
      // Not present or not executable
    }
  }
  return null;
}

export function probeLocalCodingBinaries(): DetectedCodingProvider[] {
  return LOCAL_BINARY_CANDIDATES.map((spec) => {
    const meta = CODING_PROVIDER_META[spec.kind];
    let foundPath: string | null = null;
    for (const bin of spec.binaries) {
      foundPath = findExecutableInPath(bin);
      if (foundPath) break;
    }
    return {
      kind: spec.kind,
      display_name: meta.display_name,
      binary_path: foundPath,
      version: null,
      installed: foundPath !== null,
      recommended_username: meta.recommended_username,
      supports_acp: meta.supports_acp,
      login_hint: spec.loginHint,
    };
  });
}

// ============================================================================
// 2. CodingAgentBroker (WS CodingHostCommand / CodingHostEvent + Inline Approvals)
// ============================================================================

interface RegisteredCodingHost {
  ownerUserId: number;
  deviceId: string;
  displayName: string;
  osName: string;
  providers: DetectedCodingProvider[];
  sessionId: string | null;
  lastSeenMs: number;
  online: boolean;
}

interface PendingProbe {
  ownerUserId: number;
  resolve: (result: { deviceId: string; providers: DetectedCodingProvider[] }) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingControl {
  ownerUserId: number;
  resolve: (event: Extract<CodingHostEvent, { event: 'control_result' }>) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface ToolStepRender {
  call_id: string;
  tool_name: string;
  title: string;
  status: string;
  output_preview?: string | null;
}

interface ActiveCodingTurn {
  turnId: string;
  ownerUserId: number;
  botUserId: number;
  chatId: number;
  topicId: number | null;
  targetDeviceId: string | null;
  targetSessionId: string | null;
  providerSessionId: string | null;
  workspacePath: string;
  worktreePath: string | null;
  gitBranch: string | null;
  turnIdx: number;
  thinkingText: string;
  streamText: string;
  toolSteps: ToolStepRender[];
  messageId: number | null;
  throttleTimer: NodeJS.Timeout | null;
  finished: boolean;
}

export interface CodingTurnMeta {
  turnId: string;
  ownerUserId: number;
  botUserId: number;
  chatId: number;
  targetDeviceId: string | null;
  targetSessionId: string | null;
}

interface PendingApprovalRecord {
  turnId: string;
  requestId: string;
  ownerUserId: number;
  botUserId: number;
  chatId: number;
  kind: string;
  title: string;
  detail: string;
  ruleKey: string;
  messageId: number;
  resolved: boolean;
  expired: boolean;
  decision?: CodingApprovalDecision;
}

function stripLeadingBotMention(text: string, botUsername: string): string {
  const trimmed = text.trim();
  const re = new RegExp(`^@${botUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s+|$)`, 'i');
  return trimmed.replace(re, '').trim();
}

export class CodingAgentBroker {
  private readonly hosts = new Map<string, RegisteredCodingHost>();
  private readonly pendingProbes = new Map<string, PendingProbe>();
  private readonly pendingControls = new Map<string, PendingControl>();
  private readonly activeTurns = new Map<string, ActiveCodingTurn>();
  private readonly chatActiveTurns = new Map<string, string>();
  private readonly turnMeta = new Map<string, CodingTurnMeta>();
  private readonly pendingApprovals = new Map<string, PendingApprovalRecord>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly hub: RealtimeGatewayHub,
  ) {}

  private hostKey(userId: number, deviceId: string): string {
    return `${userId}:${deviceId}`;
  }

  private chatTurnKey(botUserId: number, chatId: number, topicId: number | null): string {
    return `${botUserId}:${chatId}:${topicId ?? 0}`;
  }

  private approvalKey(turnId: string, requestId: string): string {
    return `${turnId}:${requestId}`;
  }

  listHostsForUser(userId: number): Array<{
    device_id: string;
    display_name: string;
    os_name: string;
    online: boolean;
    last_seen_ms: number;
    providers: DetectedCodingProvider[];
  }> {
    const out: Array<{
      device_id: string;
      display_name: string;
      os_name: string;
      online: boolean;
      last_seen_ms: number;
      providers: DetectedCodingProvider[];
    }> = [];
    for (const h of this.hosts.values()) {
      if (h.ownerUserId !== userId) continue;
      out.push({
        device_id: h.deviceId,
        display_name: h.displayName,
        os_name: h.osName,
        online: h.online,
        last_seen_ms: h.lastSeenMs,
        providers: h.providers,
      });
    }
    return out;
  }

  resolveOnlineHost(userId: number, preferredDeviceId?: string | null): RegisteredCodingHost | null {
    if (preferredDeviceId && preferredDeviceId.trim()) {
      const exact = this.hosts.get(this.hostKey(userId, preferredDeviceId.trim()));
      return exact && exact.online ? exact : null;
    }
    let freshest: RegisteredCodingHost | null = null;
    for (const h of this.hosts.values()) {
      if (h.ownerUserId !== userId || !h.online) continue;
      if (!freshest || h.lastSeenMs > freshest.lastSeenMs) {
        freshest = h;
      }
    }
    return freshest;
  }

  getTurnMeta(turnId: string): CodingTurnMeta | undefined {
    return this.turnMeta.get(turnId);
  }

  isTurnActive(turnId: string): boolean {
    const t = this.activeTurns.get(turnId);
    return Boolean(t && !t.finished);
  }

  getPendingApproval(turnId: string, requestId: string): PendingApprovalRecord | undefined {
    return this.pendingApprovals.get(this.approvalKey(turnId, requestId));
  }

  markApprovalResolved(
    turnId: string,
    requestId: string,
    decision: CodingApprovalDecision,
    meta: CodingTurnMeta,
  ): PendingApprovalRecord {
    const key = this.approvalKey(turnId, requestId);
    const existing = this.pendingApprovals.get(key);
    if (existing) {
      existing.resolved = true;
      existing.decision = decision;
      return existing;
    }
    const record: PendingApprovalRecord = {
      turnId,
      requestId,
      ownerUserId: meta.ownerUserId,
      botUserId: meta.botUserId,
      chatId: meta.chatId,
      kind: '',
      title: '',
      detail: '',
      ruleKey: '',
      messageId: 0,
      resolved: true,
      expired: false,
      decision,
    };
    this.pendingApprovals.set(key, record);
    return record;
  }

  async probeHostProviders(
    ownerUserId: number,
    deviceId?: string,
    timeoutMs = 6000,
  ): Promise<{ deviceId: string; providers: DetectedCodingProvider[] }> {
    const clampedTimeout = Math.max(500, Math.min(15_000, Math.floor(timeoutMs)));
    const host = this.resolveOnlineHost(ownerUserId, deviceId);
    if (!host) {
      throw new ApiError(
        503,
        'host_probe_unavailable',
        'No online coding agent host connected',
        { hosts: this.listHostsForUser(ownerUserId) },
      );
    }

    const reqId = `cprobe_${crypto.randomBytes(6).toString('hex')}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingProbes.delete(reqId);
        reject(
          new ApiError(
            503,
            'host_probe_timeout',
            `Coding host '${host.deviceId}' did not respond to probe within ${clampedTimeout}ms`,
          ),
        );
      }, clampedTimeout);
      timer.unref();

      this.pendingProbes.set(reqId, { ownerUserId, resolve, reject, timer });

      const sent = this.hub.sendCodingHostCommand(
        ownerUserId,
        {
          cmd: 'probe_providers',
          req_id: reqId,
          owner_user_id: ownerUserId,
          target_device_id: host.deviceId,
        },
        host.sessionId,
      );
      if (!sent) {
        clearTimeout(timer);
        this.pendingProbes.delete(reqId);
        host.online = false;
        host.sessionId = null;
        reject(
          new ApiError(
            503,
            'host_probe_unavailable',
            'Coding agent host WebSocket is disconnected',
          ),
        );
      }
    });
  }

  private async sendControlCommand(
    ownerUserId: number,
    bot: BotRegistryEntry,
    cfg: CodingAgentBotConfig,
    chatId: number,
    topicId: number | null,
    action: CodingControlAction,
    timeoutMs = 8000,
  ): Promise<Extract<CodingHostEvent, { event: 'control_result' }> | null> {
    const host = this.resolveOnlineHost(ownerUserId, cfg.bound_device_id);
    if (!host) return null;

    const reqId = `cctrl_${crypto.randomBytes(6).toString('hex')}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingControls.delete(reqId);
        resolve(null);
      }, timeoutMs);
      timer.unref();

      this.pendingControls.set(reqId, {
        ownerUserId,
        resolve,
        reject: () => resolve(null),
        timer,
      });

      const sent = this.hub.sendCodingHostCommand(
        ownerUserId,
        {
          cmd: 'control',
          req_id: reqId,
          owner_user_id: ownerUserId,
          target_device_id: host.deviceId,
          bot_user_id: bot.bot_user_id,
          chat_id: chatId,
          topic_id: topicId,
          is_forum_topic: Boolean(topicId),
          config: cfg,
          action,
        },
        host.sessionId,
      );
      if (!sent) {
        clearTimeout(timer);
        this.pendingControls.delete(reqId);
        host.online = false;
        host.sessionId = null;
        resolve(null);
      }
    });
  }

  private formatTurnBody(turn: ActiveCodingTurn, finalFooter?: string): string {
    const parts: string[] = [];
    if (turn.toolSteps.length > 0) {
      const stepLines = turn.toolSteps.slice(-12).map((s) => {
        const icon = s.status === 'completed' || s.status === 'ok' ? '✅' : s.status === 'error' ? '❌' : '⚙️';
        return `${icon} \`${s.tool_name}\`: ${s.title}${s.output_preview ? ` — ${s.output_preview.slice(0, 100)}` : ''}`;
      });
      parts.push(stepLines.join('\n'));
    }
    if (turn.streamText.trim()) {
      parts.push(turn.streamText);
    } else if (turn.thinkingText.trim()) {
      parts.push(`_${turn.thinkingText.slice(-300)}_`);
    }
    if (finalFooter) {
      parts.push(finalFooter);
    }
    return parts.join('\n\n').trim() || '…';
  }

  private flushTurnMessage(turn: ActiveCodingTurn, finalFooter?: string): void {
    if (turn.throttleTimer) {
      clearTimeout(turn.throttleTimer);
      turn.throttleTimer = null;
    }
    const text = this.formatTurnBody(turn, finalFooter);
    try {
      if (turn.messageId === null) {
        const created = createMessageAtomic(this.db, this.hub, {
          chatId: turn.chatId,
          senderId: turn.botUserId,
          topicId: turn.topicId ?? undefined,
          text,
        });
        turn.messageId = created.message.id;
      } else {
        editMessageAtomic(this.db, this.hub, {
          chatId: turn.chatId,
          messageId: turn.messageId,
          editorUserId: turn.botUserId,
          text,
        });
      }
    } catch {
      // Ignore if chat/db closed during teardown
    }
  }

  private scheduleTurnFlush(turn: ActiveCodingTurn): void {
    if (turn.throttleTimer || turn.finished) return;
    turn.throttleTimer = setTimeout(() => {
      turn.throttleTimer = null;
      this.flushTurnMessage(turn);
    }, 120);
    turn.throttleTimer.unref();
  }

  handleHostEvent(userId: number, sessionId: string | null, event: CodingHostEvent): void {
    const now = Date.now();
    switch (event.event) {
      case 'host_register': {
        const deviceId = String(event.device_id ?? '').trim();
        if (!deviceId) return;
        this.hosts.set(this.hostKey(userId, deviceId), {
          ownerUserId: userId,
          deviceId,
          displayName: String(event.display_name ?? deviceId),
          osName: String(event.os_name ?? 'unknown'),
          providers: Array.isArray(event.providers) ? event.providers : [],
          sessionId,
          lastSeenMs: now,
          online: true,
        });
        return;
      }

      case 'probe_result': {
        const pending = this.pendingProbes.get(event.req_id);
        if (!pending || pending.ownerUserId !== userId) return;
        clearTimeout(pending.timer);
        this.pendingProbes.delete(event.req_id);
        const host = this.hosts.get(this.hostKey(userId, event.device_id));
        if (host) {
          host.providers = Array.isArray(event.providers) ? event.providers : [];
          host.lastSeenMs = now;
        }
        pending.resolve({
          deviceId: event.device_id,
          providers: Array.isArray(event.providers) ? event.providers : [],
        });
        return;
      }

      case 'control_result': {
        const pending = this.pendingControls.get(event.req_id);
        if (!pending || pending.ownerUserId !== userId) return;
        clearTimeout(pending.timer);
        this.pendingControls.delete(event.req_id);
        pending.resolve(event);
        return;
      }

      case 'turn_started': {
        const turn = this.activeTurns.get(event.turn_id);
        if (!turn || turn.ownerUserId !== userId) return;
        turn.providerSessionId = event.provider_session_id ?? null;
        turn.workspacePath = event.workspace_path || turn.workspacePath;
        turn.worktreePath = event.worktree_path ?? null;
        turn.gitBranch = event.git_branch ?? null;
        turn.turnIdx = Number(event.turn_idx ?? 1);
        this.hub.broadcastBotActivity(turn.chatId, {
          chat_id: turn.chatId,
          bot_user_id: turn.botUserId,
          state: 'thinking',
          detail: `Turn #${turn.turnIdx}`,
        });
        return;
      }

      case 'turn_activity': {
        const turn = this.activeTurns.get(event.turn_id);
        if (!turn || turn.ownerUserId !== userId) return;
        this.hub.broadcastBotActivity(turn.chatId, {
          chat_id: turn.chatId,
          bot_user_id: turn.botUserId,
          state: event.state,
          detail: event.detail ?? null,
        });
        return;
      }

      case 'turn_thinking_delta': {
        const turn = this.activeTurns.get(event.turn_id);
        if (!turn || turn.ownerUserId !== userId || turn.finished) return;
        turn.thinkingText += event.delta ?? '';
        this.scheduleTurnFlush(turn);
        return;
      }

      case 'turn_text_delta': {
        const turn = this.activeTurns.get(event.turn_id);
        if (!turn || turn.ownerUserId !== userId || turn.finished) return;
        turn.streamText += event.delta ?? '';
        this.scheduleTurnFlush(turn);
        return;
      }

      case 'turn_tool_step': {
        const turn = this.activeTurns.get(event.turn_id);
        if (!turn || turn.ownerUserId !== userId || turn.finished) return;
        const idx = turn.toolSteps.findIndex((s) => s.call_id === event.call_id);
        const step: ToolStepRender = {
          call_id: event.call_id,
          tool_name: event.tool_name,
          title: event.title,
          status: event.status,
          output_preview: event.output_preview ?? null,
        };
        if (idx >= 0) turn.toolSteps[idx] = step;
        else turn.toolSteps.push(step);
        this.scheduleTurnFlush(turn);
        return;
      }

      case 'turn_approval_requested': {
        const turn = this.activeTurns.get(event.turn_id);
        if (!turn || turn.ownerUserId !== userId || turn.finished) return;
        const apprKey = this.approvalKey(event.turn_id, event.request_id);
        const existingAppr = this.pendingApprovals.get(apprKey);
        if (existingAppr?.resolved) {
          existingAppr.kind = event.kind;
          existingAppr.title = event.title;
          existingAppr.detail = event.detail;
          existingAppr.ruleKey = event.rule_key;
          return;
        }
        if (turn.streamText || turn.toolSteps.length > 0) {
          this.flushTurnMessage(turn);
        }
        const keyboard: InlineKeyboardButton[][] = [
          [
            {
              text: '✅ 允许本次',
              callback_data: `coding:approve:${event.turn_id}:${event.request_id}:once`,
            },
            {
              text: '🔓 本会话允许',
              callback_data: `coding:approve:${event.turn_id}:${event.request_id}:session`,
            },
            {
              text: '❌ 拒绝',
              callback_data: `coding:approve:${event.turn_id}:${event.request_id}:deny`,
            },
          ],
        ];
        const cardText = [
          `🔐 **权限审批请求** (${event.kind})`,
          `**${event.title}**`,
          event.detail ? `\`\`\`\n${event.detail}\n\`\`\`` : '',
          `规则键: \`${event.rule_key}\``,
        ]
          .filter(Boolean)
          .join('\n');

        try {
          const created = createMessageAtomic(this.db, this.hub, {
            chatId: turn.chatId,
            senderId: turn.botUserId,
            topicId: turn.topicId ?? undefined,
            text: cardText,
            inlineKeyboard: keyboard,
          });
          this.pendingApprovals.set(this.approvalKey(event.turn_id, event.request_id), {
            turnId: event.turn_id,
            requestId: event.request_id,
            ownerUserId: turn.ownerUserId,
            botUserId: turn.botUserId,
            chatId: turn.chatId,
            kind: event.kind,
            title: event.title,
            detail: event.detail,
            ruleKey: event.rule_key,
            messageId: created.message.id,
            resolved: false,
            expired: false,
          });
        } catch {
          // Ignore teardown error
        }
        this.hub.broadcastBotActivity(turn.chatId, {
          chat_id: turn.chatId,
          bot_user_id: turn.botUserId,
          state: 'approval',
          detail: event.title,
        });
        return;
      }

      case 'turn_completed': {
        const turn = this.activeTurns.get(event.turn_id);
        if (!turn || turn.ownerUserId !== userId) return;
        turn.finished = true;
        if (turn.throttleTimer) {
          clearTimeout(turn.throttleTimer);
          turn.throttleTimer = null;
        }
        if (event.final_text) {
          turn.streamText = event.final_text;
        } else if (!event.ok && event.error) {
          turn.streamText = `${turn.streamText ? `${turn.streamText}\n\n` : ''}❌ ${event.error}`;
        }

        const footerParts: string[] = [];
        if (event.diff_stat) {
          footerParts.push(
            `📝 ${event.diff_stat.files_changed} file(s), +${event.diff_stat.insertions}/-${event.diff_stat.deletions}`,
          );
        }
        if (event.token_usage) {
          footerParts.push(
            `🔢 in=${event.token_usage.input_tokens} out=${event.token_usage.output_tokens}`,
          );
        }
        const footer = footerParts.length > 0 ? `_${footerParts.join(' · ')}_` : undefined;
        this.flushTurnMessage(turn, footer);

        this.activeTurns.delete(event.turn_id);
        const ctKey = this.chatTurnKey(turn.botUserId, turn.chatId, turn.topicId);
        if (this.chatActiveTurns.get(ctKey) === event.turn_id) {
          this.chatActiveTurns.delete(ctKey);
        }

        // Expire ALL unresolved pending approvals for this turn & clear their inline keyboards!
        for (const rec of this.pendingApprovals.values()) {
          if (rec.turnId === event.turn_id && !rec.resolved) {
            rec.expired = true;
            try {
              this.db
                .prepare(`UPDATE messages SET inline_keyboard_json = NULL WHERE chat_id = ? AND message_id = ?`)
                .run(rec.chatId, rec.messageId);
              editMessageAtomic(this.db, this.hub, {
                chatId: rec.chatId,
                messageId: rec.messageId,
                editorUserId: rec.botUserId,
                text: `🔐 **权限审批已失效** (${rec.title}) — 本轮执行已结束。`,
              });
            } catch {
              // Ignore if message deleted
            }
          }
        }

        this.hub.broadcastBotActivity(turn.chatId, {
          chat_id: turn.chatId,
          bot_user_id: turn.botUserId,
          state: 'idle',
          detail: null,
        });
        return;
      }
    }
  }

  markSessionDisconnected(userId: number | null, sessionId: string | null): void {
    if (!sessionId) return;
    for (const host of this.hosts.values()) {
      if ((userId === null || host.ownerUserId === userId) && host.sessionId === sessionId) {
        host.online = false;
        host.sessionId = null;
      }
    }
  }

  private persistBotConfig(bot: BotRegistryEntry, cfg: CodingAgentBotConfig): void {
    bot.coding_agent = cfg;
    this.db
      .prepare(`UPDATE bots_registry SET bot_json = ? WHERE bot_user_id = ?`)
      .run(JSON.stringify(bot), bot.bot_user_id);
  }

  private formatStatusCard(bot: BotRegistryEntry, cfg: CodingAgentBotConfig): string {
    const host = this.resolveOnlineHost(bot.owner_user_id, cfg.bound_device_id);
    const meta = CODING_PROVIDER_META[cfg.provider_kind];
    return [
      `🤖 **${bot.display_name}** (@${bot.username})`,
      `• Provider: \`${meta.display_name}\` (\`${cfg.provider_kind}\`)`,
      `• Workspace: \`${cfg.workspace_path || '(unset)'}\``,
      `• Worktree: \`${cfg.use_worktree ? 'on' : 'off'}\``,
      `• Permission Mode: \`${cfg.permission_mode}\``,
      `• Model: \`${cfg.model_override || '(default)'}\``,
      `• Group Members Allowed: \`${cfg.allow_group_members ? 'yes' : 'owner_only'}\``,
      `• Host Status: ${host ? `🟢 Online (\`${host.displayName}\` / \`${host.deviceId}\`)` : '🔴 Offline'}`,
    ].join('\n');
  }

  private buildModeKeyboard(botUserId: number): InlineKeyboardButton[][] {
    return [
      [
        { text: 'Ask', callback_data: `coding:mode:${botUserId}:ask` },
        { text: 'Auto Edit', callback_data: `coding:mode:${botUserId}:auto_edit` },
        { text: 'Full Access', callback_data: `coding:mode:${botUserId}:full_access` },
      ],
    ];
  }

  handleIncomingMessage(params: {
    bot: BotRegistryEntry;
    chatId: number;
    senderId: number;
    text: string;
    topicId?: number | null;
  }): boolean {
    const cfg = params.bot.coding_agent;
    if (!cfg) return false;
    const { bot, chatId, senderId, topicId = null } = params;

    // Owner-only security guard (enforced in both DMs and group chats!)
    if (senderId !== bot.owner_user_id && !cfg.allow_group_members) {
      createMessageAtomic(this.db, this.hub, {
        chatId,
        senderId: bot.bot_user_id,
        topicId: topicId ?? undefined,
        text: CODING_AGENT_OWNER_ONLY_MSG,
      });
      return true;
    }

    const cleaned = stripLeadingBotMention(params.text, bot.username);
    if (!cleaned) return true;

    if (cleaned.startsWith('/')) {
      void this.handleSlashCommand(bot, cfg, chatId, topicId, cleaned);
      return true;
    }

    void this.dispatchTurn(bot, cfg, chatId, topicId, cleaned);
    return true;
  }

  private async handleSlashCommand(
    bot: BotRegistryEntry,
    cfg: CodingAgentBotConfig,
    chatId: number,
    topicId: number | null,
    rawText: string,
  ): Promise<void> {
    const withoutSlash = rawText.slice(1).trim();
    const spaceIdx = withoutSlash.indexOf(' ');
    const verb = (spaceIdx === -1 ? withoutSlash : withoutSlash.slice(0, spaceIdx))
      .split('@')[0]!
      .toLowerCase();
    const argStr = spaceIdx === -1 ? '' : withoutSlash.slice(spaceIdx + 1).trim();

    const reply = (text: string, inlineKeyboard?: InlineKeyboardButton[][]): void => {
      try {
        createMessageAtomic(this.db, this.hub, {
          chatId,
          senderId: bot.bot_user_id,
          topicId: topicId ?? undefined,
          text,
          ...(inlineKeyboard ? { inlineKeyboard } : {}),
        });
      } catch {
        // Ignore teardown errors
      }
    };

    switch (verb) {
      case 'start': {
        reply(this.formatStatusCard(bot, cfg), this.buildModeKeyboard(bot.bot_user_id));
        return;
      }

      case 'help': {
        const lines = CODING_SLASH_COMMANDS.map((c) => `• \`/${c.command}\` — ${c.description}`);
        reply(`**${bot.display_name} 编程智能体命令 (${CODING_SLASH_COMMANDS.length})**\n${lines.join('\n')}`);
        return;
      }

      case 'mode': {
        if (!argStr) {
          reply(
            `当前权限模式: \`${cfg.permission_mode}\` (ask / auto_edit / full_access)`,
            this.buildModeKeyboard(bot.bot_user_id),
          );
          return;
        }
        const parsed = parseCodingPermissionMode(argStr);
        if (!parsed) {
          reply(`无效的权限模式 \`${argStr}\`。可选: \`ask\`, \`auto_edit\`, \`full_access\`。`);
          return;
        }
        cfg.permission_mode = parsed;
        this.persistBotConfig(bot, cfg);
        const ctrl = await this.sendControlCommand(bot.owner_user_id, bot, cfg, chatId, topicId, {
          action: 'set_permission_mode',
          mode: parsed,
        });
        reply(ctrl?.markdown_reply || `✅ 权限模式已切换为 \`${parsed}\`。`);
        return;
      }

      case 'workspace': {
        if (!argStr) {
          reply(`当前工作区路径: \`${cfg.workspace_path || '(unset)'}\``);
          return;
        }
        cfg.workspace_path = argStr;
        this.persistBotConfig(bot, cfg);
        const ctrl = await this.sendControlCommand(bot.owner_user_id, bot, cfg, chatId, topicId, {
          action: 'set_workspace',
          path: argStr,
        });
        reply(ctrl?.markdown_reply || `✅ 工作区已更新为 \`${argStr}\`。`);
        return;
      }

      case 'worktree': {
        if (!argStr) {
          reply(`Git Worktree 隔离: \`${cfg.use_worktree ? 'on' : 'off'}\``);
          return;
        }
        const parts = argStr.split(/\s+/);
        const sub = parts[0]!.toLowerCase();
        const branch = parts[1] ?? null;
        if (sub === 'on') cfg.use_worktree = true;
        else if (sub === 'off') cfg.use_worktree = false;
        this.persistBotConfig(bot, cfg);
        const ctrl = await this.sendControlCommand(bot.owner_user_id, bot, cfg, chatId, topicId, {
          action: 'worktree_op',
          op: sub,
          branch,
        });
        reply(ctrl?.markdown_reply || `✅ Worktree 操作 \`${sub}\` 已更新（use_worktree=${cfg.use_worktree}）。`);
        return;
      }

      case 'model': {
        if (!argStr) {
          const ctrl = await this.sendControlCommand(bot.owner_user_id, bot, cfg, chatId, topicId, {
            action: 'list_models',
          });
          reply(ctrl?.markdown_reply || `当前模型: \`${cfg.model_override || '(default)'}\``);
          return;
        }
        cfg.model_override = argStr;
        this.persistBotConfig(bot, cfg);
        const ctrl = await this.sendControlCommand(bot.owner_user_id, bot, cfg, chatId, topicId, {
          action: 'set_model',
          model: argStr,
        });
        reply(ctrl?.markdown_reply || `✅ 模型已切换为 \`${argStr}\`。`);
        return;
      }

      case 'diff': {
        const turnIdx = argStr && /^\d+$/.test(argStr) ? Number(argStr) : null;
        const ctrl = await this.sendControlCommand(bot.owner_user_id, bot, cfg, chatId, topicId, {
          action: 'get_diff',
          turn_idx: turnIdx,
        });
        reply(ctrl?.markdown_reply || '⚠️ 本地编程主机未在线，无法获取代码变更 diff。');
        return;
      }

      case 'rollback': {
        const turnIdx = argStr && /^\d+$/.test(argStr) ? Number(argStr) : null;
        const ctrl = await this.sendControlCommand(bot.owner_user_id, bot, cfg, chatId, topicId, {
          action: 'rollback_checkpoint',
          turn_idx: turnIdx,
        });
        reply(ctrl?.markdown_reply || '⚠️ 本地编程主机未在线，无法执行检查点回滚。');
        return;
      }

      case 'handoff': {
        const target = argStr.replace(/^@/, '').trim();
        const ctrl = await this.sendControlCommand(bot.owner_user_id, bot, cfg, chatId, topicId, {
          action: 'build_handoff_summary',
          target_bot_username: target || 'HermesAgent',
        });
        reply(ctrl?.markdown_reply || '⚠️ 本地编程主机未在线，无法生成交接摘要。');
        return;
      }

      case 'status': {
        const ctrl = await this.sendControlCommand(bot.owner_user_id, bot, cfg, chatId, topicId, {
          action: 'get_status',
        });
        reply(ctrl?.markdown_reply || this.formatStatusCard(bot, cfg));
        return;
      }

      case 'login': {
        const ctrl = await this.sendControlCommand(bot.owner_user_id, bot, cfg, chatId, topicId, {
          action: 'check_login',
        });
        reply(ctrl?.markdown_reply || '⚠️ 本地编程主机未在线，无法检查本地 CLI 登录状态。');
        return;
      }

      case 'new': {
        const ctrl = await this.sendControlCommand(bot.owner_user_id, bot, cfg, chatId, topicId, {
          action: 'reset_session',
        });
        reply(ctrl?.markdown_reply || '✅ 会话已重置。');
        return;
      }

      case 'stop': {
        const ctKey = this.chatTurnKey(bot.bot_user_id, chatId, topicId);
        const activeTurnId = this.chatActiveTurns.get(ctKey);
        if (!activeTurnId) {
          reply('当前没有正在运行的编程任务。');
          return;
        }
        const turn = this.activeTurns.get(activeTurnId);
        if (turn) {
          this.hub.sendCodingHostCommand(
            turn.ownerUserId,
            {
              cmd: 'cancel_turn',
              turn_id: turn.turnId,
              owner_user_id: turn.ownerUserId,
              target_device_id: turn.targetDeviceId,
            },
            turn.targetSessionId,
          );
          turn.finished = true;
          if (turn.throttleTimer) clearTimeout(turn.throttleTimer);
          this.activeTurns.delete(activeTurnId);
          for (const rec of this.pendingApprovals.values()) {
            if (rec.turnId === activeTurnId && !rec.resolved) {
              rec.expired = true;
              if (rec.messageId > 0) {
                try {
                  this.db
                    .prepare(
                      `UPDATE messages SET inline_keyboard_json = NULL WHERE chat_id = ? AND message_id = ?`,
                    )
                    .run(rec.chatId, rec.messageId);
                } catch {
                  // Ignore if message deleted
                }
              }
            }
          }
        }
        this.chatActiveTurns.delete(ctKey);
        this.hub.broadcastBotActivity(chatId, {
          chat_id: chatId,
          bot_user_id: bot.bot_user_id,
          state: 'idle',
          detail: null,
        });
        reply(`🛑 已发送停止指令（turn \`${activeTurnId}\`）。`);
        return;
      }

      default:
        reply(`未知命令 \`/${verb}\`。输入 \`/help\` 查看所有 13 个编程智能体命令。`);
    }
  }

  private async dispatchTurn(
    bot: BotRegistryEntry,
    cfg: CodingAgentBotConfig,
    chatId: number,
    topicId: number | null,
    prompt: string,
  ): Promise<void> {
    const host = this.resolveOnlineHost(bot.owner_user_id, cfg.bound_device_id);
    if (!host) {
      createMessageAtomic(this.db, this.hub, {
        chatId,
        senderId: bot.bot_user_id,
        topicId: topicId ?? undefined,
        text: '⚠️ 当前没有在线的本地主机桌面客户端。请在您的电脑上打开 Fabushi 桌面客户端并保持在线连接。',
      });
      return;
    }

    const turnId = `cturn_${crypto.randomBytes(8).toString('hex')}`;
    const turn: ActiveCodingTurn = {
      turnId,
      ownerUserId: bot.owner_user_id,
      botUserId: bot.bot_user_id,
      chatId,
      topicId,
      targetDeviceId: host.deviceId,
      targetSessionId: host.sessionId,
      providerSessionId: null,
      workspacePath: cfg.workspace_path,
      worktreePath: null,
      gitBranch: null,
      turnIdx: 1,
      thinkingText: '',
      streamText: '',
      toolSteps: [],
      messageId: null,
      throttleTimer: null,
      finished: false,
    };

    // Register BEFORE sending WS frame to avoid race with immediate host turn_started!
    this.activeTurns.set(turnId, turn);
    this.chatActiveTurns.set(this.chatTurnKey(bot.bot_user_id, chatId, topicId), turnId);
    this.turnMeta.set(turnId, {
      turnId,
      ownerUserId: bot.owner_user_id,
      botUserId: bot.bot_user_id,
      chatId,
      targetDeviceId: host.deviceId,
      targetSessionId: host.sessionId,
    });

    const sent = this.hub.sendCodingHostCommand(
      bot.owner_user_id,
      {
        cmd: 'start_turn',
        turn_id: turnId,
        owner_user_id: bot.owner_user_id,
        target_device_id: host.deviceId,
        bot_user_id: bot.bot_user_id,
        chat_id: chatId,
        topic_id: topicId,
        is_forum_topic: Boolean(topicId),
        prompt,
        config: cfg,
      },
      host.sessionId,
    );

    if (!sent) {
      this.activeTurns.delete(turnId);
      this.chatActiveTurns.delete(this.chatTurnKey(bot.bot_user_id, chatId, topicId));
      host.online = false;
      host.sessionId = null;
      createMessageAtomic(this.db, this.hub, {
        chatId,
        senderId: bot.bot_user_id,
        topicId: topicId ?? undefined,
        text: '⚠️ 本地主机连接已断开，无法启动编程任务。',
      });
    }
  }

  reset(): void {
    for (const p of this.pendingProbes.values()) {
      clearTimeout(p.timer);
      p.reject(new ApiError(503, 'server_reset', 'Server reset'));
    }
    this.pendingProbes.clear();
    for (const c of this.pendingControls.values()) {
      clearTimeout(c.timer);
      c.reject(new Error('Server reset'));
    }
    this.pendingControls.clear();
    for (const t of this.activeTurns.values()) {
      if (t.throttleTimer) clearTimeout(t.throttleTimer);
    }
    this.activeTurns.clear();
    this.chatActiveTurns.clear();
    this.turnMeta.clear();
    this.pendingApprovals.clear();
    this.hosts.clear();
  }

  dispose(): void {
    this.reset();
  }
}

// ============================================================================
// 3. Inline Callback Handler (`coding:approve:*` & `coding:mode:*`)
// ============================================================================

export async function handleCodingCallback(
  db: DatabaseSync,
  hub: RealtimeGatewayHub,
  broker: CodingAgentBroker,
  ctx: RequestContext,
  body: Record<string, unknown>,
): Promise<void> {
  const auth = requireAuth(db, ctx);
  const chatId = parsePositiveIdStr(ctx.params.chatId ?? body.chat_id);
  if (!chatId) throw new ApiError(400, 'invalid_chat_id', 'Invalid chatId');
  ensureChatMembership(db, chatId, auth.userId);

  const rawCbVal = body.callback_data ?? body.data;
  if (typeof rawCbVal !== 'string') {
    throw new ApiError(400, 'invalid_callback', 'callback_data must be a string');
  }
  const rawCb = rawCbVal.trim();
  const parts = rawCb.split(':');
  if (parts[0] !== 'coding') {
    throw new ApiError(400, 'invalid_callback', 'Not a coding callback');
  }

  if (parts[1] === 'approve') {
    // coding:approve:<turnId>:<requestId>:<once|session|deny>
    if (parts.length !== 5) {
      throw new ApiError(400, 'invalid_callback', 'Malformed coding:approve callback_data');
    }
    const turnId = parts[2]!.trim();
    const requestId = parts[3]!.trim();
    const decToken = parts[4]!.trim();
    if (!turnId || !requestId || requestId.length > 128) {
      throw new ApiError(400, 'invalid_callback', 'Invalid turnId or requestId in coding:approve');
    }
    const decisionMap = new Map<string, CodingApprovalDecision>([
      ['once', 'allow_once'],
      ['allow_once', 'allow_once'],
      ['session', 'allow_session'],
      ['allow_session', 'allow_session'],
      ['deny', 'deny'],
    ]);
    const decision = decisionMap.get(decToken);
    if (!decision) {
      throw new ApiError(400, 'invalid_callback', `Unsupported approval decision: ${decToken}`);
    }

    const meta = broker.getTurnMeta(turnId);
    if (meta) {
      if (meta.chatId !== chatId) {
        throw new ApiError(403, 'forbidden', 'Cross-chat approval callback is forbidden');
      }
      const botRow = db
        .prepare(`SELECT bot_json FROM bots_registry WHERE bot_user_id = ?`)
        .get(meta.botUserId) as { bot_json: string } | undefined;
      const bot = botRow ? (JSON.parse(botRow.bot_json) as BotRegistryEntry) : null;
      const allowGroup = Boolean(bot?.coding_agent?.allow_group_members);
      if (auth.userId !== meta.ownerUserId && !allowGroup) {
        throw new ApiError(403, 'forbidden', CODING_AGENT_OWNER_ONLY_MSG);
      }
    }

    const approval = broker.getPendingApproval(turnId, requestId);
    if (!meta || !broker.isTurnActive(turnId) || approval?.expired) {
      throw new ApiError(410, 'approval_expired', 'Approval request has expired or turn already finished');
    }

    if (approval?.resolved) {
      sendJson(ctx.res, 200, {
        ok: true,
        already_resolved: true,
        companion_chat_id: chatId,
        toast: '该审批已处理',
      });
      return;
    }

    const resolvedRec = broker.markApprovalResolved(turnId, requestId, decision, meta);
    hub.sendCodingHostCommand(
      meta.ownerUserId,
      {
        cmd: 'resolve_approval',
        turn_id: turnId,
        request_id: requestId,
        owner_user_id: meta.ownerUserId,
        target_device_id: meta.targetDeviceId,
        decision,
      },
      meta.targetSessionId,
    );

    const statusLabel =
      decision === 'allow_once'
        ? '✅ 已允许本次执行'
        : decision === 'allow_session'
          ? '🔓 已在本会话允许'
          : '❌ 已拒绝执行';

    // Strictly use server-tracked approval.messageId (NEVER untrusted caller body.message_id!)
    const msgId = resolvedRec.messageId;
    if (msgId > 0) {
      try {
        db.prepare(
          `UPDATE messages SET inline_keyboard_json = NULL WHERE chat_id = ? AND message_id = ?`,
        ).run(chatId, msgId);
        editMessageAtomic(db, hub, {
          chatId,
          messageId: msgId,
          editorUserId: resolvedRec.botUserId,
          text: `🔐 **权限审批结果** (${resolvedRec.title || requestId}): ${statusLabel}`,
        });
      } catch {
        // Ignore if original card message was deleted
      }
    }

    sendJson(ctx.res, 200, {
      ok: true,
      companion_chat_id: chatId,
      decision,
      toast: statusLabel,
    });
    return;
  }

  if (parts[1] === 'mode') {
    // coding:mode:<botUserId>:<ask|auto_edit|full_access>
    if (parts.length !== 4) {
      throw new ApiError(400, 'invalid_callback', 'Malformed coding:mode callback_data');
    }
    const botUserId = parsePositiveIdStr(parts[2]);
    const mode = parseCodingPermissionMode(parts[3]!);
    if (!botUserId || !mode) {
      throw new ApiError(400, 'invalid_callback', 'Invalid botUserId or permission mode');
    }
    const botRow = db
      .prepare(`SELECT owner_user_id, bot_json FROM bots_registry WHERE bot_user_id = ?`)
      .get(botUserId) as { owner_user_id: number; bot_json: string } | undefined;
    if (!botRow) throw new ApiError(404, 'bot_not_found', 'Coding bot not found');

    const bot = JSON.parse(botRow.bot_json) as BotRegistryEntry;
    if (!bot.coding_agent) {
      throw new ApiError(400, 'not_coding_bot', 'Bot is not configured as a coding agent');
    }
    const botInChat = db
      .prepare(`SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ? AND role != 'banned'`)
      .get(chatId, botUserId);
    if (!botInChat) {
      throw new ApiError(403, 'forbidden', 'Target coding bot is not a member of this chat');
    }
    if (auth.userId !== Number(botRow.owner_user_id) && !bot.coding_agent.allow_group_members) {
      throw new ApiError(403, 'forbidden', CODING_AGENT_OWNER_ONLY_MSG);
    }

    bot.coding_agent.permission_mode = mode as CodingPermissionMode;
    db.prepare(`UPDATE bots_registry SET bot_json = ? WHERE bot_user_id = ?`).run(
      JSON.stringify(bot),
      botUserId,
    );

    const host = broker.resolveOnlineHost(Number(botRow.owner_user_id), bot.coding_agent.bound_device_id);
    if (host) {
      hub.sendCodingHostCommand(
        Number(botRow.owner_user_id),
        {
          cmd: 'control',
          req_id: `cmode_${crypto.randomBytes(6).toString('hex')}`,
          owner_user_id: Number(botRow.owner_user_id),
          target_device_id: host.deviceId,
          bot_user_id: botUserId,
          chat_id: chatId,
          config: bot.coding_agent,
          action: { action: 'set_permission_mode', mode },
        },
        host.sessionId,
      );
    }

    createMessageAtomic(db, hub, {
      chatId,
      senderId: botUserId,
      text: `✅ 权限模式已切换为 \`${mode}\`。`,
    });

    sendJson(ctx.res, 200, {
      ok: true,
      companion_chat_id: chatId,
      mode,
      toast: `Permission mode set to ${mode}`,
    });
    return;
  }

  throw new ApiError(400, 'invalid_callback', `Unknown coding callback action: ${parts[1] ?? ''}`);
}

// ============================================================================
// 4. HTTP Route Registration
// ============================================================================

export function registerCodingAgentRoutes(
  router: HttpRouter,
  db: DatabaseSync,
  broker: CodingAgentBroker,
): void {
  router.post('/api/v1/coding-agents/probe', async (ctx) => {
    const auth = requireAuth(db, ctx);
    let body: { device_id?: unknown; timeout_ms?: unknown } = {};
    try {
      body = await readJsonBody<{ device_id?: unknown; timeout_ms?: unknown }>(ctx.req);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 400)) throw err;
    }

    if (body.device_id !== undefined && body.device_id !== null && typeof body.device_id !== 'string') {
      throw new ApiError(400, 'invalid_device_id', 'device_id must be a string');
    }
    if (
      body.timeout_ms !== undefined &&
      body.timeout_ms !== null &&
      (typeof body.timeout_ms !== 'number' || !Number.isFinite(body.timeout_ms))
    ) {
      throw new ApiError(400, 'invalid_timeout', 'timeout_ms must be a finite number');
    }

    const timeoutMs =
      typeof body.timeout_ms === 'number' && Number.isFinite(body.timeout_ms)
        ? body.timeout_ms
        : 6000;
    const deviceId =
      typeof body.device_id === 'string' && body.device_id.trim()
        ? body.device_id.trim()
        : undefined;

    const result = await broker.probeHostProviders(auth.userId, deviceId, timeoutMs);
    sendJson(ctx.res, 200, {
      ok: true,
      device_id: result.deviceId,
      providers: result.providers,
    });
  });

  router.get('/api/v1/coding-agents/hosts', (ctx) => {
    const auth = requireAuth(db, ctx);
    const hosts = broker.listHostsForUser(auth.userId);
    sendJson(ctx.res, 200, { hosts, total: hosts.length });
  });

  router.get('/api/v1/coding-agents/local-binaries', (ctx) => {
    requireAuth(db, ctx);
    const providers = probeLocalCodingBinaries();
    sendJson(ctx.res, 200, { ok: true, providers });
  });
}
