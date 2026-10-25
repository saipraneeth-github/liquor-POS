import { describe, it, expect } from 'vitest';
import { countDenominations, computeShiftSummary, computeDiscrepancy } from '../../src/modules/shifts/shift.engine.js';

describe('countDenominations', () => {
  it('500x10 + 200x5 = 6000.00', () => {
    expect(countDenominations({ '500': 10, '200': 5 })).toBe('6000.00');
  });

  it('adds coins as a decimal amount', () => {
    expect(countDenominations({ '2000': 1, '10': 3, coins: '12.50' })).toBe('2042.50');
    expect(countDenominations({ coins: 7 })).toBe('7.00');
  });

  it('returns 0.00 for an empty count', () => {
    expect(countDenominations({})).toBe('0.00');
  });

  it('rejects unknown denominations, negative / fractional counts and bad coins', () => {
    expect(() => countDenominations({ '300': 1 })).toThrow(/Unknown denomination/);
    expect(() => countDenominations({ '500': -1 })).toThrow(/non-negative integer/);
    expect(() => countDenominations({ '500': 1.5 })).toThrow(/non-negative integer/);
    expect(() => countDenominations({ coins: '-1.00' })).toThrow(/Invalid amount/);
    expect(() => countDenominations({ coins: '1.234' })).toThrow(/Invalid amount/);
  });
});

describe('computeShiftSummary', () => {
  const bills = [
    { status: 'PAID', paymentMode: 'CASH', total: '1000.00' },
    { status: 'PAID', paymentMode: 'CASH', total: '200.00' },
    { status: 'PAID', paymentMode: 'UPI', total: '450.50' },
    { status: 'PAID', paymentMode: 'CARD', total: '300.00' },
    { status: 'PAID', paymentMode: 'CREDIT', total: '800.00' },
    { status: 'VOIDED', paymentMode: 'CASH', total: '5000.00' },
  ];

  it('sums PAID bills per mode, excludes VOIDED, and adds float to cash', () => {
    const s = computeShiftSummary('500.00', bills);
    expect(s).toEqual({
      cashCollected: '1200.00',
      cardCollected: '300.00',
      upiCollected: '450.50',
      creditCollected: '800.00',
      grossCollected: '2750.50',
      paidBillsCount: 5,
      expectedCash: '1700.00',
    });
  });

  it('handles a shift with no bills', () => {
    expect(computeShiftSummary('0', []).expectedCash).toBe('0.00');
  });
});

describe('computeDiscrepancy', () => {
  it('is negative for a shortage and positive for an excess', () => {
    expect(computeDiscrepancy('1650.00', '1700.00')).toBe('-50.00');
    expect(computeDiscrepancy('1710.50', '1700.00')).toBe('10.50');
    expect(computeDiscrepancy('1700', '1700.00')).toBe('0.00');
  });
});
