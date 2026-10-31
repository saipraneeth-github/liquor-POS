/**
 * gst.engine.ts — Pure GST presentation logic for printed / generated bills.
 * Per-line tax stored on bill_items is authoritative; this derives taxable value, the
 * CGST/SGST (or IGST) split and the rate-wise summary that a GST invoice must show.
 */

import { Decimal } from 'decimal.js';
import { allocateDiscount } from './billing.engine.js';

export interface GstLineInput {
  name: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;   // quantity * unitPrice, BEFORE bill discount (tax-inclusive)
  taxRate: string;
  taxAmount: string;   // stored tax, computed after discount allocation
}

export interface GstLine extends GstLineInput {
  discountShare: string;
  net: string;         // lineTotal - discountShare (what the customer pays for the line)
  taxable: string;     // net - tax
  cgst: string;
  sgst: string;
  igst: string;
}

export interface GstRateSummary {
  rate: string;
  taxable: string;
  cgst: string;
  sgst: string;
  igst: string;
  tax: string;
}

export interface GstBreakdown {
  lines: GstLine[];
  summary: GstRateSummary[];
  totals: { taxable: string; cgst: string; sgst: string; igst: string; tax: string; net: string };
  interState: boolean;
}

/** Splits tax into two halves that always add back to the exact tax (SGST takes the odd paisa). */
export function splitTax(tax: Decimal, interState: boolean): { cgst: Decimal; sgst: Decimal; igst: Decimal } {
  if (interState) return { cgst: new Decimal(0), sgst: new Decimal(0), igst: tax };
  const cgst = tax.div(2).toDecimalPlaces(2, Decimal.ROUND_DOWN);
  return { cgst, sgst: tax.minus(cgst), igst: new Decimal(0) };
}

export function buildGstBreakdown(lines: GstLineInput[], discount = '0', interState = false): GstBreakdown {
  const shares = allocateDiscount(lines.map((l) => new Decimal(l.lineTotal)), new Decimal(discount));
  const zero = () => new Decimal(0);

  const out: GstLine[] = lines.map((l, i) => {
    const net = new Decimal(l.lineTotal).minus(shares[i]);
    const tax = new Decimal(l.taxAmount);
    const split = splitTax(tax, interState);
    return {
      ...l,
      discountShare: shares[i].toFixed(2),
      net: net.toFixed(2),
      taxable: net.minus(tax).toFixed(2),
      cgst: split.cgst.toFixed(2),
      sgst: split.sgst.toFixed(2),
      igst: split.igst.toFixed(2),
    };
  });

  const byRate = new Map<string, { taxable: Decimal; cgst: Decimal; sgst: Decimal; igst: Decimal; tax: Decimal }>();
  for (const l of out) {
    const key = new Decimal(l.taxRate).toFixed(2);
    const acc = byRate.get(key) ?? { taxable: zero(), cgst: zero(), sgst: zero(), igst: zero(), tax: zero() };
    acc.taxable = acc.taxable.plus(l.taxable);
    acc.cgst = acc.cgst.plus(l.cgst);
    acc.sgst = acc.sgst.plus(l.sgst);
    acc.igst = acc.igst.plus(l.igst);
    acc.tax = acc.tax.plus(l.taxAmount);
    byRate.set(key, acc);
  }

  const summary = [...byRate.entries()]
    .sort((a, b) => new Decimal(a[0]).comparedTo(b[0]))
    .map(([rate, v]) => ({
      rate,
      taxable: v.taxable.toFixed(2),
      cgst: v.cgst.toFixed(2),
      sgst: v.sgst.toFixed(2),
      igst: v.igst.toFixed(2),
      tax: v.tax.toFixed(2),
    }));

  const sum = (pick: (l: GstLine) => string) => out.reduce((s, l) => s.plus(pick(l)), zero()).toFixed(2);
  return {
    lines: out,
    summary,
    totals: {
      taxable: sum((l) => l.taxable),
      cgst: sum((l) => l.cgst),
      sgst: sum((l) => l.sgst),
      igst: sum((l) => l.igst),
      tax: sum((l) => l.taxAmount),
      net: sum((l) => l.net),
    },
    interState,
  };
}
