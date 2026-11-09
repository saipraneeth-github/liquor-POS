import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { requireRole, getUser, assertBranchAccess } from '../../middleware/auth.guard.js';
import { sendError } from '../../lib/errors.js';
import { businessDateOf } from '../../lib/business-day.js';
import { syncDraftSheetsFor } from '../counters/counter.service.js';
import { rowTypeId } from './saletype.engine.js';
import {
  CreateSaleTypeSchema, SetAllocationSchema, SetPricesSchema, TransferSchema, UpdateSaleTypeSchema,
  createSaleType, getPriceMatrix, listBranchSaleTypes, listCounters, resolveSaleType, setAllocation, setPrices, transferStock, updateSaleType,
} from './saletype.service.js';

const BranchParams = z.object({ branchId: z.string().uuid() });
const TypeParams = z.object({ branchId: z.string().uuid(), id: z.string().uuid() });

export async function saleTypeRoutes(fastify: FastifyInstance) {
  // GET /sale-types/:branchId — the types this shop sells under (?all=1 for the settings screen: includes switched-off ones)
  fastify.get('/sale-types/:branchId', { preHandler: requireRole('steward') }, async (request, reply) => {
    const params = BranchParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid branchId' });
    const user = getUser(request);
    if (!(await assertBranchAccess(user, params.data.branchId, reply))) return;
    const all = (request.query as { all?: string })?.all === '1';
    try {
      return await listBranchSaleTypes(db, params.data.branchId, { all });
    } catch (err) { return sendError(reply, err); }
  });

  // POST /sale-types/:branchId — add a sale type to this shop's business (manager+)
  fastify.post('/sale-types/:branchId', { preHandler: requireRole('manager') }, async (request, reply) => {
    const params = BranchParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid branchId' });
    const body = CreateSaleTypeSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Validation failed', details: body.error.flatten() });
    if (!(await assertBranchAccess(getUser(request), params.data.branchId, reply))) return;
    try { return reply.code(201).send(await createSaleType(params.data.branchId, body.data)); } catch (err) { return sendError(reply, err); }
  });

  // PATCH /sale-types/:branchId/:id — rename, reorder, switch off, or switch on/off for this shop (manager+)
  fastify.patch('/sale-types/:branchId/:id', { preHandler: requireRole('manager') }, async (request, reply) => {
    const params = TypeParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid id' });
    const body = UpdateSaleTypeSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Validation failed', details: body.error.flatten() });
    if (!(await assertBranchAccess(getUser(request), params.data.branchId, reply))) return;
    try { return await updateSaleType(params.data.branchId, params.data.id, body.data); } catch (err) { return sendError(reply, err); }
  });

  // GET /sale-types/:branchId/prices — every retail product with its default price (MRP) and a price per other type
  fastify.get('/sale-types/:branchId/prices', { preHandler: requireRole('cashier') }, async (request, reply) => {
    const params = BranchParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid branchId' });
    if (!(await assertBranchAccess(getUser(request), params.data.branchId, reply))) return;
    try { return await getPriceMatrix(params.data.branchId); } catch (err) { return sendError(reply, err); }
  });

  // PUT /sale-types/:branchId/prices — set / clear prices for the non-default types (manager+)
  fastify.put('/sale-types/:branchId/prices', { preHandler: requireRole('manager') }, async (request, reply) => {
    const params = BranchParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid branchId' });
    const body = SetPricesSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Validation failed', details: body.error.flatten() });
    const user = getUser(request);
    if (!(await assertBranchAccess(user, params.data.branchId, reply))) return;
    try { return await setPrices(user, params.data.branchId, body.data); } catch (err) { return sendError(reply, err); }
  });

  // GET /sale-types/:branchId/stock — bottles per product in each counter
  fastify.get('/sale-types/:branchId/stock', { preHandler: requireRole('cashier') }, async (request, reply) => {
    const params = BranchParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid branchId' });
    if (!(await assertBranchAccess(getUser(request), params.data.branchId, reply))) return;
    try { return await listCounters(params.data.branchId); } catch (err) { return sendError(reply, err); }
  });

  // PUT /sale-types/:branchId/allocation — divide the stock: how many bottles each non-default counter holds (manager+)
  fastify.put('/sale-types/:branchId/allocation', { preHandler: requireRole('manager') }, async (request, reply) => {
    const params = BranchParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid branchId' });
    const body = SetAllocationSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Validation failed', details: body.error.flatten() });
    const user = getUser(request);
    if (!(await assertBranchAccess(user, params.data.branchId, reply))) return;
    try {
      const result = await setAllocation(user, params.data.branchId, body.data);
      await syncDraftSheetsFor(params.data.branchId, businessDateOf(), [null, ...result.typeIds]);
      return result;
    } catch (err) { return sendError(reply, err); }
  });

  // POST /sale-types/:branchId/transfer — move bottles between two counters of this shop (manager+)
  fastify.post('/sale-types/:branchId/transfer', { preHandler: requireRole('manager') }, async (request, reply) => {
    const params = BranchParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid branchId' });
    const body = TransferSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Validation failed', details: body.error.flatten() });
    const user = getUser(request);
    if (!(await assertBranchAccess(user, params.data.branchId, reply))) return;
    try {
      const result = await transferStock(user, params.data.branchId, body.data);
      // Today's open counter sheets of both counters pick the move up as "transfer"
      const from = await resolveSaleType(db, params.data.branchId, body.data.fromSaleTypeId);
      const to = await resolveSaleType(db, params.data.branchId, body.data.toSaleTypeId);
      await syncDraftSheetsFor(params.data.branchId, businessDateOf(), [rowTypeId(from), rowTypeId(to)]);
      return reply.code(201).send(result);
    } catch (err) { return sendError(reply, err); }
  });
}
