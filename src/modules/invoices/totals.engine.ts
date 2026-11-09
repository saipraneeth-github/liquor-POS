/**
 * totals.engine.ts — PURE: reconciliation of the totals block printed on a Telangana ICDC challan.
 *
 * The printed numbers form a chain, so every figure we store can be proven (or a misread caught) by arithmetic:
 *   1. Σ line amounts                         = Invoice Value
 *   2. Invoice Value + MRP Rounding Off       = Net Invoice Value  ( = "(-)Less this Invoice Value")
 *   3. Previous Credit + e-challan/DD Amount  = Sub Total
 *   4. Sub Total − Net − Turnover Tax − Special Excise Cess − TCS = Retailer Credit Balance
 * A check is only run when every figure it needs is present; a chain that cannot be verified is reported as
 * `TOTALS_UNVERIFIED` (a warning), a chain that is verifiably broken blocks approval — the figures are posted to the
 * books (purchase voucher, e-challan payment voucher), so they must be right.
 */
import { Decimal } from 'decimal.js';

export interface TotalsBlock {
  /** Σ of the line amounts as stored on the draft. */
  linesSum: string;
  /** "Invoice Value" printed under the item table. */
  invoiceValue: string | null;
  mrpRoundingOff: string | null;
  netInvoiceValue: string | null;
  turnoverTax: string | null;
  specialExciseCess: string | null;
  tcsAmount: string | null;
  previousCredit: string | null;
  challanAmount: string | null;
  subTotal: string | null;
  retailerCreditBalance: string | null;
}

export interface TotalsCheck {
  code: 'LINES_TOTAL_MISMATCH' | 'NET_VALUE_MISMATCH' | 'SUBTOTAL_MISMATCH' | 'BALANCE_MISMATCH';
  label: string;
  /** What the other figures say it should be. */
  expected: string | null;
  /** What is printed / stored. */
  actual: string | null;
  difference: string | null;
  status: 'OK' | 'FAIL' | 'SKIPPED';
}

export interface TotalsReconciliation {
  checks: TotalsCheck[];
  /** Warning codes to store on the invoice (failed checks + TOTALS_UNVERIFIED). */
  warnings: string[];
}

/** Warnings that prevent review/approval until the figures are corrected. */
export const BLOCKING_TOTALS_WARNINGS = ['LINES_TOTAL_MISMATCH', 'NET_VALUE_MISMATCH', 'SUBTOTAL_MISMATCH', 'BALANCE_MISMATCH'] as const;
export const TOTALS_WARNINGS = [...BLOCKING_TOTALS_WARNINGS, 'TOTALS_UNVERIFIED'] as const;

const LINES_TOLERANCE = new Decimal('1.00');   // printed line amounts are each rounded to the paisa
const CHAIN_TOLERANCE = new Decimal('0.05');

const dec = (v: string | null | undefined) => (v === null || v === undefined || v === '' ? null : new Decimal(v));

function run(
  code: TotalsCheck['code'], label: string, expected: Decimal | null, actual: Decimal | null, tolerance: Decimal,
): TotalsCheck {
  if (expected === null || actual === null) return { code, label, expected: expected?.toFixed(2) ?? null, actual: actual?.toFixed(2) ?? null, difference: null, status: 'SKIPPED' };
  const diff = actual.minus(expected);
  return { code, label, expected: expected.toFixed(2), actual: actual.toFixed(2), difference: diff.toFixed(2), status: diff.abs().lte(tolerance) ? 'OK' : 'FAIL' };
}

export function reconcileTotalsBlock(b: TotalsBlock): TotalsReconciliation {
  const invoiceValue = dec(b.invoiceValue);
  const rounding = dec(b.mrpRoundingOff);
  const net = dec(b.netInvoiceValue);
  const prev = dec(b.previousCredit);
  const challan = dec(b.challanAmount) ?? (prev !== null ? new Decimal(0) : null);
  const sub = dec(b.subTotal);
  const balance = dec(b.retailerCreditBalance);
  const tot = dec(b.turnoverTax) ?? new Decimal(0);
  const cess = dec(b.specialExciseCess) ?? new Decimal(0);
  const tcs = dec(b.tcsAmount) ?? new Decimal(0);

  const checks: TotalsCheck[] = [
    run('LINES_TOTAL_MISMATCH', 'Sum of lines = Invoice Value', invoiceValue, new Decimal(b.linesSum), LINES_TOLERANCE),
    run('NET_VALUE_MISMATCH', 'Invoice Value + MRP Rounding Off = Net Invoice Value',
      invoiceValue !== null && rounding !== null ? invoiceValue.plus(rounding) : null, net, CHAIN_TOLERANCE),
    run('SUBTOTAL_MISMATCH', 'Previous Credit + e-challan/DD = Sub Total',
      prev !== null && challan !== null ? prev.plus(challan) : null, sub, CHAIN_TOLERANCE),
    run('BALANCE_MISMATCH', 'Sub Total − Net − Turnover Tax − Cess − TCS = Retailer Credit Balance',
      sub !== null && net !== null ? sub.minus(net).minus(tot).minus(cess).minus(tcs) : null, balance, CHAIN_TOLERANCE),
  ];

  const warnings: string[] = checks.filter((c) => c.status === 'FAIL').map((c) => c.code);
  if (checks.some((c) => c.status === 'SKIPPED')) warnings.push('TOTALS_UNVERIFIED');
  return { checks, warnings };
}
