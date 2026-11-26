import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CODING_PROVIDER_KINDS,
  CODING_SLASH_COMMANDS,
  DEFAULT_ARGON2_KDF_PARAMS,
  DEFAULT_MCP_PROTOCOL_VERSION,
  FABUSHI_PROTOCOL_VERSION,
  GROK_AVATAR_COLOR_IDS,
  GROK_AVATAR_SHAPES,
  GROK_COLOR_PALETTE,
  MCP_OAUTH_SCOPES,
  MCP_PROTOCOL_VERSIONS,
  SCRIPT_STEP_KINDS,
  extractWebMcpPageError,
  formatDeviceSyncCode,
  grokShippedColorIndex,
  grokShippedHash,
  grokShippedShapeHash,
  isReadOnlyRemoteComputerOp,
  isSupportedMcpProtocolVersion,
  isSupportedMcpScope,
  isValidArgon2KdfParams,
  isValidAutomationAppId,
  isValidVaultCategory,
  isValidVaultItemKey,
  isValidX25519PubkeyBytes,
  parseCodingPermissionMode,
  parseCodingProviderKind,
  resolveGrokBotAvatar,
  resolveGrokPersonaColor,
  resolveGrokPersonaShape,
  scanJsonForSecretLeaks,
  validateAutomationAppId,
  type AutomationScriptApp,
  type RemoteComputerOp,
} from '@gpui-telegram/protocol';
import {
  DEFAULT_APP_VERSION,
  loadServerConfig,
  normalizeAiGatewayBaseUrl,
  resolveServerConfig,
} from '../../../apps/server/src/config.js';
import {
  shouldProxyPathname,
  shouldProxyWebSocketPathname,
} from '../../../apps/server/src/proxy.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../../..');

describe('Fabushi v1.7.0 Version & Package Alignment', () => {
  it('aligns protocol version constant and all workspace package.json manifests to 1.7.0', () => {
    expect(FABUSHI_PROTOCOL_VERSION).toBe('1.7.0');
    expect(DEFAULT_APP_VERSION).toBe('1.7.0');

    const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
    };
    const protoPkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'packages/protocol/package.json'), 'utf8'),
    ) as { version: string };
    const serverPkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'apps/server/package.json'), 'utf8'),
    ) as { version: string };
    const webPkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'apps/web/package.json'), 'utf8'),
    ) as { version: string };

    expect(rootPkg.name).toBe('fabushi-web');
    expect(rootPkg.version).toBe('1.7.0');
    expect(protoPkg.version).toBe('1.7.0');
    expect(serverPkg.version).toBe('1.7.0');
    expect(webPkg.version).toBe('1.7.0');
  });
});

describe('Grok Bot 0.18 Deterministic UTF-16 FNV-1a Avatar Hash & WebMCP Helpers', () => {
  it('matches upstream Rust grokShippedHash, color, and shape vectors verbatim (including emoji UTF-16 pairs)', () => {
    const vectors: Array<{
      seed: string;
      hash: number;
      colorIdx: number;
      color: string;
      swatch: string;
      shapeHash: number;
      shape: string;
    }> = [
      {
        seed: '',
        hash: 2166136261,
        colorIdx: 6,
        color: 'blue',
        swatch: '#1084FE',
        shapeHash: 3303396341,
        shape: 'hex',
      },
      {
        seed: 'fabushi',
        hash: 122724665,
        colorIdx: 7,
        color: 'violet',
        swatch: '#9159FE',
        shapeHash: 66951438,
        shape: 'cloud',
      },
      {
        seed: 'fabushi-ai-bot',
        hash: 2324597598,
        colorIdx: 6,
        color: 'blue',
        swatch: '#1084FE',
        shapeHash: 959516613,
        shape: 'hex',
      },
      {
        seed: 'alpha-agent',
        hash: 1513445479,
        colorIdx: 2,
        color: 'orange',
        swatch: '#FF6700',
        shapeHash: 3116162693,
        shape: 'hex',
      },
      {
        seed: 'beta-agent',
        hash: 4152506347,
        colorIdx: 4,
        color: 'green',
        swatch: '#00C972',
        shapeHash: 4150202620,
        shape: 'wedge',
      },
      {
        seed: 'coffee_helper_bot',
        hash: 632917472,
        colorIdx: 0,
        color: 'brown',
        swatch: '#936439',
        shapeHash: 2710295492,
        shape: 'wedge',
      },
      {
        seed: '🤖',
        hash: 1395338133,
        colorIdx: 3,
        color: 'yellow',
        swatch: '#FF9800',
        shapeHash: 2521942957,
        shape: 'hex',
      },
      {
        seed: 'agent-🚀',
        hash: 1696156236,
        colorIdx: 7,
        color: 'violet',
        swatch: '#9159FE',
        shapeHash: 4263883647,
        shape: 'teardrop',
      },
    ];

    expect(GROK_AVATAR_SHAPES).toHaveLength(8);
    expect(GROK_AVATAR_COLOR_IDS).toHaveLength(11);
    expect(GROK_COLOR_PALETTE).toHaveLength(11);

    for (const v of vectors) {
      expect(grokShippedHash(v.seed)).toBe(v.hash);
      expect(grokShippedColorIndex(v.seed)).toBe(v.colorIdx);
      expect(grokShippedShapeHash(v.seed)).toBe(v.shapeHash);

      const resolved = resolveGrokBotAvatar(v.seed);
      expect(resolved.color).toBe(v.color);
      expect(resolved.swatchHex).toBe(v.swatch);
      expect(resolved.shape).toBe(v.shape);
    }
  });

  it('normalizes explicit colors, #RGB shorthand, classic shape, and legacy shape aliases', () => {
    expect(resolveGrokPersonaColor('agent', '  CYAN ')).toBe('cyan');
    expect(resolveGrokPersonaColor('agent', '#abc')).toBe('#AABBCC');
    expect(resolveGrokPersonaColor('agent', ' #0f8 ')).toBe('#00FF88');
    expect(resolveGrokPersonaColor('agent', '#ec4899')).toBe('#EC4899');
    expect(resolveGrokPersonaColor('agent-x', 'not-a-color')).toBe(
      resolveGrokPersonaColor('agent-x'),
    );
    expect(resolveGrokPersonaColor('agent-x', 'not-a-color')).not.toBe('black');

    expect(resolveGrokPersonaShape('agent', ' CLASSIC ')).toBe('classic');
    expect(resolveGrokPersonaShape('agent', 'circle')).toBe('blob');
    expect(resolveGrokPersonaShape('agent', 'round')).toBe('blob');
    expect(resolveGrokPersonaShape('agent', 'rounded')).toBe('squircle');
    expect(resolveGrokPersonaShape('agent', 'square')).toBe('squircle');
    expect(resolveGrokPersonaShape('agent', 'box')).toBe('squircle');
    expect(resolveGrokPersonaShape('agent', 'hexagon')).toBe('hex');
    expect(resolveGrokPersonaShape('agent', 'shield')).toBe('wedge');
    expect(resolveGrokPersonaShape('agent', 'diamond')).toBe('wedge');
    expect(resolveGrokPersonaShape('agent', 'spark')).toBe('wedge');

    const custom = resolveGrokBotAvatar('agent', { shape: 'classic', color: '#0f8' });
    expect(custom).toEqual({
      shape: 'classic',
      color: '#00FF88',
      swatchHex: '#00FF88',
      gradLightHex: '#00FF88',
      gradDarkHex: '#00FF88',
    });

    // D9: ASCII-only lowercase parity with Rust `.to_ascii_lowercase()` (Unicode Kelvin sign U+212A must fall back to hash)
    expect(resolveGrokPersonaColor('override-seed-🚀', 'blac\u212A')).toBe(
      resolveGrokPersonaColor('override-seed-🚀'),
    );
    expect(resolveGrokPersonaColor('override-seed-🚀', 'blac\u212A')).not.toBe('black');
    expect(resolveGrokPersonaShape('override-seed-🚀', 'spar\u212A')).toBe(
      resolveGrokPersonaShape('override-seed-🚀'),
    );
    expect(resolveGrokPersonaShape('override-seed-🚀', 'spar\u212A')).not.toBe('wedge');
  });

  it('extracts WebMCP page/boot errors in strict priority order without false positives', () => {
    expect(extractWebMcpPageError(null)).toBeNull();
    expect(extractWebMcpPageError({ visible_toast: 'Saved successfully' })).toBeNull();
    expect(
      extractWebMcpPageError({
        boot_error: 'WASM init failed',
        page_errors: ['secondary'],
        visible_toast: '500 error',
      }),
    ).toEqual({ source: 'boot_error', message: 'WASM init failed' });
    expect(
      extractWebMcpPageError({
        page_errors: ['  TypeError: boom ', '', 'ReferenceError: x'],
      }),
    ).toEqual({
      source: 'page_errors',
      message: 'TypeError: boom; ReferenceError: x',
      raw_errors: ['TypeError: boom', 'ReferenceError: x'],
    });
    expect(
      extractWebMcpPageError({ visible_toast: '加载失败：404 Not Found' }),
    ).toEqual({
      source: 'visible_toast',
      message: '加载失败：404 Not Found',
    });
  });
});

describe('Split-Key V2 User Vault & X25519 Device Sync Verification', () => {
  it('computes exact upstream SHA-256 NNN-NNN device sync codes from Uint8Array and base64', () => {
    const v1 = new Uint8Array(32).fill(0x01);
    const v2 = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const v3 = new Uint8Array(32).fill(0xff);

    expect(formatDeviceSyncCode(v1)).toBe('134-141');
    expect(formatDeviceSyncCode('AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=')).toBe('134-141');

    expect(formatDeviceSyncCode(v2)).toBe('969-024');
    expect(formatDeviceSyncCode('AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=')).toBe('969-024');

    expect(formatDeviceSyncCode(v3)).toBe('756-352');
    expect(formatDeviceSyncCode('//////////////////////////////////////////8=')).toBe('756-352');
    // URL-safe base64 without padding matches standard base64
    expect(formatDeviceSyncCode('__________________________________________8')).toBe('756-352');

    expect(() => formatDeviceSyncCode('not!valid!b64')).toThrow();
    // D8: Malformed half-padded base64 and non-canonical trailing pad bits must throw
    expect(() => formatDeviceSyncCode('AA=')).toThrow();
    expect(() => formatDeviceSyncCode('AB==')).toThrow();
    expect(isValidX25519PubkeyBytes(v1)).toBe(true);
    expect(isValidX25519PubkeyBytes(new Uint8Array(32))).toBe(false);
    expect(isValidX25519PubkeyBytes(new Uint8Array(31).fill(1))).toBe(false);
  });

  it('validates vault categories, item keys, and Argon2id bounds strictly', () => {
    expect(isValidVaultCategory('password')).toBe(true);
    expect(isValidVaultCategory('browser_cookie')).toBe(true);
    expect(isValidVaultCategory('ai_oauth')).toBe(true);
    expect(isValidVaultCategory('PASSWORD')).toBe(false);
    expect(isValidVaultCategory('other')).toBe(false);

    expect(isValidVaultItemKey('cred_1')).toBe(true);
    expect(isValidVaultItemKey('site:github.com-v1')).toBe(true);
    expect(isValidVaultItemKey('a'.repeat(128))).toBe(true);

    expect(isValidVaultItemKey('')).toBe(false);
    expect(isValidVaultItemKey('a'.repeat(129))).toBe(false);
    expect(isValidVaultItemKey('../secret')).toBe(false);
    expect(isValidVaultItemKey('foo..bar')).toBe(false);
    expect(isValidVaultItemKey('a/b')).toBe(false);
    expect(isValidVaultItemKey('a\\b')).toBe(false);
    expect(isValidVaultItemKey('key with space')).toBe(false);
    expect(isValidVaultItemKey(' leading')).toBe(false);
    expect(isValidVaultItemKey('中文key')).toBe(false);

    expect(isValidArgon2KdfParams(DEFAULT_ARGON2_KDF_PARAMS)).toBe(true);
    expect(isValidArgon2KdfParams({ m_cost_kib: 512, t_cost: 3, p_cost: 1 })).toBe(false);
    expect(isValidArgon2KdfParams({ m_cost_kib: 65536, t_cost: 0, p_cost: 1 })).toBe(false);
    expect(isValidArgon2KdfParams({ m_cost_kib: 65536, t_cost: 3, p_cost: 17 })).toBe(false);
    // D8: Null/non-object runtime input must return false safely without throwing
    expect(isValidArgon2KdfParams(null as unknown as typeof DEFAULT_ARGON2_KDF_PARAMS)).toBe(false);
    expect(isValidArgon2KdfParams(undefined as unknown as typeof DEFAULT_ARGON2_KDF_PARAMS)).toBe(
      false,
    );
  });
});

