/**
 * Third-Party Coding Agents as Native Bots (`gpui_telegram_coding`) Protocol Contracts
 * aligned with desktop `bhrumom/gpui-telegram` v1.6.11 (`coding_agent_contracts.rs`).
 *
 * Pure ES2023 + DOM isomorphic module (zero `node:*` imports or Node globals).
 */

export const CODING_PROVIDER_KINDS = [
  'claude_code',
  'codex',
  'open_code',
  'cursor_cli',
  'antigravity',
  'acp_custom',
] as const;

export type CodingProviderKind = (typeof CODING_PROVIDER_KINDS)[number];

export interface CodingProviderMeta {
  kind: CodingProviderKind;
  display_name: string;
  recommended_username: string;
  default_binary: string | null;
  supports_acp: boolean;
}

export const CODING_PROVIDER_META: Record<CodingProviderKind, CodingProviderMeta> = {
  claude_code: {
    kind: 'claude_code',
    display_name: 'Claude Code',
    recommended_username: 'claude_code_bot',
    default_binary: 'claude',
    supports_acp: false,
  },
  codex: {
    kind: 'codex',
    display_name: 'Codex',
    recommended_username: 'codex_bot',
    default_binary: 'codex',
    supports_acp: false,
  },
  open_code: {
    kind: 'open_code',
    display_name: 'OpenCode',
    recommended_username: 'opencode_bot',
    default_binary: 'opencode',
    supports_acp: true,
  },
  cursor_cli: {
    kind: 'cursor_cli',
    display_name: 'Cursor CLI',
    recommended_username: 'cursor_cli_bot',
    default_binary: 'cursor-agent',
    supports_acp: true,
  },
  antigravity: {
    kind: 'antigravity',
    display_name: 'Antigravity',
    recommended_username: 'antigravity_bot',
    default_binary: 'agy',
    supports_acp: false,
  },
  acp_custom: {
    kind: 'acp_custom',
    display_name: 'Custom ACP',
    recommended_username: 'acp_coding_bot',
    default_binary: null,
    supports_acp: true,
  },
};

export const CODING_PERMISSION_MODES = ['ask', 'auto_edit', 'full_access'] as const;
export type CodingPermissionMode = (typeof CODING_PERMISSION_MODES)[number];
export type CodingApprovalDecision = 'allow_once' | 'allow_session' | 'deny';

export const CODING_AGENT_OWNER_ONLY_MSG =
  '🔒 该编程智能体仅限所有者操作（可在 Bot 设置中开启群成员权限）。';

/** All 13 upstream native coding bot slash commands (`bots_miniapps.rs:2916-2971`) */
export interface CodingSlashCommandSpec {
  command: string;
  description: string;
}

export const CODING_SLASH_COMMANDS: readonly CodingSlashCommandSpec[] = [
  { command: 'start', description: '查看编程智能体状态与工作区' },
  { command: 'workspace', description: '绑定或切换本地项目目录' },
  { command: 'worktree', description: '开关或管理 Git Worktree 隔离' },
  { command: 'model', description: '查看或切换模型' },
  { command: 'mode', description: '切换权限模式 (ask/auto_edit/full_access)' },
  { command: 'diff', description: '查看本轮或指定回合的代码变更' },
  { command: 'rollback', description: '回滚到指定检查点' },
  { command: 'handoff', description: '交接当前上下文给其他 @Bot' },
  { command: 'stop', description: '停止当前正在执行的任务' },
  { command: 'new', description: '重置会话开启新对话' },
  { command: 'status', description: '查看当前运行与主机连接状态' },
  { command: 'login', description: '检查本地 CLI 登录授权状态' },
  { command: 'help', description: '查看所有编程智能体命令说明' },
] as const;

export interface CodingAgentBotConfig {
  provider_kind: CodingProviderKind;
  workspace_path: string;
  use_worktree: boolean;
  permission_mode: CodingPermissionMode;
  executable_override?: string | null;
  extra_args: string[];
  bound_device_id?: string | null;
  bound_node_id?: string | null;
  model_override?: string | null;
  allow_group_members: boolean;
}

export interface DetectedCodingProvider {
  kind: CodingProviderKind;
  display_name: string;
  binary_path: string | null;
  version: string | null;
  installed: boolean;
  recommended_username: string;
  supports_acp: boolean;
  login_hint: string;
}

export interface CodingDiffStat {
  files_changed: number;
  insertions: number;
  deletions: number;
  changed_files: string[];
}

export interface CodingTokenUsage {
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cost_usd: number | null;
}

/** `#[serde(tag = "action", rename_all = "snake_case")]` — 12 upstream control actions */
export type CodingControlAction =
  | { action: 'set_workspace'; path: string }
  | { action: 'worktree_op'; op: string; branch?: string | null }
  | { action: 'get_diff'; turn_idx?: number | null }
  | { action: 'rollback_checkpoint'; turn_idx?: number | null }
  | { action: 'list_models' }
  | { action: 'set_model'; model: string }
  | { action: 'set_permission_mode'; mode: CodingPermissionMode }
  | { action: 'commit_and_pr'; message?: string | null; title?: string | null }
  | { action: 'get_status' }
  | { action: 'check_login' }
  | { action: 'reset_session' }
  | { action: 'build_handoff_summary'; target_bot_username: string };

