import * as crypto from 'node:crypto';
import { test, expect } from '../helpers/fixtures';
import {
  API_PATHS,
  APPLE_COMPOSE_STAGE,
  BOT_PRESTART_BAR,
  CMP_INPUT_WRAP,
  DOM,
} from '../helpers/selectors';
import {
  apiUrl,
  authHeaders,
  registerUserViaApi,
  sendApiMessage,
} from '../helpers/server';
import {
  BILINGUAL_PATTERNS,
  openRightInspector,
  scopedButton,
  selectChat,
} from '../helpers/ui';
import {
  buildCodingHostEventFrame,
  buildDetectedCodingProvider,
  extractBotUserId,
  extractCodingHostCommand,
  extractUpdateEvent,
  OpaqueWsClient,
  startEphemeralOpenAiStub,
} from '../helpers/api';

test.describe('Tier 3 — PW04: Grok Compose + Multi-Agent Workspace, Bot Pre-Start + Inspector & Coding Agent Group RBAC', () => {
  test('PW-10 (A10 x A02 x A03): Grok #apple-compose-stage multi-select (User + 2 Bots) -> auto-titled group -> SharedGroupWorkspace WS sync', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const headers = authHeaders(user.token);

    const bot1Res = await request.post(apiUrl(API_PATHS.fabushiBots), {
      headers,
      data: {
        display_name: 'Planner Bot',
        username: `planner_${Date.now().toString(36)}_bot`,
      },
    });
    const bot2Res = await request.post(apiUrl(API_PATHS.fabushiBots), {
      headers,
      data: {
        display_name: 'Reviewer Bot',
        username: `reviewer_${Date.now().toString(36)}_bot`,
      },
    });
    expect([200, 201]).toContain(bot1Res.status());
    expect([200, 201]).toContain(bot2Res.status());
    const bot1Data = (await bot1Res.json()) as {
      bot?: { bot_user_id?: number; id?: number; user_id?: number; username?: string };
      registry?: { bot_user_id?: number };
    };
    expect(extractBotUserId(bot1Data)).toBeGreaterThan(0);
    expect(typeof bot1Data.bot?.username).toBe('string');
    const plannerUsername = bot1Data.bot!.username!;

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator(DOM.btnNewChatFab).click();
    const stage = page.locator(APPLE_COMPOSE_STAGE);
    await expect(stage).toBeVisible();

    const searchInput = stage.locator('input').first();
    await searchInput.fill('Planner Bot');
    await stage.getByText('Planner Bot').first().click();
    await searchInput.fill('Reviewer Bot');
    await stage.getByText('Reviewer Bot').first().click();

    const composer = page.locator(DOM.messageComposerInput);
    await composer.fill('Kickoff multi-agent planning session');
    await composer.press('Enter');

    await expect(stage).toBeHidden();
    await expect(page.locator(DOM.chatHeaderTitle)).toContainText(/Planner Bot|Reviewer Bot/);

    // Verify group was persisted via chats API
    const chatsRes = await request.get(apiUrl(API_PATHS.chats), { headers });
    expect(chatsRes.status()).toBe(200);
    const chatsBody = (await chatsRes.json()) as {
      chats: Array<{ id?: number; chat_id?: number; title?: string }>;
    };
    expect(Array.isArray(chatsBody.chats)).toBe(true);
    const multiGroup = chatsBody.chats.find((c) =>
      /Planner Bot|Reviewer Bot/.test(String(c.title ?? '')),
    );
    expect(multiGroup).toBeTruthy();
    const groupId = Number(multiGroup!.chat_id ?? multiGroup!.id);
    expect(Number.isFinite(groupId) && groupId > 0).toBe(true);

    // Trigger genuine SharedGroupWorkspace write via contracted Magpie provider + group_workspace_write tool -> WS AgentWorkspaceUpdated
    const stub = await startEphemeralOpenAiStub((call) => {
      if (call.index === 0) {
        return {
          tool_calls: [
            {
              id: 'call_pw10_ws',
              type: 'function',
              function: {
                name: 'group_workspace_write',
                arguments: JSON.stringify({
                  chat_id: groupId,
                  key: 'design_doc',
                  value: { status: 'draft' },
                  expected_revision: 0,
                }),
              },
            },
          ],
          finish_reason: 'tool_calls',
        };
      }
      return { content: 'Stored design_doc in shared workspace.', finish_reason: 'stop' };
    });

    const ws = await OpaqueWsClient.connect(user.token);
    try {
      const provRes = await request.post(apiUrl(API_PATHS.magpieProviders), {
        headers,
        data: {
          provider_id: 'e2e_pw10_openai_stub',
          name: 'PW10 OpenAI Stub',
          api_mode: 'chat_completions',
          base_url: stub.baseUrl,
          api_key: 'sk-e2e-pw10-stub-key',
          default_model: 'e2e-multiagent-1',
          enabled: true,
          activate: true,
        },
      });
      expect([200, 201]).toContain(provRes.status());

      await sendApiMessage(
        request,
        user.token,
        groupId,
        `@${plannerUsername} save design_doc to shared workspace`,
      );

      const wsUpdatedFrame = await ws.waitForFrame(
        (f) => {
          const ev = extractUpdateEvent(f, 'AgentWorkspaceUpdated');
          return ev !== null && Number(ev.chat_id) === groupId && ev.key === 'design_doc';
        },
        10_000,
        'UpdateEvent::AgentWorkspaceUpdated for design_doc',
      );
      const updated = extractUpdateEvent(wsUpdatedFrame, 'AgentWorkspaceUpdated');
      expect(updated).not.toBeNull();
      expect(Number(updated!.revision)).toBeGreaterThanOrEqual(1);
    } finally {
      ws.close();
      await stub.close();
    }
  });

  test('PW-11 (A10 x A07 x A05): Unstarted 1v1 Bot #bot-prestart-bar -> /start -> external MenuButton outside #cmp-input-wrap -> Bot Inspector separation', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const createRes = await request.post(apiUrl(API_PATHS.fabushiBots), {
      headers: authHeaders(user.token),
      data: {
        display_name: 'Separation Check Bot',
        username: `sepcheck_${Date.now().toString(36)}_bot`,
        description: 'Pure 1v1 bot profile verification',
      },
    });
    expect([200, 201]).toContain(createRes.status());

    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, 'Separation Check Bot');

    const prestart = page.locator(BOT_PRESTART_BAR);
    await expect(prestart).toBeVisible();
    await expect(page.locator(DOM.messageComposerInput)).toBeHidden();
    await scopedButton(prestart, BILINGUAL_PATTERNS.startBot).first().click();

    await expect(prestart).toBeHidden();
    await expect(page.locator(DOM.messageComposerInput)).toBeVisible();

    const cmpWrap = page.locator(CMP_INPUT_WRAP);
    await expect(cmpWrap).toBeVisible();
    expect(
      await cmpWrap
        .locator('#composer-bot-menu-btn, [data-testid="bot-menu-button"], button[aria-label*="menu" i]')
        .count(),
    ).toBe(0);

    const externalMenuBtn = page
      .locator('#composer-bot-menu-btn, #composer-bot-slash-btn, #btn-bot-menu, [data-testid*="bot-menu" i]')
      .first();
    await expect(externalMenuBtn).toBeVisible();
    expect(await externalMenuBtn.evaluate((el) => el.closest('#cmp-input-wrap') === null)).toBe(true);

    const rightCol = await openRightInspector(page);
    await expect(rightCol.locator(DOM.rightProfileInfo)).toContainText('Separation Check Bot');
    // Bot profile MUST NEVER show Group Members tab
    await expect(rightCol.locator(DOM.rightTabMembers)).toHaveCount(0);
  });

  test('PW-12 (A11 x A10 x A03): Coding Agent Bot in group chat (allow_group_members: false) -> owner approves turn while non-owner is rejected 403', async ({
    request,
  }) => {
    const owner = await registerUserViaApi(request, { firstName: 'PW12 Owner' });
    const peer = await registerUserViaApi(request, { firstName: 'PW12 Peer' });
    const deviceId = `dev_pw12_${crypto.randomBytes(4).toString('hex')}`;

    // 1. Create coding bot FIRST so we can include botUserId in group membership
    const botRes = await request.post(apiUrl(API_PATHS.fabushiBots), {
      headers: authHeaders(owner.token),
      data: {
        display_name: 'Group Claude Bot',
        username: `grp_claude_${Date.now().toString(36)}_bot`,
        coding_agent: {
          provider_kind: 'claude_code',
          workspace_path: '/workspace/group-repo',
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
      bot?: { bot_user_id?: number; id?: number; user_id?: number; username?: string };
      registry?: { bot_user_id?: number };
    };
    const botUserId = extractBotUserId(botData);
    expect(botUserId).toBeGreaterThan(0);
    expect(typeof botData.bot?.username).toBe('string');
    const botUsername = botData.bot!.username!;

    // 2. Create group containing peer AND botUserId
    const grpRes = await request.post(apiUrl(API_PATHS.chatsCreate), {
      headers: authHeaders(owner.token),
      data: {
        chat_type: 'group',
        title: 'Coding Approval Group',
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

    const reqId = `req_pw12_${crypto.randomBytes(4).toString('hex')}`;
    const hostWs = await OpaqueWsClient.connect(owner.token);
    try {
      hostWs.send(
        buildCodingHostEventFrame({
          event: 'host_register',
          device_id: deviceId,
          display_name: 'PW12 Linux Host',
          os_name: 'linux',
          providers: [buildDetectedCodingProvider('claude_code')],
        }),
      );

      // Owner triggers genuine server StartTurn in the group chat
      await sendApiMessage(request, owner.token, groupChatId, `@${botUsername} Run unit tests`);
      const startFrame = await hostWs.waitForFrame(
        (f) => extractCodingHostCommand(f)?.cmd === 'start_turn',
        6_000,
        'CodingHostCommand::start_turn for PW-12',
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
          provider_session_id: 'sess_pw12_1',
          workspace_path: '/workspace/group-repo',
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
          title: 'Run unit tests',
          detail: 'npm run test:unit',
          rule_key: 'shell:npm_test',
        }),
      );

      // Non-owner group peer rejected 403
      const peerTry = await request.post(
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
      expect(peerTry.status()).toBe(403);

      // Owner succeeds and host receives ResolveApproval
      const ownerTry = await request.post(
        apiUrl(`${API_PATHS.chats}/${groupChatId}/callback`),
        {
          headers: authHeaders(owner.token),
          data: {
            message_id: 0,
            callback_data: `coding:approve:${turnId as string}:${reqId}:once`,
          },
        },
      );
      expect(ownerTry.status()).toBe(200);

      const resolveFrame = await hostWs.waitForFrame(
        (f) => {
          const cmd = extractCodingHostCommand(f);
          return cmd?.cmd === 'resolve_approval' && cmd.request_id === reqId;
        },
        6_000,
        'owner resolve_approval dispatch',
      );
      const resolvedCmd = extractCodingHostCommand(resolveFrame);
      expect(resolvedCmd).not.toBeNull();
      expect(resolvedCmd!.turn_id).toBe(turnId);
      expect(resolvedCmd!.request_id).toBe(reqId);
      expect(resolvedCmd!.decision).toBe('allow_once');
    } finally {
      hostWs.close();
    }
  });
});
