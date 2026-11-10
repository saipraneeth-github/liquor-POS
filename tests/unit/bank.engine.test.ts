import { describe, it, expect } from 'vitest';
import {
  assignHashes, classifyHeader, detectDayFirst, detectMapping, feePosting, hintCategory, looksLikeMoney, matchIgnoreRule, parseBankDate, parseMoney,
  postingForCategory, rowsToLines, scanBalanceHints, suggestMatches, suggestPattern, summarise, textLinesToTable, verifyBalanceChain,
  type BookEntry, type IgnoreRule, type MatchLine,
} from '../../src/modules/bank/bank.engine.js';

// Synthetic statements in the layouts different Indian banks use. No real customer data.
const lakh = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Builds ledger rows with correct running balances from (date, narration, ±amount). */
function ledger(opening: number, items: Array<[string, string, number]>) {
  let bal = opening;
  return items.map(([date, narr, amt]) => { bal = Math.round((bal + amt) * 100) / 100; return { date, narr, amt, bal }; });
}
const ITEMS: Array<[string, string, number]> = [
  ['01/04/2026', 'UPI-RAZORPAY SETTLEMENT-HDFC0001234', 18420.5],
  ['02/04/2026', 'NEFT-RAJ BEVERAGES-SI-2291', -64000],
  ['02/04/2026', 'CASH DEPOSIT BY SELF', 40000],
  ['03/04/2026', 'SMS ALERT CHARGES Q1', -23.6],
  ['04/04/2026', 'ATM WDL 12345', -5000],
];
const OPENING = 210000;

function runCsv(rows: string[][]) {
  const m = detectMapping(rows);
  const hints = scanBalanceHints(rows);
  const res = rowsToLines(rows, m.headerRow, m.mapping, { opening: hints.opening });
  return { m, hints, ...res, check: verifyBalanceChain(res.lines, hints) };
}

describe('parseMoney', () => {
  it('reads Indian grouping, currency marks, signs and Dr/Cr', () => {
    expect(parseMoney('1,23,456.78')!.value.toFixed(2)).toBe('123456.78');
    expect(parseMoney('₹ 1,234.00')!.value.toFixed(2)).toBe('1234.00');
    expect(parseMoney('Rs. 500')!.value.toFixed(2)).toBe('500.00');
    expect(parseMoney('(500.00)')!.negative).toBe(true);
    expect(parseMoney('-500.00')!.negative).toBe(true);
    expect(parseMoney('500.00-')!.negative).toBe(true);
    expect(parseMoney('1,000.00 Cr')).toMatchObject({ side: 'CR' });
    expect(parseMoney('2,500.00Dr')).toMatchObject({ side: 'DR' });
    expect(parseMoney('Dr 250.00')).toMatchObject({ side: 'DR' });
  });
  it('rejects blanks, dashes, dates and text', () => {
    for (const v of ['', ' ', '-', '--', 'NA', 'N/A', '31/03/2026', 'abc', null, undefined]) expect(parseMoney(v as string)).toBeNull();
  });
  it('looksLikeMoney needs decimals or comma grouping, so a long reference number is not an amount', () => {
    expect(looksLikeMoney('1,500.00')).toBe(true);
    expect(looksLikeMoney('500.5')).toBe(true);
    expect(looksLikeMoney('123456789012')).toBe(false);
  });
});

describe('parseBankDate', () => {
  it('reads every common layout', () => {
    expect(parseBankDate('31/03/2026')).toBe('2026-03-31');
    expect(parseBankDate('31-03-26')).toBe('2026-03-31');
    expect(parseBankDate('31.03.2026')).toBe('2026-03-31');
    expect(parseBankDate('31 Mar 2026')).toBe('2026-03-31');
    expect(parseBankDate('31-Mar-26')).toBe('2026-03-31');
    expect(parseBankDate('Mar 31, 2026')).toBe('2026-03-31');
    expect(parseBankDate('2026-03-31')).toBe('2026-03-31');
    expect(parseBankDate('31/03/2026 14:22:10')).toBe('2026-03-31');
    expect(parseBankDate('2026-03-31T10:00:00')).toBe('2026-03-31');
  });
  it('is day-first for ambiguous dates unless told otherwise', () => {
    expect(parseBankDate('04/05/2026')).toBe('2026-05-04');
    expect(parseBankDate('04/05/2026', false)).toBe('2026-04-05');
  });
  it('reads Excel serial numbers and refuses impossible dates', () => {
    expect(parseBankDate('46112')).toBe('2026-03-31');
    expect(parseBankDate('31/02/2026')).toBeNull();
    expect(parseBankDate('13/13/2026')).toBeNull();
    expect(parseBankDate('hello')).toBeNull();
  });
  it('detectDayFirst flips only when the data proves month-first', () => {
    expect(detectDayFirst(['04/05/2026', '15/05/2026'])).toBe(true);
    expect(detectDayFirst(['04/05/2026', '05/15/2026'])).toBe(false);
    expect(detectDayFirst(['04/05/2026'])).toBe(true);
  });
});

