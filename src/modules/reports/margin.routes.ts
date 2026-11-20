import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, getUser, assertBranchAccess } from '../../middleware/auth.guard.js';
import { requirePermission } from '../permissions/permission.service.js';
import { sendError } from '../../lib/errors.js';
import { MarginQuerySchema, getMarginReport } from './margin.service.js';

/** GET /reports/margin/:branchId?from=&to= — product margin from this outlet's own costs (needs "see cost prices"). */
export async function marginRoutes(fastify: FastifyInstance) {
  fastify.get('/reports/margin/:branchId', { preHandler: [requireRole('steward'), requirePermission('cost.view')] }, async (request, reply) => {
    const p = z.object({ branchId: z.string().uuid() }).safeParse(request.params);
    if (!p.success) return reply.code(400).send({ error: 'Invalid branchId' });
    const q = MarginQuerySchema.safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: q.error.issues[0]?.message ?? 'Validation failed', details: q.error.flatten() });
    if (!(await assertBranchAccess(getUser(request), p.data.branchId, reply))) return;
    try {
      return await getMarginReport(p.data.branchId, q.data);
    } catch (err) {
      return sendError(reply, err, 'Failed to build the margin report');
    }
  });
}
