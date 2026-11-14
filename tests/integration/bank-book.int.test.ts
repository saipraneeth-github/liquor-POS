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
  const b = '----book' + Math.random().toString(16).slice(2);
  const body = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="s.csv"\r\nContent-Type: text/csv\r\n\r\n`),
    Buffer.from(content), Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  return { body, type: `multipart/form-data; boundary=${b}` };
}

async function importOne(narration: string, amount: number, dayOffset: number) {
  const acct = (await inject('POST', '/bank/accounts', mgr(), { branchId: ctx.branchId, name: `Book acct ${Math.random().toString(16).slice(2, 8)}` })).json().id as string;
  const row = `${dmy(addDays(today, dayOffset))},"${narration}",${(-amount).toFixed(2)},,${(-amount).toFixed(2)}`;
  const m = multipart(['Date,Narration,Debit,Credit,Balance', row].join('\n'));
  const res = await ctx.app.inject({ method: 'POST', url: `/api/v1/bank/accounts/${acct}/statements`, headers: { ...mgr(), 'content-type': m.type }, payload: m.body });
  expect(res.statusCode).toBe(201);
  const statementId = res.json().statement.id as string;
  const lines = (await inject('GET', `/bank/statements/${statementId}/lines`, mgr())).json() as { id: string; narration: string }[];
  return { statementId, lineId: lines[0].id };
}

describe('the book side of a statement', () => {
  it('lists BANK-ledger entries around the statement dates, and says which line each is matched to', async () => {
    const { statementId, lineId } = await importOne('SMS CHARGES BOOKVIEW', 23.6, 55);
    expect((await inject('GET', `/bank/statements/${statementId}/book`, mgr())).json()).toEqual([]);   // nothing posted yet

    const posted = await inject('POST', `/bank/lines/${lineId}/post`, mgr(), { category: 'BANK_CHARGE' });
    expect(posted.statusCode).toBe(201);

    const book = (await inject('GET', `/bank/statements/${statementId}/book`, mgr())).json() as { id: string; credit: string; debit: string; voucherNumber: string; matchedLineId: string | null }[];
    const entry = book.find((e) => e.matchedLineId === lineId);
    expect(entry).toBeTruthy();
    expect(Number(entry!.credit)).toBeCloseTo(23.6, 2);       // money out of the bank is a credit to the BANK ledger
    expect(entry!.voucherNumber).toBeTruthy();
  });

  it('is for managers of that account only', async () => {
    const { statementId } = await importOne('NEFT-BOOKVIEW-ACCESS', 100, 56);
    expect((await inject('GET', `/bank/statements/${statementId}/book`, ctx.auth('cashier'))).statusCode).toBe(403);
    expect((await inject('GET', `/bank/statements/00000000-0000-4000-8000-000000000000/book`, mgr())).statusCode).toBe(404);
  });
});
