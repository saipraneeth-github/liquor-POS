import { Decimal } from 'decimal.js';
import { expenseLedgerCode } from './chart.js';

// ─── TYPES ──────────────────────────────────────────────────────────────────

/** One voucher line. Exactly one of debit/credit is > 0; both are 2dp decimal strings. */
export interface PostingLine<L extends string = string> {
  ledger: L;          // ledger code (posting rules) or ledger id (manual journals)
  debit: string;
  credit: string;
}

export interface RawPostingLine<L extends string = string> {
  ledger: L;
  debit?: string | number | Decimal;
  credit?: string | number | Decimal;
}

const MONEY_2DP = /^-?\d+\.\d{2}$/;

// ─── VOUCHER BUILDING / VALIDATION ───────────────────────────────────────────

function toMoney(value: string | number | Decimal | undefined): Decimal {
  if (value === undefined || value === '') return new Decimal(0);
  const d = new Decimal(value);
  if (!d.isFinite()) throw new Error(`Invalid amount ${String(value)}`);
  return d;
}

export function dr<L extends string>(ledger: L, amount: string | number | Decimal): RawPostingLine<L> {
  return { ledger, debit: amount };
}

export function cr<L extends string>(ledger: L, amount: string | number | Decimal): RawPostingLine<L> {
  return { ledger, credit: amount };
}

/**
 * Normalises raw lines (2dp strings, zero-amount lines dropped) and asserts the voucher balances.
 * Amounts with more than 2 decimal places are rejected — rounding must happen in the posting rule.
 */
export function buildVoucher<L extends string>(raw: RawPostingLine<L>[]): PostingLine<L>[] {
  const lines: PostingLine<L>[] = [];
  for (const line of raw) {
    const debit = toMoney(line.debit);
    const credit = toMoney(line.credit);
    if (debit.decimalPlaces() > 2 || credit.decimalPlaces() > 2) {
      throw new Error(`Amounts must have at most 2 decimal places (ledger ${line.ledger})`);
    }
    if (debit.isZero() && credit.isZero()) continue;
    lines.push({ ledger: line.ledger, debit: debit.toFixed(2), credit: credit.toFixed(2) });
  }
  assertBalanced(lines);
  return lines;
}

export interface VoucherTotals { debit: string; credit: string }

export function voucherTotals(lines: Pick<PostingLine, 'debit' | 'credit'>[]): VoucherTotals {
  let debit = new Decimal(0);
  let credit = new Decimal(0);
  for (const l of lines) {
    debit = debit.plus(l.debit);
    credit = credit.plus(l.credit);
  }
  return { debit: debit.toFixed(2), credit: credit.toFixed(2) };
}

/** Throws unless sum(debit) == sum(credit) > 0 and every line has exactly one positive 2dp side. */
export function assertBalanced(lines: Pick<PostingLine, 'ledger' | 'debit' | 'credit'>[]): void {
  if (lines.length < 2) throw new Error('A voucher needs at least two lines');
  for (const l of lines) {
    if (!MONEY_2DP.test(l.debit) || !MONEY_2DP.test(l.credit)) {
      throw new Error(`Line amounts must be 2dp decimal strings (ledger ${l.ledger})`);
    }
    const debit = new Decimal(l.debit);
    const credit = new Decimal(l.credit);
    if (debit.isNegative() || credit.isNegative()) {
      throw new Error(`Negative amount on ledger ${l.ledger}`);
    }
    const positives = (debit.greaterThan(0) ? 1 : 0) + (credit.greaterThan(0) ? 1 : 0);
    if (positives !== 1) {
      throw new Error(`Each line must have exactly one of debit/credit > 0 (ledger ${l.ledger})`);
    }
  }
  const totals = voucherTotals(lines);
  if (!new Decimal(totals.debit).equals(totals.credit)) {
    throw new Error(`Voucher is not balanced: debit ${totals.debit} != credit ${totals.credit}`);
  }
  if (!new Decimal(totals.debit).greaterThan(0)) {
    throw new Error('Voucher total must be greater than zero');
  }
}

/** Swaps every debit/credit — the exact reversal of a voucher. */
export function reverseLines<L extends string>(lines: PostingLine<L>[]): PostingLine<L>[] {
  return lines.map((l) => ({ ledger: l.ledger, debit: l.credit, credit: l.debit }));
}

