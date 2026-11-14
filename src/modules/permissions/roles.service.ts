/**
 * roles.service.ts — the roles the Super Admin defines, and putting people on them.
 *
 * Built-in roles (isSystem) are fixed. A custom role is a level (steward / cashier / manager), a set of granted permissions
 * and default pages. Editing one applies on its people's next request: permissions are read per request. Roles are retired,
 * never deleted: people may be on them and the audit trail names them.
 */
import { z } from 'zod';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { roles, users } from '../../db/schema.js';
import { BusinessRuleError, ConflictError, NotFoundError } from '../../lib/errors.js';
import { logAudit } from '../../lib/audit.js';
import { roleRank } from '../../middleware/auth.guard.js';
import type { UserRole } from '../auth/auth.service.js';
import { CUSTOM_LEVELS, PERMISSION_GROUPS, ROLE_PAGES, normalisePermissions, permissionCatalog, permissionSummary, roleKeyFromName, validateRole } from './roles.engine.js';

export type RoleRow = typeof roles.$inferSelect;

const NAME = z.string().trim().min(3, 'Use at least 3 characters').max(40, 'Use at most 40 characters');
// Left out = leave as it is. A blank clears it (see blankToNull).
const DESCRIPTION = z.string().trim().max(200).optional();
const blankToNull = (v: string | undefined) => (v ? v : null);
const PERMS = z.array(z.string().trim().min(1).max(40)).max(50);
const PAGES = z.array(z.string().trim().min(1).max(40)).max(50).nullable();

export const CreateRoleSchema = z.object({
  name: NAME,
  description: DESCRIPTION,
  level: z.enum(CUSTOM_LEVELS),
  permissions: PERMS.default([]),
  pages: PAGES.default(null),
});
export const UpdateRoleSchema = z.object({
  name: NAME.optional(),
  description: DESCRIPTION,
  level: z.enum(CUSTOM_LEVELS).optional(),
  permissions: PERMS.optional(),
  pages: PAGES.optional(),
}).refine((d) => Object.keys(d).length > 0, 'At least one field is required');
export const ActiveRoleSchema = z.object({ isActive: z.boolean() });
export const AssignRoleSchema = z.object({ roleId: z.string().uuid() });

const snapshot = (r: RoleRow) => ({ name: r.name, description: r.description, level: r.level, permissions: r.permissions, pages: r.pages, isActive: r.isActive });

async function loadRole(id: string): Promise<RoleRow> {
  const [r] = await db.select().from(roles).where(eq(roles.id, id)).limit(1);
  if (!r) throw new NotFoundError('Role not found');
  return r;
}
function assertCustom(r: RoleRow) {
  if (r.isSystem) throw new BusinessRuleError(`${r.name} is a built-in role and cannot be changed. Duplicate it to make your own.`);
}

// ─── LIST ───────────────────────────────────────────────────────────────────

/** Every role with how many people hold it, plus what the editor needs to draw itself. */
export async function listRoles() {
  const rows = await db.select().from(roles).orderBy(asc(roles.isSystem), asc(roles.name));
  const counts = await db.select({ roleId: users.roleId, role: users.role, n: sql<number>`count(*)::int` }).from(users).groupBy(users.roleId, users.role);
  const withCounts = rows.map((r) => ({
    ...r,
    // built-in roles are held by everyone with that level and no custom role
    userCount: counts.filter((c) => (r.isSystem ? c.roleId === null && c.role === r.key : c.roleId === r.id)).reduce((s, c) => s + c.n, 0),
    summary: r.isSystem ? null : permissionSummary(r.permissions),
  }));
  // built-in first, in rank order; then custom ones by name
  const sorted = [
    ...withCounts.filter((r) => r.isSystem).sort((a, b) => roleRank(b.level) - roleRank(a.level)),
    ...withCounts.filter((r) => !r.isSystem),
  ];
  return {
    roles: sorted,
    catalog: { groups: permissionCatalog(), pages: ROLE_PAGES, levels: CUSTOM_LEVELS, groupIds: PERMISSION_GROUPS.map((g) => g.id) },
  };
}

// ─── CREATE / EDIT / RETIRE ─────────────────────────────────────────────────

export async function createRole(actorId: string | null, input: z.infer<typeof CreateRoleSchema>) {
  const permissions = normalisePermissions(input.permissions);
  const problems = validateRole({ name: input.name, level: input.level, permissions: input.permissions, pages: input.pages });
  if (problems.length) throw new BusinessRuleError(problems.join(' '));
  if (permissions.length !== new Set(input.permissions).size) throw new BusinessRuleError(`Unknown permission: ${input.permissions.filter((k) => !permissions.includes(k as never)).join(', ')}.`);

  const base = roleKeyFromName(input.name);
  let key = base;
  for (let n = 2; (await db.select({ id: roles.id }).from(roles).where(eq(roles.key, key)).limit(1)).length > 0; n++) key = `${base.slice(0, 26)}_${n}`;
  const [clash] = await db.select({ id: roles.id }).from(roles).where(eq(roles.nameKey, input.name.toLowerCase())).limit(1);
  if (clash) throw new ConflictError(`A role named “${input.name}” already exists`);

  const [row] = await db.insert(roles).values({
    key, name: input.name, nameKey: input.name.toLowerCase(), description: blankToNull(input.description), level: input.level,
    permissions, pages: input.pages, createdById: actorId,
  }).returning();
  await logAudit(actorId, 'role.create', { type: 'role', id: row.id }, { after: snapshot(row) });
  return row;
}

