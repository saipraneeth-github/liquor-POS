import { describe, it, expect } from 'vitest';
import { parseMoney, parseQuantity, looksLikeGarbledNumber } from '../../src/modules/invoices/extraction/numbers.js';
import { detectFileType, imageDimensions, XLSX_MIME } from '../../src/modules/invoices/extraction/detect-type.js';
import { parseDateText, findInvoiceNumber, findSupplierName, extractHeaderFields } from '../../src/modules/invoices/extraction/header-fields.engine.js';
import { classifyHeader, findHeaderRow, applyMapping, classifySummaryRow, rowsToLines } from '../../src/modules/invoices/extraction/table.engine.js';
import { classifyHeaderWordFuzzy, parseHeaderLine, splitNumericTail, textLinesToRows } from '../../src/modules/invoices/extraction/text-lines.engine.js';
import { itemsToLines } from '../../src/modules/invoices/extraction/pdf-text.js';
import { extractVolumeMl, compareVolumes, matchLine, type CatalogProduct } from '../../src/modules/invoices/match.engine.js';
import { validateLine, validateInvoice, isPlaceholderNumber, countFlags } from '../../src/modules/invoices/validate.engine.js';
import { convertCases, buildDraftLines, type CatalogEntry } from '../../src/modules/invoices/draft.engine.js';

const CATALOG: CatalogEntry[] = [
  { id: 'p-rc-750', name: 'Royal Challenge Premium Whisky 750ml', brand: 'Royal Challenge', barcode: '890123456001', sku: 'RC-750', volumeMl: 750, packQuantity: 12, mrp: '850.00', isActive: true, taxRate: '18.00' },
  { id: 'p-rc-375', name: 'Royal Challenge Premium Whisky 375ml', brand: 'Royal Challenge', barcode: '890123456099', sku: 'RC-375', volumeMl: 375, packQuantity: 24, mrp: '430.00', isActive: true, taxRate: '18.00' },
  { id: 'p-bp-750', name: 'Blenders Pride Rare Premium 750ml', brand: 'Blenders Pride', barcode: '890123456002', sku: 'BP-750', volumeMl: 750, packQuantity: 12, mrp: '1050.00', isActive: true, taxRate: '18.00' },
  { id: 'p-kf-650', name: 'Kingfisher Premium Lager Beer 650ml', brand: 'Kingfisher', barcode: '890123456003', sku: 'KF-650', volumeMl: 650, packQuantity: 12, mrp: '180.00', isActive: true, taxRate: '18.00' },
  { id: 'p-om-750', name: 'Old Monk XXX Rum 750ml', brand: 'Old Monk', barcode: '890123456005', sku: 'OM-750', volumeMl: 750, packQuantity: null, mrp: '450.00', isActive: true, taxRate: '18.00' },
  { id: 'p-inactive', name: 'Discontinued Gin 750ml', brand: 'Old Gin', barcode: '890999999999', sku: 'OG-750', volumeMl: 750, packQuantity: 12, mrp: '500.00', isActive: false, taxRate: '18.00' },
];

describe('invoice extraction: numbers', () => {
  it('parses Indian and western money strings and rejects garbage or overflow', () => {
    expect(parseMoney('1,23,456.5')).toBe('123456.50');
    expect(parseMoney('₹ 850')).toBe('850.00');
    expect(parseMoney('Rs. 1,200/-')).toBe('1200.00');
    expect(parseMoney('INR 99.555')).toBe('99.56');
    expect(parseMoney(620)).toBe('620.00');
    expect(parseMoney('10000000000')).toBeNull();
    expect(parseMoney('2a080.00')).toBeNull();
    expect(parseMoney('-10')).toBeNull();
  });

  it('parses integer quantities with units and detects garbled numbers', () => {
    expect(parseQuantity('24 btls')).toBe(24);
    expect(parseQuantity('24.00')).toBe(24);
    expect(parseQuantity('1,200 nos.')).toBe(1200);
    expect(parseQuantity('12.5')).toBeNull();
    expect(parseQuantity('100001')).toBeNull();

    expect(looksLikeGarbledNumber('2a080.00')).toBe(true);
    expect(looksLikeGarbledNumber('750ml')).toBe(false);
    expect(looksLikeGarbledNumber('25-10-2026')).toBe(false);
    expect(looksLikeGarbledNumber('INV-2026-0457')).toBe(false);
  });
});

