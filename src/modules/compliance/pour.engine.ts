/**
 * pour.engine.ts — Pure peg-variance maths. A pour count compares the ml physically left in the
 * open bottle with what the system expects; negative variance = short (spillage, free pours, theft).
 */

import { Decimal } from 'decimal.js';

export function pourVariance(expectedMl: number, countedMl: number): number {
  return countedMl - expectedMl;
}

/** Money value of a variance at the bottle's per-ml rate (selling value). */
export function varianceValue(varianceMl: number, bottleRate: string, bottleMl: number | null): string {
  if (!bottleMl || bottleMl <= 0) return '0.00';
  return new Decimal(bottleRate).div(bottleMl).mul(varianceMl).toDecimalPlaces(2).toFixed(2);
}

/** Variance as a share of ml sold (0 when nothing was sold). Negative = shortage. */
export function variancePercent(varianceMl: number, soldMl: number): string {
  if (soldMl <= 0) return '0.0';
  return new Decimal(varianceMl).div(soldMl).mul(100).toDecimalPlaces(1).toFixed(1);
}

/** Validates a counted figure against the bottle size. */
export function assertValidCount(countedMl: number, bottleMl: number | null): void {
  if (!Number.isInteger(countedMl) || countedMl < 0) throw new Error('Counted ml must be a whole number, 0 or more');
  if (bottleMl && countedMl > bottleMl) throw new Error(`Counted ml cannot exceed the ${bottleMl} ml bottle`);
}
