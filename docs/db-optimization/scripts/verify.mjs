// End-to-end verification of the proposed phases on a THROWAWAY in-memory PGlite database.
//   node docs/db-optimization/scripts/verify.mjs [scale]     (scale = bills per branch, default 40000)
// It never reads DATABASE_URL and never opens a network connection. Output: results/verification-results.{json,md}
import fs from 'node:fs';
import path from 'node:path';
import { createMigratedDb, ROOT } from './lib.mjs';

const SCALE = Number(process.argv[2] || 40000);
const DOC = path.join(ROOT, 'docs/db-optimization');
const sqlOf = (f) => fs.readFileSync(path.join(DOC, 'sql', f), 'utf8');
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);

const db = await createMigratedDb();
const lastRows = async (sql) => { const r = await db.exec(sql); return r[r.length - 1].rows; };
const R = { scale: SCALE, phases: {}, bench: [], tests: {} };

// ── 1. synthetic data (3 branches, one year of trading, realistic child-row ratios) ────────────
log('seeding…');
await db.exec(`
INSERT INTO syndicates (id, name) VALUES ('00000000-0000-0000-0000-0000000000a1', 'Bench Syndicate');
INSERT INTO branches (id, syndicate_id, name, code) SELECT gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1', 'Branch '||g, 'B'||g FROM generate_series(1,3) g;
INSERT INTO categories (name, tax_rate) VALUES ('Whisky',18),('Beer',18),('Wine',18);
INSERT INTO users (branch_id, name, email, password_hash, role) SELECT id, 'Cashier '||code, 'c'||code||'@x.test', 'x', 'cashier' FROM branches;
INSERT INTO products (category_id, name, brand, mrp, barcode, sku, syndicate_id)
  SELECT (SELECT id FROM categories ORDER BY name OFFSET (g % 3) LIMIT 1), 'Product '||g, 'Brand '||(g % 40), 100 + (g % 50) * 10, 'BC'||g, 'SK'||g, '00000000-0000-0000-0000-0000000000a1' FROM generate_series(1,600) g;
INSERT INTO stock (branch_id, product_id, quantity) SELECT b.id, p.id, 50 + (random()*400)::int FROM branches b CROSS JOIN products p;
INSERT INTO terminals (branch_id, terminal_name, device_key) SELECT id, 'T1', 'dev-'||code FROM branches;
INSERT INTO shift_sessions (branch_id, terminal_id, cashier_id, status, opened_at, closed_at)
  SELECT b.id, t.id, u.id, 'CLOSED', now() - (g||' hours')::interval * 8, now() - (g||' hours')::interval * 8 + interval '7 hours'
  FROM branches b JOIN terminals t ON t.branch_id=b.id JOIN users u ON u.branch_id=b.id, generate_series(1,${Math.max(100, Math.floor(SCALE / 400))}) g;
INSERT INTO customers (branch_id, name, phone, credit_allowed, credit_limit) SELECT b.id, 'Cust '||g, '9'||lpad((row_number() over ())::text, 9, '0'), true, 50000 FROM branches b, generate_series(1,200) g;
INSERT INTO account_ledgers (branch_id, code, name, "group") SELECT b.id, c.code, c.code, c.grp::ledger_group FROM branches b,
  (VALUES ('CASH','ASSET'),('SALES','INCOME'),('OUTPUT_GST','LIABILITY'),('BANK','ASSET')) c(code, grp);
`);

