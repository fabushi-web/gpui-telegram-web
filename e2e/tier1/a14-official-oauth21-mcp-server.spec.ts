import { test, expect } from '../helpers/fixtures';
import {
  API_PATHS,
  DOM,
  OAUTH_MCP_GRANTS_PANEL,
} from '../helpers/selectors';
import {
  apiUrl,
  authHeaders,
  getBaseUrl,
  registerUserViaApi,
} from '../helpers/server';
import {
  callOfficialMcpJsonRpc,
  completeOfficialMcpOAuthFlow,
} from '../helpers/api';
import { openNavDestination } from '../helpers/ui';

test.describe('Tier 1 — A14: Official OAuth 2.1 Remote MCP Server (/mcp, Streamable HTTP + SSE, PKCE S256, Grants/Audit)', () => {
  test('A14-T1-01: RFC 9728 / 8414 / OpenID discovery endpoints exposing 14 scopes & PKCE S256', async ({
    request,
  }) => {
    const baseUrl = getBaseUrl();

    for (const p of [
      API_PATHS.wellKnownOAuthProtectedResource,
      API_PATHS.wellKnownOAuthProtectedResourceMcp,
    ]) {
      const res = await request.get(apiUrl(p));
      expect(res.status()).toBe(200);
      const cacheControl = res.headers()['cache-control'];
      expect(typeof cacheControl).toBe('string');
      expect(cacheControl).toContain('no-store');
      const body = (await res.json()) as {
        resource: string;
        authorization_servers: string[];
        bearer_methods_supported: string[];
        scopes_supported: string[];
        resource_name: string;
      };
      expect(body.resource).toBe(`${baseUrl}/mcp`);
      expect(body.authorization_servers).toContain(baseUrl);
      expect(body.bearer_methods_supported).toContain('header');
      expect(body.scopes_supported.length).toBeGreaterThanOrEqual(14);
      expect(body.resource_name).toContain('Fabushi');
    }

    for (const p of [
      API_PATHS.wellKnownOAuthAuthServer,
      API_PATHS.wellKnownOpenIdConfig,
    ]) {
      const res = await request.get(apiUrl(p));
      expect(res.status()).toBe(200);
      const body = (await res.json()) as {
        authorization_endpoint: string;
        token_endpoint: string;
        registration_endpoint: string;
        revocation_endpoint: string;
        code_challenge_methods_supported: string[];
        grant_types_supported: string[];
        client_id_metadata_document_supported?: boolean;
      };
      expect(body.authorization_endpoint).toBe(`${baseUrl}/oauth/authorize`);
      expect(body.token_endpoint).toBe(`${baseUrl}/oauth/token`);
      expect(body.registration_endpoint).toBe(`${baseUrl}/oauth/register`);
      expect(body.revocation_endpoint).toBe(`${baseUrl}/oauth/revoke`);
      expect(body.code_challenge_methods_supported).toContain('S256');
      expect(body.grant_types_supported).toContain('authorization_code');
      expect(body.grant_types_supported).toContain('refresh_token');
    }
  });

  test('A14-T1-02: RFC 7591 Dynamic Client Registration (POST /oauth/register -> 201, fbmcp_cli_*) with loopback & IDE custom scheme URIs', async ({
    request,
  }) => {
    const res = await request.post(apiUrl(API_PATHS.oauthRegister), {
      data: {
        client_name: 'Cursor IDE MCP Client',
        redirect_uris: [
          'http://127.0.0.1:45555/callback',
          'cursor://fabushi.mcp/callback',
        ],
        token_endpoint_auth_method: 'none',
      },
    });
    expect([200, 201]).toContain(res.status());
    const body = (await res.json()) as {
      client_id: string;
      client_name: string;
      redirect_uris: string[];
      token_endpoint_auth_method: string;
    };
    expect(body.client_id).toMatch(/^fbmcp_cli_/);
    expect(body.client_name).toBe('Cursor IDE MCP Client');
    expect(body.redirect_uris).toContain('http://127.0.0.1:45555/callback');
  });

  test('A14-T1-03: Full OAuth 2.1 Authorization Code + PKCE S256 consent flow (/oauth/authorize -> login -> approve -> POST /oauth/token)', async ({
    request,
  }) => {
    const user = await registerUserViaApi(request);
    const oauth = await completeOfficialMcpOAuthFlow(request, user, {
      clientName: 'PKCE S256 E2E Client',
      scope: 'devices:read chats:read messaging:read',
    });

    expect(oauth.accessToken.length).toBeGreaterThan(10);
    expect(oauth.refreshToken.length).toBeGreaterThan(10);
    expect(oauth.tokenType).toBe('Bearer');
    expect(oauth.expiresIn).toBeGreaterThan(0);
    expect(oauth.scope).toContain('chats:read');
  });

  test('A14-T1-04: Streamable HTTP POST /mcp (MCP-Protocol-Version: 2025-11-25): initialize, tools/list (31 tools), resources/list, tools/call & DELETE /mcp', async ({
    request,
  }) => {
    const user = await registerUserViaApi(request);
    const oauth = await completeOfficialMcpOAuthFlow(request, user, {
      scope: 'devices:read devices:connect chats:read messaging:read tasks:manage',
    });

    const init = await callOfficialMcpJsonRpc(
      request,
      'initialize',
      {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'e2e-mcp-harness', version: '1.6.11' },
      },
      { accessToken: oauth.accessToken, id: 1 },
    );
    expect(init.status).toBe(200);
    expect(init.headers['mcp-protocol-version']).toBe('2025-11-25');
    const sessionId = init.headers['mcp-session-id'];
    expect(sessionId).toMatch(/^mcp_sess_/);

    const toolsList = await callOfficialMcpJsonRpc(
      request,
      'tools/list',
      {},
      { accessToken: oauth.accessToken, sessionId, id: 2 },
    );
    expect(toolsList.status).toBe(200);
    const toolsResult = toolsList.body?.result as { tools?: Array<{ name: string }> } | undefined;
    expect(Array.isArray(toolsResult?.tools)).toBe(true);
    expect(toolsResult!.tools!.length).toBeGreaterThanOrEqual(31);

    const resList = await callOfficialMcpJsonRpc(
      request,
      'resources/list',
      {},
      { accessToken: oauth.accessToken, sessionId, id: 3 },
    );
    expect(resList.status).toBe(200);
    const resText = JSON.stringify(resList.body);
    expect(resText).toMatch(/devices|sessions|dialogs/i);

    const callDialogs = await callOfficialMcpJsonRpc(
      request,
      'tools/call',
      { name: 'list_dialogs', arguments: {} },
      { accessToken: oauth.accessToken, sessionId, id: 4 },
    );
    expect(callDialogs.status).toBe(200);
    expect(callDialogs.body?.error).toBeUndefined();

    const delRes = await request.delete(apiUrl(API_PATHS.officialMcp), {
      headers: {
        Authorization: `Bearer ${oauth.accessToken}`,
        'Mcp-Session-Id': sessionId,
      },
    });
    expect([200, 204]).toContain(delRes.status());
  });

  test('A14-T1-05: Refresh token rotation (POST /oauth/token grant_type=refresh_token) & token revocation (POST /oauth/revoke)', async ({
    request,
  }) => {
    const user = await registerUserViaApi(request);
    const oauth = await completeOfficialMcpOAuthFlow(request, user);

    const rotRes = await request.post(apiUrl(API_PATHS.oauthToken), {
      form: {
        grant_type: 'refresh_token',
        refresh_token: oauth.refreshToken,
        client_id: oauth.clientId,
      },
    });
    expect(rotRes.status()).toBe(200);
    const rotated = (await rotRes.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(rotated.access_token).toBeTruthy();
    expect(rotated.refresh_token).toBeTruthy();
    expect(rotated.refresh_token).not.toBe(oauth.refreshToken);

    const revokeRes = await request.post(apiUrl(API_PATHS.oauthRevoke), {
      form: { token: rotated.access_token },
    });
    expect(revokeRes.status()).toBe(200);
    expect(((await revokeRes.json()) as { revoked?: boolean }).revoked).toBe(true);

    // Revoked access token MUST be rejected with 401 on POST /mcp
    const postRevoke = await callOfficialMcpJsonRpc(
      request,
      'tools/list',
      {},
      { accessToken: rotated.access_token, id: 10 },
    );
    expect(postRevoke.status).toBe(401);
  });

  test('A14-T1-06: Grants & Audit API + UI (GET/DELETE /api/v1/mcp/grants, GET /api/v1/mcp/audit, #oauth-mcp-grants-panel, #mcp-tools-dock)', async ({
    authSession,
    request,
  }) => {
    const { page, user } = authSession;
    const headers = authHeaders(user.token);

    const oauth = await completeOfficialMcpOAuthFlow(request, user, {
      clientName: 'Audited MCP Grant Client',
    });
    const init = await callOfficialMcpJsonRpc(
      request,
      'initialize',
      {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'audited-client', version: '1.0.0' },
      },
      { accessToken: oauth.accessToken },
    );
    expect(init.status).toBe(200);
    const sessionId = init.headers['mcp-session-id'];
    expect(sessionId).toMatch(/^mcp_sess_/);

    const auditedCall = await callOfficialMcpJsonRpc(
      request,
      'tools/call',
      { name: 'list_dialogs', arguments: {} },
      { accessToken: oauth.accessToken, sessionId, id: 2 },
    );
    expect(auditedCall.status).toBe(200);

    const grantsRes = await request.get(apiUrl(API_PATHS.mcpGrants), { headers });
    expect(grantsRes.status()).toBe(200);
    const grantsBody = (await grantsRes.json()) as {
      grants: Array<{ family_id: string; client_name: string }>;
    };
    const grant = grantsBody.grants.find((g) => g.client_name === 'Audited MCP Grant Client');
    expect(grant).toBeTruthy();

    const auditRes = await request.get(`${apiUrl(API_PATHS.mcpAudit)}?limit=20`, { headers });
    expect(auditRes.status()).toBe(200);
    const auditBody = (await auditRes.json()) as { entries: unknown[]; total: number };
    expect(Array.isArray(auditBody.entries)).toBe(true);
    expect(auditBody.entries.length).toBeGreaterThanOrEqual(1);

    // Open MCP workspace and verify #oauth-mcp-grants-panel lists real grant
    await openNavDestination(page, 'mcp');
    await expect(page.locator(DOM.mcpToolsDock)).toBeVisible();
    const grantsPanel = page.locator(OAUTH_MCP_GRANTS_PANEL);
    await expect(grantsPanel).toBeVisible();
    await expect(grantsPanel).toContainText('Audited MCP Grant Client');

    // Revoking grant kills the active OAuth access token
    const delGrantRes = await request.delete(
      apiUrl(`${API_PATHS.mcpGrants}/${grant!.family_id}`),
      { headers },
    );
    expect(delGrantRes.status()).toBe(200);

    const postRevokeMcp = await callOfficialMcpJsonRpc(
      request,
      'tools/list',
      {},
      { accessToken: oauth.accessToken },
    );
    expect(postRevokeMcp.status).toBe(401);
  });
});
