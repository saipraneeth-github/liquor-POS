import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { setupIntegration, type IntegrationContext } from './helpers.js';

let ctx: IntegrationContext;
beforeAll(async () => { ctx = await setupIntegration(); }, 180_000);
afterAll(async () => { await ctx?.app.close(); });

const inject = (method: 'GET' | 'POST' | 'PATCH', url: string, headers: Record<string, string>, payload?: unknown) =>
  ctx.app.inject({ method, url: `/api/v1${url}`, headers, payload: payload as object | undefined });
const other = () => ctx.authFor({ sub: ctx.otherBranchManager.id, email: ctx.otherBranchManager.email, role: 'manager', branchId: ctx.otherBranchId });

type Floor = { id: string; name: string; status: string; currentSessionId: string | null; sessionTotal: string | null; sessionItems: number | null; sessionToServe: number | null; sessionGuestCount: number | null; sessionStewardName: string | null; sessionLastOrderAt: string | null };
const floor = async () => (await inject('GET', `/tables/${ctx.branchId}`, ctx.auth('steward'))).json().tables as Floor[];
const row = async (id: string) => (await floor()).find((t) => t.id === id)!;

let seq = 0;
async function newTable(open = false, guests?: number) {
  const t = (await inject('POST', `/tables/${ctx.branchId}`, ctx.auth('manager'), { name: `FT-${++seq}-${Math.random().toString(36).slice(2, 5)}` })).json().table as { id: string; name: string };
  let sessionId: string | null = null;
  if (open) {
    const o = await inject('POST', `/tables/${t.id}/open`, ctx.auth('cashier'), { branchId: ctx.branchId, stewardId: ctx.users.steward.id, ...(guests ? { guestCount: guests } : {}) });
    expect(o.statusCode, o.body).toBe(201);
    sessionId = o.json().session.id;
  }
  return { ...t, sessionId };
}
const order = async (sessionId: string, productIndex: number, quantity: number, destination: 'BAR' | 'KITCHEN' = 'BAR') => {
  const r = await inject('POST', '/kot', ctx.auth('steward'), { tableSessionId: sessionId, branchId: ctx.branchId, destination, items: [{ productId: ctx.products[productIndex].id, quantity }] });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().kotOrder as { id: string; items: { id: string }[] };
};

describe('the floor shows what each table has spent', () => {
  it('a free table has no bill; an occupied one shows items, total, who serves and what is still to serve', async () => {
    const free = await newTable();
    const busy = await newTable(true, 3);
    expect(await row(free.id)).toMatchObject({ status: 'FREE', sessionTotal: null, sessionItems: null, currentSessionId: null });
    expect(await row(busy.id)).toMatchObject({ status: 'OCCUPIED', sessionTotal: '0.00', sessionItems: 0, sessionToServe: 0, sessionGuestCount: 3, sessionStewardName: 'Test steward' });

    await order(busy.sessionId!, 0, 2);                                   // 2 × ₹1000
    await order(busy.sessionId!, 1, 3, 'KITCHEN');                        // 3 × ₹200
    const t = await row(busy.id);
    expect(t).toMatchObject({ sessionTotal: '2600.00', sessionItems: 5, sessionToServe: 5 });
    expect(t.sessionLastOrderAt).not.toBeNull();
  });

  it('serving takes items off "to serve" but not off the bill; a cancelled item leaves the bill', async () => {
    const t = await newTable(true);
    const k1 = await order(t.sessionId!, 0, 1);
    const k2 = await order(t.sessionId!, 1, 2);
    expect(await row(t.id)).toMatchObject({ sessionTotal: '1400.00', sessionToServe: 3 });

    expect((await inject('POST', `/kot/${k1.id}/serve-all`, ctx.auth('steward'), { branchId: ctx.branchId })).statusCode).toBe(200);
    expect(await row(t.id)).toMatchObject({ sessionTotal: '1400.00', sessionToServe: 2, sessionItems: 3 });

    const cancel = await inject('PATCH', `/kot/${k2.id}/items/${k2.items[0].id}`, ctx.auth('steward'), { status: 'CANCELLED', branchId: ctx.branchId });
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect(await row(t.id)).toMatchObject({ sessionTotal: '1000.00', sessionItems: 1, sessionToServe: 0 });
  });

  it('tables do not see each other\'s orders, and other branches see none of it', async () => {
    const a = await newTable(true);
    const b = await newTable(true);
    await order(a.sessionId!, 0, 1);
    expect((await row(b.id)).sessionTotal).toBe('0.00');
    expect((await inject('GET', `/tables/${ctx.branchId}`, other())).statusCode).toBe(403);
  });
});

