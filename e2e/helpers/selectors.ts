/**
 * Canonical DOM IDs, data-testid hooks, theme/tab registries, and safe CSS
 * attribute selector builders contracted in PROJECT.md § Interface Contracts
 * and TEST_INFRA.md for Fabushi Web v1.6.11.
 *
 * Strictly opaque-box: zero imports from application source packages.
 * Zero demo/sandbox auth bypass selectors.
 */

// -----------------------------------------------------------------------------
// Canonical UPPER_SNAKE_CASE v1.6.11 Selector Constants (PROJECT.md §3)
// -----------------------------------------------------------------------------
export const SIDEBAR_PINNED_CHATS_GRID = '#sidebar-pinned-chats-grid' as const;
export const APPLE_COMPOSE_STAGE = '#apple-compose-stage' as const;
export const BOT_PRESTART_BAR = '#bot-prestart-bar' as const;
export const CMP_INPUT_WRAP = '#cmp-input-wrap' as const;
export const STAGE_TOAST_PILL = '#stage-toast-pill' as const;
export const WINDOW_TOAST_BANNER = '#window-toast-banner' as const;
export const MINIAPP_PIP_OVERLAY = '#miniapp-pip-overlay' as const;
export const NAV_DEST_BROWSER = '#nav-dest-browser' as const;
export const BROWSER_WORKSPACE = '#browser-workspace' as const;
export const BROWSER_INSPECTOR_TABS = '#browser-inspector-tabs' as const;
export const AUTOMATION_APP_STORE_PANEL = '#automation-app-store-panel' as const;
export const OAUTH_MCP_GRANTS_PANEL = '#oauth-mcp-grants-panel' as const;
export const REMOTE_ASSIST_PANEL = '#remote-assist-panel' as const;
export const VAULT_SETTINGS_PANEL = '#vault-settings-panel' as const;

/**
 * Attribute-substring selector used by Zero-Fake-Data assertions to prove
 * no demo-login or simulated-QR controls exist anywhere in production auth UI.
 */
export const FORBIDDEN_DEMO_CONTROL_SELECTOR =
  '[id*="demo-login"], [id*="demo-auth"], [data-testid*="demo-login"], [id*="simulate-qr"], [data-testid*="simulate-qr"]' as const;

/**
 * Bilingual accessible button-text pattern for removed demo/sandbox/QR-sim controls.
 */
export const FORBIDDEN_DEMO_BUTTON_TEXT =
  /demo\s*login|1-click\s*demo|simulate\s*qr|standalone\s*sandbox|一键体验|演示登录|模拟扫码|沙盒模式/i;

