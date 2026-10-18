import type { FastifyInstance } from 'fastify';
import { requireRole, getUser } from '../../middleware/auth.guard.js';
import {
  createProduct,
  getProductByBarcode,
  listProducts,
  updateMrp,
  CreateProductSchema,
  UpdateMrpSchema,
} from './product.service.js';

export async function productRoutes(fastify: FastifyInstance) {
  // GET /products — list all active products (cashier+)
  fastify.get('/products', {
    preHandler: requireRole('cashier'),
  }, async (request, reply) => {
    const products = await listProducts(true);
    return products;
  });

  // GET /products/barcode/:barcode — POS barcode lookup (cashier+)
  fastify.get('/products/barcode/:barcode', {
    preHandler: requireRole('cashier'),
  }, async (request, reply) => {
    const { barcode } = request.params as { barcode: string };
    const product = await getProductByBarcode(barcode);
    if (!product) return reply.code(404).send({ error: 'Product not found' });
    return product;
  });

  // POST /products — create product (manager+)
  fastify.post('/products', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const parsed = CreateProductSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    }
    const product = await createProduct(parsed.data);
    return reply.code(201).send(product);
  });

  // PATCH /products/:id/mrp — update MRP with price audit (manager+)
  fastify.patch('/products/:id/mrp', {
    preHandler: requireRole('manager'),
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = UpdateMrpSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid MRP' });
    }
    const user = getUser(request);
    try {
      await updateMrp(id, parsed.data.mrp, user);
      return { success: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Update failed';
      return reply.code(422).send({ error: msg });
    }
  });
}
