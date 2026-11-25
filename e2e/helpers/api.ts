import * as crypto from 'node:crypto';
import * as http from 'node:http';
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { API_PATHS } from './selectors';
import { apiUrl, authHeaders, getBaseUrl } from './server';

/**
 * Pure opaque-box protocol, cryptography, OAuth 2.1 PKCE, MCP JSON-RPC,
 * WebSocket, CodingHost, WebMCP, Multi-Agent OpenAI Stub, and Automation Script App
 * builders using Node 22 built-ins. Zero imports from application packages.
 */

export const MCP_SUPPORTED_SCOPES = [
  'devices:read',
  'devices:connect',
  'screen:view',
  'input:control',
  'terminal:exec',
  'files:read',
  'files:write',
  'assist:manage',
  'power:control',
  'messaging:read',
  'messaging:write',
  'chats:read',
  'miniapp:control',
  'tasks:manage',
] as const;

export const DEFAULT_MCP_OAUTH_SCOPE =
  'devices:read devices:connect chats:read messaging:read tasks:manage';

export interface SplitKeyMaterial {
  saltB64: string;
  verifierB64: string;
  kdfParams: {
    m_cost_kib: number;
    t_cost: number;
    p_cost: number;
  };
}

export function generateSplitKeyMaterial(
  seed = crypto.randomBytes(16).toString('hex'),
): SplitKeyMaterial {
  const salt = crypto.randomBytes(16);
  const verifier = crypto
    .createHmac('sha256', salt)
    .update(`fabushi-split-key-v2:${seed}`)
    .digest();
  return {
    saltB64: salt.toString('base64'),
    verifierB64: verifier.toString('base64'),
    kdfParams: {
      m_cost_kib: 65536,
      t_cost: 3,
      p_cost: 1,
    },
  };
}

export function generateX25519KeyMaterial(): {
  publicKeyB64: string;
  privateKeyDer: Buffer;
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  // Raw 32-byte X25519 public key sits at the end of the 44-byte SPKI DER envelope.
  const rawPublicKey = spki.subarray(spki.length - 32);
  return {
    publicKeyB64: rawPublicKey.toString('base64'),
    privateKeyDer: privateKey.export({ format: 'der', type: 'pkcs8' }),
  };
}

export function generateRandomB64(byteLength: number): string {
  return crypto.randomBytes(byteLength).toString('base64');
}

/**
 * Generates a canonical 60-byte ChaCha20Poly1305 wrapped root key payload:
 * 12B nonce + 32B VaultRootKey + 16B authentication tag.
 */
export function generateWrappedRootKeyB64(): string {
  return generateRandomB64(60);
}

/**
 * Generates a canonical 48-byte X25519 sealed root key payload for device-sync
 * approval where the 12B nonce is transmitted separately in `nonce_b64`:
 * 32B VaultRootKey + 16B authentication tag.
 */
export function generateX25519SealedRootKeyB64(): string {
  return generateRandomB64(48);
}

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
  method: 'S256';
}

export function generatePkceS256(): PkcePair {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier, 'ascii')
    .digest('base64url');
  return {
    codeVerifier,
    codeChallenge,
    method: 'S256',
  };
}

export interface OAuthMcpAuthCodeResult {
  clientId: string;
  redirectUri: string;
  authCode: string;
  scope: string;
  resource: string;
  state: string;
  pkce: PkcePair;
}

export interface OAuthMcpFlowResult {
  clientId: string;
  redirectUri: string;
  accessToken: string;
  refreshToken: string;
  scope: string;
  tokenType: string;
  expiresIn: number;
  pkce: PkcePair;
}

function mergeResponseCookies(cookieJar: Map<string, string>, res: APIResponse): void {
  for (const header of res.headersArray()) {
    if (header.name.toLowerCase() !== 'set-cookie') continue;
    const firstSegment = header.value.split(';')[0]?.trim();
    if (!firstSegment) continue;
    const eqIdx = firstSegment.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = firstSegment.slice(0, eqIdx).trim();
    const val = firstSegment.slice(eqIdx + 1).trim();
    if (val.length === 0) {
      cookieJar.delete(key);
    } else {
      cookieJar.set(key, val);
    }
  }
}

