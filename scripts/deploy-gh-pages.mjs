#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDistDir = path.join(rootDir, 'apps', 'web', 'dist');
const repoSlug = process.env.GITHUB_REPOSITORY?.split('/')[1]?.trim();
const basePath =
  process.env.VITE_BASE_PATH?.trim() || (repoSlug ? `/${repoSlug}/` : '/fabushi-web/');
const defaultServerUrl =
  process.env.VITE_DEFAULT_SERVER_URL?.trim() || 'https://web.ombhrum.com';

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, {
    cwd: rootDir,
    stdio: 'inherit',
    ...opts,
  });
}

const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
  cwd: rootDir,
  encoding: 'utf8',
}).trim();

const gitName = execFileSync('git', ['config', 'user.name'], {
  cwd: rootDir,
  encoding: 'utf8',
}).trim();

const gitEmail = execFileSync('git', ['config', 'user.email'], {
  cwd: rootDir,
  encoding: 'utf8',
}).trim();

console.log(
  `[deploy:pages] Building @gpui-telegram/protocol & @gpui-telegram/web with VITE_BASE_PATH=${basePath}, VITE_DEFAULT_SERVER_URL=${defaultServerUrl}...`,
);
run('npm', ['run', 'build', '--workspace=@gpui-telegram/protocol']);
run('npm', ['run', 'build', '--workspace=@gpui-telegram/web'], {
  env: {
    ...process.env,
    VITE_BASE_PATH: basePath,
    VITE_DEFAULT_SERVER_URL: defaultServerUrl,
  },
});

const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabushi-web-pages-'));
try {
  fs.cpSync(webDistDir, stageDir, { recursive: true });
  fs.copyFileSync(path.join(stageDir, 'index.html'), path.join(stageDir, '404.html'));
  fs.writeFileSync(path.join(stageDir, '.nojekyll'), '');

  console.log('[deploy:pages] Publishing static bundle to origin/gh-pages...');
  run('git', ['init', '-b', 'gh-pages'], { cwd: stageDir });
  run('git', ['config', 'user.name', gitName || 'fabushi-web-bot'], { cwd: stageDir });
  run('git', ['config', 'user.email', gitEmail || 'noreply@github.com'], { cwd: stageDir });
  run('git', ['add', '-A'], { cwd: stageDir });
  run('git', ['commit', '-m', `deploy(pages): publish live web bundle (${new Date().toISOString()})`], {
    cwd: stageDir,
  });
  run('git', ['push', '--force', remoteUrl, 'gh-pages:gh-pages'], { cwd: stageDir });
} finally {
  fs.rmSync(stageDir, { recursive: true, force: true });
}

console.log('[deploy:pages] Restoring root / build for full-stack server...');
run('npm', ['run', 'build', '--workspace=@gpui-telegram/web'], {
  env: { ...process.env, VITE_BASE_PATH: '/' },
});
console.log('[deploy:pages] Done!');
