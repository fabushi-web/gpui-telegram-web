import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import type { Duplex } from 'node:stream';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

const MCP_EXPOSED_HEADERS = ['Mcp-Session-Id', 'Mcp-Protocol-Version', 'WWW-Authenticate'] as const;

function extractPathname(pathnameOrUrl: string): string {
  const trimmed = pathnameOrUrl.trim();
  if (!trimmed) return '/';
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      return (parsed.pathname || '/').replace(/^\/+/, '/');
    } catch {
      // Fall through to string extraction
    }
  }
  const idx = trimmed.search(/[?#]/);
  const rawPath = idx >= 0 ? trimmed.slice(0, idx) : trimmed;
  // Neutralize WHATWG URL parser quirks before relative URL resolution:
  // 1) Strip ASCII \t, \r, \n (removed by WHATWG URL §4.3 before parsing, which turns '/\t/evil.com/...' into '//evil.com/...')
  // 2) Normalize '\' to '/' and collapse leading slashes so '/\...', '\...', and '//...' can never parse as scheme-relative authorities
  const cleanedRaw = rawPath.replace(/[\t\r\n]/g, '').replace(/\\/g, '/');
  const prefixed = `/${cleanedRaw.replace(/^\/+/, '')}`;
  try {
    const parsed = new URL(prefixed, 'http://localhost');
    if (parsed.hostname !== 'localhost') return '/';
    return (parsed.pathname || '/').replace(/^\/+/, '/');
  } catch {
    return prefixed;
  }
}

/**
 * Determines whether a request pathname should be transparently forwarded to
 * `UPSTREAM_SERVER_URL` (e.g. a real Rust `gpui_telegram_server` instance on `ombhrum.com`).
 */
export function shouldProxyPathname(pathname: string): boolean {
  const cleanPath = extractPathname(pathname);
  const probePath = cleanPath.length > 1 ? cleanPath.replace(/\/+$/, '') : cleanPath;
  // Always serve container liveness probes locally so Docker/Render/Fly healthchecks pass in proxy mode
  if (
    probePath === '/api/v1/health' ||
    probePath === '/healthz' ||
    probePath === '/api/v1/ready'
  ) {
    return false;
  }
  return (
    cleanPath.startsWith('/api/') ||
    cleanPath === '/health' ||
    cleanPath.startsWith('/v1/') ||
    cleanPath.startsWith('/.well-known/') ||
    cleanPath.startsWith('/oauth/') ||
    cleanPath === '/mcp' ||
    cleanPath.startsWith('/mcp/') ||
    cleanPath.startsWith('/miniapps/') ||
    cleanPath.startsWith('/bot/') ||
    /^\/bot[^/]+\//.test(cleanPath) ||
    cleanPath.startsWith('/js/')
  );
}

export interface ProxyWebSocketOptions {
  proxyBrowserWs?: boolean;
  env?: NodeJS.ProcessEnv;
}

function resolveProxyBrowserWs(
  optionsOrEnv?: boolean | ProxyWebSocketOptions | NodeJS.ProcessEnv,
): boolean {
  if (typeof optionsOrEnv === 'boolean') return optionsOrEnv;
  if (optionsOrEnv && typeof optionsOrEnv === 'object') {
    if ('proxyBrowserWs' in optionsOrEnv && typeof optionsOrEnv.proxyBrowserWs === 'boolean') {
      return optionsOrEnv.proxyBrowserWs;
    }
    if ('env' in optionsOrEnv) {
      const envCandidate = (optionsOrEnv as ProxyWebSocketOptions).env;
      if (envCandidate && typeof envCandidate === 'object') {
        return envCandidate.PROXY_BROWSER_WS === '1';
      }
      if (envCandidate === undefined) {
        return process.env.PROXY_BROWSER_WS === '1';
      }
    }
    return (optionsOrEnv as NodeJS.ProcessEnv).PROXY_BROWSER_WS === '1';
  }
  return process.env.PROXY_BROWSER_WS === '1';
}

/**
 * Determines whether a WebSocket upgrade path should be forwarded to `UPSTREAM_SERVER_URL`.
 * Forwards `/api/v1/ws`, `/api/v1/tailnet/derp`, and `/api/v1/orca/wake`; keeps `/api/v1/browser/ws`
 * local by default unless `PROXY_BROWSER_WS=1` (or `{ proxyBrowserWs: true }`).
 */
export function shouldProxyWebSocketPathname(
  pathnameOrUrl: string,
  optionsOrEnv?: boolean | ProxyWebSocketOptions | NodeJS.ProcessEnv,
): boolean {
  const cleanPath = extractPathname(pathnameOrUrl);
  if (
    cleanPath === '/api/v1/ws' ||
    cleanPath === '/api/v1/tailnet/derp' ||
    cleanPath === '/api/v1/orca/wake'
  ) {
    return true;
  }
  if (cleanPath === '/api/v1/browser/ws') {
    return resolveProxyBrowserWs(optionsOrEnv);
  }
  return false;
}

/**
 * Transparently proxies HTTP/HTTPS requests (including SSE streams, Range media streams,
 * and chunked uploads) to the configured upstream `gpui_telegram_server`.
 */
export function proxyHttpRequest(
  upstreamBaseUrl: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const upstream = new URL(upstreamBaseUrl);
  const reqUrl = req.url ?? '/';
  const isHttps = upstream.protocol === 'https:';
  const port = upstream.port ? Number(upstream.port) : isHttps ? 443 : 80;

  const forwardHeaders: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lower = k.toLowerCase();
    if (lower === 'host' || HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (v !== undefined) forwardHeaders[k] = v;
  }
  forwardHeaders.host = upstream.host;
  if (req.socket.remoteAddress) {
    const existingXff = req.headers['x-forwarded-for'];
    forwardHeaders['x-forwarded-for'] = existingXff
      ? `${String(existingXff)}, ${req.socket.remoteAddress}`
      : req.socket.remoteAddress;
  }
  forwardHeaders['x-forwarded-proto'] =
    (req.headers['x-forwarded-proto'] as string | undefined) ?? 'https';

  const requestFn = isHttps ? https.request : http.request;
  const proxyReq = requestFn(
    {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port,
      method: req.method ?? 'GET',
      path: `${upstream.pathname.replace(/\/+$/, '')}${reqUrl}`,
      headers: forwardHeaders,
    },
    (proxyRes) => {
      const respHeaders: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        const lower = k.toLowerCase();
        if (HOP_BY_HOP_HEADERS.has(lower)) continue;
        // Preserve our server's CORS headers cleanly without duplicating upstream ones
        if (lower.startsWith('access-control-')) continue;
        if (v !== undefined) respHeaders[k] = v;
      }
      const existingExposeRaw = res.getHeader('Access-Control-Expose-Headers');
      const existingExpose = Array.isArray(existingExposeRaw)
        ? existingExposeRaw.join(', ')
        : typeof existingExposeRaw === 'string'
          ? existingExposeRaw
          : '';
      const exposeList = existingExpose
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean);
      const seenLower = new Set(exposeList.map((h) => h.toLowerCase()));
      for (const headerName of MCP_EXPOSED_HEADERS) {
        if (!seenLower.has(headerName.toLowerCase())) {
          exposeList.push(headerName);
          seenLower.add(headerName.toLowerCase());
        }
      }
      res.setHeader('Access-Control-Expose-Headers', exposeList.join(', '));
      res.writeHead(proxyRes.statusCode ?? 502, respHeaders);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify({
          error: 'upstream_unreachable',
          message: `Upstream server (${upstream.host}) unreachable: ${err.message}`,
        }),
      );
    } else {
      res.end();
    }
  });

  req.on('aborted', () => {
    proxyReq.destroy();
  });

  req.pipe(proxyReq);
}

