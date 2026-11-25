import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ServerConfig } from '../config.js';
import { ApiError, type HttpRouter, type RequestContext } from '../utils/http.js';

export const DEFAULT_MANIFEST_UPSTREAM_URL =
  'https://github.com/bhrumom/gpui-telegram/releases/latest/download/latest-mac.json';
export const DEFAULT_ASSET_UPSTREAM_BASE =
  'https://github.com/bhrumom/gpui-telegram/releases/download';

const MANIFEST_CACHE_TTL_MS = 60_000;
const MAX_CACHED_TAG_DIRS = 2;

export interface UpdatesRouteOptions {
  manifestUpstreamUrl?: string;
  assetUpstreamBase?: string;
}

/**
 * Validates release tag against upstream `routes/updates.rs` allowlist.
 */
export function isValidReleaseTag(tag: string): boolean {
  if (tag.length < 1 || tag.length > 64) return false;
  if (tag.includes('..') || !/^[A-Za-z0-9._-]+$/.test(tag)) return false;
  return (
    tag.startsWith('v') ||
    tag.startsWith('V') ||
    tag.startsWith('macos-main-') ||
    /^[0-9]/.test(tag)
  );
}

/**
 * Validates release asset filename against upstream `routes/updates.rs` allowlist.
 */
export function isValidReleaseFilename(filename: string): boolean {
  if (filename.length < 1 || filename.length > 128) return false;
  if (
    filename.includes('..') ||
    filename.includes('/') ||
    filename.includes('\\') ||
    !/^[A-Za-z0-9._-]+$/.test(filename)
  ) {
    return false;
  }
  return (
    filename.startsWith('Fabushi-') ||
    filename.startsWith('gpui_telegram') ||
    filename.startsWith('fabushi') ||
    filename === 'latest-mac.json' ||
    filename === 'latest-windows.json' ||
    filename === 'SHA256SUMS' ||
    filename === 'SHA256SUMS-windows.txt'
  );
}

export const RAW_DOT_SEGMENT_OR_TRAVERSAL_RE =
  /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)|(?:%2e|\.){2}|%5c|\\/i;
export const RAW_ENCODED_SLASH_RE = /%2f/i;

/**
 * Extracts and canonicalizes the leading slash of the raw request-target path BEFORE `new URL(...)`,
 * stripping query/fragment and any RFC 9112 §3.2.2 absolute-form `scheme://authority` prefix.
 */
export function extractRawRequestPath(rawUrl: string | undefined): string {
  const beforeQuery = (rawUrl ?? '/').split(/[?#]/, 1)[0] ?? '/';
  const withoutOrigin = beforeQuery.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#\\]*/, '');
  const withLeadingSlash = withoutOrigin.startsWith('/') ? withoutOrigin : `/${withoutOrigin}`;
  return withLeadingSlash.replace(/^\/+/, '/');
}

/**
 * Raw pre-normalization traversal check run BEFORE `new URL(req.url, ...)` so literal `.` / `..`,
 * `%2e`, `%2e%2e`, `%2f`, `%5c`, or `\` in `/api/v1/updates/` (including RFC 9112 absolute-form
 * URIs and pre-`/assets/` dot-segments) strictly yield HTTP 400.
 */
export function hasRawUpdateAssetTraversal(rawUrl: string | undefined): boolean {
  const normalizedRawPath = extractRawRequestPath(rawUrl);
  if (!normalizedRawPath.startsWith('/api/v1/updates/')) {
    return false;
  }
  return (
    RAW_DOT_SEGMENT_OR_TRAVERSAL_RE.test(normalizedRawPath) ||
    RAW_ENCODED_SLASH_RE.test(normalizedRawPath)
  );
}

function pruneOldTagDirectories(cacheRoot: string, keepTag: string): void {
  try {
    if (!fs.existsSync(cacheRoot)) return;
    const entries = fs
      .readdirSync(cacheRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const full = path.join(cacheRoot, d.name);
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(full).mtimeMs;
        } catch {
          mtimeMs = 0;
        }
        return { name: d.name, full, mtimeMs };
      });
    if (entries.length <= MAX_CACHED_TAG_DIRS) return;
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    let kept = 0;
    for (const entry of entries) {
      if (entry.name === keepTag) {
        kept += 1;
        continue;
      }
      if (kept < MAX_CACHED_TAG_DIRS) {
        kept += 1;
      } else {
        fs.rmSync(entry.full, { recursive: true, force: true });
      }
    }
  } catch {
    // Best-effort cache pruning
  }
}

