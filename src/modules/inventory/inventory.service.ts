import { Decimal } from 'decimal.js';
import { db } from '../../db/client.js';
import {
  products,
  stock,
  stockAudit,
  supplierInvoices,
  supplierInvoiceItems,
  priceAudit,
  billItems,
  bills,
  schemes,
  schemePurchases,
} from '../../db/schema.js';
import { eq, and, gte, inArray, ne, sql } from 'drizzle-orm';
import {
  parseAndValidateInvoice,
  type RawExtractedInvoice,
} from './invoice-parser.engine.js';
import { estimateIndent, type IndentEstimationResult } from '../stock/indent.engine.js';
import { emitDomainEvent, type Tx } from '../../lib/domain-events.js';
import { BusinessRuleError, ConflictError } from '../../lib/errors.js';
import type { JwtPayload } from '../auth/auth.service.js';

export async function parseInvoice(rawInvoice: RawExtractedInvoice) {
  // Load current product catalog references
  const allProducts = await db
    .select({
      id: products.id,
      barcode: products.barcode,
      name: products.name,
      volumeMl: products.volumeMl,
      currentMrp: products.mrp,
    })
    .from(products);

  return parseAndValidateInvoice(rawInvoice, allProducts);
}

export interface ApproveInvoiceInput {
  branchId: string;
  supplierName: string;
  invoiceNumber: string;
  invoiceDate?: string;
  totalAmount: string;
  notes?: string;
  items: Array<{
    productId: string;
    rawDescription: string;
    quantity: number;
    costPrice: string;
    mrp: string;
    taxRate?: string;
  }>;
}

// ─── APPROVE SUPPLIER INVOICE (atomic) ───────────────────────────────────────

export async function approveInwardInvoice(input: ApproveInvoiceInput, user: JwtPayload) {
  if (input.items.length === 0) throw new BusinessRuleError('Invoice must contain at least one item');

  return await db.transaction(async (tx) => {
    // 0. Reject double-approval of the same supplier invoice (would double the stock)
    const [dupe] = await tx
      .select({ id: supplierInvoices.id })
      .from(supplierInvoices)
      .where(and(
        eq(supplierInvoices.branchId, input.branchId),
        eq(supplierInvoices.supplierName, input.supplierName),
        eq(supplierInvoices.invoiceNumber, input.invoiceNumber),
        ne(supplierInvoices.status, 'REJECTED'),
      ))
      .limit(1);
    if (dupe) throw new ConflictError(`Invoice ${input.invoiceNumber} from ${input.supplierName} already recorded`);

    // 1. All referenced products must exist (single query)
    const productMap = await loadInvoiceProducts(tx, input.items.map((i) => i.productId));

    // 2. Create supplier invoice record
    const [invoice] = await tx
      .insert(supplierInvoices)
      .values({
        branchId: input.branchId,
        createdById: user.sub,
        approvedById: user.sub,
        supplierName: input.supplierName,
        invoiceNumber: input.invoiceNumber,
        invoiceDate: input.invoiceDate ? new Date(input.invoiceDate) : new Date(),
        totalAmount: new Decimal(input.totalAmount).toFixed(2),
        status: 'APPROVED',
        notes: input.notes,
        approvedAt: new Date(),
      })
      .returning();

    // 3. Line items (decimal-safe line totals)
    const insertedItems = await tx
      .insert(supplierInvoiceItems)
      .values(input.items.map((item) => ({
        invoiceId: invoice.id,
        productId: item.productId,
        rawDescription: item.rawDescription,
        quantity: item.quantity,
        costPrice: new Decimal(item.costPrice).toFixed(2),
        mrp: new Decimal(item.mrp).toFixed(2),
        taxRate: new Decimal(item.taxRate ?? '18.00').toFixed(2),
        lineCostTotal: new Decimal(item.costPrice).mul(item.quantity).toFixed(2),
      })))
      .returning();

    // 4-6. Stock, audit, prices, domain event
    await applyApprovedInvoice(tx, { invoice, items: insertedItems, userId: user.sub, productMap });

    return invoice;
  });
}

// ─── SHARED APPROVAL EFFECTS (direct approval + invoice upload workflow) ────────

type InvoiceRow = typeof supplierInvoices.$inferSelect;
type InvoiceItemRow = typeof supplierInvoiceItems.$inferSelect;
export type InvoiceProductMap = Map<string, { id: string; mrp: string; packQuantity: number | null }>;

/** Loads the referenced products (single query); throws 422 listing any unknown product ids. */
export async function loadInvoiceProducts(tx: Tx, productIds: string[]): Promise<InvoiceProductMap> {
  const ids = [...new Set(productIds)];
  const productRows = ids.length === 0 ? [] : await tx
    .select({ id: products.id, mrp: products.mrp, packQuantity: products.packQuantity })
    .from(products)
    .where(inArray(products.id, ids));
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
  const productUpdatesMap = new Map<string, { costPrice: string; mrp?: string }>();
  const priceAuditInserts = [];

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
    const packSize = product.packQuantity && product.packQuantity > 0 ? product.packQuantity : 12;
    totalCases = totalCases.plus(new Decimal(item.quantity).div(packSize));
    totalValue = totalValue.plus(item.lineCostTotal);

    const newMrp = new Decimal(item.mrp).toFixed(2);
    const mrpChanged = !new Decimal(product.mrp).equals(newMrp);

    // We update product for every item that dictates it, but for costPrice we just use the last item's cost price,
    // however if we have multiple items for same product, this update could run multiple times concurrently.
    // It's safer to only push one update per product. We do this by aggregating updates into a map.
    productUpdatesMap.set(productId, { costPrice: new Decimal(item.costPrice).toFixed(2), ...(mrpChanged ? { mrp: newMrp } : {}) });

    if (mrpChanged) {
      priceAuditInserts.push({ productId, userId, oldMrp: product.mrp, newMrp });
      productMap.set(productId, { ...product, mrp: newMrp });
    }
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

  // Batch update products
  const productUpdates = Array.from(productUpdatesMap.entries()).map(([id, updateData]) =>
    tx.update(products).set(updateData).where(eq(products.id, id))
  );
  await Promise.all(productUpdates);

  // Batch insert price audits if any
  if (priceAuditInserts.length > 0) {
    await tx.insert(priceAudit).values(priceAuditInserts);
  }

  // Auto-credit any active supplier schemes matching this branch and supplier name
  if (invoice.supplierName.trim() && (totalCases.gt(0) || totalValue.gt(0))) {
    const activeSchemes = await tx
      .select()
      .from(schemes)
      .where(and(
        eq(schemes.branchId, invoice.branchId),
        eq(schemes.status, 'ACTIVE'),
        sql`lower(trim(${schemes.supplierName})) = lower(trim(${invoice.supplierName}))`,
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
      quantity: stock.quantity,
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
