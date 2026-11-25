import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';
import { sha256Hex } from './crypto.js';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    extra?: Record<string, unknown>,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function safeDecodeURIComponent(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new ApiError(400, 'bad_request', 'Malformed URI encoding');
  }
}

export interface AuthSessionContext {
  userId: number;
  sessionId: string;
  rawToken: string;
  tokenHash: string;
  username: string;
}

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  url: URL;
  pathname: string;
  query: URLSearchParams;
  params: Record<string, string>;
}

export type RouteHandler = (ctx: RequestContext) => Promise<void> | void;

interface CompiledRoute {
  method: string;
  regex: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

export class HttpRouter {
  private readonly routes: CompiledRoute[] = [];

  register(method: string, pattern: string, handler: RouteHandler): void {
    const paramNames: string[] = [];
    const regexStr =
      '^' +
      pattern
        .replace(/\/+$/, '')
        .split('/')
        .map((seg) => {
          if (seg === '*') {
            paramNames.push('wildcard');
            return '(.*)';
          }
          const colonIdx = seg.indexOf(':');
          if (colonIdx !== -1) {
            const prefix = seg.slice(0, colonIdx).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            paramNames.push(seg.slice(colonIdx + 1));
            return `${prefix}([^/]+)`;
          }
          return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('/') +
      '/?$';

    this.routes.push({
      method: method.toUpperCase(),
      regex: new RegExp(regexStr),
      paramNames,
      handler,
    });
  }

  get(pattern: string, handler: RouteHandler): void {
    this.register('GET', pattern, handler);
  }

  post(pattern: string, handler: RouteHandler): void {
    this.register('POST', pattern, handler);
  }

  put(pattern: string, handler: RouteHandler): void {
    this.register('PUT', pattern, handler);
  }

  patch(pattern: string, handler: RouteHandler): void {
    this.register('PATCH', pattern, handler);
  }

  delete(pattern: string, handler: RouteHandler): void {
    this.register('DELETE', pattern, handler);
  }

  match(
    method: string,
    pathname: string,
  ): { handler: RouteHandler; params: Record<string, string> } | null {
    const upperMethod = method.toUpperCase();
    const normalizedPath = pathname === '/' ? '/' : pathname.replace(/\/+$/, '');
    for (const route of this.routes) {
      if (route.method !== upperMethod && !(upperMethod === 'HEAD' && route.method === 'GET')) {
        continue;
      }
      const m = route.regex.exec(normalizedPath);
      if (m) {
        const params: Record<string, string> = {};
        route.paramNames.forEach((name, idx) => {
          params[name] = safeDecodeURIComponent(m[idx + 1] ?? '');
        });
        return { handler: route.handler, params };
      }
    }
    return null;
  }
}

const responseAcceptsGzip = new WeakMap<ServerResponse, boolean>();

export function shouldCompressContentType(contentType: string): boolean {
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!mime) return false;
  if (
    mime === 'text/event-stream' ||
    mime === 'application/octet-stream' ||
    mime === 'application/wasm' ||
    mime.startsWith('audio/') ||
    mime.startsWith('video/')
  ) {
    return false;
  }
  if (mime.startsWith('image/')) {
    return mime === 'image/svg+xml';
  }
  return (
    mime === 'application/json' ||
    mime === 'application/javascript' ||
    mime === 'application/manifest+json' ||
    mime === 'application/xhtml+xml' ||
    mime.startsWith('text/')
  );
}

export function markResponseAcceptsGzip(req: IncomingMessage, res: ServerResponse): void {
  const acceptEncoding = String(req.headers['accept-encoding'] ?? '');
  responseAcceptsGzip.set(res, /\bgzip\b/i.test(acceptEncoding));
}

export function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD',
  );
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Telegram-Init-Data, X-Device-Id, X-File-Name, Idempotency-Key, Range, X-Desktop-Browser-Token, Mcp-Session-Id, Mcp-Protocol-Version',
  );
  res.setHeader(
    'Access-Control-Expose-Headers',
    'Content-Range, Accept-Ranges, Content-Length, Content-Disposition, Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate',
  );
}

export function sendText(
  res: ServerResponse,
  status: number,
  text: string,
  contentType = 'text/plain; charset=utf-8',
): void {
  if (res.writableEnded) return;
  const rawBuf = Buffer.from(text, 'utf8');
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', rawBuf.length);
  res.end(rawBuf);
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.writableEnded) return;
  const rawBuf = Buffer.from(JSON.stringify(payload), 'utf8');
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (
    responseAcceptsGzip.get(res) &&
    rawBuf.length >= 1024 &&
    shouldCompressContentType('application/json')
  ) {
    const gz = zlib.gzipSync(rawBuf);
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('Content-Length', gz.length);
    res.end(gz);
    return;
  }
  res.setHeader('Content-Length', rawBuf.length);
  res.end(rawBuf);
}

export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): void {
  sendJson(res, status, {
    error: code,
    message,
    ...extra,
  });
}

