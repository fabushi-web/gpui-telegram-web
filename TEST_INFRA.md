# E2E Test Infrastructure & Specification (`TEST_INFRA.md`)

## 1. Test Philosophy

1. **Requirement-Driven Opaque-Box Isolation**:
   - The Playwright E2E suite in `/home/antigravity/gpui-telegram-web/e2e/` is authored strictly from the user requirements (`/home/antigravity/.agents/teamwork/ORIGINAL_REQUEST.md`), global specification & interface contracts (`/home/antigravity/PROJECT.md`), and authoritative upstream domain survey (`bhrum/gpui-telegram` + Telegram Web A/K).
   - `e2e/` is a **100% self-contained npm package** with zero TypeScript/runtime imports from `../packages/**` or `../apps/**`. It interacts with the application exclusively as a real human user in Chromium (`http://127.0.0.1:<PORT>`, DOM, keyboard/mouse/clipboard/file-upload/audio/canvas/iframe events, `IndexedDB`/`localStorage`, `BroadcastChannel`, HTTP `/api/v1/*`, and WebSocket `/api/v1/ws`).
2. **Fail-Closed Verification Integrity**:
   - Every test MUST exercise real browser navigation, genuine user interactions, and concrete observable post-conditions (DOM state mutations, computed CSS layout/colors, network/WS frames, canvas pixel/state verification, file downloads, or `page.reload()` persistence).
   - `test.skip`, `test.fixme`, `test.todo`, `expect(true).toBe(true)`, catch-and-swallow `try { ... } catch {}` around assertions, or passing when target elements are absent are **strictly forbidden**.
   - Every spec MUST **fail closed** when pointed at an empty/dummy HTTP server (`npm --prefix /home/antigravity/gpui-telegram-web/e2e run verify:fail-closed`) and pass ONLY when the real UI and backend contracts in `PROJECT.md` are genuinely satisfied.
3. **Deterministic State Reset & Zero Cross-Test Pollution**:
   - Every test starts from a deterministic state via `POST /api/v1/test/reset` (when `ENABLE_TEST_RESET=1` on the server) paired with browser `localStorage`, `sessionStorage`, cookie, and `IndexedDB` cleanup in the shared Playwright fixture.
   - All temporary E2E server data lives under `/home/antigravity/gpui-telegram-web/e2e/.e2e-data` (gitignored); `/tmp` is **never** used.
4. **Canonical Hook + Bilingual Semantic Locator Discipline**:
   - Primary containers, controls, tabs, and modals are targeted via the exact canonical `#id` and `[data-testid]` selectors contracted in `PROJECT.md § Interface Contracts`.
   - Sub-controls inside canonical containers (e.g., submit buttons or menu items inside `#modal-create-poll`, `#main-menu-drawer`, or context menus) use container-scoped ARIA roles and bilingual `en-US` / `zh-CN` regular expressions so tests remain rock-solid across locales without coupling to internal implementation details.

---

## 2. Feature Inventory (`F1`–`F16`, `N = 16`)

Every feature in `/home/antigravity/PROJECT.md § Feature Inventory` is covered by `>= 5` happy-path tests in **Tier 1** (`e2e/tier1/`) and `>= 5` boundary/corner/negative tests in **Tier 2** (`e2e/tier2/`), plus pairwise interactions in **Tier 3** (`e2e/tier3/`) and end-to-end workflows in **Tier 4** (`e2e/tier4/`).

