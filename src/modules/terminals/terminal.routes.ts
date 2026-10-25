/**
 * terminal.routes.ts — POS terminals (billing counters) per branch.
 *
 * GET   /terminals/:branchId   — cashier+ (deviceKey only returned to manager+)
 * POST  /terminals/:branchId   — manager+ ({ terminalName, deviceKey? }; random deviceKey if absent)
 * PATCH /terminals/:id         — manager+ ({ terminalName?, isActive? })
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, getUser, assertBranchAccess, roleRank, ROLE_RANK } from '../../middleware/auth.guard.js';
import { sendError } from '../../lib/errors.js';
import {
  listTerminals,
  getTerminal,
  createTerminal,
  updateTerminal,
  CreateTerminalSchema,
  UpdateTerminalSchema,
} from './terminal.service.js';

const BranchParams = z.object({ branchId: z.string().uuid() });
const IdParams = z.object({ id: z.string().uuid() });

export async function terminalRoutes(fastify: FastifyInstance) {
  // Cashiers need the list to pick a terminal when opening a shift; the device key stays manager-only.
  fastify.get('/terminals/:branchId', { preHandler: requireRole('cashier') }, async (request, reply) => {
    const params = BranchParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid branchId' });
    const user = getUser(request);
    if (!(await assertBranchAccess(user, params.data.branchId, reply))) return;
    try {
      const rows = await listTerminals(params.data.branchId);
      if (roleRank(user.role) >= ROLE_RANK.manager) return rows;
      return rows.map(({ deviceKey: _deviceKey, ...rest }) => rest);
    } catch (err) {
      return sendError(reply, err, 'Terminal listing failed');
    }
  });

  fastify.post('/terminals/:branchId', { preHandler: requireRole('manager') }, async (request, reply) => {
    const params = BranchParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid branchId' });
    const parsed = CreateTerminalSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    if (!(await assertBranchAccess(getUser(request), params.data.branchId, reply))) return;
    try {
      const terminal = await createTerminal(params.data.branchId, parsed.data);
      return reply.code(201).send(terminal);
    } catch (err) {
      return sendError(reply, err, 'Terminal creation failed');
    }
  });

  fastify.patch('/terminals/:id', { preHandler: requireRole('manager') }, async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'Terminal not found' });
    const parsed = UpdateTerminalSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    try {
      const existing = await getTerminal(params.data.id);
      if (!existing) return reply.code(404).send({ error: 'Terminal not found' });
      if (!(await assertBranchAccess(getUser(request), existing.branchId, reply))) return;
      return await updateTerminal(params.data.id, parsed.data);
    } catch (err) {
      return sendError(reply, err, 'Terminal update failed');
    }
  });
}
