import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  BOTFATHER_USER_ID,
  CODING_PERMISSION_MODES,
  CODING_PROVIDER_KINDS,
  CODING_SLASH_COMMANDS,
  HERMES_TOOLSET_IDS,
  resolveGrokBotAvatar,
  type BotRegistryEntry,
  type CodingAgentBotConfig,
  type CodingPermissionMode,
  type CodingProviderKind,
  type FabushiBotCreateResponse,
  type FabushiBotSummaryDto,
  type HermesApprovalItem,
  type HermesCommandDescriptor,
  type HermesCronJobDto,
  type HermesKanbanBoardDto,
  type HermesKanbanCardDto,
  type HermesMemoryState,
  type HermesSessionSummary,
  type HermesSkillDto,
  type HermesStreamEvent,
} from '@gpui-telegram/protocol';
import type { ServerConfig } from '../config.js';
import {
  createMessageAtomic,
  ensureChatWriteAccess,
  parseBoundedQueryInt,
  parseOptionalPositiveInt,
} from '../db/queries.js';
import { computeNextCronRunMs, runPrivacyMasking } from '../utils/crypto.js';
import {
  ApiError,
  beginSseStream,
  readJsonBody,
  requireAuth,
  sendJson,
  type HttpRouter,
  type RequestContext,
} from '../utils/http.js';
import type { RealtimeGatewayHub } from '../ws/hub.js';
import {
  getUserMagpieStateSnapshot,
  getUserMaskingConfig,
  runConfiguredLlmCompletion,
  upsertUserMagpieProvider,
} from './magpie.js';

export const HERMES_COMMAND_CATALOG: HermesCommandDescriptor[] = [
  // 1. Session (11)
  { name: 'new', aliases: ['reset'], category: 'session', description: 'Start a fresh Hermes conversation session', usage: '/new [title]' },
  { name: 'clear', aliases: [], category: 'session', description: 'Clear current session message history', usage: '/clear' },
  { name: 'resume', aliases: ['load'], category: 'session', description: 'Resume a saved session by ID', usage: '/resume <session_id>' },
  { name: 'branch', aliases: ['fork'], category: 'session', description: 'Fork current trajectory into a child branch', usage: '/branch [title]' },
  { name: 'title', aliases: ['rename'], category: 'session', description: 'Rename the active Hermes session', usage: '/title <new_title>' },
  { name: 'retry', aliases: ['regenerate'], category: 'session', description: 'Regenerate the last assistant turn', usage: '/retry' },
  { name: 'undo', aliases: [], category: 'session', description: 'Pop the last turn pair from history', usage: '/undo' },
  { name: 'compress', aliases: ['compact'], category: 'session', description: 'Summarize and compact older turns', usage: '/compress' },
  { name: 'checkpoint', aliases: ['savepoint'], category: 'session', description: 'Create a named filesystem/session snapshot', usage: '/checkpoint [label]' },
  { name: 'rollback', aliases: ['restore'], category: 'session', description: 'Restore to a prior checkpoint', usage: '/rollback [checkpoint_id]' },
  { name: 'history', aliases: ['sessions'], category: 'session', description: 'List recent Hermes sessions', usage: '/history' },

  // 2. Model & Provider (7)
  { name: 'model', aliases: ['m'], category: 'model_and_provider', description: 'Switch or inspect active LLM model', usage: '/model [model_id]' },
  { name: 'provider', aliases: [], category: 'model_and_provider', description: 'Switch active Magpie LLM provider', usage: '/provider [provider_id]' },
  { name: 'providers', aliases: [], category: 'model_and_provider', description: 'List configured Magpie providers', usage: '/providers' },
  { name: 'effort', aliases: ['thinking'], category: 'model_and_provider', description: 'Configure reasoning effort level', usage: '/effort [low|medium|high]' },
  { name: 'temperature', aliases: ['temp'], category: 'model_and_provider', description: 'Set sampling temperature', usage: '/temperature <0.0-2.0>' },
  { name: 'fallback', aliases: [], category: 'model_and_provider', description: 'Toggle failover routing policy', usage: '/fallback [on|off]' },
  { name: 'routing', aliases: [], category: 'model_and_provider', description: 'Switch Magpie routing strategy', usage: '/routing [smart|order|rotate|cheapest]' },

  // 3. Tools & Skills (11)
  { name: 'tools', aliases: [], category: 'tools_and_skills', description: 'List active Hermes tools', usage: '/tools' },
  { name: 'toolsets', aliases: [], category: 'tools_and_skills', description: 'Inspect or toggle the 29 toolsets', usage: '/toolsets [preset]' },
  { name: 'skills', aliases: [], category: 'tools_and_skills', description: 'List installed Hermes skills', usage: '/skills' },
  { name: 'skill', aliases: [], category: 'tools_and_skills', description: 'Invoke or inspect a named skill', usage: '/skill <name>' },
  { name: 'reload-mcp', aliases: ['mcp'], category: 'tools_and_skills', description: 'Reload connected MCP tool servers', usage: '/reload-mcp' },
  { name: 'quarantine', aliases: [], category: 'tools_and_skills', description: 'Inspect quarantined skills', usage: '/quarantine' },
  { name: 'browser', aliases: [], category: 'tools_and_skills', description: 'Check headless browser toolset status', usage: '/browser' },
  { name: 'terminal', aliases: ['exec'], category: 'tools_and_skills', description: 'Inspect sandboxed terminal environment', usage: '/terminal' },
  { name: 'vision', aliases: [], category: 'tools_and_skills', description: 'Check multimodal vision capabilities', usage: '/vision' },
  { name: 'subagents', aliases: [], category: 'tools_and_skills', description: 'Inspect parallel subagent pool', usage: '/subagents' },
  { name: 'connections', aliases: [], category: 'tools_and_skills', description: 'List external platform connectors', usage: '/connections' },

  // 4. Memory & Persona (6)
  { name: 'personality', aliases: ['persona', 'soul'], category: 'memory_and_persona', description: 'View or update SOUL.md persona', usage: '/personality [prompt]' },
  { name: 'prompt', aliases: ['system'], category: 'memory_and_persona', description: 'Inspect assembled system prompt', usage: '/prompt' },
  { name: 'memory', aliases: ['mem'], category: 'memory_and_persona', description: 'Inspect bounded MEMORY.md & USER.md', usage: '/memory [add <note>]' },
  { name: 'remember', aliases: [], category: 'memory_and_persona', description: 'Append an entry to MEMORY.md (<=2200 chars)', usage: '/remember <fact>' },
  { name: 'profile', aliases: ['user'], category: 'memory_and_persona', description: 'Append a preference to USER.md (<=1375 chars)', usage: '/profile <pref>' },
  { name: 'honcho', aliases: [], category: 'memory_and_persona', description: 'Query dialectic Honcho user model', usage: '/honcho [question]' },

  // 5. Inspection & Export (8)
  { name: 'help', aliases: ['h', 'commands'], category: 'inspection_and_export', description: 'List all 61 Hermes slash commands', usage: '/help [category]' },
  { name: 'status', aliases: ['info'], category: 'inspection_and_export', description: 'Show Hermes runtime, model, and memory status', usage: '/status' },
  { name: 'usage', aliases: ['cost', 'tokens'], category: 'inspection_and_export', description: 'Show token and cost ledger summary', usage: '/usage' },
  { name: 'insights', aliases: ['analytics'], category: 'inspection_and_export', description: 'Show tool call and latency insights', usage: '/insights' },
  { name: 'context', aliases: ['ctx'], category: 'inspection_and_export', description: 'Show context window token breakdown', usage: '/context' },
  { name: 'export', aliases: [], category: 'inspection_and_export', description: 'Export PII-redacted trajectory JSON', usage: '/export' },
  { name: 'search', aliases: ['find'], category: 'inspection_and_export', description: 'Full-text search across Hermes sessions', usage: '/search <query>' },
  { name: 'diff', aliases: [], category: 'inspection_and_export', description: 'Show workspace modifications since checkpoint', usage: '/diff' },

  // 6. Workflow & Automation (8)
  { name: 'plan', aliases: [], category: 'workflow_and_automation', description: 'Generate a structured multi-step plan', usage: '/plan <goal>' },
  { name: 'kanban', aliases: ['board'], category: 'workflow_and_automation', description: 'Inspect or add cards to Kanban board', usage: '/kanban [add <title>]' },
  { name: 'cron', aliases: ['schedule'], category: 'workflow_and_automation', description: 'List or schedule 5-field cron jobs', usage: '/cron' },
  { name: 'heartbeat', aliases: ['pulse'], category: 'workflow_and_automation', description: 'Check or trigger proactive heartbeat', usage: '/heartbeat' },
  { name: 'background', aliases: ['bg'], category: 'workflow_and_automation', description: 'Dispatch prompt as background task', usage: '/background <prompt>' },
  { name: 'btw', aliases: ['aside'], category: 'workflow_and_automation', description: 'Ask an ephemeral side question without polluting context', usage: '/btw <question>' },
  { name: 'todo', aliases: [], category: 'workflow_and_automation', description: 'Show session task checklist', usage: '/todo' },
  { name: 'clarify', aliases: [], category: 'workflow_and_automation', description: 'Toggle interactive clarification prompts', usage: '/clarify' },

  // 7. Safety & Control (5)
  { name: 'yolo', aliases: [], category: 'safety_and_control', description: 'Toggle autonomous tool execution mode', usage: '/yolo [on|off]' },
  { name: 'approve', aliases: [], category: 'safety_and_control', description: 'Approve pending security command', usage: '/approve [approval_id]' },
  { name: 'deny', aliases: ['reject'], category: 'safety_and_control', description: 'Deny pending security command', usage: '/deny [approval_id]' },
  { name: 'stop', aliases: ['abort'], category: 'safety_and_control', description: 'Abort active streaming turn', usage: '/stop' },
  { name: 'privacy', aliases: ['mask'], category: 'safety_and_control', description: 'Inspect Magpie PII privacy masking status', usage: '/privacy' },

  // 8. Modes & UI (5) -> Total = 61 commands
  { name: 'studio', aliases: ['panel'], category: 'modes_and_ui', description: 'Open Hermes 6-Tab Studio drawer', usage: '/studio [tab]' },
  { name: 'magpie', aliases: ['gateway'], category: 'modes_and_ui', description: 'Open Magpie LLM Gateway configuration', usage: '/magpie' },
  { name: 'voice', aliases: ['talk'], category: 'modes_and_ui', description: 'Toggle Full-Duplex Talk Mode', usage: '/voice' },
  { name: 'computer', aliases: ['desktop'], category: 'modes_and_ui', description: 'Open Remote Computer Workbench', usage: '/computer' },
  { name: 'verbose', aliases: ['debug'], category: 'modes_and_ui', description: 'Toggle verbose tool trace output', usage: '/verbose' },
];

const DANGEROUS_SIMPLE_COMMAND_RE =
  /\b(?:rm[ \t]+-rf|mkfs|dd[ \t]+if=|chmod[ \t]+777|sudo[ \t]+rm)\b/i;
