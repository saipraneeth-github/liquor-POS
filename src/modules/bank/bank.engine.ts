/**
 * bank.engine.ts — PURE bank-statement logic (no DB, no I/O).
 *
 * Goal: work with ANY bank's statement without per-bank templates.
 *   1. Parsing   — find the header row, infer which column is what, read Indian-format amounts and dates,
 *                  work out debit vs credit (columns, Dr/Cr marks, signs, or the running-balance delta).
 *   2. Validation— the statement must agree with itself: every running balance follows from the one before,
 *                  and opening + credits − debits = closing. This is the proof that extraction was correct.
 *   3. Matching  — pair statement lines with the entries in the books' BANK ledger (1:1, or one card/UPI
 *                  settlement ↔ many sales minus the gateway fee) and suggest a category for the rest.
 *
 * Nothing here is bank-specific. Layout differences are absorbed by header vocabulary, content inference,
 * and (in the UI) a column mapping the user can correct.
 */
import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';

// ─── TYPES ──────────────────────────────────────────────────────────────────

export interface ParsedLine {
  lineNo: number;            // 1-based position in the statement after ordering
  txnDate: string;           // YYYY-MM-DD
  valueDate: string | null;
  narration: string;
  reference: string | null;
  debit: string;             // money OUT of the account, 2dp ('0.00' when the line is a credit)
  credit: string;            // money INTO the account
  balance: string | null;    // running balance after the line, when the statement shows one
  confidence: number;        // 0..1: how sure the parser is about the amount and its direction
  flags: string[];           // e.g. DIRECTION_GUESSED, BOTH_SIDES
}

export interface ColumnMapping {
  date?: number;
  valueDate?: number;
  narration?: number;
  reference?: number;
  debit?: number;
  credit?: number;
  amount?: number;   // single amount column…
  drCr?: number;     // …with a Dr/Cr indicator column (or a sign / Dr-Cr suffix on the amount)
  balance?: number;
}
export type ColumnKey = keyof ColumnMapping;
export const COLUMN_KEYS: ColumnKey[] = ['date', 'valueDate', 'narration', 'reference', 'debit', 'credit', 'amount', 'drCr', 'balance'];

export interface BalanceHints { opening: string | null; closing: string | null }

export interface BalanceCheck {
  status: 'PASS' | 'FAIL' | 'UNVERIFIABLE';
  message: string;
  checked: number;                                   // lines whose running balance was compared
  breaks: { lineNo: number; expected: string; actual: string }[];
  opening: string | null;
  closing: string | null;
  computedClosing: string | null;                    // opening + credits − debits
  totalDebit: string;
  totalCredit: string;
}

const D = (v: Decimal.Value) => new Decimal(v);
const TOL = new Decimal('0.005');
const money2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

// ─── AMOUNTS ────────────────────────────────────────────────────────────────

export interface MoneyToken { value: Decimal; side: 'DR' | 'CR' | null; negative: boolean }

/**
 * "1,23,456.78", "₹ 1,234.00", "Rs. 500", "(500.00)", "-500", "500.00-", "1,000.00 Cr", "Dr 250.00".
 * Returns null for blanks, dashes and anything that is not a plain number (so a date never parses as money).
 * `value` is always the absolute amount; sign and Dr/Cr are reported separately.
 */
export function parseMoney(raw: string | null | undefined): MoneyToken | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s || /^(-+|nil|na|n\/a|null|\.|--)$/i.test(s)) return null;

  let side: 'DR' | 'CR' | null = null;
  // "1,000.00 Cr", "1,000.00Cr", "1,000.00 (Dr)": the marker may touch the number, so no word boundary before it
  const suffix = s.match(/^(.*?\d)[\s(]*(dr|cr|debit|credit)\b\.?\)?\s*$/i);
  const prefix = s.match(/^\s*\(?\b(dr|cr|debit|credit)\b\.?\)?\s*(.*)$/i);
  if (suffix && suffix[1].trim()) { side = /^d/i.test(suffix[2]) ? 'DR' : 'CR'; s = suffix[1]; }
  else if (prefix && prefix[2].trim()) { side = /^d/i.test(prefix[1]) ? 'DR' : 'CR'; s = prefix[2]; }

  s = s.replace(/₹|rs\.?|inr|`/gi, '').trim();
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { negative = true; s = s.slice(1); }
  if (s.endsWith('-')) { negative = true; s = s.slice(0, -1); }
  s = s.replace(/[,\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return { value: D(s), side, negative };
}

/** A token that is clearly an amount (has decimals or comma grouping) — used when guessing columns from content. */
export function looksLikeMoney(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const t = String(raw).trim();
  if (!/\.\d{1,2}\s*(dr|cr)?\)?$/i.test(t) && !/\d,\d{2,3}/.test(t)) return false;
  return parseMoney(t) !== null;
}

function parseSide(raw: string | null | undefined): 'DR' | 'CR' | null {
  const t = (raw ?? '').trim().toLowerCase();
  if (!t) return null;
  if (/^(dr|d|debit|db|w|wd|wdl|withdrawal|out|paid\s*out)\.?$/.test(t)) return 'DR';
  if (/^(cr|c|credit|cd|dep|deposit|in|paid\s*in)\.?$/.test(t)) return 'CR';
  return null;
}

// ─── DATES ──────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function iso(y: number, m: number, d: number): string | null {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

function fullYear(y: number): number {
  if (y >= 100) return y;
  return y <= 69 ? 2000 + y : 1900 + y;
}

/**
 * Dates in every layout banks use: 31/03/2026, 31-03-26, 31.03.2026, 31 Mar 2026, 31-Mar-26, Mar 31, 2026,
 * 2026-03-31, with or without a time, and Excel serial numbers. Ambiguous 04/05/2026 follows `dayFirst` (India: true).
 */
export function parseBankDate(raw: string | null | undefined, dayFirst = true): string | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(/[T\s]+\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*(am|pm)?(z|[+-]\d{2}:?\d{2})?$/i, '').trim();

  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return iso(+m[1], +m[2], +m[3]);

  m = s.match(/^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})$/);
  if (m) {
    const a = +m[1], b = +m[2], y = fullYear(+m[3]);
    if (a > 12) return iso(y, b, a);
    if (b > 12) return iso(y, a, b);
    return dayFirst ? iso(y, b, a) : iso(y, a, b);
  }

  m = s.match(/^(\d{1,2})[-/. ,]*([A-Za-z]{3,9})\.?[-/. ,]*(\d{2,4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) return iso(fullYear(+m[3]), MONTHS[m[2].toLowerCase()], +m[1]);

  m = s.match(/^([A-Za-z]{3,9})\.?[-/. ,]*(\d{1,2})(?:st|nd|rd|th)?[-/. ,]+(\d{2,4})$/);
  if (m && MONTHS[m[1].toLowerCase()]) return iso(fullYear(+m[3]), MONTHS[m[1].toLowerCase()], +m[2]);

  if (/^\d{5}(\.\d+)?$/.test(s)) {            // Excel serial day number
    const n = Math.floor(Number(s));
    if (n > 25000 && n < 60000) return new Date(Date.UTC(1899, 11, 30) + n * 86_400_000).toISOString().slice(0, 10);
  }
  return null;
}

/** Day-first unless the data proves month-first (some second component > 12 while the first is ≤ 12). */
export function detectDayFirst(samples: string[]): boolean {
  let dayFirst = 0;
  let monthFirst = 0;
  for (const s of samples) {
    const m = s.trim().match(/^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})/);
    if (!m) continue;
    if (+m[1] > 12 && +m[2] <= 12) dayFirst++;
    else if (+m[2] > 12 && +m[1] <= 12) monthFirst++;
  }
  return monthFirst <= dayFirst;
}

export function addDays(isoDate: string, days: number): string {
  return new Date(new Date(`${isoDate}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}
