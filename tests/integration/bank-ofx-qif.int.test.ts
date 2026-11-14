import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIntegration, type IntegrationContext } from './helpers.js';

let ctx: IntegrationContext;
beforeAll(async () => { ctx = await setupIntegration(); }, 60_000);
afterAll(async () => { await ctx?.app.close(); });

const mgr = () => ctx.auth('manager');

function multipart(content: string, filename: string) {
  const b = '----fmt' + Math.random().toString(16).slice(2);
  const body = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    Buffer.from(content, 'latin1'), Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  return { body, type: `multipart/form-data; boundary=${b}` };
}
const upload = (accountId: string, path: 'statements' | 'statements/preview', content: string, filename: string) => {
  const m = multipart(content, filename);
  return ctx.app.inject({ method: 'POST', url: `/api/v1/bank/accounts/${accountId}/${path}`, headers: { ...mgr(), 'content-type': m.type }, payload: m.body });
};
async function newAccount(name: string): Promise<string> {
  const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/bank/accounts', headers: mgr(), payload: { branchId: ctx.branchId, name } });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

const ofx = (tag: string) => `OFXHEADER:100
DATA:OFXSGML
VERSION:102
CHARSET:1252

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20310105<TRNAMT>-12000.00<FITID>${tag}1<NAME>NEFT HOTEL RENT</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20310106<TRNAMT>-31500.00<FITID>${tag}2<NAME>SALARY STAFF CAFÉ</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20310107<TRNAMT>5000.00<FITID>${tag}3<NAME>UPI CUSTOMER</STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>61500.00<DTASOF>20310107</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

const qif = (tag: string) => `!Type:Bank
D25/01/2031
T-2,450.00
PElectricity ${tag}
N9001
^
D26/01/2031
T7,000.00
PCustomer ${tag}
^
`;

describe('OFX and QIF statements', () => {
  it('previews an OFX file without saving, with the lines it read', async () => {
    const acct = await newAccount('OFX preview');
    const res = await upload(acct, 'statements/preview', ofx('P'), 'bank.ofx');
    expect(res.statusCode, res.body).toBe(200);
    const p = res.json();
    expect(p.source).toBe('OFX');
    expect(p.lineCount).toBe(3);
    expect(p.periodStart).toBe('2031-01-05');
    expect(p.periodEnd).toBe('2031-01-07');
    expect(p.lines.map((l: { narration: string }) => l.narration)).toContain('SALARY STAFF CAFÉ');   // Latin-1 text read correctly
    const list = await ctx.app.inject({ method: 'GET', url: `/api/v1/bank/accounts/${acct}/statements`, headers: mgr() });
    expect(list.json()).toHaveLength(0);
  });

  it('imports an OFX file, matches nothing it should not, refuses the same file twice and skips repeated lines', async () => {
    const acct = await newAccount('OFX import');
    const res = await upload(acct, 'statements', ofx('I'), 'bank.qfx');
    expect(res.statusCode, res.body).toBe(201);
    const s = res.json().statement;
    expect(s.source).toBe('OFX');
    expect(s.lineCount).toBe(3);
    expect(s.closingBalance).toBe('61500.00');
    const lines = (await ctx.app.inject({ method: 'GET', url: `/api/v1/bank/statements/${s.id}/lines`, headers: mgr() })).json() as { debit: string; credit: string; reference: string | null }[];
    expect(lines.map((l) => [l.debit, l.credit])).toEqual([['12000.00', '0.00'], ['31500.00', '0.00'], ['0.00', '5000.00']]);
    expect(lines[0].reference).toBe('I1');

    expect((await upload(acct, 'statements', ofx('I'), 'bank.ofx')).statusCode).toBe(409);   // the same file again
  });

  it('imports a QIF file with day-first dates and thousands commas', async () => {
    const acct = await newAccount('QIF import');
    const res = await upload(acct, 'statements', qif('Q'), 'export.qif');
    expect(res.statusCode, res.body).toBe(201);
    const s = res.json().statement;
    expect(s.source).toBe('QIF');
    expect(s.periodStart).toBe('2031-01-25');
    const lines = (await ctx.app.inject({ method: 'GET', url: `/api/v1/bank/statements/${s.id}/lines`, headers: mgr() })).json() as { narration: string; debit: string; credit: string }[];
    expect(lines.map((l) => [l.narration, l.debit, l.credit])).toEqual([['Electricity Q', '2450.00', '0.00'], ['Customer Q', '0.00', '7000.00']]);
  });

  it('says plainly when an OFX file has nothing to import', async () => {
    const acct = await newAccount('OFX empty');
    const res = await upload(acct, 'statements', 'OFXHEADER:100\n<OFX><BANKTRANLIST></BANKTRANLIST></OFX>', 'empty.ofx');
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/no transactions/i);
  });
});
