import { defineConfig, devices } from '@playwright/test';

// E2E runs against the production build (vite preview) plus a real game server on a scratch database.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:5374', viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'allow' },
  projects: [{ name: 'phone-chromium', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } }],
  webServer: [
    { command: 'pnpm --filter @capital/web build && pnpm --filter @capital/web exec vite preview --port 5374 --strictPort', url: 'http://localhost:5374', reuseExistingServer: false, timeout: 120_000, env: { CAPITAL_SERVER: 'http://localhost:8797' } },
    { command: 'pnpm --filter @capital/server start', url: 'http://localhost:8797/api/health', reuseExistingServer: false, timeout: 60_000, env: { PORT: '8797', DB_PATH: ':memory:', ALLOWED_ORIGINS: 'http://localhost:5374' } },
  ],
});
