/**
 * branch-admin.service.ts — Super Admin view of every branch on the platform, and which features each one has.
 *
 * A feature is on unless a row says otherwise (branch_features holds only the switched-off ones).
 */
import { z } from 'zod';
import { and, count, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { branchFeatures, branches, syndicates, users } from '../../db/schema.js';
import { BusinessRuleError, NotFoundError } from '../../lib/errors.js';
import { logAudit } from '../../lib/audit.js';
import { FEATURES, isFeatureKey } from './features.engine.js';

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);

/** Switched-off feature keys per branch. Branches with everything on are absent from the map. */
export async function disabledFeaturesByBranch(branchIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (branchIds.length === 0) return out;
  const rows = await db.select({ branchId: branchFeatures.branchId, feature: branchFeatures.feature }).from(branchFeatures)
    .where(inArray(branchFeatures.branchId, branchIds));
  for (const r of rows) if (isFeatureKey(r.feature)) out.set(r.branchId, [...(out.get(r.branchId) ?? []), r.feature]);
  return out;
}

/** Is this feature switched off for this branch? One indexed lookup. */
export async function isFeatureOff(branchId: string, feature: string): Promise<boolean> {
  const [row] = await db.select({ f: branchFeatures.feature }).from(branchFeatures)
    .where(and(eq(branchFeatures.branchId, branchId), eq(branchFeatures.feature, feature))).limit(1);
  return !!row;
}

// ─── LIST ───────────────────────────────────────────────────────────────────

