/**
 * lifting.engine.ts — Pure excise quota / stock-lifting evaluation. No DB calls.
 *
 * Quotas are expressed in CASES; supplier invoices record BOTTLES. Each lifted line is
 * converted with the product's pack size:
 *
 *   cases = quantity / packQuantity     (packQuantity missing or <= 0 → DEFAULT_PACK_QUANTITY = 12)
 *
 * Dates are business dates (YYYY-MM-DD); `today` is passed in for determinism.
 *
 *   daysLeft       = calendar days remaining in the period INCLUDING today
 *                    (today == periodEnd → 1; after periodEnd → 0; before periodStart → full period length)
 *   utilisationPct = liftedCases / quotaCases × 100 (2dp, not capped)
 *   remainingCases = max(quotaCases − liftedCases, 0)
 *
 * Flags:
 *   EXCEEDED       liftedCases > quotaCases
 *   EXPIRING       period still running, daysLeft <= 7 and utilisation < 90%
 *   EXPIRED_UNMET  period has ended (today > periodEnd) with liftedCases < quotaCases
 */

import { Decimal } from 'decimal.js';

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

export const DEFAULT_PACK_QUANTITY = 12;
export const EXPIRING_DAYS_THRESHOLD = 7;
export const EXPIRING_UTILISATION_PCT = 90;

// ─── TYPES ────────────────────────────────────────────────────────────────────

export type LiftingFlag = 'EXPIRING' | 'EXCEEDED' | 'EXPIRED_UNMET';

export interface LiftedLine {
  quantity: number;               // bottles
  packQuantity: number | null;    // bottles per case
}

export interface QuotaInput {
  quotaCases: number;
  periodStart: string;            // YYYY-MM-DD
  periodEnd: string;              // YYYY-MM-DD
}

export interface LiftingResult {
  liftedCases: string;
  utilisationPct: string;
  remainingCases: string;
  daysLeft: number;
  flags: LiftingFlag[];
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function dayNumber(date: string): number {
  const t = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(t)) throw new Error(`Invalid date ${date}; expected YYYY-MM-DD`);
  return Math.round(t / 86_400_000);
}

/** Bottles → cases using the product pack size (default 12). */
export function bottlesToCases(quantity: number, packQuantity: number | null | undefined): Decimal {
  const pack = packQuantity && packQuantity > 0 ? packQuantity : DEFAULT_PACK_QUANTITY;
  return new Decimal(quantity).div(pack);
}

export function sumLiftedCases(lines: LiftedLine[]): Decimal {
  return lines.reduce((acc, l) => acc.plus(bottlesToCases(l.quantity, l.packQuantity)), new Decimal(0));
}

/** True when the quota period [start, end] overlaps the inclusive range [from, to]. */
export function periodsOverlap(start: string, end: string, from: string, to: string): boolean {
  return dayNumber(start) <= dayNumber(to) && dayNumber(end) >= dayNumber(from);
}

// ─── EVALUATION ───────────────────────────────────────────────────────────────

export function evaluateLifting(quota: QuotaInput, lines: LiftedLine[], today: string): LiftingResult {
  const start = dayNumber(quota.periodStart);
  const end = dayNumber(quota.periodEnd);
  const now = dayNumber(today);
  if (end < start) throw new Error('periodEnd must be on or after periodStart');

  const lifted = sumLiftedCases(lines).toDecimalPlaces(2);
  const quotaCases = new Decimal(quota.quotaCases);

  const utilisation = quotaCases.isZero()
    ? (lifted.isZero() ? new Decimal(0) : new Decimal(100))
    : lifted.div(quotaCases).times(100).toDecimalPlaces(2);

  const expired = now > end;
  const started = now >= start;
  const daysLeft = expired ? 0 : !started ? end - start + 1 : end - now + 1;

  const flags: LiftingFlag[] = [];
  if (lifted.greaterThan(quotaCases)) flags.push('EXCEEDED');
  if (started && !expired && daysLeft <= EXPIRING_DAYS_THRESHOLD && utilisation.lessThan(EXPIRING_UTILISATION_PCT)) {
    flags.push('EXPIRING');
  }
  if (expired && lifted.lessThan(quotaCases)) flags.push('EXPIRED_UNMET');

  return {
    liftedCases:    lifted.toFixed(2),
    utilisationPct: utilisation.toFixed(2),
    remainingCases: Decimal.max(quotaCases.minus(lifted), 0).toFixed(2),
    daysLeft,
    flags,
  };
}
