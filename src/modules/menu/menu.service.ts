/**
 * menu.service.ts — Kitchen and Bar menu items, serving sizes and rate history.
 * Menu items are rows in `products` with menu_type KITCHEN | BAR. Rates are tax-inclusive.
 */

import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { branchMenuAvailability, categories, priceAudit, productServings, products, servingPriceAudit, users } from '../../db/schema.js';
import { BusinessRuleError, ConflictError, NotFoundError, isUniqueViolation } from '../../lib/errors.js';
import type { Tx } from '../../lib/domain-events.js';
import type { JwtPayload } from '../auth/auth.service.js';
import { normalizeLabel, validateServings } from './serving.engine.js';
import { branchAvailability, type Tenant } from './menu-access.js';

// ─── SCHEMAS ────────────────────────────────────────────────────────────────

const SAFE_TEXT = (max: number) =>
  z.string().trim().min(1).max(max).refine((s) => !/[<>]/.test(s), 'Must not contain HTML angle brackets (< or >)');
const OPT_TEXT = (max: number) =>
  z.string().trim().max(max).refine((s) => !/[<>]/.test(s), 'Must not contain HTML angle brackets (< or >)');
const MONEY = z.string().regex(/^\d+(\.\d{1,2})?$/, 'Must be a decimal amount').refine((v) => Number(v) > 0, 'Must be positive');
const GST = z.string().regex(/^\d+(\.\d{1,2})?$/, 'GST % must be a number').refine((v) => Number(v) <= 100, 'GST % cannot exceed 100');

export const MENU_TYPES = ['kitchen', 'bar'] as const;
export type MenuTypeParam = (typeof MENU_TYPES)[number];
const toDbType = (t: MenuTypeParam) => (t === 'kitchen' ? ('KITCHEN' as const) : ('BAR' as const));

export const ServingSchema = z.object({
  id:        z.string().uuid().optional(),
  label:     SAFE_TEXT(60),
  volumeMl:  z.coerce.number().int().positive().max(5000).nullable().optional(),
  price:     MONEY,
  isActive:  z.boolean().optional().default(true),
});

export const CreateMenuItemSchema = z.object({
  name:         SAFE_TEXT(200),
  categoryName: SAFE_TEXT(100),
  price:        MONEY,                                   // rate; for bar items the full-bottle / unit rate
  description:  OPT_TEXT(500).optional(),
  gstRate:      GST,
  isAvailable:  z.boolean().optional().default(true),
  brand:        OPT_TEXT(200).optional(),
  hsnCode:      OPT_TEXT(10).optional(),                 // HSN / SAC printed on GST invoices
  volumeMl:     z.coerce.number().int().positive().max(5000).optional(),   // bottle size (bar)
  servings:     z.array(ServingSchema).max(12).optional(),
});

export const UpdateMenuItemSchema = z.object({
  name:         SAFE_TEXT(200).optional(),
  categoryName: SAFE_TEXT(100).optional(),
  price:        MONEY.optional(),
  description:  OPT_TEXT(500).optional(),
  gstRate:      GST.optional(),
  isAvailable:  z.boolean().optional(),
  brand:        OPT_TEXT(200).optional(),
  hsnCode:      OPT_TEXT(10).optional(),
  volumeMl:     z.coerce.number().int().positive().max(5000).nullable().optional(),
  menuType:     z.enum(['BAR']).optional(),              // adopt an existing catalog bottle into the bar menu
});

export const ReplaceServingsSchema = z.object({ servings: z.array(ServingSchema).max(12) });

export type CreateMenuItemInput = z.infer<typeof CreateMenuItemSchema>;
export type UpdateMenuItemInput = z.infer<typeof UpdateMenuItemSchema>;
export type ServingInputRow = z.infer<typeof ServingSchema>;

// ─── HELPERS ────────────────────────────────────────────────────────────────

async function findOrCreateCategory(tx: Tx, name: string, gstRate: string): Promise<string> {
  const clean = normalizeLabel(name);
  const [existing] = await tx.select({ id: categories.id }).from(categories).where(eq(categories.name, clean)).limit(1);
  if (existing) return existing.id;
  const [created] = await tx.insert(categories).values({ name: clean, taxRate: new Decimal(gstRate).toFixed(2) }).returning({ id: categories.id });
  return created.id;
}

