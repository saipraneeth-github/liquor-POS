import postgres from 'postgres';
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { PGlite } from '@electric-sql/pglite';
import * as schema from './schema.js';
import dns from 'node:dns';

// Fallback DNS resolver for ISPs/routers (like Airtel/Jio) that return RCODE_REFUSED for cloud DB domains like *.neon.tech
if (!process.env.DATABASE_URL?.startsWith('pglite://')) {
  try {
    dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
    const origLookup = dns.lookup;
    // @ts-expect-error - wrapping node:dns lookup to provide public DNS fallback
    dns.lookup = (hostname: string, options: any, callback: any) => {
      if (typeof options === 'function') {
        callback = options;
        options = {};
      }
      origLookup(hostname, options, (err: any, address: any, family: any) => {
        if (err && (err.code === 'ENOTFOUND' || err.code === 'EREFUSED')) {
          dns.resolve4(hostname, (err2, addresses) => {
            if (!err2 && addresses?.length) {
              if (options?.all) {
                return callback(null, addresses.map((a) => ({ address: a, family: 4 })));
              }
              return callback(null, addresses[0], 4);
            }
            callback(err, address, family);
          });
        } else {
          callback(err, address, family);
        }
      });
    };
  } catch {
    // Non-fatal if runtime restricts DNS configuration
  }
}

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
