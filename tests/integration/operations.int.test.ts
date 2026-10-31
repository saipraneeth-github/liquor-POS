import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { setupIntegration, type IntegrationContext } from './helpers.js';

let ctx: IntegrationContext;

beforeAll(async () => {
  ctx = await setupIntegration();
}, 60_000);

afterAll(async () => {
  await ctx?.app.close();
});

const inject = (method: 'GET' | 'POST' | 'PATCH', url: string, headers: Record<string, string>, payload?: unknown) =>
  ctx.app.inject({ method, url: `/api/v1${url}`, headers, payload: payload as any });
const otherManager = () => ctx.authFor({
  sub: ctx.otherBranchManager.id, email: ctx.otherBranchManager.email, role: 'manager', branchId: ctx.otherBranchId,
});

async function stockOf(productId: string, branchId = ctx.branchId) {
  const [row] = await ctx.db.select().from(ctx.schema.stock)
    .where(and(eq(ctx.schema.stock.branchId, branchId), eq(ctx.schema.stock.productId, productId)));
  return row?.quantity ?? 0;
}

// ─── INVENTORY ────────────────────────────────────────────────────────────────

describe('supplier invoice approval', () => {
  it('adds stock atomically, audits, records MRP change in price_audit and emits the event', async () => {
    const { onDomainEvent } = await import('../../src/lib/domain-events.js');
    const events: number[] = [];
    const off = onDomainEvent('supplierInvoice.approved', ({ items }) => { events.push(items.length); });

    const [whisky, beer] = ctx.products;
    const before = { w: await stockOf(whisky.id), b: await stockOf(beer.id) };
    const res = await inject('POST', '/inventory/invoices/approve', ctx.auth('manager'), {
      branchId: ctx.branchId, supplierName: 'Acme', invoiceNumber: 'INV-1', totalAmount: '10000.00',
      items: [
        { productId: whisky.id, rawDescription: 'Whisky', quantity: 6, costPrice: '810.00', mrp: '1050.00' },
        { productId: beer.id, rawDescription: 'Beer', quantity: 24, costPrice: '150.10', mrp: '200.00' },
        { productId: beer.id, rawDescription: 'Beer (free)', quantity: 12, costPrice: '0.00', mrp: '200.00' },
      ],
    });
    off();
    expect(res.statusCode).toBe(201);
    expect(events).toEqual([3]);
    expect(await stockOf(whisky.id)).toBe(before.w + 6);
    expect(await stockOf(beer.id)).toBe(before.b + 36);

    const audits = await ctx.db.select().from(ctx.schema.stockAudit).where(eq(ctx.schema.stockAudit.referenceId, res.json().id));
    expect(audits.map((a) => a.reason)).toEqual(['PURCHASE', 'PURCHASE', 'PURCHASE']);

    const prices = await ctx.db.select().from(ctx.schema.priceAudit).where(eq(ctx.schema.priceAudit.productId, whisky.id));
    expect(prices).toHaveLength(1);
    expect(prices[0]).toMatchObject({ oldMrp: '1000.00', newMrp: '1050.00' });
    expect(await ctx.db.select().from(ctx.schema.priceAudit).where(eq(ctx.schema.priceAudit.productId, beer.id))).toHaveLength(0);

    const items = await ctx.db.select().from(ctx.schema.supplierInvoiceItems).where(eq(ctx.schema.supplierInvoiceItems.invoiceId, res.json().id));
    expect(items.find((i) => i.quantity === 24)!.lineCostTotal).toBe('3602.40');
  });

  it('rejects a duplicate invoice (409), unknown products (422), bad decimals (400), foreign branch (403)', async () => {
    const base = { branchId: ctx.branchId, supplierName: 'Acme', totalAmount: '1.00' };
    const item = { productId: ctx.products[0].id, rawDescription: 'W', quantity: 1, costPrice: '1.00', mrp: '1050.00' };
    expect((await inject('POST', '/inventory/invoices/approve', ctx.auth('manager'), { ...base, invoiceNumber: 'INV-1', items: [item] })).statusCode).toBe(409);
    expect((await inject('POST', '/inventory/invoices/approve', ctx.auth('manager'), { ...base, invoiceNumber: 'INV-2', items: [{ ...item, productId: '00000000-0000-4000-8000-000000000000' }] })).statusCode).toBe(422);
    expect((await inject('POST', '/inventory/invoices/approve', ctx.auth('manager'), { ...base, invoiceNumber: 'INV-3', items: [{ ...item, costPrice: 'abc' }] })).statusCode).toBe(400);
    expect((await inject('POST', '/inventory/invoices/approve', otherManager(), { ...base, invoiceNumber: 'INV-4', items: [item] })).statusCode).toBe(403);
  });
});

