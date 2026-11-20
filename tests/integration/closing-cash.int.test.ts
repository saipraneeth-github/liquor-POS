/**
 * Drawer cash includes khata repayments taken in cash and excludes cash expenses; a day cannot be closed while a shift is
 * open; a closed day takes no more bills until it is reopened (audited).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIntegration, type IntegrationContext } from './helpers.js';
import { businessDateOf } from '../../src/lib/business-day.js';

let ctx: IntegrationContext;
beforeAll(async () => { ctx = await setupIntegration(); }, 120_000);
afterAll(async () => { await ctx?.app.close(); });

type Role = 'manager' | 'cashier' | 'office_admin';
const call = (method: 'GET' | 'POST', url: string, role: Role, payload?: unknown) =>
  ctx.app.inject({ method, url: `/api/v1${url}`, headers: ctx.auth(role), payload: payload as never });

const today = businessDateOf();
let shiftId = '';
let cashBill = 0;          // what the cash bill came to
let closingId = '';

describe('drawer cash', () => {
  it('a shift expects float + cash sales + cash khata repayments', async () => {
    const term = await call('POST', `/terminals/${ctx.branchId}`, 'manager', { terminalName: 'Counter 1' });
    expect(term.statusCode, term.body).toBe(201);
    const open = await call('POST', '/shifts/open', 'cashier', { terminalId: term.json().id, openingFloat: '500.00' });
    expect(open.statusCode, open.body).toBe(201);
    shiftId = open.json().id;

    const bill = await call('POST', '/bills', 'cashier', { branchId: ctx.branchId, paymentMode: 'CASH', items: [{ productId: ctx.products[0].id, quantity: 1 }] });
    expect(bill.statusCode, bill.body).toBe(201);
    cashBill = Number(bill.json().total);

    const cust = await call('POST', `/customers/${ctx.branchId}`, 'manager', { name: 'Khata Ravi', phone: '9876511111', creditAllowed: true, creditLimit: '100000' });
    expect(cust.statusCode, cust.body).toBe(201);
    const customerId = cust.json().customer.id;
    const credit = await call('POST', '/bills', 'cashier', { branchId: ctx.branchId, paymentMode: 'CREDIT', customerId, items: [{ productId: ctx.products[1].id, quantity: 1 }] });
    expect(credit.statusCode, credit.body).toBe(201);
    const repay = await call('POST', `/customers/${customerId}/repayments`, 'cashier', { amount: '100.00', paymentMode: 'CASH' });
    expect(repay.statusCode, repay.body).toBe(201);

    const cur = (await call('GET', '/shifts/current', 'cashier')).json().shift;
    expect(cur.summary.cashRepayments).toBe('100.00');
    expect(Number(cur.summary.expectedCash)).toBeCloseTo(500 + cashBill + 100, 2);
  });

  it('a closing cannot be submitted while a shift is open', async () => {
    const res = await call('POST', '/closing', 'manager', { branchId: ctx.branchId, openingCash: '0.00', actualCashCounted: '0.00', businessDate: today });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/open cashier shift/i);
  });

  it('closing = opening + cash sales + cash repayments - cash expenses - withdrawals', async () => {
    const closeShift = await call('POST', `/shifts/${shiftId}/close`, 'cashier', { denominations: { '500': 1 } });
    expect(closeShift.statusCode, closeShift.body).toBe(200);

    const exp = await call('POST', `/expenses/${ctx.branchId}`, 'manager', { category: 'Tea', amount: '40.00', paymentMode: 'CASH', expenseDate: today });
    expect(exp.statusCode, exp.body).toBe(201);

    const preview = (await call('GET', `/closing/preview?branchId=${ctx.branchId}&date=${today}`, 'manager')).json();
    expect(preview.sales.cashRepayments).toBe('100.00');
    expect(preview.sales.cashExpenses).toBe('40.00');

    const expected = (cashBill + 100 - 40).toFixed(2);
    const res = await call('POST', '/closing', 'manager', { branchId: ctx.branchId, openingCash: '0.00', actualCashCounted: expected, businessDate: today });
    expect(res.statusCode, res.body).toBe(201);
    const row = res.json();
    expect(row).toMatchObject({ cashRepayments: '100.00', cashExpenses: '40.00', expectedCashInDrawer: expected, isBalanced: true });
    closingId = row.id;
  });
});

describe('closed day', () => {
  it('takes no more bills', async () => {
    const res = await call('POST', '/bills', 'cashier', { branchId: ctx.branchId, paymentMode: 'CASH', items: [{ productId: ctx.products[0].id, quantity: 1 }] });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/already closed/i);
  });

  it('is reopened only by an office admin / owner, with a reason, and then takes bills again', async () => {
    expect((await call('POST', `/closing/${closingId}/reopen`, 'manager', { reason: 'closed too early by mistake' })).statusCode).toBe(403);
    expect((await call('POST', `/closing/${closingId}/reopen`, 'office_admin', { reason: 'short' })).statusCode).toBe(400);
    const ok = await call('POST', `/closing/${closingId}/reopen`, 'office_admin', { reason: 'closed too early by mistake' });
    expect(ok.statusCode, ok.body).toBe(200);

    const audits = await ctx.db.select().from(ctx.schema.auditLog);
    expect(audits.some((a) => a.action === 'closing.reopen')).toBe(true);

    const bill = await call('POST', '/bills', 'cashier', { branchId: ctx.branchId, paymentMode: 'CASH', items: [{ productId: ctx.products[0].id, quantity: 1 }] });
    expect(bill.statusCode, bill.body).toBe(201);
  });
});
