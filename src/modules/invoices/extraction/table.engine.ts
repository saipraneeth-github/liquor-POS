/**
 * table.engine.ts — PURE: rows of cells (from CSV / XLSX / rebuilt PDF/OCR text) → invoice lines.
 *
 * Finds the header row by column synonyms (or uses an explicit mapping), converts each data row to an
 * ExtractedLine, skips blank / sub-total / tax rows and captures the invoice total.
 */
import { parseMoney, parseQuantity, looksLikeGarbledNumber } from './numbers.js';
import type { ColumnMapping, ExtractedLine, InvoiceField, TableResult } from './types.js';
import { INVOICE_FIELDS } from './types.js';

const MAX_HEADER_SCAN = 30;

/** Normalises a header cell: lowercase, punctuation → space (keeps %), collapsed spaces. */
export function normaliseHeader(cell: string): string {
  return cell.toLowerCase().replace(/[^a-z0-9%]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Maps one header cell to a logical field (null = ignore column). Order matters. */
export function classifyHeader(cell: string): InvoiceField | null {
  const h = normaliseHeader(cell);
  if (!h) return null;
  const has = (re: RegExp) => re.test(h);
  if (has(/\b(s ?no|sl|sr|serial|hsn|sac|batch|uom|unit of measure|exp|expiry|mfg)\b/) && !has(/\b(description|item name|product name)\b/)) return null;
  if (has(/\b(gst|tax|igst|cgst|sgst|vat)\b/)) {
    if (has(/\b(amount|amt|value)\b/)) return null;                 // tax amount column — ignored
    if (has(/%|\b(rate|percent|pct)\b/) || h === 'gst' || h === 'tax') return 'taxRate';
    return null;
  }
  if (has(/\b(barcode|bar code|ean|upc|gtin)\b/)) return 'barcode';
  if (has(/\b(sku|item code|product code|code|item no|article)\b/)) return 'sku';
  if (has(/\bmrp\b|\bmax(imum)? retail\b/)) return 'mrp';
  if (has(/\b(cases?|cs|ctns?|cartons?|boxes)\b/) && !has(/\b(rate|price|cost|amount|amt|value)\b/)) return 'cases';
  if (has(/\b(qty|qnty|quantity|bottles?|btls?|nos|units|pcs)\b/)) return 'quantity';
  if (has(/\b(rate|cost|unit price|price|purchase rate|landing)\b/)) return 'rate';
  if (has(/\b(amount|amt|value|line total|total|net)\b/)) return 'amount';
  if (has(/\b(description|desc|item|items|product|products|particulars|brand|name|goods|article)\b/)) return 'description';
  return null;
}

/** Field → column index for one candidate header row (first occurrence wins). */
export function mapHeaderRow(cells: string[], classify: (c: string) => InvoiceField | null = classifyHeader): Partial<Record<InvoiceField, number>> {
  const map: Partial<Record<InvoiceField, number>> = {};
  cells.forEach((cell, idx) => {
    const f = classify(cell);
    if (f && map[f] === undefined) map[f] = idx;
  });
  return map;
}

/** A usable header needs a description column and at least two numeric columns. */
export function headerScore(map: Partial<Record<InvoiceField, number>>): number {
  if (map.description === undefined) return 0;
  const numeric = (['quantity', 'cases', 'rate', 'mrp', 'amount'] as InvoiceField[]).filter((f) => map[f] !== undefined).length;
  if (numeric < 2) return 0;
  return Object.keys(map).length;
}

export function findHeaderRow(rows: string[][]): { index: number; columns: Partial<Record<InvoiceField, number>> } | null {
  let best: { index: number; columns: Partial<Record<InvoiceField, number>>; score: number } | null = null;
  for (let i = 0; i < Math.min(rows.length, MAX_HEADER_SCAN); i++) {
    const columns = mapHeaderRow(rows[i]);
    const score = headerScore(columns);
    if (score > 0 && (!best || score > best.score)) best = { index: i, columns, score };
  }
  return best ? { index: best.index, columns: best.columns } : null;
}

/** Applies an explicit mapping (indices or header texts) on top of the detected one. */
export function applyMapping(
  rows: string[][],
  detected: { index: number; columns: Partial<Record<InvoiceField, number>> } | null,
  mapping: ColumnMapping,
): { index: number; columns: Partial<Record<InvoiceField, number>> } {
  let headerIndex = detected?.index ?? -1;
  const columns: Partial<Record<InvoiceField, number>> = { ...(detected?.columns ?? {}) };
  const byName = Object.values(mapping).filter((v): v is string => typeof v === 'string').map(normaliseHeader);
  if (byName.length > 0 && headerIndex < 0) {
    headerIndex = rows.slice(0, MAX_HEADER_SCAN).findIndex((r) => byName.some((n) => r.some((c) => normaliseHeader(c) === n)));
  }
  for (const field of INVOICE_FIELDS) {
    const v = mapping[field];
    if (v === undefined) continue;
    if (typeof v === 'number') {
      columns[field] = v;
    } else if (headerIndex >= 0) {
      const idx = rows[headerIndex].findIndex((c) => normaliseHeader(c) === normaliseHeader(v));
      if (idx >= 0) columns[field] = idx;
    }
    // A column may serve only one field: drop other fields pointing at the same column
    for (const other of INVOICE_FIELDS) {
      if (other !== field && columns[other] !== undefined && columns[other] === columns[field]) delete columns[other];
    }
  }
  if (headerIndex < 0 && rows.length > 1) {
    const numCols = (['quantity', 'cases', 'rate', 'mrp', 'amount'] as InvoiceField[])
      .map((f) => columns[f]).filter((c): c is number => c !== undefined);
    if (numCols.length > 0 && numCols.every((c) => {
      const raw = (rows[0]?.[c] ?? '').trim();
      return !raw || (parseMoney(raw) === null && parseQuantity(raw) === null && !looksLikeGarbledNumber(raw));
    })) {
      headerIndex = 0;
    }
  }
  return { index: headerIndex, columns };
}

// ─── SUMMARY ROWS ─────────────────────────────────────────────────────────────

const TOTAL_RANK: Array<[RegExp, number]> = [
  [/^(grand total|net total|net amount|net payable|invoice total|invoice value|total amount|amount payable|bill amount|total invoice)/, 3],
  [/^total\b/, 2],
  [/^(sub ?total|total before)/, 1],
];
const NON_ITEM_ROW = /^(round(ing)? ?off|cgst|sgst|igst|gst|tax|vat|cess|tcs|tds|discount|freight|transport|less|add|e ?& ?o ?e|amount in words|rupees)\b/;

/** Returns the total "rank" (1 sub-total … 3 grand total) if the row is a total row, 0 if non-item summary, -1 if item row. */
export function classifySummaryRow(texts: string[]): number {
  for (const t of texts) {
    const n = normaliseHeader(t);
    if (!n) continue;
    for (const [re, rank] of TOTAL_RANK) if (re.test(n)) return rank;
    if (NON_ITEM_ROW.test(n)) return 0;
  }
  return -1;
}

// ─── ROWS → LINES ─────────────────────────────────────────────────────────────

function cellAt(row: string[], idx: number | undefined): string {
  return idx === undefined ? '' : (row[idx] ?? '').trim();
}

function lastNumericCell(row: string[]): { value: string | null; garbled: boolean } {
  for (let i = row.length - 1; i >= 0; i--) {
    const c = (row[i] ?? '').trim();
    if (!c) continue;
    const m = parseMoney(c);
    if (m !== null) return { value: m, garbled: false };
    if (looksLikeGarbledNumber(c)) return { value: null, garbled: true };
  }
  return { value: null, garbled: false };
}

/**
 * Converts rows to invoice lines. `mapping` overrides detected columns.
 * Without a usable header (and no mapping) returns no lines.
 */
export function rowsToLines(rows: string[][], mapping?: ColumnMapping): TableResult {
  const detected = findHeaderRow(rows);
  const header = mapping && Object.keys(mapping).length > 0 ? applyMapping(rows, detected, mapping) : detected;
  const result: TableResult = { lines: [], capturedTotal: null, totalUnreadable: false, headerRowIndex: header?.index ?? null, columns: header?.columns ?? {} };
  if (!header || header.columns.description === undefined) return result;

  const cols = header.columns;
  let totalRank = 0;
  let lineNumber = 0;

  for (let r = header.index + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((c) => !c || !c.trim())) continue;
    // Repeated header (multi-page exports)
    if (headerScore(mapHeaderRow(row)) > 0) continue;

    const description = cellAt(row, cols.description);
    // Label of a summary row sits in the description column, or (when that is empty) in any text cell
    const summary = classifySummaryRow(description ? [description] : row.filter((c) => c && parseMoney(c) === null));
    if (summary >= 0) {
      if (summary > 0 && summary >= totalRank) {
        const amountCell = cellAt(row, cols.amount);
        const fromAmount = amountCell ? parseMoney(amountCell) : null;
        const fallback = fromAmount === null ? lastNumericCell(row) : { value: fromAmount, garbled: false };
        if (fallback.value !== null) {
          result.capturedTotal = fallback.value;
          result.totalUnreadable = false;
          totalRank = summary;
        } else if (fallback.garbled || (amountCell && looksLikeGarbledNumber(amountCell))) {
          result.totalUnreadable = true;
        }
      }
      continue;
    }

    const flags: string[] = [];
    const num = (field: InvoiceField, parse: (s: string) => string | number | null) => {
      const raw = cellAt(row, cols[field]);
      if (!raw) return null;
      const v = parse(raw);
      if (v === null && !flags.includes('UNREADABLE_NUMBER')) flags.push('UNREADABLE_NUMBER');
      return v;
    };
    const quantity = num('quantity', parseQuantity) as number | null;
    const cases = num('cases', parseQuantity) as number | null;
    const rate = num('rate', parseMoney) as string | null;
    const mrp = num('mrp', parseMoney) as string | null;
    const amount = num('amount', parseMoney) as string | null;
    const taxRate = num('taxRate', (s) => parseMoney(s.replace(/%$/, ''))) as string | null;

    // Not an item: no description and no quantities/amount
    if (!description && quantity === null && cases === null && amount === null) continue;
    if (description && quantity === null && cases === null && rate === null && amount === null && mrp === null && flags.length === 0) continue;

    const barcodeRaw = cellAt(row, cols.barcode).replace(/\s/g, '');
    result.lines.push({
      lineNumber: ++lineNumber,
      description: description || '(no description)',
      barcode: /^\d{6,14}$/.test(barcodeRaw) ? barcodeRaw : null,
      sku: cellAt(row, cols.sku) || null,
      quantity,
      cases,
      rate,
      mrp,
      amount,
      taxRate,
      confidence: null,
      flags,
    });
  }
  return result;
}
