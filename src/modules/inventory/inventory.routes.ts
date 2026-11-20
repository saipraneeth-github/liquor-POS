import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, getUser, assertBranchAccess } from '../../middleware/auth.guard.js';
import { sendError } from '../../lib/errors.js';
import { logAudit } from '../../lib/audit.js';
import { stripCost, userCan } from '../permissions/permission.service.js';
import { tenantOf } from '../menu/menu-access.js';

const MONEY = z.string().regex(/^\d+(\.\d{1,2})?$/, 'must be a decimal string with up to 2dp');
import { requirePermission } from '../permissions/permission.service.js';
import { StockCountSchema, adjustStock } from './stock-adjust.service.js';
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
  // DELETE /inventory/stock/:branchId/clear — reset a branch's inventory (office admin / owner only)
  fastify.delete('/inventory/stock/:branchId/clear', {
    preHandler: requireRole('office_admin'),
  }, async (request, reply) => {
    const params = BranchParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid branchId' });
    const { branchId } = params.data;
    const user = getUser(request);
    if (!(await assertBranchAccess(user, branchId, reply))) return;

    try {
      const res = await clearCompleteInventory(branchId);
      await logAudit(user.sub, 'inventory.clear', { type: 'branch', id: branchId }, res);
      return reply.code(200).send({
        success: true,
        message: 'Complete inventory cleared successfully',
        ...res,
      });
    } catch (err: unknown) {
      return sendError(reply, err, 'Failed to clear inventory');
    }
  });

  // POST /inventory/stock/:branchId/adjust — stock-take: set the shop total of counted products to the physical count
  fastify.post('/inventory/stock/:branchId/adjust', {
    preHandler: [requireRole('steward'), requirePermission('stock.adjust')],
  }, async (request, reply) => {
    const params = BranchParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid branchId' });
    const body = StockCountSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'Validation failed', details: body.error.flatten() });
    const user = getUser(request);
    if (!(await assertBranchAccess(user, params.data.branchId, reply))) return;
    try {
      return await adjustStock(params.data.branchId, body.data, user);
    } catch (err) {
      return sendError(reply, err, 'Failed to adjust stock');
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
    // buying prices only for people who may see them; everyone else gets the selling side of the stock
    return (await userCan(user, 'cost.view')) ? stockList : stripCost(stockList);
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
  }, async (request, reply) => {
    const query = request.query as { branchId?: string };
    const user = getUser(request);
    // A branch's mappings need access to that branch; without one, the caller's own business's mappings
    if (query.branchId && query.branchId !== user.branchId && !(await assertBranchAccess(user, query.branchId, reply))) return;
    return getBrandCodeMappings(await tenantOf(user), query.branchId);
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
    const user = getUser(request);
    try {
      if (parsed.data.branchId && parsed.data.branchId !== user.branchId && !(await assertBranchAccess(user, parsed.data.branchId, reply))) return;
      // Cost is a permission: without cost.view the typed cost is ignored
      const canCost = await userCan(user, 'cost.view');
      const mapping = await upsertBrandCodeMapping(await tenantOf(user), canCost ? parsed.data : { ...parsed.data, costPrice: undefined });
      return reply.code(200).send(mapping);
    } catch (err) {
      return sendError(reply, err, 'Mapping failed');
    }
  });

  // DELETE /inventory/brand-mappings/:id — delete a brand code mapping
  fastify.delete('/inventory/brand-mappings/:id', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid id' });
    try {
      const res = await deleteBrandCodeMapping(await tenantOf(getUser(request)), params.data.id);
      return reply.code(200).send(res);
    } catch (err) {
      return sendError(reply, err, 'Delete failed');
    }
  });
}
