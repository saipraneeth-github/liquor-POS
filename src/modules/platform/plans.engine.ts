/**
 * plans.engine.ts — pure rules for plan changes. No database, no clock.
 *
 * Moving a business to another plan part-way through a paid period: the unused days of the current plan are credited
 * against the new plan's price, and the new plan's billing period starts on the effective date.
 */
import { Decimal } from 'decimal.js';

const DAY = 86_400_000;
const D = (v: Decimal.Value) => new Decimal(v);

export const CYCLES = [30, 90, 365] as const;
export const CYCLE_LABEL: Record<number, string> = { 30: 'month', 90: 'quarter', 365: 'year' };

/** yyyy-mm-dd + n days, in UTC (no time zone surprises: these are calendar dates). */
export function addDaysIso(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

export interface ProrationInput {
  /** The business has paid for its current plan (a trial, or a plan never paid for, earns no credit). */
  currentPaid: boolean;
  currentPrice: string;
  currentCycleDays: number;
  paidUntil: Date | null;
  /** yyyy-mm-dd the new plan starts. */
  effective: string;
  targetPrice: string;
  targetCycleDays: number;
}

export interface Proration {
  unusedDays: number;
  credit: string;
  newPrice: string;
  amountDue: string;
  periodStart: string;
  periodEnd: string;
}

export function prorate(i: ProrationInput): Proration {
  const eff = Date.parse(`${i.effective}T00:00:00Z`);
  let unusedDays = 0;
  if (i.currentPaid && i.paidUntil && i.paidUntil.getTime() > eff) {
    unusedDays = Math.min(i.currentCycleDays, Math.ceil((i.paidUntil.getTime() - eff) / DAY));
  }
  const credit = i.currentCycleDays > 0 ? D(unusedDays).div(i.currentCycleDays).mul(i.currentPrice).toDecimalPlaces(2) : D(0);
  const due = Decimal.max(D(0), D(i.targetPrice).minus(credit)).toDecimalPlaces(2);
  return {
    unusedDays,
    credit: credit.toFixed(2),
    newPrice: D(i.targetPrice).toFixed(2),
    amountDue: due.toFixed(2),
    periodStart: i.effective,
    periodEnd: addDaysIso(i.effective, i.targetCycleDays),
  };
}

/** What a plan costs per month, whatever its billing cycle: used for recurring-revenue figures. */
export function monthlyEquivalent(price: string, cycleDays: number): string {
  return cycleDays > 0 ? D(price).mul(30).div(cycleDays).toDecimalPlaces(2).toFixed(2) : '0.00';
}

/** "Hotel Pro 2!" → "HOTEL_PRO_2": the stable code a plan is stored under. */
export function planCodeFromName(name: string): string {
  const code = name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 20);
  return code || 'PLAN';
}
