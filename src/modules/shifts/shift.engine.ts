import { Decimal } from 'decimal.js';

// ─── SHIFT ENGINE ────────────────────────────────────────────────────────────
//
// Pure cash-drawer maths for cashier shifts. No DB, no I/O.
//
//   expectedCash = openingFloat + cashCollected
//   countedCash  = Σ(note value × count) + coins
//   discrepancy  = countedCash − expectedCash   (negative = shortage, positive = excess)

export const NOTE_VALUES = ['2000', '500', '200', '100', '50', '20', '10'] as const;
export type NoteValue = (typeof NOTE_VALUES)[number];

export type Denominations = Partial<Record<NoteValue, number>> & { coins?: string | number };

const MONEY_RE = /^\d+(\.\d{1,2})?$/;

export interface ShiftBill {
  status:      string;          // only PAID bills count
  paymentMode: string | null;   // CASH | CARD | UPI | CREDIT
  total:       string;
}

export interface ShiftSummary {
  cashCollected:   string;
  cardCollected:   string;
  upiCollected:    string;
  creditCollected: string;
  grossCollected:  string;
  paidBillsCount:  number;
  expectedCash:    string;
}

function toMoney(value: string | number, label: string): Decimal {
  const str = typeof value === 'number' ? String(value) : value;
  if (!MONEY_RE.test(str)) throw new Error(`Invalid amount for ${label}: ${value}`);
  return new Decimal(str);
}

// ─── DENOMINATIONS ───────────────────────────────────────────────────────────

/**
 * Totals a cash count. Accepts known note values only, each a non-negative integer count,
 * plus an optional non-negative `coins` amount (max 2dp). Returns a 2dp string.
 */
export function countDenominations(denoms: Record<string, unknown>): string {
  if (!denoms || typeof denoms !== 'object' || Array.isArray(denoms)) {
    throw new Error('Denominations must be an object');
  }
  let total = new Decimal(0);
  for (const [key, raw] of Object.entries(denoms)) {
    if (raw === undefined) continue;
    if (key === 'coins') {
      if (typeof raw !== 'string' && typeof raw !== 'number') throw new Error('coins must be a decimal amount');
      total = total.plus(toMoney(raw, 'coins'));
      continue;
    }
    if (!(NOTE_VALUES as readonly string[]).includes(key)) {
      throw new Error(`Unknown denomination: ${key}`);
    }
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
      throw new Error(`Count for ${key} must be a non-negative integer`);
    }
    total = total.plus(new Decimal(key).times(raw));
  }
  return total.toFixed(2);
}

// ─── SUMMARY ─────────────────────────────────────────────────────────────────

/** Collections per payment mode from PAID bills (VOIDED/OPEN ignored) and the expected drawer cash. */
export function computeShiftSummary(openingFloat: string, bills: ShiftBill[]): ShiftSummary {
  const float = toMoney(openingFloat, 'openingFloat');
  const sums: Record<'CASH' | 'CARD' | 'UPI' | 'CREDIT', Decimal> = {
    CASH: new Decimal(0), CARD: new Decimal(0), UPI: new Decimal(0), CREDIT: new Decimal(0),
  };
  let paid = 0;
  let gross = new Decimal(0);
  for (const bill of bills) {
    if (bill.status !== 'PAID') continue;
    const amount = new Decimal(bill.total);
    paid += 1;
    gross = gross.plus(amount);
    const mode = (bill.paymentMode ?? 'CASH').toUpperCase() as keyof typeof sums;
    if (mode in sums) sums[mode] = sums[mode].plus(amount);
    else sums.CASH = sums.CASH.plus(amount);   // unknown legacy modes are treated as cash
  }
  return {
    cashCollected:   sums.CASH.toFixed(2),
    cardCollected:   sums.CARD.toFixed(2),
    upiCollected:    sums.UPI.toFixed(2),
    creditCollected: sums.CREDIT.toFixed(2),
    grossCollected:  gross.toFixed(2),
    paidBillsCount:  paid,
    expectedCash:    float.plus(sums.CASH).toFixed(2),
  };
}

/** counted − expected, 2dp (negative = shortage, positive = excess). */
export function computeDiscrepancy(countedCash: string, expectedCash: string): string {
  return new Decimal(countedCash).minus(new Decimal(expectedCash)).toFixed(2);
}
