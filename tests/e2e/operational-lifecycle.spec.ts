import { test, expect } from '@playwright/test';

test.describe('End-to-End Operational Lifecycle Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test.skip('Journey 5: Table Status Mutation (Open Table -> Occupied)', async ({ page }) => {
    // 1. Login as Cashier (Cashier has cashier role required for tables/open)
    await page.fill('#loginEmail', 'cashier@liquor.com');
    await page.fill('#loginPass', 'Password@123');
    await page.click('button:has-text("Sign In")');

    // 2. Navigate to Tables & KOT view
    await page.click('#nav-tables');
    await expect(page.locator('#page-tables')).toBeVisible();

    // 3. Locate a free table tile (by name, so its locator survives the re-render)
    await expect(page.locator('.table-tile').first()).toBeVisible({ timeout: 10000 });
    const freeTile = page.locator('.table-tile.table-FREE').first();
    const name = await freeTile.getAttribute('data-table');
    const tile = page.locator(`.table-tile[data-table="${name}"]`);

    // 4. Click tile to open it
    await tile.click();
    await expect(tile.locator('span').first()).toHaveText('OCCUPIED', { timeout: 5000 });

    // 5. Clicking an occupied tile never closes it: it opens the actions dialog instead
    await tile.click();
    await expect(page.locator('#modal')).toBeVisible();
    await expect(page.locator('#tblActKot')).toBeVisible();
    await expect(page.locator('#tblActBill')).toBeVisible();
    await page.click('#tblActClose');
    // No KOTs on it, so a plain confirmation is enough; cancelling keeps the table occupied
    await expect(page.locator('#confirmOk')).toBeVisible();
    await page.click('#confirmCancel');
    await expect(page.locator('#modal')).toBeHidden();
    await expect(tile.locator('span').first()).toHaveText('OCCUPIED');
  });

  test.skip('Journey 6: Day Closing Reconciliation Submission (Owner/Manager role)', async ({ page }) => {
    // 1. Login as Owner (Owner has manager/owner rank required for POST /closing)
    await page.fill('#loginEmail', 'owner@liquor.com');
    await page.fill('#loginPass', 'Password@123');
    await page.click('button:has-text("Sign In")');

    // 2. Navigate to Day Closing view
    await page.click('#nav-closing');
    await expect(page.locator('#page-closing')).toBeVisible();

    // 3. Enter closing cash values
    await page.fill('#closingOpeningCash', '5000.00');
    await page.fill('#closingActualCash', '5000.00');
    await page.fill('#closingWithdrawals', '0.00');

    // Handle the browser alert dialog automatically
    page.once('dialog', dialog => dialog.accept());

    // 4. Click Submit Day Close button
    const submitBtn = page.locator('#btnSubmitClosing');
    await submitBtn.click();
    // Locking the day asks for an in-page confirmation first
    await expect(page.locator('#modalTitle')).toContainText('Close day');
    await page.click('#confirmOk');

    // 5. Verify database audit record status message rendered
    const statusMsg = page.locator('#closingStatusMsg');
    await expect(statusMsg).toContainText('Day Closed & Locked', { timeout: 10000 });
  });
});

