/**
 * Golden tests on the real Telangana ICDC challans in Testing_invoices/.
 * They pin the two properties the whole purchase flow depends on:
 *  1. every figure printed in the totals block is read correctly and the printed chain reconciles — which also proves
 *     no item line was dropped (Σ lines = printed Invoice Value);
 *  2. every line matches the catalog product with the SAME brand code AND ml — never another size.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { extractInvoice } from '../../src/modules/invoices/extraction/index.js';
import { buildDraftLines, type CatalogEntry } from '../../src/modules/invoices/draft.engine.js';
import { matchLine, type CatalogProduct } from '../../src/modules/invoices/match.engine.js';
import { reconcileTotalsBlock } from '../../src/modules/invoices/totals.engine.js';
import { TELANGANA_ICDC_PRODUCTS } from '../../src/db/data/telangana-products.js';

const DIR = join(process.cwd(), 'Testing_invoices');
const FILES = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.pdf')) : [];

const CATALOG: CatalogEntry[] = TELANGANA_ICDC_PRODUCTS.map((p, i) => ({
  id: `p${i}`, name: p.name, brand: p.brand, barcode: null, sku: p.sku, exciseCode: p.exciseCode,
  volumeMl: p.volumeMl, packQuantity: p.packQuantity, mrp: p.mrp, costPrice: p.costPrice, isActive: true, taxRate: '18.00',
}));

/** Expected figures read off the printed challans (Indian digit grouping normalised). */
const EXPECTED: Record<string, Record<string, string | number>> = {
  'ICDCB.pdf': {
    lines: 30, invoiceValue: '873568.58', mrpRoundingOff: '68318.30', net: '941886.88', turnoverTax: '87357.00',
    cess: '123660.00', tcs: '20585.00', challan: '1525000.00', previousCredit: '529410.01', subTotal: '2054410.01', balance: '880921.13',
  },
  'ICDCA1.pdf': {
    lines: 8, invoiceValue: '376728.08', mrpRoundingOff: '26106.30', net: '402834.38', turnoverTax: '37673.00',
    cess: '47940.00', tcs: '8811.00', challan: '0.00', previousCredit: '1514162.27', subTotal: '1514162.27', balance: '1016903.89',
  },
  'ICDCc.pdf': {
    lines: 16, invoiceValue: '1655602.50', mrpRoundingOff: '109197.00', net: '1764799.50', turnoverTax: '165561.00',
    cess: '176270.00', tcs: '38608.00', challan: '0.00', previousCredit: '2154275.47', subTotal: '2154275.47', balance: '9036.97',
  },
};

