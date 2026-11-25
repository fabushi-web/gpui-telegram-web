import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTOMATION_APP_SCHEMA_VERSION_V1 } from '@gpui-telegram/protocol';
import { createTelegramServer, type TelegramServerInstance } from '../../../apps/server/src/index.js';

async function apiJson(
  baseUrl: string,
  method: string,
  urlPath: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, headers: res.headers, data, rawText: text };
}

async function registerUser(baseUrl: string, username: string) {
  const res = await apiJson(baseUrl, 'POST', '/api/v1/auth/register', {
    body: { username, password: 'TestPassword123!', first_name: username },
  });
  expect(res.status).toBe(201);
  return { token: res.data.token as string, userId: Number(res.data.user.user_id) };
}

describe('M3 Domain 3 — Persistent Browser Bridge, Script Distillation, Zero-LLM CDP Replay & Automation Script App Store', () => {
  let tmpDir = '';
  let srv: TelegramServerInstance;
  let baseUrl = '';
  let fixtureSrv: http.Server;
  let fixtureUrl = '';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabushi-m3-d3-'));
    srv = createTelegramServer({
      port: 0,
      host: '127.0.0.1',
      dataDir: tmpDir,
      enableTestReset: true,
    });
    baseUrl = (await srv.start()).baseUrl;

    fixtureSrv = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html>
<html>
  <head><title>Replay Fixture</title></head>
  <body>
    <input data-testid="query-input" placeholder="Search" />
    <button data-testid="submit-btn" onclick="document.querySelector('[data-testid=result-box]').textContent = 'Result: ' + document.querySelector('[data-testid=query-input]').value">Run</button>
    <div data-testid="result-box">Idle</div>
  </body>
</html>`);
    });
    await new Promise<void>((resolve) => fixtureSrv.listen(0, '127.0.0.1', () => resolve()));
    const port = (fixtureSrv.address() as { port: number }).port;
    fixtureUrl = `http://127.0.0.1:${port}/`;
  });

  afterAll(async () => {
    await srv.close();
    await new Promise<void>((resolve) => fixtureSrv.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists desktop pairing tokens, control_generation & audit logs in SQLite across full server restarts', async () => {
    const alice = await registerUser(baseUrl, 'm3_persist_alice');

    const pair = await apiJson(baseUrl, 'POST', '/api/v1/browser/pair/create', {
      token: alice.token,
      body: { label: 'Restart Test Desktop' },
    });
    expect(pair.status).toBe(200);
    expect(pair.data.pair_code).toBe(pair.data.pairing_code);
    expect(pair.data.desktop_token).toBe(pair.data.control_token);

    const claimed = await apiJson(baseUrl, 'POST', '/api/v1/browser/pair/claim', {
      body: { pairing_code: pair.data.pairing_code, controller_label: 'Restart Test Desktop' },
    });
    expect(claimed.status).toBe(200);
    const desktopToken = claimed.data.desktop_token as string;

    // Close and reopen server on the EXACT same SQLite dataDir!
    await srv.close();
    srv = createTelegramServer({
      port: 0,
      host: '127.0.0.1',
      dataDir: tmpDir,
      enableTestReset: true,
    });
    baseUrl = (await srv.start()).baseUrl;

    // Desktop token & audit trail MUST survive restart!
    const targetsAfterRestart = await apiJson(baseUrl, 'GET', '/api/v1/browser/targets', {
      headers: { 'X-Desktop-Browser-Token': desktopToken },
    });
    expect(targetsAfterRestart.status).toBe(200);
    expect(targetsAfterRestart.data.control_generation).toBe(1);

    const auditAfterRestart = await apiJson(baseUrl, 'GET', '/api/v1/browser/audit', {
      headers: { 'X-Desktop-Browser-Token': desktopToken },
    });
    expect(auditAfterRestart.status).toBe(200);
    expect(auditAfterRestart.data.entries.some((e: any) => e.action === 'pair_claim')).toBe(true);

    // Revoke control -> control_generation increments to 2 -> desktop token immediately 401!
    const revoked = await apiJson(baseUrl, 'POST', '/api/v1/browser/revoke', {
      token: alice.token,
      body: { revoke_tokens: true },
    });
    expect(revoked.status).toBe(200);
    expect(revoked.data.control_generation).toBe(2);

    const afterRevoke = await apiJson(baseUrl, 'GET', '/api/v1/browser/targets', {
      headers: { 'X-Desktop-Browser-Token': desktopToken },
    });
    expect(afterRevoke.status).toBe(401);
  });

  it('distills BrowserActionTrace (scrubbing secrets + blocking metadata SSRF) and replays deterministically with ZERO LLM on real Chromium CDP', async () => {
    const alice = await registerUser(baseUrl, 'm3_replay_alice');

    // 1. Metadata SSRF URL rejected during distillation
    const ssrfDistill = await apiJson(baseUrl, 'POST', '/api/v1/browser/scripts/distill', {
      token: alice.token,
      body: {
        trace: {
          trace_id: 'tr_ssrf',
          initial_url: 'http://169.254.169.254/latest/meta-data/',
          actions: [{ seq: 0, timestamp_ms: Date.now(), page_url: 'http://169.254.169.254/', action: { kind: 'navigate', url: 'http://169.254.169.254/latest/meta-data/' } }],
        },
        metadata: { name: 'SSRF Script' },
      },
    });
    expect(ssrfDistill.status).toBe(400);

    // 2. Distill trace with secret password field -> literal value MUST be scrubbed into {{password}} + is_secret: true!
    const secretPass = 'MySuperSecretPassword!99';
    const distilledSecret = await apiJson(baseUrl, 'POST', '/api/v1/browser/scripts/distill', {
      token: alice.token,
      body: {
        trace: {
          trace_id: 'tr_secret',
          initial_url: fixtureUrl,
          actions: [
            { seq: 1, timestamp_ms: Date.now(), page_url: fixtureUrl, action: { kind: 'navigate', url: fixtureUrl } },
            {
              seq: 2,
              timestamp_ms: Date.now(),
              page_url: fixtureUrl,
              action: {
                kind: 'fill',
                locator: { name_attr: 'password', css_selector: 'input[type=password]' },
                value: secretPass,
                is_secret: true,
              },
            },
          ],
        },
        metadata: { name: 'Login Script', slug: 'login-script' },
      },
    });
    expect(distilledSecret.status).toBe(200);
    expect(JSON.stringify(distilledSecret.data.manifest)).not.toContain(secretPass);
    const passParam = distilledSecret.data.manifest.parameters.find((p: any) => p.name === 'password');
    expect(passParam).toMatchObject({ is_secret: true, default_value: null });

    // 3. Distill fixture workflow & replay deterministically over REAL Chromium CDP with used_llm: false!
    const distilled = await apiJson(baseUrl, 'POST', '/api/v1/browser/scripts/distill', {
      token: alice.token,
      body: {
        trace: {
          trace_id: 'tr_replay',
          initial_url: fixtureUrl,
          parameter_bindings: [{ param_name: 'search_term', literal_value: 'SAMPLE_QUERY', required: true }],
          actions: [
            { seq: 1, timestamp_ms: Date.now(), page_url: fixtureUrl, action: { kind: 'navigate', url: fixtureUrl } },
            { seq: 2, timestamp_ms: Date.now(), page_url: fixtureUrl, action: { kind: 'fill', locator: { test_id: 'query-input' }, value: 'SAMPLE_QUERY' } },
            { seq: 3, timestamp_ms: Date.now(), page_url: fixtureUrl, action: { kind: 'click', locator: { test_id: 'submit-btn' } } },
            { seq: 4, timestamp_ms: Date.now(), page_url: fixtureUrl, action: { kind: 'assert_visible', locator: { test_id: 'result-box' } } },
            { seq: 5, timestamp_ms: Date.now(), page_url: fixtureUrl, action: { kind: 'extract_text', locator: { test_id: 'result-box' }, output_key: 'summary' } },
          ],
        },
        metadata: { name: 'Fixture Search App', app_id: 'fixture-search-app' },
      },
    });
    expect(distilled.status).toBe(200);
    const manifest = distilled.data.manifest;

    const replay = await apiJson(baseUrl, 'POST', '/api/v1/browser/scripts/replay', {
      token: alice.token,
      body: { manifest, params: { search_term: 'DeterministicZeroLLM' } },
    });
    expect(replay.status).toBe(200);
    expect(replay.data.report.success).toBe(true);
    expect(replay.data.report.used_llm).toBe(false);
    expect(replay.data.report.steps_executed).toBe(5);
    expect(replay.data.report.extracted_outputs.summary).toBe('Result: DeterministicZeroLLM');

    // 4. Control Mode transitions
    const cmResume = await apiJson(baseUrl, 'POST', '/api/v1/browser/control-mode', {
      token: alice.token,
      body: { action: 'resume', active_step: 2, status_text: 'Running' },
    });
    expect(cmResume.status).toBe(200);
    expect(cmResume.data.control_mode.mode).toBe('ai_controlling');

    const cmTakeover = await apiJson(baseUrl, 'POST', '/api/v1/browser/control-mode', {
      token: alice.token,
      body: { action: 'takeover', paused_at_step: 2 },
    });
    expect(cmTakeover.status).toBe(200);
    expect(cmTakeover.data.control_mode.mode).toBe('user_takeover');
  }, 30000);

  it('enforces Automation Script App Store 7 endpoints, 422 secret leak scanner, owner auth, idempotent installs & run telemetry', async () => {
    const alice = await registerUser(baseUrl, 'm3_store_alice');
    const bob = await registerUser(baseUrl, 'm3_store_bob');

    // 1. Secret leak scanner MUST block embedded API keys with 422!
    const leakedKey = ['sk', 'proj', 'LeakedOpenAiKey99887766554433221100'].join('-');
    const leakPublish = await apiJson(baseUrl, 'POST', '/api/v1/automation-apps', {
      token: alice.token,
      body: {
        manifest: {
          schema_version: AUTOMATION_APP_SCHEMA_VERSION_V1,
          app_id: 'leaky-app',
          slug: 'leaky-app',
          name: 'Leaky App',
          version: '1.0.0',
          description: `Uses ${leakedKey}`,
          category: 'automation',
          target_domains: ['example.com'],
          parameters: [],
          steps: [{ kind: 'navigate', url_template: 'https://example.com' }],
          required_capabilities: ['browser.cdp'],
        },
      },
    });
    expect(leakPublish.status).toBe(422);
    expect(leakPublish.data.error).toBe('secret_leak_detected');

    // 2. Clean publish v1.0.0 + update to v1.1.0 + cross-author 403
    const pub1 = await apiJson(baseUrl, 'POST', '/api/v1/automation-apps', {
      token: alice.token,
      body: {
        manifest: {
          schema_version: AUTOMATION_APP_SCHEMA_VERSION_V1,
          app_id: 'github-triage',
          slug: 'github-triage',
          name: 'GitHub Issue Triage',
          version: '1.0.0',
          description: 'Triages issues deterministically',
          category: 'devtools',
          target_domains: ['github.com'],
          parameters: [{ name: 'repo', description: 'owner/repo', required: true, default_value: null, is_secret: false }],
          steps: [{ kind: 'navigate', url_template: 'https://github.com/{{repo}}/issues' }],
          required_capabilities: ['browser.cdp'],
        },
      },
    });
    expect(pub1.status).toBe(201);
    expect(pub1.data.content_sha256).toMatch(/^[0-9a-f]{64}$/);

    // Bob cannot overwrite Alice's app_id -> 403!
    const bobHijack = await apiJson(baseUrl, 'POST', '/api/v1/automation-apps', {
      token: bob.token,
      body: {
        manifest: {
          ...pub1.data.manifest,
          version: '2.0.0',
        },
      },
    });
    expect(bobHijack.status).toBe(403);

    // Alice publishes v1.1.0 (existing app update returns 200)
    const pub2 = await apiJson(baseUrl, 'POST', '/api/v1/automation-apps', {
      token: alice.token,
      body: { manifest: { ...pub1.data.manifest, version: '1.1.0' } },
    });
    expect(pub2.status).toBe(200);
    expect(pub2.data.versions).toEqual(['1.1.0', '1.0.0']);

    // Duplicate (app_id, version) MUST return 409 version_conflict!
    const dupVer = await apiJson(baseUrl, 'POST', '/api/v1/automation-apps', {
      token: alice.token,
      body: { manifest: { ...pub1.data.manifest, version: '1.1.0' } },
    });
    expect(dupVer.status).toBe(409);
    expect(dupVer.data.error).toBe('version_conflict');

    // Private draft hidden from Bob (404), visible to Alice (200)
    const draft = await apiJson(baseUrl, 'POST', '/api/v1/automation-apps', {
      token: alice.token,
      body: {
        is_published: false,
        manifest: { ...pub1.data.manifest, app_id: 'private-draft', slug: 'private-draft', name: 'Private Draft' },
      },
    });
    expect(draft.status).toBe(201);
    expect((await apiJson(baseUrl, 'GET', '/api/v1/automation-apps/private-draft', { token: bob.token })).status).toBe(404);
    expect((await apiJson(baseUrl, 'GET', '/api/v1/automation-apps/private-draft', { token: alice.token })).status).toBe(200);

    // 3. Catalog search, detail (?version=1.0.0), idempotent install, /installed & /mine, run telemetry, uninstall
    const search = await apiJson(baseUrl, 'GET', '/api/v1/automation-apps?q=triage&domain=github.com', {
      token: bob.token,
    });
    expect(search.status).toBe(200);
    expect(search.data.total).toBe(1);

    const oldVer = await apiJson(baseUrl, 'GET', '/api/v1/automation-apps/github-triage?version=1.0.0', {
      token: bob.token,
    });
    expect(oldVer.status).toBe(200);
    expect(oldVer.data.manifest.version).toBe('1.0.0');

    const inst1 = await apiJson(baseUrl, 'POST', '/api/v1/automation-apps/github-triage/install', { token: bob.token });
    expect(inst1.status).toBe(200);
    expect(inst1.data.install_count).toBe(1);
    expect(inst1.data.newly_installed).toBe(true);
    expect(inst1.data.app.manifest.app_id).toBe('github-triage');
    const inst2 = await apiJson(baseUrl, 'POST', '/api/v1/automation-apps/github-triage/install', { token: bob.token });
    expect(inst2.status).toBe(200);
    expect(inst2.data.install_count).toBe(1); // Idempotent!
    expect(inst2.data.newly_installed).toBe(false);

    const installed = await apiJson(baseUrl, 'GET', '/api/v1/automation-apps/installed', { token: bob.token });
    expect(installed.status).toBe(200);
    expect(installed.data.apps.some((a: any) => a.app_id === 'github-triage')).toBe(true);

    const mine = await apiJson(baseUrl, 'GET', '/api/v1/automation-apps/mine', { token: bob.token });
    expect(mine.status).toBe(200);
    expect(mine.data.installed.some((a: any) => a.app_id === 'github-triage')).toBe(true);

    // Unknown run version MUST return 400 validation_error
    const badRunVer = await apiJson(baseUrl, 'POST', '/api/v1/automation-apps/github-triage/runs', {
      token: bob.token,
      body: { version: '9.9.9', success: true },
    });
    expect(badRunVer.status).toBe(400);
    expect(badRunVer.data.error).toBe('validation_error');

    const run = await apiJson(baseUrl, 'POST', '/api/v1/automation-apps/github-triage/runs', {
      token: bob.token,
      body: { success: true, steps_executed: 1, total_duration_ms: 85, used_llm: false },
    });
    expect(run.status).toBe(200);
    expect(run.data.run_count).toBe(1);
    expect(run.data.status).toBe('succeeded');

    const uninst = await apiJson(baseUrl, 'DELETE', '/api/v1/automation-apps/github-triage/install', { token: bob.token });
    expect(uninst.status).toBe(200);
    expect(uninst.data.install_count).toBe(0);
    expect(uninst.data.removed).toBe(true);
  });

  it('hardens VETO-2 two-pass secret scanner (changelog + duplicate JSON keys), author spoofing, size cap, SSRF, non-scalar 400s & distillation scrubbing', async () => {
    const alice = await registerUser(baseUrl, 'm3_sec_alice');
    const bob = await registerUser(baseUrl, 'm3_sec_bob');

    const baseManifest = {
      schema_version: AUTOMATION_APP_SCHEMA_VERSION_V1,
      app_id: 'sec-clean-app',
      slug: 'sec-clean-app',
      name: 'Clean App',
      version: '1.0.0',
      description: 'Clean description',
      category: 'automation',
      target_domains: ['example.com'],
      parameters: [
        {
          name: 'corp_password',
          description: 'Vault credential',
          required: true,
          default_value: null,
          is_secret: true,
        },
      ],
      steps: [
        {
          kind: 'fill',
          locator: { css_selector: 'input[type="password"]' },
          value_template: '{{corp_password}}',
          secret_vault_key: 'corp_password',
        },
      ],
      required_capabilities: ['browser.cdp'],
    };

    // 1. Legitimate manifest with is_secret: true + secret_vault_key MUST succeed (zero false positives!)
    const okClean = await apiJson(baseUrl, 'POST', '/api/v1/automation-apps', {
      token: alice.token,
      body: { manifest: baseManifest, changelog: 'Initial clean release' },
    });
    expect(okClean.status).toBe(201);

    // 2. Secret hidden in top-level changelog or extra unknown field MUST return 422 secret_leak_detected
    const syntheticJwt = [
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
      'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    ].join('.');
    const changelogLeak = await apiJson(baseUrl, 'POST', '/api/v1/automation-apps', {
      token: alice.token,
      body: {
        manifest: { ...baseManifest, app_id: 'sec-changelog-leak', slug: 'sec-changelog-leak' },
        changelog: `Tested with Authorization: Bearer ${syntheticJwt}`,
      },
    });
    expect(changelogLeak.status).toBe(422);
    expect(changelogLeak.data.error).toBe('secret_leak_detected');

    const extraFieldLeak = await apiJson(baseUrl, 'POST', '/api/v1/automation-apps', {
      token: alice.token,
      body: {
        manifest: { ...baseManifest, app_id: 'sec-extra-field', slug: 'sec-extra-field' },
        debug_token: ['ghp', '1234567890abcdef1234567890abcdef1234'].join('_'),
      },
    });
    expect(extraFieldLeak.status).toBe(422);
    expect(extraFieldLeak.data.error).toBe('secret_leak_detected');

    // 3. VETO-2: Secrets shadowed inside duplicate JSON keys (manifest, changelog, Unicode-escaped) MUST return 422!
    const syntheticSk = ['sk', 'proj', 'ShadowedDuplicateKey1234567890abcd'].join('-');
    const dupRawBody = `{"manifest":{"schema_version":1,"app_id":"sec-dup-key","slug":"sec-dup-key","name":"Dup Key","version":"1.0.0","description":"${syntheticSk}","description":"Totally clean description","category":"automation","target_domains":["example.com"],"parameters":[],"steps":[{"kind":"navigate","url_template":"https://example.com"}],"required_capabilities":["browser.cdp"]}}`;
    const dupRes = await fetch(`${baseUrl}/api/v1/automation-apps`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${alice.token}`,
        'Content-Type': 'application/json',
      },
      body: dupRawBody,
    });
    expect(dupRes.status).toBe(422);
    expect((await dupRes.json()).error).toBe('secret_leak_detected');

    const dupChangelogBody = `{"changelog":"Bearer ${syntheticJwt}","changelog":"clean","manifest":{"schema_version":1,"app_id":"sec-dup-cl","slug":"sec-dup-cl","name":"Dup CL","version":"1.0.0","description":"Clean","category":"automation","target_domains":["example.com"],"parameters":[],"steps":[{"kind":"navigate","url_template":"https://example.com"}],"required_capabilities":["browser.cdp"]}}`;
    const dupClRes = await fetch(`${baseUrl}/api/v1/automation-apps`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.token}`, 'Content-Type': 'application/json' },
      body: dupChangelogBody,
    });
    expect(dupClRes.status).toBe(422);
    expect((await dupClRes.json()).error).toBe('secret_leak_detected');

    const dupUnicodeBody = `{"manifest":{"schema_version":1,"app_id":"sec-dup-uni","slug":"sec-dup-uni","name":"Dup Uni","version":"1.0.0","\\u0064escription":"${syntheticSk}","description":"Clean","category":"automation","target_domains":["example.com"],"parameters":[],"steps":[{"kind":"navigate","url_template":"https://example.com"}],"required_capabilities":["browser.cdp"]}}`;
    const dupUniRes = await fetch(`${baseUrl}/api/v1/automation-apps`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${alice.token}`, 'Content-Type': 'application/json' },
      body: dupUnicodeBody,
    });
    expect(dupUniRes.status).toBe(422);
    expect((await dupUniRes.json()).error).toBe('secret_leak_detected');

    // 4. VETO-2: Secret shadowed inside duplicate parameter default_value MUST return 422 secret_leak_detected!
    const dupParamRaw = `{"manifest":{"schema_version":1,"app_id":"sec-dup-param","slug":"sec-dup-param","name":"Dup Param","version":"1.0.0","description":"Clean","category":"automation","target_domains":["example.com"],"parameters":[{"name":"p","is_secret":true,"default_value":"RawSecret123!","default_value":null}],"steps":[{"kind":"navigate","url_template":"https://example.com"}],"required_capabilities":["browser.cdp"]}}`;
    const dupParamRes = await fetch(`${baseUrl}/api/v1/automation-apps`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${alice.token}`,
        'Content-Type': 'application/json',
      },
      body: dupParamRaw,
    });
    expect(dupParamRes.status).toBe(422);
    expect((await dupParamRes.json()).error).toBe('secret_leak_detected');

    // 5. Author spoofing via forged author_id MUST return 403 forbidden
    const spoofRes = await apiJson(baseUrl, 'POST', '/api/v1/automation-apps', {
      token: bob.token,
      body: {
        manifest: {
          ...baseManifest,
          app_id: 'sec-spoof-author',
          slug: 'sec-spoof-author',
          author_id: String(alice.userId),
        },
      },
    });
    expect(spoofRes.status).toBe(403);

    // 6. Reserved app_id="installed" rejected 400 invalid_app_id; >512 KiB rejected 400 payload_too_large
    const reservedRes = await apiJson(baseUrl, 'POST', '/api/v1/automation-apps', {
      token: alice.token,
      body: { manifest: { ...baseManifest, app_id: 'installed', slug: 'installed' } },
    });
    expect(reservedRes.status).toBe(400);
    expect(reservedRes.data.error).toBe('invalid_app_id');

    const hugeRes = await fetch(`${baseUrl}/api/v1/automation-apps`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${alice.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ manifest: { ...baseManifest, description: 'a'.repeat(530 * 1024) } }),
    });
    expect(hugeRes.status).toBe(400);
    expect((await hugeRes.json()).error).toBe('payload_too_large');

    // 7. Cloud metadata / link-local SSRF URLs MUST be blocked with 400 unsafe_browser_url
    for (const ssrfUrl of [
      'http://169.254.169.254/latest/meta-data/',
      'http://100.100.100.200/latest/meta-data/',
      'http://[::ffff:169.254.169.254]/latest/meta-data/',
      'http://[fe80::1]/',
      'http://[fd00:ec2::254]/',
      'http://metadata.google.internal/computeMetadata/v1/',
    ]) {
      const ssrfOpen = await apiJson(baseUrl, 'POST', '/api/v1/browser/headless/open', {
        token: alice.token,
        body: { url: ssrfUrl },
      });
      expect(ssrfOpen.status).toBe(400);
      expect(ssrfOpen.data.error).toBe('unsafe_browser_url');
    }

    // 8. All non-scalar inputs on browserControl return clean 400 (ZERO 500s & revoke does NOT mutate generation on 400!)
    const statusBeforeBadRevoke = await apiJson(baseUrl, 'GET', '/api/v1/browser/status', { token: alice.token });
    const genBeforeBadRevoke = Number(statusBeforeBadRevoke.data.control_generation ?? 0);
    expect(
      (await apiJson(baseUrl, 'POST', '/api/v1/browser/revoke', { token: alice.token, body: { reason: ['arr'], target_id: { bad: 1 } } })).status,
    ).toBe(400);
    const statusAfterBadRevoke = await apiJson(baseUrl, 'GET', '/api/v1/browser/status', { token: alice.token });
    expect(Number(statusAfterBadRevoke.data.control_generation ?? 0)).toBe(genBeforeBadRevoke);
    expect(
      (await apiJson(baseUrl, 'POST', '/api/v1/browser/pair/create', { token: alice.token, body: { label: ['arr'], ttl_secs: 'not_a_number' } })).status,
    ).toBe(400);
    expect(
      (await apiJson(baseUrl, 'POST', '/api/v1/browser/pair/claim', { body: { pair_code: [] } })).status,
    ).toBe(400);
    expect(
      (await apiJson(baseUrl, 'POST', '/api/v1/browser/targets/register', { token: alice.token, body: { target_id: ['arr'], url: { x: 1 } } })).status,
    ).toBe(400);
    expect(
      (await apiJson(baseUrl, 'POST', '/api/v1/browser/headless/open', { token: alice.token, body: { url: 12345, viewport: { width: 'bad', height: null } } })).status,
    ).toBe(400);
    expect(
      (await apiJson(baseUrl, 'POST', '/api/v1/browser/headless/open', { token: alice.token, body: { backend: 'custom_svg' } })).status,
    ).toBe(400);
    expect(
      (await apiJson(baseUrl, 'POST', '/api/v1/browser/command', { token: alice.token, body: { action: 123 } })).status,
    ).toBe(400);
    expect(
      (await apiJson(baseUrl, 'POST', '/api/v1/browser/scripts/distill', { token: alice.token, body: { trace: { actions: [null] }, metadata: { name: 'Bad' } } })).status,
    ).toBe(400);

    // MCP manifest tool descriptions must NOT mention legacy HTTP DOM fallback
    const manifestRes = await apiJson(baseUrl, 'GET', '/api/v1/mcp/manifest', { token: alice.token });
    expect(manifestRes.status).toBe(200);
    const headlessTools = (manifestRes.data.tools ?? []).filter(
      (t: any) => t.name === 'browser_open_headless' || t.name === 'browser_headless_open',
    );
    expect(headlessTools.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(headlessTools).toLowerCase()).not.toContain('fallback');

    // 9. Distillation auto-scrubs URL credentials, query tokens, hash tokens & secret fills + uses numeric author_id
    const distillRes = await apiJson(baseUrl, 'POST', '/api/v1/browser/scripts/distill', {
      token: alice.token,
      body: {
        metadata: { name: 'Scrubbed Auth Flow', app_id: 'scrubbed-auth-flow', slug: 'scrubbed-auth-flow' },
        trace: {
          trace_id: 'tr_scrub',
          initial_url: 'https://portal.example.com',
          actions: [
            {
              seq: 1,
              action: {
                kind: 'navigate',
                url: 'https://alice:BasicPass99@portal.example.com/callback?api_key=MySecretApiKey12345&page=1#access_token=HashTok987654321&state=ok',
              },
            },
            {
              seq: 2,
              action: {
                kind: 'fill',
                locator: { css_selector: 'input[name="note"]' },
                value: ['sk', 'proj', 'DistillAutoScrubbed1234567890abcdef'].join('-'),
              },
            },
          ],
        },
      },
    });
    expect(distillRes.status).toBe(200);
    const distilled = distillRes.data.manifest;
    const serialized = JSON.stringify(distilled);
    expect(serialized).not.toContain('BasicPass99');
    expect(serialized).not.toContain('MySecretApiKey12345');
    expect(serialized).not.toContain('HashTok987654321');
    expect(serialized).not.toContain('DistillAutoScrubbed');
    expect(distilled.author_id).toBe(String(alice.userId));
    expect(distilled.parameters.every((p: any) => p.is_secret === true && p.default_value === null)).toBe(true);

    // Distilled manifest can be published cleanly without author_id mismatch or 422!
    const pubDistilled = await apiJson(baseUrl, 'POST', '/api/v1/automation-apps', {
      token: alice.token,
      body: { manifest: distilled },
    });
    expect(pubDistilled.status).toBe(201);
  });
});
