import { describe, it, expect } from 'vitest';
import {
  daysSinceLastBill, healthScore, percentChange, queueFlags, recurringRevenue, revenueByMonth, type InsightTenant,
} from '../../src/modules/platform/insights.engine.js';

const NOW = new Date('2026-11-07T10:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const inDays = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const PRICES = { TRIAL: '0.00', STANDARD: '2999.00', PRO: '7999.00' };

const tenant = (over: Partial<InsightTenant> = {}): InsightTenant => ({
  id: 't', plan: 'STANDARD', isActive: true, access: 'OK', trialEndsAt: null, paidUntil: inDays(10), createdAt: daysAgo(90),
  staffCount: 4, bills30d: 400, lastBillAt: daysAgo(0), ...over,
});

describe('recurringRevenue', () => {
  it('counts only active paid plans in good standing', () => {
    const list = [
      tenant({ plan: 'PRO' }), tenant({ plan: 'STANDARD' }),
      tenant({ plan: 'TRIAL', paidUntil: null }),
      tenant({ plan: 'PRO', isActive: false, access: 'SUSPENDED' }),
      tenant({ plan: 'STANDARD', access: 'OVERDUE' }),
    ];
    expect(recurringRevenue(list, PRICES)).toBe(7999 + 2999);
  });
  it('is zero with no tenants', () => expect(recurringRevenue([], PRICES)).toBe(0));
});

describe('healthScore', () => {
  it('is high for a busy business that billed today', () => expect(healthScore(tenant(), NOW)).toBeGreaterThanOrEqual(90));
  it('falls as the last bill gets older', () => {
    const fresh = healthScore(tenant({ lastBillAt: daysAgo(0) }), NOW);
    const week = healthScore(tenant({ lastBillAt: daysAgo(6) }), NOW);
    const month = healthScore(tenant({ lastBillAt: daysAgo(30) }), NOW);
    expect(fresh).toBeGreaterThan(week);
    expect(week).toBeGreaterThan(month);
  });
  it('is low for a business that never billed', () => expect(healthScore(tenant({ lastBillAt: null, bills30d: 0 }), NOW)).toBeLessThan(40));
  it('never exceeds 40 when access is blocked, however active', () => {
    expect(healthScore(tenant({ access: 'OVERDUE' }), NOW)).toBeLessThanOrEqual(40);
    expect(healthScore(tenant({ access: 'SUSPENDED', isActive: false }), NOW)).toBeLessThanOrEqual(40);
  });
  it('stays within 0..100', () => {
    expect(healthScore(tenant({ bills30d: 1_000_000 }), NOW)).toBe(100);
    expect(healthScore(tenant({ lastBillAt: null, bills30d: 0, staffCount: 0, access: 'SUSPENDED' }), NOW)).toBe(0);
  });
});

describe('queueFlags', () => {
  it('flags a trial ending in 4 days or fewer, and one that already ended', () => {
    expect(queueFlags(tenant({ plan: 'TRIAL', trialEndsAt: inDays(4) }), NOW)).toContain('trialEnding');
    expect(queueFlags(tenant({ plan: 'TRIAL', trialEndsAt: inDays(-1), access: 'TRIAL_EXPIRED' }), NOW)).toContain('trialEnding');
    expect(queueFlags(tenant({ plan: 'TRIAL', trialEndsAt: inDays(9) }), NOW)).not.toContain('trialEnding');
  });
  it('flags a paid plan whose paid-until date has passed', () => {
    expect(queueFlags(tenant({ paidUntil: daysAgo(2) }), NOW)).toContain('overdue');
    expect(queueFlags(tenant({ paidUntil: inDays(2) }), NOW)).not.toContain('overdue');
    expect(queueFlags(tenant({ plan: 'TRIAL', paidUntil: daysAgo(2), trialEndsAt: inDays(9) }), NOW)).not.toContain('overdue');
  });
  it('flags quiet businesses: no bill for 7+ days, or never billed after a week', () => {
    expect(queueFlags(tenant({ lastBillAt: daysAgo(7) }), NOW)).toContain('quiet');
    expect(queueFlags(tenant({ lastBillAt: daysAgo(6) }), NOW)).not.toContain('quiet');
    expect(queueFlags(tenant({ lastBillAt: null, createdAt: daysAgo(10) }), NOW)).toContain('quiet');
  });
  it('gives a brand-new business a week before calling it quiet', () => {
    expect(queueFlags(tenant({ lastBillAt: null, createdAt: daysAgo(2) }), NOW)).not.toContain('quiet');
  });
  it('a suspended business is only listed as suspended', () => {
    expect(queueFlags(tenant({ isActive: false, access: 'SUSPENDED', lastBillAt: null, paidUntil: daysAgo(30) }), NOW)).toEqual(['suspended']);
  });
  it('a healthy business is in no list', () => expect(queueFlags(tenant(), NOW)).toEqual([]));
});

describe('revenueByMonth', () => {
  it('returns six months ending this month, oldest first, zero-filled', () => {
    const r = revenueByMonth([], NOW);
    expect(r.map((x) => x.month)).toEqual(['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
    expect(r.every((x) => x.standard === 0 && x.pro === 0)).toBe(true);
  });
  it('splits paid invoices by plan and month and ignores others', () => {
    const r = revenueByMonth([
      { plan: 'STANDARD', amount: '2999.00', paidAt: new Date('2026-11-03T05:00:00Z') },
      { plan: 'STANDARD', amount: '2999.00', paidAt: new Date('2026-11-06T05:00:00Z') },
      { plan: 'PRO', amount: '7999.00', paidAt: new Date('2026-10-28T05:00:00Z') },
      { plan: 'PRO', amount: '7999.00', paidAt: new Date('2025-01-01T05:00:00Z') },   // outside the window
      { plan: 'PRO', amount: '7999.00', paidAt: null },                              // not paid
      { plan: 'TRIAL', amount: '0.00', paidAt: new Date('2026-11-01T05:00:00Z') },
    ], NOW);
    expect(r[5]).toEqual({ month: '2026-11', standard: 5998, pro: 0 });
    expect(r[4]).toEqual({ month: '2026-10', standard: 0, pro: 7999 });
  });
  it('crosses a year boundary', () => {
    const r = revenueByMonth([], new Date('2026-02-10T00:00:00Z'));
    expect(r.map((x) => x.month)).toEqual(['2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02']);
  });
});

describe('small helpers', () => {
  it('percentChange is null without a previous figure', () => {
    expect(percentChange(100, 0)).toBeNull();
    expect(percentChange(110, 100)).toBe(10);
    expect(percentChange(50, 100)).toBe(-50);
  });
  it('daysSinceLastBill', () => {
    expect(daysSinceLastBill({ lastBillAt: null }, NOW)).toBeNull();
    expect(daysSinceLastBill({ lastBillAt: daysAgo(3) }, NOW)).toBe(3);
  });
});
