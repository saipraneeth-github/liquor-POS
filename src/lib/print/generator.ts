// src/lib/print/generator.ts
// Builds printable documents (customer bill, kitchen/bar order ticket) as a neutral list of rows,
// then renders them as ESC/POS bytes, plain text, or HTML. Pure — no DB or network access.
import { EscPosBuilder } from './escpos.js';
import { buildGstBreakdown, type GstBreakdown } from '../../modules/billing/gst.engine.js';

// ─── MODELS ─────────────────────────────────────────────────────────────────

export interface PrintItem {
  name: string;          // includes the serving, e.g. "Single Malt 750ml (60 ml)"
  qty: number;
  rate: number;          // unit rate, tax-inclusive
  net: number;           // line amount before bill discount
  taxRate?: number;      // GST %
  taxAmount?: number;
  hsn?: string;
}

export interface PrintBill {
  branchName: string;
  branchAddress: string;
  gstin?: string;
  billNumber: string;
  date: string;
  cashierName: string;
  customerName?: string;
  buyerGstin?: string;           // B2B invoice
  roundOff?: number;             // + rounded up, - rounded down
  items: PrintItem[];
  subtotal: number;
  discount: number;
  taxAmount: number;
  total: number;
  paymentMode: string;
  voided?: boolean;
  interState?: boolean;          // IGST instead of CGST + SGST
  paperWidth?: '58mm' | '80mm';  // defaults to 58mm
}

export interface PrintKot {
  branchName: string;
  kotNumber: string;
  tableName: string;
  destination: 'KITCHEN' | 'BAR';
  steward: string;
  date: string;
  notes?: string;
  items: { name: string; qty: number; notes?: string }[];
  paperWidth?: '58mm' | '80mm';
}

export type Row =
  | { t: 'center'; text: string; bold?: boolean; big?: boolean }
  | { t: 'pair'; l: string; r: string; bold?: boolean }
  | { t: 'cols'; cells: string[]; widths: number[]; bold?: boolean }
  | { t: 'text'; text: string; bold?: boolean; big?: boolean }
  | { t: 'sep'; ch: string }
  | { t: 'feed' };

export const widthChars = (paper?: '58mm' | '80mm') => (paper === '80mm' ? 48 : 32);

const money = (n: number | string) => Number(n).toFixed(2);

function fit(text: string, len: number): string {
  return text.length > len ? text.slice(0, len) : text;
}

// ─── DOCUMENT BUILDERS ──────────────────────────────────────────────────────

export function buildGstFromBill(bill: PrintBill): GstBreakdown {
  return buildGstBreakdown(
    bill.items.map((i) => ({
      name: i.name,
      quantity: i.qty,
      unitPrice: money(i.rate),
      lineTotal: money(i.net),
      taxRate: money(i.taxRate ?? 0),
      taxAmount: money(i.taxAmount ?? 0),
    })),
    money(bill.discount),
    !!bill.interState,
  );
}

