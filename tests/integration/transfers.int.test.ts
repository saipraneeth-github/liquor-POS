import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import { and, eq } from 'drizzle-orm';
import { setupIntegration, type IntegrationContext } from './helpers.js';
import { planReceipt, validateDispatch } from '../../src/modules/transfers/transfer.engine.js';

let ctx: IntegrationContext;
let branchB = '';
let managerB: { authorization: string };
let transferId = '';

beforeAll(async () => {
  ctx = await setupIntegration();
  const [syn] = await ctx.db.select().from(ctx.schema.branches).where(eq(ctx.schema.branches.id, ctx.branchId));
  const [b] = await ctx.db.insert(ctx.schema.branches).values({ name: 'Second Outlet', code: 'SEC', syndicateId: syn.syndicateId }).returning();
  branchB = b.id;
  const [u] = await ctx.db.insert(ctx.schema.users).values({
    name: 'Manager B', email: 'managerb@test.local', passwordHash: await bcrypt.hash('Password@123', 4), role: 'manager', branchId: branchB,
  }).returning();
  managerB = ctx.authFor({ sub: u.id, email: u.email, role: 'manager', branchId: branchB });
  // the sender paid 800 a bottle for the whisky
  await ctx.db.insert(ctx.schema.branchProductCosts).values({ branchId: ctx.branchId, productId: ctx.products[0].id, costPrice: '800' });
}, 120_000);
afterAll(async () => { await ctx?.app.close(); });

const send = (headers: { authorization: string }, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  ctx.app.inject({ method, url: `/api/v1${url}`, headers, payload: payload as never });
const stockOf = async (branchId: string, productId: string) =>
  (await ctx.db.select().from(ctx.schema.stock).where(and(eq(ctx.schema.stock.branchId, branchId), eq(ctx.schema.stock.productId, productId))))[0]?.quantity ?? 0;

describe('transfer rules (pure)', () => {
  it('validates a dispatch list', () => {
    expect(validateDispatch([])).toEqual(['Add at least one product']);
    expect(validateDispatch([{ productId: 'a', quantity: 2 }, { productId: 'a', quantity: 1 }])).toContain('A product appears twice');
    expect(validateDispatch([{ productId: 'a', quantity: 0 }])).toContain('Quantities must be whole numbers above zero');
    expect(validateDispatch([{ productId: 'a', quantity: 3 }])).toEqual([]);
  });
  it('plans a receipt: unlisted lines arrive in full, shortfalls are recorded, extras refused', () => {
    const sent = [{ productId: 'a', quantity: 10 }, { productId: 'b', quantity: 4 }];
    expect(planReceipt(sent).totalShortage).toBe(0);
    const plan = planReceipt(sent, [{ productId: 'a', receivedQuantity: 8 }]);
    expect(plan.lines).toEqual([{ productId: 'a', sent: 10, received: 8, shortage: 2 }, { productId: 'b', sent: 4, received: 4, shortage: 0 }]);
    expect(plan).toMatchObject({ totalSent: 14, totalReceived: 12, totalShortage: 2 });
    expect(() => planReceipt(sent, [{ productId: 'a', receivedQuantity: 11 }])).toThrow(/More arrived/);
    expect(() => planReceipt(sent, [{ productId: 'z', receivedQuantity: 1 }])).toThrow(/not sent/);
  });
});

describe('dispatch', () => {
  it('takes the bottles out of the sender at once and holds them in transit', async () => {
    const before = await stockOf(ctx.branchId, ctx.products[0].id);
    const res = await send(ctx.auth('manager'), 'POST', '/transfers', { fromBranchId: ctx.branchId, toBranchId: branchB, note: 'weekend rush', items: [{ productId: ctx.products[0].id, quantity: 5 }] });
    expect(res.statusCode, res.body).toBe(201);
    const t = res.json();
    transferId = t.id;
    expect(t).toMatchObject({ status: 'IN_TRANSIT', totalBottles: 5, fromBranchName: 'Main', toBranchName: 'Second Outlet' });
    expect(t.transferNumber).toMatch(/^TR-\d{8}-[0-9A-F]{6}$/);
    expect(await stockOf(ctx.branchId, ctx.products[0].id)).toBe(before - 5);
    expect(await stockOf(branchB, ctx.products[0].id)).toBe(0);
    const audit = await ctx.db.select().from(ctx.schema.stockAudit).where(and(eq(ctx.schema.stockAudit.referenceId, transferId), eq(ctx.schema.stockAudit.reason, 'TRANSFER_OUT')));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ branchId: ctx.branchId, changeQty: -5 });
  });

  it('is refused for a cashier, for more than the sender has, to another business, and from an outlet you do not work in', async () => {
    const line = [{ productId: ctx.products[0].id, quantity: 1 }];
    expect((await send(ctx.auth('cashier'), 'POST', '/transfers', { fromBranchId: ctx.branchId, toBranchId: branchB, items: line })).statusCode).toBe(403);
    const big = await send(ctx.auth('manager'), 'POST', '/transfers', { fromBranchId: ctx.branchId, toBranchId: branchB, items: [{ productId: ctx.products[0].id, quantity: 99_999 }] });
    expect(big.statusCode).toBe(422);
    expect(big.json().error).toMatch(/Insufficient stock/);
    const foreign = await send(ctx.auth('manager'), 'POST', '/transfers', { fromBranchId: ctx.branchId, toBranchId: ctx.otherBranchId, items: line });
    expect(foreign.statusCode).toBe(422);
    expect(foreign.json().error).toMatch(/same business/);
    expect((await send(ctx.auth('manager'), 'POST', '/transfers', { fromBranchId: ctx.branchId, toBranchId: ctx.branchId, items: line })).statusCode).toBe(422);
    // B's manager cannot send out of A
    expect((await send(managerB, 'POST', '/transfers', { fromBranchId: ctx.branchId, toBranchId: branchB, items: line })).statusCode).toBe(403);
    // a failed dispatch leaves the stock alone
    expect(await stockOf(ctx.branchId, ctx.products[0].id)).toBeGreaterThan(0);
  });
});

