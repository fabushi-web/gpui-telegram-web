import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT_DIR = path.resolve(currentDir, '../../..');

export const DEFAULT_APP_VERSION = '1.6.11';
export const DEFAULT_CLOUD_GATEWAY_URL = 'https://api.ombhrum.com';
export const DEFAULT_AI_GATEWAY_URL = 'https://ai.ombhrum.com';

function nonEmpty(value?: string | null): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function nonEmptyUrl(value?: string | null): string | undefined {
  const trimmed = nonEmpty(value);
  if (!trimmed) return undefined;
  const stripped = trimmed.replace(/\/+$/, '');
  return stripped.length > 0 ? stripped : undefined;
}

/**
 * Normalizes an AI gateway base URL so callers appending `/v1/chat/completions`
 * never double the version segment into `/v1/v1/chat/completions`.
 */
export function normalizeAiGatewayBaseUrl(
  raw: string | null | undefined,
  fallback = DEFAULT_AI_GATEWAY_URL,
): string {
  const resolvedFallback =
    fallback === DEFAULT_AI_GATEWAY_URL
      ? DEFAULT_AI_GATEWAY_URL
      : normalizeAiGatewayBaseUrl(fallback, DEFAULT_AI_GATEWAY_URL);
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return resolvedFallback;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      let pathname = parsed.pathname.replace(/\/+$/, '');
      pathname = pathname.replace(/(?:\/+v1)+$/i, '');
      pathname = pathname.replace(/\/+$/, '');
      return `${parsed.origin}${pathname}`;
    }
  } catch {
    // Fall back to string normalization for non-URL strings
  }
  const normalized = trimmed
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .replace(/(?:\/+v1)+$/i, '')
    .replace(/\/+$/, '');
  return normalized || resolvedFallback;
}

export interface ServerConfig {
  port: number;
  host: string;
  appVersion: string;
  dataDir: string;
  mediaDir: string;
  uploadsDir: string;
  webDistDir: string;
  fabushiAssetsDir: string;
  enableTestReset: boolean;
  /**
   * When true, seeds deterministic demo users/chats/wallets/sandboxes (test/dev ONLY).
   * Always false in real production unless explicitly opted in via `SEED_DEMO_DATA=1` or `ENABLE_TEST_RESET=1`.
   */
  seedDemoData: boolean;
  /**
   * When true, permits 1-click demo login and simulated QR/Alipay/Passkey shortcuts.
   * Always false in production unless explicitly opted in.
   */
  allowDemoAuth: boolean;
  /**
   * When true, exposes deterministic OTP `dev_code` in send-code responses (test/dev ONLY).
   * Always false in production.
   */
  exposeDevOtpCode: boolean;
  /**
   * Optional upstream `gpui_telegram_server` URL (e.g. `https://your-upstream-server.example.com`).
   * When set, this server acts as an HTTPS/HTTP + SSE + WebSocket reverse proxy while serving the SPA.
   */
  upstreamServerUrl: string | null;
  /** Whether `/api/v1/browser/ws` upgrades should also be proxied upstream (`PROXY_BROWSER_WS=1`). */
  proxyBrowserWs: boolean;
  /** Canonical cloud gateway URL (`FABUSHI_CLOUD_GATEWAY_URL ?? OMBHRUM_API_URL`, default `https://api.ombhrum.com`). */
  cloudGatewayUrl: string;
  /** Official cloud OAuth gateway URL (alias of `cloudGatewayUrl` kept for backward compatibility). */
  oauthGatewayUrl: string;
  /** Official cloud AI gateway URL (`FABUSHI_AI_GATEWAY_URL ?? AI_GATEWAY_URL`, normalized without trailing `/v1`). */
  aiGatewayUrl: string;
  /** Optional SMTP/HTTP mail delivery webhook for real email OTP delivery. */
  mailWebhookUrl: string | null;
  /** Optional SMS delivery webhook for real phone OTP delivery. */
  smsWebhookUrl: string | null;
  masterSecret: Buffer;
  /** TURN HMAC secret (raw UTF-8 `TURN_SECRET` bytes matching coturn `static-auth-secret`, or `masterSecret` fallback). */
  turnSecret: Buffer;
}

export interface ServerConfigOverrides {
  port?: number;
  host?: string;
  appVersion?: string;
  dataDir?: string;
  webDistDir?: string;
  fabushiAssetsDir?: string;
  enableTestReset?: boolean;
  seedDemoData?: boolean;
  allowDemoAuth?: boolean;
  exposeDevOtpCode?: boolean;
  upstreamServerUrl?: string | null;
  proxyBrowserWs?: boolean;
  cloudGatewayUrl?: string;
  oauthGatewayUrl?: string;
  aiGatewayUrl?: string;
  mailWebhookUrl?: string | null;
  smsWebhookUrl?: string | null;
  masterSecretHex?: string;
  turnSecret?: string | Buffer;
}

function resolveFabushiAssetsDir(
  webDistDir: string,
  overrideDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const candidates = [
    overrideDir,
    env.FABUSHI_ASSETS_DIR,
    path.join(webDistDir, 'miniapps/fabushi-globe'),
    path.join(REPO_ROOT_DIR, 'apps/web/public/miniapps/fabushi-globe'),
  ].filter((p): p is string => Boolean(p && p.trim()));

  for (const dir of candidates) {
    const resolved = path.resolve(dir);
    if (fs.existsSync(path.join(resolved, 'fabushi_miniapp.wasm'))) {
      return resolved;
    }
  }
  return path.resolve(
    overrideDir ?? path.join(REPO_ROOT_DIR, 'apps/web/public/miniapps/fabushi-globe'),
  );
}

