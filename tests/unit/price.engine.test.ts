import { describe, it, expect } from 'vitest';
import { defaultPrice, foldBranchPrices, needsTenantPrice, positivePrice, resolveUnitPrice } from '../../src/modules/catalog/price.engine.js';

describe('positivePrice', () => {
  it('accepts positive amounts and normalises to 2dp', () => {
    expect(positivePrice('850')).toBe('850.00');
    expect(positivePrice('850.5')).toBe('850.50');
    expect(positivePrice(12)).toBe('12.00');
  });
  it('rejects zero, blank, negative and junk', () => {
    for (const v of [null, undefined, '', '  ', '0', '0.00', '-5', 'abc']) expect(positivePrice(v as never)).toBeNull();
  });
});

describe('default price', () => {
  it('is the tenant price when the branch has no override', () => {
    expect(defaultPrice('1000.00')).toBe('1000.00');
    expect(defaultPrice('1000.00', {})).toBe('1000.00');
  });
  it('the branch override wins', () => {
    expect(defaultPrice('1000.00', { base: '1100.00' })).toBe('1100.00');
  });
  it('an unpriced product is null, and a branch override makes it sellable there', () => {
    expect(defaultPrice('0.00')).toBeNull();
    expect(defaultPrice('0.00', { base: '900.00' })).toBe('900.00');
    expect(needsTenantPrice('0.00')).toBe(true);
    expect(needsTenantPrice('1.00')).toBe(false);
  });
  it('a zero override is ignored (falls back to the tenant price)', () => {
    expect(defaultPrice('1000.00', { base: '0.00' })).toBe('1000.00');
  });
});

describe('resolveUnitPrice', () => {
  const walkIn = { id: 'w', isDefault: true };
  const janata = { id: 'j', isDefault: false };

  it('default type: branch override, else tenant price', () => {
    expect(resolveUnitPrice(walkIn, '500.00', null)).toBe('500.00');
    expect(resolveUnitPrice(walkIn, '500.00', '400.00', { base: '520.00' })).toBe('520.00');   // a typed price is irrelevant to the default type
  });
  it('other type: branch override for that type, then the tenant type price; never the default-type price', () => {
    expect(resolveUnitPrice(janata, '500.00', '450.00', { byType: { j: '440.00' } })).toBe('440.00');
    expect(resolveUnitPrice(janata, '500.00', '450.00', { base: '520.00' })).toBe('450.00');
    expect(resolveUnitPrice(janata, '500.00', null, { base: '520.00' })).toBeNull();
    expect(resolveUnitPrice(janata, '500.00', null)).toBeNull();
  });
  it("another type's override does not apply", () => {
    expect(resolveUnitPrice(janata, '500.00', '450.00', { byType: { other: '1.00' } })).toBe('450.00');
  });
  it('null when nothing is priced anywhere', () => {
    expect(resolveUnitPrice(walkIn, '0.00', null)).toBeNull();
    expect(resolveUnitPrice(janata, '0.00', '0.00')).toBeNull();
  });
});

describe('foldBranchPrices', () => {
  it('groups default and per-type overrides by product', () => {
    const m = foldBranchPrices([
      { productId: 'a', saleTypeId: null, price: '10.00' },
      { productId: 'a', saleTypeId: 't1', price: '9.00' },
      { productId: 'b', saleTypeId: 't1', price: '8.00' },
    ]);
    expect(m.get('a')).toEqual({ base: '10.00', byType: { t1: '9.00' } });
    expect(m.get('b')).toEqual({ byType: { t1: '8.00' } });
  });
});
