import { Decimal } from 'decimal.js';
import { db } from '../../db/client.js';
import {
  products,
  stock,
  stockAudit,
  stockByType,
  supplierInvoices,
  supplierInvoiceItems,
  priceAudit,
  billItems,
  bills,
  schemes,
  schemePurchases,
  breakageLogs,
  brandCodeMappings,
  branchProductCosts,
  branches,
  categories,
  masterProducts,
} from '../../db/schema.js';
import { branchCostMap, branchTenantId, categoryScope, mapMasterProducts, requireTenantId } from '../catalog/catalog.service.js';
import type { Tenant } from '../menu/menu-access.js';
import { deleteAllInvoices } from '../invoices/invoice.service.js';
import { eq, and, or, isNull, gte, inArray, sql, ilike } from 'drizzle-orm';
import { estimateIndent, type IndentEstimationResult } from '../stock/indent.engine.js';
import { emitDomainEvent, type Tx } from '../../lib/domain-events.js';
import { BusinessRuleError, NotFoundError } from '../../lib/errors.js';
import { cleanProductName } from '../../lib/product-name.js';

// ─── SHARED APPROVAL EFFECTS (direct approval + invoice upload workflow) ────────

type InvoiceRow = typeof supplierInvoices.$inferSelect;
type InvoiceItemRow = typeof supplierInvoiceItems.$inferSelect;
export type InvoiceProductMap = Map<string, {
  id: string;
  packQuantity: number | null;
  volumeMl?: number | null;
  costPrice?: string | null;
  previousCostPrice?: string | null;
}>;

/** Loads the referenced products (single query); throws 422 listing any unknown product ids. */
export async function loadInvoiceProducts(tx: Tx, productIds: string[], invoiceId?: string): Promise<InvoiceProductMap> {
  const ids = [...new Set(productIds)];
  const productRows = ids.length === 0 ? [] : await tx
    .select({
      id: products.id,
      syndicateId: products.syndicateId,
      packQuantity: products.packQuantity,
      volumeMl: products.volumeMl,
      costPrice: products.costPrice,
      previousCostPrice: products.previousCostPrice,
    })
    .from(products)
    .where(inArray(products.id, ids));
  // An invoice can only touch the catalog of its own business (stock and cost would otherwise land on another tenant's item)
  if (invoiceId && productRows.length > 0) {
    const [owner] = await tx.select({ syndicateId: branches.syndicateId }).from(supplierInvoices)
      .innerJoin(branches, eq(branches.id, supplierInvoices.branchId)).where(eq(supplierInvoices.id, invoiceId)).limit(1);
    const foreign = productRows.filter((p) => p.syndicateId !== (owner?.syndicateId ?? null));
    if (foreign.length > 0) throw new BusinessRuleError(`Unknown products: ${foreign.map((p) => p.id).join(', ')}`);
  }
  const productMap: InvoiceProductMap = new Map(productRows.map((p) => [p.id, p]));
  const missing = ids.filter((id) => !productMap.has(id));
  if (missing.length > 0) throw new BusinessRuleError(`Unknown products: ${missing.join(', ')}`);
  return productMap;
}

/**
 * Applies an APPROVED invoice inside the caller's transaction: atomic stock increment + PURCHASE stock_audit per
 * line, product cost price update, MRP change recorded in price_audit, active supplier scheme progress, then
 * 'supplierInvoice.approved' (accounting posts the purchase voucher).
 */
