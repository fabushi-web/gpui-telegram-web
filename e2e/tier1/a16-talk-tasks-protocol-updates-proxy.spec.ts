import { test, expect } from '../helpers/fixtures';
import { API_PATHS, DOM } from '../helpers/selectors';
import { apiUrl, authHeaders, registerUserViaApi } from '../helpers/server';
import {
  bilingualRegex,
  BILINGUAL_PATTERNS,
  openNavDestination,
  scopedButton,
  type NavDestination,
} from '../helpers/ui';

test.describe('Tier 1 — A16: Talk Mode, Truthful Task Center, Status/Capabilities, Updates Relay & Multi-Workspace Navigation', () => {
  test('A16-T1-01: GET /health ("OK"), GET /api/v1/status (version 1.6.11 + capabilities[]), and CORS exposed MCP headers', async ({
    request,
  }) => {
    const rawHealth = await request.get(apiUrl(API_PATHS.healthRaw));
    expect(rawHealth.status()).toBe(200);
    expect((await rawHealth.text()).trim()).toBe('OK');

    const statusRes = await request.get(apiUrl(API_PATHS.status), {
      headers: { Origin: 'http://127.0.0.1:4173' },
    });
    expect(statusRes.status()).toBe(200);
    const statusBody = (await statusRes.json()) as {
      server?: string;
      status?: string;
      version?: string;
      capabilities?: string[];
    };
    expect(statusBody.version).toBe('1.6.11');
    expect(['ok', 'healthy']).toContain(statusBody.status);
    expect(Array.isArray(statusBody.capabilities)).toBe(true);
    const caps = statusBody.capabilities!;
    for (const requiredCap of [
      'auth',
      'messaging_pts',
      'official_mcp_oauth21',
      'remote_control',
      'remote_assist',
      'hermes_agent',
      'auto_update_relay',
    ]) {
      expect(caps).toContain(requiredCap);
    }

    const rawExpose = statusRes.headers()['access-control-expose-headers'];
    expect(typeof rawExpose).toBe('string');
    const exposeHeaders = rawExpose.toLowerCase();
    expect(exposeHeaders).toContain('mcp-protocol-version');
    expect(exposeHeaders).toContain('mcp-session-id');
    expect(exposeHeaders).toContain('www-authenticate');
  });

  test('A16-T1-02: Truthful Talk Mode (#nav-dest-talk, #talk-mode-orb) with zero simulated voice text input or fake echo', async ({
    authSession,
  }) => {
    const { page } = authSession;
    const talkOrb = await openNavDestination(page, 'talk');
    await expect(talkOrb).toBeVisible();

    const talkText = await talkOrb.innerText();
    expect(talkText).not.toContain('输入模拟语音文本');
    expect(talkText).not.toMatch(/simulated\s*voice\s*text/i);
    await expect(
      talkOrb.locator('input[placeholder*="模拟"], input[placeholder*="simulated" i]'),
    ).toHaveCount(0);
    await expect(talkOrb.locator('button').first()).toBeVisible();
  });

  test('A16-T1-03: Truthful Task Center (#nav-dest-tasks, #task-center-workspace) creating a real task at honest 0% progress & empty logs', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const headers = authHeaders(user.token);

    // Fresh account has 0 fake pre-seeded tasks
    const initialTasksRes = await request.get(apiUrl(API_PATHS.tasks), { headers });
    expect(initialTasksRes.status()).toBe(200);
    const initialTasksBody = (await initialTasksRes.json()) as { tasks?: unknown } | unknown[];
    const initialTasks = Array.isArray(initialTasksBody)
      ? initialTasksBody
      : initialTasksBody.tasks;
    expect(Array.isArray(initialTasks)).toBe(true);
    expect(initialTasks as unknown[]).toHaveLength(0);

    // Create a real task and verify honest 0% progress (no fake 25% floor) & empty logs
    const createRes = await request.post(apiUrl(API_PATHS.tasks), {
      headers,
      data: { title: 'Truthful Zero Progress Task', description: 'Initial real task' },
    });
    expect([200, 201]).toContain(createRes.status());
    const created = (await createRes.json()) as {
      progress?: unknown;
      logs?: unknown;
      task?: { progress?: unknown; logs?: unknown };
    };
    const rawProgress = created.progress ?? created.task?.progress;
    const rawLogs = created.logs ?? created.task?.logs;
    expect(typeof rawProgress).toBe('number');
    expect(rawProgress).toBe(0);
    expect(Array.isArray(rawLogs)).toBe(true);
    expect(rawLogs as unknown[]).toHaveLength(0);

    const workspace = await openNavDestination(page, 'tasks');
    await expect(workspace).toBeVisible();
    await expect(workspace).toContainText('Truthful Zero Progress Task');
    await expect(workspace).not.toContainText('25%');

    // UI task creation flow works cleanly without conditional skip
    const newTaskBtn = scopedButton(
      workspace,
      bilingualRegex('new\\s*task|create\\s*task|add\\s*task', '新建任务|创建任务'),
    ).first();
    await expect(newTaskBtn).toBeVisible();
    await newTaskBtn.click();

    const input = page.locator(`${DOM.taskCenterWorkspace} input, [role="dialog"] input`).first();
    await expect(input).toBeVisible();
    await input.fill('UI Created Truthful Task');
    await scopedButton(
      page.locator(`${DOM.taskCenterWorkspace}, [role="dialog"]`).first(),
      BILINGUAL_PATTERNS.confirm,
    )
      .first()
      .click();
    await expect(workspace).toContainText('UI Created Truthful Task');
  });

  test('A16-T1-04: Auto-update relay endpoint (GET /api/v1/updates/latest-mac.json) returns valid JSON or honest 502 (never fabricated release data)', async ({
    request,
  }) => {
    const res = await request.get(apiUrl(API_PATHS.updatesLatestMac), {
      failOnStatusCode: false,
    });
    const status = res.status();
    const body = (await res.json()) as Record<string, unknown>;
    if (status === 200) {
      expect(typeof body.version).toBe('string');
      expect((body.version as string).length).toBeGreaterThan(0);
      expect(body.version).not.toBe('0.0.0');
    } else {
      expect(status).toBe(502);
      expect(typeof body.error).toBe('string');
      expect(body.error as string).toMatch(/upstream_manifest|update|fetch/i);
    }
  });

  test('A16-T1-05: Clean multi-workspace #nav-rail navigation (chats -> browser -> tasks -> mcp -> talk -> computer -> hermes -> settings) with zero console errors', async ({
    authSession,
  }) => {
    const { page } = authSession;
    const consoleErrors: string[] = [];
    page.on('pageerror', (err) => consoleErrors.push(err.message));

    const destinations: NavDestination[] = [
      'chats',
      'browser',
      'tasks',
      'mcp',
      'talk',
      'computer',
      'hermes',
      'settings',
    ];

    for (const dest of destinations) {
      const panel = await openNavDestination(page, dest);
      await expect(panel).toBeVisible();
    }

    expect(consoleErrors).toEqual([]);
  });
});
