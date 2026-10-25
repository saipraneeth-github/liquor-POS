import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, getUser, assertBranchAccess, getAccessibleBranchIds } from '../../middleware/auth.guard.js';
import { sendError } from '../../lib/errors.js';
import { isIsoDate } from '../../lib/business-day.js';
import { performDailyClosing, listDailyClosings } from './closing.service.js';

const SubmitClosingSchema = z.object({
  branchId: z.string().uuid(),
  openingCash: z.string().regex(/^\d+(\.\d{1,2})?$/),
  actualCashCounted: z.string().regex(/^\d+(\.\d{1,2})?$/),
  cashWithdrawals: z.string().regex(/^\d+(\.\d{1,2})?$/).optional().default('0'),
  notes: z.string().max(1000).optional(),
  businessDate: z.string().refine(isIsoDate, 'businessDate must be YYYY-MM-DD').optional(),
});

const ListClosingQuerySchema = z.object({
  branchId: z.string().uuid().optional(),
});

export async function closingRoutes(fastify: FastifyInstance) {
  // POST /closing — perform end-of-day closing (manager+)
  fastify.post('/closing', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const user = getUser(request);
    const parsed = SubmitClosingSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    }

    if (!(await assertBranchAccess(user, parsed.data.branchId, reply))) return;

    try {
      const record = await performDailyClosing(parsed.data, user);
      return reply.code(201).send(record);
    } catch (err: unknown) {
      return sendError(reply, err, 'Daily closing failed');
    }
  });

  // GET /closing?branchId= — list closing history for accessible branches (manager+)
  fastify.get('/closing', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const user = getUser(request);
    const parsed = ListClosingQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    }
    if (parsed.data.branchId) {
      if (!(await assertBranchAccess(user, parsed.data.branchId, reply))) return;
      return listDailyClosings([parsed.data.branchId]);
    }
    return listDailyClosings(await getAccessibleBranchIds(user));
  });
}
