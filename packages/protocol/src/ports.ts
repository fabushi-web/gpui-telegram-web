/**
 * Hexagonal `TelegramClientPort` & `ClientEvent` Interface Contract.
 *
 * Bridges `@gpui-telegram/web` Zustand stores to all 3 runtime modes:
 * 1. `server` — Full-stack REST `/api/v1/*` + WebSocket `/api/v1/ws`
 * 2. `sandbox` — Standalone offline IndexedDB + `BroadcastChannel` engine
 * 3. `mtproto` — Browser MTProto (`api_id` + `api_hash`) mode
 */

import type {
  BotRegistryEntry,
  ComputerNodeDto,
  ComputerRunPolicy,
  HermesCommandDescriptor,
  HermesCronJobDto,
  HermesKanbanBoardDto,
  HermesMemoryState,
  HermesSessionSummary,
  HermesSkillDto,
  HermesStreamEvent,
  HermesStudioTab,
  MagpieMaskingConfig,
  MagpieMaskingPreviewResult,
  MagpiePreset,
  MagpieProviderView,
  MagpieRoutingGroup,
  MagpieUsageLedgerSummary,
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
} from './aiContracts.js';
import type { PublishPreKeysRequest, PublishPreKeysResponse, UserPreKeyBundlesResponse } from './e2ee.js';
import type { MessageEntity } from './entities.js';
import type {
  AdminLogEventDto,
  AuthResponse,
  CallRecordDto,
  CallSessionState,
  CallSignalPayload,
  ChannelStatisticsDto,
  ChatFolder,
  ChatMemberDto,
  ChatSummary,
  DraftState,
  ForumTopic,
  GifResultDto,
  GlobalSearchResponse,
  InlineQueryResponse,
  InviteLinkDto,
  InvoiceCard,
  MediaDescriptor,
  MessageContent,
  MessageItem,
  PollData,
  QrPairSessionDto,
  ReactionCount,
  ReactionDetail,
  ScheduledMessageDto,
  SearchHitDto,
  SearchTabCategory,
  SessionDto,
  StickerSetDto,
  StoryGroup,
  StoryItem,
  TodoListCard,
  TranslateMessageResponse,
  TwoFactorStatusDto,
  UserPrivacySettingsDto,
  UserProfile,
} from './models.js';
import type {
  PtsUpdate,
  SyncGetDifferenceRequest,
  SyncGetDifferenceResponse,
  TypingAction,
  UpdateEvent,
} from './sync.js';
import type {
  DeviceSyncActionResponse,
  DeviceSyncApproveRequest,
  DeviceSyncRequestDto,
  DeviceSyncRequestResponse,
  DeviceSyncStatusResponse,
  KdfParamsResponse,
  PendingDeviceSyncListResponse,
  UpsertUserVaultItemRequest,
  UpsertUserVaultItemResponse,
  UserVaultEnvelopeResponse,
  UserVaultKeyEnvelopeDto,
  UserVaultSyncPullResponse,
} from './userVault.js';
import type {
  AutomationAppDetail,
  InstallAutomationAppResponse,
  ListAutomationAppsQuery,
  ListAutomationAppsResponse,
  ListInstalledAutomationAppsResponse,
  PublishAutomationAppRequest,
  RecordAutomationRunRequest,
  RecordAutomationRunResponse,
  UninstallAutomationAppResponse,
} from './automationApps.js';
import type { CodingAgentsProbeRequest, CodingAgentsProbeResponse } from './codingAgents.js';
import type {
  AssistStartRequest,
  AssistStartResponse,
  RemoteAssistConfigDto,
  RemoteSessionsResponse,
} from './remoteControl.js';
import type { McpAuditListResponse, OAuthGrantsResponse } from './officialMcp.js';
import type {
  CatalogRecommendResponse,
  CatalogReviewsResponse,
  CreationAuditListResponse,
  CreationKind,
  CreationListResponse,
  CreationSyncResponse,
  GameLeaderboardResponse,
  PublicCatalogSearchResponse,
  ReviewDecisionRequest,
  SubmitGameScoreRequest,
  SubmitReviewRequest,
  UpsertCatalogReviewRequest,
  UpsertCatalogStateRequest,
  UpsertCreationRequest,
  UpsertCreationResponse,
  UserCreationDto,
  UserCreationStateDto,
} from './creations.js';
import type {
  AlgoPreferencesDto,
  AutoModDecisionDto,
  AutoModDryRunRequest,
  CommunityActorDto,
  CommunityCommentDto,
  CommunityListDto,
  CommunityNotificationDto,
  CommunityPostDto,
  CommunitySearchRequestDto,
  CommunitySearchResponseDto,
  EngagementSignalDto,
  FeedResponseDto,
  FeedSort,
  FeedTab,
  ModLogEntryDto,
  ModQueueItemDto,
  SubCommunityDto,
  TrendingTopicDto,
} from './community.js';
import type {
  BotGroupDto,
  BotHomeFilesDto,
  BotItemDto,
  BotMemoryEntryDto,
  BotPackageV1Dto,
  BrowserDesignCaptureRequest,
  BrowserDesignCaptureResponse,
  DesignModeChatHandoffDto,
  NeedsYouItemDto,
  OrcaArtifactPublicView,
  OrcaBotDto,
  OrcaBotTemplateDto,
  OrcaDecisionGateDto,
  OrcaDiffAnnotationDto,
  OrcaHostFederationDto,
  OrcaMailboxMessageDto,
  OrcaPluginManifestDto,
  OrcaRpcRequestEnvelope,
  OrcaRpcResponseEnvelope,
  OrcaRunDto,
  OrcaTaskDto,
  OrcaTelegramLinkDto,
  OrcaUsageQuotaSnapshotDto,
  OrcaVaultSearchHitDto,
  OrcaWebhookCreatedDto,
  OrcaWebhookPublicDto,
  OrcaWorktreeDto,
  TeamShareIdentityDto,
  TeamShareOfferEnvelopeDto,
  UpNextSuggestionDto,
} from './orca.js';

