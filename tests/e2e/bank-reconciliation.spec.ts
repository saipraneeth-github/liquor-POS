/**
 * Bank statement upload and reconciliation through the React app (served from dist/frontend).
 * Build the frontend first: `npm run build:frontend`.
 *
 * Statement dates sit weeks ahead of today so that no sale made by other specs falls inside a settlement window;
 * the card/UPI settlement match (with its fee) is covered by tests/integration/bank.int.test.ts.
 */
import { test, expect, type Page } from '@playwright/test';
import { PASSWORD, uniq } from './helpers';

test.describe.configure({ mode: 'serial' });

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

/** An ICICI-style layout (serial column, "Transaction Remarks", "(INR)" headings) with correct running balances. */
function statement(rows: Array<[string, string, number]>, breakAt?: number): string {
  let bal = 0;
  const body = rows.map(([date, narr, amt], i) => {
    bal = Math.round((bal + amt) * 100) / 100;
    const shown = breakAt === i ? bal + 50 : bal;
    return `${i + 1},${date},${date},-,${narr},${amt < 0 ? (-amt).toFixed(2) : '0.00'},${amt > 0 ? amt.toFixed(2) : '0.00'},${shown.toFixed(2)}`;
  });
  return ['Detailed Statement', 'S No.,Value Date,Transaction Date,Cheque Number,Transaction Remarks,Withdrawal Amount (INR),Deposit Amount (INR),Balance (INR)', ...body].join('\n');
}

const csvFile = (name: string, content: string) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(content) });

test.beforeAll(async ({ request }) => {
  const res = await request.get('/login', { headers: { Accept: 'text/html' } });
  const html = await res.text();
  test.skip(!html.includes('id="root"'), 'React build not found — run `npm run build:frontend` first');
});

test('add an account, upload a statement from any bank, see it verified, and reconcile it into the books', async ({ page }) => {
  await reactLogin(page, 'manager@liquor.com');
  await page.click('#nav-bank');
  await expect(page.getByRole('heading', { name: 'Match Bank Statement' })).toBeVisible();

  // Add the account (a manager cannot choose the whole-business scope)
  await page.click('#bankAddAccount');
  await page.fill('#bankAccName', `ICICI ${stamp}`);
  await page.fill('#bankAccBank', 'ICICI');
  await page.fill('#bankAccLast4', '4821');
  await expect(page.locator('#bankScopeShared')).toBeDisabled();
  await page.click('#bankAccSave');
  await expect(page.locator('#bankAccountSelect')).toContainText(`ICICI ${stamp}`);

  // Upload: columns are recognised without any configuration, and the statement proves itself
  await page.click('#bankUploadBtn');
  const d1 = ahead(40);
  const d2 = ahead(41);
  const file = statement([
    [d1, 'CASH DEP BY SELF', 10000],
    [d1, `SMS ALERT CHRG ${stamp}`, -23.6],
    [d2, 'INT PD 01-08-26 TO 31-10-26', 45],
    [d2, 'NEFT-RAJ BEVERAGES-INV 7781', -5000],
  ]);
  await page.setInputFiles('#bankFile', csvFile('icici.csv', file));
  await expect(page.locator('#bankBalanceCheck')).toHaveAttribute('data-status', 'PASS');
  await expect(page.locator('#bankBalanceCheck')).toContainText('Statement verified');
  await expect(page.locator('#bankPreviewTable tbody tr')).toHaveCount(4);
  await expect(page.locator('#bankPreviewTable')).toContainText('CASH DEP BY SELF');
  await expect(page.locator('#bankImportBtn')).toBeEnabled();
  await page.click('#bankImportBtn');
  await page.click('#bankViewTable');
  await page.click('#bankWorkingsToggle');

  // Reconcile: nothing is "reconciled" while lines are still missing from the books
  await expect(page.locator('#bankLinesTable')).toBeVisible();
  const card = page.locator('#bankSummary [data-state]');
  await expect(card).toHaveAttribute('data-state', 'incomplete');
  await expect(page.locator('#bankFinalize')).toBeDisabled();
  await expect(page.locator('#bankLinesTable tbody tr')).toHaveCount(4);

  // Post the three that have a recognisable kind, with one click each
  const rows = page.locator('#bankLinesTable tbody tr');
  for (const remaining of [3, 2, 1]) {
    const row = page.locator('#bankLinesTable tbody tr', { hasText: /cash deposit|bank charge|interest/i }).first();
    await row.locator('[data-action="post"]').click();
    await page.click('#bankPostConfirm');
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    // The table reloads after each post: wait for the resolved line to leave it before touching the next one
    await expect(rows).toHaveCount(remaining);
  }
  await expect(rows).toHaveCount(1);
  await expect(card).toHaveAttribute('data-state', 'incomplete');      // the supplier NEFT is still not in the books

  // The last one is an ordinary supplier transfer: the user says what it is
  await page.locator('#bankLinesTable tbody tr').first().locator('[data-action="post"]').click();
  await page.selectOption('#bankPostCategory', 'SUPPLIER_PAYMENT');
  await page.click('#bankPostConfirm');
  await expect(card).toHaveAttribute('data-state', 'reconciled');
  await expect(page.locator('#bankFinalize')).toBeEnabled();
  await page.click('#bankFinalize');
  // when the totals still differ the app asks first; this statement may or may not tie out, so accept either way
  const anyway = page.locator('#bankFinalizeAnyway');
  if (await anyway.isVisible({ timeout: 1500 }).catch(() => false)) await anyway.click();

  // Once submitted/reconciled, it comes out of the page and navigates to Transactions & search
  await expect(page.locator('#txnSearch')).toBeVisible();

  // Switch to Statements tab and verify it shows as Reconciled
  await page.click('#bankTabStatements');
  await expect(page.locator('#bankStatements [data-statement]')).toHaveCount(1);
  await expect(page.locator('#bankStatements')).toContainText('Reconciled');

  // Viewing a reconciled statement has Accept-All and Submit disabled, and Close button returns out
  await page.click('[data-action="open-statement"]');
  await expect(page.locator('#bankFinalize')).toBeDisabled();
  await expect(page.locator('#bankAcceptAll')).toBeDisabled();
  await page.click('#bankCloseStatement');
  await expect(page.locator('#bankStatements [data-statement]')).toHaveCount(1);
  await expect(page.locator('#bankStatements')).toContainText('Reconciled');
  await page.click('#bankUploadBtn');
  await page.setInputFiles('#bankFile', csvFile('icici-again.csv', file));
  await expect(page.locator('#bankPreviewTable')).toBeVisible();
  await expect(page.getByText('This exact file has already been imported')).toBeVisible();
  await expect(page.locator('#bankImportBtn')).toBeDisabled();
});