describe.skipIf(FILES.length === 0)('real ICDC challans (Testing_invoices/)', () => {
  for (const file of FILES) {
    describe(file, () => {
      const loaded = (async () => extractInvoice(readFileSync(join(DIR, file))))();

      it('totals block reads correctly and the printed chain reconciles (no dropped lines)', async () => {
        const r = await loaded;
        const m = r.meta;
        const linesSum = r.table.lines.reduce((s, l) => s.plus(l.amount ?? 0), new Decimal(0)).toFixed(2);
        const rec = reconcileTotalsBlock({
          linesSum, invoiceValue: m.linesBasicTotal ?? null, mrpRoundingOff: m.mrpRoundingOff ?? null, netInvoiceValue: m.netInvoiceValue ?? null,
          turnoverTax: m.turnoverTax ?? null, specialExciseCess: m.specialCess ?? null, tcsAmount: m.tcsAmount ?? null,
          previousCredit: m.previousCredit ?? null, challanAmount: m.challanAmount ?? null, subTotal: m.subTotal ?? null,
          retailerCreditBalance: m.retailerCreditBalance ?? null,
        });
        expect(rec.checks.map((c) => `${c.code}:${c.status}`)).toEqual([
          'LINES_TOTAL_MISMATCH:OK', 'NET_VALUE_MISMATCH:OK', 'SUBTOTAL_MISMATCH:OK', 'BALANCE_MISMATCH:OK',
        ]);
        expect(rec.warnings).toEqual([]);
        // the figures the business keeps are all present
        expect(m.netInvoiceValue).toBeTruthy();
        expect(m.mrpRoundingOff).toBeTruthy();
        expect(m.previousCredit).toBeTruthy();
        expect(m.subTotal).toBeTruthy();
        expect(m.challanAmount).toBeTruthy();
        expect(m.retailerCreditBalance).toBeTruthy();
      });

      it('every line carries code, ml and pack, and no header text leaks into names', async () => {
        const r = await loaded;
        for (const l of r.table.lines) {
          expect(l.sku, `line ${l.lineNumber}`).toMatch(/^\d{4}$/);
          expect(l.volumeMl, `line ${l.lineNumber}`).toBeGreaterThan(0);
          expect(l.packQuantity, `line ${l.lineNumber}`).toBeGreaterThan(0);
          expect(l.barcode, 'the excise brand code is not a barcode').toBeNull();
          expect(l.description).not.toMatch(/IMFL\/FL|Particulars|Cases\/Btls|Invoice Qty|#039/i);
        }
      });

      it('every line matches the catalog product with the same brand code AND ml', async () => {
        const r = await loaded;
        const drafts = buildDraftLines(r.table.lines, CATALOG);
        drafts.forEach((d, i) => {
          const line = r.table.lines[i];
          expect(d.matchStatus, `line ${line.lineNumber} ${line.sku}/${line.volumeMl}ml`).toBe('MATCHED');
          const p = CATALOG.find((c) => c.id === d.productId)!;
          expect(p.exciseCode).toBe(line.sku);
          expect(p.volumeMl).toBe(line.volumeMl);
          expect(d.flags).not.toContain('VOLUME_MISMATCH');
        });
      });
    });
  }

  for (const [file, exp] of Object.entries(EXPECTED)) {
    it(`${file}: printed figures are stored exactly`, async () => {
      if (!FILES.includes(file)) return;
      const r = await extractInvoice(readFileSync(join(DIR, file)));
      const m = r.meta;
      expect(r.table.lines).toHaveLength(exp.lines as number);
      expect({
        invoiceValue: m.linesBasicTotal, mrpRoundingOff: m.mrpRoundingOff, net: m.netInvoiceValue, turnoverTax: m.turnoverTax,
        cess: m.specialCess, tcs: m.tcsAmount, challan: m.challanAmount, previousCredit: m.previousCredit,
        subTotal: m.subTotal, balance: m.retailerCreditBalance,
      }).toEqual({
        invoiceValue: exp.invoiceValue, mrpRoundingOff: exp.mrpRoundingOff, net: exp.net, turnoverTax: exp.turnoverTax,
        cess: exp.cess, tcs: exp.tcs, challan: exp.challan, previousCredit: exp.previousCredit,
        subTotal: exp.subTotal, balance: exp.balance,
      });
      // total payable to the depot = net + turnover tax + cess + TCS
      expect(m.totalInvoiceAmount).toBe(
        new Decimal(exp.net as string).plus(exp.turnoverTax as string).plus(exp.cess as string).plus(exp.tcs as string).toFixed(2),
      );
    });
  }
});

describe('volume is a hard key in every matching path', () => {
  const mk = (id: string, name: string, volumeMl: number | null, extra: Partial<CatalogProduct> = {}): CatalogProduct => ({
    id, name, brand: 'Heineken', barcode: null, sku: `S-${id}`, exciseCode: '6561', volumeMl, packQuantity: 12, mrp: '200.00', isActive: true, ...extra,
  });

  it('a real size that differs by one digit (650 vs 750) is never auto-matched', () => {
    const cat = [mk('a', 'Heineken Lager Beer', 750)];
    const m = matchLine({ description: 'Heineken Lager Beer 650ml' }, cat);
    expect(m.status).not.toBe('MATCHED');
  });

  it('a name match whose volume is unknown is only a suggestion', () => {
    const cat = [mk('a', 'Heineken Lager Beer', null)];
    const m = matchLine({ description: 'Heineken Lager Beer' }, cat);
    expect(m.status).toBe('SUGGESTED');
    expect(m.flags).toContain('VOLUME_UNVERIFIED');
  });

  it('name path with a known different ml never matches that product', () => {
    const cat = [mk('a', 'Heineken Lager Beer 330ml', 330), mk('b', 'Heineken Lager Beer 500ml', 500)];
    const m = matchLine({ description: 'Heineken Lager Beer', volumeMl: 650 }, cat);
    expect(m.status).toBe('UNMATCHED');
  });

  it('new/edited lines use the brand code + ml, so a missing size is not matched to a neighbour', () => {
    const cat = [mk('a', 'Heineken Lager Beer 330ml', 330)];
    const m = matchLine({ description: 'HEINEKEN LAGER BEER', barcode: '6561', sku: '6561', volumeMl: 650 }, cat);
    expect(m.productId).toBeNull();
    expect(m.flags).toContain('VOLUME_DIFFERS');
    expect(m.candidates[0].volumeMl).toBe(330);
  });

  it('two catalog products with the same code and ml are ambiguous — nothing is picked', () => {
    const cat = [mk('a', 'Heineken Lager Beer 650ml', 650), mk('b', 'Heineken Lager Beer 650ml dup', 650)];
    const m = matchLine({ description: 'HEINEKEN LAGER BEER', sku: '6561', volumeMl: 650 }, cat);
    expect(m.productId).toBeNull();
    expect(m.flags).toContain('AMBIGUOUS_MATCH');
  });

  it('a barcode of another size does not match', () => {
    const cat = [mk('a', 'Heineken Lager Beer 330ml', 330, { barcode: '8901234' })];
    expect(matchLine({ description: 'x', barcode: '8901234', volumeMl: 650 }, cat).productId).toBeNull();
    expect(matchLine({ description: 'x', barcode: '8901234', volumeMl: 330 }, cat).method).toBe('BARCODE');
  });
});

describe('totals reconciliation', () => {
  const base = {
    linesSum: '1000.00', invoiceValue: '1000.00', mrpRoundingOff: '80.00', netInvoiceValue: '1080.00', turnoverTax: '10.00',
    specialExciseCess: '20.00', tcsAmount: '5.00', previousCredit: '500.00', challanAmount: '1000.00', subTotal: '1500.00',
    retailerCreditBalance: '385.00',
  };
  it('passes when every link of the chain holds', () => {
    expect(reconcileTotalsBlock(base).warnings).toEqual([]);
  });
  it('flags a dropped line', () => {
    expect(reconcileTotalsBlock({ ...base, linesSum: '900.00' }).warnings).toContain('LINES_TOTAL_MISMATCH');
  });
  it('flags a misread rounding off, e-challan or credit balance', () => {
    expect(reconcileTotalsBlock({ ...base, mrpRoundingOff: '8.00' }).warnings).toContain('NET_VALUE_MISMATCH');
    expect(reconcileTotalsBlock({ ...base, challanAmount: '100.00' }).warnings).toContain('SUBTOTAL_MISMATCH');
    expect(reconcileTotalsBlock({ ...base, retailerCreditBalance: '1.00' }).warnings).toContain('BALANCE_MISMATCH');
  });
  it('reports a chain it cannot verify instead of silently passing it', () => {
    expect(reconcileTotalsBlock({ ...base, invoiceValue: null }).warnings).toEqual(['TOTALS_UNVERIFIED']);
  });
});
