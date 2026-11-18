import {
  E2EE_SAFETY_EMOJIS,
  HERMES_TOOLSET_IDS,
  createTextContent,
  enrichMessageItem,
  peerAvatarColorIndex,
  type AdapterMode,
  type AuthResponse,
  type BotRegistryEntry,
  type BrowserAuditLogEntry,
  type BrowserCommandRequest,
  type BrowserCommandResult,
  type BrowserControlClientPort,
  type BrowserControlRevokeResponse,
  type BrowserRegisterPayload,
  type BrowserSnapshotDto,
  type BrowserStateReportPayload,
  type BrowserTargetDescriptor,
  type CallSessionState,
  type CallSignalPayload,
  type ChannelStatisticsDto,
  type ChatFolder,
  type ChatMemberDto,
  type ChatSummary,
  type ComputerNodeDto,
  type ComputerRunPolicy,
  type ConnectionState,
  type DesktopPairingTicketDto,
  type DraftState,
  type ForumTopic,
  type GifResultDto,
  type GlobalSearchResponse,
  type HeadlessBrowserSessionDto,
  type HermesCommandDescriptor,
  type HermesCronJobDto,
  type HermesKanbanBoardDto,
  type HermesMemoryState,
  type HermesSessionSummary,
  type HermesSkillDto,
  type HermesStreamEvent,
  type HermesStudioSnapshot,
  type HermesStudioTab,
  type InviteLinkDto,
  type InvoiceCard,
  type MagpieConfigSnapshot,
  type MagpieMaskingConfig,
  type MagpieMaskingPreviewResult,
  type MagpiePreset,
  type MagpieProviderView,
  type MagpieRoutingGroup,
  type MagpieUsageLedgerSummary,
  type McpJsonRpcRequest,
  type McpJsonRpcResponse,
  type McpPendingApprovalDto,
  type McpServerDto,
  type McpToolDto,
  type MediaDescriptor,
  type MessageEntity,
  type MessageItem,
  type MiniAppEntry,
  type MiniAppLaunchContext,
  type PendingComputerCommandDto,
  type PollData,
  type PublishPreKeysRequest,
  type PublishPreKeysResponse,
  type PtsUpdate,
  type QrPairSessionDto,
  type ReactionCount,
  type ReactionDetail,
  type SearchHitDto,
  type SearchTabCategory,
  type SendMessagePortInput,
  type SessionDto,
  type StickerSetDto,
  type StoryGroup,
  type StoryItem,
  type SyncGetDifferenceRequest,
  type SyncGetDifferenceResponse,
  type TailnetStatusDto,
  type TalkSessionDto,
  type TaskItemDto,
  type TelegramClientPort,
  type TwoFactorStatusDto,
  type TypingAction,
  type UnsubscribeFn,
  type UpdateEvent,
  type UserPreKeyBundlesResponse,
  type UserPrivacySettingsDto,
  type UserProfile,
  type WalletStateDto,
} from '@gpui-telegram/protocol';
import { blobUrlRegistry } from '../services/blobUrlRegistry';
import { browserControlAgent } from '../services/browserControlAgent';
import { buildChatExportHtml, buildChatExportJson } from '../services/chatExport';
import { broadcastSync } from './broadcastSync';
import { indexedDbCache } from './indexedDbCache';

function makeUser(
  userId: number,
  firstName: string,
  opts: Partial<UserProfile> = {},
): UserProfile {
  return {
    userId,
    user_id: userId,
    firstName,
    first_name: firstName,
    lastName: opts.lastName,
    username: opts.username,
    bio: opts.bio ?? 'GPUI Telegram Web Sandbox Peer',
    phone: opts.phone,
    isBot: Boolean(opts.isBot),
    isVerified: Boolean(opts.isVerified),
    isPremium: Boolean(opts.isPremium),
    status: opts.status ?? 'online',
    colorIndex: peerAvatarColorIndex(userId),
  };
}

function makeMessage(
  id: number,
  chatId: number,
  senderId: number,
  isOut: boolean,
  text: string,
  extra: Partial<MessageItem> = {},
): MessageItem {
  const nowMs = extra.date_ms ?? Date.now();
  return enrichMessageItem({
    id,
    chat_id: chatId,
    peer_id: { Chat: chatId },
    to_peer: { Chat: chatId },
    sender_id: senderId,
    topic_id: extra.topic_id,
    flags: {
      is_out: isOut,
      is_pinned: Boolean(extra.flags?.is_pinned),
      is_silent: Boolean(extra.flags?.is_silent),
      is_edited: Boolean(extra.flags?.is_edited),
      is_scheduled: Boolean(extra.flags?.is_scheduled),
      media_unread: false,
      has_reactions: (extra.reactions?.length ?? 0) > 0,
      no_forwards: false,
      is_forwarded: Boolean(extra.forward_info),
    },
    date: extra.date ?? new Date(nowMs).toISOString(),
    date_ms: nowMs,
    text,
    entities: extra.entities ?? [],
    content: extra.content ?? createTextContent(text, extra.entities),
    reply_to: extra.reply_to,
    forward_info: extra.forward_info,
    reactions: extra.reactions ?? [],
    client_nonce: extra.client_nonce,
    inline_keyboard: extra.inline_keyboard,
    views: extra.views,
    ttl_seconds: extra.ttl_seconds,
    delivery_status: extra.delivery_status ?? 'sent',
  });
}

export class LocalSandboxAdapter implements TelegramClientPort, BrowserControlClientPort {
  public readonly mode: AdapterMode = 'sandbox';

  private connectionState: ConnectionState = 'connected';
  private connListeners = new Set<(state: ConnectionState) => void>();
  private updateListeners = new Set<(ev: UpdateEvent, pts?: PtsUpdate) => void>();

  private me: UserProfile = makeUser(101, 'Alice', {
    lastName: 'Lin',
    username: 'alice_sandbox',
    phone: '+14155550101',
    isPremium: true,
  });

  private contactIds = new Set<number>([102, 103, 104]);

  private users = new Map<number, UserProfile>();
  private chats = new Map<number, ChatSummary>();
  private messagesByChat = new Map<number, MessageItem[]>();
  private topicsByChat = new Map<number, ForumTopic[]>();
  private folders: ChatFolder[] = [];
  private stories: StoryItem[] = [];
  private polls = new Map<number, { chatId: number; msgId: number; poll: PollData }>();
  private mediaBlobs = new Map<string, { url: string; descriptor: MediaDescriptor }>();
  private nextMsgId = 500;
  private nextChatId = 900;
  private nextPollId = 300;
  private twoFa: TwoFactorStatusDto = { enabled: false, has_password: false };
  private privacy: UserPrivacySettingsDto = {
    phone_privacy: 'contacts',
    last_seen_privacy: 'everybody',
    photo_privacy: 'everybody',
    calls_privacy: 'everybody',
    forwards_privacy: 'everybody',
    groups_privacy: 'everybody',
    ttl_months: 6,
    global_ttl_seconds: 0,
    sensitive_content_enabled: false,
    passcode_enabled: false,
    notifications_private: true,
    notifications_groups: true,
    notifications_channels: true,
    notifications_sound: true,
    include_muted_in_badge: false,
    badge_count_messages: true,
    p2p_mode: 'contacts',
    accept_calls: true,
    is_premium: true,
  };
  private blockedIds = new Set<number>();
  private calls: CallSessionState[] = [];
  private bots: BotRegistryEntry[] = [];
  private miniApps: MiniAppEntry[] = [];
  private tasks: TaskItemDto[] = [];
  private mcpServers: McpServerDto[] = [];
  private mcpTools: McpToolDto[] = [];
  private mcpApprovals: McpPendingApprovalDto[] = [];
  private talkSession: TalkSessionDto = {
    session_id: 'talk_sandbox_1',
    state: 'idle',
    generation: 1,
    signal_seq: 1,
    buffered_chunks: 0,
  };
  private computers: ComputerNodeDto[] = [];
  private computerApprovals: PendingComputerCommandDto[] = [];
  private wallet: WalletStateDto = {
    user_id: 101,
    balance: 2500,
    stars_balance: 2500,
    ton_nano: 12_500_000_000,
    ton_balance: '12.50 TON',
    updated_at_ms: Date.now(),
    transactions: [
      {
        tx_id: 'tx_seed_1',
        kind: 'topup',
        amount_stars: 2500,
        description: 'Initial Sandbox Stars Grant',
        created_at_ms: Date.now() - 3600_000,
      },
    ],
  };
  private hermesStudio: HermesStudioSnapshot;
  private magpieConfig: MagpieConfigSnapshot;
  private headlessSessions = new Map<string, { session: HeadlessBrowserSessionDto; snapshot: BrowserSnapshotDto }>();

  constructor() {
    const now = Date.now();
    this.hermesStudio = {
      status: { engine: 'hermes-sandbox-v1', online: true, toolsets_count: HERMES_TOOLSET_IDS.length },
      sessions: [
        {
          session_id: 'hses_default',
          title: 'Architecture & Rust/TS Parity Session',
          source: 'telegram_web',
          model: 'hermes-3-llama-70b',
          message_count: 4,
          total_tokens: 1840,
          total_cost_usd: 0.004,
          created_at_ms: now - 7200_000,
          updated_at_ms: now,
        },
      ],
      memory: {
        memory: { raw: '- Prefers zero-purple dark themes\n- Strict hexagonal ports', entries: ['Prefers zero-purple dark themes', 'Strict hexagonal ports'], chars: 58, limit: 2200 },
        user: { raw: '- Principal Systems Architect', entries: ['Principal Systems Architect'], chars: 29, limit: 1375 },
        soul: '# Hermes Agent Soul\nConcise, verifiable engineering reasoning.',
        honcho_observations: ['Active bilingual zh-CN / en-US operator'],
      },
      skills: [
        {
          name: 'web-browser-bridge',
          description: 'Inspect and automate live Telegram Web DOM snapshots safely.',
          body: 'Use snapshot refs e1..eN before click/fill.',
          tags: ['browser', 'mcp'],
          toolsets: ['browser', 'mcp'],
          version: '1.0.0',
          enabled: true,
          trusted: true,
          status: 'active',
          security_risk: 'low',
          security_findings: [],
          updated_at_ms: now,
        },
      ],
      enabledToolsets: ['core', 'web', 'memory', 'skills', 'browser', 'mcp', 'kanban', 'cronjob'],
      cronJobs: [
        {
          job_id: 'cron_daily_digest',
          name: 'Morning Channel Digest',
          schedule_expr: '0 9 * * *',
          prompt: 'Summarize unread engineering updates.',
          enabled: true,
          next_run_ms: now + 43_200_000,
          run_count: 3,
        },
      ],
      kanbanBoards: [
        {
          board_id: 'kb_main',
          title: 'Hermes Engineering Sprint',
          description: 'Autonomous agent task board',
          columns: ['inbox', 'todo', 'in_progress', 'review', 'done'],
          cards: [
            {
              card_id: 'card_1',
              board_id: 'kb_main',
              column_id: 'in_progress',
              title: 'Verify E2EE 4-emoji fingerprint',
              description: 'Cross-check Alice & Bob ECDH P-256 shared secret',
              priority: 'high',
              labels: ['security', 'e2ee'],
              checklist: [{ text: 'WebCrypto P-256 keygen', completed: true }],
              comments: [],
              position: 0,
              updated_at_ms: now,
            },
          ],
        },
      ],
    };

    const defaultPresets: MagpiePreset[] = [
      { id: 'openai', name: 'OpenAI Official', category: 'vendor', api_mode: 'chat_completions', base_url: 'https://api.openai.com/v1', default_model: 'gpt-4o-mini', models: ['gpt-4o', 'gpt-4o-mini'], no_key_required: false },
      { id: 'anthropic', name: 'Anthropic Claude', category: 'vendor', api_mode: 'anthropic_messages', base_url: 'https://api.anthropic.com/v1', default_model: 'claude-3-7-sonnet', models: ['claude-3-7-sonnet'], no_key_required: false },
      { id: 'deepseek', name: 'DeepSeek', category: 'vendor', api_mode: 'chat_completions', base_url: 'https://api.deepseek.com/v1', default_model: 'deepseek-chat', models: ['deepseek-chat', 'deepseek-reasoner'], no_key_required: false },
      { id: 'local_hermes', name: 'Local Hermes Built-in', category: 'local', api_mode: 'local_hermes', base_url: 'local://hermes', default_model: 'hermes-local-v1', models: ['hermes-local-v1'], no_key_required: true },
    ];
    const defaultProviders: MagpieProviderView[] = [
      {
        provider_id: 'local_hermes',
        preset_id: 'local_hermes',
        name: 'Local Hermes Built-in',
        api_mode: 'local_hermes',
        base_url: 'local://hermes',
        default_model: 'hermes-local-v1',
        enabled: true,
        no_key_required: true,
        has_api_key: false,
        masked_key: null,
        custom_headers: {},
        updated_at_ms: now,
      },
    ];
    const defaultGroups: MagpieRoutingGroup[] = [
      {
        id: 'default',
        name: 'Smart Hybrid Failover',
        strategy: 'smart',
        members: [{ target: 'local_hermes', weight: 100, enabled: true, free: true }],
        sticky_ttl_ms: 60_000,
      },
    ];
    const defaultMasking: MagpieMaskingConfig = {
      enabled: true,
      mask_secrets: true,
      mask_personal: true,
      custom_words: [],
      allow_list: [],
      default_action: 'mask',
    };

    this.magpieConfig = {
      presets: defaultPresets,
      providers: defaultProviders,
      activeProvider: 'local_hermes',
      activeModel: 'hermes-local-v1',
      allowLocalFallback: true,
      routingGroups: defaultGroups,
      routingStrategy: 'smart',
      masking: defaultMasking,
    };

    this.seedInitialDataset();
  }

