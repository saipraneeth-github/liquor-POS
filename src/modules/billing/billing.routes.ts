import type { FastifyInstance } from 'fastify';
import { requireRole, getUser, assertBranchAccess } from '../../middleware/auth.guard.js';
import {
  createBill,
  voidBill,
  getBillById,
  CreateBillSchema,
  VoidBillSchema,
} from './billing.service.js';

export async function billingRoutes(fastify: FastifyInstance) {
  // POST /bills — create a new bill (cashier+)
  fastify.post('/bills', {
    preHandler: requireRole('cashier'),
  }, async (request, reply) => {
    const user = getUser(request);
    const parsed = CreateBillSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    }

    if (!assertBranchAccess(user, parsed.data.branchId, reply)) return;

    try {
      const bill = await createBill(parsed.data, user);
      return reply.code(201).send(bill);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Bill creation failed';
      return reply.code(422).send({ error: msg });
    }
  });

  // GET /bills/:id — get bill with line items
  fastify.get('/bills/:id', {
    preHandler: requireRole('cashier'),
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const bill = await getBillById(id);
    if (!bill) return reply.code(404).send({ error: 'Bill not found' });

    const user = getUser(request);
    if (!assertBranchAccess(user, bill.branchId, reply)) return;

    return bill;
  });

  // POST /bills/:id/void — void a bill (manager+)
  fastify.post('/bills/:id/void', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = VoidBillSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'voidReason is required (min 5 chars)' });
    }

    const user = getUser(request);

    try {
      await voidBill(id, parsed.data.voidReason, user);
      return { success: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Void failed';
      return reply.code(422).send({ error: msg });
    }
  });
}