export async function applyApprovedInvoice(
  tx: Tx,
  { invoice, items, userId, productMap }: { invoice: InvoiceRow; items: InvoiceItemRow[]; userId: string; productMap: InvoiceProductMap },
): Promise<void> {
  let totalCases = new Decimal(0);
  let totalValue = new Decimal(0);

  if (items.length === 0) return;

  const stockInsertsMap = new Map<string, { branchId: string; productId: string; quantity: number; reorderLevel: number }>();
  const stockAuditInserts = [];
  const productUpdatesMap = new Map<string, {
    costPrice: string;
    previousCostPrice?: string | null;
    costPerCase?: string | null;
    lastInvoiceId?: string;
    lastInvoiceNumber?: string;
    lastInvoiceDate?: string;
    costUpdatedAt?: string;
  }>();

  const branchCosts = await branchCostMap(tx, invoice.branchId, items.map((i) => i.productId).filter(Boolean) as string[]);
  const costRows = new Map<string, typeof branchProductCosts.$inferInsert>();

  for (const item of items) {
    const productId = item.productId;
    if (!productId) throw new BusinessRuleError('Every invoice line must be matched to a product before approval');

    const existingStock = stockInsertsMap.get(productId);
    if (existingStock) {
      existingStock.quantity += item.quantity;
    } else {
      stockInsertsMap.set(productId, { branchId: invoice.branchId, productId, quantity: item.quantity, reorderLevel: 5 });
    }

    stockAuditInserts.push({
      branchId: invoice.branchId,
      productId,
      userId,
      changeQty: item.quantity,
      reason: 'PURCHASE' as const,
      referenceId: invoice.id,
    });

    const product = productMap.get(productId)!;
    // The pack size the supplier actually delivered (printed on the invoice line) wins over the catalog's
    const packSize = item.packQuantity && item.packQuantity > 0 ? item.packQuantity
      : product.packQuantity && product.packQuantity > 0 ? product.packQuantity : 12;
    totalCases = totalCases.plus(new Decimal(item.quantity).div(packSize));
    totalValue = totalValue.plus(item.lineCostTotal);

    // Store unit-level cost price at high precision (DECIMAL 14, 6)
    const newCostPrice = new Decimal(item.costPrice).toFixed(6);
    // "previous cost" = what THIS branch paid last time (none if it never bought the item: another outlet's price is not its history)
    const branchPrev = costRows.get(productId)?.costPrice ?? branchCosts.get(productId)?.costPrice ?? null;
    const prevCostPrice = branchPrev ? new Decimal(branchPrev).toFixed(6) : null;
    const caseRateVal = item.caseRate ? new Decimal(item.caseRate).toFixed(2) : null;

    costRows.set(productId, {
      branchId: invoice.branchId, productId, costPrice: newCostPrice, previousCostPrice: prevCostPrice, costPerCase: caseRateVal,
      lastInvoiceId: invoice.id, lastInvoiceNumber: invoice.invoiceNumber,
      lastInvoiceDate: invoice.invoiceDate instanceof Date ? invoice.invoiceDate : (invoice.invoiceDate ? new Date(String(invoice.invoiceDate)) : new Date()),
      costUpdatedAt: new Date(),
    });
    productUpdatesMap.set(productId, {
      costPrice: newCostPrice,
      previousCostPrice: prevCostPrice ?? null,
      costPerCase: caseRateVal ?? null,
      lastInvoiceId: invoice.id,
      lastInvoiceNumber: invoice.invoiceNumber,
      lastInvoiceDate: invoice.invoiceDate instanceof Date ? invoice.invoiceDate.toISOString() : (invoice.invoiceDate ? String(invoice.invoiceDate) : new Date().toISOString()),
      costUpdatedAt: new Date().toISOString(),
    });

    // An invoice carries what the business PAID. It never changes what the business SELLS at (that is typed in Pricing).
    productMap.set(productId, { ...product, costPrice: newCostPrice, previousCostPrice: prevCostPrice ?? undefined });
  }

  // Batch insert stock and aggregate quantities on conflict
  await tx.insert(stock)
    .values(Array.from(stockInsertsMap.values()))
    .onConflictDoUpdate({
      target: [stock.branchId, stock.productId],
      set: { quantity: sql`${stock.quantity} + EXCLUDED.quantity` },
    });

  // Batch insert stock audits
  await tx.insert(stockAudit).values(stockAuditInserts);

  // This branch's own cost record (upsert): the figures the Products page and margins show for this outlet
  if (costRows.size > 0) {
    await tx.insert(branchProductCosts).values([...costRows.values()]).onConflictDoUpdate({
      target: [branchProductCosts.branchId, branchProductCosts.productId],
      set: {
        costPrice: sql`excluded.cost_price`, previousCostPrice: sql`excluded.previous_cost_price`, costPerCase: sql`excluded.cost_per_case`,
        lastInvoiceId: sql`excluded.last_invoice_id`, lastInvoiceNumber: sql`excluded.last_invoice_number`,
        lastInvoiceDate: sql`excluded.last_invoice_date`, costUpdatedAt: sql`excluded.cost_updated_at`,
      },
    });
  }

  // Batch update products (the business-wide "latest" figures)
  const updatesArr = Array.from(productUpdatesMap.entries());
  if (updatesArr.length > 0) {
    // ⚡ Bolt Optimization: Batch update products with CASE WHEN
    // Replaces O(N) sequential database updates with a single query.
    // Impact: Eliminates N+1 queries during invoice approval, massively reducing DB lock contention and transaction duration.
    const costPriceCaseSql = sql`CAST(CASE ${sql.join(
      updatesArr.map(([id, data]) => sql`WHEN ${products.id} = ${id} THEN ${data.costPrice}`),
      sql` `
    )} ELSE ${products.costPrice} END AS numeric)`;

    const previousCostPriceCaseSql = sql`CAST(CASE ${sql.join(
      updatesArr.map(([id, data]) => sql`WHEN ${products.id} = ${id} THEN ${data.previousCostPrice}`),
      sql` `
    )} ELSE ${products.previousCostPrice} END AS numeric)`;

    const costPerCaseCaseSql = sql`CAST(CASE ${sql.join(
      updatesArr.map(([id, data]) => sql`WHEN ${products.id} = ${id} THEN ${data.costPerCase}`),
      sql` `
    )} ELSE ${products.costPerCase} END AS numeric)`;

    const lastInvoiceIdCaseSql = sql`CAST(CASE ${sql.join(
      updatesArr.map(([id, data]) => sql`WHEN ${products.id} = ${id} THEN ${data.lastInvoiceId}`),
      sql` `
    )} ELSE ${products.lastInvoiceId} END AS uuid)`;

    const lastInvoiceNumberCaseSql = sql`CAST(CASE ${sql.join(
      updatesArr.map(([id, data]) => sql`WHEN ${products.id} = ${id} THEN ${data.lastInvoiceNumber}`),
      sql` `
    )} ELSE ${products.lastInvoiceNumber} END AS text)`;

    const lastInvoiceDateCaseSql = sql`CAST(CASE ${sql.join(
      updatesArr.map(([id, data]) => sql`WHEN ${products.id} = ${id} THEN ${data.lastInvoiceDate}`),
      sql` `
    )} ELSE ${products.lastInvoiceDate} END AS timestamp)`;

    const costUpdatedAtCaseSql = sql`CAST(CASE ${sql.join(
      updatesArr.map(([id, data]) => sql`WHEN ${products.id} = ${id} THEN ${data.costUpdatedAt}`),
      sql` `
    )} ELSE ${products.costUpdatedAt} END AS timestamp)`;

    // Batch update products with costPrice, previousCostPrice, costPerCase, and invoice references
    await tx.update(products)
      .set({
        costPrice: costPriceCaseSql,
        previousCostPrice: previousCostPriceCaseSql,
        costPerCase: costPerCaseCaseSql,
        lastInvoiceId: lastInvoiceIdCaseSql,
        lastInvoiceNumber: lastInvoiceNumberCaseSql,
        lastInvoiceDate: lastInvoiceDateCaseSql,
        costUpdatedAt: costUpdatedAtCaseSql,
      })
      .where(inArray(products.id, updatesArr.map(([id]) => id)));
  }

  // Auto-credit any active supplier schemes matching this branch and supplier name
  if (invoice.supplierName.trim() && (totalCases.gt(0) || totalValue.gt(0))) {
    const activeSchemes = await tx
      .select()
      .from(schemes)
      .where(and(
        eq(schemes.branchId, invoice.branchId),
        eq(schemes.status, 'ACTIVE'),
        eq(sql`lower(trim(${schemes.supplierName}))`, invoice.supplierName.trim().toLowerCase()),
      ));
    const casesStr = totalCases.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
    const valStr = totalValue.toFixed(2);
    for (const sc of activeSchemes) {
      const inc = sc.targetType === 'QTY' ? new Decimal(casesStr) : new Decimal(valStr);
      if (inc.lte(0)) continue;
      await tx.insert(schemePurchases).values({
        schemeId: sc.id,
        qty: casesStr,
        value: valStr,
        referenceId: invoice.id,
        notes: `Invoice ${invoice.invoiceNumber}`,
      });
      await tx
        .update(schemes)
        .set({ currentValue: sql`${schemes.currentValue} + ${inc.toFixed(2)}` })
        .where(eq(schemes.id, sc.id));
    }
  }

  await emitDomainEvent('supplierInvoice.approved', { invoice, items }, tx);
}

