/**
 * credit.engine.ts — Pure customer khata (credit) rules. No DB calls.
 * Balances are decimal strings; `currentCredit` is the amount the customer owes.
 */

import { Decimal } from 'decimal.js';

function positive(amount: string, label: string): Decimal {
  const d = new Decimal(amount);
  if (d.isNegative() || d.isZero()) throw new Error(`${label} must be greater than zero`);
  return d;
}

/**
 * Throws when a purchase of `amount` would push the outstanding balance above `limit`.
 */
export function assertCreditAvailable(current: string, limit: string, amount: string): void {
  const amt = new Decimal(amount);
  if (amt.isNegative()) throw new Error('Credit amount cannot be negative');
  const lim = new Decimal(limit);
  const next = new Decimal(current).plus(amt);
  if (next.greaterThan(lim)) {
    const available = Decimal.max(lim.minus(current), 0);
    throw new Error(
      `Credit limit exceeded: outstanding ${new Decimal(current).toFixed(2)} + bill ${amt.toFixed(2)} ` +
      `exceeds limit ${lim.toFixed(2)} (available ${available.toFixed(2)})`,
    );
  }
}

/** New outstanding balance after a credit purchase. */
export function applyCreditPurchase(current: string, amount: string): string {
  return new Decimal(current).plus(positive(amount, 'Purchase amount')).toFixed(2);
}

/** New outstanding balance after a repayment. Over-repayment is rejected. */
export function applyRepayment(current: string, amount: string): string {
  const amt = positive(amount, 'Repayment amount');
  const cur = new Decimal(current);
  if (amt.greaterThan(cur)) {
    throw new Error(`Repayment ${amt.toFixed(2)} exceeds outstanding balance ${cur.toFixed(2)}`);
  }
  return cur.minus(amt).toFixed(2);
}

/**
 * New balance after reversing a credit purchase (e.g. bill void). May go negative
 * (customer holds an advance) when the bill was already repaid.
 */
export function applyCreditReversal(current: string, amount: string): string {
  return new Decimal(current).minus(positive(amount, 'Reversal amount')).toFixed(2);
}

// ─── CUSTOMER RULES ──────────────────────────────────────────────────────────

/**
 * Normalises an Indian mobile number to its 10-digit form.
 * Accepts optional spaces/dashes and a leading "+91", "91" or "0". Returns null when invalid.
 * Valid mobiles start with 6, 7, 8 or 9.
 */
export function normalizeIndianMobile(raw: string): string | null {
  let digits = raw.replace(/[\s-]/g, '');
  if (digits.startsWith('+91')) digits = digits.slice(3);
  else if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

/** Throws when a new credit limit would sit below the customer's current outstanding balance. */
export function assertCreditLimitUpdate(newLimit: string, currentCredit: string): void {
  const lim = new Decimal(newLimit);
  if (lim.isNegative()) throw new Error('Credit limit cannot be negative');
  const cur = new Decimal(currentCredit);
  if (lim.lessThan(cur)) {
    throw new Error(`Credit limit ${lim.toFixed(2)} cannot be below current outstanding ${cur.toFixed(2)}`);
  }
}

// ─── STATEMENT ───────────────────────────────────────────────────────────────

export type CreditTxnType = 'PURCHASE' | 'REPAYMENT' | 'ADJUSTMENT';

export interface CreditTxnInput {
  type: CreditTxnType;
  amount: string;           // always positive
  recordedAt: Date | null;
}

/**
 * Signed effect of a transaction on the outstanding balance.
 * PURCHASE increases what the customer owes; REPAYMENT and ADJUSTMENT (bill-void reversals)
 * reduce it.
 */
export function creditTxnDelta(type: CreditTxnType, amount: string): Decimal {
  const amt = new Decimal(amount);
  return type === 'PURCHASE' ? amt : amt.negated();
}

/**
 * Builds a khata statement: replays transactions in chronological order from a zero
 * opening balance, attaches `runningBalance` (balance after that entry), and returns the
 * entries NEWEST FIRST. Input order does not matter (ties keep input order).
 */
export function buildStatement<T extends CreditTxnInput>(
  txns: T[],
): { entries: (T & { runningBalance: string })[]; closingBalance: string } {
  const chronological = txns
    .map((t, idx) => ({ t, idx }))
    .sort((a, b) => {
      const ta = a.t.recordedAt?.getTime() ?? 0;
      const tb = b.t.recordedAt?.getTime() ?? 0;
      return ta - tb || a.idx - b.idx;
    });

  let balance = new Decimal(0);
  const withBalance = chronological.map(({ t }) => {
    balance = balance.plus(creditTxnDelta(t.type, t.amount));
    return { ...t, runningBalance: balance.toFixed(2) };
  });

  return { entries: withBalance.reverse(), closingBalance: balance.toFixed(2) };
}
