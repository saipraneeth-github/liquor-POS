import { describe, it, expect } from 'vitest';
import { Decimal } from 'decimal.js';
import {
  calculateBill,
  assertMrpMatch,
  mergeBillItems,
  resolveTaxRate,
  formatBillNumber,
  allocateDiscount,
} from '../../src/modules/billing/billing.engine.js';

describe('mergeBillItems', () => {
  it('merges duplicate productIds by summing quantities, keeping first-seen order', () => {
    expect(mergeBillItems([
      { productId: 'a', quantity: 1 },
      { productId: 'b', quantity: 2 },
      { productId: 'a', quantity: 3 },
    ])).toEqual([{ productId: 'a', quantity: 4 }, { productId: 'b', quantity: 2 }]);
  });

  it('rejects non-positive or fractional quantities', () => {
    expect(() => mergeBillItems([{ productId: 'a', quantity: 0 }])).toThrow('Invalid quantity');
    expect(() => mergeBillItems([{ productId: 'a', quantity: 1.5 }])).toThrow('Invalid quantity');
  });
});

describe('resolveTaxRate', () => {
  it('uses the category rate and falls back to 18.00 only when uncategorised', () => {
    expect(resolveTaxRate('12')).toBe('12.00');
    expect(resolveTaxRate('0.00')).toBe('0.00');
    expect(resolveTaxRate(null)).toBe('18.00');
    expect(resolveTaxRate(undefined)).toBe('18.00');
  });

  it('beer at 12% back-calculates GST from a 200 MRP', () => {
    const r = calculateBill([{ productId: 'beer', quantity: 1, unitPrice: '200.00', taxRate: resolveTaxRate('12.00') }]);
    expect(r.taxAmount).toBe('21.43');   // 200 - 200/1.12 (178.57)
  });
});

describe('formatBillNumber', () => {
  it('formats CODE-YYYY-000001', () => {
    expect(formatBillNumber('MAIN', 2026, 1)).toBe('MAIN-2026-000001');
    expect(formatBillNumber('MH1', 2026, 1234567)).toBe('MH1-2026-1234567');
  });

  it('rejects invalid sequences', () => {
    expect(() => formatBillNumber('X', 2026, 0)).toThrow();
  });
});

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

// ─── DISCOUNT vs GST (review fix) ────────────────────────────────────────────

describe('calculateBill — discount reduces the taxable value', () => {
  it('computes GST on the discounted (net) amount, not on the gross MRP', () => {
    const r = calculateBill([{ productId: 'w', quantity: 1, unitPrice: '1000.00', taxRate: '18.00' }], '100.00');
    expect(r.total).toBe('900.00');
    // 900 - 900/1.18 = 900 - 762.71 = 137.29 (gross would wrongly give 152.54)
    expect(r.taxAmount).toBe('137.29');
    expect(r.lines[0].lineTotal).toBe('1000.00');
  });

  it('apportions the discount pro rata across mixed tax rates', () => {
    const r = calculateBill([
      { productId: 'w', quantity: 1, unitPrice: '1000.00', taxRate: '18.00' },
      { productId: 'b', quantity: 1, unitPrice: '200.00',  taxRate: '12.00' },
    ], '120.00');
    // shares 100 / 20 → nets 900 / 180 → tax 137.29 + 19.29
    expect(r.lines[0].taxAmount).toBe('137.29');
    expect(r.lines[1].taxAmount).toBe('19.29');
    expect(r.taxAmount).toBe('156.58');
    expect(r.total).toBe('1080.00');
  });

  it('full discount → zero tax', () => {
    const r = calculateBill([{ productId: 'w', quantity: 2, unitPrice: '100.00', taxRate: '18.00' }], '200.00');
    expect(r.total).toBe('0.00');
    expect(r.taxAmount).toBe('0.00');
  });
});

describe('allocateDiscount', () => {
  const D = (v: string) => new Decimal(v);
  it('shares sum exactly to the discount and never go negative', () => {
    const shares = allocateDiscount([D('33.33'), D('33.33'), D('33.34')], D('10.00'));
    expect(shares.reduce((s: any, x: any) => s.plus(x), D('0')).toFixed(2)).toBe('10.00');
    expect(shares.every((s: any) => !s.isNegative())).toBe(true);
  });
  it('returns zeros when there is no discount', () => {
    expect(allocateDiscount([D('5'), D('7')], D('0')).map((s) => s.toFixed(2))).toEqual(['0.00', '0.00']);
  });
});