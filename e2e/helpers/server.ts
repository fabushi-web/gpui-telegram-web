import type { APIRequestContext, Page } from '@playwright/test';
import { API_PATHS } from './selectors';

export const DEFAULT_PORT = 4173;
export const DEFAULT_BASE_URL = `http://127.0.0.1:${DEFAULT_PORT}`;

export interface ServerHealthResponse {
  ok: boolean;
  version?: string;
}

export interface WaitForServerHealthOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface ResetTestServerOptions {
  allowSandbox404?: boolean;
}

/**
 * Returns the validated, trailing-slash-stripped base URL for Playwright E2E tests.
 * Defaults to `http://127.0.0.1:4173`.
 *
 * CRITICAL PROXY INVARIANT (PROJECT.md L91):
 * Throws immediately if `0.0.0.0` (or IPv6 wildcard `::`) is ever supplied in
 * `E2E_BASE_URL`, because VM `HTTP_PROXY` only exempts `NO_PROXY=localhost,127.0.0.1,::1,[::1]`.
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

  const normalizedPath = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${normalizedPath}`;
}

/**
 * Polls `GET /api/v1/health` until HTTP 200 with JSON `{ ok: true }` is observed,
 * or throws a descriptive error once `timeoutMs` elapses.
 */
export async function waitForServerHealth(
  request: APIRequestContext,
  options?: WaitForServerHealthOptions,
): Promise<ServerHealthResponse> {
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}${API_PATHS.health}`;
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
          return {
            ok: true,
            ...(typeof maybeVersion === 'string' ? { version: maybeVersion } : {}),
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
 * Deterministically resets server SQLite WAL + seeded universe via `POST /api/v1/test/reset`.
 * Fails closed on network failure, any 5xx status, `ok: false` payload, or any non-2xx
 * status (unless `status === 404` AND `options?.allowSandbox404 === true`).
 */
export async function resetTestServer(
  request: APIRequestContext,
  options?: ResetTestServerOptions,
): Promise<void> {
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}${API_PATHS.testReset}`;

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

  if (status >= 500) {
    const text = await response.text().catch(() => '');
    throw new Error(`Server error HTTP ${status} from POST ${url}: ${text.slice(0, 300)}`);
  }

  if (status === 404 && options?.allowSandbox404 === true) {
    return;
  }

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
 * Wipes all browser client state (`cookies`, `localStorage`, `sessionStorage`,
 * Service Workers, Cache Storage, and all `IndexedDB` databases) for the test origin.
 *
 * Navigates to `getBaseUrl()` first ONLY when `page.url()` is `about:blank`, non-http(s),
 * or on a different origin so Web Storage / IndexedDB access never throws `SecurityError`.
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
      const registrations = await navigator.serviceWorker.getRegistrations().catch(() => []);
      await Promise.all(registrations.map((reg) => reg.unregister().catch(() => false)));
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
