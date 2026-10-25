/**
 * invoice.service.ts — supplier invoice drafts: upload (extract → match → validate → store), manual drafts,
 * history and detail. Review / approve / reject / edit live in invoice-workflow.service.ts.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { and, eq, ne } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  categories, invoiceAttachments, products, supplierInvoiceItems, supplierInvoices,
} from '../../db/schema.js';
import type { Tx } from '../../lib/domain-events.js';
import { BusinessRuleError, ConflictError, isUniqueViolation } from '../../lib/errors.js';
import type { JwtPayload } from '../auth/auth.service.js';
import { extractInvoice } from './extraction/index.js';
import { MAX_MONEY } from './extraction/numbers.js';
import { buildDraftLines, DEFAULT_TAX_RATE, type CatalogEntry, type DraftLine } from './draft.engine.js';
import { matchLine } from './match.engine.js';
import { PLACEHOLDER_PREFIX, validateInvoice, validateLine } from './validate.engine.js';
import type { InvoiceInput, LineInput, UploadFields } from './invoice.schemas.js';
import { getInvoiceDetail } from './invoice-query.service.js';

export { getInvoiceDetail, listInvoices, getInvoiceAttachment, getInvoiceBranchId } from './invoice-query.service.js';

/** 409 carrying the id of the live invoice that already uses this supplier + number. */
export class DuplicateInvoiceError extends ConflictError {
  constructor(public readonly existingInvoiceId: string, invoiceNumber: string) {
    super(`Invoice ${invoiceNumber} from this supplier is already recorded for the branch`);
  }
}

export function placeholderNumber(): string {
  return PLACEHOLDER_PREFIX + randomBytes(4).toString('hex').toUpperCase();
}

/** Active catalog with category GST rate, for matching. */
export async function loadCatalog(exec: Tx | typeof db = db): Promise<CatalogEntry[]> {
  const rows = await exec
    .select({
      id: products.id, name: products.name, brand: products.brand, barcode: products.barcode, sku: products.sku,
      volumeMl: products.volumeMl, packQuantity: products.packQuantity, mrp: products.mrp, isActive: products.isActive,
      taxRate: categories.taxRate,
    })
    .from(products)
    .leftJoin(categories, eq(products.categoryId, categories.id))
    .where(eq(products.isActive, true));
  return rows;
}

export async function findLiveDuplicate(exec: Tx | typeof db, branchId: string, supplierName: string, invoiceNumber: string, excludeId?: string) {
  const conds = [
    eq(supplierInvoices.branchId, branchId),
    eq(supplierInvoices.supplierName, supplierName),
    eq(supplierInvoices.invoiceNumber, invoiceNumber),
    ne(supplierInvoices.status, 'REJECTED'),
  ];
  if (excludeId) conds.push(ne(supplierInvoices.id, excludeId));
  const [row] = await exec.select({ id: supplierInvoices.id }).from(supplierInvoices).where(and(...conds)).limit(1);
  return row?.id ?? null;
}

export function assertMoneyRange(lines: Array<{ lineCostTotal: string }>, total: string) {
  const sum = lines.reduce((s, l) => s.plus(l.lineCostTotal), new Decimal(0));
  if (sum.gte(MAX_MONEY) || new Decimal(total).gte(MAX_MONEY)) throw new BusinessRuleError('Invoice amount exceeds the supported maximum');
}

export function itemValues(invoiceId: string, lines: DraftLine[]) {
  return lines.map((l) => ({
    invoiceId,
    productId: l.productId,
    rawDescription: l.rawDescription,
    quantity: l.quantity,
    costPrice: l.costPrice,
    mrp: l.mrp,
    taxRate: l.taxRate,
    lineCostTotal: l.lineCostTotal,
    lineNumber: l.lineNumber,
    barcode: l.barcode,
    matchStatus: l.matchStatus,
    matchMethod: l.matchMethod,
    matchConfidence: l.matchConfidence,
    extractedAmount: l.extractedAmount,
    flags: l.flags,
  }));
}