export const ListBranchesSchema = z.object({
  search: z.string().trim().max(80).optional(),
  tenantId: z.string().uuid().optional(),
  status: z.enum(['active', 'suspended', 'archived']).optional(),     // the business's standing
  featureOff: z.string().trim().optional().refine((v) => v === undefined || v === '' || isFeatureKey(v), 'Unknown feature'),   // only branches with this feature switched off
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const standing = sql<'ARCHIVED' | 'SUSPENDED' | 'ACTIVE' | 'NONE'>`(case
  when ${syndicates.id} is null then 'NONE'
  when ${syndicates.archivedAt} is not null then 'ARCHIVED'
  when ${syndicates.isActive} = false then 'SUSPENDED'
  else 'ACTIVE' end)`;

export async function listPlatformBranches(q: z.infer<typeof ListBranchesSchema>) {
  const conds: SQL[] = [];
  if (q.search) {
    const like = `%${escapeLike(q.search)}%`;
    conds.push(or(ilike(branches.name, like), ilike(branches.code, like), ilike(branches.address, like), ilike(syndicates.name, like))!);
  }
  if (q.tenantId) conds.push(eq(branches.syndicateId, q.tenantId));
  if (q.status) conds.push(sql`${standing} = ${q.status.toUpperCase()}`);
  if (q.featureOff) conds.push(sql`exists (select 1 from branch_features bf where bf.branch_id = ${branches.id} and bf.feature = ${q.featureOff})`);
  const where = conds.length ? and(...conds) : undefined;

  const rows = await db.select({
    id: branches.id, name: branches.name, code: branches.code, address: branches.address, createdAt: branches.createdAt,
    tenantId: syndicates.id, tenant: syndicates.name, tenantMaxBranches: syndicates.maxBranches, standing,
    staff: sql<number>`(select count(*)::int from users u where u.branch_id = ${branches.id} and u.is_active = true)`,
    tenantBranches: sql<number>`(select count(*)::int from branches b2 where b2.syndicate_id = ${branches.syndicateId})`,
    featuresOff: sql<number>`(select count(*)::int from branch_features bf where bf.branch_id = ${branches.id})`,
  }).from(branches).leftJoin(syndicates, eq(branches.syndicateId, syndicates.id))
    .where(where).orderBy(syndicates.name, branches.code).limit(q.limit).offset(q.offset);
  const [{ total }] = await db.select({ total: count() }).from(branches).leftJoin(syndicates, eq(branches.syndicateId, syndicates.id)).where(where);
  return { branches: rows, total: Number(total), limit: q.limit, offset: q.offset, features: FEATURES.map(({ key, label }) => ({ key, label })) };
}

// ─── ONE BRANCH ─────────────────────────────────────────────────────────────

export async function getPlatformBranch(id: string) {
  const [b] = await db.select({
    id: branches.id, name: branches.name, code: branches.code, address: branches.address, gstin: branches.gstin,
    exciseLicenseNo: branches.exciseLicenseNo, createdAt: branches.createdAt,
    tenantId: syndicates.id, tenant: syndicates.name, tenantPlan: syndicates.plan, tenantMaxBranches: syndicates.maxBranches, standing,
  }).from(branches).leftJoin(syndicates, eq(branches.syndicateId, syndicates.id)).where(eq(branches.id, id)).limit(1);
  if (!b) throw new NotFoundError('Branch not found');

  const off = new Set((await disabledFeaturesByBranch([id])).get(id) ?? []);
  const changed = await db.select({ feature: branchFeatures.feature, at: branchFeatures.updatedAt, by: users.name }).from(branchFeatures)
    .leftJoin(users, eq(branchFeatures.updatedById, users.id)).where(eq(branchFeatures.branchId, id));
  const features = FEATURES.map((f) => {
    const c = changed.find((x) => x.feature === f.key);
    return { key: f.key, label: f.label, description: f.description, enabled: !off.has(f.key), changedAt: c?.at ?? null, changedBy: c?.by ?? null };
  });

  const staff = await db.select({ id: users.id, name: users.name, email: users.email, role: users.role, isActive: users.isActive, lastLoginAt: users.lastLoginAt })
    .from(users).where(eq(users.branchId, id)).orderBy(users.role, users.name);
  // The business's Admins can work in every branch of it
  const admins = b.tenantId
    ? await db.select({ id: users.id, name: users.name, email: users.email, role: users.role, isActive: users.isActive, lastLoginAt: users.lastLoginAt })
      .from(users).where(and(eq(users.syndicateId, b.tenantId), eq(users.role, 'owner')))
    : [];
  const [{ n }] = b.tenantId ? await db.select({ n: count() }).from(branches).where(eq(branches.syndicateId, b.tenantId)) : [{ n: 0 }];
  return { ...b, tenantBranches: Number(n), features, staff, admins };
}

// ─── SWITCH FEATURES ────────────────────────────────────────────────────────

export const SetFeaturesSchema = z.object({
  features: z.record(z.string(), z.boolean()).refine((f) => Object.keys(f).length > 0, 'Choose at least one feature'),
});

/**
 * Turn features on or off for one branch. Takes effect on the branch's next request. Only what actually changes is written
 * and audited (with before and after); asking for what is already so changes nothing.
 */
export async function setBranchFeatures(actorId: string | null, id: string, input: z.infer<typeof SetFeaturesSchema>) {
  const [b] = await db.select({ id: branches.id, name: branches.name, code: branches.code, tenantId: branches.syndicateId }).from(branches).where(eq(branches.id, id)).limit(1);
  if (!b) throw new NotFoundError('Branch not found');
  const unknown = Object.keys(input.features).filter((k) => !isFeatureKey(k));
  if (unknown.length) throw new BusinessRuleError(`Unknown feature: ${unknown.join(', ')}`);

  const currentOff = new Set((await disabledFeaturesByBranch([id])).get(id) ?? []);
  const before: Record<string, boolean> = {};
  const after: Record<string, boolean> = {};
  const turnOff: string[] = [];
  const turnOn: string[] = [];
  for (const [key, enabled] of Object.entries(input.features)) {
    const wasEnabled = !currentOff.has(key);
    if (wasEnabled === enabled) continue;
    before[key] = wasEnabled;
    after[key] = enabled;
    (enabled ? turnOn : turnOff).push(key);
  }
  if (turnOff.length === 0 && turnOn.length === 0) throw new BusinessRuleError('Nothing changed');

  await db.transaction(async (tx) => {
    if (turnOff.length) {
      await tx.insert(branchFeatures).values(turnOff.map((feature) => ({ branchId: id, feature, updatedById: actorId }))).onConflictDoNothing();
    }
    if (turnOn.length) await tx.delete(branchFeatures).where(and(eq(branchFeatures.branchId, id), inArray(branchFeatures.feature, turnOn)));
  });
  await logAudit(actorId, 'branch.features', { type: 'branch', id }, { branch: `${b.name} (${b.code})`, tenantId: b.tenantId, before, after });
  return getPlatformBranch(id);
}
