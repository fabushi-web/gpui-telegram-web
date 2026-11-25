import { test, expect } from '../helpers/fixtures';
import { API_PATHS, DOM } from '../helpers/selectors';
import {
  apiUrl,
  authHeaders,
  createRealConversationFixture,
  registerUserViaApi,
} from '../helpers/server';
import {
  buildSampleBrowserActionTrace,
  buildValidAutomationAppManifest,
  generateRandomB64,
} from '../helpers/api';
import {
  bilingualRegex,
  ensureDarkThemeAndAssertNoPurple,
  openBurgerMenu,
  openRightInspector,
  scopedButton,
  selectChat,
  sendTextMessage,
} from '../helpers/ui';
import { createTextFilePayload } from '../helpers/media';

test.describe('Tier 3 — PW06: Browser Distillation + Vault Secret Binding, Call + Secret Chat & Offline + Channel Export', () => {
  test('PW-16 (A15 x A08 x A02): Built-in Browser Script Distillation -> Secret Leak 422 caught -> Vault secret binding -> clean App Store publish & deterministic replay', async ({
    request,
  }) => {
    const author = await registerUserViaApi(request);
    const headers = authHeaders(author.token);

    // 1. Store real encrypted secret in User Vault
    const vaultRes = await request.put(
      apiUrl(`${API_PATHS.vaultItems}/password/example_portal_password`),
      {
        headers,
        data: { nonce_b64: generateRandomB64(12), ciphertext_b64: generateRandomB64(64) },
      },
    );
    expect(vaultRes.status()).toBe(200);

    // 2. Attempt to publish manifest with raw hardcoded key -> blocked with 422 secret_leak_detected
    const leaky = buildValidAutomationAppManifest({
      steps: [
        {
          kind: 'fill',
          locator: { css_selector: 'input[type="password"]' },
          value_template: 'sk-live-secretleak1234567890abcdef',
        },
      ],
    });
    const leakRes = await request.post(apiUrl(API_PATHS.automationApps), {
      headers,
      data: { manifest: leaky, is_published: true },
      failOnStatusCode: false,
    });
    expect(leakRes.status()).toBe(422);
    expect(((await leakRes.json()) as { error?: string }).error).toBe('secret_leak_detected');

    // 3. Distill recorded BrowserActionTrace (scrubbing raw password -> secret_vault_key) & publish cleanly
    const distillRes = await request.post(apiUrl(API_PATHS.browserScriptsDistill), {
      headers,
      data: {
        trace: buildSampleBrowserActionTrace(),
        metadata: {
          name: 'Vault-Bound Portal Runner',
          description: 'Clean vault-bound distilled automation app',
          category: 'productivity',
          target_domains: ['example.com'],
        },
      },
    });
    expect([200, 201]).toContain(distillRes.status());
    const distilledBody = (await distillRes.json()) as {
      manifest?: Record<string, unknown>;
      app?: Record<string, unknown>;
    };
    const cleanManifest = distilledBody.manifest ?? distilledBody.app ?? distilledBody;
    const cleanSerialized = JSON.stringify(cleanManifest);
    expect(cleanSerialized).not.toContain('RawRecordedCredential99!');
    expect(cleanSerialized).toContain('example_portal_password');

    const cleanPub = await request.post(apiUrl(API_PATHS.automationApps), {
      headers,
      data: { manifest: cleanManifest, is_published: true },
    });
    expect(cleanPub.status()).toBe(201);
    const published = (await cleanPub.json()) as {
      app_id: string;
      content_sha256?: string;
    };
    expect(published.content_sha256).toMatch(/^[a-f0-9]{64}$/i);

    // 4. Record zero-LLM deterministic replay run
    const runRes = await request.post(
      apiUrl(`${API_PATHS.automationApps}/${published.app_id}/runs`),
      {
        headers,
        data: {
          version: '1.0.0',
          success: true,
          steps_executed: 5,
          total_duration_ms: 320,
          used_llm: false,
        },
      },
    );
    expect(runRes.status()).toBe(200);
    const runBody = (await runRes.json()) as { run_count?: unknown };
    expect(typeof runBody.run_count).toBe('number');
    expect(runBody.run_count).toBe(1);
  });

  test('PW-17 (A07 x A06 x A02): WebRTC Video Call minimized to #top-call-bar while switching themes & opening E2EE Secret Chat', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.dmTitle);

    await page.locator(DOM.btnStartVideoCall).click();
    const callOverlay = page.locator(DOM.callOverlay);
    await expect(callOverlay).toBeVisible();

    await scopedButton(callOverlay, bilingualRegex('minimize|collapse|back', '最小化|收起'))
      .first()
      .click();
    const topCallBar = page.locator(DOM.topCallBar);
    await expect(topCallBar).toBeVisible();

    // Toggle theme while call remains active in #top-call-bar + unconditional dark anti-purple check
    const themeBefore = await page.evaluate(
      () => (document.documentElement.getAttribute('data-theme') ?? '').toLowerCase(),
    );
    await openBurgerMenu(page);
    await page.locator(DOM.menuToggleNightMode).click();
    const themeAfter = await page.evaluate(
      () => (document.documentElement.getAttribute('data-theme') ?? '').toLowerCase(),
    );
    expect(themeAfter).not.toBe(themeBefore);
    await ensureDarkThemeAndAssertNoPurple(page);

    // While #top-call-bar remains alive, open E2EE Secret Chat and send an encrypted message
    const rightCol = await openRightInspector(page);
    const secretBtn = scopedButton(
      rightCol,
      bilingualRegex('secret\\s*chat|start\\s*secret|encrypted\\s*chat', '加密聊天|私密聊天|发起加密'),
    ).first();
    await expect(secretBtn).toBeVisible();
    await secretBtn.click();

    await expect(
      page.locator(`${DOM.chatHeader}, ${DOM.middleColumn}`).first(),
    ).toContainText(/secret|e2ee|encrypted|加密|私密/i);
    await sendTextMessage(page, 'PW17_Secret_While_Call_Minimized');

    // Call bar stays alive; restore and hang up cleanly
    await expect(topCallBar).toBeVisible();
    await topCallBar.click();
    await expect(callOverlay).toBeVisible();
    await scopedButton(callOverlay, bilingualRegex('end|hang\\s*up|decline', '挂断|结束'))
      .first()
      .click();
    await expect(callOverlay).toBeHidden();
    await expect(topCallBar).toBeHidden();
  });

  test('PW-18 (A07 x A06 x A03): Offline queue Markdown + File -> reconnect idempotent delivery -> Broadcast Channel JSON/HTML export', async ({
    authSession,
    context,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token, {
      includeChannel: true,
      channelTitle: 'Export Audit Broadcast',
    });
    expect(conv.channelTitle).toBeTruthy();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.channelTitle!);

    await context.setOffline(true);
    await expect(page.locator(DOM.connectionStatusBanner)).toBeVisible({ timeout: 8_000 });
    const offlineMarker = `ChannelOfflinePost_PW18_${Date.now()}`;
    const offlinePost = `**${offlineMarker}**`;
    const composer = page.locator(DOM.messageComposerInput);
    await composer.fill(offlinePost);
    await composer.press('Enter');

    await context.setOffline(false);
    await expect(page.locator(DOM.connectionStatusBanner)).toBeHidden({ timeout: 10_000 });
    await expect(
      page.locator(DOM.messageList).locator(DOM.messageBubble).filter({ hasText: offlineMarker }),
    ).toHaveCount(1);

    // Upload a real text file once back online and assert it renders in timeline
    const [uploadRes] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes('/api/v1/media') && res.request().method() === 'POST',
      ),
      page
        .locator(DOM.fileUploadInput)
        .setInputFiles(
          createTextFilePayload('release-notes-pw18.txt', 'Fabushi Web 1.6.11 release notes'),
        ),
    ]);
    expect([200, 201]).toContain(uploadRes.status());
    await expect(page.locator(DOM.messageList)).toContainText('release-notes-pw18.txt');

    // Post another confirmed message and export BOTH JSON and HTML verifying real persisted messages
    const onlinePost = `ChannelOnlineConfirmed_PW18_${Date.now()}`;
    await sendTextMessage(page, onlinePost);
    await openRightInspector(page);

    const readDownload = async (btnSelector: string) => {
      const downloadPromise = page.waitForEvent('download');
      await page.locator(btnSelector).click();
      const dl = await downloadPromise;
      const stream = await dl.createReadStream();
      expect(stream).not.toBeNull();
      const chunks: Buffer[] = [];
      for await (const c of stream!) {
        chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      }
      return Buffer.concat(chunks).toString('utf8');
    };

    const exportedJson = await readDownload(DOM.btnExportChatJson);
    expect(exportedJson).toContain(offlineMarker);
    expect(exportedJson).toContain(onlinePost);

    const exportedHtml = await readDownload(DOM.btnExportChatHtml);
    expect(exportedHtml.toLowerCase()).toContain('<html');
    expect(exportedHtml).toContain(onlinePost);
  });
});
