/**
 * compliance.service.ts — Excise quotas, stock-lifting report, breakage and stock reconciliation.
 * Pure lifting maths lives in lifting.engine.ts.
 */

import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  exciseQuotas,
  breakageLogs,
  stock,
  stockAudit,
  products,
  categories,
  supplierInvoices,
  supplierInvoiceItems,
  users,
} from '../../db/schema.js';
import { and, asc, desc, eq, gte, lt, sql, type SQL } from 'drizzle-orm';
import { Decimal } from 'decimal.js';
import { BusinessRuleError, NotFoundError } from '../../lib/errors.js';
import { businessDateOf, businessDayBounds, businessRangeBounds, isIsoDate } from '../../lib/business-day.js';
import { evaluateLifting, periodsOverlap } from './lifting.engine.js';
import type { JwtPayload } from '../auth/auth.service.js';

// ─── SCHEMAS ────────────────────────────────────────────────────────────────

const ISO_DATE = z.string().refine(isIsoDate, 'must be a YYYY-MM-DD date');

export const CreateQuotaSchema = z.object({
  categoryId:  z.string().uuid().optional(),
  periodStart: ISO_DATE,
  periodEnd:   ISO_DATE,
  quotaCases:  z.number().int().positive().max(10_000_000),
  notes:       z.string().trim().max(1000).optional(),
}).refine((d) => d.periodEnd >= d.periodStart, {
  message: 'periodEnd must be on or after periodStart',
  path: ['periodEnd'],
});

export const DateRangeQuerySchema = z.object({
  from: ISO_DATE.optional(),
  to:   ISO_DATE.optional(),
}).refine((d) => !d.from || !d.to || d.to >= d.from, {
  message: 'to must be on or after from',
  path: ['to'],
});

export const BreakageSchema = z.object({
  productId: z.string().uuid(),
  quantity:  z.number().int().positive().max(100_000),
  reason:    z.string().trim().min(3).max(500),
});

export const StockAuditQuerySchema = z.object({
  productId: z.string().uuid().optional(),
  from:      ISO_DATE.optional(),
  to:        ISO_DATE.optional(),
  limit:     z.coerce.number().int().min(1).max(2000).default(500),
}).refine((d) => !d.from || !d.to || d.to >= d.from, {
  message: 'to must be on or after from',
  path: ['to'],
});

export type CreateQuotaInput = z.infer<typeof CreateQuotaSchema>;
export type BreakageInput = z.infer<typeof BreakageSchema>;
export type StockAuditQuery = z.infer<typeof StockAuditQuerySchema>;

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/** createdAt range conditions for optional inclusive business dates. */
function createdAtRange(column: typeof breakageLogs.createdAt | typeof stockAudit.createdAt, from?: string, to?: string): SQL[] {
  const conditions: SQL[] = [];
  if (from) conditions.push(gte(column, businessDayBounds(from).start));
  if (to) conditions.push(lt(column, businessDayBounds(to).end));
  return conditions;
}

// ─── EXCISE QUOTAS ───────────────────────────────────────────────────────────

export async function createQuota(branchId: string, input: CreateQuotaInput) {
  if (input.categoryId) {
    const [cat] = await db.select({ id: categories.id }).from(categories).where(eq(categories.id, input.categoryId)).limit(1);
    if (!cat) throw new BusinessRuleError('Category not found');
  }
  const [row] = await db.insert(exciseQuotas).values({
    branchId,
    categoryId:  input.categoryId ?? null,
    periodStart: input.periodStart,
    periodEnd:   input.periodEnd,
    quotaCases:  input.quotaCases,
    notes:       input.notes ?? null,
  }).returning();
  return row;
}

