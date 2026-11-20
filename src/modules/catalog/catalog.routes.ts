import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { requireRole, getUser, assertBranchAccess } from '../../middleware/auth.guard.js';
import { sendError } from '../../lib/errors.js';
import { tenantOf } from '../menu/menu-access.js';
import { requirePermission, stripCost, userCan } from '../permissions/permission.service.js';
import {
  applyMasterUpdates, branchTenantId, listMasterCatalog, listMasterUpdates, listPricing, mapMasterProducts, masterCategories, masterIdsFor, masterStates, requireTenantId,
  setBranchPrices, setTenantPrices,
} from './catalog.service.js';

const Uuid = z.string().uuid();
const BranchQuery = z.object({ branchId: Uuid.optional() });
const MONEY = z.string().trim().regex(/^\d{1,10}(\.\d{1,2})?$/, 'price must be a decimal string with up to 2dp').refine((v) => Number(v) > 0, 'price must be above zero');

const PriceRows = z.array(z.object({
  productId: Uuid.optional(),
  sku: z.string().trim().min(1).max(64).optional(),
  barcode: z.string().trim().min(1).max(64).optional(),
  price: MONEY.nullable(),
}).refine((r) => r.productId || r.sku || r.barcode, 'Each row needs a productId, sku or barcode')).min(1).max(2000);

/**
 * Master catalog → business mapping and the business's prices.
 *   GET  /catalog/master?branchId=&q=&category=&mapped=&limit=&offset=      the state's master products, flagged mapped / needs price (no prices)
 *   GET  /catalog/master/categories?branchId=
 *   POST /catalog/master/map {masterProductIds?|categoryNames?|all?}        map to the business (manager); creates UNPRICED products
 *   GET  /catalog/pricing?branchId=&q=&unpricedOnly=                        price grid: business price + the branch's override
 *   PUT  /catalog/prices {rows}                                              business-wide prices (prices.edit)
 *   PUT  /catalog/branches/:branchId/prices {rows:[{…,saleTypeId?,price|null}]}   a branch's own prices (prices.edit); null removes
 */
