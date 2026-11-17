import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  HERMES_TOOLSET_IDS,
  parseMarkdownEntities,
  toWireMessageEntity,
  type BotRegistryEntry,
  type ChatFolderDto,
  type ComputerNodeDto,
  type HermesCronJobDto,
  type HermesKanbanBoardDto,
  type HermesSkillDto,
  type MagpieMaskingConfig,
  type MagpiePreset,
  type MagpieProviderView,
  type MagpieRoutingGroup,
  type McpServerDto,
  type MiniAppEntry,
  type PollData,
  type StickerSetDto,
  type TaskItemDto,
  type TodoListCard,
  type UserPrivacySettingsDto,
  type WalletTransactionDto,
} from '@gpui-telegram/protocol';
import { computeNextCronRunMs, hashSecretScrypt } from '../utils/crypto.js';

// Precompute seeded demo user scrypt hashes once at module load so `/api/v1/test/reset` finishes in <10ms
const SEED_PWD_ALICE = hashSecretScrypt('alice1234');
const SEED_PWD_BOB = hashSecretScrypt('bob12345');

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
  is_premium: true,
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

  // 1 Remote Magpie
  { id: 'remote-magpie', name: 'Remote Magpie Gateway', category: 'remote', api_mode: 'chat_completions', base_url: 'http://127.0.0.1:4173/api/v1/magpie/v1', default_model: 'hermes-local-v1', models: ['hermes-local-v1'], no_key_required: true },

  // 4 Custom protocol adapters
  { id: 'custom-openai', name: 'Custom OpenAI-Compatible', category: 'custom', api_mode: 'chat_completions', base_url: 'http://127.0.0.1:8000/v1', default_model: 'custom-gpt', models: ['custom-gpt'], no_key_required: false },
  { id: 'custom-anthropic', name: 'Custom Anthropic Messages', category: 'custom', api_mode: 'anthropic_messages', base_url: 'http://127.0.0.1:8000/v1', default_model: 'custom-claude', models: ['custom-claude'], no_key_required: false },
  { id: 'custom-gemini', name: 'Custom Gemini API', category: 'custom', api_mode: 'gemini_generate_content', base_url: 'http://127.0.0.1:8000/v1beta', default_model: 'custom-gemini', models: ['custom-gemini'], no_key_required: false },
  { id: 'custom-responses', name: 'Custom Codex Responses API', category: 'custom', api_mode: 'codex_responses', base_url: 'http://127.0.0.1:8000/v1', default_model: 'codex-mini', models: ['codex-mini'], no_key_required: false },
];

