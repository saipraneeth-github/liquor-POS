// ─── BUSINESS DAY HELPERS ────────────────────────────────────────────────────
//
// A "business day" is a calendar date in the store's local time. The offset from UTC
// (minutes) comes from BUSINESS_UTC_OFFSET_MINUTES; default 330 = IST (the stores are in India).

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function offsetMinutes(): number {
  const raw = Number(process.env.BUSINESS_UTC_OFFSET_MINUTES ?? '330');
  return Number.isFinite(raw) ? raw : 0;
}

export function isIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Business date (YYYY-MM-DD) of an instant. */
export function businessDateOf(instant: Date = new Date()): string {
  return new Date(instant.getTime() + offsetMinutes() * 60_000).toISOString().slice(0, 10);
}

/** [start, end) instants covering the business day `date`. */
export function businessDayBounds(date: string): { start: Date; end: Date } {
  if (!isIsoDate(date)) throw new Error(`Invalid date ${date}; expected YYYY-MM-DD`);
  const start = new Date(new Date(`${date}T00:00:00.000Z`).getTime() - offsetMinutes() * 60_000);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

/** [start, end) instants covering the inclusive business-date range startDate..endDate. */
export function businessRangeBounds(startDate: string, endDate: string): { start: Date; end: Date } {
  const { start } = businessDayBounds(startDate);
  const { end } = businessDayBounds(endDate);
  return { start, end };
}
