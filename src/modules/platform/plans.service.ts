/**
 * plans.service.ts — the plan catalog the Super Admin sells, and moving businesses between plans.
 *
 * `syndicates.plan` stores a plan code. TRIAL always exists (free, time-limited). A retired plan can no longer be
 * picked, but businesses already on it keep it and keep being billed its price.
 */
import { z } from 'zod';
import { and, asc, count, eq, isNotNull, lte, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { branches, saasPlans, subscriptionInvoices, syndicates } from '../../db/schema.js';
import { BusinessRuleError, ConflictError, NotFoundError } from '../../lib/errors.js';
import { businessDateOf } from '../../lib/business-day.js';
import { logAudit } from '../../lib/audit.js';
import { addDaysIso, CYCLES, monthlyEquivalent, planCodeFromName, prorate } from './plans.engine.js';

export type PlanRow = typeof saasPlans.$inferSelect;
export const TRIAL = 'TRIAL';
const DAY = 86_400_000;
const MAX_DAYS_AHEAD = 90;

// ─── CATALOG ────────────────────────────────────────────────────────────────

const PRICE = z.string().trim().regex(/^\d{1,6}(\.\d{1,2})?$/, 'Enter an amount like 2999 or 2999.50');
const FEATURES = z.array(z.string().trim().min(1).max(80)).max(12, 'At most 12 features');

export const CreatePlanSchema = z.object({
  name: z.string().trim().min(3, 'Use at least 3 characters').max(40, 'Use at most 40 characters'),
  price: PRICE.refine((v) => Number(v) > 0, 'A paid plan needs a price above zero'),
  cycleDays: z.number().int().refine((v) => (CYCLES as readonly number[]).includes(v), 'Choose monthly, quarterly or yearly'),
  maxBranches: z.number().int().min(1).max(500),
  features: FEATURES.default([]),
});
export const UpdatePlanSchema = z.object({
  name: z.string().trim().min(3).max(40).optional(),
  price: PRICE.optional(),
  cycleDays: z.number().int().refine((v) => (CYCLES as readonly number[]).includes(v), 'Choose monthly, quarterly or yearly').optional(),
  maxBranches: z.number().int().min(1).max(500).optional(),
  features: FEATURES.optional(),
}).refine((d) => Object.keys(d).length > 0, 'At least one field is required');
export const ActivePlanSchema = z.object({ isActive: z.boolean() });

export async function getPlan(code: string): Promise<PlanRow | null> {
  const [p] = await db.select().from(saasPlans).where(eq(saasPlans.code, code)).limit(1);
  return p ?? null;
}

/** Loads a plan or says why it cannot be used. `active` refuses a retired plan; `paid` refuses the trial. */
export async function requirePlan(code: string, opts: { active?: boolean; paid?: boolean } = {}): Promise<PlanRow> {
  const p = await getPlan(code);
  if (!p) throw new NotFoundError('Plan not found');
  if (opts.active && !p.isActive) throw new BusinessRuleError(`${p.name} has been retired and cannot be chosen`);
  if (opts.paid && p.code === TRIAL) throw new BusinessRuleError('Choose a paid plan');
  return p;
}

/** Every plan with how many businesses are on it. Retired ones are included unless asked otherwise. */
export async function listPlans(opts: { includeRetired?: boolean } = { includeRetired: true }) {
  const rows = await db.select().from(saasPlans)
    .where(opts.includeRetired === false ? eq(saasPlans.isActive, true) : undefined)
    .orderBy(asc(saasPlans.sortOrder), asc(saasPlans.name));
  const counts = await db.select({ plan: syndicates.plan, n: count() }).from(syndicates).groupBy(syndicates.plan);
  return rows.map((p) => ({ ...p, tenantCount: Number(counts.find((c) => c.plan === p.code)?.n ?? 0) }));
}

/** Price per month for every plan, whatever its billing cycle: the basis of the recurring-revenue figure. */
export async function monthlyPrices(): Promise<Record<string, string>> {
  const rows = await db.select().from(saasPlans);
  return Object.fromEntries(rows.map((p) => [p.code, monthlyEquivalent(p.price, p.cycleDays)]));
}

const snapshot = (p: PlanRow) => ({ name: p.name, price: p.price, cycleDays: p.cycleDays, maxBranches: p.maxBranches, features: p.features, isActive: p.isActive });

export async function createPlan(actorId: string | null, input: z.infer<typeof CreatePlanSchema>) {
  // A readable, stable code; add a number if the name has been used before
  const base = planCodeFromName(input.name);
  let code = base === TRIAL ? 'TRIAL_2' : base;
  for (let n = 2; await getPlan(code); n++) code = `${base.slice(0, 17)}_${n}`;
  const [{ top }] = await db.select({ top: sql<number>`coalesce(max(${saasPlans.sortOrder}), 0)::int` }).from(saasPlans);
  const [row] = await db.insert(saasPlans).values({
    code, name: input.name, price: Number(input.price).toFixed(2), cycleDays: input.cycleDays, maxBranches: input.maxBranches,
    features: input.features, sortOrder: top + 10,
  }).returning();
  await logAudit(actorId, 'plan.create', { type: 'plan', id: row.code }, { after: snapshot(row) });
  return row;
}

/**
 * A new price or limit applies to invoices raised afterwards and to businesses that move to the plan afterwards.
 * Invoices already raised, and the branch limit already set on a business, are left alone.
 */
export async function updatePlan(actorId: string | null, code: string, input: z.infer<typeof UpdatePlanSchema>) {
  const before = await requirePlan(code);
  if (code === TRIAL && ((input.price !== undefined && Number(input.price) !== 0) || (input.cycleDays !== undefined && input.cycleDays !== before.cycleDays))) {
    throw new BusinessRuleError('The trial is always free, so its price and billing cycle cannot be changed');
  }
  if (code !== TRIAL && input.price !== undefined && Number(input.price) <= 0) throw new BusinessRuleError('A paid plan needs a price above zero');
  const [row] = await db.update(saasPlans).set({
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.price !== undefined ? { price: Number(input.price).toFixed(2) } : {}),
    ...(input.cycleDays !== undefined ? { cycleDays: input.cycleDays } : {}),
    ...(input.maxBranches !== undefined ? { maxBranches: input.maxBranches } : {}),
    ...(input.features !== undefined ? { features: input.features } : {}),
    updatedAt: new Date(),
  }).where(eq(saasPlans.code, code)).returning();
  await logAudit(actorId, 'plan.update', { type: 'plan', id: code }, { before: snapshot(before), after: snapshot(row) });
  return row;
}

