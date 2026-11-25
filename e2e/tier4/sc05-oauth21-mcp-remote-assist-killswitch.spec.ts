import { test, expect } from '../helpers/fixtures';
import {
  API_PATHS,
  OAUTH_MCP_GRANTS_PANEL,
  REMOTE_ASSIST_PANEL,
} from '../helpers/selectors';
import {
  apiUrl,
  authHeaders,
  registerUserViaApi,
} from '../helpers/server';
import {
  callOfficialMcpJsonRpc,
  completeOfficialMcpOAuthFlow,
} from '../helpers/api';
import { openNavDestination } from '../helpers/ui';

test.describe('Tier 4 — SC-05: Official OAuth 2.1 Remote MCP + UU-Parity Remote Assist & Emergency Kill Switch', () => {
  test('SC-05: Discover /.well-known/* -> SSRF redirect blocked 400 -> PKCE S256 consent & token -> 401/403 MCP checks -> active /mcp session + UU Remote Assist session -> Emergency Kill Switch disconnect-all terminates BOTH -> Grants UI & audit log', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const guestUser = await registerUserViaApi(request, { firstName: 'Remote Helper' });
    const hostHeaders = authHeaders(user.token);

    // 1. Discover RFC 9728 & RFC 8414 metadata
    const prRes = await request.get(apiUrl(API_PATHS.wellKnownOAuthProtectedResource));
    expect(prRes.status()).toBe(200);
    const asRes = await request.get(apiUrl(API_PATHS.wellKnownOAuthAuthServer));
    expect(asRes.status()).toBe(200);

    // 2. Confirm unsafe non-loopback HTTP redirect URI blocked 400
    const badDcr = await request.post(apiUrl(API_PATHS.oauthRegister), {
      data: { client_name: 'Unsafe', redirect_uris: ['http://evil.invalid/cb'] },
      failOnStatusCode: false,
    });
    expect(badDcr.status()).toBe(400);

    // 3. Unauthenticated /mcp returns 401 WWW-Authenticate
    const unauthMcp = await callOfficialMcpJsonRpc(request, 'tools/list', {});
    expect(unauthMcp.status).toBe(401);
    expect(unauthMcp.headers['www-authenticate']).toContain('resource_metadata=');

    // 4. Complete full PKCE S256 OAuth flow with canonical scopes & initialize Streamable HTTP /mcp session
    const oauth = await completeOfficialMcpOAuthFlow(request, user, {
      clientName: 'SC05 Official IDE MCP',
      scope: 'devices:read devices:connect chats:read messaging:read',
    });
    const init = await callOfficialMcpJsonRpc(
      request,
      'initialize',
      {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'sc05-client', version: '1.6.11' },
      },
      { accessToken: oauth.accessToken },
    );
    expect(init.status).toBe(200);
    const mcpSessionId = init.headers['mcp-session-id'];
    expect(mcpSessionId).toMatch(/^mcp_sess_/);

    const listTools = await callOfficialMcpJsonRpc(
      request,
      'tools/list',
      {},
      { accessToken: oauth.accessToken, sessionId: mcpSessionId, id: 2 },
    );
    expect(listTools.status).toBe(200);

    // 4b. Verify 403 insufficient_scope when calling privileged tool lacking power:control scope
    const deniedTool = await callOfficialMcpJsonRpc(
      request,
      'tools/call',
      { name: 'device_power_action', arguments: { action: 'lock' } },
      { accessToken: oauth.accessToken, sessionId: mcpSessionId, id: 25 },
    );
    expect(deniedTool.status).toBe(403);
    expect(deniedTool.headers['www-authenticate']).toContain('insufficient_scope');

    // 5. Simultaneously start cross-account 9-digit UU Remote Assist session
    const allowRes = await request.post(apiUrl(API_PATHS.remoteAssistAllow), {
      headers: hostHeaders,
      data: { allow_assist: true },
    });
    expect(allowRes.status()).toBe(200);

    const resetRes = await request.post(apiUrl(API_PATHS.remoteAssistResetCode), {
      headers: hostHeaders,
      data: {},
    });
    expect(resetRes.status()).toBe(200);
    const assistInfo = (await resetRes.json()) as { assist_id: string; current_code: string };
    expect(assistInfo.assist_id).toMatch(/^\d{9}$/);

    const assistStart = await request.post(apiUrl(API_PATHS.remoteAssistStart), {
      headers: authHeaders(guestUser.token),
      data: {
        assist_id: assistInfo.assist_id,
        access_code: assistInfo.current_code,
        requester_name: guestUser.firstName,
        mode: 'desktop',
      },
    });
    expect(assistStart.status()).toBe(200);

    // 6. Verify Remote Assist & OAuth MCP Grants panels in UI
    await openNavDestination(page, 'computer');
    await expect(page.locator(REMOTE_ASSIST_PANEL)).toBeVisible();

    await openNavDestination(page, 'mcp');
    await expect(page.locator(OAUTH_MCP_GRANTS_PANEL)).toBeVisible();
    await expect(page.locator(OAUTH_MCP_GRANTS_PANEL)).toContainText('SC05 Official IDE MCP');

    // 7. Trigger Emergency Kill Switch -> disconnects ALL remote + MCP sessions
    const killRes = await request.post(apiUrl(API_PATHS.remoteSessionsDisconnectAll), {
      headers: hostHeaders,
      data: {},
    });
    expect(killRes.status()).toBe(200);
    expect(((await killRes.json()) as { kill_switch: boolean }).kill_switch).toBe(true);

    const remAfterRes = await request.get(apiUrl(API_PATHS.remoteSessions), {
      headers: hostHeaders,
    });
    expect(remAfterRes.status()).toBe(200);
    const remAfter = (await remAfterRes.json()) as { sessions?: unknown[] };
    expect(Array.isArray(remAfter.sessions)).toBe(true);
    expect(remAfter.sessions).toHaveLength(0);

    const mcpAfter = await callOfficialMcpJsonRpc(
      request,
      'tools/list',
      {},
      { accessToken: oauth.accessToken, sessionId: mcpSessionId, id: 3 },
    );
    expect([401, 404, 410]).toContain(mcpAfter.status);
    expect(mcpAfter.body?.error).toBeTruthy();

    // 8. Verify audit log & non-empty grant revocation
    const auditRes = await request.get(`${apiUrl(API_PATHS.mcpAudit)}?limit=25`, {
      headers: hostHeaders,
    });
    expect(auditRes.status()).toBe(200);

    const grantsRes = await request.get(apiUrl(API_PATHS.mcpGrants), { headers: hostHeaders });
    expect(grantsRes.status()).toBe(200);
    const grants = (await grantsRes.json()) as { grants?: Array<{ family_id: string }> };
    expect(Array.isArray(grants.grants)).toBe(true);
    expect(grants.grants!.length).toBeGreaterThanOrEqual(1);
    for (const grant of grants.grants!) {
      const rev = await request.delete(
        apiUrl(`${API_PATHS.mcpGrants}/${grant.family_id}`),
        { headers: hostHeaders },
      );
      expect(rev.status()).toBe(200);
    }
  });
});
