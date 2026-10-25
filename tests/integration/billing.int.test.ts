import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { setupIntegration, type IntegrationContext } from './helpers.js';

let ctx: IntegrationContext;
let whiskyId: string;
let beerId: string;

beforeAll(async () => {
  ctx = await setupIntegration();
  whiskyId = ctx.products[0].id;
  beerId = ctx.products[1].id;
}, 60_000);

afterAll(async () => {
  await ctx?.app.close();
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────

async function stockOf(productId: string, branchId = ctx.branchId): Promise<number> {
  const [row] = await ctx.db.select().from(ctx.schema.stock)
    .where(and(eq(ctx.schema.stock.branchId, branchId), eq(ctx.schema.stock.productId, productId)));
  return row?.quantity ?? 0;
}

function postBill(payload: Record<string, unknown>, headers = ctx.auth('cashier')) {
  return ctx.app.inject({
    method: 'POST', url: '/api/v1/bills', headers,
    payload: { branchId: ctx.branchId, paymentMode: 'CASH', ...payload },
  });
}

function voidBill(id: string, headers = ctx.auth('manager')) {
  return ctx.app.inject({
    method: 'POST', url: `/api/v1/bills/${id}/void`, headers,
    payload: { voidReason: 'Customer changed mind' },
  });
}

const otherManager = () => ctx.authFor({
  sub: ctx.otherBranchManager.id, email: ctx.otherBranchManager.email, role: 'manager', branchId: ctx.otherBranchId,
});

// ─── TAX / ITEMS ──────────────────────────────────────────────────────────────

describe('bill calculation', () => {
  it('applies the category tax rate (beer 12%, whisky 18%)', async () => {
    const res = await postBill({ items: [{ productId: beerId, quantity: 1 }, { productId: whiskyId, quantity: 1 }] });
    expect(res.statusCode).toBe(201);
    const bill = res.json();
    const beerLine = bill.items.find((i: any) => i.productId === beerId);
    const whiskyLine = bill.items.find((i: any) => i.productId === whiskyId);
    expect(beerLine.taxRate).toBe('12.00');
    expect(beerLine.taxAmount).toBe('21.43');
    expect(whiskyLine.taxRate).toBe('18.00');
    expect(whiskyLine.taxAmount).toBe('152.54');
    expect(bill.taxAmount).toBe('173.97');
    expect(bill.total).toBe('1200.00');
    expect(bill.billNumber).toMatch(/^MAIN-\d{4}-\d{6}$/);
  });

  it('merges duplicate productIds into one line and deducts once', async () => {
    const before = await stockOf(beerId);
    const res = await postBill({ items: [{ productId: beerId, quantity: 1 }, { productId: beerId, quantity: 2 }] });
    expect(res.statusCode).toBe(201);
    expect(res.json().items).toHaveLength(1);
    expect(res.json().items[0].quantity).toBe(3);
    expect(await stockOf(beerId)).toBe(before - 3);
  });

  it('rejects unknown products with 422 and oversell with 422', async () => {
    const unknown = await postBill({ items: [{ productId: '00000000-0000-4000-8000-000000000000', quantity: 1 }] });
    expect(unknown.statusCode).toBe(422);
    const tooMany = await postBill({ items: [{ productId: whiskyId, quantity: 100_00 }] });
    expect(tooMany.statusCode).toBe(422);
    expect(tooMany.json().error).toMatch(/Insufficient stock/);
  });
});

// ─── VOID ─────────────────────────────────────────────────────────────────────

describe('void', () => {
  it('denies voiding a bill from another branch (403) and leaves it PAID', async () => {
    const bill = (await postBill({ items: [{ productId: whiskyId, quantity: 1 }] })).json();
    const res = await voidBill(bill.id, otherManager());
    expect(res.statusCode).toBe(403);
    const [row] = await ctx.db.select().from(ctx.schema.bills).where(eq(ctx.schema.bills.id, bill.id));
    expect(row.status).toBe('PAID');
  });

  it('voids once (stock restored + audit) and rejects the second void with 422', async () => {
    const before = await stockOf(whiskyId);
    const bill = (await postBill({ items: [{ productId: whiskyId, quantity: 2 }] })).json();
    expect(await stockOf(whiskyId)).toBe(before - 2);

    const first = await voidBill(bill.id);
    expect(first.statusCode).toBe(200);
    expect(await stockOf(whiskyId)).toBe(before);

    const second = await voidBill(bill.id);
    expect(second.statusCode).toBe(422);
    expect(second.json().error).toBe('Bill is already voided');
    expect(await stockOf(whiskyId)).toBe(before);

    const audits = await ctx.db.select().from(ctx.schema.stockAudit)
      .where(and(eq(ctx.schema.stockAudit.referenceId, bill.id), eq(ctx.schema.stockAudit.reason, 'VOID_REVERSAL')));
    expect(audits).toHaveLength(1);
    expect(audits[0].changeQty).toBe(2);
  });

  it('concurrent voids of the same bill reverse stock exactly once', async () => {
    const before = await stockOf(beerId);
    const bill = (await postBill({ items: [{ productId: beerId, quantity: 4 }] })).json();
    const results = await Promise.all([voidBill(bill.id), voidBill(bill.id), voidBill(bill.id)]);
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 422)).toHaveLength(2);
    expect(await stockOf(beerId)).toBe(before);
  });

  it('returns 404 for an unknown bill', async () => {
    const res = await voidBill('00000000-0000-4000-8000-000000000000');
    expect(res.statusCode).toBe(404);
  });
});