describe('invoice extraction: detect-type', () => {
  it('sniffs PDF, PNG, JPEG, XLSX, CSV and rejects unsupported formats', () => {
    expect(detectFileType(Buffer.from('%PDF-1.7\n...'))).toEqual({ kind: 'PDF', mimeType: 'application/pdf', subtype: 'pdf' });

    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    png.writeUInt32BE(800, 16);
    png.writeUInt32BE(600, 20);
    expect(detectFileType(png).kind).toBe('IMAGE');
    expect(imageDimensions(png)).toEqual({ width: 800, height: 600 });

    const xlsxZip = Buffer.from('PK\x03\x04...xl/workbook.xml...', 'latin1');
    expect(detectFileType(xlsxZip)).toEqual({ kind: 'EXCEL', mimeType: XLSX_MIME, subtype: 'xlsx' });

    expect(detectFileType(Buffer.from('Item,Qty,Rate,Amount\nRoyal Challenge,12,620,7440\n')).kind).toBe('CSV');

    expect(() => detectFileType(Buffer.alloc(0))).toThrow(/empty/i);
    expect(() => detectFileType(Buffer.from('PK\x03\x04...word/document.xml', 'latin1'))).toThrow(/not an Excel/i);
    expect(() => detectFileType(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]))).toThrow(/\.xls/i);
  });
});

describe('invoice extraction: header fields', () => {
  it('extracts supplier name, invoice number, date and GSTIN above the table header', () => {
    expect(parseDateText('Dated: 25/10/2026')).toBe('2026-10-25');
    expect(parseDateText('14 Oct 2026')).toBe('2026-10-14');
    expect(parseDateText('2026-02-30')).toBeNull();

    const lines = [
      'TAX INVOICE',
      'M/s. Telangana Beverages Corp Ltd',
      'GSTIN: 36AABCT1234F1Z5',
      'Invoice No: TSBCL/2026/0981   Date: 24-10-2026',
      'Item Description   Qty   Rate   MRP   Amount',
      'Royal Challenge 750ml   12   620.00   850.00   7440.00',
    ];
    const h = extractHeaderFields(lines, 4);
    expect(h).toEqual({
      invoiceNumber: 'TSBCL/2026/0981',
      invoiceDate: '2026-10-24',
      supplierName: 'Telangana Beverages Corp Ltd',
      gstin: '36AABCT1234F1Z5',
    });
    expect(findInvoiceNumber(['Invoice No: 24/10/2026'])).toBeNull();
    expect(findSupplierName(['TAX INVOICE', 'United Spirits Distribution', 'Item Qty Rate'], 2)).toBe('United Spirits Distribution');
  });
});

