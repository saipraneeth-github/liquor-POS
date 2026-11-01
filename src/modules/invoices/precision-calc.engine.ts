/**
 * precision-calc.engine.ts — PURE: High-precision invoice and inventory arithmetic.
 *
 * Implements the mandatory calculation rule:
 * 1. Calculate per-bottle cost at full precision: CaseRate / PackSize (e.g. 1501 / 12 = 125.083333...)
 *    Store internally at DECIMAL(14,6) — never round early!
 * 2. Compute line totals from source-of-truth:
 *    (Cases × CaseRate) + (LooseBottles × (CaseRate / PackSize))
 * 3. Multiply quantity × precision unit cost to derive unitDerivedTotal (e.g. 600 × 125.083333 = 75,049.9998)
 * 4. Explicitly reconcile residual delta (e.g. +0.0002) in roundingAdjustment so stored totals match
 *    the invoice line amount exactly.
 * 5. Track old vs new price changes, calculate difference and percentage, flag increases > 10%.
 */
import { Decimal } from 'decimal.js';

// Internal arithmetic precision: 20 significant digits
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

export const HIGH_INCREASE_THRESHOLD_PCT = 10; // Warning threshold for price spikes

export interface LineCalcInput {
  lineNumber: number;
  cases: number | null;
  looseBottles: number | null;
  packQuantity: number | null;
  rate: string | null;           // could be case rate or bottle rate
  caseRate?: string | null;      // explicit case rate if known
  amount: string | null;         // source-of-truth line total printed on invoice
  mrp: string | null;
  currentProductCost?: string | null;
}

export interface PrecisionLineResult {
  lineNumber: number;
  casesDelivered: number;
  bottlesDelivered: number;
  packQuantity: number;
  totalQuantity: number;
  caseRate: string;              // e.g. "1501.00"
  exactUnitCost: Decimal;        // full precision Decimal
  costPrice: string;             // stored as DECIMAL(14,6), e.g. "125.083333"
  displayUnitCost: string;       // 2 decimals for display, e.g. "125.08"
  lineCostTotal: string;         // source-of-truth total, e.g. "75050.00"
  unitDerivedTotal: string;      // totalQuantity * costPrice, e.g. "75049.9998"
  roundingAdjustment: string;    // lineCostTotal - unitDerivedTotal, e.g. "0.0002"
  previousCostPrice: string | null;
  costDifference: string | null;
  costIncreasePct: string | null;
  hasIncreased: boolean;
  hasDecreased: boolean;
  isHighIncrease: boolean;
  flags: string[];
}

export interface ReconciledInvoiceTotals {
  linesBasicTotal: string;        // Wholesale line sum, e.g. "630224.00"
  mrpRoundingOff: string;         // State excise rounding off, e.g. "50371.20"
  netInvoiceValue: string;        // Debit amount, e.g. "680595.20"
  totalDerivedSum: string;        // Sum of unit-derived line amounts
  totalRoundingAdjustment: string;// Sum of line rounding adjustments
  variance: string;               // linesBasicTotal + mrpRoundingOff - netInvoiceValue
  isBalanced: boolean;
}

/**
 * Calculates precision unit cost, derived totals, and rounding adjustment for an invoice line.
 */
