import { describe, it, expect } from 'vitest';
import { buildGstBreakdown, splitTax } from '../../src/modules/billing/gst.engine.js';
import { deductMl, restoreMl, splitUnitsAndMl, validateServings } from '../../src/modules/menu/serving.engine.js';
import { mergeBillItems, resolveTaxRate } from '../../src/modules/billing/billing.engine.js';
import { buildBillRows, buildKotRows, renderEscPos, renderText, type PrintBill } from '../../src/lib/print/index.js';
import { Decimal } from 'decimal.js';

describe('gst.engine', () => {
  it('splits tax into CGST + SGST that always add up (odd paisa goes to SGST)', () => {
    const s = splitTax(new Decimal('22.85'), false);
    expect(s.cgst.toFixed(2)).toBe('11.42');
    expect(s.sgst.toFixed(2)).toBe('11.43');
    expect(s.igst.toFixed(2)).toBe('0.00');
  });

  it('uses IGST for inter-state supply', () => {
    const s = splitTax(new Decimal('152.54'), true);
    expect(s.igst.toFixed(2)).toBe('152.54');
    expect(s.cgst.toFixed(2)).toBe('0.00');
  });

  it('derives taxable value, rate-wise summary and totals; discount is shared pro rata', () => {
    const g = buildGstBreakdown([
      { name: 'Whisky', quantity: 1, unitPrice: '1000.00', lineTotal: '1000.00', taxRate: '18.00', taxAmount: '152.54' },
      { name: 'Paneer', quantity: 2, unitPrice: '240.00', lineTotal: '480.00', taxRate: '5.00', taxAmount: '22.86' },
    ]);
    expect(g.lines[0].taxable).toBe('847.46');
    expect(g.summary.map((s) => s.rate)).toEqual(['5.00', '18.00']);
    expect(g.summary[1]).toMatchObject({ taxable: '847.46', cgst: '76.27', sgst: '76.27', tax: '152.54' });
    expect(g.totals.tax).toBe('175.40');
    expect(new Decimal(g.totals.taxable).plus(g.totals.tax).toFixed(2)).toBe('1480.00');
    expect(new Decimal(g.totals.cgst).plus(g.totals.sgst).toFixed(2)).toBe(g.totals.tax);
  });

  it('net of line = amount minus its share of the bill discount', () => {
    const g = buildGstBreakdown([
      { name: 'A', quantity: 1, unitPrice: '100.00', lineTotal: '100.00', taxRate: '18.00', taxAmount: '13.73' },
      { name: 'B', quantity: 1, unitPrice: '100.00', lineTotal: '100.00', taxRate: '18.00', taxAmount: '13.73' },
    ], '20.00');
    expect(g.lines.map((l) => l.net)).toEqual(['90.00', '90.00']);
    expect(g.totals.net).toBe('180.00');
  });
});

describe('billing helpers', () => {
  it('product GST overrides the category rate; falls back to 18 only when neither exists', () => {
    expect(resolveTaxRate('18', '5')).toBe('5.00');
    expect(resolveTaxRate('12', null)).toBe('12.00');
    expect(resolveTaxRate(null, undefined)).toBe('18.00');
  });

  it('keeps different servings of the same product on separate lines', () => {
    const merged = mergeBillItems([
      { productId: 'p', servingId: 's60', quantity: 1 },
      { productId: 'p', servingId: 's90', quantity: 1 },
      { productId: 'p', servingId: 's60', quantity: 2 },
      { productId: 'q', quantity: 1 },
    ]);
    expect(merged).toEqual([
      { productId: 'p', servingId: 's60', quantity: 3 },
      { productId: 'p', servingId: 's90', quantity: 1 },
      { productId: 'q', quantity: 1 },
    ]);
  });
});

