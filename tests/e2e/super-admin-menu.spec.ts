/**
 * The Super Admin runs the software for other businesses: only Platform screens, never a shop's billing, stock or books.
 * Build the frontend first: `npm run build:frontend`.
 */
import { test, expect } from '@playwright/test';
import { login } from './helpers';

test('Super Admin sees only the Platform menus and cannot open a shop screen', async ({ page }) => {
  await login(page, 'superadmin@liquor.com');
  await expect(page).toHaveURL(/\/platform/);
  for (const id of ['nav-platform', 'nav-platform-users', 'nav-platform-plans', 'nav-platform-branches', 'nav-platform-roles', 'nav-platform-audit']) {
    await expect(page.locator(`#${id}`)).toBeVisible();
  }
  for (const id of ['nav-pos', 'nav-shift', 'nav-bills', 'nav-tables', 'nav-products', 'nav-counter', 'nav-accounting', 'nav-bank', 'nav-closing', 'nav-dashboard']) {
    await expect(page.locator(`#${id}`)).toHaveCount(0);
  }
  await expect(page.locator('#sidebarBranch')).toContainText('Platform HQ');
  // a shop address sends the Super Admin back to the console
  await page.goto('/pos');
  await expect(page).toHaveURL(/\/platform/);
  await expect(page.getByRole('heading', { name: 'Platform Console' })).toBeVisible();
});

test('A business owner still sees the shop menus and no Platform menus', async ({ page }) => {
  await login(page, 'owner@liquor.com');
  await expect(page.locator('#nav-pos')).toBeVisible();
  await expect(page.locator('#nav-platform')).toHaveCount(0);
});
