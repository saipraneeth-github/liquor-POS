import { describe, it, expect } from 'vitest';
import {
  bottlesToCases,
  evaluateLifting,
  periodsOverlap,
} from '../../src/modules/compliance/lifting.engine.js';

const QUOTA = { quotaCases: 100, periodStart: '2026-10-01', periodEnd: '2026-10-31' };

describe('bottlesToCases', () => {
  it('uses packQuantity, defaulting to 12', () => {
    expect(bottlesToCases(48, 24).toFixed(2)).toBe('2.00');
    expect(bottlesToCases(24, null).toFixed(2)).toBe('2.00');
    expect(bottlesToCases(6, 0).toFixed(2)).toBe('0.50');
  });
});

describe('evaluateLifting', () => {
  it('mid-period, on track: no flags', () => {
    const r = evaluateLifting(QUOTA, [{ quantity: 600, packQuantity: 12 }], '2026-10-10');
    expect(r).toEqual({ liftedCases: '50.00', utilisationPct: '50.00', remainingCases: '50.00', daysLeft: 22, flags: [] });
  });

  it('EXPIRING when <= 7 days left and utilisation < 90%', () => {
    const r = evaluateLifting(QUOTA, [{ quantity: 1068, packQuantity: 12 }], '2026-10-25');   // 89 cases
    expect(r.daysLeft).toBe(7);
    expect(r.utilisationPct).toBe('89.00');
    expect(r.flags).toEqual(['EXPIRING']);
  });

  it('not EXPIRING when utilisation >= 90%', () => {
    const r = evaluateLifting(QUOTA, [{ quantity: 1080, packQuantity: 12 }], '2026-10-31');   // 90 cases
    expect(r.daysLeft).toBe(1);
    expect(r.flags).toEqual([]);
  });

  it('EXCEEDED when lifted > quota', () => {
    const r = evaluateLifting(QUOTA, [{ quantity: 1212, packQuantity: 12 }], '2026-10-15');
    expect(r.liftedCases).toBe('101.00');
    expect(r.utilisationPct).toBe('101.00');
    expect(r.remainingCases).toBe('0.00');
    expect(r.flags).toEqual(['EXCEEDED']);
  });

  it('EXPIRED_UNMET after the period when under quota', () => {
    const r = evaluateLifting(QUOTA, [{ quantity: 120, packQuantity: 12 }], '2026-11-02');
    expect(r.daysLeft).toBe(0);
    expect(r.flags).toEqual(['EXPIRED_UNMET']);
  });

  it('met exactly after expiry has no flags', () => {
    const r = evaluateLifting(QUOTA, [{ quantity: 1200, packQuantity: 12 }], '2026-11-02');
    expect(r.flags).toEqual([]);
  });

  it('before the period starts, daysLeft is the full period length', () => {
    expect(evaluateLifting(QUOTA, [], '2026-09-01').daysLeft).toBe(31);
  });

  it('a short quota that has not started yet is not EXPIRING (period not running)', () => {
    const week = { quotaCases: 10, periodStart: '2026-11-01', periodEnd: '2026-11-05' };
    const r = evaluateLifting(week, [], '2026-10-20');
    expect(r.daysLeft).toBe(5);
    expect(r.flags).toEqual([]);
  });

  it('mixes pack sizes and the 12/case default', () => {
    const r = evaluateLifting(QUOTA, [
      { quantity: 24, packQuantity: 24 },   // 1 case
      { quantity: 18, packQuantity: null }, // 1.5 cases
    ], '2026-10-01');
    expect(r.liftedCases).toBe('2.50');
  });

  it('rejects an inverted period', () => {
    expect(() => evaluateLifting({ ...QUOTA, periodEnd: '2026-09-30' }, [], '2026-10-01')).toThrow();
  });
});

describe('periodsOverlap', () => {
  it('detects inclusive overlap', () => {
    expect(periodsOverlap('2026-10-01', '2026-10-31', '2026-10-31', '2026-11-05')).toBe(true);
    expect(periodsOverlap('2026-10-01', '2026-10-31', '2026-11-01', '2026-11-05')).toBe(false);
    expect(periodsOverlap('2026-10-01', '2026-10-31', '2026-09-01', '2026-09-30')).toBe(false);
  });
});
