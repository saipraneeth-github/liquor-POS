/** Read side of supplier invoices: history list, detail, original file. */
import { Decimal } from 'decimal.js';
import { and, asc, desc, eq, gte, lt, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../../db/client.js';
import { invoiceAttachments, products, supplierInvoiceItems, supplierInvoices, users } from '../../db/schema.js';
import { NotFoundError } from '../../lib/errors.js';
import type { ListQuery } from './invoice.schemas.js';

const creator = alias(users, 'creator');
const approver = alias(users, 'approver');
const reviewer = alias(users, 'reviewer');
const rejecter = alias(users, 'rejecter');

const invoiceColumns = {
  id: supplierInvoices.id,
  branchId: supplierInvoices.branchId,
  supplierName: supplierInvoices.supplierName,
  invoiceNumber: supplierInvoices.invoiceNumber,
  invoiceDate: supplierInvoices.invoiceDate,
  totalAmount: supplierInvoices.totalAmount,
  status: supplierInvoices.status,
  source: supplierInvoices.source,
  originalFilename: supplierInvoices.originalFilename,
  notes: supplierInvoices.notes,
  createdAt: supplierInvoices.createdAt,
  createdById: supplierInvoices.createdById,
  createdByName: creator.name,
  reviewedById: supplierInvoices.reviewedById,
  reviewedByName: reviewer.name,
  reviewedAt: supplierInvoices.reviewedAt,
  approvedById: supplierInvoices.approvedById,
  approvedByName: approver.name,
  approvedAt: supplierInvoices.approvedAt,
  rejectedById: supplierInvoices.rejectedById,
  rejectedByName: rejecter.name,
  rejectedAt: supplierInvoices.rejectedAt,
  rejectionReason: supplierInvoices.rejectionReason,
};

export async function getInvoiceBranchId(id: string): Promise<string> {
  const [row] = await db.select({ branchId: supplierInvoices.branchId }).from(supplierInvoices).where(eq(supplierInvoices.id, id)).limit(1);
  if (!row) throw new NotFoundError('Invoice not found');
  return row.branchId;
}

export async function getInvoiceDetail(id: string) {
  const [invoice] = await db
    .select({ ...invoiceColumns, extractionWarnings: supplierInvoices.extractionWarnings, extractionMeta: supplierInvoices.extractionMeta })
    .from(supplierInvoices)
    .leftJoin(creator, eq(supplierInvoices.createdById, creator.id))
    .leftJoin(reviewer, eq(supplierInvoices.reviewedById, reviewer.id))
    .leftJoin(approver, eq(supplierInvoices.approvedById, approver.id))
    .leftJoin(rejecter, eq(supplierInvoices.rejectedById, rejecter.id))
    .where(eq(supplierInvoices.id, id))
    .limit(1);
  if (!invoice) throw new NotFoundError('Invoice not found');

  const items = await db
    .select({
      id: supplierInvoiceItems.id,
      lineNumber: supplierInvoiceItems.lineNumber,
      productId: supplierInvoiceItems.productId,
      productName: products.name,
      productBrand: products.brand,
      catalogMrp: products.mrp,
      packQuantity: products.packQuantity,
      rawDescription: supplierInvoiceItems.rawDescription,
      barcode: supplierInvoiceItems.barcode,
      quantity: supplierInvoiceItems.quantity,
      costPrice: supplierInvoiceItems.costPrice,
      mrp: supplierInvoiceItems.mrp,
      taxRate: supplierInvoiceItems.taxRate,
      lineCostTotal: supplierInvoiceItems.lineCostTotal,
      extractedAmount: supplierInvoiceItems.extractedAmount,
      matchStatus: supplierInvoiceItems.matchStatus,
      matchMethod: supplierInvoiceItems.matchMethod,
      matchConfidence: supplierInvoiceItems.matchConfidence,
      flags: supplierInvoiceItems.flags,
    })
    .from(supplierInvoiceItems)
    .leftJoin(products, eq(supplierInvoiceItems.productId, products.id))
    .where(eq(supplierInvoiceItems.invoiceId, id))
    .orderBy(asc(supplierInvoiceItems.lineNumber), asc(supplierInvoiceItems.id));

  const attachments = await db
    .select({
      id: invoiceAttachments.id, filename: invoiceAttachments.filename, mimeType: invoiceAttachments.mimeType,
      sizeBytes: invoiceAttachments.sizeBytes, sha256: invoiceAttachments.sha256, createdAt: invoiceAttachments.createdAt,
    })
    .from(invoiceAttachments)
    .where(eq(invoiceAttachments.invoiceId, id));

  const linesTotal = items.reduce((s, i) => s.plus(i.lineCostTotal), new Decimal(0));
  return {
    invoice: { ...invoice, linesTotal: linesTotal.toFixed(2) },
    items: items.map((i) => ({ ...i, flags: i.flags ?? [] })),
    attachment: attachments[0] ?? null,
  };
}

export async function getInvoiceAttachment(invoiceId: string) {
  const [row] = await db
    .select({ filename: invoiceAttachments.filename, mimeType: invoiceAttachments.mimeType, data: invoiceAttachments.data })
    .from(invoiceAttachments)
    .where(eq(invoiceAttachments.invoiceId, invoiceId))
    .limit(1);
  if (!row) throw new NotFoundError('No original file stored for this invoice');
  return row;
}

export async function listInvoices(branchId: string, q: ListQuery) {
  const conds: SQL[] = [eq(supplierInvoices.branchId, branchId)];
  if (q.status) conds.push(eq(supplierInvoices.status, q.status));
  const effectiveDate = sql`coalesce(${supplierInvoices.invoiceDate}, ${supplierInvoices.createdAt})`;
  if (q.from) conds.push(gte(effectiveDate, new Date(q.from)));
  if (q.to) conds.push(lt(effectiveDate, new Date(new Date(q.to).getTime() + 86_400_000)));
  if (q.q) {
    const like = `%${q.q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    conds.push(sql`(${supplierInvoices.supplierName} ilike ${like} or ${supplierInvoices.invoiceNumber} ilike ${like} or coalesce(${supplierInvoices.originalFilename}, '') ilike ${like})`);
  }

  const lineStats = db
    .select({
      invoiceId: supplierInvoiceItems.invoiceId,
      lineCount: sql<number>`count(*)::int`.as('line_count'),
      linesTotal: sql<string>`coalesce(sum(${supplierInvoiceItems.lineCostTotal}), 0)::numeric(14,2)::text`.as('lines_total'),
      flagCount: sql<number>`coalesce(sum(jsonb_array_length(coalesce(${supplierInvoiceItems.flags}, '[]'::jsonb))), 0)::int`.as('flag_count'),
      unmatchedCount: sql<number>`count(*) filter (where ${supplierInvoiceItems.productId} is null)::int`.as('unmatched_count'),
    })
    .from(supplierInvoiceItems)
    .groupBy(supplierInvoiceItems.invoiceId)
    .as('line_stats');

  const where = and(...conds);
  const rows = await db
    .select({
      ...invoiceColumns,
      warningCount: sql<number>`coalesce(jsonb_array_length(${supplierInvoices.extractionWarnings}), 0)::int`,
      lineCount: sql<number>`coalesce(${lineStats.lineCount}, 0)::int`,
      linesTotal: sql<string>`coalesce(${lineStats.linesTotal}, '0.00')`,
      flagCount: sql<number>`coalesce(${lineStats.flagCount}, 0)::int`,
      unmatchedCount: sql<number>`coalesce(${lineStats.unmatchedCount}, 0)::int`,
    })
    .from(supplierInvoices)
    .leftJoin(lineStats, eq(lineStats.invoiceId, supplierInvoices.id))
    .leftJoin(creator, eq(supplierInvoices.createdById, creator.id))
    .leftJoin(reviewer, eq(supplierInvoices.reviewedById, reviewer.id))
    .leftJoin(approver, eq(supplierInvoices.approvedById, approver.id))
    .leftJoin(rejecter, eq(supplierInvoices.rejectedById, rejecter.id))
    .where(where)
    .orderBy(desc(supplierInvoices.createdAt), desc(supplierInvoices.id))
    .limit(q.limit)
    .offset(q.offset);
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(supplierInvoices).where(where);
  return { items: rows, total: Number(total), limit: q.limit, offset: q.offset };
}
