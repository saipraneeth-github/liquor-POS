/**
 * dashboard.engine.ts — PURE dashboard logic (no DB, no I/O): hourly buckets, payment mix, comparisons with
 * "yesterday at the same time", khata ageing, and the ranked "needs attention" list.
 */
import { Decimal } from 'decimal.js';

const D = (v: Decimal.Value) => new Decimal(v);
const money2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// ─── SALES ──────────────────────────────────────────────────────────────────

/** Totals per business hour: 24 buckets starting at `dayStart` (the start of the store's day, not midnight UTC). */
export function hourlyBuckets(rows: Array<{ at: Date; total: string }>, dayStart: Date): number[] {
  const out = Array.from({ length: 24 }, () => D(0));
  for (const r of rows) {
    const h = Math.floor((r.at.getTime() - dayStart.getTime()) / HOUR_MS);
    if (h >= 0 && h < 24) out[h] = out[h].plus(r.total);
  }
  return out.map((d) => Number(money2(d)));
}

export function sumTotals(rows: Array<{ total: string }>): string {
  return money2(rows.reduce((a, r) => a.plus(r.total), D(0)));
}

export const PAY_MODES = ['CASH', 'UPI', 'CARD', 'CREDIT'] as const;
export type PayMode = (typeof PAY_MODES)[number];

/** A bill with no mode recorded was taken as cash (the books treat it the same way). Order is fixed so charts stay stable. */
export function paymentMix(rows: Array<{ mode: string | null; total: string }>): Array<{ mode: PayMode; total: string; share: number }> {
  const sums: Record<PayMode, Decimal> = { CASH: D(0), UPI: D(0), CARD: D(0), CREDIT: D(0) };
  for (const r of rows) {
    const m = (r.mode ?? 'CASH').toUpperCase();
    const key: PayMode = (PAY_MODES as readonly string[]).includes(m) ? (m as PayMode) : 'CASH';
    sums[key] = sums[key].plus(r.total);
  }
  const all = PAY_MODES.reduce((a, m) => a.plus(sums[m]), D(0));
  return PAY_MODES.map((mode) => ({
    mode,
    total: money2(sums[mode]),
    share: all.isZero() ? 0 : Math.round(sums[mode].div(all).mul(1000).toNumber()) / 10,
  }));
}

/** Percentage change to one decimal, or null when there is nothing to compare with (yesterday was zero). */
export function percentChange(now: Decimal.Value, before: Decimal.Value): number | null {
  const b = D(before);
  if (b.isZero()) return null;
  return Math.round(D(now).minus(b).div(b).mul(1000).toNumber()) / 10;
}

/** The moment yesterday that is as far into its day as `now` is into today (for "vs yesterday at this time"). */
export function sameTimeYesterday(todayStart: Date, now: Date, yesterdayStart: Date): Date {
  return new Date(yesterdayStart.getTime() + (now.getTime() - todayStart.getTime()));
}

// ─── KHATA AGEING ───────────────────────────────────────────────────────────

export const AGING_BUCKETS = [
  { key: 'D0_15', label: '0 to 15 days', maxDays: 15 },
  { key: 'D16_30', label: '16 to 30 days', maxDays: 30 },
  { key: 'D31_60', label: '31 to 60 days', maxDays: 60 },
  { key: 'D60_PLUS', label: 'Over 60 days', maxDays: Infinity },
] as const;

/**
 * How old is what a customer still owes? Repayments settle the OLDEST purchases first, so what remains is the newest
 * purchases adding up to the current balance. A balance larger than the recorded purchases (an opening balance or an
 * adjustment) has no date, so it is shown as the oldest bucket rather than hidden.
 */
