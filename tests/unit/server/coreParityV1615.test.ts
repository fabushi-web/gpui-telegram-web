import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTelegramServer, type TelegramServerInstance } from '@gpui-telegram/server';
import { deliverScheduledMessageAtomic } from '../../../apps/server/src/db/queries.js';
import { shouldProxyWebSocketPathname } from '../../../apps/server/src/proxy.js';
import {
  evaluateGroupWakeGate,
  extractMentionTokens,
  type GroupBotCandidate,
} from '../../../apps/server/src/routes/multiAgent.js';
import {
  apiJson,
  connectWsAuthenticated,
  createUniqueTestDir,
  registerTestUser,
} from './_helpers.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../../..');

describe('Fabushi v1.7.0 Server Core Parity (`v1.6.12`–`v1.6.15`)', () => {
  let server: TelegramServerInstance;
  let baseUrl = '';
  let wsUrl = '';
  let dataDir = '';

  let prodServer: TelegramServerInstance;
  let prodBaseUrl = '';
  let prodDataDir = '';

  let mockLlmServer: http.Server;
  let mockLlmBaseUrl = '';
  const mockLlmRequests: Array<{ messages: Array<{ role: string; content: string }> }> = [];

  beforeAll(async () => {
    dataDir = createUniqueTestDir('m1a-core-parity');
    server = createTelegramServer({
      port: 0,
      host: '127.0.0.1',
      dataDir,
      enableTestReset: true,
    });
    const started = await server.start();
    baseUrl = started.baseUrl;
    wsUrl = started.wsUrl;

    prodDataDir = createUniqueTestDir('m1a-core-prod');
    prodServer = createTelegramServer({
      port: 0,
      host: '127.0.0.1',
      dataDir: prodDataDir,
      enableTestReset: false,
    });
    const startedProd = await prodServer.start();
    prodBaseUrl = startedProd.baseUrl;

    // Local real OpenAI-compatible mock LLM HTTP server for testing /btw, /plan, /retry & /translate
    mockLlmServer = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      let parsed: { messages?: Array<{ role: string; content: string }> } = {};
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = {};
      }
      const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
      mockLlmRequests.push({ messages: msgs });
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user')?.content ?? '';
      const sys = msgs.find((m) => m.role === 'system')?.content ?? '';

      let reply = `MOCK_LLM_REPLY:${lastUser}`;
      if (sys.toLowerCase().includes('translate')) {
        reply = `[TRANSLATED] ${lastUser}`;
      } else if (sys.toLowerCase().includes('step-by-step plan')) {
        reply = `1. Audit requirements for ${lastUser}\n2. Implement & verify tests`;
      } else if (sys.toLowerCase().includes('ephemeral')) {
        reply = `EPHEMERAL_ANSWER:${lastUser}`;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl_mock_1',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: reply },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
        }),
      );
    });
    await new Promise<void>((resolve) => mockLlmServer.listen(0, '127.0.0.1', resolve));
    const llmPort = (mockLlmServer.address() as AddressInfo).port;
    mockLlmBaseUrl = `http://127.0.0.1:${llmPort}`;
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => mockLlmServer?.close(() => resolve()));
    await prodServer?.close();
    await server?.close();
    fs.rmSync(prodDataDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('reports v1.7.0 across health/status/version and proxies /api/v1/orca/wake in both proxy.ts and nginx.ombhrum.conf', async () => {
    for (const route of ['/api/v1/health', '/api/v1/status', '/api/v1/version']) {
      const res = await apiJson(baseUrl, 'GET', route);
      expect(res.status).toBe(200);
      expect(res.data.version).toBe('1.7.0');
    }

    expect(shouldProxyWebSocketPathname('/api/v1/orca/wake')).toBe(true);
    expect(shouldProxyWebSocketPathname('/api/v1/orca/wake?token=tok_123')).toBe(true);
    expect(shouldProxyWebSocketPathname('ws://127.0.0.1:4173/api/v1/orca/wake?token=t')).toBe(true);

    const nginxConf = fs.readFileSync(path.join(repoRoot, 'deploy/nginx.ombhrum.conf'), 'utf8');
    expect(nginxConf).toContain('v1.7.0');
    const wsLocMatch = /location\s+~\s+(\^\/api\/v1\/\([^)]+\)\$)/.exec(nginxConf);
    expect(wsLocMatch).not.toBeNull();
    const wsRegex = new RegExp(wsLocMatch![1]!);
    expect(wsRegex.test('/api/v1/orca/wake')).toBe(true);
    expect(wsRegex.test('/api/v1/ws')).toBe(true);
    expect(wsRegex.test('/api/v1/tailnet/derp')).toBe(true);
    expect(wsRegex.test('/api/v1/browser/ws')).toBe(true);
  });

  it('strictly gates POST /api/v1/test/promote-support (404 when disabled, 200 + auth/me is_support when enabled)', async () => {
    const prodUser = await registerTestUser(prodBaseUrl, 'prod_support_check');
    const disabledRes = await apiJson(prodBaseUrl, 'POST', '/api/v1/test/promote-support', {
      body: { user_id: prodUser.user_id, is_support: true },
    });
    expect(disabledRes.status).toBe(404);

    const prodMe = await apiJson(prodBaseUrl, 'GET', '/api/v1/auth/me', { token: prodUser.token });
    expect(prodMe.status).toBe(200);
    expect(prodMe.data.is_support).toBe(false);

    const testUser = await registerTestUser(baseUrl, 'support_target_user');
    const badReq = await apiJson(baseUrl, 'POST', '/api/v1/test/promote-support', { body: {} });
    expect(badReq.status).toBe(400);

    const missingUser = await apiJson(baseUrl, 'POST', '/api/v1/test/promote-support', {
      body: { username: 'does_not_exist_999' },
    });
    expect(missingUser.status).toBe(404);

    const promoteRes = await apiJson(baseUrl, 'POST', '/api/v1/test/promote-support', {
      body: { username: `@${testUser.username}`, is_support: true },
    });
    expect(promoteRes.status).toBe(200);
    expect(promoteRes.data).toMatchObject({
      ok: true,
      user_id: testUser.user_id,
      username: testUser.username,
      is_support: true,
    });

    const meAfter = await apiJson(baseUrl, 'GET', '/api/v1/auth/me', { token: testUser.token });
    expect(meAfter.status).toBe(200);
    expect(meAfter.data.is_support).toBe(true);
  });

  it('enforces Multi-Agent PrimaryFallback 4-tier priority, /cmd@botname, CJK @所有人, low-signal pass, and reply_to_bot end-to-end', async () => {
    // 1. Mention token extraction (/cmd@botname, trailing punctuation, rejecting emails)
    expect(extractMentionTokens('/status@alpha_bot please check @beta_bot. not alice@gamma_bot')).toEqual([
      'alpha_bot',
      'beta_bot',
    ]);

    const botAlpha: GroupBotCandidate = {
      bot_user_id: 800_010,
      agent_id: 'alpha_bot',
      username: 'alpha_bot',
      display_name: 'Alpha Bot',
      description: 'Database performance specialist',
      skills: ['postgres'],
    };
    const botBeta: GroupBotCandidate = {
      bot_user_id: 800_020,
      agent_id: 'beta_bot',
      username: 'beta_bot',
      display_name: 'Beta Bot',
      description: 'Frontend layout advisor',
      skills: ['css'],
    };
    const botHermes: GroupBotCandidate = {
      bot_user_id: 777000,
      agent_id: 'hermesagent',
      username: 'HermesAgent',
      display_name: 'Hermes Agent',
      description: 'General systems assistant',
      skills: [],
    };

    // 2. CJK broadcast mentions
    for (const msg of ['@所有人 大家好', '@所有人，看一下', '@全体成员 同步进度']) {
      const dec = evaluateGroupWakeGate({
        text: msg,
        senderIsHuman: true,
        senderUserId: 1001,
        remainingLoopBudget: 5,
        candidates: [botAlpha, botBeta],
      });
      expect(dec.status).toBe('wake');
      expect(dec.reason).toBe('mention_all');
      expect(dec.targets.length).toBe(2);
    }

    // 3. /cmd@botname wakes targeted bot
    const slashMention = evaluateGroupWakeGate({
      text: '/status@beta_bot check metrics',
      senderIsHuman: true,
      senderUserId: 1001,
      remainingLoopBudget: 5,
      candidates: [botAlpha, botBeta],
    });
    expect(slashMention.status).toBe('wake');
    expect(slashMention.reason).toBe('explicit_mention');
    expect(slashMention.targets.map((b) => b.username)).toEqual(['beta_bot']);

    // 4. Low-signal ack stays `pass`
    for (const ack of ['ok', '好的']) {
      const ackDec = evaluateGroupWakeGate({
        text: ack,
        senderIsHuman: true,
        senderUserId: 1001,
        remainingLoopBudget: 5,
        candidates: [botAlpha, botBeta],
      });
      expect(ackDec.status).toBe('pass');
      expect(ackDec.reason).toBe('low_signal_ack');
    }

    // 5. PrimaryFallback tier 1: top positive score (>0 but <0.35)
    const tier1 = evaluateGroupWakeGate({
      text: 'Let us inspect postgres migrations this sprint',
      senderIsHuman: true,
      senderUserId: 1001,
      remainingLoopBudget: 5,
      candidates: [botBeta, botAlpha],
    });
    expect(tier1.status).toBe('wake');
    expect(tier1.reason).toBe('primary_fallback');
    expect(tier1.targets[0]?.bot_user_id).toBe(botAlpha.bot_user_id);

    // 6. PrimaryFallback tier 2: recent speaker (`last_spoken_ms` when no score > 0)
    const now = Date.now();
    const tier2 = evaluateGroupWakeGate({
      text: 'What should our launch agenda cover tomorrow morning?',
      senderIsHuman: true,
      senderUserId: 1001,
      remainingLoopBudget: 5,
      candidates: [
        { ...botAlpha, last_spoken_ms: now - 60_000 },
        { ...botBeta, last_spoken_ms: now - 30_000 },
      ],
      nowMs: now,
    });
    expect(tier2.status).toBe('wake');
    expect(tier2.reason).toBe('primary_fallback');
    expect(tier2.targets[0]?.bot_user_id).toBe(botBeta.bot_user_id);

    // 7. PrimaryFallback tier 3: official Hermes bot (777000) when no positive score and no recent speaker
    const tier3 = evaluateGroupWakeGate({
      text: 'Can somebody summarize today?',
      senderIsHuman: true,
      senderUserId: 1001,
      remainingLoopBudget: 5,
      candidates: [botAlpha, botHermes, botBeta],
    });
    expect(tier3.status).toBe('wake');
    expect(tier3.reason).toBe('primary_fallback');
    expect(tier3.targets[0]?.bot_user_id).toBe(777000);

    // 8. PrimaryFallback tier 4: first eligible candidate when no 777000
    const tier4 = evaluateGroupWakeGate({
      text: 'Can somebody summarize today?',
      senderIsHuman: true,
      senderUserId: 1001,
      remainingLoopBudget: 5,
      candidates: [botAlpha, botBeta],
    });
    expect(tier4.status).toBe('wake');
    expect(tier4.reason).toBe('primary_fallback');
    expect(tier4.targets[0]?.bot_user_id).toBe(botAlpha.bot_user_id);

    // 9. NEVER fires on bot-to-bot (`senderIsHuman: false`)
    const botToBot = evaluateGroupWakeGate({
      text: 'Can somebody summarize today?',
      senderIsHuman: false,
      senderUserId: botAlpha.bot_user_id,
      remainingLoopBudget: 3,
      candidates: [botAlpha, botBeta, botHermes],
    });
    expect(botToBot.status).toBe('pass');
    expect(botToBot.reason).toBe('no_relevant_candidate');

    // 10. End-to-end reply_to_bot propagation in a real group chat with 2 bots
    const alice = await registerTestUser(baseUrl, 'reply_gate_alice');
    const createdBot = await apiJson(baseUrl, 'POST', '/api/v1/bots', {
      token: alice.token,
      body: { display_name: 'Reply Target Bot', username: 'reply_target_bot' },
    });
    expect(createdBot.status).toBe(201);
    const customBotId = Number(createdBot.data.bot.bot_user_id);
    const customBotToken = String(createdBot.data.bot_token);

    const grpRes = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
      token: alice.token,
      body: {
        title: 'Multi-Bot Reply Gate Room',
        chat_type: 1,
        member_ids: [777000, customBotId],
      },
    });
    expect(grpRes.status).toBe(201);
    const groupChatId = Number(grpRes.data.chat_id);

    // Have custom bot post a message into the group via Bot API
    const botPost = await apiJson(baseUrl, 'POST', `/bot/${customBotToken}/sendMessage`, {
      body: { chat_id: groupChatId, text: 'I am ready to inspect your reply.' },
    });
    expect(botPost.status).toBe(200);
    const botMsgId = Number(botPost.data.result.message_id);

    // Configure mock LLM for Alice so the awakened bot can post an actual reply
    const provSetup = await apiJson(baseUrl, 'PUT', '/api/v1/fabushi/magpie/providers', {
      token: alice.token,
      body: {
        provider_id: 'mock_openai',
        name: 'Mock OpenAI',
        api_mode: 'chat_completions',
        base_url: mockLlmBaseUrl,
        api_key: 'sk-test-local-mock',
        default_model: 'gpt-4o-mini',
        enabled: true,
      },
    });
    expect(provSetup.status).toBe(200);
    const cfgSetup = await apiJson(baseUrl, 'PUT', '/api/v1/fabushi/magpie/config', {
      token: alice.token,
      body: { active_provider: 'mock_openai', active_model: 'gpt-4o-mini' },
    });
    expect(cfgSetup.status).toBe(200);

    // Human replies directly to customBotId's message with quote_text
    const replyRes = await apiJson(baseUrl, 'POST', `/api/v1/chats/${groupChatId}/messages`, {
      token: alice.token,
      body: {
        text: 'Please review that point carefully.',
        reply_to_msg_id: botMsgId,
        quote_text: 'ready to inspect',
      },
    });
    expect(replyRes.status).toBe(201);

    // Wait briefly for async group bot reply from customBotId (NOT 777000)
    let targetBotReplied = false;
    for (let i = 0; i < 30; i++) {
      const hist = await apiJson(baseUrl, 'GET', `/api/v1/chats/${groupChatId}/messages`, {
        token: alice.token,
      });
      const msgs = hist.data.messages as Array<{ sender_id: number; text?: string }>;
      if (
        msgs.some(
          (m) =>
            m.sender_id === customBotId &&
            (m.text ?? '').includes('MOCK_LLM_REPLY') &&
            (m.text ?? '').includes('ready to inspect'),
        )
      ) {
        targetBotReplied = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(targetBotReplied).toBe(true);
  });

  it('implements GET /api/v1/bots/inline-query and POST /bot/:token/answerInlineQuery with strict validation, cross-bot hijack protection, and zero leaks', async () => {
    const owner = await registerTestUser(baseUrl, 'inline_owner');
    const other = await registerTestUser(baseUrl, 'inline_other');

    // Unauthenticated -> 401
    expect((await apiJson(baseUrl, 'GET', '/api/v1/bots/inline-query?bot=FabushiBot')).status).toBe(401);

    // Missing bot -> 400; missing/unknown bot -> 404
    expect(
      (await apiJson(baseUrl, 'GET', '/api/v1/bots/inline-query', { token: owner.token })).status,
    ).toBe(400);
    expect(
      (await apiJson(baseUrl, 'GET', '/api/v1/bots/inline-query?bot=no_such_bot_xyz', { token: owner.token })).status,
    ).toBe(404);

    // Inline-disabled bot (@BotFather) -> 400 inline_not_enabled
    const disabledInline = await apiJson(
      baseUrl,
      'GET',
      '/api/v1/bots/inline-query?bot=BotFather&query=test',
      { token: owner.token },
    );
    expect(disabledInline.status).toBe(400);

    // Official inline bot (@FabushiBot) works gracefully without public_catalog_entries table and returns official MiniApps
    const officialRes = await apiJson(
      baseUrl,
      'GET',
      '/api/v1/bots/inline-query?bot=FabushiBot&query=fabushi&limit=10',
      { token: owner.token },
    );
    expect(officialRes.status).toBe(200);
    expect(officialRes.data.ok).toBe(true);
    expect(officialRes.data.query_id).toMatch(/^iq_/);
    expect(Array.isArray(officialRes.data.results)).toBe(true);
    expect(officialRes.data.results.length).toBeGreaterThanOrEqual(1);

    // Create two custom bots to test answerInlineQuery + cross-bot hijack protection
    const bot1Res = await apiJson(baseUrl, 'POST', '/api/v1/bots', {
      token: owner.token,
      body: { display_name: 'Inline Bot One', username: 'inline_one_bot' },
    });
    const bot2Res = await apiJson(baseUrl, 'POST', '/api/v1/bots', {
      token: other.token,
      body: { display_name: 'Inline Bot Two', username: 'inline_two_bot' },
    });
    expect(bot1Res.status).toBe(201);
    expect(bot2Res.status).toBe(201);

    const bot1Id = Number(bot1Res.data.bot.bot_user_id);
    const bot1Token = String(bot1Res.data.bot_token);
    const bot2Token = String(bot2Res.data.bot_token);

    // Enable inline on bot1
    const patchRes = await apiJson(baseUrl, 'PATCH', `/api/v1/bots/${bot1Id}`, {
      token: owner.token,
      body: { is_inline: true },
    });
    expect(patchRes.status).toBe(200);

    // Issue inline query for bot1
    const q1 = await apiJson(
      baseUrl,
      'GET',
      `/api/v1/bots/inline-query?bot=inline_one_bot&query=hello`,
      { token: owner.token },
    );
    expect(q1.status).toBe(200);
    const queryId = String(q1.data.query_id);

    // Invalid bot token -> 401
    expect(
      (
        await apiJson(baseUrl, 'POST', '/bot/999999:BADTOKEN/answerInlineQuery', {
          body: { inline_query_id: queryId, results: [] },
        })
      ).status,
    ).toBe(401);

    // Invalid payloads -> 400 (missing id, duplicate result ids, malformed results)
    expect(
      (
        await apiJson(baseUrl, 'POST', `/bot/${bot1Token}/answerInlineQuery`, {
          body: { inline_query_id: '', results: [] },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await apiJson(baseUrl, 'POST', `/bot/${bot1Token}/answerInlineQuery`, {
          body: {
            inline_query_id: queryId,
            results: [
              { type: 'article', id: 'dup', title: 'A' },
              { type: 'article', id: 'dup', title: 'B' },
            ],
          },
        })
      ).status,
    ).toBe(400);

    // Cross-bot hijack attempt -> 403
    const hijackRes = await apiJson(baseUrl, 'POST', `/bot/${bot2Token}/answerInlineQuery`, {
      body: {
        inline_query_id: queryId,
        results: [{ type: 'article', id: 'r1', title: 'Hijacked' }],
      },
    });
    expect(hijackRes.status).toBe(403);

    // Legitimate bot1 answers query -> 200 { ok: true, result: true }
    const ansRes = await apiJson(baseUrl, 'POST', `/bot/${bot1Token}/answerInlineQuery`, {
      body: {
        inline_query_id: queryId,
        cache_time: 60,
        is_personal: true,
        next_offset: '10',
        results: [
          {
            type: 'article',
            id: 'res_1',
            title: 'Real Inline Result',
            description: 'Answered via Bot HTTP API',
            input_message_content: { message_text: 'Selected Real Inline Result' },
          },
        ],
      },
    });
    expect(ansRes.status).toBe(200);
    expect(ansRes.data).toEqual({ ok: true, result: true });

    // Retrieve answered results via query_id
    const fetched = await apiJson(
      baseUrl,
      'GET',
      `/api/v1/bots/inline-query?bot=inline_one_bot&query_id=${encodeURIComponent(queryId)}`,
      { token: owner.token },
    );
    expect(fetched.status).toBe(200);
    expect(fetched.data.results).toHaveLength(1);
    expect(fetched.data.results[0].title).toBe('Real Inline Result');
    expect(fetched.data.next_offset).toBe('10');
  });

  it('executes Hermes slash commands authentically (/background, /browser, /terminal, /subagents, /connections, /diff, /retry, /plan, /btw without mutating history)', async () => {
    const user = await registerTestUser(baseUrl, 'hermes_slash_user');

    // /background persists a real queued task in SQLite `tasks`
    const bgRes = await apiJson(baseUrl, 'POST', '/api/v1/fabushi/command', {
      token: user.token,
      body: { command: '/background Audit database indexes nightly' },
    });
    expect(bgRes.status).toBe(200);
    expect(bgRes.data.task_id).toMatch(/^task_/);
    const tasksRes = await apiJson(baseUrl, 'GET', '/api/v1/tasks', { token: user.token });
    expect(tasksRes.status).toBe(200);
    expect(
      (tasksRes.data.tasks as Array<{ task_id: string; state: string }>).some(
        (t) => t.task_id === bgRes.data.task_id && t.state === 'queued',
      ),
    ).toBe(true);

    // /browser, /terminal, /subagents, /connections, /diff return truthful live summaries
    for (const cmd of ['/browser', '/terminal', '/subagents', '/connections', '/diff']) {
      const r = await apiJson(baseUrl, 'POST', '/api/v1/fabushi/command', {
        token: user.token,
        body: { command: cmd },
      });
      expect(r.status).toBe(200);
      expect(typeof r.data.response_text).toBe('string');
      expect(r.data.response_text.length).toBeGreaterThan(10);
    }

    // /terminal with command arg & 0 online nodes -> honest 503 node_offline
    const termExec = await apiJson(baseUrl, 'POST', '/api/v1/fabushi/command', {
      token: user.token,
      body: { command: '/terminal uname -a' },
    });
    expect(termExec.status).toBe(503);

    // /plan & /btw return honest 503 provider_not_configured before configuring Magpie
    expect(
      (
        await apiJson(baseUrl, 'POST', '/api/v1/fabushi/command', {
          token: user.token,
          body: { command: '/plan Build offline cache' },
        })
      ).status,
    ).toBe(503);
    expect(
      (
        await apiJson(baseUrl, 'POST', '/api/v1/fabushi/command', {
          token: user.token,
          body: { command: '/btw What is WAL mode?' },
        })
      ).status,
    ).toBe(503);

    // /vision -> 501 when unconfigured; /reload-mcp -> 501 (honest)
    expect(
      (
        await apiJson(baseUrl, 'POST', '/api/v1/fabushi/command', {
          token: user.token,
          body: { command: '/vision' },
        })
      ).status,
    ).toBe(501);
    expect(
      (
        await apiJson(baseUrl, 'POST', '/api/v1/fabushi/command', {
          token: user.token,
          body: { command: '/reload-mcp' },
        })
      ).status,
    ).toBe(501);

    // Configure local mock OpenAI provider (with vision-capable model gpt-4o)
    const hermesProv = await apiJson(baseUrl, 'PUT', '/api/v1/fabushi/magpie/providers', {
      token: user.token,
      body: {
        provider_id: 'local_mock_llm',
        name: 'Local Mock',
        api_mode: 'chat_completions',
        base_url: mockLlmBaseUrl,
        api_key: 'sk-mock-hermes-key',
        default_model: 'gpt-4o',
        enabled: true,
      },
    });
    expect(hermesProv.status).toBe(200);
    const hermesCfg = await apiJson(baseUrl, 'PUT', '/api/v1/fabushi/magpie/config', {
      token: user.token,
      body: { active_provider: 'local_mock_llm', active_model: 'gpt-4o' },
    });
    expect(hermesCfg.status).toBe(200);

    // /vision now succeeds truthfully
    const visionReady = await apiJson(baseUrl, 'POST', '/api/v1/fabushi/command', {
      token: user.token,
      body: { command: '/vision' },
    });
    expect(visionReady.status).toBe(200);
    expect(visionReady.data.response_text).toContain('gpt-4o');

    // Run a normal turn so the session has history
    const turnRes = await apiJson(baseUrl, 'POST', '/api/v1/fabushi/turns', {
      token: user.token,
      body: { prompt: 'Explain SQLite WAL briefly' },
    });
    expect(turnRes.status).toBe(200);
    const sid = String(turnRes.data.session_id);

    const beforeSess = await apiJson(baseUrl, 'GET', `/api/v1/fabushi/sessions/${sid}`, {
      token: user.token,
    });
    const beforeCount = (beforeSess.data.messages as unknown[]).length;
    expect(beforeCount).toBe(2);

    // /btw answers using real mock LLM WITHOUT mutating session history!
    const btwRes = await apiJson(baseUrl, 'POST', '/api/v1/fabushi/command', {
      token: user.token,
      body: { command: '/btw What port does HTTP use?', session_id: sid },
    });
    expect(btwRes.status).toBe(200);
    expect(btwRes.data.response_text).toContain('EPHEMERAL_ANSWER:What port does HTTP use?');

    const afterBtwSess = await apiJson(baseUrl, 'GET', `/api/v1/fabushi/sessions/${sid}`, {
      token: user.token,
    });
    expect((afterBtwSess.data.messages as unknown[]).length).toBe(beforeCount);

    // /plan calls real mock LLM
    const planRes = await apiJson(baseUrl, 'POST', '/api/v1/fabushi/command', {
      token: user.token,
      body: { command: '/plan Add scheduled messages', session_id: sid },
    });
    expect(planRes.status).toBe(200);
    expect(planRes.data.response_text).toContain('Add scheduled messages');

    // /retry regenerates last user turn via real mock LLM
    const retryRes = await apiJson(baseUrl, 'POST', '/api/v1/fabushi/command', {
      token: user.token,
      body: { command: '/retry', session_id: sid },
    });
    expect(retryRes.status).toBe(200);
    expect(retryRes.data.ui_effect).toEqual({ kind: 'refresh_session' });
    expect(retryRes.data.response_text).toContain('MOCK_LLM_REPLY:Explain SQLite WAL briefly');
  });

  it('handles scheduled messages lifecycle, inline message translation, group admin log, and calls history', async () => {
    const admin = await registerTestUser(baseUrl, 'parity_admin');
    const member = await registerTestUser(baseUrl, 'parity_member');
    const outsider = await registerTestUser(baseUrl, 'parity_outsider');

    // Create group chat with admin + member
    const grpRes = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
      token: admin.token,
      body: { title: 'Parity Group', chat_type: 1, member_ids: [member.user_id] },
    });
    expect(grpRes.status).toBe(201);
    const chatId = Number(grpRes.data.chat_id);

    // 1. Scheduled Messages Lifecycle: POST future -> absent from normal GET /messages, present in GET /scheduled-messages -> send-now -> DELETE
    const futureMs = Date.now() + 3_600_000;
    const sched1 = await apiJson(baseUrl, 'POST', `/api/v1/chats/${chatId}/messages`, {
      token: admin.token,
      body: { text: 'Scheduled message one', schedule_at_ms: futureMs },
    });
    expect(sched1.status).toBe(201);
    expect(sched1.data.message.flags.is_scheduled).toBe(true);
    expect(sched1.data.message.scheduled_at_ms).toBe(futureMs);
    const sched1Id = Number(sched1.data.message.id);

    const sched2 = await apiJson(baseUrl, 'POST', `/api/v1/chats/${chatId}/messages`, {
      token: admin.token,
      body: { text: 'Scheduled message two (to cancel)', schedule_at_ms: futureMs + 60_000 },
    });
    expect(sched2.status).toBe(201);
    const sched2Id = Number(sched2.data.message.id);

    // Normal history excludes pending scheduled messages
    const histBefore = await apiJson(baseUrl, 'GET', `/api/v1/chats/${chatId}/messages`, {
      token: admin.token,
    });
    expect(histBefore.status).toBe(200);
    expect((histBefore.data.messages as Array<{ id: number }>).map((m) => m.id)).not.toContain(
      sched1Id,
    );

    // Scheduled queue lists both
    const schedList = await apiJson(baseUrl, 'GET', `/api/v1/chats/${chatId}/scheduled-messages`, {
      token: admin.token,
    });
    expect(schedList.status).toBe(200);
    expect(schedList.data.total).toBe(2);

    // Send scheduled message 1 immediately
    const sendNow = await apiJson(
      baseUrl,
      'POST',
      `/api/v1/chats/${chatId}/scheduled-messages/${sched1Id}/send-now`,
      { token: admin.token },
    );
    expect(sendNow.status).toBe(200);
    expect(sendNow.data.message.flags.is_scheduled).toBe(false);

    const histAfter = await apiJson(baseUrl, 'GET', `/api/v1/chats/${chatId}/messages`, {
      token: admin.token,
    });
    expect((histAfter.data.messages as Array<{ id: number }>).map((m) => m.id)).toContain(sched1Id);

    // Cancel scheduled message 2
    const cancelRes = await apiJson(
      baseUrl,
      'DELETE',
      `/api/v1/chats/${chatId}/scheduled-messages/${sched2Id}`,
      { token: admin.token },
    );
    expect(cancelRes.status).toBe(200);

    const schedListAfter = await apiJson(
      baseUrl,
      'GET',
      `/api/v1/chats/${chatId}/scheduled-messages`,
      { token: admin.token },
    );
    expect(schedListAfter.data.total).toBe(0);

    // 2. Inline Message Translate: 403 non-member, 503 unconfigured, 200 with real mock LLM
    const outsiderTranslate = await apiJson(
      baseUrl,
      'POST',
      `/api/v1/chats/${chatId}/messages/${sched1Id}/translate`,
      { token: outsider.token, body: { target_lang: 'zh-CN' } },
    );
    expect(outsiderTranslate.status).toBe(403);

    const unconfiguredTranslate = await apiJson(
      baseUrl,
      'POST',
      `/api/v1/chats/${chatId}/messages/${sched1Id}/translate`,
      { token: admin.token, body: { target_lang: 'zh-CN' } },
    );
    expect(unconfiguredTranslate.status).toBe(503);
    expect(unconfiguredTranslate.data.error).toBe('provider_not_configured');

    const transProv = await apiJson(baseUrl, 'PUT', '/api/v1/fabushi/magpie/providers', {
      token: admin.token,
      body: {
        provider_id: 'translate_mock',
        name: 'Translate Mock',
        api_mode: 'chat_completions',
        base_url: mockLlmBaseUrl,
        api_key: 'sk-translate-mock',
        default_model: 'gpt-4o-mini',
        enabled: true,
      },
    });
    expect(transProv.status).toBe(200);
    const transCfg = await apiJson(baseUrl, 'PUT', '/api/v1/fabushi/magpie/config', {
      token: admin.token,
      body: { active_provider: 'translate_mock', active_model: 'gpt-4o-mini' },
    });
    expect(transCfg.status).toBe(200);

    const translated = await apiJson(
      baseUrl,
      'POST',
      `/api/v1/chats/${chatId}/messages/${sched1Id}/translate`,
      { token: admin.token, body: { target_lang: 'zh-CN' } },
    );
    expect(translated.status).toBe(200);
    expect(translated.data).toMatchObject({
      ok: true,
      chat_id: chatId,
      message_id: sched1Id,
      target_lang: 'zh-CN',
      original_text: 'Scheduled message one',
      translated_text: '[TRANSLATED] Scheduled message one',
    });

    // 3. Group Admin Log: 403 for regular member, real recorded entries for admin
    const memberLogRes = await apiJson(baseUrl, 'GET', `/api/v1/chats/${chatId}/admin-log`, {
      token: member.token,
    });
    expect(memberLogRes.status).toBe(403);

    await apiJson(baseUrl, 'PATCH', `/api/v1/chats/${chatId}`, {
      token: admin.token,
      body: { title: 'Parity Group Renamed' },
    });
    await apiJson(baseUrl, 'POST', `/api/v1/chats/${chatId}/messages/${sched1Id}/pin`, {
      token: admin.token,
      body: {},
    });
    const inv = await apiJson(baseUrl, 'POST', `/api/v1/chats/${chatId}/invites`, {
      token: admin.token,
      body: { title: 'Team Invite' },
    });
    expect(inv.status).toBe(201);
    await apiJson(baseUrl, 'DELETE', `/api/v1/chats/${chatId}/invites/${inv.data.code}`, {
      token: admin.token,
    });
    await apiJson(baseUrl, 'PATCH', `/api/v1/chats/${chatId}/members/${member.user_id}`, {
      token: admin.token,
      body: { role: 'admin', custom_title: 'Moderator' },
    });

    const adminLogRes = await apiJson(baseUrl, 'GET', `/api/v1/chats/${chatId}/admin-log`, {
      token: admin.token,
    });
    expect(adminLogRes.status).toBe(200);
    const actions = (adminLogRes.data.events as Array<{ action: string }>).map((e) => e.action);
    expect(actions).toContain('edit_chat_info');
    expect(actions).toContain('pin_message');
    expect(actions).toContain('create_invite');
    expect(actions).toContain('revoke_invite');
    expect(actions).toContain('update_member_role');

    // 4. Calls History (`/api/v1/calls` & `/api/v1/calls/history`)
    const callStart = await apiJson(baseUrl, 'POST', '/api/v1/calls', {
      token: admin.token,
      body: { callee_id: member.user_id, is_video: true },
    });
    expect(callStart.status).toBe(201);
    const callId = String(callStart.data.call_id);

    const calls1 = await apiJson(baseUrl, 'GET', '/api/v1/calls', { token: admin.token });
    const calls2 = await apiJson(baseUrl, 'GET', '/api/v1/calls/history?filter=video&limit=10', {
      token: admin.token,
    });
    expect(calls1.status).toBe(200);
    expect(calls2.status).toBe(200);
    expect((calls1.data.calls as Array<{ call_id: string }>).some((c) => c.call_id === callId)).toBe(
      true,
    );
    expect((calls2.data.calls as Array<{ call_id: string }>).some((c) => c.call_id === callId)).toBe(
      true,
    );
    expect(calls2.data.total).toBeGreaterThanOrEqual(1);
  });

  it('closes all pending scheduled-message plaintext leaks, prevents TOCTOU double delivery, hardens inline-query cache/catalog isolation, and scopes translate fallback (Fixes 8–11)', async () => {
    const owner = await registerTestUser(baseUrl, 'sec_sched_owner');
    const member = await registerTestUser(baseUrl, 'sec_sched_member');
    const outsider = await registerTestUser(baseUrl, 'sec_sched_outsider');

    // Fix 11 minor cleanup: bare '@' username returns 400 invalid_user
    const bareAtPromote = await apiJson(baseUrl, 'POST', '/api/v1/test/promote-support', {
      body: { username: '@', is_support: true },
    });
    expect(bareAtPromote.status).toBe(400);

    // Configure mock LLM for member and owner so translate assertions exercise real paths
    for (const u of [owner, member]) {
      await apiJson(baseUrl, 'PUT', '/api/v1/fabushi/magpie/providers', {
        token: u.token,
        body: {
          provider_id: 'sec_mock',
          name: 'Sec Mock',
          api_mode: 'chat_completions',
          base_url: mockLlmBaseUrl,
          api_key: 'sk-sec-mock',
          default_model: 'gpt-4o-mini',
          enabled: true,
        },
      });
      await apiJson(baseUrl, 'PUT', '/api/v1/fabushi/magpie/config', {
        token: u.token,
        body: { active_provider: 'sec_mock', active_model: 'gpt-4o-mini' },
      });
    }

    // Create shared group + member's own Saved Messages chat
    const grpRes = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
      token: owner.token,
      body: { title: 'Scheduled Security Room', chat_type: 1, member_ids: [member.user_id] },
    });
    expect(grpRes.status).toBe(201);
    const groupId = Number(grpRes.data.chat_id);

    const memberOwnChat = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
      token: member.token,
      body: { title: 'Member Private Room', chat_type: 1, member_ids: [] },
    });
    expect(memberOwnChat.status).toBe(201);
    const memberChatId = Number(memberOwnChat.data.chat_id);

    // Fix 11 minor cleanup: revoking nonexistent invite code does NOT pollute chat_admin_log
    const fakeRevoke = await apiJson(
      baseUrl,
      'DELETE',
      `/api/v1/chats/${groupId}/invites/does_not_exist_code`,
      { token: owner.token },
    );
    expect(fakeRevoke.status).toBe(200);
    const logAfterFakeRevoke = await apiJson(baseUrl, 'GET', `/api/v1/chats/${groupId}/admin-log`, {
      token: owner.token,
    });
    expect(
      (logAfterFakeRevoke.data.events as Array<{ action: string }>).some(
        (e) => e.action === 'revoke_invite',
      ),
    ).toBe(false);

    // Owner schedules a future message with a unique secret & URL + client_nonce
    const secretToken = 'UNSENT_SCHEDULED_TOP_SECRET_9911';
    const schedNonce = 9911223344;
    const futureMs = Date.now() + 600_000;
    const schedRes = await apiJson(baseUrl, 'POST', `/api/v1/chats/${groupId}/messages`, {
      token: owner.token,
      body: {
        text: `${secretToken} https://example.com/secret-preview`,
        schedule_at_ms: futureMs,
        client_nonce: schedNonce,
      },
    });
    expect(schedRes.status).toBe(201);
    const schedId = Number(schedRes.data.message.id);

    // Same-sender client_nonce retry of pending scheduled message still deduplicates cleanly!
    const schedRetry = await apiJson(baseUrl, 'POST', `/api/v1/chats/${groupId}/messages`, {
      token: owner.token,
      body: {
        text: `${secretToken} https://example.com/secret-preview`,
        schedule_at_ms: futureMs,
        client_nonce: schedNonce,
      },
    });
    expect(schedRetry.status).toBe(200);
    expect(schedRetry.data.duplicate).toBe(true);
    expect(Number(schedRetry.data.message.id)).toBe(schedId);

    // Fix 8A: Search must hide unsent scheduled message
    const searchRes = await apiJson(
      baseUrl,
      'GET',
      `/api/v1/search?q=${encodeURIComponent(secretToken)}`,
      { token: member.token },
    );
    expect(searchRes.status).toBe(200);
    expect(searchRes.data.hits).toHaveLength(0);

    // Fix 8B: Export (json & html) & Statistics must exclude unsent scheduled message
    const exportJson = await apiJson(baseUrl, 'GET', `/api/v1/chats/${groupId}/export?format=json`, {
      token: member.token,
    });
    expect(exportJson.status).toBe(200);
    expect(JSON.stringify(exportJson.data)).not.toContain(secretToken);

    const exportHtmlRes = await fetch(`${baseUrl}/api/v1/chats/${groupId}/export?format=html`, {
      headers: { Authorization: `Bearer ${member.token}` },
    });
    expect(exportHtmlRes.status).toBe(200);
    const exportHtmlText = await exportHtmlRes.text();
    expect(exportHtmlText).not.toContain(secretToken);

    const statsBefore = await apiJson(baseUrl, 'GET', `/api/v1/chats/${groupId}/statistics`, {
      token: member.token,
    });
    expect(statsBefore.status).toBe(200);
    expect(statsBefore.data.total_messages).toBe(0);

    // Fix 8C: Forward, Translate, Pin, Reactions, and Edit must NOT expose or mutate pending scheduled message
    const fwdRes = await apiJson(baseUrl, 'POST', `/api/v1/chats/${groupId}/messages/forward`, {
      token: member.token,
      body: { from_chat_id: groupId, to_chat_id: memberChatId, message_ids: [schedId] },
    });
    expect(fwdRes.status).toBe(201);
    expect(fwdRes.data.messages).toHaveLength(0);

    const transSched = await apiJson(
      baseUrl,
      'POST',
      `/api/v1/chats/${groupId}/messages/${schedId}/translate`,
      { token: member.token, body: { target_lang: 'zh' } },
    );
    expect(transSched.status).toBe(404);

    const pinSched = await apiJson(
      baseUrl,
      'POST',
      `/api/v1/chats/${groupId}/messages/${schedId}/pin`,
      { token: owner.token, body: {} },
    );
    expect(pinSched.status).toBe(404);

    const reactSched = await apiJson(
      baseUrl,
      'POST',
      `/api/v1/chats/${groupId}/messages/${schedId}/reactions`,
      { token: member.token, body: { emoji: '👍' } },
    );
    expect(reactSched.status).toBe(404);

    const editSched = await apiJson(
      baseUrl,
      'PATCH',
      `/api/v1/chats/${groupId}/messages/${schedId}`,
      { token: owner.token, body: { text: 'Edited before send' } },
    );
    expect(editSched.status).toBe(404);

    // Fix 8D: Reply preview must NOT leak scheduled message plaintext
    const replyProbe = await apiJson(baseUrl, 'POST', `/api/v1/chats/${groupId}/messages`, {
      token: member.token,
      body: { text: 'Attempting reply preview leak', reply_to_msg_id: schedId },
    });
    expect(replyProbe.status).toBe(201);
    expect(replyProbe.data.message.reply_to?.preview_text).toBeUndefined();

    // Fix 9: deliverScheduledMessageAtomic delivers strictly ONCE (second call returns null, PTS advances by 1)
    const ptsBeforeDeliver = Number(
      (
        server.db
          .prepare(`SELECT pts FROM chats WHERE chat_id = ?`)
          .get(groupId) as { pts: number }
      ).pts,
    );
    const firstDeliver = deliverScheduledMessageAtomic(server.db, server.hub, groupId, schedId);
    const secondDeliver = deliverScheduledMessageAtomic(server.db, server.hub, groupId, schedId);
    expect(firstDeliver).not.toBeNull();
    expect(secondDeliver).toBeNull();
    const ptsAfterDeliver = Number(
      (
        server.db
          .prepare(`SELECT pts FROM chats WHERE chat_id = ?`)
          .get(groupId) as { pts: number }
      ).pts,
    );
    expect(ptsAfterDeliver).toBe(ptsBeforeDeliver + 1);

    // Fix 11: Scoped fallback on POST /api/v1/messages/:messageId/translate without chat_id
    // Two isolated users both own separate private chats with message_id = 1
    const tenantA = await registerTestUser(baseUrl, 'sec_translate_tenant_a');
    const tenantB = await registerTestUser(baseUrl, 'sec_translate_tenant_b');
    await apiJson(baseUrl, 'PUT', '/api/v1/fabushi/magpie/providers', {
      token: tenantB.token,
      body: {
        provider_id: 'sec_mock_b',
        name: 'Sec Mock B',
        api_mode: 'chat_completions',
        base_url: mockLlmBaseUrl,
        api_key: 'sk-sec-mock-b',
        default_model: 'gpt-4o-mini',
        enabled: true,
      },
    });
    await apiJson(baseUrl, 'PUT', '/api/v1/fabushi/magpie/config', {
      token: tenantB.token,
      body: { active_provider: 'sec_mock_b', active_model: 'gpt-4o-mini' },
    });

    const tenantAChat = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
      token: tenantA.token,
      body: { title: 'Tenant A Private Room', chat_type: 1, member_ids: [] },
    });
    const tenantAChatId = Number(tenantAChat.data.chat_id);
    const tenantAM1 = await apiJson(baseUrl, 'POST', `/api/v1/chats/${tenantAChatId}/messages`, {
      token: tenantA.token,
      body: { text: 'Tenant A private message one' },
    });
    expect(tenantAM1.status).toBe(201);
    const tenantAMsgId = Number(tenantAM1.data.message.id);

    const tenantBChat = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
      token: tenantB.token,
      body: { title: 'Tenant B Private Room', chat_type: 1, member_ids: [] },
    });
    const tenantBChatId = Number(tenantBChat.data.chat_id);
    const tenantBM1 = await apiJson(baseUrl, 'POST', `/api/v1/chats/${tenantBChatId}/messages`, {
      token: tenantB.token,
      body: { text: 'Tenant B private message one' },
    });
    expect(tenantBM1.status).toBe(201);
    const tenantBMsgId = Number(tenantBM1.data.message.id);

    // Tenant B translating own message without chat_id succeeds cleanly
    const scopedNormal = await apiJson(
      baseUrl,
      'POST',
      `/api/v1/messages/${tenantBMsgId}/translate`,
      { token: tenantB.token, body: { target_lang: 'en' } },
    );
    expect(scopedNormal.status).toBe(200);
    expect(scopedNormal.data.chat_id).toBe(tenantBChatId);
    expect(scopedNormal.data.original_text).toBe('Tenant B private message one');

    // Outsider calling /messages/:tenantAMsgId/translate without chat_id gets 404 (no 403 cross-tenant existence oracle)
    const outsiderScoped = await apiJson(
      baseUrl,
      'POST',
      `/api/v1/messages/${tenantAMsgId}/translate`,
      { token: outsider.token, body: { target_lang: 'en' } },
    );
    expect(outsiderScoped.status).toBe(404);

    // Composite PK (chat_id, message_id) collision check: both Tenant A (inserted first) and Tenant B share message_id 50001
    const sharedMsgId = 50001;
    const nowTs = Date.now();
    const insertShared = server.db.prepare(`
      INSERT INTO messages (
        chat_id, message_id, sender_id, date_ms, content_json, text_plain,
        entities_json, flags_json, media_type, deleted_for_everyone, scheduled_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, '[]', '{}', 'none', 0, NULL)
    `);
    insertShared.run(
      tenantAChatId,
      sharedMsgId,
      tenantA.user_id,
      nowTs - 1000,
      JSON.stringify({ type: 'Text', data: { text: 'Tenant A shared id secret' } }),
      'Tenant A shared id secret',
    );
    insertShared.run(
      tenantBChatId,
      sharedMsgId,
      tenantB.user_id,
      nowTs,
      JSON.stringify({ type: 'Text', data: { text: 'Tenant B shared id text' } }),
      'Tenant B shared id text',
    );
    const scopedCollision = await apiJson(
      baseUrl,
      'POST',
      `/api/v1/messages/${sharedMsgId}/translate`,
      { token: tenantB.token, body: { target_lang: 'en' } },
    );
    expect(scopedCollision.status).toBe(200);
    expect(scopedCollision.data.chat_id).toBe(tenantBChatId);
    expect(scopedCollision.data.original_text).toBe('Tenant B shared id text');

    // Fix 10: Inline query cache_time: 0 non-caching, public_catalog_entries zero-leak + missing updated_at_ms safety + custom bot isolation + filterKind
    const customBot = await apiJson(baseUrl, 'POST', '/api/v1/bots', {
      token: owner.token,
      body: { display_name: 'Ephemeral Inline Bot', username: 'ephemeral_iq_bot' },
    });
    expect(customBot.status).toBe(201);
    const customBotId = Number(customBot.data.bot.bot_user_id);
    const customBotToken = String(customBot.data.bot_token);
    await apiJson(baseUrl, 'PATCH', `/api/v1/bots/${customBotId}`, {
      token: owner.token,
      body: { is_inline: true },
    });

    const iqFirst = await apiJson(
      baseUrl,
      'GET',
      '/api/v1/bots/inline-query?bot=ephemeral_iq_bot&query=nocache_item',
      { token: owner.token },
    );
    expect(iqFirst.status).toBe(200);
    const iqFirstId = String(iqFirst.data.query_id);

    const ansZeroCache = await apiJson(baseUrl, 'POST', `/bot/${customBotToken}/answerInlineQuery`, {
      body: {
        inline_query_id: iqFirstId,
        cache_time: 0,
        results: [{ type: 'article', id: 'ephem_1', title: 'Ephemeral Uncached Result' }],
      },
    });
    expect(ansZeroCache.status).toBe(200);

    // Explicit query_id still retrieves the answered result
    const iqById = await apiJson(
      baseUrl,
      'GET',
      `/api/v1/bots/inline-query?bot=ephemeral_iq_bot&query_id=${encodeURIComponent(iqFirstId)}`,
      { token: owner.token },
    );
    expect(iqById.status).toBe(200);
    expect(iqById.data.results).toHaveLength(1);

    // Fresh query without query_id MUST NOT serve cache_time: 0 result!
    const iqFresh = await apiJson(
      baseUrl,
      'GET',
      '/api/v1/bots/inline-query?bot=ephemeral_iq_bot&query=nocache_item',
      { token: owner.token },
    );
    expect(iqFresh.status).toBe(200);
    expect(iqFresh.data.results).toHaveLength(0);

    // Create a minimal public_catalog_entries table WITHOUT updated_at_ms but WITH visibility/review_status/deleted_at_ms
    server.db.exec(`
      CREATE TABLE IF NOT EXISTS public_catalog_entries (
        creation_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        visibility TEXT NOT NULL DEFAULT 'public',
        review_status TEXT NOT NULL DEFAULT 'approved',
        deleted_at_ms INTEGER
      );
    `);
    try {
      server.db
        .prepare(
          `INSERT OR REPLACE INTO public_catalog_entries
            (creation_id, kind, title, summary, visibility, review_status, deleted_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('pub_book_99', 'book', 'Stellar Atlas', 'Approved public astronomy book', 'public', 'approved', null);
      server.db
        .prepare(
          `INSERT OR REPLACE INTO public_catalog_entries
            (creation_id, kind, title, summary, visibility, review_status, deleted_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('priv_draft_99', 'book', 'Stellar Secret Draft', 'Private draft book', 'private', 'draft', null);
      server.db
        .prepare(
          `INSERT OR REPLACE INTO public_catalog_entries
            (creation_id, kind, title, summary, visibility, review_status, deleted_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('del_book_99', 'book', 'Stellar Deleted Book', 'Removed book', 'public', 'approved', Date.now());

      // Official @FabushiBot with kind=book returns ONLY pub_book_99 (no 500 crash, no private/draft/deleted leak, no MiniApps)
      const officialBooks = await apiJson(
        baseUrl,
        'GET',
        '/api/v1/bots/inline-query?bot=FabushiBot&kind=book&query=Stellar',
        { token: owner.token },
      );
      expect(officialBooks.status).toBe(200);
      const resultIds = (officialBooks.data.results as Array<{ id: string }>).map((r) => r.id);
      expect(resultIds).toEqual(['cat_pub_book_99']);

      // Unrelated custom bot MUST NOT be polluted by global public_catalog_entries
      const customQuery = await apiJson(
        baseUrl,
        'GET',
        '/api/v1/bots/inline-query?bot=ephemeral_iq_bot&query=Stellar',
        { token: owner.token },
      );
      expect(customQuery.status).toBe(200);
      expect(customQuery.data.results).toHaveLength(0);
    } finally {
      server.db.exec(`DROP TABLE IF EXISTS public_catalog_entries;`);
    }
  });

  it('enforces Iteration 3 scheduled-message isolation across WS SendReaction, deleteMessagesAtomic, clearHistory, official MCP, and translate/multiAgent fallbacks (Fixes 6–9)', async () => {
    const alice = await registerTestUser(baseUrl, 'iter3_alice', {
      password: 'Iter3Password123!',
    });
    const bob = await registerTestUser(baseUrl, 'iter3_bob', {
      password: 'Iter3Password123!',
    });

    // 1. Group setup for WS SendReaction (Fix 6), group non-admin oracle (Fix 7), and Official MCP (Fix 8)
    const grpRes = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
      token: alice.token,
      body: { title: 'Iter3 Security Group', chat_type: 1, member_ids: [bob.user_id] },
    });
    expect(grpRes.status).toBe(201);
    const groupId = Number(grpRes.data.chat_id);

    const deliveredRes = await apiJson(baseUrl, 'POST', `/api/v1/chats/${groupId}/messages`, {
      token: alice.token,
      body: { text: 'ITER3_MCP_VISIBLE_DELIVERED_101' },
    });
    expect(deliveredRes.status).toBe(201);
    const deliveredId = Number(deliveredRes.data.message.id);

    const deletedForAllRes = await apiJson(baseUrl, 'POST', `/api/v1/chats/${groupId}/messages`, {
      token: alice.token,
      body: { text: 'ITER3_MCP_DELETED_ALL_102' },
    });
    expect(deletedForAllRes.status).toBe(201);
    const deletedForAllId = Number(deletedForAllRes.data.message.id);
    expect(
      (
        await apiJson(
          baseUrl,
          'DELETE',
          `/api/v1/chats/${groupId}/messages/${deletedForAllId}?for_everyone=true`,
          { token: alice.token },
        )
      ).status,
    ).toBe(200);

    const deletedForBobRes = await apiJson(baseUrl, 'POST', `/api/v1/chats/${groupId}/messages`, {
      token: alice.token,
      body: { text: 'ITER3_MCP_HIDDEN_FOR_BOB_103' },
    });
    expect(deletedForBobRes.status).toBe(201);
    const deletedForBobId = Number(deletedForBobRes.data.message.id);
    expect(
      (
        await apiJson(
          baseUrl,
          'DELETE',
          `/api/v1/chats/${groupId}/messages/${deletedForBobId}?for_everyone=false`,
          { token: bob.token },
        )
      ).status,
    ).toBe(200);

    const grpSchedSecret = 'ITER3_ULTRA_SECRET_SCHED_999';
    const grpSchedRes = await apiJson(baseUrl, 'POST', `/api/v1/chats/${groupId}/messages`, {
      token: alice.token,
      body: { text: grpSchedSecret, schedule_at_ms: Date.now() + 600_000 },
    });
    expect(grpSchedRes.status).toBe(201);
    const grpSchedId = Number(grpSchedRes.data.message.id);

    // Fix 6: Live WS SendReaction & Reaction targeting pending scheduled message MUST return 404 and leave message_reactions empty
    const bobWs = await connectWsAuthenticated(wsUrl, bob.token);
    try {
      bobWs.ws.send(JSON.stringify({ type: 'SubscribeChat', payload: { chat_id: groupId } }));
      await new Promise((r) => setTimeout(r, 80));

      const errBefore = bobWs.frames.filter((f) => f.type === 'Error').length;
      bobWs.ws.send(
        JSON.stringify({
          type: 'SendReaction',
          payload: { chat_id: groupId, message_id: grpSchedId, emoji: '🔥', action: 'add' },
        }),
      );
      await bobWs.waitForFrame(
        (f) => f.type === 'Error' && f.payload?.code === 404,
      );

      bobWs.ws.send(
        JSON.stringify({
          type: 'Reaction',
          payload: { chat_id: groupId, message_id: grpSchedId, emoji: '❤️', action: 'add' },
        }),
      );
      await new Promise((r) => setTimeout(r, 120));

      const err404Frames = bobWs.frames.filter(
        (f) => f.type === 'Error' && f.payload?.code === 404,
      );
      expect(err404Frames.length).toBeGreaterThanOrEqual(errBefore + 2);
      const rxBroadcasts = bobWs.frames.filter(
        (f) => f.type === 'PtsPush' && f.payload?.update?.type === 'ReactionUpdated',
      );
      expect(rxBroadcasts).toHaveLength(0);

      const rxCountRow = server.db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM message_reactions WHERE chat_id = ? AND message_id = ?`,
        )
        .get(groupId, grpSchedId) as { cnt: number };
      expect(Number(rxCountRow.cnt)).toBe(0);
    } finally {
      bobWs.ws.close();
    }

    // Fix 7 (Group non-admin oracle): Bob deleting Alice's pending scheduled ID returns 200 with empty deletedIds (NOT 403 oracle),
    // while deleting Alice's delivered message STILL enforces 403 forbidden!
    const bobProbeSched = await apiJson(
      baseUrl,
      'DELETE',
      `/api/v1/chats/${groupId}/messages/${grpSchedId}?for_everyone=true`,
      { token: bob.token },
    );
    expect(bobProbeSched.status).toBe(200);
    expect(bobProbeSched.data.tombstone?.message_ids).toEqual([]);

    const bobProbeDelivered = await apiJson(
      baseUrl,
      'DELETE',
      `/api/v1/chats/${groupId}/messages/${deliveredId}?for_everyone=true`,
      { token: bob.token },
    );
    expect(bobProbeDelivered.status).toBe(403);

    // Fix 7 (1:1 DM cross-user destruction): Bob CANNOT wipe Alice's pending scheduled DM via REST DELETE, WS DeleteMessages, or clearHistory
    const dmRes = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
      token: alice.token,
      body: { title: 'Iter3 DM', chat_type: 0, member_ids: [bob.user_id] },
    });
    expect(dmRes.status).toBe(201);
    const dmId = Number(dmRes.data.chat_id);

    const dmDeliveredRes = await apiJson(baseUrl, 'POST', `/api/v1/chats/${dmId}/messages`, {
      token: alice.token,
      body: { text: 'Normal DM message' },
    });
    expect(dmDeliveredRes.status).toBe(201);

    const dmSchedRes = await apiJson(baseUrl, 'POST', `/api/v1/chats/${dmId}/messages`, {
      token: alice.token,
      body: { text: 'DM_SECRET_SCHED_777', schedule_at_ms: Date.now() + 600_000 },
    });
    expect(dmSchedRes.status).toBe(201);
    const dmSchedId = Number(dmSchedRes.data.message.id);

    const ptsBeforeDmDelete = Number(
      (
        server.db.prepare(`SELECT pts FROM chats WHERE chat_id = ?`).get(dmId) as { pts: number }
      ).pts,
    );

    // REST DELETE for_everyone=true
    const bobRestDel = await apiJson(
      baseUrl,
      'DELETE',
      `/api/v1/chats/${dmId}/messages/${dmSchedId}?for_everyone=true`,
      { token: bob.token },
    );
    expect(bobRestDel.status).toBe(200);
    expect(bobRestDel.data.tombstone?.message_ids).toEqual([]);
    expect(bobRestDel.data.pts).toBe(ptsBeforeDmDelete);

    // REST DELETE for_everyone=false must NOT insert message_user_deletions for scheduled ID
    const bobLocalDel = await apiJson(
      baseUrl,
      'DELETE',
      `/api/v1/chats/${dmId}/messages/${dmSchedId}?for_everyone=false`,
      { token: bob.token },
    );
    expect(bobLocalDel.status).toBe(200);
    expect(bobLocalDel.data.tombstone?.message_ids).toEqual([]);
    const mudRow = server.db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM message_user_deletions WHERE chat_id = ? AND message_id = ?`,
      )
      .get(dmId, dmSchedId) as { cnt: number };
    expect(Number(mudRow.cnt)).toBe(0);

    // Live WS DeleteMessages { for_everyone: true }
    const bobDmWs = await connectWsAuthenticated(wsUrl, bob.token);
    try {
      bobDmWs.ws.send(
        JSON.stringify({
          type: 'DeleteMessages',
          payload: { chat_id: dmId, message_ids: [dmSchedId], for_everyone: true },
        }),
      );
      await new Promise((r) => setTimeout(r, 120));
    } finally {
      bobDmWs.ws.close();
    }

    // POST /history/clear { for_everyone: true } clears normal DM messages but preserves Alice's pending scheduled message
    const bobClearDm = await apiJson(baseUrl, 'POST', `/api/v1/chats/${dmId}/history/clear`, {
      token: bob.token,
      body: { for_everyone: true },
    });
    expect(bobClearDm.status).toBe(200);

    const aliceSchedAfterAttacks = await apiJson(
      baseUrl,
      'GET',
      `/api/v1/chats/${dmId}/scheduled-messages`,
      { token: alice.token },
    );
    expect(aliceSchedAfterAttacks.status).toBe(200);
    const remainingDmSchedIds = (
      aliceSchedAfterAttacks.data.messages as Array<{ id: number; text: string }>
    ).map((m) => m.id);
    expect(remainingDmSchedIds).toEqual([dmSchedId]);

    // Fix 8: Official MCP get_chat_history & search_messages exclude unsent scheduled, deleted-for-all, deleted-for-me, and cleared messages
    const regClient = await apiJson(baseUrl, 'POST', '/oauth/register', {
      body: {
        client_name: 'Iter3 MCP Audit Client',
        redirect_uris: ['http://127.0.0.1:9899/cb'],
        token_endpoint_auth_method: 'none',
      },
    });
    expect(regClient.status).toBe(201);
    const clientId = String(regClient.data.client_id);

    const verifier = 'iter3_pkce_verifier_abcdefghijklmnopqrstuvwxyz_0123456789';
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const authPage = await apiJson(
      baseUrl,
      'GET',
      `/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent('http://127.0.0.1:9899/cb')}&response_type=code&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256&scope=${encodeURIComponent('chats:read messaging:read')}&resource=${encodeURIComponent(`${baseUrl}/mcp`)}`,
    );
    expect(authPage.status).toBe(200);
    const oauthCookie = (authPage.headers.get('set-cookie') ?? '').split(';')[0]!;
    const txId = /name="tx_id" value="([^"]+)"/.exec(authPage.rawText)![1]!;
    const csrf1 = /name="csrf_token" value="([^"]+)"/.exec(authPage.rawText)![1]!;

    const oauthLogin = await apiJson(baseUrl, 'POST', '/oauth/authorize/login', {
      headers: { Cookie: oauthCookie, Accept: 'application/json' },
      body: {
        tx_id: txId,
        csrf_token: csrf1,
        username: bob.username,
        password: 'Iter3Password123!',
      },
    });
    expect(oauthLogin.status).toBe(200);
    const csrf2 = String(oauthLogin.data.csrf_token);

    const oauthApprove = await fetch(`${baseUrl}/oauth/authorize/approve`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Cookie: oauthCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx_id: txId, csrf_token: csrf2, decision: 'approve' }),
    });
    expect(oauthApprove.status).toBe(302);
    const authCode = new URL(oauthApprove.headers.get('location')!).searchParams.get('code')!;

    const tokRes = await apiJson(baseUrl, 'POST', '/oauth/token', {
      body: {
        grant_type: 'authorization_code',
        code: authCode,
        client_id: clientId,
        redirect_uri: 'http://127.0.0.1:9899/cb',
        code_verifier: verifier,
      },
    });
    expect(tokRes.status).toBe(200);
    const bobMcpToken = String(tokRes.data.access_token);

    const mcpHeaders = { 'MCP-Protocol-Version': '2025-11-25' };
    const mcpHist = await apiJson(baseUrl, 'POST', '/mcp', {
      token: bobMcpToken,
      headers: mcpHeaders,
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_chat_history', arguments: { chat_id: groupId, limit: 20 } },
      },
    });
    expect(mcpHist.status).toBe(200);
    const histPayloadText = String(mcpHist.data.result?.content?.[0]?.text ?? '');
    expect(histPayloadText).toContain('ITER3_MCP_VISIBLE_DELIVERED_101');
    expect(histPayloadText).not.toContain(grpSchedSecret);
    expect(histPayloadText).not.toContain('ITER3_MCP_DELETED_ALL_102');
    expect(histPayloadText).not.toContain('ITER3_MCP_HIDDEN_FOR_BOB_103');

    const mcpSearchSched = await apiJson(baseUrl, 'POST', '/mcp', {
      token: bobMcpToken,
      headers: mcpHeaders,
      body: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'search_messages', arguments: { query: grpSchedSecret, limit: 20 } },
      },
    });
    expect(mcpSearchSched.status).toBe(200);
    const searchSchedParsed = JSON.parse(String(mcpSearchSched.data.result?.content?.[0]?.text));
    expect(searchSchedParsed.total).toBe(0);
    expect(searchSchedParsed.hits).toEqual([]);

    const mcpSearchHidden = await apiJson(baseUrl, 'POST', '/mcp', {
      token: bobMcpToken,
      headers: mcpHeaders,
      body: {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'search_messages',
          arguments: { query: 'ITER3_MCP_HIDDEN_FOR_BOB_103', limit: 20 },
        },
      },
    });
    expect(mcpSearchHidden.status).toBe(200);
    expect(JSON.parse(String(mcpSearchHidden.data.result?.content?.[0]?.text)).total).toBe(0);

    const mcpSearchVisible = await apiJson(baseUrl, 'POST', '/mcp', {
      token: bobMcpToken,
      headers: mcpHeaders,
      body: {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'search_messages',
          arguments: { query: 'ITER3_MCP_VISIBLE_DELIVERED_101', limit: 20 },
        },
      },
    });
    expect(mcpSearchVisible.status).toBe(200);
    expect(JSON.parse(String(mcpSearchVisible.data.result?.content?.[0]?.text)).total).toBe(1);

    // After Bob clears history locally, MCP get_chat_history & search_messages respect cleared_up_to_msg_id
    expect(
      (
        await apiJson(baseUrl, 'POST', `/api/v1/chats/${groupId}/history/clear`, {
          token: bob.token,
          body: { for_everyone: false },
        })
      ).status,
    ).toBe(200);

    const mcpHistAfterClear = await apiJson(baseUrl, 'POST', '/mcp', {
      token: bobMcpToken,
      headers: mcpHeaders,
      body: {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'get_chat_history', arguments: { chat_id: groupId, limit: 20 } },
      },
    });
    expect(mcpHistAfterClear.status).toBe(200);
    expect(JSON.parse(String(mcpHistAfterClear.data.result?.content?.[0]?.text)).messages).toEqual(
      [],
    );

    const mcpSearchAfterClear = await apiJson(baseUrl, 'POST', '/mcp', {
      token: bobMcpToken,
      headers: mcpHeaders,
      body: {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'search_messages',
          arguments: { query: 'ITER3_MCP_VISIBLE_DELIVERED_101', limit: 20 },
        },
      },
    });
    expect(mcpSearchAfterClear.status).toBe(200);
    expect(JSON.parse(String(mcpSearchAfterClear.data.result?.content?.[0]?.text)).total).toBe(0);

    // Fix 9: Translate fallback skips 'left' chat memberships in favor of active chats sharing message_id
    await apiJson(baseUrl, 'PUT', '/api/v1/fabushi/magpie/providers', {
      token: bob.token,
      body: {
        provider_id: 'iter3_mock_bob',
        name: 'Iter3 Mock Bob',
        api_mode: 'chat_completions',
        base_url: mockLlmBaseUrl,
        api_key: 'sk-iter3-mock-bob',
        default_model: 'gpt-4o-mini',
        enabled: true,
      },
    });
    await apiJson(baseUrl, 'PUT', '/api/v1/fabushi/magpie/config', {
      token: bob.token,
      body: { active_provider: 'iter3_mock_bob', active_model: 'gpt-4o-mini' },
    });

    const activeChat = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
      token: bob.token,
      body: { title: 'Iter3 Active Chat', chat_type: 1, member_ids: [] },
    });
    const activeChatId = Number(activeChat.data.chat_id);
    const leftChat = await apiJson(baseUrl, 'POST', '/api/v1/chats', {
      token: alice.token,
      body: { title: 'Iter3 Left Chat', chat_type: 1, member_ids: [bob.user_id] },
    });
    const leftChatId = Number(leftChat.data.chat_id);
    server.db
      .prepare(`UPDATE chat_members SET role = 'left' WHERE chat_id = ? AND user_id = ?`)
      .run(leftChatId, bob.user_id);

    const collideMsgId = 60001;
    const baseTs = Date.now();
    const insertCollide = server.db.prepare(`
      INSERT INTO messages (
        chat_id, message_id, sender_id, date_ms, content_json, text_plain,
        entities_json, flags_json, media_type, deleted_for_everyone, scheduled_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, '[]', '{}', 'none', 0, NULL)
    `);
    insertCollide.run(
      activeChatId,
      collideMsgId,
      bob.user_id,
      baseTs - 2000,
      JSON.stringify({ type: 'Text', data: { text: 'Bob active chat message' } }),
      'Bob active chat message',
    );
    insertCollide.run(
      leftChatId,
      collideMsgId,
      alice.user_id,
      baseTs,
      JSON.stringify({ type: 'Text', data: { text: 'Alice newer left chat secret' } }),
      'Alice newer left chat secret',
    );

    const transActive = await apiJson(
      baseUrl,
      'POST',
      `/api/v1/messages/${collideMsgId}/translate`,
      { token: bob.token, body: { target_lang: 'en' } },
    );
    expect(transActive.status).toBe(200);
    expect(transActive.data.chat_id).toBe(activeChatId);
    expect(transActive.data.original_text).toBe('Bob active chat message');

    // Deliver grpSchedId now and confirm zero premature WS reactions leaked onto it
    const deliveredSched = await apiJson(
      baseUrl,
      'POST',
      `/api/v1/chats/${groupId}/scheduled-messages/${grpSchedId}/send-now`,
      { token: alice.token },
    );
    expect(deliveredSched.status).toBe(200);
    expect(deliveredSched.data.message.reactions ?? []).toEqual([]);
  });
});


