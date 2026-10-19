/**
 * Phase 3 — Supplier Scheme Engine Tests (TDD — written BEFORE implementation)
 * Tests cover: scheme progress %, threshold alert detection, slab-based reward
 */

import { describe, it, expect } from 'vitest';
import { Decimal } from 'decimal.js';
import {
  computeSchemeProgress,
  isSchemeAlertTriggered,
  selectSlab,
  type Scheme,
  type SchemeSlab,
} from '../../src/modules/schemes/scheme.engine';

const makeScheme = (target: string, current: string, targetType: 'VALUE' | 'QTY' = 'VALUE'): Scheme => ({
  id: 'scheme-1',
  supplierName: 'United Spirits',
  branchId: 'branch-1',
  targetType,
  targetValue: new Decimal(target),
  currentValue: new Decimal(current),
  rewardDescription: '3% cashback',
  startDate: new Date('2026-10-01'),
  endDate: new Date('2026-10-31'),
});

describe('scheme.engine — computeSchemeProgress', () => {
  it('returns 0% when nothing purchased', () => {
    const scheme = makeScheme('100000', '0');
    expect(computeSchemeProgress(scheme).toNumber()).toBe(0);
  });

  it('returns 50% when halfway to target', () => {
    const scheme = makeScheme('100000', '50000');
    expect(computeSchemeProgress(scheme).toNumber()).toBe(50);
  });

  it('returns 100% when exactly at target', () => {
    const scheme = makeScheme('100000', '100000');
    expect(computeSchemeProgress(scheme).toNumber()).toBe(100);
  });

  it('caps at 100% when over target', () => {
    const scheme = makeScheme('100000', '120000');
    expect(computeSchemeProgress(scheme).toNumber()).toBe(100);
  });

  it('works for QTY-type schemes', () => {
    const scheme = makeScheme('200', '75', 'QTY');
    // 75/200 = 37.5%
    expect(computeSchemeProgress(scheme).toNumber()).toBe(37.5);
  });
});

describe('scheme.engine — isSchemeAlertTriggered', () => {
  it('triggers alert when progress >= alertThreshold (default 80%)', () => {
    const scheme = makeScheme('100000', '85000');
    expect(isSchemeAlertTriggered(scheme)).toBe(true);
  });

  it('does NOT trigger alert when below threshold', () => {
    const scheme = makeScheme('100000', '70000');
    expect(isSchemeAlertTriggered(scheme)).toBe(false);
  });

  it('triggers alert at exactly the threshold', () => {
    const scheme = makeScheme('100000', '80000');
    expect(isSchemeAlertTriggered(scheme)).toBe(true);
  });

  it('supports custom alert threshold', () => {
    const scheme = makeScheme('100000', '60000');
    expect(isSchemeAlertTriggered(scheme, 60)).toBe(true);
    expect(isSchemeAlertTriggered(scheme, 65)).toBe(false);
  });
});

describe('scheme.engine — selectSlab', () => {
  const slabs: SchemeSlab[] = [
    { minValue: new Decimal('0'),      maxValue: new Decimal('50000'),  reward: '1% cashback' },
    { minValue: new Decimal('50001'),  maxValue: new Decimal('100000'), reward: '2% cashback' },
    { minValue: new Decimal('100001'), maxValue: null,                  reward: '3% cashback + gift' },
  ];

  it('selects correct slab for value in first range', () => {
    const result = selectSlab(new Decimal('30000'), slabs);
    expect(result?.reward).toBe('1% cashback');
  });

  it('selects correct slab for value in second range', () => {
    const result = selectSlab(new Decimal('75000'), slabs);
    expect(result?.reward).toBe('2% cashback');
  });

  it('selects top slab for value exceeding all fixed ranges', () => {
    const result = selectSlab(new Decimal('150000'), slabs);
    expect(result?.reward).toBe('3% cashback + gift');
  });

  it('returns null when no slabs defined', () => {
    const result = selectSlab(new Decimal('50000'), []);
    expect(result).toBeNull();
  });
});
