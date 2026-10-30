import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { detectFileType } from '../../src/modules/invoices/extraction/detect-type.js';
import { isIcdcDocument, extractIcdcHeader, extractIcdcTotals } from '../../src/modules/invoices/extraction/icdc.engine.js';
import { extractInvoice } from '../../src/modules/invoices/extraction/index.js';
import { matchLine, type CatalogProduct } from '../../src/modules/invoices/match.engine.js';
import { convertCases } from '../../src/modules/invoices/draft.engine.js';

describe('Telangana Excise ICDC Engine', () => {
  it('detects ICDC documents from text lines and rejects generic commercial invoices', () => {
    const icdcLines = [
      'GOVERNMENT OF TELANGANA',
      'PROHIBITION & EXCISE DEPARTMENT',
      'IML DEPOT : IMFL Depot Ranga Reddy-II',
      'INVOICE CUM DELIVERY CHALLAN',
      'ICDC Number: ICDC037200326032761',
    ];
    expect(isIcdcDocument(icdcLines)).toBe(true);

    const genericLines = [
      'TAX INVOICE',
      'M/s. Telangana Beverages Corp Ltd',
      'GSTIN: 36AABCT1234F1Z5',
      'Invoice No: TSBCL/2026/0981   Date: 24-10-2026',
    ];
    expect(isIcdcDocument(genericLines)).toBe(false);
  });

  it('detects PDF format even with leading whitespace bytes (ICDCB.pdf)', () => {
    const bufWithWhitespace = Buffer.from('\n\n\n\n\r\n%PDF-1.4\n%test');
    const detected = detectFileType(bufWithWhitespace);
    expect(detected.kind).toBe('PDF');
    expect(detected.mimeType).toBe('application/pdf');
    expect(detected.offset).toBe(6);
  });

  it('matches catalog products by exciseCode with method SKU and confidence 1', () => {
    const catalog: CatalogProduct[] = [
      {
        id: 'prod-kf-5016',
        name: 'Kingfisher Premium Lager Beer 650ml',
        brand: 'Kingfisher',
        barcode: null,
        sku: 'KF-650',
        exciseCode: '5016',
        volumeMl: 650,
        packQuantity: 12,
        mrp: '180.00',
        isActive: true,
      },
    ];

    const match = matchLine({ description: 'KING FISHER PREMIUM LAGER BEER', sku: '5016' }, catalog);
    expect(match).toMatchObject({
      productId: 'prod-kf-5016',
      status: 'MATCHED',
      method: 'SKU',
      confidence: 1,
    });
  });

  it('supports dual quantity conversion (cases + bottles) using pack size', () => {
    // 29 cases * 12 + 10 bottles = 358 bottles
    const converted = convertCases(
      { cases: 29, quantity: 10, rate: '183.42', mrp: '220.00', amount: '65663.17' },
      12,
    );
    expect(converted).toEqual({
      quantity: 358,
      rate: '183.42',
      flags: ['CASES_CONVERTED'],
    });
  });

  describe('Testing All 10 Telangana ICDC PDFs in testing_invoices/', () => {
    const pdfDir = fs.existsSync('testing_invoices')
      ? 'testing_invoices'
      : fs.existsSync('Testing_invoices')
      ? 'Testing_invoices'
      : 'testing_invoices';
    const testCases: Array<{
      file: string;
      expectedLines: number;
      expectedTotal: string;
      expectedDepot: RegExp;
      sampleCheck?: (lines: any[]) => void;
    }> = [
      {
        file: 'ICDC.pdf',
        expectedLines: 22,
        expectedTotal: '680595.20',
        expectedDepot: /IMFL Depot Ranga Reddy-II/i,
      },
      {
        file: 'ICDCA.pdf',
        expectedLines: 22,
        expectedTotal: '680595.20',
        expectedDepot: /IMFL Depot Ranga Reddy-II/i,
      },
      {
        file: 'ICDCA1.pdf',
        expectedLines: 8,
        expectedTotal: '402834.38',
        expectedDepot: /IMFL Depot Medchal-II/i,
        sampleCheck: (lines) => {
          // Row 3 in ICDCA1.pdf is Budweiser King of Beers with 29 cases and 10 loose bottles
          const row3 = lines.find((l) => l.lineNumber === 3);
          expect(row3).toBeDefined();
          expect(row3.sku).toBe('5019');
          expect(row3.cases).toBe(29);
          expect(row3.quantity).toBe(10);
          expect(row3.description).toContain('BUDWEISER');
          expect(row3.amount).toBe('65663.17');
        },
      },
      {
        file: 'ICDCA2.pdf',
        expectedLines: 23,
        expectedTotal: '1141849.72',
        expectedDepot: /IMFL Depot Medchal-II/i,
      },
      {
        file: 'ICDCA3.pdf',
        expectedLines: 48,
        expectedTotal: '1240711.00',
        expectedDepot: /IMFL Depot Medchal-II/i,
      },
      {
        file: 'ICDCA4.pdf',
        expectedLines: 25,
        expectedTotal: '1015110.20',
        expectedDepot: /IMFL Depot Medchal-II/i,
      },
      {
        file: 'ICDCA5.pdf',
        expectedLines: 59,
        expectedTotal: '2863868.27',
        expectedDepot: /IMFL Depot Medchal-II/i,
      },
      {
        file: 'ICDCB.pdf',
        expectedLines: 30,
        expectedTotal: '941886.88',
        expectedDepot: /IMFL Depot Medchal-II/i,
      },
      {
        file: 'ICDCc.pdf',
        expectedLines: 16,
        expectedTotal: '1764799.50',
        expectedDepot: /IMFL Depot Medchal-II/i,
      },
      {
        file: 'ICDCd.pdf',
        expectedLines: 51,
        expectedTotal: '1767840.27',
        expectedDepot: /IMFL Depot Medchal-II/i,
      },
    ];

    for (const tc of testCases) {
      it(`extracts ${tc.file} cleanly with 100% accuracy`, async () => {
        const filePath = path.join(pdfDir, tc.file);
        if (!fs.existsSync(filePath)) {
          console.warn(`Skipping ${tc.file} (file not found)`);
          return;
        }

        const buf = fs.readFileSync(filePath);
        const result = await extractInvoice(buf);

        expect(result.meta.engine).toBe('icdc-extractor');
        expect(result.header.invoiceNumber).toMatch(/^ICDC\d+$/);
        expect(result.header.supplierName).toMatch(tc.expectedDepot);
        expect(result.header.invoiceDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(result.header.gstin).toBe('36490111631');
        expect(result.table.capturedTotal).toBe(tc.expectedTotal);
        expect(result.table.lines).toHaveLength(tc.expectedLines);

        // Every line must have description, 4-digit sku, cases, and amount
        for (const line of result.table.lines) {
          expect(line.description.length).toBeGreaterThan(0);
          expect(line.sku).toMatch(/^\d{4}$/);
          expect(line.cases).toBeGreaterThanOrEqual(0);
          expect(line.amount).toMatch(/^\d+\.\d{2}$/);
        }

        if (tc.sampleCheck) {
          tc.sampleCheck(result.table.lines);
        }
      });
    }
  });
});

