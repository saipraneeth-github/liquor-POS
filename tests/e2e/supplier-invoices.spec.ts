import { test, expect } from '@playwright/test';
import { login, uniq } from './helpers';

test('supplier invoice upload: CSV extract -> review & map unmatched line -> approve -> stock & history updated', async ({ page }) => {
  const invNo = `INV-2026-${uniq()}`;
  const csv = [
    `Supplier: United Spirits Depot`,
    `Invoice No: ${invNo},Date: 2026-10-24`,
    `Barcode,Description,Qty,Rate,MRP,Amount`,
    `890123456001,Royal Challenge Premium Whisky 750ml,12,620.00,850.00,7440.00`,
    `,Kingfisher Premium Lager Beer 650ml,24,130.00,180.00,3120.00`,
    `,Grand Total,,,,10560.00`,
  ].join('\n');

  await login(page, 'manager@liquor.com');
  // Stock lives on the Inventory page; read the starting Royal Challenge quantity there
  const openStock = async () => {
    await page.goto('/inventory');
    await expect(page.locator('#stockTable table')).toBeVisible();
    return page.locator('#stockTable tbody tr', { hasText: 'Royal Challenge Premium Whisky 750ml' });
  };
  const qtyOf = async (row: ReturnType<typeof page.locator>) => Number((await row.locator('td').nth(1).innerText()).match(/\d+/)?.[0] ?? 'NaN');
  const beforeRc = await qtyOf(await openStock());

  // Upload the CSV invoice from the All Invoices page
  await page.click('#nav-invoices');
  await page.getByRole('button', { name: 'Add Supplier Bill', exact: true }).click();
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
  await expect(rows.nth(0)).toHaveAttribute('data-match-status', /^(MATCHED|SUGGESTED)$/);
  await expect(rows.nth(1)).toHaveAttribute('data-match-status', /^(MATCHED|SUGGESTED)$/);
  // Line 2 is only a suggested match: confirm it, otherwise the server refuses the approval
  await rows.nth(1).locator('.ie-confirm-match').click();
  await expect(rows.nth(1)).toHaveAttribute('data-match-status', 'MANUAL');

  // Mark reviewed
  await page.click('#invReviewBtn');
  await expect(page.locator('#invDetailBox')).toContainText(/reviewed/i);

  // Confirm the inward and approve it
  await page.getByRole('button', { name: /Submit Invoice/ }).click();
  await page.click('#invApproveBtn');
  await page.click('#confirmOk');

  // Approval returns straight to All Invoices where the bill shows as added to stock
  await expect(page.locator('#invHistoryBox tr', { hasText: invNo })).toContainText('Added to Stock', { timeout: 20000 });

  // ...and Royal Challenge went up by 12 on the Inventory page
  await openStock();
  await expect.poll(async () => qtyOf(page.locator('#stockTable tbody tr', { hasText: 'Royal Challenge Premium Whisky 750ml' })), { timeout: 15000 }).toBe(beforeRc + 12);
});

test('Supplier Invoices: several files added together are each read into a draft, and search finds them', async ({ page }) => {
  const stamp = uniq();
  const mk = (no: string, depot: string) => ({
    name: `${no}.csv`,
    mimeType: 'text/csv',
    buffer: Buffer.from([
      `Supplier: ${depot}`,
      `Invoice No: ${no},Date: 2026-10-24`,
      'Barcode,Description,Qty,Rate,MRP,Amount',
      '890123456001,Royal Challenge Premium Whisky 750ml,2,620.00,850.00,1240.00',
    ].join('\n'), 'utf8'),
  });
  const a = `BULK-A-${stamp}`, b = `BULK-B-${stamp}`;

  await login(page, 'manager@liquor.com');
  await page.click('#nav-invoices');
  // the list has no upload area, only a button to the Add Supplier Bill screen
  await expect(page.locator('#bulkDropZone')).toHaveCount(0);
  await page.getByRole('button', { name: 'Add Supplier Bill' }).first().click();
  await page.locator('#bulkFileInput').setInputFiles([mk(a, 'Alpha Depot'), mk(b, 'Beta Depot')]);
  await expect(page.locator('#bulkTray')).toContainText('2 of 2 uploaded', { timeout: 30000 });
  await page.getByRole('button', { name: /^Supplier Invoices/ }).click();

  // searching by invoice number finds only that bill
  await page.locator('#searchIcdcInput').fill(a);
  await expect(page.locator('#invHistoryBox tbody tr')).toHaveCount(1, { timeout: 10000 });
  await expect(page.locator('#invHistoryBox tbody tr')).toContainText(a);
});