test('personal transactions: ignore with a reason, in bulk, save a rule, and the rule handles the next statement', async ({ page }) => {
  await reactLogin(page, 'manager@liquor.com');
  await page.click('#nav-bank');
  await expect(page.locator('#bankAccountSelect')).toBeVisible();

  // A statement with personal spend mixed in
  await page.click('#bankUploadBtn');
  await page.setInputFiles('#bankFile', csvFile('personal.csv', statement([
    [ahead(70), 'CASH DEP BY SELF', 20000],
    [ahead(70), `UPI/4121/SWIGGY/swiggy@icici/Payment ${stamp}`, -250],
    [ahead(70), `UPI/4122/SWIGGY INSTAMART/Payment ${stamp}`, -430],
    [ahead(71), `UPI/4123/ZOMATO/zomato@hdfc/Payment ${stamp}`, -310],
    [ahead(71), `NEFT-RAJ BEVERAGES-INV 9${stamp}`, -7000],
  ])));
  await expect(page.locator('#bankBalanceCheck')).toHaveAttribute('data-status', 'PASS');
  await page.click('#bankImportBtn');
  await page.click('#bankViewTable');
  const rows = page.locator('#bankLinesTable tbody tr');
  await expect(rows).toHaveCount(5);

  // Select the two Swiggy lines and ignore them together; a reason is always chosen, and a rule is saved at the same time
  await rows.filter({ hasText: 'SWIGGY' }).locator('[data-select]').first().check();
  await rows.filter({ hasText: 'SWIGGY INSTAMART' }).locator('[data-select]').check();
  await expect(page.locator('#bankBulkBar')).toContainText('2 selected');
  await page.click('#bankBulkIgnore');
  await expect(page.locator('#bankIgnoreReason')).toHaveValue('PERSONAL');
  await page.fill('#bankIgnoreNote', 'Owner meals');
  await page.check('#bankIgnoreMakeRule');
  await expect(page.locator('#bankRulePattern')).toHaveValue('SWIGGY');              // suggested from the narration
  await expect(page.locator('#bankRuleSide')).toHaveValue('OUT');
  await page.selectOption('#bankRuleAction', 'AUTO');
  await expect(page.locator('#bankRuleCatch')).toContainText('0');                   // the other open lines are not Swiggy
  await page.click('#bankIgnoreConfirm');
  await expect(rows).toHaveCount(3);                                                  // deposit, Zomato, NEFT are still open

  // One line on its own, with a different reason
  await rows.filter({ hasText: 'ZOMATO' }).locator('[data-action="ignore"]').click();
  await page.selectOption('#bankIgnoreReason', 'OTHER_BUSINESS');
  await page.click('#bankIgnoreConfirm');
  await expect(rows).toHaveCount(2);

  // Everything ignored is visible, with why
  await page.locator('[data-filter="IGNORED"]').click();
  await expect(rows).toHaveCount(3);
  await expect(page.locator('#bankLinesTable')).toContainText('Personal');
  await expect(page.locator('#bankLinesTable')).toContainText('Another business');
  await expect(page.locator('#bankLinesTable')).toContainText('Owner meals');
  await page.click('#bankWorkingsToggle');
  await expect(page.locator('#bankIgnoredSummary')).toContainText('3 lines');

  // A later statement: the saved rule ignores Swiggy by itself, and says so
  await page.getByRole('button', { name: '← All statements' }).click();
  await page.click('#bankUploadBtn');
  await page.setInputFiles('#bankFile', csvFile('personal2.csv', statement([
    [ahead(80), 'CASH DEP BY SELF 2', 5000],
    [ahead(80), `UPI/5001/SWIGGY/swiggy@icici/Payment B${stamp}`, -199],
    [ahead(80), `UPI/5002/SOME SUPPLIER/Payment B${stamp}`, -900],
  ])));
  await expect(page.locator('#bankPreviewTable tbody tr')).toHaveCount(3);
  await page.click('#bankImportBtn');
  await page.click('#bankViewTable');
  await expect(rows).toHaveCount(2);                                                  // Swiggy did not need attention
  await page.locator('[data-filter="IGNORED"]').click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('decided by a saved rule');

  // Taking it back sticks: re-running the match does not ignore it again
  await rows.first().locator('[data-action="unmatch"]').click();
  await page.click('#bankRematch');
  await page.locator('[data-filter="REVIEW"]').click();
  await expect(rows.filter({ hasText: 'SWIGGY' })).toHaveCount(1);

  // The rule can be seen and changed from the account page
  await page.getByRole('button', { name: '← All statements' }).click();
  await page.click('#bankRulesToggle');
  const ruleRow = page.locator('[data-rule="SWIGGY"]');
  await expect(ruleRow).toBeVisible();
  await expect(ruleRow).toContainText('money out only');
  await ruleRow.locator('[data-rule-action]').selectOption('SUGGEST');
  await expect(ruleRow.locator('[data-rule-action]')).toHaveValue('SUGGEST');
  await ruleRow.locator('[data-rule-delete]').click();
  await page.locator('div.fixed', { hasText: 'Delete the rule' }).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('[data-rule="SWIGGY"]')).toHaveCount(0);
});

