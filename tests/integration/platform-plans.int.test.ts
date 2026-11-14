import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { setupIntegration, type IntegrationContext } from './helpers.js';
import { businessDateOf } from '../../src/lib/business-day.js';
import { addDaysIso } from '../../src/modules/platform/plans.engine.js';

let ctx: IntegrationContext;
let superAdmin: { authorization: string };
const stamp = Math.random().toString(36).slice(2, 7);
let seq = 0;
const today = businessDateOf();

const inject = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, headers: Record<string, string>, payload?: unknown) =>
  ctx.app.inject({ method, url: `/api/v1${url}`, headers, payload: payload as object | undefined });
const sa = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => inject(method, url, superAdmin, payload);

type Plan = { code: string; name: string; price: string; cycleDays: number; maxBranches: number; isActive: boolean; tenantCount: number; features: string[] };
const plans = async () => (await sa('GET', '/platform/plans')).json().plans as Plan[];
const newPlan = async (over: Record<string, unknown> = {}) => {
  const r = await sa('POST', '/platform/plans', { name: `Plan ${stamp} ${++seq}`, price: '1000', cycleDays: 30, maxBranches: 2, features: ['One', 'Two'], ...over });
  expect(r.statusCode).toBe(201);
  return r.json() as Plan;
};
const newTenant = async (plan: string, extra: Record<string, unknown> = {}) => {
  const n = ++seq;
  const r = await sa('POST', '/platform/tenants', { name: `Biz ${stamp} ${n}`, plan, admin: { name: 'A', email: `biz.${stamp}.${n}@plans.test`, password: 'Sup3rSecret!' }, ...extra });
  expect(r.statusCode).toBe(201);
  return r.json().tenant.id as string;
};
const tenant = async (id: string) => ((await sa('GET', '/platform/tenants')).json().tenants as Array<{ id: string; plan: string; maxBranches: number; paidUntil: string | null; nextPlan: string | null; nextPlanFrom: string | null }>).find((t) => t.id === id)!;
const invoices = async (id: string) => (await sa('GET', `/platform/tenants/${id}/invoices`)).json().invoices as Array<{ id: string; plan: string; amount: string; status: string }>;
/** Raise and pay an invoice, so the business has genuinely paid for its plan. */
const pay = async (id: string) => {
  const inv = await sa('POST', `/platform/tenants/${id}/invoices`);
  expect(inv.statusCode).toBe(201);
  expect((await sa('POST', `/platform/invoices/${inv.json().id}/pay`, { paymentRef: 'UTR-1' })).statusCode).toBe(200);
};
const audit = async (action: string, tenantId: string) => (await sa('GET', `/platform/audit?action=${action}&tenantId=${tenantId}`)).json().events as Array<{ meta: Record<string, unknown> }>;

beforeAll(async () => {
  ctx = await setupIntegration();
  const [root] = await ctx.db.insert(ctx.schema.users).values({
    name: 'Plans Root', email: `root.${stamp}@plans.local`, passwordHash: await bcrypt.hash('Password@123', 4), role: 'owner', branchId: null, syndicateId: null,
  }).returning();
  superAdmin = ctx.authFor({ sub: root.id, email: root.email, role: 'owner', branchId: null, syndicateId: null });
}, 60_000);
afterAll(async () => { await ctx?.app.close(); });

