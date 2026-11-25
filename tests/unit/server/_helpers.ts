import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { WebSocket } from 'ws';
import { REPO_ROOT_DIR } from '@gpui-telegram/server';

export const TEST_TMP_ROOT = path.join(REPO_ROOT_DIR, '.test-tmp');

export function createUniqueTestDir(prefix: string): string {
  const dir = path.join(
    TEST_TMP_ROOT,
    `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function apiJson<T = any>(
  baseUrl: string,
  method: string,
  route: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; data: T; headers: Headers; rawText: string }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) {
    headers.Authorization = `Bearer ${opts.token}`;
  }
  let payload: RequestInit['body'];
  if (opts.body !== undefined) {
    if (Buffer.isBuffer(opts.body) || opts.body instanceof Uint8Array) {
      payload = new Uint8Array(opts.body);
    } else {
      headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
      payload = JSON.stringify(opts.body);
    }
  }

  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: payload,
  });

  const rawText = await res.text();
  let data: any = rawText;
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch {
    // Preserve raw text for non-JSON responses
  }
  return { status: res.status, data: data as T, headers: res.headers, rawText };
}

export interface RegisteredTestUser {
  user_id: number;
  username: string;
  token: string;
  session_id: string;
  password: string;
}

export async function registerTestUser(
  baseUrl: string,
  username: string,
  opts: { first_name?: string; last_name?: string; password?: string; phone?: string } = {},
): Promise<RegisteredTestUser> {
  const password = opts.password ?? `Pass#${username}_2026!`;
  const res = await apiJson(baseUrl, 'POST', '/api/v1/auth/register', {
    body: {
      username,
      password,
      first_name: opts.first_name ?? username,
      last_name: opts.last_name,
      phone: opts.phone,
    },
  });
  if (res.status !== 201) {
    throw new Error(`Failed to register ${username}: HTTP ${res.status} ${JSON.stringify(res.data)}`);
  }
  return {
    user_id: Number(res.data.user_id),
    username: String(res.data.username),
    token: String(res.data.token),
    session_id: String(res.data.session_id),
    password,
  };
}

export function connectWsAuthenticated(
  wsUrl: string,
  token: string,
): Promise<{
  ws: WebSocket;
  frames: any[];
  waitForFrame: (predicate: (f: any) => boolean, timeoutMs?: number) => Promise<any>;
}> {
  return new Promise((resolve, reject) => {
    const frames: any[] = [];
    const waiters: Array<{ pred: (f: any) => boolean; res: (f: any) => void }> = [];
    const ws = new WebSocket(`${wsUrl}?token=${encodeURIComponent(token)}`);

    ws.on('message', (raw) => {
      const parsed = JSON.parse(raw.toString('utf8'));
      frames.push(parsed);
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i]!;
        if (w.pred(parsed)) {
          waiters.splice(i, 1);
          w.res(parsed);
        }
      }
      if (parsed.type === 'AuthOk') {
        resolve({
          ws,
          frames,
          waitForFrame(predicate, timeoutMs = 4000) {
            const existing = frames.find(predicate);
            if (existing) return Promise.resolve(existing);
            return new Promise((resWait, rejWait) => {
              const timer = setTimeout(
                () => rejWait(new Error('Timed out waiting for WS frame')),
                timeoutMs,
              );
              waiters.push({
                pred: predicate,
                res: (f) => {
                  clearTimeout(timer);
                  resWait(f);
                },
              });
            });
          },
        });
      }
    });

    ws.once('error', reject);
  });
}

export function sendRawHttpRequest(
  port: number,
  method: string,
  rawPath: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
      const headerLines = Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}`);
      const reqLines = [
        `${method} ${rawPath} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Connection: close',
        ...headerLines,
        '',
        '',
      ];
      sock.write(reqLines.join('\r\n'));
    });
    const chunks: Buffer[] = [];
    sock.on('data', (c: Buffer) => chunks.push(c));
    sock.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const headerEnd = raw.indexOf('\r\n\r\n');
      const head = headerEnd >= 0 ? raw.slice(0, headerEnd) : raw;
      const body = headerEnd >= 0 ? raw.slice(headerEnd + 4) : '';
      const lines = head.split('\r\n');
      const firstLine = lines[0] ?? '';
      const m = /^HTTP\/1\.[01]\s+(\d+)/.exec(firstLine);
      const statusCode = m ? Number(m[1]) : 0;
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const idx = line.indexOf(':');
        if (idx > 0) {
          headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
        }
      }
      resolve({ statusCode, headers, body });
    });
    sock.once('error', reject);
  });
}

export interface EphemeralOtpWebhook {
  url: string;
  deliveries: Array<Record<string, any>>;
  close(): Promise<void>;
}

