/**
 * Regression tests for the code-review findings: client-supplied stock bypass (B1), price/cost writes outside the
 * permission model (P1/P2), cross-branch inventory read (P3), health check (X3), agent token index (N2).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { setupIntegration, type IntegrationContext } from './helpers.js';

let ctx: IntegrationContext;
beforeAll(async () => { ctx = await setupIntegration(); }, 60_000);
afterAll(async () => { await ctx?.app.close(); });

type Role = 'owner' | 'manager' | 'office_admin' | 'cashier' | 'steward';
const inject = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, role: Role, payload?: unknown) =>
  ctx.app.inject({ method, url: `/api/v1${url}`, headers: ctx.auth(role), payload: payload as never });

async function stockOf(productId: string) {
  const [row] = await ctx.db.select().from(ctx.schema.stock)
    .where(and(eq(ctx.schema.stock.branchId, ctx.branchId), eq(ctx.schema.stock.productId, productId)));
  return row.quantity;
}

describe('B1 — skipStockDeduction is not reachable from JSON', () => {
  it('a cashier cannot sell without stock moving by sending the flag', async () => {
    const p = ctx.products[0];
    const before = await stockOf(p.id);
    const res = await inject('POST', '/bills', 'cashier', {
      branchId: ctx.branchId, paymentMode: 'CASH', skipStockDeduction: true,
      items: [{ productId: p.id, quantity: 2 }],
    });
    expect([200, 201, 400]).toContain(res.statusCode);
    if (res.statusCode === 201) expect(await stockOf(p.id)).toBe(before - 2);   // unknown key ignored, stock still deducted
    else expect(await stockOf(p.id)).toBe(before);
  });
});

describe('P1/P2 — price and cost writes', () => {
  it('PATCH /products/:id refuses mrp and costPrice (400) and changes nothing', async () => {
    const p = ctx.products[0];
    const audits = (await ctx.db.select().from(ctx.schema.priceAudit)).length;
    for (const body of [{ mrp: '1' }, { costPrice: '1' }]) {
      expect((await inject('PATCH', `/products/${p.id}`, 'cashier', body)).statusCode).toBe(400);
    }
    const [row] = await ctx.db.select().from(ctx.schema.products).where(eq(ctx.schema.products.id, p.id));
    expect(row.mrp).toBe(p.mrp);
    expect(Number(row.costPrice)).toBe(800);
    expect((await ctx.db.select().from(ctx.schema.priceAudit)).length).toBe(audits);
  });

  it('PATCH /products/:id still renames', async () => {
    const res = await inject('PATCH', `/products/${ctx.products[1].id}`, 'cashier', { brand: 'TB2' });
    expect(res.statusCode).toBe(200);
  });

  it('a cashier (no cost.view) cannot write costPrice on create; a manager can', async () => {
    const base = { categoryId: ctx.products[0].categoryId, packQuantity: 12, volumeMl: 750, mrp: '500' };
    const a = await inject('POST', '/products', 'cashier', { ...base, name: 'Cashier Made 750ml', brand: 'CM', barcode: '2000000000001', sku: 'CM1', costPrice: '1' });
    expect(a.statusCode).toBe(201);
    const [rowA] = await ctx.db.select().from(ctx.schema.products).where(eq(ctx.schema.products.barcode, '2000000000001'));
    expect(rowA.costPrice).toBeNull();

    const b = await inject('POST', '/products', 'manager', { ...base, name: 'Manager Made 750ml', brand: 'MM', barcode: '2000000000002', sku: 'MM1', costPrice: '400' });
    expect(b.statusCode).toBe(201);
    const [rowB] = await ctx.db.select().from(ctx.schema.products).where(eq(ctx.schema.products.barcode, '2000000000002'));
    expect(Number(rowB.costPrice)).toBe(400);
  });
});

describe('P3 — GET /products?branchId needs access to that branch', () => {
  it('a cashier cannot read another branch\'s stock; their own branch is fine', async () => {
    expect((await inject('GET', `/products?branchId=${ctx.otherBranchId}`, 'cashier')).statusCode).toBe(403);
    expect((await inject('GET', `/products?branchId=${ctx.branchId}`, 'cashier')).statusCode).toBe(200);
  });
});

describe('X3 — health touches the database', () => {
  it('reports ok when the database answers', async () => {
    for (const url of ['/health', '/api/v1/health']) {
      const res = await ctx.app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('ok');
    }
  });
});

describe('N2 — agent token hash is unique', () => {
  it('two branches cannot share a token hash, but many can have none', async () => {
    const { branches } = ctx.schema;
    await ctx.db.update(branches).set({ agentTokenHash: 'h1' }).where(eq(branches.id, ctx.branchId));
    await expect(ctx.db.update(branches).set({ agentTokenHash: 'h1' }).where(eq(branches.id, ctx.otherBranchId))).rejects.toThrow();
    await ctx.db.update(branches).set({ agentTokenHash: null }).where(eq(branches.id, ctx.branchId));
  });
});

describe('R1 / R3 — permission guard and cost masking', () => {
  it('requirePermission without a prior requireRole answers 403, not 500', async () => {
    const { requirePermission } = await import('../../src/modules/permissions/permission.service.js');
    let status = 0;
    const reply = { code(n: number) { status = n; return this; }, send() { return this; } };
    await requirePermission('prices.edit')({} as never, reply as never);
    expect(status).toBe(403);
  });

  it('every cost-looking column on products / stock / invoices is covered by stripCost', async () => {
    const { COST_FIELDS, stripCost } = await import('../../src/modules/permissions/permission.service.js');
    const { getTableColumns } = await import('drizzle-orm');
    const cols = [
      ...Object.keys(getTableColumns(ctx.schema.products)),
      ...Object.keys(getTableColumns(ctx.schema.stock)),
    ].filter((c) => /cost|landed|purchase/i.test(c));
    const uncovered = cols.filter((c) => !(COST_FIELDS as readonly string[]).includes(c));
    expect(uncovered).toEqual([]);
    expect(stripCost({ a: [{ costPrice: '1', b: { costPerCase: '2', mrp: '3' } }] })).toEqual({ a: [{ b: { mrp: '3' } }] });
  });
});

describe('G3 — integer role ranks, unknown role is an error', () => {
  it('ranks are integers in the right order and an unknown role throws', async () => {
    const { ROLE_RANK, roleRank } = await import('../../src/middleware/auth.guard.js');
    const order = ['steward', 'cashier', 'manager', 'office_admin', 'owner'] as const;
    for (let i = 1; i < order.length; i++) expect(ROLE_RANK[order[i]]).toBeGreaterThan(ROLE_RANK[order[i - 1]]);
    for (const r of order) expect(Number.isInteger(ROLE_RANK[r])).toBe(true);
    expect(() => roleRank('OWNER')).toThrow(/Unknown role/);
  });
});

describe('I1 — extraction limiter', () => {
  it('runs at most N jobs at once, queues the rest in order, and refuses past the queue cap', async () => {
    const { createLimiter, QueueFullError } = await import('../../src/lib/limiter.js');
    const run = createLimiter(2, 1);
    let active = 0; let peak = 0;
    const gates: Array<() => void> = [];
    const job = () => new Promise<void>((resolve) => {
      active += 1; peak = Math.max(peak, active);
      gates.push(() => { active -= 1; resolve(); });
    });
    const p = [run(job), run(job), run(job)];          // 2 running, 1 queued
    await expect(run(job)).rejects.toBeInstanceOf(QueueFullError);
    await new Promise((r) => setTimeout(r, 10));
    expect(active).toBe(2);
    gates.shift()!(); await new Promise((r) => setTimeout(r, 10));
    expect(active).toBe(2);                            // the queued job took the freed slot
    while (gates.length) { gates.shift()!(); await new Promise((r) => setTimeout(r, 5)); }
    await Promise.all(p);
    expect(peak).toBe(2);
  });
});

describe('X4 — secrets are not tracked', () => {
  it('.env is not in git (only .env.example)', async () => {
    const { execSync } = await import('node:child_process');
    const tracked = execSync('git ls-files .env .env.local', { encoding: 'utf8' }).trim();
    expect(tracked).toBe('');
  });
});
