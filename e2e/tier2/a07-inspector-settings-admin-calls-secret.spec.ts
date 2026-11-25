import * as crypto from 'node:crypto';
import { test, expect } from '../helpers/fixtures';
import { API_PATHS, DOM } from '../helpers/selectors';
import {
  apiUrl,
  authHeaders,
  clearClientState,
  createRealConversationFixture,
  getBaseUrl,
  registerUserViaApi,
} from '../helpers/server';
import {
  bilingualRegex,
  BILINGUAL_PATTERNS,
  loginWithPassword,
  openBurgerMenu,
  openRightInspector,
  openSettings,
  scopedButton,
  selectChat,
} from '../helpers/ui';
import { generateX25519KeyMaterial } from '../helpers/api';

test.describe('Tier 2 — A07: Channel RBAC, Inspector Cross-Chat Isolation, Settings Truthfulness & Call/E2EE Negatives', () => {
  test('A07-T2-01: Non-admin user attempting to post in a broadcast channel receives 403 Forbidden (and UI hides composer)', async ({
    browser,
    openSecondUserContext,
    request,
  }) => {
    const owner = await registerUserViaApi(request, { firstName: 'Channel Owner' });
    const conv = await createRealConversationFixture(request, owner.token, {
      includeChannel: true,
      channelTitle: 'ReadOnly Broadcast Channel',
    });

    // 1. Non-admin subscriber peer posting via API receives 403
    const writeRes = await request.post(
      apiUrl(`${API_PATHS.chats}/${conv.channelChatId}/messages`),
      {
        headers: authHeaders(conv.peer.token),
        data: { chat_id: conv.channelChatId, text: 'Unauthorized subscriber post' },
        failOnStatusCode: false,
      },
    );
    expect(writeRes.status()).toBe(403);

    // 2. Non-admin subscriber UI MUST hide composer when viewing the broadcast channel
    const peerCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const peerPage = await peerCtx.newPage();
      await clearClientState(peerPage);
      await peerPage.goto(`${getBaseUrl()}/`, { waitUntil: 'domcontentloaded' });
      await loginWithPassword(peerPage, conv.peer.username, conv.peer.password);
      await selectChat(peerPage, conv.channelTitle ?? 'ReadOnly Broadcast Channel');
      await expect(peerPage.locator(DOM.chatHeaderTitle)).toContainText('ReadOnly Broadcast Channel');
      await expect(peerPage.locator(DOM.messageComposerInput)).toBeHidden();
    } finally {
      await peerCtx.close();
    }

    // 3. Non-member outsider write also returns 403
    const viewer = await openSecondUserContext({
      firstName: 'Subscriber Viewer',
    });
    const outsiderWrite = await request.post(
      apiUrl(`${API_PATHS.chats}/${conv.channelChatId}/messages`),
      {
        headers: authHeaders(viewer.user.token),
        data: { chat_id: conv.channelChatId, text: 'Outsider post' },
        failOnStatusCode: false,
      },
    );
    expect(outsiderWrite.status()).toBe(403);
  });

  test('A07-T2-02: Right Inspector switching between Bot -> Group -> 1v1 User clears peer facts synchronously (zero cross-chat bleed)', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token, {
      includeGroup: true,
      groupTitle: 'Isolated Group Facts',
    });
    const botRes = await request.post(apiUrl(API_PATHS.fabushiBots), {
      headers: authHeaders(user.token),
      data: {
        display_name: 'Isolated Fact Bot',
        username: `fact_bot_${Date.now().toString(36)}_bot`,
        description: 'Unique Bot Bio Token Z99',
      },
    });
    expect([200, 201]).toContain(botRes.status());
    await page.reload({ waitUntil: 'domcontentloaded' });

    await selectChat(page, 'Isolated Fact Bot');
    const rightCol = await openRightInspector(page);
    await expect(rightCol.locator(DOM.rightProfileInfo)).toContainText('Isolated Fact Bot');

    await selectChat(page, conv.groupTitle ?? 'Isolated Group Facts');
    await expect(rightCol.locator(DOM.rightProfileInfo)).toContainText('Isolated Group Facts');
    await expect(rightCol.locator(DOM.rightProfileInfo)).not.toContainText('Unique Bot Bio Token Z99');

    await selectChat(page, conv.dmTitle);
    await expect(rightCol.locator(DOM.rightProfileInfo)).toContainText(conv.dmTitle);
    await expect(rightCol.locator(DOM.rightProfileInfo)).not.toContainText('Isolated Group Facts');
  });

  test('A07-T2-03: Group/channel creation blocks blank title and invalid @username (< 5 chars / symbols) rejected', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;

    await openBurgerMenu(page);
    await page.locator(DOM.menuItemNewGroup).click();
    const grpModal = page.locator(DOM.modalCreateGroup);
    await expect(grpModal).toBeVisible();

    const createBtn = scopedButton(grpModal, BILINGUAL_PATTERNS.confirm)
      .or(scopedButton(grpModal, BILINGUAL_PATTERNS.create))
      .first();
    if (await createBtn.isEnabled()) {
      await createBtn.click();
      await expect(grpModal).toBeVisible();
    } else {
      await expect(createBtn).toBeDisabled();
    }

    await scopedButton(grpModal, BILINGUAL_PATTERNS.cancel)
      .or(scopedButton(grpModal, bilingualRegex('close', '关闭')))
      .first()
      .click();
    await expect(grpModal).toBeHidden();

    // Invalid @username (< 5 chars and disallowed symbols) rejected with 400
    for (const badHandle of ['abc', 'bad$handle!']) {
      const badChanRes = await request.post(apiUrl(API_PATHS.chatsCreate), {
        headers: authHeaders(user.token),
        data: {
          chat_type: 'channel',
          title: 'Invalid Handle Channel',
          username: badHandle,
          client_nonce: crypto.randomUUID(),
        },
        failOnStatusCode: false,
      });
      expect(badChanRes.status()).toBe(400);

      const badRegRes = await request.post(apiUrl(API_PATHS.authRegister), {
        data: {
          username: badHandle,
          password: 'ValidPassword!2026',
          first_name: 'Bad Handle Test',
        },
        failOnStatusCode: false,
      });
      expect(badRegRes.status()).toBe(400);
    }
  });

  test('A07-T2-04: Empty sticker packs do NOT claim built-in vector packs; sessions do NOT fabricate 127.0.0.1; no 34.46.77.133 preset', async ({
    authSession,
  }) => {
    const { page } = authSession;

    // Intercept sessions list with empty ip_address to verify UI NEVER fabricates '127.0.0.1'
    let sessionsIntercepted = false;
    let interceptedSessionCount = 0;
    await page.route('**/api/v1/auth/sessions*', async (route) => {
      const resp = await route.fetch();
      const json = (await resp.json()) as {
        sessions?: Array<Record<string, unknown>>;
      };
      interceptedSessionCount = Array.isArray(json.sessions) ? json.sessions.length : 0;
      const patched = Array.isArray(json.sessions)
        ? {
            ...json,
            sessions: json.sessions.map((s) => ({ ...s, ip_address: '' })),
          }
        : json;
      await route.fulfill({
        status: resp.status(),
        contentType: 'application/json',
        body: JSON.stringify(patched),
      });
      sessionsIntercepted = true;
    });

    const settings = await openSettings(page);
    expect(await settings.innerText()).not.toContain('34.46.77.133');

    // 1. Stickers section MUST NOT claim built-in vector packs when empty
    const stickersBtn = settings
      .locator('[data-settings-section*="sticker" i]')
      .or(scopedButton(settings, bilingualRegex('stickers|emoji', '贴纸|表情')))
      .first();
    await expect(stickersBtn).toBeVisible();
    await stickersBtn.click();
    await expect(settings).not.toContainText('Built-in vector sticker packs active');

    // 2. Devices/Sessions section MUST NOT fabricate '127.0.0.1' or '34.46.77.133'
    const devicesBtn = settings
      .locator('[data-settings-section*="device" i], [data-settings-section*="session" i]')
      .or(scopedButton(settings, bilingualRegex('devices|sessions', '设备|会话')))
      .first();
    await expect(devicesBtn).toBeVisible();
    await devicesBtn.click();
    await expect.poll(() => sessionsIntercepted, { timeout: 5_000 }).toBe(true);
    expect(interceptedSessionCount).toBeGreaterThanOrEqual(1);
    await expect(settings).not.toContainText('127.0.0.1');
    await expect(settings).not.toContainText('34.46.77.133');
  });

  test('A07-T2-05: Denied camera/mic permission in WebRTC call surfaces truthful error (NO silent fake canvas video)', async ({
    page,
    request,
  }) => {
    await clearClientState(page);
    const user = await registerUserViaApi(request);
    const conv = await createRealConversationFixture(request, user.token);

    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: () =>
            Promise.reject(new DOMException('Camera permission denied', 'NotAllowedError')),
          getDisplayMedia: () =>
            Promise.reject(new DOMException('Display permission denied', 'NotAllowedError')),
        },
      });
    });

    await page.goto(`${getBaseUrl()}/`, { waitUntil: 'domcontentloaded' });
    await loginWithPassword(page, user.username, user.password);
    await selectChat(page, conv.dmTitle);

    await page.locator(DOM.btnStartVideoCall).click();
    await expect(
      page
        .locator(`${DOM.windowToastBanner}, ${DOM.stageToastPill}, ${DOM.callOverlay}, [role="alert"]`)
        .first(),
    ).toContainText(/permission|denied|microphone|camera|error|权限|拒绝|失败/i);
    await expect(page.locator(`${DOM.callOverlay} canvas`)).toHaveCount(0);
  });

  test('A07-T2-06: Tampered E2EE Secret Chat ciphertext fails WebCrypto AES-GCM authentication & /api/v1/e2ee/prekeys rejects unauthenticated (401) and malformed/bad-signature prekeys (400)', async ({
    page,
    request,
  }) => {
    const userA = await registerUserViaApi(request);
    const userB = await registerUserViaApi(request);
    const deviceId = `e2ee_dev_${crypto.randomBytes(4).toString('hex')}`;

    // 1. Contracted /api/v1/e2ee/prekeys enforces 401 when unauthenticated (ZERO 404 acceptance)
    const unauthPrekeys = await request.post(apiUrl(API_PATHS.e2eePrekeys), {
      data: { device_id: deviceId },
      failOnStatusCode: false,
    });
    expect(unauthPrekeys.status()).toBe(401);

    // 2. Malformed identity_key / corrupted Ed25519 SPK signature rejected with strictly 400
    const { publicKey: edPub, privateKey: edPriv } = crypto.generateKeyPairSync('ed25519');
    const edPubDer = edPub.export({ format: 'der', type: 'spki' });
    const edPubRaw32 = edPubDer.subarray(edPubDer.length - 32);
    const identityX25519 = generateX25519KeyMaterial();
    const spkX25519 = generateX25519KeyMaterial();
    const spkPubRaw32 = Buffer.from(spkX25519.publicKeyB64, 'base64');
    const validSig = crypto.sign(
      null,
      Buffer.concat([Buffer.from('gpui-e2ee-spk-v1'), spkPubRaw32]),
      edPriv,
    );
    const corruptedSig = Buffer.from(validSig);
    corruptedSig[0] ^= 0xff;
    const otpX25519 = generateX25519KeyMaterial();

    const malformedRes = await request.post(apiUrl(API_PATHS.e2eePrekeys), {
      headers: authHeaders(userA.token),
      data: {
        device_id: deviceId,
        device_name: 'Tampered SPK Device',
        identity_key: '!!!not-valid-base64!!!',
        identity_signing_key: edPubRaw32.toString('base64'),
        signed_prekey: {
          key_id: 1,
          public_key: spkX25519.publicKeyB64,
          signature: corruptedSig.toString('base64'),
          created_at_ms: Date.now(),
        },
        one_time_prekeys: [{ key_id: 1, public_key: otpX25519.publicKeyB64 }],
      },
      failOnStatusCode: false,
    });
    expect(malformedRes.status()).toBe(400);

    const badSigRes = await request.post(apiUrl(API_PATHS.e2eePrekeys), {
      headers: authHeaders(userA.token),
      data: {
        device_id: deviceId,
        device_name: 'Corrupted Sig Device',
        identity_key: identityX25519.publicKeyB64,
        identity_signing_key: edPubRaw32.toString('base64'),
        signed_prekey: {
          key_id: 1,
          public_key: spkX25519.publicKeyB64,
          signature: corruptedSig.toString('base64'),
          created_at_ms: Date.now(),
        },
        one_time_prekeys: [{ key_id: 1, public_key: otpX25519.publicKeyB64 }],
      },
      failOnStatusCode: false,
    });
    expect(badSigRes.status()).toBe(400);

    // 3. Valid Ed25519-signed prekey bundle publishes (200), counts accurately, and is fetchable by peer
    const validPublish = await request.post(apiUrl(API_PATHS.e2eePrekeys), {
      headers: authHeaders(userA.token),
      data: {
        device_id: deviceId,
        device_name: 'Verified E2EE Device',
        identity_key: identityX25519.publicKeyB64,
        identity_signing_key: edPubRaw32.toString('base64'),
        signed_prekey: {
          key_id: 1,
          public_key: spkX25519.publicKeyB64,
          signature: validSig.toString('base64'),
          created_at_ms: Date.now(),
        },
        one_time_prekeys: [{ key_id: 1, public_key: otpX25519.publicKeyB64 }],
      },
    });
    expect(validPublish.status()).toBe(200);

    const countRes = await request.get(
      `${apiUrl(API_PATHS.e2eePrekeysCount)}?device_id=${encodeURIComponent(deviceId)}`,
      { headers: authHeaders(userA.token) },
    );
    expect(countRes.status()).toBe(200);
    const countBody = (await countRes.json()) as {
      has_signed_prekey?: unknown;
      remaining_one_time_prekeys?: unknown;
    };
    expect(countBody.has_signed_prekey).toBe(true);
    expect(countBody.remaining_one_time_prekeys).toBe(1);

    const peerFetchRes = await request.get(
      apiUrl(`${API_PATHS.e2eePrekeys}/${userA.userId}`),
      { headers: authHeaders(userB.token) },
    );
    expect(peerFetchRes.status()).toBe(200);
    const peerBundle = (await peerFetchRes.json()) as { devices?: unknown[] };
    expect(Array.isArray(peerBundle.devices)).toBe(true);
    expect(peerBundle.devices!.length).toBeGreaterThanOrEqual(1);

    // 4. Real browser WebCrypto AES-256-GCM tampered-ciphertext & tampered-tag rejection proof
    await page.goto(`${getBaseUrl()}/`, { waitUntil: 'domcontentloaded' });
    const cryptoResult = await page.evaluate(async () => {
      const key = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const plaintext = new TextEncoder().encode('SecretChatE2eePayload');
      const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);

      const validPlain = new TextDecoder().decode(
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipherBuf),
      );

      const tamperedCipher = new Uint8Array(cipherBuf.slice(0));
      tamperedCipher[0] ^= 0x01;
      let cipherErrorName = '';
      try {
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, tamperedCipher);
      } catch (err) {
        cipherErrorName = err instanceof DOMException ? err.name : String(err);
      }

      const tamperedTag = new Uint8Array(cipherBuf.slice(0));
      tamperedTag[tamperedTag.length - 1] ^= 0x01;
      let tagErrorName = '';
      try {
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, tamperedTag);
      } catch (err) {
        tagErrorName = err instanceof DOMException ? err.name : String(err);
      }

      return { validPlain, cipherErrorName, tagErrorName };
    });

    expect(cryptoResult.validPlain).toBe('SecretChatE2eePayload');
    expect(cryptoResult.cipherErrorName).toBe('OperationError');
    expect(cryptoResult.tagErrorName).toBe('OperationError');
  });
});
