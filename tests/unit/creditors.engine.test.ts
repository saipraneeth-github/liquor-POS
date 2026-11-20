import { describe, it, expect } from 'vitest';
import { ageBucket, buildCreditors, supplierKey } from '../../src/modules/accounting/creditors.engine.js';

describe('age buckets', () => {
  it('cuts at 30 / 60 / 90 days', () => {
    expect([0, 30, 31, 60, 61, 90, 91].map(ageBucket)).toEqual(['current', 'current', 'd31_60', 'd31_60', 'd61_90', 'd61_90', 'd90plus']);
  });
});

describe('creditors', () => {
  const asOf = '2026-11-20';
  const inv = (id: string, supplier: string, date: string, payable: string, settledByChallan = '0') => ({ id, supplier, number: id, date, payable, settledByChallan });

  it('pays the oldest invoice first and ages what is left', () => {
    const c = buildCreditors(
      [inv('I1', 'Acme', '2026-08-12', '1000', '200'), inv('I2', 'Acme', '2026-10-11', '500'), inv('I3', 'Acme', '2026-11-15', '300')],
      [{ supplier: 'Acme', amount: '900', date: '2026-11-19' }],
      asOf,
    );
    const a = c.suppliers[0];
    expect(a).toMatchObject({ supplier: 'Acme', invoiced: '1800.00', paid: '1100.00', outstanding: '700.00', advance: '0.00' });
    // I1: 1000 - 200 challan = 800 -> cleared; the 100 left over goes to I2 (500 -> 400); I3 untouched
    expect(a.openInvoices.map((o) => [o.number, o.outstanding, o.bucket])).toEqual([['I2', '400.00', 'd31_60'], ['I3', '300.00', 'current']]);
    expect(a.buckets).toEqual({ current: '300.00', d31_60: '400.00', d61_90: '0.00', d90plus: '0.00' });
    expect(c.totals).toMatchObject({ outstanding: '700.00', advance: '0.00' });
  });

  it('money paid beyond what is owed is an advance', () => {
    const c = buildCreditors([inv('I1', 'Acme', '2026-11-01', '1000')], [{ supplier: 'acme', amount: '1500', date: '2026-11-10' }], asOf);
    expect(c.suppliers[0]).toMatchObject({ outstanding: '0.00', advance: '500.00', openInvoices: [] });
    expect(c.totals.advance).toBe('500.00');
  });

  it('a challan larger than its invoice leaves an advance too', () => {
    const c = buildCreditors([inv('I1', 'Acme', '2026-11-01', '1000', '1200')], [], asOf);
    expect(c.suppliers[0]).toMatchObject({ outstanding: '0.00', advance: '200.00' });
  });

  it('treats differently spelled names as one supplier and lists the biggest debt first', () => {
    expect(supplierKey('  ABC   Traders ')).toBe(supplierKey('abc traders'));
    const c = buildCreditors(
      [inv('A1', 'ABC Traders', '2026-11-01', '100'), inv('A2', 'abc  traders', '2026-11-02', '50'), inv('B1', 'Zed Depot', '2026-11-03', '900')],
      [], asOf,
    );
    expect(c.suppliers.map((s) => [s.supplier, s.outstanding])).toEqual([['Zed Depot', '900.00'], ['ABC Traders', '150.00']]);
  });

  it('ignores invoices and payments dated after the as-of day', () => {
    const c = buildCreditors([inv('I1', 'Acme', '2026-11-25', '1000')], [{ supplier: 'Acme', amount: '100', date: '2026-11-26' }], asOf);
    expect(c.totals.outstanding).toBe('0.00');
  });
});
