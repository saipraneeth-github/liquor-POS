import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { db } from '../../db/client.js';
import { products, categories, masterProducts, priceAudit, productServings, stock } from '../../db/schema.js';
import { and, eq, getTableColumns, inArray } from 'drizzle-orm';
import { branchAvailability, type Tenant } from '../menu/menu-access.js';
import { branchCostMap, branchPriceMap, categoryScope, productTenantScope, requireTenantId } from '../catalog/catalog.service.js';
import { defaultPrice, positivePrice } from '../catalog/price.engine.js';
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
  // MRP is optional at product creation time — the tenant types it later (Products → Pricing, or PATCH /mrp).
  // The column defaults to '0.00' ("needs a price"); POS billing refuses to sell an unpriced product.
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
  // mrp / costPrice are deliberately NOT editable here: MRP changes go through PATCH /products/:id/mrp
  // (prices.edit permission + price_audit row). .strict() turns an attempt into a 400, not a silent no-op.
  barcode: OPT_SAFE_TEXT(64).nullable(),
  sku: OPT_SAFE_TEXT(64).nullable(),
  exciseCode: OPT_SAFE_TEXT(10).nullable(),
}).strict();

export type CreateProductInput = z.infer<typeof CreateProductSchema>;
export type UpdateProductInput = z.infer<typeof UpdateProductSchema>;

// ─── PRODUCT SERVICE ─────────────────────────────────────────────────────────

/** The platform's categories plus the caller's own business's (a tenant never sees another tenant's). */
export async function listCategories(tenant: Tenant = 'ALL') {
  return await db
    .select({ id: categories.id, name: categories.name, taxRate: categories.taxRate, taxType: categories.taxType, custom: categories.syndicateId })
    .from(categories)
    .where(categoryScope(tenant))
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
  const tenantId = requireTenantId(tenant);
  const [category] = await db
    .select({ id: categories.id, name: categories.name, taxRate: categories.taxRate })
    .from(categories)
    .where(and(eq(categories.id, input.categoryId), categoryScope(tenantId)))
    .limit(1);
  if (!category) throw new BusinessRuleError('Category not found');

  // An item taken from the master catalog gets its identity from the master (the client's copy of it is ignored)
  let identity: { name: string; brand: string; volumeMl?: number; exciseCode?: string; packQuantity?: number; sku?: string; revision: number } | null = null;
  if (input.masterProductId) {
    const [m] = await db.select().from(masterProducts).where(and(eq(masterProducts.id, input.masterProductId), eq(masterProducts.isActive, true))).limit(1);
    if (!m) throw new BusinessRuleError('That product is not in the master catalog');
    const [dup] = await db.select({ id: products.id }).from(products).where(and(eq(products.syndicateId, tenantId), eq(products.masterProductId, m.id))).limit(1);
    if (dup) throw new ConflictError('This master product is already in your catalog');
    identity = { name: cleanProductName(m.name), brand: m.brand, volumeMl: m.volumeMl, exciseCode: m.exciseCode, packQuantity: m.packQuantity, sku: m.sku, revision: m.revision };
  }
  const cleanName = identity?.name ?? cleanProductName(input.name);
  const brand = identity?.brand ?? (input.brand || cleanName.split(' ')[0] || cleanName);
  // No price is invented: left empty it stays 0.00 ("needs a price") until the tenant types one
  const mrp = input.mrp ? new Decimal(input.mrp).toFixed(2) : '0.00';

  try {
    const [product] = await db.insert(products).values({
      categoryId:      input.categoryId,
      masterProductId: input.masterProductId,
      barcode:         input.barcode,
      sku:             identity?.sku ?? input.sku,
      name:            cleanName,
      brand,
      volumeMl:        identity?.volumeMl ?? input.volumeMl,
      exciseCode:      identity?.exciseCode ?? input.exciseCode,
      packQuantity:    identity?.packQuantity ?? input.packQuantity,
      masterRevision:  identity ? identity.revision : undefined,
      mrp,
      costPrice:       input.costPrice ? new Decimal(input.costPrice).toFixed(2) : undefined,
      syndicateId:     tenantId,
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
  const [existing] = await db.select().from(products).where(and(eq(products.id, id), productTenantScope(tenant))).limit(1);
  if (!existing) throw new NotFoundError('Product not found');

  // What a bottle IS comes from the master catalog; the business can only rename it (display name), change its barcode, etc.
  if (existing.masterProductId) {
    const locked = (['brand', 'volumeMl', 'packQuantity', 'categoryId', 'sku', 'exciseCode'] as const).filter((k) => input[k] !== undefined && input[k] !== existing[k]);
    if (locked.length > 0) throw new BusinessRuleError(`${locked.join(', ')} come from the master catalog and cannot be changed on this product`);
  }

  const updates: Record<string, any> = {};
  if (input.name !== undefined) updates.name = cleanProductName(input.name);
  if (input.brand !== undefined) updates.brand = input.brand;
  if (input.volumeMl !== undefined) updates.volumeMl = input.volumeMl;
  if (input.packQuantity !== undefined) updates.packQuantity = input.packQuantity;
  if (input.categoryId !== undefined) updates.categoryId = input.categoryId;
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
  const [row] = await db.select().from(products).where(and(eq(products.barcode, barcode), productTenantScope(tenant))).limit(1);
  return row ?? null;
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
    const foreign = existing && tenant !== 'ALL' && existing.syndicateId !== tenant;
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
  const query = db
    .select({ ...getTableColumns(products), categoryName: categories.name, taxRate: categories.taxRate })
    .from(products)
    .leftJoin(categories, eq(products.categoryId, categories.id));
  const found = await (query.where(and(activeOnly ? eq(products.isActive, true) : undefined, productTenantScope(tenant))).orderBy(products.name));
  // A branch's own on/off switch overrides the shared availability flag
  const foundIds = found.map((r) => r.id);
  const [overrides, prices, costs] = await Promise.all([
    branchId ? branchAvailability(db, branchId, foundIds) : Promise.resolve(new Map<string, boolean>()),
    branchPriceMap(db, branchId, foundIds),
    branchCostMap(db, branchId, foundIds),
  ]);
  // `mrp` is the price this branch charges (its override, else the business-wide price) so the POS shows what it will bill;
  // `tenantMrp` is the business-wide price and `branchPrice` the override. `needsPrice` = cannot be sold here yet.
  const rows = found.map((r) => {
    const o = prices.get(r.id);
    const effective = defaultPrice(r.mrp, o);
    const c = costs.get(r.id);
    // With a branch chosen, cost figures are that branch's own purchases (a branch that never bought it shows none)
    const cost = branchId ? {
      costPrice: c?.costPrice ?? null, previousCostPrice: c?.previousCostPrice ?? null, costPerCase: c?.costPerCase ?? null,
      lastInvoiceId: c?.lastInvoiceId ?? null, lastInvoiceNumber: c?.lastInvoiceNumber ?? null,
      lastInvoiceDate: c?.lastInvoiceDate ?? null, costUpdatedAt: c?.costUpdatedAt ?? null,
    } : {};
    return {
      ...r, ...cost, isAvailable: overrides.get(r.id) ?? r.isAvailable,
      mrp: effective ?? r.mrp, tenantMrp: r.mrp, branchPrice: positivePrice(o?.base), needsPrice: effective === null,
    };
  });

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
