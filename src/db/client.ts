import postgres from 'postgres';
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { PGlite } from '@electric-sql/pglite';
import * as schema from './schema.js';

/**
 * DATABASE_URL selects the driver:
 *   postgresql://user:pass@host:5432/db   → real PostgreSQL (production)
 *   pglite://./.pglite                    → embedded PGlite stored in that directory (local dev / e2e)
 *   pglite://memory                       → in-memory PGlite (tests)
 */
const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL environment variable is required');
}

function createDb(databaseUrl: string) {
  if (databaseUrl.startsWith('pglite://')) {
    const target = databaseUrl.slice('pglite://'.length);
    const client = target === 'memory' || target === '' ? new PGlite() : new PGlite(target);
    return drizzlePglite(client, { schema });
  }
  const sql = postgres(databaseUrl, { max: 10, idle_timeout: 30 });
  return drizzlePg(sql, { schema });
}

// Both drivers expose the same query-builder API; type as the postgres-js flavour.
export const db = createDb(url) as unknown as ReturnType<typeof drizzlePg<typeof schema>>;
export type DB = typeof db;
export const isPglite = url.startsWith('pglite://');