export async function catalogRoutes(fastify: FastifyInstance) {
  /** The caller's business and the state whose master catalog applies (from the branch asked for, else their own). */
  async function context(request: FastifyRequest, reply: FastifyReply, branchId?: string) {
    const user = getUser(request);
    const id = branchId ?? user.branchId ?? undefined;
    if (id) {
      if (id !== user.branchId && !(await assertBranchAccess(user, id, reply))) return null;
      const b = await branchTenantId(db, id);
      return { user, tenantId: b.syndicateId, stateCode: b.stateCode, branchId: id };
    }
    return { user, tenantId: requireTenantId(await tenantOf(user)), stateCode: 'TS', branchId: null as string | null };
  }

  fastify.get('/catalog/master', { preHandler: requireRole('cashier') }, async (request, reply) => {
    const q = BranchQuery.merge(z.object({
      q: z.string().max(100).optional(), category: z.string().max(60).optional(),
      state: z.string().max(10).optional(), priceStatus: z.enum(['all', 'priced', 'unpriced']).optional(),
      mapped: z.enum(['0', '1']).optional(), limit: z.coerce.number().int().min(1).max(500).optional(), offset: z.coerce.number().int().min(0).optional(),
    })).safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: 'Validation failed', details: q.error.flatten() });
    try {
      const c = await context(request, reply, q.data.branchId);
      if (!c) return;
      const targetState = q.data.state?.trim().toUpperCase() || c.stateCode;
      return await listMasterCatalog(c.tenantId, targetState, {
        q: q.data.q, category: q.data.category, stateCode: targetState, priceStatus: q.data.priceStatus,
        limit: q.data.limit, offset: q.data.offset,
        mapped: q.data.mapped === undefined ? undefined : q.data.mapped === '1',
      });
    } catch (err) { return sendError(reply, err, 'Catalog lookup failed'); }
  });

  fastify.get('/catalog/master/states', { preHandler: requireRole('cashier') }, async (request, reply) => {
    try {
      return await masterStates();
    } catch (err) { return sendError(reply, err, 'Failed to fetch states'); }
  });

  fastify.get('/catalog/master/categories', { preHandler: requireRole('cashier') }, async (request, reply) => {
    const q = BranchQuery.merge(z.object({ state: z.string().max(10).optional() })).safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: 'Validation failed' });
    try {
      const c = await context(request, reply, q.data.branchId);
      if (!c) return;
      const targetState = q.data.state?.trim().toUpperCase() || c.stateCode;
      return await masterCategories(targetState);
    } catch (err) { return sendError(reply, err, 'Catalog lookup failed'); }
  });

  fastify.post('/catalog/master/map', { preHandler: requireRole('manager') }, async (request, reply) => {
    const body = z.object({
      branchId: Uuid.optional(),
      masterProductIds: z.array(Uuid).max(2000).optional(),
      categoryNames: z.array(z.string().min(1).max(60)).max(30).optional(),
      all: z.boolean().optional(),
    }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Validation failed', details: body.error.flatten() });
    try {
      const c = await context(request, reply, body.data.branchId);
      if (!c) return;
      const ids = [...(body.data.masterProductIds ?? []), ...(await masterIdsFor(c.stateCode, { categoryNames: body.data.categoryNames, all: body.data.all }))];
      if (ids.length === 0) return reply.code(400).send({ error: 'Choose master products, categories or all' });
      return reply.code(201).send(await db.transaction((tx) => mapMasterProducts(tx, c.tenantId, ids)));
    } catch (err) { return sendError(reply, err, 'Could not add products from the master catalog'); }
  });

  // Products whose master entry changed since the business added them ("update available"), and applying those changes
  fastify.get('/catalog/master/updates', { preHandler: requireRole('cashier') }, async (request, reply) => {
    const q = BranchQuery.safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: 'Validation failed' });
    try {
      const c = await context(request, reply, q.data.branchId);
      if (!c) return;
      return await listMasterUpdates(c.tenantId);
    } catch (err) { return sendError(reply, err, 'Could not check for updates'); }
  });

  fastify.post('/catalog/master/updates/apply', { preHandler: requireRole('manager') }, async (request, reply) => {
    const body = z.object({ branchId: Uuid.optional(), productIds: z.array(Uuid).max(2000).optional() }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Validation failed', details: body.error.flatten() });
    try {
      const c = await context(request, reply, body.data.branchId);
      if (!c) return;
      return await applyMasterUpdates(c.tenantId, body.data.productIds);   // no ids = every product with an update
    } catch (err) { return sendError(reply, err, 'Could not apply the updates'); }
  });

  fastify.get('/catalog/pricing', { preHandler: requireRole('manager') }, async (request, reply) => {
    const q = BranchQuery.merge(z.object({
      q: z.string().max(100).optional(), unpricedOnly: z.enum(['0', '1']).optional(),
      inStockOnly: z.enum(['0', '1']).optional(),
      limit: z.coerce.number().int().min(1).max(2000).optional(), offset: z.coerce.number().int().min(0).optional(),
    })).safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: 'Validation failed', details: q.error.flatten() });
    try {
      const c = await context(request, reply, q.data.branchId);
      if (!c) return;
      const res = await listPricing(c.tenantId, c.branchId, {
        q: q.data.q,
        unpricedOnly: q.data.unpricedOnly === '1',
        inStockOnly: q.data.inStockOnly === '1',
        limit: q.data.limit,
        offset: q.data.offset,
      });
      return (await userCan(c.user, 'cost.view')) ? res : stripCost(res);
    } catch (err) { return sendError(reply, err, 'Pricing lookup failed'); }
  });

  fastify.put('/catalog/prices', { preHandler: [requireRole('manager'), requirePermission('prices.edit')] }, async (request, reply) => {
    const body = z.object({ branchId: Uuid.optional(), rows: PriceRows }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Validation failed', details: body.error.flatten() });
    try {
      const c = await context(request, reply, body.data.branchId);
      if (!c) return;
      return await setTenantPrices(c.tenantId, c.user, body.data.rows);
    } catch (err) { return sendError(reply, err, 'Price update failed'); }
  });

  fastify.put('/catalog/branches/:branchId/prices', { preHandler: [requireRole('manager'), requirePermission('prices.edit')] }, async (request, reply) => {
    const params = z.object({ branchId: Uuid }).safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'Branch not found' });
    const body = z.object({
      rows: z.array(z.object({
        productId: Uuid.optional(), sku: z.string().trim().min(1).max(64).optional(), barcode: z.string().trim().min(1).max(64).optional(),
        saleTypeId: Uuid.nullable().optional(), price: MONEY.nullable(),
      }).refine((r) => r.productId || r.sku || r.barcode, 'Each row needs a productId, sku or barcode')).min(1).max(2000),
    }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Validation failed', details: body.error.flatten() });
    try {
      const c = await context(request, reply, params.data.branchId);
      if (!c) return;
      return await setBranchPrices(c.tenantId, params.data.branchId, c.user, body.data.rows);
    } catch (err) { return sendError(reply, err, 'Branch price update failed'); }
  });
}