export function daysBetween(a: string, b: string): number {
  return Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86_400_000);
}

// ─── HEADER / COLUMN DETECTION ──────────────────────────────────────────────

// Ordered: the first matching rule wins, so specific phrases come before generic ones.
const HEADER_RULES: Array<[ColumnKey, RegExp]> = [
  ['valueDate', /value\s*(date|dt)|^value$/],
  ['date',      /^(txn|trans|transaction|tran|posting|post|booking|entry|posted)?\s*(date|dt)\b|transaction\s*date|txn\s*date|date\s*of\s*transaction|^date/],
  ['drCr',      /^(dr\s*\/\s*cr|cr\s*\/\s*dr|debit\s*\/\s*credit|credit\s*\/\s*debit|type|txn\s*type|transaction\s*type|tran\s*type|dr\s*cr|cr\s*dr|indicator|dr\/cr\s*(flag|indicator))$/],
  ['reference', /\bchq\b|cheque|check\s*(no|num)|\bref(erence)?\b|\butr\b|instrument|txn\s*id|transaction\s*id|tran\s*id|\bchq\s*no/],
  ['balance',   /balance|^bal\b|\bbal\.?$|running/],
  ['debit',     /debit|withdraw|paid\s*out|money\s*out|^dr\.?$|^dr\b|amount\s*debited|outflow/],
  ['credit',    /credit|deposit|paid\s*in|money\s*in|^cr\.?$|^cr\b|amount\s*credited|inflow/],
  ['amount',    /^(transaction\s*|txn\s*|tran\s*)?(amount|amt)\b|amount\s*\(/],
  ['narration', /narration|description|particular|remark|detail|narrative|beneficiary|memo|payee/],
];

export function classifyHeader(cell: string): ColumnKey | null {
  const t = cell.toLowerCase().replace(/[._*]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  for (const [key, re] of HEADER_RULES) if (re.test(t)) return key;
  return null;
}

export interface MappingResult {
  headerRow: number;                 // index in `rows`; -1 when the columns were inferred from content
  headers: string[];
  mapping: ColumnMapping;
  method: 'HEADER' | 'CONTENT' | 'MANUAL';
  confidence: number;                // 0..1
  warnings: string[];
}

/** Finds the header row among the first 60 rows (statements start with account details / address blocks). */
export function findHeaderRow(rows: string[][]): { headerRow: number; mapping: ColumnMapping; headers: string[] } | null {
  let best: { headerRow: number; mapping: ColumnMapping; headers: string[]; score: number } | null = null;
  for (let i = 0; i < Math.min(rows.length, 60); i++) {
    const mapping: ColumnMapping = {};
    rows[i].forEach((cell, idx) => {
      const key = classifyHeader(cell);
      if (key && mapping[key] === undefined) mapping[key] = idx;
    });
    if (mapping.date === undefined) continue;
    const hasMoney = mapping.debit !== undefined || mapping.credit !== undefined || mapping.amount !== undefined;
    if (!hasMoney) continue;
    // Separate debit/credit columns beat a single amount column
    if ((mapping.debit !== undefined || mapping.credit !== undefined) && mapping.amount !== undefined) delete mapping.amount;
    const score = Object.keys(mapping).length;
    if (score >= 3 && (!best || score > best.score)) best = { headerRow: i, mapping, headers: rows[i], score };
  }
  return best ? { headerRow: best.headerRow, mapping: best.mapping, headers: best.headers } : null;
}

/** When there is no recognisable header: guess the columns from what the cells look like. */
export function inferMappingFromContent(rows: string[][], dayFirst = true): { mapping: ColumnMapping; confidence: number } | null {
  const sample = rows.slice(0, 300);
  const width = Math.max(0, ...sample.map((r) => r.length));
  if (width < 3) return null;
  const stats = Array.from({ length: width }, (_, c) => {
    const cells = sample.map((r) => (r[c] ?? '').trim()).filter(Boolean);
    const n = Math.max(1, cells.length);
    return {
      c,
      filled: cells.length,
      dateRatio: cells.filter((x) => parseBankDate(x, dayFirst) !== null && !looksLikeMoney(x)).length / n,
      moneyRatio: cells.filter(looksLikeMoney).length / n,
      avgLen: cells.reduce((a, x) => a + x.length, 0) / n,
    };
  });
  const dateCols = stats.filter((s) => s.dateRatio >= 0.6 && s.filled >= 3).map((s) => s.c);
  if (dateCols.length === 0) return null;
  // A debit or credit column is legitimately sparse (a statement may have only two deposits), so one filled cell is enough
  const moneyCols = stats.filter((s) => s.moneyRatio >= 0.3 && s.filled >= 1 && !dateCols.includes(s.c)).map((s) => s.c);
  if (moneyCols.length === 0) return null;
  const mapping: ColumnMapping = { date: dateCols[0] };
  if (dateCols[1] !== undefined) mapping.valueDate = dateCols[1];

  // How often are two columns filled on the SAME row? Debit and credit almost never are (one side per line);
  // an amount and its running balance almost always are. This tells the two layouts apart.
  const cellFilled = (r: string[], c: number) => looksLikeMoney(r[c]);
  const overlap = (a: number, b: number) => {
    let both = 0;
    let either = 0;
    for (const r of sample) {
      const x = cellFilled(r, a);
      const y = cellFilled(r, b);
      if (x || y) either++;
      if (x && y) both++;
    }
    return either === 0 ? 0 : both / either;
  };

  if (moneyCols.length >= 3) {
    mapping.balance = moneyCols[moneyCols.length - 1];
    mapping.debit = moneyCols[moneyCols.length - 3];
    mapping.credit = moneyCols[moneyCols.length - 2];
  } else if (moneyCols.length === 2) {
    if (overlap(moneyCols[0], moneyCols[1]) < 0.25) {      // mutually exclusive → Debit | Credit, with no running balance
      mapping.debit = moneyCols[0];
      mapping.credit = moneyCols[1];
    } else {                                                // filled together → Amount | Balance
      mapping.amount = moneyCols[0];
      mapping.balance = moneyCols[1];
    }
  } else {
    mapping.amount = moneyCols[0];
  }
  const used = new Set(Object.values(mapping));
  const text = stats.filter((s) => !used.has(s.c) && s.moneyRatio < 0.3 && s.filled >= 3).sort((a, b) => b.avgLen - a.avgLen);
  if (text[0]) mapping.narration = text[0].c;
  if (text[1] && text[1].avgLen < 40) mapping.reference = text[1].c;
  return { mapping, confidence: 0.5 };
}

/** Header detection first, content inference second. Never throws: an unreadable layout returns confidence 0. */
export function detectMapping(rows: string[][], dayFirst = true): MappingResult {
  const warnings: string[] = [];
  const header = findHeaderRow(rows);
  if (header) {
    if (header.mapping.narration === undefined) warnings.push('NO_NARRATION_COLUMN');
    if (header.mapping.balance === undefined) warnings.push('NO_BALANCE_COLUMN');
    const conf = 0.6 + 0.1 * Number(header.mapping.narration !== undefined) + 0.2 * Number(header.mapping.balance !== undefined)
      + 0.1 * Number(header.mapping.debit !== undefined || header.mapping.credit !== undefined || header.mapping.drCr !== undefined);
    return { headerRow: header.headerRow, headers: header.headers, mapping: header.mapping, method: 'HEADER', confidence: Math.min(1, conf), warnings };
  }
  const guess = inferMappingFromContent(rows, dayFirst);
  if (guess) {
    warnings.push('COLUMNS_GUESSED_FROM_CONTENT');
    return { headerRow: -1, headers: [], mapping: guess.mapping, method: 'CONTENT', confidence: guess.confidence, warnings };
  }
  return { headerRow: -1, headers: [], mapping: {}, method: 'CONTENT', confidence: 0, warnings: ['COLUMNS_NOT_RECOGNISED'] };
}

// ─── ROWS → LINES ───────────────────────────────────────────────────────────

const OPENING_RE = /\b(opening\s*bal(ance)?|balance\s*b\s*\/\s*f|brought\s*forward)\b/i;
const CLOSING_RE = /\b(closing\s*bal(ance)?|balance\s*c\s*\/\s*f|carried\s*forward)\b/i;

/** Opening / closing balance printed on the statement outside the transaction table, if any. */
export function scanBalanceHints(rows: string[][]): BalanceHints {
  const hints: BalanceHints = { opening: null, closing: null };
  for (const row of rows) {
    const text = row.join(' ');
    const isOpening = OPENING_RE.test(text);
    const isClosing = CLOSING_RE.test(text);
    if (!isOpening && !isClosing) continue;
    if (row.some((c) => parseBankDate(c) !== null && !looksLikeMoney(c))) continue;   // a transaction row, not a summary
    const amounts = row.filter(looksLikeMoney).map((c) => parseMoney(c)!);
    if (amounts.length === 0) continue;
    const t = amounts[amounts.length - 1];
    const signed = t.negative || t.side === 'DR' ? t.value.negated() : t.value;
    if (isOpening && hints.opening === null) hints.opening = money2(signed);
    if (isClosing) hints.closing = money2(signed);   // the last "closing" wins (page footers repeat)
  }
  return hints;
}

const NOISE_ROW_RE = /^(page\s*\d|statement\s*(of|period|summary)|account\s*(no|number|statement)|customer|branch|ifsc|micr|total\b|grand\s*total|opening\s*bal|closing\s*bal|\*+|end\s*of|this\s*is\s*a\s*computer|registered\s*office|generated\s*on|toll\s*free)/i;

export interface NormalizeResult {
  lines: ParsedLine[];
  skipped: { row: number; reason: string }[];
  dayFirst: boolean;
}

/** Applies a column mapping to the rows below the header and produces ordered, direction-resolved lines. */
export function rowsToLines(rows: string[][], headerRow: number, mapping: ColumnMapping, opts: { dayFirst?: boolean; opening?: string | null } = {}): NormalizeResult {
  const cell = (r: string[], idx: number | undefined) => (idx === undefined ? '' : (r[idx] ?? '').trim());
  const dateSamples = mapping.date === undefined ? [] : rows.slice(headerRow + 1, headerRow + 400).map((r) => cell(r, mapping.date));
  const dayFirst = opts.dayFirst ?? detectDayFirst(dateSamples);

  type Pending = ParsedLine & { _amount?: Decimal; _unknownDir?: boolean; _row: number };
  const out: Pending[] = [];
  const skipped: { row: number; reason: string }[] = [];

  for (let i = headerRow + 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.every((c) => !c.trim())) continue;
    // Repeated header row (multi-page exports)
    if (findHeaderRow([r])) { skipped.push({ row: i, reason: 'REPEATED_HEADER' }); continue; }

    const txnDate = parseBankDate(cell(r, mapping.date), dayFirst);
    if (!txnDate) {
      // Narration that wraps onto a second row has no date and no amount: glue it to the line above
      const narr = cell(r, mapping.narration);
      const hasAmount = [mapping.debit, mapping.credit, mapping.amount, mapping.balance].some((c) => looksLikeMoney(cell(r, c)));
      if (out.length > 0 && narr && !hasAmount && !NOISE_ROW_RE.test(narr)) {
        out[out.length - 1].narration = `${out[out.length - 1].narration} ${narr}`.trim();
      } else {
        skipped.push({ row: i, reason: 'NO_DATE' });
      }
      continue;
    }

    let debit = D(0);
    let credit = D(0);
    let unknownDir = false;
    let amount: Decimal | undefined;
    let confidence = 1;
    const flags: string[] = [];
    let balanceSide: 'DR' | 'CR' | null = null;

    if (mapping.debit !== undefined || mapping.credit !== undefined) {
      const d = parseMoney(cell(r, mapping.debit));
      const c = parseMoney(cell(r, mapping.credit));
      if (d) debit = d.value;
      if (c) credit = c.value;
      if (!debit.isZero() && !credit.isZero()) { flags.push('BOTH_SIDES'); confidence = 0.5; }
    } else if (mapping.amount !== undefined) {
      const a = parseMoney(cell(r, mapping.amount));
      if (a) {
        amount = a.value;
        const side = parseSide(cell(r, mapping.drCr)) ?? a.side ?? (a.negative ? 'DR' : null);
        if (side === 'DR') debit = a.value;
        else if (side === 'CR') credit = a.value;
        else unknownDir = true;
      }
    }
    if (debit.isZero() && credit.isZero() && !unknownDir) { skipped.push({ row: i, reason: 'NO_AMOUNT' }); continue; }

    const bal = parseMoney(cell(r, mapping.balance));
    if (bal) balanceSide = bal.side;
    const balance = bal ? money2(bal.negative || balanceSide === 'DR' ? bal.value.negated() : bal.value) : null;

    out.push({
      lineNo: 0,
      txnDate,
      valueDate: parseBankDate(cell(r, mapping.valueDate), dayFirst),
      narration: cell(r, mapping.narration),
      reference: cell(r, mapping.reference) || null,
      debit: money2(debit),
      credit: money2(credit),
      balance,
      confidence,
      flags,
      _amount: amount,
      _unknownDir: unknownDir,
      _row: i,
    });
  }

  const ordered = orientLines(out);
  resolveUnknownDirections(ordered as Pending[], opts.opening ?? null);
  const lines: ParsedLine[] = ordered.map((l, idx) => {
    const { _amount, _unknownDir, _row, ...rest } = l as Pending;
    void _amount; void _unknownDir; void _row;
    return { ...rest, lineNo: idx + 1 };
  });
  return { lines, skipped, dayFirst };
}

/**
 * Exports list newest-first or oldest-first. Chooses the order whose running balances chain correctly; with no
 * balances it falls back to the dates (ascending). Same-day order is preserved from the file.
 */
export function orientLines<T extends ParsedLine>(lines: T[]): T[] {
  if (lines.length < 2) return lines;
  const withBal = lines.filter((l) => l.balance !== null).length;
  const reversed = [...lines].reverse();
  if (withBal >= 2) {
    const fwd = chainBreaks(lines);
    const rev = chainBreaks(reversed);
    if (rev < fwd) return reversed;
    if (fwd < rev) return lines;
  }
  return lines[0].txnDate > lines[lines.length - 1].txnDate ? reversed : lines;
}

function chainBreaks(lines: ParsedLine[]): number {
  let breaks = 0;
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i - 1].balance;
    const c = lines[i].balance;
    if (p === null || c === null) continue;
    if (D(p).plus(lines[i].credit).minus(lines[i].debit).minus(c).abs().gt(TOL)) breaks++;
  }
  return breaks;
}

