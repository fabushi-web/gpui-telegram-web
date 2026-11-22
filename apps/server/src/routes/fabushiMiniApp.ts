import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ServerConfig } from '../config.js';
import { createMessageAtomic, getUserProfileDto } from '../db/queries.js';
import { verifyMiniAppInitData } from '../utils/crypto.js';
import {
  ApiError,
  authenticateToken,
  extractBearerToken,
  readJsonBody,
  sendJson,
  type HttpRouter,
  type RequestContext,
} from '../utils/http.js';
import type { RealtimeGatewayHub } from '../ws/hub.js';
import { runConfiguredLlmCompletion } from './magpie.js';

interface FabushiProfileDto {
  user_id: number;
  username: string;
  display_name: string;
  avatar_url: string;
  bio: string;
  user_no: number;
  is_vip: boolean;
  vip_plan: string;
  vip_expires_at: string | null;
  is_admin: boolean;
  locale: string;
  total_transfer_bytes: number;
  total_transfer_count: number;
  total_practice_sessions: number;
  total_practice_minutes: number;
  total_practice_chants: number;
  consecutive_days: number;
  locked_practice_title: string | null;
}

interface FabushiLockedPractice {
  title: string;
  category: string;
  file_path: string;
  selected_at_ms: number;
  is_locked: boolean;
}

interface FabushiPracticeRecordDto {
  id: number;
  sutra_name: string;
  sutra_source: string;
  duration_minutes: number;
  chant_count: number;
  record_date: string;
  local_time: string;
  is_manual: boolean;
  notes: string | null;
  start_time: string | null;
  end_time: string | null;
  created_at: string;
}

interface FabushiPracticeStatsDto {
  today_sutra: string | null;
  today_count: number;
  today_duration_minutes: number;
  total_records: number;
  total_count: number;
  total_duration_minutes: number;
  total_days: number;
  consecutive_days: number;
  by_subject: Array<{
    sutra_name: string;
    count: number;
    duration_minutes: number;
    days: number;
  }>;
}

interface FabushiLeaderboardEntryDto {
  user_id: number;
  username: string;
  display_name: string;
  avatar: string | null;
  total_bytes: number;
  total_bytes_formatted: string;
  total_records: number;
  total_count: number;
  total_duration: number;
  total_days: number;
  latest_sutra: string | null;
  latest_record_date: string | null;
  rank: number;
  follower_count: number;
  following_count: number;
  is_following: boolean;
  is_self: boolean;
}

const ASSET_CONTENT_TYPES: Record<string, string> = {
  'earth_texture.jpg': 'image/jpeg',
  'home_world_lightfield.webp': 'image/webp',
  'zen_room_backdrop_2d.webp': 'image/webp',
  'concap.csv': 'text/csv; charset=utf-8',
  'r2-files-list.json': 'application/json; charset=utf-8',
  'fabushi_miniapp.wasm': 'application/wasm',
};

function formatLeaderboardBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let val = bytes;
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx += 1;
  }
  return idx === 0 ? `${Math.round(val)} B` : `${val.toFixed(2)} ${units[idx]}`;
}

function todayDateStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function nowTimeHm(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function resolveFabushiAuth(
  db: DatabaseSync,
  ctx: RequestContext,
): { userId: number; initUsername?: string; initDisplayName?: string } {
  const rawHeader = ctx.req.headers['x-telegram-init-data'];
  let initDataRaw = typeof rawHeader === 'string' && rawHeader.trim() ? rawHeader.trim() : '';
  if (!initDataRaw) {
    const authHdr = ctx.req.headers.authorization;
    if (typeof authHdr === 'string' && /^tma\s+/i.test(authHdr)) {
      initDataRaw = authHdr.replace(/^tma\s+/i, '').trim();
    }
  }

  if (initDataRaw) {
    const botRows = db
      .prepare(`SELECT bot_token FROM bots_registry ORDER BY CASE WHEN bot_user_id = 777002 THEN 0 ELSE 1 END, created_at_ms ASC`)
      .all() as Array<{ bot_token: string }>;
    for (const row of botRows) {
      const verified = verifyMiniAppInitData(row.bot_token, initDataRaw);
      if (verified.valid && verified.user?.id) {
        const uid = Number(verified.user.id);
        const first = String(verified.user.first_name ?? '').trim();
        const last = String(verified.user.last_name ?? '').trim();
        const uname =
          typeof verified.user.username === 'string' && verified.user.username.trim()
            ? verified.user.username.trim()
            : undefined;
        const display = `${first} ${last}`.trim() || uname || `user_${uid}`;
        return { userId: uid, initUsername: uname, initDisplayName: display };
      }
    }
    throw new ApiError(401, 'invalid_init_data', 'Invalid or expired X-Telegram-Init-Data HMAC signature');
  }

  const bearer = extractBearerToken(ctx.req, ctx.query);
  const session = authenticateToken(db, bearer);
  if (!session) {
    throw new ApiError(401, 'unauthorized', 'Authentication required for Fabushi Mini App API');
  }
  return { userId: session.userId };
}

function mapProfileRow(row: Record<string, unknown>): {
  profile: FabushiProfileDto;
  locked_practice: FabushiLockedPractice | null;
} {
  let locked: FabushiLockedPractice | null = null;
  if (typeof row.locked_practice_json === 'string' && row.locked_practice_json) {
    try {
      locked = JSON.parse(row.locked_practice_json) as FabushiLockedPractice;
    } catch {
      locked = null;
    }
  }
  const profile: FabushiProfileDto = {
    user_id: Number(row.user_id),
    username: String(row.username),
    display_name: String(row.display_name),
    avatar_url: String(row.avatar_url ?? ''),
    bio: String(row.bio ?? ''),
    user_no: Number(row.user_no),
    is_vip: Boolean(row.is_vip),
    vip_plan: String(row.vip_plan ?? 'free'),
    vip_expires_at: row.vip_expires_at ? String(row.vip_expires_at) : null,
    is_admin: Boolean(row.is_admin),
    locale: String(row.locale ?? 'zh-CN'),
    total_transfer_bytes: Number(row.total_transfer_bytes ?? 0),
    total_transfer_count: Number(row.total_transfer_count ?? 0),
    total_practice_sessions: Number(row.total_practice_sessions ?? 0),
    total_practice_minutes: Number(row.total_practice_minutes ?? 0),
    total_practice_chants: Number(row.total_practice_chants ?? 0),
    consecutive_days: Number(row.consecutive_days ?? 0),
    locked_practice_title: locked?.title ?? null,
  };
  return { profile, locked_practice: locked };
}

function ensureFabushiProfile(
  db: DatabaseSync,
  auth: { userId: number; initUsername?: string; initDisplayName?: string },
): { profile: FabushiProfileDto; locked_practice: FabushiLockedPractice | null } {
  const existing = db
    .prepare(`SELECT * FROM fabushi_profiles WHERE user_id = ?`)
    .get(auth.userId) as Record<string, unknown> | undefined;
  if (existing) {
    return mapProfileRow(existing);
  }

  const user = getUserProfileDto(db, auth.userId);
  const username =
    user?.username?.trim() || auth.initUsername || `user_${auth.userId}`;
  const displayName =
    (user
      ? `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim()
      : '') ||
    auth.initDisplayName ||
    username;
  const avatarUrl = user?.avatar_media_id
    ? `/api/v1/media/stream/${user.avatar_media_id}`
    : '';
  const isAdmin =
    username === 'fabushi_official_publisher' || username === 'admin' || auth.userId === 1 ? 1 : 0;
  const userNoRow = db
    .prepare(`SELECT COALESCE(MAX(user_no), 10000) AS mx FROM fabushi_profiles`)
    .get() as { mx: number };
  const userNo = Math.max(10001, Number(userNoRow.mx) + 1);
  const now = Date.now();

  db.prepare(`
    INSERT INTO fabushi_profiles (
      user_id, username, display_name, avatar_url, bio, user_no,
      is_vip, vip_plan, vip_expires_at, is_admin, locale,
      total_transfer_bytes, total_transfer_count, total_practice_sessions,
      total_practice_minutes, total_practice_chants, consecutive_days,
      locked_practice_json, updated_at_ms
    ) VALUES (?, ?, ?, ?, '', ?, 0, 'free', NULL, ?, 'zh-CN', 0, 0, 0, 0, 0, 0, NULL, ?)
  `).run(auth.userId, username, displayName, avatarUrl, userNo, isAdmin, now);

  const created = db
    .prepare(`SELECT * FROM fabushi_profiles WHERE user_id = ?`)
    .get(auth.userId) as Record<string, unknown>;
  return mapProfileRow(created);
}

function listPracticeRecords(db: DatabaseSync, userId: number, limit = 100): FabushiPracticeRecordDto[] {
  const rows = db
    .prepare(
      `SELECT * FROM fabushi_practice_records WHERE user_id = ? ORDER BY record_date DESC, id DESC LIMIT ?`,
    )
    .all(userId, limit) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: Number(r.id),
    sutra_name: String(r.sutra_name),
    sutra_source: String(r.sutra_source ?? 'built_in'),
    duration_minutes: Number(r.duration_minutes ?? 0),
    chant_count: Number(r.chant_count ?? 0),
    record_date: String(r.record_date),
    local_time: String(r.local_time),
    is_manual: Boolean(r.is_manual),
    notes: r.notes ? String(r.notes) : null,
    start_time: r.start_time ? String(r.start_time) : null,
    end_time: r.end_time ? String(r.end_time) : null,
    created_at: String(r.created_at),
  }));
}

function computeConsecutiveDays(datesDesc: string[]): number {
  if (datesDesc.length === 0) return 0;
  const unique = Array.from(new Set(datesDesc)).sort().reverse();
  let streak = 1;
  for (let i = 1; i < unique.length; i += 1) {
    const prev = Date.parse(`${unique[i - 1]}T00:00:00Z`);
    const cur = Date.parse(`${unique[i]}T00:00:00Z`);
    if (Math.round((prev - cur) / 86_400_000) === 1) {
      streak += 1;
    } else {
      break;
    }
  }
  return streak;
}

function recomputeAndSyncPracticeStats(db: DatabaseSync, userId: number): FabushiPracticeStatsDto {
  const records = listPracticeRecords(db, userId, 1000);
  const today = todayDateStr();
  let todaySutra: string | null = null;
  let todayCount = 0;
  let todayDuration = 0;
  let totalCount = 0;
  let totalDuration = 0;
  const daySet = new Set<string>();
  const subjectMap = new Map<string, { count: number; duration: number; days: Set<string> }>();

  for (const rec of records) {
    totalCount += rec.chant_count;
    totalDuration += rec.duration_minutes;
    daySet.add(rec.record_date);
    if (rec.record_date === today) {
      if (!todaySutra) todaySutra = rec.sutra_name;
      todayCount += rec.chant_count;
      todayDuration += rec.duration_minutes;
    }
    const entry = subjectMap.get(rec.sutra_name) ?? { count: 0, duration: 0, days: new Set<string>() };
    entry.count += rec.chant_count;
    entry.duration += rec.duration_minutes;
    entry.days.add(rec.record_date);
    subjectMap.set(rec.sutra_name, entry);
  }

  const consecutiveDays = computeConsecutiveDays(Array.from(daySet));
  db.prepare(`
    UPDATE fabushi_profiles
    SET total_practice_sessions = ?, total_practice_minutes = ?, total_practice_chants = ?,
        consecutive_days = ?, updated_at_ms = ?
    WHERE user_id = ?
  `).run(records.length, totalDuration, totalCount, consecutiveDays, Date.now(), userId);

  return {
    today_sutra: todaySutra,
    today_count: todayCount,
    today_duration_minutes: todayDuration,
    total_records: records.length,
    total_count: totalCount,
    total_duration_minutes: totalDuration,
    total_days: daySet.size,
    consecutive_days: consecutiveDays,
    by_subject: Array.from(subjectMap.entries()).map(([sutra_name, st]) => ({
      sutra_name,
      count: st.count,
      duration_minutes: st.duration,
      days: st.days.size,
    })),
  };
}

function getLeaderboard(
  db: DatabaseSync,
  viewerUserId: number,
  kind: 'global' | 'practice',
  limit = 50,
): FabushiLeaderboardEntryDto[] {
  const orderBy =
    kind === 'practice'
      ? `total_practice_minutes DESC, total_practice_chants DESC, user_id ASC`
      : `total_transfer_bytes DESC, total_transfer_count DESC, user_id ASC`;

  const rows = db
    .prepare(`SELECT * FROM fabushi_profiles ORDER BY ${orderBy} LIMIT ?`)
    .all(limit) as Array<Record<string, unknown>>;

  const followingSet = new Set<number>(
    (
      db
        .prepare(`SELECT target_user_id FROM fabushi_follows WHERE follower_user_id = ?`)
        .all(viewerUserId) as Array<{ target_user_id: number }>
    ).map((r) => Number(r.target_user_id)),
  );

  return rows.map((r, idx) => {
    const uid = Number(r.user_id);
    const totalBytes = Number(r.total_transfer_bytes ?? 0);
    const followerRow = db
      .prepare(`SELECT COUNT(*) AS cnt FROM fabushi_follows WHERE target_user_id = ?`)
      .get(uid) as { cnt: number };
    const followingRow = db
      .prepare(`SELECT COUNT(*) AS cnt FROM fabushi_follows WHERE follower_user_id = ?`)
      .get(uid) as { cnt: number };
    const latestRec = db
      .prepare(
        `SELECT sutra_name, record_date FROM fabushi_practice_records WHERE user_id = ? ORDER BY record_date DESC, id DESC LIMIT 1`,
      )
      .get(uid) as { sutra_name: string; record_date: string } | undefined;
    const daysRow = db
      .prepare(`SELECT COUNT(DISTINCT record_date) AS cnt FROM fabushi_practice_records WHERE user_id = ?`)
      .get(uid) as { cnt: number };

    return {
      user_id: uid,
      username: String(r.username),
      display_name: String(r.display_name),
      avatar: r.avatar_url ? String(r.avatar_url) : null,
      total_bytes: totalBytes,
      total_bytes_formatted: formatLeaderboardBytes(totalBytes),
      total_records: Number(r.total_practice_sessions ?? 0),
      total_count: Number(r.total_practice_chants ?? 0),
      total_duration: Number(r.total_practice_minutes ?? 0),
      total_days: Number(daysRow.cnt ?? 0),
      latest_sutra: latestRec?.sutra_name ?? null,
      latest_record_date: latestRec?.record_date ?? null,
      rank: idx + 1,
      follower_count: Number(followerRow.cnt ?? 0),
      following_count: Number(followingRow.cnt ?? 0),
      is_following: followingSet.has(uid),
      is_self: uid === viewerUserId,
    };
  });
}

function getOnlineCounts(db: DatabaseSync): { globalSending: number; zenRoom: number } {
  const cutoff = Date.now() - 120_000;
  db.prepare(`DELETE FROM fabushi_online_heartbeats WHERE last_seen_ms < ?`).run(cutoff);
  const globalRow = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM fabushi_online_heartbeats WHERE activity_type = 'global_sending'`,
    )
    .get() as { cnt: number };
  const zenRow = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM fabushi_online_heartbeats WHERE activity_type = 'zen_room'`,
    )
    .get() as { cnt: number };
  return {
    globalSending: Number(globalRow.cnt ?? 0),
    zenRoom: Number(zenRow.cnt ?? 0),
  };
}

function computeUnlockedAchievements(profile: FabushiProfileDto): string[] {
  const ids: string[] = [];
  if (profile.total_transfer_count >= 1) ids.push('first_offering');
  if (profile.total_transfer_bytes >= 1024 * 1024) ids.push('dharma_stream_1mb');
  if (profile.total_practice_sessions >= 1) ids.push('first_practice');
  if (profile.total_practice_chants >= 108) ids.push('chants_108');
  if (profile.consecutive_days >= 7) ids.push('streak_7d');
  if (profile.locked_practice_title) ids.push('one_door_deep');
  return ids;
}

function notifyFabushiCompanionChat(
  db: DatabaseSync,
  hub: RealtimeGatewayHub,
  userId: number,
  receiptText: string,
): void {
  const existing = db
    .prepare(
      `SELECT c.chat_id FROM chats c
       JOIN chat_members m1 ON m1.chat_id = c.chat_id AND m1.user_id = ?
       JOIN chat_members m2 ON m2.chat_id = c.chat_id AND m2.user_id = 777002
       WHERE c.chat_type = 0
       LIMIT 1`,
    )
    .get(userId) as { chat_id: number } | undefined;
  if (!existing) return;

  createMessageAtomic(db, hub, {
    chatId: Number(existing.chat_id),
    senderId: 777002,
    text: receiptText,
    inlineKeyboard: [
      [{ text: '🪷 打开 全球法布施', web_app_url: '/miniapps/FabushiBot/fabushi' }],
    ],
  });
}

export function registerFabushiMiniAppRoutes(
  router: HttpRouter,
  db: DatabaseSync,
  config: ServerConfig,
  hub: RealtimeGatewayHub,
): void {
  // 1. Real 833KB Rust-compiled WebAssembly binary (`fabushi_miniapp.wasm`)
  const serveWasm = (ctx: RequestContext): void => {
    const wasmPath = path.join(config.fabushiAssetsDir, 'fabushi_miniapp.wasm');
    if (!fs.existsSync(wasmPath)) {
      throw new ApiError(404, 'wasm_not_found', 'fabushi_miniapp.wasm not found on server');
    }
    const bytes = fs.readFileSync(wasmPath);
    ctx.res.statusCode = 200;
    ctx.res.setHeader('Content-Type', 'application/wasm');
    ctx.res.setHeader('Content-Length', String(bytes.length));
    ctx.res.setHeader('Cache-Control', 'no-cache');
    ctx.res.end(bytes);
  };
  router.get('/api/v1/fabushi-miniapp/app.wasm', serveWasm);
  router.get('/miniapps/fabushi/app.wasm', serveWasm);

  // 2. Real textures & data assets (`earth_texture.jpg`, `home_world_lightfield.webp`, etc.)
  router.get('/api/v1/fabushi-miniapp/assets/:name', (ctx) => {
    const rawName = path.basename(ctx.params.name ?? '');
    const contentType = ASSET_CONTENT_TYPES[rawName];
    if (!contentType) {
      throw new ApiError(404, 'asset_not_found', `Mini App asset "${rawName}" not found`);
    }
    const filePath = path.join(config.fabushiAssetsDir, rawName);
    if (!fs.existsSync(filePath)) {
      throw new ApiError(404, 'asset_not_found', `Mini App asset "${rawName}" missing`);
    }
    const bytes = fs.readFileSync(filePath);
    ctx.res.statusCode = 200;
    ctx.res.setHeader('Content-Type', contentType);
    ctx.res.setHeader('Content-Length', String(bytes.length));
    ctx.res.setHeader('Cache-Control', 'public, max-age=300');
    ctx.res.end(bytes);
  });

  // 3. Bootstrap bundle (`GET /api/v1/fabushi-miniapp/bootstrap`)
  router.get('/api/v1/fabushi-miniapp/bootstrap', (ctx) => {
    const auth = resolveFabushiAuth(db, ctx);
    const { profile, locked_practice } = ensureFabushiProfile(db, auth);
    const practice_stats = recomputeAndSyncPracticeStats(db, auth.userId);
    const refreshed = ensureFabushiProfile(db, auth);
    const practice_records = listPracticeRecords(db, auth.userId, 100);
    const leaderboard = getLeaderboard(db, auth.userId, 'global', 50);
    const practice_leaderboard = getLeaderboard(db, auth.userId, 'practice', 50);
    const online = getOnlineCounts(db);

    sendJson(ctx.res, 200, {
      type: 'bootstrap',
      profile: refreshed.profile,
      locked_practice: refreshed.locked_practice ?? locked_practice,
      leaderboard,
      practice_leaderboard,
      practice_records,
      practice_stats,
      unlocked_achievement_ids: computeUnlockedAchievements(refreshed.profile),
      online_global_sending_count: online.globalSending,
      online_zen_room_count: online.zenRoom,
    });
    void profile;
  });

  // 4. Record Dharma Transfer (`POST /api/v1/fabushi-miniapp/transfer`)
  router.post('/api/v1/fabushi-miniapp/transfer', async (ctx) => {
    const auth = resolveFabushiAuth(db, ctx);
    ensureFabushiProfile(db, auth);
    const body = await readJsonBody<{
      content_title?: string;
      content_kind?: string;
      target_countries?: string[];
      bytes_sent?: number;
      beam_count?: number;
    }>(ctx.req);

    const title = (body.content_title ?? '').trim();
    if (!title) throw new ApiError(400, 'bad_request', 'content_title must not be empty');
    const targets =
      Array.isArray(body.target_countries) && body.target_countries.length > 0
        ? body.target_countries
        : ['ALL'];
    const beams = Math.max(1, Number(body.beam_count ?? targets.length));
    const bytes = Math.max(1024, Number(body.bytes_sent ?? beams * 1024));
    const kind = (body.content_kind ?? 'sutra').trim() || 'sutra';
    const now = Date.now();

    db.prepare(`
      INSERT INTO fabushi_transfers (user_id, content_title, content_kind, target_countries_json, bytes_sent, beam_count, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(auth.userId, title, kind, JSON.stringify(targets), bytes, beams, now);

    db.prepare(`
      UPDATE fabushi_profiles
      SET total_transfer_bytes = total_transfer_bytes + ?,
          total_transfer_count = total_transfer_count + 1,
          updated_at_ms = ?
      WHERE user_id = ?
    `).run(bytes, now, auth.userId);

    const updated = ensureFabushiProfile(db, auth).profile;
    const leaderboard = getLeaderboard(db, auth.userId, 'global', 50);
    const targetLabel =
      targets.includes('ALL') ? '全球所有节点' : targets.slice(0, 4).join(', ');
    notifyFabushiCompanionChat(
      db,
      hub,
      auth.userId,
      `🌍 **全球法布施功德回执**\n• 布施内容：《${title}》\n• 送达节点：${targetLabel}（${beams} 束法光，本次 ${formatLeaderboardBytes(bytes)}）\n• 累计法布施：${formatLeaderboardBytes(updated.total_transfer_bytes)}（共 ${updated.total_transfer_count} 次）`,
    );

    sendJson(ctx.res, 200, {
      type: 'transfer_recorded',
      total_transfer_bytes: updated.total_transfer_bytes,
      total_transfer_count: updated.total_transfer_count,
      leaderboard,
    });
  });

  // 5. Save Zen Room Practice Session (`POST /api/v1/fabushi-miniapp/practice/session`)
  router.post('/api/v1/fabushi-miniapp/practice/session', async (ctx) => {
    const auth = resolveFabushiAuth(db, ctx);
    ensureFabushiProfile(db, auth);
    const body = await readJsonBody<{
      sutra?: string;
      sutra_name?: string;
      duration_minutes?: number;
      chant_count?: number;
      start_time_ms?: number;
      end_time_ms?: number;
      notes?: string | null;
    }>(ctx.req);

    const sutra = (body.sutra ?? body.sutra_name ?? '').trim();
    if (!sutra) throw new ApiError(400, 'bad_request', 'sutra must not be empty');
    const durationMinutes = Math.max(0, Math.trunc(Number(body.duration_minutes ?? 0)));
    const chantCount = Math.max(0, Math.trunc(Number(body.chant_count ?? 0)));
    const nowIso = new Date().toISOString();
    const recDate = todayDateStr();
    const localTime = nowTimeHm();
    const startIso = body.start_time_ms ? new Date(body.start_time_ms).toISOString() : null;
    const endIso = body.end_time_ms ? new Date(body.end_time_ms).toISOString() : null;

    const info = db
      .prepare(`
        INSERT INTO fabushi_practice_records (
          user_id, sutra_name, sutra_source, duration_minutes, chant_count,
          record_date, local_time, is_manual, notes, start_time, end_time, created_at
        ) VALUES (?, ?, 'built_in', ?, ?, ?, ?, 0, ?, ?, ?, ?)
      `)
      .run(
        auth.userId,
        sutra,
        durationMinutes,
        chantCount,
        recDate,
        localTime,
        body.notes?.trim() || null,
        startIso,
        endIso,
        nowIso,
      );

    const practice_stats = recomputeAndSyncPracticeStats(db, auth.userId);
    const profile = ensureFabushiProfile(db, auth).profile;
    const record: FabushiPracticeRecordDto = {
      id: Number(info.lastInsertRowid),
      sutra_name: sutra,
      sutra_source: 'built_in',
      duration_minutes: durationMinutes,
      chant_count: chantCount,
      record_date: recDate,
      local_time: localTime,
      is_manual: false,
      notes: body.notes?.trim() || null,
      start_time: startIso,
      end_time: endIso,
      created_at: nowIso,
    };

    notifyFabushiCompanionChat(
      db,
      hub,
      auth.userId,
      `🪷 **禅室共修功德回执**\n• 修行功课：《${sutra}》\n• 本次记录：诵持 ${chantCount} 遍 · ${durationMinutes} 分钟\n• 累计共修：${profile.total_practice_sessions} 次 · 连续 ${profile.consecutive_days} 天`,
    );

    sendJson(ctx.res, 200, {
      type: 'practice_session_saved',
      record,
      practice_stats,
      profile,
    });
  });

  // 6. Practice Records CRUD (`GET/POST/PUT/DELETE /api/v1/fabushi-miniapp/practice/record*`)
  router.get('/api/v1/fabushi-miniapp/practice/record', (ctx) => {
    const auth = resolveFabushiAuth(db, ctx);
    ensureFabushiProfile(db, auth);
    const practice_records = listPracticeRecords(db, auth.userId, 100);
    const practice_stats = recomputeAndSyncPracticeStats(db, auth.userId);
    sendJson(ctx.res, 200, {
      type: 'practice_records_refreshed',
      practice_records,
      practice_stats,
    });
  });

  router.post('/api/v1/fabushi-miniapp/practice/record', async (ctx) => {
    const auth = resolveFabushiAuth(db, ctx);
    ensureFabushiProfile(db, auth);
    const body = await readJsonBody<{
      sutra_name?: string;
      sutra?: string;
      chant_count?: number;
      duration_minutes?: number;
      record_date?: string;
      local_time?: string;
      notes?: string | null;
    }>(ctx.req);

    const sutra = (body.sutra_name ?? body.sutra ?? '').trim();
    if (!sutra) throw new ApiError(400, 'bad_request', 'sutra_name must not be empty');
    db.prepare(`
      INSERT INTO fabushi_practice_records (
        user_id, sutra_name, sutra_source, duration_minutes, chant_count,
        record_date, local_time, is_manual, notes, created_at
      ) VALUES (?, ?, 'manual', ?, ?, ?, ?, 1, ?, ?)
    `).run(
      auth.userId,
      sutra,
      Math.max(0, Math.trunc(Number(body.duration_minutes ?? 0))),
      Math.max(0, Math.trunc(Number(body.chant_count ?? 1))),
      body.record_date?.trim() || todayDateStr(),
      body.local_time?.trim() || nowTimeHm(),
      body.notes?.trim() || null,
      new Date().toISOString(),
    );

    const practice_stats = recomputeAndSyncPracticeStats(db, auth.userId);
    const practice_records = listPracticeRecords(db, auth.userId, 100);
    sendJson(ctx.res, 200, {
      type: 'practice_records_refreshed',
      practice_records,
      practice_stats,
    });
  });

  const handleUpdateRecord = async (ctx: RequestContext): Promise<void> => {
    const auth = resolveFabushiAuth(db, ctx);
    ensureFabushiProfile(db, auth);
    const body = await readJsonBody<{
      id?: number;
      sutra_name?: string;
      sutra?: string;
      chant_count?: number;
      duration_minutes?: number;
      record_date?: string;
      local_time?: string;
      notes?: string | null;
    }>(ctx.req);
    const recordId = Number(ctx.params.id ?? body.id);
    if (!Number.isInteger(recordId) || recordId <= 0) {
      throw new ApiError(400, 'bad_request', 'record id is required');
    }
    const sutra = (body.sutra_name ?? body.sutra ?? '').trim();
    if (!sutra) throw new ApiError(400, 'bad_request', 'sutra_name must not be empty');

    const res = db
      .prepare(`
        UPDATE fabushi_practice_records
        SET sutra_name = ?, chant_count = ?, duration_minutes = ?, record_date = ?, local_time = ?, notes = ?
        WHERE id = ? AND user_id = ?
      `)
      .run(
        sutra,
        Math.max(0, Math.trunc(Number(body.chant_count ?? 1))),
        Math.max(0, Math.trunc(Number(body.duration_minutes ?? 0))),
        body.record_date?.trim() || todayDateStr(),
        body.local_time?.trim() || nowTimeHm(),
        body.notes?.trim() || null,
        recordId,
        auth.userId,
      );
    if (Number(res.changes) === 0) {
      throw new ApiError(404, 'not_found', 'Practice record not found');
    }
    const practice_stats = recomputeAndSyncPracticeStats(db, auth.userId);
    const practice_records = listPracticeRecords(db, auth.userId, 100);
    sendJson(ctx.res, 200, {
      type: 'practice_records_refreshed',
      practice_records,
      practice_stats,
    });
  };
  router.put('/api/v1/fabushi-miniapp/practice/record', handleUpdateRecord);
  router.put('/api/v1/fabushi-miniapp/practice/record/:id', handleUpdateRecord);

  router.delete('/api/v1/fabushi-miniapp/practice/record/:id', (ctx) => {
    const auth = resolveFabushiAuth(db, ctx);
    ensureFabushiProfile(db, auth);
    const recordId = Number(ctx.params.id);
    const res = db
      .prepare(`DELETE FROM fabushi_practice_records WHERE id = ? AND user_id = ?`)
      .run(recordId, auth.userId);
    if (Number(res.changes) === 0) {
      throw new ApiError(404, 'not_found', 'Practice record not found');
    }
    const practice_stats = recomputeAndSyncPracticeStats(db, auth.userId);
    const practice_records = listPracticeRecords(db, auth.userId, 100);
    sendJson(ctx.res, 200, {
      type: 'practice_records_refreshed',
      practice_records,
      practice_stats,
    });
  });

  // 7. Profile (`GET/PUT /api/v1/fabushi-miniapp/profile`)
  router.get('/api/v1/fabushi-miniapp/profile', (ctx) => {
    const auth = resolveFabushiAuth(db, ctx);
    const { profile, locked_practice } = ensureFabushiProfile(db, auth);
    sendJson(ctx.res, 200, {
      type: 'profile_updated',
      profile,
      locked_practice,
    });
  });

  router.put('/api/v1/fabushi-miniapp/profile', async (ctx) => {
    const auth = resolveFabushiAuth(db, ctx);
    const existing = ensureFabushiProfile(db, auth);
    const body = await readJsonBody<{
      display_name?: string;
      bio?: string;
      locked_practice?: FabushiLockedPractice;
      locale?: string;
    }>(ctx.req);

    const nextDisplayName = body.display_name?.trim() || existing.profile.display_name;
    const nextBio = body.bio !== undefined ? body.bio : existing.profile.bio;
    const nextLocale = body.locale?.trim() || existing.profile.locale;
    // 一门深入: once locked, cannot be overwritten
    const nextLocked = existing.locked_practice ?? body.locked_practice ?? null;

    db.prepare(`
      UPDATE fabushi_profiles
      SET display_name = ?, bio = ?, locale = ?, locked_practice_json = ?, updated_at_ms = ?
      WHERE user_id = ?
    `).run(
      nextDisplayName,
      nextBio,
      nextLocale,
      nextLocked ? JSON.stringify(nextLocked) : null,
      Date.now(),
      auth.userId,
    );

    const refreshed = ensureFabushiProfile(db, auth);
    sendJson(ctx.res, 200, {
      type: 'profile_updated',
      profile: refreshed.profile,
      locked_practice: refreshed.locked_practice,
    });
  });

  // 8. Membership (`POST /api/v1/fabushi-miniapp/membership`)
  router.post('/api/v1/fabushi-miniapp/membership', async (ctx) => {
    const auth = resolveFabushiAuth(db, ctx);
    ensureFabushiProfile(db, auth);
    const body = await readJsonBody<{ plan?: string }>(ctx.req);
    const rawPlan = (body.plan ?? 'yearly').trim().toLowerCase();
    const plan = rawPlan === 'monthly' ? 'monthly' : rawPlan === 'quarterly' ? 'quarterly' : 'yearly';
    const days = plan === 'monthly' ? 30 : plan === 'quarterly' ? 90 : 365;
    const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();

    db.prepare(`
      UPDATE fabushi_profiles
      SET is_vip = 1, vip_plan = ?, vip_expires_at = ?, updated_at_ms = ?
      WHERE user_id = ?
    `).run(plan, expiresAt, Date.now(), auth.userId);

    const refreshed = ensureFabushiProfile(db, auth);
    sendJson(ctx.res, 200, {
      type: 'membership_activated',
      profile: refreshed.profile,
    });
  });

  // 9. Follow toggle (`POST /api/v1/fabushi-miniapp/follow`)
  router.post('/api/v1/fabushi-miniapp/follow', async (ctx) => {
    const auth = resolveFabushiAuth(db, ctx);
    ensureFabushiProfile(db, auth);
    const body = await readJsonBody<{ target_username?: string }>(ctx.req);
    const targetUsername = (body.target_username ?? '').trim().replace(/^@/, '');
    if (!targetUsername) throw new ApiError(400, 'bad_request', 'target_username must not be empty');

    const target = db
      .prepare(`SELECT user_id, username FROM fabushi_profiles WHERE LOWER(username) = LOWER(?)`)
      .get(targetUsername) as { user_id: number; username: string } | undefined;
    if (!target) {
      throw new ApiError(404, 'not_found', `User @${targetUsername} not found`);
    }

    const exists = db
      .prepare(`SELECT 1 FROM fabushi_follows WHERE follower_user_id = ? AND target_user_id = ?`)
      .get(auth.userId, target.user_id);

    let isFollowing: boolean;
    if (exists) {
      db.prepare(`DELETE FROM fabushi_follows WHERE follower_user_id = ? AND target_user_id = ?`).run(
        auth.userId,
        target.user_id,
      );
      isFollowing = false;
    } else {
      db.prepare(
        `INSERT INTO fabushi_follows (follower_user_id, target_user_id, created_at_ms) VALUES (?, ?, ?)`,
      ).run(auth.userId, target.user_id, Date.now());
      isFollowing = true;
    }

    const cntRow = db
      .prepare(`SELECT COUNT(*) AS cnt FROM fabushi_follows WHERE target_user_id = ?`)
      .get(target.user_id) as { cnt: number };

    sendJson(ctx.res, 200, {
      type: 'follow_toggled',
      target_username: target.username,
      is_following: isFollowing,
      follower_count: Number(cntRow.cnt ?? 0),
    });
  });

  // 10. Leaderboard (`GET /api/v1/fabushi-miniapp/leaderboard?kind=global|practice`)
  router.get('/api/v1/fabushi-miniapp/leaderboard', (ctx) => {
    const auth = resolveFabushiAuth(db, ctx);
    ensureFabushiProfile(db, auth);
    const kind = ctx.query.get('kind')?.toLowerCase() === 'practice' ? 'practice' : 'global';
    const limit = Math.max(1, Math.min(100, Number(ctx.query.get('limit') ?? 50)));
    const entries = getLeaderboard(db, auth.userId, kind, limit);
    sendJson(ctx.res, 200, {
      type: 'leaderboard_fetched',
      kind,
      entries,
    });
  });

  // 11. Online Heartbeat (`POST /api/v1/fabushi-miniapp/heartbeat`)
  router.post('/api/v1/fabushi-miniapp/heartbeat', async (ctx) => {
    const auth = resolveFabushiAuth(db, ctx);
    ensureFabushiProfile(db, auth);
    const body = await readJsonBody<{ activity_type?: string }>(ctx.req);
    const activity = body.activity_type === 'zen_room' ? 'zen_room' : 'global_sending';
    db.prepare(`
      INSERT OR REPLACE INTO fabushi_online_heartbeats (user_id, activity_type, last_seen_ms)
      VALUES (?, ?, ?)
    `).run(auth.userId, activity, Date.now());
    const counts = getOnlineCounts(db);
    sendJson(ctx.res, 200, {
      type: 'heartbeat_ack',
      activity_type: activity,
      online_count: activity === 'zen_room' ? counts.zenRoom : counts.globalSending,
    });
  });

  // 12. AI Dharma Chat (`POST /api/v1/fabushi-miniapp/ai-chat`)
  router.post('/api/v1/fabushi-miniapp/ai-chat', async (ctx) => {
    const auth = resolveFabushiAuth(db, ctx);
    const { profile, locked_practice } = ensureFabushiProfile(db, auth);
    const body = await readJsonBody<{
      message?: string;
      prompt?: string;
      history?: Array<{ text: string; is_user: boolean }>;
    }>(ctx.req);

    const question = (body.message ?? body.prompt ?? '').trim();
    if (!question) throw new ApiError(400, 'bad_request', 'message must not be empty');

    const systemPrompt = [
      '你现在是「全球法布施 (@fabushi_bot)」小程序内的慈悲修行助手。请以温和、恭敬、简明、正念的语言回答用户的佛法修行、诵经、禅修与全球法布施问题。切勿编造虚假的实时数据。',
      locked_practice ? `用户当前一门深入的主修功课：《${locked_practice.title}》。` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const llmMessages: Array<{ role: string; content: string }> = [
      { role: 'system', content: systemPrompt },
      ...(body.history ?? []).slice(-6).map((m) => ({
        role: m.is_user ? 'user' : 'assistant',
        content: m.text,
      })),
      { role: 'user', content: question },
    ];

    const completion = await runConfiguredLlmCompletion(db, config, auth.userId, llmMessages);
    if (completion.usedUpstream && completion.text.trim()) {
      sendJson(ctx.res, 200, {
        type: 'ai_chat_reply',
        reply: completion.text.trim(),
      });
      return;
    }

    const fallbackReply =
      profile.locale === 'en'
        ? `No external AI model is configured yet. Open Settings → Magpie LLM Gateway to connect an OpenAI, Anthropic, Gemini, or DeepSeek API key for live Dharma Q&A.`
        : `当前尚未配置外部 AI 模型密钥。请前往「设置 → Magpie 模型网关」配置您的 OpenAI / Anthropic / Gemini / DeepSeek 或兼容接口密钥，即可启用实时修行问答。`;

    sendJson(ctx.res, 200, {
      type: 'ai_chat_reply',
      reply: fallbackReply,
    });
  });
}