export function buildBillRows(bill: PrintBill): Row[] {
  const w = widthChars(bill.paperWidth);
  const wide = w >= 48;
  const gst = buildGstFromBill(bill);
  const rows: Row[] = [];

  rows.push({ t: 'center', text: bill.branchName, bold: true, big: true });
  if (bill.branchAddress) rows.push({ t: 'center', text: bill.branchAddress });
  rows.push({ t: 'center', text: `GSTIN: ${bill.gstin || 'NOT AVAILABLE'}` });
  rows.push({ t: 'center', text: bill.voided ? '*** VOID ***' : 'TAX INVOICE', bold: true });
  rows.push({ t: 'sep', ch: '=' });
  rows.push({ t: 'text', text: `Bill No: ${bill.billNumber}` });
  rows.push({ t: 'text', text: `Date: ${bill.date}` });
  rows.push({ t: 'text', text: `Cashier: ${bill.cashierName}` });
  if (bill.customerName) rows.push({ t: 'text', text: `Customer: ${bill.customerName}` });
  if (bill.buyerGstin) rows.push({ t: 'text', text: `Buyer GSTIN: ${bill.buyerGstin}` });
  rows.push({ t: 'sep', ch: '-' });

  // Items: name line, then qty x rate / amount, then the GST split for that line
  const qtyW = wide ? 6 : 5;
  const amtW = wide ? 12 : 9;
  rows.push({ t: 'cols', cells: ['Item', 'Qty', 'Amount'], widths: [w - qtyW - amtW, qtyW, amtW], bold: true });
  rows.push({ t: 'sep', ch: '-' });
  for (const [idx, line] of gst.lines.entries()) {
    rows.push({ t: 'text', text: fit(line.name, w) });
    rows.push({
      t: 'cols',
      cells: [`  @${money(line.unitPrice)}`, String(line.quantity), money(line.net)],
      widths: [w - qtyW - amtW, qtyW, amtW],
    });
    const rate = Number(line.taxRate);
    const split = bill.interState
      ? `IGST ${money(line.igst)}`
      : `CGST ${money(line.cgst)} SGST ${money(line.sgst)}`;
    const hsn = bill.items[idx].hsn;
    rows.push({ t: 'text', text: fit(`  ${hsn ? `HSN ${hsn}  ` : ''}Taxable ${money(line.taxable)}`, w) });
    rows.push({ t: 'text', text: fit(`  GST ${rate}%: ${split}`, w) });
    if (idx < gst.lines.length - 1) rows.push({ t: 'feed' });
  }
  rows.push({ t: 'sep', ch: '-' });

  // Totals
  rows.push({ t: 'pair', l: 'Gross (incl. GST)', r: money(bill.subtotal) });
  if (bill.discount > 0) rows.push({ t: 'pair', l: 'Discount', r: `-${money(bill.discount)}` });
  rows.push({ t: 'pair', l: 'Taxable value', r: gst.totals.taxable });
  if (bill.interState) {
    rows.push({ t: 'pair', l: 'IGST', r: gst.totals.igst });
  } else {
    rows.push({ t: 'pair', l: 'CGST', r: gst.totals.cgst });
    rows.push({ t: 'pair', l: 'SGST', r: gst.totals.sgst });
  }
  rows.push({ t: 'pair', l: 'Total GST', r: gst.totals.tax });
  if (bill.roundOff) rows.push({ t: 'pair', l: 'Round off', r: `${bill.roundOff > 0 ? '+' : '-'}${money(Math.abs(bill.roundOff))}` });
  rows.push({ t: 'sep', ch: '-' });
  rows.push({ t: 'pair', l: 'TOTAL', r: money(bill.total), bold: true });
  rows.push({ t: 'sep', ch: '-' });

  // Rate-wise tax summary
  const c = wide ? [8, 14, 13, 13] : [6, 9, 8, 9];
  const third = bill.interState ? 'IGST' : 'CGST';
  const fourth = bill.interState ? '' : 'SGST';
  rows.push({ t: 'cols', cells: ['GST%', 'Taxable', third, fourth], widths: c, bold: true });
  for (const s of gst.summary) {
    rows.push({
      t: 'cols',
      cells: [s.rate, s.taxable, bill.interState ? s.igst : s.cgst, bill.interState ? '' : s.sgst],
      widths: c,
    });
  }
  rows.push({ t: 'sep', ch: '-' });
  rows.push({ t: 'pair', l: 'Payment', r: bill.paymentMode });
  rows.push({ t: 'center', text: 'Prices include GST. Thank you!' });
  rows.push({ t: 'feed' });
  return rows;
}

export function buildKotRows(kot: PrintKot): Row[] {
  const rows: Row[] = [];
  rows.push({ t: 'center', text: `${kot.destination} ORDER`, bold: true, big: true });
  rows.push({ t: 'center', text: kot.branchName });
  rows.push({ t: 'sep', ch: '=' });
  rows.push({ t: 'text', text: `KOT: ${kot.kotNumber}`, bold: true });
  rows.push({ t: 'text', text: `Table: ${kot.tableName}`, bold: true, big: true });
  rows.push({ t: 'text', text: `Steward: ${kot.steward}` });
  rows.push({ t: 'text', text: `Time: ${kot.date}` });
  rows.push({ t: 'sep', ch: '-' });
  for (const i of kot.items) {
    rows.push({ t: 'text', text: `${i.qty} x ${i.name}`, bold: true, big: true });
    if (i.notes) rows.push({ t: 'text', text: `   * ${i.notes}` });
  }
  if (kot.notes) {
    rows.push({ t: 'sep', ch: '-' });
    rows.push({ t: 'text', text: `Note: ${kot.notes}` });
  }
  rows.push({ t: 'sep', ch: '=' });
  rows.push({ t: 'feed' });
  return rows;
}

