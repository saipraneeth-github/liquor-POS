import { describe, it, expect } from 'vitest';
import { planSalesReturn, purchaseReturnTotal, refundLedgerFor, type ReturnableLine } from '../../src/modules/billing/return.engine.js';
import { buildMarginReport } from '../../src/modules/reports/margin.engine.js';

const line = (over: Partial<ReturnableLine> = {}): ReturnableLine => ({
  billItemId: 'L1', productId: 'P1', name: 'Whisky', quantity: 3, lineTotal: '3000.00', taxAmount: '457.63', servingId: null, returnedQty: 0, returnedGross: '0', returnedTax: '0', ...over,
});

describe('customer return', () => {
  it('refunds the share of what was actually paid, net of the bill discount', () => {
    // bill: 3000 gross, 300 discount (10%) -> the customer paid 2700 for 3 bottles
    const plan = planSalesReturn({ subtotal: '3000.00', discount: '300.00' }, [line()], [{ billItemId: 'L1', quantity: 1 }]);
    expect(plan.lines[0]).toMatchObject({ gross: '1000.00', tax: '152.54', net: '900.00', discount: '100.00' });
    expect(plan.totals).toEqual({ gross: '1000.00', tax: '152.54', discount: '100.00', refund: '900.00' });
  });

  it('part-returns add up to the line to the paisa: the last bottle takes the exact remainder', () => {
    const first = planSalesReturn({ subtotal: '3000.00', discount: '0' }, [line()], [{ billItemId: 'L1', quantity: 1 }]);
    const second = planSalesReturn({ subtotal: '3000.00', discount: '0' }, [line({ returnedQty: 1, returnedGross: first.lines[0].gross, returnedTax: first.lines[0].tax })], [{ billItemId: 'L1', quantity: 2 }]);
    expect(Number(first.lines[0].gross) + Number(second.lines[0].gross)).toBe(3000);
    expect((Number(first.lines[0].tax) + Number(second.lines[0].tax)).toFixed(2)).toBe('457.63');
  });

  it('refuses more than is left, a peg, a repeat, and an unknown line', () => {
    const bill = { subtotal: '3000.00', discount: '0' };
    expect(() => planSalesReturn(bill, [line({ returnedQty: 2, returnedGross: '2000', returnedTax: '300' })], [{ billItemId: 'L1', quantity: 2 }])).toThrow(/only 1 left/);
    expect(() => planSalesReturn(bill, [line({ servingId: 's1' })], [{ billItemId: 'L1', quantity: 1 }])).toThrow(/cannot be returned/);
    expect(() => planSalesReturn(bill, [line()], [{ billItemId: 'L1', quantity: 1 }, { billItemId: 'L1', quantity: 1 }])).toThrow(/twice/);
    expect(() => planSalesReturn(bill, [line()], [{ billItemId: 'nope', quantity: 1 }])).toThrow(/not on this bill/);
    expect(() => planSalesReturn(bill, [line()], [{ billItemId: 'L1', quantity: 0 }])).toThrow(/above zero/);
    expect(() => planSalesReturn(bill, [line()], [])).toThrow(/at least one/);
  });

  it('the money goes back where it came from', () => {
    expect(['CASH', 'UPI', 'CARD', 'CREDIT', undefined].map(refundLedgerFor)).toEqual(['CASH', 'BANK', 'BANK', 'SUNDRY_DEBTORS', 'CASH']);
  });
});

describe('return to a supplier', () => {
  it('prices each line and totals them', () => {
    const r = purchaseReturnTotal([{ productId: 'a', quantity: 2, unitCost: '800' }, { productId: 'b', quantity: 3, unitCost: '150.5' }]);
    expect(r.total).toBe('2051.50');
    expect(r.lines.map((l) => l.amount)).toEqual(['1600.00', '451.50']);
    expect(() => purchaseReturnTotal([{ productId: 'a', quantity: 1, unitCost: '0' }])).toThrow(/cost price/);
    expect(() => purchaseReturnTotal([])).toThrow(/at least one/);
  });
});

describe('margin', () => {
  const sold = [
    { productId: 'a', name: 'Whisky', quantity: 10, gross: '10000.00', tax: '1525.42', discountShare: '500.00' },
    { productId: 'b', name: 'Beer', quantity: 20, gross: '4000.00', tax: '610.17', discountShare: '0.00' },
    { productId: 'c', name: 'Local Rum', quantity: 5, gross: '1500.00', tax: '228.81', discountShare: '0.00' },
  ];
  const costs = new Map<string, string | null>([['a', '800'], ['b', '150'], ['c', null]]);

  it('is revenue net of tax and discount less quantity x cost; unknown cost is left blank', () => {
    const r = buildMarginReport(sold, [], costs);
    const whisky = r.rows.find((x) => x.productId === 'a')!;
    expect(whisky).toMatchObject({ revenue: '7974.58', cost: '8000.00', margin: '-25.42' });   // 10000 - 500 - 1525.42, less 10 x 800
    const rum = r.rows.find((x) => x.productId === 'c')!;
    expect(rum).toMatchObject({ unitCost: null, cost: null, margin: null, marginPct: null });
    expect(r.totals.withoutCost).toBe(1);
    // the total counts only products whose cost is known
    expect(r.totals.revenue).toBe((7974.58 + 3389.83).toFixed(2));
  });

  it('takes returns off the quantity and the revenue', () => {
    const r = buildMarginReport(sold, [{ productId: 'b', quantity: 5, gross: '1000.00', tax: '152.54', discountShare: '0.00' }], costs);
    const beer = r.rows.find((x) => x.productId === 'b')!;
    expect(beer.quantity).toBe(15);
    expect(beer.revenue).toBe('2542.37');   // (4000 - 610.17) - (1000 - 152.54)
    expect(beer.cost).toBe('2250.00');
  });

  it('ranks by margin and drops a product that was fully returned', () => {
    const r = buildMarginReport(
      [{ productId: 'a', name: 'Whisky', quantity: 2, gross: '2000.00', tax: '305.08', discountShare: '0.00' }],
      [{ productId: 'a', quantity: 2, gross: '2000.00', tax: '305.08', discountShare: '0.00' }], costs,
    );
    expect(r.rows).toEqual([]);
  });

  it('a peg counts as a fraction of a bottle', () => {
    const r = buildMarginReport([{ productId: 'a', name: 'Whisky', quantity: 2.5, gross: '2500.00', tax: '0.00', discountShare: '0.00' }], [], costs);
    expect(r.rows[0]).toMatchObject({ quantity: 2.5, cost: '2000.00' });
  });
});
