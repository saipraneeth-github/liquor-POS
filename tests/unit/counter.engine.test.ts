import { describe, it, expect } from 'vitest';
import {
  computeLine,
  computeSheetTotal,
  violatesInvariant,
  casesAndLooseToBottles,
  bottlesToCasesAndLoose,
  CounterInvariantError,
} from '../../src/modules/counters/counter.engine.js';

describe('computeLine', () => {
  it('Sold = Opening + Inward - Closing; Revenue = Sold x Rate', () => {
    expect(computeLine({ opening: 40, inward: 24, closing: 50, rate: '1000.00' }))
      .toEqual({ sold: 14, revenue: '14000.00', surplus: 0 });
  });

  it('beer: opening 2 cases of 12 + 5 bottles, 1 case inward, 1 case + 3 left', () => {
    const opening = casesAndLooseToBottles(2, 5, 12);   // 29
    const inward = casesAndLooseToBottles(1, 0, 12);    // 12
    const closing = casesAndLooseToBottles(1, 3, 12);   // 15
    expect(opening).toBe(29);
    const r = computeLine({ opening, inward, closing, rate: '200.00' });
    expect(r.sold).toBe(26);
    expect(r.revenue).toBe('5200.00');
  });

  it('zero sales when closing = opening + inward', () => {
    expect(computeLine({ opening: 10, inward: 2, closing: 12, rate: '150.00' }))
      .toEqual({ sold: 0, revenue: '0.00', surplus: 0 });
  });

  it('decimal rates keep 2dp precision', () => {
    expect(computeLine({ opening: 3, inward: 0, closing: 0, rate: '99.99' }).revenue).toBe('299.97');
    expect(computeLine({ opening: 7, inward: 0, closing: 0, rate: '0.10' }).revenue).toBe('0.70');
  });

  it('rejects closing > opening + inward unless an adjustment is allowed', () => {
    const line = { opening: 5, inward: 1, closing: 8, rate: '100.00' };
    expect(violatesInvariant(line)).toBe(true);
    expect(() => computeLine(line)).toThrow(CounterInvariantError);
    expect(computeLine(line, { allowAdjustment: true })).toEqual({ sold: 0, revenue: '0.00', surplus: 2 });
  });

  it('rejects negative / fractional counts and bad rates', () => {
    expect(() => computeLine({ opening: -1, inward: 0, closing: 0, rate: '1.00' })).toThrow(/non-negative/);
    expect(() => computeLine({ opening: 1.5, inward: 0, closing: 0, rate: '1.00' })).toThrow(/non-negative/);
    expect(() => computeLine({ opening: 1, inward: 0, closing: 0, rate: 'abc' })).toThrow(/Invalid rate/);
  });
});

describe('computeSheetTotal', () => {
  it('sums line revenues to 2dp', () => {
    expect(computeSheetTotal([{ revenue: '14000.00' }, { revenue: '5200.00' }, { revenue: '0.70' }])).toBe('19200.70');
    expect(computeSheetTotal([])).toBe('0.00');
  });
});

describe('case <-> bottle helpers', () => {
  it('splits bottles into cases and loose', () => {
    expect(bottlesToCasesAndLoose(29, 12)).toEqual({ cases: 2, loose: 5 });
    expect(bottlesToCasesAndLoose(24, 12)).toEqual({ cases: 2, loose: 0 });
    expect(bottlesToCasesAndLoose(7, null)).toEqual({ cases: 0, loose: 7 });
  });

  it('refuses cases for products without a pack quantity', () => {
    expect(casesAndLooseToBottles(0, 4, null)).toBe(4);
    expect(() => casesAndLooseToBottles(1, 0, null)).toThrow(/pack quantity/);
  });
});
