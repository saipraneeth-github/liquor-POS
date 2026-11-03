/**
 * invoice.service.ts — supplier invoice drafts: upload (extract → match → validate → store), manual drafts,
 * history and detail. Review / approve / reject / edit live in invoice-workflow.service.ts.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { and, eq, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  branches, categories, invoiceAttachments, journalLines, journalVouchers, products, schemePurchases, supplierInvoiceItems, supplierInvoices,
} from '../../db/schema.js';
import type { Tx } from '../../lib/domain-events.js';
import { BusinessRuleError, ConflictError, NotFoundError, isUniqueViolation } from '../../lib/errors.js';
import type { JwtPayload } from '../auth/auth.service.js';
import { extractInvoice } from './extraction/index.js';
import { MAX_MONEY } from './extraction/numbers.js';
import { buildDraftLines, DEFAULT_TAX_RATE, type CatalogEntry, type DraftLine } from './draft.engine.js';
import { matchLine } from './match.engine.js';
import {
  PLACEHOLDER_PREFIX, isPlaceholderNumber, validateInvoice, validateLine,
  formatInvoiceDate, formatDuplicateInvoiceMessage, normalizeInvoiceNumber,
} from './validate.engine.js';
import type { InvoiceInput, LineInput, UploadFields } from './invoice.schemas.js';
import { getInvoiceDetail } from './invoice-query.service.js';

export { getInvoiceDetail, listInvoices, getInvoiceAttachment, getInvoiceBranchId } from './invoice-query.service.js';
export { formatInvoiceDate, formatDuplicateInvoiceMessage, normalizeInvoiceNumber } from './validate.engine.js';

export interface LiveDuplicateInfo {
  id: string;
  invoiceNumber: string;
  invoiceDate: Date | null;
  createdAt: Date | null;
  supplierName: string;
  totalAmount: string;
  status: string;
}

/** 409 carrying the id of the live invoice that already uses this number in the branch. */
export class DuplicateInvoiceError extends ConflictError {
  constructor(
    public readonly existingInvoiceId: string,
    public readonly invoiceNumber: string,
    public readonly existingDate?: Date | string | null,
  ) {
    const dateStr = formatInvoiceDate(existingDate);
    super(`Invoice number ${invoiceNumber} has already been uploaded on ${dateStr}.`);
  }
}

export function placeholderNumber(): string {
  return PLACEHOLDER_PREFIX + randomBytes(4).toString('hex').toUpperCase();
}

/** Active catalog with category GST rate, for matching. */
export async function loadCatalog(exec: Tx | typeof db = db, branchId?: string): Promise<CatalogEntry[]> {
  // A branch only matches against its own business's catalog (plus unowned legacy items)
  let scope: SQL | undefined;
  if (branchId) {
    const [branch] = await exec.select({ syndicateId: branches.syndicateId }).from(branches).where(eq(branches.id, branchId)).limit(1);
    scope = branch?.syndicateId ? or(isNull(products.syndicateId), eq(products.syndicateId, branch.syndicateId)) : isNull(products.syndicateId);
  }
  const rows = await exec
    .select({
      id: products.id, name: products.name, brand: products.brand, barcode: products.barcode, sku: products.sku,
      exciseCode: products.exciseCode,
      volumeMl: products.volumeMl, packQuantity: products.packQuantity, mrp: products.mrp, costPrice: products.costPrice, isActive: products.isActive,
      taxRate: categories.taxRate,
    })
    .from(products)
    .leftJoin(categories, eq(products.categoryId, categories.id))
    .where(and(eq(products.isActive, true), scope));
  return rows;
}

