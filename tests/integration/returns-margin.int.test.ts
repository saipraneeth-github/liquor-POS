import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { setupIntegration, type IntegrationContext } from './helpers.js';
import { businessDateOf } from '../../src/lib/business-day.js';

let ctx: IntegrationContext;
beforeAll(async () => { ctx = await setupIntegration(); }, 120_000);
afterAll(async () => { await ctx?.app.close(); });

type Role = 'manager' | 'cashier';
const call = (method: 'GET' | 'POST', url: string, role: Role, payload?: unknown) =>
  ctx.app.inject({ method, url: `/api/v1${url}`, headers: ctx.auth(role), payload: payload as never });
const stockOf = async (productId: string) =>
  (await ctx.db.select().from(ctx.schema.stock).where(and(eq(ctx.schema.stock.branchId, ctx.branchId), eq(ctx.schema.stock.productId, productId))))[0]?.quantity ?? 0;
const linesOf = async (voucherSource: string, sourceId: string) => {
  const { journalVouchers, journalLines, accountLedgers } = ctx.schema;
  const [v] = await ctx.db.select().from(journalVouchers).where(and(eq(journalVouchers.sourceType, voucherSource), eq(journalVouchers.sourceId, sourceId)));
  if (!v) return null;
  const rows = await ctx.db.select({ code: accountLedgers.code, debit: journalLines.debit, credit: journalLines.credit })
    .from(journalLines).innerJoin(accountLedgers, eq(accountLedgers.id, journalLines.ledgerId)).where(eq(journalLines.voucherId, v.id));
  return Object.fromEntries(rows.map((r) => [r.code, { debit: Number(r.debit), credit: Number(r.credit) }]));
};

let billId = '';
let lineId = '';
let firstReturn: { id: string; refundAmount: string };