function streamFileWithByteRanges(ctx: RequestContext, filePath: string): void {
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;

  // Never gzip binary release assets (`application/octet-stream`)
  ctx.res.removeHeader('Content-Encoding');
  ctx.res.setHeader('Content-Type', 'application/octet-stream');
  ctx.res.setHeader('Accept-Ranges', 'bytes');
  ctx.res.setHeader('X-Content-Type-Options', 'nosniff');
  ctx.res.setHeader('Cache-Control', 'public, max-age=3600');

  const rangeHeader = ctx.req.headers.range;
  if (!rangeHeader) {
    ctx.res.statusCode = 200;
    ctx.res.setHeader('Content-Length', fileSize);
    if (ctx.method === 'HEAD') {
      ctx.res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(ctx.res);
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
  fs.createReadStream(filePath, { start, end }).pipe(ctx.res);
}

export function registerUpdatesRoutes(
  router: HttpRouter,
  config: ServerConfig,
  options: UpdatesRouteOptions = {},
): void {
  const manifestUrl =
    options.manifestUpstreamUrl?.trim() ||
    process.env.UPDATES_MANIFEST_URL?.trim() ||
    DEFAULT_MANIFEST_UPSTREAM_URL;
  const assetBase = (
    options.assetUpstreamBase?.trim() ||
    process.env.UPDATES_ASSET_BASE_URL?.trim() ||
    DEFAULT_ASSET_UPSTREAM_BASE
  ).replace(/\/+$/, '');
  const userAgent = `Fabushi-Update-Relay/${config.appVersion}`;
  const cacheRoot = path.resolve(path.join(config.dataDir, 'updates_cache'));

  let manifestCache: { fetchedAtMs: number; body: string } | null = null;
  const inflightDownloads = new Map<string, Promise<void>>();

  // 1. Auto-Update Manifest Relay (60s in-memory TTL cache)
  router.get('/api/v1/updates/latest-mac.json', async (ctx: RequestContext) => {
    const now = Date.now();
    if (manifestCache && now - manifestCache.fetchedAtMs < MANIFEST_CACHE_TTL_MS) {
      const buf = Buffer.from(manifestCache.body, 'utf8');
      ctx.res.statusCode = 200;
      ctx.res.setHeader('Content-Type', 'application/json; charset=utf-8');
      ctx.res.setHeader('Cache-Control', 'public, max-age=60');
      ctx.res.setHeader('Content-Length', buf.length);
      if (ctx.method === 'HEAD') {
        ctx.res.end();
        return;
      }
      ctx.res.end(buf);
      return;
    }

    let upRes: Response;
    try {
      upRes = await fetch(manifestUrl, {
        method: 'GET',
        headers: {
          'User-Agent': userAgent,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new ApiError(
        502,
        'upstream_manifest_failed',
        `Failed to fetch release manifest: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!upRes.ok) {
      throw new ApiError(
        502,
        'upstream_manifest_http',
        `Upstream release manifest returned HTTP ${upRes.status}`,
      );
    }

    let bodyText: string;
    try {
      bodyText = await upRes.text();
    } catch {
      throw new ApiError(
        502,
        'upstream_manifest_failed',
        'Upstream release manifest stream terminated unexpectedly',
      );
    }
    try {
      JSON.parse(bodyText);
    } catch {
      throw new ApiError(502, 'upstream_manifest_invalid', 'Upstream release manifest is not valid JSON');
    }

    manifestCache = { fetchedAtMs: Date.now(), body: bodyText };
    const buf = Buffer.from(bodyText, 'utf8');
    ctx.res.statusCode = 200;
    ctx.res.setHeader('Content-Type', 'application/json; charset=utf-8');
    ctx.res.setHeader('Cache-Control', 'public, max-age=60');
    ctx.res.setHeader('Content-Length', buf.length);
    if (ctx.method === 'HEAD') {
      ctx.res.end();
      return;
    }
    ctx.res.end(buf);
  });

  // 2. Release Binary Asset Relay (strict allowlist, atomic disk cache, single-flight, RFC 7233 206 Range)
  router.get('/api/v1/updates/assets/:tag/:filename', async (ctx: RequestContext) => {
    const tag = ctx.params.tag ?? '';
    const filename = ctx.params.filename ?? '';

    if (!isValidReleaseTag(tag) || !isValidReleaseFilename(filename)) {
      throw new ApiError(
        400,
        'invalid_update_asset',
        'Release tag or asset filename is not permitted by update relay allowlist',
      );
    }

    const tagDir = path.resolve(path.join(cacheRoot, tag));
    const cachedPath = path.resolve(path.join(tagDir, filename));
    const rootPrefix = cacheRoot.endsWith(path.sep) ? cacheRoot : `${cacheRoot}${path.sep}`;
    if (!cachedPath.startsWith(rootPrefix)) {
      throw new ApiError(400, 'invalid_update_asset', 'Invalid update asset cache path');
    }

    const hasValidCachedFile = (): boolean => {
      try {
        return fs.existsSync(cachedPath) && fs.statSync(cachedPath).size > 0;
      } catch {
        return false;
      }
    };

    if (!hasValidCachedFile()) {
      const flightKey = `${tag}/${filename}`;
      let downloadPromise = inflightDownloads.get(flightKey);
      if (!downloadPromise) {
        downloadPromise = (async () => {
          fs.mkdirSync(tagDir, { recursive: true });
          const upstreamUrl = `${assetBase}/${encodeURIComponent(tag)}/${encodeURIComponent(filename)}`;
          let upRes: Response;
          try {
            upRes = await fetch(upstreamUrl, {
              method: 'GET',
              headers: {
                'User-Agent': userAgent,
                'Accept-Encoding': 'identity',
              },
              signal: AbortSignal.timeout(45_000),
            });
          } catch (err) {
            throw new ApiError(
              502,
              'upstream_asset_failed',
              `Failed to fetch release asset: ${err instanceof Error ? err.message : String(err)}`,
            );
          }

          if (upRes.status === 404) {
            throw new ApiError(404, 'update_asset_not_found', `Release asset ${flightKey} not found`);
          }
          if (!upRes.ok) {
            throw new ApiError(
              502,
              'upstream_asset_http',
              `Upstream release asset returned HTTP ${upRes.status}`,
            );
          }

          const clHeader = upRes.headers.get('content-length');
          const expectedLen = clHeader !== null && /^\d+$/.test(clHeader) ? Number(clHeader) : null;

          const tmpPath = path.join(tagDir, `${filename}.tmp.${crypto.randomUUID()}`);
          let written = 0;
          try {
            const fd = fs.openSync(tmpPath, 'w');
            try {
              if (upRes.body) {
                const reader = upRes.body.getReader();
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  if (value && value.byteLength > 0) {
                    fs.writeSync(fd, value);
                    written += value.byteLength;
                  }
                }
              } else {
                const buf = Buffer.from(await upRes.arrayBuffer());
                fs.writeSync(fd, buf);
                written = buf.length;
              }
            } finally {
              fs.closeSync(fd);
            }

            if (written === 0 || (expectedLen !== null && written < expectedLen)) {
              fs.rmSync(tmpPath, { force: true });
              throw new ApiError(
                502,
                'upstream_truncated',
                'Upstream release asset download was truncated',
              );
            }

            fs.renameSync(tmpPath, cachedPath);
            pruneOldTagDirectories(cacheRoot, tag);
          } catch (err) {
            fs.rmSync(tmpPath, { force: true });
            if (err instanceof ApiError) {
              throw err;
            }
            throw new ApiError(
              502,
              'upstream_truncated',
              'Upstream update asset stream terminated unexpectedly',
            );
          }
        })().finally(() => {
          inflightDownloads.delete(flightKey);
        });
        inflightDownloads.set(flightKey, downloadPromise);
      }
      await downloadPromise;
    }

    streamFileWithByteRanges(ctx, cachedPath);
  });

  // Catch-all for malformed `/api/v1/updates/assets/*` paths -> strict 400
  router.get('/api/v1/updates/assets/*', () => {
    throw new ApiError(
      400,
      'invalid_update_asset',
      'Invalid update asset path (expected /api/v1/updates/assets/:tag/:filename)',
    );
  });
}
