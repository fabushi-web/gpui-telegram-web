/**
 * Orca Bot OS, Multi-Bot Groups, Webhooks, E2EE Team Share, Agent IDE,
 * Unified RPC v3, 4-Tier Plugins, Browser Design Mode & Non-Themable SecuritySurface (`v1.7.0`).
 *
 * Aligned verbatim with desktop `bhrumom/gpui-telegram` (`orca_contracts.rs`, `orca_core`,
 * `orca_ide`, `bot-browser/src/design_mode.rs`, `views/orca/security_surface.rs`),
 * with dark-safe non-purple palette swatches & tab colors (`235°..315°` strictly avoided).
 */

// ============================================================================
// 1. Exact Error Code Catalogs (29 Bot + 17 IDE + 16 Tidy-Up)
// ============================================================================

export const ORCA_BOT_ERROR_CODES = [
  'bot_name_taken',
  'bot_not_found',
  'bot_folder_not_owned',
  'bot_avatar_changed',
  'bot_avatar_invalid',
  'invalid_argument',
  'bots_disabled',
  'bot_chat_not_found',
  'bot_paused',
  'bot_self',
  'bot_request_type',
  'bot_request_worker',
  'not_found',
  'item_closed',
  'not_owner',
  'items_read_only',
  'items_unavailable',
  'item_changed',
  'question_closed',
  'bot_package_newer_schema',
  'bot_package_duplicate_part',
  'bot_package_path_not_allowed',
  'secret_blocked',
  'lineage_parent_changed',
  'bot_offer_already_answered',
  'expired',
  'not_this_host',
  'full',
  'granted_not_added',
] as const;

export type BotErrorCode = (typeof ORCA_BOT_ERROR_CODES)[number];

export const ORCA_BOT_ERROR_HTTP_STATUS: Record<BotErrorCode, number> = {
  bot_name_taken: 409,
  bot_not_found: 404,
  bot_folder_not_owned: 403,
  bot_avatar_changed: 409,
  bot_avatar_invalid: 400,
  invalid_argument: 400,
  bots_disabled: 403,
  bot_chat_not_found: 404,
  bot_paused: 409,
  bot_self: 400,
  bot_request_type: 400,
  bot_request_worker: 403,
  not_found: 404,
  item_closed: 409,
  not_owner: 403,
  items_read_only: 409,
  items_unavailable: 503,
  item_changed: 409,
  question_closed: 409,
  bot_package_newer_schema: 422,
  bot_package_duplicate_part: 400,
  bot_package_path_not_allowed: 400,
  secret_blocked: 422,
  lineage_parent_changed: 409,
  bot_offer_already_answered: 409,
  expired: 410,
  not_this_host: 403,
  full: 409,
  granted_not_added: 409,
};

export const ORCA_IDE_ERROR_CODES = [
  'unknown_task',
  'unknown_dispatch',
  'stale_dispatch',
  'mailbox_is_local',
  'server_mail_unsupported',
  'tab_not_found',
  'system_shortcut_blocked',
  'approval_required',
  'plugin_system_disabled',
  'emulator_unsupported',
  'emulator_input_blocked',
  'wait_timeout',
  'yaml_duplicate_key',
  'yaml_size_exceeded',
  'yaml_alias_limit',
  'copy_budget_exceeded',
  'hibernation_blocked',
] as const;

export type OrcaIdeErrorCode = (typeof ORCA_IDE_ERROR_CODES)[number];

export const ORCA_IDE_ERROR_HTTP_STATUS: Record<OrcaIdeErrorCode, number> = {
  unknown_task: 404,
  unknown_dispatch: 404,
  stale_dispatch: 409,
  mailbox_is_local: 400,
  server_mail_unsupported: 400,
  tab_not_found: 404,
  system_shortcut_blocked: 403,
  approval_required: 403,
  plugin_system_disabled: 403,
  emulator_unsupported: 400,
  emulator_input_blocked: 403,
  wait_timeout: 408,
  yaml_duplicate_key: 400,
  yaml_size_exceeded: 413,
  yaml_alias_limit: 400,
  copy_budget_exceeded: 413,
  hibernation_blocked: 409,
};

export const ORCA_TIDY_UP_ERROR_CODES = [
  'not_list_lines',
  'bad_topic',
  'too_long',
  'too_many_removed',
  'too_many_added',
  'too_many_filed',
  'not_copied',
  'protected_line_modified',
  'protected_line_removed',
  'duplicate_fact',
  'empty_draft',
  'invalid_format',
  'changed',
  'timed_out',
  'unsupported_agent',
  'invalid_topic_content',
] as const;

export type TidyUpErrorCode = (typeof ORCA_TIDY_UP_ERROR_CODES)[number];

export const ORCA_TIDY_UP_ERROR_HTTP_STATUS: Record<TidyUpErrorCode, number> = {
  not_list_lines: 400,
  bad_topic: 400,
  too_long: 400,
  too_many_removed: 422,
  too_many_added: 422,
  too_many_filed: 422,
  not_copied: 400,
  protected_line_modified: 422,
  protected_line_removed: 422,
  duplicate_fact: 400,
  empty_draft: 400,
  invalid_format: 400,
  changed: 409,
  timed_out: 408,
  unsupported_agent: 400,
  invalid_topic_content: 400,
};

export interface OrcaErrorEnvelope {
  error: {
    code: BotErrorCode | OrcaIdeErrorCode | TidyUpErrorCode | string;
    message: string;
    details?: Record<string, unknown>;
  };
}

// ============================================================================
// 2. 22 Bot Agents, 20 Mascots × 9 Outfits & Dark-Safe Avatar Colors
// ============================================================================

export const BOT_AGENTS = [
  'claude',
  'codex',
  'grok',
  'opencode',
  'omp',
  'pi',
  'antigravity',
  'cursor',
  'hermes',
  'copilot',
  'opencode2',
  'kimi',
  'kiro',
  'aug',
  'goose',
  'kilo',
  'mimo-code',
  'droid',
  'qwen-code',
  'cline',
  'devin',
  'codebuddy',
] as const;

export type BotAgentId = (typeof BOT_AGENTS)[number];

export const BOT_LEGACY_READABLE_AGENTS = [
  'claude',
  'codex',
  'grok',
  'opencode',
  'omp',
  'pi',
  'antigravity',
] as const;

export const BOT_LOOK_AROUND_SUPPORTED_AGENTS = ['claude', 'codex'] as const;

export const BOT_RETIRED_AGENT_MIGRATIONS: Record<string, BotAgentId> = {
  gemini: 'antigravity',
};

export interface BotAgentMetadataDto {
  id: BotAgentId;
  display_name: string;
  supports_look_around: boolean;
  supports_tidy_up: boolean;
  legacy_readable: boolean;
}

