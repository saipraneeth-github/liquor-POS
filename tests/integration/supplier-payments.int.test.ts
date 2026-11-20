import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { setupIntegration, type IntegrationContext } from './helpers.js';
import { businessDateOf } from '../../src/lib/business-day.js';

let ctx: IntegrationContext;
beforeAll(async () => {
  ctx = await setupIntegration();
  // an approved supplier invoice: 10 bottles at 800 = 8000 payable, 1000 of it already paid by e-challan
  const approvedAt = new Date(Date.now() - 40 * 86_400_000);
  const [inv] = await ctx.db.insert(ctx.schema.supplierInvoices).values({
    branchId: ctx.branchId, createdById: ctx.users.manager.id, approvedById: ctx.users.manager.id, supplierName: 'Acme Depot', invoiceNumber: 'AD-1',
    invoiceDate: approvedAt, totalAmount: '8000.00', challanAmount: '1000.00', status: 'APPROVED', approvedAt,
  }).returning();
  await ctx.db.insert(ctx.schema.supplierInvoiceItems).values({
    invoiceId: inv.id, productId: ctx.products[0].id, rawDescription: 'TW 750', quantity: 10, costPrice: '800', lineCostTotal: '8000.00',
  });
}, 120_000);
afterAll(async () => { await ctx?.app.close(); });

type Role = 'manager' | 'cashier';
const call = (method: 'GET' | 'POST', url: string, role: Role, payload?: unknown) =>
  ctx.app.inject({ method, url: `/api/v1/accounting/suppliers/${ctx.branchId}${url}`, headers: ctx.auth(role), payload: payload as never });

let bankPaymentId = '';

describe('what is owed', () => {
  it('starts from the approved invoice less its e-challan, aged by invoice date', async () => {
    const res = await call('GET', '/ageing', 'manager');
    expect(res.statusCode, res.body).toBe(200);
    const s = res.json().suppliers[0];
    expect(s).toMatchObject({ supplier: 'Acme Depot', invoiced: '8000.00', paid: '1000.00', outstanding: '7000.00' });
    expect(s.openInvoices[0]).toMatchObject({ number: 'AD-1', bucket: 'd31_60' });
    expect(res.json().totals.outstanding).toBe('7000.00');
  });
});

describe('paying a supplier', () => {
  it('reduces what is owed and posts Dr creditors / Cr bank', async () => {
    const res = await call('POST', '/payments', 'manager', { supplierName: 'acme  depot', amount: '2500.00', paymentMode: 'BANK', reference: 'UTR123' });
    expect(res.statusCode, res.body).toBe(201);
    bankPaymentId = res.json().id;
    expect((await call('GET', '/ageing', 'manager')).json().suppliers[0]).toMatchObject({ outstanding: '4500.00', paid: '3500.00' });

    const { journalVouchers, journalLines, accountLedgers } = ctx.schema;
    const [v] = await ctx.db.select().from(journalVouchers).where(and(eq(journalVouchers.sourceType, 'SUPPLIER_PAYMENT'), eq(journalVouchers.sourceId, bankPaymentId)));
    const lines = await ctx.db.select({ code: accountLedgers.code, debit: journalLines.debit, credit: journalLines.credit })
      .from(journalLines).innerJoin(accountLedgers, eq(accountLedgers.id, journalLines.ledgerId)).where(eq(journalLines.voucherId, v.id));
    expect(Object.fromEntries(lines.map((l) => [l.code, [l.debit, l.credit]]))).toEqual({ SUNDRY_CREDITORS: ['2500.00', '0.00'], BANK: ['0.00', '2500.00'] });
  });

  it('a cash payment leaves the drawer and shows in the closing preview', async () => {
    const res = await call('POST', '/payments', 'manager', { supplierName: 'Acme Depot', amount: '300.00', paymentMode: 'CASH' });
    expect(res.statusCode, res.body).toBe(201);
    const preview = (await ctx.app.inject({ method: 'GET', url: `/api/v1/closing/preview?branchId=${ctx.branchId}&date=${businessDateOf()}`, headers: ctx.auth('manager') })).json();
    expect(preview.sales.cashExpenses).toBe('300.00');
  });

  it('is validated and permission-checked', async () => {
    expect((await call('POST', '/payments', 'cashier', { supplierName: 'Acme Depot', amount: '10', paymentMode: 'CASH' })).statusCode).toBe(403);
    expect((await call('POST', '/payments', 'manager', { supplierName: 'Acme Depot', amount: '0', paymentMode: 'CASH' })).statusCode).toBe(400);
    expect((await call('POST', '/payments', 'manager', { supplierName: 'Acme Depot', amount: '10', paymentMode: 'CASH', paymentDate: '2999-01-01' })).statusCode).toBe(422);
    const foreign = await ctx.app.inject({
      method: 'GET', url: `/api/v1/accounting/suppliers/${ctx.branchId}/ageing`,
      headers: ctx.authFor({ sub: ctx.otherBranchManager.id, email: ctx.otherBranchManager.email, role: 'manager', branchId: ctx.otherBranchId }),
    });
    expect(foreign.statusCode).toBe(403);
  });

  it('can be voided once, which puts the debt back and reverses the voucher', async () => {
    expect((await call('POST', `/payments/${bankPaymentId}/void`, 'manager', { reason: 'short' })).statusCode).toBe(400);
    const res = await call('POST', `/payments/${bankPaymentId}/void`, 'manager', { reason: 'paid to the wrong supplier by mistake' });
    expect(res.statusCode, res.body).toBe(200);
    expect((await call('GET', '/ageing', 'manager')).json().suppliers[0].outstanding).toBe('6700.00');   // 7000 - 300 cash
    const list = (await call('GET', '/payments', 'manager')).json();
    expect(list.count).toBe(1);
    expect(list.payments).toHaveLength(2);
    const { journalVouchers } = ctx.schema;
    expect(await ctx.db.select().from(journalVouchers).where(and(eq(journalVouchers.sourceType, 'SUPPLIER_PAYMENT_VOID'), eq(journalVouchers.sourceId, bankPaymentId)))).toHaveLength(1);
    expect((await call('POST', `/payments/${bankPaymentId}/void`, 'manager', { reason: 'paid to the wrong supplier by mistake' })).statusCode).toBe(409);
  });
});

describe('closed day', () => {
  it('takes no more cash payments, but a bank payment is not a drawer matter', async () => {
    const closed = await ctx.app.inject({ method: 'POST', url: '/api/v1/closing', headers: ctx.auth('manager'), payload: { branchId: ctx.branchId, openingCash: '0.00', actualCashCounted: '0.00', businessDate: businessDateOf(), notes: 'closing for the test, drawer not counted' } });
    expect(closed.statusCode, closed.body).toBe(201);
    const cash = await call('POST', '/payments', 'manager', { supplierName: 'Acme Depot', amount: '50', paymentMode: 'CASH' });
    expect(cash.statusCode).toBe(422);
    expect(cash.json().error).toMatch(/already closed/i);
    expect((await call('POST', '/payments', 'manager', { supplierName: 'Acme Depot', amount: '50', paymentMode: 'UPI' })).statusCode).toBe(201);
  });
});
