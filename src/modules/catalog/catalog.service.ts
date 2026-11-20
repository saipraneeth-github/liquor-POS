/**
 * catalog.service.ts — The master catalog → tenant mapping, and the tenant's / branch's prices.
 *
 *   master_products   platform-owned reference list (no prices, no tenant)
 *   products          the tenant's items; `master_product_id` = which master product an item maps to
 *   branch_product_prices   a branch's own price over the tenant-wide price
 *
 * Tenants pick products from the master and TYPE their prices; nothing here invents a price.
 */
import { and, asc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { Decimal } from 'decimal.js';
import { db } from '../../db/client.js';
import {
  branches, branchProductCosts, branchProductPrices, categories, masterProductBarcodes, masterProducts, priceAudit, productPrices, products, saleTypes, stock,
} from '../../db/schema.js';
import type { Tx } from '../../lib/domain-events.js';
import { BusinessRuleError, ConflictError, NotFoundError, isUniqueViolation } from '../../lib/errors.js';
import { cleanProductName } from '../../lib/product-name.js';
import type { JwtPayload } from '../auth/auth.service.js';
import type { Tenant } from '../menu/menu-access.js';
import { foldBranchPrices, needsTenantPrice, positivePrice, type BranchPriceEntry } from './price.engine.js';

type Exec = Tx | typeof db;

// ─── TENANT ──────────────────────────────────────────────────────────────────

/** The business a branch belongs to. A branch without one has no catalog, so catalog work on it is refused. */
export async function branchTenantId(exec: Exec, branchId: string): Promise<{ syndicateId: string; stateCode: string }> {
  const [b] = await exec.select({ syndicateId: branches.syndicateId, stateCode: branches.stateCode }).from(branches).where(eq(branches.id, branchId)).limit(1);
  if (!b) throw new NotFoundError('Branch not found');
  if (!b.syndicateId) throw new BusinessRuleError('This branch does not belong to a business yet, so it has no product catalog');
  return { syndicateId: b.syndicateId, stateCode: b.stateCode };
}

/** A concrete tenant id for work that writes catalog data (the platform owner has to pick a business first). */
export function requireTenantId(tenant: Tenant): string {
  if (tenant === 'ALL' || tenant === null) throw new BusinessRuleError('Choose a business (branch) first: the catalog belongs to a business');
  return tenant;
}

/** SQL scope for `products` rows a caller may see. 'ALL' = platform owner. A user without a business sees nothing. */
export function productTenantScope(tenant: Tenant): SQL | undefined {
  if (tenant === 'ALL') return undefined;
  if (tenant === null) return sql`false`;
  return eq(products.syndicateId, tenant);
}

/** Categories a tenant can use: the platform's plus its own. */
export function categoryScope(tenant: Tenant): SQL | undefined {
  if (tenant === 'ALL') return undefined;
  if (tenant === null) return isNull(categories.syndicateId);
  return or(isNull(categories.syndicateId), eq(categories.syndicateId, tenant));
}

// ─── BRANCH PRICES ───────────────────────────────────────────────────────────

/** A branch's overrides for some products (all sale types), folded per product. One query. */
export async function branchPriceMap(exec: Exec, branchId: string | null | undefined, productIds: string[]): Promise<Map<string, BranchPriceEntry>> {
  if (!branchId || productIds.length === 0) return new Map();
  const rows = await exec.select({
    productId: branchProductPrices.productId, saleTypeId: branchProductPrices.saleTypeId, price: branchProductPrices.price,
  }).from(branchProductPrices)
    .where(and(eq(branchProductPrices.branchId, branchId), inArray(branchProductPrices.productId, productIds)));
  return foldBranchPrices(rows);
}

// ─── BRANCH COST ─────────────────────────────────────────────────────────────

export type BranchCost = typeof branchProductCosts.$inferSelect;

/** What a branch last paid for some products (latest approved invoice at THAT branch), keyed by product. One query. */
export async function branchCostMap(exec: Exec, branchId: string | null | undefined, productIds: string[]): Promise<Map<string, BranchCost>> {
  if (!branchId || productIds.length === 0) return new Map();
  const rows = await exec.select().from(branchProductCosts)
    .where(and(eq(branchProductCosts.branchId, branchId), inArray(branchProductCosts.productId, productIds)));
  return new Map(rows.map((r) => [r.productId, r]));
}

// ─── MASTER CATALOG ──────────────────────────────────────────────────────────

export interface MasterListQuery {
  q?: string;
  category?: string;
  stateCode?: string;
  priceStatus?: 'all' | 'priced' | 'unpriced';
  /** true = only already mapped, false = only not yet mapped, undefined = both */
  mapped?: boolean;
  limit?: number;
  offset?: number;
}

/** Distinct active states available in the master catalog. */
export async function masterStates(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ state: masterProducts.state })
    .from(masterProducts)
    .where(eq(masterProducts.isActive, true))
    .orderBy(asc(masterProducts.state));
  const states = rows.map((r) => r.state).filter(Boolean);
  return states.length > 0 ? states : ['TS'];
}

