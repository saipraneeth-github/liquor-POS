import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { branches, syndicates, users } from '../db/schema.js';
import type { JwtPayload, UserRole } from '../modules/auth/auth.service.js';
import { ACCESS_MESSAGE, accessState } from '../modules/platform/access.engine.js';

// ─── RBAC ROLE HIERARCHY ─────────────────────────────────────────────────────

export const ROLE_RANK: Record<UserRole, number> = {
  steward:  1,
  cashier:  2,
  manager:  3,
  owner:    4,
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function roleRank(role: string): number {
  return ROLE_RANK[role as UserRole] ?? 0;
}

/**
 * Returns a Fastify preHandler that requires the user to be authenticated
 * and have at least `minRole` rank.
 */
/**
 * `allowLocked`: let a tenant whose trial ended or whose payment is overdue through, so its Admin can still
 * reach the billing screens and pay. A suspended tenant is never let through.
 */
export function requireRole(minRole: UserRole, opts: { allowLocked?: boolean } = {}) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      await request.jwtVerify();
    } catch {
      reply.code(401).send({ error: 'Unauthorized: invalid or missing token' });
      return;
    }

    // Re-read the account on every request: a deactivated, deleted, demoted or moved user
    // must lose access immediately, not when the (8h) token expires.
    const claims = request.user as JwtPayload;
    const [account] = claims?.sub && UUID_RE.test(claims.sub)
      ? await db
          .select({
            role: users.role, branchId: users.branchId, syndicateId: users.syndicateId, isActive: users.isActive,
            tenantActive: syndicates.isActive,   // NULL when the account has no tenant (platform owner)
            tenantPlan: syndicates.plan,
            tenantTrialEndsAt: syndicates.trialEndsAt,
            tenantPaidUntil: syndicates.paidUntil,
          })
          .from(users)
          .leftJoin(branches, eq(users.branchId, branches.id))
          .leftJoin(syndicates, eq(syndicates.id, sql`coalesce(${users.syndicateId}, ${branches.syndicateId})`))
          .where(eq(users.id, claims.sub))
          .limit(1)
      : [];
    if (!account || !account.isActive) {
      reply.code(401).send({ error: 'Unauthorized: account is inactive or no longer exists' });
      return;
    }
    // A suspended tenant (unpaid / offboarded) loses access for every one of its users at once
    if (account.tenantActive !== null) {
      const state = accessState({
        isActive: account.tenantActive,
        plan: account.tenantPlan ?? 'TRIAL',
        trialEndsAt: account.tenantTrialEndsAt,
        paidUntil: account.tenantPaidUntil,
      });
      (request as unknown as { tenantAccess?: string }).tenantAccess = state;
      const lockedButPayable = state === 'TRIAL_EXPIRED' || state === 'OVERDUE';
      if (state !== 'OK' && !(opts.allowLocked && lockedButPayable)) {
        reply.code(403).send({ error: ACCESS_MESSAGE[state], code: state });
        return;
      }
    }
    const payload: JwtPayload = {
      ...claims,
      role: account.role,
      branchId: account.branchId ?? null,
      syndicateId: account.syndicateId ?? null,
    };
    request.user = payload;

    if (roleRank(payload.role) < ROLE_RANK[minRole]) {
      reply.code(403).send({ error: `Forbidden: requires role ${minRole} or higher` });
    }
  };
}

/**
 * Returns the authenticated user payload from the request.
 */
export function getUser(request: FastifyRequest): JwtPayload {
  return request.user as JwtPayload;
}

// ─── MULTI-TENANT ACCESS MODEL ───────────────────────────────────────────────
//
//   platform owner  = role owner, branchId NULL, syndicateId NULL → every branch
//   syndicate owner = role owner, syndicateId set                → branches of that syndicate
//   everyone else                                                 → their own branchId only

/**
 * Resolves the syndicate claim. Tokens minted before the claim existed have it undefined;
 * for owners we then read it from the DB so a syndicate owner is never promoted to platform owner.
 */
async function resolveSyndicateId(user: JwtPayload): Promise<string | null> {
  if (user.syndicateId !== undefined) return user.syndicateId ?? null;
  if (user.role !== 'owner') return null;
  const [row] = await db.select({ syndicateId: users.syndicateId }).from(users).where(eq(users.id, user.sub)).limit(1);
  return row?.syndicateId ?? null;
}

export async function isPlatformOwner(user: JwtPayload): Promise<boolean> {
  if (user.role !== 'owner' || user.branchId) return false;
  return (await resolveSyndicateId(user)) === null;
}

/** Returns the owner's syndicate id when the user is a syndicate owner, else null. */
export async function getOwnedSyndicateId(user: JwtPayload): Promise<string | null> {
  if (user.role !== 'owner') return null;
  return resolveSyndicateId(user);
}

/** Pure-ish check without sending a response. */
export async function canAccessBranch(user: JwtPayload, targetBranchId: string): Promise<boolean> {
  if (!targetBranchId || !UUID_RE.test(targetBranchId)) return false;
  if (user.role === 'owner') {
    const syndicateId = await resolveSyndicateId(user);
    if (syndicateId) {
      const [branch] = await db
        .select({ syndicateId: branches.syndicateId })
        .from(branches)
        .where(eq(branches.id, targetBranchId))
        .limit(1);
      return !!branch && branch.syndicateId === syndicateId;
    }
    if (!user.branchId) return true;   // platform owner
  }
  return user.branchId === targetBranchId;
}

/**
 * Guard: sends 403 and returns false when the user may not access `targetBranchId`.
 * A non-existent branch is reported as 403 for scoped users (no existence leak).
 */
export async function assertBranchAccess(
  user: JwtPayload,
  targetBranchId: string,
  reply: FastifyReply,
): Promise<boolean> {
  if (await canAccessBranch(user, targetBranchId)) return true;
  reply.code(403).send({ error: 'Forbidden: cross-branch access denied' });
  return false;
}

/** Branch ids the user may access, or 'ALL' for the platform owner. */
export async function getAccessibleBranchIds(user: JwtPayload): Promise<string[] | 'ALL'> {
  if (user.role === 'owner') {
    const syndicateId = await resolveSyndicateId(user);
    if (syndicateId) {
      const rows = await db.select({ id: branches.id }).from(branches).where(eq(branches.syndicateId, syndicateId));
      return rows.map((r) => r.id);
    }
    if (!user.branchId) return 'ALL';
  }
  return user.branchId ? [user.branchId] : [];
}
