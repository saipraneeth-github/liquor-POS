import { test, expect } from '@playwright/test';
import { login, uniq } from './helpers';

test('supplier invoice upload: CSV extract -> review & map unmatched line -> approve -> stock & history updated', async ({ page }) => {
  const invNo = `INV-2026-${uniq()}`;
  const csv = [
    `Supplier: United Spirits Depot`,
    `Invoice No: ${invNo},Date: 2026-10-24`,
    `Barcode,Description,Qty,Rate,MRP,Amount`,
    `890123456001,Royal Challenge Premium Whisky 750ml,12,620.00,850.00,7440.00`,
    `,Special Batch Lager 650ml,24,130.00,180.00,3120.00`,
    `,Grand Total,,,,10560.00`,
  ].join('\n');

  await login(page, 'manager@liquor.com');
  await page.click('#nav-inventory');

  // Read the initial Royal Challenge stock from the Current Store Stock tab
  const openStock = async () => {
    await page.getByRole('button', { name: 'Current Store Stock' }).click();
    await expect(page.locator('#stockTable table')).toBeVisible();
    return page.locator('#stockTable tbody tr', { hasText: 'Royal Challenge Premium Whisky 750ml' });
  };
  const qtyOf = async (row: ReturnType<typeof page.locator>) => Number((await row.locator('td').nth(1).innerText()).match(/\d+/)?.[0] ?? 'NaN');
  const beforeRc = await qtyOf(await openStock());

  // Upload the CSV invoice from the Add Supplier Bill tab
  await page.getByRole('button', { name: 'Add Supplier Bill' }).click();
  await page.locator('#invUploadFile').setInputFiles({
    name: 'united-spirits.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv, 'utf8'),
  });
  await page.click('#invUploadBtn');

  // The review screen opens as a draft: line 1 matched to a product, line 2 needs one
  await expect(page.locator('#invDetailBox')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('#invEditNumber')).toHaveValue(invNo);
  const rows = page.locator('#invEditLines .inv-edit-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator('.ie-match-badge')).toHaveAttribute('title', 'Matched');
  await expect(rows.nth(1).locator('.ie-match-badge')).toHaveAttribute('title', 'Needs selection');

  // Map line 2 to Kingfisher Premium Lager Beer 650ml
  const kfOption = rows.nth(1).locator('.ie-prod option', { hasText: 'Kingfisher Premium Lager Beer 650ml' }).first();
  const kfVal = await kfOption.getAttribute('value');
  await rows.nth(1).locator('.ie-prod').selectOption(kfVal!);
  await expect(rows.nth(1).locator('.ie-match-badge')).toHaveAttribute('title', 'Matched');

  // Mark reviewed
  await page.click('#invReviewBtn');
  await expect(page.locator('#invDetailBox')).toContainText(/reviewed/i);

  // Confirm the inward and approve it
  await page.getByRole('button', { name: /Proceed to Inward Confirmation/ }).click();
  await page.click('#invApproveBtn');
  await page.click('#confirmOk');

  // It lands on the stock tab: Royal Challenge went up by 12
  await expect(page.locator('#stockTable')).toBeVisible({ timeout: 20000 });
  await expect.poll(async () => qtyOf(page.locator('#stockTable tbody tr', { hasText: 'Royal Challenge Premium Whisky 750ml' })), { timeout: 15000 }).toBe(beforeRc + 12);

  // And the bill is in history as approved
  await page.getByRole('button', { name: /Bill History/ }).click();
  await expect(page.locator('#invHistoryBox tr', { hasText: invNo })).toContainText('Added to Stock');
});
