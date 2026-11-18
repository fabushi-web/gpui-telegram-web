import { create } from 'zustand';
import type {
  BotRegistryEntry,
  BrowserAuditLogEntry,
  BrowserCommandRequest,
  BrowserCommandResult,
  BrowserSnapshotDto,
  BrowserTargetDescriptor,
  ComputerNodeDto,
  ComputerRunPolicy,
  DesktopPairingTicketDto,
  HeadlessBrowserSessionDto,
  HermesCommandDescriptor,
  HermesStreamEvent,
  HermesStudioSnapshot,
  HermesStudioTab,
  MagpieConfigSnapshot,
  MagpieMaskingPreviewResult,
  MagpieUsageLedgerSummary,
  McpJsonRpcRequest,
  McpJsonRpcResponse,
  McpPendingApprovalDto,
  McpServerDto,
  McpToolDto,
  MiniAppEntry,
  MiniAppLaunchContext,
  PendingComputerCommandDto,
  TailnetStatusDto,
  TalkSessionDto,
  TaskItemDto,
  WalletStateDto,
} from '@gpui-telegram/protocol';
import { getClientAdapter } from '../adapters';
import {
  browserControlAgent,
  type BrowserCommandInput,
  type LocalBrowserAuditEntry,
} from '../services/browserControlAgent';
import { useChatStore } from './useChatStore';
import { useUiStore } from './useUiStore';

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

  // Hermes 6-Tab Studio
  hermesStudio: HermesStudioSnapshot | null;
  activeStudioTab: HermesStudioTab;
  hermesCommands: HermesCommandDescriptor[];
  streamingTurn: StreamingHermesTurn | null;
  lastSlashResponse: string | null;

  // Magpie LLM Gateway
  magpieConfig: MagpieConfigSnapshot | null;
  magpieUsage: MagpieUsageLedgerSummary | null;
  maskPreview: MagpieMaskingPreviewResult | null;

  // Tasks & Cron
  tasks: TaskItemDto[];

  // MCP Tools Dock
  mcpServers: McpServerDto[];
  mcpTools: McpToolDto[];
  mcpApprovals: McpPendingApprovalDto[];
  lastMcpOutput: Record<string, unknown> | null;

  // Talk Mode
  talkSession: TalkSessionDto | null;

  // Remote Computers & Tailnet
  computers: ComputerNodeDto[];
  computerApprovals: PendingComputerCommandDto[];
  tailnet: TailnetStatusDto | null;
  lastTakeoverMs: number | null;

  // Wallet
  wallet: WalletStateDto | null;

  // F17 Browser Control & Headless Sessions
  pairingTicket: DesktopPairingTicketDto | null;
  browserTargets: BrowserTargetDescriptor[];
  headlessSessions: HeadlessBrowserSessionDto[];
  headlessSnapshots: Record<string, BrowserSnapshotDto>;
  headlessScreenshots: Record<string, string>;
  browserAuditLogs: BrowserAuditLogEntry[];
  localBridgeState: {
    targetId: string;
    allowDesktopControl: boolean;
    controlGeneration: number;
    isRemoteActive: boolean;
    auditLogs: LocalBrowserAuditEntry[];
  };

  // Actions
  bootstrapWorkspaces: () => Promise<void>;
  loadBots: () => Promise<BotRegistryEntry[]>;
  createBot: (req: { displayName: string; username: string; description?: string }) => Promise<{ bot: BotRegistryEntry; botToken: string; chatId: number }>;

  loadMiniApps: (query?: string) => Promise<MiniAppEntry[]>;
  launchMiniApp: (botUsername: string, shortName: string, chatId?: number) => Promise<MiniAppLaunchContext>;
  setMiniAppIframeRef: (iframe: HTMLIFrameElement | null) => void;
  clickMiniAppMainButton: () => void;
  clickMiniAppBackButton: () => void;
  closeMiniApp: () => void;
  bindMiniAppPostMessageBridge: () => () => void;

  loadHermesStudio: () => Promise<HermesStudioSnapshot>;
  setActiveStudioTab: (tab: HermesStudioTab) => void;
  updateStudioTab: (tab: HermesStudioTab, patch: Record<string, unknown>) => Promise<HermesStudioSnapshot>;
  streamPrompt: (req: { prompt: string; sessionId?: string; chatId?: number; model?: string }) => Promise<void>;
  runSlashCommand: (command: string, chatId?: number, sessionId?: string) => Promise<string>;

  loadMagpie: () => Promise<void>;
  updateMagpie: (patch: Record<string, unknown>) => Promise<MagpieConfigSnapshot>;
  previewMask: (sampleText: string) => Promise<MagpieMaskingPreviewResult>;

  loadTasks: () => Promise<TaskItemDto[]>;
  createTask: (req: { title: string; description?: string; cronExpr?: string; chatId?: number }) => Promise<TaskItemDto>;
  updateTask: (taskId: string, patch: Partial<{ state: TaskItemDto['state']; title: string; cronExpr: string }>) => Promise<TaskItemDto>;
  deleteTask: (taskId: string) => Promise<void>;

  loadMcp: () => Promise<void>;
  invokeMcpTool: (req: { toolId?: string; toolName?: string; arguments?: Record<string, unknown>; forceApprove?: boolean }) => Promise<Record<string, unknown>>;
  decideMcpApproval: (requestId: string, allow: boolean) => Promise<void>;

  startTalk: () => Promise<TalkSessionDto>;
  sendTalkUtterance: (audioOrTranscript: Uint8Array | string) => Promise<TalkSessionDto>;
  bargeInTalk: () => Promise<TalkSessionDto>;
  stopTalk: () => Promise<TalkSessionDto>;

  loadComputers: () => Promise<void>;
  runComputerOp: (nodeId: string, operation: Record<string, unknown>, callerLabel?: string) => Promise<Record<string, unknown>>;
  decideComputerApproval: (commandId: string, approve: boolean) => Promise<void>;
  setComputerPolicy: (nodeId: string, policy: ComputerRunPolicy) => Promise<void>;
  emergencyTakeover: (nodeId?: string) => Promise<{ latencyMs: number; newGeneration: number }>;

  loadWallet: () => Promise<WalletStateDto>;
  topUpStars: (amount: number) => Promise<WalletStateDto>;
  sendStarGift: (req: { toUserId: number; chatId?: number; amountStars: number; giftId?: string; message?: string }) => Promise<WalletStateDto>;

  loadBrowserControl: () => Promise<void>;
  createPairingTicket: (label?: string, ttlSecs?: number) => Promise<DesktopPairingTicketDto>;
  claimPairingTicket: (pairCode: string, controllerLabel?: string) => Promise<DesktopPairingTicketDto>;
  setAllowDesktopControl: (allowed: boolean) => void;
  runLocalBrowserCommand: (cmd: BrowserCommandInput) => Promise<BrowserCommandResult>;
  runRemoteBrowserCommand: (req: BrowserCommandRequest) => Promise<BrowserCommandResult>;
  revokeBrowserControl: (targetId?: string) => Promise<{ elapsedMs: number; controlGeneration: number }>;
  openHeadlessSession: (url?: string, preferFallback?: boolean) => Promise<HeadlessBrowserSessionDto>;
  runHeadlessAction: (sessionId: string, req: Omit<BrowserCommandRequest, 'target_id'>) => Promise<BrowserCommandResult>;
  captureHeadlessScreenshot: (sessionId: string) => Promise<string>;
  closeHeadlessSession: (sessionId: string) => Promise<void>;
  invokeMcpRpc: (req: McpJsonRpcRequest) => Promise<McpJsonRpcResponse>;
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
  color: '#3390EC',
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
  streamingTurn: null,
  lastSlashResponse: null,

  magpieConfig: null,
  magpieUsage: null,
  maskPreview: null,

  tasks: [],

  mcpServers: [],
  mcpTools: [],
  mcpApprovals: [],
  lastMcpOutput: null,

  talkSession: null,

  computers: [],
  computerApprovals: [],
  tailnet: null,
  lastTakeoverMs: null,

  wallet: null,

  pairingTicket: null,
  browserTargets: [],
  headlessSessions: [],
  headlessSnapshots: {},
  headlessScreenshots: {},
  browserAuditLogs: [],
  localBridgeState: browserControlAgent.getState(),

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

  loadHermesStudio: async () => {
    const adapter = getClientAdapter();
    const [studio, commands] = await Promise.all([
      adapter.getHermesStudioState(),
      adapter.listHermesCommands().catch(() => [] as HermesCommandDescriptor[]),
    ]);
    set({ hermesStudio: studio, hermesCommands: commands });
    return studio;
  },

  setActiveStudioTab: (activeStudioTab) => set({ activeStudioTab }),

  updateStudioTab: async (tab, patch) => {
    const studio = await getClientAdapter().updateHermesStudioState(tab, patch);
    set({ hermesStudio: studio });
    return studio;
  },

  streamPrompt: async (req) => {
    set({
      streamingTurn: {
        turnId: `turn_${Date.now()}`,
        sessionId: req.sessionId ?? 'default',
        prompt: req.prompt,
        thinkingText: '',
        outputText: '',
        model: req.model ?? 'hermes-3',
        provider: 'magpie',
        isStreaming: true,
        toolCalls: [],
        pendingApproval: null,
        error: null,
      },
    });

    await getClientAdapter().streamHermesTurn(req, (event: HermesStreamEvent) => {
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
    });
  },

  runSlashCommand: async (command, chatId, sessionId) => {
    const res = await getClientAdapter().executeHermesSlashCommand(command, chatId, sessionId);
    set({ lastSlashResponse: res.responseText });
    await get().loadHermesStudio().catch(() => undefined);
    return res.responseText;
  },

  loadMagpie: async () => {
    const adapter = getClientAdapter();
    const [config, usage] = await Promise.all([
      adapter.getMagpieConfig(),
      adapter.getMagpieUsage().catch(() => null),
    ]);
    set({ magpieConfig: config, magpieUsage: usage });
  },

  updateMagpie: async (patch) => {
    const updated = await getClientAdapter().updateMagpieConfig(patch);
    set({ magpieConfig: updated });
    return updated;
  },

  previewMask: async (sampleText) => {
    const preview = await getClientAdapter().testMagpiePrivacyMask(sampleText);
    set({ maskPreview: preview });
    return preview;
  },

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

  loadMcp: async () => {
    const adapter = getClientAdapter();
    const [servers, toolsRes] = await Promise.all([
      adapter.listMcpServers(),
      adapter.listMcpTools(),
    ]);
    set({
      mcpServers: servers,
      mcpTools: toolsRes.tools,
      mcpApprovals: toolsRes.approvals,
    });
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

  startTalk: async () => {
    const talkSession = await getClientAdapter().startTalkSession();
    set({ talkSession });
    return talkSession;
  },

  sendTalkUtterance: async (audioOrTranscript) => {
    const payload =
      typeof audioOrTranscript === 'string'
        ? { transcript: audioOrTranscript }
        : audioOrTranscript;
    const talkSession = await getClientAdapter().sendTalkAudio(payload);
    set({ talkSession });
    return talkSession;
  },

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

  loadComputers: async () => {
    const adapter = getClientAdapter();
    const [compRes, tailnet] = await Promise.all([
      adapter.listComputers(),
      adapter.getTailnetStatus().catch(() => null),
    ]);
    set({
      computers: compRes.computers,
      computerApprovals: compRes.pendingApprovals,
      tailnet,
    });
  },

  runComputerOp: async (nodeId, operation, callerLabel) => {
    const res = await getClientAdapter().executeComputerOp(nodeId, operation, callerLabel);
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
    // Local immediate <10ms preemption fence first
    const localRevoke = browserControlAgent.emergencyTakeover('User emergency takeover');
    const localElapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    set((prev) => ({
      lastTakeoverMs: Number(localElapsed.toFixed(2)),
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
    const remote = await getClientAdapter()
      .emergencyTakeoverComputer(nodeId)
      .catch(() => ({ newGeneration: localRevoke.controlGeneration }));
    return {
      latencyMs: Number(localElapsed.toFixed(2)),
      newGeneration: remote.newGeneration,
    };
  },

  loadWallet: async () => {
    const wallet = await getClientAdapter().getWalletState();
    set({ wallet });
    return wallet;
  },

  topUpStars: async (amount) => {
    const wallet = await getClientAdapter().topUpStars(amount);
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

  loadBrowserControl: async () => {
    const adapter = getClientAdapter();
    await adapter.registerBrowserTarget(browserControlAgent.buildRegisterPayload()).catch(() => undefined);
    const [targetsRes, sessionsRes, logsRes] = await Promise.all([
      adapter.listBrowserTargets().catch(() => ({ targets: [] as BrowserTargetDescriptor[], control_generation: 1 })),
      adapter.listHeadlessSessions().catch(() => ({ sessions: [] as HeadlessBrowserSessionDto[] })),
      adapter.listBrowserAuditLogs(50).catch(() => ({ entries: [] as BrowserAuditLogEntry[] })),
    ]);
    set({
      browserTargets: targetsRes.targets,
      headlessSessions: sessionsRes.sessions,
      browserAuditLogs: logsRes.entries,
      localBridgeState: browserControlAgent.getState(),
    });
  },

  createPairingTicket: async (label = 'Desktop Controller', ttlSecs = 300) => {
    const pairingTicket = await getClientAdapter().createDesktopPairingTicket({ label, ttlSecs });
    set({ pairingTicket });
    return pairingTicket;
  },

  claimPairingTicket: async (pairCode, controllerLabel) => {
    const pairingTicket = await getClientAdapter().claimDesktopPairingTicket(
      pairCode,
      controllerLabel,
    );
    set({ pairingTicket });
    return pairingTicket;
  },

  setAllowDesktopControl: (allowed) => {
    browserControlAgent.setAllowDesktopControl(allowed);
    set({ localBridgeState: browserControlAgent.getState() });
    void getClientAdapter()
      .reportBrowserState(browserControlAgent.buildStateReportPayload())
      .catch(() => undefined);
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
    const local = browserControlAgent.emergencyTakeover('User revoked desktop browser control');
    set({ localBridgeState: browserControlAgent.getState() });
    const remote = await getClientAdapter()
      .revokeBrowserControl({ targetId, revokeTokens: true })
      .catch(() => ({
        control_generation: local.controlGeneration,
        elapsed_us: Math.round(local.elapsedMs * 1000),
      }));
    await get().loadBrowserControl().catch(() => undefined);
    return {
      elapsedMs: local.elapsedMs,
      controlGeneration: remote.control_generation,
    };
  },

  openHeadlessSession: async (url, preferFallback) => {
    const origin =
      typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:8080';
    const res = await getClientAdapter().openHeadlessSession({
      url: url || origin,
      viewport: { width: 1280, height: 800 },
      preferFallback,
    });
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

  invokeMcpRpc: (req) => getClientAdapter().invokeMcpRpc(req),
}));

browserControlAgent.subscribe(() => {
  useAiWorkspaceStore.setState({
    localBridgeState: browserControlAgent.getState(),
  });
});
