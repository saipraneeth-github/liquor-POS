/**
 * Regression tests for defects found in the Stage A core review:
 *   - tokens of deactivated / demoted / deleted users kept working until expiry
 *   - non-uuid :branchId on inventory routes leaked a 500
 *   - overlapping consolidated invoices double-billed a syndicate
 *   - branch parent assignment allowed longer cycles (A→B→A)
 *   - moving a branch to another syndicate kept a cross-syndicate parent link
 *   - bill GST was computed on the pre-discount amount
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { setupIntegration, type IntegrationContext } from './helpers.js';
import { branchRoutes } from '../../src/modules/branches/branch.routes.js';

let ctx: IntegrationContext;
let branchApp: FastifyInstance;
let platformAuth: { authorization: string };
let passwordHash: string;

beforeAll(async () => {
  ctx = await setupIntegration();
  passwordHash = await bcrypt.hash('Password@123', 4);
  const [platform] = await ctx.db.insert(ctx.schema.users).values({
    name: 'Platform', email: 'platform@review.local', passwordHash, role: 'owner',
  }).returning();
  platformAuth = ctx.authFor({ sub: platform.id, email: platform.email, role: 'owner', branchId: null, syndicateId: null });

  branchApp = Fastify();
  branchApp.register(fastifyJwt, { secret: process.env.JWT_SECRET! });
  branchApp.register(branchRoutes, { prefix: '/api/v1' });
  await branchApp.ready();
}, 60_000);

afterAll(async () => {
  await branchApp?.close();
  await ctx?.app.close();
});

const inject = (method: 'GET' | 'POST' | 'PATCH', url: string, headers?: Record<string, string>, payload?: unknown) =>
  ctx.app.inject({ method, url, headers, payload: payload as any });

async function makeUser(role: 'manager' | 'cashier', email: string) {
  const [u] = await ctx.db.insert(ctx.schema.users).values({
    name: email, email, passwordHash, role, branchId: ctx.branchId,
  }).returning();
  return { user: u, headers: ctx.authFor({ sub: u.id, email, role, branchId: ctx.branchId }) };
}

// ─── STALE TOKENS ─────────────────────────────────────────────────────────────

describe('tokens reflect the current account state', () => {
  it('rejects a deactivated user with 401', async () => {
    const { user, headers } = await makeUser('cashier', 'deact@review.local');
    expect((await inject('GET', '/api/v1/products', headers)).statusCode).toBe(200);
    await ctx.db.update(ctx.schema.users).set({ isActive: false }).where(eq(ctx.schema.users.id, user.id));
    expect((await inject('GET', '/api/v1/products', headers)).statusCode).toBe(401);
  });

  it('applies a demotion immediately (manager token → 403 on manager route)', async () => {
    const { user, headers } = await makeUser('manager', 'demote@review.local');
    expect((await inject('GET', `/api/v1/closing?branchId=${ctx.branchId}`, headers)).statusCode).toBe(200);
    await ctx.db.update(ctx.schema.users).set({ role: 'cashier' }).where(eq(ctx.schema.users.id, user.id));
    expect((await inject('GET', `/api/v1/closing?branchId=${ctx.branchId}`, headers)).statusCode).toBe(403);
  });

  it('rejects a token whose user no longer exists', async () => {
    const ghost = ctx.authFor({ sub: '00000000-0000-4000-8000-000000000000', email: 'g@x', role: 'manager', branchId: ctx.branchId });
    expect((await inject('GET', '/api/v1/products', ghost)).statusCode).toBe(401);
  });
});

// ─── INPUT VALIDATION ─────────────────────────────────────────────────────────

describe('inventory :branchId validation', () => {
  it('returns 400 (not 500) for a non-uuid branchId, for platform and syndicate owners', async () => {
    for (const h of [platformAuth, ctx.auth('owner')]) {
      expect((await inject('GET', '/api/v1/inventory/stock/not-a-uuid', h)).statusCode).toBe(400);
      expect((await inject('GET', '/api/v1/inventory/indent/not-a-uuid', h)).statusCode).toBe(400);
    }
  });

  it('rejects non-decimal money in the raw invoice parser with 400', async () => {
    const res = await inject('POST', '/api/v1/inventory/invoices/parse', ctx.auth('manager'), {
      supplierName: 'S', invoiceNumber: 'I1', invoiceDate: '2026-01-01', claimedTotal: 'abc',
      items: [{ rawDescription: 'x', quantity: 1, costPrice: '1.00', mrp: '2.00' }],
    });
    expect(res.statusCode).toBe(400);
  });
});

// ─── CONSOLIDATED INVOICES ────────────────────────────────────────────────────

describe('consolidated invoices', () => {
  it('rejects a period overlapping an existing invoice with 409', async () => {
    const url = `/api/v1/syndicates/${ctx.syndicateId}/consolidated-invoices`;
    expect((await inject('POST', url, ctx.auth('owner'), { periodStart: '2025-03-01', periodEnd: '2025-03-31' })).statusCode).toBe(201);
    expect((await inject('POST', url, ctx.auth('owner'), { periodStart: '2025-03-15', periodEnd: '2025-04-15' })).statusCode).toBe(409);
    expect((await inject('POST', url, ctx.auth('owner'), { periodStart: '2025-03-31', periodEnd: '2025-03-31' })).statusCode).toBe(409);
    expect((await inject('POST', url, ctx.auth('owner'), { periodStart: '2025-04-01', periodEnd: '2025-04-30' })).statusCode).toBe(201);
  });
});

// ─── BRANCH HIERARCHY ─────────────────────────────────────────────────────────

describe('branch hierarchy', () => {
  it('rejects a parent assignment that would create a longer cycle (A→B→A)', async () => {
    const create = (code: string, parentBranchId?: string) => branchApp.inject({
      method: 'POST', url: '/api/v1/branches', headers: ctx.auth('owner'),
      payload: { name: code, code, ...(parentBranchId ? { parentBranchId } : {}) },
    });
    const a = (await create('CYA')).json();
    const b = (await create('CYB', a.id)).json();
    const c = (await create('CYC', b.id)).json();
    const res = await branchApp.inject({
      method: 'PATCH', url: `/api/v1/branches/${a.id}`, headers: ctx.auth('owner'), payload: { parentBranchId: c.id },
    });
    expect(res.statusCode).toBe(422);
  });

  it('clears cross-syndicate parent links when a branch moves syndicate', async () => {
    const [parent] = await ctx.db.insert(ctx.schema.branches).values({ name: 'P', code: 'MVP', syndicateId: ctx.syndicateId }).returning();
    const [child] = await ctx.db.insert(ctx.schema.branches).values({
      name: 'C', code: 'MVC', syndicateId: ctx.syndicateId, parentBranchId: parent.id,
    }).returning();
    const [s2] = await ctx.db.insert(ctx.schema.syndicates).values({ name: 'Move Target' }).returning();

    const res = await inject('POST', `/api/v1/syndicates/${s2.id}/branches/${child.id}`, platformAuth);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ syndicateId: s2.id, parentBranchId: null });
  });
});

// ─── BILL TAX WITH DISCOUNT ───────────────────────────────────────────────────

describe('bill tax with discount', () => {
  it('stores GST on the discounted transaction value', async () => {
    const res = await inject('POST', '/api/v1/bills', ctx.auth('cashier'), {
      branchId: ctx.branchId, paymentMode: 'CASH', discount: '100.00',
      items: [{ productId: ctx.products[0].id, quantity: 1 }],   // whisky 1000 @ 18%
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ total: '900.00', taxAmount: '137.29' });
  });
});
