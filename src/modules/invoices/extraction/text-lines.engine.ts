/**
 * text-lines.engine.ts — PURE: plain text lines (PDF text layer or OCR output) → rows of cells for table.engine.
 *
 * OCR collapses column spacing and misreads characters, so columns are recovered from the NUMERIC TAIL of each
 * line (qty / rate / mrp / amount sit at the end of an item line) aligned with the numeric columns of the header.
 * Header words are matched fuzzily ("Oty" → Qty, "[tem" → Item). Unreadable numbers are kept (not guessed) so the
 * table engine flags them.
 */
import { classifyHeader, normaliseHeader } from './table.engine.js';
import { parseMoney, looksLikeGarbledNumber } from './numbers.js';
import type { InvoiceField } from './types.js';

const NUMERIC_FIELDS: InvoiceField[] = ['quantity', 'cases', 'rate', 'mrp', 'amount', 'taxRate'];
const HEADER_WORDS: Array<[string, InvoiceField]> = [
  ['item', 'description'], ['description', 'description'], ['product', 'description'], ['particulars', 'description'],
  ['brand', 'description'], ['qty', 'quantity'], ['quantity', 'quantity'], ['bottles', 'quantity'], ['btls', 'quantity'],
  ['cases', 'cases'], ['rate', 'rate'], ['price', 'rate'], ['cost', 'rate'], ['mrp', 'mrp'], ['amount', 'amount'],
  ['value', 'amount'], ['total', 'amount'], ['barcode', 'barcode'], ['ean', 'barcode'], ['sku', 'sku'], ['code', 'sku'],
];

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

/** Header word classification tolerant to one OCR character error (only for words of 3+ letters). */
export function classifyHeaderWordFuzzy(word: string): InvoiceField | null {
  const exact = classifyHeader(word);
  if (exact) return exact;
  const w = normaliseHeader(word).replace(/\s/g, '');
  if (w.length < 3) return null;
  for (const [syn, field] of HEADER_WORDS) {
    if (Math.abs(syn.length - w.length) <= 1 && editDistance(w, syn) <= 1) return field;
  }
  return null;
}

/** Splits a header line into (field, position) pairs, merging two-word headers like "unit price", "item code". */
export function parseHeaderLine(line: string): InvoiceField[] {
  const words = line.trim().split(/\s+/);
  const fields: InvoiceField[] = [];
  for (let i = 0; i < words.length; i++) {
    const pair = i + 1 < words.length ? classifyHeader(`${words[i]} ${words[i + 1]}`) : null;
    const single = classifyHeaderWordFuzzy(words[i]);
    const nextSingle = i + 1 < words.length ? classifyHeaderWordFuzzy(words[i + 1]) : null;
    // "Unit Price", "Item Code", "Line Total": the pair means something the words alone don't
    if (pair && pair !== single && (single === null || nextSingle === null || pair !== nextSingle)) {
      if (!fields.includes(pair)) fields.push(pair);
      i++;
      continue;
    }
    if (single && !fields.includes(single)) fields.push(single);
  }
  return fields;
}

function isHeaderFields(fields: InvoiceField[]): boolean {
  return fields.includes('description') && fields.filter((f) => NUMERIC_FIELDS.includes(f)).length >= 2;
}

export const GARBLED_PREFIX = '?';

function numericToken(tok: string): 'num' | 'garbled' | null {
  if (parseMoney(tok) !== null) return 'num';
  if (looksLikeGarbledNumber(tok)) return 'garbled';
  return null;
}

/**
 * Splits an item line into [leading codes..., description, ...numeric tail (max `n` tokens)].
 * Garbled numeric tokens are kept verbatim (table.engine marks them UNREADABLE_NUMBER).
 */
export function splitNumericTail(line: string, n: number): { description: string; tail: string[]; barcode: string | null } {
  const tokens = line.trim().replace(/\s+([%])/g, '$1').split(/\s+/).filter(Boolean);
  const tail: string[] = [];
  while (tokens.length > 0 && tail.length < n) {
    const t = tokens[tokens.length - 1].replace(/^[|[\]]+|[|[\]]+$/g, '');
    const kind = numericToken(t.replace(/%$/, ''));
    if (!kind) break;
    // keep at least one word of description
    if (tokens.length === 1 && tail.length > 0 && kind === 'num' && /^\d+$/.test(t)) break;
    tail.unshift(t);
    tokens.pop();
  }
  let barcode: string | null = null;
  if (tokens.length > 1 && /^\d{8,14}$/.test(tokens[0])) barcode = tokens.shift()!;
  return { description: tokens.join(' '), tail, barcode };
}

export interface TextRows {
  rows: string[][];
  headerFound: boolean;
  /** Index (in the non-empty input lines) of the table header line, -1 when none. */
  headerLineIndex: number;
}

/** Text lines → rows: [barcode, description, ...numeric columns] with a synthesized header row first. */
export function textLinesToRows(lines: string[]): TextRows {
  const clean = lines.map((l) => l.replace(/\t/g, '  ').trimEnd()).filter((l) => l.trim());
  let headerIdx = -1;
  let fields: InvoiceField[] = [];
  for (let i = 0; i < clean.length; i++) {
    const f = parseHeaderLine(clean[i]);
    if (isHeaderFields(f) && f.length > fields.length) { headerIdx = i; fields = f; }
  }
  const headerFound = headerIdx >= 0;
  const numericCols: InvoiceField[] = headerFound
    ? fields.filter((f) => NUMERIC_FIELDS.includes(f))
    : ['quantity', 'rate', 'mrp', 'amount'];
  const headerLabel: Record<InvoiceField, string> = {
    description: 'Description', quantity: 'Qty', cases: 'Cases', rate: 'Rate', mrp: 'MRP', amount: 'Amount',
    barcode: 'Barcode', sku: 'SKU', taxRate: 'GST %',
  };
  const rows: string[][] = [['Barcode', 'Description', ...numericCols.map((f) => headerLabel[f])]];

  for (let i = headerIdx + 1; i < clean.length; i++) {
    const { description, tail, barcode } = splitNumericTail(clean[i], numericCols.length);
    if (tail.length === 0 || (!headerFound && tail.length < 2 && !/\b(total|amount|payable)\b/i.test(description))) {
      rows.push(['', clean[i].trim()]);
      continue;
    }
    let cells: string[];
    if (!headerFound && tail.length === 3 && numericCols.length === 4) {
      cells = [tail[0], tail[1], '', tail[2]];               // qty rate amount (no MRP column)
    } else {
      // Right-align: amount is the last column; a total row has only the amount
      cells = [...Array(numericCols.length - tail.length).fill(''), ...tail];
    }
    rows.push([barcode ?? '', description, ...cells]);
  }
  return { rows, headerFound, headerLineIndex: headerIdx };
}
