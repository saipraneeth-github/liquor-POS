// Tests drizzle/0025_db_optimization.sql with the REAL Drizzle migrator on in-memory PGlite:
//  A) database already at 0024 and holding data -> migrate applies ONLY 0025; data unchanged; indexes/constraints present
//  B) database at 0024 holding a row that violates a Phase 2 rule -> migration FAILS and ROLLS BACK completely (nothing half-applied)
//  C) empty database -> all 26 migrations apply
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { ROOT } from './lib.mjs';

const full = path.join(ROOT, 'drizzle');
// a copy of ./drizzle that stops at 0024 (journal trimmed) = "production before this release"
const upTo24 = fs.mkdtempSync(path.join(os.tmpdir(), 'drz24-'));
fs.cpSync(full, upTo24, { recursive: true });
const j = JSON.parse(fs.readFileSync(path.join(full, 'meta/_journal.json'), 'utf8'));
j.entries = j.entries.filter((e) => e.tag !== '0025_db_optimization');
fs.writeFileSync(path.join(upTo24, 'meta/_journal.json'), JSON.stringify(j));
fs.rmSync(path.join(upTo24, '0025_db_optimization.sql'), { force: true });

const seed = `
INSERT INTO syndicates (id,name) VALUES ('00000000-0000-0000-0000-0000000000a1','S');
INSERT INTO branches (id,syndicate_id,name,code) VALUES ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000a1','B','B1');
INSERT INTO users (id,branch_id,name,email,password_hash,role) VALUES ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000b1','u','u@x.test','x','cashier');
INSERT INTO categories (id,name,tax_rate) VALUES ('00000000-0000-0000-0000-0000000000d1','Whisky',18);
INSERT INTO products (id,category_id,name,brand,mrp) VALUES ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000d1','P','Br',100);
INSERT INTO stock (branch_id,product_id,quantity) VALUES ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000e1',10);
INSERT INTO bills (id,branch_id,cashier_id,bill_number,status,subtotal,tax_amount,total,payment_mode) VALUES ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1','B1-1','PAID',100,15.25,100,'CASH');
INSERT INTO bill_items (bill_id,product_id,quantity,unit_price,tax_rate,tax_amount,line_total) VALUES ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000e1',1,100,18,15.25,100);
INSERT INTO account_ledgers (id,branch_id,code,name,"group") VALUES ('00000000-0000-0000-0000-000000000a11','00000000-0000-0000-0000-0000000000b1','CASH','Cash','ASSET');
INSERT INTO journal_vouchers (id,branch_id,voucher_number,voucher_date,voucher_type,narration) VALUES ('00000000-0000-0000-0000-000000000b11','00000000-0000-0000-0000-0000000000b1','V1',current_date,'SALES','x');
INSERT INTO journal_lines (voucher_id,ledger_id,debit,credit) VALUES ('00000000-0000-0000-0000-000000000b11','00000000-0000-0000-0000-000000000a11',100,0);`;

const snap = async (db) => (await db.query(`SELECT (SELECT count(*) FROM bills)::int bills,(SELECT count(*) FROM bill_items)::int items,(SELECT count(*) FROM stock)::int stock,(SELECT count(*) FROM journal_lines)::int jl,
  md5((SELECT string_agg(t::text,'|' ORDER BY id) FROM bills t)) hb`)).rows[0];
const counts = async (db) => (await db.query(`SELECT (SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname LIKE 'idx\\_%')::int idx,
  (SELECT count(*) FROM pg_constraint WHERE connamespace='public'::regnamespace AND conname LIKE 'ck\\_%')::int checks,
  (SELECT count(*) FROM pg_constraint WHERE connamespace='public'::regnamespace AND NOT convalidated)::int not_valid,
  (SELECT count(*) FROM drizzle.__drizzle_migrations)::int migrations`)).rows[0];
const results = {};

// A) populated DB at 0024 -> apply 0025 with the real migrator
{
  const pg = new PGlite(); const db = drizzle(pg);
  await migrate(db, { migrationsFolder: upTo24 });
  await pg.exec(seed);
  const before = await snap(pg), c0 = await counts(pg);
  await migrate(db, { migrationsFolder: full });
  const after = await snap(pg), c1 = await counts(pg);
  results.A = { migrationsBefore: c0.migrations, migrationsAfter: c1.migrations, idxAfter: c1.idx, checksAfter: c1.checks, notValid: c1.not_valid,
    dataUnchanged: JSON.stringify(before) === JSON.stringify(after) };
  await migrate(db, { migrationsFolder: full }); // running it again must be a no-op
  results.A.rerunIsNoop = (await counts(pg)).migrations === c1.migrations;
  await pg.close();
}
// B) a row that violates a new rule -> whole migration must roll back
{
  const pg = new PGlite(); const db = drizzle(pg);
  await migrate(db, { migrationsFolder: upTo24 });
  await pg.exec(seed);
  await pg.exec(`UPDATE bills SET payment_mode = 'BITCOIN'`);
  const c0 = await counts(pg); let failed = false, msg = '';
  try { await migrate(db, { migrationsFolder: full }); } catch (e) { failed = true; msg = String(e.cause?.message || e.message).slice(0, 120); }
  const c1 = await counts(pg);
  results.B = { failedAsExpected: failed, reason: msg, nothingHalfApplied: c1.idx === c0.idx && c1.checks === c0.checks && c1.migrations === c0.migrations };
  await pg.close();
}
// D) the failure seen on Neon: products pointing at a deleted invoice -> migration succeeds, pointer backed up then cleared
{
  const pg = new PGlite(); const db = drizzle(pg);
  await migrate(db, { migrationsFolder: upTo24 });
  await pg.exec(seed);
  await pg.exec("UPDATE products SET last_invoice_id = '9f656362-a178-45c8-b6c1-1fccd3f66e87', last_invoice_number = 'INV-9', last_invoice_date = now()");
  await migrate(db, { migrationsFolder: full });
  const p = (await pg.query('SELECT last_invoice_id, last_invoice_number FROM products')).rows[0];
  const b = (await pg.query('SELECT last_invoice_id, last_invoice_number FROM products_last_invoice_orphans_backup')).rows;
  const c = await counts(pg);
  results.D = { pointerCleared: p.last_invoice_id === null, numberKept: p.last_invoice_number === 'INV-9', backedUp: b.length === 1 && b[0].last_invoice_id === '9f656362-a178-45c8-b6c1-1fccd3f66e87', migrated: c.migrations === 26, notValid: c.not_valid };
  await pg.close();
}
// C) empty DB -> all migrations
{
  const pg = new PGlite(); const db = drizzle(pg);
  await migrate(db, { migrationsFolder: full });
  results.C = await counts(pg);
  await pg.close();
}
console.log(JSON.stringify(results, null, 2));
const ok = results.A.migrationsBefore === 25 && results.A.migrationsAfter === 26 && results.A.idxAfter >= 41 && results.A.checksAfter === 11 && results.A.notValid === 0
  && results.A.dataUnchanged && results.A.rerunIsNoop && results.B.failedAsExpected && results.B.nothingHalfApplied && results.C.migrations === 26
  && results.D.pointerCleared && results.D.numberKept && results.D.backedUp && results.D.migrated && results.D.notValid === 0;
console.log(ok ? 'MIGRATION 0025 TEST PASSED' : 'MIGRATION 0025 TEST FAILED');
process.exit(ok ? 0 : 1);
