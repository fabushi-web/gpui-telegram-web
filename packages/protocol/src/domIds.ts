/**
 * Canonical DOM element IDs, data-testid values, and data-* attributes
 * shared across `@gpui-telegram/protocol`, `@gpui-telegram/web`, and E2E suites.
 *
 * Stored WITHOUT leading `#` so React JSX uses `id={DOM_IDS.AUTH_SCREEN}`
 * and CSS/DOM selectors use `#${DOM_IDS.AUTH_SCREEN}` or `domSelector(DOM_IDS.AUTH_SCREEN)`.
 */
export const DOM_IDS = {
  // 1. Auth & Lock (24 IDs)
  AUTH_SCREEN: 'auth-screen',
  BTN_DEMO_LOGIN: 'btn-demo-login',
  TAB_AUTH_PHONE: 'tab-auth-phone',
  TAB_AUTH_QR: 'tab-auth-qr',
  TAB_AUTH_PASSWORD: 'tab-auth-password',
  TAB_AUTH_EMAIL: 'tab-auth-email',
  TAB_AUTH_ALIPAY: 'tab-auth-alipay',
  BTN_AUTH_PASSKEY: 'btn-auth-passkey',
  AUTH_COUNTRY_SELECT: 'auth-country-select',
  AUTH_PHONE_INPUT: 'auth-phone-input',
  BTN_AUTH_SEND_CODE: 'btn-auth-send-code',
  AUTH_CODE_INPUT: 'auth-code-input',
  AUTH_2FA_INPUT: 'auth-2fa-input',
  BTN_AUTH_SUBMIT_2FA: 'btn-auth-submit-2fa',
  QR_LOGIN_SVG: 'qr-login-svg',
  BTN_SIMULATE_QR_SCAN: 'btn-simulate-qr-scan',
  AUTH_USERNAME_INPUT: 'auth-username-input',
  AUTH_PASSWORD_INPUT: 'auth-password-input',
  BTN_AUTH_PASSWORD_SUBMIT: 'btn-auth-password-submit',
  AUTH_MODE_REGISTER_TOGGLE: 'auth-mode-register-toggle',
  AUTH_SERVER_URL_INPUT: 'auth-server-url-input',
  BTN_MTPROTO_CONFIG: 'btn-mtproto-config',
  PASSCODE_LOCK_SCREEN: 'passcode-lock-screen',
  PASSCODE_UNLOCK_INPUT: 'passcode-unlock-input',

  // 2. App Shell & Left Column (34 IDs)
  APP_SHELL: 'app-shell',
  CONNECTION_STATUS_BANNER: 'connection-status-banner',
  LEFT_COLUMN: 'left-column',
  BTN_COLLAPSE_SIDEBAR: 'btn-collapse-sidebar',
  BTN_MAIN_MENU: 'btn-main-menu',
  MAIN_MENU_DRAWER: 'main-menu-drawer',
  MENU_ACCOUNT_SWITCHER: 'menu-account-switcher',
  MENU_ITEM_SAVED_MESSAGES: 'menu-item-saved-messages',
  MENU_ITEM_ARCHIVED: 'menu-item-archived',
  MENU_ITEM_CONTACTS: 'menu-item-contacts',
  MENU_ITEM_NEW_GROUP: 'menu-item-new-group',
  MENU_ITEM_NEW_CHANNEL: 'menu-item-new-channel',
  MENU_ITEM_SETTINGS: 'menu-item-settings',
  MENU_TOGGLE_NIGHT_MODE: 'menu-toggle-night-mode',
  MENU_TOGGLE_LANGUAGE: 'menu-toggle-language',
  MENU_ITEM_WALLET: 'menu-item-wallet',
  MENU_ITEM_LOGOUT: 'menu-item-logout',
  GLOBAL_SEARCH_INPUT: 'global-search-input',
  SEARCH_TABS: 'search-tabs',
  STORIES_BAR: 'stories-bar',
  STORIES_VIEWER: 'stories-viewer',
  CHAT_FOLDER_TABS: 'chat-folder-tabs',
  ARCHIVED_CHATS_ROW: 'archived-chats-row',
  CHAT_LIST: 'chat-list',
  FORUM_TOPIC_LIST: 'forum-topic-list',
  BTN_NEW_CHAT_FAB: 'btn-new-chat-fab',
  NAV_RAIL: 'nav-rail',
  NAV_DEST_CHATS: 'nav-dest-chats',
  NAV_DEST_TASKS: 'nav-dest-tasks',
  NAV_DEST_MCP: 'nav-dest-mcp',
  NAV_DEST_TALK: 'nav-dest-talk',
  NAV_DEST_COMPUTER: 'nav-dest-computer',
  NAV_DEST_HERMES: 'nav-dest-hermes',
  NAV_DEST_SETTINGS: 'nav-dest-settings',

  // 3. Middle Column & Composer (26 IDs)
  MIDDLE_COLUMN: 'middle-column',
  BTN_BACK_TO_CHATS: 'btn-back-to-chats',
  CHAT_HEADER: 'chat-header',
  CHAT_HEADER_TITLE: 'chat-header-title',
  CHAT_HEADER_STATUS: 'chat-header-status',
  BTN_IN_CHAT_SEARCH: 'btn-in-chat-search',
  BTN_START_AUDIO_CALL: 'btn-start-audio-call',
  BTN_START_VIDEO_CALL: 'btn-start-video-call',
  BTN_TOGGLE_RIGHT_COLUMN: 'btn-toggle-right-column',
  BTN_CHAT_MORE: 'btn-chat-more',
  PINNED_MESSAGE_BANNER: 'pinned-message-banner',
  MESSAGE_LIST: 'message-list',
  BTN_SCROLL_TO_BOTTOM: 'btn-scroll-to-bottom',
  SELECTION_TOOLBAR: 'selection-toolbar',
  COMPOSER_REPLY_EDIT_BANNER: 'composer-reply-edit-banner',
  MESSAGE_COMPOSER_INPUT: 'message-composer-input',
  BTN_FORMATTING_TOOLBAR: 'btn-formatting-toolbar',
  BTN_EMOJI_PICKER: 'btn-emoji-picker',
  EMOJI_STICKER_GIF_POPOVER: 'emoji-sticker-gif-popover',
  BTN_ATTACH_MENU: 'btn-attach-menu',
  FILE_UPLOAD_INPUT: 'file-upload-input',
  BTN_AI_COMPOSE: 'btn-ai-compose',
  BTN_RECORD_VOICE: 'btn-record-voice',
  BTN_SEND_MESSAGE: 'btn-send-message',
  TOP_AUDIO_PLAYER_BAR: 'top-audio-player-bar',
  TOP_CALL_BAR: 'top-call-bar',

  // 4. Right Column, Settings & Modals (32 IDs)
  RIGHT_COLUMN: 'right-column',
  RIGHT_PROFILE_INFO: 'right-profile-info',
  RIGHT_TABS: 'right-tabs',
  RIGHT_TAB_MEMBERS: 'right-tab-members',
  RIGHT_TAB_MEDIA: 'right-tab-media',
  RIGHT_TAB_FILES: 'right-tab-files',
  RIGHT_TAB_LINKS: 'right-tab-links',
  RIGHT_TAB_VOICE: 'right-tab-voice',
  RIGHT_TAB_STATS: 'right-tab-stats',
  IN_CHAT_SEARCH_INPUT: 'in-chat-search-input',
  IN_CHAT_SEARCH_PREV: 'in-chat-search-prev',
  IN_CHAT_SEARCH_NEXT: 'in-chat-search-next',
  SETTINGS_PANEL: 'settings-panel',
  BTN_EXPORT_CHAT_JSON: 'btn-export-chat-json',
  BTN_EXPORT_CHAT_HTML: 'btn-export-chat-html',
  LIGHTBOX_VIEWER: 'lightbox-viewer',
  LIGHTBOX_ZOOM_IN: 'lightbox-zoom-in',
  LIGHTBOX_ROTATE: 'lightbox-rotate',
  LIGHTBOX_NEXT: 'lightbox-next',
  LIGHTBOX_PREV: 'lightbox-prev',
  LIGHTBOX_DOWNLOAD: 'lightbox-download',
  LIGHTBOX_CLOSE: 'lightbox-close',
  MODAL_MEDIA_EDITOR: 'modal-media-editor',
  INSTANT_VIEW_MODAL: 'instant-view-modal',
  MODAL_CREATE_GROUP: 'modal-create-group',
  MODAL_CREATE_CHANNEL: 'modal-create-channel',
  MODAL_CONTACTS: 'modal-contacts',
  MODAL_FORWARD: 'modal-forward',
  MODAL_CREATE_POLL: 'modal-create-poll',
  MODAL_CREATE_TODO: 'modal-create-todo',
  MODAL_SHORTCUTS: 'modal-shortcuts',
  CALL_OVERLAY: 'call-overlay',

  // 5. AI, MiniApps & Workspaces (11 IDs)
  MINIAPP_MODAL: 'miniapp-modal',
  MINIAPP_IFRAME: 'miniapp-iframe',
  HERMES_STUDIO_PANEL: 'hermes-studio-panel',
  MAGPIE_GATEWAY_PANEL: 'magpie-gateway-panel',
  TASK_CENTER_WORKSPACE: 'task-center-workspace',
  MCP_TOOLS_DOCK: 'mcp-tools-dock',
  TALK_MODE_ORB: 'talk-mode-orb',
  COMPUTER_WORKBENCH: 'computer-workbench',
  COMPUTER_CANVAS: 'computer-canvas',
  BTN_COMPUTER_TAKEOVER: 'btn-computer-takeover',
  WALLET_STARS_MODAL: 'wallet-stars-modal',

  // 6. Browser Control & Desktop Bridge (10 IDs)
  NAV_DEST_BROWSER: 'nav-dest-browser',
  BROWSER_CONTROL_WORKSPACE: 'browser-control-workspace',
  BTN_BROWSER_PAIR_DESKTOP: 'btn-browser-pair-desktop',
  BTN_BROWSER_REVOKE_CONTROL: 'btn-browser-revoke-control',
  BROWSER_PAIRING_CODE_DISPLAY: 'browser-pairing-code-display',
  BROWSER_HEADLESS_URL_INPUT: 'browser-headless-url-input',
  BTN_BROWSER_HEADLESS_OPEN: 'btn-browser-headless-open',
  BROWSER_HEADLESS_VIEWPORT: 'browser-headless-viewport',
  BROWSER_SNAPSHOT_VIEW: 'browser-snapshot-view',
  BROWSER_AUDIT_LOG: 'browser-audit-log',
} as const;

export type DomIdKey = keyof typeof DOM_IDS;
export type DomIdValue = (typeof DOM_IDS)[DomIdKey];

export const DATA_TEST_IDS = {
  CHAT_ROW: 'chat-row',
  MESSAGE_BUBBLE: 'message-bubble',
} as const;

export type DataTestIdValue = (typeof DATA_TEST_IDS)[keyof typeof DATA_TEST_IDS];

export const DATA_ATTRS = {
  FOLDER_ID: 'data-folder-id',
  CHAT_ID: 'data-chat-id',
  TOPIC_ID: 'data-topic-id',
  MESSAGE_ID: 'data-message-id',
  SETTINGS_SECTION: 'data-settings-section',
  HERMES_TAB: 'data-hermes-tab',
  BROWSER_REF: 'data-bctrl-ref',
} as const;

export type DataAttrName = (typeof DATA_ATTRS)[keyof typeof DATA_ATTRS];

export function domSelector(id: DomIdValue): `#${string}` {
  return `#${id}`;
}
