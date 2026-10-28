import { test, expect } from '@playwright/test';
import { login } from './helpers';

test.skip('counter sheet: create for a date, edit closing counts with live sold/revenue, save and post', async ({ page }) => {
  // A random past date (sheets are unique per branch+date; future dates are rejected)
  const d = new Date(Date.UTC(2025, 0, 1) + Math.floor(Math.random() * 300) * 86400000).toISOString().slice(0, 10);

  await login(page, 'manager@liquor.com');
  await page.click('#nav-counter');
  await page.fill('#counterDate', d);
  await page.click('#counterCreateBtn');
  await expect(page.locator('#counterStatus')).toContainText('DRAFT');

  const firstRow = page.locator('#counterSheet tbody tr').first();
  const productId = await firstRow.getAttribute('data-product');
  const closing = page.locator(`#cc-${productId}`);
  const original = Number(await closing.inputValue());
  expect(original).toBeGreaterThan(1);
  const rateText = (await firstRow.locator('td').nth(5).innerText()).trim();

  // Two bottles fewer on the shelf → live preview shows 2 sold and 2 × rate revenue
  await closing.fill(String(original - 2));
  await expect(page.locator(`#cs-${productId}`)).toHaveText('2');
  const rate = Number(rateText.replace(/[₹,]/g, ''));
  const expectedRevenue = '₹' + (rate * 2).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  await expect(page.locator(`#cr-${productId}`)).toHaveText(expectedRevenue);
  await expect(page.locator('#counterDirty')).toContainText('Unsaved');

  // Save → server-computed values
  await page.click('#counterSaveBtn');
  await expect(page.locator(`#cs-${productId}`)).toHaveText('2');
  await expect(page.locator(`#cr-${productId}`)).toHaveText(expectedRevenue);
  await expect(page.locator('#counterTotal')).toHaveText(expectedRevenue);

  // Post (manager) → read-only
  await page.click('#counterPostBtn');
  await page.click('#confirmOk');
  await expect(page.locator('#counterStatus')).toContainText('POSTED');
  await expect(page.locator(`#cc-${productId}`)).toHaveCount(0);
  await expect(page.locator('#counterRecent')).toContainText(`${d} · POSTED`);
});
