import { sql, eq, inArray } from 'drizzle-orm';
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

  // Can we batch update with CASE?
  // Let's do it using Drizzle's ON CONFLICT DO UPDATE since it's cleaner.

  const items = [
    { productId: 'p1', quantity: 5 },
    { productId: 'p2', quantity: 10 },
  ];

  await db.insert(stock).values(
    items.map(item => ({
      branchId: 'b1',
      productId: item.productId,
      quantity: item.quantity
    }))
  ).onConflictDoUpdate({
    target: [stock.branchId, stock.productId],
    set: { quantity: sql`${stock.quantity} + EXCLUDED.quantity` }
  });

  const res = await db.select().from(stock);
  console.log("AFTER INSERT/UPDATE:", res);
}

main().catch(console.error);