/** The state's master products, each flagged with whether this tenant has mapped it (and the tenant product id). No prices. */
export async function listMasterCatalog(tenantId: string, stateCode: string, query: MasterListQuery = {}) {
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
  const offset = Math.max(query.offset ?? 0, 0);
  const targetState = (query.stateCode?.trim().toUpperCase()) || stateCode;
  const conds: SQL[] = [eq(masterProducts.state, targetState), eq(masterProducts.isActive, true)];
  const q = query.q?.trim();
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    conds.push(or(
      ilike(masterProducts.name, like), ilike(masterProducts.brand, like), eq(masterProducts.exciseCode, q), eq(masterProducts.sku, q),
      sql`exists (select 1 from ${masterProductBarcodes} b where b.master_product_id = ${masterProducts.id} and b.barcode = ${q})`,
    )!);
  }
  if (query.category) conds.push(sql`lower(${masterProducts.categoryName}) = lower(${query.category})`);
  if (query.mapped === true) conds.push(sql`${products.id} is not null`);
  if (query.mapped === false) conds.push(sql`${products.id} is null`);
  if (query.priceStatus === 'unpriced') {
    conds.push(sql`${products.id} is not null and (${products.mrp} is null or ${products.mrp} <= 0)`);
  } else if (query.priceStatus === 'priced') {
    conds.push(sql`${products.id} is not null and ${products.mrp} > 0`);
  }

  const where = and(...conds);
  const base = db.select({
    id: masterProducts.id, state: masterProducts.state, categoryName: masterProducts.categoryName, name: masterProducts.name,
    brand: masterProducts.brand, volumeMl: masterProducts.volumeMl, packQuantity: masterProducts.packQuantity,
    exciseCode: masterProducts.exciseCode, sku: masterProducts.sku,
    productId: products.id, mrp: products.mrp,
  }).from(masterProducts)
    .leftJoin(products, and(eq(products.masterProductId, masterProducts.id), eq(products.syndicateId, tenantId)))
    .where(where);
  const [rows, [{ n }]] = await Promise.all([
    base.orderBy(asc(masterProducts.categoryName), asc(masterProducts.brand), asc(masterProducts.volumeMl)).limit(limit).offset(offset),
    db.select({ n: sql<number>`count(*)::int` }).from(masterProducts)
      .leftJoin(products, and(eq(products.masterProductId, masterProducts.id), eq(products.syndicateId, tenantId))).where(where),
  ]);
  return {
    total: n,
    items: rows.map((r) => ({
      id: r.id, state: r.state, categoryName: r.categoryName, name: r.name, brand: r.brand, volumeMl: r.volumeMl,
      packQuantity: r.packQuantity, exciseCode: r.exciseCode, sku: r.sku,
      mapped: r.productId !== null, productId: r.productId, needsPrice: r.productId !== null && needsTenantPrice(r.mrp),
    })),
  };
}

export async function masterCategories(stateCode: string) {
  const rows = await db.select({ name: masterProducts.categoryName, n: sql<number>`count(*)::int` }).from(masterProducts)
    .where(and(eq(masterProducts.state, stateCode), eq(masterProducts.isActive, true)))
    .groupBy(masterProducts.categoryName).orderBy(asc(masterProducts.categoryName));
  return rows;
}

export interface MapResult { created: number; alreadyMapped: number; skipped: Array<{ masterProductId: string; reason: string }>; productIds: string[] }

/**
 * Maps master products to a tenant: creates the tenant's product (identity from the master, NO price — it shows as "needs
 * price" until the tenant types one). Safe to repeat and to run concurrently: a tenant maps a master product once
 * (unique index), and an own item that already carries the master SKU is adopted instead of duplicated.
 */
