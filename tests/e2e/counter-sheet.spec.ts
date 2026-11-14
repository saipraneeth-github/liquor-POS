import { test, expect, type Page } from '@playwright/test';
import { PASSWORD } from './helpers';

// Signs in through the React sign-in screen (the shared `login` helper opens "/", which is the old single-file page).
async function reactLogin(page: Page, email: string): Promise<void> {
  page.on('pageerror', (err) => console.error(`Uncaught page exception: "${err.message}"`));
  await page.goto('/login');
  await page.fill('#loginEmail', email);
  await page.fill('#loginPass', PASSWORD);
  await page.click('#loginBtn');
  await expect(page.locator('#mainApp')).toBeVisible({ timeout: 15000 });
}

test('counter sheet: create for a date, edit closing counts with live sold/revenue, save and post', async ({ page }) => {
  // A random past date (sheets are unique per branch+date; future dates are rejected)
  const d = new Date(Date.UTC(2025, 0, 1) + Math.floor(Math.random() * 300) * 86400000).toISOString().slice(0, 10);

  await reactLogin(page, 'manager@liquor.com');
  await page.click('#nav-counter');
  await page.fill('#counterDate', d);
  await page.click('#counterCreateBtn');
  await expect(page.locator('#counterStatus')).toContainText('DRAFT');

  const firstRow = page.locator('#counterSheet tbody tr').first();
  const productId = await firstRow.getAttribute('data-product');
  const closing = page.locator(`#cc-${productId}`);
  const original = Number(await closing.inputValue());
  expect(original).toBeGreaterThan(1);
  // the rate is the cell just before this row's revenue cell
  const rateText = (await firstRow.locator('td').nth(6).innerText()).trim();

  // Two bottles fewer on the shelf → live preview shows 2 sold and 2 × rate revenue
  await closing.fill(String(original - 2));
  await expect(page.locator(`#cs-${productId}`)).toHaveText(/^2\b/);
  const rate = Number(rateText.replace(/[₹,]/g, ''));
  const expectedRevenue = '₹' + (rate * 2).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  await expect(page.locator(`#cr-${productId}`)).toHaveText(expectedRevenue);
  await expect(page.locator('#counterDirty')).toContainText('Unsaved');

  // Save → server-computed values
  await page.click('#counterSaveBtn');
  await expect(page.locator(`#cs-${productId}`)).toHaveText(/^2\b/);
  await expect(page.locator(`#cr-${productId}`)).toHaveText(expectedRevenue);
  await expect(page.locator('#counterTotal')).toHaveText(expectedRevenue);

  // Post (manager) → read-only
  await page.click('#counterPostBtn');
  await page.click('#confirmOk');
  await expect(page.locator('#counterStatus')).toContainText('POSTED', { timeout: 20000 });
  await expect(page.locator(`#cc-${productId}`)).toHaveCount(0);
  await expect(page.locator('#counterRecent')).toContainText(`${d} · POSTED`);
});

test('counter sheet: a manager can correct the opening stock, the sold count follows, and it is marked as edited; a cashier cannot', async ({ page }) => {
  const d = new Date(Date.UTC(2025, 0, 1) + Math.floor(Math.random() * 300) * 86400000).toISOString().slice(0, 10);
  await reactLogin(page, 'manager@liquor.com');
  await page.click('#nav-counter');
  await page.fill('#counterDate', d);
  await page.click('#counterCreateBtn');
  await expect(page.locator('#counterStatus')).toContainText('DRAFT');

  const firstRow = page.locator('#counterSheet tbody tr').first();
  const productId = await firstRow.getAttribute('data-product');
  const opening = page.locator(`#co-${productId}`);
  const original = Number(await opening.inputValue());
  const closing = Number(await page.locator(`#cc-${productId}`).inputValue());

  // Five more bottles were on the shelf at the start of the day: sold goes up by five, live
  await opening.fill(String(original + 5));
  const expectedSold = 5 + Math.max(0, original - closing);
  await expect(page.locator(`#cs-${productId}`)).toHaveText(new RegExp('^' + expectedSold + '[^0-9]|^' + expectedSold + '$'));
  await page.click('#counterSaveBtn');
  await expect(page.locator(`[data-opening-edited="${productId}"]`)).toContainText(`was ${original}`);
  await expect(page.locator(`#co-${productId}`)).toHaveValue(String(original + 5));
});

test('counter sheet: a cashier without the permission sees the opening as a plain number', async ({ page }) => {
  await reactLogin(page, 'cashier@liquor.com');
  await page.click('#nav-counter');
  const recent = page.locator('#counterSheet tbody tr').first();
  await expect(recent).toBeVisible({ timeout: 20000 });
  await expect(page.locator('input.counter-opening')).toHaveCount(0);
});
