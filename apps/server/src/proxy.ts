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

/**
 * Determines whether a request pathname should be transparently forwarded to
 * `UPSTREAM_SERVER_URL` (e.g. a real Rust `gpui_telegram_server` instance on `ombhrum.com` or GCE).
 */
export function shouldProxyPathname(pathname: string): boolean {
  // Always serve container liveness probes locally so Docker/Render/Fly healthchecks pass in proxy mode
  if (pathname === '/api/v1/health' || pathname === '/healthz' || pathname === '/api/v1/ready') {
    return false;
  }
  // Serve bundled 833KB Fabushi WASM & textures locally unless explicitly proxied
  if (
    pathname === '/api/v1/fabushi-miniapp/app.wasm' ||
    pathname.startsWith('/api/v1/fabushi-miniapp/assets/')
  ) {
    return false;
  }
  return (
    pathname.startsWith('/api/') ||
    pathname === '/health' ||
    pathname.startsWith('/v1/') ||
    pathname.startsWith('/bot/') ||
    pathname === '/js/telegram-web-app.js'
  );
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
 * Transparently tunnels WebSocket upgrades (`/api/v1/ws`, `/api/v1/tailnet/derp`, etc.)
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