export function resolveServerConfig(
  overrides: ServerConfigOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const portEnv = nonEmpty(env.PORT);
  const portRaw = overrides.port ?? (portEnv !== undefined ? Number(portEnv) : 4173);
  const port = Number.isInteger(portRaw) && portRaw >= 0 && portRaw <= 65535 ? portRaw : 4173;
  const host = nonEmpty(overrides.host) ?? nonEmpty(env.HOST) ?? '127.0.0.1';
  const appVersion =
    nonEmpty(overrides.appVersion) ?? nonEmpty(env.APP_VERSION) ?? DEFAULT_APP_VERSION;

  const dataDir = path.resolve(
    nonEmpty(overrides.dataDir) ?? nonEmpty(env.DATA_DIR) ?? path.join(REPO_ROOT_DIR, 'data'),
  );
  const mediaDir = path.join(dataDir, 'media');
  const uploadsDir = path.join(dataDir, 'uploads');
  const webDistDir = path.resolve(
    nonEmpty(overrides.webDistDir) ??
      nonEmpty(env.WEB_DIST_DIR) ??
      path.join(REPO_ROOT_DIR, 'apps/web/dist'),
  );
  const fabushiAssetsDir = resolveFabushiAssetsDir(webDistDir, overrides.fabushiAssetsDir, env);

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.mkdirSync(uploadsDir, { recursive: true });

  const enableTestReset = overrides.enableTestReset ?? env.ENABLE_TEST_RESET === '1';
  const seedDemoData =
    overrides.seedDemoData ?? (enableTestReset || env.SEED_DEMO_DATA === '1');
  const allowDemoAuth =
    overrides.allowDemoAuth ?? (enableTestReset || seedDemoData || env.ALLOW_DEMO_AUTH === '1');
  const exposeDevOtpCode =
    overrides.exposeDevOtpCode ?? (enableTestReset || env.EXPOSE_DEV_OTP_CODE === '1');

  const rawUpstream =
    overrides.upstreamServerUrl !== undefined
      ? overrides.upstreamServerUrl
      : env.UPSTREAM_SERVER_URL ?? null;
  const upstreamServerUrl = nonEmptyUrl(rawUpstream) ?? null;

  const proxyBrowserWs = overrides.proxyBrowserWs ?? env.PROXY_BROWSER_WS === '1';

  const cloudGatewayUrl =
    nonEmptyUrl(overrides.cloudGatewayUrl) ??
    nonEmptyUrl(overrides.oauthGatewayUrl) ??
    nonEmptyUrl(env.FABUSHI_CLOUD_GATEWAY_URL) ??
    nonEmptyUrl(env.OMBHRUM_API_URL) ??
    DEFAULT_CLOUD_GATEWAY_URL;
  const oauthGatewayUrl = cloudGatewayUrl;

  const aiGatewayUrl = normalizeAiGatewayBaseUrl(
    nonEmptyUrl(overrides.aiGatewayUrl) ??
      nonEmptyUrl(env.FABUSHI_AI_GATEWAY_URL) ??
      nonEmptyUrl(env.AI_GATEWAY_URL),
  );

  const mailWebhookUrl =
    overrides.mailWebhookUrl !== undefined
      ? overrides.mailWebhookUrl
      : nonEmpty(env.AUTH_SYSTEM_MAIL_URL) ?? null;

  const smsWebhookUrl =
    overrides.smsWebhookUrl !== undefined
      ? overrides.smsWebhookUrl
      : nonEmpty(env.AUTH_SYSTEM_SMS_URL) ?? null;

  const secretFilePath = path.join(dataDir, '.master-secret');
  let masterSecret: Buffer;
  const envSecret =
    nonEmpty(overrides.masterSecretHex) ??
    nonEmpty(env.GPUI_MASTER_SECRET) ??
    nonEmpty(env.SESSION_SECRET);
  if (envSecret) {
    masterSecret = crypto.createHash('sha256').update(envSecret).digest();
  } else if (fs.existsSync(secretFilePath)) {
    masterSecret = Buffer.from(fs.readFileSync(secretFilePath, 'utf8').trim(), 'hex');
    if (masterSecret.length !== 32) {
      masterSecret = crypto.randomBytes(32);
      fs.writeFileSync(secretFilePath, masterSecret.toString('hex'), { mode: 0o600 });
    }
  } else {
    masterSecret = crypto.randomBytes(32);
    fs.writeFileSync(secretFilePath, masterSecret.toString('hex'), { mode: 0o600 });
  }

  let turnSecret: Buffer;
  if (Buffer.isBuffer(overrides.turnSecret) && overrides.turnSecret.length > 0) {
    turnSecret = overrides.turnSecret;
  } else {
    const rawTurn =
      (typeof overrides.turnSecret === 'string' ? nonEmpty(overrides.turnSecret) : undefined) ??
      nonEmpty(env.TURN_SECRET);
    turnSecret = rawTurn ? Buffer.from(rawTurn, 'utf8') : masterSecret;
  }

  return {
    port,
    host,
    appVersion,
    dataDir,
    mediaDir,
    uploadsDir,
    webDistDir,
    fabushiAssetsDir,
    enableTestReset,
    seedDemoData,
    allowDemoAuth,
    exposeDevOtpCode,
    upstreamServerUrl,
    proxyBrowserWs,
    cloudGatewayUrl,
    oauthGatewayUrl,
    aiGatewayUrl,
    mailWebhookUrl,
    smsWebhookUrl,
    masterSecret,
    turnSecret,
  };
}

export const loadServerConfig = resolveServerConfig;
