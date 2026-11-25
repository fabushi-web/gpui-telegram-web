# E2E Test Infrastructure & Specification — Fabushi Web `v1.6.11` (`TEST_INFRA.md`)

## 1. Test Philosophy (Zero Fake Data & Opaque-Box Isolation)

1. **Zero Fake Data Truthfulness Mandate**:
   - Every E2E spec verifies **Fabushi Web `v1.6.11`** against real backend state (`apps/server` SQLite WAL + WebSocket `/api/v1/ws` + real upstream/self-hosted contracts).
   - `POST /api/v1/test/reset` (when `ENABLE_TEST_RESET=1`) **cleanly wipes SQLite tables to an empty truthful state** — it NEVER seeds fabricated users, chats, contacts, stories, AI providers, MCP tools, computer nodes, or Stars/TON grants.
   - Freshly registered accounts start truthfully with `chats: []`, `contacts: []`, `stories: []`, `providers: []`, `computers: []`, `stars: 0`, `is_premium: false`, and empty MiniApp `initData` when unauthenticated.
   - All authenticated UI specs sign in via **real account registration/login** (`registerAndLoginUser`, `registerUserViaApi`, `loginWithPassword`). Specs requiring existing conversations opt into `createRealConversationFixture(request, token, options)` using real REST endpoints.
2. **Requirement-Driven Opaque-Box Isolation**:
   - The Playwright E2E suite in `e2e/` (`fabushi-web-e2e` v1.6.11) is a **100% self-contained npm package** with zero TypeScript or runtime imports from application packages (`packages/**` or `apps/**`).
   - Tests interact exclusively through real Chromium browser actions (`http://127.0.0.1:<PORT>`), DOM/CSS/Canvas/WebCrypto/WASM/Media APIs, `BroadcastChannel`, HTTP REST/OAuth/MCP endpoints, ephemeral `127.0.0.1:0` OpenAI-compatible stubs (for multi-agent tool-loop verification), and WebSocket `/api/v1/ws`.
