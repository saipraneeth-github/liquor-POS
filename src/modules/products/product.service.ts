import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { db } from '../../db/client.js';
import { products, categories, masterProducts, priceAudit, productServings, stock } from '../../db/schema.js';
import { and, eq, getTableColumns, inArray, isNull, or } from 'drizzle-orm';
import { branchAvailability, type Tenant } from '../menu/menu-access.js';
import { BusinessRuleError, ConflictError, NotFoundError, isUniqueViolation } from '../../lib/errors.js';
import type { JwtPayload } from '../auth/auth.service.js';
import { cleanProductName } from '../../lib/product-name.js';

// ─── SCHEMAS ────────────────────────────────────────────────────────────────

const SAFE_TEXT = (max: number) => z.string().trim().min(1).max(max).refine((s) => !/[<>]/.test(s), 'Must not contain HTML angle brackets (< or >)');
const OPT_SAFE_TEXT = (max: number) => z.string().trim().max(max).optional().transform((s) => s || undefined).refine((s) => !s || !/[<>]/.test(s), 'Must not contain HTML angle brackets (< or >)');

export const CreateProductSchema = z.object({
  categoryId:   z.string().uuid(),
  barcode:      OPT_SAFE_TEXT(64),
  sku:          OPT_SAFE_TEXT(64),
  name:         SAFE_TEXT(200),
  brand:        OPT_SAFE_TEXT(200),
  volumeMl:     z.coerce.number().int().positive().optional(),
  exciseCode:   OPT_SAFE_TEXT(10),
  packQuantity: z.coerce.number().int().positive().max(1000).optional(),
  // MRP is optional at product creation time — set/updated later on the Products page or via PATCH /mrp.
  // The DB column defaults to '0.00'; POS billing will block sales of products with 0.00 MRP.
  mrp:          z.string().trim().optional().transform((v) => v || undefined)
                  .refine((v) => !v || /^\d+(\.\d{1,2})?$/.test(v), 'MRP must be a decimal string')
                  .refine((v) => !v || Number(v) >= 0, 'MRP must be non-negative'),
  costPrice:    z.string().trim().optional().transform((v) => v || undefined).refine((v) => !v || /^\d+(\.\d{1,2})?$/.test(v), 'Cost price must be a decimal string'),
  masterProductId: z.string().uuid().optional(),
});

export const UpdateMrpSchema = z.object({
  mrp: z.string().regex(/^\d+(\.\d{1,2})?$/, 'MRP must be a decimal string'),
});

export const UpdateProductSchema = z.object({
  name: OPT_SAFE_TEXT(200),
  brand: OPT_SAFE_TEXT(200),
  volumeMl: z.coerce.number().int().positive().nullable().optional(),
  packQuantity: z.coerce.number().int().positive().max(1000).optional(),
  categoryId: z.string().uuid().optional(),
  mrp: z.string().trim().optional().transform((v) => v || undefined)
    .refine((v) => !v || /^\d+(\.\d{1,2})?$/.test(v), 'MRP must be a decimal string'),
  costPrice: z.string().trim().optional().transform((v) => v || undefined)
    .refine((v) => !v || /^\d+(\.\d{1,2})?$/.test(v), 'Cost price must be a decimal string'),
  barcode: OPT_SAFE_TEXT(64).nullable(),
  sku: OPT_SAFE_TEXT(64).nullable(),
  exciseCode: OPT_SAFE_TEXT(10).nullable(),
});

export type CreateProductInput = z.infer<typeof CreateProductSchema>;
export type UpdateProductInput = z.infer<typeof UpdateProductSchema>;

// ─── PRODUCT SERVICE ─────────────────────────────────────────────────────────

export async function listCategories() {
  return await db
    .select({ id: categories.id, name: categories.name, taxRate: categories.taxRate, taxType: categories.taxType })
    .from(categories)
    .orderBy(categories.name);
}

/**
 * Look up a Telangana state master product by excise code (brand code) + volume (ml).
 * Returns the full master product row so the frontend can auto-populate the Add Product modal.
 */
