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

import { deductMl, restoreMl } from '../../src/modules/menu/serving.engine.js';

describe('deductMl', () => {
  it('deducts from open ml without opening new bottle', () => {
    const result = deductMl({ quantity: 5, openMl: 100 }, 60, 750);
    expect(result).toEqual({ state: { quantity: 5, openMl: 40 }, bottlesOpened: 0 });
  });

  it('opens a new bottle if open ml is insufficient', () => {
    const result = deductMl({ quantity: 5, openMl: 30 }, 60, 750);
    expect(result).toEqual({ state: { quantity: 4, openMl: 720 }, bottlesOpened: 1 });
  });

  it('opens multiple bottles if requested ml is larger than bottle capacity', () => {
    const result = deductMl({ quantity: 5, openMl: 0 }, 1600, 750);
    expect(result).toEqual({ state: { quantity: 2, openMl: 650 }, bottlesOpened: 3 }); // 3 * 750 = 2250, 2250 - 1600 = 650
  });

  it('returns null if not enough sealed bottles', () => {
    const result = deductMl({ quantity: 1, openMl: 30 }, 1600, 750);
    expect(result).toBeNull();
  });

  it('exact bottle multiple from zero open ml', () => {
    const result = deductMl({ quantity: 5, openMl: 0 }, 1500, 750);
    expect(result).toEqual({ state: { quantity: 3, openMl: 0 }, bottlesOpened: 2 });
  });

  it('exact bottle multiple with some open ml', () => {
    const result = deductMl({ quantity: 5, openMl: 100 }, 1500, 750);
    expect(result).toEqual({ state: { quantity: 3, openMl: 100 }, bottlesOpened: 2 });
  });

  it('handles exact amount remaining in open bottle', () => {
    const result = deductMl({ quantity: 5, openMl: 60 }, 60, 750);
    expect(result).toEqual({ state: { quantity: 5, openMl: 0 }, bottlesOpened: 0 });
  });

  it('rejects zero or negative ml', () => {
    expect(() => deductMl({ quantity: 5, openMl: 0 }, 0, 750)).toThrow();
    expect(() => deductMl({ quantity: 5, openMl: 0 }, -10, 750)).toThrow();
  });

  it('handles small fractional ml requests (e.g., 0.5ml)', () => {
    const result = deductMl({ quantity: 5, openMl: 1 }, 0.5, 750);
    expect(result).toEqual({ state: { quantity: 5, openMl: 0.5 }, bottlesOpened: 0 });
  });
});

describe('restoreMl', () => {
  it('restores ml to open bottle', () => {
    const result = restoreMl({ quantity: 5, openMl: 40 }, 60, 750);
    expect(result).toEqual({ quantity: 5, openMl: 100 });
  });

  it('restores to a full sealed bottle if ml exceeds bottle capacity', () => {
    const result = restoreMl({ quantity: 5, openMl: 700 }, 60, 750);
    expect(result).toEqual({ quantity: 6, openMl: 10 });
  });

  it('restores multiple sealed bottles', () => {
    const result = restoreMl({ quantity: 5, openMl: 0 }, 1600, 750);
    expect(result).toEqual({ quantity: 7, openMl: 100 });
  });

  it('exact bottle multiple restore', () => {
    const result = restoreMl({ quantity: 5, openMl: 0 }, 1500, 750);
    expect(result).toEqual({ quantity: 7, openMl: 0 });
  });

  it('rejects zero or negative ml', () => {
    expect(() => restoreMl({ quantity: 5, openMl: 0 }, 0, 750)).toThrow();
    expect(() => restoreMl({ quantity: 5, openMl: 0 }, -10, 750)).toThrow();
  });
});
