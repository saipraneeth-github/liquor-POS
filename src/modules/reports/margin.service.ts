import { z } from 'zod';
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { billItems, bills, branchProductCosts, products, salesReturnItems, salesReturns } from '../../db/schema.js';
import { businessDateOf, businessDayBounds, isIsoDate } from '../../lib/business-day.js';
import { BusinessRuleError } from '../../lib/errors.js';
import { buildMarginReport, type ReturnedRow, type SoldRow } from './margin.engine.js';

const ISO_DATE = z.string().refine(isIsoDate, 'must be YYYY-MM-DD');
export const MarginQuerySchema = z.object({ from: ISO_DATE.optional(), to: ISO_DATE.optional() })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: 'from must be on or before to', path: ['from'] });

const MAX_DAYS = 366;

/** Product margin for an outlet over a period (see margin.engine.ts for the rules). */
export async function getMarginReport(branchId: string, q: z.infer<typeof MarginQuerySchema>) {
  const to = q.to ?? businessDateOf();
  const from = q.from ?? businessDateOf(new Date(Date.parse(to + 'T00:00:00Z') - 29 * 86_400_000));
  if (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z') > MAX_DAYS * 86_400_000) throw new BusinessRuleError(`Choose a period of at most ${MAX_DAYS} days`);
  const start = businessDayBounds(from).start;
  const end = businessDayBounds(to).end;

  // A line's share of the bill discount: the bill discount is spread over the lines in proportion to their gross
  const share = (gross: unknown) => sql<string>`coalesce(round(${gross} * ${bills.discount} / nullif(${bills.subtotal}, 0), 2), 0)`;

  const soldRows = await db
    .select({
      productId: billItems.productId, name: products.name,
      // a peg is a fraction of a bottle
      qty: sql<string>`sum(case when ${billItems.servingMl} is not null and ${products.volumeMl} > 0 then ${billItems.servingMl}::numeric * ${billItems.quantity} / ${products.volumeMl} else ${billItems.quantity} end)::text`,
      gross: sql<string>`sum(${billItems.lineTotal})::text`, tax: sql<string>`sum(${billItems.taxAmount})::text`,
      discountShare: sql<string>`sum(${share(billItems.lineTotal)})::text`,
    })
    .from(billItems).innerJoin(bills, eq(bills.id, billItems.billId)).innerJoin(products, eq(products.id, billItems.productId))
    .where(and(eq(bills.branchId, branchId), eq(bills.status, 'PAID'), gte(bills.createdAt, start), lt(bills.createdAt, end)))
    .groupBy(billItems.productId, products.name);

  const returnedRows = await db
    .select({
      productId: salesReturnItems.productId, qty: sql<number>`sum(${salesReturnItems.quantity})::int`,
      gross: sql<string>`sum(${salesReturnItems.grossAmount})::text`, tax: sql<string>`sum(${salesReturnItems.taxAmount})::text`,
      discountShare: sql<string>`sum(${share(salesReturnItems.grossAmount)})::text`,
    })
    .from(salesReturnItems).innerJoin(salesReturns, eq(salesReturns.id, salesReturnItems.returnId)).innerJoin(bills, eq(bills.id, salesReturns.billId))
    .where(and(eq(salesReturns.branchId, branchId), gte(salesReturns.createdAt, start), lt(salesReturns.createdAt, end)))
    .groupBy(salesReturnItems.productId);

  const ids = soldRows.map((r) => r.productId);
  const unitCost = new Map<string, string | null>(ids.map((id) => [id, null]));
  if (ids.length > 0) {
    // this outlet's own cost first; the business-wide last cost only for a bottle the outlet has no record of
    const legacy = await db.select({ id: products.id, cost: products.costPrice }).from(products).where(inArray(products.id, ids));
    for (const l of legacy) if (l.cost && Number(l.cost) > 0) unitCost.set(l.id, l.cost);
    const own = await db.select({ productId: branchProductCosts.productId, cost: branchProductCosts.costPrice }).from(branchProductCosts)
      .where(and(eq(branchProductCosts.branchId, branchId), inArray(branchProductCosts.productId, ids)));
    for (const c of own) if (Number(c.cost) > 0) unitCost.set(c.productId, c.cost);
  }

  const sold: SoldRow[] = soldRows.map((r) => ({ productId: r.productId, name: r.name, quantity: Number(r.qty), gross: r.gross, tax: r.tax, discountShare: r.discountShare }));
  const returned: ReturnedRow[] = returnedRows.map((r) => ({ productId: r.productId, quantity: Number(r.qty), gross: r.gross, tax: r.tax, discountShare: r.discountShare }));
  return { branchId, from, to, ...buildMarginReport(sold, returned, unitCost) };
}
