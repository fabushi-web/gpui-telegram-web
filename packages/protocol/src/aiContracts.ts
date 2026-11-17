/**
 * F16 AI Agent Platform, `@BotFather`, `Telegram.WebApp` Mini Apps, 全球法布施 (`fabushi-globe`),
 * Hermes 6-Tab Studio, Magpie LLM Gateway, Global Task Center & Cron, MCP Tools Dock,
 * Full-Duplex Talk Mode, Remote Computer Workbench, Tailnet, and Stars/TON Wallet Contracts.
 */

export interface BotCommandSpec {
  command: string;
  description: string;
}

export interface BotRegistryEntry {
  bot_user_id: number;
  owner_user_id: number;
  username: string;
  display_name: string;
  description: string;
  about: string;
  ai_persona?: string;
  commands: BotCommandSpec[];
  is_official: boolean;
  is_inline: boolean;
  allow_attach_menu: boolean;
  menu_button_type: 'commands' | 'web_app' | 'default';
  menu_button_text?: string;
  menu_button_url?: string;
  has_main_app: boolean;
  main_app_short_name?: string;
  preferred_model?: string;
  thinking_level?: string;
  approval_mode?: 'ask' | 'read_only' | 'yolo';
  toolset_preset?: string;
  webhook_url?: string;
  created_at_ms: number;
}

export interface MiniAppThemeParams {
  bg_color: string;
  text_color: string;
  hint_color: string;
  link_color: string;
  button_color: string;
  button_text_color: string;
  secondary_bg_color: string;
  header_bg_color: string;
}

export interface MiniAppEntry {
  app_id: string;
  bot_user_id: number;
  bot_username: string;
  short_name: string;
  title: string;
  description: string;
  category: string;
  icon_emoji: string;
  web_url: string;
  has_wasm?: boolean;
  is_installed: boolean;
  companion_chat_id?: number;
  install_count: number;
  created_at_ms: number;
}

export interface MiniAppLaunchContext {
  app: MiniAppEntry;
  launch_url: string;
  init_data: string;
  query_id: string;
  auth_date: number;
  companion_chat_id: number;
  state: Record<string, unknown>;
  theme_params: MiniAppThemeParams;
}

export interface CloudStorageItem {
  key: string;
  value: string;
  updated_at_ms?: number;
}

// ============================================================================
// Hermes 6-Tab AI Studio & SSE Runtime Contracts
// ============================================================================

export const HERMES_STUDIO_TABS = [
  'sessions',
  'memory',
  'skills',
  'toolsets',
  'cron',
  'kanban',
] as const;

export type HermesStudioTab = (typeof HERMES_STUDIO_TABS)[number];

export const HERMES_TOOLSET_IDS = [
  'core',
  'web',
  'terminal',
  'file',
  'memory',
  'skills',
  'vision',
  'image_gen',
  'video_gen',
  'browser',
  'audio_tts',
  'audio_stt',
  'cronjob',
  'subagents',
  'code_execution',
  'clarify',
  'todo',
  'planning',
  'reasoning',
  'mcp',
  'kanban',
  'desktop_ui',
  'computer_use',
  'connections',
  'honcho',
  'session_search',
  'workspace',
  'voice',
  'platform_im',
] as const;

export type HermesToolsetId = (typeof HERMES_TOOLSET_IDS)[number];

export type HermesToolsetPreset =
  | 'hermes-cli'
  | 'hermes-telegram'
  | 'hermes-acp'
  | 'minimal'
  | 'safe'
  | 'full';

export type HermesStreamEvent =
  | { type: 'turn_started'; turn_id: string; session_id: string; model: string; provider: string }
  | { type: 'thinking_delta'; turn_id: string; delta: string }
  | { type: 'text_delta'; turn_id: string; text: string; delta?: string }
  | { type: 'tool_call_started'; turn_id: string; tool_call_id: string; tool_name: string; arguments: unknown }
  | {
      type: 'tool_call_finished';
      turn_id: string;
      tool_call_id: string;
      tool_name: string;
      ok: boolean;
      output_preview: string;
      duration_ms: number;
    }
  | {
      type: 'approval_required';
      turn_id: string;
      approval_id: string;
      tool_name: string;
      command: string;
      reason: string;
      risk_level: 'low' | 'medium' | 'high' | 'critical';
    }
  | { type: 'clarify_prompt'; turn_id: string; question: string; options: string[] }
  | {
      type: 'done';
      turn_id: string;
      session_id: string;
      response_text: string;
      model: string;
      provider: string;
      finish_reason: string;
      delivered_message_id?: number;
      usage: {
        input_tokens: number;
        output_tokens: number;
        reasoning_tokens: number;
        total_tokens: number;
        estimated_cost_usd: number;
      };
      tool_calls_count: number;
    }
  | { type: 'error'; code: string; message: string };

