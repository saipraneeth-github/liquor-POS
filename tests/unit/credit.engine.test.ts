import { describe, it, expect } from 'vitest';
import {
  assertCreditAvailable,
  applyCreditPurchase,
  applyRepayment,
  applyCreditReversal,
} from '../../src/modules/customers/credit.engine.js';

describe('assertCreditAvailable', () => {
  it('allows a purchase that lands exactly on the limit', () => {
    expect(() => assertCreditAvailable('400.00', '1000.00', '600.00')).not.toThrow();
  });

  it('rejects a purchase that exceeds the limit with a helpful message', () => {
    expect(() => assertCreditAvailable('400.00', '1000.00', '600.01')).toThrow(/Credit limit exceeded.*available 600.00/);
  });

  it('rejects negative amounts', () => {
    expect(() => assertCreditAvailable('0', '1000', '-1')).toThrow('cannot be negative');
  });

  it('reports zero available when already over the limit', () => {
    expect(() => assertCreditAvailable('1200.00', '1000.00', '1.00')).toThrow(/available 0.00/);
  });
});

describe('balance transitions', () => {
  it('applyCreditPurchase adds decimal-safely', () => {
    expect(applyCreditPurchase('0.10', '0.20')).toBe('0.30');
  });

  it('applyCreditPurchase rejects zero', () => {
    expect(() => applyCreditPurchase('10', '0')).toThrow('greater than zero');
  });

  it('applyRepayment subtracts and rejects over-repayment', () => {
    expect(applyRepayment('500.00', '200.50')).toBe('299.50');
    expect(() => applyRepayment('100.00', '100.01')).toThrow('exceeds outstanding balance');
  });

  it('applyCreditReversal may go negative (customer advance)', () => {
    expect(applyCreditReversal('100.00', '250.00')).toBe('-150.00');
  });
});