| ID | Feature | Canonical DOM & API Contracts (`PROJECT.md`) | Tier 1 Focus (`>= 5` tests) | Tier 2 Focus (`>= 5` tests) |
|---|---|---|---|---|
| **F1** | **Multi-Flow Auth, Adapter Switcher, Multi-Account & Passcode Lock** | `#auth-screen`, `#btn-demo-login`, `#tab-auth-phone`, `#tab-auth-qr`, `#tab-auth-password`, `#tab-auth-email`, `#tab-auth-alipay`, `#btn-auth-passkey`, `#auth-country-select`, `#auth-phone-input`, `#btn-auth-send-code`, `#auth-code-input`, `#auth-2fa-input`, `#btn-auth-submit-2fa`, `#qr-login-svg`, `#btn-simulate-qr-scan`, `#auth-username-input`, `#auth-password-input`, `#btn-auth-password-submit`, `#auth-mode-register-toggle`, `#auth-server-url-input`, `#btn-mtproto-config`, `#menu-account-switcher`, `#passcode-lock-screen`, `#passcode-unlock-input`, `#menu-item-logout` | 1-click Demo login, Phone+Country+OTP, Cloud 2FA login, SVG QR pairing + `#btn-simulate-qr-scan`, Username/Password register+login, Email/Alipay/Passkey/ServerURL/MTProto mode + Multi-Account switch + Local Passcode Lock (`Ctrl+Shift+L`) | Invalid phone format, wrong OTP code rejection, wrong 2FA password error, duplicate username `409` / wrong password `401`, wrong passcode lock rejection without exposing `#app-shell`, `page.reload()` session & 6-slot multi-account boundary |
| **F2** | **Responsive 4-Breakpoint 3-Column Shell, 4 Vanilla CSS Themes & Bilingual i18n** | `#app-shell`, `#left-column`, `#middle-column`, `#right-column`, `#btn-back-to-chats`, `#btn-collapse-sidebar`, `#nav-rail`, `#btn-main-menu`, `#main-menu-drawer`, `#menu-toggle-night-mode`, `#menu-toggle-language`, `:root[data-theme="night\|tinted\|day\|classic"]`, `--tg-font-size`, `--tg-bubble-radius`, `--tg-ui-scale` | 4 breakpoints (`1440x900` 3-col, `1100x800` 2-col, `768x900` tablet drawers, `390x844` mobile stack), `#btn-collapse-sidebar` `64px` rail (`Ctrl+B`), `#main-menu-drawer`, 4 Vanilla CSS themes (`Ctrl+D`) with zero purple-on-dark check, 8 accents/7 wallpapers/sliders, live `zh-CN`/`en-US` i18n (`Ctrl+L`) | Mobile `390x844` slide-stack `#left-column -> #middle-column -> #right-column -> #btn-back-to-chats` zero horizontal overflow, 7-level layered `Escape` stack (1 layer popped per `Esc`), sidebar resize clamp `[260px..424px]`, theme/scale/locale reload persistence, anti-purple dark-mode RGB invariant across overlays |
| **F3** | **Real-Time WebSocket (`/api/v1/ws`), Monotonic PTS Sync, Offline Outbox & Multi-Tab Sync** | `#connection-status-banner`, `/api/v1/health`, `/api/v1/ws`, `/api/v1/sync/get_difference`, `BroadcastChannel('gpui-telegram-web-sync')` | Clean WS connection without offline banner, monotonic `pts` real-time message delivery & `🕒 -> ✓ -> ✓✓` checkmarks, `/api/v1/sync/get_difference` sync recovery, live typing indicator in `#chat-header-status` & `#chat-list`, `BroadcastChannel` live multi-tab sync | `context.setOffline(true)` banner + pending `🕒` outbox queue, reconnect idempotent flush (`client_nonce` dedup, zero duplicate bubbles), `pts` gap recovery, `page.reload()` SQLite + IndexedDB state survival, invalid/revoked auth token WS rejection |
| **F4** | **Virtualized Chat List, Chat Folders, Archive, Stories & Forum Topics** | `#chat-list`, `[data-testid="chat-row"]`, `[data-chat-id]`, `#chat-folder-tabs`, `[data-folder-id]`, `#archived-chats-row`, `#stories-bar`, `#stories-viewer`, `#menu-item-saved-messages`, `#forum-topic-list`, `[data-topic-id]`, `#btn-new-chat-fab` | Virtualized `#chat-list` rows (7-color avatars, unread pills, pin/mute badges, context menu Pin/Mute/Unread/Archive), `#chat-folder-tabs` filter + custom folder CRUD, `#archived-chats-row` expand/collapse, `#stories-bar` & `#stories-viewer` + post story, `Saved Messages` (`Ctrl+0`), Supergroup `#forum-topic-list` scoping | Empty custom folder empty state + Add Chats CTA, max pinned chats per folder limit & toast, archiving/unarchiving last chat dynamic row visibility, non-admin topic creation restriction, delete/leave active chat clean fallback to empty stage |
| **F5** | **Global CJK Full-Text Search & In-Chat Search with Date Jump** | `#global-search-input`, `#search-tabs`, `#btn-in-chat-search`, `#in-chat-search-input`, `#in-chat-search-prev`, `#in-chat-search-next` | `#global-search-input` (`Ctrl+K` / `/`) CJK full-text query & snippet highlight, `#search-tabs` (`Chats`, `Messages`, `Apps`, `Media`, `Links`, `Files`, `Music`, `Voice`), `#in-chat-search-input` (`Ctrl+F`) match counter (`M of N`), `#in-chat-search-prev`/`#in-chat-search-next` bubble jump, sender & Jump-to-Date calendar filter | Zero-match global & in-chat empty states, regex/SQL/HTML metacharacter query safety (`.*+?[]'";<script>`), mixed CJK + emoji + Latin boundary search, `Escape` search clear & restore chat list, rapid debounced input race cancellation |
| **F6** | **Virtualized Date-Grouped Tail-Bubble Timeline, Pinned Banner & Read Receipts** | `#message-list`, `[data-testid="message-bubble"]`, `[data-message-id]`, `#pinned-message-banner`, `#btn-scroll-to-bottom` | Virtualized `#message-list` sticky date pills & `<=900s` sender-grouped SVG tail bubbles `[160px..480px]`, `48px` bottom stickiness & `#btn-scroll-to-bottom` FAB, per-chat scroll position preservation across switches, `#pinned-message-banner` multi-pin cycle & jump, channel `👁` views & viewport read receipts | Rapid 10-chat switching isolation (`AbortController` `chatId` fencing, zero bubble/draft bleed), `>4096` char message split/handling without silent truncation, 250-char unbroken URL `overflow-wrap: anywhere` zero horizontal overflow, mixed RTL Arabic/Hebrew + LTR `dir="auto"`, deleting pinned message updates/hides `#pinned-message-banner` |
| **F7** | **Rich Text Entities, Code Blocks, Spoilers, Link Previews & Instant View** | `[data-testid="message-bubble"]`, `#instant-view-modal` | Bold/italic/underline/strikethrough/inline-code UTF-16 entity rendering, fenced ` ```lang ` code block with `Copy Code`, click-to-reveal `||spoiler||` & collapsible `> blockquote`, clickable `@mention` / `#hashtag` / URL, OpenGraph WebPage preview & `#instant-view-modal` reader | XSS payloads (`<img src=x onerror=...>`, `<svg onload=...>`, `javascript:alert(1)`) strictly escaped (`window.__xss === undefined`), malformed unclosed Markdown graceful rendering, UTF-16 astral emoji surrogate-pair offset integrity, external link confirmation / `noopener`, plain URL without OpenGraph clean fallback |
| **F8** | **Canonical Composer, 3-State CJK IME Safety FSM, Formatting, Stickers/GIFs & Drafts** | `#message-composer-input`, `#btn-formatting-toolbar`, `#btn-emoji-picker`, `#emoji-sticker-gif-popover`, `#btn-ai-compose`, `#btn-send-message` | Elastic `[44px..192px]` composer growth & `Shift+Enter` newline vs `Enter` send, `#btn-formatting-toolbar` & `Ctrl+B/I/U/Shift+X/Shift+M/Shift+P/K`, 3-tab `Emoji / Stickers / GIFs` popover send, `/slash` & `@mention` autocomplete + silent/scheduled send, per-chat draft sync & red `Draft:` row badge, `#btn-ai-compose` rewrite/translate | **3-State CJK IME `Enter` fence** (`compositionstart` -> Pinyin -> `Enter` commits candidate ONLY without sending; 1-frame `compositionend` guard; subsequent `Idle` `Enter` sends), `192px` max-height cap + scroll, whitespace-only send blocked, non-admin broadcast channel hides composer (Mute/Discuss bar), draft survival across rapid switch & reload, invalid past schedule rejection |
| **F9** | **Message Operations: Reply, Quote-Reply, Edit, Forward, Pin, Delete & Multi-Select** | `#composer-reply-edit-banner`, `#modal-forward`, `#selection-toolbar` | Context Reply + jump to replied bubble, selected-text Partial Quote Reply, Edit via menu & empty-composer `ArrowUp` (`"edited"` label), `#modal-forward` (search target, Saved Messages, hide sender, comment), Pin/Unpin message, Delete (`for me` vs `for everyone` tombstone) + `#selection-toolbar` batch ops | `ArrowUp` in non-empty composer does NOT hijack caret into edit mode, `Escape` cancels reply/edit while preserving typed draft, reply header when original message deleted shows graceful tombstone, editing incoming peer message forbidden, clearing last selected message auto-closes `#selection-toolbar` |
| **F10** | **Out-of-Flow Hover Quick Reactions, 32-Emoji Picker & Reactor List** | `[data-testid="message-bubble"]` hover trigger, quick strip, 32-emoji popover, reaction counter pills | Zero-layout-shift hover reaction button -> 7-emoji quick strip, 8x4 32-emoji extended selector, toggle own reaction (`is_chosen_by_me` active state & count `+1/-1`), multiple distinct emoji chips on single bubble, Reactor List popover avatars/names | Rapid multi-click toggle idempotency (never `0` chip leftover or negative count), max reactions per message replacement rule, viewport edge clamping for reaction popover, service/deleted tombstone messages suppress reaction bar, reaction counts persist across `page.reload()` |
| **F11** | **Resumable CAS Media Upload, Mosaic Albums, Spoilers, Files, Media Editor & Lightbox** | `#btn-attach-menu`, `#file-upload-input`, `#modal-media-editor`, `#lightbox-viewer`, `#lightbox-zoom-in`, `#lightbox-rotate`, `#lightbox-next`, `#lightbox-prev`, `#lightbox-download`, `#lightbox-close` | Single photo upload & HTTP 206 / Blob display, `#modal-media-editor` (crop/rotate/draw/spoiler/caption), 2–4 item proportional Mosaic Media Album, Document/File card with extension badge & Blob download, `#lightbox-viewer` zoom/rotate/next/prev/download/close, `Ctrl+V` clipboard paste & drag-drop image | Corrupted/non-image bytes uploaded as image degrade safely without crash, `>10` attachments album split/limit handling, cancelling `#modal-media-editor` leaves timeline untouched, spoiler-flagged photo stays blurred until click, `#lightbox-viewer` zoom clamp `[1x..4x]` & first/last navigation bounds |
| **F12** | **100-Bar 5-Bit Voice Notes, Round Video, Persistent Audio Bar & Headless Synth Fallback** | `#btn-record-voice`, `#top-audio-player-bar` | `#btn-record-voice` recording via headless Web Audio PCM `.wav` fallback & send, 100-bar 5-bit waveform play/pause & scrub seek, `1x -> 1.5x -> 2x` speed pill, `->A` Voice-to-Text transcription toggle, `240px` circular Round Video note & `#top-audio-player-bar` persistence across chats | Explicit `navigator.mediaDevices.getUserMedia` `NotFoundError`/`NotAllowedError` rejection cleanly activates synth WAV fallback without unhandled error, cancel recording (`Escape`/Cancel) discards blob, ultra-short `<1s` tap handling, waveform seek `[0..100%]` boundary clamp, closing `#top-audio-player-bar` halts playback |
| **F13** | **Interactive Polls, Quiz Mode, Collaborative Todo Checklists & Invoices** | `#modal-create-poll`, `#modal-create-todo`, `#wallet-stars-modal` | `#modal-create-poll` regular poll creation & live percentage bar voting, retract vote & close poll + Poll Results drawer, Quiz mode single-choice correct/wrong explanation feedback, `#modal-create-todo` shared checklist item toggle, Stars/TON/Stripe Invoice card checkout & receipt | Poll creation blocked with empty question or `<2` non-empty options, max `12` poll options cap, closed poll rejects new votes & retract, Quiz mode locks answer after vote, Todo checklist empty-item validation & `30`-item cap |
| **F14** | **Right Context Inspector, Contacts/Groups/Channels Admin, Stats & 25-Page Settings + Export** | `#btn-toggle-right-column`, `#right-column`, `#right-profile-info`, `#right-tabs` (`#right-tab-members`, `#right-tab-media`, `#right-tab-files`, `#right-tab-links`, `#right-tab-voice`, `#right-tab-stats`), `#settings-panel`, `[data-settings-section]`, `#btn-export-chat-json`, `#btn-export-chat-html`, `#modal-create-group`, `#modal-create-channel`, `#modal-contacts`, `#modal-shortcuts` | `#right-column` (`Ctrl+I`) profile & all 6 shared tabs + SVG/Canvas Channel Statistics, `#modal-create-group` / `#modal-create-channel` / `#modal-contacts` wizards, Group admin promote/ban & invite links, 25-page `#settings-panel` slide-stack navigation, `#btn-export-chat-json` & `#btn-export-chat-html` downloads, `#modal-shortcuts` (`?`) | `#right-column` strict per-`chatId` media/files/links isolation (zero cross-chat synthetic items + clean empty states), invalid `@username` (`<5` chars / symbols) rejected in Profile Settings, group/channel creation blocks blank title, revoked invite link rejected, empty chat JSON/HTML export valid structure |
| **F15** | **WebRTC 1-on-1 & Group Audio/Video Calls, Screen Share & WebCrypto E2EE Secret Chats** | `#btn-start-audio-call`, `#btn-start-video-call`, `#call-overlay`, `#top-call-bar` | 1-on-1 Audio Call `#call-overlay` with 4-emoji E2EE key fingerprint & mute toggle, Video Call + Screen Share with headless Canvas/WebAudio stream fallback, minimize call to `#top-call-bar` & restore, end call + post-call rating, WebCrypto (`ECDH + HKDF + AES-256-GCM`) Secret Chat + TTL | Denied camera/screen-share permission degrades gracefully in `#call-overlay`, 1-on-1 call controls disabled/adapted in broadcast channels, declined/hung-up call cleans `#call-overlay` & logs Call service item, Secret Chat self-destruct TTL countdown auto-purges expired message, malformed/tampered E2EE ciphertext rejected safely |
| **F16** | **`@BotFather`, `window.Telegram.WebApp` Mini Apps, 全球法布施 WASM+3D Globe, Hermes 6-Tab Studio, Magpie LLM Gateway & Cloud Workspaces** | `#miniapp-modal`, `#miniapp-iframe`, `#hermes-studio-panel`, `[data-hermes-tab]`, `#magpie-gateway-panel`, `#task-center-workspace`, `#mcp-tools-dock`, `#talk-mode-orb`, `#computer-workbench`, `#computer-canvas`, `#btn-computer-takeover`, `#wallet-stars-modal`, `#nav-rail` (`#nav-dest-tasks`, `#nav-dest-mcp`, `#nav-dest-talk`, `#nav-dest-computer`, `#nav-dest-hermes`) | `@BotFather` (`/start`, `/newbot`, `/mybots`, `/newapp`), `#miniapp-iframe` `/js/telegram-web-app.js` SDK (`initData`, `themeParams`, `MainButton`, `CloudStorage`, `sendData`), **全球法布施 (`fabushi-globe`) `.wasm` + HTML5 `<canvas>` 3D Globe & Zen Room (`木鱼`/Incense/Sutras/VIP/Leaderboard)**, **Hermes 6-Tab Studio** + SSE `ThinkingBubble` + `/slash` commands, **Magpie LLM Gateway** (routing/presets/PII masking/ledger), **Task Center & Cron** + **MCP Dock**, **`TalkModeOrb`** + **Computer Workbench** + **Stars/TON Wallet** | `@BotFather` rejects bot username not ending in `bot` or duplicate handle, `#miniapp-iframe` sandbox enforcement & untrusted origin `postMessage` rejection, `fabushi-globe` WASM `CloudStorage` persistence across reopen/reload, Magpie zero-API-key local provider + PII masking (`email`/phone/`sk-...` redacted), MCP dangerous tool blocked until explicit user approval, Computer Workbench `#btn-computer-takeover` & `Escape` immediate lease takeover |

