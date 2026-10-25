import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, getUser, assertBranchAccess } from '../../middleware/auth.guard.js';
import { sendError } from '../../lib/errors.js';
import {
  createBill,
  voidBill,
  getBillById,
  getBillHeader,
  listBills,
  CreateBillSchema,
  VoidBillSchema,
  ListBillsQuerySchema,
} from './billing.service.js';

const IdParamsSchema = z.object({ id: z.string().uuid() });

export async function billingRoutes(fastify: FastifyInstance) {
  // POST /bills — create a new bill (cashier+). 201 new, 200 idempotent replay (clientRef).
  fastify.post('/bills', {
    preHandler: requireRole('cashier'),
  }, async (request, reply) => {
    const user = getUser(request);
    const parsed = CreateBillSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    }

    if (!(await assertBranchAccess(user, parsed.data.branchId, reply))) return;

    try {
      const { bill, created } = await createBill(parsed.data, user);
      return reply.code(created ? 201 : 200).send(bill);
    } catch (err: unknown) {
      return sendError(reply, err, 'Bill creation failed');
    }
  });

  // GET /bills?branchId=&date=YYYY-MM-DD&status=&limit=&offset= — bill history (cashier+)
  fastify.get('/bills', {
    preHandler: requireRole('cashier'),
  }, async (request, reply) => {
    const parsed = ListBillsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    }
    const user = getUser(request);
    if (!(await assertBranchAccess(user, parsed.data.branchId, reply))) return;
    return listBills(parsed.data);
  });

  // GET /bills/:id — get bill with line items
  fastify.get('/bills/:id', {
    preHandler: requireRole('cashier'),
  }, async (request, reply) => {
    const params = IdParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'Bill not found' });
    const bill = await getBillById(params.data.id);
    if (!bill) return reply.code(404).send({ error: 'Bill not found' });

    const user = getUser(request);
    if (!(await assertBranchAccess(user, bill.branchId, reply))) return;

    return bill;
  });

  // POST /bills/:id/void — void a bill (manager+, own/accessible branch only)
  fastify.post('/bills/:id/void', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const params = IdParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'Bill not found' });
    const parsed = VoidBillSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'voidReason is required (min 5 chars)' });
    }

    const user = getUser(request);
    const bill = await getBillHeader(params.data.id);
    if (!bill) return reply.code(404).send({ error: 'Bill not found' });
    if (!(await assertBranchAccess(user, bill.branchId, reply))) return;

    try {
      await voidBill(params.data.id, parsed.data.voidReason, user);
      return { success: true };
    } catch (err: unknown) {
      return sendError(reply, err, 'Void failed');
    }
  });
}