/**
 * Runtime transport mode.
 * @deprecated `'sandbox'` and `'mtproto'` modes are scheduled for removal in M4 production runtime.
 */
export type AdapterMode = 'server' | 'sandbox' | 'mtproto';

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'updating';

export type ClientEvent =
  | { kind: 'connection_state'; state: ConnectionState }
  | { kind: 'pts_update'; update: PtsUpdate }
  | { kind: 'update'; event: UpdateEvent }
  | { kind: 'auth_invalidated'; reason: string };

export type UnsubscribeFn = () => void;

export interface SendMessagePortInput {
  chatId: number;
  text?: string;
  entities?: MessageEntity[];
  content?: MessageContent;
  replyToMsgId?: number;
  quoteText?: string;
  topicId?: number;
  clientNonce?: number;
  silent?: boolean;
  scheduleAtMs?: number;
  ttlSeconds?: number;
  sendAsPeerId?: number;
  skipServerBotReply?: boolean;
}

export interface HermesStudioSnapshot {
  status: Record<string, unknown>;
  sessions: HermesSessionSummary[];
  memory: HermesMemoryState;
  skills: HermesSkillDto[];
  enabledToolsets: string[];
  cronJobs: HermesCronJobDto[];
  kanbanBoards: HermesKanbanBoardDto[];
}

export interface MagpieConfigSnapshot {
  presets: MagpiePreset[];
  providers: MagpieProviderView[];
  activeProvider: string;
  activeModel: string;
  allowLocalFallback: boolean;
  routingGroups: MagpieRoutingGroup[];
  routingStrategy: string;
  masking: MagpieMaskingConfig;
}

export interface TelegramClientPort {
  readonly mode: AdapterMode;

  // Lifecycle & Real-Time Subscriptions
  connect(token?: string): Promise<void>;
  disconnect(): Promise<void>;
  getConnectionState(): ConnectionState;
  onConnectionStateChange(listener: (state: ConnectionState) => void): UnsubscribeFn;
  onUpdate(listener: (event: UpdateEvent, ptsUpdate?: PtsUpdate) => void): UnsubscribeFn;
  getDifference(req: SyncGetDifferenceRequest): Promise<SyncGetDifferenceResponse>;

