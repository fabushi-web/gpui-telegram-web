import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  HERMES_TOOLSET_IDS,
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
import { createMessageAtomic } from '../db/queries.js';
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
  { name: 'fallback', aliases: [], category: 'model_and_provider', description: 'Toggle local Hermes fallback', usage: '/fallback [on|off]' },
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

  // 8. Modes & UI (5) -> Total = 11 + 7 + 11 + 6 + 8 + 8 + 5 + 5 = 61 commands!
  { name: 'studio', aliases: ['panel'], category: 'modes_and_ui', description: 'Open Hermes 6-Tab Studio drawer', usage: '/studio [tab]' },
  { name: 'magpie', aliases: ['gateway'], category: 'modes_and_ui', description: 'Open Magpie LLM Gateway configuration', usage: '/magpie' },
  { name: 'voice', aliases: ['talk'], category: 'modes_and_ui', description: 'Toggle Full-Duplex Talk Mode', usage: '/voice' },
  { name: 'computer', aliases: ['desktop'], category: 'modes_and_ui', description: 'Open Remote Computer Workbench', usage: '/computer' },
  { name: 'verbose', aliases: ['debug'], category: 'modes_and_ui', description: 'Toggle verbose tool trace output', usage: '/verbose' },
];

const DANGEROUS_COMMAND_REGEX = /\b(rm\s+-rf|mkfs|dd\s+if=|chmod\s+777|curl\s+[^|]+\|\s*(?:ba)?sh|sudo\s+rm)\b/i;
const SKILL_EXFIL_REGEX = /(curl\s+[^\n]*\$[A-Z_]*KEY|wget\s+[^\n]*token|eval\s*\(|nc\s+-e|bash\s+-i)/i;

interface StoredHermesMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  reasoning?: string;
  tool_calls?: Array<{ id: string; name: string; arguments: unknown; output: string }>;
  created_at_ms: number;
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
    'You are Hermes AI, a precise systems engineering assistant.',
  );
  const obsRaw = getHermesKv(db, userId, 'honcho_obs', '[]');
  let obs: string[] = [];
  try {
    obs = JSON.parse(obsRaw) as string[];
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

function getOrCreateHermesSession(
  db: DatabaseSync,
  userId: number,
  sessionId?: string,
  chatId?: number,
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
    .prepare(`SELECT * FROM hermes_sessions WHERE user_id = ? ORDER BY updated_at_ms DESC LIMIT 1`)
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
    ) VALUES (?, ?, NULL, ?, 777000, 'Hermes Session', 'web', 'hermes-local-v1', '[]', '[]', 0, 0, ?, ?)
  `).run(newId, userId, chatId ?? 106, now, now);

  return {
    session_id: newId,
    title: 'Hermes Session',
    model: 'hermes-local-v1',
    messages: [],
    checkpoints: [],
    total_tokens: 0,
    total_cost_usd: 0,
  };
}

export function executeSlashCommandInternal(
  db: DatabaseSync,
  userId: number,
  rawCommand: string,
  sessionId?: string,
  chatId?: number,
): {
  ok: boolean;
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

  const session = getOrCreateHermesSession(db, userId, sessionId, chatId);
  const now = Date.now();

  if (!spec) {
    return {
      ok: false,
      command: rawVerb,
      response_text: `Unknown command \`/${rawVerb}\`. Type \`/help\` to view all ${HERMES_COMMAND_CATALOG.length} available commands.`,
      session_id: session.session_id,
      ui_effect: { kind: 'none' },
    };
  }

  switch (spec.name.toLowerCase()) {
    case 'help': {
      const grouped = new Map<string, string[]>();
      for (const c of HERMES_COMMAND_CATALOG) {
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
        response_text: `**Hermes Slash Commands (${HERMES_COMMAND_CATALOG.length} total)**:\n${lines.join('\n')}`,
        session_id: session.session_id,
        ui_effect: { kind: 'none' },
      };
    }

    case 'status': {
      const mem = getHermesMemoryState(db, userId);
      const toolsets = JSON.parse(getHermesKv(db, userId, 'enabled_toolsets', '[]')) as string[];
      return {
        ok: true,
        command: 'status',
        response_text: `**Hermes Runtime Status**\n• Session: \`${session.session_id}\` (${session.messages.length} msgs)\n• Model: \`${session.model}\`\n• Toolsets enabled: ${toolsets.length}/${HERMES_TOOLSET_IDS.length}\n• MEMORY.md: ${mem.memory.chars}/2200 chars · USER.md: ${mem.user.chars}/1375 chars`,
        session_id: session.session_id,
        ui_effect: { kind: 'none' },
      };
    }

    case 'new': {
      const newSid = `hses_${crypto.randomBytes(8).toString('hex')}`;
      const title = argStr || 'New Hermes Session';
      db.prepare(`
        INSERT INTO hermes_sessions (
          session_id, user_id, chat_id, bot_id, title, source, model,
          messages_json, checkpoints_json, total_tokens, total_cost_usd, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, 777000, ?, 'slash', ?, '[]', '[]', 0, 0, ?, ?)
      `).run(newSid, userId, chatId ?? 106, title, session.model, now, now);
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
        chatId ?? 106,
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

    case 'checkpoint': {
      const cpId = `cp_${crypto.randomBytes(4).toString('hex')}`;
      const checkpoints = [
        ...session.checkpoints,
        { id: cpId, label: argStr || `Snapshot #${session.checkpoints.length + 1}`, message_count: session.messages.length, created_at_ms: now },
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
        response_text: `Current model: \`${session.model}\`.`,
        session_id: session.session_id,
        ui_effect: { kind: 'none' },
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

    case 'personality': {
      if (argStr) {
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
        command: 'personality',
        response_text: `**SOUL.md**:\n${mem.soul}`,
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
            ? `Recent sessions:\n${rows.map((r) => `• \`${r.session_id}\` — **${r.title}** (${r.model})`).join('\n')}`
            : 'No sessions yet.',
        session_id: session.session_id,
        ui_effect: { kind: 'open_studio', payload: { tab: 'sessions' } },
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
      const nextMode = argStr === 'off' ? 'ask' : argStr === 'on' ? 'yolo' : currentMode === 'yolo' ? 'ask' : 'yolo';
      setHermesKv(db, userId, 'approval_mode', nextMode);
      return {
        ok: true,
        command: 'yolo',
        response_text: `Approval mode set to \`${nextMode}\`.`,
        session_id: session.session_id,
        ui_effect: { kind: 'approval_mode_changed', payload: { mode: nextMode } },
      };
    }

    case 'studio': {
      const tab = argStr || 'sessions';
      return {
        ok: true,
        command: 'studio',
        response_text: `Opening Hermes 6-Tab Studio (\`${tab}\`).`,
        session_id: session.session_id,
        ui_effect: { kind: 'open_studio', payload: { tab } },
      };
    }

    default:
      return {
        ok: true,
        command: spec.name,
        response_text: `Executed \`/${spec.name}\`${argStr ? ` with \`${argStr}\`` : ''} — ${spec.description}.`,
        session_id: session.session_id,
        ui_effect: { kind: 'none' },
      };
  }
}

export function registerHermesStudioRoutes(
  router: HttpRouter,
  db: DatabaseSync,
  hub: RealtimeGatewayHub,
): void {
  // 1. Runtime Status & Slash Commands
  router.get('/api/v1/hermes/status', (ctx) => {
    const auth = requireAuth(db, ctx);
    const mem = getHermesMemoryState(db, auth.userId);
    const enabledToolsets = JSON.parse(getHermesKv(db, auth.userId, 'enabled_toolsets', '[]')) as string[];
    const sessionCnt = db
      .prepare(`SELECT COUNT(*) AS cnt FROM hermes_sessions WHERE user_id = ?`)
      .get(auth.userId) as { cnt: number };
    const skillCnt = db
      .prepare(`SELECT COUNT(*) AS cnt FROM hermes_skills WHERE user_id = ?`)
      .get(auth.userId) as { cnt: number };

    sendJson(ctx.res, 200, {
      ready: true,
      version: '1.2.0',
      active_model: 'hermes-local-v1',
      active_provider: 'local_hermes',
      approval_mode: getHermesKv(db, auth.userId, 'approval_mode', 'ask'),
      session_count: Number(sessionCnt.cnt),
      skill_count: Number(skillCnt.cnt),
      enabled_toolsets_count: enabledToolsets.length,
      total_toolsets_count: HERMES_TOOLSET_IDS.length,
      commands_count: HERMES_COMMAND_CATALOG.length,
      memory_chars: mem.memory.chars,
      user_chars: mem.user.chars,
    });
  });

  router.get('/api/v1/hermes/commands', (ctx) => {
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
      chat_id?: number;
    }>(ctx.req);
    const rawCmd = body.command ?? body.input ?? '/help';
    const result = executeSlashCommandInternal(db, auth.userId, rawCmd, body.session_id, body.chat_id);
    sendJson(ctx.res, 200, result);
  };
  router.post('/api/v1/hermes/commands/execute', handleExecuteCommand);
  router.post('/api/v1/hermes/command', handleExecuteCommand);

  // 2. Streaming & Synchronous Agent Turn Execution (`/api/v1/hermes/turns` & `/turns/:id/events`)
  router.post('/api/v1/hermes/turns', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      prompt?: string;
      input?: string;
      session_id?: string;
      chat_id?: number;
      model?: string;
      stream?: boolean;
      deliver_to_chat?: boolean;
    }>(ctx.req);

    const rawPrompt = (body.prompt ?? body.input ?? '').trim();
    if (!rawPrompt) {
      throw new ApiError(400, 'empty_prompt', 'Prompt cannot be empty');
    }

    const wantsSse =
      body.stream === true ||
      (ctx.req.headers.accept ?? '').includes('text/event-stream');

    // Intercept slash commands cleanly for BOTH synchronous JSON and SSE streams!
    if (rawPrompt.startsWith('/')) {
      const slashRes = executeSlashCommandInternal(
        db,
        auth.userId,
        rawPrompt,
        body.session_id,
        body.chat_id,
      );
      const turnId = `turn_${crypto.randomBytes(6).toString('hex')}`;
      const slashEvents: HermesStreamEvent[] = [
        {
          type: 'turn_started',
          turn_id: turnId,
          session_id: slashRes.session_id,
          model: 'hermes-local-v1',
          provider: 'local_hermes',
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
          model: 'hermes-local-v1',
          provider: 'local_hermes',
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

    const session = getOrCreateHermesSession(db, auth.userId, body.session_id, body.chat_id);
    const turnId = `turn_${crypto.randomBytes(8).toString('hex')}`;
    const model = body.model ?? session.model;
    const approvalMode = getHermesKv(db, auth.userId, 'approval_mode', 'ask');

    // Privacy Masking before persistence & execution!
    const magpieRow = db
      .prepare(`SELECT state_json FROM magpie_state WHERE user_id = ?`)
      .get(auth.userId) as { state_json: string } | undefined;
    const maskingCfg = magpieRow
      ? JSON.parse(magpieRow.state_json).masking
      : { enabled: true, mask_secrets: true, mask_personal: true, custom_words: [], allow_list: [], default_action: 'mask' };
    const masked = runPrivacyMasking(rawPrompt, maskingCfg);
    const safePrompt = masked.masked_text;

    const events: HermesStreamEvent[] = [];
    events.push({
      type: 'turn_started',
      turn_id: turnId,
      session_id: session.session_id,
      model,
      provider: 'local_hermes',
    });

    const reasoningText = `Analyzing request (${safePrompt.length} chars) with bounded MEMORY.md context and active toolsets.`;
    events.push({
      type: 'thinking_delta',
      turn_id: turnId,
      delta: reasoningText,
    });

    // Check dangerous command guard (`approval_required` unless `approval_mode === 'yolo'`)
    let responseText: string;
    let toolCallsCount = 0;

    if (DANGEROUS_COMMAND_REGEX.test(safePrompt) && approvalMode !== 'yolo') {
      const approvalId = `appr_${crypto.randomBytes(6).toString('hex')}`;
      const approvalItem: HermesApprovalItem = {
        approval_id: approvalId,
        session_id: session.session_id,
        tool_name: 'terminal',
        command: safePrompt,
        reason: 'Destructive shell pattern detected by Hermes security guard',
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
      responseText = `⚠️ Execution paused: High-risk command requires explicit approval (\`${approvalId}\`) in **Hermes Studio -> Toolsets / Approvals**.`;
    } else {
      const toolCallId = `tc_${crypto.randomBytes(4).toString('hex')}`;
      toolCallsCount = 1;
      events.push({
        type: 'tool_call_started',
        turn_id: turnId,
        tool_call_id: toolCallId,
        tool_name: 'memory_lookup',
        arguments: { query: safePrompt.slice(0, 64) },
      });
      events.push({
        type: 'tool_call_finished',
        turn_id: turnId,
        tool_call_id: toolCallId,
        tool_name: 'memory_lookup',
        ok: true,
        output_preview: 'Loaded bounded MEMORY.md & active workspace metadata',
        duration_ms: 4,
      });

      responseText = `**Hermes AI Response**: Processed "${safePrompt}".\n• Session: \`${session.session_id}\`\n• Model: \`${model}\`${masked.hit_count > 0 ? `\n• Privacy Masking: Redacted ${masked.hit_count} sensitive token(s)` : ''}`;
    }

    // Emit chunked text deltas
    const mid = Math.max(1, Math.floor(responseText.length / 2));
    const chunk1 = responseText.slice(0, mid);
    const chunk2 = responseText.slice(mid);
    events.push({ type: 'text_delta', turn_id: turnId, text: chunk1, delta: chunk1 });
    if (chunk2) {
      events.push({ type: 'text_delta', turn_id: turnId, text: chunk2, delta: chunk2 });
    }

    let deliveredMessageId: number | undefined;
    if (body.deliver_to_chat && body.chat_id) {
      const msgRes = createMessageAtomic(db, hub, {
        chatId: Number(body.chat_id),
        senderId: 777000,
        text: responseText,
      });
      deliveredMessageId = msgRes.message.id;
    }

    const inputTokens = Math.max(4, Math.ceil(safePrompt.length / 4));
    const outputTokens = Math.max(8, Math.ceil(responseText.length / 4));
    const doneEvent: HermesStreamEvent = {
      type: 'done',
      turn_id: turnId,
      session_id: session.session_id,
      response_text: responseText,
      model,
      provider: 'local_hermes',
      finish_reason: 'stop',
      delivered_message_id: deliveredMessageId,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        reasoning_tokens: 12,
        total_tokens: inputTokens + outputTokens + 12,
        estimated_cost_usd: 0,
      },
      tool_calls_count: toolCallsCount,
    };
    events.push(doneEvent);

    // Persist turn + updated session trajectory
    const now = Date.now();
    const updatedMessages: StoredHermesMessage[] = [
      ...session.messages,
      { id: `u_${turnId}`, role: 'user', content: safePrompt, created_at_ms: now },
      { id: `a_${turnId}`, role: 'assistant', content: responseText, reasoning: reasoningText, created_at_ms: now + 1 },
    ];
    db.prepare(`
      UPDATE hermes_sessions
      SET messages_json = ?, total_tokens = total_tokens + ?, updated_at_ms = ?
      WHERE session_id = ?
    `).run(JSON.stringify(updatedMessages), inputTokens + outputTokens + 12, now, session.session_id);

    const turnSummary = {
      turn_id: turnId,
      session_id: session.session_id,
      response_text: responseText,
      model,
      provider: 'local_hermes',
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

  router.get('/api/v1/hermes/turns/:turnId/events', (ctx) => {
    const auth = requireAuth(db, ctx);
    const row = db
      .prepare(`SELECT events_json FROM hermes_turns WHERE turn_id = ? AND user_id = ?`)
      .get(ctx.params.turnId!, auth.userId) as { events_json: string } | undefined;
    if (!row) throw new ApiError(404, 'turn_not_found', 'Hermes turn not found');

    const events = JSON.parse(row.events_json) as HermesStreamEvent[];
    const sse = beginSseStream(ctx.res);
    for (const ev of events) {
      sse.sendEvent(ev.type, ev);
    }
    sse.end();
  });

  // 3. Tab 1: Sessions (`sessions`, `branch`, `export` with PII redaction, `search`)
  router.get('/api/v1/hermes/sessions', (ctx) => {
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

  router.post('/api/v1/hermes/sessions', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{ title?: string; model?: string; chat_id?: number }>(ctx.req);
    const sid = `hses_${crypto.randomBytes(8).toString('hex')}`;
    const now = Date.now();
    const title = body.title?.trim() || 'New Studio Session';
    const model = body.model?.trim() || 'hermes-local-v1';

    db.prepare(`
      INSERT INTO hermes_sessions (
        session_id, user_id, chat_id, bot_id, title, source, model,
        messages_json, checkpoints_json, total_tokens, total_cost_usd, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, 777000, ?, 'studio', ?, '[]', '[]', 0, 0, ?, ?)
    `).run(sid, auth.userId, body.chat_id ?? 106, title, model, now, now);

    sendJson(ctx.res, 201, {
      session_id: sid,
      title,
      model,
      message_count: 0,
      total_tokens: 0,
      total_cost_usd: 0,
      created_at_ms: now,
      updated_at_ms: now,
    });
  });

  router.get('/api/v1/hermes/sessions/:sessionId', (ctx) => {
    const auth = requireAuth(db, ctx);
    const row = db
      .prepare(`SELECT * FROM hermes_sessions WHERE session_id = ? AND user_id = ?`)
      .get(ctx.params.sessionId!, auth.userId) as Record<string, unknown> | undefined;
    if (!row) throw new ApiError(404, 'session_not_found', 'Hermes session not found');
    sendJson(ctx.res, 200, {
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

  router.post('/api/v1/hermes/sessions/:sessionId/branch', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{ title?: string }>(ctx.req);
    const res = executeSlashCommandInternal(
      db,
      auth.userId,
      `/branch ${body.title ?? ''}`,
      ctx.params.sessionId!,
    );
    sendJson(ctx.res, 201, res);
  });

  router.get('/api/v1/hermes/sessions/:sessionId/export', (ctx) => {
    const auth = requireAuth(db, ctx);
    const row = db
      .prepare(`SELECT * FROM hermes_sessions WHERE session_id = ? AND user_id = ?`)
      .get(ctx.params.sessionId!, auth.userId) as Record<string, unknown> | undefined;
    if (!row) throw new ApiError(404, 'session_not_found', 'Hermes session not found');

    const magpieRow = db
      .prepare(`SELECT state_json FROM magpie_state WHERE user_id = ?`)
      .get(auth.userId) as { state_json: string } | undefined;
    const userMaskCfg = magpieRow ? JSON.parse(magpieRow.state_json).masking : undefined;
    const exportMaskCfg = {
      enabled: true,
      mask_secrets: true,
      mask_personal: true,
      custom_words: Array.isArray(userMaskCfg?.custom_words) ? userMaskCfg.custom_words : [],
      allow_list: Array.isArray(userMaskCfg?.allow_list) ? userMaskCfg.allow_list : [],
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

    sendJson(ctx.res, 200, {
      session_id: String(row.session_id),
      title: runPrivacyMasking(String(row.title ?? ''), exportMaskCfg).masked_text,
      model: String(row.model),
      messages: redactedMessages,
    });
  });

  router.delete('/api/v1/hermes/sessions/:sessionId', (ctx) => {
    const auth = requireAuth(db, ctx);
    db.prepare(`DELETE FROM hermes_sessions WHERE session_id = ? AND user_id = ?`).run(
      ctx.params.sessionId!,
      auth.userId,
    );
    sendJson(ctx.res, 200, { ok: true });
  });

  // 4. Tab 2: Bounded Memory (`MEMORY.md <= 2200`, `USER.md <= 1375`, `SOUL.md`, Honcho)
  router.get('/api/v1/hermes/memory', (ctx) => {
    const auth = requireAuth(db, ctx);
    sendJson(ctx.res, 200, getHermesMemoryState(db, auth.userId));
  });

  const handlePutMemory = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      target?: 'memory' | 'user' | 'soul';
      action?: 'add' | 'replace' | 'remove';
      content?: string;
      old_text?: string;
      memory_md?: string;
      user_md?: string;
      soul_md?: string;
    }>(ctx.req);

    const cur = getHermesMemoryState(db, auth.userId);

    if (body.memory_md !== undefined) {
      if (body.memory_md.length > 2200) {
        throw new ApiError(400, 'memory_limit_exceeded', 'MEMORY.md cannot exceed 2200 characters');
      }
      setHermesKv(db, auth.userId, 'memory_md', body.memory_md);
    }
    if (body.user_md !== undefined) {
      if (body.user_md.length > 1375) {
        throw new ApiError(400, 'user_limit_exceeded', 'USER.md cannot exceed 1375 characters');
      }
      setHermesKv(db, auth.userId, 'user_md', body.user_md);
    }
    if (body.soul_md !== undefined) {
      setHermesKv(db, auth.userId, 'soul_md', body.soul_md);
    }

    if (body.target && body.content !== undefined) {
      if (body.target === 'soul') {
        setHermesKv(db, auth.userId, 'soul_md', body.content);
      } else {
        const kvKey = body.target === 'memory' ? 'memory_md' : 'user_md';
        const limit = body.target === 'memory' ? 2200 : 1375;
        let entries = body.target === 'memory' ? [...cur.memory.entries] : [...cur.user.entries];

        if (body.action === 'remove') {
          entries = entries.filter((e) => !e.includes(body.content!));
        } else if (body.action === 'replace' && body.old_text) {
          entries = entries.map((e) => (e.includes(body.old_text!) ? body.content! : e));
        } else {
          entries.push(body.content.trim());
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
  router.put('/api/v1/hermes/memory', handlePutMemory);
  router.post('/api/v1/hermes/memory', handlePutMemory);

  const handleHonchoObserve = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{ observation?: string; note?: string }>(ctx.req);
    const cur = getHermesMemoryState(db, auth.userId);
    const text = (body.observation ?? body.note ?? '').trim();
    const obs = [...cur.honcho_observations, text].filter(Boolean);
    setHermesKv(db, auth.userId, 'honcho_obs', JSON.stringify(obs));
    sendJson(ctx.res, 200, { ok: true, honcho_observations: obs });
  };
  router.post('/api/v1/hermes/honcho/observe', handleHonchoObserve);
  router.post('/api/v1/hermes/honcho', handleHonchoObserve);

  router.get('/api/v1/hermes/honcho', (ctx) => {
    const auth = requireAuth(db, ctx);
    const cur = getHermesMemoryState(db, auth.userId);
    sendJson(ctx.res, 200, { ok: true, honcho_observations: cur.honcho_observations });
  });

  router.get('/api/v1/hermes/soul', (ctx) => {
    const auth = requireAuth(db, ctx);
    const cur = getHermesMemoryState(db, auth.userId);
    sendJson(ctx.res, 200, { ok: true, soul: cur.soul, soul_md: cur.soul });
  });

  router.put('/api/v1/hermes/soul', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{ soul_md?: string; content?: string }>(ctx.req);
    const nextSoul = body.soul_md ?? body.content ?? '';
    setHermesKv(db, auth.userId, 'soul_md', nextSoul);
    sendJson(ctx.res, 200, { ok: true, soul_md: nextSoul });
  });

  // 5. Tab 3: Skills Hub & Security Quarantine Scanner
  router.get('/api/v1/hermes/skills', (ctx) => {
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

  router.post('/api/v1/hermes/skills', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      name?: string;
      description?: string;
      body?: string;
      tags?: string[];
      toolsets?: string[];
      version?: string;
    }>(ctx.req);

    const name = (body.name ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    if (!name) throw new ApiError(400, 'invalid_skill_name', 'Skill name is required');
    const skillBody = body.body ?? '';

    const findings: string[] = [];
    if (SKILL_EXFIL_REGEX.test(skillBody)) {
      findings.push('Detected suspicious secret exfiltration or remote shell execution pattern');
    }
    if (DANGEROUS_COMMAND_REGEX.test(skillBody)) {
      findings.push('Detected destructive shell command in skill instructions');
    }

    const quarantined = findings.length > 0;
    const skill: HermesSkillDto = {
      name,
      description: body.description ?? '',
      body: skillBody,
      tags: body.tags ?? [],
      toolsets: body.toolsets ?? ['core'],
      version: body.version ?? '1.0.0',
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

  router.post('/api/v1/hermes/skills/:name/trust', (ctx) => {
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
  });

  router.delete('/api/v1/hermes/skills/:name', (ctx) => {
    const auth = requireAuth(db, ctx);
    db.prepare(`DELETE FROM hermes_skills WHERE user_id = ? AND name = ?`).run(
      auth.userId,
      ctx.params.name!,
    );
    sendJson(ctx.res, 200, { ok: true });
  });

  // 6. Tab 4: 29 Toolsets, Presets & Security Approvals
  router.get('/api/v1/hermes/toolsets', (ctx) => {
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
      enabled_ids?: string[];
      preset?: string;
      toggle_id?: string;
      approval_mode?: string;
    }>(ctx.req);

    let current = new Set(JSON.parse(getHermesKv(db, auth.userId, 'enabled_toolsets', '[]')) as string[]);

    if (body.preset) {
      if (body.preset === 'minimal') {
        current = new Set(['core', 'memory', 'clarify', 'todo']);
      } else if (body.preset === 'safe') {
        current = new Set(['core', 'web', 'file', 'memory', 'skills', 'planning', 'reasoning', 'session_search']);
      } else {
        current = new Set([...HERMES_TOOLSET_IDS]);
      }
    }
    if (body.enabled_ids) {
      current = new Set(body.enabled_ids.filter((id) => (HERMES_TOOLSET_IDS as readonly string[]).includes(id)));
    }
    if (body.toggle_id && (HERMES_TOOLSET_IDS as readonly string[]).includes(body.toggle_id)) {
      if (current.has(body.toggle_id)) current.delete(body.toggle_id);
      else current.add(body.toggle_id);
    }
    if (body.approval_mode) {
      setHermesKv(db, auth.userId, 'approval_mode', body.approval_mode);
    }

    const list = Array.from(current);
    setHermesKv(db, auth.userId, 'enabled_toolsets', JSON.stringify(list));
    sendJson(ctx.res, 200, {
      ok: true,
      enabled_ids: list,
      approval_mode: getHermesKv(db, auth.userId, 'approval_mode', 'ask'),
    });
  };
  router.put('/api/v1/hermes/toolsets', handleUpdateToolsets);
  router.post('/api/v1/hermes/toolsets', handleUpdateToolsets);

  router.post('/api/v1/hermes/approvals/:approvalId/resolve', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{ decision?: 'approved' | 'denied'; approved?: boolean }>(ctx.req);
    const row = db
      .prepare(`SELECT approval_json FROM hermes_approvals WHERE approval_id = ? AND user_id = ?`)
      .get(ctx.params.approvalId!, auth.userId) as { approval_json: string } | undefined;
    if (!row) throw new ApiError(404, 'approval_not_found', 'Approval request not found');

    const item = JSON.parse(row.approval_json) as HermesApprovalItem;
    item.status =
      body.decision ?? (body.approved === false ? 'denied' : 'approved');

    db.prepare(`UPDATE hermes_approvals SET approval_json = ? WHERE approval_id = ?`).run(
      JSON.stringify(item),
      item.approval_id,
    );
    sendJson(ctx.res, 200, item);
  });

  // 7. Tab 5: Cron Scheduler & Proactive Heartbeat
  router.get('/api/v1/hermes/cron', (ctx) => {
    const auth = requireAuth(db, ctx);
    const rows = db
      .prepare(`SELECT job_json FROM hermes_cron_jobs WHERE user_id = ? ORDER BY created_at_ms DESC`)
      .all(auth.userId) as Array<{ job_json: string }>;
    const heartbeat = JSON.parse(
      getHermesKv(
        db,
        auth.userId,
        'heartbeat',
        '{"enabled":true,"interval_secs":300,"active_chat_id":106,"tick_count":1}',
      ),
    );
    sendJson(ctx.res, 200, {
      jobs: rows.map((r) => JSON.parse(r.job_json) as HermesCronJobDto),
      heartbeat,
    });
  });

  router.post('/api/v1/hermes/cron', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      name?: string;
      schedule_expr?: string;
      prompt?: string;
      chat_id?: number;
      enabled?: boolean;
    }>(ctx.req);

    const scheduleExpr = (body.schedule_expr ?? '*/15 * * * *').trim();
    let nextRunMs: number;
    try {
      nextRunMs = computeNextCronRunMs(scheduleExpr, Date.now());
    } catch (err) {
      throw new ApiError(400, 'invalid_cron', err instanceof Error ? err.message : 'Invalid cron');
    }

    const jobId = `cron_${crypto.randomBytes(6).toString('hex')}`;
    const job: HermesCronJobDto = {
      job_id: jobId,
      name: body.name?.trim() || 'Scheduled Agent Job',
      schedule_expr: scheduleExpr,
      prompt: body.prompt?.trim() || 'Run periodic status check',
      chat_id: body.chat_id ?? 106,
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

    sendJson(ctx.res, 201, job);
  });

  const handleTriggerCronJob = (ctx: RequestContext): void => {
    const auth = requireAuth(db, ctx);
    const row = db
      .prepare(`SELECT job_json FROM hermes_cron_jobs WHERE job_id = ? AND user_id = ?`)
      .get(ctx.params.jobId!, auth.userId) as { job_json: string } | undefined;
    if (!row) throw new ApiError(404, 'cron_not_found', 'Cron job not found');

    const job = JSON.parse(row.job_json) as HermesCronJobDto;
    const now = Date.now();
    job.last_run_ms = now;
    job.run_count += 1;
    job.next_run_ms = computeNextCronRunMs(job.schedule_expr, now);

    db.prepare(`UPDATE hermes_cron_jobs SET job_json = ? WHERE job_id = ?`).run(
      JSON.stringify(job),
      job.job_id,
    );

    if (job.chat_id) {
      createMessageAtomic(db, hub, {
        chatId: job.chat_id,
        senderId: 777000,
        text: `⏰ **[Cron: ${job.name}]** Executed scheduled prompt: "${job.prompt}"`,
      });
    }
    sendJson(ctx.res, 200, job);
  };
  router.post('/api/v1/hermes/cron/:jobId/trigger', handleTriggerCronJob);
  router.post('/api/v1/hermes/cron/:jobId/run', handleTriggerCronJob);

  router.delete('/api/v1/hermes/cron/:jobId', (ctx) => {
    const auth = requireAuth(db, ctx);
    db.prepare(`DELETE FROM hermes_cron_jobs WHERE job_id = ? AND user_id = ?`).run(
      ctx.params.jobId!,
      auth.userId,
    );
    sendJson(ctx.res, 200, { ok: true });
  });

  // Proactive Heartbeat Configuration & Manual Pulse
  router.get('/api/v1/hermes/heartbeat', (ctx) => {
    const auth = requireAuth(db, ctx);
    const hb = JSON.parse(
      getHermesKv(
        db,
        auth.userId,
        'heartbeat',
        '{"enabled":true,"interval_secs":300,"active_chat_id":106,"tick_count":1}',
      ),
    );
    sendJson(ctx.res, 200, hb);
  });

  router.put('/api/v1/hermes/heartbeat', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const patch = await readJsonBody<Record<string, unknown>>(ctx.req);
    const cur = JSON.parse(
      getHermesKv(
        db,
        auth.userId,
        'heartbeat',
        '{"enabled":true,"interval_secs":300,"active_chat_id":106,"tick_count":1}',
      ),
    );
    const next = { ...cur, ...patch, updated_at_ms: Date.now() };
    setHermesKv(db, auth.userId, 'heartbeat', JSON.stringify(next));
    sendJson(ctx.res, 200, next);
  });

  router.post('/api/v1/hermes/heartbeat/tick', (ctx) => {
    const auth = requireAuth(db, ctx);
    const cur = JSON.parse(
      getHermesKv(
        db,
        auth.userId,
        'heartbeat',
        '{"enabled":true,"interval_secs":300,"active_chat_id":106,"tick_count":1}',
      ),
    ) as { enabled: boolean; interval_secs: number; active_chat_id?: number; tick_count: number; last_tick_ms?: number };
    cur.tick_count = Number(cur.tick_count ?? 0) + 1;
    cur.last_tick_ms = Date.now();
    setHermesKv(db, auth.userId, 'heartbeat', JSON.stringify(cur));
    sendJson(ctx.res, 200, cur);
  });

  // 8. Tab 6: Kanban Boards & Cards CRUD
  router.get('/api/v1/hermes/kanban', (ctx) => {
    const auth = requireAuth(db, ctx);
    const rows = db
      .prepare(`SELECT board_json FROM hermes_kanban_boards WHERE user_id = ? ORDER BY updated_at_ms DESC`)
      .all(auth.userId) as Array<{ board_json: string }>;
    const boards = rows.map((r) => JSON.parse(r.board_json) as HermesKanbanBoardDto);
    sendJson(ctx.res, 200, { boards, board: boards[0] ?? null });
  });

  router.post('/api/v1/hermes/kanban/cards', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      board_id?: string;
      column_id?: string;
      title?: string;
      description?: string;
      priority?: HermesKanbanCardDto['priority'];
      labels?: string[];
    }>(ctx.req);

    const boardId = body.board_id ?? 'board_main';
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

    const card: HermesKanbanCardDto = {
      card_id: `card_${crypto.randomBytes(6).toString('hex')}`,
      board_id: board.board_id,
      column_id: body.column_id ?? 'todo',
      title: (body.title ?? 'New Card').trim(),
      description: body.description ?? '',
      priority: body.priority ?? 'medium',
      labels: body.labels ?? [],
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

  router.patch('/api/v1/hermes/kanban/cards/:cardId', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const cardId = ctx.params.cardId!;
    const patch = await readJsonBody<Partial<HermesKanbanCardDto>>(ctx.req);

    const rows = db
      .prepare(`SELECT board_id, board_json FROM hermes_kanban_boards WHERE user_id = ?`)
      .all(auth.userId) as Array<{ board_id: string; board_json: string }>;

    for (const r of rows) {
      const board = JSON.parse(r.board_json) as HermesKanbanBoardDto;
      const idx = board.cards.findIndex((c) => c.card_id === cardId);
      if (idx !== -1) {
        board.cards[idx] = {
          ...board.cards[idx]!,
          ...patch,
          card_id: cardId,
          updated_at_ms: Date.now(),
        };
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

  router.delete('/api/v1/hermes/kanban/cards/:cardId', (ctx) => {
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
}