export async function mapMasterProducts(exec: Exec, tenantId: string, masterIds: string[]): Promise<MapResult> {
  const result: MapResult = { created: 0, alreadyMapped: 0, skipped: [], productIds: [] };
  const ids = [...new Set(masterIds)];
  if (ids.length === 0) return result;

  const masters = await exec.select().from(masterProducts).where(and(inArray(masterProducts.id, ids), eq(masterProducts.isActive, true)));
  const known = new Set(masters.map((m) => m.id));
  for (const id of ids) if (!known.has(id)) result.skipped.push({ masterProductId: id, reason: 'Not in the master catalog' });

  // Platform categories only: a tenant never creates one by mapping
  const cats = await exec.select({ id: categories.id, name: categories.name }).from(categories).where(isNull(categories.syndicateId));
  const catByName = new Map(cats.map((c) => [c.name.toLowerCase(), c.id]));

  const existing = await exec.select({ id: products.id, masterProductId: products.masterProductId, sku: products.sku })
    .from(products).where(and(eq(products.syndicateId, tenantId), or(inArray(products.masterProductId, [...known]), inArray(products.sku, masters.map((m) => m.sku)))));
  const mappedBy = new Map(existing.filter((e) => e.masterProductId).map((e) => [e.masterProductId!, e.id]));
  const ownBySku = new Map(existing.filter((e) => !e.masterProductId && e.sku).map((e) => [e.sku!, e.id]));

  const toInsert: Array<typeof products.$inferInsert> = [];
  for (const m of masters) {
    const have = mappedBy.get(m.id);
    if (have) { result.alreadyMapped += 1; result.productIds.push(have); continue; }
    const own = ownBySku.get(m.sku);
    if (own) {   // the tenant already made this bottle by hand: adopt it instead of creating a second one
      await exec.update(products).set({ masterProductId: m.id, masterRevision: m.revision }).where(eq(products.id, own));
      result.created += 1; result.productIds.push(own); continue;
    }
    const categoryId = catByName.get(m.categoryName.toLowerCase());
    if (!categoryId) { result.skipped.push({ masterProductId: m.id, reason: `Category "${m.categoryName}" is not set up on the platform` }); continue; }
    toInsert.push({
      categoryId, masterProductId: m.id, masterRevision: m.revision, name: cleanProductName(m.name), brand: m.brand, volumeMl: m.volumeMl,
      packQuantity: m.packQuantity, exciseCode: m.exciseCode, sku: m.sku, mrp: '0.00', syndicateId: tenantId,
    });
  }
  if (toInsert.length > 0) {
    // onConflictDoNothing: a concurrent request (or a barcode/SKU clash) must not fail the batch; re-read what exists after
    const inserted = await exec.insert(products).values(toInsert).onConflictDoNothing().returning({ id: products.id, masterProductId: products.masterProductId });
    result.created += inserted.length;
    for (const r of inserted) result.productIds.push(r.id);
    const insertedMasters = new Set(inserted.map((r) => r.masterProductId));
    const missed = toInsert.filter((t) => !insertedMasters.has(t.masterProductId!));
    if (missed.length > 0) {
      const again = await exec.select({ id: products.id, masterProductId: products.masterProductId }).from(products)
        .where(and(eq(products.syndicateId, tenantId), inArray(products.masterProductId, missed.map((t) => t.masterProductId!))));
      const got = new Set(again.map((r) => r.masterProductId));
      for (const r of again) { result.alreadyMapped += 1; result.productIds.push(r.id); }
      for (const t of missed) if (!got.has(t.masterProductId!)) result.skipped.push({ masterProductId: t.masterProductId!, reason: 'Its SKU or barcode is already used by another of your products' });
    }
  }
  return result;
}

/** Master ids for "add everything in these categories" / "add all". */
export async function masterIdsFor(stateCode: string, opts: { categoryNames?: string[]; all?: boolean }): Promise<string[]> {
  if (!opts.all && !(opts.categoryNames?.length)) return [];
  const conds: SQL[] = [eq(masterProducts.state, stateCode), eq(masterProducts.isActive, true)];
  if (!opts.all) conds.push(sql`lower(${masterProducts.categoryName}) in (${sql.join((opts.categoryNames ?? []).map((c) => sql`${c.toLowerCase()}`), sql`, `)})`);
  const rows = await db.select({ id: masterProducts.id }).from(masterProducts).where(and(...conds));
  return rows.map((r) => r.id);
}

// ─── PRICING GRID ────────────────────────────────────────────────────────────

export interface PricingQuery { q?: string; unpricedOnly?: boolean; inStockOnly?: boolean; limit?: number; offset?: number }