export function calculatePrecisionLine(input: LineCalcInput): PrecisionLineResult {
  const flags: string[] = [];
  const cases = Math.max(0, input.cases ?? 0);
  const loose = Math.max(0, input.looseBottles ?? 0);
  const pack = Math.max(1, input.packQuantity ?? 12);
  const totalQuantity = (cases * pack) + loose;

  const rawAmount = input.amount !== null ? new Decimal(input.amount) : null;

  // Determine wholesale case rate
  let caseRateDec: Decimal;
  if (input.caseRate && new Decimal(input.caseRate).gt(0)) {
    caseRateDec = new Decimal(input.caseRate);
  } else if (input.rate && new Decimal(input.rate).gt(0)) {
    const r = new Decimal(input.rate);
    // If rate > MRP or rate * cases approx matches amount, it's a case rate
    const isPerCase = rawAmount !== null && cases > 0
      ? r.mul(cases).minus(rawAmount).abs().lte(2)
      : input.mrp !== null && r.gt(new Decimal(input.mrp));
    if (isPerCase) {
      caseRateDec = r;
    } else if (rawAmount !== null && totalQuantity > 0) {
      // Derive case rate from invoice line amount
      caseRateDec = rawAmount.mul(pack).div(totalQuantity).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    } else {
      caseRateDec = r.mul(pack).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    }
  } else if (rawAmount !== null && totalQuantity > 0) {
    caseRateDec = rawAmount.mul(pack).div(totalQuantity).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  } else {
    caseRateDec = new Decimal(0);
    flags.push('UNREADABLE_NUMBER');
  }

  // Mandatory Rule: Per-bottle cost at full precision = CaseRate / PackSize
  const exactUnitCost = pack > 0 ? caseRateDec.div(pack) : new Decimal(0);
  const storageCost = exactUnitCost.decimalPlaces() > 2
    ? exactUnitCost.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toFixed(6)
    : exactUnitCost.toFixed(2);

  // Line cost total from source-of-truth invoice amount, or computed from case formula
  let lineCostTotalDec: Decimal;
  if (rawAmount !== null) {
    lineCostTotalDec = rawAmount;
  } else {
    lineCostTotalDec = new Decimal(cases).mul(caseRateDec)
      .plus(new Decimal(loose).mul(exactUnitCost))
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  }

  // Verification derived total: totalQuantity × storageCost (6 decimal places)
  const unitDerivedDec = new Decimal(storageCost).mul(totalQuantity).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

  // Reconciled residual rounding adjustment
  const lineRoundingAdjDec = lineCostTotalDec.minus(unitDerivedDec);

  // Price change comparison against catalog
  let previousCostPrice: string | null = null;
  let costDifference: string | null = null;
  let costIncreasePct: string | null = null;
  let hasIncreased = false;
  let hasDecreased = false;
  let isHighIncrease = false;

  if (input.currentProductCost) {
    const prev = new Decimal(input.currentProductCost);
    previousCostPrice = prev.toFixed(6);
    const diff = new Decimal(storageCost).minus(prev);
    costDifference = diff.toFixed(6);

    if (diff.gt(new Decimal('0.0001'))) {
      hasIncreased = true;
      flags.push('COST_INCREASED');
      const pct = prev.gt(0) ? diff.div(prev).mul(100) : new Decimal(0);
      costIncreasePct = pct.toFixed(2);
      if (pct.gte(HIGH_INCREASE_THRESHOLD_PCT)) {
        isHighIncrease = true;
        flags.push('HIGH_COST_INCREASE');
      }
    } else if (diff.lt(new Decimal('-0.0001'))) {
      hasDecreased = true;
      flags.push('COST_DECREASED');
      const pct = prev.gt(0) ? diff.abs().div(prev).mul(100) : new Decimal(0);
      costIncreasePct = pct.negated().toFixed(2);
    }
  }

  return {
    lineNumber: input.lineNumber,
    casesDelivered: cases,
    bottlesDelivered: loose,
    packQuantity: pack,
    totalQuantity,
    caseRate: caseRateDec.toFixed(2),
    exactUnitCost,
    costPrice: storageCost,
    displayUnitCost: exactUnitCost.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
    lineCostTotal: lineCostTotalDec.toFixed(2),
    unitDerivedTotal: unitDerivedDec.toFixed(4),
    roundingAdjustment: lineRoundingAdjDec.toFixed(4),
    previousCostPrice,
    costDifference,
    costIncreasePct,
    hasIncreased,
    hasDecreased,
    isHighIncrease,
    flags,
  };
}

/**
 * Reconciles the whole invoice document:
 * Net Invoice Value = LinesBasicTotal + mrpRoundingOff
 */
export function reconcileInvoiceTotals(
  lines: Array<{ lineCostTotal: string; unitDerivedTotal?: string; roundingAdjustment?: string }>,
  capturedTotal: string,
  mrpRoundingOffInput?: string | null,
): ReconciledInvoiceTotals {
  let linesSum = new Decimal(0);
  let derivedSum = new Decimal(0);
  let roundingSum = new Decimal(0);

  for (const l of lines) {
    linesSum = linesSum.plus(new Decimal(l.lineCostTotal || '0'));
    if (l.unitDerivedTotal) derivedSum = derivedSum.plus(new Decimal(l.unitDerivedTotal));
    if (l.roundingAdjustment) roundingSum = roundingSum.plus(new Decimal(l.roundingAdjustment));
  }

  const netInvoiceVal = new Decimal(capturedTotal || '0');

  // If MRP Rounding Off was explicitly extracted, use it; otherwise compute it as netInvoiceVal - linesSum
  let mrpRoundingOffDec: Decimal;
  if (mrpRoundingOffInput !== null && mrpRoundingOffInput !== undefined && mrpRoundingOffInput.trim() !== '') {
    mrpRoundingOffDec = new Decimal(mrpRoundingOffInput);
  } else if (netInvoiceVal.gt(linesSum)) {
    mrpRoundingOffDec = netInvoiceVal.minus(linesSum);
  } else {
    mrpRoundingOffDec = new Decimal(0);
  }

  const variance = netInvoiceVal.minus(linesSum.plus(mrpRoundingOffDec));

  return {
    linesBasicTotal: linesSum.toFixed(2),
    mrpRoundingOff: mrpRoundingOffDec.toFixed(2),
    netInvoiceValue: netInvoiceVal.toFixed(2),
    totalDerivedSum: derivedSum.toFixed(4),
    totalRoundingAdjustment: roundingSum.toFixed(4),
    variance: variance.toFixed(2),
    isBalanced: variance.abs().lte(new Decimal('0.02')),
  };
}
