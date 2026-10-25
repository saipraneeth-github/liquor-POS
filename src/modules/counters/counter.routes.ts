/**
 * counter.routes.ts — daily counter sheets (sales derived from stock counts).
 *
 * POST /counter-sheets/:branchId             — cashier+ ({ sheetDate }; creates DRAFT, 409 if exists)
 * GET  /counter-sheets/:branchId?date=       — cashier+ (sheets of a branch)
 * GET  /counter-sheets/sheet/:id             — cashier+ (sheet with lines + product names)
 * PUT  /counter-sheets/sheet/:id/lines       — cashier+ (DRAFT only; manager+ may approveAdjustment or change inward)
 * POST /counter-sheets/sheet/:id/post        — manager+ (DRAFT → POSTED; stock corrected to the closing counts as of the sheet day)
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireRole, getUser, assertBranchAccess } from '../../middleware/auth.guard.js';
import { sendError } from '../../lib/errors.js';
import {
  createSheet,
  listSheets,
  getSheet,
  getSheetRow,
  updateSheetLines,
  postSheet,
  CreateSheetSchema,
  ListSheetsQuerySchema,
  UpdateLinesSchema,
} from './counter.service.js';

const BranchParams = z.object({ branchId: z.string().uuid() });
const IdParams = z.object({ id: z.string().uuid() });

/** Resolves :id to a sheet the caller may access; sends 404/403 and returns null otherwise. */
async function loadAccessibleSheet(request: FastifyRequest, reply: FastifyReply) {
  const params = IdParams.safeParse(request.params);
  if (!params.success) { reply.code(404).send({ error: 'Counter sheet not found' }); return null; }
  const sheet = await getSheetRow(params.data.id);
  if (!sheet) { reply.code(404).send({ error: 'Counter sheet not found' }); return null; }
  if (!(await assertBranchAccess(getUser(request), sheet.branchId, reply))) return null;
  return sheet;
}

export async function counterSheetRoutes(fastify: FastifyInstance) {
  fastify.post('/counter-sheets/:branchId', { preHandler: requireRole('cashier') }, async (request, reply) => {
    const params = BranchParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid branchId' });
    const parsed = CreateSheetSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    const user = getUser(request);
    if (!(await assertBranchAccess(user, params.data.branchId, reply))) return;
    try {
      const sheet = await createSheet(user, params.data.branchId, parsed.data.sheetDate);
      return reply.code(201).send(sheet);
    } catch (err) {
      return sendError(reply, err, 'Counter sheet creation failed');
    }
  });

  fastify.get('/counter-sheets/sheet/:id', { preHandler: requireRole('cashier') }, async (request, reply) => {
    try {
      const sheet = await loadAccessibleSheet(request, reply);
      if (!sheet) return;
      return await getSheet(sheet.id);
    } catch (err) {
      return sendError(reply, err, 'Counter sheet lookup failed');
    }
  });

  fastify.get('/counter-sheets/:branchId', { preHandler: requireRole('cashier') }, async (request, reply) => {
    const params = BranchParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid branchId' });
    const query = ListSheetsQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'Validation failed', details: query.error.flatten() });
    if (!(await assertBranchAccess(getUser(request), params.data.branchId, reply))) return;
    try {
      return await listSheets(params.data.branchId, query.data.date);
    } catch (err) {
      return sendError(reply, err, 'Counter sheet listing failed');
    }
  });

  fastify.put('/counter-sheets/sheet/:id/lines', { preHandler: requireRole('cashier') }, async (request, reply) => {
    const parsed = UpdateLinesSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    try {
      const sheet = await loadAccessibleSheet(request, reply);
      if (!sheet) return;
      return await updateSheetLines(getUser(request), sheet.id, parsed.data);
    } catch (err) {
      return sendError(reply, err, 'Counter sheet update failed');
    }
  });

  fastify.post('/counter-sheets/sheet/:id/post', { preHandler: requireRole('manager') }, async (request, reply) => {
    try {
      const sheet = await loadAccessibleSheet(request, reply);
      if (!sheet) return;
      return await postSheet(getUser(request), sheet.id);
    } catch (err) {
      return sendError(reply, err, 'Counter sheet posting failed');
    }
  });
}