3. **5-Step Fail-Closed & Static Anti-Vacuity Integrity Gate**:
   - Every test executes concrete observable assertions (DOM/CSS mutations, exact HTTP status codes & JSON schemas, cryptographic digests, WS frames, binary downloads, or `page.reload()` persistence) with zero unbranched conditional assertion skips, zero error-swallowing `.catch()` fallbacks, zero nullish defaults masking missing fields, and zero `404`-masked RBAC/validation checks.
   - Skipped/deferred/focused test modifiers, soft assertions, and vacuous tautological assertions are strictly forbidden and mechanically rejected.
   - `npm --prefix e2e run verify:fail-closed` runs a **5-step fail-closed gate**:
     1. **Step 1/5 — TypeScript AST Static Anti-Vacuity & Opaque-Box Gate**: Parses all 46 specs (`tier1..tier4`) and 7 helper modules, rejecting non-opaque imports, forbidden test modifiers, tautologies, unbranched `if` statements guarding assertions/UI visibility, error-swallowing `.catch()` callbacks outside `finally`, mixed `2xx`/`4xx` or `500` status arrays, nullish defaults masking missing assertion fields, and tier count regressions.
     2. **Step 2/5 — Helper Contract & Media Integrity Audit**: Validates `helpers/{ui,selectors,server,api,media}.ts` exports, canonical 14 `MCP_SUPPORTED_SCOPES`, 60-byte ChaCha20Poly1305 wrapped root keys, `ScriptParameter.is_secret` schema, `0.0.0.0` proxy fail-closed rejection, invalid browser path rejection, and pure in-memory PNG/WAV/PDF/text/corrupt magic bytes.
     3. **Step 3/5 — Ephemeral `127.0.0.1:0` Dummy Server**: Binds a zero-dependency local HTTP dummy server returning `404 DUMMY_ENDPOINT` on all API/OAuth/MCP routes plus `/purple-dark` and `/valid-dark` theme test fixtures.
     4. **Step 4/5 — Real Auto-Detected Chromium & `assertNoPurpleOnDark` Self-Test**: Launches real headless Chromium/Chrome, proving `assertNoPurpleOnDark` throws on `/purple-dark` and accepts Apple Dark `/valid-dark`.
     5. **Step 5/5 — 4-Tier Playwright Fail-Closed Probe**: Executes representative specs across `tier1`, `tier2`, `tier3`, and `tier4` sequentially against the dummy server inside a concurrency-safe per-run `e2e/.e2e-data/p<4hex>/` tree (sized to keep both Google Chrome and bundled Playwright Chromium safely under Linux's 107-byte `AF_UNIX` `SingletonSocket` limit), rejecting exit `0`, timeouts, or harness setup errors, and removing its isolated probe directory cleanly in `finally`.
4. **Dynamic Paths & Proxy Safety**:
   - Zero hardcoded absolute repository or browser paths. `e2e/playwright.config.ts` and `e2e/scripts/verify-fail-closed.mjs` derive `E2E_ROOT` and `REPO_ROOT` dynamically (`path.resolve(__dirname, '..')`).
   - All temporary server/browser data lives inside `e2e/.e2e-data/` (gitignored; `playwright.config.ts` honors per-run `E2E_TMP_DIR` strictly constrained within `e2e/.e2e-data/`); system `/tmp` is never used.
   - `getBaseUrl()` enforces `127.0.0.1` / `localhost` and fails closed on `0.0.0.0` / `::` to honor VM `NO_PROXY` rules.

---

## 2. Feature Inventory (`A01`–`A16`) & `PROJECT.md` `F1`–`F14` Traceability

Every feature area `A01`–`A16` maps 100% to `PROJECT.md` `F1`–`F14` and upstream `v1.4.0`–`v1.6.11` domain specifications, with `>= 5` Tier 1 happy-path tests and `>= 5` Tier 2 boundary/corner/negative tests per area:

| Area | Spec Basename | `PROJECT.md` Mapping | Tier 1 | Tier 2 | Core Verification Scope |
|---|---|---|---:|---:|---|
| **A01** | `a01-auth-zero-fake-data-security.spec.ts` | F1, F2, F12 | 6 | 6 | Real registration/login, absence of removed demo/QR-sim controls, strict typed truthful empty account state, Cloud 2FA, two-device QR pairing, Passcode Lock, Passkey COSE anti-bypass (`400`/`401`/`403`), Alipay hijack rejection, UI logout + `DELETE /api/v1/account` + WS disconnect |
| **A02** | `a02-apple-muse-uiux-branding.spec.ts` | F1, F13 | 6 | 6 | 4 Vanilla CSS themes (`night`, `tinted`, `day`, `classic`), unconditional 4-step Apple Dark elevation, zero dark drop shadows, zero purple-on-dark across modals/drawers/workspaces, centered `76px` contact header, 3×3 `#sidebar-pinned-chats-grid`, 4 breakpoints, theme + locale reload persistence, 2-layer non-overlapping toasts, `Fabushi Web v1.6.11` & `sw.js` `fabushi-web-v4` branding |
| **A03** | `a03-ws-pts-messaging-sync.spec.ts` | F4 | 6 | 6 | Real-time `/api/v1/ws` `PtsPush`/`Ack`, `CreateChatRequest.client_nonce` (UUID) & `SendMessageHttpRequest.client_nonce` (`u64`) idempotency, CJK (`、`) vs Latin (`, `) auto-title, `archive-local-bot-reply` (`u64` nonce & `403` RBAC), `/api/v1/sync/get_difference`, multi-tab `BroadcastChannel`, offline outbox flush, local-TZ `HH:MM` timestamps, chat-switch race fencing |
| **A04** | `a04-chatlist-folders-stories-topics-search.spec.ts` | F2, F4, F12 | 6 | 6 | Virtualized `#chat-list` context ops (Mute/Unread/Pin/Archive observable state), custom Chat Folders CRUD & filtering, `#archived-chats-row`, Saved Messages, real Stories, Forum Topics isolation & non-admin `403` create/close RBAC, Global CJK & In-Chat Search, real Contacts lookup (`404` on non-existent user) |
| **A05** | `a05-composer-ime-entities-ops-reactions.spec.ts` | F2, F4, F12, F13 | 6 | 6 | 3-state CJK IME Safety FSM (incl. Safari trailing-Enter guard), Apple Capsule Composer (`#cmp-input-wrap`), rich UTF-16 entities (bold/italic/strike/code) & XSS neutrality, anti-fabricated OpenGraph on bare URLs, Reply/Edit (`403` RBAC)/Forward/Pin/Multi-Select batch delete, zero-jitter hover reactions (`+1`/`-1`) & reload persistence |
| **A06** | `a06-media-voice-polls-todos-wallet.spec.ts` | F2, F8, F12 | 6 | 6 | Resumable CAS photo upload (strict HTTP 206), `#modal-media-editor`, 3-image Mosaic Album, `%PDF-` binary download + honest UI 404 download error (zero fabricated `"Shared document:"`), `#lightbox-viewer` zoom clamp, real Chromium fake-device Voice Notes (`1.5x`/`2x` + `#top-audio-player-bar`), honest `NotAllowedError` rejection, Polls (retract + close + closed-poll immutability) / Quizzes / Todos, truthful `0`-balance Wallet & payment-gated Stars/VIP (`400`/`402`/`403`) |
| **A07** | `a07-inspector-settings-admin-calls-secret.spec.ts` | F2, F12, F13 | 6 | 6 | Strict Right Inspector Bot vs Group vs 1v1 User separation, Group/Channel creation + invite links + `#right-tab-stats`, non-admin Channel `403` RBAC & hidden subscriber composer, invalid `@username` `400`, wired Settings (Stickers/Devices anti-`127.0.0.1`/Magpie/Shortcuts/Toggles), JSON/HTML export, WebRTC Video Calls (fake media device + honest denied error + 4-emoji fingerprint), E2EE Secret Chat TTL + contracted `/api/v1/e2ee/prekeys` Ed25519 SPK (`401`/`400`/`200`) + browser WebCrypto `AES-256-GCM` tampered-ciphertext & tag `OperationError` rejection |
| **A08** | `a08-split-key-v2-vault-device-sync.spec.ts` | F3 | 6 | 6 | `GET /api/v1/auth/kdf-params` (deterministic anti-enumeration fake salt), Split-Key V2 register/login/upgrade/rotation (`401 invalid_credentials`, `409 already_upgraded`), E2EE Vault 60-byte wrapped root key envelope & revisioned items (`409 revision_conflict`, `400` `..`/category/KDF validation), X25519 Device Trust Ring (`NNN-NNN`, 48B sealed root key + 12B nonce, atomic `"consumed"` wipe, cross-user `403` status/approve/deny), `#vault-settings-panel` |
| **A09** | `a09-ai-provider-isolation-magpie-models.spec.ts` | F5 | 6 | 6 | Truthful zero-provider Magpie state, per-user ChaCha20-Poly1305 provider CRUD (`provider_id` + `api_mode`) + secret redaction + tenant read/patch/probe/delete isolation, canonical `ClientSubscriptionSyncItem` sync, live `models.dev` catalog, PII masking preview, truthful `503 provider_not_configured` + inline `PROVIDER_ERROR` CTA, authenticated `401` on `/v1/*` & `/api/v1/magpie/v1/*`, SSE anti-`[DONE]` on error, unreachable probe `ok: false` + error string, composer `#btn-ai-compose` truthful error toast |
| **A10** | `a10-fabushi-hermes-grok-multiagent.spec.ts` | F6, F13 | 6 | 6 | Canonical `/api/v1/fabushi/*` (sessions, memory, skills, approvals, cron) & `/api/v1/fabushi-bots` CRUD cleanly separated from `/api/v1/fabushi-miniapp/*`, Grok `#bot-prestart-bar` + external `MenuButton` outside `#cmp-input-wrap`, inline `#apple-compose-stage` 1-recipient DM carry-draft & 2+ auto-titled group, `group:<chat_id>` vs 1:1 DM isolation, Multi-Agent `SharedGroupWorkspace` (`group_workspace_write`/`read` via ephemeral OpenAI stub + WS `AgentFloorChanged`/`AgentWorkspaceUpdated` + stale revision conflict), Stage 2 `[PASS]`/`NO_REPLY` suppression + 5-hop `LoopBudget`, anti-stub slash commands & zero-provider cron `503` |
| **A11** | `a11-coding-agent-bots.spec.ts` | F7 | 6 | 6 | Coding Agent Bot CRUD across all 6 `CodingProviderKind` values, canonical wrapped `{ type: 'CodingHostEvent', payload }` (`host_register`, `probe_result` w/ `req_id`, `DetectedCodingProviderDto` `kind`/`binary_path`), `POST /api/v1/coding-agents/probe` (`200` online / `503` offline & post-disconnect), server-issued `StartTurn` `turn_id` streaming turns, inline `coding:approve:...` (`{ message_id: 0 }`) + group owner-only `403` guard + auto-expiry on `turn_completed`, mode callbacks, verified slash command replies & `/stop` `cancel_turn` |
| **A12** | `a12-miniapps-webmcp-wasm-pip.spec.ts` | F8 | 6 | 6 | Decoupled `/api/v1/miniapps/*` catalog/install/launch, fresh `v1.6.11` `fabushi_miniapp.wasm` (`\0asm`, `837,676 B`, SHA-256 `a074f76c...`) & 3D `<canvas>`, `/js/telegram-web-app.js` zero-fake empty `initData` + `themeParams`/`MainButton` + HMAC `validate-init-data` (`401` tamper) + honest `CloudStorage` (`500` error callback), `navigator.modelContext` (6 methods) + `window.__GPUI_WEBMCP__.discover()`/`readState()`/`invoke()` (6 built-in DOM + 6 Fabushi tools) + 2-WS-client `MiniAppTakeoverState` → `MiniAppControlStatus` broadcast, floating `#miniapp-pip-overlay` restore-in-place sentinel, `CreateMiniAppRequest` unsafe `web_url` & untrusted `postMessage`, WASM 404 `boot_error`, blocked bot `403` |
| **A13** | `a13-remote-assist-computer-killswitch.spec.ts` | F9, F12 | 6 | 6 | UU-Parity Remote Assist 9-digit `assist_id`, `reset-code`/`set-code` (`400` weak code), `allow` toggle disconnecting guests, cross-account `start` (`404`/`403`/`401`/`429` rate limit), Emergency Kill Switch `disconnect-all` with verified un-clamped real latency (`>= 15ms`, never `9.9ms`), local computer register/poll/`commands/:id/complete` + WebRTC signaling, truthful empty `#computer-workbench` & anti-fake Tailnet |
| **A14** | `a14-official-oauth21-mcp-server.spec.ts` | F10, F12 | 6 | 6 | RFC 9728/8414/OpenID `/.well-known/*` discovery, RFC 7591 DCR + redirect/CIMD SSRF `400` checks, cookie-isolated PKCE S256 consent/token (`MCP_SUPPORTED_SCOPES` canonical scopes, wrong `code_verifier` `400 invalid_grant`, refresh-rotation & replay block, revoke), Streamable HTTP `/mcp` (`2025-11-25`, 31+ tools, unsupported version `400`, `401 WWW-Authenticate`, `403 insufficient_scope`, cross-user session block, unknown tool JSON-RPC error), Grants & Audit API + `#oauth-mcp-grants-panel`, zero fabricated `mcp_filesystem` stubs |
| **A15** | `a15-browser-automation-distillation-appstore.spec.ts` | F11, F12 | 6 | 6 | `v1.6.11` `#browser-workspace` 4-tab inspector (`Copilot`, `Recorder`, `Session`, `App Store`) with truthful `0` targets & clean URL input, persisted desktop pairing + awaited un-clamped revoke (`>= 15ms`, never `9.9ms`), real Chromium CDP session (non-SVG visual frame + semantic DOM + `BrowserControlMode`), Script Distillation (`POST /api/v1/browser/scripts/distill` w/ canonical `RecordedBrowserAction` & `ScriptParameter.is_secret`), Automation App Store publish/search/idempotent install/run (`used_llm: false`), recursive **`422 secret_leak_detected`** (API key/Bearer/unknown field/password), reserved `app_id` `400`, unpublished `404`, `author_id` spoof & non-owner `403`, duplicate version `409` |
| **A16** | `a16-talk-tasks-protocol-updates-proxy.spec.ts` | F1, F4, F12, F14 | 5 | 5 | `GET /health` `"OK"`, `GET /api/v1/status` (`v1.6.11` capabilities + CORS exposed MCP headers), truthful Talk Mode (no simulated text/echo), truthful Task Center (`0%` initial & patched progress, empty logs, UI create), auto-update relay + strict `400` allowlist/traversal rejection, unknown callback anti-stub (`{ message_id: 0 }`), removed fake SVG GIF route, 8-destination `#nav-rail` traversal |
| **Total T1/T2** | **16 Tier 1 + 16 Tier 2 files** | **100% of F1–F14** | **95** | **95** | — |

---

## 3. Harness Architecture & Browser Auto-Detection

### 3.1 Directory Layout (`e2e/`)
```text
e2e/
├── .gitignore
├── package.json                # fabushi-web-e2e v1.6.11 (isolated @playwright/test + typescript)
├── package-lock.json
├── tsconfig.json               # strict: true, zero imports outside e2e/
├── playwright.config.ts        # Dynamic repo root, E2E_TMP_DIR isolation, auto-detected Chromium, workers=1 default
├── scripts/
│   └── verify-fail-closed.mjs  # 5-step AST anti-vacuity + helper/media + Chromium + 4-tier dummy server probe
├── helpers/
│   ├── index.ts                # Barrel export
│   ├── selectors.ts            # Canonical v1.6.11 DOM IDs, UPPER_SNAKE_CASE constants & API_PATHS
│   ├── server.ts               # Browser auto-detect, proxy-safe getBaseUrl, clean reset, u64 client_nonce, real API fixtures
│   ├── ui.ts                   # registerAndLoginUser, CJK IME FSM, assertNoPurpleOnDark, ensureDarkThemeAndAssertNoPurple
│   ├── fixtures.ts             # resetServerHook, emptyAuthPage, authPage, authSession, openSecondTab, openSecondUserContext
│   ├── media.ts                # Pure in-memory PNG, RIFF WAV, %PDF-1.4, UTF-8 text & corrupt builders
│   └── api.ts                  # Split-Key V2, X25519, 60B/48B vault wraps, cookie-isolated OAuth/PKCE, MCP, CodingHost, WebMCP, AutomationApp & OpenAI stub
├── tier1/                      # 16 files, 95 Feature Coverage tests (a01..a16)
├── tier2/                      # 16 files, 95 Boundary, Corner & Negative tests (a01..a16)
├── tier3/                      #  6 files, 18 Cross-Feature Pairwise tests (pw01..pw06)
└── tier4/                      #  8 files,  8 Real-World End-to-End Workflows (sc01..sc08)
```

### 3.2 Browser Auto-Detection & Launch Contract (`resolveChromiumExecutablePath`)
Shared by both `e2e/playwright.config.ts` and `e2e/scripts/verify-fail-closed.mjs`:
1. `process.env.PLAYWRIGHT_CHROME_PATH` (if explicitly set: validates executable file or throws fail-closed).
2. Playwright bundled `chromium.executablePath()` (if executable exists: returns `undefined` so Playwright uses its managed binary).
3. System browser fallback: `/usr/bin/google-chrome` → `/usr/bin/chromium` → `/usr/bin/chromium-browser`.
4. Resilient cache scan: `${PLAYWRIGHT_BROWSERS_PATH || '/opt/ms-playwright'}/chromium-*/{chrome-linux64,chrome-linux}/chrome` (descending revision).
5. Fail-closed descriptive error if none exist.

- **Launch Args**: `['--no-sandbox', '--disable-setuid-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']`.
- **Concurrency**: `workers: process.env.PLAYWRIGHT_WORKERS ? Number(process.env.PLAYWRIGHT_WORKERS) : 1` (safe for 2-vCPU VM).
- **WebServer**: When `E2E_BASE_URL` is unset, starts `npm start` from dynamically resolved `REPO_ROOT` with `PORT=4173`, `HOST=127.0.0.1`, `ENABLE_TEST_RESET=1`, `DATA_DIR=<E2E_ROOT>/.e2e-data`, polling `http://127.0.0.1:4173/api/v1/health`.

---

## 4. Tier 3 Pairwise Matrix (`e2e/tier3/`, 18 Tests)

- **`pw01-sync-ui-messaging.spec.ts`**: `PW-01` (multi-tab BroadcastChannel live sync of send/edit/hover reaction/Apple Dark theme + unconditional anti-purple on both tabs), `PW-02` (custom folder + 3×3 pinned grid + CJK search), `PW-03` (Forum Topic isolation + pin + reply + topic-scoped search).
- **`pw02-media-voice-inspector-mobile.spec.ts`**: `PW-04` (media editor album + lightbox + per-chat `#right-tab-media` isolation), `PW-05` (fake-device voice note + `1.5x`/`2x` speed + persistent `#top-audio-player-bar` + in-chat search), `PW-06` (mobile `390×844` stack + CJK IME + right inspector).
- **`pw03-auth-vault-ai-isolation.spec.ts`**: `PW-07` (Split-Key V2 + E2EE Vault + Passcode Lock + reload persistence), `PW-08` (multi-tenant isolation across Vault + encrypted AI provider + Device Sync), `PW-09` (Settings → Magpie → PII masking → Hermes `503` + structured `PROVIDER_ERROR` card CTA loop).
- **`pw04-grok-multiagent-coding-bots.spec.ts`**: `PW-10` (Grok `#apple-compose-stage` multi-select 2 bots + `group_workspace_write` WS `AgentWorkspaceUpdated` sync), `PW-11` (Bot `#bot-prestart-bar` → `/start` → external `MenuButton` outside `#cmp-input-wrap` → Bot Inspector separation), `PW-12` (Coding Agent Bot in group chat with server `StartTurn` + owner approval vs non-owner `403`).
- **`pw05-miniapps-webmcp-oauth-remote.spec.ts`**: `PW-13` (`fabushi-globe` WASM `\0asm` + CloudStorage readback + `send-data` → Forward into Forum Group verified at target), `PW-14` (`fabushi-globe` minimized to `#miniapp-pip-overlay` + WS `MiniAppTakeoverState`→`MiniAppControlStatus` + restore-in-place sentinel), `PW-15` (Official OAuth 2.1 MCP canonical scopes + UU Remote Assist + Emergency Kill Switch terminating BOTH, `401`/`404`/`410`).
- **`pw06-browser-appstore-calls-channel.spec.ts`**: `PW-16` (Script Distillation + `422 secret_leak_detected` + Vault binding + App Store publish `content_sha256` & zero-LLM replay), `PW-17` (minimized Video Call `#top-call-bar` + unconditional dark theme anti-purple + E2EE Secret Chat), `PW-18` (offline idempotent queue + file upload + Broadcast Channel JSON & HTML export).

---

## 5. Tier 4 Real-World Application Scenarios (`e2e/tier4/`, 8 Scenarios)

1. **`sc01-onboarding-zero-fake-data-apple-muse.spec.ts`**: Truthful onboarding, zero demo controls, empty workspace, 2FA + Passcode Lock, unconditional Apple Dark zero-purple, CJK IME, hover reaction, reply, fake-mic voice note & reload unlock.
2. **`sc02-vault-v2-x25519-device-sync.spec.ts`**: V1 → Split-Key V2 upgrade, raw-password `401`, anti-enumeration fake salt, 60B Vault envelope/items + `409 revision_conflict`, X25519 two-device trust ring atomic one-time read, `#vault-settings-panel`.
3. **`sc03-grok-multiagent-coding-bot.spec.ts`**: Standard + `claude_code` Fabushi Bots, `#bot-prestart-bar`, `#apple-compose-stage` group creation, `503 provider_not_configured` proof, isolated Magpie provider, WS Coding Host probe/server `StartTurn`/stream/approval + contracted `SharedGroupWorkspace` WS update.
4. **`sc04-fabushi-globe-wasm-webmcp-pip.spec.ts`**: SDK zero-fake `initData` verification, fresh `v1.6.11` `837,676 B` WASM SHA-256 check, authenticated HMAC launch (`MiniAppInitDataDto`), `navigator.modelContext` + `window.__GPUI_WEBMCP__.discover()`, floating `#miniapp-pip-overlay` + WS `MiniAppControlStatus` + restore-in-place sentinel, CloudStorage readback & `send-data` card.
5. **`sc05-oauth21-mcp-remote-assist-killswitch.spec.ts`**: RFC discovery, SSRF redirect `400`, PKCE S256 OAuth consent/token with canonical scopes, `401`/`403 insufficient_scope` MCP checks, Streamable HTTP `/mcp` (`2025-11-25`) + concurrent UU Remote Assist 9-digit session, Emergency Kill Switch terminating both (`401`/`404`/`410`), audit & non-empty grant revocation.
6. **`sc06-browser-automation-distill-appstore.spec.ts`**: `#browser-workspace` 4-tab inspector (`0` targets), desktop pairing (`control_token` verified), `422 secret_leak_detected` gate, Script Distillation, clean App Store publish (`201` + 64-hex `content_sha256`), User B idempotent install + zero-LLM run + race-free pairing revoke.
7. **`sc07-offline-multitab-forum-search-export.spec.ts`**: Multi-tab `BroadcastChannel`, Forum Supergroup Topic + Mosaic album + fenced code + Poll, offline commuter queue across 2 chats, reconnect Tab 2 live sync + Tab 1 idempotent flush, CJK search, JSON & HTML transcript exports.
8. **`sc08-webrtc-calls-secret-chat-broadcast-channel.spec.ts`**: 1-on-1 WebRTC Video Call (`#top-call-bar`), WebCrypto E2EE Secret Chat (`SubtleCrypto` observer), Broadcast Channel non-admin `403` RBAC, owner Mosaic album & `#right-tab-stats`.

---

## 6. Suite Totals & Verification Commands

| Tier | Directory | Spec Files | Test Count |
|---|---|---:|---:|
| **Tier 1 — Feature Coverage** | `e2e/tier1/` | 16 | **95** (`>= 5` per `A01`–`A16`) |
| **Tier 2 — Boundary & Negative** | `e2e/tier2/` | 16 | **95** (`>= 5` per `A01`–`A16`) |
| **Tier 3 — Cross-Feature Pairwise** | `e2e/tier3/` | 6 | **18** (`>= 16`) |
| **Tier 4 — Real-World Scenarios** | `e2e/tier4/` | 8 | **8** (`>= 8`) |
| **Total Opaque-Box Suite** | **`e2e/`** | **46** | **216** |

### Pre-`TEST_READY.md` Verification Commands (Run Sequentially)
```bash
# 1. Strict TypeScript check (expect exit 0)
npm --prefix e2e run typecheck

# 2. Playwright test discovery (expect exit 0, 216 tests across tiers 1-4)
npm --prefix e2e run test:list
# Or directly from repo root:
npx --prefix e2e playwright test -c e2e/playwright.config.ts --list

# 3. 5-step AST anti-vacuity + helper/media + real Chromium + 4-tier fail-closed proof (expect exit 0)
npm --prefix e2e run verify:fail-closed
```
