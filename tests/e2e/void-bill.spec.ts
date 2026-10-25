import { test, expect } from '@playwright/test';
import { addProduct, checkoutAndGetBillNo, login } from './helpers';

test('manager voids a bill from bill history with a reason', async ({ page }) => {
  await login(page, 'manager@liquor.com');
  await addProduct(page, 'Magic Moments');
  const billNo = await checkoutAndGetBillNo(page);

  await page.click('#nav-bills');
  await page.fill('#billsSearch', billNo);
  const row = page.locator(`tr.bill-row[data-bill-number="${billNo}"]`);
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('PAID');

  // Reason is validated (min 5 chars) before the request is sent
  await row.getByRole('button', { name: 'Void' }).click();
  await page.fill('#voidReason', 'bad');
  await page.click('#voidConfirmBtn');
  await expect(page.locator('#modal')).toBeVisible();

  await page.fill('#voidReason', 'Customer returned the bottle unopened');
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/void') && r.request().method() === 'POST'),
    page.click('#voidConfirmBtn'),
  ]);
  expect(resp.status()).toBe(200);
  await expect(page.locator('#modal')).toBeHidden();
  await expect(row).toContainText('VOIDED');
  await expect(row.getByRole('button', { name: 'Void' })).toHaveCount(0);

  // The bill detail shows the void reason
  await row.getByRole('button', { name: 'View' }).click();
  await expect(page.locator('#modalBody')).toContainText('Customer returned the bottle unopened');
});

test('cashier sees bill history but no Void action', async ({ page }) => {
  await login(page, 'cashier@liquor.com');
  await addProduct(page, 'Magic Moments');
  const billNo = await checkoutAndGetBillNo(page);
  await page.click('#nav-bills');
  await page.fill('#billsSearch', billNo);
  const row = page.locator(`tr.bill-row[data-bill-number="${billNo}"]`);
  await expect(row).toHaveCount(1);
  await expect(row.getByRole('button', { name: 'Void' })).toHaveCount(0);
});
