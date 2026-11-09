import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, getUser, assertBranchAccess } from '../../middleware/auth.guard.js';
import { sendError } from '../../lib/errors.js';

const MONEY = z.string().regex(/^\d+(\.\d{1,2})?$/, 'must be a decimal string with up to 2dp');
import {
  getStockStatus,
  getBranchIndentEstimations,
  clearCompleteInventory,
  getBrandCodeMappings,
  upsertBrandCodeMapping,
  deleteBrandCodeMapping,
} from './inventory.service.js';

const BranchParams = z.object({ branchId: z.string().uuid() });

export async function inventoryRoutes(fastify: FastifyInstance) {
  // DELETE /inventory/stock/:branchId/clear — delete complete inventory for branch (manager+)
  fastify.delete('/inventory/stock/:branchId/clear', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const params = BranchParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid branchId' });
    const { branchId } = params.data;
    const user = getUser(request);
    if (!(await assertBranchAccess(user, branchId, reply))) return;

    try {
      const res = await clearCompleteInventory(branchId);
      return reply.code(200).send({
        success: true,
        message: 'Complete inventory cleared successfully',
        ...res,
      });
    } catch (err: unknown) {
      return sendError(reply, err, 'Failed to clear inventory');
    }
  });

  // GET /inventory/stock/:branchId — real-time stock levels with shortage alerts (cashier+)
  fastify.get('/inventory/stock/:branchId', {
    preHandler: requireRole('cashier'),
  }, async (request, reply) => {
    const params = BranchParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid branchId' });
    const { branchId } = params.data;
    const user = getUser(request);
    if (!(await assertBranchAccess(user, branchId, reply))) return;

    const stockList = await getStockStatus(branchId);
    return stockList;
  });

  // GET /inventory/indent/:branchId — auto indent estimation (manager+)
  fastify.get('/inventory/indent/:branchId', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const params = BranchParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid branchId' });
    const { branchId } = params.data;
    const user = getUser(request);
    if (!(await assertBranchAccess(user, branchId, reply))) return;

    const suggestions = await getBranchIndentEstimations(branchId);
    return suggestions;
  });

  // GET /inventory/brand-mappings — list brand code mappings
  fastify.get('/inventory/brand-mappings', {
    preHandler: requireRole('cashier'),
  }, async (request) => {
    const query = request.query as { branchId?: string };
    return getBrandCodeMappings(query.branchId);
  });

  // POST /inventory/brand-mappings — create or update a brand code mapping
  fastify.post('/inventory/brand-mappings', {
    preHandler: requireRole('cashier'),
  }, async (request, reply) => {
    const schema = z.object({
      brandCode: z.string().min(1),
      volumeMl: z.number().int().positive().optional().nullable(),
      productId: z.string().uuid().optional(),
      productName: z.string().optional(),
      categoryName: z.string().optional(),
      branchId: z.string().uuid().optional(),
      packQuantity: z.number().int().positive().optional(),
      mrp: MONEY.optional(),
      costPrice: MONEY.optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    }
    const mapping = await upsertBrandCodeMapping(parsed.data);
    return reply.code(200).send(mapping);
  });

  // DELETE /inventory/brand-mappings/:id — delete a brand code mapping
  fastify.delete('/inventory/brand-mappings/:id', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid id' });
    const res = await deleteBrandCodeMapping(params.data.id);
    return reply.code(200).send(res);
  });
}
