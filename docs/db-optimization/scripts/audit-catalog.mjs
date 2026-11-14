// Read-only catalog audit of the schema produced by the migrations (scratch PGlite).
import { createMigratedDb } from './lib.mjs';
const db = await createMigratedDb();
const q = async (title, sql) => { const r = await db.query(sql); console.log(`\n## ${title} (${r.rows.length})`); console.table(r.rows); };

await q('Tables / columns', `select table_name, count(*) cols from information_schema.columns where table_schema='public' group by 1 order by 2 desc limit 12`);
console.log((await db.query(`select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'`)).rows);

await q('FOREIGN KEYS WITHOUT A COVERING INDEX (first column of some index)', `
with fk as (
  select c.conrelid, c.conname, c.confrelid::regclass::text as refs, c.conkey[1] as attnum, c.confdeltype
  from pg_constraint c join pg_namespace n on n.oid=c.connamespace where c.contype='f' and n.nspname='public')
select fk.conrelid::regclass::text as tbl, a.attname as col, fk.refs, case fk.confdeltype when 'c' then 'CASCADE' when 'n' then 'SET NULL' else 'NO ACTION' end as on_delete
from fk join pg_attribute a on a.attrelid=fk.conrelid and a.attnum=fk.attnum
where not exists (select 1 from pg_index i where i.indrelid=fk.conrelid and i.indkey[0]=fk.attnum and i.indpred is null)
order by 1,2`);

await q('Indexes whose columns are a strict prefix of another index on the same table (redundant candidates)', `
select a.indrelid::regclass::text tbl, a.indexrelid::regclass::text redundant, b.indexrelid::regclass::text covered_by
from pg_index a join pg_index b on a.indrelid=b.indrelid and a.indexrelid<>b.indexrelid
where a.indpred is null and b.indpred is null and a.indexprs is null and b.indexprs is null
  and not a.indisunique and a.indnatts < b.indnatts
  and (string_to_array(a.indkey::text,' '))[1:a.indnatts] = (string_to_array(b.indkey::text,' '))[1:a.indnatts]
order by 1`);

await q('Indexes per table (non-PK)', `select tablename, count(*) n from pg_indexes where schemaname='public' and indexname not like '%_pkey' group by 1 order by 2 desc limit 15`);
await q('Tables with NO secondary index at all', `
select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relkind='r' and not exists (select 1 from pg_index i where i.indrelid=c.oid and not i.indisprimary) order by 1`);
await q('numeric columns without precision', `select table_name, column_name from information_schema.columns where table_schema='public' and data_type='numeric' and numeric_precision is null`);
await q('timestamp WITHOUT time zone columns', `select table_name, column_name from information_schema.columns where table_schema='public' and data_type='timestamp without time zone'`);
await q('Text status/flag columns that behave like enums (no CHECK, no enum)', `
select table_name, column_name from information_schema.columns where table_schema='public' and data_type='text'
 and column_name in ('status','source','scope','kind','side','action','direction','reason','target','provider','payment_mode','recon_status','match_status','match_method','level','plan','target_type')
order by 1,2`);
await q('CHECK constraints present', `select conrelid::regclass::text tbl, conname from pg_constraint where contype='c' and connamespace='public'::regnamespace`);
// ── drift: schema.ts vs what the migrations really create ──
import fs from 'node:fs'; import path from 'node:path'; import { ROOT } from './lib.mjs';
const schemaSrc = fs.readFileSync(path.join(ROOT, 'src/db/schema.ts'), 'utf8');
const declared = {};
for (const m of schemaSrc.matchAll(/export const \w+ = pgTable\('(\w+)', \{([\s\S]*?)\n\}(?:, \(|\);)/g))
  declared[m[1]] = [...m[2].matchAll(/^\s{2}\w+:\s+[\w.]+\('(\w+)'/gm)].map((x) => x[1]);
const real = {};
for (const r of (await db.query(`select table_name t, column_name c from information_schema.columns where table_schema='public'`)).rows) (real[r.t] ||= []).push(r.c);
const drift = [];
for (const t of new Set([...Object.keys(declared), ...Object.keys(real)])) {
  if (t.startsWith('__')) continue;
  const d = new Set(declared[t] || []), r = new Set(real[t] || []);
  for (const c of d) if (!r.has(c)) drift.push({ table: t, column: c, problem: 'in schema.ts, NOT in migrations' });
  for (const c of r) if (!d.has(c)) drift.push({ table: t, column: c, problem: 'in migrations, NOT in schema.ts' });
}
console.log('\n## Drift between schema.ts and migrations (' + drift.length + ')'); console.table(drift);
await db.close();
