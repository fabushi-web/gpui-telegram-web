import { test, expect } from '../helpers/fixtures';
import { API_PATHS, DOM } from '../helpers/selectors';
import {
  apiUrl,
  authHeaders,
  registerUserViaApi,
} from '../helpers/server';
import { BILINGUAL_PATTERNS, openNavDestination, scopedButton } from '../helpers/ui';

test.describe('Tier 2 — A13: Remote Assist Code Validation, Rate-Limit, Anti-Fake Tailnet/Canvas & Un-Clamped Kill Switch Latency', () => {
  test('A13-T2-01: POST /api/v1/remote/assist/set-code rejects weak codes (digits-only, letters-only, short) with 400 invalid_assist_code', async ({
    request,
  }) => {
    const user = await registerUserViaApi(request);
    const headers = authHeaders(user.token);

    for (const weakCode of ['12345678', 'abcdefgh', 'ab1', 'a1b2c3d4e5f6g7h8i9']) {
      const res = await request.post(apiUrl(API_PATHS.remoteAssistSetCode), {
        headers,
        data: { code: weakCode },
        failOnStatusCode: false,
      });
      expect(res.status()).toBe(400);
      const body = (await res.json()) as { error?: unknown };
      expect(typeof body.error).toBe('string');
      expect(body.error as string).toMatch(/invalid_assist_code|invalid|code/i);
    }
  });

  test('A13-T2-02: POST /api/v1/remote/assist/start returns 404 for unknown ID, 403 when allow_assist: false, and 401/429 on repeated wrong codes', async ({
    request,
  }) => {
    const hostUser = await registerUserViaApi(request);
    const guestUser = await registerUserViaApi(request);
    const hostHeaders = authHeaders(hostUser.token);
    const guestHeaders = authHeaders(guestUser.token);

    // Unknown assist_id -> 404
    const unknownRes = await request.post(apiUrl(API_PATHS.remoteAssistStart), {
      headers: guestHeaders,
      data: { assist_id: '999999999', access_code: 'ValidCode99', mode: 'desktop' },
      failOnStatusCode: false,
    });
    expect(unknownRes.status()).toBe(404);

    const infoRes = await request.get(apiUrl(API_PATHS.remoteAssistInfo), { headers: hostHeaders });
    expect(infoRes.status()).toBe(200);
    const info = (await infoRes.json()) as { assist_id: string };

    // Disabled -> 403 assist_disabled
    const disableRes = await request.post(apiUrl(API_PATHS.remoteAssistAllow), {
      headers: hostHeaders,
      data: { allow_assist: false },
    });
    expect(disableRes.status()).toBe(200);

    const disabledRes = await request.post(apiUrl(API_PATHS.remoteAssistStart), {
      headers: guestHeaders,
      data: { assist_id: info.assist_id, access_code: 'WrongCode12', mode: 'desktop' },
      failOnStatusCode: false,
    });
    expect(disabledRes.status()).toBe(403);

    // Enable and supply wrong code repeatedly -> starts 401 and triggers 429 rate limit
    const enableRes = await request.post(apiUrl(API_PATHS.remoteAssistAllow), {
      headers: hostHeaders,
      data: { allow_assist: true },
    });
    expect(enableRes.status()).toBe(200);

    const setCodeRes = await request.post(apiUrl(API_PATHS.remoteAssistSetCode), {
      headers: hostHeaders,
      data: { code: 'TrueSecret88' },
    });
    expect(setCodeRes.status()).toBe(200);

    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const badRes = await request.post(apiUrl(API_PATHS.remoteAssistStart), {
        headers: guestHeaders,
        data: { assist_id: info.assist_id, access_code: 'BadGuess99', mode: 'desktop' },
        failOnStatusCode: false,
      });
      statuses.push(badRes.status());
    }
    expect(statuses[0]).toBe(401);
    expect(statuses.every((s) => s === 401 || s === 429)).toBe(true);
    expect(statuses).toContain(429);
  });

  test('A13-T2-03: Setting allow_assist: false immediately disconnects active assist_guest sessions', async ({
    request,
  }) => {
    const hostUser = await registerUserViaApi(request);
    const guestUser = await registerUserViaApi(request);
    const hostHeaders = authHeaders(hostUser.token);

    const allowRes = await request.post(apiUrl(API_PATHS.remoteAssistAllow), {
      headers: hostHeaders,
      data: { allow_assist: true },
    });
    expect(allowRes.status()).toBe(200);

    const resetRes = await request.post(apiUrl(API_PATHS.remoteAssistResetCode), {
      headers: hostHeaders,
      data: {},
    });
    expect(resetRes.status()).toBe(200);
    const resetBody = (await resetRes.json()) as { assist_id: string; current_code: string };

    const startRes = await request.post(apiUrl(API_PATHS.remoteAssistStart), {
      headers: authHeaders(guestUser.token),
      data: {
        assist_id: resetBody.assist_id,
        access_code: resetBody.current_code,
        mode: 'desktop',
      },
    });
    expect(startRes.status()).toBe(200);

    // Turning off allow_assist disconnects all active guest sessions
    const disableRes = await request.post(apiUrl(API_PATHS.remoteAssistAllow), {
      headers: hostHeaders,
      data: { allow_assist: false },
    });
    expect(disableRes.status()).toBe(200);

    const sessionsRes = await request.get(apiUrl(API_PATHS.remoteSessions), {
      headers: hostHeaders,
    });
    expect(sessionsRes.status()).toBe(200);
    const sessionsBody = (await sessionsRes.json()) as { sessions?: unknown[] };
    expect(Array.isArray(sessionsBody.sessions)).toBe(true);
    expect(sessionsBody.sessions).toHaveLength(0);
  });

  test('A13-T2-04: POST /api/v1/remote/webrtc/signal rejects missing token (401) and fbrelay_ token missing session_id (400)', async ({
    request,
  }) => {
    const unauth = await request.post(apiUrl(API_PATHS.remoteWebrtcSignal), {
      data: { sender_device_id: 'dev_a', frame: { type: 'offer' } },
      failOnStatusCode: false,
    });
    expect(unauth.status()).toBe(401);

    const hostUser = await registerUserViaApi(request);
    const guestUser = await registerUserViaApi(request);
    const allowRes = await request.post(apiUrl(API_PATHS.remoteAssistAllow), {
      headers: authHeaders(hostUser.token),
      data: { allow_assist: true },
    });
    expect(allowRes.status()).toBe(200);

    const resetRes = await request.post(apiUrl(API_PATHS.remoteAssistResetCode), {
      headers: authHeaders(hostUser.token),
      data: {},
    });
    expect(resetRes.status()).toBe(200);
    const info = (await resetRes.json()) as { assist_id: string; current_code: string };

    const startRes = await request.post(apiUrl(API_PATHS.remoteAssistStart), {
      headers: authHeaders(guestUser.token),
      data: { assist_id: info.assist_id, access_code: info.current_code, mode: 'desktop' },
    });
    expect(startRes.status()).toBe(200);
    const started = (await startRes.json()) as { temp_relay_token: string };
    expect(started.temp_relay_token).toMatch(/^fbrelay_/);

    const missingSessionRes = await request.post(apiUrl(API_PATHS.remoteWebrtcSignal), {
      headers: authHeaders(started.temp_relay_token),
      data: { sender_device_id: 'guest_dev', frame: { type: 'offer' } },
      failOnStatusCode: false,
    });
    expect([400, 401]).toContain(missingSessionRes.status());
  });

  test('A13-T2-05: Unconnected #computer-workbench NEVER renders fake SVG terminal and GET /api/v1/tailnet/status NEVER fabricates 100.64.0.1 connected: true', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;

    const tailnetRes = await request.get(apiUrl(API_PATHS.tailnetStatus), {
      headers: authHeaders(user.token),
      failOnStatusCode: false,
    });
    if (tailnetRes.status() === 200) {
      const tailnet = (await tailnetRes.json()) as {
        connected?: unknown;
        self_ip?: unknown;
        ip?: unknown;
      };
      expect(tailnet.connected).toBe(false);
      expect(tailnet.self_ip ?? tailnet.ip).not.toBe('100.64.0.1');
    } else {
      expect([501, 503]).toContain(tailnetRes.status());
      const errBody = (await tailnetRes.json()) as { error?: unknown };
      expect(typeof errBody.error).toBe('string');
      expect((errBody.error as string).trim().length).toBeGreaterThan(0);
    }

    const workbench = await openNavDestination(page, 'computer');
    const html = await workbench.innerHTML();
    expect(html).not.toContain('uname -a');
    expect(html).not.toContain('100.64.0.1');
  });

  test('A13-T2-06: Kill switch latency display is truthful & un-clamped (injected >= 30ms delay displays >= 15ms, NOT clamped to 9.9ms)', async ({
    authSession,
  }) => {
    const { page } = authSession;
    await openNavDestination(page, 'computer');

    let routeIntercepted = false;
    await page.route('**/api/v1/remote/sessions/disconnect-all', async (route) => {
      routeIntercepted = true;
      await new Promise((r) => setTimeout(r, 40));
      await route.continue();
    });

    const killBtn = page
      .locator(DOM.btnComputerTakeover)
      .or(scopedButton(page.locator(DOM.computerWorkbench), BILINGUAL_PATTERNS.disconnectAll))
      .first();
    await expect(killBtn).toBeVisible();

    const t0 = Date.now();
    const [killRes] = await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes('/api/v1/remote/sessions/disconnect-all') &&
          res.request().method() === 'POST',
        { timeout: 8_000 },
      ),
      killBtn.click(),
    ]);
    const elapsedMs = Date.now() - t0;
    expect(routeIntercepted).toBe(true);
    expect(killRes.status()).toBe(200);
    expect(elapsedMs).toBeGreaterThanOrEqual(30);

    let latencyMatch: RegExpMatchArray | null = null;
    await expect
      .poll(
        async () => {
          const texts = await page
            .locator(
              `${DOM.computerWorkbench}, ${DOM.windowToastBanner}, ${DOM.stageToastPill}`,
            )
            .allInnerTexts();
          latencyMatch = texts.join('\n').match(/(\d+(?:\.\d+)?)\s*ms/i);
          return latencyMatch !== null;
        },
        {
          timeout: 5_000,
          message:
            'Expected un-clamped kill-switch ms latency readout in #computer-workbench or toast banner',
        },
      )
      .toBe(true);

    expect(latencyMatch).not.toBeNull();
    const displayedMs = Number(latencyMatch![1]);
    expect(displayedMs).toBeGreaterThanOrEqual(15);
    expect(displayedMs).not.toBe(9.9);
  });
});