---

## 3. Test Architecture & Harness Contract

### 3.1 Directory Layout (`/home/antigravity/gpui-telegram-web/e2e/`)
```text
/home/antigravity/gpui-telegram-web/e2e/
├── .gitignore                        # Ignores node_modules/, .e2e-data/, test-results/, playwright-report/
├── package.json                      # Self-contained @playwright/test + typescript + @types/node
├── package-lock.json
├── tsconfig.json                     # strict: true, isolated inside e2e/
├── playwright.config.ts              # /usr/lib/chromium/chromium, 127.0.0.1:4173, workers <= 2
├── scripts/
│   └── verify-fail-closed.mjs        # Ephemeral 127.0.0.1 dummy server proving specs fail closed
├── helpers/
│   ├── selectors.ts                  # Canonical DOM IDs & data-testid constants from PROJECT.md
│   ├── server.ts                     # Base URL, /api/v1/health check, POST /api/v1/test/reset, storage wipe
│   ├── fixtures.ts                   # Extended Playwright test/expect with clean state & authenticatedPage
│   ├── ui.ts                         # Resilient bilingual (en-US/zh-CN) UI interaction & theme assertion helpers
│   └── media.ts                      # Deterministic in-memory PNG, RIFF WAV, PDF, and text Buffer builders
├── tier1/                            # >= 80 Feature Coverage tests (f01..f16, >= 5 per feature)
├── tier2/                            # >= 80 Boundary, Corner & Negative tests (f01..f16, >= 5 per feature)
├── tier3/                            # >= 16 Cross-Feature Pairwise Combination tests
└── tier4/                            # >= 8 Real-World End-to-End Application Scenarios
```

