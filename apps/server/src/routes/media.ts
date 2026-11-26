import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  E2EE_SAFETY_EMOJIS,
  type CallSessionState,
  type CallSignalPayload,
  type DevicePreKeyBundle,
  type MediaDescriptor,
  type PublishPreKeysRequest,
  type StickerItemDto,
  type StickerSetDto,
  type StoryGroup,
  type StoryItem,
  type TurnCredentialsDto,
} from '@gpui-telegram/protocol';
import type { ServerConfig } from '../config.js';
import {
  createMessageAtomic,
  ensureChatMembership,
  ensureChatWriteAccess,
  getUserProfileDto,
  parseOptionalNonNegativeInt,
  parseOptionalPositiveInt,
} from '../db/queries.js';
import { decodeStandardBase64Strict, sha256Hex } from '../utils/crypto.js';
import {
  ApiError,
  readJsonBody,
  readRawBody,
  readUploadedFileBody,
  requireAuth,
  sendJson,
  type HttpRouter,
  type RequestContext,
} from '../utils/http.js';
import type { RealtimeGatewayHub } from '../ws/hub.js';

function storeCasBlobAndMetadata(
  db: DatabaseSync,
  config: ServerConfig,
  uploaderId: number,
  buffer: Buffer,
  meta: {
    fileName: string;
    mimeType: string;
    width?: number;
    height?: number;
    durationSecs?: number;
    waveform?: number[];
    hasSpoiler?: boolean;
  },
): MediaDescriptor & { id: string; deduplicated: boolean; sha256: string } {
  const sha256 = sha256Hex(buffer);
  const shardDir = path.join(config.mediaDir, sha256.slice(0, 2));
  fs.mkdirSync(shardDir, { recursive: true });
  const storagePath = path.join(shardDir, sha256);

  const alreadyOnDisk = fs.existsSync(storagePath);
  if (!alreadyOnDisk) {
    fs.writeFileSync(storagePath, buffer);
  }

  const existingRow = db
    .prepare(`SELECT file_id FROM media_files WHERE sha256_hex = ? LIMIT 1`)
    .get(sha256) as { file_id: string } | undefined;

  const fileId = `med_${crypto.randomBytes(10).toString('hex')}`;
  const now = Date.now();

  db.prepare(`
    INSERT INTO media_files (
      file_id, sha256_hex, storage_path, file_name, mime_type, size_bytes,
      width, height, duration_secs, waveform_json, has_spoiler, uploader_id, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fileId,
    sha256,
    storagePath,
    meta.fileName || 'file.bin',
    meta.mimeType || 'application/octet-stream',
    buffer.length,
    meta.width ?? null,
    meta.height ?? null,
    meta.durationSecs ?? null,
    meta.waveform ? JSON.stringify(meta.waveform) : null,
    meta.hasSpoiler ? 1 : 0,
    uploaderId,
    now,
  );

  return {
    id: fileId,
    file_id: fileId,
    sha256,
    deduplicated: Boolean(existingRow || alreadyOnDisk),
    file_name: meta.fileName || 'file.bin',
    mime_type: meta.mimeType || 'application/octet-stream',
    size_bytes: buffer.length,
    url: `/api/v1/media/${fileId}`,
    width: meta.width,
    height: meta.height,
    duration_seconds: meta.durationSecs,
    waveform: meta.waveform,
    has_spoiler: meta.hasSpoiler,
  };
}

export function registerMediaStoriesE2eeAndCallRoutes(
  router: HttpRouter,
  db: DatabaseSync,
  config: ServerConfig,
  hub: RealtimeGatewayHub,
): void {
  // 1. Resumable Chunked CAS Media Upload (`init`, `part`, `status`, `complete`) + Single-Shot Upload
  router.post('/api/v1/media/upload/init', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      file_name?: unknown;
      mime_type?: unknown;
      total_size?: unknown;
      size_bytes?: unknown;
      part_size?: unknown;
      expected_sha256?: unknown;
    }>(ctx.req);

    if (body.file_name !== undefined && body.file_name !== null && typeof body.file_name !== 'string') {
      throw new ApiError(400, 'invalid_file_name', 'file_name must be a string');
    }
    if (body.mime_type !== undefined && body.mime_type !== null && typeof body.mime_type !== 'string') {
      throw new ApiError(400, 'invalid_mime_type', 'mime_type must be a string');
    }
    if (
      body.expected_sha256 !== undefined &&
      body.expected_sha256 !== null &&
      typeof body.expected_sha256 !== 'string'
    ) {
      throw new ApiError(400, 'invalid_sha256', 'expected_sha256 must be a string');
    }
    const totalSize =
      parseOptionalNonNegativeInt(
        body.total_size ?? body.size_bytes,
        'invalid_size',
        'total_size must be a non-negative integer',
      ) ?? 0;
    const partSize =
      parseOptionalPositiveInt(
        body.part_size,
        'invalid_part_size',
        'part_size must be a positive integer',
      ) ?? 524_288;
    const totalParts = Math.max(1, Math.ceil(totalSize / partSize));
    const uploadId = `upl_${crypto.randomBytes(10).toString('hex')}`;

    fs.mkdirSync(path.join(config.uploadsDir, uploadId), { recursive: true });

    db.prepare(`
      INSERT INTO media_uploads (
        upload_id, user_id, file_name, mime_type, total_size, part_size, total_parts, expected_sha256, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uploadId,
      auth.userId,
      (typeof body.file_name === 'string' ? body.file_name.trim() : '') || 'upload.bin',
      (typeof body.mime_type === 'string' ? body.mime_type.trim() : '') || 'application/octet-stream',
      totalSize,
      partSize,
      totalParts,
      typeof body.expected_sha256 === 'string' ? body.expected_sha256.toLowerCase() : null,
      Date.now(),
    );

    sendJson(ctx.res, 201, {
      upload_id: uploadId,
      part_size: partSize,
      total_parts: totalParts,
    });
  });

  const handleUploadPart = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const headerUploadId = ctx.req.headers['x-upload-id'];
    const uploadId =
      ctx.params.uploadId ??
      ctx.query.get('upload_id') ??
      (typeof headerUploadId === 'string' ? headerUploadId : '');
    const headerPartIdx = ctx.req.headers['x-part-index'];
    const rawPartIdx =
      ctx.params.partIdx ??
      ctx.query.get('part_index') ??
      ctx.query.get('part') ??
      (typeof headerPartIdx === 'string' ? headerPartIdx : '');
    const partIndex = Number.parseInt(rawPartIdx, 10);

    const session = db
      .prepare(`SELECT * FROM media_uploads WHERE upload_id = ? AND user_id = ?`)
      .get(uploadId, auth.userId) as
      | { upload_id: string; total_parts: number }
      | undefined;
    if (!session) {
      throw new ApiError(404, 'upload_not_found', 'Chunked upload session not found');
    }
    if (!Number.isFinite(partIndex) || partIndex < 0 || partIndex >= Number(session.total_parts)) {
      throw new ApiError(400, 'invalid_part_index', `part_index must be in 0..${Number(session.total_parts) - 1}`);
    }

    const chunk = await readRawBody(ctx.req);
    const dir = path.join(config.uploadsDir, uploadId);
    fs.mkdirSync(dir, { recursive: true });
    const partPath = path.join(dir, `${partIndex}.part`);
    fs.writeFileSync(partPath, chunk);

    db.prepare(`
      INSERT OR REPLACE INTO media_upload_parts (upload_id, part_index, size_bytes, part_path)
      VALUES (?, ?, ?, ?)
    `).run(uploadId, partIndex, chunk.length, partPath);

    sendJson(ctx.res, 200, {
      ok: true,
      upload_id: uploadId,
      part_index: partIndex,
      bytes_written: chunk.length,
      sha256: sha256Hex(chunk),
    });
  };
  router.put('/api/v1/media/upload/:uploadId/part/:partIdx', handleUploadPart);
  router.post('/api/v1/media/upload/:uploadId/part/:partIdx', handleUploadPart);
  router.put('/api/v1/media/upload/:uploadId/:partIdx', handleUploadPart);
  router.post('/api/v1/media/upload/:uploadId/:partIdx', handleUploadPart);
  router.put('/api/v1/media/upload/part', handleUploadPart);
  router.post('/api/v1/media/upload/part', handleUploadPart);

  router.get('/api/v1/media/upload/:uploadId/status', (ctx) => {
    const auth = requireAuth(db, ctx);
    const uploadId = ctx.params.uploadId!;
    const session = db
      .prepare(`SELECT * FROM media_uploads WHERE upload_id = ? AND user_id = ?`)
      .get(uploadId, auth.userId) as { total_parts: number; total_size: number } | undefined;
    if (!session) throw new ApiError(404, 'upload_not_found', 'Upload session not found');

    const partRows = db
      .prepare(`SELECT part_index, size_bytes FROM media_upload_parts WHERE upload_id = ? ORDER BY part_index ASC`)
      .all(uploadId) as Array<{ part_index: number; size_bytes: number }>;

    const uploadedParts = partRows.map((p) => Number(p.part_index));
    const receivedBytes = partRows.reduce((s, p) => s + Number(p.size_bytes), 0);
    sendJson(ctx.res, 200, {
      upload_id: uploadId,
      total_parts: Number(session.total_parts),
      uploaded_parts: uploadedParts,
      received_bytes: receivedBytes,
      complete: uploadedParts.length === Number(session.total_parts),
    });
  });

  const handleCompleteUpload = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      upload_id?: unknown;
      width?: unknown;
      height?: unknown;
      duration_seconds?: unknown;
      waveform?: unknown;
      has_spoiler?: boolean;
      expected_sha256?: unknown;
    }>(ctx.req);
    if (body.upload_id !== undefined && body.upload_id !== null && typeof body.upload_id !== 'string') {
      throw new ApiError(400, 'invalid_upload_id', 'upload_id must be a string');
    }
    if (
      body.expected_sha256 !== undefined &&
      body.expected_sha256 !== null &&
      typeof body.expected_sha256 !== 'string'
    ) {
      throw new ApiError(400, 'invalid_sha256', 'expected_sha256 must be a string');
    }
    const width = parseOptionalNonNegativeInt(
      body.width,
      'invalid_dimensions',
      'width must be a non-negative integer',
    );
    const height = parseOptionalNonNegativeInt(
      body.height,
      'invalid_dimensions',
      'height must be a non-negative integer',
    );
    let durationSecs: number | undefined;
    if (body.duration_seconds !== undefined && body.duration_seconds !== null) {
      if (
        typeof body.duration_seconds !== 'number' ||
        !Number.isFinite(body.duration_seconds) ||
        body.duration_seconds < 0
      ) {
        throw new ApiError(400, 'invalid_duration', 'duration_seconds must be a non-negative number');
      }
      durationSecs = body.duration_seconds;
    }
    let waveform: number[] | undefined;
    if (body.waveform !== undefined && body.waveform !== null) {
      if (
        !Array.isArray(body.waveform) ||
        !body.waveform.every((v) => typeof v === 'number' && Number.isFinite(v))
      ) {
        throw new ApiError(400, 'invalid_waveform', 'waveform must be an array of finite numbers');
      }
      waveform = body.waveform as number[];
    }
    const uploadId =
      ctx.params.uploadId ??
      (typeof body.upload_id === 'string' ? body.upload_id : undefined) ??
      ctx.query.get('upload_id') ??
      '';

    const session = db
      .prepare(`SELECT * FROM media_uploads WHERE upload_id = ? AND user_id = ?`)
      .get(uploadId, auth.userId) as
      | {
          upload_id: string;
          file_name: string;
          mime_type: string;
          total_parts: number;
          expected_sha256: string | null;
        }
      | undefined;
    if (!session) throw new ApiError(404, 'upload_not_found', 'Upload session not found');

    const partRows = db
      .prepare(`SELECT part_index, part_path FROM media_upload_parts WHERE upload_id = ? ORDER BY part_index ASC`)
      .all(uploadId) as Array<{ part_index: number; part_path: string }>;

    if (partRows.length < Number(session.total_parts)) {
      throw new ApiError(
        400,
        'incomplete_parts',
        `Expected ${session.total_parts} parts, received ${partRows.length}`,
      );
    }

    const buffers = partRows.map((p) => fs.readFileSync(p.part_path));
    const fullBuffer = Buffer.concat(buffers);
    const actualSha256 = sha256Hex(fullBuffer);
    const expectedSha = (
      (typeof body.expected_sha256 === 'string' ? body.expected_sha256 : undefined) ??
      session.expected_sha256
    )?.toLowerCase();

    if (expectedSha && expectedSha !== actualSha256) {
      throw new ApiError(400, 'sha256_mismatch', 'Assembled file SHA-256 does not match expected hash');
    }

    const descriptor = storeCasBlobAndMetadata(db, config, auth.userId, fullBuffer, {
      fileName: session.file_name,
      mimeType: session.mime_type,
      width,
      height,
      durationSecs,
      waveform,
      hasSpoiler: Boolean(body.has_spoiler),
    });

    // Clean temporary upload parts
    db.prepare(`DELETE FROM media_upload_parts WHERE upload_id = ?`).run(uploadId);
    db.prepare(`DELETE FROM media_uploads WHERE upload_id = ?`).run(uploadId);
    fs.rmSync(path.join(config.uploadsDir, uploadId), { recursive: true, force: true });

    sendJson(ctx.res, 200, descriptor);
  };
  router.post('/api/v1/media/upload/complete', handleCompleteUpload);
  router.post('/api/v1/media/upload/:uploadId/complete', handleCompleteUpload);

  // Single-shot upload (multipart/form-data OR raw binary)
  router.post('/api/v1/media/upload', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const uploaded = await readUploadedFileBody(ctx.req, ctx.query);
    const rawWidth = ctx.query.get('width');
    const rawHeight = ctx.query.get('height');
    const rawDuration = ctx.query.get('duration') ?? ctx.query.get('duration_seconds');
    const rawWaveformHeader = ctx.req.headers['x-waveform'];
    const rawWaveform =
      ctx.query.get('waveform') ??
      (typeof rawWaveformHeader === 'string' ? rawWaveformHeader : null);

    let durationSecs: number | undefined;
    if (rawDuration !== null && rawDuration.trim() !== '') {
      const parsedDuration = Number(rawDuration);
      if (!Number.isFinite(parsedDuration) || parsedDuration < 0) {
        throw new ApiError(400, 'invalid_duration', 'duration_seconds must be a non-negative number');
      }
      durationSecs = parsedDuration;
    }

    let waveform: number[] | undefined;
    if (rawWaveform !== null && rawWaveform.trim() !== '') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawWaveform);
      } catch {
        throw new ApiError(400, 'invalid_waveform', 'waveform must be a valid JSON array of finite numbers');
      }
      if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === 'number' && Number.isFinite(v))) {
        throw new ApiError(400, 'invalid_waveform', 'waveform must be an array of finite numbers');
      }
      waveform = parsed as number[];
    }

    const descriptor = storeCasBlobAndMetadata(db, config, auth.userId, uploaded.buffer, {
      fileName: uploaded.fileName,
      mimeType: uploaded.mimeType,
      width: rawWidth && Number.isFinite(Number(rawWidth)) ? Number(rawWidth) : undefined,
      height: rawHeight && Number.isFinite(Number(rawHeight)) ? Number(rawHeight) : undefined,
      durationSecs,
      waveform,
      hasSpoiler: ctx.query.get('spoiler') === 'true',
    });
    sendJson(ctx.res, 201, descriptor);
  });

  router.get('/api/v1/media/:fileId/meta', (ctx) => {
    const row = db
      .prepare(`SELECT * FROM media_files WHERE file_id = ?`)
      .get(ctx.params.fileId!) as Record<string, unknown> | undefined;
    if (!row) throw new ApiError(404, 'media_not_found', 'Media file not found');
    sendJson(ctx.res, 200, {
      file_id: row.file_id,
      sha256: row.sha256_hex,
      file_name: row.file_name,
      mime_type: row.mime_type,
      size_bytes: Number(row.size_bytes),
      width: row.width ?? undefined,
      height: row.height ?? undefined,
      duration_seconds: row.duration_secs ?? undefined,
      waveform: row.waveform_json ? JSON.parse(String(row.waveform_json)) : undefined,
      has_spoiler: Boolean(row.has_spoiler),
      url: `/api/v1/media/${row.file_id}`,
    });
  });

  router.post('/api/v1/media/:fileId/transcribe', (ctx) => {
    requireAuth(db, ctx);
    const row = db
      .prepare(`SELECT file_id FROM media_files WHERE file_id = ?`)
      .get(ctx.params.fileId!) as { file_id: string } | undefined;
    if (!row) throw new ApiError(404, 'media_not_found', 'Media file not found');
    throw new ApiError(
      501,
      'transcription_not_configured',
      'Voice transcription service is not configured on this server',
    );
  });

  // 2. HTTP `206 Partial Content` & `416 Range Not Satisfiable` Byte-Range Streaming
  const handleStreamMedia = (ctx: RequestContext): void => {
    const fileId = ctx.params.fileId!;
    const row = db
      .prepare(`SELECT * FROM media_files WHERE file_id = ?`)
      .get(fileId) as Record<string, unknown> | undefined;

    if (!row) {
      throw new ApiError(404, 'media_not_found', `Media ${fileId} not found`);
    }

    const storagePath = String(row.storage_path);
    if (!fs.existsSync(storagePath)) {
      throw new ApiError(404, 'media_blob_missing', 'Underlying CAS blob missing on disk');
    }

    const stat = fs.statSync(storagePath);
    const fileSize = stat.size;
    const mimeType = String(row.mime_type || 'application/octet-stream');
    const lowerMime = mimeType.split(';')[0]!.trim().toLowerCase();
    const isScriptableMime =
      lowerMime === 'text/html' ||
      lowerMime === 'application/xhtml+xml' ||
      lowerMime === 'image/svg+xml' ||
      lowerMime === 'text/xml' ||
      lowerMime === 'application/xml' ||
      lowerMime === 'text/javascript' ||
      lowerMime === 'application/javascript' ||
      lowerMime === 'application/ecmascript' ||
      /\.(?:html?|xhtml|svg|xml|m?js)$/i.test(String(row.file_name || ''));
    const dispositionMode = isScriptableMime ? 'attachment' : 'inline';
    const safeFileName = String(row.file_name || 'file.bin').replace(/["\r\n]/g, '_');

    ctx.res.setHeader('Accept-Ranges', 'bytes');
    ctx.res.setHeader('X-Content-Type-Options', 'nosniff');
    ctx.res.setHeader('Content-Type', isScriptableMime && lowerMime === 'text/html' ? 'text/plain; charset=utf-8' : mimeType);
    ctx.res.setHeader('ETag', `"${row.sha256_hex}"`);
    ctx.res.setHeader('Content-Disposition', `${dispositionMode}; filename="${safeFileName}"`);

    const rangeHeader = ctx.req.headers.range;
    if (!rangeHeader) {
      ctx.res.statusCode = 200;
      ctx.res.setHeader('Content-Length', fileSize);
      if (ctx.method === 'HEAD') {
        ctx.res.end();
        return;
      }
      fs.createReadStream(storagePath).pipe(ctx.res);
      return;
    }

    const rangeMatch = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
    if (!rangeMatch || (rangeMatch[1] === '' && rangeMatch[2] === '') || fileSize === 0) {
      ctx.res.statusCode = 416;
      ctx.res.setHeader('Content-Range', `bytes */${fileSize}`);
      ctx.res.end();
      return;
    }

    let start: number;
    let end: number;

    if (rangeMatch[1] === '') {
      // Suffix byte range: `bytes=-N`
      const suffixLen = Number.parseInt(rangeMatch[2]!, 10);
      if (!Number.isFinite(suffixLen) || suffixLen <= 0) {
        ctx.res.statusCode = 416;
        ctx.res.setHeader('Content-Range', `bytes */${fileSize}`);
        ctx.res.end();
        return;
      }
      start = Math.max(0, fileSize - suffixLen);
      end = fileSize - 1;
    } else {
      start = Number.parseInt(rangeMatch[1]!, 10);
      end = rangeMatch[2] !== '' ? Number.parseInt(rangeMatch[2]!, 10) : fileSize - 1;
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start < 0 ||
        start >= fileSize ||
        start > end
      ) {
        ctx.res.statusCode = 416;
        ctx.res.setHeader('Content-Range', `bytes */${fileSize}`);
        ctx.res.end();
        return;
      }
      end = Math.min(end, fileSize - 1);
    }

    const chunkLength = end - start + 1;
    ctx.res.statusCode = 206;
    ctx.res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    ctx.res.setHeader('Content-Length', chunkLength);

    if (ctx.method === 'HEAD') {
      ctx.res.end();
      return;
    }
    fs.createReadStream(storagePath, { start, end }).pipe(ctx.res);
  };
  router.get('/api/v1/media/download/:fileId', handleStreamMedia);
  router.get('/api/v1/media/stream/:fileId', handleStreamMedia);
  router.get('/api/v1/media/:fileId/stream', handleStreamMedia);
  router.get('/api/v1/media/:fileId', handleStreamMedia);

  // 3. Ephemeral 24h Stories (`list`, `create`, `view`, `delete`)
  router.get('/api/v1/stories', (ctx) => {
    const auth = requireAuth(db, ctx);
    const now = Date.now();
    const rows = db
      .prepare(
        `SELECT s.*, u.username, u.first_name, u.avatar_media_id,
                EXISTS (SELECT 1 FROM story_views v WHERE v.story_id = s.story_id AND v.viewer_user_id = ?) AS viewed_by_me
         FROM stories s
         JOIN users u ON u.user_id = s.user_id
         WHERE s.expires_at_ms > ?
         ORDER BY s.created_at_ms DESC`,
      )
      .all(auth.userId, now) as Array<Record<string, unknown>>;

    const byUser = new Map<number, StoryGroup>();
    const flatStories: StoryItem[] = [];

    for (const r of rows) {
      const uid = Number(r.user_id);
      const item: StoryItem = {
        storyId: String(r.story_id),
        story_id: String(r.story_id),
        userId: uid,
        username: (r.username as string | null) ?? undefined,
        firstName: String(r.first_name),
        mediaId: (r.media_id as string | null) ?? undefined,
        mediaType: String(r.media_type),
        caption: (r.caption as string | null) ?? undefined,
        backgroundGradient: (r.background_gradient as string | null) ?? undefined,
        privacy: String(r.privacy),
        viewsCount: Number(r.views_count),
        isViewed: Boolean(r.viewed_by_me),
        createdAtMs: Number(r.created_at_ms),
        expiresAtMs: Number(r.expires_at_ms),
      };
      flatStories.push(item);

      let group = byUser.get(uid);
      if (!group) {
        group = {
          userId: uid,
          username: item.username,
          firstName: item.firstName,
          avatarMediaId: (r.avatar_media_id as string | null) ?? undefined,
          hasUnviewed: false,
          stories: [],
        };
        byUser.set(uid, group);
      }
      group.stories.push(item);
      if (!item.isViewed) {
        group.hasUnviewed = true;
      }
    }

    sendJson(ctx.res, 200, {
      story_groups: Array.from(byUser.values()),
      stories: flatStories,
    });
  });

  router.post('/api/v1/stories', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      media_id?: unknown;
      media_file_id?: unknown;
      media_type?: unknown;
      caption?: unknown;
      text_overlay?: unknown;
      background_gradient?: unknown;
      privacy?: unknown;
      ttl_secs?: unknown;
      ttl_hours?: unknown;
    }>(ctx.req);

    const readOptionalStoryString = (val: unknown, field: string): string | undefined => {
      if (val === undefined || val === null) {
        return undefined;
      }
      if (typeof val !== 'string') {
        throw new ApiError(400, 'invalid_story', `${field} must be a string`);
      }
      return val;
    };

    const rawMediaId = readOptionalStoryString(body.media_id, 'media_id');
    const rawMediaFileId = readOptionalStoryString(body.media_file_id, 'media_file_id');
    const rawMediaType = readOptionalStoryString(body.media_type, 'media_type');
    const rawCaption = readOptionalStoryString(body.caption, 'caption');
    const rawTextOverlay = readOptionalStoryString(body.text_overlay, 'text_overlay');
    const rawBackgroundGradient = readOptionalStoryString(
      body.background_gradient,
      'background_gradient',
    );
    const rawPrivacy = readOptionalStoryString(body.privacy, 'privacy');

    let ttlSecs = 86_400;
    if (body.ttl_secs !== undefined && body.ttl_secs !== null) {
      if (typeof body.ttl_secs !== 'number' || !Number.isFinite(body.ttl_secs) || body.ttl_secs <= 0) {
        throw new ApiError(400, 'invalid_story', 'ttl_secs must be a positive number');
      }
      ttlSecs = body.ttl_secs;
    } else if (body.ttl_hours !== undefined && body.ttl_hours !== null) {
      if (
        typeof body.ttl_hours !== 'number' ||
        !Number.isFinite(body.ttl_hours) ||
        body.ttl_hours <= 0
      ) {
        throw new ApiError(400, 'invalid_story', 'ttl_hours must be a positive number');
      }
      ttlSecs = body.ttl_hours * 3600;
    }

    const storyId = `story_${crypto.randomBytes(8).toString('hex')}`;
    const now = Date.now();
    const ttlMs = Math.max(60, Math.round(ttlSecs)) * 1000;
    const mediaId = rawMediaId ?? rawMediaFileId ?? null;
    const mediaType = rawMediaType ?? (mediaId ? 'photo' : 'gradient_card');
    const caption = rawCaption ?? rawTextOverlay ?? null;
    const backgroundGradient =
      rawBackgroundGradient ?? 'linear-gradient(135deg, #1084FE, #2B5278)';
    const privacy = rawPrivacy ?? 'everyone';

    db.prepare(`
      INSERT INTO stories (
        story_id, user_id, media_id, media_type, caption, background_gradient,
        privacy, views_count, created_at_ms, expires_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      storyId,
      auth.userId,
      mediaId,
      mediaType,
      caption,
      backgroundGradient,
      privacy,
      now,
      now + ttlMs,
    );

    const user = getUserProfileDto(db, auth.userId);
    const item: StoryItem = {
      storyId,
      story_id: storyId,
      userId: auth.userId,
      username: user?.username,
      firstName: user?.first_name ?? 'User',
      mediaId: mediaId ?? undefined,
      mediaType,
      caption: caption ?? undefined,
      backgroundGradient,
      privacy,
      viewsCount: 0,
      isViewed: false,
      createdAtMs: now,
      expiresAtMs: now + ttlMs,
    };
    sendJson(ctx.res, 201, item);
  });

  router.post('/api/v1/stories/:storyId/view', (ctx) => {
    const auth = requireAuth(db, ctx);
    const storyId = ctx.params.storyId!;
    const exists = db.prepare(`SELECT views_count FROM stories WHERE story_id = ?`).get(storyId) as
      | { views_count: number }
      | undefined;
    if (!exists) throw new ApiError(404, 'story_not_found', 'Story not found');

    const prior = db
      .prepare(`SELECT 1 FROM story_views WHERE story_id = ? AND viewer_user_id = ?`)
      .get(storyId, auth.userId);
    if (!prior) {
      db.prepare(`INSERT INTO story_views (story_id, viewer_user_id, viewed_at_ms) VALUES (?, ?, ?)`).run(
        storyId,
        auth.userId,
        Date.now(),
      );
      db.prepare(`UPDATE stories SET views_count = views_count + 1 WHERE story_id = ?`).run(storyId);
    }

    const updated = db.prepare(`SELECT views_count FROM stories WHERE story_id = ?`).get(storyId) as {
      views_count: number;
    };
    sendJson(ctx.res, 200, { ok: true, views_count: Number(updated.views_count) });
  });

  router.delete('/api/v1/stories/:storyId', (ctx) => {
    const auth = requireAuth(db, ctx);
    db.prepare(`DELETE FROM stories WHERE story_id = ? AND user_id = ?`).run(
      ctx.params.storyId!,
      auth.userId,
    );
    sendJson(ctx.res, 200, { ok: true });
  });

  // 4. Stickers & GIFs
  const handleListStickerSets = (ctx: RequestContext): void => {
    const auth = requireAuth(db, ctx);
    const rows = db.prepare(`SELECT * FROM sticker_sets`).all() as Array<Record<string, unknown>>;
    const sets: StickerSetDto[] = rows.map((r) => {
      const stickers = JSON.parse(String(r.stickers_json)) as StickerItemDto[];
      const userRow = db
        .prepare(`SELECT installed FROM user_sticker_sets WHERE user_id = ? AND set_id = ?`)
        .get(auth.userId, String(r.set_id)) as { installed: number } | undefined;
      return {
        set_id: String(r.set_id),
        short_name: String(r.short_name),
        title: String(r.title),
        count: stickers.length,
        is_installed: userRow ? Boolean(userRow.installed) : Boolean(r.installed_by_default),
        stickers,
      };
    });
    sendJson(ctx.res, 200, { sticker_sets: sets, sets });
  };
  router.get('/api/v1/stickers/sets', handleListStickerSets);
  router.get('/api/v1/stickers', handleListStickerSets);

  router.post('/api/v1/stickers/sets/:setId/install', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{ installed?: boolean }>(ctx.req);
    const installed = body.installed ?? true;
    db.prepare(`
      INSERT OR REPLACE INTO user_sticker_sets (user_id, set_id, installed)
      VALUES (?, ?, ?)
    `).run(auth.userId, ctx.params.setId!, installed ? 1 : 0);
    sendJson(ctx.res, 200, { ok: true, installed });
  });

  const handleSearchGifs = (ctx: RequestContext): void => {
    requireAuth(db, ctx);
    sendJson(ctx.res, 200, { gifs: [], results: [] });
  };
  router.get('/api/v1/gifs/search', handleSearchGifs);
  router.get('/api/v1/gifs/trending', handleSearchGifs);

  // 5. E2EE X3DH PreKey Directory (Cryptographically verified Ed25519 + ECDSA P-256)
  const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
  const P256_SPKI_PREFIX = Buffer.from(
    '3059301306072a8648ce3d020106082a8648ce3d030107034200',
    'hex',
  );

  const decodeE2eeKeyStrict = (raw: unknown, field: string): Buffer => {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new ApiError(400, 'invalid_key_encoding', `${field} must be a non-empty base64 string`);
    }
    try {
      return decodeStandardBase64Strict(raw.trim());
    } catch {
      throw new ApiError(400, 'invalid_key_encoding', `${field} has invalid base64 encoding`);
    }
  };

  router.post('/api/v1/e2ee/prekeys', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<PublishPreKeysRequest>(ctx.req);

    const headerDeviceId =
      typeof ctx.req.headers['x-device-id'] === 'string' ? ctx.req.headers['x-device-id'].trim() : '';
    const deviceId = (typeof body.device_id === 'string' ? body.device_id.trim() : '') || headerDeviceId;
    if (!deviceId || deviceId.length > 128) {
      throw new ApiError(400, 'invalid_device_id', 'device_id must be 1..=128 characters');
    }

    if (!body.signed_prekey || typeof body.signed_prekey !== 'object') {
      throw new ApiError(400, 'invalid_prekeys', 'signed_prekey is required');
    }

    const ikBytes = decodeE2eeKeyStrict(body.identity_key, 'identity_key');
    const signingBytes = decodeE2eeKeyStrict(body.identity_signing_key, 'identity_signing_key');
    const spkPubBytes = decodeE2eeKeyStrict(body.signed_prekey.public_key, 'signed_prekey.public_key');
    const spkSigBytes = decodeE2eeKeyStrict(body.signed_prekey.signature, 'signed_prekey.signature');

    const otpks = Array.isArray(body.one_time_prekeys) ? body.one_time_prekeys : [];
    const otpkBuffers = otpks.map((o, idx) =>
      decodeE2eeKeyStrict(o?.public_key, `one_time_prekeys[${idx}].public_key`),
    );

    if (signingBytes.length === 32) {
      // Upstream Rust contract (`routes/e2ee.rs` & `TEST_INFRA.md` A07): 32B X25519 + 32B Ed25519
      if (
        ikBytes.length !== 32 ||
        spkPubBytes.length !== 32 ||
        spkSigBytes.length !== 64 ||
        otpkBuffers.some((b) => b.length !== 32)
      ) {
        throw new ApiError(
          400,
          'invalid_key_length',
          'Ed25519/X25519 prekey bundle requires 32-byte keys and a 64-byte signature',
        );
      }
      let validSig = false;
      try {
        const pubKey = crypto.createPublicKey({
          key: Buffer.concat([ED25519_SPKI_PREFIX, signingBytes]),
          format: 'der',
          type: 'spki',
        });
        const signedMsg = Buffer.concat([Buffer.from('gpui-e2ee-spk-v1', 'utf8'), spkPubBytes]);
        validSig = crypto.verify(null, signedMsg, pubKey, spkSigBytes);
      } catch {
        validSig = false;
      }
      if (!validSig) {
        throw new ApiError(
          400,
          'invalid_spk_signature',
          'Signed prekey Ed25519 signature verification failed',
        );
      }
    } else if (signingBytes.length === 65 && signingBytes[0] === 0x04) {
      // `@gpui-telegram/protocol` WebCrypto P-256 X3DH contract: 65B uncompressed P-256 keys
      if (
        ikBytes.length !== 65 ||
        ikBytes[0] !== 0x04 ||
        spkPubBytes.length !== 65 ||
        spkPubBytes[0] !== 0x04 ||
        spkSigBytes.length < 64 ||
        otpkBuffers.some((b) => b.length !== 65 || b[0] !== 0x04)
      ) {
        throw new ApiError(
          400,
          'invalid_key_length',
          'P-256 prekey bundle requires 65-byte uncompressed keys and a valid ECDSA signature',
        );
      }
      let validSig = false;
      try {
        const pubKey = crypto.createPublicKey({
          key: Buffer.concat([P256_SPKI_PREFIX, signingBytes]),
          format: 'der',
          type: 'spki',
        });
        const signedMsg = Buffer.concat([
          Buffer.from('gpui-telegram-x3dh-spk-v1', 'utf8'),
          spkPubBytes,
        ]);
        validSig = crypto.verify(
          'sha256',
          signedMsg,
          {
            key: pubKey,
            dsaEncoding: spkSigBytes.length === 64 ? 'ieee-p1363' : 'der',
          },
          spkSigBytes,
        );
      } catch {
        validSig = false;
      }
      if (!validSig) {
        throw new ApiError(
          400,
          'invalid_spk_signature',
          'Signed prekey ECDSA P-256 signature verification failed',
        );
      }
    } else {
      throw new ApiError(
        400,
        'invalid_key_length',
        'identity_signing_key must be 32-byte Ed25519 or 65-byte uncompressed P-256 key',
      );
    }

    const storedBundle: PublishPreKeysRequest = {
      ...body,
      device_id: deviceId,
    };

    const now = Date.now();
    db.prepare(`
      INSERT OR REPLACE INTO e2ee_prekeys (user_id, device_id, bundle_json, updated_at_ms)
      VALUES (?, ?, ?, ?)
    `).run(auth.userId, deviceId, JSON.stringify(storedBundle), now);

    sendJson(ctx.res, 200, {
      success: true,
      user_id: auth.userId,
      device_id: deviceId,
      remaining_one_time_prekeys: otpks.length,
      updated_at_ms: now,
    });
  });

  router.get('/api/v1/e2ee/prekeys/count', (ctx) => {
    const auth = requireAuth(db, ctx);
    const deviceId = ctx.query.get('device_id') ?? 'web-primary';
    const row = db
      .prepare(`SELECT bundle_json FROM e2ee_prekeys WHERE user_id = ? AND device_id = ?`)
      .get(auth.userId, deviceId) as { bundle_json: string } | undefined;

    if (!row) {
      sendJson(ctx.res, 200, {
        user_id: auth.userId,
        device_id: deviceId,
        remaining_one_time_prekeys: 0,
        has_signed_prekey: false,
      });
      return;
    }

    const parsed = JSON.parse(row.bundle_json) as PublishPreKeysRequest;
    sendJson(ctx.res, 200, {
      user_id: auth.userId,
      device_id: deviceId,
      remaining_one_time_prekeys: (parsed.one_time_prekeys ?? []).length,
      has_signed_prekey: Boolean(parsed.signed_prekey),
    });
  });

  const handleGetUserPreKeys = (ctx: RequestContext): void => {
    requireAuth(db, ctx);
    const targetUserId = Number(ctx.params.userId);
    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
      throw new ApiError(400, 'invalid_user_id', 'userId must be a positive integer');
    }
    const targetUser = db
      .prepare(`SELECT user_id FROM users WHERE user_id = ?`)
      .get(targetUserId);
    if (!targetUser) {
      throw new ApiError(404, 'user_not_found', `User ${targetUserId} not found`);
    }

    const deviceFilter = ctx.query.get('device_id')?.trim();
    const rows = (
      deviceFilter
        ? db
            .prepare(`SELECT device_id, bundle_json FROM e2ee_prekeys WHERE user_id = ? AND device_id = ?`)
            .all(targetUserId, deviceFilter)
        : db
            .prepare(`SELECT device_id, bundle_json FROM e2ee_prekeys WHERE user_id = ?`)
            .all(targetUserId)
    ) as Array<{ device_id: string; bundle_json: string }>;

    if (rows.length === 0) {
      throw new ApiError(404, 'prekeys_not_found', 'No E2EE prekey bundles published for user');
    }

    const devices: DevicePreKeyBundle[] = [];
    for (const r of rows) {
      const stored = JSON.parse(r.bundle_json) as PublishPreKeysRequest;
      const otpk = (stored.one_time_prekeys ?? []).shift();
      db.prepare(
        `UPDATE e2ee_prekeys SET bundle_json = ?, updated_at_ms = ? WHERE user_id = ? AND device_id = ?`,
      ).run(JSON.stringify(stored), Date.now(), targetUserId, r.device_id);

      devices.push({
        user_id: targetUserId,
        device_id: stored.device_id,
        device_name: stored.device_name,
        identity_key: stored.identity_key,
        identity_signing_key: stored.identity_signing_key,
        signed_prekey: stored.signed_prekey,
        one_time_prekey: otpk,
      });
    }

    sendJson(ctx.res, 200, { user_id: targetUserId, devices });
  };
  router.get('/api/v1/e2ee/users/:userId/prekeys', handleGetUserPreKeys);
  router.get('/api/v1/e2ee/devices/:userId/prekeys', handleGetUserPreKeys);
  router.get('/api/v1/e2ee/prekeys/:userId', handleGetUserPreKeys);

  router.delete('/api/v1/e2ee/devices/:deviceId', (ctx) => {
    const auth = requireAuth(db, ctx);
    const deviceId = (ctx.params.deviceId ?? '').trim();
    const del = db
      .prepare(`DELETE FROM e2ee_prekeys WHERE user_id = ? AND device_id = ?`)
      .run(auth.userId, deviceId);
    if (Number(del.changes) === 0) {
      throw new ApiError(404, 'device_not_found', 'E2EE device bundle not found');
    }
    sendJson(ctx.res, 200, { revoked: true, device_id: deviceId });
  });

  // 6. WebRTC Calls & Ephemeral HMAC-SHA1 TURN Credentials (signed with `config.turnSecret`)
  const handleTurnCredentials = (ctx: RequestContext): void => {
    const auth = requireAuth(db, ctx);
    const ttlSecs = 3600;
    const expiresAt = Math.floor(Date.now() / 1000) + ttlSecs;
    const username = `${expiresAt}:${auth.userId}`;
    const credential = crypto
      .createHmac('sha1', config.turnSecret)
      .update(username)
      .digest('base64');

    const envUris = (process.env.TURN_URIS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const uris =
      envUris.length > 0
        ? envUris
        : ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];

    const dto: TurnCredentialsDto = {
      username,
      credential,
      uris,
      ttl_seconds: ttlSecs,
      expires_at: expiresAt,
    };
    sendJson(ctx.res, 200, dto);
  };
  router.get('/api/v1/calls/turn-credentials', handleTurnCredentials);
  router.get('/api/v1/rtc/turn-credentials', handleTurnCredentials);
  router.get('/api/v1/webrtc/turn_credentials', handleTurnCredentials);
  router.get('/api/v1/webrtc/turn-credentials', handleTurnCredentials);

  const handleListCalls = (ctx: RequestContext): void => {
    const auth = requireAuth(db, ctx);
    const rawLimit = ctx.query.get('limit');
    const parsedLimit = rawLimit ? Number(rawLimit) : 50;
    const limit =
      Number.isInteger(parsedLimit) && parsedLimit >= 1 && parsedLimit <= 100
        ? parsedLimit
        : 50;
    const filter = (ctx.query.get('filter') ?? 'all').trim().toLowerCase();

    const clauses: string[] = ['(caller_id = ? OR callee_id = ?)'];
    const args: Array<string | number> = [auth.userId, auth.userId];
    if (filter === 'video') {
      clauses.push('is_video = 1');
    } else if (filter === 'missed') {
      clauses.push(`(state = 'failed' OR (state = 'ended' AND duration_secs = 0 AND callee_id = ?))`);
      args.push(auth.userId);
    }

    const rows = db
      .prepare(
        `SELECT * FROM call_sessions WHERE ${clauses.join(' AND ')} ORDER BY started_at_ms DESC LIMIT ?`,
      )
      .all(...args, limit) as Array<Record<string, unknown>>;

    const calls: CallSessionState[] = rows.map((r) => ({
      call_id: String(r.call_id),
      chat_id: r.chat_id ? Number(r.chat_id) : undefined,
      caller_id: Number(r.caller_id),
      callee_id: Number(r.callee_id),
      is_video: Boolean(r.is_video),
      state: r.state as CallSessionState['state'],
      duration_secs: Number(r.duration_secs),
      rating: r.rating ? Number(r.rating) : undefined,
      emoji_fingerprint: r.emoji_fingerprint_json ? (JSON.parse(String(r.emoji_fingerprint_json)) as string[]) : undefined,
      started_at_ms: Number(r.started_at_ms),
      ended_at_ms: r.ended_at_ms ? Number(r.ended_at_ms) : undefined,
    }));
    sendJson(ctx.res, 200, { calls, total: calls.length });
  };
  router.get('/api/v1/calls', handleListCalls);
  router.get('/api/v1/calls/history', handleListCalls);

  const handleStartCall = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<{
      callee_id?: unknown;
      peer_user_id?: unknown;
      chat_id?: unknown;
      is_video?: boolean;
    }>(ctx.req);

    const rawCallee = body.callee_id ?? body.peer_user_id;
    if (
      typeof rawCallee !== 'number' ||
      !Number.isInteger(rawCallee) ||
      rawCallee <= 0 ||
      rawCallee > Number.MAX_SAFE_INTEGER
    ) {
      throw new ApiError(400, 'missing_callee', 'callee_id or peer_user_id is required to start a call');
    }
    const calleeId = rawCallee;
    if (calleeId === auth.userId) {
      throw new ApiError(400, 'cannot_call_self', 'Cannot place a call to yourself');
    }
    const calleeUser = getUserProfileDto(db, calleeId);
    if (!calleeUser) {
      throw new ApiError(404, 'callee_not_found', `Target callee user ${calleeId} not found`);
    }
    const chatId = parseOptionalPositiveInt(
      body.chat_id,
      'invalid_chat_id',
      'chat_id must be a positive integer',
    );
    if (chatId !== undefined) {
      ensureChatWriteAccess(db, chatId, auth.userId);
      ensureChatMembership(db, chatId, calleeId);
    }
    const callId = `call_${crypto.randomBytes(8).toString('hex')}`;
    const now = Date.now();
    const fpHash = crypto.createHash('sha256').update(`call:${callId}:${auth.userId}:${calleeId}`).digest();
    const emojiFp = [0, 1, 2, 3].map((i) => E2EE_SAFETY_EMOJIS[fpHash[i]! % 32]!);

    db.prepare(`
      INSERT INTO call_sessions (
        call_id, chat_id, caller_id, callee_id, is_video, state, duration_secs, emoji_fingerprint_json, started_at_ms
      ) VALUES (?, ?, ?, ?, ?, 'ringing', 0, ?, ?)
    `).run(callId, chatId ?? null, auth.userId, calleeId, body.is_video ? 1 : 0, JSON.stringify(emojiFp), now);

    const session: CallSessionState = {
      call_id: callId,
      chat_id: chatId,
      caller_id: auth.userId,
      callee_id: calleeId,
      is_video: Boolean(body.is_video),
      state: 'ringing',
      duration_secs: 0,
      key_fingerprint: fpHash.subarray(0, 12).toString('hex'),
      emoji_fingerprint: emojiFp,
      started_at_ms: now,
    };

    hub.sendToUser(calleeId, {
      type: 'Update',
      payload: {
        type: 'CallUpdated',
        data: {
          call_id: callId,
          state: 'ringing',
          signal: {
            call_id: callId,
            chat_id: chatId,
            from_user_id: auth.userId,
            target_user_id: calleeId,
            signal_type: 'ringing',
          },
        },
      },
    });

    sendJson(ctx.res, 201, session);
  };
  router.post('/api/v1/calls', handleStartCall);
  router.post('/api/v1/calls/start', handleStartCall);
  router.post('/api/v1/calls/invite', handleStartCall);

  const requireCallParticipant = (callId: string, userId: number): Record<string, unknown> => {
    const row = db.prepare(`SELECT * FROM call_sessions WHERE call_id = ?`).get(callId) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      throw new ApiError(404, 'call_not_found', 'Call session not found');
    }
    if (Number(row.caller_id) !== userId && Number(row.callee_id) !== userId) {
      throw new ApiError(403, 'forbidden', 'You are not a participant of this call');
    }
    return row;
  };

  const handleCallSignal = async (ctx: RequestContext): Promise<void> => {
    const auth = requireAuth(db, ctx);
    const body = await readJsonBody<CallSignalPayload>(ctx.req);
    const rawCallId: unknown = ctx.params.callId ?? body.call_id;
    if (rawCallId !== undefined && rawCallId !== null && typeof rawCallId !== 'string') {
      throw new ApiError(400, 'invalid_call_id', 'call_id must be a string');
    }
    if (
      body.signal_type !== undefined &&
      body.signal_type !== null &&
      typeof body.signal_type !== 'string'
    ) {
      throw new ApiError(400, 'invalid_signal_type', 'signal_type must be a string');
    }
    const sigChatId = parseOptionalPositiveInt(
      body.chat_id,
      'invalid_chat_id',
      'chat_id must be a positive integer',
    );
    const sigTargetUserId = parseOptionalPositiveInt(
      body.target_user_id,
      'invalid_target_user_id',
      'target_user_id must be a positive integer',
    );
    const callId = typeof rawCallId === 'string' ? rawCallId.trim() : '';
    const sig: CallSignalPayload = {
      ...body,
      chat_id: sigChatId,
      target_user_id: sigTargetUserId,
      call_id: callId,
      from_user_id: auth.userId,
    };

    let callRow: Record<string, unknown> | undefined;
    if (callId) {
      callRow = requireCallParticipant(callId, auth.userId);
    }
    if (sigChatId !== undefined) {
      ensureChatWriteAccess(db, sigChatId, auth.userId);
    }

    if (callId && (sig.signal_type === 'accept' || sig.signal_type === 'answer')) {
      if (callRow && String(callRow.state) === 'ended') {
        throw new ApiError(
          409,
          'call_already_ended',
          'Cannot accept or answer an ended call',
        );
      }
      const upd = db
        .prepare(`UPDATE call_sessions SET state = 'active' WHERE call_id = ? AND state != 'ended'`)
        .run(callId);
      if (Number(upd.changes) === 0) {
        throw new ApiError(
          409,
          'call_already_ended',
          'Cannot accept or answer an ended call',
        );
      }
    }

    if (sigTargetUserId !== undefined) {
      hub.sendToUser(sigTargetUserId, {
        type: 'Update',
        payload: { type: 'CallSignal', data: sig },
      });
    } else if (sigChatId !== undefined) {
      hub.broadcastChatEphemeral(sigChatId, { type: 'CallSignal', data: sig }, auth.userId);
    }
    sendJson(ctx.res, 200, { ok: true, call_id: callId || undefined });
  };
  router.post('/api/v1/calls/signal', handleCallSignal);
  router.post('/api/v1/calls/:callId/signal', handleCallSignal);

  router.post('/api/v1/calls/:callId/accept', (ctx) => {
    const auth = requireAuth(db, ctx);
    const callId = ctx.params.callId!;
    const row = requireCallParticipant(callId, auth.userId);
    if (String(row.state) === 'ended') {
      throw new ApiError(409, 'call_already_ended', 'Cannot accept an ended call');
    }
    const upd = db
      .prepare(`UPDATE call_sessions SET state = 'active' WHERE call_id = ? AND state != 'ended'`)
      .run(callId);
    if (Number(upd.changes) === 0) {
      throw new ApiError(409, 'call_already_ended', 'Cannot accept an ended call');
    }
    sendJson(ctx.res, 200, { ok: true, call_id: callId, state: 'active' });
  });

  router.post('/api/v1/calls/:callId/end', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const callId = ctx.params.callId!;
    const body = await readJsonBody<{
      rating?: unknown;
      duration_secs?: unknown;
      comment?: unknown;
    }>(ctx.req);

    let providedDurationSecs: number | undefined;
    if (body.duration_secs !== undefined && body.duration_secs !== null) {
      if (
        typeof body.duration_secs !== 'number' ||
        !Number.isFinite(body.duration_secs) ||
        body.duration_secs < 0
      ) {
        throw new ApiError(400, 'invalid_duration', 'duration_secs must be a non-negative number');
      }
      providedDurationSecs = Math.trunc(body.duration_secs);
    }
    let validatedRating: number | undefined;
    if (body.rating !== undefined && body.rating !== null) {
      if (
        typeof body.rating !== 'number' ||
        !Number.isInteger(body.rating) ||
        body.rating < 1 ||
        body.rating > 5
      ) {
        throw new ApiError(400, 'invalid_rating', 'rating must be an integer between 1 and 5');
      }
      validatedRating = body.rating;
    }
    if (body.comment !== undefined && body.comment !== null && typeof body.comment !== 'string') {
      throw new ApiError(400, 'invalid_comment', 'comment must be a string');
    }

    const row = requireCallParticipant(callId, auth.userId);

    if (row.chat_id !== undefined && row.chat_id !== null) {
      ensureChatWriteAccess(db, Number(row.chat_id), auth.userId);
    }

    const alreadyEnded = String(row.state) === 'ended';
    const now = Date.now();
    const durationSecs = alreadyEnded
      ? Number(row.duration_secs ?? 0)
      : (providedDurationSecs ?? Math.max(1, Math.round((now - Number(row.started_at_ms)) / 1000)));

    if (!alreadyEnded) {
      const updateRes = db
        .prepare(`
          UPDATE call_sessions
          SET state = 'ended', duration_secs = ?, rating = COALESCE(?, rating), ended_at_ms = ?
          WHERE call_id = ? AND state != 'ended'
        `)
        .run(durationSecs, validatedRating ?? null, now, callId);

      if (Number(updateRes.changes) === 1 && row.chat_id !== undefined && row.chat_id !== null) {
        createMessageAtomic(db, hub, {
          chatId: Number(row.chat_id),
          senderId: auth.userId,
          content: {
            type: 'Service',
            data: {
              kind: 'call_ended',
              call_id: callId,
              duration_secs: durationSecs,
              is_video: Boolean(row.is_video),
            },
          },
        });
      }
    } else if (validatedRating !== undefined) {
      db.prepare(`UPDATE call_sessions SET rating = COALESCE(?, rating) WHERE call_id = ?`).run(
        validatedRating,
        callId,
      );
    }

    sendJson(ctx.res, 200, {
      ok: true,
      call_id: callId,
      state: 'ended',
      duration_secs: durationSecs,
      rating:
        validatedRating ??
        (row.rating !== null && row.rating !== undefined ? Number(row.rating) : undefined),
    });
  });

  router.post('/api/v1/calls/:callId/rate', async (ctx) => {
    const auth = requireAuth(db, ctx);
    const callId = ctx.params.callId!;
    requireCallParticipant(callId, auth.userId);
    const body = await readJsonBody<{ rating?: unknown; comment?: unknown }>(ctx.req);
    let rating = 5;
    if (body.rating !== undefined && body.rating !== null) {
      if (
        typeof body.rating !== 'number' ||
        !Number.isInteger(body.rating) ||
        body.rating < 1 ||
        body.rating > 5
      ) {
        throw new ApiError(400, 'invalid_rating', 'rating must be an integer between 1 and 5');
      }
      rating = body.rating;
    }
    if (body.comment !== undefined && body.comment !== null && typeof body.comment !== 'string') {
      throw new ApiError(400, 'invalid_comment', 'comment must be a string');
    }
    db.prepare(`UPDATE call_sessions SET rating = ? WHERE call_id = ?`).run(rating, callId);
    sendJson(ctx.res, 200, { ok: true, rating });
  });
}
