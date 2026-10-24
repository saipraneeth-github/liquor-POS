import { FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../../db/client.js';
import { userPagePermissions, users } from '../../db/schema.js';
import { and, eq } from 'drizzle-orm';

/**
 * Ensures the authenticated user has permission to access the requested route.
 * Also verifies basic role requirements if specified.
 */
export async function pageGuard(
  request: FastifyRequest,
  reply: FastifyReply,
  routePath: string,
  allowedRoles?: string[]
) {
  const user = request.user as { id: string; role: string } | undefined;

  if (!user || !user.id) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  // First, verify role level access if provided
  if (allowedRoles && !allowedRoles.includes(user.role)) {
    return reply.status(403).send({ error: 'Forbidden: Insufficient role' });
  }

  // Second, check granular user-to-page permission matrix
  const permission = await db
    .select()
    .from(userPagePermissions)
    .where(
      and(
        eq(userPagePermissions.userId, user.id),
        eq(userPagePermissions.routePath, routePath)
      )
    )
    .limit(1);

  if (permission.length === 0 || !permission[0].canAccess) {
    return reply.status(403).send({ error: 'Forbidden: Missing page access permission' });
  }
}
