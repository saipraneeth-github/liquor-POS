/**
 * pour.service.ts — Pour counts (physical check of the open bottle) and the variance report.
 */

import { z } from 'zod';
import { and, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { billItems, bills, pourCounts, products, stock, stockAudit, users } from '../../db/schema.js';
import { BusinessRuleError, NotFoundError } from '../../lib/errors.js';
import { businessRangeBounds, isIsoDate } from '../../lib/business-day.js';
import type { JwtPayload } from '../auth/auth.service.js';
import { assertValidCount, pourVariance, variancePercent, varianceValue } from './pour.engine.js';

export const PourCountSchema = z.object({
  productId: z.string().uuid(),
  countedMl: z.number().int().min(0).max(5000),
  note:      z.string().trim().max(300).optional(),
  adjust:    z.boolean().optional().default(true),   // reset the system's open-bottle ml to what was counted
});
export type PourCountInput = z.infer<typeof PourCountSchema>;

export const PourReportQuerySchema = z.object({
  from: z.string().refine(isIsoDate, 'from must be YYYY-MM-DD'),
  to:   z.string().refine(isIsoDate, 'to must be YYYY-MM-DD'),
});

export async function recordPourCount(branchId: string, input: PourCountInput, user: JwtPayload) {
  return db.transaction(async (tx) => {
    const [product] = await tx.select({ id: products.id, name: products.name, volumeMl: products.volumeMl })
      .from(products).where(eq(products.id, input.productId)).limit(1);
    if (!product) throw new NotFoundError('Product not found');
    try {
      assertValidCount(input.countedMl, product.volumeMl);
    } catch (e) {
      throw new BusinessRuleError((e as Error).message);
    }

    const [row] = await tx.select({ openMl: stock.openMl })
      .from(stock)
      .where(and(eq(stock.branchId, branchId), eq(stock.productId, input.productId)))
      .for('update');
    if (!row) throw new BusinessRuleError(`${product.name} has no stock record in this branch`);

    const variance = pourVariance(row.openMl, input.countedMl);
    const [count] = await tx.insert(pourCounts).values({
      branchId,
      productId: input.productId,
      userId: user.sub,
      expectedMl: row.openMl,
      countedMl: input.countedMl,
      varianceMl: variance,
      note: input.note || null,
    }).returning();

    if (input.adjust && variance !== 0) {
      await tx.update(stock).set({ openMl: input.countedMl })
        .where(and(eq(stock.branchId, branchId), eq(stock.productId, input.productId)));
      await tx.insert(stockAudit).values({
        branchId, productId: input.productId, userId: user.sub,
        changeQty: 0, changeMl: variance, reason: 'MANUAL_ADJUST', referenceId: count.id,
      });
    }
    return count;
  });
}

/** Per bar product: pegs and ml sold in the period, ml variance recorded by counts, and its value. */
export async function pourReport(branchId: string, from: string, to: string) {
  const { start, end } = businessRangeBounds(from, to);

  const sold = await db
    .select({
      productId: billItems.productId,
      pegs: sql<number>`coalesce(sum(${billItems.quantity}), 0)::int`,
      ml: sql<number>`coalesce(sum(${billItems.quantity} * ${billItems.servingMl}), 0)::int`,
    })
    .from(billItems)
    .innerJoin(bills, eq(billItems.billId, bills.id))
    .where(and(
      eq(bills.branchId, branchId),
      eq(bills.status, 'PAID'),
      gte(bills.createdAt, start),
      lt(bills.createdAt, end),
      isNotNull(billItems.servingMl),
    ))
    .groupBy(billItems.productId);

  const counted = await db
    .select({
      productId: pourCounts.productId,
      counts: sql<number>`count(*)::int`,
      varianceMl: sql<number>`coalesce(sum(${pourCounts.varianceMl}), 0)::int`,
    })
    .from(pourCounts)
    .where(and(eq(pourCounts.branchId, branchId), gte(pourCounts.createdAt, start), lt(pourCounts.createdAt, end)))
    .groupBy(pourCounts.productId);

  const ids = [...new Set([...sold.map((r) => r.productId), ...counted.map((r) => r.productId)])];
  if (ids.length === 0) return { from, to, rows: [], totals: { soldMl: 0, varianceMl: 0, varianceValue: '0.00' } };

  const meta = await db
    .select({ id: products.id, name: products.name, volumeMl: products.volumeMl, mrp: products.mrp, openMl: stock.openMl })
    .from(products)
    .leftJoin(stock, and(eq(stock.productId, products.id), eq(stock.branchId, branchId)))
    .where(inArray(products.id, ids));
  const metaById = new Map(meta.map((m) => [m.id, m]));
  const soldById = new Map(sold.map((r) => [r.productId, r]));
  const countedById = new Map(counted.map((r) => [r.productId, r]));

  const rows = ids.map((id) => {
    const m = metaById.get(id)!;
    const s = soldById.get(id);
    const c = countedById.get(id);
    const soldMl = s?.ml ?? 0;
    const varianceMl = c?.varianceMl ?? 0;
    return {
      productId: id,
      name: m.name,
      pegsSold: s?.pegs ?? 0,
      soldMl,
      counts: c?.counts ?? 0,
      varianceMl,
      variancePercent: variancePercent(varianceMl, soldMl),
      varianceValue: varianceValue(varianceMl, m.mrp, m.volumeMl),
      openMlNow: m.openMl ?? 0,
      bottleMl: m.volumeMl,
    };
  }).sort((a, b) => a.varianceMl - b.varianceMl);   // biggest shortage first

  const totals = rows.reduce((acc, r) => ({
    soldMl: acc.soldMl + r.soldMl,
    varianceMl: acc.varianceMl + r.varianceMl,
    varianceValue: (Number(acc.varianceValue) + Number(r.varianceValue)).toFixed(2),
  }), { soldMl: 0, varianceMl: 0, varianceValue: '0.00' });

  return { from, to, rows, totals };
}

/** Latest counts, newest first, with who counted. */
export async function recentPourCounts(branchId: string, limit = 30) {
  return db
    .select({
      id: pourCounts.id, productId: pourCounts.productId, name: products.name,
      expectedMl: pourCounts.expectedMl, countedMl: pourCounts.countedMl, varianceMl: pourCounts.varianceMl,
      note: pourCounts.note, createdAt: pourCounts.createdAt, by: users.name,
    })
    .from(pourCounts)
    .innerJoin(products, eq(pourCounts.productId, products.id))
    .leftJoin(users, eq(pourCounts.userId, users.id))
    .where(eq(pourCounts.branchId, branchId))
    .orderBy(sql`${pourCounts.createdAt} desc`)
    .limit(limit);
}
