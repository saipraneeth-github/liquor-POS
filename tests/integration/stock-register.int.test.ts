import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { setupIntegration, type IntegrationContext } from './helpers.js';
import { businessDateOf } from '../../src/lib/business-day.js';

let ctx: IntegrationContext;
let opening = 0;
const today = businessDateOf();
beforeAll(async () => { ctx = await setupIntegration(); }, 120_000);
afterAll(async () => { await ctx?.app.close(); });

type Role = 'manager' | 'cashier';
const call = (method: 'GET' | 'POST', url: string, role: Role, payload?: unknown) =>
  ctx.app.inject({ method, url: `/api/v1${url}`, headers: ctx.auth(role), payload: payload as never });
const stockOf = async (productId: string) =>
  (await ctx.db.select().from(ctx.schema.stock).where(and(eq(ctx.schema.stock.branchId, ctx.branchId), eq(ctx.schema.stock.productId, productId))))[0]?.quantity ?? 0;

describe('stock register', () => {
  it('records a day of real movements', async () => {
    const whisky = ctx.products[0].id;
    opening = await stockOf(whisky);
    const bill = await call('POST', '/bills', 'cashier', { branchId: ctx.branchId, paymentMode: 'CASH', items: [{ productId: whisky, quantity: 5 }] });
    expect(bill.statusCode, bill.body).toBe(201);
    expect((await call('POST', `/bills/${bill.json().id}/returns`, 'manager', { reason: 'one sealed bottle came back', items: [{ billItemId: bill.json().items[0].id, quantity: 1 }] })).statusCode).toBe(201);
    expect((await call('POST', `/compliance/breakage/${ctx.branchId}`, 'cashier', { productId: whisky, quantity: 2, reason: 'BREAKAGE' })).statusCode).toBeLessThan(300);
    const adj = await call('POST', `/inventory/stock/${ctx.branchId}/adjust`, 'manager', { note: 'physical count found three short', lines: [{ productId: whisky, countedQuantity: (await stockOf(whisky)) - 3 }] });
    expect(adj.statusCode, adj.body).toBe(200);
  });

  it('shows opening, the columns, and a closing that is the stock on the shelf', async () => {
    const res = await call('GET', `/compliance/stock-audit/${ctx.branchId}/register?from=${today}&to=${today}`, 'manager');
    expect(res.statusCode, res.body).toBe(200);
    const row = res.json().rows.find((r: { productId: string }) => r.productId === ctx.products[0].id);
    // sold 5, one came back = 4; broke 2; stock-take took off 3
    expect(row).toMatchObject({ opening, sold: 4, breakage: 2, adjustments: -3, received: 0, closing: opening - 4 - 2 - 3 });
    expect(row.closing).toBe(await stockOf(ctx.products[0].id));
    expect(row.opening + row.received + row.transferIn - row.transferOut - row.returnedToSupplier - row.sold - row.counterSheetSales - row.breakage + row.adjustments).toBe(row.closing);
    expect(res.json().totals.closing).toBeGreaterThan(0);
  });

  it('a period in the past shows what the outlet held then', async () => {
    const res = await call('GET', `/compliance/stock-audit/${ctx.branchId}/register?from=2020-01-01&to=2020-01-31`, 'manager');
    expect(res.statusCode).toBe(200);
    const row = res.json().rows.find((r: { productId: string }) => r.productId === ctx.products[0].id);
    // nothing moved then; everything moved since is taken back off the live figure
    expect(row).toMatchObject({ sold: 0, breakage: 0, closing: opening, opening });
  });

  it('exports CSV and gives one product day by day', async () => {
    const csv = await call('GET', `/compliance/stock-audit/${ctx.branchId}/register?from=${today}&to=${today}&format=csv`, 'manager');
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toContain('stock-register-');
    expect(csv.body).toContain('Test Whisky 750ml');
    expect(csv.body.trim().split('\r\n').at(-1)).toMatch(/^TOTAL,/);

    const day = (await call('GET', `/compliance/stock-audit/${ctx.branchId}/register/${ctx.products[0].id}?from=${today}&to=${today}`, 'manager')).json();
    expect(day.days).toHaveLength(1);
    expect(day.days[0]).toMatchObject({ date: today, opening, sold: 4, breakage: 2, adjustments: -3 });
    expect(day.closing).toBe(await stockOf(ctx.products[0].id));
  });

  it('needs a manager, the right branch and a sane period', async () => {
    expect((await call('GET', `/compliance/stock-audit/${ctx.branchId}/register`, 'cashier')).statusCode).toBe(403);
    expect((await call('GET', `/compliance/stock-audit/${ctx.branchId}/register?from=2020-01-01&to=2026-01-01`, 'manager')).statusCode).toBe(422);
    expect((await call('GET', `/compliance/stock-audit/${ctx.branchId}/register?from=2026-02-01&to=2026-01-01`, 'manager')).statusCode).toBe(400);
    const foreign = await ctx.app.inject({
      method: 'GET', url: `/api/v1/compliance/stock-audit/${ctx.branchId}/register`,
      headers: ctx.authFor({ sub: ctx.otherBranchManager.id, email: ctx.otherBranchManager.email, role: 'manager', branchId: ctx.otherBranchId }),
    });
    expect(foreign.statusCode).toBe(403);
  });
});
