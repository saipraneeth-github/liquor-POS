import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { setupIntegration, type IntegrationContext } from './helpers.js';

let ctx: IntegrationContext;
let superAdmin: { authorization: string };
const stamp = Math.random().toString(36).slice(2, 7);
let seq = 0;

const inject = (method: 'GET' | 'POST' | 'PUT', url: string, headers: Record<string, string>, payload?: unknown) =>
  ctx.app.inject({ method, url: `/api/v1${url}`, headers, payload: payload as object | undefined });
const sa = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => inject(method, url, superAdmin, payload);

type Row = { id: string; name: string; code: string; tenant: string | null; tenantId: string | null; standing: string; staff: number; featuresOff: number; tenantBranches: number };
const list = async (qs = '') => (await sa('GET', `/platform/branches${qs}`)).json() as { branches: Row[]; total: number; features: { key: string }[] };
type Feature = { key: string; enabled: boolean; changedBy: string | null; label: string };
const detail = async (id: string) => (await sa('GET', `/platform/branches/${id}`)).json() as { id: string; features: Feature[]; staff: { email: string; role: string }[]; admins: { email: string }[]; tenant: string | null; standing: string; tenantBranches: number };
const setFeatures = (id: string, features: Record<string, boolean>) => sa('PUT', `/platform/branches/${id}/features`, { features });
const asManager = () => ctx.auth('manager');

/** A business of its own with two branches (and a manager in the first), created next to the seeded one. */
async function newTenantWithBranches() {
  const n = ++seq;
  const r = await sa('POST', '/platform/tenants', { name: `Branchy ${stamp} ${n}`, plan: 'PRO', admin: { name: 'B Admin', email: `branchy.${stamp}.${n}@br.test`, password: 'Sup3rSecret!' } });
  expect(r.statusCode).toBe(201);
  const tenantId = r.json().tenant.id as string;
  const mk = async (code: string, name: string) => (await ctx.db.insert(ctx.schema.branches).values({ name, code: `${code}${stamp}${n}`.slice(0, 10).toUpperCase(), syndicateId: tenantId, address: 'Plot 4, Jubilee Hills' }).returning())[0];
  const b1 = await mk('N', `North ${stamp}`);
  const b2 = await mk('S', `South ${stamp}`);
  await ctx.db.insert(ctx.schema.users).values({ name: 'North Manager', email: `nm.${stamp}.${n}@br.test`, passwordHash: await bcrypt.hash('Password@123', 4), role: 'manager', branchId: b1.id });
  return { tenantId, b1, b2 };
}

beforeAll(async () => {
  ctx = await setupIntegration();
  const [root] = await ctx.db.insert(ctx.schema.users).values({
    name: 'Branch Root', email: `root.${stamp}@br.local`, passwordHash: await bcrypt.hash('Password@123', 4), role: 'owner', branchId: null, syndicateId: null,
  }).returning();
  superAdmin = ctx.authFor({ sub: root.id, email: root.email, role: 'owner', branchId: null, syndicateId: null });
}, 60_000);
afterAll(async () => { await ctx?.app.close(); });