describe('header recognition', () => {
  it.each([
    ['Date', 'date'], ['Txn Date', 'date'], ['Transaction Date', 'date'], ['Tran Date', 'date'], ['Posting Date', 'date'],
    ['Value Dt', 'valueDate'], ['Value Date', 'valueDate'],
    ['Narration', 'narration'], ['Particulars', 'narration'], ['Transaction Remarks', 'narration'], ['Description', 'narration'],
    ['Chq./Ref.No.', 'reference'], ['Cheque Number', 'reference'], ['Ref No./Cheque No.', 'reference'], ['UTR', 'reference'],
    ['Withdrawal Amt.', 'debit'], ['Withdrawal Amount (INR)', 'debit'], ['Debit', 'debit'], ['Dr', 'debit'], ['Debit Amount', 'debit'],
    ['Deposit Amt.', 'credit'], ['Deposit Amount (INR)', 'credit'], ['Credit', 'credit'], ['Cr', 'credit'],
    ['Closing Balance', 'balance'], ['Balance', 'balance'], ['Balance (INR)', 'balance'], ['Running Balance', 'balance'],
    ['Amount', 'amount'], ['Transaction Amount', 'amount'], ['Amount (INR)', 'amount'],
    ['Dr/Cr', 'drCr'], ['Cr/Dr', 'drCr'], ['Transaction Type', 'drCr'],
  ])('%s → %s', (header, key) => expect(classifyHeader(header)).toBe(key));

  it('ignores columns that carry no information', () => {
    for (const h of ['S No.', 'Sl. No.', '', 'Branch Code', 'Page']) expect(classifyHeader(h)).toBeNull();
  });
});

