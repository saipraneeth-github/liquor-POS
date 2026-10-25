import { z } from 'zod';
import { db } from '../../db/client.js';
import { users, branches, syndicates, userPagePermissions } from '../../db/schema.js';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { hashPassword, type JwtPayload } from '../auth/auth.service.js';
import { canAccessBranch, getAccessibleBranchIds, getOwnedSyndicateId, isPlatformOwner } from '../../middleware/auth.guard.js';
import { PAGE_KEYS } from '../auth/page-guard.js';
import { assertCanAssignRole, assertUserPatchAllowed, canManageUser } from './user.engine.js';
import { BusinessRuleError, ConflictError, ForbiddenError, NotFoundError, isUniqueViolation } from '../../lib/errors.js';

// ─── SCHEMAS ────────────────────────────────────────────────────────────────

const ROLE = z.enum(['owner', 'manager', 'cashier', 'steward']);

export const CreateUserSchema = z.object({
  name:        z.string().trim().min(1).max(100),
  email:       z.string().trim().toLowerCase().email().max(254),
  password:    z.string().min(8).max(128),
  role:        ROLE,
  branchId:    z.string().uuid().optional().nullable(),
  syndicateId: z.string().uuid().optional().nullable(),   // owners only
});

export const UpdateUserSchema = z.object({
  name:     z.string().trim().min(1).max(100).optional(),
  role:     ROLE.optional(),
  isActive: z.boolean().optional(),
}).refine((d) => Object.keys(d).length > 0, 'At least one field is required');

export const ListUsersQuerySchema = z.object({
  branchId: z.string().uuid().optional(),
});

export const SetPagesSchema = z.object({
  pages: z.array(z.object({
    routePath: z.enum(PAGE_KEYS),
    canAccess: z.boolean(),
  })).max(PAGE_KEYS.length),
});

export type CreateUserInput = z.infer<typeof CreateUserSchema>;
export type UpdateUserInput = z.infer<typeof UpdateUserSchema>;

// ─── PROJECTION (never expose passwordHash) ─────────────────────────────────

const publicColumns = {
  id:          users.id,
  name:        users.name,
  email:       users.email,
  role:        users.role,
  branchId:    users.branchId,
  syndicateId: users.syndicateId,
  isActive:    users.isActive,
  createdAt:   users.createdAt,
};

type UserRow = typeof users.$inferSelect;

async function loadUser(id: string): Promise<UserRow | null> {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row ?? null;
}

/** Whether `actor` may see/manage `target` based on tenancy alone. */
async function inScope(actor: JwtPayload, target: Pick<UserRow, 'branchId' | 'syndicateId'>): Promise<boolean> {
  if (target.branchId) return canAccessBranch(actor, target.branchId);
  // branch-less users are owners (platform or syndicate)
  if (await isPlatformOwner(actor)) return true;
  const own = await getOwnedSyndicateId(actor);
  return !!own && target.syndicateId === own;
}

// ─── QUERIES ────────────────────────────────────────────────────────────────

export async function getMe(userId: string) {
  const [me] = await db.select(publicColumns).from(users).where(eq(users.id, userId)).limit(1);
  if (!me) throw new NotFoundError('User not found');
  const pages = await db
    .select({ routePath: userPagePermissions.routePath, canAccess: userPagePermissions.canAccess })
    .from(userPagePermissions)
    .where(eq(userPagePermissions.userId, userId));
  let branch: { id: string; name: string; code: string } | null = null;
  if (me.branchId) {
    const [b] = await db.select({ id: branches.id, name: branches.name, code: branches.code })
      .from(branches).where(eq(branches.id, me.branchId)).limit(1);
    branch = b ?? null;
  }
  return { ...me, branch, pages };
}

export async function listUsers(actor: JwtPayload, branchId?: string) {
  if (branchId) {
    if (!(await canAccessBranch(actor, branchId))) throw new ForbiddenError('Forbidden: cross-branch access denied');
    return db.select(publicColumns).from(users).where(eq(users.branchId, branchId)).orderBy(users.name);
  }

  const scope = await getAccessibleBranchIds(actor);
  if (scope === 'ALL') return db.select(publicColumns).from(users).orderBy(users.name);

  const own = await getOwnedSyndicateId(actor);
  const branchCond = scope.length > 0 ? inArray(users.branchId, scope) : undefined;
  const ownerCond = own ? and(isNull(users.branchId), eq(users.syndicateId, own)) : undefined;
  const where = branchCond && ownerCond ? or(branchCond, ownerCond) : (branchCond ?? ownerCond);
  if (!where) return [];
  return db.select(publicColumns).from(users).where(where).orderBy(users.name);
}

