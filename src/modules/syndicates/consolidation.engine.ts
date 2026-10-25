/**
 * consolidation.engine.ts — Pure aggregation of syndicate sales into a consolidated invoice.
 * No DB calls. All side-effects in syndicate.service.ts.
 */

import { Decimal } from 'decimal.js';

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface ConsolidationBillInput {
  branchId: string;
  total: string;
  taxAmount: string;
  status: 'OPEN' | 'PAID' | 'VOIDED';
}

export interface ConsolidationBranchInput {
  id: string;
  name: string;
  code: string;
}

export interface BranchBreakdown {
  branchId: string;
  branchName: string;
  branchCode: string;
  grossSales: string;
  totalTax: string;
  billCount: number;
}

export interface ConsolidatedTotals {
  grossSales: string;
  totalTax: string;
  billCount: number;
  breakdown: BranchBreakdown[];
}

// ─── PERIOD VALIDATION ────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function assertValidPeriod(periodStart: string, periodEnd: string, maxDays = 366): void {
  for (const d of [periodStart, periodEnd]) {
    if (!DATE_RE.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) {
      throw new Error(`Invalid date ${d}; expected YYYY-MM-DD`);
    }
  }
  const days = (Date.parse(`${periodEnd}T00:00:00Z`) - Date.parse(`${periodStart}T00:00:00Z`)) / 86_400_000;
  if (days < 0) throw new Error('periodEnd must be on or after periodStart');
  if (days + 1 > maxDays) throw new Error(`Period cannot exceed ${maxDays} days`);
}

// ─── AGGREGATION ──────────────────────────────────────────────────────────────

/**
 * Aggregates PAID bills only (OPEN/VOIDED ignored). Every syndicate branch appears in the
 * breakdown — including branches with no sales — ordered by branch code. Bills from
 * branches outside `branches` are rejected (guards against cross-tenant leakage).
 */
export function aggregateConsolidatedInvoice(
  branches: ConsolidationBranchInput[],
  bills: ConsolidationBillInput[],
): ConsolidatedTotals {
  const acc = new Map<string, { gross: Decimal; tax: Decimal; count: number; branch: ConsolidationBranchInput }>();
  for (const b of branches) acc.set(b.id, { gross: new Decimal(0), tax: new Decimal(0), count: 0, branch: b });

  for (const bill of bills) {
    if (bill.status !== 'PAID') continue;
    const entry = acc.get(bill.branchId);
    if (!entry) throw new Error(`Bill from branch ${bill.branchId} is outside the syndicate`);
    entry.gross = entry.gross.plus(bill.total);
    entry.tax = entry.tax.plus(bill.taxAmount);
    entry.count += 1;
  }

  const breakdown = [...acc.values()]
    .sort((a, b) => a.branch.code.localeCompare(b.branch.code))
    .map((e) => ({
      branchId:   e.branch.id,
      branchName: e.branch.name,
      branchCode: e.branch.code,
      grossSales: e.gross.toFixed(2),
      totalTax:   e.tax.toFixed(2),
      billCount:  e.count,
    }));

  return {
    grossSales: breakdown.reduce((s, b) => s.plus(b.grossSales), new Decimal(0)).toFixed(2),
    totalTax:   breakdown.reduce((s, b) => s.plus(b.totalTax), new Decimal(0)).toFixed(2),
    billCount:  breakdown.reduce((s, b) => s + b.billCount, 0),
    breakdown,
  };
}
