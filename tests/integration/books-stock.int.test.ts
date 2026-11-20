/**
 * Expense void (reversing voucher), the cash book, the stock-take adjustment, and the closed-day rule for cash expenses.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { setupIntegration, type IntegrationContext } from './helpers.js';
import { businessDateOf } from '../../src/lib/business-day.js';

let ctx: IntegrationContext;
beforeAll(async () => { ctx = await setupIntegration(); }, 120_000);
afterAll(async () => { await ctx?.app.close(); });

type Role = 'manager' | 'cashier' | 'office_admin';
const call = (method: 'GET' | 'POST', url: string, role: Role, payload?: unknown) =>
  ctx.app.inject({ method, url: `/api/v1${url}`, headers: ctx.auth(role), payload: payload as never });
const today = businessDateOf();

let keepId = '';
let voidId = '';
let cashBill = 0;

describe('expense void', () => {
  it('records two cash expenses and a cash sale', async () => {
    const a = await call('POST', `/expenses/${ctx.branchId}`, 'manager', { category: 'Tea', amount: '40.00', paymentMode: 'CASH' });
    const b = await call('POST', `/expenses/${ctx.branchId}`, 'manager', { category: 'Rent', amount: '1000.00', paymentMode: 'CASH' });
    expect(a.statusCode, a.body).toBe(201);
    expect(b.statusCode, b.body).toBe(201);
    keepId = a.json().id;
    voidId = b.json().id;
    const bill = await call('POST', '/bills', 'cashier', { branchId: ctx.branchId, paymentMode: 'CASH', items: [{ productId: ctx.products[0].id, quantity: 1 }] });
    expect(bill.statusCode, bill.body).toBe(201);
    cashBill = Number(bill.json().total);
  });

  it('needs a reason, the accounting permission, and the right branch', async () => {
    expect((await call('POST', `/expenses/${ctx.branchId}/${voidId}/void`, 'manager', { reason: 'short' })).statusCode).toBe(400);
    expect((await call('POST', `/expenses/${ctx.branchId}/${voidId}/void`, 'cashier', { reason: 'entered twice by mistake' })).statusCode).toBe(403);
    // an expense of this branch cannot be voided through another branch's URL
    const wrong = await ctx.app.inject({ method: 'POST', url: `/api/v1/expenses/${ctx.otherBranchId}/${voidId}/void`, headers: ctx.auth('manager'), payload: { reason: 'entered twice by mistake' } });
    expect([403, 404]).toContain(wrong.statusCode);
  });

  it('voids once: it leaves the totals, posts an exact reversing voucher, and cannot be voided twice', async () => {
    const res = await call('POST', `/expenses/${ctx.branchId}/${voidId}/void`, 'manager', { reason: 'entered twice by mistake' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().voidedAt).toBeTruthy();

    const list = (await call('GET', `/expenses/${ctx.branchId}`, 'manager')).json();
    expect(list.total).toBe('40.00');
    expect(list.voidedCount).toBe(1);
    expect(list.expenses.find((e: { id: string }) => e.id === voidId).voidedAt).toBeTruthy();
    expect(list.expenses.find((e: { id: string }) => e.id === keepId).voidedAt).toBeNull();

    const { journalVouchers, journalLines } = ctx.schema;
    const [reversal] = await ctx.db.select().from(journalVouchers).where(and(eq(journalVouchers.sourceType, 'EXPENSE_VOID'), eq(journalVouchers.sourceId, voidId)));
    expect(reversal).toBeDefined();
    const lines = await ctx.db.select().from(journalLines).where(eq(journalLines.voucherId, reversal.id));
    const dr = lines.reduce((n, l) => n + Number(l.debit), 0);
    const cr = lines.reduce((n, l) => n + Number(l.credit), 0);
    expect(dr).toBe(1000);
    expect(cr).toBe(1000);

    expect((await call('POST', `/expenses/${ctx.branchId}/${voidId}/void`, 'manager', { reason: 'entered twice by mistake' })).statusCode).toBe(409);
  });

  it('a voided cash expense no longer reduces the drawer', async () => {
    const preview = (await call('GET', `/closing/preview?branchId=${ctx.branchId}&date=${today}`, 'manager')).json();
    expect(preview.sales.cashExpenses).toBe('40.00');
  });
});

describe('cash book', () => {
  it('shows the day: the sale in, the expense out, the void back in', async () => {
    const res = await call('GET', `/accounting/cash-book/${ctx.branchId}?ledger=CASH&from=${today}&to=${today}`, 'manager');
    expect(res.statusCode, res.body).toBe(200);
    const book = res.json();
    expect(book.days).toHaveLength(1);
    const day = book.days[0];
    // receipts: the sale + the 1000 reversal; payments: the 40 and the 1000 that was later voided
    expect(Number(day.receipts)).toBeCloseTo(cashBill + 1000, 2);
    expect(Number(day.payments)).toBeCloseTo(1040, 2);
    expect(Number(book.closing)).toBeCloseTo(cashBill - 40, 2);
    expect(day.entries.length).toBeGreaterThanOrEqual(4);
  });

  it('a branch with no postings has an empty book, and a cashier cannot read it', async () => {
    const other = await ctx.app.inject({
      method: 'GET', url: `/api/v1/accounting/cash-book/${ctx.otherBranchId}?ledger=BANK`,
      headers: ctx.authFor({ sub: ctx.otherBranchManager.id, email: ctx.otherBranchManager.email, role: 'manager', branchId: ctx.otherBranchId }),
    });
    expect(other.statusCode, other.body).toBe(200);
    expect(other.json().days).toEqual([]);
    expect((await call('GET', `/accounting/cash-book/${ctx.branchId}`, 'cashier')).statusCode).toBe(403);
  });
});

describe('stock-take', () => {
  const stockOf = async (productId: string) => (await ctx.db.select().from(ctx.schema.stock)
    .where(and(eq(ctx.schema.stock.branchId, ctx.branchId), eq(ctx.schema.stock.productId, productId))))[0]?.quantity ?? 0;

  it('sets the shop total to the count and records who changed what', async () => {
    const p = ctx.products[1];
    const before = await stockOf(p.id);
    const res = await call('POST', `/inventory/stock/${ctx.branchId}/adjust`, 'manager', {
      note: 'Annual physical count - 3 bottles found broken in the godown',
      lines: [{ productId: p.id, countedQuantity: before - 3 }, { productId: ctx.products[0].id, countedQuantity: await stockOf(ctx.products[0].id) }],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ unchanged: 1, adjusted: [{ productId: p.id, before, after: before - 3, delta: -3 }] });
    expect(await stockOf(p.id)).toBe(before - 3);

    const rows = await ctx.db.select().from(ctx.schema.stockAudit)
      .where(and(eq(ctx.schema.stockAudit.productId, p.id), eq(ctx.schema.stockAudit.reason, 'MANUAL_ADJUST')));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ changeQty: -3, userId: ctx.users.manager.id, referenceId: res.json().batchId });
    const audits = await ctx.db.select().from(ctx.schema.auditLog).where(eq(ctx.schema.auditLog.action, 'stock.adjust'));
    expect(JSON.stringify(audits.at(-1)!.meta)).toContain('Annual physical count');
  });

  it('needs the permission, a reason, and valid counts', async () => {
    const p = ctx.products[1];
    const line = [{ productId: p.id, countedQuantity: 1 }];
    expect((await call('POST', `/inventory/stock/${ctx.branchId}/adjust`, 'cashier', { note: 'a long enough reason', lines: line })).statusCode).toBe(403);
    expect((await call('POST', `/inventory/stock/${ctx.branchId}/adjust`, 'manager', { note: 'short', lines: line })).statusCode).toBe(400);
    expect((await call('POST', `/inventory/stock/${ctx.branchId}/adjust`, 'manager', { note: 'a long enough reason', lines: [{ productId: p.id, countedQuantity: -1 }] })).statusCode).toBe(400);
    expect((await call('POST', `/inventory/stock/${ctx.branchId}/adjust`, 'manager', { note: 'a long enough reason', lines: [{ productId: ctx.otherProducts[0].id, countedQuantity: 1 }] })).statusCode).toBe(422);
    // a manager of another branch cannot touch this branch
    const other = await ctx.app.inject({
      method: 'POST', url: `/api/v1/inventory/stock/${ctx.branchId}/adjust`, payload: { note: 'a long enough reason', lines: line },
      headers: ctx.authFor({ sub: ctx.otherBranchManager.id, email: ctx.otherBranchManager.email, role: 'manager', branchId: ctx.otherBranchId }),
    });
    expect(other.statusCode).toBe(403);
  });
});

describe('closed day', () => {
  it('takes no more cash expenses, but a bank expense is not a drawer matter', async () => {
    const closed = await call('POST', '/closing', 'manager', { branchId: ctx.branchId, openingCash: '0.00', actualCashCounted: '0.00', businessDate: today, notes: 'closing for the test, drawer not counted' });
    expect(closed.statusCode, closed.body).toBe(201);
    const cash = await call('POST', `/expenses/${ctx.branchId}`, 'manager', { category: 'Tea', amount: '10.00', paymentMode: 'CASH' });
    expect(cash.statusCode).toBe(422);
    expect(cash.json().error).toMatch(/already closed/i);
    const bank = await call('POST', `/expenses/${ctx.branchId}`, 'manager', { category: 'Internet', amount: '10.00', paymentMode: 'BANK' });
    expect(bank.statusCode, bank.body).toBe(201);
    // a cash expense of that day cannot be voided until the day is reopened
    const voidKept = await call('POST', `/expenses/${ctx.branchId}/${keepId}/void`, 'manager', { reason: 'wrong day, to be re-entered' });
    expect(voidKept.statusCode).toBe(422);
  });
});