// ─── CREATE ─────────────────────────────────────────────────────────────────

export async function createUser(actor: JwtPayload, input: CreateUserInput) {
  try {
    assertCanAssignRole(actor.role, input.role);
  } catch (err) {
    throw new ForbiddenError(err instanceof Error ? err.message : 'Forbidden');
  }

  let branchId: string | null = input.branchId ?? null;
  let syndicateId: string | null = null;

  if (input.role === 'owner') {
    if (await isPlatformOwner(actor)) {
      syndicateId = input.syndicateId ?? null;
      if (syndicateId) {
        const [s] = await db.select({ id: syndicates.id }).from(syndicates).where(eq(syndicates.id, syndicateId)).limit(1);
        if (!s) throw new BusinessRuleError('Syndicate not found');
      }
    } else {
      const own = await getOwnedSyndicateId(actor);
      if (!own) throw new ForbiddenError('Only platform or syndicate owners can create owners');
      if (input.syndicateId && input.syndicateId !== own) throw new ForbiddenError('Cannot create owners for another syndicate');
      syndicateId = own;
      if (branchId) throw new BusinessRuleError('Syndicate owners are not tied to a branch');
    }
    if (branchId && !(await canAccessBranch(actor, branchId))) throw new ForbiddenError('Forbidden: cross-branch access denied');
  } else {
    if (input.syndicateId) throw new BusinessRuleError('syndicateId applies to owners only');
    if (actor.role !== 'owner') branchId = branchId ?? actor.branchId;
    if (!branchId) throw new BusinessRuleError('branchId is required for non-owner users');
    if (!(await canAccessBranch(actor, branchId))) throw new ForbiddenError('Forbidden: cross-branch access denied');
  }

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${input.email}`)
    .limit(1);
  if (existing) throw new ConflictError('A user with this email already exists');

  try {
    const [created] = await db.insert(users).values({
      name: input.name,
      email: input.email,
      passwordHash: await hashPassword(input.password),
      role: input.role,
      branchId,
      syndicateId,
    }).returning(publicColumns);
    return created;
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError('A user with this email already exists');
    throw err;
  }
}

// ─── UPDATE ─────────────────────────────────────────────────────────────────

export async function updateUser(actor: JwtPayload, userId: string, patch: UpdateUserInput) {
  const target = await loadUser(userId);
  if (!target || !(await inScope(actor, target))) throw new NotFoundError('User not found');

  try {
    assertUserPatchAllowed({ id: actor.sub, role: actor.role }, target, patch);
  } catch (err) {
    throw new ForbiddenError(err instanceof Error ? err.message : 'Forbidden');
  }

  const [updated] = await db
    .update(users)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.role !== undefined ? { role: patch.role } : {}),
      ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
    })
    .where(eq(users.id, userId))
    .returning(publicColumns);
  return updated;
}

// ─── PAGE PERMISSION MATRIX ─────────────────────────────────────────────────

async function loadManageableTarget(actor: JwtPayload, userId: string, forWrite: boolean) {
  const target = await loadUser(userId);
  if (!target || !(await inScope(actor, target))) throw new NotFoundError('User not found');
  if (forWrite && !canManageUser({ id: actor.sub, role: actor.role }, target)) {
    throw new ForbiddenError('You cannot change page access for this user');
  }
  return target;
}

export async function getUserPages(actor: JwtPayload, userId: string) {
  await loadManageableTarget(actor, userId, false);
  return db
    .select({ routePath: userPagePermissions.routePath, canAccess: userPagePermissions.canAccess })
    .from(userPagePermissions)
    .where(eq(userPagePermissions.userId, userId))
    .orderBy(userPagePermissions.routePath);
}

/** Replaces the user's page matrix with exactly the given entries. */
export async function setUserPages(
  actor: JwtPayload,
  userId: string,
  pages: { routePath: string; canAccess: boolean }[],
) {
  await loadManageableTarget(actor, userId, true);
  const unique = new Map(pages.map((p) => [p.routePath, p.canAccess]));

  await db.transaction(async (tx) => {
    await tx.delete(userPagePermissions).where(eq(userPagePermissions.userId, userId));
    if (unique.size > 0) {
      await tx.insert(userPagePermissions).values(
        [...unique].map(([routePath, canAccess]) => ({ userId, routePath, canAccess })),
      );
    }
  });

  return getUserPages(actor, userId);
}
