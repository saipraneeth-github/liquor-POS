import { describe, it, expect } from 'vitest';
import { accessState, GRACE_DAYS } from '../../src/modules/platform/access.engine.js';
import { nextAttemptDelayMs, MAX_PRINT_ATTEMPTS } from '../../src/lib/print/retry.js';

const now = new Date('2026-11-01T10:00:00Z');
const days = (n: number) => new Date(now.getTime() + n * 86_400_000);
const base = { isActive: true, plan: 'STANDARD', trialEndsAt: null, paidUntil: null };

describe('accessState', () => {
  it('suspended always blocks', () => {
    expect(accessState({ ...base, isActive: false }, now)).toBe('SUSPENDED');
    expect(accessState({ ...base, plan: 'TRIAL', isActive: false, trialEndsAt: days(5) }, now)).toBe('SUSPENDED');
  });

  it('trial runs until trial_ends_at', () => {
    expect(accessState({ ...base, plan: 'TRIAL', trialEndsAt: days(1) }, now)).toBe('OK');
    expect(accessState({ ...base, plan: 'TRIAL', trialEndsAt: days(-1) }, now)).toBe('TRIAL_EXPIRED');
  });

  it('paid plans get a grace period after paid_until', () => {
    expect(accessState({ ...base, paidUntil: days(-(GRACE_DAYS - 1)) }, now)).toBe('OK');
    expect(accessState({ ...base, paidUntil: days(-(GRACE_DAYS + 1)) }, now)).toBe('OVERDUE');
  });

  it('missing dates mean no limit (manually managed tenants)', () => {
    expect(accessState(base, now)).toBe('OK');
    expect(accessState({ ...base, plan: 'TRIAL' }, now)).toBe('OK');
  });
});

describe('print retry backoff', () => {
  it('backs off and gives up after the maximum attempts', () => {
    expect(nextAttemptDelayMs(1)).toBe(30_000);
    expect(nextAttemptDelayMs(2)).toBe(120_000);
    expect(nextAttemptDelayMs(MAX_PRINT_ATTEMPTS - 1)).toBeGreaterThan(nextAttemptDelayMs(2)!);
    expect(nextAttemptDelayMs(MAX_PRINT_ATTEMPTS)).toBeNull();
  });
});