describe('invoice extraction: table & text-lines engines', () => {
  it('classifies headers, parses rows, skips tax/subtotal rows and captures grand total', () => {
    expect(classifyHeader('Item Description')).toBe('description');
    expect(classifyHeader('Bottles')).toBe('quantity');
    expect(classifyHeader('Cases')).toBe('cases');
    expect(classifyHeader('Landing Cost')).toBe('rate');
    expect(classifyHeader('GST %')).toBe('taxRate');
    expect(classifyHeader('CGST Amount')).toBeNull();
    expect(classifySummaryRow(['Sub Total'])).toBe(1);
    expect(classifySummaryRow(['Grand Total'])).toBe(3);
    expect(classifySummaryRow(['CGST 9%'])).toBe(0);

    const rows = [
      ['Supplier: United Spirits', '', '', '', ''],
      ['Sl No', 'Particulars', 'Qty', 'Rate', 'MRP', 'Line Total'],
      ['1', 'Royal Challenge 750ml', '12', '620.00', '850.00', '7,440.00'],
      ['2', 'Blenders Pride 750ml', '6', '780.00', '1050.00', '4,680.00'],
      ['', 'Sub Total', '', '', '', '12,120.00'],
      ['', 'Rounding Off', '', '', '', '0.00'],
      ['', 'Grand Total', '', '', '', '12,120.00'],
    ];
    const res = rowsToLines(rows);
    expect(res.headerRowIndex).toBe(1);
    expect(res.lines).toHaveLength(2);
    expect(res.lines[0]).toMatchObject({ lineNumber: 1, description: 'Royal Challenge 750ml', quantity: 12, rate: '620.00', mrp: '850.00', amount: '7440.00' });
    expect(res.capturedTotal).toBe('12120.00');
  });

  it('supports explicit columnMapping overrides and flags unreadable numbers', () => {
    const rows = [
      ['ColA', 'ColB', 'ColC', 'ColD'],
      ['Old Monk 750ml', '10', '330.00', '33a0.00'],
      ['Total', '', '', '33b0.00'],
    ];
    const mapped = applyMapping(rows, findHeaderRow(rows), { description: 0, quantity: 1, rate: 2, amount: 3 });
    expect(mapped.columns).toEqual({ description: 0, quantity: 1, rate: 2, amount: 3 });
    const res = rowsToLines(rows, { description: 0, quantity: 1, rate: 2, amount: 3 });
    expect(res.lines).toHaveLength(1);
    expect(res.lines[0].flags).toContain('UNREADABLE_NUMBER');
    expect(res.totalUnreadable).toBe(true);
  });

  it('rebuilds rows from OCR/PDF text lines and groups positioned PDF text items', () => {
    expect(classifyHeaderWordFuzzy('Oty')).toBe('quantity');
    expect(parseHeaderLine('Sl.No  Item Description  Unit Price  Oty  MRP  Line Total')).toEqual([
      'description', 'rate', 'quantity', 'mrp', 'amount',
    ]);
    const split = splitNumericTail('890123456001 Royal Challenge 750ml 12 620.00 850.00 7440.00', 4);
    expect(split).toEqual({
      barcode: '890123456001',
      description: 'Royal Challenge 750ml',
      tail: ['12', '620.00', '850.00', '7440.00'],
    });

    const textRows = textLinesToRows([
      'Particulars   Qty   Rate   MRP   Amount',
      'Kingfisher Premium 650ml   24   130.00   180.00   3120.00',
      'Grand Total   3120.00',
    ]);
    expect(textRows.headerFound).toBe(true);
    const table = rowsToLines(textRows.rows);
    expect(table.lines).toHaveLength(1);
    expect(table.capturedTotal).toBe('3120.00');

    const pdfLines = itemsToLines([
      { str: 'Item', x: 10, y: 100, width: 20, size: 10 },
      { str: 'Qty', x: 150, y: 101, width: 15, size: 10 },
      { str: 'Old Monk', x: 10, y: 80, width: 40, size: 10 },
      { str: '12', x: 150, y: 80, width: 10, size: 10 },
    ]);
    expect(pdfLines).toEqual(['Item  Qty', 'Old Monk  12']);
  });
});

describe('invoice catalog matching (match.engine)', () => {
  it('matches by exact barcode and SKU first, ignoring inactive products', () => {
    expect(matchLine({ description: 'Anything', barcode: '890123456002' }, CATALOG)).toMatchObject({
      productId: 'p-bp-750', status: 'MATCHED', method: 'BARCODE', confidence: 1,
    });
    expect(matchLine({ description: 'Anything', sku: 'kf-650' }, CATALOG)).toMatchObject({
      productId: 'p-kf-650', status: 'MATCHED', method: 'SKU', confidence: 1,
    });
    expect(matchLine({ description: 'Discontinued Gin 750ml', barcode: '890999999999' }, CATALOG).productId).toBeNull();
  });

  it('fuzzy matches names, handles OCR digit swaps and volume differences, and marks ambiguous matches SUGGESTED', () => {
    expect(extractVolumeMl('750 ml')).toBe(750);
    expect(extractVolumeMl('1.5 ltr')).toBe(1500);
    expect(compareVolumes(750, 720)).toBe('ocr');
    expect(compareVolumes(750, 375)).toBe('diff');

    // Strong OCR-tolerant match ("01d Monk XXX Rum 720ml" -> Old Monk 750ml with VOLUME_DIFFERS)
    const ocrMatch = matchLine({ description: '01d Monk XXX Rum 720ml' }, CATALOG);
    expect(ocrMatch.productId).toBe('p-om-750');
    expect(ocrMatch.flags).toContain('VOLUME_DIFFERS');

    // Ambiguous when volume is missing and both 750ml and 375ml Royal Challenge score identically
    const ambig = matchLine({ description: 'Royal Challenge Premium Whisky' }, CATALOG);
    expect(ambig.status).toBe('SUGGESTED');
    expect(ambig.candidates.length).toBeGreaterThanOrEqual(2);

    // Unmatched unknown item
    expect(matchLine({ description: 'Imported Tequila Blanco 750ml' }, CATALOG).status).toBe('UNMATCHED');
  });
});

