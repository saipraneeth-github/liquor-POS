/**
 * draft.engine.ts — PURE: extracted lines + catalog → draft invoice lines (matched, cases converted, validated).
 */
import { Decimal } from 'decimal.js';
import { matchLine, type CatalogProduct, type MatchResult } from './match.engine.js';
import { validateLine, AMOUNT_TOLERANCE } from './validate.engine.js';
import type { ExtractedLine } from './extraction/types.js';
import { MAX_MONEY } from './extraction/numbers.js';

export interface CatalogEntry extends CatalogProduct {
  /** Category GST rate, used when the line has none. */
  taxRate: string | null;
}

export interface DraftLine {
  lineNumber: number;
  rawDescription: string;
  barcode: string | null;
  productId: string | null;
  productName: string | null;
  matchStatus: 'MATCHED' | 'SUGGESTED' | 'UNMATCHED' | 'MANUAL';
  matchMethod: 'BARCODE' | 'SKU' | 'NAME' | 'MANUAL' | null;
  matchConfidence: string | null;
  quantity: number;
  costPrice: string;
  mrp: string;
  taxRate: string;
  extractedAmount: string | null;
  lineCostTotal: string;
  flags: string[];
  candidates: MatchResult['candidates'];
}

export const DEFAULT_TAX_RATE = '18.00';

function within(a: Decimal, b: string | Decimal): boolean {
  return a.minus(b).abs().lte(AMOUNT_TOLERANCE);
}

/**
 * Cases → bottles using the matched product's pack size (or the pack size extracted directly from the invoice).
 * The rate is treated as per-case (and divided by the pack size) when cases × rate matches the line amount,
 * or — without an amount — when the rate exceeds the MRP.
 */
export function convertCases(
  line: Pick<ExtractedLine, 'cases' | 'quantity' | 'rate' | 'mrp' | 'amount'>,
  packQuantity: number | null,
): { quantity: number | null; rate: string | null; flags: string[] } {
  if (line.cases === null) return { quantity: line.quantity, rate: line.rate, flags: [] };
  if (!packQuantity || packQuantity <= 0) return { quantity: null, rate: line.rate, flags: ['CASES_NO_PACK_SIZE'] };
  const bottles = line.cases * packQuantity + (line.quantity ?? 0);
  let rate = line.rate;
  if (rate !== null && packQuantity > 1) {
    const r = new Decimal(rate);
    const perCase = line.amount !== null
      ? within(r.mul(line.cases), line.amount) && !within(r.mul(bottles), line.amount)
      : line.mrp !== null && r.gt(line.mrp);
    if (perCase) rate = r.div(packQuantity).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  }
  return { quantity: bottles, rate, flags: ['CASES_CONVERTED'] };
}

function validTaxRate(rate: string | null): string | null {
  if (rate === null) return null;
  const d = new Decimal(rate);
  return d.gte(0) && d.lte(100) ? d.toFixed(2) : null;
}

export function buildDraftLines(lines: ExtractedLine[], catalog: CatalogEntry[]): DraftLine[] {
  const byId = new Map(catalog.map((p) => [p.id, p]));
  return lines.map((line) => {
    const match = matchLine(line, catalog);
    const product = match.productId ? byId.get(match.productId)! : null;
    const effectivePackQty = product?.packQuantity ?? line.packQuantity ?? null;
    const conv = convertCases(line, effectivePackQty);
    const flags = [...line.flags, ...match.flags, ...conv.flags];
    const rawDescription = line.cases !== null && !conv.flags.includes('CASES_CONVERTED')
      ? `${line.description} [${line.cases} cs]`
      : line.description;
    // qty × rate must fit numeric(12,2); an absurd product is treated as a misread quantity
    if (conv.quantity !== null && conv.rate !== null && new Decimal(conv.rate).mul(conv.quantity).gte(MAX_MONEY)) {
      conv.quantity = null;
      flags.push('VALUE_OUT_OF_RANGE');
    }
    const effectiveMrp = line.mrp ?? product?.mrp ?? null;
    const validated = validateLine({
      quantity: conv.quantity,
      costPrice: conv.rate,
      mrp: effectiveMrp,
      extractedAmount: line.amount,
      catalogMrp: product?.mrp ?? null,
      confidence: line.confidence,
      productId: match.productId,
      matchStatus: match.status,
      flags,
    });
    return {
      lineNumber: line.lineNumber,
      rawDescription: rawDescription.slice(0, 500),
      barcode: line.barcode,
      productId: match.productId,
      productName: product?.name ?? null,
      matchStatus: match.status,
      matchMethod: match.method,
      matchConfidence: match.productId ? match.confidence.toFixed(3) : (match.confidence > 0 ? match.confidence.toFixed(3) : null),
      quantity: conv.quantity !== null && conv.quantity > 0 ? conv.quantity : 0,
      costPrice: conv.rate ?? '0.00',
      mrp: effectiveMrp ?? '0.00',
      taxRate: validTaxRate(line.taxRate) ?? product?.taxRate ?? DEFAULT_TAX_RATE,
      extractedAmount: line.amount,
      lineCostTotal: validated.lineCostTotal,
      flags: validated.flags,
      candidates: match.candidates,
    };
  });
}
