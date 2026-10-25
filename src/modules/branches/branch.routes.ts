/**
 * branch.routes.ts — branch master data.
 *
 * GET   /branches        — any authenticated user (accessible branches only)
 * POST  /branches        — platform / syndicate owner
 * PATCH /branches/:id    — platform / syndicate owner (branch must be in scope)
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, getUser } from '../../middleware/auth.guard.js';
import { sendError } from '../../lib/errors.js';
import { listBranches, createBranch, updateBranch, CreateBranchSchema, UpdateBranchSchema } from './branch.service.js';

const IdParams = z.object({ id: z.string().uuid() });

export async function branchRoutes(fastify: FastifyInstance) {
  fastify.get('/branches', { preHandler: requireRole('steward') }, async (request) => {
    return listBranches(getUser(request));
  });

  fastify.post('/branches', { preHandler: requireRole('owner') }, async (request, reply) => {
    const parsed = CreateBranchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    try {
      return reply.code(201).send(await createBranch(getUser(request), parsed.data));
    } catch (err) {
      return sendError(reply, err, 'Branch creation failed');
    }
  });

  fastify.patch('/branches/:id', { preHandler: requireRole('owner') }, async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'Branch not found' });
    const parsed = UpdateBranchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    try {
      return await updateBranch(getUser(request), params.data.id, parsed.data);
    } catch (err) {
      return sendError(reply, err, 'Branch update failed');
    }
  });
}