/**
 * A single Amount column with no Dr/Cr marker: the running balance tells the direction (balance went up → credit).
 * Only if there is no balance either does it fall back to narration keywords, and then it says so.
 */
function resolveUnknownDirections(lines: Array<ParsedLine & { _amount?: Decimal; _unknownDir?: boolean }>, opening: string | null): void {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l._unknownDir || !l._amount) continue;
    const amt = l._amount;
    let prev: Decimal | null = null;
    if (i > 0 && lines[i - 1].balance !== null) prev = D(lines[i - 1].balance!);
    else if (i === 0 && opening !== null) prev = D(opening);
    let dir: 'DR' | 'CR' | null = null;
    if (prev !== null && l.balance !== null) {
      const delta = D(l.balance).minus(prev);
      if (delta.minus(amt).abs().lte(TOL)) dir = 'CR';
      else if (delta.plus(amt).abs().lte(TOL)) dir = 'DR';
    } else if (l.balance !== null && i + 1 < lines.length && lines[i + 1].balance !== null) {
      // First line without an opening balance: infer from the NEXT line's balance step is not possible; leave to keywords
    }
    if (dir === null) {
      if (/^(by[-/ ]|by\b)/i.test(l.narration)) {
        dir = 'CR';
        l.confidence = Math.min(l.confidence, 0.85);
      } else if (/^(to[-/ ]|to\b)/i.test(l.narration)) {
        dir = 'DR';
        l.confidence = Math.min(l.confidence, 0.85);
      } else {
        dir = /\b(cr|credit|deposit|received|rcvd|salary|interest|int\.?\s*pd|refund|reversal|neft\s*cr|imps\s*cr|by\s*[-/]?\s*(cash|transfer|clg))\b/i.test(l.narration) ? 'CR' : 'DR';
        l.flags.push('DIRECTION_GUESSED');
        l.confidence = Math.min(l.confidence, 0.4);
      }
    } else {
      l.confidence = Math.min(l.confidence, 0.9);
    }
    if (dir === 'DR') { l.debit = money2(amt); l.credit = '0.00'; }
    else { l.credit = money2(amt); l.debit = '0.00'; }
    l._unknownDir = false;
  }
}

