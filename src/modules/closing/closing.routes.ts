import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, getUser, assertBranchAccess } from '../../middleware/auth.guard.js';
import { performDailyClosing, listDailyClosings } from './closing.service.js';

const SubmitClosingSchema = z.object({
  branchId: z.string().uuid(),
  openingCash: z.string().regex(/^\d+(\.\d{1,2})?$/),
  actualCashCounted: z.string().regex(/^\d+(\.\d{1,2})?$/),
  cashWithdrawals: z.string().regex(/^\d+(\.\d{1,2})?$/).optional().default('0'),
  notes: z.string().optional(),
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

    if (!assertBranchAccess(user, parsed.data.branchId, reply)) return;

    try {
      const record = await performDailyClosing(parsed.data, user);
      return reply.code(201).send(record);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Daily closing failed';
      return reply.code(422).send({ error: msg });
    }
  });

  // GET /closing — list closing history (manager+)
  fastify.get('/closing', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const user = getUser(request);
    const branchId = user.role === 'owner' ? undefined : (user.branchId ?? undefined);
    const records = await listDailyClosings(branchId);
    return records;
  });
}
