/**
 * access.engine.ts — Pure rule that decides whether a tenant may use the product right now.
 * Trial: until trial_ends_at. Paid plans: until paid_until plus a grace period. NULL dates = no limit
 * (manually managed / legacy tenants). A suspended tenant is always blocked.
 */

export const GRACE_DAYS = 7;

export type AccessState = 'OK' | 'SUSPENDED' | 'TRIAL_EXPIRED' | 'OVERDUE';

export interface TenantAccessInput {
  isActive: boolean;
  plan: string;
  trialEndsAt: Date | null;
  paidUntil: Date | null;
}

export function accessState(t: TenantAccessInput, now: Date = new Date()): AccessState {
  if (!t.isActive) return 'SUSPENDED';
  if (t.plan === 'TRIAL') {
    return t.trialEndsAt && now.getTime() > t.trialEndsAt.getTime() ? 'TRIAL_EXPIRED' : 'OK';
  }
  if (t.paidUntil && now.getTime() > t.paidUntil.getTime() + GRACE_DAYS * 86_400_000) return 'OVERDUE';
  return 'OK';
}

export const ACCESS_MESSAGE: Record<Exclude<AccessState, 'OK'>, string> = {
  SUSPENDED: 'This business account is suspended. Please contact support.',
  TRIAL_EXPIRED: 'Your free trial has ended. Please contact support to choose a plan.',
  OVERDUE: 'Your subscription payment is overdue. Please contact support to restore access.',
};
