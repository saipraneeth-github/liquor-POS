import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { roles, userPermissions, userSaleTypes, users } from '../../db/schema.js';
import type { Tx } from '../../lib/domain-events.js';
import { ForbiddenError } from '../../lib/errors.js';
import type { JwtPayload } from '../auth/auth.service.js';
import { listBranchSaleTypes } from '../saletypes/saletype.service.js';
import {
  PERMISSIONS, can, discountCapPct, effectivePermissions, isPermissionKey, restrictsSaleTypes, saleTypeAllowed,
  type PermissionKey, type PermissionOverrides,
} from './permissions.engine.js';

type Exec = Tx | typeof db;

/** The user's stored overrides (only the actions explicitly switched on or off). */
export async function loadOverrides(userId: string, exec: Exec = db): Promise<PermissionOverrides> {
  const rows = await exec.select({ permission: userPermissions.permission, allowed: userPermissions.allowed })
    .from(userPermissions).where(eq(userPermissions.userId, userId));
  const out: PermissionOverrides = {};
  for (const r of rows) if (isPermissionKey(r.permission)) out[r.permission] = r.allowed;
  return out;
}

/** The custom role a user holds, if any (a built-in role is just the user's `role`: it has no row to read). */
export async function loadCustomRole(userId: string, exec: Exec = db) {
  const [row] = await exec.select({ id: roles.id, name: roles.name, permissions: roles.permissions, pages: roles.pages })
    .from(users).innerJoin(roles, eq(users.roleId, roles.id)).where(eq(users.id, userId)).limit(1);
  return row ?? null;
}

/** The permission set of the user's custom role, or null: a built-in role keeps the code defaults. */
export async function loadRolePermissions(userId: string, exec: Exec = db): Promise<string[] | null> {
  return (await loadCustomRole(userId, exec))?.permissions ?? null;
}

/** `user` must be the account as the guard just re-read it (role is current). */
export async function userCan(user: JwtPayload, key: PermissionKey): Promise<boolean> {
  return can(user.role, await loadOverrides(user.sub), key, await loadRolePermissions(user.sub));
}

/** Largest bill discount in % for this user; null = unlimited. */
export async function userDiscountCapPct(user: JwtPayload): Promise<number | null> {
  return discountCapPct(user.role, await loadOverrides(user.sub), await loadRolePermissions(user.sub));
}

/**
 * Route guard for one action. Put it AFTER requireRole in the preHandler list (requireRole authenticates and refreshes
 * the account); use requireRole('steward') there when the permission, not the rank, is what decides.
 */
export function requirePermission(key: PermissionKey) {
  const label = PERMISSIONS.find((p) => p.key === key)!.label.toLowerCase();
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const user = request.user as JwtPayload | undefined;
    if (!user?.sub || !(await userCan(user, key))) {
      reply.code(403).send({ error: `Forbidden: you do not have permission to ${label}`, code: 'PERMISSION_DENIED', permission: key });
    }
  };
}

/** The sale types a cashier / steward is limited to, or null when they may use all of them. */
export async function allowedSaleTypeIds(user: JwtPayload, exec: Exec = db): Promise<string[] | null> {
  if (!restrictsSaleTypes(user.role)) return null;
  const rows = await exec.select({ id: userSaleTypes.saleTypeId }).from(userSaleTypes).where(eq(userSaleTypes.userId, user.sub));
  return rows.length === 0 ? null : rows.map((r) => r.id);
}

/** `saleTypeId` null = the shop's default (Walk-in) sale type. Throws 403 when the user is limited to other types. */
export async function assertSaleTypeAllowed(user: JwtPayload, branchId: string, saleTypeId: string | null, exec: Exec = db): Promise<void> {
  const allowed = await allowedSaleTypeIds(user, exec);
  if (allowed === null) return;
  let id = saleTypeId;
  if (id === null) {
    const def = (await listBranchSaleTypes(exec, branchId)).find((t) => t.isDefault);
    id = def?.id ?? '';
  }
  if (!saleTypeAllowed(user.role, allowed, id)) throw new ForbiddenError('You are not allowed to work with this sale type');
}

/** What the app needs to know about the signed-in user: which actions are on, the discount cap, the sale types. */
export async function myPermissions(user: Pick<JwtPayload, 'sub' | 'role'>) {
  const overrides = await loadOverrides(user.sub);
  const custom = await loadCustomRole(user.sub);
  const restricted = restrictsSaleTypes(user.role)
    ? (await db.select({ id: userSaleTypes.saleTypeId }).from(userSaleTypes).where(eq(userSaleTypes.userId, user.sub))).map((r) => r.id)
    : [];
  return {
    permissions: effectivePermissions(user.role, overrides, custom?.permissions),
    discountCapPct: discountCapPct(user.role, overrides, custom?.permissions),
    saleTypeIds: restricted.length > 0 ? restricted : null,
    roleName: custom?.name ?? null,                       // null = a built-in role, named by `role`
    rolePages: custom?.pages ?? null,                      // the role's default menu, used when the person has none of their own
  };
}

const COST_FIELDS = ['costPrice', 'previousCostPrice', 'costPerCase', 'lastInvoiceId', 'lastInvoiceNumber', 'lastInvoiceDate', 'costUpdatedAt', 'costValue'] as const;

/** Removes every cost field, at any depth, from a row, a list of rows or a nested response (e.g. {breakage: {...}}). */
export function stripCost<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if ((COST_FIELDS as readonly string[]).includes(k)) continue;
        out[k] = walk(x);
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
}
export type { PermissionKey };