// ─── PDF / OCR TEXT → ROWS ──────────────────────────────────────────────────

const DATE_AT_START = /^(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{1,2}[-/. ]+[A-Za-z]{3,9}\.?[-/. ,]+\d{2,4}|\d{4}-\d{2}-\d{2})(?=\s|$)/;
const MONEY_AT_END = /(?:^|\s)((?:₹|rs\.?\s?)?\(?-?\d[\d,]*\.\d{1,2}\)?(?:\s*(?:dr|cr)\b\.?)?)\s*$/i;
const REFERENCE_TOKEN = /\b(?:[A-Z]{0,8}\d{6,}|\d{9,})\b/;

export interface TextTable { rows: string[][]; mapping: ColumnMapping; headerRow: number; hints: BalanceHints; skippedLines: number }

/**
 * Text lines from a PDF/OCR → the same row shape a spreadsheet gives, so ONE normaliser handles everything.
 * Layout-agnostic: a transaction line starts with a date and ends with one or two amounts (amount, balance).
 * Lines without a date that carry no amount are narration continuations. Direction comes later, from the balance.
 */
export function textLinesToTable(textLines: string[]): TextTable {
  const rows: string[][] = [['Date', 'Value Date', 'Narration', 'Reference', 'Amount', 'Dr/Cr', 'Balance']];
  let skipped = 0;
  const hints: BalanceHints = { opening: null, closing: null };

  for (const raw of textLines) {
    const line = raw.replace(/\s+$/g, '').trim();
    if (!line) continue;
    const afterSerial = line.replace(/^\d{1,3}\s+(?=\d{1,2}[-/.])/, '');   // "12  05/04/2026 …" row serial numbers

    // Opening / closing balance or page carry-forward printed as a text line (even if prefixed by a date or page header)
    const isOpening = OPENING_RE.test(line);
    const isClosing = CLOSING_RE.test(line);
    if (isOpening || isClosing) {
      const m = line.match(MONEY_AT_END);
      const t = m ? parseMoney(m[1]) : null;
      if (t) {
        const signed = t.negative || t.side === 'DR' ? t.value.negated() : t.value;
        if (isOpening && hints.opening === null) hints.opening = money2(signed);
        if (isClosing) hints.closing = money2(signed);
      }
      continue;
    }

    const d1 = afterSerial.match(DATE_AT_START);

    if (!d1) {
      const last = rows[rows.length - 1];
      if (rows.length > 1 && !MONEY_AT_END.test(line) && line.length < 160 && !NOISE_ROW_RE.test(line)) {
        last[2] = `${last[2]} ${line}`.trim();
      } else {
        skipped++;
      }
      continue;
    }

    let rest = afterSerial.slice(d1[0].length).trim();
    const dateRaw = d1[1];
    let valueDateRaw = '';
    const d2 = rest.match(DATE_AT_START);
    if (d2) { valueDateRaw = d2[1]; rest = rest.slice(d2[0].length).trim(); }

    // Amounts from the right: [balance] ← [amount] (← optional second amount when both Dr and Cr columns print)
    const tokens: string[] = [];
    for (let i = 0; i < 3; i++) {
      const m = rest.match(MONEY_AT_END);
      if (!m) break;
      tokens.unshift(m[1].trim());
      rest = rest.slice(0, rest.length - m[0].length).replace(/\s+$/, '');
    }
    if (tokens.length === 0) { skipped++; continue; }

    let amountRaw = '';
    let balanceRaw = '';
    if (tokens.length === 1) amountRaw = tokens[0];
    else if (tokens.length === 2) { amountRaw = tokens[0]; balanceRaw = tokens[1]; }
    else {
      // debit, credit, balance printed with a 0.00 in the empty column
      balanceRaw = tokens[2];
      const a = parseMoney(tokens[0]);
      const b = parseMoney(tokens[1]);
      amountRaw = a && !a.value.isZero() ? tokens[0] : tokens[1];
      if (a && b && !a.value.isZero() && !b.value.isZero()) amountRaw = tokens[0];
    }
    const amt = parseMoney(amountRaw);
    let drCr = amt?.side ?? '';
    const narration = rest.trim();
    if (!drCr) {
      if (/^(by[-/ ]|by\b)/i.test(narration)) drCr = 'CR';
      else if (/^(to[-/ ]|to\b)/i.test(narration)) drCr = 'DR';
    }
    const ref = narration.match(REFERENCE_TOKEN)?.[0] ?? '';
    rows.push([dateRaw, valueDateRaw, narration, ref, amountRaw.replace(/\s*(dr|cr)\b\.?$/i, ''), drCr, balanceRaw]);
  }
  return {
    rows,
    mapping: { date: 0, valueDate: 1, narration: 2, reference: 3, amount: 4, drCr: 5, balance: 6 },
    headerRow: 0,
    hints,
    skippedLines: skipped,
  };
}

