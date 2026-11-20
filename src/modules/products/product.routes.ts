import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, getUser, assertBranchAccess } from '../../middleware/auth.guard.js';
import { sendError } from '../../lib/errors.js';
import { tenantOf } from '../menu/menu-access.js';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { branches } from '../../db/schema.js';
import { requirePermission, stripCost, userCan } from '../permissions/permission.service.js';
import {
  createProduct,
  getProductByBarcode,
  listCategories,
  listProducts,
  lookupMasterProduct,
  updateMrp,
  updateProduct,
  CreateProductSchema,
  UpdateMrpSchema,
  UpdateProductSchema,
} from './product.service.js';

const IdParams = z.object({ id: z.string().uuid() });

export async function productRoutes(fastify: FastifyInstance) {
  // GET /products — list all active products (cashier+)
  // Steward+ so floor staff can raise KOTs; cost price is commercial data and withheld from stewards.
  fastify.get('/products', {
    preHandler: requireRole('steward'),
  }, async (request, reply) => {
    const user = getUser(request);
    const query = request.query as { branchId?: string };
    const branchId = query?.branchId ?? user.branchId ?? undefined;
    // Stock levels and menu overrides are branch data: check access whenever a different branch is asked for
    if (branchId && branchId !== user.branchId && !(await assertBranchAccess(user, branchId, reply))) return;
    const list = await listProducts(true, await tenantOf(user), branchId);
    // Cost prices are for people who may see them (cost.view); everyone else only sees selling prices
    return (await userCan(user, 'cost.view')) ? list : stripCost(list);
  });

  // GET /products/barcode/:barcode — POS barcode lookup (cashier+)
  fastify.get('/products/barcode/:barcode', {
    preHandler: requireRole('cashier'),
  }, async (request, reply) => {
    const { barcode } = request.params as { barcode: string };
    const user = getUser(request);
    const product = await getProductByBarcode(barcode, await tenantOf(user));
    if (!product || !product.isActive) return reply.code(404).send({ error: 'Product not found' });
    return (await userCan(user, 'cost.view')) ? product : stripCost(product);
  });

  // GET /categories — list all active categories (steward+)
  fastify.get('/categories', { preHandler: requireRole('steward') }, async (request) => listCategories(await tenantOf(getUser(request))));

  // GET /master-products/lookup?exciseCode=5028&volumeMl=650 — master catalog lookup (cashier+)
  // Used by the "Add Missing Product" modal to auto-fill fields from the Telangana TSBCL ICDC catalog.
  fastify.get('/master-products/lookup', {
    preHandler: requireRole('cashier'),
  }, async (request, reply) => {
    const q = request.query as { exciseCode?: string; volumeMl?: string; state?: string };
    const exciseCode = (q.exciseCode ?? '').trim();
    const volumeMl = parseInt(q.volumeMl ?? '', 10);
    if (!exciseCode || isNaN(volumeMl) || volumeMl <= 0) {
      return reply.code(400).send({ error: 'exciseCode and volumeMl (integer > 0) are required' });
    }
    // The state comes from the caller's own branch (never trust a client-chosen one beyond a platform owner)
    const user = getUser(request);
    let state = 'TS';
    if (user.branchId) {
      const [b] = await db.select({ stateCode: branches.stateCode }).from(branches).where(eq(branches.id, user.branchId)).limit(1);
      state = b?.stateCode ?? state;
    } else if (q.state) state = q.state;
    const result = await lookupMasterProduct(exciseCode, volumeMl, state);
    if (!result) return reply.code(404).send({ error: 'Not found in master catalog' });
    return result;
  });

  // POST /products — create product (cashier+)
  fastify.post('/products', {
    preHandler: requireRole('cashier'),
  }, async (request, reply) => {
    const parsed = CreateProductSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    }
    try {
      const user = getUser(request);
      // Cost is a permission: writing it needs cost.view, otherwise the field is ignored
      const canCost = await userCan(user, 'cost.view');
      const product = await createProduct(canCost ? parsed.data : { ...parsed.data, costPrice: undefined }, await tenantOf(user));
      return reply.code(201).send(canCost ? product : stripCost(product));
    } catch (err: unknown) {
      return sendError(reply, err, 'Product creation failed');
    }
  });

  // PATCH /products/:id — update product details like name, brand, volume, pack size (cashier+)
  fastify.patch('/products/:id', {
    preHandler: requireRole('cashier'),
  }, async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'Product not found' });
    const parsed = UpdateProductSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    }
    const user = getUser(request);
    try {
      const updated = await updateProduct(params.data.id, parsed.data, await tenantOf(user));
      return reply.code(200).send((await userCan(user, 'cost.view')) ? updated : stripCost(updated));
    } catch (err: unknown) {
      return sendError(reply, err, 'Product update failed');
    }
  });

  // PATCH /products/:id/mrp — update MRP with price audit (needs the 'change selling prices' permission)
  fastify.patch('/products/:id/mrp', {
    preHandler: [requireRole('steward'), requirePermission('prices.edit')],
  }, async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'Product not found' });
    const parsed = UpdateMrpSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid MRP' });
    }
    const user = getUser(request);
    try {
      await updateMrp(params.data.id, parsed.data.mrp, user, await tenantOf(user));
      return { success: true };
    } catch (err: unknown) {
      return sendError(reply, err, 'Update failed');
    }
  });
}