// ─── PRODUCTS ─────────────────────────────────────────────────────────────────

describe('products', () => {
  it('MRP change writes price_audit; unchanged MRP is a no-op; unknown product 404', async () => {
    const beer = ctx.products[1];
    const res = await inject('PATCH', `/products/${beer.id}/mrp`, ctx.auth('manager'), { mrp: '210' });
    expect(res.statusCode).toBe(200);
    const audit = await ctx.db.select().from(ctx.schema.priceAudit).where(eq(ctx.schema.priceAudit.productId, beer.id));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ oldMrp: '200.00', newMrp: '210.00', userId: ctx.users.manager.id });

    await inject('PATCH', `/products/${beer.id}/mrp`, ctx.auth('manager'), { mrp: '210.00' });
    expect(await ctx.db.select().from(ctx.schema.priceAudit).where(eq(ctx.schema.priceAudit.productId, beer.id))).toHaveLength(1);

    expect((await inject('PATCH', '/products/00000000-0000-4000-8000-000000000000/mrp', ctx.auth('manager'), { mrp: '1' })).statusCode).toBe(404);
  });

  it('duplicate barcode → 409, unknown category → 422', async () => {
    const base = { categoryId: ctx.products[0].categoryId, name: 'Dup', brand: 'D', mrp: '100.00' };
    // barcodes are unique within a business: the second product with the same code is refused
    expect((await inject('POST', '/products', ctx.auth('manager'), { ...base, barcode: '1000000000777' })).statusCode).toBe(201);
    expect((await inject('POST', '/products', ctx.auth('manager'), { ...base, barcode: '1000000000777' })).statusCode).toBe(409);
    expect((await inject('POST', '/products', ctx.auth('manager'), { ...base, categoryId: '00000000-0000-4000-8000-000000000000' })).statusCode).toBe(422);
  });
});

// ─── TABLES & KOT ─────────────────────────────────────────────────────────────

describe('tables and KOT', () => {
  let tableId: string;
  let sessionId: string;

  it('creates and opens a table; double-open → 409; bad body → 400', async () => {
    expect((await inject('POST', `/tables/${ctx.branchId}`, ctx.auth('manager'), { name: '' })).statusCode).toBe(400);
    const created = await inject('POST', `/tables/${ctx.branchId}`, ctx.auth('manager'), { name: 'T-1', capacity: 4 });
    expect(created.statusCode).toBe(201);
    tableId = created.json().table.id;

    expect((await inject('POST', `/tables/${tableId}/open`, ctx.auth('cashier'), {})).statusCode).toBe(400);
    const opened = await inject('POST', `/tables/${tableId}/open`, ctx.auth('cashier'), { branchId: ctx.branchId, stewardId: ctx.users.steward.id });
    expect(opened.statusCode).toBe(201);
    sessionId = opened.json().session.id;
    expect((await inject('POST', `/tables/${tableId}/open`, ctx.auth('cashier'), { branchId: ctx.branchId })).statusCode).toBe(409);
  });

  it('rejects a steward from another branch (422) and a table from another branch (403/404)', async () => {
    const created = await inject('POST', `/tables/${ctx.branchId}`, ctx.auth('manager'), { name: 'T-2' });
    const t2 = created.json().table.id;
    expect((await inject('POST', `/tables/${t2}/open`, ctx.auth('cashier'), { branchId: ctx.branchId, stewardId: ctx.otherBranchManager.id })).statusCode).toBe(422);
    expect((await inject('POST', `/tables/${t2}/open`, otherManager(), { branchId: ctx.otherBranchId })).statusCode).toBe(404);
  });

  it('KOT uses DB prices/tax, ignoring client-supplied prices', async () => {
    const res = await inject('POST', '/kot', ctx.auth('steward'), {
      tableSessionId: sessionId, branchId: ctx.branchId,
      items: [{ productId: ctx.products[0].id, quantity: 2, unitPrice: '1.00', taxRate: '0.00' }],
    });
    expect(res.statusCode).toBe(201);
    const item = res.json().kotOrder.items[0];
    expect(item.taxRate).toBe('18.00');
    expect(Number(item.unitPrice)).toBeGreaterThan(1);

    const bill = await inject('GET', `/kot/session/${sessionId}/bill?branchId=${ctx.branchId}`, ctx.auth('cashier'));
    expect(bill.statusCode).toBe(200);
    expect(Number(bill.json().grandTotal)).toBe(Number(item.unitPrice) * 2);
  });

  it('KOT item status: invalid transition 422, cross-branch 404', async () => {
    const kot = (await inject('POST', '/kot', ctx.auth('steward'), {
      tableSessionId: sessionId, branchId: ctx.branchId, items: [{ productId: ctx.products[1].id, quantity: 1 }],
    })).json().kotOrder;
    const url = `/kot/${kot.id}/items/${kot.items[0].id}`;
    expect((await inject('PATCH', url, ctx.auth('steward'), { status: 'SERVED', branchId: ctx.branchId })).statusCode).toBe(422);
    expect((await inject('PATCH', url, ctx.auth('steward'), { status: 'PREPARING', branchId: ctx.branchId })).statusCode).toBe(200);
    expect((await inject('PATCH', url, otherManager(), { status: 'SERVED', branchId: ctx.otherBranchId })).statusCode).toBe(404);
  });

  it('closes the table; KOT on a closed session → 404; closing again → 409', async () => {
    const closed = await inject('POST', `/tables/${tableId}/close`, ctx.auth('cashier'), { branchId: ctx.branchId });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().session.closedAt).toBeTruthy();
    expect((await inject('POST', '/kot', ctx.auth('steward'), {
      tableSessionId: sessionId, branchId: ctx.branchId, items: [{ productId: ctx.products[1].id, quantity: 1 }],
    })).statusCode).toBe(404);
    expect((await inject('POST', `/tables/${tableId}/close`, ctx.auth('cashier'), { branchId: ctx.branchId })).statusCode).toBe(409);
  });
});

