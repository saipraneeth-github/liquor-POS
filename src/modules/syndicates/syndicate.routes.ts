/**
 * syndicate.routes.ts — multi-tenant syndicate administration.
 *
 * GET   /syndicates                                   — platform owner: all; syndicate owner: own
 * POST  /syndicates                                   — platform owner
 * PATCH /syndicates/:id                               — platform owner
 * GET   /syndicates/:id/branches                      — platform owner or owner of that syndicate
 * POST  /syndicates/:id/branches/:branchId            — platform owner (assign branch)
 * POST  /syndicates/:id/consolidated-invoices         — platform owner or owner of that syndicate
 * GET   /syndicates/:id/consolidated-invoices         — platform owner or owner of that syndicate
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireRole, getUser, isPlatformOwner, getOwnedSyndicateId } from '../../middleware/auth.guard.js';
import { sendError } from '../../lib/errors.js';
import type { JwtPayload } from '../auth/auth.service.js';
import {
  listSyndicates,
  getSyndicate,
  createSyndicate,
  updateSyndicate,
  getSyndicateBranches,
  assignBranchToSyndicate,
  createConsolidatedInvoice,
  listConsolidatedInvoices,
  CreateSyndicateSchema,
  UpdateSyndicateSchema,
  ConsolidatedInvoiceSchema,
} from './syndicate.service.js';

const IdParams = z.object({ id: z.string().uuid() });
const AssignParams = z.object({ id: z.string().uuid(), branchId: z.string().uuid() });

async function requirePlatformOwner(user: JwtPayload, reply: FastifyReply): Promise<boolean> {
  if (await isPlatformOwner(user)) return true;
  reply.code(403).send({ error: 'Forbidden: platform owner only' });
  return false;
}

/** Platform owner, or the owner of this syndicate. */
async function assertSyndicateAccess(user: JwtPayload, syndicateId: string, reply: FastifyReply): Promise<boolean> {
  if (await isPlatformOwner(user)) return true;
  if ((await getOwnedSyndicateId(user)) === syndicateId) return true;
  reply.code(403).send({ error: 'Forbidden: no access to this syndicate' });
  return false;
}

export async function syndicateRoutes(fastify: FastifyInstance) {
  // All routes require an authenticated owner; finer checks per route.
  const ownerOnly = requireRole('owner');

  fastify.get('/syndicates', { preHandler: ownerOnly }, async (request, reply) => {
    const user = getUser(request);
    if (await isPlatformOwner(user)) return listSyndicates('ALL');
    const own = await getOwnedSyndicateId(user);
    if (!own) return reply.code(403).send({ error: 'Forbidden: not a syndicate owner' });
    return listSyndicates(own);
  });

  fastify.post('/syndicates', { preHandler: ownerOnly }, async (request, reply) => {
    const user = getUser(request);
    if (!(await requirePlatformOwner(user, reply))) return;
    const parsed = CreateSyndicateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    try {
      return reply.code(201).send(await createSyndicate(parsed.data));
    } catch (err) {
      return sendError(reply, err, 'Syndicate creation failed');
    }
  });

  fastify.patch('/syndicates/:id', { preHandler: ownerOnly }, async (request, reply) => {
    const user = getUser(request);
    if (!(await requirePlatformOwner(user, reply))) return;
    const params = IdParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'Syndicate not found' });
    const parsed = UpdateSyndicateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    try {
      return await updateSyndicate(params.data.id, parsed.data);
    } catch (err) {
      return sendError(reply, err, 'Syndicate update failed');
    }
  });

  fastify.get('/syndicates/:id/branches', { preHandler: ownerOnly }, async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'Syndicate not found' });
    const user = getUser(request);
    if (!(await assertSyndicateAccess(user, params.data.id, reply))) return;
    if (!(await getSyndicate(params.data.id))) return reply.code(404).send({ error: 'Syndicate not found' });
    return getSyndicateBranches(params.data.id);
  });

  fastify.post('/syndicates/:id/branches/:branchId', { preHandler: ownerOnly }, async (request, reply) => {
    const user = getUser(request);
    if (!(await requirePlatformOwner(user, reply))) return;
    const params = AssignParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'Not found' });
    try {
      return await assignBranchToSyndicate(params.data.id, params.data.branchId);
    } catch (err) {
      return sendError(reply, err, 'Branch assignment failed');
    }
  });

  fastify.post('/syndicates/:id/consolidated-invoices', { preHandler: ownerOnly }, async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'Syndicate not found' });
    const user = getUser(request);
    if (!(await assertSyndicateAccess(user, params.data.id, reply))) return;
    const parsed = ConsolidatedInvoiceSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    try {
      const invoice = await createConsolidatedInvoice(params.data.id, parsed.data.periodStart, parsed.data.periodEnd, user.sub);
      return reply.code(201).send(invoice);
    } catch (err) {
      return sendError(reply, err, 'Consolidated invoice failed');
    }
  });

  fastify.get('/syndicates/:id/consolidated-invoices', { preHandler: ownerOnly }, async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'Syndicate not found' });
    const user = getUser(request);
    if (!(await assertSyndicateAccess(user, params.data.id, reply))) return;
    return listConsolidatedInvoices(params.data.id);
  });
}
