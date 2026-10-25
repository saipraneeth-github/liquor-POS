import { Decimal } from 'decimal.js';
import type { LedgerGroup } from './chart.js';

// ─── TYPES ──────────────────────────────────────────────────────────────────
//
// Sign convention everywhere: balance is signed, + = debit, - = credit.

export interface LedgerMovement {
  ledgerId: string;
  code: string;
  name: string;
  group: LedgerGroup;
  openingBalance: string;   // signed
  debit: string;            // sum of journal debits in scope
  credit: string;           // sum of journal credits in scope
}

export interface LedgerBalance extends LedgerMovement {
  balance: string;          // opening + debit - credit (signed)
}

const ZERO = new Decimal(0);

function sum(values: Decimal[]): Decimal {
  return values.reduce((acc, v) => acc.plus(v), ZERO);
}

// ─── BALANCES ────────────────────────────────────────────────────────────────

export function ledgerBalance(m: Pick<LedgerMovement, 'openingBalance' | 'debit' | 'credit'>): Decimal {
  return new Decimal(m.openingBalance).plus(m.debit).minus(m.credit);
}

export function computeLedgerBalances(movements: LedgerMovement[]): LedgerBalance[] {
  return movements.map((m) => ({ ...m, balance: ledgerBalance(m).toFixed(2) }));
}

// ─── TRIAL BALANCE ───────────────────────────────────────────────────────────

export interface TrialBalanceRow {
  ledgerId: string;
  code: string;
  name: string;
  group: LedgerGroup;
  debit: string;    // closing debit balance (0 if credit)
  credit: string;   // closing credit balance (0 if debit)
}

export interface TrialBalance {
  rows: TrialBalanceRow[];
  totalDebit: string;
  totalCredit: string;
  difference: string;   // totalDebit - totalCredit
  isBalanced: boolean;
}

export function computeTrialBalance(movements: LedgerMovement[]): TrialBalance {
  const rows: TrialBalanceRow[] = movements.map((m) => {
    const bal = ledgerBalance(m);
    return {
      ledgerId: m.ledgerId,
      code: m.code,
      name: m.name,
      group: m.group,
      debit: bal.greaterThan(0) ? bal.toFixed(2) : '0.00',
      credit: bal.lessThan(0) ? bal.abs().toFixed(2) : '0.00',
    };
  });
  const totalDebit = sum(rows.map((r) => new Decimal(r.debit)));
  const totalCredit = sum(rows.map((r) => new Decimal(r.credit)));
  const difference = totalDebit.minus(totalCredit);
  return {
    rows,
    totalDebit: totalDebit.toFixed(2),
    totalCredit: totalCredit.toFixed(2),
    difference: difference.toFixed(2),
    isBalanced: difference.isZero(),
  };
}

// ─── PROFIT & LOSS ───────────────────────────────────────────────────────────

export interface ProfitLossRow { ledgerId: string; code: string; name: string; amount: string }

export interface ProfitLoss {
  income: ProfitLossRow[];
  expenses: ProfitLossRow[];
  totalIncome: string;
  totalExpense: string;
  netProfit: string;   // totalIncome - totalExpense (negative = loss)
}

/**
 * Period P&L from period movements only (opening balances are ignored here).
 * Income amount = credit - debit; expense amount = debit - credit.
 */
export function computeProfitLoss(movements: LedgerMovement[]): ProfitLoss {
  const income = movements
    .filter((m) => m.group === 'INCOME')
    .map((m) => ({ ledgerId: m.ledgerId, code: m.code, name: m.name, amount: new Decimal(m.credit).minus(m.debit).toFixed(2) }));
  const expenses = movements
    .filter((m) => m.group === 'EXPENSE')
    .map((m) => ({ ledgerId: m.ledgerId, code: m.code, name: m.name, amount: new Decimal(m.debit).minus(m.credit).toFixed(2) }));
  const totalIncome = sum(income.map((r) => new Decimal(r.amount)));
  const totalExpense = sum(expenses.map((r) => new Decimal(r.amount)));
  return {
    income,
    expenses,
    totalIncome: totalIncome.toFixed(2),
    totalExpense: totalExpense.toFixed(2),
    netProfit: totalIncome.minus(totalExpense).toFixed(2),
  };
}

