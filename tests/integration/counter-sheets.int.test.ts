import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { and, eq } from 'drizzle-orm';
import { setupIntegration, type IntegrationContext } from './helpers.js';
import { counterSheetRoutes } from '../../src/modules/counters/counter.routes.js';
import { businessDateOf, businessDayBounds } from '../../src/lib/business-day.js';

let ctx: IntegrationContext;
let app: FastifyInstance;   // local instance with the counter-sheet routes (independent of buildApp wiring)
let whiskyId: string;
let beerId: string;
const today = businessDateOf();
const yesterday = businessDateOf(new Date(Date.now() - 86_400_000));
const tomorrow = businessDateOf(new Date(Date.now() + 86_400_000));

beforeAll(async () => {
  ctx = await setupIntegration();
  whiskyId = ctx.products[0].id;
  beerId = ctx.products[1].id;
  app = Fastify();
  app.register(fastifyJwt, { secret: process.env.JWT_SECRET! });
  app.register(counterSheetRoutes, { prefix: '/api/v1' });
  await app.ready();

  // A supplier invoice approved yesterday: 12 whisky bottles inward (already in the seeded stock of 100,
  // with the PURCHASE audit row approval writes)
  const approvedAt = new Date(businessDayBounds(yesterday).start.getTime() + 3_600_000);
  const [inv] = await ctx.db.insert(ctx.schema.supplierInvoices).values({
    branchId: ctx.branchId, createdById: ctx.users.manager.id, approvedById: ctx.users.manager.id,
    supplierName: 'Acme', invoiceNumber: 'INV-1', totalAmount: '9600.00', status: 'APPROVED', approvedAt,
  }).returning();
  await ctx.db.insert(ctx.schema.supplierInvoiceItems).values({
    invoiceId: inv.id, productId: whiskyId, rawDescription: 'TW 750', quantity: 12,
    costPrice: '800.00', mrp: '1000.00', lineCostTotal: '9600.00',
  });
  await ctx.db.insert(ctx.schema.stockAudit).values({
    branchId: ctx.branchId, productId: whiskyId, userId: ctx.users.manager.id, changeQty: 12,
    reason: 'PURCHASE', referenceId: inv.id, createdAt: approvedAt,
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await ctx?.app.close();
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────

const otherManager = () => ctx.authFor({
  sub: ctx.otherBranchManager.id, email: ctx.otherBranchManager.email, role: 'manager', branchId: ctx.otherBranchId,
});

async function stockOf(productId: string): Promise<number> {
  const [row] = await ctx.db.select().from(ctx.schema.stock)
    .where(and(eq(ctx.schema.stock.branchId, ctx.branchId), eq(ctx.schema.stock.productId, productId)));
  return row.quantity;
}

function putLines(id: string, lines: Record<string, unknown>[], headers = ctx.auth('cashier')) {
  return app.inject({ method: 'PUT', url: `/api/v1/counter-sheets/sheet/${id}/lines`, headers, payload: { lines } });
}

const lineOf = (sheet: any, productId: string) => sheet.lines.find((l: any) => l.productId === productId);

// ─── LIFECYCLE ────────────────────────────────────────────────────────────────

describe('counter sheet lifecycle', () => {
  let sheetId: string;

  it('creates a DRAFT with opening / inward / closing / rate per stocked product; duplicate is 409', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/counter-sheets/${ctx.branchId}`, headers: ctx.auth('cashier'), payload: { sheetDate: yesterday },
    });
    expect(res.statusCode).toBe(201);
    const sheet = res.json();
    sheetId = sheet.id;
    expect(sheet.status).toBe('DRAFT');
    expect(sheet.lines).toHaveLength(2);
    // no prior posted sheet: opening = stock (100) rewound past the day's inward (12) already in stock
    expect(lineOf(sheet, whiskyId)).toMatchObject({
      openingBottles: 88, inwardBottles: 12, closingBottles: 100, sellingRate: '1000.00', productName: 'Test Whisky 750ml',
    });
    expect(lineOf(sheet, beerId)).toMatchObject({ openingBottles: 100, inwardBottles: 0, closingBottles: 100, sellingRate: '200.00' });

    const dup = await app.inject({
      method: 'POST', url: `/api/v1/counter-sheets/${ctx.branchId}`, headers: ctx.auth('cashier'), payload: { sheetDate: yesterday },
    });
    expect(dup.statusCode).toBe(409);

    // a future day cannot be counted yet
    const future = await app.inject({
      method: 'POST', url: `/api/v1/counter-sheets/${ctx.branchId}`, headers: ctx.auth('cashier'), payload: { sheetDate: tomorrow },
    });
    expect(future.statusCode).toBe(422);

    const bad = await app.inject({
      method: 'POST', url: `/api/v1/counter-sheets/${ctx.branchId}`, headers: ctx.auth('cashier'), payload: { sheetDate: '2026-13-01' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('denies other-branch users (403) on create, list, read, update and post', async () => {
    const h = otherManager();
    expect((await app.inject({ method: 'POST', url: `/api/v1/counter-sheets/${ctx.branchId}`, headers: h, payload: { sheetDate: today } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/v1/counter-sheets/${ctx.branchId}`, headers: h })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/v1/counter-sheets/sheet/${sheetId}`, headers: h })).statusCode).toBe(403);
    expect((await putLines(sheetId, [{ productId: beerId, closingBottles: 90 }], h)).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/v1/counter-sheets/sheet/${sheetId}/post`, headers: h })).statusCode).toBe(403);
  });

  it('recomputes sold, revenue and sheet total on update', async () => {
    const res = await putLines(sheetId, [
      { productId: whiskyId, closingBottles: 90 },   // 88 + 12 - 90 = 10 sold → 10000
      { productId: beerId, closingBottles: 95 },     // 100 - 95 = 5 sold → 1000
    ]);
    expect(res.statusCode).toBe(200);
    const sheet = res.json();
    expect(lineOf(sheet, whiskyId)).toMatchObject({ soldBottles: 10, lineRevenue: '10000.00' });
    expect(lineOf(sheet, beerId)).toMatchObject({ soldBottles: 5, lineRevenue: '1000.00' });
    expect(lineOf(sheet, beerId).closingSplit).toEqual({ cases: 7, loose: 11 });
    expect(sheet.totalRevenue).toBe('11000.00');
  });

  it('only a manager may override the invoice-derived inward count (cashier 422)', async () => {
    // lowering inward would understate sold bottles and revenue
    // (88 + 0 − 80 = 8 sold instead of 88 + 12 − 80 = 20)
    const cashier = await putLines(sheetId, [{ productId: whiskyId, closingBottles: 80, inwardBottles: 0 }]);
    expect(cashier.statusCode).toBe(422);
    const unchanged = await app.inject({ method: 'GET', url: `/api/v1/counter-sheets/sheet/${sheetId}`, headers: ctx.auth('cashier') });
    expect(lineOf(unchanged.json(), whiskyId)).toMatchObject({ inwardBottles: 12, soldBottles: 10 });

    // echoing the current inward value is fine for a cashier
    const same = await putLines(sheetId, [{ productId: whiskyId, closingBottles: 90, inwardBottles: 12 }]);
    expect(same.statusCode).toBe(200);

    const manager = await putLines(sheetId, [{ productId: whiskyId, closingBottles: 90, inwardBottles: 14 }], ctx.auth('manager'));
    expect(manager.statusCode).toBe(200);
    expect(lineOf(manager.json(), whiskyId)).toMatchObject({ inwardBottles: 14, soldBottles: 12 });
    const restore = await putLines(sheetId, [{ productId: whiskyId, closingBottles: 90, inwardBottles: 12 }], ctx.auth('manager'));
    expect(lineOf(restore.json(), whiskyId)).toMatchObject({ inwardBottles: 12, soldBottles: 10 });
    expect(restore.json().totalRevenue).toBe('11000.00');
  });

  it('rejects closing > opening + inward for cashiers (422) but allows a manager override', async () => {
    const cashier = await putLines(sheetId, [{ productId: beerId, closingBottles: 105 }]);
    expect(cashier.statusCode).toBe(422);
    const cashierApprove = await putLines(sheetId, [{ productId: beerId, closingBottles: 105, approveAdjustment: true }]);
    expect(cashierApprove.statusCode).toBe(422);
    const managerNoFlag = await putLines(sheetId, [{ productId: beerId, closingBottles: 105 }], ctx.auth('manager'));
    expect(managerNoFlag.statusCode).toBe(422);

    const manager = await putLines(sheetId, [{ productId: beerId, closingBottles: 105, approveAdjustment: true }], ctx.auth('manager'));
    expect(manager.statusCode).toBe(200);
    expect(lineOf(manager.json(), beerId)).toMatchObject({
      closingBottles: 105, soldBottles: 0, lineRevenue: '0.00', adjustmentApprovedById: ctx.users.manager.id,
    });
    expect(manager.json().totalRevenue).toBe('10000.00');

    // back to a normal count clears the approval
    const reset = await putLines(sheetId, [{ productId: beerId, closingBottles: 95 }]);
    expect(lineOf(reset.json(), beerId)).toMatchObject({ soldBottles: 5, adjustmentApprovedById: null });
    expect(reset.json().totalRevenue).toBe('11000.00');
  });

  it('rejects products not on the sheet (422) and duplicate lines (400)', async () => {
    const unknown = await putLines(sheetId, [{ productId: '00000000-0000-4000-8000-000000000000', closingBottles: 1 }]);
    expect(unknown.statusCode).toBe(422);
    const dup = await putLines(sheetId, [{ productId: beerId, closingBottles: 1 }, { productId: beerId, closingBottles: 2 }]);
    expect(dup.statusCode).toBe(400);
  });

  it('posting is manager+, sets stock to closing with COUNTER_SHEET audits, and only once', async () => {
    const cashier = await app.inject({ method: 'POST', url: `/api/v1/counter-sheets/sheet/${sheetId}/post`, headers: ctx.auth('cashier') });
    expect(cashier.statusCode).toBe(403);

    const res = await app.inject({ method: 'POST', url: `/api/v1/counter-sheets/sheet/${sheetId}/post`, headers: ctx.auth('manager') });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'POSTED', postedById: ctx.users.manager.id });
    expect(await stockOf(whiskyId)).toBe(90);
    expect(await stockOf(beerId)).toBe(95);

    const audits = await ctx.db.select().from(ctx.schema.stockAudit)
      .where(and(eq(ctx.schema.stockAudit.referenceId, sheetId), eq(ctx.schema.stockAudit.reason, 'COUNTER_SHEET')));
    expect(audits).toHaveLength(2);
    expect(audits.find((a) => a.productId === whiskyId)?.changeQty).toBe(-10);
    expect(audits.find((a) => a.productId === beerId)?.changeQty).toBe(-5);

    const again = await app.inject({ method: 'POST', url: `/api/v1/counter-sheets/sheet/${sheetId}/post`, headers: ctx.auth('manager') });
    expect(again.statusCode).toBe(409);
    expect(await stockOf(whiskyId)).toBe(90);

    const edit = await putLines(sheetId, [{ productId: beerId, closingBottles: 90 }]);
    expect(edit.statusCode).toBe(409);
  });

  it('the next sheet opens from the last posted closing; list and read work', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/counter-sheets/${ctx.branchId}`, headers: ctx.auth('cashier'), payload: { sheetDate: today },
    });
    expect(res.statusCode).toBe(201);
    expect(lineOf(res.json(), whiskyId)).toMatchObject({ openingBottles: 90, inwardBottles: 0, closingBottles: 90 });
    expect(lineOf(res.json(), beerId)).toMatchObject({ openingBottles: 95 });

    const list = await app.inject({ method: 'GET', url: `/api/v1/counter-sheets/${ctx.branchId}?date=${yesterday}`, headers: ctx.auth('cashier') });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0]).toMatchObject({ id: sheetId, status: 'POSTED', totalRevenue: '11000.00' });

    const read = await app.inject({ method: 'GET', url: `/api/v1/counter-sheets/sheet/${sheetId}`, headers: ctx.auth('cashier') });
    expect(read.statusCode).toBe(200);
    expect(read.json().lines).toHaveLength(2);

    const missing = await app.inject({ method: 'GET', url: '/api/v1/counter-sheets/sheet/00000000-0000-4000-8000-000000000000', headers: ctx.auth('cashier') });
    expect(missing.statusCode).toBe(404);
  });
});

// ─── GAP DAYS ─────────────────────────────────────────────────────────────────

describe('opening after days without a sheet', () => {
  it('adds inward approved between the last posted sheet and the new sheet date to the opening', async () => {
    const h = otherManager();
    const dayMs = 86_400_000;
    const d10 = businessDateOf(new Date(Date.now() - 10 * dayMs));
    const d9 = businessDateOf(new Date(Date.now() - 9 * dayMs));
    const d8 = businessDateOf(new Date(Date.now() - 8 * dayMs));

    const first = await app.inject({ method: 'POST', url: `/api/v1/counter-sheets/${ctx.otherBranchId}`, headers: h, payload: { sheetDate: d10 } });
    expect(first.statusCode).toBe(201);
    expect(lineOf(first.json(), beerId)).toMatchObject({ openingBottles: 100 });
    const put = await putLines(first.json().id, [{ productId: beerId, closingBottles: 90 }], h);
    expect(put.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/v1/counter-sheets/sheet/${first.json().id}/post`, headers: h })).statusCode).toBe(200);

    // 24 beers approved on d9, a day with no counter sheet
    const approvedAt = new Date(businessDayBounds(d9).start.getTime() + 3_600_000);
    const [inv] = await ctx.db.insert(ctx.schema.supplierInvoices).values({
      branchId: ctx.otherBranchId, createdById: ctx.otherBranchManager.id, approvedById: ctx.otherBranchManager.id,
      supplierName: 'Acme', invoiceNumber: 'INV-GAP', totalAmount: '3600.00', status: 'APPROVED', approvedAt,
    }).returning();
    await ctx.db.insert(ctx.schema.supplierInvoiceItems).values({
      invoiceId: inv.id, productId: beerId, rawDescription: 'Beer 650', quantity: 24,
      costPrice: '150.00', mrp: '200.00', lineCostTotal: '3600.00',
    });
    // what approval does to stock: +24 with a PURCHASE audit row
    await ctx.db.update(ctx.schema.stock).set({ quantity: 114 })
      .where(and(eq(ctx.schema.stock.branchId, ctx.otherBranchId), eq(ctx.schema.stock.productId, beerId)));
    await ctx.db.insert(ctx.schema.stockAudit).values({
      branchId: ctx.otherBranchId, productId: beerId, userId: ctx.otherBranchManager.id, changeQty: 24,
      reason: 'PURCHASE', referenceId: inv.id, createdAt: approvedAt,
    });

    const next = await app.inject({ method: 'POST', url: `/api/v1/counter-sheets/${ctx.otherBranchId}`, headers: h, payload: { sheetDate: d8 } });
    expect(next.statusCode).toBe(201);
    // 90 counted on d10 + 24 received on d9 = 114 available at the start of d8
    expect(lineOf(next.json(), beerId)).toMatchObject({ openingBottles: 114, inwardBottles: 0, closingBottles: 114 });
  });
});