describe('Automation Script App Store ID Validator & Secret Leak Scanner', () => {
  it('validates automation app IDs including case-insensitive reserved "installed"', () => {
    expect(SCRIPT_STEP_KINDS).toHaveLength(10);

    expect(validateAutomationAppId('hn-top-10')).toEqual({ valid: true, normalized: 'hn-top-10' });
    expect(validateAutomationAppId('  App_01  ')).toEqual({ valid: true, normalized: 'App_01' });
    expect(isValidAutomationAppId('a'.repeat(128))).toBe(true);

    for (const bad of [
      '',
      '   ',
      'a'.repeat(129),
      'installed',
      'INSTALLED',
      'Installed',
      'bad.id',
      'bad/id',
      '../traversal',
      'bad id',
    ]) {
      const res = validateAutomationAppId(bad);
      expect(res.valid).toBe(false);
      expect(isValidAutomationAppId(bad)).toBe(false);
    }
  });

  it('allows clean AutomationScriptApp manifests with canonical secret placeholders, vault keys, and Bearer prose nouns', () => {
    const cleanManifest: AutomationScriptApp = {
      schema_version: 1,
      app_id: 'github-login-check',
      slug: 'github-login-check',
      name: 'GitHub Login Check',
      version: '1.0.0',
      description:
        'Uses Bearer authentication, Bearer authorization, Bearer credentials, Bearer protocol, and Basic settings.',
      category: 'devtools',
      target_domains: ['github.com'],
      parameters: [
        {
          name: 'api_token',
          description: 'Runtime secret token',
          required: true,
          default_value: null,
          is_secret: true,
        },
        {
          name: 'repo_name',
          description: 'Repository slug',
          required: true,
          default_value: 'fabushi-web',
          is_secret: false,
        },
      ],
      steps: [
        { kind: 'navigate', url_template: 'https://token.example.com:8443/repos/{{repo_name}}' },
        {
          kind: 'fill',
          locator: { name_attr: 'password' },
          value_template: '{{api_token}}',
          secret_vault_key: 'cred_github:password',
        },
        { kind: 'human_checkpoint', reason: 'Authorization: Bearer {{api_token}}' },
      ],
      required_capabilities: ['browser.navigate', 'browser.fill'],
    };

    const result = scanJsonForSecretLeaks(cleanManifest);
    expect(result.safe).toBe(true);
    expect(result.findings).toEqual([]);

    const publishReqResult = scanJsonForSecretLeaks(
      {
        manifest: cleanManifest,
        is_published: true,
        changelog: 'Improved Bearer implementation and Bearer documentation for Basic usage.',
      },
      { context: 'request' },
    );
    expect(publishReqResult.safe).toBe(true);

    // Verify all 18 upstream Bearer prose nouns are allowed
    const proseNouns = [
      'authenticating',
      'authentication',
      'authorization',
      'credential',
      'credentials',
      'certification',
      'implementation',
      'configuration',
      'documentation',
      'verification',
      'specification',
      'integration',
      'management',
      'middleware',
      'protocol',
      'mechanism',
      'framework',
      'architecture',
    ];
    for (const noun of proseNouns) {
      expect(scanJsonForSecretLeaks({ note: `Requires Bearer ${noun}.` }).safe).toBe(true);
    }
  });

  it('detects API keys, JWTs, PEM blocks, Bearer/Basic credentials, nested/encoded secrets, and depth > 16', () => {
    const leakyPayloads: Array<{ label: string; payload: unknown }> = [
      { label: 'Anthropic key', payload: { desc: 'key sk-ant-api03-1234567890abcdef' } },
      { label: 'OpenAI project key', payload: { desc: 'sk-proj-1234567890abcdefghij' } },
      { label: 'Generic sk key', payload: { desc: 'sk-1234567890abcdef1234' } },
      { label: 'GitHub PAT', payload: { desc: 'ghp_1234567890abcdefghij123456' } },
      { label: 'AWS key', payload: { desc: 'AKIAIOSFODNN7EXAMPLE' } },
      {
        label: 'Google AIza key',
        payload: { desc: 'AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGqeTA' },
      },
      {
        label: 'JWT',
        payload: {
          desc: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
        },
      },
      {
        label: 'PEM private key',
        payload: { desc: '-----BEGIN RSA PRIVATE KEY-----\nMIIE...' },
      },
      { label: 'Bearer token', payload: { header: 'Bearer live_token_12345' } },
      {
        label: 'Second Bearer after prose noun on same line',
        payload: { header: 'Uses Bearer authentication with Bearer live_token_12345' },
      },
      { label: 'Basic auth user:pass', payload: { header: 'Basic dXNlcjpwYXNz' } },
      { label: 'Sensitive JSON key', payload: { password: 'hunter2' } },
      {
        label: 'Nested JSON string',
        payload: { notes: '{"api_key":"secret123"}' },
      },
      {
        label: 'Percent-encoded KV',
        payload: { url: 'https://example.com/cb?auth_token%3Dabc12345' },
      },
      {
        label: 'JSON-escaped secret',
        payload: { raw: '{\\"password\\":\\"hunter2\\"}' },
      },
      {
        label: 'Invalid secret_vault_key with =',
        payload: { steps: [{ kind: 'fill', secret_vault_key: 'foo=bar' }] },
      },
      {
        label: 'Secret param with default_value',
        payload: {
          parameters: [{ name: 'api_token', is_secret: true, default_value: 'hardcoded' }],
        },
      },
      {
        label: 'Changelog leak',
        payload: { manifest: { name: 'Clean' }, changelog: 'token ghp_1234567890abcdefghij123456' },
      },
    ];

    for (const { label, payload } of leakyPayloads) {
      const res = scanJsonForSecretLeaks(payload);
      expect(res.safe, `Expected secret leak detection for: ${label}`).toBe(false);
      expect(res.findings.length).toBeGreaterThan(0);
    }

    // Excessive JSON depth (> 16)
    let deep: Record<string, unknown> = { leaf: 'ok' };
    for (let i = 0; i < 18; i++) {
      deep = { child: deep };
    }
    const deepRes = scanJsonForSecretLeaks(deep);
    expect(deepRes.safe).toBe(false);
    expect(deepRes.findings.some((f) => f.reason.includes('nesting depth'))).toBe(true);
  });

  it('catches duplicate JSON keys, placeholder-suffix/trailing secrets, + form encoding, 4-pass BFS, Slack tokens, sentence punctuation, long/bearer/basic KV keys, and embedded JSON fallback (D1, D3-D7)', () => {
    const pct = (s: string) =>
      [...s].map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
    const uni = (s: string) =>
      [...s].map((c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('');

    const secretParams = {
      parameters: [
        { name: 'api_token', is_secret: true, default_value: null },
        { name: 'pw', is_secret: true, default_value: null },
      ],
    };

    const adversarialCases: Array<{ label: string; payload: unknown }> = [
      // D1: Duplicate JSON keys (top-level string, nested string, embedded string, deeply nested)
      {
        label: 'D1 top-level duplicate key GitHub PAT',
        payload: '{"note": "ghp_123456789012345678901234567890123456", "note": "clean"}',
      },
      {
        label: 'D1 nested duplicate key Anthropic',
        payload: { desc: '{"note":"sk-ant-api03-1234567890abcdef1234","note":"clean"}' },
      },
      {
        label: 'D1 nested duplicate key empty shadow',
        payload: { meta: '{"token": "ghp_123456789012345678901234567890123456", "token": ""}' },
      },
      {
        label: 'D1 nested duplicate key password shadowed by placeholder',
        payload: {
          ...secretParams,
          meta: '{"password": "hunter2_plaintext", "password": "{{pw}}"}',
        },
      },
      {
        label: 'D1 nested duplicate key JWT',
        payload: {
          desc: '{"x":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c","x":"ok"}',
        },
      },
      {
        label: 'D1 deeply nested duplicate key AWS',
        payload: {
          meta: '{"a":{"b":{"note":"AKIAIOSFODNN7EXAMPLE","note":"clean"}}}',
        },
      },
      {
        label: 'D1 embedded JSON with duplicate key',
        payload: {
          meta: 'prefix {"note":"sk-ant-api03-1234567890abcdef1234","note":"clean"} suffix',
        },
      },
      // D3: Placeholder-prefix bypass, same-line trailing secrets, quoted/assigned Bearer
      {
        label: 'D3 KV placeholder-suffix leak',
        payload: { ...secretParams, desc: 'password={{api_token}}real_secret_123' },
      },
      {
        label: 'D3 Bearer placeholder-suffix leak',
        payload: { ...secretParams, desc: 'Bearer {{api_token}}real_secret_123' },
      },
      {
        label: 'D3 Quoted Bearer placeholder-suffix leak',
        payload: { ...secretParams, desc: 'Bearer "{{api_token}}real_secret_123"' },
      },
      {
        label: 'D3 Basic placeholder-suffix leak',
        payload: { ...secretParams, desc: 'Basic {{api_token}}dXNlcjpwYXNz' },
      },
      {
        label: 'D3 Bearer same-line trailing secret',
        payload: {
          ...secretParams,
          header: 'Bearer {{api_token}} leaked_real_secret_token_999',
        },
      },
      {
        label: 'D3 Basic same-line trailing secret',
        payload: { header: 'Basic ok YWRtaW46c3VwZXJzZWNyZXQ=' },
      },
      {
        label: 'D3 Quoted lowercase Bearer secret',
        payload: { header: 'Bearer "mysecret"' },
      },
      {
        label: 'D3 Assigned short Bearer secret with digit',
        payload: { header: 'Bearer: a1b2' },
      },
      {
        label: 'D3 Assigned = short Bearer secret with digit',
        payload: { header: 'Bearer=a1b2' },
      },
      // D4: Form-urlencoded '+' -> space and full BFS frontier decode passes
      {
        label: 'D4 Bearer+ form-urlencoded leak',
        payload: { url: 'https://example.com/?h=Bearer+live_secret_token_999' },
      },
      {
        label: 'D4 Basic+ form-urlencoded leak',
        payload: { url: 'https://example.com/?h=Basic+dXNlcjpwYXNz' },
      },
      {
        label: 'D4 4-pass mixed escape + percent BFS leak',
        payload: {
          raw:
            'prefix \\"hi\\" ' +
            pct(pct(pct(uni('ghp_123456789012345678901234567890123456')))),
        },
      },
      {
        label: 'D4 multi-pass percent-encoded KV alongside backslash escape',
        payload: {
          desc: '\\n%2525252570%2525252561%2525252573%2525252573%2525252577%252525256f%2525252572%2525252564%252525253dhunter2',
        },
      },
      // D5: Slack tokens and sentence-ending punctuation
      {
        label: 'D5 Slack xoxb token',
        payload: {
          desc: `Notify via ${['xoxb', '123456789012', '1234567890123', 'abcdefghijklmnopqrstuvwx'].join('-')}`,
        },
      },
      {
        label: 'D5 Slack xoxp token',
        payload: {
          desc: `Notify via ${['xoxp', '123456789012', '123456789012', '123456789012', 'abcdef1234567890abcdef1234567890'].join('-')}`,
        },
      },
      {
        label: 'D5 OpenAI key ending with period',
        payload: { desc: 'My key is sk-live-1234567890abcdef12345678.' },
      },
      {
        label: 'D5 AWS key ending with period',
        payload: { desc: 'My AWS key is AKIAIOSFODNN7EXAMPLE.' },
      },
      {
        label: 'D5 JWT ending with period',
        payload: {
          desc: 'My JWT is eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U.',
        },
      },
      // D6: Long dot-prefix KV keys and inline bearer/basic keys
      {
        label: 'D6 long dot-prefix password KV (>64 chars)',
        payload: { desc: `${'a'.repeat(60)}.password=real_secret_123` },
      },
      {
        label: 'D6 inline my_bearer KV',
        payload: { desc: 'my_bearer=live_secret_123456' },
      },
      {
        label: 'D6 inline http_basic KV',
        payload: { desc: 'http_basic=dXNlcjpwYXNz' },
      },
      // D7: Embedded JSON when full string starts with '{' and ends with '}' but is not valid JSON
      {
        label: 'D7 non-JSON outer braces containing embedded JSON secret',
        payload: { meta: '{notjson} {"bearer": "mysecretvalue999"}' },
      },
    ];

    for (const { label, payload } of adversarialCases) {
      const res = scanJsonForSecretLeaks(payload);
      expect(res.safe, `Expected secret leak detection for: ${label}`).toBe(false);
      expect(res.findings.length).toBeGreaterThan(0);
    }

    // D3 prose false-positive parity check: plain unquoted Bearer prose <12 chars stays safe
    expect(
      scanJsonForSecretLeaks({ desc: 'Uses Bearer token-based workflow via vault.' }).safe,
    ).toBe(true);
    expect(
      scanJsonForSecretLeaks({ desc: 'the bearer token is managed by vault' }).safe,
    ).toBe(true);
    expect(scanJsonForSecretLeaks({ desc: 'bearer of good news' }).safe).toBe(true);
    // Clean deeply nested valid JSON string (> 16) still fails closed without stack overflow
    expect(
      scanJsonForSecretLeaks({ raw: '['.repeat(30_000) + ']'.repeat(30_000) }).safe,
    ).toBe(false);
  });

  it('maintains linear O(N) latency on pathological brackets, colons, and large clean URL payloads (D2)', () => {
    const t0 = performance.now();
    const unclosedBrackets = scanJsonForSecretLeaks({ note: '['.repeat(50_000) });
    const bracketsMs = performance.now() - t0;
    expect(unclosedBrackets.safe).toBe(true);
    expect(bracketsMs).toBeLessThan(500);

    const t1 = performance.now();
    const manyColons = scanJsonForSecretLeaks({ desc: 'a:b '.repeat(25_000) });
    const colonsMs = performance.now() - t1;
    expect(manyColons.safe).toBe(true);
    expect(colonsMs).toBeLessThan(500);

    const t2 = performance.now();
    const largeUrls = scanJsonForSecretLeaks({
      desc: 'Save 50% on clean items at https://example.com/sale?q=hello_world '.repeat(4000),
    });
    const urlsMs = performance.now() - t2;
    expect(largeUrls.safe).toBe(true);
    expect(urlsMs).toBeLessThan(500);
  });

  it('catches CLI-flag, dot/digit-prefixed, bracketed-subscript KV keys, cross-mode memo leaks, stray-quote embedded JSON, and oversized bracket secrets (I2-A..I2-E)', () => {
    const secretParams = {
      parameters: [
        { name: 'api_token', is_secret: true, default_value: null },
        { name: 'auth_token', is_secret: true, default_value: null },
        { name: 'pw', is_secret: true, default_value: null },
        { name: 'tok', is_secret: true, default_value: null },
        { name: 'creds', is_secret: true, default_value: null },
        { name: 'repo_name', is_secret: false, default_value: 'fabushi-web' },
      ],
    };

    const deepArr20 = '['.repeat(20) + ']'.repeat(20);
    const deepObj20 = '{"a":'.repeat(20) + '1' + '}'.repeat(20);

    const leakyVectors: Array<{ label: string; payload: unknown }> = [
      // I2-A: CLI flags, dot-prefixed, digit-prefixed KV keys
      { label: 'I2-A CLI --password=', payload: { cmd: 'curl --password=hunter2 https://api.example.com' } },
      { label: 'I2-A CLI --api-key=', payload: { cmd: '--api-key=real_secret_123' } },
      { label: 'I2-A CLI -token=', payload: { cmd: '-token=real_secret_123' } },
      { label: 'I2-A CLI --password:', payload: { cmd: '--password: hunter2' } },
      { label: 'I2-A dot .password=', payload: { cmd: '.password=hunter2' } },
      { label: 'I2-A double-dot ..password=', payload: { cmd: '..password=hunter2' } },
      { label: 'I2-A digit-dot 1.password=', payload: { cmd: '1.password=hunter2' } },
      { label: 'I2-A digit 2fa_secret=', payload: { cmd: '2fa_secret=JBSWY3DPEHPK3PXP' } },
      { label: 'I2-A digit 1password=', payload: { cmd: '1password=hunter2' } },
      { label: 'I2-A digit 0_api_key=', payload: { cmd: '0_api_key=real_secret_123' } },
      { label: 'I2-A URL query 2fa_secret=', payload: { url: 'https://example.com/api?2fa_secret=JBSWY3DPEHPK3PXP' } },
      { label: 'I2-A userinfo @ after port', payload: { url: 'https://token.example.com:8443@evil.com' } },

      // I2-B: Stray-quote embedded JSON objects, duplicate keys, deep arrays/objects
      { label: 'I2-B prose bracket quote + JSON', payload: { note: 'Use [size 5"] with {"api key": "mysecret123"}' } },
      { label: 'I2-B stray [ " + JSON', payload: { note: '[ " {"api key": "mysecret123"}' } },
      { label: 'I2-B stray [ " + deep20 array', payload: { note: `[ " ${deepArr20}` } },
      { label: 'I2-B stray [" + dup-key JSON', payload: { note: '[" {"1_password":"hunter2","1_password":""}' } },
      { label: 'I2-B stray [" + numeric sensitive JSON', payload: { note: '[" {"0_token": 999999}' } },
      { label: 'I2-B stray [" + array dup-key JSON', payload: { note: '[" [{"0_secret":"leaked","0_secret":""}]' } },
      { label: 'I2-B broken outer { + inner JSON', payload: { note: '{"bad {"api key": "mysecret123"}' } },
      { label: 'I2-B broken outer { + deep20 obj', payload: { note: `{"x":"bad ${deepObj20}` } },
      { label: 'I2-B broken outer { + trailing prose', payload: { note: '{"bad {"api key": "mysecret123"} trailing prose' } },
      { label: 'I2-B nested broken quote JSON', payload: { note: '{"x":"bad {"api key": "mysecret123"}"}' } },
      { label: 'I2-B array failPoint isolation', payload: { note: '[1, "bad {"api key": "mysecret123"}"]' } },
      { label: 'I2-B double-brace wrapped JSON', payload: { note: '{{"password":"leaked"}}' } },
      { label: 'I2-B newline string flush + JSON', payload: { note: '{"bad\n{"api key": "mysecret123"}' } },

      // I2-C: Cross-mode memo isolation (Basic -> Sensitive/Bearer, Bearer -> Sensitive/Basic, URL variants)
      { label: 'I2-C xBasic then password then plain', payload: { ...secretParams, line: 'xBasic={{api_token}} password={{api_token}} supersecretplain' } },
      { label: 'I2-C http_basic then password then bearer', payload: { ...secretParams, line: 'http_basic={{creds}} password={{pw}} mylongbearersecrettoken' } },
      { label: 'I2-C myBearer then password then basic b64', payload: { ...secretParams, line: 'myBearer={{api_token}} password={{api_token}} YTphYmNk' } },
      { label: 'I2-C my_bearer then password then basic padded', payload: { ...secretParams, line: 'my_bearer={{tok}} password={{pw}} YTphYWE=' } },
      { label: 'I2-C myBearer then xBasic then basic b64', payload: { ...secretParams, line: 'myBearer={{api_token}} xBasic={{api_token}} YTphYmNk' } },
      { label: 'I2-C URL xBasic then password then plain', payload: { ...secretParams, url: 'https://example.com/?xBasic={{creds}}&password={{pw}}&mode=prod supersecretplain' } },
      { label: 'I2-C URL my_bearer then password then basic', payload: { ...secretParams, url: 'https://example.com/?my_bearer={{tok}}&password={{pw}}&mode=prod YTphYmNk' } },

      // I2-D: Bracketed subscript KV keys
      { label: 'I2-D auth_token[0]=', payload: { line: 'auth_token[0]=hunter2' } },
      { label: 'I2-D password[prod]=', payload: { line: 'password[prod]=hunter2' } },
      { label: 'I2-D headers[x-api-key]=', payload: { line: 'headers[x-api-key]=real_secret_123' } },
      { label: 'I2-D config["password"]=', payload: { line: 'config["password"]=hunter2' } },
      { label: 'I2-D auth_token[0].prod=', payload: { line: 'auth_token[0].prod=hunter2' } },
      { label: 'I2-D URL auth_token[0]=', payload: { url: 'https://example.com/api?auth_token[0]=hunter2' } },
      { label: 'I2-D auth_token[0][1]=', payload: { line: 'auth_token[0][1]=hunter2' } },
      { label: 'I2-D auth_token["]"]=', payload: { line: 'auth_token["]"]=hunter2' } },
      { label: 'I2-D "auth_token"[0]=', payload: { line: '"auth_token"[0]=hunter2' } },
      { label: 'I2-D [auth_token]=', payload: { line: '[auth_token]=hunter2' } },
      { label: 'I2-D stray quote + auth_token["]"]=', payload: { line: '\' auth_token["]"]=hunter2' } },
      { label: 'I2-D contraction + auth_token[0]=', payload: { line: "it's auth_token[0]=hunter2" } },

      // I2-E: Oversized bracket secrets & auth header trailing leaks
      { label: 'I2-E oversized Bearer bracket secret', payload: { header: `Bearer ( ${' '.repeat(5000)}mysecret )` } },
      { label: 'I2-E oversized Bearer bracket 4-char digit', payload: { header: `Bearer ( ${' '.repeat(5000)}a1b2 )` } },
      { label: 'I2-E oversized Basic bracket secret', payload: { header: `Basic ( ${' '.repeat(5000)}dXNlcjpwYXNz )` } },
      { label: 'I2-E oversized Bearer kv rhs bracket secret', payload: { header: `Bearer token: ( ${' '.repeat(5000)}mysecret )` } },
      { label: 'I2-E Auth header trailing leak', payload: { ...secretParams, header: 'Authorization: Bearer {{api_token}} leaked_secret' } },
      { label: 'I2-E quoted authorization= trailing leak', payload: { ...secretParams, header: 'authorization="Bearer {{api_token}}" leaked_secret' } },
    ];

    for (const { label, payload } of leakyVectors) {
      const res = scanJsonForSecretLeaks(payload);
      expect(res.safe, `Expected secret leak detection for: ${label}`).toBe(false);
      expect(res.findings.length).toBeGreaterThan(0);
    }

    const cleanVectors: Array<{ label: string; payload: unknown }> = [
      // I2-A benign guards
      { label: 'I2-A benign host:port', payload: { url: 'https://host:8080/path' } },
      { label: 'I2-A benign sensitive-label host:port', payload: { ...secretParams, url: 'https://token.example.com:8443/repos/{{repo_name}}' } },
      { label: 'I2-A benign foo:8080', payload: { note: 'foo:8080' } },
      { label: 'I2-A benign CLI --verbose=true', payload: { cmd: '--verbose=true --timeout=30 -n=5' } },
      { label: 'I2-A benign .env=prod and 1.name=alice', payload: { note: '.env=prod 1.name=alice .=x' } },
      // I2-B benign guards
      { label: 'I2-B benign stray bracket quote + placeholder', payload: { ...secretParams, note: 'Use [size 5"] and [note "ok"] safely with {{api_token}}' } },
      { label: 'I2-B benign embedded containers', payload: { note: 'prefix [1, 2, 3] and {"name": "demo"} suffix' } },
      { label: 'I2-B exact top-level JSON string depth 16 stays safe', payload: '['.repeat(16) + ']'.repeat(16) },
      { label: 'I2-B exact wrapped object + 15-deep JSON string (total depth 16) stays safe', payload: { raw: '['.repeat(15) + ']'.repeat(15) } },
      // I2-D benign guards
      { label: 'I2-D benign items[0]=hello', payload: { note: 'items[0]=hello data[user][name]=alice' } },
      { label: 'I2-D benign URL subscript + protected token', payload: { ...secretParams, url: 'https://example.com/api?items[0]=hello&token={{api_token}}&mode=production' } },
      { label: 'I2-D benign URL auth_token[0]={{api_token}}', payload: { ...secretParams, url: 'https://example.com/api?auth_token[0]={{api_token}}&mode=production' } },
      { label: 'I2-D benign prose dot after subscript', payload: { ...secretParams, note: 'Use auth_token[0]. Note: {{auth_token}}' } },
      { label: 'I2-D benign prose dot after key', payload: { note: 'Use auth_token. Note: ok' } },
      { label: 'I2-D benign Authorization[0] header', payload: { ...secretParams, header: 'Authorization[0]: Bearer {{api_token}}' } },
      // I2-E clean multi-secret URL & oversized placeholder bracket
      { label: 'I2-E clean multi-secret URL', payload: { ...secretParams, url: 'https://example.com/login?password={{pw}}&token={{api_token}}&mode=production' } },
      { label: 'I2-E oversized Bearer bracket with placeholder', payload: { ...secretParams, header: `Bearer ( ${' '.repeat(5000)}{{api_token}} )` } },
    ];

    for (const { label, payload } of cleanVectors) {
      const res = scanJsonForSecretLeaks(payload);
      expect(res.safe, `Expected safe=true for: ${label}, got: ${JSON.stringify(res.findings)}`).toBe(true);
    }

    // Exact depth boundary: depth 17 fails closed (both top-level 17-deep and wrapped 16-deep)
    expect(scanJsonForSecretLeaks('['.repeat(17) + ']'.repeat(17)).safe).toBe(false);
    expect(scanJsonForSecretLeaks({ raw: '['.repeat(16) + ']'.repeat(16) }).safe).toBe(false);
  });

  it('enforces linear O(N) latency (< 500ms) across all Iteration 2/3 adversarial DoS payloads (I2-B, I2-D, I2-E)', () => {
    const pwParams = [{ name: 'pw', is_secret: true, default_value: null }];
    const authTokenParams = [{ name: 'auth_token', is_secret: true, default_value: null }];

    const cases: Array<{ label: string; payload: unknown; expectedSafe: boolean }> = [
      {
        label: 'I2-E Basic ( + 240k spaces',
        payload: { note: `\n%25252520${'Basic ( '.repeat(160)}${' '.repeat(240_000)}` },
        expectedSafe: true,
      },
      {
        label: 'I2-E nested Basic < 10k',
        payload: { note: 'Basic < '.repeat(10_000) + '>'.repeat(10_000) },
        expectedSafe: true,
      },
      {
        label: 'I2-E 10k URL token=x&',
        payload: { url: `https://example.com/?${'token=x&'.repeat(10_000)}` },
        expectedSafe: false,
      },
      {
        label: 'I2-E 5k URL password={{pw}}&',
        payload: { parameters: pwParams, url: `https://example.com/?${'password={{pw}}&'.repeat(5_000)}` },
        expectedSafe: true,
      },
      {
        label: 'I2-E URL unclosed {{ 20k',
        payload: { parameters: pwParams, url: `https://example.com/?password={{pw}}&${'{{'.repeat(20_000)}` },
        expectedSafe: false,
      },
      {
        label: 'I2-E 10k authorization=x',
        payload: { line: 'authorization=x '.repeat(10_000) },
        expectedSafe: false,
      },
      {
        label: 'I2-D 50k unmatched ] + =',
        payload: { line: `${']'.repeat(50_000)}=` },
        expectedSafe: true,
      },
      {
        label: 'I2-D 20k ] + 2k [a=1]',
        payload: { line: `${']'.repeat(20_000)}${'[a=1]'.repeat(2_000)}` },
        expectedSafe: true,
      },
      {
        label: 'I2-D 5k nested auth_token[',
        payload: {
          parameters: authTokenParams,
          line: `${',auth_token['.repeat(5_000)}${']= {{auth_token}}, '.repeat(5_000)}`,
        },
        expectedSafe: true,
      },
      {
        label: 'I2-B 20k stray ["',
        payload: { note: '[" '.repeat(20_000) },
        expectedSafe: true,
      },
      {
        label: 'I2-B 300KB failing objects + trailing secret',
        payload: { note: `${'{ "bad": x} '.repeat(25_000)}{"password":"leaked"}` },
        expectedSafe: false,
      },
      {
        label: 'I2-B 20k deep broken prefix + trailing secret',
        payload: { note: `{"bad ${'{"a":'.repeat(20_000)}{"password":"leaked"}` },
        expectedSafe: false,
      },
      {
        label: 'I2-B stray quote + 30k deep valid array',
        payload: { note: `[ " ${'['.repeat(30_000)}${']'.repeat(30_000)}` },
        expectedSafe: false,
      },
      {
        label: 'Step 5 512KiB 64-variant BFS clean',
        payload: { note: `%252525252525+\\\\\\\\\\\\\\n ${'a '.repeat(250_000)}` },
        expectedSafe: true,
      },
    ];

    for (const { label, payload, expectedSafe } of cases) {
      const t = performance.now();
      const res = scanJsonForSecretLeaks(payload);
      const elapsedMs = performance.now() - t;
      expect(res.safe, `Unexpected safe result for ${label}`).toBe(expectedSafe);
      expect(elapsedMs, `DoS latency exceeded 500ms for ${label}: ${elapsedMs.toFixed(1)}ms`).toBeLessThan(500);
    }
  });

  it('catches contraction/stray-quote subscript leaks (I3-A), escaped long-key leaks (I3-B), deferred Basic controls & multi-field reporting (I3-C), and preserves surrogate-pair placeholders (I3-D)', () => {
    const leakyVectors: Array<{ label: string; payload: unknown }> = [
      // I3-A: All 5 Reviewer 2 contraction & stray-quote subscript bypasses + backward-quote parity
      { label: 'I3-A contraction + single-quoted ] in subscript', payload: { line: "Don't use auth_token['a]b', 0]=hunter2" } },
      { label: 'I3-A stray " + double-quoted ] in subscript', payload: { line: '" auth_token["a]b", 0]=hunter2' } },
      { label: 'I3-A stray " + headers["x-api-key]"]', payload: { line: '" headers["x-api-key]", 0]=real_secret_123' } },
      { label: 'I3-A contraction + config[\'password]\']', payload: { line: "Don't leak config['password]', 0]=hunter2" } },
      { label: 'I3-A contraction + root bracket + quoted ]', payload: { line: "Don't use [auth_token]['a]b', 0]=hunter2" } },
      { label: 'I3-A escaped quote inside subscript', payload: { line: "Don't use auth_token['a\\'b]c', 0]=hunter2" } },
      { label: 'I3-A mixed quotes inside subscript', payload: { line: 'Don\'t use auth_token["a\'b]c", 0]=hunter2' } },
      { label: 'I3-A endedInQuote propagation into noQuote fallback', payload: { line: '"] = " auth_token["]=hunter2' } },
      { label: 'I3-A multi-line reset after contraction', payload: { line: "Don't\nauth_token['a]b', 0]=hunter2" } },

      // I3-B: Escaped long & short KV keys (including \n line-break keys caught via UnescapedLineSegIndex)
      { label: 'I3-B long key _\\u0070assword', payload: { line: `${'a'.repeat(130)}_\\u0070assword=hunter2` } },
      { label: 'I3-B long key .\\u0070assword', payload: { line: `${'a'.repeat(130)}.\\u0070assword=hunter2` } },
      { label: 'I3-B long key camelCase \\u0050assword', payload: { line: `${'a'.repeat(130)}\\u0050assword=hunter2` } },
      { label: 'I3-B long key \\u005fpassword', payload: { line: `${'a'.repeat(130)}\\u005fpassword=hunter2` } },
      { label: 'I3-B quoted long key with \\u0070assword\\n', payload: { line: `"${'a'.repeat(130)}_\\u0070assword\\n"=hunter2` } },
      { label: 'I3-B subscript long key with \\u0070assword\\n', payload: { line: `cfg["${'a'.repeat(130)}_\\u0070assword\\n"]=hunter2` } },
      { label: 'I3-B short key escaped bearer + \\n', payload: { line: 'cfg["my_\\u0062earer_x\\n"]=a1b2' } },
      { label: 'I3-B long key escaped bearer + \\n', payload: { line: `cfg["${'a'.repeat(130)}_\\u0062earer_x\\n"]=a1b2` } },
      { label: 'I3-B short key escaped basic + \\n', payload: { line: 'cfg["my_\\u0062asic_x\\n"]=dXNlcjpwYXNz' } },
      { label: 'I3-B long key escaped basic + \\n', payload: { line: `cfg["${'a'.repeat(130)}_\\u0062asic_x\\n"]=dXNlcjpwYXNz` } },
      { label: 'I3-B straddling \\r + \\u005f long key', payload: { line: `foo\\refresh\\u005ftoken_${'a'.repeat(130)}=hunter2` } },

      // I3-C: Deferred Basic span & pure-letter base64 security controls
      { label: 'I3-C quoted Basic credential', payload: { header: 'Basic"YWRtaW46cGFzcw=="' } },
      { label: 'I3-C broken-quote long Basic span', payload: { header: `Basic"YWRtaW46cGFzcw=="trailing${':ok'.repeat(100)}` } },
      { label: 'I3-C pure-letter base64 Basic in long span', payload: { header: `Basic:YWJjOmRlZg${':ok'.repeat(100)}` } },
      { label: 'I3-C pure-letter base64 Basic with trailing = stripped', payload: { header: `Basic:${'ok:'.repeat(100)}YWJjOmRlZg=` } },
      { label: 'I3-C Basic= splitsRun credential', payload: { header: `Basic=YWRtaW46cGFzcw==${':ok'.repeat(100)}` } },
      { label: 'I3-C long Basic KV ending with credential', payload: { line: `${';xBasic:a;'.repeat(50)}YWRtaW46cGFzcw==` } },
      { label: 'I3-C enclosing-quoted long Basic span with credential', payload: { header: `"Basic:${'ok:'.repeat(100)}YWRtaW46cGFzcw=="` } },

      // I3-D: Multi-byte UTF-8 / non-BMP emoji adjacent to percent-encoded secrets
      { label: 'I3-D multi-byte UTF-8 %F0%9F%9A%80 before secret', payload: { text: '%F0%9F%9A%80%20password=hunter2' } },
      { label: 'I3-D emoji before firstValidPct', payload: { text: '😀%70assword%3Dhunter2' } },
      { label: 'I3-D secret decoded with invalid %a🚀 suffix', payload: { text: 'hello%20world%20password=hunter2%a🚀' } },
    ];

    for (const { label, payload } of leakyVectors) {
      const res = scanJsonForSecretLeaks(payload);
      expect(res.safe, `Expected secret leak detection for: ${label}`).toBe(false);
      expect(res.findings.length).toBeGreaterThan(0);
    }

    const cleanVectors: Array<{ label: string; payload: unknown }> = [
      // I3-A benign parity
      { label: 'I3-A contraction + benign subscript', payload: { line: "Don't use items['a]b', 0]=hello" } },
      { label: 'I3-A no false noQuote fallback when not endedInQuote', payload: { line: 'prefix "a[b" c]=1' } },
      // I3-B benign parity
      { label: 'I3-B unseparated aaa...\\u0070assword parity', payload: { line: `${'a'.repeat(130)}\\u0070assword=hunter2` } },
      {
        label: 'I3-B straddling \\n prefix with protected placeholder',
        payload: {
          parameters: [{ name: 'api_token', is_secret: true, default_value: null }],
          text: `prefix\\ntoken_${'a'.repeat(130)}=\\"{{api_token}}\\"`,
        },
      },
      {
        label: 'I3-B straddling \\n + interior \\u0041 with protected placeholder',
        payload: {
          parameters: [{ name: 'api_token', is_secret: true, default_value: null }],
          text: `prefix\\ntoken_\\u0041${'a'.repeat(130)}=\\"{{api_token}}\\"`,
        },
      },
      // I3-C benign parity
      { label: 'I3-C non-cred Basic with trailing = stripped', payload: { header: `Basic:${'a'.repeat(500)}=` } },
      { label: 'I3-C enclosing-quoted long clean Basic span', payload: { header: `"Basic:${'ok:'.repeat(100)}ok"` } },
      {
        label: 'I3-C quoted authorization[0] with Bearer placeholder',
        payload: {
          parameters: [{ name: 'tok', is_secret: true, default_value: null }],
          h: '"authorization[0]"="Bearer {{tok}}"',
        },
      },
      // I3-D surrogate-pair & multi-byte UTF-8 placeholders preserved losslessly
      {
        label: 'I3-D hello%20world password={{key_%a🚀}}',
        payload: {
          parameters: [{ name: 'key_%a🚀', is_secret: true, default_value: null }],
          text: 'hello%20world password={{key_%a🚀}}',
        },
      },
      {
        label: 'I3-D %41%X😀 password={{key_%X😀}}',
        payload: {
          parameters: [{ name: 'key_%X😀', is_secret: true, default_value: null }],
          text: '%41%X😀 password={{key_%X😀}}',
        },
      },
      {
        label: 'I3-D 😀%20password={{🚀key}}',
        payload: {
          parameters: [{ name: '🚀key', is_secret: true, default_value: null }],
          text: '😀%20password={{🚀key}}',
        },
      },
      {
        label: 'I3-D %F0%9F%9A%80%X password={{k🚀}}',
        payload: {
          parameters: [{ name: 'k🚀', is_secret: true, default_value: null }],
          text: '%F0%9F%9A%80%X password={{k🚀}}',
        },
      },
      {
        label: 'I3-D truncated UTF-8 %F0%9F%9A🚀 password={{k🚀}}',
        payload: {
          parameters: [{ name: 'k🚀', is_secret: true, default_value: null }],
          text: '%F0%9F%9A🚀 password={{k🚀}}',
        },
      },
    ];

    for (const { label, payload } of cleanVectors) {
      const res = scanJsonForSecretLeaks(payload);
      expect(res.safe, `Expected safe=true for: ${label}, got: ${JSON.stringify(res.findings)}`).toBe(true);
    }

    // Fail-fast per-path preserves multi-field diagnostic reporting across distinct object properties
    const multiField = scanJsonForSecretLeaks({
      fieldA: 'password=1; password=2; password=3',
      fieldB: 'Bearer secret_token_123 Bearer another_token_456',
    });
    expect(multiField.safe).toBe(false);
    expect(multiField.findings).toHaveLength(2);
  });

  it('enforces O(N log N) latency (< 500ms) across ALL Iteration 3/4 DoS and ReDoS vectors (I3-A, I3-B, I3C-1..I3C-9)', () => {
    const authTokenParams = [{ name: 'auth_token', is_secret: true, default_value: null }];
    const pwParams = [{ name: 'pw', is_secret: true, default_value: null }];
    const tokParams = [{ name: 'tok', is_secret: true, default_value: null }];
    const manyParams = Array.from({ length: 2_000 }, (_, i) => ({
      name: `p${i}`,
      is_secret: true,
      default_value: null,
    }));

    const cases: Array<{ label: string; payload: unknown; expectedSafe: boolean }> = [
      // I3-A backward findOpenBracket DoS vectors
      { label: 'I3-A 10k [ + 20k ] + = (embedded JSON depth > 16)', payload: { line: `${'['.repeat(10_000)}${']'.repeat(20_000)}=` }, expectedSafe: false },
      { label: 'I3-A 10k x[ + 20k ] + = (pure Step 2 safe: true)', payload: { line: `${'x['.repeat(10_000)}${']'.repeat(20_000)}=` }, expectedSafe: true },
      { label: 'I3-A 20k [" + 20k ] + =', payload: { line: `${'["'.repeat(20_000)}${']'.repeat(20_000)}=` }, expectedSafe: true },
      { label: 'I3-A 50k " + ]=', payload: { line: `${'"'.repeat(50_000)}]=` }, expectedSafe: true },
      { label: 'I3-A 5k a[ + 5k ]=', payload: { line: `${'a['.repeat(5_000)}${']='.repeat(5_000)}` }, expectedSafe: true },
      { label: 'I3-A stray " + 50k ] + =', payload: { line: `"${']'.repeat(50_000)}=` }, expectedSafe: true },

      // I3-B always-on LineSegIndex with backslashes & valid JSON escapes
      {
        label: 'I3-B \\x + 5k nested auth_token[ (155KB)',
        payload: {
          parameters: authTokenParams,
          line: `\\x ${',auth_token['.repeat(5_000)}${']= {{auth_token}}, '.repeat(5_000)}`,
        },
        expectedSafe: true,
      },
      {
        label: 'I3-B \\x + 5k nested items[ (100KB)',
        payload: { line: `\\x ${',items['.repeat(5_000)}${']= 1, '.repeat(5_000)}` },
        expectedSafe: true,
      },
      {
        label: 'I3-B interior \\z + 4k nested a[',
        payload: { desc: `,a[\\z${',a['.repeat(4_000)}${']=1, '.repeat(4_000)}` },
        expectedSafe: true,
      },
      {
        label: 'I3-B valid \\\\ + 4k nested a[',
        payload: { desc: `\\\\ ${',a['.repeat(4_000)}${']=1, '.repeat(4_000)}` },
        expectedSafe: true,
      },
      {
        label: 'I3-B interior valid \\u0041 + 4k nested a[',
        payload: { desc: `,a[\\u0041${',a['.repeat(4_000)}${']=1, '.repeat(4_000)}` },
        expectedSafe: true,
      },
      {
        label: 'I3-B straddling \\n + interior \\u0041 + 2k [x',
        payload: { desc: `foo\\n${'a'.repeat(5_000)}[\\u0041${'[x'.repeat(2_000)}${']=1 '.repeat(2_000)}` },
        expectedSafe: true,
      },

      // I3-C fail-fast leaky benchmarks
      { label: 'I3-C ;password=x x6000', payload: { line: ';password=x'.repeat(6_000) }, expectedSafe: false },
      { label: 'I3-C Bearer: x6000', payload: { line: 'Bearer:'.repeat(6_000) }, expectedSafe: false },
      { label: 'I3-C Bearer( x6000', payload: { line: 'Bearer('.repeat(6_000) }, expectedSafe: false },
      { label: 'I3-C token={{ x4000 + 100k spaces', payload: { line: `${'token={{ '.repeat(4_000)}${' '.repeat(100_000)}` }, expectedSafe: false },
      { label: 'I3-C BFS token={{ x500 + 200k spaces', payload: { line: `\n%25252520+\\z ${'token={{ '.repeat(500)}${' '.repeat(200_000)}` }, expectedSafe: false },
      { label: 'I3-C my_bearer= x4000', payload: { line: 'my_bearer='.repeat(4_000) }, expectedSafe: false },
      { label: 'I3-C token= x8000', payload: { line: 'token='.repeat(8_000) }, expectedSafe: false },
      { label: 'I3-C authorization= x4000', payload: { line: 'authorization='.repeat(4_000) }, expectedSafe: false },
      { label: 'I3-C Basic= x4000', payload: { line: 'Basic='.repeat(4_000) }, expectedSafe: false },
      { label: 'I3-C duplicate-key JSON x5000', payload: { raw: `{ ${'"password":"x",'.repeat(5_000)}"a":1 }` }, expectedSafe: false },
      { label: 'I3C-3 ReDoS L1561 Basic a + 80k ( + {{tok}}', payload: { line: `Basic a${'('.repeat(80_000)}{{tok}}` }, expectedSafe: false },
      { label: 'I3C-3 ReDoS L1596 Bearer a a + 80k ( + b', payload: { line: `Bearer a a${'('.repeat(80_000)}b` }, expectedSafe: false },
      { label: 'I3C-2 Basic=ab: x6000 splitsRun leaky', payload: { line: 'Basic=ab:'.repeat(6_000) }, expectedSafe: false },

      // I3C-1..I3C-9 safe: true adversarial benchmarks (fail-fast NEVER triggers)
      { label: 'I3C-1 Basic( x6000', payload: { line: 'Basic('.repeat(6_000) }, expectedSafe: true },
      { label: 'I3C-2 Basic: x6000', payload: { line: 'Basic:'.repeat(6_000) }, expectedSafe: true },
      { label: 'I3C-2 Basic" x6000', payload: { line: 'Basic"'.repeat(6_000) }, expectedSafe: true },
      { label: 'I3C-2 Basic:ok, x6000', payload: { line: 'Basic:ok,'.repeat(6_000) }, expectedSafe: true },
      { label: 'I3C-2 "Basic" x6000', payload: { line: '"Basic"'.repeat(6_000) }, expectedSafe: true },
      { label: 'I3C-2 Basic=a: x6000', payload: { line: 'Basic=a:'.repeat(6_000) }, expectedSafe: true },
      { label: 'I3C-2 earlier Basic cred + Basic: x6000', payload: { line: `YWRtaW46cGFzcw==,${'Basic:'.repeat(6_000)}` }, expectedSafe: true },
      { label: 'I3C-3 ReDoS L3641 Basic + 80k . + a', payload: { line: `Basic ${'.'.repeat(80_000)}a` }, expectedSafe: true },
      { label: 'I3C-3 ReDoS L3600 "Basic + 80k . + a', payload: { line: `"Basic ${'.'.repeat(80_000)}a` }, expectedSafe: true },
      { label: 'I3C-4 ;xBasic:a x6000', payload: { line: ';xBasic:a'.repeat(6_000) }, expectedSafe: true },
      { label: 'I3C-4 URL ,xBasic:a x6000', payload: { url: `https://example.com/?${',xBasic:a'.repeat(6_000)}` }, expectedSafe: true },
      { label: 'I3C-4 ;xBasic:"a x6000', payload: { line: ';xBasic:"a'.repeat(6_000) }, expectedSafe: true },
      { label: 'I3C-5 Basic: x6000 + 100k spaces', payload: { line: `${'Basic:'.repeat(6_000)}${' '.repeat(100_000)}` }, expectedSafe: true },
      { label: 'I3C-5 Basic: x6000 + " + 100k a (unclosed level-1 quote)', payload: { line: `${'Basic:'.repeat(6_000)} "${'a'.repeat(100_000)}` }, expectedSafe: true },
      { label: 'I3C-5 Basic: x6000 + space + 100k a (level-1 long span)', payload: { line: `${'Basic:'.repeat(6_000)} ${'a'.repeat(100_000)}` }, expectedSafe: true },
      { label: 'I3C-5 "Basic" x6000 + " + 100k .', payload: { line: `${'"Basic"'.repeat(6_000)} "${'.'.repeat(100_000)}` }, expectedSafe: true },
      { label: 'I3C-5 ;xBasic:a x6000 + 100k spaces', payload: { line: `${';xBasic:a'.repeat(6_000)}${' '.repeat(100_000)}` }, expectedSafe: true },
      { label: 'I3C-6 nested Basic ( x120 + 50k ok', payload: { line: `${'Basic ('.repeat(120)}a${')'.repeat(120)}${' ok'.repeat(50_000)}` }, expectedSafe: true },
      { label: 'I3C-6 nested Basic ( x120 + , + 200k a', payload: { line: `${'Basic ('.repeat(120)}a${')'.repeat(120)},${'a'.repeat(200_000)}` }, expectedSafe: true },
      { label: 'I3C-6 nested Bearer ( x120 + 200k . (strict bracket Bearer)', payload: { line: `${'Bearer ('.repeat(120)}a${')'.repeat(120)}${'.'.repeat(200_000)}` }, expectedSafe: false },
      { label: 'I3C-6 nested Bearer ( x120 + {{tok}} + 200k . (strict bracket Bearer)', payload: { parameters: tokParams, line: `${'Bearer ('.repeat(120)}a${')'.repeat(120)}{{tok}}${'.'.repeat(200_000)}` }, expectedSafe: false },
      { label: 'I3C-7 H4 prose guard + 100k spaces', payload: { line: `${'A "b" "c": '.repeat(5_000)}${' '.repeat(100_000)}` }, expectedSafe: true },
      { label: 'I3C-8a password={{pw}} x25k (no [)', payload: { parameters: pwParams, note: 'password={{pw}} '.repeat(25_000) }, expectedSafe: true },
      { label: 'I3C-8b https://a:1 x25k (no .)', payload: { note: 'https://a:1 '.repeat(25_000) }, expectedSafe: true },
      { label: 'I3C-8c 30k dots + 3k nested a[', payload: { note: `${'.'.repeat(30_000)}a[${',a['.repeat(3_000)}${']=1, '.repeat(3_000)}` }, expectedSafe: true },
      { label: 'I3C-8d 10k "" + 2k nested password[', payload: { parameters: pwParams, note: `${'""'.repeat(10_000)}password[${',a['.repeat(2_000)}${']={{pw}}, '.repeat(2_000)}` }, expectedSafe: true },
      { label: 'I3C-9 2k params x 4k placeholders', payload: { parameters: manyParams, note: 'password={{p1999}} '.repeat(4_000) }, expectedSafe: true },
      { label: 'Step 0 PEM linear', payload: { note: `${'-----BEGIN '.repeat(10_000)}PRIVATE KEY` }, expectedSafe: true },
      { label: 'Step 5 eyJ linear 100k', payload: { note: 'eyJ'.repeat(100_000) }, expectedSafe: true },
      { label: 'Step 5 sk-! linear 100k', payload: { note: 'sk-!'.repeat(100_000) }, expectedSafe: true },
      {
        label: '10k clean object fields',
        payload: Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`k${i}`, `clean_val_${i}`])),
        expectedSafe: true,
      },
    ];

    for (const { label, payload, expectedSafe } of cases) {
      const t = performance.now();
      const res = scanJsonForSecretLeaks(payload);
      const elapsedMs = performance.now() - t;
      expect(res.safe, `Unexpected safe result for ${label}: ${JSON.stringify(res.findings)}`).toBe(expectedSafe);
      expect(elapsedMs, `DoS latency exceeded 500ms for ${label}: ${elapsedMs.toFixed(1)}ms`).toBeLessThan(500);
    }
  });

  it('enforces Iteration 4/5 security & upstream parity controls across Step 3 Bearer multiline (I4-B), Step 4 8-level Basic & verifiedBasicRestLevel monotonicity (I4-A/I4-PARITY-1), AUDIT-BUG-1, and 3-state trailing left-extension soundness (I4-C)', () => {
    const tokParams = [{ name: 'tok', is_secret: true, default_value: null }];

    const leakyVectors: Array<{ label: string; payload: unknown }> = [
      // I4-A & I4-PARITY-1: 8-level Basic chain + verifiedBasicRestLevel level-monotonicity + repeated Basic controls
      { label: 'I4-PARITY-1 Basic 4-level chain', payload: { line: 'Basic a:\nb:\nc:\nd:\ndXNlcjpwYXNz' } },
      { label: 'I4-PARITY-1 Basic 7-level chain', payload: { line: 'Basic a:\nb:\nc:\nd:\ne:\nf:\ng:\ndXNlcjpwYXNz' } },
      { label: 'I4-A shallow re-entry monotonicity', payload: { line: 'Basic x:\nBasic:\na:\nb:\nc:\nd:\ne:\nf:\ndXNlcjpwYXNz' } },
      { label: 'I4-A repeated Basic: + quoted cred', payload: { line: `${'Basic:'.repeat(100)} "dXNlcjpwYXNz"` } },
      { label: 'I4-A repeated Basic: + multiline quoted cred', payload: { line: `${'Basic:'.repeat(100)}\n"dXNlcjpwYXNz"` } },
      { label: 'I4-A repeated Basic: + chained cred', payload: { line: `${'Basic:'.repeat(100)} a: b: dXNlcjpwYXNz` } },
      { label: 'AUDIT-BUG-1 long-quote authorization leak', payload: { parameters: tokParams, line: `"authorization"${'""'.repeat(100)}[x]=Bearer secret_leak_123456` } },

      // I4-B: Step 3 Bearer multiline trailing, rhs.followedByKvSep, Branch 3 skipWsCached, broken quote, empty-RHS materialization
      { label: 'I4-B multiline Bearer rhs trailing leak', payload: { parameters: tokParams, header: 'Bearer ok:\n{{tok}} leaked_secret_123456' } },
      { label: 'I4-B multiline Bearer rhs trailing a1b2c3', payload: { parameters: tokParams, header: 'Bearer header:\n{{tok}} a1b2c3' } },
      { label: 'I4-B multiline Bearer rhs : leaked_secret', payload: { parameters: tokParams, header: 'Bearer ok:\n{{tok}} : leaked_secret_123456' } },
      { label: 'I4-B multiline Bearer rhs : abcdef (Branch 3 kvSep)', payload: { parameters: tokParams, header: 'Bearer ok:\n{{tok}} : abcdef' } },
      { label: 'I4-B multiline Bearer rhs : a1b2 (Branch 3 kvSep)', payload: { parameters: tokParams, header: 'Bearer ok:\n{{tok}} : a1b2' } },
      { label: 'I4-B multiline Bearer rhs \\n: leaked_secret (Branch 3 skipWs)', payload: { parameters: tokParams, header: 'Bearer ok:\n{{tok}}\n: leaked_secret_123456' } },
      { label: 'I4-B multiline Bearer empty-quoted rhs trailing leak', payload: { parameters: tokParams, header: 'Bearer ok:\n"" leaked_secret_123456' } },
      { label: 'I4-B multiline Bearer broken-quote empty rhs', payload: { parameters: tokParams, header: 'Bearer ok:\n"' } },
      { label: 'I4-B deferred Step 3 empty-RHS materialization', payload: { parameters: tokParams, header: `Bearer:${'a'.repeat(200)}:\n` } },
      { label: 'I4-B deferred Step 3 empty-quoted RHS materialization', payload: { parameters: tokParams, header: `Bearer:${'a'.repeat(200)}: ""` } },
      { label: 'I4-B empty RHS strictMode leak', payload: { parameters: tokParams, header: 'Bearer secret123456:\n' } },
      { label: 'I4-B multiline Bearer rhs enclosureOverflow leak', payload: { parameters: tokParams, header: `Bearer ok:\n(${' '.repeat(5_000)}mysecret )` } },

      // I4-C: Soundness leak controls for 3-state safeStartFirstTokBraceKind & boundary splice
      { label: 'I4-C non-trim )& onto placeholder {{tok}}', payload: { parameters: tokParams, line: `${'Basic ('.repeat(5)}a${')&'.repeat(5)}{{tok}}` } },
      { label: 'I4-C leading ): onto a:{{tok}}', payload: { parameters: tokParams, line: `${'Basic ('.repeat(5)}a${'):'.repeat(5)}a:{{tok}}` } },
      { label: 'I4-C Subcase 2A ): hazard onto kv_placeholder', payload: { parameters: tokParams, line: `${'Basic ('.repeat(5)}a${'):'.repeat(4)})&a:{{tok}}` } },
      { label: 'I4-C Subcase 2A )} hazard onto kv_placeholder', payload: { parameters: tokParams, line: `${'Basic ('.repeat(5)}a${')}'.repeat(4)})&a:{{tok}}` } },
      { label: 'I4-C leading quote trap )& onto "a:{{tok}}"', payload: { parameters: tokParams, line: `${'Basic('.repeat(5)}x${')&'.repeat(5)}"a:{{tok}}"` } },
      { label: 'I4-C leading quote trap )& + )"a:{{tok}}"', payload: { parameters: tokParams, line: `${'Basic ('.repeat(5)}a${')&'.repeat(4)})"a:{{tok}}"` } },
      { label: 'I4-C seam }} synthesis (Basic {Basic {x}}}abc)', payload: { line: 'Basic {Basic {x}}}abc' } },
      { label: 'I4-C seam }} synthesis on long token (Basic {Basic {x}}} + 200 Q)', payload: { line: `Basic {Basic {x}}}${ 'Q'.repeat(200) }` } },
      { label: 'I4-C double-brace {{ in nested Basic', payload: { line: 'Basic (Basic (x) {{a),ok' } },
      { label: 'I4-C boundary splice )Y + TphYmNk (3x)', payload: { line: `${'Basic('.repeat(3)}x${')Y'.repeat(3)}TphYmNk` } },
      { label: 'I4-C boundary splice )Y + TphYmNk (5x)', payload: { line: `${'Basic('.repeat(5)}x${')Y'.repeat(5)}TphYmNk` } },
      { label: 'I4-C secret in A before kv_placeholder', payload: { parameters: tokParams, line: 'Basic (Basic (x) dXNlcjpwYXNz &)&a:{{tok}}' } },
      { label: 'I4-C = overlap in both mode', payload: { parameters: tokParams, line: 'password="{{tok}}" ========={' } },
    ];

    for (const { label, payload } of leakyVectors) {
      const res = scanJsonForSecretLeaks(payload);
      expect(res.safe, `Expected secret leak detection for: ${label}`).toBe(false);
      expect(res.findings.length).toBeGreaterThan(0);
    }

    const cleanVectors: Array<{ label: string; payload: unknown }> = [
      // I4-PARITY-1 exact 0..8 depth boundary
      { label: 'I4-PARITY-1 Basic 8-level boundary stays safe', payload: { line: 'Basic a:\nb:\nc:\nd:\ne:\nf:\ng:\nh:\ndXNlcjpwYXNz' } },
      // AUDIT-BUG-1 clean auth header control
      { label: 'AUDIT-BUG-1 long-quote authorization protected placeholder', payload: { parameters: tokParams, line: `"authorization"${'""'.repeat(100)}[x]=Bearer {{tok}}` } },
      // I4-B clean multiline & prose controls
      { label: 'I4-B clean multiline Bearer ok:\\n{{tok}}', payload: { parameters: tokParams, header: 'Bearer ok:\n{{tok}}' } },
      { label: 'I4-B clean single-line Bearer header: {{tok}}', payload: { parameters: tokParams, header: 'Bearer header: {{tok}}' } },
      { label: 'I4-B clean empty RHS Bearer ok:\\n', payload: { parameters: tokParams, header: 'Bearer ok:\n' } },
      { label: 'I4-B clean empty RHS prose Bearer authentication:\\n', payload: { parameters: tokParams, header: 'Bearer authentication:\n' } },
      { label: 'I4-B clean Authorization: Bearer {{tok}}\\n: note', payload: { parameters: tokParams, header: 'Authorization: Bearer {{tok}}\n: note' } },
      // I4-C clean single-brace parity controls (no {{ or }})
      { label: 'I4-C single { non-brace parity', payload: { line: `${'Basic ('.repeat(5)}a${'){'.repeat(4)}){abc` } },
      { label: 'I4-C single } non-brace parity', payload: { line: `${'Basic ('.repeat(5)}a${')}'.repeat(4)})}abc` } },
    ];

    for (const { label, payload } of cleanVectors) {
      const res = scanJsonForSecretLeaks(payload);
      expect(res.safe, `Expected safe=true for: ${label}, got: ${JSON.stringify(res.findings)}`).toBe(true);
    }
  });

  it('enforces linear O(N) latency (< 500ms) across ALL Iteration 4/5 DoS & cache-thrashing vectors (I4-A, AUDIT-BUG-1/2, I4-B, I4-C)', () => {
    const tokParams = [{ name: 'tok', is_secret: true, default_value: null }];

    const cases: Array<{ label: string; payload: unknown; expectedSafe: boolean }> = [
      // I4-A: Step 4 Basic chained-hop memo & thrash-proof LongRunCache
      { label: 'I4-A quoted 100KB Basic: x6000', payload: { line: `${'Basic:'.repeat(6_000)} "${'a'.repeat(100_000)}"` }, expectedSafe: true },
      { label: 'I4-A BFS quoted 25KB Basic: x1500', payload: { line: `%25252520+\\n ${'Basic:'.repeat(1_500)} "${'a'.repeat(25_000)}"` }, expectedSafe: true },
      { label: 'I4-A 100KB lhs:{{tok}} Basic: x6000', payload: { parameters: tokParams, line: `${'Basic:'.repeat(6_000)} ${'a'.repeat(100_000)}:{{tok}}` }, expectedSafe: true },
      { label: 'I4-A 1KB bracketed Basic: x6000', payload: { line: `${'Basic:'.repeat(6_000)} (${'a'.repeat(1_000)})` }, expectedSafe: true },
      { label: 'I4-A multi-level non-ws thrash Basic: x8000', payload: { line: `${'Basic:'.repeat(8_000)} a: b: ${'c'.repeat(120_000)}` }, expectedSafe: true },
      { label: 'I4-A short token + 100KB horiz ws afterHoriz', payload: { line: `${'Basic:'.repeat(6_000)} a${' '.repeat(100_000)}: b: c` }, expectedSafe: true },
      { label: 'I4-A whitespace skip thrash Basic: x8000', payload: { line: `${'Basic:'.repeat(8_000)} :${' '.repeat(120_000)}` }, expectedSafe: true },
      { label: 'I4-A double-quote thrash Basic: x8000', payload: { line: `${'Basic:'.repeat(8_000)} "a": "${'a'.repeat(120_000)}` }, expectedSafe: true },
      { label: 'I4-A single-quote thrash Basic: x6000', payload: { line: `${'Basic:'.repeat(6_000)} 'a': '${'a'.repeat(100_000)}` }, expectedSafe: true },

      // AUDIT-BUG-1 & AUDIT-BUG-2: Fixed-slot & uncached backward scan fixes
      {
        label: 'AUDIT-BUG-1 isAuthHeaderSpan 1-slot thrash',
        payload: {
          parameters: tokParams,
          line: `"password"${'""'.repeat(60_000)}${'[x'.repeat(2_000)}${'].a={{tok}} token={{tok}} '.repeat(2_000)}`,
        },
        expectedSafe: true,
      },
      {
        label: 'AUDIT-BUG-2 trimHorizWsEnd after [ run collapse (0 params)',
        payload: {
          line: `a${' '.repeat(80_000)}${'['.repeat(2_000)}x${'].b=x '.repeat(2_000)}`,
        },
        expectedSafe: true,
      },

      // I4-B: Step 3 Bearer deferred KV span & verifiedBearerRhsStart
      { label: 'I4-B Bearer: x40k + {{tok}}', payload: { parameters: tokParams, line: `${'Bearer:'.repeat(40_000)} {{tok}}` }, expectedSafe: true },
      { label: 'I4-B BFS Bearer: x10k + {{tok}}', payload: { parameters: tokParams, line: `%25252520+\\n ${'Bearer:'.repeat(10_000)} {{tok}}` }, expectedSafe: true },
      { label: 'I4-B multiline Bearer: x40k + \\n{{tok}}', payload: { parameters: tokParams, line: `${'Bearer:'.repeat(40_000)}\n{{tok}}` }, expectedSafe: true },
      { label: 'I4-B Bearer: x6k + ok : {{tok}}', payload: { parameters: tokParams, line: `${'Bearer:'.repeat(6_000)}ok : {{tok}}` }, expectedSafe: true },
      { label: 'I4-B Bearer: x6k + oversized bracket {{tok}}', payload: { parameters: tokParams, line: `${'Bearer:'.repeat(6_000)} (${' '.repeat(100_000)}{{tok}})` }, expectedSafe: true },
      { label: 'I4-B Bearer prose x20k + token', payload: { line: `${'Bearer '.repeat(20_000)}token` }, expectedSafe: true },
      { label: 'I4-B fail-fast Bearer: x40k + ok', payload: { parameters: tokParams, line: `${'Bearer:'.repeat(40_000)} ok` }, expectedSafe: false },
      { label: 'I4-B fail-fast Bearer: x6k + quoted 100k', payload: { parameters: tokParams, line: `${'Bearer:'.repeat(6_000)} "${'a'.repeat(100_000)}"` }, expectedSafe: false },
      { label: 'I4-B fail-fast Bearer: x6k + 100k:{{tok}}', payload: { parameters: tokParams, line: `${'Bearer:'.repeat(6_000)} ${'a'.repeat(100_000)}:{{tok}}` }, expectedSafe: false },
      { label: 'I4-B fail-fast Bearer" x6k', payload: { line: 'Bearer"'.repeat(6_000) }, expectedSafe: false },
      { label: 'I4-B fail-fast Bearer( x6k', payload: { line: 'Bearer('.repeat(6_000) }, expectedSafe: false },

      // I4-C: checkSameLineTrailingSafe 3-state brace kind & deferred long Basic fallback
      { label: 'I4-C nested Basic( x127 + )} + 200k Q', payload: { line: `${'Basic('.repeat(127)}x${')}'.repeat(127)}${'Q'.repeat(200_000)}` }, expectedSafe: true },
      { label: 'I4-C BFS nested Basic( x127 + )} + 30k Q', payload: { line: `%25252520+\\z\n${'Basic('.repeat(127)}x${')}'.repeat(127)}${'Q'.repeat(30_000)}` }, expectedSafe: true },
      { label: 'I4-C nested Basic ( x110 + )& + { + 200k a', payload: { line: `${'Basic ('.repeat(110)}a${')&'.repeat(110)}{${'a'.repeat(200_000)}` }, expectedSafe: true },
      { label: 'I4-C BFS nested Basic ( x110 + )& + { + 50k a', payload: { line: `%25252520+\\n ${'Basic ('.repeat(110)}a${')&'.repeat(110)}{${'a'.repeat(50_000)}` }, expectedSafe: true },
      { label: 'I4-C multiline 80x nested Basic( x127 + 4k Q', payload: { line: `${'Basic('.repeat(127)}x${')}'.repeat(127)}${'Q'.repeat(4_000)}\n`.repeat(80) }, expectedSafe: true },
      { label: 'I4-C BFS nested Basic ( x110 + )& + 50k a:{{tok}}', payload: { parameters: tokParams, line: `%25252520+\\n ${'Basic ('.repeat(110)}a${')&'.repeat(110)}${'a'.repeat(50_000)}:{{tok}}` }, expectedSafe: true },
      { label: 'I4-C nested Bearer( x120 + 50k a:{{tok}}', payload: { parameters: tokParams, line: `${'Bearer('.repeat(120)}a:{{tok}}${')'.repeat(120)}&${'a'.repeat(50_000)}:{{tok}}` }, expectedSafe: true },
      { label: 'I4-C nested Bearer( x120 + 200k non-ASCII', payload: { parameters: tokParams, line: `${'Bearer('.repeat(120)}a:{{tok}}${')'.repeat(120)}&${'α'.repeat(200_000)}` }, expectedSafe: true },
    ];

    for (const { label, payload, expectedSafe } of cases) {
      const t = performance.now();
      const res = scanJsonForSecretLeaks(payload);
      const elapsedMs = performance.now() - t;
      expect(res.safe, `Unexpected safe result for ${label}: ${JSON.stringify(res.findings)}`).toBe(expectedSafe);
      expect(elapsedMs, `DoS latency exceeded 500ms for ${label}: ${elapsedMs.toFixed(1)}ms`).toBeLessThan(500);
    }
  });
});

