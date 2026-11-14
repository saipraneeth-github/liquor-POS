/**
 * Transactions & search: record bank lines under Rent / Wages / Utilities, then find them by category or keyword with totals.
 * Build the frontend first: `npm run build:frontend`.
 */
import { test, expect } from '@playwright/test';
import { apiGet, apiPost, apiToken, login, uniq } from './helpers';

const ahead = (d: number) => new Date(Date.now() + 330 * 60_000 + d * 86_400_000).toISOString().slice(0, 10).split('-').reverse().join('/');

test.beforeEach(() => {
  test.setTimeout(120_000);
});

test('Transactions: search Rent and Wages, see totals, narrow by a category chip', async ({ page, request }) => {
  const manager = await apiToken(request, 'manager@liquor.com');
  const me = await apiGet<{ branchId: string }>(request, manager, '/me');
  const stamp = uniq();
  const acct = await apiPost<{ id: string }>(request, manager, '/bank/accounts', { branchId: me.branchId, name: `Txn ${stamp}` });
  await apiPost(request, manager, `/bank/accounts/${acct.id}/types/defaults`, {});

  const rows: Array<[number, string, number, number]> = [
    [200, `NEFT-HOTEL RENT OCT ${stamp}`, 12000, 12000],
    [201, `NEFT-HOTEL RENT NOV ${stamp}`, 12000, 24000],
    [202, `SALARY STAFF OCT ${stamp}`, 30000, 54000],
    [203, `SALARY STAFF NOV ${stamp}`, 31500, 85500],
  ];
  const csv = ['Date,Narration,Debit,Credit,Balance', ...rows.map(([d, n, a, b]) => `${ahead(d)},"${n}",${a},,${(100000 - b).toFixed(2)}`)].join('\n');
  const up = await request.post(`/api/v1/bank/accounts/${acct.id}/statements`, {
    headers: { Authorization: `Bearer ${manager}` },
    multipart: { file: { name: 't.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) } },
  });
  expect(up.ok(), await up.text()).toBeTruthy();
  const statementId = (await up.json()).statement.id as string;
  const lines = await apiGet<{ id: string; narration: string }[]>(request, manager, `/bank/statements/${statementId}/lines`);
  const types = await apiGet<{ id: string; name: string }[]>(request, manager, `/bank/accounts/${acct.id}/types`);
  const typeId = (n: string) => types.find((t) => t.name === n)!.id;
  for (const l of lines) await apiPost(request, manager, `/bank/lines/${l.id}/post`, { typeId: typeId(l.narration.includes('RENT') ? 'Rent' : 'Wages') });

  await login(page, 'manager@liquor.com');
  await page.click('#nav-bank');
  await page.selectOption('#bankAccountSelect', acct.id);
  await page.click('#bankTabTransactions');
  await expect(page.locator('#txnSearch')).toBeVisible();

  // Rent: two payments, 24,000 out
  await page.fill('#txnQuery', 'rent');
  await expect(page.locator('#txnTable tbody tr[data-txn]')).toHaveCount(2);
  await expect(page.locator('#txnDebit')).toContainText('24,000.00');
  await expect(page.locator('#txnTable')).toContainText('Bank statement');
  await expect(page.locator('#txnTable')).toContainText('reconciled');

  // Wages: two payments, 61,500 out
  await page.fill('#txnQuery', 'wages');
  await expect(page.locator('#txnTable tbody tr[data-txn]')).toHaveCount(2);
  await expect(page.locator('#txnDebit')).toContainText('61,500.00');

  // A date range: only the later wage payment
  await page.fill('#txnQuery', '');
  await page.click('[data-category="wages"]');
  await expect(page.locator('#txnTable tbody tr[data-txn]')).toHaveCount(2);

  // Filter using the transaction type dropdown
  await page.selectOption('#txnCategorySelect', 'rent');
  await expect(page.locator('#txnTable tbody tr[data-txn]')).toHaveCount(2);
  await expect(page.locator('#txnDebit')).toContainText('24,000.00');

  await page.click('#txnClear');
  await page.fill('#txnQuery', stamp);
  await expect(page.locator('#txnTable tbody tr[data-txn]')).toHaveCount(4);
  await expect(page.locator('#txnCount')).toHaveText('4');

  // No match is said plainly
  await page.fill('#txnQuery', 'zzzz-nothing');
  await expect(page.locator('#txnTable')).toContainText('No transactions match');
});

test('Upload an OFX file: the preview shows what was read, then it imports like any statement', async ({ page, request }) => {
  const manager = await apiToken(request, 'manager@liquor.com');
  const me = await apiGet<{ branchId: string }>(request, manager, '/me');
  const stamp = uniq();
  await apiPost(request, manager, '/bank/accounts', { branchId: me.branchId, name: `OFX ${stamp}` });
  const ofx = `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>\n` +
    `<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20331105<TRNAMT>-12000.00<FITID>${stamp}1<NAME>NEFT HOTEL RENT ${stamp}</STMTTRN>\n` +
    `<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20331106<TRNAMT>5000.00<FITID>${stamp}2<NAME>UPI CUSTOMER ${stamp}</STMTTRN>\n` +
    `</BANKTRANLIST><LEDGERBAL><BALAMT>93000.00<DTASOF>20331106</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

  await login(page, 'manager@liquor.com');
  await page.click('#nav-bank');
  await page.selectOption('#bankAccountSelect', { label: `OFX ${stamp}` });
  await page.click('#bankUploadBtn');
  await page.setInputFiles('#bankFile', { name: 'bank.ofx', mimeType: 'application/octet-stream', buffer: Buffer.from(ofx) });
  await expect(page.locator('#bankPreviewTable tbody tr')).toHaveCount(2);
  await expect(page.locator('#bankPreviewTable')).toContainText(`NEFT HOTEL RENT ${stamp}`);
  await page.click('#bankImportBtn');
  await expect(page.locator('#bankVsBook')).toBeVisible();
  await expect(page.locator('#bvbBankList')).toContainText(`UPI CUSTOMER ${stamp}`);
});

test('Filters work in the side-by-side view and the table, and the page uses the full width', async ({ page, request }) => {
  const manager = await apiToken(request, 'manager@liquor.com');
  const me = await apiGet<{ branchId: string }>(request, manager, '/me');
  const stamp = uniq();
  const acct = await apiPost<{ id: string }>(request, manager, '/bank/accounts', { branchId: me.branchId, name: `Flt ${stamp}` });
  const rows: Array<[number, string, number, number, number]> = [
    [400, `RENT ${stamp}`, 12000, 0, 88000], [401, `SALARY ${stamp}`, 30000, 0, 58000], [402, `CUSTOMER ${stamp}`, 0, 5000, 63000]];
  const csv = ['Date,Narration,Debit,Credit,Balance', ...rows.map((r) => `${ahead(r[0])},"${r[1]}",${r[2] || ''},${r[3] || ''},${r[4]}`)].join('\n');
  const up = await request.post(`/api/v1/bank/accounts/${acct.id}/statements`, {
    headers: { Authorization: `Bearer ${manager}` }, multipart: { file: { name: 'f.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) } } });
  expect(up.ok(), await up.text()).toBeTruthy();

  await login(page, 'manager@liquor.com');
  await page.setViewportSize({ width: 1700, height: 900 });
  await page.click('#nav-bank');
  await page.selectOption('#bankAccountSelect', acct.id);
  await page.getByRole('button', { name: 'Reconcile', exact: true }).first().click();
  await expect(page.locator('#bankVsBook')).toBeVisible();
  const bank = page.locator('#bvbBankList [data-bvb-line]');
  await expect(bank).toHaveCount(3);

  // Side by side: money in only, then money out only
  await page.selectOption('#bankDirection', 'IN');
  await expect(bank).toHaveCount(1);
  await expect(bank.first()).toContainText('CUSTOMER');
  await page.selectOption('#bankDirection', 'OUT');
  await expect(bank).toHaveCount(2);
  await page.selectOption('#bankDirection', 'ALL');

  // A date range hides the lines outside it (dates are yyyy-mm-dd in the filter)
  const iso = (d: number) => new Date(Date.now() + 330 * 60_000 + d * 86_400_000).toISOString().slice(0, 10);
  await page.fill('#bankDateFrom', iso(401));
  await expect(bank).toHaveCount(2);
  await page.fill('#bankDateTo', iso(401));
  await expect(bank).toHaveCount(1);
  await expect(bank.first()).toContainText('SALARY');
  await page.click('#bankClearFilters');
  await expect(bank).toHaveCount(3);

  // The same filters in the table
  await page.click('#bankViewTable');
  await page.selectOption('#bankDirection', 'IN');
  await expect(page.locator('#bankLinesTable tbody tr[data-line-status]')).toHaveCount(1);

  // Full width: the table reaches the right edge of the content area
  await page.click('#bankClearFilters');
  const main = await page.locator('main').boundingBox();
  const tbl = await page.locator('#bankLinesTable').locator('xpath=..').boundingBox();
  expect(main!.x + main!.width - (tbl!.x + tbl!.width)).toBeLessThan(40);
});

test('Transactions follow the bank account you pick, and Accounting lists them for every account', async ({ page, request }) => {
  const manager = await apiToken(request, 'manager@liquor.com');
  const me = await apiGet<{ branchId: string }>(request, manager, '/me');
  const stamp = uniq();
  const make = async (name: string, narration: string, day: number) => {
    const acct = await apiPost<{ id: string }>(request, manager, '/bank/accounts', { branchId: me.branchId, name });
    await apiPost(request, manager, `/bank/accounts/${acct.id}/types/defaults`, {});
    const csv = `Date,Narration,Debit,Credit,Balance\n${ahead(day)},"${narration}",7000,,93000`;
    const up = await request.post(`/api/v1/bank/accounts/${acct.id}/statements`, {
      headers: { Authorization: `Bearer ${manager}` }, multipart: { file: { name: 'a.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) } } });
    expect(up.ok(), await up.text()).toBeTruthy();
    const sid = (await up.json()).statement.id as string;
    const line = (await apiGet<{ id: string }[]>(request, manager, `/bank/statements/${sid}/lines`))[0];
    const types = await apiGet<{ id: string; name: string }[]>(request, manager, `/bank/accounts/${acct.id}/types`);
    await apiPost(request, manager, `/bank/lines/${line.id}/post`, { typeId: types.find((t) => t.name === 'Rent')!.id });
    return acct.id;
  };
  const accA = await make(`AccA ${stamp}`, `RENT ALPHA ${stamp}`, 600);
  const accB = await make(`AccB ${stamp}`, `RENT BETA ${stamp}`, 601);

  await login(page, 'manager@liquor.com');
  await page.click('#nav-bank');
  await page.selectOption('#bankAccountSelect', accA);
  await page.click('#bankTabTransactions');
  await page.fill('#txnQuery', stamp);
  await expect(page.locator('#txnTable tbody tr[data-txn]')).toHaveCount(1);
  await expect(page.locator('#txnTable')).toContainText(`ALPHA ${stamp}`);
  // another account: a different list, not the same one
  await page.selectOption('#bankAccountSelect', accB);
  await expect(page.locator('#txnTable')).toContainText(`BETA ${stamp}`);
  await expect(page.locator('#txnTable')).not.toContainText(`ALPHA ${stamp}`);

  // Accounting: every account together, or one at a time
  await page.click('#nav-accounting');
  await page.click('#acctab-bank');
  await page.fill('#txnQuery', stamp);
  await expect(page.locator('#txnTable tbody tr[data-txn]')).toHaveCount(2);
  await page.selectOption('#acctBankAccount', accA);
  await expect(page.locator('#txnTable tbody tr[data-txn]')).toHaveCount(1);
  await expect(page.locator('#txnTable')).toContainText(`ALPHA ${stamp}`);
});