  private seedInitialDataset(): void {
    const now = Date.now();
    const bob = makeUser(102, 'Bob', { lastName: 'Chen', username: 'bob_chen', phone: '+14155550102' });
    const botFather = makeUser(201, 'BotFather', { username: 'BotFather', isBot: true, isVerified: true });
    const fabushiBot = makeUser(202, '全球法布施', { username: 'FabushiBot', isBot: true, isVerified: true });
    const hermesBot = makeUser(203, 'Hermes AI Agent', { username: 'HermesAgent', isBot: true, isVerified: true });

    for (const u of [this.me, bob, botFather, fabushiBot, hermesBot]) {
      this.users.set(u.userId, u);
    }

    const mkChat = (
      chatId: number,
      title: string,
      kind: ChatSummary['kind'],
      chatType: number,
      extra: Partial<ChatSummary> = {},
    ): ChatSummary => ({
      chatId,
      chat_id: chatId,
      title,
      kind,
      chatType,
      creatorId: 101,
      peerUserId: extra.peerUserId,
      username: extra.username,
      about: extra.about ?? `${title} — Sandbox`,
      colorIndex: peerAvatarColorIndex(chatId),
      isVerified: Boolean(extra.isVerified),
      isGroup: kind === 'group' || kind === 'supergroup',
      isSupergroup: kind === 'supergroup',
      isChannel: kind === 'channel',
      isBot: kind === 'bot',
      isForum: Boolean(extra.isForum),
      isSecret: kind === 'secret',
      isSavedMessages: kind === 'saved',
      isArchived: Boolean(extra.isArchived),
      isPinned: Boolean(extra.isPinned),
      isMuted: Boolean(extra.isMuted),
      pts: 3,
      lastMessageId: 1,
      lastMessageDateMs: now,
      lastMessagePreview: extra.lastMessagePreview ?? 'Ready',
      unreadCount: extra.unreadCount ?? 0,
      unreadMentionsCount: 0,
      unreadReactionsCount: 0,
      readInboxMaxId: 10,
      readOutboxMaxId: 10,
      slowModeSeconds: 0,
      memberCount: extra.memberCount ?? 2,
      pinnedMessageIds: [],
      draft: null,
    });

    const saved = mkChat(1, 'Saved Messages', 'saved', 0, { isPinned: true, memberCount: 1 });
    const dmBob = mkChat(2, 'Bob Chen', 'private', 0, { peerUserId: 102, isPinned: true });
    const chatBotFather = mkChat(3, 'BotFather', 'bot', 0, { peerUserId: 201, username: 'BotFather', isVerified: true });
    const chatFabushi = mkChat(4, '全球法布施 · Merit Globe', 'bot', 0, { peerUserId: 202, username: 'FabushiBot', isVerified: true });
    const chatHermes = mkChat(5, 'Hermes AI Agent', 'bot', 0, { peerUserId: 203, username: 'HermesAgent', isVerified: true });
    const forumGroup = mkChat(6, 'GPUI Rust Core Forum', 'supergroup', 2, { isForum: true, memberCount: 48 });
    const releaseChan = mkChat(7, 'Telegram Web Releases', 'channel', 3, { isVerified: true, memberCount: 1240 });

    for (const c of [saved, dmBob, chatBotFather, chatFabushi, chatHermes, forumGroup, releaseChan]) {
      this.chats.set(c.chatId, c);
    }

    this.topicsByChat.set(6, [
      { chatId: 6, topicId: 1, topic_id: 1, title: 'General', iconColor: 0x3390ec, iconEmoji: '💬', creatorId: 101, isPinned: true, isClosed: false, isHidden: false, lastMessageId: 106, unreadCount: 0, createdAtMs: now - 50_000 },
      { chatId: 6, topicId: 2, topic_id: 2, title: 'WebCrypto E2EE & WebRTC', iconColor: 0x3fc1b0, iconEmoji: '🔐', creatorId: 102, isPinned: false, isClosed: false, isHidden: false, lastMessageId: 107, unreadCount: 1, createdAtMs: now - 40_000 },
    ]);

    this.messagesByChat.set(1, [
      makeMessage(101, 1, 101, true, '📌 Saved Messages cloud scratchpad — works 100% offline in LocalSandboxAdapter.'),
    ]);
    this.messagesByChat.set(2, [
      makeMessage(102, 2, 102, false, 'Hey Alice! Ready to test voice waveforms, polls, and E2EE secret chats?'),
      makeMessage(103, 2, 101, true, 'Yes! Zero-purple dark theme & bilingual i18n are live.'),
    ]);
    this.messagesByChat.set(3, [
      makeMessage(104, 3, 201, false, 'Send `/newbot <username> <display name>` to register a new bot, or `/mybots` to list your bots.'),
    ]);
    this.messagesByChat.set(4, [
      makeMessage(105, 4, 202, false, '欢迎体验全球法布施 WebAssembly 功德地球 MiniApp！点击下方按钮启动。', {
        inline_keyboard: [[{ text: '🌏 启动全球法布施 MiniApp', web_app_url: '/miniapps/fabushi-globe/index.html' }]],
      }),
    ]);
    this.messagesByChat.set(5, [
      makeMessage(106, 5, 203, false, 'Hermes AI Agent ready. Try `/help`, `/status`, or stream a multi-step reasoning turn.'),
    ]);
    this.messagesByChat.set(6, [
      makeMessage(107, 6, 102, false, 'Welcome to the GPUI Rust Core Forum! Switch topics on the left.', { topic_id: 1 }),
    ]);
    this.messagesByChat.set(7, [
      makeMessage(108, 7, 101, true, '🚀 GPUI Telegram Web v1.0 — Full 17-Domain Parity!', { views: 428 }),
    ]);

    for (const [cid, list] of this.messagesByChat.entries()) {
      const last = list[list.length - 1];
      const chat = this.chats.get(cid);
      if (chat && last) {
        chat.lastMessageId = last.id;
        chat.lastMessageDateMs = last.date_ms ?? now;
        chat.lastMessagePreview = last.text ?? '';
      }
    }

    this.bots = [
      {
        bot_user_id: 201,
        owner_user_id: 101,
        username: 'BotFather',
        display_name: 'BotFather',
        description: 'Official bot registry & MiniApp configurator',
        about: 'Create and manage Telegram bots',
        commands: [{ command: '/newbot', description: 'Create a new bot' }, { command: '/mybots', description: 'List bots' }],
        is_official: true,
        is_inline: false,
        allow_attach_menu: false,
        menu_button_type: 'commands',
        has_main_app: false,
        created_at_ms: now,
      },
      {
        bot_user_id: 202,
        owner_user_id: 101,
        username: 'FabushiBot',
        display_name: '全球法布施',
        description: '3D Merit Globe + WASM Wooden Fish & Dedication',
        about: '全球法布施 WebAssembly MiniApp',
        commands: [{ command: '/start', description: 'Open Merit Globe' }],
        is_official: true,
        is_inline: true,
        allow_attach_menu: true,
        menu_button_type: 'web_app',
        menu_button_text: '法布施地球',
        menu_button_url: '/miniapps/fabushi-globe/index.html',
        has_main_app: true,
        main_app_short_name: 'fabushi-globe',
        created_at_ms: now,
      },
    ];

    this.miniApps = [
      {
        app_id: 'app_fabushi',
        bot_user_id: 202,
        bot_username: 'FabushiBot',
        short_name: 'fabushi-globe',
        title: '全球法布施 · Merit Globe',
        description: 'WebAssembly 功德步进 + 电子木鱼 + 供香 + 回向榜',
        category: 'lifestyle',
        icon_emoji: '🌏',
        web_url: '/miniapps/fabushi-globe/index.html',
        has_wasm: true,
        is_installed: true,
        companion_chat_id: 4,
        install_count: 10800,
        created_at_ms: now,
      },
      {
        app_id: 'app_taskboard',
        bot_user_id: 203,
        bot_username: 'TaskBoardBot',
        short_name: 'taskboard',
        title: 'Kanban TaskBoard',
        description: 'Collaborative sprint board powered by Telegram.WebApp CloudStorage',
        category: 'productivity',
        icon_emoji: '📋',
        web_url: '/miniapps/taskboard/index.html',
        has_wasm: false,
        is_installed: true,
        companion_chat_id: 5,
        install_count: 4200,
        created_at_ms: now,
      },
    ];

    this.stories = [
      {
        storyId: 'story_bob_1',
        story_id: 'story_bob_1',
        userId: 102,
        username: 'bob_chen',
        firstName: 'Bob',
        mediaType: 'gradient',
        caption: 'Shipping 60fps virtualized timelines in GPUI Telegram Web ⚡',
        backgroundGradient: 'linear-gradient(135deg, #0E1621, #1B4978, #3FC1B0)',
        privacy: 'everyone',
        viewsCount: 14,
        isViewed: false,
        createdAtMs: now - 3600_000,
        expiresAtMs: now + 82_800_000,
      },
    ];

    this.tasks = [
      {
        task_id: 'task_1',
        title: 'Daily Unread Summary',
        description: 'Compile key engineering decisions across channels',
        state: 'running',
        cron_expr: '0 9 * * *',
        next_run_ms: now + 3600_000,
        chat_id: 1,
        progress: 65,
        logs: ['Initialized cron runner', 'Scanning GPUI Rust Core Forum'],
        created_at_ms: now - 7200_000,
        updated_at_ms: now,
      },
    ];

    this.mcpServers = [
      { server_id: 'mcp_browser_bridge', name: 'Live Browser Bridge MCP', transport: 'http', endpoint: '/api/v1/mcp/rpc', enabled: true, status: 'connected', tools_count: 3 },
    ];
    this.mcpTools = [
      { tool_id: 'browser_snapshot', server_id: 'mcp_browser_bridge', name: 'browser_snapshot', description: 'Capture live DOM accessibility snapshot', risk_level: 'read_only', requires_approval: false },
      { tool_id: 'browser_click', server_id: 'mcp_browser_bridge', name: 'browser_click', description: 'Click an interactive ref in the active tab', risk_level: 'medium', requires_approval: true },
    ];

    this.computers = [
      {
        node_id: 'sandbox:default',
        display_name: 'Cloud Sandbox (Ubuntu 24.04)',
        kind: 'cloud_sandbox',
        tier_badge: '免费',
        host: '100.64.0.1',
        os_name: 'Linux 6.8 x86_64',
        resolution: '1280x720',
        online: true,
        run_policy: 'allow_read_only',
        has_saved_credential: false,
        lease_state: 'idle',
        lease_generation: 1,
        updated_at_ms: now,
      },
    ];
  }

