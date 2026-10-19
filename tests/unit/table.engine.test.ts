/**
 * Phase 3 — Table Management Engine Tests (TDD — written BEFORE implementation)
 * Tests cover: table status state machine, session lifecycle, double-occupation guard
 */

import { describe, it, expect } from 'vitest';
import {
  canOpenTable,
  canCloseTable,
  transitionTableStatus,
  validateStewardAssignment,
  TableStatus,
} from '../../src/modules/tables/table.engine';

describe('table.engine — status state machine', () => {
  it('FREE table can be opened (→ OCCUPIED)', () => {
    expect(canOpenTable('FREE')).toBe(true);
  });

  it('OCCUPIED table cannot be re-opened (prevent double-occupation)', () => {
    expect(canOpenTable('OCCUPIED')).toBe(false);
  });

  it('RESERVED table can be opened (→ OCCUPIED)', () => {
    expect(canOpenTable('RESERVED')).toBe(true);
  });

  it('OCCUPIED table can be closed (→ FREE)', () => {
    expect(canCloseTable('OCCUPIED')).toBe(true);
  });

  it('FREE table cannot be closed', () => {
    expect(canCloseTable('FREE')).toBe(false);
  });

  it('transitionTableStatus: FREE → OCCUPIED returns OCCUPIED', () => {
    expect(transitionTableStatus('FREE', 'open')).toBe<TableStatus>('OCCUPIED');
  });

  it('transitionTableStatus: OCCUPIED → FREE returns FREE on close', () => {
    expect(transitionTableStatus('OCCUPIED', 'close')).toBe<TableStatus>('FREE');
  });

  it('transitionTableStatus: OCCUPIED → open throws error (double-occupation)', () => {
    expect(() => transitionTableStatus('OCCUPIED', 'open')).toThrow(
      /already occupied/i
    );
  });

  it('transitionTableStatus: FREE → close throws error', () => {
    expect(() => transitionTableStatus('FREE', 'close')).toThrow(
      /not occupied/i
    );
  });
});

describe('table.engine — steward assignment', () => {
  it('valid steward UUID passes validation', () => {
    expect(() =>
      validateStewardAssignment('3f2504e0-4f89-11d3-9a0c-0305e82c3301')
    ).not.toThrow();
  });

  it('null stewardId is allowed (unassigned table)', () => {
    expect(() => validateStewardAssignment(null)).not.toThrow();
  });

  it('empty string stewardId throws', () => {
    expect(() => validateStewardAssignment('')).toThrow(/invalid steward/i);
  });
});
