import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import { setupIntegration, type IntegrationContext } from './helpers.js';

let ctx: IntegrationContext;
let superAdmin: { authorization: string };

const inject = (method: 'GET' | 'POST' | 'PATCH', url: string, headers: { authorization: string }, payload?: unknown) =>
  ctx.app.inject({ method, url, headers, payload: payload as object | undefined });
const dashboard = async () => (await inject('GET', '/api/v1/platform/dashboard', superAdmin)).json();
const newTenant = async (name: string, plan: 'TRIAL' | 'STANDARD' | 'PRO') => {
  const r = await inject('POST', '/api/v1/platform/tenants', superAdmin, {
    name, plan, admin: { name: `${name} Admin`, email: `${name.toLowerCase().replace(/\W+/g, '')}@dash.test`, password: 'Sup3rSecret!' },
  });
  expect(r.statusCode).toBe(201);
  return r.json().tenant.id as string;
};

beforeAll(async () => {
  ctx = await setupIntegration();
  const hash = await bcrypt.hash('Password@123', 4);
  const [sa] = await ctx.db.insert(ctx.schema.users).values({
    name: 'Platform Root', email: 'root@dash.local', passwordHash: hash, role: 'owner', branchId: null, syndicateId: null,
  }).returning();
  superAdmin = ctx.authFor({ sub: sa.id, email: sa.email, role: 'owner', branchId: null, syndicateId: null });
}, 60_000);

afterAll(async () => { await ctx?.app.close(); });

describe('GET /platform/dashboard', () => {
  it('is for the Super Admin only', async () => {
    expect((await inject('GET', '/api/v1/platform/dashboard', ctx.auth('owner'))).statusCode).toBe(403);
    expect((await inject('GET', '/api/v1/platform/dashboard', ctx.auth('manager'))).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/platform/dashboard' })).statusCode).toBe(401);
    expect((await inject('GET', '/api/v1/platform/dashboard', superAdmin)).statusCode).toBe(200);
  });

  it('returns the full shape with six zero-filled months', async () => {
    const d = await dashboard();
    expect(Object.keys(d.kpis)).toEqual(expect.arrayContaining(['mrr', 'payingTenants', 'trialTenants', 'outstanding', 'branches', 'staff', 'sales30d']));
    expect(d.plans.map((p: { plan: string }) => p.plan)).toEqual(['TRIAL', 'STANDARD', 'PRO']);
    expect(d.revenueByMonth).toHaveLength(6);
    expect(Object.keys(d.queue)).toEqual(['trialEnding', 'overdue', 'quiet', 'suspended']);
  });

  it('a new paid business adds its price to MRR; suspending it takes the price away and lists it', async () => {
    const before = await dashboard();
    const id = await newTenant('Mrr Test Wines', 'PRO');
    const after = await dashboard();
    expect(after.kpis.mrr - before.kpis.mrr).toBe(7999);
    expect(after.kpis.payingTenants - before.kpis.payingTenants).toBe(1);

    await inject('PATCH', `/api/v1/platform/tenants/${id}`, superAdmin, { isActive: false });
    const suspended = await dashboard();
    expect(suspended.kpis.mrr).toBe(before.kpis.mrr);
    expect(suspended.queue.suspended.ids).toContain(id);
  });

  it('lists a trial that is about to end, and not one with time left', async () => {
    const soon = await newTenant('Ending Trial Bar', 'TRIAL');
    const roomy = await newTenant('Roomy Trial Bar', 'TRIAL');
    await inject('PATCH', `/api/v1/platform/tenants/${soon}`, superAdmin, { plan: 'TRIAL', trialEndsAt: new Date(Date.now() + 2 * 86_400_000).toISOString() });
    const d = await dashboard();
    expect(d.queue.trialEnding.ids).toContain(soon);
    expect(d.queue.trialEnding.ids).not.toContain(roomy);
  });

  it('a paid-then-lapsed business is listed as overdue', async () => {
    const id = await newTenant('Lapsed Liquors', 'STANDARD');
    await inject('PATCH', `/api/v1/platform/tenants/${id}`, superAdmin, { plan: 'STANDARD', paidUntil: new Date(Date.now() - 3 * 86_400_000).toISOString() });
    expect((await dashboard()).queue.overdue.ids).toContain(id);
  });

  it('a recorded subscription payment shows up as billed revenue this month and clears outstanding', async () => {
    const id = await newTenant('Revenue Bar', 'STANDARD');
    const before = await dashboard();
    const inv = (await inject('POST', `/api/v1/platform/tenants/${id}/invoices`, superAdmin)).json();
    const pending = await dashboard();
    expect(Number(pending.kpis.outstanding) - Number(before.kpis.outstanding)).toBe(2999);
    await inject('POST', `/api/v1/platform/invoices/${inv.id}/pay`, superAdmin, { paymentRef: 'UTR-DASH-1' });
    const after = await dashboard();
    const last = (d: { revenueByMonth: { standard: number; pro: number }[] }) => d.revenueByMonth[5];
    expect(last(after).standard - last(before).standard).toBeGreaterThanOrEqual(2999);
    expect(Number(after.kpis.outstanding)).toBe(Number(before.kpis.outstanding));
  });

  it('the tenant list carries a health score and queue flags', async () => {
    const list = (await inject('GET', '/api/v1/platform/tenants', superAdmin)).json().tenants;
    expect(list.length).toBeGreaterThan(0);
    for (const t of list) {
      expect(t.health).toBeGreaterThanOrEqual(0);
      expect(t.health).toBeLessThanOrEqual(100);
      expect(Array.isArray(t.flags)).toBe(true);
    }
    const suspended = list.find((t: { name: string }) => t.name === 'Mrr Test Wines');
    expect(suspended.flags).toEqual(['suspended']);
    expect(suspended.health).toBeLessThanOrEqual(40);
  });
});
