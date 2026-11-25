import { test, expect } from '../helpers/fixtures';
import { API_PATHS, DOM } from '../helpers/selectors';
import {
  apiUrl,
  authHeaders,
  generateUniqueUsername,
  registerUserViaApi,
} from '../helpers/server';
import {
  generateRandomB64,
  generateSplitKeyMaterial,
  generateX25519KeyMaterial,
} from '../helpers/api';
import {
  bilingualRegex,
  BILINGUAL_PATTERNS,
  openNavDestination,
  openSettings,
  scopedButton,
} from '../helpers/ui';

test.describe('Tier 3 — PW03: Split-Key V2 Vault, Multi-User AI/Vault Isolation & Settings->Magpie->Hermes Flow', () => {
  test('PW-07 (A01 x A08 x A03): Split-Key V2 upgrade + E2EE Vault item upsert + Local Passcode Lock + reload restoration', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const headers = authHeaders(user.token);

    // Upgrade account to Split-Key V2 & store E2EE vault item
    const split = generateSplitKeyMaterial('pw07-seed');
    const upRes = await request.post(apiUrl(API_PATHS.authUpgradeSplitKey), {
      headers,
      data: {
        old_password: user.password,
        auth_salt_b64: split.saltB64,
        auth_verifier_b64: split.verifierB64,
        kdf_params: split.kdfParams,
      },
    });
    expect(upRes.status()).toBe(200);

    const itemRes = await request.put(apiUrl(`${API_PATHS.vaultItems}/password/pw07_key`), {
      headers,
      data: { nonce_b64: generateRandomB64(12), ciphertext_b64: generateRandomB64(64) },
    });
    expect(itemRes.status()).toBe(200);

    // Enable Local Passcode Lock & reload
    const settings = await openSettings(page);
    const privacyBtn = settings
      .locator('[data-settings-section*="privacy" i]')
      .or(scopedButton(settings, bilingualRegex('privacy', '隐私')))
      .first();
    await expect(privacyBtn).toBeVisible();
    await privacyBtn.click();

    const passcodeBtn = settings
      .locator('[data-settings-section*="passcode" i], [data-testid*="passcode" i]')
      .or(scopedButton(settings, bilingualRegex('passcode', '应用锁|本地密码')))
      .first();
    await expect(passcodeBtn).toBeVisible();
    await passcodeBtn.click();

    const inputs = page.locator(
      `${DOM.settingsPanel} input[type="password"], [role="dialog"] input[type="password"]`,
    );
    await expect(inputs.first()).toBeVisible();
    const n = await inputs.count();
    expect(n).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < Math.min(2, n); i++) {
      await inputs.nth(i).fill('5678');
    }
    await scopedButton(
      page.locator(`${DOM.settingsPanel}, [role="dialog"]`).first(),
      BILINGUAL_PATTERNS.confirm,
    )
      .first()
      .click();

    await page.keyboard.press('Control+Shift+L');
    await expect(page.locator(DOM.passcodeLockScreen)).toBeVisible();

    // Reload MUST keep #passcode-lock-screen active until unlocked with passcode
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator(DOM.passcodeLockScreen)).toBeVisible();

    await page.locator(DOM.passcodeUnlockInput).fill('5678');
    await page.locator(DOM.passcodeUnlockInput).press('Enter');
    await expect(page.locator(DOM.passcodeLockScreen)).toBeHidden();
    await expect(page.locator(DOM.appShell)).toBeVisible();

    // Vault item remains intact after unlock & reload
    const fetchItems = await request.get(
      `${apiUrl(API_PATHS.vaultItems)}?since_revision=0`,
      { headers },
    );
    expect(fetchItems.status()).toBe(200);
    const itemsBody = (await fetchItems.json()) as {
      items?: Array<{ item_key?: string }>;
    };
    expect(Array.isArray(itemsBody.items)).toBe(true);
    expect(itemsBody.items!.some((i) => i.item_key === 'pw07_key')).toBe(true);
  });

  test('PW-08 (A08 x A09 x A01): Multi-user isolation: User A Vault + encrypted AI Provider + Device Sync invisible to User B', async ({
    request,
  }) => {
    const userA = await registerUserViaApi(request, {
      username: generateUniqueUsername('tenantA'),
    });
    const userB = await registerUserViaApi(request, {
      username: generateUniqueUsername('tenantB'),
    });

    // User A creates Vault item, encrypted Magpie AI provider, and Device Sync request
    const vaultPutRes = await request.put(apiUrl(`${API_PATHS.vaultItems}/ai_oauth/userA_token`), {
      headers: authHeaders(userA.token),
      data: { nonce_b64: generateRandomB64(12), ciphertext_b64: generateRandomB64(64) },
    });
    expect(vaultPutRes.status()).toBe(200);

    const provRes = await request.post(apiUrl(API_PATHS.magpieProviders), {
      headers: authHeaders(userA.token),
      data: {
        provider_id: `e2e_pw08_${Date.now().toString(36)}`,
        name: 'User A Isolated LLM',
        kind: 'openai',
        api_mode: 'chat_completions',
        base_url: 'https://api.openai.com/v1',
        api_key: 'sk-user-a-only-secret-11223344',
        default_model: 'gpt-4o-mini',
        enabled: true,
        activate: true,
      },
    });
    expect([200, 201]).toContain(provRes.status());

    // Prove User A's provider setup took effect
    const aMagpieRes = await request.get(apiUrl(API_PATHS.magpieState), {
      headers: authHeaders(userA.token),
    });
    expect(aMagpieRes.status()).toBe(200);
    const aMagpie = (await aMagpieRes.json()) as { has_configured_provider?: boolean };
    expect(aMagpie.has_configured_provider).toBe(true);

    const syncReqRes = await request.post(apiUrl(API_PATHS.vaultDeviceSyncRequest), {
      headers: authHeaders(userA.token),
      data: {
        device_name: 'User A Laptop',
        device_public_key_b64: generateX25519KeyMaterial().publicKeyB64,
      },
    });
    expect([200, 201]).toContain(syncReqRes.status());
    const syncReq = (await syncReqRes.json()) as { request_id: string };
    expect(syncReq.request_id).toMatch(/^dsr_/);

    // Verify User B sees ZERO items across all three domains
    const bVaultRes = await request.get(`${apiUrl(API_PATHS.vaultItems)}?since_revision=0`, {
      headers: authHeaders(userB.token),
    });
    expect(bVaultRes.status()).toBe(200);
    const bVault = (await bVaultRes.json()) as { items?: unknown[] };
    expect(Array.isArray(bVault.items)).toBe(true);
    expect(bVault.items).toHaveLength(0);

    const bMagpieRes = await request.get(apiUrl(API_PATHS.magpieState), {
      headers: authHeaders(userB.token),
    });
    expect(bMagpieRes.status()).toBe(200);
    const bMagpie = (await bMagpieRes.json()) as {
      has_configured_provider?: boolean;
      providers?: unknown[];
    };
    expect(bMagpie.has_configured_provider).toBe(false);
    expect(Array.isArray(bMagpie.providers)).toBe(true);
    expect(bMagpie.providers).toHaveLength(0);

    const bSync = await request.get(
      apiUrl(`${API_PATHS.vaultDeviceSync}/${syncReq.request_id}/status`),
      { headers: authHeaders(userB.token), failOnStatusCode: false },
    );
    expect(bSync.status()).toBe(403);
  });

  test('PW-09 (A07 x A09 x A10): Settings -> Open Magpie Gateway -> PII masking preview + Hermes Studio 503 PROVIDER_ERROR CTA round-trip', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const headers = authHeaders(user.token);

    // 1. Settings -> Magpie link genuinely opens #magpie-gateway-panel
    const settings = await openSettings(page);
    const magpieBtn = settings
      .locator('[data-settings-section*="magpie" i], [data-testid*="magpie" i]')
      .or(scopedButton(settings, bilingualRegex('magpie|ai\\s*provider', '喜鹊|模型网关')))
      .first();
    await expect(magpieBtn).toBeVisible();
    await magpieBtn.click();
    await expect(page.locator(DOM.magpieGatewayPanel)).toBeVisible();

    // 2. Server-backed PII masking preview strips sensitive email/key while keeping non-PII text
    const maskRes = await request.post(apiUrl(API_PATHS.magpieMaskingPreview), {
      headers,
      data: { text: 'Reach ops@fabushi.example with sk-secret-abcdef1234567890' },
    });
    expect(maskRes.status()).toBe(200);
    const maskBody = (await maskRes.json()) as { masked_text?: unknown; masked?: unknown };
    const maskedOut = maskBody.masked_text ?? maskBody.masked;
    expect(typeof maskedOut).toBe('string');
    expect((maskedOut as string).length).toBeGreaterThan(0);
    expect(maskedOut as string).toContain('Reach');
    expect(maskedOut as string).not.toContain('ops@fabushi.example');
    expect(maskedOut as string).not.toContain('sk-secret-abcdef1234567890');

    // 3. Hermes turn with 0 providers -> truthful 503 + structured inline PROVIDER_ERROR card + CTA opening #magpie-gateway-panel
    const hermesPanel = await openNavDestination(page, 'hermes');
    const promptInput = hermesPanel.locator('textarea, input[type="text"]').first();
    await expect(promptInput).toBeVisible();
    await promptInput.fill('Analyze deployment logs');

    const [turnRes] = await Promise.all([
      page.waitForResponse(
        (res) =>
          (res.url().includes('/api/v1/fabushi/turns') ||
            res.url().includes('/api/v1/hermes/turns')) &&
          res.request().method() === 'POST',
        { timeout: 8_000 },
      ),
      promptInput.press('Enter'),
    ]);
    expect(turnRes.status()).toBe(503);
    const turnBody = (await turnRes.json()) as {
      error?: string;
      needs_provider_selection?: boolean;
      action?: string;
    };
    expect(turnBody.error).toBe('provider_not_configured');
    expect(turnBody.needs_provider_selection).toBe(true);
    expect(turnBody.action).toBe('hermes:open_ai_providers');

    const errorCard = hermesPanel
      .locator('[data-testid*="provider-error" i], [data-error-code="PROVIDER_ERROR"], .provider-error-card, [role="alert"]')
      .first();
    await expect(errorCard).toBeVisible({ timeout: 6_000 });
    await expect(errorCard).toContainText(
      /provider_not_configured|PROVIDER_ERROR|no\s*ai\s*provider|未配置.*模型|未配置.*供应商/i,
    );

    const cta = scopedButton(errorCard, BILINGUAL_PATTERNS.configureAiProvider).first();
    await expect(cta).toBeVisible();
    await cta.click();
    await expect(page.locator(DOM.magpieGatewayPanel)).toBeVisible();
  });
});