describe('moving a party to another table', () => {
  it('takes the open order with it: the old table is free, the new one shows the same bill', async () => {
    const from = await newTable(true, 2);
    const to = await newTable();
    await order(from.sessionId!, 0, 1);

    const r = await inject('POST', `/tables/${from.id}/move`, ctx.auth('steward'), { branchId: ctx.branchId, toTableId: to.id });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ from: from.name, to: to.name });

    expect(await row(from.id)).toMatchObject({ status: 'FREE', currentSessionId: null, sessionTotal: null });
    expect(await row(to.id)).toMatchObject({ status: 'OCCUPIED', currentSessionId: from.sessionId, sessionTotal: '1000.00', sessionGuestCount: 2, sessionStewardName: 'Test steward' });
    // the bill is still raised from the same session, now on the new table
    const bill = await inject('GET', `/kot/session/${from.sessionId}/bill?branchId=${ctx.branchId}`, ctx.auth('cashier'));
    expect(bill.statusCode).toBe(200);
    // and the old table can be used again
    expect((await inject('POST', `/tables/${from.id}/open`, ctx.auth('cashier'), { branchId: ctx.branchId })).statusCode).toBe(201);

    const trail = await ctx.db.select().from(ctx.schema.auditLog).where(eq(ctx.schema.auditLog.action, 'table.move'));
    expect(trail.some((e) => e.targetId === from.sessionId && (e.meta as { to: string }).to === to.name)).toBe(true);
  });

  it('refuses an occupied target, a free source, the same table, other branches, and bad input', async () => {
    const a = await newTable(true);
    const b = await newTable(true);
    const free = await newTable();
    const move = (id: string, body: unknown, auth = ctx.auth('steward')) => inject('POST', `/tables/${id}/move`, auth, body);
    const busy = await move(a.id, { branchId: ctx.branchId, toTableId: b.id });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toMatch(/not free/i);
    expect((await move(free.id, { branchId: ctx.branchId, toTableId: a.id })).statusCode).toBe(409);        // a free table has nobody to move
    expect((await move(a.id, { branchId: ctx.branchId, toTableId: a.id })).statusCode).toBe(422);
    expect((await move(a.id, { branchId: ctx.branchId })).statusCode).toBe(400);
    expect((await move(a.id, { branchId: ctx.branchId, toTableId: '00000000-0000-4000-8000-000000000000' })).statusCode).toBe(404);
    expect((await move(a.id, { branchId: ctx.otherBranchId, toTableId: free.id }, other())).statusCode).toBe(404);   // not their table
    expect((await move(a.id, { branchId: ctx.branchId, toTableId: free.id }, other())).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'POST', url: `/api/v1/tables/${a.id}/move`, payload: { branchId: ctx.branchId, toTableId: free.id } })).statusCode).toBe(401);
    expect(await row(a.id)).toMatchObject({ status: 'OCCUPIED' });                                           // nothing moved
  });
});

