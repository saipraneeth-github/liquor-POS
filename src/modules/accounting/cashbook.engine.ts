import { Decimal } from 'decimal.js';

/**
 * PURE: the classic cash book. A ledger statement (CASH or BANK) regrouped by day: what the day opened with, what came in
 * (receipts = debits), what went out (payments = credits) and what it closed with, with the entries of the day under it.
 */
export interface CashBookEntry {
  voucherId: string;
  voucherNumber: string;
  voucherDate: string;       // YYYY-MM-DD
  voucherType: string;
  narration: string;
  debit: string;
  credit: string;
  balance: string;           // running balance after this entry
}

export interface CashBookDay {
  date: string;
  opening: string;
  receipts: string;
  payments: string;
  closing: string;
  entries: CashBookEntry[];
}

export interface CashBook {
  opening: string;
  closing: string;
  totalReceipts: string;
  totalPayments: string;
  days: CashBookDay[];
}

/** `entries` must already be in chronological order with running balances (computeRunningBalance). */
export function buildCashBook(openingBalance: string, entries: CashBookEntry[]): CashBook {
  const days: CashBookDay[] = [];
  let running = new Decimal(openingBalance);
  let totalReceipts = new Decimal(0);
  let totalPayments = new Decimal(0);

  for (const e of entries) {
    let day = days[days.length - 1];
    if (!day || day.date !== e.voucherDate) {
      day = { date: e.voucherDate, opening: running.toFixed(2), receipts: '0.00', payments: '0.00', closing: running.toFixed(2), entries: [] };
      days.push(day);
    }
    const debit = new Decimal(e.debit);
    const credit = new Decimal(e.credit);
    running = running.plus(debit).minus(credit);
    totalReceipts = totalReceipts.plus(debit);
    totalPayments = totalPayments.plus(credit);
    day.receipts = new Decimal(day.receipts).plus(debit).toFixed(2);
    day.payments = new Decimal(day.payments).plus(credit).toFixed(2);
    day.closing = running.toFixed(2);
    day.entries.push(e);
  }

  return {
    opening: new Decimal(openingBalance).toFixed(2),
    closing: running.toFixed(2),
    totalReceipts: totalReceipts.toFixed(2),
    totalPayments: totalPayments.toFixed(2),
    days,
  };
}