describe('plan catalog', () => {
  it('is for the Super Admin only; Admins can read the plans on sale', async () => {
    for (const [m, path] of [['GET', '/platform/plans'], ['POST', '/platform/plans'], ['PATCH', '/platform/plans/PRO'], ['POST', '/platform/plans/PRO/retire']] as const) {
      expect((await inject(m, path, ctx.auth('owner'), {})).statusCode).toBe(403);
      expect((await inject(m, path, ctx.auth('manager'), {})).statusCode).toBe(403);
    }
    const onSale = (await inject('GET', '/tenant/plans', ctx.auth('owner'))).json().plans as Array<{ code: string }>;
    expect(onSale.map((p) => p.code)).toEqual(expect.arrayContaining(['STANDARD', 'PRO']));
    expect(onSale.map((p) => p.code)).not.toContain('TRIAL');
  });

  it('starts with the three plans that were always there, at the same prices and limits', async () => {
    const p = await plans();
    expect(p.find((x) => x.code === 'TRIAL')).toMatchObject({ price: '0.00', maxBranches: 1, isActive: true });
    expect(p.find((x) => x.code === 'STANDARD')).toMatchObject({ price: '2999.00', maxBranches: 3, cycleDays: 30 });
    expect(p.find((x) => x.code === 'PRO')).toMatchObject({ price: '7999.00', maxBranches: 25 });
  });

  it('creates a plan with a readable code, validates the form, and audits it', async () => {
    const bad = async (over: Record<string, unknown>) => (await sa('POST', '/platform/plans', { name: 'Valid name', price: '1000', cycleDays: 30, maxBranches: 2, ...over })).statusCode;
    expect(await bad({ name: 'ab' })).toBe(400);
    expect(await bad({ price: '0' })).toBe(400);
    expect(await bad({ price: 'cheap' })).toBe(400);
    expect(await bad({ cycleDays: 45 })).toBe(400);
    expect(await bad({ maxBranches: 0 })).toBe(400);
    expect(await bad({ features: Array.from({ length: 13 }, (_, i) => `f${i}`) })).toBe(400);

    const gold = await newPlan({ name: `Gold Bar ${stamp}`, price: '4999.5', cycleDays: 90, maxBranches: 5, features: ['Five branches'] });
    expect(gold.code).toBe(`GOLD_BAR_${stamp.toUpperCase()}`);
    expect(gold).toMatchObject({ price: '4999.50', cycleDays: 90, maxBranches: 5, isActive: true });
    const twin = await newPlan({ name: `Gold Bar ${stamp}` });
    expect(twin.code).toBe(`GOLD_BAR_${stamp.toUpperCase()}_2`);                     // the same name never reuses a code
    const trialName = await newPlan({ name: 'Trial' });
    expect(trialName.code).not.toBe('TRIAL');                                           // the built-in trial cannot be shadowed
    const trail = (await sa('GET', `/platform/audit?action=plan.create`)).json().events as Array<{ targetId: string }>;
    expect(trail.map((e) => e.targetId)).toContain(gold.code);
  });

  it('a new price applies to invoices raised afterwards; an invoice already raised keeps its amount', async () => {
    const plan = await newPlan({ price: '1000' });
    const t = await newTenant(plan.code);
    expect((await sa('POST', `/platform/tenants/${t}/invoices`)).statusCode).toBe(201);
    const first = (await invoices(t))[0];
    expect(first.amount).toBe('1000.00');

    const edited = await sa('PATCH', `/platform/plans/${plan.code}`, { price: '1500', features: ['Now with more'] });
    expect(edited.statusCode).toBe(200);
    expect((await invoices(t))[0].amount).toBe('1000.00');
    const log = (await sa('GET', `/platform/audit?action=plan.update`)).json().events[0];
    expect(log.meta.before.price).toBe('1000.00');
    expect(log.meta.after.price).toBe('1500.00');

    await sa('POST', `/platform/invoices/${first.id}/pay`, { paymentRef: 'X' });
    expect((await sa('POST', `/platform/tenants/${t}/invoices`)).statusCode).toBe(201);
    expect((await invoices(t)).find((i) => i.status === 'PENDING')!.amount).toBe('1500.00');
  });

  it('the trial is always free and cannot be retired', async () => {
    expect((await sa('PATCH', '/platform/plans/TRIAL', { price: '500' })).statusCode).toBe(422);
    expect((await sa('PATCH', '/platform/plans/TRIAL', { cycleDays: 90 })).statusCode).toBe(422);
    expect((await sa('PATCH', '/platform/plans/TRIAL', { features: ['Free for 14 days'] })).statusCode).toBe(200);
    expect((await sa('POST', '/platform/plans/TRIAL/retire')).statusCode).toBe(422);
    expect((await sa('PATCH', '/platform/plans/NOPE', { name: 'Whatever' })).statusCode).toBe(404);
    expect((await sa('PATCH', '/platform/plans/STANDARD', {})).statusCode).toBe(400);
  });

  it('a retired plan cannot be chosen, but businesses on it keep it and keep being billed', async () => {
    const plan = await newPlan({ price: '800' });
    const t = await newTenant(plan.code);
    const other = await newTenant('TRIAL');
    expect((await sa('POST', `/platform/plans/${plan.code}/retire`)).statusCode).toBe(200);
    expect((await plans()).find((p) => p.code === plan.code)).toMatchObject({ isActive: false, tenantCount: 1 });

    expect((await inject('GET', '/tenant/plans', ctx.auth('owner'))).json().plans.map((p: { code: string }) => p.code)).not.toContain(plan.code);
    const create = await sa('POST', '/platform/tenants', { name: `Late ${stamp}`, plan: plan.code, admin: { name: 'A', email: `late.${stamp}@plans.test`, password: 'Sup3rSecret!' } });
    expect(create.statusCode).toBe(422);
    expect((await sa('PATCH', `/platform/tenants/${other}`, { plan: plan.code })).statusCode).toBe(422);
    expect((await sa('POST', `/platform/tenants/${other}/plan`, { plan: plan.code })).statusCode).toBe(422);
    expect((await sa('PATCH', `/platform/tenants/${t}`, { plan: plan.code, maxBranches: 4 })).statusCode).toBe(200);       // staying put is fine
    expect((await sa('POST', `/platform/tenants/${t}/invoices`)).statusCode).toBe(201);
    expect((await invoices(t))[0].amount).toBe('800.00');

    expect((await sa('POST', `/platform/plans/${plan.code}/reactivate`)).statusCode).toBe(200);
    expect((await plans()).find((p) => p.code === plan.code)!.isActive).toBe(true);
    expect((await sa('POST', '/platform/tenants', { name: `Back ${stamp}`, plan: plan.code, admin: { name: 'A', email: `back.${stamp}@plans.test`, password: 'Sup3rSecret!' } })).statusCode).toBe(201);
  });

  it('recurring revenue counts a yearly plan as its monthly equivalent', async () => {
    const mrr = async () => Number((await sa('GET', '/platform/dashboard')).json().kpis.mrr);
    const before = await mrr();
    const yearly = await newPlan({ price: '12000', cycleDays: 365, maxBranches: 3 });
    await newTenant(yearly.code);
    expect((await mrr()) - before).toBeCloseTo(986.3, 1);                    // 12000 × 30 / 365
    const dash = (await sa('GET', '/platform/dashboard')).json();
    expect(dash.plans.find((p: { plan: string }) => p.plan === yearly.code)).toMatchObject({ name: yearly.name, count: 1, price: '986.30' });
  });
});