// ─── BALANCE SHEET ───────────────────────────────────────────────────────────

export interface BalanceSheetRow { ledgerId: string; code: string; name: string; amount: string }

export interface BalanceSheet {
  assets: BalanceSheetRow[];
  liabilities: BalanceSheetRow[];
  equity: BalanceSheetRow[];
  totalAssets: string;
  totalLiabilities: string;
  totalEquity: string;
  retainedEarnings: string;              // net profit to date (income - expense balances incl. openings)
  totalLiabilitiesAndEquity: string;     // liabilities + equity + retained earnings
  difference: string;                    // assets - (liabilities + equity + retained)
  isBalanced: boolean;
}

/**
 * Balance sheet as of a date from cumulative movements (opening + everything up to asOf).
 * Assets are shown debit-positive; liabilities/equity credit-positive.
 */
export function computeBalanceSheet(movements: LedgerMovement[]): BalanceSheet {
  const row = (m: LedgerMovement, sign: 1 | -1): BalanceSheetRow => ({
    ledgerId: m.ledgerId, code: m.code, name: m.name, amount: ledgerBalance(m).mul(sign).toFixed(2),
  });
  const assets = movements.filter((m) => m.group === 'ASSET').map((m) => row(m, 1));
  const liabilities = movements.filter((m) => m.group === 'LIABILITY').map((m) => row(m, -1));
  const equity = movements.filter((m) => m.group === 'EQUITY').map((m) => row(m, -1));
  const retained = sum(
    movements.filter((m) => m.group === 'INCOME' || m.group === 'EXPENSE').map((m) => ledgerBalance(m).neg()),
  );

  const totalAssets = sum(assets.map((r) => new Decimal(r.amount)));
  const totalLiabilities = sum(liabilities.map((r) => new Decimal(r.amount)));
  const totalEquity = sum(equity.map((r) => new Decimal(r.amount)));
  const rhs = totalLiabilities.plus(totalEquity).plus(retained);
  const difference = totalAssets.minus(rhs);

  return {
    assets,
    liabilities,
    equity,
    totalAssets: totalAssets.toFixed(2),
    totalLiabilities: totalLiabilities.toFixed(2),
    totalEquity: totalEquity.toFixed(2),
    retainedEarnings: retained.toFixed(2),
    totalLiabilitiesAndEquity: rhs.toFixed(2),
    difference: difference.toFixed(2),
    isBalanced: difference.isZero(),
  };
}

// ─── LEDGER STATEMENT (RUNNING BALANCE) ──────────────────────────────────────

export interface StatementEntry {
  voucherId: string;
  voucherNumber: string;
  voucherDate: string;
  voucherType: string;
  narration: string;
  debit: string;
  credit: string;
}

export interface StatementRow extends StatementEntry { balance: string }

export interface LedgerStatement {
  openingBalance: string;   // balance before the first entry in range
  entries: StatementRow[];
  totalDebit: string;
  totalCredit: string;
  closingBalance: string;
}

/** Entries must already be ordered chronologically. */
export function computeRunningBalance(openingBalance: string, entries: StatementEntry[]): LedgerStatement {
  let running = new Decimal(openingBalance);
  let totalDebit = ZERO;
  let totalCredit = ZERO;
  const rows = entries.map((e) => {
    running = running.plus(e.debit).minus(e.credit);
    totalDebit = totalDebit.plus(e.debit);
    totalCredit = totalCredit.plus(e.credit);
    return { ...e, balance: running.toFixed(2) };
  });
  return {
    openingBalance: new Decimal(openingBalance).toFixed(2),
    entries: rows,
    totalDebit: totalDebit.toFixed(2),
    totalCredit: totalCredit.toFixed(2),
    closingBalance: running.toFixed(2),
  };
}
