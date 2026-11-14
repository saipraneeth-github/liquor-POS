/**
 * Super Admin: branches across every business, and switching a feature off for one branch.
 * Build the frontend first: `npm run build:frontend`.
 * The test puts everything back at the end, so later specs still find the feature on.
 */
import { test, expect, type Page } from '@playwright/test';
import { PASSWORD } from './helpers';

async function loginSuper(page: Page) {
  await page.goto('/login');
  await page.fill('#loginEmail', 'superadmin@liquor.com');
  await page.fill('#loginPass', PASSWORD);
  await page.click('#loginBtn');
  await expect(page.locator('#page-platform')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#sidebarBranch')).toContainText('Platform HQ', { timeout: 20000 });
  await expect(page.locator('#platformKpis')).toBeVisible({ timeout: 20000 });
}

async function loginManager(page: Page) {
  await page.goto('/login');
  await page.fill('#loginEmail', 'manager@liquor.com');
  await page.fill('#loginPass', PASSWORD);
  await page.click('#loginBtn');
  await expect(page.locator('#mainApp')).toBeVisible({ timeout: 15000 });
}

async function openBranch(page: Page) {
  await page.fill('#pbSearch', 'MAIN-01');
  const row = page.locator('[data-branch-row="MAIN-01"]');
  await expect(row).toBeVisible();
  await row.locator('[data-action="manage"]').click();
  await expect(page.locator('#bdFeatures')).toBeVisible();
  return row;
}

test('Switch a feature off for one branch: the branch loses the page, and gets it back when it is switched on', async ({ page, browser }) => {
  test.setTimeout(120_000);   // two sign-ins, a save, a second browser, and putting it all back
  await loginSuper(page);
  await page.click('#nav-platform-branches');
  await expect(page.locator('#platformBranchesTitle')).toBeVisible();
  await expect(page.locator('#pbTable tbody tr').first()).toBeVisible();

  // find the demo branch and open it: who works there, and the eight switches
  const row = await openBranch(page);
  await expect(page.locator('#bdPeople')).toContainText('manager@liquor.com');
  await expect(page.locator('#bdFeatures [data-feature]')).toHaveCount(8);
  await expect(page.locator('[data-switch="bank"]')).toBeChecked();

  // changes are shown as unsaved until saved, and can be reverted
  await page.uncheck('[data-switch="bank"]');
  await page.uncheck('[data-switch="schemes"]');
  await expect(page.locator('#branchDrawer')).toContainText('2 unsaved changes');
  await page.click('#bdRevert');
  await expect(page.locator('[data-switch="bank"]')).toBeChecked();
  await expect(page.locator('#bdSave')).toBeDisabled();

  try {
    await page.uncheck('[data-switch="bank"]');
    await page.click('#bdSave');
    await expect(page.locator('[data-feature="bank"]')).toContainText('Switched off');
    await expect(page.locator('[data-feature="bank"]')).toContainText('Platform Owner');         // who did it
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.locator('#branchDrawer')).toHaveCount(0);

    // the list shows it, and can find branches with a feature off
    await page.fill('#pbSearch', '');
    await page.selectOption('#pbFeatureOff', 'bank');
    await expect(row).toContainText('1 off');
    await expect(page.locator('#pbTable tbody tr').first()).toBeVisible();

    // a manager of that branch no longer sees the page, and cannot open it
    const ctx = await browser.newContext();
    const mgr = await ctx.newPage();
    await loginManager(mgr);
    await expect(mgr.locator('#nav-accounting')).toBeVisible();                                    // other pages are still there
    await expect(mgr.locator('#nav-bank')).toHaveCount(0);
    await mgr.goto('/bank');
    await expect(mgr.locator('#mainApp')).toBeVisible();
    await expect(mgr).not.toHaveURL(/\/bank$/);
    const status = await mgr.evaluate(async () => {
      const t = localStorage.getItem('token');
      const b = await (await fetch('/api/v1/branches', { headers: { Authorization: `Bearer ${t}` } })).json();
      const r = await fetch(`/api/v1/bank/accounts?branchId=${b[0].id}`, { headers: { Authorization: `Bearer ${t}` } });
      return { status: r.status, body: await r.json() };
    });
    expect(status.status).toBe(403);
    expect(status.body.code).toBe('FEATURE_DISABLED');
    await ctx.close();
  } finally {
    // put it back, whatever happened above
    await page.goto('/platform/branches');
    await page.fill('#pbSearch', 'MAIN-01');
    await page.locator('[data-branch-row="MAIN-01"] [data-action="manage"]').click();
    const sw = page.locator('[data-switch="bank"]');
    await expect(sw).toBeVisible();
    if (!(await sw.isChecked())) {
      await sw.check();
      await page.click('#bdSave');
      await expect(page.locator('[data-feature="bank"]')).not.toContainText('Switched off');
    }
  }

  // back on: the manager has the page again
  const ctx2 = await browser.newContext();
  const mgr2 = await ctx2.newPage();
  await loginManager(mgr2);
  await expect(mgr2.locator('#nav-bank')).toBeVisible();
  await ctx2.close();
});

test('Branches: filters, empty state, and cards on a phone', async ({ page }) => {
  await loginSuper(page);
  await page.click('#nav-platform-branches');
  await expect(page.locator('#pbTable tbody tr').first()).toBeVisible();
  await page.fill('#pbSearch', 'no-such-branch-anywhere');
  await expect(page.locator('#pbEmpty')).toContainText('No branches match');
  await page.click('#pbClear');
  await expect(page.locator('#pbTable tbody tr').first()).toBeVisible();

  await page.setViewportSize({ width: 390, height: 800 });
  await expect(page.locator('#pbCards')).toBeVisible();
  await expect(page.locator('#pbTable')).toBeHidden();
});
