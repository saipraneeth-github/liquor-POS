import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { and, eq } from 'drizzle-orm';
import { setupIntegration, type IntegrationContext } from './helpers.js';
import { complianceRoutes } from '../../src/modules/compliance/compliance.routes.js';
import { businessDateOf } from '../../src/lib/business-day.js';

let ctx: IntegrationContext;
let app: FastifyInstance;   // local app with the compliance plugin (works before and after wiring into buildApp)
let whiskyId: string;
let beerId: string;

beforeAll(async () => {
  ctx = await setupIntegration();
  whiskyId = ctx.products[0].id;
  beerId = ctx.products[1].id;
  app = Fastify();
  app.register(fastifyJwt, { secret: process.env.JWT_SECRET! });
  app.register(complianceRoutes, { prefix: '/api/v1' });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await ctx?.app.close();
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────

const otherManager = () => ctx.authFor({
  sub: ctx.otherBranchManager.id, email: ctx.otherBranchManager.email, role: 'manager', branchId: ctx.otherBranchId,
});

function shiftDate(days: number): string {
  const d = new Date(`${businessDateOf()}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function stockOf(productId: string, branchId = ctx.branchId): Promise<number> {
  const [row] = await ctx.db.select().from(ctx.schema.stock)
    .where(and(eq(ctx.schema.stock.branchId, branchId), eq(ctx.schema.stock.productId, productId)));
  return row?.quantity ?? 0;
}

async function insertInvoice(status: 'APPROVED' | 'DRAFT', invoiceDate: Date, items: { productId: string | null; quantity: number }[]) {
  const [inv] = await ctx.db.insert(ctx.schema.supplierInvoices).values({
    branchId: ctx.branchId, createdById: ctx.users.manager.id, supplierName: 'Depot', invoiceNumber: `INV-${Math.random()}`,
    invoiceDate, totalAmount: '0', status, approvedAt: status === 'APPROVED' ? invoiceDate : null,
  }).returning();
  await ctx.db.insert(ctx.schema.supplierInvoiceItems).values(items.map((i) => ({
    invoiceId: inv.id, productId: i.productId, rawDescription: 'line', quantity: i.quantity,
    costPrice: '1.00', mrp: '1.00', lineCostTotal: '1.00',
  })));
}

// ─── BREAKAGE ─────────────────────────────────────────────────────────────────

describe('breakage', () => {
  it('decrements stock, logs cost value and writes a BREAKAGE stock_audit row', async () => {
    const before = await stockOf(whiskyId);
    const res = await app.inject({
      method: 'POST', url: `/api/v1/compliance/breakage/${ctx.branchId}`, headers: ctx.auth('cashier'),
      payload: { productId: whiskyId, quantity: 3, reason: 'Dropped crate' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.stockQuantity).toBe(before - 3);
    expect(body.breakage).toMatchObject({ quantity: 3, costValue: '2400.00' });   // 800 × 3
    expect(await stockOf(whiskyId)).toBe(before - 3);

    const audits = await ctx.db.select().from(ctx.schema.stockAudit)
      .where(eq(ctx.schema.stockAudit.referenceId, body.breakage.id));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ reason: 'BREAKAGE', changeQty: -3, productId: whiskyId });
  });

  it('insufficient stock → 422 with nothing written', async () => {
    const before = await stockOf(beerId);
    const res = await app.inject({
      method: 'POST', url: `/api/v1/compliance/breakage/${ctx.branchId}`, headers: ctx.auth('cashier'),
      payload: { productId: beerId, quantity: before + 1, reason: 'Too many' },
    });
    expect(res.statusCode).toBe(422);
    expect(await stockOf(beerId)).toBe(before);
    const logs = await ctx.db.select().from(ctx.schema.breakageLogs).where(eq(ctx.schema.breakageLogs.productId, beerId));
    expect(logs).toHaveLength(0);
  });

  it('lists breakage with totals (manager+) and denies cashier / cross-branch', async () => {
    await app.inject({
      method: 'POST', url: `/api/v1/compliance/breakage/${ctx.branchId}`, headers: ctx.auth('manager'),
      payload: { productId: beerId, quantity: 2, reason: 'Leaking bottles' },
    });
    const res = await app.inject({ method: 'GET', url: `/api/v1/compliance/breakage/${ctx.branchId}?from=${shiftDate(-1)}&to=${shiftDate(1)}`, headers: ctx.auth('manager') });
    expect(res.statusCode).toBe(200);
    expect(res.json().totals).toEqual({ count: 2, quantity: 5, costValue: '2700.00' });   // 2400 + 150 × 2

    const cashier = await app.inject({ method: 'GET', url: `/api/v1/compliance/breakage/${ctx.branchId}`, headers: ctx.auth('cashier') });
    expect(cashier.statusCode).toBe(403);
    const cross = await app.inject({
      method: 'POST', url: `/api/v1/compliance/breakage/${ctx.branchId}`, headers: otherManager(),
      payload: { productId: beerId, quantity: 1, reason: 'Sneaky' },
    });
    expect(cross.statusCode).toBe(403);
  });

  it('stock-audit report joins product names and summarises net change', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/compliance/stock-audit/${ctx.branchId}?productId=${whiskyId}`, headers: ctx.auth('manager') });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entries.every((e: any) => e.productName === 'Test Whisky 750ml')).toBe(true);
    expect(body.summary).toEqual([
      expect.objectContaining({ productId: whiskyId, inQty: 0, outQty: 3, netChange: -3, entries: 1 }),
    ]);
    const cross = await app.inject({ method: 'GET', url: `/api/v1/compliance/stock-audit/${ctx.branchId}`, headers: otherManager() });
    expect(cross.statusCode).toBe(403);
  });
});