describe('Super Admin: branches across every business', () => {
  it('is for the Super Admin only', async () => {
    for (const [m, path] of [['GET', '/platform/branches'], ['GET', `/platform/branches/${ctx.branchId}`], ['PUT', `/platform/branches/${ctx.branchId}/features`]] as const) {
      expect((await inject(m, path, ctx.auth('owner'), { features: { bank: false } })).statusCode).toBe(403);
      expect((await inject(m, path, ctx.auth('manager'), { features: { bank: false } })).statusCode).toBe(403);
      expect((await ctx.app.inject({ method: m, url: `/api/v1${path}` })).statusCode).toBe(401);
    }
  });

  it('lists every branch with its business, staff, standing and what is switched off; filters and pages', async () => {
    const t = await newTenantWithBranches();
    const all = await list('?limit=200');
    expect(all.total).toBeGreaterThanOrEqual(4);                                                 // Main, Other, North, South
    expect(all.features.map((f) => f.key)).toEqual(expect.arrayContaining(['bank', 'accounting', 'bar']));
    const north = all.branches.find((b) => b.id === t.b1.id)!;
    expect(north).toMatchObject({ tenantId: t.tenantId, standing: 'ACTIVE', staff: 1, featuresOff: 0, tenantBranches: 2 });
    expect(north.tenant).toContain('Branchy');
    expect(all.branches.find((b) => b.id === ctx.otherBranchId)).toMatchObject({ tenant: null, standing: 'NONE' });   // a branch with no business

    expect((await list(`?tenantId=${t.tenantId}`)).branches.map((b) => b.id).sort()).toEqual([t.b1.id, t.b2.id].sort());
    expect((await list(`?search=${encodeURIComponent(`South ${stamp}`)}`)).branches.map((b) => b.id)).toEqual([t.b2.id]);
    expect((await list('?search=jubilee')).branches.map((b) => b.id)).toEqual(expect.arrayContaining([t.b1.id, t.b2.id]));   // address
    expect((await list(`?search=${encodeURIComponent(`Branchy ${stamp}`)}`)).total).toBe(2);                                // the business name
    const page = await list(`?tenantId=${t.tenantId}&limit=1&offset=1`);
    expect(page.branches).toHaveLength(1);
    expect(page.total).toBe(2);

    // standing follows the business: suspended, then archived
    await sa('PATCH' as never, `/platform/tenants/${t.tenantId}`, { isActive: false });
    expect((await list(`?tenantId=${t.tenantId}&status=suspended`)).total).toBe(2);
    expect((await list(`?tenantId=${t.tenantId}&status=active`)).total).toBe(0);
    await sa('POST', `/platform/tenants/${t.tenantId}/archive`, { reason: 'testing' });
    expect((await list(`?tenantId=${t.tenantId}&status=archived`)).total).toBe(2);

    expect((await sa('GET', '/platform/branches?status=gone')).statusCode).toBe(400);
    expect((await sa('GET', '/platform/branches?featureOff=teleport')).statusCode).toBe(400);
    expect((await sa('GET', '/platform/branches?limit=9999')).statusCode).toBe(400);
  });

  it('shows one branch with its feature matrix and who can work in it', async () => {
    const d = await detail(ctx.branchId);
    expect(d.tenant).toBe('Test Syndicate');
    expect(d.features).toHaveLength(8);
    expect(d.features.every((f) => f.enabled)).toBe(true);
    expect(d.staff.map((u) => u.role).sort()).toEqual(['cashier', 'manager', 'office_admin', 'steward']);
    expect(d.admins.map((a) => a.email)).toEqual(['owner@test.local']);                        // the business Admin works in every branch
    expect((await sa('GET', '/platform/branches/00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect((await sa('GET', '/platform/branches/not-an-id')).statusCode).toBe(404);
  });
});

describe('switching features per branch', () => {
  it('turns features off and on, records who and when, and audits only what changed', async () => {
    const t = await newTenantWithBranches();
    const r = await setFeatures(t.b1.id, { bank: false, schemes: false, accounting: true });   // accounting was already on: no change
    expect(r.statusCode).toBe(200);
    const d = r.json() as Awaited<ReturnType<typeof detail>>;
    expect(d.features.filter((f) => !f.enabled).map((f) => f.key).sort()).toEqual(['bank', 'schemes']);
    expect(d.features.find((f) => f.key === 'bank')).toMatchObject({ enabled: false, changedBy: 'Branch Root' });
    expect((await list(`?tenantId=${t.tenantId}`)).branches.find((b) => b.id === t.b1.id)!.featuresOff).toBe(2);
    expect((await list('?featureOff=bank&limit=200')).branches.map((b) => b.id)).toContain(t.b1.id);
    expect((await list('?featureOff=bank&limit=200')).branches.map((b) => b.id)).not.toContain(t.b2.id);

    const log = (await sa('GET', `/platform/audit?action=branch.features&tenantId=${t.tenantId}`)).json().events[0];
    expect(log.meta.before).toEqual({ bank: true, schemes: true });
    expect(log.meta.after).toEqual({ bank: false, schemes: false });
    expect(log.tenant).toContain('Branchy');

    // the other branch of the same business is untouched
    expect((await detail(t.b2.id)).features.every((f) => f.enabled)).toBe(true);

    // back on: nothing is left switched off
    expect((await setFeatures(t.b1.id, { bank: true, schemes: true })).statusCode).toBe(200);
    expect((await detail(t.b1.id)).features.every((f) => f.enabled)).toBe(true);
  });

  it('refuses nothing-to-do, unknown features and empty requests', async () => {
    const t = await newTenantWithBranches();
    const noop = await setFeatures(t.b1.id, { bank: true });
    expect(noop.statusCode).toBe(422);
    expect(noop.json().error).toMatch(/nothing changed/i);
    const unknown = await setFeatures(t.b1.id, { teleport: false });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json().error).toMatch(/unknown feature/i);
    expect((await sa('PUT', `/platform/branches/${t.b1.id}/features`, { features: {} })).statusCode).toBe(400);
    expect((await sa('PUT', `/platform/branches/${t.b1.id}/features`, {})).statusCode).toBe(400);
    expect((await sa('PUT', `/platform/branches/${t.b1.id}/features`, { features: { bank: 'no' } })).statusCode).toBe(400);
    expect((await setFeatures('00000000-0000-4000-8000-000000000000', { bank: false })).statusCode).toBe(404);
  });
});

describe('a switched-off feature is closed for that branch', () => {
  it('blocks the branch\'s own users and anyone naming the branch; other branches and core screens are untouched', async () => {
    const bank = () => inject('GET', `/bank/accounts?branchId=${ctx.branchId}`, asManager());
    expect((await bank()).statusCode).toBe(200);

    expect((await setFeatures(ctx.branchId, { bank: false })).statusCode).toBe(200);
    const blocked = await bank();
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ code: 'FEATURE_DISABLED', feature: 'bank' });
    // the branch is found in the path, the query or the body, and from the user's own branch when nothing names one
    expect((await inject('POST', '/bank/accounts', asManager(), { branchId: ctx.branchId, name: 'Nope' })).statusCode).toBe(403);
    expect((await inject('GET', '/bank/accounts', asManager())).statusCode).toBe(403);
    expect((await inject('GET', `/bank/accounts?branchId=${ctx.branchId}`, ctx.auth('owner'))).statusCode).toBe(403);   // the business Admin too

    // another branch has it, the same user's other features work, POS billing is untouched, no token still means 401
    const other = ctx.authFor({ sub: ctx.otherBranchManager.id, email: ctx.otherBranchManager.email, role: 'manager', branchId: ctx.otherBranchId });
    expect((await inject('GET', `/bank/accounts?branchId=${ctx.otherBranchId}`, other)).statusCode).toBe(200);
    expect((await inject('GET', `/accounting/trial-balance/${ctx.branchId}`, asManager())).statusCode).toBe(200);
    const sale = await inject('POST', '/bills', ctx.auth('cashier'), { branchId: ctx.branchId, paymentMode: 'CASH', items: [{ productId: ctx.products[0].id, quantity: 1 }] });
    expect(sale.statusCode).toBe(201);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/v1/bank/accounts?branchId=${ctx.branchId}` })).statusCode).toBe(401);

    // the app is told, so it can hide the page
    const branches = (await inject('GET', '/branches', asManager())).json() as { id: string; disabledFeatures: string[] }[];
    expect(branches.find((b) => b.id === ctx.branchId)!.disabledFeatures).toEqual(['bank']);

    // on again: open at once
    expect((await setFeatures(ctx.branchId, { bank: true })).statusCode).toBe(200);
    expect((await bank()).statusCode).toBe(200);
    expect(((await inject('GET', '/branches', asManager())).json() as { id: string; disabledFeatures: string[] }[]).find((b) => b.id === ctx.branchId)!.disabledFeatures).toEqual([]);
  });

  it('closes every route of the feature, and only those', async () => {
    const off = { bar: false, invoices: false, schemes: false, counter_sheets: false, closing: false, compliance: false, accounting: false };
    expect((await setFeatures(ctx.branchId, off)).statusCode).toBe(200);
    const b = ctx.branchId;
    for (const url of [`/tables/${b}`, `/invoices/${b}`, `/schemes/${b}`, `/counter-sheets/${b}`, `/compliance/quotas/${b}`, `/compliance/lifting/${b}`, `/expenses/${b}`, `/accounting/ledgers/${b}`]) {
      const r = await inject('GET', url, asManager());
      expect(r.statusCode, url).toBe(403);
      expect(r.json().code, url).toBe('FEATURE_DISABLED');
    }
    expect((await inject('GET', `/closing?branchId=${b}`, asManager())).statusCode).toBe(403);
    // not part of any switchable feature: still work (breakage and pour control live under /compliance, the POS needs sale types and customers)
    for (const url of [`/inventory/stock/${b}`, `/compliance/breakage/${b}`, `/sale-types/${b}`, `/customers/${b}`, `/products`]) {
      expect((await inject('GET', url, asManager())).statusCode, url).toBe(200);
    }
    expect((await setFeatures(ctx.branchId, Object.fromEntries(Object.keys(off).map((k) => [k, true])))).statusCode).toBe(200);
    expect((await inject('GET', `/tables/${b}`, asManager())).statusCode).toBe(200);
  });

  it('a deleted business takes its feature switches with it', async () => {
    const t = await newTenantWithBranches();
    await setFeatures(t.b1.id, { bank: false });
    await sa('POST', `/platform/tenants/${t.tenantId}/archive`, { reason: 'cleanup' });
    await ctx.db.update(ctx.schema.syndicates).set({ archivedAt: new Date(Date.now() - 31 * 86_400_000) }).where(eq(ctx.schema.syndicates.id, t.tenantId));
    const name = ((await sa('GET', '/platform/tenants')).json().tenants as { id: string; name: string }[]).find((x) => x.id === t.tenantId)!.name;
    const del = await sa('POST', `/platform/tenants/${t.tenantId}/delete`, { confirmName: name, acknowledge: true });
    expect(del.statusCode).toBe(200);
    expect((await sa('GET', `/platform/branches/${t.b1.id}`)).statusCode).toBe(404);
    expect((await ctx.db.select().from(ctx.schema.branchFeatures).where(eq(ctx.schema.branchFeatures.branchId, t.b1.id)))).toHaveLength(0);
  });
});