  public getDiscoveredPeers(): UserProfile[] {
    return Array.from(this.users.values());
  }

  private emitUpdate(ev: UpdateEvent, pts?: PtsUpdate): void {
    for (const fn of this.updateListeners) {
      try {
        fn(ev, pts);
      } catch {
        // Ignore
      }
    }
  }

  private makeAuthResponse(): AuthResponse {
    return {
      user_id: this.me.userId,
      username: this.me.username ?? 'alice_sandbox',
      session_id: 'sandbox_session_primary',
      token: `sandbox_tok_${this.me.userId}`,
      first_name: this.me.firstName,
      last_name: this.me.lastName,
      user: {
        user_id: this.me.userId,
        username: this.me.username,
        first_name: this.me.firstName,
        last_name: this.me.lastName,
        is_bot: false,
        is_verified: true,
        is_premium: true,
        status: 'online',
      },
    };
  }

  public async connect(): Promise<void> {
    this.connectionState = 'connected';
    for (const fn of this.connListeners) fn('connected');
  }

  public async disconnect(): Promise<void> {
    this.connectionState = 'disconnected';
    for (const fn of this.connListeners) fn('disconnected');
  }

  public getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  public onConnectionStateChange(listener: (state: ConnectionState) => void): UnsubscribeFn {
    this.connListeners.add(listener);
    return () => this.connListeners.delete(listener);
  }

  public onUpdate(listener: (event: UpdateEvent, ptsUpdate?: PtsUpdate) => void): UnsubscribeFn {
    this.updateListeners.add(listener);
    return () => this.updateListeners.delete(listener);
  }

  public async getDifference(req: SyncGetDifferenceRequest): Promise<SyncGetDifferenceResponse> {
    const chat = this.chats.get(req.chat_id);
    const pts = chat?.pts ?? 1;
    return {
      status: 'UpToDate',
      chat_id: req.chat_id,
      new_messages: [],
      other_updates: [],
      pts,
      current_pts: pts,
      updates: [],
      has_more: false,
      snapshot_required: false,
    };
  }

  // F1: Auth
  public async loginDemo(slot = 0): Promise<AuthResponse> {
    if (slot > 0) {
      const uid = 101 + slot;
      this.me = makeUser(uid, `DemoUser${slot}`, { username: `demo_slot_${slot}` });
      this.users.set(uid, this.me);
    }
    return this.makeAuthResponse();
  }

  public async sendPhoneCode(): Promise<{ phone_code_hash: string; timeout_secs: number; dev_code?: string }> {
    return { phone_code_hash: `hash_${Date.now()}`, timeout_secs: 120, dev_code: '12345' };
  }

  public async verifyPhoneCode(req: {
    phone: string;
    code: string;
    first_name?: string;
    last_name?: string;
  }): Promise<AuthResponse | { requires_2fa: true; challenge_token: string; hint?: string }> {
    if (req.code === '00000') throw new Error('Invalid verification code');
    if (this.twoFa.enabled) {
      return { requires_2fa: true, challenge_token: 'chal_sandbox_2fa', hint: this.twoFa.hint };
    }
    if (req.first_name) this.me.firstName = req.first_name;
    this.me.phone = req.phone;
    return this.makeAuthResponse();
  }

  public async verify2fa(): Promise<AuthResponse> {
    return this.makeAuthResponse();
  }

  public async get2faStatus(): Promise<TwoFactorStatusDto> {
    return { ...this.twoFa };
  }

  public async set2faPassword(req: { new_password: string; hint?: string; recovery_email?: string }): Promise<TwoFactorStatusDto> {
    this.twoFa = {
      enabled: true,
      has_password: Boolean(req.new_password),
      hint: req.hint,
      recovery_email: req.recovery_email ?? null,
      updated_at_ms: Date.now(),
    };
    return { ...this.twoFa };
  }

  public async disable2faPassword(): Promise<{ ok: boolean }> {
    this.twoFa = { enabled: false, has_password: false };
    return { ok: true };
  }

  public async initQrPairing(): Promise<QrPairSessionDto> {
    const pairId = `qr_${Date.now()}`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160"><rect width="160" height="160" rx="12" fill="#FFFFFF"/><rect x="18" y="18" width="40" height="40" fill="#0E1621"/><rect x="102" y="18" width="40" height="40" fill="#0E1621"/><rect x="18" y="102" width="40" height="40" fill="#0E1621"/><circle cx="80" cy="80" r="18" fill="#3390EC"/></svg>`;
    return {
      pair_id: pairId,
      pair_token: `tok_${pairId}`,
      qr_url: `tg://login?token=${pairId}`,
      svg,
      status: 'pending',
      expires_at_ms: Date.now() + 120_000,
    };
  }

  public async pollQrPairing(pairId: string): Promise<QrPairSessionDto> {
    return {
      pair_id: pairId,
      pair_token: `tok_${pairId}`,
      qr_url: `tg://login?token=${pairId}`,
      svg: '',
      status: 'pending',
      expires_at_ms: Date.now() + 90_000,
    };
  }

  public async acceptQrPairing(pairId: string): Promise<QrPairSessionDto> {
    const session = this.makeAuthResponse();
    return {
      pair_id: pairId,
      pair_token: `tok_${pairId}`,
      qr_url: `tg://login?token=${pairId}`,
      svg: '',
      status: 'approved',
      expires_at_ms: Date.now() + 90_000,
      token: session.token,
      session,
      user: session.user,
    };
  }

  public async loginPassword(username: string): Promise<AuthResponse> {
    this.me.username = username;
    return this.makeAuthResponse();
  }

  public async registerPassword(req: { username: string; first_name: string; last_name?: string }): Promise<AuthResponse> {
    this.me.username = req.username;
    this.me.firstName = req.first_name;
    this.me.lastName = req.last_name;
    return this.makeAuthResponse();
  }

  public async sendEmailCode(): Promise<{ email_code_hash: string; dev_code?: string }> {
    return { email_code_hash: `ehash_${Date.now()}`, dev_code: '654321' };
  }

  public async verifyEmailCode(): Promise<AuthResponse> {
    return this.makeAuthResponse();
  }

  public async startAlipayAuth(): Promise<{ session_id: string; qr_url: string; svg: string; expires_at_ms: number }> {
    const sid = `ali_${Date.now()}`;
    return {
      session_id: sid,
      qr_url: `https://qr.alipay.com/${sid}`,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" rx="12" fill="#1687FF"/><text x="60" y="66" text-anchor="middle" fill="#FFF" font-size="16" font-family="sans-serif">Alipay QR</text></svg>`,
      expires_at_ms: Date.now() + 120_000,
    };
  }

  public async pollAlipayAuth(): Promise<{ status: string; auth?: AuthResponse }> {
    return { status: 'pending' };
  }

  public async confirmAlipayAuth(): Promise<AuthResponse> {
    return this.makeAuthResponse();
  }

  public async getPasskeyChallenge(): Promise<{ challenge_id: string; challenge: string; rp_id: string }> {
    return { challenge_id: `pkc_${Date.now()}`, challenge: 'sandbox_webauthn_challenge', rp_id: 'localhost' };
  }

  public async registerPasskey(req: { cred_id?: string; label: string }): Promise<{ cred_id: string; label: string }> {
    return { cred_id: req.cred_id ?? `cred_${Date.now()}`, label: req.label };
  }

  public async verifyPasskey(): Promise<AuthResponse> {
    return this.makeAuthResponse();
  }

  public async listSessions(): Promise<SessionDto[]> {
    return [
      {
        session_id: 'sandbox_session_primary',
        device_name: 'Telegram Web (Browser Sandbox)',
        platform: 'Web',
        ip_address: '127.0.0.1',
        created_at_ms: Date.now() - 3600_000,
        last_active_ms: Date.now(),
        is_current: true,
      },
    ];
  }

  public async revokeSession(): Promise<void> {}
  public async revokeOtherSessions(): Promise<number> {
    return 0;
  }
  public async logout(): Promise<void> {
    await this.disconnect();
  }

  // F4, F5, F14: Chats & Contacts
  public async listChats(opts?: { archived?: boolean; folderId?: string | number }): Promise<{ chats: ChatSummary[]; users: UserProfile[] }> {
    let list = Array.from(this.chats.values());
    if (opts?.archived !== undefined) {
      list = list.filter((c) => c.isArchived === opts.archived);
    }
    if (opts?.folderId && opts.folderId !== 'all') {
      const f = this.folders.find((fl) => String(fl.id) === String(opts.folderId) || fl.folderId === String(opts.folderId));
      if (f) {
        list = list.filter((c) => f.includedChatIds.includes(c.chatId) || (f.includeGroups && c.isGroup) || (f.includeChannels && c.isChannel) || (f.includeBots && c.isBot));
      }
    }
    list.sort((a, b) => (a.isPinned !== b.isPinned ? (a.isPinned ? -1 : 1) : b.lastMessageDateMs - a.lastMessageDateMs));
    return { chats: list.map((c) => ({ ...c })), users: this.getDiscoveredPeers() };
  }

  public async getChat(chatId: number): Promise<ChatSummary> {
    const c = this.chats.get(chatId);
    if (!c) throw new Error(`Chat ${chatId} not found`);
    return { ...c };
  }

  public async openSavedMessages(): Promise<ChatSummary> {
    return this.getChat(1);
  }

