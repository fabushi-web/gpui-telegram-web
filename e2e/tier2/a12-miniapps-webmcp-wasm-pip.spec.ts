import { test, expect } from '../helpers/fixtures';
import { API_PATHS, DOM } from '../helpers/selectors';
import {
  apiUrl,
  authHeaders,
  registerUserViaApi,
} from '../helpers/server';
import { extractBotUserId } from '../helpers/api';
import { bilingualRegex, scopedButton } from '../helpers/ui';

test.describe('Tier 2 — A12: MiniApp SDK Zero-Fake-initData, HMAC Tamper 401, CloudStorage Error Honesty & WASM Boot Failure', () => {
  test('A12-T2-01: Loading /js/telegram-web-app.js without tgWebAppData yields empty initData and undefined user (ZERO fabricated identity or hardcoded hash)', async ({
    page,
    request,
  }) => {
    const sdkRes = await request.get(apiUrl(API_PATHS.telegramWebAppSdk));
    expect(sdkRes.status()).toBe(200);
    const sdkSource = await sdkRes.text();
    expect(sdkSource).not.toContain('89d6079ad6762351f38c6dbbc41bb53048019256a9443988af7a48bcad16ba31');

    // Load SDK in a clean page with no #tgWebAppData hash
    await page.setContent(`<!doctype html><html><head><script src="${apiUrl(API_PATHS.telegramWebAppSdk)}"></script></head><body></body></html>`);
    const snapshot = await page.evaluate(() => {
      const wa = (
        window as unknown as {
          Telegram?: {
            WebApp?: {
              initData?: string;
              initDataUnsafe?: { user?: unknown; hash?: string };
            };
          };
        }
      ).Telegram?.WebApp;
      return {
        exists: Boolean(wa),
        initData: wa ? wa.initData : undefined,
        unsafeUser: wa?.initDataUnsafe?.user,
        unsafeHash: wa?.initDataUnsafe?.hash,
      };
    });

    expect(snapshot.exists).toBe(true);
    expect(snapshot.initData).toBe('');
    expect(snapshot.unsafeUser).toBeUndefined();
    expect(snapshot.unsafeHash).toBeUndefined();
  });

  test('A12-T2-02: POST /api/v1/miniapps/:bot/:short/validate-init-data rejects tampered HMAC-SHA256 hash with 401', async ({
    request,
  }) => {
    const user = await registerUserViaApi(request);
    const headers = authHeaders(user.token);
    const catalogRes = await request.get(apiUrl(API_PATHS.miniappsCatalog), { headers });
    expect(catalogRes.status()).toBe(200);
    const catalog = (await catalogRes.json()) as {
      apps?: Array<{ bot_username: string; short_name: string }>;
    };
    expect(Array.isArray(catalog.apps)).toBe(true);
    const app = catalog.apps![0];
    expect(app).toBeTruthy();

    const tamperedInitData =
      'auth_date=1700000000&user=%7B%22id%22%3A1%2C%22username%22%3A%22spoof%22%7D&hash=0000000000000000000000000000000000000000000000000000000000000000';

    const valRes = await request.post(
      apiUrl(`${API_PATHS.miniapps}/${app.bot_username}/${app.short_name}/validate-init-data`),
      {
        headers,
        data: { init_data: tamperedInitData },
        failOnStatusCode: false,
      },
    );
    expect(valRes.status()).toBe(401);
  });

  test('A12-T2-03: CloudStorage network failure returns real error callback (NEVER false-success cb(null, true)) and oversized values rejected', async ({
    page,
    request,
  }) => {
    const user = await registerUserViaApi(request);
    const headers = authHeaders(user.token);
    const catalogRes = await request.get(apiUrl(API_PATHS.miniappsCatalog), { headers });
    expect(catalogRes.status()).toBe(200);
    const catalog = (await catalogRes.json()) as {
      apps?: Array<{ bot_username: string; short_name: string }>;
    };
    expect(Array.isArray(catalog.apps)).toBe(true);
    const app = catalog.apps![0];
    expect(app).toBeTruthy();

    // Oversized CloudStorage value (> 4096 bytes) rejected via API
    const oversizedRes = await request.put(
      apiUrl(`${API_PATHS.miniapps}/${app.bot_username}/${app.short_name}/storage`),
      {
        headers,
        data: { key: 'oversized_key', value: 'x'.repeat(10_000) },
        failOnStatusCode: false,
      },
    );
    expect([400, 413]).toContain(oversizedRes.status());

    // SDK CloudStorage.setItem MUST hit backend storage route and fail honestly on HTTP 500
    let storageHits = 0;
    await page.route('**/storage**', (route) => {
      storageHits += 1;
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'storage_unavailable' }),
      });
    });

    const gotoRes = await page.goto(apiUrl(API_PATHS.fabushiMiniAppIndex), {
      waitUntil: 'domcontentloaded',
    });
    expect(gotoRes).not.toBeNull();
    expect(gotoRes!.status()).toBe(200);

    const result = await page.evaluate(
      () =>
        new Promise<{ hasCloudStorage: boolean; err: unknown; ok: unknown }>((resolve) => {
          const cs = (
            window as unknown as {
              Telegram?: {
                WebApp?: {
                  CloudStorage?: {
                    setItem: (
                      k: string,
                      v: string,
                      cb: (err: unknown, ok?: unknown) => void,
                    ) => void;
                  };
                };
              };
            }
          ).Telegram?.WebApp?.CloudStorage;
          if (!cs) {
            resolve({ hasCloudStorage: false, err: null, ok: null });
            return;
          }
          cs.setItem('test_err_key', 'val', (err, ok) =>
            resolve({ hasCloudStorage: true, err, ok }),
          );
        }),
    );

    expect(result.hasCloudStorage).toBe(true);
    expect(storageHits).toBeGreaterThanOrEqual(1);
    expect(Boolean(result.err)).toBe(true);
    expect(result.ok).not.toBe(true);
  });

  test('A12-T2-04: Untrusted-origin postMessage to host bridge is ignored & unsafe web_app.url schemes (javascript:, data:, file://) rejected', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const headers = authHeaders(user.token);

    // 1. Create a real owned bot so validation rejects specifically on unsafe web_url scheme
    const botUsername = `unsafe_app_${Date.now().toString(36)}_bot`;
    const botRes = await request.post(apiUrl(API_PATHS.fabushiBots), {
      headers,
      data: {
        display_name: 'Scheme Validation Bot',
        username: botUsername,
      },
    });
    expect([200, 201]).toContain(botRes.status());

    for (const unsafeUrl of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      '//evil.example/hijack',
    ]) {
      const res = await request.post(apiUrl(API_PATHS.miniapps), {
        headers,
        data: {
          bot_username: botUsername,
          short_name: `unsafe_${Date.now().toString(36)}`,
          title: 'Unsafe MiniApp',
          description: 'Unsafe URL scheme validation',
          category: 'tools',
          icon_emoji: '🧪',
          web_url: unsafeUrl,
          peer_types: ['private'],
          is_attach_enabled: false,
        },
        failOnStatusCode: false,
      });
      expect([400, 422]).toContain(res.status());
    }

    // 2. Untrusted-origin postMessage events MUST NOT close #miniapp-modal or trigger send-data
    let sendDataCalls = 0;
    await page.route('**/send-data**', (route) => {
      sendDataCalls += 1;
      return route.continue();
    });

    const launchTrigger = page
      .locator('[data-testid*="miniapp" i], [data-miniapp-short-name*="fabushi" i]')
      .or(scopedButton(page, bilingualRegex('fabushi|mini\\s*app|法布施', '法布施|小程序')))
      .first();
    await expect(launchTrigger).toBeVisible();
    await launchTrigger.click();
    const modal = page.locator(DOM.miniappModal);
    await expect(modal).toBeVisible();

    await page.evaluate(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://untrusted-origin.invalid',
          data: JSON.stringify({ eventType: 'web_app_close' }),
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://untrusted-origin.invalid',
          data: JSON.stringify({
            eventType: 'web_app_data_send',
            eventData: { data: 'spoofed_untrusted_payload' },
          }),
        }),
      );
    });
    await page.waitForTimeout(300);

    await expect(modal).toBeVisible();
    expect(sendDataCalls).toBe(0);
  });

  test('A12-T2-05: Simulated WASM 404 fetch triggers truthful boot_error state and WebMCP tool error (never claims success)', async ({
    page,
  }) => {
    let wasmInterceptHits = 0;
    await page.route('**/*.wasm*', (route) => {
      wasmInterceptHits += 1;
      return route.fulfill({ status: 404, body: 'WASM missing' });
    });

    const gotoRes = await page.goto(apiUrl(API_PATHS.fabushiMiniAppIndex), {
      waitUntil: 'domcontentloaded',
    });
    expect(gotoRes).not.toBeNull();
    expect(gotoRes!.status()).toBe(200);

    await expect
      .poll(() => wasmInterceptHits, {
        timeout: 8_000,
        message: 'Expected Fabushi MiniApp to request .wasm so 404 route triggers',
      })
      .toBeGreaterThanOrEqual(1);

    // Poll until window.__GPUI_WEBMCP__.readState() surfaces a non-empty boot_error
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const bridge = (
              window as unknown as {
                __GPUI_WEBMCP__?: { readState?: () => Record<string, unknown> };
              }
            ).__GPUI_WEBMCP__;
            const state = typeof bridge?.readState === 'function' ? bridge.readState() : null;
            return typeof state?.boot_error === 'string' ? state.boot_error : '';
          }),
        {
          timeout: 8_000,
          message: 'Expected __GPUI_WEBMCP__.readState().boot_error to populate on WASM 404',
        },
      )
      .not.toBe('');

    const status = await page.evaluate(
      () =>
        new Promise<{
          hasModelContext: boolean;
          hasBridge: boolean;
          toolOk: unknown;
          toolError: string;
          bodyText: string;
        }>((resolve) => {
          const nav = navigator as Navigator & { modelContext?: Record<string, unknown> };
          const bridge = (
            window as unknown as {
              __GPUI_WEBMCP__?: {
                invoke?: (
                  reqId: string,
                  op: string,
                  toolName?: string,
                  args?: Record<string, unknown>,
                ) => void;
              };
            }
          ).__GPUI_WEBMCP__;
          const bodyText = document.body.innerText || '';
          if (typeof bridge?.invoke !== 'function') {
            resolve({
              hasModelContext: Boolean(nav.modelContext),
              hasBridge: Boolean(bridge),
              toolOk: true,
              toolError: '',
              bodyText,
            });
            return;
          }
          const reqId = 'e2e_boot_err_check';
          const timer = window.setTimeout(() => {
            window.removeEventListener('message', onMessage);
            resolve({
              hasModelContext: Boolean(nav.modelContext),
              hasBridge: true,
              toolOk: true,
              toolError: '',
              bodyText,
            });
          }, 5_000);
          const onMessage = (evt: MessageEvent) => {
            let parsed: unknown = evt.data;
            if (typeof parsed === 'string') {
              try {
                parsed = JSON.parse(parsed);
              } catch {
                return;
              }
            }
            if (
              parsed &&
              typeof parsed === 'object' &&
              (parsed as { eventType?: string }).eventType === 'webmcp_response'
            ) {
              const data = (parsed as { eventData?: Record<string, unknown> }).eventData;
              if (data && data.request_id === reqId) {
                window.clearTimeout(timer);
                window.removeEventListener('message', onMessage);
                resolve({
                  hasModelContext: Boolean(nav.modelContext),
                  hasBridge: true,
                  toolOk: data.ok,
                  toolError: String(data.error ?? ''),
                  bodyText: document.body.innerText || '',
                });
              }
            }
          };
          window.addEventListener('message', onMessage);
          bridge.invoke(reqId, 'call_tool', 'fabushi_get_status', {});
        }),
    );

    expect(status.hasModelContext).toBe(true);
    expect(status.hasBridge).toBe(true);
    expect(status.toolOk).toBe(false);
    expect(status.toolError.trim().length).toBeGreaterThan(0);
    // Explicit error terms only (bare "wasm" removed so healthy title text never false-passes)
    expect(
      /boot_error|加载失败|错误|error|failed|404/i.test(status.bodyText) ||
        /boot_error|error|failed|404|not\s*ready/i.test(status.toolError),
    ).toBe(true);
  });

  test('A12-T2-06: Blocked bot / unpermitted DM returns 403 on /bot:token/sendMessage', async ({
    request,
  }) => {
    const owner = await registerUserViaApi(request);
    const stranger = await registerUserViaApi(request);

    const botRes = await request.post(apiUrl(API_PATHS.fabushiBots), {
      headers: authHeaders(owner.token),
      data: {
        display_name: 'Permission Check Bot',
        username: `perm_bot_${Date.now().toString(36)}_bot`,
      },
    });
    expect([200, 201]).toContain(botRes.status());
    const botData = (await botRes.json()) as {
      bot_token: string;
      companion_chat_id: number;
      bot?: { bot_user_id?: number; id?: number; user_id?: number };
      registry?: { bot_user_id?: number };
    };
    const botId = extractBotUserId(botData);
    expect(botId).toBeGreaterThan(0);

    // Prove /bot:token/sendMessage route is live on owner's companion chat (200)
    const ownerPush = await request.post(
      apiUrl(`/bot${botData.bot_token}/sendMessage`),
      {
        data: { chat_id: botData.companion_chat_id, text: 'Permitted owner status update' },
      },
    );
    expect(ownerPush.status()).toBe(200);

    // Stranger blocks the bot explicitly
    const blockRes = await request.post(apiUrl(`${API_PATHS.bots}/${botId}/block`), {
      headers: authHeaders(stranger.token),
    });
    expect([200, 201]).toContain(blockRes.status());

    // Pushing to blocked stranger MUST return strictly 403 (ZERO 404 masking!)
    const pushRes = await request.post(
      apiUrl(`/bot${botData.bot_token}/sendMessage`),
      {
        data: { chat_id: stranger.userId, text: 'Unsolicited spam' },
        failOnStatusCode: false,
      },
    );
    expect(pushRes.status()).toBe(403);
  });
});
