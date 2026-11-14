import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIntegration, type IntegrationContext } from './helpers.js';
import { addDays } from '../../src/modules/bank/bank.engine.js';
import { businessDateOf } from '../../src/lib/business-day.js';

let ctx: IntegrationContext;
const today = businessDateOf();
let seq = 0;

beforeAll(async () => { ctx = await setupIntegration(); }, 60_000);
afterAll(async () => { await ctx?.app.close(); });

const inject = (method: 'GET' | 'POST' | 'PATCH', url: string, headers: Record<string, string>, payload?: unknown) =>
  ctx.app.inject({ method, url: `/api/v1${url}`, headers, payload: payload as never });
const mgr = () => ctx.auth('manager');
const dmy = (iso: string) => iso.split('-').reverse().join('/');

function multipart(content: string) {
  const b = '----typ' + Math.random().toString(16).slice(2);
  const body = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="s.csv"\r\nContent-Type: text/csv\r\n\r\n`),
    Buffer.from(content), Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  return { body, type: `multipart/form-data; boundary=${b}` };
}

async function newAccount(): Promise<string> {
  const res = await inject('POST', '/bank/accounts', mgr(), { branchId: ctx.branchId, name: `Types acct ${++seq}` });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

type Line = { id: string; narration: string; status: string; category: string | null; voucherId: string | null; suggestion: { kind: string; customTypeId?: string; customTypeName?: string } | null };

/** Imports lines on an account; [days from today, narration, signed amount]. Day offsets must differ between imports on one account. */
async function importLines(accountId: string, items: Array<[number, string, number]>) {
  let bal = 0;
  const rows = items.map(([d, narr, amt]) => {
    bal = Math.round((bal + amt) * 100) / 100;
    return `${dmy(addDays(today, d))},"${narr}",${amt < 0 ? (-amt).toFixed(2) : ''},${amt > 0 ? amt.toFixed(2) : ''},${bal.toFixed(2)}`;
  });
  const m = multipart(['Date,Narration,Debit,Credit,Balance', ...rows].join('\n'));
  const res = await ctx.app.inject({ method: 'POST', url: `/api/v1/bank/accounts/${accountId}/statements`, headers: { ...mgr(), 'content-type': m.type }, payload: m.body });
  expect(res.statusCode).toBe(201);
  const statementId = res.json().statement.id as string;
  return { statementId, lines: await lines(statementId) };
}
const lines = async (statementId: string) => (await inject('GET', `/bank/statements/${statementId}/lines`, mgr())).json() as Line[];

async function ledgerId(code?: string): Promise<string> {
  const res = await inject('GET', `/accounting/ledgers/${ctx.branchId}`, mgr());
  const list = res.json().ledgers as { id: string; code: string }[];
  const l = code ? list.find((x) => x.code === code) : list.find((x) => x.code !== 'BANK');
  expect(l).toBeTruthy();
  return l!.id;
}
const makeType = (acct: string, body: Record<string, unknown>) => inject('POST', `/bank/accounts/${acct}/types`, mgr(), body);

describe('customer-defined transaction types', () => {
  it('validates the form, refuses the bank ledger and duplicate names, and lists what was saved', async () => {
    const acct = await newAccount();
    const lid = await ledgerId();
    expect((await makeType(acct, { name: 'ab', direction: 'OUT', ledgerId: lid })).statusCode).toBe(400);                 // too short
    expect((await makeType(acct, { name: 'x'.repeat(41), direction: 'OUT', ledgerId: lid })).statusCode).toBe(400);       // too long
    expect((await makeType(acct, { name: 'Hotel rent', direction: 'SIDEWAYS', ledgerId: lid })).statusCode).toBe(400);
    expect((await makeType(acct, { name: 'Hotel rent', direction: 'OUT' })).statusCode).toBe(400);                         // no ledger
    expect((await makeType(acct, { name: 'Hotel rent', direction: 'OUT', ledgerId: lid, matchText: 'ab' })).statusCode).toBe(400); // text too short
    expect((await makeType(acct, { name: 'Hotel rent', direction: 'OUT', ledgerId: await ledgerId('BANK') })).statusCode).toBe(422);

    const ok = await makeType(acct, { name: 'Hotel rent', direction: 'OUT', ledgerId: lid });
    expect(ok.statusCode).toBe(201);
    const dup = await makeType(acct, { name: '  HOTEL RENT ', direction: 'IN', ledgerId: lid });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toMatch(/already exists/i);

    const list = (await inject('GET', `/bank/accounts/${acct}/types`, mgr())).json() as { name: string; direction: string; ledgerName: string; isActive: boolean }[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Hotel rent', direction: 'OUT', isActive: true });
    expect(list[0].ledgerName).toBeTruthy();
  });

  it('"save and apply" offers the type on lines that are waiting; posting through it creates a voucher and matches the line', async () => {
    const acct = await newAccount();
    const { statementId, lines: first } = await importLines(acct, [[40, 'NEFT-HOTEL RENT NOV', -12000], [40, 'NEFT-SOMETHING ELSE', -500]]);
    expect(first.every((l) => l.suggestion?.customTypeId === undefined)).toBe(true);

    const lid = await ledgerId();
    const made = await makeType(acct, { name: 'Hotel rent', direction: 'OUT', ledgerId: lid, matchText: 'hotel rent', applyToOpen: true });
    expect(made.statusCode).toBe(201);
    expect(made.json().applied).toBe(1);
    const typeId = made.json().type.id as string;

    const after = await lines(statementId);
    const rent = after.find((l) => l.narration.includes('HOTEL RENT'))!;
    expect(rent.status).toBe('SUGGESTED');
    expect(rent.suggestion).toMatchObject({ kind: 'POST', customTypeId: typeId, customTypeName: 'Hotel rent' });
    expect(after.find((l) => l.narration.includes('ELSE'))!.suggestion?.customTypeId).toBeUndefined();

    const posted = await inject('POST', `/bank/lines/${rent.id}/post`, mgr(), { typeId });
    expect(posted.statusCode).toBe(201);
    const done = (await lines(statementId)).find((l) => l.id === rent.id)!;
    expect(done.status).toBe('MATCHED');
    expect(done.category).toBe(`CUSTOM:${typeId}`);
    expect(done.voucherId).toBeTruthy();
  });

  it('a later import suggests the type by itself, only on the side it was made for', async () => {
    const acct = await newAccount();
    const lid = await ledgerId();
    await makeType(acct, { name: 'Gold loan EMI', direction: 'OUT', ledgerId: lid, matchText: 'GOLD LOAN' });
    const { lines: ls } = await importLines(acct, [[41, 'ECS-GOLD LOAN EMI 7731', -4500], [42, 'NEFT-GOLD LOAN REFUND', 800]]);
    const emi = ls.find((l) => l.narration.includes('EMI'))!;
    const refund = ls.find((l) => l.narration.includes('REFUND'))!;
    expect(emi.suggestion).toMatchObject({ kind: 'POST', customTypeName: 'Gold loan EMI' });
    expect(refund.suggestion?.customTypeId).toBeUndefined();   // an OUT-only type is not offered on money coming in
  });

  it('refuses a type on the wrong side, a switched-off type, and another account\'s type', async () => {
    const a = await newAccount();
    const b = await newAccount();
    const lid = await ledgerId();
    const typeId = (await makeType(a, { name: 'Rent paid', direction: 'OUT', ledgerId: lid })).json().type.id as string;

    const { lines: la } = await importLines(a, [[43, 'NEFT-IN-1', 1000], [44, 'NEFT-OUT-1', -700]]);
    const credit = la.find((l) => l.narration.includes('IN-1'))!;
    const debit = la.find((l) => l.narration.includes('OUT-1'))!;
    const wrongSide = await inject('POST', `/bank/lines/${credit.id}/post`, mgr(), { typeId });
    expect(wrongSide.statusCode).toBe(422);

    const { lines: lb } = await importLines(b, [[45, 'NEFT-OUT-B', -300]]);
    expect((await inject('POST', `/bank/lines/${lb[0].id}/post`, mgr(), { typeId })).statusCode).toBe(404);

    expect((await inject('PATCH', `/bank/types/${typeId}`, mgr(), { isActive: false })).statusCode).toBe(200);
    expect((await inject('POST', `/bank/lines/${debit.id}/post`, mgr(), { typeId })).statusCode).toBe(422);
    expect((await inject('PATCH', `/bank/types/${typeId}`, mgr(), { isActive: true })).statusCode).toBe(200);
    expect((await inject('POST', `/bank/lines/${debit.id}/post`, mgr(), { typeId })).statusCode).toBe(201);
  });

  it('needs either a category or a type, never both; cashiers cannot manage types', async () => {
    const acct = await newAccount();
    const lid = await ledgerId();
    const typeId = (await makeType(acct, { name: 'Misc payment', direction: 'EITHER', ledgerId: lid })).json().type.id as string;
    const { lines: ls } = await importLines(acct, [[46, 'NEFT-X', -100]]);
    expect((await inject('POST', `/bank/lines/${ls[0].id}/post`, mgr(), {})).statusCode).toBe(400);
    expect((await inject('POST', `/bank/lines/${ls[0].id}/post`, mgr(), { typeId, category: 'BANK_CHARGE' })).statusCode).toBe(400);

    const cashier = ctx.auth('cashier');
    expect((await inject('GET', `/bank/accounts/${acct}/types`, cashier)).statusCode).toBe(403);
    expect((await inject('POST', `/bank/accounts/${acct}/types`, cashier, { name: 'Sneaky', direction: 'OUT', ledgerId: lid })).statusCode).toBe(403);
  });
});
