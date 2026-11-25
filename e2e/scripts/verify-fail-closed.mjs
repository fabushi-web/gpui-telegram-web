import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
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
// Keep per-run unique directory short (p<4hex>) so both Google Chrome (101B) and Playwright
// Chromium (105B) AF_UNIX SingletonSocket paths stay strictly under Linux's 107-byte
// sockaddr_un.sun_path limit while remaining concurrency-safe.
const RUN_ID = crypto.randomBytes(2).toString('hex');
const PROBE_DIR = path.join(E2E_DATA_DIR, `p${RUN_ID}`);
const E2E_TMP_DIR = PROBE_DIR;

// Redirect temporary browser/runner artifacts strictly into per-run isolated directory inside e2e/.e2e-data.
fs.mkdirSync(E2E_TMP_DIR, { recursive: true });
process.env.E2E_TMP_DIR = E2E_TMP_DIR;
process.env.TMPDIR = E2E_TMP_DIR;
process.env.TMP = E2E_TMP_DIR;
process.env.TEMP = E2E_TMP_DIR;

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
    <main id="dummy-placeholder">Not fabushi-web</main>
  </body>
</html>`;

const PURPLE_DARK_HTML = `<!doctype html>
<html lang="en" data-theme="night">
  <head>
    <meta charset="utf-8" />
    <title>Purple Dark Anti-Regression Probe</title>
    <style>
      html, body { margin: 0; background-color: #121212; color: #F5F5F5; }
      #app-shell { display: flex; min-height: 100vh; background-color: #121212; }
      #left-column { width: 288px; background-color: #0E0E0E; border-right: 1px solid #2C2C2C; }
      #middle-column { flex: 1; background-color: #161616; padding: 16px; }
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
    <title>Valid Apple Dark Probe — Fabushi Web v1.6.11</title>
    <style>
      html, body { margin: 0; background-color: #121212; color: #F5F5F5; }
      #app-shell { display: flex; min-height: 100vh; background-color: #121212; }
      #left-column { width: 288px; background-color: #0E0E0E; border-right: 1px solid #2C2C2C; }
      #middle-column { flex: 1; background-color: #161616; padding: 16px; }
      #cmp-input-wrap { background-color: #1F1F1F; border: 1px solid #2C2C2C; border-radius: 22px; padding: 8px 14px; }
      [data-testid="message-bubble"] {
        background-image: linear-gradient(180deg, #1884FC 0%, #116DD2 100%);
        color: #FFFFFF;
        padding: 10px 14px;
        border-radius: 18px;
      }
      button {
        background-color: #0A84FF;
        color: #FFFFFF;
        border: 1px solid #0A84FF;
        padding: 8px 16px;
      }
    </style>
  </head>
  <body>
    <div id="app-shell">
      <aside id="left-column">Left</aside>
      <main id="middle-column">
        <div data-testid="message-bubble">Valid Apple Dark gradient bubble (#1884FC -> #116DD2)</div>
        <div id="cmp-input-wrap"><button id="btn-blue-cta" type="button">Apple Blue Action (#0A84FF)</button></div>
      </main>
    </div>
  </body>
</html>`;

function collectFiles(dirPath, suffix) {
  if (!fs.existsSync(dirPath)) return [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(full, suffix));
    } else if (entry.isFile() && entry.name.endsWith(suffix)) {
      results.push(full);
    }
  }
  return results.sort();
}

function collectSpecFiles(dirPath) {
  return collectFiles(dirPath, '.spec.ts');
}

function getLineCol(sf, node) {
  const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return `${pos.line + 1}:${pos.character + 1}`;
}

function subtreeHasAssertionCall(node, sf) {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (ts.isCallExpression(n)) {
      const expr = n.expression;
      const name = ts.isIdentifier(expr)
        ? expr.text
        : ts.isPropertyAccessExpression(expr)
          ? expr.expression.getText(sf)
          : '';
      if (name === 'expect' || name === 'assertNoPurpleOnDark' || name.startsWith('assert')) {
        found = true;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function subtreeHasUiGuardCall(node) {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (ts.isPropertyAccessExpression(n)) {
      if (n.name.text === 'isVisible' || n.name.text === 'isEnabled') {
        found = true;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function isSwallowingFallbackExpr(node) {
  let expr = node;
  while (ts.isParenthesizedExpression(expr)) {
    expr = expr.expression;
  }
  if (expr.kind === ts.SyntaxKind.NullKeyword || expr.kind === ts.SyntaxKind.FalseKeyword) {
    return true;
  }
  if (ts.isIdentifier(expr) && expr.text === 'undefined') {
    return true;
  }
  if (ts.isStringLiteral(expr) && expr.text === '') {
    return true;
  }
  if (ts.isObjectLiteralExpression(expr) && expr.properties.length === 0) {
    return true;
  }
  if (ts.isArrayLiteralExpression(expr) && expr.elements.length === 0) {
    return true;
  }
  return false;
}

function isSwallowingCatchCallback(arg) {
  if (!ts.isArrowFunction(arg) && !ts.isFunctionExpression(arg)) return false;
  if (!ts.isBlock(arg.body)) {
    return isSwallowingFallbackExpr(arg.body);
  }
  if (arg.body.statements.length === 0) return true;
  if (arg.body.statements.length === 1) {
    const stmt = arg.body.statements[0];
    if (ts.isReturnStatement(stmt)) {
      return !stmt.expression || isSwallowingFallbackExpr(stmt.expression);
    }
  }
  return false;
}

function isDefaultZeroishRight(node) {
  let expr = node;
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (ts.isNumericLiteral(expr) && expr.text === '0') return 'zero';
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return 'false';
  if (ts.isArrayLiteralExpression(expr) && expr.elements.length === 0) return 'emptyArray';
  if (ts.isStringLiteral(expr) && expr.text === '') return 'emptyString';
  return null;
}

function unwrapParens(node) {
  let cur = node;
  while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
  return cur;
}

/**
 * Step 1/5: Fast TypeScript AST static anti-vacuity & opaque-box integrity gate
 * covering ALL spec files under e2e/tier1..tier4 and ALL helper files under e2e/helpers.
 */
function verifyStaticSpecIntegrity() {
  const violations = [];
  const forbiddenTestProps = new Set(['skip', 'fixme', 'todo', 'only', 'fail']);
  const forbiddenImportRoots = new Set(['packages', 'apps']);

  const helperFiles = collectFiles(path.join(E2E_ROOT, 'helpers'), '.ts');
  const tierDirs = ['tier1', 'tier2', 'tier3', 'tier4'];
  const tierCounts = { tier1: 0, tier2: 0, tier3: 0, tier4: 0 };
  const allSpecFiles = [];

  for (const tier of tierDirs) {
    const specs = collectSpecFiles(path.join(E2E_ROOT, tier));
    for (const filePath of specs) {
      allSpecFiles.push({ tier, filePath });
    }
  }

  const checkOpaqueImports = (sf, filePath) => {
    const rel = path.relative(E2E_ROOT, filePath);
    const validateSpecifier = (specText, node) => {
      if (!specText.startsWith('.')) return;
      const resolved = path.resolve(path.dirname(filePath), specText);
      if (resolved.startsWith(E2E_ROOT + path.sep) || resolved === E2E_ROOT) return;
      const segments = specText.split('/');
      if (segments.some((seg) => forbiddenImportRoots.has(seg))) {
        violations.push(`${rel}:${getLineCol(sf, node)} forbidden non-opaque import "${specText}"`);
      }
    };

    const visit = (node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        validateSpecifier(node.moduleSpecifier.text, node);
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length >= 1 &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        validateSpecifier(node.arguments[0].text, node);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  };

  for (const helperPath of helperFiles) {
    const source = fs.readFileSync(helperPath, 'utf8');
    const sf = ts.createSourceFile(helperPath, source, ts.ScriptTarget.ES2023, true);
    checkOpaqueImports(sf, helperPath);
  }

  for (const { tier, filePath } of allSpecFiles) {
    const rel = path.relative(E2E_ROOT, filePath);
    const source = fs.readFileSync(filePath, 'utf8');
    const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.ES2023, true);
    checkOpaqueImports(sf, filePath);

    let fileTestCount = 0;

    const inspectTestBody = (bodyNode) => {
      if (!subtreeHasAssertionCall(bodyNode, sf)) {
        violations.push(`${rel}:${getLineCol(sf, bodyNode)} test body has zero assertions`);
      }

      const walk = (node, inFinally, inBrowserEval) => {
        // Detect browser evaluate callbacks (DOM logic inside browser does not hold Playwright assertions)
        let nextInBrowserEval = inBrowserEval;
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          (node.expression.name.text === 'evaluate' ||
            node.expression.name.text === 'evaluateHandle' ||
            node.expression.name.text === 'addInitScript')
        ) {
          nextInBrowserEval = true;
        }

        // 1. Forbidden modifiers & tautologies
        if (ts.isPropertyAccessExpression(node)) {
          const baseName = ts.isIdentifier(node.expression) ? node.expression.text : '';
          const propName = node.name.text;
          if ((baseName === 'test' || baseName === 'describe') && forbiddenTestProps.has(propName)) {
            violations.push(
              `${rel}:${getLineCol(sf, node)} forbidden test modifier "${baseName}.${propName}"`,
            );
          }
          if (baseName === 'expect' && propName === 'soft') {
            violations.push(`${rel}:${getLineCol(sf, node)} forbidden soft assertion modifier`);
          }
        }

        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'expect') {
          if (node.arguments.length === 1) {
            const arg = unwrapParens(node.arguments[0]);
            if (
              arg.kind === ts.SyntaxKind.TrueKeyword ||
              arg.kind === ts.SyntaxKind.FalseKeyword ||
              (ts.isNumericLiteral(arg) && arg.text === '1')
            ) {
              violations.push(`${rel}:${getLineCol(sf, node)} forbidden tautological literal assertion`);
            }
          }

          // Check mixed 2xx/4xx or 500 status arrays in expect([...]).toContain(...)
          if (
            node.arguments.length >= 1 &&
            ts.isArrayLiteralExpression(unwrapParens(node.arguments[0])) &&
            node.parent &&
            ts.isPropertyAccessExpression(node.parent) &&
            node.parent.name.text === 'toContain'
          ) {
            const arr = unwrapParens(node.arguments[0]);
            const nums = [];
            for (const el of arr.elements) {
              if (ts.isNumericLiteral(el)) nums.push(Number(el.text));
            }
            if (nums.length > 0 && nums.length === arr.elements.length) {
              if (nums.includes(500)) {
                violations.push(
                  `${rel}:${getLineCol(sf, node)} status array allows HTTP 500 (${JSON.stringify(nums)})`,
                );
              }
              const has2xx = nums.some((n) => n >= 200 && n < 300);
              const has4xxOr5xx = nums.some((n) => n >= 400 && n < 600);
              if (has2xx && has4xxOr5xx) {
                violations.push(
                  `${rel}:${getLineCol(sf, node)} status array mixes 2xx with 4xx/5xx (${JSON.stringify(nums)})`,
                );
              }
            }
          }

          // Check nullish-coalescing defaults masking missing fields directly inside expect(...)
          if (node.arguments.length >= 1 && node.parent && ts.isPropertyAccessExpression(node.parent)) {
            const arg = unwrapParens(node.arguments[0]);
            if (
              ts.isBinaryExpression(arg) &&
              arg.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
            ) {
              const rhsKind = isDefaultZeroishRight(arg.right);
              const matcherName = node.parent.name.text;
              const matcherCall = node.parent.parent;
              if (rhsKind && ts.isCallExpression(matcherCall)) {
                const firstMatcherArg = matcherCall.arguments[0]
                  ? unwrapParens(matcherCall.arguments[0])
                  : null;
                const matchesZero =
                  rhsKind === 'zero' &&
                  matcherName === 'toBe' &&
                  firstMatcherArg &&
                  ts.isNumericLiteral(firstMatcherArg) &&
                  firstMatcherArg.text === '0';
                const matchesFalse =
                  rhsKind === 'false' &&
                  matcherName === 'toBe' &&
                  firstMatcherArg &&
                  firstMatcherArg.kind === ts.SyntaxKind.FalseKeyword;
                const matchesEmptyArr =
                  rhsKind === 'emptyArray' &&
                  matcherName === 'toHaveLength' &&
                  firstMatcherArg &&
                  ts.isNumericLiteral(firstMatcherArg) &&
                  firstMatcherArg.text === '0';
                const matchesEmptyStr =
                  rhsKind === 'emptyString' &&
                  matcherName === 'toBe' &&
                  firstMatcherArg &&
                  ts.isStringLiteral(firstMatcherArg) &&
                  firstMatcherArg.text === '';
                if (matchesZero || matchesFalse || matchesEmptyArr || matchesEmptyStr) {
                  violations.push(
                    `${rel}:${getLineCol(sf, node)} nullish default masks missing field in expect(...).${matcherName}(...)`,
                  );
                }
              }
            }
          }
        }

        // 2. Unbranched `if (...)` guarding assertions or UI visibility checks inside test bodies
        if (!inFinally && !inBrowserEval && ts.isIfStatement(node) && !node.elseStatement) {
          if (subtreeHasAssertionCall(node.thenStatement, sf)) {
            violations.push(
              `${rel}:${getLineCol(sf, node)} unbranched if-statement guards expect/assert call without else branch`,
            );
          } else if (subtreeHasUiGuardCall(node.expression)) {
            violations.push(
              `${rel}:${getLineCol(sf, node)} unbranched if-statement guards UI isVisible/isEnabled branch`,
            );
          }
        }

        // 3. Assertion/error-swallowing .catch(...) outside finally blocks & browser evals
        if (
          !inFinally &&
          !inBrowserEval &&
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'catch' &&
          node.arguments.length >= 1 &&
          isSwallowingCatchCallback(node.arguments[0])
        ) {
          violations.push(
            `${rel}:${getLineCol(sf, node)} error-swallowing .catch() fallback inside test body`,
          );
        }

        if (ts.isTryStatement(node)) {
          walk(node.tryBlock, inFinally, nextInBrowserEval);
          if (node.catchClause) walk(node.catchClause, inFinally, nextInBrowserEval);
          if (node.finallyBlock) walk(node.finallyBlock, true, nextInBrowserEval);
          return;
        }

        ts.forEachChild(node, (child) => walk(child, inFinally, nextInBrowserEval));
      };

      walk(bodyNode, false, false);
    };

    const topVisit = (node) => {
      if (ts.isPropertyAccessExpression(node)) {
        const baseName = ts.isIdentifier(node.expression) ? node.expression.text : '';
        const propName = node.name.text;
        if ((baseName === 'test' || baseName === 'describe') && forbiddenTestProps.has(propName)) {
          violations.push(
            `${rel}:${getLineCol(sf, node)} forbidden test modifier "${baseName}.${propName}"`,
          );
        }
      }

      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'test' &&
        node.arguments.length >= 2
      ) {
        const lastArg = node.arguments[node.arguments.length - 1];
        if (ts.isArrowFunction(lastArg) || ts.isFunctionExpression(lastArg)) {
          fileTestCount += 1;
          tierCounts[tier] += 1;
          inspectTestBody(lastArg.body);
          return;
        }
      }
      ts.forEachChild(node, topVisit);
    };

    topVisit(sf);

    if ((tier === 'tier1' || tier === 'tier2') && fileTestCount < 5) {
      violations.push(`${rel}: expected >= 5 tests per ${tier} file, found ${fileTestCount}`);
    }
  }

  assert.ok(tierCounts.tier1 >= 80, `Expected tier1 >= 80 tests, got ${tierCounts.tier1}`);
  assert.ok(tierCounts.tier2 >= 80, `Expected tier2 >= 80 tests, got ${tierCounts.tier2}`);
  assert.ok(tierCounts.tier3 >= 16, `Expected tier3 >= 16 tests, got ${tierCounts.tier3}`);
  assert.ok(tierCounts.tier4 >= 8, `Expected tier4 >= 8 tests, got ${tierCounts.tier4}`);

  if (violations.length > 0) {
    throw new Error(
      `Static AST anti-vacuity & opaque-box gate found ${violations.length} violation(s):\n${violations
        .slice(0, 40)
        .map((v) => `  - ${v}`)
        .join('\n')}`,
    );
  }

  const totalTests = tierCounts.tier1 + tierCounts.tier2 + tierCounts.tier3 + tierCounts.tier4;
  console.log(
    `[verify:fail-closed] Step 1/5 PASS — AST anti-vacuity & opaque-box gate verified ${totalTests} tests across ${allSpecFiles.length} spec files (tier1=${tierCounts.tier1} tier2=${tierCounts.tier2} tier3=${tierCounts.tier3} tier4=${tierCounts.tier4}) + ${helperFiles.length} helper files with 0 violations.`,
  );
}

async function verifyMediaHelpers(media) {
  assert.equal(typeof media.createPngBuffer, 'function', 'media.createPngBuffer must be exported');
  const png = media.createPngBuffer({ width: 16, height: 16, r: 10, g: 132, b: 255 });
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

  assert.equal(typeof media.createWavBuffer, 'function', 'media.createWavBuffer must be exported');
  const wav = media.createWavBuffer({ durationMs: 250, frequencyHz: 440, sampleRate: 16000 });
  assert.ok(Buffer.isBuffer(wav), 'createWavBuffer must return a Buffer');
  assert.ok(wav.length >= 44 + 8000, `WAV buffer unexpectedly short (${wav.length} bytes)`);
  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF', 'WAV missing RIFF header');
  assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE', 'WAV missing WAVE format marker');
  assert.equal(wav.subarray(12, 16).toString('ascii'), 'fmt ', 'WAV missing fmt chunk');
  assert.ok(wav.includes(Buffer.from('data')), 'WAV missing data chunk');

  assert.equal(typeof media.createPdfBuffer, 'function', 'media.createPdfBuffer must be exported');
  const pdf = media.createPdfBuffer('Fail-Closed Verification Doc');
  assert.ok(Buffer.isBuffer(pdf), 'createPdfBuffer must return a Buffer');
  assert.ok(pdf.length > 100, `PDF buffer too small (${pdf.length} bytes)`);
  assert.equal(pdf.subarray(0, 7).toString('ascii'), '%PDF-1.', 'PDF missing %PDF-1.x header');
  assert.ok(pdf.toString('ascii').trimEnd().endsWith('%%EOF'), 'PDF missing %%EOF trailer');

  assert.equal(typeof media.createTextBuffer, 'function', 'media.createTextBuffer must be exported');
  const txt = media.createTextBuffer('fabushi-web e2e text payload');
  assert.ok(Buffer.isBuffer(txt), 'createTextBuffer must return a Buffer');
  assert.ok(txt.length >= 24, `Text buffer too small (${txt.length} bytes)`);
  assert.ok(txt.toString('utf8').includes('fabushi-web'), 'Text buffer content mismatch');

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

  console.log('[verify:fail-closed] Step 2/5 PASS — helper contracts & media.ts magic bytes verified.');
}

function runCommandAsync(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeout ?? 45_000);

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({
        status: timedOut ? 124 : (code ?? 1),
        stdout,
        stderr,
        timedOut,
      });
    });
  });
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

    if (
      reqUrl.pathname.startsWith('/api/') ||
      reqUrl.pathname.startsWith('/oauth/') ||
      reqUrl.pathname.startsWith('/.well-known/') ||
      reqUrl.pathname.startsWith('/v1/') ||
      reqUrl.pathname === '/mcp'
    ) {
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
  let server = null;
  let browser = null;
  try {
    // Step 1/5: Static AST anti-vacuity & opaque-box integrity audit over all 46 specs + helpers
    verifyStaticSpecIntegrity();

    const media = await import('../helpers/media.ts');
    const ui = await import('../helpers/ui.ts');
    const selectors = await import('../helpers/selectors.ts');
    const serverHelpers = await import('../helpers/server.ts');
    const apiHelpers = await import('../helpers/api.ts');

    // Step 2/5: Verify helper exports, canonical schemas, and media magic bytes
    assert.equal(typeof ui.assertNoPurpleOnDark, 'function', 'helpers/ui.ts must export assertNoPurpleOnDark');
    assert.equal(
      typeof ui.ensureDarkThemeAndAssertNoPurple,
      'function',
      'helpers/ui.ts must export ensureDarkThemeAndAssertNoPurple',
    );
    assert.equal(typeof ui.registerAndLoginUser, 'function', 'helpers/ui.ts must export registerAndLoginUser');
    assert.equal(typeof ui.assertNoDemoAuthControls, 'function', 'helpers/ui.ts must export assertNoDemoAuthControls');
    assert.equal('btnDemoLogin' in selectors.DOM, false, 'DOM must not contain removed demo login selector');
    assert.equal('btnSimulateQrScan' in selectors.DOM, false, 'DOM must not contain removed QR simulation selector');
    assert.equal('btnMtprotoConfig' in selectors.DOM, false, 'DOM must not contain removed MTProto config selector');
    assert.equal(typeof selectors.DOM.appShell, 'string', 'DOM.appShell must exist');
    assert.equal(typeof selectors.DOM.browserWorkspace, 'string', 'DOM.browserWorkspace must exist');
    assert.equal(typeof selectors.DOM.sidebarPinnedChatsGrid, 'string', 'DOM.sidebarPinnedChatsGrid must exist');
    assert.equal(typeof selectors.DOM.automationAppStorePanel, 'string', 'DOM.automationAppStorePanel must exist');
    assert.equal(typeof selectors.DOM.oauthMcpGrantsPanel, 'string', 'DOM.oauthMcpGrantsPanel must exist');
    assert.equal(typeof selectors.DOM.remoteAssistPanel, 'string', 'DOM.remoteAssistPanel must exist');
    assert.equal(typeof selectors.DOM.vaultSettingsPanel, 'string', 'DOM.vaultSettingsPanel must exist');
    assert.equal(typeof serverHelpers.getBaseUrl, 'function', 'helpers/server.ts must export getBaseUrl');
    assert.equal(
      typeof serverHelpers.resolveChromiumExecutablePath,
      'function',
      'helpers/server.ts must export resolveChromiumExecutablePath',
    );
    assert.equal(apiHelpers.MCP_SUPPORTED_SCOPES.length, 14, 'MCP_SUPPORTED_SCOPES must have 14 canonical scopes');
    assert.equal(
      Buffer.from(apiHelpers.generateWrappedRootKeyB64(), 'base64').length,
      60,
      'generateWrappedRootKeyB64 must produce 60 raw bytes (12B nonce + 32B key + 16B tag)',
    );
    assert.equal(
      typeof apiHelpers.startEphemeralOpenAiStub,
      'function',
      'helpers/api.ts must export startEphemeralOpenAiStub',
    );
    assert.equal(
      typeof apiHelpers.obtainOfficialMcpAuthCode,
      'function',
      'helpers/api.ts must export obtainOfficialMcpAuthCode',
    );
    const sampleManifest = apiHelpers.buildValidAutomationAppManifest();
    assert.ok(
      sampleManifest.parameters.some((p) => p.is_secret === true && p.default_value === null),
      'buildValidAutomationAppManifest must emit canonical ScriptParameter.is_secret',
    );

    // Verify getBaseUrl rejects 0.0.0.0 fail-closed
    const prevBaseUrl = process.env.E2E_BASE_URL;
    try {
      process.env.E2E_BASE_URL = 'http://0.0.0.0:4173';
      assert.throws(() => serverHelpers.getBaseUrl(), /0\.0\.0\.0/, 'getBaseUrl must reject 0.0.0.0');
    } finally {
      if (prevBaseUrl === undefined) delete process.env.E2E_BASE_URL;
      else process.env.E2E_BASE_URL = prevBaseUrl;
    }

    // Verify resolveChromiumExecutablePath throws fail-closed on invalid explicit path
    const prevChromePath = process.env.PLAYWRIGHT_CHROME_PATH;
    try {
      process.env.PLAYWRIGHT_CHROME_PATH = '/nonexistent/path/to/chrome-binary';
      assert.throws(
        () => serverHelpers.resolveChromiumExecutablePath(),
        /does not exist or is not executable/i,
        'resolveChromiumExecutablePath must reject invalid PLAYWRIGHT_CHROME_PATH',
      );
    } finally {
      if (prevChromePath === undefined) delete process.env.PLAYWRIGHT_CHROME_PATH;
      else process.env.PLAYWRIGHT_CHROME_PATH = prevChromePath;
    }

    await verifyMediaHelpers(media);

    // Step 3/5: Start ephemeral dummy server
    const started = await startDummyServer();
    server = started.server;
    const baseUrl = started.baseUrl;
    console.log(`[verify:fail-closed] Step 3/5 PASS — ephemeral dummy server bound at ${baseUrl}`);

    // Step 4/5: Real auto-detected Chromium render & assertNoPurpleOnDark self-test
    let bundledPath;
    try {
      bundledPath = chromium.executablePath();
    } catch {
      bundledPath = undefined;
    }
    const executablePath = serverHelpers.resolveChromiumExecutablePath(bundledPath);

    browser = await chromium.launch({
      ...(executablePath ? { executablePath } : {}),
      headless: true,
      args: [...serverHelpers.CHROMIUM_LAUNCH_ARGS],
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    await page.goto(`${baseUrl}/dummy`, { waitUntil: 'domcontentloaded' });
    const dummyText = await page.locator('#dummy-placeholder').textContent();
    assert.equal(dummyText?.trim(), 'Not fabushi-web', 'Dummy DOM render failed');
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
        'FAIL-CLOSED VIOLATION: assertNoPurpleOnDark did NOT throw on /purple-dark under data-theme="night"',
      );
    }

    await page.goto(`${baseUrl}/valid-dark`, { waitUntil: 'domcontentloaded' });
    await ui.assertNoPurpleOnDark(page);

    await context.close();
    await browser.close();
    browser = null;
    console.log(
      `[verify:fail-closed] Step 4/5 PASS — auto-detected Chromium (${executablePath ?? 'playwright-bundled'}) render & assertNoPurpleOnDark (/purple-dark rejected, Apple Dark /valid-dark accepted).`,
    );

    // Step 5/5: Probe representative spec from ALL 4 tiers sequentially against dummy server
    const tiers = ['tier1', 'tier2', 'tier3', 'tier4'];
    const tierTargets = [];
    for (const tier of tiers) {
      const specs = collectSpecFiles(path.join(E2E_ROOT, tier));
      assert.ok(
        specs.length > 0,
        `Expected at least 1 spec file inside ${tier}/ for 4-tier fail-closed proof`,
      );
      tierTargets.push({ tier, relSpec: path.relative(E2E_ROOT, specs[0]) });
    }

    const probeOutputDir = path.join(PROBE_DIR, 'out');
    fs.mkdirSync(PROBE_DIR, { recursive: true });

    const childEnv = {
      ...process.env,
      E2E_BASE_URL: baseUrl,
      E2E_EXPECT_TIMEOUT_MS: '2500',
      E2E_TMP_DIR,
      PLAYWRIGHT_WORKERS: '1',
      CI: '1',
      TMPDIR: E2E_TMP_DIR,
      TMP: E2E_TMP_DIR,
      TEMP: E2E_TMP_DIR,
    };

    const fatalHarnessError =
      /Cannot find module|ERR_MODULE_NOT_FOUND|SyntaxError|No tests found|Executable doesn't exist|Unknown option|does not exist or is not executable|No executable Chromium\/Chrome|while setting up "resetServerHook"/i;
    const genuineContractMarker =
      /#auth-screen|#app-shell|#chat-list|locator\(|expect\(|DUMMY_ENDPOINT|HTTP\s+404|failed with HTTP|register|toBeVisible|toBe\(/i;

    for (const { tier, relSpec } of tierTargets) {
      console.log(
        `[verify:fail-closed] Probing ${tier} (${relSpec}) against dummy server...`,
      );
      const runResult = await runCommandAsync(
        'npx',
        [
          'playwright',
          'test',
          relSpec,
          '--max-failures=1',
          '--retries=0',
          '--timeout=8000',
          '--reporter=list',
          `--output=${path.join(probeOutputDir, tier)}`,
        ],
        {
          cwd: E2E_ROOT,
          env: childEnv,
          timeout: 45_000,
        },
      );

      const combinedOutput = `${runResult.stdout || ''}\n${runResult.stderr || ''}`;
      if (runResult.status === 0) {
        throw new Error(
          `FAIL-CLOSED VIOLATION: ${tier} (${relSpec}) exited 0 against dummy server!\nOutput:\n${combinedOutput}`,
        );
      }

      if (runResult.timedOut) {
        throw new Error(
          `${tier} (${relSpec}) timed out waiting on child Playwright process:\n${combinedOutput}`,
        );
      }

      if (fatalHarnessError.test(combinedOutput)) {
        throw new Error(
          `${tier} (${relSpec}) failed due to harness/config/import/browser error rather than genuine contract failure:\n${combinedOutput}`,
        );
      }

      const genuineFailureMarker = /\b[1-9]\d*\s+failed\b/i.test(combinedOutput);
      if (!genuineFailureMarker || !genuineContractMarker.test(combinedOutput)) {
        throw new Error(
          `${tier} (${relSpec}) exited ${runResult.status}, but output lacked expected contract failure markers:\n${combinedOutput}`,
        );
      }

      console.log(
        `[verify:fail-closed] ${tier} (${relSpec}) PASS — exited non-zero (${runResult.status}) with genuine contract failure.`,
      );
    }

    console.log(
      '[verify:fail-closed] Step 5/5 PASS — all 4 tiers proved fail-closed against dummy server.',
    );
    console.log('[verify:fail-closed] ALL 5 FAIL-CLOSED VERIFICATION CHECKS PASSED.');
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    }
    fs.rmSync(PROBE_DIR, { recursive: true, force: true });
    try {
      if (fs.existsSync(E2E_DATA_DIR) && fs.readdirSync(E2E_DATA_DIR).length === 0) {
        fs.rmdirSync(E2E_DATA_DIR);
      }
    } catch {
      // Preserve .e2e-data if another concurrent run is active
    }
  }
}

main().catch((err) => {
  console.error('[verify:fail-closed] FAILED:', err);
  process.exit(1);
});