/** Retire (stop selling) or bring back a plan. Never deletes: businesses may be on it, and old invoices name it. */
export async function setPlanActive(actorId: string | null, code: string, isActive: boolean) {
  const before = await requirePlan(code);
  if (code === TRIAL && !isActive) throw new BusinessRuleError('The trial plan cannot be retired');
  if (before.isActive === isActive) return before;
  const [row] = await db.update(saasPlans).set({ isActive, updatedAt: new Date() }).where(eq(saasPlans.code, code)).returning();
  await logAudit(actorId, isActive ? 'plan.reactivate' : 'plan.retire', { type: 'plan', id: code }, { before: { isActive: before.isActive }, after: { isActive } });
  return row;
}

// ─── MOVING A BUSINESS TO ANOTHER PLAN ──────────────────────────────────────

type Tenant = typeof syndicates.$inferSelect;

async function loadTenant(id: string): Promise<Tenant> {
  const [t] = await db.select().from(syndicates).where(eq(syndicates.id, id)).limit(1);
  if (!t) throw new NotFoundError('Tenant not found');
  return t;
}
const branchesInUse = async (syndicateId: string) => {
  const [{ n }] = await db.select({ n: count() }).from(branches).where(eq(branches.syndicateId, syndicateId));
  return Number(n);
};

