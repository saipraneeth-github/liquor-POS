import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  branches, branchSaleTypes, priceAudit, productPrices, products, saleTypes, stock, stockAudit, stockByType,
} from '../../db/schema.js';
import type { Tx } from '../../lib/domain-events.js';
import { BusinessRuleError, ConflictError, NotFoundError, isUniqueViolation } from '../../lib/errors.js';
import type { JwtPayload } from '../auth/auth.service.js';
import {
  DEFAULT_SALE_TYPES, applyTransfer, counterQuantity, normalizeSaleTypeCode, rowTypeId, type SaleTypeLite,
} from './saletype.engine.js';

type Exec = Tx | typeof db;
export type SaleTypeRow = typeof saleTypes.$inferSelect;
export interface BranchSaleType extends SaleTypeLite {
  code: string;
  sortOrder: number;
  isActive: boolean;
  /** Whether this shop sells under the type (the default type is always enabled). */
  enabled: boolean;
}

const MONEY_POSITIVE = z.string().trim().regex(/^\d{1,10}(\.\d{1,2})?$/, 'price must be a decimal string with up to 2dp').refine((v) => Number(v) > 0, 'price must be positive');

export const CreateSaleTypeSchema = z.object({ name: z.string().trim().min(2).max(40).refine((s) => !/[<>]/.test(s), 'must not contain < or >'), code: z.string().trim().min(2).max(40).optional() });
export const UpdateSaleTypeSchema = z.object({
  name:      z.string().trim().min(2).max(40).refine((s) => !/[<>]/.test(s), 'must not contain < or >').optional(),
  isActive:  z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
  /** Sell under this type in this shop (false = hidden from this shop only). */
  enabled:   z.boolean().optional(),
});
export const SetPricesSchema = z.object({
  prices: z.array(z.object({
    productId:  z.string().uuid(),
    saleTypeId: z.string().uuid(),
    price:      MONEY_POSITIVE.nullable(),    // null removes the price (product no longer sold under that type)
  })).min(1).max(1000),
});
export const TransferSchema = z.object({
  productId:      z.string().uuid(),
  fromSaleTypeId: z.string().uuid().nullable().optional(),   // omitted / null = the default type
  toSaleTypeId:   z.string().uuid().nullable().optional(),
  quantity:       z.number().int().positive().max(100_000),
});
export type TransferInput = z.infer<typeof TransferSchema>;

// ─── TENANT / TYPES ──────────────────────────────────────────────────────────

/** The business a branch belongs to (syndicate id), or null for a standalone shop. */
export async function branchTenant(exec: Exec, branchId: string): Promise<string | null> {
  const [b] = await exec.select({ syndicateId: branches.syndicateId }).from(branches).where(eq(branches.id, branchId)).limit(1);
  if (!b) throw new NotFoundError('Branch not found');
  return b.syndicateId;
}

const tenantScope = (tenant: string | null) => (tenant === null ? isNull(saleTypes.syndicateId) : eq(saleTypes.syndicateId, tenant));

/** Creates Walk-in (default) and Janata for a business the first time it is needed. Idempotent. */
export async function ensureTenantSaleTypes(exec: Exec, tenant: string | null): Promise<void> {
  const existing = await exec.select({ id: saleTypes.id }).from(saleTypes).where(tenantScope(tenant)).limit(1);
  if (existing.length > 0) return;
  await exec.insert(saleTypes).values(DEFAULT_SALE_TYPES.map((d) => ({ ...d, syndicateId: tenant }))).onConflictDoNothing();
}

