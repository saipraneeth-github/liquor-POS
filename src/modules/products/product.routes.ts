import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, getUser } from '../../middleware/auth.guard.js';
import { sendError } from '../../lib/errors.js';
import { tenantOf } from '../menu/menu-access.js';
import {
  createProduct,
  getProductByBarcode,
  listCategories,
  listProducts,
  updateMrp,
  CreateProductSchema,
  UpdateMrpSchema,
} from './product.service.js';

const IdParams = z.object({ id: z.string().uuid() });

export async function productRoutes(fastify: FastifyInstance) {
  // GET /products — list all active products (cashier+)
  // Steward+ so floor staff can raise KOTs; cost price is commercial data and withheld from stewards.
  fastify.get('/products', {
    preHandler: requireRole('steward'),
  }, async (request) => {
    const user = getUser(request);
    const list = await listProducts(true, await tenantOf(user), user.branchId ?? undefined);
    if (user.role !== 'steward') return list;
    return list.map(({ costPrice: _costPrice, ...rest }) => rest);
  });

  // GET /products/barcode/:barcode — POS barcode lookup (cashier+)
  fastify.get('/products/barcode/:barcode', {
    preHandler: requireRole('cashier'),
  }, async (request, reply) => {
    const { barcode } = request.params as { barcode: string };
    const product = await getProductByBarcode(barcode, await tenantOf(getUser(request)));
    if (!product || !product.isActive) return reply.code(404).send({ error: 'Product not found' });
    return product;
  });

  // GET /categories — list all active categories (steward+)
  fastify.get('/categories', { preHandler: requireRole('steward') }, async () => listCategories());

  // POST /products — create product (cashier+)
  fastify.post('/products', {
    preHandler: requireRole('cashier'),
  }, async (request, reply) => {
    const parsed = CreateProductSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    }
    try {
      const product = await createProduct(parsed.data, await tenantOf(getUser(request)));
      return reply.code(201).send(product);
    } catch (err: unknown) {
      return sendError(reply, err, 'Product creation failed');
    }
  });

  // PATCH /products/:id/mrp — update MRP with price audit (manager+)
  fastify.patch('/products/:id/mrp', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const params = IdParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'Product not found' });
    const parsed = UpdateMrpSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid MRP' });
    }
    const user = getUser(request);
    try {
      await updateMrp(params.data.id, parsed.data.mrp, user);
      return { success: true };
    } catch (err: unknown) {
      return sendError(reply, err, 'Update failed');
    }
  });
}
