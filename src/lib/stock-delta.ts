import { sql } from 'drizzle-orm';
import type { Tx } from './domain-events.js';

export interface StockDelta { branchId: string; productId: string; saleTypeId?: string; quantity: number }

/**
 * Adds a signed quantity to `stock` (or `stock_by_type` when `saleTypeId` is present) in two statements, whatever the sign.
 *
 * Why not `INSERT ... VALUES (delta) ON CONFLICT DO UPDATE SET quantity = quantity + EXCLUDED.quantity`: PostgreSQL checks
 * a CHECK constraint on the *proposed* row before it resolves the conflict, so a negative delta is refused even when the
 * stored total would stay positive. That is why `quantity >= 0` could not be enforced. Here existing rows are UPDATEd, and
 * a row that does not exist yet can only start from zero or more.
 */
export async function addStockDeltas(tx: Tx, rows: StockDelta[]): Promise<void> {
  if (rows.length === 0) return;
  const typed = rows[0].saleTypeId !== undefined;
  const table = typed ? sql`stock_by_type` : sql`stock`;
  const values = sql.join(rows.map((r) => typed
    ? sql`(${r.branchId}::uuid, ${r.productId}::uuid, ${r.saleTypeId!}::uuid, ${r.quantity}::int)`
    : sql`(${r.branchId}::uuid, ${r.productId}::uuid, ${r.quantity}::int)`), sql`, `);
  const cols = typed ? sql`d(b, p, t, q)` : sql`d(b, p, q)`;
  const match = typed
    ? sql`x.branch_id = d.b AND x.product_id = d.p AND x.sale_type_id = d.t`
    : sql`x.branch_id = d.b AND x.product_id = d.p`;

  await tx.execute(sql`UPDATE ${table} x SET quantity = x.quantity + d.q FROM (VALUES ${values}) AS ${cols} WHERE ${match}`);
  await tx.execute(typed
    ? sql`INSERT INTO stock_by_type (branch_id, product_id, sale_type_id, quantity)
          SELECT d.b, d.p, d.t, GREATEST(d.q, 0) FROM (VALUES ${values}) AS ${cols}
          WHERE NOT EXISTS (SELECT 1 FROM stock_by_type x WHERE ${match}) ON CONFLICT DO NOTHING`
    : sql`INSERT INTO stock (branch_id, product_id, quantity)
          SELECT d.b, d.p, GREATEST(d.q, 0) FROM (VALUES ${values}) AS ${cols}
          WHERE NOT EXISTS (SELECT 1 FROM stock x WHERE ${match}) ON CONFLICT DO NOTHING`);
}
