/**
 * invoice-workflow.service.ts — edit (DRAFT/REVIEWED → DRAFT), review (DRAFT → REVIEWED),
 * approve (DRAFT|REVIEWED → APPROVED, applies stock/prices/accounting) and reject (→ REJECTED).
 * Every transition is a conditional status update, so concurrent requests cannot both succeed.
 * APPROVED and REJECTED invoices are immutable.
 */
import { Decimal } from 'decimal.js';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { products, supplierInvoiceItems, supplierInvoices } from '../../db/schema.js';
import type { Tx } from '../../lib/domain-events.js';
import { BusinessRuleError, ConflictError, NotFoundError, isUniqueViolation } from '../../lib/errors.js';
import type { JwtPayload } from '../auth/auth.service.js';
import { applyApprovedInvoice, loadInvoiceProducts } from '../inventory/inventory.service.js';
import type { DraftLine } from './draft.engine.js';
import { DEFAULT_TAX_RATE } from './draft.engine.js';
import { matchLine } from './match.engine.js';
import {
  EXTRACTION_FLAGS, PROVENANCE_FLAGS, isPlaceholderNumber, validateInvoice, validateLine,
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
      const catalog = await loadCatalog(tx);
      const refIds = [...new Set(input.items.map((i) => i.productId).filter((p): p is string => !!p))];
      const refRows = refIds.length ? await tx.select({ id: products.id, name: products.name, mrp: products.mrp }).from(products).where(inArray(products.id, refIds)) : [];
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
          const auto = matchLine({ description: item.rawDescription, barcode: item.barcode }, catalog);
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
        const next = { quantity: item.quantity, costPrice: new Decimal(item.costPrice).toFixed(2), mrp: new Decimal(item.mrp).toFixed(2) };
        if (prev && sameNumbers(prev, next)) {
          const keep = (prev.flags ?? []).filter((f) => (EXTRACTION_FLAGS as readonly string[]).includes(f)
            && (f !== 'VOLUME_DIFFERS' || prev.productId === productId));
          carried = [...carried, ...keep];
        }
        const product = productId ? refMap.get(productId) ?? catalog.find((c) => c.id === productId) ?? null : null;
        const v = validateLine({
          ...next, extractedAmount: item.extractedAmount ?? prev?.extractedAmount ?? null,
          catalogMrp: product?.mrp ?? null, productId, matchStatus: status, flags: carried,
        });
        return {
          lineNumber: idx + 1, rawDescription: item.rawDescription, barcode: item.barcode ?? prev?.barcode ?? null,
          productId, productName: product?.name ?? null, matchStatus: status, matchMethod: method, matchConfidence: confidence,
          ...next,
          taxRate: new Decimal(item.taxRate ?? prev?.taxRate ?? (productId ? taxByProduct.get(productId) : null) ?? DEFAULT_TAX_RATE).toFixed(2),
          extractedAmount: item.extractedAmount !== undefined ? item.extractedAmount : prev?.extractedAmount ?? null,
          lineCostTotal: v.lineCostTotal, flags: v.flags, candidates: [],
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
      const inv = validateInvoice({
        invoiceNumber, invoiceDate, supplierName: input.supplierName, capturedTotal: totalAmount, lineTotals: lines.map((l) => l.lineCostTotal),
      });

      const updated = await tx.update(supplierInvoices).set({
        supplierName: input.supplierName,
        invoiceNumber,
        invoiceDate: invoiceDate ? new Date(invoiceDate) : null,
        totalAmount,
        notes: input.notes !== undefined ? input.notes : current.notes,
        status: 'DRAFT',
        reviewedById: null,
        reviewedAt: null,
        extractionWarnings: [...new Set([...sticky, ...inv.warnings])],
        extractionMeta: { ...(current.extractionMeta ?? {}), computedTotal: computed, editedById: user.sub, editedAt: new Date().toISOString() },
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
  }
  return problems;
}

export async function reviewInvoice(id: string, user: JwtPayload) {
  await db.transaction(async (tx) => {
    const [row] = await tx.update(supplierInvoices)
      .set({ status: 'REVIEWED', reviewedById: user.sub, reviewedAt: new Date() })
      .where(and(eq(supplierInvoices.id, id), eq(supplierInvoices.status, 'DRAFT')))
      .returning({ id: supplierInvoices.id });
    if (!row) throw await statusError(tx, id, 'reviewed');
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
    const items = await tx.select().from(supplierInvoiceItems).where(eq(supplierInvoiceItems.invoiceId, id));
    if (items.length === 0) throw new BusinessRuleError('Invoice has no lines');
    const problems = lineProblems(items, true);
    if (problems.length) throw new BusinessRuleError(`Cannot approve: ${problems.join('; ')}`);
    const productMap = await loadInvoiceProducts(tx, items.map((i) => i.productId!));
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