// ─── CONCURRENCY ──────────────────────────────────────────────────────────────

describe('concurrent bill creation', () => {
  it('never oversells and issues unique bill numbers', async () => {
    const [p] = await ctx.db.insert(ctx.schema.products).values({
      name: 'Race Rum', brand: 'RR', mrp: '500.00', categoryId: ctx.products[0].categoryId,
    }).returning();
    await ctx.db.insert(ctx.schema.stock).values({ branchId: ctx.branchId, productId: p.id, quantity: 100 });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => postBill({ items: [{ productId: p.id, quantity: 30 }] })),
    );
    const ok = results.filter((r) => r.statusCode === 201);
    const rejected = results.filter((r) => r.statusCode === 422);
    expect(ok).toHaveLength(3);
    expect(rejected).toHaveLength(2);
    expect(await stockOf(p.id)).toBe(10);

    const numbers = ok.map((r) => r.json().billNumber);
    expect(new Set(numbers).size).toBe(numbers.length);

    const allNumbers = (await ctx.db.select({ n: ctx.schema.bills.billNumber }).from(ctx.schema.bills)).map((r) => r.n);
    expect(new Set(allNumbers).size).toBe(allNumbers.length);
  });
});

// ─── CREDIT (KHATA) ───────────────────────────────────────────────────────────

describe('CREDIT sales', () => {
  let customerId: string;

  beforeAll(async () => {
    const [c] = await ctx.db.insert(ctx.schema.customers).values({
      branchId: ctx.branchId, name: 'Ravi', phone: '9000000001', creditAllowed: true, creditLimit: '2500.00',
    }).returning();
    customerId = c.id;
  });

  async function customer() {
    const [c] = await ctx.db.select().from(ctx.schema.customers).where(eq(ctx.schema.customers.id, customerId));
    return c;
  }

  it('requires customerId (400)', async () => {
    const res = await postBill({ paymentMode: 'CREDIT', items: [{ productId: beerId, quantity: 1 }] });
    expect(res.statusCode).toBe(400);
  });

  it('enforces the credit limit, records PURCHASE, and reverses on void', async () => {
    const first = await postBill({ paymentMode: 'CREDIT', customerId, items: [{ productId: whiskyId, quantity: 2 }] });
    expect(first.statusCode).toBe(201);
    expect(first.json().customerId).toBe(customerId);
    expect((await customer()).currentCredit).toBe('2000.00');

    const txns = await ctx.db.select().from(ctx.schema.creditTransactions)
      .where(eq(ctx.schema.creditTransactions.customerId, customerId));
    expect(txns).toHaveLength(1);
    expect(txns[0]).toMatchObject({ type: 'PURCHASE', amount: '2000.00', balanceAfter: '2000.00', billId: first.json().id });

    const stockBefore = await stockOf(whiskyId);
    const over = await postBill({ paymentMode: 'CREDIT', customerId, items: [{ productId: whiskyId, quantity: 1 }] });
    expect(over.statusCode).toBe(422);
    expect(over.json().error).toMatch(/Credit limit exceeded/);
    expect(await stockOf(whiskyId)).toBe(stockBefore);          // rolled back
    expect((await customer()).currentCredit).toBe('2000.00');

    const voided = await voidBill(first.json().id);
    expect(voided.statusCode).toBe(200);
    expect((await customer()).currentCredit).toBe('0.00');
    const adj = await ctx.db.select().from(ctx.schema.creditTransactions)
      .where(and(eq(ctx.schema.creditTransactions.customerId, customerId), eq(ctx.schema.creditTransactions.type, 'ADJUSTMENT')));
    expect(adj).toHaveLength(1);
    expect(adj[0]).toMatchObject({ amount: '2000.00', balanceAfter: '0.00' });
  });

  it('rejects customers from another branch or without credit permission', async () => {
    const [foreign] = await ctx.db.insert(ctx.schema.customers).values({
      branchId: ctx.otherBranchId, name: 'Elsewhere', phone: '9000000002', creditAllowed: true, creditLimit: '9999.00',
    }).returning();
    const [noCredit] = await ctx.db.insert(ctx.schema.customers).values({
      branchId: ctx.branchId, name: 'Cash only', phone: '9000000003', creditAllowed: false, creditLimit: '9999.00',
    }).returning();

    const a = await postBill({ paymentMode: 'CREDIT', customerId: foreign.id, items: [{ productId: beerId, quantity: 1 }] });
    expect(a.statusCode).toBe(422);
    const b = await postBill({ paymentMode: 'CREDIT', customerId: noCredit.id, items: [{ productId: beerId, quantity: 1 }] });
    expect(b.statusCode).toBe(422);
    expect(b.json().error).toMatch(/not allowed/);
  });
});