export function khataAging(purchases: Array<{ amount: string; at: Date }>, balance: string, asOf: Date): Array<{ key: string; label: string; amount: string }> {
  const buckets = AGING_BUCKETS.map((b) => ({ key: b.key as string, label: b.label as string, amount: D(0) }));
  let remaining = D(balance);
  for (const p of [...purchases].sort((a, b) => b.at.getTime() - a.at.getTime())) {
    if (remaining.lte(0)) break;
    const take = Decimal.min(remaining, p.amount);
    const days = Math.max(0, Math.floor((asOf.getTime() - p.at.getTime()) / DAY_MS));
    const idx = AGING_BUCKETS.findIndex((b) => days <= b.maxDays);
    buckets[idx].amount = buckets[idx].amount.plus(take);
    remaining = remaining.minus(take);
  }
  if (remaining.gt(0)) buckets[buckets.length - 1].amount = buckets[buckets.length - 1].amount.plus(remaining);
  return buckets.map((b) => ({ key: b.key, label: b.label, amount: money2(b.amount) }));
}

export function mergeAging(list: Array<Array<{ key: string; label: string; amount: string }>>): Array<{ key: string; label: string; amount: string }> {
  return AGING_BUCKETS.map((b) => ({
    key: b.key, label: b.label,
    amount: money2(list.reduce((a, l) => a.plus(l.find((x) => x.key === b.key)?.amount ?? 0), D(0))),
  }));
}

// ─── TIME ───────────────────────────────────────────────────────────────────