export const BOT_AGENT_METADATA: Record<BotAgentId, BotAgentMetadataDto> = {
  claude: { id: 'claude', display_name: 'Claude Code', supports_look_around: true, supports_tidy_up: true, legacy_readable: true },
  codex: { id: 'codex', display_name: 'Codex', supports_look_around: true, supports_tidy_up: true, legacy_readable: true },
  grok: { id: 'grok', display_name: 'Grok', supports_look_around: false, supports_tidy_up: false, legacy_readable: true },
  opencode: { id: 'opencode', display_name: 'OpenCode', supports_look_around: false, supports_tidy_up: false, legacy_readable: true },
  omp: { id: 'omp', display_name: 'OMP', supports_look_around: false, supports_tidy_up: false, legacy_readable: true },
  pi: { id: 'pi', display_name: 'Pi', supports_look_around: false, supports_tidy_up: false, legacy_readable: true },
  antigravity: { id: 'antigravity', display_name: 'Antigravity', supports_look_around: false, supports_tidy_up: false, legacy_readable: true },
  cursor: { id: 'cursor', display_name: 'Cursor', supports_look_around: false, supports_tidy_up: false, legacy_readable: false },
  hermes: { id: 'hermes', display_name: 'Hermes', supports_look_around: false, supports_tidy_up: false, legacy_readable: false },
  copilot: { id: 'copilot', display_name: 'GitHub Copilot', supports_look_around: false, supports_tidy_up: false, legacy_readable: false },
  opencode2: { id: 'opencode2', display_name: 'OpenCode 2', supports_look_around: false, supports_tidy_up: false, legacy_readable: false },
  kimi: { id: 'kimi', display_name: 'Kimi Code', supports_look_around: false, supports_tidy_up: false, legacy_readable: false },
  kiro: { id: 'kiro', display_name: 'Kiro', supports_look_around: false, supports_tidy_up: false, legacy_readable: false },
  aug: { id: 'aug', display_name: 'Augment', supports_look_around: false, supports_tidy_up: false, legacy_readable: false },
  goose: { id: 'goose', display_name: 'Goose', supports_look_around: false, supports_tidy_up: false, legacy_readable: false },
  kilo: { id: 'kilo', display_name: 'Kilo Code', supports_look_around: false, supports_tidy_up: false, legacy_readable: false },
  'mimo-code': { id: 'mimo-code', display_name: 'MiMo Code', supports_look_around: false, supports_tidy_up: false, legacy_readable: false },
  droid: { id: 'droid', display_name: 'Factory Droid', supports_look_around: false, supports_tidy_up: false, legacy_readable: false },
  'qwen-code': { id: 'qwen-code', display_name: 'Qwen Code', supports_look_around: false, supports_tidy_up: false, legacy_readable: false },
  cline: { id: 'cline', display_name: 'Cline', supports_look_around: false, supports_tidy_up: false, legacy_readable: false },
  devin: { id: 'devin', display_name: 'Devin', supports_look_around: false, supports_tidy_up: false, legacy_readable: false },
  codebuddy: { id: 'codebuddy', display_name: 'CodeBuddy', supports_look_around: false, supports_tidy_up: false, legacy_readable: false },
};

export const BOT_MASCOT_IDS = [
  'A1',
  'B1',
  'D1',
  'E1',
  'F1',
  'G1',
  'H1',
  'H2',
  'I1',
  'J1',
  'K2',
  'L2',
  'M1',
  'N1',
  'O1',
  'P3',
  'Q1',
  'R3',
  'S2',
  'T1',
] as const;

export type BotMascotId = (typeof BOT_MASCOT_IDS)[number];

/** 19 pickable mascots (`S2` is retired from picker but valid on disk). */
export const BOT_PICKABLE_MASCOT_IDS = BOT_MASCOT_IDS.filter(
  (id): id is Exclude<BotMascotId, 'S2'> => id !== 'S2',
);

export const BOT_AVATAR_OUTFITS = [
  'tie',
  'detective',
  'hard-hat',
  'reviewer',
  'night-shift',
  'artist',
  'scientist',
  'party',
  'security',
] as const;

export type BotAvatarOutfit = (typeof BOT_AVATAR_OUTFITS)[number];

/**
 * 11 dark-safe avatar color swatches (replacing desktop `#c9b8e8` purple with `#9ec5fe` sky-blue
 * so ZERO swatches fall inside the forbidden `235°..315°` purple hue band).
 */
export const ORCA_BOT_AVATAR_COLORS = [
  '#b3dbf4',
  '#ffffff',
  '#9ec5fe',
  '#f4c4cf',
  '#f8cfa8',
  '#f6e3a1',
  '#c5dfb5',
  '#b5e3d8',
  '#8fa3b8',
  '#3a3f4b',
  '#1f2126',
] as const;

export const ORCA_DEFAULT_AVATAR_COLOR = '#b3dbf4' as const;

export const BOT_PERMISSION_MODES = ['ask', 'accept-edits', 'auto', 'full-access'] as const;
export type BotPermissionMode = (typeof BOT_PERMISSION_MODES)[number];

export type BotItemsStale = 3 | 5 | 7 | 14 | 'never';

export const LOCAL_EXECUTION_HOST_ID = 'local' as const;
export const BOT_QUIET_MARKER = 'NO_REPLY' as const;
export const BOT_NAME_MAX_LENGTH = 64 as const;
export const UNNAMED_BOT_NAME = 'New bot' as const;
export const BOT_MAX_MEMBERS = 200 as const;
export const BOT_MAX_CONNECTOR_WORKSPACES = 8 as const;
export const BOT_MAX_SKILL_PROJECTS = 20 as const;
export const BOT_HANDED_PAIRED_WORKSPACES_MAX = 50 as const;

// ============================================================================
// 3. Bot Home Files, Memory Governance, Items, Look-Around & Multi-Bot Groups
// ============================================================================

export const BOT_MEMORY_INDEX_LINE_CAP = 200 as const;
export const BOT_MEMORY_SOURCE_SEPARATOR = ' \u00b7 from: ' as const;
export const BOT_MEMORY_HISTORY_DAYS = 90 as const;
export const BOT_MEMORY_ARCHIVE_TOPIC = 'archive' as const;
export const BOT_MEMORY_PROTECTED_PREFIXES = ['Rule:', 'Prefers:', 'Decided:'] as const;

export const READD_GUARD_DAYS = 14 as const;
export const READD_GUARD_MS = 1_209_600_000 as const;
export const READD_WORD_SIMILARITY_THRESHOLD = 0.8 as const;
export const READD_OWNER_COVERAGE_THRESHOLD = 0.5 as const;

export const TIDY_UP_TARGET_FACTS = 60 as const;
export const TIDY_UP_MAX_NEW_FACTS = 6 as const;
export const TIDY_UP_MAX_FILED = 20 as const;
export const TIDY_UP_HOURS_FROM = 3 as const;
export const TIDY_UP_HOURS_UNTIL = 8 as const;
export const TIDY_UP_RUN_LIMIT_MS = 600_000 as const;
export const TIDY_UP_MAX_PROSE_LINES = 5 as const;
export const TIDY_UP_TOPIC_MAX_LEN = 40 as const;

export const BOT_MEMORY_KINDS = ['rule', 'prefers', 'decided', 'lesson', 'fact'] as const;
export type BotMemoryKind = (typeof BOT_MEMORY_KINDS)[number];

export interface BotHomeFilesDto {
  soul_md: string;
  memory_md: string;
  agents_md: string;
  claude_md: string;
  bot_json: string;
  topics?: Record<string, string>;
}

export interface BotMemoryEntryDto {
  entry_id: string;
  bot_id: string;
  kind: BotMemoryKind;
  text: string;
  topic?: string;
  source?: string;
  protected_owner: boolean;
  created_at_ms: number;
  forgotten_at_ms?: number;
}

export interface OrcaBotDto {
  bot_id: string;
  owner_user_id: number;
  name: string;
  agent: BotAgentId;
  model?: string;
  mascot_id: BotMascotId;
  avatar_outfit: BotAvatarOutfit;
  avatar_color: string;
  avatar_file_id?: string;
  avatar_revision: number;
  avatar_revision_epoch: string;
  permission_mode: BotPermissionMode;
  paused: boolean;
  look_around_enabled: boolean;
  look_around_every?: LookAroundEvery;
  look_around_focus?: string;
  items_stale?: BotItemsStale;
  template_id?: string;
  execution_host_id: string;
  telegram_chat_id?: number;
  created_at_ms: number;
  updated_at_ms: number;
}

