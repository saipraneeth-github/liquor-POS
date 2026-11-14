/**
 * Bank reconciliation: the summary strip, expandable line details, filters, and adding a transaction type of your own.
 * Build the frontend first: `npm run build:frontend`.
 */
import { test, expect, type Page } from '@playwright/test';
import { PASSWORD, uniq } from './helpers';

const stamp = uniq();

async function reactLogin(page: Page, email: string): Promise<void> {
  page.on('pageerror', (err) => console.error(`Uncaught page exception: "${err.message}"`));
  await page.goto('/login');
  await page.fill('#loginEmail', email);
  await page.fill('#loginPass', PASSWORD);
  await page.click('#loginBtn');
  await expect(page.locator('#mainApp')).toBeVisible({ timeout: 15000 });
}

/** dd/mm/yyyy, `days` after today in store (IST) time. */
function ahead(days: number): string {
  const d = new Date(Date.now() + 330 * 60_000 + days * 86_400_000).toISOString().slice(0, 10);
  return d.split('-').reverse().join('/');
}

function statement(rows: Array<[string, string, number]>): string {
  let bal = 0;
  const body = rows.map(([date, narr, amt], i) => {
    bal = Math.round((bal + amt) * 100) / 100;
    return `${i + 1},${date},${date},-,${narr},${amt < 0 ? (-amt).toFixed(2) : '0.00'},${amt > 0 ? amt.toFixed(2) : '0.00'},${bal.toFixed(2)}`;
  });
  return ['Detailed Statement', 'S No.,Value Date,Transaction Date,Cheque Number,Transaction Remarks,Withdrawal Amount (INR),Deposit Amount (INR),Balance (INR)', ...body].join('\n');
}

test('strip, line details, filters, and a transaction type of your own that posts a line', async ({ page }) => {
  await reactLogin(page, 'manager@liquor.com');
  await page.click('#nav-bank');

  await page.click('#bankAddAccount');
  await page.fill('#bankAccName', `Types ${stamp}`);
  await page.fill('#bankAccBank', 'ICICI');
  await page.fill('#bankAccLast4', '9911');
  await page.click('#bankAccSave');
  await expect(page.locator('#bankAccountSelect')).toContainText(`Types ${stamp}`);

  await page.click('#bankUploadBtn');
  const csv = statement([
    [ahead(70), `NEFT-HOTEL RENT NOV ${stamp}`, -12000],
    [ahead(71), `NEFT-STATIONERY ${stamp}`, -800],
  ]);
  await page.setInputFiles('#bankFile', { name: 'types.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(page.locator('#bankBalanceCheck')).toHaveAttribute('data-status', 'PASS');
  await page.click('#bankImportBtn');
  await page.click('#bankViewTable');
  await expect(page.locator('#bankLinesTable tbody tr')).toHaveCount(2);

  // The summary strip shows the totals and what is left to do
  const strip = page.locator('#bankStrip');
  await expect(strip).toContainText('Bank statement balance');
  await expect(strip).toContainText('12,800');
  await expect(page.locator('#bankStripStatus')).toContainText('2 lines need attention');

  // Every line shows its reference and balance columns, and opens to full details
  await expect(page.locator('#bankLinesTable thead')).toContainText('Ref no.');
  await expect(page.locator('#bankLinesTable thead')).toContainText('Balance');
  const rentRow = page.locator('#bankLinesTable tbody tr[data-line-status]', { hasText: 'HOTEL RENT' });
  await rentRow.locator('[data-expand]').click();
  await expect(page.locator('[data-detail]')).toContainText('Full narration');
  await expect(page.locator('[data-detail]')).toContainText('Import id');
  await rentRow.locator('[data-expand]').click();
  await expect(page.locator('[data-detail]')).toHaveCount(0);

  // Search takes several words, and says so when nothing matches
  await page.fill('#bankLineSearch', `stationery ${stamp}`);
  await expect(page.locator('#bankLinesTable tbody tr[data-line-status]')).toHaveCount(1);
  await page.fill('#bankLineSearch', 'no such words anywhere');
  await expect(page.locator('#bankLinesTable')).toContainText('No lines match');
  await page.click('#bankClearFilters');
  await expect(page.locator('#bankLinesTable tbody tr[data-line-status]')).toHaveCount(2);

  // Add a transaction type: validation shows next to the field
  await page.click('#bankAddType');
  await page.fill('#bankTypeName', 'ab');
  await page.click('#bankTypeSave');
  await expect(page.locator('#bankTypeForm')).toContainText('Use at least 3 characters');
  await expect(page.locator('#bankTypeForm')).toContainText('Choose the account it posts to');
  await page.fill('#bankTypeName', 'Hotel rent');
  await page.selectOption('#bankTypeLedger', { index: 1 });
  await page.fill('#bankTypeText', 'HOTEL RENT');
  await page.click('#bankTypeSaveApply');
  await expect(page.locator('#bankTypeForm')).toHaveCount(0);

  // The type is now offered on the matching line, and posting through it matches the line
  await expect(rentRow.locator('[data-action="post"]')).toContainText('Post as hotel rent');
  await rentRow.locator('[data-action="post"]').click();
  await expect(page.locator('#bankPostCategory')).toHaveValue(/^type:/);
  await page.click('#bankPostConfirm');
  await expect(page.locator('[role="dialog"]')).toHaveCount(0);
  await expect(page.locator('#bankStripStatus')).toContainText('1 line need');
  await page.click('[data-filter="MATCHED"]');
  await expect(page.locator('#bankLinesTable')).toContainText('Hotel rent');

  // The same name again is refused, whatever the capitalisation
  await page.click('#bankAddType');
  await page.fill('#bankTypeName', 'HOTEL RENT');
  await page.selectOption('#bankTypeLedger', { index: 1 });
  await page.click('#bankTypeSave');
  await expect(page.locator('#bankTypeForm')).toContainText('already exists');
});
