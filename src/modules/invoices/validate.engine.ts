/**
 * validate.engine.ts — PURE: arithmetic / plausibility checks on invoice lines and the invoice as a whole.
 * Produces flags only; it never "fixes" numbers except that the line amount used downstream is always qty × rate.
 */
import { Decimal } from 'decimal.js';

export const AMOUNT_TOLERANCE = new Decimal(1);       // ₹1
export const LOW_CONFIDENCE_THRESHOLD = 80;           // OCR line confidence (0-100)
export const PLACEHOLDER_PREFIX = 'DRAFT-';

/** Flags that only extraction can raise — kept across edits only while the line's numbers are unchanged. */
export const EXTRACTION_FLAGS = ['LOW_CONFIDENCE', 'UNREADABLE_NUMBER', 'VOLUME_DIFFERS'] as const;
/** Flags describing a conversion that happened at extraction — kept across edits. */
export const PROVENANCE_FLAGS = ['CASES_CONVERTED'] as const;

export interface LineToValidate {
  quantity: number | null;
  costPrice: string | null;
  mrp: string | null;
  extractedAmount: string | null;
  /** MRP of the matched catalog product (null when unmatched). */
  catalogMrp: string | null;
  confidence?: number | null;
  productId?: string | null;
  matchStatus?: string | null;
  /** Flags already raised (extraction / matching / conversion); validation flags are recomputed. */
  flags?: string[];
}

export interface ValidatedLine {
  flags: string[];
  /** qty × cost (2dp) — the amount that will be posted; '0.00' when qty or cost is missing. */
  lineCostTotal: string;
}

const VALIDATION_FLAGS = new Set([
  'AMOUNT_MISMATCH', 'COST_ABOVE_MRP', 'MRP_CHANGED', 'INCOMPLETE', 'UNMATCHED', 'NEEDS_CONFIRMATION',
]);

export function validateLine(line: LineToValidate): ValidatedLine {
  const flags = new Set((line.flags ?? []).filter((f) => !VALIDATION_FLAGS.has(f)));
  const qty = line.quantity;
  const cost = line.costPrice !== null ? new Decimal(line.costPrice) : null;
  const mrp = line.mrp !== null ? new Decimal(line.mrp) : null;

  // Review/approval need positive qty, cost and MRP (free goods go through the direct approval endpoint)
  if (qty === null || qty <= 0 || cost === null || cost.lte(0) || mrp === null || mrp.lte(0)) flags.add('INCOMPLETE');

  const computed = qty !== null && cost !== null ? cost.mul(qty).toDecimalPlaces(2, Decimal.ROUND_HALF_UP) : null;
  if (computed !== null && line.extractedAmount !== null
      && computed.minus(line.extractedAmount).abs().greaterThan(AMOUNT_TOLERANCE)) {
    flags.add('AMOUNT_MISMATCH');
  }
  if (cost !== null && mrp !== null && mrp.gt(0) && cost.gt(mrp)) flags.add('COST_ABOVE_MRP');
  if (mrp !== null && mrp.gt(0) && line.catalogMrp !== null && !mrp.equals(line.catalogMrp)) flags.add('MRP_CHANGED');
  if (line.confidence !== null && line.confidence !== undefined && line.confidence < LOW_CONFIDENCE_THRESHOLD) flags.add('LOW_CONFIDENCE');
  if (!line.productId) flags.add('UNMATCHED');
  else if (line.matchStatus === 'SUGGESTED') flags.add('NEEDS_CONFIRMATION');

  return { flags: [...flags], lineCostTotal: (computed ?? new Decimal(0)).toFixed(2) };
}

export interface InvoiceToValidate {
  invoiceNumber: string | null;
  invoiceDate?: string | null;
  supplierName?: string | null;
  capturedTotal: string | null;
  lineTotals: string[];
  duplicateFile?: boolean;
  totalUnreadable?: boolean;
  /** Header fields came from OCR → must be checked by a person. */
  headerFromOcr?: boolean;
  now?: Date;
}

export interface ValidatedInvoice {
  warnings: string[];
  computedTotal: string;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function formatInvoiceDate(dateInput: Date | string | null | undefined): string {
  if (!dateInput) {
    const today = new Date();
    return `${today.getDate()} ${MONTH_NAMES[today.getMonth()]} ${today.getFullYear()}`;
  }
  const d = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  if (Number.isNaN(d.getTime())) {
    const today = new Date();
    return `${today.getDate()} ${MONTH_NAMES[today.getMonth()]} ${today.getFullYear()}`;
  }
  return `${d.getDate()} ${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
}

export function normalizeInvoiceNumber(num: string | null | undefined): string {
  return (num ?? '').trim().toLowerCase();
}

export function formatDuplicateInvoiceMessage(invoiceNumber: string, date: Date | string | null | undefined): string {
  return `Invoice number ${invoiceNumber.trim()} has already been uploaded on ${formatInvoiceDate(date)}.`;
}

export function isPlaceholderNumber(invoiceNumber: string): boolean {
  return invoiceNumber.startsWith(PLACEHOLDER_PREFIX);
}

export function validateInvoice(inv: InvoiceToValidate): ValidatedInvoice {
  const warnings: string[] = [];
  const computed = inv.lineTotals.reduce((s, t) => s.plus(t), new Decimal(0));
  if (inv.capturedTotal !== null && computed.minus(inv.capturedTotal).abs().greaterThan(AMOUNT_TOLERANCE)) {
    warnings.push('TOTAL_MISMATCH');
  }
  if (inv.totalUnreadable) warnings.push('TOTAL_UNREADABLE');
  if (!inv.invoiceNumber || isPlaceholderNumber(inv.invoiceNumber)) warnings.push('INVOICE_NUMBER_MISSING');
  if (inv.supplierName !== undefined && !inv.supplierName?.trim()) warnings.push('SUPPLIER_MISSING');
  if (inv.invoiceDate) {
    const now = inv.now ?? new Date();
    if (new Date(inv.invoiceDate).getTime() > now.getTime() + 2 * 86_400_000) warnings.push('INVOICE_DATE_IN_FUTURE');
  }
  if (inv.duplicateFile) warnings.push('DUPLICATE_FILE');
  if (inv.headerFromOcr) warnings.push('HEADER_FROM_OCR');
  return { warnings, computedTotal: computed.toFixed(2) };
}

/** Summary counts of line flags for the invoice list. */
export function countFlags(lineFlags: string[][]): number {
  return lineFlags.reduce((n, f) => n + f.length, 0);
}
