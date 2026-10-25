import { describe, it, expect } from 'vitest';
import { aggregateConsolidatedInvoice, assertValidPeriod } from '../../src/modules/syndicates/consolidation.engine.js';

const branches = [
  { id: 'b2', name: 'Second', code: 'ZZ2' },
  { id: 'b1', name: 'First', code: 'AA1' },
  { id: 'b3', name: 'Idle', code: 'MM3' },
];

describe('aggregateConsolidatedInvoice', () => {
  it('sums PAID bills only and produces a per-branch breakdown (sorted by code, idle branches included)', () => {
    const result = aggregateConsolidatedInvoice(branches, [
      { branchId: 'b1', total: '1000.00', taxAmount: '152.54', status: 'PAID' },
      { branchId: 'b1', total: '200.00', taxAmount: '21.43', status: 'PAID' },
      { branchId: 'b2', total: '0.10', taxAmount: '0.01', status: 'PAID' },
      { branchId: 'b2', total: '0.20', taxAmount: '0.02', status: 'PAID' },
      { branchId: 'b2', total: '999.00', taxAmount: '99.00', status: 'VOIDED' },
      { branchId: 'b1', total: '50.00', taxAmount: '5.00', status: 'OPEN' },
    ]);

    expect(result.grossSales).toBe('1200.30');
    expect(result.totalTax).toBe('174.00');
    expect(result.billCount).toBe(4);
    expect(result.breakdown.map((b) => b.branchCode)).toEqual(['AA1', 'MM3', 'ZZ2']);
    expect(result.breakdown[0]).toEqual({
      branchId: 'b1', branchName: 'First', branchCode: 'AA1', grossSales: '1200.00', totalTax: '173.97', billCount: 2,
    });
    expect(result.breakdown[1]).toMatchObject({ grossSales: '0.00', billCount: 0 });
    expect(result.breakdown[2]).toMatchObject({ grossSales: '0.30', totalTax: '0.03', billCount: 2 });
  });

  it('returns zeros for no bills', () => {
    const result = aggregateConsolidatedInvoice(branches, []);
    expect(result).toMatchObject({ grossSales: '0.00', totalTax: '0.00', billCount: 0 });
  });

  it('rejects bills from branches outside the syndicate', () => {
    expect(() => aggregateConsolidatedInvoice(branches, [
      { branchId: 'foreign', total: '10.00', taxAmount: '1.00', status: 'PAID' },
    ])).toThrow('outside the syndicate');
  });
});

describe('assertValidPeriod', () => {
  it('accepts a single-day and a month period', () => {
    expect(() => assertValidPeriod('2026-01-01', '2026-01-01')).not.toThrow();
    expect(() => assertValidPeriod('2026-01-01', '2026-01-31')).not.toThrow();
  });

  it('rejects inverted, malformed and over-long periods', () => {
    expect(() => assertValidPeriod('2026-02-01', '2026-01-01')).toThrow('on or after');
    expect(() => assertValidPeriod('2026/01/01', '2026-01-02')).toThrow('Invalid date');
    expect(() => assertValidPeriod('2024-01-01', '2026-01-01')).toThrow('cannot exceed');
  });
});