/** `#[serde(tag = "cmd", rename_all = "snake_case")]` — discriminator is `cmd` */
export type CodingHostCommand =
  | {
      cmd: 'probe_providers';
      req_id: string;
      owner_user_id: number;
      target_device_id?: string | null;
    }
  | {
      cmd: 'start_turn';
      turn_id: string;
      owner_user_id: number;
      target_device_id?: string | null;
      bot_user_id: number;
      chat_id: number;
      topic_id?: number | null;
      is_forum_topic?: boolean;
      prompt: string;
      config: CodingAgentBotConfig;
    }
  | {
      cmd: 'cancel_turn';
      turn_id: string;
      owner_user_id: number;
      target_device_id?: string | null;
    }
  | {
      cmd: 'resolve_approval';
      turn_id: string;
      request_id: string;
      owner_user_id: number;
      target_device_id?: string | null;
      decision: CodingApprovalDecision;
    }
  | {
      cmd: 'control';
      req_id: string;
      owner_user_id: number;
      target_device_id?: string | null;
      bot_user_id: number;
      chat_id: number;
      topic_id?: number | null;
      is_forum_topic?: boolean;
      config: CodingAgentBotConfig;
      action: CodingControlAction;
    };

/** `#[serde(tag = "event", rename_all = "snake_case")]` — discriminator is `event` */
export type CodingHostEvent =
  | {
      event: 'host_register';
      device_id: string;
      display_name: string;
      os_name: string;
      providers: DetectedCodingProvider[];
    }
  | {
      event: 'probe_result';
      req_id: string;
      device_id: string;
      providers: DetectedCodingProvider[];
    }
  | {
      event: 'turn_started';
      turn_id: string;
      provider_session_id?: string | null;
      workspace_path: string;
      worktree_path?: string | null;
      git_branch?: string | null;
      turn_idx: number;
    }
  | { event: 'turn_activity'; turn_id: string; state: string; detail?: string | null }
  | { event: 'turn_thinking_delta'; turn_id: string; delta: string }
  | { event: 'turn_text_delta'; turn_id: string; delta: string }
  | {
      event: 'turn_tool_step';
      turn_id: string;
      call_id: string;
      tool_name: string;
      title: string;
      status: string;
      output_preview?: string | null;
    }
  | {
      event: 'turn_approval_requested';
      turn_id: string;
      request_id: string;
      kind: string;
      title: string;
      detail: string;
      rule_key: string;
    }
  | {
      event: 'turn_completed';
      turn_id: string;
      ok: boolean;
      final_text: string;
      error?: string | null;
      turn_idx: number;
      checkpoint_ref?: string | null;
      diff_stat?: CodingDiffStat | null;
      token_usage?: CodingTokenUsage | null;
    }
  | {
      event: 'control_result';
      req_id: string;
      ok: boolean;
      markdown_reply: string;
      updated_workspace?: string | null;
      updated_use_worktree?: boolean | null;
      updated_model?: string | null;
      updated_permission_mode?: CodingPermissionMode | null;
      handoff_summary?: string | null;
    };

export interface CodingAgentsProbeRequest {
  device_id?: string;
  timeout_ms?: number;
}

export interface CodingAgentsProbeResponse {
  ok: boolean;
  device_id?: string;
  providers: DetectedCodingProvider[];
  error?: string;
}

/** Parses a coding provider kind from canonical names or CLI aliases (`coding_agent_contracts.rs:93-106`). */
export function parseCodingProviderKind(raw: string): CodingProviderKind | null {
  switch (raw.trim().toLowerCase()) {
    case 'claude_code':
    case 'claudecode':
    case 'claude-code':
    case 'claude':
      return 'claude_code';
    case 'codex':
    case 'openai_codex':
    case 'openai-codex':
      return 'codex';
    case 'open_code':
    case 'opencode':
    case 'open-code':
      return 'open_code';
    case 'cursor_cli':
    case 'cursorcli':
    case 'cursor-cli':
    case 'cursor':
    case 'cursor-agent':
    case 'cursor_agent':
      return 'cursor_cli';
    case 'antigravity':
    case 'agy':
      return 'antigravity';
    case 'acp_custom':
    case 'acpcustom':
    case 'acp-custom':
    case 'acp':
    case 'custom_acp':
      return 'acp_custom';
    default:
      return null;
  }
}

/** Parses a coding permission mode from canonical strings or aliases (`coding_agent_contracts.rs:148-157`). */
export function parseCodingPermissionMode(raw: string): CodingPermissionMode | null {
  switch (raw.trim().toLowerCase()) {
    case 'ask':
    case 'prompt':
      return 'ask';
    case 'auto_edit':
    case 'autoedit':
    case 'auto-edit':
      return 'auto_edit';
    case 'full_access':
    case 'fullaccess':
    case 'full-access':
    case 'full':
    case 'autonomous':
      return 'full_access';
    default:
      return null;
  }
}
