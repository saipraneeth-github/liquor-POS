import { temporaryPassword } from '../platform/platform.service.js';
import { logAudit } from '../../lib/audit.js';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { users, branches, syndicates, userPagePermissions, userPermissions, userSaleTypes } from '../../db/schema.js';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { hashPassword, type JwtPayload } from '../auth/auth.service.js';
import { canAccessBranch, getAccessibleBranchIds, getOwnedSyndicateId, isPlatformOwner } from '../../middleware/auth.guard.js';
import { PAGE_KEYS } from '../auth/page-guard.js';
import { loadOverrides, myPermissions } from '../permissions/permission.service.js';
import {
  PERMISSIONS, PERMISSION_KEYS, defaultAllowed, discountCapPct, effectivePermissions, isPermissionKey, isUnrestricted,
  notGrantable, restrictsSaleTypes, validateOverrides, type PermissionKey, type PermissionOverrides,
} from '../permissions/permissions.engine.js';
import { listBranchSaleTypes } from '../saletypes/saletype.service.js';
import { assertCanAssignRole, assertUserPatchAllowed, canManageUser } from './user.engine.js';
import { BusinessRuleError, ConflictError, ForbiddenError, NotFoundError, isUniqueViolation } from '../../lib/errors.js';

// ─── SCHEMAS ────────────────────────────────────────────────────────────────

const ROLE = z.enum(['owner', 'manager', 'office_admin', 'cashier', 'steward']);

const USER_NAME = z.string().trim().min(1).max(100).refine((s) => !/[<>]/.test(s), 'Name must not contain < or >');

export const CreateUserSchema = z.object({
  name:        USER_NAME,
  email:       z.string().trim().toLowerCase().email().max(254),
  password:    z.string().min(8).max(128),
  role:        ROLE,
  branchId:    z.string().uuid().optional().nullable(),
  syndicateId: z.string().uuid().optional().nullable(),   // owners only
});

export const UpdateUserSchema = z.object({
  name:     USER_NAME.optional(),
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
  return { ...me, branch, pages, ...(await myPermissions({ sub: me.id, role: me.role })) };
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
    .where(eq(sql`lower(${users.email})`, input.email.toLowerCase()))
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

// ─── PERMISSIONS (actions a user may do, and which sale types a cashier may use) ─────

export const SetPermissionsSchema = z.object({
  /** key → true (allow) / false (deny) / null (back to the role default) */
  overrides: z.record(z.string(), z.boolean().nullable()).default({}),
  /** Sale types a cashier / steward is limited to; empty = all of them. */
  saleTypeIds: z.array(z.string().uuid()).max(50).default([]),
});

async function permissionView(target: UserRow) {
  const stored = await loadOverrides(target.id);
  const saleTypes = target.branchId ? await listBranchSaleTypes(db, target.branchId, { all: true }) : [];
  const limited = restrictsSaleTypes(target.role)
    ? (await db.select({ id: userSaleTypes.saleTypeId }).from(userSaleTypes).where(eq(userSaleTypes.userId, target.id))).map((r) => r.id)
    : [];
  return {
    userId: target.id,
    role: target.role,
    unrestricted: isUnrestricted(target.role),                       // owner / office admin: everything, always
    permissions: PERMISSIONS.map((p) => ({
      key: p.key, label: p.label, description: p.description,
      roleDefault: defaultAllowed(target.role, p.key),
      override: stored[p.key] ?? null,
      effective: effectivePermissions(target.role, stored)[p.key],
    })),
    discountCapPct: discountCapPct(target.role, stored),
    canLimitSaleTypes: restrictsSaleTypes(target.role),
    saleTypes: saleTypes.map((t) => ({ id: t.id, name: t.name, isDefault: t.isDefault })),
    saleTypeIds: limited,                                            // empty = not limited
  };
}

export async function getUserPermissions(actor: JwtPayload, userId: string) {
  return permissionView(await loadManageableTarget(actor, userId, false));
}

/**
 * Replaces the user's overrides and sale-type limits. Rules: only users below the actor can be changed; an actor can only
 * switch ON what they hold themselves; owner / office admin cannot be restricted; overrides equal to the role default are
 * not stored; sale-type limits only apply to cashiers and stewards and must be sale types of the user's own business.
 */
export async function setUserPermissions(actor: JwtPayload, userId: string, input: z.infer<typeof SetPermissionsSchema>) {
  const target = await loadManageableTarget(actor, userId, true);

  const wanted: PermissionOverrides = {};
  for (const [key, value] of Object.entries(input.overrides)) {
    if (!isPermissionKey(key)) throw new BusinessRuleError(`Unknown permission: ${key}`);
    if (value !== null && value !== defaultAllowed(target.role, key)) wanted[key] = value;
  }
  const problems = validateOverrides(target.role, wanted);
  if (problems.length > 0) throw new BusinessRuleError(problems.join(' '));

  const denied = notGrantable(actor.role, await loadOverrides(actor.sub), wanted);
  if (denied.length > 0) throw new ForbiddenError(`You cannot grant a permission you do not have yourself: ${denied.join(', ')}`);

  let typeIds: string[] = [];
  if (input.saleTypeIds.length > 0) {
    if (!restrictsSaleTypes(target.role)) throw new BusinessRuleError('Only cashiers and stewards can be limited to some sale types');
    if (!target.branchId) throw new BusinessRuleError('This user has no shop');
    const valid = new Set((await listBranchSaleTypes(db, target.branchId, { all: true })).map((t) => t.id));
    typeIds = [...new Set(input.saleTypeIds)];
    if (typeIds.some((id) => !valid.has(id))) throw new BusinessRuleError('Unknown sale type for this shop');
  }

  await db.transaction(async (tx) => {
    await tx.delete(userPermissions).where(eq(userPermissions.userId, userId));
    const rows = PERMISSION_KEYS.filter((k) => wanted[k] !== undefined)
      .map((k: PermissionKey) => ({ userId, permission: k, allowed: wanted[k]!, updatedById: actor.sub }));
    if (rows.length > 0) await tx.insert(userPermissions).values(rows);
    await tx.delete(userSaleTypes).where(eq(userSaleTypes.userId, userId));
    if (typeIds.length > 0) await tx.insert(userSaleTypes).values(typeIds.map((saleTypeId) => ({ userId, saleTypeId })));
  });
  return permissionView(target);
}
// ─── PASSWORD RESET (no e-mail: the manager hands over a temporary password) ──

export async function resetUserPassword(actor: JwtPayload, userId: string) {
  const target = await loadManageableTarget(actor, userId, true);
  if (target.id === actor.sub) throw new BusinessRuleError('Use "Change password" for your own account');
  const password = temporaryPassword();
  await db.update(users).set({ passwordHash: await hashPassword(password) }).where(eq(users.id, userId));
  await logAudit(actor.sub, 'user.password_reset', { type: 'user', id: userId });
  return { email: target.email, temporaryPassword: password };
}
