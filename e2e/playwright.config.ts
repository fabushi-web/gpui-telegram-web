import * as fs from 'node:fs';
import { defineConfig } from '@playwright/test';
import { getBaseUrl } from './helpers/server';

const E2E_ROOT = '/home/antigravity/gpui-telegram-web/e2e';
const E2E_DATA_DIR = `${E2E_ROOT}/.e2e-data`;
const E2E_TMP_DIR = `${E2E_DATA_DIR}/tmp`;

// Redirect temporary browser/runner artifacts strictly into e2e/.e2e-data/tmp (never /tmp).
fs.mkdirSync(E2E_TMP_DIR, { recursive: true });
process.env.TMPDIR = E2E_TMP_DIR;
process.env.TMP = E2E_TMP_DIR;
process.env.TEMP = E2E_TMP_DIR;

const rawEnvBaseUrl = process.env.E2E_BASE_URL?.trim();
const baseURL = getBaseUrl();

const workers = process.env.PLAYWRIGHT_WORKERS
  ? Number(process.env.PLAYWRIGHT_WORKERS)
  : process.env.CI
    ? 1
    : 2;

const isListMode = process.argv.includes('--list');

export default defineConfig({
  testDir: '.',
  testMatch: [
    'tier1/**/*.spec.ts',
    'tier2/**/*.spec.ts',
    'tier3/**/*.spec.ts',
    'tier4/**/*.spec.ts',
    'tier5/**/*.spec.ts',
  ],
  outputDir: '/home/antigravity/gpui-telegram-web/e2e/test-results',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers,
  timeout: 30_000,
  expect: {
    timeout: 8_000,
  },
  reporter: isListMode
    ? [['list']]
    : [
        ['list'],
        [
          'html',
          {
            outputFolder: '/home/antigravity/gpui-telegram-web/e2e/playwright-report',
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
      executablePath: '/usr/lib/chromium/chromium',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--use-fake-ui-for-media-stream',
      ],
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
        command:
          'PORT=4173 HOST=127.0.0.1 ENABLE_TEST_RESET=1 DATA_DIR=/home/antigravity/gpui-telegram-web/e2e/.e2e-data npm --prefix /home/antigravity/gpui-telegram-web start',
        url: 'http://127.0.0.1:4173/api/v1/health',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