export async function findLiveDuplicate(
  exec: Tx | typeof db,
  branchId: string,
  invoiceNumber: string,
  excludeId?: string,
): Promise<LiveDuplicateInfo | null> {
  const trimmed = (invoiceNumber ?? '').trim();
  if (!trimmed || isPlaceholderNumber(trimmed)) return null;
  const conds: SQL[] = [
    eq(supplierInvoices.branchId, branchId),
    eq(sql`lower(trim(${supplierInvoices.invoiceNumber}))`, trimmed.toLowerCase()),
    ne(supplierInvoices.status, 'REJECTED'),
  ];
  if (excludeId) conds.push(ne(supplierInvoices.id, excludeId));
  const [row] = await exec
    .select({
      id: supplierInvoices.id,
      invoiceNumber: supplierInvoices.invoiceNumber,
      invoiceDate: supplierInvoices.invoiceDate,
      createdAt: supplierInvoices.createdAt,
      supplierName: supplierInvoices.supplierName,
      totalAmount: supplierInvoices.totalAmount,
      status: supplierInvoices.status,
    })
    .from(supplierInvoices)
    .where(and(...conds))
    .limit(1);
  return row ?? null;
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
    casesDelivered: l.casesDelivered ?? 0,
    bottlesDelivered: l.bottlesDelivered ?? 0,
    packQuantity: l.packQuantity ?? 12,
    quantity: l.quantity,
    caseRate: l.caseRate ?? null,
    costPrice: l.costPrice,
    mrp: l.mrp,
    taxRate: l.taxRate,
    lineCostTotal: l.lineCostTotal,
    unitDerivedTotal: l.unitDerivedTotal ?? null,
    roundingAdjustment: l.roundingAdjustment ?? '0.0000',
    previousCostPrice: l.previousCostPrice ?? null,
    costDifference: l.costDifference ?? null,
    costIncreasePct: l.costIncreasePct ?? null,
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
      if (header.invoiceNumber && !isPlaceholderNumber(header.invoiceNumber)) {
        const existing = await findLiveDuplicate(tx, header.branchId, header.invoiceNumber);
        if (existing) throw new DuplicateInvoiceError(existing.id, header.invoiceNumber, existing.invoiceDate ?? existing.createdAt);
      }
      const linesBasicTotal = lines.reduce((s, l) => s.plus(new Decimal(l.lineCostTotal || '0')), new Decimal(0)).toFixed(2);
      const roundingAdjustment = lines.reduce((s, l) => s.plus(new Decimal(l.roundingAdjustment || '0')), new Decimal(0)).toFixed(4);
      const totalCases = lines.reduce((s, l) => s + (l.casesDelivered || 0), 0);
      const totalBottles = lines.reduce((s, l) => s + (l.quantity || 0), 0);

      const [invoice] = await tx.insert(supplierInvoices).values({
        branchId: header.branchId,
        createdById: header.userId,
        supplierName: header.supplierName,
        invoiceNumber: header.invoiceNumber,
        invoiceDate: header.invoiceDate ? new Date(header.invoiceDate) : null,
        linesBasicTotal: (header.meta?.linesBasicTotal as string) ?? linesBasicTotal,
        mrpRoundingOff: (header.meta?.mrpRoundingOff as string) ?? '0.00',
        roundingAdjustment,
        totalAmount: header.totalAmount,
        specialExciseCess: (header.meta?.specialCess as string) ?? null,
        turnoverTax: (header.meta?.turnoverTax as string) ?? null,
        tcsAmount: (header.meta?.tcsAmount as string) ?? null,
        totalCases,
        totalBottles,
        challanAmount: (header.meta?.challanAmount as string) ?? null,
        challanNumber: (header.meta?.challanNumber as string) ?? null,
        previousCredit: (header.meta?.previousCredit as string) ?? null,
        subTotal: (header.meta?.subTotal as string) ?? null,
        netInvoiceValue: (header.meta?.netInvoiceValue as string) ?? null,
        totalInvoiceAmount: (header.meta?.totalInvoiceAmount as string) ?? null,
        retailerCreditBalance: (header.meta?.retailerCreditBalance as string) ?? null,
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
      const existing = await findLiveDuplicate(db, header.branchId, header.invoiceNumber);
      if (existing) throw new DuplicateInvoiceError(existing.id, header.invoiceNumber, existing.invoiceDate ?? existing.createdAt);
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

  const lines = buildDraftLines(extraction.table.lines, await loadCatalog(db, input.branchId));
  const f = input.fields;
  const invoiceNumber = f.invoiceNumber?.trim() || extraction.header.invoiceNumber?.trim() || null;
  if (invoiceNumber && !isPlaceholderNumber(invoiceNumber)) {
    const existing = await findLiveDuplicate(db, input.branchId, invoiceNumber);
    if (existing) throw new DuplicateInvoiceError(existing.id, invoiceNumber, existing.invoiceDate ?? existing.createdAt);
  }
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
    const cpDec = new Decimal(item.costPrice);
    const costPriceStr = cpDec.decimalPlaces() <= 2 ? cpDec.toFixed(2) : cpDec.toFixed(6);
    const derived = new Decimal(costPriceStr).mul(item.quantity).toFixed(4);
    const roundingAdj = new Decimal(v.lineCostTotal).minus(new Decimal(derived)).toFixed(4);
    return {
      lineNumber: idx + 1,
      rawDescription: item.rawDescription,
      barcode: item.barcode ?? null,
      sku: product?.sku ?? null,
      productId,
      productName: product?.name ?? null,
      matchStatus: status,
      matchMethod: item.productId ? 'MANUAL' : auto?.method ?? null,
      matchConfidence: item.productId ? '1.000' : auto && auto.confidence > 0 ? auto.confidence.toFixed(3) : null,
      casesDelivered: item.casesDelivered ?? 0,
      bottlesDelivered: item.bottlesDelivered ?? 0,
      packQuantity: item.packQuantity ?? 12,
      quantity: item.quantity,
      caseRate: item.caseRate ?? null,
      costPrice: costPriceStr,
      displayCostPrice: new Decimal(costPriceStr).toFixed(2),
      mrp: new Decimal(item.mrp).toFixed(2),
      taxRate: new Decimal(item.taxRate ?? product?.taxRate ?? DEFAULT_TAX_RATE).toFixed(2),
      extractedAmount: item.extractedAmount ? new Decimal(item.extractedAmount).toFixed(2) : null,
      lineCostTotal: v.lineCostTotal,
      unitDerivedTotal: derived,
      roundingAdjustment: roundingAdj,
      previousCostPrice: product?.costPrice ?? null,
      costDifference: null,
      costIncreasePct: null,
      hasIncreased: false,
      hasDecreased: false,
      isHighIncrease: false,
      flags: v.flags,
      candidates: auto?.candidates ?? [],
    };
  });
}

