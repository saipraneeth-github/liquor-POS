// QA clean-up for the data created by the end-to-end browser testing session (2026-11-13).
//   node docs/qa/cleanup.mjs inventory   read-only: lists every row this session created
//   node docs/qa/cleanup.mjs void        stage 1 (through the app): void the paid test bills, so stock / vouchers / khata reverse by the app's own rules
//   node docs/qa/cleanup.mjs shift       close the cashier shift the test opened (counted = expected, no discrepancy)
//   node docs/qa/cleanup.mjs apply       stage 2: remove the setup data + undo the test khata repayments, in ONE transaction (all or nothing)
// Reads DATABASE_URL from .env (never printed). Same DNS fallback as src/db/client.ts.
// Scope is deliberately narrow: names starting "QA ", users qa.*@liquor.com, and rows created at/after SINCE (UTC).
import fs from 'node:fs'; import path from 'node:path'; import dns from 'node:dns';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SINCE = process.env.QA_SINCE || '2026-11-13T16:40:00Z';
const API = 'http://localhost:3001/api/v1';
{
  const pub = new dns.Resolver(); pub.setServers(['8.8.8.8', '1.1.1.1']); const orig = dns.lookup;
  dns.lookup = (h, o, cb) => {
    if (typeof o === 'function') { cb = o; o = {}; }
    orig(h, o, (e, a, f) => e ? pub.resolve4(h, (e2, as) => (e2 || !as?.length) ? cb(e) : (o?.all ? cb(null, as.map((x) => ({ address: x, family: 4 }))) : cb(null, as[0], 4))) : cb(e, a, f));
  };
}
const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
const url = (env.match(/^DATABASE_URL=(.+)$/m) || [])[1].trim();
const sql = postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 30, onnotice: () => {} });
const mode = process.argv[2];
const show = async (title, q) => { const r = await q; console.log(`\n## ${title} (${r.length})`); if (r.length) console.table(r); return r; };
const login = async (email) => (await (await fetch(API + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Password@123' }) })).json()).token;

try {
  console.log('since (UTC):', SINCE, '| db:', (await sql`select current_database() d`)[0].d);
  if (mode === 'inventory') {
    await show('tables named "QA …"', sql`select id, name, status from tables where name like 'QA %'`);
    await show('products named "QA Test Whisky …"', sql`select id, name, mrp from products where name like 'QA Test Whisky%'`);
    await show('schemes named "QA Scheme …"', sql`select id, scheme_name, status from schemes where scheme_name like 'QA Scheme%'`);
    await show('excise quotas created in the session', sql`select id, quota_cases, created_at from excise_quotas where created_at >= ${SINCE}`);
    await show('QA staff users', sql`select id, email, is_active from users where email like 'qa.%@liquor.com'`);
    await show('counter sheets created in the session', sql`select id, sheet_date, status, created_at from daily_counter_sheets where created_at >= ${SINCE} order by created_at`);
    await show('day closings created in the session', sql`select id, closing_date, cash_sales, status from daily_closings where created_at >= ${SINCE}`);
    await show('bills created in the session', sql`select b.bill_number, b.status, b.payment_mode, b.total, c.name as customer from bills b left join customers c on c.id=b.customer_id where b.created_at >= ${SINCE} order by b.created_at`);
    await show('khata entries in the session', sql`select c.name, t.type, t.amount, t.balance_after from credit_transactions t join customers c on c.id=t.customer_id where t.recorded_at >= ${SINCE} order by t.recorded_at`);
    await show('shift sessions opened in the session', sql`select s.id, u.email, s.status from shift_sessions s join users u on u.id=s.cashier_id where s.opened_at >= ${SINCE}`);
    await show('Ravi Kumar now', sql`select name, current_credit from customers where name = 'Ravi Kumar'`);
  } else if (mode === 'void') {
    const mgr = await login('manager@liquor.com');
    const mine = await sql`select id, bill_number from bills where created_at >= ${SINCE} and status = 'PAID' order by created_at`;
    console.log('voiding', mine.length, 'paid test bills:', mine.map((b) => b.bill_number.slice(-3)).join(', '));
    for (const b of mine) {
      const r = await fetch(API + '/bills/' + b.id + '/void', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + mgr }, body: JSON.stringify({ voidReason: 'QA end-to-end test clean-up' }) });
      console.log(' ', b.bill_number, '->', r.status, r.ok ? '' : (await r.text()).slice(0, 160));
      if (!r.ok) throw new Error('void failed; stopping');
    }
  } else if (mode === 'shift') {
    const tok = await login('cashier@liquor.com');
    const cur = await (await fetch(API + '/shifts/current', { headers: { authorization: 'Bearer ' + tok } })).json();
    console.log('current shift:', JSON.stringify(cur).slice(0, 500));
    const sh = cur.shift || cur;
    const expected = Number(sh.expectedCash ?? sh.expected ?? sh.expectedLive ?? sh.openingFloat ?? 0);
    const r = await fetch(API + '/shifts/' + sh.id + '/close', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: JSON.stringify({ denominations: { coins: expected.toFixed(2) }, notes: 'QA end-to-end test clean-up' }) });
    console.log('close ->', r.status, (await r.text()).slice(0, 400));
  } else if (mode === 'apply') {
    await sql.begin(async (tx) => {
      const one = async (q) => (await q)[0];
      const expectEq = (what, got, want) => { if (got !== want) throw new Error(`ABORT (nothing changed): ${what} = ${got}, expected ${want}`); console.log('  ok', what, '=', got); };
      expectEq('paid test bills still to void', (await one(tx`select count(*)::int n from bills where created_at >= ${SINCE} and status='PAID'`)).n, 0);

      // khata: remove the two test repayments and their vouchers, then re-chain balance_after
      const ravi = await one(tx`select id, current_credit from customers where name='Ravi Kumar'`);
      const reps = await tx`select id, amount from credit_transactions where customer_id=${ravi.id} and type='REPAYMENT' and recorded_at >= ${SINCE} order by recorded_at`;
      expectEq('test repayments', reps.length, 2);
      const vouchers = await tx`select id from journal_vouchers where source_type='CREDIT_REPAYMENT' and created_at >= ${SINCE}`;
      expectEq('repayment vouchers', vouchers.length, 2);
      const restored = (Number(ravi.current_credit) + reps.reduce((s, r) => s + Number(r.amount), 0)).toFixed(2);
      await tx`delete from journal_vouchers where id in ${tx(vouchers.map((v) => v.id))}`;   // journal lines cascade
      await tx`delete from credit_transactions where id in ${tx(reps.map((r) => r.id))}`;
      const rest = await tx`select id, type, amount from credit_transactions where customer_id=${ravi.id} and recorded_at >= ${SINCE} order by recorded_at`;
      let bal = Number(restored); const chain = [];
      for (const t of [...rest].reverse()) { chain.unshift({ id: t.id, bal: bal.toFixed(2) }); bal += t.type === 'PURCHASE' ? -Number(t.amount) : Number(t.amount); }
      for (const t of chain) await tx`update credit_transactions set balance_after=${t.bal} where id=${t.id}`;
      await tx`update customers set current_credit=${restored} where id=${ravi.id}`;
      console.log('  Ravi Kumar balance restored to', restored);

      // bar table, its sessions and KOT orders (KOT items cascade)
      const tbl = await tx`select id from tables where name like 'QA %'`; expectEq('QA tables', tbl.length, 1);
      const sess = await tx`select id from table_sessions where table_id=${tbl[0].id}`;
      if (sess.length) { const ids = sess.map((x) => x.id); await tx`delete from kot_orders where table_session_id in ${tx(ids)}`; await tx`delete from table_sessions where id in ${tx(ids)}`; }
      await tx`delete from tables where id=${tbl[0].id}`;

      // product (only if nothing transactional references it)
      const prod = await tx`select id from products where name like 'QA Test Whisky%'`; expectEq('QA products', prod.length, 1);
      const pid = prod[0].id;
      const refs = await one(tx`select (select count(*) from bill_items where product_id=${pid})::int + (select count(*) from kot_items where product_id=${pid})::int + (select count(*) from stock_audit where product_id=${pid})::int + (select count(*) from daily_counter_sheet_lines where product_id=${pid})::int + (select count(*) from supplier_invoice_items where product_id=${pid})::int as n`);
      expectEq('QA product transaction rows', refs.n, 0);
      await tx`delete from price_audit where product_id=${pid}`; await tx`delete from stock where product_id=${pid}`; await tx`delete from products where id=${pid}`;

      // scheme and quotas
      const sch = await tx`select id from schemes where scheme_name like 'QA Scheme%'`; expectEq('QA schemes', sch.length, 1);
      await tx`delete from scheme_purchases where scheme_id=${sch[0].id}`; await tx`delete from schemes where id=${sch[0].id}`;
      expectEq('quotas removed', (await tx`delete from excise_quotas where created_at >= ${SINCE} and quota_cases in (50,77) returning id`).length, 2);

      // draft counter sheets I created (lines cascade) and the test day closing
      expectEq('draft counter sheets removed', (await tx`delete from daily_counter_sheets where created_at >= ${SINCE} and status='DRAFT' returning id`).length, 2);
      expectEq('test day closings removed', (await tx`delete from daily_closings where created_at >= ${SINCE} and cash_sales = 0 returning id`).length, 1);

      // QA staff user: delete; if something still references it, deactivate instead
      const usr = await tx`select id from users where email like 'qa.%@liquor.com'`; expectEq('QA users', usr.length, 1);
      await tx`update audit_log set actor_id=null where actor_id=${usr[0].id}`;
      try { await tx.savepoint(async (sp) => { await sp`delete from users where id=${usr[0].id}`; }); console.log('  QA user deleted'); }
      catch (e) { await tx`update users set is_active=false where id=${usr[0].id}`; console.log('  QA user still referenced (' + (e.constraint_name || e.message).slice(0, 60) + ') -> deactivated instead'); }
    });
    console.log('\nAPPLIED (single transaction committed)');
  } else throw new Error('usage: inventory | void | shift | apply');
} finally { await sql.end({ timeout: 5 }); }
