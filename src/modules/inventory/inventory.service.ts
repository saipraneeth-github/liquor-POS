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
export type InvoiceProductMap = Map<string, { id: string; mrp: string }>;

/** Loads the referenced products (single query); throws 422 listing any unknown product ids. */
export async function loadInvoiceProducts(tx: Tx, productIds: string[]): Promise<InvoiceProductMap> {
  const ids = [...new Set(productIds)];
  const productRows = ids.length === 0 ? [] : await tx
    .select({ id: products.id, mrp: products.mrp })
    .from(products)
    .where(inArray(products.id, ids));
  const productMap: InvoiceProductMap = new Map(productRows.map((p) => [p.id, p]));
  const missing = ids.filter((id) => !productMap.has(id));
  if (missing.length > 0) throw new BusinessRuleError(`Unknown products: ${missing.join(', ')}`);
  return productMap;
}

/**
 * Applies an APPROVED invoice inside the caller's transaction: atomic stock increment + PURCHASE stock_audit per
 * line, product cost price update, MRP change recorded in price_audit, then 'supplierInvoice.approved'
 * (accounting posts the purchase voucher). Every item must have a productId present in `productMap`.
 */
export async function applyApprovedInvoice(
  tx: Tx,
  { invoice, items, userId, productMap }: { invoice: InvoiceRow; items: InvoiceItemRow[]; userId: string; productMap: InvoiceProductMap },
): Promise<void> {
  for (const item of items) {
    const productId = item.productId;
    if (!productId) throw new BusinessRuleError('Every invoice line must be matched to a product before approval');

    // Atomic stock increment (creates the row if missing)
    await tx
      .insert(stock)
      .values({ branchId: invoice.branchId, productId, quantity: item.quantity, reorderLevel: 5 })
      .onConflictDoUpdate({
        target: [stock.branchId, stock.productId],
        set: { quantity: sql`${stock.quantity} + ${item.quantity}` },
      });

    await tx.insert(stockAudit).values({
      branchId: invoice.branchId,
      productId,
      userId,
      changeQty: item.quantity,
      reason: 'PURCHASE',
      referenceId: invoice.id,
    });

    // Update cost price; MRP changes are audited in price_audit
    const product = productMap.get(productId)!;
    const newMrp = new Decimal(item.mrp).toFixed(2);
    const mrpChanged = !new Decimal(product.mrp).equals(newMrp);
    await tx
      .update(products)
      .set({ costPrice: new Decimal(item.costPrice).toFixed(2), ...(mrpChanged ? { mrp: newMrp } : {}) })
      .where(eq(products.id, productId));
    if (mrpChanged) {
      await tx.insert(priceAudit).values({ productId, userId, oldMrp: product.mrp, newMrp });
      productMap.set(productId, { ...product, mrp: newMrp });
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