export async function lookupMasterProduct(exciseCode: string, volumeMl: number, state = 'TS') {
  const [row] = await db
    .select()
    .from(masterProducts)
    .where(
      and(
        eq(masterProducts.state, state),
        eq(masterProducts.exciseCode, exciseCode.trim()),
        eq(masterProducts.volumeMl, volumeMl),
        eq(masterProducts.isActive, true),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function createProduct(input: CreateProductInput, tenant: Tenant = 'ALL') {
  const [category] = await db
    .select({ id: categories.id, name: categories.name, taxRate: categories.taxRate })
    .from(categories)
    .where(eq(categories.id, input.categoryId))
    .limit(1);
  if (!category) throw new BusinessRuleError('Category not found');
  const cleanName = cleanProductName(input.name);
  const brand = input.brand || cleanName.split(' ')[0] || cleanName;
  // MRP defaults to '0.00' when not supplied; POS billing will block sales of unpriced products
  const mrp = input.mrp ? new Decimal(input.mrp).toFixed(2) : '0.00';

  try {
    const [product] = await db.insert(products).values({
      categoryId:      input.categoryId,
      masterProductId: input.masterProductId,
      barcode:         input.barcode,
      sku:             input.sku,
      name:            cleanName,
      brand,
      volumeMl:        input.volumeMl,
      exciseCode:      input.exciseCode,
      packQuantity:    input.packQuantity,
      mrp,
      costPrice:       input.costPrice ? new Decimal(input.costPrice).toFixed(2) : undefined,
      syndicateId:     tenant === 'ALL' ? null : tenant,
    }).returning();
    return { ...product, categoryName: category.name, taxRate: category.taxRate };
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError('A product with this barcode or SKU already exists');
    throw err;
  }
}

export async function updateProduct(
  id: string,
  input: UpdateProductInput,
  tenant: Tenant = 'ALL'
) {
  const scope = tenant === 'ALL' ? undefined : tenant === null ? isNull(products.syndicateId) : or(isNull(products.syndicateId), eq(products.syndicateId, tenant));
  const [existing] = await db.select().from(products).where(and(eq(products.id, id), scope)).limit(1);
  if (!existing) throw new NotFoundError('Product not found');

  const updates: Record<string, any> = {};
  if (input.name !== undefined) updates.name = cleanProductName(input.name);
  if (input.brand !== undefined) updates.brand = input.brand;
  if (input.volumeMl !== undefined) updates.volumeMl = input.volumeMl;
  if (input.packQuantity !== undefined) updates.packQuantity = input.packQuantity;
  if (input.categoryId !== undefined) updates.categoryId = input.categoryId;
  if (input.mrp !== undefined) updates.mrp = input.mrp ? new Decimal(input.mrp).toFixed(2) : '0.00';
  if (input.costPrice !== undefined) updates.costPrice = input.costPrice ? new Decimal(input.costPrice).toFixed(2) : undefined;
  if (input.barcode !== undefined) updates.barcode = input.barcode;
  if (input.sku !== undefined) updates.sku = input.sku;
  if (input.exciseCode !== undefined) updates.exciseCode = input.exciseCode;

  if (Object.keys(updates).length === 0) return existing;

  const [updated] = await db
    .update(products)
    .set(updates)
    .where(eq(products.id, id))
    .returning();

  return updated;
}

/** Barcodes are unique per business, so the lookup is limited to the caller's tenant (their own item wins over a shared one). */
export async function getProductByBarcode(barcode: string, tenant: Tenant = 'ALL') {
  const scope = tenant === 'ALL' ? undefined : tenant === null ? isNull(products.syndicateId) : or(isNull(products.syndicateId), eq(products.syndicateId, tenant));
  const rows = await db.select().from(products).where(and(eq(products.barcode, barcode), scope)).limit(2);
  return rows.find((r) => r.syndicateId !== null) ?? rows[0] ?? null;
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
  tenant: Tenant = 'ALL',
): Promise<void> {
  const normalized = new Decimal(newMrp);
  if (normalized.isZero() || normalized.isNegative()) throw new BusinessRuleError('MRP must be greater than zero');
  const mrp = normalized.toFixed(2);

  await db.transaction(async (tx) => {
    // Read the old MRP under a row lock so concurrent changes audit correctly
    const [existing] = await tx
      .select({ id: products.id, mrp: products.mrp, syndicateId: products.syndicateId })
      .from(products)
      .where(eq(products.id, productId))
      .for('update');
    // A product of another business is reported as missing (no existence leak) — the MRP belongs to its own business
    const foreign = existing && existing.syndicateId !== null && tenant !== 'ALL' && existing.syndicateId !== tenant;
    if (!existing || foreign) throw new NotFoundError(`Product ${productId} not found`);
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
export async function listProducts(activeOnly = true, tenant: Tenant = 'ALL', branchId?: string) {
  const scope = tenant === 'ALL' ? undefined : tenant === null ? isNull(products.syndicateId) : or(isNull(products.syndicateId), eq(products.syndicateId, tenant));
  const query = db
    .select({ ...getTableColumns(products), categoryName: categories.name, taxRate: categories.taxRate })
    .from(products)
    .leftJoin(categories, eq(products.categoryId, categories.id));
  const found = await (query.where(and(activeOnly ? eq(products.isActive, true) : undefined, scope)).orderBy(products.name));
  // A branch's own on/off switch overrides the shared availability flag
  const overrides = branchId ? await branchAvailability(db, branchId, found.map((r) => r.id)) : new Map<string, boolean>();
  const rows = found.map((r) => ({ ...r, isAvailable: overrides.get(r.id) ?? r.isAvailable }));

  // Peg / glass servings ride along so POS and KOT can offer them without a second call
  const servings = rows.length === 0 ? [] : await db
    .select()
    .from(productServings)
    .where(inArray(productServings.productId, rows.filter((r) => r.menuType === 'BAR').map((r) => r.id)))
    .orderBy(productServings.sortOrder, productServings.volumeMl);
  const byProduct = new Map<string, typeof servings>();
  for (const s of servings) {
    if (!s.isActive) continue;
    byProduct.set(s.productId, [...(byProduct.get(s.productId) ?? []), s]);
  }

  // Branch-level real-time inventory stock (bottles & open peg ml)
  const stockMap = new Map<string, { quantity: number; openMl: number; reorderLevel: number }>();
  if (branchId && rows.length > 0) {
    const stockRows = await db
      .select({
        productId: stock.productId,
        quantity: stock.quantity,
        openMl: stock.openMl,
        reorderLevel: stock.reorderLevel,
      })
      .from(stock)
      .where(and(
        eq(stock.branchId, branchId),
        inArray(stock.productId, rows.map((r) => r.id))
      ));
    for (const s of stockRows) {
      stockMap.set(s.productId, {
        quantity: s.quantity,
        openMl: s.openMl,
        reorderLevel: s.reorderLevel ?? 5,
      });
    }
  }

  return rows.map((r) => {
    const s = stockMap.get(r.id);
    return {
      ...r,
      currentStock: r.trackStock ? (s?.quantity ?? 0) : null,
      stockQuantity: r.trackStock ? (s?.quantity ?? 0) : null,
      openMl: r.trackStock ? (s?.openMl ?? 0) : null,
      reorderLevel: s?.reorderLevel ?? 5,
      servings: byProduct.get(r.id) ?? [],
    };
  });
}