export async function readRawBody(req: IncomingMessage, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new ApiError(413, 'payload_too_large', `Request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export async function readJsonBody<T = Record<string, unknown>>(
  req: IncomingMessage,
  maxBytes = 8 * 1024 * 1024,
): Promise<T> {
  const buf = await readRawBody(req, maxBytes);
  if (buf.length === 0) {
    return {} as T;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new ApiError(400, 'invalid_json', 'Malformed JSON request body');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError(400, 'invalid_json', 'Request body must be a JSON object');
  }
  return parsed as T;
}

/**
 * Extracts single file bytes + filename + mimeType from either `multipart/form-data`
 * or raw binary body (`X-File-Name` / `?filename=...`).
 */
export async function readUploadedFileBody(
  req: IncomingMessage,
  query: URLSearchParams,
): Promise<{ buffer: Buffer; fileName: string; mimeType: string }> {
  const raw = await readRawBody(req);
  const contentType = req.headers['content-type'] ?? 'application/octet-stream';

  const boundaryMatch = /multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (boundaryMatch) {
    const boundary = `--${boundaryMatch[1] ?? boundaryMatch[2]!}`;
    const boundaryBuf = Buffer.from(boundary, 'utf8');
    const firstBoundary = raw.indexOf(boundaryBuf);
    if (firstBoundary !== -1) {
      const headerStart = firstBoundary + boundaryBuf.length + 2; // skip \r\n
      const headerEnd = raw.indexOf(Buffer.from('\r\n\r\n'), headerStart);
      if (headerEnd !== -1) {
        const partHeaders = raw.subarray(headerStart, headerEnd).toString('utf8');
        const bodyStart = headerEnd + 4;
        const nextBoundary = raw.indexOf(Buffer.from(`\r\n${boundary}`), bodyStart);
        const fileBuf = nextBoundary !== -1 ? raw.subarray(bodyStart, nextBoundary) : raw.subarray(bodyStart);

        const fnMatch = /filename="([^"]*)"/i.exec(partHeaders);
        const ctMatch = /Content-Type:\s*([^\r\n;]+)/i.exec(partHeaders);
        return {
          buffer: fileBuf,
          fileName: fnMatch?.[1] || 'upload.bin',
          mimeType: ctMatch?.[1]?.trim() || 'application/octet-stream',
        };
      }
    }
  }

  const headerName = req.headers['x-file-name'];
  const fileName =
    (typeof headerName === 'string' ? safeDecodeURIComponent(headerName) : undefined) ??
    query.get('filename') ??
    'upload.bin';

  const mimeType = contentType.split(';')[0]?.trim() || 'application/octet-stream';
  return {
    buffer: raw,
    fileName,
    mimeType,
  };
}

export function extractBearerToken(req: IncomingMessage, query?: URLSearchParams): string | null {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (m && m[1]) {
      return m[1].trim();
    }
  }
  const queryToken = query?.get('token');
  if (queryToken && queryToken.trim()) {
    return queryToken.trim();
  }
  return null;
}

export function authenticateToken(db: DatabaseSync, rawToken: string | null): AuthSessionContext | null {
  if (!rawToken) return null;
  const tokenHash = sha256Hex(rawToken);
  const now = Date.now();
  const row = db
    .prepare(
      `SELECT s.session_id, s.user_id, s.expires_at_ms, u.username
       FROM auth_sessions s
       JOIN users u ON u.user_id = s.user_id
       WHERE s.token_hash = ? AND s.revoked = 0`,
    )
    .get(tokenHash) as
    | { session_id: string; user_id: number; expires_at_ms: number; username: string | null }
    | undefined;

  if (!row) return null;
  if (row.expires_at_ms > 0 && row.expires_at_ms < now) {
    return null;
  }

  db.prepare(`UPDATE auth_sessions SET last_active_ms = ? WHERE session_id = ?`).run(
    now,
    row.session_id,
  );

  return {
    userId: Number(row.user_id),
    sessionId: row.session_id,
    rawToken,
    tokenHash,
    username: row.username ?? `user${row.user_id}`,
  };
}

export function requireAuth(db: DatabaseSync, ctx: RequestContext): AuthSessionContext {
  const token = extractBearerToken(ctx.req, ctx.query);
  const session = authenticateToken(db, token);
  if (!session) {
    throw new ApiError(401, 'unauthorized', 'Missing, invalid, or expired authentication token');
  }
  return session;
}

export function beginSseStream(res: ServerResponse): {
  sendEvent: (eventName: string, data: unknown) => void;
  sendRawData: (rawData: string) => void;
  end: () => void;
} {
  responseAcceptsGzip.set(res, false);
  res.removeHeader('Content-Encoding');
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  return {
    sendEvent(eventName: string, data: unknown) {
      if (res.writableEnded) return;
      res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    sendRawData(rawData: string) {
      if (res.writableEnded) return;
      res.write(`data: ${rawData}\n\n`);
    },
    end() {
      if (!res.writableEnded) {
        res.end();
      }
    },
  };
}
