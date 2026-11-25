import * as crypto from 'node:crypto';
import { test, expect } from '../helpers/fixtures';
import { API_PATHS, DOM } from '../helpers/selectors';
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
import { selectChat } from '../helpers/ui';

const CODING_PROVIDERS = [
  'claude_code',
  'codex',
  'open_code',
  'cursor_cli',
  'antigravity',
  'acp_custom',
] as const;

test.describe('Tier 1 — A11: Third-Party Coding Agent Bots (gpui_telegram_coding Parity)', () => {
  test('A11-T1-01: Create & patch Coding Agent Bot (POST/PATCH /api/v1/fabushi-bots with coding_agent config)', async ({
    request,
  }) => {
    const owner = await registerUserViaApi(request);
    const headers = authHeaders(owner.token);

    const createRes = await request.post(apiUrl(API_PATHS.fabushiBots), {
      headers,
      data: {
        display_name: 'Claude Code Repo Bot',
        username: `claude_repo_${Date.now().toString(36)}_bot`,
        coding_agent: {
          provider_kind: 'claude_code',
          workspace_path: '/workspace/fabushi-web',
          use_worktree: true,
          permission_mode: 'ask',
          extra_args: [],
          allow_group_members: false,
        },
      },
    });
    expect([200, 201]).toContain(createRes.status());
    const created = (await createRes.json()) as {
      bot?: { bot_user_id?: number; id?: number; user_id?: number };
      registry?: {
        bot_user_id?: number;
        coding_agent?: { provider_kind?: string; permission_mode?: string };
      };
      companion_chat_id?: number;
    };
    const botId = extractBotUserId(created);
    expect(botId).toBeGreaterThan(0);
    expect(created.registry?.coding_agent?.provider_kind).toBe('claude_code');
    expect(created.registry?.coding_agent?.permission_mode).toBe('ask');

    const patchRes = await request.patch(apiUrl(`${API_PATHS.fabushiBots}/${botId}`), {
      headers,
      data: {
        coding_agent: {
          provider_kind: 'claude_code',
          workspace_path: '/workspace/fabushi-web',
          use_worktree: true,
          permission_mode: 'auto_edit',
          extra_args: ['--verbose'],
          allow_group_members: false,
        },
      },
    });
    expect(patchRes.status()).toBe(200);
    const patched = (await patchRes.json()) as {
      registry?: { coding_agent?: { permission_mode?: string } };
    };
    expect(patched.registry?.coding_agent?.permission_mode).toBe('auto_edit');
  });

  test('A11-T1-02: WS Coding Host registration (host_register) + live POST /api/v1/coding-agents/probe returning 200 with detected providers', async ({
    request,
  }) => {
    const owner = await registerUserViaApi(request);
    const deviceId = `dev_coding_${crypto.randomBytes(4).toString('hex')}`;
    const hostWs = await OpaqueWsClient.connect(owner.token);

    try {
      hostWs.send(
        buildCodingHostEventFrame({
          event: 'host_register',
          device_id: deviceId,
          display_name: 'E2E Coding Workstation',
          os_name: 'linux',
          providers: [
            buildDetectedCodingProvider('claude_code'),
            buildDetectedCodingProvider('codex'),
          ],
        }),
      );

      // Handle server-dispatched probe_providers command on host WS
      const probePromise = request.post(apiUrl(API_PATHS.codingAgentsProbe), {
        headers: authHeaders(owner.token),
        data: { device_id: deviceId, timeout_ms: 5000 },
      });

      const probeFrame = await hostWs.waitForFrame(
        (f) => extractCodingHostCommand(f)?.cmd === 'probe_providers',
        5_000,
        'CodingHostCommand::probe_providers',
      );
      const cmd = extractCodingHostCommand(probeFrame);
      expect(cmd).not.toBeNull();
      const reqId = cmd!.req_id ?? cmd!.request_id;
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

      const probeRes = await probePromise;
      expect(probeRes.status()).toBe(200);
      const probeBody = (await probeRes.json()) as {
        ok?: boolean;
        device_id?: string;
        providers?: Array<{ kind?: string; provider_kind?: string; installed?: boolean }>;
      };
      expect(probeBody.ok).toBe(true);
      expect(probeBody.device_id).toBe(deviceId);
      expect(Array.isArray(probeBody.providers)).toBe(true);
      expect(
        probeBody.providers!.some(
          (p) => (p.kind ?? p.provider_kind) === 'claude_code' && p.installed === true,
        ),
      ).toBe(true);
    } finally {
      hostWs.close();
    }
  });

  test('A11-T1-03: End-to-end Coding Agent turn over WS (StartTurn <-> turn_started/turn_text_delta/turn_tool_step/turn_completed) rendering streaming output', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const deviceId = `dev_turn_${crypto.randomBytes(4).toString('hex')}`;
    const botRes = await request.post(apiUrl(API_PATHS.fabushiBots), {
      headers: authHeaders(user.token),
      data: {
        display_name: 'Stream Codex Bot',
        username: `stream_codex_${Date.now().toString(36)}_bot`,
        coding_agent: {
          provider_kind: 'codex',
          workspace_path: '/workspace/app',
          use_worktree: false,
          permission_mode: 'auto_edit',
          extra_args: [],
          bound_device_id: deviceId,
          allow_group_members: false,
        },
      },
    });
    expect([200, 201]).toContain(botRes.status());
    const botData = (await botRes.json()) as {
      bot?: { bot_user_id?: number; id?: number; user_id?: number };
      registry?: { bot_user_id?: number };
      companion_chat_id?: number;
    };
    const chatId = Number(botData.companion_chat_id);
    const botUserId = extractBotUserId(botData);
    expect(chatId).toBeGreaterThan(0);
    expect(botUserId).toBeGreaterThan(0);

    const hostWs = await OpaqueWsClient.connect(user.token);
    try {
      hostWs.send(
        buildCodingHostEventFrame({
          event: 'host_register',
          device_id: deviceId,
          display_name: 'E2E Codex Workstation',
          os_name: 'linux',
          providers: [buildDetectedCodingProvider('codex')],
        }),
      );

      await page.reload({ waitUntil: 'domcontentloaded' });
      await selectChat(page, 'Stream Codex Bot');

      // Send prompt message to trigger genuine server StartTurn command to host
      await sendApiMessage(request, user.token, chatId, 'Refactor parser module');

      const startFrame = await hostWs.waitForFrame(
        (f) => extractCodingHostCommand(f)?.cmd === 'start_turn',
        6_000,
        'CodingHostCommand::start_turn',
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
          provider_session_id: 'sess_e2e_1',
          workspace_path: '/workspace/app',
          worktree_path: null,
          git_branch: 'main',
          turn_idx: 1,
        }),
      );
      hostWs.send(
        buildCodingHostEventFrame({
          event: 'turn_tool_step',
          turn_id: turnId as string,
          call_id: 'call_patch_1',
          tool_name: 'apply_patch',
          title: 'Updated parser.ts (+14/-3)',
          status: 'completed',
          output_preview: '+14/-3 lines',
        }),
      );
      hostWs.send(
        buildCodingHostEventFrame({
          event: 'turn_text_delta',
          turn_id: turnId as string,
          delta: 'Refactored parser cleanly with zero regressions.',
        }),
      );
      hostWs.send(
        buildCodingHostEventFrame({
          event: 'turn_completed',
          turn_id: turnId as string,
          ok: true,
          final_text: 'Refactored parser cleanly with zero regressions.',
          error: null,
          turn_idx: 1,
          checkpoint_ref: null,
          diff_stat: {
            files_changed: 1,
            insertions: 14,
            deletions: 3,
            changed_files: ['src/parser.ts'],
          },
          token_usage: {
            input_tokens: 420,
            output_tokens: 185,
            cached_tokens: 0,
            cost_usd: 0.0042,
          },
        }),
      );

      await expect(
        page.locator(DOM.messageList).locator(DOM.messageBubble).filter({
          hasText: 'Refactored parser cleanly with zero regressions.',
        }),
      ).toBeVisible({ timeout: 8_000 });
    } finally {
      hostWs.close();
    }
  });

  test('A11-T1-04: Interactive inline approval card (turn_approval_requested) -> owner clicks coding:approve:...:once -> host receives ResolveApproval', async ({
    request,
  }) => {
    const owner = await registerUserViaApi(request);
    const deviceId = `dev_appr_${crypto.randomBytes(4).toString('hex')}`;
    const botRes = await request.post(apiUrl(API_PATHS.fabushiBots), {
      headers: authHeaders(owner.token),
      data: {
        display_name: 'Approval Coding Bot',
        username: `appr_code_${Date.now().toString(36)}_bot`,
        coding_agent: {
          provider_kind: 'claude_code',
          workspace_path: '/workspace/app',
          use_worktree: true,
          permission_mode: 'ask',
          extra_args: [],
          bound_device_id: deviceId,
          allow_group_members: false,
        },
      },
    });
    expect([200, 201]).toContain(botRes.status());
    const botData = (await botRes.json()) as {
      bot?: { bot_user_id?: number; id?: number; user_id?: number };
      registry?: { bot_user_id?: number };
      companion_chat_id?: number;
    };
    const chatId = Number(botData.companion_chat_id);
    const botUserId = extractBotUserId(botData);
    expect(chatId).toBeGreaterThan(0);
    expect(botUserId).toBeGreaterThan(0);

    const hostWs = await OpaqueWsClient.connect(owner.token);
    try {
      hostWs.send(
        buildCodingHostEventFrame({
          event: 'host_register',
          device_id: deviceId,
          display_name: 'E2E Approval Workstation',
          os_name: 'linux',
          providers: [buildDetectedCodingProvider('claude_code')],
        }),
      );

      await sendApiMessage(request, owner.token, chatId, 'Run npm test in repo');
      const startFrame = await hostWs.waitForFrame(
        (f) => extractCodingHostCommand(f)?.cmd === 'start_turn',
        6_000,
        'CodingHostCommand::start_turn',
      );
      const startCmd = extractCodingHostCommand(startFrame);
      expect(startCmd).not.toBeNull();
      const turnId = startCmd!.turn_id;
      expect(typeof turnId).toBe('string');
      expect((turnId as string).length).toBeGreaterThan(0);

      const requestId = `req_${crypto.randomBytes(4).toString('hex')}`;
      hostWs.send(
        buildCodingHostEventFrame({
          event: 'turn_started',
          turn_id: turnId as string,
          provider_session_id: 'sess_appr_1',
          workspace_path: '/workspace/app',
          worktree_path: null,
          git_branch: 'main',
          turn_idx: 1,
        }),
      );
      hostWs.send(
        buildCodingHostEventFrame({
          event: 'turn_approval_requested',
          turn_id: turnId as string,
          request_id: requestId,
          kind: 'shell_exec',
          title: 'Run unit tests',
          detail: 'npm run test:unit',
          rule_key: 'shell:npm_test',
        }),
      );

      const cbRes = await request.post(apiUrl(`${API_PATHS.chats}/${chatId}/callback`), {
        headers: authHeaders(owner.token),
        data: {
          message_id: 0,
          callback_data: `coding:approve:${turnId as string}:${requestId}:once`,
        },
      });
      expect(cbRes.status()).toBe(200);

      const resolvedFrame = await hostWs.waitForFrame(
        (f) => {
          const cmd = extractCodingHostCommand(f);
          return cmd?.cmd === 'resolve_approval' && cmd.request_id === requestId;
        },
        6_000,
        'CodingHostCommand::resolve_approval',
      );
      const resolvedCmd = extractCodingHostCommand(resolvedFrame);
      expect(resolvedCmd).not.toBeNull();
      expect(resolvedCmd!.turn_id).toBe(turnId);
      expect(resolvedCmd!.request_id).toBe(requestId);
      expect(resolvedCmd!.decision).toBe('allow_once');
    } finally {
      hostWs.close();
    }
  });

  test('A11-T1-05: Coding permission mode switch callback (coding:mode:{bot_user_id}:auto_edit) & native slash commands (/status, /mode, /workspace, /help)', async ({
    request,
  }) => {
    const owner = await registerUserViaApi(request);
    const deviceId = `dev_mode_${crypto.randomBytes(4).toString('hex')}`;
    const botRes = await request.post(apiUrl(API_PATHS.fabushiBots), {
      headers: authHeaders(owner.token),
      data: {
        display_name: 'Mode Switch Coding Bot',
        username: `mode_code_${Date.now().toString(36)}_bot`,
        coding_agent: {
          provider_kind: 'open_code',
          workspace_path: '/workspace/service',
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
      bot?: { bot_user_id?: number; id?: number; user_id?: number };
      registry?: { bot_user_id?: number };
      companion_chat_id?: number;
    };
    const chatId = Number(botData.companion_chat_id);
    const botUserId = extractBotUserId(botData);
    expect(chatId).toBeGreaterThan(0);
    expect(botUserId).toBeGreaterThan(0);

    const modeCbRes = await request.post(apiUrl(`${API_PATHS.chats}/${chatId}/callback`), {
      headers: authHeaders(owner.token),
      data: {
        message_id: 0,
        callback_data: `coding:mode:${botUserId}:auto_edit`,
      },
    });
    expect(modeCbRes.status()).toBe(200);

    const getBotRes = await request.get(apiUrl(`${API_PATHS.fabushiBots}/${botUserId}`), {
      headers: authHeaders(owner.token),
    });
    expect(getBotRes.status()).toBe(200);
    expect(await getBotRes.text()).toContain('auto_edit');

    const hostWs = await OpaqueWsClient.connect(owner.token);
    try {
      hostWs.send(
        buildCodingHostEventFrame({
          event: 'host_register',
          device_id: deviceId,
          display_name: 'E2E Slash Cmd Host',
          os_name: 'linux',
          providers: [buildDetectedCodingProvider('open_code')],
        }),
      );

      // Respond once per host-forwarded CodingHostCommand::control req_id
      const handledReqIds = new Set<string>();
      const respondPendingControl = async (fromIdx: number) => {
        const frames = hostWs.getFrames().slice(fromIdx);
        for (const frame of frames) {
          const cmd = extractCodingHostCommand(frame);
          if (
            cmd?.cmd === 'control' &&
            typeof cmd.req_id === 'string' &&
            !handledReqIds.has(cmd.req_id)
          ) {
            handledReqIds.add(cmd.req_id);
            hostWs.send(
              buildCodingHostEventFrame({
                event: 'control_result',
                req_id: cmd.req_id,
                ok: true,
                markdown_reply: 'Workspace: /workspace/service | Mode: auto_edit',
              }),
            );
          }
        }
      };

      const fetchBotReplies = async () => {
        const res = await request.get(apiUrl(`${API_PATHS.chats}/${chatId}/messages`), {
          headers: authHeaders(owner.token),
        });
        expect(res.status()).toBe(200);
        const body = (await res.json()) as {
          messages?: Array<{ sender_id?: number; text?: string }>;
        };
        expect(Array.isArray(body.messages)).toBe(true);
        return body.messages!.filter((m) => Number(m.sender_id) === botUserId);
      };

      let expectedReplyCount = (await fetchBotReplies()).length;
      for (const cmd of ['/help', '/mode', '/status', '/workspace']) {
        const cursor = hostWs.getFrameCount();
        const msg = await sendApiMessage(request, owner.token, chatId, cmd);
        expect(msg.messageId).toBeGreaterThan(0);
        expectedReplyCount += 1;

        await expect
          .poll(
            async () => {
              await respondPendingControl(cursor);
              return (await fetchBotReplies()).length;
            },
            {
              timeout: 6_000,
              message: `Expected real coding bot reply persisted for slash command "${cmd}"`,
            },
          )
          .toBeGreaterThanOrEqual(expectedReplyCount);
      }

      const finalRepliesText = (await fetchBotReplies())
        .map((r) => r.text ?? '')
        .join('\n');
      expect(finalRepliesText).toMatch(/auto_edit|workspace|\/status|\/help/i);
    } finally {
      hostWs.close();
    }
  });

  test('A11-T1-06: Support across all 6 CodingProviderKind values (claude_code, codex, open_code, cursor_cli, antigravity, acp_custom)', async ({
    request,
  }) => {
    const owner = await registerUserViaApi(request);
    const headers = authHeaders(owner.token);

    for (const provider of CODING_PROVIDERS) {
      const res = await request.post(apiUrl(API_PATHS.fabushiBots), {
        headers,
        data: {
          display_name: `Bot ${provider}`,
          username: `prov_${provider}_${Date.now().toString(36).slice(-4)}_bot`,
          coding_agent: {
            provider_kind: provider,
            workspace_path: `/workspace/${provider}`,
            use_worktree: false,
            permission_mode: 'ask',
            extra_args: [],
            allow_group_members: false,
          },
        },
      });
      expect([200, 201]).toContain(res.status());
      const body = (await res.json()) as {
        registry?: { coding_agent?: { provider_kind?: string } };
      };
      expect(body.registry?.coding_agent?.provider_kind).toBe(provider);
    }
  });
});
