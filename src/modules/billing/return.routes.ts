import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, getUser, assertBranchAccess } from '../../middleware/auth.guard.js';
import { requirePermission } from '../permissions/permission.service.js';
import { sendError } from '../../lib/errors.js';
import { getBillHeader } from './billing.service.js';
import {
  PurchaseReturnSchema, SalesReturnSchema, createPurchaseReturn, createSalesReturn, listBillReturns, listPurchaseReturns,
} from './return.service.js';

const IdParams = z.object({ id: z.string().uuid() });

/**
 *   POST /bills/:id/returns   — customer returns bottles from a PAID bill (credit note; needs the "void bills" permission)
 *   GET  /bills/:id/returns   — returns made against the bill and how many of each line have come back
 *   POST /purchase-returns    — bottles sent back to a supplier (debit note; needs "approve supplier invoices")
 *   GET  /purchase-returns?branchId=
 */
export async function returnRoutes(fastify: FastifyInstance) {
  fastify.post('/bills/:id/returns', { preHandler: [requireRole('steward'), requirePermission('bills.void')] }, async (request, reply) => {
    const p = IdParams.safeParse(request.params);
    if (!p.success) return reply.code(404).send({ error: 'Bill not found' });
    const body = SalesReturnSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'Validation failed', details: body.error.flatten() });
    const user = getUser(request);
    const bill = await getBillHeader(p.data.id);
    if (!bill) return reply.code(404).send({ error: 'Bill not found' });
    if (!(await assertBranchAccess(user, bill.branchId, reply))) return;
    try {
      return reply.code(201).send(await createSalesReturn(p.data.id, body.data, user));
    } catch (err) {
      return sendError(reply, err, 'Failed to record the return');
    }
  });

  fastify.get('/bills/:id/returns', { preHandler: requireRole('cashier') }, async (request, reply) => {
    const p = IdParams.safeParse(request.params);
    if (!p.success) return reply.code(404).send({ error: 'Bill not found' });
    const bill = await getBillHeader(p.data.id);
    if (!bill) return reply.code(404).send({ error: 'Bill not found' });
    if (!(await assertBranchAccess(getUser(request), bill.branchId, reply))) return;
    try {
      return await listBillReturns(p.data.id);
    } catch (err) {
      return sendError(reply, err, 'Failed to load returns');
    }
  });

  fastify.post('/purchase-returns', { preHandler: [requireRole('steward'), requirePermission('invoices.approve')] }, async (request, reply) => {
    const body = PurchaseReturnSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'Validation failed', details: body.error.flatten() });
    const user = getUser(request);
    if (!(await assertBranchAccess(user, body.data.branchId, reply))) return;
    try {
      return reply.code(201).send(await createPurchaseReturn(body.data, user));
    } catch (err) {
      return sendError(reply, err, 'Failed to record the return');
    }
  });

  fastify.get('/purchase-returns', { preHandler: [requireRole('steward'), requirePermission('invoices.approve')] }, async (request, reply) => {
    const q = z.object({ branchId: z.string().uuid() }).safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: 'branchId is required' });
    if (!(await assertBranchAccess(getUser(request), q.data.branchId, reply))) return;
    try {
      return await listPurchaseReturns(q.data.branchId);
    } catch (err) {
      return sendError(reply, err, 'Failed to load returns');
    }
  });
}
