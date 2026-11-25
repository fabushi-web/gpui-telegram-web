import * as crypto from 'node:crypto';
import { test, expect } from '../helpers/fixtures';
import {
  API_PATHS,
  APPLE_COMPOSE_STAGE,
  BOT_PRESTART_BAR,
  DOM,
} from '../helpers/selectors';
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
  extractUpdateEvent,
  OpaqueWsClient,
  startEphemeralOpenAiStub,
} from '../helpers/api';
import {
  BILINGUAL_PATTERNS,
  scopedButton,
  selectChat,
} from '../helpers/ui';

test.describe('Tier 4 — SC-03: Grok Multi-Agent Group, Per-User AI Isolation & Coding Agent Bot Approval Workflow', () => {
  test('SC-03: Create 2 Fabushi Bots (standard + claude_code) -> 1v1 #bot-prestart-bar -> #apple-compose-stage multi-select group -> 503 PROVIDER_ERROR -> isolated Magpie provider -> WS Coding Host probe/stream/approval -> SharedGroupWorkspace update', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const headers = authHeaders(user.token);
    const otherUser = await registerUserViaApi(request);
    const deviceId = `dev_sc03_${crypto.randomBytes(4).toString('hex')}`;

    // 1. Create standard Fabushi Bot & Claude Code Coding Agent Bot
    const stdBotRes = await request.post(apiUrl(API_PATHS.fabushiBots), {
      headers,
      data: {
        display_name: 'SC03 Planner Bot',
        username: `sc03_plan_${Date.now().toString(36)}_bot`,
        description: 'Architecture coordinator',
      },
    });
    expect([200, 201]).toContain(stdBotRes.status());
    const stdBotData = (await stdBotRes.json()) as {
      bot?: { bot_user_id?: number; id?: number; user_id?: number; username?: string };
      registry?: { bot_user_id?: number };
    };
    expect(extractBotUserId(stdBotData)).toBeGreaterThan(0);
    expect(typeof stdBotData.bot?.username).toBe('string');
    const plannerUsername = stdBotData.bot!.username!;

    const codeBotRes = await request.post(apiUrl(API_PATHS.fabushiBots), {
      headers,
      data: {
        display_name: 'SC03 Claude Code Bot',
        username: `sc03_code_${Date.now().toString(36)}_bot`,
        coding_agent: {
          provider_kind: 'claude_code',
          workspace_path: '/workspace/fabushi-web',
          use_worktree: true,
          permission_mode: 'ask',
          extra_args: [],
          bound_device_id: deviceId,
          allow_group_members: false,
        },
      },
    });
    expect([200, 201]).toContain(codeBotRes.status());
    const codeBot = (await codeBotRes.json()) as {
      bot?: { bot_user_id?: number; id?: number; user_id?: number };
      registry?: { bot_user_id?: number };
      companion_chat_id: number;
    };
    const codeBotId = extractBotUserId(codeBot);
    expect(codeBotId).toBeGreaterThan(0);
    expect(Number(codeBot.companion_chat_id)).toBeGreaterThan(0);

    // 2. Open unstarted 1:1 bot chat -> #bot-prestart-bar -> START reveals composer
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, 'SC03 Planner Bot');
    await expect(page.locator(BOT_PRESTART_BAR)).toBeVisible();
    await scopedButton(page.locator(BOT_PRESTART_BAR), BILINGUAL_PATTERNS.startBot)
      .first()
      .click();
    await expect(page.locator(DOM.messageComposerInput)).toBeVisible();

    // 3. Use #apple-compose-stage (+) multi-select to form an auto-titled multi-agent group
    await page.locator(DOM.btnNewChatFab).click();
    const stage = page.locator(APPLE_COMPOSE_STAGE);
    await expect(stage).toBeVisible();
    const search = stage.locator('input').first();
    await search.fill('SC03 Planner Bot');
    await stage.getByText('SC03 Planner Bot').first().click();
    await search.fill('SC03 Claude Code Bot');
    await stage.getByText('SC03 Claude Code Bot').first().click();
    await page.locator(DOM.messageComposerInput).fill('Coordinate release PR review');
    await page.locator(DOM.messageComposerInput).press('Enter');
    await expect(stage).toBeHidden();

    // Locate the newly created multi-agent group chat_id
    const chatsRes = await request.get(apiUrl(API_PATHS.chats), { headers });
    expect(chatsRes.status()).toBe(200);
    const chatsBody = (await chatsRes.json()) as {
      chats?: Array<{ id?: number; chat_id?: number; title?: string }>;
    };
    expect(Array.isArray(chatsBody.chats)).toBe(true);
    const multiGroup = chatsBody.chats!.find((c) =>
      /SC03 Planner Bot|SC03 Claude Code Bot/.test(String(c.title ?? '')),
    );
    expect(multiGroup).toBeTruthy();
    const groupId = Number(multiGroup!.chat_id ?? multiGroup!.id);
    expect(groupId).toBeGreaterThan(0);

    // 4. Verify truthful 503 provider_not_configured before configuring provider
    const zeroTurn = await request.post(apiUrl(API_PATHS.fabushiTurns), {
      headers,
      data: { prompt: 'Draft release notes' },
      failOnStatusCode: false,
    });
    expect(zeroTurn.status()).toBe(503);
    const zeroBody = (await zeroTurn.json()) as {
      error?: string;
      needs_provider_selection?: boolean;
    };
    expect(zeroBody.error).toBe('provider_not_configured');
    expect(zeroBody.needs_provider_selection).toBe(true);

    // 5. Configure per-user Magpie provider backed by ephemeral OpenAI stub and verify strict isolation from otherUser
    const stub = await startEphemeralOpenAiStub((call) => {
      if (call.index === 0) {
        return {
          tool_calls: [
            {
              id: 'call_sc03_ws_1',
              type: 'function',
              function: {
                name: 'group_workspace_write',
                arguments: JSON.stringify({
                  chat_id: groupId,
                  key: 'release_status',
                  value: { approved: true },
                  expected_revision: 0,
                }),
              },
            },
          ],
          finish_reason: 'tool_calls',
        };
      }
      return { content: 'Updated release_status in SharedGroupWorkspace.', finish_reason: 'stop' };
    });

    const hostWs = await OpaqueWsClient.connect(user.token);
    try {
      const provRes = await request.post(apiUrl(API_PATHS.magpieProviders), {
        headers,
        data: {
          provider_id: 'e2e_sc03_openai_stub',
          name: 'SC03 Private OpenAI',
          kind: 'openai',
          api_mode: 'chat_completions',
          base_url: stub.baseUrl,
          api_key: 'sk-sc03-private-isolated-123456',
          default_model: 'e2e-multiagent-1',
          enabled: true,
          activate: true,
        },
      });
      expect([200, 201]).toContain(provRes.status());

      const otherStateRes = await request.get(apiUrl(API_PATHS.magpieState), {
        headers: authHeaders(otherUser.token),
      });
      expect(otherStateRes.status()).toBe(200);
      const otherState = (await otherStateRes.json()) as {
        has_configured_provider?: boolean;
        providers?: unknown[];
      };
      expect(otherState.has_configured_provider).toBe(false);
      expect(Array.isArray(otherState.providers)).toBe(true);
      expect(otherState.providers).toHaveLength(0);

      // 6. Connect WS Coding Host -> probe -> genuine server StartTurn -> stream + approval -> owner approves -> turn_completed
      hostWs.send(
        buildCodingHostEventFrame({
          event: 'host_register',
          device_id: deviceId,
          display_name: 'SC03 Linux Host',
          os_name: 'linux',
          providers: [buildDetectedCodingProvider('claude_code')],
        }),
      );

      const probePromise = request.post(apiUrl(API_PATHS.codingAgentsProbe), {
        headers,
        data: { device_id: deviceId, timeout_ms: 5000 },
      });
      const probeFrame = await hostWs.waitForFrame(
        (f) => extractCodingHostCommand(f)?.cmd === 'probe_providers',
        5_000,
        'probe_providers command',
      );
      const probeCmd = extractCodingHostCommand(probeFrame);
      expect(probeCmd).not.toBeNull();
      const probeReqId = probeCmd!.req_id ?? probeCmd!.request_id;
      expect(typeof probeReqId).toBe('string');
      expect((probeReqId as string).length).toBeGreaterThan(0);

      hostWs.send(
        buildCodingHostEventFrame({
          event: 'probe_result',
          req_id: probeReqId as string,
          device_id: deviceId,
          providers: [buildDetectedCodingProvider('claude_code')],
        }),
      );
      expect((await probePromise).status()).toBe(200);

      // Trigger genuine server StartTurn in coding bot companion chat
      await sendApiMessage(request, user.token, codeBot.companion_chat_id, 'Run unit tests');
      const startFrame = await hostWs.waitForFrame(
        (f) => extractCodingHostCommand(f)?.cmd === 'start_turn',
        6_000,
        'CodingHostCommand::start_turn in SC-03',
      );
      const startCmd = extractCodingHostCommand(startFrame);
      expect(startCmd).not.toBeNull();
      const turnId = startCmd!.turn_id;
      expect(typeof turnId).toBe('string');
      expect((turnId as string).length).toBeGreaterThan(0);

      const approvalId = `appr_sc03_${crypto.randomBytes(4).toString('hex')}`;

      hostWs.send(
        buildCodingHostEventFrame({
          event: 'turn_started',
          turn_id: turnId as string,
          provider_session_id: 'sess_sc03_1',
          workspace_path: '/workspace/fabushi-web',
          worktree_path: null,
          git_branch: 'main',
          turn_idx: 1,
        }),
      );
      hostWs.send(
        buildCodingHostEventFrame({
          event: 'turn_tool_step',
          turn_id: turnId as string,
          call_id: 'call_sc03_1',
          tool_name: 'shell_exec',
          title: 'Run unit tests',
          status: 'running',
          output_preview: 'npm run test:unit',
        }),
      );
      hostWs.send(
        buildCodingHostEventFrame({
          event: 'turn_approval_requested',
          turn_id: turnId as string,
          request_id: approvalId,
          kind: 'shell_exec',
          title: 'Execute unit tests',
          detail: 'npm run test:unit',
          rule_key: 'shell:npm_test',
        }),
      );

      const cbRes = await request.post(
        apiUrl(`${API_PATHS.chats}/${codeBot.companion_chat_id}/callback`),
        {
          headers,
          data: {
            message_id: 0,
            callback_data: `coding:approve:${turnId as string}:${approvalId}:once`,
          },
        },
      );
      expect(cbRes.status()).toBe(200);

      const resolveFrame = await hostWs.waitForFrame(
        (f) => {
          const cmd = extractCodingHostCommand(f);
          return cmd?.cmd === 'resolve_approval' && cmd.request_id === approvalId;
        },
        6_000,
        'resolve_approval frame',
      );
      const resolvedCmd = extractCodingHostCommand(resolveFrame);
      expect(resolvedCmd).not.toBeNull();
      expect(resolvedCmd!.turn_id).toBe(turnId);
      expect(resolvedCmd!.decision).toBe('allow_once');

      hostWs.send(
        buildCodingHostEventFrame({
          event: 'turn_completed',
          turn_id: turnId as string,
          ok: true,
          final_text: 'All unit tests passed (+0 regressions).',
          error: null,
          turn_idx: 1,
          checkpoint_ref: null,
          diff_stat: {
            files_changed: 2,
            insertions: 12,
            deletions: 4,
            changed_files: ['src/a.ts', 'src/b.ts'],
          },
          token_usage: {
            input_tokens: 512,
            output_tokens: 210,
            cached_tokens: 0,
            cost_usd: 0.002,
          },
        }),
      );

      await selectChat(page, 'SC03 Claude Code Bot');
      await expect(page.locator(DOM.messageList)).toContainText(
        'All unit tests passed (+0 regressions).',
        { timeout: 8_000 },
      );

      // 7. SharedGroupWorkspace update via contracted group_workspace_write tool -> WS AgentWorkspaceUpdated
      await sendApiMessage(
        request,
        user.token,
        groupId,
        `@${plannerUsername} update release_status in shared workspace`,
      );
      const wsUpdatedFrame = await hostWs.waitForFrame(
        (f) => {
          const ev = extractUpdateEvent(f, 'AgentWorkspaceUpdated');
          return ev !== null && Number(ev.chat_id) === groupId && ev.key === 'release_status';
        },
        10_000,
        'UpdateEvent::AgentWorkspaceUpdated for release_status',
      );
      const updated = extractUpdateEvent(wsUpdatedFrame, 'AgentWorkspaceUpdated');
      expect(updated).not.toBeNull();
      expect(Number(updated!.revision)).toBeGreaterThanOrEqual(1);
    } finally {
      hostWs.close();
      await stub.close();
    }
  });
});