/** "45 m", "6 h 20 m", "2 d 3 h". */
export function describeDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} m`;
  if (m < 48 * 60) return `${Math.floor(m / 60)} h ${m % 60} m`;
  return `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`;
}

export const minutesBetween = (from: Date, to: Date) => Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));

// ─── NEEDS ATTENTION ────────────────────────────────────────────────────────

export type Severity = 'bad' | 'warn' | 'good';
export interface AttentionItem { id: string; severity: Severity; title: string; detail: string; route: string }

export interface AttentionInput {
  now: Date;
  dayStart: Date;
  role: 'cashier' | 'manager' | 'owner';
  openShifts: Array<{ terminalName: string; cashierName: string; openedAt: Date; mine: boolean }>;
  yesterdayHadSales: boolean;
  yesterdayClosed: boolean;
  yesterdayDifference: string | null;      // closing cash difference, when closed
  bankLinesToReview: number;
  lowStock: Array<{ name: string; quantity: number }>;
}

const SHIFT_WARN_MINUTES = 12 * 60;          // a shift is normal for most of the day; flag it when it runs unusually long
const CASHIER_SHIFT_WARN_MINUTES = 10 * 60;

/** What needs a decision, most urgent first. A cashier only sees their own shift and stock; money and books are for managers. */
export function attentionItems(input: AttentionInput): AttentionItem[] {
  const items: AttentionItem[] = [];
  const staff = input.role !== 'cashier';

  const shifts = input.openShifts.filter((s) => staff || s.mine).map((s) => ({ ...s, minutes: minutesBetween(s.openedAt, input.now) }));
  const warnAt = staff ? SHIFT_WARN_MINUTES : CASHIER_SHIFT_WARN_MINUTES;
  const long = shifts.filter((s) => s.minutes >= warnAt).sort((a, b) => b.minutes - a.minutes);
  if (long.length > 0) {
    const worst = long[0];
    const overnight = long.some((s) => s.openedAt.getTime() < input.dayStart.getTime());
    items.push({
      id: 'shift',
      severity: overnight ? 'bad' : 'warn',
      title: !staff ? `Your shift has been open ${describeDuration(worst.minutes)}`
        : long.length === 1 ? `${worst.terminalName} shift still open` : `${long.length} shifts still open`,
      detail: !staff ? 'close it before you leave' : `${worst.cashierName}, ${describeDuration(worst.minutes)}${overnight ? ', since yesterday' : ''}`,
      route: '/shift',
    });
  }

  if (staff) {
    if (input.yesterdayHadSales && !input.yesterdayClosed) {
      items.push({ id: 'yesterday-open', severity: 'bad', title: 'Yesterday was not closed', detail: 'close it so cash and sales are on record', route: '/closing' });
    } else if (input.yesterdayHadSales && input.yesterdayClosed) {
      const diff = input.yesterdayDifference;
      if (diff !== null && !D(diff).abs().lte('0.005')) {
        items.push({ id: 'yesterday-diff', severity: 'warn', title: 'Yesterday closed with a cash difference', detail: `₹${money2(D(diff).abs())} ${D(diff).lt(0) ? 'short' : 'over'}`, route: '/closing' });
      } else {
        items.push({ id: 'yesterday-ok', severity: 'good', title: 'Yesterday is closed', detail: 'cash balanced', route: '/closing' });
      }
    }
    if (input.bankLinesToReview > 0) {
      items.push({ id: 'bank', severity: 'warn', title: `${input.bankLinesToReview} bank line${input.bankLinesToReview === 1 ? '' : 's'} to review`, detail: 'match or post them', route: '/bank' });
    }
  }

  const out = input.lowStock.filter((s) => s.quantity <= 0);
  const low = input.lowStock.filter((s) => s.quantity > 0);
  if (out.length > 0) {
    items.push({ id: 'out-of-stock', severity: 'bad', title: `${out.length} item${out.length === 1 ? '' : 's'} out of stock`, detail: out.slice(0, 3).map((s) => s.name).join(', '), route: '/inventory' });
  }
  if (low.length > 0) {
    items.push({ id: 'low-stock', severity: 'warn', title: `${low.length} item${low.length === 1 ? '' : 's'} below reorder level`, detail: low.slice(0, 3).map((s) => s.name).join(', '), route: '/inventory' });
  }

  const rank: Record<Severity, number> = { bad: 0, warn: 1, good: 2 };
  return items.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

// ─── DAY-CLOSE CHECKLIST ────────────────────────────────────────────────────

export interface ClosingStep { id: string; label: string; done: boolean; route: string }

export interface ClosingInput {
  openShiftCount: number;
  counterSheetInUse: boolean;
  counterSheetPosted: boolean;
  bankInUse: boolean;
  bankLinesToReview: number;
  pourInUse: boolean;
  pourRecordedToday: boolean;
}

/** Only the steps this store actually uses are listed, so the checklist is never padded with things it does not do. */
export function closingSteps(i: ClosingInput): ClosingStep[] {
  const steps: ClosingStep[] = [
    { id: 'shifts', label: i.openShiftCount === 0 ? 'All shifts closed' : `Close ${i.openShiftCount} open shift${i.openShiftCount === 1 ? '' : 's'}`, done: i.openShiftCount === 0, route: '/shift' },
  ];
  if (i.counterSheetInUse) steps.push({ id: 'counter', label: i.counterSheetPosted ? 'Counter sheet posted' : 'Post today’s counter sheet', done: i.counterSheetPosted, route: '/counter' });
  if (i.pourInUse) steps.push({ id: 'pour', label: i.pourRecordedToday ? 'Pour counts recorded' : 'Record pour counts', done: i.pourRecordedToday, route: '/pour' });
  if (i.bankInUse) steps.push({ id: 'bank', label: i.bankLinesToReview === 0 ? 'Bank lines reviewed' : `Review ${i.bankLinesToReview} bank line${i.bankLinesToReview === 1 ? '' : 's'}`, done: i.bankLinesToReview === 0, route: '/bank' });
  return steps;
}

// ─── MONTH HELPERS (business dates as YYYY-MM-DD) ───────────────────────────

export const monthStartOf = (isoDate: string) => `${isoDate.slice(0, 7)}-01`;

export function previousMonthStart(isoDate: string): string {
  const y = Number(isoDate.slice(0, 4));
  const m = Number(isoDate.slice(5, 7));
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`;
}

export function pastMonthsList(isoDate: string, count = 6): Array<{ key: string; label: string; start: string; end: string }> {
  const result: Array<{ key: string; label: string; start: string; end: string }> = [];
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let y = Number(isoDate.slice(0, 4));
  let m = Number(isoDate.slice(5, 7));

  for (let i = 0; i < count; i++) {
    const startStr = `${y}-${String(m).padStart(2, '0')}-01`;
    let nextY = y;
    let nextM = m + 1;
    if (nextM > 12) {
      nextM = 1;
      nextY = y + 1;
    }
    const endStr = `${nextY}-${String(nextM).padStart(2, '0')}-01`;
    const label = monthNames[m - 1];
    result.unshift({ key: `${y}-${String(m).padStart(2, '0')}`, label, start: startStr, end: endStr });

    m--;
    if (m < 1) {
      m = 12;
      y--;
    }
  }
  return result;
}