export async function createManualDraft(branchId: string, user: JwtPayload, input: InvoiceInput) {
  if (input.invoiceNumber && !isPlaceholderNumber(input.invoiceNumber)) {
    const existing = await findLiveDuplicate(db, branchId, input.invoiceNumber);
    if (existing) throw new DuplicateInvoiceError(existing.id, input.invoiceNumber, existing.invoiceDate ?? existing.createdAt);
  }
  const lines = linesFromInput(input.items, await loadCatalog(db, branchId));
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

export async function deleteInvoice(invoiceId: string, _user: JwtPayload): Promise<void> {
  const [inv] = await db.select().from(supplierInvoices).where(eq(supplierInvoices.id, invoiceId)).limit(1);
  if (!inv) throw new NotFoundError('Invoice not found');

  await db.transaction(async (tx) => {
    const vouchers = await tx.select({ id: journalVouchers.id }).from(journalVouchers)
      .where(and(inArray(journalVouchers.sourceType, ['SUPPLIER_INVOICE', 'SUPPLIER_CHALLAN']), eq(journalVouchers.sourceId, invoiceId)));
    for (const v of vouchers) {
      await tx.delete(journalLines).where(eq(journalLines.voucherId, v.id));
      await tx.delete(journalVouchers).where(eq(journalVouchers.id, v.id));
    }

    await tx.delete(schemePurchases).where(eq(schemePurchases.referenceId, invoiceId));
    await tx.delete(supplierInvoices).where(eq(supplierInvoices.id, invoiceId));
  });
}

export async function deleteAllInvoices(branchId: string): Promise<number> {
  const invs = await db.select({ id: supplierInvoices.id }).from(supplierInvoices).where(eq(supplierInvoices.branchId, branchId));
  if (invs.length === 0) return 0;

  for (const inv of invs) {
    await db.transaction(async (tx) => {
      const vouchers = await tx.select({ id: journalVouchers.id }).from(journalVouchers)
        .where(and(inArray(journalVouchers.sourceType, ['SUPPLIER_INVOICE', 'SUPPLIER_CHALLAN']), eq(journalVouchers.sourceId, inv.id)));
      for (const v of vouchers) {
        await tx.delete(journalLines).where(eq(journalLines.voucherId, v.id));
        await tx.delete(journalVouchers).where(eq(journalVouchers.id, v.id));
      }
      await tx.delete(schemePurchases).where(eq(schemePurchases.referenceId, inv.id));
      await tx.delete(supplierInvoices).where(eq(supplierInvoices.id, inv.id));
    });
  }
  return invs.length;
}
