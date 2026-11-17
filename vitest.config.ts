import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@gpui-telegram/protocol': path.resolve(rootDir, 'packages/protocol/src/index.ts'),
      '@gpui-telegram/server': path.resolve(rootDir, 'apps/server/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/e2e/**',
      '**/.test-tmp/**',
    ],
    maxWorkers: 2,
    minWorkers: 1,
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
