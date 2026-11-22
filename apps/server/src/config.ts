import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT_DIR = path.resolve(currentDir, '../../..');

export interface ServerConfig {
  port: number;
  host: string;
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
   * Optional upstream `gpui_telegram_server` URL (e.g. `http://34.46.77.133:8080`).
   * When set, this server acts as an HTTPS/HTTP + SSE + WebSocket reverse proxy while serving the SPA.
   */
  upstreamServerUrl: string | null;
  /** Official cloud OAuth gateway URL (matching desktop `FABUSHI_CLOUD_GATEWAY_URL`, default `https://api.ombhrum.com`). */
  oauthGatewayUrl: string;
  /** Official cloud AI gateway URL (matching desktop `FABUSHI_AI_GATEWAY_URL`, default `https://ai.ombhrum.com`). */
  aiGatewayUrl: string;
  /** Optional SMTP/HTTP mail delivery webhook for real email OTP delivery. */
  mailWebhookUrl: string | null;
  /** Optional SMS delivery webhook for real phone OTP delivery. */
  smsWebhookUrl: string | null;
  masterSecret: Buffer;
}

export interface ServerConfigOverrides {
  port?: number;
  host?: string;
  dataDir?: string;
  webDistDir?: string;
  fabushiAssetsDir?: string;
  enableTestReset?: boolean;
  seedDemoData?: boolean;
  allowDemoAuth?: boolean;
  exposeDevOtpCode?: boolean;
  upstreamServerUrl?: string | null;
  oauthGatewayUrl?: string;
  aiGatewayUrl?: string;
  mailWebhookUrl?: string | null;
  smsWebhookUrl?: string | null;
  masterSecretHex?: string;
}

function resolveFabushiAssetsDir(webDistDir: string, overrideDir?: string): string {
  const candidates = [
    overrideDir,
    process.env.FABUSHI_ASSETS_DIR,
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

export function resolveServerConfig(overrides: ServerConfigOverrides = {}): ServerConfig {
  const portRaw = overrides.port ?? (process.env.PORT !== undefined ? Number(process.env.PORT) : 4173);
  const port = Number.isFinite(portRaw) && portRaw >= 0 ? Math.trunc(portRaw) : 4173;
  const host = overrides.host ?? process.env.HOST ?? '127.0.0.1';

  const dataDir = path.resolve(
    overrides.dataDir ?? process.env.DATA_DIR ?? path.join(REPO_ROOT_DIR, 'data'),
  );
  const mediaDir = path.join(dataDir, 'media');
  const uploadsDir = path.join(dataDir, 'uploads');
  const webDistDir = path.resolve(
    overrides.webDistDir ?? process.env.WEB_DIST_DIR ?? path.join(REPO_ROOT_DIR, 'apps/web/dist'),
  );
  const fabushiAssetsDir = resolveFabushiAssetsDir(webDistDir, overrides.fabushiAssetsDir);

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.mkdirSync(uploadsDir, { recursive: true });

  const enableTestReset =
    overrides.enableTestReset ?? process.env.ENABLE_TEST_RESET === '1';
  const seedDemoData =
    overrides.seedDemoData ??
    (enableTestReset || process.env.SEED_DEMO_DATA === '1');
  const allowDemoAuth =
    overrides.allowDemoAuth ??
    (enableTestReset || seedDemoData || process.env.ALLOW_DEMO_AUTH === '1');
  const exposeDevOtpCode =
    overrides.exposeDevOtpCode ??
    (enableTestReset || process.env.EXPOSE_DEV_OTP_CODE === '1');

  const rawUpstream =
    overrides.upstreamServerUrl !== undefined
      ? overrides.upstreamServerUrl
      : process.env.UPSTREAM_SERVER_URL ?? null;
  const upstreamServerUrl =
    rawUpstream && rawUpstream.trim()
      ? rawUpstream.trim().replace(/\/+$/, '')
      : null;

  const oauthGatewayUrl = (
    overrides.oauthGatewayUrl ??
    process.env.FABUSHI_CLOUD_GATEWAY_URL ??
    'https://api.ombhrum.com'
  )
    .trim()
    .replace(/\/+$/, '');

  const aiGatewayUrl = (
    overrides.aiGatewayUrl ??
    process.env.FABUSHI_AI_GATEWAY_URL ??
    'https://ai.ombhrum.com'
  )
    .trim()
    .replace(/\/+$/, '');

  const mailWebhookUrl =
    overrides.mailWebhookUrl !== undefined
      ? overrides.mailWebhookUrl
      : process.env.AUTH_SYSTEM_MAIL_URL?.trim() || null;

  const smsWebhookUrl =
    overrides.smsWebhookUrl !== undefined
      ? overrides.smsWebhookUrl
      : process.env.AUTH_SYSTEM_SMS_URL?.trim() || null;

  const secretFilePath = path.join(dataDir, '.master-secret');
  let masterSecret: Buffer;
  const envSecret = overrides.masterSecretHex ?? process.env.GPUI_MASTER_SECRET;
  if (envSecret && envSecret.length >= 32) {
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

  return {
    port,
    host,
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
    oauthGatewayUrl,
    aiGatewayUrl,
    mailWebhookUrl,
    smsWebhookUrl,
    masterSecret,
  };
}