describe('statement layouts from different banks (no per-bank template)', () => {
  const L = ledger(OPENING, ITEMS);
  const expectLines = (r: ReturnType<typeof runCsv>) => {
    expect(r.lines).toHaveLength(5);
    expect(r.lines[0]).toMatchObject({ txnDate: '2026-04-01', credit: '18420.50', debit: '0.00' });
    expect(r.lines[1]).toMatchObject({ txnDate: '2026-04-02', debit: '64000.00', credit: '0.00' });
    expect(r.lines[3]).toMatchObject({ debit: '23.60' });
    expect(r.lines[4].balance).toBe(L[4].bal.toFixed(2));
    expect(r.check.status).toBe('PASS');
    expect(r.check.opening).toBe('210000.00');
    expect(r.check.closing).toBe(L[4].bal.toFixed(2));
  };

  it('Layout A — preamble rows, Withdrawal/Deposit columns, dd/mm/yy, lakh commas', () => {
    const rows = [
      ['HDFC BANK LIMITED'], ['Account Branch : MG ROAD'], ['Statement From : 01/04/2026 To : 05/04/2026'], [],
      ['Date', 'Narration', 'Chq./Ref.No.', 'Value Dt', 'Withdrawal Amt.', 'Deposit Amt.', 'Closing Balance'],
      ...L.map((x) => [x.date.replace('/2026', '/26'), x.narr, '0000' + Math.abs(x.amt).toFixed(0), x.date.replace('/2026', '/26'),
        x.amt < 0 ? lakh(-x.amt) : '', x.amt > 0 ? lakh(x.amt) : '', lakh(x.bal)]),
    ];
    const r = runCsv(rows);
    expect(r.m.method).toBe('HEADER');
    expect(r.m.headerRow).toBe(4);
    expectLines(r);
  });

  it('Layout B — serial column, Transaction Remarks, "(INR)" headers', () => {
    const rows = [
      ['Detailed Statement'], ['Transactions List - Current Account'],
      ['S No.', 'Value Date', 'Transaction Date', 'Cheque Number', 'Transaction Remarks', 'Withdrawal Amount (INR)', 'Deposit Amount (INR)', 'Balance (INR)'],
      ...L.map((x, i) => [String(i + 1), x.date, x.date, '-', x.narr, x.amt < 0 ? (-x.amt).toFixed(2) : '0.00', x.amt > 0 ? x.amt.toFixed(2) : '0.00', x.bal.toFixed(2)]),
    ];
    const r = runCsv(rows);
    expect(r.m.mapping).toMatchObject({ valueDate: 1, date: 2, narration: 4, debit: 5, credit: 6, balance: 7 });
    expectLines(r);
  });

  it('Layout C — Debit/Credit columns with "01 Apr 2026" dates', () => {
    const rows = [
      ['Txn Date', 'Value Date', 'Description', 'Ref No./Cheque No.', 'Debit', 'Credit', 'Balance'],
      ...L.map((x) => {
        const d = new Date(`${x.date.split('/').reverse().join('-')}T00:00:00Z`);
        const s = `${String(d.getUTCDate()).padStart(2, '0')} ${['Jan', 'Feb', 'Mar', 'Apr'][d.getUTCMonth()]} ${d.getUTCFullYear()}`;
        return [s, s, x.narr, '', x.amt < 0 ? lakh(-x.amt) : '', x.amt > 0 ? lakh(x.amt) : '', lakh(x.bal)];
      }),
    ];
    expectLines(runCsv(rows));
  });

  it('Layout D — one Amount column plus a Dr/Cr column', () => {
    const rows = [
      ['Date', 'Particulars', 'Amount', 'Dr/Cr', 'Balance'],
      ...L.map((x) => [x.date, x.narr, lakh(Math.abs(x.amt)), x.amt < 0 ? 'DR' : 'CR', lakh(x.bal)]),
    ];
    expectLines(runCsv(rows));
  });

  it('Layout E — a single Amount column with NO direction: the running balance decides', () => {
    const rows = [
      ['Opening Balance', '', lakh(OPENING)],
      ['Date', 'Narration', 'Amount', 'Balance'],
      ...L.map((x) => [x.date, x.narr, lakh(Math.abs(x.amt)), lakh(x.bal)]),
    ];
    const r = runCsv(rows);
    expect(r.lines.map((l) => (l.credit !== '0.00' ? 'CR' : 'DR'))).toEqual(['CR', 'DR', 'CR', 'DR', 'DR']);
    expect(r.lines.every((l) => !l.flags.includes('DIRECTION_GUESSED'))).toBe(true);
    expect(r.check.status).toBe('PASS');
  });

  it('Layout E without an opening balance: the FIRST line is genuinely ambiguous, so it is flagged, not silently guessed', () => {
    const rows = [
      ['Date', 'Narration', 'Amount', 'Balance'],
      ...L.map((x) => [x.date, x.narr, lakh(Math.abs(x.amt)), lakh(x.bal)]),
    ];
    const r = runCsv(rows);
    expect(r.lines[0].flags).toContain('DIRECTION_GUESSED');
    expect(r.lines[0].confidence).toBeLessThanOrEqual(0.4);
    // every later line is fixed by the balance step from the line before it
    expect(r.lines.slice(1).map((l) => (l.credit !== '0.00' ? 'CR' : 'DR'))).toEqual(['DR', 'CR', 'DR', 'DR']);
    expect(r.lines.slice(1).every((l) => !l.flags.includes('DIRECTION_GUESSED'))).toBe(true);
  });

  it('Layout F — Dr/Cr written as a suffix on the amount and on the balance', () => {
    const rows = [
      ['Date', 'Narration', 'Amount', 'Balance'],
      ...L.map((x) => [x.date, x.narr, `${lakh(Math.abs(x.amt))} ${x.amt < 0 ? 'Dr' : 'Cr'}`, `${lakh(x.bal)} Cr`]),
    ];
    expectLines(runCsv(rows));
  });

  it('newest-first exports are put back in order using the balance chain', () => {
    const rows = [
      ['Date', 'Narration', 'Debit', 'Credit', 'Balance'],
      ...[...L].reverse().map((x) => [x.date, x.narr, x.amt < 0 ? (-x.amt).toFixed(2) : '', x.amt > 0 ? x.amt.toFixed(2) : '', x.bal.toFixed(2)]),
    ];
    const r = runCsv(rows);
    expect(r.lines[0].narration).toContain('RAZORPAY');
    expect(r.lines[4].narration).toContain('ATM');
    expect(r.check.status).toBe('PASS');
  });

  it('narration wrapped onto a second row is rejoined, not read as a transaction', () => {
    const rows = [
      ['Date', 'Narration', 'Debit', 'Credit', 'Balance'],
      ['01/04/2026', 'NEFT-LONG BENEFICIARY NAME', '', '1000.00', '1000.00'],
      ['', 'PRIVATE LIMITED-INV 4471', '', '', ''],
      ['02/04/2026', 'ATM WDL', '200.00', '', '800.00'],
    ];
    const r = runCsv(rows);
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0].narration).toBe('NEFT-LONG BENEFICIARY NAME PRIVATE LIMITED-INV 4471');
  });

  it('repeated header rows from page breaks are skipped', () => {
    const header = ['Date', 'Narration', 'Debit', 'Credit', 'Balance'];
    const rows = [header, ['01/04/2026', 'A', '', '100.00', '100.00'], header, ['02/04/2026', 'B', '10.00', '', '90.00']];
    expect(runCsv(rows).lines).toHaveLength(2);
  });

  it('no recognisable header: columns are inferred from what the cells look like', () => {
    const rows = ITEMS.length && ledger(OPENING, ITEMS).map((x) => [x.date, x.narr, x.amt < 0 ? lakh(-x.amt) : '', x.amt > 0 ? lakh(x.amt) : '', lakh(x.bal)]);
    const m = detectMapping(rows as string[][]);
    expect(m.method).toBe('CONTENT');
    expect(m.mapping).toMatchObject({ date: 0, narration: 1, debit: 2, credit: 3, balance: 4 });
    const res = rowsToLines(rows as string[][], -1, m.mapping);
    expect(res.lines).toHaveLength(5);
    expect(verifyBalanceChain(res.lines).status).toBe('PASS');
  });

  it('two sparse money columns with no balance are Debit | Credit, not Amount | Balance (no transaction may be lost)', () => {
    const rows = [['14/11/2026', 'Mystery receipt', '', '75.00'], ['14/11/2026', 'Mystery payment', '30.00', ''], ['15/11/2026', 'Another receipt', '', '10.50']];
    const m = detectMapping(rows);
    expect(m.mapping).toMatchObject({ date: 0, narration: 1, debit: 2, credit: 3 });
    expect(m.mapping.balance).toBeUndefined();
    const res = rowsToLines(rows, -1, m.mapping);
    expect(res.lines).toHaveLength(3);
    expect(res.lines.map((l) => [l.debit, l.credit])).toEqual([['0.00', '75.00'], ['30.00', '0.00'], ['0.00', '10.50']]);
    expect(res.lines.every((l) => !l.flags.includes('DIRECTION_GUESSED'))).toBe(true);
  });

  it('an Amount column next to a Balance column (filled together) is still read as Amount | Balance', () => {
    const rows = [['01/04/2026', 'A', '100.00', '1,100.00'], ['02/04/2026', 'B', '50.00', '1,050.00'], ['03/04/2026', 'C', '25.00', '1,075.00']];
    const m = detectMapping(rows);
    expect(m.mapping).toMatchObject({ amount: 2, balance: 3 });
  });

  it('a row with a date but no readable amount is reported as skipped, never dropped silently', () => {
    const rows = [['Date', 'Narration', 'Debit', 'Credit'], ['01/04/2026', 'Good', '', '10.00'], ['02/04/2026', 'Unreadable amount', 'see note', ''], ['03/04/2026', 'Good too', '5.00', '']];
    const r = rowsToLines(rows, 0, { date: 0, narration: 1, debit: 2, credit: 3 });
    expect(r.lines).toHaveLength(2);
    expect(r.skipped).toEqual([{ row: 2, reason: 'NO_AMOUNT' }]);
  });

  it('month-first dates in a file are detected, not silently misread', () => {
    const rows = [['Date', 'Narration', 'Debit', 'Credit', 'Balance'], ['04/15/2026', 'X', '', '10.00', '10.00'], ['05/01/2026', 'Y', '', '5.00', '15.00']];
    const r = runCsv(rows);
    expect(r.dayFirst).toBe(false);
    expect(r.lines.map((l) => l.txnDate)).toEqual(['2026-04-15', '2026-05-01']);
  });

  it('a statement the engine cannot recognise reports confidence 0 instead of guessing', () => {
    expect(detectMapping([['hello', 'world'], ['foo', 'bar']]).confidence).toBe(0);
  });
});