  public async createChat(req: {
    title: string;
    chatType: number;
    about?: string;
    username?: string;
    isForum?: boolean;
    peerUserId?: number;
    memberIds?: number[];
  }): Promise<ChatSummary> {
    const id = ++this.nextChatId;
    const kind: ChatSummary['kind'] =
      req.chatType === 3 ? 'channel' : req.chatType === 2 ? 'supergroup' : req.chatType === 1 ? 'group' : 'private';
    const now = Date.now();
    const chat: ChatSummary = {
      chatId: id,
      chat_id: id,
      title: req.title,
      kind,
      chatType: req.chatType,
      creatorId: this.me.userId,
      peerUserId: req.peerUserId,
      username: req.username,
      about: req.about,
      colorIndex: peerAvatarColorIndex(id),
      isVerified: false,
      isGroup: kind === 'group' || kind === 'supergroup',
      isSupergroup: kind === 'supergroup',
      isChannel: kind === 'channel',
      isBot: false,
      isForum: Boolean(req.isForum),
      isSecret: false,
      isSavedMessages: false,
      isArchived: false,
      isPinned: false,
      isMuted: false,
      pts: 1,
      lastMessageId: 0,
      lastMessageDateMs: now,
      lastMessagePreview: 'Created',
      unreadCount: 0,
      unreadMentionsCount: 0,
      unreadReactionsCount: 0,
      readInboxMaxId: 0,
      readOutboxMaxId: 0,
      slowModeSeconds: 0,
      memberCount: (req.memberIds?.length ?? 0) + 1,
      pinnedMessageIds: [],
      draft: null,
    };
    this.chats.set(id, chat);
    this.messagesByChat.set(id, []);
    return { ...chat };
  }

  public async updateChat(chatId: number, patch: Partial<{ title: string; about: string; username: string; slowModeSeconds: number; isForum: boolean }>): Promise<ChatSummary> {
    const c = this.chats.get(chatId);
    if (!c) throw new Error(`Chat ${chatId} not found`);
    Object.assign(c, patch);
    return { ...c };
  }

  public async deleteOrLeaveChat(chatId: number): Promise<void> {
    this.chats.delete(chatId);
    this.messagesByChat.delete(chatId);
  }

  public async clearChatHistory(chatId: number): Promise<void> {
    this.messagesByChat.set(chatId, []);
  }

  public async updateChatSettings(
    chatId: number,
    patch: Partial<{ isPinned: boolean; isArchived: boolean; isMuted: boolean; unreadMark: boolean; folderId: number | null }>,
  ): Promise<ChatSummary> {
    const c = this.chats.get(chatId);
    if (!c) throw new Error(`Chat ${chatId} not found`);
    if (patch.isPinned !== undefined) c.isPinned = patch.isPinned;
    if (patch.isArchived !== undefined) c.isArchived = patch.isArchived;
    if (patch.isMuted !== undefined) c.isMuted = patch.isMuted;
    if (patch.unreadMark !== undefined) c.unreadMark = patch.unreadMark;
    if (patch.folderId !== undefined) c.folderId = patch.folderId;
    return { ...c };
  }

  public async setChatTtl(chatId: number, ttlSeconds: number): Promise<void> {
    const c = this.chats.get(chatId);
    if (c) c.ttlSeconds = ttlSeconds;
  }

  public async saveDraft(chatId: number, draft: DraftState | null): Promise<void> {
    const c = this.chats.get(chatId);
    if (c) c.draft = draft;
    await indexedDbCache.saveDraft(String(this.me.userId), chatId, draft);
  }

  public async listFolders(): Promise<ChatFolder[]> {
    return [...this.folders];
  }

  public async upsertFolder(folder: Partial<ChatFolder> & { title: string }): Promise<ChatFolder> {
    const id = folder.id ?? this.folders.length + 2;
    const item: ChatFolder = {
      id,
      folderId: String(id),
      title: folder.title,
      emoticon: folder.emoticon ?? '📁',
      includedChatIds: folder.includedChatIds ?? [],
      excludedChatIds: folder.excludedChatIds ?? [],
      pinnedChatIds: folder.pinnedChatIds ?? [],
      includeContacts: folder.includeContacts ?? false,
      includeNonContacts: folder.includeNonContacts ?? false,
      includeGroups: folder.includeGroups ?? true,
      includeChannels: folder.includeChannels ?? true,
      includeBots: folder.includeBots ?? false,
      excludeMuted: folder.excludeMuted ?? false,
      excludeRead: folder.excludeRead ?? false,
      excludeArchived: folder.excludeArchived ?? true,
      sortOrder: folder.sortOrder ?? this.folders.length,
    };
    const idx = this.folders.findIndex((f) => f.id === id);
    if (idx >= 0) this.folders[idx] = item;
    else this.folders.push(item);
    return item;
  }

  public async deleteFolder(folderId: number | string): Promise<void> {
    this.folders = this.folders.filter((f) => String(f.id) !== String(folderId) && f.folderId !== String(folderId));
  }

  public async listForumTopics(chatId: number): Promise<ForumTopic[]> {
    return [...(this.topicsByChat.get(chatId) ?? [])];
  }

  public async createForumTopic(chatId: number, req: { title: string; iconColor?: number; iconEmoji?: string }): Promise<ForumTopic> {
    const list = this.topicsByChat.get(chatId) ?? [];
    const topicId = list.length + 10;
    const t: ForumTopic = {
      chatId,
      topicId,
      topic_id: topicId,
      title: req.title,
      iconColor: req.iconColor ?? 0x3390ec,
      iconEmoji: req.iconEmoji ?? '💬',
      creatorId: this.me.userId,
      isPinned: false,
      isClosed: false,
      isHidden: false,
      lastMessageId: 0,
      unreadCount: 0,
      createdAtMs: Date.now(),
    };
    list.push(t);
    this.topicsByChat.set(chatId, list);
    return t;
  }

  public async updateForumTopic(chatId: number, topicId: number, patch: Partial<{ title: string; isClosed: boolean; isPinned: boolean }>): Promise<ForumTopic> {
    const list = this.topicsByChat.get(chatId) ?? [];
    const found = list.find((t) => t.topicId === topicId);
    if (!found) throw new Error('Topic not found');
    Object.assign(found, patch);
    return { ...found };
  }

  public async deleteForumTopic(chatId: number, topicId: number): Promise<void> {
    const list = this.topicsByChat.get(chatId) ?? [];
    this.topicsByChat.set(chatId, list.filter((t) => t.topicId !== topicId));
  }

  public async listContacts(): Promise<UserProfile[]> {
    return Array.from(this.users.values()).filter(
      (u) => u.userId !== this.me.userId && (this.contactIds.has(u.userId) || !u.isBot),
    );
  }

  public async addContact(req: { userId?: number; username?: string; phone?: string; firstName?: string; lastName?: string }): Promise<UserProfile> {
    const uid = req.userId ?? ++this.nextChatId;
    const u = makeUser(uid, req.firstName || req.username || 'Contact', {
      lastName: req.lastName,
      username: req.username,
      phone: req.phone,
    });
    this.users.set(uid, u);
    this.contactIds.add(uid);
    return u;
  }

  public async deleteContact(userId: number): Promise<void> {
    this.contactIds.delete(userId);
  }

  public async resolveUsername(username: string): Promise<{ peerType: string; user?: UserProfile; chat?: ChatSummary }> {
    const clean = username.replace(/^@/, '').toLowerCase();
    for (const u of this.users.values()) {
      if (u.username?.toLowerCase() === clean) return { peerType: 'user', user: u };
    }
    for (const c of this.chats.values()) {
      if (c.username?.toLowerCase() === clean) return { peerType: 'chat', chat: c };
    }
    throw new Error(`Username @${clean} not found`);
  }

  public async listMembers(chatId: number): Promise<{ members: ChatMemberDto[]; users: UserProfile[] }> {
    const now = Date.now();
    const members: ChatMemberDto[] = [
      { user_id: this.me.userId, username: this.me.username, first_name: this.me.firstName, role: 'owner', admin_rights: 255, banned_rights: 0, joined_at_ms: now - 86400_000 },
      { user_id: 102, username: 'bob_chen', first_name: 'Bob', last_name: 'Chen', role: 'member', admin_rights: 0, banned_rights: 0, joined_at_ms: now - 43200_000 },
    ];
    void chatId;
    return { members, users: this.getDiscoveredPeers() };
  }

  public async addMembers(): Promise<void> {}
  public async updateMemberRole(_chatId: number, userId: number, patch: { role: ChatMemberDto['role']; customTitle?: string }): Promise<ChatMemberDto> {
    const u = this.users.get(userId);
    return {
      user_id: userId,
      username: u?.username,
      first_name: u?.firstName ?? 'Member',
      role: patch.role,
      admin_rights: patch.role === 'admin' ? 127 : 0,
      banned_rights: patch.role === 'banned' ? 255 : 0,
      custom_title: patch.customTitle,
      joined_at_ms: Date.now(),
    };
  }
  public async removeMember(): Promise<void> {}

  public async listInviteLinks(chatId: number): Promise<InviteLinkDto[]> {
    return [
      {
        invite_id: `inv_${chatId}`,
        chat_id: chatId,
        creator_id: this.me.userId,
        link: `https://t.me/+sandbox_${chatId}`,
        code: `sandbox_${chatId}`,
        usage_limit: null,
        usage_count: 3,
        expire_date_ms: null,
        request_needed: false,
        is_revoked: false,
        created_at_ms: Date.now() - 3600_000,
      },
    ];
  }

  public async createInviteLink(chatId: number, req?: { title?: string; usageLimit?: number; expireAtMs?: number }): Promise<InviteLinkDto> {
    const code = `sbx_${chatId}_${Date.now().toString(36)}`;
    return {
      invite_id: code,
      chat_id: chatId,
      creator_id: this.me.userId,
      link: `https://t.me/+${code}`,
      code,
      title: req?.title,
      usage_limit: req?.usageLimit ?? null,
      usage_count: 0,
      expire_date_ms: req?.expireAtMs ?? null,
      request_needed: false,
      is_revoked: false,
      created_at_ms: Date.now(),
    };
  }

  public async revokeInviteLink(): Promise<void> {}
  public async joinByInvite(code: string): Promise<ChatSummary> {
    return this.createChat({ title: `Joined (${code})`, chatType: 2 });
  }

  public async getChannelStatistics(chatId: number): Promise<ChannelStatisticsDto> {
    const c = this.chats.get(chatId);
    const today = new Date().toISOString().slice(0, 10);
    return {
      chat_id: chatId,
      title: c?.title ?? 'Channel',
      member_count: c?.memberCount ?? 120,
      total_messages: (this.messagesByChat.get(chatId) ?? []).length,
      messages_last_7d: 18,
      views_per_post: 420,
      shares_per_post: 19,
      enabled_notifications_pct: 74.5,
      boosts_count: 12,
      total_reactions: 96,
      active_posters_7d: 6,
      growth_rate_pct: 8.4,
      daily_series: [{ day: today, timestamp_ms: Date.now(), messages: 5, views: 420, members: 120, reactions: 24, active_senders: 3 }],
      daily_growth: [{ date: today, members: 120, views: 420 }],
      top_emojis: [['🔥', 42], ['👍', 31], ['🚀', 23]],
    };
  }

  public async listStories(): Promise<StoryGroup[]> {
    const byUser = new Map<number, StoryGroup>();
    for (const s of this.stories) {
      const grp = byUser.get(s.userId) ?? {
        userId: s.userId,
        username: s.username,
        firstName: s.firstName,
        hasUnviewed: false,
        stories: [],
      };
      grp.stories.push({ ...s });
      if (!s.isViewed) grp.hasUnviewed = true;
      byUser.set(s.userId, grp);
    }
    return Array.from(byUser.values());
  }

