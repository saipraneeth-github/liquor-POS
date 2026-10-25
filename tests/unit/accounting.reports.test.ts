import { describe, it, expect } from 'vitest';
import {
  computeBalanceSheet,
  computeLedgerBalances,
  computeProfitLoss,
  computeRunningBalance,
  computeTrialBalance,
  type LedgerMovement,
} from '../../src/modules/accounting/reports.engine.js';
import { summarizeExpenses } from '../../src/modules/expenses/expense.engine.js';

function m(code: string, group: LedgerMovement['group'], debit: string, credit: string, openingBalance = '0'): LedgerMovement {
  return { ledgerId: code.toLowerCase(), code, name: code, group, openingBalance, debit, credit };
}

// Sale 1000 cash (847.46 + 152.54), expense 300 cash, capital 5000 into bank, purchase 1180 on credit
const BOOKS: LedgerMovement[] = [
  m('CASH', 'ASSET', '1000.00', '300.00'),
  m('BANK', 'ASSET', '5000.00', '0'),
  m('INPUT_GST', 'ASSET', '180.00', '0'),
  m('SUNDRY_CREDITORS', 'LIABILITY', '0', '1180.00'),
  m('OUTPUT_GST', 'LIABILITY', '0', '152.54'),
  m('CAPITAL', 'EQUITY', '0', '5000.00'),
  m('SALES', 'INCOME', '0', '847.46'),
  m('PURCHASES', 'EXPENSE', '1000.00', '0'),
  m('EXPENSE_RENT', 'EXPENSE', '300.00', '0'),
];

describe('computeLedgerBalances', () => {
  it('balance = opening + debit - credit (signed)', () => {
    const [cash, , , cred] = computeLedgerBalances(BOOKS);
    expect(cash.balance).toBe('700.00');
    expect(cred.balance).toBe('-1180.00');
    expect(computeLedgerBalances([m('X', 'ASSET', '10', '5', '-20.50')])[0].balance).toBe('-15.50');
  });
});

describe('computeTrialBalance', () => {
  it('debit and credit totals match for balanced books', () => {
    const tb = computeTrialBalance(BOOKS);
    expect(tb.totalDebit).toBe(tb.totalCredit);
    expect(tb.totalDebit).toBe('7180.00');
    expect(tb.isBalanced).toBe(true);
    expect(tb.rows.find((r) => r.code === 'SALES')).toMatchObject({ debit: '0.00', credit: '847.46' });
  });
  it('flags an unbalanced opening balance', () => {
    const tb = computeTrialBalance([...BOOKS, m('OWNER_LOAN', 'LIABILITY', '0', '0', '-100.00')]);
    expect(tb.isBalanced).toBe(false);
    expect(tb.difference).toBe('-100.00');
  });
});

describe('computeProfitLoss', () => {
  it('net profit = income - expense', () => {
    const pl = computeProfitLoss(BOOKS);
    expect(pl.totalIncome).toBe('847.46');
    expect(pl.totalExpense).toBe('1300.00');
    expect(pl.netProfit).toBe('-452.54');
  });
  it('handles reversals within the period (sale + void nets to zero)', () => {
    const pl = computeProfitLoss([m('SALES', 'INCOME', '500.00', '500.00'), m('DISCOUNT_ALLOWED', 'EXPENSE', '5.00', '5.00')]);
    expect(pl.netProfit).toBe('0.00');
  });
});

describe('computeBalanceSheet', () => {
  it('assets = liabilities + equity + retained earnings', () => {
    const bs = computeBalanceSheet(BOOKS);
    expect(bs.totalAssets).toBe('5880.00');
    expect(bs.totalLiabilities).toBe('1332.54');
    expect(bs.totalEquity).toBe('5000.00');
    expect(bs.retainedEarnings).toBe('-452.54');
    expect(bs.totalLiabilitiesAndEquity).toBe('5880.00');
    expect(bs.isBalanced).toBe(true);
  });
  it('is not balanced when the trial balance is not', () => {
    expect(computeBalanceSheet([...BOOKS, m('CASH2', 'ASSET', '1.00', '0')]).isBalanced).toBe(false);
  });
  it('empty books are balanced at zero', () => {
    const bs = computeBalanceSheet([]);
    expect(bs.isBalanced).toBe(true);
    expect(bs.totalAssets).toBe('0.00');
  });
});

describe('computeRunningBalance', () => {
  it('carries the opening balance through every entry', () => {
    const e = (debit: string, credit: string) => ({
      voucherId: 'v', voucherNumber: 'JV', voucherDate: '2026-01-01', voucherType: 'SALES', narration: '', debit, credit,
    });
    const st = computeRunningBalance('100.00', [e('50.00', '0.00'), e('0.00', '175.25'), e('10.10', '0.00')]);
    expect(st.entries.map((r) => r.balance)).toEqual(['150.00', '-25.25', '-15.15']);
    expect(st.totalDebit).toBe('60.10');
    expect(st.totalCredit).toBe('175.25');
    expect(st.closingBalance).toBe('-15.15');
    expect(computeRunningBalance('0', []).closingBalance).toBe('0.00');
  });
});

describe('summarizeExpenses', () => {
  it('groups by category case-insensitively, sorted by total desc', () => {
    const s = summarizeExpenses([
      { category: 'Rent', amount: '1000.00' },
      { category: 'Electricity', amount: '250.50' },
      { category: 'rent ', amount: '0.10' },
      { category: 'Electricity', amount: '250.50' },
    ]);
    expect(s.total).toBe('1501.10');
    expect(s.count).toBe(4);
    expect(s.byCategory).toEqual([
      { category: 'Rent', total: '1000.10', count: 2 },
      { category: 'Electricity', total: '501.00', count: 2 },
    ]);
  });

  it('groups exactly like the EXPENSE_<CODE> ledger (punctuation/spacing insensitive)', () => {
    const s = summarizeExpenses([
      { category: 'Staff Salary', amount: '100.00' },
      { category: 'staff-salary', amount: '50.00' },
      { category: 'STAFF  SALARY!', amount: '1.00' },
    ]);
    expect(s.byCategory).toEqual([{ category: 'Staff Salary', total: '151.00', count: 3 }]);
  });
});