test('a statement that does not add up is flagged with the exact line, and cannot be imported unless the user insists', async ({ page }) => {
  await reactLogin(page, 'manager@liquor.com');
  await page.click('#nav-bank');
  await expect(page.locator('#bankAccountSelect')).toBeVisible();
  await page.click('#bankUploadBtn');
  const bad = statement([[ahead(50), 'SALE RECEIPT', 500], [ahead(50), 'SUPPLIER NEFT', -200], [ahead(51), 'SMS CHARGE', -10]], 1);
  await page.setInputFiles('#bankFile', csvFile('broken.csv', bad));

  const banner = page.locator('#bankBalanceCheck');
  await expect(banner).toHaveAttribute('data-status', 'FAIL');
  await expect(banner).toContainText('does not add up');
  await expect(banner).toContainText('Line 2');
  await expect(page.locator('#bankImportBtn')).toBeDisabled();
  await page.check('#bankAcceptMismatch');
  await expect(page.locator('#bankImportBtn')).toBeEnabled();
});

test('a file with no recognisable dates opens the manual column mapping instead of guessing', async ({ page }) => {
  await reactLogin(page, 'manager@liquor.com');
  await page.click('#nav-bank');
  await expect(page.locator('#bankAccountSelect')).toBeVisible();
  await page.click('#bankUploadBtn');
  await page.setInputFiles('#bankFile', csvFile('nodates.csv', 'Reference,Detail,Out,In\nA1,coffee,10.00,\nA2,tea,,5.00\n'));
  await expect(page.locator('#bankUploadError')).toContainText('not recognised');
  await expect(page.locator('[id^="bankMap-"]')).toHaveCount(9);
  await expect(page.locator('#bankApplyMapping')).toBeVisible();
  await expect(page.locator('#bankImportBtn')).toHaveCount(0);
});

test('a layout that can be worked out from the cell contents loses no transaction', async ({ page }) => {
  await reactLogin(page, 'manager@liquor.com');
  await page.click('#nav-bank');
  await expect(page.locator('#bankAccountSelect')).toBeVisible();
  await page.click('#bankUploadBtn');
  const d = ahead(60);
  await page.setInputFiles('#bankFile', csvFile('odd.csv', `Zeta,Foo,Bar,Baz\n${d},Mystery receipt,,75.00\n${d},Mystery payment,30.00,\n`));
  await expect(page.locator('#bankPreviewTable tbody tr')).toHaveCount(2);           // the credit-only row must not be dropped
  await expect(page.locator('#bankBalanceCheck')).toHaveAttribute('data-status', 'UNVERIFIABLE');
  await expect(page.locator('#bankImportBtn')).toContainText('Import 2 transactions');
});