export const DOM = {
  // ---------------------------------------------------------------------------
  // 1. Auth & Lock (PROJECT.md §3)
  // ---------------------------------------------------------------------------
  authScreen: '#auth-screen',
  tabAuthPhone: '#tab-auth-phone',
  tabAuthQr: '#tab-auth-qr',
  btnQrLoginFallback: '#tab-auth-qr, #btn-qr-login',
  tabAuthPassword: '#tab-auth-password',
  tabAuthEmail: '#tab-auth-email',
  tabAuthAlipay: '#tab-auth-alipay',
  btnAuthPasskey: '#btn-auth-passkey',
  authCountrySelect: '#auth-country-select',
  authPhoneInput: '#auth-phone-input',
  btnAuthSendCode: '#btn-auth-send-code',
  authCodeInput: '#auth-code-input',
  auth2faInput: '#auth-2fa-input',
  btnAuthSubmit2fa: '#btn-auth-submit-2fa',
  qrLoginSvg: '#qr-login-svg',
  authUsernameInput: '#auth-username-input',
  authPasswordInput: '#auth-password-input',
  btnAuthPasswordSubmit: '#btn-auth-password-submit',
  authModeRegisterToggle: '#auth-mode-register-toggle',
  authServerUrlInput: '#auth-server-url-input',
  passcodeLockScreen: '#passcode-lock-screen',
  passcodeUnlockInput: '#passcode-unlock-input',

  // ---------------------------------------------------------------------------
  // 2. App Shell & Left Column (PROJECT.md §3)
  // ---------------------------------------------------------------------------
  appShell: '#app-shell',
  connectionStatusBanner: '#connection-status-banner',
  leftColumn: '#left-column',
  btnCollapseSidebar: '#btn-collapse-sidebar',
  btnMainMenu: '#btn-main-menu',
  mainMenuDrawer: '#main-menu-drawer',
  menuAccountSwitcher: '#menu-account-switcher',
  menuItemSavedMessages: '#menu-item-saved-messages',
  menuItemArchived: '#menu-item-archived',
  menuItemContacts: '#menu-item-contacts',
  menuItemNewGroup: '#menu-item-new-group',
  menuItemNewChannel: '#menu-item-new-channel',
  menuItemSettings: '#menu-item-settings',
  menuToggleNightMode: '#menu-toggle-night-mode',
  menuToggleLanguage: '#menu-toggle-language',
  menuItemWallet: '#menu-item-wallet',
  menuItemLogout: '#menu-item-logout',
  globalSearchInput: '#global-search-input',
  searchTabs: '#search-tabs',
  storiesBar: '#stories-bar',
  storiesViewer: '#stories-viewer',
  chatFolderTabs: '#chat-folder-tabs',
  folderTabItem: '#chat-folder-tabs [data-folder-id]',
  sidebarPinnedChatsGrid: SIDEBAR_PINNED_CHATS_GRID,
  archivedChatsRow: '#archived-chats-row',
  chatList: '#chat-list',
  chatRow: '[data-testid="chat-row"]',
  forumTopicList: '#forum-topic-list',
  forumTopicItem: '[data-topic-id]',
  btnNewChatFab: '#btn-new-chat-fab',
  navRail: '#nav-rail',
  navDestChats: '#nav-dest-chats',
  navDestBrowser: NAV_DEST_BROWSER,
  navDestTasks: '#nav-dest-tasks',
  navDestMcp: '#nav-dest-mcp',
  navDestTalk: '#nav-dest-talk',
  navDestComputer: '#nav-dest-computer',
  navDestHermes: '#nav-dest-hermes',
  navDestSettings: '#nav-dest-settings',

  // ---------------------------------------------------------------------------
  // 3. Middle Column, Apple/Muse & Grok Bot Stage (PROJECT.md §3)
  // ---------------------------------------------------------------------------
  middleColumn: '#middle-column',
  btnBackToChats: '#btn-back-to-chats',
  chatHeader: '#chat-header',
  chatHeaderTitle: '#chat-header-title',
  chatHeaderStatus: '#chat-header-status',
  btnInChatSearch: '#btn-in-chat-search',
  btnStartAudioCall: '#btn-start-audio-call',
  btnStartVideoCall: '#btn-start-video-call',
  btnToggleRightColumn: '#btn-toggle-right-column',
  btnChatMore: '#btn-chat-more',
  pinnedMessageBanner: '#pinned-message-banner',
  messageList: '#message-list',
  messageBubble: '[data-testid="message-bubble"]',
  btnScrollToBottom: '#btn-scroll-to-bottom',
  selectionToolbar: '#selection-toolbar',
  appleComposeStage: APPLE_COMPOSE_STAGE,
  botPrestartBar: BOT_PRESTART_BAR,
  cmpInputWrap: CMP_INPUT_WRAP,
  composerReplyEditBanner: '#composer-reply-edit-banner',
  messageComposerInput: '#message-composer-input',
  btnFormattingToolbar: '#btn-formatting-toolbar',
  btnEmojiPicker: '#btn-emoji-picker',
  emojiStickerGifPopover: '#emoji-sticker-gif-popover',
  btnAttachMenu: '#btn-attach-menu',
  fileUploadInput: '#file-upload-input',
  btnAiCompose: '#btn-ai-compose',
  btnRecordVoice: '#btn-record-voice',
  btnSendMessage: '#btn-send-message',
  stageToastPill: STAGE_TOAST_PILL,
  windowToastBanner: WINDOW_TOAST_BANNER,
  topAudioPlayerBar: '#top-audio-player-bar',
  topCallBar: '#top-call-bar',

  // ---------------------------------------------------------------------------
  // 4. Right Column, Settings & Modals (PROJECT.md §3)
  // ---------------------------------------------------------------------------
  rightColumn: '#right-column',
  rightProfileInfo: '#right-profile-info',
  rightTabs: '#right-tabs',
  rightTabMembers: '#right-tab-members',
  rightTabMedia: '#right-tab-media',
  rightTabFiles: '#right-tab-files',
  rightTabLinks: '#right-tab-links',
  rightTabVoice: '#right-tab-voice',
  rightTabStats: '#right-tab-stats',
  inChatSearchInput: '#in-chat-search-input',
  inChatSearchPrev: '#in-chat-search-prev',
  inChatSearchNext: '#in-chat-search-next',
  settingsPanel: '#settings-panel',
  settingsSectionItem: '#settings-panel [data-settings-section]',
  vaultSettingsPanel: VAULT_SETTINGS_PANEL,
  btnExportChatJson: '#btn-export-chat-json',
  btnExportChatHtml: '#btn-export-chat-html',
  lightboxViewer: '#lightbox-viewer',
  lightboxZoomIn: '#lightbox-zoom-in',
  lightboxRotate: '#lightbox-rotate',
  lightboxNext: '#lightbox-next',
  lightboxPrev: '#lightbox-prev',
  lightboxDownload: '#lightbox-download',
  lightboxClose: '#lightbox-close',
  modalMediaEditor: '#modal-media-editor',
  instantViewModal: '#instant-view-modal',
  modalCreateGroup: '#modal-create-group',
  modalCreateChannel: '#modal-create-channel',
  modalContacts: '#modal-contacts',
  modalForward: '#modal-forward',
  modalCreatePoll: '#modal-create-poll',
  modalCreateTodo: '#modal-create-todo',
  modalShortcuts: '#modal-shortcuts',
  callOverlay: '#call-overlay',

  // ---------------------------------------------------------------------------
  // 5. v1.6.11 Workspaces, MiniApps, AI, MCP, Remote Assist & Browser
  // ---------------------------------------------------------------------------
  miniappModal: '#miniapp-modal',
  miniappIframe: '#miniapp-iframe',
  miniappPipOverlay: MINIAPP_PIP_OVERLAY,
  browserWorkspace: BROWSER_WORKSPACE,
  browserControlWorkspace: '#browser-control-workspace',
  browserWorkspaceAny: `${BROWSER_WORKSPACE}, #browser-control-workspace`,
  browserInspectorTabs: BROWSER_INSPECTOR_TABS,
  automationAppStorePanel: AUTOMATION_APP_STORE_PANEL,
  btnBrowserPairDesktop: '#btn-browser-pair-desktop',
  browserPairingCodeDisplay: '#browser-pairing-code-display',
  btnBrowserRevokeControl: '#btn-browser-revoke-control',
  browserSnapshotView: '#browser-snapshot-view',
  browserHeadlessUrlInput: '#browser-headless-url-input',
  btnBrowserHeadlessOpen: '#btn-browser-headless-open',
  browserHeadlessViewport: '#browser-headless-viewport',
  browserAuditLog: '#browser-audit-log',
  hermesStudioPanel: '#hermes-studio-panel',
  hermesTabItem: '#hermes-studio-panel [data-hermes-tab]',
  magpieGatewayPanel: '#magpie-gateway-panel',
  taskCenterWorkspace: '#task-center-workspace',
  mcpToolsDock: '#mcp-tools-dock',
  oauthMcpGrantsPanel: OAUTH_MCP_GRANTS_PANEL,
  talkModeOrb: '#talk-mode-orb',
  computerWorkbench: '#computer-workbench',
  computerCanvas: '#computer-canvas',
  btnComputerTakeover: '#btn-computer-takeover',
  remoteAssistPanel: REMOTE_ASSIST_PANEL,
  walletStarsModal: '#wallet-stars-modal',
} as const;