/** The numbers behind a plan change on a given day. Pure of side effects. */
async function computeChange(tenant: Tenant, target: PlanRow, effective: string) {
  const current = await getPlan(tenant.plan);
  // Credit is for money actually received: the 30 day courtesy a new paid plan starts with is not a paid period
  const [{ n: paidInvoices }] = await db.select({ n: count() }).from(subscriptionInvoices)
    .where(and(eq(subscriptionInvoices.syndicateId, tenant.id), eq(subscriptionInvoices.status, 'PAID')));
  const currentPaid = !!current && tenant.plan !== TRIAL && Number(current.price) > 0 && tenant.paidUntil !== null && Number(paidInvoices) > 0;
  const p = prorate({
    currentPaid, currentPrice: current?.price ?? '0', currentCycleDays: current?.cycleDays ?? 30, paidUntil: tenant.paidUntil,
    effective, targetPrice: target.price, targetCycleDays: target.cycleDays,
  });
  const inUse = await branchesInUse(tenant.id);
  const warnings: string[] = [];
  const fitsBranches = inUse <= target.maxBranches;
  if (!fitsBranches) warnings.push(`This business has ${inUse} branches; ${target.name} allows ${target.maxBranches}.`);
  if (tenant.plan === target.code) warnings.push(`This business is already on ${target.name}.`);
  if (Number(p.amountDue) === 0 && Number(target.price) > 0) warnings.push('The unused time on the current plan covers the whole new price: nothing to pay.');
  return {
    current: current ? { code: current.code, name: current.name, price: current.price, cycleDays: current.cycleDays } : { code: tenant.plan, name: tenant.plan, price: '0.00', cycleDays: 30 },
    target: { code: target.code, name: target.name, price: target.price, cycleDays: target.cycleDays, maxBranches: target.maxBranches },
    effectiveDate: effective, paidUntil: tenant.paidUntil, currentPaid,
    ...p, branchesInUse: inUse, fitsBranches, sameAsCurrent: tenant.plan === target.code, warnings,
  };
}
export type PlanChangePreview = Awaited<ReturnType<typeof computeChange>>;

function checkEffectiveDate(effective: string): void {
  const today = businessDateOf();
  if (effective < today) throw new BusinessRuleError('The effective date cannot be in the past');
  if (effective > addDaysIso(today, MAX_DAYS_AHEAD)) throw new BusinessRuleError(`The effective date can be at most ${MAX_DAYS_AHEAD} days ahead`);
}

/** What changing this business to `code` on `effective` would cost, before anyone confirms it. */
export async function previewPlanChange(syndicateId: string, code: string, effective?: string): Promise<PlanChangePreview> {
  const eff = effective ?? businessDateOf();
  checkEffectiveDate(eff);
  const target = await requirePlan(code, { active: true, paid: true });
  return computeChange(await loadTenant(syndicateId), target, eff);
}

