import { describe, it, expect } from 'vitest';
import {
  parseAndValidateInvoice,
  type RawExtractedInvoice,
  type CatalogProductReference,
} from '../../src/modules/inventory/invoice-parser.engine.js';

describe('parseAndValidateInvoice', () => {
  const catalog: CatalogProductReference[] = [
    { id: 'prod-rs-750', barcode: '8901234567890', name: 'Royal Stag', volumeMl: 750, currentMrp: '200.00' },
    { id: 'prod-kf-650', barcode: '8901234567891', name: 'Kingfisher Strong', volumeMl: 650, currentMrp: '70.00' },
  ];

  const rawInvoice: RawExtractedInvoice = {
    supplierName: 'United Spirits Distributors Ltd',
    invoiceNumber: 'INV-2026-9921',
    invoiceDate: '2026-10-15',
    claimedTotal: '5500.00',
    items: [
      {
        rawDescription: 'Royal Stag 750ml Deluxe',
        barcode: '8901234567890',
        quantity: 20,
        costPrice: '150.00',
        mrp: '200.00',
        taxRate: '18.00',
      },
      {
        rawDescription: 'Kingfisher Strong 650ml',
        barcode: '8901234567891',
        quantity: 50,
        costPrice: '50.00',
        mrp: '70.00',
        taxRate: '12.00',
      },
    ],
  };

  it('matches catalog products and computes line totals accurately', () => {
    const result = parseAndValidateInvoice(rawInvoice, catalog);

    expect(result.isValid).toBe(true);
    expect(result.supplierName).toBe('United Spirits Distributors Ltd');
    expect(result.invoiceNumber).toBe('INV-2026-9921');
    expect(result.items).toHaveLength(2);

    // Item 1: 20 * 150 = 3000
    expect(result.items[0].productId).toBe('prod-rs-750');
    expect(result.items[0].isMatched).toBe(true);
    expect(result.items[0].lineCostTotal).toBe('3000.00');

    // Item 2: 50 * 50 = 2500
    expect(result.items[1].productId).toBe('prod-kf-650');
    expect(result.items[1].isMatched).toBe(true);
    expect(result.items[1].lineCostTotal).toBe('2500.00');

    // Total = 3000 + 2500 = 5500.00
    expect(result.computedTotal).toBe('5500.00');
    expect(result.isTotalVerified).toBe(true);
  });

  it('flags unmatched products that need creation in catalog', () => {
    const invoiceWithNewItem: RawExtractedInvoice = {
      ...rawInvoice,
      claimedTotal: '2000.00',
      items: [
        {
          rawDescription: 'Craft IPA Beer 330ml',
          barcode: '9999999999999', // not in catalog
          quantity: 24,
          costPrice: '80.00',
          mrp: '120.00',
          taxRate: '18.00',
        },
      ],
    };

    const result = parseAndValidateInvoice(invoiceWithNewItem, catalog);
    expect(result.items[0].isMatched).toBe(false);
    expect(result.items[0].productId).toBeNull();
    expect(result.hasUnmatchedItems).toBe(true);
  });

  it('detects discrepancy between claimed supplier total and calculated sum', () => {
    const mismatchedInvoice: RawExtractedInvoice = {
      ...rawInvoice,
      claimedTotal: '9999.00', // incorrect total
    };

    const result = parseAndValidateInvoice(mismatchedInvoice, catalog);
    expect(result.isTotalVerified).toBe(false);
    expect(result.discrepancyNote).toContain('Claimed total 9999.00 does not match computed 5500.00');
  });
});
