/**
 * bank-formats.ts — OFX / QFX and QIF statements, turned into the same table a CSV gives (pure, no I/O).
 *
 * Both formats are read into rows of  Date · Description · Reference · Debit · Credit  with ISO dates, so the normal
 * import (balance proof, duplicate detection, auto-matching) works on them unchanged.
 *   OFX/QFX  — bank "Web Connect" export. Old SGML (tags with no closing tag) and XML versions are both read.
 *              It carries the ledger balance but no running balance per line, so the statement is not balance-verified.
 *   QIF      — Quicken export. Dates come as D/M/Y or M/D/Y with no marker; we look at every date to decide, and say so when
 *              they are all ambiguous (we assume day first, as Indian banks write them).
 */
import { Decimal } from 'decimal.js';
import type { BalanceHints, ColumnMapping } from './bank.engine.js';

export interface FormatTable {
  kind: 'OFX' | 'QIF';
  rows: string[][];
  headerRow: number;
  mapping: ColumnMapping;
  hints: BalanceHints;
  warnings: string[];
}

const HEADER = ['Date', 'Description', 'Reference', 'Debit', 'Credit'];
const MAPPING: ColumnMapping = { date: 0, narration: 1, reference: 2, debit: 3, credit: 4 };

/** Which format a text file is, from its first bytes. null = not one of these. */
export function sniffBankFormat(text: string): 'OFX' | 'QIF' | null {
  const head = text.slice(0, 4096).replace(/^﻿/, '');
  if (/^\s*OFXHEADER\s*:/i.test(head) || /<OFX[\s>]/i.test(head) || (/<\?OFX/i.test(head))) return 'OFX';
  if (/^\s*!(Type|Account|Option|Clear)\b/i.test(head)) return 'QIF';
  return null;
}

const iso = (y: number, m: number, d: number): string | null =>
  m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1990 && y <= 2100 ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;

/** A money value as written in these files: optional sign, thousands commas, or a decimal comma. */
export function parseAmount(raw: string): Decimal | null {
  let s = raw.trim().replace(/[₹$€£\s]/g, '');
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); } else if (s.startsWith('+')) s = s.slice(1);
  // 1.234,56 (decimal comma) vs 1,234.56
  if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.');
  else s = s.replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const d = new Decimal(s);
  return neg ? d.negated() : d;
}

function addRow(rows: string[][], date: string, description: string, reference: string, signed: Decimal) {
  rows.push([date, description, reference, signed.isNegative() ? signed.abs().toFixed(2) : '', signed.isNegative() || signed.isZero() ? '' : signed.toFixed(2)]);
}

// ─── OFX ────────────────────────────────────────────────────────────────────

/** `<TAG>value` up to the next tag or line end; works for SGML (no closing tag) and XML (`</TAG>`). */
function ofxField(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i'));
  return m ? m[1].trim() : '';
}

/** DTPOSTED: 20240131, 20240131120000, 20240131120000.000[+5.5:IST] */
function ofxDate(raw: string): string | null {
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? iso(+m[1], +m[2], +m[3]) : null;
}

export function ofxToTable(text: string): FormatTable {
  const warnings: string[] = [];
  const rows: string[][] = [HEADER];
  const blocks = text.split(/<STMTTRN>/i).slice(1);
  if (blocks.length === 0) throw new Error('This OFX file has no transactions.');
  let unreadable = 0;
  for (const raw of blocks) {
    const block = raw.split(/<\/STMTTRN>|<\/BANKTRANLIST>|<\/CCSTMTRS>|<\/STMTRS>/i)[0];
    const date = ofxDate(ofxField(block, 'DTPOSTED') || ofxField(block, 'DTUSER'));
    const amount = parseAmount(ofxField(block, 'TRNAMT'));
    if (!date || !amount) { unreadable++; continue; }
    const name = ofxField(block, 'NAME') || ofxField(block, 'PAYEE');
    const memo = ofxField(block, 'MEMO');
    const description = [name, memo && memo !== name ? memo : ''].filter(Boolean).join(' ').trim() || ofxField(block, 'TRNTYPE');
    const reference = ofxField(block, 'CHECKNUM') || ofxField(block, 'REFNUM') || ofxField(block, 'FITID');
    addRow(rows, date, description, reference, amount);
  }
  if (unreadable) warnings.push(`ROWS_WITHOUT_AMOUNT:${unreadable}`);
  if (rows.length === 1) throw new Error('No transactions in this OFX file could be read.');
  const bal = text.match(/<LEDGERBAL>[\s\S]*?<BALAMT>([^<\r\n]*)/i);
  const closing = bal ? parseAmount(bal[1]) : null;
  return { kind: 'OFX', rows, headerRow: 0, mapping: MAPPING, hints: { opening: null, closing: closing ? closing.toFixed(2) : null }, warnings };
}

