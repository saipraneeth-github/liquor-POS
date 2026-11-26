import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, getUser, assertBranchAccess } from '../../middleware/auth.guard.js';
import { requirePermission } from '../permissions/permission.service.js';
import { sendError } from '../../lib/errors.js';
import { ListExpensesQuerySchema, RecordExpenseSchema, VoidExpenseSchema, expenseYearSummary, listExpenses, recordExpense, voidExpense } from './expense.service.js';
import { db } from '../../db/client.js';
import { expenses } from '../../db/schema.js';
import { eq } from 'drizzle-orm';

const BranchParamsSchema = z.object({ branchId: z.string().uuid() });

// ─── EXPENSE ROUTES (manager+, branch-scoped) ────────────────────────────────

export async function expenseRoutes(fastify: FastifyInstance) {
  fastify.get('/expenses/:branchId/summary', {
    preHandler: [requireRole('steward'), requirePermission('accounting.view')],
  }, async (request, reply) => {
    const params = BranchParamsSchema.safeParse(request.params);
    const query = z.object({ year: z.coerce.number().int().min(2000).max(2100) }).safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: 'Choose a valid year' });
    if (!(await assertBranchAccess(getUser(request), params.data.branchId, reply))) return;
    try { return await expenseYearSummary(params.data.branchId, query.data.year); }
    catch (err) { return sendError(reply, err, 'Failed to load expense totals'); }
  });
  // POST /expenses/:branchId — record an expense (posts a PAYMENT voucher)
  fastify.post('/expenses/:branchId', {
    preHandler: [requireRole('steward'), requirePermission('accounting.post')],
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

  // POST /expenses/:branchId/:id/void {reason} — void an expense (reversing voucher; never a delete)
  fastify.post('/expenses/:branchId/:id/void', {
    preHandler: [requireRole('steward'), requirePermission('accounting.post')],
  }, async (request, reply) => {
    const params = z.object({ branchId: z.string().uuid(), id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Validation failed', details: params.error.flatten() });
    const body = VoidExpenseSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'Validation failed', details: body.error.flatten() });
    const user = getUser(request);
    if (!(await assertBranchAccess(user, params.data.branchId, reply))) return;
    // the expense must belong to the branch named in the URL (that is the branch the access check was made for)
    const [owned] = await db.select({ branchId: expenses.branchId }).from(expenses).where(eq(expenses.id, params.data.id)).limit(1);
    if (!owned || owned.branchId !== params.data.branchId) return reply.code(404).send({ error: 'Expense not found' });
    try {
      return await voidExpense(params.data.id, body.data.reason, user);
    } catch (err) {
      return sendError(reply, err, 'Failed to void expense');
    }
  });

  // GET /expenses/:branchId?from=&to= — expenses with totals by category
  fastify.get('/expenses/:branchId', {
    preHandler: [requireRole('steward'), requirePermission('accounting.view')],
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
