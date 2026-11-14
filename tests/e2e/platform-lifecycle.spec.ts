/**
 * Super Admin: archive, restore, export and permanently delete a business.
 * Build the frontend first: `npm run build:frontend`. The e2e server runs with ARCHIVE_RETENTION_DAYS=0 so the
 * 30-day wait is skipped; the real wait is covered by tests/integration/platform-lifecycle.int.test.ts.
 */
import { test, expect, type Page } from '@playwright/test';
import { PASSWORD, uniq } from './helpers';

const stamp = uniq();
const tenantName = `Life Bar ${stamp}`;
const adminEmail = `life.${stamp.toLowerCase()}@tenant.test`;

async function loginSuper(page: Page) {
  await page.goto('/login');
  await page.fill('#loginEmail', 'superadmin@liquor.com');
  await page.fill('#loginPass', PASSWORD);
  await page.click('#loginBtn');
  await expect(page.locator('#page-platform')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#sidebarBranch')).toContainText('Platform HQ', { timeout: 20000 });
  await expect(page.locator('#platformKpis')).toBeVisible({ timeout: 20000 });
}

test('Archive, restore, export and delete a business', async ({ page }) => {
  await loginSuper(page);
  await page.click('#tenantAddBtn');
  await page.fill('#tenantName', tenantName);
  await page.fill('#tenantAdminName', 'Life Admin');
  await page.fill('#tenantAdminEmail', adminEmail);
  await page.fill('#tenantAdminPassword', 'Welcome#2026');
  await page.click('#tenantSaveBtn');
  const row = page.locator('.tenant-row', { hasText: tenantName });
  await expect(row).toBeVisible();

  // Archive needs a reason, then the business leaves the active list
  await row.locator('.tenant-archive').click();
  await page.click('#archiveOk');
  await expect(page.locator('#archiveForm')).toContainText('Say why');
  await page.fill('#archiveReason', 'Stopped trading');
  await page.click('#archiveOk');
  await expect(row).toHaveCount(0);

  // It shows under "Archived", with the reason, and only the archive actions
  await page.selectOption('#tenantStatusFilter', 'ARCHIVED');
  await expect(row).toBeVisible();
  await expect(row).toContainText('Archived');
  await expect(row).toContainText('Stopped trading');
  await expect(row.locator('.tenant-restore')).toBeVisible();
  await expect(row.getByRole('button', { name: 'Suspend' })).toHaveCount(0);

  // Restore brings it back
  await row.locator('.tenant-restore').click();
  await expect(row).toHaveCount(0);
  await page.selectOption('#tenantStatusFilter', 'ACTIVE');
  await expect(row).toBeVisible();
  await expect(row).not.toContainText('Archived');

  // Archive again, then delete: the button stays off until the name is typed and the warning ticked
  await row.locator('.tenant-archive').click();
  await page.fill('#archiveReason', 'Closing down for good');
  await page.click('#archiveOk');
  await page.selectOption('#tenantStatusFilter', 'ARCHIVED');
  await row.locator('.tenant-delete').click();
  await expect(page.locator('#deleteForm')).toContainText('This cannot be undone');
  await expect(page.locator('#exportBox')).toContainText('Download a copy before deleting');
  await expect(page.locator('#deleteOk')).toBeDisabled();
  await page.fill('#deleteConfirmName', 'Some other name');
  await page.check('#deleteAck');
  await expect(page.locator('#deleteOk')).toBeDisabled();                       // wrong name
  await page.fill('#deleteConfirmName', tenantName.toLowerCase());
  await expect(page.locator('#deleteOk')).toBeDisabled();                       // right name, wrong capitals
  await page.fill('#deleteConfirmName', tenantName);
  await page.uncheck('#deleteAck');
  await expect(page.locator('#deleteOk')).toBeDisabled();                       // not acknowledged

  // Download a copy first
  const downloading = page.waitForEvent('download');
  await page.click('#exportData');
  expect((await downloading).suggestedFilename()).toMatch(/Life-Bar-.*-export-\d{4}-\d{2}-\d{2}\.json$/);
  await expect(page.locator('#exportBox')).toContainText('Data downloaded');

  await page.check('#deleteAck');
  await expect(page.locator('#deleteOk')).toBeEnabled();
  await page.click('#deleteOk');
  await expect(page.locator('#deleteForm')).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await page.selectOption('#tenantStatusFilter', 'ALL');
  await expect(row).toHaveCount(0);                                              // gone from every view

  // The audit log remembers it
  await page.click('#nav-platform-audit');
  await page.selectOption('#auAction', 'tenant.delete');
  await expect(page.locator('[data-audit-row="tenant.delete"]').first()).toBeVisible();
});

test('Tenants: on a phone the table becomes cards with the actions folded away', async ({ page }) => {
  await loginSuper(page);
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(page.locator('#tenantCards')).toBeVisible();
  await expect(page.locator('#tenantTable')).toBeHidden();
  const card = page.locator('.tenant-card').first();
  await expect(card).toBeVisible();
  await card.locator('summary').click();
  await expect(card.getByRole('button', { name: 'Change plan' })).toBeVisible();
});
