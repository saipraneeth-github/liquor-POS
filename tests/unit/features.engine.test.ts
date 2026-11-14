import { describe, it, expect } from 'vitest';
import { FEATURES, FEATURE_KEYS, featureForPage, featureForPath, isFeatureKey } from '../../src/modules/platform/features.engine.js';

describe('featureForPath', () => {
  it('maps each feature\'s URLs, with or without the /api/v1 prefix and a query string', () => {
    expect(featureForPath('/api/v1/bank/accounts')).toBe('bank');
    expect(featureForPath('/api/v1/bank/statements/abc/lines?limit=500')).toBe('bank');
    expect(featureForPath('/bank')).toBe('bank');
    expect(featureForPath('/api/v1/accounting/trial-balance/xyz')).toBe('accounting');
    expect(featureForPath('/api/v1/expenses/xyz')).toBe('accounting');
    expect(featureForPath('/api/v1/tables/xyz')).toBe('bar');
    expect(featureForPath('/api/v1/kot/session/abc/bill')).toBe('bar');
    expect(featureForPath('/api/v1/invoices/xyz/upload')).toBe('invoices');
    expect(featureForPath('/api/v1/schemes/xyz/alerts')).toBe('schemes');
    expect(featureForPath('/api/v1/counter-sheets/sheet/abc/post')).toBe('counter_sheets');
    expect(featureForPath('/api/v1/closing')).toBe('closing');
  });

  it('matches whole path segments only', () => {
    expect(featureForPath('/api/v1/banking')).toBeNull();
    expect(featureForPath('/api/v1/tables-extra')).toBeNull();
    expect(featureForPath('/api/v1/bankx/accounts')).toBeNull();
  });

  it('leaves the screens the POS depends on alone', () => {
    for (const p of ['/api/v1/bills', '/api/v1/shifts/open', '/api/v1/products', '/api/v1/customers/xyz', '/api/v1/sale-types/xyz', '/api/v1/inventory/stock/xyz',
      '/api/v1/menu/xyz', '/api/v1/compliance/breakage/xyz', '/api/v1/compliance/pour-report/xyz', '/api/v1/me', '/api/v1/branches', '/api/v1/platform/branches']) {
      expect(featureForPath(p), p).toBeNull();
    }
  });

  it('covers only the excise parts of compliance, not breakage or pour control', () => {
    expect(featureForPath('/api/v1/compliance/quotas/xyz')).toBe('compliance');
    expect(featureForPath('/api/v1/compliance/lifting/xyz')).toBe('compliance');
    expect(featureForPath('/api/v1/compliance/stock-audit/xyz')).toBe('compliance');
    expect(featureForPath('/api/v1/compliance/breakage/xyz')).toBeNull();
  });
});

describe('registry', () => {
  it('has unique keys and no prefix claimed twice', () => {
    expect(new Set(FEATURE_KEYS).size).toBe(FEATURES.length);
    const prefixes = FEATURES.flatMap((f) => f.prefixes);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
  it('knows its keys and pages', () => {
    expect(isFeatureKey('bank')).toBe(true);
    expect(isFeatureKey('pos')).toBe(false);
    expect(featureForPage('/bank')).toBe('bank');
    expect(featureForPage('/counter')).toBe('counter_sheets');
    expect(featureForPage('/pos')).toBeNull();
  });
});