// ─── PAYMENT MODE → LEDGER ───────────────────────────────────────────────────

export type MoneyLedgerCode = 'CASH' | 'BANK' | 'SUNDRY_DEBTORS';

/** CASH → CASH; CARD/UPI/BANK → BANK; CREDIT → SUNDRY_DEBTORS (only when allowed). */
export function paymentLedgerCode(paymentMode: string | null | undefined, allowCredit = true): MoneyLedgerCode {
  switch ((paymentMode ?? '').toUpperCase()) {
    case 'CASH':   return 'CASH';
    case 'CARD':
    case 'UPI':
    case 'BANK':   return 'BANK';
    case 'CREDIT':
      if (allowCredit) return 'SUNDRY_DEBTORS';
      break;
  }
  throw new Error(`Unsupported payment mode for posting: ${paymentMode ?? 'none'}`);
}

// ─── POSTING RULES ───────────────────────────────────────────────────────────

export interface BillPostingInput {
  subtotal: string;      // MRP-inclusive gross (sum of qty × MRP)
  taxAmount: string;     // GST contained inside the subtotal
  discount: string;      // flat discount after tax
  total: string;         // subtotal - discount + roundOff (amount received / receivable)
  roundOff?: string;     // rounding to a whole rupee (+ = customer paid more)
  paymentMode: string | null;
}

/**
 * Bill paid:
 *   Dr CASH | BANK | SUNDRY_DEBTORS   total
 *   Dr DISCOUNT_ALLOWED               discount (if > 0)
 *       Cr SALES                      subtotal - taxAmount
 *       Cr OUTPUT_GST                 taxAmount
 *   Dr|Cr ROUND_OFF                   |roundOff| (only when rounding is on)
 * Balances because total + discount - roundOff = subtotal = (subtotal - tax) + tax.
 */
export function billPaidLines(bill: BillPostingInput): PostingLine[] {
  const subtotal = new Decimal(bill.subtotal);
  const tax = new Decimal(bill.taxAmount);
  const discount = new Decimal(bill.discount);
  const total = new Decimal(bill.total);
  const roundOff = new Decimal(bill.roundOff ?? '0');
  if (!total.equals(subtotal.minus(discount).plus(roundOff))) {
    throw new Error(`Bill total ${bill.total} != subtotal ${bill.subtotal} - discount ${bill.discount} + round-off ${roundOff.toFixed(2)}`);
  }
  return buildVoucher<string>([
    dr(paymentLedgerCode(bill.paymentMode), total),
    dr('DISCOUNT_ALLOWED', discount),
    cr('SALES', subtotal.minus(tax)),
    cr('OUTPUT_GST', tax),
    // Customer paid more than the bill (round up) = income; paid less (round down) = expense
    ...(roundOff.isPositive() && !roundOff.isZero() ? [cr('ROUND_OFF', roundOff)] : []),
    ...(roundOff.isNegative() ? [dr('ROUND_OFF', roundOff.abs())] : []),
  ]);
}

export interface CounterSheetSaleLine {
  amount: string;     // tax-inclusive revenue of the bottles (bottles × the counter's rate)
  taxRate: string;    // GST % contained in the amount
}

/**
 * Bottles that left a counter without a POS bill (found by the counter sheet), sold for cash:
 *   Dr CASH             total
 *       Cr SALES        total − tax
 *       Cr OUTPUT_GST   tax        (back-calculated per line, like a bill)
 */
export function counterSheetSalesLines(lines: CounterSheetSaleLine[]): PostingLine[] {
  if (lines.length === 0) throw new Error('No counter sheet sales to post');
  let total = new Decimal(0);
  let tax = new Decimal(0);
  for (const l of lines) {
    const amount = new Decimal(l.amount).toDecimalPlaces(2);
    if (amount.isNegative()) throw new Error('Negative counter sheet sale');
    const taxable = amount.div(new Decimal(l.taxRate).div(100).plus(1)).toDecimalPlaces(2);
    total = total.plus(amount);
    tax = tax.plus(amount.minus(taxable));
  }
  return buildVoucher<string>([dr('CASH', total), cr('SALES', total.minus(tax)), cr('OUTPUT_GST', tax)]);
}

/** Bill voided: exact reversal of the original sale voucher. */
export function billVoidedLines(original: PostingLine[]): PostingLine[] {
  const reversed = reverseLines(original);
  assertBalanced(reversed);
  return reversed;
}