  // F1: Auth, 2FA, QR, Passkeys & Sessions
  /** @deprecated Demo auth is removed in v1.6.11 production runtime (M4). */
  loginDemo(slot?: number): Promise<AuthResponse>;
  /** Note: `dev_code` is @deprecated and omitted in v1.6.11 production runtime. */
  sendPhoneCode(phone: string): Promise<{ phone_code_hash: string; timeout_secs: number; dev_code?: string }>;
  verifyPhoneCode(req: {
    phone: string;
    phone_code_hash?: string;
    code: string;
    password?: string;
    first_name?: string;
    last_name?: string;
  }): Promise<AuthResponse | { requires_2fa: true; challenge_token: string; hint?: string }>;
  verify2fa(req: { challenge_token: string; password: string }): Promise<AuthResponse>;
  get2faStatus(): Promise<TwoFactorStatusDto>;
  set2faPassword(req: { current_password?: string; new_password: string; hint?: string; recovery_email?: string }): Promise<TwoFactorStatusDto>;
  disable2faPassword(currentPassword?: string): Promise<{ ok: boolean }>;
  initQrPairing(deviceName?: string): Promise<QrPairSessionDto>;
  pollQrPairing(pairId: string): Promise<QrPairSessionDto>;
  acceptQrPairing(pairId: string): Promise<QrPairSessionDto>;
  loginPassword(username: string, password: string, twoFaPassword?: string): Promise<AuthResponse>;
  registerPassword(req: {
    username: string;
    password: string;
    first_name: string;
    last_name?: string;
  }): Promise<AuthResponse>;
  /** Note: `dev_code` is @deprecated and omitted in v1.6.11 production runtime. */
  sendEmailCode(email: string): Promise<{ email_code_hash: string; dev_code?: string }>;
  verifyEmailCode(req: { email: string; code: string; email_code_hash?: string }): Promise<AuthResponse>;
  startAlipayAuth(): Promise<{ session_id: string; qr_url: string; svg: string; expires_at_ms: number }>;
  pollAlipayAuth(sessionId: string): Promise<{ status: string; auth?: AuthResponse }>;
  /** @deprecated Local Alipay confirmation bypass is removed in v1.6.11 (M4). */
  confirmAlipayAuth(sessionId: string): Promise<AuthResponse>;
  getPasskeyChallenge(username?: string): Promise<{ challenge_id: string; challenge: string; rp_id: string }>;
  registerPasskey(req: { cred_id?: string; label: string; public_key_b64?: string }): Promise<{ cred_id: string; label: string }>;
  verifyPasskey(req: { challenge_id: string; credential_id: string }): Promise<AuthResponse>;
  listSessions(): Promise<SessionDto[]>;
  revokeSession(sessionId: string): Promise<void>;
  revokeOtherSessions(): Promise<number>;
  logout(): Promise<void>;

  // F4, F5 & F14: Chats, Folders, Topics, Contacts, Social Admin, Search, Stats & Export
  listChats(opts?: { archived?: boolean; folderId?: string | number }): Promise<{ chats: ChatSummary[]; users: UserProfile[] }>;
  getChat(chatId: number): Promise<ChatSummary>;
  openSavedMessages(): Promise<ChatSummary>;
  createChat(req: {
    title: string;
    chatType: number;
    about?: string;
    username?: string;
    isForum?: boolean;
    peerUserId?: number;
    memberIds?: number[];
    memberUsernames?: string[];
    clientNonce?: string;
  }): Promise<ChatSummary>;
  updateChat(chatId: number, patch: Partial<{ title: string; about: string; username: string; slowModeSeconds: number; isForum: boolean }>): Promise<ChatSummary>;
  deleteOrLeaveChat(chatId: number): Promise<void>;
  updateChatSettings(
    chatId: number,
    patch: Partial<{ isPinned: boolean; isArchived: boolean; isMuted: boolean; unreadMark: boolean; folderId: number | null }>,
  ): Promise<ChatSummary>;
  setChatTtl(chatId: number, ttlSeconds: number): Promise<void>;
  saveDraft(chatId: number, draft: DraftState | null): Promise<void>;
  listFolders(): Promise<ChatFolder[]>;
  upsertFolder(folder: Partial<ChatFolder> & { title: string }): Promise<ChatFolder>;
  deleteFolder(folderId: number | string): Promise<void>;
  listForumTopics(chatId: number): Promise<ForumTopic[]>;
  createForumTopic(chatId: number, req: { title: string; iconColor?: number; iconEmoji?: string }): Promise<ForumTopic>;
  updateForumTopic(chatId: number, topicId: number, patch: Partial<{ title: string; isClosed: boolean; isPinned: boolean }>): Promise<ForumTopic>;
  deleteForumTopic(chatId: number, topicId: number): Promise<void>;
  listContacts(): Promise<UserProfile[]>;
  addContact(req: { userId?: number; username?: string; phone?: string; firstName?: string; lastName?: string }): Promise<UserProfile>;
  deleteContact(userId: number): Promise<void>;
  resolveUsername(username: string): Promise<{ peerType: string; user?: UserProfile; chat?: ChatSummary }>;
  listMembers(chatId: number): Promise<{ members: ChatMemberDto[]; users: UserProfile[] }>;
  addMembers(chatId: number, userIds: number[]): Promise<void>;
  updateMemberRole(chatId: number, userId: number, patch: { role: ChatMemberDto['role']; customTitle?: string }): Promise<ChatMemberDto>;
  removeMember(chatId: number, userId: number): Promise<void>;
  listInviteLinks(chatId: number): Promise<InviteLinkDto[]>;
  createInviteLink(chatId: number, req?: { title?: string; usageLimit?: number; expireAtMs?: number }): Promise<InviteLinkDto>;
  revokeInviteLink(chatId: number, code: string): Promise<void>;
  joinByInvite(code: string): Promise<ChatSummary>;
  getChannelStatistics(chatId: number): Promise<ChannelStatisticsDto>;
  listStories(): Promise<StoryGroup[]>;
  createStory(req: { caption?: string; mediaFileId?: string; backgroundGradient?: string }): Promise<StoryItem>;
  markStoryViewed(storyId: string): Promise<number>;
  searchGlobal(query: string, opts?: { tab?: SearchTabCategory; minDate?: number; maxDate?: number }): Promise<GlobalSearchResponse>;
  searchMessages(chatId: number, query: string, opts?: { senderId?: number; topicId?: number; minDate?: number; maxDate?: number }): Promise<SearchHitDto[]>;
  exportChat(chatId: number, format: 'json' | 'html'): Promise<string>;

