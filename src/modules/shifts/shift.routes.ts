/**
 * shift.routes.ts — cashier shifts on POS terminals.
 *
 * POST /shifts/open        — cashier+ ({ terminalId, openingFloat }; one OPEN shift per cashier & terminal)
 * GET  /shifts/current     — cashier+ (caller's open shift with live totals, or { shift: null })
 * POST /shifts/:id/close   — cashier+ (shift owner, or manager+ of that branch; { denominations, notes? })
 * GET  /shifts             — manager+ (?branchId=&date=&status=)
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, getUser, assertBranchAccess } from '../../middleware/auth.guard.js';
import { sendError } from '../../lib/errors.js';
import {
  openShift,
  getCurrentShift,
  closeShift,
  listShifts,
  OpenShiftSchema,
  CloseShiftSchema,
  ListShiftsQuerySchema,
} from './shift.service.js';

const IdParams = z.object({ id: z.string().uuid() });

export async function shiftRoutes(fastify: FastifyInstance) {
  fastify.post('/shifts/open', { preHandler: requireRole('cashier') }, async (request, reply) => {
    const parsed = OpenShiftSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    try {
      const shift = await openShift(getUser(request), parsed.data);
      return reply.code(201).send(shift);
    } catch (err) {
      return sendError(reply, err, 'Shift open failed');
    }
  });

  fastify.get('/shifts/current', { preHandler: requireRole('cashier') }, async (request, reply) => {
    try {
      return { shift: await getCurrentShift(getUser(request)) };
    } catch (err) {
      return sendError(reply, err, 'Shift lookup failed');
    }
  });

  fastify.post('/shifts/:id/close', { preHandler: requireRole('cashier') }, async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'Shift not found' });
    const parsed = CloseShiftSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    try {
      return await closeShift(getUser(request), params.data.id, parsed.data);
    } catch (err) {
      return sendError(reply, err, 'Shift close failed');
    }
  });

  fastify.get('/shifts', { preHandler: requireRole('manager') }, async (request, reply) => {
    const parsed = ListShiftsQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    const user = getUser(request);
    const branchId = parsed.data.branchId ?? user.branchId;
    if (!branchId) return reply.code(400).send({ error: 'branchId is required' });
    if (!(await assertBranchAccess(user, branchId, reply))) return;
    try {
      return await listShifts(branchId, parsed.data);
    } catch (err) {
      return sendError(reply, err, 'Shift listing failed');
    }
  });
}
