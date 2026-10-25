import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { db } from '../../db/client.js';
import { products, categories, priceAudit } from '../../db/schema.js';
import { eq, getTableColumns } from 'drizzle-orm';
import { BusinessRuleError, ConflictError, NotFoundError, isUniqueViolation } from '../../lib/errors.js';
import type { JwtPayload } from '../auth/auth.service.js';

// ─── SCHEMAS ────────────────────────────────────────────────────────────────

export const CreateProductSchema = z.object({
  categoryId:   z.string().uuid(),
  barcode:      z.string().trim().min(1).max(64).optional(),
  sku:          z.string().trim().min(1).max(64).optional(),
  name:         z.string().trim().min(1).max(200),
  brand:        z.string().trim().min(1).max(200),
  volumeMl:     z.number().int().positive().optional(),
  exciseCode:   z.string().trim().max(10).optional(),
  packQuantity: z.number().int().positive().max(1000).optional(),
  mrp:          z.string().regex(/^\d+(\.\d{1,2})?$/, 'MRP must be a decimal string').refine((v) => Number(v) > 0, 'MRP must be positive'),
  costPrice:    z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
});

export const UpdateMrpSchema = z.object({
  mrp: z.string().regex(/^\d+(\.\d{1,2})?$/, 'MRP must be a decimal string'),
});

export type CreateProductInput = z.infer<typeof CreateProductSchema>;

// ─── PRODUCT SERVICE ─────────────────────────────────────────────────────────

export async function createProduct(input: CreateProductInput) {
  const [category] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.id, input.categoryId))
    .limit(1);
  if (!category) throw new BusinessRuleError('Category not found');

  try {
    const [product] = await db.insert(products).values({
      categoryId:   input.categoryId,
      barcode:      input.barcode,
      sku:          input.sku,
      name:         input.name,
      brand:        input.brand,
      volumeMl:     input.volumeMl,
      exciseCode:   input.exciseCode,
      packQuantity: input.packQuantity,
      mrp:          new Decimal(input.mrp).toFixed(2),
      costPrice:    input.costPrice ? new Decimal(input.costPrice).toFixed(2) : undefined,
    }).returning();
    return product;
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError('A product with this barcode or SKU already exists');
    throw err;
  }
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
  const normalized = new Decimal(newMrp);
  if (normalized.isZero() || normalized.isNegative()) throw new BusinessRuleError('MRP must be greater than zero');
  const mrp = normalized.toFixed(2);

  await db.transaction(async (tx) => {
    // Read the old MRP under a row lock so concurrent changes audit correctly
    const [existing] = await tx
      .select({ id: products.id, mrp: products.mrp })
      .from(products)
      .where(eq(products.id, productId))
      .for('update');
    if (!existing) throw new NotFoundError(`Product ${productId} not found`);
    if (new Decimal(existing.mrp).equals(mrp)) return;   // no-op, nothing to audit

    await tx.update(products)
      .set({ mrp })
      .where(eq(products.id, productId));

    // Write price audit (append-only)
    await tx.insert(priceAudit).values({
      productId,
      userId:  user.sub,
      oldMrp:  existing.mrp,
      newMrp:  mrp,
    });
  });
}

/** Products with their category name and GST rate (for catalog filters and display). */
export async function listProducts(activeOnly = true) {
  const query = db
    .select({ ...getTableColumns(products), categoryName: categories.name, taxRate: categories.taxRate })
    .from(products)
    .leftJoin(categories, eq(products.categoryId, categories.id));
  return activeOnly ? query.where(eq(products.isActive, true)).orderBy(products.name) : query.orderBy(products.name);
}
