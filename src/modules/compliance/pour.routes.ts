/**
 * pour.routes.ts — Peg pour control.
 *
 * POST /api/v1/compliance/pour-counts/:branchId   — record a physical count of an open bottle (manager+)
 * GET  /api/v1/compliance/pour-counts/:branchId   — recent counts (manager+)
 * GET  /api/v1/compliance/pour-report/:branchId?from=&to=   — variance report (manager+)
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, getUser, assertBranchAccess } from '../../middleware/auth.guard.js';
import { sendError } from '../../lib/errors.js';
import { PourCountSchema, PourReportQuerySchema, pourReport, recentPourCounts, recordPourCount } from './pour.service.js';

const BranchParams = z.object({ branchId: z.string().uuid() });

export async function pourRoutes(app: FastifyInstance) {
  app.post('/compliance/pour-counts/:branchId', { preHandler: requireRole('manager') }, async (req, reply) => {
    const params = BranchParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid branchId' });
    const body = PourCountSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Validation failed', details: body.error.flatten() });
    const user = getUser(req);
    if (!(await assertBranchAccess(user, params.data.branchId, reply))) return;
    try {
      return reply.code(201).send(await recordPourCount(params.data.branchId, body.data, user));
    } catch (err) {
      return sendError(reply, err, 'Could not record pour count');
    }
  });

  app.get('/compliance/pour-counts/:branchId', { preHandler: requireRole('manager') }, async (req, reply) => {
    const params = BranchParams.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid branchId' });
    if (!(await assertBranchAccess(getUser(req), params.data.branchId, reply))) return;
    return { counts: await recentPourCounts(params.data.branchId) };
  });

  app.get('/compliance/pour-report/:branchId', { preHandler: requireRole('manager') }, async (req, reply) => {
    const params = BranchParams.safeParse(req.params);
    const query = PourReportQuerySchema.safeParse(req.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: 'branchId and from/to (YYYY-MM-DD) are required' });
    if (!(await assertBranchAccess(getUser(req), params.data.branchId, reply))) return;
    try {
      return await pourReport(params.data.branchId, query.data.from, query.data.to);
    } catch (err) {
      return sendError(reply, err, 'Could not build report');
    }
  });
}