### 3.2 VM Chromium, Proxy & `webServer` Configuration (`playwright.config.ts`)
- **Browser Binary**: `/usr/lib/chromium/chromium` (`Chromium 156.0.8078.79`), installed with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install`.
- **Launch Options**: `executablePath: '/usr/lib/chromium/chromium'`, `args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-fake-ui-for-media-stream']` (note: Tier 2 `f12` / `f15` explicitly override or deny `getUserMedia` via `addInitScript` when testing no-mic/denied-permission fallbacks).
- **Concurrency**: `workers: process.env.PLAYWRIGHT_WORKERS ? Number(process.env.PLAYWRIGHT_WORKERS) : (process.env.CI ? 1 : 2)` to respect the 2-vCPU, 0-swap VM budget.
- **Proxy-Safe Base URL**: `const baseURL = process.env.E2E_BASE_URL || 'http://127.0.0.1:4173'` (NEVER `0.0.0.0`, honoring `NO_PROXY=localhost,127.0.0.1,::1,[::1]`).
- **Automatic `webServer` with `E2E_BASE_URL` Override**:
  - When `process.env.E2E_BASE_URL` is **unset**: Playwright launches `PORT=4173 HOST=127.0.0.1 ENABLE_TEST_RESET=1 DATA_DIR=/home/antigravity/gpui-telegram-web/e2e/.e2e-data npm --prefix /home/antigravity/gpui-telegram-web start`, polling `http://127.0.0.1:4173/api/v1/health` with `reuseExistingServer: !process.env.CI`.
  - When `process.env.E2E_BASE_URL` **is set**: `webServer` is `undefined`, allowing pointing directly at custom/running instances or the ephemeral fail-closed dummy server.

