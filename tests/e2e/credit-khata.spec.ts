import { test, expect, type Page } from '@playwright/test';
import { addProduct, login } from './helpers';

function paise(text: string): number {
  const m = text.replace(/[₹,\s]/g, '').match(/^(-?)(\d+)\.(\d{2})/);
  if (!m) throw new Error('not money: ' + text);
  return (m[1] ? -1 : 1) * (Number(m[2]) * 100 + Number(m[3]));
}

async function openRaviStatement(page: Page) {
  await page.click('#nav-customers');
  await page.fill('#custSearch', 'Ravi');
  await page.click('#custSearchBtn');
  await page.locator('.cust-row', { hasText: 'Ravi Kumar' }).getByRole('button', { name: 'Statement' }).click();
  await expect(page.locator('#custStatementName')).toHaveText('Ravi Kumar');
  return paise(await page.locator('#custOutstanding').innerText());
}

test('CREDIT sale to khata customer Ravi Kumar, then a repayment', async ({ page }) => {
  await login(page, 'cashier@liquor.com');
  const before = await openRaviStatement(page);

  // Credit sale of one Kingfisher at the current database price.
  await addProduct(page, 'Kingfisher');
  const saleAmount = paise(await page.locator('#totalAmount').innerText());
  await page.click('#pay-CREDIT');
  await page.fill('#creditSearch', 'Ravi');
  await page.locator('#creditResults .list-btn', { hasText: 'Ravi Kumar' }).click();
  const card = page.locator('#creditCustomerCard');
  await expect(card).toContainText(/Limit\s*₹5,000\.00/);
  const remainingBefore = paise(await page.locator('#creditRemaining').innerText());
  expect(remainingBefore).toBe(500000 - before);

  await page.click('#checkoutBtn');
  await expect(page.locator('#checkoutModal')).toBeVisible();
  await expect(page.locator('#checkoutSummary')).toContainText('collected via CREDIT');
  await expect(page.locator('#checkoutSummary')).toContainText('Ravi Kumar');
  await page.click('#newBillBtn');

  // Khata now owes exactly the amount billed from the database price.
  const afterSale = await openRaviStatement(page);
  expect(afterSale - before).toBe(saleAmount);
  await expect(page.locator('#custEntries')).toContainText('PURCHASE');

  // Repay the same amount in cash → back to the original balance.
  await page.fill('#repayAmount', (saleAmount / 100).toFixed(2));
  await page.locator('#repayMode').selectOption('CASH');
  await page.click('#repayBtn');
  await expect(page.locator('#custEntries')).toContainText('REPAYMENT');
  await expect.poll(async () => paise(await page.locator('#custOutstanding').innerText())).toBe(before);
});
