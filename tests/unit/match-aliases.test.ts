import { describe, expect, it } from 'vitest';
import { matchLine, type CatalogProduct } from '../../src/modules/invoices/match.engine.js';

const prod = (over: Partial<CatalogProduct>): CatalogProduct => ({
  id: 'p1', name: 'Royal Stag', brand: 'Royal Stag', barcode: null, sku: null, exciseCode: null,
  volumeMl: 750, packQuantity: 12, isActive: true, ...over,
});

describe('trained brand codes', () => {
  it('matches a line whose code was taught for the product, size must agree', () => {
    const catalog = [prod({ aliasCodes: ['RS-9'] })];
    expect(matchLine({ description: 'ROYAL STAG', sku: 'rs-9', volumeMl: 750 }, catalog).status).toBe('MATCHED');
    expect(matchLine({ description: 'ROYAL STAG', sku: 'RS-9', volumeMl: 180 }, catalog).status).toBe('UNMATCHED');
  });
  it('treats leading zeros as the same code', () => {
    const catalog = [prod({ exciseCode: '0123' })];
    expect(matchLine({ description: 'X', sku: '123', volumeMl: 750 }, catalog).status).toBe('MATCHED');
  });
});
