/**
 * dunning.engine.ts — Pure rules for billing reminders. Returns the single stage a tenant is in right now;
 * the service sends each (stage, period) once. No DB, no clock.
 */

import { GRACE_DAYS } from './access.engine.js';

export type DunningKind = 'TRIAL_3' | 'TRIAL_ENDED' | 'DUE_7' | 'DUE_1' | 'OVERDUE' | 'GRACE_LAST';

export interface DunningInput {
  isActive: boolean;
  plan: string;
  trialEndsAt: Date | null;
  paidUntil: Date | null;
}

const DAY = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Whole days from now until `to` (rounded up); <= 0 means it has passed. */
export function daysUntil(to: Date, now: Date): number {
  return Math.ceil((to.getTime() - now.getTime()) / DAY);
}

export function dunningStage(t: DunningInput, now: Date): { kind: DunningKind; periodKey: string } | null {
  if (!t.isActive) return null;

  if (t.plan === 'TRIAL') {
    if (!t.trialEndsAt) return null;
    const left = daysUntil(t.trialEndsAt, now);
    const periodKey = isoDay(t.trialEndsAt);
    if (left <= 0) return { kind: 'TRIAL_ENDED', periodKey };
    if (left <= 3) return { kind: 'TRIAL_3', periodKey };
    return null;
  }

  if (!t.paidUntil) return null;
  const left = daysUntil(t.paidUntil, now);
  const periodKey = isoDay(t.paidUntil);
  if (left > 7) return null;
  if (left > 1) return { kind: 'DUE_7', periodKey };
  if (left > 0) return { kind: 'DUE_1', periodKey };
  // Past the paid date: warn, and send a last notice on the final day before access is blocked
  return left <= -(GRACE_DAYS - 1) ? { kind: 'GRACE_LAST', periodKey } : { kind: 'OVERDUE', periodKey };
}

/** A paid tenant gets its next invoice raised automatically once the renewal is a week away. */
export function needsInvoice(t: DunningInput, now: Date): boolean {
  if (!t.isActive || t.plan === 'TRIAL' || !t.paidUntil) return false;
  return daysUntil(t.paidUntil, now) <= 7;
}