### 3.3 Shared Helper Exports Contract (`e2e/helpers/*`)
All Tier 1–4 spec files import from `../helpers/fixtures`, `../helpers/selectors`, `../helpers/ui`, `../helpers/media`, and `../helpers/server`:
- **`helpers/selectors.ts`**: Exports `DOM` object containing every canonical `#id` and `[data-testid]` selector defined in `PROJECT.md § Interface Contracts` (lines 100–105), plus `NAV_DESTS`, `RIGHT_TABS`, `AUTH_TABS`, and `THEMES = ['night', 'tinted', 'day', 'classic'] as const`.
- **`helpers/server.ts`**:
  - `getBaseUrl(): string`
  - `resetTestServer(request: APIRequestContext): Promise<void>` (`POST /api/v1/test/reset` — fails closed if status `>= 500`, gracefully handles sandbox-only static mode if `404` only when explicitly testing sandbox mode, otherwise asserts `ok`)
  - `clearClientState(page: Page): Promise<void>` (clears cookies, `localStorage`, `sessionStorage`, and deletes all `IndexedDB` databases on origin)
- **`helpers/fixtures.ts`**:
  - Exports `test` and `expect` from `@playwright/test` extended with:
    - Automatic per-test server reset (`resetTestServer`) before navigating
    - `authPage: Page` fixture that navigates to `/`, resets client + server state, clicks `#btn-demo-login` (if on `#auth-screen`), and awaits `#app-shell` & `#chat-list` visible
    - `openSecondTab(): Promise<Page>` helper sharing the same `BrowserContext` for `BroadcastChannel` multi-tab sync tests