// ─── QUOTAS & LIFTING ─────────────────────────────────────────────────────────

describe('excise quotas & lifting report', () => {
  beforeAll(async () => {
    const now = new Date();
    // Approved, in period: whisky 120 btl (10 cases), beer 240 btl (20 cases), unmatched 6 btl (0.5 case @ default 12)
    await insertInvoice('APPROVED', now, [
      { productId: whiskyId, quantity: 120 },
      { productId: beerId, quantity: 240 },
      { productId: null, quantity: 6 },
    ]);
    // Ignored: draft invoice, and an approved invoice before the quota period
    await insertInvoice('DRAFT', now, [{ productId: whiskyId, quantity: 1200 }]);
    await insertInvoice('APPROVED', new Date(Date.now() - 30 * 86_400_000), [{ productId: whiskyId, quantity: 1200 }]);
  });

  it('validates the period and enforces roles', async () => {
    const bad = await app.inject({
      method: 'POST', url: `/api/v1/compliance/quotas/${ctx.branchId}`, headers: ctx.auth('manager'),
      payload: { periodStart: shiftDate(0), periodEnd: shiftDate(-1), quotaCases: 10 },
    });
    expect(bad.statusCode).toBe(400);
    const cashier = await app.inject({
      method: 'POST', url: `/api/v1/compliance/quotas/${ctx.branchId}`, headers: ctx.auth('cashier'),
      payload: { periodStart: shiftDate(0), periodEnd: shiftDate(1), quotaCases: 10 },
    });
    expect(cashier.statusCode).toBe(403);
  });

  it('computes lifted cases, utilisation and flags per quota', async () => {
    const whiskyQuota = await app.inject({
      method: 'POST', url: `/api/v1/compliance/quotas/${ctx.branchId}`, headers: ctx.auth('manager'),
      payload: { categoryId: ctx.products[0].categoryId, periodStart: shiftDate(-5), periodEnd: shiftDate(3), quotaCases: 50 },
    });
    expect(whiskyQuota.statusCode).toBe(201);
    const allQuota = await app.inject({
      method: 'POST', url: `/api/v1/compliance/quotas/${ctx.branchId}`, headers: ctx.auth('manager'),
      payload: { periodStart: shiftDate(-5), periodEnd: shiftDate(20), quotaCases: 25, notes: 'All liquor' },
    });
    expect(allQuota.statusCode).toBe(201);
    // Non-overlapping quota (future) is excluded from today's report
    await app.inject({
      method: 'POST', url: `/api/v1/compliance/quotas/${ctx.branchId}`, headers: ctx.auth('manager'),
      payload: { periodStart: shiftDate(40), periodEnd: shiftDate(60), quotaCases: 5 },
    });

    const list = await app.inject({ method: 'GET', url: `/api/v1/compliance/quotas/${ctx.branchId}`, headers: ctx.auth('manager') });
    expect(list.json().quotas).toHaveLength(3);

    const res = await app.inject({ method: 'GET', url: `/api/v1/compliance/lifting/${ctx.branchId}`, headers: ctx.auth('manager') });
    expect(res.statusCode).toBe(200);
    const quotas = res.json().quotas;
    expect(quotas).toHaveLength(2);

    const whisky = quotas.find((q: any) => q.quotaId === whiskyQuota.json().quota.id);
    expect(whisky).toMatchObject({
      categoryName: 'Whisky', liftedCases: '10.00', utilisationPct: '20.00', remainingCases: '40.00', daysLeft: 4, flags: ['EXPIRING'],
    });
    const all = quotas.find((q: any) => q.quotaId === allQuota.json().quota.id);
    expect(all).toMatchObject({
      categoryName: 'ALL', liftedCases: '30.50', utilisationPct: '122.00', remainingCases: '0.00', flags: ['EXCEEDED'],
    });

    const cross = await app.inject({ method: 'GET', url: `/api/v1/compliance/lifting/${ctx.branchId}`, headers: otherManager() });
    expect(cross.statusCode).toBe(403);
  });
});