// ─── IDEMPOTENCY ──────────────────────────────────────────────────────────────

describe('clientRef idempotency', () => {
  it('returns the existing bill with 200 and deducts stock once', async () => {
    const before = await stockOf(beerId);
    const payload = { clientRef: 'offline-device-1-0001', items: [{ productId: beerId, quantity: 2 }] };
    const first = await postBill(payload);
    expect(first.statusCode).toBe(201);
    const second = await postBill(payload);
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
    expect(await stockOf(beerId)).toBe(before - 2);
  });

  it('handles concurrent submissions of the same clientRef', async () => {
    const payload = { clientRef: 'offline-device-1-0002', items: [{ productId: beerId, quantity: 1 }] };
    const results = await Promise.all([postBill(payload), postBill(payload), postBill(payload)]);
    const ids = new Set(results.map((r) => r.json().id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
  });

  it('rejects clientRef longer than 64 chars', async () => {
    const res = await postBill({ clientRef: 'x'.repeat(65), items: [{ productId: beerId, quantity: 1 }] });
    expect(res.statusCode).toBe(400);
  });
});

// ─── HISTORY / EVENTS ─────────────────────────────────────────────────────────

describe('bill history & domain events', () => {
  it('GET /bills lists newest first with pagination and status filter', async () => {
    const { businessDateOf } = await import('../../src/lib/business-day.js');
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/bills?branchId=${ctx.branchId}&date=${businessDateOf()}&status=PAID&limit=2`,
      headers: ctx.auth('cashier'),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.bills).toHaveLength(2);
    expect(body.total).toBeGreaterThan(2);
    expect(body.bills.every((b: any) => b.status === 'PAID')).toBe(true);
    expect(new Date(body.bills[0].createdAt).getTime()).toBeGreaterThanOrEqual(new Date(body.bills[1].createdAt).getTime());
  });

  it('GET /bills denies another branch (403) and validates input (400)', async () => {
    const denied = await ctx.app.inject({ method: 'GET', url: `/api/v1/bills?branchId=${ctx.branchId}`, headers: otherManager() });
    expect(denied.statusCode).toBe(403);
    const bad = await ctx.app.inject({ method: 'GET', url: `/api/v1/bills?branchId=${ctx.branchId}&date=24-10-2026`, headers: ctx.auth('cashier') });
    expect(bad.statusCode).toBe(400);
  });

  it('emits bill.paid inside the transaction; a failing handler rolls the sale back', async () => {
    const { onDomainEvent } = await import('../../src/lib/domain-events.js');
    const seen: string[] = [];
    const offOk = onDomainEvent('bill.paid', async ({ bill, items }, tx) => {
      const [row] = await tx.select().from(ctx.schema.bills).where(eq(ctx.schema.bills.id, bill.id));
      seen.push(`${row.billNumber}:${items.length}`);
    });
    const ok = await postBill({ items: [{ productId: beerId, quantity: 1 }] });
    expect(ok.statusCode).toBe(201);
    expect(seen).toEqual([`${ok.json().billNumber}:1`]);
    offOk();

    const before = await stockOf(beerId);
    const billsBefore = (await ctx.db.select().from(ctx.schema.bills)).length;
    const offFail = onDomainEvent('bill.paid', () => { throw new Error('ledger posting failed'); });
    const failed = await postBill({ items: [{ productId: beerId, quantity: 1 }] });
    offFail();
    expect(failed.statusCode).toBe(422);
    expect(await stockOf(beerId)).toBe(before);
    expect((await ctx.db.select().from(ctx.schema.bills)).length).toBe(billsBefore);
  });
});