function serializeIsolatedCookieHeader(cookieJar: Map<string, string>): string {
  if (cookieJar.size === 0) {
    // Non-empty benign cookie overrides Playwright APIRequestContext's shared cookie jar
    // so a prior user's `fbmcp_user_sess` cookie never bleeds into a subsequent OAuth flow.
    return 'fbmcp_e2e_iso=1';
  }
  return [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * Executes RFC 7591 Dynamic Client Registration + OAuth 2.1 PKCE S256
 * authorization/login/consent steps with per-flow cookie isolation and returns
 * the single-use authorization code + PKCE pair before `/oauth/token` exchange.
 */
export async function obtainOfficialMcpAuthCode(
  request: APIRequestContext,
  credentials: { username: string; password: string; token?: string },
  options: {
    clientName?: string;
    redirectUri?: string;
    scope?: string;
    resource?: string;
  } = {},
): Promise<OAuthMcpAuthCodeResult> {
  const baseUrl = getBaseUrl();
  const redirectUri = options.redirectUri ?? 'http://127.0.0.1:43210/oauth/callback';
  const scope = options.scope ?? DEFAULT_MCP_OAUTH_SCOPE;
  const resource = options.resource ?? `${baseUrl}${API_PATHS.officialMcp}`;
  const cookieJar = new Map<string, string>();

  // 1. Dynamic Client Registration (RFC 7591)
  const dcrRes = await request.post(apiUrl(API_PATHS.oauthRegister), {
    data: {
      client_name: options.clientName ?? 'Fabushi E2E MCP Client',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
    },
    failOnStatusCode: false,
  });
  const dcrBody = (await dcrRes.json().catch(() => null)) as Record<string, unknown> | null;
  if ((dcrRes.status() !== 201 && dcrRes.status() !== 200) || !dcrBody?.client_id) {
    throw new Error(
      `POST /oauth/register failed (${dcrRes.status()}): ${JSON.stringify(dcrBody)}`,
    );
  }
  const clientId = String(dcrBody.client_id);

  // 2. GET /oauth/authorize to establish consent tx + CSRF token (cookie-isolated)
  const pkce = generatePkceS256();
  const state = crypto.randomBytes(12).toString('hex');
  const authParams = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: 'S256',
    scope,
    resource,
    state,
  });

  const authRes = await request.get(
    `${apiUrl(API_PATHS.oauthAuthorize)}?${authParams.toString()}`,
    {
      headers: {
        ...(credentials.token ? authHeaders(credentials.token) : {}),
        Cookie: serializeIsolatedCookieHeader(cookieJar),
      },
      maxRedirects: 0,
      failOnStatusCode: false,
    },
  );
  mergeResponseCookies(cookieJar, authRes);
  const authHtml = await authRes.text();
  if (authRes.status() !== 200) {
    throw new Error(
      `GET /oauth/authorize failed (${authRes.status()}): ${authHtml.slice(0, 400)}`,
    );
  }

  const extractField = (html: string, name: string): string | undefined => {
    const inputMatch = html.match(
      new RegExp(
        `<input[^>]*name=["']${name}["'][^>]*value=["']([^"']+)["']|<input[^>]*value=["']([^"']+)["'][^>]*name=["']${name}["']`,
        'i',
      ),
    );
    if (inputMatch) return inputMatch[1] || inputMatch[2];
    const jsonMatch = html.match(
      new RegExp(`"${name}"\\s*:\\s*"([^"]+)"`, 'i'),
    );
    return jsonMatch?.[1];
  };

  let txId =
    extractField(authHtml, 'tx_id') ??
    extractField(authHtml, 'tx') ??
    extractField(authHtml, 'transaction_id');
  let csrfToken =
    extractField(authHtml, 'csrf_token') ?? extractField(authHtml, 'csrf');

  // 3. Authenticate inside the consent flow if login form is rendered
  if (
    authHtml.includes('/oauth/authorize/login') ||
    /name=["']username["']/i.test(authHtml)
  ) {
    const loginRes = await request.post(apiUrl(API_PATHS.oauthAuthorizeLogin), {
      headers: {
        Cookie: serializeIsolatedCookieHeader(cookieJar),
      },
      form: {
        ...(txId ? { tx_id: txId, tx: txId } : {}),
        ...(csrfToken ? { csrf_token: csrfToken, csrf: csrfToken } : {}),
        username: credentials.username,
        password: credentials.password,
      },
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    mergeResponseCookies(cookieJar, loginRes);
    const loginText = await loginRes.text();
    if (loginRes.status() >= 400) {
      throw new Error(
        `POST /oauth/authorize/login failed (${loginRes.status()}): ${loginText.slice(0, 400)}`,
      );
    }
    txId =
      extractField(loginText, 'tx_id') ??
      extractField(loginText, 'tx') ??
      txId;
    csrfToken =
      extractField(loginText, 'csrf_token') ??
      extractField(loginText, 'csrf') ??
      csrfToken;
  }

  // 4. Approve consent to obtain single-use authorization code
  const approveRes = await request.post(apiUrl(API_PATHS.oauthAuthorizeApprove), {
    headers: {
      ...(credentials.token ? authHeaders(credentials.token) : {}),
      Cookie: serializeIsolatedCookieHeader(cookieJar),
    },
    form: {
      ...(txId ? { tx_id: txId, tx: txId } : {}),
      ...(csrfToken ? { csrf_token: csrfToken, csrf: csrfToken } : {}),
      decision: 'approve',
      approve: '1',
      scope,
      scopes: scope,
    },
    maxRedirects: 0,
    failOnStatusCode: false,
  });

  const location =
    approveRes.headers()['location'] ??
    approveRes.headers()['Location'] ??
    '';
  let authCode = '';
  if (location) {
    const parsedRedirect = new URL(location, baseUrl);
    authCode = parsedRedirect.searchParams.get('code') ?? '';
    const returnedState = parsedRedirect.searchParams.get('state') ?? '';
    if (returnedState && returnedState !== state) {
      throw new Error(`OAuth state mismatch: expected ${state}, got ${returnedState}`);
    }
  } else {
    const approveJson = (await approveRes.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (approveJson?.code) {
      authCode = String(approveJson.code);
    } else if (typeof approveJson?.redirect_url === 'string') {
      authCode = new URL(approveJson.redirect_url).searchParams.get('code') ?? '';
    }
  }

  if (!authCode) {
    const fallbackBody = await approveRes.text().catch(() => '');
    throw new Error(
      `POST /oauth/authorize/approve did not issue an authorization code (HTTP ${approveRes.status()}, location="${location}", body="${fallbackBody.slice(0, 300)}")`,
    );
  }

  return {
    clientId,
    redirectUri,
    authCode,
    scope,
    resource,
    state,
    pkce,
  };
}

/**
 * Executes the genuine RFC 7591 + OAuth 2.1 PKCE S256 consent & token flow
 * against `/oauth/register`, `/oauth/authorize`, `/oauth/authorize/login`,
 * `/oauth/authorize/approve`, and `/oauth/token`.
 */
export async function completeOfficialMcpOAuthFlow(
  request: APIRequestContext,
  credentials: { username: string; password: string; token?: string },
  options: {
    clientName?: string;
    redirectUri?: string;
    scope?: string;
    resource?: string;
  } = {},
): Promise<OAuthMcpFlowResult> {
  const auth = await obtainOfficialMcpAuthCode(request, credentials, options);

  // 5. Exchange code + PKCE verifier at POST /oauth/token
  const tokenRes = await request.post(apiUrl(API_PATHS.oauthToken), {
    form: {
      grant_type: 'authorization_code',
      client_id: auth.clientId,
      code: auth.authCode,
      redirect_uri: auth.redirectUri,
      code_verifier: auth.pkce.codeVerifier,
      resource: auth.resource,
    },
    failOnStatusCode: false,
  });
  const tokenBody = (await tokenRes.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (tokenRes.status() !== 200 || !tokenBody?.access_token) {
    throw new Error(
      `POST /oauth/token failed (${tokenRes.status()}): ${JSON.stringify(tokenBody)}`,
    );
  }

  return {
    clientId: auth.clientId,
    redirectUri: auth.redirectUri,
    accessToken: String(tokenBody.access_token),
    refreshToken: String(tokenBody.refresh_token ?? ''),
    scope: String(tokenBody.scope ?? auth.scope),
    tokenType: String(tokenBody.token_type ?? 'Bearer'),
    expiresIn: Number(tokenBody.expires_in ?? 3600),
    pkce: auth.pkce,
  };
}

export async function callOfficialMcpJsonRpc(
  request: APIRequestContext,
  method: string,
  params: Record<string, unknown> = {},
  options: {
    accessToken?: string;
    sessionId?: string;
    protocolVersion?: string;
    id?: number | string;
  } = {},
) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': options.protocolVersion ?? '2025-11-25',
  };
  if (options.accessToken) {
    headers.Authorization = `Bearer ${options.accessToken}`;
  }
  if (options.sessionId) {
    headers['Mcp-Session-Id'] = options.sessionId;
  }

  const res = await request.post(apiUrl(API_PATHS.officialMcp), {
    headers,
    data: {
      jsonrpc: '2.0',
      id: options.id ?? 1,
      method,
      params,
    },
    failOnStatusCode: false,
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return {
    status: res.status(),
    headers: res.headers(),
    body,
  };
}

export interface WsFrame {
  type?: string;
  event?: string;
  cmd?: string;
  payload?: Record<string, unknown>;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export class OpaqueWsClient {
  private readonly ws: WebSocket;
  private readonly received: WsFrame[] = [];
  private readonly waiters: Array<{
    predicate: (frame: WsFrame) => boolean;
    resolve: (frame: WsFrame) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (evt) => {
      let parsed: WsFrame;
      try {
        parsed = JSON.parse(String(evt.data)) as WsFrame;
      } catch {
        return;
      }
      this.received.push(parsed);
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        const waiter = this.waiters[i];
        if (waiter.predicate(parsed)) {
          clearTimeout(waiter.timer);
          this.waiters.splice(i, 1);
          waiter.resolve(parsed);
        }
      }
    });
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('WebSocket closed before matching frame arrived'));
      }
    });
  }

  static connect(token: string, timeoutMs = 8_000): Promise<OpaqueWsClient> {
    const httpBase = getBaseUrl();
    const wsBase = httpBase.replace(/^http/i, 'ws');
    const url = `${wsBase}${API_PATHS.ws}?token=${encodeURIComponent(token)}`;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`WebSocket connection to ${url} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new OpaqueWsClient(ws));
      });

      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`WebSocket connection to ${url} failed`));
      });
    });
  }

  send(frame: Record<string, unknown>): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Cannot send frame on closed WebSocket');
    }
    this.ws.send(JSON.stringify(frame));
  }

  getFrames(): WsFrame[] {
    return [...this.received];
  }

  getFrameCount(): number {
    return this.received.length;
  }

  waitForFrame(
    predicate: (frame: WsFrame) => boolean,
    timeoutMs = 8_000,
    description = 'expected WS frame',
    fromIndex = 0,
  ): Promise<WsFrame> {
    for (let i = Math.max(0, fromIndex); i < this.received.length; i++) {
      if (predicate(this.received[i])) {
        return Promise.resolve(this.received[i]);
      }
    }
    if (this.closed) {
      return Promise.reject(
        new Error(`WebSocket already closed before ${description}`),
      );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for ${description} (received ${this.received.length} frames)`,
          ),
        );
      }, timeoutMs);

      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      try {
        this.ws.close();
      } catch {
        // ignore close errors
      }
    }
  }
}