describe('opening / closing balances printed outside the table', () => {
  it('are picked up from summary rows', () => {
    const rows = [['Opening Balance', '', '2,10,000.00'], ['Closing Balance', '', '2,49,396.90'], ['Date', 'Narration', 'Debit', 'Credit', 'Balance']];
    expect(scanBalanceHints(rows)).toEqual({ opening: '210000.00', closing: '249396.90' });
  });
});

describe('verifyBalanceChain — the statement must agree with itself', () => {
  const base = () => rowsToLines([
    ['Date', 'Narration', 'Debit', 'Credit', 'Balance'],
    ['01/04/2026', 'A', '', '100.00', '1100.00'],
    ['02/04/2026', 'B', '50.00', '', '1050.00'],
    ['03/04/2026', 'C', '', '25.00', '1075.00'],
  ], 0, { date: 0, narration: 1, debit: 2, credit: 3, balance: 4 }).lines;

  it('passes when every balance follows', () => {
    const c = verifyBalanceChain(base());
    expect(c).toMatchObject({ status: 'PASS', opening: '1000.00', closing: '1075.00', totalCredit: '125.00', totalDebit: '50.00' });
  });
  it('fails and names the line when a row is misread', () => {
    const lines = base();
    lines[1].debit = '5.00';          // 50.00 misread as 5.00
    const c = verifyBalanceChain(lines);
    expect(c.status).toBe('FAIL');
    expect(c.breaks[0]).toMatchObject({ lineNo: 2, expected: '1095.00', actual: '1050.00' });
    expect(c.message).toMatch(/line 2/);
  });
  it('does not cascade: one bad line is one break', () => {
    const lines = base();
    lines[0].credit = '90.00';
    expect(verifyBalanceChain(lines, { opening: '1000.00', closing: null }).breaks).toHaveLength(1);
  });
  it('a missing row breaks the chain at the next line', () => {
    const lines = base();
    lines.splice(1, 1);
    expect(verifyBalanceChain(lines).status).toBe('FAIL');
  });
  it('compares the stated closing balance with the last running balance', () => {
    expect(verifyBalanceChain(base(), { opening: null, closing: '9999.00' }).status).toBe('FAIL');
  });
  it('without running balances it falls back to opening + movement = closing, else says it cannot verify', () => {
    const lines = rowsToLines([['Date', 'Narration', 'Debit', 'Credit'], ['01/04/2026', 'A', '', '100.00'], ['02/04/2026', 'B', '30.00', '']], 0,
      { date: 0, narration: 1, debit: 2, credit: 3 }).lines;
    expect(verifyBalanceChain(lines, { opening: '1000.00', closing: '1070.00' }).status).toBe('PASS');
    expect(verifyBalanceChain(lines, { opening: '1000.00', closing: '1080.00' }).status).toBe('FAIL');
    expect(verifyBalanceChain(lines).status).toBe('UNVERIFIABLE');
  });
  it('tracks continuous running balance across intermittent null-balance lines with checkpoints', () => {
    const lines = [
      { lineNo: 1, txnDate: '2026-04-01', valueDate: null, narration: 'NEFT IN', reference: null, debit: '0.00', credit: '100.00', balance: '1100.00', confidence: 1, flags: [] },
      { lineNo: 2, txnDate: '2026-04-01', valueDate: null, narration: 'NEFT IN 2', reference: null, debit: '0.00', credit: '50.00', balance: null, confidence: 1, flags: [] },
      { lineNo: 3, txnDate: '2026-04-02', valueDate: null, narration: 'NEFT OUT', reference: null, debit: '20.00', credit: '0.00', balance: '1130.00', confidence: 1, flags: [] },
    ];
    const res = verifyBalanceChain(lines, { opening: '1000.00', closing: '1130.00' });
    expect(res.status).toBe('PASS');
    expect(res.checked).toBe(2);
    expect(res.breaks).toHaveLength(0);
  });
  it('an empty statement is unverifiable', () => expect(verifyBalanceChain([]).status).toBe('UNVERIFIABLE'));
});

