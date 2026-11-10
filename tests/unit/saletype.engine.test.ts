import { describe, expect, it } from 'vitest';
import {
  applyTransfer, counterQuantity, explicitTotal, normalizeSaleTypeCode, rowTypeId, unitPriceFor,
} from '../../src/modules/saletypes/saletype.engine.js';
import { computeLine, violatesInvariant } from '../../src/modules/counters/counter.engine.js';
import { counterSheetSalesLines } from '../../src/modules/accounting/ledger.engine.js';

const walkIn = { id: 'w', name: 'Walk-in', isDefault: true };
const janata = { id: 'j', name: 'Janata', isDefault: false };
const permit = { id: 'p', name: 'Permit', isDefault: false };

describe('sale type pricing and ids', () => {
  it('the default type is priced by the MRP; others default to MRP when not explicitly set', () => {
    expect(unitPriceFor(walkIn, '1000.00', null)).toBe('1000.00');
    expect(unitPriceFor(janata, '1000.00', '900')).toBe('900.00');
    expect(unitPriceFor(janata, '1000.00', null)).toBe('1000.00');        // defaults to Walk-in MRP
    expect(unitPriceFor(janata, '1000.00', '0')).toBe('1000.00');         // 0 falls back to Walk-in MRP
  });
  it('rows store NULL for the default type', () => {
    expect(rowTypeId(walkIn)).toBeNull();
    expect(rowTypeId(janata)).toBe('j');
  });
  it('derives a stable code from a name', () => {
    expect(normalizeSaleTypeCode(' Permit  room ')).toBe('PERMIT_ROOM');
    expect(() => normalizeSaleTypeCode('---')).toThrow();
  });
});

describe('counters', () => {
  it('the default counter is the total minus the explicit ones', () => {
    const explicit = new Map([['j', 30], ['p', 5]]);
    expect(counterQuantity(walkIn, 100, explicit)).toBe(65);
    expect(counterQuantity(janata, 100, explicit)).toBe(30);
    expect(counterQuantity(permit, 100, new Map())).toBe(0);
    expect(explicitTotal(explicit)).toBe(35);
  });

  it('a transfer moves bottles between counters and never changes the shop total', () => {
    const start = new Map<string, number>();
    const toJanata = applyTransfer(100, start, walkIn, janata, 30);
    expect(counterQuantity(walkIn, 100, toJanata)).toBe(70);
    expect(counterQuantity(janata, 100, toJanata)).toBe(30);
    const back = applyTransfer(100, toJanata, janata, walkIn, 10);
    expect(counterQuantity(janata, 100, back)).toBe(20);
    const across = applyTransfer(100, toJanata, janata, permit, 12);
    expect(counterQuantity(janata, 100, across)).toBe(18);
    expect(counterQuantity(permit, 100, across)).toBe(12);
    expect(counterQuantity(walkIn, 100, across)).toBe(70);
  });

  it('refuses to move more than a counter holds, to the same counter, or a non-positive amount', () => {
    const explicit = new Map([['j', 30]]);
    expect(() => applyTransfer(100, explicit, janata, walkIn, 31)).toThrow(/Only 30 available in Janata/);
    expect(() => applyTransfer(100, explicit, walkIn, janata, 71)).toThrow(/Only 70 available in Walk-in/);
    expect(() => applyTransfer(100, explicit, walkIn, walkIn, 1)).toThrow(/different/);
    expect(() => applyTransfer(100, explicit, walkIn, janata, 0)).toThrow();
  });
});

describe('counter sheet line with transfers', () => {
  it('bottles moved in are available, bottles moved out are not sales', () => {
    // Janata: opened 0, 20 moved in, 16 left → 4 sold at 180
    expect(computeLine({ opening: 0, inward: 0, transfer: 20, closing: 16, rate: '180.00' })).toMatchObject({ sold: 4, revenue: '720.00' });
    // Walk-in: opened 100, 20 moved out, 80 left → nothing sold
    expect(computeLine({ opening: 100, inward: 0, transfer: -20, closing: 80, rate: '200.00' })).toMatchObject({ sold: 0, revenue: '0.00' });
    expect(violatesInvariant({ opening: 100, inward: 0, transfer: -20, closing: 81 })).toBe(true);
    expect(() => computeLine({ opening: 5, inward: 0, transfer: -9, closing: 0, rate: '1.00' })).toThrow(/moved out/);
  });
  it('without a transfer it behaves as before', () => {
    expect(computeLine({ opening: 10, inward: 5, closing: 12, rate: '100.00' })).toMatchObject({ sold: 3, revenue: '300.00' });
  });
});

describe('counterSheetSalesLines (bottles sold without a bill)', () => {
  it('Dr CASH = Cr SALES + Cr OUTPUT_GST, GST back-calculated per line', () => {
    const lines = counterSheetSalesLines([{ amount: '360.00', taxRate: '12' }]);
    const amt = (code: string, side: 'debit' | 'credit') => lines.find((l) => l.ledger === code)![side];
    expect(amt('CASH', 'debit')).toBe('360.00');
    expect(amt('SALES', 'credit')).toBe('321.43');
    expect(amt('OUTPUT_GST', 'credit')).toBe('38.57');
  });
  it('zero-rated lines post no GST line and an empty list is refused', () => {
    const lines = counterSheetSalesLines([{ amount: '500.00', taxRate: '0' }]);
    expect(lines.some((l) => l.ledger === 'OUTPUT_GST')).toBe(false);
    expect(() => counterSheetSalesLines([])).toThrow();
  });
});