const SKILL_SIMPLE_EXFIL_RE = /(?:eval[ \t]*\(|nc[ \t]+-e|bash[ \t]+-i)/i;

function hasDangerousCommand(text: string): boolean {
  if (DANGEROUS_SIMPLE_COMMAND_RE.test(text)) return true;
  for (const line of text.split(/\r?\n/)) {
    const curlMatch = /\bcurl[ \t]+[^\s|]/i.exec(line);
    if (curlMatch) {
      const rest = line.slice(curlMatch.index + curlMatch[0].length);
      if (/\|[ \t]*(?:ba)?sh\b/i.test(rest)) return true;
    }
  }
  return false;
}

function hasSkillExfilPattern(text: string): boolean {
  if (SKILL_SIMPLE_EXFIL_RE.test(text)) return true;
  for (const line of text.split(/\r?\n/)) {
    const curlMatch = /\bcurl[ \t]+/i.exec(line);
    if (curlMatch && /\$[A-Z_]*KEY/i.test(line.slice(curlMatch.index + curlMatch[0].length))) {
      return true;
    }
    const wgetMatch = /\bwget[ \t]+/i.exec(line);
    if (wgetMatch && /token/i.test(line.slice(wgetMatch.index + wgetMatch[0].length))) {
      return true;
    }
  }
  return false;
}

const BOT_USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{3,31}$/;
const CODING_PROVIDER_KIND_SET = new Set<string>(CODING_PROVIDER_KINDS);
const CODING_PERMISSION_MODE_SET = new Set<string>(CODING_PERMISSION_MODES);

const DEFAULT_HEARTBEAT_JSON = JSON.stringify({
  enabled: false,
  interval_secs: 300,
  active_chat_id: null,
  tick_count: 0,
});

interface StoredHermesMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  reasoning?: string;
  tool_calls?: Array<{ id: string; name: string; arguments: unknown; output: string }>;
  created_at_ms: number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function getHermesKv(db: DatabaseSync, userId: number, key: string, fallback = ''): string {
  const row = db
    .prepare(`SELECT kv_value FROM hermes_kv WHERE user_id = ? AND kv_key = ?`)
    .get(userId, key) as { kv_value: string } | undefined;
  return row?.kv_value ?? fallback;
}

function setHermesKv(db: DatabaseSync, userId: number, key: string, value: string): void {
  db.prepare(`
    INSERT OR REPLACE INTO hermes_kv (user_id, kv_key, kv_value, updated_at_ms)
    VALUES (?, ?, ?, ?)
  `).run(userId, key, value, Date.now());
}

export function getHermesMemoryState(db: DatabaseSync, userId: number): HermesMemoryState {
  const memRaw = getHermesKv(db, userId, 'memory_md', '');
  const userRaw = getHermesKv(db, userId, 'user_md', '');
  const soul = getHermesKv(
    db,
    userId,
    'soul_md',
    'You are Fabushi AI (Hermes), a precise systems engineering assistant.',
  );
  const obsRaw = getHermesKv(db, userId, 'honcho_obs', '[]');
  let obs: string[] = [];
  try {
    const parsed = JSON.parse(obsRaw);
    obs = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    obs = [];
  }

  return {
    memory: {
      raw: memRaw,
      entries: memRaw ? memRaw.split('\n§\n').map((s) => s.trim()).filter(Boolean) : [],
      chars: memRaw.length,
      limit: 2200,
    },
    user: {
      raw: userRaw,
      entries: userRaw ? userRaw.split('\n§\n').map((s) => s.trim()).filter(Boolean) : [],
      chars: userRaw.length,
      limit: 1375,
    },
    soul,
    honcho_observations: obs,
  };
}

function scanSkillSecurity(skillBody: string): string[] {
  const findings: string[] = [];
  if (hasSkillExfilPattern(skillBody)) {
    findings.push('Detected suspicious secret exfiltration or remote shell execution pattern');
  }
  if (hasDangerousCommand(skillBody)) {
    findings.push('Detected destructive shell command in skill instructions');
  }
  return findings;
}

function getOrCreateHermesSession(
  db: DatabaseSync,
  userId: number,
  sessionId?: string,
  chatId?: number | null,
  defaultModel = '',
): {
  session_id: string;
  title: string;
  model: string;
  messages: StoredHermesMessage[];
  checkpoints: Array<{ id: string; label: string; message_count: number; created_at_ms: number }>;
  total_tokens: number;
  total_cost_usd: number;
} {
  if (sessionId) {
    const row = db
      .prepare(`SELECT * FROM hermes_sessions WHERE session_id = ? AND user_id = ?`)
      .get(sessionId, userId) as Record<string, unknown> | undefined;
    if (row) {
      return {
        session_id: String(row.session_id),
        title: String(row.title),
        model: String(row.model),
        messages: JSON.parse(String(row.messages_json)) as StoredHermesMessage[],
        checkpoints: JSON.parse(String(row.checkpoints_json || '[]')),
        total_tokens: Number(row.total_tokens),
        total_cost_usd: Number(row.total_cost_usd),
      };
    }
  }

  const latestRow = db
    .prepare(
      `SELECT * FROM hermes_sessions WHERE user_id = ? AND source != 'group' ORDER BY updated_at_ms DESC LIMIT 1`,
    )
    .get(userId) as Record<string, unknown> | undefined;

  if (latestRow && !sessionId) {
    return {
      session_id: String(latestRow.session_id),
      title: String(latestRow.title),
      model: String(latestRow.model),
      messages: JSON.parse(String(latestRow.messages_json)) as StoredHermesMessage[],
      checkpoints: JSON.parse(String(latestRow.checkpoints_json || '[]')),
      total_tokens: Number(latestRow.total_tokens),
      total_cost_usd: Number(latestRow.total_cost_usd),
    };
  }

  const newId = sessionId || `hses_${crypto.randomBytes(8).toString('hex')}`;
  const now = Date.now();
  db.prepare(`
    INSERT INTO hermes_sessions (
      session_id, user_id, parent_session_id, chat_id, bot_id, title, source, model,
      messages_json, checkpoints_json, total_tokens, total_cost_usd, created_at_ms, updated_at_ms
    ) VALUES (?, ?, NULL, ?, 777000, 'Fabushi Session', 'web', ?, '[]', '[]', 0, 0, ?, ?)
  `).run(newId, userId, chatId ?? null, defaultModel, now, now);

  return {
    session_id: newId,
    title: 'Fabushi Session',
    model: defaultModel,
    messages: [],
    checkpoints: [],
    total_tokens: 0,
    total_cost_usd: 0,
  };
}

export function validateCodingAgentConfig(raw: unknown): CodingAgentBotConfig {
  if (!isPlainObject(raw)) {
    throw new ApiError(400, 'invalid_coding_agent', 'coding_agent must be a plain object');
  }
  const providerKind = raw.provider_kind;
  if (typeof providerKind !== 'string' || !CODING_PROVIDER_KIND_SET.has(providerKind)) {
    throw new ApiError(
      400,
      'invalid_provider_kind',
      `Unsupported coding_agent.provider_kind: ${String(providerKind)}`,
    );
  }
  const permMode = raw.permission_mode ?? 'ask';
  if (typeof permMode !== 'string' || !CODING_PERMISSION_MODE_SET.has(permMode)) {
    throw new ApiError(
      400,
      'invalid_permission_mode',
      `Unsupported coding_agent.permission_mode: ${String(permMode)}`,
    );
  }
  let extraArgs: string[] = [];
  if (raw.extra_args !== undefined) {
    if (!Array.isArray(raw.extra_args) || !raw.extra_args.every((a) => typeof a === 'string')) {
      throw new ApiError(400, 'invalid_coding_agent', 'coding_agent.extra_args must be a string array');
    }
    extraArgs = raw.extra_args.map((a) => a.trim()).filter(Boolean);
  }

  const workspacePath =
    typeof raw.workspace_path === 'string' ? raw.workspace_path.trim() : '';

  return {
    provider_kind: providerKind as CodingProviderKind,
    workspace_path: workspacePath,
    use_worktree: Boolean(raw.use_worktree),
    permission_mode: permMode as CodingPermissionMode,
    executable_override:
      typeof raw.executable_override === 'string' && raw.executable_override.trim()
        ? raw.executable_override.trim()
        : null,
    extra_args: extraArgs,
    bound_device_id:
      typeof raw.bound_device_id === 'string' && raw.bound_device_id.trim()
        ? raw.bound_device_id.trim()
        : null,
    bound_node_id:
      typeof raw.bound_node_id === 'string' && raw.bound_node_id.trim()
        ? raw.bound_node_id.trim()
        : null,
    model_override:
      typeof raw.model_override === 'string' && raw.model_override.trim()
        ? raw.model_override.trim()
        : null,
    allow_group_members: Boolean(raw.allow_group_members),
  };
}

function findCompanionChatId(db: DatabaseSync, userId: number, botUserId: number): number | null {
  const row = db
    .prepare(
      `SELECT c.chat_id
       FROM chats c
       INNER JOIN chat_members cm1 ON cm1.chat_id = c.chat_id AND cm1.user_id = ?
       INNER JOIN chat_members cm2 ON cm2.chat_id = c.chat_id AND cm2.user_id = ?
       WHERE c.chat_type = 0
       ORDER BY c.chat_id ASC LIMIT 1`,
    )
    .get(userId, botUserId) as { chat_id: number } | undefined;
  return row ? Number(row.chat_id) : null;
}

function buildFabushiBotSummary(
  db: DatabaseSync,
  viewerUserId: number,
  entry: BotRegistryEntry,
): FabushiBotSummaryDto {
  const agentId = entry.agent_id || entry.username.toLowerCase();
  const resolvedAvatar = resolveGrokBotAvatar(agentId, {
    shape: entry.avatar_shape,
    color: entry.avatar_color,
  });
  const mem = getHermesMemoryState(db, viewerUserId);
  const skillCnt = db
    .prepare(`SELECT COUNT(*) AS cnt FROM hermes_skills WHERE user_id = ?`)
    .get(viewerUserId) as { cnt: number };
  const companionChatId = findCompanionChatId(db, viewerUserId, entry.bot_user_id);

  return {
    bot_user_id: entry.bot_user_id,
    owner_user_id: entry.owner_user_id,
    agent_id: agentId,
    username: entry.username,
    display_name: entry.display_name,
    description: entry.description || '',
    title: entry.about || entry.display_name,
    avatar_shape: resolvedAvatar.shape,
    avatar_color: resolvedAvatar.color,
    preferred_model: entry.preferred_model || '',
    thinking_level: entry.thinking_level || 'medium',
    approval_mode: entry.approval_mode || 'ask',
    toolset_preset: entry.toolset_preset || 'hermes-telegram',
    notify_on_agent_updates: true,
    hidden_from_sidebar: false,
    memory_entries_count: mem.memory.entries.length,
    skills_count: Number(skillCnt.cnt ?? 0),
    execution_state: 'idle',
    companion_chat_id: companionChatId,
    coding_agent: entry.owner_user_id === viewerUserId ? (entry.coding_agent ?? null) : null,
  };
}

export function executeSlashCommandInternal(
  db: DatabaseSync,
  userId: number,
  rawCommand: string,
  sessionId?: string,
  chatId?: number | null,
  config?: ServerConfig,
): {
  ok: boolean;
  error_code?: string;
  http_status?: number;
  command: string;
  response_text: string;
  session_id: string;
  ui_effect: { kind: string; payload?: unknown };
} {
  const trimmed = rawCommand.trim();
  const withoutSlash = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
  const spaceIdx = withoutSlash.indexOf(' ');
  const rawVerb = (spaceIdx === -1 ? withoutSlash : withoutSlash.slice(0, spaceIdx)).split('@')[0]!;
  const argStr = spaceIdx === -1 ? '' : withoutSlash.slice(spaceIdx + 1).trim();

  const spec = HERMES_COMMAND_CATALOG.find(
    (c) =>
      c.name.toLowerCase() === rawVerb.toLowerCase() ||
      c.aliases.some((a) => a.toLowerCase() === rawVerb.toLowerCase()),
  );

  const magpieSnap = config ? getUserMagpieStateSnapshot(db, config, userId) : null;
  const session = getOrCreateHermesSession(
    db,
    userId,
    sessionId,
    chatId,
    magpieSnap?.active_model ?? '',
  );
  const now = Date.now();

  if (!spec) {
    return {
      ok: false,
      error_code: 'unknown_command',
      http_status: 400,
      command: rawVerb,
      response_text: `Unknown command \`/${rawVerb}\`. Type \`/help\` to view all ${HERMES_COMMAND_CATALOG.length} available commands.`,
      session_id: session.session_id,
      ui_effect: { kind: 'none' },
    };
  }

  switch (spec.name.toLowerCase()) {
    case 'help': {
      const filterCat = argStr.trim().toLowerCase();
      const grouped = new Map<string, string[]>();
      for (const c of HERMES_COMMAND_CATALOG) {
        if (filterCat && !c.category.toLowerCase().includes(filterCat)) continue;
        const list = grouped.get(c.category) ?? [];
        list.push(`/${c.name}`);
        grouped.set(c.category, list);
      }
      const lines = Array.from(grouped.entries()).map(
        ([cat, cmds]) => `• **${cat}** (${cmds.length}): ${cmds.join(', ')}`,
      );
      return {
        ok: true,
        command: 'help',
        response_text: `**Fabushi / Hermes Slash Commands (${HERMES_COMMAND_CATALOG.length} total)**:\n${lines.join('\n')}`,
        session_id: session.session_id,
        ui_effect: { kind: 'none' },
      };
    }

    case 'status': {
      const mem = getHermesMemoryState(db, userId);
      const toolsets = JSON.parse(getHermesKv(db, userId, 'enabled_toolsets', '[]')) as string[];
      const activeModel = magpieSnap?.active_model || session.model || '(unconfigured)';
      const activeProv = magpieSnap?.active_provider || '(unconfigured)';
      return {
        ok: true,
        command: 'status',
        response_text: `**Fabushi Agent Runtime Status**\n• Session: \`${session.session_id}\` (${session.messages.length} msgs)\n• Provider: \`${activeProv}\` · Model: \`${activeModel}\`\n• Toolsets enabled: ${toolsets.length}/${HERMES_TOOLSET_IDS.length}\n• MEMORY.md: ${mem.memory.chars}/2200 chars · USER.md: ${mem.user.chars}/1375 chars`,
        session_id: session.session_id,
        ui_effect: { kind: 'none' },
      };
    }

    case 'new': {
      const newSid = `hses_${crypto.randomBytes(8).toString('hex')}`;
      const title = argStr || 'New Studio Session';
      db.prepare(`
        INSERT INTO hermes_sessions (
          session_id, user_id, chat_id, bot_id, title, source, model,
          messages_json, checkpoints_json, total_tokens, total_cost_usd, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, 777000, ?, 'slash', ?, '[]', '[]', 0, 0, ?, ?)
      `).run(newSid, userId, chatId ?? null, title, magpieSnap?.active_model ?? session.model, now, now);
      return {
        ok: true,
        command: 'new',
        response_text: `Started new session **${title}** (\`${newSid}\`).`,
        session_id: newSid,
        ui_effect: { kind: 'switch_session', payload: { session_id: newSid } },
      };
    }

    case 'clear': {
      db.prepare(`UPDATE hermes_sessions SET messages_json = '[]', updated_at_ms = ? WHERE session_id = ?`).run(
        now,
        session.session_id,
      );
      return {
        ok: true,
        command: 'clear',
        response_text: `Cleared message history in session \`${session.session_id}\`.`,
        session_id: session.session_id,
        ui_effect: { kind: 'refresh_session' },
      };
    }

    case 'branch': {
      const childId = `hses_${crypto.randomBytes(8).toString('hex')}`;
      const branchTitle = argStr || `${session.title} (Branch)`;
      db.prepare(`
        INSERT INTO hermes_sessions (
          session_id, user_id, parent_session_id, chat_id, bot_id, title, source, model,
          messages_json, checkpoints_json, total_tokens, total_cost_usd, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, 777000, ?, 'branch', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        childId,
        userId,
        session.session_id,
        chatId ?? null,
        branchTitle,
        session.model,
        JSON.stringify(session.messages),
        JSON.stringify(session.checkpoints),
        session.total_tokens,
        session.total_cost_usd,
        now,
        now,
      );
      return {
        ok: true,
        command: 'branch',
        response_text: `Branched session \`${session.session_id}\` -> **${branchTitle}** (\`${childId}\`).`,
        session_id: childId,
        ui_effect: { kind: 'switch_session', payload: { session_id: childId } },
      };
    }

    case 'title': {
      const nextTitle = argStr || 'Untitled Session';
      db.prepare(`UPDATE hermes_sessions SET title = ?, updated_at_ms = ? WHERE session_id = ?`).run(
        nextTitle,
        now,
        session.session_id,
      );
      return {
        ok: true,
        command: 'title',
        response_text: `Renamed session to **${nextTitle}**.`,
        session_id: session.session_id,
        ui_effect: { kind: 'refresh_session' },
      };
    }

    case 'undo': {
      const trimmedMsgs = session.messages.slice(0, Math.max(0, session.messages.length - 2));
      db.prepare(`UPDATE hermes_sessions SET messages_json = ?, updated_at_ms = ? WHERE session_id = ?`).run(
        JSON.stringify(trimmedMsgs),
        now,
        session.session_id,
      );
      return {
        ok: true,
        command: 'undo',
        response_text: `Reverted last turn (${trimmedMsgs.length} messages remaining).`,
        session_id: session.session_id,
        ui_effect: { kind: 'refresh_session' },
      };
    }

    case 'compress': {
      if (session.messages.length <= 4) {
        return {
          ok: true,
          command: 'compress',
          response_text: `Session \`${session.session_id}\` has ${session.messages.length} messages; nothing to compact.`,
          session_id: session.session_id,
          ui_effect: { kind: 'none' },
        };
      }
      const older = session.messages.slice(0, session.messages.length - 4);
      const recent = session.messages.slice(-4);
      const summaryLines = older
        .map((m) => `${m.role}: ${m.content.slice(0, 100)}`)
        .join('\n')
        .slice(0, 1200);
      const compacted: StoredHermesMessage[] = [
        {
          id: `cmp_${crypto.randomBytes(4).toString('hex')}`,
          role: 'system',
          content: `[Compacted ${older.length} earlier messages]\n${summaryLines}`,
          created_at_ms: now,
        },
        ...recent,
      ];
      db.prepare(`UPDATE hermes_sessions SET messages_json = ?, updated_at_ms = ? WHERE session_id = ?`).run(
        JSON.stringify(compacted),
        now,
        session.session_id,
      );
      return {
        ok: true,
        command: 'compress',
        response_text: `Compacted ${older.length} older messages into a summary (${compacted.length} messages remaining).`,
        session_id: session.session_id,
        ui_effect: { kind: 'refresh_session' },
      };
    }

    case 'checkpoint': {
      const cpId = `cp_${crypto.randomBytes(4).toString('hex')}`;
      const checkpoints = [
        ...session.checkpoints,
        {
          id: cpId,
          label: argStr || `Snapshot #${session.checkpoints.length + 1}`,
          message_count: session.messages.length,
          created_at_ms: now,
        },
      ];
      db.prepare(`UPDATE hermes_sessions SET checkpoints_json = ?, updated_at_ms = ? WHERE session_id = ?`).run(
        JSON.stringify(checkpoints),
        now,
        session.session_id,
      );
      return {
        ok: true,
        command: 'checkpoint',
        response_text: `Created checkpoint \`${cpId}\` at message #${session.messages.length}.`,
        session_id: session.session_id,
        ui_effect: { kind: 'none' },
      };
    }

    case 'rollback': {
      const targetCp = argStr
        ? session.checkpoints.find((c) => c.id === argStr)
        : session.checkpoints[session.checkpoints.length - 1];
      const keepCount = targetCp ? targetCp.message_count : 0;
      const rolledMsgs = session.messages.slice(0, keepCount);
      db.prepare(`UPDATE hermes_sessions SET messages_json = ?, updated_at_ms = ? WHERE session_id = ?`).run(
        JSON.stringify(rolledMsgs),
        now,
        session.session_id,
      );
      return {
        ok: true,
        command: 'rollback',
        response_text: targetCp
          ? `Rolled back to checkpoint \`${targetCp.id}\` (${keepCount} messages).`
          : `Rolled back session to initial empty state.`,
        session_id: session.session_id,
        ui_effect: { kind: 'refresh_session' },
      };
    }

    case 'model': {
      if (argStr) {
        if (argStr === 'hermes-local-v1' || argStr === 'hermes-fast-v1') {
          throw new ApiError(400, 'invalid_model', 'Legacy simulated models are not supported');
        }
        db.prepare(`UPDATE hermes_sessions SET model = ?, updated_at_ms = ? WHERE session_id = ?`).run(
          argStr,
          now,
          session.session_id,
        );
        return {
          ok: true,
          command: 'model',
          response_text: `Switched active model to \`${argStr}\`.`,
          session_id: session.session_id,
          ui_effect: { kind: 'model_changed', payload: { model: argStr } },
        };
      }
      return {
        ok: true,
        command: 'model',
        response_text: `Current model: \`${session.model || magpieSnap?.active_model || '(unconfigured)'}\`.`,
        session_id: session.session_id,
        ui_effect: { kind: 'none' },
      };
    }

    case 'provider':
    case 'providers': {
      const list = magpieSnap?.providers ?? [];
      if (spec.name === 'provider' && argStr) {
        const match = list.find((p) => p.provider_id === argStr);
        if (!match) {
          throw new ApiError(404, 'provider_not_found', `Provider '${argStr}' not found`);
        }
        if (config) {
          upsertUserMagpieProvider(db, config, userId, { activate: true }, match.provider_id, true);
        }
        return {
          ok: true,
          command: 'provider',
          response_text: `Switched active provider to **${match.name}** (\`${match.provider_id}\`).`,
          session_id: session.session_id,
          ui_effect: { kind: 'open_magpie' },
        };
      }
      return {
        ok: true,
        command: spec.name,
        response_text:
          list.length > 0
            ? `Configured providers (${list.length}):\n${list.map((p) => `• \`${p.provider_id}\` (${p.default_model}) ${p.enabled ? 'enabled' : 'disabled'}`).join('\n')}`
            : 'No AI providers configured yet. Open Magpie LLM Gateway to add a provider.',
        session_id: session.session_id,
        ui_effect: { kind: 'open_magpie' },
      };
    }

    case 'effort': {
      const allowed = new Set(['low', 'medium', 'high']);
      const cur = getHermesKv(db, userId, 'reasoning_effort', 'medium');
      if (argStr) {
        const val = argStr.toLowerCase();
        if (!allowed.has(val)) {
          throw new ApiError(400, 'invalid_effort', 'Effort must be low, medium, or high');
        }
        setHermesKv(db, userId, 'reasoning_effort', val);
        return {
          ok: true,
          command: 'effort',
          response_text: `Reasoning effort set to \`${val}\`.`,
          session_id: session.session_id,
          ui_effect: { kind: 'none' },
        };
      }
      return {
        ok: true,
        command: 'effort',
        response_text: `Current reasoning effort: \`${cur}\`.`,
        session_id: session.session_id,
        ui_effect: { kind: 'none' },
      };
    }

    case 'temperature': {
      const cur = getHermesKv(db, userId, 'temperature', '0.7');
      if (argStr) {
        const num = Number(argStr);
        if (!Number.isFinite(num) || num < 0 || num > 2) {
          throw new ApiError(400, 'invalid_temperature', 'Temperature must be between 0.0 and 2.0');
        }
        setHermesKv(db, userId, 'temperature', String(num));
        return {
          ok: true,
          command: 'temperature',
          response_text: `Sampling temperature set to \`${num}\`.`,
          session_id: session.session_id,
          ui_effect: { kind: 'none' },
        };
      }
      return {
        ok: true,
        command: 'temperature',
        response_text: `Current sampling temperature: \`${cur}\`.`,
        session_id: session.session_id,
        ui_effect: { kind: 'none' },
      };
    }

    case 'fallback': {
      const cur = getHermesKv(db, userId, 'routing_fallback', 'off');
      if (argStr) {
        const next = argStr.toLowerCase() === 'on' ? 'on' : 'off';
        setHermesKv(db, userId, 'routing_fallback', next);
        return {
          ok: true,
          command: 'fallback',
          response_text: `Failover routing set to \`${next}\`.`,
          session_id: session.session_id,
          ui_effect: { kind: 'none' },
        };
      }
      return {
        ok: true,
        command: 'fallback',
        response_text: `Current failover routing: \`${cur}\`.`,
        session_id: session.session_id,
        ui_effect: { kind: 'none' },
      };
    }

    case 'routing': {
      const cur = getHermesKv(db, userId, 'routing_strategy', magpieSnap?.routing_strategy ?? 'smart');
      if (argStr) {
        const next = argStr.toLowerCase();
        setHermesKv(db, userId, 'routing_strategy', next);
        return {
          ok: true,
          command: 'routing',
          response_text: `Routing strategy set to \`${next}\`.`,
          session_id: session.session_id,
          ui_effect: { kind: 'open_magpie' },
        };
      }
      return {
        ok: true,
        command: 'routing',
        response_text: `Current routing strategy: \`${cur}\`.`,
        session_id: session.session_id,
        ui_effect: { kind: 'none' },
      };
    }

    case 'tools':
    case 'toolsets': {
      let enabled = JSON.parse(getHermesKv(db, userId, 'enabled_toolsets', '[]')) as string[];
      if (argStr) {
        if (argStr === 'minimal') enabled = ['core', 'memory', 'clarify', 'todo'];
        else if (argStr === 'safe') enabled = ['core', 'web', 'file', 'memory', 'skills', 'planning', 'reasoning', 'session_search'];
        else if (argStr === 'full') enabled = [...HERMES_TOOLSET_IDS];
        setHermesKv(db, userId, 'enabled_toolsets', JSON.stringify(enabled));
      }
      return {
        ok: true,
        command: spec.name,
        response_text: `Enabled toolsets (${enabled.length}/${HERMES_TOOLSET_IDS.length}): ${enabled.join(', ') || '(none)'}`,
        session_id: session.session_id,
        ui_effect: { kind: 'open_studio', payload: { tab: 'toolsets' } },
      };
    }

    case 'skills':
    case 'skill':
    case 'quarantine': {
      const rows = db
        .prepare(`SELECT skill_json FROM hermes_skills WHERE user_id = ? ORDER BY updated_at_ms DESC`)
        .all(userId) as Array<{ skill_json: string }>;
      const allSkills = rows.map((r) => JSON.parse(r.skill_json) as HermesSkillDto);
      if (spec.name === 'quarantine') {
        const q = allSkills.filter((s) => s.status === 'quarantined');
        return {
          ok: true,
          command: 'quarantine',
          response_text:
            q.length > 0
              ? `Quarantined skills (${q.length}):\n${q.map((s) => `• \`${s.name}\` (${s.security_findings.join('; ')})`).join('\n')}`
              : 'No quarantined skills.',
          session_id: session.session_id,
          ui_effect: { kind: 'open_studio', payload: { tab: 'skills' } },
        };
      }
      if (spec.name === 'skill' && argStr) {
        const match = allSkills.find((s) => s.name === argStr.toLowerCase());
        if (!match) throw new ApiError(404, 'skill_not_found', `Skill '${argStr}' not found`);
        return {
          ok: true,
          command: 'skill',
          response_text: `**Skill \`${match.name}\`** (${match.status}): ${match.description || '(no description)'}`,
          session_id: session.session_id,
          ui_effect: { kind: 'open_studio', payload: { tab: 'skills' } },
        };
      }
      return {
        ok: true,
        command: 'skills',
        response_text:
          allSkills.length > 0
            ? `Installed skills (${allSkills.length}):\n${allSkills.map((s) => `• \`${s.name}\` [${s.status}]`).join('\n')}`
            : 'No skills installed.',
        session_id: session.session_id,
        ui_effect: { kind: 'open_studio', payload: { tab: 'skills' } },
      };
    }

    case 'memory':
    case 'remember': {
      const mem = getHermesMemoryState(db, userId);
      const toAdd = spec.name === 'remember' ? argStr : argStr.replace(/^add\s+/i, '');
      if (toAdd) {
        const nextRaw = mem.memory.raw ? `${mem.memory.raw}\n§\n${toAdd}` : toAdd;
        if (nextRaw.length > 2200) {
          throw new ApiError(400, 'memory_limit_exceeded', 'MEMORY.md exceeds 2200 character budget');
        }
        setHermesKv(db, userId, 'memory_md', nextRaw);
        return {
          ok: true,
          command: spec.name,
          response_text: `Saved to MEMORY.md (${nextRaw.length}/2200 chars).`,
          session_id: session.session_id,
          ui_effect: { kind: 'open_studio', payload: { tab: 'memory' } },
        };
      }
      return {
        ok: true,
        command: 'memory',
        response_text: `**MEMORY.md** (${mem.memory.chars}/2200 chars):\n${mem.memory.entries.map((e) => `• ${e}`).join('\n') || '(empty)'}`,
        session_id: session.session_id,
        ui_effect: { kind: 'open_studio', payload: { tab: 'memory' } },
      };
    }

    case 'profile': {
      const mem = getHermesMemoryState(db, userId);
      if (argStr) {
        const nextRaw = mem.user.raw ? `${mem.user.raw}\n§\n${argStr}` : argStr;
        if (nextRaw.length > 1375) {
          throw new ApiError(400, 'user_limit_exceeded', 'USER.md exceeds 1375 character budget');
        }
        setHermesKv(db, userId, 'user_md', nextRaw);
        return {
          ok: true,
          command: 'profile',
          response_text: `Saved preference to USER.md (${nextRaw.length}/1375 chars).`,
          session_id: session.session_id,
          ui_effect: { kind: 'open_studio', payload: { tab: 'memory' } },
        };
      }
      return {
        ok: true,
        command: 'profile',
        response_text: `**USER.md** (${mem.user.chars}/1375 chars):\n${mem.user.entries.map((e) => `• ${e}`).join('\n') || '(empty)'}`,
        session_id: session.session_id,
        ui_effect: { kind: 'open_studio', payload: { tab: 'memory' } },
      };
    }

    case 'personality':
    case 'prompt': {
      if (spec.name === 'personality' && argStr) {
        setHermesKv(db, userId, 'soul_md', argStr);
        return {
          ok: true,
          command: 'personality',
          response_text: `Updated SOUL.md persona (${argStr.length} chars).`,
          session_id: session.session_id,
          ui_effect: { kind: 'open_studio', payload: { tab: 'memory' } },
        };
      }
      const mem = getHermesMemoryState(db, userId);
      return {
        ok: true,
        command: spec.name,
        response_text: `**SOUL.md**:\n${mem.soul}`,
        session_id: session.session_id,
        ui_effect: { kind: 'open_studio', payload: { tab: 'memory' } },
      };
    }

    case 'honcho': {
      const mem = getHermesMemoryState(db, userId);
      if (argStr) {
        const obs = [...mem.honcho_observations, argStr];
        setHermesKv(db, userId, 'honcho_obs', JSON.stringify(obs));
        return {
          ok: true,
          command: 'honcho',
          response_text: `Recorded Honcho observation (${obs.length} total).`,
          session_id: session.session_id,
          ui_effect: { kind: 'open_studio', payload: { tab: 'memory' } },
        };
      }
      return {
        ok: true,
        command: 'honcho',
        response_text:
          mem.honcho_observations.length > 0
            ? `Honcho observations (${mem.honcho_observations.length}):\n${mem.honcho_observations.map((o) => `• ${o}`).join('\n')}`
            : 'No Honcho observations recorded yet.',
        session_id: session.session_id,
        ui_effect: { kind: 'open_studio', payload: { tab: 'memory' } },
      };
    }

    case 'resume': {
      if (!argStr) {
        throw new ApiError(400, 'missing_session_id', 'Usage: /resume <session_id>');
      }
      const target = db
        .prepare(`SELECT session_id, title FROM hermes_sessions WHERE session_id = ? AND user_id = ?`)
        .get(argStr, userId) as { session_id: string; title: string } | undefined;
      if (!target) {
        throw new ApiError(404, 'session_not_found', `Session ${argStr} not found`);
      }
      return {
        ok: true,
        command: 'resume',
        response_text: `Resumed session **${target.title}** (\`${target.session_id}\`).`,
        session_id: target.session_id,
        ui_effect: { kind: 'switch_session', payload: { session_id: target.session_id } },
      };
    }

    case 'history': {
      const rows = db
        .prepare(`SELECT session_id, title, model FROM hermes_sessions WHERE user_id = ? ORDER BY updated_at_ms DESC LIMIT 10`)
        .all(userId) as Array<{ session_id: string; title: string; model: string }>;
      return {
        ok: true,
        command: 'history',
        response_text:
          rows.length > 0
            ? `Recent sessions:\n${rows.map((r) => `• \`${r.session_id}\` — **${r.title}** (${r.model || 'unconfigured'})`).join('\n')}`
            : 'No sessions yet.',
        session_id: session.session_id,
        ui_effect: { kind: 'open_studio', payload: { tab: 'sessions' } },
      };
    }

    case 'usage':
    case 'insights': {
      const agg = db
        .prepare(
          `SELECT COUNT(*) AS cnt, COALESCE(SUM(prompt_tokens),0) AS pt, COALESCE(SUM(completion_tokens),0) AS ct, COALESCE(AVG(latency_ms),0) AS avg_ms
           FROM magpie_usage_ledger WHERE user_id = ?`,
        )
        .get(userId) as { cnt: number; pt: number; ct: number; avg_ms: number };
      return {
        ok: true,
        command: spec.name,
        response_text: `Usage ledger: ${Number(agg.cnt)} requests · ${Number(agg.pt)} prompt tokens · ${Number(agg.ct)} completion tokens · avg ${Math.round(Number(agg.avg_ms))}ms`,
        session_id: session.session_id,
        ui_effect: { kind: 'none' },
      };
    }

    case 'context': {
      const mem = getHermesMemoryState(db, userId);
      const msgChars = session.messages.reduce((acc, m) => acc + m.content.length, 0);
      return {
        ok: true,
        command: 'context',
        response_text: `Context breakdown: ${session.messages.length} messages (${msgChars} chars) · MEMORY.md (${mem.memory.chars} chars) · USER.md (${mem.user.chars} chars) · total_tokens=${session.total_tokens}`,
        session_id: session.session_id,
        ui_effect: { kind: 'none' },
      };
    }

    case 'export': {
      return {
        ok: true,
        command: 'export',
        response_text: `Session \`${session.session_id}\` is ready for redacted export at \`GET /api/v1/fabushi/sessions/${session.session_id}/export\`.`,
        session_id: session.session_id,
        ui_effect: { kind: 'export_session', payload: { session_id: session.session_id } },
      };
    }

    case 'search': {
      const q = argStr.trim().toLowerCase();
      if (!q) throw new ApiError(400, 'missing_query', 'Usage: /search <query>');
      const rows = db
        .prepare(`SELECT session_id, title, messages_json FROM hermes_sessions WHERE user_id = ?`)
        .all(userId) as Array<{ session_id: string; title: string; messages_json: string }>;
      const hits = rows.filter(
        (r) => r.title.toLowerCase().includes(q) || r.messages_json.toLowerCase().includes(q),
      );
      return {
        ok: true,
        command: 'search',
        response_text:
          hits.length > 0
            ? `Found ${hits.length} session(s) matching "${argStr}":\n${hits.slice(0, 10).map((h) => `• \`${h.session_id}\` — ${h.title}`).join('\n')}`
            : `No sessions matching "${argStr}".`,
        session_id: session.session_id,
        ui_effect: { kind: 'open_studio', payload: { tab: 'sessions' } },
      };
    }

    case 'kanban':
    case 'todo': {
      const rows = db
        .prepare(`SELECT board_json FROM hermes_kanban_boards WHERE user_id = ? ORDER BY updated_at_ms DESC`)
        .all(userId) as Array<{ board_json: string }>;
      const boards = rows.map((r) => JSON.parse(r.board_json) as HermesKanbanBoardDto);
      const totalCards = boards.reduce((sum, b) => sum + b.cards.length, 0);
      return {
        ok: true,
        command: spec.name,
        response_text: `Kanban boards: ${boards.length} · Cards: ${totalCards}`,
        session_id: session.session_id,
        ui_effect: { kind: 'open_studio', payload: { tab: 'kanban' } },
      };
    }

    case 'cron': {
      const rows = db
        .prepare(`SELECT job_json FROM hermes_cron_jobs WHERE user_id = ? ORDER BY created_at_ms DESC`)
        .all(userId) as Array<{ job_json: string }>;
      const jobs = rows.map((r) => JSON.parse(r.job_json) as HermesCronJobDto);
      return {
        ok: true,
        command: 'cron',
        response_text:
          jobs.length > 0
            ? `Cron jobs (${jobs.length}):\n${jobs.map((j) => `• \`${j.job_id}\` **${j.name}** (${j.schedule_expr})`).join('\n')}`
            : 'No scheduled cron jobs.',
        session_id: session.session_id,
        ui_effect: { kind: 'open_studio', payload: { tab: 'cron' } },
      };
    }

    case 'heartbeat': {
      const hb = JSON.parse(getHermesKv(db, userId, 'heartbeat', DEFAULT_HEARTBEAT_JSON)) as {
        enabled: boolean;
        interval_secs: number;
        tick_count: number;
      };
      return {
        ok: true,
        command: 'heartbeat',
        response_text: `Heartbeat: ${hb.enabled ? 'enabled' : 'disabled'} · interval ${hb.interval_secs}s · ticks=${hb.tick_count}`,
        session_id: session.session_id,
        ui_effect: { kind: 'open_studio', payload: { tab: 'cron' } },
      };
    }

    case 'clarify': {
      const cur = getHermesKv(db, userId, 'clarify_enabled', 'off');
      const next = cur === 'on' ? 'off' : 'on';
      setHermesKv(db, userId, 'clarify_enabled', next);
      return {
        ok: true,
        command: 'clarify',
        response_text: `Interactive clarification prompts set to \`${next}\`.`,
        session_id: session.session_id,
        ui_effect: { kind: 'none' },
      };
    }

    case 'approve':
    case 'deny': {
      const targetRow = (
        argStr
          ? db
              .prepare(`SELECT approval_json FROM hermes_approvals WHERE approval_id = ? AND user_id = ?`)
              .get(argStr, userId)
          : db
              .prepare(`SELECT approval_json FROM hermes_approvals WHERE user_id = ? ORDER BY created_at_ms DESC LIMIT 1`)
              .get(userId)
      ) as { approval_json: string } | undefined;
      if (!targetRow) {
        return {
          ok: true,
          command: spec.name,
          response_text: 'No pending approval requests found.',
          session_id: session.session_id,
          ui_effect: { kind: 'none' },
        };
      }
      const item = JSON.parse(targetRow.approval_json) as HermesApprovalItem;
      item.status = spec.name === 'approve' ? 'approved' : 'denied';
      db.prepare(`UPDATE hermes_approvals SET approval_json = ? WHERE approval_id = ?`).run(
        JSON.stringify(item),
        item.approval_id,
      );
      return {
        ok: true,
        command: spec.name,
        response_text: `Approval \`${item.approval_id}\` marked **${item.status}**.`,
        session_id: session.session_id,
        ui_effect: { kind: 'open_studio', payload: { tab: 'toolsets' } },
      };
    }

    case 'yolo': {
      const currentMode = getHermesKv(db, userId, 'approval_mode', 'ask');
      const nextMode =
        argStr === 'off' ? 'ask' : argStr === 'on' ? 'yolo' : currentMode === 'yolo' ? 'ask' : 'yolo';
      setHermesKv(db, userId, 'approval_mode', nextMode);
      return {
        ok: true,
        command: 'yolo',
        response_text: `Approval mode set to \`${nextMode}\`.`,
        session_id: session.session_id,
        ui_effect: { kind: 'approval_mode_changed', payload: { mode: nextMode } },
      };
    }

    case 'stop': {
      return {
        ok: true,
        command: 'stop',
        response_text: 'Requested turn cancellation.',
        session_id: session.session_id,
        ui_effect: { kind: 'abort_turn' },
      };
    }

    case 'privacy': {
      const mask = magpieSnap?.masking;
      return {
        ok: true,
        command: 'privacy',
        response_text: `Privacy masking: ${mask?.enabled !== false ? 'enabled' : 'disabled'} · action=\`${mask?.default_action ?? 'mask'}\` · custom_words=${mask?.custom_words?.length ?? 0}`,
        session_id: session.session_id,
        ui_effect: { kind: 'open_magpie' },
      };
    }

    case 'studio': {
      const tab = argStr || 'sessions';
      return {
        ok: true,
        command: 'studio',
        response_text: `Opening Fabushi 6-Tab Studio (\`${tab}\`).`,
        session_id: session.session_id,
        ui_effect: { kind: 'open_studio', payload: { tab } },
      };
    }

    case 'magpie': {
      return {
        ok: true,
        command: 'magpie',
        response_text: 'Opening Magpie LLM Gateway configuration.',
        session_id: session.session_id,
        ui_effect: { kind: 'open_magpie' },
      };
    }

    case 'voice': {
      return {
        ok: true,
        command: 'voice',
        response_text: 'Toggling Talk Mode workspace.',
        session_id: session.session_id,
        ui_effect: { kind: 'open_talk' },
      };
    }

    case 'computer': {
      return {
        ok: true,
        command: 'computer',
        response_text: 'Opening Remote Computer Workbench.',
        session_id: session.session_id,
        ui_effect: { kind: 'open_computer' },
      };
    }

    case 'verbose': {
      const cur = getHermesKv(db, userId, 'verbose_mode', 'off');
      const next = cur === 'on' ? 'off' : 'on';
      setHermesKv(db, userId, 'verbose_mode', next);
      return {
        ok: true,
        command: 'verbose',
        response_text: `Verbose tool trace output set to \`${next}\`.`,
        session_id: session.session_id,
        ui_effect: { kind: 'none' },
      };
    }

    default:
      // ZERO fake "Executed /cmd" stubs — honest 501 command_not_supported!
      return {
        ok: false,
        error_code: 'command_not_supported',
        http_status: 501,
        command: spec.name,
        response_text: `Command \`/${spec.name}\` requires a live tool/runtime context and is not supported via stateless slash execution.`,
        session_id: session.session_id,
        ui_effect: { kind: 'none' },
      };
  }
}

