// Business-day helpers for the UI. A "business day" is a calendar date in the STORE's local time, matching the
// server (src/lib/business-day.ts, BUSINESS_UTC_OFFSET_MINUTES, default 330 = IST).
//
// `new Date().toISOString().slice(0, 10)` is the UTC date: between 00:00 and 05:30 IST it is still "yesterday",
// so screens would default to the wrong day. Always use these helpers for date defaults and filters.
//
// Build-time override for other time zones: VITE_BUSINESS_UTC_OFFSET_MINUTES.

function offsetMinutes(): number {
  const raw = Number(import.meta.env.VITE_BUSINESS_UTC_OFFSET_MINUTES ?? '330');
  return Number.isFinite(raw) ? raw : 330;
}

/** Business date (YYYY-MM-DD) of an instant, optionally shifted by whole days. */
export function businessDate(offsetDays = 0, instant: Date = new Date()): string {
  const shifted = instant.getTime() + offsetMinutes() * 60_000 + offsetDays * 86_400_000;
  return new Date(shifted).toISOString().slice(0, 10);
}
