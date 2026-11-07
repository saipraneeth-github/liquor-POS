import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // One server process (with CPU-heavy password hashing) serves every worker, so more workers only make each run slower.
  workers: process.env.CI ? 1 : 3,
  expect: { timeout: 10_000 },
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3001',
    trace: 'on-first-retry',
  },
  // Fresh embedded PGlite database per run (migrated + seeded by src/dev-local.ts) â€” no Postgres install needed.
  // Set E2E_DATABASE_URL to run against a real database instead.
  webServer: {
    command: 'node -e "require(\'fs\').rmSync(\'.pglite-e2e\',{recursive:true,force:true})" && node --import tsx src/dev-local.ts',
    url: 'http://localhost:3001/health',
    reuseExistingServer: !process.env.CI,
    timeout: 180000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      DATABASE_URL: process.env.E2E_DATABASE_URL ?? 'pglite://./.pglite-e2e',
      PORT: '3001',
      NODE_ENV: 'development',
      SEED_DEMO_STOCK: 'true',
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