export type DOMKey = keyof typeof DOM;
export type DOMSelector = (typeof DOM)[DOMKey];

/** Canonical 4 Vanilla CSS themes on `:root[data-theme="..."]`. */
export const THEMES = ['night', 'tinted', 'day', 'classic'] as const;
export type ThemeName = (typeof THEMES)[number];

/** Canonical authentication mode tabs. */
export const AUTH_TABS = {
  phone: DOM.tabAuthPhone,
  qr: DOM.tabAuthQr,
  password: DOM.tabAuthPassword,
  email: DOM.tabAuthEmail,
  alipay: DOM.tabAuthAlipay,
} as const;
export type AuthTabKey = keyof typeof AUTH_TABS;

/** Canonical unified navigation rail destinations (v1.6.11). */
export const NAV_DESTS = {
  chats: DOM.navDestChats,
  browser: DOM.navDestBrowser,
  tasks: DOM.navDestTasks,
  mcp: DOM.navDestMcp,
  talk: DOM.navDestTalk,
  computer: DOM.navDestComputer,
  hermes: DOM.navDestHermes,
  settings: DOM.navDestSettings,
} as const;
export type NavDestKey = keyof typeof NAV_DESTS;

/** Canonical right-column context inspector tabs. */
export const RIGHT_TABS = {
  members: DOM.rightTabMembers,
  media: DOM.rightTabMedia,
  files: DOM.rightTabFiles,
  links: DOM.rightTabLinks,
  voice: DOM.rightTabVoice,
  stats: DOM.rightTabStats,
} as const;
export type RightTabKey = keyof typeof RIGHT_TABS;

