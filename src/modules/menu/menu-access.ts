/**
 * menu-access.ts — Tenant ownership and per-branch availability of menu items.
 * A menu item belongs to one tenant (syndicate); a branch may also switch an item off locally.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { branches, branchMenuAvailability } from '../../db/schema.js';
import { BusinessRuleError } from '../../lib/errors.js';
import { isPlatformOwner } from '../../middleware/auth.guard.js';
import type { Tx } from '../../lib/domain-events.js';
import type { JwtPayload } from '../auth/auth.service.js';

/** 'ALL' = platform owner (sees every tenant), string = tenant id, null = no tenant (standalone branch). */
export type Tenant = string | 'ALL' | null;

export async function tenantOf(user: JwtPayload): Promise<Tenant> {
  if (await isPlatformOwner(user)) return 'ALL';
  if (user.syndicateId) return user.syndicateId;
  if (!user.branchId) return null;
  const [branch] = await db.select({ syndicateId: branches.syndicateId }).from(branches).where(eq(branches.id, user.branchId)).limit(1);
  return branch?.syndicateId ?? null;
}

export interface SellableRow {
  id: string;
  name: string;
  syndicateId: string | null;
  isAvailable: boolean;
}

/** Availability of `productIds` at a branch: branch override wins over the shared flag. */
export async function branchAvailability(
  tx: Tx | typeof db,
  branchId: string,
  productIds: string[],
): Promise<Map<string, boolean>> {
  if (productIds.length === 0) return new Map();
  const rows = await tx
    .select({ productId: branchMenuAvailability.productId, isAvailable: branchMenuAvailability.isAvailable })
    .from(branchMenuAvailability)
    .where(and(eq(branchMenuAvailability.branchId, branchId), inArray(branchMenuAvailability.productId, productIds)));
  return new Map(rows.map((r) => [r.productId, r.isAvailable]));
}

/**
 * Throws when a product belongs to another tenant or is switched off (globally or at this branch).
 * Used by billing and KOT before anything is priced.
 */
export async function assertBranchCanSell(tx: Tx | typeof db, branchId: string, rows: SellableRow[]): Promise<void> {
  const [branch] = await tx.select({ syndicateId: branches.syndicateId }).from(branches).where(eq(branches.id, branchId)).limit(1);
  const foreign = rows.filter((r) => r.syndicateId && r.syndicateId !== (branch?.syndicateId ?? null));
  if (foreign.length > 0) {
    throw new BusinessRuleError(`One or more products not found: ${foreign.map((r) => r.id).join(', ')}`);
  }
  const overrides = await branchAvailability(tx, branchId, rows.map((r) => r.id));
  const unavailable = rows.filter((r) => !(overrides.get(r.id) ?? r.isAvailable));
  if (unavailable.length > 0) {
    throw new BusinessRuleError(`Out of stock on the menu: ${unavailable.map((r) => r.name).join(', ')}`);
  }
}
