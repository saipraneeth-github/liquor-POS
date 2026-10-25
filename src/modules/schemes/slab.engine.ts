/**
 * slab.engine.ts — Pure case-based scheme slab evaluation. No DB calls.
 *
 * RULE ("best slab", non-cumulative):
 *   The scheme pays out according to ONE slab — the highest slab whose `minCases` is
 *   less than or equal to the total cases purchased. Lower slabs are NOT added on top.
 *   The discount applies to ALL cases purchased:
 *
 *     discountTotal = slab.discountPerCase × totalCases
 *     freeBottles   = slab.freeBottles
 *
 *   When no slab is reached, the payout is zero and `nextSlab` is the first slab.
 *   `casesToNextSlab` = nextSlab.minCases − totalCases (null when already at the top slab).
 */

import { Decimal } from 'decimal.js';

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface CaseSlab {
  minCases: number;
  freeBottles: number;
  discountPerCase: string;   // decimal string
}

export interface SlabEvaluation<S extends CaseSlab = CaseSlab> {
  totalCases: string;
  slab: S | null;
  freeBottles: number;
  discountTotal: string;
  nextSlab: S | null;
  casesToNextSlab: string | null;
}

// ─── EVALUATION ───────────────────────────────────────────────────────────────

/** Evaluates `totalCases` (number or decimal string) against `slabs` (any order). */
export function evaluateSlabs<S extends CaseSlab>(
  totalCases: number | string,
  slabs: S[],
): SlabEvaluation<S> {
  const total = new Decimal(totalCases);
  if (total.isNegative()) throw new Error('totalCases cannot be negative');

  const sorted = [...slabs].sort((a, b) => a.minCases - b.minCases);

  let slab: S | null = null;
  let nextSlab: S | null = null;
  for (const s of sorted) {
    if (total.greaterThanOrEqualTo(s.minCases)) slab = s;
    else { nextSlab = s; break; }
  }

  return {
    totalCases:      total.toFixed(2),
    slab,
    freeBottles:     slab?.freeBottles ?? 0,
    discountTotal:   slab ? new Decimal(slab.discountPerCase).times(total).toFixed(2) : '0.00',
    nextSlab,
    casesToNextSlab: nextSlab ? new Decimal(nextSlab.minCases).minus(total).toFixed(2) : null,
  };
}

/** Returns an error message when slabs are invalid (duplicate or negative minCases), else null. */
export function validateSlabs(slabs: CaseSlab[]): string | null {
  const seen = new Set<number>();
  for (const s of slabs) {
    if (!Number.isInteger(s.minCases) || s.minCases < 0) return 'minCases must be a non-negative integer';
    if (!Number.isInteger(s.freeBottles) || s.freeBottles < 0) return 'freeBottles must be a non-negative integer';
    if (new Decimal(s.discountPerCase).isNegative()) return 'discountPerCase cannot be negative';
    if (seen.has(s.minCases)) return `Duplicate slab for minCases ${s.minCases}`;
    seen.add(s.minCases);
  }
  return null;
}