describe('merging two tables onto one bill', () => {
  it('moves every order to the other table, adds the guests, closes the first session and frees its table', async () => {
    const a = await newTable(true, 2);
    const b = await newTable(true, 4);
    await order(a.sessionId!, 0, 1);                                      // 1000
    await order(a.sessionId!, 1, 1, 'KITCHEN');                           // 200
    await order(b.sessionId!, 1, 2);                                      // 400

    const r = await inject('POST', `/tables/${a.id}/merge`, ctx.auth('cashier'), { branchId: ctx.branchId, intoTableId: b.id });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ from: a.name, into: b.name, ordersMoved: 2 });

    expect(await row(a.id)).toMatchObject({ status: 'FREE', currentSessionId: null });
    expect(await row(b.id)).toMatchObject({ status: 'OCCUPIED', currentSessionId: b.sessionId, sessionTotal: '1600.00', sessionItems: 4, sessionGuestCount: 6 });
    const [merged] = await ctx.db.select().from(ctx.schema.tableSessions).where(eq(ctx.schema.tableSessions.id, a.sessionId!));
    expect(merged.closedAt).not.toBeNull();
    expect(merged.notes).toContain(`Merged into ${b.name}`);
    const bill = (await inject('GET', `/kot/session/${b.sessionId}/bill?branchId=${ctx.branchId}`, ctx.auth('cashier'))).json();
    expect(JSON.stringify(bill)).toContain('1600');                       // one bill carries both tables' orders
    expect((await ctx.db.select().from(ctx.schema.auditLog).where(eq(ctx.schema.auditLog.action, 'table.merge'))).length).toBeGreaterThanOrEqual(1);
  });

  it('needs both tables occupied, two different tables, a cashier or above, and the same branch', async () => {
    const a = await newTable(true);
    const free = await newTable();
    const merge = (id: string, body: unknown, auth = ctx.auth('cashier')) => inject('POST', `/tables/${id}/merge`, auth, body);
    expect((await merge(a.id, { branchId: ctx.branchId, intoTableId: free.id })).statusCode).toBe(409);
    expect((await merge(free.id, { branchId: ctx.branchId, intoTableId: a.id })).statusCode).toBe(409);
    expect((await merge(a.id, { branchId: ctx.branchId, intoTableId: a.id })).statusCode).toBe(422);
    expect((await merge(a.id, { branchId: ctx.branchId })).statusCode).toBe(400);
    expect((await merge(a.id, { branchId: ctx.branchId, intoTableId: free.id }, ctx.auth('steward'))).statusCode).toBe(403);
    expect((await merge(a.id, { branchId: ctx.branchId, intoTableId: free.id }, other())).statusCode).toBe(403);
    expect(await row(a.id)).toMatchObject({ status: 'OCCUPIED' });
  });
});