- **`helpers/ui.ts`**:
  - `loginViaDemo(page: Page): Promise<void>`
  - `selectChat(page: Page, matcher?: string | RegExp | number): Promise<Locator>`
  - `sendTextMessage(page: Page, text: string): Promise<Locator>`
  - `simulateCjkImeComposition(input: Locator, pinyin: string, committedText: string): Promise<void>`
  - `openBurgerMenu(page: Page): Promise<Locator>`
  - `openSettings(page: Page): Promise<Locator>`
  - `openRightInspector(page: Page): Promise<Locator>`
  - `assertNoPurpleOnDark(page: Page): Promise<void>` (samples computed `backgroundColor`, `color`, `borderColor` across `#app-shell`, `#left-column`, `#middle-column`, buttons, and outgoing bubbles under `data-theme="night"` / `"tinted"` and asserts zero purple/violet hue dominance where `R > 95 && B > 140 && B > G + 45 && R > G + 30`)
- **`helpers/media.ts`**:
  - `createPngBuffer(options?: { width?: number; height?: number; r?: number; g?: number; b?: number }): Buffer` (valid CRC32-signed PNG binary generated pure in-memory via `node:zlib`)
  - `createWavBuffer(options?: { durationMs?: number; frequencyHz?: number; sampleRate?: number }): Buffer` (valid 16-bit PCM RIFF `.wav` sine/chime buffer)
  - `createPdfBuffer(title?: string): Buffer` (valid minimal `%PDF-1.4` document buffer)
  - `createCorruptImageBuffer(): Buffer` (random non-image header bytes for negative tests)

---

## 4. Tier 3 Cross-Feature Pairwise Matrix (`>= 16` Tests)