// ─── QIF ────────────────────────────────────────────────────────────────────

/** Splits a QIF file into records (lines up to a `^`), each a map of field letter → values. */
function qifRecords(text: string): Array<Record<string, string>> {
  const records: Array<Record<string, string>> = [];
  let cur: Record<string, string> = {};
  let inBank = true;
  for (const lineRaw of text.split(/\r?\n/)) {
    const line = lineRaw.replace(/^﻿/, '').trimEnd();
    if (!line) continue;
    if (line.startsWith('!')) {
      // only bank-like sections hold statement lines; investment accounts and lists are skipped
      if (/^!Type:/i.test(line)) inBank = /^!Type:\s*(Bank|Cash|CCard|Oth A|Oth L)\b/i.test(line);
      continue;
    }
    if (line === '^') { if (inBank && Object.keys(cur).length) records.push(cur); cur = {}; continue; }
    if (!inBank) continue;
    cur[line[0].toUpperCase()] = line.slice(1).trim();
  }
  if (inBank && Object.keys(cur).length) records.push(cur);
  return records.filter((r) => r.D !== undefined && r.T !== undefined);
}

/** `12/31'24`, `31/12/2024`, `31-12-24`: day first unless the dates prove month first. */
function qifDates(records: Array<Record<string, string>>): { dates: Array<string | null>; assumed: boolean } {
  const parts = records.map((r) => {
    const m = r.D.replace(/'/g, '/').match(/^(\d{1,2})[/.\- ](\d{1,2})[/.\- ](\d{2,4})$/);
    if (!m) return null;
    const y = +m[3] < 100 ? (+m[3] > 70 ? 1900 + +m[3] : 2000 + +m[3]) : +m[3];
    return { a: +m[1], b: +m[2], y };
  });
  const monthFirst = parts.some((p) => p && p.a <= 12 && p.b > 12);
  const dayFirst = parts.some((p) => p && p.a > 12);
  const assumed = !monthFirst && !dayFirst;
  const useDayFirst = dayFirst || assumed;
  const dates = parts.map((p) => (p ? (useDayFirst ? iso(p.y, p.b, p.a) : iso(p.y, p.a, p.b)) : null));
  return { dates, assumed };
}

export function qifToTable(text: string): FormatTable {
  const warnings: string[] = [];
  const records = qifRecords(text);
  if (records.length === 0) throw new Error('This QIF file has no bank transactions.');
  const { dates, assumed } = qifDates(records);
  if (assumed) warnings.push('QIF_DATES_ASSUMED_DAY_FIRST');
  const rows: string[][] = [HEADER];
  let unreadable = 0;
  records.forEach((r, i) => {
    const amount = parseAmount(r.T);
    const date = dates[i];
    if (!date || !amount) { unreadable++; return; }
    const description = [r.P, r.M && r.M !== r.P ? r.M : ''].filter(Boolean).join(' ').trim() || 'QIF transaction';
    addRow(rows, date, description, r.N ?? '', amount);
  });
  if (unreadable) warnings.push(`ROWS_WITHOUT_AMOUNT:${unreadable}`);
  if (rows.length === 1) throw new Error('No transactions in this QIF file could be read.');
  return { kind: 'QIF', rows, headerRow: 0, mapping: MAPPING, hints: { opening: null, closing: null }, warnings };
}

/** Reads an OFX or QIF text into the common table. null when the text is neither. */
export function bankFormatToTable(text: string): FormatTable | null {
  const kind = sniffBankFormat(text);
  if (kind === 'OFX') return ofxToTable(text);
  if (kind === 'QIF') return qifToTable(text);
  return null;
}