/** Every retail product of the business with its tenant price and (for the chosen branch) its override. */
export async function listPricing(tenantId: string, branchId: string | null, query: PricingQuery = {}) {
  const limit = Math.min(Math.max(query.limit ?? 500, 1), 2000);
  const offset = Math.max(query.offset ?? 0, 0);
  const conds: SQL[] = [eq(products.syndicateId, tenantId), eq(products.isActive, true), eq(products.menuType, 'RETAIL')];
  const q = query.q?.trim();
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    conds.push(or(ilike(products.name, like), ilike(products.brand, like), eq(products.sku, q), eq(products.barcode, q), eq(products.exciseCode, q))!);
  }
  if (query.unpricedOnly) {
    // "needs a price": no tenant price, and — when a branch is chosen — no override there either
    conds.push(sql`${products.mrp} <= 0`);
    if (branchId) conds.push(sql`not exists (select 1 from ${branchProductPrices} o where o.product_id = ${products.id} and o.branch_id = ${branchId} and o.sale_type_id is null and o.price > 0)`);
  }
  if (query.inStockOnly && branchId) {
    conds.push(sql`exists (select 1 from ${stock} s where s.product_id = ${products.id} and s.branch_id = ${branchId} and s.quantity > 0)`);
  }
  const rows = await db.select({
    id: products.id, name: products.name, brand: products.brand, volumeMl: products.volumeMl, packQuantity: products.packQuantity,
    exciseCode: products.exciseCode, barcode: products.barcode, sku: products.sku, mrp: products.mrp, costPrice: products.costPrice,
    masterProductId: products.masterProductId, categoryName: categories.name,
  }).from(products).leftJoin(categories, eq(products.categoryId, categories.id))
    .where(and(...conds)).orderBy(asc(products.name)).limit(limit).offset(offset);
  const [overrides, costs, stockRows] = await Promise.all([
    branchPriceMap(db, branchId, rows.map((r) => r.id)),
    branchCostMap(db, branchId, rows.map((r) => r.id)),
    branchId && rows.length > 0
      ? db.select({ productId: stock.productId, quantity: stock.quantity })
          .from(stock)
          .where(and(eq(stock.branchId, branchId), inArray(stock.productId, rows.map((r) => r.id))))
      : Promise.resolve([]),
  ]);
  const stockMap = new Map<string, number>(stockRows.map((s) => [s.productId, s.quantity]));
  const [{ n: unpriced }] = await db.select({ n: sql<number>`count(*)::int` }).from(products)
    .where(and(eq(products.syndicateId, tenantId), eq(products.isActive, true), eq(products.menuType, 'RETAIL'), sql`${products.mrp} <= 0`));
  return {
    unpricedCount: unpriced,
    items: rows.map((r) => {
      const o = overrides.get(r.id);
      const c = costs.get(r.id);
      const tenantPrice = positivePrice(r.mrp);
      const effectivePrice = positivePrice(o?.base) ?? tenantPrice;
      const effectiveCost = c?.costPrice ?? r.costPrice ?? null;
      return {
        ...r, mrp: r.mrp, tenantPrice, branchPrice: positivePrice(o?.base),
        effectivePrice,
        needsPrice: effectivePrice === null,
        mapped: r.masterProductId !== null,
        costPrice: effectiveCost ? Number(effectiveCost).toFixed(2) : null,
        stockQuantity: stockMap.get(r.id) ?? 0,
      };
    }),
  };
}

export interface PriceRow { productId?: string; sku?: string; barcode?: string; price: string | null }

async function resolveRows<R extends PriceRow>(exec: Exec, tenantId: string, rows: R[]) {
  const ids = rows.flatMap((r) => (r.productId ? [r.productId] : []));
  const skus = rows.flatMap((r) => (!r.productId && r.sku ? [r.sku] : []));
  const barcodes = rows.flatMap((r) => (!r.productId && !r.sku && r.barcode ? [r.barcode] : []));
  const conds = [
    ids.length ? inArray(products.id, ids) : undefined,
    skus.length ? inArray(products.sku, skus) : undefined,
    barcodes.length ? inArray(products.barcode, barcodes) : undefined,
  ].filter(Boolean) as SQL[];
  const found = conds.length === 0 ? [] : await exec.select({ id: products.id, sku: products.sku, barcode: products.barcode, mrp: products.mrp, name: products.name })
    .from(products).where(and(eq(products.syndicateId, tenantId), or(...conds)));
  const byId = new Map(found.map((p) => [p.id, p]));
  const bySku = new Map(found.filter((p) => p.sku).map((p) => [p.sku!, p]));
  const byBarcode = new Map(found.filter((p) => p.barcode).map((p) => [p.barcode!, p]));
  // Same order as the input; a row that names no product of this business is reported, not guessed
  const resolved = rows.map((row) => ({
    row,
    product: row.productId ? byId.get(row.productId) : row.sku ? bySku.get(row.sku) : row.barcode ? byBarcode.get(row.barcode) : undefined,
  }));
  const unknown = resolved.filter((r) => !r.product).map((r) => r.row.productId ?? r.row.sku ?? r.row.barcode ?? '(blank row)');
  return { resolved, unknown };
}

