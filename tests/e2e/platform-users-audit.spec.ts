/**
 * Super Admin: Users across every business, and the Audit log.
 * Build the frontend first: `npm run build:frontend`.
 */
import { test, expect, type Page } from '@playwright/test';
import { PASSWORD, uniq } from './helpers';

test.describe.configure({ mode: 'serial' });   // the audit test reads what the users test just did

const stamp = uniq();
const adminEmail = `uaudit.${stamp.toLowerCase()}@tenant.test`;
const tenantName = `Audit Bar ${stamp}`;

async function loginSuper(page: Page) {
  await page.goto('/login');
  await page.fill('#loginEmail', 'superadmin@liquor.com');
  await page.fill('#loginPass', PASSWORD);
  await page.click('#loginBtn');
  await expect(page.locator('#page-platform')).toBeVisible({ timeout: 15000 });
  // the page remounts once when the default branch finishes loading; wait for that before doing anything
  await expect(page.locator('#sidebarBranch')).toContainText('Platform HQ', { timeout: 20000 });
  await expect(page.locator('#platformKpis')).toBeVisible({ timeout: 20000 });
}

test('Users: find a person in any business, give a temporary password, switch the account off and on', async ({ page }) => {
  await loginSuper(page);
  await page.click('#tenantAddBtn');
  await page.fill('#tenantName', tenantName);
  await page.fill('#tenantAdminName', 'Audit Admin');
  await page.fill('#tenantAdminEmail', adminEmail);
  await page.fill('#tenantAdminPassword', 'Welcome#2026');
  await page.click('#tenantSaveBtn');
  await expect(page.locator('.tenant-row', { hasText: tenantName })).toBeVisible();

  await page.click('#nav-platform-users');
  await expect(page.locator('#platformUsersTitle')).toBeVisible();
  await page.fill('#puSearch', adminEmail);
  const row = page.locator(`[data-user-row="${adminEmail}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText(tenantName);
  await expect(row).toContainText('Never');                      // has not signed in yet
  await expect(page.locator('[data-user-row]')).toHaveCount(1);

  await row.locator('[data-action="reset"]').click();
  await expect(page.locator('#puTempPassword')).not.toBeEmpty();
  await page.getByRole('button', { name: 'Done' }).click();

  await row.locator('[data-action="deactivate"]').click();
  await page.click('#puDeactivateOk');
  await expect(row).toContainText('Inactive');
  await row.locator('[data-action="activate"]').click();
  await expect(row).toContainText('Active');

  // filters: nothing matches a nonsense search, and clearing brings the list back
  await page.fill('#puSearch', 'nobody-has-this-name');
  await expect(page.locator('#puEmpty')).toContainText('No users match');
  await page.click('#puClear');
  await expect(page.locator('#puTable tbody tr').first()).toBeVisible();

  // the platform owner cannot be switched off from here
  await page.fill('#puSearch', 'superadmin@liquor.com');
  await expect(page.locator('[data-user-row="superadmin@liquor.com"]')).toContainText('Platform owner');
  await expect(page.locator('[data-user-row="superadmin@liquor.com"] [data-action]')).toHaveCount(0);

  // on a phone the table becomes cards
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(page.locator('#puCards')).toBeVisible();
  await expect(page.locator('#puTable')).toBeHidden();
});

test('Audit log: filter by action and business, open an event to see before and after, export to CSV', async ({ page }) => {
  await loginSuper(page);
  // make something to look at: switch the new business to Standard with a limit
  await page.click('#nav-platform-audit');
  await expect(page.locator('#platformAuditTitle')).toBeVisible();
  await expect(page.locator('#auTable tbody tr').first()).toBeVisible();

  await page.selectOption('#auAction', 'user.deactivate');
  const rows = page.locator('[data-audit-row="user.deactivate"]');
  await expect(rows.first()).toBeVisible();
  await rows.first().click();
  const detail = page.locator('[data-audit-detail]').first();
  await expect(detail).toContainText('Before');
  await expect(detail).toContainText('After');
  await expect(detail).toContainText('isActive');

  await page.selectOption('#auTenant', { label: tenantName });
  await expect(rows.first()).toBeVisible();
  await expect(page.locator('#auTable tbody tr[data-audit-row]').first()).toContainText(tenantName);

  const downloading = page.waitForEvent('download');
  await page.click('#auExport');
  expect((await downloading).suggestedFilename()).toMatch(/^audit-log-\d{4}-\d{2}-\d{2}\.csv$/);

  await page.fill('#auActor', 'nobody-by-this-name');
  await expect(page.locator('#auEmpty')).toContainText('No events match');
  await page.click('#auClear');
  await expect(page.locator('#auTable tbody tr').first()).toBeVisible();
});

test('only the Super Admin sees these pages', async ({ page }) => {
  await page.goto('/login');
  await page.fill('#loginEmail', 'manager@liquor.com');
  await page.fill('#loginPass', PASSWORD);
  await page.click('#loginBtn');
  await expect(page.locator('#mainApp')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#nav-platform-users')).toHaveCount(0);
  await page.goto('/platform/users');
  await expect(page.locator('#page-platform-users')).toHaveCount(0);
  await page.goto('/platform/audit');
  await expect(page.locator('#page-platform-audit')).toHaveCount(0);
});
