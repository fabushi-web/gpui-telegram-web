import { create } from 'zustand';
import {
  createTextContent,
  enrichMessageItem,
  extractPlainTextFromContent,
  fromWireMessageEntity,
  mapChatDtoToDomain,
  mapChatFolderDtoToDomain,
  mapForumTopicDtoToDomain,
  mapStoryDtoToDomain,
  mapUserDtoToDomain,
  parseMarkdownEntities,
  type AlbumMediaItem,
  type ArchiveLocalBotReplyRequest,
  type ArchiveLocalBotReplyResponse,
  type ChannelStatisticsDto,
  type ChatFolder,
  type ChatMemberDto,
  type ChatSummary,
  type ConnectionState,
  type DraftState,
  type ForumTopic,
  type GifResultDto,
  type GlobalSearchResponse,
  type InviteLinkDto,
  type MessageContent,
  type MessageEntity,
  type MessageItem,
  type PollData,
  type ReactionDetail,
  type SearchHitDto,
  type SearchTabCategory,
  type StickerItemDto,
  type StickerSetDto,
  type StoryGroup,
  type StoryItem,
  type TypingAction,
  type UpdateEvent,
  type UserPrivacySettingsDto,
  type UserProfile,
} from '@gpui-telegram/protocol';
import {
  broadcastSync,
  getClientAdapter,
  getServerAdapter,
  indexedDbCache,
} from '../adapters';
import type {
  RoundVideoRecordingResult,
  VoiceRecordingResult,
} from '../services/audioRecorder';
import { exportAndDownloadChat } from '../services/chatExport';
import {
  decryptEnvelope,
  encryptEnvelope,
  ensureSecretChatKeyMaterial,
} from '../services/e2eeClient';
import { webrtcManager } from '../services/webrtcManager';
import { useAuthStore } from './useAuthStore';
import { useUiStore } from './useUiStore';

const localTabSendTimestampByChat = new Map<number, number>();

export function markLocalTabSend(chatId: number): void {
  localTabSendTimestampByChat.set(chatId, Date.now());
}

export function clearLocalTabSend(chatId: number): void {
  localTabSendTimestampByChat.delete(chatId);
}

export function wasSentLocallyInTab(chatId: number, windowMs = 1500): boolean {
  const ts = localTabSendTimestampByChat.get(chatId);
  if (ts === undefined) return false;
  return Date.now() - ts <= windowMs;
}

export interface ReplyTargetState {
  messageId: number;
  senderName?: string;
  previewText: string;
  quoteText?: string;
}

export interface RoomAgentState {
  currentSpeaker: string | null;
  queuedCount: number;
  loopHops: number;
  updatedAtMs: number;
  workspaceRevision?: number;
  lastWorkspaceKey?: string;
}

export interface BotActivityState {
  botUserId: number;
  state: string;
  detail?: string | null;
  updatedAtMs: number;
}

export interface AgentHandoffState {
  fromAgent: string;
  toAgent: string;
  hop: number;
  maxHops: number;
  updatedAtMs: number;
}

export interface ChatState {
  chatsById: Record<number, ChatSummary>;
  orderedChatIds: number[];
  activeChatId: number | null;
  activeTopicId: number | null;
  activeFolderId: string | number;
  showArchived: boolean;

  messagesByChat: Record<number, MessageItem[]>;
  hasMoreByChat: Record<number, boolean>;
  pinnedByChat: Record<number, MessageItem[]>;
  topicsByChat: Record<number, ForumTopic[]>;
  folders: ChatFolder[];
  draftsByChat: Record<number, DraftState>;

  replyTargetByChat: Record<number, ReplyTargetState | null>;
  editingMessageByChat: Record<number, MessageItem | null>;
  selectedMessageIds: number[];
  isMultiSelectMode: boolean;

  peersById: Record<number, UserProfile>;
  contacts: UserProfile[];
  blockedUsers: UserProfile[];
  privacySettings: UserPrivacySettingsDto | null;
  membersByChat: Record<number, ChatMemberDto[]>;
  invitesByChat: Record<number, InviteLinkDto[]>;
  statsByChat: Record<number, ChannelStatisticsDto>;

  storyGroups: StoryGroup[];
  stickerSets: StickerSetDto[];
  gifResults: GifResultDto[];

  globalSearchQuery: string;
  globalSearchTab: SearchTabCategory;
  globalSearchResults: GlobalSearchResponse | null;
  inChatSearchQuery: string;
  inChatSearchHits: SearchHitDto[];

  typingByChat: Record<number, number[]>;
  decryptedSecretTexts: Record<string, string>;
  voiceTranscripts: Record<string, string>;

  roomAgentStateByChat: Record<number, RoomAgentState>;
  botActivityByChat: Record<number, BotActivityState>;
  agentFloorByChat: Record<number, { currentSpeaker: string | null; queuedCount: number; loopHops: number }>;
  agentWorkspaceByChat: Record<number, Record<string, unknown>>;
  lastAgentHandoffByChat: Record<number, AgentHandoffState>;

  isLoadingChats: boolean;
  isLoadingMessages: boolean;
  uploadProgress: number | null;
  connectionState: ConnectionState;
  pendingOutboxCount: number;

  bootstrapChats: () => Promise<void>;
  selectChat: (chatId: number | null, topicId?: number | null) => Promise<void>;
  setActiveFolder: (folderId: string | number) => void;
  setShowArchived: (archived: boolean) => void;
  loadOlderMessages: (chatId: number) => Promise<boolean>;

  setReplyTarget: (chatId: number, target: ReplyTargetState | null) => void;
  setEditingMessage: (chatId: number, message: MessageItem | null) => void;
  toggleMessageSelection: (messageId: number, force?: boolean) => void;
  clearMultiSelect: () => void;

  sendText: (
    chatId: number,
    rawText: string,
    opts?: {
      entities?: MessageEntity[];
      replyToMsgId?: number;
      quoteText?: string;
      topicId?: number;
      silent?: boolean;
      scheduleAtMs?: number;
      ttlSeconds?: number;
      skipServerBotReply?: boolean;
    },
  ) => Promise<MessageItem>;
  archiveLocalBotReply: (
    chatId: number,
    req: ArchiveLocalBotReplyRequest,
  ) => Promise<ArchiveLocalBotReplyResponse>;
  sendMediaFiles: (
    chatId: number,
    files: Array<File | Blob>,
    opts?: { caption?: string; hasSpoiler?: boolean; topicId?: number; replyToMsgId?: number },
  ) => Promise<MessageItem>;
  sendVoiceRecording: (
    chatId: number,
    rec: VoiceRecordingResult,
    topicId?: number,
  ) => Promise<MessageItem>;
  sendRoundVideoRecording: (
    chatId: number,
    rec: RoundVideoRecordingResult,
    topicId?: number,
  ) => Promise<MessageItem>;
  sendSticker: (chatId: number, sticker: StickerItemDto, topicId?: number) => Promise<MessageItem>;
  sendGif: (chatId: number, gif: GifResultDto, topicId?: number) => Promise<MessageItem>;
  clickInlineKeyboardButton: (
    chatId: number,
    messageId: number,
    callbackData: string,
  ) => Promise<string | undefined>;

  editMessage: (chatId: number, messageId: number, newText: string) => Promise<MessageItem>;
  deleteMessages: (chatId: number, messageIds: number[], forEveryone?: boolean) => Promise<void>;
  forwardMessages: (
    fromChatId: number,
    toChatId: number,
    messageIds: number[],
    opts?: { hideSender?: boolean; comment?: string },
  ) => Promise<MessageItem[]>;
  pinMessage: (chatId: number, messageId: number, pinned: boolean) => Promise<void>;
  markChatRead: (chatId: number, maxId?: number) => Promise<void>;
  sendTyping: (chatId: number, action?: TypingAction) => Promise<void>;
  toggleReaction: (chatId: number, messageId: number, emoji: string) => Promise<void>;
  fetchReactionDetails: (chatId: number, messageId: number) => Promise<ReactionDetail[]>;

  createPoll: (
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
  ) => Promise<MessageItem>;
  votePoll: (chatId: number, messageId: number, pollId: number, optionIds: number[]) => Promise<PollData>;
  closePoll: (chatId: number, messageId: number, pollId: number) => Promise<PollData>;
  createTodo: (chatId: number, title: string, items: string[], topicId?: number) => Promise<MessageItem>;
  toggleTodoItem: (chatId: number, messageId: number, itemId: string, completed?: boolean) => Promise<MessageItem>;
  createInvoice: (
    chatId: number,
    req: { title: string; description?: string; currency?: string; amount: number },
  ) => Promise<MessageItem>;
  payInvoice: (chatId: number, messageId: number) => Promise<{ paid: boolean; balance: number }>;

