import { sql, eq, inArray } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { pgTable, text, integer, uniqueIndex } from 'drizzle-orm/pg-core';

const products = pgTable('products', {
  id: text('id').primaryKey(),
  costPrice: text('cost_price').notNull(),
  mrp: text('mrp').notNull()
});

async function main() {
  const client = new PGlite();
  const db = drizzle(client);

  await client.exec(`
    CREATE TABLE products (
      id TEXT PRIMARY KEY,
      cost_price TEXT NOT NULL,
      mrp TEXT NOT NULL
    );
  `);

  await db.insert(products).values({ id: 'p1', costPrice: '10.00', mrp: '20.00' });
  await db.insert(products).values({ id: 'p2', costPrice: '15.00', mrp: '30.00' });

  // Can we batch update products with ON CONFLICT DO UPDATE? Yes, but it requires doing INSERT ... ON CONFLICT
  // However, updating products might be easier if we just do Promise.all().
  // Wait, wait... In billing.service.ts, computeStockDeltas is used.
}

main().catch(console.error);
