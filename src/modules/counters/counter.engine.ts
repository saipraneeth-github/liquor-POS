import { Decimal } from 'decimal.js';
import { PackQuantityEngine } from '../products/pack-qty.engine.js';

// ─── COUNTER SHEET ENGINE ────────────────────────────────────────────────────
//
// Daily counter sheets derive sales from stock counts instead of POS bills:
//
//   Sold    = Opening + Inward − Closing
//   Revenue = Sold × Rate (MRP)
//
// Invariant: Closing ≤ Opening + Inward. A higher closing count means bottles appeared
// from nowhere (miscount / unrecorded inward); it is rejected unless a manager approves
// the adjustment, in which case the surplus is recorded and sold is 0.

export class CounterInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CounterInvariantError';
  }
}

export interface CounterLineInput {
  opening: number;
  inward:  number;
  closing: number;
  rate:    string;
}

export interface CounterLineResult {
  sold:    number;
  revenue: string;
  surplus: number;   // closing − (opening + inward) when an adjustment was approved, else 0
}

function assertCount(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
}

/** True when the closing count exceeds what was available (opening + inward). */
export function violatesInvariant(line: Pick<CounterLineInput, 'opening' | 'inward' | 'closing'>): boolean {
  return line.closing > line.opening + line.inward;
}

export function computeLine(line: CounterLineInput, opts: { allowAdjustment?: boolean } = {}): CounterLineResult {
  assertCount(line.opening, 'opening');
  assertCount(line.inward, 'inward');
  assertCount(line.closing, 'closing');
  if (!/^\d+(\.\d{1,2})?$/.test(line.rate)) throw new Error(`Invalid rate: ${line.rate}`);

  const available = line.opening + line.inward;
  if (line.closing > available) {
    if (!opts.allowAdjustment) {
      throw new CounterInvariantError(
        `Closing (${line.closing}) exceeds opening + inward (${available}); manager adjustment required`,
      );
    }
    return { sold: 0, revenue: '0.00', surplus: line.closing - available };
  }
  const sold = available - line.closing;
  return { sold, revenue: new Decimal(line.rate).times(sold).toFixed(2), surplus: 0 };
}

export function computeSheetTotal(lines: { revenue: string }[]): string {
  return lines.reduce((acc, l) => acc.plus(new Decimal(l.revenue)), new Decimal(0)).toFixed(2);
}

// ─── CASE ↔ BOTTLE HELPERS (delegate to PackQuantityEngine) ──────────────────

/** Cases + loose bottles → total bottles, e.g. 2 cases of 12 + 5 = 29. */
export function casesAndLooseToBottles(cases: number, loose: number, packQuantity: number | null | undefined): number {
  assertCount(cases, 'cases');
  assertCount(loose, 'loose bottles');
  if (!packQuantity || packQuantity <= 0) {
    if (cases > 0) throw new Error('Product has no pack quantity; enter bottles only');
    return loose;
  }
  return PackQuantityEngine.casesToBottles(cases, packQuantity) + loose;
}

/** Total bottles → { cases, loose }, e.g. 29 bottles of 12-pack = 2 cases + 5. */
export function bottlesToCasesAndLoose(bottles: number, packQuantity: number | null | undefined): { cases: number; loose: number } {
  assertCount(bottles, 'bottles');
  if (!packQuantity || packQuantity <= 0) return { cases: 0, loose: bottles };
  const cases = Math.floor(PackQuantityEngine.bottlesToCases(bottles, packQuantity));
  return { cases, loose: bottles - PackQuantityEngine.casesToBottles(cases, packQuantity) };
}
