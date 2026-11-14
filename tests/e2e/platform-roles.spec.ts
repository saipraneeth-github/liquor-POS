/**
 * Super Admin: roles and permissions. Create a custom role, give it to a person, see it take effect, retire it.
 * Build the frontend first: `npm run build:frontend`.
 * The test puts the cashier back on the built-in Cashier role at the end, so later specs find them unchanged.
 */
import { test, expect, type Page } from '@playwright/test';
import { PASSWORD, uniq } from './helpers';

const stamp = uniq();
const roleName = `Counter Lead ${stamp}`;

async function loginSuper(page: Page) {
  await page.goto('/login');
  await page.fill('#loginEmail', 'superadmin@liquor.com');
  await page.fill('#loginPass', PASSWORD);
  await page.click('#loginBtn');
  await expect(page.locator('#page-platform')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#sidebarBranch')).toContainText('Platform HQ', { timeout: 20000 });
  await expect(page.locator('#platformKpis')).toBeVisible({ timeout: 20000 });
}

async function changeRoleOf(page: Page, email: string, label: string | RegExp) {
  await page.click('#nav-platform-users');
  await page.fill('#puSearch', email);
  const row = page.locator(`[data-user-row="${email}"]`);
  await expect(row).toBeVisible();
  await row.locator('[data-action="role"]').click();
  await page.selectOption('#pickRole', { label });
  await page.click('#saveRole');
  await expect(page.locator('#changeRoleForm')).toHaveCount(0);
  return row;
}

test('Roles: built-in roles are fixed; create one, give it to a cashier, see it work, retire it', async ({ page, browser }) => {
  test.setTimeout(150_000);
  await loginSuper(page);
  await page.click('#nav-platform-roles');
  await expect(page.locator('#platformRolesTitle')).toBeVisible();

  // The five built-in roles, locked. Owner cannot be restricted; a manager has everything by default; a cashier nothing extra
  for (const key of ['owner', 'office_admin', 'manager', 'cashier', 'steward']) await expect(page.locator(`[data-role="${key}"]`)).toBeVisible();
  await page.click('[data-role="owner"]');
  await expect(page.locator('#roleLocked')).toContainText('Cannot be restricted');
  await expect(page.locator('[data-permission="bills.void"]')).toBeDisabled();
  await expect(page.locator('[data-permission="bills.void"]')).toBeChecked();
  await page.click('[data-role="cashier"]');
  await expect(page.locator('[data-permission="bills.void"]')).not.toBeChecked();
  await expect(page.locator('#roleLocked')).toContainText('duplicate it');
  await expect(page.locator('#roleSave')).toHaveCount(0);

  // New role: the form says what is wrong
  await page.click('#roleNew');
  await page.fill('#roleName', 'ab');
  await page.click('#roleSave');
  await expect(page.locator('#roleEditor')).toContainText('Use at least 3 characters');
  await page.fill('#roleName', roleName);
  await page.selectOption('#roleLevel', 'cashier');
  await page.check('[data-permission="invoices.approve"]');
  await expect(page.locator('#roleApproveWarn')).toContainText('See cost prices');
  await page.click('#roleSave');                                                  // blocked until fixed
  await expect(page.locator('#roleSave')).toBeVisible();
  await page.uncheck('[data-permission="invoices.approve"]');
  await page.click('[data-all="billing"]');                                       // the Billing group: "void bills"
  await expect(page.locator('[data-permission="bills.void"]')).toBeChecked();
  await page.click('#roleMenuOwn');
  await page.check('[data-page="pos"]');
  await page.check('[data-page="bills"]');
  await page.click('#roleSave');
  const item = page.locator('[data-role]', { hasText: roleName });
  await expect(item).toBeVisible();
  await expect(item).toContainText('1 of 12 permissions');
  await expect(page.locator('#roleEditor')).toContainText('0 people have this role');

  // Edit: add a permission with the group switch, then revert it, then save it
  await page.check('[data-permission="discount.unlimited"]');
  await expect(page.locator('#roleEditor')).toContainText('Unsaved changes');
  await page.click('#roleRevert');
  await expect(page.locator('[data-permission="discount.unlimited"]')).not.toBeChecked();
  await page.check('[data-permission="discount.unlimited"]');
  await page.click('#roleSave');
  await expect(item).toContainText('2 of 12 permissions');

  // Duplicating the built-in manager starts from everything a manager has
  await page.click('[data-role="manager"]');
  await page.click('#roleDuplicate');
  await expect(page.locator('#roleName')).toHaveValue('Manager copy');
  await expect(page.locator('[data-permission="cost.view"]')).toBeChecked();
  await expect(page.locator('[data-permission="bills.void"]')).toBeChecked();
  await page.click(`[data-role]:has-text("${roleName}")`);                         // leave it unsaved

  try {
    // Give it to the demo cashier, and see it take effect
    const row = await changeRoleOf(page, 'cashier@liquor.com', roleName);
    await expect(row.locator('[data-cell="role"]')).toContainText(roleName);

    const ctx = await browser.newContext();
    const cashier = await ctx.newPage();
    await cashier.goto('/login');
    await cashier.fill('#loginEmail', 'cashier@liquor.com');
    await cashier.fill('#loginPass', PASSWORD);
    await cashier.click('#loginBtn');
    await expect(cashier.locator('#mainApp')).toBeVisible({ timeout: 15000 });
    const mine = await cashier.evaluate(async () => (await fetch('/api/v1/me', { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } })).json());
    expect(mine.role).toBe('cashier');
    expect(mine.roleName).toContain('Counter Lead');
    expect(mine.permissions['bills.void']).toBe(true);
    expect(mine.permissions['cost.view']).toBe(false);
    expect(mine.discountCapPct).toBeNull();                                                      // "discount above 5%" was granted
    expect(mine.pages.find((p: { routePath: string }) => p.routePath === 'pos').canAccess).toBe(true);
    expect(mine.pages.find((p: { routePath: string }) => p.routePath === 'bank').canAccess).toBe(false);
    await expect(cashier.locator('#nav-pos')).toBeVisible();                                      // and the menu follows the role
    await ctx.close();

    // Retire it: the person keeps it, nobody new can get it
    await page.click('#nav-platform-roles');
    await page.click(`[data-role]:has-text("${roleName}")`);
    await page.click('#roleRetire');
    await expect(page.locator('#roleEditor')).toContainText('Retired');
    await expect(page.locator('#roleEditor')).toContainText('1 person has this role');
    await page.click('#nav-platform-users');
    await page.fill('#puSearch', 'steward@liquor.com');
    await page.locator('[data-user-row="steward@liquor.com"] [data-action="role"]').click();
    await expect(page.locator('#pickRole')).not.toContainText(roleName);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.click('#nav-platform-roles');
    await page.click(`[data-role]:has-text("${roleName}")`);
    await page.click('#roleReactivate');
    await expect(page.locator('#roleEditor')).toContainText('Custom');
  } finally {
    // put the cashier back on the built-in role, whatever happened above
    await changeRoleOf(page, 'cashier@liquor.com', 'Cashier (built-in)');
  }
  await expect(page.locator('[data-user-row="cashier@liquor.com"] [data-cell="role"]')).toContainText('Cashier');
});

test('Roles: on a phone the list is a picker and the permission groups fold; only the Super Admin sees the page', async ({ page }) => {
  await loginSuper(page);
  await page.click('#nav-platform-roles');
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(page.locator('#roleSelect')).toBeVisible();
  await expect(page.locator('#roleList')).toBeHidden();
  await page.selectOption('#roleSelect', { label: 'Manager' });
  await expect(page.locator('#roleEditor')).toContainText('Manager');
  await page.locator('[data-group="costs"] summary').click();                                   // a group folds shut
  await expect(page.locator('[data-group="costs"]')).not.toHaveAttribute('open', '');

  await page.evaluate(() => localStorage.clear());
  await page.goto('/login');
  await page.fill('#loginEmail', 'manager@liquor.com');
  await page.fill('#loginPass', PASSWORD);
  await page.click('#loginBtn');
  await expect(page.locator('#mainApp')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#nav-platform-roles')).toHaveCount(0);
  await page.goto('/platform/roles');
  await expect(page.locator('#page-platform-roles')).toHaveCount(0);
});
