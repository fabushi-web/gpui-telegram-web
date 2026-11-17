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
  enableTestReset: boolean;
  masterSecret: Buffer;
}

export interface ServerConfigOverrides {
  port?: number;
  host?: string;
  dataDir?: string;
  webDistDir?: string;
  enableTestReset?: boolean;
  masterSecretHex?: string;
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

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.mkdirSync(uploadsDir, { recursive: true });

  const enableTestReset =
    overrides.enableTestReset ?? process.env.ENABLE_TEST_RESET === '1';

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
    enableTestReset,
    masterSecret,
  };
}
