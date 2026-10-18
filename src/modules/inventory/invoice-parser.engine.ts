import { Decimal } from 'decimal.js';

export interface CatalogProductReference {
  id: string;
  barcode?: string | null;
  name: string;
  volumeMl?: number | null;
  currentMrp: string;
}

export interface RawInvoiceItem {
  rawDescription: string;
  barcode?: string;
  quantity: number;
  costPrice: string;
  mrp: string;
  taxRate?: string;
}

export interface RawExtractedInvoice {
  supplierName: string;
  invoiceNumber: string;
  invoiceDate: string;
  claimedTotal: string;
  items: RawInvoiceItem[];
}

export interface ParsedInvoiceItem {
  rawDescription: string;
  productId: string | null;
  isMatched: boolean;
  quantity: number;
  costPrice: string;
  mrp: string;
  taxRate: string;
  lineCostTotal: string;
}

export interface InvoiceValidationResult {
  isValid: boolean;
  supplierName: string;
  invoiceNumber: string;
  invoiceDate: string;
  claimedTotal: string;
  computedTotal: string;
  isTotalVerified: boolean;
  hasUnmatchedItems: boolean;
  items: ParsedInvoiceItem[];
  discrepancyNote?: string;
}

/**
 * Normalizes, matches, and verifies raw OCR/AI-extracted supplier invoices.
 */
export function parseAndValidateInvoice(
  rawInvoice: RawExtractedInvoice,
  catalog: CatalogProductReference[],
): InvoiceValidationResult {
  const barcodeMap = new Map<string, CatalogProductReference>();
  const nameMap = new Map<string, CatalogProductReference>();

  for (const prod of catalog) {
    if (prod.barcode) barcodeMap.set(prod.barcode, prod);
    nameMap.set(prod.name.toLowerCase().trim(), prod);
  }

  let computedTotal = new Decimal(0);
  let hasUnmatchedItems = false;

  const parsedItems: ParsedInvoiceItem[] = rawInvoice.items.map((item) => {
    let matchedProduct: CatalogProductReference | undefined;

    if (item.barcode && barcodeMap.has(item.barcode)) {
      matchedProduct = barcodeMap.get(item.barcode);
    } else {
      // Fallback matching by description substring
      const descLower = item.rawDescription.toLowerCase();
      for (const [name, prod] of nameMap.entries()) {
        if (descLower.includes(name)) {
          matchedProduct = prod;
          break;
        }
      }
    }

    const qty = new Decimal(item.quantity);
    const cost = new Decimal(item.costPrice);
    const lineCost = qty.mul(cost).toDecimalPlaces(2);
    computedTotal = computedTotal.plus(lineCost);

    const isMatched = !!matchedProduct;
    if (!isMatched) {
      hasUnmatchedItems = true;
    }

    return {
      rawDescription: item.rawDescription,
      productId: matchedProduct ? matchedProduct.id : null,
      isMatched,
      quantity: item.quantity,
      costPrice: cost.toFixed(2),
      mrp: new Decimal(item.mrp).toFixed(2),
      taxRate: new Decimal(item.taxRate ?? '18.00').toFixed(2),
      lineCostTotal: lineCost.toFixed(2),
    };
  });

  const claimed = new Decimal(rawInvoice.claimedTotal);
  const isTotalVerified = claimed.equals(computedTotal);
  let discrepancyNote: string | undefined;

  if (!isTotalVerified) {
    discrepancyNote = `Claimed total ${claimed.toFixed(2)} does not match computed ${computedTotal.toFixed(2)}`;
  }

  return {
    isValid: true,
    supplierName: rawInvoice.supplierName,
    invoiceNumber: rawInvoice.invoiceNumber,
    invoiceDate: rawInvoice.invoiceDate,
    claimedTotal: claimed.toFixed(2),
    computedTotal: computedTotal.toFixed(2),
    isTotalVerified,
    hasUnmatchedItems,
    items: parsedItems,
    discrepancyNote,
  };
}
