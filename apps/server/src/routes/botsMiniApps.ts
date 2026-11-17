import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  escapeHtml,
  type BotRegistryEntry,
  type MiniAppEntry,
  type MiniAppLaunchContext,
  type MiniAppThemeParams,
} from '@gpui-telegram/protocol';
import { createMessageAtomic, getUserProfileDto } from '../db/queries.js';
import { signMiniAppInitData, verifyMiniAppInitData } from '../utils/crypto.js';
import {
  ApiError,
  authenticateToken,
  extractBearerToken,
  readJsonBody,
  requireAuth,
  sendJson,
  type HttpRouter,
  type RequestContext,
} from '../utils/http.js';
import type { RealtimeGatewayHub } from '../ws/hub.js';

const NIGHT_THEME_PARAMS: MiniAppThemeParams = {
  bg_color: '#17212B',
  text_color: '#F5F5F5',
  hint_color: '#7F91A4',
  link_color: '#3390EC',
  button_color: '#3390EC',
  button_text_color: '#FFFFFF',
  secondary_bg_color: '#0E1621',
  header_bg_color: '#17212B',
};

/**
 * Valid minimal WebAssembly binary (`\0asm\x01\x00\x00\x00`) exporting `meritStep(current: i32, delta: i32) -> i32`
 * used by the `全球法布施` (`fabushi-globe`) Mini App via genuine `WebAssembly.instantiate(...)`!
 */
const FABUSHI_WASM_BASE64 = Buffer.from([
  0x00, 0x61, 0x73, 0x6d, // "\0asm"
  0x01, 0x00, 0x00, 0x00, // version 1
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f, // Type section: (i32, i32) -> i32
  0x03, 0x02, 0x01, 0x00, // Function section: func 0 uses type 0
  0x07, 0x0d, 0x01, 0x09, 0x6d, 0x65, 0x72, 0x69, 0x74, 0x53, 0x74, 0x65, 0x70, 0x00, 0x00, // Export "meritStep"
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b, // Code: local.get 0, local.get 1, i32.add, end
]).toString('base64');

function nextBotUserId(db: DatabaseSync): number {
  const row = db
    .prepare(`SELECT COALESCE(MAX(bot_user_id), 800000) AS mx FROM bots_registry WHERE bot_user_id >= 800000`)
    .get() as { mx: number };
  return Math.max(800001, Number(row.mx) + 1);
}

function ensureCompanionDmChat(db: DatabaseSync, userId: number, botUserId: number): number {
  const existing = db
    .prepare(
      `SELECT c.chat_id FROM chats c
       JOIN chat_members m1 ON m1.chat_id = c.chat_id AND m1.user_id = ?
       JOIN chat_members m2 ON m2.chat_id = c.chat_id AND m2.user_id = ?
       WHERE c.chat_type = 0
       LIMIT 1`,
    )
    .get(userId, botUserId) as { chat_id: number } | undefined;

  if (existing) {
    return Number(existing.chat_id);
  }

  const botUser = getUserProfileDto(db, botUserId);
  const mx = db.prepare(`SELECT COALESCE(MAX(chat_id), 500) AS mx FROM chats`).get() as { mx: number };
  const chatId = Math.max(501, Number(mx.mx) + 1);
  const now = Date.now();

  db.prepare(`
    INSERT INTO chats (
      chat_id, title, kind, chat_type, creator_id, peer_user_id, username, about,
      is_forum, is_verified, pts, next_msg_id, last_message_id, last_message_date_ms, created_at_ms
    ) VALUES (?, ?, 'bot', 0, ?, ?, NULL, ?, 0, 1, 0, 1, 0, ?, ?)
  `).run(
    chatId,
    botUser?.first_name ?? `Bot ${botUserId}`,
    userId,
    botUserId,
    botUser?.bio ?? null,
    now,
    now,
  );
  db.prepare(`INSERT INTO chat_members (chat_id, user_id, role, joined_at_ms) VALUES (?, ?, 'member', ?)`).run(chatId, userId, now);
  db.prepare(`INSERT INTO chat_members (chat_id, user_id, role, joined_at_ms) VALUES (?, ?, 'owner', ?)`).run(chatId, botUserId, now);
  return chatId;
}

function createBotRecord(
  db: DatabaseSync,
  ownerUserId: number,
  displayName: string,
  rawUsername: string,
  description = '',
): { entry: BotRegistryEntry; botToken: string; companionChatId: number } {
  const cleanUsername = rawUsername.trim().replace(/^@/, '');
  if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(cleanUsername) || !/bot$/i.test(cleanUsername)) {
    throw new ApiError(
      400,
      'invalid_bot_username',
      'Bot username must be 5–32 characters and end in "bot" (e.g. DemoHelperBot)',
    );
  }

  const dup = db
    .prepare(`SELECT user_id FROM users WHERE LOWER(username) = LOWER(?)`)
    .get(cleanUsername);
  if (dup) {
    throw new ApiError(409, 'username_taken', `Bot username @${cleanUsername} is already taken`);
  }

  const botUserId = nextBotUserId(db);
  const secret = crypto.randomBytes(18).toString('base64url');
  const botToken = `${botUserId}:AA${secret}`;
  const now = Date.now();

  db.prepare(`
    INSERT INTO users (
      user_id, username, first_name, bio, emoji_status, is_bot, is_verified, is_premium,
      status, last_seen_ms, created_at_ms
    ) VALUES (?, ?, ?, ?, '🤖', 1, 0, 0, 'bot', ?, ?)
  `).run(botUserId, cleanUsername, displayName.trim() || cleanUsername, description || null, now, now);

  const entry: BotRegistryEntry = {
    bot_user_id: botUserId,
    owner_user_id: ownerUserId,
    username: cleanUsername,
    display_name: displayName.trim() || cleanUsername,
    description,
    about: description,
    commands: [{ command: 'start', description: 'Start interacting with this bot' }],
    is_official: false,
    is_inline: false,
    allow_attach_menu: false,
    menu_button_type: 'commands',
    has_main_app: false,
    created_at_ms: now,
  };

  db.prepare(`
    INSERT INTO bots_registry (bot_user_id, owner_user_id, bot_token, bot_json, created_at_ms)
    VALUES (?, ?, ?, ?, ?)
  `).run(botUserId, ownerUserId, botToken, JSON.stringify(entry), now);

  const companionChatId = ensureCompanionDmChat(db, ownerUserId, botUserId);
  return { entry, botToken, companionChatId };
}

/**
 * Handles conversational `@BotFather` (`777001`) and `@FabushiBot` (`777002`) chat messages!
 */
