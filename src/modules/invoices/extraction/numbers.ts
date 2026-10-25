import { Decimal } from 'decimal.js';

/** Largest value a numeric(12,2) column can hold is 9,999,999,999.99. */
export const MAX_MONEY = new Decimal('10000000000');

/**
 * Parses Indian-formatted money / numbers: "1,23,456.50", "₹ 850", "Rs. 1,200/-", "INR 99.5".
 * Returns a 2dp decimal string, or null when the text is not a clean non-negative number.
 * Never guesses: OCR garbage such as "2a080" → null (caller flags it as unreadable).
 */
export function parseMoney(raw: unknown): string | null {
  const n = parseNumber(raw);
  // numeric(12,2) holds < 1e10
  if (n === null || n.gte(MAX_MONEY)) return null;
  return n.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

/** Like parseMoney but returns the Decimal (unrounded). */
export function parseNumber(raw: unknown): Decimal | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? new Decimal(raw) : null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s
    .replace(/^(₹|rs\.?|inr)\s*/i, '')
    .replace(/\s*(\/-|\/=)$/, '')
    .replace(/[\s ]/g, '')
    .replace(/^₹/, '');
  // Indian or western digit grouping; commas only between digit groups
  if (!/^\d{1,3}(,\d{2,3})*(\.\d+)?$|^\d+(\.\d+)?$|^\.\d+$/.test(s)) return null;
  s = s.replace(/,/g, '');
  if (s.replace(/\D/g, '').length > 15) return null;
  return new Decimal(s);
}

/**
 * Parses a quantity: non-negative integer, tolerating "24.00", "24 btls", "2 cs", "1,200".
 * Returns null when not an integer.
 */
export function parseQuantity(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(/\s*(btls?|bottles?|nos?\.?|pcs|units?|cs|cases?|ctn)\.?$/i, '');
  const n = parseNumber(s);
  if (n === null || !n.isInteger()) return null;
  if (n.greaterThan(100_000)) return null;
  return n.toNumber();
}

/** True when a non-empty cell looks numeric but cannot be parsed (e.g. OCR "2a080.00"). */
export function looksLikeGarbledNumber(raw: string): boolean {
  const s = raw.trim();
  if (s.length < 2) return false;
  if (/(ml|ltr|lt|l|cl|pcs|btls?|cs|x)$/i.test(s)) return false;
  if (/^\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(s)) return false;          // a date, not a number
  if (/^[A-Za-z]{2,}[-/]/.test(s)) return false;                           // a code such as INV-2026-0457
  const digits = (s.match(/\d/g) ?? []).length;
  return digits >= 2 && digits / s.length >= 0.5 && /^[\w.,₹/-]+$/.test(s);
}