export function buildComputerViewportSvg(title: string, statusLine: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450" width="800" height="450">
    <rect width="800" height="450" fill="#0E1621"/>
    <rect x="0" y="0" width="800" height="34" fill="#17212B"/>
    <circle cx="18" cy="17" r="5" fill="#E53935"/>
    <circle cx="34" cy="17" r="5" fill="#FFB300"/>
    <circle cx="50" cy="17" r="5" fill="#43A047"/>
    <text x="72" y="22" fill="#F5F5F5" font-family="monospace" font-size="13">${title}</text>
    <rect x="24" y="54" width="752" height="368" rx="8" fill="#182533" stroke="#2B5278"/>
    <text x="44" y="92" fill="#3390EC" font-family="monospace" font-size="14">$ uname -a &amp;&amp; uptime</text>
    <text x="44" y="120" fill="#D8E2EC" font-family="monospace" font-size="13">Linux sandbox-default 6.8.0-x86_64 GNU/Linux</text>
    <text x="44" y="152" fill="#64B5F6" font-family="monospace" font-size="13">${statusLine}</text>
  </svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

export function seedDatabaseIfEmpty(db: DatabaseSync): void {
  const existing = db.prepare(`SELECT COUNT(*) AS cnt FROM users`).get() as { cnt: number };
  if (Number(existing.cnt) > 0) {
    return;
  }
  seedDeterministicUniverse(db);
}

export function resetAndSeedDatabase(db: DatabaseSync, mediaDir: string, uploadsDir: string): void {
  // Wipe CAS blobs and in-flight upload part files
  for (const dir of [mediaDir, uploadsDir]) {
    if (fs.existsSync(dir)) {
      for (const entry of fs.readdirSync(dir)) {
        fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
      }
    }
  }

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.exec(`
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
    seedDeterministicUniverse(db, { inTransaction: true });
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

export function seedDeterministicUniverse(
  db: DatabaseSync,
  options: { inTransaction?: boolean } = {},
): void {
  const baseTs = 1763395200000; // Fixed deterministic base epoch for reproducible ordering

  if (!options.inTransaction) {
    db.exec('BEGIN IMMEDIATE;');
  }
  try {
    const insertUser = db.prepare(`
      INSERT INTO users (
        user_id, username, first_name, last_name, bio, phone, email,
        password_salt, password_hash, emoji_status, is_bot, is_verified, is_premium,
        status, last_seen_ms, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertUser.run(
      1001, 'alice', 'Alice', 'Chen',
      'Full-Stack Systems Architect · Building GPUI Telegram Web',
      '+8613800138001', 'alice@gpui.dev',
      SEED_PWD_ALICE.saltHex, SEED_PWD_ALICE.hashHex,
      '⚡', 0, 1, 1, 'online', baseTs, baseTs,
    );
    insertUser.run(
      1002, 'bob_rivera', 'Bob', 'Rivera',
      'Distributed Sync & WebRTC Engine Lead',
      '+14155550102', 'bob@gpui.dev',
      SEED_PWD_BOB.saltHex, SEED_PWD_BOB.hashHex,
      '🚀', 0, 1, 1, 'online', baseTs, baseTs,
    );
    insertUser.run(
      1003, 'linwei', 'Lin', 'Wei',
      'Design Systems & Typography · 专注视觉与交互体验',
      '+8613900139003', 'linwei@gpui.dev',
      null, null,
      '🎨', 0, 0, 1, 'online', baseTs - 120_000, baseTs,
    );
    insertUser.run(
      1004, 'sara_rtl', 'Sara', 'Al-Mansoor',
      'Internationalization & Accessibility Specialist',
      '+971501234567', 'sara@gpui.dev',
      null, null,
      '🌍', 0, 0, 0, 'recently', baseTs - 600_000, baseTs,
    );
    insertUser.run(
      777000, 'HermesAgent', 'Hermes AI', 'Assistant',
      'Official Hermes 6-Tab AI Studio & Tool-Augmented Agent Runtime',
      null, null, null, null, '🤖', 1, 1, 1, 'bot', baseTs, baseTs,
    );
    insertUser.run(
      777001, 'BotFather', 'BotFather', '',
      'BotFather is the one bot to rule them all. Use it to create new bot accounts and Mini Apps.',
      null, null, null, null, '☑️', 1, 1, 1, 'bot', baseTs, baseTs,
    );
    insertUser.run(
      777002, 'FabushiBot', '全球法布施', 'Bot',
      '全球法布施 3D WASM Globe & Zen Room (木鱼 · 焚香 · 经典共修 · 功德回向)',
      null, null, null, null, '🪷', 1, 1, 1, 'bot', baseTs, baseTs,
    );
    insertUser.run(
      777003, 'TaskBoardBot', 'TaskBoard', 'Bot',
      'Collaborative Sprint & Kanban Mini App Companion',
      null, null, null, null, '📋', 1, 1, 0, 'bot', baseTs, baseTs,
    );

    // Privacy settings & Contacts for Alice
    const insertPrivacy = db.prepare(`INSERT INTO account_privacy (user_id, settings_json) VALUES (?, ?)`);
    for (const uid of [1001, 1002, 1003, 1004]) {
      insertPrivacy.run(uid, JSON.stringify(DEFAULT_PRIVACY_SETTINGS));
    }

    const insertContact = db.prepare(`
      INSERT INTO user_contacts (owner_user_id, contact_user_id, first_name, last_name, created_at_ms)
      VALUES (?, ?, ?, ?, ?)
    `);
    insertContact.run(1001, 1002, 'Bob', 'Rivera', baseTs);
    insertContact.run(1001, 1003, 'Lin', 'Wei', baseTs);
    insertContact.run(1001, 1004, 'Sara', 'Al-Mansoor', baseTs);
    insertContact.run(1002, 1001, 'Alice', 'Chen', baseTs);

    // Chats
    const insertChat = db.prepare(`
      INSERT INTO chats (
        chat_id, title, kind, chat_type, creator_id, peer_user_id, username, about,
        is_forum, is_verified, pts, next_msg_id, last_message_id, last_message_date_ms,
        last_message_preview, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertChat.run(100, 'Saved Messages', 'saved', 0, 1001, 1001, null, 'Cloud personal scratchpad & bookmarks', 0, 0, 0, 1, 0, baseTs, '', baseTs);
    insertChat.run(101, 'Bob Rivera', 'private', 0, 1001, 1002, 'bob_rivera', 'Distributed Sync & WebRTC Engine Lead', 0, 1, 0, 1, 0, baseTs, '', baseTs);
    insertChat.run(102, 'Product Design Group', 'group', 1, 1001, null, null, 'Core UI/UX, Vanilla CSS Themes, CJK Typography & Rich Cards', 0, 0, 0, 1, 0, baseTs, '', baseTs);
    insertChat.run(103, 'GPUI Telegram Forum', 'supergroup', 2, 1001, null, 'gpui_engineering', 'Supergroup Forum for Protocol, Architecture & Releases', 1, 1, 0, 1, 0, baseTs, '', baseTs);
    insertChat.run(104, 'Tech News Channel', 'channel', 3, 1001, null, 'tech_news_channel', 'Official release notes, benchmarks, and ecosystem updates', 0, 1, 0, 1, 0, baseTs, '', baseTs);
    insertChat.run(105, 'BotFather', 'bot', 0, 1001, 777001, 'BotFather', 'Official Bot & Mini App Creator', 0, 1, 0, 1, 0, baseTs, '', baseTs);
    insertChat.run(106, 'Hermes AI', 'bot', 0, 1001, 777000, 'HermesAgent', 'Hermes 6-Tab Studio & Agent Assistant', 0, 1, 0, 1, 0, baseTs, '', baseTs);
    insertChat.run(107, '全球法布施', 'bot', 0, 1001, 777002, 'FabushiBot', '全球法布施 3D Globe & 禅室修行助手', 0, 1, 0, 1, 0, baseTs, '', baseTs);
    insertChat.run(108, 'Legacy v1.0 Archive', 'group', 1, 1002, null, null, 'Archived v1.0 migration notes', 0, 0, 0, 1, 0, baseTs - 86_400_000, '', baseTs - 86_400_000);

    // Chat Members
    const insertMember = db.prepare(`
      INSERT INTO chat_members (chat_id, user_id, role, admin_rights, banned_rights, custom_title, joined_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertMember.run(100, 1001, 'owner', 255, 0, null, baseTs);
    insertMember.run(101, 1001, 'member', 0, 0, null, baseTs);
    insertMember.run(101, 1002, 'member', 0, 0, null, baseTs);

    insertMember.run(102, 1001, 'owner', 255, 0, 'Founder', baseTs);
    insertMember.run(102, 1002, 'admin', 127, 0, 'Sync Lead', baseTs);
    insertMember.run(102, 1003, 'member', 0, 0, 'Design Lead', baseTs);
    insertMember.run(102, 1004, 'member', 0, 0, null, baseTs);

    insertMember.run(103, 1001, 'owner', 255, 0, 'Core Maintainer', baseTs);
    insertMember.run(103, 1002, 'admin', 127, 0, 'Protocol Architect', baseTs);
    insertMember.run(103, 1003, 'member', 0, 0, null, baseTs);
    insertMember.run(103, 777000, 'member', 0, 0, 'AI Bot', baseTs);

    insertMember.run(104, 1001, 'owner', 255, 0, 'Editor', baseTs);
    insertMember.run(104, 1002, 'admin', 127, 0, null, baseTs);
    insertMember.run(104, 1003, 'member', 0, 0, null, baseTs);
    insertMember.run(104, 1004, 'member', 0, 0, null, baseTs);

    insertMember.run(105, 1001, 'member', 0, 0, null, baseTs);
    insertMember.run(105, 777001, 'owner', 255, 0, null, baseTs);

    insertMember.run(106, 1001, 'member', 0, 0, null, baseTs);
    insertMember.run(106, 777000, 'owner', 255, 0, null, baseTs);

    insertMember.run(107, 1001, 'member', 0, 0, null, baseTs);
    insertMember.run(107, 777002, 'owner', 255, 0, null, baseTs);

    insertMember.run(108, 1001, 'member', 0, 0, null, baseTs);
    insertMember.run(108, 1002, 'owner', 255, 0, null, baseTs);

    // Forum Topics on Supergroup 103
    const insertTopic = db.prepare(`
      INSERT INTO forum_topics (chat_id, topic_id, title, icon_color, icon_emoji, creator_id, is_pinned, is_closed, is_hidden, last_message_id, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertTopic.run(103, 1, 'General', 0x3390ec, '💬', 1001, 1, 0, 0, null, baseTs);
    insertTopic.run(103, 2, 'Architecture', 0x2ea043, '🏗️', 1002, 1, 0, 0, null, baseTs);
    insertTopic.run(103, 3, 'Releases', 0xe5a00d, '🚀', 1001, 0, 0, 0, null, baseTs);

    // Seed Helper to insert real PTS-tracked messages
    const seedMsg = (params: {
      chatId: number;
      senderId: number;
      markdown?: string;
      content?: unknown;
      topicId?: number;
      replyToMsgId?: number;
      quoteText?: string;
      views?: number;
      isPinned?: boolean;
      inlineKeyboard?: unknown;
      dateOffsetMs: number;
    }): number => {
      const chatRow = db
        .prepare(`SELECT pts, next_msg_id, chat_type FROM chats WHERE chat_id = ?`)
        .get(params.chatId) as { pts: number; next_msg_id: number; chat_type: number };
      const msgId = Number(chatRow.next_msg_id);
      const nextPts = Number(chatRow.pts) + 1;
      const dateMs = baseTs + params.dateOffsetMs;

      let plainText = '';
      let wireEntities: unknown[] = [];
      let contentObj: unknown = params.content;

      if (!contentObj) {
        const parsed = parseMarkdownEntities(params.markdown ?? '');
        plainText = parsed.text;
        wireEntities = parsed.entities.map(toWireMessageEntity);
        contentObj = {
          type: 'Text',
          data: {
            text: plainText,
            entities: wireEntities,
          },
        };
      } else {
        const typed = contentObj as { type: string; data?: Record<string, unknown> };
        plainText = String(typed.data?.question ?? typed.data?.title ?? `[${typed.type}]`);
      }

      const flags = {
        is_out: false,
        is_pinned: Boolean(params.isPinned),
        is_silent: false,
        is_edited: false,
        is_scheduled: false,
        media_unread: false,
        has_reactions: false,
        no_forwards: false,
        is_forwarded: false,
        is_post: Number(chatRow.chat_type) === 3,
      };

      const replyJson = params.replyToMsgId
        ? JSON.stringify({
            reply_to_msg_id: params.replyToMsgId,
            quote_text: params.quoteText,
          })
        : null;

      db.prepare(`
        INSERT INTO messages (
          chat_id, message_id, sender_id, topic_id, date_ms, text_plain,
          content_json, entities_json, reply_to_json, inline_keyboard_json, flags_json, views
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        params.chatId,
        msgId,
        params.senderId,
        params.topicId ?? null,
        dateMs,
        plainText,
        JSON.stringify(contentObj),
        JSON.stringify(wireEntities),
        replyJson,
        params.inlineKeyboard ? JSON.stringify(params.inlineKeyboard) : null,
        JSON.stringify(flags),
        params.views ?? 1,
      );

      db.prepare(`
        UPDATE chats
        SET pts = ?, next_msg_id = ?, last_message_id = ?, last_message_date_ms = ?, last_message_preview = ?
        WHERE chat_id = ?
      `).run(nextPts, msgId + 1, msgId, dateMs, plainText.slice(0, 120), params.chatId);

      if (params.topicId) {
        db.prepare(`UPDATE forum_topics SET last_message_id = ? WHERE chat_id = ? AND topic_id = ?`).run(
          msgId,
          params.chatId,
          params.topicId,
        );
      }

      if (params.isPinned) {
        db.prepare(`
          INSERT INTO pinned_messages (chat_id, message_id, topic_id, pinned_by, pinned_at_ms)
          VALUES (?, ?, ?, ?, ?)
        `).run(params.chatId, msgId, params.topicId ?? 0, params.senderId, dateMs);
      }

      const eventPayload = {
        type: 'NewMessage',
        data: {
          id: msgId,
          chat_id: params.chatId,
          sender_id: params.senderId,
          date: new Date(dateMs).toISOString(),
          content: contentObj,
        },
      };
      db.prepare(`
        INSERT INTO pts_events (chat_id, pts, pts_count, created_at_ms, event_json)
        VALUES (?, ?, 1, ?, ?)
      `).run(params.chatId, nextPts, dateMs, JSON.stringify(eventPayload));

      return msgId;
    };

    // Saved Messages (100)
    seedMsg({
      chatId: 100,
      senderId: 1001,
      markdown: '📌 **Saved Notes**: Remember to verify UTF-16 surrogate pairs 🎉 and中文全文搜索 (`全球法布施`) before shipping v1.2.0!',
      isPinned: true,
      dateOffsetMs: 1000,
    });

    // DM with Bob Rivera (101)
    const bobMsg1 = seedMsg({
      chatId: 101,
      senderId: 1002,
      markdown: 'Hey @alice! Monotonic per-chat `pts` sync and WebSocket `/api/v1/ws` gap recovery are live.\n```ts\nconst gap = detectPtsGap(update, localPts);\n```',
      dateOffsetMs: 5000,
    });
    seedMsg({
      chatId: 101,
      senderId: 1001,
      markdown: 'Awesome work! Let us also test partial quote replies and ||spoiler formatting|| in #TelegramWeb.',
      replyToMsgId: bobMsg1,
      quoteText: 'Monotonic per-chat pts sync',
      dateOffsetMs: 9000,
    });

    // Product Design Group (102) — Text + Poll + Todo + Reactions
    const grpWelcome = seedMsg({
      chatId: 102,
      senderId: 1003,
      markdown: '大家好！Welcome to **Product Design Group**. Remember: Night theme uses crisp Telegram Blue `#3390EC` on `#0E1621` — strictly zero purple on dark!',
      isPinned: true,
      dateOffsetMs: 12_000,
    });

    const seededPoll: PollData = {
      id: 'poll_seed_1',
      poll_id: 1,
      question: 'Which responsive layout mode do you use most often?',
      options: [
        { option_id: 0, text: '3-Column Desktop (>=1276px)', vote_count: 2, is_chosen: true, percentage: 67, voter_ids: [1001, 1002] },
        { option_id: 1, text: '2-Column Compact (926–1275px)', vote_count: 1, is_chosen: false, percentage: 33, voter_ids: [1003] },
        { option_id: 2, text: 'Mobile Slide-Stack (<=600px)', vote_count: 0, is_chosen: false, percentage: 0, voter_ids: [] },
      ],
      total_voters: 3,
      total_votes: 3,
      is_closed: false,
      is_anonymous: false,
      allows_multiple_answers: false,
      is_quiz: false,
    };
    const pollMsgId = seedMsg({
      chatId: 102,
      senderId: 1001,
      content: { type: 'Poll', data: seededPoll },
      dateOffsetMs: 15_000,
    });
    db.prepare(`
      INSERT INTO polls (poll_id, chat_id, message_id, creator_id, poll_json, is_closed, created_at_ms)
      VALUES (1, 102, ?, 1001, ?, 0, ?)
    `).run(pollMsgId, JSON.stringify(seededPoll), baseTs + 15_000);
    db.prepare(`INSERT INTO poll_votes (poll_id, user_id, option_ids_json, voted_at_ms) VALUES (1, 1001, '[0]', ?)`).run(baseTs + 15_100);
    db.prepare(`INSERT INTO poll_votes (poll_id, user_id, option_ids_json, voted_at_ms) VALUES (1, 1002, '[0]', ?)`).run(baseTs + 15_200);
    db.prepare(`INSERT INTO poll_votes (poll_id, user_id, option_ids_json, voted_at_ms) VALUES (1, 1003, '[1]', ?)`).run(baseTs + 15_300);

    const seededTodo: TodoListCard = {
      id: 'todo_seed_1',
      list_id: 'todo_seed_1',
      title: 'M1 Launch Readiness Checklist',
      items: [
        { id: 'item_1', title: 'Verify 3-state CJK IME Safety FSM', completed: true, completed_at_ms: baseTs + 16_000 },
        { id: 'item_2', title: 'Verify 100-bar 5-bit voice waveform codec', completed: true, completed_at_ms: baseTs + 16_500 },
        { id: 'item_3', title: 'Test HTTP 206 byte-range media streaming', completed: false },
      ],
      completed_count: 2,
      action_buttons: [],
    };
    seedMsg({
      chatId: 102,
      senderId: 1002,
      content: { type: 'Todo', data: seededTodo },
      dateOffsetMs: 18_000,
    });

    // Seed Reactions on grpWelcome
    db.prepare(`INSERT INTO message_reactions (chat_id, message_id, user_id, emoji, created_at_ms) VALUES (102, ?, 1001, '🔥', ?)`).run(grpWelcome, baseTs + 13_000);
    db.prepare(`INSERT INTO message_reactions (chat_id, message_id, user_id, emoji, created_at_ms) VALUES (102, ?, 1002, '🔥', ?)`).run(grpWelcome, baseTs + 13_100);
    db.prepare(`INSERT INTO message_reactions (chat_id, message_id, user_id, emoji, created_at_ms) VALUES (102, ?, 1004, '👍', ?)`).run(grpWelcome, baseTs + 13_200);

    // Forum Supergroup (103) messages per topic
    seedMsg({
      chatId: 103,
      senderId: 1001,
      topicId: 1,
      markdown: 'Welcome to `#General` in **GPUI Telegram Forum**! Post cross-team updates here.',
      isPinned: true,
      dateOffsetMs: 20_000,
    });
    seedMsg({
      chatId: 103,
      senderId: 1002,
      topicId: 2,
      markdown: 'Architecture note: `TelegramClientPort` cleanly decouples `server`, `sandbox`, and `mtproto` adapters.',
      dateOffsetMs: 22_000,
    });
    seedMsg({
      chatId: 103,
      senderId: 1001,
      topicId: 3,
      markdown: 'Release `v1.2.0` includes `$TON` & Stars Wallet, `@BotFather`, and 全球法布施 3D Globe.',
      dateOffsetMs: 24_000,
    });

    // Tech News Channel (104) with views & Invoice card
    seedMsg({
      chatId: 104,
      senderId: 1001,
      markdown: '📣 **GPUI Telegram Web v1.2.0 Released!** Full real-time sync, WebCrypto E2EE (`ECDH P-256 + AES-256-GCM`), and Hermes 6-Tab Studio are now available at https://gpui-telegram.dev/releases.',
      views: 1480,
      isPinned: true,
      dateOffsetMs: 26_000,
    });
    seedMsg({
      chatId: 104,
      senderId: 1001,
      content: {
        type: 'Invoice',
        data: {
          id: 'inv_pro_supporter',
          invoice_id: 'inv_pro_supporter',
          title: 'Telegram Stars Cloud Supporter Pack',
          description: 'Unlock custom emoji status & support open-source development',
          currency: 'XTR',
          amount_cents: 150,
          total_amount: 150,
          status: 'pending',
          is_paid: false,
          prices: [{ label: 'Supporter Badge (150 Stars)', amount_cents: 150 }],
        },
      },
      views: 920,
      dateOffsetMs: 28_000,
    });

    // Bot chats (105 BotFather, 106 Hermes, 107 Fabushi)
    seedMsg({
      chatId: 105,
      senderId: 777001,
      markdown: 'I can help you create and manage Telegram bots and Mini Apps.\n\nCommands:\n/newbot — create a new bot\n/mybots — manage your bots\n/newapp — create a WebApp Mini App\n/setdescription — change bot description\n/deletebot — delete an existing bot',
      inlineKeyboard: [
        [
          { text: '➕ New Bot', callback_data: 'bf:newbot' },
          { text: '🤖 My Bots', callback_data: 'bf:mybots' },
        ],
        [
          { text: '🧩 New Mini App', callback_data: 'bf:newapp' },
        ],
      ],
      dateOffsetMs: 30_000,
    });

    seedMsg({
      chatId: 106,
      senderId: 777000,
      markdown: 'Hello! I am **Hermes AI** (`@HermesAgent`). Type `/help` to inspect all 61 slash commands or open **Hermes 6-Tab Studio** to manage Sessions, Memory (`MEMORY.md` / `SOUL.md`), Skills, 29 Toolsets, Cron, and Kanban.',
      dateOffsetMs: 32_000,
    });

    seedMsg({
      chatId: 107,
      senderId: 777002,
      markdown: '欢迎来到 **全球法布施 (`@FabushiBot`)**！点击下方按钮启动 3D 地球法布施与禅室（木鱼 · 焚香 · 心经/金刚经共修）。',
      inlineKeyboard: [
        [
          {
            text: '🌏 启动全球法布施 3D Globe',
            web_app_url: '/miniapps/FabushiBot/fabushi-globe',
          },
        ],
      ],
      dateOffsetMs: 34_000,
    });

    seedMsg({
      chatId: 108,
      senderId: 1002,
      markdown: 'Archived v1.0 sprint retrospective notes.',
      dateOffsetMs: -80_000_000,
    });

    // User Chat Settings for Alice (1001) & Bob (1002)
    const insertChatSetting = db.prepare(`
      INSERT INTO user_chat_settings (
        user_id, chat_id, is_pinned, is_archived, is_muted, read_inbox_max_id, read_outbox_max_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertChatSetting.run(1001, 100, 1, 0, 0, 1, 1);
    insertChatSetting.run(1001, 101, 1, 0, 0, 2, 2);
    insertChatSetting.run(1001, 102, 0, 0, 0, 1, 2);
    insertChatSetting.run(1001, 103, 0, 0, 0, 2, 3);
    insertChatSetting.run(1001, 104, 0, 0, 1, 2, 2);
    insertChatSetting.run(1001, 105, 0, 0, 0, 1, 1);
    insertChatSetting.run(1001, 106, 0, 0, 0, 1, 1);
    insertChatSetting.run(1001, 107, 0, 0, 0, 1, 1);
    insertChatSetting.run(1001, 108, 0, 1, 1, 1, 1);

    insertChatSetting.run(1002, 101, 1, 0, 0, 2, 2);
    insertChatSetting.run(1002, 102, 0, 0, 0, 3, 3);
    insertChatSetting.run(1002, 103, 0, 0, 0, 3, 3);

    // Chat Folders for Alice
    const folders: ChatFolderDto[] = [
      {
        id: 1,
        folder_id: 'personal',
        title: 'Personal',
        emoticon: '👤',
        include_chats: [100, 101],
        exclude_chats: [],
        pinned_chats: [100],
        include_contacts: true,
        include_non_contacts: false,
        include_groups: false,
        include_channels: false,
        include_bots: false,
        exclude_muted: false,
        exclude_read: false,
        exclude_archived: true,
        sort_order: 1,
      },
      {
        id: 2,
        folder_id: 'work',
        title: 'Work',
        emoticon: '💼',
        include_chats: [102, 103, 104],
        exclude_chats: [],
        pinned_chats: [103],
        include_contacts: false,
        include_non_contacts: false,
        include_groups: true,
        include_channels: true,
        include_bots: false,
        exclude_muted: false,
        exclude_read: false,
        exclude_archived: true,
        sort_order: 2,
      },
      {
        id: 3,
        folder_id: 'bots',
        title: 'Bots & AI',
        emoticon: '🤖',
        include_chats: [105, 106, 107],
        exclude_chats: [],
        pinned_chats: [106],
        include_contacts: false,
        include_non_contacts: false,
        include_groups: false,
        include_channels: false,
        include_bots: true,
        exclude_muted: false,
        exclude_read: false,
        exclude_archived: true,
        sort_order: 3,
      },
    ];
    const insertFolder = db.prepare(`
      INSERT INTO chat_folders (user_id, folder_id, title, emoticon, folder_json, sort_order)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const f of folders) {
      insertFolder.run(1001, f.id, f.title, f.emoticon ?? null, JSON.stringify(f), f.sort_order);
    }

    // Stories
    const nowMs = Date.now();
    const insertStory = db.prepare(`
      INSERT INTO stories (
        story_id, user_id, media_id, media_type, caption, background_gradient,
        privacy, views_count, created_at_ms, expires_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertStory.run('story_alice_1', 1001, null, 'gradient_card', 'Shipping GPUI Telegram Web v1.2.0 🚀', 'linear-gradient(135deg, #1084FE, #2B5278)', 'everyone', 14, nowMs - 3_600_000, nowMs + 82_800_000);
    insertStory.run('story_bob_1', 1002, null, 'gradient_card', 'Zero-gap PTS sync benchmark: 0.4ms commit latency ⚡', 'linear-gradient(135deg, #0F766E, #115E59)', 'everyone', 9, nowMs - 1_800_000, nowMs + 84_600_000);
    insertStory.run('story_linwei_1', 1003, null, 'gradient_card', '全新夜间蓝与经典绿四套主题设计定稿 ✨', 'linear-gradient(135deg, #1E3A8A, #0284C7)', 'everyone', 19, nowMs - 900_000, nowMs + 85_500_000);

    // Sticker Sets
    const stickerSets: StickerSetDto[] = [
      {
        set_id: 'gpui_mascots',
        short_name: 'gpui_mascots',
        title: 'GPUI Mascots',
        count: 4,
        is_installed: true,
        stickers: [
          { id: 'stk_rocket', set_id: 'gpui_mascots', emoji: '🚀', mime_type: 'image/svg+xml', width: 160, height: 160, is_animated: false, is_video: false },
          { id: 'stk_fire', set_id: 'gpui_mascots', emoji: '🔥', mime_type: 'image/svg+xml', width: 160, height: 160, is_animated: false, is_video: false },
          { id: 'stk_lotus', set_id: 'gpui_mascots', emoji: '🪷', mime_type: 'image/svg+xml', width: 160, height: 160, is_animated: false, is_video: false },
          { id: 'stk_party', set_id: 'gpui_mascots', emoji: '🎉', mime_type: 'image/svg+xml', width: 160, height: 160, is_animated: false, is_video: false },
        ],
      },
    ];
    for (const s of stickerSets) {
      db.prepare(`INSERT INTO sticker_sets (set_id, short_name, title, stickers_json, installed_by_default) VALUES (?, ?, ?, ?, 1)`).run(
        s.set_id,
        s.short_name,
        s.title,
        JSON.stringify(s.stickers),
      );
    }

    // Official Bots Registry
    const officialBots: Array<{ token: string; entry: BotRegistryEntry }> = [
      {
        token: '777001:AAOfficialBotFatherToken_v1',
        entry: {
          bot_user_id: 777001,
          owner_user_id: 1001,
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
          created_at_ms: baseTs,
        },
      },
      {
        token: '777000:AAOfficialHermesAgentToken_v1',
        entry: {
          bot_user_id: 777000,
          owner_user_id: 1001,
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
          preferred_model: 'hermes-local-v1',
          approval_mode: 'ask',
          toolset_preset: 'hermes-telegram',
          created_at_ms: baseTs,
        },
      },
      {
        token: '777002:AAOfficialFabushiBotToken_v1',
        entry: {
          bot_user_id: 777002,
          owner_user_id: 1001,
          username: 'FabushiBot',
          display_name: '全球法布施',
          description: '全球法布施 WASM 3D Globe & Zen Room Mini App Bot',
          about: '实时全球法布施光束 · 禅室电子木鱼 · 经典共修 · 功德回向',
          commands: [
            { command: 'start', description: '打开全球法布施导航卡片' },
          ],
          is_official: true,
          is_inline: true,
          allow_attach_menu: true,
          menu_button_type: 'web_app',
          menu_button_text: '全球法布施',
          menu_button_url: '/miniapps/FabushiBot/fabushi-globe',
          has_main_app: true,
          main_app_short_name: 'fabushi-globe',
          created_at_ms: baseTs,
        },
      },
      {
        token: '777003:AAOfficialTaskBoardBotToken_v1',
        entry: {
          bot_user_id: 777003,
          owner_user_id: 1001,
          username: 'TaskBoardBot',
          display_name: 'TaskBoard Bot',
          description: 'Team Sprint & Checklist Mini App Bot',
          about: 'Interactive TaskBoard WebApp integrated with Telegram CloudStorage',
          commands: [
            { command: 'start', description: 'Open TaskBoard Mini App' },
          ],
          is_official: true,
          is_inline: false,
          allow_attach_menu: true,
          menu_button_type: 'web_app',
          menu_button_text: 'TaskBoard',
          menu_button_url: '/miniapps/TaskBoardBot/taskboard',
          has_main_app: true,
          main_app_short_name: 'taskboard',
          created_at_ms: baseTs,
        },
      },
    ];

    const insertBot = db.prepare(`
      INSERT INTO bots_registry (bot_user_id, owner_user_id, bot_token, bot_json, created_at_ms)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const b of officialBots) {
      insertBot.run(b.entry.bot_user_id, b.entry.owner_user_id, b.token, JSON.stringify(b.entry), baseTs);
    }

    // Seeded Mini Apps (`fabushi-globe`, alias `fabushi`, and `taskboard`)
    const miniApps: MiniAppEntry[] = [
      {
        app_id: 'app_fabushi_globe',
        bot_user_id: 777002,
        bot_username: 'FabushiBot',
        short_name: 'fabushi-globe',
        title: '全球法布施 3D Globe & 禅室',
        description: 'Compiled WebAssembly 3D spherical projection globe, Dharma light beams, Wooden Fish (木鱼), Sutras & Merit Leaderboard.',
        category: 'lifestyle',
        icon_emoji: '🌏',
        web_url: '/miniapps/FabushiBot/fabushi-globe',
        has_wasm: true,
        is_installed: true,
        companion_chat_id: 107,
        install_count: 1080,
        created_at_ms: baseTs,
      },
      {
        app_id: 'app_fabushi_alias',
        bot_user_id: 777002,
        bot_username: 'FabushiBot',
        short_name: 'fabushi',
        title: '全球法布施 (Fabushi)',
        description: '全球法布施 3D WASM 地球与禅室共修应用',
        category: 'lifestyle',
        icon_emoji: '🪷',
        web_url: '/miniapps/FabushiBot/fabushi',
        has_wasm: true,
        is_installed: true,
        companion_chat_id: 107,
        install_count: 860,
        created_at_ms: baseTs,
      },
      {
        app_id: 'app_taskboard',
        bot_user_id: 777003,
        bot_username: 'TaskBoardBot',
        short_name: 'taskboard',
        title: 'TaskBoard Sprint Planner',
        description: 'Collaborative sprint board backed by Telegram.WebApp.CloudStorage & sendData.',
        category: 'productivity',
        icon_emoji: '📋',
        web_url: '/miniapps/TaskBoardBot/taskboard',
        has_wasm: false,
        is_installed: true,
        install_count: 420,
        created_at_ms: baseTs,
      },
    ];
    const insertMiniApp = db.prepare(`
      INSERT INTO mini_apps (app_id, bot_user_id, bot_username, short_name, app_json, html_bundle, created_at_ms)
      VALUES (?, ?, ?, ?, ?, NULL, ?)
    `);
    for (const app of miniApps) {
      insertMiniApp.run(app.app_id, app.bot_user_id, app.bot_username, app.short_name, JSON.stringify(app), baseTs);
      db.prepare(`
        INSERT INTO mini_app_installs (user_id, app_id, companion_chat_id, installed_at_ms)
        VALUES (1001, ?, ?, ?)
      `).run(app.app_id, app.companion_chat_id ?? null, baseTs);
    }

    // Seed Hermes 6-Tab Studio initial state for Alice (1001)
    const insertHermesKv = db.prepare(`
      INSERT INTO hermes_kv (user_id, kv_key, kv_value, updated_at_ms) VALUES (?, ?, ?, ?)
    `);
    insertHermesKv.run(1001, 'memory_md', 'Project: gpui-telegram-web v1.2.0\n§\nArchitecture: Hexagonal TypeScript Monorepo + SQLite WAL + PTS Sync', baseTs);
    insertHermesKv.run(1001, 'user_md', 'Primary User: Alice Chen (@alice)\n§\nPreferred Languages: English & Simplified Chinese (zh-CN)', baseTs);
    insertHermesKv.run(1001, 'soul_md', 'You are Hermes AI, a calm, rigorous systems engineer integrated natively into GPUI Telegram Web.', baseTs);
    insertHermesKv.run(1001, 'honcho_obs', JSON.stringify(['Prefers deterministic tests and clean Vanilla CSS design tokens.']), baseTs);
    insertHermesKv.run(1001, 'enabled_toolsets', JSON.stringify([...HERMES_TOOLSET_IDS]), baseTs);
    insertHermesKv.run(1001, 'approval_mode', 'ask', baseTs);
    insertHermesKv.run(
      1001,
      'heartbeat',
      JSON.stringify({ enabled: true, interval_secs: 300, active_chat_id: 106, last_tick_ms: baseTs, tick_count: 1 }),
      baseTs,
    );

    db.prepare(`
      INSERT INTO hermes_sessions (
        session_id, user_id, parent_session_id, chat_id, bot_id, title, source, model,
        messages_json, checkpoints_json, total_tokens, total_cost_usd, created_at_ms, updated_at_ms
      ) VALUES (?, 1001, NULL, 106, 777000, ?, 'telegram', 'hermes-local-v1', ?, '[]', 128, 0, ?, ?)
    `).run(
      'hses_seed_main',
      'Architecture & PTS Sync Review',
      JSON.stringify([
        { id: 'm1', role: 'user', content: 'Summarize our PTS gap recovery design.', created_at_ms: baseTs },
        { id: 'm2', role: 'assistant', content: 'Each mutating chat event increments monotonic per-chat `pts` in SQLite WAL and replays missing deltas via `/api/v1/sync/get_difference`.', reasoning: 'Checked sync/pts.rs invariants.', created_at_ms: baseTs + 500 },
      ]),
      baseTs,
      baseTs + 500,
    );

    const seedSkill: HermesSkillDto = {
      name: 'pts-sync-diagnostics',
      description: 'Inspects per-chat PTS continuity, outbox deduplication, and WebSocket health.',
      body: '---\nname: pts-sync-diagnostics\n---\nVerify prevPts(update) === localPts before applying state updates.',
      tags: ['sync', 'diagnostics'],
      toolsets: ['core', 'session_search'],
      version: '1.0.0',
      enabled: true,
      trusted: true,
      status: 'active',
      security_risk: 'none',
      security_findings: [],
      updated_at_ms: baseTs,
    };
    db.prepare(`INSERT INTO hermes_skills (user_id, name, skill_json, updated_at_ms) VALUES (1001, ?, ?, ?)`).run(
      seedSkill.name,
      JSON.stringify(seedSkill),
      baseTs,
    );

    const seedCron: HermesCronJobDto = {
      job_id: 'cron_daily_digest',
      name: 'Daily Engineering Digest',
      schedule_expr: '0 9 * * *',
      prompt: 'Summarize unread highlights in GPUI Telegram Forum.',
      chat_id: 106,
      bot_id: 777000,
      enabled: true,
      next_run_ms: computeNextCronRunMs('0 9 * * *', nowMs),
      last_run_ms: null,
      run_count: 0,
    };
    db.prepare(`INSERT INTO hermes_cron_jobs (job_id, user_id, job_json, created_at_ms) VALUES (?, 1001, ?, ?)`).run(
      seedCron.job_id,
      JSON.stringify(seedCron),
      baseTs,
    );

    const seedBoard: HermesKanbanBoardDto = {
      board_id: 'board_main',
      title: 'GPUI Telegram Web Roadmap',
      description: '6-Tab Hermes Studio Kanban Board',
      columns: ['inbox', 'todo', 'in_progress', 'review', 'done'],
      cards: [
        {
          card_id: 'card_1',
          board_id: 'board_main',
          column_id: 'done',
          title: 'Shared Protocol & 5-Bit Waveform Codec',
          description: 'UTF-16 entities, CJK IME FSM, and WebCrypto E2EE envelopes',
          priority: 'high',
          labels: ['protocol'],
          assignee: 'alice',
          checklist: [{ text: '127 canonical DOM IDs', completed: true }],
          comments: [],
          position: 0,
          updated_at_ms: baseTs,
        },
        {
          card_id: 'card_2',
          board_id: 'board_main',
          column_id: 'in_progress',
          title: 'Full-Stack SQLite WAL & WS PTS Engine',
          description: '7 Auth flows, HTTP 206 CAS media, Hermes & Magpie',
          priority: 'urgent',
          labels: ['server'],
          assignee: 'bob_rivera',
          checklist: [{ text: 'Sub-50ms test reset', completed: true }],
          comments: [],
          position: 0,
          updated_at_ms: baseTs,
        },
      ],
    };
    db.prepare(`INSERT INTO hermes_kanban_boards (board_id, user_id, board_json, updated_at_ms) VALUES (?, 1001, ?, ?)`).run(
      seedBoard.board_id,
      JSON.stringify(seedBoard),
      baseTs,
    );

    // Seed Magpie Gateway Default Local Provider + State
    const localProvider: MagpieProviderView = {
      provider_id: 'local_hermes',
      preset_id: 'remote-magpie',
      name: 'Local Hermes Smart Runtime',
      api_mode: 'local_hermes',
      base_url: 'local://hermes-v1',
      default_model: 'hermes-local-v1',
      enabled: true,
      no_key_required: true,
      has_api_key: false,
      masked_key: null,
      custom_headers: {},
      updated_at_ms: baseTs,
    };
    db.prepare(`
      INSERT INTO magpie_providers (user_id, provider_id, provider_json, encrypted_api_key, key_nonce, updated_at_ms)
      VALUES (1001, 'local_hermes', ?, NULL, NULL, ?)
    `).run(JSON.stringify(localProvider), baseTs);

    const defaultMasking: MagpieMaskingConfig = {
      enabled: true,
      mask_secrets: true,
      mask_personal: true,
      custom_words: [],
      allow_list: ['alice@gpui.dev'],
      default_action: 'mask',
    };
    const defaultGroup: MagpieRoutingGroup = {
      id: 'default-smart',
      name: 'Smart Default Pool',
      strategy: 'smart',
      members: [{ target: 'local_hermes', weight: 100, enabled: true, free: true }],
      sticky_ttl_ms: 300_000,
    };
    db.prepare(`
      INSERT INTO magpie_state (user_id, state_json, updated_at_ms) VALUES (1001, ?, ?)
    `).run(
      JSON.stringify({
        active_provider: 'local_hermes',
        active_model: 'hermes-local-v1',
        allow_local_fallback: true,
        routing_strategy: 'smart',
        routing_groups: [defaultGroup],
        masking: defaultMasking,
        subscriptions: [
          {
            id: 'sub_local_free',
            kind: 'antigravity',
            label: 'Built-in Local Hermes Runtime (Zero-Key)',
            plan: 'Free Unlimited',
            models: ['hermes-local-v1', 'hermes-fast-v1'],
            active: true,
          },
        ],
      }),
      baseTs,
    );

    // Seed Global Task Center, MCP Servers, Computer Sandbox, Tailnet, and Wallet
    const seedTask: TaskItemDto = {
      task_id: 'task_seed_1',
      title: 'Index CJK Search Corpus',
      description: 'Verify highlighted snippet extraction across chats and messages',
      state: 'completed',
      cron_expr: '*/30 * * * *',
      next_run_ms: computeNextCronRunMs('*/30 * * * *', nowMs),
      chat_id: 103,
      progress: 100,
      logs: ['Initialized SQLite WAL search index', 'Verified CJK 1-char and phrase queries'],
      created_at_ms: baseTs,
      updated_at_ms: baseTs,
    };
    db.prepare(`INSERT INTO tasks (task_id, user_id, task_json, updated_at_ms) VALUES (?, 1001, ?, ?)`).run(
      seedTask.task_id,
      JSON.stringify(seedTask),
      baseTs,
    );

    const seedMcp: McpServerDto = {
      server_id: 'mcp_filesystem',
      name: 'Workspace Filesystem & Git MCP',
      transport: 'stdio',
      endpoint: 'npx @modelcontextprotocol/server-filesystem',
      enabled: true,
      status: 'connected',
      tools_count: 3,
    };
    db.prepare(`INSERT INTO mcp_servers (server_id, user_id, server_json, updated_at_ms) VALUES (?, 1001, ?, ?)`).run(
      seedMcp.server_id,
      JSON.stringify(seedMcp),
      baseTs,
    );

    const sandboxNode: ComputerNodeDto = {
      node_id: 'sandbox:default',
      display_name: 'Cloud Sandbox (Ubuntu 24.04)',
      kind: 'cloud_sandbox',
      tier_badge: '免费',
      host: '100.64.0.1',
      os_name: 'Linux 6.8 x86_64',
      resolution: '1280x720',
      online: true,
      run_policy: 'allow_read_only',
      has_saved_credential: false,
      lease_state: 'idle',
      lease_generation: 1,
      frame_svg_data_url: buildComputerViewportSvg('sandbox:default — Cloud Workbench', 'Ready · Policy: allow_read_only · Generation #1'),
      updated_at_ms: baseTs,
    };
    for (const uid of [1001, 1002, 1003, 1004]) {
      db.prepare(`
        INSERT INTO computer_nodes (node_id, user_id, node_json, encrypted_secret, secret_nonce, updated_at_ms)
        VALUES (?, ?, ?, NULL, NULL, ?)
      `).run(sandboxNode.node_id, uid, JSON.stringify(sandboxNode), baseTs);
    }

    db.prepare(`
      INSERT INTO account_passkeys (cred_id, user_id, label, public_key_b64, created_at_ms, last_used_ms)
      VALUES ('cred_alice_default', 1001, 'Alice MacBook Touch ID', NULL, ?, ?)
    `).run(baseTs, baseTs);

    // Wallet Balances & Seed Transactions
    db.prepare(`INSERT INTO wallet_accounts (user_id, stars_balance, ton_nano, updated_at_ms) VALUES (1001, 2500, 12500000000, ?)`).run(baseTs);
    db.prepare(`INSERT INTO wallet_accounts (user_id, stars_balance, ton_nano, updated_at_ms) VALUES (1002, 1200, 5000000000, ?)`).run(baseTs);
    db.prepare(`INSERT INTO wallet_accounts (user_id, stars_balance, ton_nano, updated_at_ms) VALUES (1003, 800, 2000000000, ?)`).run(baseTs);

    const seedWalletTx: WalletTransactionDto = {
      tx_id: 'tx_seed_welcome',
      kind: 'topup',
      amount_stars: 2500,
      ton_nano_delta: 12_500_000_000,
      description: 'Initial Creator Stars & TON Grant',
      created_at_ms: baseTs,
    };
    db.prepare(`INSERT INTO wallet_transactions (tx_id, user_id, tx_json, created_at_ms) VALUES (?, 1001, ?, ?)`).run(
      seedWalletTx.tx_id,
      JSON.stringify(seedWalletTx),
      baseTs,
    );

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
