import { test, expect } from '@playwright/test';

test.describe('Playwright Setup Verification', () => {
  test('evaluates in-browser context', async ({ page }) => {
    await page.setContent('<h1>Playwright Ready</h1>');
    const heading = page.locator('h1');
    await expect(heading).toHaveText('Playwright Ready');
  });
});