async function loadItem(tx: Tx | typeof db, id: string) {
  const [row] = await tx
    .select({
      id: products.id, name: products.name, brand: products.brand, description: products.description,
      menuType: products.menuType, mrp: products.mrp, gstRate: products.gstRate, isAvailable: products.isAvailable,
      isActive: products.isActive, volumeMl: products.volumeMl, trackStock: products.trackStock,
      hsnCode: products.hsnCode, syndicateId: products.syndicateId,
      categoryId: products.categoryId, categoryName: categories.name, categoryTaxRate: categories.taxRate,
    })
    .from(products)
    .leftJoin(categories, eq(products.categoryId, categories.id))
    .where(eq(products.id, id))
    .limit(1);
  return row ?? null;
}

async function attachServings<T extends { id: string }>(rows: T[], includeInactive: boolean) {
  if (rows.length === 0) return [];
  const servings = await db
    .select()
    .from(productServings)
    .where(inArray(productServings.productId, rows.map((r) => r.id)))
    .orderBy(productServings.sortOrder, productServings.volumeMl);
  const byProduct = new Map<string, typeof servings>();
  for (const s of servings) {
    if (!includeInactive && !s.isActive) continue;
    const list = byProduct.get(s.productId) ?? [];
    list.push(s);
    byProduct.set(s.productId, list);
  }
  return rows.map((r) => ({ ...r, servings: byProduct.get(r.id) ?? [] }));
}

/** Items whose rate/serving details the page shows; effective GST falls back to the category rate. */
function withEffectiveGst<T extends { gstRate: string | null; categoryTaxRate: string | null }>(row: T) {
  return { ...row, effectiveGstRate: row.gstRate ?? row.categoryTaxRate ?? '18.00' };
}

/** Platform owner reaches everything; a tenant reaches its own items; unowned items belong to standalone branches. */
export function tenantOwns(owner: string | null, tenant: Tenant): boolean {
  if (tenant === 'ALL') return true;
  return owner === null ? tenant === null : owner === tenant;
}

async function assertMenuItem(tx: Tx | typeof db, id: string, tenant: Tenant, type?: MenuTypeParam) {
  const item = await loadItem(tx, id);
  if (!item || item.menuType === 'RETAIL' || !tenantOwns(item.syndicateId, tenant)) throw new NotFoundError('Menu item not found');
  if (type && item.menuType !== toDbType(type)) throw new NotFoundError('Menu item not found');
  return item;
}

// ─── QUERIES ────────────────────────────────────────────────────────────────

export async function listMenuItems(type: MenuTypeParam, tenant: Tenant, includeInactive = false, branchId?: string) {
  const scope = tenant === 'ALL' ? undefined : tenant === null ? isNull(products.syndicateId) : or(isNull(products.syndicateId), eq(products.syndicateId, tenant));
  const where = and(
    eq(products.menuType, toDbType(type)),
    includeInactive ? undefined : eq(products.isActive, true),
    scope,
  );
  const rows = await db
    .select({
      id: products.id, name: products.name, brand: products.brand, description: products.description,
      menuType: products.menuType, mrp: products.mrp, gstRate: products.gstRate, isAvailable: products.isAvailable,
      isActive: products.isActive, volumeMl: products.volumeMl, trackStock: products.trackStock,
      hsnCode: products.hsnCode, syndicateId: products.syndicateId,
      categoryId: products.categoryId, categoryName: categories.name, categoryTaxRate: categories.taxRate,
    })
    .from(products)
    .leftJoin(categories, eq(products.categoryId, categories.id))
    .where(where)
    .orderBy(categories.name, products.name);

  // At a branch, its own switch overrides the shared availability flag
  const overrides = branchId ? await branchAvailability(db, branchId, rows.map((r) => r.id)) : new Map<string, boolean>();
  const withBranch = rows.map((r) => ({
    ...r,
    sharedAvailable: r.isAvailable,
    isAvailable: overrides.get(r.id) ?? r.isAvailable,
    branchOverride: overrides.has(r.id),
  }));
  return (await attachServings(withBranch, includeInactive)).map(withEffectiveGst);
}

export async function getMenuItem(id: string, tenant: Tenant) {
  const item = await assertMenuItem(db, id, tenant);
  const [full] = await attachServings([item], true);
  return withEffectiveGst(full);
}

