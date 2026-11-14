// Prints the headline inventory numbers quoted in 01-schema-audit.md.
import { createMigratedDb } from './lib.mjs';
const db = await createMigratedDb();
const one = async (s) => (await db.query(s)).rows[0];
console.log('tables      ', (await one(`select count(*) n from information_schema.tables where table_schema='public' and table_type='BASE TABLE'`)).n);
console.log('enums       ', (await one(`select count(*) n from pg_type where typtype='e' and typnamespace='public'::regnamespace`)).n);
console.log('FKs (total) ', (await one(`select count(*) n from pg_constraint where contype='f' and connamespace='public'::regnamespace`)).n);
console.log('FKs multicol', (await one(`select count(*) n from pg_constraint where contype='f' and connamespace='public'::regnamespace and array_length(conkey,1)>1`)).n);
console.log('PKs         ', (await one(`select count(*) n from pg_constraint where contype='p' and connamespace='public'::regnamespace`)).n);
console.log('tables w/o PK', (await db.query(`select c.relname from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='r' and not exists (select 1 from pg_constraint k where k.conrelid=c.oid and k.contype='p')`)).rows.map(r=>r.relname).join(','));
console.log('composite PK', (await db.query(`select conrelid::regclass::text t from pg_constraint where contype='p' and connamespace='public'::regnamespace and array_length(conkey,1)>1`)).rows.map(r=>r.t).join(','));
console.log('non-uuid PK ', (await db.query(`select c.conrelid::regclass::text t from pg_constraint c join pg_attribute a on a.attrelid=c.conrelid and a.attnum=c.conkey[1] where c.contype='p' and c.connamespace='public'::regnamespace and array_length(c.conkey,1)=1 and a.atttypid<>'uuid'::regtype`)).rows.map(r=>r.t).join(','));
const idx = await db.query(`select count(*) filter (where indexdef like '%UNIQUE%') u, count(*) filter (where indexdef not like '%UNIQUE%') nu from pg_indexes where schemaname='public' and indexname not like '%\_pkey'`);
console.log('secondary idx (unique / non-unique)', idx.rows[0]);
await db.close();
