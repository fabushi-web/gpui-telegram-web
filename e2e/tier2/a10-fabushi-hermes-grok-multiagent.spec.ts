import * as crypto from 'node:crypto';
import { test, expect } from '../helpers/fixtures';
import { API_PATHS, APPLE_COMPOSE_STAGE, DOM } from '../helpers/selectors';
import {
  apiUrl,
  authHeaders,
  createRealConversationFixture,
  registerUserViaApi,
  sendApiMessage,
} from '../helpers/server';
import { selectChat } from '../helpers/ui';
import {
  extractBotUserId,
  extractUpdateEvent,
  OpaqueWsClient,
  startEphemeralOpenAiStub,
} from '../helpers/api';

test.describe('Tier 2 — A10: Fabushi Agent Anti-Stubs, Bot Ownership RBAC, Compose Stage Isolation & Multi-Agent Guardrails', () => {
  test('A10-T2-01: Unimplemented/invalid slash command on POST /api/v1/fabushi/command does NOT return fake "Executed /cmd — ..." stub', async ({
    request,
  }) => {
    const user = await registerUserViaApi(request);
    const headers = authHeaders(user.token);

    // 1. Prove /api/v1/fabushi/command is live with a valid command
    const helpRes = await request.post(apiUrl(API_PATHS.fabushiCommand), {
      headers,
      data: { command: '/help' },
    });
    expect(helpRes.status()).toBe(200);

    // 2. Invalid slash command MUST NOT return fake "Executed /cmd" stub or silent 404 route-miss
    const res = await request.post(apiUrl(API_PATHS.fabushiCommand), {
      headers,
      data: { command: '/nonexistent_fake_stub_cmd' },
      failOnStatusCode: false,
    });
    expect([400, 422, 501]).toContain(res.status());
    const body = (await res.json()) as { error?: unknown; message?: unknown };
    expect(JSON.stringify(body)).not.toMatch(/Executed\s+\/nonexistent_fake_stub_cmd/i);
    const errText = body.error ?? body.message;
    expect(typeof errText).toBe('string');
    expect((errText as string).trim().length).toBeGreaterThan(0);
  });

  test('A10-T2-02: Non-owner attempting PATCH /api/v1/fabushi-bots/:botId receives 403 forbidden; invalid bot username rejected 400', async ({
    request,
  }) => {
    const owner = await registerUserViaApi(request);
    const intruder = await registerUserViaApi(request);

    // Invalid username not ending with 'bot' rejected with 400
    const badUsername = await request.post(apiUrl(API_PATHS.fabushiBots), {
      headers: authHeaders(owner.token),
      data: { display_name: 'Bad Handle', username: 'invalid_handle_no_suffix' },
      failOnStatusCode: false,
    });
    expect(badUsername.status()).toBe(400);

    const createRes = await request.post(apiUrl(API_PATHS.fabushiBots), {
      headers: authHeaders(owner.token),
      data: {
        display_name: 'Owner Locked Bot',
        username: `owner_lock_${Date.now().toString(36)}_bot`,
      },
    });
    expect([200, 201]).toContain(createRes.status());
    const created = (await createRes.json()) as {
      bot?: { bot_user_id?: number; id?: number; user_id?: number };
      registry?: { bot_user_id?: number };
    };
    const botId = extractBotUserId(created);
    expect(botId).toBeGreaterThan(0);

    const patchIntruder = await request.patch(
      apiUrl(`${API_PATHS.fabushiBots}/${botId}`),
      {
        headers: authHeaders(intruder.token),
        data: { description: 'Hijacked description' },
        failOnStatusCode: false,
      },
    );
    expect(patchIntruder.status()).toBe(403);
  });

  test('A10-T2-03: Entering #apple-compose-stage with 0 recipients hides composer, isolates background chat, and Escape restores prior chat without synthetic rows', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.dmTitle);

    const rowCountBefore = await page.locator(DOM.chatList).locator(DOM.chatRow).count();
    await page.locator(DOM.btnNewChatFab).click();

    const stage = page.locator(APPLE_COMPOSE_STAGE);
    await expect(stage).toBeVisible();
    // 0 recipients selected -> composer input hidden and NO synthetic "新信息" row added to chat list
    await expect(page.locator(DOM.messageComposerInput)).toBeHidden();
    await expect(page.locator(DOM.chatList).locator(DOM.chatRow)).toHaveCount(rowCountBefore);
    await expect(page.locator(DOM.chatList)).not.toContainText('新信息');

    await page.keyboard.press('Escape');
    await expect(stage).toBeHidden();
    await expect(page.locator(DOM.chatHeaderTitle)).toContainText(conv.dmTitle);
  });

  test('A10-T2-04: Multi-Agent SharedGroupWorkspace tool write with stale expected_revision returns revision conflict error without overwriting revision 2', async ({
    request,
  }) => {
    const owner = await registerUserViaApi(request);
    const headers = authHeaders(owner.token);

    const botARes = await request.post(apiUrl(API_PATHS.fabushiBots), {
      headers,
      data: {
        display_name: 'Workspace Guard Bot',
        username: `ws_guard_${Date.now().toString(36)}_bot`,
      },
    });
    expect([200, 201]).toContain(botARes.status());
    const botAData = (await botARes.json()) as {
      bot?: { bot_user_id?: number; id?: number; user_id?: number; username?: string };
      registry?: { bot_user_id?: number };
    };
    const botAId = extractBotUserId(botAData);
    expect(typeof botAData.bot?.username).toBe('string');
    const botAUsername = botAData.bot!.username!;

    const botBRes = await request.post(apiUrl(API_PATHS.fabushiBots), {
      headers,
      data: {
        display_name: 'Workspace Peer Bot',
        username: `ws_peer_${Date.now().toString(36)}_bot`,
      },
    });
    expect([200, 201]).toContain(botBRes.status());
    const botBId = extractBotUserId(
      (await botBRes.json()) as {
        bot?: { bot_user_id?: number; id?: number; user_id?: number };
        registry?: { bot_user_id?: number };
      },
    );

    const grpRes = await request.post(apiUrl(API_PATHS.chatsCreate), {
      headers,
      data: {
        chat_type: 'group',
        title: 'Workspace Conflict Room',
        member_ids: [botAId, botBId],
        client_nonce: crypto.randomUUID(),
      },
    });
    expect([200, 201]).toContain(grpRes.status());
    const grpBody = (await grpRes.json()) as {
      chat_id?: number;
      id?: number;
      chat?: { chat_id?: number; id?: number };
    };
    const groupId = Number(grpBody.chat_id ?? grpBody.id ?? grpBody.chat?.chat_id ?? grpBody.chat?.id);
    expect(groupId).toBeGreaterThan(0);

    // Drive rev 0->1, rev 1->2, stale expected_revision=1 write, then read back to verify intact rev 2
    const stub = await startEphemeralOpenAiStub((call) => {
      if (call.index === 0) {
        return {
          tool_calls: [
            {
              id: 'call_rev_1',
              type: 'function',
              function: {
                name: 'group_workspace_write',
                arguments: JSON.stringify({
                  chat_id: groupId,
                  key: 'shared_plan',
                  value: { step: 1 },
                  expected_revision: 0,
                }),
              },
            },
          ],
          finish_reason: 'tool_calls',
        };
      }
      if (call.index === 1) {
        return {
          tool_calls: [
            {
              id: 'call_rev_2',
              type: 'function',
              function: {
                name: 'group_workspace_write',
                arguments: JSON.stringify({
                  chat_id: groupId,
                  key: 'shared_plan',
                  value: { step: 2 },
                  expected_revision: 1,
                }),
              },
            },
          ],
          finish_reason: 'tool_calls',
        };
      }
      if (call.index === 2) {
        return {
          tool_calls: [
            {
              id: 'call_rev_stale',
              type: 'function',
              function: {
                name: 'group_workspace_write',
                arguments: JSON.stringify({
                  chat_id: groupId,
                  key: 'shared_plan',
                  value: { step: 99 },
                  expected_revision: 1,
                }),
              },
            },
          ],
          finish_reason: 'tool_calls',
        };
      }
      if (call.index === 3) {
        return {
          tool_calls: [
            {
              id: 'call_rev_read',
              type: 'function',
              function: {
                name: 'group_workspace_read',
                arguments: JSON.stringify({
                  chat_id: groupId,
                  key: 'shared_plan',
                }),
              },
            },
          ],
          finish_reason: 'tool_calls',
        };
      }
      return { content: 'Completed optimistic concurrency check.', finish_reason: 'stop' };
    });

    try {
      const provRes = await request.post(apiUrl(API_PATHS.magpieProviders), {
        headers,
        data: {
          provider_id: 'e2e_ws_conflict_stub',
          name: 'E2E Workspace Conflict Stub',
          api_mode: 'chat_completions',
          base_url: stub.baseUrl,
          api_key: 'sk-e2e-ws-conflict-key',
          default_model: 'e2e-multiagent-1',
          enabled: true,
          activate: true,
        },
      });
      expect([200, 201]).toContain(provRes.status());

      await sendApiMessage(
        request,
        owner.token,
        groupId,
        `@${botAUsername} verify shared_plan revision conflict handling`,
      );

      await expect
        .poll(() => stub.calls.length, {
          timeout: 12_000,
          message: 'Expected agent loop to execute 4 workspace tool calls + final reply',
        })
        .toBeGreaterThanOrEqual(5);

      // Call 3 must receive the tool error / revision conflict from stale call 2
      const staleToolMsgs = stub.calls[3].messages.filter((m) => m.role === 'tool');
      expect(staleToolMsgs.length).toBeGreaterThanOrEqual(1);
      const latestStaleResult = JSON.stringify(staleToolMsgs[staleToolMsgs.length - 1]);
      expect(latestStaleResult).toMatch(/conflict|revision|mismatch|expected|409/i);

      // Call 4 must receive group_workspace_read showing intact step 2 (NEVER overwritten to 99)
      const readToolMsgs = stub.calls[4].messages.filter((m) => m.role === 'tool');
      expect(readToolMsgs.length).toBeGreaterThanOrEqual(1);
      const latestReadResult = JSON.stringify(readToolMsgs[readToolMsgs.length - 1]);
      expect(latestReadResult).toContain('2');
      expect(latestReadResult).not.toContain('99');
    } finally {
      await stub.close();
    }
  });

  test('A10-T2-05: Multi-Agent Stage 2 reply gate suppresses [PASS] / NO_REPLY tokens and enforces 5-hop loop budget', async ({
    request,
  }) => {
    const owner = await registerUserViaApi(request);
    const headers = authHeaders(owner.token);

    const botARes = await request.post(apiUrl(API_PATHS.fabushiBots), {
      headers,
      data: {
        display_name: 'Gate Alpha Bot',
        username: `gate_alpha_${Date.now().toString(36)}_bot`,
      },
    });
    expect([200, 201]).toContain(botARes.status());
    const botAData = (await botARes.json()) as {
      bot?: { bot_user_id?: number; id?: number; user_id?: number; username?: string };
      registry?: { bot_user_id?: number };
    };
    const botAId = extractBotUserId(botAData);
    expect(typeof botAData.bot?.username).toBe('string');
    const botAUsername = botAData.bot!.username!;

    const botBRes = await request.post(apiUrl(API_PATHS.fabushiBots), {
      headers,
      data: {
        display_name: 'Gate Beta Bot',
        username: `gate_beta_${Date.now().toString(36)}_bot`,
      },
    });
    expect([200, 201]).toContain(botBRes.status());
    const botBData = (await botBRes.json()) as {
      bot?: { bot_user_id?: number; id?: number; user_id?: number; username?: string };
      registry?: { bot_user_id?: number };
    };
    const botBId = extractBotUserId(botBData);
    expect(typeof botBData.bot?.username).toBe('string');
    const botBUsername = botBData.bot!.username!;

    const grpRes = await request.post(apiUrl(API_PATHS.chatsCreate), {
      headers,
      data: {
        chat_type: 'group',
        title: 'Loop Budget Guard Room',
        member_ids: [botAId, botBId],
        client_nonce: crypto.randomUUID(),
      },
    });
    expect([200, 201]).toContain(grpRes.status());
    const grpBody = (await grpRes.json()) as {
      chat_id?: number;
      id?: number;
      chat?: { chat_id?: number; id?: number };
    };
    const groupId = Number(grpBody.chat_id ?? grpBody.id ?? grpBody.chat?.chat_id ?? grpBody.chat?.id);
    expect(groupId).toBeGreaterThan(0);

    let phase: 'suppress' | 'pingpong' = 'suppress';
    let pingPongTurns = 0;

    const stub = await startEphemeralOpenAiStub((call) => {
      if (phase === 'suppress') {
        if (call.index === 0) {
          return { content: '[PASS]', finish_reason: 'stop' };
        }
        return { content: 'NO_REPLY', finish_reason: 'stop' };
      }
      // Ping-pong phase: alternate botA <-> botB via SendToAgent tool (upstream v1.6.11)
      // or plain @mention fallback, using distinct non-echo wording on every hop
      const hasSendToAgentTool = call.tools.some(
        (t) =>
          (t.function as { name?: string } | undefined)?.name === 'SendToAgent' ||
          t.name === 'SendToAgent',
      );
      let lastUserIdx = -1;
      for (let i = call.messages.length - 1; i >= 0; i -= 1) {
        if (call.messages[i]?.role === 'user') {
          lastUserIdx = i;
          break;
        }
      }
      const hasToolResult = call.messages
        .slice(lastUserIdx + 1)
        .some((m) => m.role === 'tool');

      if (hasSendToAgentTool) {
        if (!hasToolResult) {
          pingPongTurns += 1;
          const targetHandle = pingPongTurns % 2 === 1 ? botBUsername : botAUsername;
          const hopNonce = crypto.randomBytes(4).toString('hex');
          return {
            tool_calls: [
              {
                id: `call_handoff_${pingPongTurns}`,
                type: 'function',
                function: {
                  name: 'SendToAgent',
                  arguments: JSON.stringify({
                    targetId: targetHandle,
                    message: `Turn ${pingPongTurns} handoff payload ${hopNonce}`,
                  }),
                },
              },
            ],
            finish_reason: 'tool_calls',
          };
        }
        return {
          content: `Completed hop ${pingPongTurns} (${crypto.randomBytes(4).toString('hex')})`,
          finish_reason: 'stop',
        };
      }

      // Fallback for servers implementing plain @mention bot-to-bot handoff without SendToAgent in call.tools
      pingPongTurns += 1;
      const targetHandle = pingPongTurns % 2 === 1 ? botBUsername : botAUsername;
      return {
        content: `Stage ${pingPongTurns} token ${crypto.randomBytes(4).toString('hex')} handing off to @${targetHandle}`,
        finish_reason: 'stop',
      };
    });

    const ws = await OpaqueWsClient.connect(owner.token);
    try {
      const provRes = await request.post(apiUrl(API_PATHS.magpieProviders), {
        headers,
        data: {
          provider_id: 'e2e_reply_gate_stub',
          name: 'E2E Reply Gate Stub',
          api_mode: 'chat_completions',
          base_url: stub.baseUrl,
          api_key: 'sk-e2e-reply-gate-key',
          default_model: 'e2e-multiagent-1',
          enabled: true,
          activate: true,
        },
      });
      expect([200, 201]).toContain(provRes.status());

      // Check 1: [PASS] and NO_REPLY sentinel replies MUST be suppressed (0 bot messages posted)
      await sendApiMessage(request, owner.token, groupId, `@${botAUsername} check status alpha`);
      await expect
        .poll(() => stub.calls.length, { timeout: 8_000 })
        .toBeGreaterThanOrEqual(1);

      await sendApiMessage(request, owner.token, groupId, `@${botBUsername} check status beta`);
      await expect
        .poll(() => stub.calls.length, { timeout: 8_000 })
        .toBeGreaterThanOrEqual(2);

      // Wait for floor control to settle after both suppressed turns
      await expect
        .poll(
          () => {
            const floorEvents = ws
              .getFrames()
              .map((f) => extractUpdateEvent(f, 'AgentFloorChanged'))
              .filter((ev): ev is Record<string, unknown> => ev !== null && Number(ev.chat_id) === groupId);
            return floorEvents.length > 0 && floorEvents[floorEvents.length - 1].current_speaker == null;
          },
          { timeout: 6_000, message: 'Expected AgentFloorChanged to settle idle after suppressed turns' },
        )
        .toBe(true);

      const suppressedMsgsRes = await request.get(
        apiUrl(`${API_PATHS.chats}/${groupId}/messages`),
        { headers },
      );
      expect(suppressedMsgsRes.status()).toBe(200);
      const suppressedMsgsBody = (await suppressedMsgsRes.json()) as {
        messages?: Array<{ sender_id?: number; text?: string }>;
      };
      expect(Array.isArray(suppressedMsgsBody.messages)).toBe(true);
      const botMsgsAfterSuppress = suppressedMsgsBody.messages!.filter(
        (m) => Number(m.sender_id) === botAId || Number(m.sender_id) === botBId,
      );
      expect(botMsgsAfterSuppress).toHaveLength(0);
      const suppressedSerialized = JSON.stringify(suppressedMsgsBody.messages);
      expect(suppressedSerialized).not.toContain('[PASS]');
      expect(suppressedSerialized).not.toContain('NO_REPLY');

      // Check 2: 5-hop LoopBudget caps bot-to-bot handoff loop at 2..5 turns with both bots replying
      phase = 'pingpong';
      const cursorBeforeHandoff = ws.getFrameCount();
      await sendApiMessage(request, owner.token, groupId, `@${botAUsername} start handoff loop`);

      const isFloorIdleAfterHandoff = () => {
        const recentFloor = ws
          .getFrames()
          .slice(cursorBeforeHandoff)
          .map((f) => extractUpdateEvent(f, 'AgentFloorChanged'))
          .filter((ev): ev is Record<string, unknown> => ev !== null && Number(ev.chat_id) === groupId);
        const lastFloor = recentFloor[recentFloor.length - 1];
        if (!lastFloor) return false;
        const queueEmpty =
          lastFloor.queued_count == null || Number(lastFloor.queued_count) === 0;
        return lastFloor.current_speaker == null && queueEmpty;
      };

      await expect
        .poll(
          () => pingPongTurns >= 2 && isFloorIdleAfterHandoff(),
          {
            timeout: 12_000,
            message: 'Expected bot-to-bot ping-pong handoff loop (>= 2 turns) to terminate and floor to return idle',
          },
        )
        .toBe(true);

      // Confirm quiescence: ensure pingPongTurns does not increase over a consecutive 500ms window
      // while the floor remains idle with an empty queue (prevents hop-2 early-settle race & catches uncapped loops)
      const quiescenceDeadline = Date.now() + 8_000;
      let quiescent = false;
      while (Date.now() < quiescenceDeadline) {
        const settledTurns = pingPongTurns;
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (pingPongTurns === settledTurns && isFloorIdleAfterHandoff()) {
          quiescent = true;
          break;
        }
        if (pingPongTurns > 5) {
          break;
        }
      }

      expect(pingPongTurns).toBeGreaterThanOrEqual(2);
      expect(pingPongTurns).toBeLessThanOrEqual(5);
      expect(quiescent).toBe(true);

      const postLoopMsgsRes = await request.get(
        apiUrl(`${API_PATHS.chats}/${groupId}/messages`),
        { headers },
      );
      expect(postLoopMsgsRes.status()).toBe(200);
      const postLoopBody = (await postLoopMsgsRes.json()) as {
        messages?: Array<{ sender_id?: number; text?: string }>;
      };
      expect(Array.isArray(postLoopBody.messages)).toBe(true);
      const botLoopReplies = postLoopBody.messages!.filter(
        (m) => Number(m.sender_id) === botAId || Number(m.sender_id) === botBId,
      );
      expect(botLoopReplies.length).toBeGreaterThanOrEqual(2);
      expect(botLoopReplies.length).toBeLessThanOrEqual(5);
      expect(botLoopReplies.some((m) => Number(m.sender_id) === botAId)).toBe(true);
      expect(botLoopReplies.some((m) => Number(m.sender_id) === botBId)).toBe(true);
    } finally {
      ws.close();
      await stub.close();
    }
  });

  test('A10-T2-06: Hermes cron trigger with 0 configured AI providers fails truthfully (503) rather than inserting a fake static message', async ({
    request,
  }) => {
    const user = await registerUserViaApi(request);
    const headers = authHeaders(user.token);

    const createCron = await request.post(apiUrl(API_PATHS.fabushiCron), {
      headers,
      data: {
        name: 'Zero Provider Cron Job',
        schedule: '*/5 * * * *',
        prompt: 'Generate nightly summary',
      },
    });
    expect([200, 201]).toContain(createCron.status());
    const cronData = (await createCron.json()) as { id?: unknown; job?: { id?: unknown } };
    const cronId = cronData.id ?? cronData.job?.id;
    expect(typeof cronId).toBe('string');
    expect((cronId as string).length).toBeGreaterThan(0);

    const runRes = await request.post(
      apiUrl(`${API_PATHS.fabushiCron}/${cronId as string}/run`),
      { headers, failOnStatusCode: false },
    );
    expect([502, 503]).toContain(runRes.status());
    expect(await runRes.text()).not.toContain('Executed scheduled prompt');
  });
});
