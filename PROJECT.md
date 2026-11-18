# Project: gpui-telegram-web

## Overview
Full-featured web version of [`bhrum/gpui-telegram`](https://github.com/bhrum/gpui-telegram) (`v1.2.0`) built with a modern hexagonal full-stack TypeScript web architecture, delivering **100% visual, responsive, and interactive parity with Telegram Web (Web A / Web K)** plus **100% feature parity with `bhrum/gpui-telegram`** (including all 7 authentication flows, real-time WebSocket `/api/v1/ws` + monotonic per-chat `pts` sync, CJK full-text search, resumable CAS HTTP 206 media streaming, 100-bar 5-bit scrubbable voice waveforms with headless Web Audio fallback, 3-state CJK IME composer fencing, WebRTC audio/video/screen-share calls, WebCrypto E2EE secret chats, `@BotFather` + `/js/telegram-web-app.js` Mini Apps featuring the compiled `.wasm` + HTML5 Canvas **全球法布施 3D Globe & Zen Room**, **Hermes 6-Tab AI Agent Studio**, **Magpie LLM Gateway**, **Global Task Center & Cron**, **MCP Tools Dock**, **Full-Duplex Talk Mode**, **Remote Computer Control Workbench**, and **Stars/TON Wallet**), followed by public GitHub repository creation and code push.

---

## Architecture

### 1. Monorepo & Hexagonal Full-Stack Topology
- **Repository Root**: `/home/antigravity/gpui-telegram-web` (npm workspaces monorepo on Node.js `v24.22.2` + TypeScript `5.x` strict mode).
- **Three Clean Layers**:
  1. **`packages/protocol` (`@gpui-telegram/protocol`)**: Pure TypeScript shared domain models, wire DTOs, UTF-16 `MessageEntity` & Markdown parser/serializer, 3-state CJK `ImeSafetyFsm` (`Idle` -> `Composing` -> `Committed`), 100-bar 5-bit voice waveform codec, WebCrypto E2EE envelope helpers (`ECDH P-256 + HKDF + AES-256-GCM`), 22-variant `UpdateEvent` & `PtsUpdate` sync contracts, `WsClientFrame` / `WsServerFrame` discriminated unions, canonical DOM `id` / `data-testid` registry, and the hexagonal **`TelegramClientPort`** interface.
  2. **`apps/server` (`@gpui-telegram/server`)**: Production Node 24 HTTP/REST (`/api/v1/*`) + WebSocket (`/api/v1/ws`) + SSE + SQLite WAL (`node:sqlite` built-in) backend mirroring `gpui_telegram_server`:
     - Atomic per-chat monotonic `pts` sequence engine + `/api/v1/sync/get_difference` gap recovery + `client_nonce` outbox deduplication.
     - 7 authentication flows + multi-device session management + salted `scrypt` password/2FA hashing.
     - CJK-aware full-text search across chats, contacts, apps, and messages with highlighted snippets & media-type filters.
     - Content-addressable SHA-256 chunked media upload + HTTP `206 Partial Content` byte-range streaming.
     - Built-in interactive `@BotFather` (`777001`), `/js/telegram-web-app.js` SDK & Mini App host (`/miniapps/*`), Hermes Agent streaming SSE runtime (29 `/slash` commands + 6-tab Studio state), Magpie LLM Gateway (live OpenAI/Anthropic/Gemini SSE proxy when API key supplied + deterministic zero-subscription smart local provider + PII privacy masking + usage ledger), Global Task Center & 5-field Cron, MCP Tools registry & approval dock, Remote Computer Workbench stream/takeover, Tailnet status, WebRTC signaling hub, and Stars/TON Wallet.
     - Co-hosts compiled `apps/web/dist` static SPA with `index.html` fallback in production (`npm start`) and exposes CORS + healthcheck (`GET /api/v1/health`) for dev/multi-origin deployment.
  3. **`apps/web` (`@gpui-telegram/web`)**: Vite + React 19 + Zustand (atomic selector slices) + `@tanstack/react-virtual` + **100% Vanilla CSS** (`tokens.css`, `reset.css`, `layout.css`, modular CSS — **strictly zero TailwindCSS** and **zero purple-on-dark** per `web-app-development` skill):
     - Connects through `TelegramClientPort` with **3 runtime modes**:
       - **`server` mode (default when backend reachable)**: Full-stack REST `/api/v1/*` + WebSocket `/api/v1/ws` + IndexedDB local cache + offline outbox queue + editable Server URL bar (supports local `/api/v1` or remote `gpui_telegram_server` URL).
       - **`sandbox` standalone browser mode**: Full-fidelity IndexedDB + `BroadcastChannel` engine so the static web build works 100% offline/serverless as well.
       - **`mtproto` public Telegram mode**: Browser MTProto credential workflow (`api_id` + `api_hash` stored locally in IndexedDB) for direct Telegram DC WebSocket sessions alongside self-hosted/sandbox accounts.
     - Multi-tab live synchronization via `BroadcastChannel('gpui-telegram-web-sync')` + PWA `manifest.webmanifest` & Service Worker shell.

### 2. Design System & Responsive Geometry
- **4 Curated Themes (`:root[data-theme="night|tinted|day|classic"]`)**:
  - `night` (Default Dark — **Telegram Blue `#3390EC` / `#1084FE`**, outgoing bubble `#2B5278`, incoming `#182533`, surface `#17212B` / `#0E1621` — strictly NO purple/violet accents on dark backgrounds).
  - `tinted` (Graphite Ocean Slate `#0E1013` / `#1687FF`), `day` (Clean Light `#FFFFFF` / `#DEF1FD`), `classic` (Telegram Classic Green `#EFFDDE` / `#D5E8C8..#B8D8A3`).
  - 8 custom accent swatches, 7 vector/gradient wallpaper presets + custom image upload + frosted blur, runtime `--tg-font-size` (`12px..20px`), `--tg-bubble-radius` (`6px..18px`), `--tg-ui-scale` (`50%..200%`), and 7 deterministic peer avatar gradients (`Math.abs(peerNumericId) % 7`).
- **4-Tier Responsive Breakpoints**:
  - `>= 1276px`: 3-Column Docked (`LeftColumn` resizable `[260px..424px]` or collapsed `64px` rail + `MiddleColumn 1fr` + `RightColumn 360px`).
  - `926px – 1275px`: 2-Column Docked (`LeftColumn` + `MiddleColumn`) + floating slide-over `RightColumn`.
  - `601px – 925px`: Full-width `MiddleColumn` + slide-over `LeftColumn` & `RightColumn` drawers.
  - `<= 600px`: Mobile `100vw x 100dvh` slide-stack (`LeftColumn` -> `MiddleColumn` with header `#btn-back-to-chats` -> `RightColumn`).

---

## Feature Inventory

Every feature discovered across Step 0 Survey (`bhrum/gpui-telegram` + Telegram Web A/K) is mapped below; none is unassigned.

| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F1 | **Multi-Flow Auth, Adapter Switcher, Multi-Account & Passcode Lock** | 1-Click Instant Sandbox/Demo login (`#btn-demo-login`), Phone + searchable Country Code + OTP (`#auth-phone-input`, `#auth-code-input`), Cloud 2FA Password (`#auth-2fa-input` + setup/disable), Real SVG QR Pairing (`#btn-qr-login` + live `/api/v1/auth/pair/*` + `#btn-simulate-qr-scan`), Username/Password Login & Register, Email OTP, Alipay QR, WebAuthn Passkeys (`navigator.credentials` + headless fallback), Editable Server URL (`#auth-server-url-input`) + MTProto (`api_id`/`api_hash`) mode, Multi-Account Switcher (up to 6 accounts), Active Sessions revocation, and Local Passcode Lock (`Ctrl/Cmd+Shift+L`, `#passcode-lock-screen`). | M1, M2, M6 | survey_1, survey_2 |
| F2 | **Responsive 4-Breakpoint 3-Column Shell, 4 Vanilla CSS Themes & Bilingual i18n** | 4-tier responsive Telegram Web layout (`>=1276px` 3-col, `926-1275px` 2-col, `601-925px` tablet drawers, `<=600px` mobile stack), resizable Left Sidebar + `64px` collapsed rail (`Ctrl/Cmd+B`), Unified Navigation destinations, Burger Menu drawer (`#btn-main-menu`), 4 Vanilla CSS themes (`night` Blue, `tinted`, `day`, `classic`, `Ctrl/Cmd+D`), 8 accents, 7 wallpapers + blur, font/radius/scale sliders, and live `zh-CN` / `en-US` i18n (`Ctrl/Cmd+L`). | M1, M2, M4, M6 | survey_1, survey_2 |
| F3 | **Real-Time WebSocket (`/api/v1/ws`), Monotonic PTS Sync, Offline Outbox & Multi-Tab Sync** | Authenticated WebSocket with 25s ping/pong, jittered exponential backoff (`0.5s..30s`), `#connection-status-banner`, per-chat SQLite WAL `pts` sequence sync & `/api/v1/sync/get_difference` gap recovery, IndexedDB local cache + `client_nonce` idempotent offline outbox (`🕒 -> ✓ -> ✓✓`), live typing/recording indicators, and `BroadcastChannel` multi-tab live sync. | M1, M2, M6 | survey_1, survey_2 |
| F4 | **Virtualized Chat List, Chat Folders, Archive, Stories & Forum Topics** | `@tanstack/react-virtual` dialog rows (`#chat-list`: 7-color gradient avatars, online dot, typing preview, red `Draft:`, media badge, `🕒/✓/✓✓`, `@` mention & `❤️` reaction badges, mute/pin icons, unread pills, right-click menu: Pin, Mute, Mark Read/Unread, Archive, Folder, Clear, Delete/Leave), `ChatFolderTabs` (`All`, `Personal`, `Work`, `Bots`, `Unread` + custom CRUD folders) & optional vertical Folder Rail, collapsible `Archived Chats`, `Stories` ring strip + fullscreen `StoriesViewer` & Post Story, `Saved Messages` (`Ctrl/Cmd+0`), and Supergroup **Forum Topics** sub-panel. | M1, M2, M6 | survey_1, survey_2 |
| F5 | **Global CJK Full-Text Search & In-Chat Search with Date Jump** | Debounced Global Search (`#global-search-input`, `Ctrl/Cmd+K` or `/`) with CJK snippet highlighting across `Chats`, `Messages`, `Apps`, `Media`, `Links`, `Files`, `Music`, `Voice` + date filter; In-Chat Search (`#in-chat-search-input`, `Ctrl/Cmd+F`) with sender filter, Jump-to-Date calendar, match counter (`M of N`), and Prev/Next jumper highlighting target message bubble. | M1, M2, M4, M6 | survey_1, survey_2 |
| F6 | **Virtualized Date-Grouped Tail-Bubble Timeline, Pinned Banner & Read Receipts** | Anchor-stabilized virtualized message list (`#message-list`) with `48px` bottom stickiness, exact per-chat scroll preservation & `AbortController` `chatId` fencing on rapid switches, sticky Date Group Pills, `<=900s` sender-grouped bubbles (`[160px..480px]`) with `6x10px` SVG corner tails, `IntersectionObserver` read-receipt dispatch, channel views (`👁`), `"edited"` label, service pills, unread divider, multi-pin `#pinned-message-banner` carousel, and Scroll-to-Bottom / Mentions / Reactions FABs. | M1, M3, M6 | survey_1, survey_2 |
| F7 | **Rich Text Entities, Code Blocks, Spoilers, Link Previews & Instant View** | XSS-safe UTF-16 `MessageEntity` & Markdown parser/renderer: **bold**, *italic*, __underline__, ~~strikethrough~~, `inline code`, fenced ` ```lang ` code blocks with `Copy Code`, click-to-reveal `||spoilers||`, collapsible `> blockquotes`, clickable `@mentions`, `#hashtags`, timestamps, URLs, OpenGraph WebPage Link Previews, and **Instant View** reader modal (`#instant-view-modal`). | M1, M3, M6 | survey_1, survey_2 |
| F8 | **Canonical Composer, 3-State CJK IME Safety FSM, Formatting, Stickers/GIFs & Drafts** | Auto-expanding `[44px..192px]` composer (`#message-composer-input`) with **3-state CJK IME Safety FSM (`Idle -> Composing -> Committed`)** so `Enter` during IME composition never misfires send while `Shift+Enter` inserts newline, per-chat cloud/local draft sync, Formatting Toolbar (`Ctrl/Cmd+B/I/U/Shift+X/Shift+M/Shift+P/K`), 3-tab `Emoji / Stickers / GIFs` picker (`#btn-emoji-picker`), `/slash` & `@mention` autocomplete, Send-As selector, Silent/Scheduled send options, and ✨ **AI Compose Assistant** (`#btn-ai-compose`: tone/grammar/EN<->ZH translate). | M1, M3, M6 | survey_1, survey_2 |
| F9 | **Message Operations: Reply, Quote-Reply, Edit, Forward, Pin, Delete & Multi-Select** | Context menu & shortcuts for Reply, selected-text **Partial Quote Reply**, Edit (`ArrowUp` on empty composer edits last own message), Forward modal (`#modal-forward` with chat search, Saved Messages, hide sender, comment), Pin/Unpin, Delete (`for me` vs `for everyone` tombstone), Copy Text/Link, Translate bar, and **Multi-Message Selection Toolbar** (`#selection-toolbar`). | M1, M3, M4, M6 | survey_1, survey_2 |
| F10 | **Out-of-Flow Hover Quick Reactions, 32-Emoji Picker & Reactor List** | Zero-jitter floating hover reaction button -> 7-emoji quick strip -> 8x4 32-emoji extended picker, animated reaction counter pills on bubbles (`is_chosen_by_me` active state + reactor avatars), and Reactor List popover. | M1, M3, M6 | survey_1, survey_2 |
| F11 | **Resumable CAS Media Upload, Mosaic Albums, Spoilers, Files, Media Editor & Lightbox** | Drag-and-drop, `#btn-attach-menu`, and `Ctrl+V` paste; SHA-256 chunked CAS upload + HTTP 206 Range streaming; **Canvas Media Editor** (`#modal-media-editor`: crop, rotate, draw brush, spoiler toggle, caption); 2–10 item proportional **Mosaic Media Albums**; Stickers & GIFs; Document/File cards with extension badge & real Blob download; `BlobUrlRegistry` cleanup; and **Fullscreen Media Lightbox Viewer** (`#lightbox-viewer`: `1x..4x` zoom, pan, 90° rotate, filmstrip, download, forward, delete). | M1, M3, M6 | survey_1, survey_2 |
| F12 | **100-Bar 5-Bit Voice Notes, Round Video, Persistent Audio Bar & Headless Synth Fallback** | Voice & Round Video Recorder (`#btn-record-voice`) via `MediaRecorder` + Web Audio waveform extractor WITH automatic **Headless Web Audio PCM `.wav` synthesizer fallback** when `getUserMedia` is unavailable in Playwright; 100-bar 5-bit scrubbable Voice Player (`1x/1.5x/2x` rate + `->A` Voice-to-Text transcription), `240px` circular Round Video player, and persistent `#top-audio-player-bar`. | M1, M3, M6 | survey_1, survey_2 |
| F13 | **Interactive Polls, Quiz Mode, Collaborative Todo Checklists & Invoices** | Create Poll / Quiz modal (`#modal-create-poll`: anonymous/visible voters, multi-choice, Quiz correct answer + explanation), live vote percentage bars, Retract Vote / Close Poll, Poll Results drawer, interactive **Todo Checklists** (`#modal-create-todo`), and **Stars / TON / Stripe Invoice & Gift Cards** with checkout receipt. | M1, M3, M4, M6 | survey_1, survey_2 |
| F14 | **Right Context Inspector, Contacts/Groups/Channels Admin, Stats & 25-Page Settings + Export** | Collapsible `#right-column` (`Ctrl/Cmd+I`) scoped strictly to active `chatId` (`Profile`, `Members` admin/promote/ban/add, `Media`, `Files`, `Links`, `Voice`, `GIFs`, `SVG`/`Canvas` **Channel Statistics & Boosts**); `New Group` (`#modal-create-group`), `New Channel` (`#modal-create-channel`), `Contacts & Add Contact` (`#modal-contacts`), Invite Links; full **25-Page Left Slide-Stack Settings Router** (`#settings-panel`) + **JSON & Styled HTML Chat Export** + **Keyboard Shortcuts Modal** (`#modal-shortcuts`) + 7-layer `Escape` stack. | M1, M4, M6 | survey_1, survey_2 |
| F15 | **WebRTC 1-on-1 & Group Audio/Video Calls, Screen Share & WebCrypto E2EE Secret Chats** | Interactive `#call-overlay` (`RTCPeerConnection` + `/api/v1/ws` `CallSignal` + peer responder + headless Canvas/WebAudio stream fallback, 4-emoji E2EE fingerprint, mic/cam/screen-share toggles, group call grid, minimize to `#top-call-bar`, post-call rating); plus **Secret Chats** (`ECDH + HKDF + AES-256-GCM` E2EE envelopes, key fingerprint, and per-chat self-destruct TTL countdown). | M1, M4, M6 | survey_1, survey_2 |
| F16 | **`@BotFather`, `window.Telegram.WebApp` Mini Apps, 全球法布施 WASM+3D Globe, Hermes 6-Tab AI Studio, Magpie LLM Gateway & Cloud Computer/Task/MCP/Talk Workspaces** | Interactive `@BotFather` (`/start`, `/newbot`, `/mybots`, `/newapp`) & Mini App Catalog; sandboxed `<iframe src="/miniapps/...">` host injecting `/js/telegram-web-app.js` (`initData` HMAC, `themeParams`, `MainButton`, `BackButton`, `CloudStorage`, `sendData`, `close`); flagship **全球法布施 (`fabushi-globe`) Real `.wasm` + HTML5 Canvas 3D Globe & Zen Room Mini App** (compiled `.wasm` spherical projection/light-beam kernel, country markers, Dharma beams, Sutras, Wooden-Fish `木鱼` & Incense Zen room, Achievements, VIP, Leaderboard) + `TaskBoard` Mini App; **Hermes AI Runtime** (SSE `ThinkingBubble`, 29 `/slash` commands, **6-Tab Studio**: Sessions/Providers, Memory/Soul, Skills Hub, Toolsets/Terminal, Cron/Heartbeat, Kanban/Approvals); **Magpie LLM Gateway** (OpenAI/Anthropic/Gemini routing, zero-subscription presets, PII privacy masking, usage ledger); **Global Task Center (7-state FSM + Cron)**, **MCP Tools Permission Dock**, **Full-Duplex `TalkModeOrb`**, **Remote Computer Workbench** (`<canvas>` viewport + approval banner + `<10ms` `Esc` takeover + Tailnet status), and **Stars/TON Wallet**. | M1, M5, M6 | survey_1, survey_2 |

---

## Milestones

| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | **Foundation, Shared Protocol, Design Tokens & Full-Stack Server Engine** | Scaffold `/home/antigravity/gpui-telegram-web` monorepo, `@gpui-telegram/protocol` (models, entities, IME FSM, 5-bit waveform codec, E2EE crypto helpers, WS/PTS schemas, `TelegramClientPort`, DOM ID constants), `@gpui-telegram/server` (SQLite WAL, 7 auth flows, `/api/v1/ws` PTS hub, CJK search, HTTP 206 CAS media, rich pre-seeded universe, `@BotFather`/MiniApps/Hermes SSE/Magpie/Tasks/MCP/Computers/Wallet APIs, static SPA host), and `@gpui-telegram/web` foundation (Vanilla CSS `tokens.css`/`layout.css`, client adapters, Zustand stores, i18n). | none | IN_PROGRESS (`ed036094fbecafa15264ba1b9ed5c589`) |
| M2 | **Auth Suite (7 Flows + Passcode), Responsive Shell, Left Sidebar, Folders, Stories, Forum Topics & Global Search** | Implement complete `auth/*` UI (Demo 1-click, Phone+OTP+2FA, SVG QR Pairing, Password, Email OTP, Alipay QR, WebAuthn Passkeys, Server URL / MTProto mode, Multi-Account, Passcode Lock), 4-breakpoint `MainShell`, `BurgerMenu`, Unified Nav Rail, `GlobalSearch`, `StoriesBar` & `StoriesViewer`, `ChatFolderTabs`, `ArchivedChats`, virtualized `ChatList` with context menus, and `ForumTopicList`. | M1 | PLANNED |
| M3 | **Middle Conversation Stage, Tail-Bubble Timeline, 12 Rich Card/Media Renderers, Lightbox & IME-Safe Composer** | Implement `ChatHeader`, `PinnedBanner`, virtualized `MessageList` (date pills, `<=900s` tail bubbles, read receipts, scroll persistence), XSS-safe Entities/Markdown/Code/Spoiler/WebPage/`InstantViewModal`, Mosaic Albums, Stickers/GIFs, 100-bar 5-bit Voice Player (`1x/1.5x/2x` + transcribe + `#top-audio-player-bar`), Round Video, File cards, Polls/Quizzes/Todos/Invoices, Hover Quick & 32-Emoji Reactions, Reply/Quote/Edit/Forward/Pin/Delete/`SelectionToolbar`, `CanonicalComposer` (3-state CJK IME FSM, drafts, toolbar, `MediaEditorModal`, Voice Recorder with headless WAV fallback, AI Compose), and `LightboxViewer`. | M1 | PLANNED |
| M4 | **Right Context Inspector, 25-Page Settings Slide-Stack, Social/Creation Modals, WebRTC Calls & Secret Chats E2EE** | Implement `RightColumn` (`Profile`, `Members` admin CRUD, `Media`/`Files`/`Links`/`Voice`/`GIFs`, `SVG`/`Canvas` Channel Statistics, `InChatSearch`), full 25-page `SettingsStack` (Profile, Appearance, Folders, Privacy/2FA/Passkeys/Passcode/TTL, Notifications, Storage & JSON/HTML Chat Export, Language, Wallet, Shortcuts), `NewGroup`/`NewChannel`/`Contacts`/`Forward`/`CreatePoll`/`CreateTodo`/`Invoice`/`Confirm` modals, `CallOverlay` (`RTCPeerConnection` + signaling + headless media fallback + screen share), and WebCrypto `SecretChat` E2EE flow. | M1 | PLANNED |
| M5 | **`@BotFather`, `Telegram.WebApp` Mini Apps, 全球法布施 WASM+3D Globe, Hermes 6-Tab Studio, Magpie Gateway & AI/Computer Workspaces** | Implement `@BotFather` wizard & Mini App Catalog, `/js/telegram-web-app.js` SDK & `MiniAppModal` iframe host (`initData` HMAC, `CloudStorage`, `MainButton`, theme sync), compiled `.wasm` + HTML5 Canvas **全球法布施 (`fabushi-globe`) 3D Globe & Zen Room Mini App** + `TaskBoard` Mini App, **Hermes 6-Tab Studio** & SSE `ThinkingBubble` + 29 `/slash` commands, **Magpie LLM Gateway** panel (routing, presets, PII masking, usage ledger), **Global Task Center & Cron**, **MCP Tools Dock**, **`TalkModeOrb`**, and **Remote Computer Workbench** (`Esc` emergency takeover + Tailnet). | M1 | PLANNED |
| M6 | **Full-Stack Integration, Unified Shell Wiring, Multi-Tab Sync, PWA & UX/Accessibility Polish** | Integrate M2 + M3 + M4 + M5 cleanly into `App.tsx`, verify 7-level `Escape` key stack, global keyboard shortcuts, `BroadcastChannel` multi-tab sync, PWA manifest & service worker, zero placeholder/stub UI, production build serving (`npm run build && npm start` on `127.0.0.1`), and full documentation (`README.md`). | M2, M3, M4, M5 | PLANNED |
| M7 | **Final Milestone: E2E Test Pass (Tiers 1–4), Tier 5 Adversarial Coverage Hardening & GitHub Repo Creation + Push** | Phase 1: Pass 100% of E2E Testing Track (`TEST_READY.md` Tiers 1–4) sequentially; Phase 2: Tier 5 white-box adversarial coverage hardening (Challenger → Worker → Reviewer + Forensic Auditor loop until zero gaps); Final Delivery: initialize clean git repo, create public GitHub repo `fabushi-web/gpui-telegram-web`, push code, and verify remote. | M6, TEST_READY.md | PLANNED |

*(Parallel E2E Testing Track is `IN_PROGRESS` under `teamwork_preview_sub_orch_e2e` (`ad1aa9519d6273d06ba8a12da3e17b12`), authoring `TEST_INFRA.md`, `/home/antigravity/gpui-telegram-web/e2e/`, and `/home/antigravity/TEST_READY.md`.)*

---

## Interface Contracts

### 1. Canonical Entry Points, Ports & Environment Variables (For Both Implementation & E2E Tracks)
- **Repository Root**: `/home/antigravity/gpui-telegram-web`
- **Production Build Command**: `npm --prefix /home/antigravity/gpui-telegram-web run build` (compiles `packages/protocol`, `apps/server`, and `apps/web/dist` including `/miniapps/*` and `/js/telegram-web-app.js`).
- **Unified Full-Stack Server Start Command**:
  ```bash
  PORT=4173 HOST=127.0.0.1 DATA_DIR=/path/to/isolated-data npm --prefix /home/antigravity/gpui-telegram-web start
  ```
  - **CRITICAL PROXY RULE**: Always bind and connect via `http://127.0.0.1:<PORT>` or `http://localhost:<PORT>` (NEVER `0.0.0.0` in client/Playwright URLs because VM `HTTP_PROXY` only exempts `NO_PROXY=localhost,127.0.0.1,::1,[::1]`).
  - `DATA_DIR`: Configurable directory for SQLite WAL database & uploaded media blobs so every E2E test suite or worker can start with a clean, deterministic, pre-seeded state without cross-test pollution (and `POST /api/v1/test/reset` when `ENABLE_TEST_RESET=1` resets server DB + re-seeds instantaneously in `<50ms`!).
  - **Healthcheck**: `GET http://127.0.0.1:<PORT>/api/v1/health` returns `200 OK` JSON `{"ok": true, "version": "1.2.0"}`.
- **Headless Browser Configuration (Playwright)**:
  - `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`
  - `executablePath: '/usr/lib/chromium/chromium'` with `args: ['--no-sandbox', '--disable-setuid-sandbox']`
  - Cap worker concurrency (`workers: 2` max; `1` during parallel verification waves) on this 2-vCPU, 0-swap VM.

### 2. Canonical DOM `id` & `data-testid` Contract (`packages/protocol` <-> `apps/web` <-> `e2e/`)
All interactive UI controls MUST expose semantic HTML5 roles/labels AND these deterministic `id` / `data-testid` hooks:
- **Auth & Lock**: `#auth-screen`, `#btn-demo-login`, `#tab-auth-phone`, `#tab-auth-qr`, `#tab-auth-password`, `#tab-auth-email`, `#tab-auth-alipay`, `#btn-auth-passkey`, `#auth-country-select`, `#auth-phone-input`, `#btn-auth-send-code`, `#auth-code-input`, `#auth-2fa-input`, `#btn-auth-submit-2fa`, `#qr-login-svg`, `#btn-simulate-qr-scan`, `#auth-username-input`, `#auth-password-input`, `#btn-auth-password-submit`, `#auth-mode-register-toggle`, `#auth-server-url-input`, `#btn-mtproto-config`, `#passcode-lock-screen`, `#passcode-unlock-input`.
- **App Shell & Left Column**: `#app-shell`, `#connection-status-banner`, `#left-column`, `#btn-collapse-sidebar`, `#btn-main-menu`, `#main-menu-drawer`, `#menu-account-switcher`, `#menu-item-saved-messages`, `#menu-item-archived`, `#menu-item-contacts`, `#menu-item-new-group`, `#menu-item-new-channel`, `#menu-item-settings`, `#menu-toggle-night-mode`, `#menu-toggle-language`, `#menu-item-wallet`, `#menu-item-logout`, `#global-search-input`, `#search-tabs`, `#stories-bar`, `#stories-viewer`, `#chat-folder-tabs` (`[data-folder-id="..."]`), `#archived-chats-row`, `#chat-list` (`[data-testid="chat-row"]` + `data-chat-id="..."`), `#forum-topic-list` (`[data-topic-id="..."]`), `#btn-new-chat-fab`, `#nav-rail` (`#nav-dest-chats`, `#nav-dest-tasks`, `#nav-dest-mcp`, `#nav-dest-talk`, `#nav-dest-computer`, `#nav-dest-hermes`, `#nav-dest-settings`).
- **Middle Column & Composer**: `#middle-column`, `#btn-back-to-chats` (mobile/tablet), `#chat-header`, `#chat-header-title`, `#chat-header-status`, `#btn-in-chat-search`, `#btn-start-audio-call`, `#btn-start-video-call`, `#btn-toggle-right-column`, `#btn-chat-more`, `#pinned-message-banner`, `#message-list` (`[data-testid="message-bubble"]` + `data-message-id="..."`), `#btn-scroll-to-bottom`, `#selection-toolbar`, `#composer-reply-edit-banner`, `#message-composer-input`, `#btn-formatting-toolbar`, `#btn-emoji-picker`, `#emoji-sticker-gif-popover`, `#btn-attach-menu`, `#file-upload-input`, `#btn-ai-compose`, `#btn-record-voice`, `#btn-send-message`, `#top-audio-player-bar`, `#top-call-bar`.
- **Right Column, Settings & Modals**: `#right-column`, `#right-profile-info`, `#right-tabs` (`#right-tab-members`, `#right-tab-media`, `#right-tab-files`, `#right-tab-links`, `#right-tab-voice`, `#right-tab-stats`), `#in-chat-search-input`, `#in-chat-search-prev`, `#in-chat-search-next`, `#settings-panel` (`[data-settings-section="..."]`, `#btn-export-chat-json`, `#btn-export-chat-html`), `#lightbox-viewer` (`#lightbox-zoom-in`, `#lightbox-rotate`, `#lightbox-next`, `#lightbox-prev`, `#lightbox-download`, `#lightbox-close`), `#modal-media-editor`, `#instant-view-modal`, `#modal-create-group`, `#modal-create-channel`, `#modal-contacts`, `#modal-forward`, `#modal-create-poll`, `#modal-create-todo`, `#modal-shortcuts`, `#call-overlay`.
- **AI, MiniApps & Workspaces**: `#miniapp-modal` (`#miniapp-iframe`), `#hermes-studio-panel` (`[data-hermes-tab="..."]`), `#magpie-gateway-panel`, `#task-center-workspace`, `#mcp-tools-dock`, `#talk-mode-orb`, `#computer-workbench` (`#computer-canvas`, `#btn-computer-takeover`), `#wallet-stars-modal`.

### 3. `packages/protocol` ↔ `apps/server` ↔ `apps/web` Store Contract
- `packages/protocol` exports all shared types (`UserProfile`, `PeerEntity`, `ChatSummary`, `ForumTopic`, `ChatFolder`, `StoryGroup`, `MessageItem`, `MessageEntity`, `ReactionCount`, `PollData`, `TodoListCard`, `InvoiceCard`, `WsClientFrame`, `WsServerFrame`, `UpdateEvent`, `PtsUpdate`, `TelegramClientPort`, `ImeSafetyFsm`, `encodeWaveform5Bit`/`decodeWaveform5Bit`, `DOM_IDS`).
- `apps/web/src/store/` exposes normalized Zustand stores initialized in M1:
  - `useAuthStore`: `authState`, `accounts`, `activeAccountId`, `adapterMode`, `serverUrl`, `isLocked`, actions (`loginDemo`, `sendPhoneCode`, `verifyPhoneCode`, `verify2fa`, `startQrPairing`, `simulateQrAccept`, `loginPassword`, `registerPassword`, `loginEmail`, `loginAlipay`, `loginPasskey`, `switchAccount`, `logout`, `setPasscode`, `lockApp`, `unlockApp`).
  - `useChatStore`: `peers`, `chats`, `folders`, `activeFolderId`, `activeChatId`, `activeTopicId`, `messagesByChat`, `draftsByChat`, `typingByChat`, `selectedMessageIds`, `replyOrEditTarget`, `searchState`, `stories`, and full CRUD/message/reaction/poll/todo/media/call/secret-chat actions delegated through active `TelegramClientPort`.
  - `useUiStore`: `leftSidebarWidth`, `isLeftCollapsed`, `isRightOpen`, `rightTab`, `mobilePane` (`'left'|'middle'|'right'`), `activeNavDest`, `isBurgerOpen`, `settingsStack`, `activeModal`, `lightboxState`, `audioPlayerState`, `activeCall`, `escapeStack` (`pushLayer`/`popTopLayer`).
  - `useSettingsStore`: `theme` (`'night'|'tinted'|'day'|'classic'`), `accentColor`, `wallpaper`, `wallpaperBlur`, `fontSize` (`12..20`), `bubbleRadius` (`6..18`), `uiScale` (`50..200`), `language` (`'zh-CN'|'en-US'`), `sendByEnter`, `autoTranslate`, `notificationsEnabled`.
  - `useAiWorkspaceStore`: `botFatherState`, `miniAppsCatalog`, `activeMiniApp`, `hermesSessions`, `hermesMemory`, `hermesSkills`, `hermesTools`, `hermesCrons`, `hermesKanban`, `magpieConfig`, `magpieUsage`, `tasks`, `mcpTools`, `mcpApprovals`, `talkModeState`, `computerSession`, `walletState`.

---

## Code Layout

Strict exclusive write ownership across tracks and parallel milestones:

```text
/home/antigravity/
├── PROJECT.md                                  # Global project index (Project Orchestrator)
├── TEST_INFRA.md                               # E2E test architecture & feature checklist (E2E Orchestrator)
├── TEST_READY.md                               # E2E suite completion signal (E2E Orchestrator)
├── .agents/teamwork/                           # Coordination metadata ONLY (never source/tests/data)
└── gpui-telegram-web/                          # Git repository root to push to GitHub
    ├── package.json                            # [M1; M6 scripts check] npm workspaces root
    ├── tsconfig.base.json                      # [M1]
    ├── .gitignore                              # [M1, M7]
    ├── README.md                               # [M1, M6, M7]
    ├── packages/
    │   └── protocol/                           # [M1] Shared schemas, IME FSM, waveform codec, E2EE, TelegramClientPort, DOM_IDS
    ├── apps/
    │   ├── server/                             # [M1; M6 integration refinements] Node 24 + SQLite WAL + /api/v1 REST/WS/SSE/HTTP-206
    │   └── web/
    │       ├── index.html                      # [M1, M6]
    │       ├── vite.config.ts                  # [M1, M6]
    │       ├── public/
    │       │   ├── js/telegram-web-app.js      # [M5] Telegram.WebApp iframe bridge SDK
    │       │   ├── miniapps/                   # [M5] fabushi-globe (.wasm + 3D Canvas + Zen Room) & taskboard Mini Apps
    │       │   ├── manifest.webmanifest        # [M6] PWA manifest
    │       │   └── sw.js                       # [M6] Service worker shell
    │       └── src/
    │           ├── styles/
    │           │   ├── tokens.css              # [M1] 4 themes (zero purple-on-dark), accents, typography
    │           │   ├── reset.css               # [M1]
    │           │   ├── layout.css              # [M1] 4-breakpoint responsive CSS Grid
    │           │   ├── auth.css                # [M2]
    │           │   ├── left.css                # [M2]
    │           │   ├── middle.css              # [M3]
    │           │   ├── right-settings-modals.css # [M4]
    │           │   └── ai-miniapps.css         # [M5]
    │           ├── adapters/                   # [M1] HttpWsServerAdapter, LocalSandboxAdapter, MtprotoAdapter, BroadcastChannel
    │           ├── store/                      # [M1] Zustand stores (useAuthStore, useChatStore, useUiStore, useSettingsStore, useAiWorkspaceStore)
    │           ├── i18n/                       # [M1; M2-M6 keys] zh-CN & en-US dictionary
    │           ├── services/
    │           │   ├── audioRecorder.ts        # [M3] MediaRecorder + Web Audio waveform + headless PCM WAV synth
    │           │   ├── blobUrlRegistry.ts      # [M3] Ref-counted ObjectURL cache
    │           │   └── chatExport.ts           # [M4] JSON & styled HTML exporter
    │           ├── components/
    │           │   ├── auth/                   # [M2] 7 Auth flows, QR, CountryPicker, PasscodeLock
    │           │   ├── layout/                 # [M2] MainShell, NavRail, ConnectionBanner, TopAudioBar, TopCallBar
    │           │   ├── left/                   # [M2] BurgerMenu, GlobalSearch, Stories, Folders, Archive, ChatList, ForumTopics
    │           │   ├── middle/                 # [M3] ChatHeader, PinnedBanner, MessageList, Bubbles, Cards, Reactions, Composer
    │           │   ├── media/                  # [M3] LightboxViewer, MediaEditorModal, InstantViewModal
    │           │   ├── right/                  # [M4] RightColumn, Profile, Members, SharedMedia/Files/Links/Voice, Stats, InChatSearch
    │           │   ├── settings/               # [M4] 25-page SettingsSlideStack
    │           │   ├── modals/                 # [M4] Group/Channel/Contacts/Forward/Poll/Todo/Invoice/SecretChat/Shortcuts/Confirm
    │           │   ├── calls/                  # [M4] CallOverlay (WebRTC + loopback + screen share)
    │           │   ├── miniapps/               # [M5] MiniAppModal, BotFatherCatalog
    │           │   └── ai/                     # [M5] HermesStudio (6 tabs), MagpieGateway, TaskCenter, McpDock, TalkModeOrb, ComputerWorkbench, WalletModal
    │           ├── App.tsx                     # [M1 skeleton -> M6 full integration]
    │           └── main.tsx                    # [M1, M6]
    ├── tests/
    │   └── unit/                               # [M1-M6] Vitest unit & contract tests
    └── e2e/                                    # [E2E Testing Track ONLY -> M7 Tier 5 adds tier5/] Self-contained Playwright opaque-box suite
        ├── package.json                        # [E2E Track] @playwright/test
        ├── playwright.config.ts                # [E2E Track] /usr/lib/chromium/chromium headless config
        ├── helpers/                            # [E2E Track] Server lifecycle & browser fixtures
        ├── tier1/                              # [E2E Track] >= 80 Feature Coverage tests (>=5 per F1..F16)
        ├── tier2/                              # [E2E Track] >= 80 Boundary, Corner & Negative tests (>=5 per F1..F16)
        ├── tier3/                              # [E2E Track] >= 16 Cross-Feature Pairwise tests
        └── tier4/                              # [E2E Track] >= 8 Real-World End-to-End Application Scenarios
```

---

## F17 — Desktop-to-Browser Control Bridge & Standalone Parity Summary

### 1. Zero Native Binary Dependency
All desktop capabilities of `bhrum/gpui-telegram` (`v1.2.0`) are implemented natively in TypeScript across `packages/protocol`, `apps/server`, and `apps/web` with **zero runtime or build-time dependency on the Rust/GPUI desktop binary**:
- **`server` mode**: Full Node.js 24 (`node:http` + `node:sqlite` WAL + `ws` + SSE) backend + React 19 SPA.
- **`sandbox` mode**: 100% client-side standalone runtime (`LocalSandboxAdapter` + `BroadcastChannel` multi-tab sync) requiring zero backend server.
- **`mtproto` mode**: Pluggable `TelegramClientPort` adapter for direct Telegram DC transport configuration.

### 2. Desktop-to-Browser Control Bridge (`F17`)
Provides bidirectional browser automation and inspection capabilities **to** `gpui-telegram` desktop clients, CLI scripts, and MCP agents:
- **Protocol Contract (`packages/protocol/src/browserControl.ts`)**: Typed schemas for `BrowserTargetDto`, `BrowserSnapshotDto`, `BrowserElementRef`, `BrowserTabCommand`, `HeadlessBrowserSessionDto`, `DesktopPairingTokenDto`, and MCP JSON-RPC 2.0 envelopes.
- **Live Web Tab Agent (`apps/web/src/services/browserControlAgent.ts` & `apps/web/src/components/ai/BrowserControlWorkspace.tsx`)**:
  - Exposes `window.__GPUI_TELEGRAM_BROWSER_BRIDGE__` (`snapshot`, `executeCommand`, `getStatus`) and maintains a live `/api/v1/browser/ws` reverse-RPC channel.
  - Supports deterministic element-ref (`e1`, `e2`, ...) DOM/Accessibility snapshots, `click`, `fill`, `press`, `hover`, `scroll`, `select`, `navigate`, SVG viewport `screenshot`, `evaluate_query`, and semantic `app_action` commands (`select_chat`, `send_chat_message`, `switch_theme`, `open_nav_dest`, `search_global`), plus `<10ms` emergency `Revoke All` (`#btn-browser-revoke-all`).
- **Server Controller & Headless Chromium CDP Studio (`apps/server/src/routes/browserControl.ts`)**:
  - Pairing & capability token lifecycle (`/api/v1/browser/pair/request`, `/api/v1/browser/pair/exchange`, `/api/v1/browser/grants`, `/api/v1/browser/revoke-all`) with strict per-user isolation via `X-Desktop-Browser-Token`.
  - Isolated Headless Chromium CDP controller (`/api/v1/browser/headless/sessions/*`) with automatic `http_dom_fallback` when Chromium is absent.
  - Standard **Model Context Protocol (MCP) JSON-RPC 2.0** server (`GET /api/v1/mcp/manifest`, `POST /api/v1/mcp/rpc`) exposing 9 `browser_*` tools.

### 3. Verification Status
- **TypeScript (`tsc --noEmit`)**: 0 errors across `packages/protocol`, `apps/server`, `apps/web`, and `e2e`.
- **Unit & Integration (`vitest run`)**: 26/26 passed (`protocol.test.ts`, `server.test.ts`, `ecosystem.test.ts`, `browserControl.test.ts`).
- **End-to-End (`@playwright/test` Chromium)**: 97/97 passed across all 17 Tier 1 spec files (`F1`–`F17`).