describe('invoice validation & draft building (validate.engine + draft.engine)', () => {
  it('converts cases to bottles using packQuantity and divides per-case rate when appropriate', () => {
    // 2 cases * 12 = 24 bottles; rate 7440/case -> 620/bottle because 2 * 7440 == 14880
    expect(convertCases({ cases: 2, quantity: 0, rate: '7440.00', mrp: '850.00', amount: '14880.00' }, 12)).toEqual({
      quantity: 24, rate: '620.00', flags: ['CASES_CONVERTED'],
    });
    // Missing packQuantity -> CASES_NO_PACK_SIZE
    expect(convertCases({ cases: 2, quantity: null, rate: '3960.00', mrp: '450.00', amount: '7920.00' }, null)).toEqual({
      quantity: null, rate: '3960.00', flags: ['CASES_NO_PACK_SIZE'],
    });
  });

  it('raises line and invoice validation flags accurately', () => {
    const vLine = validateLine({
      quantity: 12,
      costPrice: '620.00',
      mrp: '860.00',
      extractedAmount: '7000.00', // 12 * 620 = 7440 != 7000
      catalogMrp: '850.00',       // 860 != 850
      confidence: 65,             // < 80
      productId: 'p-rc-750',
      matchStatus: 'SUGGESTED',
    });
    expect(vLine.lineCostTotal).toBe('7440.00');
    expect(vLine.flags).toEqual(expect.arrayContaining([
      'AMOUNT_MISMATCH', 'MRP_CHANGED', 'LOW_CONFIDENCE', 'NEEDS_CONFIRMATION',
    ]));

    const vInv = validateInvoice({
      invoiceNumber: 'DRAFT-1234ABCD',
      invoiceDate: '2099-01-01',
      supplierName: '',
      capturedTotal: '8000.00',
      lineTotals: ['7440.00'],
      duplicateFile: true,
      headerFromOcr: true,
      now: new Date('2026-10-25T00:00:00Z'),
    });
    expect(isPlaceholderNumber('DRAFT-1234ABCD')).toBe(true);
    expect(vInv.computedTotal).toBe('7440.00');
    expect(vInv.warnings).toEqual(expect.arrayContaining([
      'TOTAL_MISMATCH', 'INVOICE_NUMBER_MISSING', 'SUPPLIER_MISSING', 'INVOICE_DATE_IN_FUTURE', 'DUPLICATE_FILE', 'HEADER_FROM_OCR',
    ]));
    expect(countFlags([vLine.flags, ['UNMATCHED']])).toBe(vLine.flags.length + 1);
  });

  it('builds draft lines end-to-end from extracted lines and catalog', () => {
    const draft = buildDraftLines([
      {
        lineNumber: 1,
        description: 'Blenders Pride Rare Premium 750ml',
        barcode: '890123456002',
        sku: null,
        quantity: 12,
        cases: null,
        rate: '780.00',
        mrp: '1050.00',
        amount: '9360.00',
        taxRate: null,
        confidence: 95,
        flags: [],
      },
    ], CATALOG);
    expect(draft).toHaveLength(1);
    expect(draft[0]).toMatchObject({
      productId: 'p-bp-750',
      matchStatus: 'MATCHED',
      quantity: 12,
      costPrice: '780.00',
      mrp: '1050.00',
      taxRate: '18.00',
      lineCostTotal: '9360.00',
      flags: [],
    });
  });
});
