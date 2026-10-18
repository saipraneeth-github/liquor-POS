import { describe, it, expect } from 'vitest';
import { calculateBill, assertMrpMatch } from '../../src/modules/billing/billing.engine.js';

describe('calculateBill', () => {
  it('calculates a single-item bill with 18% GST (MRP-inclusive)', () => {
    const result = calculateBill([
      { productId: 'p1', quantity: 2, unitPrice: '450.00', taxRate: '18.00' },
    ]);

    // pretax for 2 × 450 = 900
    // taxable_value = 900 / 1.18 = 762.71 (rounded)
    // tax = 900 - 762.71 = 137.29
    expect(result.subtotal).toBe('900.00');
    expect(result.taxAmount).toBe('137.29');
    expect(result.discount).toBe('0.00');
    expect(result.total).toBe('900.00');
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].lineTotal).toBe('900.00');
  });

  it('calculates multi-item bill correctly', () => {
    const result = calculateBill([
      { productId: 'p1', quantity: 1, unitPrice: '200.00', taxRate: '18.00' },
      { productId: 'p2', quantity: 3, unitPrice: '100.00', taxRate: '12.00' },
    ]);

    // p1: 200, p2: 300, subtotal = 500
    expect(result.subtotal).toBe('500.00');
    expect(result.lines).toHaveLength(2);
  });

  it('applies discount to total only, not subtotal', () => {
    const result = calculateBill(
      [{ productId: 'p1', quantity: 1, unitPrice: '500.00', taxRate: '18.00' }],
      '50.00',
    );

    expect(result.subtotal).toBe('500.00');
    expect(result.discount).toBe('50.00');
    expect(result.total).toBe('450.00');
  });

  it('throws when discount exceeds subtotal', () => {
    expect(() =>
      calculateBill(
        [{ productId: 'p1', quantity: 1, unitPrice: '100.00', taxRate: '18.00' }],
        '200.00',
      ),
    ).toThrow('Discount exceeds bill subtotal');
  });

  it('throws for zero quantity', () => {
    expect(() =>
      calculateBill([{ productId: 'p1', quantity: 0, unitPrice: '100.00', taxRate: '18.00' }]),
    ).toThrow('Invalid quantity');
  });

  it('throws for negative price', () => {
    expect(() =>
      calculateBill([{ productId: 'p1', quantity: 1, unitPrice: '-50.00', taxRate: '18.00' }]),
    ).toThrow('Invalid unit price');
  });

  it('throws for tax rate above 100%', () => {
    expect(() =>
      calculateBill([{ productId: 'p1', quantity: 1, unitPrice: '100.00', taxRate: '101.00' }]),
    ).toThrow('Invalid tax rate');
  });

  it('throws for empty line items', () => {
    expect(() => calculateBill([])).toThrow('Bill must contain at least one line item');
  });

  it('throws for negative discount', () => {
    expect(() =>
      calculateBill(
        [{ productId: 'p1', quantity: 1, unitPrice: '100.00', taxRate: '18.00' }],
        '-10.00',
      ),
    ).toThrow('Discount cannot be negative');
  });

  it('produces decimal-safe results (no floating-point drift)', () => {
    // 3 × 33.33 = 99.99 (not 99.99000000001)
    const result = calculateBill([
      { productId: 'p1', quantity: 3, unitPrice: '33.33', taxRate: '0.00' },
    ]);
    expect(result.subtotal).toBe('99.99');
    expect(result.total).toBe('99.99');
  });
});

describe('assertMrpMatch', () => {
  it('does not throw when prices match', () => {
    expect(() => assertMrpMatch('450.00', '450.00', 'p1')).not.toThrow();
  });

  it('throws when prices differ', () => {
    expect(() => assertMrpMatch('400.00', '450.00', 'p1')).toThrow('Price mismatch');
  });
});
