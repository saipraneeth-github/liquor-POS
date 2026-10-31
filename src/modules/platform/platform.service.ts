/**
 * platform.service.ts — SaaS back office for the Super Admin (platform owner): tenants (bar businesses),
 * their plan and branch limit, suspension, and usage. A tenant is a `syndicates` row; its Admin is an
 * owner user scoped to that syndicate.
 */

import { z } from 'zod';
import { and, count, eq, gte, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { auditLog, bills, branches, subscriptionInvoices, syndicates, users } from '../../db/schema.js';
import { randomInt } from 'node:crypto';
import { accessState } from './access.engine.js';
import { logAudit } from '../../lib/audit.js';
import { BusinessRuleError, ConflictError, NotFoundError, isUniqueViolation } from '../../lib/errors.js';
import { hashPassword } from '../auth/auth.service.js';

// ─── PLANS ──────────────────────────────────────────────────────────────────

export const PLANS = ['TRIAL', 'STANDARD', 'PRO'] as const;
export type Plan = (typeof PLANS)[number];

/** Default branch allowance per plan (the Super Admin can override per tenant). */
export const PLAN_BRANCH_LIMITS: Record<Plan, number> = { TRIAL: 1, STANDARD: 3, PRO: 25 };

/** Monthly price per plan in rupees, GST included. TRIAL is free. */
export const PLAN_PRICES: Record<Plan, string> = { TRIAL: '0.00', STANDARD: '2999.00', PRO: '7999.00' };
export const TRIAL_DAYS = 14;
const DAY = 86_400_000;

export function branchLimitFor(plan: Plan, override?: number): number {
  return override ?? PLAN_BRANCH_LIMITS[plan];
}

/** Throws when the tenant already has as many branches as its plan allows. */
export function assertWithinBranchLimit(currentBranches: number, maxBranches: number): void {
  if (currentBranches >= maxBranches) {
    throw new BusinessRuleError(
      `Plan limit reached: this plan allows ${maxBranches} branch${maxBranches === 1 ? '' : 'es'}. Contact support to upgrade.`,
    );
  }
}

// ─── SCHEMAS ────────────────────────────────────────────────────────────────

const GSTIN = z.string().trim().toUpperCase().regex(/^[0-9A-Z]{15}$/, 'GSTIN must be 15 alphanumeric characters');
const PAN = z.string().trim().toUpperCase().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Invalid PAN');
const NAME = z.string().trim().min(1).max(200).refine((s) => !/[<>]/.test(s), 'Must not contain < or >');

export const CreateTenantSchema = z.object({
  name:         NAME,
  gstin:        GSTIN.optional(),
  pan:          PAN.optional(),
  contactPhone: z.string().trim().min(6).max(20).optional(),
  plan:         z.enum(PLANS).default('TRIAL'),
  maxBranches:  z.number().int().min(1).max(500).optional(),
  admin: z.object({
    name:     NAME,
    email:    z.string().trim().toLowerCase().email(),
    password: z.string().min(8).max(100),
  }),
});

export const UpdateTenantSchema = z.object({
  name:         NAME.optional(),
  gstin:        GSTIN.nullable().optional(),
  contactPhone: z.string().trim().min(6).max(20).nullable().optional(),
  plan:         z.enum(PLANS).optional(),
  maxBranches:  z.number().int().min(1).max(500).optional(),
  isActive:     z.boolean().optional(),
  // Support: extend a trial or a paid period by hand (ISO date-time)
  trialEndsAt:  z.string().datetime().transform((v) => new Date(v)).nullable().optional(),
  paidUntil:    z.string().datetime().transform((v) => new Date(v)).nullable().optional(),
}).refine((d) => Object.keys(d).length > 0, 'At least one field is required');

export type CreateTenantInput = z.infer<typeof CreateTenantSchema>;
export type UpdateTenantInput = z.infer<typeof UpdateTenantSchema>;

// ─── QUERIES ────────────────────────────────────────────────────────────────

const THIRTY_DAYS = 30 * 86_400_000;

export async function listTenants() {
  const tenants = await db.select().from(syndicates).orderBy(syndicates.name);
  if (tenants.length === 0) return [];
  const ids = tenants.map((t) => t.id);
  const since = new Date(Date.now() - THIRTY_DAYS);

  const branchCounts = await db
    .select({ syndicateId: branches.syndicateId, n: count() })
    .from(branches).where(inArray(branches.syndicateId, ids)).groupBy(branches.syndicateId);

  const staffCounts = await db
    .select({ syndicateId: branches.syndicateId, n: count() })
    .from(users).innerJoin(branches, eq(users.branchId, branches.id))
    .where(and(inArray(branches.syndicateId, ids), eq(users.isActive, true))).groupBy(branches.syndicateId);

  const sales = await db
    .select({
      syndicateId: branches.syndicateId,
      bills: sql<number>`count(*)::int`,
      total: sql<string>`coalesce(sum(${bills.total}), 0)::numeric(14,2)::text`,
      lastBillAt: sql<string | null>`max(${bills.createdAt})`,
    })
    .from(bills).innerJoin(branches, eq(bills.branchId, branches.id))
    .where(and(inArray(branches.syndicateId, ids), eq(bills.status, 'PAID'), gte(bills.createdAt, since)))
    .groupBy(branches.syndicateId);

  const admins = await db
    .select({ id: users.id, syndicateId: users.syndicateId, name: users.name, email: users.email, isActive: users.isActive })
    .from(users).where(and(inArray(users.syndicateId, ids), eq(users.role, 'owner')));

  const by = <T extends { syndicateId: string | null }>(rows: T[]) => new Map(rows.map((r) => [r.syndicateId, r]));
  const bc = by(branchCounts); const sc = by(staffCounts); const sl = by(sales);

  return tenants.map((t) => ({
    ...t,
    access: accessState(t),
    branchCount: Number(bc.get(t.id)?.n ?? 0),
    staffCount: Number(sc.get(t.id)?.n ?? 0),
    bills30d: sl.get(t.id)?.bills ?? 0,
    sales30d: sl.get(t.id)?.total ?? '0.00',
    lastBillAt: sl.get(t.id)?.lastBillAt ?? null,
    admins: admins.filter((a) => a.syndicateId === t.id).map(({ id, name, email, isActive }) => ({ id, name, email, isActive })),
  }));
}

export async function platformOverview() {
  const tenants = await listTenants();
  const sum = (f: (t: (typeof tenants)[number]) => number) => tenants.reduce((s, t) => s + f(t), 0);
  return {
    tenants: tenants.length,
    activeTenants: tenants.filter((t) => t.isActive).length,
    suspendedTenants: tenants.filter((t) => !t.isActive).length,
    trialTenants: tenants.filter((t) => t.plan === 'TRIAL').length,
    branches: sum((t) => t.branchCount),
    staff: sum((t) => t.staffCount),
    bills30d: sum((t) => t.bills30d),
    sales30d: tenants.reduce((s, t) => s + Number(t.sales30d), 0).toFixed(2),
  };
}

/** What a tenant Admin sees about their own subscription. */
export async function tenantSummary(syndicateId: string) {
  const [tenant] = await db.select().from(syndicates).where(eq(syndicates.id, syndicateId)).limit(1);
  if (!tenant) throw new NotFoundError('Business not found');
  const [{ n }] = await db.select({ n: count() }).from(branches).where(eq(branches.syndicateId, syndicateId));
  return {
    id: tenant.id, name: tenant.name, plan: tenant.plan, isActive: tenant.isActive,
    maxBranches: tenant.maxBranches, branchCount: Number(n),
    trialEndsAt: tenant.trialEndsAt, paidUntil: tenant.paidUntil, access: accessState(tenant),
    price: PLAN_PRICES[tenant.plan as Plan] ?? '0.00',
  };
}

// ─── COMMANDS ───────────────────────────────────────────────────────────────

/** Creates the tenant and its first Admin (owner scoped to the tenant) in one transaction. */
export async function createTenant(input: CreateTenantInput) {
  const passwordHash = await hashPassword(input.admin.password);
  try {
    return await db.transaction(async (tx) => {
      const [tenant] = await tx.insert(syndicates).values({
        name: input.name,
        gstin: input.gstin,
        pan: input.pan,
        contactPhone: input.contactPhone,
        plan: input.plan,
        maxBranches: branchLimitFor(input.plan, input.maxBranches),
        // Trial runs for 14 days; a paid plan starts with a 30 day courtesy period until the first invoice is paid
        trialEndsAt: input.plan === 'TRIAL' ? new Date(Date.now() + TRIAL_DAYS * DAY) : null,
        paidUntil: input.plan === 'TRIAL' ? null : new Date(Date.now() + 30 * DAY),
      }).returning();
      const [admin] = await tx.insert(users).values({
        name: input.admin.name,
        email: input.admin.email,
        passwordHash,
        role: 'owner',
        branchId: null,
        syndicateId: tenant.id,
      }).returning({ id: users.id, email: users.email, name: users.name });
      return { tenant, admin };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError('A user with this email already exists');
    throw err;
  }
}

export async function updateTenant(id: string, input: UpdateTenantInput) {
  const patch: Partial<typeof syndicates.$inferInsert> = { ...input };
  // Moving plan without an explicit limit adopts that plan's default allowance
  if (input.plan && input.maxBranches === undefined) patch.maxBranches = PLAN_BRANCH_LIMITS[input.plan];
  if (input.plan) {
    const [current] = await db.select().from(syndicates).where(eq(syndicates.id, id)).limit(1);
    // Moving off the trial starts a 30 day courtesy period; extending the trial needs the Super Admin to edit the date directly
    if (current && input.plan !== 'TRIAL' && !current.paidUntil) patch.paidUntil = new Date(Date.now() + 30 * DAY);
    if (current && input.plan === 'TRIAL' && !current.trialEndsAt) patch.trialEndsAt = new Date(Date.now() + TRIAL_DAYS * DAY);
  }
  const [row] = await db.update(syndicates).set(patch).where(eq(syndicates.id, id)).returning();
  if (!row) throw new NotFoundError('Tenant not found');
  return row;
}

/** Branch count used when creating a branch under a tenant. */
export async function branchCountOf(syndicateId: string): Promise<{ count: number; max: number }> {
  const [tenant] = await db.select({ max: syndicates.maxBranches }).from(syndicates).where(eq(syndicates.id, syndicateId)).limit(1);
  const [{ n }] = await db.select({ n: count() }).from(branches).where(eq(branches.syndicateId, syndicateId));
  return { count: Number(n), max: tenant?.max ?? PLAN_BRANCH_LIMITS.TRIAL };
}

// ─── SUBSCRIPTION INVOICES ──────────────────────────────────────────────────

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export async function listInvoices(syndicateId: string) {
  return db.select().from(subscriptionInvoices)
    .where(eq(subscriptionInvoices.syndicateId, syndicateId))
    .orderBy(sql`${subscriptionInvoices.periodStart} desc`);
}

/** Next 30 day period, starting when the current paid period ends (or today). One unpaid invoice at a time. */
export async function generateInvoice(syndicateId: string, actorId: string | null, forPlan?: Plan) {
  const [tenant] = await db.select().from(syndicates).where(eq(syndicates.id, syndicateId)).limit(1);
  if (!tenant) throw new NotFoundError('Tenant not found');
  const plan = (forPlan ?? tenant.plan) as Plan;
  if (PLAN_PRICES[plan] === '0.00') throw new BusinessRuleError('The trial plan is free: move the tenant to a paid plan first');

  const [open] = await db.select({ id: subscriptionInvoices.id }).from(subscriptionInvoices)
    .where(and(eq(subscriptionInvoices.syndicateId, syndicateId), eq(subscriptionInvoices.status, 'PENDING'))).limit(1);
  if (open) throw new ConflictError('There is already an unpaid invoice for this tenant');

  // A renewal continues from the end of the paid period; the first invoice after a trial starts today
  const start = tenant.plan !== 'TRIAL' && tenant.paidUntil && tenant.paidUntil.getTime() > Date.now() ? tenant.paidUntil : new Date();
  const end = new Date(start.getTime() + 30 * DAY);
  const [inv] = await db.insert(subscriptionInvoices).values({
    syndicateId, plan, amount: PLAN_PRICES[plan], periodStart: isoDay(start), periodEnd: isoDay(end),
  }).returning();
  await logAudit(actorId, 'invoice.generate', { type: 'tenant', id: syndicateId }, { invoiceId: inv.id, amount: inv.amount });
  return inv;
}

/** Records a payment received outside the app (bank transfer / UPI / cheque) and extends access. */
export async function markInvoicePaid(invoiceId: string, paymentRef: string, actorId: string | null) {
  return db.transaction(async (tx) => {
    const [inv] = await tx.update(subscriptionInvoices)
      .set({ status: 'PAID', paidAt: new Date(), paymentRef })
      .where(and(eq(subscriptionInvoices.id, invoiceId), eq(subscriptionInvoices.status, 'PENDING')))
      .returning();
    if (!inv) throw new BusinessRuleError('Invoice not found or already settled');
    const paidThrough = new Date(`${inv.periodEnd}T23:59:59.000Z`);
    const [tenant] = await tx.select({ paidUntil: syndicates.paidUntil, plan: syndicates.plan }).from(syndicates).where(eq(syndicates.id, inv.syndicateId)).for('update');
    if (tenant && tenant.plan !== inv.plan && PLANS.includes(inv.plan as Plan)) {
      // Paying for another plan is what switches to it (a trial becomes Standard / Pro here)
      const [{ n }] = await tx.select({ n: count() }).from(branches).where(eq(branches.syndicateId, inv.syndicateId));
      await tx.update(syndicates).set({
        plan: inv.plan,
        maxBranches: Math.max(PLAN_BRANCH_LIMITS[inv.plan as Plan], Number(n)),
        paidUntil: paidThrough,
      }).where(eq(syndicates.id, inv.syndicateId));
    } else if (!tenant?.paidUntil || tenant.paidUntil.getTime() < paidThrough.getTime()) {
      await tx.update(syndicates).set({ paidUntil: paidThrough }).where(eq(syndicates.id, inv.syndicateId));
    }
    await tx.insert(auditLog).values({
      actorId, action: 'invoice.paid', targetType: 'tenant', targetId: inv.syndicateId, meta: { invoiceId, paymentRef },
    });
    return inv;
  });
}

// ─── SUPPORT: ADMIN PASSWORDS AND SIGN-IN AS ───────────────────────────────

/** 12 characters from an unambiguous alphabet (no 0/O, 1/l/I). */
export function temporaryPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return Array.from({ length: 12 }, () => alphabet[randomInt(alphabet.length)]).join('');
}

export async function tenantAdmins(syndicateId: string) {
  return db.select({ id: users.id, name: users.name, email: users.email, isActive: users.isActive })
    .from(users).where(and(eq(users.syndicateId, syndicateId), eq(users.role, 'owner')));
}

export async function resetTenantAdminPassword(syndicateId: string, userId: string, actorId: string | null) {
  const [admin] = await db.select({ id: users.id, email: users.email }).from(users)
    .where(and(eq(users.id, userId), eq(users.syndicateId, syndicateId), eq(users.role, 'owner'))).limit(1);
  if (!admin) throw new NotFoundError('Admin not found for this tenant');
  const password = temporaryPassword();
  await db.update(users).set({ passwordHash: await hashPassword(password) }).where(eq(users.id, admin.id));
  await logAudit(actorId, 'admin.password_reset', { type: 'user', id: admin.id });
  return { email: admin.email, temporaryPassword: password };
}

export async function recentAudit(limit = 50) {
  return db.select({
    id: auditLog.id, action: auditLog.action, targetType: auditLog.targetType, targetId: auditLog.targetId,
    meta: auditLog.meta, createdAt: auditLog.createdAt, actor: users.name,
  }).from(auditLog).leftJoin(users, eq(auditLog.actorId, users.id))
    .orderBy(sql`${auditLog.createdAt} desc`).limit(limit);
}

// ─── SELF-SERVICE PLAN CHANGE ───────────────────────────────────────────────

/**
 * An Admin picks a paid plan for their own business. This only raises the invoice for that plan; the business
 * moves to the plan when the invoice is paid (see markInvoicePaid), so choosing never grants free days.
 * The plan must have room for the branches already in use.
 */
export async function changePlanSelfService(syndicateId: string, plan: Plan, actorId: string | null) {
  if (!PLANS.includes(plan) || plan === 'TRIAL') throw new BusinessRuleError('Choose Standard or Pro');
  const [tenant] = await db.select().from(syndicates).where(eq(syndicates.id, syndicateId)).limit(1);
  if (!tenant) throw new NotFoundError('Business not found');

  const [{ n }] = await db.select({ n: count() }).from(branches).where(eq(branches.syndicateId, syndicateId));
  const limit = PLAN_BRANCH_LIMITS[plan];
  if (Number(n) > limit) {
    throw new BusinessRuleError(`You have ${n} branches; the ${plan} plan allows ${limit}. Choose a bigger plan or contact support.`);
  }

  await logAudit(actorId, 'tenant.plan_requested', { type: 'tenant', id: syndicateId }, { from: tenant.plan, to: plan });

  // Reuse an unpaid invoice of the same plan, otherwise void it and raise one for the new plan
  const [open] = await db.select().from(subscriptionInvoices)
    .where(and(eq(subscriptionInvoices.syndicateId, syndicateId), eq(subscriptionInvoices.status, 'PENDING'))).limit(1);
  if (open && open.plan === plan) return open;
  if (open) await db.update(subscriptionInvoices).set({ status: 'VOID' }).where(eq(subscriptionInvoices.id, open.id));
  return generateInvoice(syndicateId, actorId, plan);
}
