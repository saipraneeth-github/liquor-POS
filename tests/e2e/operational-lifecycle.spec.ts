import { test, expect } from '@playwright/test';

test.describe('End-to-End Operational Lifecycle Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('Journey 5: Table Status Mutation (Open Table -> Occupied)', async ({ page }) => {
    // 1. Login as Cashier (Cashier has cashier role required for tables/open)
    await page.fill('#loginEmail', 'cashier@liquor.com');
    await page.fill('#loginPass', 'Password@123');
    await page.click('button:has-text("Sign In")');

    // 2. Navigate to Tables & KOT view
    await page.click('#nav-tables');
    await expect(page.locator('#page-tables')).toBeVisible();

    // 3. Locate first table tile
    const firstTable = page.locator('.table-tile').first();
    await expect(firstTable).toBeVisible({ timeout: 10000 });

    const statusBadge = firstTable.locator('span').first();
    const initialStatus = await statusBadge.innerText();

    // 4. Click tile to toggle status
    await firstTable.click();

    // 5. Verify status badge updates
    await expect(async () => {
      const updatedStatus = await firstTable.locator('span').first().innerText();
      expect(updatedStatus).not.toBe(initialStatus);
    }).toPass({ timeout: 5000 });
  });

  test('Journey 6: Day Closing Reconciliation Submission (Owner/Manager role)', async ({ page }) => {
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

    // 5. Verify database audit record status message rendered
    const statusMsg = page.locator('#closingStatusMsg');
    await expect(statusMsg).toContainText('Day Closed & Locked', { timeout: 10000 });
  });
});

