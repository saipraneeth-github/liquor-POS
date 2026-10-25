import { describe, it, expect } from 'vitest';
import { Decimal } from 'decimal.js';
import {
  assertBalanced,
  buildVoucher,
  billPaidLines,
  billVoidedLines,
  creditRepaymentLines,
  cr,
  dr,
  expenseLines,
  paymentLedgerCode,
  reverseLines,
  supplierInvoiceLines,
  voucherTotals,
  type PostingLine,
} from '../../src/modules/accounting/ledger.engine.js';
import { calculateBill } from '../../src/modules/billing/billing.engine.js';
import { expenseLedgerCode, normalizeLedgerCode, isReservedLedgerCode } from '../../src/modules/accounting/chart.js';

function amountOf(lines: PostingLine[], ledger: string, side: 'debit' | 'credit'): string {
  const line = lines.find((l) => l.ledger === ledger);
  return line ? line[side] : '0.00';
}

function expectBalanced(lines: PostingLine[]) {
  expect(() => assertBalanced(lines)).not.toThrow();
  const t = voucherTotals(lines);
  expect(t.debit).toBe(t.credit);
  expect(new Decimal(t.debit).greaterThan(0)).toBe(true);
  for (const l of lines) {
    expect(l.debit).toMatch(/^\d+\.\d{2}$/);
    expect(l.credit).toMatch(/^\d+\.\d{2}$/);
    expect([new Decimal(l.debit).greaterThan(0), new Decimal(l.credit).greaterThan(0)].filter(Boolean)).toHaveLength(1);
  }
}

// ─── buildVoucher / assertBalanced ────────────────────────────────────────────

describe('buildVoucher / assertBalanced', () => {
  it('normalises to 2dp strings and drops zero lines', () => {
    const lines = buildVoucher([dr('CASH', '100'), dr('DISCOUNT_ALLOWED', 0), cr('SALES', '100.0')]);
    expect(lines).toEqual([
      { ledger: 'CASH', debit: '100.00', credit: '0.00' },
      { ledger: 'SALES', debit: '0.00', credit: '100.00' },
    ]);
  });

  it('rejects unbalanced vouchers', () => {
    expect(() => buildVoucher([dr('CASH', '100.00'), cr('SALES', '99.99')])).toThrow(/not balanced/);
  });

  it('rejects zero-total and single-line vouchers', () => {
    expect(() => buildVoucher([dr('CASH', 0), cr('SALES', 0)])).toThrow();
    expect(() => assertBalanced([{ ledger: 'CASH', debit: '10.00', credit: '0.00' }])).toThrow(/two lines/);
  });

  it('rejects a line with both sides, negatives, and >2dp amounts', () => {
    expect(() => assertBalanced([
      { ledger: 'A', debit: '10.00', credit: '10.00' },
      { ledger: 'B', debit: '0.00', credit: '0.00' },
    ])).toThrow(/exactly one/);
    expect(() => assertBalanced([
      { ledger: 'A', debit: '-10.00', credit: '0.00' },
      { ledger: 'B', debit: '0.00', credit: '-10.00' },
    ])).toThrow(/Negative/);
    expect(() => buildVoucher([dr('A', '10.005'), cr('B', '10.005')])).toThrow(/2 decimal/);
    expect(() => assertBalanced([
      { ledger: 'A', debit: '10', credit: '0.00' },
      { ledger: 'B', debit: '0.00', credit: '10.00' },
    ])).toThrow(/2dp/);
  });

  it('reverseLines swaps sides and stays balanced', () => {
    const lines = buildVoucher([dr('CASH', '50.00'), cr('SALES', '42.37'), cr('OUTPUT_GST', '7.63')]);
    const rev = reverseLines(lines);
    expect(rev[0]).toEqual({ ledger: 'CASH', debit: '0.00', credit: '50.00' });
    expectBalanced(rev);
  });
});

// ─── PAYMENT MODE MAP ─────────────────────────────────────────────────────────

describe('paymentLedgerCode', () => {
  it('maps payment modes to money ledgers', () => {
    expect(paymentLedgerCode('CASH')).toBe('CASH');
    expect(paymentLedgerCode('CARD')).toBe('BANK');
    expect(paymentLedgerCode('UPI')).toBe('BANK');
    expect(paymentLedgerCode('BANK')).toBe('BANK');
    expect(paymentLedgerCode('CREDIT')).toBe('SUNDRY_DEBTORS');
  });
  it('rejects CREDIT where not allowed and unknown modes', () => {
    expect(() => paymentLedgerCode('CREDIT', false)).toThrow();
    expect(() => paymentLedgerCode('CHEQUE')).toThrow();
    expect(() => paymentLedgerCode(null)).toThrow();
  });
});