export async function getStockStatus(branchId: string) {
  return db
    .select({
      stockId: stock.id,
      productId: products.id,
      name: products.name,
      brand: products.brand,
      volumeMl: products.volumeMl,
      packQuantity: products.packQuantity,
      mrp: products.mrp,
      costPrice: products.costPrice,
      previousCostPrice: products.previousCostPrice,
      costPerCase: products.costPerCase,
      lastInvoiceNumber: products.lastInvoiceNumber,
      lastInvoiceDate: products.lastInvoiceDate,
      costUpdatedAt: products.costUpdatedAt,
      quantity: stock.quantity,
      openMl: stock.openMl,
      reorderLevel: stock.reorderLevel,
    })
    .from(stock)
    .innerJoin(products, eq(stock.productId, products.id))
    .where(eq(stock.branchId, branchId));
}

export async function getBranchIndentEstimations(
  branchId: string,
  periodDays = 30,
  leadTimeDays = 5,
  bufferDays = 3,
): Promise<IndentEstimationResult[]> {
  const stockList = await getStockStatus(branchId);
  const since = new Date(Date.now() - periodDays * 86_400_000);

  // Units sold per product in the last `periodDays` (single grouped query)
  const salesRows = await db
    .select({
      productId: billItems.productId,
      totalSold: sql<number>`coalesce(sum(${billItems.quantity}), 0)::int`,
    })
    .from(billItems)
    .innerJoin(bills, eq(billItems.billId, bills.id))
    .where(and(
      eq(bills.branchId, branchId),
      eq(bills.status, 'PAID'),
      gte(bills.createdAt, since),
    ))
    .groupBy(billItems.productId);
  const soldMap = new Map(salesRows.map((r) => [r.productId, Number(r.totalSold)]));

  return stockList.map((item) => estimateIndent({
    productId: item.productId,
    productName: `${item.brand} - ${item.name} (${item.volumeMl ?? 750}ml)`,
    currentStock: item.quantity,
    totalSoldInPeriod: soldMap.get(item.productId) ?? 0,
    periodDays,
    leadTimeDays,
    bufferDays,
    ...(item.packQuantity ? { casePackSize: item.packQuantity } : {}),
  }));
}