  // F6–F13: Messages, Reactions, Polls, Todos, Invoices & Media
  listMessages(
    chatId: number,
    opts?: { limit?: number; beforeId?: number; afterId?: number; topicId?: number; mediaFilter?: string },
  ): Promise<{ messages: MessageItem[]; pts: number; hasMore: boolean }>;
  sendMessage(req: SendMessagePortInput): Promise<{ message: MessageItem; pts: number; duplicate?: boolean }>;
  editMessage(chatId: number, messageId: number, text: string, entities?: MessageEntity[]): Promise<{ message: MessageItem; pts: number }>;
  deleteMessages(chatId: number, messageIds: number[], forEveryone: boolean): Promise<{ pts: number }>;
  forwardMessages(
    fromChatId: number,
    toChatId: number,
    messageIds: number[],
    opts?: { hideSender?: boolean; comment?: string },
  ): Promise<MessageItem[]>;
  pinMessage(chatId: number, messageId: number, pinned: boolean): Promise<number[]>;
  listPinnedMessages(chatId: number, topicId?: number): Promise<MessageItem[]>;
  readHistory(chatId: number, maxId: number, topicId?: number): Promise<{ unreadCount: number; pts: number }>;
  sendTyping(chatId: number, action: TypingAction, topicId?: number): Promise<void>;
  toggleReaction(chatId: number, messageId: number, emoji: string): Promise<ReactionCount[]>;
  getReactionDetails(chatId: number, messageId: number): Promise<ReactionDetail[]>;
  createPoll(
    chatId: number,
    req: {
      question: string;
      options: string[];
      isAnonymous?: boolean;
      allowsMultipleAnswers?: boolean;
      isQuiz?: boolean;
      correctOptionId?: number;
      explanation?: string;
      topicId?: number;
    },
  ): Promise<{ message: MessageItem; poll: PollData }>;
  votePoll(pollId: number, optionIds: number[]): Promise<PollData>;
  closePoll(pollId: number): Promise<PollData>;
  createTodo(chatId: number, req: { title: string; items: string[]; topicId?: number }): Promise<MessageItem>;
  toggleTodoItem(chatId: number, messageId: number, itemId: string, completed?: boolean): Promise<MessageItem>;
  createInvoice(
    chatId: number,
    req: { title: string; description?: string; currency?: string; amount: number },
  ): Promise<{ message: MessageItem; invoice: InvoiceCard; pts: number }>;
  payInvoice(chatId: number, messageId: number): Promise<{ paid: boolean; balance: number; receiptMessage?: MessageItem }>;
  uploadMedia(
    data: Uint8Array | Blob,
    meta: { fileName: string; mimeType: string; width?: number; height?: number; durationSecs?: number; waveform?: number[] },
    onProgress?: (pct: number) => void,
  ): Promise<MediaDescriptor>;
  getMediaStreamUrl(fileId: string): string;
  listStickerSets(): Promise<StickerSetDto[]>;
  installStickerSet(setId: string, install: boolean): Promise<void>;
  searchGifs(query: string): Promise<GifResultDto[]>;
  transcribeVoice(fileId: string): Promise<string>;
  aiComposeAssist(text: string, mode: 'improve' | 'shorter' | 'formal' | 'translate_zh' | 'translate_en'): Promise<string>;

