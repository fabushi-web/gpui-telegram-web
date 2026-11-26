import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  resolveGrokBotAvatar,
  type BotRegistryEntry,
  type MagpiePreset,
  type MiniAppEntry,
  type StickerSetDto,
  type UserPrivacySettingsDto,
} from '@gpui-telegram/protocol';

export const DEFAULT_PRIVACY_SETTINGS: UserPrivacySettingsDto = {
  phone_privacy: 'Contacts',
  last_seen_privacy: 'Everybody',
  photo_privacy: 'Everybody',
  calls_privacy: 'Everybody',
  forwards_privacy: 'Everybody',
  groups_privacy: 'Everybody',
  ttl_months: 6,
  global_ttl_seconds: 0,
  sensitive_content_enabled: false,
  passcode_enabled: false,
  notifications_private: true,
  notifications_groups: true,
  notifications_channels: true,
  notifications_sound: true,
  include_muted_in_badge: false,
  badge_count_messages: true,
  p2p_mode: 'Contacts',
  accept_calls: true,
  is_premium: false,
};

export const MAGPIE_BUILTIN_PRESETS: MagpiePreset[] = [
  // 28 Vendor presets
  { id: 'openai', name: 'OpenAI', category: 'vendor', api_mode: 'chat_completions', base_url: 'https://api.openai.com/v1', default_model: 'gpt-4o', models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'], no_key_required: false },
  { id: 'anthropic', name: 'Anthropic', category: 'vendor', api_mode: 'anthropic_messages', base_url: 'https://api.anthropic.com/v1', default_model: 'claude-3-7-sonnet-latest', models: ['claude-3-7-sonnet-latest', 'claude-3-5-haiku-latest'], no_key_required: false },
  { id: 'google', name: 'Google Gemini', category: 'vendor', api_mode: 'gemini_generate_content', base_url: 'https://generativelanguage.googleapis.com/v1beta', default_model: 'gemini-2.5-pro', models: ['gemini-2.5-pro', 'gemini-2.5-flash'], no_key_required: false },
  { id: 'google-vertex', name: 'Google Vertex AI', category: 'vendor', api_mode: 'gemini_generate_content', base_url: 'https://aiplatform.googleapis.com/v1', default_model: 'gemini-2.5-pro', models: ['gemini-2.5-pro'], no_key_required: false },
  { id: 'deepseek', name: 'DeepSeek', category: 'vendor', api_mode: 'chat_completions', base_url: 'https://api.deepseek.com/v1', default_model: 'deepseek-chat', models: ['deepseek-chat', 'deepseek-reasoner'], no_key_required: false },
  { id: 'moonshot', name: 'Moonshot Kimi (Global)', category: 'vendor', api_mode: 'chat_completions', base_url: 'https://api.moonshot.ai/v1', default_model: 'kimi-k2', models: ['kimi-k2', 'moonshot-v1-128k'], no_key_required: false },
  { id: 'moonshot-cn', name: 'Moonshot Kimi (CN)', category: 'vendor', api_mode: 'chat_completions', base_url: 'https://api.moonshot.cn/v1', default_model: 'kimi-k2', models: ['kimi-k2'], no_key_required: false },
  { id: 'kimi-code', name: 'Kimi Code', category: 'vendor', api_mode: 'chat_completions', base_url: 'https://api.moonshot.ai/v1', default_model: 'kimi-coding', models: ['kimi-coding'], no_key_required: false },
  { id: 'kimi-code-cn', name: 'Kimi Code (CN)', category: 'vendor', api_mode: 'chat_completions', base_url: 'https://api.moonshot.cn/v1', default_model: 'kimi-coding', models: ['kimi-coding'], no_key_required: false },
  { id: 'zhipu', name: 'Zhipu GLM', category: 'vendor', api_mode: 'chat_completions', base_url: 'https://open.bigmodel.cn/api/paas/v4', default_model: 'glm-4-plus', models: ['glm-4-plus', 'glm-4-flash'], no_key_required: false },
  { id: 'zai', name: 'Z.ai', category: 'vendor', api_mode: 'chat_completions', base_url: 'https://api.z.ai/v1', default_model: 'glm-4.5', models: ['glm-4.5'], no_key_required: false },
  { id: 'minimax', name: 'MiniMax (Global)', category: 'vendor', api_mode: 'chat_completions', base_url: 'https://api.minimaxi.chat/v1', default_model: 'MiniMax-Text-01', models: ['MiniMax-Text-01'], no_key_required: false },
  { id: 'minimax-cn', name: 'MiniMax (CN)', category: 'vendor', api_mode: 'chat_completions', base_url: 'https://api.minimax.chat/v1', default_model: 'MiniMax-Text-01', models: ['MiniMax-Text-01'], no_key_required: false },
  { id: 'stepfun', name: 'StepFun', category: 'vendor', api_mode: 'chat_completions', base_url: 'https://api.stepfun.ai/v1', default_model: 'step-2-16k', models: ['step-2-16k'], no_key_required: false },
  { id: 'stepfun-cn', name: 'StepFun (CN)', category: 'vendor', api_mode: 'chat_completions', base_url: 'https://api.stepfun.com/v1', default_model: 'step-2-16k', models: ['step-2-16k'], no_key_required: false },
  { id: 'xiaomi', name: 'Xiaomi MiMo', category: 'vendor', api_mode: 'chat_completions', base_url: 'https://api.xiaomimimo.com/v1', default_model: 'mimo-7b-rl', models: ['mimo-7b-rl'], no_key_required: false },
  { id: 'qwen', name: 'Qwen DashScope (Intl)', category: 'vendor', api_mode: 'chat_completions', base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', default_model: 'qwen-max', models: ['qwen-max', 'qwen-coder-plus'], no_key_required: false },
  { id: 'qwen-cn', name: 'Qwen DashScope (CN)', category: 'vendor', api_mode: 'chat_completions', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', default_model: 'qwen-max', models: ['qwen-max'], no_key_required: false },
  { id: 'qwen-token-plan', name: 'Qwen Token Plan', category: 'vendor', api_mode: 'chat_completions', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', default_model: 'qwen-plus', models: ['qwen-plus'], no_key_required: false },
  { id: 'bailian-token-plan', name: 'Alibaba Bailian Plan', category: 'vendor', api_mode: 'chat_completions', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', default_model: 'qwen-turbo', models: ['qwen-turbo'], no_key_required: false },
  { id: 'baidu-qianfan', name: 'Baidu Qianfan', category: 'vendor', api_mode: 'chat_completions', base_url: 'https://qianfan.baidubce.com/v2', default_model: 'ernie-4.5-8k', models: ['ernie-4.5-8k'], no_key_required: false },
  { id: 'tencent-cloud', name: 'Tencent Hunyuan', category: 'vendor', api_mode: 'chat_completions', base_url: 'https://api.hunyuan.cloud.tencent.com/v1', default_model: 'hunyuan-pro', models: ['hunyuan-pro'], no_key_required: false },
  { id: 'volcengine', name: 'Volcengine Doubao', category: 'vendor', api_mode: 'chat_completions', base_url: 'https://ark.cn-beijing.volces.com/api/v3', default_model: 'doubao-1.5-pro-32k', models: ['doubao-1.5-pro-32k'], no_key_required: false },
  { id: 'longcat', name: 'LongCat', category: 'vendor', api_mode: 'chat_completions', base_url: 'https://api.longcat.chat/v1', default_model: 'longcat-large', models: ['longcat-large'], no_key_required: false },
  { id: 'xai', name: 'xAI Grok', category: 'vendor', api_mode: 'chat_completions', base_url: 'https://api.x.ai/v1', default_model: 'grok-3', models: ['grok-3', 'grok-3-mini'], no_key_required: false },
  { id: 'mistral', name: 'Mistral AI', category: 'vendor', api_mode: 'chat_completions', base_url: 'https://api.mistral.ai/v1', default_model: 'mistral-large-latest', models: ['mistral-large-latest', 'codestral-latest'], no_key_required: false },
  { id: 'groq', name: 'Groq LPU', category: 'vendor', api_mode: 'chat_completions', base_url: 'https://api.groq.com/openai/v1', default_model: 'llama-3.3-70b-versatile', models: ['llama-3.3-70b-versatile'], no_key_required: false },
  { id: 'nous', name: 'Nous Research', category: 'vendor', api_mode: 'chat_completions', base_url: 'https://inference-api.nousresearch.com/v1', default_model: 'Hermes-3-Llama-3.1-70B', models: ['Hermes-3-Llama-3.1-70B'], no_key_required: false },

  // 13 Relay presets
  { id: 'openrouter', name: 'OpenRouter', category: 'relay', api_mode: 'chat_completions', base_url: 'https://openrouter.ai/api/v1', default_model: 'anthropic/claude-3.7-sonnet', models: ['anthropic/claude-3.7-sonnet', 'openai/gpt-4o'], no_key_required: false },
  { id: 'siliconflow', name: 'SiliconFlow', category: 'relay', api_mode: 'chat_completions', base_url: 'https://api.siliconflow.cn/v1', default_model: 'deepseek-ai/DeepSeek-V3', models: ['deepseek-ai/DeepSeek-V3'], no_key_required: false },
  { id: 'vercel', name: 'Vercel AI Gateway', category: 'relay', api_mode: 'chat_completions', base_url: 'https://ai-gateway.vercel.sh/v1', default_model: 'openai/gpt-4o', models: ['openai/gpt-4o'], no_key_required: false },
  { id: 'together', name: 'Together AI', category: 'relay', api_mode: 'chat_completions', base_url: 'https://api.together.xyz/v1', default_model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo'], no_key_required: false },
  { id: 'fireworks', name: 'Fireworks AI', category: 'relay', api_mode: 'chat_completions', base_url: 'https://api.fireworks.ai/inference/v1', default_model: 'accounts/fireworks/models/deepseek-v3', models: ['accounts/fireworks/models/deepseek-v3'], no_key_required: false },
  { id: 'fireworks-nexus', name: 'Fireworks Nexus', category: 'relay', api_mode: 'chat_completions', base_url: 'https://api.fireworks.ai/inference/v1', default_model: 'accounts/fireworks/models/llama-v3p3-70b-instruct', models: ['accounts/fireworks/models/llama-v3p3-70b-instruct'], no_key_required: false },
  { id: 'nvidia', name: 'NVIDIA NIM', category: 'relay', api_mode: 'chat_completions', base_url: 'https://integrate.api.nvidia.com/v1', default_model: 'meta/llama-3.3-70b-instruct', models: ['meta/llama-3.3-70b-instruct'], no_key_required: false },
  { id: 'modelscope', name: 'ModelScope', category: 'relay', api_mode: 'chat_completions', base_url: 'https://api-inference.modelscope.cn/v1', default_model: 'Qwen/Qwen2.5-72B-Instruct', models: ['Qwen/Qwen2.5-72B-Instruct'], no_key_required: false },
  { id: 'opencode-zen', name: 'OpenCode Zen', category: 'relay', api_mode: 'chat_completions', base_url: 'https://api.opencode.ai/v1', default_model: 'zen-coder-v1', models: ['zen-coder-v1'], no_key_required: false },
  { id: 'kilo', name: 'Kilo AI', category: 'relay', api_mode: 'chat_completions', base_url: 'https://api.kilocode.ai/v1', default_model: 'kilo-sonnet', models: ['kilo-sonnet'], no_key_required: false },
  { id: 'aihubmix', name: 'AiHubMix', category: 'relay', api_mode: 'chat_completions', base_url: 'https://aihubmix.com/v1', default_model: 'gpt-4o', models: ['gpt-4o'], no_key_required: false },
  { id: '302ai', name: '302.AI', category: 'relay', api_mode: 'chat_completions', base_url: 'https://api.302.ai/v1', default_model: 'gpt-4o', models: ['gpt-4o'], no_key_required: false },
  { id: 'aigocode', name: 'AiGoCode', category: 'relay', api_mode: 'chat_completions', base_url: 'https://api.aigocode.com/v1', default_model: 'claude-3-7-sonnet', models: ['claude-3-7-sonnet'], no_key_required: false },

  // 5 Local Zero-Subscription presets
  { id: 'ollama', name: 'Ollama (Local)', category: 'local', api_mode: 'chat_completions', base_url: 'http://127.0.0.1:11434/v1', default_model: 'qwen2.5-coder:14b', models: ['qwen2.5-coder:14b', 'llama3.2:latest'], no_key_required: true },
  { id: 'lmstudio', name: 'LM Studio (Local)', category: 'local', api_mode: 'chat_completions', base_url: 'http://127.0.0.1:1234/v1', default_model: 'local-model', models: ['local-model'], no_key_required: true },
  { id: 'omlx', name: 'oMLX (Apple Silicon)', category: 'local', api_mode: 'chat_completions', base_url: 'http://127.0.0.1:8080/v1', default_model: 'mlx-community/Qwen2.5-14B', models: ['mlx-community/Qwen2.5-14B'], no_key_required: true },
  { id: 'mlx-serve', name: 'MLX Serve', category: 'local', api_mode: 'chat_completions', base_url: 'http://127.0.0.1:8081/v1', default_model: 'mlx-default', models: ['mlx-default'], no_key_required: true },
  { id: 'gpustack', name: 'GPUStack Cluster', category: 'local', api_mode: 'chat_completions', base_url: 'http://127.0.0.1:8082/v1', default_model: 'qwen2.5-72b', models: ['qwen2.5-72b'], no_key_required: false },

  // 1 Remote Magpie (requires real configured upstream model, zero fake local models)
  { id: 'remote-magpie', name: 'Remote Magpie Gateway', category: 'remote', api_mode: 'chat_completions', base_url: 'http://127.0.0.1:4173/api/v1/magpie/v1', default_model: '', models: [], no_key_required: false },

  // 4 Custom protocol adapters
  { id: 'custom-openai', name: 'Custom OpenAI-Compatible', category: 'custom', api_mode: 'chat_completions', base_url: 'http://127.0.0.1:8000/v1', default_model: 'custom-gpt', models: ['custom-gpt'], no_key_required: false },
  { id: 'custom-anthropic', name: 'Custom Anthropic Messages', category: 'custom', api_mode: 'anthropic_messages', base_url: 'http://127.0.0.1:8000/v1', default_model: 'custom-claude', models: ['custom-claude'], no_key_required: false },
  { id: 'custom-gemini', name: 'Custom Gemini API', category: 'custom', api_mode: 'gemini_generate_content', base_url: 'http://127.0.0.1:8000/v1beta', default_model: 'custom-gemini', models: ['custom-gemini'], no_key_required: false },
  { id: 'custom-responses', name: 'Custom Codex Responses API', category: 'custom', api_mode: 'codex_responses', base_url: 'http://127.0.0.1:8000/v1', default_model: 'codex-mini', models: ['codex-mini'], no_key_required: false },
];

export function seedSystemEntitiesIfEmpty(
  db: DatabaseSync,
  options: { inTransaction?: boolean } = {},
): void {
  const now = Date.now();
  if (!options.inTransaction) {
    db.exec('BEGIN IMMEDIATE;');
  }
  try {
    // 1. Official platform system bots (zero fake human accounts, zero fake chats/messages)
    const insertSystemBotUser = db.prepare(`
      INSERT OR IGNORE INTO users (
        user_id, username, first_name, last_name, bio, phone, email,
        password_salt, password_hash, emoji_status, is_bot, is_verified, is_premium,
        status, last_seen_ms, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, 1, 1, 0, 'bot', ?, ?)
    `);
    insertSystemBotUser.run(
      777000,
      'HermesAgent',
      'Hermes AI',
      'Assistant',
      'Official Hermes 6-Tab AI Studio & Tool-Augmented Agent Runtime',
      '🤖',
      now,
      now,
    );
    insertSystemBotUser.run(
      777001,
      'BotFather',
      'BotFather',
      '',
      'BotFather is the one bot to rule them all. Use it to create new bot accounts and Mini Apps.',
      '☑️',
      now,
      now,
    );
    insertSystemBotUser.run(
      777002,
      'FabushiBot',
      '全球法布施',
      'Bot',
      '全球法布施 3D WASM Globe & Zen Room (木鱼 · 焚香 · 经典共修 · 功德回向)',
      '🪷',
      now,
      now,
    );

    const officialBots: Array<{ token: string; entry: BotRegistryEntry }> = [
      {
        token: '777001:AAOfficialBotFatherToken_v1',
        entry: {
          bot_user_id: 777001,
          owner_user_id: 0,
          username: 'BotFather',
          display_name: 'BotFather',
          description: 'Official Bot & Mini App Father',
          about: 'Create and manage bots & Telegram Mini Apps',
          commands: [
            { command: 'start', description: 'Show BotFather main menu' },
            { command: 'newbot', description: 'Create a new bot' },
            { command: 'mybots', description: 'List and manage your bots' },
            { command: 'newapp', description: 'Create a new Mini App' },
            { command: 'setdescription', description: 'Update bot description' },
            { command: 'deletebot', description: 'Delete a bot' },
            { command: 'cancel', description: 'Cancel current wizard operation' },
          ],
          is_official: true,
          is_inline: false,
          allow_attach_menu: false,
          menu_button_type: 'commands',
          has_main_app: false,
          created_at_ms: now,
        },
      },
      {
        token: '777000:AAOfficialHermesAgentToken_v1',
        entry: {
          bot_user_id: 777000,
          owner_user_id: 0,
          username: 'HermesAgent',
          display_name: 'Hermes AI',
          description: 'Official Hermes 6-Tab AI Studio & Agent Runtime',
          about: 'Streaming SSE reasoning, 61 slash commands, Memory, Skills & Kanban',
          ai_persona: 'You are Hermes AI, a precise, helpful full-stack engineering and research agent.',
          commands: [
            { command: 'help', description: 'List Hermes slash commands' },
            { command: 'status', description: 'Show Hermes engine status' },
            { command: 'branch', description: 'Fork session trajectory' },
            { command: 'memory', description: 'Inspect bounded MEMORY.md' },
            { command: 'skills', description: 'List installed skills' },
          ],
          is_official: true,
          is_inline: true,
          allow_attach_menu: true,
          menu_button_type: 'commands',
          has_main_app: false,
          approval_mode: 'ask',
          toolset_preset: 'hermes-telegram',
          is_fabushi_bot: true,
          agent_id: 'fabushi-ai-bot',
          avatar_shape: resolveGrokBotAvatar('fabushi-ai-bot').shape,
          avatar_color: resolveGrokBotAvatar('fabushi-ai-bot').color,
          created_at_ms: now,
        },
      },
      {
        token: '777002:AAOfficialFabushiBotToken_v1',
        entry: {
          bot_user_id: 777002,
          owner_user_id: 0,
          username: 'FabushiBot',
          display_name: '全球法布施',
          description: '全球法布施 WASM 3D Globe & Zen Room Mini App Bot',
          about: '实时全球法布施光束 · 禅室共修 · 经典阅读 · 功德回向',
          commands: [{ command: 'start', description: '打开全球法布施导航卡片' }],
          is_official: true,
          is_inline: true,
          allow_attach_menu: true,
          menu_button_type: 'web_app',
          menu_button_text: '全球法布施',
          menu_button_url: '/miniapps/FabushiBot/fabushi',
          has_main_app: true,
          main_app_short_name: 'fabushi',
          agent_id: 'fabushibot',
          avatar_shape: resolveGrokBotAvatar('fabushibot').shape,
          avatar_color: resolveGrokBotAvatar('fabushibot').color,
          created_at_ms: now,
        },
      },
    ];

    const insertBot = db.prepare(`
      INSERT OR IGNORE INTO bots_registry (bot_user_id, owner_user_id, bot_token, bot_json, created_at_ms)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const b of officialBots) {
      insertBot.run(b.entry.bot_user_id, b.entry.owner_user_id, b.token, JSON.stringify(b.entry), now);
    }

    // 2. Official built-in Fabushi Rust/WASM MiniApp catalog entries (truthful install_count: 0, is_installed: false)
    const officialMiniApps: MiniAppEntry[] = [
      {
        app_id: 'app_fabushi_alias',
        bot_user_id: 777002,
        bot_username: 'FabushiBot',
        short_name: 'fabushi',
        title: '全球法布施',
        description: '全球法布施 3D WASM 地球与禅室共修应用（Rust/WASM 核心）',
        category: 'lifestyle',
        icon_emoji: '🪷',
        web_url: '/miniapps/FabushiBot/fabushi',
        has_wasm: true,
        is_installed: false,
        install_count: 0,
        created_at_ms: now,
      },
      {
        app_id: 'app_fabushi_globe',
        bot_user_id: 777002,
        bot_username: 'FabushiBot',
        short_name: 'fabushi-globe',
        title: '全球法布施 3D Globe & 禅室',
        description: '全球法布施 3D WASM 地球、八大经典、禅室共修与真实排行榜',
        category: 'lifestyle',
        icon_emoji: '🌏',
        web_url: '/miniapps/FabushiBot/fabushi-globe',
        has_wasm: true,
        is_installed: false,
        install_count: 0,
        created_at_ms: now,
      },
    ];
    const insertMiniApp = db.prepare(`
      INSERT OR IGNORE INTO mini_apps (app_id, bot_user_id, bot_username, short_name, app_json, html_bundle, created_at_ms)
      VALUES (?, ?, ?, ?, ?, NULL, ?)
    `);
    for (const app of officialMiniApps) {
      insertMiniApp.run(app.app_id, app.bot_user_id, app.bot_username, app.short_name, JSON.stringify(app), now);
    }

    // 3. Built-in emoji sticker pack
    const stickerSet: StickerSetDto = {
      set_id: 'gpui_mascots',
      short_name: 'gpui_mascots',
      title: 'Official Emoji Stickers',
      count: 4,
      is_installed: true,
      stickers: [
        { id: 'stk_rocket', set_id: 'gpui_mascots', emoji: '🚀', mime_type: 'image/svg+xml', width: 160, height: 160, is_animated: false, is_video: false },
        { id: 'stk_fire', set_id: 'gpui_mascots', emoji: '🔥', mime_type: 'image/svg+xml', width: 160, height: 160, is_animated: false, is_video: false },
        { id: 'stk_lotus', set_id: 'gpui_mascots', emoji: '🪷', mime_type: 'image/svg+xml', width: 160, height: 160, is_animated: false, is_video: false },
        { id: 'stk_party', set_id: 'gpui_mascots', emoji: '🎉', mime_type: 'image/svg+xml', width: 160, height: 160, is_animated: false, is_video: false },
      ],
    };
    db.prepare(
      `INSERT OR IGNORE INTO sticker_sets (set_id, short_name, title, stickers_json, installed_by_default) VALUES (?, ?, ?, ?, 1)`,
    ).run(stickerSet.set_id, stickerSet.short_name, stickerSet.title, JSON.stringify(stickerSet.stickers));

    if (!options.inTransaction) {
      db.exec('COMMIT;');
    }
  } catch (err) {
    if (!options.inTransaction) {
      db.exec('ROLLBACK;');
    }
    throw err;
  }
}

export function seedDatabaseIfEmpty(db: DatabaseSync): void {
  seedSystemEntitiesIfEmpty(db);
}

/**
 * Cleanly wipes all SQLite tables and CAS media/upload blobs, then seeds ONLY
 * legitimate official system bot definitions (zero fake human users, zero fake chats,
 * zero fake wallet grants, zero fake stories, zero fake install counts).
 */
export function resetDatabaseClean(
  db: DatabaseSync,
  mediaDir: string,
  uploadsDir: string,
): void {
  const browserProfilesDir = path.join(path.dirname(mediaDir), 'p');
  for (const dir of [mediaDir, uploadsDir, browserProfilesDir]) {
    if (fs.existsSync(dir)) {
      for (const entry of fs.readdirSync(dir)) {
        fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
      }
    }
  }

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.exec(`
      DELETE FROM automation_app_runs;
      DELETE FROM user_automation_apps;
      DELETE FROM automation_app_versions;
      DELETE FROM automation_apps;
      DELETE FROM browser_audit_logs;
      DELETE FROM browser_desktop_tokens;
      DELETE FROM browser_pairing_tickets;
      DELETE FROM browser_control_generations;
      DELETE FROM redeem_codes;
      DELETE FROM payment_orders;
      DELETE FROM bot_computer_profiles;
      DELETE FROM remote_sessions;
      DELETE FROM remote_assist_devices;
      DELETE FROM mcp_tool_audit_log;
      DELETE FROM mcp_oauth_tokens;
      DELETE FROM mcp_oauth_codes;
      DELETE FROM mcp_oauth_clients;
      DELETE FROM user_bot_permissions;
      DELETE FROM group_workspace_entries;
      DELETE FROM group_workspaces;
      DELETE FROM user_provider_vaults;
      DELETE FROM archive_bot_dedup;
      DELETE FROM chat_create_nonces;
      DELETE FROM vault_device_sync_requests;
      DELETE FROM user_vault_items;
      DELETE FROM user_vault_envelopes;
      DELETE FROM fabushi_online_heartbeats;
      DELETE FROM fabushi_follows;
      DELETE FROM fabushi_transfers;
      DELETE FROM fabushi_practice_records;
      DELETE FROM fabushi_profiles;
      DELETE FROM wallet_idempotency;
      DELETE FROM wallet_transactions;
      DELETE FROM wallet_accounts;
      DELETE FROM tailnet_peers;
      DELETE FROM computer_commands;
      DELETE FROM computer_nodes;
      DELETE FROM talk_sessions;
      DELETE FROM mcp_approvals;
      DELETE FROM mcp_servers;
      DELETE FROM tasks;
      DELETE FROM magpie_usage_ledger;
      DELETE FROM magpie_state;
      DELETE FROM magpie_providers;
      DELETE FROM hermes_kanban_boards;
      DELETE FROM hermes_cron_jobs;
      DELETE FROM hermes_approvals;
      DELETE FROM hermes_skills;
      DELETE FROM hermes_kv;
      DELETE FROM hermes_turns;
      DELETE FROM hermes_sessions;
      DELETE FROM fabushi_state;
      DELETE FROM mini_app_cloud_storage;
      DELETE FROM mini_app_installs;
      DELETE FROM mini_apps;
      DELETE FROM bot_inline_queries;
      DELETE FROM bot_api_updates;
      DELETE FROM botfather_wizards;
      DELETE FROM bots_registry;
      DELETE FROM call_sessions;
      DELETE FROM e2ee_prekeys;
      DELETE FROM user_sticker_sets;
      DELETE FROM sticker_sets;
      DELETE FROM story_views;
      DELETE FROM stories;
      DELETE FROM media_upload_parts;
      DELETE FROM media_uploads;
      DELETE FROM media_files;
      DELETE FROM poll_votes;
      DELETE FROM polls;
      DELETE FROM pts_events;
      DELETE FROM outbox_dedup;
      DELETE FROM pinned_messages;
      DELETE FROM message_reactions;
      DELETE FROM message_user_deletions;
      DELETE FROM messages;
      DELETE FROM chat_admin_log;
      DELETE FROM chat_invite_links;
      DELETE FROM forum_topics;
      DELETE FROM chat_folders;
      DELETE FROM user_chat_settings;
      DELETE FROM chat_members;
      DELETE FROM chats;
      DELETE FROM user_blocks;
      DELETE FROM user_contacts;
      DELETE FROM account_privacy;
      DELETE FROM account_passkeys;
      DELETE FROM passkey_challenges;
      DELETE FROM alipay_sessions;
      DELETE FROM qr_pair_sessions;
      DELETE FROM twofa_challenges;
      DELETE FROM twofa_secrets;
      DELETE FROM otp_challenges;
      DELETE FROM auth_sessions;
      DELETE FROM users;
      DELETE FROM sqlite_sequence;
    `);
    seedSystemEntitiesIfEmpty(db, { inTransaction: true });
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

export const resetAndSeedDatabase = resetDatabaseClean;