export const AssignPlanSchema = z.object({
  plan: z.string().trim().toUpperCase().min(2).max(30),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/** Switches the business now: voids any unpaid invoice, raises one for what is due (if anything) and sets the plan and limit. */
async function applyChange(tenant: Tenant, target: PlanRow, effective: string, actorId: string | null, how: 'assigned' | 'scheduled_applied') {
  const preview = await computeChange(tenant, target, effective);
  const due = Number(preview.amountDue);
  await db.transaction(async (tx) => {
    await tx.update(subscriptionInvoices).set({ status: 'VOID' })
      .where(and(eq(subscriptionInvoices.syndicateId, tenant.id), eq(subscriptionInvoices.status, 'PENDING')));
    if (due > 0) {
      await tx.insert(subscriptionInvoices).values({
        syndicateId: tenant.id, plan: target.code, amount: preview.amountDue, periodStart: preview.periodStart, periodEnd: preview.periodEnd,
      });
    }
    await tx.update(syndicates).set({
      plan: target.code, maxBranches: target.maxBranches, nextPlan: null, nextPlanFrom: null,
      // Fully covered by credit: access runs to the end of the new period. Otherwise the business keeps the time it has,
      // with a 30 day courtesy if it had none, until the new invoice is paid.
      paidUntil: due === 0 ? new Date(`${preview.periodEnd}T23:59:59.000Z`) : (tenant.paidUntil ?? new Date(Date.now() + 30 * DAY)),
    }).where(eq(syndicates.id, tenant.id));
  });
  await logAudit(actorId, how === 'assigned' ? 'tenant.plan_assigned' : 'tenant.plan_schedule_applied', { type: 'tenant', id: tenant.id }, {
    before: { plan: tenant.plan, maxBranches: tenant.maxBranches, paidUntil: tenant.paidUntil },
    after: { plan: target.code, maxBranches: target.maxBranches },
    effectiveDate: effective, credit: preview.credit, amountDue: preview.amountDue,
  });
  return preview;
}

/** Super Admin: put a business on a plan today, or schedule it for a later day (up to 90 days ahead). */
export async function assignPlan(actorId: string | null, syndicateId: string, input: z.infer<typeof AssignPlanSchema>) {
  const effective = input.effectiveDate ?? businessDateOf();
  checkEffectiveDate(effective);
  const target = await requirePlan(input.plan, { active: true, paid: true });
  const tenant = await loadTenant(syndicateId);
  if (tenant.archivedAt) throw new BusinessRuleError('This business is archived. Restore it before changing its plan.');
  const preview = await computeChange(tenant, target, effective);
  if (!preview.fitsBranches) throw new BusinessRuleError(preview.warnings[0]);
  if (preview.sameAsCurrent) throw new ConflictError(`This business is already on ${target.name}`);

  if (effective > businessDateOf()) {
    await db.update(syndicates).set({ nextPlan: target.code, nextPlanFrom: effective }).where(eq(syndicates.id, syndicateId));
    await logAudit(actorId, 'tenant.plan_scheduled', { type: 'tenant', id: syndicateId }, { before: { nextPlan: tenant.nextPlan, nextPlanFrom: tenant.nextPlanFrom }, after: { nextPlan: target.code, nextPlanFrom: effective } });
    return { scheduled: true as const, preview };
  }
  return { scheduled: false as const, preview: await applyChange(tenant, target, effective, actorId, 'assigned') };
}

export async function cancelScheduledPlan(actorId: string | null, syndicateId: string) {
  const tenant = await loadTenant(syndicateId);
  if (!tenant.nextPlan) throw new BusinessRuleError('No plan change is scheduled for this business');
  await db.update(syndicates).set({ nextPlan: null, nextPlanFrom: null }).where(eq(syndicates.id, syndicateId));
  await logAudit(actorId, 'tenant.plan_schedule_cancelled', { type: 'tenant', id: syndicateId }, { before: { nextPlan: tenant.nextPlan, nextPlanFrom: tenant.nextPlanFrom }, after: { nextPlan: null, nextPlanFrom: null } });
  return { cancelled: true };
}

/**
 * Scheduled changes whose day has come. Called wherever businesses are read or billed, so no separate clock is needed.
 * A change that can no longer happen (plan retired meanwhile, too many branches now) is dropped and recorded.
 */
export async function applyDuePlanChanges(syndicateId?: string): Promise<number> {
  const today = businessDateOf();
  const due = await db.select().from(syndicates)
    .where(and(isNotNull(syndicates.nextPlan), lte(syndicates.nextPlanFrom, today), syndicateId ? eq(syndicates.id, syndicateId) : undefined));
  let applied = 0;
  for (const t of due) {
    const target = await getPlan(t.nextPlan!);
    const fits = target ? (await branchesInUse(t.id)) <= target.maxBranches : false;
    if (!target || !target.isActive || !fits) {
      await db.update(syndicates).set({ nextPlan: null, nextPlanFrom: null }).where(eq(syndicates.id, t.id));
      await logAudit(null, 'tenant.plan_schedule_failed', { type: 'tenant', id: t.id }, {
        plan: t.nextPlan, reason: !target ? 'plan no longer exists' : !target.isActive ? 'plan was retired' : 'too many branches for the plan',
      });
      continue;
    }
    await applyChange(t, target, t.nextPlanFrom!, null, 'scheduled_applied');
    applied++;
  }
  return applied;
}