export function handleBotConversationTurn(
  db: DatabaseSync,
  hub: RealtimeGatewayHub,
  chatId: number,
  senderId: number,
  rawText: string,
): boolean {
  const botMember = db
    .prepare(
      `SELECT u.user_id, u.username
       FROM chat_members m
       JOIN users u ON u.user_id = m.user_id
       WHERE m.chat_id = ? AND u.is_bot = 1 AND u.user_id != ?
       LIMIT 1`,
    )
    .get(chatId, senderId) as { user_id: number; username: string | null } | undefined;

  if (!botMember) return false;
  const botId = Number(botMember.user_id);
  const text = rawText.trim();

  if (botId === 777001) {
    // @BotFather stateful wizard
    const wiz = db
      .prepare(`SELECT step, draft_json FROM botfather_wizards WHERE user_id = ?`)
      .get(senderId) as { step: string; draft_json: string } | undefined;

    if (/^\/cancel\b/i.test(text)) {
      db.prepare(`DELETE FROM botfather_wizards WHERE user_id = ?`).run(senderId);
      createMessageAtomic(db, hub, {
        chatId,
        senderId: 777001,
        text: 'Current command cancelled. Anything else I can do for you?',
      });
      return true;
    }

    if (/^\/start\b|^\/help\b/i.test(text)) {
      db.prepare(`DELETE FROM botfather_wizards WHERE user_id = ?`).run(senderId);
      createMessageAtomic(db, hub, {
        chatId,
        senderId: 777001,
        text: 'I can help you create and manage Telegram bots & Mini Apps:\n/newbot — create a new bot\n/mybots — list your bots\n/setdescription — change bot description\n/newapp — create a WebApp Mini App\n/deletebot — delete a bot\n/cancel — cancel current wizard',
        inlineKeyboard: [
          [
            { text: '➕ /newbot', callback_data: 'bf:newbot' },
            { text: '🤖 /mybots', callback_data: 'bf:mybots' },
          ],
          [
            { text: '🧩 /newapp', callback_data: 'bf:newapp' },
            { text: '🗑️ /deletebot', callback_data: 'bf:deletebot' },
          ],
        ],
      });
      return true;
    }

    if (/^\/newbot\b/i.test(text)) {
      db.prepare(`
        INSERT OR REPLACE INTO botfather_wizards (user_id, step, draft_json, updated_at_ms)
        VALUES (?, 'await_bot_name', '{}', ?)
      `).run(senderId, Date.now());
      createMessageAtomic(db, hub, {
        chatId,
        senderId: 777001,
        text: 'Alright, a new bot. How are we going to call it? Please choose a display name for your bot.',
      });
      return true;
    }

    if (/^\/mybots\b/i.test(text)) {
      const rows = db
        .prepare(`SELECT bot_json FROM bots_registry WHERE owner_user_id = ? ORDER BY created_at_ms DESC`)
        .all(senderId) as Array<{ bot_json: string }>;
      const list = rows.map((r) => {
        const b = JSON.parse(r.bot_json) as BotRegistryEntry;
        return `• **${b.display_name}** (@${b.username})`;
      });
      createMessageAtomic(db, hub, {
        chatId,
        senderId: 777001,
        text: list.length > 0 ? `Your bots:\n${list.join('\n')}` : 'You have no bots yet. Send /newbot to create one!',
      });
      return true;
    }

    if (/^\/newapp\b/i.test(text)) {
      db.prepare(`
        INSERT OR REPLACE INTO botfather_wizards (user_id, step, draft_json, updated_at_ms)
        VALUES (?, 'await_app_bot', '{}', ?)
      `).run(senderId, Date.now());
      createMessageAtomic(db, hub, {
        chatId,
        senderId: 777001,
        text: 'Creating a new WebApp Mini App. Please send the `@username` of the bot that will host the Mini App.',
      });
      return true;
    }

    if (/^\/setdescription\b/i.test(text)) {
      const rest = text.replace(/^\/setdescription\s*/i, '').trim();
      const inlineMatch = /^@?([A-Za-z0-9_]+)\s+([\s\S]+)$/.exec(rest);
      if (inlineMatch) {
        const targetU = inlineMatch[1]!.toLowerCase();
        const desc = inlineMatch[2]!.trim();
        const rows = db
          .prepare(`SELECT bot_user_id, bot_json FROM bots_registry WHERE owner_user_id = ?`)
          .all(senderId) as Array<{ bot_user_id: number; bot_json: string }>;
        const target = rows
          .map((r) => JSON.parse(r.bot_json) as BotRegistryEntry)
          .find((b) => b.username.toLowerCase() === targetU);
        if (!target) {
          createMessageAtomic(db, hub, {
            chatId,
            senderId: 777001,
            text: `Bot @${inlineMatch[1]} not found among your bots.`,
          });
          return true;
        }
        target.description = desc;
        db.prepare(`UPDATE bots_registry SET bot_json = ? WHERE bot_user_id = ?`).run(
          JSON.stringify(target),
          target.bot_user_id,
        );
        db.prepare(`UPDATE users SET bio = ? WHERE user_id = ?`).run(desc, target.bot_user_id);
        createMessageAtomic(db, hub, {
          chatId,
          senderId: 777001,
          text: `Success! Description updated for @${target.username}.`,
        });
        return true;
      }

      db.prepare(`
        INSERT OR REPLACE INTO botfather_wizards (user_id, step, draft_json, updated_at_ms)
        VALUES (?, 'await_desc_bot', '{}', ?)
      `).run(senderId, Date.now());
      createMessageAtomic(db, hub, {
        chatId,
        senderId: 777001,
        text: 'Choose a bot to change description. Please send the `@username` of your bot.',
      });
      return true;
    }

    if (/^\/deletebot\b/i.test(text)) {
      const argU = text.replace(/^\/deletebot\s*/i, '').trim().replace(/^@/, '');
      if (argU) {
        const rows = db
          .prepare(`SELECT bot_user_id, bot_json FROM bots_registry WHERE owner_user_id = ?`)
          .all(senderId) as Array<{ bot_user_id: number; bot_json: string }>;
        const target = rows
          .map((r) => JSON.parse(r.bot_json) as BotRegistryEntry)
          .find((b) => b.username.toLowerCase() === argU.toLowerCase());
        if (!target || target.bot_user_id < 800000) {
          createMessageAtomic(db, hub, {
            chatId,
            senderId: 777001,
            text: `Cannot delete @${argU}: bot not owned by you or protected system bot.`,
          });
          return true;
        }
        db.prepare(`DELETE FROM mini_apps WHERE bot_user_id = ?`).run(target.bot_user_id);
        db.prepare(`DELETE FROM bots_registry WHERE bot_user_id = ?`).run(target.bot_user_id);
        db.prepare(`DELETE FROM users WHERE user_id = ?`).run(target.bot_user_id);
        createMessageAtomic(db, hub, {
          chatId,
          senderId: 777001,
          text: `Done! The bot @${target.username} has been deleted.`,
        });
        return true;
      }

      db.prepare(`
        INSERT OR REPLACE INTO botfather_wizards (user_id, step, draft_json, updated_at_ms)
        VALUES (?, 'await_delete_bot', '{}', ?)
      `).run(senderId, Date.now());
      createMessageAtomic(db, hub, {
        chatId,
        senderId: 777001,
        text: 'Choose a bot to delete. Please send its `@username`.',
      });
      return true;
    }

    if (wiz?.step === 'await_bot_name') {
      db.prepare(`
        UPDATE botfather_wizards SET step = 'await_bot_username', draft_json = ?, updated_at_ms = ? WHERE user_id = ?
      `).run(JSON.stringify({ displayName: text }), Date.now(), senderId);
      createMessageAtomic(db, hub, {
        chatId,
        senderId: 777001,
        text: `Good. Now let's choose a username for your bot. It must end in \`bot\` (for example, \`TetrisBot\` or \`tetris_bot\`).`,
      });
      return true;
    }

    if (wiz?.step === 'await_bot_username') {
      const draft = JSON.parse(wiz.draft_json) as { displayName?: string };
      try {
        const created = createBotRecord(db, senderId, draft.displayName ?? text, text);
        db.prepare(`DELETE FROM botfather_wizards WHERE user_id = ?`).run(senderId);
        createMessageAtomic(db, hub, {
          chatId,
          senderId: 777001,
          text: `Done! Congratulations on your new bot **${created.entry.display_name}** (@${created.entry.username}).\n\nUse this token to access the HTTP API:\n\`${created.botToken}\``,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Invalid username';
        createMessageAtomic(db, hub, {
          chatId,
          senderId: 777001,
          text: `Sorry, ${msg}. Please try another username ending in \`bot\`:`,
        });
      }
      return true;
    }

    if (wiz?.step === 'await_app_bot') {
      const cleanU = text.replace(/^@/, '');
      const botRow = db
        .prepare(`SELECT bot_user_id, bot_json FROM bots_registry`)
        .all() as Array<{ bot_user_id: number; bot_json: string }>;
      const found = botRow
        .map((r) => JSON.parse(r.bot_json) as BotRegistryEntry)
        .find((b) => b.username.toLowerCase() === cleanU.toLowerCase());
      if (!found) {
        createMessageAtomic(db, hub, {
          chatId,
          senderId: 777001,
          text: `Bot @${cleanU} not found. Please send a valid bot @username or /cancel.`,
        });
        return true;
      }
      db.prepare(`
        UPDATE botfather_wizards SET step = 'await_app_short_name', draft_json = ?, updated_at_ms = ? WHERE user_id = ?
      `).run(JSON.stringify({ botUserId: found.bot_user_id, botUsername: found.username }), Date.now(), senderId);
      createMessageAtomic(db, hub, {
        chatId,
        senderId: 777001,
        text: `Great! Send a short alphanumeric \`short_name\` for your Mini App on @${found.username} (e.g. \`dashboard\`):`,
      });
      return true;
    }

    if (wiz?.step === 'await_app_short_name') {
      const draft = JSON.parse(wiz.draft_json) as { botUserId: number; botUsername: string };
      const shortName = text.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'webapp';
      const appId = `app_${crypto.randomBytes(6).toString('hex')}`;
      const app: MiniAppEntry = {
        app_id: appId,
        bot_user_id: draft.botUserId,
        bot_username: draft.botUsername,
        short_name: shortName,
        title: `${draft.botUsername} · ${shortName}`,
        description: `Mini App created via @BotFather`,
        category: 'utilities',
        icon_emoji: '🧩',
        web_url: `/miniapps/${draft.botUsername}/${shortName}`,
        is_installed: true,
        install_count: 1,
        created_at_ms: Date.now(),
      };
      db.prepare(`
        INSERT OR REPLACE INTO mini_apps (app_id, bot_user_id, bot_username, short_name, app_json, html_bundle, created_at_ms)
        VALUES (?, ?, ?, ?, ?, NULL, ?)
      `).run(appId, app.bot_user_id, app.bot_username, app.short_name, JSON.stringify(app), app.created_at_ms);
      db.prepare(`DELETE FROM botfather_wizards WHERE user_id = ?`).run(senderId);
      createMessageAtomic(db, hub, {
        chatId,
        senderId: 777001,
        text: `Mini App created! Launch URL: \`/miniapps/${app.bot_username}/${app.short_name}\``,
      });
      return true;
    }

    if (wiz?.step === 'await_desc_bot') {
      const cleanU = text.replace(/^@/, '').toLowerCase();
      const rows = db
        .prepare(`SELECT bot_user_id, bot_json FROM bots_registry WHERE owner_user_id = ?`)
        .all(senderId) as Array<{ bot_user_id: number; bot_json: string }>;
      const target = rows
        .map((r) => JSON.parse(r.bot_json) as BotRegistryEntry)
        .find((b) => b.username.toLowerCase() === cleanU);
      if (!target) {
        createMessageAtomic(db, hub, {
          chatId,
          senderId: 777001,
          text: `Bot @${cleanU} not found among your bots. Send a valid @username or /cancel.`,
        });
        return true;
      }
      db.prepare(`
        UPDATE botfather_wizards SET step = 'await_desc_text', draft_json = ?, updated_at_ms = ? WHERE user_id = ?
      `).run(JSON.stringify({ botUserId: target.bot_user_id, botUsername: target.username }), Date.now(), senderId);
      createMessageAtomic(db, hub, {
        chatId,
        senderId: 777001,
        text: `OK. Send me the new description for @${target.username}.`,
      });
      return true;
    }

    if (wiz?.step === 'await_desc_text') {
      const draft = JSON.parse(wiz.draft_json) as { botUserId: number; botUsername: string };
      const row = db
        .prepare(`SELECT bot_json FROM bots_registry WHERE bot_user_id = ?`)
        .get(draft.botUserId) as { bot_json: string } | undefined;
      if (row) {
        const entry = JSON.parse(row.bot_json) as BotRegistryEntry;
        entry.description = text;
        db.prepare(`UPDATE bots_registry SET bot_json = ? WHERE bot_user_id = ?`).run(
          JSON.stringify(entry),
          draft.botUserId,
        );
        db.prepare(`UPDATE users SET bio = ? WHERE user_id = ?`).run(text, draft.botUserId);
      }
      db.prepare(`DELETE FROM botfather_wizards WHERE user_id = ?`).run(senderId);
      createMessageAtomic(db, hub, {
        chatId,
        senderId: 777001,
        text: `Success! Description updated for @${draft.botUsername}.`,
      });
      return true;
    }

    if (wiz?.step === 'await_delete_bot') {
      const cleanU = text.replace(/^@/, '').toLowerCase();
      const rows = db
        .prepare(`SELECT bot_user_id, bot_json FROM bots_registry WHERE owner_user_id = ?`)
        .all(senderId) as Array<{ bot_user_id: number; bot_json: string }>;
      const target = rows
        .map((r) => JSON.parse(r.bot_json) as BotRegistryEntry)
        .find((b) => b.username.toLowerCase() === cleanU);
      if (!target || target.bot_user_id < 800000) {
        createMessageAtomic(db, hub, {
          chatId,
          senderId: 777001,
          text: `Cannot delete @${cleanU}: bot not owned by you or protected system bot.`,
        });
        return true;
      }
      db.prepare(`DELETE FROM mini_apps WHERE bot_user_id = ?`).run(target.bot_user_id);
      db.prepare(`DELETE FROM bots_registry WHERE bot_user_id = ?`).run(target.bot_user_id);
      db.prepare(`DELETE FROM users WHERE user_id = ?`).run(target.bot_user_id);
      db.prepare(`DELETE FROM botfather_wizards WHERE user_id = ?`).run(senderId);
      createMessageAtomic(db, hub, {
        chatId,
        senderId: 777001,
        text: `Done! The bot @${target.username} has been deleted.`,
      });
      return true;
    }

    createMessageAtomic(db, hub, {
      chatId,
      senderId: 777001,
      text: 'Unrecognized command. Send /newbot, /mybots, /setdescription, /newapp, /deletebot, or /help.',
    });
    return true;
  }

  if (botId === 777002) {
    // @FabushiBot companion reply
    createMessageAtomic(db, hub, {
      chatId,
      senderId: 777002,
      text: `随喜赞叹！已同步至 **全球法布施** 禅室记录。\n[STATE_PATCH]{"last_message":${JSON.stringify(text.slice(0, 80))}}[/STATE_PATCH]`,
      inlineKeyboard: [
        [{ text: '🌏 打开全球法布施 3D Globe', web_app_url: '/miniapps/FabushiBot/fabushi-globe' }],
      ],
    });
    return true;
  }

  // Generic custom bot auto-acknowledgement
  if (botId >= 800000) {
    const botUser = getUserProfileDto(db, botId);
    createMessageAtomic(db, hub, {
      chatId,
      senderId: botId,
      text: `🤖 **${botUser?.first_name ?? 'Bot'}** received: "${text}"`,
    });
    return true;
  }

  return false;
}

function getFabushiState(db: DatabaseSync, userId: number): {
  merit_total: number;
  wooden_fish_taps: number;
  incense_lit: boolean;
  beams: Array<{ id: string; from_city: string; to_city: string; sutra: string; created_at_ms: number }>;
  dedications: Array<{ text: string; created_at_ms: number }>;
} {
  const row = db
    .prepare(`SELECT state_json FROM fabushi_state WHERE user_id = ?`)
    .get(userId) as { state_json: string } | undefined;
  if (row) {
    return JSON.parse(row.state_json);
  }
  return {
    merit_total: 108,
    wooden_fish_taps: 36,
    incense_lit: true,
    beams: [
      { id: 'beam_1', from_city: 'Hangzhou', to_city: 'Kyoto', sutra: '般若波罗蜜多心经', created_at_ms: Date.now() - 60_000 },
      { id: 'beam_2', from_city: 'Singapore', to_city: 'San Francisco', sutra: '金刚般若波罗蜜经', created_at_ms: Date.now() - 30_000 },
    ],
    dedications: [{ text: '愿以此功德，普及于一切', created_at_ms: Date.now() - 120_000 }],
  };
}

function saveFabushiState(
  db: DatabaseSync,
  userId: number,
  state: ReturnType<typeof getFabushiState>,
): void {
  db.prepare(`
    INSERT OR REPLACE INTO fabushi_state (user_id, state_json, updated_at_ms)
    VALUES (?, ?, ?)
  `).run(userId, JSON.stringify(state), Date.now());
}

export function registerBotsMiniAppsAndFabushiRoutes(
  router: HttpRouter,
  db: DatabaseSync,
  hub: RealtimeGatewayHub,
): void {
  // 1. Bot Registry REST Endpoints (`/api/v1/bots*`)
  router.get('/api/v1/bots', (ctx) => {
    requireAuth(db, ctx);
    const rows = db
      .prepare(`SELECT bot_json FROM bots_registry ORDER BY created_at_ms ASC`)
      .all() as Array<{ bot_json: string }>;
    const bots = rows.map(
      (r) => JSON.parse(r.bot_json) as BotRegistryEntry,
    );
    sendJson(ctx.res, 200, { bots });
  });

  router.post('/api/v1/bots', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      display_name?: string;
      name?: string;
      username?: string;
      description?: string;
    }>(ctx.req);

    const created = createBotRecord(
      db,
      auth.userId,
      body.display_name ?? body.name ?? 'Custom Bot',
      body.username ?? '',
      body.description ?? '',
    );
    sendJson(ctx.res, 201, {
      bot: created.entry,
      bot_token: created.botToken,
      chat_id: created.companionChatId,
    });
  });

  router.get('/api/v1/bots/:botId', (ctx) => {
    requireAuth(db, ctx);
    const param = ctx.params.botId!.replace(/^@/, '');
    const rows = db.prepare(`SELECT bot_json FROM bots_registry`).all() as Array<{ bot_json: string }>;
    const bot = rows
      .map((r) => JSON.parse(r.bot_json) as BotRegistryEntry)
      .find((b) => String(b.bot_user_id) === param || b.username.toLowerCase() === param.toLowerCase());
    if (!bot) throw new ApiError(404, 'bot_not_found', 'Bot not found');
    sendJson(ctx.res, 200, bot);
  });

  router.patch('/api/v1/bots/:botId', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const botId = Number(ctx.params.botId);
    const row = db
      .prepare(`SELECT owner_user_id, bot_json FROM bots_registry WHERE bot_user_id = ?`)
      .get(botId) as { owner_user_id: number; bot_json: string } | undefined;
    if (!row) throw new ApiError(404, 'bot_not_found', 'Bot not found');
    if (Number(row.owner_user_id) !== auth.userId) {
      throw new ApiError(403, 'forbidden', 'Only the bot owner can update bot settings');
    }

    const patch = await readJsonBody<Partial<BotRegistryEntry>>(ctx.req);
    const current = JSON.parse(row.bot_json) as BotRegistryEntry;
    const updated: BotRegistryEntry = {
      ...current,
      ...patch,
      bot_user_id: current.bot_user_id,
      owner_user_id: current.owner_user_id,
      username: current.username,
    };
    db.prepare(`UPDATE bots_registry SET bot_json = ? WHERE bot_user_id = ?`).run(
      JSON.stringify(updated),
      botId,
    );
    sendJson(ctx.res, 200, updated);
  });

  router.post('/api/v1/bots/:botId/regenerate-token', (ctx) => {
    const auth = requireAuth(db, ctx);
    const botId = Number(ctx.params.botId);
    const row = db
      .prepare(`SELECT owner_user_id FROM bots_registry WHERE bot_user_id = ?`)
      .get(botId) as { owner_user_id: number } | undefined;
    if (!row || Number(row.owner_user_id) !== auth.userId) {
      throw new ApiError(403, 'forbidden', 'Cannot regenerate token for this bot');
    }
    const newToken = `${botId}:AA${crypto.randomBytes(18).toString('base64url')}`;
    db.prepare(`UPDATE bots_registry SET bot_token = ? WHERE bot_user_id = ?`).run(newToken, botId);
    sendJson(ctx.res, 200, { ok: true, bot_token: newToken });
  });

  router.delete('/api/v1/bots/:botId', (ctx) => {
    const auth = requireAuth(db, ctx);
    const botId = Number(ctx.params.botId);
    const row = db
      .prepare(`SELECT owner_user_id, bot_json FROM bots_registry WHERE bot_user_id = ?`)
      .get(botId) as { owner_user_id: number; bot_json: string } | undefined;
    if (!row) throw new ApiError(404, 'bot_not_found', 'Bot not found');
    const entry = JSON.parse(row.bot_json) as BotRegistryEntry;
    if (entry.is_official || Number(row.owner_user_id) !== auth.userId) {
      throw new ApiError(403, 'forbidden', 'Cannot delete official or unowned bot');
    }
    db.prepare(`DELETE FROM bots_registry WHERE bot_user_id = ?`).run(botId);
    sendJson(ctx.res, 200, { ok: true });
  });

  // 2. Telegram HTTP Bot API Compatibility (`/bot:botToken/:method`)
  const handleBotHttpApi = async (ctx: RequestContext): Promise<void> => {
    const botToken = ctx.params.botToken ?? '';
    const method = ctx.params.method!;

    const botRow = db
      .prepare(`SELECT bot_user_id, bot_json FROM bots_registry WHERE bot_token = ?`)
      .get(botToken) as { bot_user_id: number; bot_json: string } | undefined;
    if (!botRow) {
      sendJson(ctx.res, 401, { ok: false, error_code: 401, description: 'Unauthorized bot token' });
      return;
    }

    const bot = JSON.parse(botRow.bot_json) as BotRegistryEntry;
    const body = ctx.method === 'POST' ? await readJsonBody<Record<string, unknown>>(ctx.req) : {};

    switch (method) {
      case 'getMe':
        sendJson(ctx.res, 200, {
          ok: true,
          result: {
            id: bot.bot_user_id,
            is_bot: true,
            first_name: bot.display_name,
            username: bot.username,
            can_join_groups: true,
            supports_inline_queries: bot.is_inline,
          },
        });
        return;

      case 'sendMessage': {
        const chatId = Number(body.chat_id ?? ctx.query.get('chat_id'));
        const text = String(body.text ?? ctx.query.get('text') ?? '');
        const msgRes = createMessageAtomic(db, hub, {
          chatId,
          senderId: bot.bot_user_id,
          text,
        });
        sendJson(ctx.res, 200, {
          ok: true,
          result: {
            message_id: msgRes.message.id,
            chat: { id: chatId },
            date: Math.floor(Date.now() / 1000),
            text: msgRes.message.text,
          },
        });
        return;
      }

      case 'getUpdates': {
        const updates = db
          .prepare(`SELECT update_id, payload_json FROM bot_api_updates WHERE bot_user_id = ? ORDER BY update_id ASC LIMIT 50`)
          .all(bot.bot_user_id) as Array<{ update_id: number; payload_json: string }>;
        sendJson(ctx.res, 200, {
          ok: true,
          result: updates.map((u) => ({
            update_id: u.update_id,
            ...(JSON.parse(u.payload_json) as Record<string, unknown>),
          })),
        });
        return;
      }

      case 'setMyCommands': {
        if (Array.isArray(body.commands)) {
          bot.commands = body.commands as BotRegistryEntry['commands'];
          db.prepare(`UPDATE bots_registry SET bot_json = ? WHERE bot_user_id = ?`).run(
            JSON.stringify(bot),
            bot.bot_user_id,
          );
        }
        sendJson(ctx.res, 200, { ok: true, result: true });
        return;
      }

      default:
        sendJson(ctx.res, 200, { ok: true, result: true });
    }
  };
  router.get('/bot:botToken/:method', handleBotHttpApi);
  router.post('/bot:botToken/:method', handleBotHttpApi);
  router.get('/bot/:botToken/:method', handleBotHttpApi);
  router.post('/bot/:botToken/:method', handleBotHttpApi);

  // Inline Keyboard Callback Query Endpoint (`POST /api/v1/chats/:chatId/messages/:messageId/callback` & `/api/v1/bots/callback`)
  const handleInlineCallbackQuery = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      chat_id?: number;
      message_id?: number;
      callback_data?: string;
      data?: string;
    }>(ctx.req);

    const chatId = Number(ctx.params.chatId ?? body.chat_id ?? 0);
    const messageId = Number(ctx.params.messageId ?? body.message_id ?? 0);
    const cbData = (body.callback_data ?? body.data ?? '').trim();
    if (!chatId || !cbData) {
      throw new ApiError(400, 'invalid_callback', 'chat_id and callback_data are required');
    }

    const callbackQueryId = `cbq_${crypto.randomBytes(6).toString('hex')}`;
    const bfMap: Record<string, string> = {
      'bf:newbot': '/newbot',
      'bf:mybots': '/mybots',
      'bf:newapp': '/newapp',
      'bf:deletebot': '/deletebot',
      'bf:setdescription': '/setdescription',
    };
    if (bfMap[cbData]) {
      handleBotConversationTurn(db, hub, chatId, auth.userId, bfMap[cbData]!);
    }

    sendJson(ctx.res, 200, {
      ok: true,
      callback_query_id: callbackQueryId,
      chat_id: chatId,
      message_id: messageId,
      data: cbData,
      answer_text: 'Callback processed',
    });
  };
  router.post('/api/v1/chats/:chatId/messages/:messageId/callback', handleInlineCallbackQuery);
  router.post('/api/v1/bots/callback', handleInlineCallbackQuery);

  // 3. Mini App Registry, Launch (`WebAppData` HMAC-SHA256 `initData`), Verify & CloudStorage
  router.get('/api/v1/miniapps', (ctx) => {
    const auth = requireAuth(db, ctx);
    const q = (ctx.query.get('q') ?? '').trim().toLowerCase();
    const category = (ctx.query.get('category') ?? '').trim().toLowerCase();

    const rows = db
      .prepare(`SELECT app_json FROM mini_apps ORDER BY created_at_ms ASC`)
      .all() as Array<{ app_json: string }>;
    const installedRows = db
      .prepare(`SELECT app_id, companion_chat_id FROM mini_app_installs WHERE user_id = ?`)
      .all(auth.userId) as Array<{ app_id: string; companion_chat_id: number | null }>;
    const installMap = new Map(installedRows.map((i) => [i.app_id, i.companion_chat_id]));

    let apps = rows.map((r) => {
      const a = JSON.parse(r.app_json) as MiniAppEntry;
      return {
        ...a,
        is_installed: installMap.has(a.app_id),
        companion_chat_id: installMap.get(a.app_id) ?? a.companion_chat_id,
      };
    });

    if (q) {
      apps = apps.filter(
        (a) =>
          a.title.toLowerCase().includes(q) ||
          a.short_name.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q),
      );
    }
    if (category && category !== 'all') {
      apps = apps.filter((a) => a.category.toLowerCase() === category);
    }

    sendJson(ctx.res, 200, { apps, miniapps: apps });
  });

  router.get('/api/v1/miniapps/installed', (ctx) => {
    const auth = requireAuth(db, ctx);
    const rows = db
      .prepare(
        `SELECT m.app_json, i.companion_chat_id
         FROM mini_app_installs i
         JOIN mini_apps m ON m.app_id = i.app_id
         WHERE i.user_id = ?`,
      )
      .all(auth.userId) as Array<{ app_json: string; companion_chat_id: number | null }>;

    const apps = rows.map((r) => ({
      ...(JSON.parse(r.app_json) as MiniAppEntry),
      is_installed: true,
      companion_chat_id: r.companion_chat_id ?? undefined,
    }));
    sendJson(ctx.res, 200, { apps });
  });

  router.post('/api/v1/miniapps', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      bot_username?: string;
      bot_user_id?: number;
      short_name?: string;
      title?: string;
      description?: string;
      category?: string;
      icon_emoji?: string;
      html_bundle?: string;
    }>(ctx.req);

    const botRow = (
      body.bot_user_id
        ? db.prepare(`SELECT bot_user_id, bot_json FROM bots_registry WHERE bot_user_id = ?`).get(body.bot_user_id)
        : db.prepare(`SELECT bot_user_id, bot_json FROM bots_registry WHERE owner_user_id = ? LIMIT 1`).get(auth.userId)
    ) as { bot_user_id: number; bot_json: string } | undefined;

    if (!botRow) throw new ApiError(404, 'bot_not_found', 'Target bot not found');
    const bot = JSON.parse(botRow.bot_json) as BotRegistryEntry;
    const shortName = (body.short_name ?? 'app').replace(/[^A-Za-z0-9_-]/g, '');
    const appId = `app_${crypto.randomBytes(6).toString('hex')}`;
    const now = Date.now();

    const app: MiniAppEntry = {
      app_id: appId,
      bot_user_id: bot.bot_user_id,
      bot_username: body.bot_username?.replace(/^@/, '') || bot.username,
      short_name: shortName,
      title: body.title?.trim() || `${bot.display_name} App`,
      description: body.description ?? '',
      category: body.category ?? 'utilities',
      icon_emoji: body.icon_emoji ?? '🧩',
      web_url: `/miniapps/${bot.username}/${shortName}`,
      is_installed: true,
      install_count: 1,
      created_at_ms: now,
    };

    db.prepare(`
      INSERT OR REPLACE INTO mini_apps (app_id, bot_user_id, bot_username, short_name, app_json, html_bundle, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(appId, app.bot_user_id, app.bot_username, app.short_name, JSON.stringify(app), body.html_bundle ?? null, now);

    sendJson(ctx.res, 201, app);
  });

  function resolveMiniAppRow(paramA: string, paramB?: string): {
    app: MiniAppEntry;
    botToken: string;
    htmlBundle: string | null;
  } {
    const cleanA = paramA.replace(/^@/, '');
    const numericBotId = /^\d+$/.test(cleanA) ? Number(cleanA) : -1;
    const row = (
      paramB
        ? db
            .prepare(
              `SELECT m.app_json, m.html_bundle, b.bot_token
               FROM mini_apps m
               JOIN bots_registry b ON b.bot_user_id = m.bot_user_id
               WHERE (LOWER(m.bot_username) = LOWER(?) OR m.bot_user_id = ?) AND LOWER(m.short_name) = LOWER(?)`,
            )
            .get(cleanA, numericBotId, paramB)
        : db
            .prepare(
              `SELECT m.app_json, m.html_bundle, b.bot_token
               FROM mini_apps m
               JOIN bots_registry b ON b.bot_user_id = m.bot_user_id
               WHERE m.app_id = ? OR LOWER(m.short_name) = LOWER(?) OR LOWER(m.bot_username) = LOWER(?) OR m.bot_user_id = ?
               ORDER BY m.created_at_ms ASC LIMIT 1`,
            )
            .get(paramA, cleanA, cleanA, numericBotId)
    ) as { app_json: string; html_bundle: string | null; bot_token: string } | undefined;

    if (!row) {
      throw new ApiError(404, 'miniapp_not_found', 'Mini App not found');
    }
    return {
      app: JSON.parse(row.app_json) as MiniAppEntry,
      botToken: row.bot_token,
      htmlBundle: row.html_bundle,
    };
  }

  const handleLaunchMiniApp = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const body = ctx.method === 'POST' ? await readJsonBody<{ chat_id?: number; start_param?: string }>(ctx.req) : {};
    const resolved = ctx.params.botUsername
      ? resolveMiniAppRow(ctx.params.botUsername, ctx.params.shortName)
      : resolveMiniAppRow(ctx.params.appId!);

    const user = getUserProfileDto(db, auth.userId)!;
    const companionChatId =
      body.chat_id ?? ensureCompanionDmChat(db, auth.userId, resolved.app.bot_user_id);

    db.prepare(`
      INSERT OR REPLACE INTO mini_app_installs (user_id, app_id, companion_chat_id, installed_at_ms)
      VALUES (?, ?, ?, ?)
    `).run(auth.userId, resolved.app.app_id, companionChatId, Date.now());

    const authDate = Math.floor(Date.now() / 1000);
    const queryId = `AA${crypto.randomBytes(8).toString('hex')}`;
    const userPayload = JSON.stringify({
      id: user.user_id,
      first_name: user.first_name,
      last_name: user.last_name ?? '',
      username: user.username ?? '',
      language_code: 'zh-hans',
      is_premium: user.is_premium,
    });

    const signed = signMiniAppInitData(resolved.botToken, {
      auth_date: String(authDate),
      query_id: queryId,
      start_param: body.start_param ?? 'web_launch',
      user: userPayload,
    });

    const launchUrl = `${resolved.app.web_url}#tgWebAppData=${encodeURIComponent(signed.initData)}&tgWebAppVersion=8.0&tgWebAppPlatform=weba`;

    const cloudRows = db
      .prepare(`SELECT item_key, item_value FROM mini_app_cloud_storage WHERE user_id = ? AND scope_key = ?`)
      .all(auth.userId, resolved.app.app_id) as Array<{ item_key: string; item_value: string }>;
    const stateObj: Record<string, unknown> = {};
    for (const r of cloudRows) {
      stateObj[r.item_key] = r.item_value;
    }

    const launchCtx: MiniAppLaunchContext = {
      app: { ...resolved.app, is_installed: true, companion_chat_id: companionChatId },
      launch_url: launchUrl,
      init_data: signed.initData,
      query_id: queryId,
      auth_date: authDate,
      companion_chat_id: companionChatId,
      state: stateObj,
      theme_params: NIGHT_THEME_PARAMS,
    };
    sendJson(ctx.res, 200, launchCtx);
  };
  router.post('/api/v1/miniapps/:botUsername/:shortName/launch', handleLaunchMiniApp);
  router.get('/api/v1/miniapps/:botUsername/:shortName/launch', handleLaunchMiniApp);
  router.post('/api/v1/miniapps/:appId/launch', handleLaunchMiniApp);

  const handleVerifyInitData = async (ctx: RequestContext): Promise<void> => {
    const body = await readJsonBody<{
      init_data?: string;
      bot_username?: string;
      short_name?: string;
      app_id?: string;
    }>(ctx.req);

    const headerInitData = ctx.req.headers['x-telegram-init-data'];
    const initData =
      body.init_data ?? (typeof headerInitData === 'string' ? headerInitData : '');
    let botToken: string | undefined;

    const botUsername = ctx.params.botUsername ?? body.bot_username;
    const shortName = ctx.params.shortName ?? body.short_name;
    const appId = ctx.params.appId ?? body.app_id;

    if (botUsername && shortName) {
      botToken = resolveMiniAppRow(botUsername, shortName).botToken;
    } else if (appId) {
      botToken = resolveMiniAppRow(appId).botToken;
    } else {
      // Try all registered bot tokens to see if init_data matches a valid bot
      const allBots = db.prepare(`SELECT bot_token FROM bots_registry`).all() as Array<{ bot_token: string }>;
      for (const b of allBots) {
        const check = verifyMiniAppInitData(b.bot_token, initData);
        if (check.valid) {
          sendJson(ctx.res, 200, { valid: true, user: check.user, params: check.params });
          return;
        }
      }
      sendJson(ctx.res, 401, { valid: false, error: 'invalid_init_data', message: 'HMAC-SHA256 verification failed' });
      return;
    }

    const verified = verifyMiniAppInitData(botToken, initData);
    if (!verified.valid) {
      sendJson(ctx.res, 401, { valid: false, error: 'invalid_init_data', message: 'HMAC-SHA256 verification failed' });
      return;
    }
    sendJson(ctx.res, 200, { valid: true, user: verified.user, params: verified.params });
  };
  router.post('/api/v1/miniapps/verify-init-data', handleVerifyInitData);
  router.post('/api/v1/miniapps/validate-init-data', handleVerifyInitData);
  router.post('/api/v1/miniapps/:botUsername/:shortName/validate-init-data', handleVerifyInitData);
  router.post('/api/v1/miniapps/:appId/validate-init-data', handleVerifyInitData);

  // Helper authenticating Mini App requests via EITHER Bearer token OR `X-Telegram-Init-Data` HMAC-SHA256!
  function resolveMiniAppCallerUserId(ctx: RequestContext, botToken: string): number {
    const initDataHeader = ctx.req.headers['x-telegram-init-data'];
    if (typeof initDataHeader === 'string' && initDataHeader.trim()) {
      const check = verifyMiniAppInitData(botToken, initDataHeader.trim());
      if (!check.valid || !check.user?.id) {
        throw new ApiError(401, 'invalid_init_data', 'Tampered or invalid X-Telegram-Init-Data HMAC');
      }
      return Number(check.user.id);
    }
    const auth = requireAuth(db, ctx);
    return auth.userId;
  }

  // CloudStorage CRUD (`1..128` key length, `<=4096` value length, max `1024` keys)
  const handleGetCloudStorage = (ctx: RequestContext): void => {
    const resolved = ctx.params.botUsername
      ? resolveMiniAppRow(ctx.params.botUsername, ctx.params.shortName)
      : resolveMiniAppRow(ctx.params.appId!);
    const userId = resolveMiniAppCallerUserId(ctx, resolved.botToken);
    const scopeKey = resolved.app.app_id;

    const filterKeys = ctx.query.get('keys')
      ? ctx.query.get('keys')!.split(',').map((k) => k.trim()).filter(Boolean)
      : null;

    const rows = db
      .prepare(`SELECT item_key, item_value FROM mini_app_cloud_storage WHERE user_id = ? AND scope_key = ?`)
      .all(userId, scopeKey) as Array<{ item_key: string; item_value: string }>;

    const items: Record<string, string> = {};
    const keys: string[] = [];
    for (const r of rows) {
      keys.push(r.item_key);
      if (!filterKeys || filterKeys.includes(r.item_key)) {
        items[r.item_key] = r.item_value;
      }
    }
    sendJson(ctx.res, 200, { ok: true, items, values: items, keys });
  };
  router.get('/api/v1/miniapps/:botUsername/:shortName/cloud-storage', handleGetCloudStorage);
  router.get('/api/v1/miniapps/:botUsername/:shortName/storage', handleGetCloudStorage);
  router.get('/api/v1/miniapps/:appId/state', handleGetCloudStorage);
  router.get('/api/v1/miniapps/:appId/storage', handleGetCloudStorage);

  const handleSetCloudStorage = async (ctx: RequestContext): Promise<void> => {
    const resolved = ctx.params.botUsername
      ? resolveMiniAppRow(ctx.params.botUsername, ctx.params.shortName)
      : resolveMiniAppRow(ctx.params.appId!);
    const userId = resolveMiniAppCallerUserId(ctx, resolved.botToken);
    const scopeKey = resolved.app.app_id;

    const body = await readJsonBody<{
      key?: string;
      value?: string;
      items?: Record<string, string>;
    }>(ctx.req);

    const entries: Array<[string, string]> = body.items
      ? Object.entries(body.items)
      : body.key !== undefined
        ? [[body.key, String(body.value ?? '')]]
        : [];

    const countRow = db
      .prepare(`SELECT COUNT(*) AS cnt FROM mini_app_cloud_storage WHERE user_id = ? AND scope_key = ?`)
      .get(userId, scopeKey) as { cnt: number };

    if (Number(countRow.cnt) + entries.length > 1024) {
      throw new ApiError(400, 'cloud_storage_quota_exceeded', 'CloudStorage exceeds 1024 keys');
    }

    const now = Date.now();
    for (const [k, v] of entries) {
      if (k.length < 1 || k.length > 128) {
        throw new ApiError(400, 'invalid_storage_key', 'CloudStorage key must be 1..128 chars');
      }
      if (v.length > 4096) {
        throw new ApiError(400, 'invalid_storage_value', 'CloudStorage value must be <= 4096 chars');
      }
      db.prepare(`
        INSERT OR REPLACE INTO mini_app_cloud_storage (user_id, scope_key, item_key, item_value, updated_at_ms)
        VALUES (?, ?, ?, ?, ?)
      `).run(userId, scopeKey, k, v, now);
    }

    sendJson(ctx.res, 200, { ok: true, updated: entries.length });
  };
  router.put('/api/v1/miniapps/:botUsername/:shortName/cloud-storage', handleSetCloudStorage);
  router.post('/api/v1/miniapps/:botUsername/:shortName/cloud-storage', handleSetCloudStorage);
  router.put('/api/v1/miniapps/:botUsername/:shortName/storage', handleSetCloudStorage);
  router.post('/api/v1/miniapps/:botUsername/:shortName/storage', handleSetCloudStorage);
  router.put('/api/v1/miniapps/:appId/state', handleSetCloudStorage);
  router.post('/api/v1/miniapps/:appId/state', handleSetCloudStorage);
  router.put('/api/v1/miniapps/:appId/storage', handleSetCloudStorage);
  router.post('/api/v1/miniapps/:appId/storage', handleSetCloudStorage);

  const handleDeleteCloudStorage = async (ctx: RequestContext): Promise<void> => {
    const resolved = ctx.params.botUsername
      ? resolveMiniAppRow(ctx.params.botUsername, ctx.params.shortName)
      : resolveMiniAppRow(ctx.params.appId!);
    const userId = resolveMiniAppCallerUserId(ctx, resolved.botToken);
    const scopeKey = resolved.app.app_id;

    const queryKeys = ctx.query.get('keys')
      ? ctx.query.get('keys')!.split(',').map((k) => k.trim()).filter(Boolean)
      : [];
    const body = await readJsonBody<{ keys?: string[]; key?: string }>(ctx.req);
    const keys = [...queryKeys, ...(body.keys ?? []), ...(body.key ? [body.key] : [])];

    for (const k of keys) {
      db.prepare(
        `DELETE FROM mini_app_cloud_storage WHERE user_id = ? AND scope_key = ? AND item_key = ?`,
      ).run(userId, scopeKey, k);
    }
    sendJson(ctx.res, 200, { ok: true, deleted: keys.length });
  };
  router.delete('/api/v1/miniapps/:botUsername/:shortName/cloud-storage', handleDeleteCloudStorage);
  router.delete('/api/v1/miniapps/:botUsername/:shortName/storage', handleDeleteCloudStorage);
  router.delete('/api/v1/miniapps/:appId/state', handleDeleteCloudStorage);
  router.delete('/api/v1/miniapps/:appId/storage', handleDeleteCloudStorage);

  // Mini App `WebApp.sendData` / Event Relay -> Companion Bot Chat!
  const handleMiniAppSendData = async (ctx: RequestContext): Promise<void> => {
    const resolved = ctx.params.botUsername
      ? resolveMiniAppRow(ctx.params.botUsername, ctx.params.shortName)
      : resolveMiniAppRow(ctx.params.appId!);
    const userId = resolveMiniAppCallerUserId(ctx, resolved.botToken);
    const body = await readJsonBody<{ data?: unknown; event_type?: string; chat_id?: number }>(ctx.req);

    const payloadStr =
      typeof body.data === 'string' ? body.data : JSON.stringify(body.data ?? {});
    const companionChatId =
      body.chat_id ?? ensureCompanionDmChat(db, userId, resolved.app.bot_user_id);

    const userMsg = createMessageAtomic(db, hub, {
      chatId: companionChatId,
      senderId: userId,
      text: `🧩 [${resolved.app.title}] WebApp Data: ${payloadStr}`,
    });

    const botReply = createMessageAtomic(db, hub, {
      chatId: companionChatId,
      senderId: resolved.app.bot_user_id,
      text: `✅ **${resolved.app.title}** synchronized WebApp action.\n[STATE_PATCH]{"ack":true,"echo":${JSON.stringify(payloadStr.slice(0, 120))}}[/STATE_PATCH]`,
    });

    hub.sendToUser(userId, {
      type: 'Update',
      payload: {
        type: 'MiniAppStatePatch',
        data: {
          app_id: resolved.app.app_id,
          chat_id: companionChatId,
          patch: { ack: true, last_event_ts: Date.now() },
        },
      },
    });

    sendJson(ctx.res, 200, {
      ok: true,
      chat_id: companionChatId,
      service_message_id: userMsg.message.id,
      bot_reply_message_id: botReply.message.id,
    });
  };
  router.post('/api/v1/miniapps/:appId/send-data', handleMiniAppSendData);
  router.post('/api/v1/miniapps/:appId/event', handleMiniAppSendData);
  router.post('/api/v1/miniapps/:botUsername/:shortName/send-data', handleMiniAppSendData);

  // 4. `全球法布施` (`fabushi-globe`) Stateful REST Endpoints (resolving X-Telegram-Init-Data OR Bearer token)
  const resolveFabushiUserId = (ctx: RequestContext): number => {
    const initHeader = ctx.req.headers['x-telegram-init-data'];
    if (typeof initHeader === 'string' && initHeader.trim()) {
      const fabushiBot = db
        .prepare(`SELECT bot_token FROM bots_registry WHERE bot_user_id = 777002`)
        .get() as { bot_token: string } | undefined;
      if (fabushiBot) {
        const check = verifyMiniAppInitData(fabushiBot.bot_token, initHeader.trim());
        if (!check.valid || !check.user?.id) {
          throw new ApiError(401, 'invalid_init_data', 'Tampered or invalid X-Telegram-Init-Data HMAC');
        }
        return Number(check.user.id);
      }
    }
    const bearer = extractBearerToken(ctx.req, ctx.query);
    const session = authenticateToken(db, bearer);
    return session?.userId ?? 1001;
  };

  router.get('/api/v1/fabushi/state', (ctx) => {
    const userId = resolveFabushiUserId(ctx);
    sendJson(ctx.res, 200, getFabushiState(db, userId));
  });

  router.post('/api/v1/fabushi/beam', async (ctx) => {
    const userId = resolveFabushiUserId(ctx);
    const body = await readJsonBody<{ from_city?: string; to_city?: string; sutra?: string }>(ctx.req);

    const state = getFabushiState(db, userId);
    state.merit_total += 9;
    state.beams.unshift({
      id: `beam_${crypto.randomBytes(4).toString('hex')}`,
      from_city: body.from_city ?? 'Shanghai',
      to_city: body.to_city ?? 'Zurich',
      sutra: body.sutra ?? '般若波罗蜜多心经',
      created_at_ms: Date.now(),
    });
    state.beams = state.beams.slice(0, 25);
    saveFabushiState(db, userId, state);
    sendJson(ctx.res, 201, state);
  });

  router.post('/api/v1/fabushi/zen/muyu', async (ctx) => {
    const userId = resolveFabushiUserId(ctx);
    const body = await readJsonBody<{ count?: number }>(ctx.req);
    const delta = Math.max(1, Math.min(108, Number(body.count ?? 1)));
    const state = getFabushiState(db, userId);
    state.wooden_fish_taps += delta;
    state.merit_total += delta;
    saveFabushiState(db, userId, state);
    sendJson(ctx.res, 200, state);
  });

  router.post('/api/v1/fabushi/zen/incense', async (ctx) => {
    const userId = resolveFabushiUserId(ctx);
    await readJsonBody(ctx.req);
    const state = getFabushiState(db, userId);
    state.incense_lit = true;
    state.merit_total += 3;
    saveFabushiState(db, userId, state);
    sendJson(ctx.res, 200, state);
  });

  router.post('/api/v1/fabushi/zen/dedicate', async (ctx) => {
    const userId = resolveFabushiUserId(ctx);
    const body = await readJsonBody<{ text?: string }>(ctx.req);
    const state = getFabushiState(db, userId);
    const dedicationText = (body.text ?? '愿以此功德，庄严佛净土').trim();
    state.dedications.unshift({ text: dedicationText, created_at_ms: Date.now() });
    state.merit_total += 18;
    saveFabushiState(db, userId, state);

    const companionChatId = ensureCompanionDmChat(db, userId, 777002);
    createMessageAtomic(db, hub, {
      chatId: companionChatId,
      senderId: 777002,
      text: `🪷 功德回向圆满：「${dedicationText}」· 当前总功德 **${state.merit_total}**`,
    });

    sendJson(ctx.res, 200, state);
  });

  // 5. Official `window.Telegram.WebApp` v8.0 JavaScript Bridge (`/js/telegram-web-app.js`)
  router.get('/js/telegram-web-app.js', (ctx) => {
    const sdkJs = `(function () {
  var hashParams = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
  var initData = hashParams.get('tgWebAppData') || '';
  var parsedInit = new URLSearchParams(initData);
  var userObj = null;
  try { userObj = parsedInit.get('user') ? JSON.parse(parsedInit.get('user')) : null; } catch (_) {}

  var listeners = {};
  function emit(eventType, payload) {
    var list = listeners[eventType] || [];
    for (var i = 0; i < list.length; i++) {
      try { list[i](payload); } catch (_) {}
    }
  }

  function postHost(eventType, eventData) {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(JSON.stringify({ eventType: eventType, eventData: eventData || {} }), '*');
      }
    } catch (_) {}
  }

  window.addEventListener('message', function (ev) {
    try {
      var msg = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
      if (!msg || !msg.eventType) return;
      if (msg.eventType === 'main_button_pressed') {
        emit('mainButtonClicked');
      } else if (msg.eventType === 'back_button_pressed') {
        emit('backButtonClicked');
      } else if (msg.eventType === 'theme_changed' && msg.eventData) {
        Object.assign(WebApp.themeParams, msg.eventData.theme_params || {});
        emit('themeChanged', msg.eventData);
      } else {
        emit(msg.eventType, msg.eventData);
      }
    } catch (_) {}
  });

  var pathParts = window.location.pathname.split('/').filter(Boolean);
  var botUsername = pathParts[1] || 'FabushiBot';
  var shortName = pathParts[2] || 'fabushi-globe';
  var storageUrl = '/api/v1/miniapps/' + encodeURIComponent(botUsername) + '/' + encodeURIComponent(shortName) + '/cloud-storage';
  var sendDataUrl = '/api/v1/miniapps/' + encodeURIComponent(botUsername) + '/' + encodeURIComponent(shortName) + '/send-data';

  var mainBtnCallbacks = [];
  var backBtnCallbacks = [];

  var MainButton = {
    text: 'CONTINUE',
    color: '#3390EC',
    textColor: '#FFFFFF',
    isVisible: false,
    isActive: true,
    isProgressVisible: false,
    setText: function (t) { this.text = String(t); postHost('web_app_setup_main_button', { text: this.text, is_visible: this.isVisible, is_active: this.isActive, color: this.color, text_color: this.textColor }); return this; },
    show: function () { this.isVisible = true; postHost('web_app_setup_main_button', { text: this.text, is_visible: true, is_active: this.isActive, color: this.color, text_color: this.textColor }); return this; },
    hide: function () { this.isVisible = false; postHost('web_app_setup_main_button', { text: this.text, is_visible: false, is_active: this.isActive }); return this; },
    enable: function () { this.isActive = true; return this; },
    disable: function () { this.isActive = false; return this; },
    showProgress: function () { this.isProgressVisible = true; return this; },
    hideProgress: function () { this.isProgressVisible = false; return this; },
    setParams: function (p) { if (p.text) this.text = p.text; if (p.color) this.color = p.color; if (p.is_visible !== undefined) this.isVisible = Boolean(p.is_visible); postHost('web_app_setup_main_button', { text: this.text, is_visible: this.isVisible, is_active: this.isActive, color: this.color, text_color: this.textColor }); return this; },
    onClick: function (cb) { mainBtnCallbacks.push(cb); WebApp.onEvent('mainButtonClicked', cb); return this; },
    offClick: function (cb) { WebApp.offEvent('mainButtonClicked', cb); return this; }
  };

  var BackButton = {
    isVisible: false,
    show: function () { this.isVisible = true; postHost('web_app_setup_back_button', { is_visible: true }); return this; },
    hide: function () { this.isVisible = false; postHost('web_app_setup_back_button', { is_visible: false }); return this; },
    onClick: function (cb) { backBtnCallbacks.push(cb); WebApp.onEvent('backButtonClicked', cb); return this; },
    offClick: function (cb) { WebApp.offEvent('backButtonClicked', cb); return this; }
  };

  var CloudStorage = {
    setItem: function (key, value, cb) {
      fetch(storageUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': initData },
        body: JSON.stringify({ key: key, value: String(value) })
      }).then(function (r) { return r.ok ? (cb && cb(null, true)) : (cb && cb('storage_error', false)); })
        .catch(function (e) { if (cb) cb(String(e), false); });
    },
    getItem: function (key, cb) {
      fetch(storageUrl + '?keys=' + encodeURIComponent(key), {
        headers: { 'X-Telegram-Init-Data': initData }
      }).then(function (r) { return r.json(); })
        .then(function (d) { if (cb) cb(null, (d.items && d.items[key]) || ''); })
        .catch(function (e) { if (cb) cb(String(e), ''); });
    },
    getItems: function (keys, cb) {
      fetch(storageUrl + '?keys=' + encodeURIComponent(keys.join(',')), {
        headers: { 'X-Telegram-Init-Data': initData }
      }).then(function (r) { return r.json(); })
        .then(function (d) { if (cb) cb(null, d.items || {}); })
        .catch(function (e) { if (cb) cb(String(e), {}); });
    },
    removeItem: function (key, cb) {
      fetch(storageUrl + '?keys=' + encodeURIComponent(key), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': initData },
        body: JSON.stringify({ keys: [key] })
      }).then(function () { if (cb) cb(null, true); })
        .catch(function (e) { if (cb) cb(String(e), false); });
    },
    removeItems: function (keys, cb) {
      fetch(storageUrl, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': initData },
        body: JSON.stringify({ keys: keys })
      }).then(function () { if (cb) cb(null, true); })
        .catch(function (e) { if (cb) cb(String(e), false); });
    },
    getKeys: function (cb) {
      fetch(storageUrl, { headers: { 'X-Telegram-Init-Data': initData } })
        .then(function (r) { return r.json(); })
        .then(function (d) { if (cb) cb(null, d.keys || []); })
        .catch(function (e) { if (cb) cb(String(e), []); });
    }
  };

  var WebApp = {
    initData: initData,
    initDataUnsafe: {
      query_id: parsedInit.get('query_id') || '',
      user: userObj,
      auth_date: Number(parsedInit.get('auth_date') || 0),
      hash: parsedInit.get('hash') || ''
    },
    version: '8.0',
    platform: 'weba',
    colorScheme: 'dark',
    themeParams: ${JSON.stringify(NIGHT_THEME_PARAMS)},
    isExpanded: true,
    viewportHeight: window.innerHeight || 640,
    viewportStableHeight: window.innerHeight || 640,
    MainButton: MainButton,
    BottomButton: MainButton,
    BackButton: BackButton,
    HapticFeedback: {
      impactOccurred: function (style) { postHost('web_app_trigger_haptic_feedback', { type: 'impact', impact_style: style }); },
      notificationOccurred: function (type) { postHost('web_app_trigger_haptic_feedback', { type: 'notification', notification_type: type }); },
      selectionChanged: function () { postHost('web_app_trigger_haptic_feedback', { type: 'selection_change' }); }
    },
    CloudStorage: CloudStorage,
    ready: function () { postHost('web_app_ready', {}); },
    expand: function () { this.isExpanded = true; postHost('web_app_expand', {}); },
    close: function () { postHost('web_app_close', {}); },
    sendData: function (dataStr) {
      var str = typeof dataStr === 'string' ? dataStr : JSON.stringify(dataStr);
      postHost('web_app_data_send', { data: str });
      return fetch(sendDataUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': initData },
        body: JSON.stringify({ data: str })
      });
    },
    onEvent: function (eventType, cb) {
      listeners[eventType] = listeners[eventType] || [];
      listeners[eventType].push(cb);
    },
    offEvent: function (eventType, cb) {
      listeners[eventType] = (listeners[eventType] || []).filter(function (fn) { return fn !== cb; });
    }
  };

  window.Telegram = window.Telegram || {};
  window.Telegram.WebApp = WebApp;
})();`;

    ctx.res.statusCode = 200;
    ctx.res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    ctx.res.setHeader('Cache-Control', 'no-cache');
    ctx.res.end(sdkJs);
  });

  // 6. Hosted Mini App Bundles (`/miniapps/:botUsername/:shortName`)
  router.get('/miniapps/:botUsername/:shortName', (ctx) => {
    const resolved = resolveMiniAppRow(ctx.params.botUsername!, ctx.params.shortName!);
    if (resolved.htmlBundle) {
      ctx.res.statusCode = 200;
      ctx.res.setHeader('Content-Type', 'text/html; charset=utf-8');
      ctx.res.end(resolved.htmlBundle);
      return;
    }

    const shortLower = resolved.app.short_name.toLowerCase();
    const html =
      shortLower.includes('fabushi')
        ? renderFabushiGlobeMiniAppHtml(resolved.app)
        : renderTaskBoardMiniAppHtml(resolved.app);

    ctx.res.statusCode = 200;
    ctx.res.setHeader('Content-Type', 'text/html; charset=utf-8');
    ctx.res.end(html);
  });
}

