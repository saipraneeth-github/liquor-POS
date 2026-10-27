import { sql, eq, and, gte } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { pgTable, text, integer, uniqueIndex } from 'drizzle-orm/pg-core';

const stock = pgTable('stock', {
  branchId: text('branch_id').notNull(),
  productId: text('product_id').notNull(),
  quantity: integer('quantity').notNull()
}, (t) => ({
  uniq: uniqueIndex('uniq_idx').on(t.branchId, t.productId)
}));

async function main() {
  const client = new PGlite();
  const db = drizzle(client);

  await client.exec(`
    CREATE TABLE stock (
      branch_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      quantity INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX uniq_idx ON stock(branch_id, product_id);
  `);

  await db.insert(stock).values({ branchId: 'b1', productId: 'p1', quantity: 10 });
  await db.insert(stock).values({ branchId: 'b1', productId: 'p2', quantity: 20 });

  // Can we batch update WITH a condition like quantity >= qty using CASE WHEN?
  // We can do it!
  const deltas = [
    { productId: 'p1', delta: -5 },
    { productId: 'p2', delta: -15 },
  ];

  // In billing.service.ts, the for loop is used to throw an error EXACTLY on the first product that fails stock condition.
  // Wait, if we use CASE WHEN in a single SQL statement, it's possible it won't throw until the whole statement finishes,
  // OR we can just use Promise.all.
  // Wait, if we use Promise.all() for `tx.update(stock)`, they run in parallel, avoiding N+1 round trips!
  // Let's test if Promise.all() works.

  try {
    const updates = await Promise.all(deltas.map(d => {
      const qty = -d.delta;
      return db.update(stock).set({ quantity: sql`${stock.quantity} - ${qty}` })
        .where(and(eq(stock.branchId, 'b1'), eq(stock.productId, d.productId), gte(stock.quantity, qty)))
        .returning({ id: stock.productId });
    }));
    console.log(updates);
  } catch (e) {
    console.error(e);
  }
}

main().catch(console.error);