export interface DetectedCodingProviderDto {
  kind: 'claude_code' | 'codex' | 'open_code' | 'cursor_cli' | 'antigravity' | 'acp_custom';
  display_name: string;
  binary_path: string | null;
  version: string | null;
  installed: boolean;
  recommended_username: string;
  supports_acp: boolean;
  login_hint: string;
}

export function buildDetectedCodingProvider(
  kind: DetectedCodingProviderDto['kind'],
  overrides: Partial<DetectedCodingProviderDto> = {},
): DetectedCodingProviderDto {
  const defaults: Record<
    DetectedCodingProviderDto['kind'],
    Omit<DetectedCodingProviderDto, 'kind'>
  > = {
    claude_code: {
      display_name: 'Claude Code',
      binary_path: '/usr/local/bin/claude',
      version: '1.0.42',
      installed: true,
      recommended_username: 'claude_code_bot',
      supports_acp: false,
      login_hint: '',
    },
    codex: {
      display_name: 'Codex',
      binary_path: '/usr/local/bin/codex',
      version: '0.9.1',
      installed: true,
      recommended_username: 'codex_bot',
      supports_acp: false,
      login_hint: '',
    },
    open_code: {
      display_name: 'OpenCode',
      binary_path: '/usr/local/bin/opencode',
      version: '0.5.0',
      installed: true,
      recommended_username: 'opencode_bot',
      supports_acp: true,
      login_hint: '',
    },
    cursor_cli: {
      display_name: 'Cursor CLI',
      binary_path: '/usr/local/bin/cursor-agent',
      version: '1.2.0',
      installed: true,
      recommended_username: 'cursor_cli_bot',
      supports_acp: true,
      login_hint: '',
    },
    antigravity: {
      display_name: 'Antigravity',
      binary_path: '/usr/local/bin/agy',
      version: '1.0.0',
      installed: true,
      recommended_username: 'antigravity_bot',
      supports_acp: false,
      login_hint: '',
    },
    acp_custom: {
      display_name: 'Custom ACP',
      binary_path: '/usr/local/bin/custom-acp',
      version: '1.0.0',
      installed: true,
      recommended_username: 'acp_coding_bot',
      supports_acp: true,
      login_hint: '',
    },
  };
  return { kind, ...defaults[kind], ...overrides };
}