  public async createStory(req: { caption?: string; mediaFileId?: string; backgroundGradient?: string }): Promise<StoryItem> {
    const now = Date.now();
    const item: StoryItem = {
      storyId: `story_${now}`,
      story_id: `story_${now}`,
      userId: this.me.userId,
      username: this.me.username,
      firstName: this.me.firstName,
      mediaId: req.mediaFileId,
      mediaType: req.mediaFileId ? 'photo' : 'gradient',
      caption: req.caption,
      backgroundGradient: req.backgroundGradient ?? 'linear-gradient(135deg, #0E1621, #3390EC)',
      privacy: 'everyone',
      viewsCount: 1,
      isViewed: false,
      createdAtMs: now,
      expiresAtMs: now + 86_400_000,
    };
    this.stories.unshift(item);
    return item;
  }

  public async markStoryViewed(storyId: string): Promise<number> {
    const found = this.stories.find((s) => s.storyId === storyId);
    if (found && !found.isViewed) {
      found.isViewed = true;
      found.viewsCount += 1;
    }
    return found?.viewsCount ?? 1;
  }

  public async searchGlobal(query: string, opts?: { tab?: SearchTabCategory }): Promise<GlobalSearchResponse> {
    const q = query.trim().toLowerCase();
    const hits: SearchHitDto[] = [];
    for (const [cid, list] of this.messagesByChat.entries()) {
      const chat = this.chats.get(cid);
      for (const m of list) {
        if (!q || (m.text ?? '').toLowerCase().includes(q)) {
          hits.push({
            chat_id: cid,
            chat_title: chat?.title,
            message_id: m.id,
            sender_id: m.sender_id,
            date_ms: m.date_ms ?? Date.now(),
            text: m.text ?? '',
            snippet_html: m.text ?? '',
          });
        }
      }
    }
    return {
      query,
      tab: opts?.tab ?? 'messages',
      total: hits.length,
      chats: [],
      users: [],
      apps: this.miniApps
        .filter((a) => !q || a.title.toLowerCase().includes(q))
        .map((a) => ({ app_id: a.app_id, bot_username: a.bot_username, short_name: a.short_name, title: a.title, description: a.description })),
      hits,
      messages: hits,
    };
  }

  public async searchMessages(chatId: number, query: string): Promise<SearchHitDto[]> {
    const q = query.trim().toLowerCase();
    const list = this.messagesByChat.get(chatId) ?? [];
    const chat = this.chats.get(chatId);
    return list
      .filter((m) => !q || (m.text ?? '').toLowerCase().includes(q))
      .map((m) => ({
        chat_id: chatId,
        chat_title: chat?.title,
        message_id: m.id,
        sender_id: m.sender_id,
        date_ms: m.date_ms ?? Date.now(),
        text: m.text ?? '',
        snippet_html: m.text ?? '',
      }));
  }

  public async exportChat(chatId: number, format: 'json' | 'html'): Promise<string> {
    const chat = await this.getChat(chatId);
    const msgs = this.messagesByChat.get(chatId) ?? [];
    const peerRecord: Record<number, UserProfile> = {};
    for (const [uid, u] of this.users.entries()) peerRecord[uid] = u;
    return format === 'json'
      ? buildChatExportJson(chat, msgs, peerRecord)
      : buildChatExportHtml(chat, msgs, peerRecord);
  }

  // F6–F13: Messages & Interactive Cards
  public async listMessages(
    chatId: number,
    opts?: { limit?: number; beforeId?: number; topicId?: number },
  ): Promise<{ messages: MessageItem[]; pts: number; hasMore: boolean }> {
    let list = [...(this.messagesByChat.get(chatId) ?? [])];
    if (opts?.topicId !== undefined) {
      list = list.filter((m) => (m.topic_id ?? 1) === opts.topicId);
    }
    if (opts?.beforeId !== undefined) {
      list = list.filter((m) => m.id < opts.beforeId!);
    }
    const limit = opts?.limit ?? 50;
    const hasMore = list.length > limit;
    const sliced = hasMore ? list.slice(-limit) : list;
    const pts = this.chats.get(chatId)?.pts ?? 1;
    return { messages: sliced, pts, hasMore };
  }

  public async sendMessage(req: SendMessagePortInput): Promise<{ message: MessageItem; pts: number; duplicate?: boolean }> {
    const list = this.messagesByChat.get(req.chatId) ?? [];
    if (req.clientNonce !== undefined) {
      const existing = list.find((m) => m.client_nonce === req.clientNonce);
      if (existing) {
        return { message: existing, pts: this.chats.get(req.chatId)?.pts ?? 1, duplicate: true };
      }
    }

    const id = ++this.nextMsgId;
    const msg = makeMessage(id, req.chatId, this.me.userId, true, req.text ?? '', {
      entities: req.entities,
      content: req.content,
      topic_id: req.topicId,
      reply_to: req.replyToMsgId ? { reply_to_msg_id: req.replyToMsgId, quote_text: req.quoteText } : undefined,
      client_nonce: req.clientNonce,
      ttl_seconds: req.ttlSeconds,
      flags: {
        is_out: true,
        is_pinned: false,
        is_silent: Boolean(req.silent),
        is_edited: false,
        is_scheduled: Boolean(req.scheduleAtMs),
        media_unread: false,
        has_reactions: false,
        no_forwards: false,
        is_forwarded: false,
      },
    });
    list.push(msg);
    this.messagesByChat.set(req.chatId, list);

    const chat = this.chats.get(req.chatId);
    const nextPts = (chat?.pts ?? 1) + 1;
    if (chat) {
      chat.pts = nextPts;
      chat.lastMessageId = msg.id;
      chat.lastMessageDateMs = msg.date_ms ?? Date.now();
      chat.lastMessagePreview = msg.text ?? '';
    }

    // Handle BotFather commands in sandbox mode
    if (req.chatId === 3 && (req.text ?? '').startsWith('/newbot')) {
      const parts = (req.text ?? '').trim().split(/\s+/);
      const uname = parts[1] || `SandboxBot${Date.now() % 1000}`;
      const dname = parts.slice(2).join(' ') || uname;
      const created = await this.createBot({ username: uname, displayName: dname });
      const reply = makeMessage(
        ++this.nextMsgId,
        3,
        201,
        false,
        `Done! Congratulations on your new bot @${created.bot.username}.\nToken: \`${created.botToken}\``,
      );
      list.push(reply);
      this.emitUpdate({ type: 'NewMessage', data: reply });
    }

    broadcastSync.publish({
      kind: 'message_upsert',
      accountId: String(this.me.userId),
      chatId: req.chatId,
      message: msg,
      pts: nextPts,
    });
    return { message: msg, pts: nextPts };
  }

  public async editMessage(chatId: number, messageId: number, text: string, entities?: MessageEntity[]): Promise<{ message: MessageItem; pts: number }> {
    const list = this.messagesByChat.get(chatId) ?? [];
    const idx = list.findIndex((m) => m.id === messageId);
    if (idx < 0) throw new Error('Message not found');
    const prev = list[idx]!;
    const updated = enrichMessageItem({
      ...prev,
      text,
      entities: entities ?? prev.entities,
      content: createTextContent(text, entities ?? prev.entities),
      edit_date: new Date().toISOString(),
      isEdited: true,
      flags: { ...prev.flags, is_edited: true },
    });
    list[idx] = updated;
    const chat = this.chats.get(chatId);
    const pts = (chat?.pts ?? 1) + 1;
    if (chat) chat.pts = pts;
    return { message: updated, pts };
  }

  public async deleteMessages(chatId: number, messageIds: number[]): Promise<{ pts: number }> {
    const idSet = new Set(messageIds);
    const list = (this.messagesByChat.get(chatId) ?? []).filter((m) => !idSet.has(m.id));
    this.messagesByChat.set(chatId, list);
    const chat = this.chats.get(chatId);
    const pts = (chat?.pts ?? 1) + 1;
    if (chat) chat.pts = pts;
    return { pts };
  }

  public async forwardMessages(
    fromChatId: number,
    toChatId: number,
    messageIds: number[],
    opts?: { hideSender?: boolean; comment?: string },
  ): Promise<MessageItem[]> {
    const src = this.messagesByChat.get(fromChatId) ?? [];
    const out: MessageItem[] = [];
    if (opts?.comment && opts.comment.trim()) {
      const commentSent = await this.sendMessage({
        chatId: toChatId,
        text: opts.comment.trim(),
      });
      out.push(commentSent.message);
    }
    for (const mid of messageIds) {
      const orig = src.find((m) => m.id === mid);
      if (!orig) continue;
      const sent = await this.sendMessage({
        chatId: toChatId,
        text: orig.text,
        content: orig.content,
      });
      if (!opts?.hideSender) {
        const peer = this.users.get(orig.sender_id);
        sent.message.forward_info = {
          from_id: { User: orig.sender_id },
          from_name: peer
            ? [peer.firstName, peer.lastName].filter(Boolean).join(' ')
            : `User #${orig.sender_id}`,
          date: orig.date_ms ?? Date.now(),
          original_message_id: orig.id,
        };
        sent.message.flags = { ...sent.message.flags, is_forwarded: true };
      }
      out.push(sent.message);
    }
    return out;
  }

  public async pinMessage(chatId: number, messageId: number, pinned: boolean): Promise<number[]> {
    const c = this.chats.get(chatId);
    if (!c) return [];
    const set = new Set(c.pinnedMessageIds);
    if (pinned) set.add(messageId);
    else set.delete(messageId);
    c.pinnedMessageIds = Array.from(set);
    return [...c.pinnedMessageIds];
  }

  public async listPinnedMessages(chatId: number): Promise<MessageItem[]> {
    const c = this.chats.get(chatId);
    const pinnedSet = new Set(c?.pinnedMessageIds ?? []);
    return (this.messagesByChat.get(chatId) ?? []).filter((m) => pinnedSet.has(m.id) || m.flags.is_pinned);
  }

  public async readHistory(chatId: number, maxId: number): Promise<{ unreadCount: number; pts: number }> {
    const c = this.chats.get(chatId);
    if (c) {
      c.unreadCount = 0;
      c.unreadMark = false;
      c.readInboxMaxId = Math.max(c.readInboxMaxId, maxId);
    }
    return { unreadCount: 0, pts: c?.pts ?? 1 };
  }

  public async sendTyping(_chatId: number, _action: TypingAction): Promise<void> {}

  public async toggleReaction(chatId: number, messageId: number, emoji: string): Promise<ReactionCount[]> {
    const list = this.messagesByChat.get(chatId) ?? [];
    const msg = list.find((m) => m.id === messageId);
    if (!msg) return [];
    const existing = msg.reactions.find((r) => r.emoji === emoji);
    if (existing) {
      if (existing.is_chosen_by_me || existing.chosen) {
        existing.count = Math.max(0, existing.count - 1);
        existing.is_chosen_by_me = false;
        existing.chosen = false;
      } else {
        existing.count += 1;
        existing.is_chosen_by_me = true;
        existing.chosen = true;
      }
      msg.reactions = msg.reactions.filter((r) => r.count > 0);
    } else {
      msg.reactions.push({
        emoji,
        count: 1,
        is_chosen_by_me: true,
        chosen: true,
        user_ids: [this.me.userId],
      });
    }
    return [...msg.reactions];
  }