/** Sale types of the branch's business, with this shop's on/off switch. Inactive / disabled ones only when asked. */
export async function listBranchSaleTypes(exec: Exec, branchId: string, opts: { all?: boolean } = {}): Promise<BranchSaleType[]> {
  const tenant = await branchTenant(exec, branchId);
  await ensureTenantSaleTypes(exec, tenant);
  const rows = await exec.select().from(saleTypes).where(tenantScope(tenant)).orderBy(asc(saleTypes.sortOrder), asc(saleTypes.name));
  const overrides = await exec.select().from(branchSaleTypes).where(eq(branchSaleTypes.branchId, branchId));
  const switches = new Map(overrides.map((o) => [o.saleTypeId, o.enabled]));
  const list = rows.map((r) => ({
    id: r.id, code: r.code, name: r.name, isDefault: r.isDefault, sortOrder: r.sortOrder, isActive: r.isActive,
    enabled: r.isDefault ? true : (switches.get(r.id) ?? true),
  }));
  return opts.all ? list : list.filter((t) => t.isActive && t.enabled);
}

/** The sale type a bill / sheet is for: the given one (must be sold in this shop) or the default. */
export async function resolveSaleType(exec: Exec, branchId: string, saleTypeId?: string | null): Promise<BranchSaleType> {
  const list = await listBranchSaleTypes(exec, branchId);
  if (!saleTypeId) {
    const def = list.find((t) => t.isDefault);
    if (!def) throw new BusinessRuleError('This business has no default sale type');
    return def;
  }
  const found = list.find((t) => t.id === saleTypeId);
  if (!found) throw new BusinessRuleError('That sale type is not available in this shop');
  return found;
}

export async function createSaleType(branchId: string, input: z.infer<typeof CreateSaleTypeSchema>) {
  const tenant = await branchTenant(db, branchId);
  await ensureTenantSaleTypes(db, tenant);
  const existing = await db.select({ sortOrder: saleTypes.sortOrder }).from(saleTypes).where(tenantScope(tenant));
  try {
    const [row] = await db.insert(saleTypes).values({
      syndicateId: tenant,
      code: normalizeSaleTypeCode(input.code ?? input.name),
      name: input.name,
      sortOrder: Math.max(0, ...existing.map((e) => e.sortOrder)) + 1,
    }).returning();
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError(`A sale type with the code ${normalizeSaleTypeCode(input.code ?? input.name)} already exists`);
    throw err;
  }
}

export async function updateSaleType(branchId: string, id: string, input: z.infer<typeof UpdateSaleTypeSchema>) {
  const tenant = await branchTenant(db, branchId);
  const [row] = await db.select().from(saleTypes).where(and(eq(saleTypes.id, id), tenantScope(tenant))).limit(1);
  if (!row) throw new NotFoundError('Sale type not found');
  if (row.isDefault && input.isActive === false) throw new BusinessRuleError('The default sale type cannot be switched off');
  if (row.isDefault && input.enabled === false) throw new BusinessRuleError('The default sale type is always on');
  await db.transaction(async (tx) => {
    const patch: Partial<typeof saleTypes.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.isActive !== undefined) patch.isActive = input.isActive;
    if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
    if (Object.keys(patch).length > 0) await tx.update(saleTypes).set(patch).where(eq(saleTypes.id, id));
    if (input.enabled !== undefined) {
      await tx.insert(branchSaleTypes).values({ branchId, saleTypeId: id, enabled: input.enabled })
        .onConflictDoUpdate({ target: [branchSaleTypes.branchId, branchSaleTypes.saleTypeId], set: { enabled: input.enabled } });
    }
  });
  return (await listBranchSaleTypes(db, branchId, { all: true })).find((t) => t.id === id)!;
}

// ─── PRICES ──────────────────────────────────────────────────────────────────

const productScope = (tenant: string | null) => (tenant === null ? isNull(products.syndicateId) : or(isNull(products.syndicateId), eq(products.syndicateId, tenant)));

