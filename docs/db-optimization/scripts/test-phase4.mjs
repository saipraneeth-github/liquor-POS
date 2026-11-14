// Proves Phase 4 loses no data: live + archive row counts and content hash are identical before, after UP, and after DOWN.
import fs from 'node:fs'; import path from 'node:path';
import { createMigratedDb, ROOT } from './lib.mjs';
const sql = (f) => fs.readFileSync(path.join(ROOT, 'docs/db-optimization/sql', f), 'utf8');
const db = await createMigratedDb();
await db.exec(`
INSERT INTO email_outbox (to_email, subject, body, created_at) SELECT 'a@x.test','s'||g,'b', now() - (g||' days')::interval FROM generate_series(1,200) g;
INSERT INTO syndicates (id,name) VALUES ('00000000-0000-0000-0000-0000000000a1','S');
INSERT INTO branches (id,syndicate_id,name,code) VALUES ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000a1','B','B1');
INSERT INTO print_jobs (branch_id, kind, ref_id, status, created_at)
  SELECT '00000000-0000-0000-0000-0000000000b1','bill',gen_random_uuid(),(ARRAY['SENT','PENDING','FAILED'])[1+g%3], now() - (g||' days')::interval FROM generate_series(1,150) g;
INSERT INTO users (name,email,password_hash,role) VALUES ('u','u@x.test','x','owner');
INSERT INTO password_resets (user_id, token_hash, expires_at, used_at, created_at)
  SELECT (SELECT id FROM users LIMIT 1),'t'||g, now() + (CASE WHEN g%2=0 THEN '-' ELSE '' END || (g%5+1) || ' days')::interval, CASE WHEN g%3=0 THEN now() END, now() - (g||' days')::interval FROM generate_series(1,100) g;`);
const snap = async (withArchive) => (await db.query(`
  SELECT (SELECT count(*) FROM email_outbox)::int eo, (SELECT count(*) FROM print_jobs)::int pj, (SELECT count(*) FROM password_resets)::int pr,
         ${withArchive ? `(SELECT count(*) FROM email_outbox_archive)::int eoa, (SELECT count(*) FROM print_jobs_archive)::int pja, (SELECT count(*) FROM password_resets_archive)::int pra,` : '0 eoa, 0 pja, 0 pra,'}
         md5((SELECT string_agg(t::text,'|' ORDER BY id) FROM (SELECT * FROM email_outbox ${withArchive ? 'UNION ALL SELECT * FROM email_outbox_archive' : ''}) t)) h1,
         md5((SELECT string_agg(t::text,'|' ORDER BY id) FROM (SELECT * FROM print_jobs ${withArchive ? 'UNION ALL SELECT * FROM print_jobs_archive' : ''}) t)) h2,
         md5((SELECT string_agg(t::text,'|' ORDER BY id) FROM (SELECT * FROM password_resets ${withArchive ? 'UNION ALL SELECT * FROM password_resets_archive' : ''}) t)) h3`)).rows[0];
const before = await snap(false);
await db.exec(sql('004_retention_archive_up.sql'));
const mid = await snap(true);
const pendingKept = (await db.query(`SELECT count(*)::int n FROM print_jobs WHERE status <> 'SENT'`)).rows[0].n;
await db.exec(sql('004_retention_archive_down.sql'));
const tablesLeft = (await db.query(`SELECT count(*)::int n FROM pg_tables WHERE tablename LIKE '%\\_archive'`)).rows[0].n;
const after = await snap(false);
const sum = (s) => [s.eo + s.eoa, s.pj + s.pja, s.pr + s.pra];
const checks = {
  'rows moved by UP (email/print/reset)': [mid.eoa, mid.pja, mid.pra],
  'live+archive count unchanged after UP': JSON.stringify(sum(before)) === JSON.stringify(sum(mid)),
  'content hash unchanged after UP (live+archive)': before.h1 === mid.h1 && before.h2 === mid.h2 && before.h3 === mid.h3,
  'PENDING/FAILED print jobs all still live': pendingKept === 100,
  'DOWN restores exact content': before.h1 === after.h1 && before.h2 === after.h2 && before.h3 === after.h3 && JSON.stringify(sum(before)) === JSON.stringify(sum(after)),
  'archive tables removed by DOWN': tablesLeft === 0,
};
console.log(checks);
if (Object.values(checks).some((v) => v === false)) { console.error('PHASE 4 TEST FAILED'); process.exit(1); }
console.log('PHASE 4 TEST PASSED');
await db.close();