/**
 * Transparently tunnels WebSocket upgrades (`/api/v1/ws`, `/api/v1/tailnet/derp`, `/api/v1/orca/wake`, etc.)
 * to `UPSTREAM_SERVER_URL` over raw TCP or TLS socket piping.
 */
export function proxyWebSocketUpgrade(
  upstreamBaseUrl: string,
  req: http.IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
): void {
  const upstream = new URL(upstreamBaseUrl);
  const isHttps = upstream.protocol === 'https:';
  const port = upstream.port ? Number(upstream.port) : isHttps ? 443 : 80;
  const reqPath = `${upstream.pathname.replace(/\/+$/, '')}${req.url ?? '/'}`;

  const upstreamSocket: net.Socket = isHttps
    ? tls.connect({
        host: upstream.hostname,
        port,
        servername: upstream.hostname,
      })
    : net.connect({
        host: upstream.hostname,
        port,
      });

  const onConnect = () => {
    const lines: string[] = [`${req.method ?? 'GET'} ${reqPath} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const key = req.rawHeaders[i]!;
      const val = req.rawHeaders[i + 1] ?? '';
      if (key.toLowerCase() === 'host') {
        lines.push(`Host: ${upstream.host}`);
      } else {
        lines.push(`${key}: ${val}`);
      }
    }
    if (!req.headers.host) {
      lines.push(`Host: ${upstream.host}`);
    }
    lines.push('', '');
    upstreamSocket.write(lines.join('\r\n'));
    if (head && head.length > 0) {
      upstreamSocket.write(head);
    }
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
  };

  upstreamSocket.once(isHttps ? 'secureConnect' : 'connect', onConnect);

  upstreamSocket.on('error', () => {
    try {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    } catch {
      // Ignore broken client socket
    }
    clientSocket.destroy();
  });

  clientSocket.on('error', () => {
    upstreamSocket.destroy();
  });
  clientSocket.on('close', () => {
    upstreamSocket.destroy();
  });
}
