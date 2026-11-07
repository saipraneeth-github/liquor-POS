import { test, expect, type Page } from '@playwright/test';
import { PASSWORD } from './helpers';

async function login(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.goto('/login');
  await page.fill('#loginEmail', email);
  await page.fill('#loginPass', password);
  await page.click('#loginBtn');
}

test('login: shows server status, reveals the password, and says how many tries are left', async ({ page }) => {
  await page.goto('/login');
  await expect(page.locator('#loginServerStatus')).toContainText(/reachable/i, { timeout: 15000 });
  await page.fill('#loginPass', 'secret-value');
  await expect(page.locator('#loginPass')).toHaveAttribute('type', 'password');
  await page.click('#loginShowPw');
  await expect(page.locator('#loginPass')).toHaveAttribute('type', 'text');

  await login(page, 'manager@liquor.com', 'definitely-wrong');
  await expect(page.locator('#loginError')).toContainText(/tries? left/i);
});

test('manager dashboard: figures, attention strip and New bill shortcut', async ({ page }) => {
  await login(page, 'manager@liquor.com');
  await expect(page.locator('#page-dashboard')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#dashSales')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#dashAttention')).toBeVisible();
  await expect(page.locator('#dashLoading')).toHaveCount(0);
  await page.click('#dashNewBill');
  await expect(page).toHaveURL(/\/pos$/);
});

test('owner dashboard: all-outlets view and switch to a single outlet', async ({ page }) => {
  await login(page, 'owner@liquor.com');
  const toggle = page.locator('#dashScope-all');
  // A syndicate owner may first be asked to pick a branch; the toggle appears once on the dashboard.
  await expect(toggle).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#dashTitle')).toContainText('All outlets');
  await page.click('#dashScope-branch');
  await expect(page.locator('#dashNewBill')).toBeVisible();
});
