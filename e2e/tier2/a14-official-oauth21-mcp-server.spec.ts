import * as crypto from 'node:crypto';
import { test, expect } from '../helpers/fixtures';
import { API_PATHS } from '../helpers/selectors';
import {
  apiUrl,
  authHeaders,
  getBaseUrl,
  registerUserViaApi,
} from '../helpers/server';
import {
  callOfficialMcpJsonRpc,
  completeOfficialMcpOAuthFlow,
  generatePkceS256,
  obtainOfficialMcpAuthCode,
} from '../helpers/api';

test.describe('Tier 2 — A14: Official OAuth 2.1 MCP Security (401/403 WWW-Authenticate, SSRF/Redirect, PKCE Replay & Zero Fake Tools)', () => {
  test('A14-T2-01: Unauthenticated POST /mcp returns 401 with WWW-Authenticate Bearer resource_metadata and JSON-RPC -32001', async ({
    request,
  }) => {
    const res = await callOfficialMcpJsonRpc(request, 'tools/list', {});
    expect(res.status).toBe(401);
    const wwwAuth = res.headers['www-authenticate'];
    expect(typeof wwwAuth).toBe('string');
    expect(wwwAuth).toMatch(/Bearer/i);
    expect(wwwAuth).toContain('resource_metadata=');
    expect(wwwAuth).toContain('.well-known/oauth-protected-resource');
    const errObj = res.body?.error as { code?: number } | undefined;
    expect(errObj?.code).toBe(-32001);
  });

  test('A14-T2-02: Valid OAuth token lacking required scope calling privileged MCP tool returns 403 insufficient_scope & JSON-RPC -32002', async ({
    request,
  }) => {
    const user = await registerUserViaApi(request);
    // Request strictly minimal read-only scope (no messaging:write scope)
    const oauth = await completeOfficialMcpOAuthFlow(request, user, {
      scope: 'devices:read',
    });

    const init = await callOfficialMcpJsonRpc(
      request,
      'initialize',
      {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'low-scope-client', version: '1.0.0' },
      },
      { accessToken: oauth.accessToken },
    );
    expect(init.status).toBe(200);
    const sessionId = init.headers['mcp-session-id'];

    const forbiddenCall = await callOfficialMcpJsonRpc(
      request,
      'tools/call',
      { name: 'send_message', arguments: { chat_id: 1, text: 'unauthorized' } },
      { accessToken: oauth.accessToken, sessionId, id: 2 },
    );
    expect(forbiddenCall.status).toBe(403);
    const wwwAuth = forbiddenCall.headers['www-authenticate'];
    expect(typeof wwwAuth).toBe('string');
    expect(wwwAuth).toContain('insufficient_scope');
    const errObj = forbiddenCall.body?.error as { code?: number } | undefined;
    expect(errObj?.code).toBe(-32002);
  });

  test('A14-T2-03: POST /oauth/register rejects non-loopback http://, #fragment, userinfo & traversal with 400; CIMD SSRF rejected 400', async ({
    request,
  }) => {
    for (const badUri of [
      'http://evil.example.com/callback',
      'https://client.example.com/cb#fragment',
      'https://user:pass@client.example.com/cb',
      'https://client.example.com/../../etc/passwd',
    ]) {
      const res = await request.post(apiUrl(API_PATHS.oauthRegister), {
        data: { client_name: 'Bad Redirect Client', redirect_uris: [badUri] },
        failOnStatusCode: false,
      });
      expect(res.status()).toBe(400);
    }

    // CIMD SSRF against loopback / private metadata URI rejected 400
    const pkce = generatePkceS256();
    const ssrfParams = new URLSearchParams({
      response_type: 'code',
      client_id: 'https://127.0.0.1/metadata.json',
      redirect_uri: 'http://127.0.0.1:41234/cb',
      code_challenge: pkce.codeChallenge,
      code_challenge_method: 'S256',
      scope: 'devices:read',
      resource: `${getBaseUrl()}/mcp`,
    });
    const ssrfRes = await request.get(
      `${apiUrl(API_PATHS.oauthAuthorize)}?${ssrfParams.toString()}`,
      { failOnStatusCode: false },
    );
    expect(ssrfRes.status()).toBe(400);
  });

  test('A14-T2-04: /oauth/authorize without PKCE S256 fails (400); /oauth/token rejects wrong code_verifier and rotated refresh token replay (400 invalid_grant)', async ({
    request,
  }) => {
    const dcrRes = await request.post(apiUrl(API_PATHS.oauthRegister), {
      data: {
        client_name: 'PKCE Negative Client',
        redirect_uris: ['http://127.0.0.1:41235/cb'],
        token_endpoint_auth_method: 'none',
      },
    });
    expect([200, 201]).toContain(dcrRes.status());
    const dcr = (await dcrRes.json()) as { client_id: string };

    // 1. Missing code_challenge_method=S256 -> 400
    const plainRes = await request.get(
      `${apiUrl(API_PATHS.oauthAuthorize)}?response_type=code&client_id=${encodeURIComponent(dcr.client_id)}&redirect_uri=${encodeURIComponent('http://127.0.0.1:41235/cb')}&code_challenge=plain123&code_challenge_method=plain`,
      { failOnStatusCode: false },
    );
    expect(plainRes.status()).toBe(400);

    // 2. Wrong PKCE code_verifier on /oauth/token -> 400 invalid_grant
    const user = await registerUserViaApi(request);
    const authCodeFlow = await obtainOfficialMcpAuthCode(request, user, {
      clientName: 'Wrong Verifier Client',
      scope: 'devices:read',
    });
    const wrongVerifierRes = await request.post(apiUrl(API_PATHS.oauthToken), {
      form: {
        grant_type: 'authorization_code',
        client_id: authCodeFlow.clientId,
        code: authCodeFlow.authCode,
        redirect_uri: authCodeFlow.redirectUri,
        code_verifier: `wrong_verifier_${crypto.randomBytes(16).toString('hex')}`,
        resource: authCodeFlow.resource,
      },
      failOnStatusCode: false,
    });
    expect(wrongVerifierRes.status()).toBe(400);
    expect(await wrongVerifierRes.text()).toContain('invalid_grant');

    // 3. Rotated refresh token reuse -> 400 invalid_grant
    const oauth = await completeOfficialMcpOAuthFlow(request, user);

    const rot1 = await request.post(apiUrl(API_PATHS.oauthToken), {
      form: {
        grant_type: 'refresh_token',
        refresh_token: oauth.refreshToken,
        client_id: oauth.clientId,
      },
    });
    expect(rot1.status()).toBe(200);

    // Replaying the already-rotated original refresh token MUST fail with 400 invalid_grant
    const replay = await request.post(apiUrl(API_PATHS.oauthToken), {
      form: {
        grant_type: 'refresh_token',
        refresh_token: oauth.refreshToken,
        client_id: oauth.clientId,
      },
      failOnStatusCode: false,
    });
    expect(replay.status()).toBe(400);
    expect(await replay.text()).toContain('invalid_grant');
  });

  test('A14-T2-05: Cross-user Mcp-Session-Id rejected on POST /mcp (401/403/404) and unsupported protocol version rejected', async ({
    request,
  }) => {
    const userA = await registerUserViaApi(request);
    const userB = await registerUserViaApi(request);
    const oauthA = await completeOfficialMcpOAuthFlow(request, userA);
    const oauthB = await completeOfficialMcpOAuthFlow(request, userB);

    const initA = await callOfficialMcpJsonRpc(
      request,
      'initialize',
      {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'user-a', version: '1.0' },
      },
      { accessToken: oauthA.accessToken },
    );
    expect(initA.status).toBe(200);
    const sessionA = initA.headers['mcp-session-id'];

    // User B trying to hijack User A's Mcp-Session-Id is rejected with structured error
    const hijack = await callOfficialMcpJsonRpc(
      request,
      'tools/list',
      {},
      { accessToken: oauthB.accessToken, sessionId: sessionA },
    );
    expect([401, 403, 404]).toContain(hijack.status);
    expect(hijack.body?.error).toBeTruthy();

    // Unsupported MCP-Protocol-Version rejected with 400
    const badProto = await callOfficialMcpJsonRpc(
      request,
      'tools/list',
      {},
      { accessToken: oauthA.accessToken, sessionId: sessionA, protocolVersion: '1999-01-01' },
    );
    expect(badProto.status).toBe(400);
  });

  test('A14-T2-06: Fresh user MCP tools list has ZERO fabricated mcp_filesystem stubs and unknown tool invoke fails cleanly', async ({
    request,
  }) => {
    const user = await registerUserViaApi(request);
    const headers = authHeaders(user.token);

    const toolsRes = await request.get(apiUrl(API_PATHS.mcpTools), { headers });
    expect(toolsRes.status()).toBe(200);
    const toolsText = await toolsRes.text();
    const toolsParsed = JSON.parse(toolsText) as { tools?: unknown } | unknown[];
    const toolsList = Array.isArray(toolsParsed) ? toolsParsed : toolsParsed.tools;
    expect(Array.isArray(toolsList)).toBe(true);
    expect(toolsList as unknown[]).toHaveLength(0);
    expect(toolsText).not.toContain('mcp_filesystem');
    expect(toolsText).not.toContain('fs_read_file');
    expect(toolsText).not.toContain('fs_write_file');

    // Authenticated Official MCP POST /mcp unknown tool invoke returns structured JSON-RPC 2.0 error (rejects HTTP 500 & plain non-JSON-RPC 404)
    const oauth = await completeOfficialMcpOAuthFlow(request, user, {
      scope: 'devices:read chats:read',
    });
    const init = await callOfficialMcpJsonRpc(
      request,
      'initialize',
      {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'unknown-tool-check', version: '1.6.11' },
      },
      { accessToken: oauth.accessToken, id: 1 },
    );
    expect(init.status).toBe(200);
    const sessionId = init.headers['mcp-session-id'];

    const badTool = await callOfficialMcpJsonRpc(
      request,
      'tools/call',
      { name: 'nonexistent_tool', arguments: {} },
      { accessToken: oauth.accessToken, sessionId, id: 2 },
    );
    // Reject HTTP 500 crashes and plain non-JSON-RPC 404 route misses;
    // accept compliant JSON-RPC 2.0 error responses on HTTP 200, 400, or upstream v1.6.11 HTTP 404 (-32601)
    if (badTool.status === 200) {
      expect(badTool.body?.jsonrpc).toBe('2.0');
    } else {
      expect([400, 404]).toContain(badTool.status);
      expect(badTool.body?.jsonrpc).toBe('2.0');
    }
    expect(badTool.body?.id).toBe(2);
    expect(badTool.body?.error).toBeTruthy();
    const rpcErr = badTool.body?.error as { code?: unknown; message?: unknown };
    expect(typeof rpcErr.code).toBe('number');
    expect(rpcErr.code as number).toBeLessThan(0);
    expect(typeof rpcErr.message).toBe('string');
    expect((rpcErr.message as string).length).toBeGreaterThan(0);
    expect(JSON.stringify(badTool.body)).not.toContain('Executed MCP tool');
  });
});
