import { describe, it, expect } from 'vitest';
import {
  MAX_PARKED, addParked, discountFromAmount, discountFromPercent, loadParked, quickCashOptions, recentProductIds, recordSale, removeParked,
  resolveScan, saveParked, tender, type ParkedBill,
} from '../../frontend/src/pos/posLogic.js';

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe('discounts', () => {
  it('a percentage of the subtotal, never above the cap, rounded down for a capped user', () => {
    expect(discountFromPercent(1000, 5, 5)).toEqual({ pct: 5, amount: 50 });
    expect(discountFromPercent(1000, 12, 5)).toEqual({ pct: 5, amount: 50 });          // typed past the cap: held to it
    expect(discountFromPercent(333.33, 5, 5).amount).toBe(16.66);                     // 16.6665 → down, so it can never exceed 5%
    expect(discountFromPercent(1000, 12, null)).toEqual({ pct: 12, amount: 120 });    // no cap
    expect(discountFromPercent(1000, -3, null).amount).toBe(0);
    expect(discountFromPercent(1000, Number.NaN, 5).amount).toBe(0);
  });
  it('a rupee amount is held to the cap and to the subtotal', () => {
    expect(discountFromAmount(1000, 40, 5)).toMatchObject({ amount: 40, pct: 4 });
    expect(discountFromAmount(1000, 100, 5).amount).toBe(50);                         // over the cap: held to ₹50
    expect(discountFromAmount(1000, 5000, null).amount).toBe(1000);                   // never more than the bill
    expect(discountFromAmount(0, 10, null)).toEqual({ pct: 0, amount: 0 });
    expect(discountFromAmount(1000, -1, 5).amount).toBe(0);
  });
  it('an amount within the cap always passes the server\'s exact check (paise only)', () => {
    for (const subtotal of [199.99, 333.33, 1050, 7.77, 12345.67]) {
      const { amount } = discountFromAmount(subtotal, 99999, 5);
      expect(Math.round(amount * 100) * 100).toBeLessThanOrEqual(Math.round(subtotal * 100) * 5);
    }
  });
});

describe('cash tender', () => {
  it('offers the exact amount, then the next round figures', () => {
    expect(quickCashOptions(463)).toEqual([463, 470, 500, 1000, 2000]);
    expect(quickCashOptions(500)).toEqual([500, 1000, 2000]);
    expect(quickCashOptions(99.5)).toEqual([99.5, 100, 500, 1000, 2000]);
    expect(quickCashOptions(0)).toEqual([]);
  });
  it('works out the change, the shortfall, or "nothing typed"', () => {
    expect(tender(463, '')).toEqual({ state: 'none', received: 463, change: 0, short: 0 });
    expect(tender(463, '500')).toEqual({ state: 'ok', received: 500, change: 37, short: 0 });
    expect(tender(463, '463')).toMatchObject({ state: 'ok', change: 0 });
    expect(tender(463, '400')).toEqual({ state: 'short', received: 400, change: 0, short: 63 });
    expect(tender(463, 'abc').state).toBe('short');
    expect(tender(463, '-5').state).toBe('short');
    expect(tender(99.9, '100').change).toBe(0.1);                                       // no float noise
  });
});

describe('Enter in the search box', () => {
  const a = { id: 'a', barcode: '8901' }, b = { id: 'b', barcode: '8902' }, c = { id: 'c', barcode: '' };
  it('an exact barcode wins, even if more products are showing', () => {
    expect(resolveScan([a, b, c], [a, b, c], '8902')).toEqual({ kind: 'match', product: b });
    expect(resolveScan([a, b, c], [a, b, c], ' 8902 ')).toEqual({ kind: 'match', product: b });
  });
  it('otherwise one visible product is the answer, several are left to pick, none is none', () => {
    expect(resolveScan([a, b, c], [c], 'whisky')).toEqual({ kind: 'match', product: c });
    expect(resolveScan([a, b, c], [a, b], 'whisky')).toEqual({ kind: 'many' });
    expect(resolveScan([a, b, c], [], 'nothing')).toEqual({ kind: 'none' });
    expect(resolveScan([a, b, c], [a, b, c], '   ')).toEqual({ kind: 'none' });
  });
  it('two products with one barcode are not guessed between', () => {
    expect(resolveScan([a, { id: 'a2', barcode: '8901' }], [a], '8901')).toEqual({ kind: 'many' });
  });
});

describe('parked bills', () => {
  const bill = (id: string): ParkedBill => ({ id, parkedAt: '2026-11-12T10:00:00Z', saleTypeId: '', paymentMode: 'CASH', discountPercent: '', buyerGstin: '', customer: null, lines: [{ productId: 'p', qty: 1 }], items: 1, total: '100.00' });
  it('keeps the newest first and at most ten', () => {
    let list: ParkedBill[] = [];
    for (let i = 0; i < 12; i++) list = addParked(list, bill(`b${i}`));
    expect(list).toHaveLength(MAX_PARKED);
    expect(list[0].id).toBe('b11');
    expect(list.map((b) => b.id)).not.toContain('b0');
  });
  it('parking the same bill again replaces it instead of duplicating it', () => {
    const list = addParked(addParked([], bill('x')), { ...bill('x'), total: '250.00' });
    expect(list).toHaveLength(1);
    expect(list[0].total).toBe('250.00');
  });
  it('removes one, and survives storage round-trips and bad data', () => {
    const store = memory();
    saveParked(store, 'u1', [bill('a'), bill('b')]);
    expect(loadParked(store, 'u1').map((b) => b.id)).toEqual(['a', 'b']);
    expect(removeParked(loadParked(store, 'u1'), 'a').map((b) => b.id)).toEqual(['b']);
    expect(loadParked(store, 'someone-else')).toEqual([]);                              // per person
    store.setItem('lc_pos_parked:u2', '{oops');
    expect(loadParked(store, 'u2')).toEqual([]);
  });
});

describe('recently sold', () => {
  it('lists the most recently sold first, and a repeat sale moves a product up', () => {
    const store = memory();
    recordSale(store, 'b1', ['a', 'b'], 1000);
    recordSale(store, 'b1', ['c'], 2000);
    expect(recentProductIds(store, 'b1', 8)[0]).toBe('c');
    recordSale(store, 'b1', ['a'], 3000);
    expect(recentProductIds(store, 'b1', 8)[0]).toBe('a');
    expect(recentProductIds(store, 'b1', 2)).toHaveLength(2);
    expect(recentProductIds(store, 'other-branch', 8)).toEqual([]);                      // per branch
  });
  it('never throws on broken storage', () => {
    const broken = { getItem: () => { throw new Error('no'); }, setItem: () => { throw new Error('no'); } };
    expect(() => recordSale(broken, 'b', ['a'])).not.toThrow();
    expect(recentProductIds(broken, 'b')).toEqual([]);
  });
});
