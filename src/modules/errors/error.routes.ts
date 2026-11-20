import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { errorEvents } from '../../db/schema.js';
import { getUser, isPlatformOwner, requireRole } from '../../middleware/auth.guard.js';
import { logAudit } from '../../lib/audit.js';
import { captureError } from './error-tracker.js';

const ClientErrorSchema = z.object({
  message: z.string().trim().min(1).max(500),
  stack: z.string().max(4000).optional(),
  url: z.string().max(300).optional(),
  release: z.string().max(40).optional(),
});
const ListSchema = z.object({
  status: z.enum(['open', 'resolved', 'all']).default('open'),
  source: z.enum(['SERVER', 'BROWSER']).optional(),
});

/**
 *   POST /client-errors                 — the browser reports an uncaught error (public, rate limited, size capped)
 *   GET  /platform/errors               — Super Admin: distinct errors, most recent first
 *   POST /platform/errors/:id/resolve   — mark one resolved (it reopens by itself if it happens again)
 */
export async function errorRoutes(fastify: FastifyInstance) {
  const isProduction = process.env.NODE_ENV === 'production';

  fastify.post('/client-errors', {
    config: isProduction ? { rateLimit: { max: 20, timeWindow: '1 minute' } } : {},
    bodyLimit: 16 * 1024,
  }, async (request, reply) => {
    const body = ClientErrorSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid report' });
    // Signed in? Link the report to the person, from the token alone (no database lookup, nothing trusted beyond the id)
    let userId: string | null = null;
    let branchId: string | null = null;
    try {
      await request.jwtVerify();
      const u = request.user as { sub?: string; branchId?: string | null };
      userId = u.sub ?? null; branchId = u.branchId ?? null;
    } catch { /* anonymous: the sign-in page can fail too */ }
    await captureError({
      source: 'BROWSER', message: body.data.message, stack: body.data.stack, route: body.data.url, userId, branchId,
      userAgent: String(request.headers['user-agent'] ?? ''), release: body.data.release,
    });
    return reply.code(204).send();
  });

  const guard = { preHandler: requireRole('owner') };

  fastify.get('/platform/errors', guard, async (request, reply) => {
    if (!(await isPlatformOwner(getUser(request)))) return reply.code(403).send({ error: 'Forbidden: Super Admin only' });
    const q = ListSchema.safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: 'Validation failed' });
    const conds: SQL[] = [];
    if (q.data.status === 'open') conds.push(isNull(errorEvents.resolvedAt));
    if (q.data.status === 'resolved') conds.push(isNotNull(errorEvents.resolvedAt));
    if (q.data.source) conds.push(eq(errorEvents.source, q.data.source));
    const rows = await db.select().from(errorEvents).where(conds.length ? and(...conds) : undefined).orderBy(desc(errorEvents.lastSeenAt)).limit(200);
    const [{ open }] = await db.select({ open: sql<number>`count(*)::int` }).from(errorEvents).where(isNull(errorEvents.resolvedAt));
    return { errors: rows, open };
  });

  fastify.post('/platform/errors/:id/resolve', guard, async (request, reply) => {
    const user = getUser(request);
    if (!(await isPlatformOwner(user))) return reply.code(403).send({ error: 'Forbidden: Super Admin only' });
    const p = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!p.success) return reply.code(404).send({ error: 'Not found' });
    const [row] = await db.update(errorEvents).set({ resolvedAt: new Date(), resolvedById: user.sub }).where(eq(errorEvents.id, p.data.id)).returning();
    if (!row) return reply.code(404).send({ error: 'Not found' });
    await logAudit(user.sub, 'error.resolve', { type: 'error_event', id: row.id }, { message: row.message.slice(0, 120) });
    return row;
  });
}