export function buildCodingHostEventFrame(
  eventPayload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: 'CodingHostEvent',
    payload: eventPayload,
  };
}

/**
 * Unwraps a `WsServerFrame::Update(UpdateEvent::<eventType>)` or `PtsPush`/`PtsUpdate`
 * envelope and returns its inner `data` object when matching `eventType`.
 */
export function extractUpdateEvent(
  frame: WsFrame,
  eventType: string,
): Record<string, unknown> | null {
  if (frame.type === 'Update' && frame.payload && typeof frame.payload === 'object') {
    const inner = frame.payload as Record<string, unknown>;
    if (inner.type === eventType && inner.data && typeof inner.data === 'object') {
      return inner.data as Record<string, unknown>;
    }
  }
  if (
    (frame.type === 'PtsPush' || frame.type === 'PtsUpdate') &&
    frame.payload &&
    typeof frame.payload === 'object'
  ) {
    const ev = (frame.payload as Record<string, unknown>).event as
      | Record<string, unknown>
      | undefined;
    if (ev?.type === eventType && ev.data && typeof ev.data === 'object') {
      return ev.data as Record<string, unknown>;
    }
  }
  if (frame.type === eventType) {
    const body = (frame.data ?? frame.payload ?? frame) as Record<string, unknown>;
    if (body && typeof body === 'object') return body;
  }
  return null;
}

