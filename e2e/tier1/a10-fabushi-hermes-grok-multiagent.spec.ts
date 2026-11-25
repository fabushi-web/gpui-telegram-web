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
  createRealConversationFixture,
  registerUserViaApi,
  sendApiMessage,
} from '../helpers/server';
import {
  BILINGUAL_PATTERNS,
  openNavDestination,
  readComposerText,
  scopedButton,
  selectChat,
  sendTextMessage,
} from '../helpers/ui';
import {
  extractBotUserId,
  extractUpdateEvent,
  OpaqueWsClient,
  startEphemeralOpenAiStub,
} from '../helpers/api';

test.describe('Tier 1 — A10: Unified /api/v1/fabushi/* Runtime, Grok Bot UX & Multi-Agent Group Protocol', () => {
  test('A10-T1-01: Canonical /api/v1/fabushi/* & /api/v1/fabushi-bots CRUD cleanly separated from /api/v1/fabushi-miniapp/*', async ({
    request,
  }) => {
    const owner = await registerUserViaApi(request);
    const headers = authHeaders(owner.token);

    const statusRes = await request.get(apiUrl(API_PATHS.fabushiStatus), { headers });
    expect(statusRes.status()).toBe(200);

    const botUsername = `fabushi_crud_${Date.now().toString(36)}_bot`;
    const createRes = await request.post(apiUrl(API_PATHS.fabushiBots), {
      headers,
      data: {
        display_name: 'Architect Agent',
        username: botUsername,
        description: 'System architecture reviewer bot',
        avatar_shape: 'hexagon',
        avatar_color: '#0A84FF',
      },
    });
    expect([200, 201]).toContain(createRes.status());
    const created = (await createRes.json()) as {
      bot?: { bot_user_id?: number; id?: number; user_id?: number; username?: string };
      registry?: { bot_user_id?: number };
      bot_token?: string;
      companion_chat_id?: number;
    };
    const botId = extractBotUserId(created);
    expect(botId).toBeGreaterThan(0);
    expect(created.bot_token).toBeTruthy();
    expect(Number(created.companion_chat_id)).toBeGreaterThan(0);

    const patchRes = await request.patch(apiUrl(`${API_PATHS.fabushiBots}/${botId}`), {
      headers,
      data: { description: 'Updated architecture specialist' },
    });
    expect(patchRes.status()).toBe(200);

    const listRes = await request.get(apiUrl(API_PATHS.fabushiBots), { headers });
    expect(listRes.status()).toBe(200);
    expect(await listRes.text()).toContain(botUsername);

    // Ensure /api/v1/fabushi-miniapp/* namespace serves real WASM bytes cleanly separated from /api/v1/fabushi/*
    const wasmRes = await request.get(apiUrl(API_PATHS.fabushiMiniAppApiWasm), {
      headers,
    });
    expect(wasmRes.status()).toBe(200);
    const wasmBytes = await wasmRes.body();
    expect([...wasmBytes.subarray(0, 4)]).toEqual([0x00, 0x61, 0x73, 0x6d]);
  });

  test('A10-T1-02: #hermes-studio-panel real server-persisted sessions, memory, skills persistence, approvals, and cron job CRUD', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const headers = authHeaders(user.token);

    const sessRes = await request.post(apiUrl(API_PATHS.fabushiSessions), {
      headers,
      data: { title: 'Real Server Persisted Session' },
    });
    expect([200, 201]).toContain(sessRes.status());
    const sessBody = (await sessRes.json()) as {
      id?: unknown;
      session_id?: unknown;
      session?: { id?: unknown };
    };
    const sessionId = sessBody.id ?? sessBody.session_id ?? sessBody.session?.id;
    expect(typeof sessionId).toBe('string');
    expect((sessionId as string).length).toBeGreaterThan(0);

    const listSessRes = await request.get(apiUrl(API_PATHS.fabushiSessions), { headers });
    expect(listSessRes.status()).toBe(200);
    expect(await listSessRes.text()).toContain('Real Server Persisted Session');

    // Memory read + action persistence
    const memGetRes = await request.get(apiUrl(API_PATHS.fabushiMemory), { headers });
    expect(memGetRes.status()).toBe(200);
    const memActRes = await request.post(apiUrl(API_PATHS.fabushiMemoryAction), {
      headers,
      data: {
        action: 'add',
        key: 'e2e_architecture_note',
        content: 'Fabushi Web v1.6.11 server-persisted memory entry',
      },
    });
    expect([200, 201]).toContain(memActRes.status());
    const memVerifyRes = await request.get(apiUrl(API_PATHS.fabushiMemory), { headers });
    expect(memVerifyRes.status()).toBe(200);
    expect(await memVerifyRes.text()).toContain('Fabushi Web v1.6.11 server-persisted memory entry');

    // Skills & approvals lists return structured arrays
    const skillsRes = await request.get(apiUrl(API_PATHS.fabushiSkills), { headers });
    expect(skillsRes.status()).toBe(200);
    const skillsBody = (await skillsRes.json()) as { skills?: unknown } | unknown[];
    const skillsList = Array.isArray(skillsBody) ? skillsBody : skillsBody.skills;
    expect(Array.isArray(skillsList)).toBe(true);

    const approvalsRes = await request.get(apiUrl(API_PATHS.fabushiApprovals), { headers });
    expect(approvalsRes.status()).toBe(200);
    const approvalsBody = (await approvalsRes.json()) as { approvals?: unknown } | unknown[];
    const approvalsList = Array.isArray(approvalsBody) ? approvalsBody : approvalsBody.approvals;
    expect(Array.isArray(approvalsList)).toBe(true);

    // Open Hermes Studio and verify real session appears in UI
    const hermesPanel = await openNavDestination(page, 'hermes');
    await expect(hermesPanel).toBeVisible();
    await expect(hermesPanel).toContainText('Real Server Persisted Session');

    // Create a real cron job via API & verify persisted list
    const cronRes = await request.post(apiUrl(API_PATHS.fabushiCron), {
      headers,
      data: {
        name: 'Nightly Regression Digest',
        schedule: '0 2 * * *',
        prompt: 'Check build status',
      },
    });
    expect([200, 201]).toContain(cronRes.status());
    const listCronRes = await request.get(apiUrl(API_PATHS.fabushiCron), { headers });
    expect(listCronRes.status()).toBe(200);
    expect(await listCronRes.text()).toContain('Nightly Regression Digest');
  });

  test('A10-T1-03: Grok 1v1 Bot pre-start #bot-prestart-bar hiding composer -> /start reveals composer & external MenuButton outside #cmp-input-wrap', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const createRes = await request.post(apiUrl(API_PATHS.fabushiBots), {
      headers: authHeaders(user.token),
      data: {
        display_name: 'Grok Companion Bot',
        username: `grok_comp_${Date.now().toString(36)}_bot`,
        description: 'Can answer architecture questions and summarize threads.',
      },
    });
    expect([200, 201]).toContain(createRes.status());

    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, 'Grok Companion Bot');

    // Unstarted 1:1 bot chat with 0 messages renders #bot-prestart-bar and hides composer
    const prestartBar = page.locator(BOT_PRESTART_BAR);
    await expect(prestartBar).toBeVisible();
    await expect(page.locator(DOM.messageComposerInput)).toBeHidden();

    // Clicking START sends /start and reveals Apple Capsule Composer
    const startBtn = scopedButton(prestartBar, BILINGUAL_PATTERNS.startBot).first();
    await expect(startBtn).toBeVisible();
    await startBtn.click();

    await expect(prestartBar).toBeHidden();
    await expect(page.locator(DOM.messageComposerInput)).toBeVisible();

    // Verify Bot MenuButton sits strictly OUTSIDE #cmp-input-wrap
    const cmpWrap = page.locator(CMP_INPUT_WRAP);
    await expect(cmpWrap).toBeVisible();
    const nestedMenuCount = await cmpWrap
      .locator('#composer-bot-menu-btn, [data-testid="bot-menu-button"], button[aria-label*="menu" i]')
      .count();
    expect(nestedMenuCount).toBe(0);

    const externalMenuBtn = page
      .locator('#composer-bot-menu-btn, #composer-bot-slash-btn, [data-testid="bot-menu-button"]')
      .first();
    await expect(externalMenuBtn).toBeVisible();
    const isOutside = await externalMenuBtn.evaluate((el) => el.closest('#cmp-input-wrap') === null);
    expect(isOutside).toBe(true);
  });

  test('A10-T1-04: Inline #apple-compose-stage multi-select compose: 1 recipient opens DM carrying draft; 2+ recipients create auto-titled group with client_nonce', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const peerA = await registerUserViaApi(request, { firstName: 'Nora' });
    const peerB = await registerUserViaApi(request, { firstName: 'Owen' });
    // Ensure both real peers are discoverable contacts/chats
    await createRealConversationFixture(request, user.token, {
      peerUsername: peerA.username,
      peerFirstName: peerA.firstName,
    });
    const contactRes = await request.post(apiUrl(API_PATHS.contacts), {
      headers: authHeaders(user.token),
      data: { username: peerB.username },
    });
    expect([200, 201]).toContain(contactRes.status());

    await page.reload({ waitUntil: 'domcontentloaded' });

    // 1. Single recipient inside #apple-compose-stage opens DM carrying draft
    await page.locator(DOM.btnNewChatFab).click();
    const composeStage = page.locator(APPLE_COMPOSE_STAGE);
    await expect(composeStage).toBeVisible();

    const searchInput = composeStage.locator('input').first();
    await searchInput.fill(peerA.firstName);
    const pickAOnly = composeStage.getByText(peerA.firstName).first();
    await expect(pickAOnly).toBeVisible();
    await pickAOnly.click();

    const composer = page.locator(DOM.messageComposerInput);
    await expect(composer).toBeVisible();
    await composer.fill('CarryDraft_DM_1611');
    const openDmBtn = scopedButton(composeStage, BILINGUAL_PATTERNS.confirm)
      .or(scopedButton(composeStage, BILINGUAL_PATTERNS.next))
      .or(page.locator(DOM.btnSendMessage))
      .first();
    await expect(openDmBtn).toBeVisible();
    await openDmBtn.click();
    await expect(composeStage).toBeHidden();
    await expect(page.locator(DOM.chatHeaderTitle)).toContainText(peerA.firstName);
    const dmCarriedOrSent =
      (await readComposerText(composer)).includes('CarryDraft_DM_1611') ||
      (await page.locator(DOM.messageList).innerText()).includes('CarryDraft_DM_1611');
    expect(dmCarriedOrSent).toBe(true);

    // 2. Select 2 recipients inside #apple-compose-stage to form an auto-titled group
    await page.locator(DOM.btnNewChatFab).click();
    await expect(composeStage).toBeVisible();

    await searchInput.fill(peerA.firstName);
    const pickA = composeStage.getByText(peerA.firstName).first();
    await expect(pickA).toBeVisible();
    await pickA.click();

    await searchInput.fill(peerB.firstName);
    const pickB = composeStage.getByText(peerB.firstName).first();
    await expect(pickB).toBeVisible();
    await pickB.click();

    await expect(composer).toBeVisible();
    await composer.fill('First multi-select group kickoff');
    await composer.press('Enter');

    await expect(composeStage).toBeHidden();
    await expect(page.locator(DOM.chatHeaderTitle)).toContainText(/Nora|Owen/);
    await expect(page.locator(DOM.messageList)).toContainText('First multi-select group kickoff');
  });

  test('A10-T1-05: Multi-Agent Group Protocol: SharedGroupWorkspace revisioned KV via group_workspace_write & WS AgentFloorChanged / AgentWorkspaceUpdated events', async ({
    request,
  }) => {
    const owner = await registerUserViaApi(request);
    const headers = authHeaders(owner.token);

    // Create 2 Fabushi Bots for the Multi-Agent group
    const botARes = await request.post(apiUrl(API_PATHS.fabushiBots), {
      headers,
      data: {
        display_name: 'Planner Agent',
        username: `planner_${Date.now().toString(36)}_bot`,
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
        display_name: 'Reviewer Agent',
        username: `reviewer_${Date.now().toString(36)}_bot`,
      },
    });
    expect([200, 201]).toContain(botBRes.status());
    const botBData = (await botBRes.json()) as {
      bot?: { bot_user_id?: number; id?: number; user_id?: number };
      registry?: { bot_user_id?: number };
    };
    const botBId = extractBotUserId(botBData);

    const grpRes = await request.post(apiUrl(API_PATHS.chatsCreate), {
      headers,
      data: {
        chat_type: 'group',
        title: 'MultiAgent Workspace Room',
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

    // Ephemeral OpenAI-compatible stub driving genuine group_workspace_write tool calls
    const stub = await startEphemeralOpenAiStub((call) => {
      if (call.index === 0) {
        return {
          tool_calls: [
            {
              id: 'call_ws_write_1',
              type: 'function',
              function: {
                name: 'group_workspace_write',
                arguments: JSON.stringify({
                  chat_id: groupId,
                  key: 'sprint_plan',
                  value: { milestone: 'v1.6.11', owner: owner.username },
                  expected_revision: 0,
                }),
              },
            },
          ],
          finish_reason: 'tool_calls',
        };
      }
      return {
        content: 'Workspace sprint_plan saved at revision 1',
        finish_reason: 'stop',
      };
    });

    const ws = await OpaqueWsClient.connect(owner.token);
    try {
      const provRes = await request.post(apiUrl(API_PATHS.magpieProviders), {
        headers,
        data: {
          provider_id: 'e2e_local_openai',
          name: 'E2E Local OpenAI Stub',
          api_mode: 'chat_completions',
          base_url: stub.baseUrl,
          api_key: 'sk-e2e-local-stub-key',
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
        `@${botAUsername} record sprint_plan to shared workspace`,
      );

      // Verify genuine WS AgentFloorChanged and AgentWorkspaceUpdated events
      const floorFrame = await ws.waitForFrame(
        (f) => {
          const ev = extractUpdateEvent(f, 'AgentFloorChanged');
          return ev !== null && Number(ev.chat_id) === groupId;
        },
        10_000,
        'UpdateEvent::AgentFloorChanged',
      );
      expect(extractUpdateEvent(floorFrame, 'AgentFloorChanged')).not.toBeNull();

      const wsUpdatedFrame = await ws.waitForFrame(
        (f) => {
          const ev = extractUpdateEvent(f, 'AgentWorkspaceUpdated');
          return (
            ev !== null &&
            Number(ev.chat_id) === groupId &&
            ev.key === 'sprint_plan' &&
            Number(ev.revision) >= 1
          );
        },
        10_000,
        'UpdateEvent::AgentWorkspaceUpdated for sprint_plan',
      );
      const updatedEvent = extractUpdateEvent(wsUpdatedFrame, 'AgentWorkspaceUpdated');
      expect(updatedEvent).not.toBeNull();
      expect(Number(updatedEvent!.revision)).toBeGreaterThanOrEqual(1);

      // Verify stub received tool execution result containing revision 1
      await expect
        .poll(() => stub.calls.length, { timeout: 8_000 })
        .toBeGreaterThanOrEqual(2);
      const secondCallToolMsgs = stub.calls[1].messages.filter((m) => m.role === 'tool');
      expect(secondCallToolMsgs.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(secondCallToolMsgs)).toContain('1');
    } finally {
      ws.close();
      await stub.close();
    }
  });

  test('A10-T1-06: Multi-Agent room session isolation (group:<chat_id> separated from 1:1 bot DM) & @mention autocomplete', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const botRes = await request.post(apiUrl(API_PATHS.fabushiBots), {
      headers: authHeaders(user.token),
      data: {
        display_name: 'Mentionable Bot',
        username: `mentionable_${Date.now().toString(36)}_bot`,
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

    // Create a group containing the bot
    const grpRes = await request.post(apiUrl(API_PATHS.chatsCreate), {
      headers: authHeaders(user.token),
      data: {
        chat_type: 'group',
        title: 'Bot Mention Group',
        member_ids: [botUserId],
        client_nonce: crypto.randomUUID(),
      },
    });
    expect([200, 201]).toContain(grpRes.status());

    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, 'Bot Mention Group');

    const composer = page.locator(DOM.messageComposerInput);
    await composer.click();
    await composer.type('@');

    const suggestion = page
      .locator('[role="listbox"], [data-testid*="mention" i]')
      .getByText(new RegExp(botUsername.slice(0, 10), 'i'))
      .first();
    await expect(suggestion).toBeVisible();
    await suggestion.click();

    await expect(composer).toHaveValue(new RegExp(`@${botUsername}`, 'i'));

    // Send group-scoped prompt and verify strict separation from 1:1 bot DM
    const groupOnlyMarker = `GroupExclusivePrompt_${Date.now()}`;
    await sendTextMessage(page, `@${botUsername} ${groupOnlyMarker}`);
    await selectChat(page, 'Mentionable Bot');
    await expect(page.locator(DOM.messageList)).not.toContainText(groupOnlyMarker);
  });
});
