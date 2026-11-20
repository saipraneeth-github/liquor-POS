import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { branches, products, stock, stockAudit, stockByType } from '../../db/schema.js';
import { addStockDeltas } from '../../lib/stock-delta.js';
import { logAudit } from '../../lib/audit.js';
import { BusinessRuleError, NotFoundError } from '../../lib/errors.js';
import type { JwtPayload } from '../auth/auth.service.js';
import { planAdjustments, type CurrentStock } from './stock-adjust.engine.js';

export const StockCountSchema = z.object({
  // why the book figure was wrong: it is kept on every movement's audit entry and in the audit log
  note: z.string().trim().min(10, 'Say why the count differs (at least 10 characters)').max(300),
  lines: z.array(z.object({
    productId: z.string().uuid(),
    countedQuantity: z.number().int('The count must be a whole number').min(0).max(1_000_000),
  })).min(1).max(1000)
    .refine((l) => new Set(l.map((x) => x.productId)).size === l.length, 'A product appears twice'),
});
export type StockCountInput = z.infer<typeof StockCountSchema>;

/**
 * Sets the shop total of each counted product to the physical count. Every difference is a `MANUAL_ADJUST` row in
 * `stock_audit` (signed, with the batch id as reference), so the stock-audit report shows who changed what and when.
 * Books: purchases are periodic-inventory, so no voucher is posted (see AGENTS.md known gaps).
 */
export async function adjustStock(branchId: string, input: StockCountInput, user: JwtPayload) {
  const batchId = randomUUID();
  const productIds = input.lines.map((l) => l.productId);

  const result = await db.transaction(async (tx) => {
    const [branch] = await tx.select({ syndicateId: branches.syndicateId }).from(branches).where(eq(branches.id, branchId)).limit(1);
    if (!branch) throw new NotFoundError('Branch not found');

    const productRows = await tx.select({ id: products.id, name: products.name, syndicateId: products.syndicateId })
      .from(products).where(inArray(products.id, productIds));
    const known = new Map(productRows.map((p) => [p.id, p]));
    const missing = productIds.filter((id) => {
      const p = known.get(id);
      return !p || (p.syndicateId && p.syndicateId !== branch.syndicateId);
    });
    if (missing.length > 0) throw new BusinessRuleError(`One or more products not found: ${missing.join(', ')}`);

    // Lock the rows being counted so a sale cannot slip in between reading the book figure and writing the count
    const stockRows = await tx.select({ productId: stock.productId, quantity: stock.quantity }).from(stock)
      .where(and(eq(stock.branchId, branchId), inArray(stock.productId, productIds))).for('update');
    const typeRows = await tx.select({ productId: stockByType.productId, total: sql<number>`sum(${stockByType.quantity})::int` })
      .from(stockByType).where(and(eq(stockByType.branchId, branchId), inArray(stockByType.productId, productIds)))
      .groupBy(stockByType.productId);

    const current = new Map<string, CurrentStock>();
    for (const id of productIds) current.set(id, { quantity: 0, otherCounters: 0, name: known.get(id)!.name });
    for (const r of stockRows) current.get(r.productId)!.quantity = r.quantity;
    for (const r of typeRows) current.get(r.productId)!.otherCounters = Number(r.total);

    const plan = planAdjustments(input.lines.map((l) => ({ productId: l.productId, counted: l.countedQuantity })), current);
    if (plan.problems.length > 0) throw new BusinessRuleError(plan.problems.join('; '));

    if (plan.changes.length > 0) {
      await addStockDeltas(tx, plan.changes.map((c) => ({ branchId, productId: c.productId, quantity: c.delta })));
      await tx.insert(stockAudit).values(plan.changes.map((c) => ({
        branchId, productId: c.productId, userId: user.sub, changeQty: c.delta, reason: 'MANUAL_ADJUST' as const, referenceId: batchId,
      })));
    }
    return plan;
  });

  if (result.changes.length > 0) {
    await logAudit(user.sub, 'stock.adjust', { type: 'branch', id: branchId }, {
      batchId, note: input.note, adjusted: result.changes.length, unchanged: result.unchanged,
      net: result.changes.reduce((n, c) => n + c.delta, 0),
    });
  }
  return { batchId, adjusted: result.changes, unchanged: result.unchanged };
}
