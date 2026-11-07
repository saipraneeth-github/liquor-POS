import { describe, it, expect } from 'vitest';
import {
  attentionItems, closingSteps, describeDuration, hourlyBuckets, khataAging, mergeAging, monthStartOf, paymentMix, percentChange,
  previousMonthStart, sameTimeYesterday, sumTotals, type AttentionInput,
} from '../../src/modules/dashboard/dashboard.engine.js';

const at = (iso: string) => new Date(iso);
// A store day in IST starts at 00:00+05:30, i.e. 18:30 UTC the evening before
const DAY_START = at('2026-11-06T18:30:00Z');

describe('hourlyBuckets', () => {
  it('buckets by the store day, not by UTC midnight', () => {
    const rows = [
      { at: at('2026-11-06T18:45:00Z'), total: '100.00' },    // 00:15 IST → hour 0
      { at: at('2026-11-07T04:29:59Z'), total: '50.50' },     // 09:59:59 IST → hour 9
      { at: at('2026-11-07T04:30:00Z'), total: '25.00' },     // 10:00 IST → hour 10
      { at: at('2026-11-07T04:40:00Z'), total: '75.25' },     // 10:10 IST → hour 10
    ];
    const h = hourlyBuckets(rows, DAY_START);
    expect(h).toHaveLength(24);
    expect(h[0]).toBe(100);
    expect(h[9]).toBe(50.5);
    expect(h[10]).toBe(100.25);
    expect(h.reduce((a, b) => a + b, 0)).toBe(250.75);
  });
  it('ignores anything outside the 24 hours', () => {
    const h = hourlyBuckets([{ at: at('2026-11-06T18:29:59Z'), total: '999' }, { at: at('2026-11-07T18:30:00Z'), total: '999' }], DAY_START);
    expect(h.every((v) => v === 0)).toBe(true);
  });
});

describe('sums and mix', () => {
  it('sums money exactly', () => expect(sumTotals([{ total: '0.10' }, { total: '0.20' }])).toBe('0.30'));
  it('splits by payment mode in a fixed order, with shares adding to ~100', () => {
    const mix = paymentMix([{ mode: 'CASH', total: '500' }, { mode: 'UPI', total: '300' }, { mode: 'CARD', total: '150' }, { mode: 'CREDIT', total: '50' }, { mode: null, total: '500' }]);
    expect(mix.map((m) => m.mode)).toEqual(['CASH', 'UPI', 'CARD', 'CREDIT']);
    expect(mix[0]).toEqual({ mode: 'CASH', total: '1000.00', share: 66.7 });   // 1,000 of 1,500; a bill with no mode counts as cash
    expect(mix.reduce((a, m) => a + m.share, 0)).toBeCloseTo(100, 0);
  });
  it('an empty day has zero shares, not NaN', () => {
    expect(paymentMix([]).every((m) => m.total === '0.00' && m.share === 0)).toBe(true);
  });
  it('percentChange is null when there is nothing to compare with', () => {
    expect(percentChange('122500', '108500')).toBe(12.9);
    expect(percentChange('90', '100')).toBe(-10);
    expect(percentChange('50', '0')).toBeNull();
  });
  it('compares with yesterday at the same point in the day', () => {
    const y = sameTimeYesterday(at('2026-11-06T18:30:00Z'), at('2026-11-07T15:42:00Z'), at('2026-11-05T18:30:00Z'));
    expect(y.toISOString()).toBe('2026-11-06T15:42:00.000Z');
  });
});

