/**
 * invoice-workflow.service.ts — edit (DRAFT/REVIEWED → DRAFT), review (DRAFT → REVIEWED),
 * approve (DRAFT|REVIEWED → APPROVED, applies stock/prices/accounting) and reject (→ REJECTED).
 * Every transition is a conditional status update, so concurrent requests cannot both succeed.
 * APPROVED and REJECTED invoices are immutable.
 */
import { Decimal } from 'decimal.js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { products, schemePurchases, schemes, stock, stockAudit, supplierInvoiceItems, supplierInvoices } from '../../db/schema.js';
import { emitDomainEvent, type Tx } from '../../lib/domain-events.js';
import { BusinessRuleError, ConflictError, NotFoundError, isUniqueViolation } from '../../lib/errors.js';
import type { JwtPayload } from '../auth/auth.service.js';
import { applyApprovedInvoice, loadInvoiceProducts } from '../inventory/inventory.service.js';
import type { DraftLine } from './draft.engine.js';
import { DEFAULT_TAX_RATE } from './draft.engine.js';
import { matchLine, extractVolumeMl } from './match.engine.js';
import { BLOCKING_TOTALS_WARNINGS, reconcileTotalsBlock } from './totals.engine.js';
import {
  BLOCKING_LINE_FLAGS, EXTRACTION_FLAGS, PROVENANCE_FLAGS, isPlaceholderNumber, validateInvoice, validateLine,
} from './validate.engine.js';
import type { InvoiceInput } from './invoice.schemas.js';
import {
  DuplicateInvoiceError, assertMoneyRange, findLiveDuplicate, getInvoiceDetail, itemValues, loadCatalog,
} from './invoice.service.js';

const EDITABLE = ['DRAFT', 'REVIEWED'] as const;
type ItemRow = typeof supplierInvoiceItems.$inferSelect;

/** 404 when missing, 409 when the invoice is in a state that does not allow `action` (returned, to be thrown). */
async function statusError(exec: Tx | typeof db, id: string, action: string): Promise<Error> {
  const [row] = await exec.select({ status: supplierInvoices.status }).from(supplierInvoices).where(eq(supplierInvoices.id, id)).limit(1);
  if (!row) return new NotFoundError('Invoice not found');
  return new ConflictError(`Invoice is ${row.status} and cannot be ${action}`);
}

function sameNumbers(prev: ItemRow, next: { quantity: number; costPrice: string; mrp: string }): boolean {
  return prev.quantity === next.quantity && new Decimal(prev.costPrice).equals(next.costPrice) && new Decimal(prev.mrp).equals(next.mrp);
}

