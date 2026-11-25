import {
  test as base,
  expect,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import {
  clearClientState,
  getBaseUrl,
  registerUserViaApi,
  resetTestServer,
  type RegisteredUserSession,
  type RegisterUserOptions,
} from './server';
import { loginWithPassword, registerAndLoginUser } from './ui';

export interface AuthSessionFixture {
  page: Page;
  user: RegisteredUserSession;
}

export interface SecondUserContextResult {
  context: BrowserContext;
  page: Page;
  user: RegisteredUserSession;
}

export interface E2EFixtures {
  /** Auto-fixture cleanly wiping backend SQLite WAL tables before each test. */
  resetServerHook: void;
  /** Newly registered real user signed in via browser UI with 0 chats (truthful empty state). */
  emptyAuthPage: Page;
  /** Newly registered real user signed in via browser UI after full clean reset. */
  authPage: Page;
  /** Real API-registered user signed into the UI, returning both Page and Bearer token. */
  authSession: AuthSessionFixture;
  /** Opens a second Page in the same BrowserContext at `/` for BroadcastChannel sync tests. */
  openSecondTab: () => Promise<Page>;
  /** Opens an isolated second BrowserContext logged in as a real second registered user. */
  openSecondUserContext: (
    options?: RegisterUserOptions,
  ) => Promise<SecondUserContextResult>;
}

export const test = base.extend<E2EFixtures>({
  resetServerHook: [
    async ({ request }, use) => {
      await resetTestServer(request);
      await use();
    },
    { auto: true },
  ],

  emptyAuthPage: async ({ page, request, resetServerHook: _resetHook }, use) => {
    await clearClientState(page);
    await resetTestServer(request);

    const baseUrl = getBaseUrl();
    await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
    await registerAndLoginUser(page);

    await use(page);
  },

  authPage: async ({ page, request, resetServerHook: _resetHook }, use) => {
    await clearClientState(page);
    await resetTestServer(request);

    const baseUrl = getBaseUrl();
    await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
    await registerAndLoginUser(page);

    await use(page);
  },

  authSession: async ({ page, request, resetServerHook: _resetHook }, use) => {
    await clearClientState(page);
    await resetTestServer(request);

    const user = await registerUserViaApi(request);
    const baseUrl = getBaseUrl();
    await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
    await loginWithPassword(page, user.username, user.password);

    await use({ page, user });
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

  openSecondUserContext: async ({ browser, request, resetServerHook: _resetHook }, use) => {
    const openedContexts: BrowserContext[] = [];
    const baseUrl = getBaseUrl();

    const openContext = async (
      options?: RegisterUserOptions,
    ): Promise<SecondUserContextResult> => {
      const user = await registerUserViaApi(request, options);
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        ignoreHTTPSErrors: true,
      });
      openedContexts.push(context);
      const page = await context.newPage();
      await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
      await loginWithPassword(page, user.username, user.password);
      return { context, page, user };
    };

    try {
      await use(openContext);
    } finally {
      for (const ctx of openedContexts.reverse()) {
        await ctx.close().catch(() => undefined);
      }
    }
  },
});

export { expect };