describe('khataAging — repayments settle the oldest purchases first', () => {
  const now = at('2026-11-07T00:00:00Z');
  const day = (n: number) => new Date(now.getTime() - n * 86_400_000);
  const amounts = (r: ReturnType<typeof khataAging>) => r.map((b) => b.amount);

  it('what remains is the newest purchases adding up to the balance', () => {
    // bought 1000 (80 days ago), 500 (40 days ago), 300 (10 days ago); balance 600 → 300 (10 d) + 300 of the 500 (40 d)
    const r = khataAging([{ amount: '1000', at: day(80) }, { amount: '500', at: day(40) }, { amount: '300', at: day(10) }], '600', now);
    expect(amounts(r)).toEqual(['300.00', '0.00', '300.00', '0.00']);
  });
  it('a balance with no purchase history is shown as the oldest bucket, not hidden', () => {
    expect(amounts(khataAging([{ amount: '200', at: day(5) }], '1000', now))).toEqual(['200.00', '0.00', '0.00', '800.00']);
    expect(amounts(khataAging([], '750', now))).toEqual(['0.00', '0.00', '0.00', '750.00']);
  });
  it('bucket edges: 15 days is still the first bucket, 16 the second, 61 the last', () => {
    expect(amounts(khataAging([{ amount: '1', at: day(15) }], '1', now))).toEqual(['1.00', '0.00', '0.00', '0.00']);
    expect(amounts(khataAging([{ amount: '1', at: day(16) }], '1', now))).toEqual(['0.00', '1.00', '0.00', '0.00']);
    expect(amounts(khataAging([{ amount: '1', at: day(61) }], '1', now))).toEqual(['0.00', '0.00', '0.00', '1.00']);
  });
  it('a zero balance owes nothing, whatever was bought', () => {
    expect(amounts(khataAging([{ amount: '500', at: day(3) }], '0', now))).toEqual(['0.00', '0.00', '0.00', '0.00']);
  });
  it('merges customers bucket by bucket', () => {
    const a = khataAging([{ amount: '100', at: day(2) }], '100', now);
    const b = khataAging([{ amount: '50', at: day(70) }], '50', now);
    expect(amounts(mergeAging([a, b]))).toEqual(['100.00', '0.00', '0.00', '50.00']);
  });
});

describe('time helpers', () => {
  it('describes durations', () => {
    expect(describeDuration(0)).toBe('0 m');
    expect(describeDuration(45)).toBe('45 m');
    expect(describeDuration(380)).toBe('6 h 20 m');
    expect(describeDuration(60)).toBe('1 h 0 m');
    expect(describeDuration(50 * 60 + 5)).toBe('2 d 2 h');
  });
  it('month starts', () => {
    expect(monthStartOf('2026-11-07')).toBe('2026-11-01');
    expect(previousMonthStart('2026-11-07')).toBe('2026-10-01');
    expect(previousMonthStart('2026-01-15')).toBe('2025-12-01');
  });
});

