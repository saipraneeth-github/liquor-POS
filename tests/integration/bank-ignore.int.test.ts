import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { setupIntegration, type IntegrationContext } from './helpers.js';
import { addDays } from '../../src/modules/bank/bank.engine.js';
import { businessDateOf } from '../../src/lib/business-day.js';

let ctx: IntegrationContext;
const today = businessDateOf();
let seq = 0;

beforeAll(async () => { ctx = await setupIntegration(); }, 60_000);
afterAll(async () => { await ctx?.app.close(); });

// ── helpers ───────────────────────────────────────────────────────────────────
const inject = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, headers: Record<string, string>, payload?: unknown) =>
  ctx.app.inject({ method, url: `/api/v1${url}`, headers, payload: payload as never });
const mgr = () => ctx.auth('manager');

function multipart(content: string) {
  const b = '----ign' + Math.random().toString(16).slice(2);
  const body = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="s.csv"\r\nContent-Type: text/csv\r\n\r\n`),
    Buffer.from(content), Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  return { body, type: `multipart/form-data; boundary=${b}` };
}
const dmy = (iso: string) => iso.split('-').reverse().join('/');

/** Each test gets its own account, so lines never collide on the per-account de-duplication. */
async function newAccount(name?: string): Promise<string> {
  const res = await inject('POST', '/bank/accounts', mgr(), { branchId: ctx.branchId, name: name ?? `Acct ${++seq}` });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

type Item = [number, string, number];   // [days from today, narration, signed amount]
async function importLines(accountId: string, items: Item[]) {
  let bal = 0;
  const rows = items.map(([d, narr, amt]) => {
    bal = Math.round((bal + amt) * 100) / 100;
    return `${dmy(addDays(today, d))},"${narr}",${amt < 0 ? (-amt).toFixed(2) : ''},${amt > 0 ? amt.toFixed(2) : ''},${bal.toFixed(2)}`;
  });
  const m = multipart(['Date,Narration,Debit,Credit,Balance', ...rows].join('\n'));
  const res = await ctx.app.inject({ method: 'POST', url: `/api/v1/bank/accounts/${accountId}/statements`, headers: { ...mgr(), 'content-type': m.type }, payload: m.body });
  expect(res.statusCode).toBe(201);
  const statementId = res.json().statement.id as string;
  const lines = (await inject('GET', `/bank/statements/${statementId}/lines`, mgr())).json() as Line[];
  return { statementId, lines, imported: res.json() };
}
type Line = { id: string; narration: string; status: string; ignoreReason: string | null; ignoredByRuleId: string | null; note: string | null; suggestion: { kind: string; pattern?: string; ignoreReason?: string } | null };
const refresh = async (statementId: string) => (await inject('GET', `/bank/statements/${statementId}/lines`, mgr())).json() as Line[];
const by = (lines: Line[], text: string) => lines.filter((l) => l.narration.includes(text));
const rule = (accountId: string, body: Record<string, unknown>) => inject('POST', `/bank/accounts/${accountId}/rules`, mgr(), { reason: 'PERSONAL', ...body });

// ── a reason is always recorded ───────────────────────────────────────────────
describe('ignoring a line', () => {
  it('needs a reason, and only a known one', async () => {
    const acct = await newAccount();
    const { lines } = await importLines(acct, [[30, 'UPI/1/SWIGGY/Payment', -250]]);
    const id = lines[0].id;
    expect((await inject('POST', `/bank/lines/${id}/ignore`, mgr(), {})).statusCode).toBe(400);
    expect((await inject('POST', `/bank/lines/${id}/ignore`, mgr(), { note: 'just a note' })).statusCode).toBe(400);
    expect((await inject('POST', `/bank/lines/${id}/ignore`, mgr(), { reason: 'BECAUSE' })).statusCode).toBe(400);
    expect((await inject('POST', `/bank/lines/${id}/ignore`, mgr(), { reason: 'PERSONAL', note: 'Owner lunch' })).statusCode).toBe(200);
  });

  it('records why, shows it in the summary, and can be taken back', async () => {
    const acct = await newAccount();
    const { statementId, lines } = await importLines(acct, [[31, 'UPI/2/SWIGGY/Payment', -250], [31, 'UPI/3/UBER/Payment', -120.5], [31, 'NEFT-OTHER SHOP', -999]]);
    await inject('POST', `/bank/lines/${by(lines, 'SWIGGY')[0].id}/ignore`, mgr(), { reason: 'PERSONAL', note: 'Owner lunch' });
    await inject('POST', `/bank/lines/${by(lines, 'UBER')[0].id}/ignore`, mgr(), { reason: 'PERSONAL' });
    await inject('POST', `/bank/lines/${by(lines, 'OTHER SHOP')[0].id}/ignore`, mgr(), { reason: 'OTHER_BUSINESS' });

    const now = await refresh(statementId);
    expect(by(now, 'SWIGGY')[0]).toMatchObject({ status: 'IGNORED', ignoreReason: 'PERSONAL', note: 'Owner lunch' });

    const sum = (await inject('GET', `/bank/statements/${statementId}/summary`, mgr())).json();
    expect(sum.ignored).toMatchObject({ count: 3, totalIn: '0.00', totalOut: '1369.50' });
    expect(sum.ignored.byReason).toEqual(expect.arrayContaining([
      { reason: 'PERSONAL', count: 2, in: '0.00', out: '370.50' },
      { reason: 'OTHER_BUSINESS', count: 1, in: '0.00', out: '999.00' },
    ]));

    const back = await inject('POST', `/bank/lines/${by(lines, 'SWIGGY')[0].id}/unmatch`, mgr());
    expect(back.statusCode).toBe(200);
    expect(by(await refresh(statementId), 'SWIGGY')[0]).toMatchObject({ status: 'UNMATCHED', ignoreReason: null, note: null });
  });

  it('cannot ignore a line that is already matched', async () => {
    const acct = await newAccount();
    const { lines } = await importLines(acct, [[32, 'CASH DEPOSIT BY SELF', 500]]);
    expect((await inject('POST', `/bank/lines/${lines[0].id}/post`, mgr(), { category: 'CASH_DEPOSIT' })).statusCode).toBe(201);
    expect((await inject('POST', `/bank/lines/${lines[0].id}/ignore`, mgr(), { reason: 'PERSONAL' })).statusCode).toBe(409);
  });
});

// ── bulk ──────────────────────────────────────────────────────────────────────
describe('ignoring many lines at once', () => {
  it('takes every open line given, skips anything not open or not on this statement, and audits it once', async () => {
    const acct = await newAccount();
    const a = await importLines(acct, [[33, 'UPI/4/SWIGGY/Payment', -100], [33, 'UPI/5/ZOMATO/Payment', -200], [33, 'UPI/6/UBER/Payment', -300], [33, 'NEFT-SUPPLIER', -400]]);
    const other = await importLines(await newAccount(), [[34, 'UPI/7/SWIGGY/Payment', -50]]);
    const ids = by(a.lines, 'SWIGGY').concat(by(a.lines, 'ZOMATO'), by(a.lines, 'UBER')).map((l) => l.id);

    await inject('POST', `/bank/lines/${ids[0]}/ignore`, mgr(), { reason: 'PERSONAL' });                // one is already ignored
    const res = await inject('POST', `/bank/statements/${a.statementId}/ignore`, mgr(), {
      lineIds: [...ids, other.lines[0].id, '00000000-0000-4000-8000-000000000000'], reason: 'PERSONAL', note: 'Owner spend, March',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ignored: 2, skipped: 3 });        // 2 newly ignored; the already-ignored, the other statement's and the unknown id skipped

    const now = await refresh(a.statementId);
    expect(by(now, 'NEFT-SUPPLIER')[0].status).toBe('UNMATCHED');         // untouched
    expect(by(now, 'ZOMATO')[0]).toMatchObject({ status: 'IGNORED', ignoreReason: 'PERSONAL', note: 'Owner spend, March' });
    expect((await refresh(other.statementId))[0].status).not.toBe('IGNORED');

    const audits = await ctx.db.select().from(ctx.schema.auditLog).where(eq(ctx.schema.auditLog.action, 'bank.line.ignore_bulk'));
    expect(audits.filter((x) => (x.meta as { count: number }).count === 2)).toHaveLength(1);
  });

  it('needs a reason and at least one line', async () => {
    const acct = await newAccount();
    const { statementId, lines } = await importLines(acct, [[35, 'UPI/8/SWIGGY/Payment', -10]]);
    expect((await inject('POST', `/bank/statements/${statementId}/ignore`, mgr(), { lineIds: [lines[0].id] })).statusCode).toBe(400);
    expect((await inject('POST', `/bank/statements/${statementId}/ignore`, mgr(), { lineIds: [], reason: 'PERSONAL' })).statusCode).toBe(400);
  });
});

// ── rules ─────────────────────────────────────────────────────────────────────
describe('ignore rules: management and access', () => {
  it('validates, refuses duplicates, lists, edits and deletes', async () => {
    const acct = await newAccount();
    expect((await rule(acct, { pattern: 'ab' })).statusCode).toBe(400);                          // too short
    expect((await rule(acct, { pattern: 'swiggy', minAmount: '500', maxAmount: '100' })).statusCode).toBe(400);
    expect((await rule(acct, { pattern: 'swiggy', action: 'MAYBE' })).statusCode).toBe(400);
    const ok = await rule(acct, { pattern: 'Swiggy', reason: 'PERSONAL' });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ pattern: 'Swiggy', action: 'SUGGEST', side: 'ANY', isActive: true });
    expect((await rule(acct, { pattern: 'SWIGGY' })).statusCode).toBe(409);                       // same text, any case

    const id = ok.json().id as string;
    const patched = await inject('PATCH', `/bank/rules/${id}`, mgr(), { action: 'AUTO', isActive: false });
    expect(patched.json()).toMatchObject({ action: 'AUTO', isActive: false });
    expect((await inject('PATCH', `/bank/rules/${id}`, mgr(), { minAmount: '900', maxAmount: '10' })).statusCode).toBe(422);
    expect((await inject('PATCH', `/bank/rules/${id}`, mgr(), {})).statusCode).toBe(422);

    const list = (await inject('GET', `/bank/accounts/${acct}/rules`, mgr())).json() as Array<{ id: string; ignoredLines: number }>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, ignoredLines: 0 });

    expect((await inject('DELETE', `/bank/rules/${id}`, mgr())).statusCode).toBe(200);
    expect((await inject('GET', `/bank/accounts/${acct}/rules`, mgr())).json()).toHaveLength(0);
    expect((await inject('DELETE', `/bank/rules/${id}`, mgr())).statusCode).toBe(404);
  });

  it("cashiers and other branches' managers cannot read or change rules", async () => {
    const acct = await newAccount();
    const r = await rule(acct, { pattern: 'private' });
    const other = ctx.authFor({ sub: ctx.otherBranchManager.id, email: ctx.otherBranchManager.email, role: 'manager', branchId: ctx.otherBranchId });
    for (const who of [ctx.auth('cashier'), other]) {
      expect((await inject('GET', `/bank/accounts/${acct}/rules`, who)).statusCode).toBe(403);
      expect((await inject('POST', `/bank/accounts/${acct}/rules`, who, { pattern: 'hack', reason: 'PERSONAL' })).statusCode).toBe(403);
      expect((await inject('PATCH', `/bank/rules/${r.json().id}`, who, { isActive: false })).statusCode).toBe(403);
      expect((await inject('DELETE', `/bank/rules/${r.json().id}`, who)).statusCode).toBe(403);
    }
  });

  it('a rule belongs to its account only', async () => {
    const a = await newAccount();
    const b = await newAccount();
    await rule(a, { pattern: 'swiggy', action: 'AUTO' });
    const onB = await importLines(b, [[36, 'UPI/9/SWIGGY/Payment', -75]]);
    expect(onB.lines[0].status).not.toBe('IGNORED');
    expect(onB.lines[0].suggestion).toBeNull();
  });
});

// ── rules at work ─────────────────────────────────────────────────────────────
describe('ignore rules at work', () => {
  it('a SUGGEST rule only proposes; the user confirms them all in one click', async () => {
    const acct = await newAccount();
    await rule(acct, { pattern: 'swiggy', reason: 'PERSONAL', action: 'SUGGEST' });
    const { statementId, lines } = await importLines(acct, [[37, 'UPI/10/SWIGGY/Payment', -100], [37, 'UPI/11/swiggy instamart', -140], [37, 'NEFT-RAJ BEVERAGES', -5000]]);
    const swiggy = by(lines, 'wiggy').concat(by(lines, 'SWIGGY'));
    expect(swiggy.length).toBeGreaterThan(0);
    for (const l of lines.filter((x) => /swiggy/i.test(x.narration))) {
      expect(l.status).toBe('SUGGESTED');
      expect(l.suggestion).toMatchObject({ kind: 'IGNORE', pattern: 'swiggy', ignoreReason: 'PERSONAL' });
    }
    expect(by(lines, 'RAJ')[0].suggestion).toBeNull();

    // the generic "accept matches" button must NOT quietly ignore anything
    await inject('POST', `/bank/statements/${statementId}/accept-suggestions`, mgr(), {});
    expect((await refresh(statementId)).filter((l) => l.status === 'IGNORED')).toHaveLength(0);

    const res = await inject('POST', `/bank/statements/${statementId}/apply-ignore-suggestions`, mgr());
    expect(res.json()).toEqual({ ignored: 2 });
    const now = await refresh(statementId);
    expect(now.filter((l) => l.status === 'IGNORED')).toHaveLength(2);
    expect(by(now, 'RAJ')[0].status).toBe('UNMATCHED');
    const list = (await inject('GET', `/bank/accounts/${acct}/rules`, mgr())).json() as Array<{ ignoredLines: number }>;
    expect(list[0].ignoredLines).toBe(2);
  });

  it('an AUTO rule ignores on import, says which rule did it, and is audited', async () => {
    const acct = await newAccount();
    const r = (await rule(acct, { pattern: 'zomato', reason: 'PERSONAL', action: 'AUTO' })).json();
    const { statementId, lines, imported } = await importLines(acct, [[38, 'UPI/12/ZOMATO/Payment', -310], [38, 'NEFT-RAJ BEVERAGES', -5000]]);
    expect(imported.match.autoIgnored).toBe(1);
    expect(by(lines, 'ZOMATO')[0]).toMatchObject({ status: 'IGNORED', ignoreReason: 'PERSONAL', ignoredByRuleId: r.id });
    expect(by(lines, 'ZOMATO')[0].note).toMatch(/rule .zomato./);
    expect(by(lines, 'RAJ')[0].status).toBe('UNMATCHED');

    const audits = await ctx.db.select().from(ctx.schema.auditLog).where(eq(ctx.schema.auditLog.action, 'bank.line.auto_ignore'));
    expect(audits.some((a) => a.targetId === statementId)).toBe(true);
  });

  it('a person taking an auto-ignored line back is respected: re-running the match does not ignore it again', async () => {
    const acct = await newAccount();
    await rule(acct, { pattern: 'ubereats', action: 'AUTO' });
    const { statementId, lines } = await importLines(acct, [[39, 'UPI/13/UBEREATS/Payment', -220]]);
    expect(lines[0].status).toBe('IGNORED');
    expect((await inject('POST', `/bank/lines/${lines[0].id}/unmatch`, mgr())).statusCode).toBe(200);
    await inject('POST', `/bank/statements/${statementId}/match`, mgr());
    expect((await refresh(statementId))[0]).toMatchObject({ status: 'UNMATCHED', ignoredByRuleId: null });
  });

  it('a line that matches the books is NEVER auto-ignored, whatever the rule says', async () => {
    const acct = await newAccount();
    await rule(acct, { pattern: 'swiggy', action: 'AUTO' });
    // The books already hold a 640 payment from the bank (a catering expense)…
    expect((await inject('POST', `/expenses/${ctx.branchId}`, mgr(), { category: 'Catering', amount: '640.00', paymentMode: 'BANK' })).statusCode).toBe(201);
    // …and the statement shows it with a narration that happens to contain the rule's text
    const { lines } = await importLines(acct, [[3, 'NEFT-SWIGGY CATERING SERVICES', -640]]);
    expect(lines[0].status).toBe('SUGGESTED');
    expect(lines[0].suggestion).toMatchObject({ kind: 'ONE_TO_ONE' });
    expect(lines[0].ignoredByRuleId).toBeNull();
  });

  it('a rule can be limited to one side and an amount range', async () => {
    const acct = await newAccount();
    await rule(acct, { pattern: 'swiggy', side: 'OUT', minAmount: '50', maxAmount: '500', action: 'AUTO' });
    const { lines } = await importLines(acct, [
      [40, 'UPI/14/SWIGGY tiny', -20],              // below the range
      [40, 'UPI/15/SWIGGY lunch', -200],            // inside: ignored
      [40, 'UPI/16/SWIGGY big catering', -9000],    // above the range
      [40, 'UPI/17/SWIGGY REFUND', 200],            // wrong side (credit)
    ]);
    const status = (t: string) => by(lines, t)[0].status;
    expect(status('tiny')).toBe('UNMATCHED');
    expect(status('lunch')).toBe('IGNORED');
    expect(status('big catering')).toBe('UNMATCHED');
    expect(status('REFUND')).toBe('UNMATCHED');
  });

  it('"ignore lines like this" while ignoring: saves the rule and applies it to the other open lines immediately', async () => {
    const acct = await newAccount();
    const { statementId, lines } = await importLines(acct, [[41, 'UPI/18/AMAZON PAY/a', -100], [41, 'UPI/19/AMAZON PAY/b', -200], [41, 'NEFT-RAJ BEVERAGES', -5000]]);
    const first = by(lines, 'AMAZON')[0];
    const res = await inject('POST', `/bank/lines/${first.id}/ignore`, mgr(), {
      reason: 'PERSONAL', note: 'Owner shopping', rule: { pattern: 'AMAZON', action: 'AUTO', side: 'OUT' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rule.applied.autoIgnored).toBe(1);               // the second AMAZON line
    const now = await refresh(statementId);
    expect(by(now, 'AMAZON').every((l) => l.status === 'IGNORED')).toBe(true);
    expect(by(now, 'RAJ')[0].status).toBe('UNMATCHED');
    const rules = (await inject('GET', `/bank/accounts/${acct}/rules`, mgr())).json() as Array<{ pattern: string; action: string; side: string; reason: string }>;
    expect(rules).toEqual([expect.objectContaining({ pattern: 'AMAZON', action: 'AUTO', side: 'OUT', reason: 'PERSONAL' })]);
  });

  it('deleting a rule keeps the decisions it already made, but stops it acting on new statements', async () => {
    const acct = await newAccount();
    const r = (await rule(acct, { pattern: 'netflix', action: 'AUTO' })).json();
    const first = await importLines(acct, [[42, 'UPI/20/NETFLIX/Payment', -649]]);
    expect(first.lines[0].status).toBe('IGNORED');
    await inject('DELETE', `/bank/rules/${r.id}`, mgr());
    expect((await refresh(first.statementId))[0].status).toBe('IGNORED');
    const second = await importLines(acct, [[43, 'UPI/21/NETFLIX/Payment', -649]]);
    expect(second.lines[0].status).toBe('UNMATCHED');
  });
});