/** Rate history: item rate changes and serving rate changes, newest first. */
export async function getPriceHistory(productId: string, tenant: Tenant) {
  await assertMenuItem(db, productId, tenant);

  const itemRows = await db
    .select({ at: priceAudit.changedAt, oldPrice: priceAudit.oldMrp, newPrice: priceAudit.newMrp, by: users.name })
    .from(priceAudit)
    .leftJoin(users, eq(priceAudit.userId, users.id))
    .where(eq(priceAudit.productId, productId));

  const servingRows = await db
    .select({
      at: servingPriceAudit.changedAt, oldPrice: servingPriceAudit.oldPrice, newPrice: servingPriceAudit.newPrice,
      by: users.name, serving: productServings.label,
    })
    .from(servingPriceAudit)
    .innerJoin(productServings, eq(servingPriceAudit.servingId, productServings.id))
    .leftJoin(users, eq(servingPriceAudit.userId, users.id))
    .where(eq(productServings.productId, productId));

  return [
    ...itemRows.map((r) => ({ ...r, serving: null as string | null })),
    ...servingRows,
  ].sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));
}

// ─── COMMANDS ───────────────────────────────────────────────────────────────

async function writeServings(tx: Tx, productId: string, rows: ServingInputRow[], user: JwtPayload) {
  const [product] = await tx.select({ volumeMl: products.volumeMl }).from(products).where(eq(products.id, productId)).limit(1);
  try {
    validateServings(rows.filter((r) => r.isActive), product?.volumeMl);
  } catch (e) {
    throw new BusinessRuleError((e as Error).message);
  }
  if (rows.some((r) => r.volumeMl) && !product?.volumeMl) {
    throw new BusinessRuleError('Set the bottle size (ml) before adding peg servings');
  }

  const existing = await tx.select().from(productServings).where(eq(productServings.productId, productId));
  const existingById = new Map(existing.map((s) => [s.id, s]));
  const keptIds = new Set<string>();

  try {
    let order = 0;
    for (const row of rows) {
      const label = normalizeLabel(row.label);
      const price = new Decimal(row.price).toFixed(2);
      const prev = row.id ? existingById.get(row.id) : undefined;
      if (row.id && !prev) throw new NotFoundError('Serving not found for this item');

      if (prev) {
        keptIds.add(prev.id);
        await tx.update(productServings)
          .set({ label, volumeMl: row.volumeMl ?? null, price, isActive: row.isActive, sortOrder: order++ })
          .where(eq(productServings.id, prev.id));
        if (!new Decimal(prev.price).equals(price)) {
          await tx.insert(servingPriceAudit).values({ servingId: prev.id, userId: user.sub, oldPrice: prev.price, newPrice: price });
        }
      } else {
        const [created] = await tx.insert(productServings)
          .values({ productId, label, volumeMl: row.volumeMl ?? null, price, isActive: row.isActive, sortOrder: order++ })
          .returning({ id: productServings.id });
        keptIds.add(created.id);
        await tx.insert(servingPriceAudit).values({ servingId: created.id, userId: user.sub, oldPrice: null, newPrice: price });
      }
    }

    // Servings omitted from the list are retired (kept for old bills), never hard-deleted
    for (const prev of existing) {
      if (!keptIds.has(prev.id) && prev.isActive) {
        await tx.update(productServings).set({ isActive: false }).where(eq(productServings.id, prev.id));
      }
    }
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError('Two servings share the same label');
    throw err;
  }
}

export async function createMenuItem(type: MenuTypeParam, input: CreateMenuItemInput, user: JwtPayload, tenant: Tenant) {
  if (type === 'kitchen' && (input.servings?.length || input.volumeMl)) {
    throw new BusinessRuleError('Kitchen items do not have bottle sizes or servings');
  }
  const id = await db.transaction(async (tx) => {
    const categoryId = await findOrCreateCategory(tx, input.categoryName, input.gstRate);
    const price = new Decimal(input.price).toFixed(2);
    const [created] = await tx.insert(products).values({
      categoryId,
      name:        input.name,
      brand:       input.brand || input.name.split(' ')[0] || input.name,
      description: input.description || null,
      menuType:    toDbType(type),
      mrp:         price,
      gstRate:     new Decimal(input.gstRate).toFixed(2),
      isAvailable: input.isAvailable,
      volumeMl:    input.volumeMl,
      trackStock:  type === 'bar',
      hsnCode:     input.hsnCode || null,
      syndicateId: tenant === 'ALL' ? null : tenant,
    }).returning({ id: products.id });
    await tx.insert(priceAudit).values({ productId: created.id, userId: user.sub, oldMrp: null, newMrp: price });
    if (input.servings?.length) await writeServings(tx, created.id, input.servings, user);
    return created.id;
  });
  return getMenuItem(id, tenant);
}

