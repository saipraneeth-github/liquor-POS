import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import { setupIntegration, type IntegrationContext } from './helpers.js';

let ctx: IntegrationContext;
let platformAuth: { authorization: string };
let foreignSyndicateId: string;
let foreignBranchId: string;

beforeAll(async () => {
  ctx = await setupIntegration();
  const passwordHash = await bcrypt.hash('Password@123', 4);
  const [platform] = await ctx.db.insert(ctx.schema.users).values({
    name: 'Platform', email: 'platform@test.local', passwordHash, role: 'owner', branchId: null, syndicateId: null,
  }).returning();
  platformAuth = ctx.authFor({ sub: platform.id, email: platform.email, role: 'owner', branchId: null, syndicateId: null });

  const [s2] = await ctx.db.insert(ctx.schema.syndicates).values({ name: 'Foreign Syndicate' }).returning();
  foreignSyndicateId = s2.id;
  const [b] = await ctx.db.insert(ctx.schema.branches).values({ name: 'Foreign', code: 'FRN', syndicateId: s2.id }).returning();
  foreignBranchId = b.id;
}, 60_000);

afterAll(async () => {
  await ctx?.app.close();
});

const get = (url: string, headers?: Record<string, string>) => ctx.app.inject({ method: 'GET', url, headers });
const post = (url: string, payload: unknown, headers?: Record<string, string>) =>
  ctx.app.inject({ method: 'POST', url, payload: payload as any, headers });

// ─── AUTH ─────────────────────────────────────────────────────────────────────

describe('syndicate routes require auth', () => {
  it('returns 401 without a token on every route', async () => {
    const id = ctx.syndicateId;
    const results = await Promise.all([
      get('/api/v1/syndicates'),
      post('/api/v1/syndicates', { name: 'X' }),
      ctx.app.inject({ method: 'PATCH', url: `/api/v1/syndicates/${id}`, payload: { name: 'Y' } }),
      get(`/api/v1/syndicates/${id}/branches`),
      post(`/api/v1/syndicates/${id}/branches/${ctx.otherBranchId}`, {}),
      post(`/api/v1/syndicates/${id}/consolidated-invoices`, { periodStart: '2026-01-01', periodEnd: '2026-01-31' }),
      get(`/api/v1/syndicates/${id}/consolidated-invoices`),
    ]);
    for (const r of results) expect(r.statusCode).toBe(401);
  });

  it('login token carries the syndicateId claim', async () => {
    const res = await post('/api/v1/auth/login', { email: 'owner@test.local', password: 'Password@123' });
    const token = res.json().token as string;
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    expect(claims.syndicateId).toBe(ctx.syndicateId);
  });
});

// ─── SYNDICATE OWNER ISOLATION ────────────────────────────────────────────────

describe('syndicate owner isolation', () => {
  it('lists only its own syndicate; non-owners get 403', async () => {
    const own = await get('/api/v1/syndicates', ctx.auth('owner'));
    expect(own.statusCode).toBe(200);
    expect(own.json().map((s: any) => s.id)).toEqual([ctx.syndicateId]);

    expect((await get('/api/v1/syndicates', ctx.auth('manager'))).statusCode).toBe(403);
  });

  it('cannot read another syndicate', async () => {
    expect((await get(`/api/v1/syndicates/${foreignSyndicateId}/branches`, ctx.auth('owner'))).statusCode).toBe(403);
    expect((await get(`/api/v1/syndicates/${foreignSyndicateId}/consolidated-invoices`, ctx.auth('owner'))).statusCode).toBe(403);
    const own = await get(`/api/v1/syndicates/${ctx.syndicateId}/branches`, ctx.auth('owner'));
    expect(own.statusCode).toBe(200);
    expect(own.json().map((b: any) => b.id)).toEqual([ctx.branchId]);
  });

  it('cannot read branch data outside its syndicate', async () => {
    expect((await get(`/api/v1/inventory/stock/${ctx.otherBranchId}`, ctx.auth('owner'))).statusCode).toBe(403);
    expect((await get(`/api/v1/inventory/stock/${foreignBranchId}`, ctx.auth('owner'))).statusCode).toBe(403);
    expect((await get(`/api/v1/tables/${ctx.otherBranchId}`, ctx.auth('owner'))).statusCode).toBe(403);
    expect((await get(`/api/v1/inventory/stock/${ctx.branchId}`, ctx.auth('owner'))).statusCode).toBe(200);
  });

  it('cannot bill into another syndicate\'s branch', async () => {
    const res = await post('/api/v1/bills', {
      branchId: ctx.otherBranchId, paymentMode: 'CASH', items: [{ productId: ctx.products[0].id, quantity: 1 }],
    }, ctx.auth('owner'));
    expect(res.statusCode).toBe(403);
  });

  it('treats legacy tokens without the syndicateId claim via DB lookup (no privilege escalation)', async () => {
    const legacy = { authorization: `Bearer ${ctx.app.jwt.sign({ sub: ctx.users.owner.id, email: ctx.users.owner.email, role: 'owner', branchId: null })}` };
    expect((await get(`/api/v1/inventory/stock/${ctx.otherBranchId}`, legacy)).statusCode).toBe(403);
    expect((await get(`/api/v1/inventory/stock/${ctx.branchId}`, legacy)).statusCode).toBe(200);
  });

  it('closing history only shows accessible branches', async () => {
    await post('/api/v1/closing', { branchId: ctx.otherBranchId, openingCash: '0', actualCashCounted: '0' }, ctx.authFor({
      sub: ctx.otherBranchManager.id, email: ctx.otherBranchManager.email, role: 'manager', branchId: ctx.otherBranchId,
    }));
    const res = await get('/api/v1/closing', ctx.auth('owner'));
    expect(res.statusCode).toBe(200);
    expect(res.json().every((c: any) => c.branchId === ctx.branchId)).toBe(true);
  });
});