export const BOT_ITEM_STATUSES = [
  'planned',
  'working',
  'waiting',
  'needs_you',
  'done',
  'canceled',
] as const;
export type BotItemStatus = (typeof BOT_ITEM_STATUSES)[number];

export const BOT_ITEM_LINK_KINDS = ['dispatch', 'pr', 'url', 'file', 'automation'] as const;
export type BotItemLinkKind = (typeof BOT_ITEM_LINK_KINDS)[number];

export interface BotItemLinkDto {
  kind: BotItemLinkKind;
  label: string;
  ref: string;
}

export interface BotItemAskOptionDto {
  id: string;
  label: string;
  detail?: string;
}

export interface BotItemAskQuestionDto {
  question_id: string;
  prompt: string;
  options: BotItemAskOptionDto[];
  selected_option_id?: string;
  freeform_answer?: string;
}

export interface BotItemAskCardDto {
  ask_id: string;
  item_num: number;
  bot_id: string;
  context?: string;
  questions: BotItemAskQuestionDto[];
  closed: boolean;
  created_at_ms: number;
  answered_at_ms?: number;
}

export interface BotItemDto {
  item_num: number;
  bot_id: string;
  title: string;
  description: string;
  done_means?: string;
  status: BotItemStatus;
  waiting_reason?: string;
  links: BotItemLinkDto[];
  ask_card?: BotItemAskCardDto | null;
  revision: number;
  snoozed_until_ms?: number;
  created_at_ms: number;
  updated_at_ms: number;
}

export const NEEDS_YOU_FOLD_CAP = 5 as const;
export type NeedsYouKind = 'approval' | 'question' | 'other';

export interface NeedsYouItemDto {
  id: string;
  kind: NeedsYouKind;
  bot_id: string;
  bot_name: string;
  item_num?: number;
  title: string;
  summary: string;
  priority: number;
  created_at_ms: number;
}

export const LOOK_AROUND_EVERY_VALUES = [
  'every-4h',
  'every-2h',
  'twice-daily',
  'mornings',
] as const;
export type LookAroundEvery = (typeof LOOK_AROUND_EVERY_VALUES)[number];

export const UP_NEXT_STATES = ['idle', 'running', 'ready', 'failed'] as const;
export type UpNextState = (typeof UP_NEXT_STATES)[number];

export const UP_NEXT_SUGGESTION_MAX_PER_RUN = 5 as const;

export interface UpNextSuggestionDto {
  suggestion_id: string;
  bot_id: string;
  title: string;
  why: string;
  ask: string;
  dismissed: boolean;
  promoted_item_num?: number;
  created_at_ms: number;
}

export type BotGroupReplyMode =
  | { kind: 'bot'; botId: string }
  | { kind: 'all' }
  | { kind: 'mentions' };

export const BOT_REQUEST_TYPES = ['status', 'question', 'handoff'] as const;
export type BotRequestType = (typeof BOT_REQUEST_TYPES)[number];

export const BOT_REQUEST_POLICY_PRECEDENCE = [
  'bots_disabled',
  'bot_not_found',
  'bot_chat_not_found',
  'bot_self',
  'bot_paused',
  'bot_request_type',
  'bot_request_worker',
] as const;

export interface BotGroupDto {
  group_id: string;
  name: string;
  owner_user_id: number;
  member_bot_ids: string[];
  reply_mode: BotGroupReplyMode;
  default_thread_id?: string;
  created_at_ms: number;
  updated_at_ms: number;
}

// ============================================================================
// 4. 24 Bot Templates, 13 Bundled Skills, BotPackage v1 & 5-Class Secret Scanner
// ============================================================================

export const BOT_TEMPLATE_CATEGORIES = [
  'coding',
  'releases',
  'support',
  'planning',
  'ops',
  'personal',
] as const;
export type BotTemplateCategory = (typeof BOT_TEMPLATE_CATEGORIES)[number];

export interface OrcaBotTemplateDto {
  id: string;
  category: BotTemplateCategory;
  name: string;
  summary: string;
  default_agent: BotAgentId;
  default_mascot: BotMascotId;
  default_outfit: BotAvatarOutfit;
  bundled_skills: string[];
  look_around_enabled: false;
}

