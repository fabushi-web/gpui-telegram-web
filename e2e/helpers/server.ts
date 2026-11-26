import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { API_PATHS } from './selectors';

export const DEFAULT_PORT = 4173;
export const DEFAULT_BASE_URL = `http://127.0.0.1:${DEFAULT_PORT}`;

/**
 * Canonical headless Chromium launch arguments for Fabushi Web E2E.
 * Includes fake media device stream so genuine getUserMedia / MediaRecorder / WebRTC
 * tests execute cleanly in headless VM environments without app-level fake fallbacks.
 */
export const CHROMIUM_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
] as const;

const SYSTEM_BROWSER_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
] as const;

function isExecutableFile(filePath: string | undefined): filePath is string {
  if (!filePath || filePath.trim().length === 0) return false;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function scanPlaywrightBrowsersCache(): string | undefined {
  const browsersRoot =
    process.env.PLAYWRIGHT_BROWSERS_PATH?.trim() || '/opt/ms-playwright';
  if (!fs.existsSync(browsersRoot)) {
    return undefined;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(browsersRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }

  const chromiumDirs = entries
    .filter((entry) => entry.isDirectory() && /^chromium-\d+$/.test(entry.name))
    .sort((a, b) => {
      const revA = Number(a.name.slice('chromium-'.length));
      const revB = Number(b.name.slice('chromium-'.length));
      return revB - revA;
    });

  for (const dir of chromiumDirs) {
    for (const sub of ['chrome-linux64', 'chrome-linux']) {
      const candidate = path.join(browsersRoot, dir.name, sub, 'chrome');
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/**
 * Auto-detects an executable Chromium/Chrome binary in strict precedence order:
 * 1. `process.env.PLAYWRIGHT_CHROME_PATH` (if explicitly set: returns it or throws fail-closed)
 * 2. Playwright bundled `chromium.executablePath()` (if executable exists: returns `undefined`
 *    so Playwright launches its managed binary directly)
 * 3. System browsers: `/usr/bin/google-chrome`, `/usr/bin/chromium`, `/usr/bin/chromium-browser`
 * 4. Resilient cache scan under `${PLAYWRIGHT_BROWSERS_PATH || '/opt/ms-playwright'}/chromium-*`
 * 5. Fail-closed throw if no executable browser exists.
 */
export function resolveChromiumExecutablePath(
  playwrightBundledPath?: string,
): string | undefined {
  const explicit = process.env.PLAYWRIGHT_CHROME_PATH?.trim();
  if (explicit) {
    if (!isExecutableFile(explicit)) {
      throw new Error(
        `PLAYWRIGHT_CHROME_PATH="${explicit}" does not exist or is not executable.`,
      );
    }
    return explicit;
  }

  if (isExecutableFile(playwrightBundledPath)) {
    return undefined;
  }

  for (const candidate of SYSTEM_BROWSER_CANDIDATES) {
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }

  const cachedBinary = scanPlaywrightBrowsersCache();
  if (cachedBinary) {
    return cachedBinary;
  }

  throw new Error(
    `No executable Chromium/Chrome binary found. Checked PLAYWRIGHT_CHROME_PATH, Playwright bundled (${playwrightBundledPath ?? 'unset'}), system paths (${SYSTEM_BROWSER_CANDIDATES.join(', ')}), and PLAYWRIGHT_BROWSERS_PATH (${process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/ms-playwright'}).`,
  );
}

export interface ServerHealthResponse {
  ok: boolean;
  version?: string;
  app?: string;
}

export interface WaitForServerHealthOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface RegisterUserOptions {
  username?: string;
  password?: string;
  firstName?: string;
  lastName?: string;
  deviceName?: string;
}

export interface RegisteredUserSession {
  userId: number;
  username: string;
  password: string;
  firstName: string;
  lastName?: string;
  token: string;
  sessionId: string;
  authVersion: number;
}

export interface CreateRealConversationFixtureOptions {
  peerUsername?: string;
  peerFirstName?: string;
  peerPassword?: string;
  includeGroup?: boolean;
  groupTitle?: string;
  isForumGroup?: boolean;
  includeChannel?: boolean;
  channelTitle?: string;
  channelUsername?: string;
  initialDmMessages?: Array<{ from: 'primary' | 'peer'; text: string }>;
  initialGroupMessages?: Array<{ from: 'primary' | 'peer'; text: string }>;
}

export interface RealConversationFixture {
  peer: RegisteredUserSession;
  dmChatId: number;
  dmTitle: string;
  groupChatId?: number;
  groupTitle?: string;
  channelChatId?: number;
  channelTitle?: string;
  messages: Array<{
    chatId: number;
    messageId: number;
    senderId: number;
    text: string;
  }>;
}

let usernameCounter = 0;

/**
 * Generates a collision-free username matching `^[a-z][a-z0-9_]{5,28}$`.
 */
export function generateUniqueUsername(prefix = 'e2euser'): string {
  usernameCounter += 1;
  const safePrefix = prefix
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 10) || 'e2euser';
  const suffix = `${Date.now().toString(36).slice(-5)}_${usernameCounter}_${crypto.randomBytes(2).toString('hex')}`;
  return `${safePrefix}_${suffix}`.slice(0, 30);
}

export function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
  };
}

/**
 * Returns the validated, trailing-slash-stripped base URL for Playwright E2E tests.
 * Defaults to `http://127.0.0.1:4173`.
 *
 * CRITICAL PROXY INVARIANT:
 * Throws immediately if `0.0.0.0` (or IPv6 wildcard `::`) is supplied in `E2E_BASE_URL`,
 * honoring `NO_PROXY=localhost,127.0.0.1,::1,[::1]`.
 */
export function getBaseUrl(): string {
  const raw = process.env.E2E_BASE_URL?.trim();
  if (!raw) {
    return DEFAULT_BASE_URL;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `Invalid E2E_BASE_URL "${raw}": expected an absolute http:// or https:// URL (e.g. "${DEFAULT_BASE_URL}").`,
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Invalid E2E_BASE_URL "${raw}": unsupported protocol "${parsed.protocol}" (expected http: or https:).`,
    );
  }

  if (
    parsed.hostname === '0.0.0.0' ||
    parsed.hostname === '::' ||
    parsed.hostname === '[::]' ||
    raw.includes('0.0.0.0')
  ) {
    throw new Error(
      `Forbidden E2E_BASE_URL "${raw}": wildcard bind address "${parsed.hostname}" bypasses NO_PROXY=localhost,127.0.0.1,::1,[::1]. Use "http://127.0.0.1:<PORT>" instead.`,
    );
  }

  const normalizedPath =
    parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${normalizedPath}`;
}

export function apiUrl(pathname: string): string {
  const normalized = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${getBaseUrl()}${normalized}`;
}

/**
 * Polls `GET /api/v1/health` until HTTP 200 with JSON `{ ok: true }` is observed,
 * or throws a descriptive error once `timeoutMs` elapses.
 */
export async function waitForServerHealth(
  request: APIRequestContext,
  options?: WaitForServerHealthOptions,
): Promise<ServerHealthResponse> {
  const url = apiUrl(API_PATHS.health);
  const timeoutMs = options?.timeoutMs ?? 15_000;
  const pollIntervalMs = options?.pollIntervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;

  let lastFailure = 'no response received';

  while (Date.now() <= deadline) {
    const remainingMs = Math.max(250, deadline - Date.now());
    try {
      const response = await request.get(url, {
        timeout: Math.min(2_500, remainingMs),
        failOnStatusCode: false,
      });
      const status = response.status();
      if (status === 200) {
        const body: unknown = await response.json().catch(() => null);
        if (
          body !== null &&
          typeof body === 'object' &&
          'ok' in body &&
          (body as { ok: unknown }).ok === true
        ) {
          const maybeVersion = (body as { version?: unknown }).version;
          const maybeApp = (body as { app?: unknown }).app;
          return {
            ok: true,
            ...(typeof maybeVersion === 'string' ? { version: maybeVersion } : {}),
            ...(typeof maybeApp === 'string' ? { app: maybeApp } : {}),
          };
        }
        lastFailure = `HTTP 200 with invalid health payload: ${JSON.stringify(body)}`;
      } else {
        lastFailure = `HTTP ${status}`;
      }
    } catch (err) {
      lastFailure = err instanceof Error ? err.message : String(err);
    }

    if (Date.now() + pollIntervalMs > deadline) {
      break;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for server health at ${url} (last failure: ${lastFailure}).`,
  );
}

/**
 * Deterministically wipes server SQLite WAL tables to a clean truthful empty state
 * via `POST /api/v1/test/reset`. Strictly fails closed on any non-2xx or `{ ok: false }`.
 */
export async function resetTestServer(request: APIRequestContext): Promise<void> {
  const url = apiUrl(API_PATHS.testReset);

  let response;
  try {
    response = await request.post(url, {
      data: {},
      timeout: 10_000,
      failOnStatusCode: false,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Network failure calling POST ${url}: ${msg}`);
  }

  const status = response.status();
  if (!response.ok()) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `Unexpected HTTP ${status} from POST ${url} (ensure server runs with ENABLE_TEST_RESET=1): ${text.slice(0, 300)}`,
    );
  }

  const contentType = response.headers()['content-type'] ?? '';
  if (contentType.includes('application/json')) {
    const payload: unknown = await response.json().catch(() => null);
    if (
      payload !== null &&
      typeof payload === 'object' &&
      'ok' in payload &&
      (payload as { ok: unknown }).ok === false
    ) {
      throw new Error(`POST ${url} returned ok=false: ${JSON.stringify(payload)}`);
    }
  }
}

/**
 * Registers a real user via `POST /api/v1/auth/register`.
 * Fails closed on any non-200/201 response or missing `token` / `user_id`.
 */
export async function registerUserViaApi(
  request: APIRequestContext,
  options?: RegisterUserOptions,
): Promise<RegisteredUserSession> {
  const username = options?.username ?? generateUniqueUsername('member');
  const password = options?.password ?? 'FabushiE2e!2026';
  const firstName = options?.firstName ?? 'E2E Member';
  const lastName = options?.lastName ?? 'Tester';
  const deviceName = options?.deviceName ?? 'Playwright Chromium';

  const url = apiUrl(API_PATHS.authRegister);
  const response = await request.post(url, {
    data: {
      username,
      password,
      first_name: firstName,
      last_name: lastName,
      device_name: deviceName,
      auto_welcome: false,
    },
    timeout: 10_000,
    failOnStatusCode: false,
  });

  const status = response.status();
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if ((status !== 200 && status !== 201) || !body) {
    throw new Error(
      `POST ${url} failed with HTTP ${status}: ${JSON.stringify(body)}`,
    );
  }

  const userObj =
    typeof body.user === 'object' && body.user !== null
      ? (body.user as Record<string, unknown>)
      : null;
  const userId = Number(body.user_id ?? body.id ?? userObj?.id ?? userObj?.user_id);
  const token = String(body.token ?? body.access_token ?? '');
  const sessionId = String(body.session_id ?? body.sessionId ?? '');
  const authVersion = Number(body.auth_version ?? 1);

  if (!Number.isFinite(userId) || userId <= 0 || token.length === 0) {
    throw new Error(
      `POST ${url} returned invalid AuthResponse payload: ${JSON.stringify(body)}`,
    );
  }

  return {
    userId,
    username,
    password,
    firstName,
    lastName,
    token,
    sessionId,
    authVersion,
  };
}

function deriveSplitKeyV2AuthVerifierB64(
  password: string,
  saltB64: string,
  kdfParams?: { m_cost_kib?: unknown; t_cost?: unknown; p_cost?: unknown } | null,
): string {
  const mCost = Number(kdfParams?.m_cost_kib ?? 65536);
  const tCost = Number(kdfParams?.t_cost ?? 3);
  const pCost = Number(kdfParams?.p_cost ?? 1);
  const normalizedSaltB64 = saltB64.trim().replace(/-/g, '+').replace(/_/g, '/');
  const saltBytes = Buffer.from(normalizedSaltB64, 'base64');
  const domainPrefix = Buffer.from(
    `fabushi/split-key-v2|${mCost}|${tCost}|${pCost}|`,
    'utf8',
  );
  const boundSalt = Buffer.concat([domainPrefix, saltBytes]);
  const masterBits = crypto.pbkdf2Sync(
    Buffer.from(password, 'utf8'),
    boundSalt,
    10_000,
    32,
    'sha256',
  );
  const verifierBits = crypto.hkdfSync(
    'sha256',
    masterBits,
    saltBytes,
    Buffer.from('fabushi/auth-verifier/v2', 'utf8'),
    32,
  );
  return Buffer.from(verifierBits).toString('base64');
}

/**
 * Logs in an existing user via `POST /api/v1/auth/login`.
 * Queries `GET /api/v1/auth/kdf-params` first so Split-Key V2 accounts (created by the
 * real Web UI) authenticate via derived `auth_verifier_b64`, while V1 accounts retain the
 * standard password login path.
 */
export async function loginUserViaApi(
  request: APIRequestContext,
  username: string,
  password: string,
  deviceName = 'Playwright Chromium',
): Promise<RegisteredUserSession> {
  const kdfUrl = `${apiUrl(API_PATHS.authKdfParams)}?username=${encodeURIComponent(username)}`;
  const kdfRes = await request.get(kdfUrl, {
    timeout: 10_000,
    failOnStatusCode: false,
  });
  const kdfBody =
    kdfRes.status() === 200
      ? ((await kdfRes.json().catch(() => null)) as {
          auth_version?: unknown;
          auth_salt_b64?: unknown;
          kdf_params?: { m_cost_kib?: unknown; t_cost?: unknown; p_cost?: unknown } | null;
        } | null)
      : null;

  const loginPayload: Record<string, unknown> =
    kdfBody &&
    Number(kdfBody.auth_version) === 2 &&
    typeof kdfBody.auth_salt_b64 === 'string' &&
    kdfBody.auth_salt_b64.trim().length > 0
      ? {
          username,
          password: '',
          auth_verifier_b64: deriveSplitKeyV2AuthVerifierB64(
            password,
            kdfBody.auth_salt_b64,
            kdfBody.kdf_params,
          ),
          device_name: deviceName,
        }
      : { username, password, device_name: deviceName };

  const url = apiUrl(API_PATHS.authLogin);
  const response = await request.post(url, {
    data: loginPayload,
    timeout: 10_000,
    failOnStatusCode: false,
  });
  const status = response.status();
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (status !== 200 || !body) {
    throw new Error(`POST ${url} failed with HTTP ${status}: ${JSON.stringify(body)}`);
  }

  const userObj =
    typeof body.user === 'object' && body.user !== null
      ? (body.user as Record<string, unknown>)
      : null;
  const userId = Number(body.user_id ?? body.id ?? userObj?.id ?? userObj?.user_id);
  const token = String(body.token ?? body.access_token ?? '');
  const sessionId = String(body.session_id ?? body.sessionId ?? '');
  const firstName = String(body.first_name ?? userObj?.first_name ?? username);
  const authVersion = Number(body.auth_version ?? 1);

  if (!Number.isFinite(userId) || userId <= 0 || token.length === 0) {
    throw new Error(`POST ${url} returned invalid login response: ${JSON.stringify(body)}`);
  }

  return {
    userId,
    username,
    password,
    firstName,
    token,
    sessionId,
    authVersion,
  };
}

async function createChatViaApi(
  request: APIRequestContext,
  token: string,
  payload: Record<string, unknown>,
): Promise<{ chatId: number; title: string; raw: Record<string, unknown> }> {
  const primaryUrl = apiUrl(API_PATHS.chatsCreate);
  let res = await request.post(primaryUrl, {
    headers: authHeaders(token),
    data: payload,
    timeout: 10_000,
    failOnStatusCode: false,
  });

  if (res.status() === 404) {
    res = await request.post(apiUrl(API_PATHS.chats), {
      headers: authHeaders(token),
      data: payload,
      timeout: 10_000,
      failOnStatusCode: false,
    });
  }

  const status = res.status();
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if ((status !== 200 && status !== 201) || !body) {
    throw new Error(
      `Create chat failed with HTTP ${status}: ${JSON.stringify(body)}`,
    );
  }

  const chatObj =
    typeof body.chat === 'object' && body.chat !== null
      ? (body.chat as Record<string, unknown>)
      : body;
  const chatId = Number(chatObj.chat_id ?? chatObj.id ?? body.chat_id ?? body.id);
  const title = String(chatObj.title ?? payload.title ?? '');
  if (!Number.isFinite(chatId) || chatId <= 0) {
    throw new Error(`Create chat returned invalid chat_id: ${JSON.stringify(body)}`);
  }

  return { chatId, title, raw: body };
}

export async function sendApiMessage(
  request: APIRequestContext,
  token: string,
  chatId: number,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<{ messageId: number; pts: number; senderId: number; raw: Record<string, unknown> }> {
  const url = apiUrl(`${API_PATHS.chats}/${chatId}/messages`);
  const res = await request.post(url, {
    headers: authHeaders(token),
    data: {
      chat_id: chatId,
      text,
      client_nonce: crypto.randomInt(1, 2 ** 48 - 1),
      ...extra,
    },
    timeout: 10_000,
    failOnStatusCode: false,
  });

  const status = res.status();
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if ((status !== 200 && status !== 201) || !body) {
    throw new Error(`POST ${url} failed with HTTP ${status}: ${JSON.stringify(body)}`);
  }

  const msgObj =
    typeof body.message === 'object' && body.message !== null
      ? (body.message as Record<string, unknown>)
      : body;
  const messageId = Number(msgObj.message_id ?? msgObj.id ?? body.message_id ?? body.id);
  const pts = Number(body.pts ?? msgObj.pts ?? 0);
  const senderId = Number(msgObj.sender_id ?? body.sender_id ?? 0);
  if (!Number.isFinite(messageId) || messageId <= 0) {
    throw new Error(`POST ${url} returned invalid message_id: ${JSON.stringify(body)}`);
  }
  return { messageId, pts, senderId, raw: body };
}

/**
 * Opt-in helper creating a genuine second registered user and real DM
 * (plus optional Group/Forum and Broadcast Channel) via real REST endpoints.
 * Specs verifying truthful empty initial workspace MUST NOT call this helper.
 */
export async function createRealConversationFixture(
  request: APIRequestContext,
  primaryToken: string,
  options: CreateRealConversationFixtureOptions = {},
): Promise<RealConversationFixture> {
  const peer = await registerUserViaApi(request, {
    username: options.peerUsername ?? generateUniqueUsername('peer'),
    password: options.peerPassword ?? 'PeerPass!2026',
    firstName: options.peerFirstName ?? 'Peer Partner',
    lastName: 'Contact',
  });

  const dm = await createChatViaApi(request, primaryToken, {
    chat_type: 'private',
    peer_user_id: peer.userId,
    title: peer.firstName,
    client_nonce: crypto.randomUUID(),
  });

  const fixture: RealConversationFixture = {
    peer,
    dmChatId: dm.chatId,
    dmTitle: dm.title || peer.firstName,
    messages: [],
  };

  const dmMessages = options.initialDmMessages ?? [
    { from: 'peer', text: 'Hello from verified peer partner' },
    { from: 'primary', text: 'Confirmed real conversation setup' },
  ];

  for (const entry of dmMessages) {
    const senderToken = entry.from === 'primary' ? primaryToken : peer.token;
    const sent = await sendApiMessage(request, senderToken, dm.chatId, entry.text);
    fixture.messages.push({
      chatId: dm.chatId,
      messageId: sent.messageId,
      senderId: sent.senderId,
      text: entry.text,
    });
  }

  if (options.includeGroup) {
    const groupTitle = options.groupTitle ?? 'Engineering Sync Group';
    const group = await createChatViaApi(request, primaryToken, {
      chat_type: options.isForumGroup ? 'supergroup' : 'group',
      title: groupTitle,
      is_forum: Boolean(options.isForumGroup),
      member_ids: [peer.userId],
      client_nonce: crypto.randomUUID(),
    });
    fixture.groupChatId = group.chatId;
    fixture.groupTitle = group.title || groupTitle;

    const groupMsgs = options.initialGroupMessages ?? [
      { from: 'primary', text: 'Welcome to the real group room' },
    ];
    for (const entry of groupMsgs) {
      const senderToken = entry.from === 'primary' ? primaryToken : peer.token;
      const sent = await sendApiMessage(request, senderToken, group.chatId, entry.text);
      fixture.messages.push({
        chatId: group.chatId,
        messageId: sent.messageId,
        senderId: sent.senderId,
        text: entry.text,
      });
    }
  }

  if (options.includeChannel) {
    const channelTitle = options.channelTitle ?? 'Release Announcements';
    const channelUsername =
      options.channelUsername ?? generateUniqueUsername('chan');
    const channel = await createChatViaApi(request, primaryToken, {
      chat_type: 'channel',
      title: channelTitle,
      username: channelUsername,
      member_ids: [peer.userId],
      client_nonce: crypto.randomUUID(),
    });
    fixture.channelChatId = channel.chatId;
    fixture.channelTitle = channel.title || channelTitle;
  }

  return fixture;
}

/**
 * Wipes all browser client state (`cookies`, `localStorage`, `sessionStorage`,
 * Service Workers, Cache Storage, and all `IndexedDB` databases) for the test origin.
 */
export async function clearClientState(page: Page): Promise<void> {
  const baseUrl = getBaseUrl();
  const targetOrigin = new URL(baseUrl).origin;

  await page.context().clearCookies();

  let currentOrigin: string | null = null;
  const currentUrl = page.url();
  if (currentUrl.startsWith('http://') || currentUrl.startsWith('https://')) {
    try {
      currentOrigin = new URL(currentUrl).origin;
    } catch {
      currentOrigin = null;
    }
  }

  if (currentOrigin !== targetOrigin) {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  }

  const { hadBlockedDb } = await page.evaluate(async () => {
    window.localStorage.clear();
    window.sessionStorage.clear();

    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker
        .getRegistrations()
        .catch(() => []);
      await Promise.all(
        registrations.map((reg) => reg.unregister().catch(() => false)),
      );
    }

    if ('caches' in window) {
      const keys = await window.caches.keys().catch(() => []);
      await Promise.all(keys.map((key) => window.caches.delete(key).catch(() => false)));
    }

    let blocked = false;

    if ('indexedDB' in window && typeof window.indexedDB.databases === 'function') {
      const dbs = await window.indexedDB.databases();
      const names = dbs
        .map((db) => db.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0);

      await Promise.all(
        names.map(
          (name) =>
            new Promise<void>((resolve, reject) => {
              const timer = window.setTimeout(() => {
                blocked = true;
                resolve();
              }, 1_500);

              const req = window.indexedDB.deleteDatabase(name);
              req.onsuccess = () => {
                window.clearTimeout(timer);
                resolve();
              };
              req.onerror = () => {
                window.clearTimeout(timer);
                reject(req.error ?? new Error(`Failed to delete IndexedDB "${name}"`));
              };
              req.onblocked = () => {
                window.clearTimeout(timer);
                blocked = true;
                resolve();
              };
            }),
        ),
      );
    }

    return { hadBlockedDb: blocked };
  });

  if (hadBlockedDb) {
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send('Storage.clearDataForOrigin', {
        origin: targetOrigin,
        storageTypes: 'indexeddb,local_storage,service_workers,cache_storage',
      });
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  }
}