// ─── VALIDATION: THE STATEMENT MUST AGREE WITH ITSELF ───────────────────────

export function verifyBalanceChain(lines: ParsedLine[], hints: BalanceHints = { opening: null, closing: null }): BalanceCheck {
  const totalDebit = lines.reduce((a, l) => a.plus(l.debit), D(0));
  const totalCredit = lines.reduce((a, l) => a.plus(l.credit), D(0));
  const withBal = lines.filter((l) => l.balance !== null);
  const base = {
    totalDebit: money2(totalDebit),
    totalCredit: money2(totalCredit),
    breaks: [] as BalanceCheck['breaks'],
  };

  if (lines.length === 0) {
    return { ...base, status: 'UNVERIFIABLE', message: 'No transactions were read.', checked: 0, opening: hints.opening, closing: hints.closing, computedClosing: null };
  }

  // Opening: stated, else derived from the first line that has a balance
  let opening: Decimal | null = hints.opening !== null ? D(hints.opening) : null;
  if (opening === null && lines[0].balance !== null) opening = D(lines[0].balance).minus(lines[0].credit).plus(lines[0].debit);
  const closingStated = hints.closing !== null ? D(hints.closing) : null;
  const lastBal = withBal.length ? D(withBal[withBal.length - 1].balance!) : null;
  const closing = closingStated ?? lastBal;
  const computedClosing = opening !== null ? opening.plus(totalCredit).minus(totalDebit) : null;

  const breaks: BalanceCheck['breaks'] = [];
  let prev: Decimal | null = opening;
  let checked = 0;
  for (const l of lines) {
    if (l.balance === null) {
      if (prev !== null) prev = prev.plus(l.credit).minus(l.debit);
      continue;
    }
    const actual = D(l.balance);
    if (prev !== null) {
      const expected = prev.plus(l.credit).minus(l.debit);
      checked++;
      if (expected.minus(actual).abs().gt(TOL)) breaks.push({ lineNo: l.lineNo, expected: money2(expected), actual: money2(actual) });
    }
    prev = actual;                 // resync so one bad line does not cascade into hundreds of breaks
  }

  // Too few running balances to verify line by line: fall back to opening + movement = closing when both are known
  if (withBal.length < Math.max(2, Math.ceil(lines.length * 0.5))) {
    if (opening !== null && closingStated !== null && computedClosing !== null) {
      const ok = computedClosing.minus(closingStated).abs().lte(TOL) && breaks.length === 0;
      return { ...base, status: ok ? 'PASS' : 'FAIL', checked, opening: money2(opening), closing: money2(closingStated), computedClosing: money2(computedClosing),
        message: ok ? `Opening balance + credits − debits equals the closing balance${checked > 0 ? ` (${checked} checkpoint(s) verified)` : ''}.`
          : `Opening ${money2(opening)} + credits − debits = ${money2(computedClosing)}, but the statement closes at ${money2(closingStated)}.` };
    }
    return { ...base, status: 'UNVERIFIABLE', checked, opening: opening !== null ? money2(opening) : null, closing: closing !== null ? money2(closing) : null, computedClosing: computedClosing !== null ? money2(computedClosing) : null,
      message: 'This statement has no running balance, so it cannot be proven correct automatically. Review the totals before importing.' };
  }

  let closingOk = true;
  if (closingStated !== null && lastBal !== null) closingOk = closingStated.minus(lastBal).abs().lte(TOL);

  const pass = breaks.length === 0 && closingOk;
  let message: string;
  if (pass) message = `Every running balance follows from the one before (${checked} checked). The statement agrees with itself.`;
  else if (breaks.length > 0) message = `${breaks.length} line(s) do not follow from the previous balance — a row was misread, missing or duplicated. First problem: line ${breaks[0].lineNo}.`;
  else message = `The last running balance ${money2(lastBal!)} differs from the stated closing balance ${money2(closingStated!)}.`;

  return {
    ...base,
    status: pass ? 'PASS' : 'FAIL',
    message,
    checked,
    breaks: breaks.slice(0, 20),
    opening: opening !== null ? money2(opening) : null,
    closing: closing !== null ? money2(closing) : null,
    computedClosing: computedClosing !== null ? money2(computedClosing) : null,
  };
}

// ─── IDENTITY (dedupe across overlapping statements) ────────────────────────

const normText = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Stable id of a transaction. Two identical lines in one file get different `occurrence` numbers, so neither is lost. */
export function assignHashes(lines: ParsedLine[]): Array<ParsedLine & { hash: string }> {
  const seen = new Map<string, number>();
  return lines.map((l) => {
    const key = [l.txnDate, l.debit, l.credit, l.balance ?? '', normText(l.narration), (l.reference ?? '').trim()].join('|');
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    return { ...l, hash: createHash('sha256').update(`${key}|${occurrence}`).digest('hex').slice(0, 32) };
  });
}

// ─── CATEGORY HINTS ─────────────────────────────────────────────────────────

export type BankCategory =
  | 'SETTLEMENT' | 'CASH_DEPOSIT' | 'CASH_WITHDRAWAL' | 'BANK_CHARGE' | 'INTEREST'
  | 'SUPPLIER_PAYMENT' | 'SUPPLIER_REFUND' | 'OWNER_CAPITAL' | 'OWNER_DRAWINGS'
  | 'EXCISE_GOVT' | 'SALARY_WAGES' | 'RENT' | 'MISC_EXPENSES' | 'UTILITIES'
  | 'INTER_ACCOUNT_IN' | 'INTER_ACCOUNT_OUT'
  | 'OTHER_RECEIPT' | 'OTHER_PAYMENT';

export const POSTABLE_CATEGORIES: BankCategory[] = [
  'CASH_DEPOSIT', 'CASH_WITHDRAWAL', 'BANK_CHARGE', 'INTEREST', 'SUPPLIER_PAYMENT', 'SUPPLIER_REFUND',
  'OWNER_CAPITAL', 'OWNER_DRAWINGS', 'EXCISE_GOVT', 'SALARY_WAGES', 'RENT', 'MISC_EXPENSES', 'UTILITIES',
  'INTER_ACCOUNT_IN', 'INTER_ACCOUNT_OUT', 'OTHER_RECEIPT', 'OTHER_PAYMENT',
];

/** Which direction each category belongs to: 'IN' = a credit on the statement, 'OUT' = a debit. */
export const CATEGORY_SIDE: Record<BankCategory, 'IN' | 'OUT'> = {
  SETTLEMENT: 'IN', CASH_DEPOSIT: 'IN', INTEREST: 'IN', SUPPLIER_REFUND: 'IN', OWNER_CAPITAL: 'IN', INTER_ACCOUNT_IN: 'IN', OTHER_RECEIPT: 'IN',
  CASH_WITHDRAWAL: 'OUT', BANK_CHARGE: 'OUT', SUPPLIER_PAYMENT: 'OUT', OWNER_DRAWINGS: 'OUT', EXCISE_GOVT: 'OUT', SALARY_WAGES: 'OUT',
  RENT: 'OUT', MISC_EXPENSES: 'OUT', UTILITIES: 'OUT',
  INTER_ACCOUNT_OUT: 'OUT', OTHER_PAYMENT: 'OUT',
};