describe('Coding Agents, Remote Control & Official OAuth 2.1 MCP Contracts', () => {
  it('exposes all 6 coding providers, 13 slash commands, and CLI parser helpers', () => {
    expect(CODING_PROVIDER_KINDS).toHaveLength(6);
    expect(CODING_SLASH_COMMANDS).toHaveLength(13);
    expect(parseCodingProviderKind('claude-code')).toBe('claude_code');
    expect(parseCodingProviderKind('cursor-agent')).toBe('cursor_cli');
    expect(parseCodingProviderKind('agy')).toBe('antigravity');
    expect(parseCodingProviderKind('unknown')).toBeNull();
    expect(parseCodingPermissionMode('auto-edit')).toBe('auto_edit');
    expect(parseCodingPermissionMode('autonomous')).toBe('full_access');
    expect(parseCodingPermissionMode('invalid')).toBeNull();
  });

  it('classifies read-only vs mutating RemoteComputerOp variants accurately', () => {
    const readOps: RemoteComputerOp[] = [
      { op: 'read_file', path: '/tmp/a' },
      { op: 'list_dir', path: '/tmp' },
      { op: 'capture_screen' },
      { op: 'clipboard_get' },
      { op: 'display_list' },
      { op: 'accessibility_tree', max_depth: 4 },
      { op: 'terminal_op', terminal_op: 'ls' },
      { op: 'test_connection' },
    ];
    const writeOps: RemoteComputerOp[] = [
      { op: 'shell_exec', command: 'ls' },
      { op: 'write_file', path: '/tmp/a', content: 'hi' },
      { op: 'mouse_action', action: 'click', x: 10, y: 20 },
      { op: 'keyboard_action', action: 'type', text: 'hello' },
      { op: 'clipboard_set', text: 'hello' },
      { op: 'power_action', action: { kind: 'lock' } },
      { op: 'terminal_op', terminal_op: 'exec', command: 'whoami' },
      { op: 'file_chunk_op', chunk_op: 'write', transfer_id: 't1', path: '/a', offset: 0 },
    ];

    for (const op of readOps) expect(isReadOnlyRemoteComputerOp(op)).toBe(true);
    for (const op of writeOps) expect(isReadOnlyRemoteComputerOp(op)).toBe(false);
  });

  it('exposes exact MCP protocol versions and 14 OAuth 2.1 scopes', () => {
    expect(MCP_PROTOCOL_VERSIONS).toEqual(['2025-11-25', '2025-06-18', '2025-03-26']);
    expect(DEFAULT_MCP_PROTOCOL_VERSION).toBe('2025-11-25');
    expect(MCP_OAUTH_SCOPES).toHaveLength(14);
    expect(isSupportedMcpProtocolVersion('2025-11-25')).toBe(true);
    expect(isSupportedMcpProtocolVersion('2024-01-01')).toBe(false);
    expect(isSupportedMcpScope('miniapp:control')).toBe(true);
    expect(isSupportedMcpScope('admin:all')).toBe(false);
  });
});

