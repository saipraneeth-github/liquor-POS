import type { FastifyReply, FastifyRequest } from 'fastify';
import type { JwtPayload } from '../modules/auth/auth.service.js';

// ─── RBAC ROLE HIERARCHY ─────────────────────────────────────────────────────

const ROLE_RANK: Record<string, number> = {
  steward:  1,
  cashier:  2,
  manager:  3,
  owner:    4,
};

/**
 * Returns a Fastify preHandler that requires the user to be authenticated
 * and have at least `minRole` rank.
 */
export function requireRole(minRole: 'steward' | 'cashier' | 'manager' | 'owner') {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      await request.jwtVerify();
    } catch {
      reply.code(401).send({ error: 'Unauthorized: invalid or missing token' });
      return;
    }

    const payload = request.user as JwtPayload;
    const userRank = ROLE_RANK[payload.role] ?? 0;
    const requiredRank = ROLE_RANK[minRole];

    if (userRank < requiredRank) {
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

/**
 * Guard: owner may access any branch; others only their own.
 */
export function assertBranchAccess(
  user: JwtPayload,
  targetBranchId: string,
  reply: FastifyReply,
): boolean {
  if (user.role === 'owner') return true;
  if (user.branchId === targetBranchId) return true;
  reply.code(403).send({ error: 'Forbidden: cross-branch access denied' });
  return false;
}