// ─── PLATFORM OWNER ADMIN ─────────────────────────────────────────────────────

describe('platform owner administration', () => {
  it('only the platform owner creates syndicates (validated)', async () => {
    expect((await post('/api/v1/syndicates', { name: 'Nope' }, ctx.auth('owner'))).statusCode).toBe(403);
    expect((await post('/api/v1/syndicates', { name: '' }, platformAuth)).statusCode).toBe(400);
    expect((await post('/api/v1/syndicates', { name: 'Bad', gstin: 'short' }, platformAuth)).statusCode).toBe(400);
    const ok = await post('/api/v1/syndicates', { name: 'New Syndicate', gstin: '22aaaaa0000a1z5' }, platformAuth);
    expect(ok.statusCode).toBe(201);
    expect(ok.json().gstin).toBe('22AAAAA0000A1Z5');

    const all = await get('/api/v1/syndicates', platformAuth);
    expect(all.json().length).toBeGreaterThanOrEqual(3);
  });

  it('PATCH /syndicates/:id is platform-only', async () => {
    const url = `/api/v1/syndicates/${foreignSyndicateId}`;
    expect((await ctx.app.inject({ method: 'PATCH', url, payload: { name: 'Hijack' }, headers: ctx.auth('owner') })).statusCode).toBe(403);
    const ok = await ctx.app.inject({ method: 'PATCH', url, payload: { name: 'Foreign Renamed' }, headers: platformAuth });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().name).toBe('Foreign Renamed');
  });

  it('assigns a branch to a syndicate (platform owner only)', async () => {
    const [b] = await ctx.db.insert(ctx.schema.branches).values({ name: 'Loose', code: 'LSE' }).returning();
    const url = `/api/v1/syndicates/${foreignSyndicateId}/branches/${b.id}`;
    expect((await post(url, {}, ctx.auth('owner'))).statusCode).toBe(403);
    const ok = await post(url, {}, platformAuth);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().syndicateId).toBe(foreignSyndicateId);
    expect((await post(`/api/v1/syndicates/${foreignSyndicateId}/branches/00000000-0000-4000-8000-000000000000`, {}, platformAuth)).statusCode).toBe(404);
  });
});

// ─── CONSOLIDATED INVOICES ────────────────────────────────────────────────────

describe('consolidated invoices', () => {
  it('aggregates PAID bills across the syndicate branches only', async () => {
    const { businessDateOf } = await import('../../src/lib/business-day.js');
    const [whisky, beer] = ctx.products;
    const bill = (branchId: string, productId: string, quantity: number, headers = ctx.auth('cashier')) =>
      post('/api/v1/bills', { branchId, paymentMode: 'CASH', items: [{ productId, quantity }] }, headers);

    expect((await bill(ctx.branchId, whisky.id, 1)).statusCode).toBe(201);   // 1000.00, tax 152.54
    expect((await bill(ctx.branchId, beer.id, 2)).statusCode).toBe(201);     //  400.00, tax  42.86
    const toVoid = (await bill(ctx.branchId, beer.id, 1)).json();
    expect((await post(`/api/v1/bills/${toVoid.id}/void`, { voidReason: 'Wrong item' }, ctx.auth('manager'))).statusCode).toBe(200);
    // other branch (not in the syndicate) — must be excluded
    const om = ctx.authFor({ sub: ctx.otherBranchManager.id, email: ctx.otherBranchManager.email, role: 'manager', branchId: ctx.otherBranchId });
    expect((await bill(ctx.otherBranchId, whisky.id, 3, om)).statusCode).toBe(201);

    const today = businessDateOf();
    const url = `/api/v1/syndicates/${ctx.syndicateId}/consolidated-invoices`;
    const res = await post(url, { periodStart: today, periodEnd: today }, ctx.auth('owner'));
    expect(res.statusCode).toBe(201);
    const inv = res.json();
    expect(inv.grossSales).toBe('1400.00');
    expect(inv.totalTax).toBe('195.40');
    expect(inv.billCount).toBe(2);
    expect(inv.breakdown).toHaveLength(1);
    expect(inv.breakdown[0]).toMatchObject({ branchId: ctx.branchId, grossSales: '1400.00', billCount: 2 });

    const list = await get(url, ctx.auth('owner'));
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);

    // validation / access
    expect((await post(url, { periodStart: today, periodEnd: '2000-01-01' }, ctx.auth('owner'))).statusCode).toBe(422);
    expect((await post(url, { periodStart: 'yesterday', periodEnd: today }, ctx.auth('owner'))).statusCode).toBe(400);
    expect((await post(`/api/v1/syndicates/${foreignSyndicateId}/consolidated-invoices`, { periodStart: today, periodEnd: today }, ctx.auth('owner'))).statusCode).toBe(403);
  });
});
