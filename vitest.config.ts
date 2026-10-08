import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['packages/*/src/**/*.test.ts', 'tests/unit/**/*.test.ts', 'apps/server/src/**/*.test.ts'], testTimeout: 60_000 },
});