function renderFabushiGlobeMiniAppHtml(app: MiniAppEntry): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(app.title)}</title>
  <script src="/js/telegram-web-app.js"></script>
  <style>
    body { margin: 0; padding: 16px; background: #0E1621; color: #F5F5F5; font-family: -apple-system, BlinkMacSystemFont, "Noto Sans SC", sans-serif; }
    header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    h1 { font-size: 18px; margin: 0; color: #F5F5F5; }
    .badge { padding: 4px 10px; border-radius: 999px; background: #182533; border: 1px solid #2B5278; font-size: 12px; color: #64B5F6; }
    #globe-canvas { width: 100%; height: 220px; border-radius: 12px; background: #17212B; border: 1px solid #242F3D; display: block; margin-bottom: 12px; }
    .controls { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 12px; }
    button { padding: 10px 12px; border-radius: 10px; border: 1px solid #2B5278; background: #182533; color: #F5F5F5; font-size: 13px; cursor: pointer; font-weight: 500; }
    button:hover { background: #2B5278; }
    .panel { background: #17212B; border: 1px solid #242F3D; border-radius: 10px; padding: 12px; font-size: 13px; line-height: 1.5; }
  </style>
</head>
<body>
  <header>
    <h1>🌏 全球法布施 · 3D WASM 禅室</h1>
    <span class="badge" id="merit-badge">功德: 108 · WASM Ready</span>
  </header>
  <canvas id="globe-canvas" width="520" height="220"></canvas>
  <div class="controls">
    <button id="btn-muyu" type="button">🪵 敲击木鱼 (+1)</button>
    <button id="btn-beam" type="button">✨ 发射法布施光束</button>
    <button id="btn-dedicate" type="button">🪷 功德回向</button>
  </div>
  <section class="panel" id="sutra-panel">
    <strong>《般若波罗蜜多心经》</strong>：观自在菩萨，行深般若波罗蜜多时，照见五蕴皆空，度一切苦厄。
  </section>
  <script>
    (function () {
      var tg = window.Telegram && window.Telegram.WebApp;
      if (tg) {
        tg.ready();
        tg.expand();
        tg.MainButton.setText('回向并同步至聊天').show().onClick(function () {
          tg.sendData({ action: 'dedicate_merit', merit: meritTotal });
        });
      }

      var meritTotal = 108;
      var wasmMeritStep = function (a, b) { return a + b; };
      var b64 = "${FABUSHI_WASM_BASE64}";
      var bin = Uint8Array.from(atob(b64), function (c) { return c.charCodeAt(0); });
      WebAssembly.instantiate(bin).then(function (res) {
        if (res.instance && res.instance.exports && res.instance.exports.meritStep) {
          wasmMeritStep = res.instance.exports.meritStep;
        }
      }).catch(function () {});

      function updateBadge() {
        document.getElementById('merit-badge').textContent = '功德: ' + meritTotal + ' · WASM Active';
      }

      var authHdrs = { 'Content-Type': 'application/json' };
      if (tg && tg.initData) {
        authHdrs['X-Telegram-Init-Data'] = tg.initData;
      }

      document.getElementById('btn-muyu').addEventListener('click', function () {
        meritTotal = wasmMeritStep(meritTotal, 1);
        updateBadge();
        fetch('/api/v1/fabushi/zen/muyu', { method: 'POST', headers: authHdrs, body: '{"count":1}' });
      });

      document.getElementById('btn-beam').addEventListener('click', function () {
        meritTotal = wasmMeritStep(meritTotal, 9);
        updateBadge();
        fetch('/api/v1/fabushi/beam', { method: 'POST', headers: authHdrs, body: '{"from_city":"Hangzhou","to_city":"London"}' });
      });

      document.getElementById('btn-dedicate').addEventListener('click', function () {
        meritTotal = wasmMeritStep(meritTotal, 18);
        updateBadge();
        if (tg) tg.sendData({ action: 'dedicate', merit: meritTotal });
      });

      var canvas = document.getElementById('globe-canvas');
      var ctx = canvas.getContext('2d');
      var angle = 0;
      function renderGlobe() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        var cx = canvas.width / 2, cy = canvas.height / 2, r = 82;
        ctx.strokeStyle = '#3390EC';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
        for (var i = -2; i <= 2; i++) {
          ctx.beginPath();
          ctx.ellipse(cx, cy, Math.abs(Math.cos(angle + i * 0.5)) * r, r, 0, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(51, 144, 236, 0.35)';
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.moveTo(cx - 42, cy - 18);
        ctx.quadraticCurveTo(cx, cy - 92, cx + 48, cy + 12);
        ctx.strokeStyle = '#FFB300';
        ctx.lineWidth = 2;
        ctx.stroke();
        angle += 0.012;
        requestAnimationFrame(renderGlobe);
      }
      renderGlobe();
    })();
  </script>
</body>
</html>`;
}

function renderTaskBoardMiniAppHtml(app: MiniAppEntry): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(app.title)}</title>
  <script src="/js/telegram-web-app.js"></script>
  <style>
    body { margin: 0; padding: 16px; background: #0E1621; color: #F5F5F5; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
    h1 { font-size: 18px; margin: 0 0 12px; }
    .row { display: flex; gap: 8px; margin-bottom: 12px; }
    input { flex: 1; padding: 8px 12px; border-radius: 8px; border: 1px solid #242F3D; background: #17212B; color: #F5F5F5; }
    button { padding: 8px 14px; border-radius: 8px; border: none; background: #3390EC; color: #FFFFFF; cursor: pointer; font-weight: 500; }
    ul { list-style: none; padding: 0; margin: 0; }
    li { padding: 10px 12px; border-radius: 8px; background: #17212B; border: 1px solid #242F3D; margin-bottom: 8px; }
  </style>
</head>
<body>
  <h1>📋 ${escapeHtml(app.title)}</h1>
  <div class="row">
    <input id="task-input" placeholder="Add sprint task to CloudStorage…" />
    <button id="btn-add-task" type="button">Add</button>
  </div>
  <ul id="task-list"></ul>
  <script>
    (function () {
      var tg = window.Telegram && window.Telegram.WebApp;
      var tasks = ['Verify WebSocket PTS sync', 'Ship Mini App CloudStorage'];
      function render() {
        var ul = document.getElementById('task-list');
        ul.innerHTML = '';
        tasks.forEach(function (t) {
          var li = document.createElement('li');
          li.textContent = t;
          ul.appendChild(li);
        });
      }
      if (tg) {
        tg.ready();
        tg.expand();
        tg.CloudStorage.getItem('sprint_tasks', function (err, val) {
          if (!err && val) {
            try { tasks = JSON.parse(val); render(); } catch (_) {}
          }
        });
        tg.MainButton.setText('Sync Board to Chat').show().onClick(function () {
          tg.sendData({ action: 'sync_tasks', count: tasks.length, tasks: tasks });
        });
      }
      document.getElementById('btn-add-task').addEventListener('click', function () {
        var inp = document.getElementById('task-input');
        var v = inp.value.trim();
        if (!v) return;
        tasks.push(v);
        inp.value = '';
        render();
        if (tg) tg.CloudStorage.setItem('sprint_tasks', JSON.stringify(tasks));
      });
      render();
    })();
  </script>
</body>
</html>`;
}
