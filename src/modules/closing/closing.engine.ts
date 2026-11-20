import { Decimal } from 'decimal.js';

export interface DailyBillSummaryInput {
  id: string;
  total: string;
  taxAmount: string;
  paymentMode: string;
  status: 'OPEN' | 'PAID' | 'VOIDED';
}

export interface DailyReturnSummaryInput {
  refundMode: string;
  refundAmount: string;
  taxAmount?: string;
}

export interface CashFloatInput {
  openingCash: string;
  cashWithdrawals?: string;
  /** Khata repayments taken in cash that day: they go INTO the drawer without a bill. */
  cashRepayments?: string;
  /** Expenses paid in cash that day: they come OUT of the drawer without a bill. */
  cashExpenses?: string;
}

export interface SalesOverrideInput {
  cashSales?: string;
  cardSales?: string;
  upiSales?: string;
  creditSales?: string;
}

export interface DailyClosingReconciliationResult {
  openingCash: string;
  cashSales: string;
  cardSales: string;
  upiSales: string;
  creditSales: string;     // khata sales — revenue, but NOT cash in drawer
  grossSales: string;
  grossBilled: string;     // original gross bills before returns
  totalRefunds: string;    // total refunds from credit notes / returns
  cashRefunds: string;
  cardRefunds: string;
  upiRefunds: string;
  creditRefunds: string;
  totalTax: string;
  cashWithdrawals: string;
  cashRepayments: string;
  cashExpenses: string;
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
  salesOverride?: SalesOverrideInput,
  returns: DailyReturnSummaryInput[] = [],
): DailyClosingReconciliationResult {
  const actualCash = new Decimal(actualCashCountedStr);
  if (actualCash.isNegative()) {
    throw new Error('Actual cash counted cannot be negative');
  }

  const opening = new Decimal(cashFloat.openingCash);
  const withdrawals = new Decimal(cashFloat.cashWithdrawals ?? '0');
  const repayments = new Decimal(cashFloat.cashRepayments ?? '0');
  const cashExpenses = new Decimal(cashFloat.cashExpenses ?? '0');

  let cashSales = new Decimal(0);
  let cardSales = new Decimal(0);
  let upiSales = new Decimal(0);
  let creditSales = new Decimal(0);
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
      } else if (mode === 'CREDIT') {
        creditSales = creditSales.plus(total);
      } else {
        throw new Error(`Unknown payment mode ${bill.paymentMode} on bill ${bill.id}`);
      }
    }
  }

  // Deduct customer returns / credit notes per payment channel
  let cashRefunds = new Decimal(0);
  let cardRefunds = new Decimal(0);
  let upiRefunds = new Decimal(0);
  let creditRefunds = new Decimal(0);
  let totalTaxRefunds = new Decimal(0);

  for (const ret of returns) {
    const amt = new Decimal(ret.refundAmount || '0');
    const tax = new Decimal(ret.taxAmount || '0');
    totalTaxRefunds = totalTaxRefunds.plus(tax);
    const mode = (ret.refundMode || 'CASH').toUpperCase();
    if (mode === 'CASH') cashRefunds = cashRefunds.plus(amt);
    else if (mode === 'CARD') cardRefunds = cardRefunds.plus(amt);
    else if (mode === 'UPI') upiRefunds = upiRefunds.plus(amt);
    else if (mode === 'CREDIT') creditRefunds = creditRefunds.plus(amt);
  }

  const netCashSales = Decimal.max(0, cashSales.minus(cashRefunds));
  const netCardSales = Decimal.max(0, cardSales.minus(cardRefunds));
  const netUpiSales = Decimal.max(0, upiSales.minus(upiRefunds));
  const netCreditSales = Decimal.max(0, creditSales.minus(creditRefunds));
  const netTotalTax = Decimal.max(0, totalTax.minus(totalTaxRefunds));

  // Allow manager edits / adjustments
  const finalCashSales = salesOverride?.cashSales !== undefined ? new Decimal(salesOverride.cashSales) : netCashSales;
  const finalCardSales = salesOverride?.cardSales !== undefined ? new Decimal(salesOverride.cardSales) : netCardSales;
  const finalUpiSales = salesOverride?.upiSales !== undefined ? new Decimal(salesOverride.upiSales) : netUpiSales;
  const finalCreditSales = salesOverride?.creditSales !== undefined ? new Decimal(salesOverride.creditSales) : netCreditSales;

  // Total Net Sales for Day Closing = Net Cash + Net Card + Net UPI + Net Credit
  const grossSales = finalCashSales.plus(finalCardSales).plus(finalUpiSales).plus(finalCreditSales);
  const grossBilled = cashSales.plus(cardSales).plus(upiSales).plus(creditSales);
  const totalRefunds = cashRefunds.plus(cardRefunds).plus(upiRefunds).plus(creditRefunds);

  // Drawer = opening + cash sales + cash khata repayments - cash expenses - withdrawals
  const expectedCashInDrawer = opening.plus(finalCashSales).plus(repayments).minus(cashExpenses).minus(withdrawals);
  const cashDiscrepancy = actualCash.minus(expectedCashInDrawer);

  return {
    openingCash: opening.toFixed(2),
    cashSales: finalCashSales.toFixed(2),
    cardSales: finalCardSales.toFixed(2),
    upiSales: finalUpiSales.toFixed(2),
    creditSales: finalCreditSales.toFixed(2),
    grossSales: grossSales.toFixed(2),
    grossBilled: grossBilled.toFixed(2),
    totalRefunds: totalRefunds.toFixed(2),
    cashRefunds: cashRefunds.toFixed(2),
    cardRefunds: cardRefunds.toFixed(2),
    upiRefunds: upiRefunds.toFixed(2),
    creditRefunds: creditRefunds.toFixed(2),
    totalTax: netTotalTax.toFixed(2),
    cashWithdrawals: withdrawals.toFixed(2),
    cashRepayments: repayments.toFixed(2),
    cashExpenses: cashExpenses.toFixed(2),
    expectedCashInDrawer: expectedCashInDrawer.toFixed(2),
    actualCashCounted: actualCash.toFixed(2),
    cashDiscrepancy: cashDiscrepancy.toFixed(2),
    isBalanced: cashDiscrepancy.isZero(),
    totalBillsCount: bills.length,
    paidBillsCount: paidCount,
    voidedBillsCount: voidedCount,
  };
}