function moneyOrThrow(price: string | null, label: string): string | null {
  if (price === null) return null;
  const p = positivePrice(price);
  if (p === null) throw new BusinessRuleError(`${label}: price must be greater than zero`);
  if (new Decimal(p).gt('9999999999')) throw new BusinessRuleError(`${label}: price is too large`);
  return p;
}

/** Sets the business-wide selling price (typed by the tenant) for many products at once; every change is audited. */
export async function setTenantPrices(tenantId: string, user: JwtPayload, rows: PriceRow[]) {
  return db.transaction(async (tx) => {
    const { resolved, unknown } = await resolveRows(tx, tenantId, rows);
    const last = new Map<string, { product: NonNullable<(typeof resolved)[number]['product']>; price: string }>();
    for (const { row, product } of resolved) {
      if (!product) continue;
      const price = moneyOrThrow(row.price, product.name);
      if (price === null) throw new BusinessRuleError(`${product.name}: a business-wide price cannot be removed, only changed`);
      last.set(product.id, { product, price });   // the last row for a product wins
    }
    const changes = [...last.values()].filter((c) => !new Decimal(c.product.mrp).equals(c.price));
    if (changes.length > 0) {
      const caseSql = sql`CAST(CASE ${sql.join(changes.map((c) => sql`WHEN ${products.id} = ${c.product.id} THEN ${c.price}`), sql` `)} END AS numeric)`;
      await tx.update(products).set({ mrp: caseSql }).where(inArray(products.id, changes.map((c) => c.product.id)));
      await tx.insert(priceAudit).values(changes.map((c) => ({ productId: c.product.id, userId: user.sub, oldMrp: c.product.mrp, newMrp: c.price })));
    }
    return { updated: changes.length, unchanged: last.size - changes.length, unknown };
  });
}

/** Sets or removes a branch's own price (default type, or one sale type) over the business-wide price. price null = remove. */
export async function setBranchPrices(
  tenantId: string, branchId: string, user: JwtPayload,
  rows: Array<PriceRow & { saleTypeId?: string | null }>,
) {
  return db.transaction(async (tx) => {
    const { resolved, unknown } = await resolveRows(tx, tenantId, rows);
    // Which sale type each input row refers to; the default type is stored as NULL
    const typeIds = [...new Set(rows.flatMap((r) => (r.saleTypeId ? [r.saleTypeId] : [])))];
    const types = typeIds.length === 0 ? [] : await tx.select({ id: saleTypes.id, isDefault: saleTypes.isDefault, syndicateId: saleTypes.syndicateId })
      .from(saleTypes).where(inArray(saleTypes.id, typeIds));
    const typeById = new Map(types.map((t) => [t.id, t]));
    for (const id of typeIds) {
      const t = typeById.get(id);
      if (!t || t.syndicateId !== tenantId) throw new BusinessRuleError('Unknown sale type');
    }
    const wanted = new Map<string, { productId: string; saleTypeId: string | null; price: string | null }>();
    for (const { row, product } of resolved) {
      if (!product) continue;
      const t = row.saleTypeId ? typeById.get(row.saleTypeId)! : null;
      const saleTypeId = t && !t.isDefault ? t.id : null;
      wanted.set(`${product.id}:${saleTypeId ?? ''}`, { productId: product.id, saleTypeId, price: moneyOrThrow(row.price, product.name) });
    }
    const list = [...wanted.values()];
    if (list.length === 0) return { updated: 0, removed: 0, unknown };

    const current = await tx.select().from(branchProductPrices)
      .where(and(eq(branchProductPrices.branchId, branchId), inArray(branchProductPrices.productId, [...new Set(list.map((l) => l.productId))])));
    const curKey = new Map(current.map((c) => [`${c.productId}:${c.saleTypeId ?? ''}`, c]));
    const audits: Array<typeof priceAudit.$inferInsert> = [];
    let updated = 0; let removed = 0;
    for (const w of list) {
      const cur = curKey.get(`${w.productId}:${w.saleTypeId ?? ''}`);
      if (w.price === null) {
        if (!cur) continue;
        await tx.delete(branchProductPrices).where(eq(branchProductPrices.id, cur.id));
        removed += 1;
        continue;
      }
      if (cur && new Decimal(cur.price).equals(w.price)) continue;
      if (cur) await tx.update(branchProductPrices).set({ price: w.price, updatedById: user.sub, updatedAt: new Date() }).where(eq(branchProductPrices.id, cur.id));
      else await tx.insert(branchProductPrices).values({ branchId, productId: w.productId, saleTypeId: w.saleTypeId, price: w.price, updatedById: user.sub });
      audits.push({ productId: w.productId, userId: user.sub, oldMrp: cur?.price ?? null, newMrp: w.price, saleTypeId: w.saleTypeId, branchId });
      updated += 1;
    }
    if (audits.length > 0) await tx.insert(priceAudit).values(audits);
    return { updated, removed, unknown };
  });
}

