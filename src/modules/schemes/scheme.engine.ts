/**
 * scheme.engine.ts — Pure supplier scheme progress and alert logic.
 * No DB calls. All side-effects in scheme.service.ts.
 */

import { Decimal } from 'decimal.js';

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface Scheme {
  id: string;
  supplierName: string;
  branchId: string;
  targetType: 'VALUE' | 'QTY';
  targetValue: Decimal;
  currentValue: Decimal;
  rewardDescription: string;
  startDate: Date;
  endDate: Date;
  alertThresholdPct?: number;   // default 80
}

export interface SchemeSlab {
  minValue: Decimal;
  maxValue: Decimal | null;   // null = open-ended (top tier)
  reward: string;
}

// ─── PROGRESS COMPUTATION ────────────────────────────────────────────────────

/**
 * Returns progress as a Decimal percentage (0–100, capped at 100).
 *
 *   progress = min(currentValue / targetValue × 100, 100)
 */
export function computeSchemeProgress(scheme: Scheme): Decimal {
  if (scheme.targetValue.isZero()) return new Decimal(0);

  const pct = scheme.currentValue
    .div(scheme.targetValue)
    .times(100)
    .toDecimalPlaces(2);

  return Decimal.min(pct, new Decimal(100));
}

// ─── ALERT DETECTION ─────────────────────────────────────────────────────────

/**
 * Returns true when the scheme's progress has reached or exceeded the alert
 * threshold (default 80%).
 *
 * Rationale: gives owners advance notice to push sales before scheme target date.
 */
export function isSchemeAlertTriggered(
  scheme: Scheme,
  alertThresholdPct?: number
): boolean {
  const threshold = alertThresholdPct ?? scheme.alertThresholdPct ?? 80;
  const progress  = computeSchemeProgress(scheme);
  return progress.greaterThanOrEqualTo(threshold);
}

// ─── SLAB REWARD SELECTION ───────────────────────────────────────────────────

/**
 * Finds the most applicable slab for a given purchase value.
 * Slabs should be ordered by minValue ascending.
 * The top-tier slab has maxValue = null (open-ended).
 *
 * Returns null if no slabs are defined.
 */
export function selectSlab(value: Decimal, slabs: SchemeSlab[]): SchemeSlab | null {
  if (slabs.length === 0) return null;

  let best: SchemeSlab | null = null;

  for (const slab of slabs) {
    const meetsMin = value.greaterThanOrEqualTo(slab.minValue);
    const meetsMax = slab.maxValue === null || value.lessThanOrEqualTo(slab.maxValue);

    if (meetsMin && meetsMax) {
      // Prefer more specific (higher minValue) slab
      if (!best || slab.minValue.greaterThan(best.minValue)) {
        best = slab;
      }
    }
  }

  return best;
}