describe('customer return (cash sale)', () => {
  it('sets up a cash bill of 3 whisky', async () => {
    const res = await call('POST', '/bills', 'cashier', { branchId: ctx.branchId, paymentMode: 'CASH', items: [{ productId: ctx.products[0].id, quantity: 3 }] });
    expect(res.statusCode, res.body).toBe(201);
    billId = res.json().id;
    lineId = res.json().items[0].id;
  });

  it('refunds one bottle, puts it back in stock, and reverses the sale voucher for that share', async () => {
    const before = await stockOf(ctx.products[0].id);
    const res = await call('POST', `/bills/${billId}/returns`, 'manager', { reason: 'customer changed mind, sealed bottle', items: [{ billItemId: lineId, quantity: 1 }] });
    expect(res.statusCode, res.body).toBe(201);
    firstReturn = res.json();
    expect(firstReturn.refundAmount).toBe('1000.00');
    expect(await stockOf(ctx.products[0].id)).toBe(before + 1);

    const audit = await ctx.db.select().from(ctx.schema.stockAudit).where(and(eq(ctx.schema.stockAudit.referenceId, firstReturn.id), eq(ctx.schema.stockAudit.reason, 'SALES_RETURN')));
    expect(audit).toHaveLength(1);
    expect(audit[0].changeQty).toBe(1);

    const v = (await linesOf('SALES_RETURN', firstReturn.id))!;
    expect(v.CASH.credit).toBe(1000);
    expect(v.SALES.debit + v.OUTPUT_GST.debit).toBeCloseTo(1000, 2);      // the sale voucher in reverse: gross split into sales and tax
    expect(v.OUTPUT_GST.debit).toBeGreaterThan(0);
  });

  it('tracks how many have come back and refuses more than is left', async () => {
    const info = (await call('GET', `/bills/${billId}/returns`, 'cashier')).json();
    expect(info.returnedByItem[lineId]).toBe(1);
    expect(info.returns).toHaveLength(1);
    const tooMany = await call('POST', `/bills/${billId}/returns`, 'manager', { reason: 'customer changed mind again', items: [{ billItemId: lineId, quantity: 3 }] });
    expect(tooMany.statusCode).toBe(422);
    expect(tooMany.json().error).toMatch(/only 2 left/);
    const rest = await call('POST', `/bills/${billId}/returns`, 'manager', { reason: 'returning the other two bottles', items: [{ billItemId: lineId, quantity: 2 }] });
    expect(rest.statusCode, rest.body).toBe(201);
    // 3 bottles = 3000 to the paisa across the two returns
    expect(Number(firstReturn.refundAmount) + Number(rest.json().refundAmount)).toBe(3000);
  });

  it('GET /bills and GET /bills/:id reflect the sales returns and net total', async () => {
    const listRes = await call('GET', `/bills?branchId=${ctx.branchId}&limit=10`, 'cashier');
    expect(listRes.statusCode).toBe(200);
    const returnedBill = listRes.json().bills.find((b: any) => b.id === billId);
    expect(returnedBill).toBeDefined();
    expect(returnedBill.refundedAmount).toBe('3000.00');
    expect(returnedBill.returnCount).toBe(2);
    expect(returnedBill.netTotal).toBe('0.00');

    // Detail endpoint
    const detailRes = await call('GET', `/bills/${billId}`, 'cashier');
    expect(detailRes.statusCode).toBe(200);
    const detail = detailRes.json();
    expect(detail.refundedAmount).toBe('3000.00');
    expect(detail.netTotal).toBe('0.00');
    expect(detail.returns).toHaveLength(2);

    // Cannot void a bill that has sales returns
    const voidRes = await call('POST', `/bills/${billId}/void`, 'manager', { voidReason: 'attempting void on returned bill' });
    expect(voidRes.statusCode).toBe(422);
    expect(voidRes.json().error).toMatch(/returns recorded/);
  });

  it('cash given back leaves the drawer in the closing preview and deducts sales', async () => {
    const preview = (await call('GET', `/closing/preview?branchId=${ctx.branchId}&date=${businessDateOf()}`, 'manager')).json();
    expect(preview.sales.cashRefunds).toBe('3000.00');
    expect(preview.sales.totalRefunds).toBe('3000.00');
    expect(preview.sales.cashSales).toBe('0.00');
    expect(preview.sales.grossSales).toBe('0.00');

    const dash = (await call('GET', `/dashboard/branch/${ctx.branchId}`, 'manager')).json();
    expect(dash.today.sales).toBe('0.00');
  });

  it('needs the permission and the right branch, and only a paid bill', async () => {
    expect((await call('POST', `/bills/${billId}/returns`, 'cashier', { reason: 'not allowed for a cashier', items: [{ billItemId: lineId, quantity: 1 }] })).statusCode).toBe(403);
    const foreign = await ctx.app.inject({
      method: 'POST', url: `/api/v1/bills/${billId}/returns`, payload: { reason: 'from another business entirely', items: [{ billItemId: lineId, quantity: 1 }] },
      headers: ctx.authFor({ sub: ctx.otherBranchManager.id, email: ctx.otherBranchManager.email, role: 'manager', branchId: ctx.otherBranchId }),
    });
    expect(foreign.statusCode).toBe(403);
    expect((await call('POST', `/bills/${billId}/returns`, 'manager', { reason: 'abc', items: [{ billItemId: lineId, quantity: 1 }] })).statusCode).toBe(400);
    const sold = (await call('POST', '/bills', 'cashier', { branchId: ctx.branchId, paymentMode: 'CASH', items: [{ productId: ctx.products[1].id, quantity: 1 }] })).json();
    expect((await call('POST', `/bills/${sold.id}/void`, 'manager', { voidReason: 'voided before any return can be made' })).statusCode).toBe(200);
    const onVoided = await call('POST', `/bills/${sold.id}/returns`, 'manager', { reason: 'bill was already voided', items: [{ billItemId: sold.items[0].id, quantity: 1 }] });
    expect(onVoided.statusCode).toBe(422);
  });
});

describe('customer return (khata sale)', () => {
  it('reduces what the customer owes instead of paying cash', async () => {
    const cust = (await call('POST', `/customers/${ctx.branchId}`, 'manager', { name: 'Khata Ravi', phone: '9876522222', creditAllowed: true, creditLimit: '100000' })).json().customer;
    const bill = await call('POST', '/bills', 'cashier', { branchId: ctx.branchId, paymentMode: 'CREDIT', customerId: cust.id, items: [{ productId: ctx.products[1].id, quantity: 2 }] });
    expect(bill.statusCode, bill.body).toBe(201);
    const owed = Number((await ctx.db.select().from(ctx.schema.customers).where(eq(ctx.schema.customers.id, cust.id)))[0].currentCredit);
    expect(owed).toBe(400);
    const ret = await call('POST', `/bills/${bill.json().id}/returns`, 'manager', { reason: 'one bottle was damaged', items: [{ billItemId: bill.json().items[0].id, quantity: 1 }] });
    expect(ret.statusCode, ret.body).toBe(201);
    expect(ret.json().refundMode).toBe('CREDIT');
    const after = (await ctx.db.select().from(ctx.schema.customers).where(eq(ctx.schema.customers.id, cust.id)))[0];
    expect(Number(after.currentCredit)).toBe(200);
    const v = (await linesOf('SALES_RETURN', ret.json().id))!;
    expect(v.SUNDRY_DEBTORS.credit).toBe(200);
    const txn = await ctx.db.select().from(ctx.schema.creditTransactions).where(and(eq(ctx.schema.creditTransactions.customerId, cust.id), eq(ctx.schema.creditTransactions.type, 'ADJUSTMENT')));
    expect(txn.at(-1)).toMatchObject({ amount: '200.00', balanceAfter: '200.00' });
  });
});

