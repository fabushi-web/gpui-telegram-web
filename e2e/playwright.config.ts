import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium, defineConfig } from '@playwright/test';
import {
  CHROMIUM_LAUNCH_ARGS,
  getBaseUrl,
  resolveChromiumExecutablePath,
} from './helpers/server';

const E2E_ROOT = path.resolve(__dirname);
const REPO_ROOT = path.resolve(E2E_ROOT, '..');
const E2E_DATA_DIR = path.join(E2E_ROOT, '.e2e-data');
const requestedTmpDir = process.env.E2E_TMP_DIR?.trim();
const resolvedRequested = requestedTmpDir ? path.resolve(requestedTmpDir) : '';
const E2E_TMP_DIR =
  resolvedRequested && resolvedRequested.startsWith(E2E_DATA_DIR + path.sep)
    ? resolvedRequested
    : path.join(E2E_DATA_DIR, 'tmp');

const isListMode = process.argv.includes('--list');

// Redirect temporary browser/runner artifacts strictly into e2e/.e2e-data (never /tmp).
if (!isListMode) {
  fs.mkdirSync(E2E_TMP_DIR, { recursive: true });
}
process.env.TMPDIR = E2E_TMP_DIR;
process.env.TMP = E2E_TMP_DIR;
process.env.TEMP = E2E_TMP_DIR;

const rawEnvBaseUrl = process.env.E2E_BASE_URL?.trim();
const baseURL = getBaseUrl();

const parsedWorkers = process.env.PLAYWRIGHT_WORKERS
  ? Number(process.env.PLAYWRIGHT_WORKERS)
  : 1;
const workers =
  Number.isInteger(parsedWorkers) && parsedWorkers >= 1 ? parsedWorkers : 1;

const parsedExpectTimeout = process.env.E2E_EXPECT_TIMEOUT_MS
  ? Number(process.env.E2E_EXPECT_TIMEOUT_MS)
  : 8_000;
const expectTimeout =
  Number.isFinite(parsedExpectTimeout) && parsedExpectTimeout >= 500
    ? parsedExpectTimeout
    : 8_000;

let bundledChromiumPath: string | undefined;
try {
  bundledChromiumPath = chromium.executablePath();
} catch {
  bundledChromiumPath = undefined;
}
const resolvedExecutablePath = resolveChromiumExecutablePath(bundledChromiumPath);

const webServerEnv = Object.fromEntries(
  Object.entries({
    ...process.env,
    PORT: '4173',
    HOST: '127.0.0.1',
    ENABLE_TEST_RESET: '1',
    DATA_DIR: E2E_DATA_DIR,
    TMPDIR: E2E_TMP_DIR,
    TMP: E2E_TMP_DIR,
    TEMP: E2E_TMP_DIR,
  }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
);

export default defineConfig({
  testDir: '.',
  testMatch: [
    'tier1/**/*.spec.ts',
    'tier2/**/*.spec.ts',
    'tier3/**/*.spec.ts',
    'tier4/**/*.spec.ts',
    'tier5/**/*.spec.ts',
  ],
  outputDir: path.join(E2E_ROOT, 'test-results'),
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers,
  timeout: 30_000,
  expect: {
    timeout: expectTimeout,
  },
  reporter: isListMode
    ? [['list']]
    : [
        ['list'],
        [
          'html',
          {
            outputFolder: path.join(E2E_ROOT, 'playwright-report'),
            open: 'never',
          },
        ],
      ],
  use: {
    baseURL,
    headless: true,
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    launchOptions: {
      ...(resolvedExecutablePath ? { executablePath: resolvedExecutablePath } : {}),
      args: [...CHROMIUM_LAUNCH_ARGS],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
      },
    },
  ],
  webServer: rawEnvBaseUrl
    ? undefined
    : {
        command: 'npm start',
        cwd: REPO_ROOT,
        env: webServerEnv,
        url: 'http://127.0.0.1:4173/api/v1/health',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
