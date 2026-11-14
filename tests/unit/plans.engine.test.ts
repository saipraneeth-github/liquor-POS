import { describe, it, expect } from 'vitest';
import { addDaysIso, monthlyEquivalent, planCodeFromName, prorate } from '../../src/modules/platform/plans.engine.js';

const base = { currentPaid: true, currentPrice: '2999.00', currentCycleDays: 30, targetPrice: '7999.00', targetCycleDays: 30 };
const utc = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe('prorate: moving to another plan mid-period', () => {
  it('credits the unused days of the current plan against the new price', () => {
    // 10 of 30 days left on a 2999 plan = 999.67 credit
    const r = prorate({ ...base, paidUntil: utc('2026-11-20'), effective: '2026-11-10' });
    expect(r.unusedDays).toBe(10);
    expect(r.credit).toBe('999.67');
    expect(r.amountDue).toBe('6999.33');
    expect(r.periodStart).toBe('2026-11-10');
    expect(r.periodEnd).toBe('2026-12-10');
  });

  it('gives no credit for a trial or an unpaid plan', () => {
    const r = prorate({ ...base, currentPaid: false, paidUntil: utc('2026-11-20'), effective: '2026-11-10' });
    expect(r.credit).toBe('0.00');
    expect(r.amountDue).toBe('7999.00');
  });

  it('gives no credit when the paid period has already ended (or never existed)', () => {
    expect(prorate({ ...base, paidUntil: utc('2026-11-01'), effective: '2026-11-10' }).credit).toBe('0.00');
    expect(prorate({ ...base, paidUntil: null, effective: '2026-11-10' }).credit).toBe('0.00');
  });

  it('never credits more than one cycle, even if paid far ahead', () => {
    const r = prorate({ ...base, paidUntil: utc('2027-06-01'), effective: '2026-11-10' });
    expect(r.unusedDays).toBe(30);
    expect(r.credit).toBe('2999.00');
  });

  it('can cover the whole price: nothing to pay when moving to a cheaper plan', () => {
    const r = prorate({ ...base, currentPrice: '7999.00', targetPrice: '2999.00', paidUntil: utc('2026-12-10'), effective: '2026-11-10' });
    expect(r.credit).toBe('7999.00');
    expect(r.amountDue).toBe('0.00');
  });

  it('uses the new plan\'s own cycle length for the new period', () => {
    expect(prorate({ ...base, targetCycleDays: 365, paidUntil: null, effective: '2026-01-01' }).periodEnd).toBe('2027-01-01');
    expect(prorate({ ...base, targetCycleDays: 90, paidUntil: null, effective: '2026-01-01' }).periodEnd).toBe('2026-04-01');
  });

  it('is exact to the paisa with a yearly current plan', () => {
    const r = prorate({ currentPaid: true, currentPrice: '29990.00', currentCycleDays: 365, paidUntil: utc('2026-12-31'), effective: '2026-11-10', targetPrice: '7999.00', targetCycleDays: 30 });
    expect(r.unusedDays).toBe(51);
    expect(r.credit).toBe('4190.38');            // 51/365 × 29990
    expect(r.amountDue).toBe('3808.62');
  });
});

describe('helpers', () => {
  it('turns a billing cycle into a monthly figure for revenue totals', () => {
    expect(monthlyEquivalent('2999.00', 30)).toBe('2999.00');
    expect(monthlyEquivalent('8997.00', 90)).toBe('2999.00');
    expect(monthlyEquivalent('29990.00', 365)).toBe('2464.93');
  });
  it('makes a stable code from a plan name', () => {
    expect(planCodeFromName('Hotel Pro 2!')).toBe('HOTEL_PRO_2');
    expect(planCodeFromName('  bar & grill ')).toBe('BAR_GRILL');
    expect(planCodeFromName('!!!')).toBe('PLAN');
    expect(planCodeFromName('A very long plan name that goes on and on').length).toBeLessThanOrEqual(20);
  });
  it('adds calendar days without time-zone drift', () => {
    expect(addDaysIso('2026-02-27', 3)).toBe('2026-03-02');
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01');
  });
});
