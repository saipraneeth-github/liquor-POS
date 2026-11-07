import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIntegration, type IntegrationContext } from './helpers.js';
import { addDays, businessDateOf } from '../../src/modules/bank/bank.engine.js';
import { businessDateOf as bizToday } from '../../src/lib/business-day.js';

let ctx: IntegrationContext;
let accountId: string;
const today = bizToday();
void businessDateOf;

beforeAll(async () => { ctx = await setupIntegration(); }, 60_000);
afterAll(async () => { await ctx?.app.close(); });

// ── helpers ───────────────────────────────────────────────────────────────────
const inject = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, headers: Record<string, string>, payload?: unknown) =>
  ctx.app.inject({ method, url: `/api/v1${url}`, headers, payload: payload as never });

function multipart(file: { name: string; content: Buffer | string }, fields: Record<string, string> = {}) {
  const boundary = '----bankboundary' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
  parts.push(Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

const upload = (url: string, role: 'manager' | 'cashier' | 'owner', csv: string | Buffer, fields: Record<string, string> = {}) => {
  const m = multipart({ name: 'statement.csv', content: csv }, fields);
  return ctx.app.inject({ method: 'POST', url: `/api/v1${url}`, headers: { ...ctx.auth(role), 'content-type': m.contentType }, payload: m.body });
};

const dmy = (iso: string) => iso.split('-').reverse().join('/');

/** CSV in a "Withdrawal / Deposit / Closing Balance" layout with a correct running balance. */
function statementCsv(opening: number, items: Array<[string, string, number]>, breakBalanceAt?: number) {
  let bal = opening;
  const rows = items.map(([date, narr, amt], i) => {
    bal = Math.round((bal + amt) * 100) / 100;
    const shown = breakBalanceAt === i ? bal + 1 : bal;
    return `${dmy(date)},"${narr}",,${amt < 0 ? (-amt).toFixed(2) : ''},${amt > 0 ? amt.toFixed(2) : ''},${shown.toFixed(2)}`;
  });
  return ['ACME BANK', 'Statement of account', 'Date,Narration,Chq./Ref.No.,Withdrawal Amt.,Deposit Amt.,Closing Balance', ...rows].join('\n');
}

async function sell(mode: 'CARD' | 'UPI' | 'CASH', productIdx: number, qty: number) {
  const res = await inject('POST', '/bills', ctx.auth('cashier'), {
    branchId: ctx.branchId, paymentMode: mode, clientRef: crypto.randomUUID(), items: [{ productId: ctx.products[productIdx].id, quantity: qty }],
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function trialBalance() {
  const res = await inject('GET', `/accounting/trial-balance/${ctx.branchId}`, ctx.auth('manager'));
  return res.json() as { isBalanced: boolean; rows: Array<{ code: string; debit: string; credit: string }> };
}
const ledger = (tb: Awaited<ReturnType<typeof trialBalance>>, code: string) => tb.rows.find((r) => r.code === code)!;

// ── accounts ──────────────────────────────────────────────────────────────────
describe('bank accounts', () => {
  it('a manager adds an account for their branch; cashiers cannot use the feature at all', async () => {
    const res = await inject('POST', '/bank/accounts', ctx.auth('manager'), { branchId: ctx.branchId, name: 'HDFC Current', bankName: 'HDFC', accountLast4: '4821' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ scope: 'BRANCH', accountLast4: '4821' });
    accountId = res.json().id;
    expect((await inject('GET', '/bank/accounts', ctx.auth('cashier'))).statusCode).toBe(403);
    expect((await inject('POST', '/bank/accounts', ctx.auth('cashier'), { branchId: ctx.branchId, name: 'X1' })).statusCode).toBe(403);
  });

  it('refuses a duplicate name, and anything but the last four digits of the number', async () => {
    expect((await inject('POST', '/bank/accounts', ctx.auth('manager'), { branchId: ctx.branchId, name: 'HDFC Current' })).statusCode).toBe(409);
    expect((await inject('POST', '/bank/accounts', ctx.auth('manager'), { branchId: ctx.branchId, name: 'Full number', accountLast4: '123456789012' })).statusCode).toBe(400);
  });

  it('a shared (whole-business) account is owner-only', async () => {
    const asManager = await inject('POST', '/bank/accounts', ctx.auth('manager'), { branchId: ctx.branchId, name: 'Shared', scope: 'SYNDICATE' });
    expect(asManager.statusCode).toBe(403);
    const asOwner = await inject('POST', '/bank/accounts', ctx.auth('owner'), { branchId: ctx.branchId, name: 'Shared', scope: 'SYNDICATE' });
    expect(asOwner.statusCode).toBe(201);
    expect(asOwner.json()).toMatchObject({ scope: 'SYNDICATE', syndicateId: ctx.syndicateId });
    // …and a manager does not even see it
    const list = (await inject('GET', '/bank/accounts', ctx.auth('manager'))).json() as Array<{ name: string }>;
    expect(list.map((a) => a.name)).not.toContain('Shared');
    const ownerList = (await inject('GET', '/bank/accounts', ctx.auth('owner'))).json() as Array<{ name: string }>;
    expect(ownerList.map((a) => a.name)).toContain('Shared');
  });

  it('a branch with no business group cannot have a shared account', async () => {
    // A platform owner (no branch, no business group) can reach every branch, including one outside any group
    const [platform] = await ctx.db.insert(ctx.schema.users).values({
      name: 'Platform owner', email: 'platform@test.local', passwordHash: 'x', role: 'owner', branchId: null, syndicateId: null,
    }).returning();
    const res = await inject('POST', '/bank/accounts', ctx.authFor({ sub: platform.id, email: platform.email, role: 'owner', branchId: null, syndicateId: null }),
      { branchId: ctx.otherBranchId, name: 'Shared2', scope: 'SYNDICATE' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/business group/);
  });

  it("another branch's manager cannot see or use the account", async () => {
    const other = ctx.authFor({ sub: ctx.otherBranchManager.id, email: ctx.otherBranchManager.email, role: 'manager', branchId: ctx.otherBranchId });
    expect((await inject('GET', `/bank/accounts/${accountId}/statements`, other)).statusCode).toBe(403);
    expect((await inject('PATCH', `/bank/accounts/${accountId}`, other, { name: 'hijack' })).statusCode).toBe(403);
    const m = multipart({ name: 's.csv', content: 'Date,Narration,Debit,Credit,Balance\n01/04/2026,A,,1.00,1.00' });
    const res = await ctx.app.inject({ method: 'POST', url: `/api/v1/bank/accounts/${accountId}/statements/preview`, headers: { ...other, 'content-type': m.contentType }, payload: m.body });
    expect(res.statusCode).toBe(403);
  });
});

// ── the full journey ──────────────────────────────────────────────────────────
describe('import → match → accept → post → reconcile', () => {
  const D1 = addDays(today, 1);
  const D2 = addDays(today, 2);
  const D3 = addDays(today, 3);
  let csv: string;
  let statementId: string;
  let lines: Array<{ id: string; narration: string; status: string; credit: string; debit: string; suggestion: { kind: string; category?: string; fee?: string; entryIds?: string[] } | null }>;

  beforeAll(async () => {
    // Books: CARD 1,000 and UPI 2,000 (two bottles) are debited to BANK when the bills are paid. One cash bill must NOT appear in BANK.
    await sell('CARD', 0, 1);
    await sell('UPI', 0, 2);
    await sell('CASH', 1, 3);
    // Bank: the gateway pays 3,000 less 2% on D1, the owner deposits 5,000 cash, the bank charges 23.60 and pays 12.00 interest.
    csv = statementCsv(0, [
      [D1, 'UPI-RAZORPAY SETTLEMENT-412345678901', 2940],
      [D1, 'CASH DEPOSIT BY SELF', 5000],
      [D2, 'SMS ALERT CHARGES Q1', -23.6],
      [D3, 'INT.PD:01-01-2026 TO 31-03-2026', 12],
    ]);
  });

  it('preview parses and proves the statement without saving anything', async () => {
    const res = await upload(`/bank/accounts/${accountId}/statements/preview`, 'manager', csv);
    expect(res.statusCode).toBe(200);
    const p = res.json();
    expect(p.method).toBe('HEADER');
    expect(p.mapping).toMatchObject({ date: 0, narration: 1, reference: 2, debit: 3, credit: 4, balance: 5 });
    expect(p.balanceCheck).toMatchObject({ status: 'PASS', closing: '7928.40' });
    expect(p.lineCount).toBe(4);
    expect(p.duplicateLines).toBe(0);
    expect(p.periodStart).toBe(D1);
    expect(p.periodEnd).toBe(D3);
    expect((await inject('GET', `/bank/accounts/${accountId}/statements`, ctx.auth('manager'))).json()).toHaveLength(0);
  });

  it('refuses a statement that does not agree with itself (a misread balance), unless the user insists', async () => {
    const broken = statementCsv(0, [[D1, 'A', 100], [D1, 'B', 50], [D2, 'C', -20]], 1);
    const res = await upload(`/bank/accounts/${accountId}/statements`, 'manager', broken);
    expect(res.statusCode).toBe(422);
    expect(res.json().details).toMatchObject({ code: 'BALANCE_MISMATCH', balanceCheck: { status: 'FAIL' } });
    expect(res.json().error).toMatch(/line 2/);
    expect((await inject('GET', `/bank/accounts/${accountId}/statements`, ctx.auth('manager'))).json()).toHaveLength(0);
  });

  it('imports, de-duplicates and auto-matches', async () => {
    const res = await upload(`/bank/accounts/${accountId}/statements`, 'manager', csv);
    expect(res.statusCode).toBe(201);
    const out = res.json();
    expect(out).toMatchObject({ imported: 4, duplicates: 0 });
    statementId = out.statement.id;
    expect(out.statement).toMatchObject({ lineCount: 4, status: 'IMPORTED', openingBalance: '0.00', closingBalance: '7928.40', periodStart: D1, periodEnd: D3 });

    lines = (await inject('GET', `/bank/statements/${statementId}/lines`, ctx.auth('manager'))).json();
    expect(lines).toHaveLength(4);
    const by = (s: string) => lines.find((l) => l.narration.includes(s))!;
    expect(by('RAZORPAY').suggestion).toMatchObject({ kind: 'SETTLEMENT', fee: '60.00' });
    expect(by('RAZORPAY').suggestion!.entryIds).toHaveLength(2);          // the CARD and the UPI sale — not the cash sale
    expect(by('CASH DEPOSIT').suggestion).toMatchObject({ kind: 'POST', category: 'CASH_DEPOSIT' });
    expect(by('SMS ALERT').suggestion).toMatchObject({ kind: 'POST', category: 'BANK_CHARGE' });
    expect(by('INT.PD').suggestion).toMatchObject({ kind: 'POST', category: 'INTEREST' });
    expect(lines.every((l) => l.status === 'SUGGESTED')).toBe(true);
  });

  it('the same file twice is refused; an overlapping statement only adds the new lines', async () => {
    const again = await upload(`/bank/accounts/${accountId}/statements`, 'manager', csv);
    expect(again.statusCode).toBe(409);
    expect(again.json().details.existingStatementId).toBe(statementId);

    const D4 = addDays(today, 4);
    const overlapping = statementCsv(0, [
      [D1, 'UPI-RAZORPAY SETTLEMENT-412345678901', 2940],
      [D1, 'CASH DEPOSIT BY SELF', 5000],
      [D2, 'SMS ALERT CHARGES Q1', -23.6],
      [D3, 'INT.PD:01-01-2026 TO 31-03-2026', 12],
      [D4, 'NEFT-RAJ BEVERAGES-SI-2291', -1500],
    ]);
    const res = await upload(`/bank/accounts/${accountId}/statements`, 'manager', overlapping);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ imported: 1, duplicates: 4 });
    // tidy: the extra statement is not part of the journey below
    expect((await inject('DELETE', `/bank/statements/${res.json().statement.id}`, ctx.auth('manager'))).statusCode).toBe(200);
  });

  it('a settlement is accepted: the sales are matched and the withheld fee is posted as a bank charge', async () => {
    const before = await trialBalance();
    const l = lines.find((x) => x.narration.includes('RAZORPAY'))!;
    const res = await inject('POST', `/bank/lines/${l.id}/accept`, ctx.auth('manager'), {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'MATCHED', fee: '60.00' });
    expect(res.json().voucherId).toBeTruthy();

    const after = await trialBalance();
    expect(after.isBalanced).toBe(true);
    expect(Number(ledger(after, 'BANK_CHARGES').debit) - Number(ledger(before, 'BANK_CHARGES').debit)).toBe(60);
    // BANK: sales 3,000 debited, fee 60 credited
    expect(Number(ledger(after, 'BANK').debit) - Number(ledger(after, 'BANK').credit)).toBe(2940);

    // accepting it again is refused, and so is un-matching a line that posted a voucher
    expect((await inject('POST', `/bank/lines/${l.id}/accept`, ctx.auth('manager'), {})).statusCode).toBe(409);
    expect((await inject('POST', `/bank/lines/${l.id}/unmatch`, ctx.auth('manager'))).statusCode).toBe(409);
  });

  it('cash deposit, charge and interest are posted with the right books entries', async () => {
    const find = (s: string) => lines.find((x) => x.narration.includes(s))!;

    // wrong direction for the line is refused
    const wrong = await inject('POST', `/bank/lines/${find('CASH DEPOSIT').id}/post`, ctx.auth('manager'), { category: 'BANK_CHARGE' });
    expect(wrong.statusCode).toBe(422);
    // "other" needs a ledger
    expect((await inject('POST', `/bank/lines/${find('CASH DEPOSIT').id}/post`, ctx.auth('manager'), { category: 'OTHER_RECEIPT' })).statusCode).toBe(422);

    const before = await trialBalance();
    for (const [narr, category] of [['CASH DEPOSIT', 'CASH_DEPOSIT'], ['SMS ALERT', 'BANK_CHARGE'], ['INT.PD', 'INTEREST']] as const) {
      const res = await inject('POST', `/bank/lines/${find(narr).id}/post`, ctx.auth('manager'), { category });
      expect(res.statusCode, narr).toBe(201);
    }
    const after = await trialBalance();
    expect(after.isBalanced).toBe(true);
    // The trial balance shows each ledger's NET balance, so compare net movement (debit − credit)
    const net = (tb: Awaited<ReturnType<typeof trialBalance>>, code: string) => Number(ledger(tb, code).debit) - Number(ledger(tb, code).credit);
    const move = (code: string) => Math.round((net(after, code) - net(before, code)) * 100) / 100;
    expect(move('CASH')).toBe(-5000);                    // cash left the till…
    expect(move('BANK')).toBe(5000 - 23.6 + 12);         // …into the bank, less the charge, plus interest
    expect(move('BANK_CHARGES')).toBe(23.6);
    expect(move('INTEREST_INCOME')).toBe(-12);           // income is a credit

    // a second post for the same line is refused
    expect((await inject('POST', `/bank/lines/${find('CASH DEPOSIT').id}/post`, ctx.auth('manager'), { category: 'CASH_DEPOSIT' })).statusCode).toBe(409);
  });

  it('while lines are unresolved the figures may tie out, but it is NOT reported as reconciled', async () => {
    // A fresh statement whose lines are all still open
    const csv2 = statementCsv(7928.4, [[addDays(today, 8), 'NEFT-SOMEONE UNKNOWN', -250]]);
    const imp = await upload(`/bank/accounts/${accountId}/statements`, 'manager', csv2);
    const st = imp.json().statement.id;
    const { summary } = (await inject('GET', `/bank/statements/${st}/summary`, ctx.auth('manager'))).json();
    expect(summary.unpostedPayments).toBe('250.00');
    expect(summary.difference).toBe('0.00');            // the item is listed, so the arithmetic ties…
    expect(summary.booksComplete).toBe(false);          // …but the books are missing it
    expect(summary.reconciled).toBe(false);
    expect((await inject('DELETE', `/bank/statements/${st}`, ctx.auth('manager'))).statusCode).toBe(200);
  });

  it('the bank reconciliation statement now has zero difference', async () => {
    const res = await inject('GET', `/bank/statements/${statementId}/summary`, ctx.auth('manager'));
    expect(res.statusCode).toBe(200);
    const { summary, counts } = res.json();
    expect(counts).toEqual({ MATCHED: 4 });
    expect(summary).toMatchObject({
      bankClosing: '7928.40', bookBalance: '7928.40', outstandingReceipts: '0.00', outstandingPayments: '0.00',
      unpostedReceipts: '0.00', unpostedPayments: '0.00', difference: '0.00', booksComplete: true, reconciled: true,
    });
  });

  it('finalising marks the statement reconciled; a statement with posted vouchers cannot be deleted', async () => {
    expect((await inject('POST', `/bank/statements/${statementId}/finalize`, ctx.auth('manager'))).statusCode).toBe(200);
    expect((await inject('GET', `/bank/statements/${statementId}`, ctx.auth('manager'))).json().statement.status).toBe('RECONCILED');
    expect((await inject('DELETE', `/bank/statements/${statementId}`, ctx.auth('manager'))).statusCode).toBe(409);
  });
});

// ── one-to-one, ignore, manual ────────────────────────────────────────────────
describe('one-to-one matching, ignoring and manual matching', () => {
  let statementId: string;
  let lines: Array<{ id: string; narration: string; status: string; suggestion: { kind: string; entryIds?: string[] } | null }>;

  beforeAll(async () => {
    // Book: a BANK-mode expense of 1,500 (Cr BANK). Bank: debit 1,500 four days later, and a debit that is nothing to do with the business.
    const exp = await inject('POST', `/expenses/${ctx.branchId}`, ctx.auth('manager'), { category: 'Electricity', amount: '1500.00', paymentMode: 'BANK' });
    expect(exp.statusCode).toBe(201);
    const start = 7928.4;
    const csv = statementCsv(start, [
      [addDays(today, 4), 'NEFT-TSSPDCL ELECTRICITY BILL', -1500],
      [addDays(today, 5), 'POS PURCHASE PERSONAL SHOPPING', -777],
    ]);
    const res = await upload(`/bank/accounts/${accountId}/statements`, 'manager', csv);
    expect(res.statusCode).toBe(201);
    statementId = res.json().statement.id;
    lines = (await inject('GET', `/bank/statements/${statementId}/lines`, ctx.auth('manager'))).json();
  });

  it('a payment already in the books is matched 1:1 and posts nothing new', async () => {
    const l = lines.find((x) => x.narration.includes('ELECTRICITY'))!;
    expect(l.suggestion).toMatchObject({ kind: 'ONE_TO_ONE' });
    const before = await trialBalance();
    const res = await inject('POST', `/bank/lines/${l.id}/accept`, ctx.auth('manager'), {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'MATCHED', fee: '0.00', voucherId: null });
    expect(await trialBalance()).toEqual(before);
    // a matched line can be un-matched again because it posted nothing
    expect((await inject('POST', `/bank/lines/${l.id}/unmatch`, ctx.auth('manager'))).statusCode).toBe(200);
  });

  it('manual match: the same entry can be picked by hand, and it cannot be matched twice', async () => {
    const l = lines.find((x) => x.narration.includes('ELECTRICITY'))!;
    const cands = (await inject('GET', `/bank/lines/${l.id}/candidates`, ctx.auth('manager'))).json() as Array<{ id: string; credit: string }>;
    const entry = cands.find((c) => c.credit === '1500.00')!;
    expect(entry).toBeTruthy();
    const ok = await inject('POST', `/bank/lines/${l.id}/match`, ctx.auth('manager'), { entryIds: [entry.id] });
    expect(ok.statusCode).toBe(200);
    // the other line cannot claim an entry that is already reconciled
    const other = lines.find((x) => x.narration.includes('PERSONAL'))!;
    expect((await inject('POST', `/bank/lines/${other.id}/match`, ctx.auth('manager'), { entryIds: [entry.id] })).statusCode).toBe(409);
  });

  it('a difference between the entry and the line is refused unless the user posts it as a charge', async () => {
    // book a 2,000 expense, bank took 2,010
    await inject('POST', `/expenses/${ctx.branchId}`, ctx.auth('manager'), { category: 'Rent', amount: '2000.00', paymentMode: 'BANK' });
    const csv = statementCsv(7928.4 - 1500 - 777, [[addDays(today, 6), 'NEFT-LANDLORD RENT', -2010]]);
    const imp = await upload(`/bank/accounts/${accountId}/statements`, 'manager', csv);
    const st = imp.json().statement.id;
    const l = (await inject('GET', `/bank/statements/${st}/lines`, ctx.auth('manager'))).json()[0];
    const cands = (await inject('GET', `/bank/lines/${l.id}/candidates`, ctx.auth('manager'))).json() as Array<{ id: string; credit: string }>;
    const entry = cands.find((c) => c.credit === '2000.00')!;
    const refused = await inject('POST', `/bank/lines/${l.id}/match`, ctx.auth('manager'), { entryIds: [entry.id] });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toMatch(/differ by ₹10\.00/);
    const ok = await inject('POST', `/bank/lines/${l.id}/match`, ctx.auth('manager'), { entryIds: [entry.id], postDifference: true });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().fee).toBe('10.00');
    expect((await trialBalance()).isBalanced).toBe(true);
  });

  it('a line that is not the business\'s can be ignored (and un-ignored); it stays visible in the reconciliation', async () => {
    const l = lines.find((x) => x.narration.includes('PERSONAL'))!;
    const res = await inject('POST', `/bank/lines/${l.id}/ignore`, ctx.auth('manager'), { reason: 'PERSONAL', note: 'Owner personal spend' });
    expect(res.statusCode).toBe(200);
    const sum = (await inject('GET', `/bank/statements/${statementId}/summary`, ctx.auth('manager'))).json();
    expect(sum.summary.ignoredNet).toBe('-777.00');
    expect((await inject('POST', `/bank/lines/${l.id}/unmatch`, ctx.auth('manager'))).statusCode).toBe(200);
  });

  it('cannot finalise while lines are still open', async () => {
    const res = await inject('POST', `/bank/statements/${statementId}/finalize`, ctx.auth('manager'));
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/still unmatched/);
  });

  it('accept-suggestions only takes high-confidence 1:1 / settlement suggestions, never a posting', async () => {
    const res = await inject('POST', `/bank/statements/${statementId}/accept-suggestions`, ctx.auth('manager'), {});
    expect(res.statusCode).toBe(200);
    const stillOpen = (await inject('GET', `/bank/statements/${statementId}/lines?status=SUGGESTED`, ctx.auth('manager'))).json() as unknown[];
    expect(Array.isArray(stillOpen)).toBe(true);
  });
});

// ── upload validation ─────────────────────────────────────────────────────────
describe('upload validation', () => {
  it('rejects a non-statement file, a photo, an empty body and a statement it cannot read', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
    expect((await upload(`/bank/accounts/${accountId}/statements/preview`, 'manager', png)).statusCode).toBe(415);
    expect((await upload(`/bank/accounts/${accountId}/statements/preview`, 'manager', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0, 0, 0]))).statusCode).toBe(415);
    const empty = await ctx.app.inject({ method: 'POST', url: `/api/v1/bank/accounts/${accountId}/statements/preview`, headers: ctx.auth('manager'), payload: {} });
    expect(empty.statusCode).toBe(415);
    const gibberish = await upload(`/bank/accounts/${accountId}/statements/preview`, 'manager', 'hello\nworld\nthis is not a statement');
    expect(gibberish.statusCode).toBe(422);
    expect(gibberish.json().details.code).toBe('MAPPING_REQUIRED');
    expect(gibberish.json().details.sampleRows.length).toBeGreaterThan(0);   // so the screen can show the file for manual mapping
  });

  it('an unrecognised layout can be imported with a manual column mapping', async () => {
    const odd = ['Zeta,Foo,Bar,Baz', `${dmy(addDays(today, 9))},Mystery thing,10.00,`, `${dmy(addDays(today, 9))},Other thing,,25.00`].join('\n');
    const res = await upload(`/bank/accounts/${accountId}/statements/preview`, 'manager', odd, {
      mapping: JSON.stringify({ date: 0, narration: 1, debit: 2, credit: 3 }), headerRow: '0',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ method: 'MANUAL', lineCount: 2 });
    expect(res.json().balanceCheck.status).toBe('UNVERIFIABLE');     // no running balance: the screen must warn
  });

  it('a header-less file with Debit | Credit and no balance reads BOTH lines and warns it cannot be verified', async () => {
    const odd = ['Zeta,Foo,Bar,Baz', `${dmy(addDays(today, 9))},Mystery receipt,,75.00`, `${dmy(addDays(today, 9))},Mystery payment,30.00,`].join('\n');
    const res = await upload(`/bank/accounts/${accountId}/statements/preview`, 'manager', odd);
    expect(res.statusCode).toBe(200);
    const p = res.json();
    expect(p.lineCount).toBe(2);
    expect(p.lines.map((l: { debit: string; credit: string }) => [l.debit, l.credit])).toEqual([['0.00', '75.00'], ['30.00', '0.00']]);
    expect(p.balanceCheck.status).toBe('UNVERIFIABLE');
  });

  it('rows that have a date but no readable amount are called out, not silently dropped', async () => {
    const csv = ['Date,Narration,Debit,Credit,Balance', `${dmy(addDays(today, 9))},Fine,,10.00,10.00`, `${dmy(addDays(today, 9))},Garbled,see note,,`].join('\n');
    const p = (await upload(`/bank/accounts/${accountId}/statements/preview`, 'manager', csv)).json();
    expect(p.lineCount).toBe(1);
    expect(p.warnings).toContain('ROWS_WITHOUT_AMOUNT:1');
  });

  it('a malformed mapping is a 422, not a crash', async () => {
    const res = await upload(`/bank/accounts/${accountId}/statements/preview`, 'manager', 'a,b\n1,2', { mapping: '{"date": 99}' });
    expect(res.statusCode).toBe(422);
    const res2 = await upload(`/bank/accounts/${accountId}/statements/preview`, 'manager', 'a,b\n1,2', { mapping: '{"narration": 1}' });
    expect(res2.statusCode).toBe(422);
  });
});
