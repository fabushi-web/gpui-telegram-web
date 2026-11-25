import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openSqliteWalDatabase(dataDir: string): DatabaseSync {
  const dbPath = path.join(dataDir, 'telegram.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  initDatabaseSchema(db);
  return db;
}

export function initDatabaseSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY,
      username TEXT UNIQUE,
      first_name TEXT NOT NULL,
      last_name TEXT,
      bio TEXT,
      phone TEXT UNIQUE,
      email TEXT UNIQUE,
      password_salt TEXT,
      password_hash TEXT,
      avatar_media_id TEXT,
      emoji_status TEXT,
      is_bot INTEGER NOT NULL DEFAULT 0,
      is_verified INTEGER NOT NULL DEFAULT 0,
      is_premium INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'recently',
      last_seen_ms INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      auth_version INTEGER NOT NULL DEFAULT 1,
      auth_salt_b64 TEXT,
      auth_kdf_m_kib INTEGER,
      auth_kdf_t_cost INTEGER,
      auth_kdf_p_cost INTEGER,
      account_generation INTEGER NOT NULL DEFAULT 1,
      updated_at_ms INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      session_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      device_name TEXT NOT NULL,
      platform TEXT,
      ip_address TEXT,
      created_at_ms INTEGER NOT NULL,
      last_active_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS otp_challenges (
      challenge_id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      target TEXT NOT NULL,
      code TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      resend_after_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_otp_target ON otp_challenges(channel, target);

    CREATE TABLE IF NOT EXISTS twofa_secrets (
      user_id INTEGER PRIMARY KEY,
      salt_hex TEXT NOT NULL,
      hash_hex TEXT NOT NULL,
      hint TEXT,
      recovery_email TEXT,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS twofa_challenges (
      challenge_token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      device_name TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      expires_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS qr_pair_sessions (
      pair_id TEXT PRIMARY KEY,
      qr_url TEXT NOT NULL,
      svg TEXT NOT NULL,
      device_name TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      approved_user_id INTEGER,
      issued_token TEXT,
      issued_session_id TEXT,
      expires_at_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS alipay_sessions (
      session_id TEXT PRIMARY KEY,
      qr_url TEXT NOT NULL,
      svg TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      approved_user_id INTEGER,
      issued_token TEXT,
      issued_session_id TEXT,
      expires_at_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS passkey_challenges (
      challenge_id TEXT PRIMARY KEY,
      challenge TEXT NOT NULL,
      username TEXT,
      user_id INTEGER,
      purpose TEXT NOT NULL DEFAULT 'auth',
      rp_id TEXT,
      expires_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS account_passkeys (
      cred_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      label TEXT NOT NULL,
      public_key_b64 TEXT,
      cose_alg INTEGER,
      sign_count INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      last_used_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS account_privacy (
      user_id INTEGER PRIMARY KEY,
      settings_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_contacts (
      owner_user_id INTEGER NOT NULL,
      contact_user_id INTEGER NOT NULL,
      first_name TEXT NOT NULL,
      last_name TEXT,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (owner_user_id, contact_user_id)
    );

    CREATE TABLE IF NOT EXISTS user_blocks (
      owner_user_id INTEGER NOT NULL,
      blocked_user_id INTEGER NOT NULL,
      blocked_at_ms INTEGER NOT NULL,
      PRIMARY KEY (owner_user_id, blocked_user_id)
    );

    CREATE TABLE IF NOT EXISTS chats (
      chat_id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      chat_type INTEGER NOT NULL,
      creator_id INTEGER NOT NULL,
      peer_user_id INTEGER,
      username TEXT UNIQUE,
      about TEXT,
      photo_file_id TEXT,
      is_forum INTEGER NOT NULL DEFAULT 0,
      is_verified INTEGER NOT NULL DEFAULT 0,
      pts INTEGER NOT NULL DEFAULT 0,
      next_msg_id INTEGER NOT NULL DEFAULT 1,
      last_message_id INTEGER NOT NULL DEFAULT 0,
      last_message_date_ms INTEGER NOT NULL DEFAULT 0,
      last_message_preview TEXT,
      last_message_media_type TEXT,
      ttl_seconds INTEGER NOT NULL DEFAULT 0,
      slow_mode_seconds INTEGER NOT NULL DEFAULT 0,
      emoji_fingerprint_json TEXT,
      created_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_members (
      chat_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      admin_rights INTEGER NOT NULL DEFAULT 0,
      banned_rights INTEGER NOT NULL DEFAULT 0,
      custom_title TEXT,
      joined_at_ms INTEGER NOT NULL,
      PRIMARY KEY (chat_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS user_chat_settings (
      user_id INTEGER NOT NULL,
      chat_id INTEGER NOT NULL,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      is_muted INTEGER NOT NULL DEFAULT 0,
      mute_until_ms INTEGER,
      unread_mark INTEGER NOT NULL DEFAULT 0,
      folder_id INTEGER,
      draft_json TEXT,
      read_inbox_max_id INTEGER NOT NULL DEFAULT 0,
      read_outbox_max_id INTEGER NOT NULL DEFAULT 0,
      send_as_peer_id INTEGER,
      cleared_up_to_msg_id INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, chat_id)
    );

    CREATE TABLE IF NOT EXISTS chat_folders (
      user_id INTEGER NOT NULL,
      folder_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      emoticon TEXT,
      folder_json TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, folder_id)
    );

    CREATE TABLE IF NOT EXISTS forum_topics (
      chat_id INTEGER NOT NULL,
      topic_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      icon_color INTEGER NOT NULL DEFAULT 3379436,
      icon_emoji TEXT,
      creator_id INTEGER NOT NULL,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      is_closed INTEGER NOT NULL DEFAULT 0,
      is_hidden INTEGER NOT NULL DEFAULT 0,
      last_message_id INTEGER,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (chat_id, topic_id)
    );

    CREATE TABLE IF NOT EXISTS chat_invite_links (
      code TEXT PRIMARY KEY,
      invite_id TEXT NOT NULL,
      chat_id INTEGER NOT NULL,
      creator_id INTEGER NOT NULL,
      title TEXT,
      usage_limit INTEGER,
      usage_count INTEGER NOT NULL DEFAULT 0,
      expire_date_ms INTEGER,
      request_needed INTEGER NOT NULL DEFAULT 0,
      is_revoked INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      chat_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      sender_id INTEGER NOT NULL,
      send_as_peer_id INTEGER,
      topic_id INTEGER,
      date_ms INTEGER NOT NULL,
      edit_date_ms INTEGER,
      text_plain TEXT NOT NULL DEFAULT '',
      media_type TEXT,
      content_json TEXT NOT NULL,
      entities_json TEXT NOT NULL DEFAULT '[]',
      reply_to_json TEXT,
      forward_info_json TEXT,
      inline_keyboard_json TEXT,
      web_page_json TEXT,
      flags_json TEXT NOT NULL,
      views INTEGER NOT NULL DEFAULT 1,
      forwards INTEGER NOT NULL DEFAULT 0,
      ttl_seconds INTEGER,
      expires_at_ms INTEGER,
      deleted_for_everyone INTEGER NOT NULL DEFAULT 0,
      client_nonce INTEGER,
      PRIMARY KEY (chat_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat_date ON messages(chat_id, date_ms);

    CREATE TABLE IF NOT EXISTS message_user_deletions (
      user_id INTEGER NOT NULL,
      chat_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      PRIMARY KEY (user_id, chat_id, message_id)
    );

    CREATE TABLE IF NOT EXISTS message_reactions (
      chat_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      emoji TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (chat_id, message_id, user_id, emoji)
    );

    CREATE TABLE IF NOT EXISTS pinned_messages (
      chat_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      topic_id INTEGER NOT NULL DEFAULT 0,
      pinned_by INTEGER NOT NULL,
      pinned_at_ms INTEGER NOT NULL,
      PRIMARY KEY (chat_id, message_id)
    );

    CREATE TABLE IF NOT EXISTS outbox_dedup (
      user_id INTEGER NOT NULL,
      client_nonce INTEGER NOT NULL,
      chat_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      pts INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (user_id, client_nonce)
    );

    CREATE TABLE IF NOT EXISTS pts_events (
      chat_id INTEGER NOT NULL,
      pts INTEGER NOT NULL,
      pts_count INTEGER NOT NULL DEFAULT 1,
      created_at_ms INTEGER NOT NULL,
      event_json TEXT NOT NULL,
      PRIMARY KEY (chat_id, pts)
    );

    CREATE TABLE IF NOT EXISTS polls (
      poll_id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      creator_id INTEGER NOT NULL,
      poll_json TEXT NOT NULL,
      is_closed INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS poll_votes (
      poll_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      option_ids_json TEXT NOT NULL,
      voted_at_ms INTEGER NOT NULL,
      PRIMARY KEY (poll_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS media_files (
      file_id TEXT PRIMARY KEY,
      sha256_hex TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      width INTEGER,
      height INTEGER,
      duration_secs REAL,
      waveform_json TEXT,
      has_spoiler INTEGER NOT NULL DEFAULT 0,
      uploader_id INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_media_sha256 ON media_files(sha256_hex);

    CREATE TABLE IF NOT EXISTS media_uploads (
      upload_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      total_size INTEGER NOT NULL,
      part_size INTEGER NOT NULL,
      total_parts INTEGER NOT NULL,
      expected_sha256 TEXT,
      created_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS media_upload_parts (
      upload_id TEXT NOT NULL,
      part_index INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      part_path TEXT NOT NULL,
      PRIMARY KEY (upload_id, part_index)
    );

    CREATE TABLE IF NOT EXISTS stories (
      story_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      media_id TEXT,
      media_type TEXT NOT NULL,
      caption TEXT,
      background_gradient TEXT,
      privacy TEXT NOT NULL DEFAULT 'everyone',
      views_count INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS story_views (
      story_id TEXT NOT NULL,
      viewer_user_id INTEGER NOT NULL,
      viewed_at_ms INTEGER NOT NULL,
      PRIMARY KEY (story_id, viewer_user_id)
    );

    CREATE TABLE IF NOT EXISTS sticker_sets (
      set_id TEXT PRIMARY KEY,
      short_name TEXT NOT NULL,
      title TEXT NOT NULL,
      stickers_json TEXT NOT NULL,
      installed_by_default INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS user_sticker_sets (
      user_id INTEGER NOT NULL,
      set_id TEXT NOT NULL,
      installed INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (user_id, set_id)
    );

    CREATE TABLE IF NOT EXISTS e2ee_prekeys (
      user_id INTEGER NOT NULL,
      device_id TEXT NOT NULL,
      bundle_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (user_id, device_id)
    );

    CREATE TABLE IF NOT EXISTS call_sessions (
      call_id TEXT PRIMARY KEY,
      chat_id INTEGER,
      caller_id INTEGER NOT NULL,
      callee_id INTEGER NOT NULL,
      is_video INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL,
      duration_secs INTEGER NOT NULL DEFAULT 0,
      rating INTEGER,
      emoji_fingerprint_json TEXT,
      started_at_ms INTEGER NOT NULL,
      ended_at_ms INTEGER
    );

    CREATE TABLE IF NOT EXISTS bots_registry (
      bot_user_id INTEGER PRIMARY KEY,
      owner_user_id INTEGER NOT NULL,
      bot_token TEXT NOT NULL UNIQUE,
      bot_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS botfather_wizards (
      user_id INTEGER PRIMARY KEY,
      step TEXT NOT NULL,
      draft_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bot_api_updates (
      update_id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_user_id INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mini_apps (
      app_id TEXT PRIMARY KEY,
      bot_user_id INTEGER NOT NULL,
      bot_username TEXT NOT NULL,
      short_name TEXT NOT NULL,
      app_json TEXT NOT NULL,
      html_bundle TEXT,
      created_at_ms INTEGER NOT NULL,
      UNIQUE (bot_username, short_name)
    );

    CREATE TABLE IF NOT EXISTS mini_app_installs (
      user_id INTEGER NOT NULL,
      app_id TEXT NOT NULL,
      companion_chat_id INTEGER,
      installed_at_ms INTEGER NOT NULL,
      PRIMARY KEY (user_id, app_id)
    );

    CREATE TABLE IF NOT EXISTS mini_app_cloud_storage (
      user_id INTEGER NOT NULL,
      scope_key TEXT NOT NULL,
      item_key TEXT NOT NULL,
      item_value TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (user_id, scope_key, item_key)
    );

    CREATE TABLE IF NOT EXISTS fabushi_state (
      user_id INTEGER PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS hermes_sessions (
      session_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      parent_session_id TEXT,
      chat_id INTEGER,
      bot_id INTEGER,
      title TEXT NOT NULL,
      source TEXT NOT NULL,
      model TEXT NOT NULL,
      messages_json TEXT NOT NULL,
      checkpoints_json TEXT NOT NULL DEFAULT '[]',
      total_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS hermes_turns (
      turn_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      events_json TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS hermes_kv (
      user_id INTEGER NOT NULL,
      kv_key TEXT NOT NULL,
      kv_value TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (user_id, kv_key)
    );

    CREATE TABLE IF NOT EXISTS hermes_skills (
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      skill_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (user_id, name)
    );

    CREATE TABLE IF NOT EXISTS hermes_approvals (
      approval_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      approval_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS hermes_cron_jobs (
      job_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      job_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS hermes_kanban_boards (
      board_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      board_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS magpie_providers (
      user_id INTEGER NOT NULL,
      provider_id TEXT NOT NULL,
      provider_json TEXT NOT NULL,
      encrypted_api_key TEXT,
      key_nonce TEXT,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (user_id, provider_id)
    );

    CREATE TABLE IF NOT EXISTS magpie_state (
      user_id INTEGER PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS magpie_usage_ledger (
      entry_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL,
      completion_tokens INTEGER NOT NULL,
      masked_hits INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      task_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      task_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mcp_servers (
      server_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      server_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mcp_approvals (
      request_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      approval_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS talk_sessions (
      user_id INTEGER PRIMARY KEY,
      session_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS computer_nodes (
      node_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      node_json TEXT NOT NULL,
      encrypted_secret TEXT,
      secret_nonce TEXT,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (user_id, node_id)
    );

    CREATE TABLE IF NOT EXISTS computer_commands (
      command_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      node_id TEXT NOT NULL,
      cmd_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tailnet_peers (
      user_id INTEGER NOT NULL,
      device_id TEXT NOT NULL,
      peer_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (user_id, device_id)
    );

    CREATE TABLE IF NOT EXISTS wallet_accounts (
      user_id INTEGER PRIMARY KEY,
      stars_balance INTEGER NOT NULL DEFAULT 0,
      ton_nano INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wallet_transactions (
      tx_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      tx_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wallet_idempotency (
      user_id INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (user_id, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS fabushi_profiles (
      user_id INTEGER PRIMARY KEY,
      username TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar_url TEXT NOT NULL DEFAULT '',
      bio TEXT NOT NULL DEFAULT '',
      user_no INTEGER NOT NULL,
      is_vip INTEGER NOT NULL DEFAULT 0,
      vip_plan TEXT NOT NULL DEFAULT 'free',
      vip_expires_at TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      locale TEXT NOT NULL DEFAULT 'zh-CN',
      total_transfer_bytes INTEGER NOT NULL DEFAULT 0,
      total_transfer_count INTEGER NOT NULL DEFAULT 0,
      total_practice_sessions INTEGER NOT NULL DEFAULT 0,
      total_practice_minutes INTEGER NOT NULL DEFAULT 0,
      total_practice_chants INTEGER NOT NULL DEFAULT 0,
      consecutive_days INTEGER NOT NULL DEFAULT 0,
      locked_practice_json TEXT,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fabushi_practice_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      sutra_name TEXT NOT NULL,
      sutra_source TEXT NOT NULL DEFAULT 'built_in',
      duration_minutes INTEGER NOT NULL DEFAULT 0,
      chant_count INTEGER NOT NULL DEFAULT 0,
      record_date TEXT NOT NULL,
      local_time TEXT NOT NULL,
      is_manual INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      start_time TEXT,
      end_time TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fabushi_practice_user ON fabushi_practice_records(user_id, record_date DESC, id DESC);

    CREATE TABLE IF NOT EXISTS fabushi_transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      content_title TEXT NOT NULL,
      content_kind TEXT NOT NULL DEFAULT 'sutra',
      target_countries_json TEXT NOT NULL DEFAULT '["ALL"]',
      bytes_sent INTEGER NOT NULL DEFAULT 0,
      beam_count INTEGER NOT NULL DEFAULT 1,
      created_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fabushi_follows (
      follower_user_id INTEGER NOT NULL,
      target_user_id INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (follower_user_id, target_user_id)
    );

    CREATE TABLE IF NOT EXISTS fabushi_online_heartbeats (
      user_id INTEGER NOT NULL,
      activity_type TEXT NOT NULL,
      last_seen_ms INTEGER NOT NULL,
      PRIMARY KEY (user_id, activity_type)
    );

    CREATE TABLE IF NOT EXISTS user_vault_envelopes (
      user_id INTEGER PRIMARY KEY,
      key_version INTEGER NOT NULL,
      kdf_alg TEXT NOT NULL,
      kdf_salt_b64 TEXT NOT NULL,
      kdf_m_cost_kib INTEGER NOT NULL,
      kdf_t_cost INTEGER NOT NULL,
      kdf_p_cost INTEGER NOT NULL,
      wrapped_root_key_b64 TEXT NOT NULL,
      recovery_wrapped_root_key_b64 TEXT,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_vault_items (
      user_id INTEGER NOT NULL,
      category TEXT NOT NULL,
      item_key TEXT NOT NULL,
      revision INTEGER NOT NULL,
      nonce_b64 TEXT NOT NULL,
      ciphertext_b64 TEXT NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (user_id, category, item_key)
    );
    CREATE INDEX IF NOT EXISTS idx_user_vault_items_user_rev
      ON user_vault_items(user_id, revision);

    CREATE TABLE IF NOT EXISTS vault_device_sync_requests (
      request_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      device_name TEXT NOT NULL,
      device_public_key_b64 TEXT NOT NULL,
      verification_code TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      approver_ephemeral_pub_b64 TEXT,
      encrypted_root_key_b64 TEXT,
      nonce_b64 TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_vault_device_sync_user_status
      ON vault_device_sync_requests(user_id, status, expires_at);

    CREATE TABLE IF NOT EXISTS chat_create_nonces (
      creator_user_id INTEGER NOT NULL,
      client_nonce TEXT NOT NULL,
      chat_id INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (creator_user_id, client_nonce)
    );

    CREATE TABLE IF NOT EXISTS archive_bot_dedup (
      caller_user_id INTEGER NOT NULL,
      chat_id INTEGER NOT NULL,
      bot_user_id INTEGER NOT NULL,
      client_nonce INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      pts INTEGER NOT NULL,
      date_ms INTEGER NOT NULL,
      PRIMARY KEY (caller_user_id, chat_id, bot_user_id, client_nonce)
    );
  `);

  // Safe idempotent column migrations for existing SQLite databases
  const ensureColumn = (table: string, column: string, definition: string): void => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
    }
  };

  ensureColumn('alipay_sessions', 'upstream_attempt_id', 'TEXT');
  ensureColumn('users', 'auth_version', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn('users', 'auth_salt_b64', 'TEXT');
  ensureColumn('users', 'auth_kdf_m_kib', 'INTEGER');
  ensureColumn('users', 'auth_kdf_t_cost', 'INTEGER');
  ensureColumn('users', 'auth_kdf_p_cost', 'INTEGER');
  ensureColumn('users', 'account_generation', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn('users', 'updated_at_ms', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('passkey_challenges', 'user_id', 'INTEGER');
  ensureColumn('passkey_challenges', 'purpose', "TEXT NOT NULL DEFAULT 'auth'");
  ensureColumn('passkey_challenges', 'rp_id', 'TEXT');
  ensureColumn('account_passkeys', 'cose_alg', 'INTEGER');
  ensureColumn('account_passkeys', 'sign_count', 'INTEGER NOT NULL DEFAULT 0');
}