/** Inserts invoice + items (+ attachment) in `tx`; converts a live-duplicate unique violation into a 409 with the id. */
async function insertDraft(
  header: { branchId: string; userId: string; supplierName: string; invoiceNumber: string; invoiceDate: string | null; totalAmount: string; notes?: string | null; source: string; originalFilename?: string | null; warnings: string[]; meta: Record<string, unknown> },
  lines: DraftLine[],
  attachment?: { filename: string; mimeType: string; data: Buffer; sha256: string },
): Promise<string> {
  assertMoneyRange(lines, header.totalAmount);
  try {
    return await db.transaction(async (tx) => {
      const existing = await findLiveDuplicate(tx, header.branchId, header.supplierName, header.invoiceNumber);
      if (existing) throw new DuplicateInvoiceError(existing, header.invoiceNumber);
      const [invoice] = await tx.insert(supplierInvoices).values({
        branchId: header.branchId,
        createdById: header.userId,
        supplierName: header.supplierName,
        invoiceNumber: header.invoiceNumber,
        invoiceDate: header.invoiceDate ? new Date(header.invoiceDate) : null,
        totalAmount: header.totalAmount,
        status: 'DRAFT',
        notes: header.notes ?? null,
        source: header.source,
        originalFilename: header.originalFilename ?? null,
        extractionWarnings: header.warnings,
        extractionMeta: header.meta,
      }).returning({ id: supplierInvoices.id });
      if (lines.length > 0) await tx.insert(supplierInvoiceItems).values(itemValues(invoice.id, lines));
      if (attachment) {
        await tx.insert(invoiceAttachments).values({
          invoiceId: invoice.id, filename: attachment.filename, mimeType: attachment.mimeType,
          sizeBytes: attachment.data.length, sha256: attachment.sha256, data: attachment.data,
        });
      }
      return invoice.id;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = await findLiveDuplicate(db, header.branchId, header.supplierName, header.invoiceNumber);
      if (existing) throw new DuplicateInvoiceError(existing, header.invoiceNumber);
    }
    throw err;
  }
}

/** Strips any path, control characters and quotes from a client-supplied file name. */
export function sanitizeFilename(name: string | undefined | null): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '').replace(/\s+/g, ' ').trim().slice(0, 150);
  return clean || 'invoice';
}

export interface UploadInput {
  branchId: string;
  user: JwtPayload;
  buffer: Buffer;
  filename: string | undefined;
  fields: UploadFields;
}

export async function createDraftFromUpload(input: UploadInput) {
  const extraction = await extractInvoice(input.buffer, { columnMapping: input.fields.columnMapping });
  const sha256 = createHash('sha256').update(input.buffer).digest('hex');
  const [dupFile] = await db
    .select({ invoiceId: invoiceAttachments.invoiceId })
    .from(invoiceAttachments)
    .innerJoin(supplierInvoices, eq(invoiceAttachments.invoiceId, supplierInvoices.id))
    .where(and(eq(invoiceAttachments.sha256, sha256), eq(supplierInvoices.branchId, input.branchId)))
    .limit(1);

  const lines = buildDraftLines(extraction.table.lines, await loadCatalog());
  const f = input.fields;
  const invoiceNumber = f.invoiceNumber ?? extraction.header.invoiceNumber ?? null;
  const supplierName = (f.supplierName ?? extraction.header.supplierName ?? '').slice(0, 200);
  const invoiceDate = f.invoiceDate ?? extraction.header.invoiceDate ?? null;
  const usedOcr = extraction.kind === 'IMAGE' || (extraction.meta.ocrPages ?? 0) > 0;
  const headerFromOcr = usedOcr && (!f.invoiceNumber || !f.invoiceDate || !f.supplierName);
  const inv = validateInvoice({
    invoiceNumber, invoiceDate, supplierName, capturedTotal: extraction.table.capturedTotal,
    lineTotals: lines.map((l) => l.lineCostTotal), duplicateFile: !!dupFile, headerFromOcr,
  });
  const warnings = [...new Set([...extraction.warnings, ...inv.warnings])];
  const filename = sanitizeFilename(input.filename);
  const meta = {
    ...extraction.meta,
    computedTotal: inv.computedTotal,
    ...(dupFile ? { duplicateOfInvoiceId: dupFile.invoiceId } : {}),
  };

  const id = await insertDraft({
    branchId: input.branchId,
    userId: input.user.sub,
    supplierName,
    invoiceNumber: invoiceNumber ?? placeholderNumber(),
    invoiceDate,
    totalAmount: extraction.table.capturedTotal ?? inv.computedTotal,
    source: extraction.kind,
    originalFilename: filename,
    warnings,
    meta,
  }, lines, { filename, mimeType: extraction.mimeType, data: input.buffer, sha256 });

  const detail = await getInvoiceDetail(id);
  const candidates = new Map(lines.map((l) => [l.lineNumber, l.candidates]));
  return {
    ...detail,
    items: detail.items.map((i) => ({ ...i, candidates: candidates.get(i.lineNumber ?? -1) ?? [] })),
    warnings,
    meta,
  };
}