  // F14 & F15: Profile, Privacy, Calls & Secret Chats E2EE
  getMe(): Promise<UserProfile>;
  updateProfile(patch: Partial<{ firstName: string; lastName: string; username: string; bio: string; photoFileId: string }>): Promise<UserProfile>;
  getPrivacySettings(): Promise<UserPrivacySettingsDto>;
  updatePrivacySettings(patch: Partial<UserPrivacySettingsDto>): Promise<UserPrivacySettingsDto>;
  listBlockedUsers(): Promise<UserProfile[]>;
  setBlockedUser(userId: number, blocked: boolean): Promise<void>;
  startCall(calleeId: number, isVideo: boolean, chatId?: number): Promise<CallSessionState>;
  sendCallSignal(signal: CallSignalPayload): Promise<void>;
  endCall(callId: string, rating?: number): Promise<CallSessionState>;
  listCalls(): Promise<CallSessionState[]>;
  publishPreKeys(req: PublishPreKeysRequest): Promise<PublishPreKeysResponse>;
  getUserPreKeyBundles(userId: number): Promise<UserPreKeyBundlesResponse>;
  createSecretChat(peerUserId: number, ttlSeconds?: number): Promise<ChatSummary>;

  // F16: Bots, MiniApps, Hermes, Magpie, Tasks, MCP, Talk, Computers, Tailnet & Wallet
  listBots(): Promise<BotRegistryEntry[]>;
  createBot(req: { displayName: string; username: string; description?: string }): Promise<{ bot: BotRegistryEntry; botToken: string; chatId: number }>;
  listMiniApps(query?: string): Promise<MiniAppEntry[]>;
  launchMiniApp(botUsername: string, shortName: string, chatId?: number): Promise<MiniAppLaunchContext>;
  getMiniAppCloudStorage(botUsername: string, shortName: string, keys?: string[]): Promise<Record<string, string>>;
  setMiniAppCloudStorage(botUsername: string, shortName: string, key: string, value: string): Promise<void>;
  deleteMiniAppCloudStorage(botUsername: string, shortName: string, keys: string[]): Promise<void>;
  streamHermesTurn(
    req: { prompt: string; sessionId?: string; chatId?: number; model?: string },
    onEvent: (event: HermesStreamEvent) => void,
  ): Promise<void>;
  executeHermesSlashCommand(command: string, chatId?: number, sessionId?: string): Promise<{ responseText: string; uiEffect: unknown }>;
  listHermesCommands(prefix?: string): Promise<HermesCommandDescriptor[]>;
  getHermesStudioState(): Promise<HermesStudioSnapshot>;
  updateHermesStudioState(tab: HermesStudioTab, patch: Record<string, unknown>): Promise<HermesStudioSnapshot>;
  getMagpieConfig(): Promise<MagpieConfigSnapshot>;
  updateMagpieConfig(patch: Record<string, unknown>): Promise<MagpieConfigSnapshot>;
  getMagpieUsage(): Promise<MagpieUsageLedgerSummary>;
  testMagpiePrivacyMask(text: string): Promise<MagpieMaskingPreviewResult>;
  listTasks(): Promise<TaskItemDto[]>;
  createTask(req: { title: string; description?: string; cronExpr?: string; chatId?: number }): Promise<TaskItemDto>;
  updateTask(taskId: string, patch: Partial<{ state: TaskItemDto['state']; title: string; cronExpr: string }>): Promise<TaskItemDto>;
  deleteTask(taskId: string): Promise<void>;
  listMcpServers(): Promise<McpServerDto[]>;
  listMcpTools(): Promise<{ tools: McpToolDto[]; approvals: McpPendingApprovalDto[] }>;
  invokeMcpTool(req: {
    toolId?: string;
    toolName?: string;
    arguments?: Record<string, unknown>;
    forceApprove?: boolean;
  }): Promise<Record<string, unknown>>;
  approveMcpToolCall(requestId: string, allow: boolean): Promise<void>;
  startTalkSession(): Promise<TalkSessionDto>;
  sendTalkAudio(audioOrTranscript: Uint8Array | { transcript: string }): Promise<TalkSessionDto>;
  bargeInTalkSession(): Promise<TalkSessionDto>;
  stopTalkSession(): Promise<TalkSessionDto>;
  listComputers(): Promise<{ computers: ComputerNodeDto[]; pendingApprovals: PendingComputerCommandDto[] }>;
  executeComputerOp(
    nodeId: string,
    operation: Record<string, unknown>,
    callerLabel?: string,
  ): Promise<Record<string, unknown>>;
  approveComputerCommand(commandId: string, approve: boolean): Promise<PendingComputerCommandDto>;
  updateComputerPolicy(nodeId: string, policy: ComputerRunPolicy): Promise<ComputerNodeDto>;
  emergencyTakeoverComputer(nodeId?: string): Promise<{ status: string; newGeneration: number; latencySub10ms: boolean }>;
  // Optional production desktop-aligned extensions (implemented by HttpWsServerAdapter)
  probeServerHealth?(serverUrl?: string): Promise<{
    ok: boolean;
    version?: string;
    server?: string;
    mode?: string;
    latencyMs: number;
    error?: string;
  }>;
  emailRegister?(req: {
    email: string;
    code: string;
    username: string;
    password: string;
    first_name?: string;
    last_name?: string;
    email_code_hash?: string;
  }): Promise<AuthResponse>;
  probeMagpieProvider?(providerId: string): Promise<{
    ok: boolean;
    latency_ms?: number;
    models?: string[];
    error?: string;
  }>;
  scanMagpieSubscriptions?(): Promise<{ subscriptions: Array<Record<string, unknown>> }>;
  importMagpieConfig?(payload: {
    raw_text?: string;
    providers?: Array<Record<string, unknown>>;
  }): Promise<MagpieConfigSnapshot>;
  createCloudComputer?(req: {
    display_name: string;
    host: string;
    port?: number;
    ssh_user: string;
    secret?: string;
    run_policy?: ComputerRunPolicy;
  }): Promise<ComputerNodeDto>;
  testComputerConnection?(nodeId: string): Promise<{
    ok: boolean;
    latency_ms?: number;
    message?: string;
  }>;
  deleteComputer?(nodeId: string): Promise<void>;
  registerMcpServer?(req: {
    name: string;
    transport: string;
    url?: string;
    command?: string;
    args?: string[];
  }): Promise<McpServerDto>;
  deleteMcpServer?(serverId: string): Promise<void>;