describe('serving.engine', () => {
  it('draws from the open bottle first, then opens sealed bottles', () => {
    expect(deductMl({ quantity: 2, openMl: 100 }, 60, 750)).toEqual({ state: { quantity: 2, openMl: 40 }, bottlesOpened: 0 });
    expect(deductMl({ quantity: 2, openMl: 40 }, 60, 750)).toEqual({ state: { quantity: 1, openMl: 730 }, bottlesOpened: 1 });
  });

  it('fails when stock cannot cover the pour', () => {
    expect(deductMl({ quantity: 0, openMl: 50 }, 60, 750)).toBeNull();
    expect(deductMl({ quantity: 1, openMl: 0 }, 800, 750)).toBeNull();
  });

  it('restores ml and re-seals whole bottles', () => {
    expect(restoreMl({ quantity: 1, openMl: 700 }, 60, 750)).toEqual({ quantity: 2, openMl: 10 });
    expect(restoreMl({ quantity: 1, openMl: 100 }, 60, 750)).toEqual({ quantity: 1, openMl: 160 });
  });

  it('splits sale lines into units and ml', () => {
    const { units, ml } = splitUnitsAndMl([
      { productId: 'a', quantity: 3, servingMl: 60 },
      { productId: 'a', quantity: 1, servingMl: 90 },
      { productId: 'a', quantity: 2, servingMl: null },
    ]);
    expect(ml.get('a')).toBe(270);
    expect(units.get('a')).toBe(2);
  });

  it('validates labels and peg size', () => {
    expect(() => validateServings([{ label: 'A', volumeMl: 30, price: '1' }, { label: 'a', volumeMl: 60, price: '2' }])).toThrow(/Duplicate/);
    expect(() => validateServings([{ label: 'Big', volumeMl: 1000, price: '1' }], 750)).toThrow(/larger/);
    expect(() => validateServings([{ label: '60 ml', volumeMl: 60, price: '1' }, { label: 'Bottle', price: '9' }], 750)).not.toThrow();
  });
});

describe('print generator', () => {
  const bill: PrintBill = {
    branchName: 'Main Store', branchAddress: '1 High St', gstin: '36ABCDE1234F1Z5',
    billNumber: 'MAIN-2026-000001', date: '31/10/2026 20:15', cashierName: 'Asha',
    items: [
      { name: 'Single Malt (60 ml)', qty: 3, rate: 300, net: 900, taxRate: 18, taxAmount: 137.29 },
      { name: 'Paneer Tikka', qty: 2, rate: 240, net: 480, taxRate: 5, taxAmount: 22.86 },
    ],
    subtotal: 1380, discount: 0, taxAmount: 160.15, total: 1380, paymentMode: 'CASH',
  };

  it.each([32, 48])('prints GSTIN, CGST/SGST, rate summary and total at %i columns', (width) => {
    const text = renderText(buildBillRows({ ...bill, paperWidth: width === 48 ? '80mm' : '58mm' }), width);
    expect(text).toContain('GSTIN: 36ABCDE1234F1Z5');
    expect(text).toContain('TAX INVOICE');
    expect(text).toContain('CGST');
    expect(text).toContain('SGST');
    expect(text).toContain('1380.00');
    expect(text).toContain('Single Malt (60 ml)');
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(width);
  });

  it('switches to IGST when inter-state', () => {
    const text = renderText(buildBillRows({ ...bill, interState: true }), 32);
    expect(text).toContain('IGST');
    expect(text).not.toContain('SGST');
  });

  it('KOT shows table, items and serving but no prices', () => {
    const text = renderText(buildKotRows({
      branchName: 'Main Store', kotNumber: 'AB12CD34', tableName: 'T-4', destination: 'BAR', steward: 'Ravi',
      date: '31/10/2026 20:15', items: [{ name: 'Single Malt (60 ml)', qty: 2, notes: 'No ice' }],
    }), 32);
    expect(text).toContain('BAR ORDER');
    expect(text).toContain('Table: T-4');
    expect(text).toContain('2 x Single Malt (60 ml)');
    expect(text).toContain('No ice');
    expect(text).not.toMatch(/\d+\.\d{2}/);
  });

  it('ESC/POS output starts with init and ends with a cut', () => {
    const bytes = renderEscPos(buildBillRows(bill), 32);
    expect([bytes[0], bytes[1]]).toEqual([0x1b, 0x40]);
    expect(Array.from(bytes.slice(-3))).toEqual([0x1d, 0x56, 0x01]);
  });
});
