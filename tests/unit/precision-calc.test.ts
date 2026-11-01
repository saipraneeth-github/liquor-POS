import { describe, it, expect } from 'vitest';
import { calculatePrecisionLine, reconcileInvoiceTotals } from '../../src/modules/invoices/precision-calc.engine.js';
import { Decimal } from 'decimal.js';

describe('Precision Inventory Engine (Calculation Rule Verification)', () => {
  it('implements mandatory rule from ICDC 1 (Kingfisher 650ml: 12/case, 50 cases, rate 1501, line total 75050.00)', () => {
    const result = calculatePrecisionLine({
      lineNumber: 1,
      cases: 50,
      looseBottles: 0,
      packQuantity: 12,
      rate: '1501.00',
      caseRate: '1501.00',
      amount: '75050.00',
      mrp: '180.00',
    });

    expect(result.totalQuantity).toBe(600);
    expect(result.caseRate).toBe('1501.00');
    // Exact per-bottle cost = 1501 / 12 = 125.0833333...
    expect(result.costPrice).toBe('125.083333');
    expect(result.displayUnitCost).toBe('125.08');
    // Stored line total matches bill exactly
    expect(result.lineCostTotal).toBe('75050.00');
    // Verification: 600 * 125.083333 = 75049.9998
    expect(result.unitDerivedTotal).toBe('75049.9998');
    // Residual difference is explicitly reconciled
    expect(result.roundingAdjustment).toBe('0.0002');
  });

  it('implements mixed line with partial cases and loose bottles (ICDCA1 row 3: 29 cases, 10 bottles, amount 65663.17)', () => {
    const result = calculatePrecisionLine({
      lineNumber: 3,
      cases: 29,
      looseBottles: 10,
      packQuantity: 12,
      rate: '183.42',
      caseRate: '2201.00',
      amount: '65663.17',
      mrp: '220.00',
    });

    expect(result.totalQuantity).toBe(358);
    expect(result.caseRate).toBe('2201.00');
    // 2201 / 12 = 183.416666667
    expect(result.costPrice).toBe('183.416667');
    expect(result.displayUnitCost).toBe('183.42');
    expect(result.lineCostTotal).toBe('65663.17');
    // Derived total: 358 * 183.416667 = 65663.1668
    expect(new Decimal(result.roundingAdjustment).abs().toNumber()).toBeLessThanOrEqual(0.01);
  });

  it('implements loose-only partial cases (ICDCB row 24: 0 cases, 23 bottles, amount 7093.58)', () => {
    const result = calculatePrecisionLine({
      lineNumber: 24,
      cases: 0,
      looseBottles: 23,
      packQuantity: 24,
      rate: '308.42',
      caseRate: '7402.00',
      amount: '7093.58',
      mrp: '450.00',
    });

    expect(result.totalQuantity).toBe(23);
    expect(result.caseRate).toBe('7402.00');
    expect(result.costPrice).toBe('308.416667');
    expect(result.lineCostTotal).toBe('7093.58');
  });

  it('detects price increases and flags increases above 10%', () => {
    // Normal increase (5.55%)
    const res1 = calculatePrecisionLine({
      lineNumber: 1,
      cases: 50,
      looseBottles: 0,
      packQuantity: 12,
      caseRate: '1501.00',
      amount: '75050.00',
      mrp: '180.00',
      currentProductCost: '118.500000',
    });
    expect(res1.hasIncreased).toBe(true);
    expect(res1.isHighIncrease).toBe(false);
    expect(res1.costIncreasePct).toBe('5.56');
    expect(res1.flags).toContain('COST_INCREASED');

    // High increase (25.08%)
    const res2 = calculatePrecisionLine({
      lineNumber: 2,
      cases: 50,
      looseBottles: 0,
      packQuantity: 12,
      caseRate: '1501.00',
      amount: '75050.00',
      mrp: '180.00',
      currentProductCost: '100.000000',
    });
    expect(res2.hasIncreased).toBe(true);
    expect(res2.isHighIncrease).toBe(true);
    expect(res2.flags).toContain('HIGH_COST_INCREASE');
  });

  it('reconciles two-tier invoice totals (Wholesale Lines Basic Sum + MRP Rounding Off == Net Debit)', () => {
    const lines = [
      { lineCostTotal: '75050.00', unitDerivedTotal: '75049.9998', roundingAdjustment: '0.0002' },
      { lineCostTotal: '555174.00', unitDerivedTotal: '555174.0000', roundingAdjustment: '0.0000' },
    ];
    // Total lines sum = 630,224.00
    // MRP Rounding Off = 50,371.20
    // Net Invoice Value = 680,595.20
    const reconciled = reconcileInvoiceTotals(lines, '680595.20', '50371.20');

    expect(reconciled.linesBasicTotal).toBe('630224.00');
    expect(reconciled.mrpRoundingOff).toBe('50371.20');
    expect(reconciled.netInvoiceValue).toBe('680595.20');
    expect(reconciled.variance).toBe('0.00');
    expect(reconciled.isBalanced).toBe(true);
  });
});