  // Optional v1.6.11 Split-Key V2 Vault, Device Sync, Automation Apps, Coding Agents, Remote Assist & OAuth MCP
  getKdfParams?(usernameOrEmail: string): Promise<KdfParamsResponse>;
  getUserVaultEnvelope?(): Promise<UserVaultEnvelopeResponse>;
  putUserVaultEnvelope?(envelope: UserVaultKeyEnvelopeDto): Promise<UserVaultEnvelopeResponse>;
  listUserVaultItems?(sinceRevision?: number): Promise<UserVaultSyncPullResponse>;
  upsertUserVaultItem?(
    category: string,
    itemKey: string,
    req: UpsertUserVaultItemRequest,
  ): Promise<UpsertUserVaultItemResponse>;
  deleteUserVaultItem?(category: string, itemKey: string): Promise<UpsertUserVaultItemResponse>;
  requestDeviceSync?(req: DeviceSyncRequestDto): Promise<DeviceSyncRequestResponse>;
  listPendingDeviceSyncs?(): Promise<PendingDeviceSyncListResponse>;
  approveDeviceSync?(requestId: string, req: DeviceSyncApproveRequest): Promise<DeviceSyncActionResponse>;
  denyDeviceSync?(requestId: string): Promise<DeviceSyncActionResponse>;
  getDeviceSyncStatus?(requestId: string): Promise<DeviceSyncStatusResponse>;
  listAutomationApps?(query?: ListAutomationAppsQuery): Promise<ListAutomationAppsResponse>;
  listInstalledAutomationApps?(): Promise<ListInstalledAutomationAppsResponse>;
  getAutomationApp?(appId: string): Promise<AutomationAppDetail>;
  publishAutomationApp?(req: PublishAutomationAppRequest): Promise<AutomationAppDetail>;
  installAutomationApp?(appId: string): Promise<InstallAutomationAppResponse>;
  uninstallAutomationApp?(appId: string): Promise<UninstallAutomationAppResponse>;
  recordAutomationRun?(appId: string, req: RecordAutomationRunRequest): Promise<RecordAutomationRunResponse>;
  probeCodingAgents?(req?: CodingAgentsProbeRequest): Promise<CodingAgentsProbeResponse>;
  getRemoteAssistInfo?(): Promise<RemoteAssistConfigDto>;
  startRemoteAssist?(req: AssistStartRequest): Promise<AssistStartResponse>;
  listRemoteSessions?(): Promise<RemoteSessionsResponse>;
  disconnectRemoteSession?(sessionId: string): Promise<{ ok: boolean }>;
  disconnectAllRemoteSessions?(): Promise<{ ok: boolean; disconnected: number }>;
  listOAuthMcpGrants?(): Promise<OAuthGrantsResponse>;
  revokeOAuthMcpGrant?(familyId: string): Promise<{ ok: boolean }>;
  listOAuthMcpAudit?(limit?: number): Promise<McpAuditListResponse>;