/** Short ticket used by "Test print" in the branch printer settings. */
export function buildTestRows(branchName: string, paper?: '58mm' | '80mm', host?: string | null): Row[] {
  return [
    { t: 'center', text: 'PRINTER TEST', bold: true, big: true },
    { t: 'center', text: branchName },
    { t: 'sep', ch: '=' },
    { t: 'text', text: `Paper: ${paper ?? '58mm'} (${widthChars(paper)} columns)` },
    ...(host ? [{ t: 'text' as const, text: `Printer: ${host}` }] : []),
    { t: 'text', text: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' },
    { t: 'sep', ch: '-' },
    { t: 'center', text: 'If you can read this, printing works.' },
    { t: 'feed' },
  ];
}

// ─── RENDERERS ──────────────────────────────────────────────────────────────

const padR = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));
const padL = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : ' '.repeat(n - s.length) + s);

function formatRow(row: Row, width: number): string[] {
  switch (row.t) {
    case 'sep':
      return [row.ch.repeat(width)];
    case 'feed':
      return [''];
    case 'center':
      return wrap(row.text, width).map((l) => ' '.repeat(Math.max(0, Math.floor((width - l.length) / 2))) + l);
    case 'text':
      return wrap(row.text, width);
    case 'pair': {
      const gap = Math.max(1, width - row.l.length - row.r.length);
      return [fit(row.l + ' '.repeat(gap) + row.r, width)];
    }
    case 'cols':
      return [row.cells.map((c, i) => (i === 0 ? padR(c, row.widths[i]) : padL(c, row.widths[i]))).join('')];
  }
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(' ', width);
    if (cut <= 0) cut = width;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  out.push(rest);
  return out;
}

export function renderText(rows: Row[], width: number): string {
  return rows.flatMap((r) => formatRow(r, width)).join('\n') + '\n';
}

export function renderHtml(rows: Row[], width: number, title: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = rows
    .flatMap((r) => {
      const lines = formatRow(r, width).map(esc);
      const bold = 'bold' in r && r.bold;
      const big = 'big' in r && r.big;
      return lines.map((l) => (bold || big ? `<b${big ? ' class="big"' : ''}>${l}</b>` : l));
    })
    .join('\n');
  const mm = width >= 48 ? 80 : 58;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>@page{size:${mm}mm auto;margin:2mm}body{margin:0;width:${mm}mm}
pre{font:11px/1.25 "Courier New",monospace;margin:0;white-space:pre}.big{font-size:14px}</style></head>
<body><pre>${body}</pre></body></html>`;
}

export function renderEscPos(rows: Row[], width: number, opts: { cut?: boolean; kickDrawer?: boolean } = {}): Uint8Array {
  const b = new EscPosBuilder(width);
  for (const row of rows) {
    const bold = 'bold' in row && row.bold;
    const big = 'big' in row && row.big;
    if (bold) b.boldOn();
    if (big) b.size(0, 1);
    for (const line of formatRow(row, width)) b.addLine(line);
    if (big) b.size(0, 0);
    if (bold) b.boldOff();
  }
  b.addLine().addLine();
  if (opts.cut !== false) b.cut();
  if (opts.kickDrawer) b.kickDrawer();
  return b.build();
}

// ─── CONVENIENCE ────────────────────────────────────────────────────────────

/** ESC/POS bytes for a customer bill (kept for callers of the original API). */
export function generateReceiptBuffer(bill: PrintBill): Uint8Array {
  return renderEscPos(buildBillRows(bill), widthChars(bill.paperWidth), { kickDrawer: bill.paymentMode === 'CASH' });
}

export function generateKotBuffer(kot: PrintKot): Uint8Array {
  return renderEscPos(buildKotRows(kot), widthChars(kot.paperWidth));
}