export async function startEphemeralOtpWebhook(): Promise<EphemeralOtpWebhook> {
  const deliveries: Array<Record<string, any>> = [];
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        deliveries.push(JSON.parse(text));
      } catch {
        deliveries.push({ raw: text });
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  const port = (srv.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/deliver`,
    deliveries,
    async close() {
      srv.closeAllConnections?.();
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    },
  };
}

// ============================================================================
// Minimal RFC 8949 CBOR Encoder & Real WebAuthn Test Fixture Helpers
// ============================================================================

function encodeCborHead(major: number, n: number): Buffer {
  const m = (major & 0x07) << 5;
  if (n < 24) return Buffer.from([m | n]);
  if (n < 0x100) return Buffer.from([m | 24, n]);
  if (n < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = m | 25;
    b.writeUInt16BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = m | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

export function encodeCborValue(val: unknown): Buffer {
  if (typeof val === 'number') {
    if (val >= 0) return encodeCborHead(0, val);
    return encodeCborHead(1, -1 - val);
  }
  if (Buffer.isBuffer(val)) {
    return Buffer.concat([encodeCborHead(2, val.length), val]);
  }
  if (typeof val === 'string') {
    const b = Buffer.from(val, 'utf8');
    return Buffer.concat([encodeCborHead(3, b.length), b]);
  }
  if (val instanceof Map) {
    const parts: Buffer[] = [encodeCborHead(5, val.size)];
    for (const [k, v] of val.entries()) {
      parts.push(encodeCborValue(k), encodeCborValue(v));
    }
    return Buffer.concat(parts);
  }
  throw new Error(`Unsupported CBOR test encoding type: ${typeof val}`);
}

export function buildCoseKeyFromPublicKey(
  publicKey: crypto.KeyObject,
  alg: -7 | -8 | -257,
): Buffer {
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, string>;
  const map = new Map<unknown, unknown>();
  if (alg === -7) {
    map.set(1, 2); // kty: EC2
    map.set(3, -7); // alg: ES256
    map.set(-1, 1); // crv: P-256
    map.set(-2, Buffer.from(jwk.x!, 'base64url'));
    map.set(-3, Buffer.from(jwk.y!, 'base64url'));
  } else if (alg === -8) {
    map.set(1, 1); // kty: OKP
    map.set(3, -8); // alg: EdDSA
    map.set(-1, 6); // crv: Ed25519
    map.set(-2, Buffer.from(jwk.x!, 'base64url'));
  } else {
    map.set(1, 3); // kty: RSA
    map.set(3, -257); // alg: RS256
    map.set(-1, Buffer.from(jwk.n!, 'base64url'));
    map.set(-2, Buffer.from(jwk.e!, 'base64url'));
  }
  return encodeCborValue(map);
}

export function buildWebAuthnAttestationObject(params: {
  rpId: string;
  credId: Buffer;
  cosePublicKey: Buffer;
  signCount?: number;
  flags?: number;
}): Buffer {
  const rpIdHash = crypto.createHash('sha256').update(params.rpId, 'utf8').digest();
  const flags = Buffer.from([params.flags ?? 0x45]); // UP | UV | AT
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(params.signCount ?? 0, 0);
  const aaguid = Buffer.alloc(16, 0);
  const credLen = Buffer.alloc(2);
  credLen.writeUInt16BE(params.credId.length, 0);
  const authData = Buffer.concat([
    rpIdHash,
    flags,
    counter,
    aaguid,
    credLen,
    params.credId,
    params.cosePublicKey,
  ]);
  const attMap = new Map<unknown, unknown>();
  attMap.set('fmt', 'none');
  attMap.set('attStmt', new Map());
  attMap.set('authData', authData);
  return encodeCborValue(attMap);
}

export function buildSignedWebAuthnAssertion(params: {
  privateKey: crypto.KeyObject;
  alg: -7 | -8 | -257;
  rpId: string;
  origin: string;
  challenge: string;
  signCount?: number;
  flags?: number;
  type?: string;
  dsaEncoding?: 'der' | 'ieee-p1363';
}): {
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
} {
  const clientDataObj = {
    type: params.type ?? 'webauthn.get',
    challenge: params.challenge,
    origin: params.origin,
    crossOrigin: false,
  };
  const clientDataBuf = Buffer.from(JSON.stringify(clientDataObj), 'utf8');
  const rpIdHash = crypto.createHash('sha256').update(params.rpId, 'utf8').digest();
  const flags = Buffer.from([params.flags ?? 0x05]); // UP | UV
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(params.signCount ?? 1, 0);
  const authDataBuf = Buffer.concat([rpIdHash, flags, counter]);

  const clientDataHash = crypto.createHash('sha256').update(clientDataBuf).digest();
  const signedData = Buffer.concat([authDataBuf, clientDataHash]);

  let sig: Buffer;
  if (params.alg === -8) {
    sig = crypto.sign(null, signedData, params.privateKey);
  } else if (params.alg === -7 && params.dsaEncoding === 'ieee-p1363') {
    sig = crypto.sign('sha256', signedData, {
      key: params.privateKey,
      dsaEncoding: 'ieee-p1363',
    });
  } else {
    sig = crypto.sign('sha256', signedData, params.privateKey);
  }

  return {
    clientDataJSON: clientDataBuf.toString('base64url'),
    authenticatorData: authDataBuf.toString('base64url'),
    signature: sig.toString('base64url'),
  };
}
