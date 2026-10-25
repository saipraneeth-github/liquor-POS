import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, getUser, assertBranchAccess } from '../../middleware/auth.guard.js';
import { sendError } from '../../lib/errors.js';
import { ListExpensesQuerySchema, RecordExpenseSchema, listExpenses, recordExpense } from './expense.service.js';

const BranchParamsSchema = z.object({ branchId: z.string().uuid() });

// ─── EXPENSE ROUTES (manager+, branch-scoped) ────────────────────────────────

export async function expenseRoutes(fastify: FastifyInstance) {
  // POST /expenses/:branchId — record an expense (posts a PAYMENT voucher)
  fastify.post('/expenses/:branchId', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const params = BranchParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Validation failed', details: params.error.flatten() });
    const body = RecordExpenseSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Validation failed', details: body.error.flatten() });

    const user = getUser(request);
    if (!(await assertBranchAccess(user, params.data.branchId, reply))) return;
    try {
      return reply.code(201).send(await recordExpense(params.data.branchId, body.data, user));
    } catch (err) {
      return sendError(reply, err, 'Failed to record expense');
    }
  });

  // GET /expenses/:branchId?from=&to= — expenses with totals by category
  fastify.get('/expenses/:branchId', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const params = BranchParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Validation failed', details: params.error.flatten() });
    const query = ListExpensesQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'Validation failed', details: query.error.flatten() });

    if (!(await assertBranchAccess(getUser(request), params.data.branchId, reply))) return;
    try {
      return await listExpenses(params.data.branchId, query.data);
    } catch (err) {
      return sendError(reply, err, 'Failed to load expenses');
    }
  });
}
