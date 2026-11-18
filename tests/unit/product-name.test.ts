import { describe, it, expect } from 'vitest';
import { cleanProductName } from '../../src/lib/product-name.js';

describe('cleanProductName', () => {
  it('strips bracketed case and bottle counts', () => {
    expect(cleanProductName('BUDWEISER KING OF BEERS [29 cs + 10 btls]')).toBe('BUDWEISER KING OF BEERS');
    expect(cleanProductName('KING FISHER PREMIUM LAGER BEER [50 cs]')).toBe('KING FISHER PREMIUM LAGER BEER');
    expect(cleanProductName('HAYWARDS 5000 SUPER STRONG BEER [50 cs]')).toBe('HAYWARDS 5000 SUPER STRONG BEER');
  });

  it('strips parenthesized case and bottle counts', () => {
    expect(cleanProductName('KINGFISHER ULTRA LAGER BEER (10 cs)')).toBe('KINGFISHER ULTRA LAGER BEER');
    expect(cleanProductName('TUBORG STRONG (25 cs + 5 btls)')).toBe('TUBORG STRONG');
  });

  it('strips trailing unbracketed case counts', () => {
    expect(cleanProductName('ROYAL STAG DELUXE 50 cs')).toBe('ROYAL STAG DELUXE');
  });

  it('preserves volume and brand details', () => {
    expect(cleanProductName('BUDWEISER KING OF BEERS [29 cs + 10 btls] 650ml')).toBe('BUDWEISER KING OF BEERS 650ml');
    expect(cleanProductName('MCDOWELLS NO.1 LUXURY WHISKY 750ml')).toBe('MCDOWELLS NO.1 LUXURY WHISKY 750ml');
  });

  it('handles null, undefined and empty strings safely', () => {
    expect(cleanProductName(null)).toBe('');
    expect(cleanProductName(undefined)).toBe('');
    expect(cleanProductName('')).toBe('');
  });
});