describe('receipt', () => {
  it('only the receiving outlet confirms, once, at what actually arrived', async () => {
    expect((await send(ctx.auth('manager'), 'POST', `/transfers/${transferId}/receive`, {})).statusCode).toBe(403);   // the sender cannot confirm
    const senderBefore = await stockOf(ctx.branchId, ctx.products[0].id);

    const res = await send(managerB, 'POST', `/transfers/${transferId}/receive`, { items: [{ productId: ctx.products[0].id, receivedQuantity: 4 }] });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: 'RECEIVED', shortage: 1, items: [{ quantity: 5, receivedQuantity: 4 }] });
    expect(await stockOf(branchB, ctx.products[0].id)).toBe(4);
    expect(await stockOf(ctx.branchId, ctx.products[0].id)).toBe(senderBefore);     // the one lost bottle does not come back

    const inAudit = await ctx.db.select().from(ctx.schema.stockAudit).where(and(eq(ctx.schema.stockAudit.referenceId, transferId), eq(ctx.schema.stockAudit.reason, 'TRANSFER_IN')));
    expect(inAudit).toHaveLength(1);
    expect(inAudit[0]).toMatchObject({ branchId: branchB, changeQty: 4 });

    // the receiving outlet starts from what the sender paid
    const cost = await ctx.db.select().from(ctx.schema.branchProductCosts).where(and(eq(ctx.schema.branchProductCosts.branchId, branchB), eq(ctx.schema.branchProductCosts.productId, ctx.products[0].id)));
    expect(Number(cost[0]?.costPrice)).toBe(800);

    expect((await send(managerB, 'POST', `/transfers/${transferId}/receive`, {})).statusCode).toBe(409);
  });
});

describe('cancel, list and detail', () => {
  it('the sender cancels a transfer still on the way and the bottles come back', async () => {
    const beerBefore = await stockOf(ctx.branchId, ctx.products[1].id);
    const t = (await send(ctx.auth('manager'), 'POST', '/transfers', { fromBranchId: ctx.branchId, toBranchId: branchB, items: [{ productId: ctx.products[1].id, quantity: 3 }] })).json();
    expect(await stockOf(ctx.branchId, ctx.products[1].id)).toBe(beerBefore - 3);

    expect((await send(managerB, 'POST', `/transfers/${t.id}/cancel`, { reason: 'changed our mind' })).statusCode).toBe(403);   // not the sender
    expect((await send(ctx.auth('manager'), 'POST', `/transfers/${t.id}/cancel`, { reason: 'no' })).statusCode).toBe(400);
    const res = await send(ctx.auth('manager'), 'POST', `/transfers/${t.id}/cancel`, { reason: 'sent to the wrong outlet' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().status).toBe('CANCELLED');
    expect(await stockOf(ctx.branchId, ctx.products[1].id)).toBe(beerBefore);
    expect((await send(managerB, 'POST', `/transfers/${t.id}/receive`, {})).statusCode).toBe(409);   // too late to receive
  });

  it('lists what an outlet sent or is due to receive, and each end can open the detail', async () => {
    const mine = (await send(ctx.auth('manager'), 'GET', `/transfers?branchId=${ctx.branchId}`)).json();
    expect(mine.transfers.length).toBeGreaterThanOrEqual(2);
    const incoming = (await send(managerB, 'GET', `/transfers?branchId=${branchB}&status=RECEIVED`)).json();
    expect(incoming.transfers).toHaveLength(1);
    expect((await send(managerB, 'GET', `/transfers/${transferId}`)).statusCode).toBe(200);
    expect((await send(ctx.auth('manager'), 'GET', `/transfers/${transferId}`)).statusCode).toBe(200);
    // an outlet of another business sees nothing of it
    const foreign = ctx.authFor({ sub: ctx.otherBranchManager.id, email: ctx.otherBranchManager.email, role: 'manager', branchId: ctx.otherBranchId });
    expect((await send(foreign, 'GET', `/transfers/${transferId}`)).statusCode).toBe(403);
    expect((await send(foreign, 'GET', `/transfers?branchId=${ctx.branchId}`)).statusCode).toBe(403);
  });
});