describe('attentionItems', () => {
  const NOW = at('2026-11-07T15:42:00Z');                       // 21:12 IST
  const base = (over: Partial<AttentionInput> = {}): AttentionInput => ({
    now: NOW, dayStart: DAY_START, role: 'manager', openShifts: [], yesterdayHadSales: true, yesterdayClosed: true, yesterdayDifference: '0.00',
    bankLinesToReview: 0, lowStock: [], ...over,
  });
  const shift = (hoursAgo: number, over: Partial<AttentionInput['openShifts'][number]> = {}) => ({
    terminalName: 'Counter 2', cashierName: 'Ravi', openedAt: new Date(NOW.getTime() - hoursAgo * 3_600_000), mine: false, ...over,
  });

  it('a calm day shows only the good news', () => {
    const items = attentionItems(base());
    expect(items).toEqual([expect.objectContaining({ id: 'yesterday-ok', severity: 'good' })]);
  });

  it('is ordered: bad, then warn, then good', () => {
    const items = attentionItems(base({
      yesterdayClosed: false, bankLinesToReview: 2, lowStock: [{ name: 'Kingfisher', quantity: 4 }, { name: 'Old Monk', quantity: 0 }],
    }));
    expect(items.map((i) => i.severity)).toEqual(['bad', 'bad', 'warn', 'warn']);
    expect(items.map((i) => i.id)).toEqual(['yesterday-open', 'out-of-stock', 'bank', 'low-stock']);
  });

  it('a shift open for a normal working stretch is NOT flagged; an unusually long one is', () => {
    expect(attentionItems(base({ openShifts: [shift(6)] })).some((i) => i.id === 'shift')).toBe(false);
    const warn = attentionItems(base({ openShifts: [shift(13)] })).find((i) => i.id === 'shift')!;
    expect(warn).toMatchObject({ severity: 'warn', title: 'Counter 2 shift still open', detail: 'Ravi, 13 h 0 m' });
  });

  it('a shift left open since yesterday is bad', () => {
    const item = attentionItems(base({ openShifts: [shift(30)] })).find((i) => i.id === 'shift')!;
    expect(item.severity).toBe('bad');
    expect(item.detail).toContain('since yesterday');
  });

  it('several long shifts are counted, the longest is named', () => {
    const item = attentionItems(base({ openShifts: [shift(13), shift(15, { cashierName: 'Asha', terminalName: 'Counter 1' })] })).find((i) => i.id === 'shift')!;
    expect(item.title).toBe('2 shifts still open');
    expect(item.detail).toContain('Asha');
  });

  it('a cashier sees only their own shift and stock, never the books', () => {
    const items = attentionItems(base({
      role: 'cashier', bankLinesToReview: 5, yesterdayClosed: false,
      openShifts: [shift(11, { mine: true, cashierName: 'Me' }), shift(20, { mine: false })],
      lowStock: [{ name: 'Tuborg', quantity: 3 }],
    }));
    expect(items.map((i) => i.id).sort()).toEqual(['low-stock', 'shift']);
    expect(items.find((i) => i.id === 'shift')!.title).toBe('Your shift has been open 11 h 0 m');
  });

  it('yesterday: not closed is bad, a cash difference is a warning, nothing sold is silent', () => {
    expect(attentionItems(base({ yesterdayClosed: false }))[0]).toMatchObject({ id: 'yesterday-open', severity: 'bad' });
    expect(attentionItems(base({ yesterdayDifference: '-150.00' }))[0]).toMatchObject({ id: 'yesterday-diff', severity: 'warn', detail: '₹150.00 short' });
    expect(attentionItems(base({ yesterdayDifference: '20.00' }))[0].detail).toBe('₹20.00 over');
    expect(attentionItems(base({ yesterdayHadSales: false, yesterdayClosed: false }))).toEqual([]);
  });

  it('names the stock problems and pluralises properly', () => {
    const one = attentionItems(base({ lowStock: [{ name: 'Kingfisher', quantity: 2 }] })).find((i) => i.id === 'low-stock')!;
    expect(one.title).toBe('1 item below reorder level');
    const many = attentionItems(base({ lowStock: [1, 2, 3, 4].map((n) => ({ name: `Item ${n}`, quantity: 1 })) })).find((i) => i.id === 'low-stock')!;
    expect(many.title).toBe('4 items below reorder level');
    expect(many.detail).toBe('Item 1, Item 2, Item 3');
  });
});

describe('closingSteps', () => {
  const none = { openShiftCount: 0, counterSheetInUse: false, counterSheetPosted: false, bankInUse: false, bankLinesToReview: 0, pourInUse: false, pourRecordedToday: false };
  it('lists only what this store uses', () => {
    expect(closingSteps(none).map((s) => s.id)).toEqual(['shifts']);
    expect(closingSteps({ ...none, counterSheetInUse: true, bankInUse: true, pourInUse: true }).map((s) => s.id)).toEqual(['shifts', 'counter', 'pour', 'bank']);
  });
  it('says what is left to do', () => {
    const steps = closingSteps({ ...none, openShiftCount: 2, counterSheetInUse: true, bankInUse: true, bankLinesToReview: 3 });
    expect(steps.map((s) => [s.label, s.done])).toEqual([
      ['Close 2 open shifts', false], ['Post today’s counter sheet', false], ['Review 3 bank lines', false],
    ]);
    const done = closingSteps({ ...none, counterSheetInUse: true, counterSheetPosted: true });
    expect(done.every((s) => s.done)).toBe(true);
  });
});
