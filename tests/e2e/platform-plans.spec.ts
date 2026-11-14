/**
 * Super Admin: the plan catalog, and moving a business to another plan with a preview.
 * Build the frontend first: `npm run build:frontend`.
 */
import { test, expect, type Page } from '@playwright/test';
import { PASSWORD, uniq } from './helpers';

const stamp = uniq();
const planName = `Gold ${stamp}`;
const tenantName = `Plan Bar ${stamp}`;

async function loginSuper(page: Page) {
  await page.goto('/login');
  await page.fill('#loginEmail', 'superadmin@liquor.com');
  await page.fill('#loginPass', PASSWORD);
  await page.click('#loginBtn');
  await expect(page.locator('#page-platform')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#sidebarBranch')).toContainText('Platform HQ', { timeout: 20000 });
  await expect(page.locator('#platformKpis')).toBeVisible({ timeout: 20000 });
}

test('Plans: create, edit and retire a plan; use it for a business; preview, apply, schedule and cancel a change', async ({ page }) => {
  await loginSuper(page);

  // The three original plans are there, with their prices
  await page.click('#nav-platform-plans');
  await expect(page.locator('#platformPlansTitle')).toBeVisible();
  for (const code of ['TRIAL', 'STANDARD', 'PRO']) await expect(page.locator(`[data-plan="${code}"]`)).toBeVisible();
  await expect(page.locator('[data-plan="STANDARD"]')).toContainText('2,999');
  await expect(page.locator('[data-plan="TRIAL"] [data-action="retire"]')).toHaveCount(0);   // the trial cannot be retired

  // Create a plan: the form says what is wrong next to the field
  await page.click('#planAdd');
  await page.fill('#planName', 'ab');
  await page.fill('#planPrice', '0');
  await page.click('#planSave');
  await expect(page.locator('#planForm')).toContainText('Use at least 3 characters');
  await expect(page.locator('#planForm')).toContainText('A paid plan needs a price above zero');
  await page.fill('#planName', planName);
  await page.fill('#planPrice', '4500');
  await page.selectOption('#planCycle', '90');
  await page.fill('#planBranches', '4');
  await page.fill('#planFeatures', 'Four branches\nBank reconciliation');
  await page.click('#planSave');
  const card = page.locator('[data-plan]', { hasText: planName });
  await expect(card).toBeVisible();
  await expect(card).toContainText('4,500');
  await expect(card).toContainText('quarter');
  await expect(card).toContainText('Up to 4 branches');
  await expect(card).toContainText('Bank reconciliation');
  await expect(card).toContainText('0 businesses on it');

  // Edit it
  await card.locator('[data-action="edit"]').click();
  await page.fill('#planPrice', '4800');
  await page.click('#planSave');
  await expect(card).toContainText('4,800');

  // Use it: it is offered when creating a business
  await page.click('#nav-platform');
  await expect(page.locator('#platformKpis')).toBeVisible();
  await page.click('#tenantAddBtn');
  await page.fill('#tenantName', tenantName);
  await page.selectOption('#tenantPlan', { label: `${planName} — 4 branches` });
  await page.fill('#tenantAdminName', 'Plan Admin');
  await page.fill('#tenantAdminEmail', `plans.${stamp.toLowerCase()}@tenant.test`);
  await page.fill('#tenantAdminPassword', 'Welcome#2026');
  await page.click('#tenantSaveBtn');
  const row = page.locator('.tenant-row', { hasText: tenantName });
  await expect(row).toContainText(planName);
  await expect(page.locator('#platformPlans')).toContainText(planName);       // and the dashboard's plan mix counts it

  // Change plan: the cost is shown first, and nothing happens until it is confirmed
  await row.locator('.tenant-change-plan').click();
  await page.selectOption('#cpPlan', 'STANDARD');
  await expect(page.locator('#cpPreview')).toContainText('Due now');
  await expect(page.locator('#cpPreview')).toContainText('2,999.00');
  await expect(page.locator('#cpPreview')).toContainText('no credit');        // the courtesy period was never paid for
  await expect(page.locator('#cpConfirm')).toContainText('Change plan now');
  await page.click('#cpConfirm');
  await expect(row).toContainText('Standard');

  // Schedule a change for later: the table says so, and it can be cancelled
  await row.locator('.tenant-change-plan').click();
  await page.selectOption('#cpPlan', { label: planName });
  const later = new Date(Date.now() + 330 * 60_000 + 10 * 86_400_000).toISOString().slice(0, 10);
  await page.fill('#cpDate', later);
  await expect(page.locator('#cpPreview')).toContainText('Due when it starts');
  await expect(page.locator('#cpConfirm')).toContainText('Schedule for');
  await page.click('#cpConfirm');
  await expect(row.locator('.tenant-scheduled')).toContainText(planName);
  await expect(row).toContainText('Standard');                                  // still on Standard until the day

  await row.locator('.tenant-change-plan').click();
  await expect(page.locator('#scheduledNote')).toContainText(planName);
  await page.click('#cpCancelScheduled');
  await expect(row.locator('.tenant-scheduled')).toHaveCount(0);

  // A bad date is explained, not silently accepted
  await row.locator('.tenant-change-plan').click();
  await page.selectOption('#cpPlan', 'PRO');
  const far = new Date(Date.now() + 330 * 60_000 + 120 * 86_400_000).toISOString().slice(0, 10);
  await page.evaluate((v) => { const el = document.querySelector('#cpDate') as HTMLInputElement; el.removeAttribute('max'); void v; }, far);
  await page.fill('#cpDate', far);
  await expect(page.locator('#cpError')).toContainText('at most 90 days');
  await expect(page.locator('#cpConfirm')).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();

  // Retire the plan: it disappears from the choices but stays on the list, and can come back
  await page.click('#nav-platform-plans');
  await card.locator('[data-action="retire"]').click();
  await page.click('#planRetireOk');
  await expect(card).toContainText('Retired');
  await page.click('#nav-platform');
  await page.click('#tenantAddBtn');
  await expect(page.locator('#tenantPlan')).not.toContainText(planName);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.click('#nav-platform-plans');
  await card.locator('[data-action="reactivate"]').click();
  await expect(card).toContainText('On sale');
});

test('Plans: on a phone the cards stack, and only the Super Admin sees the page', async ({ page }) => {
  await loginSuper(page);
  await page.click('#nav-platform-plans');
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(page.locator('[data-plan="STANDARD"]')).toBeVisible();
  const grid = await page.locator('#planGrid').boundingBox();
  expect(grid!.width).toBeLessThanOrEqual(390);

  await page.evaluate(() => localStorage.clear());
  await page.goto('/login');
  await page.fill('#loginEmail', 'manager@liquor.com');
  await page.fill('#loginPass', PASSWORD);
  await page.click('#loginBtn');
  await expect(page.locator('#mainApp')).toBeVisible({ timeout: 15000 });
  await page.goto('/platform/plans');
  await expect(page.locator('#page-platform-plans')).toHaveCount(0);
});