/** One table for everything price-related: each retail product with its default price (MRP) and a price per other type. */
export async function getPriceMatrix(branchId: string) {
  const tenant = await branchTenant(db, branchId);
  const types = await listBranchSaleTypes(db, branchId, { all: true });
  const priced = types.filter((t) => !t.isDefault);
  const prods = await db.select({
    id: products.id, name: products.name, brand: products.brand, volumeMl: products.volumeMl, packQuantity: products.packQuantity,
    exciseCode: products.exciseCode, barcode: products.barcode, mrp: products.mrp,
  }).from(products).where(and(eq(products.isActive, true), eq(products.menuType, 'RETAIL'), productScope(tenant))).orderBy(asc(products.name));
  const prices = priced.length === 0 || prods.length === 0 ? [] : await db.select().from(productPrices)
    .where(and(inArray(productPrices.saleTypeId, priced.map((t) => t.id)), inArray(productPrices.productId, prods.map((p) => p.id))));
  const byProduct = new Map<string, Record<string, string>>();
  for (const p of prices) byProduct.set(p.productId, { ...(byProduct.get(p.productId) ?? {}), [p.saleTypeId]: p.price });
  return { types, products: prods.map((p) => ({ ...p, prices: byProduct.get(p.id) ?? {} })) };
}

/** Sets / clears prices for non-default types in one transaction; every change is audited. The default price stays products.mrp. */
export async function setPrices(user: JwtPayload, branchId: string, input: z.infer<typeof SetPricesSchema>) {
  const tenant = await branchTenant(db, branchId);
  return db.transaction(async (tx) => {
    const types = new Map((await listBranchSaleTypes(tx, branchId, { all: true })).map((t) => [t.id, t]));
    const prods = new Map((await tx.select({ id: products.id, name: products.name }).from(products)
      .where(and(inArray(products.id, [...new Set(input.prices.map((p) => p.productId))]), productScope(tenant)))).map((p) => [p.id, p]));
    let changed = 0;
    for (const entry of input.prices) {
      const type = types.get(entry.saleTypeId);
      if (!type) throw new BusinessRuleError('Unknown sale type for this business');
      if (type.isDefault) throw new BusinessRuleError(`${type.name} is priced by the product's MRP — change the MRP instead`);
      const product = prods.get(entry.productId);
      if (!product) throw new BusinessRuleError(`Unknown product ${entry.productId}`);

      const [old] = await tx.select().from(productPrices)
        .where(and(eq(productPrices.productId, entry.productId), eq(productPrices.saleTypeId, entry.saleTypeId))).for('update');
      const newPrice = entry.price === null ? null : new Decimal(entry.price).toFixed(2);
      if ((old?.price ?? null) === newPrice) continue;

      if (newPrice === null) {
        const [held] = await tx.select({ q: sql<number>`coalesce(sum(${stockByType.quantity}), 0)::int` }).from(stockByType)
          .where(and(eq(stockByType.productId, entry.productId), eq(stockByType.saleTypeId, entry.saleTypeId)));
        if ((held?.q ?? 0) > 0) throw new BusinessRuleError(`${product.name}: ${held.q} bottle(s) are still in the ${type.name} counter — move them back before removing the price`);
        await tx.delete(productPrices).where(and(eq(productPrices.productId, entry.productId), eq(productPrices.saleTypeId, entry.saleTypeId)));
      } else {
        await tx.insert(productPrices).values({ productId: entry.productId, saleTypeId: entry.saleTypeId, price: newPrice })
          .onConflictDoUpdate({ target: [productPrices.productId, productPrices.saleTypeId], set: { price: newPrice, updatedAt: new Date() } });
      }
      await tx.insert(priceAudit).values({
        productId: entry.productId, userId: user.sub, oldMrp: old?.price ?? null, newMrp: newPrice ?? '0.00', saleTypeId: entry.saleTypeId,
      });
      changed++;
    }
    return { changed };
  });
}

/** Price of each product under one non-default type (productId → price). */
export async function typePrices(exec: Exec, saleTypeId: string, productIds: string[]): Promise<Map<string, string>> {
  if (productIds.length === 0) return new Map();
  const rows = await exec.select().from(productPrices)
    .where(and(eq(productPrices.saleTypeId, saleTypeId), inArray(productPrices.productId, productIds)));
  return new Map(rows.map((r) => [r.productId, r.price]));
}

