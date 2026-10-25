import { describe, it, expect } from 'vitest';
import {
  assertCreditAvailable,
  assertCreditLimitUpdate,
  applyCreditPurchase,
  applyRepayment,
  buildStatement,
  creditTxnDelta,
  normalizeIndianMobile,
  type CreditTxnInput,
} from '../../src/modules/customers/credit.engine.js';

// ─── CEILING ──────────────────────────────────────────────────────────────────

describe('credit ceiling', () => {
  it('allows purchases up to the limit and blocks the next rupee', () => {
    let balance = '0.00';
    assertCreditAvailable(balance, '1000.00', '700.00');
    balance = applyCreditPurchase(balance, '700.00');
    expect(() => assertCreditAvailable(balance, '1000.00', '300.00')).not.toThrow();
    expect(() => assertCreditAvailable(balance, '1000.00', '300.01')).toThrow(/Credit limit exceeded/);
  });

  it('a zero limit blocks any credit purchase', () => {
    expect(() => assertCreditAvailable('0', '0', '0.01')).toThrow(/available 0.00/);
  });

  it('limit cannot be lowered below the outstanding balance', () => {
    expect(() => assertCreditLimitUpdate('499.99', '500.00')).toThrow(/cannot be below current outstanding 500.00/);
    expect(() => assertCreditLimitUpdate('500.00', '500.00')).not.toThrow();
    expect(() => assertCreditLimitUpdate('-1', '0')).toThrow(/negative/);
  });
});

// ─── REPAYMENTS & RUNNING BALANCE ─────────────────────────────────────────────

describe('running balance after repayments', () => {
  const t = (type: CreditTxnInput['type'], amount: string, minute: number): CreditTxnInput & { id: string } => ({
    id: `${type}-${minute}`, type, amount, recordedAt: new Date(Date.UTC(2026, 0, 1, 10, minute)),
  });

  it('replays chronologically and returns newest first', () => {
    const txns = [
      t('REPAYMENT', '300.00', 2),
      t('PURCHASE', '1000.00', 1),
      t('PURCHASE', '250.50', 3),
      t('REPAYMENT', '950.50', 4),
    ];
    const { entries, closingBalance } = buildStatement(txns);
    expect(entries.map((e) => e.id)).toEqual(['REPAYMENT-4', 'PURCHASE-3', 'REPAYMENT-2', 'PURCHASE-1']);
    expect(entries.map((e) => e.runningBalance)).toEqual(['0.00', '950.50', '700.00', '1000.00']);
    expect(closingBalance).toBe('0.00');
  });

  it('ADJUSTMENT (void reversal) reduces the balance', () => {
    expect(creditTxnDelta('ADJUSTMENT', '100').toFixed(2)).toBe('-100.00');
    const { closingBalance } = buildStatement([t('PURCHASE', '400', 1), t('ADJUSTMENT', '400', 2)]);
    expect(closingBalance).toBe('0.00');
  });

  it('empty statement has zero balance', () => {
    expect(buildStatement([])).toEqual({ entries: [], closingBalance: '0.00' });
  });

  it('sequential repayments decrease the outstanding decimal-safely', () => {
    let bal = '1000.00';
    bal = applyRepayment(bal, '333.33');
    bal = applyRepayment(bal, '333.33');
    expect(bal).toBe('333.34');
    expect(applyRepayment(bal, '333.34')).toBe('0.00');
  });
});

describe('over-repayment', () => {
  it('rejects repaying more than outstanding', () => {
    expect(() => applyRepayment('250.00', '250.01')).toThrow(/exceeds outstanding balance 250.00/);
  });

  it('rejects any repayment when nothing is owed or the customer holds an advance', () => {
    expect(() => applyRepayment('0.00', '1')).toThrow(/exceeds outstanding/);
    expect(() => applyRepayment('-50.00', '1')).toThrow(/exceeds outstanding/);
  });

  it('rejects zero / negative repayments', () => {
    expect(() => applyRepayment('100', '0')).toThrow(/greater than zero/);
    expect(() => applyRepayment('100', '-5')).toThrow(/greater than zero/);
  });
});

// ─── PHONE ────────────────────────────────────────────────────────────────────

describe('normalizeIndianMobile', () => {
  it('accepts 10-digit mobiles with common prefixes', () => {
    expect(normalizeIndianMobile('9876543210')).toBe('9876543210');
    expect(normalizeIndianMobile('+91 98765-43210')).toBe('9876543210');
    expect(normalizeIndianMobile('919876543210')).toBe('9876543210');
    expect(normalizeIndianMobile('09876543210')).toBe('9876543210');
  });

  it('rejects landlines, short numbers and bad leading digits', () => {
    expect(normalizeIndianMobile('5876543210')).toBeNull();
    expect(normalizeIndianMobile('987654321')).toBeNull();
    expect(normalizeIndianMobile('98765432101')).toBeNull();
    expect(normalizeIndianMobile('abcdefghij')).toBeNull();
  });
});