/** Turns API line input into draft lines (manual product → MANUAL; otherwise auto-matched). */
export function linesFromInput(items: LineInput[], catalog: CatalogEntry[]): DraftLine[] {
  const byId = new Map(catalog.map((p) => [p.id, p]));
  return items.map((item, idx) => {
    const auto = item.productId === undefined ? matchLine({ description: item.rawDescription, barcode: item.barcode }, catalog) : null;
    const productId = item.productId !== undefined ? item.productId : auto!.productId;
    const status = item.productId ? 'MANUAL' : item.productId === null ? 'UNMATCHED' : auto!.status;
    const product = productId ? byId.get(productId) ?? null : null;
    const v = validateLine({
      quantity: item.quantity, costPrice: item.costPrice, mrp: item.mrp, extractedAmount: item.extractedAmount ?? null,
      catalogMrp: product?.mrp ?? null, productId, matchStatus: status, flags: auto?.flags ?? [],
    });
    return {
      lineNumber: idx + 1,
      rawDescription: item.rawDescription,
      barcode: item.barcode ?? null,
      productId,
      productName: product?.name ?? null,
      matchStatus: status,
      matchMethod: item.productId ? 'MANUAL' : auto?.method ?? null,
      matchConfidence: item.productId ? '1.000' : auto && auto.confidence > 0 ? auto.confidence.toFixed(3) : null,
      quantity: item.quantity,
      costPrice: new Decimal(item.costPrice).toFixed(2),
      mrp: new Decimal(item.mrp).toFixed(2),
      taxRate: new Decimal(item.taxRate ?? product?.taxRate ?? DEFAULT_TAX_RATE).toFixed(2),
      extractedAmount: item.extractedAmount ? new Decimal(item.extractedAmount).toFixed(2) : null,
      lineCostTotal: v.lineCostTotal,
      flags: v.flags,
      candidates: auto?.candidates ?? [],
    };
  });
}

export async function createManualDraft(branchId: string, user: JwtPayload, input: InvoiceInput) {
  const lines = linesFromInput(input.items, await loadCatalog());
  const inv = validateInvoice({
    invoiceNumber: input.invoiceNumber ?? null, invoiceDate: input.invoiceDate ?? null, supplierName: input.supplierName,
    capturedTotal: input.totalAmount ?? null, lineTotals: lines.map((l) => l.lineCostTotal),
  });
  const id = await insertDraft({
    branchId, userId: user.sub, supplierName: input.supplierName,
    invoiceNumber: input.invoiceNumber ?? placeholderNumber(), invoiceDate: input.invoiceDate ?? null,
    totalAmount: input.totalAmount ? new Decimal(input.totalAmount).toFixed(2) : inv.computedTotal,
    notes: input.notes, source: 'MANUAL', warnings: inv.warnings, meta: { engine: 'manual', computedTotal: inv.computedTotal },
  }, lines);
  return { ...(await getInvoiceDetail(id)), warnings: inv.warnings };
}
