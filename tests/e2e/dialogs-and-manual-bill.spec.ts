import { test, expect, type Page } from '@playwright/test';
import { PASSWORD, uniq } from './helpers';

const stamp = uniq();

async function login(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.fill('#loginEmail', email);
  await page.fill('#loginPass', PASSWORD);
  await page.click('#loginBtn');
  await expect(page.locator('#mainApp')).toBeVisible({ timeout: 15000 });
}

/** Where the open dialog's card sits against the middle of the window, in pixels (0 = centred). */
async function centreOffset(page: Page): Promise<number> {
  return page.evaluate(() => {
    const overlay = [...document.querySelectorAll('[role=dialog]')].pop() as HTMLElement | undefined;
    if (!overlay) return 9999;
    const c = (overlay.firstElementChild as HTMLElement).getBoundingClientRect();
    return Math.round((c.top + c.bottom) / 2 - window.innerHeight / 2);
  });
}

test('dialogs open in the middle of the window, on a tall screen and on a short one', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await login(page, 'manager@liquor.com');
  await page.click('#changePasswordBtn');
  await expect(page.locator('[role=dialog]')).toBeVisible();
  expect(Math.abs(await centreOffset(page))).toBeLessThanOrEqual(2);
  await page.keyboard.press('Escape');
  await page.locator('[role=dialog] button[aria-label="Close"]').click();

  // a short window: the dialog must still be reachable from its first field to its last button
  await page.setViewportSize({ width: 1100, height: 420 });
  await page.click('#changePasswordBtn');
  await expect(page.locator('[role=dialog]')).toBeVisible();
  const reach = await page.evaluate(async () => {
    const overlay = document.querySelector('[role=dialog]') as HTMLElement;
    overlay.scrollTop = overlay.scrollHeight;
    await new Promise((r) => setTimeout(r, 150));
    const save = document.querySelector('#pwSave')!.getBoundingClientRect();
    overlay.scrollTop = 0;
    await new Promise((r) => setTimeout(r, 150));
    const first = document.querySelector('#pwCurrent')!.getBoundingClientRect();
    return { saveInView: save.bottom <= window.innerHeight + 1, firstInView: first.top >= 0 };
  });
  expect(reach).toEqual({ saveInView: true, firstInView: true });
});

test('forgot password: the form sits a little above the middle, not pushed down', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/forgot-password');
  const box = await page.locator('.lc-login-form').first().boundingBox();
  expect(box).not.toBeNull();
  const centre = box!.y + box!.height / 2;
  expect(centre).toBeLessThan(768 / 2);
  expect(centre).toBeGreaterThan(768 * 0.3);
});

test('a supplier bill typed in by hand can be confirmed into stock', async ({ page }) => {
  // The brand code is the first word of the description and brand mappings are shared by the whole business,
  // so it must be unique to this run or the stock would land on an earlier run's product.
  const product = `MB${stamp} Manual Brandy 750ml`;
  const invNo = `MAN-${stamp}`;
  await login(page, 'manager@liquor.com');

  await page.goto('/invoices');
  await page.getByRole('button', { name: 'Add Supplier Bill' }).click();
  await page.getByText('Enter bill items manually').click();
  await page.locator('#invEditSupplier').fill(`Depot ${stamp}`);
  await page.locator('#invEditNumber').fill(invNo);

  // The first line starts as a placeholder: describe it and set 6 bottles at 400.00 (MRP 600.00)
  const row = page.locator('#invEditLines .inv-edit-row').first();
  await row.getByTitle('Edit row fields').click();
  await row.locator('.ie-desc').fill(product);
  await row.locator('.ie-qty').fill('6');
  await row.locator('.ie-cost').fill('400.00');
  await row.locator('.ie-mrp').fill('600.00');
  await row.getByTitle('Save and make read-only').click();

  // A new brand has to be added to the catalogue before stock can be inwarded against it
  await row.getByRole('button', { name: 'Save to Mapping' }).click();
  await expect(row).toHaveAttribute('data-match-status', /^(MATCHED|MANUAL)$/, { timeout: 15000 });

  await page.click('#invReviewBtn');
  await page.getByRole('button', { name: /Submit Invoice/ }).click();

  // the dialog states what will be posted, worked out from the lines (6 bottles at the line's cost)
  await page.click('#invApproveBtn');
  await expect(page.locator('#confirmOk')).toBeVisible();
  await expect(page.locator('[role=dialog], #modal').last()).toContainText('₹2400.00');
  await page.click('#confirmOk');

  await expect(page.locator('#invHistoryBox tr', { hasText: invNo })).toContainText('Added to Stock', { timeout: 20000 });
  await page.goto('/inventory');
  await expect(page.locator('#stockTable tbody tr', { hasText: product })).toContainText('6', { timeout: 15000 });
});
