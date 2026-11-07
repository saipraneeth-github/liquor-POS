/**
 * dashboard.routes.ts
 *   GET /dashboard/branch/:branchId — one outlet (cashier+; a cashier only gets their own shift and the stock list)
 *   GET /dashboard/owner            — all outlets of the owner's business (owner)
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, getUser, assertBranchAccess } from '../../middleware/auth.guard.js';
import { sendError } from '../../lib/errors.js';
import { branchDashboard, ownerDashboard } from './dashboard.service.js';

const BranchParams = z.object({ branchId: z.string().uuid() });

export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/dashboard/branch/:branchId', { preHandler: requireRole('cashier') }, async (req, reply) => {
    const params = BranchParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid branchId' });
    const user = getUser(req);
    if (!(await assertBranchAccess(user, params.data.branchId, reply))) return;
    try { return await branchDashboard(user, params.data.branchId); } catch (err) { return sendError(reply, err, 'Dashboard failed'); }
  });

  app.get('/dashboard/owner', { preHandler: requireRole('owner') }, async (req, reply) => {
    try { return await ownerDashboard(getUser(req)); } catch (err) { return sendError(reply, err, 'Dashboard failed'); }
  });
}
