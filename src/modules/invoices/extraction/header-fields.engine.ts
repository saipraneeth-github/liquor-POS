/**
 * header-fields.engine.ts — PURE: free text lines → invoice number, date, supplier name, GSTIN.
 */
import type { ExtractedHeader } from './types.js';

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

export const GSTIN_RE = /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/;

function iso(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Finds the first valid date in `text`: dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy, yyyy-mm-dd, dd MMM yyyy, dd-MMM-yy. */
export function parseDateText(text: string): string | null {
  let m: RegExpMatchArray | null;
  const ymd = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g;
  while ((m = ymd.exec(text))) { const r = iso(+m[1], +m[2], +m[3]); if (r) return r; }
  const dmy = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})\b/g;
  while ((m = dmy.exec(text))) { const r = iso(+m[3], +m[2], +m[1]); if (r) return r; }
  const dMy = /\b(\d{1,2})(?:st|nd|rd|th)?[\s\-/.,]*([A-Za-z]{3,9})[\s\-/.,]*(\d{4}|\d{2})\b/g;
  while ((m = dMy.exec(text))) {
    const mon = MONTHS[m[2].toLowerCase().slice(0, m[2].toLowerCase().startsWith('sept') ? 4 : 3)];
    if (mon) { const r = iso(+m[3], mon, +m[1]); if (r) return r; }
  }
  return null;
}

const INVOICE_NO_RES = [
  /\b(?:invoice|inv|bill)\s*(?:no|number|num|#)\.?\s*[:#\-]?\s*([A-Z0-9][A-Z0-9\-/]{1,40})/i,
  /\b(?:invoice|inv|bill)\s*[:#]\s*([A-Z0-9][A-Z0-9\-/]{1,40})/i,
  /\b(?:invoice|inv|bill)\b[^\n:]{0,20}?\bno\.?\s*[:#\-]?\s*([A-Z0-9][A-Z0-9\-/]{1,40})/i,
];

export function findInvoiceNumber(lines: string[]): string | null {
  for (const re of INVOICE_NO_RES) {
    for (const line of lines) {
      const m = line.match(re);
      if (m && /\d/.test(m[1]) && !/^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(m[1])) return m[1].replace(/[-/]+$/, '');
    }
  }
  return null;
}

const SUPPLIER_RE = /\b(?:supplier|supplied by|sold by|vendor|seller|from|m\/s\.?)\s*(?:name)?\s*[:\-]\s*(.+)$/i;
const TRIVIAL_LINE = /\b(tax invoice|invoice|bill of supply|original|duplicate|triplicate|date|gstin|phone|ph|mobile|email|page|to|buyer|bill to|ship to|customer)\b/i;

function cleanName(s: string): string {
  return s.split(/\s{2,}|\t|\|/)[0].replace(/[,;:\-]+$/, '').trim().slice(0, 120);
}

export function findSupplierName(lines: string[], fallbackLimit = 8): string | null {
  for (const line of lines) {
    const m = line.match(SUPPLIER_RE);
    if (m) { const n = cleanName(m[1]); if (/[A-Za-z]{2}/.test(n)) return n; }
  }
  for (const line of lines.slice(0, Math.min(8, fallbackLimit))) {
    const t = line.trim();
    const letters = (t.match(/[A-Za-z]/g) ?? []).length;
    if (letters < 4 || letters / t.length < 0.5 || TRIVIAL_LINE.test(t) || GSTIN_RE.test(t)) continue;
    return cleanName(t);
  }
  return null;
}

/**
 * Extracts header fields from document text lines (top to bottom). `tableStart` = index of the table header line:
 * the "first non-trivial line" supplier fallback only looks above it (never at item rows).
 */
export function extractHeaderFields(lines: string[], tableStart = lines.length): ExtractedHeader {
  const nonEmptyBefore = lines.slice(0, tableStart).filter((l) => l.trim()).length;
  const clean = lines.map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
  const dateLines = clean.filter((l) => /\bdate[d]?\b|\bdt\b/i.test(l));
  const gstin = clean.map((l) => l.toUpperCase().match(GSTIN_RE)?.[0]).find(Boolean) ?? null;
  return {
    invoiceNumber: findInvoiceNumber(clean),
    invoiceDate: parseDateText(dateLines.join('\n')) ?? parseDateText(clean.slice(0, 15).join('\n')),
    supplierName: findSupplierName(clean, nonEmptyBefore),
    gstin,
  };
}
