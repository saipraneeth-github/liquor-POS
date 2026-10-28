import { test, expect } from '@playwright/test';
import { login, uniq } from './helpers';

test.skip('supplier invoice upload: CSV extract -> review & map unmatched line -> approve -> stock & history updated', async ({ page }) => {
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
  await page.click('#nav-stock');
  await expect(page.locator('#stockTable table')).toBeVisible();

  // Read initial Royal Challenge stock
  const rcRow = page.locator('#stockTable tbody tr', { hasText: 'Royal Challenge Premium Whisky 750ml' });
  const beforeRc = Number((await rcRow.locator('td').nth(1).innerText()).trim());

  // Upload CSV invoice
  await page.locator('#invUploadFile').setInputFiles({
    name: 'united-spirits.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv, 'utf8'),
  });
  await page.click('#invUploadBtn');

  // Review detail box opens with DRAFT status, line 1 MATCHED, line 2 UNMATCHED
  await expect(page.locator('#invDetailBox')).toBeVisible();
  await expect(page.locator('#invEditNumber')).toHaveValue(invNo);
  const rows = page.locator('#invEditLines .inv-edit-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator('.ie-match-badge')).toContainText('MATCHED');
  await expect(rows.nth(1).locator('.ie-match-badge')).toContainText('UNMATCHED');

  // Map line 2 to Kingfisher Premium Lager Beer 650ml
  const kfOption = rows.nth(1).locator('.ie-prod option', { hasText: 'Kingfisher Premium Lager Beer 650ml' });
  const kfVal = await kfOption.getAttribute('value');
  await rows.nth(1).locator('.ie-prod').selectOption(kfVal!);
  await expect(rows.nth(1).locator('.ie-match-badge')).toContainText('MANUAL');

  // Mark reviewed, then approve
  await page.click('#invReviewBtn');
  await expect(page.locator('#invDetailBox')).toContainText('REVIEWED');

  await page.click('#invApproveBtn');
  await page.click('#confirmOk');

  await expect(page.locator('#invDetailBox')).toContainText('APPROVED');
  await expect(page.locator('#invHistoryBox tr', { hasText: invNo })).toContainText('APPROVED');

  // Verify stock of Royal Challenge increased by 12
  await expect(rcRow.locator('td').nth(1)).toHaveText(String(beforeRc + 12));
});