describe('PDF / OCR text lines', () => {
  const text = [
    'ACME BANK  Statement of Account',
    'Account No: XXXXXX4821   Branch: MG Road',
    'Opening Balance  2,10,000.00',
    'Date  Narration  Withdrawals  Deposits  Balance',
    '01/04/2026  UPI/RAZORPAY SETTLEMENT/412345678901  18,420.50  2,28,420.50',
    '02/04/2026  NEFT-RAJ BEVERAGES-SI-2291  64,000.00  1,64,420.50',
    '           PRIVATE LIMITED',
    '02/04/2026  CASH DEPOSIT BY SELF  40,000.00  2,04,420.50',
    '03/04/2026  SMS ALERT CHARGES Q1  23.60  2,04,396.90',
    'Page 1 of 2',
    'Closing Balance  2,04,396.90',
  ];

  it('reads transactions without any column headers, directions come from the balance', () => {
    const t = textLinesToTable(text);
    expect(t.hints).toEqual({ opening: '210000.00', closing: '204396.90' });
    const r = rowsToLines(t.rows, t.headerRow, t.mapping, { opening: t.hints.opening });
    expect(r.lines).toHaveLength(4);
    expect(r.lines.map((l) => (l.credit !== '0.00' ? 'CR' : 'DR'))).toEqual(['CR', 'DR', 'CR', 'DR']);
    expect(r.lines[1].narration).toBe('NEFT-RAJ BEVERAGES-SI-2291 PRIVATE LIMITED');
    expect(r.lines[0].reference).toBe('412345678901');
    expect(verifyBalanceChain(r.lines, t.hints).status).toBe('PASS');
  });

  it('honours Dr/Cr suffixes when the statement prints them', () => {
    const t = textLinesToTable([
      '01/04/2026  CHEQUE DEPOSIT  1,000.00 Cr  11,000.00 Cr',
      '02/04/2026  ATM WDL  500.00 Dr  10,500.00 Cr',
    ]);
    const r = rowsToLines(t.rows, 0, t.mapping);
    expect(r.lines[0]).toMatchObject({ credit: '1000.00', debit: '0.00' });
    expect(r.lines[1]).toMatchObject({ debit: '500.00', credit: '0.00' });
  });

  it('a reference number is not mistaken for an amount (amounts need decimals)', () => {
    const t = textLinesToTable(['05/04/2026  IMPS/P2A/509412345678/ACME  1,250.00  9,000.00']);
    expect(t.rows[1][4]).toBe('1,250.00');
    expect(t.rows[1][6]).toBe('9,000.00');
  });

  it('guesses direction from the narration ONLY when there is no balance, and flags it', () => {
    const t = textLinesToTable(['01/04/2026  SALARY CREDIT  50,000.00', '02/04/2026  ELECTRICITY BILL  1,200.00']);
    const r = rowsToLines(t.rows, 0, t.mapping);
    expect(r.lines[0].credit).toBe('50000.00');
    expect(r.lines[1].debit).toBe('1200.00');
    expect(r.lines.every((l) => l.flags.includes('DIRECTION_GUESSED') && l.confidence <= 0.4)).toBe(true);
  });

  it('matches amounts with multiple spaces before Cr/Dr marker', () => {
    const t = textLinesToTable(['01/10/2026  By-Transfer NEFT : UTIB  01/10/2026  969194.38  980294.65  Cr']);
    expect(t.rows[1][4]).toBe('969194.38');
    expect(t.rows[1][6]).toBe('980294.65  Cr');
  });

  it('skips date-prefixed Balance C/F and Balance B/F lines while updating hints', () => {
    const t = textLinesToTable([
      'Opening Balance  11100.27  Cr',
      '01/10/2026  By-Transfer NEFT  01/10/2026  969194.38  980294.65  Cr',
      '03-10-2026  Balance C/F  2900059.00  2912197.53  23238.80 Cr',
      '03-10-2026  Balance B/F  23238.80  Cr',
      '03/10/2026  By-Transfer NEFT  03/10/2026  49306.92',
      'Balance C/F  72545.72  Cr',
    ]);
    expect(t.hints).toEqual({ opening: '11100.27', closing: '72545.72' });
    expect(t.rows).toHaveLength(3);
    expect(t.rows[1][2]).toContain('By-Transfer NEFT');
    expect(t.rows[2][2]).toContain('By-Transfer NEFT');
  });

  it('infers credit for By- and debit for To- Indian banking prefixes with high confidence', () => {
    const t = textLinesToTable([
      '01/10/2026  By-Transfer NEFT : HDFC0000240  1500.00',
      '03/10/2026  To-Mail Transfer RTGS  2900059.00',
    ]);
    const r = rowsToLines(t.rows, 0, t.mapping);
    expect(r.lines[0]).toMatchObject({ credit: '1500.00', debit: '0.00' });
    expect(r.lines[0].confidence).toBeGreaterThanOrEqual(0.8);
    expect(r.lines[1]).toMatchObject({ debit: '2900059.00', credit: '0.00' });
    expect(r.lines[1].confidence).toBeGreaterThanOrEqual(0.8);
  });
});