// ─── BILL PAID ────────────────────────────────────────────────────────────────

describe('billPaidLines', () => {
  it('posts a simple cash sale: Dr CASH total, Cr SALES taxable, Cr OUTPUT_GST tax', () => {
    const calc = calculateBill([{ productId: 'w', quantity: 1, unitPrice: '1000.00', taxRate: '18.00' }]);
    const lines = billPaidLines({ ...calc, paymentMode: 'CASH' });
    expectBalanced(lines);
    expect(amountOf(lines, 'CASH', 'debit')).toBe('1000.00');
    expect(amountOf(lines, 'SALES', 'credit')).toBe('847.46');
    expect(amountOf(lines, 'OUTPUT_GST', 'credit')).toBe('152.54');
    expect(lines.find((l) => l.ledger === 'DISCOUNT_ALLOWED')).toBeUndefined();
  });

  it('posts discount to DISCOUNT_ALLOWED and still balances', () => {
    const calc = calculateBill([
      { productId: 'w', quantity: 2, unitPrice: '1000.00', taxRate: '18.00' },
      { productId: 'b', quantity: 3, unitPrice: '200.00', taxRate: '12.00' },
    ], '75.50');
    const lines = billPaidLines({ ...calc, paymentMode: 'UPI' });
    expectBalanced(lines);
    expect(amountOf(lines, 'BANK', 'debit')).toBe(calc.total);
    expect(amountOf(lines, 'DISCOUNT_ALLOWED', 'debit')).toBe('75.50');
    expect(new Decimal(amountOf(lines, 'SALES', 'credit')).plus(amountOf(lines, 'OUTPUT_GST', 'credit')).toFixed(2))
      .toBe(calc.subtotal);
  });

  it('balances with odd per-line tax rounding across three lines', () => {
    const calc = calculateBill([
      { productId: 'a', quantity: 3, unitPrice: '333.33', taxRate: '18.00' },
      { productId: 'b', quantity: 7, unitPrice: '99.99', taxRate: '12.00' },
      { productId: 'c', quantity: 1, unitPrice: '0.07', taxRate: '28.00' },
    ], '0.01');
    for (const mode of ['CASH', 'CARD', 'UPI', 'CREDIT']) {
      const lines = billPaidLines({ ...calc, paymentMode: mode });
      expectBalanced(lines);
      expect(amountOf(lines, 'OUTPUT_GST', 'credit')).toBe(calc.taxAmount);
    }
  });

  it('CREDIT bill debits SUNDRY_DEBTORS; CARD debits BANK', () => {
    const calc = calculateBill([{ productId: 'b', quantity: 1, unitPrice: '200.00', taxRate: '12.00' }]);
    expect(amountOf(billPaidLines({ ...calc, paymentMode: 'CREDIT' }), 'SUNDRY_DEBTORS', 'debit')).toBe('200.00');
    expect(amountOf(billPaidLines({ ...calc, paymentMode: 'CARD' }), 'BANK', 'debit')).toBe('200.00');
  });

  it('a 100% discount bill posts only discount vs sales/GST', () => {
    const calc = calculateBill([{ productId: 'b', quantity: 1, unitPrice: '200.00', taxRate: '12.00' }], '200.00');
    const lines = billPaidLines({ ...calc, paymentMode: 'CASH' });
    expectBalanced(lines);
    expect(lines.find((l) => l.ledger === 'CASH')).toBeUndefined();
  });

  it('rejects inconsistent bill numbers', () => {
    expect(() => billPaidLines({ subtotal: '100.00', taxAmount: '10.00', discount: '0.00', total: '90.00', paymentMode: 'CASH' }))
      .toThrow();
  });
});

// ─── BILL VOIDED ──────────────────────────────────────────────────────────────

