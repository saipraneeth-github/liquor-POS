import { sql } from 'drizzle-orm';
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

  // In Drizzle we can't do a bulk update with WHERE very easily.
  // Wait, the "for loop" in billing void is:
  // await tx.insert(stock).values({ branchId: bill.branchId, productId: delta.productId, quantity: delta.delta })
  // .onConflictDoUpdate({ target: [stock.branchId, stock.productId], set: { quantity: sql`${stock.quantity} + ${delta.delta}` } });

  // Is it possible to pass an array to insert.values().onConflictDoUpdate()?

  const deltas = [
    { productId: 'p1', delta: 5 },
    { productId: 'p2', delta: 10 },
    { productId: 'p3', delta: 15 } // new stock
  ];

  await db.insert(stock).values(deltas.map(d => ({ branchId: 'b1', productId: d.productId, quantity: d.delta })))
    .onConflictDoUpdate({
      target: [stock.branchId, stock.productId],
      set: { quantity: sql`${stock.quantity} + EXCLUDED.quantity` }
    });

  const res = await db.select().from(stock);
  console.log("AFTER ON CONFLICT:", res);
}

main().catch(console.error);