describe('assignHashes — overlapping statements must not double-count', () => {
  const mk = (n: number) => rowsToLines([['Date', 'Narration', 'Debit', 'Credit', 'Balance'],
    ...Array.from({ length: n }, (_, i) => ['01/04/2026', 'SAME', '', '10.00', String(10 * (i + 1)) + '.00'])], 0,
  { date: 0, narration: 1, debit: 2, credit: 3, balance: 4 }).lines;

  it('is stable for the same transaction in two files', () => {
    const a = assignHashes(mk(3));
    const b = assignHashes(mk(5));
    expect(b.slice(0, 3).map((l) => l.hash)).toEqual(a.map((l) => l.hash));
    expect(new Set(b.map((l) => l.hash)).size).toBe(5);
  });
  it('gives two genuinely identical lines in one file different identities', () => {
    const lines = assignHashes(rowsToLines([['Date', 'Narration', 'Debit', 'Credit'], ['01/04/2026', 'COFFEE', '50.00', ''], ['01/04/2026', 'COFFEE', '50.00', '']], 0,
      { date: 0, narration: 1, debit: 2, credit: 3 }).lines);
    expect(lines[0].hash).not.toBe(lines[1].hash);
  });
});

describe('hintCategory', () => {
  const h = (narration: string, side: 'debit' | 'credit') => hintCategory({ narration, debit: side === 'debit' ? '10.00' : '0.00', credit: side === 'credit' ? '10.00' : '0.00' });
  it('flags charges, interest, cash and settlements', () => {
    expect(h('SMS ALERT CHARGES', 'debit')).toBe('BANK_CHARGE');
    expect(h('GST ON CHARGES', 'debit')).toBe('BANK_CHARGE');
    expect(h('ATM WDL', 'debit')).toBe('CASH_WITHDRAWAL');
    expect(h('INT.PD:01-01-2026 TO 31-03-2026', 'credit')).toBe('INTEREST');
    expect(h('CASH DEPOSIT BY SELF', 'credit')).toBe('CASH_DEPOSIT');
    expect(h('RAZORPAY SETTLEMENT', 'credit')).toBe('SETTLEMENT');
  });
  it('does not guess for an ordinary transfer, and respects direction', () => {
    expect(h('NEFT-RAJ BEVERAGES', 'debit')).toBeNull();
    expect(h('SMS ALERT CHARGES', 'credit')).toBeNull();
  });
});

describe('suggestMatches', () => {
  let n = 0;
  const entry = (date: string, debit: string, credit: string, narration: string, sourceType = 'BILL'): BookEntry => ({ id: `e${++n}`, date, debit, credit, narration, sourceType });
  const line = (id: string, date: string, side: 'in' | 'out', amount: string, narration = '', reference: string | null = null): MatchLine =>
    ({ id, date, debit: side === 'out' ? amount : '0.00', credit: side === 'in' ? amount : '0.00', narration, reference });

  it('1:1 — same amount and direction within a few days', () => {
    const e = entry('2026-04-02', '0.00', '64000.00', 'e-Challan/DD payment SI-2291 for Raj Beverages', 'SUPPLIER_CHALLAN');
    const s = suggestMatches([line('L1', '2026-04-03', 'out', '64000.00', 'NEFT-RAJ BEVERAGES-SI-2291')], [e]).get('L1')!;
    expect(s.kind).toBe('ONE_TO_ONE');
    expect(s.kind === 'ONE_TO_ONE' && s.entryIds).toEqual([e.id]);
    expect(s.confidence).toBeGreaterThan(0.8);
  });

  it('1:1 — direction matters: a receipt is never matched to a payment', () => {
    const e = entry('2026-04-02', '0.00', '500.00', 'Expense', 'EXPENSE');
    expect(suggestMatches([line('L1', '2026-04-02', 'in', '500.00')], [e]).get('L1')).toBeNull();
  });

  it('1:1 — outside the date window is not matched', () => {
    const e = entry('2026-03-01', '500.00', '0.00', 'Sales bill A (UPI)');
    expect(suggestMatches([line('L1', '2026-04-02', 'in', '500.00')], [e]).get('L1')).toBeNull();
  });

  it('1:1 — two identical candidates lower the confidence so a human looks', () => {
    const a = entry('2026-04-02', '300.00', '0.00', 'Sales bill A (UPI)');
    const b = entry('2026-04-02', '300.00', '0.00', 'Sales bill B (UPI)');
    const s = suggestMatches([line('L1', '2026-04-02', 'in', '300.00')], [a, b]).get('L1')!;
    expect(s.confidence).toBeLessThan(0.7);
    expect(s.reason).toMatch(/confirm/);
  });

  it('a book entry is suggested to at most one line', () => {
    const e = entry('2026-04-02', '300.00', '0.00', 'Sales bill A (UPI)');
    const res = suggestMatches([line('L1', '2026-04-02', 'in', '300.00'), line('L2', '2026-04-02', 'in', '300.00')], [e]);
    expect([res.get('L1'), res.get('L2')].filter((s) => s?.kind === 'ONE_TO_ONE')).toHaveLength(1);
  });

  it('settlement — a payout equals several days of card/UPI sales less the gateway fee', () => {
    const sales = [
      entry('2026-04-01', '6000.00', '0.00', 'Sales bill M-1 (UPI)'),
      entry('2026-04-01', '4000.00', '0.00', 'Sales bill M-2 (CARD)'),
      entry('2026-04-02', '8000.00', '0.00', 'Sales bill M-3 (UPI)'),
    ];
    // 18,000 of sales − 2% fee = 17,640 arrives on the 4th
    const s = suggestMatches([line('P', '2026-04-04', 'in', '17640.00', 'RAZORPAY SETTLEMENT')], sales).get('P')!;
    expect(s.kind).toBe('SETTLEMENT');
    if (s.kind !== 'SETTLEMENT') return;
    expect(s.entryIds.sort()).toEqual(sales.map((e) => e.id).sort());
    expect(s.expected).toBe('18000.00');
    expect(s.fee).toBe('360.00');
    expect(s.feePct).toBe(2);
    expect(s.confidence).toBeGreaterThanOrEqual(0.7);   // gateway named in the narration
  });

  it('settlement — card-only and UPI-only payouts are recognised separately', () => {
    const sales = [
      entry('2026-04-01', '6000.00', '0.00', 'Sales bill M-1 (UPI)'),
      entry('2026-04-01', '4000.00', '0.00', 'Sales bill M-2 (CARD)'),
    ];
    const s = suggestMatches([line('C', '2026-04-03', 'in', '3920.00', 'HDFC POS SETTLEMENT')], sales).get('C')!;
    expect(s.kind === 'SETTLEMENT' && s.mode).toBe('CARD');
    expect(s.kind === 'SETTLEMENT' && s.fee).toBe('80.00');
  });

  it('settlement — a voided sale inside the window nets off', () => {
    const sales = [
      entry('2026-04-01', '5000.00', '0.00', 'Sales bill M-1 (UPI)'),
      entry('2026-04-01', '1000.00', '0.00', 'Sales bill M-2 (UPI)'),
      entry('2026-04-01', '0.00', '1000.00', 'Reversal of bill M-2: customer returned', 'BILL_VOID'),
    ];
    const s = suggestMatches([line('P', '2026-04-02', 'in', '4950.00', 'UPI SETTLEMENT')], sales).get('P')!;
    expect(s.kind).toBe('SETTLEMENT');
    expect(s.kind === 'SETTLEMENT' && s.expected).toBe('5000.00');
  });

  it('settlement — a fee above the limit is not treated as a fee', () => {
    const sales = [entry('2026-04-01', '10000.00', '0.00', 'Sales bill M-1 (UPI)')];
    expect(suggestMatches([line('P', '2026-04-02', 'in', '8000.00', 'SETTLEMENT')], sales).get('P')).toBeNull();
  });

  it('settlement — a payout larger than the sales is never matched', () => {
    const sales = [entry('2026-04-01', '1000.00', '0.00', 'Sales bill M-1 (UPI)')];
    expect(suggestMatches([line('P', '2026-04-02', 'in', '1200.00', 'SETTLEMENT')], sales).get('P')).toBeNull();
  });

  it('nothing in the books: hints a category so it can be posted in one click', () => {
    const res = suggestMatches([
      line('A', '2026-04-03', 'out', '23.60', 'SMS ALERT CHARGES Q1'),
      line('B', '2026-04-03', 'in', '40000.00', 'CASH DEPOSIT BY SELF'),
      line('C', '2026-04-03', 'out', '777.00', 'NEFT-SOMEONE'),
    ], []);
    expect(res.get('A')).toMatchObject({ kind: 'POST', category: 'BANK_CHARGE' });
    expect(res.get('B')).toMatchObject({ kind: 'POST', category: 'CASH_DEPOSIT' });
    expect(res.get('C')).toBeNull();
  });
});