/** Runtime CSS custom properties. */
export const CSS_VARS = {
  fontSize: '--tg-font-size',
  bubbleRadius: '--tg-bubble-radius',
  uiScale: '--tg-ui-scale',
} as const;

/** Canonical data-* attribute names. */
export const DATA_ATTRS = {
  theme: 'data-theme',
  testId: 'data-testid',
  chatId: 'data-chat-id',
  messageId: 'data-message-id',
  folderId: 'data-folder-id',
  topicId: 'data-topic-id',
  settingsSection: 'data-settings-section',
  hermesTab: 'data-hermes-tab',
  browserRef: 'data-bctrl-ref',
} as const;

/** 4-tier responsive viewport presets. */
export const VIEWPORTS = {
  desktop3Col: { width: 1440, height: 900 },
  desktop2Col: { width: 1100, height: 800 },
  tabletDrawer: { width: 768, height: 900 },
  mobileStack: { width: 390, height: 844 },
} as const;

/** Multi-tab BroadcastChannel name. */
export const BROADCAST_CHANNEL_NAME = 'gpui-telegram-web-sync' as const;

/** Canonical v1.6.11 backend HTTP/WS/OAuth/MCP/WASM endpoints (PROJECT.md §2). */
export const API_PATHS = {
  // Core Health, Status, Updates & Sync
  healthRaw: '/health',
  health: '/api/v1/health',
  status: '/api/v1/status',
  testReset: '/api/v1/test/reset',
  ws: '/api/v1/ws',
  syncGetDifference: '/api/v1/sync/get_difference',
  updatesLatestMac: '/api/v1/updates/latest-mac.json',
  updatesAssets: '/api/v1/updates/assets',
  swJs: '/sw.js',
  manifest: '/manifest.webmanifest',

  // Real Auth & Split-Key V2
  authBase: '/api/v1/auth',
  authKdfParams: '/api/v1/auth/kdf-params',
  authRegister: '/api/v1/auth/register',
  authLogin: '/api/v1/auth/login',
  authPasswordRegister: '/api/v1/auth/password/register',
  authPasswordLogin: '/api/v1/auth/password/login',
  authEmailRegister: '/api/v1/auth/email/register',
  authUpgradeSplitKey: '/api/v1/auth/upgrade-split-key',
  authChangePassword: '/api/v1/auth/change-password',
  authPhoneSendCode: '/api/v1/auth/phone/send-code',
  authPhoneVerify: '/api/v1/auth/phone/verify',
  auth2fa: '/api/v1/auth/2fa',
  auth2faSet: '/api/v1/auth/2fa/set',
  auth2faVerify: '/api/v1/auth/2fa/verify',
  authPairCreate: '/api/v1/auth/pair/create',
  authPairStatus: '/api/v1/auth/pair/status',
  authPairAccept: '/api/v1/auth/pair/accept',
  authPasskeyRegisterOptions: '/api/v1/auth/passkey/register/options',
  authPasskeyRegisterVerify: '/api/v1/auth/passkey/register/verify',
  authPasskeyLoginOptions: '/api/v1/auth/passkey/login/options',
  authPasskeyVerify: '/api/v1/auth/passkey/verify',
  authAlipayConfirm: '/api/v1/auth/alipay/confirm',
  authLogout: '/api/v1/auth/logout',
  account: '/api/v1/account',
  accountMe: '/api/v1/me',

  // E2EE User Vault & X25519 Device Trust Ring
  vaultEnvelope: '/api/v1/user-vault/envelope',
  vaultItems: '/api/v1/user-vault/items',
  vaultDeviceSync: '/api/v1/user-vault/device-sync',
  vaultDeviceSyncRequest: '/api/v1/user-vault/device-sync/request',
  vaultDeviceSyncPending: '/api/v1/user-vault/device-sync/pending',

  // Messaging, Chats, Contacts, Stories, Wallet, Media, Tasks, Talk
  chats: '/api/v1/chats',
  chatsCreate: '/api/v1/chats/create',
  chatsSaved: '/api/v1/chats/saved',
  messages: '/api/v1/messages',
  contacts: '/api/v1/contacts',
  stories: '/api/v1/stories',
  folders: '/api/v1/folders',
  media: '/api/v1/media',
  wallet: '/api/v1/wallet',
  walletTopup: '/api/v1/wallet/topup',
  walletStarsTopup: '/api/v1/wallet/stars/topup',
  tasks: '/api/v1/tasks',
  talkAudio: '/api/v1/talk/audio',
  gifsSvgRocket: '/api/v1/gifs/svg/rocket',

  // E2EE Prekeys (X3DH / Double Ratchet)
  e2eePrekeys: '/api/v1/e2ee/prekeys',
  e2eePrekeysCount: '/api/v1/e2ee/prekeys/count',

  // Unified Fabushi / Hermes Runtime, Multi-Agent & Magpie v1.6
  fabushiStatus: '/api/v1/fabushi/status',
  fabushiTurns: '/api/v1/fabushi/turns',
  fabushiCommand: '/api/v1/fabushi/command',
  fabushiSessions: '/api/v1/fabushi/sessions',
  fabushiMemory: '/api/v1/fabushi/memory',
  fabushiMemoryAction: '/api/v1/fabushi/memory/action',
  fabushiSkills: '/api/v1/fabushi/skills',
  fabushiApprovals: '/api/v1/fabushi/approvals',
  fabushiCron: '/api/v1/fabushi/cron',
  fabushiBots: '/api/v1/fabushi-bots',
  magpieState: '/api/v1/fabushi/magpie/state',
  magpieProviders: '/api/v1/fabushi/magpie/providers',
  magpieModelsCatalog: '/api/v1/fabushi/magpie/models/catalog',
  magpieSubscriptionsSync: '/api/v1/fabushi/magpie/subscriptions/sync',
  magpieGroups: '/api/v1/fabushi/magpie/groups',
  magpieMasking: '/api/v1/fabushi/magpie/masking',
  magpieMaskPreview: '/api/v1/fabushi/magpie/mask-preview',
  magpieMaskingPreview: '/api/v1/fabushi/magpie/masking/preview',
  magpieV1Models: '/api/v1/magpie/v1/models',
  magpieV1ChatCompletions: '/api/v1/magpie/v1/chat/completions',
  magpieV1Responses: '/api/v1/magpie/v1/responses',
  magpieV1Messages: '/api/v1/magpie/v1/messages',
  openaiV1Models: '/v1/models',
  openaiV1ChatCompletions: '/v1/chat/completions',

  // Coding Agent Bots
  codingAgentsProbe: '/api/v1/coding-agents/probe',

  // Decoupled Mini Apps, WebMCP & Fabushi 3D WASM
  telegramWebAppSdk: '/js/telegram-web-app.js',
  miniapps: '/api/v1/miniapps',
  miniappsCatalog: '/api/v1/miniapps/catalog',
  miniappsInstalled: '/api/v1/miniapps/installed',
  miniappsRecent: '/api/v1/miniapps/recent',
  bots: '/api/v1/bots',
  botfatherNlCreate: '/api/v1/botfather/nl-create',
  fabushiMiniAppBase: '/api/v1/fabushi-miniapp',
  fabushiMiniAppMembership: '/api/v1/fabushi-miniapp/membership',
  fabushiMiniAppApiWasm: '/api/v1/fabushi-miniapp/app.wasm',
  fabushiMiniAppWasm: '/miniapps/fabushi-globe/fabushi_miniapp.wasm',
  fabushiMiniAppIndex: '/miniapps/fabushi-globe/index.html',

  // UU-Parity Remote Assist, Computers & Tailnet
  remoteAssistInfo: '/api/v1/remote/assist/info',
  remoteAssistResetCode: '/api/v1/remote/assist/reset-code',
  remoteAssistSetCode: '/api/v1/remote/assist/set-code',
  remoteAssistAllow: '/api/v1/remote/assist/allow',
  remoteAssistStart: '/api/v1/remote/assist/start',
  remoteSessions: '/api/v1/remote/sessions',
  remoteSessionsDisconnect: '/api/v1/remote/sessions/disconnect',
  remoteSessionsDisconnectAll: '/api/v1/remote/sessions/disconnect-all',
  remoteWebrtcSignal: '/api/v1/remote/webrtc/signal',
  computers: '/api/v1/computers',
  computersLocalRegister: '/api/v1/computers/local/register',
  computersLocalPoll: '/api/v1/computers/local/poll',
  computersCommands: '/api/v1/computers/commands',
  tailnetStatus: '/api/v1/tailnet/status',

  // Official OAuth 2.1 Remote MCP
  wellKnownOAuthProtectedResource: '/.well-known/oauth-protected-resource',
  wellKnownOAuthProtectedResourceMcp: '/.well-known/oauth-protected-resource/mcp',
  wellKnownOAuthAuthServer: '/.well-known/oauth-authorization-server',
  wellKnownOpenIdConfig: '/.well-known/openid-configuration',
  oauthRegister: '/oauth/register',
  oauthAuthorize: '/oauth/authorize',
  oauthAuthorizeLogin: '/oauth/authorize/login',
  oauthAuthorizeQrPoll: '/oauth/authorize/qr-poll',
  oauthAuthorizeApprove: '/oauth/authorize/approve',
  oauthToken: '/oauth/token',
  oauthRevoke: '/oauth/revoke',
  mcpTools: '/api/v1/mcp/tools',
  mcpGrants: '/api/v1/mcp/grants',
  mcpAudit: '/api/v1/mcp/audit',
  officialMcp: '/mcp',

  // Built-in Browser, Script Distillation & Automation App Store (v1.6.11)
  browserBase: '/api/v1/browser',
  browserPairCreate: '/api/v1/browser/pair/create',
  browserPairClaim: '/api/v1/browser/pair/claim',
  browserCommand: '/api/v1/browser/command',
  browserScriptsDistill: '/api/v1/browser/scripts/distill',
  automationApps: '/api/v1/automation-apps',
  automationAppsInstalled: '/api/v1/automation-apps/installed',
} as const;