// ─── STOCK PER COUNTER ───────────────────────────────────────────────────────

/** Explicit counters of a product in a branch (saleTypeId → bottles). */
export async function explicitCounters(exec: Exec, branchId: string, productId: string): Promise<Map<string, number>> {
  const rows = await exec.select().from(stockByType).where(and(eq(stockByType.branchId, branchId), eq(stockByType.productId, productId)));
  return new Map(rows.map((r) => [r.saleTypeId, r.quantity]));
}

/** Σ explicit counters per product for a branch — what the default type must leave untouched. */
export async function explicitSums(exec: Exec, branchId: string, productIds: string[]): Promise<Map<string, number>> {
  if (productIds.length === 0) return new Map();
  const rows = await exec
    .select({ productId: stockByType.productId, q: sql<number>`coalesce(sum(${stockByType.quantity}), 0)::int` })
    .from(stockByType)
    .where(and(eq(stockByType.branchId, branchId), inArray(stockByType.productId, productIds)))
    .groupBy(stockByType.productId);
  return new Map(rows.map((r) => [r.productId, r.q]));
}

/** Bottles per product and counter for a branch (for the transfer dialog and the stock screen). */
export async function listCounters(branchId: string) {
  const types = await listBranchSaleTypes(db, branchId);
  const totals = await db.select({ productId: stock.productId, quantity: stock.quantity }).from(stock).where(eq(stock.branchId, branchId));
  const explicit = await db.select().from(stockByType).where(eq(stockByType.branchId, branchId));
  const byProduct = new Map<string, Map<string, number>>();
  for (const e of explicit) byProduct.set(e.productId, (byProduct.get(e.productId) ?? new Map()).set(e.saleTypeId, e.quantity));
  return {
    types,
    products: totals.map((t) => {
      const ex = byProduct.get(t.productId) ?? new Map<string, number>();
      return {
        productId: t.productId, total: t.quantity,
        counters: Object.fromEntries(types.map((ty) => [ty.id, counterQuantity(ty, t.quantity, ex)])),
      };
    }),
  };
}

/** Moves bottles between two counters inside the caller's transaction (no commit of its own). */
async function moveInTx(
  tx: Tx, user: JwtPayload, branchId: string, productId: string,
  from: BranchSaleType, to: BranchSaleType, quantity: number,
) {
  const [row] = await tx.select().from(stock)
    .where(and(eq(stock.branchId, branchId), eq(stock.productId, productId))).for('update');
  if (!row) throw new BusinessRuleError('There is no stock of this product in this shop');
  if (!to.isDefault) {
    const prices = await typePrices(tx, to.id, [productId]);
    if (!prices.has(productId)) throw new BusinessRuleError(`Set a ${to.name} price for this product before moving stock to it`);
  }
  const explicit = await explicitCounters(tx, branchId, productId);
  let next: Map<string, number>;
  try {
    next = applyTransfer(row.quantity, explicit, from, to, quantity);
  } catch (err) {
    throw new BusinessRuleError(err instanceof Error ? err.message : 'Transfer not possible');
  }
  for (const type of [from, to]) {
    if (type.isDefault) continue;
    await tx.insert(stockByType).values({ branchId, productId, saleTypeId: type.id, quantity: next.get(type.id) ?? 0 })
      .onConflictDoUpdate({ target: [stockByType.branchId, stockByType.productId, stockByType.saleTypeId], set: { quantity: next.get(type.id) ?? 0 } });
  }
  await tx.insert(stockAudit).values([
    { branchId, productId, userId: user.sub, changeQty: -quantity, reason: 'TYPE_TRANSFER' as const, saleTypeId: rowTypeId(from) },
    { branchId, productId, userId: user.sub, changeQty: quantity, reason: 'TYPE_TRANSFER' as const, saleTypeId: rowTypeId(to) },
  ]);
}