export async function updateMenuItem(id: string, input: UpdateMenuItemInput, user: JwtPayload, tenant: Tenant) {
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(products).where(eq(products.id, id)).for('update');
    if (!current) throw new NotFoundError('Menu item not found');
    const adopting = current.menuType === 'RETAIL' && input.menuType === 'BAR';
    if (current.menuType === 'RETAIL' && !adopting) throw new NotFoundError('Menu item not found');
    if (!adopting && !tenantOwns(current.syndicateId, tenant)) throw new NotFoundError('Menu item not found');
    // A bottle owned by another business cannot be adopted; an unowned (legacy) one becomes this tenant's
    if (adopting && current.syndicateId && !tenantOwns(current.syndicateId, tenant)) throw new NotFoundError('Menu item not found');

    const set: Partial<typeof products.$inferInsert> = {};
    if (input.name !== undefined) set.name = input.name;
    if (input.brand !== undefined) set.brand = input.brand || current.brand;
    if (input.description !== undefined) set.description = input.description || null;
    if (input.isAvailable !== undefined) set.isAvailable = input.isAvailable;
    if (input.volumeMl !== undefined) set.volumeMl = input.volumeMl;
    if (input.gstRate !== undefined) set.gstRate = new Decimal(input.gstRate).toFixed(2);
    if (adopting) {
      // The bottle becomes this tenant's bar item
      set.menuType = 'BAR';
      set.trackStock = true;
      if (tenant !== 'ALL') set.syndicateId = tenant;
    }
    if (input.hsnCode !== undefined) set.hsnCode = input.hsnCode || null;
    if (input.categoryName !== undefined) {
      set.categoryId = await findOrCreateCategory(tx, input.categoryName, input.gstRate ?? current.gstRate ?? '18.00');
    }
    if (input.price !== undefined) {
      const price = new Decimal(input.price).toFixed(2);
      set.mrp = price;
      if (!new Decimal(current.mrp).equals(price)) {
        await tx.insert(priceAudit).values({ productId: id, userId: user.sub, oldMrp: current.mrp, newMrp: price });
      }
    }
    if (Object.keys(set).length > 0) await tx.update(products).set(set).where(eq(products.id, id));
  });
  return getMenuItem(id, tenant);
}

export async function replaceServings(id: string, rows: ServingInputRow[], user: JwtPayload, tenant: Tenant) {
  await db.transaction(async (tx) => {
    const item = await assertMenuItem(tx, id, tenant, 'bar');
    if (item.menuType !== 'BAR') throw new BusinessRuleError('Servings are only available on bar items');
    await writeServings(tx, id, rows, user);
  });
  return getMenuItem(id, tenant);
}

/** A branch switches an item on/off for itself only. */
export async function setBranchAvailability(id: string, branchId: string, isAvailable: boolean, tenant: Tenant) {
  await assertMenuItem(db, id, tenant);
  await db.insert(branchMenuAvailability)
    .values({ branchId, productId: id, isAvailable })
    .onConflictDoUpdate({
      target: [branchMenuAvailability.branchId, branchMenuAvailability.productId],
      set: { isAvailable, updatedAt: new Date() },
    });
}

/** Soft delete: bills and KOTs reference the product, so it is hidden rather than removed. */
export async function deleteMenuItem(id: string, tenant: Tenant) {
  await assertMenuItem(db, id, tenant);
  const [row] = await db
    .update(products)
    .set({ isActive: false })
    .where(and(eq(products.id, id), inArray(products.menuType, ['KITCHEN', 'BAR'])))
    .returning({ id: products.id });
  if (!row) throw new NotFoundError('Menu item not found');
}
