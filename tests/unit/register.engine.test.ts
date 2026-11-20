import { describe, it, expect } from 'vitest';
import { buildDailyRegister, buildRegister, registerToCsv, REASON_BUCKET } from '../../src/modules/compliance/register.engine.js';

const input = (over: Record<string, unknown> = {}) => ({
  productId: 'p1', name: 'Test Whisky 750ml', brand: 'TW', volumeMl: 750, packQuantity: 12, current: 80, after: 0, moves: {} as Record<string, number>, ...over,
});

describe('stock register', () => {
  it('opening + in - out = closing holds by construction, for every kind of movement', () => {
    const moves = { PURCHASE: 24, TRANSFER_IN: 6, TRANSFER_OUT: -4, PURCHASE_RETURN: -2, SALE: -30, VOID_REVERSAL: 1, SALES_RETURN: 2, COUNTER_SHEET: -3, BREAKAGE: -1, DAMAGE: -1, MANUAL_ADJUST: -5, TYPE_TRANSFER: 0 };
    const reg = buildRegister([input({ current: 80, moves })]);
    const r = reg.rows[0];
    expect(r).toMatchObject({ received: 24, transferIn: 6, transferOut: 4, returnedToSupplier: 2, sold: 27, counterSheetSales: 3, breakage: 2, adjustments: -5, closing: 80 });
    expect(r.opening + r.received + r.transferIn - r.transferOut - r.returnedToSupplier - r.sold - r.counterSheetSales - r.breakage + r.adjustments).toBe(r.closing);
    expect(r.opening).toBe(80 - (24 + 6 - 4 - 2 - 30 + 1 + 2 - 3 - 1 - 1 - 5));
  });

  it('a void or a customer return takes bottles off the sold figure', () => {
    expect(buildRegister([input({ moves: { SALE: -10, VOID_REVERSAL: 4, SALES_RETURN: 1 } })]).rows[0].sold).toBe(5);
  });

  it('anchors the closing to the live stock, not to the audit history', () => {
    // 80 on the shelf now, 15 more bottles left AFTER the period: the period closed with 95
    const r = buildRegister([input({ current: 80, after: -15, moves: { SALE: -5 } })]).rows[0];
    expect(r.closing).toBe(95);
    expect(r.opening).toBe(100);
  });

  it('totals the columns and the litres, rows sorted by name', () => {
    const reg = buildRegister([input({ productId: 'b', name: 'Beer 650ml', volumeMl: 650, current: 10, moves: { SALE: -2 } }), input({ current: 80, moves: { SALE: -5 } })]);
    expect(reg.rows.map((r) => r.name)).toEqual(['Beer 650ml', 'Test Whisky 750ml']);
    expect(reg.totals).toMatchObject({ sold: 7, closing: 90, opening: 97 });
    expect(reg.totals.closingLitres).toBe(66.5);   // 10 x 0.65 + 80 x 0.75
  });

  it('every known reason feeds a column; anything else is an adjustment', () => {
    expect(REASON_BUCKET.COUNTER_SHEET).toBe('counterSheetSales');
    expect(buildRegister([input({ current: 10, moves: { SOMETHING_NEW: -3 } })]).rows[0].adjustments).toBe(-3);
  });
});

describe('daily register', () => {
  it('carries the balance from day to day', () => {
    const days = buildDailyRegister(100, new Map([
      ['2026-11-03', { SALE: -5 }], ['2026-11-01', { PURCHASE: 24, BREAKAGE: -1 }], ['2026-11-02', { SALE: -10 }],
    ]));
    expect(days.map((d) => [d.date, d.opening, d.closing])).toEqual([['2026-11-01', 100, 123], ['2026-11-02', 123, 113], ['2026-11-03', 113, 108]]);
    expect(days[0]).toMatchObject({ received: 24, breakage: 1, sold: 0 });
  });
});

describe('csv', () => {
  it('quotes names with commas or quotes and ends with a TOTAL row', () => {
    const csv = registerToCsv(buildRegister([input({ name: 'Brandy, "Old" 750', current: 5, moves: { SALE: -1 } })]));
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toContain('Opening');
    expect(lines[1].startsWith('"Brandy, ""Old"" 750",TW,750,6,')).toBe(true);
    expect(lines[2].startsWith('TOTAL')).toBe(true);
  });
});