// ─── SCHEMES ──────────────────────────────────────────────────────────────────

describe('schemes', () => {
  it('validates input, enforces scheme branch on purchase and increments atomically', async () => {
    const body = {
      supplierName: 'Acme', schemeName: 'Diwali', targetType: 'QTY', targetValue: '100',
      rewardDescription: '5 free cases', startDate: '2026-01-01', endDate: '2026-12-31',
    };
    expect((await inject('POST', `/schemes/${ctx.branchId}`, ctx.auth('manager'), { ...body, endDate: '2025-01-01' })).statusCode).toBe(400);
    const created = await inject('POST', `/schemes/${ctx.branchId}`, ctx.auth('manager'), body);
    expect(created.statusCode).toBe(201);
    const schemeId = created.json().scheme.id;

    expect((await inject('POST', `/schemes/${schemeId}/purchase`, otherManager(), { qty: '10' })).statusCode).toBe(403);
    expect((await inject('POST', `/schemes/${schemeId}/purchase`, ctx.auth('manager'), { qty: '0' })).statusCode).toBe(422);

    const results = await Promise.all(Array.from({ length: 4 }, () =>
      inject('POST', `/schemes/${schemeId}/purchase`, ctx.auth('manager'), { qty: '10' })));
    expect(results.every((r) => r.statusCode === 201)).toBe(true);
    const [row] = await ctx.db.select().from(ctx.schema.schemes).where(eq(ctx.schema.schemes.id, schemeId));
    expect(row.currentValue).toBe('40.00');
  });
});

// ─── CLOSING ──────────────────────────────────────────────────────────────────

describe('daily closing', () => {
  it('uses only this branch\'s bills for the day and keeps CREDIT out of the drawer', async () => {
    const { businessDateOf } = await import('../../src/lib/business-day.js');
    const [c] = await ctx.db.insert(ctx.schema.customers).values({
      branchId: ctx.otherBranchId, name: 'Khata', phone: '9111111111', creditAllowed: true, creditLimit: '5000.00',
    }).returning();
    const om = otherManager();
    const beer = ctx.products[1].id;
    const bill = (paymentMode: string, extra: Record<string, unknown> = {}) => inject('POST', '/bills', om, {
      branchId: ctx.otherBranchId, paymentMode, items: [{ productId: beer, quantity: 1 }], ...extra,
    });
    // beer MRP in this file was raised to 210 earlier
    expect((await bill('CASH')).statusCode).toBe(201);
    expect((await bill('UPI')).statusCode).toBe(201);
    expect((await bill('CREDIT', { customerId: c.id })).statusCode).toBe(201);

    const res = await inject('POST', '/closing', om, {
      branchId: ctx.otherBranchId, openingCash: '1000.00', actualCashCounted: '1210.00', businessDate: businessDateOf(),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      cashSales: '210.00', upiSales: '210.00', creditSales: '210.00', grossSales: '630.00',
      expectedCashInDrawer: '1210.00', isBalanced: true, paidBillsCount: 3,
    });

    const past = await inject('POST', '/closing', om, {
      branchId: ctx.otherBranchId, openingCash: '0', actualCashCounted: '0', businessDate: '2020-01-01',
    });
    expect(past.json()).toMatchObject({ grossSales: '0.00', totalBillsCount: 0 });
    expect((await inject('POST', '/closing', om, { branchId: ctx.branchId, openingCash: '0', actualCashCounted: '0' })).statusCode).toBe(403);
  });
});
