/**
 * The redesigned POS: scan and keyboard, cash tender with change, undo, parked bills, recent items, a rupee discount,
 * hiding out-of-stock items, and the cart as a sheet on a phone.
 * Build the frontend first: `npm run build:frontend`.
 */
import { test, expect, type Page } from '@playwright/test';
import { PASSWORD } from './helpers';

async function signInCashier(page: Page) {
  await page.goto('/login');
  await page.fill('#loginEmail', 'cashier@liquor.com');
  await page.fill('#loginPass', PASSWORD);
  await page.click('#loginBtn');
  await expect(page.locator('#mainApp')).toBeVisible({ timeout: 15000 });
}

/** A plain bottle with a barcode and plenty of stock, to scan. */
async function pickProduct(page: Page) {
  return page.evaluate(async () => {
    const t = localStorage.getItem('token');
    const h = { Authorization: `Bearer ${t}` };
    const b = await (await fetch('/api/v1/branches', { headers: h })).json();
    const list = await (await fetch(`/api/v1/products?branchId=${b[0].id}`, { headers: h })).json() as Array<{ name: string; barcode: string; trackStock?: boolean; currentStock?: number; stockQuantity?: number; servings?: unknown[]; isAvailable?: boolean }>;
    const p = list.find((x) => x.barcode && x.trackStock !== false && (x.currentStock ?? x.stockQuantity ?? 0) >= 5 && !(x.servings?.length) && x.isAvailable !== false);
    return p ? { name: p.name, barcode: p.barcode } : null;
  });
}

const rupees = (s: string) => Number(s.replace(/[^0-9.]/g, ''));

test('POS: scan, keyboard, undo, tender with change, park and resume, recent items', async ({ page }) => {
  test.setTimeout(120_000);
  await signInCashier(page);
  await page.goto('/pos');
  await expect(page.locator('.pos-product').first()).toBeVisible({ timeout: 20000 });
  const product = await pickProduct(page);
  expect(product).not.toBeNull();

  // The search box is ready for a scanner: a barcode and Enter put the item in the order
  await expect(page.locator('#posSearch')).toBeFocused();
  await page.keyboard.type(product!.barcode);
  await page.keyboard.press('Enter');
  const lines = page.locator('.cart-line');
  await expect(lines).toHaveCount(1);
  await expect(lines.first()).toContainText(product!.name);
  await expect(page.locator('#posSearch')).toHaveValue('');
  await expect(page.locator('#cartCount')).toContainText('1 item');

  // Keys act on the last touched line: + adds one, - takes one away
  await lines.first().locator('.line-clamp-2').click();
  await page.keyboard.press('+');
  await expect(lines.first()).toContainText('×2');
  await page.keyboard.press('-');
  await expect(lines.first()).toContainText('×1');

  // Removing a line can be undone
  await page.getByRole('button', { name: 'Decrease quantity' }).click();
  await expect(lines).toHaveCount(0);
  await expect(page.locator('#undoBar')).toContainText(product!.name);
  await page.click('#undoBtn');
  await expect(lines).toHaveCount(1);

  // Park the bill (F4), serve someone else, then bring it back (F8)
  await page.keyboard.press('F4');
  await expect(lines).toHaveCount(0);
  await expect(page.locator('#parkedCount')).toHaveText('1');
  await page.keyboard.press('F8');
  await expect(page.locator('#parkedList')).toContainText('1 item');
  await page.locator('.parked-resume').first().click();
  await expect(page.locator('#parkedList')).toHaveCount(0);
  await expect(lines).toHaveCount(1);
  await expect(lines.first()).toContainText(product!.name);
  await expect(page.locator('#parkedCount')).toHaveCount(0);

  // Cash: nothing typed means exact; too little blocks; more shows the change to give back
  const total = rupees(await page.locator('#totalAmount').innerText());
  await expect(page.locator('#changeDue')).toHaveAttribute('data-state', 'none');
  await page.fill('#tenderInput', '1');
  await expect(page.locator('#changeDue')).toHaveAttribute('data-state', 'short');
  await expect(page.locator('#checkoutBtn')).toBeDisabled();
  await page.fill('#tenderInput', String(total + 100));
  await expect(page.locator('#changeDue')).toHaveAttribute('data-state', 'ok');
  await expect(page.locator('#changeDue')).toContainText('100.00');
  await expect(page.locator('#checkoutBtn')).toBeEnabled();

  await page.keyboard.press('F9');
  await expect(page.locator('#checkoutModal')).toBeVisible();
  await expect(page.locator('#checkoutChange')).toContainText('100.00');
  await expect(page.locator('#newBillBtn')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#checkoutModal')).toHaveCount(0);
  await expect(lines).toHaveCount(0);

  // What was just sold is a tap away, with its price
  await expect(page.locator('#posRecent [data-recent]').first()).toContainText(product!.name.slice(0, 10));
  await page.locator('#posRecent [data-recent]').first().click();
  await expect(lines).toHaveCount(1);
});

test('POS: a discount in rupees is held to the cashier\'s cap; out-of-stock items can be hidden', async ({ page }) => {
  await signInCashier(page);
  await page.goto('/pos');
  await expect(page.locator('.pos-product').first()).toBeVisible({ timeout: 20000 });
  const product = await pickProduct(page);
  await page.fill('#posSearch', product!.barcode);
  await page.keyboard.press('Enter');
  await expect(page.locator('.cart-line')).toHaveCount(1);

  const subtotal = rupees(await page.locator('#totalAmount').innerText());
  await page.click('#discountModeBtn');
  await page.fill('#discountAmount', String(subtotal * 10));                    // far more than allowed
  const after = rupees(await page.locator('#totalAmount').innerText());
  await expect(page.locator('#discountCapHint')).toBeVisible();
  expect(after).toBeGreaterThanOrEqual(subtotal * 0.95 - 0.01);                  // a cashier's discount never passes the cap
  expect(after).toBeLessThan(subtotal);

  const before = await page.locator('.pos-product').count();
  await page.check('#posHideOut');
  expect(await page.locator('.pos-product').count()).toBeLessThanOrEqual(before);
  await page.uncheck('#posHideOut');
  expect(await page.locator('.pos-product').count()).toBe(before);
});

test('POS: on a phone the order is a bar at the bottom that opens as a sheet', async ({ page }) => {
  await signInCashier(page);
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/pos');
  await expect(page.locator('.pos-product').first()).toBeVisible({ timeout: 20000 });
  await expect(page.locator('#cartBar')).toContainText('Cart is empty');
  await page.locator('.pos-product:not([disabled])').first().click();
  await expect(page.locator('#cartBar')).toContainText('1 item');
  await page.click('#cartBar');
  await expect(page.locator('#cartPanel')).toBeInViewport();
  await expect(page.locator('.cart-line')).toHaveCount(1);
  await expect(page.locator('#checkoutBtn')).toBeVisible();
  await page.getByRole('button', { name: 'Close the cart' }).click();
  await expect(page.locator('#cartBar')).toBeVisible();
});
