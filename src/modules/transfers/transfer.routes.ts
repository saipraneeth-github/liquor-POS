import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, getUser, assertBranchAccess, canAccessBranch } from '../../middleware/auth.guard.js';
import { requirePermission } from '../permissions/permission.service.js';
import { sendError } from '../../lib/errors.js';
import {
  CancelTransferSchema, CreateTransferSchema, ListTransfersSchema, ReceiveTransferSchema,
  cancelTransfer, createTransfer, getTransfer, listTransfers, receiveTransfer, transferBranches, transferDestinations,
} from './transfer.service.js';

const IdParams = z.object({ id: z.string().uuid() });
const guard = { preHandler: [requireRole('steward'), requirePermission('stock.transfer')] };

/**
 * Stock transfers between the outlets of one business.
 *   POST /transfers              — dispatch (sender's outlet)
 *   GET  /transfers?branchId=    — sent by / due to this outlet
 *   GET  /transfers/:id
 *   POST /transfers/:id/receive  — receiver confirms (optionally with what actually arrived)
 *   POST /transfers/:id/cancel   — sender cancels while it is still in transit
 */
export async function transferRoutes(fastify: FastifyInstance) {
  fastify.post('/transfers', guard, async (request, reply) => {
    const body = CreateTransferSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'Validation failed', details: body.error.flatten() });
    const user = getUser(request);
    if (!(await assertBranchAccess(user, body.data.fromBranchId, reply))) return;   // you send from an outlet you work in
    try {
      return reply.code(201).send(await createTransfer(body.data, user));
    } catch (err) {
      return sendError(reply, err, 'Failed to create the transfer');
    }
  });

  fastify.get('/transfers', guard, async (request, reply) => {
    const q = ListTransfersSchema.safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: 'Validation failed', details: q.error.flatten() });
    if (!(await assertBranchAccess(getUser(request), q.data.branchId, reply))) return;
    try {
      return await listTransfers(q.data);
    } catch (err) {
      return sendError(reply, err, 'Failed to load transfers');
    }
  });

  fastify.get('/transfers/destinations', guard, async (request, reply) => {
    const q = z.object({ branchId: z.string().uuid() }).safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: 'branchId is required' });
    if (!(await assertBranchAccess(getUser(request), q.data.branchId, reply))) return;
    try {
      return await transferDestinations(q.data.branchId);
    } catch (err) {
      return sendError(reply, err, 'Failed to load outlets');
    }
  });

  fastify.get('/transfers/:id', guard, async (request, reply) => {
    const p = IdParams.safeParse(request.params);
    if (!p.success) return reply.code(404).send({ error: 'Transfer not found' });
    const ends = await transferBranches(p.data.id);
    if (!ends) return reply.code(404).send({ error: 'Transfer not found' });
    // either end may look at it
    const user = getUser(request);
    const fromOk = await canAccessBranch(user, ends.fromBranchId);
    if (!fromOk && !(await assertBranchAccess(user, ends.toBranchId, reply))) return;
    try {
      return await getTransfer(p.data.id);
    } catch (err) {
      return sendError(reply, err, 'Failed to load the transfer');
    }
  });

  fastify.post('/transfers/:id/receive', guard, async (request, reply) => {
    const p = IdParams.safeParse(request.params);
    const body = ReceiveTransferSchema.safeParse(request.body ?? {});
    if (!p.success) return reply.code(404).send({ error: 'Transfer not found' });
    if (!body.success) return reply.code(400).send({ error: 'Validation failed', details: body.error.flatten() });
    const ends = await transferBranches(p.data.id);
    if (!ends) return reply.code(404).send({ error: 'Transfer not found' });
    const user = getUser(request);
    if (!(await assertBranchAccess(user, ends.toBranchId, reply))) return;   // only the receiving outlet confirms receipt
    try {
      return await receiveTransfer(p.data.id, body.data, user);
    } catch (err) {
      return sendError(reply, err, 'Failed to receive the transfer');
    }
  });

  fastify.post('/transfers/:id/cancel', guard, async (request, reply) => {
    const p = IdParams.safeParse(request.params);
    const body = CancelTransferSchema.safeParse(request.body);
    if (!p.success) return reply.code(404).send({ error: 'Transfer not found' });
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'Validation failed' });
    const ends = await transferBranches(p.data.id);
    if (!ends) return reply.code(404).send({ error: 'Transfer not found' });
    const user = getUser(request);
    if (!(await assertBranchAccess(user, ends.fromBranchId, reply))) return;   // only the sending outlet cancels
    try {
      return await cancelTransfer(p.data.id, body.data.reason, user);
    } catch (err) {
      return sendError(reply, err, 'Failed to cancel the transfer');
    }
  });
}