/**
 * Moves bottles between two counters of one shop (e.g. Walk-in → Janata, or back). The shop's total stock — the
 * source of truth, fed by approved invoices — does not change; two TYPE_TRANSFER audit rows record both sides.
 * The target type must already have a price for the product.
 */
export async function transferStock(user: JwtPayload, branchId: string, input: TransferInput) {
  return db.transaction(async (tx) => {
    const from = await resolveSaleType(tx, branchId, input.fromSaleTypeId);
    const to = await resolveSaleType(tx, branchId, input.toSaleTypeId);
    await moveInTx(tx, user, branchId, input.productId, from, to, input.quantity);
    return { from: from.id, to: to.id, quantity: input.quantity };
  });
}

export const SetAllocationSchema = z.object({
  allocations: z.array(z.object({
    productId:  z.string().uuid(),
    saleTypeId: z.string().uuid(),                       // a non-default type; Walk-in is whatever is left
    quantity:   z.number().int().min(0).max(1_000_000),  // bottles that counter should hold
  })).min(1).max(1000),
});

/**
 * "Divide the stock": sets how many bottles each non-default counter should hold; Walk-in keeps the rest of the shop total.
 * Applied as transfers (so every move is audited and today's sheets follow), decreases first so the bottles are free
 * before they are handed to another counter. All or nothing.
 */
export async function setAllocation(user: JwtPayload, branchId: string, input: z.infer<typeof SetAllocationSchema>) {
  return db.transaction(async (tx) => {
    const types = new Map((await listBranchSaleTypes(tx, branchId)).map((t) => [t.id, t]));
    const walkIn = [...types.values()].find((t) => t.isDefault)!;
    const wanted = new Map<string, number>();                       // `${productId}|${typeId}` → bottles
    for (const a of input.allocations) {
      const type = types.get(a.saleTypeId);
      if (!type) throw new BusinessRuleError('That sale type is not available in this shop');
      if (type.isDefault) throw new BusinessRuleError(`${type.name} keeps whatever is not given to another counter — set the other counters instead`);
      wanted.set(`${a.productId}|${a.saleTypeId}`, a.quantity);
    }
    const plan: { productId: string; type: BranchSaleType; diff: number }[] = [];
    for (const [k, quantity] of wanted) {
      const [productId, typeId] = k.split('|');
      const current = (await explicitCounters(tx, branchId, productId)).get(typeId) ?? 0;
      if (quantity !== current) plan.push({ productId, type: types.get(typeId)!, diff: quantity - current });
    }
    plan.sort((a, b) => a.diff - b.diff);                           // give bottles back to Walk-in first
    for (const p of plan) {
      if (p.diff > 0) await moveInTx(tx, user, branchId, p.productId, walkIn, p.type, p.diff);
      else await moveInTx(tx, user, branchId, p.productId, p.type, walkIn, -p.diff);
    }
    return { moved: plan.length, typeIds: [...new Set(plan.map((p) => p.type.id))] };
  });
}

/** Recent stock movements of one product in a shop, each tagged with the counter (sale type) that moved. */
export async function productMovements(branchId: string, productId: string, limit = 100) {
  const types = await listBranchSaleTypes(db, branchId, { all: true });
  const names = new Map(types.map((t) => [t.id, t.name]));
  const walkIn = types.find((t) => t.isDefault)?.name ?? 'Walk-in';
  const rows = await db.select().from(stockAudit)
    .where(and(eq(stockAudit.branchId, branchId), eq(stockAudit.productId, productId)))
    .orderBy(desc(stockAudit.createdAt)).limit(Math.min(Math.max(limit, 1), 500));
  return rows.map((r) => ({
    id: r.id, at: r.createdAt, reason: r.reason, changeQty: r.changeQty, referenceId: r.referenceId,
    counter: r.saleTypeId ? (names.get(r.saleTypeId) ?? 'Other') : walkIn,
  }));
}