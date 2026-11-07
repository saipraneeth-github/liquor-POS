import postgres from 'postgres';
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { PGlite } from '@electric-sql/pglite';
import * as schema from './schema.js';
import dns from 'node:dns';

// Fallback DNS resolver for ISPs/routers (like Airtel/Jio) that return RCODE_REFUSED for cloud DB domains like *.neon.tech
// The system resolver is tried first; public resolvers are only consulted when it fails, and only through a
// dedicated Resolver (the process-wide dns.setServers() is left alone, so corporate/split DNS keeps working).
// Set DB_DNS_FALLBACK=0 to turn this off entirely (e.g. on a locked-down network).
if (!process.env.DATABASE_URL?.startsWith('pglite://') && process.env.DB_DNS_FALLBACK !== '0') {
  try {
    const publicResolver = new dns.Resolver();
    publicResolver.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
    const origLookup = dns.lookup;
    const fallbackLookup = (hostname: string, options: unknown, callback: unknown) => {
      let opts = options as dns.LookupOptions | number | undefined;
      let cb = callback as (...args: unknown[]) => void;
      if (typeof options === 'function') {
        cb = options as (...args: unknown[]) => void;
        opts = {};
      }
      const wantsAll = typeof opts === 'object' && opts !== null && opts.all === true;
      (origLookup as (h: string, o: unknown, c: (...a: unknown[]) => void) => void)(hostname, opts, (err, address, family) => {
        const code = (err as NodeJS.ErrnoException | null)?.code;
        if (err && (code === 'ENOTFOUND' || code === 'EREFUSED')) {
          publicResolver.resolve4(hostname, (err2, addresses) => {
            if (!err2 && addresses?.length) {
              return wantsAll
                ? cb(null, addresses.map((a) => ({ address: a, family: 4 })))
                : cb(null, addresses[0], 4);
            }
            cb(err, address, family);
          });
        } else {
          cb(err, address, family);
        }
      });
    };
    dns.lookup = fallbackLookup as unknown as typeof dns.lookup;
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