/** Typed prices of the sale types for a product list (used where a bill is priced). */
export async function typePricesFor(exec: Exec, saleTypeId: string, productIds: string[]) {
  if (productIds.length === 0) return new Map<string, string>();
  const rows = await exec.select().from(productPrices).where(and(eq(productPrices.saleTypeId, saleTypeId), inArray(productPrices.productId, productIds)));
  return new Map(rows.map((r) => [r.productId, r.price]));
}

// ─── PLATFORM: LOADING THE MASTER CATALOG ────────────────────────────────────

export interface MasterProductInput {
  state?: string;
  categoryName: string;
  name: string;
  brand: string;
  volumeMl: number;
  packQuantity: number;
  exciseCode: string;
  sku: string;
  barcodes?: string[];
}

/**
 * Platform operation (seed / Super Admin import): adds or refreshes master products. A master product names a category, so the
 * PLATFORM category is created here if it is missing (18% GST until the Super Admin sets the real rate): tenants never create
 * platform categories. A master row carries no price. Existing (state, excise code, volume) rows keep their id and are updated.
 */
export async function upsertMasterProducts(rows: MasterProductInput[], exec: Exec = db): Promise<{ added: number; updated: number }> {
  if (rows.length === 0) return { added: 0, updated: 0 };
  const names = [...new Set(rows.map((r) => r.categoryName))];
  const have = await exec.select({ name: categories.name }).from(categories).where(isNull(categories.syndicateId));
  const haveLower = new Set(have.map((c) => c.name.toLowerCase()));
  const missing = names.filter((n) => !haveLower.has(n.toLowerCase()));
  if (missing.length > 0) await exec.insert(categories).values(missing.map((name) => ({ name, taxRate: '18.00' }))).onConflictDoNothing();

  let added = 0; let updated = 0;
  for (const r of rows) {
    const state = r.state ?? 'TS';
    const [prev] = await exec.select({ id: masterProducts.id }).from(masterProducts)
      .where(and(eq(masterProducts.state, state), eq(masterProducts.exciseCode, r.exciseCode), eq(masterProducts.volumeMl, r.volumeMl))).limit(1);
    let id = prev?.id;
    if (prev) {
      const [cur] = await exec.select().from(masterProducts).where(eq(masterProducts.id, prev.id)).limit(1);
      const identityChanged = cur.categoryName !== r.categoryName || cur.brand !== r.brand || cur.packQuantity !== r.packQuantity || cur.sku !== r.sku;
      await exec.update(masterProducts).set({
        categoryName: r.categoryName, name: r.name, brand: r.brand, packQuantity: r.packQuantity, sku: r.sku,
        ...(identityChanged ? { revision: sql`${masterProducts.revision} + 1` } : {}), updatedAt: new Date(),
      }).where(eq(masterProducts.id, prev.id));
      updated += 1;
    } else {
      const [row] = await exec.insert(masterProducts).values({
        state, categoryName: r.categoryName, name: r.name, brand: r.brand, volumeMl: r.volumeMl, packQuantity: r.packQuantity, exciseCode: r.exciseCode, sku: r.sku,
      }).returning({ id: masterProducts.id });
      id = row.id; added += 1;
    }
    if (r.barcodes?.length) await exec.insert(masterProductBarcodes).values(r.barcodes.map((barcode) => ({ masterProductId: id!, barcode }))).onConflictDoNothing();
  }
  return { added, updated };
}

// ─── "UPDATE AVAILABLE": THE MASTER CHANGED AFTER THE BUSINESS ADDED A PRODUCT ───

