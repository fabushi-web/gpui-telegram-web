# gpui-telegram-web

Complete standalone web edition of [`bhrum/gpui-telegram`](https://github.com/bhrum/gpui-telegram) (`v1.2.0`), engineered with a clean hexagonal TypeScript monorepo architecture (`packages/protocol`, `apps/server`, `apps/web`).

It delivers **100% standalone parity with Telegram Web (Web A / Web K) and `gpui-telegram` desktop** with **zero dependency on the native Rust/GPUI desktop binary**, while simultaneously exposing a bidirectional **Desktop-to-Browser Control Bridge (`F17` + MCP JSON-RPC 2.0)** so `gpui-telegram` desktop clients and AI agents can remotely inspect and control live web tabs or isolated Headless Chromium sessions.

---

## Highlights & Feature Matrix (`F1`–`F17`)

- **3 Standalone Runtime Modes (Zero Native Binary Dependency)**:
  - **`server` (Default Full-Stack Mode)**: Node.js 24 (`node:http` + `node:sqlite` WAL + `ws` + SSE) + React 19 SPA with real multi-client sync, WebRTC signaling, chunked media streaming, E2EE key directory, AI workspaces, and Browser Control Bridge.
  - **`sandbox` (100% Browser-Standalone Offline Mode)**: Runs entirely inside the browser via `LocalSandboxAdapter` + `BroadcastChannel` multi-tab sync with zero backend server required (`?mode=sandbox`).
  - **`mtproto` (Telegram DC Mode)**: Pluggable `TelegramClientPort` adapter for direct MTProto transport configuration (`?mode=mtproto`).
- **Telegram Web (Web A / Web K) Complete UX (`F1`–`F15`)**:
  - **7 Authentication Flows & Local Security (`F1`)**: Phone + OTP, QR Code login, Cloud 2FA (`scrypt`), Sign-Up, Passkey/WebAuthn, Demo Account Switcher (`Alice`, `Bob`, `Carol`, `Dave`), Bot Token login, Alipay OAuth simulation, and local AES-GCM Passcode Lock (`Ctrl+L`).
  - **Responsive 3-Column Shell, 4 Themes & Bilingual i18n (`F2`)**: Desktop 3-column / Tablet 2-column / Mobile single-column layout, `Night`, `Day`, `Tinted`, and `Classic` themes (**100% Vanilla CSS, strictly zero purple/violet hues on dark themes**), custom accent picker, message density, and instant `zh-CN` / `en-US` switching.
  - **Per-Chat Monotonic `pts` WebSocket Sync (`F3`)**: `/api/v1/ws` real-time push, `PtsStateMachine` gap detection, `/api/v1/sync/getDifference` recovery, `client_nonce` idempotency, typing/upload/record action indicators, and multi-tab `BroadcastChannel` state sync.
  - **Stories, Folders, Archive & Forum Topics (`F4`)**: 24h Stories ring & viewer/composer, up to 10 Chat Folders, collapsible Archived Chats, Saved Messages, and Supergroup Forum Topics split-view.
  - **CJK Full-Text Search & Rich Timeline (`F5`–`F13`)**: 1-char CJK (`中文`) + Latin prefix global/in-chat search, `@tanstack/react-virtual` virtualized timeline, grouped albums, UTF-16 `MessageEntity` formatting & spoilers, fenced code blocks with copy, Instant View reader, 3-state CJK `ImeSafetyFsm` composer, scheduled/silent messages, forward/reply/edit/delete/pin, animated reactions, SHA-256 chunked media upload + HTTP `206 Partial Content` streaming, Lightbox & Canvas media editor, 100-bar 5-bit voice notes & circular video notes with transcription, Polls/Quizzes, collaborative Todo checklists, and Stars/TON invoices.
  - **Right Context Inspector, 25-Page Settings, WebRTC Calls & E2EE Secret Chats (`F14`–`F15`)**: Shared media/files/links/voice tabs, group/channel admin permissions & stats, JSON/HTML chat history export, 1-on-1 WebRTC P2P voice/video/screen-share calls with loopback verification, and WebCrypto E2EE Secret Chats (`ECDH P-256 + HKDF-SHA256 + AES-256-GCM`) with 4-emoji safety fingerprint verification.
- **`gpui-telegram` Native Ecosystem Capabilities (`F16`)**:
  - Conversational `@BotFather` (`777001`), `window.Telegram.WebApp` Mini Apps (`全球法布施` WebAssembly + 3D Canvas Globe + Zen Room, and `TaskBoard`), **Hermes 6-Tab AI Studio** (61 `/slash` commands + SSE `ThinkingBubble`), **Magpie Multi-Provider LLM Gateway** (PII masking + token ledger), **Global Task Center & 5-Field Cron Scheduler**, **MCP Tools Permission Dock**, **Full-Duplex Talk Mode Orb**, **Remote Computer Workbench** (`<10ms` emergency takeover), **Tailnet Mesh Overlay**, and **Stars/TON Wallet**.
- **Desktop-to-Browser Control Bridge (`F17`)**:
  - Live Web Tab Agent (`window.__GPUI_TELEGRAM_BROWSER_BRIDGE__`) + WebSocket reverse RPC (`/api/v1/browser/ws`) + REST controller API (`/api/v1/browser/*`) + Server-managed Headless Chromium CDP Studio (`/api/v1/browser/headless/*` with deterministic `http_dom_fallback`) + standard **Model Context Protocol JSON-RPC 2.0** endpoint (`POST /api/v1/mcp/rpc`).

---

## Monorepo Architecture

```text
gpui-telegram-web/
├── packages/
│   └── protocol/       # @gpui-telegram/protocol — Shared DTOs, UTF-16 entities, CJK IME FSM,
│                       # 5-bit waveform codec, WebCrypto E2EE, PTS sync FSM, DOM_IDS & BrowserControl types
├── apps/
│   ├── server/         # @gpui-telegram/server — Node.js 24 HTTP + node:sqlite WAL + WS + SSE +
│   │                   # Headless Chromium CDP controller + MCP JSON-RPC 2.0 host
│   └── web/            # @gpui-telegram/web — Vite + React 19 + Zustand + @tanstack/react-virtual +
│                       # 100% Vanilla CSS + Live Browser Control Agent
├── tests/
│   └── unit/           # Vitest unit, protocol, ecosystem & F17 browser bridge integration suites
└── e2e/                # Self-contained Playwright Chromium E2E verification suite (F1–F17)
```

---

## Quick Start

### Prerequisites
- **Node.js `>= 22.13.0`** (uses built-in `node:sqlite` — zero native C++ addon compilation required)
- **npm `>= 10`**

### Install, Build & Launch (Clean Production Mode — Zero Fake Data)

```bash
npm install
npm run build
SESSION_SECRET=$(openssl rand -hex 32) \
PORT=4173 HOST=0.0.0.0 DATA_DIR=./data npm start
```

Open `http://127.0.0.1:4173` in your browser:
- **Production Mode (Default)**: Clean SQLite database with zero mock users/chats/wallets, real ISO/IEC 18004 QR codes, real Alipay OAuth (`api.ombhrum.com`), real 833KB Rust-compiled Fabushi 3D WASM Mini App, and real Magpie multi-provider LLM routing.
- **Reverse Proxy Mode (Pair with Rust `gpui_telegram_server`)**:
  ```bash
  UPSTREAM_SERVER_URL=http://34.46.77.133:8080 \
  PORT=4173 HOST=0.0.0.0 npm start
  ```
  Serves the Web SPA + static Fabushi WASM bundle while transparently proxying `/api/*` (HTTP, SSE, HTTP 206 Range) and WebSockets (`/api/v1/ws`, `/api/v1/browser/ws`) to your live Rust backend.
- **Developer Sandbox Mode (Opt-In Only)**: Append `?mode=sandbox` or `?dev=1` locally (disabled by default in production).

---

## Desktop-to-Browser Control Bridge (`F17`) — Integration Guide for `gpui-telegram` Desktop & MCP Clients

`gpui-telegram-web` allows native `gpui-telegram` desktop clients, CLI scripts, and MCP-compatible AI agents to inspect and control browser sessions securely.

### 1. Pair a Desktop Controller (Capability Token)

1. Open **Browser Control Workspace** (`#nav-dest-browser` in the left navigation rail) in the web app to generate a 6-character pairing code, **or** request one via API with an authenticated user bearer token:
   ```bash
   curl -X POST http://127.0.0.1:4173/api/v1/browser/pair/request \
     -H "Authorization: Bearer <USER_SESSION_TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{"client_name":"gpui-telegram-desktop","Scopes":["snapshot","act","navigate","headless"]}'
   ```
2. Exchange the `pair_code` from the desktop client for a scoped `X-Desktop-Browser-Token`:
   ```bash
   curl -X POST http://127.0.0.1:4173/api/v1/browser/pair/exchange \
     -H "Content-Type: application/json" \
     -d '{"pair_code":"<6_CHAR_CODE>","desktop_name":"gpui-telegram macOS/Linux Desktop"}'
   ```
3. **Emergency `<10ms` Revoke**: Clicking `#btn-browser-revoke-all` in the web UI or calling `POST /api/v1/browser/revoke-all` immediately invalidates all desktop capability tokens and terminates active control leases.

### 2. Inspect & Drive Live Paired Web Tabs

```bash
# List connected live web tabs & headless sessions for this user
curl http://127.0.0.1:4173/api/v1/browser/targets \
  -H "X-Desktop-Browser-Token: <DESKTOP_TOKEN>"

# Capture Accessibility / DOM snapshot with deterministic element refs (e1, e2, ...)
curl -X POST http://127.0.0.1:4173/api/v1/browser/tabs/<TARGET_ID>/command \
  -H "X-Desktop-Browser-Token: <DESKTOP_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"action":"snapshot"}'

# Execute UI or semantic Telegram actions (click, fill, press, navigate, app_action, screenshot)
curl -X POST http://127.0.0.1:4173/api/v1/browser/tabs/<TARGET_ID>/command \
  -H "X-Desktop-Browser-Token: <DESKTOP_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"action":"app_action","app_action":"send_chat_message","app_payload":{"chat_id":101,"text":"Sent remotely from gpui-telegram Desktop!"}}'
```

### 3. Drive Server-Managed Headless Chromium Sessions

Desktop clients can also spawn isolated headless Chromium instances (`cdp_chromium` with automatic `http_dom_fallback` when no browser binary is installed):

```bash
# Open a headless browser session
curl -X POST http://127.0.0.1:4173/api/v1/browser/headless/sessions \
  -H "X-Desktop-Browser-Token: <DESKTOP_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"url":"http://127.0.0.1:4173","width":1280,"height":800}'

# Snapshot, click, fill, evaluate, or capture PNG/SVG screenshots
curl -X POST http://127.0.0.1:4173/api/v1/browser/headless/sessions/<SESSION_ID>/action \
  -H "X-Desktop-Browser-Token: <DESKTOP_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"action":"snapshot"}'
```

### 4. Connect via Model Context Protocol (MCP JSON-RPC 2.0)

Point any MCP host (including `gpui-telegram` Hermes/MCP runtime, Claude Desktop, or Cursor) at:
- **Manifest**: `GET /api/v1/mcp/manifest`
- **JSON-RPC 2.0 Endpoint**: `POST /api/v1/mcp/rpc` (`initialize`, `ping`, `tools/list`, `tools/call`)
- **Exposed Browser Tools**: `browser_list_targets`, `browser_tab_command`, `browser_snapshot`, `browser_act`, `browser_open_headless`, `browser_headless_open`, `browser_headless_action`, `browser_headless_screenshot`, `browser_headless_close`.

---

## Production Deployment (`ombhrum.com`)

1. **Docker & Docker Compose (Recommended — Full-Stack or Reverse Proxy to Rust `gpui_telegram_server`)**:
   ```bash
   cp .env.example .env
   # Set SESSION_SECRET (and optionally UPSTREAM_SERVER_URL=http://<rust-server>:8080)
   docker compose up -d --build
   ```
   Persists SQLite WAL databases and content-addressed media in the `gpui_telegram_data` volume (`/data`) with built-in `/api/v1/health` healthcheck and `SEED_DEMO_DATA=0` / `ALLOW_DEMO_AUTH=0`.
2. **HTTPS Edge Reverse Proxy (`web.ombhrum.com`)**:
   - **Caddy (Auto-HTTPS)**: `caddy run --config deploy/Caddyfile`
   - **Nginx**: copy `deploy/nginx.ombhrum.conf` to `/etc/nginx/sites-enabled/` (includes WebSocket upgrades, unbuffered SSE, HTTP 206 Range, and `application/wasm` MIME type).
3. **Static Hosting / GitHub Pages (connects to `https://api.ombhrum.com`)**:
   - Build & publish via `VITE_DEFAULT_SERVER_URL=https://api.ombhrum.com npm run deploy:pages`.
4. **Cloud PaaS Blueprints**:
   - **Render**: `render.yaml` (persistent disk `/data` + Docker healthcheck).
   - **Railway**: `railway.json` (`Dockerfile` builder + `/api/v1/health`).
   - **Fly.io**: `fly.toml` (`fly volumes create gpui_telegram_data --size 2 && fly deploy`).

---

## Verification & Testing

```bash
# 1. Strict TypeScript check across protocol, server, and web
npm run typecheck

# 2. Production bundle build
npm run build

# 3. Vitest unit, protocol, production-mode & browser bridge integration suites
npm run test:unit
```
