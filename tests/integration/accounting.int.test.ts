import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { Decimal } from 'decimal.js';
import { and, eq } from 'drizzle-orm';
import { setupIntegration, type IntegrationContext } from './helpers.js';
import { accountingRoutes } from '../../src/modules/accounting/accounting.routes.js';
import { expenseRoutes } from '../../src/modules/expenses/expense.routes.js';
import { registerAccountingHandlers, postBillPaid } from '../../src/modules/accounting/posting.service.js';
import { emitDomainEvent, domainEventHandlerCount } from '../../src/lib/domain-events.js';

let ctx: IntegrationContext;
let app: FastifyInstance;    // local instance with the accounting + expense routes
let whiskyId: string;
let beerId: string;

beforeAll(async () => {
  ctx = await setupIntegration();
  registerAccountingHandlers();
  whiskyId = ctx.products[0].id;
  beerId = ctx.products[1].id;

  app = Fastify();
  app.register(fastifyJwt, { secret: process.env.JWT_SECRET! });
  app.register(accountingRoutes, { prefix: '/api/v1' });
  app.register(expenseRoutes, { prefix: '/api/v1' });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await ctx?.app.close();
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────

const otherManager = () => ctx.authFor({
  sub: ctx.otherBranchManager.id, email: ctx.otherBranchManager.email, role: 'manager', branchId: ctx.otherBranchId,
});

async function postBill(payload: Record<string, unknown>) {
  const res = await ctx.app.inject({
    method: 'POST', url: '/api/v1/bills', headers: ctx.auth('cashier'),
    payload: { branchId: ctx.branchId, paymentMode: 'CASH', ...payload },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; total: string; subtotal: string; taxAmount: string; discount: string; billNumber: string };
}

/** Lines of the voucher posted for a source, keyed by ledger code. */
async function voucherFor(sourceType: string, sourceId: string) {
  const { journalVouchers, journalLines, accountLedgers } = ctx.schema;
  const vouchers = await ctx.db.select().from(journalVouchers)
    .where(and(eq(journalVouchers.sourceType, sourceType), eq(journalVouchers.sourceId, sourceId)));
  if (vouchers.length === 0) return null;
  const rows = await ctx.db
    .select({ code: accountLedgers.code, debit: journalLines.debit, credit: journalLines.credit })
    .from(journalLines)
    .innerJoin(accountLedgers, eq(journalLines.ledgerId, accountLedgers.id))
    .where(eq(journalLines.voucherId, vouchers[0].id));
  const lines = Object.fromEntries(rows.map((r) => [r.code, { debit: r.debit, credit: r.credit }]));
  let dr = new Decimal(0);
  let cr = new Decimal(0);
  for (const r of rows) { dr = dr.plus(r.debit); cr = cr.plus(r.credit); }
  return { voucher: vouchers[0], count: vouchers.length, lines, totalDebit: dr.toFixed(2), totalCredit: cr.toFixed(2) };
}

function get(url: string, headers = ctx.auth('manager')) {
  return app.inject({ method: 'GET', url: `/api/v1${url}`, headers });
}

function post(url: string, payload: unknown, headers = ctx.auth('manager')) {
  return app.inject({ method: 'POST', url: `/api/v1${url}`, headers, payload: payload as Record<string, unknown> });
}

async function createCustomer() {
  const [c] = await ctx.db.insert(ctx.schema.customers).values({
    branchId: ctx.branchId, name: 'Khata Ravi', phone: '9000000001', creditAllowed: true, creditLimit: '50000.00',
  }).returning();
  return c;
}

// ─── SALES POSTING ────────────────────────────────────────────────────────────

describe('bill → SALES voucher', () => {
  it('a cash bill posts a balanced SALES voucher with correct ledger amounts', async () => {
    const bill = await postBill({ items: [{ productId: whiskyId, quantity: 1 }] });
    const v = await voucherFor('BILL', bill.id);
    expect(v).not.toBeNull();
    expect(v!.voucher.voucherType).toBe('SALES');
    expect(v!.voucher.voucherNumber).toMatch(/^JV-MAIN-\d{8}-[0-9A-F]{8}$/);
    expect(v!.totalDebit).toBe(v!.totalCredit);
    expect(v!.lines.CASH).toEqual({ debit: '1000.00', credit: '0.00' });
    expect(v!.lines.SALES).toEqual({ debit: '0.00', credit: '847.46' });
    expect(v!.lines.OUTPUT_GST).toEqual({ debit: '0.00', credit: '152.54' });
    expect(v!.lines.DISCOUNT_ALLOWED).toBeUndefined();
  });

  it('a CREDIT bill with discount debits SUNDRY_DEBTORS and DISCOUNT_ALLOWED', async () => {
    const customer = await createCustomer();
    const bill = await postBill({
      paymentMode: 'CREDIT', customerId: customer.id, discount: '25.00',
      items: [{ productId: beerId, quantity: 3 }, { productId: whiskyId, quantity: 1 }],
    });
    const v = await voucherFor('BILL', bill.id);
    expect(v!.lines.SUNDRY_DEBTORS).toEqual({ debit: bill.total, credit: '0.00' });
    expect(v!.lines.DISCOUNT_ALLOWED).toEqual({ debit: '25.00', credit: '0.00' });
    expect(v!.lines.OUTPUT_GST.credit).toBe(bill.taxAmount);
    expect(new Decimal(v!.lines.SALES.credit).plus(bill.taxAmount).toFixed(2)).toBe(bill.subtotal);
    expect(v!.totalDebit).toBe(bill.subtotal);
    expect(v!.totalCredit).toBe(bill.subtotal);
  });

  it('UPI bill debits BANK', async () => {
    const bill = await postBill({ paymentMode: 'UPI', items: [{ productId: beerId, quantity: 2 }] });
    const v = await voucherFor('BILL', bill.id);
    expect(v!.lines.BANK).toEqual({ debit: '400.00', credit: '0.00' });
  });
});

describe('void → reversal voucher', () => {
  it('creates the exact reversal and the trial balance still balances', async () => {
    const bill = await postBill({ discount: '10.00', items: [{ productId: whiskyId, quantity: 2 }] });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/v1/bills/${bill.id}/void`, headers: ctx.auth('manager'),
      payload: { voidReason: 'Wrong items rung' },
    });
    expect(res.statusCode).toBe(200);

    const sale = await voucherFor('BILL', bill.id);
    const reversal = await voucherFor('BILL_VOID', bill.id);
    expect(reversal).not.toBeNull();
    expect(reversal!.voucher.voucherType).toBe('JOURNAL');
    for (const [code, line] of Object.entries(sale!.lines)) {
      expect(reversal!.lines[code]).toEqual({ debit: line.credit, credit: line.debit });
    }

    const tb = await get(`/accounting/trial-balance/${ctx.branchId}`);
    expect(tb.statusCode).toBe(200);
    expect(tb.json().isBalanced).toBe(true);
    expect(tb.json().totalDebit).toBe(tb.json().totalCredit);
  });
});

describe('double posting', () => {
  it('re-running the bill.paid handler for the same bill is a no-op', async () => {
    const bill = await postBill({ items: [{ productId: beerId, quantity: 1 }] });
    const [row] = await ctx.db.select().from(ctx.schema.bills).where(eq(ctx.schema.bills.id, bill.id));
    const again = await ctx.db.transaction((tx) => postBillPaid({ bill: row, items: [] }, tx));
    expect(again).toBeNull();
    expect((await voucherFor('BILL', bill.id))!.count).toBe(1);
  });

  it('registerAccountingHandlers is idempotent', () => {
    const before = domainEventHandlerCount('bill.paid');
    registerAccountingHandlers();
    registerAccountingHandlers();
    expect(domainEventHandlerCount('bill.paid')).toBe(before);
  });
});

// ─── PURCHASES / KHATA (posted via domain events) ─────────────────────────────

describe('supplier invoice + credit repayment events', () => {
  it('posts PURCHASE and RECEIPT vouchers', async () => {
    const { supplierInvoices, supplierInvoiceItems, customers, creditTransactions } = ctx.schema;
    const invoiceId = await ctx.db.transaction(async (tx) => {
      const [invoice] = await tx.insert(supplierInvoices).values({
        branchId: ctx.branchId, createdById: ctx.users.manager.id, approvedById: ctx.users.manager.id,
        supplierName: 'United Spirits', invoiceNumber: 'US-001', totalAmount: '11400.00', status: 'APPROVED',
        approvedAt: new Date(),
      }).returning();
      const items = await tx.insert(supplierInvoiceItems).values([
        { invoiceId: invoice.id, productId: whiskyId, rawDescription: 'TW 750', quantity: 12, costPrice: '800.00', mrp: '1000.00', taxRate: '18.00', lineCostTotal: '9600.00' },
        { invoiceId: invoice.id, productId: beerId, rawDescription: 'TB 650', quantity: 12, costPrice: '150.00', mrp: '200.00', taxRate: '12.00', lineCostTotal: '1800.00' },
      ]).returning();
      await emitDomainEvent('supplierInvoice.approved', { invoice, items }, tx);
      return invoice.id;
    });
    const purchase = await voucherFor('SUPPLIER_INVOICE', invoiceId);
    expect(purchase!.voucher.voucherType).toBe('PURCHASE');
    expect(purchase!.lines.SUNDRY_CREDITORS).toEqual({ debit: '0.00', credit: '11400.00' });
    expect(purchase!.lines.PURCHASES.debit).toBe('9742.73');
    expect(purchase!.lines.INPUT_GST.debit).toBe('1657.27');

    const [customer] = await ctx.db.select().from(customers).where(eq(customers.branchId, ctx.branchId)).limit(1);
    const txnId = await ctx.db.transaction(async (tx) => {
      const [txn] = await tx.insert(creditTransactions).values({
        customerId: customer.id, type: 'REPAYMENT', amount: '300.00', balanceAfter: '0.00',
        paymentMode: 'UPI', recordedById: ctx.users.cashier.id,
      }).returning();
      await emitDomainEvent('credit.repayment', { customer, txn }, tx);
      return txn.id;
    });
    const receipt = await voucherFor('CREDIT_REPAYMENT', txnId);
    expect(receipt!.voucher.voucherType).toBe('RECEIPT');
    expect(receipt!.lines.BANK).toEqual({ debit: '300.00', credit: '0.00' });
    expect(receipt!.lines.SUNDRY_DEBTORS).toEqual({ debit: '0.00', credit: '300.00' });
  });
});

// ─── EXPENSES ─────────────────────────────────────────────────────────────────

describe('expenses', () => {
  it('POST records the expense and posts a PAYMENT voucher; GET totals by category', async () => {
    const res = await post(`/expenses/${ctx.branchId}`, {
      category: 'Rent', amount: '15000', paymentMode: 'BANK', expenseDate: '2026-10-01', notes: 'October rent',
    });
    expect(res.statusCode).toBe(201);
    const expense = res.json();
    expect(expense.amount).toBe('15000.00');
    const v = await voucherFor('EXPENSE', expense.id);
    expect(v!.voucher.voucherType).toBe('PAYMENT');
    expect(v!.voucher.voucherDate).toBe('2026-10-01');
    expect(v!.lines.EXPENSE_RENT).toEqual({ debit: '15000.00', credit: '0.00' });
    expect(v!.lines.BANK).toEqual({ debit: '0.00', credit: '15000.00' });

    expect((await post(`/expenses/${ctx.branchId}`, { category: 'Electricity', amount: '1200.50', paymentMode: 'CASH', expenseDate: '2026-10-02' })).statusCode).toBe(201);
    expect((await post(`/expenses/${ctx.branchId}`, { category: 'rent', amount: '500', paymentMode: 'CASH', expenseDate: '2026-10-03' })).statusCode).toBe(201);

    const list = await get(`/expenses/${ctx.branchId}?from=2026-10-01&to=2026-10-31`);
    expect(list.statusCode).toBe(200);
    expect(list.json().total).toBe('16700.50');
    expect(list.json().totalsByCategory[0]).toEqual({ category: 'Rent', total: '15500.00', count: 2 });

    const ranged = await get(`/expenses/${ctx.branchId}?from=2026-10-02&to=2026-10-02`);
    expect(ranged.json().count).toBe(1);
  });

  it('validates input and enforces role / branch access', async () => {
    expect((await post(`/expenses/${ctx.branchId}`, { category: 'Rent', amount: '0', paymentMode: 'CASH' })).statusCode).toBe(400);
    expect((await post(`/expenses/${ctx.branchId}`, { category: 'Rent', amount: '10', paymentMode: 'CREDIT' })).statusCode).toBe(400);
    expect((await post(`/expenses/${ctx.branchId}`, { category: 'Rent', amount: '10', paymentMode: 'CASH' }, ctx.auth('cashier'))).statusCode).toBe(403);
    expect((await post(`/expenses/${ctx.branchId}`, { category: 'Rent', amount: '10', paymentMode: 'CASH' }, otherManager())).statusCode).toBe(403);
    expect((await get(`/expenses/${ctx.branchId}`, otherManager())).statusCode).toBe(403);
  });
});

// ─── LEDGERS / MANUAL JOURNAL ─────────────────────────────────────────────────

describe('ledgers and manual journals', () => {
  it('lists system ledgers with balances; creates custom ledgers', async () => {
    const res = await get(`/accounting/ledgers/${ctx.branchId}`);
    expect(res.statusCode).toBe(200);
    const codes = res.json().ledgers.map((l: { code: string }) => l.code);
    for (const code of ['CASH', 'BANK', 'SUNDRY_DEBTORS', 'INVENTORY', 'SUNDRY_CREDITORS', 'OUTPUT_GST', 'INPUT_GST', 'CAPITAL', 'SALES', 'PURCHASES', 'DISCOUNT_ALLOWED', 'EXPENSE_RENT']) {
      expect(codes).toContain(code);
    }

    const created = await post(`/accounting/ledgers/${ctx.branchId}`, { name: 'Owner Loan', group: 'LIABILITY' });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ code: 'OWNER_LOAN', isSystem: false, openingBalance: '0.00' });
    expect((await post(`/accounting/ledgers/${ctx.branchId}`, { name: 'Owner Loan', group: 'LIABILITY' })).statusCode).toBe(409);
    expect((await post(`/accounting/ledgers/${ctx.branchId}`, { name: 'Cash', group: 'ASSET' })).statusCode).toBe(422);
    expect((await post(`/accounting/ledgers/${ctx.branchId}`, { name: 'X', group: 'NOPE' })).statusCode).toBe(400);
  });

  it('manual journal: unbalanced → 422, balanced → 201, foreign ledger → 422', async () => {
    const ledgers = (await get(`/accounting/ledgers/${ctx.branchId}`)).json().ledgers as { id: string; code: string }[];
    const id = (code: string) => ledgers.find((l) => l.code === code)!.id;

    const unbalanced = await post(`/accounting/journal/${ctx.branchId}`, {
      narration: 'Capital introduced',
      lines: [{ ledgerId: id('BANK'), debit: '50000.00' }, { ledgerId: id('CAPITAL'), credit: '49999.99' }],
    });
    expect(unbalanced.statusCode).toBe(422);

    const bothSides = await post(`/accounting/journal/${ctx.branchId}`, {
      narration: 'Bad line',
      lines: [{ ledgerId: id('BANK'), debit: '10.00', credit: '10.00' }, { ledgerId: id('CAPITAL'), credit: '0.00' }],
    });
    expect(bothSides.statusCode).toBe(422);

    const ok = await post(`/accounting/journal/${ctx.branchId}`, {
      narration: 'Capital introduced',
      lines: [{ ledgerId: id('BANK'), debit: '50000.00' }, { ledgerId: id('CAPITAL'), credit: '50000.00' }],
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ voucherType: 'JOURNAL', sourceType: 'MANUAL' });
    expect(ok.json().lines).toHaveLength(2);

    // ledger of another branch
    const otherLedgers = await app.inject({ method: 'GET', url: `/api/v1/accounting/ledgers/${ctx.otherBranchId}`, headers: otherManager() });
    const otherCash = otherLedgers.json().ledgers.find((l: { code: string }) => l.code === 'CASH').id;
    const foreign = await post(`/accounting/journal/${ctx.branchId}`, {
      narration: 'Cross branch',
      lines: [{ ledgerId: otherCash, debit: '1.00' }, { ledgerId: id('CAPITAL'), credit: '1.00' }],
    });
    expect(foreign.statusCode).toBe(422);
  });

  it('ledger entries show a running balance', async () => {
    const ledgers = (await get(`/accounting/ledgers/${ctx.branchId}`)).json().ledgers as { id: string; code: string; balance: string }[];
    const cash = ledgers.find((l) => l.code === 'CASH')!;
    const res = await get(`/accounting/ledgers/${ctx.branchId}/${cash.id}/entries`);
    expect(res.statusCode).toBe(200);
    const st = res.json();
    expect(st.entries.length).toBeGreaterThan(0);
    expect(st.closingBalance).toBe(cash.balance);
    expect(st.entries[st.entries.length - 1].balance).toBe(st.closingBalance);

    const future = await get(`/accounting/ledgers/${ctx.branchId}/${cash.id}/entries?from=2999-01-01`);
    expect(future.json().entries).toHaveLength(0);
    expect(future.json().openingBalance).toBe(cash.balance);

    const missing = await get(`/accounting/ledgers/${ctx.branchId}/00000000-0000-0000-0000-000000000000/entries`);
    expect(missing.statusCode).toBe(404);
  });
});

// ─── REPORTS ──────────────────────────────────────────────────────────────────

describe('reports after a mix of operations', () => {
  it('trial balance, P&L and balance sheet agree', async () => {
    const tb = (await get(`/accounting/trial-balance/${ctx.branchId}`)).json();
    expect(tb.isBalanced).toBe(true);
    expect(tb.totalDebit).toBe(tb.totalCredit);

    const pl = (await get(`/accounting/profit-loss/${ctx.branchId}`)).json();
    expect(new Decimal(pl.totalIncome).minus(pl.totalExpense).toFixed(2)).toBe(pl.netProfit);

    const bs = (await get(`/accounting/balance-sheet/${ctx.branchId}`)).json();
    expect(bs.isBalanced).toBe(true);
    expect(bs.totalAssets).toBe(bs.totalLiabilitiesAndEquity);
    expect(bs.retainedEarnings).toBe(pl.netProfit);   // all postings are inside the default (unbounded) period

    const daybook = (await get(`/accounting/vouchers/${ctx.branchId}?type=SALES`)).json();
    expect(daybook.count).toBeGreaterThan(0);
    for (const v of daybook.vouchers) {
      expect(v.voucherType).toBe('SALES');
      const dr = v.lines.reduce((a: Decimal, l: { debit: string }) => a.plus(l.debit), new Decimal(0));
      const cr = v.lines.reduce((a: Decimal, l: { credit: string }) => a.plus(l.credit), new Decimal(0));
      expect(dr.equals(cr)).toBe(true);
    }

    expect((await get(`/accounting/profit-loss/${ctx.branchId}?from=2026-10-10&to=2026-10-01`)).statusCode).toBe(400);
    expect((await get(`/accounting/trial-balance/${ctx.branchId}?asOf=not-a-date`)).statusCode).toBe(400);
  });

  it('tally export returns an XML attachment containing the vouchers', async () => {
    const [anyVoucher] = await ctx.db.select().from(ctx.schema.journalVouchers)
      .where(eq(ctx.schema.journalVouchers.branchId, ctx.branchId)).limit(1);
    const res = await get(`/accounting/tally-export/${ctx.branchId}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/xml');
    expect(String(res.headers['content-disposition'])).toMatch(/^attachment; filename="tally-MAIN-.*\.xml"$/);
    expect(res.body).toContain('<TALLYREQUEST>Import Data</TALLYREQUEST>');
    expect(res.body).toContain('<SVCURRENTCOMPANY>Main</SVCURRENTCOMPANY>');
    expect(res.body).toContain(`<VOUCHERNUMBER>${anyVoucher.voucherNumber}</VOUCHERNUMBER>`);
    expect(res.body).toContain('<LEDGERNAME>Sales Account</LEDGERNAME>');

    const empty = await get(`/accounting/tally-export/${ctx.branchId}?from=2999-01-01&to=2999-01-31`);
    expect(empty.statusCode).toBe(200);
    expect(empty.body).toContain('<ENVELOPE>');
    expect(empty.body).not.toContain('<VOUCHER ');
  });

  it('cross-branch and low-role access is denied', async () => {
    for (const url of [
      `/accounting/ledgers/${ctx.branchId}`,
      `/accounting/vouchers/${ctx.branchId}`,
      `/accounting/trial-balance/${ctx.branchId}`,
      `/accounting/profit-loss/${ctx.branchId}`,
      `/accounting/balance-sheet/${ctx.branchId}`,
      `/accounting/tally-export/${ctx.branchId}`,
    ]) {
      expect((await get(url, otherManager())).statusCode).toBe(403);
      expect((await get(url, ctx.auth('cashier'))).statusCode).toBe(403);
    }
    expect((await post(`/accounting/journal/${ctx.branchId}`, { narration: 'x x x', lines: [] }, otherManager())).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/api/v1/accounting/ledgers/${ctx.branchId}` })).statusCode).toBe(401);
    // the syndicate owner may read the syndicate branch, but not the non-syndicate one
    expect((await get(`/accounting/trial-balance/${ctx.branchId}`, ctx.auth('owner'))).statusCode).toBe(200);
    expect((await get(`/accounting/trial-balance/${ctx.otherBranchId}`, ctx.auth('owner'))).statusCode).toBe(403);
  });
});

// ─── REVIEW REGRESSIONS ───────────────────────────────────────────────────────

describe('review regressions', () => {
  const MISSING_BRANCH = '11111111-1111-4111-8111-111111111111';

  async function platformOwner() {
    const [u] = await ctx.db.insert(ctx.schema.users).values({
      name: 'Platform owner', email: 'platform@test.local', passwordHash: 'x', role: 'owner', branchId: null, syndicateId: null,
    }).returning();
    return ctx.authFor({ sub: u.id, email: u.email, role: 'owner', branchId: null, syndicateId: null });
  }

  it('unknown branch → 404 (not a 422 FK error) for ledger create and manual journal', async () => {
    const headers = await platformOwner();
    const ledger = await post(`/accounting/ledgers/${MISSING_BRANCH}`, { name: 'Owner Loan', group: 'LIABILITY' }, headers);
    expect(ledger.statusCode).toBe(404);
    const journal = await post(`/accounting/journal/${MISSING_BRANCH}`, {
      narration: 'Nowhere',
      lines: [{ ledgerId: MISSING_BRANCH, debit: '1.00' }, { ledgerId: MISSING_BRANCH, credit: '1.00' }],
    }, headers);
    expect(journal.statusCode).toBe(404);
  });

  it('amounts that overflow the numeric columns are rejected with 400', async () => {
    expect((await post(`/expenses/${ctx.branchId}`, { category: 'Rent', amount: '99999999999', paymentMode: 'CASH' })).statusCode).toBe(400);
    expect((await post(`/accounting/ledgers/${ctx.branchId}`, { name: 'Huge Loan', group: 'LIABILITY', openingBalance: '-1000000000000' })).statusCode).toBe(400);
    const ledgers = (await get(`/accounting/ledgers/${ctx.branchId}`)).json().ledgers as { id: string; code: string }[];
    const id = (code: string) => ledgers.find((l) => l.code === code)!.id;
    const res = await post(`/accounting/journal/${ctx.branchId}`, {
      narration: 'Too big',
      lines: [{ ledgerId: id('BANK'), debit: '1000000000000.00' }, { ledgerId: id('CAPITAL'), credit: '1000000000000.00' }],
    });
    expect(res.statusCode).toBe(400);
  });

  it('a custom ledger cannot reuse an existing ledger name (Tally imports by name)', async () => {
    const res = await post(`/accounting/ledgers/${ctx.branchId}`, { name: 'cash in hand', code: 'PETTY', group: 'ASSET' });
    expect(res.statusCode).toBe(409);
  });

  it('voiding a bill that was never paid posts no phantom reversal', async () => {
    const { postBillVoided } = await import('../../src/modules/accounting/posting.service.js');
    const fakeId = '22222222-2222-4222-8222-222222222222';
    const bill = {
      id: fakeId, branchId: ctx.branchId, cashierId: ctx.users.cashier.id, billNumber: 'MAIN-OPEN-1', status: 'VOIDED' as const,
      subtotal: '200.00', taxAmount: '21.43', discount: '0.00', total: '200.00', paymentMode: 'CASH',
      customerId: null, shiftSessionId: null, clientRef: null, paidAt: null, voidedAt: new Date(), voidReason: 'never paid',
      createdAt: new Date(),
    };
    const result = await ctx.db.transaction((tx) => postBillVoided({ bill, items: [] }, tx));
    expect(result).toBeNull();
    expect(await voucherFor('BILL_VOID', fakeId)).toBeNull();
  });

  it('day book reports when it was truncated by limit', async () => {
    const res = await get(`/accounting/vouchers/${ctx.branchId}?limit=1`);
    expect(res.statusCode).toBe(200);
    expect(res.json().count).toBe(1);
    expect(res.json().hasMore).toBe(true);
    const all = await get(`/accounting/vouchers/${ctx.branchId}?limit=2000`);
    expect(all.json().hasMore).toBe(false);
  });
});