export interface MasterUpdate {
  productId: string; name: string; masterProductId: string; discontinued: boolean;
  changes: Array<{ field: string; from: string | null; to: string | null }>;
}

const sameText = (a: unknown, b: unknown) => String(a ?? '') === String(b ?? '');

/** Mapped products whose master entry has a newer revision (what would change), plus discontinued ones. One query + one diff. */
export async function listMasterUpdates(tenantId: string): Promise<MasterUpdate[]> {
  const rows = await db.select({
    id: products.id, name: products.name, brand: products.brand, volumeMl: products.volumeMl, packQuantity: products.packQuantity,
    exciseCode: products.exciseCode, sku: products.sku, categoryId: products.categoryId, rev: products.masterRevision,
    mId: masterProducts.id, mBrand: masterProducts.brand, mVol: masterProducts.volumeMl, mPack: masterProducts.packQuantity,
    mExcise: masterProducts.exciseCode, mSku: masterProducts.sku, mCategory: masterProducts.categoryName, mRev: masterProducts.revision,
    mActive: masterProducts.isActive,
  }).from(products).innerJoin(masterProducts, eq(masterProducts.id, products.masterProductId))
    .where(and(eq(products.syndicateId, tenantId), eq(products.isActive, true),
      or(sql`coalesce(${products.masterRevision}, 0) < ${masterProducts.revision}`, eq(masterProducts.isActive, false))));
  if (rows.length === 0) return [];
  const cats = await db.select({ id: categories.id, name: categories.name }).from(categories).where(isNull(categories.syndicateId));
  const catName = new Map(cats.map((c) => [c.id, c.name]));
  return rows.map((r) => {
    const changes: MasterUpdate['changes'] = [];
    const diff = (field: string, from: unknown, to: unknown) => { if (!sameText(from, to)) changes.push({ field, from: from == null ? null : String(from), to: to == null ? null : String(to) }); };
    if ((r.rev ?? 0) < r.mRev) {
      diff('Brand', r.brand, r.mBrand); diff('Size (ml)', r.volumeMl, r.mVol); diff('Pack', r.packQuantity, r.mPack);
      diff('Excise code', r.exciseCode, r.mExcise); diff('SKU', r.sku, r.mSku); diff('Category', catName.get(r.categoryId ?? ''), r.mCategory);
    }
    return { productId: r.id, name: r.name, masterProductId: r.mId, discontinued: !r.mActive, changes };
  }).filter((u) => u.changes.length > 0 || u.discontinued);
}

/** Copies the master's identity onto the business's products (price, cost, stock and the display name are never touched). */
export async function applyMasterUpdates(tenantId: string, productIds?: string[]): Promise<{ applied: number; skipped: Array<{ productId: string; reason: string }> }> {
  return db.transaction(async (tx) => {
    const rows = await tx.select({
      id: products.id, sku: products.sku, rev: products.masterRevision,
      m: masterProducts,
    }).from(products).innerJoin(masterProducts, eq(masterProducts.id, products.masterProductId))
      .where(and(eq(products.syndicateId, tenantId), productIds?.length ? inArray(products.id, productIds) : undefined,
        sql`coalesce(${products.masterRevision}, 0) < ${masterProducts.revision}`));
    if (rows.length === 0) return { applied: 0, skipped: [] };
    const cats = await tx.select({ id: categories.id, name: categories.name }).from(categories).where(isNull(categories.syndicateId));
    const catId = new Map(cats.map((c) => [c.name.toLowerCase(), c.id]));
    const taken = await tx.select({ id: products.id, sku: products.sku }).from(products)
      .where(and(eq(products.syndicateId, tenantId), inArray(products.sku, rows.map((r) => r.m.sku))));
    const skuOwner = new Map(taken.map((t) => [t.sku, t.id]));
    const skipped: Array<{ productId: string; reason: string }> = [];
    let applied = 0;
    for (const r of rows) {
      const owner = skuOwner.get(r.m.sku);
      if (owner && owner !== r.id) { skipped.push({ productId: r.id, reason: `SKU ${r.m.sku} is already used by another of your products` }); continue; }
      const categoryId = catId.get(r.m.categoryName.toLowerCase());
      if (!categoryId) { skipped.push({ productId: r.id, reason: `Category "${r.m.categoryName}" is not set up on the platform` }); continue; }
      await tx.update(products).set({
        brand: r.m.brand, volumeMl: r.m.volumeMl, packQuantity: r.m.packQuantity, exciseCode: r.m.exciseCode, sku: r.m.sku,
        categoryId, masterRevision: r.m.revision,
      }).where(eq(products.id, r.id));
      applied += 1;
    }
    return { applied, skipped };
  });
}

