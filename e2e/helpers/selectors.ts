/**
 * Canonical DOM IDs, data-testid hooks, theme/tab registries, and safe CSS
 * attribute selector builders contracted in PROJECT.md § Interface Contracts
 * and TEST_INFRA.md § 2 & § 3.3.
 *
 * Strictly opaque-box: zero imports from application source packages.
 */

export const DOM = {
  // ---------------------------------------------------------------------------
  // 1. Auth & Lock (PROJECT.md L101, F1)
  // ---------------------------------------------------------------------------
  authScreen: '#auth-screen',
  btnDemoLogin: '#btn-demo-login',
  tabAuthPhone: '#tab-auth-phone',
  tabAuthQr: '#tab-auth-qr',
  /** Fallback selector covering both canonical #tab-auth-qr (L101) and F1 prose #btn-qr-login (L47). */
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
  btnSimulateQrScan: '#btn-simulate-qr-scan',
  authUsernameInput: '#auth-username-input',
  authPasswordInput: '#auth-password-input',
  btnAuthPasswordSubmit: '#btn-auth-password-submit',
  authModeRegisterToggle: '#auth-mode-register-toggle',
  authServerUrlInput: '#auth-server-url-input',
  btnMtprotoConfig: '#btn-mtproto-config',
  passcodeLockScreen: '#passcode-lock-screen',
  passcodeUnlockInput: '#passcode-unlock-input',

  // ---------------------------------------------------------------------------
  // 2. App Shell & Left Column (PROJECT.md L102, F1–F5, F16)
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
  archivedChatsRow: '#archived-chats-row',
  chatList: '#chat-list',
  chatRow: '[data-testid="chat-row"]',
  forumTopicList: '#forum-topic-list',
  forumTopicItem: '#forum-topic-list [data-topic-id]',
  btnNewChatFab: '#btn-new-chat-fab',
  navRail: '#nav-rail',
  navDestChats: '#nav-dest-chats',
  navDestTasks: '#nav-dest-tasks',
  navDestMcp: '#nav-dest-mcp',
  navDestTalk: '#nav-dest-talk',
  navDestComputer: '#nav-dest-computer',
  navDestHermes: '#nav-dest-hermes',
  navDestSettings: '#nav-dest-settings',

  // ---------------------------------------------------------------------------
  // 3. Middle Column & Composer (PROJECT.md L103, F2, F3, F5–F12, F14, F15)
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
  topAudioPlayerBar: '#top-audio-player-bar',
  topCallBar: '#top-call-bar',

  // ---------------------------------------------------------------------------
  // 4. Right Column, Settings & Modals (PROJECT.md L104, F5, F7, F9, F11, F13–F15)
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
  // 5. AI, MiniApps & Workspaces (PROJECT.md L105, F13, F16)
  // ---------------------------------------------------------------------------
  miniappModal: '#miniapp-modal',
  miniappIframe: '#miniapp-iframe',
  hermesStudioPanel: '#hermes-studio-panel',
  hermesTabItem: '#hermes-studio-panel [data-hermes-tab]',
  magpieGatewayPanel: '#magpie-gateway-panel',
  taskCenterWorkspace: '#task-center-workspace',
  mcpToolsDock: '#mcp-tools-dock',
  talkModeOrb: '#talk-mode-orb',
  computerWorkbench: '#computer-workbench',
  computerCanvas: '#computer-canvas',
  btnComputerTakeover: '#btn-computer-takeover',
  walletStarsModal: '#wallet-stars-modal',
} as const;

export type DOMKey = keyof typeof DOM;
export type DOMSelector = (typeof DOM)[DOMKey];

/** Canonical 4 Vanilla CSS themes on `:root[data-theme="..."]` (PROJECT.md L29). */
export const THEMES = ['night', 'tinted', 'day', 'classic'] as const;
export type ThemeName = (typeof THEMES)[number];

/** Canonical authentication mode tabs (PROJECT.md L101). */
export const AUTH_TABS = {
  phone: DOM.tabAuthPhone,
  qr: DOM.tabAuthQr,
  password: DOM.tabAuthPassword,
  email: DOM.tabAuthEmail,
  alipay: DOM.tabAuthAlipay,
} as const;
export type AuthTabKey = keyof typeof AUTH_TABS;

/** Canonical unified navigation rail destinations (PROJECT.md L102). */
export const NAV_DESTS = {
  chats: DOM.navDestChats,
  tasks: DOM.navDestTasks,
  mcp: DOM.navDestMcp,
  talk: DOM.navDestTalk,
  computer: DOM.navDestComputer,
  hermes: DOM.navDestHermes,
  settings: DOM.navDestSettings,
} as const;
export type NavDestKey = keyof typeof NAV_DESTS;

/** Canonical right-column context inspector tabs (PROJECT.md L104). */
export const RIGHT_TABS = {
  members: DOM.rightTabMembers,
  media: DOM.rightTabMedia,
  files: DOM.rightTabFiles,
  links: DOM.rightTabLinks,
  voice: DOM.rightTabVoice,
  stats: DOM.rightTabStats,
} as const;
export type RightTabKey = keyof typeof RIGHT_TABS;

/** Runtime CSS custom properties contracted in PROJECT.md L32 & TEST_INFRA.md L28. */
export const CSS_VARS = {
  fontSize: '--tg-font-size',
  bubbleRadius: '--tg-bubble-radius',
  uiScale: '--tg-ui-scale',
} as const;

/** Canonical data-* attribute names contracted in PROJECT.md L29, L102–105. */
export const DATA_ATTRS = {
  theme: 'data-theme',
  testId: 'data-testid',
  chatId: 'data-chat-id',
  messageId: 'data-message-id',
  folderId: 'data-folder-id',
  topicId: 'data-topic-id',
  settingsSection: 'data-settings-section',
  hermesTab: 'data-hermes-tab',
} as const;

/** 4-tier responsive viewport presets contracted in PROJECT.md L34–37 & TEST_INFRA.md L28. */
export const VIEWPORTS = {
  desktop3Col: { width: 1440, height: 900 },
  desktop2Col: { width: 1100, height: 800 },
  tabletDrawer: { width: 768, height: 900 },
  mobileStack: { width: 390, height: 844 },
} as const;

/** Multi-tab BroadcastChannel name contracted in PROJECT.md L26 & TEST_INFRA.md L29. */
export const BROADCAST_CHANNEL_NAME = 'gpui-telegram-web-sync' as const;

/** Canonical backend HTTP/WS/SDK endpoints contracted in PROJECT.md L14–20, L92–93. */
export const API_PATHS = {
  health: '/api/v1/health',
  testReset: '/api/v1/test/reset',
  ws: '/api/v1/ws',
  syncGetDifference: '/api/v1/sync/get_difference',
  telegramWebAppSdk: '/js/telegram-web-app.js',
} as const;

/**
 * Safely escapes a dynamic identifier for interpolation inside a double-quoted
 * CSS attribute selector `[data-foo="<escaped>"]`.
 * Throws immediately if given an empty string to prevent vacuous/silent mismatches.
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