Located in `e2e/tier3/`:
1. **PW-01 (`F3 × F6 × F9 × F2`)**: Multi-tab `BroadcastChannel` live sync of send, edit, reaction, and Night/Day theme switch across two open tabs.
2. **PW-02 (`F4 × F5 × F6`)**: Custom Chat Folder CRUD + pinned chat ordering + Global CJK Search snippet jump + unread badge decrement on viewport read.
3. **PW-03 (`F4 × F9 × F5`)**: Supergroup Forum Topic (`#forum-topic-list`) + Partial Quote Reply + Topic-scoped Pin Banner + Topic-scoped In-Chat Search.
4. **PW-04 (`F11 × F7 × F14`)**: Media Editor (`#modal-media-editor`) brush/crop + Spoiler toggle + formatted caption -> Mosaic Album -> `#lightbox-viewer` -> `#right-tab-media` sync.
5. **PW-05 (`F12 × F4 × F5`)**: Headless Voice Note recording -> `1.5x` playback -> switch chat -> `#top-audio-player-bar` stays live while running In-Chat Search in another chat.
6. **PW-06 (`F16 × F9 × F4`)**: `fabushi-globe` WASM Mini App `CloudStorage` write + `Telegram.WebApp.sendData` -> message card posted in chat -> Forward (`#modal-forward`) into Forum Topic.
7. **PW-07 (`F16: Hermes × Magpie × Task Center`)**: Magpie PII privacy masking enabled -> Hermes streaming SSE prompt containing email/phone -> masked turn output -> schedule follow-up 5-field Cron in `#task-center-workspace`.
8. **PW-08 (`F1 × F8 × F3`)**: Multi-Account Switcher (2 accounts) + independent CJK composer drafts per account + Local Passcode Lock (`#passcode-lock-screen`) + `page.reload()` full restoration.
9. **PW-09 (`F3 × F7 × F11 × F14`)**: Browser offline (`setOffline(true)`) -> queue Markdown + File attachment -> reconnect idempotent delivery -> `#btn-export-chat-json` & `#btn-export-chat-html` verify exported messages.
10. **PW-10 (`F13 × F10 × F9`)**: Quiz Mode poll vote & explanation -> 32-emoji reactions -> `#selection-toolbar` multi-select forward with `"Hide sender name"` to `Saved Messages`.
11. **PW-11 (`F2 × F8 × F14`)**: Mobile `390x844` single-pane stack + 3-state CJK IME composition commit + slide into `#right-column` profile & `#btn-back-to-chats` navigation.
12. **PW-12 (`F15 × F7 × F14`)**: WebCrypto E2EE Secret Chat + `||spoiler||` message + self-destruct TTL countdown + `#right-column` shared media isolation.
13. **PW-13 (`F16 × F5 × F2`)**: `@BotFather` `/newbot` & `/newapp` creation -> discover new Mini App via `#global-search-input` `Apps` tab under `zh-CN` localization.
14. **PW-14 (`F15 × F2 × F14`)**: Active WebRTC Video Call minimized to `#top-call-bar` while adjusting `#settings-panel` theme, bubble radius, and font size sliders live.
15. **PW-15 (`F16: MCP × Computer Workbench × F2`)**: `#mcp-tools-dock` tool permission approval -> `#computer-workbench` live `<canvas>` session -> `<10ms` `Escape` / `#btn-computer-takeover` emergency human takeover.
16. **PW-16 (`F16: Wallet × F13 × F14`)**: `#wallet-stars-modal` Stars top-up -> pay Stars Invoice card in chat -> verify receipt & updated balance in Settings Wallet section.
17. **PW-17 (`F7 × F2 × F6`)**: Open `#instant-view-modal` from WebPage preview -> toggle theme (`Ctrl+D`) -> layered `Escape` dismissal preserves exact `#message-list` scroll offset.
18. **PW-18 (`F14 × F11 × F13 × F6`)**: Create public Channel (`#modal-create-channel`) -> post photo & poll -> verify `👁` view counter & `#right-tab-stats` SVG/Canvas analytics charts.

---

## 5. Tier 4 Real-World Application Scenarios (`>= 8` Scenarios)