// ─── PLATFORM: EDITING THE MASTER CATALOG (Super Admin) ──────────────────────

export interface MasterListFilter { state?: string; q?: string; category?: string; active?: boolean; limit?: number; offset?: number }

export async function adminListMaster(f: MasterListFilter) {
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 500);
  const conds: SQL[] = [];
  if (f.state) conds.push(eq(masterProducts.state, f.state));
  if (f.category) conds.push(sql`lower(${masterProducts.categoryName}) = lower(${f.category})`);
  if (f.active !== undefined) conds.push(eq(masterProducts.isActive, f.active));
  const q = f.q?.trim();
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    conds.push(or(ilike(masterProducts.name, like), ilike(masterProducts.brand, like), eq(masterProducts.exciseCode, q), eq(masterProducts.sku, q))!);
  }
  const where = conds.length ? and(...conds) : undefined;
  const [items, [{ n }], mapped] = await Promise.all([
    db.select().from(masterProducts).where(where).orderBy(asc(masterProducts.state), asc(masterProducts.categoryName), asc(masterProducts.brand), asc(masterProducts.volumeMl)).limit(limit).offset(Math.max(f.offset ?? 0, 0)),
    db.select({ n: sql<number>`count(*)::int` }).from(masterProducts).where(where),
    db.select({ id: products.masterProductId, n: sql<number>`count(*)::int` }).from(products).where(sql`${products.masterProductId} is not null`).groupBy(products.masterProductId),
  ]);
  const usage = new Map(mapped.map((m) => [m.id, m.n]));
  return { total: n, items: items.map((m) => ({ ...m, businesses: usage.get(m.id) ?? 0 })) };
}

export interface MasterPatch { name?: string; brand?: string; categoryName?: string; packQuantity?: number; sku?: string; isActive?: boolean }

/** Edits one master product. A change to what the bottle IS (brand, pack, SKU, category) raises its revision so businesses are told. */
export async function adminUpdateMaster(id: string, patch: MasterPatch) {
  const [cur] = await db.select().from(masterProducts).where(eq(masterProducts.id, id)).limit(1);
  if (!cur) throw new NotFoundError('Master product not found');
  if (patch.categoryName) {
    const [c] = await db.select({ id: categories.id }).from(categories).where(and(isNull(categories.syndicateId), sql`lower(${categories.name}) = lower(${patch.categoryName})`)).limit(1);
    if (!c) throw new BusinessRuleError(`Category "${patch.categoryName}" does not exist. Create it first.`);
  }
  const identityChanged = (patch.brand !== undefined && patch.brand !== cur.brand) || (patch.packQuantity !== undefined && patch.packQuantity !== cur.packQuantity)
    || (patch.sku !== undefined && patch.sku !== cur.sku) || (patch.categoryName !== undefined && patch.categoryName !== cur.categoryName);
  const set: Partial<typeof masterProducts.$inferInsert> = { ...patch, updatedAt: new Date() };
  if (identityChanged) (set as Record<string, unknown>).revision = sql`${masterProducts.revision} + 1`;
  try {
    const [row] = await db.update(masterProducts).set(set).where(eq(masterProducts.id, id)).returning();
    return { before: cur, after: row };
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError('Another master product already has that SKU');
    throw err;
  }
}

export async function adminListCategories() {
  const rows = await db.select().from(categories).where(isNull(categories.syndicateId)).orderBy(asc(categories.name));
  const use = await db.select({ name: masterProducts.categoryName, n: sql<number>`count(*)::int` }).from(masterProducts).groupBy(masterProducts.categoryName);
  const byName = new Map(use.map((u) => [u.name.toLowerCase(), u.n]));
  return rows.map((c) => ({ ...c, masterProducts: byName.get(c.name.toLowerCase()) ?? 0 }));
}

export async function adminSaveCategory(input: { id?: string; name: string; taxRate: string }) {
  const name = input.name.trim();
  try {
    if (input.id) {
      const [row] = await db.update(categories).set({ name, taxRate: input.taxRate }).where(and(eq(categories.id, input.id), isNull(categories.syndicateId))).returning();
      if (!row) throw new NotFoundError('Category not found');
      return row;
    }
    const [row] = await db.insert(categories).values({ name, taxRate: input.taxRate }).returning();
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError('A platform category with this name already exists');
    throw err;
  }
}
