import { test as base, expect, type Page } from '@playwright/test';
import { clearClientState, getBaseUrl, resetTestServer } from './server';
import { loginViaDemo } from './ui';

export interface E2EFixtureOptions {
  /**
   * When explicitly set via `test.use({ allowSandbox404: true })` for standalone
   * serverless sandbox specs, permits HTTP 404 from `POST /api/v1/test/reset`.
   * Defaults to `false` (strict fail-closed).
   */
  allowSandbox404: boolean;
}

export interface E2EFixtures extends E2EFixtureOptions {
  /** Auto-fixture resetting backend SQLite WAL & seeded state before each test. */
  resetServerHook: void;
  /** Pre-authenticated Page after full client+server reset and 1-click Demo login. */
  authPage: Page;
  /** Opens a second Page in the same BrowserContext at `/` for BroadcastChannel sync tests. */
  openSecondTab: () => Promise<Page>;
}

export const test = base.extend<E2EFixtures>({
  allowSandbox404: [false, { option: true }],

  resetServerHook: [
    async ({ request, allowSandbox404 }, use) => {
      await resetTestServer(request, { allowSandbox404 });
      await use();
    },
    { auto: true },
  ],

  authPage: async ({ page, request, allowSandbox404, resetServerHook: _resetHook }, use) => {
    await clearClientState(page);
    await resetTestServer(request, { allowSandbox404 });

    const baseUrl = getBaseUrl();
    await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
    await loginViaDemo(page);

    await use(page);
  },

  openSecondTab: async ({ context, resetServerHook: _resetHook }, use) => {
    const openedTabs: Page[] = [];
    const baseUrl = getBaseUrl();

    const openTab = async (): Promise<Page> => {
      const tab = await context.newPage();
      openedTabs.push(tab);
      await tab.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
      return tab;
    };

    try {
      await use(openTab);
    } finally {
      for (const tab of openedTabs.reverse()) {
        if (!tab.isClosed()) {
          await tab.close().catch(() => undefined);
        }
      }
    }
  },
});

export { expect };