  // Optional v1.7.0 Core Parity methods (inline queries, scheduled messages, translate, admin log, calls history)
  queryBotInline?(req: {
    bot: string;
    query: string;
    chatId?: number;
    offset?: string;
    limit?: number;
    queryId?: string;
  }): Promise<InlineQueryResponse>;
  listScheduledMessages?(chatId: number): Promise<ScheduledMessageDto[]>;
  cancelScheduledMessage?(chatId: number, messageId: number): Promise<{ ok: boolean }>;
  sendScheduledMessageNow?(chatId: number, messageId: number): Promise<{ message: MessageItem; pts: number }>;
  translateMessage?(chatId: number, messageId: number, targetLang: string): Promise<TranslateMessageResponse>;
  listAdminLog?(
    chatId: number,
    opts?: { limit?: number; beforeId?: number; action?: string; actorId?: number },
  ): Promise<{ chat_id: number; events: AdminLogEventDto[]; total: number }>;
  listCallsHistory?(opts?: {
    limit?: number;
    filter?: 'all' | 'missed' | 'video';
  }): Promise<{ calls: CallRecordDto[]; total: number }>;

  getTailnetStatus(): Promise<TailnetStatusDto>;
  getWalletState(): Promise<WalletStateDto>;
  /** @deprecated Unverified direct Stars minting is replaced by verified checkout/redeem in v1.6.11. */
  topUpStars(amount: number): Promise<WalletStateDto>;
  sendStarGift(req: { toUserId: number; chatId?: number; amountStars: number; giftId?: string; message?: string }): Promise<WalletStateDto>;
}

// ============================================================================
// Dedicated v1.7.0 Sub-Port Interfaces (M2–M5)
// ============================================================================

export interface CreationsClientPort {
  listMyCreations(kind?: CreationKind): Promise<CreationListResponse>;
  syncMyCreations(sinceRevision?: number): Promise<CreationSyncResponse>;
  getCreation(creationId: string): Promise<UserCreationDto>;
  upsertCreation(req: UpsertCreationRequest): Promise<UpsertCreationResponse>;
  deleteCreation(creationId: string): Promise<{ ok: boolean }>;
  submitCreationReview(creationId: string, req?: SubmitReviewRequest): Promise<UserCreationDto>;
  withdrawCreationReview(creationId: string): Promise<UserCreationDto>;
  unpublishCreation(creationId: string): Promise<UserCreationDto>;
  listReviewQueue(): Promise<CreationListResponse>;
  decideCreationReview(creationId: string, req: ReviewDecisionRequest): Promise<UserCreationDto>;
  listCreationAudit(creationId: string): Promise<CreationAuditListResponse>;
  searchPublicCatalog(opts?: {
    kind?: CreationKind;
    query?: string;
    genre?: string;
    limit?: number;
  }): Promise<PublicCatalogSearchResponse>;
  getCatalogRecommendations(opts?: { kind?: CreationKind; limit?: number }): Promise<CatalogRecommendResponse>;
  listMyCatalogStates(): Promise<UserCreationStateDto[]>;
  upsertCatalogState(creationId: string, req: UpsertCatalogStateRequest): Promise<UserCreationStateDto>;
  listCatalogReviews(creationId: string): Promise<CatalogReviewsResponse>;
  upsertCatalogReview(creationId: string, req: UpsertCatalogReviewRequest): Promise<CatalogReviewsResponse>;
  submitGameScore(creationId: string, req: SubmitGameScoreRequest): Promise<GameLeaderboardResponse>;
  getGameLeaderboard(creationId: string): Promise<GameLeaderboardResponse>;
}