/**
 * Safely escapes a dynamic identifier for interpolation inside a double-quoted
 * CSS attribute selector `[data-foo="<escaped>"]`.
 */
export function escapeCssAttrValue(value: string | number): string {
  const str = String(value);
  if (str.length === 0) {
    throw new Error('CSS attribute selector value must not be empty.');
  }
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\0/g, '\uFFFD')
    .replace(/\r/g, '\\d ')
    .replace(/\n/g, '\\a ');
}

export function chatRowById(chatId: string | number): string {
  return `${DOM.chatRow}[data-chat-id="${escapeCssAttrValue(chatId)}"]`;
}

export function messageBubbleById(messageId: string | number): string {
  return `${DOM.messageBubble}[data-message-id="${escapeCssAttrValue(messageId)}"]`;
}

export function folderTabById(folderId: string | number): string {
  return `${DOM.chatFolderTabs} [data-folder-id="${escapeCssAttrValue(folderId)}"]`;
}

export function topicRowById(topicId: string | number): string {
  return `${DOM.forumTopicList} [data-topic-id="${escapeCssAttrValue(topicId)}"]`;
}

export function settingsSectionById(sectionId: string | number): string {
  return `${DOM.settingsPanel} [data-settings-section="${escapeCssAttrValue(sectionId)}"]`;
}

export function hermesTabById(tabId: string | number): string {
  return `${DOM.hermesStudioPanel} [data-hermes-tab="${escapeCssAttrValue(tabId)}"]`;
}

export function themeRootSelector(theme: ThemeName): string {
  return `:root[data-theme="${escapeCssAttrValue(theme)}"]`;
}
