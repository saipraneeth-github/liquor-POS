import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIntegration, type IntegrationContext } from './helpers.js';
import { addDays } from '../../src/modules/bank/bank.engine.js';
import { businessDateOf } from '../../src/lib/business-day.js';

let ctx: IntegrationContext;
const today = businessDateOf();

beforeAll(async () => { ctx = await setupIntegration(); }, 60_000);
afterAll(async () => { await ctx?.app.close(); });

const inject = (method: 'GET' | 'POST', url: string, headers: Record<string, string>, payload?: unknown) =>
  ctx.app.inject({ method, url: `/api/v1${url}`, headers, payload: payload as never });
const mgr = () => ctx.auth('manager');
const dmy = (iso: string) => iso.split('-').reverse().join('/');

function multipart(content: string) {
  const b = '----txn' + Math.random().toString(16).slice(2);
  const body = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="s.csv"\r\nContent-Type: text/csv\r\n\r\n`),
    Buffer.from(content), Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  return { body, type: `multipart/form-data; boundary=${b}` };
}

type Line = { id: string; narration: string; status: string };
type Txn = { description: string; amount: string; direction: string; category: string; source: string; reconStatus: string };
type Search = {
  transactions: Txn[];
  totals: { count: number; debit: string; credit: string; net: string };
  byCategory: { category: string; count: number; debit: string; credit: string }[];
};

/** Sample data: rent twice, wages twice, an electricity bill and a customer receipt. [days from today, narration, signed amount] */
const SAMPLE: Array<[number, string, number]> = [
  [-40, 'NEFT-HOTEL RENT OCT', -12000],
  [-38, 'SALARY STAFF OCT', -30000],
  [-12, 'NEFT-HOTEL RENT NOV', -12000],
  [-10, 'SALARY STAFF NOV', -31500],
  [-9, 'ELECTRICITY BILL TSSPDCL', -2450],
  [-8, 'UPI/CUSTOMER/9876 TABLE BOOKING', 5000],
];

let accountId = '';
let lines: Line[] = [];

const search = async (qs: string) => {
  const res = await inject('GET', `/bank/transactions/${ctx.branchId}${qs}`, mgr());
  expect(res.statusCode).toBe(200);
  return res.json() as Search;
};

describe('recorded transactions: categories, rent and wages searches', () => {
  beforeAll(async () => {
    const acct = await inject('POST', '/bank/accounts', mgr(), { branchId: ctx.branchId, name: 'Txn search account' });
    accountId = acct.json().id;
    let bal = 0;
    const rows = SAMPLE.map(([d, narr, amt]) => {
      bal = Math.round((bal + amt) * 100) / 100;
      return `${dmy(addDays(today, d))},"${narr}",${amt < 0 ? (-amt).toFixed(2) : ''},${amt > 0 ? amt.toFixed(2) : ''},${bal.toFixed(2)}`;
    });
    const m = multipart(['Date,Narration,Debit,Credit,Balance', ...rows].join('\n'));
    const res = await ctx.app.inject({ method: 'POST', url: `/api/v1/bank/accounts/${accountId}/statements`, headers: { ...mgr(), 'content-type': m.type }, payload: m.body });
    expect(res.statusCode).toBe(201);
    const statementId = res.json().statement.id as string;
    lines = (await inject('GET', `/bank/statements/${statementId}/lines`, mgr())).json() as Line[];
    expect(lines).toHaveLength(6);
  });

  it('starts empty: nothing has been recorded yet', async () => {
    const r = await search('');
    expect(r.totals.count).toBe(0);
  });

  it('adds the standard categories once, and posting through them records the transactions', async () => {
    const first = await inject('POST', `/bank/accounts/${accountId}/types/defaults`, mgr());
    expect(first.statusCode).toBe(200);
    expect(first.json().created).toEqual(['Rent', 'Wages', 'Utilities', 'Supplies']);
    expect((await inject('POST', `/bank/accounts/${accountId}/types/defaults`, mgr())).json().created).toEqual([]);   // idempotent

    const types = (await inject('GET', `/bank/accounts/${accountId}/types`, mgr())).json() as { id: string; name: string }[];
    const typeId = (name: string) => types.find((t) => t.name === name)!.id;
    const post = async (narration: string, name: string) => {
      const line = lines.find((l) => l.narration === narration)!;
      const res = await inject('POST', `/bank/lines/${line.id}/post`, mgr(), { typeId: typeId(name) });
      expect(res.statusCode, res.body).toBe(201);
    };
    await post('NEFT-HOTEL RENT OCT', 'Rent');
    await post('NEFT-HOTEL RENT NOV', 'Rent');
    await post('SALARY STAFF OCT', 'Wages');
    await post('SALARY STAFF NOV', 'Wages');
    await post('ELECTRICITY BILL TSSPDCL', 'Utilities');
  });

  it('a rent search lists both rent payments with the right total', async () => {
    const r = await search('?q=rent');
    expect(r.transactions.map((t) => t.description).sort()).toEqual(['NEFT-HOTEL RENT NOV', 'NEFT-HOTEL RENT OCT']);
    expect(r.transactions.every((t) => t.category === 'Rent' && t.direction === 'DEBIT' && t.source === 'BANK_STATEMENT' && t.reconStatus === 'MATCHED')).toBe(true);
    expect(r.totals).toEqual({ count: 2, debit: '24000.00', credit: '0.00', net: '-24000.00' });
  });

  it('the same search by category gives the same answer, and narrows by date range', async () => {
    const byCategory = await search('?category=Rent');
    expect(byCategory.totals.debit).toBe('24000.00');
    const lastMonthOnly = await search(`?category=rent&from=${addDays(today, -20)}`);
    expect(lastMonthOnly.transactions.map((t) => t.description)).toEqual(['NEFT-HOTEL RENT NOV']);
    expect(lastMonthOnly.totals.debit).toBe('12000.00');
  });

  it('a wages search lists both salary payments with the right total', async () => {
    const r = await search('?q=wages');
    expect(r.transactions.map((t) => t.description).sort()).toEqual(['SALARY STAFF NOV', 'SALARY STAFF OCT']);
    expect(r.totals).toEqual({ count: 2, debit: '61500.00', credit: '0.00', net: '-61500.00' });
    expect((await search('?category=Wages')).totals.debit).toBe('61500.00');
  });

  it('a keyword also matches the description, and every category has its own total in the same range', async () => {
    const r = await search('?q=electricity');
    expect(r.transactions).toHaveLength(1);
    expect(r.transactions[0].category).toBe('Utilities');

    const all = await search(`?category=rent&from=${addDays(today, -60)}&to=${today}`);
    const totals = Object.fromEntries(all.byCategory.map((c) => [c.category, c.debit]));
    expect(totals).toMatchObject({ Rent: '24000.00', Wages: '61500.00', Utilities: '2450.00' });   // not narrowed by the picked category
  });

  it('a built-in category is searchable by its wording, and money in is a credit', async () => {
    const line = lines.find((l) => l.narration.startsWith('UPI/CUSTOMER'))!;
    const res = await inject('POST', `/bank/lines/${line.id}/post`, mgr(), { category: 'OTHER_RECEIPT', ledgerId: await anyLedger() });
    expect(res.statusCode, res.body).toBe(201);
    const r = await search('?q=other receipt');
    expect(r.totals).toMatchObject({ count: 1, credit: '5000.00', debit: '0.00' });
    expect((await search('?direction=CREDIT')).transactions).toHaveLength(1);
  });

  it('is limited to branches the person can reach, and needs a manager', async () => {
    const cashier = await inject('GET', `/bank/transactions/${ctx.branchId}`, ctx.auth('cashier'));
    expect(cashier.statusCode).toBe(403);
    const bad = await inject('GET', `/bank/transactions/${ctx.branchId}?from=yesterday`, mgr());
    expect(bad.statusCode).toBe(400);
  });
});

async function anyLedger(): Promise<string> {
  const res = await inject('GET', `/accounting/ledgers/${ctx.branchId}`, mgr());
  return (res.json().ledgers as { id: string; code: string }[]).find((l) => l.code === 'MISC_INCOME' || (l.code !== 'BANK' && l.code !== 'CASH'))!.id;
}

describe('transactions are per bank account', () => {
  it('searching with an account shows only that account, and categories total per account', async () => {
    const second = (await inject('POST', '/bank/accounts', mgr(), { branchId: ctx.branchId, name: 'Second account' })).json().id as string;
    await inject('POST', `/bank/accounts/${second}/types/defaults`, mgr());
    const m = multipart(['Date,Narration,Debit,Credit,Balance', `${dmy(addDays(today, -5))},"SHOP RENT DEC",9000,,91000`].join('\n'));
    const up = await ctx.app.inject({ method: 'POST', url: `/api/v1/bank/accounts/${second}/statements`, headers: { ...mgr(), 'content-type': m.type }, payload: m.body });
    expect(up.statusCode, up.body).toBe(201);
    const sid = up.json().statement.id as string;
    const l = ((await inject('GET', `/bank/statements/${sid}/lines`, mgr())).json() as Line[])[0];
    const types = (await inject('GET', `/bank/accounts/${second}/types`, mgr())).json() as { id: string; name: string }[];
    expect((await inject('POST', `/bank/lines/${l.id}/post`, mgr(), { typeId: types.find((t) => t.name === 'Rent')!.id })).statusCode).toBe(201);

    const all = await search('?q=rent');
    expect(all.totals.debit).toBe('33000.00');                       // the branch: 24,000 + 9,000
    const onlySecond = await search(`?q=rent&accountId=${second}`);
    expect(onlySecond.totals).toMatchObject({ count: 1, debit: '9000.00' });
    expect(onlySecond.byCategory.map((c) => c.category)).toEqual(['Rent']);
    const onlyFirst = await search(`?q=rent&accountId=${accountId}`);
    expect(onlyFirst.totals.debit).toBe('24000.00');
    expect(onlyFirst.transactions.every((t) => t.description !== 'SHOP RENT DEC')).toBe(true);
  });
});
