import { test, expect } from '@playwright/test';
import { addProduct, apiGet, apiPost, apiToken, checkoutAndGetBillNo, login, uniq } from './helpers';

test('cashier opens a shift, rings a bill and closes with denominations showing the discrepancy', async ({ page, request }) => {
  // Isolated cashier + terminal so other specs' bills never land in this shift
  const id = uniq();
  const mgr = await apiToken(request, 'manager@liquor.com');
  const me = await apiGet<{ branchId: string }>(request, mgr, '/me');
  const terminalName = `E2E Till ${id}`;
  await apiPost(request, mgr, `/terminals/${me.branchId}`, { terminalName });
  const email = `shift.${id.toLowerCase()}@liquor.com`;
  await apiPost(request, mgr, '/users', { name: `Shift Cashier ${id}`, email, password: 'Password@123', role: 'cashier', branchId: me.branchId });

  await login(page, email);
  await page.click('#nav-shift');
  await page.locator('#shiftTerminal').selectOption({ label: terminalName });
  await page.fill('#shiftFloat', '1000.00');
  await page.click('#shiftOpenBtn');
  await expect(page.locator('#shiftExpectedLive')).toHaveText('₹1,000.00');

  // Ring one Old Monk (MRP ₹450) in cash
  await addProduct(page, 'Old Monk XXX');
  await page.click('#pay-CASH');
  await checkoutAndGetBillNo(page);

  // Live totals reflect the sale: expected = float + cash sales
  await page.click('#nav-shift');
  await expect(page.locator('#shiftCash')).toHaveText('₹450.00');
  await expect(page.locator('#shiftExpectedLive')).toHaveText('₹1,450.00');

  // Count ₹1,400 → ₹50 short; the live counter previews it before submitting
  await page.fill('#denom-500', '2');
  await page.fill('#denom-200', '2');
  await expect(page.locator('#shiftCounted')).toHaveText('₹1,400.00');
  await expect(page.locator('#shiftDiscrepancy')).toContainText('-₹50.00 (Shortage)');

  await page.click('#shiftCloseBtn');
  await page.click('#confirmOk');
  const result = page.locator('#shiftCloseResult');
  await expect(result).toBeVisible();
  await expect(page.locator('#shiftResultExpected')).toHaveText('₹1,450.00');
  await expect(page.locator('#shiftResultCounted')).toHaveText('₹1,400.00');
  await expect(page.locator('#shiftResultDiscrepancy')).toHaveText('-₹50.00 (Shortage)');
});
