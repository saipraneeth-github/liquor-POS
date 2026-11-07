/**
 * insights.engine.ts — PURE rules behind the Super Admin dashboard: recurring revenue, a tenant health score,
 * the "needs action" queue and the monthly revenue series. No DB, no clock (pass `now`).
 */

export const DAY_MS = 86_400_000;
export const TRIAL_WARNING_DAYS = 4;
export const QUIET_DAYS = 7;

export interface InsightTenant {
  id: string;
  plan: string;                        // TRIAL | STANDARD | PRO
  isActive: boolean;
  access: 'OK' | 'SUSPENDED' | 'TRIAL_EXPIRED' | 'OVERDUE';
  trialEndsAt: Date | null;
  paidUntil: Date | null;
  createdAt: Date | null;
  staffCount: number;
  bills30d: number;
  lastBillAt: Date | null;             // latest PAID bill ever (not only the last 30 days)
}

const wholeDays = (from: Date, to: Date) => Math.floor((to.getTime() - from.getTime()) / DAY_MS);

/** Days since the last bill, or null when the business has never billed. */
export function daysSinceLastBill(t: Pick<InsightTenant, 'lastBillAt'>, now: Date): number | null {
  return t.lastBillAt ? Math.max(0, wholeDays(t.lastBillAt, now)) : null;
}

/** Monthly recurring revenue: active, paid-plan businesses whose access is in order. */
export function recurringRevenue(tenants: InsightTenant[], prices: Record<string, string>): number {
  return tenants
    .filter((t) => t.isActive && t.plan !== 'TRIAL' && t.access === 'OK')
    .reduce((sum, t) => sum + Number(prices[t.plan] ?? 0), 0);
}

/**
 * 0-100. Half comes from how recently they billed, a quarter from how much, and the rest from having staff and
 * being in good standing. A suspended or expired business never scores above 40: it cannot use the product.
 */
export function healthScore(t: InsightTenant, now: Date): number {
  const gap = daysSinceLastBill(t, now);
  const recency = gap === null ? 0 : gap <= 1 ? 50 : gap <= 3 ? 42 : gap <= 7 ? 28 : gap <= 14 ? 12 : 0;
  const volume = Math.min(25, Math.round(t.bills30d / 20));
  const staff = t.staffCount > 0 ? 10 : 0;
  const standing = t.access === 'OK' ? 15 : 0;
  const raw = recency + volume + staff + standing;
  return Math.max(0, Math.min(t.access === 'OK' ? 100 : 40, raw));
}

export type QueueKey = 'trialEnding' | 'overdue' | 'quiet' | 'suspended';

/** Which of the four action lists a business belongs to (it can be in more than one). */
export function queueFlags(t: InsightTenant, now: Date): QueueKey[] {
  const flags: QueueKey[] = [];
  if (!t.isActive) { flags.push('suspended'); return flags; }
  if (t.plan === 'TRIAL' && t.trialEndsAt) {
    const left = (t.trialEndsAt.getTime() - now.getTime()) / DAY_MS;
    if (left <= TRIAL_WARNING_DAYS) flags.push('trialEnding');   // includes a trial that already ended
  }
  if (t.plan !== 'TRIAL' && t.paidUntil && t.paidUntil.getTime() < now.getTime()) flags.push('overdue');
  const gap = daysSinceLastBill(t, now);
  const age = t.createdAt ? wholeDays(t.createdAt, now) : QUIET_DAYS;
  if ((gap === null && age >= QUIET_DAYS) || (gap !== null && gap >= QUIET_DAYS)) flags.push('quiet');
  return flags;
}

/** Sums subscription money COLLECTED (by the month it was paid) into the last `months` calendar months (oldest first), split by plan. */
export function revenueByMonth(
  invoices: { plan: string; amount: string; paidAt: Date | null }[],
  now: Date,
  months = 6,
): { month: string; standard: number; pro: number }[] {
  const keys: string[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  const out = keys.map((month) => ({ month, standard: 0, pro: 0 }));
  for (const inv of invoices) {
    if (!inv.paidAt) continue;
    const row = out.find((r) => r.month === inv.paidAt!.toISOString().slice(0, 7));
    if (!row) continue;
    if (inv.plan === 'PRO') row.pro += Number(inv.amount);
    else if (inv.plan === 'STANDARD') row.standard += Number(inv.amount);
  }
  return out;
}

export function percentChange(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}