export async function listQuotas(branchId: string) {
  return db
    .select({
      id:           exciseQuotas.id,
      branchId:     exciseQuotas.branchId,
      categoryId:   exciseQuotas.categoryId,
      categoryName: categories.name,
      periodStart:  exciseQuotas.periodStart,
      periodEnd:    exciseQuotas.periodEnd,
      quotaCases:   exciseQuotas.quotaCases,
      notes:        exciseQuotas.notes,
      createdAt:    exciseQuotas.createdAt,
    })
    .from(exciseQuotas)
    .leftJoin(categories, eq(exciseQuotas.categoryId, categories.id))
    .where(eq(exciseQuotas.branchId, branchId))
    .orderBy(desc(exciseQuotas.periodStart));
}

// ─── STOCK LIFTING REPORT ────────────────────────────────────────────────────

/**
 * For every quota overlapping [from, to] (defaults: today), sums the bottles on APPROVED
 * supplier invoices dated inside the QUOTA period (invoice_date, falling back to
 * approved_at / created_at), converted to cases, and evaluates utilisation and flags.
 */
export async function getLiftingReport(branchId: string, from?: string, to?: string, today = businessDateOf()) {
  const rangeFrom = from ?? to ?? today;
  const rangeTo = to ?? from ?? today;

  const quotas = (await listQuotas(branchId))
    .filter((q) => periodsOverlap(q.periodStart, q.periodEnd, rangeFrom, rangeTo))
    .sort((a, b) => a.periodStart.localeCompare(b.periodStart));

  const liftedAt = sql`coalesce(${supplierInvoices.invoiceDate}, ${supplierInvoices.approvedAt}, ${supplierInvoices.createdAt})`;

  const report = [];
  for (const q of quotas) {
    const { start, end } = businessRangeBounds(q.periodStart, q.periodEnd);
    const conditions: SQL[] = [
      eq(supplierInvoices.branchId, branchId),
      eq(supplierInvoices.status, 'APPROVED'),
      sql`${liftedAt} >= ${start.toISOString()}::timestamptz`,
      sql`${liftedAt} < ${end.toISOString()}::timestamptz`,
    ];
    if (q.categoryId) conditions.push(eq(products.categoryId, q.categoryId));

    const lines = await db
      .select({ quantity: supplierInvoiceItems.quantity, packQuantity: products.packQuantity })
      .from(supplierInvoiceItems)
      .innerJoin(supplierInvoices, eq(supplierInvoiceItems.invoiceId, supplierInvoices.id))
      .leftJoin(products, eq(supplierInvoiceItems.productId, products.id))
      .where(and(...conditions));

    report.push({
      quotaId:      q.id,
      categoryId:   q.categoryId,
      categoryName: q.categoryName ?? 'ALL',
      periodStart:  q.periodStart,
      periodEnd:    q.periodEnd,
      quotaCases:   q.quotaCases,
      ...evaluateLifting(q, lines, today),
    });
  }

  return { branchId, from: rangeFrom, to: rangeTo, today, quotas: report };
}

// ─── BREAKAGE ────────────────────────────────────────────────────────────────

/** Records a breakage: guarded stock decrement, breakage log, BREAKAGE stock audit — atomically. */
export async function recordBreakage(branchId: string, input: BreakageInput, user: JwtPayload) {
  const [product] = await db
    .select({ id: products.id, name: products.name, costPrice: products.costPrice })
    .from(products)
    .where(eq(products.id, input.productId))
    .limit(1);
  if (!product) throw new NotFoundError('Product not found');

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(stock)
      .set({ quantity: sql`${stock.quantity} - ${input.quantity}` })
      .where(and(
        eq(stock.branchId, branchId),
        eq(stock.productId, input.productId),
        gte(stock.quantity, input.quantity),
      ))
      .returning({ quantity: stock.quantity });

    if (!updated) {
      const [current] = await tx
        .select({ quantity: stock.quantity })
        .from(stock)
        .where(and(eq(stock.branchId, branchId), eq(stock.productId, input.productId)))
        .limit(1);
      throw new BusinessRuleError(
        `Insufficient stock for ${product.name}: requested ${input.quantity}, available ${current?.quantity ?? 0}`,
      );
    }

    const costValue = new Decimal(product.costPrice ?? '0').times(input.quantity).toFixed(2);

    const [log] = await tx.insert(breakageLogs).values({
      branchId,
      productId:    input.productId,
      quantity:     input.quantity,
      reason:       input.reason,
      costValue,
      recordedById: user.sub,
    }).returning();

    await tx.insert(stockAudit).values({
      branchId,
      productId:   input.productId,
      userId:      user.sub,
      changeQty:   -input.quantity,
      reason:      'BREAKAGE',
      referenceId: log.id,
    });

    return { breakage: log, stockQuantity: updated.quantity };
  });
}

