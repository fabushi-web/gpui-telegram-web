# Fabushi Web (`v1.6.11`)

Standalone full-stack TypeScript web edition aligned **100% with desktop [`bhrumom/gpui-telegram`](https://github.com/bhrumom/gpui-telegram) `v1.6.11`**, engineered with a clean hexagonal monorepo (`packages/protocol`, `apps/server`, `apps/web`) and **strictly zero fake, mock, or demo data in production runtime**.

Every unauthenticated, empty-workspace, zero-provider, disconnected, and error state behaves faithfully to desktop Fabushi `v1.6.11`, backed by real SQLite WAL persistence (`node:sqlite`), real WebSocket `/api/v1/ws` + monotonic `pts` synchronization, real WebCrypto Split-Key V2 & E2EE Vaulting, real per-user ChaCha20-Poly1305 AI provider isolation, fresh `v1.6.11` Fabushi 3D WASM + WebMCP Mini Apps, Official OAuth 2.1 Remote MCP (`/mcp`), UU-Parity Remote Assist, and Built-in Interactive Chromium CDP Browser + Script Distillation + Automation Script App Store.

---

## Highlights & Feature Matrix (`v1.6.11`)

- **Zero Fake Data & Single Real Production Runtime (`A01`)**:
  - Single production transport (`HttpWsServerAdapter`) backed by `node:http` + `node:sqlite` WAL + `ws` + SSE (zero client-side fake adapters, zero pre-seeded accounts/chats/messages, zero unverified wallet minting, zero fabricated AI/MCP/Tailnet/canvas/voice stubs).
  - Clean new accounts start truthfully empty (`chats: []`, `0` Stars / `0` TON, `0` configured AI providers, `0` browser targets).
  - Real authentication flows: Password / Split-Key V2 (`Argon2id` + HKDF verifier), Phone OTP, Email OTP + Cloud 2FA enforcement, QR Pairing (`/pair/create`, `/pair/status`, `/pair/accept`), real WebAuthn COSE Passkeys, Alipay OAuth, and local AES-GCM Passcode Lock (`Ctrl+Shift+L`).
- **Apple Messages macOS & Muse UI/UX Redesign (`A02`)**:
  - Four 100% Vanilla CSS themes (`Night`, `Tinted`, `Day`, `Classic`) with strict zero-purple-on-dark invariant, 4-step dark elevation ladder, zero dark drop shadows, 180° vertical blue outgoing bubbles, and 9-hue bot tinting.
  - Centered `76px` translucent Apple Messages contact header, `288px` collapsible sidebar with flicker-free Apple 3×3 Pinned Chats Grid (`#sidebar-pinned-chats-grid`), Apple Capsule Composer (`max-w: 740px`) with 3-state CJK `ImeSafetyFsm`, 2-layer non-overlapping toasts (`#stage-toast-pill` & `#window-toast-banner`), 2-pane Apple System Settings offset past `#nav-rail`, and live bilingual `en-US` / `zh-CN` switching.
- **Core Messaging, Media, WebRTC Calls & E2EE Secret Chats (`A03`–`A07`)**:
  - Per-chat monotonic `pts` WebSocket sync (`PtsPush`/`Ack`), `client_nonce` idempotency, 1-char CJK + Latin full-text search, Stories, Chat Folders, Forum Topics, UTF-16 `MessageEntity` formatting, chunked SHA-256 media upload + HTTP `206 Partial Content` streaming, Lightbox & Canvas media editor, 100-bar 5-bit voice & video notes, Polls/Quizzes, collaborative Todo checklists, payment/redeem-gated Stars Wallet (`402 payment_required`), real JSON/HTML chat exports, WebRTC P2P voice/video/screen-share calls with TURN credentials, and WebCrypto E2EE Secret Chats (`ECDH P-256 + HKDF-SHA256 + AES-256-GCM`).
- **Split-Key V2 Zero-Knowledge Auth, E2EE User Vault & X25519 Device Trust Ring (`A08`)**:
  - Anti-enumeration `GET /api/v1/auth/kdf-params`, Split-Key V2 registration, silent V1→V2 upgrade, and password rotation.
  - Revisioned client-side AES-256-GCM E2EE Vault (`GET/PUT /api/v1/user-vault/envelope`, `GET/PUT/DELETE /api/v1/user-vault/items/:category/:itemKey` across `password`, `browser_cookie`, `ai_oauth` with optimistic `409` concurrency).
  - X25519 Device Trust Ring (`device-sync/{request,pending,:id/approve,:id/deny,:id/status}`) with deterministic 6-digit `NNN-NNN` verification codes and atomic one-time ciphertext consumption.
- **Per-User ChaCha20-Poly1305 Magpie v1.6 Gateway & Live `models.dev` Catalog (`A09`)**:
  - Strict tenant isolation: every user's AI provider credentials and client-synced subscriptions are encrypted at rest via HKDF + ChaCha20-Poly1305 (`enc:v1:<b64>`) with redacted readbacks.
  - Live 2-tier `models.dev` catalog (`GET /api/v1/fabushi/magpie/models/catalog`), OpenAI/Anthropic/Gemini/Responses gateway (`/api/v1/magpie/v1/*`), routing groups CRUD, server-backed outbound PII privacy masking, and truthful fail-closed `503 provider_not_configured` inline `PROVIDER_ERROR` cards with `"Configure AI Provider"` CTA.
- **Unified Fabushi / Hermes Runtime, Multi-Agent Group Protocol & Coding Agent Bots (`A10`–`A11`)**:
  - Canonical `/api/v1/fabushi/*` agent runtime (persisted sessions, memory/soul, skills, 29 toolsets, cron jobs, kanban & security approvals) + Grok Bot pre-start `START` bar and inline `+` multi-select compose stage.
  - Multi-Agent Group Protocol (`FloorControlQueue`, 5-hop `LoopBudget`, `SharedGroupWorkspace` revisioned KV).
  - Native Coding Agent Bots supporting all 6 providers (`claude_code`, `codex`, `open_code`, `cursor_cli`, `antigravity`, `acp_custom`), real PATH probing (`POST /api/v1/coding-agents/probe`), 13 slash commands, 3 permission modes (`ask`, `auto_edit`, `full_access`), and WS host brokering.
- **Decoupled Mini Apps, Fresh `v1.6.11` Fabushi 3D WASM, WebMCP & Floating PiP (`A12`)**:
  - Authentic `v1.6.11` Rust-compiled `fabushi_miniapp.wasm` (837,676 bytes) + `hosted_bundle.html` with `navigator.modelContext` WebMCP tool registration, server-backed `CloudStorage`, and restore-in-place Floating PiP (`#miniapp-pip-overlay`) preserving WASM heap state across minimize/restore.
- **UU-Parity Remote Assist, Real Remote Computer Control & Emergency Kill Switch (`A13`)**:
  - Permanent 9-digit Assist ID, temporary rotating & custom 8–16 alphanumeric access codes with rate limiting, guest assist sessions (`/api/v1/remote/assist/*`), local computer agent polling (`/api/v1/computers/local/{register,poll}`), extended `RemoteComputerOp`, and un-clamped Emergency Kill Switch (`POST /api/v1/remote/sessions/disconnect-all`).
- **Official OAuth 2.1 Remote MCP Server (`/mcp`, `A14`)**:
  - RFC 9728 / RFC 8414 / RFC 7591 discovery (`/.well-known/*`, `/oauth/register`), mandatory PKCE S256 authorization flow, SSRF-hardened redirect/CIMD checks, rotating refresh token families, Streamable HTTP + SSE (`MCP-Protocol-Version: 2025-11-25`), 14 canonical scopes, and interactive Grants & Audit UI (`#oauth-mcp-grants-panel`).
- **Built-in Interactive Browser, Script Distillation & Automation Script App Store (`A15`)**:
  - Isolated Chromium CDP headless sessions (`/api/v1/browser/headless/*`), real PNG screenshots & semantic DOM refs, `BrowserControlMode` takeover controls, persisted desktop pairing & un-clamped emergency revoke, 4-tab Inspector (`Copilot`, `Recorder`, `Session`, `App Store`).
  - **Script Distillation** (`POST /api/v1/browser/scripts/distill`) compiling `BrowserActionTrace` into parameterized secret-free `AutomationScriptApp` manifests with zero-LLM deterministic replay (`used_llm: false`).
  - **Automation Script App Store** (`/api/v1/automation-apps*`) protected by a recursive **Defense-in-Depth `422 secret_leak_detected` scanner**, SHA-256 integrity digests, and idempotent install/uninstall/run telemetry.
- **Truthful Talk Mode, Task Center & Auto-Update Relay (`A16`)**:
  - Real WebAudio `MediaRecorder` microphone capture in `#talk-mode-orb` with honest permission and `503` pipeline errors (zero simulated text input).
  - SQLite-persisted Task Center starting at truthful `0%` progress & empty logs with 5-field cron validation.
  - `GET /api/v1/status` (`version: "1.6.11"` + `capabilities[]`) and `/api/v1/updates/latest-mac.json` relay.

---

## Monorepo Architecture

```text
fabushi-web/
├── packages/
│   └── protocol/       # @gpui-telegram/protocol v1.6.11 — Shared DTOs, UTF-16 entities, CJK IME FSM,
│                       # 5-bit waveform codec, E2EE, Split-Key V2 Vault, Automation Apps + Secret Scanner,
│                       # Coding Agents, Remote Control, WebMCP, Official OAuth 2.1 MCP & DOM_IDS
├── apps/
│   ├── server/         # @gpui-telegram/server v1.6.11 — Node.js 22+ HTTP + node:sqlite WAL + WS + SSE +
│   │                   # ChaCha20 AI Vault + Chromium CDP + Official OAuth 2.1 MCP + Reverse Proxy
│   └── web/            # @gpui-telegram/web v1.6.11 — Vite + React 19 + Zustand 5 + @tanstack/react-virtual +
│                       # 100% Vanilla CSS (Apple/Muse) + Fabushi 3D WASM + WebMCP SDK + sw.js v4
├── tests/
│   └── unit/           # Vitest protocol & server security/zero-fake-data unit & integration suites
└── e2e/                # Opaque-box Playwright Chromium E2E suite (Tiers 1–4 + Tier 5 adversarial)
```

---

## Quick Start

### Prerequisites
- **Node.js `>= 22.13.0`** (uses built-in `node:sqlite` — zero native C++ addon builds required)
- **npm `>= 10`**
- Optional: **Chromium / Google Chrome** (auto-detected for Built-in Headless Browser CDP sessions)

### Install, Build & Run Standalone Production Server

```bash
npm install
npm run build
SESSION_SECRET=$(openssl rand -hex 32) \
PORT=4173 HOST=127.0.0.1 DATA_DIR=./data npm start
```

Open `http://127.0.0.1:4173` in your browser and register a real account (or sign in via Split-Key V2 / Phone / Email / QR / Passkey).

### Reverse Proxy Mode (Pair with Native Rust `gpui_telegram_server`)

```bash
UPSTREAM_SERVER_URL=https://your-upstream-fabushi-server.example.com \
PORT=4173 HOST=0.0.0.0 npm start
```

Serves the compiled Fabushi Web SPA while transparently proxying `/api/*`, `/v1/*`, `/.well-known/*`, `/oauth/*`, `/mcp`, `/miniapps/*`, `/bot*/*`, `/js/*`, and WebSocket upgrades (`/api/v1/ws`, `/api/v1/browser/ws`, `/api/v1/tailnet/derp`) to your upstream backend.

### Key Environment Variables

| Variable | Description |
|---|---|
| `PORT` / `HOST` | Bind port & interface (default `4173` / `0.0.0.0`) |
| `DATA_DIR` | Persistent directory for SQLite WAL database, uploaded media, and `models.dev` cache |
| `GPUI_MASTER_SECRET` / `SESSION_SECRET` | 32-byte master secret for session signing & HKDF key derivation |
| `FABUSHI_PROVIDER_MASTER_KEY` | Optional dedicated master key for per-user ChaCha20-Poly1305 AI provider vault |
| `TURN_SECRET` | HMAC secret for WebRTC TURN credential minting (`/api/v1/calls/turn-credentials`) |
| `UPSTREAM_SERVER_URL` | Optional upstream Rust `gpui_telegram_server` URL for reverse-proxy mode |
| `CHROME_EXECUTABLE` / `CHROMIUM_PATH` | Optional explicit Chromium binary path for CDP headless browser sessions |
| `VITE_BASE_PATH` | Vite asset base path (`./` for portable self-hosted builds, `/fabushi-web/` for GitHub Pages) |

---

## Official OAuth 2.1 MCP (`/mcp`) & Desktop Integration

Connect MCP-compatible AI clients (Claude Desktop, Cursor, Antigravity, or Fabushi Desktop):

1. Discover metadata via `GET /.well-known/oauth-protected-resource` and `GET /.well-known/oauth-authorization-server`.
2. Register dynamically via `POST /oauth/register` (loopback HTTP, HTTPS, or desktop deep-link redirect URIs only) and complete PKCE S256 authorization at `/oauth/authorize`.
3. Connect to `POST / GET / DELETE /mcp` with `Authorization: Bearer <access_token>` and `MCP-Protocol-Version: 2025-11-25`.
4. Audit every tool invocation or revoke any client grant family immediately in **MCP Dock → Official OAuth 2.1 Grants (`#oauth-mcp-grants-panel`)** or terminate all active sessions via **Remote Assist → Emergency Kill Switch**.

---

## Deployment

- **Docker / Docker Compose**: `docker compose up --build` (uses included `Dockerfile`, `docker-compose.yml`, and `deploy/Caddyfile` / `deploy/nginx.ombhrum.conf`).
- **PaaS**: Ready-to-use manifests included for Fly.io (`fly.toml`), Railway (`railway.json`), and Render (`render.yaml`).
- **GitHub Pages (Static SPA)**: Automatically deployed via `.github/workflows/ci-deploy.yml` with `VITE_BASE_PATH=/fabushi-web/`. Static hosts connect cleanly to any user-configured Fabushi backend URL (e.g., `https://web.ombhrum.com`).

---

## Verification & Testing

```bash
# 1. Monorepo TypeScript strict check
npm run typecheck

# 2. Full production build (protocol -> server -> web)
npm run build

# 3. Unit & server integration test suites (Vitest)
npm run test:unit

# 4. Opaque-box Playwright E2E test suites (Tiers 1–4)
npm run test:e2e
```