export interface CommunityClientPort {
  listIdentities(): Promise<{ actors: CommunityActorDto[]; active_actor_id?: string }>;
  getFeed(opts?: {
    tab?: FeedTab;
    sort?: FeedSort;
    cursor?: string;
    limit?: number;
  }): Promise<FeedResponseDto>;
  getAlgoPreferences(): Promise<AlgoPreferencesDto>;
  updateAlgoPreferences(prefs: Partial<AlgoPreferencesDto>): Promise<AlgoPreferencesDto>;
  recordSignal(signal: EngagementSignalDto): Promise<{ ok: boolean }>;
  createPost(payload: Record<string, unknown>): Promise<CommunityPostDto>;
  getPost(postId: string): Promise<CommunityPostDto>;
  listComments(postId: string, sort?: string): Promise<CommunityCommentDto[]>;
  createComment(postId: string, bodyMarkdown: string, parentCommentId?: string): Promise<CommunityCommentDto>;
  listCommunities(): Promise<SubCommunityDto[]>;
  getCommunity(slug: string): Promise<SubCommunityDto>;
  listLists(): Promise<CommunityListDto[]>;
  listTrending(): Promise<TrendingTopicDto[]>;
  searchCommunity(req: CommunitySearchRequestDto): Promise<CommunitySearchResponseDto>;
  listNotifications(unreadOnly?: boolean): Promise<CommunityNotificationDto[]>;
  listModQueue(slug: string): Promise<ModQueueItemDto[]>;
  listModLogs(slug: string): Promise<ModLogEntryDto[]>;
  dryRunAutoMod(req: AutoModDryRunRequest): Promise<AutoModDecisionDto>;
}

export interface OrcaBotsClientPort {
  listBots(): Promise<OrcaBotDto[]>;
  listTemplates(): Promise<OrcaBotTemplateDto[]>;
  createBot(payload: Record<string, unknown>): Promise<OrcaBotDto>;
  getBotHomeFiles(botId: string): Promise<BotHomeFilesDto>;
  listBotMemory(botId: string): Promise<BotMemoryEntryDto[]>;
  listBotItems(botId: string): Promise<BotItemDto[]>;
  listNeedsYou(): Promise<NeedsYouItemDto[]>;
  listUpNext(botId: string): Promise<UpNextSuggestionDto[]>;
  listGroups(): Promise<BotGroupDto[]>;
  exportBotPackage(botId: string): Promise<BotPackageV1Dto>;
  importBotPackage(pkg: BotPackageV1Dto): Promise<OrcaBotDto>;
  getTeamShareIdentity(): Promise<TeamShareIdentityDto>;
  sealTeamShareOffer(botId: string, recipientUserId: number): Promise<TeamShareOfferEnvelopeDto>;
  listWebhooks(): Promise<OrcaWebhookPublicDto[]>;
  createWebhook(payload: Record<string, unknown>): Promise<OrcaWebhookCreatedDto>;
  getTelegramLink(botId: string): Promise<OrcaTelegramLinkDto | null>;
}

export interface OrcaIdeClientPort {
  invokeRpc<T = unknown>(req: OrcaRpcRequestEnvelope): Promise<OrcaRpcResponseEnvelope & { result?: T }>;
  listRuns(): Promise<OrcaRunDto[]>;
  listTasks(runId: string): Promise<OrcaTaskDto[]>;
  listMailbox(runId: string): Promise<OrcaMailboxMessageDto[]>;
  listDecisionGates(runId: string): Promise<OrcaDecisionGateDto[]>;
  listHosts(): Promise<OrcaHostFederationDto[]>;
  listWorktrees(): Promise<OrcaWorktreeDto[]>;
  listDiffAnnotations(filePath?: string): Promise<OrcaDiffAnnotationDto[]>;
  searchVault(query: string): Promise<OrcaVaultSearchHitDto[]>;
  listPlugins(): Promise<OrcaPluginManifestDto[]>;
  listArtifacts(): Promise<OrcaArtifactPublicView[]>;
  getUsageSnapshots(): Promise<OrcaUsageQuotaSnapshotDto[]>;
}

export interface BrowserDesignModeClientPort {
  captureDesignMode(req: BrowserDesignCaptureRequest): Promise<BrowserDesignCaptureResponse>;
  handoffDesignToChat?(req: DesignModeChatHandoffDto): Promise<{ ok: boolean; message_id?: number }>;
}