export const ORCA_BOT_TEMPLATES: ReadonlyArray<OrcaBotTemplateDto> = [
  // Coding (6)
  { id: 'pr-review', category: 'coding', name: 'PR Review', summary: 'Review pull requests for correctness, tests, and regressions.', default_agent: 'claude', default_mascot: 'A1', default_outfit: 'reviewer', bundled_skills: ['pr-review-checklist'], look_around_enabled: false },
  { id: 'bug-investigation', category: 'coding', name: 'Bug Investigation', summary: 'Reproduce failures, isolate root causes, and draft fixes.', default_agent: 'claude', default_mascot: 'B1', default_outfit: 'detective', bundled_skills: ['bug-reproduction'], look_around_enabled: false },
  { id: 'dependency-updates', category: 'coding', name: 'Dependency Updates', summary: 'Track upgrades, changelogs, and breaking dependency changes.', default_agent: 'codex', default_mascot: 'D1', default_outfit: 'hard-hat', bundled_skills: ['dependency-upgrade'], look_around_enabled: false },
  { id: 'unreviewed-work', category: 'coding', name: 'Unreviewed Work', summary: 'Surface stale diffs and PRs waiting on engineering review.', default_agent: 'claude', default_mascot: 'E1', default_outfit: 'reviewer', bundled_skills: ['pr-review-checklist'], look_around_enabled: false },
  { id: 'workspace-cleanup', category: 'coding', name: 'Workspace Cleanup', summary: 'Prune stale worktrees, dead branches, and temporary artifacts.', default_agent: 'codex', default_mascot: 'F1', default_outfit: 'hard-hat', bundled_skills: ['workspace-hygiene'], look_around_enabled: false },
  { id: 'security-check', category: 'coding', name: 'Security Check', summary: 'Audit secrets, permissions, and OWASP hazards before ship.', default_agent: 'claude', default_mascot: 'G1', default_outfit: 'security', bundled_skills: ['security-checklist'], look_around_enabled: false },
  // Releases (4)
  { id: 'release', category: 'releases', name: 'Release Captain', summary: 'Coordinate release gates, build checks, and version tagging.', default_agent: 'claude', default_mascot: 'H1', default_outfit: 'tie', bundled_skills: ['release-readiness'], look_around_enabled: false },
  { id: 'release-notes', category: 'releases', name: 'Release Notes', summary: 'Draft user-facing release notes from merged PRs and commits.', default_agent: 'claude', default_mascot: 'H2', default_outfit: 'artist', bundled_skills: ['release-notes-style'], look_around_enabled: false },
  { id: 'ci-failures', category: 'releases', name: 'CI Failures', summary: 'Triage failing CI workflows and distinguish flakes from real bugs.', default_agent: 'codex', default_mascot: 'I1', default_outfit: 'detective', bundled_skills: ['ci-failure-triage'], look_around_enabled: false },
  { id: 'deploy-watch', category: 'releases', name: 'Deploy Watch', summary: 'Monitor rollouts, health checks, and rollback triggers.', default_agent: 'claude', default_mascot: 'J1', default_outfit: 'night-shift', bundled_skills: ['release-readiness'], look_around_enabled: false },
  // Support (4)
  { id: 'support', category: 'support', name: 'Support Desk', summary: 'Draft accurate support responses grounded in docs and code.', default_agent: 'claude', default_mascot: 'K2', default_outfit: 'tie', bundled_skills: ['issue-triage'], look_around_enabled: false },
  { id: 'feedback', category: 'support', name: 'Feedback Synthesizer', summary: 'Cluster customer feedback into actionable product themes.', default_agent: 'claude', default_mascot: 'L2', default_outfit: 'scientist', bundled_skills: ['feedback-themes'], look_around_enabled: false },
  { id: 'bug-intake', category: 'support', name: 'Bug Intake', summary: 'Validate incoming bug reports and request missing repro details.', default_agent: 'codex', default_mascot: 'M1', default_outfit: 'detective', bundled_skills: ['bug-reproduction'], look_around_enabled: false },
  { id: 'issue-triage', category: 'support', name: 'Issue Triage', summary: 'Label, deduplicate, and route incoming issues to owners.', default_agent: 'claude', default_mascot: 'N1', default_outfit: 'reviewer', bundled_skills: ['issue-triage'], look_around_enabled: false },
  // Planning (4)
  { id: 'briefing', category: 'planning', name: 'Status Briefing', summary: 'Compile concise status briefs across active projects.', default_agent: 'claude', default_mascot: 'O1', default_outfit: 'tie', bundled_skills: ['status-brief'], look_around_enabled: false },
  { id: 'docs-upkeep', category: 'planning', name: 'Docs Upkeep', summary: 'Keep READMEs, runbooks, and architecture specs synced with code.', default_agent: 'codex', default_mascot: 'P3', default_outfit: 'artist', bundled_skills: ['spec-format'], look_around_enabled: false },
  { id: 'spec-drafts', category: 'planning', name: 'Spec Drafter', summary: 'Turn ideas and notes into structured RFCs and engineering specs.', default_agent: 'claude', default_mascot: 'Q1', default_outfit: 'scientist', bundled_skills: ['spec-format'], look_around_enabled: false },
  { id: 'backlog-cleanup', category: 'planning', name: 'Backlog Cleanup', summary: 'Spot duplicate, stale, or underspecified backlog items.', default_agent: 'claude', default_mascot: 'R3', default_outfit: 'reviewer', bundled_skills: ['issue-triage'], look_around_enabled: false },
  // Ops (2)
  { id: 'incident-notes', category: 'ops', name: 'Incident Notes', summary: 'Maintain crisp incident timelines and postmortem drafts.', default_agent: 'claude', default_mascot: 'T1', default_outfit: 'night-shift', bundled_skills: ['incident-timeline'], look_around_enabled: false },
  { id: 'oncall-handoff', category: 'ops', name: 'On-Call Handoff', summary: 'Summarize active alerts, mitigations, and follow-ups for shift handoff.', default_agent: 'claude', default_mascot: 'A1', default_outfit: 'security', bundled_skills: ['incident-timeline', 'status-brief'], look_around_enabled: false },
  // Personal (4)
  { id: 'followup', category: 'personal', name: 'Follow-Up Tracker', summary: 'Track open commitments and gentle reminders.', default_agent: 'claude', default_mascot: 'B1', default_outfit: 'tie', bundled_skills: ['status-brief'], look_around_enabled: false },
  { id: 'standup', category: 'personal', name: 'Standup Helper', summary: 'Assemble yesterday, today, and blocker notes from real work.', default_agent: 'claude', default_mascot: 'D1', default_outfit: 'party', bundled_skills: ['status-brief'], look_around_enabled: false },
  { id: 'email-digest', category: 'personal', name: 'Email Digest', summary: 'Distill high-signal messages and action items.', default_agent: 'claude', default_mascot: 'E1', default_outfit: 'tie', bundled_skills: ['status-brief'], look_around_enabled: false },
  { id: 'meeting-prep', category: 'personal', name: 'Meeting Prep', summary: 'Prepare agendas, context briefs, and open questions before meetings.', default_agent: 'claude', default_mascot: 'F1', default_outfit: 'scientist', bundled_skills: ['status-brief'], look_around_enabled: false },
];

export const ORCA_BUNDLED_SKILLS = [
  'pr-review-checklist',
  'bug-reproduction',
  'ci-failure-triage',
  'release-readiness',
  'release-notes-style',
  'dependency-upgrade',
  'security-checklist',
  'issue-triage',
  'feedback-themes',
  'status-brief',
  'spec-format',
  'incident-timeline',
  'workspace-hygiene',
] as const;

export type OrcaBundledSkillId = (typeof ORCA_BUNDLED_SKILLS)[number];

export interface OrcaSkillDto {
  slug: string;
  title: string;
  content_markdown: string;
  bundled: boolean;
}

export const BOT_PACKAGE_SCHEMA_VERSION = 1 as const;
export const BOT_PACKAGE_MANIFEST_PATH = 'dev.orca.bot-sharing/bot.json' as const;
export const BOT_PACKAGE_MAX_TOTAL_BYTES = 16_777_216 as const;
export const BOT_PACKAGE_MAX_FILES = 192 as const;
export const BOT_PACKAGE_MAX_FILE_BYTES = 2_097_152 as const;
export const BOT_PACKAGE_MAX_SKILLS = 64 as const;
export const BOT_PACKAGE_MAX_MEMORY_TOPICS = 64 as const;

export interface BotPackageFileEntryDto {
  path: string;
  content_utf8?: string;
  content_b64?: string;
  byte_size: number;
}

export interface BotPackageV1Dto {
  schema_version: 1;
  manifest_path: typeof BOT_PACKAGE_MANIFEST_PATH;
  bot_name: string;
  agent: BotAgentId;
  mascot_id: BotMascotId;
  avatar_outfit: BotAvatarOutfit;
  avatar_color: string;
  files: BotPackageFileEntryDto[];
  exported_at_ms: number;
}

export const ORCA_SECRET_SCAN_CLASSES = [
  'api_key_or_token',
  'private_key_or_pem',
  'password_or_secret_assignment',
  'personal_identifier',
  'sensitive_url_or_path',
] as const;

export type OrcaSecretScanClass = (typeof ORCA_SECRET_SCAN_CLASSES)[number];

export const ORCA_RISK_KINDS = [
  'secret',
  'pipe-to-shell',
  'sudo',
  'sends-file',
  'hidden-unicode',
] as const;

export type OrcaRiskKind = (typeof ORCA_RISK_KINDS)[number];

export interface OrcaSecretScanFinding {
  scan_class: OrcaSecretScanClass;
  blocking: boolean;
  error_code?: 'secret_blocked';
  line: number;
  matched_label: string;
  redacted_placeholder: string;
}

export interface OrcaSecretScanResult {
  clean: boolean;
  blocked: boolean;
  error_code?: 'secret_blocked';
  findings: OrcaSecretScanFinding[];
}