  public async getReactionDetails(chatId: number, messageId: number): Promise<ReactionDetail[]> {
    const list = this.messagesByChat.get(chatId) ?? [];
    const msg = list.find((m) => m.id === messageId);
    return (msg?.reactions ?? []).map((r) => ({
      emoji: r.emoji,
      count: r.count,
      chosen: Boolean(r.is_chosen_by_me || r.chosen),
      user_ids: r.user_ids ?? [this.me.userId],
    }));
  }

  public async sendCallbackQuery(_chatId: number, _messageId: number, data: string): Promise<{ answerText?: string; message?: MessageItem }> {
    return { answerText: `Action acknowledged: ${data}` };
  }

  public async createPoll(
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
  ): Promise<{ message: MessageItem; poll: PollData }> {
    const pollId = ++this.nextPollId;
    const poll: PollData = {
      id: String(pollId),
      poll_id: pollId,
      question: req.question,
      options: req.options.map((text, idx) => ({
        option_id: idx,
        text,
        vote_count: 0,
        is_chosen: false,
        percentage: 0,
      })),
      total_voters: 0,
      is_closed: false,
      is_anonymous: req.isAnonymous ?? true,
      allows_multiple_answers: Boolean(req.allowsMultipleAnswers),
      is_quiz: Boolean(req.isQuiz),
      correct_option_id: req.correctOptionId,
      explanation: req.explanation,
    };
    const sent = await this.sendMessage({
      chatId,
      text: `📊 ${req.question}`,
      content: { type: 'Poll', data: poll },
      topicId: req.topicId,
    });
    this.polls.set(pollId, { chatId, msgId: sent.message.id, poll });
    return { message: sent.message, poll };
  }

  public async votePoll(pollId: number, optionIds: number[]): Promise<PollData> {
    const entry = this.polls.get(pollId);
    if (!entry) throw new Error('Poll not found');
    const chosenSet = new Set(optionIds);
    for (const opt of entry.poll.options) {
      if (opt.is_chosen && !chosenSet.has(opt.option_id)) {
        opt.vote_count = Math.max(0, opt.vote_count - 1);
        opt.is_chosen = false;
      } else if (!opt.is_chosen && chosenSet.has(opt.option_id)) {
        opt.vote_count += 1;
        opt.is_chosen = true;
      }
    }
    const total = entry.poll.options.reduce((acc, o) => acc + o.vote_count, 0);
    entry.poll.total_voters = chosenSet.size > 0 ? Math.max(1, total) : 0;
    for (const opt of entry.poll.options) {
      opt.percentage = total > 0 ? Math.round((opt.vote_count / total) * 100) : 0;
    }
    return { ...entry.poll, options: entry.poll.options.map((o) => ({ ...o })) };
  }

  public async closePoll(pollId: number): Promise<PollData> {
    const entry = this.polls.get(pollId);
    if (!entry) throw new Error('Poll not found');
    entry.poll.is_closed = true;
    return { ...entry.poll };
  }

  public async createTodo(chatId: number, req: { title: string; items: string[]; topicId?: number }): Promise<MessageItem> {
    const listId = `todo_list_${Date.now()}`;
    const sent = await this.sendMessage({
      chatId,
      text: `☑️ ${req.title}`,
      topicId: req.topicId,
      content: {
        type: 'Todo',
        data: {
          id: listId,
          list_id: listId,
          title: req.title,
          completed_count: 0,
          action_buttons: [],
          items: req.items.map((title, idx) => ({
            id: `todo_${idx + 1}`,
            title,
            completed: false,
          })),
        },
      },
    });
    return sent.message;
  }

  public async toggleTodoItem(chatId: number, messageId: number, itemId: string, completed?: boolean): Promise<MessageItem> {
    const list = this.messagesByChat.get(chatId) ?? [];
    const msg = list.find((m) => m.id === messageId);
    if (!msg || msg.content.type !== 'Todo') throw new Error('Todo message not found');
    for (const item of msg.content.data.items) {
      if (String(item.id) === String(itemId)) {
        item.completed = completed ?? !item.completed;
      }
    }
    msg.content.data.completed_count = msg.content.data.items.filter((i) => i.completed).length;
    return { ...msg };
  }

  public async createInvoice(
    chatId: number,
    req: { title: string; description?: string; currency?: string; amount: number },
  ): Promise<{ message: MessageItem; invoice: InvoiceCard; pts: number }> {
    const invId = `inv_${Date.now()}`;
    const invoice: InvoiceCard = {
      id: invId,
      invoice_id: invId,
      title: req.title,
      description: req.description ?? '',
      currency: req.currency ?? 'XTR',
      amount_cents: req.amount,
      total_amount: req.amount,
      status: 'pending',
      is_paid: false,
      prices: [{ label: req.title, amount_cents: req.amount }],
    };
    const sent = await this.sendMessage({
      chatId,
      text: `💳 ${req.title}`,
      content: { type: 'Invoice', data: invoice },
    });
    return { message: sent.message, invoice, pts: sent.pts };
  }

  public async payInvoice(chatId: number, messageId: number): Promise<{ paid: boolean; balance: number; receiptMessage?: MessageItem }> {
    const list = this.messagesByChat.get(chatId) ?? [];
    const msg = list.find((m) => m.id === messageId);
    if (msg && msg.content.type === 'Invoice' && !msg.content.data.is_paid) {
      msg.content.data.is_paid = true;
      const amt = msg.content.data.total_amount;
      this.wallet.balance = Math.max(0, this.wallet.balance - amt);
      this.wallet.stars_balance = this.wallet.balance;
    }
    const receipt = await this.sendMessage({ chatId, text: '✅ Payment receipt confirmed' });
    return { paid: true, balance: this.wallet.balance, receiptMessage: receipt.message };
  }