/** Types whose other side is an account the user must pick (no fixed ledger). */
export const CATEGORY_NEEDS_LEDGER: ReadonlySet<BankCategory> = new Set<BankCategory>([
  'INTER_ACCOUNT_IN', 'INTER_ACCOUNT_OUT', 'OTHER_RECEIPT', 'OTHER_PAYMENT',
]);

const GATEWAY_RE = /razorpay|paytm|phonepe|payu|cashfree|billdesk|pine\s*labs|mswipe|\bedc\b|\bpos\b.*settle|settlement|merchant|bharatpe|google\s*pay|gpay|ccavenue|stripe|worldline|sale\s*proceeds|\bacq(uirer)?\b|card\s*sett|upi\s*sett|payswiff|mobikwik|yesapn|bulk\s*posting|sbip_cr/i;
const SUPPLIER_NAME_RE = /\b(spirits?|wines?|beverages?|breweries|brewery|distilleries|distillery|agencies|liquors?|industries|marketing\s*services|beers?)\b/i;

/** Keyword hints only — a suggestion for the user to confirm, never an automatic decision. */
export function hintCategory(line: { debit: string; credit: string; narration: string }): BankCategory | null {
  const n = line.narration;
  const isCredit = D(line.credit).gt(0);
  const isDebit = D(line.debit).gt(0);
  if (isCredit) {
    if (/\b(int\.?\s*(pd|paid|cr|credit|on)|interest\s*(paid|credit|cr)?|credit\s*interest|sb\s*int)\b/i.test(n) && !GATEWAY_RE.test(n)) return 'INTEREST';
    if (/\b(cash\s*(dep|deposit)|csh\s*dep|cdm|by\s*cash|self\s*deposit|cash-dep)\b/i.test(n)) return 'CASH_DEPOSIT';
    if (GATEWAY_RE.test(n)) return 'SETTLEMENT';
    if (/by-?\s*(clearing|transfer)/i.test(n) && SUPPLIER_NAME_RE.test(n)) return 'SUPPLIER_REFUND';
  }
  if (isDebit) {
    if (/tnsg|cyber\s*treasur|treasury|commissioner|prohibition|excise|e-?challan/i.test(n)) return 'EXCISE_GOVT';
    if (/\b(chg|chgs|charge|charges|fee|fees|penalty|amc|min(imum)?\s*bal|sms\s*(alert|chg)|gst\s*(on)?|cgst|sgst|igst|processing|annual|return\s*chg|cheque\s*return|cash\s*handling|nach\s*return)\b/i.test(n)) return 'BANK_CHARGE';
    if (/\b(atm|cash\s*(wdl|withdrawal)|nfs|self\s*(cheque|chq)|cash\s*wdl)\b/i.test(n)) return 'CASH_WITHDRAWAL';
    if (/\b(salary|salaries|wages|payroll|stipend)\b/i.test(n)) return 'SALARY_WAGES';
    if (/\b(rent|rental|lease|landlord|shop\s*rent|store\s*rent|office\s*rent)\b/i.test(n)) return 'RENT';
    if (/\b(electricity|power|bescom|tneb|mseb|cesc|water|utility|utilities|broadband|wifi|internet|telephone|mobile\s*bill|airtel|jio|bsnl)\b/i.test(n)) return 'UTILITIES';
    if (/\b(misc|miscellaneous|stationery|printing|refreshment|tea|coffee|cleaning|repairs?|maintenance)\b/i.test(n)) return 'MISC_EXPENSES';
  }
  return null;
}
// ─── MATCHING ───────────────────────────────────────────────────────────────

/** One entry of the books' BANK ledger. `debit` = money in (receipt), `credit` = money out (payment). */
export interface BookEntry {
  id: string;            // journal line id
  date: string;          // voucher date
  debit: string;
  credit: string;
  narration: string;     // voucher narration
  sourceType: string | null;
}

export interface MatchLine { id: string; date: string; debit: string; credit: string; narration: string; reference: string | null }

export type Suggestion =
  | { kind: 'IGNORE'; ruleId: string; pattern: string; ignoreReason: IgnoreReason; confidence: number; reason: string }
  | { kind: 'ONE_TO_ONE'; entryIds: string[]; confidence: number; reason: string }
  | { kind: 'SETTLEMENT'; entryIds: string[]; expected: string; fee: string; feePct: number; days: string[]; mode: 'ALL' | 'CARD' | 'UPI'; confidence: number; reason: string }
  | { kind: 'POST'; category: BankCategory; confidence: number; reason: string; customTypeId?: string; customTypeName?: string };

export interface MatchOptions {
  windowDays: number;       // 1:1 — how far apart the statement date and the book date may be
  maxFeePct: number;        // settlement — largest gateway/EDC fee (% of the sales) treated as a fee
  maxSettleDays: number;    // settlement — how many days of sales one payout may cover
  settleLagDays: number;    // settlement — how many days after the last sale the money may arrive
}
export const DEFAULT_MATCH_OPTIONS: MatchOptions = { windowDays: 7, maxFeePct: 3, maxSettleDays: 5, settleLagDays: 5 };

const STOP = new Set(['the', 'and', 'for', 'from', 'with', 'bill', 'sales', 'sale', 'payment', 'purchase', 'invoice', 'upi', 'neft', 'rtgs', 'imps', 'ref', 'txn', 'cash', 'card', 'bank']);
function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP.has(t)));
}
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let hit = 0;
  for (const t of a) if (b.has(t)) hit++;
  return hit / Math.min(a.size, b.size);
}

const amountOf = (l: MatchLine) => (D(l.credit).gt(0) ? D(l.credit) : D(l.debit));
const isIn = (l: MatchLine) => D(l.credit).gt(0);
const entryAmount = (e: BookEntry, money: 'IN' | 'OUT') => (money === 'IN' ? D(e.debit) : D(e.credit));

function modeOf(e: BookEntry): 'CARD' | 'UPI' | 'OTHER' {
  const m = e.narration.match(/\((CARD|UPI)\)/i);
  return m ? (m[1].toUpperCase() as 'CARD' | 'UPI') : 'OTHER';
}
const isSalesEntry = (e: BookEntry) => e.sourceType === 'BILL' || e.sourceType === 'BILL_VOID';

/**
 * Suggests, for each statement line, how it relates to the books. Pure and deterministic; nothing is applied.
 *   1. ONE_TO_ONE  — same amount and direction as ONE unmatched book entry within a few days.
 *   2. SETTLEMENT  — a payout (credit) equal to several days of card/UPI sales minus a plausible fee.
 *   3. POST        — no book entry at all; the narration hints at what it is (charge, interest, cash …).
 * A book entry is suggested to at most one line.
 */