describe('Server Config Env Wiring & URL Normalization (apps/server/src/config.ts)', () => {
  it('normalizes AI gateway base URLs without doubling /v1 or corrupting /v1beta', () => {
    expect(normalizeAiGatewayBaseUrl(undefined)).toBe('https://ai.ombhrum.com');
    expect(normalizeAiGatewayBaseUrl(null)).toBe('https://ai.ombhrum.com');
    expect(normalizeAiGatewayBaseUrl('')).toBe('https://ai.ombhrum.com');
    expect(normalizeAiGatewayBaseUrl('   ')).toBe('https://ai.ombhrum.com');
    expect(normalizeAiGatewayBaseUrl('https://ai.ombhrum.com///')).toBe('https://ai.ombhrum.com');
    expect(normalizeAiGatewayBaseUrl('https://api.ombhrum.com/v1')).toBe('https://api.ombhrum.com');
    expect(normalizeAiGatewayBaseUrl('https://api.ombhrum.com/v1/')).toBe('https://api.ombhrum.com');
    expect(normalizeAiGatewayBaseUrl('https://api.ombhrum.com/V1///')).toBe(
      'https://api.ombhrum.com',
    );
    expect(normalizeAiGatewayBaseUrl('https://api.ombhrum.com/v1/v1/')).toBe(
      'https://api.ombhrum.com',
    );
    expect(normalizeAiGatewayBaseUrl('https://proxy.example.com/api/v1/')).toBe(
      'https://proxy.example.com/api',
    );
    expect(normalizeAiGatewayBaseUrl('https://proxy.example.com/v1beta')).toBe(
      'https://proxy.example.com/v1beta',
    );
    expect(normalizeAiGatewayBaseUrl('https://proxy.example.com/v10/')).toBe(
      'https://proxy.example.com/v10',
    );
    expect(normalizeAiGatewayBaseUrl('https://api.ombhrum.com/v1/?foo=1#bar')).toBe(
      'https://api.ombhrum.com',
    );
    expect(normalizeAiGatewayBaseUrl('http://127.0.0.1:8080/v1')).toBe('http://127.0.0.1:8080');
    // D10: Repeated /v1 segments separated by multiple slashes and custom fallback normalization
    expect(normalizeAiGatewayBaseUrl('https://api.ombhrum.com/v1//v1/')).toBe(
      'https://api.ombhrum.com',
    );
    expect(normalizeAiGatewayBaseUrl('https://api.ombhrum.com/v1///v1')).toBe(
      'https://api.ombhrum.com',
    );
    expect(normalizeAiGatewayBaseUrl('https://proxy.example.com/api/v1//v1/')).toBe(
      'https://proxy.example.com/api',
    );
    expect(normalizeAiGatewayBaseUrl('proxy.local/v1//v1/')).toBe('proxy.local');
    expect(normalizeAiGatewayBaseUrl('', 'https://custom.example.com/v1//v1/')).toBe(
      'https://custom.example.com',
    );
  });

  it('resolves defaults, legacy env aliases, canonical precedence, empty fallthrough, and raw UTF-8 TURN_SECRET', () => {
    expect(loadServerConfig).toBe(resolveServerConfig);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabushi-config-test-'));
    try {
      // 1. Pure defaults
      const defCfg = loadServerConfig({ dataDir: path.join(tmpDir, 'defaults') }, {});
      expect(defCfg.appVersion).toBe('1.7.0');
      expect(defCfg.cloudGatewayUrl).toBe('https://api.ombhrum.com');
      expect(defCfg.oauthGatewayUrl).toBe('https://api.ombhrum.com');
      expect(defCfg.aiGatewayUrl).toBe('https://ai.ombhrum.com');
      expect(defCfg.proxyBrowserWs).toBe(false);
      expect(defCfg.turnSecret.equals(defCfg.masterSecret)).toBe(true);

      // 2. Legacy aliases + empty canonical fallthrough
      const legacyCfg = loadServerConfig(
        { dataDir: path.join(tmpDir, 'legacy') },
        {
          GPUI_MASTER_SECRET: '',
          SESSION_SECRET: 'legacy-session-secret-1234567890',
          FABUSHI_CLOUD_GATEWAY_URL: '   ',
          OMBHRUM_API_URL: 'https://cloud.example.com///',
          FABUSHI_AI_GATEWAY_URL: '',
          AI_GATEWAY_URL: 'https://api.ombhrum.com/v1/',
          TURN_SECRET: 'coturn-raw-secret',
          PROXY_BROWSER_WS: '1',
        },
      );
      expect(
        legacyCfg.masterSecret.equals(
          crypto.createHash('sha256').update('legacy-session-secret-1234567890').digest(),
        ),
      ).toBe(true);
      expect(legacyCfg.cloudGatewayUrl).toBe('https://cloud.example.com');
      expect(legacyCfg.oauthGatewayUrl).toBe('https://cloud.example.com');
      expect(legacyCfg.aiGatewayUrl).toBe('https://api.ombhrum.com');
      expect(legacyCfg.turnSecret.equals(Buffer.from('coturn-raw-secret', 'utf8'))).toBe(true);
      expect(legacyCfg.turnSecret.equals(legacyCfg.masterSecret)).toBe(false);
      expect(legacyCfg.proxyBrowserWs).toBe(true);

      // 3. Canonical env vars take precedence over legacy aliases
      const canonicalCfg = loadServerConfig(
        { dataDir: path.join(tmpDir, 'canonical') },
        {
          GPUI_MASTER_SECRET: 'canonical-master-secret',
          SESSION_SECRET: 'legacy-session-secret',
          FABUSHI_CLOUD_GATEWAY_URL: 'https://canonical-cloud.example.com/',
          OMBHRUM_API_URL: 'https://legacy-cloud.example.com/',
          FABUSHI_AI_GATEWAY_URL: 'https://canonical-ai.example.com/v1',
          AI_GATEWAY_URL: 'https://legacy-ai.example.com/v1',
        },
      );
      expect(
        canonicalCfg.masterSecret.equals(
          crypto.createHash('sha256').update('canonical-master-secret').digest(),
        ),
      ).toBe(true);
      expect(canonicalCfg.cloudGatewayUrl).toBe('https://canonical-cloud.example.com');
      expect(canonicalCfg.oauthGatewayUrl).toBe('https://canonical-cloud.example.com');
      expect(canonicalCfg.aiGatewayUrl).toBe('https://canonical-ai.example.com');

      // 4. D11: Empty/whitespace/out-of-range PORT, slash-only cloudGatewayUrl, and empty turnSecret override fallthrough
      const emptyPortCfg = loadServerConfig(
        { dataDir: path.join(tmpDir, 'empty-port') },
        { GPUI_MASTER_SECRET: 's', PORT: '' },
      );
      expect(emptyPortCfg.port).toBe(4173);

      const wsPortCfg = loadServerConfig(
        { dataDir: path.join(tmpDir, 'ws-port') },
        { GPUI_MASTER_SECRET: 's', PORT: '   ' },
      );
      expect(wsPortCfg.port).toBe(4173);

      const overPortCfg = loadServerConfig(
        { dataDir: path.join(tmpDir, 'over-port') },
        { GPUI_MASTER_SECRET: 's', PORT: '70000' },
      );
      expect(overPortCfg.port).toBe(4173);

      const zeroPortCfg = loadServerConfig(
        { dataDir: path.join(tmpDir, 'zero-port') },
        { GPUI_MASTER_SECRET: 's', PORT: '0' },
      );
      expect(zeroPortCfg.port).toBe(0);

      const slashCloudCfg = loadServerConfig(
        { dataDir: path.join(tmpDir, 'slash-cloud'), turnSecret: '' },
        {
          GPUI_MASTER_SECRET: 's',
          FABUSHI_CLOUD_GATEWAY_URL: '///',
          OMBHRUM_API_URL: 'https://fallback-cloud.ombhrum.com/',
          FABUSHI_AI_GATEWAY_URL: '///',
          AI_GATEWAY_URL: 'https://legacy-ai.ombhrum.com/v1/',
          TURN_SECRET: 'env-turn-secret',
        },
      );
      expect(slashCloudCfg.cloudGatewayUrl).toBe('https://fallback-cloud.ombhrum.com');
      expect(slashCloudCfg.aiGatewayUrl).toBe('https://legacy-ai.ombhrum.com');
      expect(slashCloudCfg.turnSecret.equals(Buffer.from('env-turn-secret', 'utf8'))).toBe(true);

      const slashOverrideAiCfg = loadServerConfig(
        { dataDir: path.join(tmpDir, 'slash-cloud'), aiGatewayUrl: '///' },
        {
          GPUI_MASTER_SECRET: 's',
          FABUSHI_AI_GATEWAY_URL: 'https://canonical-ai.ombhrum.com/v1//v1/',
        },
      );
      expect(slashOverrideAiCfg.aiGatewayUrl).toBe('https://canonical-ai.ombhrum.com');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Reverse Proxy Route & WebSocket Matching (apps/server/src/proxy.ts)', () => {
  it('forwards all v1.6.11 API, OAuth, MCP, MiniApps, Bot, and JS routes while keeping probes & SPA local', () => {
    const localPaths = [
      '/',
      '/index.html',
      '/assets/app.js',
      '/sw.js',
      '/api/v1/health',
      '/api/v1/health/',
      '/healthz',
      '/api/v1/ready',
      '/mcp-other',
      // D12: Dot-segment path normalization on relative paths
      '/api/v1/../v1/health',
      '/api/v1/../../index.html',
      '/mcp/../../healthz',
    ];
    for (const p of localPaths) {
      expect(shouldProxyPathname(p), `Expected local (false) for ${p}`).toBe(false);
    }

    const proxiedPaths = [
      '/api/v1/chats',
      '/api/v1/fabushi-miniapp/app.wasm',
      '/api/v1/fabushi-miniapp/assets/earth_texture.jpg',
      '/health',
      '/v1/chat/completions',
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-authorization-server',
      '/.well-known/openid-configuration',
      '/oauth/register',
      '/oauth/authorize?client_id=test',
      '/oauth/token',
      '/mcp',
      '/mcp?session=abc',
      '/mcp/sse',
      '/miniapps/FabushiBot/fabushi',
      '/bot/123:ABC/getMe',
      '/bot123456:AAH-token/sendMessage',
      '/js/telegram-web-app.js',
      '/js/custom.js',
    ];
    for (const p of proxiedPaths) {
      expect(shouldProxyPathname(p), `Expected proxied (true) for ${p}`).toBe(true);
    }
  });

  it('forwards /api/v1/ws and /api/v1/tailnet/derp, and gates /api/v1/browser/ws behind PROXY_BROWSER_WS=1', () => {
    expect(shouldProxyWebSocketPathname('/api/v1/ws', {})).toBe(true);
    expect(shouldProxyWebSocketPathname('/api/v1/ws?token=abc', {})).toBe(true);
    expect(shouldProxyWebSocketPathname('ws://127.0.0.1:4173/api/v1/ws?token=1', {})).toBe(true);
    expect(shouldProxyWebSocketPathname('/api/v1/tailnet/derp', {})).toBe(true);
    expect(shouldProxyWebSocketPathname('/api/v1/tailnet/derp?node=1', {})).toBe(true);

    expect(shouldProxyWebSocketPathname('/api/v1/browser/ws', {})).toBe(false);
    expect(shouldProxyWebSocketPathname('/api/v1/browser/ws?role=tab', {})).toBe(false);
    expect(shouldProxyWebSocketPathname('/api/v1/browser/ws', { PROXY_BROWSER_WS: '0' })).toBe(
      false,
    );
    expect(shouldProxyWebSocketPathname('/api/v1/browser/ws', { PROXY_BROWSER_WS: '1' })).toBe(
      true,
    );
    expect(shouldProxyWebSocketPathname('/api/v1/browser/ws', { proxyBrowserWs: true })).toBe(true);
    expect(shouldProxyWebSocketPathname('/api/v1/browser/ws', true)).toBe(true);
    expect(shouldProxyWebSocketPathname('/ws/other', { PROXY_BROWSER_WS: '1' })).toBe(false);
  });

  it('neutralizes WHATWG backslash/control-char authority confusion, redundant slashes, percent-encoded dot-segments, and probe trailing slashes (I2-F)', () => {
    const mustBeLocal = [
      // Relative backslash authority confusion & liveness bypasses
      '/\\evil.com/mcp',
      '\\evil.com/mcp',
      '\\\\evil.com/mcp',
      '///\\evil.com/mcp',
      '/\\evil.com/api/v1/chats',
      '/\\api/v1/health',
      '\\api\\v1\\health',
      '/api/v1/..\\v1\\health',
      // Control characters stripped by WHATWG URL §4.3
      '/\t/evil.com/mcp',
      '/\n/evil.com/mcp',
      '/\r/evil.com/mcp',
      '\t/api/v1/health',
      '/\t/api/v1/health',
      '/\t\\evil.com/mcp',
      // Protocol-relative & redundant leading slashes
      '//evil.com/mcp',
      '//evil.com/api/v1/health',
      '//api/v1/health',
      '///api/v1/health',
      '/..//api/v1/health',
      // Full URLs with scheme
      'https://web.ombhrum.com/api/v1/../v1/health',
      'https://example.com/\\evil.com/api/v1/chats',
      'https://web.ombhrum.com//api/v1/health',
      // Percent-encoded dot-segments
      '/api/v1/%2e%2e/v1/health',
      '/api/v1/%2e%2e/%2e%2e/index.html',
      // Trailing slashes & dot on liveness probes
      '/api/v1/health///',
      '/healthz/',
      '/api/v1/ready/',
      '/api/v1/health/.',
    ];
    for (const p of mustBeLocal) {
      expect(shouldProxyPathname(p), `Expected local (false) for ${JSON.stringify(p)}`).toBe(false);
    }

    const mustBeProxied = [
      '//api/v1/chats',
      '//mcp',
      '/\\mcp',
      '/..//api/v1/chats',
      'https://web.ombhrum.com//api/v1/chats',
      'https://web.ombhrum.com/mcp?foo=bar',
    ];
    for (const p of mustBeProxied) {
      expect(shouldProxyPathname(p), `Expected proxied (true) for ${JSON.stringify(p)}`).toBe(true);
    }

    const wsLocal = [
      '/\\evil.com/api/v1/ws',
      '\\evil.com/api/v1/ws',
      '/\\evil.com/api/v1/tailnet/derp',
      '/\t/evil.com/api/v1/ws',
      '//evil.com/api/v1/ws',
    ];
    for (const p of wsLocal) {
      expect(
        shouldProxyWebSocketPathname(p, {}),
        `Expected WS local (false) for ${JSON.stringify(p)}`,
      ).toBe(false);
    }

    expect(shouldProxyWebSocketPathname('//api/v1/ws', {})).toBe(true);
    expect(shouldProxyWebSocketPathname('/\\api/v1/ws', {})).toBe(true);
    expect(shouldProxyWebSocketPathname('\\api\\v1\\ws', {})).toBe(true);
    expect(shouldProxyWebSocketPathname('/..//api/v1/ws', {})).toBe(true);
    expect(shouldProxyWebSocketPathname('ws://127.0.0.1:4173/api/v1/tailnet/derp?peer=1', {})).toBe(
      true,
    );
    expect(shouldProxyWebSocketPathname('ws://127.0.0.1:4173//api/v1/ws?token=1', {})).toBe(true);
    expect(shouldProxyWebSocketPathname('/api/v1/%2e%2e/v1/ws', {})).toBe(true);
    expect(shouldProxyWebSocketPathname('/api/v1/ws/%2e%2e/browser/ws', {})).toBe(false);
    expect(
      shouldProxyWebSocketPathname('/api/v1/ws/%2e%2e/browser/ws', { PROXY_BROWSER_WS: '1' }),
    ).toBe(true);
  });
});
