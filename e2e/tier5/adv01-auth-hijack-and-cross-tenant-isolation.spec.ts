import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  assertNoDemoAuthControls,
  DOM,
  expect,
  getBaseUrl,
  NAV_DESTS,
  openBurgerMenu,
  openNavDestination,
  registerAndLoginUser,
  registerUserViaApi,
  test,
} from '../helpers';

test.describe('Tier 5 Adversarial — Auth Hijack, Cross-Tenant Isolation & Multi-Tab Sync (F-01, F-03, F-07)', () => {
  test('ADV01-01 (F-01): ?server= query parameter cannot hijack an authenticated session or poison localStorage', async ({
    authSession,
  }) => {
    const { page, user } = authSession;
    const baseUrl = getBaseUrl();

    const capturedAuthHeaders: string[] = [];
    const capturedWsTokens: string[] = [];
    const trapServer = http.createServer((req, res) => {
      const auth = req.headers.authorization;
      if (auth) capturedAuthHeaders.push(auth);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      });
      res.end(JSON.stringify({ ok: true }));
    });
    trapServer.on('upgrade', (req, socket) => {
      const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
      const tok = parsed.searchParams.get('token');
      if (tok) capturedWsTokens.push(tok);
      socket.destroy();
    });

    await new Promise<void>((resolve) => trapServer.listen(0, '127.0.0.1', resolve));
    const trapPort = (trapServer.address() as AddressInfo).port;
    const trapOrigin = `http://127.0.0.1:${trapPort}`;

    try {
      await page.goto(`${baseUrl}/?server=${encodeURIComponent(trapOrigin)}`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.locator(DOM.appShell)).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(800);

      expect(capturedAuthHeaders).toEqual([]);
      expect(capturedWsTokens).toEqual([]);

      const stored = await page.evaluate(() => {
        const raw = localStorage.getItem('gpui_tg_auth_v1');
        return raw
          ? (JSON.parse(raw) as { serverUrl?: string; accounts?: Array<{ serverUrl?: string }> })
          : null;
      });
      expect(stored).not.toBeNull();
      expect(stored?.serverUrl).not.toBe(trapOrigin);
      for (const acc of stored?.accounts ?? []) {
        expect(acc.serverUrl).not.toBe(trapOrigin);
      }

      expect(page.url()).not.toContain('server=');
      await expect(page.locator(DOM.appShell)).toBeVisible();
      expect(user.token.length).toBeGreaterThan(10);
    } finally {
      await new Promise<void>((resolve) => trapServer.close(() => resolve()));
    }
  });

  test('ADV01-02 (F-03): Full logout purges bot token, MiniApp PiP, browser control consent/pairing, and passcode across tenants', async ({
    authSession,
  }) => {
    const { page } = authSession;

    // 1. User A launches Fabushi Globe MiniApp and minimizes to PiP
    await openBurgerMenu(page);
    await page
      .locator(DOM.mainMenuDrawer)
      .getByRole('menuitem', { name: /mini\s*app|小程序/i })
      .first()
      .click();
    await expect(page.locator('#miniapp-catalog-modal')).toBeVisible();

    await page
      .locator('#miniapp-catalog-modal')
      .getByRole('button', { name: /launch|启动/i })
      .first()
      .click();
    await expect(page.locator(DOM.miniappModal)).toBeVisible();
    await page.locator('[data-testid="miniapp-minimize-pip-btn"]').click();
    await expect(page.locator(DOM.miniappPipOverlay)).toBeVisible();

    // 2. Enable desktop browser control opt-in & generate pairing ticket
    await openNavDestination(page, 'browser');
    await page
      .locator(DOM.browserWorkspaceAny)
      .getByRole('tab', { name: /session|pairing|会话/i })
      .or(page.locator(DOM.browserWorkspaceAny).getByRole('button', { name: /session|pairing|会话/i }))
      .first()
      .click();
    const toggle = page.locator('#browser-control-workspace input[type="checkbox"]').first();
    await expect(toggle).toBeVisible();
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect(toggle).toBeChecked();
    await page.locator(DOM.btnBrowserPairDesktop).click();
    await expect(page.locator(DOM.browserPairingCodeDisplay)).toBeVisible();
    const userAPairCode = (await page.locator(DOM.browserPairingCodeDisplay).innerText()).trim();
    expect(userAPairCode.length).toBeGreaterThan(3);

    // 3. Set local passcode in Settings
    await page.keyboard.press('Control+,');
    await expect(page.locator(DOM.settingsPanel)).toBeVisible();
    await page
      .locator(DOM.settingsPanel)
      .getByRole('button', { name: /passcode|本地密码锁/i })
      .first()
      .click();
    await page.locator(`${DOM.settingsPanel} input[type="password"]`).first().fill('2468');
    await page
      .locator(DOM.settingsPanel)
      .getByRole('button', { name: /save passcode|保存密码/i })
      .click();
    await page.keyboard.press('Escape');

    // 4. Logout User A cleanly
    await openBurgerMenu(page);
    await page.locator(DOM.menuItemLogout).click();
    await expect(page.locator(DOM.authScreen)).toBeVisible();
    await assertNoDemoAuthControls(page);

    // 5. Register & login fresh User B on the exact same browser tab (zero full reload)
    await registerAndLoginUser(page);
    await expect(page.locator(DOM.appShell)).toBeVisible();

    // (a) User A's PiP MiniApp must NOT leak into User B
    await expect(page.locator(DOM.miniappPipOverlay)).toHaveCount(0);

    // (b) User A's Browser Control opt-in & pairing code must NOT leak into User B
    await openNavDestination(page, 'browser');
    await page
      .locator(DOM.browserWorkspaceAny)
      .getByRole('tab', { name: /session|pairing|会话/i })
      .or(page.locator(DOM.browserWorkspaceAny).getByRole('button', { name: /session|pairing|会话/i }))
      .first()
      .click();
    await expect(page.locator('#browser-control-workspace input[type="checkbox"]').first()).not.toBeChecked();
    await expect(page.locator(DOM.browserPairingCodeDisplay)).toHaveCount(0);
    const browserBodyText = await page.locator(DOM.browserControlWorkspace).innerText();
    expect(browserBodyText).not.toContain(userAPairCode);

    // (c) User A's local passcode must NOT lock out User B
    await page.keyboard.press('Control+Shift+L');
    await page.waitForTimeout(250);
    await expect(page.locator(DOM.passcodeLockScreen)).toHaveCount(0);
    await expect(page.locator(DOM.appShell)).toBeVisible();
  });

  test('ADV01-03 (F-07): Multi-tab account switch synchronizes active account across open tabs via BroadcastChannel', async ({
    authSession,
    request,
    openSecondTab,
  }) => {
    const { page: tab1, user: userA } = authSession;
    const userB = await registerUserViaApi(request, { firstName: 'MultiB' });

    // Add User B into the same browser session via Account Switcher
    await openBurgerMenu(tab1);
    await tab1.locator(DOM.menuAccountSwitcher).click();
    await tab1.locator('[data-testid="btn-add-account"]').click();
    await expect(tab1.locator(DOM.authScreen)).toBeVisible();

    await tab1.locator(DOM.tabAuthPassword).click();
    await tab1.locator(DOM.authUsernameInput).fill(userB.username);
    await tab1.locator(DOM.authPasswordInput).fill(userB.password);
    await tab1.locator(DOM.btnAuthPasswordSubmit).click();
    await expect(tab1.locator(DOM.appShell)).toBeVisible({ timeout: 10_000 });

    // Open Tab 2 while User B is active
    const tab2 = await openSecondTab();
    await expect(tab2.locator(DOM.appShell)).toBeVisible({ timeout: 10_000 });
    await openBurgerMenu(tab2);
    await expect(tab2.locator(DOM.mainMenuDrawer)).toContainText(`@${userB.username}`);
    await tab2.keyboard.press('Escape');

    // Switch Tab 1 back to User A
    await openBurgerMenu(tab1);
    await tab1.locator(DOM.menuAccountSwitcher).click();
    await tab1
      .locator(DOM.mainMenuDrawer)
      .getByRole('menuitem', { name: new RegExp(`@${userA.username}`, 'i') })
      .click();

    // Tab 2 must synchronize to User A via BroadcastChannel auth_switched
    await expect
      .poll(
        async () => {
          return tab2.evaluate(() => {
            const raw = localStorage.getItem('gpui_tg_auth_v1');
            if (!raw) return '';
            const parsed = JSON.parse(raw) as {
              activeAccountId?: string;
              accounts?: Array<{ accountId: string; user?: { username?: string } }>;
            };
            const active = parsed.accounts?.find((a) => a.accountId === parsed.activeAccountId);
            return active?.user?.username ?? '';
          });
        },
        { timeout: 5_000 },
      )
      .toBe(userA.username);

    await expect
      .poll(
        async () => {
          await openBurgerMenu(tab2);
          const text = await tab2.locator(DOM.mainMenuDrawer).innerText();
          await tab2.keyboard.press('Escape');
          return text;
        },
        { timeout: 6_000 },
      )
      .toContain(`@${userA.username}`);

    expect(NAV_DESTS.chats).toBeTruthy();
  });
});
