import * as crypto from 'node:crypto';
import { test, expect } from '../helpers/fixtures';
import { API_PATHS } from '../helpers/selectors';
import {
  apiUrl,
  authHeaders,
  registerUserViaApi,
  sendApiMessage,
} from '../helpers/server';
import {
  buildCodingHostEventFrame,
  buildDetectedCodingProvider,
  extractBotUserId,
  extractCodingHostCommand,
  OpaqueWsClient,
} from '../helpers/api';

test.describe('Tier 2 — A11: Coding Agent Bots Offline 503, Owner-Only Guard, Approval Auto-Expiry & Validation', () => {
  test('A11-T2-01: POST /api/v1/coding-agents/probe when no WS coding host is connected returns truthful 503 Service Unavailable', async ({
    request,
  }) => {
    const owner = await registerUserViaApi(request);
    const res = await request.post(apiUrl(API_PATHS.codingAgentsProbe), {
      headers: authHeaders(owner.token),
      data: { timeout_ms: 1500 },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(503);
  });

  test('A11-T2-02: Non-owner group member attempting coding:approve:... when allow_group_members: false is rejected with 403 owner-only guard', async ({
    request,
  }) => {
    const owner = await registerUserViaApi(request, { firstName: 'Guard Owner' });
    const peer = await registerUserViaApi(request, { firstName: 'Group Member' });
    const deviceId = `dev_owner_guard_${crypto.randomBytes(4).toString('hex')}`;

    const botRes = await request.post(apiUrl(API_PATHS.fabushiBots), {
      headers: authHeaders(owner.token),
      data: {
        display_name: 'Guarded Coding Bot',
        username: `guard_code_${Date.now().toString(36)}_bot`,
        coding_agent: {
          provider_kind: 'claude_code',
          workspace_path: '/workspace/secure',
          use_worktree: false,
          permission_mode: 'ask',
          extra_args: [],
          bound_device_id: deviceId,
          allow_group_members: false,
        },
      },
    });
    expect([200, 201]).toContain(botRes.status());
    const botData = (await botRes.json()) as {
      bot?: { bot_user_id?: number; id?: number; user_id?: number; username?: string };
      registry?: { bot_user_id?: number };
    };
    const botUserId = extractBotUserId(botData);
    expect(typeof botData.bot?.username).toBe('string');
    const botUsername = botData.bot!.username!;

    // Create group containing BOTH the non-owner peer and the coding bot
    const grpRes = await request.post(apiUrl(API_PATHS.chatsCreate), {
      headers: authHeaders(owner.token),
      data: {
        chat_type: 'group',
        title: 'Owner Only Coding Group',
        member_ids: [peer.userId, botUserId],
        client_nonce: crypto.randomUUID(),
      },
    });
    expect([200, 201]).toContain(grpRes.status());
    const grpBody = (await grpRes.json()) as {
      chat_id?: number;
      id?: number;
      chat?: { chat_id?: number; id?: number };
    };
    const groupChatId = Number(
      grpBody.chat_id ?? grpBody.id ?? grpBody.chat?.chat_id ?? grpBody.chat?.id,
    );
    expect(groupChatId).toBeGreaterThan(0);

    const reqId = `req_${crypto.randomBytes(4).toString('hex')}`;
    const hostWs = await OpaqueWsClient.connect(owner.token);
    try {
      hostWs.send(
        buildCodingHostEventFrame({
          event: 'host_register',
          device_id: deviceId,
          display_name: 'Owner Guard Workstation',
          os_name: 'linux',
          providers: [buildDetectedCodingProvider('claude_code')],
        }),
      );

      // Owner triggers a genuine server StartTurn via @mention in the group
      await sendApiMessage(request, owner.token, groupChatId, `@${botUsername} run unit tests`);
      const startFrame = await hostWs.waitForFrame(
        (f) => extractCodingHostCommand(f)?.cmd === 'start_turn',
        6_000,
        'CodingHostCommand::start_turn in group',
      );
      const startCmd = extractCodingHostCommand(startFrame);
      expect(startCmd).not.toBeNull();
      const turnId = startCmd!.turn_id;
      expect(typeof turnId).toBe('string');
      expect((turnId as string).length).toBeGreaterThan(0);

      hostWs.send(
        buildCodingHostEventFrame({
          event: 'turn_started',
          turn_id: turnId as string,
          provider_session_id: 'sess_guard_1',
          workspace_path: '/workspace/secure',
          worktree_path: null,
          git_branch: 'main',
          turn_idx: 1,
        }),
      );
      hostWs.send(
        buildCodingHostEventFrame({
          event: 'turn_approval_requested',
          turn_id: turnId as string,
          request_id: reqId,
          kind: 'shell_exec',
          title: 'Run unit test suite',
          detail: 'npm run test:unit',
          rule_key: 'shell:npm_test',
        }),
      );

      const nonOwnerCb = await request.post(
        apiUrl(`${API_PATHS.chats}/${groupChatId}/callback`),
        {
          headers: authHeaders(peer.token),
          data: {
            message_id: 0,
            callback_data: `coding:approve:${turnId as string}:${reqId}:once`,
          },
          failOnStatusCode: false,
        },
      );
      expect(nonOwnerCb.status()).toBe(403);
    } finally {
      hostWs.close();
    }
  });

  test('A11-T2-03: Unresolved inline approval card auto-expires when turn_completed arrives (late callback rejected)', async ({
    request,
  }) => {
    const owner = await registerUserViaApi(request);
    const deviceId = `dev_exp_${crypto.randomBytes(4).toString('hex')}`;
    const botRes = await request.post(apiUrl(API_PATHS.fabushiBots), {
      headers: authHeaders(owner.token),
      data: {
        display_name: 'Expiry Coding Bot',
        username: `exp_code_${Date.now().toString(36)}_bot`,
        coding_agent: {
          provider_kind: 'codex',
          workspace_path: '/workspace/exp',
          use_worktree: false,
          permission_mode: 'ask',
          extra_args: [],
          bound_device_id: deviceId,
          allow_group_members: false,
        },
      },
    });
    expect([200, 201]).toContain(botRes.status());
    const botData = (await botRes.json()) as {
      companion_chat_id: number;
      bot?: { bot_user_id?: number; id?: number; user_id?: number };
      registry?: { bot_user_id?: number };
    };
    const botUserId = extractBotUserId(botData);
    expect(botUserId).toBeGreaterThan(0);
    const chatId = Number(botData.companion_chat_id);
    expect(chatId).toBeGreaterThan(0);
    const reqId = `req_exp_${crypto.randomBytes(4).toString('hex')}`;

    const hostWs = await OpaqueWsClient.connect(owner.token);
    try {
      hostWs.send(
        buildCodingHostEventFrame({
          event: 'host_register',
          device_id: deviceId,
          display_name: 'Expiry Test Workstation',
          os_name: 'linux',
          providers: [buildDetectedCodingProvider('codex')],
        }),
      );

      await sendApiMessage(request, owner.token, chatId, 'Edit index.ts module');
      const startFrame = await hostWs.waitForFrame(
        (f) => extractCodingHostCommand(f)?.cmd === 'start_turn',
        6_000,
        'CodingHostCommand::start_turn for expiry check',
      );
      const startCmd = extractCodingHostCommand(startFrame);
      expect(startCmd).not.toBeNull();
      const turnId = startCmd!.turn_id;
      expect(typeof turnId).toBe('string');
      expect((turnId as string).length).toBeGreaterThan(0);

      hostWs.send(
        buildCodingHostEventFrame({
          event: 'turn_started',
          turn_id: turnId as string,
          provider_session_id: 'sess_exp_1',
          workspace_path: '/workspace/exp',
          worktree_path: null,
          git_branch: 'main',
          turn_idx: 1,
        }),
      );
      hostWs.send(
        buildCodingHostEventFrame({
          event: 'turn_approval_requested',
          turn_id: turnId as string,
          request_id: reqId,
          kind: 'file_edit',
          title: 'Write index.ts',
          detail: 'Update src/index.ts',
          rule_key: 'edit:index_ts',
        }),
      );
      hostWs.send(
        buildCodingHostEventFrame({
          event: 'turn_completed',
          turn_id: turnId as string,
          ok: true,
          final_text: 'Turn ended before approval',
          error: null,
          turn_idx: 1,
          checkpoint_ref: null,
        }),
      );

      await new Promise((r) => setTimeout(r, 250));

      const lateCb = await request.post(
        apiUrl(`${API_PATHS.chats}/${chatId}/callback`),
        {
          headers: authHeaders(owner.token),
          data: {
            message_id: 0,
            callback_data: `coding:approve:${turnId as string}:${reqId}:once`,
          },
          failOnStatusCode: false,
        },
      );
      expect([400, 409, 410]).toContain(lateCb.status());
      const errBody = (await lateCb.json()) as { error?: unknown; message?: unknown };
      const errText = errBody.error ?? errBody.message;
      expect(typeof errText).toBe('string');
      expect((errText as string).trim().length).toBeGreaterThan(0);
    } finally {
      hostWs.close();
    }
  });

  test('A11-T2-04: Coding Host WS disconnect automatically marks host offline so subsequent probe returns 503', async ({
    request,
  }) => {
    const owner = await registerUserViaApi(request);
    const deviceId = `dev_disc_${crypto.randomBytes(4).toString('hex')}`;
    const hostWs = await OpaqueWsClient.connect(owner.token);

    try {
      hostWs.send(
        buildCodingHostEventFrame({
          event: 'host_register',
          device_id: deviceId,
          display_name: 'Disconnect Test Workstation',
          os_name: 'linux',
          providers: [buildDetectedCodingProvider('claude_code')],
        }),
      );

      // 1. Prove the host is genuinely online first via live probe round-trip (200)
      const onlineProbePromise = request.post(apiUrl(API_PATHS.codingAgentsProbe), {
        headers: authHeaders(owner.token),
        data: { device_id: deviceId, timeout_ms: 4000 },
      });
      const probeFrame = await hostWs.waitForFrame(
        (f) => extractCodingHostCommand(f)?.cmd === 'probe_providers',
        5_000,
        'CodingHostCommand::probe_providers before disconnect',
      );
      const probeCmd = extractCodingHostCommand(probeFrame);
      expect(probeCmd).not.toBeNull();
      const reqId = probeCmd!.req_id ?? probeCmd!.request_id;
      expect(typeof reqId).toBe('string');
      expect((reqId as string).length).toBeGreaterThan(0);

      hostWs.send(
        buildCodingHostEventFrame({
          event: 'probe_result',
          req_id: reqId as string,
          device_id: deviceId,
          providers: [buildDetectedCodingProvider('claude_code')],
        }),
      );
      const onlineProbeRes = await onlineProbePromise;
      expect(onlineProbeRes.status()).toBe(200);
    } finally {
      hostWs.close();
    }

    await new Promise((r) => setTimeout(r, 250));

    // 2. After WS close, host is offline and probe MUST return 503
    const probeAfterClose = await request.post(apiUrl(API_PATHS.codingAgentsProbe), {
      headers: authHeaders(owner.token),
      data: { device_id: deviceId, timeout_ms: 1000 },
      failOnStatusCode: false,
    });
    expect(probeAfterClose.status()).toBe(503);
  });

  test('A11-T2-05: Invalid provider_kind or permission_mode on POST /api/v1/fabushi-bots rejected with 400', async ({
    request,
  }) => {
    const owner = await registerUserViaApi(request);
    const headers = authHeaders(owner.token);

    const badProvider = await request.post(apiUrl(API_PATHS.fabushiBots), {
      headers,
      data: {
        display_name: 'Invalid Provider Bot',
        username: `bad_prov_${Date.now().toString(36)}_bot`,
        coding_agent: {
          provider_kind: 'nonexistent_provider',
          workspace_path: '/workspace',
          use_worktree: false,
          permission_mode: 'ask',
          extra_args: [],
          allow_group_members: false,
        },
      },
      failOnStatusCode: false,
    });
    expect(badProvider.status()).toBe(400);

    const badMode = await request.post(apiUrl(API_PATHS.fabushiBots), {
      headers,
      data: {
        display_name: 'Invalid Mode Bot',
        username: `bad_mode_${Date.now().toString(36)}_bot`,
        coding_agent: {
          provider_kind: 'claude_code',
          workspace_path: '/workspace',
          use_worktree: false,
          permission_mode: 'root_shell_bypass',
          extra_args: [],
          allow_group_members: false,
        },
      },
      failOnStatusCode: false,
    });
    expect(badMode.status()).toBe(400);
  });

  test('A11-T2-06: Coding turn cancellation (/stop) dispatches cancel_turn cleanly without stuck activity', async ({
    request,
  }) => {
    const owner = await registerUserViaApi(request);
    const deviceId = `dev_cancel_${crypto.randomBytes(4).toString('hex')}`;
    const botRes = await request.post(apiUrl(API_PATHS.fabushiBots), {
      headers: authHeaders(owner.token),
      data: {
        display_name: 'Cancelable Coding Bot',
        username: `cancel_code_${Date.now().toString(36)}_bot`,
        coding_agent: {
          provider_kind: 'cursor_cli',
          workspace_path: '/workspace/cancel',
          use_worktree: false,
          permission_mode: 'ask',
          extra_args: [],
          bound_device_id: deviceId,
          allow_group_members: false,
        },
      },
    });
    expect([200, 201]).toContain(botRes.status());
    const botData = (await botRes.json()) as {
      companion_chat_id: number;
      bot?: { bot_user_id?: number; id?: number; user_id?: number };
      registry?: { bot_user_id?: number };
    };
    const chatId = Number(botData.companion_chat_id);
    expect(chatId).toBeGreaterThan(0);

    const hostWs = await OpaqueWsClient.connect(owner.token);
    try {
      hostWs.send(
        buildCodingHostEventFrame({
          event: 'host_register',
          device_id: deviceId,
          display_name: 'Cancel Test Workstation',
          os_name: 'linux',
          providers: [buildDetectedCodingProvider('cursor_cli')],
        }),
      );

      // Start an active turn first so /stop cancels a real server-tracked turn_id
      await sendApiMessage(request, owner.token, chatId, 'Long running refactor task');
      const startFrame = await hostWs.waitForFrame(
        (f) => extractCodingHostCommand(f)?.cmd === 'start_turn',
        6_000,
        'CodingHostCommand::start_turn before /stop',
      );
      const startCmd = extractCodingHostCommand(startFrame);
      expect(startCmd).not.toBeNull();
      const turnId = startCmd!.turn_id;
      expect(typeof turnId).toBe('string');
      expect((turnId as string).length).toBeGreaterThan(0);

      hostWs.send(
        buildCodingHostEventFrame({
          event: 'turn_started',
          turn_id: turnId as string,
          provider_session_id: 'sess_cancel_1',
          workspace_path: '/workspace/cancel',
          worktree_path: null,
          git_branch: 'main',
          turn_idx: 1,
        }),
      );

      const stopMsg = await sendApiMessage(request, owner.token, chatId, '/stop');
      expect(stopMsg.messageId).toBeGreaterThan(0);

      const cancelFrame = await hostWs.waitForFrame(
        (f) => extractCodingHostCommand(f)?.cmd === 'cancel_turn',
        6_000,
        'CodingHostCommand::cancel_turn',
      );
      const cancelCmd = extractCodingHostCommand(cancelFrame);
      expect(cancelCmd).not.toBeNull();
      expect(cancelCmd!.turn_id).toBe(turnId);
    } finally {
      hostWs.close();
    }
  });
});
