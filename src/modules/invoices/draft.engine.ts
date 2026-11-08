import { calculatePrecisionLine } from './precision-calc.engine.js';
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
  sku: string | null;
  productId: string | null;
  productName: string | null;
  matchStatus: 'MATCHED' | 'SUGGESTED' | 'UNMATCHED' | 'MANUAL';
  matchMethod: 'BARCODE' | 'SKU' | 'NAME' | 'MANUAL' | null;
  matchConfidence: string | null;
  casesDelivered: number;
  bottlesDelivered: number;
  packQuantity: number;
  quantity: number;
  caseRate: string | null;
  costPrice: string;
  displayCostPrice: string;
  mrp: string;
  taxRate: string;
  extractedAmount: string | null;
  lineCostTotal: string;
  unitDerivedTotal: string;
  roundingAdjustment: string;
  previousCostPrice: string | null;
  costDifference: string | null;
  costIncreasePct: string | null;
  hasIncreased: boolean;
  hasDecreased: boolean;
  isHighIncrease: boolean;
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
    const effectivePackQty = line.packQuantity || product?.packQuantity || 12;

    // Run precision arithmetic calculation
    const calc = calculatePrecisionLine({
      lineNumber: line.lineNumber,
      cases: line.cases,
      looseBottles: line.quantity,
      packQuantity: effectivePackQty,
      rate: line.rate,
      caseRate: line.caseRate,
      amount: line.amount,
      mrp: line.mrp ?? product?.mrp ?? null,
      currentProductCost: product?.costPrice ?? null,
    });

    const flags = [...line.flags, ...match.flags, ...calc.flags];
    if (line.cases !== null) flags.push('CASES_CONVERTED');

    const rawDescription = line.cases !== null
      ? `${line.description} [${line.cases} cs${line.quantity ? ' + ' + line.quantity + ' btls' : ''}]`
      : line.description;

    const effectiveMrp = line.mrp ?? product?.mrp ?? null;
    const validated = validateLine({
      quantity: calc.totalQuantity,
      costPrice: calc.costPrice,
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
      sku: line.sku,
      productId: match.productId,
      productName: product?.name ?? null,
      matchStatus: match.status,
      matchMethod: match.method,
      matchConfidence: match.productId ? match.confidence.toFixed(3) : (match.confidence > 0 ? match.confidence.toFixed(3) : null),
      casesDelivered: calc.casesDelivered,
      bottlesDelivered: calc.bottlesDelivered,
      packQuantity: calc.packQuantity,
      quantity: calc.totalQuantity,
      caseRate: calc.caseRate,
      costPrice: calc.costPrice,
      displayCostPrice: calc.displayUnitCost,
      mrp: effectiveMrp ?? '0.00',
      taxRate: validTaxRate(line.taxRate) ?? product?.taxRate ?? DEFAULT_TAX_RATE,
      extractedAmount: line.amount,
      lineCostTotal: calc.lineCostTotal,
      unitDerivedTotal: calc.unitDerivedTotal,
      roundingAdjustment: calc.roundingAdjustment,
      previousCostPrice: calc.previousCostPrice,
      costDifference: calc.costDifference,
      costIncreasePct: calc.costIncreasePct,
      hasIncreased: calc.hasIncreased,
      hasDecreased: calc.hasDecreased,
      isHighIncrease: calc.isHighIncrease,
      flags: validated.flags,
      candidates: match.candidates,
    };
  });
}