  saveDraft: (chatId: number, text: string, replyToMsgId?: number, quoteText?: string) => Promise<void>;
  updateChatSettings: (
    chatId: number,
    patch: Partial<{ isPinned: boolean; isArchived: boolean; isMuted: boolean; unreadMark: boolean; folderId: number | null }>,
  ) => Promise<ChatSummary>;
  setChatTtl: (chatId: number, ttlSeconds: number) => Promise<void>;
  createGroupOrChannel: (req: {
    title?: string;
    kind: 'group' | 'supergroup' | 'channel';
    about?: string;
    username?: string;
    isForum?: boolean;
    memberIds?: number[];
    memberUsernames?: string[];
    clientNonce?: string;
  }) => Promise<ChatSummary>;
  createSecretChat: (peerUserId: number, ttlSeconds?: number) => Promise<ChatSummary>;
  openSavedMessages: () => Promise<ChatSummary>;
  deleteOrLeaveChat: (chatId: number) => Promise<void>;
  clearChatHistory: (chatId: number, forEveryone?: boolean) => Promise<void>;

  upsertFolder: (folder: Partial<ChatFolder> & { title: string }) => Promise<ChatFolder>;
  deleteFolder: (folderId: number | string) => Promise<void>;
  createTopic: (chatId: number, title: string, iconEmoji?: string) => Promise<ForumTopic>;
  updateTopic: (
    chatId: number,
    topicId: number,
    patch: Partial<{ title: string; isClosed: boolean; isPinned: boolean }>,
  ) => Promise<ForumTopic>;
  deleteTopic: (chatId: number, topicId: number) => Promise<void>;

  loadContacts: () => Promise<UserProfile[]>;
  addContact: (req: { userId?: number; username?: string; phone?: string; firstName?: string; lastName?: string }) => Promise<UserProfile>;
  deleteContact: (userId: number) => Promise<void>;
  resolveUsername: (username: string) => Promise<{ peerType: string; user?: UserProfile; chat?: ChatSummary }>;

  loadChatAdminData: (chatId: number) => Promise<void>;
  addChatMembers: (chatId: number, userIds: number[]) => Promise<void>;
  updateMemberRole: (chatId: number, userId: number, role: ChatMemberDto['role'], customTitle?: string) => Promise<void>;
  removeMember: (chatId: number, userId: number) => Promise<void>;
  createInviteLink: (chatId: number, title?: string) => Promise<InviteLinkDto>;
  revokeInviteLink: (chatId: number, code: string) => Promise<void>;
  joinByInvite: (code: string) => Promise<ChatSummary>;
  loadChannelStatistics: (chatId: number) => Promise<ChannelStatisticsDto>;

  loadStories: () => Promise<StoryGroup[]>;
  createStory: (req: { caption?: string; mediaFileId?: string; backgroundGradient?: string }) => Promise<StoryItem>;
  markStoryViewed: (storyId: string) => Promise<void>;

  loadStickersAndGifs: (gifQuery?: string) => Promise<void>;
  installStickerSet: (setId: string, install: boolean) => Promise<void>;
  searchGifs: (query: string) => Promise<GifResultDto[]>;

  searchGlobal: (query: string, tab?: SearchTabCategory) => Promise<GlobalSearchResponse | null>;
  searchInChat: (chatId: number, query: string) => Promise<SearchHitDto[]>;

  transcribeVoiceMessage: (fileId: string) => Promise<string>;
  runAiComposeAssist: (
    text: string,
    mode: 'improve' | 'shorter' | 'formal' | 'translate_zh' | 'translate_en',
  ) => Promise<string>;
  exportChatHistory: (chatId: number, format: 'json' | 'html') => Promise<{ fileName: string; content: string }>;

  updateMyProfile: (
    patch: Partial<{ firstName: string; lastName: string; username: string; bio: string; photoFileId: string }>,
  ) => Promise<UserProfile>;
  loadPrivacyAndBlocked: () => Promise<void>;
  updatePrivacy: (patch: Partial<UserPrivacySettingsDto>) => Promise<UserPrivacySettingsDto>;
  toggleBlockUser: (userId: number, blocked: boolean) => Promise<void>;

  bindRealtimeEvents: () => () => void;
  resetChatStore: () => void;
}

function sortChatIds(chatsById: Record<number, ChatSummary>): number[] {
  return Object.values(chatsById)
    .sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      return (b.lastMessageDateMs ?? 0) - (a.lastMessageDateMs ?? 0);
    })
    .map((c) => c.chatId);
}

function compareTimelineMessages(a: MessageItem, b: MessageItem): number {
  const aOpt = a.id < 0;
  const bOpt = b.id < 0;
  if (aOpt !== bOpt) return aOpt ? 1 : -1;
  if (aOpt && bOpt) {
    const dt = (a.date_ms ?? 0) - (b.date_ms ?? 0);
    return dt !== 0 ? dt : a.id - b.id;
  }
  return a.id - b.id;
}

function mergeMessageIntoTimeline(existing: MessageItem[], incoming: MessageItem): MessageItem[] {
  const enriched = enrichMessageItem(incoming);
  const idx = existing.findIndex(
    (m) =>
      m.id === enriched.id ||
      (enriched.client_nonce !== undefined &&
        m.client_nonce !== undefined &&
        m.client_nonce === enriched.client_nonce),
  );
  if (idx >= 0) {
    const next = [...existing];
    next[idx] = enriched;
    return next.sort(compareTimelineMessages);
  }
  return [...existing, enriched].sort(compareTimelineMessages);
}

let activeSelectSequence = 0;
let chatStoreAccountEpoch = 0;
let realtimeUnbindFn: (() => void) | null = null;