// ─── MOVEMENTS OUTSIDE THE SHEET DAY ─────────────────────────────────────────

describe('stock movements recorded outside the sheet day', () => {
  it('opening is start-of-day stock, and posting keeps movements made after the sheet day', async () => {
    const [third] = await ctx.db.insert(ctx.schema.branches).values({ name: 'Third', code: 'THR' }).returning();
    const [mgr] = await ctx.db.insert(ctx.schema.users).values({
      name: 'Third manager', email: 'manager@third.local', passwordHash: 'x', role: 'manager', branchId: third.id,
    }).returning();
    const h = ctx.authFor({ sub: mgr.id, email: mgr.email, role: 'manager', branchId: third.id });
    const stockAt = async () => (await ctx.db.select().from(ctx.schema.stock)
      .where(and(eq(ctx.schema.stock.branchId, third.id), eq(ctx.schema.stock.productId, beerId))))[0].quantity;

    // 50 beers; 5 sold at the POS today (stock 45, SALE audit now)
    await ctx.db.insert(ctx.schema.stock).values({ branchId: third.id, productId: beerId, quantity: 45 });
    await ctx.db.insert(ctx.schema.stockAudit).values({
      branchId: third.id, productId: beerId, userId: mgr.id, changeQty: -5, reason: 'SALE',
    });

    // yesterday's sheet opens from the stock as it was then (50), not today's 45
    const y = await app.inject({ method: 'POST', url: `/api/v1/counter-sheets/${third.id}`, headers: h, payload: { sheetDate: yesterday } });
    expect(y.statusCode).toBe(201);
    expect(lineOf(y.json(), beerId)).toMatchObject({ openingBottles: 50, closingBottles: 50 });
    const put = await putLines(y.json().id, [{ productId: beerId, closingBottles: 48 }], h);
    expect(lineOf(put.json(), beerId)).toMatchObject({ soldBottles: 2, lineRevenue: '400.00' });

    // posting corrects yesterday's variance (−2) and keeps today's POS sale (−5): 50 − 2 − 5 = 43
    const post = await app.inject({ method: 'POST', url: `/api/v1/counter-sheets/sheet/${y.json().id}/post`, headers: h });
    expect(post.statusCode).toBe(200);
    expect(await stockAt()).toBe(43);
    const [audit] = await ctx.db.select().from(ctx.schema.stockAudit)
      .where(and(eq(ctx.schema.stockAudit.referenceId, y.json().id), eq(ctx.schema.stockAudit.reason, 'COUNTER_SHEET')));
    expect(audit.changeQty).toBe(-2);

    // today's sheet opens from yesterday's posted closing; today's sale shows up as sold
    const t = await app.inject({ method: 'POST', url: `/api/v1/counter-sheets/${third.id}`, headers: h, payload: { sheetDate: today } });
    expect(t.statusCode).toBe(201);
    expect(lineOf(t.json(), beerId)).toMatchObject({ openingBottles: 48 });
    const put2 = await putLines(t.json().id, [{ productId: beerId, closingBottles: 43 }], h);
    expect(lineOf(put2.json(), beerId)).toMatchObject({ soldBottles: 5 });
  });
});