describe('ignore rules', () => {
  const rule = (over: Partial<IgnoreRule> = {}): IgnoreRule => ({
    id: 'r1', pattern: 'swiggy', side: 'ANY', minAmount: null, maxAmount: null, reason: 'PERSONAL', action: 'SUGGEST', isActive: true, ...over,
  });
  const line = (narration: string, side: 'debit' | 'credit' = 'debit', amount = '250.00', reference: string | null = null) =>
    ({ narration, reference, debit: side === 'debit' ? amount : '0.00', credit: side === 'credit' ? amount : '0.00' });

  it('matches the text anywhere in the narration or reference, in any case and spacing', () => {
    expect(matchIgnoreRule(line('UPI/412345678901/SWIGGY/swiggy@icici/Payment'), [rule()])?.id).toBe('r1');
    expect(matchIgnoreRule(line('POS  PURCHASE   Swiggy   Instamart'), [rule()])).not.toBeNull();
    expect(matchIgnoreRule(line('UPI payment', 'debit', '1.00', 'SWIGGY-7781'), [rule()])).not.toBeNull();
    expect(matchIgnoreRule(line('UPI/RAJ BEVERAGES/Payment'), [rule()])).toBeNull();
  });

  it('a pattern shorter than 3 characters never matches (it would swallow the whole statement)', () => {
    expect(matchIgnoreRule(line('ANYTHING AT ALL'), [rule({ pattern: 'a' }), rule({ pattern: 'an' })])).toBeNull();
    expect(matchIgnoreRule(line('ANYTHING AT ALL'), [rule({ pattern: 'any' })])).not.toBeNull();
  });

  it('respects the side: an OUT rule leaves credits alone, an IN rule leaves debits alone', () => {
    expect(matchIgnoreRule(line('SWIGGY REFUND', 'credit'), [rule({ side: 'OUT' })])).toBeNull();
    expect(matchIgnoreRule(line('SWIGGY ORDER', 'debit'), [rule({ side: 'OUT' })])).not.toBeNull();
    expect(matchIgnoreRule(line('SWIGGY ORDER', 'debit'), [rule({ side: 'IN' })])).toBeNull();
    expect(matchIgnoreRule(line('SWIGGY REFUND', 'credit'), [rule({ side: 'IN' })])).not.toBeNull();
  });

  it('respects the amount range, inclusive at both ends', () => {
    const r = rule({ minAmount: '100.00', maxAmount: '500.00' });
    expect(matchIgnoreRule(line('SWIGGY', 'debit', '99.99'), [r])).toBeNull();
    expect(matchIgnoreRule(line('SWIGGY', 'debit', '100.00'), [r])).not.toBeNull();
    expect(matchIgnoreRule(line('SWIGGY', 'debit', '500.00'), [r])).not.toBeNull();
    expect(matchIgnoreRule(line('SWIGGY', 'debit', '500.01'), [r])).toBeNull();
  });

  it('skips inactive rules and returns the first matching one', () => {
    const off = rule({ id: 'off', isActive: false });
    const second = rule({ id: 'second', pattern: 'insta' });
    expect(matchIgnoreRule(line('SWIGGY INSTAMART'), [off, second])?.id).toBe('second');
    expect(matchIgnoreRule(line('SWIGGY INSTAMART'), [rule({ id: 'a' }), second])?.id).toBe('a');
  });

  it('suggestPattern picks the merchant, not the payment plumbing', () => {
    expect(suggestPattern('UPI/412345678901/SWIGGY/swiggy@icici/Payment')).toBe('SWIGGY');
    expect(suggestPattern('NEFT-HDFC0001234-RAMESH KUMAR-REF 8812')).toBe('RAMESH');
    expect(suggestPattern('IMPS/P2A/509412345678/AMAZON PAY')).toBe('AMAZON');
    expect(suggestPattern('POS 4821 ZOMATO LTD')).toBe('ZOMATO');
    expect(suggestPattern('UPI/412345678901/Payment')).toBe('');
    expect(suggestPattern('')).toBe('');
  });
});

