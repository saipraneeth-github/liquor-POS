/**
 * platform.service.ts — SaaS back office for the Super Admin (platform owner): tenants (bar businesses),
 * their plan and branch limit, suspension, and usage. A tenant is a `syndicates` row; its Admin is an
 * owner user scoped to that syndicate.
 */

import { z } from 'zod';
import { alias } from 'drizzle-orm/pg-core';
import { and, count, eq, gte, ilike, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { auditLog, bills, branches, roles, saasPlans, subscriptionInvoices, syndicates, users } from '../../db/schema.js';
import { randomInt } from 'node:crypto';
import { accessState } from './access.engine.js';
import { healthScore, percentChange, queueFlags, recurringRevenue, revenueByMonth, type InsightTenant } from './insights.engine.js';
import { logAudit } from '../../lib/audit.js';
import { BusinessRuleError, ConflictError, NotFoundError, isUniqueViolation } from '../../lib/errors.js';
import { hashPassword } from '../auth/auth.service.js';
import { TRIAL, applyDuePlanChanges, getPlan, listPlans, monthlyPrices, requirePlan } from './plans.service.js';
import { monthlyEquivalent } from './plans.engine.js';

// ─── PLANS ──────────────────────────────────────────────────────────────────

// Plans (name, price, billing cycle, branch limit) live in the saas_plans table: see plans.service.ts.
export type Plan = string;
export const TRIAL_DAYS = 14;
const DAY = 86_400_000;

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
const PLAN_CODE = z.string().trim().toUpperCase().min(2).max(30);
const NAME = z.string().trim().min(1).max(200).refine((s) => !/[<>]/.test(s), 'Must not contain < or >');

export const CreateTenantSchema = z.object({
  name:         NAME,
  gstin:        GSTIN.optional(),
  pan:          PAN.optional(),
  contactPhone: z.string().trim().min(6).max(20).optional(),
  plan:         PLAN_CODE.default(TRIAL),
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
  plan:         PLAN_CODE.optional(),
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
  await applyDuePlanChanges();
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

  const lastBills = await db
    .select({ syndicateId: branches.syndicateId, at: sql<string | null>`max(${bills.createdAt})` })
    .from(bills).innerJoin(branches, eq(bills.branchId, branches.id))
    .where(and(inArray(branches.syndicateId, ids), eq(bills.status, 'PAID'))).groupBy(branches.syndicateId);

  const by = <T extends { syndicateId: string | null }>(rows: T[]) => new Map(rows.map((r) => [r.syndicateId, r]));
  const bc = by(branchCounts); const sc = by(staffCounts); const sl = by(sales); const lb = by(lastBills);
  const now = new Date();

  return tenants.map((t) => {
    const access = accessState(t, now);
    const staffCount = Number(sc.get(t.id)?.n ?? 0);
    const bills30d = sl.get(t.id)?.bills ?? 0;
    const lastBillRaw = lb.get(t.id)?.at ?? null;
    const insight = {
      id: t.id, plan: t.plan, isActive: t.isActive, access, trialEndsAt: t.trialEndsAt, paidUntil: t.paidUntil,
      createdAt: t.createdAt, staffCount, bills30d, lastBillAt: lastBillRaw ? new Date(lastBillRaw) : null,
    };
    return {
      ...t,
      access,
      branchCount: Number(bc.get(t.id)?.n ?? 0),
      staffCount,
      bills30d,
      sales30d: sl.get(t.id)?.total ?? '0.00',
      lastBillAt: lastBillRaw,
      health: healthScore(insight, now),
      flags: queueFlags(insight, now),
      admins: admins.filter((a) => a.syndicateId === t.id).map(({ id, name, email, isActive }) => ({ id, name, email, isActive })),
    };
  });
}

/** Everything the Super Admin dashboard shows above the tenant table. */
export async function platformDashboard(now: Date = new Date()) {
  const tenants = (await listTenants()).filter((t) => !t.archivedAt);   // archived businesses are out of every figure
  const insights: InsightTenant[] = tenants.map((t) => ({
    id: t.id, plan: t.plan, isActive: t.isActive, access: t.access, trialEndsAt: t.trialEndsAt, paidUntil: t.paidUntil,
    createdAt: t.createdAt, staffCount: t.staffCount, bills30d: t.bills30d, lastBillAt: t.lastBillAt ? new Date(t.lastBillAt) : null,
  }));

  const since60 = new Date(now.getTime() - 60 * DAY);
  const since30 = new Date(now.getTime() - 30 * DAY);
  const [prev] = await db
    .select({ total: sql<string>`coalesce(sum(${bills.total}), 0)::numeric(14,2)::text` })
    .from(bills).innerJoin(branches, eq(bills.branchId, branches.id))
    .where(and(sql`${branches.syndicateId} is not null`, eq(bills.status, 'PAID'), gte(bills.createdAt, since60), lt(bills.createdAt, since30)));

  const pending = await db.select({ amount: subscriptionInvoices.amount }).from(subscriptionInvoices).where(eq(subscriptionInvoices.status, 'PENDING'));
  const paid = await db
    .select({ plan: subscriptionInvoices.plan, amount: subscriptionInvoices.amount, paidAt: subscriptionInvoices.paidAt })
    .from(subscriptionInvoices).where(eq(subscriptionInvoices.status, 'PAID'));

  const sales30d = tenants.reduce((s, t) => s + Number(t.sales30d), 0);
  const signedUp = tenants.filter((t) => t.createdAt && t.createdAt.getTime() >= since30.getTime());
  const queue = { trialEnding: [] as string[], overdue: [] as string[], quiet: [] as string[], suspended: [] as string[] };
  for (const t of tenants) for (const f of t.flags) queue[f].push(t.id);

  return {
    asOf: now.toISOString(),
    kpis: {
      mrr: recurringRevenue(insights, await monthlyPrices()),
      payingTenants: tenants.filter((t) => t.plan !== 'TRIAL' && t.isActive && t.access === 'OK').length,
      trialTenants: tenants.filter((t) => t.plan === 'TRIAL').length,
      outstanding: pending.reduce((s, r) => s + Number(r.amount), 0).toFixed(2),
      outstandingCount: pending.length,
      branches: tenants.reduce((s, t) => s + t.branchCount, 0),
      staff: tenants.reduce((s, t) => s + t.staffCount, 0),
      sales30d: sales30d.toFixed(2),
      salesChangePercent: percentChange(sales30d, Number(prev?.total ?? 0)),
    },
    plans: (await listPlans()).filter((p) => p.isActive || p.tenantCount > 0)
      .map((p) => ({ plan: p.code, name: p.name, price: monthlyEquivalent(p.price, p.cycleDays), count: tenants.filter((t) => t.plan === p.code).length })),
    revenueByMonth: revenueByMonth(paid, now),
    funnel: {
      signedUp: signedUp.length,
      billed: signedUp.filter((t) => t.lastBillAt).length,
      paying: signedUp.filter((t) => t.plan !== 'TRIAL').length,
    },
    queue: {
      trialEnding: { count: queue.trialEnding.length, ids: queue.trialEnding },
      overdue: { count: queue.overdue.length, ids: queue.overdue },
      quiet: { count: queue.quiet.length, ids: queue.quiet },
      suspended: { count: queue.suspended.length, ids: queue.suspended },
    },
  };
}

export async function platformOverview() {
  const tenants = (await listTenants()).filter((t) => !t.archivedAt);
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
  await applyDuePlanChanges(syndicateId);
  const [{ n }] = await db.select({ n: count() }).from(branches).where(eq(branches.syndicateId, syndicateId));
  const planRow = await getPlan(tenant.plan);
  return {
    id: tenant.id, name: tenant.name, plan: tenant.plan, planName: planRow?.name ?? tenant.plan, cycleDays: planRow?.cycleDays ?? 30, isActive: tenant.isActive,
    maxBranches: tenant.maxBranches, branchCount: Number(n),
    trialEndsAt: tenant.trialEndsAt, paidUntil: tenant.paidUntil, access: accessState(tenant),
    price: planRow?.price ?? '0.00',
  };
}

// ─── COMMANDS ───────────────────────────────────────────────────────────────

/** Creates the tenant and its first Admin (owner scoped to the tenant) in one transaction. */
export async function createTenant(input: CreateTenantInput) {
  const plan = await requirePlan(input.plan, { active: true });
  const passwordHash = await hashPassword(input.admin.password);
  try {
    return await db.transaction(async (tx) => {
      const [tenant] = await tx.insert(syndicates).values({
        name: input.name,
        gstin: input.gstin,
        pan: input.pan,
        contactPhone: input.contactPhone,
        plan: input.plan,
        maxBranches: input.maxBranches ?? plan.maxBranches,
        // Trial runs for 14 days; a paid plan starts with a 30 day courtesy period until the first invoice is paid
        trialEndsAt: input.plan === TRIAL ? new Date(Date.now() + TRIAL_DAYS * DAY) : null,
        paidUntil: input.plan === TRIAL ? null : new Date(Date.now() + 30 * DAY),
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

/** The fields a plan / access change can alter, for "before" in the audit trail. */
export async function tenantSnapshot(id: string) {
  const [t] = await db.select({
    plan: syndicates.plan, maxBranches: syndicates.maxBranches, isActive: syndicates.isActive, trialEndsAt: syndicates.trialEndsAt, paidUntil: syndicates.paidUntil,
  }).from(syndicates).where(eq(syndicates.id, id)).limit(1);
  return t ?? null;
}

export async function updateTenant(id: string, input: UpdateTenantInput) {
  const [existing] = await db.select({ archivedAt: syndicates.archivedAt }).from(syndicates).where(eq(syndicates.id, id)).limit(1);
  if (existing?.archivedAt && input.isActive === true) throw new BusinessRuleError('This business is archived. Restore it from the archive instead.');
  const patch: Partial<typeof syndicates.$inferInsert> = { ...input };
  if (input.plan) {
    const [current] = await db.select().from(syndicates).where(eq(syndicates.id, id)).limit(1);
    // Moving to a different plan needs a plan that is still on sale; staying on one that has been retired is fine
    const plan = await requirePlan(input.plan, { active: current?.plan !== input.plan });
    // Moving plan without an explicit limit adopts that plan's default allowance
    if (input.maxBranches === undefined) patch.maxBranches = plan.maxBranches;
    // Moving off the trial starts a 30 day courtesy period; extending the trial needs the Super Admin to edit the date directly
    if (current && input.plan !== TRIAL && !current.paidUntil) patch.paidUntil = new Date(Date.now() + 30 * DAY);
    if (current && input.plan === TRIAL && !current.trialEndsAt) patch.trialEndsAt = new Date(Date.now() + TRIAL_DAYS * DAY);
  }
  const [row] = await db.update(syndicates).set(patch).where(eq(syndicates.id, id)).returning();
  if (!row) throw new NotFoundError('Tenant not found');
  return row;
}

/** Branch count used when creating a branch under a tenant. */
export async function branchCountOf(syndicateId: string): Promise<{ count: number; max: number }> {
  const [tenant] = await db.select({ max: syndicates.maxBranches }).from(syndicates).where(eq(syndicates.id, syndicateId)).limit(1);
  const [{ n }] = await db.select({ n: count() }).from(branches).where(eq(branches.syndicateId, syndicateId));
  return { count: Number(n), max: tenant?.max ?? 1 };
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
  const planRow = await requirePlan(forPlan ?? tenant.plan);
  const plan = planRow.code;
  if (Number(planRow.price) === 0) throw new BusinessRuleError('The trial plan is free: move the tenant to a paid plan first');

  const [open] = await db.select({ id: subscriptionInvoices.id }).from(subscriptionInvoices)
    .where(and(eq(subscriptionInvoices.syndicateId, syndicateId), eq(subscriptionInvoices.status, 'PENDING'))).limit(1);
  if (open) throw new ConflictError('There is already an unpaid invoice for this tenant');

  // A renewal continues from the end of the paid period; the first invoice after a trial starts today
  const start = tenant.plan !== TRIAL && tenant.paidUntil && tenant.paidUntil.getTime() > Date.now() ? tenant.paidUntil : new Date();
  const end = new Date(start.getTime() + planRow.cycleDays * DAY);
  const [inv] = await db.insert(subscriptionInvoices).values({
    syndicateId, plan, amount: planRow.price, periodStart: isoDay(start), periodEnd: isoDay(end),
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
    // on the transaction's own connection: a query on the shared one would wait for this transaction to finish
    const [invoicePlan] = await tx.select().from(saasPlans).where(eq(saasPlans.code, inv.plan)).limit(1);
    if (tenant && tenant.plan !== inv.plan && invoicePlan) {
      // Paying for another plan is what switches to it (a trial becomes a paid plan here)
      const [{ n }] = await tx.select({ n: count() }).from(branches).where(eq(branches.syndicateId, inv.syndicateId));
      await tx.update(syndicates).set({
        plan: inv.plan,
        maxBranches: Math.max(invoicePlan.maxBranches, Number(n)),
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

// ─── USERS ACROSS ALL TENANTS ───────────────────────────────────────────────

export const ListUsersSchema = z.object({
  search: z.string().trim().max(80).optional(),
  role: z.enum(['owner', 'office_admin', 'manager', 'cashier', 'steward']).optional(),
  tenantId: z.string().uuid().optional(),
  status: z.enum(['active', 'inactive']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export const SetUserActiveSchema = z.object({ isActive: z.boolean() });

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);
/** The business a user belongs to: directly (an Admin) or through their branch. */
const tenantOfUser = sql`coalesce(${users.syndicateId}, ${branches.syndicateId})`;

export async function listPlatformUsers(q: z.infer<typeof ListUsersSchema>) {
  const conds: SQL[] = [];
  if (q.search) {
    const like = `%${escapeLike(q.search)}%`;
    conds.push(or(ilike(users.name, like), ilike(users.email, like))!);
  }
  if (q.role) conds.push(eq(users.role, q.role));
  if (q.status) conds.push(eq(users.isActive, q.status === 'active'));
  if (q.tenantId) conds.push(sql`${tenantOfUser} = ${q.tenantId}`);
  const where = conds.length ? and(...conds) : undefined;

  const rows = await db.select({
    id: users.id, name: users.name, email: users.email, role: users.role, roleName: roles.name, isActive: users.isActive,
    createdAt: users.createdAt, lastLoginAt: users.lastLoginAt, branch: branches.name,
    tenantId: sql<string | null>`${tenantOfUser}`, tenant: syndicates.name,
    isPlatformOwner: sql<boolean>`(${users.role} = 'owner' and ${users.branchId} is null and ${users.syndicateId} is null)`,
  }).from(users)
    .leftJoin(branches, eq(users.branchId, branches.id))
    .leftJoin(syndicates, eq(syndicates.id, tenantOfUser))
    .leftJoin(roles, eq(users.roleId, roles.id))
    .where(where)
    .orderBy(sql`${users.createdAt} desc`, users.name)
    .limit(q.limit).offset(q.offset);
  const [{ total }] = await db.select({ total: count() }).from(users)
    .leftJoin(branches, eq(users.branchId, branches.id)).where(where);
  return { users: rows, total: Number(total), limit: q.limit, offset: q.offset };
}

async function loadManageableUser(actorId: string, userId: string) {
  const [u] = await db.select({
    id: users.id, name: users.name, email: users.email, role: users.role, isActive: users.isActive,
    branchId: users.branchId, syndicateId: users.syndicateId,
  }).from(users).where(eq(users.id, userId)).limit(1);
  if (!u) throw new NotFoundError('User not found');
  if (u.id === actorId) throw new BusinessRuleError('You cannot do this to your own account');
  if (u.role === 'owner' && !u.branchId && !u.syndicateId) throw new BusinessRuleError('Platform owners cannot be changed from here');
  return u;
}

/** Switch an account off (or back on). Takes effect on the user's very next request: tokens are re-checked against the database. */
export async function setPlatformUserActive(actorId: string, userId: string, isActive: boolean) {
  const u = await loadManageableUser(actorId, userId);
  if (u.isActive === isActive) return { id: u.id, isActive };
  await db.update(users).set({ isActive }).where(eq(users.id, u.id));
  await logAudit(actorId, isActive ? 'user.activate' : 'user.deactivate', { type: 'user', id: u.id }, { email: u.email, before: { isActive: u.isActive }, after: { isActive } });
  return { id: u.id, isActive };
}

/** A temporary password for any tenant user, shown once to the Super Admin. */
export async function resetPlatformUserPassword(actorId: string, userId: string) {
  const u = await loadManageableUser(actorId, userId);
  const password = temporaryPassword();
  await db.update(users).set({ passwordHash: await hashPassword(password) }).where(eq(users.id, u.id));
  await logAudit(actorId, 'user.password_reset', { type: 'user', id: u.id }, { email: u.email });
  return { email: u.email, temporaryPassword: password };
}

// ─── AUDIT LOG ──────────────────────────────────────────────────────────────

export const AuditQuerySchema = z.object({
  actor: z.string().trim().max(80).optional(),                         // part of the actor's name or e-mail
  action: z.string().trim().max(80).optional(),                        // part of the action name, e.g. "user." or "tenant.suspend"
  tenantId: z.string().uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Filtered, paged audit trail. Read-only. The business is the actor's, or the target when the target is a business. */
export async function searchAudit(q: z.infer<typeof AuditQuerySchema>) {
  const actorBranch = alias(branches, 'actor_branch');
  const actorTenant = sql`coalesce(${users.syndicateId}, ${actorBranch.syndicateId})`;
  // What the event was about: a business itself, or one of its users (the Super Admin has no business of their own)
  const targetTenant = sql`(case
    when ${auditLog.targetType} in ('tenant', 'syndicate') then ${auditLog.targetId}::uuid
    when ${auditLog.targetType} = 'user' then (select coalesce(tu.syndicate_id, tb.syndicate_id) from users tu left join branches tb on tb.id = tu.branch_id where tu.id = ${auditLog.targetId}::uuid)
    when ${auditLog.targetType} = 'branch' then (select bb.syndicate_id from branches bb where bb.id = ${auditLog.targetId}::uuid)
  end)`;
  const eventTenant = sql`coalesce(${actorTenant}, ${targetTenant})`;
  const conds: SQL[] = [];
  if (q.actor) {
    const like = `%${escapeLike(q.actor)}%`;
    conds.push(or(ilike(users.name, like), ilike(users.email, like))!);
  }
  if (q.action) conds.push(ilike(auditLog.action, `%${escapeLike(q.action)}%`));
  if (q.tenantId) conds.push(sql`${eventTenant} = ${q.tenantId}`);
  if (q.from) conds.push(gte(auditLog.createdAt, new Date(`${q.from}T00:00:00+05:30`)));
  if (q.to) conds.push(lt(auditLog.createdAt, new Date(new Date(`${q.to}T00:00:00+05:30`).getTime() + 86_400_000)));
  const where = conds.length ? and(...conds) : undefined;

  const events = await db.select({
    id: auditLog.id, action: auditLog.action, targetType: auditLog.targetType, targetId: auditLog.targetId,
    meta: auditLog.meta, createdAt: auditLog.createdAt, actor: users.name, actorEmail: users.email,
    tenant: sql<string | null>`(select name from syndicates s where s.id = ${eventTenant})`,
  }).from(auditLog)
    .leftJoin(users, eq(auditLog.actorId, users.id))
    .leftJoin(actorBranch, eq(users.branchId, actorBranch.id))
    .where(where)
    .orderBy(sql`${auditLog.createdAt} desc`, auditLog.id)
    .limit(q.limit).offset(q.offset);
  const [{ total }] = await db.select({ total: count() }).from(auditLog)
    .leftJoin(users, eq(auditLog.actorId, users.id))
    .leftJoin(actorBranch, eq(users.branchId, actorBranch.id))
    .where(where);
  return { events, total: Number(total), limit: q.limit, offset: q.offset };
}

export async function auditActions() {
  const rows = await db.selectDistinct({ action: auditLog.action }).from(auditLog).orderBy(auditLog.action);
  return rows.map((r) => r.action);
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
  const target = await requirePlan(plan, { active: true, paid: true });
  const [tenant] = await db.select().from(syndicates).where(eq(syndicates.id, syndicateId)).limit(1);
  if (!tenant) throw new NotFoundError('Business not found');

  const [{ n }] = await db.select({ n: count() }).from(branches).where(eq(branches.syndicateId, syndicateId));
  const limit = target.maxBranches;
  if (Number(n) > limit) {
    throw new BusinessRuleError(`You have ${n} branches; the ${target.name} plan allows ${limit}. Choose a bigger plan or contact support.`);
  }

  await logAudit(actorId, 'tenant.plan_requested', { type: 'tenant', id: syndicateId }, { from: tenant.plan, to: plan });

  // Reuse an unpaid invoice of the same plan, otherwise void it and raise one for the new plan
  const [open] = await db.select().from(subscriptionInvoices)
    .where(and(eq(subscriptionInvoices.syndicateId, syndicateId), eq(subscriptionInvoices.status, 'PENDING'))).limit(1);
  if (open && open.plan === plan) return open;
  if (open) await db.update(subscriptionInvoices).set({ status: 'VOID' }).where(eq(subscriptionInvoices.id, open.id));
  return generateInvoice(syndicateId, actorId, plan);
}
