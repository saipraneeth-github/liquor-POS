import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
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
      LEGACY_PREVIEW: '1',   // the original journeys drive preview.html at "/"; React specs use /login
      NODE_ENV: 'development',
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
