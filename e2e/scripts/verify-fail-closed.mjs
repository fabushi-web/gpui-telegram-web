import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { chromium } from '@playwright/test';

const __filename = fileURLToPath(import.meta.url);
const SCRIPTS_DIR = path.dirname(__filename);
const E2E_ROOT = path.resolve(SCRIPTS_DIR, '..');
const E2E_DATA_DIR = path.join(E2E_ROOT, '.e2e-data');
const E2E_TMP_DIR = path.join(E2E_DATA_DIR, 'tmp');
const PROBE_DIR = path.join(E2E_DATA_DIR, 'probe');

// Ensure zero /tmp usage across Node, npx, Playwright, and Chromium.
fs.mkdirSync(E2E_TMP_DIR, { recursive: true });
process.env.TMPDIR = E2E_TMP_DIR;
process.env.TMP = E2E_TMP_DIR;
process.env.TEMP = E2E_TMP_DIR;

// Synchronous Node 24 module hooks so direct imports of ../helpers/*.ts work
// cleanly regardless of extensionless internal relative imports or type-only imports.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.startsWith('file://') &&
      (specifier.startsWith('./') || specifier.startsWith('../'))
    ) {
      const parentPath = fileURLToPath(context.parentURL);
      if (parentPath.startsWith(E2E_ROOT)) {
        const baseResolved = path.resolve(path.dirname(parentPath), specifier);
        const candidates = specifier.endsWith('.ts')
          ? [baseResolved]
          : specifier.endsWith('.js')
            ? [baseResolved, baseResolved.slice(0, -3) + '.ts']
            : [baseResolved + '.ts', path.join(baseResolved, 'index.ts')];
        for (const candidate of candidates) {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return { url: pathToFileURL(candidate).href, shortCircuit: true };
          }
        }
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('file://') && url.endsWith('.ts')) {
      const filePath = fileURLToPath(url);
      const source = fs.readFileSync(filePath, 'utf8');
      const transpiled = ts.transpileModule(source, {
        fileName: filePath,
        compilerOptions: {
          target: ts.ScriptTarget.ES2023,
          module: ts.ModuleKind.ESNext,
          esModuleInterop: true,
        },
      });
      return {
        format: 'module',
        source: transpiled.outputText,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const DUMMY_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Dummy Placeholder Server</title>
  </head>
  <body>
    <main id="dummy-placeholder">Not gpui-telegram-web</main>
  </body>
</html>`;

const PURPLE_DARK_HTML = `<!doctype html>
<html lang="en" data-theme="night">
  <head>
    <meta charset="utf-8" />
    <title>Purple Dark Anti-Regression Probe</title>
    <style>
      html, body { margin: 0; background-color: #17212B; color: #F5F5F5; }
      #app-shell { display: flex; min-height: 100vh; background-color: #17212B; }
      #left-column { width: 320px; background-color: #17212B; border-right: 1px solid #0E1621; }
      #middle-column { flex: 1; background-color: #17212B; padding: 16px; }
      [data-testid="message-bubble"] {
        background-color: #8774E1;
        color: #FFFFFF;
        border: 1px solid #8774E1;
        padding: 10px 14px;
      }
      button {
        background-color: #8774E1;
        color: #FFFFFF;
        border: 1px solid #8774E1;
        padding: 8px 16px;
      }
    </style>
  </head>
  <body>
    <div id="app-shell">
      <aside id="left-column">Left</aside>
      <main id="middle-column">
        <div data-testid="message-bubble">Forbidden purple bubble (#8774E1)</div>
        <button id="btn-purple-cta" type="button">Purple Action</button>
      </main>
    </div>
  </body>
</html>`;

const VALID_DARK_HTML = `<!doctype html>
<html lang="en" data-theme="night">
  <head>
    <meta charset="utf-8" />
    <title>Valid Telegram Blue Dark Probe</title>
    <style>
      html, body { margin: 0; background-color: #17212B; color: #F5F5F5; }
      #app-shell { display: flex; min-height: 100vh; background-color: #17212B; }
      #left-column { width: 320px; background-color: #17212B; border-right: 1px solid #0E1621; }
      #middle-column { flex: 1; background-color: #0E1621; padding: 16px; }
      [data-testid="message-bubble"] {
        background-color: #2B5278;
        color: #F5F5F5;
        border: 1px solid #2B5278;
        padding: 10px 14px;
      }
      button {
        background-color: #3390EC;
        color: #FFFFFF;
        border: 1px solid #3390EC;
        padding: 8px 16px;
      }
    </style>
  </head>
  <body>
    <div id="app-shell">
      <aside id="left-column">Left</aside>
      <main id="middle-column">
        <div data-testid="message-bubble">Valid Telegram Blue outgoing bubble (#2B5278)</div>
        <button id="btn-blue-cta" type="button">Telegram Blue Action (#3390EC)</button>
      </main>
    </div>
  </body>
</html>`;

function collectSpecFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectSpecFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.spec.ts')) {
      results.push(full);
    }
  }
  return results.sort();
}

async function verifyMediaHelpers(media) {
  // 1. PNG
  assert.equal(typeof media.createPngBuffer, 'function', 'media.createPngBuffer must be exported');
  const png = media.createPngBuffer({ width: 16, height: 16, r: 51, g: 144, b: 236 });
  assert.ok(Buffer.isBuffer(png), 'createPngBuffer must return a Buffer');
  assert.ok(png.length > 64, `PNG buffer too small (${png.length} bytes)`);
  assert.deepEqual(
    [...png.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'PNG magic signature mismatch',
  );
  assert.ok(png.includes(Buffer.from('IHDR')), 'PNG missing IHDR chunk');
  assert.ok(png.includes(Buffer.from('IDAT')), 'PNG missing IDAT chunk');
  assert.ok(png.includes(Buffer.from('IEND')), 'PNG missing IEND chunk');

  // 2. WAV
  assert.equal(typeof media.createWavBuffer, 'function', 'media.createWavBuffer must be exported');
  const wav = media.createWavBuffer({ durationMs: 250, frequencyHz: 440, sampleRate: 16000 });
  assert.ok(Buffer.isBuffer(wav), 'createWavBuffer must return a Buffer');
  assert.ok(wav.length >= 44 + 8000, `WAV buffer unexpectedly short (${wav.length} bytes)`);
  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF', 'WAV missing RIFF header');
  assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE', 'WAV missing WAVE format marker');
  assert.equal(wav.subarray(12, 16).toString('ascii'), 'fmt ', 'WAV missing fmt chunk');
  assert.ok(wav.includes(Buffer.from('data')), 'WAV missing data chunk');

  // 3. PDF
  assert.equal(typeof media.createPdfBuffer, 'function', 'media.createPdfBuffer must be exported');
  const pdf = media.createPdfBuffer('Fail-Closed Verification Doc');
  assert.ok(Buffer.isBuffer(pdf), 'createPdfBuffer must return a Buffer');
  assert.ok(pdf.length > 100, `PDF buffer too small (${pdf.length} bytes)`);
  assert.equal(pdf.subarray(0, 7).toString('ascii'), '%PDF-1.', 'PDF missing %PDF-1.x header');
  assert.ok(pdf.toString('ascii').trimEnd().endsWith('%%EOF'), 'PDF missing %%EOF trailer');

  // 4. Text
  assert.equal(typeof media.createTextBuffer, 'function', 'media.createTextBuffer must be exported');
  const txt = media.createTextBuffer('gpui-telegram-web e2e text payload');
  assert.ok(Buffer.isBuffer(txt), 'createTextBuffer must return a Buffer');
  assert.ok(txt.length >= 30, `Text buffer too small (${txt.length} bytes)`);
  assert.ok(
    txt.toString('utf8').includes('gpui-telegram-web'),
    'Text buffer content mismatch',
  );

  // 5. Corrupt Image
  assert.equal(
    typeof media.createCorruptImageBuffer,
    'function',
    'media.createCorruptImageBuffer must be exported',
  );
  const corrupt = media.createCorruptImageBuffer();
  assert.ok(Buffer.isBuffer(corrupt), 'createCorruptImageBuffer must return a Buffer');
  assert.ok(corrupt.length >= 16, `Corrupt buffer too small (${corrupt.length} bytes)`);
  const notPng = !(
    corrupt[0] === 0x89 &&
    corrupt[1] === 0x50 &&
    corrupt[2] === 0x4e &&
    corrupt[3] === 0x47
  );
  const notJpeg = !(corrupt[0] === 0xff && corrupt[1] === 0xd8 && corrupt[2] === 0xff);
  const notGif = corrupt.subarray(0, 4).toString('ascii') !== 'GIF8';
  assert.ok(notPng && notJpeg && notGif, 'Corrupt image buffer must not have valid image magic bytes');

  console.log('[verify:fail-closed] Step 1/4 PASS — media.ts magic bytes & lengths verified.');
}

function startDummyServer() {
  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');

    if (reqUrl.pathname === '/api/v1/test/reset') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (reqUrl.pathname === '/api/v1/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, dummy: true }));
      return;
    }

    if (reqUrl.pathname.startsWith('/api/')) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'DUMMY_ENDPOINT' }));
      return;
    }

    if (reqUrl.pathname === '/purple-dark') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PURPLE_DARK_HTML);
      return;
    }

    if (reqUrl.pathname === '/valid-dark') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(VALID_DARK_HTML);
      return;
    }

    // Both '/' and '/dummy' (and any SPA fallback path) return dummy HTML lacking #auth-screen / #app-shell.
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(DUMMY_HTML);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to bind ephemeral 127.0.0.1 port'));
        return;
      }
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function main() {
  const media = await import('../helpers/media.ts');
  const ui = await import('../helpers/ui.ts');
  const selectors = await import('../helpers/selectors.ts');
  const serverHelpers = await import('../helpers/server.ts');

  assert.equal(
    typeof ui.assertNoPurpleOnDark,
    'function',
    'helpers/ui.ts must export assertNoPurpleOnDark',
  );
  assert.equal(typeof selectors.DOM?.appShell, 'string', 'helpers/selectors.ts must export DOM');
  assert.equal(
    typeof serverHelpers.getBaseUrl,
    'function',
    'helpers/server.ts must export getBaseUrl',
  );

  // Verify getBaseUrl rejects 0.0.0.0 fail-closed
  const prevBaseUrl = process.env.E2E_BASE_URL;
  try {
    process.env.E2E_BASE_URL = 'http://0.0.0.0:4173';
    assert.throws(
      () => serverHelpers.getBaseUrl(),
      /0\.0\.0\.0/,
      'getBaseUrl must reject 0.0.0.0',
    );
  } finally {
    if (prevBaseUrl === undefined) {
      delete process.env.E2E_BASE_URL;
    } else {
      process.env.E2E_BASE_URL = prevBaseUrl;
    }
  }

  // Step (a): Verify deterministic media builders
  await verifyMediaHelpers(media);

  // Step (b): Start ephemeral 127.0.0.1:0 dummy server
  const { server, baseUrl } = await startDummyServer();
  console.log(`[verify:fail-closed] Step 2/4 PASS — ephemeral dummy server bound at ${baseUrl}`);

  let browser = null;
  try {
    // Step (c): Headless /usr/lib/chromium/chromium render + anti-purple positive/negative probes
    browser = await chromium.launch({
      executablePath: '/usr/lib/chromium/chromium',
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-fake-ui-for-media-stream'],
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    await page.goto(`${baseUrl}/dummy`, { waitUntil: 'domcontentloaded' });
    const dummyText = await page.locator('#dummy-placeholder').textContent();
    assert.equal(dummyText?.trim(), 'Not gpui-telegram-web', 'Dummy DOM render failed');
    assert.equal(await page.locator('#auth-screen').count(), 0, 'Dummy page must lack #auth-screen');
    assert.equal(await page.locator('#app-shell').count(), 0, 'Dummy page must lack #app-shell');

    await page.goto(`${baseUrl}/purple-dark`, { waitUntil: 'domcontentloaded' });
    let purpleRejected = false;
    try {
      await ui.assertNoPurpleOnDark(page);
    } catch {
      purpleRejected = true;
    }
    if (!purpleRejected) {
      throw new Error(
        'FAIL-CLOSED VIOLATION: assertNoPurpleOnDark did NOT throw on /purple-dark (#8774E1 on #17212B under data-theme="night")',
      );
    }

    await page.goto(`${baseUrl}/valid-dark`, { waitUntil: 'domcontentloaded' });
    await ui.assertNoPurpleOnDark(page);

    await context.close();
    await browser.close();
    browser = null;
    console.log(
      '[verify:fail-closed] Step 3/4 PASS — Chromium headless render & assertNoPurpleOnDark (/purple-dark rejected, /valid-dark accepted).',
    );

    // Step (d): Execute npx playwright test fail-closed probe against dummy server
    const tier1Specs = collectSpecFiles(path.join(E2E_ROOT, 'tier1'));
    const probeOutputDir = path.join(PROBE_DIR, 'test-results');
    fs.mkdirSync(PROBE_DIR, { recursive: true });

    const childEnv = {
      ...process.env,
      E2E_BASE_URL: baseUrl,
      PLAYWRIGHT_WORKERS: '1',
      CI: '1',
      TMPDIR: E2E_TMP_DIR,
      TMP: E2E_TMP_DIR,
      TEMP: E2E_TMP_DIR,
    };

    let pwArgs;
    if (tier1Specs.length > 0) {
      const firstRelSpec = path.relative(E2E_ROOT, tier1Specs[0]);
      console.log(
        `[verify:fail-closed] Probing existing Tier 1 spec (${firstRelSpec}) against dummy server...`,
      );
      pwArgs = [
        'playwright',
        'test',
        firstRelSpec,
        '--max-failures=1',
        '--retries=0',
        '--timeout=8000',
        '--reporter=list',
        `--output=${probeOutputDir}`,
      ];
    } else {
      console.log(
        '[verify:fail-closed] tier1/ has 0 specs — materializing ephemeral .e2e-data/probe/smoke.spec.ts & playwright.probe.config.mjs...',
      );
      fs.writeFileSync(
        path.join(PROBE_DIR, 'playwright.probe.config.mjs'),
        `import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: ['smoke.spec.ts'],
  outputDir: '/home/antigravity/gpui-telegram-web/e2e/.e2e-data/probe/test-results',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  timeout: 6000,
  expect: { timeout: 2000 },
  reporter: 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL,
    headless: true,
    actionTimeout: 2500,
    navigationTimeout: 5000,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    launchOptions: {
      executablePath: '/usr/lib/chromium/chromium',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-fake-ui-for-media-stream'],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
`,
        'utf8',
      );

      fs.writeFileSync(
        path.join(PROBE_DIR, 'smoke.spec.ts'),
        `import { test, expect } from '../../helpers/fixtures';
import { DOM } from '../../helpers/selectors';

test('fail-closed smoke probe rejects dummy server lacking #auth-screen and #app-shell', async ({ authPage }) => {
  await expect(authPage.locator(DOM.appShell)).toBeVisible({ timeout: 2000 });
});
`,
        'utf8',
      );

      pwArgs = [
        'playwright',
        'test',
        '-c',
        '.e2e-data/probe/playwright.probe.config.mjs',
        '--max-failures=1',
      ];
    }

    const runResult = spawnSync('npx', pwArgs, {
      cwd: E2E_ROOT,
      env: childEnv,
      encoding: 'utf8',
      timeout: 45_000,
    });

    const combinedOutput = `${runResult.stdout || ''}\n${runResult.stderr || ''}`;
    if (runResult.status === 0) {
      throw new Error(
        `FAIL-CLOSED VIOLATION: Playwright exited 0 against dummy server!\nOutput:\n${combinedOutput}`,
      );
    }

    const fatalHarnessError =
      /Cannot find module|ERR_MODULE_NOT_FOUND|SyntaxError|No tests found|Executable doesn't exist|Unknown option/i;
    if (fatalHarnessError.test(combinedOutput)) {
      throw new Error(
        `Playwright failed due to harness/config/import error rather than genuine UI assertion:\n${combinedOutput}`,
      );
    }

    const genuineFailureMarker = /\b[1-9]\d*\s+failed\b/i.test(combinedOutput);
    const missingDomContractMarker =
      /#auth-screen|#app-shell|#btn-demo-login|#chat-list|locator\(/i;

    if (!genuineFailureMarker || !missingDomContractMarker.test(combinedOutput)) {
      throw new Error(
        `Playwright exited ${runResult.status}, but output lacked expected missing-DOM assertion markers:\n${combinedOutput}`,
      );
    }

    console.log(
      `[verify:fail-closed] Step 4/4 PASS — Playwright exited non-zero (${runResult.status}) with genuine missing-DOM contract failure.`,
    );
    console.log('[verify:fail-closed] ALL FAIL-CLOSED VERIFICATION CHECKS PASSED.');
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
    fs.rmSync(PROBE_DIR, { recursive: true, force: true });
    fs.rmSync(E2E_TMP_DIR, { recursive: true, force: true });
    try {
      if (fs.existsSync(E2E_DATA_DIR) && fs.readdirSync(E2E_DATA_DIR).length === 0) {
        fs.rmdirSync(E2E_DATA_DIR);
      }
    } catch {
      // Preserve .e2e-data if non-empty
    }
  }
}

main().catch((err) => {
  console.error('[verify:fail-closed] FAILED:', err);
  process.exit(1);
});
