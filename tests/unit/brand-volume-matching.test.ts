import { describe, it, expect } from 'vitest';
import { matchLine, type CatalogProduct } from '../../src/modules/invoices/match.engine.js';
import { buildDraftLines } from '../../src/modules/invoices/draft.engine.js';
import type { ExtractedLine } from '../../src/modules/invoices/extraction/types.js';

describe('Brand Code & Volume (ML) Disambiguation', () => {
  const catalog: CatalogProduct[] = [
    {
      id: 'prod-magic-moments-180',
      name: 'Magic Moments Jamun Spicymint Vivid Vodka 180ml',
      brand: 'Magic Moments',
      barcode: '2129-180',
      sku: 'TS-2129-180',
      exciseCode: '2129',
      volumeMl: 180,
      packQuantity: 48,
      mrp: '190.00',
      isActive: true,
    },
    {
      id: 'prod-magic-moments-750',
      name: 'Magic Moments Jamun Spicymint Vivid Vodka 750ml',
      brand: 'Magic Moments',
      barcode: '2129-750',
      sku: 'TS-2129-750',
      exciseCode: '2129',
      volumeMl: 750,
      packQuantity: 12,
      mrp: '790.00',
      isActive: true,
    },
    {
      id: 'prod-mansion-house-180',
      name: 'TI Mansion House XO Brandy 180ml',
      brand: 'Mansion House',
      barcode: '0605-180',
      sku: 'TS-0605-180',
      exciseCode: '0605',
      volumeMl: 180,
      packQuantity: 48,
      mrp: '160.00',
      isActive: true,
    },
  ];

  it('matches 180ml line to 180ml product when same brand code exists for 180ml and 750ml', () => {
    const match = matchLine(
      {
        description: 'MAGIC MOMENTS JAMUN SPICYMINT VIVID FLAVOURED VODKA',
        sku: '2129',
        volumeMl: 180,
      },
      catalog,
    );
    expect(match.status).toBe('MATCHED');
    expect(match.productId).toBe('prod-magic-moments-180');
    expect(match.method).toBe('SKU');
  });

  it('matches 750ml line to 750ml product when same brand code exists for 180ml and 750ml', () => {
    const match = matchLine(
      {
        description: 'MAGIC MOMENTS JAMUN SPICYMINT VIVID FLAVOURED VODKA',
        sku: '2129',
        volumeMl: 750,
      },
      catalog,
    );
    expect(match.status).toBe('MATCHED');
    expect(match.productId).toBe('prod-magic-moments-750');
    expect(match.method).toBe('SKU');
  });

  it('HARD RULE: refuses to match product with different ML when only 180ml exists in catalog but line is 375ml', () => {
    const match = matchLine(
      {
        description: 'TI MANSION HOUSE XO BRAN DY',
        sku: '0605',
        volumeMl: 375,
      },
      catalog,
    );
    // Must NOT match prod-mansion-house-180!
    expect(match.status).toBe('UNMATCHED');
    expect(match.productId).toBeNull();
    expect(match.flags).toContain('VOLUME_DIFFERS');
  });

  it('buildDraftLines sets volumeMl on each DraftLine accurately', () => {
    const extractedLines: ExtractedLine[] = [
      {
        lineNumber: 1,
        description: 'MAGIC MOMENTS JAMUN SPICYMINT VIVID FLAVOURED VODKA',
        barcode: null,
        sku: '2129',
        quantity: 0,
        cases: 1,
        rate: '625.08',
        mrp: '790.00',
        amount: '7501.00',
        taxRate: null,
        packQuantity: 12,
        volumeMl: 750,
        caseRate: null,
        confidence: 100,
        flags: [],
      },
      {
        lineNumber: 2,
        description: 'MAGIC MOMENTS JAMUN SPICYMINT VIVID FLAVOURED VODKA',
        barcode: null,
        sku: '2129',
        quantity: 0,
        cases: 1,
        rate: '150.08',
        mrp: '190.00',
        amount: '7204.00',
        taxRate: null,
        packQuantity: 48,
        volumeMl: 180,
        caseRate: null,
        confidence: 100,
        flags: [],
      },
    ];

    const catalogEntries = catalog.map(p => ({ ...p, taxRate: '18.00' }));
    const draft = buildDraftLines(extractedLines, catalogEntries);

    expect(draft).toHaveLength(2);
    expect(draft[0].productId).toBe('prod-magic-moments-750');
    expect(draft[0].volumeMl).toBe(750);
    expect(draft[0].quantity).toBe(12);

    expect(draft[1].productId).toBe('prod-magic-moments-180');
    expect(draft[1].volumeMl).toBe(180);
    expect(draft[1].quantity).toBe(48);
  });
});
