import { describe, it, expect } from 'vitest';
import { PackQuantityEngine } from '../../src/modules/products/pack-qty.engine.js';

describe('PackQuantityEngine', () => {
  it('converts cases to total bottles correctly', () => {
    // 10.5 cases of 12-pack (e.g. 750ml bottles)
    expect(PackQuantityEngine.casesToBottles(10.5, 12)).toBe(126);

    // 5 cases of 24-pack (e.g. 375ml pints)
    expect(PackQuantityEngine.casesToBottles(5, 24)).toBe(120);

    // 2.25 cases of 48-pack (e.g. 180ml nips)
    expect(PackQuantityEngine.casesToBottles(2.25, 48)).toBe(108);
  });

  it('handles invalid pack quantity', () => {
    expect(PackQuantityEngine.casesToBottles(10, 0)).toBe(0);
    expect(PackQuantityEngine.bottlesToCases(10, -5)).toBe(0);
  });

  it('converts total bottles to cases correctly', () => {
    expect(PackQuantityEngine.bottlesToCases(126, 12)).toBe(10.5);
    expect(PackQuantityEngine.bottlesToCases(120, 24)).toBe(5);
    expect(PackQuantityEngine.bottlesToCases(108, 48)).toBe(2.25);
  });
});
