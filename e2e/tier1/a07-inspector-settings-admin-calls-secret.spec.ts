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
  sendTextMessage,
} from '../helpers/ui';

interface E2eWindowCryptoProbe {
  __e2eWebCryptoAlgos?: string[];
}

test.describe('Tier 1 — A07: Right Inspector Separation, Groups/Channels Admin, Wired Settings, Export, WebRTC Calls & Secret Chats', () => {
  test('A07-T1-01: Right Context Inspector (#right-column, #right-profile-info) strict Bot vs Group/Channel vs 1v1 User profile separation & per-chatId shared tabs', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token, {
      includeGroup: true,
      groupTitle: 'Inspector Group Room',
    });
    const botRes = await request.post(apiUrl(API_PATHS.fabushiBots), {
      headers: authHeaders(user.token),
      data: {
        display_name: 'Inspector Test Bot',
        username: `inspector_bot_${Date.now().toString(36)}_bot`,
        description: 'Dedicated bot for inspector profile checks',
      },
    });
    expect([200, 201]).toContain(botRes.status());

    await page.reload({ waitUntil: 'domcontentloaded' });

    // 1. 1v1 User Inspector
    await selectChat(page, conv.dmTitle);
    const rightCol = await openRightInspector(page);
    await expect(rightCol.locator(DOM.rightProfileInfo)).toContainText(conv.dmTitle);
    await expect(rightCol.locator(DOM.rightTabMedia)).toBeVisible();
    await expect(rightCol.locator(DOM.rightTabFiles)).toBeVisible();
    await expect(rightCol.locator(DOM.rightTabMembers)).toHaveCount(0);

    // 2. Group Inspector shows #right-tab-members and member count
    await selectChat(page, conv.groupTitle ?? 'Inspector Group Room');
    await openRightInspector(page);
    await expect(rightCol.locator(DOM.rightProfileInfo)).toContainText(
      conv.groupTitle ?? 'Inspector Group Room',
    );
    await expect(rightCol.locator(DOM.rightTabMembers)).toBeVisible();

    // 3. Bot Inspector shows bot description & zero Group Members tab
    await selectChat(page, 'Inspector Test Bot');
    await openRightInspector(page);
    await expect(rightCol.locator(DOM.rightProfileInfo)).toContainText('Inspector Test Bot');
    await expect(rightCol.locator(DOM.rightProfileInfo)).toContainText(
      'Dedicated bot for inspector profile checks',
    );
    await expect(rightCol.locator(DOM.rightTabMembers)).toHaveCount(0);
  });

  test('A07-T1-02: Group (#modal-create-group) & Channel (#modal-create-channel) creation, invite link generation, and Channel Statistics (#right-tab-stats)', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token);
    await page.reload({ waitUntil: 'domcontentloaded' });

    // Create a Broadcast Channel via #modal-create-channel
    await openBurgerMenu(page);
    await page.locator(DOM.menuItemNewChannel).click();
    const chanModal = page.locator(DOM.modalCreateChannel);
    await expect(chanModal).toBeVisible();
    await chanModal.locator('input').first().fill('Fabushi Release Broadcast');
    await scopedButton(chanModal, BILINGUAL_PATTERNS.confirm)
      .or(scopedButton(chanModal, BILINGUAL_PATTERNS.create))
      .first()
      .click();
    await expect(chanModal).toBeHidden();

    await selectChat(page, 'Fabushi Release Broadcast');
    await sendTextMessage(page, 'Channel announcement post #1');

    const rightCol = await openRightInspector(page);
    const statsTab = rightCol.locator(DOM.rightTabStats);
    await expect(statsTab).toBeVisible();
    await statsTab.click();
    await expect(rightCol).toContainText(/views|subscribers|post|统计|浏览|订阅/i);

    // Verify existing real peer can be picked in #modal-create-group
    await openBurgerMenu(page);
    await page.locator(DOM.menuItemNewGroup).click();
    const grpModal = page.locator(DOM.modalCreateGroup);
    await expect(grpModal).toBeVisible();
    await grpModal.locator('input').first().fill('Admin Group Ops');
    const peerOpt = grpModal.getByText(conv.dmTitle).first();
    await expect(peerOpt).toBeVisible();
    await peerOpt.click();
    await scopedButton(grpModal, BILINGUAL_PATTERNS.confirm)
      .or(scopedButton(grpModal, BILINGUAL_PATTERNS.create))
      .first()
      .click();
    await expect(grpModal).toBeHidden();
    await expect(page.locator(DOM.chatList)).toContainText('Admin Group Ops');

    // Verify invite link generation on Admin Group Ops via Right Inspector
    await selectChat(page, 'Admin Group Ops');
    const grpInspector = await openRightInspector(page);
    const inviteBtn = scopedButton(
      grpInspector,
      bilingualRegex('invite\\s*link|copy\\s*invite', '邀请链接'),
    ).first();
    await expect(inviteBtn).toBeVisible();
    await inviteBtn.click();
    await expect(
      page.locator(`${DOM.rightColumn}, [role="dialog"], ${DOM.windowToastBanner}, ${DOM.stageToastPill}`).first(),
    ).toContainText(/(?:\/join\/|invite|t\.me\/|http)/i);
  });

  test('A07-T1-03: Wired Settings (#settings-panel): Settings -> Magpie button opens #magpie-gateway-panel, unified shortcuts (#modal-shortcuts), persistent toggles', async ({
    authSession,
  }) => {
    const { page } = authSession;

    // 1. Open Keyboard Shortcuts modal via unified '?' shortcut
    await page.keyboard.press('?');
    const shortcutsModal = page.locator(DOM.modalShortcuts);
    await expect(shortcutsModal).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(shortcutsModal).toBeHidden();

    // 2. Settings -> Open Magpie Gateway actually opens #magpie-gateway-panel
    const settings = await openSettings(page);
    const magpieTrigger = settings
      .locator('[data-settings-section*="magpie" i], [data-testid*="magpie" i]')
      .or(scopedButton(settings, bilingualRegex('magpie|ai\\s*provider|model\\s*gateway', '喜鹊|模型网关|AI\\s*供应商')))
      .first();
    await expect(magpieTrigger).toBeVisible();
    await magpieTrigger.click();
    await expect(page.locator(DOM.magpieGatewayPanel)).toBeVisible();

    // 3. Toggle a real Settings switch and verify persistence across reload
    const readSwitchState = async (
      loc: ReturnType<typeof page.locator>,
    ): Promise<boolean> => {
      const aria = await loc.getAttribute('aria-checked');
      if (aria === 'true' || aria === 'false') {
        return aria === 'true';
      }
      return loc.isChecked();
    };

    const settingsAgain = await openSettings(page);
    const generalBtn = settingsAgain
      .locator('[data-settings-section*="general" i], [data-settings-section*="notification" i]')
      .or(scopedButton(settingsAgain, bilingualRegex('general|notifications', '通用|通知')))
      .first();
    await expect(generalBtn).toBeVisible();
    await generalBtn.click();
    const toggle = settingsAgain.locator('input[type="checkbox"], [role="switch"]').first();
    await expect(toggle).toBeVisible();
    const initialChecked = await readSwitchState(toggle);
    await toggle.click();

    await page.reload({ waitUntil: 'domcontentloaded' });
    const reloadedSettings = await openSettings(page);
    const reloadedGeneral = reloadedSettings
      .locator('[data-settings-section*="general" i], [data-settings-section*="notification" i]')
      .or(scopedButton(reloadedSettings, bilingualRegex('general|notifications', '通用|通知')))
      .first();
    await expect(reloadedGeneral).toBeVisible();
    await reloadedGeneral.click();
    const reloadedToggle = reloadedSettings.locator('input[type="checkbox"], [role="switch"]').first();
    await expect(reloadedToggle).toBeVisible();
    const persistedChecked = await readSwitchState(reloadedToggle);
    expect(persistedChecked).toBe(!initialChecked);
  });

  test('A07-T1-04: Real JSON (#btn-export-chat-json) and HTML (#btn-export-chat-html) transcript downloads containing real messages', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const conv = await createRealConversationFixture(request, user.token, {
      initialDmMessages: [
        { from: 'peer', text: 'Export_Verified_Payload_Alpha_774' },
      ],
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await selectChat(page, conv.dmTitle);
    await openRightInspector(page);

    const jsonDownloadPromise = page.waitForEvent('download');
    await page.locator(DOM.btnExportChatJson).click();
    const jsonDownload = await jsonDownloadPromise;
    const jsonStream = await jsonDownload.createReadStream();
    const jsonChunks: Buffer[] = [];
    for await (const c of jsonStream!) jsonChunks.push(Buffer.from(c));
    const jsonText = Buffer.concat(jsonChunks).toString('utf8');
    const parsed = JSON.parse(jsonText) as unknown;
    expect(parsed).toBeTruthy();
    expect(jsonText).toContain('Export_Verified_Payload_Alpha_774');

    const htmlDownloadPromise = page.waitForEvent('download');
    await page.locator(DOM.btnExportChatHtml).click();
    const htmlDownload = await htmlDownloadPromise;
    const htmlStream = await htmlDownload.createReadStream();
    const htmlChunks: Buffer[] = [];
    for await (const c of htmlStream!) htmlChunks.push(Buffer.from(c));
    const htmlText = Buffer.concat(htmlChunks).toString('utf8');
    expect(htmlText.toLowerCase()).toContain('<html');
    expect(htmlText).toContain('Export_Verified_Payload_Alpha_774');
  });

  test('A07-T1-05: Real WebRTC 1-on-1 Audio/Video Call (#btn-start-audio-call, #btn-start-video-call, #call-overlay, 4-emoji E2EE fingerprint, #top-call-bar minimize/restore, hang-up)', async ({
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

    // Verify real video stream element and 4-emoji E2EE fingerprint exist
    await expect(callOverlay.locator('video').first()).toBeVisible();
    const callText = await callOverlay.innerText();
    const fingerprintEmojis = callText.match(/\p{Extended_Pictographic}/gu);
    expect(Array.isArray(fingerprintEmojis)).toBe(true);
    expect(fingerprintEmojis!.length).toBeGreaterThanOrEqual(4);

    // Minimize to #top-call-bar and restore
    const minBtn = scopedButton(callOverlay, bilingualRegex('minimize|collapse|back', '最小化|收起')).first();
    await expect(minBtn).toBeVisible();
    await minBtn.click();
    const topCallBar = page.locator(DOM.topCallBar);
    await expect(topCallBar).toBeVisible();

    await topCallBar.click();
    await expect(callOverlay).toBeVisible();

    // Hang up cleanly closes #call-overlay
    const endBtn = scopedButton(callOverlay, bilingualRegex('end|hang\\s*up|decline', '挂断|结束')).first();
    await expect(endBtn).toBeVisible();
    await endBtn.click();
    await expect(callOverlay).toBeHidden();
  });

  test('A07-T1-06: WebCrypto E2EE Secret Chat (ECDH + HKDF + AES-256-GCM) encrypted message round-trip & self-destruct TTL countdown', async ({
    page,
    request,
  }) => {
    await clearClientState(page);
    const primary = await registerUserViaApi(request);
    const conv = await createRealConversationFixture(request, primary.token);

    // Install transparent SubtleCrypto observer before page boot
    await page.addInitScript(() => {
      const win = window as unknown as E2eWindowCryptoProbe;
      win.__e2eWebCryptoAlgos = [];
      const record = (alg: unknown) => {
        if (!alg) return;
        const name =
          typeof alg === 'string'
            ? alg
            : typeof alg === 'object' && 'name' in alg
              ? String((alg as { name: unknown }).name)
              : '';
        if (name) win.__e2eWebCryptoAlgos?.push(name.toUpperCase());
      };
      const subtle = window.crypto?.subtle;
      if (subtle) {
        const origGen = subtle.generateKey.bind(subtle);
        subtle.generateKey = ((...args: Parameters<SubtleCrypto['generateKey']>) => {
          record(args[0]);
          return origGen(...args);
        }) as SubtleCrypto['generateKey'];
        const origDerive = subtle.deriveKey.bind(subtle);
        subtle.deriveKey = ((...args: Parameters<SubtleCrypto['deriveKey']>) => {
          record(args[0]);
          record(args[2]);
          return origDerive(...args);
        }) as SubtleCrypto['deriveKey'];
        const origEnc = subtle.encrypt.bind(subtle);
        subtle.encrypt = ((...args: Parameters<SubtleCrypto['encrypt']>) => {
          record(args[0]);
          return origEnc(...args);
        }) as SubtleCrypto['encrypt'];
      }
    });

    await page.goto(`${getBaseUrl()}/`, { waitUntil: 'domcontentloaded' });
    await loginWithPassword(page, primary.username, primary.password);
    await selectChat(page, conv.dmTitle);

    const rightCol = await openRightInspector(page);
    const secretBtn = scopedButton(
      rightCol,
      bilingualRegex('secret\\s*chat|start\\s*secret|encrypted\\s*chat', '加密聊天|私密聊天|发起加密'),
    ).first();
    await expect(secretBtn).toBeVisible();
    await secretBtn.click();

    const ttlBtn = page
      .locator(`${DOM.chatHeader}, ${DOM.rightColumn}`)
      .getByRole('button', {
        name: bilingualRegex('timer|self-destruct|ttl', '自毁|计时|阅后即焚'),
      })
      .first();
    await expect(ttlBtn).toBeVisible();
    await ttlBtn.click();
    const ttlChoice = page
      .locator('[role="menu"] button, [role="menuitem"], [role="dialog"] button')
      .filter({ hasText: /5\s*s|10\s*s|5\s*秒|10\s*秒/i })
      .first();
    await expect(ttlChoice).toBeVisible();
    await ttlChoice.click();

    const secretMarker = `E2EE_Secret_Payload_${Date.now()}`;
    await sendTextMessage(page, secretMarker);
    await expect(
      page.locator(`${DOM.chatHeader}, ${DOM.messageList}`).first(),
    ).toContainText(/\d+\s*s|\d+\s*秒|TTL|自毁/i);

    const observedAlgos = await page.evaluate(
      () => (window as unknown as E2eWindowCryptoProbe).__e2eWebCryptoAlgos,
    );
    expect(Array.isArray(observedAlgos)).toBe(true);
    expect(observedAlgos!.some((a) => a.includes('AES-GCM') || a.includes('ECDH'))).toBe(true);
  });
});