export async function updateRole(actorId: string | null, id: string, input: z.infer<typeof UpdateRoleSchema>) {
  const before = await loadRole(id);
  assertCustom(before);
  const next = {
    name: input.name ?? before.name,
    level: input.level ?? before.level,
    permissions: input.permissions ?? before.permissions,
    pages: input.pages === undefined ? before.pages : input.pages,
  };
  const problems = validateRole(next);
  if (problems.length) throw new BusinessRuleError(problems.join(' '));
  const permissions = normalisePermissions(next.permissions);
  if (permissions.length !== new Set(next.permissions).size) throw new BusinessRuleError('Unknown permission.');
  if (input.name && input.name.toLowerCase() !== before.nameKey) {
    const [clash] = await db.select({ id: roles.id }).from(roles).where(eq(roles.nameKey, input.name.toLowerCase())).limit(1);
    if (clash) throw new ConflictError(`A role named “${input.name}” already exists`);
  }

  const row = await db.transaction(async (tx) => {
    const [r] = await tx.update(roles).set({
      name: next.name, nameKey: next.name.toLowerCase(), level: next.level, permissions, pages: next.pages,
      ...(input.description !== undefined ? { description: blankToNull(input.description) } : {}), updatedAt: new Date(),
    }).where(eq(roles.id, id)).returning();
    // The level is what every route guard reads from the person: it follows the role
    if (next.level !== before.level) await tx.update(users).set({ role: next.level as UserRole }).where(eq(users.roleId, id));
    return r;
  });
  await logAudit(actorId, 'role.update', { type: 'role', id }, { before: snapshot(before), after: snapshot(row) });
  return row;
}

export async function setRoleActive(actorId: string | null, id: string, isActive: boolean) {
  const before = await loadRole(id);
  assertCustom(before);
  if (before.isActive === isActive) return before;
  const [row] = await db.update(roles).set({ isActive, updatedAt: new Date() }).where(eq(roles.id, id)).returning();
  await logAudit(actorId, isActive ? 'role.reactivate' : 'role.retire', { type: 'role', id }, { before: { isActive: before.isActive }, after: { isActive } });
  return row;
}

// ─── PUTTING A PERSON ON A ROLE ─────────────────────────────────────────────

/**
 * Super Admin: move a person to another role. Steward, cashier and manager level only: owners, office admins and platform
 * owners are not handled here. Built-in roles are chosen by level; a custom role also brings its permissions and pages.
 * Personal exceptions the person already has are kept.
 */
export async function assignRole(actorId: string | null, userId: string, roleId: string) {
  const role = await loadRole(roleId);
  if (!role.isActive) throw new BusinessRuleError(`${role.name} has been retired and cannot be given to anyone new`);
  if (!(CUSTOM_LEVELS as readonly string[]).includes(role.level)) throw new BusinessRuleError('Owners and office admins are set up when the business is created, not from here');

  const [u] = await db.select({ id: users.id, name: users.name, email: users.email, role: users.role, roleId: users.roleId, branchId: users.branchId, syndicateId: users.syndicateId })
    .from(users).where(eq(users.id, userId)).limit(1);
  if (!u) throw new NotFoundError('User not found');
  if (u.id === actorId) throw new BusinessRuleError('You cannot change your own role');
  if (u.role === 'owner' || u.role === 'office_admin') throw new BusinessRuleError('The role of an owner or office admin cannot be changed from here');

  const [prev] = u.roleId ? await db.select({ name: roles.name }).from(roles).where(eq(roles.id, u.roleId)).limit(1) : [null];
  const previousName = prev?.name ?? u.role;
  const newRoleId = role.isSystem ? null : role.id;
  if (u.roleId === newRoleId && u.role === role.level) throw new ConflictError(`${u.name} already has the role ${role.name}`);

  await db.update(users).set({ role: role.level as UserRole, roleId: newRoleId }).where(eq(users.id, userId));
  await logAudit(actorId, 'user.role_changed', { type: 'user', id: userId }, { email: u.email, before: { role: u.role, roleName: previousName }, after: { role: role.level, roleName: role.name } });
  return { id: userId, role: role.level, roleId: newRoleId, roleName: role.name };
}

/** Roles the Super Admin can put people on: active, steward / cashier / manager level. */
export async function assignableRoles() {
  return db.select({ id: roles.id, name: roles.name, level: roles.level, isSystem: roles.isSystem }).from(roles)
    .where(and(eq(roles.isActive, true), inArray(roles.level, [...CUSTOM_LEVELS]))).orderBy(asc(roles.isSystem), asc(roles.name));
}