export function extractCodingHostCommand(
  frame: WsFrame,
): Record<string, unknown> | null {
  const data = extractUpdateEvent(frame, 'CodingHostCommand');
  if (data && typeof data.cmd === 'string') {
    return data;
  }
  return null;
}

export function extractBotUserId(resp: {
  bot?: { bot_user_id?: number; user_id?: number; id?: number };
  registry?: { bot_user_id?: number };
}): number {
  const id = Number(
    resp.bot?.bot_user_id ??
      resp.registry?.bot_user_id ??
      resp.bot?.user_id ??
      resp.bot?.id,
  );
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error(
      `Invalid FabushiBotCreateResponse missing bot_user_id: ${JSON.stringify(resp)}`,
    );
  }
  return id;
}

export function extractRawInitData(
  initData: string | { raw_query_string?: string; hmac_verified?: boolean } | null | undefined,
): string {
  if (typeof initData === 'string') return initData;
  if (initData && typeof initData === 'object' && typeof initData.raw_query_string === 'string') {
    return initData.raw_query_string;
  }
  return '';
}

export function buildMiniAppTakeoverStateFrame(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: 'MiniAppTakeoverState',
    payload,
  };
}

export function buildMiniAppWebMcpResultFrame(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: 'MiniAppWebMcpResult',
    payload,
  };
}

export interface ScriptParameterDto {
  name: string;
  description: string;
  required: boolean;
  default_value: string | null;
  is_secret: boolean;
}