export interface HermesCommandDescriptor {
  name: string;
  aliases: string[];
  category:
    | 'session'
    | 'model_and_provider'
    | 'tools_and_skills'
    | 'memory_and_persona'
    | 'inspection_and_export'
    | 'workflow_and_automation'
    | 'safety_and_control'
    | 'modes_and_ui';
  description: string;
  usage: string;
}

export interface HermesSessionSummary {
  session_id: string;
  title: string;
  parent_session_id?: string | null;
  chat_id?: number | null;
  bot_id?: number | null;
  source: string;
  model: string;
  message_count: number;
  total_tokens: number;
  total_cost_usd: number;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface HermesMemoryState {
  memory: {
    raw: string;
    entries: string[];
    chars: number;
    limit: 2200;
  };
  user: {
    raw: string;
    entries: string[];
    chars: number;
    limit: 1375;
  };
  soul: string;
  honcho_observations: string[];
}

export interface HermesSkillDto {
  name: string;
  description: string;
  body: string;
  tags: string[];
  toolsets: string[];
  version: string;
  enabled: boolean;
  trusted: boolean;
  status: 'active' | 'quarantined';
  security_risk: 'none' | 'low' | 'medium' | 'high' | 'critical';
  security_findings: string[];
  updated_at_ms: number;
}

export interface HermesApprovalItem {
  approval_id: string;
  session_id?: string;
  tool_name: string;
  command: string;
  reason: string;
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  status: 'pending' | 'approved' | 'denied';
  created_at_ms: number;
}

export interface HermesCronJobDto {
  job_id: string;
  name: string;
  schedule_expr: string;
  prompt: string;
  chat_id?: number | null;
  bot_id?: number | null;
  enabled: boolean;
  next_run_ms: number;
  last_run_ms?: number | null;
  run_count: number;
}

export interface HermesKanbanCardDto {
  card_id: string;
  board_id: string;
  column_id: 'inbox' | 'todo' | 'in_progress' | 'review' | 'done' | string;
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  labels: string[];
  assignee?: string;
  checklist: Array<{ text: string; completed: boolean }>;
  comments: Array<{ author: string; text: string; created_at_ms: number }>;
  position: number;
  updated_at_ms: number;
}

export interface HermesKanbanBoardDto {
  board_id: string;
  title: string;
  description: string;
  columns: string[];
  cards: HermesKanbanCardDto[];
}

// ============================================================================
// Magpie Multi-Provider LLM Gateway Contracts
// ============================================================================

export type MagpieApiMode =
  | 'chat_completions'
  | 'codex_responses'
  | 'anthropic_messages'
  | 'gemini_generate_content'
  | 'local_hermes';

export type MagpieRoutingStrategy =
  | 'smart'
  | 'order'
  | 'rotate'
  | 'usage'
  | 'pace'
  | 'cheapest'
  | 'drain'
  | 'fastest';

export interface MagpiePreset {
  id: string;
  name: string;
  category: 'vendor' | 'relay' | 'local' | 'remote' | 'custom';
  api_mode: MagpieApiMode;
  base_url: string;
  default_model: string;
  models: string[];
  no_key_required: boolean;
}

export interface MagpieProviderView {
  provider_id: string;
  preset_id?: string;
  name: string;
  api_mode: MagpieApiMode;
  base_url: string;
  default_model: string;
  enabled: boolean;
  no_key_required: boolean;
  has_api_key: boolean;
  masked_key: string | null;
  custom_headers: Record<string, string>;
  updated_at_ms: number;
}

export interface MagpieRoutingGroup {
  id: string;
  name: string;
  strategy: MagpieRoutingStrategy;
  members: Array<{
    target: string;
    weight: number;
    enabled: boolean;
    input_cost_per_1m?: number;
    output_cost_per_1m?: number;
    free?: boolean;
  }>;
  intent_fast_model?: string;
  intent_deep_model?: string;
  sticky_ttl_ms: number;
}

export interface MagpieMaskingConfig {
  enabled: boolean;
  mask_secrets: boolean;
  mask_personal: boolean;
  custom_words: string[];
  allow_list: string[];
  default_action: 'mask' | 'warn' | 'block';
}

export interface MagpieMaskingPreviewResult {
  masked_text: string;
  hits: Array<{
    kind: 'email' | 'phone' | 'api_key' | 'jwt' | 'private_key' | 'card' | 'custom';
    placeholder: string;
    action: 'mask' | 'warn' | 'block';
    preview_hint: string;
  }>;
  hit_count: number;
  blocked: boolean;
  block_reason?: string;
}

export interface MagpieUsageLedgerSummary {
  total_requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  masked_pii_count: number;
  estimated_cost_usd: number;
  entries: Array<{
    id: string;
    provider_id: string;
    model: string;
    prompt_tokens: number;
    completion_tokens: number;
    masked_hits: number;
    latency_ms: number;
    created_at_ms: number;
  }>;
}

// ============================================================================
// Global Task Center (7-State FSM + Cron), MCP Dock, Talk Mode, Computers, Tailnet & Wallet
// ============================================================================

export type TaskFsmState =
  | 'draft'
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface TaskItemDto {
  task_id: string;
  title: string;
  description: string;
  state: TaskFsmState;
  cron_expr?: string | null;
  next_run_ms?: number | null;
  chat_id?: number | null;
  progress: number;
  logs: string[];
  created_at_ms: number;
  updated_at_ms: number;
}

export interface McpServerDto {
  server_id: string;
  name: string;
  transport: 'stdio' | 'sse' | 'http';
  endpoint: string;
  enabled: boolean;
  status: 'connected' | 'disconnected' | 'error';
  tools_count: number;
}

export interface McpToolDto {
  tool_id: string;
  server_id: string;
  name: string;
  description: string;
  risk_level: 'read_only' | 'low' | 'medium' | 'high' | 'critical';
  requires_approval: boolean;
}

export interface McpPendingApprovalDto {
  request_id: string;
  server_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  risk_level: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at_ms: number;
}

export type TalkSessionStateKind = 'idle' | 'listening' | 'thinking' | 'speaking' | 'interrupted';

export interface TalkSessionDto {
  session_id: string;
  state: TalkSessionStateKind;
  generation: number;
  signal_seq: number;
  buffered_chunks: number;
  last_transcript?: string;
  last_reply?: string;
  tts_segments?: string[];
}

export type ComputerRunPolicy =
  | 'ask_every_time'
  | 'allow_read_only'
  | 'always_allow_authorized'
  | 'disabled';

export interface ComputerNodeDto {
  node_id: string;
  display_name: string;
  kind: 'cloud_sandbox' | 'local_device' | 'cloud_server';
  tier_badge?: string;
  host: string;
  os_name: string;
  resolution: string;
  online: boolean;
  run_policy: ComputerRunPolicy;
  has_saved_credential: boolean;
  lease_state: 'idle' | 'active_control' | 'human_takeover' | 'preempted';
  lease_generation: number;
  frame_svg_data_url?: string;
  updated_at_ms: number;
}

export interface PendingComputerCommandDto {
  command_id: string;
  node_id: string;
  caller_label: string;
  operation: Record<string, unknown>;
  status: 'pending' | 'approved' | 'denied' | 'completed';
  created_at_ms: number;
}

export interface TailnetPeerDescriptor {
  device_id: string;
  display_name: string;
  ipv4: string;
  relay_mode: 'direct' | 'derp';
  derp_region: string;
  online: boolean;
  latency_ms: number;
  last_seen_ms: number;
}

export interface TailnetStatusDto {
  owner_user_id: number;
  seq: number;
  connected: boolean;
  derp_region: string;
  derp_ws_path: string;
  stun_http_path: string;
  self_peer: TailnetPeerDescriptor;
  peers: TailnetPeerDescriptor[];
}

export interface WalletTransactionDto {
  tx_id: string;
  kind: 'topup' | 'gift_sent' | 'gift_received' | 'invoice_payment' | 'transfer';
  amount_stars: number;
  ton_nano_delta?: number;
  peer_user_id?: number;
  chat_id?: number;
  description: string;
  created_at_ms: number;
}

export interface WalletStateDto {
  user_id: number;
  balance: number;
  stars_balance: number;
  ton_nano: number;
  ton_balance: string;
  updated_at_ms: number;
  transactions: WalletTransactionDto[];
}
