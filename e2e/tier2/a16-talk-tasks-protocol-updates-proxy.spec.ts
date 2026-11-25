import { test, expect } from '../helpers/fixtures';
import { API_PATHS } from '../helpers/selectors';
import {
  apiUrl,
  authHeaders,
  createRealConversationFixture,
  registerUserViaApi,
} from '../helpers/server';

test.describe('Tier 2 — A16: Update Path Traversal 400, Talk/Task/Callback/GIF Anti-Stub Negative Tests', () => {
  test('A16-T2-01: GET /api/v1/updates/assets path traversal and disallowed filename/tag rejected with 400', async ({
    request,
  }) => {
    // Valid two-segment route with disallowed extension or dot-dot segment MUST hit allowlist handler and return strictly 400 (ZERO 404 masking!)
    for (const badAllowlistPath of [
      `${API_PATHS.updatesAssets}/v1.6.11/disallowed-asset.bin`,
      `${API_PATHS.updatesAssets}/v1.6.11/Fabushi..invalid.dmg`,
    ]) {
      const res = await request.get(apiUrl(badAllowlistPath), { failOnStatusCode: false });
      expect(res.status()).toBe(400);
      const body = (await res.json()) as { error?: unknown };
      expect(typeof body.error).toBe('string');
      expect((body.error as string).trim().length).toBeGreaterThan(0);
    }

    // Encoded slash traversal must be rejected cleanly (400/403) and never leak files
    for (const traversalPath of [
      `${API_PATHS.updatesAssets}/..%2Fetc/passwd`,
      `${API_PATHS.updatesAssets}/v1.6.11/..%2Fsecret.env`,
    ]) {
      const res = await request.get(apiUrl(traversalPath), { failOnStatusCode: false });
      expect([400, 403]).toContain(res.status());
      expect(await res.text()).not.toContain('root:x:0:0');
    }
  });

  test('A16-T2-02: POST /api/v1/talk/audio without configured STT/LLM pipeline returns honest error (NEVER fake "Heard ..." echo)', async ({
    request,
  }) => {
    const user = await registerUserViaApi(request);
    const res = await request.post(apiUrl(API_PATHS.talkAudio), {
      headers: authHeaders(user.token),
      data: { text: 'Test simulated voice input' },
      failOnStatusCode: false,
    });
    expect([400, 501, 503]).toContain(res.status());
    const body = (await res.json()) as { error?: unknown; message?: unknown };
    expect(JSON.stringify(body)).not.toMatch(/Heard\s+["']?Test simulated/i);
    const errText = body.error ?? body.message;
    expect(typeof errText).toBe('string');
    expect((errText as string).trim().length).toBeGreaterThan(0);
  });

  test('A16-T2-03: POST /api/v1/tasks & PATCH /api/v1/tasks/:id never fabricate synthetic 25%/35%/40% progress or fake initialization logs', async ({
    request,
  }) => {
    const user = await registerUserViaApi(request);
    const headers = authHeaders(user.token);

    const createRes = await request.post(apiUrl(API_PATHS.tasks), {
      headers,
      data: { title: 'Anti-Fudge Progress Audit' },
    });
    expect([200, 201]).toContain(createRes.status());
    const body = (await createRes.json()) as {
      id?: unknown;
      progress?: unknown;
      logs?: unknown;
      task?: { id?: unknown; progress?: unknown; logs?: unknown };
    };
    const taskId = body.id ?? body.task?.id;
    const rawProgress = body.progress ?? body.task?.progress;
    const rawLogs = body.logs ?? body.task?.logs;
    expect(typeof taskId).toBe('string');
    expect((taskId as string).length).toBeGreaterThan(0);
    expect(typeof rawProgress).toBe('number');
    expect(rawProgress).toBe(0);
    expect(Array.isArray(rawLogs)).toBe(true);
    expect(rawLogs as unknown[]).toHaveLength(0);

    // PATCH status -> 'running' MUST NOT fabricate 35%/40% progress or synthetic logs
    const patchRes = await request.patch(apiUrl(`${API_PATHS.tasks}/${taskId as string}`), {
      headers,
      data: { status: 'running' },
    });
    expect(patchRes.status()).toBe(200);
    const patched = (await patchRes.json()) as {
      progress?: unknown;
      logs?: unknown;
      task?: { progress?: unknown; logs?: unknown };
    };
    const patchedProgress = patched.progress ?? patched.task?.progress;
    const patchedLogs = patched.logs ?? patched.task?.logs;
    expect(typeof patchedProgress).toBe('number');
    expect(patchedProgress).toBe(0);
    expect(Array.isArray(patchedLogs)).toBe(true);
    expect(patchedLogs as unknown[]).toHaveLength(0);
  });

  test('A16-T2-04: POST /api/v1/chats/:id/callback with unknown/unhandled callback does NOT fabricate "Callback ... received" stub', async ({
    request,
  }) => {
    const user = await registerUserViaApi(request);
    const conv = await createRealConversationFixture(request, user.token);

    const res = await request.post(
      apiUrl(`${API_PATHS.chats}/${conv.dmChatId}/callback`),
      {
        headers: authHeaders(user.token),
        data: { message_id: 0, callback_data: 'unknown:unhandled:action:999' },
        failOnStatusCode: false,
      },
    );
    expect([400, 422, 501]).toContain(res.status());
    const body = (await res.json()) as { error?: unknown };
    expect(typeof body.error).toBe('string');
    expect((body.error as string).trim().length).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toMatch(/Callback\s+unknown:unhandled/i);
  });

  test('A16-T2-05: Fake SVG GIF endpoint (/api/v1/gifs/svg/rocket) is disabled/absent in production mode', async ({
    request,
  }) => {
    const user = await registerUserViaApi(request);
    const res = await request.get(apiUrl(API_PATHS.gifsSvgRocket), {
      headers: authHeaders(user.token),
      failOnStatusCode: false,
    });
    expect([404, 410, 501]).toContain(res.status());
    expect(await res.text()).not.toContain('<svg');
  });
});
