import type { FastifyRequest, FastifyReply } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { userPagePermissions } from '../../db/schema.js';
import { ROLE_RANK, roleRank } from '../../middleware/auth.guard.js';
import type { JwtPayload, UserRole } from './auth.service.js';

// ─── PAGE KEYS ───────────────────────────────────────────────────────────────

/** Neutral page keys used by the user/page permission matrix. */
export const PAGE_KEYS = [
  'dashboard',
  'pos',
  'bills',
  'tables',
  'inventory',
  'purchases',
  'customers',
  'schemes',
  'closing',
  'reports',
  'accounting',
  'settings',
] as const;
export type PageKey = (typeof PAGE_KEYS)[number];

// ─── PAGE GUARD ──────────────────────────────────────────────────────────────

/**
 * Fastify preHandler factory: verifies the JWT, optionally enforces a minimum role,
 * then checks the page-permission matrix. Owners bypass the matrix; everyone else
 * needs a `user_page_permissions` row with canAccess = true.
 */
export function requirePage(routePath: string, minRole?: UserRole) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      await request.jwtVerify();
    } catch {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    const user = request.user as JwtPayload | undefined;
    if (!user?.sub) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }

    if (minRole && roleRank(user.role) < ROLE_RANK[minRole]) {
      reply.code(403).send({ error: 'Forbidden: Insufficient role' });
      return;
    }

    if (user.role === 'owner') return;

    const [permission] = await db
      .select({ canAccess: userPagePermissions.canAccess })
      .from(userPagePermissions)
      .where(and(eq(userPagePermissions.userId, user.sub), eq(userPagePermissions.routePath, routePath)))
      .limit(1);

    if (!permission || !permission.canAccess) {
      reply.code(403).send({ error: 'Forbidden: Missing page access permission' });
    }
  };
}