  public async uploadMedia(
    data: Uint8Array | Blob,
    meta: { fileName: string; mimeType: string; width?: number; height?: number; durationSecs?: number; waveform?: number[] },
    onProgress?: (pct: number) => void,
  ): Promise<MediaDescriptor> {
    const fileId = `sbx_file_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const blob =
      data instanceof Blob
        ? data
        : new Blob([new Uint8Array(data)], { type: meta.mimeType });
    const url = blobUrlRegistry.acquire(fileId, blob);
    const descriptor: MediaDescriptor = {
      file_id: fileId,
      file_name: meta.fileName,
      mime_type: meta.mimeType,
      size_bytes: blob.size,
      url,
      width: meta.width,
      height: meta.height,
      duration_seconds: meta.durationSecs,
      waveform: meta.waveform,
    };
    this.mediaBlobs.set(fileId, { url, descriptor });
    onProgress?.(100);
    return descriptor;
  }

  public getMediaStreamUrl(fileId: string): string {
    return this.mediaBlobs.get(fileId)?.url ?? blobUrlRegistry.get(fileId) ?? '';
  }

  public async listStickerSets(): Promise<StickerSetDto[]> {
    const mkSvg = (emoji: string) =>
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><text x="64" y="88" font-size="72" text-anchor="middle">${emoji}</text></svg>`)}`;
    return [
      {
        set_id: 'set_gpui_core',
        short_name: 'gpui_core',
        title: 'GPUI Mascots',
        count: 4,
        is_installed: true,
        stickers: ['🦀', '⚡', '🐬', '🚀'].map((e, i) => ({
          id: `stk_${i}`,
          set_id: 'set_gpui_core',
          emoji: e,
          svg_data_url: mkSvg(e),
          mime_type: 'image/svg+xml',
          width: 128,
          height: 128,
          is_animated: false,
          is_video: false,
        })),
      },
    ];
  }

  public async installStickerSet(): Promise<void> {}

  public async searchGifs(query: string): Promise<GifResultDto[]> {
    const label = query.trim() || 'Trending';
    const svg = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="140"><rect width="240" height="140" rx="10" fill="#182533"/><text x="120" y="76" fill="#3390EC" font-family="sans-serif" font-size="16" text-anchor="middle">GIF · ${label}</text></svg>`)}`;
    return [{ id: 'gif_1', title: label, file_id: 'gif_1', url: svg, preview_url: svg, width: 240, height: 140, mime_type: 'image/svg+xml' }];
  }

  public async transcribeVoice(fileId: string): Promise<string> {
    return `Sandbox voice transcript (${fileId}): Clear audio verified.`;
  }

  public async aiComposeAssist(text: string, mode: 'improve' | 'shorter' | 'formal' | 'translate_zh' | 'translate_en'): Promise<string> {
    if (mode === 'translate_zh') return `[中文翻译] ${text}`;
    if (mode === 'translate_en') return `[English] ${text}`;
    if (mode === 'shorter') return text.slice(0, Math.max(24, Math.floor(text.length * 0.7)));
    return `${text} ✨`;
  }

  // F14 & F15: Profile, Calls & E2EE
  public async getMe(): Promise<UserProfile> {
    return { ...this.me };
  }

  public async updateProfile(patch: Partial<{ firstName: string; lastName: string; username: string; bio: string; photoFileId: string }>): Promise<UserProfile> {
    Object.assign(this.me, patch);
    this.users.set(this.me.userId, this.me);
    return { ...this.me };
  }

  public async getPrivacySettings(): Promise<UserPrivacySettingsDto> {
    return { ...this.privacy };
  }

  public async updatePrivacySettings(patch: Partial<UserPrivacySettingsDto>): Promise<UserPrivacySettingsDto> {
    this.privacy = { ...this.privacy, ...patch };
    return { ...this.privacy };
  }

  public async listBlockedUsers(): Promise<UserProfile[]> {
    return Array.from(this.blockedIds)
      .map((id) => this.users.get(id))
      .filter((u): u is UserProfile => Boolean(u));
  }

  public async setBlockedUser(userId: number, blocked: boolean): Promise<void> {
    if (blocked) this.blockedIds.add(userId);
    else this.blockedIds.delete(userId);
  }

  public async startCall(calleeId: number, isVideo: boolean, chatId?: number): Promise<CallSessionState> {
    const call: CallSessionState = {
      call_id: `call_${Date.now()}`,
      chat_id: chatId,
      caller_id: this.me.userId,
      callee_id: calleeId,
      is_video: isVideo,
      state: 'active',
      duration_secs: 0,
      emoji_fingerprint: [E2EE_SAFETY_EMOJIS[0]!, E2EE_SAFETY_EMOJIS[7]!, E2EE_SAFETY_EMOJIS[19]!, E2EE_SAFETY_EMOJIS[25]!],
      started_at_ms: Date.now(),
    };
    this.calls.unshift(call);
    return call;
  }

  public async sendCallSignal(_signal: CallSignalPayload): Promise<void> {}

  public async endCall(callId: string, rating?: number): Promise<CallSessionState> {
    const found = this.calls.find((c) => c.call_id === callId) ?? {
      call_id: callId,
      caller_id: this.me.userId,
      callee_id: 102,
      is_video: false,
      state: 'ended' as const,
      duration_secs: 4,
      started_at_ms: Date.now() - 4000,
    };
    found.state = 'ended';
    found.rating = rating;
    found.ended_at_ms = Date.now();
    return { ...found };
  }

  public async listCalls(): Promise<CallSessionState[]> {
    return [...this.calls];
  }

  public async publishPreKeys(req: PublishPreKeysRequest): Promise<PublishPreKeysResponse> {
    return {
      success: true,
      user_id: this.me.userId,
      device_id: req.device_id,
      remaining_one_time_prekeys: req.one_time_prekeys.length,
      updated_at_ms: Date.now(),
    };
  }

  public async getUserPreKeyBundles(userId: number): Promise<UserPreKeyBundlesResponse> {
    return { user_id: userId, devices: [] };
  }

  public async createSecretChat(peerUserId: number, ttlSeconds = 30): Promise<ChatSummary> {
    const peer = this.users.get(peerUserId);
    const id = ++this.nextChatId;
    const now = Date.now();
    const chat: ChatSummary = {
      chatId: id,
      chat_id: id,
      title: `🔒 ${peer?.firstName ?? 'Secret Peer'}`,
      kind: 'secret',
      chatType: 4,
      creatorId: this.me.userId,
      peerUserId,
      colorIndex: peerAvatarColorIndex(id),
      isVerified: false,
      isGroup: false,
      isSupergroup: false,
      isChannel: false,
      isBot: false,
      isForum: false,
      isSecret: true,
      isSavedMessages: false,
      isArchived: false,
      isPinned: false,
      isMuted: false,
      pts: 1,
      lastMessageId: 0,
      lastMessageDateMs: now,
      lastMessagePreview: 'End-to-end encrypted chat ready',
      unreadCount: 0,
      unreadMentionsCount: 0,
      unreadReactionsCount: 0,
      readInboxMaxId: 0,
      readOutboxMaxId: 0,
      slowModeSeconds: 0,
      memberCount: 2,
      pinnedMessageIds: [],
      ttlSeconds,
      emojiFingerprint: ['🔐', '🐬', '💎', '🚀'],
    };
    this.chats.set(id, chat);
    this.messagesByChat.set(id, []);
    return chat;
  }

  // F16: Bots, MiniApps, Hermes, Magpie, Tasks, MCP, Talk, Computers, Tailnet, Wallet
  public async listBots(): Promise<BotRegistryEntry[]> {
    return [...this.bots];
  }

  public async createBot(req: { displayName: string; username: string; description?: string }): Promise<{ bot: BotRegistryEntry; botToken: string; chatId: number }> {
    const botUid = ++this.nextChatId;
    const bot: BotRegistryEntry = {
      bot_user_id: botUid,
      owner_user_id: this.me.userId,
      username: req.username.replace(/^@/, ''),
      display_name: req.displayName,
      description: req.description ?? '',
      about: req.description ?? '',
      commands: [{ command: '/start', description: 'Start bot' }],
      is_official: false,
      is_inline: false,
      allow_attach_menu: false,
      menu_button_type: 'default',
      has_main_app: false,
      created_at_ms: Date.now(),
    };
    this.bots.push(bot);
    const chat = await this.createChat({ title: req.displayName, chatType: 0, username: bot.username, peerUserId: botUid });
    return { bot, botToken: `${botUid}:SBX_${Date.now().toString(36)}`, chatId: chat.chatId };
  }

  public async listMiniApps(query?: string): Promise<MiniAppEntry[]> {
    const q = query?.trim().toLowerCase();
    return q
      ? this.miniApps.filter((a) => a.title.toLowerCase().includes(q) || a.short_name.toLowerCase().includes(q))
      : [...this.miniApps];
  }

  public async launchMiniApp(botUsername: string, shortName: string, chatId?: number): Promise<MiniAppLaunchContext> {
    const cleanBot = botUsername.replace(/^@/, '').toLowerCase();
    const app =
      this.miniApps.find(
        (a) => a.short_name.toLowerCase() === shortName.toLowerCase() || a.bot_username.toLowerCase() === cleanBot,
      ) ?? this.miniApps[0]!;
    const initData = `query_id=sbx_${Date.now()}&user=${encodeURIComponent(JSON.stringify({ id: this.me.userId, first_name: this.me.firstName, username: this.me.username }))}&auth_date=${Math.floor(Date.now() / 1000)}&hash=sandbox_hmac_ok`;
    return {
      app,
      launch_url: `${app.web_url}#tgWebAppData=${encodeURIComponent(initData)}`,
      init_data: initData,
      query_id: `sbx_${Date.now()}`,
      auth_date: Math.floor(Date.now() / 1000),
      companion_chat_id: chatId ?? app.companion_chat_id ?? 4,
      state: {},
      theme_params: {
        bg_color: '#0E1621',
        text_color: '#F5F5F5',
        hint_color: '#7F91A4',
        link_color: '#3390EC',
        button_color: '#3390EC',
        button_text_color: '#FFFFFF',
        secondary_bg_color: '#17212B',
        header_bg_color: '#17212B',
      },
    };
  }

  public async getMiniAppCloudStorage(botUsername: string, shortName: string, keys?: string[]): Promise<Record<string, string>> {
    return indexedDbCache.getCloudStorageItems(String(this.me.userId), botUsername, shortName, keys);
  }

  public async setMiniAppCloudStorage(botUsername: string, shortName: string, key: string, value: string): Promise<void> {
    await indexedDbCache.setCloudStorageItem(String(this.me.userId), botUsername, shortName, key, value);
  }

  public async deleteMiniAppCloudStorage(botUsername: string, shortName: string, keys: string[]): Promise<void> {
    await indexedDbCache.deleteCloudStorageItems(String(this.me.userId), botUsername, shortName, keys);
  }

  public async streamHermesTurn(
    req: { prompt: string; sessionId?: string; chatId?: number; model?: string },
    onEvent: (event: HermesStreamEvent) => void,
  ): Promise<void> {
    const turnId = `turn_${Date.now()}`;
    const sessionId = req.sessionId ?? 'hses_default';
    const model = req.model ?? this.magpieConfig.activeModel;
    onEvent({ type: 'turn_started', turn_id: turnId, session_id: sessionId, model, provider: 'local_hermes' });
    onEvent({ type: 'thinking_delta', turn_id: turnId, delta: 'Inspecting workspace context and protocol invariants...' });
    const reply = `Hermes Sandbox Response: Processed "${req.prompt}" cleanly via ${model}.`;
    onEvent({ type: 'text_delta', turn_id: turnId, text: reply, delta: reply });
    onEvent({
      type: 'done',
      turn_id: turnId,
      session_id: sessionId,
      response_text: reply,
      model,
      provider: 'local_hermes',
      finish_reason: 'stop',
      usage: { input_tokens: 24, output_tokens: 18, reasoning_tokens: 8, total_tokens: 50, estimated_cost_usd: 0 },
      tool_calls_count: 0,
    });
  }

  public async executeHermesSlashCommand(command: string): Promise<{ responseText: string; uiEffect: unknown }> {
    return {
      responseText: `Executed slash command \`${command}\` in local Hermes runtime.`,
      uiEffect: null,
    };
  }

  public async listHermesCommands(prefix?: string): Promise<HermesCommandDescriptor[]> {
    const all: HermesCommandDescriptor[] = [
      { name: '/help', aliases: ['/h'], category: 'session', description: 'Show available Hermes slash commands', usage: '/help' },
      { name: '/status', aliases: [], category: 'inspection_and_export', description: 'Show runtime & model status', usage: '/status' },
      { name: '/model', aliases: ['/m'], category: 'model_and_provider', description: 'Switch active LLM model', usage: '/model <id>' },
      { name: '/memory', aliases: [], category: 'memory_and_persona', description: 'Inspect bounded agent memory', usage: '/memory' },
      { name: '/skills', aliases: [], category: 'tools_and_skills', description: 'List installed skills', usage: '/skills' },
      { name: '/cron', aliases: [], category: 'workflow_and_automation', description: 'Manage scheduled jobs', usage: '/cron' },
    ];
    const p = prefix?.trim().toLowerCase();
    return p ? all.filter((c) => c.name.startsWith(p)) : all;
  }

  public async getHermesStudioState(): Promise<HermesStudioSnapshot> {
    return structuredClone(this.hermesStudio);
  }

  public async updateHermesStudioState(tab: HermesStudioTab, patch: Record<string, unknown>): Promise<HermesStudioSnapshot> {
    if (tab === 'toolsets' && Array.isArray(patch.enabled_toolsets)) {
      this.hermesStudio.enabledToolsets = patch.enabled_toolsets as string[];
    } else if (tab === 'memory' && typeof patch.soul_markdown === 'string') {
      this.hermesStudio.memory.soul = patch.soul_markdown;
    }
    return this.getHermesStudioState();
  }

  public async getMagpieConfig(): Promise<MagpieConfigSnapshot> {
    return structuredClone(this.magpieConfig);
  }

  public async updateMagpieConfig(patch: Record<string, unknown>): Promise<MagpieConfigSnapshot> {
    if (typeof patch.activeProvider === 'string') this.magpieConfig.activeProvider = patch.activeProvider;
    if (typeof patch.activeModel === 'string') this.magpieConfig.activeModel = patch.activeModel;
    if (patch.masking && typeof patch.masking === 'object') {
      this.magpieConfig.masking = { ...this.magpieConfig.masking, ...(patch.masking as Partial<MagpieMaskingConfig>) };
    }
    return this.getMagpieConfig();
  }

  public async getMagpieUsage(): Promise<MagpieUsageLedgerSummary> {
    return {
      total_requests: 12,
      prompt_tokens: 1420,
      completion_tokens: 980,
      total_tokens: 2400,
      masked_pii_count: 3,
      estimated_cost_usd: 0.0024,
      entries: [],
    };
  }

  public async testMagpiePrivacyMask(text: string): Promise<MagpieMaskingPreviewResult> {
    let masked = text;
    const hits: MagpieMaskingPreviewResult['hits'] = [];
    masked = masked.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (m) => {
      hits.push({ kind: 'email', placeholder: '[EMAIL_1]', action: 'mask', preview_hint: m.slice(0, 3) + '***' });
      return '[EMAIL_1]';
    });
    masked = masked.replace(/sk-[a-zA-Z0-9_-]{8,}/g, () => {
      hits.push({ kind: 'api_key', placeholder: '[API_KEY_1]', action: 'mask', preview_hint: 'sk-***' });
      return '[API_KEY_1]';
    });
    return { masked_text: masked, hits, hit_count: hits.length, blocked: false };
  }

  public async listTasks(): Promise<TaskItemDto[]> {
    return [...this.tasks];
  }

  public async createTask(req: { title: string; description?: string; cronExpr?: string; chatId?: number }): Promise<TaskItemDto> {
    const now = Date.now();
    const item: TaskItemDto = {
      task_id: `task_${now}`,
      title: req.title,
      description: req.description ?? '',
      state: 'queued',
      cron_expr: req.cronExpr ?? null,
      chat_id: req.chatId ?? null,
      progress: 0,
      logs: ['Created task'],
      created_at_ms: now,
      updated_at_ms: now,
    };
    this.tasks.unshift(item);
    return item;
  }

  public async updateTask(taskId: string, patch: Partial<{ state: TaskItemDto['state']; title: string; cronExpr: string }>): Promise<TaskItemDto> {
    const found = this.tasks.find((t) => t.task_id === taskId);
    if (!found) throw new Error('Task not found');
    if (patch.state) found.state = patch.state;
    if (patch.title) found.title = patch.title;
    if (patch.cronExpr !== undefined) found.cron_expr = patch.cronExpr;
    found.updated_at_ms = Date.now();
    return { ...found };
  }

  public async deleteTask(taskId: string): Promise<void> {
    this.tasks = this.tasks.filter((t) => t.task_id !== taskId);
  }

  public async listMcpServers(): Promise<McpServerDto[]> {
    return [...this.mcpServers];
  }

  public async listMcpTools(): Promise<{ tools: McpToolDto[]; approvals: McpPendingApprovalDto[] }> {
    return { tools: [...this.mcpTools], approvals: [...this.mcpApprovals] };
  }

  public async invokeMcpTool(req: { toolId?: string; toolName?: string; arguments?: Record<string, unknown> }): Promise<Record<string, unknown>> {
    return { status: 'completed', tool_name: req.toolName ?? req.toolId ?? 'browser_snapshot', output: { ok: true, args: req.arguments ?? {} } };
  }

  public async approveMcpToolCall(requestId: string, allow: boolean): Promise<void> {
    const item = this.mcpApprovals.find((a) => a.request_id === requestId);
    if (item) item.status = allow ? 'approved' : 'rejected';
  }

  public async startTalkSession(): Promise<TalkSessionDto> {
    this.talkSession = { ...this.talkSession, state: 'listening', signal_seq: this.talkSession.signal_seq + 1 };
    return { ...this.talkSession };
  }

  public async sendTalkAudio(audioOrTranscript: Uint8Array | { transcript: string }): Promise<TalkSessionDto> {
    const transcript = audioOrTranscript instanceof Uint8Array ? 'Voice audio utterance' : audioOrTranscript.transcript;
    this.talkSession = {
      ...this.talkSession,
      state: 'speaking',
      signal_seq: this.talkSession.signal_seq + 1,
      buffered_chunks: this.talkSession.buffered_chunks + 1,
      last_transcript: transcript,
      last_reply: `Heard "${transcript}" — ready for barge-in.`,
      tts_segments: [`Heard "${transcript}".`],
    };
    return { ...this.talkSession };
  }

  public async bargeInTalkSession(): Promise<TalkSessionDto> {
    this.talkSession = {
      ...this.talkSession,
      state: 'listening',
      generation: this.talkSession.generation + 1,
      signal_seq: this.talkSession.signal_seq + 1,
      buffered_chunks: 0,
      tts_segments: [],
    };
    return { ...this.talkSession };
  }

  public async stopTalkSession(): Promise<TalkSessionDto> {
    this.talkSession = { ...this.talkSession, state: 'idle', signal_seq: this.talkSession.signal_seq + 1 };
    return { ...this.talkSession };
  }

  public async listComputers(): Promise<{ computers: ComputerNodeDto[]; pendingApprovals: PendingComputerCommandDto[] }> {
    return { computers: [...this.computers], pendingApprovals: [...this.computerApprovals] };
  }

  public async executeComputerOp(nodeId: string, operation: Record<string, unknown>): Promise<Record<string, unknown>> {
    return { ok: true, node_id: nodeId, executed: operation };
  }

  public async approveComputerCommand(commandId: string, approve: boolean): Promise<PendingComputerCommandDto> {
    const found = this.computerApprovals.find((c) => c.command_id === commandId) ?? {
      command_id: commandId,
      node_id: 'sandbox:default',
      caller_label: 'Hermes',
      operation: {},
      status: 'pending' as const,
      created_at_ms: Date.now(),
    };
    found.status = approve ? 'approved' : 'denied';
    return found;
  }

  public async updateComputerPolicy(nodeId: string, policy: ComputerRunPolicy): Promise<ComputerNodeDto> {
    const node = this.computers.find((c) => c.node_id === nodeId) ?? this.computers[0]!;
    node.run_policy = policy;
    return { ...node };
  }

  public async emergencyTakeoverComputer(nodeId = 'sandbox:default'): Promise<{ status: string; newGeneration: number; latencySub10ms: boolean }> {
    const node = this.computers.find((c) => c.node_id === nodeId) ?? this.computers[0]!;
    node.lease_generation += 1;
    node.lease_state = 'human_takeover';
    return { status: 'revoked', newGeneration: node.lease_generation, latencySub10ms: true };
  }

  public async getTailnetStatus(): Promise<TailnetStatusDto> {
    const now = Date.now();
    const selfPeer = {
      device_id: 'dev_web_sandbox',
      display_name: 'This Browser Tab',
      ipv4: '100.64.0.2',
      relay_mode: 'direct' as const,
      derp_region: 'us-west',
      online: true,
      latency_ms: 4,
      last_seen_ms: now,
    };
    return {
      owner_user_id: this.me.userId,
      seq: 1,
      connected: true,
      derp_region: 'us-west',
      derp_ws_path: '/api/v1/tailnet/derp',
      stun_http_path: '/api/v1/tailnet/stun',
      self_peer: selfPeer,
      peers: [selfPeer],
    };
  }

  public async getWalletState(): Promise<WalletStateDto> {
    return structuredClone(this.wallet);
  }

  public async topUpStars(amount: number): Promise<WalletStateDto> {
    this.wallet.balance += amount;
    this.wallet.stars_balance = this.wallet.balance;
    this.wallet.updated_at_ms = Date.now();
    this.wallet.transactions.unshift({
      tx_id: `tx_${Date.now()}`,
      kind: 'topup',
      amount_stars: amount,
      description: `Topped up ${amount} Stars`,
      created_at_ms: Date.now(),
    });
    return this.getWalletState();
  }

  public async sendStarGift(req: { toUserId: number; chatId?: number; amountStars: number; message?: string }): Promise<WalletStateDto> {
    this.wallet.balance = Math.max(0, this.wallet.balance - req.amountStars);
    this.wallet.stars_balance = this.wallet.balance;
    this.wallet.transactions.unshift({
      tx_id: `tx_${Date.now()}`,
      kind: 'gift_sent',
      amount_stars: -req.amountStars,
      peer_user_id: req.toUserId,
      chat_id: req.chatId,
      description: req.message ?? `Sent Star Gift (${req.amountStars} ⭐)`,
      created_at_ms: Date.now(),
    });
    return this.getWalletState();
  }

  // F17: BrowserControlClientPort
  public async createDesktopPairingTicket(): Promise<DesktopPairingTicketDto> {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    return {
      pair_code: code,
      desktop_token: `sbx_dtok_${code}`,
      expires_at_ms: Date.now() + 300_000,
      http_base_url: 'http://localhost:8080',
      ws_bridge_url: 'ws://localhost:8080/api/v1/ws',
      mcp_rpc_url: 'http://localhost:8080/api/v1/mcp/rpc',
    };
  }

  public async claimDesktopPairingTicket(pairCode: string): Promise<DesktopPairingTicketDto> {
    return {
      pair_code: pairCode,
      desktop_token: `sbx_dtok_${pairCode}`,
      expires_at_ms: Date.now() + 3600_000,
      http_base_url: 'http://localhost:8080',
      ws_bridge_url: 'ws://localhost:8080/api/v1/ws',
      mcp_rpc_url: 'http://localhost:8080/api/v1/mcp/rpc',
    };
  }

  public async listBrowserTargets(): Promise<{ targets: BrowserTargetDescriptor[]; control_generation: number }> {
    const snap = browserControlAgent.captureSnapshot();
    const st = browserControlAgent.getState();
    return {
      control_generation: st.controlGeneration,
      targets: [
        {
          target_id: snap.target_id,
          user_id: this.me.userId,
          kind: 'live_web_tab',
          title: snap.title || 'GPUI Telegram Web',
          url: snap.url,
          viewport: snap.viewport,
          theme: snap.theme,
          active_chat_id: snap.active_chat_id,
          active_nav_dest: snap.active_nav_dest,
          connected_at_ms: Date.now() - 60_000,
          last_heartbeat_ms: Date.now(),
          allow_remote_control: st.allowDesktopControl,
          active_controller: st.isRemoteActive ? 'Sandbox Controller' : null,
          control_generation: st.controlGeneration,
        },
      ],
    };
  }

  public async registerBrowserTarget(payload: BrowserRegisterPayload): Promise<BrowserTargetDescriptor> {
    const list = await this.listBrowserTargets();
    return { ...list.targets[0]!, title: payload.title, url: payload.url };
  }

  public async reportBrowserState(_payload: BrowserStateReportPayload): Promise<BrowserTargetDescriptor> {
    const list = await this.listBrowserTargets();
    return list.targets[0]!;
  }

  public async sendBrowserCommand(req: BrowserCommandRequest): Promise<BrowserCommandResult> {
    return browserControlAgent.executeCommand(req, 'ui');
  }

  public async revokeBrowserControl(): Promise<BrowserControlRevokeResponse> {
    const res = browserControlAgent.emergencyTakeover('sandbox_revoke');
    return {
      ok: true,
      control_generation: res.controlGeneration,
      revoked_tokens_count: 1,
      aborted_commands_count: 0,
      elapsed_us: Math.round(res.elapsedMs * 1000),
      latency_sub10ms: res.elapsedMs < 10,
    };
  }

  public async listBrowserAuditLogs(): Promise<{ entries: BrowserAuditLogEntry[] }> {
    const st = browserControlAgent.getState();
    return {
      entries: st.auditLogs.map((a) => ({
        audit_id: a.id,
        timestamp_ms: a.timestampMs,
        target_id: st.targetId,
        caller: a.source,
        action: a.action,
        status: a.ok ? 'ok' : 'error',
        summary: a.detail ?? a.target,
        latency_ms: a.durationMs,
      })),
    };
  }

  public async openHeadlessSession(req?: { url?: string; viewport?: { width: number; height: number } }): Promise<{ session: HeadlessBrowserSessionDto; snapshot: BrowserSnapshotDto }> {
    const sid = `hls_${Date.now()}`;
    const now = Date.now();
    const session: HeadlessBrowserSessionDto = {
      session_id: sid,
      backend: 'http_dom_fallback',
      url: req?.url ?? 'https://example.org',
      title: 'Sandbox Headless Session',
      viewport: req?.viewport ?? { width: 1280, height: 720 },
      created_at_ms: now,
      updated_at_ms: now,
      status: 'ready',
    };
    const snapshot = browserControlAgent.captureSnapshot();
    this.headlessSessions.set(sid, { session, snapshot });
    return { session, snapshot };
  }

  public async listHeadlessSessions(): Promise<{ sessions: HeadlessBrowserSessionDto[] }> {
    return { sessions: Array.from(this.headlessSessions.values()).map((v) => v.session) };
  }

  public async executeHeadlessAction(sessionId: string, req: Omit<BrowserCommandRequest, 'target_id'>): Promise<BrowserCommandResult> {
    return browserControlAgent.executeCommand({ ...req, target_id: sessionId }, 'ui');
  }

  public async captureHeadlessScreenshot(sessionId: string): Promise<{ session_id: string; screenshot_data_url: string; mime_type: string; backend: HeadlessBrowserSessionDto['backend'] }> {
    const res = await browserControlAgent.executeCommand({ action: 'screenshot', target_id: sessionId }, 'ui');
    return {
      session_id: sessionId,
      screenshot_data_url: res.screenshot_data_url ?? '',
      mime_type: 'image/svg+xml',
      backend: 'http_dom_fallback',
    };
  }

  public async closeHeadlessSession(sessionId: string): Promise<{ ok: boolean; session_id: string }> {
    this.headlessSessions.delete(sessionId);
    return { ok: true, session_id: sessionId };
  }

  public async invokeMcpRpc(req: McpJsonRpcRequest): Promise<McpJsonRpcResponse> {
    return {
      jsonrpc: '2.0',
      id: req.id ?? 1,
      result: { ok: true, method: req.method },
    };
  }
}