describe('serving KOT items deducts stock immediately and rejects if insufficient', () => {
  it('errors when serving an item with insufficient stock, succeeds when sufficient, and avoids double-deduction on checkout', async () => {
    // 1. Create a product with initial stock = 2
    const [cat] = await ctx.db.select().from(ctx.schema.categories).limit(1);
    const [product] = await ctx.db.insert(ctx.schema.products).values({
      name: 'Limited Rum 750ml',
      brand: 'LR',
      barcode: `LR-${Date.now()}`,
      sku: `LR-${Date.now()}`,
      mrp: '500.00',
      costPrice: '400.00',
      categoryId: cat.id,
      volumeMl: 750,
      packQuantity: 12,
    }).returning();
    await ctx.db.insert(ctx.schema.stock).values({
      branchId: ctx.branchId,
      productId: product.id,
      quantity: 2,
      openMl: 0,
    });

    // 2. Table opens and places KOT order for 2 bottles (allowed at order time because stock is 2)
    const t = await newTable(true);
    const orderRes = await inject('POST', '/kot', ctx.auth('steward'), {
      tableSessionId: t.sessionId,
      branchId: ctx.branchId,
      destination: 'BAR',
      items: [{ productId: product.id, quantity: 2 }],
    });
    expect(orderRes.statusCode).toBe(201);
    const kotOrder = orderRes.json().kotOrder;

    // 3. Before serving, stock decreases elsewhere (e.g. counter sale or breakage) so only 1 remains
    await ctx.db.update(ctx.schema.stock)
      .set({ quantity: 1 })
      .where(and(eq(ctx.schema.stock.branchId, ctx.branchId), eq(ctx.schema.stock.productId, product.id)));

    // 4. Steward attempts to serve the 2 bottles -> MUST fail immediately with 422 Insufficient stock
    const serveFail = await inject('POST', `/kot/${kotOrder.id}/serve-all`, ctx.auth('steward'), { branchId: ctx.branchId });
    expect(serveFail.statusCode).toBe(422);
    expect(serveFail.json().error).toMatch(/insufficient stock/i);

    // Cancel this order line
    await inject('PATCH', `/kot/${kotOrder.id}/items/${kotOrder.items[0].id}`, ctx.auth('steward'), { status: 'CANCELLED', branchId: ctx.branchId });

    // 5. Place a new order for 1 bottle (available stock is 1)
    const validOrderRes = await inject('POST', '/kot', ctx.auth('steward'), {
      tableSessionId: t.sessionId,
      branchId: ctx.branchId,
      destination: 'BAR',
      items: [{ productId: product.id, quantity: 1 }],
    });
    expect(validOrderRes.statusCode).toBe(201);
    const validOrder = validOrderRes.json().kotOrder;

    // 6. Serving 1 bottle succeeds and immediately deducts stock in inventory
    const serveOk = await inject('POST', `/kot/${validOrder.id}/serve-all`, ctx.auth('steward'), { branchId: ctx.branchId });
    expect(serveOk.statusCode).toBe(200);

    const [stockAfterServe] = await ctx.db.select().from(ctx.schema.stock)
      .where(and(eq(ctx.schema.stock.branchId, ctx.branchId), eq(ctx.schema.stock.productId, product.id)));
    expect(stockAfterServe.quantity).toBe(0); // 1 - 1 = 0

    // 7. Checkout and bill table: must succeed without stock error and without re-deducting stock
    const checkoutRes = await inject('POST', `/tables/${t.id}/checkout`, ctx.auth('cashier'), {
      branchId: ctx.branchId,
      paymentMode: 'CASH',
    });
    expect(checkoutRes.statusCode, checkoutRes.body).toBe(201);

    const [stockAfterCheckout] = await ctx.db.select().from(ctx.schema.stock)
      .where(and(eq(ctx.schema.stock.branchId, ctx.branchId), eq(ctx.schema.stock.productId, product.id)));
    expect(stockAfterCheckout.quantity).toBe(0); // Still 0, not negative
  });

  it('GET /tables/:branchId/today returns collection and bills exclusively for tables settled today', async () => {
    const res = await inject('GET', `/tables/${ctx.branchId}/today`, ctx.auth('steward'));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('collection');
    expect(body).toHaveProperty('bills');
    expect(Array.isArray(body.bills)).toBe(true);
    expect(body.collection).toMatchObject({
      total: expect.any(String),
      cash: expect.any(String),
      card: expect.any(String),
      upi: expect.any(String),
      credit: expect.any(String),
      billCount: expect.any(Number),
      voidCount: expect.any(Number),
      guestCount: expect.any(Number),
      averageBill: expect.any(String),
      bySection: expect.any(Array),
      byPaymentMode: expect.any(Array),
    });
    // From previous checkout tests, we should have at least 1 table bill
    expect(body.collection.billCount).toBeGreaterThanOrEqual(1);
    expect(Number(body.collection.total)).toBeGreaterThan(0);
    expect(body.bills.length).toBeGreaterThanOrEqual(1);
    const bill = body.bills[0];
    expect(bill).toHaveProperty('billNumber');
    expect(bill).toHaveProperty('tableName');
    expect(bill).toHaveProperty('paymentMode');
    expect(bill).toHaveProperty('items');
  });
});