export function registerHermesStudioRoutes(
  router: HttpRouter,
  db: DatabaseSync,
  config: ServerConfig,
  hub: RealtimeGatewayHub,
): void {
  const mountDual = (
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    suffix: string,
    handler: (ctx: RequestContext) => void | Promise<void>,
  ): void => {
    router[method](`/api/v1/fabushi${suffix}`, handler);
    router[method](`/api/v1/hermes${suffix}`, handler);
  };

  // ============================================================================
  // 1. Runtime Status & Slash Commands
  // ============================================================================
  const handleGetRuntimeStatus = (ctx: RequestContext): void => {
    const auth = requireAuth(db, ctx);
    const mem = getHermesMemoryState(db, auth.userId);
    const enabledToolsets = JSON.parse(getHermesKv(db, auth.userId, 'enabled_toolsets', '[]')) as string[];
    const sessionCnt = db
      .prepare(`SELECT COUNT(*) AS cnt FROM hermes_sessions WHERE user_id = ?`)
      .get(auth.userId) as { cnt: number };
    const skillCnt = db
      .prepare(`SELECT COUNT(*) AS cnt FROM hermes_skills WHERE user_id = ?`)
      .get(auth.userId) as { cnt: number };
    const magpie = getUserMagpieStateSnapshot(db, config, auth.userId);

    sendJson(ctx.res, 200, {
      ready: true,
      version: config.appVersion,
      active_model: magpie.active_model,
      active_provider: magpie.active_provider,
      has_configured_provider: magpie.has_configured_provider,
      needs_provider_selection: magpie.needs_provider_selection,
      approval_mode: getHermesKv(db, auth.userId, 'approval_mode', 'ask'),
      session_count: Number(sessionCnt.cnt),
      skill_count: Number(skillCnt.cnt),
      enabled_toolsets_count: enabledToolsets.length,
      total_toolsets_count: HERMES_TOOLSET_IDS.length,
      commands_count: HERMES_COMMAND_CATALOG.length,
      memory_chars: mem.memory.chars,
      user_chars: mem.user.chars,
    });
  };
  mountDual('get', '/status', handleGetRuntimeStatus);
  mountDual('get', '/state', handleGetRuntimeStatus);

  mountDual('get', '/commands', (ctx) => {
    requireAuth(db, ctx);
    const prefix = (ctx.query.get('prefix') ?? '').trim().replace(/^\//, '').toLowerCase();
    const commands = prefix
      ? HERMES_COMMAND_CATALOG.filter(
          (c) =>
            c.name.toLowerCase().startsWith(prefix) ||
            c.aliases.some((a) => a.toLowerCase().startsWith(prefix)),
        )
      : HERMES_COMMAND_CATALOG;
    sendJson(ctx.res, 200, { total: commands.length, commands });
  });

  const handleExecuteCommand = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      command?: string;
      input?: string;
      session_id?: string;
      chat_id?: unknown;
    }>(ctx.req);
    const rawCmd =
      typeof body.command === 'string'
        ? body.command
        : typeof body.input === 'string'
          ? body.input
          : '';
    if (!rawCmd.trim()) {
      throw new ApiError(400, 'invalid_command', 'command is required');
    }
    const chatId = parseOptionalPositiveInt(body.chat_id, 'invalid_chat_id', 'chat_id must be a positive integer');
    const result = executeSlashCommandInternal(
      db,
      auth.userId,
      rawCmd,
      typeof body.session_id === 'string' ? body.session_id : undefined,
      chatId ?? null,
      config,
    );
    if (!result.ok) {
      throw new ApiError(
        result.http_status ?? 400,
        result.error_code ?? 'unknown_command',
        result.response_text,
      );
    }
    sendJson(ctx.res, 200, result);
  };
  mountDual('post', '/commands/execute', handleExecuteCommand);
  mountDual('post', '/command', handleExecuteCommand);

  // ============================================================================
  // 2. Streaming & Synchronous Agent Turn Execution (`/turns` & `/turns/:id/events`)
  // ============================================================================
  mountDual('post', '/turns', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      prompt?: string;
      input?: string;
      session_id?: string;
      chat_id?: unknown;
      model?: string;
      provider_id?: string;
      stream?: boolean;
      deliver_to_chat?: boolean;
    }>(ctx.req);

    const rawPrompt = (
      typeof body.prompt === 'string'
        ? body.prompt
        : typeof body.input === 'string'
          ? body.input
          : ''
    ).trim();
    if (!rawPrompt) {
      throw new ApiError(400, 'empty_prompt', 'Prompt cannot be empty');
    }

    const chatId = parseOptionalPositiveInt(body.chat_id, 'invalid_chat_id', 'chat_id must be a positive integer');
    if (body.deliver_to_chat && chatId) {
      ensureChatWriteAccess(db, chatId, auth.userId);
    }

    const wantsSse =
      body.stream === true ||
      (ctx.req.headers.accept ?? '').includes('text/event-stream');

    const magpieSnap = getUserMagpieStateSnapshot(db, config, auth.userId);

    // Intercept slash commands cleanly without trajectory pollution
    if (rawPrompt.startsWith('/')) {
      const slashRes = executeSlashCommandInternal(
        db,
        auth.userId,
        rawPrompt,
        typeof body.session_id === 'string' ? body.session_id : undefined,
        chatId ?? null,
        config,
      );
      if (!slashRes.ok) {
        throw new ApiError(
          slashRes.http_status ?? 400,
          slashRes.error_code ?? 'unknown_command',
          slashRes.response_text,
        );
      }
      const turnId = `turn_${crypto.randomBytes(6).toString('hex')}`;
      const slashEvents: HermesStreamEvent[] = [
        {
          type: 'turn_started',
          turn_id: turnId,
          session_id: slashRes.session_id,
          model: magpieSnap.active_model,
          provider: magpieSnap.active_provider,
        },
        {
          type: 'text_delta',
          turn_id: turnId,
          text: slashRes.response_text,
          delta: slashRes.response_text,
        },
        {
          type: 'done',
          turn_id: turnId,
          session_id: slashRes.session_id,
          response_text: slashRes.response_text,
          model: magpieSnap.active_model,
          provider: magpieSnap.active_provider,
          finish_reason: 'slash_command',
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            reasoning_tokens: 0,
            total_tokens: 0,
            estimated_cost_usd: 0,
          },
          tool_calls_count: 0,
        },
      ];
      const slashSummary = {
        turn_id: turnId,
        session_id: slashRes.session_id,
        response_text: slashRes.response_text,
        ui_effect: slashRes.ui_effect,
        events: slashEvents,
      };
      db.prepare(`
        INSERT INTO hermes_turns (turn_id, user_id, session_id, events_json, response_json, created_at_ms)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        turnId,
        auth.userId,
        slashRes.session_id,
        JSON.stringify(slashEvents),
        JSON.stringify(slashSummary),
        Date.now(),
      );

      if (wantsSse) {
        const sse = beginSseStream(ctx.res);
        for (const ev of slashEvents) {
          sse.sendEvent(ev.type, ev);
        }
        sse.end();
        return;
      }

      sendJson(ctx.res, 200, slashSummary);
      return;
    }

    const session = getOrCreateHermesSession(
      db,
      auth.userId,
      typeof body.session_id === 'string' ? body.session_id : undefined,
      chatId ?? null,
      magpieSnap.active_model,
    );
    const turnId = `turn_${crypto.randomBytes(8).toString('hex')}`;
    const approvalMode = getHermesKv(db, auth.userId, 'approval_mode', 'ask');
    const maskingCfg = getUserMaskingConfig(db, config, auth.userId);
    const masked = runPrivacyMasking(rawPrompt, maskingCfg);
    if (masked.blocked) {
      throw new ApiError(400, 'privacy_blocked', masked.block_reason ?? 'Blocked by privacy policy');
    }
    const safePrompt = masked.masked_text;

    const events: HermesStreamEvent[] = [];
    const memState = getHermesMemoryState(db, auth.userId);
    let activeModel =
      typeof body.model === 'string' && body.model.trim()
        ? body.model.trim()
        : magpieSnap.active_model || session.model;
    let activeProvider = magpieSnap.active_provider;
    let responseText = '';
    let reasoningText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let reasoningTokens = 0;
    let totalTokens = 0;

    if (hasDangerousCommand(safePrompt) && approvalMode !== 'yolo') {
      events.push({
        type: 'turn_started',
        turn_id: turnId,
        session_id: session.session_id,
        model: activeModel,
        provider: activeProvider,
      });
      const approvalId = `appr_${crypto.randomBytes(6).toString('hex')}`;
      const approvalItem: HermesApprovalItem = {
        approval_id: approvalId,
        session_id: session.session_id,
        tool_name: 'terminal',
        command: safePrompt,
        reason: 'Destructive shell pattern detected by Fabushi security guard',
        risk_level: 'critical',
        status: 'pending',
        created_at_ms: Date.now(),
      };
      db.prepare(`
        INSERT INTO hermes_approvals (approval_id, user_id, approval_json, created_at_ms)
        VALUES (?, ?, ?, ?)
      `).run(approvalId, auth.userId, JSON.stringify(approvalItem), approvalItem.created_at_ms);

      events.push({
        type: 'approval_required',
        turn_id: turnId,
        approval_id: approvalId,
        tool_name: 'terminal',
        command: safePrompt,
        reason: approvalItem.reason,
        risk_level: 'critical',
      });
      responseText = `⚠️ Execution paused: High-risk command requires explicit approval (\`${approvalId}\`).`;
    } else {
      const llmMessages = [
        {
          role: 'system',
          content: [
            memState.soul,
            memState.memory.raw ? `\n[MEMORY.md]\n${memState.memory.raw}` : '',
            memState.user.raw ? `\n[USER.md]\n${memState.user.raw}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        },
        ...session.messages.slice(-12).map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: safePrompt },
      ];

      const llmRes = await runConfiguredLlmCompletion(db, config, auth.userId, llmMessages, {
        providerId: typeof body.provider_id === 'string' ? body.provider_id : undefined,
        model: typeof body.model === 'string' ? body.model : undefined,
      });

      if (llmRes.unconfigured) {
        throw new ApiError(
          503,
          'provider_not_configured',
          'No AI model provider is configured for your account.',
          {
            needs_provider_selection: true,
            action: 'hermes:open_ai_providers',
          },
        );
      }

      if (!llmRes.usedUpstream) {
        throw new ApiError(
          502,
          'upstream_unreachable',
          llmRes.error || `Upstream provider ${llmRes.providerId} failed`,
        );
      }

      activeModel = llmRes.model;
      activeProvider = llmRes.providerId;
      responseText = llmRes.text;
      reasoningText = llmRes.reasoning ?? '';
      inputTokens = llmRes.usage?.prompt_tokens ?? 0;
      outputTokens = llmRes.usage?.completion_tokens ?? 0;
      reasoningTokens = llmRes.usage?.reasoning_tokens ?? 0;
      totalTokens = llmRes.usage?.total_tokens ?? inputTokens + outputTokens;

      events.push({
        type: 'turn_started',
        turn_id: turnId,
        session_id: session.session_id,
        model: activeModel,
        provider: activeProvider,
      });
      if (reasoningText) {
        events.push({
          type: 'thinking_delta',
          turn_id: turnId,
          delta: reasoningText,
        });
      }
    }

    // Emit chunked text deltas (ZERO fabricated memory_lookup tool calls!)
    if (responseText.length > 0) {
      const mid = Math.max(1, Math.floor(responseText.length / 2));
      const chunk1 = responseText.slice(0, mid);
      const chunk2 = responseText.slice(mid);
      events.push({ type: 'text_delta', turn_id: turnId, text: chunk1, delta: chunk1 });
      if (chunk2) {
        events.push({ type: 'text_delta', turn_id: turnId, text: chunk2, delta: chunk2 });
      }
    }

    let deliveredMessageId: number | undefined;
    if (body.deliver_to_chat && chatId) {
      const msgRes = createMessageAtomic(db, hub, {
        chatId,
        senderId: 777000,
        text: responseText,
      });
      deliveredMessageId = msgRes.message.id;
    }

    const doneEvent: HermesStreamEvent = {
      type: 'done',
      turn_id: turnId,
      session_id: session.session_id,
      response_text: responseText,
      model: activeModel,
      provider: activeProvider,
      finish_reason: 'stop',
      delivered_message_id: deliveredMessageId,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        reasoning_tokens: reasoningTokens,
        total_tokens: totalTokens,
        estimated_cost_usd: 0,
      },
      tool_calls_count: 0,
    };
    events.push(doneEvent);

    const now = Date.now();
    const updatedMessages: StoredHermesMessage[] = [
      ...session.messages,
      { id: `u_${turnId}`, role: 'user', content: safePrompt, created_at_ms: now },
      {
        id: `a_${turnId}`,
        role: 'assistant',
        content: responseText,
        ...(reasoningText ? { reasoning: reasoningText } : {}),
        created_at_ms: now + 1,
      },
    ];
    db.prepare(`
      UPDATE hermes_sessions
      SET messages_json = ?, model = ?, total_tokens = total_tokens + ?, updated_at_ms = ?
      WHERE session_id = ?
    `).run(JSON.stringify(updatedMessages), activeModel, totalTokens, now, session.session_id);

    const turnSummary = {
      turn_id: turnId,
      session_id: session.session_id,
      response_text: responseText,
      model: activeModel,
      provider: activeProvider,
      delivered_message_id: deliveredMessageId,
      usage: doneEvent.usage,
      events,
    };
    db.prepare(`
      INSERT INTO hermes_turns (turn_id, user_id, session_id, events_json, response_json, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(turnId, auth.userId, session.session_id, JSON.stringify(events), JSON.stringify(turnSummary), now);

    if (wantsSse) {
      const sse = beginSseStream(ctx.res);
      for (const ev of events) {
        sse.sendEvent(ev.type, ev);
      }
      sse.end();
      return;
    }

    sendJson(ctx.res, 200, turnSummary);
  });

  mountDual('get', '/turns/:turnId/events', (ctx) => {
    const auth = requireAuth(db, ctx);
    const row = db
      .prepare(`SELECT events_json FROM hermes_turns WHERE turn_id = ? AND user_id = ?`)
      .get(ctx.params.turnId!, auth.userId) as { events_json: string } | undefined;
    if (!row) throw new ApiError(404, 'turn_not_found', 'Turn not found');

    const events = JSON.parse(row.events_json) as HermesStreamEvent[];
    const hasError = events.some((e) => e.type === 'error');
    const hasDone = events.some((e) => e.type === 'done');
    const sse = beginSseStream(ctx.res);
    for (const ev of events) {
      sse.sendEvent(ev.type, ev);
    }
    if (!hasError && hasDone) {
      sse.sendRawData('[DONE]');
    }
    sse.end();
  });

  // ============================================================================
  // 3. Tab 1: Sessions (`sessions`, `sessions/search` BEFORE `:sessionId`, `branch`, `compress`, `undo`, `export`)
  // ============================================================================
  mountDual('get', '/sessions', (ctx) => {
    const auth = requireAuth(db, ctx);
    const q = (ctx.query.get('q') ?? '').trim().toLowerCase();
    const rows = db
      .prepare(`SELECT * FROM hermes_sessions WHERE user_id = ? ORDER BY updated_at_ms DESC`)
      .all(auth.userId) as Array<Record<string, unknown>>;

    let sessions: HermesSessionSummary[] = rows.map((r) => {
      const msgs = JSON.parse(String(r.messages_json)) as StoredHermesMessage[];
      return {
        session_id: String(r.session_id),
        title: String(r.title),
        parent_session_id: (r.parent_session_id as string | null) ?? null,
        chat_id: r.chat_id ? Number(r.chat_id) : null,
        bot_id: r.bot_id ? Number(r.bot_id) : null,
        source: String(r.source),
        model: String(r.model),
        message_count: msgs.length,
        total_tokens: Number(r.total_tokens),
        total_cost_usd: Number(r.total_cost_usd),
        created_at_ms: Number(r.created_at_ms),
        updated_at_ms: Number(r.updated_at_ms),
      };
    });

    if (q) {
      sessions = sessions.filter((s) => {
        const raw = rows.find((r) => String(r.session_id) === s.session_id);
        return (
          s.title.toLowerCase().includes(q) ||
          String(raw?.messages_json ?? '').toLowerCase().includes(q)
        );
      });
    }
    sendJson(ctx.res, 200, { sessions });
  });

  mountDual('post', '/sessions', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{ title?: string; model?: string; chat_id?: unknown }>(ctx.req);
    const sid = `hses_${crypto.randomBytes(8).toString('hex')}`;
    const now = Date.now();
    const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'New Studio Session';
    const magpie = getUserMagpieStateSnapshot(db, config, auth.userId);
    const model =
      typeof body.model === 'string' && body.model.trim() && body.model !== 'hermes-local-v1'
        ? body.model.trim()
        : magpie.active_model;
    const chatId = parseOptionalPositiveInt(body.chat_id, 'invalid_chat_id', 'chat_id must be a positive integer');

    db.prepare(`
      INSERT INTO hermes_sessions (
        session_id, user_id, chat_id, bot_id, title, source, model,
        messages_json, checkpoints_json, total_tokens, total_cost_usd, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, 777000, ?, 'studio', ?, '[]', '[]', 0, 0, ?, ?)
    `).run(sid, auth.userId, chatId ?? null, title, model, now, now);

    const summary = {
      id: sid,
      session_id: sid,
      title,
      model,
      chat_id: chatId ?? null,
      message_count: 0,
      total_tokens: 0,
      total_cost_usd: 0,
      created_at_ms: now,
      updated_at_ms: now,
    };

    sendJson(ctx.res, 201, {
      ...summary,
      session: summary,
    });
  });

  // Static `/sessions/search` MUST be registered BEFORE `/sessions/:sessionId`!
  mountDual('post', '/sessions/search', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{ query?: string; q?: string; session_id?: string; limit?: unknown }>(ctx.req);
    const query = (
      typeof body.query === 'string' ? body.query : typeof body.q === 'string' ? body.q : ''
    ).trim().toLowerCase();
    const limit = parseBoundedQueryInt(
      body.limit !== undefined ? String(body.limit) : null,
      20,
      1,
      100,
    );

    const rows = (
      typeof body.session_id === 'string' && body.session_id.trim()
        ? db
            .prepare(`SELECT * FROM hermes_sessions WHERE user_id = ? AND session_id = ?`)
            .all(auth.userId, body.session_id.trim())
        : db
            .prepare(`SELECT * FROM hermes_sessions WHERE user_id = ? ORDER BY updated_at_ms DESC`)
            .all(auth.userId)
    ) as Array<Record<string, unknown>>;

    const hits: Array<{
      session_id: string;
      title: string;
      snippet: string;
      message_id?: string;
      updated_at_ms: number;
    }> = [];

    for (const r of rows) {
      const title = String(r.title ?? '');
      const msgs = JSON.parse(String(r.messages_json ?? '[]')) as StoredHermesMessage[];
      if (!query || title.toLowerCase().includes(query)) {
        hits.push({
          session_id: String(r.session_id),
          title,
          snippet: msgs[msgs.length - 1]?.content?.slice(0, 160) ?? title,
          updated_at_ms: Number(r.updated_at_ms),
        });
        continue;
      }
      const matchedMsg = msgs.find((m) => String(m.content ?? '').toLowerCase().includes(query));
      if (matchedMsg) {
        hits.push({
          session_id: String(r.session_id),
          title,
          snippet: matchedMsg.content.slice(0, 160),
          message_id: matchedMsg.id,
          updated_at_ms: Number(r.updated_at_ms),
        });
      }
    }

    const sliced = hits.slice(0, limit);
    sendJson(ctx.res, 200, { results: sliced, hits: sliced, total: sliced.length });
  });

  mountDual('get', '/sessions/:sessionId', (ctx) => {
    const auth = requireAuth(db, ctx);
    const row = db
      .prepare(`SELECT * FROM hermes_sessions WHERE session_id = ? AND user_id = ?`)
      .get(ctx.params.sessionId!, auth.userId) as Record<string, unknown> | undefined;
    if (!row) throw new ApiError(404, 'session_not_found', 'Session not found');
    sendJson(ctx.res, 200, {
      id: row.session_id,
      session_id: row.session_id,
      title: row.title,
      parent_session_id: row.parent_session_id,
      model: row.model,
      messages: JSON.parse(String(row.messages_json)),
      checkpoints: JSON.parse(String(row.checkpoints_json || '[]')),
      total_tokens: Number(row.total_tokens),
      created_at_ms: Number(row.created_at_ms),
      updated_at_ms: Number(row.updated_at_ms),
    });
  });

  mountDual('post', '/sessions/:sessionId/branch', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{ title?: string }>(ctx.req);
    const exists = db
      .prepare(`SELECT 1 FROM hermes_sessions WHERE session_id = ? AND user_id = ?`)
      .get(ctx.params.sessionId!, auth.userId);
    if (!exists) throw new ApiError(404, 'session_not_found', 'Session not found');
    const res = executeSlashCommandInternal(
      db,
      auth.userId,
      `/branch ${typeof body.title === 'string' ? body.title : ''}`,
      ctx.params.sessionId!,
      null,
      config,
    );
    sendJson(ctx.res, 201, res);
  });

  mountDual('post', '/sessions/:sessionId/compress', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const sid = ctx.params.sessionId!;
    const row = db
      .prepare(`SELECT * FROM hermes_sessions WHERE session_id = ? AND user_id = ?`)
      .get(sid, auth.userId) as Record<string, unknown> | undefined;
    if (!row) throw new ApiError(404, 'session_not_found', 'Session not found');

    const msgs = JSON.parse(String(row.messages_json)) as StoredHermesMessage[];
    if (msgs.length <= 4) {
      sendJson(ctx.res, 200, {
        session_id: sid,
        compressed: true,
        summary: 'Session already compact.',
        message_count: msgs.length,
      });
      return;
    }

    const older = msgs.slice(0, msgs.length - 4);
    const recent = msgs.slice(-4);
    let summary = older
      .map((m) => `${m.role}: ${m.content.slice(0, 120)}`)
      .join('\n')
      .slice(0, 1500);

    // Attempt real LLM summarization if user has a configured provider
    const llmRes = await runConfiguredLlmCompletion(db, config, auth.userId, [
      { role: 'system', content: 'Summarize the following conversation concisely in bullet points.' },
      { role: 'user', content: summary },
    ]);
    if (llmRes.usedUpstream && llmRes.text.trim()) {
      summary = llmRes.text.trim();
    }

    const now = Date.now();
    const compacted: StoredHermesMessage[] = [
      {
        id: `cmp_${crypto.randomBytes(4).toString('hex')}`,
        role: 'system',
        content: `[Compacted ${older.length} earlier messages]\n${summary}`,
        created_at_ms: now,
      },
      ...recent,
    ];
    db.prepare(`UPDATE hermes_sessions SET messages_json = ?, updated_at_ms = ? WHERE session_id = ?`).run(
      JSON.stringify(compacted),
      now,
      sid,
    );
    sendJson(ctx.res, 200, {
      session_id: sid,
      compressed: true,
      summary,
      message_count: compacted.length,
    });
  });

  mountDual('post', '/sessions/:sessionId/undo', (ctx) => {
    const auth = requireAuth(db, ctx);
    const sid = ctx.params.sessionId!;
    const row = db
      .prepare(`SELECT messages_json FROM hermes_sessions WHERE session_id = ? AND user_id = ?`)
      .get(sid, auth.userId) as { messages_json: string } | undefined;
    if (!row) throw new ApiError(404, 'session_not_found', 'Session not found');

    const msgs = JSON.parse(row.messages_json) as StoredHermesMessage[];
    const trimmed = msgs.slice(0, Math.max(0, msgs.length - 2));
    db.prepare(`UPDATE hermes_sessions SET messages_json = ?, updated_at_ms = ? WHERE session_id = ?`).run(
      JSON.stringify(trimmed),
      Date.now(),
      sid,
    );
    sendJson(ctx.res, 200, {
      ok: true,
      session_id: sid,
      remaining_messages: trimmed.length,
    });
  });

  const handleExportSession = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const row = db
      .prepare(`SELECT * FROM hermes_sessions WHERE session_id = ? AND user_id = ?`)
      .get(ctx.params.sessionId!, auth.userId) as Record<string, unknown> | undefined;
    if (!row) throw new ApiError(404, 'session_not_found', 'Session not found');

    let format = (ctx.query.get('format') ?? 'json').toLowerCase();
    if (ctx.method === 'POST') {
      try {
        const body = await readJsonBody<{ format?: string }>(ctx.req);
        if (typeof body.format === 'string') format = body.format.toLowerCase();
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 400)) throw err;
      }
    }

    const userMaskCfg = getUserMaskingConfig(db, config, auth.userId);
    const exportMaskCfg = {
      enabled: true,
      mask_secrets: true,
      mask_personal: true,
      custom_words: Array.isArray(userMaskCfg.custom_words) ? userMaskCfg.custom_words : [],
      allow_list: Array.isArray(userMaskCfg.allow_list) ? userMaskCfg.allow_list : [],
      default_action: 'mask' as const,
    };

    const msgs = JSON.parse(String(row.messages_json)) as StoredHermesMessage[];
    const redactedMessages = msgs.map((m) => ({
      ...m,
      content: runPrivacyMasking(String(m.content ?? ''), exportMaskCfg).masked_text,
      ...(m.reasoning
        ? { reasoning: runPrivacyMasking(String(m.reasoning), exportMaskCfg).masked_text }
        : {}),
    }));
    const safeTitle = runPrivacyMasking(String(row.title ?? ''), exportMaskCfg).masked_text;

    if (format === 'markdown') {
      const md = [
        `# ${safeTitle}`,
        '',
        ...redactedMessages.map((m) => `### ${m.role}\n${m.content}`),
      ].join('\n\n');
      sendJson(ctx.res, 200, {
        session_id: String(row.session_id),
        title: safeTitle,
        format: 'markdown',
        markdown: md,
        messages: redactedMessages,
      });
      return;
    }

    sendJson(ctx.res, 200, {
      session_id: String(row.session_id),
      title: safeTitle,
      model: String(row.model),
      messages: redactedMessages,
    });
  };
  mountDual('get', '/sessions/:sessionId/export', handleExportSession);
  mountDual('post', '/sessions/:sessionId/export', handleExportSession);

  mountDual('delete', '/sessions/:sessionId', (ctx) => {
    const auth = requireAuth(db, ctx);
    db.prepare(`DELETE FROM hermes_sessions WHERE session_id = ? AND user_id = ?`).run(
      ctx.params.sessionId!,
      auth.userId,
    );
    sendJson(ctx.res, 200, { ok: true });
  });

  // ============================================================================
  // 4. Tab 2: Bounded Memory (`MEMORY.md <= 2200`, `USER.md <= 1375`, `SOUL.md`, Honcho)
  // ============================================================================
  mountDual('get', '/memory', (ctx) => {
    const auth = requireAuth(db, ctx);
    sendJson(ctx.res, 200, getHermesMemoryState(db, auth.userId));
  });

  const handleMutateMemory = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      target?: unknown;
      scope?: unknown;
      action?: unknown;
      content?: unknown;
      entry?: unknown;
      old_text?: unknown;
      key?: unknown;
      memory_md?: unknown;
      user_md?: unknown;
      soul_md?: unknown;
    }>(ctx.req);

    const cur = getHermesMemoryState(db, auth.userId);

    if (body.memory_md !== undefined && typeof body.memory_md !== 'string') {
      throw new ApiError(400, 'invalid_memory', 'memory_md must be a string');
    }
    if (body.user_md !== undefined && typeof body.user_md !== 'string') {
      throw new ApiError(400, 'invalid_memory', 'user_md must be a string');
    }
    if (body.soul_md !== undefined && typeof body.soul_md !== 'string') {
      throw new ApiError(400, 'invalid_memory', 'soul_md must be a string');
    }
    if (body.target !== undefined && typeof body.target !== 'string') {
      throw new ApiError(400, 'invalid_memory_target', 'target must be a string');
    }
    if (body.scope !== undefined && typeof body.scope !== 'string') {
      throw new ApiError(400, 'invalid_memory_target', 'scope must be a string');
    }
    if (body.action !== undefined && typeof body.action !== 'string') {
      throw new ApiError(400, 'invalid_memory_action', 'action must be a string');
    }
    if (body.old_text !== undefined && body.old_text !== null && typeof body.old_text !== 'string') {
      throw new ApiError(400, 'invalid_memory', 'old_text must be a string');
    }
    if (body.key !== undefined && body.key !== null && typeof body.key !== 'string') {
      throw new ApiError(400, 'invalid_memory', 'key must be a string');
    }
    if (body.content !== undefined && body.content !== null && typeof body.content !== 'string') {
      throw new ApiError(400, 'invalid_memory', 'content must be a string');
    }
    if (body.entry !== undefined && body.entry !== null && typeof body.entry !== 'string') {
      throw new ApiError(400, 'invalid_memory', 'entry must be a string');
    }

    if (typeof body.memory_md === 'string') {
      if (body.memory_md.length > 2200) {
        throw new ApiError(400, 'memory_limit_exceeded', 'MEMORY.md cannot exceed 2200 characters');
      }
      setHermesKv(db, auth.userId, 'memory_md', body.memory_md);
    }
    if (typeof body.user_md === 'string') {
      if (body.user_md.length > 1375) {
        throw new ApiError(400, 'user_limit_exceeded', 'USER.md cannot exceed 1375 characters');
      }
      setHermesKv(db, auth.userId, 'user_md', body.user_md);
    }
    if (typeof body.soul_md === 'string') {
      setHermesKv(db, auth.userId, 'soul_md', body.soul_md);
    }

    const rawTarget =
      typeof body.target === 'string'
        ? body.target.trim().toLowerCase()
        : typeof body.scope === 'string'
          ? body.scope.trim().toLowerCase()
          : typeof body.action === 'string'
            ? 'memory'
            : undefined;
    if (rawTarget !== undefined && rawTarget !== 'memory' && rawTarget !== 'user' && rawTarget !== 'soul') {
      throw new ApiError(400, 'invalid_memory_target', 'target must be memory, user, or soul');
    }
    const target = rawTarget as 'memory' | 'user' | 'soul' | undefined;
    const rawContent =
      typeof body.content === 'string'
        ? body.content
        : typeof body.entry === 'string'
          ? body.entry
          : undefined;
    const action = typeof body.action === 'string' ? body.action.trim().toLowerCase() : 'add';
    const oldText = typeof body.old_text === 'string' ? body.old_text : undefined;
    const keyText = typeof body.key === 'string' ? body.key : undefined;

    if (target) {
      if (target === 'soul') {
        if (action === 'clear') {
          setHermesKv(db, auth.userId, 'soul_md', '');
        } else if (rawContent !== undefined) {
          setHermesKv(db, auth.userId, 'soul_md', rawContent);
        }
      } else {
        const kvKey = target === 'memory' ? 'memory_md' : 'user_md';
        const limit = target === 'memory' ? 2200 : 1375;
        let entries = target === 'memory' ? [...cur.memory.entries] : [...cur.user.entries];

        if (action === 'clear') {
          entries = [];
        } else if (action === 'set_raw' || action === 'set') {
          const val = rawContent ?? '';
          if (val.length > limit) {
            throw new ApiError(400, 'memory_limit_exceeded', `${kvKey} exceeds ${limit} character limit`);
          }
          setHermesKv(db, auth.userId, kvKey, val);
          sendJson(ctx.res, 200, getHermesMemoryState(db, auth.userId));
          return;
        } else if (action === 'remove' || action === 'delete') {
          const needle = rawContent ?? oldText ?? keyText ?? '';
          if (needle) {
            entries = entries.filter((e) => !e.includes(needle));
          }
        } else if ((action === 'replace' || action === 'update') && (oldText || keyText)) {
          const needle = oldText ?? keyText!;
          const replacement = rawContent ?? '';
          entries = entries.map((e) => (e.includes(needle) ? replacement : e));
        } else if (rawContent !== undefined && rawContent.trim().length > 0) {
          entries.push(rawContent.trim());
        }

        const joined = entries.join('\n§\n');
        if (joined.length > limit) {
          throw new ApiError(400, 'memory_limit_exceeded', `${kvKey} exceeds ${limit} character limit`);
        }
        setHermesKv(db, auth.userId, kvKey, joined);
      }
    }

    sendJson(ctx.res, 200, getHermesMemoryState(db, auth.userId));
  };
  mountDual('put', '/memory', handleMutateMemory);
  mountDual('post', '/memory', handleMutateMemory);
  mountDual('post', '/memory/action', handleMutateMemory);

  const handleHonchoObserve = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{ observation?: unknown; note?: unknown }>(ctx.req);
    const raw = body.observation !== undefined ? body.observation : body.note;
    if (typeof raw !== 'string') {
      throw new ApiError(400, 'invalid_observation', 'observation must be a string');
    }
    const text = raw.trim();
    if (!text) {
      throw new ApiError(400, 'invalid_observation', 'observation cannot be empty');
    }
    const cur = getHermesMemoryState(db, auth.userId);
    const obs = [...cur.honcho_observations, text];
    setHermesKv(db, auth.userId, 'honcho_obs', JSON.stringify(obs));
    sendJson(ctx.res, 200, { ok: true, honcho_observations: obs });
  };
  mountDual('post', '/honcho/observe', handleHonchoObserve);
  mountDual('post', '/honcho', handleHonchoObserve);

  mountDual('get', '/honcho', (ctx) => {
    const auth = requireAuth(db, ctx);
    const cur = getHermesMemoryState(db, auth.userId);
    sendJson(ctx.res, 200, { ok: true, honcho_observations: cur.honcho_observations });
  });

  mountDual('get', '/soul', (ctx) => {
    const auth = requireAuth(db, ctx);
    const cur = getHermesMemoryState(db, auth.userId);
    sendJson(ctx.res, 200, { ok: true, soul: cur.soul, soul_md: cur.soul });
  });

  mountDual('put', '/soul', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{ soul_md?: string; content?: string }>(ctx.req);
    const nextSoul =
      typeof body.soul_md === 'string'
        ? body.soul_md
        : typeof body.content === 'string'
          ? body.content
          : '';
    setHermesKv(db, auth.userId, 'soul_md', nextSoul);
    sendJson(ctx.res, 200, { ok: true, soul_md: nextSoul });
  });

  // ============================================================================
  // 5. Tab 3: Skills Hub & Security Quarantine Scanner (`GET/POST`, `GET/PATCH/DELETE /:name`)
  // ============================================================================
  mountDual('get', '/skills', (ctx) => {
    const auth = requireAuth(db, ctx);
    const rows = db
      .prepare(`SELECT skill_json FROM hermes_skills WHERE user_id = ? ORDER BY updated_at_ms DESC`)
      .all(auth.userId) as Array<{ skill_json: string }>;
    const skills = rows.map((r) => JSON.parse(r.skill_json) as HermesSkillDto);
    sendJson(ctx.res, 200, {
      skills,
      quarantined: skills.filter((s) => s.status === 'quarantined'),
    });
  });

  mountDual('post', '/skills', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      name?: string;
      description?: string;
      body?: string;
      tags?: string[];
      toolsets?: string[];
      version?: string;
    }>(ctx.req);

    const name = (typeof body.name === 'string' ? body.name : '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-');
    if (!name) throw new ApiError(400, 'invalid_skill_name', 'Skill name is required');
    const skillBody = typeof body.body === 'string' ? body.body : '';

    const findings = scanSkillSecurity(skillBody);
    const quarantined = findings.length > 0;
    const skill: HermesSkillDto = {
      name,
      description: typeof body.description === 'string' ? body.description : '',
      body: skillBody,
      tags: Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === 'string') : [],
      toolsets: Array.isArray(body.toolsets)
        ? body.toolsets.filter((t): t is string => typeof t === 'string')
        : ['core'],
      version: typeof body.version === 'string' && body.version.trim() ? body.version.trim() : '1.0.0',
      enabled: !quarantined,
      trusted: !quarantined,
      status: quarantined ? 'quarantined' : 'active',
      security_risk: quarantined ? 'high' : 'none',
      security_findings: findings,
      updated_at_ms: Date.now(),
    };

    db.prepare(`
      INSERT OR REPLACE INTO hermes_skills (user_id, name, skill_json, updated_at_ms)
      VALUES (?, ?, ?, ?)
    `).run(auth.userId, name, JSON.stringify(skill), skill.updated_at_ms);

    sendJson(ctx.res, 201, skill);
  });

  mountDual('get', '/skills/:name', (ctx) => {
    const auth = requireAuth(db, ctx);
    const row = db
      .prepare(`SELECT skill_json FROM hermes_skills WHERE user_id = ? AND name = ?`)
      .get(auth.userId, ctx.params.name!) as { skill_json: string } | undefined;
    if (!row) throw new ApiError(404, 'skill_not_found', 'Skill not found');
    sendJson(ctx.res, 200, JSON.parse(row.skill_json));
  });

  mountDual('patch', '/skills/:name', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const name = ctx.params.name!;
    const row = db
      .prepare(`SELECT skill_json FROM hermes_skills WHERE user_id = ? AND name = ?`)
      .get(auth.userId, name) as { skill_json: string } | undefined;
    if (!row) throw new ApiError(404, 'skill_not_found', 'Skill not found');

    const patch = await readJsonBody<{
      description?: string;
      body?: string;
      tags?: string[];
      toolsets?: string[];
      version?: string;
      enabled?: boolean;
    }>(ctx.req);

    const skill = JSON.parse(row.skill_json) as HermesSkillDto;
    if (typeof patch.description === 'string') skill.description = patch.description;
    if (Array.isArray(patch.tags)) {
      skill.tags = patch.tags.filter((t): t is string => typeof t === 'string');
    }
    if (Array.isArray(patch.toolsets)) {
      skill.toolsets = patch.toolsets.filter((t): t is string => typeof t === 'string');
    }
    if (typeof patch.version === 'string' && patch.version.trim()) {
      skill.version = patch.version.trim();
    }
    if (typeof patch.body === 'string') {
      skill.body = patch.body;
      const findings = scanSkillSecurity(patch.body);
      skill.security_findings = findings;
      if (findings.length > 0) {
        skill.status = 'quarantined';
        skill.trusted = false;
        skill.enabled = false;
        skill.security_risk = 'high';
      } else {
        skill.security_risk = 'none';
      }
    }
    if (typeof patch.enabled === 'boolean' && skill.status !== 'quarantined') {
      skill.enabled = patch.enabled;
    }
    skill.updated_at_ms = Date.now();

    db.prepare(`UPDATE hermes_skills SET skill_json = ?, updated_at_ms = ? WHERE user_id = ? AND name = ?`).run(
      JSON.stringify(skill),
      skill.updated_at_ms,
      auth.userId,
      name,
    );
    sendJson(ctx.res, 200, skill);
  });

  const handleTrustSkill = (ctx: RequestContext): void => {
    const auth = requireAuth(db, ctx);
    const row = db
      .prepare(`SELECT skill_json FROM hermes_skills WHERE user_id = ? AND name = ?`)
      .get(auth.userId, ctx.params.name!) as { skill_json: string } | undefined;
    if (!row) throw new ApiError(404, 'skill_not_found', 'Skill not found');
    const skill = JSON.parse(row.skill_json) as HermesSkillDto;
    skill.trusted = true;
    skill.enabled = true;
    skill.status = 'active';
    skill.updated_at_ms = Date.now();
    db.prepare(`UPDATE hermes_skills SET skill_json = ?, updated_at_ms = ? WHERE user_id = ? AND name = ?`).run(
      JSON.stringify(skill),
      skill.updated_at_ms,
      auth.userId,
      skill.name,
    );
    sendJson(ctx.res, 200, skill);
  };
  mountDual('post', '/skills/:name/trust', handleTrustSkill);
  mountDual('post', '/skills/:name/approve', handleTrustSkill);

  mountDual('delete', '/skills/:name', (ctx) => {
    const auth = requireAuth(db, ctx);
    db.prepare(`DELETE FROM hermes_skills WHERE user_id = ? AND name = ?`).run(
      auth.userId,
      ctx.params.name!,
    );
    sendJson(ctx.res, 200, { ok: true });
  });

  // ============================================================================
  // 6. Tab 4: 29 Toolsets & Approvals (`GET /approvals`, `POST /approvals/:id/{decide,resolve}`)
  // ============================================================================
  mountDual('get', '/toolsets', (ctx) => {
    const auth = requireAuth(db, ctx);
    const enabled = new Set(JSON.parse(getHermesKv(db, auth.userId, 'enabled_toolsets', '[]')) as string[]);
    const toolsets = HERMES_TOOLSET_IDS.map((id) => ({
      id,
      enabled: enabled.has(id),
    }));
    const approvalRows = db
      .prepare(`SELECT approval_json FROM hermes_approvals WHERE user_id = ? ORDER BY created_at_ms DESC`)
      .all(auth.userId) as Array<{ approval_json: string }>;

    sendJson(ctx.res, 200, {
      total: HERMES_TOOLSET_IDS.length,
      toolsets,
      enabled_ids: Array.from(enabled),
      approval_mode: getHermesKv(db, auth.userId, 'approval_mode', 'ask'),
      approvals: approvalRows.map((r) => JSON.parse(r.approval_json) as HermesApprovalItem),
    });
  });

  const handleUpdateToolsets = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      enabled_ids?: unknown;
      preset?: unknown;
      toggle_id?: unknown;
      approval_mode?: unknown;
    }>(ctx.req);

    if (body.preset !== undefined && typeof body.preset !== 'string') {
      throw new ApiError(400, 'invalid_toolsets', 'preset must be a string');
    }
    if (body.enabled_ids !== undefined && !Array.isArray(body.enabled_ids)) {
      throw new ApiError(400, 'invalid_toolsets', 'enabled_ids must be an array');
    }
    if (body.toggle_id !== undefined && typeof body.toggle_id !== 'string') {
      throw new ApiError(400, 'invalid_toolsets', 'toggle_id must be a string');
    }
    if (body.approval_mode !== undefined && typeof body.approval_mode !== 'string') {
      throw new ApiError(400, 'invalid_approval_mode', 'approval_mode must be a string');
    }

    let current = new Set(JSON.parse(getHermesKv(db, auth.userId, 'enabled_toolsets', '[]')) as string[]);

    if (body.preset !== undefined && body.preset !== null) {
      if (typeof body.preset !== 'string') {
        throw new ApiError(400, 'invalid_preset', 'preset must be a string');
      }
      const preset = body.preset.trim();
      if (preset) {
        if (preset === 'minimal') {
          current = new Set(['core', 'memory', 'clarify', 'todo']);
        } else if (preset === 'safe') {
          current = new Set(['core', 'web', 'file', 'memory', 'skills', 'planning', 'reasoning', 'session_search']);
        } else if (preset === 'full') {
          current = new Set([...HERMES_TOOLSET_IDS]);
        } else {
          throw new ApiError(400, 'invalid_preset', `Unsupported preset: ${preset}`);
        }
      }
    }
    if (Array.isArray(body.enabled_ids)) {
      current = new Set(
        body.enabled_ids.filter(
          (id): id is string =>
            typeof id === 'string' && (HERMES_TOOLSET_IDS as readonly string[]).includes(id),
        ),
      );
    }
    if (typeof body.toggle_id === 'string' && (HERMES_TOOLSET_IDS as readonly string[]).includes(body.toggle_id)) {
      if (current.has(body.toggle_id)) current.delete(body.toggle_id);
      else current.add(body.toggle_id);
    }
    if (typeof body.approval_mode === 'string' && body.approval_mode.trim()) {
      setHermesKv(db, auth.userId, 'approval_mode', body.approval_mode.trim());
    }

    const list = Array.from(current);
    setHermesKv(db, auth.userId, 'enabled_toolsets', JSON.stringify(list));
    sendJson(ctx.res, 200, {
      ok: true,
      enabled_ids: list,
      approval_mode: getHermesKv(db, auth.userId, 'approval_mode', 'ask'),
    });
  };
  mountDual('put', '/toolsets', handleUpdateToolsets);
  mountDual('post', '/toolsets', handleUpdateToolsets);

  mountDual('get', '/approvals', (ctx) => {
    const auth = requireAuth(db, ctx);
    const rows = db
      .prepare(`SELECT approval_json FROM hermes_approvals WHERE user_id = ? ORDER BY created_at_ms DESC`)
      .all(auth.userId) as Array<{ approval_json: string }>;
    const approvals = rows.map((r) => JSON.parse(r.approval_json) as HermesApprovalItem);
    sendJson(ctx.res, 200, { approvals, total: approvals.length });
  });

  const handleDecideApproval = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{ decision?: unknown; approved?: unknown }>(ctx.req);
    if (body.decision !== undefined && body.decision !== null && typeof body.decision !== 'string') {
      throw new ApiError(400, 'invalid_decision', 'decision must be a string');
    }
    const row = db
      .prepare(`SELECT approval_json FROM hermes_approvals WHERE approval_id = ? AND user_id = ?`)
      .get(ctx.params.approvalId!, auth.userId) as { approval_json: string } | undefined;
    if (!row) throw new ApiError(404, 'approval_not_found', 'Approval request not found');

    const item = JSON.parse(row.approval_json) as HermesApprovalItem;
    const rawDec = typeof body.decision === 'string' ? body.decision.trim().toLowerCase() : '';
    if (rawDec === 'deny' || rawDec === 'denied' || body.approved === false) {
      item.status = 'denied';
    } else if (
      rawDec === 'approve_once' ||
      rawDec === 'approve_session' ||
      rawDec === 'approve_always' ||
      rawDec === 'approved' ||
      rawDec === 'approve' ||
      body.approved === true ||
      rawDec === ''
    ) {
      item.status = 'approved';
    } else {
      throw new ApiError(400, 'invalid_decision', `Unsupported decision: ${rawDec}`);
    }

    db.prepare(`UPDATE hermes_approvals SET approval_json = ? WHERE approval_id = ?`).run(
      JSON.stringify(item),
      item.approval_id,
    );
    sendJson(ctx.res, 200, item);
  };
  mountDual('post', '/approvals/:approvalId/resolve', handleDecideApproval);
  mountDual('post', '/approvals/:approvalId/decide', handleDecideApproval);

  // ============================================================================
  // 7. Tab 5: Cron Scheduler (Real LLM Trigger — ZERO fake static inserts!) & Heartbeat
  // ============================================================================
  mountDual('get', '/cron', (ctx) => {
    const auth = requireAuth(db, ctx);
    const rows = db
      .prepare(`SELECT job_json FROM hermes_cron_jobs WHERE user_id = ? ORDER BY created_at_ms DESC`)
      .all(auth.userId) as Array<{ job_json: string }>;
    const heartbeat = JSON.parse(
      getHermesKv(db, auth.userId, 'heartbeat', DEFAULT_HEARTBEAT_JSON),
    );
    const jobs = rows.map((r) => {
      const j = JSON.parse(r.job_json) as HermesCronJobDto;
      return { ...j, id: j.job_id, schedule: j.schedule_expr };
    });
    sendJson(ctx.res, 200, { jobs, heartbeat });
  });

  mountDual('post', '/cron', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      name?: string;
      schedule?: string;
      schedule_expr?: string;
      prompt?: string;
      chat_id?: unknown;
      enabled?: boolean;
    }>(ctx.req);

    const scheduleExpr = (
      typeof body.schedule === 'string'
        ? body.schedule
        : typeof body.schedule_expr === 'string'
          ? body.schedule_expr
          : '*/15 * * * *'
    ).trim();

    let nextRunMs: number;
    try {
      nextRunMs = computeNextCronRunMs(scheduleExpr, Date.now());
    } catch (err) {
      throw new ApiError(400, 'invalid_cron', err instanceof Error ? err.message : 'Invalid cron expression');
    }

    const chatId = parseOptionalPositiveInt(body.chat_id, 'invalid_chat_id', 'chat_id must be a positive integer');
    if (chatId) {
      ensureChatWriteAccess(db, chatId, auth.userId);
    }

    const jobId = `cron_${crypto.randomBytes(6).toString('hex')}`;
    const job: HermesCronJobDto = {
      job_id: jobId,
      name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'Scheduled Agent Job',
      schedule_expr: scheduleExpr,
      prompt: typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt.trim() : 'Run periodic status check',
      chat_id: chatId ?? null,
      bot_id: 777000,
      enabled: body.enabled ?? true,
      next_run_ms: nextRunMs,
      last_run_ms: null,
      run_count: 0,
    };

    db.prepare(`
      INSERT INTO hermes_cron_jobs (job_id, user_id, job_json, created_at_ms)
      VALUES (?, ?, ?, ?)
    `).run(jobId, auth.userId, JSON.stringify(job), Date.now());

    const dto = { ...job, id: jobId, schedule: scheduleExpr };
    sendJson(ctx.res, 201, { ...dto, job: dto });
  });

  mountDual('patch', '/cron/:jobId', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const row = db
      .prepare(`SELECT job_json FROM hermes_cron_jobs WHERE job_id = ? AND user_id = ?`)
      .get(ctx.params.jobId!, auth.userId) as { job_json: string } | undefined;
    if (!row) throw new ApiError(404, 'cron_not_found', 'Cron job not found');

    const patch = await readJsonBody<{
      name?: string;
      schedule?: string;
      schedule_expr?: string;
      prompt?: string;
      enabled?: boolean;
      chat_id?: unknown;
    }>(ctx.req);

    const job = JSON.parse(row.job_json) as HermesCronJobDto;
    if (typeof patch.name === 'string' && patch.name.trim()) job.name = patch.name.trim();
    if (typeof patch.prompt === 'string' && patch.prompt.trim()) job.prompt = patch.prompt.trim();
    if (typeof patch.enabled === 'boolean') job.enabled = patch.enabled;
    const nextSchedule = patch.schedule ?? patch.schedule_expr;
    if (typeof nextSchedule === 'string' && nextSchedule.trim()) {
      try {
        job.next_run_ms = computeNextCronRunMs(nextSchedule.trim(), Date.now());
        job.schedule_expr = nextSchedule.trim();
      } catch (err) {
        throw new ApiError(400, 'invalid_cron', err instanceof Error ? err.message : 'Invalid cron expression');
      }
    }
    if (patch.chat_id !== undefined) {
      if (patch.chat_id === null) {
        job.chat_id = null;
      } else {
        const cid = parseOptionalPositiveInt(patch.chat_id, 'invalid_chat_id', 'chat_id must be a positive integer');
        if (cid) ensureChatWriteAccess(db, cid, auth.userId);
        job.chat_id = cid ?? null;
      }
    }

    db.prepare(`UPDATE hermes_cron_jobs SET job_json = ? WHERE job_id = ?`).run(
      JSON.stringify(job),
      job.job_id,
    );
    const dto = { ...job, id: job.job_id, schedule: job.schedule_expr };
    sendJson(ctx.res, 200, { ...dto, job: dto });
  });

  const handleTriggerCronJob = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const row = db
      .prepare(`SELECT job_json FROM hermes_cron_jobs WHERE job_id = ? AND user_id = ?`)
      .get(ctx.params.jobId!, auth.userId) as { job_json: string } | undefined;
    if (!row) throw new ApiError(404, 'cron_not_found', 'Cron job not found');

    const job = JSON.parse(row.job_json) as HermesCronJobDto;
    const mem = getHermesMemoryState(db, auth.userId);

    // Invoke real configured LLM completion (ZERO static fake message inserts!)
    const llmRes = await runConfiguredLlmCompletion(db, config, auth.userId, [
      { role: 'system', content: mem.soul },
      { role: 'user', content: job.prompt },
    ]);

    if (llmRes.unconfigured) {
      throw new ApiError(
        503,
        'provider_not_configured',
        'No AI model provider is configured to execute scheduled cron job.',
        {
          needs_provider_selection: true,
          action: 'hermes:open_ai_providers',
        },
      );
    }

    if (!llmRes.usedUpstream) {
      throw new ApiError(
        502,
        'upstream_unreachable',
        llmRes.error || `Upstream provider ${llmRes.providerId} failed`,
      );
    }

    const now = Date.now();
    job.last_run_ms = now;
    job.run_count += 1;
    job.next_run_ms = computeNextCronRunMs(job.schedule_expr, now);

    db.prepare(`UPDATE hermes_cron_jobs SET job_json = ? WHERE job_id = ?`).run(
      JSON.stringify(job),
      job.job_id,
    );

    if (job.chat_id) {
      ensureChatWriteAccess(db, job.chat_id, auth.userId);
      createMessageAtomic(db, hub, {
        chatId: job.chat_id,
        senderId: 777000,
        text: llmRes.text,
      });
    }

    const dto = {
      ...job,
      id: job.job_id,
      schedule: job.schedule_expr,
      response_text: llmRes.text,
      provider: llmRes.providerId,
      model: llmRes.model,
    };
    sendJson(ctx.res, 200, dto);
  };
  mountDual('post', '/cron/:jobId/trigger', handleTriggerCronJob);
  mountDual('post', '/cron/:jobId/run', handleTriggerCronJob);

  mountDual('delete', '/cron/:jobId', (ctx) => {
    const auth = requireAuth(db, ctx);
    db.prepare(`DELETE FROM hermes_cron_jobs WHERE job_id = ? AND user_id = ?`).run(
      ctx.params.jobId!,
      auth.userId,
    );
    sendJson(ctx.res, 200, { ok: true });
  });

  // Heartbeat
  mountDual('get', '/heartbeat', (ctx) => {
    const auth = requireAuth(db, ctx);
    const hb = JSON.parse(getHermesKv(db, auth.userId, 'heartbeat', DEFAULT_HEARTBEAT_JSON));
    sendJson(ctx.res, 200, hb);
  });

  const handleUpdateHeartbeat = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const patch = await readJsonBody<Record<string, unknown>>(ctx.req);
    const cur = JSON.parse(getHermesKv(db, auth.userId, 'heartbeat', DEFAULT_HEARTBEAT_JSON)) as {
      enabled: boolean;
      interval_secs: number;
      active_chat_id?: number | null;
      tick_count: number;
      last_tick_ms?: number;
    };
    if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') {
      throw new ApiError(400, 'invalid_heartbeat', 'enabled must be a boolean');
    }
    if (
      patch.interval_secs !== undefined &&
      (typeof patch.interval_secs !== 'number' || !Number.isFinite(patch.interval_secs))
    ) {
      throw new ApiError(400, 'invalid_heartbeat', 'interval_secs must be a finite number');
    }
    const activeChatId =
      patch.active_chat_id === null
        ? null
        : patch.active_chat_id !== undefined
          ? parseOptionalPositiveInt(
              patch.active_chat_id,
              'invalid_chat_id',
              'active_chat_id must be a positive integer or null',
            ) ?? null
          : (cur.active_chat_id ?? null);

    const next = {
      ...cur,
      enabled: typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled,
      interval_secs:
        typeof patch.interval_secs === 'number'
          ? Math.max(10, Math.min(86_400, Math.floor(patch.interval_secs)))
          : cur.interval_secs,
      active_chat_id: activeChatId,
      updated_at_ms: Date.now(),
    };
    setHermesKv(db, auth.userId, 'heartbeat', JSON.stringify(next));
    sendJson(ctx.res, 200, next);
  };
  mountDual('put', '/heartbeat', handleUpdateHeartbeat);
  mountDual('post', '/heartbeat', handleUpdateHeartbeat);

  mountDual('post', '/heartbeat/tick', (ctx) => {
    const auth = requireAuth(db, ctx);
    const cur = JSON.parse(getHermesKv(db, auth.userId, 'heartbeat', DEFAULT_HEARTBEAT_JSON)) as {
      enabled: boolean;
      interval_secs: number;
      active_chat_id?: number | null;
      tick_count: number;
      last_tick_ms?: number;
    };
    cur.tick_count = Number(cur.tick_count ?? 0) + 1;
    cur.last_tick_ms = Date.now();
    setHermesKv(db, auth.userId, 'heartbeat', JSON.stringify(cur));
    sendJson(ctx.res, 200, cur);
  });

  // ============================================================================
  // 8. Tab 6: Kanban Boards & Cards CRUD
  // ============================================================================
  const handleGetKanban = (ctx: RequestContext): void => {
    const auth = requireAuth(db, ctx);
    const rows = db
      .prepare(`SELECT board_json FROM hermes_kanban_boards WHERE user_id = ? ORDER BY updated_at_ms DESC`)
      .all(auth.userId) as Array<{ board_json: string }>;
    const boards = rows.map((r) => JSON.parse(r.board_json) as HermesKanbanBoardDto);
    sendJson(ctx.res, 200, { boards, board: boards[0] ?? null });
  };
  mountDual('get', '/kanban', handleGetKanban);
  mountDual('get', '/kanban/boards', handleGetKanban);

  mountDual('post', '/kanban/boards', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{ title?: string; description?: string; columns?: string[] }>(ctx.req);
    const boardId = `board_${crypto.randomBytes(6).toString('hex')}`;
    const board: HermesKanbanBoardDto = {
      board_id: boardId,
      title: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'New Board',
      description: typeof body.description === 'string' ? body.description : '',
      columns:
        Array.isArray(body.columns) && body.columns.length > 0
          ? body.columns.filter((c): c is string => typeof c === 'string')
          : ['inbox', 'todo', 'in_progress', 'review', 'done'],
      cards: [],
    };
    db.prepare(`
      INSERT INTO hermes_kanban_boards (board_id, user_id, board_json, updated_at_ms)
      VALUES (?, ?, ?, ?)
    `).run(boardId, auth.userId, JSON.stringify(board), Date.now());
    sendJson(ctx.res, 201, { board, board_id: boardId });
  });

  mountDual('get', '/kanban/boards/:boardId', (ctx) => {
    const auth = requireAuth(db, ctx);
    const row = db
      .prepare(`SELECT board_json FROM hermes_kanban_boards WHERE board_id = ? AND user_id = ?`)
      .get(ctx.params.boardId!, auth.userId) as { board_json: string } | undefined;
    if (!row) throw new ApiError(404, 'board_not_found', 'Kanban board not found');
    const board = JSON.parse(row.board_json) as HermesKanbanBoardDto;
    sendJson(ctx.res, 200, { board, ...board });
  });

  mountDual('post', '/kanban/cards', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      board_id?: string;
      column_id?: string;
      title?: string;
      description?: string;
      priority?: HermesKanbanCardDto['priority'];
      labels?: string[];
    }>(ctx.req);

    const boardId = typeof body.board_id === 'string' && body.board_id.trim() ? body.board_id.trim() : 'board_main';
    const row = db
      .prepare(`SELECT board_json FROM hermes_kanban_boards WHERE board_id = ? AND user_id = ?`)
      .get(boardId, auth.userId) as { board_json: string } | undefined;

    const board: HermesKanbanBoardDto = row
      ? (JSON.parse(row.board_json) as HermesKanbanBoardDto)
      : {
          board_id: boardId,
          title: 'Main Board',
          description: '',
          columns: ['inbox', 'todo', 'in_progress', 'review', 'done'],
          cards: [],
        };

    const validPriorities = new Set<HermesKanbanCardDto['priority']>(['low', 'medium', 'high', 'urgent']);
    const cardPriority: HermesKanbanCardDto['priority'] =
      typeof body.priority === 'string' && validPriorities.has(body.priority as HermesKanbanCardDto['priority'])
        ? (body.priority as HermesKanbanCardDto['priority'])
        : 'medium';

    const card: HermesKanbanCardDto = {
      card_id: `card_${crypto.randomBytes(6).toString('hex')}`,
      board_id: board.board_id,
      column_id: typeof body.column_id === 'string' ? body.column_id : 'todo',
      title: (typeof body.title === 'string' ? body.title : 'New Card').trim() || 'New Card',
      description: typeof body.description === 'string' ? body.description : '',
      priority: cardPriority,
      labels: Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [],
      checklist: [],
      comments: [],
      position: board.cards.length,
      updated_at_ms: Date.now(),
    };
    board.cards.push(card);

    db.prepare(`
      INSERT OR REPLACE INTO hermes_kanban_boards (board_id, user_id, board_json, updated_at_ms)
      VALUES (?, ?, ?, ?)
    `).run(board.board_id, auth.userId, JSON.stringify(board), Date.now());

    sendJson(ctx.res, 201, { card, board });
  });

  mountDual('patch', '/kanban/cards/:cardId', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const cardId = ctx.params.cardId!;
    const patch = await readJsonBody<Record<string, unknown>>(ctx.req);

    const rows = db
      .prepare(`SELECT board_id, board_json FROM hermes_kanban_boards WHERE user_id = ?`)
      .all(auth.userId) as Array<{ board_id: string; board_json: string }>;

    const validPriorities = new Set<HermesKanbanCardDto['priority']>(['low', 'medium', 'high', 'urgent']);
    for (const r of rows) {
      const board = JSON.parse(r.board_json) as HermesKanbanBoardDto;
      const idx = board.cards.findIndex((c) => c.card_id === cardId);
      if (idx !== -1) {
        const cur = board.cards[idx]!;
        const updatedCard: HermesKanbanCardDto = {
          ...cur,
          card_id: cardId,
          board_id: cur.board_id,
          updated_at_ms: Date.now(),
        };
        if (patch.column_id !== undefined) {
          if (typeof patch.column_id !== 'string' || !patch.column_id.trim()) {
            throw new ApiError(400, 'invalid_card', 'column_id must be a non-empty string');
          }
          updatedCard.column_id = patch.column_id.trim();
        }
        if (patch.title !== undefined) {
          if (typeof patch.title !== 'string' || !patch.title.trim()) {
            throw new ApiError(400, 'invalid_card', 'title must be a non-empty string');
          }
          updatedCard.title = patch.title.trim();
        }
        if (patch.description !== undefined) {
          if (typeof patch.description !== 'string') {
            throw new ApiError(400, 'invalid_card', 'description must be a string');
          }
          updatedCard.description = patch.description;
        }
        if (patch.priority !== undefined) {
          if (
            typeof patch.priority !== 'string' ||
            !validPriorities.has(patch.priority as HermesKanbanCardDto['priority'])
          ) {
            throw new ApiError(400, 'invalid_card', 'priority must be low, medium, high, or urgent');
          }
          updatedCard.priority = patch.priority as HermesKanbanCardDto['priority'];
        }
        if (patch.labels !== undefined) {
          if (!Array.isArray(patch.labels)) {
            throw new ApiError(400, 'invalid_card', 'labels must be an array of strings');
          }
          updatedCard.labels = patch.labels.filter((l): l is string => typeof l === 'string');
        }
        if (patch.position !== undefined) {
          if (typeof patch.position !== 'number' || !Number.isFinite(patch.position)) {
            throw new ApiError(400, 'invalid_card', 'position must be a finite number');
          }
          updatedCard.position = Math.max(0, Math.floor(patch.position));
        }
        if (patch.assignee !== undefined) {
          if (patch.assignee === null) {
            delete updatedCard.assignee;
          } else if (typeof patch.assignee === 'string') {
            updatedCard.assignee = patch.assignee.trim();
          } else {
            throw new ApiError(400, 'invalid_card', 'assignee must be a string or null');
          }
        }
        if (patch.checklist !== undefined) {
          if (!Array.isArray(patch.checklist)) {
            throw new ApiError(400, 'invalid_card', 'checklist must be an array');
          }
          updatedCard.checklist = patch.checklist
            .filter((item): item is Record<string, unknown> => isPlainObject(item) && typeof item.text === 'string')
            .map((item) => ({
              text: String(item.text),
              completed: Boolean(item.completed ?? item.done),
            }));
        }
        if (patch.comments !== undefined) {
          if (!Array.isArray(patch.comments)) {
            throw new ApiError(400, 'invalid_card', 'comments must be an array');
          }
          updatedCard.comments = patch.comments
            .filter((item): item is Record<string, unknown> => isPlainObject(item) && typeof item.text === 'string')
            .map((item) => ({
              author: typeof item.author === 'string' && item.author.trim() ? item.author.trim() : auth.username,
              text: String(item.text),
              created_at_ms:
                typeof item.created_at_ms === 'number' && Number.isFinite(item.created_at_ms)
                  ? item.created_at_ms
                  : Date.now(),
            }));
        }

        board.cards[idx] = updatedCard;
        db.prepare(`UPDATE hermes_kanban_boards SET board_json = ?, updated_at_ms = ? WHERE board_id = ? AND user_id = ?`).run(
          JSON.stringify(board),
          Date.now(),
          r.board_id,
          auth.userId,
        );
        sendJson(ctx.res, 200, { card: board.cards[idx], board });
        return;
      }
    }
    throw new ApiError(404, 'card_not_found', 'Kanban card not found');
  });

  mountDual('delete', '/kanban/cards/:cardId', (ctx) => {
    const auth = requireAuth(db, ctx);
    const cardId = ctx.params.cardId!;
    const rows = db
      .prepare(`SELECT board_id, board_json FROM hermes_kanban_boards WHERE user_id = ?`)
      .all(auth.userId) as Array<{ board_id: string; board_json: string }>;

    for (const r of rows) {
      const board = JSON.parse(r.board_json) as HermesKanbanBoardDto;
      const nextCards = board.cards.filter((c) => c.card_id !== cardId);
      if (nextCards.length !== board.cards.length) {
        board.cards = nextCards;
        db.prepare(`UPDATE hermes_kanban_boards SET board_json = ?, updated_at_ms = ? WHERE board_id = ? AND user_id = ?`).run(
          JSON.stringify(board),
          Date.now(),
          r.board_id,
          auth.userId,
        );
        sendJson(ctx.res, 200, { ok: true, deleted_card_id: cardId, board });
        return;
      }
    }
    throw new ApiError(404, 'card_not_found', 'Kanban card not found');
  });

  // ============================================================================
  // 9. New v1.6 Routes: `/providers`, `/usage`, `/rollback`, `/terminal/processes`, `/talk/turn`, `/acp`
  // ============================================================================
  mountDual('get', '/providers', (ctx) => {
    const auth = requireAuth(db, ctx);
    const snap = getUserMagpieStateSnapshot(db, config, auth.userId);
    sendJson(ctx.res, 200, {
      providers: snap.providers,
      active_provider: snap.active_provider,
      active_model: snap.active_model,
      has_configured_provider: snap.has_configured_provider,
      needs_provider_selection: snap.needs_provider_selection,
    });
  });

  mountDual('put', '/providers', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<Record<string, unknown>>(ctx.req);
    const view = upsertUserMagpieProvider(db, config, auth.userId, body);
    const snap = getUserMagpieStateSnapshot(db, config, auth.userId);
    sendJson(ctx.res, 200, {
      ok: true,
      provider: view,
      providers: snap.providers,
      active_provider: snap.active_provider,
      active_model: snap.active_model,
    });
  });

  mountDual('get', '/usage', (ctx) => {
    const auth = requireAuth(db, ctx);
    const ledgerRows = db
      .prepare(
        `SELECT model, prompt_tokens, completion_tokens FROM magpie_usage_ledger WHERE user_id = ?`,
      )
      .all(auth.userId) as Array<{ model: string; prompt_tokens: number; completion_tokens: number }>;
    const turnsRow = db
      .prepare(`SELECT COUNT(*) AS cnt FROM hermes_turns WHERE user_id = ?`)
      .get(auth.userId) as { cnt: number };

    let promptTokens = 0;
    let completionTokens = 0;
    const byModelMap = new Map<string, { requests: number; prompt_tokens: number; completion_tokens: number }>();
    for (const r of ledgerRows) {
      const pt = Number(r.prompt_tokens ?? 0);
      const ct = Number(r.completion_tokens ?? 0);
      promptTokens += pt;
      completionTokens += ct;
      const cur = byModelMap.get(r.model) ?? { requests: 0, prompt_tokens: 0, completion_tokens: 0 };
      cur.requests += 1;
      cur.prompt_tokens += pt;
      cur.completion_tokens += ct;
      byModelMap.set(r.model, cur);
    }

    sendJson(ctx.res, 200, {
      total_turns: Number(turnsRow.cnt ?? 0),
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      estimated_cost_usd: 0,
      tool_calls: 0,
      by_model: Object.fromEntries(byModelMap.entries()),
    });
  });

  mountDual('post', '/rollback', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      session_id?: string;
      checkpoint_id?: string;
      turn_index?: unknown;
    }>(ctx.req);
    const sid = typeof body.session_id === 'string' ? body.session_id.trim() : '';
    if (!sid) throw new ApiError(400, 'invalid_session_id', 'session_id is required');
    const row = db
      .prepare(`SELECT messages_json, checkpoints_json FROM hermes_sessions WHERE session_id = ? AND user_id = ?`)
      .get(sid, auth.userId) as { messages_json: string; checkpoints_json: string } | undefined;
    if (!row) throw new ApiError(404, 'session_not_found', 'Session not found');

    const msgs = JSON.parse(row.messages_json) as StoredHermesMessage[];
    const checkpoints = JSON.parse(row.checkpoints_json || '[]') as Array<{
      id: string;
      message_count: number;
    }>;

    let keepCount = 0;
    if (typeof body.checkpoint_id === 'string' && body.checkpoint_id.trim()) {
      const cp = checkpoints.find((c) => c.id === body.checkpoint_id!.trim());
      if (!cp) throw new ApiError(404, 'checkpoint_not_found', 'Checkpoint not found');
      keepCount = cp.message_count;
    } else if (body.turn_index !== undefined) {
      if (
        typeof body.turn_index !== 'number' ||
        !Number.isInteger(body.turn_index) ||
        body.turn_index < 0
      ) {
        throw new ApiError(400, 'invalid_turn_index', 'turn_index must be a non-negative integer');
      }
      keepCount = Math.min(msgs.length, body.turn_index * 2);
    } else if (checkpoints.length > 0) {
      keepCount = checkpoints[checkpoints.length - 1]!.message_count;
    }

    const rolled = msgs.slice(0, keepCount);
    db.prepare(`UPDATE hermes_sessions SET messages_json = ?, updated_at_ms = ? WHERE session_id = ?`).run(
      JSON.stringify(rolled),
      Date.now(),
      sid,
    );
    sendJson(ctx.res, 200, { ok: true, session_id: sid, remaining_messages: rolled.length });
  });

  mountDual('get', '/terminal/processes', (ctx) => {
    requireAuth(db, ctx);
    sendJson(ctx.res, 200, { processes: [], total: 0 });
  });

  mountDual('post', '/talk/turn', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      transcript?: string;
      prompt?: string;
      session_id?: string;
      chat_id?: unknown;
    }>(ctx.req);
    const transcript = (
      typeof body.transcript === 'string'
        ? body.transcript
        : typeof body.prompt === 'string'
          ? body.prompt
          : ''
    ).trim();
    if (!transcript) {
      throw new ApiError(400, 'empty_transcript', 'transcript is required');
    }
    const mem = getHermesMemoryState(db, auth.userId);
    const llmRes = await runConfiguredLlmCompletion(db, config, auth.userId, [
      { role: 'system', content: mem.soul },
      { role: 'user', content: transcript },
    ]);
    if (llmRes.unconfigured) {
      throw new ApiError(
        503,
        'provider_not_configured',
        'No AI model provider is configured for Talk Mode.',
        {
          needs_provider_selection: true,
          action: 'hermes:open_ai_providers',
        },
      );
    }
    if (!llmRes.usedUpstream) {
      throw new ApiError(502, 'upstream_unreachable', llmRes.error || 'Upstream LLM failed');
    }
    sendJson(ctx.res, 200, {
      ok: true,
      reply: llmRes.text,
      model: llmRes.model,
      provider: llmRes.providerId,
      usage: llmRes.usage,
    });
  });

  mountDual('post', '/acp', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      jsonrpc?: string;
      id?: string | number | null;
      method?: string;
      params?: Record<string, unknown>;
    }>(ctx.req);
    const rpcId = body.id ?? null;
    const method = typeof body.method === 'string' ? body.method : '';

    if (method === 'initialize') {
      sendJson(ctx.res, 200, {
        jsonrpc: '2.0',
        id: rpcId,
        result: {
          protocolVersion: 1,
          agentInfo: { name: 'fabushi-agent', version: config.appVersion },
          capabilities: { prompt: true, sessions: true },
        },
      });
      return;
    }

    if (method === 'session/new') {
      const sid = `acp_${crypto.randomBytes(8).toString('hex')}`;
      const now = Date.now();
      const magpie = getUserMagpieStateSnapshot(db, config, auth.userId);
      db.prepare(`
        INSERT INTO hermes_sessions (
          session_id, user_id, chat_id, bot_id, title, source, model,
          messages_json, checkpoints_json, total_tokens, total_cost_usd, created_at_ms, updated_at_ms
        ) VALUES (?, ?, NULL, 777000, 'ACP Session', 'acp', ?, '[]', '[]', 0, 0, ?, ?)
      `).run(sid, auth.userId, magpie.active_model, now, now);
      sendJson(ctx.res, 200, {
        jsonrpc: '2.0',
        id: rpcId,
        result: { sessionId: sid },
      });
      return;
    }

    if (method === 'session/prompt') {
      const params = isPlainObject(body.params) ? body.params : {};
      const prompt = typeof params.prompt === 'string' ? params.prompt.trim() : '';
      if (!prompt) {
        sendJson(ctx.res, 400, {
          jsonrpc: '2.0',
          id: rpcId,
          error: { code: -32602, message: 'Missing prompt parameter' },
        });
        return;
      }
      const mem = getHermesMemoryState(db, auth.userId);
      const llmRes = await runConfiguredLlmCompletion(db, config, auth.userId, [
        { role: 'system', content: mem.soul },
        { role: 'user', content: prompt },
      ]);
      if (llmRes.unconfigured) {
        sendJson(ctx.res, 503, {
          jsonrpc: '2.0',
          id: rpcId,
          error: {
            code: -32003,
            message: 'provider_not_configured',
            data: { needs_provider_selection: true, action: 'hermes:open_ai_providers' },
          },
        });
        return;
      }
      if (!llmRes.usedUpstream) {
        sendJson(ctx.res, 502, {
          jsonrpc: '2.0',
          id: rpcId,
          error: { code: -32004, message: llmRes.error || 'upstream_unreachable' },
        });
        return;
      }
      sendJson(ctx.res, 200, {
        jsonrpc: '2.0',
        id: rpcId,
        result: {
          stopReason: 'end_turn',
          text: llmRes.text,
          model: llmRes.model,
          provider: llmRes.providerId,
        },
      });
      return;
    }

    sendJson(ctx.res, 404, {
      jsonrpc: '2.0',
      id: rpcId,
      error: { code: -32601, message: `Unknown ACP method: ${method}` },
    });
  });

  // ============================================================================
  // 10. Unified `/api/v1/fabushi-bots[/:botId]` CRUD (with Coding Agent Bot support!)
  // ============================================================================
  const resolveBotRow = (
    rawId: string,
  ): { bot_user_id: number; owner_user_id: number; bot_token: string; bot_json: string } | undefined => {
    const trimmed = rawId.trim().replace(/^@/, '');
    if (!trimmed) return undefined;
    if (/^\d+$/.test(trimmed)) {
      return db
        .prepare(`SELECT bot_user_id, owner_user_id, bot_token, bot_json FROM bots_registry WHERE bot_user_id = ?`)
        .get(Number(trimmed)) as
        | { bot_user_id: number; owner_user_id: number; bot_token: string; bot_json: string }
        | undefined;
    }
    const all = db
      .prepare(`SELECT bot_user_id, owner_user_id, bot_token, bot_json FROM bots_registry`)
      .all() as Array<{ bot_user_id: number; owner_user_id: number; bot_token: string; bot_json: string }>;
    const lower = trimmed.toLowerCase();
    return all.find((r) => {
      const entry = JSON.parse(r.bot_json) as BotRegistryEntry;
      return (
        entry.username.toLowerCase() === lower ||
        (entry.agent_id && entry.agent_id.toLowerCase() === lower)
      );
    });
  };

  router.get('/api/v1/fabushi-bots', (ctx) => {
    const auth = requireAuth(db, ctx);
    const rows = db
      .prepare(`SELECT bot_user_id, owner_user_id, bot_json FROM bots_registry ORDER BY bot_user_id ASC`)
      .all() as Array<{ bot_user_id: number; owner_user_id: number; bot_json: string }>;

    const bots: FabushiBotSummaryDto[] = [];
    for (const r of rows) {
      if (Number(r.bot_user_id) === BOTFATHER_USER_ID) continue;
      const entry = JSON.parse(r.bot_json) as BotRegistryEntry;
      const isVisible =
        entry.is_official ||
        Number(r.owner_user_id) === auth.userId ||
        Boolean(findCompanionChatId(db, auth.userId, Number(r.bot_user_id))) ||
        Boolean(
          db
            .prepare(`SELECT 1 FROM mini_apps WHERE bot_user_id = ? LIMIT 1`)
            .get(Number(r.bot_user_id)),
        );
      if (!isVisible) continue;
      bots.push(buildFabushiBotSummary(db, auth.userId, entry));
    }

    sendJson(ctx.res, 200, { bots, total: bots.length });
  });

  router.post('/api/v1/fabushi-bots', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      display_name?: string;
      username?: string | null;
      agent_id?: string | null;
      description?: string;
      title?: string;
      avatar_shape?: string | null;
      avatar_color?: string | null;
      preferred_model?: string | null;
      thinking_level?: string | null;
      approval_mode?: string | null;
      toolset_preset?: string | null;
      coding_agent?: unknown;
    }>(ctx.req);

    const displayName = typeof body.display_name === 'string' ? body.display_name.trim() : '';
    if (!displayName || displayName.length > 64) {
      throw new ApiError(400, 'invalid_display_name', 'display_name must be 1..64 characters');
    }

    if (body.username !== undefined && body.username !== null && typeof body.username !== 'string') {
      throw new ApiError(400, 'invalid_bot_username', 'username must be a string');
    }
    if (body.agent_id !== undefined && body.agent_id !== null && typeof body.agent_id !== 'string') {
      throw new ApiError(400, 'invalid_agent_id', 'agent_id must be a string');
    }

    let requestedUsername: string | null = null;
    if (typeof body.username === 'string' && body.username.trim().length > 0) {
      const cleaned = body.username.trim().replace(/^@/, '');
      if (!BOT_USERNAME_RE.test(cleaned) || !/bot$/i.test(cleaned)) {
        throw new ApiError(
          400,
          'invalid_bot_username',
          'Bot username must be 4-32 alphanumeric/underscore characters starting with a letter and ending in "bot"',
        );
      }
      requestedUsername = cleaned;
    }

    let codingAgent: CodingAgentBotConfig | null = null;
    if (body.coding_agent !== undefined && body.coding_agent !== null) {
      codingAgent = validateCodingAgentConfig(body.coding_agent);
    }

    const now = Date.now();
    const commands = codingAgent
      ? CODING_SLASH_COMMANDS.map((c) => ({ command: c.command, description: c.description }))
      : [
          { command: 'start', description: 'Start conversation with this bot' },
          { command: 'help', description: 'Show available bot commands' },
          { command: 'new', description: 'Start a fresh session' },
        ];

    let botUserId = 0;
    let botToken = '';
    let companionChatId = 0;
    let entry!: BotRegistryEntry;

    db.exec('BEGIN IMMEDIATE;');
    try {
      let username = '';
      if (requestedUsername !== null) {
        const existing = db
          .prepare(`SELECT 1 FROM users WHERE LOWER(username) = LOWER(?)`)
          .get(requestedUsername);
        if (existing) {
          throw new ApiError(409, 'username_taken', `Bot username @${requestedUsername} is already taken`);
        }
        username = requestedUsername;
      } else {
        const baseSlug =
          displayName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 16) || 'agent';
        const prefix = /^[a-z]/.test(baseSlug) ? baseSlug : `b_${baseSlug}`;
        for (let attempt = 0; attempt < 8; attempt++) {
          const candidate = `${prefix}_${crypto.randomBytes(3).toString('hex')}_bot`;
          const taken = db
            .prepare(`SELECT 1 FROM users WHERE LOWER(username) = LOWER(?)`)
            .get(candidate);
          if (!taken) {
            username = candidate;
            break;
          }
        }
        if (!username) {
          username = `${prefix}_${crypto.randomBytes(5).toString('hex')}_bot`;
        }
      }

      const maxRow = db
        .prepare(`SELECT COALESCE(MAX(user_id), 799999) AS max_id FROM users WHERE user_id >= 800000`)
        .get() as { max_id: number };
      botUserId = Math.max(800_000, Number(maxRow.max_id) + 1);

      const agentId =
        typeof body.agent_id === 'string' && body.agent_id.trim()
          ? body.agent_id.trim()
          : username.toLowerCase();
      const resolvedAvatar = resolveGrokBotAvatar(agentId, {
        shape: typeof body.avatar_shape === 'string' ? body.avatar_shape : undefined,
        color: typeof body.avatar_color === 'string' ? body.avatar_color : undefined,
      });

      botToken = `${botUserId}:AA${crypto.randomBytes(18).toString('base64url')}`;
      entry = {
        bot_user_id: botUserId,
        owner_user_id: auth.userId,
        username,
        display_name: displayName,
        description: typeof body.description === 'string' ? body.description.trim() : '',
        about: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : displayName,
        ai_persona:
          typeof body.description === 'string' && body.description.trim()
            ? body.description.trim()
            : `You are ${displayName}, an AI assistant bot.`,
        commands,
        is_official: false,
        is_inline: true,
        allow_attach_menu: false,
        menu_button_type: 'commands',
        has_main_app: false,
        preferred_model: typeof body.preferred_model === 'string' ? body.preferred_model.trim() : '',
        thinking_level: typeof body.thinking_level === 'string' ? body.thinking_level.trim() : 'medium',
        approval_mode:
          body.approval_mode === 'read_only' || body.approval_mode === 'yolo'
            ? body.approval_mode
            : 'ask',
        toolset_preset:
          typeof body.toolset_preset === 'string' && body.toolset_preset.trim()
            ? body.toolset_preset.trim()
            : 'hermes-telegram',
        created_at_ms: now,
        agent_id: agentId,
        avatar_shape: resolvedAvatar.shape,
        avatar_color: resolvedAvatar.color,
        is_fabushi_bot: true,
        can_join_groups: true,
        coding_agent: codingAgent,
      };

      db.prepare(`
        INSERT INTO users (
          user_id, username, first_name, last_name, bio, phone, email,
          password_salt, password_hash, emoji_status, is_bot, is_verified, is_premium,
          status, last_seen_ms, created_at_ms
        ) VALUES (?, ?, ?, '', ?, NULL, NULL, NULL, NULL, '🤖', 1, 0, 0, 'bot', ?, ?)
      `).run(botUserId, username, displayName, entry.description, now, now);

      db.prepare(`
        INSERT INTO bots_registry (bot_user_id, owner_user_id, bot_token, bot_json, created_at_ms)
        VALUES (?, ?, ?, ?, ?)
      `).run(botUserId, auth.userId, botToken, JSON.stringify(entry), now);

      // Companion 1:1 DM chat created with ZERO messages (`last_message_id = 0`) so `#bot-prestart-bar` renders!
      const mxRow = db.prepare(`SELECT COALESCE(MAX(chat_id), 500) AS mx FROM chats`).get() as { mx: number };
      companionChatId = Math.max(501, Number(mxRow.mx) + 1);
      db.prepare(`
        INSERT INTO chats (
          chat_id, title, kind, chat_type, creator_id, peer_user_id, username, about,
          is_forum, is_verified, pts, next_msg_id, last_message_id, last_message_date_ms, created_at_ms
        ) VALUES (?, ?, 'bot', 0, ?, ?, NULL, ?, 0, 1, 0, 1, 0, ?, ?)
      `).run(
        companionChatId,
        displayName,
        auth.userId,
        botUserId,
        entry.description || null,
        now,
        now,
      );

      db.prepare(`
        INSERT INTO chat_members (chat_id, user_id, role, joined_at_ms) VALUES (?, ?, 'owner', ?)
      `).run(companionChatId, auth.userId, now);
      db.prepare(`
        INSERT INTO chat_members (chat_id, user_id, role, joined_at_ms) VALUES (?, ?, 'member', ?)
      `).run(companionChatId, botUserId, now);

      db.prepare(`
        INSERT OR REPLACE INTO user_bot_permissions (
          user_id, bot_user_id, allows_write_to_pm, has_started_chat, app_tos_accepted_at, updated_at_ms
        ) VALUES (?, ?, 1, 0, 0, ?)
      `).run(auth.userId, botUserId, now);

      db.exec('COMMIT;');
    } catch (err) {
      try {
        db.exec('ROLLBACK;');
      } catch {
        // Already rolled back
      }
      throw err;
    }

    const summary = buildFabushiBotSummary(db, auth.userId, entry);
    summary.companion_chat_id = companionChatId;
    const response: FabushiBotCreateResponse = {
      bot: summary,
      registry: entry,
      bot_token: botToken,
      companion_chat_id: companionChatId,
    };
    sendJson(ctx.res, 201, response);
  });

  router.get('/api/v1/fabushi-bots/:botId', (ctx) => {
    const auth = requireAuth(db, ctx);
    const row = resolveBotRow(ctx.params.botId!);
    if (!row || Number(row.bot_user_id) === BOTFATHER_USER_ID) {
      throw new ApiError(404, 'bot_not_found', 'Bot not found');
    }
    const entry = JSON.parse(row.bot_json) as BotRegistryEntry;
    const hasMiniApp = Boolean(
      db.prepare(`SELECT 1 FROM mini_apps WHERE bot_user_id = ? LIMIT 1`).get(row.bot_user_id),
    );
    if (
      !entry.is_official &&
      Number(row.owner_user_id) !== auth.userId &&
      !hasMiniApp &&
      !findCompanionChatId(db, auth.userId, Number(row.bot_user_id))
    ) {
      throw new ApiError(403, 'forbidden', 'You do not have access to this private bot');
    }
    const summary = buildFabushiBotSummary(db, auth.userId, entry);
    const safeRegistry =
      Number(row.owner_user_id) === auth.userId || entry.is_official
        ? entry
        : { ...entry, ai_persona: '', coding_agent: null };
    sendJson(ctx.res, 200, { ...summary, bot: summary, registry: safeRegistry });
  });

  router.patch('/api/v1/fabushi-bots/:botId', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const row = resolveBotRow(ctx.params.botId!);
    if (!row || Number(row.bot_user_id) === BOTFATHER_USER_ID) {
      throw new ApiError(404, 'bot_not_found', 'Bot not found');
    }
    if (Number(row.owner_user_id) !== auth.userId) {
      throw new ApiError(403, 'forbidden', 'Only the bot owner can modify this bot');
    }

    const patch = await readJsonBody<{
      display_name?: unknown;
      description?: unknown;
      title?: unknown;
      avatar_shape?: unknown;
      avatar_color?: unknown;
      preferred_model?: unknown;
      thinking_level?: unknown;
      approval_mode?: unknown;
      toolset_preset?: unknown;
      notify_on_agent_updates?: boolean | null;
      hidden_from_sidebar?: boolean | null;
      coding_agent?: unknown;
    }>(ctx.req);

    const entry = JSON.parse(row.bot_json) as BotRegistryEntry;

    if (patch.display_name !== undefined && patch.display_name !== null && typeof patch.display_name !== 'string') {
      throw new ApiError(400, 'invalid_display_name', 'display_name must be a string');
    }
    if (typeof patch.display_name === 'string') {
      const dn = patch.display_name.trim();
      if (!dn || dn.length > 64) {
        throw new ApiError(400, 'invalid_display_name', 'display_name must be 1..64 characters');
      }
      entry.display_name = dn;
    }
    if (typeof patch.description === 'string') {
      entry.description = patch.description.trim();
    }
    if (typeof patch.title === 'string') {
      entry.about = patch.title.trim();
    }
    if (patch.avatar_shape !== undefined || patch.avatar_color !== undefined) {
      const resolved = resolveGrokBotAvatar(entry.agent_id || entry.username.toLowerCase(), {
        shape: typeof patch.avatar_shape === 'string' ? patch.avatar_shape : entry.avatar_shape,
        color: typeof patch.avatar_color === 'string' ? patch.avatar_color : entry.avatar_color,
      });
      entry.avatar_shape = resolved.shape;
      entry.avatar_color = resolved.color;
    }
    if (typeof patch.preferred_model === 'string') entry.preferred_model = patch.preferred_model.trim();
    if (typeof patch.thinking_level === 'string') entry.thinking_level = patch.thinking_level.trim();
    if (patch.approval_mode === 'ask' || patch.approval_mode === 'read_only' || patch.approval_mode === 'yolo') {
      entry.approval_mode = patch.approval_mode;
    }
    if (typeof patch.toolset_preset === 'string') entry.toolset_preset = patch.toolset_preset.trim();

    if (patch.coding_agent !== undefined) {
      if (patch.coding_agent === null) {
        entry.coding_agent = null;
      } else {
        entry.coding_agent = validateCodingAgentConfig(patch.coding_agent);
        entry.commands = CODING_SLASH_COMMANDS.map((c) => ({
          command: c.command,
          description: c.description,
        }));
      }
    }

    db.prepare(`UPDATE bots_registry SET bot_json = ? WHERE bot_user_id = ?`).run(
      JSON.stringify(entry),
      row.bot_user_id,
    );
    db.prepare(`UPDATE users SET first_name = ?, bio = ? WHERE user_id = ?`).run(
      entry.display_name,
      entry.description,
      row.bot_user_id,
    );

    const summary = buildFabushiBotSummary(db, auth.userId, entry);
    sendJson(ctx.res, 200, { ...summary, bot: summary, registry: entry });
  });

  router.delete('/api/v1/fabushi-bots/:botId', (ctx) => {
    const auth = requireAuth(db, ctx);
    const row = resolveBotRow(ctx.params.botId!);
    if (!row || Number(row.bot_user_id) === BOTFATHER_USER_ID) {
      throw new ApiError(404, 'bot_not_found', 'Bot not found');
    }
    const entry = JSON.parse(row.bot_json) as BotRegistryEntry;
    const botUserId = Number(row.bot_user_id);
    if (
      entry.is_official ||
      botUserId < 800_000 ||
      Number(row.owner_user_id) !== auth.userId
    ) {
      throw new ApiError(403, 'forbidden', 'Cannot delete official, system, or unowned bot');
    }

    db.exec('BEGIN IMMEDIATE;');
    try {
      db.prepare(
        `DELETE FROM mini_app_installs WHERE app_id IN (SELECT app_id FROM mini_apps WHERE bot_user_id = ?)`,
      ).run(botUserId);
      db.prepare(`DELETE FROM mini_apps WHERE bot_user_id = ?`).run(botUserId);
      db.prepare(`DELETE FROM user_bot_permissions WHERE bot_user_id = ?`).run(botUserId);
      db.prepare(`DELETE FROM bot_api_updates WHERE bot_user_id = ?`).run(botUserId);
      db.prepare(`DELETE FROM bot_computer_profiles WHERE bot_id = ?`).run(botUserId);
      db.prepare(`DELETE FROM bots_registry WHERE bot_user_id = ?`).run(botUserId);
      db.prepare(`DELETE FROM chat_members WHERE user_id = ?`).run(botUserId);
      db.prepare(`DELETE FROM users WHERE user_id = ? AND is_bot = 1`).run(botUserId);
      db.exec('COMMIT;');
    } catch (err) {
      try {
        db.exec('ROLLBACK;');
      } catch {
        // Already rolled back
      }
      throw err;
    }

    sendJson(ctx.res, 200, {
      ok: true,
      deleted_bot_id: botUserId,
      deleted_bot_user_id: botUserId,
      username: entry.username,
    });
  });
}
