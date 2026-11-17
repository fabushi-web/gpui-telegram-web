# gpui-telegram-web

Full-featured web edition of [`bhrum/gpui-telegram`](https://github.com/bhrum/gpui-telegram) (`v1.2.0`) engineered with a hexagonal TypeScript monorepo architecture delivering parity with Telegram Web (Web A / Web K) and `gpui-telegram`.

## Architecture

- **`packages/protocol` (`@gpui-telegram/protocol`)**: Shared domain models, wire DTOs, UTF-16 `MessageEntity` & Markdown parser/serializer, 3-state CJK `ImeSafetyFsm` (`Idle -> Composing -> Committed`), 100-bar 5-bit voice waveform codec, WebCrypto E2EE (`ECDH P-256 + HKDF-SHA256 + AES-256-GCM` + 4-emoji safety fingerprint), 23-variant `UpdateEvent` & monotonic per-chat `PtsUpdate` sync schemas, canonical `DOM_IDS` registry, and the hexagonal `TelegramClientPort` interface.
- **`apps/server` (`@gpui-telegram/server`)**: Stateful Node.js 24 (`node:http` + built-in `node:sqlite` WAL + `ws` + SSE) backend supporting all 7 authentication flows, salted `scrypt` Cloud 2FA, `/api/v1/ws` per-chat monotonic `pts` sync & gap recovery, CJK-aware full-text search, SHA-256 content-addressable chunked media upload with HTTP `206 Partial Content` byte-range streaming, `@BotFather` (`777001`), `window.Telegram.WebApp` Mini Apps (`fabushi-globe` & `taskboard`), Hermes 6-Tab AI Studio & 61 `/slash` commands, Magpie Multi-Provider LLM Gateway, Global Task Center & 5-field Cron, MCP Tools Dock, Full-Duplex Talk Mode, Remote Computer Workbench (`<10ms` emergency takeover), Tailnet mesh status, Stars/TON Wallet, and static SPA co-hosting.
- **`apps/web` (`@gpui-telegram/web`)**: Vite + React 19 + Zustand + `@tanstack/react-virtual` + 100% Vanilla CSS responsive Telegram Web interface.

## Quick Start

```bash
npm install
npm run build
PORT=4173 HOST=127.0.0.1 DATA_DIR=./data npm start
```

Open `http://127.0.0.1:4173` in your browser.

## Development & Verification Commands

- `npm run typecheck` — Strict TypeScript 5 typechecking across all workspaces and tests
- `npm run build` — Production build for `packages/protocol`, `apps/server`, and `apps/web`
- `npm run test:unit` — Run Vitest unit & full-stack server integration tests (`--maxWorkers=2`)
- `npm start` — Run unified production full-stack server (`PORT`, `HOST`, `DATA_DIR`, `ENABLE_TEST_RESET`)
