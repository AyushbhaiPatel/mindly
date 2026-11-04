import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    conditions: ['@synapse/source'],
  },
  ssr: {
    resolve: {
      conditions: ['@synapse/source'],
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'apps/*/src/**'],
    },
  },
});