export const useChatStore = create<ChatState>((set, get) => {
  const tryDecryptMessages = async (chatId: number, msgs: MessageItem[]): Promise<void> => {
    const chat = get().chatsById[chatId];
    const me = useAuthStore.getState().currentUser;
    if (!chat?.isSecret || !me) return;
    const peerId = chat.peerUserId ?? 102;
    const updates: Record<string, string> = {};
    for (const msg of msgs) {
      if (msg.content.type === 'Encrypted') {
        const key = `${chatId}:${msg.id}`;
        if (get().decryptedSecretTexts[key]) continue;
        try {
          const dec = await decryptEnvelope({
            localUserId: me.userId,
            chatId,
            peerUserId: peerId,
            envelope: msg.content.data,
          });
          updates[key] = dec.text;
        } catch {
          updates[key] = '🔐 Encrypted Message';
        }
      }
    }
    if (Object.keys(updates).length > 0) {
      set((prev) => ({
        decryptedSecretTexts: { ...prev.decryptedSecretTexts, ...updates },
      }));
    }
  };

  return {
    chatsById: {},
    orderedChatIds: [],
    activeChatId: null,
    activeTopicId: null,
    activeFolderId: 'all',
    showArchived: false,

    messagesByChat: {},
    hasMoreByChat: {},
    pinnedByChat: {},
    topicsByChat: {},
    folders: [],
    draftsByChat: {},

    replyTargetByChat: {},
    editingMessageByChat: {},
    selectedMessageIds: [],
    isMultiSelectMode: false,

    peersById: {},
    contacts: [],
    blockedUsers: [],
    privacySettings: null,
    membersByChat: {},
    invitesByChat: {},
    statsByChat: {},

    storyGroups: [],
    stickerSets: [],
    gifResults: [],

    globalSearchQuery: '',
    globalSearchTab: 'chats',
    globalSearchResults: null,
    inChatSearchQuery: '',
    inChatSearchHits: [],

    typingByChat: {},
    decryptedSecretTexts: {},
    voiceTranscripts: {},

    roomAgentStateByChat: {},
    botActivityByChat: {},
    agentFloorByChat: {},
    agentWorkspaceByChat: {},
    lastAgentHandoffByChat: {},

    isLoadingChats: false,
    isLoadingMessages: false,
    uploadProgress: null,
    connectionState: 'disconnected',
    pendingOutboxCount: 0,

    bootstrapChats: async () => {
      const adapter = getClientAdapter();
      const accountId = useAuthStore.getState().activeAccountId ?? 'default';
      const epoch = chatStoreAccountEpoch;
      set({ isLoadingChats: true, connectionState: adapter.getConnectionState() });

      // Hydrate instant IndexedDB cache strictly scoped to current account & epoch
      const cachedChats = await indexedDbCache.loadChats(accountId).catch(() => []);
      if (
        epoch === chatStoreAccountEpoch &&
        useAuthStore.getState().activeAccountId === accountId &&
        cachedChats.length > 0 &&
        Object.keys(get().chatsById).length === 0
      ) {
        const map: Record<number, ChatSummary> = {};
        for (const c of cachedChats) map[c.chatId] = c;
        set({ chatsById: map, orderedChatIds: sortChatIds(map) });
      }

      try {
        const [{ chats, users }, folders, stories, outbox] = await Promise.all([
          adapter.listChats(),
          adapter.listFolders().catch(() => [] as ChatFolder[]),
          adapter.listStories().catch(() => [] as StoryGroup[]),
          indexedDbCache.listOutbox(accountId).catch(() => []),
        ]);

        if (epoch !== chatStoreAccountEpoch) return;

        // Always overwrite with authoritative server list (even when chats is empty!)
        const chatsById: Record<number, ChatSummary> = {};
        const draftsByChat: Record<number, DraftState> = {};
        for (const c of chats) {
          chatsById[c.chatId] = c;
          if (c.draft) draftsByChat[c.chatId] = c.draft;
        }
        const peersById: Record<number, UserProfile> = {};
        for (const u of [...users, ...adapter.getDiscoveredPeers()]) {
          peersById[u.userId] = u;
        }

        const currentActive = get().activeChatId;
        const validActive = currentActive !== null && chatsById[currentActive] ? currentActive : null;

        set({
          chatsById,
          orderedChatIds: sortChatIds(chatsById),
          activeChatId: validActive,
          peersById,
          folders,
          storyGroups: stories,
          draftsByChat,
          pendingOutboxCount: outbox.length,
          isLoadingChats: false,
        });

        if (validActive === null && typeof sessionStorage !== 'undefined') {
          try {
            const savedRaw = sessionStorage.getItem('gpui_tg_active_chat_id');
            const savedId = savedRaw ? Number(savedRaw) : NaN;
            if (Number.isFinite(savedId) && chatsById[savedId]) {
              void get().selectChat(savedId);
            }
          } catch {
            // Ignore sessionStorage restrictions
          }
        }
      } catch {
        if (epoch === chatStoreAccountEpoch) {
          set({ isLoadingChats: false });
        }
      }
    },

    selectChat: async (chatId, topicId = null) => {
      const prevChatId = get().activeChatId;
      if (prevChatId !== chatId) {
        useUiStore.getState().clearToastsForChat(prevChatId);
      }
      const seq = ++activeSelectSequence;
      const epoch = chatStoreAccountEpoch;
      if (chatId === null) {
        if (typeof sessionStorage !== 'undefined') {
          try {
            sessionStorage.removeItem('gpui_tg_active_chat_id');
          } catch {
            // Ignore
          }
        }
        set({
          activeChatId: null,
          activeTopicId: null,
          selectedMessageIds: [],
          isMultiSelectMode: false,
        });
        return;
      }

      if (typeof sessionStorage !== 'undefined') {
        try {
          sessionStorage.setItem('gpui_tg_active_chat_id', String(chatId));
        } catch {
          // Ignore
        }
      }

      set({
        activeChatId: chatId,
        activeTopicId: topicId,
        isLoadingMessages: true,
        selectedMessageIds: [],
        isMultiSelectMode: false,
        inChatSearchHits: [],
      });

      const adapter = getClientAdapter();
      const accountId = useAuthStore.getState().activeAccountId ?? 'default';

      const cached = await indexedDbCache.loadChatMessages(accountId, chatId).catch(() => []);
      if (
        seq === activeSelectSequence &&
        epoch === chatStoreAccountEpoch &&
        cached.length > 0 &&
        !get().messagesByChat[chatId]?.length
      ) {
        set((prev) => ({
          messagesByChat: { ...prev.messagesByChat, [chatId]: cached },
        }));
      }

      try {
        const [msgRes, pinned, topics] = await Promise.all([
          adapter.listMessages(chatId, { limit: 60, topicId: topicId ?? undefined }),
          adapter.listPinnedMessages(chatId, topicId ?? undefined).catch(() => [] as MessageItem[]),
          get().chatsById[chatId]?.isForum
            ? adapter.listForumTopics(chatId).catch(() => [] as ForumTopic[])
            : Promise.resolve(get().topicsByChat[chatId] ?? []),
        ]);

        if (seq !== activeSelectSequence || epoch !== chatStoreAccountEpoch) return;

        const sorted = [...msgRes.messages].map(enrichMessageItem).sort((a, b) => a.id - b.id);
        set((prev) => ({
          messagesByChat: { ...prev.messagesByChat, [chatId]: sorted },
          hasMoreByChat: { ...prev.hasMoreByChat, [chatId]: msgRes.hasMore },
          pinnedByChat: { ...prev.pinnedByChat, [chatId]: pinned },
          topicsByChat: { ...prev.topicsByChat, [chatId]: topics },
          isLoadingMessages: false,
        }));

        void tryDecryptMessages(chatId, sorted);

        const lastMsg = sorted[sorted.length - 1];
        if (lastMsg && (get().chatsById[chatId]?.unreadCount ?? 0) > 0) {
          void get().markChatRead(chatId, lastMsg.id);
        }
      } catch {
        if (seq === activeSelectSequence && epoch === chatStoreAccountEpoch) {
          set({ isLoadingMessages: false });
        }
      }
    },

    setActiveFolder: (activeFolderId) => set({ activeFolderId, showArchived: false }),
    setShowArchived: (showArchived) => set({ showArchived }),

    loadOlderMessages: async (chatId) => {
      const current = get().messagesByChat[chatId] ?? [];
      const oldestId = current[0]?.id;
      const res = await getClientAdapter().listMessages(chatId, {
        limit: 50,
        beforeId: oldestId,
        topicId: get().activeTopicId ?? undefined,
      });
      let merged = [...current];
      for (const m of res.messages) {
        merged = mergeMessageIntoTimeline(merged, m);
      }
      set((prev) => ({
        messagesByChat: { ...prev.messagesByChat, [chatId]: merged },
        hasMoreByChat: { ...prev.hasMoreByChat, [chatId]: res.hasMore },
      }));
      void tryDecryptMessages(chatId, res.messages);
      return res.hasMore;
    },

    setReplyTarget: (chatId, target) =>
      set((prev) => ({
        replyTargetByChat: { ...prev.replyTargetByChat, [chatId]: target },
      })),

    setEditingMessage: (chatId, message) =>
      set((prev) => ({
        editingMessageByChat: { ...prev.editingMessageByChat, [chatId]: message },
      })),

    toggleMessageSelection: (messageId, force) =>
      set((prev) => {
        const exists = prev.selectedMessageIds.includes(messageId);
        const shouldSelect = force ?? !exists;
        const next = shouldSelect
          ? exists
            ? prev.selectedMessageIds
            : [...prev.selectedMessageIds, messageId]
          : prev.selectedMessageIds.filter((id) => id !== messageId);
        return {
          selectedMessageIds: next,
          isMultiSelectMode: next.length > 0,
        };
      }),

    clearMultiSelect: () => set({ selectedMessageIds: [], isMultiSelectMode: false }),

    sendText: async (chatId, rawText, opts) => {
      markLocalTabSend(chatId);
      const adapter = getClientAdapter();
      const chat = get().chatsById[chatId];
      const replyState = get().replyTargetByChat[chatId];
      const parsed = parseMarkdownEntities(rawText);
      const cleanText = opts?.entities ? rawText : parsed.text;
      const entities = opts?.entities ?? parsed.entities;
      const clientNonce = Math.floor(Date.now() * 100 + Math.random() * 99);

      let content: MessageContent = createTextContent(cleanText, entities);
      if (chat?.isSecret) {
        const me = useAuthStore.getState().currentUser;
        const peerId = chat.peerUserId ?? 102;
        const bundlesRes = await adapter.getUserPreKeyBundles(peerId).catch(() => ({ devices: [] }));
        const encrypted = await encryptEnvelope({
          localUserId: me?.userId ?? 1,
          chatId,
          peerUserId: peerId,
          plaintext: cleanText,
          ttlSeconds: opts?.ttlSeconds ?? chat.ttlSeconds,
          remoteBundles: bundlesRes.devices,
        });
        content = { type: 'Encrypted', data: encrypted.envelope };
      }

      const res = await adapter.sendMessage({
        chatId,
        text: chat?.isSecret ? '🔐 Encrypted Message' : cleanText,
        entities: chat?.isSecret ? [] : entities,
        content,
        replyToMsgId: opts?.replyToMsgId ?? replyState?.messageId,
        quoteText: opts?.quoteText ?? replyState?.quoteText,
        topicId: opts?.topicId ?? get().activeTopicId ?? undefined,
        clientNonce,
        silent: opts?.silent,
        scheduleAtMs: opts?.scheduleAtMs,
        ttlSeconds: opts?.ttlSeconds ?? chat?.ttlSeconds,
        skipServerBotReply: opts?.skipServerBotReply,
      });

      const msg = enrichMessageItem(res.message);
      set((prev) => {
        const prevMsgs = prev.messagesByChat[chatId] ?? [];
        const updatedChat = prev.chatsById[chatId]
          ? {
              ...prev.chatsById[chatId]!,
              lastMessageId: msg.id,
              lastMessageDateMs: msg.date_ms ?? Date.now(),
              lastMessagePreview: chat?.isSecret ? '🔐 Encrypted Message' : cleanText,
              draft: null,
            }
          : undefined;
        const nextChats = updatedChat
          ? { ...prev.chatsById, [chatId]: updatedChat }
          : prev.chatsById;
        const nextDrafts = { ...prev.draftsByChat };
        delete nextDrafts[chatId];
        return {
          messagesByChat: {
            ...prev.messagesByChat,
            [chatId]: mergeMessageIntoTimeline(prevMsgs, msg),
          },
          chatsById: nextChats,
          orderedChatIds: sortChatIds(nextChats),
          draftsByChat: nextDrafts,
          replyTargetByChat: { ...prev.replyTargetByChat, [chatId]: null },
          decryptedSecretTexts: chat?.isSecret
            ? { ...prev.decryptedSecretTexts, [`${chatId}:${msg.id}`]: cleanText }
            : prev.decryptedSecretTexts,
        };
      });

      return msg;
    },

    archiveLocalBotReply: async (chatId, req) => {
      return getServerAdapter().archiveLocalBotReply(chatId, req);
    },

    sendMediaFiles: async (chatId, files, opts) => {
      markLocalTabSend(chatId);
      const adapter = getClientAdapter();
      if (files.length === 0) throw new Error('No media files selected');
      set({ uploadProgress: 0 });

      try {
        if (files.length > 1) {
          const albumItems: AlbumMediaItem[] = [];
          const slice = files.slice(0, 10);
          for (let i = 0; i < slice.length; i++) {
            const f = slice[i]!;
            const fileName = f instanceof File ? f.name : `media_${i + 1}.bin`;
            const uploaded = await adapter.uploadMedia(
              f,
              { fileName, mimeType: f.type || 'image/png', width: 800, height: 600 },
              (pct) => set({ uploadProgress: Math.round(((i + pct / 100) / slice.length) * 100) }),
            );
            albumItems.push({
              file_id: uploaded.file_id,
              mime_type: uploaded.mime_type,
              width: uploaded.width ?? 800,
              height: uploaded.height ?? 600,
              size_bytes: uploaded.size_bytes,
              has_spoiler: opts?.hasSpoiler,
              caption: i === 0 ? opts?.caption : undefined,
            });
          }
          const res = await adapter.sendMessage({
            chatId,
            text: opts?.caption ?? `🖼️ Album (${albumItems.length})`,
            content: {
              type: 'Album',
              data: { items: albumItems, caption: opts?.caption },
            },
            topicId: opts?.topicId ?? get().activeTopicId ?? undefined,
            replyToMsgId: opts?.replyToMsgId,
          });
          set((prev) => ({
            uploadProgress: null,
            messagesByChat: {
              ...prev.messagesByChat,
              [chatId]: mergeMessageIntoTimeline(prev.messagesByChat[chatId] ?? [], res.message),
            },
          }));
          return res.message;
        }

        const f = files[0]!;
        const fileName = f instanceof File ? f.name : 'attachment.bin';
        const mime = f.type || 'application/octet-stream';
        const uploaded = await adapter.uploadMedia(
          f,
          { fileName, mimeType: mime, width: 800, height: 600 },
          (pct) => set({ uploadProgress: pct }),
        );

        let content: MessageContent;
        if (mime.startsWith('image/')) {
          content = {
            type: 'Photo',
            data: {
              file_id: uploaded.file_id,
              caption: opts?.caption ?? null,
              width: uploaded.width ?? 800,
              height: uploaded.height ?? 600,
              has_spoiler: opts?.hasSpoiler,
            },
          };
        } else if (mime.startsWith('video/')) {
          content = {
            type: 'Video',
            data: {
              file_id: uploaded.file_id,
              duration: uploaded.duration_seconds ?? 5,
              width: uploaded.width ?? 800,
              height: uploaded.height ?? 450,
              caption: opts?.caption ?? null,
              has_spoiler: opts?.hasSpoiler,
            },
          };
        } else if (mime.startsWith('audio/')) {
          content = {
            type: 'Audio',
            data: {
              file_id: uploaded.file_id,
              duration: uploaded.duration_seconds ?? 15,
              title: fileName,
              performer: null,
              size_bytes: uploaded.size_bytes,
            },
          };
        } else {
          content = {
            type: 'Document',
            data: {
              file_id: uploaded.file_id,
              file_name: fileName,
              mime_type: mime,
              size_bytes: uploaded.size_bytes,
              caption: opts?.caption,
            },
          };
        }

        const res = await adapter.sendMessage({
          chatId,
          text: opts?.caption ?? fileName,
          content,
          topicId: opts?.topicId ?? get().activeTopicId ?? undefined,
          replyToMsgId: opts?.replyToMsgId,
        });

        set((prev) => ({
          uploadProgress: null,
          messagesByChat: {
            ...prev.messagesByChat,
            [chatId]: mergeMessageIntoTimeline(prev.messagesByChat[chatId] ?? [], res.message),
          },
        }));
        return res.message;
      } catch (err) {
        set({ uploadProgress: null });
        throw err;
      }
    },

    sendVoiceRecording: async (chatId, rec, topicId) => {
      const adapter = getClientAdapter();
      const uploaded = await adapter.uploadMedia(rec.blob, {
        fileName: rec.fileName,
        mimeType: rec.mimeType,
        durationSecs: rec.durationSeconds,
        waveform: rec.waveformBars,
      });
      const res = await adapter.sendMessage({
        chatId,
        text: '🎤 Voice message',
        topicId: topicId ?? get().activeTopicId ?? undefined,
        content: {
          type: 'Voice',
          data: {
            file_id: uploaded.file_id,
            duration_seconds: rec.durationSeconds,
            waveform: rec.waveformBars,
            waveform_b64: rec.waveformBase64,
            mime_type: rec.mimeType,
            size_bytes: uploaded.size_bytes,
          },
        },
      });
      set((prev) => ({
        messagesByChat: {
          ...prev.messagesByChat,
          [chatId]: mergeMessageIntoTimeline(prev.messagesByChat[chatId] ?? [], res.message),
        },
      }));
      return res.message;
    },

    sendRoundVideoRecording: async (chatId, rec, topicId) => {
      const adapter = getClientAdapter();
      const uploaded = await adapter.uploadMedia(rec.blob, {
        fileName: rec.fileName,
        mimeType: rec.mimeType,
        width: rec.width,
        height: rec.height,
        durationSecs: rec.durationSeconds,
      });
      const res = await adapter.sendMessage({
        chatId,
        text: '⭕ Video message',
        topicId: topicId ?? get().activeTopicId ?? undefined,
        content: {
          type: 'VideoNote',
          data: {
            file_id: uploaded.file_id,
            duration_seconds: rec.durationSeconds,
            diameter: rec.width || 240,
            size_bytes: uploaded.size_bytes,
          },
        },
      });
      set((prev) => ({
        messagesByChat: {
          ...prev.messagesByChat,
          [chatId]: mergeMessageIntoTimeline(prev.messagesByChat[chatId] ?? [], res.message),
        },
      }));
      return res.message;
    },

    sendSticker: async (chatId, sticker, topicId) => {
      const res = await getClientAdapter().sendMessage({
        chatId,
        text: `${sticker.emoji} Sticker`,
        topicId: topicId ?? get().activeTopicId ?? undefined,
        content: {
          type: 'Sticker',
          data: {
            file_id: sticker.file_id ?? sticker.svg_data_url ?? sticker.id,
            emoji: sticker.emoji,
            set_id: sticker.set_id,
            width: sticker.width,
            height: sticker.height,
            is_animated: sticker.is_animated,
          },
        },
      });
      set((prev) => ({
        messagesByChat: {
          ...prev.messagesByChat,
          [chatId]: mergeMessageIntoTimeline(prev.messagesByChat[chatId] ?? [], res.message),
        },
      }));
      return res.message;
    },

    sendGif: async (chatId, gif, topicId) => {
      const res = await getClientAdapter().sendMessage({
        chatId,
        text: `GIF · ${gif.title}`,
        topicId: topicId ?? get().activeTopicId ?? undefined,
        content: {
          type: 'Gif',
          data: {
            file_id: gif.file_id,
            url: gif.url,
            width: gif.width,
            height: gif.height,
            caption: gif.title,
          },
        },
      });
      set((prev) => ({
        messagesByChat: {
          ...prev.messagesByChat,
          [chatId]: mergeMessageIntoTimeline(prev.messagesByChat[chatId] ?? [], res.message),
        },
      }));
      return res.message;
    },

    clickInlineKeyboardButton: async (chatId, messageId, callbackData) => {
      const adapter = getClientAdapter();
      if (!adapter.sendCallbackQuery) return undefined;
      const res = await adapter.sendCallbackQuery(chatId, messageId, callbackData);
      if (res.message) {
        set((prev) => ({
          messagesByChat: {
            ...prev.messagesByChat,
            [chatId]: mergeMessageIntoTimeline(prev.messagesByChat[chatId] ?? [], res.message!),
          },
        }));
      }
      return res.answerText;
    },

    editMessage: async (chatId, messageId, newText) => {
      const parsed = parseMarkdownEntities(newText);
      const res = await getClientAdapter().editMessage(
        chatId,
        messageId,
        parsed.text,
        parsed.entities,
      );
      set((prev) => ({
        messagesByChat: {
          ...prev.messagesByChat,
          [chatId]: mergeMessageIntoTimeline(prev.messagesByChat[chatId] ?? [], res.message),
        },
        editingMessageByChat: { ...prev.editingMessageByChat, [chatId]: null },
      }));
      return res.message;
    },

    deleteMessages: async (chatId, messageIds, forEveryone = true) => {
      await getClientAdapter().deleteMessages(chatId, messageIds, forEveryone);
      const idSet = new Set(messageIds);
      set((prev) => ({
        messagesByChat: {
          ...prev.messagesByChat,
          [chatId]: (prev.messagesByChat[chatId] ?? []).filter((m) => !idSet.has(m.id)),
        },
        pinnedByChat: {
          ...prev.pinnedByChat,
          [chatId]: (prev.pinnedByChat[chatId] ?? []).filter((m) => !idSet.has(m.id)),
        },
        selectedMessageIds: [],
        isMultiSelectMode: false,
      }));
    },

    forwardMessages: async (fromChatId, toChatId, messageIds, opts) => {
      const forwarded = await getClientAdapter().forwardMessages(
        fromChatId,
        toChatId,
        messageIds,
        opts,
      );
      set((prev) => {
        let timeline = prev.messagesByChat[toChatId] ?? [];
        for (const m of forwarded) {
          timeline = mergeMessageIntoTimeline(timeline, m);
        }
        return {
          messagesByChat: { ...prev.messagesByChat, [toChatId]: timeline },
          selectedMessageIds: [],
          isMultiSelectMode: false,
        };
      });
      return forwarded;
    },

    pinMessage: async (chatId, messageId, pinned) => {
      const adapter = getClientAdapter();
      const pinnedIds = await adapter.pinMessage(chatId, messageId, pinned);
      const pinnedList = await adapter.listPinnedMessages(chatId).catch(() => [] as MessageItem[]);
      set((prev) => ({
        pinnedByChat: { ...prev.pinnedByChat, [chatId]: pinnedList },
        chatsById: prev.chatsById[chatId]
          ? {
              ...prev.chatsById,
              [chatId]: { ...prev.chatsById[chatId]!, pinnedMessageIds: pinnedIds },
            }
          : prev.chatsById,
      }));
    },

    markChatRead: async (chatId, maxId) => {
      const msgs = get().messagesByChat[chatId] ?? [];
      const targetMax = maxId ?? msgs[msgs.length - 1]?.id ?? get().chatsById[chatId]?.lastMessageId ?? 0;
      const res = await getClientAdapter().readHistory(chatId, targetMax);
      set((prev) => ({
        chatsById: prev.chatsById[chatId]
          ? {
              ...prev.chatsById,
              [chatId]: {
                ...prev.chatsById[chatId]!,
                unreadCount: res.unreadCount,
                unreadMark: false,
                readInboxMaxId: Math.max(prev.chatsById[chatId]!.readInboxMaxId, targetMax),
              },
            }
          : prev.chatsById,
      }));
    },

    sendTyping: async (chatId, action = 'typing') => {
      await getClientAdapter()
        .sendTyping(chatId, action, get().activeTopicId ?? undefined)
        .catch(() => undefined);
    },

    toggleReaction: async (chatId, messageId, emoji) => {
      const reactions = await getClientAdapter().toggleReaction(chatId, messageId, emoji);
      set((prev) => ({
        messagesByChat: {
          ...prev.messagesByChat,
          [chatId]: (prev.messagesByChat[chatId] ?? []).map((m) =>
            m.id === messageId ? { ...m, reactions } : m,
          ),
        },
      }));
    },

    fetchReactionDetails: (chatId, messageId) =>
      getClientAdapter().getReactionDetails(chatId, messageId),

    createPoll: async (chatId, req) => {
      const res = await getClientAdapter().createPoll(chatId, req);
      set((prev) => ({
        messagesByChat: {
          ...prev.messagesByChat,
          [chatId]: mergeMessageIntoTimeline(prev.messagesByChat[chatId] ?? [], res.message),
        },
      }));
      return res.message;
    },

    votePoll: async (chatId, messageId, pollId, optionIds) => {
      const updated = await getClientAdapter().votePoll(pollId, optionIds);
      set((prev) => ({
        messagesByChat: {
          ...prev.messagesByChat,
          [chatId]: (prev.messagesByChat[chatId] ?? []).map((m) =>
            m.id === messageId && m.content.type === 'Poll'
              ? { ...m, content: { type: 'Poll', data: updated } }
              : m,
          ),
        },
      }));
      return updated;
    },

    closePoll: async (chatId, messageId, pollId) => {
      const updated = await getClientAdapter().closePoll(pollId);
      set((prev) => ({
        messagesByChat: {
          ...prev.messagesByChat,
          [chatId]: (prev.messagesByChat[chatId] ?? []).map((m) =>
            m.id === messageId && m.content.type === 'Poll'
              ? { ...m, content: { type: 'Poll', data: updated } }
              : m,
          ),
        },
      }));
      return updated;
    },

    createTodo: async (chatId, title, items, topicId) => {
      const msg = await getClientAdapter().createTodo(chatId, { title, items, topicId });
      set((prev) => ({
        messagesByChat: {
          ...prev.messagesByChat,
          [chatId]: mergeMessageIntoTimeline(prev.messagesByChat[chatId] ?? [], msg),
        },
      }));
      return msg;
    },

    toggleTodoItem: async (chatId, messageId, itemId, completed) => {
      const updated = await getClientAdapter().toggleTodoItem(chatId, messageId, itemId, completed);
      set((prev) => ({
        messagesByChat: {
          ...prev.messagesByChat,
          [chatId]: mergeMessageIntoTimeline(prev.messagesByChat[chatId] ?? [], updated),
        },
      }));
      return updated;
    },

    createInvoice: async (chatId, req) => {
      const res = await getClientAdapter().createInvoice(chatId, req);
      set((prev) => ({
        messagesByChat: {
          ...prev.messagesByChat,
          [chatId]: mergeMessageIntoTimeline(prev.messagesByChat[chatId] ?? [], res.message),
        },
      }));
      return res.message;
    },

    payInvoice: async (chatId, messageId) => {
      const res = await getClientAdapter().payInvoice(chatId, messageId);
      set((prev) => {
        let msgs = (prev.messagesByChat[chatId] ?? []).map((m) =>
          m.id === messageId && m.content.type === 'Invoice'
            ? {
                ...m,
                content: {
                  type: 'Invoice' as const,
                  data: { ...m.content.data, is_paid: true, status: 'paid' as const },
                },
              }
            : m,
        );
        if (res.receiptMessage) {
          msgs = mergeMessageIntoTimeline(msgs, res.receiptMessage);
        }
        return {
          messagesByChat: { ...prev.messagesByChat, [chatId]: msgs },
        };
      });
      return { paid: res.paid, balance: res.balance };
    },

    saveDraft: async (chatId, text, replyToMsgId, quoteText) => {
      const draft: DraftState | null = text.trim() || replyToMsgId
        ? {
            chatId,
            text,
            entities: [],
            replyToMsgId,
            quoteText,
            topicId: get().activeTopicId ?? undefined,
            dateMs: Date.now(),
          }
        : null;
      set((prev) => {
        const nextDrafts = { ...prev.draftsByChat };
        if (draft) nextDrafts[chatId] = draft;
        else delete nextDrafts[chatId];
        return { draftsByChat: nextDrafts };
      });
      await getClientAdapter().saveDraft(chatId, draft).catch(() => undefined);
    },

    updateChatSettings: async (chatId, patch) => {
      const updated = await getClientAdapter().updateChatSettings(chatId, patch);
      set((prev) => {
        const nextChats = { ...prev.chatsById, [chatId]: updated };
        return {
          chatsById: nextChats,
          orderedChatIds: sortChatIds(nextChats),
        };
      });
      return updated;
    },

    setChatTtl: async (chatId, ttlSeconds) => {
      await getClientAdapter().setChatTtl(chatId, ttlSeconds);
      set((prev) => ({
        chatsById: prev.chatsById[chatId]
          ? { ...prev.chatsById, [chatId]: { ...prev.chatsById[chatId]!, ttlSeconds } }
          : prev.chatsById,
      }));
    },

    createGroupOrChannel: async (req) => {
      const chatType = req.kind === 'channel' ? 3 : req.kind === 'supergroup' || req.isForum ? 2 : 1;
      const clientNonce =
        req.clientNonce ??
        (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `chat_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
      const created = await getServerAdapter().createChat({
        title: req.title ?? '',
        chatType,
        about: req.about,
        username: req.username,
        isForum: req.isForum,
        memberIds: req.memberIds,
        memberUsernames: req.memberUsernames,
        clientNonce,
      });
      set((prev) => {
        const nextChats = { ...prev.chatsById, [created.chatId]: created };
        return {
          chatsById: nextChats,
          orderedChatIds: sortChatIds(nextChats),
          activeChatId: created.chatId,
        };
      });
      return created;
    },

    createSecretChat: async (peerUserId, ttlSeconds = 30) => {
      const adapter = getClientAdapter();
      const me = useAuthStore.getState().currentUser;
      const [created, bundlesRes] = await Promise.all([
        adapter.createSecretChat(peerUserId, ttlSeconds),
        adapter.getUserPreKeyBundles(peerUserId).catch(() => ({ devices: [] })),
      ]);
      const mat = await ensureSecretChatKeyMaterial({
        localUserId: me?.userId ?? 1,
        chatId: created.chatId,
        peerUserId,
        remoteBundles: bundlesRes.devices,
      });
      const withFp: ChatSummary = {
        ...created,
        emojiFingerprint: mat.safetyEmojis,
      };
      set((prev) => {
        const nextChats = { ...prev.chatsById, [withFp.chatId]: withFp };
        return {
          chatsById: nextChats,
          orderedChatIds: sortChatIds(nextChats),
          activeChatId: withFp.chatId,
        };
      });
      return withFp;
    },

    openSavedMessages: async () => {
      const saved = await getClientAdapter().openSavedMessages();
      set((prev) => {
        const nextChats = { ...prev.chatsById, [saved.chatId]: saved };
        return {
          chatsById: nextChats,
          orderedChatIds: sortChatIds(nextChats),
        };
      });
      await get().selectChat(saved.chatId);
      return saved;
    },

    deleteOrLeaveChat: async (chatId) => {
      await getClientAdapter().deleteOrLeaveChat(chatId);
      if (typeof sessionStorage !== 'undefined') {
        try {
          if (sessionStorage.getItem('gpui_tg_active_chat_id') === String(chatId)) {
            sessionStorage.removeItem('gpui_tg_active_chat_id');
          }
        } catch {
          // Ignore
        }
      }
      set((prev) => {
        const nextChats = { ...prev.chatsById };
        delete nextChats[chatId];
        return {
          chatsById: nextChats,
          orderedChatIds: sortChatIds(nextChats),
          activeChatId: prev.activeChatId === chatId ? null : prev.activeChatId,
        };
      });
    },

    clearChatHistory: async (chatId, forEveryone = true) => {
      await getClientAdapter().clearChatHistory?.(chatId, forEveryone);
      set((prev) => ({
        messagesByChat: { ...prev.messagesByChat, [chatId]: [] },
      }));
    },

    upsertFolder: async (folder) => {
      const saved = await getClientAdapter().upsertFolder(folder);
      set((prev) => {
        const idx = prev.folders.findIndex((f) => f.id === saved.id);
        const next = idx >= 0 ? prev.folders.map((f, i) => (i === idx ? saved : f)) : [...prev.folders, saved];
        return { folders: next };
      });
      return saved;
    },

    deleteFolder: async (folderId) => {
      await getClientAdapter().deleteFolder(folderId);
      set((prev) => ({
        folders: prev.folders.filter(
          (f) => String(f.id) !== String(folderId) && f.folderId !== String(folderId),
        ),
        activeFolderId:
          String(prev.activeFolderId) === String(folderId) ? 'all' : prev.activeFolderId,
      }));
    },

    createTopic: async (chatId, title, iconEmoji) => {
      const topic = await getClientAdapter().createForumTopic(chatId, { title, iconEmoji });
      set((prev) => ({
        topicsByChat: {
          ...prev.topicsByChat,
          [chatId]: [...(prev.topicsByChat[chatId] ?? []), topic],
        },
      }));
      return topic;
    },

    updateTopic: async (chatId, topicId, patch) => {
      const updated = await getClientAdapter().updateForumTopic(chatId, topicId, patch);
      set((prev) => ({
        topicsByChat: {
          ...prev.topicsByChat,
          [chatId]: (prev.topicsByChat[chatId] ?? []).map((t) =>
            t.topicId === topicId ? updated : t,
          ),
        },
      }));
      return updated;
    },

    deleteTopic: async (chatId, topicId) => {
      await getClientAdapter().deleteForumTopic(chatId, topicId);
      set((prev) => ({
        topicsByChat: {
          ...prev.topicsByChat,
          [chatId]: (prev.topicsByChat[chatId] ?? []).filter((t) => t.topicId !== topicId),
        },
        activeTopicId: prev.activeTopicId === topicId ? null : prev.activeTopicId,
      }));
    },

    loadContacts: async () => {
      const contacts = await getClientAdapter().listContacts();
      set((prev) => {
        const nextPeers = { ...prev.peersById };
        for (const c of contacts) nextPeers[c.userId] = c;
        return { contacts, peersById: nextPeers };
      });
      return contacts;
    },

    addContact: async (req) => {
      const user = await getClientAdapter().addContact(req);
      set((prev) => ({
        contacts: [user, ...prev.contacts.filter((c) => c.userId !== user.userId)],
        peersById: { ...prev.peersById, [user.userId]: user },
      }));
      return user;
    },

    deleteContact: async (userId) => {
      await getClientAdapter().deleteContact(userId);
      set((prev) => ({
        contacts: prev.contacts.filter((c) => c.userId !== userId),
      }));
    },

    resolveUsername: (username) => getClientAdapter().resolveUsername(username),

    loadChatAdminData: async (chatId) => {
      const adapter = getClientAdapter();
      const [memberRes, invites] = await Promise.all([
        adapter.listMembers(chatId).catch(() => ({ members: [] as ChatMemberDto[], users: [] as UserProfile[] })),
        adapter.listInviteLinks(chatId).catch(() => [] as InviteLinkDto[]),
      ]);
      set((prev) => {
        const nextPeers = { ...prev.peersById };
        for (const u of memberRes.users) nextPeers[u.userId] = u;
        return {
          membersByChat: { ...prev.membersByChat, [chatId]: memberRes.members },
          invitesByChat: { ...prev.invitesByChat, [chatId]: invites },
          peersById: nextPeers,
        };
      });
    },

    addChatMembers: async (chatId, userIds) => {
      await getClientAdapter().addMembers(chatId, userIds);
      await get().loadChatAdminData(chatId);
    },

    updateMemberRole: async (chatId, userId, role, customTitle) => {
      await getClientAdapter().updateMemberRole(chatId, userId, { role, customTitle });
      await get().loadChatAdminData(chatId);
    },

    removeMember: async (chatId, userId) => {
      await getClientAdapter().removeMember(chatId, userId);
      set((prev) => ({
        membersByChat: {
          ...prev.membersByChat,
          [chatId]: (prev.membersByChat[chatId] ?? []).filter((m) => m.user_id !== userId),
        },
      }));
    },

    createInviteLink: async (chatId, title) => {
      const link = await getClientAdapter().createInviteLink(chatId, { title });
      set((prev) => ({
        invitesByChat: {
          ...prev.invitesByChat,
          [chatId]: [link, ...(prev.invitesByChat[chatId] ?? [])],
        },
      }));
      return link;
    },

    revokeInviteLink: async (chatId, code) => {
      await getClientAdapter().revokeInviteLink(chatId, code);
      set((prev) => ({
        invitesByChat: {
          ...prev.invitesByChat,
          [chatId]: (prev.invitesByChat[chatId] ?? []).map((inv) =>
            inv.code === code ? { ...inv, is_revoked: true } : inv,
          ),
        },
      }));
    },

    joinByInvite: async (code) => {
      const chat = await getClientAdapter().joinByInvite(code);
      set((prev) => {
        const nextChats = { ...prev.chatsById, [chat.chatId]: chat };
        return {
          chatsById: nextChats,
          orderedChatIds: sortChatIds(nextChats),
          activeChatId: chat.chatId,
        };
      });
      return chat;
    },

    loadChannelStatistics: async (chatId) => {
      const stats = await getClientAdapter().getChannelStatistics(chatId);
      set((prev) => ({
        statsByChat: { ...prev.statsByChat, [chatId]: stats },
      }));
      return stats;
    },

    loadStories: async () => {
      const groups = await getClientAdapter().listStories();
      set({ storyGroups: groups });
      return groups;
    },

    createStory: async (req) => {
      const story = await getClientAdapter().createStory(req);
      await get().loadStories();
      return story;
    },

    markStoryViewed: async (storyId) => {
      const views = await getClientAdapter().markStoryViewed(storyId);
      set((prev) => ({
        storyGroups: prev.storyGroups.map((g) => ({
          ...g,
          stories: g.stories.map((s) =>
            s.storyId === storyId ? { ...s, isViewed: true, viewsCount: views } : s,
          ),
        })),
      }));
    },

    loadStickersAndGifs: async (gifQuery = '') => {
      const adapter = getClientAdapter();
      const [sets, gifs] = await Promise.all([
        adapter.listStickerSets().catch(() => [] as StickerSetDto[]),
        adapter.searchGifs(gifQuery).catch(() => [] as GifResultDto[]),
      ]);
      set({ stickerSets: sets, gifResults: gifs });
    },

    installStickerSet: async (setId, install) => {
      await getClientAdapter().installStickerSet(setId, install);
      set((prev) => ({
        stickerSets: prev.stickerSets.map((s) =>
          s.set_id === setId ? { ...s, is_installed: install } : s,
        ),
      }));
    },

    searchGifs: async (query) => {
      const gifs = await getClientAdapter().searchGifs(query);
      set({ gifResults: gifs });
      return gifs;
    },

    searchGlobal: async (query, tab) => {
      const activeTab = tab ?? get().globalSearchTab;
      set({ globalSearchQuery: query, globalSearchTab: activeTab });
      if (!query.trim()) {
        set({ globalSearchResults: null });
        return null;
      }
      const res = await getClientAdapter().searchGlobal(query, { tab: activeTab });
      set({ globalSearchResults: res });
      return res;
    },

    searchInChat: async (chatId, query) => {
      set({ inChatSearchQuery: query });
      if (!query.trim()) {
        set({ inChatSearchHits: [] });
        return [];
      }
      const hits = await getClientAdapter().searchMessages(chatId, query, {
        topicId: get().activeTopicId ?? undefined,
      });
      set({ inChatSearchHits: hits });
      return hits;
    },

    transcribeVoiceMessage: async (fileId) => {
      const text = await getClientAdapter().transcribeVoice(fileId);
      set((prev) => ({
        voiceTranscripts: { ...prev.voiceTranscripts, [fileId]: text },
      }));
      return text;
    },

    runAiComposeAssist: (text, mode) => getClientAdapter().aiComposeAssist(text, mode),

    exportChatHistory: async (chatId, format) => {
      const chat = get().chatsById[chatId];
      if (!chat) throw new Error(`Chat ${chatId} not found`);
      const messages = get().messagesByChat[chatId] ?? [];
      const serverRendered = await getClientAdapter()
        .exportChat(chatId, format)
        .catch(() => undefined);
      const out = exportAndDownloadChat(chat, messages, format, get().peersById, serverRendered);
      return { fileName: out.fileName, content: out.content };
    },

    updateMyProfile: async (patch) => {
      const updated = await getClientAdapter().updateProfile(patch);
      useAuthStore.setState({ currentUser: updated });
      set((prev) => ({
        peersById: { ...prev.peersById, [updated.userId]: updated },
      }));
      return updated;
    },

    loadPrivacyAndBlocked: async () => {
      const adapter = getClientAdapter();
      const [privacy, blocked] = await Promise.all([
        adapter.getPrivacySettings().catch(() => null),
        adapter.listBlockedUsers().catch(() => [] as UserProfile[]),
      ]);
      set({ privacySettings: privacy, blockedUsers: blocked });
    },

    updatePrivacy: async (patch) => {
      const updated = await getClientAdapter().updatePrivacySettings(patch);
      set({ privacySettings: updated });
      return updated;
    },

    toggleBlockUser: async (userId, blocked) => {
      await getClientAdapter().setBlockedUser(userId, blocked);
      await get().loadPrivacyAndBlocked();
    },

    bindRealtimeEvents: () => {
      realtimeUnbindFn?.();
      const adapter = getClientAdapter();

      const applyEvent = (event: UpdateEvent): void => {
        switch (event.type) {
          case 'NewMessage':
          case 'EditMessage': {
            const msg = enrichMessageItem(event.data);
            const cid = msg.chat_id;
            set((prev) => {
              const timeline = mergeMessageIntoTimeline(prev.messagesByChat[cid] ?? [], msg);
              const existingChat = prev.chatsById[cid];
              const isIncoming = !msg.flags?.is_out;
              const nextChats = existingChat
                ? {
                    ...prev.chatsById,
                    [cid]: {
                      ...existingChat,
                      lastMessageId: Math.max(existingChat.lastMessageId, msg.id),
                      lastMessageDateMs: msg.date_ms ?? Date.now(),
                      lastMessagePreview: extractPlainTextFromContent(msg.content),
                      unreadCount:
                        event.type === 'NewMessage' && isIncoming && prev.activeChatId !== cid
                          ? existingChat.unreadCount + 1
                          : existingChat.unreadCount,
                    },
                  }
                : prev.chatsById;
              return {
                messagesByChat: { ...prev.messagesByChat, [cid]: timeline },
                chatsById: nextChats,
                orderedChatIds: sortChatIds(nextChats),
              };
            });
            void tryDecryptMessages(cid, [msg]);
            break;
          }
          case 'DeleteMessages': {
            const rawCid = event.data.chat_id;
            const cid =
              typeof rawCid === 'number'
                ? rawCid
                : 'Chat' in rawCid
                  ? rawCid.Chat
                  : 'Channel' in rawCid
                    ? rawCid.Channel
                    : 'User' in rawCid
                      ? rawCid.User
                      : rawCid.Fake;
            const delSet = new Set(event.data.message_ids);
            if (!cid) break;
            set((prev) => ({
              messagesByChat: {
                ...prev.messagesByChat,
                [cid]: (prev.messagesByChat[cid] ?? []).filter((m: MessageItem) => !delSet.has(m.id)),
              },
            }));
            break;
          }
          case 'MessageReactions':
          case 'ReactionUpdated': {
            const { chat_id, message_id, reactions } = event.data;
            set((prev) => ({
              messagesByChat: {
                ...prev.messagesByChat,
                [chat_id]: (prev.messagesByChat[chat_id] ?? []).map((m) =>
                  m.id === message_id ? { ...m, reactions } : m,
                ),
              },
            }));
            break;
          }
          case 'ChatUpdated': {
            const mapped = mapChatDtoToDomain(event.data);
            set((prev) => {
              const nextChats = { ...prev.chatsById, [mapped.chatId]: mapped };
              return { chatsById: nextChats, orderedChatIds: sortChatIds(nextChats) };
            });
            break;
          }
          case 'UserUpdated': {
            const u = mapUserDtoToDomain(event.data);
            set((prev) => ({ peersById: { ...prev.peersById, [u.userId]: u } }));
            break;
          }
          case 'PollUpdated': {
            const { chat_id, message_id, poll } = event.data;
            set((prev) => ({
              messagesByChat: {
                ...prev.messagesByChat,
                [chat_id]: (prev.messagesByChat[chat_id] ?? []).map((m) =>
                  m.id === message_id ? { ...m, content: { type: 'Poll', data: poll } } : m,
                ),
              },
            }));
            break;
          }
          case 'TodoUpdated': {
            const { chat_id, message_id, todo } = event.data;
            set((prev) => ({
              messagesByChat: {
                ...prev.messagesByChat,
                [chat_id]: (prev.messagesByChat[chat_id] ?? []).map((m) =>
                  m.id === message_id ? { ...m, content: { type: 'Todo', data: todo } } : m,
                ),
              },
            }));
            break;
          }
          case 'ForumTopicChanged': {
            const topic = mapForumTopicDtoToDomain(event.data.topic);
            const cid = event.data.chat_id;
            set((prev) => {
              const cur = prev.topicsByChat[cid] ?? [];
              const idx = cur.findIndex((t) => t.topicId === topic.topicId);
              const next = idx >= 0 ? cur.map((t, i) => (i === idx ? topic : t)) : [...cur, topic];
              return { topicsByChat: { ...prev.topicsByChat, [cid]: next } };
            });
            break;
          }
          case 'FolderChanged': {
            const folder = mapChatFolderDtoToDomain(event.data.folder);
            set((prev) => {
              const idx = prev.folders.findIndex((f) => f.id === folder.id);
              const next = idx >= 0 ? prev.folders.map((f, i) => (i === idx ? folder : f)) : [...prev.folders, folder];
              return { folders: next };
            });
            break;
          }
          case 'StoryUpdated': {
            const story = mapStoryDtoToDomain(event.data.story);
            set((prev) => ({
              storyGroups: prev.storyGroups.map((g) =>
                g.userId === story.userId
                  ? { ...g, stories: [story, ...g.stories.filter((s) => s.storyId !== story.storyId)] }
                  : g,
              ),
            }));
            break;
          }
          case 'DraftUpdated': {
            const cid = event.data.chat_id;
            const wd = event.data.draft;
            set((prev) => {
              const nextDrafts = { ...prev.draftsByChat };
              if (wd) {
                nextDrafts[cid] = {
                  chatId: wd.chat_id,
                  text: wd.text,
                  entities: (wd.entities ?? []).map(fromWireMessageEntity),
                  replyToMsgId: wd.reply_to_msg_id,
                  quoteText: wd.quote_text,
                  topicId: wd.topic_id,
                  dateMs: wd.date_ms,
                };
              } else {
                delete nextDrafts[cid];
              }
              return { draftsByChat: nextDrafts };
            });
            break;
          }
          case 'UserTyping': {
            const { chat_id, user_id, action } = event.data;
            set((prev) => {
              const cur = prev.typingByChat[chat_id] ?? [];
              const next =
                action === 'cancel'
                  ? cur.filter((id) => id !== user_id)
                  : cur.includes(user_id)
                    ? cur
                    : [...cur, user_id];
              return { typingByChat: { ...prev.typingByChat, [chat_id]: next } };
            });
            break;
          }
          case 'CallSignal': {
            void webrtcManager.handleRemoteSignal(event.data);
            break;
          }
          case 'BotActivityChanged': {
            const { chat_id, bot_user_id, state, detail } = event.data;
            set((prev) => ({
              botActivityByChat: {
                ...prev.botActivityByChat,
                [chat_id]: {
                  botUserId: bot_user_id,
                  state,
                  detail: detail ?? null,
                  updatedAtMs: Date.now(),
                },
              },
            }));
            break;
          }
          case 'AgentFloorChanged': {
            const { chat_id, current_speaker, queued_count, loop_hops } = event.data;
            set((prev) => ({
              agentFloorByChat: {
                ...prev.agentFloorByChat,
                [chat_id]: {
                  currentSpeaker: current_speaker,
                  queuedCount: queued_count,
                  loopHops: loop_hops,
                },
              },
              roomAgentStateByChat: {
                ...prev.roomAgentStateByChat,
                [chat_id]: {
                  ...(prev.roomAgentStateByChat[chat_id] ?? {}),
                  currentSpeaker: current_speaker,
                  queuedCount: queued_count,
                  loopHops: loop_hops,
                  updatedAtMs: Date.now(),
                },
              },
            }));
            break;
          }
          case 'AgentWorkspaceUpdated': {
            const { chat_id, revision, key, value } = event.data;
            set((prev) => ({
              agentWorkspaceByChat: {
                ...prev.agentWorkspaceByChat,
                [chat_id]: {
                  ...(prev.agentWorkspaceByChat[chat_id] ?? {}),
                  [key]: value,
                },
              },
              roomAgentStateByChat: {
                ...prev.roomAgentStateByChat,
                [chat_id]: {
                  currentSpeaker: prev.roomAgentStateByChat[chat_id]?.currentSpeaker ?? null,
                  queuedCount: prev.roomAgentStateByChat[chat_id]?.queuedCount ?? 0,
                  loopHops: prev.roomAgentStateByChat[chat_id]?.loopHops ?? 0,
                  workspaceRevision: revision,
                  lastWorkspaceKey: key,
                  updatedAtMs: Date.now(),
                },
              },
            }));
            break;
          }
          case 'AgentHandoffEvent': {
            const { chat_id, from_agent, to_agent, hop, max_hops } = event.data;
            set((prev) => ({
              lastAgentHandoffByChat: {
                ...prev.lastAgentHandoffByChat,
                [chat_id]: {
                  fromAgent: from_agent,
                  toAgent: to_agent,
                  hop,
                  maxHops: max_hops,
                  updatedAtMs: Date.now(),
                },
              },
              roomAgentStateByChat: {
                ...prev.roomAgentStateByChat,
                [chat_id]: {
                  ...(prev.roomAgentStateByChat[chat_id] ?? { queuedCount: 0 }),
                  currentSpeaker: to_agent,
                  loopHops: hop,
                  updatedAtMs: Date.now(),
                },
              },
            }));
            break;
          }
          default:
            break;
        }
      };

      set({ connectionState: adapter.getConnectionState() });
      const unsubUpdate = adapter.onUpdate((ev) => applyEvent(ev));
      const unsubConn = adapter.onConnectionStateChange((connectionState) => {
        const accountId = useAuthStore.getState().activeAccountId ?? 'default';
        set({ connectionState });
        void indexedDbCache
          .listOutbox(accountId)
          .then((items) => set({ pendingOutboxCount: items.length }))
          .catch(() => undefined);
      });

      const unsubBroadcast = broadcastSync.subscribe((payload) => {
        const activeAcc = useAuthStore.getState().activeAccountId ?? 'default';
        if ('accountId' in payload && payload.accountId !== activeAcc) return;
        switch (payload.kind) {
          case 'message_upsert':
            applyEvent({ type: 'NewMessage', data: payload.message });
            break;
          case 'messages_deleted':
            set((prev) => ({
              messagesByChat: {
                ...prev.messagesByChat,
                [payload.chatId]: (prev.messagesByChat[payload.chatId] ?? []).filter(
                  (m) => !payload.messageIds.includes(m.id),
                ),
              },
            }));
            break;
          case 'reaction_updated':
            set((prev) => ({
              messagesByChat: {
                ...prev.messagesByChat,
                [payload.chatId]: (prev.messagesByChat[payload.chatId] ?? []).map((m) =>
                  m.id === payload.messageId ? { ...m, reactions: payload.reactions } : m,
                ),
              },
            }));
            break;
          case 'chat_updated':
            set((prev) => {
              const nextChats = { ...prev.chatsById, [payload.chat.chatId]: payload.chat };
              return { chatsById: nextChats, orderedChatIds: sortChatIds(nextChats) };
            });
            break;
          case 'chat_deleted':
            set((prev) => {
              const nextChats = { ...prev.chatsById };
              delete nextChats[payload.chatId];
              return { chatsById: nextChats, orderedChatIds: sortChatIds(nextChats) };
            });
            break;
          case 'protocol_update':
            applyEvent(payload.event);
            break;
          default:
            break;
        }
      });

      const cleanup = () => {
        unsubUpdate();
        unsubConn();
        unsubBroadcast();
      };
      realtimeUnbindFn = cleanup;
      return cleanup;
    },

    resetChatStore: () => {
      activeSelectSequence += 1;
      chatStoreAccountEpoch += 1;
      set({
        chatsById: {},
        orderedChatIds: [],
        activeChatId: null,
        activeTopicId: null,
        activeFolderId: 'all',
        showArchived: false,
        messagesByChat: {},
        hasMoreByChat: {},
        pinnedByChat: {},
        topicsByChat: {},
        folders: [],
        draftsByChat: {},
        replyTargetByChat: {},
        editingMessageByChat: {},
        selectedMessageIds: [],
        isMultiSelectMode: false,
        peersById: {},
        contacts: [],
        blockedUsers: [],
        privacySettings: null,
        membersByChat: {},
        invitesByChat: {},
        statsByChat: {},
        storyGroups: [],
        globalSearchQuery: '',
        globalSearchResults: null,
        inChatSearchQuery: '',
        inChatSearchHits: [],
        typingByChat: {},
        decryptedSecretTexts: {},
        voiceTranscripts: {},
        roomAgentStateByChat: {},
        botActivityByChat: {},
        agentFloorByChat: {},
        agentWorkspaceByChat: {},
        lastAgentHandoffByChat: {},
        pendingOutboxCount: 0,
      });
    },
  };
});
