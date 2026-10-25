import { Decimal } from 'decimal.js';

// ─── EXPENSE SUMMARY ─────────────────────────────────────────────────────────

/** 'Staff-Salary ' → 'STAFF_SALARY' — mirrors normalizeLedgerCode() in accounting/chart.ts. */
export function expenseGroupKey(category: string): string {
  return category.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || category.trim().toUpperCase();
}

export interface ExpenseAmount { category: string; amount: string }

export interface ExpenseSummary {
  byCategory: { category: string; total: string; count: number }[];
  total: string;
  count: number;
}

/** Groups expenses by category (case/punctuation-insensitive, first-seen spelling kept), sorted by total desc. */
export function summarizeExpenses(rows: ExpenseAmount[]): ExpenseSummary {
  const groups = new Map<string, { category: string; total: Decimal; count: number }>();
  let total = new Decimal(0);
  for (const row of rows) {
    // Same key as the EXPENSE_<CODE> ledger, so these totals agree with the P&L
    const key = expenseGroupKey(row.category);
    const g = groups.get(key) ?? { category: row.category.trim(), total: new Decimal(0), count: 0 };
    g.total = g.total.plus(row.amount);
    g.count += 1;
    groups.set(key, g);
    total = total.plus(row.amount);
  }
  const byCategory = [...groups.values()]
    .sort((a, b) => b.total.comparedTo(a.total) || a.category.localeCompare(b.category))
    .map((g) => ({ category: g.category, total: g.total.toFixed(2), count: g.count }));
  return { byCategory, total: total.toFixed(2), count: rows.length };
}
