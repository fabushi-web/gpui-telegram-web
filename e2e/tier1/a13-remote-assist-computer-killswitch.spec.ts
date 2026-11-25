import * as crypto from 'node:crypto';
import { test, expect } from '../helpers/fixtures';
import { API_PATHS, DOM, REMOTE_ASSIST_PANEL } from '../helpers/selectors';
import {
  apiUrl,
  authHeaders,
  registerUserViaApi,
} from '../helpers/server';
import {
  bilingualRegex,
  BILINGUAL_PATTERNS,
  openNavDestination,
  scopedButton,
} from '../helpers/ui';

test.describe('Tier 1 — A13: UU-Parity Remote Assist, Real Remote Computer Control & Emergency Kill Switch', () => {
  test('A13-T1-01: GET /api/v1/remote/assist/info returns permanent 9-digit assist_id, reset-code generates temporary code, and #remote-assist-panel renders live values', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const headers = authHeaders(user.token);

    const infoRes = await request.get(apiUrl(API_PATHS.remoteAssistInfo), { headers });
    expect(infoRes.status()).toBe(200);
    const info = (await infoRes.json()) as {
      assist_id: string;
      allow_assist: boolean;
      code_mode: string;
      current_code?: string | null;
    };
    expect(info.assist_id).toMatch(/^\d{9}$/);

    const resetRes = await request.post(apiUrl(API_PATHS.remoteAssistResetCode), {
      headers,
      data: {},
    });
    expect(resetRes.status()).toBe(200);
    const resetBody = (await resetRes.json()) as {
      assist_id: string;
      code_mode: string;
      current_code?: string | null;
    };
    expect(resetBody.assist_id).toBe(info.assist_id);
    expect(resetBody.code_mode).toBe('temporary');
    expect(resetBody.current_code).toBeTruthy();

    await openNavDestination(page, 'computer');
    const assistPanel = page.locator(REMOTE_ASSIST_PANEL);
    await expect(assistPanel).toBeVisible();
    await expect(assistPanel).toContainText(info.assist_id.slice(0, 3));
  });

  test('A13-T1-02: POST /api/v1/remote/assist/set-code (custom 8-16 alphanumeric code) & POST /api/v1/remote/assist/allow toggle', async ({
    request,
  }) => {
    const hostUser = await registerUserViaApi(request);
    const headers = authHeaders(hostUser.token);

    const setRes = await request.post(apiUrl(API_PATHS.remoteAssistSetCode), {
      headers,
      data: { code: 'Fabushi9876' },
    });
    expect(setRes.status()).toBe(200);
    const setBody = (await setRes.json()) as {
      code_mode: string;
      current_code?: string | null;
    };
    expect(setBody.code_mode).toBe('custom');
    // Custom code must be masked/null on read
    expect(setBody.current_code == null).toBe(true);

    const disableRes = await request.post(apiUrl(API_PATHS.remoteAssistAllow), {
      headers,
      data: { allow_assist: false },
    });
    expect(disableRes.status()).toBe(200);
    expect(((await disableRes.json()) as { allow_assist: boolean }).allow_assist).toBe(false);

    const enableRes = await request.post(apiUrl(API_PATHS.remoteAssistAllow), {
      headers,
      data: { allow_assist: true },
    });
    expect(enableRes.status()).toBe(200);
    expect(((await enableRes.json()) as { allow_assist: boolean }).allow_assist).toBe(true);
  });

  test('A13-T1-03: Cross-account POST /api/v1/remote/assist/start -> active session in GET /api/v1/remote/sessions -> single-session disconnect', async ({
    request,
  }) => {
    const hostUser = await registerUserViaApi(request, { firstName: 'Assist Host' });
    const guestUser = await registerUserViaApi(request, { firstName: 'Assist Guest' });
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
    const hostInfo = (await resetRes.json()) as {
      assist_id: string;
      current_code: string;
    };

    const startRes = await request.post(apiUrl(API_PATHS.remoteAssistStart), {
      headers: authHeaders(guestUser.token),
      data: {
        assist_id: hostInfo.assist_id,
        access_code: hostInfo.current_code,
        requester_name: guestUser.firstName,
        mode: 'desktop',
      },
    });
    expect(startRes.status()).toBe(200);
    const started = (await startRes.json()) as {
      session_id: string;
      temp_relay_token: string;
    };
    expect(started.session_id).toMatch(/^rassist_/);
    expect(started.temp_relay_token).toMatch(/^fbrelay_/);

    const listRes = await request.get(apiUrl(API_PATHS.remoteSessions), {
      headers: hostHeaders,
    });
    expect(listRes.status()).toBe(200);
    const listBody = (await listRes.json()) as {
      sessions: Array<{ session_id: string }>;
    };
    expect(listBody.sessions.some((s) => s.session_id === started.session_id)).toBe(true);

    const discRes = await request.post(apiUrl(API_PATHS.remoteSessionsDisconnect), {
      headers: hostHeaders,
      data: { session_id: started.session_id },
    });
    expect(discRes.status()).toBe(200);
    const discBody = (await discRes.json()) as { disconnected: boolean };
    expect(discBody.disconnected).toBe(true);
  });

  test('A13-T1-04: Emergency Kill Switch (POST /api/v1/remote/sessions/disconnect-all & UI #btn-computer-takeover) terminates all active remote sessions', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const guestUser = await registerUserViaApi(request);
    const hostHeaders = authHeaders(user.token);

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
    const info = (await resetRes.json()) as { assist_id: string; current_code: string };

    const startRes = await request.post(apiUrl(API_PATHS.remoteAssistStart), {
      headers: authHeaders(guestUser.token),
      data: {
        assist_id: info.assist_id,
        access_code: info.current_code,
        mode: 'ai_control',
      },
    });
    expect(startRes.status()).toBe(200);

    const killRes = await request.post(apiUrl(API_PATHS.remoteSessionsDisconnectAll), {
      headers: hostHeaders,
      data: {},
    });
    expect(killRes.status()).toBe(200);
    const killBody = (await killRes.json()) as {
      disconnected_count: number;
      kill_switch: boolean;
    };
    expect(killBody.kill_switch).toBe(true);
    expect(killBody.disconnected_count).toBeGreaterThanOrEqual(1);

    const afterListRes = await request.get(apiUrl(API_PATHS.remoteSessions), {
      headers: hostHeaders,
    });
    expect(afterListRes.status()).toBe(200);
    const afterList = (await afterListRes.json()) as { sessions: unknown[] };
    expect(Array.isArray(afterList.sessions)).toBe(true);
    expect(afterList.sessions).toHaveLength(0);

    // Start a second active guest session and terminate it via UI #btn-computer-takeover
    const secondStartRes = await request.post(apiUrl(API_PATHS.remoteAssistStart), {
      headers: authHeaders(guestUser.token),
      data: {
        assist_id: info.assist_id,
        access_code: info.current_code,
        mode: 'desktop',
      },
    });
    expect(secondStartRes.status()).toBe(200);

    await openNavDestination(page, 'computer');
    const killBtn = page
      .locator(DOM.btnComputerTakeover)
      .or(scopedButton(page.locator(DOM.computerWorkbench), BILINGUAL_PATTERNS.disconnectAll))
      .first();
    await expect(killBtn).toBeVisible();

    const [uiKillRes] = await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes('/api/v1/remote/sessions/disconnect-all') &&
          res.request().method() === 'POST',
        { timeout: 8_000 },
      ),
      killBtn.click(),
    ]);
    expect(uiKillRes.status()).toBe(200);

    const afterUiListRes = await request.get(apiUrl(API_PATHS.remoteSessions), {
      headers: hostHeaders,
    });
    expect(afterUiListRes.status()).toBe(200);
    const afterUiList = (await afterUiListRes.json()) as { sessions: unknown[] };
    expect(Array.isArray(afterUiList.sessions)).toBe(true);
    expect(afterUiList.sessions).toHaveLength(0);
  });

  test('A13-T1-05: Real local computer agent registration (POST /api/v1/computers/local/register, poll, commands/:id/complete) & POST /api/v1/remote/webrtc/signal', async ({
    request,
  }) => {
    const user = await registerUserViaApi(request);
    const headers = authHeaders(user.token);
    const nodeId = `node_${crypto.randomBytes(4).toString('hex')}`;

    const regRes = await request.post(apiUrl(API_PATHS.computersLocalRegister), {
      headers,
      data: {
        node_id: nodeId,
        device_id: `dev_${nodeId}`,
        hostname: 'macbook-studio-e2e',
        platform: 'macos',
        capabilities: ['screenshot', 'keyboard', 'mouse', 'terminal'],
      },
    });
    expect([200, 201]).toContain(regRes.status());

    // Dispatch command -> local agent poll -> POST /api/v1/computers/commands/:id/complete
    const cmdPromise = request.post(apiUrl(`${API_PATHS.computers}/${nodeId}/commands`), {
      headers,
      data: { op: { type: 'system_info' }, timeout_ms: 5000 },
    });

    const pollRes = await request.post(apiUrl(API_PATHS.computersLocalPoll), {
      headers,
      data: { node_id: nodeId, timeout_ms: 3000 },
    });
    expect(pollRes.status()).toBe(200);
    const pollBody = (await pollRes.json()) as {
      commands?: Array<{ command_id?: string; id?: string }>;
      command?: { command_id?: string; id?: string };
    };
    const polledCmd = pollBody.command ?? pollBody.commands?.[0];
    const commandId = polledCmd?.command_id ?? polledCmd?.id;
    expect(typeof commandId).toBe('string');
    expect((commandId as string).length).toBeGreaterThan(0);

    const completeRes = await request.post(
      apiUrl(`${API_PATHS.computersCommands}/${commandId as string}/complete`),
      {
        headers,
        data: {
          ok: true,
          result: { hostname: 'macbook-studio-e2e', arch: 'arm64' },
        },
      },
    );
    expect(completeRes.status()).toBe(200);

    const cmdRes = await cmdPromise;
    expect(cmdRes.status()).toBe(200);
    expect(await cmdRes.text()).toContain('macbook-studio-e2e');

    const listComputers = await request.get(apiUrl(API_PATHS.computers), { headers });
    expect(listComputers.status()).toBe(200);
    expect(await listComputers.text()).toContain('macbook-studio-e2e');

    // WebRTC signaling relay accepts authenticated signal payload
    const sigRes = await request.post(apiUrl(API_PATHS.remoteWebrtcSignal), {
      headers,
      data: {
        sender_device_id: `dev_${nodeId}`,
        target_device_id: `dev_${nodeId}`,
        frame: { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n' },
      },
    });
    expect(sigRes.status()).toBe(200);
    expect(((await sigRes.json()) as { relayed?: boolean }).relayed).toBe(true);
  });

  test('A13-T1-06: Truthful empty/disconnected #computer-workbench state (zero fake SVG canvas terminal) and live remote assist panel visibility', async ({
    authSession,
  }) => {
    const { page } = authSession;
    const workbench = await openNavDestination(page, 'computer');
    await expect(workbench).toBeVisible();

    const text = await workbench.innerText();
    expect(text).not.toContain('$ uname -a');
    expect(text).not.toContain('100.64.0.1');
    await expect(workbench).toContainText(
      bilingualRegex('no\\s*connected|disconnected|register|remote\\s*assist', '未连接|暂无设备|远程协助|等待主机'),
    );
    await expect(page.locator(REMOTE_ASSIST_PANEL)).toBeVisible();
  });
});