describe('billVoidedLines', () => {
  it('is the exact negation of the sale voucher', () => {
    const calc = calculateBill([
      { productId: 'a', quantity: 3, unitPrice: '333.33', taxRate: '18.00' },
      { productId: 'b', quantity: 2, unitPrice: '200.00', taxRate: '12.00' },
    ], '10.00');
    const sale = billPaidLines({ ...calc, paymentMode: 'CASH' });
    const reversal = billVoidedLines(sale);
    expectBalanced(reversal);
    // Per ledger, sale + reversal nets to zero
    const net = new Map<string, Decimal>();
    for (const l of [...sale, ...reversal]) {
      net.set(l.ledger, (net.get(l.ledger) ?? new Decimal(0)).plus(l.debit).minus(l.credit));
    }
    for (const v of net.values()) expect(v.isZero()).toBe(true);
    reversal.forEach((l, i) => {
      expect(l.debit).toBe(sale[i].credit);
      expect(l.credit).toBe(sale[i].debit);
    });
  });
});

// ─── SUPPLIER INVOICE ─────────────────────────────────────────────────────────

describe('supplierInvoiceLines', () => {
  it('Dr PURCHASES + Dr INPUT_GST = Cr SUNDRY_CREDITORS (sum of line costs)', () => {
    const lines = supplierInvoiceLines([
      { lineCostTotal: '9600.00', taxRate: '18.00' },
      { lineCostTotal: '1800.00', taxRate: '12.00' },
    ]);
    expectBalanced(lines);
    expect(amountOf(lines, 'SUNDRY_CREDITORS', 'credit')).toBe('11400.00');
    // 9600/1.18 = 8135.59 ; 1800/1.12 = 1607.14
    expect(amountOf(lines, 'PURCHASES', 'debit')).toBe('9742.73');
    expect(amountOf(lines, 'INPUT_GST', 'debit')).toBe('1657.27');
  });

  it('balances with odd amounts and zero tax rate', () => {
    for (const items of [
      [{ lineCostTotal: '0.01', taxRate: '18.00' }, { lineCostTotal: '333.33', taxRate: '28.00' }],
      [{ lineCostTotal: '1234.57', taxRate: '0.00' }],
      [{ lineCostTotal: '99.99', taxRate: '5.00' }, { lineCostTotal: '77.77', taxRate: '12.00' }, { lineCostTotal: '1.11', taxRate: '18.00' }],
    ]) {
      expectBalanced(supplierInvoiceLines(items));
    }
  });

  it('rejects an empty invoice', () => {
    expect(() => supplierInvoiceLines([])).toThrow();
  });
});

// ─── CREDIT REPAYMENT / EXPENSE ───────────────────────────────────────────────

describe('creditRepaymentLines', () => {
  it('Dr CASH|BANK, Cr SUNDRY_DEBTORS', () => {
    const cash = creditRepaymentLines({ amount: '500.00', paymentMode: 'CASH' });
    expectBalanced(cash);
    expect(amountOf(cash, 'CASH', 'debit')).toBe('500.00');
    expect(amountOf(cash, 'SUNDRY_DEBTORS', 'credit')).toBe('500.00');
    expect(amountOf(creditRepaymentLines({ amount: '12.34', paymentMode: 'UPI' }), 'BANK', 'debit')).toBe('12.34');
  });
  it('cannot repay credit with CREDIT', () => {
    expect(() => creditRepaymentLines({ amount: '1.00', paymentMode: 'CREDIT' })).toThrow();
  });
});

describe('expenseLines', () => {
  it('Dr EXPENSE_<CATEGORY>, Cr CASH|BANK', () => {
    const lines = expenseLines({ category: 'Electricity Bill', amount: '2450.75', paymentMode: 'BANK' });
    expectBalanced(lines);
    expect(amountOf(lines, 'EXPENSE_ELECTRICITY_BILL', 'debit')).toBe('2450.75');
    expect(amountOf(lines, 'BANK', 'credit')).toBe('2450.75');
    expect(amountOf(expenseLines({ category: 'Rent', amount: '1', paymentMode: 'CASH' }), 'CASH', 'credit')).toBe('1.00');
  });
  it('rejects zero amounts', () => {
    expect(() => expenseLines({ category: 'Rent', amount: '0', paymentMode: 'CASH' })).toThrow();
  });
});

describe('chart helpers', () => {
  it('normalises ledger codes and reserves system codes', () => {
    expect(normalizeLedgerCode('  Staff salaries / wages ')).toBe('STAFF_SALARIES_WAGES');
    expect(expenseLedgerCode('Rent')).toBe('EXPENSE_RENT');
    expect(isReservedLedgerCode('CASH')).toBe(true);
    expect(isReservedLedgerCode('EXPENSE_RENT')).toBe(true);
    expect(isReservedLedgerCode('OWNER_LOAN')).toBe(false);
    expect(() => normalizeLedgerCode('!!!')).toThrow();
  });
});
