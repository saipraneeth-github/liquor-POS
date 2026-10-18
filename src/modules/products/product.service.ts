import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { db } from '../../db/client.js';
import { products, categories, priceAudit } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import type { JwtPayload } from '../auth/auth.service.js';

// ─── SCHEMAS ────────────────────────────────────────────────────────────────

export const CreateProductSchema = z.object({
  categoryId:  z.string().uuid(),
  barcode:     z.string().optional(),
  sku:         z.string().optional(),
  name:        z.string().min(1),
  brand:       z.string().min(1),
  volumeMl:    z.number().int().positive().optional(),
  mrp:         z.string().regex(/^\d+(\.\d{1,2})?$/, 'MRP must be a decimal string'),
  costPrice:   z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
});

export const UpdateMrpSchema = z.object({
  mrp: z.string().regex(/^\d+(\.\d{1,2})?$/, 'MRP must be a decimal string'),
});

export type CreateProductInput = z.infer<typeof CreateProductSchema>;

// ─── PRODUCT SERVICE ─────────────────────────────────────────────────────────

export async function createProduct(input: CreateProductInput) {
  const [product] = await db.insert(products).values({
    categoryId: input.categoryId,
    barcode:    input.barcode,
    sku:        input.sku,
    name:       input.name,
    brand:      input.brand,
    volumeMl:   input.volumeMl,
    mrp:        input.mrp,
    costPrice:  input.costPrice,
  }).returning();
  return product;
}

export async function getProductByBarcode(barcode: string) {
  const [product] = await db
    .select()
    .from(products)
    .where(eq(products.barcode, barcode))
    .limit(1);
  return product ?? null;
}

export async function getProductById(id: string) {
  const [product] = await db
    .select()
    .from(products)
    .where(eq(products.id, id))
    .limit(1);
  return product ?? null;
}

export async function updateMrp(
  productId: string,
  newMrp: string,
  user: JwtPayload,
): Promise<void> {
  const existing = await getProductById(productId);
  if (!existing) throw new Error(`Product ${productId} not found`);

  await db.transaction(async (tx) => {
    await tx.update(products)
      .set({ mrp: newMrp })
      .where(eq(products.id, productId));

    // Write price audit (append-only)
    await tx.insert(priceAudit).values({
      productId,
      userId:  user.sub,
      oldMrp:  existing.mrp,
      newMrp,
    });
  });
}

export async function listProducts(activeOnly = true) {
  return activeOnly
    ? db.select().from(products).where(eq(products.isActive, true))
    : db.select().from(products);
}