describe('moving a business to another plan', () => {
  it('previews the proration: unused time on a paid plan is credited, and bad requests are refused', async () => {
    const t = await newTenant('STANDARD');
    await pay(t);                                                            // really paid: 30 days of Standard
    const p = (await sa('GET', `/platform/tenants/${t}/plan-preview?plan=PRO`)).json();
    expect(p).toMatchObject({ currentPaid: true, unusedDays: 30, credit: '2999.00', newPrice: '7999.00', amountDue: '5000.00', fitsBranches: true, sameAsCurrent: false });
    expect(p.current.code).toBe('STANDARD');
    expect(p.periodStart).toBe(today);
    expect(p.periodEnd).toBe(addDaysIso(today, 30));

    const later = (await sa('GET', `/platform/tenants/${t}/plan-preview?plan=PRO&effective=${addDaysIso(today, 50)}`)).json();   // paid to about day 60, so ~10 days are left by then
    expect(later.unusedDays).toBeLessThan(30);
    expect(Number(later.credit)).toBeLessThan(2999);

    expect((await sa('GET', `/platform/tenants/${t}/plan-preview?plan=PRO&effective=${addDaysIso(today, -1)}`)).statusCode).toBe(422);
    expect((await sa('GET', `/platform/tenants/${t}/plan-preview?plan=PRO&effective=${addDaysIso(today, 91)}`)).statusCode).toBe(422);
    expect((await sa('GET', `/platform/tenants/${t}/plan-preview?plan=NOPE`)).statusCode).toBe(404);
    expect((await sa('GET', `/platform/tenants/${t}/plan-preview?plan=TRIAL`)).statusCode).toBe(422);
    expect((await sa('GET', `/platform/tenants/${t}/plan-preview?plan=PRO&effective=soon`)).statusCode).toBe(400);
    expect((await sa('GET', `/platform/tenants/00000000-0000-4000-8000-000000000000/plan-preview?plan=PRO`)).statusCode).toBe(404);
  });

  it('gives no credit for the courtesy period of a plan nobody has paid for', async () => {
    const t = await newTenant('STANDARD');                                  // starts with 30 courtesy days, unpaid
    const p = (await sa('GET', `/platform/tenants/${t}/plan-preview?plan=PRO`)).json();
    expect(p).toMatchObject({ currentPaid: false, credit: '0.00', amountDue: '7999.00' });
  });

  it('assigns now: the plan and limit switch at once, an unpaid invoice is replaced, and what was paid is credited', async () => {
    const t = await newTenant('STANDARD');
    await pay(t);
    await sa('POST', `/platform/tenants/${t}/invoices`);                    // a renewal nobody paid yet
    expect((await invoices(t)).filter((i) => i.status === 'PENDING')).toHaveLength(1);

    const r = await sa('POST', `/platform/tenants/${t}/plan`, { plan: 'PRO' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ scheduled: false });
    expect(r.json().preview).toMatchObject({ amountDue: '5000.00' });
    const after = await tenant(t);
    expect(after).toMatchObject({ plan: 'PRO', maxBranches: 25, nextPlan: null });
    const inv = await invoices(t);
    const pending = inv.filter((i) => i.status === 'PENDING');
    expect(pending).toHaveLength(1);                                         // the old renewal was voided, one new invoice stands
    expect(pending[0]).toMatchObject({ plan: 'PRO', amount: '5000.00' });
    expect(inv.some((i) => i.status === 'VOID')).toBe(true);

    const log = (await audit('tenant.plan_assigned', t))[0];
    expect(log.meta).toMatchObject({ before: { plan: 'STANDARD' }, after: { plan: 'PRO', maxBranches: 25 }, credit: '2999.00', amountDue: '5000.00' });
    expect((await sa('POST', `/platform/tenants/${t}/plan`, { plan: 'PRO' })).statusCode).toBe(409);     // already there
  });

  it('moving to a cheaper plan that the credit covers raises no invoice and extends access', async () => {
    const t = await newTenant('PRO');
    await pay(t);
    const r = await sa('POST', `/platform/tenants/${t}/plan`, { plan: 'STANDARD' });
    expect(r.statusCode).toBe(200);
    expect(r.json().preview).toMatchObject({ credit: '7999.00', amountDue: '0.00' });
    expect((await invoices(t)).filter((i) => i.status === 'PENDING')).toHaveLength(0);
    const after = await tenant(t);
    expect(after.plan).toBe('STANDARD');
    expect(new Date(after.paidUntil!).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
  });

  it('refuses a plan with fewer branches than the business already has', async () => {
    const small = await newPlan({ maxBranches: 1 });
    const t = await newTenant('PRO');
    const sid = (await ctx.db.select().from(ctx.schema.syndicates).where(eq(ctx.schema.syndicates.id, t)))[0].id;
    for (const code of ['B1', 'B2']) await ctx.db.insert(ctx.schema.branches).values({ name: `${code} ${stamp}`, code: `${code}${stamp}${++seq}`, syndicateId: sid } as never);
    const p = (await sa('GET', `/platform/tenants/${t}/plan-preview?plan=${small.code}`)).json();
    expect(p.fitsBranches).toBe(false);
    expect(p.warnings.join(' ')).toMatch(/2 branches/);
    const r = await sa('POST', `/platform/tenants/${t}/plan`, { plan: small.code });
    expect(r.statusCode).toBe(422);
    expect((await tenant(t)).plan).toBe('PRO');
  });

  it('schedules a change for a later day, shows it, and can cancel it', async () => {
    const t = await newTenant('STANDARD');
    const day = addDaysIso(today, 5);
    const r = await sa('POST', `/platform/tenants/${t}/plan`, { plan: 'PRO', effectiveDate: day });
    expect(r.statusCode).toBe(200);
    expect(r.json().scheduled).toBe(true);
    expect(await tenant(t)).toMatchObject({ plan: 'STANDARD', nextPlan: 'PRO', nextPlanFrom: day });
    expect((await audit('tenant.plan_scheduled', t))[0].meta).toMatchObject({ after: { nextPlan: 'PRO', nextPlanFrom: day } });

    expect((await sa('DELETE', `/platform/tenants/${t}/plan/scheduled`)).statusCode).toBe(200);
    expect(await tenant(t)).toMatchObject({ plan: 'STANDARD', nextPlan: null, nextPlanFrom: null });
    expect((await sa('DELETE', `/platform/tenants/${t}/plan/scheduled`)).statusCode).toBe(422);
  });

  it('applies a scheduled change once its day has come, the next time businesses are read', async () => {
    const t = await newTenant('STANDARD');
    await sa('POST', `/platform/tenants/${t}/plan`, { plan: 'PRO', effectiveDate: addDaysIso(today, 3) });
    await ctx.db.update(ctx.schema.syndicates).set({ nextPlanFrom: addDaysIso(today, -1) }).where(eq(ctx.schema.syndicates.id, t));   // the day arrived
    const after = await tenant(t);                                           // reading the list applies it
    expect(after).toMatchObject({ plan: 'PRO', maxBranches: 25, nextPlan: null });
    expect((await audit('tenant.plan_schedule_applied', t))).toHaveLength(1);
  });

  it('drops a scheduled change that can no longer happen, and records why', async () => {
    const plan = await newPlan({ price: '900' });
    const t = await newTenant('STANDARD');
    expect((await sa('POST', `/platform/tenants/${t}/plan`, { plan: plan.code, effectiveDate: addDaysIso(today, 4) })).json().scheduled).toBe(true);
    await sa('POST', `/platform/plans/${plan.code}/retire`);                   // retired before the day
    await ctx.db.update(ctx.schema.syndicates).set({ nextPlanFrom: today }).where(eq(ctx.schema.syndicates.id, t));
    expect(await tenant(t)).toMatchObject({ plan: 'STANDARD', nextPlan: null });
    expect((await audit('tenant.plan_schedule_failed', t))[0].meta).toMatchObject({ plan: plan.code, reason: 'plan was retired' });
  });

  it('is for the Super Admin only', async () => {
    const t = await newTenant('STANDARD');
    for (const [m, path] of [['GET', `/platform/tenants/${t}/plan-preview?plan=PRO`], ['POST', `/platform/tenants/${t}/plan`], ['DELETE', `/platform/tenants/${t}/plan/scheduled`]] as const) {
      expect((await inject(m, path, ctx.auth('owner'), { plan: 'PRO' })).statusCode).toBe(403);
      expect((await ctx.app.inject({ method: m, url: `/api/v1${path}` })).statusCode).toBe(401);
    }
  });
});
