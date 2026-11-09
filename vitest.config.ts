import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    conditions: ['@mindly/source'],
  },
  ssr: {
    resolve: {
      conditions: ['@mindly/source'],
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    // One temp folder per run, removed at the end (see the file).
    globalSetup: ['./vitest.global-setup.ts'],
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'apps/*/src/**'],
    },
  },
});
