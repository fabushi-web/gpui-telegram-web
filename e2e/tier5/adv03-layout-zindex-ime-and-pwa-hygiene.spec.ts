import {
  DOM,
  expect,
  getBaseUrl,
  openBurgerMenu,
  openNavDestination,
  openRightInspector,
  registerUserViaApi,
  test,
} from '../helpers';

test.describe('Tier 5 Adversarial — Layout Z-Index, CJK IME Safety, Zero-Fake Screenshot & PWA Hygiene (F-06, F-08, F-09, F-10)', () => {
  test('ADV03-01 (F-06): Settings panel renders above Right Inspector drawer at 1024x768 viewport', async ({
    authSession,
  }) => {
    const { page } = authSession;
    await page.setViewportSize({ width: 1024, height: 768 });

    await openBurgerMenu(page);
    await page.locator(DOM.menuItemSavedMessages).click();
    await expect(page.locator(DOM.chatHeader)).toBeVisible({ timeout: 8_000 });

    await openRightInspector(page);
    await expect(page.locator(DOM.rightColumn)).toBeVisible();

    await page.keyboard.press('Control+,');
    await expect(page.locator(DOM.settingsPanel)).toBeVisible();

    const hitCheck = await page.evaluate(() => {
      const settingsEl = document.getElementById('settings-panel');
      const rightEl = document.getElementById('right-column');
      if (!settingsEl || !rightEl) return { ok: false, reason: 'missing_elements' };
      const sRect = settingsEl.getBoundingClientRect();
      const probeX = Math.floor(sRect.right - 40);
      const probeY = Math.floor(sRect.top + sRect.height / 2);
      const hit = document.elementFromPoint(probeX, probeY);
      return {
        ok: Boolean(hit && settingsEl.contains(hit) && !rightEl.contains(hit)),
        hitId: hit?.id ?? '',
        hitTag: hit?.tagName ?? '',
      };
    });
    expect(hitCheck.ok).toBe(true);
  });

  test('ADV03-02 (F-08): CJK IME composition Enter does not prematurely submit Hermes Studio or Apple Compose Stage', async ({
    authSession,
    request,
  }) => {
    const { page } = authSession;
    const peer = await registerUserViaApi(request, { firstName: 'ImePeer' });

    // 1. Hermes Studio textarea CJK IME guard
    await openNavDestination(page, 'hermes');
    const hermesTextarea = page.locator('#hermes-studio-panel textarea').first();
    await expect(hermesTextarea).toBeVisible();

    let hermesTurnRequests = 0;
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes('/api/v1/fabushi/turns')) {
        hermesTurnRequests += 1;
      }
    });

    await hermesTextarea.fill('nihao');
    await hermesTextarea.evaluate((el) => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'ni' }));
      el.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 229,
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你好' }));
      el.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 229,
          isComposing: false,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await page.waitForTimeout(300);
    expect(hermesTurnRequests).toBe(0);
    await expect(hermesTextarea).toHaveValue('nihao');

    // 2. Apple Compose Stage CJK IME guard
    await openNavDestination(page, 'chats');
    await page.locator(DOM.btnNewChatFab).click();
    await expect(page.locator('#apple-compose-stage')).toBeVisible();

    const searchInput = page.locator('#apple-compose-stage input').first();
    await searchInput.fill(peer.username);
    const peerBtn = page
      .locator('#apple-compose-stage')
      .getByRole('button', { name: new RegExp(peer.username, 'i') })
      .first();
    await expect(peerBtn).toBeVisible({ timeout: 6_000 });
    await peerBtn.click();

    const composeInput = page.locator(`#apple-compose-stage ${DOM.messageComposerInput}`);
    await expect(composeInput).toBeVisible();

    let messagePostCount = 0;
    page.on('request', (req) => {
      if (req.method() === 'POST' && /\/api\/v1\/chats\/\d+\/messages/.test(req.url())) {
        messagePostCount += 1;
      }
    });

    await composeInput.fill('nihao');
    await composeInput.evaluate((el) => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'ni' }));
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你好' }));
      el.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 229,
          isComposing: false,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await page.waitForTimeout(300);
    expect(messagePostCount).toBe(0);
    await expect(page.locator('#apple-compose-stage')).toBeVisible();
    await expect(composeInput).toHaveValue('nihao');
  });

  test('ADV03-03 (F-09, F-10): Browser bridge rejects synthetic SVG wireframe screenshots, QR has no dark drop-shadow, and sw.js bypasses /health', async ({
    authSession,
    request,
  }) => {
    const { page } = authSession;
    const baseUrl = getBaseUrl();

    // 1. Browser bridge screenshot fails closed with zero synthetic SVG wireframe
    const shotResult = await page.evaluate(async () => {
      const bridge = (window as unknown as {
        __GPUI_TELEGRAM_BROWSER_BRIDGE__?: {
          executeCommand: (cmd: {
            action: string;
          }) => Promise<{ ok: boolean; screenshot_data_url?: string; error?: string }>;
        };
      }).__GPUI_TELEGRAM_BROWSER_BRIDGE__;
      if (!bridge) return { missing: true, ok: false, screenshot: '', error: '' };
      const res = await bridge.executeCommand({ action: 'screenshot' });
      return {
        missing: false,
        ok: res.ok,
        screenshot: res.screenshot_data_url ?? '',
        error: res.error ?? '',
      };
    });
    expect(shotResult.missing).toBe(false);
    expect(shotResult.ok).toBe(false);
    expect(shotResult.screenshot).not.toContain('data:image/svg+xml');
    expect(shotResult.error.toLowerCase()).toContain('cdp');

    // 2. sw.js must bypass /health and /healthz (never stale-cache health probes)
    const swRes = await request.get(`${baseUrl}/sw.js`);
    expect(swRes.status()).toBe(200);
    const swText = await swRes.text();
    expect(swText).toContain('fabushi-web-v5');
    expect(swText).toMatch(/health\|healthz/);

    // 3. Dark-theme QR code must have zero dark drop-shadow (box-shadow: none)
    await page.evaluate(() => {
      localStorage.removeItem('gpui_tg_auth_v1');
      document.documentElement.setAttribute('data-theme', 'night');
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator(DOM.authScreen)).toBeVisible();
    await page.locator(DOM.tabAuthQr).click();
    const qrSvg = page.locator(DOM.qrLoginSvg);
    await expect(qrSvg).toBeVisible();
    const qrShadow = await qrSvg.evaluate((el) => getComputedStyle(el).boxShadow);
    expect(qrShadow).toBe('none');
  });
});