export async function listBreakage(branchId: string, from?: string, to?: string) {
  const rows = await db
    .select({
      id:           breakageLogs.id,
      productId:    breakageLogs.productId,
      productName:  products.name,
      quantity:     breakageLogs.quantity,
      reason:       breakageLogs.reason,
      costValue:    breakageLogs.costValue,
      recordedById: breakageLogs.recordedById,
      recordedBy:   users.name,
      createdAt:    breakageLogs.createdAt,
    })
    .from(breakageLogs)
    .innerJoin(products, eq(breakageLogs.productId, products.id))
    .leftJoin(users, eq(breakageLogs.recordedById, users.id))
    .where(and(eq(breakageLogs.branchId, branchId), ...createdAtRange(breakageLogs.createdAt, from, to)))
    .orderBy(desc(breakageLogs.createdAt));

  const totals = rows.reduce(
    (acc, r) => ({ quantity: acc.quantity + r.quantity, costValue: acc.costValue.plus(r.costValue) }),
    { quantity: 0, costValue: new Decimal(0) },
  );

  return {
    entries: rows,
    totals: { count: rows.length, quantity: totals.quantity, costValue: totals.costValue.toFixed(2) },
  };
}

// ─── STOCK RECONCILIATION ────────────────────────────────────────────────────

export async function getStockAuditReport(branchId: string, query: StockAuditQuery) {
  const conditions: SQL[] = [eq(stockAudit.branchId, branchId), ...createdAtRange(stockAudit.createdAt, query.from, query.to)];
  if (query.productId) conditions.push(eq(stockAudit.productId, query.productId));
  const where = and(...conditions);

  const [rows, summary] = await Promise.all([
    db
      .select({
        id:          stockAudit.id,
        productId:   stockAudit.productId,
        productName: products.name,
        userId:      stockAudit.userId,
        changeQty:   stockAudit.changeQty,
        reason:      stockAudit.reason,
        referenceId: stockAudit.referenceId,
        createdAt:   stockAudit.createdAt,
      })
      .from(stockAudit)
      .innerJoin(products, eq(stockAudit.productId, products.id))
      .where(where)
      .orderBy(desc(stockAudit.createdAt))
      .limit(query.limit),
    db
      .select({
        productId:   stockAudit.productId,
        productName: products.name,
        inQty:       sql<number>`coalesce(sum(case when ${stockAudit.changeQty} > 0 then ${stockAudit.changeQty} else 0 end), 0)::int`,
        outQty:      sql<number>`coalesce(sum(case when ${stockAudit.changeQty} < 0 then -${stockAudit.changeQty} else 0 end), 0)::int`,
        netChange:   sql<number>`coalesce(sum(${stockAudit.changeQty}), 0)::int`,
        entries:     sql<number>`count(*)::int`,
      })
      .from(stockAudit)
      .innerJoin(products, eq(stockAudit.productId, products.id))
      .where(where)
      .groupBy(stockAudit.productId, products.name)
      .orderBy(asc(products.name)),
  ]);

  return {
    entries: rows,
    summary: summary.map((s) => ({
      ...s,
      inQty: Number(s.inQty),
      outQty: Number(s.outQty),
      netChange: Number(s.netChange),
      entries: Number(s.entries),
    })),
  };
}