export function suggestMatches(lines: MatchLine[], entries: BookEntry[], options: Partial<MatchOptions> = {}): Map<string, Suggestion | null> {
  const opt = { ...DEFAULT_MATCH_OPTIONS, ...options };
  const result = new Map<string, Suggestion | null>();
  const used = new Set<string>();
  const ordered = [...lines].sort((a, b) => a.date.localeCompare(b.date) || amountOf(b).comparedTo(amountOf(a)));

  // Pass 1 — one-to-one
  for (const line of ordered) {
    const money = isIn(line) ? 'IN' : 'OUT';
    const amount = amountOf(line);
    if (amount.lte(0)) { result.set(line.id, null); continue; }
    const lineTokens = tokens(`${line.narration} ${line.reference ?? ''}`);
    const scored: Array<{ e: BookEntry; score: number; dist: number }> = [];
    for (const e of entries) {
      if (used.has(e.id)) continue;
      if (entryAmount(e, money).minus(amount).abs().gt(TOL)) continue;
      const dist = Math.abs(daysBetween(e.date, line.date));
      if (dist > opt.windowDays) continue;
      const dateScore = 1 - dist / (opt.windowDays + 1);
      const tok = overlap(lineTokens, tokens(e.narration));
      // A reference printed on the statement (cheque no, invoice no, challan no) that appears in the voucher narration is strong evidence
      let ref = 0;
      for (const t of lineTokens) if (t.length >= 5 && /\d/.test(t) && e.narration.toLowerCase().includes(t)) ref = 1;
      scored.push({ e, dist, score: 0.55 + 0.25 * dateScore + 0.2 * Math.min(1, tok * 3 + ref) });
    }
    if (scored.length === 0) continue;
    scored.sort((a, b) => b.score - a.score || a.dist - b.dist);
    let confidence = scored[0].score;
    const ambiguous = scored.length > 1 && scored[0].score - scored[1].score < 0.05;
    if (ambiguous) confidence -= 0.2;
    used.add(scored[0].e.id);
    result.set(line.id, {
      kind: 'ONE_TO_ONE',
      entryIds: [scored[0].e.id],
      confidence: round3(Math.max(0.3, confidence)),
      reason: ambiguous
        ? `Same amount as ${scored.length} book entries near ${line.date}; confirm this is the right one.`
        : `Same amount and direction as a book entry ${scored[0].dist === 0 ? 'on the same day' : `${scored[0].dist} day(s) apart`}.`,
    });
  }

  // Pass 2 — settlements: a payout covering several days of card/UPI sales less the gateway fee
  for (const line of ordered) {
    if (result.get(line.id)) continue;
    if (!isIn(line)) continue;
    const amount = amountOf(line);
    if (amount.lte(0)) continue;
    const gatewayHint = GATEWAY_RE.test(line.narration);
    const sales = entries.filter((e) => !used.has(e.id) && isSalesEntry(e));
    if (sales.length === 0) continue;

    type Cand = { ids: string[]; T: Decimal; fee: Decimal; feePct: number; days: string[]; mode: 'ALL' | 'CARD' | 'UPI'; lag: number; len: number };
    const cands: Cand[] = [];
    for (let lag = 0; lag <= opt.settleLagDays; lag++) {
      const endDate = addDays(line.date, -lag);
      for (let len = 1; len <= opt.maxSettleDays; len++) {
        const days = Array.from({ length: len }, (_, i) => addDays(endDate, -i)).reverse();
        const inWindow = sales.filter((e) => e.date >= days[0] && e.date <= days[days.length - 1]);
        if (inWindow.length === 0) continue;
        for (const mode of ['ALL', 'CARD', 'UPI'] as const) {
          const set = inWindow.filter((e) => mode === 'ALL' || modeOf(e) === mode);
          if (set.length === 0) continue;
          const T = set.reduce((a, e) => a.plus(e.debit).minus(e.credit), D(0));
          if (T.lte(0)) continue;
          const fee = T.minus(amount);
          if (fee.lt(TOL.negated())) continue;                       // the payout can't exceed the sales
          const feePct = fee.div(T).mul(100).toNumber();
          if (feePct > opt.maxFeePct + 1e-9) continue;
          cands.push({ ids: set.map((e) => e.id), T, fee: fee.lt(0) ? D(0) : fee, feePct, days, mode, lag, len });
        }
      }
    }
    if (cands.length === 0) continue;
    cands.sort((a, b) => a.len - b.len || a.lag - b.lag || a.feePct - b.feePct);
    const best = cands[0];
    const distinct = new Set(cands.map((c) => [...c.ids].sort().join(','))).size;
    let confidence = 0.45;
    if (gatewayHint) confidence += 0.25;
    if (best.feePct <= 2.5) confidence += 0.1;
    if (best.fee.abs().lte(TOL)) confidence += 0.1;
    if (distinct > 1) confidence -= 0.15;
    best.ids.forEach((id) => used.add(id));
    result.set(line.id, {
      kind: 'SETTLEMENT',
      entryIds: best.ids,
      expected: money2(best.T),
      fee: money2(best.fee),
      feePct: Math.round(best.feePct * 100) / 100,
      days: best.days,
      mode: best.mode,
      confidence: round3(Math.min(0.9, Math.max(0.25, confidence))),
      reason: `Looks like a payout for ${best.mode === 'ALL' ? 'card + UPI' : best.mode} sales of ${best.days[0]}${best.days.length > 1 ? ` to ${best.days[best.days.length - 1]}` : ''}: ₹${money2(best.T)} less ₹${money2(best.fee)} fee (${(Math.round(best.feePct * 100) / 100).toFixed(2)}%).${distinct > 1 ? ' Other day-ranges also fit — check the dates.' : ''}`,
    });
  }

  // Pass 3 — nothing in the books: hint a category so the user can post it with one click
  for (const line of ordered) {
    if (result.get(line.id)) continue;
    const cat = hintCategory(line);
    result.set(line.id, cat && cat !== 'SETTLEMENT'
      ? { kind: 'POST', category: cat, confidence: 0.6, reason: `Not in the books. The narration looks like ${cat.toLowerCase().replace(/_/g, ' ')}.` }
      : null);
  }
  return result;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

// ─── POSTING RULES (statement line → voucher) ───────────────────────────────

export interface PostingSpec { ledger: string; debit: string; credit: string }

/**
 * The books-side entry a statement line needs when it is NOT already in the books.
 * `OTHER_*` lines use whichever ledger the user picked (returned as the placeholder code '__OTHER__').
 */
export function postingForCategory(category: BankCategory, amount: string): { voucherType: 'CONTRA' | 'PAYMENT' | 'RECEIPT'; lines: PostingSpec[]; side: 'IN' | 'OUT' } {
  const a = money2(D(amount));
  const z = '0.00';
  const dr = (ledger: string): PostingSpec => ({ ledger, debit: a, credit: z });
  const cr = (ledger: string): PostingSpec => ({ ledger, debit: z, credit: a });
  switch (category) {
    case 'CASH_DEPOSIT':    return { voucherType: 'CONTRA',  side: 'IN',  lines: [dr('BANK'), cr('CASH')] };
    case 'CASH_WITHDRAWAL': return { voucherType: 'CONTRA',  side: 'OUT', lines: [dr('CASH'), cr('BANK')] };
    case 'BANK_CHARGE':     return { voucherType: 'PAYMENT', side: 'OUT', lines: [dr('BANK_CHARGES'), cr('BANK')] };
    case 'INTEREST':        return { voucherType: 'RECEIPT', side: 'IN',  lines: [dr('BANK'), cr('INTEREST_INCOME')] };
    case 'SUPPLIER_PAYMENT':return { voucherType: 'PAYMENT', side: 'OUT', lines: [dr('SUNDRY_CREDITORS'), cr('BANK')] };
    case 'SUPPLIER_REFUND': return { voucherType: 'RECEIPT', side: 'IN',  lines: [dr('BANK'), cr('SUNDRY_CREDITORS')] };
    case 'OWNER_CAPITAL':   return { voucherType: 'RECEIPT', side: 'IN',  lines: [dr('BANK'), cr('CAPITAL')] };
    case 'OWNER_DRAWINGS':  return { voucherType: 'PAYMENT', side: 'OUT', lines: [dr('CAPITAL'), cr('BANK')] };
    case 'SALARY_WAGES':    return { voucherType: 'PAYMENT', side: 'OUT', lines: [dr('SALARY_WAGES'), cr('BANK')] };
    case 'RENT':            return { voucherType: 'PAYMENT', side: 'OUT', lines: [dr('RENT'), cr('BANK')] };
    case 'MISC_EXPENSES':   return { voucherType: 'PAYMENT', side: 'OUT', lines: [dr('MISC_EXPENSES'), cr('BANK')] };
    case 'UTILITIES':       return { voucherType: 'PAYMENT', side: 'OUT', lines: [dr('UTILITIES'), cr('BANK')] };
    case 'EXCISE_GOVT':     return { voucherType: 'PAYMENT', side: 'OUT', lines: [dr('EXCISE_GOVT'), cr('BANK')] };
    case 'INTER_ACCOUNT_IN':
    case 'OTHER_RECEIPT':   return { voucherType: 'RECEIPT', side: 'IN',  lines: [dr('BANK'), cr('__OTHER__')] };
    case 'INTER_ACCOUNT_OUT':
    case 'OTHER_PAYMENT':   return { voucherType: 'PAYMENT', side: 'OUT', lines: [dr('__OTHER__'), cr('BANK')] };
    case 'SETTLEMENT':      throw new Error('A settlement is matched to sales, not posted');
  }
}

/** The gateway/EDC fee kept back from a settlement: Dr BANK_CHARGES, Cr BANK (the sales were booked gross). */
export function feePosting(fee: string): PostingSpec[] {
  const a = money2(D(fee));
  return [{ ledger: 'BANK_CHARGES', debit: a, credit: '0.00' }, { ledger: 'BANK', debit: '0.00', credit: a }];
}

// ─── IGNORING LINES THAT ARE NOT THE STORE'S ────────────────────────────────

export const IGNORE_REASONS = ['PERSONAL', 'OTHER_BUSINESS', 'NOT_OURS', 'OTHER'] as const;
export type IgnoreReason = (typeof IGNORE_REASONS)[number];

export interface IgnoreRule {
  id: string;
  pattern: string;
  side: 'ANY' | 'IN' | 'OUT';
  minAmount: string | null;
  maxAmount: string | null;
  reason: IgnoreReason;
  action: 'SUGGEST' | 'AUTO';
  isActive: boolean;
}

export const MIN_RULE_PATTERN = 3;

/**
 * The first active rule that matches a line, or null. A rule matches when its text appears in the narration or
 * reference (any case, spacing ignored), the line is on the rule's side, and the amount is inside its range.
 * Patterns shorter than 3 characters never match: a rule for "A" would swallow the whole statement.
 */
export function matchIgnoreRule(line: { debit: string; credit: string; narration: string; reference: string | null }, rules: IgnoreRule[]): IgnoreRule | null {
  const haystack = `${line.narration} ${line.reference ?? ''}`.toLowerCase().replace(/\s+/g, ' ');
  const isIn = D(line.credit).gt(0);
  const amount = isIn ? D(line.credit) : D(line.debit);
  for (const rule of rules) {
    if (!rule.isActive) continue;
    const pattern = rule.pattern.toLowerCase().replace(/\s+/g, ' ').trim();
    if (pattern.length < MIN_RULE_PATTERN || !haystack.includes(pattern)) continue;
    if (rule.side === 'IN' && !isIn) continue;
    if (rule.side === 'OUT' && isIn) continue;
    if (rule.minAmount !== null && amount.lt(rule.minAmount)) continue;
    if (rule.maxAmount !== null && amount.gt(rule.maxAmount)) continue;
    return rule;
  }
  return null;
}

// Words that appear on many unrelated lines and so make a poor rule
const GENERIC_WORDS = new Set([
  'upi', 'neft', 'imps', 'rtgs', 'ach', 'nach', 'ecs', 'pos', 'atm', 'ibl', 'payment', 'paid', 'pay', 'transfer', 'trf', 'bank', 'ref', 'txn', 'trxn',
  'debit', 'credit', 'from', 'cash', 'card', 'online', 'bill', 'purchase', 'towards', 'self', 'bulk', 'mob', 'mobile', 'banking', 'internet', 'cheque', 'chq',
  'icici', 'hdfc', 'sbin', 'axis', 'kotak', 'okaxis', 'oksbi', 'okhdfcbank', 'okicici', 'ybl', 'paytm', 'apl', 'axl', 'upiicici',
]);

/**
 * A sensible text for "ignore lines like this", taken from a narration: the first word that looks like a name or
 * merchant (not a number, not a bank/payment-method word). "UPI/412345678901/SWIGGY/swiggy@icici/Payment" → "SWIGGY".
 * Empty when nothing distinctive is left; the user then types one.
 */
export function suggestPattern(narration: string): string {
  const tokens = narration.split(/[^A-Za-z0-9]+/).filter(Boolean);
  for (const t of tokens) {
    if (t.length < 4 || /\d/.test(t) || GENERIC_WORDS.has(t.toLowerCase())) continue;
    return t;
  }
  return '';
}

// ─── RECONCILIATION SUMMARY ─────────────────────────────────────────────────

export interface ReconciliationSummary {
  bankClosing: string | null;          // per the statement
  bookBalance: string;                 // BANK ledger as at the statement end
  outstandingReceipts: string;         // in the books, not yet on the statement
  outstandingPayments: string;
  unpostedReceipts: string;            // on the statement, not in the books
  unpostedPayments: string;
  ignoredNet: string;                  // lines deliberately left out of the books (credits − debits)
  adjustedBank: string | null;         // bank + outstanding receipts − outstanding payments − unposted receipts + unposted payments − ignored
  difference: string | null;           // book − adjustedBank; zero = the figures tie out
  /**
   * True when no statement line is missing from the books. The figures can tie out while lines still need a decision
   * (they are simply listed as reconciling items), but then the books are not right yet.
   */
  booksComplete: boolean;
  /** Fully reconciled = the figures tie out AND the books need no correction. Outstanding book items are fine: that is timing. */
  reconciled: boolean;
}

export function summarise(input: {
  bankClosing: string | null;
  bookBalance: string;
  outstandingReceipts: string;
  outstandingPayments: string;
  unpostedReceipts: string;
  unpostedPayments: string;
  ignoredNet: string;
}): ReconciliationSummary {
  const adjusted = input.bankClosing === null ? null
    : D(input.bankClosing).plus(input.outstandingReceipts).minus(input.outstandingPayments)
        .minus(input.unpostedReceipts).plus(input.unpostedPayments).minus(input.ignoredNet);
  const diff = adjusted === null ? null : D(input.bookBalance).minus(adjusted);
  const booksComplete = D(input.unpostedReceipts).abs().lte(TOL) && D(input.unpostedPayments).abs().lte(TOL);
  return {
    ...input,
    adjustedBank: adjusted === null ? null : money2(adjusted),
    difference: diff === null ? null : money2(diff),
    booksComplete,
    reconciled: diff !== null && diff.abs().lte(TOL) && booksComplete,
  };
}
