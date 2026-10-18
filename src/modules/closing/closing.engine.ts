import { Decimal } from 'decimal.js';

export interface DailyBillSummaryInput {
  id: string;
  total: string;
  taxAmount: string;
  paymentMode: string;
  status: 'OPEN' | 'PAID' | 'VOIDED';
}

export interface CashFloatInput {
  openingCash: string;
  cashWithdrawals?: string;
}

export interface DailyClosingReconciliationResult {
  openingCash: string;
  cashSales: string;
  cardSales: string;
  upiSales: string;
  grossSales: string;
  totalTax: string;
  cashWithdrawals: string;
  expectedCashInDrawer: string;
  actualCashCounted: string;
  cashDiscrepancy: string;
  isBalanced: boolean;
  totalBillsCount: number;
  paidBillsCount: number;
  voidedBillsCount: number;
}

/**
 * Pure engine for daily cash and sales reconciliation.
 * Computes drawer balance, payment breakdowns, and audits discrepancies.
 */
export function reconcileDailyClosing(
  bills: DailyBillSummaryInput[],
  cashFloat: CashFloatInput,
  actualCashCountedStr: string,
): DailyClosingReconciliationResult {
  const actualCash = new Decimal(actualCashCountedStr);
  if (actualCash.isNegative()) {
    throw new Error('Actual cash counted cannot be negative');
  }

  const opening = new Decimal(cashFloat.openingCash);
  const withdrawals = new Decimal(cashFloat.cashWithdrawals ?? '0');

  let cashSales = new Decimal(0);
  let cardSales = new Decimal(0);
  let upiSales = new Decimal(0);
  let totalTax = new Decimal(0);
  let paidCount = 0;
  let voidedCount = 0;

  for (const bill of bills) {
    if (bill.status === 'VOIDED') {
      voidedCount++;
      continue;
    }
    if (bill.status === 'PAID') {
      paidCount++;
      const total = new Decimal(bill.total);
      const tax = new Decimal(bill.taxAmount);
      totalTax = totalTax.plus(tax);

      const mode = (bill.paymentMode || '').toUpperCase();
      if (mode === 'CASH') {
        cashSales = cashSales.plus(total);
      } else if (mode === 'CARD') {
        cardSales = cardSales.plus(total);
      } else if (mode === 'UPI') {
        upiSales = upiSales.plus(total);
      }
    }
  }

  const grossSales = cashSales.plus(cardSales).plus(upiSales);
  const expectedCashInDrawer = opening.plus(cashSales).minus(withdrawals);
  const cashDiscrepancy = actualCash.minus(expectedCashInDrawer);

  return {
    openingCash: opening.toFixed(2),
    cashSales: cashSales.toFixed(2),
    cardSales: cardSales.toFixed(2),
    upiSales: upiSales.toFixed(2),
    grossSales: grossSales.toFixed(2),
    totalTax: totalTax.toFixed(2),
    cashWithdrawals: withdrawals.toFixed(2),
    expectedCashInDrawer: expectedCashInDrawer.toFixed(2),
    actualCashCounted: actualCash.toFixed(2),
    cashDiscrepancy: cashDiscrepancy.toFixed(2),
    isBalanced: cashDiscrepancy.isZero(),
    totalBillsCount: bills.length,
    paidBillsCount: paidCount,
    voidedBillsCount: voidedCount,
  };
}