const API_KEY_PATTERNS: ReadonlyArray<{ label: string; regex: RegExp }> = [
  { label: 'aws_access_key', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { label: 'sendgrid_key', regex: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g },
  { label: 'jwt_token', regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { label: 'bearer_token', regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi },
  {
    label: 'vendor_api_token',
    regex:
      /\b(?:sk-ant-[A-Za-z0-9_-]{16,}|sk-proj-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AIza[0-9A-Za-z_-]{30,}|lin_api_[A-Za-z0-9]{20,}|whsec_[A-Za-z0-9+/=_-]{16,}|orcawh_[A-Za-z0-9_-]{16,})\b/g,
  },
];

const PRIVATE_KEY_PEM_RE = /-----BEGIN\s+[A-Z0-9 ]*PRIVATE KEY-----/g;

const PASSWORD_ASSIGNMENT_RE =
  /\b(?:password|passwd|pwd|secret|api_key|apikey|api_secret|access_token|refresh_token|auth_token|private_key|client_secret|signing_secret|webhook_secret|bot_token|db_password|database_password|token_secret|master_key|encryption_key|session_secret|[a-z0-9_]*(?:_password|_secret|_token|_api_key|_private_key|_access_key))\s*[:=]\s*["']?([^\s"'`#;,]{6,})["']?/gi;

const CREDENTIAL_URL_RE = /\b(?:https?|wss?|postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?|amqp|ftp):\/\/[^/\s:@]+:[^/\s@]+@[^\s]+/gi;
const SENSITIVE_PATH_RE =
  /(?:~\/\.ssh\/|~\/\.aws\/|\/etc\/shadow\b|(?:^|[\s"'(\[`\\/=:])\.env(?:\.[A-Za-z0-9_-]+)?\b|(?:^|[\s"'(\[`\\/=:])[A-Za-z0-9._-]*\.(?:pem|key)\b)/gi;

const EMAIL_PII_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const US_SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const CREDIT_CARD_CANDIDATE_RE = /(?<![A-Za-z0-9._-])[2-6](?:[ -]?\d){12,18}(?![A-Za-z0-9._-])/g;
const PHONE_PII_RE =
  /(?<![A-Za-z0-9_])(?:\+[1-9]\d{0,2}[\s.-]?(?:\(\d{2,4}\)[\s.-]?)?\d{2,4}(?:[\s.-]?\d{2,4}){1,3}|\(\d{3}\)[\s.-]?\d{3}[\s.-]\d{4}|(?:1[\s-])?[2-9]\d{2}[\s-]\d{3}[\s-]\d{4}|1[3-9]\d[\s-]\d{4}[\s-]\d{4})(?![A-Za-z0-9_])/g;

function passesLuhnCheck(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19 || !/^\d+$/.test(digits)) {
    return false;
  }
  if (/^(\d)\1+$/.test(digits)) {
    return false;
  }
  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (shouldDouble) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

/**
 * Scans Orca bot text (`SOUL.md`, `MEMORY.md`, skills, package files) across all 5 secret classes.
 * Blocking classes (`api_key_or_token`, `private_key_or_pem`, `password_or_secret_assignment`,
 * and credentialed URLs under `sensitive_url_or_path`) set `blocked: true` and `error_code: 'secret_blocked'`.
 */
export function scanOrcaBotTextForSecrets(text: string): OrcaSecretScanResult {
  const findings: OrcaSecretScanFinding[] = [];
  if (!text) {
    return { clean: true, blocked: false, findings };
  }

  const lines = text.split(/\r?\n/);
  lines.forEach((lineText, idx) => {
    const lineNum = idx + 1;

    for (const pat of API_KEY_PATTERNS) {
      pat.regex.lastIndex = 0;
      if (pat.regex.test(lineText)) {
        findings.push({
          scan_class: 'api_key_or_token',
          blocking: true,
          error_code: 'secret_blocked',
          line: lineNum,
          matched_label: pat.label,
          redacted_placeholder: '[REDACTED:api_key_or_token]',
        });
      }
    }

    PRIVATE_KEY_PEM_RE.lastIndex = 0;
    if (PRIVATE_KEY_PEM_RE.test(lineText)) {
      findings.push({
        scan_class: 'private_key_or_pem',
        blocking: true,
        error_code: 'secret_blocked',
        line: lineNum,
        matched_label: 'private_key_pem',
        redacted_placeholder: '[REDACTED:private_key_or_pem]',
      });
    }

    PASSWORD_ASSIGNMENT_RE.lastIndex = 0;
    let pwdMatch: RegExpExecArray | null;
    while ((pwdMatch = PASSWORD_ASSIGNMENT_RE.exec(lineText)) !== null) {
      if (pwdMatch[1] && !pwdMatch[1].startsWith('[REDACTED:')) {
        findings.push({
          scan_class: 'password_or_secret_assignment',
          blocking: true,
          error_code: 'secret_blocked',
          line: lineNum,
          matched_label: 'secret_assignment',
          redacted_placeholder: '[REDACTED:password_or_secret_assignment]',
        });
      }
    }

    CREDENTIAL_URL_RE.lastIndex = 0;
    const hasCredentialUrl = CREDENTIAL_URL_RE.test(lineText);
    if (hasCredentialUrl) {
      findings.push({
        scan_class: 'sensitive_url_or_path',
        blocking: true,
        error_code: 'secret_blocked',
        line: lineNum,
        matched_label: 'credential_url',
        redacted_placeholder: '[REDACTED:sensitive_url_or_path]',
      });
    } else {
      SENSITIVE_PATH_RE.lastIndex = 0;
      if (SENSITIVE_PATH_RE.test(lineText)) {
        findings.push({
          scan_class: 'sensitive_url_or_path',
          blocking: false,
          line: lineNum,
          matched_label: 'sensitive_path',
          redacted_placeholder: '[REDACTED:sensitive_url_or_path]',
        });
      }
    }

    // Class 4: Personal Identifiers (non-blocking warnings: US SSN, Luhn credit card, structured phone, email)
    US_SSN_RE.lastIndex = 0;
    if (US_SSN_RE.test(lineText)) {
      findings.push({
        scan_class: 'personal_identifier',
        blocking: false,
        line: lineNum,
        matched_label: 'us_ssn',
        redacted_placeholder: '[REDACTED:personal_identifier]',
      });
    }

    const creditCardSpans: Array<[number, number]> = [];
    CREDIT_CARD_CANDIDATE_RE.lastIndex = 0;
    let ccMatch: RegExpExecArray | null;
    let detectedCc = false;
    while ((ccMatch = CREDIT_CARD_CANDIDATE_RE.exec(lineText)) !== null) {
      const digits = ccMatch[0].replace(/\D/g, '');
      if (passesLuhnCheck(digits)) {
        creditCardSpans.push([ccMatch.index, ccMatch.index + ccMatch[0].length]);
        if (!detectedCc) {
          detectedCc = true;
          findings.push({
            scan_class: 'personal_identifier',
            blocking: false,
            line: lineNum,
            matched_label: 'credit_card',
            redacted_placeholder: '[REDACTED:personal_identifier]',
          });
        }
      }
    }

    PHONE_PII_RE.lastIndex = 0;
    let phoneMatch: RegExpExecArray | null;
    while ((phoneMatch = PHONE_PII_RE.exec(lineText)) !== null) {
      const matchStart = phoneMatch.index;
      const matchEnd = matchStart + phoneMatch[0].length;
      const overlapsCc = creditCardSpans.some(
        ([cs, ce]) => matchStart < ce && matchEnd > cs,
      );
      if (overlapsCc) continue;
      const digits = phoneMatch[0].replace(/\D/g, '');
      if (digits.length >= 10 && digits.length <= 15) {
        findings.push({
          scan_class: 'personal_identifier',
          blocking: false,
          line: lineNum,
          matched_label: 'phone_number',
          redacted_placeholder: '[REDACTED:personal_identifier]',
        });
        break;
      }
    }

    CREDENTIAL_URL_RE.lastIndex = 0;
    const lineForEmailScan = hasCredentialUrl ? lineText.replace(CREDENTIAL_URL_RE, ' ') : lineText;
    EMAIL_PII_RE.lastIndex = 0;
    if (EMAIL_PII_RE.test(lineForEmailScan)) {
      findings.push({
        scan_class: 'personal_identifier',
        blocking: false,
        line: lineNum,
        matched_label: 'email_address',
        redacted_placeholder: '[REDACTED:personal_identifier]',
      });
    }
  });

  const blocked = findings.some((f) => f.blocking);
  return {
    clean: findings.length === 0,
    blocked,
    error_code: blocked ? 'secret_blocked' : undefined,
    findings,
  };
}

// ============================================================================
// 5. E2EE Team Share, Cross-App Import, Hand-Over & 10 Native Chat Bot Cards
// ============================================================================

export const TEAM_SHARE_ENVELOPE_VERSION = 1 as const;
export const TEAM_SHARE_OFFER_HKDF_INFO = 'orca-team-share-offer-v1' as const;
export const TEAM_SHARE_OFFER_SIG_DOMAIN = 'orca-team-share-offer-sig-v1\0' as const;
export const TEAM_SHARE_HELD_MSG_HKDF_INFO = 'orca-team-share-held-message-v1' as const;
export const TEAM_SHARE_SEND_PROOF_PURPOSE = 'share-send\0' as const;

export interface TeamShareIdentityDto {
  user_id: number;
  x25519_public_b64: string;
  ed25519_public_b64: string;
  fingerprint: string;
  created_at_ms: number;
}

export interface TeamShareOfferEnvelopeDto {
  version: 1;
  offer_id: string;
  sender_user_id: number;
  recipient_user_id: number;
  ephemeral_x25519_b64: string;
  nonce_b64: string;
  ciphertext_b64: string;
  signature_b64: string;
  expires_at_ms: number;
  created_at_ms: number;
}

export const BOT_IMPORT_SOURCES = [
  'openclaw',
  'hermes',
  'openbot',
  'custom-folder',
  'export-paste',
] as const;
export type BotImportSource = (typeof BOT_IMPORT_SOURCES)[number];

export interface BotHandOverRequestDto {
  target_host_id: string;
  include_memory?: boolean;
  include_items?: boolean;
}

export interface BotHandOverResponseDto {
  ok: boolean;
  bot_id: string;
  from_host_id: string;
  to_host_id: string;
  transferred_at_ms: number;
}

export const NATIVE_CHAT_BOT_CARD_KINDS = [
  'memoryUpdated',
  'connectorOffer',
  'importPlan',
  'importDone',
  'botRequest',
  'googleSetup',
  'composioSetup',
  'createOffer',
  'toolAdded',
  'webhook',
] as const;

export type NativeChatBotCardKind = (typeof NATIVE_CHAT_BOT_CARD_KINDS)[number];

export interface NativeChatBotCardDto {
  card_id: string;
  bot_id: string;
  kind: NativeChatBotCardKind;
  title: string;
  summary?: string;
  payload: Record<string, unknown>;
  answered?: boolean;
  created_at_ms: number;
}

// ============================================================================
// 6. 31 Event Triggers, 6 Webhook Adapters, OneShot Waits, WatchPr & IM Bridge
// ============================================================================

export const ORCA_EVENT_TRIGGER_SOURCES = [
  'slack',
  'github',
  'linear',
  'gmail',
  'calendar',
  'webhook',
] as const;
export type OrcaEventTriggerSource = (typeof ORCA_EVENT_TRIGGER_SOURCES)[number];

export interface OrcaEventTriggerSpec {
  id: string;
  source: OrcaEventTriggerSource;
  event: string;
  host_local_only?: boolean;
}

export const ORCA_EVENT_TRIGGERS: ReadonlyArray<OrcaEventTriggerSpec> = [
  // slack (3)
  { id: 'slack.mentioned', source: 'slack', event: 'mentioned' },
  { id: 'slack.message', source: 'slack', event: 'message' },
  { id: 'slack.reaction', source: 'slack', event: 'reaction' },
  // github (21)
  { id: 'github.issue_opened', source: 'github', event: 'issue_opened' },
  { id: 'github.pr_opened', source: 'github', event: 'pr_opened' },
  { id: 'github.pr_pushed', source: 'github', event: 'pr_pushed' },
  { id: 'github.pr_merged', source: 'github', event: 'pr_merged' },
  { id: 'github.comment', source: 'github', event: 'comment' },
  { id: 'github.review_comment', source: 'github', event: 'review_comment' },
  { id: 'github.review', source: 'github', event: 'review' },
  { id: 'github.mentioned', source: 'github', event: 'mentioned' },
  { id: 'github.review_requested', source: 'github', event: 'review_requested' },
  { id: 'github.assigned', source: 'github', event: 'assigned' },
  { id: 'github.ci_failed', source: 'github', event: 'ci_failed' },
  { id: 'github.ci_passed', source: 'github', event: 'ci_passed' },
  { id: 'github.ci_finished', source: 'github', event: 'ci_finished' },
  { id: 'github.pr_conflicted', source: 'github', event: 'pr_conflicted' },
  { id: 'github.pr_closed', source: 'github', event: 'pr_closed' },
  { id: 'github.pr_ready', source: 'github', event: 'pr_ready' },
  { id: 'github.labeled', source: 'github', event: 'labeled' },
  { id: 'github.issue_closed', source: 'github', event: 'issue_closed' },
  { id: 'github.deploy_finished', source: 'github', event: 'deploy_finished' },
  { id: 'github.security_alert', source: 'github', event: 'security_alert' },
  { id: 'github.workflow_finished', source: 'github', event: 'workflow_finished' },
  // linear (4)
  { id: 'linear.assigned', source: 'linear', event: 'assigned' },
  { id: 'linear.mentioned', source: 'linear', event: 'mentioned' },
  { id: 'linear.issue_created', source: 'linear', event: 'issue_created' },
  { id: 'linear.issue_moved', source: 'linear', event: 'issue_moved' },
  // gmail (1)
  { id: 'gmail.new_email', source: 'gmail', event: 'new_email', host_local_only: true },
  // calendar (1)
  { id: 'calendar.starting_soon', source: 'calendar', event: 'starting_soon', host_local_only: true },
  // webhook (1)
  { id: 'webhook.call', source: 'webhook', event: 'call' },
];

export const ORCA_WEBHOOK_ADAPTERS = [
  'standard',
  'github',
  'sentry',
  'linear',
  'pagerduty',
  'stripe',
] as const;
export type WebhookAdapterId = (typeof ORCA_WEBHOOK_ADAPTERS)[number];

export const WEBHOOK_HOOK_HOURLY_CAP = 200 as const;
export const WEBHOOK_ACCOUNT_HOURLY_CAP = 300 as const;
export const WEBHOOK_ENVELOPE_MAX_BODY_BYTES = 1_048_576 as const;

export const WEBHOOK_CALL_STATES = [
  'queued',
  'ignored',
  'paused',
  'delivered',
  'cancelled',
  'waiting_capacity',
  'started',
  'folded',
  'refused',
  'missed',
  'unavailable',
  'completed',
  'failed',
  'unverifiable',
] as const;
export type WebhookCallState = (typeof WEBHOOK_CALL_STATES)[number];

/**
 * Zero-leak public webhook DTO: strictly omits `secret` and `ingestUrl` post-creation.
 */
export interface OrcaWebhookPublicDto {
  hook_id: string;
  bot_id: string;
  name: string;
  adapter: WebhookAdapterId;
  paused: boolean;
  calls_this_hour: number;
  hourly_cap: number;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface OrcaWebhookCreatedDto extends OrcaWebhookPublicDto {
  secret: string;
  ingest_url: string;
}

export interface OneShotWaitDto {
  wait_id: string;
  bot_id: string;
  trigger_id: string;
  filter_json?: string;
  deadline_ms: number;
  status: 'waiting' | 'fired' | 'expired' | 'canceled';
  created_at_ms: number;
}

export interface WatchPrDto {
  watch_id: string;
  bot_id: string;
  repo: string;
  pr_number: number;
  fix_attempts: number;
  max_fix_attempts: number;
  deadline_ms: number;
  status: 'watching' | 'merged' | 'closed' | 'expired' | 'canceled';
  created_at_ms: number;
}

export interface OrcaTelegramLinkDto {
  bot_id: string;
  telegram_chat_id: number;
  telegram_bot_user_id?: number;
  enabled: boolean;
  linked_at_ms: number;
}

export interface OrcaTelegramCardRequest {
  chat_id: number;
  kind: NativeChatBotCardKind;
  title: string;
  body: string;
  callback_prefix: 'orca:ask:' | 'orca:gate:' | 'orca:access:';
  actions: Array<{ label: string; callback_data: string }>;
}

// ============================================================================
// 7. Orca IDE: Orchestration, orca.yaml, Worktrees, Hooks, PTY, RPC v3, Layout
// ============================================================================

export const ORCHESTRATION_TASK_STATUSES = [
  'pending',
  'ready',
  'running',
  'waiting_gate',
  'succeeded',
  'failed',
  'canceled',
] as const;
export type OrchestrationTaskStatus = (typeof ORCHESTRATION_TASK_STATUSES)[number];

export const DISPATCH_STATUSES = [
  'pending',
  'dispatched',
  'completed',
  'failed',
  'circuit_broken',
] as const;
export type DispatchStatus = (typeof DISPATCH_STATUSES)[number];

export type WorkerLivenessState =
  | { state: 'alive' }
  | { state: 'exited'; exit_code?: number | null }
  | { state: 'unverifiable' };

export const ORCA_MAILBOX_MESSAGE_TYPES = [
  'status',
  'dispatch',
  'worker_done',
  'merge_ready',
  'escalation',
  'handoff',
  'decision_gate',
  'question',
  'heartbeat',
] as const;
export type MailboxMessageType = (typeof ORCA_MAILBOX_MESSAGE_TYPES)[number];

export type MailboxPriority = 'normal' | 'high' | 'urgent';
export type MailboxDeliveryState = 'pending' | 'outstanding' | 'acknowledged' | 'fenced';
export type GateStatus = 'pending' | 'approved' | 'rejected' | 'timed_out';

export interface OrcaRunDto {
  run_id: string;
  title: string;
  workspace_id?: string;
  status: 'active' | 'completed' | 'failed' | 'canceled';
  created_at_ms: number;
  updated_at_ms: number;
}

export interface OrcaTaskDto {
  task_id: string;
  run_id: string;
  title: string;
  description?: string;
  status: OrchestrationTaskStatus;
  depends_on: string[];
  assigned_agent?: BotAgentId;
  worktree_id?: string;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface OrcaWorkerDispatchDto {
  dispatch_id: string;
  run_id: string;
  task_id: string;
  host_id: string;
  agent: BotAgentId;
  status: DispatchStatus;
  liveness: WorkerLivenessState;
  started_at_ms: number;
  finished_at_ms?: number;
}

export interface OrcaMailboxMessageDto {
  message_id: string;
  run_id: string;
  sender_id: string;
  recipient_id?: string;
  message_type: MailboxMessageType;
  priority: MailboxPriority;
  delivery_state: MailboxDeliveryState;
  body: string;
  created_at_ms: number;
}

export interface OrcaDecisionGateDto {
  gate_id: string;
  run_id: string;
  task_id?: string;
  title: string;
  prompt: string;
  status: GateStatus;
  decided_by_user_id?: number;
  note?: string;
  created_at_ms: number;
  resolved_at_ms?: number;
}

export interface OrcaHostFederationDto {
  host_id: string;
  display_name: string;
  online: boolean;
  capabilities: string[];
  active_dispatches: number;
  last_heartbeat_ms: number;
}

export const ORCA_YAML_MAX_BYTES = 262_144 as const;
export const ORCA_YAML_MAX_STRING_BYTES = 65_536 as const;
export const ORCA_YAML_MAX_ALIAS_COUNT = 100 as const;
export const ORCA_YAML_MAX_EXPANDED_NODES = 10_000 as const;
export const ORCA_YAML_MAX_DEPTH = 32 as const;

export const WORKTREE_INCLUDE_MAX_BYTES = 2_147_483_648 as const;
export const WORKTREE_INCLUDE_MAX_ENTRIES = 50_000 as const;
export const WORKTREE_INCLUDE_MAX_PATHS = 1_000 as const;

export interface OrcaWorktreeDto {
  worktree_id: string;
  repo_path: string;
  branch: string;
  path: string;
  host_id: string;
  status: 'active' | 'parked' | 'archived';
  ports: number[];
  created_at_ms: number;
  updated_at_ms: number;
}

export interface OrcaChatJournalEntryDto {
  entry_id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  submission_status?: 'queued' | 'steered' | 'sent' | 'canceled';
  created_at_ms: number;
}

export const AGENT_RUN_STATES = ['working', 'blocked', 'waiting', 'done', 'idle'] as const;
export type AgentRunState = (typeof AGENT_RUN_STATES)[number];

export interface AgentHookStatusDto {
  session_id: string;
  state: AgentRunState;
  signal_layer: 'hook' | 'screen_anchor' | 'osc7501';
  detail?: string;
  updated_at_ms: number;
}

export interface PtyMultiplexCreditAckDto {
  pane_id: string;
  frame_kind: 'output_delta' | 'recovery_snapshot';
  credit_bytes: number;
  ack_seq: number;
  cols: number;
  rows: number;
}

export const ORCA_HIBERNATION_BLOCKERS = [
  'active_pty_process',
  'running_agent_turn',
  'git_operation_in_progress',
  'active_port_forward',
  'active_review_or_merge_gate',
  'pending_bot_approval',
  'unsynced_local_snapshot',
  'pinned_no_hibernate',
] as const;

export type OrcaHibernationBlocker = (typeof ORCA_HIBERNATION_BLOCKERS)[number];

const CANONICAL_MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'cmd', 'super'] as const;
type CanonicalModifier = (typeof CANONICAL_MODIFIER_ORDER)[number];

const MODIFIER_ALIASES: Record<string, CanonicalModifier> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  shift: 'shift',
  cmd: 'cmd',
  command: 'cmd',
  meta: 'cmd',
  super: 'super',
  win: 'super',
  windows: 'super',
};

const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  del: 'delete',
};

const BLOCKED_SYSTEM_SHORTCUTS = new Set<string>([
  'cmd+q',
  'cmd+h',
  'cmd+m',
  'cmd+tab',
  'cmd+space',
  'alt+cmd+escape',
  'ctrl+cmd+q',
  'ctrl+alt+delete',
  'alt+f4',
  'alt+tab',
  'super+l',
]);

function canonicalizeOrcaShortcut(chord: string): string | null {
  if (typeof chord !== 'string') return null;
  const rawTokens = chord
    .split('+')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  if (rawTokens.length === 0) return null;

  const mods = new Set<CanonicalModifier>();
  const keys: string[] = [];
  for (const token of rawTokens) {
    if (Object.hasOwn(MODIFIER_ALIASES, token)) {
      mods.add(MODIFIER_ALIASES[token]!);
    } else {
      keys.push(Object.hasOwn(KEY_ALIASES, token) ? KEY_ALIASES[token]! : token);
    }
  }
  if (keys.length !== 1) return null;

  const orderedMods = CANONICAL_MODIFIER_ORDER.filter((m) => mods.has(m));
  return [...orderedMods, keys[0]!].join('+');
}

/**
 * Checks whether a canonicalized shortcut chord (independent of modifier order and aliases)
 * is blocked by OS safety guard (`system_shortcut_blocked`).
 */
export function isOrcaSystemShortcutBlocked(chord: string): boolean {
  const canonical = canonicalizeOrcaShortcut(chord);
  return canonical !== null && BLOCKED_SYSTEM_SHORTCUTS.has(canonical);
}

export interface OrcaArtifactPublicView {
  artifact_id: string;
  title: string;
  kind: 'html' | 'markdown';
  content: string;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface OrcaArtifactDto extends OrcaArtifactPublicView {
  edit_token: string;
}

export const E2EE_V2_PROTOCOL_ID = 'orca-mobile-e2ee/v2' as const;
export const E2EE_V2_KEY_SCHEDULE_BYTES = 96 as const;
export const E2EE_V2_HKDF_INFO = 'orca-mobile-e2ee-v2-key-schedule' as const;
export const E2EE_V2_TRANSCRIPT_SIG_DOMAIN = 'orca-e2ee-v2-transcript-v1\0' as const;

export const ORCA_RUNTIME_PROTOCOL_VERSION = 3 as const;
export const ORCA_MIN_COMPATIBLE_CLIENT_VERSION = 2 as const;
export const ORCA_MIN_COMPATIBLE_SERVER_VERSION = 2 as const;

export type OrcaCallerScope = 'desktop' | 'cli' | 'bot' | 'relay' | 'remote_host';

export interface OrcaRpcRequestEnvelope {
  method: string;
  params?: unknown;
  protocol_version: number;
  caller_scope: OrcaCallerScope;
  operation_id?: string;
}

export interface OrcaRpcResponseEnvelope {
  ok: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

export const ORCA_TAB_CONTENT_TYPES = [
  'terminal',
  'editor',
  'diff',
  'conflict-review',
  'check-details',
  'git-graph',
  'agent-session',
  'browser',
  'simulator',
  'room',
] as const;

export type OrcaTabContentType = (typeof ORCA_TAB_CONTENT_TYPES)[number];

/**
 * Dark-safe Orca IDE tab badge colors (ZERO hues in forbidden `235°..315°` purple band).
 */
export const ORCA_TAB_COLORS: Record<OrcaTabContentType, string> = {
  terminal: '#0EA5E9',
  editor: '#2563EB',
  diff: '#F59E0B',
  'conflict-review': '#EF4444',
  'check-details': '#10B981',
  'git-graph': '#06B6D4',
  'agent-session': '#14B8A6',
  browser: '#3B82F6',
  simulator: '#F43F5E',
  room: '#F97316',
};

export type OrcaDiffSide = 'left' | 'right' | 'unified';
export type OrcaLineAttribution =
  | { kind: 'human' }
  | { kind: 'bot'; bot_id: string }
  | { kind: 'worker'; dispatch_id: string }
  | { kind: 'unknown' };

export interface OrcaDiffAnnotationDto {
  annotation_id: string;
  file_path: string;
  side: OrcaDiffSide;
  line_start: number;
  line_end: number;
  body: string;
  attribution: OrcaLineAttribution;
  resolved: boolean;
  created_at_ms: number;
}

export const ORCA_USAGE_PROVIDERS_9 = [
  'claude',
  'codex',
  'opencode-go',
  'kimi-code',
  'minimax',
  'grok',
  'antigravity',
  'cursor',
  'glm-coding-plan',
] as const;
export type OrcaUsageProviderId = (typeof ORCA_USAGE_PROVIDERS_9)[number];

export interface OrcaUsageQuotaSnapshotDto {
  provider: OrcaUsageProviderId;
  window_kind: 'five_hour' | 'daily' | 'weekly' | 'monthly';
  used_percent: number;
  warning: boolean;
  source: 'structured_api' | 'claude_status_line' | 'local_estimate';
  resets_at_ms?: number;
}

export interface OrcaVaultSearchHitDto {
  doc_id: string;
  session_id: string;
  title: string;
  snippet: string;
  score: number;
  updated_at_ms: number;
}

export const ORCA_PLUGIN_TIERS = [
  'data',
  'declarative',
  'sandboxed-ui',
  'trusted-worker',
] as const;
export type OrcaPluginTier = (typeof ORCA_PLUGIN_TIERS)[number];

export const ORCA_PLUGIN_CONTRIBUTION_POINTS = [
  'panels',
  'custom_editors',
  'themes',
  'terminal_themes',
  'icon_themes',
  'fonts',
  'textmate_syntaxes',
  'language_packs',
  'commands',
  'keybindings',
  'vm_recipes',
  'settings',
  'status_bar_items',
  'mcp_servers',
  'events',
  'hooks',
] as const;
export type OrcaPluginContributionPoint = (typeof ORCA_PLUGIN_CONTRIBUTION_POINTS)[number];

export interface OrcaMcpServerDto {
  server_id: string;
  name: string;
  transport: 'stdio' | 'sse' | 'http';
  endpoint?: string;
  enabled: boolean;
}

export interface OrcaPluginManifestDto {
  schema_version: 2;
  publisher: string;
  id: string;
  version: string;
  tier: OrcaPluginTier;
  contributions: OrcaPluginContributionPoint[];
  approved: boolean;
}

// ============================================================================
// 8. Non-Themable SecuritySurface & Browser CDP Design Mode
// ============================================================================

export const SECURITY_MODAL_KINDS = [
  'PluginApproval',
  'BotAccessApproval',
  'E2eeVerification',
  'OrcaYamlTrustApproval',
] as const;
export type SecurityModalKind = (typeof SECURITY_MODAL_KINDS)[number];

export interface SecuritySurfaceApprovalDto {
  surface_id: string;
  theme_override_allowed: false;
  kind: SecurityModalKind;
  title: string;
  actor_label: string;
  summary: string;
  risk_details: string[];
  created_at_ms: number;
}

/**
 * Compile-time immutable WCAG-AAA palette for non-themable SecuritySurface dialogs.
 * NEVER overridden by user or plugin themes.
 */
export const SECURITY_SURFACE_PALETTE = {
  backdropRgba: 'rgba(5, 7, 12, 0.902)',
  surfaceBg: '#0B0F19',
  headerBg: '#161D2E',
  cardBg: '#111827',
  border: '#F59E0B',
  fgPrimary: '#F8FAFC',
  fgMuted: '#CBD5E1',
  approveBg: '#16A34A',
  denyBg: '#DC2626',
  badgeBg: '#78350F',
  badgeFg: '#FEF3C7',
} as const;

export interface DesignViewport {
  width_px: number;
  height_px: number;
  device_scale_factor_x100: number;
  is_mobile: boolean;
}

export interface DesignPin {
  pin_id: string;
  x_norm_bp: number; // 0..10000
  y_norm_bp: number; // 0..10000
  selector: string;
  note: string;
  resolved: boolean;
}

export const DESIGN_DIFF_MODES = [
  'overlay',
  'split_swipe',
  'onion_skin',
  'side_by_side',
] as const;
export type DesignDiffMode = (typeof DESIGN_DIFF_MODES)[number];

export const SOURCE_MAP_FRAMEWORKS = [
  'react_fiber',
  'vue_sfc',
  'svelte',
  'vite_data_source',
  'webpack_source_map',
  'vlq_source_map',
  'data_attribute',
  'unknown',
] as const;
export type SourceMapFramework = (typeof SOURCE_MAP_FRAMEWORKS)[number];

export interface BrowserDesignCaptureRequest {
  target_id?: string;
  session_id?: string;
  selector?: string;
  x?: number;
  y?: number;
  include_screenshot?: boolean;
  max_outer_html_bytes?: number;
}

export interface BrowserDesignCaptureResponse {
  ok: boolean;
  url: string;
  selector: string;
  tag_name: string;
  viewport: DesignViewport;
  bounding_box: { x: number; y: number; width: number; height: number };
  computed_styles: Record<string, string>;
  outer_html_snippet: string;
  source_hint?: {
    framework: SourceMapFramework;
    file?: string;
    line?: number;
    column?: number;
    component_name?: string;
  };
  screenshot_b64?: string;
  captured_at_ms: number;
}

export interface DesignModeChatHandoffDto {
  capture: BrowserDesignCaptureResponse;
  pins: DesignPin[];
  instruction: string;
  target_chat_id?: number;
  target_bot_id?: string;
}