describe('posting rules', () => {
  it.each([
    ['CASH_DEPOSIT', 'CONTRA', 'IN', ['BANK', 'CASH']],
    ['CASH_WITHDRAWAL', 'CONTRA', 'OUT', ['CASH', 'BANK']],
    ['BANK_CHARGE', 'PAYMENT', 'OUT', ['BANK_CHARGES', 'BANK']],
    ['INTEREST', 'RECEIPT', 'IN', ['BANK', 'INTEREST_INCOME']],
    ['SUPPLIER_PAYMENT', 'PAYMENT', 'OUT', ['SUNDRY_CREDITORS', 'BANK']],
  ] as const)('%s is a balanced %s voucher', (category, type, side, ledgers) => {
    const p = postingForCategory(category, '100.00');
    expect(p.voucherType).toBe(type);
    expect(p.side).toBe(side);
    expect(p.lines.map((l) => l.ledger)).toEqual(ledgers);
    expect(p.lines.reduce((a, l) => a + Number(l.debit), 0)).toBe(100);
    expect(p.lines.reduce((a, l) => a + Number(l.credit), 0)).toBe(100);
  });
  it('the BANK ledger is debited for money in and credited for money out', () => {
    expect(postingForCategory('CASH_DEPOSIT', '1.00').lines.find((l) => l.ledger === 'BANK')!.debit).toBe('1.00');
    expect(postingForCategory('BANK_CHARGE', '1.00').lines.find((l) => l.ledger === 'BANK')!.credit).toBe('1.00');
  });
  it('a settlement is matched, never posted; a fee posts Dr charges / Cr bank', () => {
    expect(() => postingForCategory('SETTLEMENT', '1.00')).toThrow();
    expect(feePosting('360.00')).toEqual([{ ledger: 'BANK_CHARGES', debit: '360.00', credit: '0.00' }, { ledger: 'BANK', debit: '0.00', credit: '360.00' }]);
  });
});

describe('summarise (bank reconciliation statement)', () => {
  const z = '0.00';
  it('the figures can tie out while the books are still incomplete — that is NOT reconciled', () => {
    // Bank holds 100,000 after taking a 23.60 charge the books don't know about yet, and 18,000 of sales the
    // gateway has not paid out yet. The books therefore stand HIGHER: 100,000 + 18,000 + 23.60.
    const s = summarise({ bankClosing: '100000.00', bookBalance: '118023.60', outstandingReceipts: '18000.00', outstandingPayments: z, unpostedReceipts: z, unpostedPayments: '23.60', ignoredNet: z });
    expect(s.adjustedBank).toBe('118023.60');
    expect(s.difference).toBe('0.00');
    expect(s.booksComplete).toBe(false);     // the 23.60 charge still has to be posted
    expect(s.reconciled).toBe(false);
  });
  it('reconciled = figures tie out, nothing missing from the books; sales awaiting payout are just timing', () => {
    const s = summarise({ bankClosing: '100000.00', bookBalance: '118000.00', outstandingReceipts: '18000.00', outstandingPayments: z, unpostedReceipts: z, unpostedPayments: z, ignoredNet: z });
    expect(s.difference).toBe('0.00');
    expect(s.booksComplete).toBe(true);
    expect(s.reconciled).toBe(true);
  });
  it('shows the unexplained difference', () => {
    const s = summarise({ bankClosing: '100000.00', bookBalance: '101000.00', outstandingReceipts: z, outstandingPayments: z, unpostedReceipts: z, unpostedPayments: z, ignoredNet: z });
    expect(s.difference).toBe('1000.00');
    expect(s.reconciled).toBe(false);
  });
  it('cannot reconcile without a closing balance', () => {
    expect(summarise({ bankClosing: null, bookBalance: '1.00', outstandingReceipts: z, outstandingPayments: z, unpostedReceipts: z, unpostedPayments: z, ignoredNet: z }).reconciled).toBe(false);
  });
});
