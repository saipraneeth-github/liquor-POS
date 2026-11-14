// Runs the project's existing e2e specs through the Vite dev server on 5173 (which proxies /api to 3001).
// Start the stack first:  node docs/db-optimization/scripts/start-test-stack.mjs
// Run:  npx playwright test -c docs/db-optimization/scripts/playwright.5173.config.ts
import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: '../../../tests/e2e',
  fullyParallel: true,
  workers: 2,
  expect: { timeout: 15_000 },
  timeout: 90_000,
  reporter: [['list'], ['json', { outputFile: '../results/e2e-5173.json' }]],
  use: { baseURL: 'http://localhost:5173', trace: 'off', screenshot: 'only-on-failure' },
  outputDir: '../results/e2e-artifacts',
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // deliberately NO webServer: it must never start (or reuse) a server pointed at a real database
});
