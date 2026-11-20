import { z } from 'zod';
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { products, stock, stockAudit } from '../../db/schema.js';
import { businessDateOf, businessDayBounds, isIsoDate } from '../../lib/business-day.js';
import { BusinessRuleError, NotFoundError } from '../../lib/errors.js';
import { buildDailyRegister, buildRegister, type Moves, type RegisterInput } from './register.engine.js';

const ISO_DATE = z.string().refine(isIsoDate, 'must be YYYY-MM-DD');
export const RegisterQuerySchema = z.object({ from: ISO_DATE.optional(), to: ISO_DATE.optional(), format: z.enum(['json', 'csv']).default('json') })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: 'from must be on or before to', path: ['from'] });

function period(q: { from?: string; to?: string }) {
  const to = q.to ?? businessDateOf();
  const from = q.from ?? businessDateOf(new Date(Date.parse(to + 'T00:00:00Z') - 29 * 86_400_000));
  if (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z') > 366 * 86_400_000) throw new BusinessRuleError('Choose a period of at most 366 days');
  return { from, to, start: businessDayBounds(from).start, end: businessDayBounds(to).end };
}

/** Stock register of an outlet for a period: every product with stock or movement. */
export async function getStockRegister(branchId: string, q: { from?: string; to?: string }) {
  const { from, to, start, end } = period(q);

  const [inPeriod, afterPeriod, held] = await Promise.all([
    db.select({ productId: stockAudit.productId, reason: stockAudit.reason, change: sql<number>`sum(${stockAudit.changeQty})::int` })
      .from(stockAudit).where(and(eq(stockAudit.branchId, branchId), gte(stockAudit.createdAt, start), lt(stockAudit.createdAt, end))).groupBy(stockAudit.productId, stockAudit.reason),
    db.select({ productId: stockAudit.productId, change: sql<number>`sum(${stockAudit.changeQty})::int` })
      .from(stockAudit).where(and(eq(stockAudit.branchId, branchId), gte(stockAudit.createdAt, end))).groupBy(stockAudit.productId),
    db.select({ productId: stock.productId, quantity: stock.quantity }).from(stock).where(eq(stock.branchId, branchId)),
  ]);

  const moves = new Map<string, Moves>();
  for (const r of inPeriod) moves.set(r.productId, { ...(moves.get(r.productId) ?? {}), [r.reason]: Number(r.change) });
  const after = new Map(afterPeriod.map((r) => [r.productId, Number(r.change)]));
  const current = new Map(held.map((r) => [r.productId, r.quantity]));

  const ids = [...new Set([...moves.keys(), ...current.keys()])];
  const info = ids.length === 0 ? [] : await db.select({ id: products.id, name: products.name, brand: products.brand, volumeMl: products.volumeMl, packQuantity: products.packQuantity })
    .from(products).where(inArray(products.id, ids));

  const inputs: RegisterInput[] = info.map((p) => ({
    productId: p.id, name: p.name, brand: p.brand ?? null, volumeMl: p.volumeMl ?? null, packQuantity: p.packQuantity ?? null,
    current: current.get(p.id) ?? 0, after: after.get(p.id) ?? 0, moves: moves.get(p.id) ?? {},
  })).filter((i) => i.current !== 0 || i.after !== 0 || Object.keys(i.moves).length > 0);

  return { branchId, from, to, ...buildRegister(inputs) };
}

/** One product's register, day by day. */
export async function getProductRegister(branchId: string, productId: string, q: { from?: string; to?: string }) {
  const { from, to, start, end } = period(q);
  const [product] = await db.select({ id: products.id, name: products.name }).from(products).where(eq(products.id, productId)).limit(1);
  if (!product) throw new NotFoundError('Product not found');

  const [rows, afterRows, held] = await Promise.all([
    db.select({ reason: stockAudit.reason, change: stockAudit.changeQty, at: stockAudit.createdAt }).from(stockAudit)
      .where(and(eq(stockAudit.branchId, branchId), eq(stockAudit.productId, productId), gte(stockAudit.createdAt, start), lt(stockAudit.createdAt, end))),
    db.select({ change: sql<number>`coalesce(sum(${stockAudit.changeQty}), 0)::int` }).from(stockAudit)
      .where(and(eq(stockAudit.branchId, branchId), eq(stockAudit.productId, productId), gte(stockAudit.createdAt, end))),
    db.select({ quantity: stock.quantity }).from(stock).where(and(eq(stock.branchId, branchId), eq(stock.productId, productId))).limit(1),
  ]);

  const byDay = new Map<string, Moves>();
  let net = 0;
  for (const r of rows) {
    const day = businessDateOf(r.at ?? new Date());
    const m = byDay.get(day) ?? {};
    m[r.reason] = (m[r.reason] ?? 0) + r.change;
    byDay.set(day, m);
    net += r.change;
  }
  const closing = (held[0]?.quantity ?? 0) - Number(afterRows[0]?.change ?? 0);
  const opening = closing - net;
  return { branchId, productId, name: product.name, from, to, opening, closing, days: buildDailyRegister(opening, byDay) };
}