export interface SupplierInvoiceItemInput {
  lineCostTotal: string;   // costPrice × quantity
  taxRate: string;         // GST %
}

/**
 * Supplier invoice approved (periodic inventory → PURCHASES):
 *   Dr PURCHASES                  sum(lineCostTotal)
 *   Dr PURCHASES_EXCISE_ROUNDING  MRP rounding off   (when printed)
 *   Dr EXCISE_TURNOVER_TAX        turnover tax       (when printed)
 *   Dr SPECIAL_EXCISE_CESS        special excise cess(when printed)
 *   Dr TCS_RECEIVABLE             TCS                (when printed)
 *       Cr SUNDRY_CREDITORS       everything above (= the depot's total debit)
 *
 * No INPUT_GST: alcohol for human consumption is outside GST, so there is no creditable input tax and the whole
 * cost is the purchase cost. (`taxRate` is still stored on the line; it is no longer used for posting.)
 * The creditor is credited with the sum of line costs plus the printed charges (not the free-typed invoice.totalAmount).
 */
export function supplierInvoiceLines(
  items: SupplierInvoiceItemInput[],
  mrpRoundingOff?: string | null,
  specialExciseCess?: string | null,
  tcsAmount?: string | null,
  turnoverTax?: string | null,
): PostingLine[] {
  if (items.length === 0) throw new Error('Supplier invoice has no items');
  let total = new Decimal(0);
  for (const item of items) {
    const lineTotal = new Decimal(item.lineCostTotal).toDecimalPlaces(2);
    if (lineTotal.isNegative()) throw new Error('Negative supplier line cost');
    total = total.plus(lineTotal);
  }

  // Liquor purchases carry no creditable input tax: the whole line cost is the purchase cost.
  const lines: RawPostingLine<string>[] = [
    dr('PURCHASES', total),
  ];

  if (mrpRoundingOff && new Decimal(mrpRoundingOff).gt(0)) {
    const rounding = new Decimal(mrpRoundingOff).toDecimalPlaces(2);
    lines.push(dr('PURCHASES_EXCISE_ROUNDING', rounding));
    total = total.plus(rounding);
  }

  if (turnoverTax && new Decimal(turnoverTax).gt(0)) {
    const tot = new Decimal(turnoverTax).toDecimalPlaces(2);
    lines.push(dr('EXCISE_TURNOVER_TAX', tot));
    total = total.plus(tot);
  }

  if (specialExciseCess && new Decimal(specialExciseCess).gt(0)) {
    const cess = new Decimal(specialExciseCess).toDecimalPlaces(2);
    lines.push(dr('SPECIAL_EXCISE_CESS', cess));
    total = total.plus(cess);
  }

  if (tcsAmount && new Decimal(tcsAmount).gt(0)) {
    const tcs = new Decimal(tcsAmount).toDecimalPlaces(2);
    lines.push(dr('TCS_RECEIVABLE', tcs));
    total = total.plus(tcs);
  }

  lines.push(cr('SUNDRY_CREDITORS', total));
  return buildVoucher<string>(lines);
}

/** Supplier e-Challan / DD advance payment to depot: Dr SUNDRY_CREDITORS, Cr BANK. */
export function supplierChallanPaymentLines(challanAmount: string): PostingLine[] {
  const amt = new Decimal(challanAmount).toDecimalPlaces(2);
  if (amt.lte(0)) throw new Error('Challan amount must be positive');
  return buildVoucher<string>([
    dr('SUNDRY_CREDITORS', amt),
    cr('BANK', amt),
  ]);
}

/** Credit (khata) repayment: Dr CASH | BANK, Cr SUNDRY_DEBTORS. */
export function creditRepaymentLines(input: { amount: string; paymentMode: string | null }): PostingLine[] {
  return buildVoucher<string>([
    dr(paymentLedgerCode(input.paymentMode ?? 'CASH', false), input.amount),
    cr('SUNDRY_DEBTORS', input.amount),
  ]);
}

/** Expense: Dr EXPENSE_<CATEGORY>, Cr CASH | BANK. */
export function expenseLines(input: { category: string; amount: string; paymentMode: string }): PostingLine[] {
  return buildVoucher<string>([
    dr(expenseLedgerCode(input.category), input.amount),
    cr(paymentLedgerCode(input.paymentMode, false), input.amount),
  ]);
}
