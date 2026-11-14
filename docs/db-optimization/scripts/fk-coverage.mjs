// How many foreign keys lack a covering index before / after Phase 1, and which ones stay unindexed (by category).
import fs from 'node:fs'; import path from 'node:path';
import { createMigratedDb, ROOT } from './lib.mjs';
const db = await createMigratedDb();
const missing = async () => (await db.query(`
  select c.conrelid::regclass::text tbl, a.attname col from pg_constraint c
  join pg_attribute a on a.attrelid=c.conrelid and a.attnum=c.conkey[1]
  where c.contype='f' and c.connamespace='public'::regnamespace
    and not exists (select 1 from pg_index i where i.indrelid=c.conrelid and i.indkey[0]=c.conkey[1] and (i.indpred is null or pg_get_expr(i.indpred,i.indrelid) like '%IS NOT NULL%'))
  order by 1,2`)).rows;
const before = await missing();
await db.exec(fs.readFileSync(path.join(ROOT, 'docs/db-optimization/sql/001_indexes_up.sql'), 'utf8'));
const after = await missing();
const audit = (c) => /_by_id$|^actor_id$|^approved_by|^opening_edited|^adjustment_approved/.test(c);
const groups = { audit: after.filter((r) => audit(r.col)), other: after.filter((r) => !audit(r.col)) };
console.log(`FKs without a covering index: before ${before.length}, after Phase 1 ${after.length}`);
console.log(`remaining "who did it" audit pointers: ${groups.audit.length}`);
console.log(`remaining other FKs (${groups.other.length}):`); console.table(groups.other);
await db.close();
