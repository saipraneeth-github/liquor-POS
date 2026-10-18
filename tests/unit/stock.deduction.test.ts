import { describe, it, expect } from 'vitest';
import {
  checkStockAvailability,
  computeStockDeltas,
  computeVoidStockDeltas,
} from '../../src/modules/stock/stock.engine.js';

describe('checkStockAvailability', () => {
  it('returns empty array when all stock is sufficient', () => {
    const stockMap = new Map([
      ['p1', 10],
      ['p2', 5],
    ]);
    const items = [
      { productId: 'p1', quantity: 3 },
      { productId: 'p2', quantity: 5 },
    ];
    expect(checkStockAvailability(items, stockMap)).toEqual([]);
  });

  it('returns shortage when stock is insufficient', () => {
    const stockMap = new Map([['p1', 2]]);
    const items = [{ productId: 'p1', quantity: 5 }];
    const shortages = checkStockAvailability(items, stockMap);
    expect(shortages).toHaveLength(1);
    expect(shortages[0]).toMatchObject({ productId: 'p1', requested: 5, available: 2 });
  });

  it('treats unknown product as zero stock', () => {
    const stockMap = new Map<string, number>();
    const items = [{ productId: 'p-unknown', quantity: 1 }];
    const shortages = checkStockAvailability(items, stockMap);
    expect(shortages).toHaveLength(1);
    expect(shortages[0].available).toBe(0);
  });

  it('returns multiple shortages', () => {
    const stockMap = new Map([
      ['p1', 0],
      ['p2', 1],
    ]);
    const items = [
      { productId: 'p1', quantity: 2 },
      { productId: 'p2', quantity: 3 },
    ];
    expect(checkStockAvailability(items, stockMap)).toHaveLength(2);
  });

  it('exact quantity match (boundary) is not a shortage', () => {
    const stockMap = new Map([['p1', 5]]);
    const items = [{ productId: 'p1', quantity: 5 }];
    expect(checkStockAvailability(items, stockMap)).toEqual([]);
  });
});

describe('computeStockDeltas', () => {
  it('produces negative deltas for sales', () => {
    const deltas = computeStockDeltas([
      { productId: 'p1', quantity: 3 },
      { productId: 'p2', quantity: 1 },
    ]);
    expect(deltas[0].delta).toBe(-3);
    expect(deltas[1].delta).toBe(-1);
  });
});

describe('computeVoidStockDeltas', () => {
  it('produces positive deltas for void reversals', () => {
    const deltas = computeVoidStockDeltas([
      { productId: 'p1', quantity: 3 },
    ]);
    expect(deltas[0].delta).toBe(3);
  });

  it('void delta is always positive even if input is negative', () => {
    const deltas = computeVoidStockDeltas([{ productId: 'p1', quantity: -3 }]);
    expect(deltas[0].delta).toBeGreaterThan(0);
  });
});
