/**
 * Bank vs Book: the statement beside the books, matching by selecting or dragging, a settlement covering many entries.
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

/** The business date `days` after today (IST), as yyyy-mm-dd. */
const isoAhead = (days: number) => new Date(Date.now() + 330 * 60_000 + days * 86_400_000).toISOString().slice(0, 10);
const dmy = (iso: string) => iso.split('-').reverse().join('/');

function statement(rows: Array<[string, string, number]>): string {
  let bal = 0;
  const body = rows.map(([date, narr, amt], i) => {
    bal = Math.round((bal + amt) * 100) / 100;
    return `${i + 1},${date},${date},-,${narr},${amt < 0 ? (-amt).toFixed(2) : '0.00'},${amt > 0 ? amt.toFixed(2) : '0.00'},${bal.toFixed(2)}`;
  });
  return ['Detailed Statement', 'S No.,Value Date,Transaction Date,Cheque Number,Transaction Remarks,Withdrawal Amount (INR),Deposit Amount (INR),Balance (INR)', ...body].join('\n');
}

/** Puts entries into the BANK ledger of the signed-in manager's branch: [narration, bank debit (money in), bank credit (money out)]. */
async function seedBook(page: Page, date: string, entries: Array<[string, number, number]>): Promise<void> {
  await page.evaluate(async ({ date, entries }) => {
    const h = { Authorization: 'Bearer ' + localStorage.getItem('token'), 'Content-Type': 'application/json' };
    const b = await (await fetch('/api/v1/branches', { headers: h })).json();
    const branchId = (b.items ?? b)[0].id as string;
    const ledgers = (await (await fetch(`/api/v1/accounting/ledgers/${branchId}`, { headers: h })).json()).ledgers as { id: string; code: string }[];
    const bank = ledgers.find((l) => l.code === 'BANK')!.id;
    const other = ledgers.find((l) => l.code === 'SALES')!.id;
    for (const [narration, bankIn, bankOut] of entries) {
      const lines = bankIn > 0
        ? [{ ledgerId: bank, debit: bankIn.toFixed(2) }, { ledgerId: other, credit: bankIn.toFixed(2) }]
        : [{ ledgerId: other, debit: bankOut.toFixed(2) }, { ledgerId: bank, credit: bankOut.toFixed(2) }];
      const res = await fetch(`/api/v1/accounting/journal/${branchId}`, { method: 'POST', headers: h, body: JSON.stringify({ voucherDate: date, narration, lines }) });
      if (!res.ok) throw new Error('journal failed: ' + (await res.text()));
    }
  }, { date, entries });
}

test('Bank vs Book: a settlement matches many entries; a drag matches one; matched pairs can be taken apart', async ({ page }) => {
  await reactLogin(page, 'manager@liquor.com');
  const d1 = isoAhead(90);
  const d2 = isoAhead(91);
  await seedBook(page, d1, [[`BVB settle A ${stamp}`, 4000, 0], [`BVB settle B ${stamp}`, 1000, 0], [`BVB supplier ${stamp}`, 0, 800]]);

  await page.click('#nav-bank');
  await page.click('#bankAddAccount');
  await page.fill('#bankAccName', `BVB ${stamp}`);
  await page.fill('#bankAccBank', 'ICICI');
  await page.fill('#bankAccLast4', '7788');
  await page.click('#bankAccSave');
  await expect(page.locator('#bankAccountSelect')).toContainText(`BVB ${stamp}`);

  await page.click('#bankUploadBtn');
  await page.setInputFiles('#bankFile', {
    name: 'bvb.csv', mimeType: 'text/csv',
    buffer: Buffer.from(statement([[dmy(d1), `NEFT-SETTLEMENT ${stamp}`, 5000], [dmy(d2), `NEFT-SUPPLIER PAYMENT ${stamp}`, -800]])),
  });
  await expect(page.locator('#bankBalanceCheck')).toHaveAttribute('data-status', 'PASS');
  await page.click('#bankImportBtn');
  await expect(page.locator('#bankVsBook')).toBeVisible();

  // Switch to the two-sided view: the statement on the left, the books on the right
  await page.click('#bankViewBook');
  await expect(page.locator('#bankVsBook')).toBeVisible();
  await expect(page.locator('#bankLinesTable')).toHaveCount(0);
  const settlement = page.locator('[data-bvb-line]', { hasText: 'SETTLEMENT' });
  const supplierLine = page.locator('[data-bvb-line]', { hasText: 'SUPPLIER PAYMENT' });
  const entryA = page.locator('[data-bvb-entry]', { hasText: `BVB settle A ${stamp}` });
  const entryB = page.locator('[data-bvb-entry]', { hasText: `BVB settle B ${stamp}` });
  const entrySupplier = page.locator('[data-bvb-entry]', { hasText: `BVB supplier ${stamp}` });
  await expect(settlement).toBeVisible();
  await expect(entryA).toBeVisible();

  // One settlement, two sales: the total only agrees once both are picked
  await settlement.click();
  await entryA.click();
  await expect(page.locator('#bvbTotal')).toContainText('4,000');
  await expect(page.locator('#bvbShort')).toBeVisible();
  await expect(page.locator('#bvbMatch')).toBeDisabled();
  await entryB.click();
  await expect(page.locator('#bvbTotal')).toContainText('5,000');
  await expect(page.locator('#bvbMatchBar')).toContainText('Amounts agree');
  await page.click('#bvbMatch');
  await expect(page.locator('[data-bvb-pair]')).toHaveCount(1);
  await expect(page.locator('[data-bvb-pair]')).toContainText(`BVB settle A ${stamp}`);
  await expect(page.locator('[data-bvb-pair]')).toContainText(`BVB settle B ${stamp}`);
  await expect(settlement).toHaveCount(0);   // it left the "not matched" side

  // Dragging a bank line onto an entry picks the pair; Match finishes it
  await supplierLine.dragTo(entrySupplier);
  await expect(page.locator('#bvbMatchBar')).toContainText('Amounts agree');
  await page.click('#bvbMatch');
  await expect(page.locator('[data-bvb-pair]')).toHaveCount(2);
  await expect(page.locator('#bankVsBook')).toContainText('Every bank line is handled');

  // A pair can be taken apart: both halves come back to the "not matched" side
  await page.locator('[data-bvb-pair]', { hasText: 'SUPPLIER PAYMENT' }).locator('[data-bvb-unmatch]').click();
  await expect(page.locator('[data-bvb-pair]')).toHaveCount(1);
  await expect(supplierLine).toBeVisible();
  await expect(entrySupplier).toBeVisible();

  // Search narrows both sides; on a phone the two sides become tabs
  await page.fill('#bankLineSearch', 'zzz nothing');
  await expect(page.locator('#bvbBankList')).toContainText('No lines match');
  await page.fill('#bankLineSearch', '');
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(page.locator('#bvbTabBook')).toBeVisible();
  await expect(page.locator('#bvbBookList')).toBeHidden();
  await page.click('#bvbTabBook');
  await expect(page.locator('#bvbBookList')).toBeVisible();
  await expect(page.locator('#bvbBankList')).toBeHidden();

  // Back to the table
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.click('#bankViewTable');
  await expect(page.locator('#bankLinesTable')).toBeVisible();
});
