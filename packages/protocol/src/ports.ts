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
  AuthResponse,
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
  InviteLinkDto,
  InvoiceCard,
  MediaDescriptor,
  MessageContent,
  MessageItem,
  PollData,
  QrPairSessionDto,
  ReactionCount,
  ReactionDetail,
  SearchHitDto,
  SearchTabCategory,
  SessionDto,
  StickerSetDto,
  StoryGroup,
  StoryItem,
  TodoListCard,
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
  loginDemo(slot?: number): Promise<AuthResponse>;
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
  sendEmailCode(email: string): Promise<{ email_code_hash: string; dev_code?: string }>;
  verifyEmailCode(req: { email: string; code: string; email_code_hash?: string }): Promise<AuthResponse>;
  startAlipayAuth(): Promise<{ session_id: string; qr_url: string; svg: string; expires_at_ms: number }>;
  pollAlipayAuth(sessionId: string): Promise<{ status: string; auth?: AuthResponse }>;
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
  getTailnetStatus(): Promise<TailnetStatusDto>;
  getWalletState(): Promise<WalletStateDto>;
  topUpStars(amount: number): Promise<WalletStateDto>;
  sendStarGift(req: { toUserId: number; chatId?: number; amountStars: number; giftId?: string; message?: string }): Promise<WalletStateDto>;
}
