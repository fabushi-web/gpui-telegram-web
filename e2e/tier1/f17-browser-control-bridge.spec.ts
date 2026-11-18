import {
  assertNoPurpleOnDark,
  DOM,
  expect,
  getBaseUrl,
  openNavDestination,
  selectChat,
  test,
} from '../helpers';

test.describe('F17 — Desktop-to-Browser Control Bridge, Headless Chromium Studio & MCP JSON-RPC 2.0', () => {
  test('F17-01: Desktop pairing flow -> Live Web Tab remote control (snapshot, fill, app_action, screenshot) -> <10ms emergency revoke', async ({
    authPage: page,
    request,
  }) => {
    const baseUrl = getBaseUrl();

    // Select a writable chat first so live tab has an active conversation context
    await selectChat(page, 0);

    // Navigate to #browser-control-workspace via Nav Rail (#nav-dest-browser)
    const workspace = await openNavDestination(page, 'browser');
    await expect(workspace).toBeVisible();
    await assertNoPurpleOnDark(page);

    // 1. Generate a Desktop Pairing Ticket in the Web UI
    const pairBtn = page.locator(DOM.btnBrowserPairDesktop);
    await expect(pairBtn).toBeVisible();
    await pairBtn.click();

    const codeDisplay = page.locator(DOM.browserPairingCodeDisplay);
    await expect(codeDisplay).toContainText(/Pair Code · 配对码:\s*[A-Z0-9-]{6,}/);

    const displayText = await codeDisplay.innerText();
    const codeMatch = displayText.match(/Pair Code · 配对码:\s*([A-Z0-9-]{6,})/);
    expect(codeMatch).not.toBeNull();
    const pairCode = codeMatch![1]!;

    // 2. Simulate external gpui-telegram Desktop client claiming the pairing code (zero web cookies!)
    const claimRes = await request.post(`${baseUrl}/api/v1/browser/pair/claim`, {
      data: {
        pair_code: pairCode,
        controller_label: 'gpui-telegram-desktop-e2e',
      },
    });
    expect(claimRes.status()).toBe(200);
    const claimBody = (await claimRes.json()) as {
      desktop_token: string;
      ws_bridge_url: string;
      mcp_rpc_url: string;
    };
    expect(claimBody.desktop_token).toMatch(/^bctrl_/);
    expect(claimBody.ws_bridge_url).toContain('/api/v1/browser/ws');
    expect(claimBody.mcp_rpc_url).toContain('/api/v1/mcp/rpc');

    const desktopHeaders = {
      'X-Desktop-Browser-Token': claimBody.desktop_token,
    };

    // 3. Desktop discovers live connected Web Tab via GET /api/v1/browser/targets
    let liveTargetId = '';
    await expect
      .poll(
        async () => {
          const targetsRes = await request.get(`${baseUrl}/api/v1/browser/targets`, {
            headers: desktopHeaders,
          });
          if (targetsRes.status() !== 200) return '';
          const body = (await targetsRes.json()) as {
            targets: Array<{ target_id: string; kind: string }>;
          };
          const live = body.targets.find((t) => t.kind === 'live_web_tab');
          liveTargetId = live?.target_id ?? '';
          return liveTargetId;
        },
        { message: 'Expected live browser tab to register on BrowserControlBridge' },
      )
      .not.toBe('');

    // 4. Desktop captures a live accessibility/DOM snapshot from the real Chromium tab over WS bridge
    const snapCmdRes = await request.post(`${baseUrl}/api/v1/browser/command`, {
      headers: desktopHeaders,
      data: {
        target_id: liveTargetId,
        action: 'snapshot',
      },
    });
    expect(snapCmdRes.status()).toBe(200);
    const snapCmdBody = (await snapCmdRes.json()) as {
      ok: boolean;
      snapshot?: { elements: Array<{ ref: string; tag: string }> };
    };
    expect(snapCmdBody.ok).toBe(true);
    expect((snapCmdBody.snapshot?.elements.length ?? 0)).toBeGreaterThan(3);

    // 5. Desktop executes high-level `app_action` (`switch_theme` -> `day`, then `send_message`, then back to `night`)
    const themeCmdRes = await request.post(`${baseUrl}/api/v1/browser/command`, {
      headers: desktopHeaders,
      data: {
        target_id: liveTargetId,
        action: 'app_action',
        app_action: 'switch_theme',
        app_payload: { theme: 'day' },
      },
    });
    expect(themeCmdRes.status()).toBe(200);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'day');

    // Switch back to chats & night theme remotely from Desktop!
    const navCmdRes = await request.post(`${baseUrl}/api/v1/browser/command`, {
      headers: desktopHeaders,
      data: {
        target_id: liveTargetId,
        action: 'app_action',
        app_action: 'navigate_workspace',
        app_payload: { dest: 'chats' },
      },
    });
    expect(navCmdRes.status()).toBe(200);
    await expect(page.locator(DOM.middleColumn)).toBeVisible();

    const uniqueMsg = `Desktop Remote Message ${Date.now()}`;
    const sendCmdRes = await request.post(`${baseUrl}/api/v1/browser/command`, {
      headers: desktopHeaders,
      data: {
        target_id: liveTargetId,
        action: 'app_action',
        app_action: 'send_message',
        app_payload: { text: uniqueMsg },
      },
    });
    expect(sendCmdRes.status()).toBe(200);
    const sendBody = (await sendCmdRes.json()) as { ok: boolean };
    expect(sendBody.ok).toBe(true);
    await expect(page.locator(DOM.messageList)).toContainText(uniqueMsg);

    // Restore night theme remotely and capture live viewport screenshot
    await request.post(`${baseUrl}/api/v1/browser/command`, {
      headers: desktopHeaders,
      data: {
        target_id: liveTargetId,
        action: 'app_action',
        app_action: 'switch_theme',
        app_payload: { theme: 'night' },
      },
    });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'night');

    const shotCmdRes = await request.post(`${baseUrl}/api/v1/browser/command`, {
      headers: desktopHeaders,
      data: {
        target_id: liveTargetId,
        action: 'screenshot',
      },
    });
    expect(shotCmdRes.status()).toBe(200);
    const shotCmdBody = (await shotCmdRes.json()) as {
      ok: boolean;
      screenshot_data_url?: string;
    };
    expect(shotCmdBody.ok).toBe(true);
    expect(shotCmdBody.screenshot_data_url).toMatch(/^data:image\//);

    // 6. User triggers <10ms Emergency Revoke Control in BrowserControlWorkspace
    await openNavDestination(page, 'browser');
    const revokeBtn = page.locator(DOM.btnBrowserRevokeControl);
    await expect(revokeBtn).toBeVisible();
    await revokeBtn.click();

    await expect(page.locator(DOM.browserControlWorkspace)).toContainText(/Revoked|control_generation/i);

    // Subsequent Desktop command with revoked `bctrl_...` token MUST fail closed with 401/409!
    const afterRevokeRes = await request.post(`${baseUrl}/api/v1/browser/command`, {
      headers: desktopHeaders,
      failOnStatusCode: false,
      data: {
        target_id: liveTargetId,
        action: 'snapshot',
      },
    });
    expect([401, 403, 409]).toContain(afterRevokeRes.status());

    // Audit log records remote commands & revoke event
    const auditLog = page.locator(DOM.browserAuditLog);
    await expect(auditLog).toBeVisible();
  });

  test('F17-02: Server-managed Headless Chromium Studio + Standard MCP JSON-RPC 2.0 Server (/api/v1/mcp/rpc)', async ({
    authPage: page,
    request,
  }) => {
    const baseUrl = getBaseUrl();

    // 1. Open Browser Control Workspace & launch a Headless Chromium session from the UI
    await openNavDestination(page, 'browser');
    const urlInput = page.locator(DOM.browserHeadlessUrlInput);
    const openBtn = page.locator(DOM.btnBrowserHeadlessOpen);
    await expect(urlInput).toBeVisible();
    await expect(openBtn).toBeVisible();

    const htmlPayload =
      'data:text/html,<html><body><h1 id="hdr">Standalone Desktop Browser Bridge</h1><button id="act" onclick="document.getElementById(\'hdr\').textContent=\'Clicked Remotely\'">Trigger</button></body></html>';
    await urlInput.fill(htmlPayload);
    await openBtn.click();

    const viewport = page.locator(DOM.browserHeadlessViewport);
    await expect(viewport).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(DOM.browserControlWorkspace)).toContainText(
      /Standalone Desktop Browser Bridge|Trigger/i,
      { timeout: 15_000 },
    );

    // 2. Verify Standard Model Context Protocol JSON-RPC 2.0 endpoint for Desktop Agents
    // Mint a fresh pairing token via UI so external Desktop MCP client can authenticate cleanly
    await page.locator(DOM.btnBrowserPairDesktop).click();
    const displayText = await page.locator(DOM.browserPairingCodeDisplay).innerText();
    const tokenMatch = displayText.match(/bctrl_[A-Za-z0-9_-]+/);
    expect(tokenMatch).not.toBeNull();
    const desktopToken = tokenMatch![0];

    const initRpc = await request.post(`${baseUrl}/api/v1/mcp/rpc`, {
      headers: { Authorization: `Bearer ${desktopToken}` },
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'gpui-telegram-desktop', version: '1.2.0' } },
      },
    });
    expect(initRpc.status()).toBe(200);
    const initJson = (await initRpc.json()) as {
      result?: { serverInfo?: { name: string }; protocolVersion?: string };
    };
    expect(initJson.result?.serverInfo?.name).toBeTruthy();

    const listRpc = await request.post(`${baseUrl}/api/v1/mcp/rpc`, {
      headers: { Authorization: `Bearer ${desktopToken}` },
      data: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      },
    });
    expect(listRpc.status()).toBe(200);
    const listJson = (await listRpc.json()) as {
      result?: { tools?: Array<{ name: string }> };
    };
    const toolNames = (listJson.result?.tools ?? []).map((t) => t.name);
    expect(toolNames).toEqual(
      expect.arrayContaining([
        'browser_list_targets',
        'browser_snapshot',
        'browser_act',
        'browser_open_headless',
      ]),
    );

    const callRpc = await request.post(`${baseUrl}/api/v1/mcp/rpc`, {
      headers: { Authorization: `Bearer ${desktopToken}` },
      data: {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'browser_list_targets',
          arguments: {},
        },
      },
    });
    expect(callRpc.status()).toBe(200);
    const callJson = (await callRpc.json()) as {
      result?: { isError?: boolean; content?: Array<{ type: string; text: string }> };
    };
    expect(callJson.result?.isError).not.toBe(true);
    expect(callJson.result?.content?.[0]?.text).toContain('live_web_tab');
  });
});
