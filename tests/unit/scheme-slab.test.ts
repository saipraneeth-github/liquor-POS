import { describe, it, expect } from 'vitest';
import { evaluateSlabs, validateSlabs, type CaseSlab } from '../../src/modules/schemes/slab.engine.js';

const SLABS: CaseSlab[] = [
  { minCases: 10, freeBottles: 2,  discountPerCase: '50.00' },
  { minCases: 25, freeBottles: 6,  discountPerCase: '75.00' },
  { minCases: 50, freeBottles: 15, discountPerCase: '100.00' },
];

describe('evaluateSlabs — best slab (non-cumulative)', () => {
  it('below the first slab pays nothing and points at the first slab', () => {
    const r = evaluateSlabs(7, SLABS);
    expect(r.slab).toBeNull();
    expect(r.freeBottles).toBe(0);
    expect(r.discountTotal).toBe('0.00');
    expect(r.nextSlab?.minCases).toBe(10);
    expect(r.casesToNextSlab).toBe('3.00');
  });

  it('exact boundary qualifies for that slab', () => {
    const r = evaluateSlabs(25, SLABS);
    expect(r.slab?.minCases).toBe(25);
    expect(r.freeBottles).toBe(6);
    expect(r.discountTotal).toBe('1875.00');   // 75 × 25
    expect(r.nextSlab?.minCases).toBe(50);
    expect(r.casesToNextSlab).toBe('25.00');
  });

  it('between slabs uses the lower slab for ALL cases (not cumulative)', () => {
    const r = evaluateSlabs(40, SLABS);
    expect(r.slab?.minCases).toBe(25);
    expect(r.freeBottles).toBe(6);             // not 2 + 6
    expect(r.discountTotal).toBe('3000.00');   // 75 × 40
    expect(r.casesToNextSlab).toBe('10.00');
  });

  it('above the top slab uses the top slab and has no next slab', () => {
    const r = evaluateSlabs(120, SLABS);
    expect(r.slab?.minCases).toBe(50);
    expect(r.freeBottles).toBe(15);
    expect(r.discountTotal).toBe('12000.00');
    expect(r.nextSlab).toBeNull();
    expect(r.casesToNextSlab).toBeNull();
  });

  it('unsorted input gives the same result', () => {
    const shuffled = [SLABS[2], SLABS[0], SLABS[1]];
    expect(evaluateSlabs(40, shuffled)).toEqual(evaluateSlabs(40, SLABS));
    expect(evaluateSlabs(5, shuffled).nextSlab?.minCases).toBe(10);
  });

  it('empty slabs → no payout, no next slab', () => {
    const r = evaluateSlabs(100, []);
    expect(r).toEqual({
      totalCases: '100.00', slab: null, freeBottles: 0, discountTotal: '0.00', nextSlab: null, casesToNextSlab: null,
    });
  });

  it('accepts decimal-string totals (scheme_purchases.qty)', () => {
    const r = evaluateSlabs('10.50', SLABS);
    expect(r.slab?.minCases).toBe(10);
    expect(r.discountTotal).toBe('525.00');
  });

  it('rejects negative totals', () => {
    expect(() => evaluateSlabs(-1, SLABS)).toThrow(/negative/);
  });
});

describe('validateSlabs', () => {
  it('accepts valid slabs', () => {
    expect(validateSlabs(SLABS)).toBeNull();
  });
  it('rejects duplicate minCases', () => {
    expect(validateSlabs([...SLABS, { minCases: 25, freeBottles: 0, discountPerCase: '0' }])).toMatch(/Duplicate/);
  });
  it('rejects negative values', () => {
    expect(validateSlabs([{ minCases: -1, freeBottles: 0, discountPerCase: '0' }])).toMatch(/minCases/);
    expect(validateSlabs([{ minCases: 1, freeBottles: 0, discountPerCase: '-1' }])).toMatch(/discountPerCase/);
  });
});
