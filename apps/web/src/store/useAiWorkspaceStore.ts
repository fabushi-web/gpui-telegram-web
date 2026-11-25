import { create } from 'zustand';
import type {
  AssistStartRequest,
  AssistStartResponse,
  AutomationAppDetail,
  AutomationAppSummary,
  AutomationScriptApp,
  BotRegistryEntry,
  BrowserActionTrace,
  BrowserAuditLogEntry,
  BrowserCommandRequest,
  BrowserCommandResult,
  BrowserControlMode,
  BrowserControlRevokeResponse,
  BrowserSnapshotDto,
  BrowserTargetDescriptor,
  CodingAgentBotConfig,
  CodingAgentsProbeRequest,
  CodingAgentsProbeResponse,
  ComputerNodeDto,
  ComputerRunPolicy,
  DesktopPairingTicketDto,
  DetectedCodingProvider,
  DeviceSyncActionResponse,
  DeviceSyncApproveRequest,
  DeviceSyncRequestDto,
  DeviceSyncRequestResponse,
  DeviceSyncStatusResponse,
  HeadlessBrowserSessionDto,
  HermesApprovalItem,
  HermesCommandDescriptor,
  HermesCronJobDto,
  HermesKanbanBoardDto,
  HermesMemoryState,
  HermesSessionSummary,
  HermesSkillDto,
  HermesStreamEvent,
  HermesStudioSnapshot,
  HermesStudioTab,
  InstalledAutomationApp,
  ListAutomationAppsQuery,
  MagpieConfigSnapshot,
  MagpieMaskingConfig,
  MagpieMaskingPreviewResult,
  MagpiePreset,
  MagpieProviderView,
  MagpieRoutingGroup,
  MagpieUsageLedgerSummary,
  McpAuditEntry,
  McpJsonRpcRequest,
  McpJsonRpcResponse,
  McpPendingApprovalDto,
  McpServerDto,
  McpToolDto,
  MiniAppEntry,
  MiniAppLaunchContext,
  OAuthGrantSummary,
  PendingComputerCommandDto,
  PendingDeviceSyncItem,
  PublishAutomationAppRequest,
  RecordAutomationRunRequest,
  RecordAutomationRunResponse,
  RecordedActionKind,
  RecordedBrowserAction,
  RemoteAssistConfigDto,
  RemoteSessionDto,
  ScriptAppMetadata,
  ScriptReplayReport,
  TailnetStatusDto,
  TalkSessionDto,
  TaskItemDto,
  UpsertUserVaultItemRequest,
  UpsertUserVaultItemResponse,
  UserVaultItemDto,
  UserVaultKeyEnvelopeDto,
  WalletStateDto,
} from '@gpui-telegram/protocol';
import { getClientAdapter } from '../adapters';
import {
  browserControlAgent,
  type BrowserCommandInput,
  type LocalBrowserAuditEntry,
} from '../services/browserControlAgent';
import { useAuthStore, type PasskeySummaryItem } from './useAuthStore';
import { useChatStore } from './useChatStore';
import { useUiStore } from './useUiStore';

export interface ProviderNotConfiguredError {
  code: 'PROVIDER_ERROR';
  error: string;
  message: string;
  needsProviderSelection: boolean;
  action?: string;
  httpStatus: number;
}

export class ApiRequestError extends Error {
  public readonly status: number;
  public readonly errorCode: string;
  public readonly needsProviderSelection: boolean;
  public readonly action?: string;
  public readonly payload: Record<string, unknown>;

  constructor(
    status: number,
    errorCode: string,
    message: string,
    payload: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.errorCode = errorCode;
    this.needsProviderSelection = Boolean(payload.needs_provider_selection);
    this.action = typeof payload.action === 'string' ? payload.action : undefined;
    this.payload = payload;
  }
}

export interface MagpieMetaSnapshot {
  hasConfiguredProvider: boolean;
  needsProviderSelection: boolean;
  allowLocalFallback: boolean;
  userScoped: boolean;
}

export interface ModelsDevCatalogDto {
  source: string;
  fetched_at_ms: number;
  providers: Record<string, string[]>;
}

export interface CodingHostSummary {
  device_id: string;
  display_name: string;
  os_name: string;
  providers: DetectedCodingProvider[];
  connected_at_ms: number;
}

export interface GroupWorkspaceSnapshot {
  revision: number;
  entries: Record<string, unknown>;
}

export interface GroupFloorSnapshot {
  current_speaker: string | null;
  queued_count: number;
  loop_hops: number;
}

export interface FabushiBotCreateInput {
  display_name: string;
  username: string;
  description?: string;
  ai_persona?: string;
  preferred_model?: string;
  approval_mode?: 'ask' | 'read_only' | 'yolo';
  coding_agent?: CodingAgentBotConfig | null;
}

export interface StreamingHermesTurn {
  turnId: string;
  sessionId: string;
  prompt: string;
  thinkingText: string;
  outputText: string;
  model: string;
  provider: string;
  isStreaming: boolean;
  toolCalls: Array<{
    id: string;
    name: string;
    ok?: boolean;
    outputPreview?: string;
    durationMs?: number;
  }>;
  pendingApproval?: {
    approvalId: string;
    toolName: string;
    command: string;
    reason: string;
    riskLevel: string;
  } | null;
  error?: string | null;
}

export interface MiniAppMainButtonState {
  isVisible: boolean;
  isActive: boolean;
  text: string;
  color: string;
  textColor: string;
}

function resolveApiUrl(path: string): string {
  const base = (useAuthStore.getState().serverUrl ?? '').trim().replace(/\/+$/, '');
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return base ? `${base}${cleanPath}` : cleanPath;
}

function buildAuthHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...(extra ?? {}) };
  const token = useAuthStore.getState().token;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function apiJson<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const headers = buildAuthHeaders(
    body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
  );
  const res = await fetch(resolveApiUrl(path), {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  if (text.trim()) {
    try {
      const json: unknown = JSON.parse(text);
      if (json && typeof json === 'object' && !Array.isArray(json)) {
        parsed = json as Record<string, unknown>;
      } else if (res.ok) {
        return json as T;
      }
    } catch {
      if (res.ok) {
        return text as unknown as T;
      }
    }
  }

  if (!res.ok) {
    const errorCode =
      typeof parsed.error === 'string' && parsed.error.trim()
        ? parsed.error.trim()
        : `http_${res.status}`;
    const message =
      (typeof parsed.message === 'string' && parsed.message.trim()) ||
      (typeof parsed.detail === 'string' && parsed.detail.trim()) ||
      (typeof parsed.error_description === 'string' && parsed.error_description.trim()) ||
      errorCode;
    throw new ApiRequestError(res.status, errorCode, message, parsed);
  }

  return parsed as unknown as T;
}

function normalizeModelsCatalogResponse(raw: Record<string, unknown>): ModelsDevCatalogDto {
  const rawProviders =
    raw.providers && typeof raw.providers === 'object' && !Array.isArray(raw.providers)
      ? (raw.providers as Record<string, unknown>)
      : {};
  const providers: Record<string, string[]> = {};
  for (const [provKey, value] of Object.entries(rawProviders)) {
    if (Array.isArray(value)) {
      const models = value
        .map((item) => {
          if (typeof item === 'string') return item.trim();
          if (item && typeof item === 'object' && 'id' in item) {
            return String((item as { id?: unknown }).id ?? '').trim();
          }
          return '';
        })
        .filter(Boolean);
      if (models.length > 0) providers[provKey] = models;
    } else if (value && typeof value === 'object' && 'models' in value) {
      const modelsObj = (value as { models?: unknown }).models;
      if (Array.isArray(modelsObj)) {
        providers[provKey] = modelsObj.map(String).filter(Boolean);
      } else if (modelsObj && typeof modelsObj === 'object') {
        providers[provKey] = Object.keys(modelsObj as Record<string, unknown>);
      }
    }
  }
  return {
    source: typeof raw.source === 'string' && raw.source ? raw.source : 'models.dev',
    fetched_at_ms: Number(raw.fetched_at_ms ?? Date.now()),
    providers,
  };
}

function mapRawMagpieState(raw: Record<string, unknown>): {
  config: MagpieConfigSnapshot;
  meta: MagpieMetaSnapshot;
  subscriptions: Array<Record<string, unknown>>;
} {
  const providers = Array.isArray(raw.providers) ? (raw.providers as MagpieProviderView[]) : [];
  const presets = Array.isArray(raw.presets) ? (raw.presets as MagpiePreset[]) : [];
  const subscriptions = Array.isArray(raw.subscriptions)
    ? (raw.subscriptions as Array<Record<string, unknown>>)
    : [];
  const masking = (raw.masking as MagpieMaskingConfig | undefined) ?? {
    enabled: true,
    mask_secrets: true,
    mask_personal: true,
    custom_words: [],
    allow_list: [],
    default_action: 'mask',
  };
  const allowLocalFallback = Boolean(raw.allow_local_fallback ?? raw.allowLocalFallback ?? false);
  const config: MagpieConfigSnapshot = {
    presets,
    providers,
    activeProvider: String(raw.active_provider ?? raw.activeProvider ?? ''),
    activeModel: String(raw.active_model ?? raw.activeModel ?? ''),
    allowLocalFallback,
    routingGroups: Array.isArray(raw.routing_groups ?? raw.routingGroups)
      ? ((raw.routing_groups ?? raw.routingGroups) as MagpieRoutingGroup[])
      : [],
    routingStrategy: String(raw.routing_strategy ?? raw.routingStrategy ?? 'smart'),
    masking,
  };
  const hasConfiguredProvider =
    raw.has_configured_provider !== undefined
      ? Boolean(raw.has_configured_provider)
      : providers.some((p) => p.enabled !== false);
  const needsProviderSelection =
    raw.needs_provider_selection !== undefined
      ? Boolean(raw.needs_provider_selection)
      : !hasConfiguredProvider;
  return {
    config,
    meta: {
      hasConfiguredProvider,
      needsProviderSelection,
      allowLocalFallback,
      userScoped: raw.user_scoped !== undefined ? Boolean(raw.user_scoped) : true,
    },
    subscriptions,
  };
}

export interface AiWorkspaceState {
  // Bots & MiniApps
  bots: BotRegistryEntry[];
  lastCreatedBotToken: string | null;
  miniApps: MiniAppEntry[];
  activeMiniApp: MiniAppLaunchContext | null;
  miniAppIframeRef: HTMLIFrameElement | null;
  miniAppMainButton: MiniAppMainButtonState;
  miniAppBackButtonVisible: boolean;
  lastMiniAppWebData: string | null;

  // Hermes / Fabushi Runtime, Approvals, Coding Bots & Multi-Agent
  hermesStudio: HermesStudioSnapshot | null;
  activeStudioTab: HermesStudioTab | 'magpie';
  hermesCommands: HermesCommandDescriptor[];
  hermesApprovals: HermesApprovalItem[];
  hermesProviderError: ProviderNotConfiguredError | null;
  streamingTurn: StreamingHermesTurn | null;
  lastSlashResponse: string | null;
  fabushiBots: BotRegistryEntry[];
  codingHosts: CodingHostSummary[];
  codingProbeResult: CodingAgentsProbeResponse | null;
  groupWorkspaces: Record<number, GroupWorkspaceSnapshot>;
  groupFloors: Record<number, GroupFloorSnapshot>;

  // Magpie v1.6 LLM Gateway & Live models.dev Catalog
  magpieConfig: MagpieConfigSnapshot | null;
  magpieMeta: MagpieMetaSnapshot | null;
  magpieSubscriptions: Array<Record<string, unknown>>;
  magpieUsage: MagpieUsageLedgerSummary | null;
  maskPreview: MagpieMaskingPreviewResult | null;
  modelsCatalog: ModelsDevCatalogDto | null;
  modelsCatalogError: string | null;

  // Tasks & Cron
  tasks: TaskItemDto[];

  // MCP Tools Dock & Official OAuth 2.1 MCP
  mcpServers: McpServerDto[];
  mcpTools: McpToolDto[];
  mcpApprovals: McpPendingApprovalDto[];
  lastMcpOutput: Record<string, unknown> | null;
  oauthMcpGrants: OAuthGrantSummary[];
  oauthMcpAudit: McpAuditEntry[];

  // Talk Mode
  talkSession: TalkSessionDto | null;
  talkProviderError: ProviderNotConfiguredError | null;

  // UU-Parity Remote Assist, Computers & Tailnet
  computers: ComputerNodeDto[];
  computerApprovals: PendingComputerCommandDto[];
  tailnet: TailnetStatusDto | null;
  remoteAssistInfo: RemoteAssistConfigDto | null;
  remoteSessions: RemoteSessionDto[];
  computerFrames: Record<string, string | null>;
  lastTakeoverMs: number | null;
  lastKillSwitchLatencyMs: number | null;

  // Wallet
  wallet: WalletStateDto | null;

  // Built-in Browser Workspace, Script Distillation & Automation App Store
  pairingTicket: DesktopPairingTicketDto | null;
  browserTargets: BrowserTargetDescriptor[];
  headlessSessions: HeadlessBrowserSessionDto[];
  headlessSnapshots: Record<string, BrowserSnapshotDto>;
  headlessScreenshots: Record<string, string>;
  browserAuditLogs: BrowserAuditLogEntry[];
  browserControlMode: BrowserControlMode;
  chromiumAvailable: boolean | null;
  lastBrowserRevokeLatencyMs: number | null;
  recordedBrowserTrace: RecordedBrowserAction[];
  distilledManifest: AutomationScriptApp | null;
  lastScriptReplayReport: ScriptReplayReport | null;
  automationApps: AutomationAppSummary[];
  installedAutomationApps: InstalledAutomationApp[];
  localBridgeState: {
    targetId: string;
    allowDesktopControl: boolean;
    controlGeneration: number;
    isRemoteActive: boolean;
    auditLogs: LocalBrowserAuditEntry[];
  };

  // E2EE User Vault, X25519 Device Trust Ring & Server Passkeys
  vaultEnvelope: UserVaultKeyEnvelopeDto | null;
  vaultItems: UserVaultItemDto[];
  vaultLatestRevision: number;
  pendingDeviceSyncs: PendingDeviceSyncItem[];
  activeDeviceSyncRequest: DeviceSyncRequestResponse | null;
  accountPasskeys: PasskeySummaryItem[];

  // Actions
  bootstrapWorkspaces: () => Promise<void>;
  loadBots: () => Promise<BotRegistryEntry[]>;
  createBot: (req: {
    displayName: string;
    username: string;
    description?: string;
  }) => Promise<{ bot: BotRegistryEntry; botToken: string; chatId: number }>;

  loadMiniApps: (query?: string) => Promise<MiniAppEntry[]>;
  launchMiniApp: (
    botUsername: string,
    shortName: string,
    chatId?: number,
  ) => Promise<MiniAppLaunchContext>;
  setMiniAppIframeRef: (iframe: HTMLIFrameElement | null) => void;
  clickMiniAppMainButton: () => void;
  clickMiniAppBackButton: () => void;
  closeMiniApp: () => void;
  bindMiniAppPostMessageBridge: () => () => void;

  // Hermes / Fabushi Actions
  loadHermesStudio: () => Promise<HermesStudioSnapshot>;
  setActiveStudioTab: (tab: HermesStudioTab | 'magpie') => void;
  updateStudioTab: (
    tab: HermesStudioTab,
    patch: Record<string, unknown>,
  ) => Promise<HermesStudioSnapshot>;
  createHermesSession: (title: string, chatId?: number) => Promise<HermesSessionSummary>;
  branchHermesSession: (sessionId: string) => Promise<HermesSessionSummary>;
  compressHermesSession: (sessionId: string) => Promise<void>;
  toggleHermesSkill: (name: string, enabled: boolean) => Promise<void>;
  decideHermesApproval: (
    approvalId: string,
    decision: 'approve_once' | 'approve_session' | 'deny',
  ) => Promise<void>;
  clearHermesProviderError: () => void;
  streamPrompt: (req: {
    prompt: string;
    sessionId?: string;
    chatId?: number;
    model?: string;
  }) => Promise<void>;
  runSlashCommand: (command: string, chatId?: number, sessionId?: string) => Promise<string>;

  // Fabushi Bots, Coding Agents & Multi-Agent Workspace Actions
  loadFabushiBots: () => Promise<BotRegistryEntry[]>;
  createFabushiBot: (req: FabushiBotCreateInput) => Promise<{
    bot: BotRegistryEntry;
    botToken: string;
    chatId: number;
  }>;
  deleteFabushiBot: (botId: number | string) => Promise<void>;
  loadCodingHosts: () => Promise<CodingHostSummary[]>;
  probeCodingAgents: (req?: CodingAgentsProbeRequest) => Promise<CodingAgentsProbeResponse>;
  loadGroupWorkspace: (chatId: number) => Promise<GroupWorkspaceSnapshot>;
  putGroupWorkspaceKey: (chatId: number, key: string, value: unknown) => Promise<void>;
  loadGroupFloor: (chatId: number) => Promise<GroupFloorSnapshot>;

  // Magpie v1.6 Actions
  loadMagpie: () => Promise<void>;
  updateMagpie: (patch: Record<string, unknown>) => Promise<MagpieConfigSnapshot>;
  loadModelsCatalog: (refresh?: boolean) => Promise<ModelsDevCatalogDto | null>;
  syncMagpieSubscriptions: (
    subscriptions: Array<Record<string, unknown>>,
    autoActivate?: boolean,
  ) => Promise<void>;
  activateMagpieSubscription: (subId: string, model?: string) => Promise<void>;
  upsertMagpieGroup: (group: {
    id?: string;
    name: string;
    strategy: string;
    models: string[];
  }) => Promise<MagpieRoutingGroup>;
  deleteMagpieGroup: (groupId: string) => Promise<void>;
  probeMagpieProvider: (
    providerId: string,
  ) => Promise<{ ok: boolean; latency_ms?: number; models?: string[]; error?: string }>;
  scanMagpieSubscriptions: () => Promise<Array<Record<string, unknown>>>;
  importMagpieConfig: (payload: {
    raw_text?: string;
    providers?: Array<Record<string, unknown>>;
  }) => Promise<MagpieConfigSnapshot>;
  previewMask: (sampleText: string) => Promise<MagpieMaskingPreviewResult>;

  // Task Center Actions
  loadTasks: () => Promise<TaskItemDto[]>;
  createTask: (req: {
    title: string;
    description?: string;
    cronExpr?: string;
    chatId?: number;
  }) => Promise<TaskItemDto>;
  updateTask: (
    taskId: string,
    patch: Partial<{ state: TaskItemDto['state']; title: string; cronExpr: string }>,
  ) => Promise<TaskItemDto>;
  deleteTask: (taskId: string) => Promise<void>;

  // MCP Dock & Official OAuth 2.1 MCP Actions
  loadMcp: () => Promise<void>;
  registerMcpServer: (req: {
    name: string;
    transport: string;
    endpoint?: string;
    url?: string;
    command?: string;
    args?: string[];
  }) => Promise<McpServerDto>;
  deleteMcpServer: (serverId: string) => Promise<void>;
  invokeMcpTool: (req: {
    toolId?: string;
    toolName?: string;
    arguments?: Record<string, unknown>;
    forceApprove?: boolean;
  }) => Promise<Record<string, unknown>>;
  decideMcpApproval: (requestId: string, allow: boolean) => Promise<void>;
  revokeOAuthMcpGrant: (familyId: string) => Promise<void>;

  // Talk Mode Actions
  startTalk: () => Promise<TalkSessionDto>;
  sendTalkUtterance: (audioOrTranscript: Uint8Array | string) => Promise<TalkSessionDto>;
  sendTalkAudioBlob: (audioBlob: Blob) => Promise<TalkSessionDto | null>;
  clearTalkProviderError: () => void;
  bargeInTalk: () => Promise<TalkSessionDto>;
  stopTalk: () => Promise<TalkSessionDto>;

  // UU-Parity Remote Assist & Computers Actions
  loadComputers: () => Promise<void>;
  loadRemoteAssist: () => Promise<void>;
  resetRemoteAssistCode: () => Promise<RemoteAssistConfigDto>;
  setRemoteAssistCode: (code: string) => Promise<RemoteAssistConfigDto>;
  setAllowRemoteAssist: (allowAssist: boolean) => Promise<RemoteAssistConfigDto>;
  startRemoteAssist: (req: AssistStartRequest) => Promise<AssistStartResponse>;
  disconnectRemoteSession: (sessionId: string) => Promise<void>;
  loadComputerFrame: (nodeId: string) => Promise<string | null>;
  createCloudComputer: (req: {
    display_name: string;
    host: string;
    port?: number;
    ssh_user: string;
    secret?: string;
    run_policy?: ComputerRunPolicy;
  }) => Promise<ComputerNodeDto>;
  testComputerConnection: (
    nodeId: string,
  ) => Promise<{ ok: boolean; latency_ms?: number; message?: string }>;
  deleteComputer: (nodeId: string) => Promise<void>;
  runComputerOp: (
    nodeId: string,
    operation: Record<string, unknown>,
    callerLabel?: string,
  ) => Promise<Record<string, unknown>>;
  decideComputerApproval: (commandId: string, approve: boolean) => Promise<void>;
  setComputerPolicy: (nodeId: string, policy: ComputerRunPolicy) => Promise<void>;
  emergencyTakeover: (
    nodeId?: string,
  ) => Promise<{ latencyMs: number; newGeneration: number; disconnectedCount: number }>;

  // Wallet Actions
  loadWallet: () => Promise<WalletStateDto>;
  redeemStars: (req: { redeem_code?: string; order_id?: string }) => Promise<WalletStateDto>;
  sendStarGift: (req: {
    toUserId: number;
    chatId?: number;
    amountStars: number;
    giftId?: string;
    message?: string;
  }) => Promise<WalletStateDto>;

  // Browser Workspace, Script Distillation & Automation App Store Actions
  loadBrowserControl: () => Promise<void>;
  registerCurrentTabForControl: () => Promise<BrowserTargetDescriptor>;
  createPairingTicket: (label?: string, ttlSecs?: number) => Promise<DesktopPairingTicketDto>;
  claimPairingTicket: (
    pairCode: string,
    controllerLabel?: string,
  ) => Promise<DesktopPairingTicketDto>;
  setAllowDesktopControl: (allowed: boolean) => void;
  runLocalBrowserCommand: (cmd: BrowserCommandInput) => Promise<BrowserCommandResult>;
  runRemoteBrowserCommand: (req: BrowserCommandRequest) => Promise<BrowserCommandResult>;
  revokeBrowserControl: (
    targetId?: string,
  ) => Promise<{ elapsedMs: number; controlGeneration: number }>;
  setBrowserControlModeAction: (req: {
    action: 'takeover' | 'resume' | 'cancel' | 'request_takeover';
    reason?: string;
    paused_at_step?: number;
    active_step?: number;
    status_text?: string;
  }) => Promise<BrowserControlMode>;
  openHeadlessSession: (url?: string, preferFallback?: boolean) => Promise<HeadlessBrowserSessionDto>;
  runHeadlessAction: (
    sessionId: string,
    req: Omit<BrowserCommandRequest, 'target_id'>,
  ) => Promise<BrowserCommandResult>;
  captureHeadlessScreenshot: (sessionId: string) => Promise<string>;
  closeHeadlessSession: (sessionId: string) => Promise<void>;
  recordBrowserAction: (action: RecordedActionKind, pageUrl?: string) => void;
  clearRecordedBrowserTrace: () => void;
  distillBrowserScript: (
    metadata: ScriptAppMetadata,
    traceOverride?: BrowserActionTrace,
  ) => Promise<AutomationScriptApp>;
  replayBrowserScript: (
    manifest: AutomationScriptApp | Record<string, unknown>,
    params?: Record<string, string>,
    sessionId?: string,
  ) => Promise<ScriptReplayReport>;
  loadAutomationApps: (query?: ListAutomationAppsQuery) => Promise<AutomationAppSummary[]>;
  loadInstalledAutomationApps: () => Promise<InstalledAutomationApp[]>;
  publishAutomationApp: (req: PublishAutomationAppRequest) => Promise<AutomationAppDetail>;
  installAutomationApp: (appId: string) => Promise<void>;
  uninstallAutomationApp: (appId: string) => Promise<void>;
  recordAutomationRun: (
    appId: string,
    req: RecordAutomationRunRequest,
  ) => Promise<RecordAutomationRunResponse>;
  invokeMcpRpc: (req: McpJsonRpcRequest) => Promise<McpJsonRpcResponse>;

  // E2EE User Vault, X25519 Device Trust Ring & Account Passkeys Actions
  loadVaultState: () => Promise<void>;
  saveVaultEnvelope: (envelope: UserVaultKeyEnvelopeDto) => Promise<UserVaultKeyEnvelopeDto | null>;
  upsertVaultItem: (
    category: string,
    itemKey: string,
    req: UpsertUserVaultItemRequest,
  ) => Promise<UpsertUserVaultItemResponse>;
  deleteVaultItem: (
    category: string,
    itemKey: string,
    expectedRevision?: number,
  ) => Promise<UpsertUserVaultItemResponse>;
  requestDeviceSync: (req: DeviceSyncRequestDto) => Promise<DeviceSyncRequestResponse>;
  approveDeviceSync: (
    requestId: string,
    req: DeviceSyncApproveRequest,
  ) => Promise<DeviceSyncActionResponse>;
  denyDeviceSync: (requestId: string) => Promise<DeviceSyncActionResponse>;
  pollDeviceSyncStatus: (requestId: string) => Promise<DeviceSyncStatusResponse>;
  loadAccountPasskeys: () => Promise<PasskeySummaryItem[]>;
  deleteAccountPasskey: (credId: string) => Promise<void>;
}

export function describeCronExpression(cronExpr?: string | null): string {
  if (!cronExpr || !cronExpr.trim()) return 'Manual trigger';
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 5) return cronExpr;
  const [min, hour, dom, mon, dow] = parts;
  if (min === '*' && hour === '*') return 'Every minute';
  if (min?.startsWith('*/') && hour === '*') return `Every ${min.slice(2)} minutes`;
  if (dom === '*' && mon === '*' && dow === '*') {
    return `Daily at ${hour?.padStart(2, '0')}:${min?.padStart(2, '0')}`;
  }
  return `Cron (${cronExpr})`;
}

