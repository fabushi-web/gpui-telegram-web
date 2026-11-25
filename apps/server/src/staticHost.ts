import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { shouldCompressContentType } from './utils/http.js';

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

/**
 * Serves compiled `@gpui-telegram/web` production assets from `webDistDir`
 * with path-traversal protection, accurate MIME headers, immutable cache headers
 * for `/assets/*`, and SPA `index.html` fallback for non-API client routes.
 */
export function serveStaticSpa(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  webDistDir: string,
): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return false;
  }

  // Never SPA-fallback unknown API, OAuth, MCP, or Bot API routes
  if (
    pathname.startsWith('/api/') ||
    pathname.startsWith('/v1/') ||
    pathname.startsWith('/.well-known/') ||
    pathname.startsWith('/oauth/') ||
    pathname === '/mcp' ||
    pathname.startsWith('/mcp/') ||
    pathname.startsWith('/bot/') ||
    /^\/bot[^/]+\//.test(pathname)
  ) {
    return false;
  }

  if (!fs.existsSync(webDistDir)) {
    return false;
  }

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'bad_request', message: 'Malformed URI encoding' }));
    return true;
  }

  const resolvedRoot = path.resolve(webDistDir);
  const rootWithSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  const decodedRel = decodedPath.replace(/^\/+/, '');
  const candidatePath = path.resolve(resolvedRoot, decodedRel || 'index.html');

  // Strict path traversal guard (including sibling-directory prefix protection!)
  if (candidatePath !== resolvedRoot && !candidatePath.startsWith(rootWithSep)) {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'forbidden', message: 'Forbidden path traversal' }));
    return true;
  }

  if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
    const ext = path.extname(candidatePath).toLowerCase();
    const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';
    const stat = fs.statSync(candidatePath);
    const acceptsGzip = /\bgzip\b/i.test(String(req.headers['accept-encoding'] ?? ''));
    const useGzip =
      req.method === 'GET' &&
      acceptsGzip &&
      stat.size >= 1024 &&
      shouldCompressContentType(mime);

    res.statusCode = 200;
    res.setHeader('Content-Type', mime);
    if (pathname.startsWith('/assets/')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }

    if (useGzip) {
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      fs.createReadStream(candidatePath).pipe(zlib.createGzip()).pipe(res);
      return true;
    }

    res.setHeader('Content-Length', stat.size);
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    fs.createReadStream(candidatePath).pipe(res);
    return true;
  }

  // If requesting a missing explicit asset file (`.js`, `.css`, `.wasm`, `.png`), return 404 rather than HTML
  const reqExt = path.extname(pathname).toLowerCase();
  if (reqExt && reqExt !== '.html') {
    return false;
  }

  const indexPath = path.join(webDistDir, 'index.html');
  if (fs.existsSync(indexPath)) {
    const stat = fs.statSync(indexPath);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control', 'no-cache');
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    fs.createReadStream(indexPath).pipe(res);
    return true;
  }

  return false;
}