await db.exec(`
CREATE TEMP TABLE _prod AS SELECT id, row_number() over (order by id) rn FROM products;
CREATE TEMP TABLE _shift AS SELECT id, branch_id, row_number() over (partition by branch_id order by id) rn, count(*) over (partition by branch_id) cnt FROM shift_sessions;
CREATE TEMP TABLE _cust AS SELECT id, branch_id, row_number() over (partition by branch_id order by id) rn FROM customers;
INSERT INTO bills (branch_id, cashier_id, bill_number, status, subtotal, tax_amount, total, payment_mode, customer_id, shift_session_id, created_at, paid_at)
SELECT b.id, u.id, b.code||'-'||i, 'PAID', 0, 0, 0,
       (ARRAY['CASH','CASH','CARD','UPI','CREDIT'])[1 + i % 5],
       CASE WHEN i % 5 = 4 THEN (SELECT id FROM _cust c WHERE c.branch_id=b.id AND c.rn = 1 + i % 200) END,
       (SELECT id FROM _shift s WHERE s.branch_id=b.id AND s.rn = 1 + i % s.cnt),
       now() - (i::numeric / ${SCALE} * interval '365 days'), now() - (i::numeric / ${SCALE} * interval '365 days')
FROM branches b JOIN users u ON u.branch_id=b.id, generate_series(1,${SCALE}) i;
`);
log('bills done');
await db.exec(`
INSERT INTO bill_items (bill_id, product_id, quantity, unit_price, tax_rate, tax_amount, line_total)
SELECT bl.id, p.id, q, p_mrp, 18, round((q*p_mrp) - (q*p_mrp)/1.18, 2), q*p_mrp
FROM (SELECT id, row_number() over (order by id) n FROM bills) bl
CROSS JOIN LATERAL generate_series(1, 1 + (bl.n % 4)::int) k
CROSS JOIN LATERAL (SELECT 1 + ((bl.n * 7 + k * 13) % 3) AS q) qq
JOIN _prod p ON p.rn = 1 + ((bl.n * 31 + k * 17) % 600)
CROSS JOIN LATERAL (SELECT 100 + (p.rn % 50) * 10 AS p_mrp) pm;
UPDATE bills b SET subtotal = s.t, total = s.t, tax_amount = round(s.t - s.t/1.18, 2)
  FROM (SELECT bill_id, sum(line_total) t FROM bill_items GROUP BY 1) s WHERE s.bill_id = b.id;
INSERT INTO stock_audit (branch_id, product_id, change_qty, reason, reference_id, created_at)
SELECT b.branch_id, i.product_id, -i.quantity, 'SALE', b.id, b.created_at FROM bill_items i JOIN bills b ON b.id = i.bill_id;
`);
log('items + stock audit done');
await db.exec(`
INSERT INTO journal_vouchers (branch_id, voucher_number, voucher_date, voucher_type, narration, source_type, source_id, created_at)
SELECT branch_id, 'V-'||bill_number, created_at::date, 'SALES', 'Bill '||bill_number, 'BILL', id, created_at FROM bills;
CREATE TEMP TABLE _led AS SELECT branch_id, code, id FROM account_ledgers;
INSERT INTO journal_lines (voucher_id, ledger_id, debit, credit)
SELECT v.id, lc.id, b.total, 0 FROM journal_vouchers v JOIN bills b ON b.id=v.source_id JOIN _led lc ON lc.branch_id=v.branch_id AND lc.code='CASH'
UNION ALL SELECT v.id, ls.id, 0, round(b.total/1.18, 2) FROM journal_vouchers v JOIN bills b ON b.id=v.source_id JOIN _led ls ON ls.branch_id=v.branch_id AND ls.code='SALES'
UNION ALL SELECT v.id, lg.id, 0, b.total - round(b.total/1.18, 2) FROM journal_vouchers v JOIN bills b ON b.id=v.source_id JOIN _led lg ON lg.branch_id=v.branch_id AND lg.code='OUTPUT_GST';
`);
log('journal done');
await db.exec(`
INSERT INTO credit_transactions (customer_id, type, amount, balance_after, recorded_by_id, recorded_at)
SELECT c.id, 'PURCHASE', 100, 100 * g, (SELECT id FROM users LIMIT 1), now() - ((30 - g) || ' days')::interval FROM customers c, generate_series(1,20) g;
UPDATE customers SET current_credit = 2000;
INSERT INTO tables (branch_id, name) SELECT b.id, 'T'||g FROM branches b, generate_series(1,40) g;
`);
await db.exec(`
INSERT INTO table_sessions (table_id, branch_id, opened_at, closed_at)
SELECT t.id, t.branch_id, now() - (g || ' hours')::interval, now() - (g || ' hours')::interval + interval '1 hour' FROM tables t, generate_series(1, ${Math.max(50, Math.floor(SCALE / 40))}) g;
INSERT INTO kot_orders (table_session_id, branch_id, created_by_id, created_at) SELECT s.id, s.branch_id, (SELECT id FROM users LIMIT 1), s.opened_at FROM table_sessions s;
INSERT INTO kot_items (kot_order_id, product_id, quantity, unit_price, tax_rate) SELECT o.id, (SELECT id FROM products LIMIT 1), 1 + g % 3, 200, 18 FROM kot_orders o, generate_series(1,3) g;
INSERT INTO supplier_invoices (branch_id, created_by_id, supplier_name, invoice_number, total_amount, created_at)
SELECT b.id, (SELECT id FROM users LIMIT 1), 'Supplier '||(g % 5), 'INV-'||g, 10000 + g, now() - (g || ' hours')::interval FROM branches b, generate_series(1, ${Math.max(200, Math.floor(SCALE / 20))}) g;
INSERT INTO supplier_invoice_items (invoice_id, raw_description, quantity, cost_price, mrp, line_cost_total)
SELECT i.id, 'Item '||g, 12, 100, 150, 1200 FROM supplier_invoices i, generate_series(1,6) g;
INSERT INTO audit_log (actor_id, action, target_type, target_id, created_at) SELECT (SELECT id FROM users LIMIT 1), 'bench.event', 'tenant', 'x', now() - (g || ' minutes')::interval FROM generate_series(1,${Math.max(5000, SCALE)}) g;
INSERT INTO print_jobs (branch_id, kind, ref_id, status, target, next_attempt_at) SELECT (SELECT id FROM branches LIMIT 1), 'bill', gen_random_uuid(), 'SENT', 'NETWORK', now() FROM generate_series(1,${Math.max(5000, SCALE)});
INSERT INTO print_jobs (branch_id, kind, ref_id, status, target, next_attempt_at) SELECT (SELECT id FROM branches LIMIT 1), 'bill', gen_random_uuid(), 'PENDING', 'NETWORK', now() - interval '1 minute' FROM generate_series(1,5);
INSERT INTO bank_accounts (branch_id, name) SELECT id, 'Main' FROM branches LIMIT 1;
INSERT INTO bank_statements (account_id, file_hash, source) SELECT id, 'h1', 'CSV' FROM bank_accounts;
INSERT INTO bank_statement_lines (statement_id, account_id, line_no, txn_date, hash) SELECT s.id, s.account_id, g, current_date, 'h'||g FROM bank_statements s, generate_series(1,10) g;
`);
await db.exec('ANALYZE');
const counts = await lastRows(`SELECT 'bills' t, count(*)::int n FROM bills UNION ALL SELECT 'bill_items', count(*) FROM bill_items UNION ALL SELECT 'stock_audit', count(*) FROM stock_audit UNION ALL SELECT 'journal_lines', count(*) FROM journal_lines UNION ALL SELECT 'journal_vouchers', count(*) FROM journal_vouchers UNION ALL SELECT 'audit_log', count(*) FROM audit_log UNION ALL SELECT 'kot_items', count(*) FROM kot_items`);
R.rowCounts = Object.fromEntries(counts.map((r) => [r.t, r.n]));
log('seed complete', R.rowCounts);