Located in `e2e/tier4/`:
1. **SC-01 — Bilingual Onboarding, Account Hardening & Daily Personal Messaging**: Phone + Country + OTP sign-in -> configure Cloud 2FA & Local Passcode Lock -> switch to `zh-CN` & `night` Blue theme -> create `"工作 / Work"` folder -> CJK IME-safe conversation, partial quote reply, reactions, headless voice note, `page.reload()`, and passcode unlock.
2. **SC-02 — Engineering Team Forum Supergroup Release War-Room**: Create Forum Supergroup -> create `#architecture` & `#release` topics -> upload annotated Mosaic diagrams via `#modal-media-editor` + fenced TypeScript code block + release-gate Poll & Todo checklist -> pin announcement -> CJK In-Chat Search -> export JSON & HTML transcripts.
3. **SC-03 — `@BotFather` & Flagship 全球法布施 (`fabushi-globe`) WASM 3D Globe + Zen Room Journey**: Configure bot/app in `@BotFather` -> launch **全球法布施** in `#miniapp-modal` -> verify `.wasm` module & 3D Globe `<canvas>` projection, trigger Dharma light-beam & Zen Room (`木鱼` Wooden Fish, Incense, Sutra reading, Leaderboard) -> persist merit in `Telegram.WebApp.CloudStorage` -> send dedication card back to group chat & react.
4. **SC-04 — Autonomous AI Agent Studio Pipeline (Hermes + Magpie + Cron + MCP + Computer Takeover)**: Configure Magpie zero-subscription provider & PII privacy masking -> run Hermes streaming SSE turn with `ThinkingBubble` & `/memory` across all 6 Studio tabs -> register recurring Cron job in `#task-center-workspace` -> approve pending MCP tool in `#mcp-tools-dock` -> inspect `#computer-workbench` `<canvas>` & trigger `Escape` emergency takeover.
5. **SC-05 — Mobile Commuter Subway Offline-to-Online Sync & Persistent Audio Briefing**: Under `390x844` mobile viewport, start playing a voice note -> navigate back to `#left-column` keeping `#top-audio-player-bar` playing -> go offline (`setOffline(true)`) -> queue 3 messages across 2 chats + save draft -> restore network -> verify idempotent `🕒 -> ✓✓` delivery with zero duplicates.
6. **SC-06 — Executive Live Video/Screen-Share Call & E2EE Secret Handoff**: Start 1-on-1 WebRTC Video Call -> enable Screen Share -> verify 4-emoji E2EE fingerprint -> minimize to `#top-call-bar` -> open E2EE Secret Chat with short self-destruct TTL to transmit confidential credential -> confirm TTL auto-purge -> hang up & submit 5-star call quality rating.
7. **SC-07 — Creator Broadcast Channel, Paid Stars Commerce & Channel Analytics**: Create public Broadcast Channel -> publish Mosaic media album, interactive Quiz, and Stars Invoice card -> top up Stars balance in `#wallet-stars-modal` & complete purchase -> verify receipt, `👁` post views, and `#right-tab-stats` SVG/Canvas growth charts.
8. **SC-08 — Multi-Account & Multi-Tab Cross-Window Power Operator**: Open two synchronized tabs (`BroadcastChannel`) -> verify live message/edit/reaction/theme propagation -> add a second account via `#menu-account-switcher` -> verify strict account data/draft isolation and seamless switching across `page.reload()`.

---

## 6. Coverage Thresholds & Gate Criteria

| Tier | Directory | Formula (`N = 16` features) | Minimum Required | Planned Target |
|---|---|---|---|---|
| **Tier 1 — Feature Coverage** | `e2e/tier1/` | `>= 5 × N` (`>= 5` per `F1`–`F16`) | `>= 80` tests | `89` tests |
| **Tier 2 — Boundary, Corner & Negative** | `e2e/tier2/` | `>= 5 × N` (`>= 5` per `F1`–`F16`) | `>= 80` tests | `82` tests |
| **Tier 3 — Cross-Feature Pairwise** | `e2e/tier3/` | `>= 1 × N` | `>= 16` tests | `18` tests |
| **Tier 4 — Real-World Scenarios** | `e2e/tier4/` | `>= 8` end-to-end journeys | `>= 8` tests | `8` tests |
| **Total Opaque-Box E2E Suite** | `e2e/` | Sum of Tiers 1–4 | **`>= 184` tests** | **`197` tests** |

### Pre-`TEST_READY.md` Mandatory Verification Checks
1. `npm --prefix /home/antigravity/gpui-telegram-web/e2e run typecheck` (`tsc --noEmit`) exits `0`.
2. `npx --prefix /home/antigravity/gpui-telegram-web/e2e playwright test --list` cleanly parses and enumerates all `>= 184` tests across `tier1/`, `tier2/`, `tier3/`, and `tier4/`, with `>= 5` Tier 1 tests and `>= 5` Tier 2 tests per feature `F1`–`F16`.
3. `npm --prefix /home/antigravity/gpui-telegram-web/e2e run verify:fail-closed` launches `/usr/lib/chromium/chromium` headless against an ephemeral `127.0.0.1` dummy server and verifies tests fail closed (exit non-zero on missing contract UI) rather than passing vacuously.
4. Zero `test.skip`, `test.todo`, `test.fixme`, `expect(true)`, `/tmp` paths, or modifications outside `TEST_INFRA.md`, `TEST_READY.md`, and `gpui-telegram-web/e2e/**` — certified `CLEAN` by `teamwork_preview_auditor` alongside `APPROVE` from both `teamwork_preview_reviewer`s and confirmation from both `teamwork_preview_challenger`s.
