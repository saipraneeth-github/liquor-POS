import { test, expect, type Page } from '@playwright/test';
import { PASSWORD, uniq } from './helpers';

const stamp = uniq();

async function loginSuper(page: Page) {
  await page.goto('/login');
  await page.fill('#loginEmail', 'superadmin@liquor.com');
  await page.fill('#loginPass', PASSWORD);
  await page.click('#loginBtn');
  await expect(page.locator('#page-platform')).toBeVisible({ timeout: 15000 });
  // The app remounts the page once when the Super Admin's default branch finishes loading (Layout keys the page on the
  // active branch). Let that happen first, or a modal opened in the meantime disappears.
  await expect(page.locator('header select').first()).toContainText('MAIN-01', { timeout: 20000 });
  await expect(page.locator('#platformKpis')).toBeVisible({ timeout: 20000 });
}

test('Super Admin dashboard: figures, action queue filters the tenant table, and clears again', async ({ page }) => {
  const name = `Dash Bar ${stamp}`;
  await loginSuper(page);
  await expect(page.locator('#platformKpis')).toContainText('Monthly recurring revenue');
  await expect(page.locator('#platformRevenue')).toBeVisible();
  await expect(page.locator('#platformPlans')).toContainText('Standard');

  // create a trial, then suspend it so it lands in the Suspended list
  await page.click('#tenantAddBtn');
  await page.fill('#tenantName', name);
  await page.fill('#tenantAdminName', 'Dash Admin');
  await page.fill('#tenantAdminEmail', `dash.${stamp.toLowerCase()}@tenant.test`);
  await page.fill('#tenantAdminPassword', 'Welcome#2026');
  await page.click('#tenantSaveBtn');
  const row = page.locator('.tenant-row', { hasText: name });
  await expect(row).toBeVisible();
  await expect(row.locator('.tenant-health')).toBeVisible();

  await row.getByRole('button', { name: 'Suspend' }).click();
  await page.click('#tenantSuspendOk');
  await expect(page.locator('[data-queue="suspended"]')).toBeEnabled();

  await page.click('[data-queue="suspended"]');
  await expect(page.locator('#queueFilterNote')).toContainText('suspended');
  await expect(page.locator('.tenant-row', { hasText: name })).toBeVisible();
  const filtered = await page.locator('.tenant-row').count();

  await page.click('#queueFilterClear');
  await expect(page.locator('#queueFilterNote')).toHaveCount(0);
  expect(await page.locator('.tenant-row').count()).toBeGreaterThanOrEqual(filtered);

  // search also finds a business by its owner's e-mail
  await page.fill('#tenantSearch', `dash.${stamp.toLowerCase()}@tenant`);
  await expect(page.locator('.tenant-row')).toHaveCount(1);
});
