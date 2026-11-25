# Project: Fabushi Web (`fabushiweb/fabushi-web`) — v1.6.11 Desktop Parity & Zero Fake Data

## Overview
Full-featured TypeScript full-stack web edition aligned **100% with desktop [`bhrumom/gpui-telegram`](https://github.com/bhrumom/gpui-telegram) `v1.6.11`** (`cc56925f887be8f177642da9cd119d29108ddba0`), with **ZERO fake, mock, demo, sandbox, fabricated, or fudged data** in production runtime code (`packages/`, `apps/`, `public/miniapps/`, `scripts/`).

Every unauthenticated, empty-workspace, zero-provider, offline, and error state behaves truthfully and faithfully to desktop `Fabushi v1.6.11`, backed by real SQLite WAL persistence, real WebSocket `/api/v1/ws` + monotonic `pts` sync, real cryptographic authentication & E2EE vaulting, real upstream/self-hosted integration, fresh `v1.6.11` Fabushi 3D WASM + WebMCP Mini Apps, Apple Messages macOS & Muse UI/UX, Grok Bot Multi-Agent protocol, Third-Party Coding Agent Bots, Official OAuth 2.1 Remote MCP (`/mcp`), UU-Parity Remote Assist, and Built-in Interactive Browser + AI Automation + Script Distillation + Automation Script App Store.

---

## Authoritative Survey & Specification Artifacts (Read-Only Reference)
- Original Request: `/home/antigravity/fabushiweb/fabushi-web/.agents/teamwork/ORIGINAL_REQUEST.md`
- Upstream Reference Clone (`v1.6.11`, `cc56925f`): `/home/antigravity/.gemini/jetski/scratch/teamwork_tmp/f9ea8a9d36067d23ad92bf829c494261/gpui-telegram-ref`
- Prep Handoff & Upstream Releases:
  - `/home/antigravity/fabushiweb/fabushi-web/.agents/teamwork/worker_env_prep/handoff.md`
  - `/home/antigravity/fabushiweb/fabushi-web/.agents/teamwork/worker_env_prep/upstream_releases.md`
- Backend / Protocol / CI / Fake-Data Audit (18 prod fake paths, 6 P0/P1 security bugs, 5 deploy bugs, 10 upstream pillars):
  - `/home/antigravity/fabushiweb/fabushi-web/.agents/teamwork/explorer_survey_backend/handoff.md`
- Frontend / MiniApps / E2E / Fake-Data Audit (20 fake/fudged/unwired defects, stale WASM/WebMCP, E2E config bugs):
  - `/home/antigravity/fabushiweb/fabushi-web/.agents/teamwork/explorer_survey_frontend/handoff.md`
- Upstream Desktop `v1.3.0 → v1.6.11` Master Specification & 6 Domain Specs:
  - `/home/antigravity/fabushiweb/fabushi-web/.agents/teamwork/spec_miner_upstream/handoff.md`
  - `/home/antigravity/fabushiweb/fabushi-web/.agents/teamwork/spec_miner_upstream/spec_01_protocol_server_vault_ai.md`
  - `/home/antigravity/fabushiweb/fabushi-web/.agents/teamwork/spec_miner_upstream/spec_02_uiux_apple_muse_branding.md`
  - `/home/antigravity/fabushiweb/fabushi-web/.agents/teamwork/spec_miner_upstream/spec_03_grok_multiagent_coding_bots.md`
  - `/home/antigravity/fabushiweb/fabushi-web/.agents/teamwork/spec_miner_upstream/spec_04_miniapps_webmcp_wasm.md`
  - `/home/antigravity/fabushiweb/fabushi-web/.agents/teamwork/spec_miner_upstream/spec_05_remote_oauth_mcp_cli.md`
  - `/home/antigravity/fabushiweb/fabushi-web/.agents/teamwork/spec_miner_upstream/spec_06_browser_automation_appstore.md`

---

## Architecture

### 1. Monorepo & Hexagonal Full-Stack Topology (`v1.6.11`)
- **Repository Root**: `/home/antigravity/fabushiweb/fabushi-web` (GitHub: `fabushiweb/fabushi-web`; Node.js `>=22.13.0`, TypeScript `5.8+` strict mode, npm workspaces).
- **Three Production Layers (ZERO fake/sandbox runtime adapters)**:
  1. **`packages/protocol` (`@gpui-telegram/protocol` v1.6.11)**:
     - Pure TypeScript shared domain models, wire DTOs, UTF-16 `MessageEntity` & Markdown parser/serializer, 3-state CJK `ImeSafetyFsm`, 100-bar 5-bit voice waveform codec, WebCrypto E2EE helpers, ISO-18004 QR SVG encoder, `WsClientFrame` / `WsServerFrame` (`PtsPush`/`Ack` + backward-compatible `PtsUpdate`/`SendAck`), `DOM_IDS`, `TelegramClientPort`.
     - New `v1.4.0`–`v1.6.11` contract modules: `userVault.ts` (Split-Key V2 + E2EE Vault + X25519 Device Trust Ring), `automationApps.ts` (Script Distillation & Automation App Store + BrowserControlMode), `codingAgents.ts` (6 coding agent providers + WS host protocol), `remoteControl.ts` (UU-Parity Remote Assist + extended `RemoteComputerOp`), `miniAppWebMcp.ts` (WebMCP `navigator.modelContext` + Grok 8-shape/11-color deterministic avatar hash + decoupled MiniApp contracts), `officialMcp.ts` (OAuth 2.1 + MCP `2025-11-25` Streamable HTTP/SSE).
  2. **`apps/server` (`@gpui-telegram/server` v1.6.11)**:
     - Node HTTP/REST + WebSocket + SSE + SQLite WAL (`node:sqlite`) backend with **zero fake seed universe**, **zero demo auth endpoints**, **zero fabricated AI/MCP/Computer/Tailnet/Talk/OG/SVG stubs**, and full reverse-proxy compatibility with Rust `gpui_telegram_server` (`UPSTREAM_SERVER_URL`).
     - Truthful clean-start behavior: new accounts start with `chats: []`, `is_premium: false`, `0` fake contacts/messages/stories/wallet grants/AI providers. `ENABLE_TEST_RESET=1` ONLY wipes SQLite tables cleanly for isolated test runs — it NEVER seeds fake Alice/Bob universes.
     - Security-hardened: real WebAuthn COSE signature verification, Cloud 2FA enforced across Phone/Password/Email, Split-Key V2 Argon2id/HKDF verifier + anti-enumeration fake salt, per-user ChaCha20-Poly1305 encrypted AI provider vault (HKDF + AAD), channel read/write RBAC, authenticated `/v1/chat/completions`, verified payment/redeem gating for Stars/VIP, SSRF-hardened OpenGraph & OAuth CIMD, and recursive `422 secret_leak_detected` scanner on Automation Script App Store.
  3. **`apps/web` (`@gpui-telegram/web` v1.6.11 — Fabushi Web)**:
     - Vite + React 19 + Zustand 5 + `@tanstack/react-virtual` + 100% Vanilla CSS (strictly zero TailwindCSS, zero purple-on-dark).
     - **Single real runtime transport (`HttpWsServerAdapter`)**: `LocalSandboxAdapter` and fake `MtprotoAdapter` are completely purged from production runtime. Unauthenticated / disconnected / static GitHub Pages users see a truthful Server Connection & Auth screen (defaulting to configurable backend URL, e.g. `https://web.ombhrum.com` on static hosts or same-origin on self-hosted) with zero fake data.
     - **Apple Messages macOS & Muse UI/UX Redesign (`v1.6.0`–`v1.6.10`)** + **Grok Bot Multi-Agent & Multi-Select Compose (`v1.6.7`–`v1.6.10`)** + **Fresh `v1.6.11` Fabushi 3D WASM (`837,676 B`, `a074f76c...`) & `hosted_bundle.html` (`49,099 B`) + WebMCP `navigator.modelContext` + In-Place PiP** + **Split-Key V2 Vault & X25519 Device Trust Ring** + **UU-Parity Remote Assist** + **Official OAuth 2.1 Remote MCP** + **Coding Agent Bots** + **Built-in Interactive Browser & Automation App Store (`v1.6.11`)**.

### 2. Zero Fake Data Invariants (Non-Negotiable Across All Milestones)
1. **Zero Demo/Sandbox Backends or Auth Bypasses**: No `LocalSandboxAdapter`, no fake `MtprotoAdapter`, no `#btn-demo-login`, no `#btn-simulate-qr-scan`, no `?dev=1`/`?mode=sandbox` production bypass, no `/api/v1/auth/demo` or `/api/v1/auth/sandbox`, no pre-seeded fake users/chats/stories/messages/wallet grants (`Alice`, `Bob`, `Lin Wei`, `Sara`, `1001`, `chat_id = 106`, `sandbox:default`).
2. **Zero Fabricated Content or Responses**: No `synthesizeWebPagePreview()` / `synthesizeWebPageFromUrl()`, no fake `[Magpie ...]` echo or `local_hermes`/`hermes-local-v1` provider, no fabricated `memory_lookup` SSE events, no `"Executed /cmd"` slash-command stubs, no fake `DEFAULT_MCP_TOOLS` or `"Executed MCP tool"` stubs, no fake Talk `"Heard ..."` echo or `"输入模拟语音文本"`, no fake SVG `ComputerWorkbench` or `drawLiveSessionCanvas()`, no fake Tailnet `100.64.0.1` mesh, no silent fake `HttpDomFallbackDriver` SVG browser screenshots, no fake `Alice Chen` `initData` in `telegram-web-app.js`, no fake group-call speakers, no fake document download text, no silent fake WAV/canvas/WebRTC media synthesis when real devices fail.
3. **Zero Fudged Metrics or Unwired Controls**: No `Math.min(9.9, ...)` latency clamping, no `Math.max(1, ...)` target-count inflation, no `25%` fake progress floor, no always-online hardcoded badges, no fake `'127.0.0.1'` fallback IPs, no dead Settings toggles or zero-listener custom events.
4. **Truthful Empty, Unauthenticated, Zero-Provider & Error States**:
   - Empty authenticated account → `chats: []`, `"All"` count `0`, no selected chat, truthful empty state prompts.
   - Zero configured AI providers → `503 { error: "provider_not_configured", needs_provider_selection: true, action: "hermes:open_ai_providers" }` + structured inline `PROVIDER_ERROR` card (SSE NEVER emits `data: [DONE]` on error).
   - Missing remote desktop host / coding host / Chromium CDP / microphone permission → honest `503` / permission error state with remediation guidance.

---

## Feature Inventory

Every feature from `ORIGINAL_REQUEST.md`, `explorer_survey_backend`, `explorer_survey_frontend`, and `spec_miner_upstream` (`v1.3.0` → `v1.6.11`) is explicitly mapped to a milestone (ZERO unassigned):

| # | Feature | Description | Milestone | Source |
|---|---|---|---|---|
| F1 | **Protocol v1.6.11 Schemas, Versioning & CI/Deploy/Proxy/Env Wiring** | Bump all workspace packages to `1.6.11`; add TS protocol contracts for Split-Key V2 Vault & X25519, Automation Script App Store, Coding Agent Bots, UU-Parity Remote Assist, WebMCP & Grok Multi-Agent, Official OAuth 2.1 MCP, WS `PtsPush`/`Ack`; fix `SESSION_SECRET`/`OMBHRUM_API_URL`/`AI_GATEWAY_URL`/`TURN_SECRET` env wiring + URL `/v1` normalization; fix `VITE_BASE_PATH=/fabushi-web/` in `ci-deploy.yml` & `deploy-gh-pages.mjs`; fix `proxy.ts` (`/.well-known/*`, `/oauth/*`, `/mcp`, `/miniapps/*`, `/bot<token>/*`, remove local WASM hijack) & `nginx.ombhrum.conf` (`/api/v1/tailnet/derp` + MCP headers). | M1, M6 | backend_audit, upstream_spec |
| F2 | **Core Server Zero-Fake-Data Purge & P0/P1 Security Hardening** | Remove `seedDeterministicUniverse()` fake data & `/auth/demo` / `/auth/sandbox` & `F1`/`F16`/`F17`/`D2`/`D4`; real WebAuthn COSE signature verification; Cloud 2FA on Email OTP; remove `/auth/alipay/confirm` hijack; real `DELETE /api/v1/account` WS disconnect + data purge; fix channel read/write RBAC; real SSRF-guarded OpenGraph fetch (no fabricated Instant View); real `TURN_SECRET` signing; `is_premium = false` default. | M2, M6 | backend_audit, upstream_spec |
| F3 | **Split-Key V2 Zero-Knowledge Auth, E2EE User Vault & X25519 Device Trust Ring** | `GET /api/v1/auth/kdf-params` (HMAC anti-enumeration fake salt), Split-Key V2 register/login/upgrade/change-password; `GET/PUT /api/v1/user-vault/envelope`, revisioned `items/{category}/{item_key}` (`409` concurrency, size/key validation); X25519 `device-sync/{request,pending,:id/approve,:id/deny,:id/status}` (6-digit `NNN-NNN`, atomic one-time read → `consumed`, 10m TTL); WebCrypto client + Settings UI. | M1, M2, M4, M5, M6 | upstream_spec (spec_01) |
| F4 | **Core Messaging v1.6.11 Parity, WS `PtsPush`/`Ack`, Local Timestamps & Update Relay** | `CreateChatRequest.client_nonce` idempotency + CJK/Latin auto-title; `skip_server_bot_reply` + `POST .../archive-local-bot-reply`; `GET /api/v1/status` (`v1.6.11` capabilities) + `/api/v1/updates/{latest-mac.json, assets/:tag/:file}`; WS `PtsPush`/`Ack` wire parity + new Multi-Agent/WebMCP/Coding events; strict session/generation fencing (`SessionRequestFence`); local-timezone (`HH:MM`) timestamps everywhere. | M1, M2, M4, M6 | backend_audit, upstream_spec (spec_01, spec_02) |
| F5 | **Per-User ChaCha20-Poly1305 AI Provider Isolation, Live `models.dev` Catalog & Magpie v1.6** | Eliminate `local_hermes` fake provider, fake echoes, unauthenticated `userId=1001` fallback, fake subscription scans; enforce `requireAuth`; per-user HKDF + ChaCha20-Poly1305 encrypted provider vault (`enc:v1:<b64>`, AAD binding, redacted reads); live 2-tier `models.dev` catalog (6h cache) + `POST /subscriptions/sync`; `/api/v1/magpie/v1/{models, chat/completions, responses, messages}`; Gemini parallel `functionResponses` + `thoughtSignature` & Vertex schema sanitization; truthful `503 provider_not_configured` (no `data: [DONE]` on error). | M1, M3, M5, M6 | backend_audit, frontend_audit, upstream_spec (spec_01) |
| F6 | **Unified Hermes-into-Fabushi Runtime (`/api/v1/fabushi/*`) & Multi-Agent Group Protocol** | Canonical `/api/v1/fabushi/*` + `/api/v1/fabushi-bots` CRUD (resolving namespace clash with `/api/v1/fabushi-miniapp/*`); eliminate hardcoded `chat_id = 106`, fake `memory_lookup`, slash stubs, fake cron insert; real slash commands, sessions/search/compress/undo, approvals, real LLM cron runner; Multi-Agent Group Protocol (`FloorControlQueue`, 5-hop `LoopBudget`, 2-stage `reply_gate`, `SharedGroupWorkspace`, Ed25519 `ScopedCapabilityToken`, WS events). | M1, M3, M5, M6 | backend_audit, frontend_audit, upstream_spec (spec_03) |
| F7 | **Third-Party Coding Agents as Native Bots (`gpui_telegram_coding` Parity)** | 6 providers (`claude_code`, `codex`, `open_code`, `cursor_cli`, `antigravity`, `acp_custom`), `POST /api/v1/coding-agents/probe` (real PATH probe), `BotRegistryEntry.coding_agent`, WS `CodingHostCommand`/`CodingHostEvent` broker, 13 slash commands, 3 permission modes, interactive inline approval cards with auto-expiry, owner-only guard, and frontend Bot/Approval UX. | M1, M3, M5, M6 | backend_audit, upstream_spec (spec_03) |
| F8 | **Decoupled External Mini Apps, WebMCP (`navigator.modelContext`), PiP Restore-in-Place & Fresh `v1.6.11` Fabushi 3D WASM** | Sync fresh `fabushi_miniapp.wasm` (`837,676 B`, `a074f76c...`) & `hosted_bundle.html` (`49,099 B`) with relative `../../js/telegram-web-app.js` subpath fix; rewrite `telegram-web-app.js` (purge fake `Alice Chen` `initData` & false-success catches, origin-checked `postMessage`, `api_base` support, full `navigator.modelContext` WebMCP shim); WS WebMCP relay + anti-hallucination error warning; decoupled `/miniapps/*` & `/bots/*` routes; live floating PiP streaming & restore-in-place without unmounting WASM; gate VIP behind verified payment/redeem. | M1, M3, M4, M6 | backend_audit, frontend_audit, upstream_spec (spec_04) |
| F9 | **UU-Parity Remote Assist, Real Remote Computer Control & Emergency Kill Switch** | Purge fake SVG `ComputerWorkbench`, fake `drawLiveSessionCanvas()`, fudged `Math.min(9.9, ...)` latency, fake Tailnet `100.64.0.1`; implement `/api/v1/remote/assist/{info,reset-code,set-code,allow,start}`, `/api/v1/remote/sessions{,/disconnect,/disconnect-all}`, `/api/v1/remote/webrtc/signal`, `/api/v1/computers/local/{register,poll}`, `/api/v1/computers/commands/:id/complete`, extended `RemoteComputerOp`, real remote frame rendering / honest disconnected state, `"本机被控中"` banner, and un-clamped emergency kill switch. | M1, M3, M5, M6 | backend_audit, frontend_audit, upstream_spec (spec_05) |
| F10 | **Official OAuth 2.1 Remote MCP Server (`/mcp`, Streamable HTTP + SSE, PKCE, Grants/Audit)** | Purge fake `DEFAULT_MCP_TOOLS` (`mcp_filesystem`) & `"Executed MCP tool"` stubs; implement RFC 9728/8414/7591 `/.well-known/*`, `/oauth/{register,authorize,authorize/login,authorize/qr-poll,authorize/approve,token,revoke}` (mandatory PKCE S256, SSRF-hardened redirect/CIMD, rotating refresh token families), `/api/v1/mcp/{grants,grants/:id,audit}`, `POST/GET/DELETE /mcp` (`2025-11-25`, real server-backed tools & resources, `401 WWW-Authenticate` / `403 insufficient_scope`), and frontend MCP Grants/Audit + risk-policy UI. | M1, M3, M5, M6 | backend_audit, frontend_audit, upstream_spec (spec_05) |
| F11 | **Built-in Interactive Browser (`NavDestination::Browser`), AI Automation, Script Distillation & Automation Script App Store (`v1.6.11`)** | Purge silent fake `HttpDomFallbackDriver` SVG screenshots, `Math.min(9.9, ...)` revoke clamp, `Math.max(1, ...)` target inflation, wireframe screenshots, and test HTML defaults; SQLite-persisted pairing tokens/grants/audit; real Chromium CDP + 11 `browser_*` tools + `BrowserControlMode` takeover banner; **Script Distillation** (`ScriptCompiler` → `AutomationScriptApp` w/ 10 `ScriptStep` kinds & `SemanticLocator`, zero-LLM deterministic replay); **Automation App Store** REST API (`/api/v1/automation-apps*`) with recursive **`422 secret_leak_detected`** scanner + 4-tab Browser Inspector (`Copilot`, `Recorder`, `Session`, `App Store`). | M1, M3, M4, M5, M6 | backend_audit, frontend_audit, upstream_spec (spec_06) |
| F12 | **Frontend Total Fake-Data Purge & Broken Control Repair** | Delete `LocalSandboxAdapter` & fake `MtprotoAdapter` from production bundle; remove `?dev=1`/`?mode=sandbox` bypass, `#btn-demo-login`, `#btn-simulate-qr-scan`, dev OTP hints, raw `http://34.46.77.133:8080`; purge `synthesizeWebPageFromUrl`, fake group-call speakers, silent fake WAV/canvas/WebRTC media fallbacks, fake doc download text & SVG posters, fake AI compose fallback, fake 25% task progress, fake Talk `"输入模拟语音文本"` (replace with real WebAudio mic/TTS or honest error), unverified Wallet minting; wire Settings→Magpie, shortcuts, 5 dead toggles, server Passkeys, truthful empty stickers/IPs. | M4, M5, M6 | frontend_audit |
| F13 | **Apple Messages macOS & Muse UI/UX Redesign (`v1.6.0`–`v1.6.10`) + Grok Bot Interaction Spec & `Fabushi v1.6.11` Branding** | Exact `Night`/`Tinted`/`Day`/`Classic` hex palettes (zero dark drop shadows, 12% top specular highlight, zero purple-on-dark, 180° vertical blue outgoing gradient, 9-hue bot tinting); centered `76px` translucent Apple Messages contact header; compact pill bubbles + non-shifting local-TZ hover timestamps; `288px` collapsible sidebar + Apple 3×3 Pinned Chats Grid (`#sidebar-pinned-chats-grid`) w/ flicker-free sync; Apple Capsule Composer (`max-w 740px`) + external `MenuButton` + 2-layer non-overlapping toast; Grok pre-start `START` bar, inline `+` multi-select compose (`#apple-compose-stage`), 8-shape/11-color avatars, Inspector profile separation; full **`Fabushi Web v1.6.11`** (`法布施网页版`) branding + `sw.js` `fabushi-web-v4` + updated `README.md`. | M4, M5, M6 | frontend_audit, upstream_spec (spec_02, spec_03) |
| F14 | **Opaque-Box E2E Suite Modernization (Tiers 1–4) & Tier 5 Adversarial Hardening** | Fix dynamic repo root & auto-detected Chrome/Playwright Chromium in `e2e/playwright.config.ts` & `verify-fail-closed.mjs`; migrate all fixtures/specs off `#btn-demo-login` & fake seed data to real user registration/login & dynamic API creation; cover all features including zero-fake-data assertions & v1.6.11 parity (Vault, OAuth MCP, Remote Assist, Coding Bots, WebMCP WASM, Apple/Muse & Grok UX, Browser Automation & App Store + 422 secret leak) across Tiers 1–4 (`TEST_READY.md`), pass 100%, then run Tier 5 adversarial hardening. | E2E Track, M6 | frontend_audit, ORIGINAL_REQUEST |
| F15 | **Git Cleanliness, Milestone Commits, Push to `origin main`, Tag `v1.6.11`, GitHub Release & Green CI/Deploy** | Regular logical commits pushed cleanly to `origin main` (zero `.agents/` or scratch files); annotated tag `v1.6.11`; `gh release create v1.6.11` with comprehensive Chinese/English release notes; verified green `.github/workflows/ci-deploy.yml` CI & GitHub Pages deployment. | M1–M6 (release in M6) | ORIGINAL_REQUEST |

---

## Milestones

| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| **M1** | **Protocol v1.6.11 Contracts, CI/Deploy/Proxy/Env Fixes & Version Alignment** | Add all `v1.4.0`–`v1.6.11` contracts to `packages/protocol`; bump versions to `1.6.11`; fix `config.ts` env vars, `proxy.ts`, `nginx.ombhrum.conf`, `ci-deploy.yml` & `deploy-gh-pages.mjs` (`VITE_BASE_PATH=/fabushi-web/`), deploy manifests; update protocol unit tests. | none | DONE (5/5 unanimous gate PASS; 55/55 unit tests; Arborist lockfile `errors: []`) |
| **M2** | **Server Core Zero-Fake-Data Purge, Security Hardening & Vault/Auth/Messaging v1.6.11** | Purge `seedDeterministicUniverse()`, demo/sandbox routes, `F1`/`F16`/`F17`/`D2`/`D4`; fix Passkey COSE crypto, Email 2FA, Alipay hijack, Account deletion, Channel RBAC, TURN secret; implement Split-Key V2, E2EE User Vault, X25519 Device Trust Ring, Messaging v1.6.11 (`client_nonce`, `archive-local-bot-reply`, `/api/v1/status`, `/api/v1/updates/*`, WS `PtsPush`/`Ack`); update server unit tests. | M1 | DONE (5/5 unanimous gate PASS; 74/74 unit tests; 28/28 adversarial suites) |
| **M3** | **Server AI/Multi-Agent/Coding/MiniApp-WebMCP/Remote/OAuth2.1-MCP/Browser/Automation-Store v1.6.11** | Purge `F2`–`F15`, `F18`; implement per-user ChaCha20-Poly1305 AI Vault + live `models.dev` + Magpie v1.6; `/api/v1/fabushi/*` + Multi-Agent protocol; Coding Agent Bots; decoupled MiniApp/WebMCP & gated VIP; UU-Parity Remote Assist & local agent bridge; Official OAuth 2.1 Remote MCP (`/mcp`, `/.well-known/*`, `/oauth/*`); real Chromium CDP + Script Distillation + Automation Script App Store (`422` secret scanner); expand unit/integration tests. | M1, M2 | DONE (`f0dee62` pushed to `origin main`; `typecheck`+`build`+22/22 M3 unit tests PASS; unified verification in M6 per Code-First directive) |
| **M4** | **Frontend Core Fake-Data Purge, Fabushi v1.6.11 WASM/WebMCP/PiP & Apple/Muse + Grok UX** | Purge `LocalSandboxAdapter`, fake `MtprotoAdapter`, demo/sandbox/QR-sim UI, `synthesizeWebPageFromUrl`, fake `Alice Chen` SDK, fake call/recording/download/composer/wireframe fallbacks; sync `v1.6.11` `fabushi_miniapp.wasm` & `hosted_bundle.html` + `navigator.modelContext` WebMCP + PiP restore-in-place; implement Apple/Muse redesign + Grok Bot pre-start & `+` multi-select compose + Inspector separation + `Fabushi Web v1.6.11` branding & `sw.js` `v4`. | M1, M2, M3 | DONE (`M4A + M4B` complete; `typecheck`+`build`+`89/89` unit tests PASS; authentic `837,676 B` WASM verified; unified testing in M6) |
| **M5** | **Frontend AI/Workspaces/Settings v1.6.11 Parity, Zero-Fake-Data Purge & Docs** | Purge fake `ComputerWorkbench` canvas & `9.9ms` clamps, fake `BrowserControlWorkspace` counts/clamps, fake `TalkModeOrb` text-sim, fake task progress, fake `local_hermes`, dead Settings controls; implement UU-Remote Assist UI, `v1.6.11` Interactive Browser + Script Distillation + Automation App Store UI, Official OAuth 2.1 MCP Grants/Audit UI, Split-Key V2 Vault & X25519 Device Sync Settings UI, Coding Agent Bot & Multi-Agent Hermes Studio UI, live `models.dev` Magpie UI; update `README.md`. | M4 | DONE (`M5` complete; `0` semantic errors, `0` fake-data matches, `0` purple hex violations, `README.md` v1.6.11; unified testing in M6) |
| **E2E** | **Parallel E2E Testing Track (`e2e/`, `TEST_INFRA.md`, `TEST_READY.md`)** | Modernize opaque-box Playwright E2E harness (dynamic paths, Chrome/Playwright auto-detect, real account auth, zero `#btn-demo-login`) & comprehensive Tiers 1–4 specs covering zero-fake-data invariants + full `v1.6.11` parity; publish `TEST_READY.md`. | none (runs parallel to M1–M5) | DONE (`216` tests / `46` files; unanimous 5/5 gate PASS; `TEST_READY.md` published) |
| **M6** | **Final Milestone: E2E Tiers 1–4 Pass, Tier 5 Adversarial Hardening, Whole-Project Audit, Push, Tag `v1.6.11`, GitHub Release & Green CI** | Phase 1: pass 100% E2E Tiers 1–4 sequentially; Phase 2: Tier 5 white-box adversarial hardening until 0 gaps; Phase 3: static zero-fake-data scan + whole-project Forensic Audit + clean git tree; Phase 4: commit, push `origin main`, annotated tag `v1.6.11`, `gh release create v1.6.11`, verified green `.github/workflows/ci-deploy.yml`. | M5, E2E (`TEST_READY.md`) | IN_PROGRESS (Unified Final Testing, Fix, Forensic Audit & Release) |

---

## Interface Contracts

### 1. Canonical Runtime, Port, Env & E2E Configuration
- **Repository Root**: `/home/antigravity/fabushiweb/fabushi-web` (all scripts/configs MUST derive root dynamically via `import.meta.dirname` / `path.resolve(__dirname, '..')`, NEVER hardcode absolute paths).
- **Production Version**: `1.6.11` across root `package.json`, `packages/protocol/package.json`, `apps/server/package.json`, `apps/web/package.json`, `e2e/package.json`, `/api/v1/health`, `/api/v1/status`, UI About/headers, and `sw.js` (`fabushi-web-v4`).
- **Build & Test Commands**:
  - `npm run typecheck`
  - `npm run build`
  - `npm run test:unit` (run sequentially after `npm run build`)
- **Unified Full-Stack Server Start**:
  ```bash
  PORT=4173 HOST=127.0.0.1 DATA_DIR=/path/to/isolated-data npm start
  ```
  - Always bind/connect via `127.0.0.1` or `localhost` (honoring VM `NO_PROXY`).
  - `ENABLE_TEST_RESET=1`: Enables `POST /api/v1/test/reset` which **cleanly wipes SQLite tables to an empty truthful state** (NEVER seeds fake users/chats/messages!).
  - Health & Status:
    - `GET /health` → `200 OK` `"OK"`
    - `GET /api/v1/health` → `200 OK` `{"ok": true, "version": "1.6.11", "app": "Fabushi Web"}`
    - `GET /api/v1/status` → `200 OK` `{"server": "fabushi-web", "status": "ok", "version": "1.6.11", "capabilities": [...]}`
- **Environment Variables (`apps/server/src/config.ts`)**:
  - Master secret: `GPUI_MASTER_SECRET ?? SESSION_SECRET` (fallback persisted 32-byte `.master-secret` in `DATA_DIR`)
  - Cloud gateway: `FABUSHI_CLOUD_GATEWAY_URL ?? OMBHRUM_API_URL`
  - AI gateway: `FABUSHI_AI_GATEWAY_URL ?? AI_GATEWAY_URL` (normalized so trailing `/v1` is never doubled into `/v1/v1/`)
  - TURN HMAC secret: `TURN_SECRET ?? masterSecret`
  - Upstream reverse proxy: `UPSTREAM_SERVER_URL` (forwards `/api/*`, `/v1/*`, `/.well-known/*`, `/oauth/*`, `/mcp`, `/miniapps/*`, `/bot*/*`, `/js/*`)
  - GitHub Pages base path: `VITE_BASE_PATH` defaults to `/fabushi-web/` in `scripts/deploy-gh-pages.mjs` and `.github/workflows/ci-deploy.yml` (and `./` in `vite.config.ts` for portable builds).
- **Playwright Browser Resolution (`e2e/playwright.config.ts`)**:
  - Auto-detect in order: `process.env.PLAYWRIGHT_CHROME_PATH` → Playwright bundled Chromium (`PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright`) → `/usr/bin/google-chrome` → `/usr/bin/chromium` → `/usr/bin/chromium-browser`.
  - Launch args: `['--no-sandbox', '--disable-setuid-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']`.
  - Concurrency: `workers: process.env.PLAYWRIGHT_WORKERS ? Number(process.env.PLAYWRIGHT_WORKERS) : 1` (safe for 2-vCPU VM).

### 2. Canonical v1.6.11 REST, OAuth, MCP & WebSocket Contracts
- **Auth & Split-Key V2 Vault**:
  - `GET /api/v1/auth/kdf-params?username=`
  - `POST /api/v1/auth/{register, login, email/register, upgrade-split-key, change-password, password/register, password/login, phone/send-code, phone/verify, 2fa/verify, pair/create, pair/status, pair/accept, passkey/register/options, passkey/register/verify, passkey/login/options, passkey/verify, logout}`
  - `GET/PUT /api/v1/user-vault/envelope`
  - `GET/PUT/DELETE /api/v1/user-vault/items[/:category/:itemKey]`
  - `POST /api/v1/user-vault/device-sync/{request, :id/approve, :id/deny}`, `GET .../device-sync/{pending, :id/status}`
- **Messaging & Updates**:
  - Existing `/api/v1/chats*`, `/api/v1/messages*`, `/api/v1/media*`, `/api/v1/sync/get_difference`, `/api/v1/contacts*`, `/api/v1/stories*`, `/api/v1/folders*`, `/api/v1/calls*`, `/api/v1/e2ee/*`
  - Added: `CreateChatRequest.client_nonce`, `POST /api/v1/chats/:chatId/messages/archive-local-bot-reply`, `GET /api/v1/updates/latest-mac.json`, `GET /api/v1/updates/assets/:tag/:filename`
- **Unified Fabushi / Hermes Agent, Multi-Agent & Magpie v1.6**:
  - Canonical `/api/v1/fabushi/*` (with `/api/v1/hermes/*` aliases) + `/api/v1/fabushi-bots[/:botId]`
  - `/api/v1/{fabushi,hermes}/magpie/{state, providers, providers/:id, providers/:id/probe, subscriptions/sync, subscriptions/:id/activate, models/catalog, groups, masking, mask-preview, usage}`
  - `/api/v1/magpie/v1/{models, chat/completions, responses, messages}` (authenticated!)
  - Multi-Agent workspace & floor endpoints + WS `AgentFloorChanged`, `AgentWorkspaceUpdated`, `AgentHandoffEvent`, `BotActivityChanged`
- **Coding Agent Bots**:
  - `POST /api/v1/coding-agents/probe`, WS `CodingHostCommand` / `CodingHostEvent`
- **Decoupled Mini Apps & WebMCP**:
  - `/api/v1/miniapps/{catalog, recent, :bot/:short/launch, :bot/:short/install, :bot/:short/action, :bot/:short/storage, :bot/:short/send-data}`
  - `/api/v1/bots/{attach-menu, profile/:target, :id/can-send-message, :id/allow-send-message, :id/accept-app-tos, :id/block}`, `/api/v1/botfather/nl-create`
  - `/api/v1/fabushi-miniapp/*` (standalone Fabushi 3D WASM app endpoints, separated cleanly from `/api/v1/fabushi/*` agent runtime!)
  - WS `MiniAppWebMcpCommand`, `MiniAppControlStatus`, `MiniAppWebMcpResult`, `MiniAppTakeoverState`
- **UU-Parity Remote Assist & Computers**:
  - `GET /api/v1/remote/assist/info`, `POST /api/v1/remote/assist/{reset-code, set-code, allow, start}`
  - `GET /api/v1/remote/sessions`, `POST /api/v1/remote/sessions/{disconnect, disconnect-all}`, `POST /api/v1/remote/webrtc/signal`
  - `POST /api/v1/computers/local/{register, poll}`, `POST /api/v1/computers/commands/:id/complete`, `GET/PUT /api/v1/bots/:botId/computer`
- **Official OAuth 2.1 Remote MCP**:
  - `GET /.well-known/{oauth-protected-resource, oauth-protected-resource/mcp, oauth-authorization-server, openid-configuration}`
  - `POST /oauth/{register, token, revoke}`, `GET /oauth/authorize`, `POST /oauth/authorize/{login, approve}`, `GET /oauth/authorize/qr-poll`
  - `GET /api/v1/mcp/grants`, `DELETE /api/v1/mcp/grants/:familyId`, `GET /api/v1/mcp/audit`
  - `POST/GET/DELETE /mcp` (Streamable HTTP + SSE, MCP `2025-11-25`)
- **Built-in Browser, Script Distillation & Automation App Store (`v1.6.11`)**:
  - `/api/v1/browser/*` (persisted pairing/grants/audit, real CDP sessions, `POST /api/v1/browser/scripts/distill`)
  - `GET/POST /api/v1/automation-apps`, `GET /api/v1/automation-apps/installed`, `GET /api/v1/automation-apps/:appId`, `POST/DELETE /api/v1/automation-apps/:appId/install`, `POST /api/v1/automation-apps/:appId/runs`

### 3. Canonical DOM `id` & `data-testid` Contract (Removed Demo IDs, Added v1.6.11 IDs)
- **Removed Fake/Demo IDs**: `#btn-demo-login`, `#btn-simulate-qr-scan` MUST NOT exist in production DOM.
- **Core Auth & Shell**: `#auth-screen`, `#tab-auth-password`, `#tab-auth-phone`, `#tab-auth-qr`, `#tab-auth-email`, `#tab-auth-alipay`, `#btn-auth-passkey`, `#auth-username-input`, `#auth-password-input`, `#btn-auth-password-submit`, `#auth-mode-register-toggle`, `#auth-server-url-input`, `#auth-country-select`, `#auth-phone-input`, `#btn-auth-send-code`, `#auth-code-input`, `#auth-2fa-input`, `#btn-auth-submit-2fa`, `#qr-login-svg`, `#passcode-lock-screen`, `#passcode-unlock-input`, `#app-shell`, `#connection-status-banner`, `#left-column`, `#btn-collapse-sidebar`, `#btn-main-menu`, `#main-menu-drawer`, `#global-search-input`, `#chat-folder-tabs`, `#sidebar-pinned-chats-grid`, `#chat-list`, `#btn-new-chat-fab`, `#nav-rail` (`#nav-dest-chats`, `#nav-dest-browser`, `#nav-dest-tasks`, `#nav-dest-mcp`, `#nav-dest-talk`, `#nav-dest-computer`, `#nav-dest-hermes`, `#nav-dest-settings`).
- **Stage, Apple/Muse & Grok Bot**: `#middle-column`, `#chat-header`, `#chat-header-title`, `#chat-header-status`, `#pinned-message-banner`, `#message-list`, `#apple-compose-stage`, `#bot-prestart-bar`, `#cmp-input-wrap`, `#message-composer-input`, `#btn-send-message`, `#stage-toast-pill`, `#window-toast-banner`, `#right-column`, `#settings-panel`, `#miniapp-modal`, `#miniapp-iframe`, `#miniapp-pip-overlay`.
- **v1.6.11 Workspaces**: `#browser-workspace`, `#browser-inspector-tabs`, `#automation-app-store-panel`, `#hermes-studio-panel`, `#magpie-gateway-panel`, `#task-center-workspace`, `#mcp-tools-dock`, `#oauth-mcp-grants-panel`, `#talk-mode-orb`, `#computer-workbench`, `#remote-assist-panel`, `#vault-settings-panel`, `#wallet-stars-modal`.

---

## Code Layout & Strict Write Ownership

```text
/home/antigravity/fabushiweb/fabushi-web/
├── .git/info/exclude                # Excludes .agents/ & TEST_READY.md (NEVER commit coordination files)
├── PROJECT.md                       # Project Orchestrator (living global index)
├── TEST_INFRA.md                    # E2E Testing Track ONLY
├── TEST_READY.md                    # E2E Testing Track ONLY (git-excluded)
├── package.json                     # [M1] Root monorepo v1.6.11
├── README.md                        # [M5] Updated Fabushi Web v1.6.11 documentation
├── .github/workflows/ci-deploy.yml  # [M1; M6 CI verification]
├── scripts/deploy-gh-pages.mjs      # [M1]
├── Dockerfile, docker-compose.yml, .env.example, fly.toml, railway.json, render.yaml, deploy/* # [M1]
├── packages/protocol/               # [M1] Shared v1.6.11 contracts & pure logic
├── apps/server/
│   ├── package.json                 # [M1] v1.6.11
│   └── src/
│       ├── config.ts, proxy.ts      # [M1] Env wiring & complete reverse proxy
│       ├── index.ts, staticHost.ts, db/*, ws/*, utils/* # [M2] Core server, schema, clean DB, WS v1.6.11
│       └── routes/
│           ├── auth.ts, chats.ts, messages.ts, media.ts, userVault.ts, updates.ts # [M2]
│           └── magpie.ts, hermes.ts, botsMiniApps.ts, fabushiMiniApp.ts, workspace.ts, browserControl.ts, officialMcp.ts, remoteAssist.ts, codingAgents.ts, automationApps.ts, multiAgent.ts # [M3]
├── apps/web/
│   ├── package.json                 # [M1] v1.6.11
│   ├── index.html, vite.config.ts, public/** # [M4] Fabushi Web v1.6.11, fresh WASM, WebMCP SDK, sw.js v4
│   └── src/
│       ├── adapters/, services/, i18n/, App.tsx, main.tsx # [M4] Real HttpWsServerAdapter only
│       ├── store/{useAuthStore,useChatStore,useUiStore,useSettingsStore}.ts # [M4]
│       ├── store/useAiWorkspaceStore.ts # [M5]
│       ├── styles/{tokens,reset,layout,auth,left,middle,right-settings-modals}.css # [M4]
│       ├── styles/ai-miniapps.css   # [M5]
│       └── components/
│           ├── auth/, layout/, left/, middle/, media/, right/, calls/, modals/, miniapps/ # [M4]
│           └── ai/, settings/       # [M5]
├── tests/unit/
│   ├── protocol/                    # [M1]
│   └── server/                      # [M2, M3] Hardened zero-fake-data & v1.6.11 regression tests
└── e2e/                             # [E2E Testing Track ONLY -> M6 Tier 5 adds tier5/]
```