export async function clearCompleteInventory(branchId: string): Promise<{ deletedStock: number; deletedInvoices: number }> {
  const deletedInvoices = await deleteAllInvoices(branchId);

  const deletedStock = await db.transaction(async (tx) => {
    await tx.delete(stockAudit).where(eq(stockAudit.branchId, branchId));
    await tx.delete(breakageLogs).where(eq(breakageLogs.branchId, branchId));
    await tx.delete(stockByType).where(eq(stockByType.branchId, branchId));   // the other counters' bottles go with the stock
    const deleted = await tx.delete(stock).where(eq(stock.branchId, branchId)).returning({ id: stock.id });

    // Costs are per branch: forget only what THIS branch paid. (An unscoped update of `products` used to wipe the
    // business-wide cost fields of every business.)
    await tx.delete(branchProductCosts).where(eq(branchProductCosts.branchId, branchId));

    return deleted.length;
  });

  return { deletedStock, deletedInvoices };
}

/** Brand-code mappings of the caller's business (a mapping belongs to the business that owns its product). */
export async function getBrandCodeMappings(tenant: Tenant, branchId?: string) {
  const conditions = [
    tenant === 'ALL' ? undefined : tenant === null ? sql`false` : eq(brandCodeMappings.syndicateId, tenant),
    branchId ? or(eq(brandCodeMappings.branchId, branchId), isNull(brandCodeMappings.branchId)) : undefined,
  ].filter((c) => c !== undefined);
  return db
    .select({
      id: brandCodeMappings.id,
      brandCode: brandCodeMappings.brandCode,
      volumeMl: brandCodeMappings.volumeMl,
      productId: brandCodeMappings.productId,
      productName: brandCodeMappings.productName,
      categoryName: brandCodeMappings.categoryName,
      branchId: brandCodeMappings.branchId,
      createdAt: brandCodeMappings.createdAt,
      updatedAt: brandCodeMappings.updatedAt,
      productCatalogName: products.name,
      productMrp: products.mrp,
    })
    .from(brandCodeMappings)
    .innerJoin(products, eq(products.id, brandCodeMappings.productId))
    .where(conditions.length ? and(...conditions) : undefined);
}