describe('return to a supplier', () => {
  it('takes bottles out of stock, posts Dr creditors / Cr purchases, and reduces what is owed', async () => {
    const approvedAt = new Date(Date.now() - 10 * 86_400_000);
    const [inv] = await ctx.db.insert(ctx.schema.supplierInvoices).values({
      branchId: ctx.branchId, createdById: ctx.users.manager.id, approvedById: ctx.users.manager.id, supplierName: 'Acme Depot', invoiceNumber: 'AD-9',
      invoiceDate: approvedAt, totalAmount: '8000.00', status: 'APPROVED', approvedAt,
    }).returning();
    await ctx.db.insert(ctx.schema.supplierInvoiceItems).values({ invoiceId: inv.id, productId: ctx.products[0].id, rawDescription: 'TW 750', quantity: 10, costPrice: '800', lineCostTotal: '8000.00' });

    const before = await stockOf(ctx.products[0].id);
    const res = await call('POST', '/purchase-returns', 'manager', { branchId: ctx.branchId, supplierName: 'Acme Depot', invoiceId: inv.id, reason: 'two bottles arrived leaking', items: [{ productId: ctx.products[0].id, quantity: 2, unitCost: '800' }] });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ amount: '1600.00', items: [{ quantity: 2, amount: '1600.00' }] });
    expect(await stockOf(ctx.products[0].id)).toBe(before - 2);
    expect(await linesOf('PURCHASE_RETURN', res.json().id)).toEqual({ SUNDRY_CREDITORS: { debit: 1600, credit: 0 }, PURCHASES: { debit: 0, credit: 1600 } });
    const ageing = (await call('GET', `/accounting/suppliers/${ctx.branchId}/ageing`, 'manager')).json();
    expect(ageing.suppliers[0]).toMatchObject({ supplier: 'Acme Depot', outstanding: '6400.00' });
  });

  it('defaults to what the outlet last paid, and is checked', async () => {
    const dflt = await call('POST', '/purchase-returns', 'manager', { branchId: ctx.branchId, supplierName: 'Acme Depot', reason: 'wrong brand delivered', items: [{ productId: ctx.products[1].id, quantity: 1 }] });
    expect(dflt.statusCode, dflt.body).toBe(201);
    expect(dflt.json().amount).toBe('150.00');   // the beer's recorded cost
    const big = await call('POST', '/purchase-returns', 'manager', { branchId: ctx.branchId, supplierName: 'Acme Depot', reason: 'returning far too many', items: [{ productId: ctx.products[0].id, quantity: 99_999, unitCost: '800' }] });
    expect(big.statusCode).toBe(422);
    expect((await call('POST', '/purchase-returns', 'cashier', { branchId: ctx.branchId, supplierName: 'Acme Depot', reason: 'not for a cashier', items: [{ productId: ctx.products[0].id, quantity: 1 }] })).statusCode).toBe(403);
  });
});

describe('margin report', () => {
  it('reports revenue, cost and margin per product from the outlet costs, with returns taken off', async () => {
    const res = await call('GET', `/reports/margin/${ctx.branchId}`, 'manager');
    expect(res.statusCode, res.body).toBe(200);
    const rep = res.json();
    const beer = rep.rows.find((r: { productId: string }) => r.productId === ctx.products[1].id);
    // sold 2 on credit + 1 on the voided bill excluded; one of the two came back
    expect(beer.quantity).toBe(1);
    expect(beer.unitCost).toBe('150.00');
    expect(Number(beer.margin)).toBeCloseTo(Number(beer.revenue) - 150, 2);
    expect(Number(beer.revenue)).toBeLessThan(200);   // net of tax
    // all three whisky came back: nothing left to report
    expect(rep.rows.find((r: { productId: string }) => r.productId === ctx.products[0].id)).toBeUndefined();
    expect(rep.totals.withoutCost).toBe(0);
  });

  it('needs the cost permission, a sane period, and the right branch', async () => {
    expect((await call('GET', `/reports/margin/${ctx.branchId}`, 'cashier')).statusCode).toBe(403);
    expect((await call('GET', `/reports/margin/${ctx.branchId}?from=2020-01-01&to=2026-01-01`, 'manager')).statusCode).toBe(422);
    expect((await call('GET', `/reports/margin/${ctx.branchId}?from=2026-02-01&to=2026-01-01`, 'manager')).statusCode).toBe(400);
    const foreign = await ctx.app.inject({
      method: 'GET', url: `/api/v1/reports/margin/${ctx.branchId}`,
      headers: ctx.authFor({ sub: ctx.otherBranchManager.id, email: ctx.otherBranchManager.email, role: 'manager', branchId: ctx.otherBranchId }),
    });
    expect(foreign.statusCode).toBe(403);
  });
});
