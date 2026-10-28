import { test, expect } from '@playwright/test';
import { addProduct, checkoutAndGetBillNo, login } from './helpers';

test.skip('accounting: trial balance is balanced after sales; P&L and Tally export work', async ({ page }) => {
  await login(page, 'manager@liquor.com');
  await addProduct(page, 'Royal Challenge');
  await checkoutAndGetBillNo(page);

  await page.click('#nav-accounting');
  await expect(page.locator('#acctab-tb')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#tbStatus')).toContainText('Balanced ✓');
  const dr = await page.locator('#tbDebit').innerText();
  const cr = await page.locator('#tbCredit').innerText();
  expect(dr).toBe(cr);
  expect(dr).not.toBe('₹0.00');

  await page.click('#acctab-pl');
  await expect(page.locator('#plNet')).toBeVisible();

  await page.click('#acctab-bs');
  await expect(page.locator('#bsStatus')).toContainText('Balanced');

  await page.click('#acctab-tally');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#tallyDownloadBtn')]);
  expect(download.suggestedFilename()).toMatch(/\.xml$/);
  await expect(page.locator('#tallyResult')).toContainText('Downloaded');
});

test.skip('role gating: steward cannot see accounting or billing; cashier cannot open manager screens', async ({ page }) => {
  await login(page, 'steward@liquor.com');
  await expect(page.locator('#userDisplay')).toContainText('steward');
  await expect(page.locator('#nav-dashboard')).toBeVisible();
  for (const tab of ['accounting', 'pos', 'bills', 'closing', 'admin', 'schemes']) {
    await expect(page.locator(`#nav-${tab}`)).toHaveCount(0);
  }
  // Forcing navigation is refused with a visible message and the page stays hidden
  await page.goto('/accounting');
  await expect(page.locator('#toastHost')).toContainText('cannot open Accounting');
  await expect(page.locator('#page-accounting')).toBeHidden();

  // Stewards do table service: Tables & KOT is reachable and lists the branch tables
  await expect(page.locator('#nav-tables')).toBeVisible();
  await page.click('#nav-tables');
  await expect(page.locator('#page-tables')).toBeVisible();
  await expect(page.locator('.table-tile').first()).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#page-tables .mgr-only')).toBeHidden();

  await page.click('button:has-text("Sign out")');
  await login(page, 'cashier@liquor.com');
  await expect(page.locator('#nav-pos')).toBeVisible();
  await expect(page.locator('#nav-accounting')).toHaveCount(0);
  await expect(page.locator('#nav-closing')).toHaveCount(0);
});

test.skip('expired or invalid session returns to the login page with a message', async ({ page }) => {
  await login(page, 'cashier@liquor.com');
  // Replace the stored token with one the server rejects, then reload (session restore → 401)
  await page.evaluate(() => {
    localStorage.setItem('token', 'x.eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDAifQ.y');
  });
  await page.reload();
  await expect(page.locator('#loginPage')).toBeVisible();
  await expect(page.locator('#loginError')).toContainText('session has expired');
});
