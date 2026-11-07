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

function formatValidationPayload(error: z.ZodError) {
  const flattened = error.flatten();
  const fieldEntries = Object.entries(flattened.fieldErrors) as [string, string[] | undefined][];
  const parts: string[] = [];
  if (flattened.formErrors.length) parts.push(...flattened.formErrors);
  for (const [field, msgs] of fieldEntries) {
    if (msgs?.length) parts.push(`${field}: ${msgs.join(', ')}`);
  }
  const summary = parts.length ? parts.join('; ') : 'Invalid input';
  return {
    error: `Validation failed: ${summary}`,
    message: `Validation failed: ${summary}`,
    details: flattened,
  };
}

export async function branchRoutes(fastify: FastifyInstance) {
  fastify.get('/branches', { preHandler: requireRole('steward') }, async (request) => {
    return listBranches(getUser(request));
  });

  fastify.post('/branches', { preHandler: requireRole('owner') }, async (request, reply) => {
    const parsed = CreateBranchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(formatValidationPayload(parsed.error));
    }
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
    if (!parsed.success) {
      return reply.code(400).send(formatValidationPayload(parsed.error));
    }
    try {
      return await updateBranch(getUser(request), params.data.id, parsed.data);
    } catch (err) {
      return sendError(reply, err, 'Branch update failed');
    }
  });
}
