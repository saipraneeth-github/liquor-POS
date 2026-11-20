import { describe, it, expect } from 'vitest';
import { buildCashBook, type CashBookEntry } from '../../src/modules/accounting/cashbook.engine.js';
import { planAdjustments } from '../../src/modules/inventory/stock-adjust.engine.js';

const entry = (date: string, debit: string, credit: string, balance: string, n = 1): CashBookEntry => ({
  voucherId: `v${date}${n}`, voucherNumber: `JV-${date}-${n}`, voucherDate: date, voucherType: 'JOURNAL', narration: 'x', debit, credit, balance,
});

describe('cash book', () => {
  it('groups a statement by day: opening, receipts, payments, closing', () => {
    const book = buildCashBook('1000.00', [
      entry('2026-11-01', '500.00', '0.00', '1500.00', 1),
      entry('2026-11-01', '0.00', '200.00', '1300.00', 2),
      entry('2026-11-03', '50.50', '0.00', '1350.50'),
    ]);
    expect(book.opening).toBe('1000.00');
    expect(book.days).toHaveLength(2);
    expect(book.days[0]).toMatchObject({ date: '2026-11-01', opening: '1000.00', receipts: '500.00', payments: '200.00', closing: '1300.00' });
    expect(book.days[1]).toMatchObject({ date: '2026-11-03', opening: '1300.00', receipts: '50.50', payments: '0.00', closing: '1350.50' });
    expect(book.totalReceipts).toBe('550.50');
    expect(book.totalPayments).toBe('200.00');
    expect(book.closing).toBe('1350.50');
  });
  it('an empty period is just the opening balance', () => {
    const book = buildCashBook('250.00', []);
    expect(book).toMatchObject({ opening: '250.00', closing: '250.00', days: [], totalReceipts: '0.00', totalPayments: '0.00' });
  });
});

describe('stock-take plan', () => {
  const cur = new Map([
    ['a', { quantity: 10, otherCounters: 0, name: 'Whisky' }],
    ['b', { quantity: 20, otherCounters: 8, name: 'Beer' }],
    ['c', { quantity: 5, otherCounters: 0, name: 'Rum' }],
  ]);
  it('turns each difference into a signed change and skips matches', () => {
    const plan = planAdjustments([{ productId: 'a', counted: 7 }, { productId: 'b', counted: 25 }, { productId: 'c', counted: 5 }], cur);
    expect(plan.problems).toEqual([]);
    expect(plan.changes).toEqual([
      { productId: 'a', before: 10, after: 7, delta: -3 },
      { productId: 'b', before: 20, after: 25, delta: 5 },
    ]);
    expect(plan.unchanged).toBe(1);
  });
  it('refuses a count below what the other counters hold', () => {
    const plan = planAdjustments([{ productId: 'b', counted: 6 }], cur);
    expect(plan.changes).toEqual([]);
    expect(plan.problems[0]).toMatch(/Beer.*other counters.*8/);
  });
  it('refuses negative, fractional and repeated counts', () => {
    const plan = planAdjustments([{ productId: 'a', counted: -1 }, { productId: 'c', counted: 2.5 }, { productId: 'c', counted: 3 }], cur);
    expect(plan.problems).toHaveLength(3);
    expect(plan.changes).toEqual([]);
  });
  it('a product with no stock row starts from zero', () => {
    expect(planAdjustments([{ productId: 'z', counted: 4 }], cur).changes).toEqual([{ productId: 'z', before: 0, after: 4, delta: 4 }]);
  });
});