const DEFAULT_MAIN_BUTTON: MiniAppMainButtonState = {
  isVisible: false,
  isActive: true,
  text: 'CONTINUE',
  color: '#0A84FF',
  textColor: '#FFFFFF',
};

let miniAppBridgeCleanup: (() => void) | null = null;

export const useAiWorkspaceStore = create<AiWorkspaceState>((set, get) => ({
  bots: [],
  lastCreatedBotToken: null,
  miniApps: [],
  activeMiniApp: null,
  miniAppIframeRef: null,
  miniAppMainButton: { ...DEFAULT_MAIN_BUTTON },
  miniAppBackButtonVisible: false,
  lastMiniAppWebData: null,

  hermesStudio: null,
  activeStudioTab: 'sessions',
  hermesCommands: [],
  hermesApprovals: [],
  hermesProviderError: null,
  streamingTurn: null,
  lastSlashResponse: null,
  fabushiBots: [],
  codingHosts: [],
  codingProbeResult: null,
  groupWorkspaces: {},
  groupFloors: {},

  magpieConfig: null,
  magpieMeta: null,
  magpieSubscriptions: [],
  magpieUsage: null,
  maskPreview: null,
  modelsCatalog: null,
  modelsCatalogError: null,

  tasks: [],

  mcpServers: [],
  mcpTools: [],
  mcpApprovals: [],
  lastMcpOutput: null,
  oauthMcpGrants: [],
  oauthMcpAudit: [],

  talkSession: null,
  talkProviderError: null,

  computers: [],
  computerApprovals: [],
  tailnet: null,
  remoteAssistInfo: null,
  remoteSessions: [],
  computerFrames: {},
  lastTakeoverMs: null,
  lastKillSwitchLatencyMs: null,

  wallet: null,

  pairingTicket: null,
  browserTargets: [],
  headlessSessions: [],
  headlessSnapshots: {},
  headlessScreenshots: {},
  browserAuditLogs: [],
  browserControlMode: { mode: 'idle' },
  chromiumAvailable: null,
  lastBrowserRevokeLatencyMs: null,
  recordedBrowserTrace: [],
  distilledManifest: null,
  lastScriptReplayReport: null,
  automationApps: [],
  installedAutomationApps: [],
  localBridgeState: browserControlAgent.getState(),

  vaultEnvelope: null,
  vaultItems: [],
  vaultLatestRevision: 0,
  pendingDeviceSyncs: [],
  activeDeviceSyncRequest: null,
  accountPasskeys: [],

  bootstrapWorkspaces: async () => {
    await Promise.allSettled([
      get().loadBots(),
      get().loadMiniApps(),
      get().loadTasks(),
      get().loadWallet(),
    ]);
  },

  loadBots: async () => {
    const bots = await getClientAdapter().listBots();
    set({ bots });
    return bots;
  },

  createBot: async (req) => {
    const res = await getClientAdapter().createBot(req);
    set((prev) => ({
      bots: [res.bot, ...prev.bots.filter((b) => b.username !== res.bot.username)],
      lastCreatedBotToken: res.botToken,
    }));
    await useChatStore.getState().bootstrapChats();
    return res;
  },

  loadMiniApps: async (query) => {
    const miniApps = await getClientAdapter().listMiniApps(query);
    set({ miniApps });
    return miniApps;
  },

  launchMiniApp: async (botUsername, shortName, chatId) => {
    const ctx = await getClientAdapter().launchMiniApp(botUsername, shortName, chatId);
    set({
      activeMiniApp: ctx,
      miniAppMainButton: { ...DEFAULT_MAIN_BUTTON },
      miniAppBackButtonVisible: false,
    });
    useUiStore.getState().setMiniAppModalOpen(true);
    return ctx;
  },

  setMiniAppIframeRef: (miniAppIframeRef) => set({ miniAppIframeRef }),

  clickMiniAppMainButton: () => {
    const win = get().miniAppIframeRef?.contentWindow;
    win?.postMessage({ eventType: 'main_button_pressed' }, '*');
  },

  clickMiniAppBackButton: () => {
    const win = get().miniAppIframeRef?.contentWindow;
    win?.postMessage({ eventType: 'back_button_pressed' }, '*');
  },

  closeMiniApp: () => {
    set({
      activeMiniApp: null,
      miniAppIframeRef: null,
      miniAppMainButton: { ...DEFAULT_MAIN_BUTTON },
      miniAppBackButtonVisible: false,
    });
    useUiStore.getState().setMiniAppModalOpen(false);
  },

  bindMiniAppPostMessageBridge: () => {
    miniAppBridgeCleanup?.();
    if (typeof window === 'undefined') return () => undefined;

    const handler = async (ev: MessageEvent) => {
      const active = get().activeMiniApp;
      if (!active || !ev.data) return;

      let parsed: Record<string, unknown> | null = null;
      if (typeof ev.data === 'string') {
        try {
          parsed = JSON.parse(ev.data) as Record<string, unknown>;
        } catch {
          return;
        }
      } else if (typeof ev.data === 'object') {
        parsed = ev.data as Record<string, unknown>;
      }
      if (!parsed) return;

      const eventType = String(parsed.eventType ?? parsed.type ?? '');
      const eventData = (parsed.eventData ?? parsed.data ?? {}) as Record<string, unknown>;

      switch (eventType) {
        case 'web_app_close':
          get().closeMiniApp();
          break;
        case 'web_app_data_send': {
          const rawData = String(eventData.data ?? '');
          set({ lastMiniAppWebData: rawData });
          if (active.companion_chat_id) {
            await useChatStore
              .getState()
              .sendText(active.companion_chat_id, `🧩 MiniApp (${active.app.title}): ${rawData}`)
              .catch(() => undefined);
          }
          break;
        }
        case 'web_app_setup_main_button': {
          set((prev) => ({
            miniAppMainButton: {
              isVisible:
                eventData.is_visible !== undefined
                  ? Boolean(eventData.is_visible)
                  : prev.miniAppMainButton.isVisible,
              isActive:
                eventData.is_active !== undefined
                  ? Boolean(eventData.is_active)
                  : prev.miniAppMainButton.isActive,
              text: typeof eventData.text === 'string' ? eventData.text : prev.miniAppMainButton.text,
              color: typeof eventData.color === 'string' ? eventData.color : prev.miniAppMainButton.color,
              textColor:
                typeof eventData.text_color === 'string'
                  ? eventData.text_color
                  : prev.miniAppMainButton.textColor,
            },
          }));
          break;
        }
        case 'web_app_setup_back_button': {
          set({ miniAppBackButtonVisible: Boolean(eventData.is_visible) });
          break;
        }
        case 'web_app_invoke_custom_method': {
          const reqId = eventData.req_id;
          const method = String(eventData.method ?? '');
          const params = (eventData.params ?? {}) as Record<string, unknown>;
          const adapter = getClientAdapter();
          const bot = active.app.bot_username;
          const short = active.app.short_name;
          let result: unknown = null;
          try {
            if (method === 'saveStorageValue') {
              await adapter.setMiniAppCloudStorage(
                bot,
                short,
                String(params.key ?? ''),
                String(params.value ?? ''),
              );
              result = true;
            } else if (method === 'getStorageValues') {
              const keys = Array.isArray(params.keys) ? params.keys.map(String) : undefined;
              result = await adapter.getMiniAppCloudStorage(bot, short, keys);
            } else if (method === 'deleteStorageValues') {
              const keys = Array.isArray(params.keys) ? params.keys.map(String) : [];
              await adapter.deleteMiniAppCloudStorage(bot, short, keys);
              result = true;
            }
            (ev.source as WindowProxy | null)?.postMessage(
              {
                eventType: 'custom_method_invoked',
                eventData: { req_id: reqId, result },
              },
              '*',
            );
          } catch (err) {
            (ev.source as WindowProxy | null)?.postMessage(
              {
                eventType: 'custom_method_invoked',
                eventData: {
                  req_id: reqId,
                  error: err instanceof Error ? err.message : String(err),
                },
              },
              '*',
            );
          }
          break;
        }
        default:
          break;
      }
    };

    window.addEventListener('message', handler);
    const cleanup = () => window.removeEventListener('message', handler);
    miniAppBridgeCleanup = cleanup;
    return cleanup;
  },

  // ==========================================================================
  // Hermes / Fabushi Unified Runtime
  // ==========================================================================

  loadHermesStudio: async () => {
    const [status, sessionsRes, memory, skillsRes, toolsetsRes, cronRes, kanbanRes, approvalsRes, commandsRes] =
      await Promise.all([
        apiJson<Record<string, unknown>>('GET', '/api/v1/fabushi/status').catch(() => ({})),
        apiJson<{ sessions?: HermesSessionSummary[] }>('GET', '/api/v1/fabushi/sessions').catch(
          () => ({ sessions: [] }),
        ),
        apiJson<HermesMemoryState>('GET', '/api/v1/fabushi/memory').catch(() => ({
          memory: { raw: '', entries: [], chars: 0, limit: 2200 as const },
          user: { raw: '', entries: [], chars: 0, limit: 1375 as const },
          soul: '',
          honcho_observations: [],
        })),
        apiJson<{ skills?: HermesSkillDto[] }>('GET', '/api/v1/fabushi/skills').catch(() => ({
          skills: [],
        })),
        apiJson<{ enabled?: string[]; enabled_toolsets?: string[] }>(
          'GET',
          '/api/v1/fabushi/toolsets',
        ).catch(() => ({ enabled: [], enabled_toolsets: [] })),
        apiJson<{ jobs?: HermesCronJobDto[] }>('GET', '/api/v1/fabushi/cron').catch(() => ({
          jobs: [],
        })),
        apiJson<{ boards?: HermesKanbanBoardDto[]; board?: HermesKanbanBoardDto }>(
          'GET',
          '/api/v1/fabushi/kanban',
        ).catch((): { boards?: HermesKanbanBoardDto[]; board?: HermesKanbanBoardDto } => ({
          boards: [],
        })),
        apiJson<{ approvals?: HermesApprovalItem[] }>('GET', '/api/v1/fabushi/approvals').catch(
          () => ({ approvals: [] }),
        ),
        apiJson<{ commands?: HermesCommandDescriptor[] } | HermesCommandDescriptor[]>(
          'GET',
          '/api/v1/fabushi/commands',
        ).catch(() => [] as HermesCommandDescriptor[]),
      ]);

    const studio: HermesStudioSnapshot = {
      status,
      sessions: sessionsRes.sessions ?? [],
      memory,
      skills: skillsRes.skills ?? [],
      enabledToolsets: toolsetsRes.enabled_toolsets ?? toolsetsRes.enabled ?? [],
      cronJobs: cronRes.jobs ?? [],
      kanbanBoards: kanbanRes.boards ?? (kanbanRes.board ? [kanbanRes.board] : []),
    };
    const commands = Array.isArray(commandsRes) ? commandsRes : (commandsRes.commands ?? []);
    set({
      hermesStudio: studio,
      hermesCommands: commands,
      hermesApprovals: approvalsRes.approvals ?? [],
    });
    return studio;
  },

  setActiveStudioTab: (activeStudioTab) => set({ activeStudioTab }),

  updateStudioTab: async (tab, patch) => {
    switch (tab) {
      case 'memory':
        if ('soul_markdown' in patch) {
          await apiJson('PUT', '/api/v1/fabushi/soul', patch);
        } else if ('action' in patch) {
          await apiJson('POST', '/api/v1/fabushi/memory/action', patch);
        } else {
          await apiJson('PUT', '/api/v1/fabushi/memory', patch);
        }
        break;
      case 'skills':
        if (typeof patch.deleteSkillName === 'string') {
          await apiJson(
            'DELETE',
            `/api/v1/fabushi/skills/${encodeURIComponent(patch.deleteSkillName)}`,
          );
        } else if (typeof patch.trustSkillName === 'string') {
          await apiJson(
            'POST',
            `/api/v1/fabushi/skills/${encodeURIComponent(patch.trustSkillName)}/trust`,
            {},
          );
        } else if (typeof patch.toggleSkillName === 'string') {
          await apiJson(
            'PATCH',
            `/api/v1/fabushi/skills/${encodeURIComponent(patch.toggleSkillName)}`,
            { enabled: Boolean(patch.enabled) },
          );
        } else {
          await apiJson('POST', '/api/v1/fabushi/skills', patch);
        }
        break;
      case 'toolsets':
        await apiJson('PUT', '/api/v1/fabushi/toolsets', patch);
        break;
      case 'cron':
        if (typeof patch.triggerJobId === 'string') {
          await apiJson(
            'POST',
            `/api/v1/fabushi/cron/${encodeURIComponent(patch.triggerJobId)}/trigger`,
            {},
          );
        } else if (typeof patch.deleteJobId === 'string') {
          await apiJson('DELETE', `/api/v1/fabushi/cron/${encodeURIComponent(patch.deleteJobId)}`);
        } else {
          await apiJson('POST', '/api/v1/fabushi/cron', patch);
        }
        break;
      case 'kanban':
        if (typeof patch.deleteCardId === 'string') {
          await apiJson(
            'DELETE',
            `/api/v1/fabushi/kanban/cards/${encodeURIComponent(patch.deleteCardId)}`,
          );
        } else if (typeof patch.cardId === 'string') {
          await apiJson(
            'PATCH',
            `/api/v1/fabushi/kanban/cards/${encodeURIComponent(patch.cardId)}`,
            patch,
          );
        } else {
          await apiJson('POST', '/api/v1/fabushi/kanban/cards', patch);
        }
        break;
      case 'sessions':
      default:
        if (typeof patch.deleteSessionId === 'string') {
          await apiJson(
            'DELETE',
            `/api/v1/fabushi/sessions/${encodeURIComponent(patch.deleteSessionId)}`,
          );
        } else {
          await apiJson('POST', '/api/v1/fabushi/sessions', patch);
        }
        break;
    }
    return get().loadHermesStudio();
  },

  createHermesSession: async (title, chatId) => {
    const res = await apiJson<HermesSessionSummary & { session?: HermesSessionSummary }>(
      'POST',
      '/api/v1/fabushi/sessions',
      { title, chat_id: chatId },
    );
    const created = res.session ?? res;
    await get().loadHermesStudio().catch(() => undefined);
    return created;
  },

  branchHermesSession: async (sessionId) => {
    const res = await apiJson<HermesSessionSummary & { session?: HermesSessionSummary }>(
      'POST',
      `/api/v1/fabushi/sessions/${encodeURIComponent(sessionId)}/branch`,
      {},
    );
    const branched = res.session ?? res;
    await get().loadHermesStudio().catch(() => undefined);
    return branched;
  },

  compressHermesSession: async (sessionId) => {
    await apiJson('POST', `/api/v1/fabushi/sessions/${encodeURIComponent(sessionId)}/compress`, {});
    await get().loadHermesStudio().catch(() => undefined);
  },

  toggleHermesSkill: async (name, enabled) => {
    await apiJson('PATCH', `/api/v1/fabushi/skills/${encodeURIComponent(name)}`, { enabled });
    await get().loadHermesStudio().catch(() => undefined);
  },

  decideHermesApproval: async (approvalId, decision) => {
    await apiJson('POST', `/api/v1/fabushi/approvals/${encodeURIComponent(approvalId)}/decide`, {
      decision,
      approved: decision !== 'deny',
    });
    await get().loadHermesStudio().catch(() => undefined);
  },

  clearHermesProviderError: () => set({ hermesProviderError: null }),

  streamPrompt: async (req) => {
    set({
      hermesProviderError: null,
      streamingTurn: {
        turnId: `turn_${Date.now()}`,
        sessionId: req.sessionId ?? '',
        prompt: req.prompt,
        thinkingText: '',
        outputText: '',
        model: req.model ?? '',
        provider: '',
        isStreaming: true,
        toolCalls: [],
        pendingApproval: null,
        error: null,
      },
    });

    const headers = buildAuthHeaders({
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    });

    const res = await fetch(resolveApiUrl('/api/v1/fabushi/turns'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        prompt: req.prompt,
        session_id: req.sessionId,
        chat_id: req.chatId,
        model: req.model,
        stream: true,
      }),
    });

    if (!res.ok) {
      let body: Record<string, unknown> = {};
      try {
        const parsed: unknown = await res.json();
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          body = parsed as Record<string, unknown>;
        }
      } catch {
        // Non-JSON error body
      }
      const errCode = typeof body.error === 'string' ? body.error : `http_${res.status}`;
      const errMsg =
        (typeof body.message === 'string' && body.message.trim()) ||
        (res.status === 503
          ? 'No AI model provider is configured for your account.'
          : `Request failed (HTTP ${res.status})`);
      const isProviderUnconfigured =
        res.status === 503 ||
        errCode === 'provider_not_configured' ||
        Boolean(body.needs_provider_selection);

      set((prev) => ({
        hermesProviderError: isProviderUnconfigured
          ? {
              code: 'PROVIDER_ERROR',
              error: errCode,
              message: errMsg,
              needsProviderSelection: true,
              action:
                typeof body.action === 'string' ? body.action : 'hermes:open_ai_providers',
              httpStatus: res.status,
            }
          : prev.hermesProviderError,
        streamingTurn: prev.streamingTurn
          ? {
              ...prev.streamingTurn,
              isStreaming: false,
              error: errMsg,
            }
          : null,
      }));
      return;
    }

    const applyEvent = (event: HermesStreamEvent) => {
      set((prev) => {
        const cur = prev.streamingTurn;
        if (!cur) return prev;
        switch (event.type) {
          case 'turn_started':
            return {
              streamingTurn: {
                ...cur,
                turnId: event.turn_id,
                sessionId: event.session_id,
                model: event.model,
                provider: event.provider,
              },
            };
          case 'thinking_delta':
            return {
              streamingTurn: { ...cur, thinkingText: cur.thinkingText + event.delta },
            };
          case 'text_delta':
            return {
              streamingTurn: {
                ...cur,
                outputText: cur.outputText + (event.delta ?? event.text ?? ''),
              },
            };
          case 'tool_call_started':
            return {
              streamingTurn: {
                ...cur,
                toolCalls: [
                  ...cur.toolCalls,
                  { id: event.tool_call_id, name: event.tool_name },
                ],
              },
            };
          case 'tool_call_finished':
            return {
              streamingTurn: {
                ...cur,
                toolCalls: cur.toolCalls.map((tc) =>
                  tc.id === event.tool_call_id
                    ? {
                        ...tc,
                        ok: event.ok,
                        outputPreview: event.output_preview,
                        durationMs: event.duration_ms,
                      }
                    : tc,
                ),
              },
            };
          case 'approval_required':
            return {
              streamingTurn: {
                ...cur,
                pendingApproval: {
                  approvalId: event.approval_id,
                  toolName: event.tool_name,
                  command: event.command,
                  reason: event.reason,
                  riskLevel: event.risk_level,
                },
              },
            };
          case 'done':
            return {
              streamingTurn: {
                ...cur,
                outputText: event.response_text || cur.outputText,
                isStreaming: false,
              },
            };
          case 'error':
            return {
              streamingTurn: {
                ...cur,
                isStreaming: false,
                error: event.message,
              },
            };
          default:
            return prev;
        }
      });
    };

    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json') || !res.body) {
      const json = (await res.json()) as {
        events?: HermesStreamEvent[];
        response_text?: string;
        model?: string;
        provider?: string;
      };
      if (Array.isArray(json.events) && json.events.length > 0) {
        for (const ev of json.events) applyEvent(ev);
      } else {
        set((prev) => ({
          streamingTurn: prev.streamingTurn
            ? {
                ...prev.streamingTurn,
                outputText: json.response_text ?? prev.streamingTurn.outputText,
                model: json.model ?? prev.streamingTurn.model,
                provider: json.provider ?? prev.streamingTurn.provider,
                isStreaming: false,
              }
            : null,
        }));
      }
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const jsonPart = line.slice(5).trim();
        if (!jsonPart || jsonPart === '[DONE]') continue;
        try {
          const ev = JSON.parse(jsonPart) as HermesStreamEvent;
          applyEvent(ev);
        } catch {
          // Ignore SSE keepalive frames
        }
      }
    }

    set((prev) => ({
      streamingTurn:
        prev.streamingTurn && prev.streamingTurn.isStreaming
          ? { ...prev.streamingTurn, isStreaming: false }
          : prev.streamingTurn,
    }));
  },

  runSlashCommand: async (command, chatId, sessionId) => {
    const res = await apiJson<{ response_text?: string; responseText?: string }>(
      'POST',
      '/api/v1/fabushi/command',
      { command, chat_id: chatId, session_id: sessionId },
    );
    const responseText = res.response_text ?? res.responseText ?? '';
    set({ lastSlashResponse: responseText });
    await get().loadHermesStudio().catch(() => undefined);
    return responseText;
  },

  // ==========================================================================
  // Fabushi Bots, Coding Agent Bots & Multi-Agent Group Workspace
  // ==========================================================================

  loadFabushiBots: async () => {
    const res = await apiJson<{ bots?: BotRegistryEntry[] } | BotRegistryEntry[]>(
      'GET',
      '/api/v1/fabushi-bots',
    ).catch(() => ({ bots: [] as BotRegistryEntry[] }));
    const bots = Array.isArray(res) ? res : (res.bots ?? []);
    set({ fabushiBots: bots });
    return bots;
  },

  createFabushiBot: async (req) => {
    const res = await apiJson<{
      bot: BotRegistryEntry;
      bot_token?: string;
      botToken?: string;
      chat_id?: number;
      chatId?: number;
    }>('POST', '/api/v1/fabushi-bots', req);
    const created = {
      bot: res.bot,
      botToken: res.bot_token ?? res.botToken ?? '',
      chatId: Number(res.chat_id ?? res.chatId ?? 0),
    };
    set((prev) => ({
      fabushiBots: [
        created.bot,
        ...prev.fabushiBots.filter((b) => b.bot_user_id !== created.bot.bot_user_id),
      ],
      lastCreatedBotToken: created.botToken || prev.lastCreatedBotToken,
    }));
    await useChatStore.getState().bootstrapChats().catch(() => undefined);
    return created;
  },

  deleteFabushiBot: async (botId) => {
    await apiJson('DELETE', `/api/v1/fabushi-bots/${encodeURIComponent(String(botId))}`);
    set((prev) => ({
      fabushiBots: prev.fabushiBots.filter((b) => String(b.bot_user_id) !== String(botId)),
    }));
  },

  loadCodingHosts: async () => {
    const res = await apiJson<{ hosts?: CodingHostSummary[] }>('GET', '/api/v1/coding-agents/hosts')
      .catch(() => ({ hosts: [] as CodingHostSummary[] }));
    const hosts = Array.isArray(res.hosts) ? res.hosts : [];
    set({ codingHosts: hosts });
    return hosts;
  },

  probeCodingAgents: async (req) => {
    const res = await apiJson<CodingAgentsProbeResponse>(
      'POST',
      '/api/v1/coding-agents/probe',
      req ?? {},
    );
    set({ codingProbeResult: res });
    await get().loadCodingHosts().catch(() => undefined);
    return res;
  },

  loadGroupWorkspace: async (chatId) => {
    const res = await apiJson<{ revision?: number; entries?: Record<string, unknown> }>(
      'GET',
      `/api/v1/chats/${chatId}/workspace`,
    );
    const snap: GroupWorkspaceSnapshot = {
      revision: Number(res.revision ?? 0),
      entries:
        res.entries && typeof res.entries === 'object' && !Array.isArray(res.entries)
          ? res.entries
          : {},
    };
    set((prev) => ({
      groupWorkspaces: { ...prev.groupWorkspaces, [chatId]: snap },
    }));
    return snap;
  },

  putGroupWorkspaceKey: async (chatId, key, value) => {
    await apiJson('PUT', `/api/v1/chats/${chatId}/workspace/${encodeURIComponent(key)}`, { value });
    await get().loadGroupWorkspace(chatId).catch(() => undefined);
  },

  loadGroupFloor: async (chatId) => {
    const res = await apiJson<GroupFloorSnapshot>('GET', `/api/v1/chats/${chatId}/floor`);
    const floor: GroupFloorSnapshot = {
      current_speaker: res.current_speaker ?? null,
      queued_count: Number(res.queued_count ?? 0),
      loop_hops: Number(res.loop_hops ?? 0),
    };
    set((prev) => ({
      groupFloors: { ...prev.groupFloors, [chatId]: floor },
    }));
    return floor;
  },

  // ==========================================================================
  // Magpie v1.6 Gateway & Live models.dev Catalog
  // ==========================================================================

  loadMagpie: async () => {
    const [rawState, usage] = await Promise.all([
      apiJson<Record<string, unknown>>('GET', '/api/v1/fabushi/magpie/state'),
      apiJson<MagpieUsageLedgerSummary>('GET', '/api/v1/fabushi/magpie/usage').catch(() => null),
    ]);
    const mapped = mapRawMagpieState(rawState);
    set({
      magpieConfig: mapped.config,
      magpieMeta: mapped.meta,
      magpieSubscriptions: mapped.subscriptions,
      magpieUsage: usage,
      hermesProviderError: mapped.meta.hasConfiguredProvider ? null : get().hermesProviderError,
    });
  },

  updateMagpie: async (patch) => {
    if (patch.upsertProvider && typeof patch.upsertProvider === 'object') {
      await apiJson('POST', '/api/v1/fabushi/magpie/providers', patch.upsertProvider);
      await get().loadMagpie();
      return get().magpieConfig!;
    }
    if (typeof patch.deleteProviderId === 'string') {
      await apiJson(
        'DELETE',
        `/api/v1/fabushi/magpie/providers/${encodeURIComponent(patch.deleteProviderId)}`,
      );
      await get().loadMagpie();
      return get().magpieConfig!;
    }
    const raw = await apiJson<Record<string, unknown>>('PUT', '/api/v1/fabushi/magpie/config', {
      active_provider: patch.activeProvider ?? patch.active_provider,
      active_model: patch.activeModel ?? patch.active_model,
      allow_local_fallback: patch.allowLocalFallback ?? patch.allow_local_fallback,
      routing_strategy: patch.routingStrategy ?? patch.routing_strategy,
      routing_groups: patch.routingGroups ?? patch.routing_groups,
      masking: patch.masking,
    });
    const mapped = mapRawMagpieState(raw);
    set({
      magpieConfig: mapped.config,
      magpieMeta: mapped.meta,
      magpieSubscriptions: mapped.subscriptions,
    });
    return mapped.config;
  },

  loadModelsCatalog: async (refresh = false) => {
    set({ modelsCatalogError: null });
    try {
      const raw = await apiJson<Record<string, unknown>>(
        'GET',
        `/api/v1/fabushi/magpie/models/catalog?refresh=${refresh ? 'true' : 'false'}`,
      );
      const catalog = normalizeModelsCatalogResponse(raw);
      set({ modelsCatalog: catalog, modelsCatalogError: null });
      return catalog;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set({ modelsCatalogError: msg });
      return null;
    }
  },

  syncMagpieSubscriptions: async (subscriptions, autoActivate = true) => {
    await apiJson('POST', '/api/v1/fabushi/magpie/subscriptions/sync', {
      subscriptions,
      auto_activate: autoActivate,
    });
    await get().loadMagpie();
  },

  activateMagpieSubscription: async (subId, model) => {
    await apiJson(
      'POST',
      `/api/v1/fabushi/magpie/subscriptions/${encodeURIComponent(subId)}/activate`,
      model ? { model } : {},
    );
    await get().loadMagpie();
  },

  upsertMagpieGroup: async (group) => {
    const created = await apiJson<MagpieRoutingGroup>(
      'POST',
      '/api/v1/fabushi/magpie/groups',
      group,
    );
    await get().loadMagpie();
    return created;
  },

  deleteMagpieGroup: async (groupId) => {
    await apiJson('DELETE', `/api/v1/fabushi/magpie/groups/${encodeURIComponent(groupId)}`);
    await get().loadMagpie();
  },

  probeMagpieProvider: async (providerId) => {
    return apiJson<{ ok: boolean; latency_ms?: number; models?: string[]; error?: string }>(
      'POST',
      `/api/v1/fabushi/magpie/providers/${encodeURIComponent(providerId)}/probe`,
      {},
    );
  },

  scanMagpieSubscriptions: async () => {
    const res = await apiJson<{ subscriptions?: Array<Record<string, unknown>> }>(
      'POST',
      '/api/v1/fabushi/magpie/subscriptions/scan',
      {},
    );
    const subscriptions = res.subscriptions ?? [];
    set({ magpieSubscriptions: subscriptions });
    return subscriptions;
  },

  importMagpieConfig: async (payload) => {
    await apiJson('POST', '/api/v1/fabushi/magpie/import', payload);
    await get().loadMagpie();
    return get().magpieConfig!;
  },

  previewMask: async (sampleText) => {
    const preview = await apiJson<MagpieMaskingPreviewResult>(
      'POST',
      '/api/v1/fabushi/magpie/masking/preview',
      { text: sampleText },
    );
    set({ maskPreview: preview });
    return preview;
  },

  // ==========================================================================
  // Global Task Center
  // ==========================================================================

  loadTasks: async () => {
    const tasks = await getClientAdapter().listTasks();
    set({ tasks });
    return tasks;
  },

  createTask: async (req) => {
    const created = await getClientAdapter().createTask(req);
    set((prev) => ({ tasks: [created, ...prev.tasks] }));
    return created;
  },

  updateTask: async (taskId, patch) => {
    const updated = await getClientAdapter().updateTask(taskId, patch);
    set((prev) => ({
      tasks: prev.tasks.map((t) => (t.task_id === taskId ? updated : t)),
    }));
    return updated;
  },

  deleteTask: async (taskId) => {
    await getClientAdapter().deleteTask(taskId);
    set((prev) => ({
      tasks: prev.tasks.filter((t) => t.task_id !== taskId),
    }));
  },

  // ==========================================================================
  // MCP Tools Dock & Official OAuth 2.1 MCP
  // ==========================================================================

  loadMcp: async () => {
    const adapter = getClientAdapter();
    const [servers, toolsRes, grantsRes, auditRes] = await Promise.all([
      adapter.listMcpServers().catch(() => [] as McpServerDto[]),
      adapter.listMcpTools().catch(() => ({
        tools: [] as McpToolDto[],
        approvals: [] as McpPendingApprovalDto[],
      })),
      apiJson<{ grants?: OAuthGrantSummary[] }>('GET', '/api/v1/mcp/grants').catch(() => ({
        grants: [] as OAuthGrantSummary[],
      })),
      apiJson<{ entries?: McpAuditEntry[] }>('GET', '/api/v1/mcp/audit?limit=50').catch(() => ({
        entries: [] as McpAuditEntry[],
      })),
    ]);
    set({
      mcpServers: servers,
      mcpTools: toolsRes.tools,
      mcpApprovals: toolsRes.approvals,
      oauthMcpGrants: grantsRes.grants ?? [],
      oauthMcpAudit: auditRes.entries ?? [],
    });
  },

  registerMcpServer: async (req) => {
    const endpoint = (req.endpoint || req.url || req.command || '').trim();
    const res = await apiJson<McpServerDto & { server?: McpServerDto }>(
      'POST',
      '/api/v1/mcp/servers',
      {
        name: req.name.trim(),
        transport: req.transport,
        endpoint,
      },
    );
    const created = res.server ?? res;
    await get().loadMcp();
    return created;
  },

  deleteMcpServer: async (serverId) => {
    await apiJson('DELETE', `/api/v1/mcp/servers/${encodeURIComponent(serverId)}`);
    await get().loadMcp();
  },

  invokeMcpTool: async (req) => {
    const out = await getClientAdapter().invokeMcpTool(req);
    set({ lastMcpOutput: out });
    await get().loadMcp().catch(() => undefined);
    return out;
  },

  decideMcpApproval: async (requestId, allow) => {
    await getClientAdapter().approveMcpToolCall(requestId, allow);
    await get().loadMcp();
  },

  revokeOAuthMcpGrant: async (familyId) => {
    await apiJson('DELETE', `/api/v1/mcp/grants/${encodeURIComponent(familyId)}`);
    await get().loadMcp();
  },

  // ==========================================================================
  // Full-Duplex Talk Mode
  // ==========================================================================

  startTalk: async () => {
    set({ talkProviderError: null });
    const talkSession = await getClientAdapter().startTalkSession();
    set({ talkSession });
    return talkSession;
  },

  sendTalkUtterance: async (audioOrTranscript) => {
    set({ talkProviderError: null });
    try {
      const payload =
        typeof audioOrTranscript === 'string'
          ? { transcript: audioOrTranscript }
          : audioOrTranscript;
      const talkSession = await getClientAdapter().sendTalkAudio(payload);
      set({ talkSession });
      return talkSession;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('503') || msg.includes('talk_pipeline_unconfigured') || msg.includes('provider')) {
        set({
          talkProviderError: {
            code: 'PROVIDER_ERROR',
            error: 'talk_pipeline_unconfigured',
            message: msg,
            needsProviderSelection: true,
            action: 'hermes:open_ai_providers',
            httpStatus: 503,
          },
        });
      }
      throw err;
    }
  },

  sendTalkAudioBlob: async (audioBlob) => {
    set({ talkProviderError: null });
    const res = await fetch(resolveApiUrl('/api/v1/talk/audio'), {
      method: 'POST',
      headers: buildAuthHeaders({
        'Content-Type': audioBlob.type || 'audio/webm',
      }),
      body: audioBlob,
    });
    if (!res.ok) {
      let body: Record<string, unknown> = {};
      try {
        const parsed: unknown = await res.json();
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          body = parsed as Record<string, unknown>;
        }
      } catch {
        // Non-JSON error body
      }
      const errCode = typeof body.error === 'string' ? body.error : `http_${res.status}`;
      const errMsg =
        (typeof body.message === 'string' && body.message.trim()) ||
        'No configured speech-to-text / AI provider pipeline for Talk Mode.';
      if (res.status === 503 || errCode === 'talk_pipeline_unconfigured') {
        set({
          talkProviderError: {
            code: 'PROVIDER_ERROR',
            error: errCode,
            message: errMsg,
            needsProviderSelection: true,
            action:
              typeof body.action === 'string' ? body.action : 'hermes:open_ai_providers',
            httpStatus: res.status,
          },
        });
        return null;
      }
      throw new ApiRequestError(res.status, errCode, errMsg, body);
    }
    const talkSession = (await res.json()) as TalkSessionDto;
    set({ talkSession });
    return talkSession;
  },

  clearTalkProviderError: () => set({ talkProviderError: null }),

  bargeInTalk: async () => {
    const talkSession = await getClientAdapter().bargeInTalkSession();
    set({ talkSession });
    return talkSession;
  },

  stopTalk: async () => {
    const talkSession = await getClientAdapter().stopTalkSession();
    set({ talkSession });
    return talkSession;
  },

  // ==========================================================================
  // UU-Parity Remote Assist, Computers & Un-Clamped Emergency Kill Switch
  // ==========================================================================

  loadComputers: async () => {
    const adapter = getClientAdapter();
    const [compRes, tailnet] = await Promise.all([
      adapter.listComputers().catch(() => ({
        computers: [] as ComputerNodeDto[],
        pendingApprovals: [] as PendingComputerCommandDto[],
      })),
      adapter.getTailnetStatus().catch(() => null),
    ]);
    set({
      computers: compRes.computers,
      computerApprovals: compRes.pendingApprovals,
      tailnet,
    });
  },

  loadRemoteAssist: async () => {
    const [assistInfo, sessionsRes] = await Promise.all([
      apiJson<RemoteAssistConfigDto>('GET', '/api/v1/remote/assist/info').catch(() => null),
      apiJson<{ sessions?: RemoteSessionDto[] }>('GET', '/api/v1/remote/sessions').catch(() => ({
        sessions: [] as RemoteSessionDto[],
      })),
    ]);
    set({
      remoteAssistInfo: assistInfo,
      remoteSessions: sessionsRes.sessions ?? [],
    });
  },

  resetRemoteAssistCode: async () => {
    const info = await apiJson<RemoteAssistConfigDto>('POST', '/api/v1/remote/assist/reset-code', {});
    set({ remoteAssistInfo: info });
    return info;
  },

  setRemoteAssistCode: async (code) => {
    const info = await apiJson<RemoteAssistConfigDto>('POST', '/api/v1/remote/assist/set-code', {
      code,
    });
    set({ remoteAssistInfo: info });
    return info;
  },

  setAllowRemoteAssist: async (allowAssist) => {
    const info = await apiJson<RemoteAssistConfigDto>('POST', '/api/v1/remote/assist/allow', {
      allow_assist: allowAssist,
    });
    set({ remoteAssistInfo: info });
    if (!allowAssist) {
      await get().loadRemoteAssist().catch(() => undefined);
    }
    return info;
  },

  startRemoteAssist: async (req) => {
    const res = await apiJson<AssistStartResponse>('POST', '/api/v1/remote/assist/start', req);
    await get().loadRemoteAssist().catch(() => undefined);
    return res;
  },

  disconnectRemoteSession: async (sessionId) => {
    await apiJson('POST', '/api/v1/remote/sessions/disconnect', { session_id: sessionId });
    await get().loadRemoteAssist().catch(() => undefined);
  },

  loadComputerFrame: async (nodeId) => {
    const res = await apiJson<{ frame_data_url?: string | null; frame?: string | null }>(
      'GET',
      `/api/v1/computers/${encodeURIComponent(nodeId)}/frame`,
    ).catch((): { frame_data_url?: string | null; frame?: string | null } => ({
      frame_data_url: null,
      frame: null,
    }));
    const frameUrl =
      typeof res.frame_data_url === 'string' && res.frame_data_url.trim()
        ? res.frame_data_url
        : typeof res.frame === 'string' && res.frame.trim()
          ? res.frame
          : null;
    set((prev) => ({
      computerFrames: { ...prev.computerFrames, [nodeId]: frameUrl },
    }));
    return frameUrl;
  },

  createCloudComputer: async (req) => {
    const created = await apiJson<ComputerNodeDto & { computer?: ComputerNodeDto }>(
      'POST',
      '/api/v1/computers/cloud',
      req,
    );
    await get().loadComputers();
    return created.computer ?? created;
  },

  testComputerConnection: async (nodeId) => {
    return apiJson<{ ok: boolean; latency_ms?: number; message?: string }>(
      'POST',
      `/api/v1/computers/${encodeURIComponent(nodeId)}/test`,
      {},
    );
  },

  deleteComputer: async (nodeId) => {
    await apiJson('DELETE', `/api/v1/computers/${encodeURIComponent(nodeId)}`);
    await get().loadComputers();
  },

  runComputerOp: async (nodeId, operation, callerLabel) => {
    const res = await getClientAdapter().executeComputerOp(nodeId, operation, callerLabel);
    if (typeof res.frame_data_url === 'string' && res.frame_data_url) {
      set((prev) => ({
        computerFrames: { ...prev.computerFrames, [nodeId]: String(res.frame_data_url) },
      }));
    }
    await get().loadComputers().catch(() => undefined);
    return res;
  },

  decideComputerApproval: async (commandId, approve) => {
    await getClientAdapter().approveComputerCommand(commandId, approve);
    await get().loadComputers();
  },

  setComputerPolicy: async (nodeId, policy) => {
    const updated = await getClientAdapter().updateComputerPolicy(nodeId, policy);
    set((prev) => ({
      computers: prev.computers.map((c) => (c.node_id === nodeId ? updated : c)),
    }));
  },

  emergencyTakeover: async (nodeId) => {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const localRevoke = browserControlAgent.emergencyTakeover('User emergency takeover');
    const killRes = await apiJson<{
      disconnected_count?: number;
      kill_switch?: boolean;
      latency_ms?: number;
    }>('POST', '/api/v1/remote/sessions/disconnect-all', {});

    let newGeneration = localRevoke.controlGeneration;
    if (nodeId) {
      const takeoverRes = await apiJson<{ new_generation?: number; newGeneration?: number }>(
        'POST',
        `/api/v1/computers/${encodeURIComponent(nodeId)}/takeover`,
        {},
      ).catch(() => null);
      if (takeoverRes) {
        newGeneration = Number(
          takeoverRes.new_generation ?? takeoverRes.newGeneration ?? newGeneration,
        );
      }
    }

    // STRICTLY UN-CLAMPED wall-clock round-trip latency!
    const elapsedMs = Number(
      ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0).toFixed(2),
    );

    set((prev) => ({
      lastTakeoverMs: elapsedMs,
      lastKillSwitchLatencyMs: elapsedMs,
      remoteSessions: [],
      localBridgeState: browserControlAgent.getState(),
      computers: prev.computers.map((c) =>
        !nodeId || c.node_id === nodeId
          ? {
              ...c,
              lease_state: 'human_takeover',
              lease_generation: c.lease_generation + 1,
            }
          : c,
      ),
    }));

    await Promise.allSettled([get().loadComputers(), get().loadRemoteAssist()]);
    return {
      latencyMs: elapsedMs,
      newGeneration,
      disconnectedCount: Number(killRes.disconnected_count ?? 0),
    };
  },

  // ==========================================================================
  // Wallet (Verified Payment/Redeem Gated — Zero Self-Minting)
  // ==========================================================================

  loadWallet: async () => {
    const wallet = await getClientAdapter().getWalletState();
    set({ wallet });
    return wallet;
  },

  redeemStars: async (req) => {
    const wallet = await apiJson<WalletStateDto>('POST', '/api/v1/wallet/topup', {
      redeem_code: req.redeem_code?.trim() || undefined,
      order_id: req.order_id?.trim() || undefined,
    });
    set({ wallet });
    return wallet;
  },

  sendStarGift: async (req) => {
    const wallet = await getClientAdapter().sendStarGift(req);
    set({ wallet });
    if (req.chatId) {
      await useChatStore.getState().selectChat(req.chatId).catch(() => undefined);
    }
    return wallet;
  },

  // ==========================================================================
  // Built-in Browser Workspace, Script Distillation & Automation App Store
  // ==========================================================================

  loadBrowserControl: async () => {
    // STRICT ZERO-FAKE INVARIANT: Do NOT silently auto-register this tab on workspace load!
    const [targetsRes, sessionsRes, logsRes, modeRes, manifestRes] = await Promise.all([
      apiJson<{ targets?: BrowserTargetDescriptor[]; control_generation?: number }>(
        'GET',
        '/api/v1/browser/targets',
      ).catch(() => ({ targets: [] as BrowserTargetDescriptor[], control_generation: 1 })),
      apiJson<{ sessions?: HeadlessBrowserSessionDto[] }>(
        'GET',
        '/api/v1/browser/headless/sessions',
      ).catch(() => ({ sessions: [] as HeadlessBrowserSessionDto[] })),
      apiJson<{ entries?: BrowserAuditLogEntry[] }>('GET', '/api/v1/browser/audit?limit=50').catch(
        () => ({ entries: [] as BrowserAuditLogEntry[] }),
      ),
      apiJson<{ control_mode?: BrowserControlMode }>('GET', '/api/v1/browser/control-mode').catch(
        () => ({ control_mode: { mode: 'idle' } as BrowserControlMode }),
      ),
      apiJson<{ chromium_cdp_available?: boolean }>('GET', '/api/v1/mcp/manifest').catch(() => ({
        chromium_cdp_available: undefined,
      })),
    ]);

    set({
      browserTargets: targetsRes.targets ?? [],
      headlessSessions: sessionsRes.sessions ?? [],
      browserAuditLogs: logsRes.entries ?? [],
      browserControlMode: modeRes.control_mode ?? { mode: 'idle' },
      chromiumAvailable:
        typeof manifestRes.chromium_cdp_available === 'boolean'
          ? manifestRes.chromium_cdp_available
          : get().chromiumAvailable,
      localBridgeState: browserControlAgent.getState(),
    });
  },

  registerCurrentTabForControl: async () => {
    const registered = await getClientAdapter().registerBrowserTarget(
      browserControlAgent.buildRegisterPayload(),
    );
    await get().loadBrowserControl().catch(() => undefined);
    return registered;
  },

  createPairingTicket: async (label = 'Desktop Controller', ttlSecs = 300) => {
    const raw = await apiJson<
      DesktopPairingTicketDto & { pairing_code?: string; code?: string; control_token?: string }
    >('POST', '/api/v1/browser/pair/create', {
      label,
      ttl_secs: ttlSecs,
    });
    const pairingTicket: DesktopPairingTicketDto = {
      ...raw,
      pair_code: raw.pair_code || raw.pairing_code || raw.code || '',
      desktop_token: raw.desktop_token || raw.control_token || '',
    };
    set({ pairingTicket });
    return pairingTicket;
  },

  claimPairingTicket: async (pairCode, controllerLabel) => {
    const raw = await apiJson<
      DesktopPairingTicketDto & { pairing_code?: string; control_token?: string }
    >('POST', '/api/v1/browser/pair/claim', {
      pair_code: pairCode,
      pairing_code: pairCode,
      code: pairCode,
      controller_label: controllerLabel,
    });
    const pairingTicket: DesktopPairingTicketDto = {
      ...raw,
      pair_code: raw.pair_code || raw.pairing_code || pairCode,
      desktop_token: raw.desktop_token || raw.control_token || '',
    };
    set({ pairingTicket });
    return pairingTicket;
  },

  setAllowDesktopControl: (allowed) => {
    browserControlAgent.setAllowDesktopControl(allowed);
    set({ localBridgeState: browserControlAgent.getState() });
    if (allowed) {
      void get().registerCurrentTabForControl().catch(() => undefined);
    } else {
      void getClientAdapter()
        .reportBrowserState(browserControlAgent.buildStateReportPayload())
        .catch(() => undefined);
    }
  },

  runLocalBrowserCommand: async (cmd) => {
    const res = await browserControlAgent.executeCommand(cmd, 'ui');
    set({ localBridgeState: browserControlAgent.getState() });
    return res;
  },

  runRemoteBrowserCommand: async (req) => {
    const res = await getClientAdapter().sendBrowserCommand(req);
    await get().loadBrowserControl().catch(() => undefined);
    return res;
  },

  revokeBrowserControl: async (targetId) => {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const local = browserControlAgent.emergencyTakeover('User revoked desktop browser control');
    const remote = await apiJson<BrowserControlRevokeResponse>('POST', '/api/v1/browser/revoke', {
      target_id: targetId,
      revoke_tokens: true,
    });
    // STRICTLY UN-CLAMPED wall-clock HTTP round-trip latency!
    const elapsedMs = Number(
      ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0).toFixed(2),
    );
    set({
      lastBrowserRevokeLatencyMs: elapsedMs,
      localBridgeState: browserControlAgent.getState(),
      browserControlMode: { mode: 'user_takeover', paused_at_step: 0 },
    });
    await get().loadBrowserControl().catch(() => undefined);
    return {
      elapsedMs,
      controlGeneration: remote.control_generation ?? local.controlGeneration,
    };
  },

  setBrowserControlModeAction: async (req) => {
    const res = await apiJson<{ control_mode: BrowserControlMode }>(
      'POST',
      '/api/v1/browser/control-mode',
      req,
    );
    const mode = res.control_mode ?? { mode: 'idle' };
    set({ browserControlMode: mode });
    return mode;
  },

  openHeadlessSession: async (url, preferFallback) => {
    const res = await apiJson<{ session: HeadlessBrowserSessionDto; snapshot: BrowserSnapshotDto }>(
      'POST',
      '/api/v1/browser/headless/open',
      {
        url: url?.trim() || 'about:blank',
        viewport: { width: 1280, height: 800 },
        prefer_fallback: preferFallback,
      },
    );
    set((prev) => ({
      headlessSessions: [
        res.session,
        ...prev.headlessSessions.filter((s) => s.session_id !== res.session.session_id),
      ],
      headlessSnapshots: {
        ...prev.headlessSnapshots,
        [res.session.session_id]: res.snapshot,
      },
    }));
    if (url?.trim()) {
      get().recordBrowserAction({ kind: 'navigate', url: url.trim() }, url.trim());
    }
    return res.session;
  },

  runHeadlessAction: async (sessionId, req) => {
    const res = await getClientAdapter().executeHeadlessAction(sessionId, req);
    if (res.snapshot) {
      set((prev) => ({
        headlessSnapshots: {
          ...prev.headlessSnapshots,
          [sessionId]: res.snapshot!,
        },
      }));
    }
    if (res.screenshot_data_url) {
      set((prev) => ({
        headlessScreenshots: {
          ...prev.headlessScreenshots,
          [sessionId]: res.screenshot_data_url!,
        },
      }));
    }
    const pageUrl = res.snapshot?.url;
    if (req.action === 'click' && (req.selector || req.ref)) {
      get().recordBrowserAction(
        { kind: 'click', locator: { css_selector: req.selector || req.ref } },
        pageUrl,
      );
    } else if (req.action === 'fill' && (req.selector || req.ref)) {
      get().recordBrowserAction(
        {
          kind: 'fill',
          locator: { css_selector: req.selector || req.ref },
          value: req.text ?? '',
        },
        pageUrl,
      );
    } else if (req.action === 'navigate' && req.url) {
      get().recordBrowserAction({ kind: 'navigate', url: req.url }, req.url);
    }
    return res;
  },

  captureHeadlessScreenshot: async (sessionId) => {
    const res = await getClientAdapter().captureHeadlessScreenshot(sessionId);
    set((prev) => ({
      headlessScreenshots: {
        ...prev.headlessScreenshots,
        [sessionId]: res.screenshot_data_url,
      },
    }));
    return res.screenshot_data_url;
  },

  closeHeadlessSession: async (sessionId) => {
    await getClientAdapter().closeHeadlessSession(sessionId);
    set((prev) => ({
      headlessSessions: prev.headlessSessions.filter((s) => s.session_id !== sessionId),
    }));
  },

  recordBrowserAction: (action, pageUrl) => {
    set((prev) => ({
      recordedBrowserTrace: [
        ...prev.recordedBrowserTrace,
        {
          seq: prev.recordedBrowserTrace.length + 1,
          timestamp_ms: Date.now(),
          page_url: pageUrl ?? null,
          action,
        },
      ],
    }));
  },

  clearRecordedBrowserTrace: () =>
    set({ recordedBrowserTrace: [], distilledManifest: null, lastScriptReplayReport: null }),

  distillBrowserScript: async (metadata, traceOverride) => {
    const trace: BrowserActionTrace = traceOverride ?? {
      trace_id: `trace_${Date.now().toString(36)}`,
      session_id: get().headlessSessions[0]?.session_id ?? 'manual',
      started_at_ms: get().recordedBrowserTrace[0]?.timestamp_ms ?? Date.now(),
      completed_at_ms: Date.now(),
      initial_url: get().recordedBrowserTrace[0]?.page_url ?? null,
      actions: get().recordedBrowserTrace,
    };
    const res = await apiJson<{ manifest?: AutomationScriptApp; app?: AutomationScriptApp }>(
      'POST',
      '/api/v1/browser/scripts/distill',
      { trace, metadata },
    );
    const manifest = res.manifest ?? res.app;
    if (!manifest) {
      throw new Error('Server returned empty distilled script manifest');
    }
    set({ distilledManifest: manifest });
    return manifest;
  },

  replayBrowserScript: async (manifest, params = {}, sessionId) => {
    const res = await apiJson<ScriptReplayReport & { report?: ScriptReplayReport }>(
      'POST',
      '/api/v1/browser/scripts/replay',
      {
        manifest,
        params,
        session_id: sessionId,
      },
    );
    const report = res.report ?? res;
    set({ lastScriptReplayReport: report });
    return report;
  },

  loadAutomationApps: async (query) => {
    const qs = new URLSearchParams();
    if (query?.q) qs.set('q', query.q);
    if (query?.category && query.category !== 'all') qs.set('category', query.category);
    if (query?.domain) qs.set('domain', query.domain);
    if (query?.limit !== undefined) qs.set('limit', String(query.limit));
    if (query?.offset !== undefined) qs.set('offset', String(query.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    const res = await apiJson<{ apps?: AutomationAppSummary[] }>(
      'GET',
      `/api/v1/automation-apps${suffix}`,
    );
    const apps = res.apps ?? [];
    set({ automationApps: apps });
    return apps;
  },

  loadInstalledAutomationApps: async () => {
    const res = await apiJson<{ apps?: InstalledAutomationApp[] }>(
      'GET',
      '/api/v1/automation-apps/installed',
    );
    const apps = res.apps ?? [];
    set({ installedAutomationApps: apps });
    return apps;
  },

  publishAutomationApp: async (req) => {
    const detail = await apiJson<AutomationAppDetail>('POST', '/api/v1/automation-apps', req);
    await Promise.allSettled([get().loadAutomationApps(), get().loadInstalledAutomationApps()]);
    return detail;
  },

  installAutomationApp: async (appId) => {
    await apiJson('POST', `/api/v1/automation-apps/${encodeURIComponent(appId)}/install`, {});
    await Promise.allSettled([get().loadAutomationApps(), get().loadInstalledAutomationApps()]);
  },

  uninstallAutomationApp: async (appId) => {
    await apiJson('DELETE', `/api/v1/automation-apps/${encodeURIComponent(appId)}/install`);
    await Promise.allSettled([get().loadAutomationApps(), get().loadInstalledAutomationApps()]);
  },

  recordAutomationRun: async (appId, req) => {
    const res = await apiJson<RecordAutomationRunResponse>(
      'POST',
      `/api/v1/automation-apps/${encodeURIComponent(appId)}/runs`,
      req,
    );
    await Promise.allSettled([get().loadAutomationApps(), get().loadInstalledAutomationApps()]);
    return res;
  },

  invokeMcpRpc: (req) => getClientAdapter().invokeMcpRpc(req),

  // ==========================================================================
  // Split-Key V2 Vault, X25519 Device Trust Ring & Account Passkeys
  // ==========================================================================

  loadVaultState: async () => {
    const [envRes, itemsRes, pendingRes] = await Promise.all([
      apiJson<{ envelope: UserVaultKeyEnvelopeDto | null }>(
        'GET',
        '/api/v1/user-vault/envelope',
      ).catch(() => ({ envelope: null })),
      apiJson<{ latest_revision?: number; items?: UserVaultItemDto[] }>(
        'GET',
        '/api/v1/user-vault/items?since_revision=0',
      ).catch(() => ({ latest_revision: 0, items: [] as UserVaultItemDto[] })),
      apiJson<{ items?: PendingDeviceSyncItem[] }>(
        'GET',
        '/api/v1/user-vault/device-sync/pending',
      ).catch(() => ({ items: [] as PendingDeviceSyncItem[] })),
    ]);

    set({
      vaultEnvelope: envRes.envelope ?? null,
      vaultItems: itemsRes.items ?? [],
      vaultLatestRevision: Number(itemsRes.latest_revision ?? 0),
      pendingDeviceSyncs: pendingRes.items ?? [],
    });
  },

  saveVaultEnvelope: async (envelope) => {
    const res = await apiJson<{ envelope: UserVaultKeyEnvelopeDto | null }>(
      'PUT',
      '/api/v1/user-vault/envelope',
      envelope,
    );
    set({ vaultEnvelope: res.envelope ?? envelope });
    return res.envelope ?? envelope;
  },

  upsertVaultItem: async (category, itemKey, req) => {
    const res = await apiJson<UpsertUserVaultItemResponse>(
      'PUT',
      `/api/v1/user-vault/items/${encodeURIComponent(category)}/${encodeURIComponent(itemKey)}`,
      req,
    );
    await get().loadVaultState().catch(() => undefined);
    return res;
  },

  deleteVaultItem: async (category, itemKey, expectedRevision) => {
    const qs =
      expectedRevision !== undefined
        ? `?expected_revision=${encodeURIComponent(String(expectedRevision))}`
        : '';
    const res = await apiJson<UpsertUserVaultItemResponse>(
      'DELETE',
      `/api/v1/user-vault/items/${encodeURIComponent(category)}/${encodeURIComponent(itemKey)}${qs}`,
    );
    await get().loadVaultState().catch(() => undefined);
    return res;
  },

  requestDeviceSync: async (req) => {
    const res = await apiJson<DeviceSyncRequestResponse>(
      'POST',
      '/api/v1/user-vault/device-sync/request',
      req,
    );
    set({ activeDeviceSyncRequest: res });
    await get().loadVaultState().catch(() => undefined);
    return res;
  },

  approveDeviceSync: async (requestId, req) => {
    const res = await apiJson<DeviceSyncActionResponse>(
      'POST',
      `/api/v1/user-vault/device-sync/${encodeURIComponent(requestId)}/approve`,
      req,
    );
    await get().loadVaultState().catch(() => undefined);
    return res;
  },

  denyDeviceSync: async (requestId) => {
    const res = await apiJson<DeviceSyncActionResponse>(
      'POST',
      `/api/v1/user-vault/device-sync/${encodeURIComponent(requestId)}/deny`,
      {},
    );
    await get().loadVaultState().catch(() => undefined);
    return res;
  },

  pollDeviceSyncStatus: async (requestId) => {
    return apiJson<DeviceSyncStatusResponse>(
      'GET',
      `/api/v1/user-vault/device-sync/${encodeURIComponent(requestId)}/status`,
    );
  },

  loadAccountPasskeys: async () => {
    const list = await useAuthStore.getState().listPasskeys();
    set({ accountPasskeys: list });
    return list;
  },

  deleteAccountPasskey: async (credId) => {
    await useAuthStore.getState().deletePasskey(credId);
    set((prev) => ({
      accountPasskeys: prev.accountPasskeys.filter((p) => p.cred_id !== credId),
    }));
  },
}));

browserControlAgent.subscribe(() => {
  useAiWorkspaceStore.setState({
    localBridgeState: browserControlAgent.getState(),
  });
});