export async function updateDraft(id: string, user: JwtPayload, input: InvoiceInput) {
  try {
    await db.transaction(async (tx) => {
      const [current] = await tx.select().from(supplierInvoices).where(eq(supplierInvoices.id, id)).for('update');
      if (!current) throw new NotFoundError('Invoice not found');
      if (!(EDITABLE as readonly string[]).includes(current.status)) throw await statusError(tx, id, 'edited');

      const prevItems = await tx.select().from(supplierInvoiceItems).where(eq(supplierInvoiceItems.invoiceId, id));
      const prevById = new Map(prevItems.map((i) => [i.id, i]));
      const catalog = await loadCatalog(tx, current.branchId);
      const refIds = [...new Set(input.items.map((i) => i.productId).filter((p): p is string => !!p))];
      const refRows = refIds.length ? await tx.select({
        id: products.id, name: products.name, mrp: products.mrp, sku: products.sku, costPrice: products.costPrice, volumeMl: products.volumeMl,
        packQuantity: products.packQuantity,
      }).from(products).where(inArray(products.id, refIds)) : [];
      const refMap = new Map(refRows.map((p) => [p.id, p]));
      const missing = refIds.filter((p) => !refMap.has(p));
      if (missing.length) throw new BusinessRuleError(`Unknown products: ${missing.join(', ')}`);
      const taxByProduct = new Map(catalog.map((p) => [p.id, p.taxRate]));

      const lines: DraftLine[] = input.items.map((item, idx) => {
        const prev = item.id ? prevById.get(item.id) : undefined;
        if (item.id && !prev) throw new BusinessRuleError(`Line ${item.id} does not belong to this invoice`);
        let productId: string | null;
        let status: DraftLine['matchStatus'];
        let method: DraftLine['matchMethod'];
        let confidence: string | null;
        let carried: string[] = prev ? (prev.flags ?? []).filter((f) => (PROVENANCE_FLAGS as readonly string[]).includes(f)) : [];
        if (item.productId === undefined && !prev) {
          // Same rules as the upload path: brand code (stored in arcode) + ml, never the name alone
          const auto = matchLine({ description: item.rawDescription, barcode: item.barcode, sku: item.barcode, volumeMl: item.volumeMl }, catalog);
          productId = auto.productId; status = auto.status; method = auto.method;
          confidence = auto.confidence > 0 ? auto.confidence.toFixed(3) : null;
          carried.push(...auto.flags);
        } else if (item.productId === null) {
          productId = null; status = 'UNMATCHED'; method = null; confidence = null;
        } else {
          productId = item.productId ?? prev!.productId;
          const unchanged = prev && prev.productId === productId;
          if (unchanged && !item.confirmMatch) {
            status = (prev!.matchStatus ?? 'UNMATCHED') as DraftLine['matchStatus'];
            method = (prev!.matchMethod ?? null) as DraftLine['matchMethod'];
            confidence = prev!.matchConfidence;
          } else {
            status = productId ? 'MANUAL' : 'UNMATCHED'; method = productId ? 'MANUAL' : null; confidence = productId ? '1.000' : null;
          }
        }
        const cpDec = new Decimal(item.costPrice);
        const costPrice = cpDec.decimalPlaces() <= 2 ? cpDec.toFixed(2) : cpDec.toFixed(6);
        const next = {
          casesDelivered: (item.casesDelivered !== undefined && item.casesDelivered !== null) ? item.casesDelivered : (prev?.casesDelivered ?? 0),
          bottlesDelivered: (item.bottlesDelivered !== undefined && item.bottlesDelivered !== null) ? item.bottlesDelivered : (prev?.bottlesDelivered ?? 0),
          packQuantity: (item.packQuantity !== undefined && item.packQuantity !== null) ? item.packQuantity : (prev?.packQuantity ?? 12),
          quantity: item.quantity,
          caseRate: item.caseRate !== undefined ? item.caseRate : (prev?.caseRate ?? null),
          costPrice,
          mrp: new Decimal(item.mrp).toFixed(2),
        };
        if (prev && sameNumbers(prev, next)) {
          const keep = (prev.flags ?? []).filter((f) => (EXTRACTION_FLAGS as readonly string[]).includes(f)
            && (f !== 'VOLUME_DIFFERS' || prev.productId === productId));
          carried = [...carried, ...keep];
        }
        const product = productId ? refMap.get(productId) ?? catalog.find((c) => c.id === productId) ?? null : null;
        const lineVol = (item.volumeMl !== undefined && item.volumeMl !== null) ? item.volumeMl : (prev?.volumeMl ?? product?.volumeMl ?? null);
        const v = validateLine({
          ...next, extractedAmount: item.extractedAmount ?? prev?.extractedAmount ?? null,
          catalogMrp: product?.mrp ?? null, productId, matchStatus: status, flags: carried,
          volumeMl: lineVol, catalogVolumeMl: product ? (product.volumeMl ?? extractVolumeMl(product.name)) : null,
          packQuantity: next.packQuantity, catalogPackQuantity: product?.packQuantity ?? null,
        });
        const derived = new Decimal(costPrice).mul(item.quantity).toFixed(4);
        const roundingAdj = new Decimal(v.lineCostTotal).minus(new Decimal(derived)).toFixed(4);
        return {
          lineNumber: idx + 1, rawDescription: item.rawDescription, barcode: item.barcode ?? prev?.barcode ?? null,
          sku: product?.sku ?? null,
          productId, productName: product?.name ?? null, matchStatus: status, matchMethod: method, matchConfidence: confidence,
          ...next,
          volumeMl: lineVol,
          displayCostPrice: new Decimal(costPrice).toFixed(2),
          taxRate: new Decimal(item.taxRate ?? prev?.taxRate ?? (productId ? taxByProduct.get(productId) : null) ?? DEFAULT_TAX_RATE).toFixed(2),
          extractedAmount: item.extractedAmount !== undefined ? item.extractedAmount : (prev?.extractedAmount ?? null),
          lineCostTotal: v.lineCostTotal,
          unitDerivedTotal: derived,
          roundingAdjustment: roundingAdj,
          previousCostPrice: prev?.previousCostPrice ?? product?.costPrice ?? null,
          costDifference: prev?.costDifference ?? null,
          costIncreasePct: prev?.costIncreasePct ?? null,
          hasIncreased: false,
          hasDecreased: false,
          isHighIncrease: false,
          flags: v.flags, candidates: [],
        };
      });

      const invoiceNumber = input.invoiceNumber ?? current.invoiceNumber;
      const invoiceDate = input.invoiceDate !== undefined ? input.invoiceDate : current.invoiceDate?.toISOString().slice(0, 10) ?? null;
      const computed = lines.reduce((s, l) => s.plus(l.lineCostTotal), new Decimal(0)).toFixed(2);
      const totalAmount = input.totalAmount ? new Decimal(input.totalAmount).toFixed(2)
        : current.source === 'MANUAL' ? computed : current.totalAmount;
      assertMoneyRange(lines, totalAmount);

      const dup = await findLiveDuplicate(tx, current.branchId, invoiceNumber, id);
      if (dup) throw new DuplicateInvoiceError(dup.id, invoiceNumber, dup.invoiceDate ?? dup.createdAt);

      const prevWarnings = current.extractionWarnings ?? [];
      const sticky = prevWarnings.filter((w) => ['OCR_USED', 'PDF_PAGES_TRUNCATED', 'DUPLICATE_FILE'].includes(w)
        || (w === 'HEADER_FROM_OCR' && !(input.invoiceNumber && input.invoiceDate)));
      // A depot challan is verified by the chain of its own printed figures (totals.engine.ts), not by comparing the
      // sum of the lines with the net value (which includes MRP rounding off).
      const prevMeta = (current.extractionMeta ?? {}) as Record<string, unknown>;
      const isIcdc = prevMeta.engine === 'icdc-extractor';
      const pick = <T>(inp: T | undefined, cur: T): T => (inp !== undefined ? inp : cur);
      const invoiceValue = pick(input.linesBasicTotal, (prevMeta.linesBasicTotal as string | undefined) ?? null);
      const mrpRoundingOff = pick(input.mrpRoundingOff, (prevMeta.mrpRoundingOff as string | undefined) ?? null);
      const netInvoiceValue = pick(input.netInvoiceValue, current.netInvoiceValue);
      const turnoverTax = pick(input.turnoverTax, current.turnoverTax);
      const specialExciseCess = pick(input.specialExciseCess, current.specialExciseCess);
      const tcsAmount = pick(input.tcsAmount, current.tcsAmount);
      const previousCredit = pick(input.previousCredit, current.previousCredit);
      const challanAmount = pick(input.challanAmount, current.challanAmount);
      const subTotal = pick(input.subTotal, current.subTotal);
      const retailerCreditBalance = pick(input.retailerCreditBalance, current.retailerCreditBalance);
      const totals = isIcdc ? reconcileTotalsBlock({
        linesSum: computed, invoiceValue, mrpRoundingOff, netInvoiceValue, turnoverTax, specialExciseCess, tcsAmount,
        previousCredit, challanAmount, subTotal, retailerCreditBalance,
      }) : null;
      const inv = validateInvoice({
        invoiceNumber, invoiceDate, supplierName: input.supplierName, capturedTotal: isIcdc ? null : totalAmount, lineTotals: lines.map((l) => l.lineCostTotal),
      });

      const updated = await tx.update(supplierInvoices).set({
        supplierName: input.supplierName,
        invoiceNumber,
        invoiceDate: invoiceDate ? new Date(invoiceDate) : null,
        totalAmount,
        linesBasicTotal: invoiceValue ?? current.linesBasicTotal,
        mrpRoundingOff: mrpRoundingOff ?? current.mrpRoundingOff,
        specialExciseCess,
        turnoverTax,
        tcsAmount,
        challanAmount,
        challanNumber: input.challanNumber !== undefined ? input.challanNumber : current.challanNumber,
        previousCredit,
        subTotal,
        netInvoiceValue,
        totalInvoiceAmount: input.totalInvoiceAmount !== undefined ? input.totalInvoiceAmount : current.totalInvoiceAmount,
        retailerCreditBalance,
        notes: input.notes !== undefined ? input.notes : current.notes,
        status: 'DRAFT',
        reviewedById: null,
        reviewedAt: null,
        extractionWarnings: [...new Set([...sticky, ...inv.warnings, ...(totals?.warnings ?? [])])],
        extractionMeta: {
          ...prevMeta, computedTotal: computed, editedById: user.sub, editedAt: new Date().toISOString(),
          ...(isIcdc ? { linesBasicTotal: invoiceValue, mrpRoundingOff, totalsChecks: totals!.checks } : {}),
        },
      }).where(and(eq(supplierInvoices.id, id), inArray(supplierInvoices.status, [...EDITABLE]))).returning({ id: supplierInvoices.id });
      if (updated.length === 0) throw await statusError(tx, id, 'edited');

      await tx.delete(supplierInvoiceItems).where(eq(supplierInvoiceItems.invoiceId, id));
      await tx.insert(supplierInvoiceItems).values(itemValues(id, lines));
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError('Another live invoice from this supplier already uses that invoice number');
    throw err;
  }
  return getInvoiceDetail(id);
}

/** Lines that block review/approval, as human-readable reasons. */
function lineProblems(items: ItemRow[], requireConfirmedMatch: boolean): string[] {
  const problems: string[] = [];
  for (const [idx, i] of items.entries()) {
    const n = i.lineNumber ?? idx + 1;
    if (!i.productId) problems.push(`line ${n}: no product selected`);
    else if (requireConfirmedMatch && !['MATCHED', 'MANUAL'].includes(i.matchStatus ?? 'MANUAL')) problems.push(`line ${n}: suggested product must be confirmed`);
    if (i.quantity <= 0) problems.push(`line ${n}: quantity must be positive`);
    if (!new Decimal(i.costPrice).gt(0)) problems.push(`line ${n}: cost must be positive`);
    if (!new Decimal(i.mrp).gt(0)) problems.push(`line ${n}: MRP must be positive`);
    if ((i.flags ?? []).some((f) => (BLOCKING_LINE_FLAGS as readonly string[]).includes(f))) {
      problems.push(`line ${n}: the selected product is a different bottle size (ml) than the invoice line`);
    }
  }
  return problems;
}

/** A depot challan whose printed figures do not add up must not post to stock or the books. */
function assertTotalsReconcile(warnings: string[] | null): void {
  const failed = (warnings ?? []).filter((w) => (BLOCKING_TOTALS_WARNINGS as readonly string[]).includes(w));
  if (failed.length) {
    throw new BusinessRuleError(`Invoice totals do not reconcile (${failed.join(', ')}). Correct the lines or the figures to match the printed challan.`);
  }
}

export async function reviewInvoice(id: string, user: JwtPayload) {
  await db.transaction(async (tx) => {
    const [row] = await tx.update(supplierInvoices)
      .set({ status: 'REVIEWED', reviewedById: user.sub, reviewedAt: new Date() })
      .where(and(eq(supplierInvoices.id, id), eq(supplierInvoices.status, 'DRAFT')))
      .returning({ id: supplierInvoices.id, extractionWarnings: supplierInvoices.extractionWarnings });
    if (!row) throw await statusError(tx, id, 'reviewed');
    assertTotalsReconcile(row.extractionWarnings);
    const items = await tx.select().from(supplierInvoiceItems).where(eq(supplierInvoiceItems.invoiceId, id));
    if (items.length === 0) throw new BusinessRuleError('Invoice has no lines');
    const problems = lineProblems(items, false);
    if (problems.length) throw new BusinessRuleError(`Cannot mark as reviewed: ${problems.join('; ')}`);
  });
  return getInvoiceDetail(id);
}

export async function approveInvoice(id: string, user: JwtPayload) {
  await db.transaction(async (tx) => {
    // Conditional transition: of two concurrent approvals exactly one gets the row back
    const [invoice] = await tx.update(supplierInvoices)
      .set({ status: 'APPROVED', approvedById: user.sub, approvedAt: new Date() })
      .where(and(eq(supplierInvoices.id, id), inArray(supplierInvoices.status, [...EDITABLE])))
      .returning();
    if (!invoice) throw await statusError(tx, id, 'approved');
    if (isPlaceholderNumber(invoice.invoiceNumber)) throw new BusinessRuleError('Enter the real supplier invoice number before approving');
    if (!invoice.supplierName.trim()) throw new BusinessRuleError('Enter the supplier name before approving');
    assertTotalsReconcile(invoice.extractionWarnings);
    const items = await tx.select().from(supplierInvoiceItems).where(eq(supplierInvoiceItems.invoiceId, id));
    if (items.length === 0) throw new BusinessRuleError('Invoice has no lines');
    const problems = lineProblems(items, true);
    if (problems.length) throw new BusinessRuleError(`Cannot approve: ${problems.join('; ')}`);
    const productMap = await loadInvoiceProducts(tx, items.map((i) => i.productId!));
    // Authoritative re-check against the live catalog: stock must go to the same bottle size the invoice delivered
    const wrongSize = items
      .filter((i) => !!i.volumeMl && !!productMap.get(i.productId!)?.volumeMl && i.volumeMl !== productMap.get(i.productId!)!.volumeMl)
      .map((i) => `line ${i.lineNumber ?? '?'}: invoice ${i.volumeMl}ml but product is ${productMap.get(i.productId!)!.volumeMl}ml`);
    if (wrongSize.length) throw new BusinessRuleError(`Cannot approve: ${wrongSize.join('; ')}`);
    await applyApprovedInvoice(tx, { invoice, items, userId: user.sub, productMap });
  });
  return getInvoiceDetail(id);
}

export async function rejectInvoice(id: string, user: JwtPayload, reason: string) {
  const [row] = await db.update(supplierInvoices)
    .set({ status: 'REJECTED', rejectedById: user.sub, rejectedAt: new Date(), rejectionReason: reason })
    .where(and(eq(supplierInvoices.id, id), inArray(supplierInvoices.status, [...EDITABLE])))
    .returning({ id: supplierInvoices.id });
  if (!row) throw await statusError(db, id, 'rejected');
  return getInvoiceDetail(id);
}

/**
 * Reverses an APPROVED invoice — the only way to undo one (approved invoices cannot be deleted):
 *  - the bottles it received are taken back out of the default counter (refused when some were already sold);
 *  - exact reversing vouchers are posted for the purchase and the e-challan payment (the originals stay);
 *  - the supplier-scheme progress it added is taken back;
 *  - the invoice is marked REVERSED and its number can be uploaded again.
 * Product cost / MRP changes made at approval are left as they are (the next invoice sets them again).
 */
export async function reverseInvoice(id: string, user: JwtPayload, reason: string) {
  await db.transaction(async (tx) => {
    const [invoice] = await tx.update(supplierInvoices)
      .set({ status: 'REVERSED', reversedById: user.sub, reversedAt: new Date(), reversalReason: reason })
      .where(and(eq(supplierInvoices.id, id), eq(supplierInvoices.status, 'APPROVED')))
      .returning();
    if (!invoice) throw await statusError(tx, id, 'reversed');

    const items = await tx.select().from(supplierInvoiceItems).where(eq(supplierInvoiceItems.invoiceId, id));
    const received = new Map<string, number>();
    for (const i of items) if (i.productId) received.set(i.productId, (received.get(i.productId) ?? 0) + i.quantity);
    const names = new Map((await tx.select({ id: products.id, name: products.name }).from(products)
      .where(inArray(products.id, [...received.keys()]))).map((p) => [p.id, p.name]));

    for (const [productId, qty] of [...received].sort(([a], [b]) => a.localeCompare(b))) {
      const taken = await tx.update(stock)
        .set({ quantity: sql`${stock.quantity} - ${qty}` })
        .where(and(
          eq(stock.branchId, invoice.branchId),
          eq(stock.productId, productId),
          // only the default counter's bottles can go back to the supplier
          sql`${stock.quantity} - ${qty} >= coalesce((SELECT sum(sbt.quantity) FROM stock_by_type sbt WHERE sbt.branch_id = ${stock.branchId} AND sbt.product_id = ${stock.productId}), 0)`,
        ))
        .returning({ productId: stock.productId });
      if (taken.length === 0) {
        throw new BusinessRuleError(`Cannot reverse: ${qty} × ${names.get(productId) ?? productId} were received, but not that many are left — the rest has already been sold or moved`);
      }
    }
    if (received.size > 0) {
      await tx.insert(stockAudit).values([...received].map(([productId, qty]) => ({
        branchId: invoice.branchId, productId, userId: user.sub, changeQty: -qty, reason: 'VOID_REVERSAL' as const, referenceId: invoice.id,
      })));
    }

    // Supplier-scheme progress credited at approval
    const credited = await tx.select().from(schemePurchases).where(eq(schemePurchases.referenceId, id));
    for (const p of credited) {
      const [scheme] = await tx.select().from(schemes).where(eq(schemes.id, p.schemeId)).limit(1);
      if (!scheme) continue;
      const inc = scheme.targetType === 'QTY' ? p.qty : p.value;
      await tx.update(schemes)
        .set({ currentValue: sql`greatest(0, ${schemes.currentValue} - ${inc})` })
        .where(eq(schemes.id, scheme.id));
    }
    if (credited.length > 0) await tx.delete(schemePurchases).where(eq(schemePurchases.referenceId, id));

    await emitDomainEvent('supplierInvoice.reversed', { invoice, items, reversedById: user.sub }, tx);
  });
  return getInvoiceDetail(id);
}