export function buildValidAutomationAppManifest(overrides: Record<string, unknown> = {}) {
  const uniqueSlug = `app_${crypto.randomBytes(4).toString('hex')}`;
  return {
    schema_version: 1,
    app_id: uniqueSlug,
    slug: uniqueSlug,
    name: `Invoice Exporter ${uniqueSlug}`,
    version: '1.0.0',
    description: 'Deterministic replay script compiled from recorded browser trace',
    category: 'productivity',
    target_domains: ['example.com'],
    parameters: [
      {
        name: 'account_label',
        description: 'Target workspace label',
        required: true,
        default_value: null,
        is_secret: false,
      },
      {
        name: 'portal_credential',
        description: 'Vault-backed credential reference',
        required: true,
        default_value: null,
        is_secret: true,
      },
    ] satisfies ScriptParameterDto[],
    steps: [
      {
        kind: 'navigate',
        url_template: 'https://example.com/dashboard?acct={{account_label}}',
      },
      {
        kind: 'wait_for',
        locator: { test_id: 'dashboard-ready', role: 'main' },
        timeout_ms: 5000,
      },
      {
        kind: 'fill',
        locator: { aria_label: 'Access Credential', css_selector: 'input[name="cred"]' },
        value_template: '{{portal_credential}}',
        secret_vault_key: 'portal_primary_secret',
      },
      {
        kind: 'click',
        locator: { role: 'button', text_anchor: 'Export Report' },
      },
      {
        kind: 'assert_visible',
        locator: { test_id: 'export-complete' },
      },
    ],
    required_capabilities: [
      'browser_navigate',
      'browser_wait_for',
      'browser_type',
      'browser_click',
      'browser_snapshot',
    ],
    ...overrides,
  };
}

export function buildSampleBrowserActionTrace(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const traceId = `trace_${crypto.randomBytes(4).toString('hex')}`;
  return {
    trace_id: traceId,
    session_id: `sess_${crypto.randomBytes(4).toString('hex')}`,
    started_at_ms: now - 4000,
    completed_at_ms: now - 200,
    initial_url: 'https://example.com/login',
    actions: [
      {
        seq: 1,
        timestamp_ms: now - 3500,
        page_url: 'https://example.com/login',
        action: {
          kind: 'navigate',
          url: 'https://example.com/login',
        },
        duration_ms: 120,
      },
      {
        seq: 2,
        timestamp_ms: now - 2500,
        page_url: 'https://example.com/login',
        action: {
          kind: 'fill',
          locator: {
            test_id: 'email-field',
            aria_label: 'Work Email',
            css_selector: 'input[name="email"]',
          },
          value: 'operator@example.com',
          is_secret: false,
          parameter_name_hint: 'work_email',
        },
        duration_ms: 45,
      },
      {
        seq: 3,
        timestamp_ms: now - 2000,
        page_url: 'https://example.com/login',
        action: {
          kind: 'fill',
          locator: {
            test_id: 'secret-field',
            aria_label: 'Password',
            css_selector: 'input[type="password"]',
          },
          value: 'RawRecordedCredential99!',
          is_secret: true,
          vault_key_hint: 'example_portal_password',
          parameter_name_hint: 'portal_password',
        },
        duration_ms: 40,
      },
      {
        seq: 4,
        timestamp_ms: now - 1200,
        page_url: 'https://example.com/login',
        action: {
          kind: 'click',
          locator: {
            role: 'button',
            text_anchor: 'Sign In',
          },
        },
        duration_ms: 60,
      },
      {
        seq: 5,
        timestamp_ms: now - 500,
        page_url: 'https://example.com/home',
        action: {
          kind: 'assert_visible',
          locator: {
            test_id: 'home-dashboard',
          },
        },
        duration_ms: 30,
      },
    ],
    parameter_bindings: [
      {
        param_name: 'work_email',
        literal_value: 'operator@example.com',
        description: 'Work email address for portal login',
        required: true,
        is_secret: false,
      },
      {
        param_name: 'portal_password',
        literal_value: 'RawRecordedCredential99!',
        description: 'Vault-backed portal password',
        required: true,
        is_secret: true,
      },
    ],
    ...overrides,
  };
}

export interface EphemeralOpenAiStubToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface EphemeralOpenAiStubReply {
  content?: string | null;
  tool_calls?: EphemeralOpenAiStubToolCall[];
  finish_reason?: 'stop' | 'tool_calls';
}