export async function upsertBrandCodeMapping(tenant: Tenant, input: {
  brandCode: string;
  volumeMl?: number | null;
  productId?: string;
  productName?: string;
  categoryName?: string;
  branchId?: string;
  packQuantity?: number | null;
  mrp?: string | null;
  costPrice?: string | null;
}) {
  const tenantId = requireTenantId(tenant);
  let stateCode = 'TS';
  if (input.branchId) {
    // A mapping can only be placed on a branch of the same business
    const b = await branchTenantId(db, input.branchId);
    if (b.syndicateId !== tenantId) throw new NotFoundError('Branch not found');
    stateCode = b.stateCode;
  }
  const trimmedCode = input.brandCode.trim();
  const normCode = trimmedCode.replace(/^0+/, '') || '0';
  const paddedCode = trimmedCode.padStart(4, '0');
  const vol = input.volumeMl ?? null;
  let prodId = input.productId;

  if (prodId) {
    const [own] = await db.select({ id: products.id }).from(products).where(and(eq(products.id, prodId), eq(products.syndicateId, tenantId))).limit(1);
    if (!own) throw new NotFoundError('Product not found');
  } else {
    const rawClean = cleanProductName(input.productName?.trim() || trimmedCode);
    let nameToSearch = rawClean;
    if (vol && !nameToSearch.toLowerCase().includes(`${vol}ml`)) {
      nameToSearch = `${nameToSearch} ${vol}ml`;
    }

    // Only the business's own products are candidates (never another business's)
    const [found] = await db
      .select({ id: products.id })
      .from(products)
      .where(and(
        eq(products.syndicateId, tenantId),
        or(
          eq(products.name, nameToSearch),
          and(
            or(
              eq(products.exciseCode, trimmedCode),
              eq(products.exciseCode, normCode),
              eq(products.exciseCode, paddedCode),
            ),
            vol ? eq(products.volumeMl, vol) : undefined,
          ),
        ),
      ))
      .limit(1);

    if (found) {
      prodId = found.id;
    } else {
      // Prefer the state's master product (identity from the master, NO price); only then a custom item
      const master = vol ? (await db.select({ id: masterProducts.id }).from(masterProducts)
        .where(and(eq(masterProducts.state, stateCode), eq(masterProducts.isActive, true), vol ? eq(masterProducts.volumeMl, vol) : undefined,
          inArray(masterProducts.exciseCode, [trimmedCode, normCode, paddedCode]))).limit(1))[0] : undefined;
      if (master) {
        const mapped = await mapMasterProducts(db, tenantId, [master.id]);
        prodId = mapped.productIds[0];
      }
    }
    if (!prodId) {
      let catId: string | null = null;
      if (input.categoryName) {
        const [cat] = await db.select({ id: categories.id }).from(categories)
          .where(and(ilike(categories.name, `%${input.categoryName.trim()}%`), categoryScope(tenantId))).limit(1);
        catId = cat?.id ?? null;
      }
      // No guessing a category: the item's tax depends on it
      if (!catId) throw new BusinessRuleError('This brand code is not in the master catalog, so choose a category to create it as your own product');
      const mrp = input.mrp && new Decimal(input.mrp).gt(0) ? new Decimal(input.mrp).toFixed(2) : '0.00';
      const [newProd] = await db.insert(products).values({
        name: nameToSearch,
        brand: input.brandCode.trim() || 'General',
        barcode: vol ? `${trimmedCode}-${vol}` : trimmedCode,
        sku: vol ? `TS-${trimmedCode}-${vol}` : `TS-${trimmedCode}`,
        exciseCode: trimmedCode,
        volumeMl: vol,
        packQuantity: input.packQuantity ?? (vol === 180 ? 48 : vol === 375 ? 24 : vol === 90 ? 96 : 12),
        categoryId: catId,
        mrp,                                   // typed by the business or left unpriced; never invented
        costPrice: input.costPrice && new Decimal(input.costPrice).gt(0) ? new Decimal(input.costPrice).toFixed(2) : undefined,
        syndicateId: tenantId,
      }).returning();
      prodId = newProd.id;
    }
  }

  const existingConds = [
    eq(brandCodeMappings.syndicateId, tenantId),
    or(
      eq(brandCodeMappings.brandCode, trimmedCode),
      eq(brandCodeMappings.brandCode, normCode),
      eq(brandCodeMappings.brandCode, paddedCode),
    )!,
  ];
  if (vol !== null) {
    existingConds.push(eq(brandCodeMappings.volumeMl, vol));
  } else {
    existingConds.push(isNull(brandCodeMappings.volumeMl));
  }
  if (input.branchId) {
    existingConds.push(or(eq(brandCodeMappings.branchId, input.branchId), isNull(brandCodeMappings.branchId))!);
  }

  const existing = await db
    .select()
    .from(brandCodeMappings)
    .where(and(...existingConds))
    .limit(1);

  const cleanInputName = input.productName ? cleanProductName(input.productName) : undefined;
  if (existing.length > 0) {
    const [updated] = await db
      .update(brandCodeMappings)
      .set({
        productId: prodId,
        volumeMl: vol,
        productName: cleanInputName ?? existing[0].productName,
        categoryName: input.categoryName ?? existing[0].categoryName,
        branchId: input.branchId ?? existing[0].branchId,
        updatedAt: new Date(),
      })
      .where(eq(brandCodeMappings.id, existing[0].id))
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(brandCodeMappings)
    .values({
      brandCode: trimmedCode,
      volumeMl: vol,
      productId: prodId,
      productName: cleanInputName,
      categoryName: input.categoryName,
      branchId: input.branchId,
      syndicateId: tenantId,
    })
    .returning();
  return created;
}

export async function deleteBrandCodeMapping(tenant: Tenant, id: string) {
  // Another business's mapping is reported as missing, like any foreign row
  const [row] = await db.select({ syndicateId: brandCodeMappings.syndicateId }).from(brandCodeMappings).where(eq(brandCodeMappings.id, id)).limit(1);
  if (!row || (tenant !== 'ALL' && row.syndicateId !== tenant)) throw new NotFoundError('Mapping not found');
  await db.delete(brandCodeMappings).where(eq(brandCodeMappings.id, id));
  return { success: true };
}