// ── 2. parameters for the benchmark queries ──────────────────────────────────────────────────
const one = async (sql) => (await db.query(sql)).rows[0];
const P = {
  branch: (await one(`SELECT id FROM branches ORDER BY code LIMIT 1`)).id,
  bill: (await one(`SELECT id FROM bills ORDER BY created_at OFFSET ${Math.floor(SCALE / 3)} LIMIT 1`)).id,
  shift: (await one(`SELECT id FROM shift_sessions ORDER BY id LIMIT 1`)).id,
  product: (await one(`SELECT product_id id FROM stock_audit GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`)).id,
  voucher: (await one(`SELECT id FROM journal_vouchers OFFSET ${Math.floor(SCALE / 2)} LIMIT 1`)).id,
  order: (await one(`SELECT id FROM kot_orders LIMIT 1 OFFSET 100`)).id,
  table: (await one(`SELECT id FROM tables LIMIT 1`)).id,
  customer: (await one(`SELECT id FROM customers LIMIT 1`)).id,
  invoice: (await one(`SELECT id FROM supplier_invoices LIMIT 1 OFFSET 50`)).id,
};
const B = P.branch;
const QUERIES = [
  ['Q01 POS: today\'s bills, newest first (GET /bills)',        `SELECT * FROM bills WHERE branch_id='${B}' AND created_at >= now() - interval '2 days' ORDER BY created_at DESC, id LIMIT 50`],
  ['Q02 Closing: one day\'s sales by payment mode',            `SELECT payment_mode, count(*), sum(total) FROM bills WHERE branch_id='${B}' AND status='PAID' AND created_at >= now() - interval '40 days' AND created_at < now() - interval '39 days' GROUP BY 1`],
  ['Q03 Bill detail / void / receipt: lines of one bill',      `SELECT * FROM bill_items WHERE bill_id='${P.bill}'`],
  ['Q04 Dashboard: top sellers, last 7 days',                  `SELECT bi.product_id, sum(bi.quantity) q FROM bill_items bi JOIN bills b ON b.id = bi.bill_id WHERE b.branch_id='${B}' AND b.created_at >= now() - interval '7 days' GROUP BY 1 ORDER BY 2 DESC LIMIT 10`],
  ['Q05 Shift close: totals of one shift',                     `SELECT payment_mode, sum(total) FROM bills WHERE shift_session_id='${P.shift}' GROUP BY 1`],
  ['Q06 Stock audit of one product',                           `SELECT * FROM stock_audit WHERE branch_id='${B}' AND product_id='${P.product}' ORDER BY created_at DESC, id LIMIT 100`],
  ['Q07 Counter sheet: movements it wrote (by reference)',     `SELECT * FROM stock_audit WHERE reference_id='${P.bill}'`],
  ['Q08 Trial balance: one month',                             `SELECT l.ledger_id, sum(l.debit), sum(l.credit) FROM journal_lines l JOIN journal_vouchers v ON v.id = l.voucher_id WHERE v.branch_id='${B}' AND v.voucher_date >= current_date - 60 AND v.voucher_date < current_date - 30 GROUP BY 1`],
  ['Q09 Voucher detail: lines of one voucher',                 `SELECT * FROM journal_lines WHERE voucher_id='${P.voucher}'`],
  ['Q10 Ledger entries: one ledger over a month',              `SELECT l.* FROM journal_lines l JOIN journal_vouchers v ON v.id = l.voucher_id WHERE l.ledger_id = (SELECT id FROM account_ledgers WHERE branch_id='${B}' AND code='CASH') AND v.voucher_date >= current_date - 30`],
  ['Q11 KOT: items of one order',                              `SELECT * FROM kot_items WHERE kot_order_id='${P.order}'`],
  ['Q12 Tables: open session of a table',                      `SELECT * FROM table_sessions WHERE table_id='${P.table}' AND closed_at IS NULL`],
  ['Q13 Khata: customer statement',                            `SELECT * FROM credit_transactions WHERE customer_id='${P.customer}' ORDER BY recorded_at DESC, id LIMIT 50`],
  ['Q14 Supplier invoice: its lines',                          `SELECT * FROM supplier_invoice_items WHERE invoice_id='${P.invoice}'`],
  ['Q15 Supplier invoices list, newest first',                 `SELECT * FROM supplier_invoices WHERE branch_id='${B}' ORDER BY created_at DESC, id LIMIT 50`],
  ['Q16 Print queue: pending network jobs',                    `SELECT * FROM print_jobs WHERE status='PENDING' AND target='NETWORK' AND next_attempt_at <= now()`],
  ['Q17 Platform audit log, newest 100',                       `SELECT * FROM audit_log ORDER BY created_at DESC, id LIMIT 100`],
  ['Q18 Khata: credit bills of a customer',                    `SELECT * FROM bills WHERE customer_id=(SELECT customer_id FROM bills WHERE customer_id IS NOT NULL ORDER BY customer_id LIMIT 1)`],
];
const scans = (node, acc = []) => { if (node['Node Type']?.includes('Scan')) acc.push(`${node['Node Type'].replace(' Scan', '')}${node['Index Name'] ? ':' + node['Index Name'] : node['Relation Name'] ? ':' + node['Relation Name'] : ''}`); (node.Plans || []).forEach((p) => scans(p, acc)); return acc; };
async function bench(sql, runs = 7) {
  const times = []; let plan, buffers = 0;
  for (let i = 0; i < runs; i++) {
    const r = await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`);
    const j = r.rows[0]['QUERY PLAN'][0]; times.push(j['Execution Time']); plan = j.Plan;
    const sumBuf = (n) => (n['Shared Hit Blocks'] || 0) + (n['Shared Read Blocks'] || 0);
    buffers = sumBuf(j.Plan);
  }
  times.sort((a, b) => a - b);
  return { ms: times[Math.floor(times.length / 2)], buffers, scans: [...new Set(scans(plan))] };
}
async function resultHash(sql) { return (await db.query(`SELECT count(*)::int n, md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) h FROM (${sql}) t`)).rows[0]; }
async function runBench(label) {
  log('benchmark', label);
  const out = {};
  for (const [name, sql] of QUERIES) { out[name] = await bench(sql); out[name].result = await resultHash(sql); }
  return out;
}
async function writeBench() { // cost of the extra indexes on the write path: insert 5,000 bills + lines, then roll back
  const times = [];
  for (let i = 0; i < 3; i++) {
    const s = performance.now();
    await db.exec(`BEGIN;
      INSERT INTO bills (branch_id, cashier_id, bill_number, status, subtotal, tax_amount, total, payment_mode, created_at)
        SELECT '${B}', (SELECT id FROM users LIMIT 1), 'W'||g||'-${i}', 'PAID', 100, 15, 100, 'CASH', now() FROM generate_series(1,5000) g;
      INSERT INTO bill_items (bill_id, product_id, quantity, unit_price, tax_rate, tax_amount, line_total)
        SELECT b.id, (SELECT id FROM products LIMIT 1), 1, 100, 18, 15, 100 FROM bills b WHERE b.bill_number LIKE 'W%-${i}';
      INSERT INTO stock_audit (branch_id, product_id, change_qty, reason, reference_id) SELECT '${B}', (SELECT id FROM products LIMIT 1), -1, 'SALE', gen_random_uuid() FROM generate_series(1,5000);
      ROLLBACK;`);
    times.push(performance.now() - s);
  }
  times.sort((a, b) => a - b);
  return times[1];
}
const sizes = async () => (await db.query(`SELECT pg_size_pretty(sum(pg_table_size(c.oid))) tables, pg_size_pretty(sum(pg_indexes_size(c.oid))) indexes, sum(pg_indexes_size(c.oid))::bigint idx_bytes, sum(pg_table_size(c.oid))::bigint tbl_bytes FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'`)).rows[0];

// ── 3. BASELINE ──────────────────────────────────────────────────────────────────────────────
const fpBefore = await lastRows(sqlOf('tests/t01_fingerprint.sql'));
const catBefore = await lastRows(sqlOf('tests/t04_catalog_snapshot.sql'));
const invBefore = await lastRows(sqlOf('tests/t02_business_invariants.sql'));
const riBefore = await lastRows(sqlOf('tests/t03_referential_integrity.sql'));
const before = await runBench('BEFORE');
R.writeMsBefore = await writeBench();
R.sizeBefore = await sizes();
R.tests.baseline = { invariants: invBefore, referentialIntegrity: riBefore };
log('baseline invariants', JSON.stringify(invBefore.filter((r) => Number(r.violations) > 0)), 'RI problems:', riBefore.length);

// ── 4. PHASE 1: indexes ──────────────────────────────────────────────────────────────────────
const p1 = performance.now();
await db.exec(sqlOf('001_indexes_up.sql'));
R.phases.phase1_ms = performance.now() - p1;
await db.exec('ANALYZE');
const after1 = await runBench('AFTER phase 1');
R.writeMsAfter = await writeBench();
R.sizeAfter = await sizes();
R.indexesAdded = Number((await one(`SELECT count(*) n FROM pg_indexes WHERE schemaname='public' AND indexname LIKE 'idx\\_%' AND indexname IN (${[...sqlOf('001_indexes_up.sql').matchAll(/INDEX IF NOT EXISTS (\w+)/g)].map((m) => `'${m[1]}'`).join(',')})`)).n);
const newIdx = [...sqlOf('001_indexes_up.sql').matchAll(/INDEX IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
const usedInPlans = new Set(Object.values(after1).flatMap((x) => x.scans.map((t) => t.split(':')[1]))); // pg_stat idx_scan is not tracked by PGlite, so read the plans
R.indexesNotExercised = newIdx.filter((i) => !usedInPlans.has(i));
const fp1 = await lastRows(sqlOf('tests/t01_fingerprint.sql'));
R.tests.phase1 = { dataFingerprintUnchanged: JSON.stringify(fp1) === JSON.stringify(fpBefore), invariants: await lastRows(sqlOf('tests/t02_business_invariants.sql')), referentialIntegrity: await lastRows(sqlOf('tests/t03_referential_integrity.sql')) };
R.bench = QUERIES.map(([name]) => ({ name, before: before[name], after: after1[name], sameResult: JSON.stringify(before[name].result) === JSON.stringify(after1[name].result) }));
R.resultHashesEqual = R.bench.every((b) => b.sameResult);

// ── 5. PHASE 2: integrity ────────────────────────────────────────────────────────────────────
R.tests.phase2 = {};
R.tests.phase2.precheckViolations = await lastRows(sqlOf('002_integrity_precheck.sql'));
await db.exec(sqlOf('002_integrity_up.sql'));
R.tests.phase2.constraintEnforcement = await lastRows(sqlOf('tests/t05_constraint_enforcement.sql'));
R.tests.phase2.referentialIntegrity = await lastRows(sqlOf('tests/t03_referential_integrity.sql'));
R.tests.phase2.dataFingerprintUnchanged = JSON.stringify(await lastRows(sqlOf('tests/t01_fingerprint.sql'))) === JSON.stringify(fpBefore);
R.tests.phase2.invariants = await lastRows(sqlOf('tests/t02_business_invariants.sql'));
// a precheck on deliberately dirty data must FIND the problem (proves the precheck is not vacuous)
await db.exec('BEGIN; UPDATE stock SET quantity = -3 WHERE id = (SELECT id FROM stock LIMIT 1);'); // stock >= 0 is not a constraint (withdrawn), so the pre-check alone must catch it
R.tests.phase2.precheckDetectsDirtyData = (await lastRows(sqlOf('002_integrity_precheck.sql'))).some((r) => r.violation === 'stock.quantity < 0');
await db.exec('ROLLBACK');

// ── 6. ROLLBACK ──────────────────────────────────────────────────────────────────────────────
await db.exec(sqlOf('002_integrity_down.sql'));
await db.exec(sqlOf('001_indexes_down.sql'));
const catAfterRollback = await lastRows(sqlOf('tests/t04_catalog_snapshot.sql'));
R.tests.rollback = {
  catalogIdenticalToOriginal: JSON.stringify(catAfterRollback) === JSON.stringify(catBefore),
  dataFingerprintUnchanged: JSON.stringify(await lastRows(sqlOf('tests/t01_fingerprint.sql'))) === JSON.stringify(fpBefore),
  catBefore, catAfterRollback,
};
// re-apply after rollback: the scripts must be repeatable
await db.exec(sqlOf('001_indexes_up.sql'));
await db.exec(sqlOf('001_indexes_up.sql')); // idempotent (IF NOT EXISTS)
R.tests.reapplyIdempotent = true;

R.elapsedSeconds = (Date.now() - t0) / 1000;
fs.mkdirSync(path.join(DOC, 'results'), { recursive: true });
fs.writeFileSync(path.join(DOC, 'results/verification-results.json'), JSON.stringify(R, null, 2));

// ── 7. markdown summary ──────────────────────────────────────────────────────────────────────
const f = (n) => (n < 10 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : Math.round(n).toString());
let md = `# Verification results (generated by scripts/verify.mjs)\n\nScratch PGlite database, synthetic data, scale = ${SCALE} bills per branch × 3 branches.\n\n`;
md += `Row counts: ${Object.entries(R.rowCounts).map(([k, v]) => `${k} ${v.toLocaleString()}`).join(', ')}\n\n`;
md += `## Read performance (median of 7 runs, EXPLAIN ANALYZE)\n\n| Query | Before ms | After ms | Speed-up | Pages read before → after | Plan before | Plan after |\n|---|---:|---:|---:|---:|---|---|\n`;
for (const r of R.bench) md += `| ${r.name} | ${f(r.before.ms)} | ${f(r.after.ms)} | ${(r.before.ms / Math.max(r.after.ms, 0.001)).toFixed(1)}× | ${r.before.buffers.toLocaleString()} → ${r.after.buffers.toLocaleString()} | ${r.before.scans.join(', ')} | ${r.after.scans.join(', ')} |\n`;
md += `\nQuery results identical before and after Phase 1 (row count + content hash, all ${R.bench.length} queries): **${R.resultHashesEqual ? 'PASS' : 'FAIL'}**\n`;
md += `\n## Write cost of the new indexes\n\nInsert 5,000 bills + 5,000 bill lines + 5,000 stock-audit rows (rolled back): **${f(R.writeMsBefore)} ms before → ${f(R.writeMsAfter)} ms after** (${((R.writeMsAfter / R.writeMsBefore - 1) * 100).toFixed(0)}%).\n\n`;
md += `## Storage\n\n| | Tables | Indexes |\n|---|---:|---:|\n| Before | ${R.sizeBefore.tables} | ${R.sizeBefore.indexes} |\n| After Phase 1 | ${R.sizeAfter.tables} | ${R.sizeAfter.indexes} |\n\nIndexes added: ${R.indexesAdded}.\n\nNew indexes the benchmark never used (justified by a query found in the code, but NOT proven by measurement here): ${R.indexesNotExercised.length ? R.indexesNotExercised.map((x) => '\`' + x + '\`').join(', ') : 'none'}.\n\n`;
const okRow = (r) => (r.ok ? 'PASS' : 'FAIL');
md += `## Test outcomes\n\n- Phase 1 data fingerprint unchanged: **${R.tests.phase1.dataFingerprintUnchanged ? 'PASS' : 'FAIL'}**\n- Phase 1 referential-integrity problems: **${R.tests.phase1.referentialIntegrity.length}** (must be 0)\n- Phase 2 pre-check violations on seeded data: **${R.tests.phase2.precheckViolations.length}** (must be 0)\n- Phase 2 pre-check detects deliberately dirty data: **${R.tests.phase2.precheckDetectsDirtyData ? 'PASS' : 'FAIL'}**\n- Phase 2 data fingerprint unchanged: **${R.tests.phase2.dataFingerprintUnchanged ? 'PASS' : 'FAIL'}**\n- Phase 2 referential-integrity problems / NOT VALID constraints: **${R.tests.phase2.referentialIntegrity.length}** (must be 0)\n- Rollback restores catalog exactly: **${R.tests.rollback.catalogIdenticalToOriginal ? 'PASS' : 'FAIL'}**; data unchanged: **${R.tests.rollback.dataFingerprintUnchanged ? 'PASS' : 'FAIL'}**\n\n### Constraint enforcement (T05)\n\n| Probe | Expected | Actual | |\n|---|---|---|---|\n`;
for (const r of R.tests.phase2.constraintEnforcement) md += `| ${r.probe} | ${r.expected} | ${r.actual} | ${okRow(r)} |\n`;
md += `\n### Business invariants (T02) — violations after Phase 2\n\n| Invariant | Violations |\n|---|---:|\n`;
for (const r of R.tests.phase2.invariants) md += `| ${r.invariant} | ${r.violations} |\n`;
fs.writeFileSync(path.join(DOC, 'results/verification-results.md'), md);
log('DONE. results written');
await db.close();