export interface EphemeralOpenAiStubCall {
  index: number;
  path: string;
  body: Record<string, unknown>;
  messages: Array<Record<string, unknown>>;
  tools: Array<Record<string, unknown>>;
}

export interface EphemeralOpenAiStubHandle {
  baseUrl: string;
  port: number;
  calls: EphemeralOpenAiStubCall[];
  close: () => Promise<void>;
}

/**
 * Starts an ephemeral OpenAI-compatible HTTP stub strictly on `127.0.0.1:0`
 * serving `GET /v1/models` and `POST /v1/chat/completions` (both SSE streaming
 * and non-streaming JSON, including `tool_calls`). Always call `close()` in `finally`.
 */
export function startEphemeralOpenAiStub(
  handler: (
    call: EphemeralOpenAiStubCall,
  ) => EphemeralOpenAiStubReply | Promise<EphemeralOpenAiStubReply>,
  options: { modelId?: string } = {},
): Promise<EphemeralOpenAiStubHandle> {
  const modelId = options.modelId ?? 'e2e-multiagent-1';
  const calls: EphemeralOpenAiStubCall[] = [];

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = reqUrl.pathname;

    if (req.method === 'GET' && (pathname === '/v1/models' || pathname === '/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [
            {
              id: modelId,
              object: 'model',
              created: Math.floor(Date.now() / 1000),
              owned_by: 'e2e-local-stub',
            },
          ],
        }),
      );
      return;
    }

    if (
      req.method === 'POST' &&
      (pathname === '/v1/chat/completions' || pathname === '/chat/completions')
    ) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { message: 'invalid_json' } }));
        return;
      }

      const call: EphemeralOpenAiStubCall = {
        index: calls.length,
        path: pathname,
        body,
        messages: Array.isArray(body.messages)
          ? (body.messages as Array<Record<string, unknown>>)
          : [],
        tools: Array.isArray(body.tools) ? (body.tools as Array<Record<string, unknown>>) : [],
      };
      calls.push(call);

      let reply: EphemeralOpenAiStubReply;
      try {
        reply = await handler(call);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { message: `e2e_stub_handler_error: ${message}` } }));
        return;
      }
      const completionId = `chatcmpl-e2e-${call.index}-${crypto.randomBytes(3).toString('hex')}`;
      const created = Math.floor(Date.now() / 1000);
      const effectiveModel = typeof body.model === 'string' && body.model ? body.model : modelId;
      const finishReason =
        reply.finish_reason ?? (reply.tool_calls && reply.tool_calls.length > 0 ? 'tool_calls' : 'stop');

      if (body.stream === true) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const emitChunk = (
          delta: Record<string, unknown>,
          chunkFinish: string | null = null,
        ) => {
          res.write(
            `data: ${JSON.stringify({
              id: completionId,
              object: 'chat.completion.chunk',
              created,
              model: effectiveModel,
              choices: [{ index: 0, delta, finish_reason: chunkFinish }],
            })}\n\n`,
          );
        };
        emitChunk({ role: 'assistant' });
        if (reply.tool_calls && reply.tool_calls.length > 0) {
          for (let i = 0; i < reply.tool_calls.length; i++) {
            const tc = reply.tool_calls[i];
            emitChunk({
              tool_calls: [
                {
                  index: i,
                  id: tc.id,
                  type: 'function',
                  function: {
                    name: tc.function.name,
                    arguments: tc.function.arguments,
                  },
                },
              ],
            });
          }
        }
        if (typeof reply.content === 'string' && reply.content.length > 0) {
          emitChunk({ content: reply.content });
        }
        emitChunk({}, finishReason);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          id: completionId,
          object: 'chat.completion',
          created,
          model: effectiveModel,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: reply.content ?? null,
                ...(reply.tool_calls && reply.tool_calls.length > 0
                  ? { tool_calls: reply.tool_calls }
                  : {}),
              },
              finish_reason: finishReason,
            },
          ],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 32,
            total_tokens: 152,
          },
        }),
      );
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { message: `Unhandled stub path ${pathname}` } }));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to bind ephemeral OpenAI stub on 127.0.0.1:0'));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}/v1`,
        port: addr.port,
        calls,
        close: async () => {
          server.closeAllConnections?.();
          await new Promise<void>((done) => server.close(() => done()));
        },
      });
    });
  });
}
