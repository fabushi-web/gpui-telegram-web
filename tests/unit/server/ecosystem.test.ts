import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateE2eeIdentity, signPreKeyPublic } from '@gpui-telegram/protocol';
import {
  REPO_ROOT_DIR,
  createTelegramServer,
  type TelegramServerInstance,
} from '@gpui-telegram/server';
import { serveStaticSpa } from '../../../apps/server/src/staticHost.js';
import { computeNextCronRunMs } from '../../../apps/server/src/utils/crypto.js';
import { registerTestUser } from './_helpers.js';

const TEST_TMP_ROOT = path.join(REPO_ROOT_DIR, '.test-tmp');

async function reqJson<T = any>(
  baseUrl: string,
  method: string,
  route: string,
  token?: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = { ...(extraHeaders ?? {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : {}) as T };
}

function sendRawHttpPath(port: number, rawPath: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
      sock.write(`GET ${rawPath} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    const chunks: Buffer[] = [];
    sock.on('data', (c: Buffer) => chunks.push(c));
    sock.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const firstLine = raw.split('\r\n')[0] ?? '';
      const m = /^HTTP\/1\.[01]\s+(\d+)/.exec(firstLine);
      const statusCode = m ? Number(m[1]) : 0;
      const bodyIdx = raw.indexOf('\r\n\r\n');
      resolve({ statusCode, body: bodyIdx >= 0 ? raw.slice(bodyIdx + 4) : '' });
    });
    sock.once('error', reject);
  });
}

describe('@gpui-telegram/server — Social, Stories, E2EE PreKeys, Calls, BotFather/MiniApps, DERP & Static SPA', () => {
  let server: TelegramServerInstance;
  let baseUrl = '';
  let serverPort = 0;
  let dataDir = '';
  let customDistRoot = '';
  let webDistDir = '';
  let siblingSecretDir = '';

  beforeAll(async () => {
    const suffix = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    dataDir = path.join(TEST_TMP_ROOT, `m1a-eco-${suffix}`);
    customDistRoot = path.join(TEST_TMP_ROOT, `m1a-static-${suffix}`);
    webDistDir = path.join(customDistRoot, 'dist');
    siblingSecretDir = path.join(customDistRoot, 'dist-secret');

    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(webDistDir, { recursive: true });
    fs.mkdirSync(siblingSecretDir, { recursive: true });
    fs.writeFileSync(
      path.join(webDistDir, 'index.html'),
      '<!doctype html><html><body><div id="root"></div></body></html>',
    );
    fs.writeFileSync(
      path.join(webDistDir, 'manifest.webmanifest'),
      JSON.stringify({ name: 'GPUI Telegram Web', display: 'standalone' }),
    );
    fs.writeFileSync(path.join(siblingSecretDir, 'secret.txt'), 'SIBLING_SECRET_LEAK');

    server = createTelegramServer({
      port: 0,
      host: '127.0.0.1',
      dataDir,
      webDistDir,
      enableTestReset: true,
    });
    const info = await server.start();
    baseUrl = info.baseUrl;
    serverPort = info.port;
  });

  afterAll(async () => {
    await server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(customDistRoot, { recursive: true, force: true });
  });

  it('serves SPA assets & .webmanifest MIME, blocks sibling-directory path traversal with 403, and 404s unknown /api/* routes', async () => {
    const rootHtml = await fetch(`${baseUrl}/`);
    expect(rootHtml.status).toBe(200);
    expect(rootHtml.headers.get('content-type')).toContain('text/html');
    const htmlBody = await rootHtml.text();
    expect(htmlBody).toContain('<div id="root"></div>');

    const manifest = await fetch(`${baseUrl}/manifest.webmanifest`);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get('content-type')).toContain('application/manifest+json');

    // Direct unit check on serveStaticSpa sibling-prefix traversal (`/../dist-secret/secret.txt` -> 403!)
    let mockStatus = 200;
    let mockBody = '';
    const handled = serveStaticSpa(
      { method: 'GET' } as any,
      {
        set statusCode(v: number) {
          mockStatus = v;
        },
        get statusCode() {
          return mockStatus;
        },
        setHeader() {},
        end(chunk?: string) {
          mockBody = chunk ?? '';
        },
      } as any,
      '/../dist-secret/secret.txt',
      webDistDir,
    );
    expect(handled).toBe(true);
    expect(mockStatus).toBe(403);
    expect(mockBody).not.toContain('SIBLING_SECRET_LEAK');

    // Network-level raw HTTP traversal (`/%2e%2e/dist-secret/secret.txt`) is also blocked (403/404) and NEVER leaks secret.txt!
    const traversal = await sendRawHttpPath(serverPort, '/%2e%2e/dist-secret/secret.txt');
    expect([403, 404]).toContain(traversal.statusCode);
    expect(traversal.body).not.toContain('SIBLING_SECRET_LEAK');

    // Deep-link SPA route falls back to index.html
    const deepLink = await fetch(`${baseUrl}/chat/101`);
    expect(deepLink.status).toBe(200);
    expect(deepLink.headers.get('content-type')).toContain('text/html');

    // Unknown API route returns JSON 404 (not HTML)
    const unknownApi = await reqJson(baseUrl, 'GET', '/api/v1/nonexistent-endpoint');
    expect(unknownApi.status).toBe(404);
    expect(unknownApi.data.error).toBe('not_found');
  });

  it('manages groups, forum topics, folders, contacts, @username lookup, invites, secret chats, and TTL expiry', async () => {
    await reqJson(baseUrl, 'POST', '/api/v1/test/reset');
    const aliceUser = await registerTestUser(baseUrl, 'alice_eco', { first_name: 'Alice' });
    const bobUser = await registerTestUser(baseUrl, 'bob_eco', { first_name: 'Bob' });
    const linweiUser = await registerTestUser(baseUrl, 'linwei_eco', { first_name: 'Lin Wei' });
    const alice = aliceUser.token;
    const bob = bobUser.token;
    const linwei = linweiUser.token;

    // Create Supergroup Forum
    const forumRes = await reqJson(baseUrl, 'POST', '/api/v1/chats', alice, {
      title: 'Core Architecture Forum',
      chat_type: 2,
      is_forum: true,
      member_ids: [bobUser.user_id],
    });
    expect(forumRes.status).toBe(201);
    expect(forumRes.data.is_forum).toBe(true);
    const forumId = forumRes.data.chat_id as number;

    // Non-admin member Bob cannot create forum topics -> 403!
    const bobTopicDenied = await reqJson(baseUrl, 'POST', `/api/v1/chats/${forumId}/topics`, bob, {
      title: 'Unauthorized Topic',
    });
    expect(bobTopicDenied.status).toBe(403);

    // Owner Alice creates topic #Performance
    const topicRes = await reqJson(baseUrl, 'POST', `/api/v1/chats/${forumId}/topics`, alice, {
      title: 'Performance',
      icon_emoji: '⚡',
    });
    expect(topicRes.status).toBe(201);
    expect(topicRes.data.topic_id).toBe(2);

    // Non-admin member Bob cannot close topic -> 403!
    const bobCloseDenied = await reqJson(
      baseUrl,
      'PATCH',
      `/api/v1/chats/${forumId}/topics/2`,
      bob,
      { is_closed: true },
    );
    expect(bobCloseDenied.status).toBe(403);

    // Create invite link -> Lin Wei joins -> revoke -> 410
    const inv = await reqJson(baseUrl, 'POST', `/api/v1/chats/${forumId}/invites`, alice, {
      title: 'Design Invite',
      usage_limit: 2,
    });
    expect(inv.status).toBe(201);

    const joined = await reqJson(baseUrl, 'POST', `/api/v1/invites/${inv.data.code}/join`, linwei);
    expect(joined.status).toBe(200);
    expect(joined.data.chat_id).toBe(forumId);

    await reqJson(baseUrl, 'DELETE', `/api/v1/chats/${forumId}/invites/${inv.data.code}`, alice);
    const afterRevoke = await reqJson(baseUrl, 'POST', `/api/v1/invites/${inv.data.code}/join`, bob);
    expect(afterRevoke.status).toBe(410);

    // Folders CRUD
    const newFolder = await reqJson(baseUrl, 'POST', '/api/v1/folders', alice, {
      title: 'Architecture',
      emoticon: '🏛️',
      include_chats: [forumId],
    });
    expect(newFolder.status).toBe(201);
    const filteredChats = await reqJson(
      baseUrl,
      'GET',
      `/api/v1/chats?folder_id=${newFolder.data.id}`,
      alice,
    );
    expect(filteredChats.data.chats.some((c: any) => c.chat_id === forumId)).toBe(true);

    // Resolve @username (real user + real public channel)
    const resolvedUser = await reqJson(baseUrl, 'GET', '/api/v1/peers/resolve?username=@bob_eco', alice);
    expect(resolvedUser.status).toBe(200);
    expect(resolvedUser.data.peer_type).toBe('user');
    expect(resolvedUser.data.user.user_id).toBe(bobUser.user_id);

    const pubChan = await reqJson(baseUrl, 'POST', '/api/v1/chats', alice, {
      title: 'Tech News Channel',
      chat_type: 3,
      username: 'tech_news_channel',
    });
    expect(pubChan.status).toBe(201);

    const resolvedChan = await reqJson(baseUrl, 'GET', '/api/v1/peers/resolve?username=tech_news_channel', alice);
    expect(resolvedChan.status).toBe(200);
    expect(resolvedChan.data.peer_type).toBe('chat');

    // Secret Chat creation + 4-emoji safety fingerprint + TTL message expiry
    const secret = await reqJson(baseUrl, 'POST', '/api/v1/secret-chats', alice, {
      peer_user_id: bobUser.user_id,
      ttl_seconds: 1,
    });
    expect(secret.status).toBe(201);
    expect(secret.data.emoji_fingerprint.length).toBe(4);
    const secretChatId = secret.data.chat.chat_id as number;

    const ephemeralMsg = await reqJson(
      baseUrl,
      'POST',
      `/api/v1/chats/${secretChatId}/messages`,
      alice,
      { text: 'Self-destructing secret message', ttl_seconds: 1 },
    );
    expect(ephemeralMsg.status).toBe(201);

    await new Promise((r) => setTimeout(r, 1100));
    const afterTtl = await reqJson(baseUrl, 'GET', `/api/v1/chats/${secretChatId}/messages`, alice);
    expect(afterTtl.data.messages.length).toBe(0);
  });

  it('handles Stories, Stickers, empty GIFs, E2EE PreKeys, WebRTC/TURN aliases, @BotFather /setdescription & /deletebot, MiniApp /storage & Fabushi X-Telegram-Init-Data, and DERP WS', async () => {
    const aliceUser = await registerTestUser(baseUrl, 'alice_eco2', { first_name: 'Alice' });
    const bobUser = await registerTestUser(baseUrl, 'bob_eco2', { first_name: 'Bob' });
    const alice = aliceUser.token;
    const bob = bobUser.token;

    // Create real DM between Alice & Bob
    const dmRes = await reqJson(baseUrl, 'POST', '/api/v1/chats', alice, {
      chat_type: 0,
      peer_user_id: bobUser.user_id,
    });
    expect(dmRes.status).toBe(201);
    const dmChatId = dmRes.data.chat_id as number;

    // Stories create + view increment
    const story = await reqJson(baseUrl, 'POST', '/api/v1/stories', alice, {
      caption: 'Testing Stories in Vitest!',
    });
    expect(story.status).toBe(201);
    const view1 = await reqJson(baseUrl, 'POST', `/api/v1/stories/${story.data.storyId}/view`, bob);
    expect(view1.status).toBe(200);
    expect(view1.data.views_count).toBe(1);

    // Stickers & truthful empty GIFs (fake SVG GIF route removed -> 404)
    const stickers = await reqJson(baseUrl, 'GET', '/api/v1/stickers/sets', alice);
    expect(stickers.status).toBe(200);
    expect(stickers.data.sets.length).toBeGreaterThan(0);

    const gifs = await reqJson(baseUrl, 'GET', '/api/v1/gifs/search?q=rocket', alice);
    expect(gifs.status).toBe(200);
    expect(gifs.data.gifs).toEqual([]);
    const fakeGifSvg = await fetch(`${baseUrl}/api/v1/gifs/svg/celebrate`);
    expect(fakeGifSvg.status).toBe(404);

    // E2EE PreKey Directory: publish 2 OTPKs -> fetch -> count drops 2 -> 1
    const bobIdentity = await generateE2eeIdentity('bob-dev-1');
    const bobSpk = await generateE2eeIdentity('bob-spk-1');
    const spkSig = await signPreKeyPublic(bobIdentity.signingKeyPair.privateKey, bobSpk.dhKeyPair.publicKeyBase64);

    const pubRes = await reqJson(baseUrl, 'POST', '/api/v1/e2ee/prekeys', bob, {
      device_id: 'bob-dev-1',
      identity_key: bobIdentity.dhKeyPair.publicKeyBase64,
      identity_signing_key: bobIdentity.signingKeyPair.publicKeyBase64,
      signed_prekey: {
        key_id: 1,
        public_key: bobSpk.dhKeyPair.publicKeyBase64,
        signature: spkSig,
      },
      one_time_prekeys: [
        { key_id: 101, public_key: bobSpk.dhKeyPair.publicKeyBase64 },
        { key_id: 102, public_key: bobSpk.dhKeyPair.publicKeyBase64 },
      ],
    });
    expect(pubRes.status).toBe(200);

    const fetchBundle1 = await reqJson(baseUrl, 'GET', `/api/v1/e2ee/users/${bobUser.user_id}/prekeys`, alice);
    expect(fetchBundle1.status).toBe(200);
    expect(fetchBundle1.data.devices[0].one_time_prekey.key_id).toBe(101);

    const countAfter1 = await reqJson(baseUrl, 'GET', '/api/v1/e2ee/prekeys/count?device_id=bob-dev-1', bob);
    expect(countAfter1.data.remaining_one_time_prekeys).toBe(1);

    // WebRTC Calls & HMAC-SHA1 TURN Credentials (missing callee -> 400!)
    const turn = await reqJson(baseUrl, 'GET', '/api/v1/webrtc/turn_credentials', alice);
    expect(turn.status).toBe(200);
    expect(turn.data.credential).toBeTruthy();

    const missingCallee = await reqJson(baseUrl, 'POST', '/api/v1/calls/invite', alice, {});
    expect(missingCallee.status).toBe(400);

    const startCall = await reqJson(baseUrl, 'POST', '/api/v1/calls/invite', alice, {
      callee_id: bobUser.user_id,
      chat_id: dmChatId,
      is_video: true,
    });
    expect(startCall.status).toBe(201);
    const endCall = await reqJson(baseUrl, 'POST', `/api/v1/calls/${startCall.data.call_id}/end`, alice, {
      duration_secs: 42,
      rating: 5,
    });
    expect(endCall.status).toBe(200);
    expect(endCall.data.state).toBe('ended');

    // Create real DM with official @BotFather (777001): /newbot -> /setdescription -> inline callback -> /deletebot
    const bfChatRes = await reqJson(baseUrl, 'POST', '/api/v1/chats', alice, {
      chat_type: 0,
      peer_user_id: 777001,
    });
    expect(bfChatRes.status).toBe(201);
    const botFatherChatId = bfChatRes.data.chat_id as number;

    await reqJson(baseUrl, 'POST', `/api/v1/chats/${botFatherChatId}/messages`, alice, { text: '/newbot' });
    await reqJson(baseUrl, 'POST', `/api/v1/chats/${botFatherChatId}/messages`, alice, { text: 'Temp QA Bot' });
    await reqJson(baseUrl, 'POST', `/api/v1/chats/${botFatherChatId}/messages`, alice, { text: 'temp_qa_bot' });

    await reqJson(baseUrl, 'POST', `/api/v1/chats/${botFatherChatId}/messages`, alice, {
      text: '/setdescription @temp_qa_bot Automated QA Verification Bot',
    });
    const botsBeforeDel = await reqJson(baseUrl, 'GET', '/api/v1/bots', alice);
    const createdBot = botsBeforeDel.data.bots.find((b: any) => b.username === 'temp_qa_bot');
    expect(createdBot).toBeDefined();
    expect(createdBot.description).toBe('Automated QA Verification Bot');

    const cbRes = await reqJson(baseUrl, 'POST', `/api/v1/chats/${botFatherChatId}/callback`, alice, {
      message_id: 0,
      callback_data: 'bf:mybots',
    });
    expect(cbRes.status).toBe(200);
    expect(cbRes.data.ok).toBe(true);

    await reqJson(baseUrl, 'POST', `/api/v1/chats/${botFatherChatId}/messages`, alice, {
      text: '/deletebot @temp_qa_bot',
    });
    const botsAfterDel = await reqJson(baseUrl, 'GET', '/api/v1/bots', alice);
    expect(botsAfterDel.data.bots.some((b: any) => b.username === 'temp_qa_bot')).toBe(false);

    // MiniApp `/storage` & `/validate-init-data` aliases + Fabushi `X-Telegram-Init-Data` per-user state isolation!
    const bobLaunch = await reqJson(
      baseUrl,
      'POST',
      '/api/v1/miniapps/FabushiBot/fabushi-globe/launch',
      bob,
      {},
    );
    expect(bobLaunch.status).toBe(200);

    const validateAlias = await reqJson(
      baseUrl,
      'POST',
      '/api/v1/miniapps/FabushiBot/fabushi-globe/validate-init-data',
      undefined,
      { init_data: bobLaunch.data.init_data },
    );
    expect(validateAlias.status).toBe(200);
    expect(validateAlias.data.valid).toBe(true);

    const putBobStorage = await reqJson(
      baseUrl,
      'PUT',
      '/api/v1/miniapps/777002/storage',
      undefined,
      { key: 'sutra_bookmark', value: 'heart_sutra_v2' },
      { 'X-Telegram-Init-Data': bobLaunch.data.init_data },
    );
    expect(putBobStorage.status).toBe(200);

    const getBobStorage = await reqJson(
      baseUrl,
      'GET',
      '/api/v1/miniapps/777002/storage',
      undefined,
      undefined,
      { 'X-Telegram-Init-Data': bobLaunch.data.init_data },
    );
    expect(getBobStorage.status).toBe(200);
    expect(getBobStorage.data.items.sutra_bookmark).toBe('heart_sutra_v2');

    // Fabushi tap via X-Telegram-Init-Data updates Bob's state via canonical /api/v1/fabushi-miniapp/*
    const bobMuyu = await reqJson(
      baseUrl,
      'POST',
      '/api/v1/fabushi-miniapp/zen/muyu',
      undefined,
      { count: 12 },
      { 'X-Telegram-Init-Data': bobLaunch.data.init_data },
    );
    expect(bobMuyu.status).toBe(200);
    expect(bobMuyu.data.wooden_fish_taps).toBeGreaterThanOrEqual(12);

    const tamperedFabushi = await reqJson(
      baseUrl,
      'GET',
      '/api/v1/fabushi-miniapp/state',
      undefined,
      undefined,
      { 'X-Telegram-Init-Data': bobLaunch.data.init_data.replace(/hash=[0-9a-f]{4}/, 'hash=beef') },
    );
    expect(tamperedFabushi.status).toBe(401);

    // Legacy colliding /api/v1/fabushi/zen/muyu removed -> 404, while /api/v1/fabushi/state serves Hermes runtime!
    const legacyCollidingMuyu = await reqJson(baseUrl, 'POST', '/api/v1/fabushi/zen/muyu', bob, { count: 1 });
    expect(legacyCollidingMuyu.status).toBe(404);
    const runtimeState = await reqJson(baseUrl, 'GET', '/api/v1/fabushi/state', alice);
    expect(runtimeState.status).toBe(200);
    expect(runtimeState.data.ready).toBe(true);
    expect(runtimeState.data.commands_count).toBe(61);

    // Telegram HTTP Bot API (`/bot<token>/getMe` & `/bot/:token/sendMessage`)
    const botMe = await reqJson(baseUrl, 'GET', '/bot/777002:AAOfficialFabushiBotToken_v1/getMe');
    expect(botMe.status).toBe(200);
    expect(botMe.data.ok).toBe(true);
    expect(botMe.data.result.username).toBe('FabushiBot');

    // Tailnet DERP WebSocket Relay (`welcome` + `keep_alive` -> `keep_alive_ack`)
    const derpUrl = `${baseUrl.replace(/^http/, 'ws')}/api/v1/tailnet/derp?token=${encodeURIComponent(alice)}&device_id=node_a`;
    const derpAck = await new Promise<any>((resolve, reject) => {
      const dws = new WebSocket(derpUrl);
      dws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString('utf8'));
        if (msg.type === 'welcome') {
          dws.send(JSON.stringify({ type: 'keep_alive', client_time_ms: 12345 }));
        } else if (msg.type === 'keep_alive_ack') {
          dws.close();
          resolve(msg);
        }
      });
      dws.once('error', reject);
    });
    expect(derpAck.client_time_ms).toBe(12345);
  });

  it('evaluates 5-field POSIX cron and @every schedules accurately and rejects malformed expressions', () => {
    const refMs = Date.UTC(2026, 10, 17, 8, 12, 30);

    expect(computeNextCronRunMs('@every 45s', refMs)).toBe(refMs + 45_000);
    expect(computeNextCronRunMs('*/15 * * * *', refMs)).toBe(Date.UTC(2026, 10, 17, 8, 15, 0));
    expect(computeNextCronRunMs('0 9 * * 1-5', refMs)).toBe(Date.UTC(2026, 10, 17, 9, 0, 0));
    expect(computeNextCronRunMs('@daily', refMs)).toBe(Date.UTC(2026, 10, 18, 0, 0, 0));

    expect(() => computeNextCronRunMs('99 * * * *', refMs)).toThrow();
    expect(() => computeNextCronRunMs('not a cron', refMs)).toThrow();
  });
});
