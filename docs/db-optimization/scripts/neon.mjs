// Runs the db-optimization scripts against the database in .env (Neon) on a DIRECT (non-pooled) connection.
//   node docs/db-optimization/scripts/neon.mjs preflight          read-only: migration level, size, pre-check, invariants, fingerprint
//   node docs/db-optimization/scripts/neon.mjs phase1             001 indexes, one statement at a time, CONCURRENTLY
//   node docs/db-optimization/scripts/neon.mjs phase2             002 constraints (NOT VALID, then VALIDATE)
//   node docs/db-optimization/scripts/neon.mjs verify             post-checks: invalid indexes, T01/T02/T03
//   node docs/db-optimization/scripts/neon.mjs rollback           002 down, then 001 down (concurrently)
// The connection string is read from .env and never printed.
import fs from 'node:fs'; import path from 'node:path';
import dns from 'node:dns';
import postgres from 'postgres';

// Same fallback as src/db/client.ts: system resolver first, public resolvers only if it fails (some ISPs refuse *.neon.tech).
{
  const pub = new dns.Resolver(); pub.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
  const orig = dns.lookup;
  dns.lookup = (host, options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    orig(host, options, (err, addr, fam) => {
      if (!err) return cb(err, addr, fam);
      pub.resolve4(host, (e2, addrs) => {
        if (e2 || !addrs?.length) return cb(err);
        if (options?.all) return cb(null, addrs.map((a) => ({ address: a, family: 4 })));
        cb(null, addrs[0], 4);
      });
    });
  };
}
import { ROOT } from './lib.mjs';

const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
let url = (env.match(/^DATABASE_URL=(.+)$/m) || [])[1]?.trim();
if (!url || !url.startsWith('postgres')) throw new Error('DATABASE_URL in .env is not a postgres URL');
url = url.replace('-pooler.', '.'); // Neon: the direct endpoint (CONCURRENTLY cannot run through the pooler)
const sql = postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 30, onnotice: () => {} });
const read = (f) => fs.readFileSync(path.join(ROOT, 'docs/db-optimization/sql', f), 'utf8');
const stmts = (text) => text.split(/;\s*\n/).map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean);
const run = async (text) => { for (const s of stmts(text)) await sql.unsafe(s); return stmts(text).length; };
// a file with a DO $ ... $ block must go to the server whole (a naive split on ';' would cut it in half)
const rows = async (text) => { if (text.includes('$')) { const r = await sql.unsafe(text); return Array.isArray(r) && Array.isArray(r[0]) ? r[r.length - 1] : r; } let last = []; for (const s of stmts(text)) last = await sql.unsafe(s); return last; };
const cmd = process.argv[2];

try {
  const who = (await sql`select current_database() db, version() v`)[0];
  console.log('connected:', who.db, '|', who.v.split(',')[0]);

  if (cmd === 'preflight') {
    const m = await sql`select count(*)::int n from drizzle.__drizzle_migrations`.catch((e) => [{ n: 'ERR ' + e.message }]);
    console.log('applied migrations:', m[0].n, '(repo has 25)');
    console.log('database size:', (await sql`select pg_size_pretty(pg_database_size(current_database())) s`)[0].s);
    console.log('tables:', (await sql`select count(*)::int n from information_schema.tables where table_schema='public' and table_type='BASE TABLE'`)[0].n);
    const big = await sql`select relname, n_live_tup::int n from pg_stat_user_tables order by n_live_tup desc limit 8`;
    console.log('largest tables (est. rows):', big.map((r) => `${r.relname}=${r.n}`).join(', '));
    console.log('existing non-PK indexes:', (await sql`select count(*)::int n from pg_indexes where schemaname='public' and indexname not like '%\_pkey'`)[0].n);
    console.log('\n-- Phase 2 pre-check (must be empty):'); console.table(await rows(read('002_integrity_precheck.sql')));
    console.log('-- invariants (violations must be 0):'); console.table(await rows(read('tests/t02_business_invariants.sql')));
    console.log('-- fingerprint:'); console.table(await rows(read('tests/t01_fingerprint.sql')));
    console.log('-- catalog snapshot:'); console.table(await rows(read('tests/t04_catalog_snapshot.sql')));
  } else if (cmd === 'phase1') {
    const t = Date.now(); let n = 0;
    for (const s of stmts(read('001_indexes_up_concurrent.sql'))) { await sql.unsafe(s); n++; }
    console.log(`phase 1: ${n} index statements OK in ${((Date.now() - t) / 1000).toFixed(1)}s`);
    console.log('invalid indexes:', (await sql`select indexrelid::regclass::text i from pg_index where not indisvalid`).map((r) => r.i));
    await sql.unsafe('ANALYZE');
  } else if (cmd === 'phase2') {
    const text = read('002_integrity_up.sql');
    const n = await run(text);
    console.log(`phase 2: ${n} statements OK`);
  } else if (cmd === 'verify') {
    console.log('invalid indexes:', (await sql`select indexrelid::regclass::text i from pg_index where not indisvalid`).map((r) => r.i));
    console.log('-- T03 referential integrity (must be empty):'); console.table(await rows(read('tests/t03_referential_integrity.sql')));
    console.log('-- T02 invariants:'); console.table(await rows(read('tests/t02_business_invariants.sql')));
    console.log('-- T01 fingerprint:'); console.table(await rows(read('tests/t01_fingerprint.sql')));
    console.log('-- catalog:'); console.table(await rows(read('tests/t04_catalog_snapshot.sql')));
  } else if (cmd === 'rollback') {
    await run(read('002_integrity_down.sql'));
    for (const s of stmts(read('001_indexes_down_concurrent.sql'))) await sql.unsafe(s);
    console.log('rolled back');
  } else throw new Error('unknown command');
} finally {
  await sql.end({ timeout: 5 });
}
