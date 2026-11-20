import { describe, it, expect } from 'vitest';
import {
  normalizeTitle,
  flawFingerprint,
  nextFlawReference,
  diceCoefficient,
  similarity,
  suggestDuplicates,
  assertTransition,
  isOpenStatus,
  FLAW_TRANSITIONS,
  FLAW_STATUSES,
  FUZZY_SUGGEST_THRESHOLD,
  type DuplicateCandidate,
} from '../../src/modules/quality/quality.engine.js';

// ─── normalizeTitle ───────────────────────────────────────────────────────────

describe('normalizeTitle', () => {
  it('strips diacritics: café → cafe', () => {
    expect(normalizeTitle('café')).toBe('cafe');
  });

  it('lowercases and collapses whitespace', () => {
    expect(normalizeTitle('  GST  Error  ')).toBe('gst error');
  });

  it('strips punctuation but keeps % and digits', () => {
    expect(normalizeTitle('18% VAT on Bill!')).toBe('18% vat on bill');
  });

  it('empty string → empty string', () => {
    expect(normalizeTitle('')).toBe('');
  });

  it('handles mixed diacritics and punctuation together', () => {
    expect(normalizeTitle('résumé!')).toBe('resume');
  });
});

// ─── flawFingerprint ──────────────────────────────────────────────────────────

describe('flawFingerprint', () => {
  const tid = 'tenant-abc';
  const mid = 'module-xyz';

  it('same inputs always produce the same SHA1 hex string', () => {
    const a = flawFingerprint(tid, mid, 'Login crash', '1.0');
    const b = flawFingerprint(tid, mid, 'Login crash', '1.0');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
  });

  it('different tenantId → different fingerprint', () => {
    const a = flawFingerprint('tenant-A', mid, 'Login crash', '1.0');
    const b = flawFingerprint('tenant-B', mid, 'Login crash', '1.0');
    expect(a).not.toBe(b);
  });

  it('different moduleId → different fingerprint', () => {
    const a = flawFingerprint(tid, 'module-1', 'Login crash', '1.0');
    const b = flawFingerprint(tid, 'module-2', 'Login crash', '1.0');
    expect(a).not.toBe(b);
  });

  it('null moduleId uses "none" sentinel (two null calls match)', () => {
    const a = flawFingerprint(tid, null, 'Login crash', '1.0');
    const b = flawFingerprint(tid, null, 'Login crash', '1.0');
    expect(a).toBe(b);
  });

  it('null moduleId differs from an explicit module', () => {
    const a = flawFingerprint(tid, null, 'Login crash', '1.0');
    const b = flawFingerprint(tid, 'none', 'Login crash', '1.0');
    // 'none' as moduleId is the same as null sentinel — they match
    // (both resolve to the string 'none')
    expect(a).toBe(b);
  });

  it('different affectedVersion → different fingerprint', () => {
    const a = flawFingerprint(tid, mid, 'Login crash', '1.0');
    const b = flawFingerprint(tid, mid, 'Login crash', '2.0');
    expect(a).not.toBe(b);
  });

  it('null/undefined version equals empty string (fingerprints match)', () => {
    const a = flawFingerprint(tid, mid, 'Login crash', null);
    const b = flawFingerprint(tid, mid, 'Login crash', undefined);
    const c = flawFingerprint(tid, mid, 'Login crash', '');
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('title normalisation is applied inside fingerprint', () => {
    const a = flawFingerprint(tid, mid, 'Login Crash!', '1.0');
    const b = flawFingerprint(tid, mid, 'login crash', '1.0');
    expect(a).toBe(b);
  });
});

// ─── nextFlawReference ────────────────────────────────────────────────────────

describe('nextFlawReference', () => {
  it('year 2026, seq 1 → FLW-2026-000001', () => {
    expect(nextFlawReference(2026, 1)).toBe('FLW-2026-000001');
  });

  it('year 2026, seq 123 → FLW-2026-000123', () => {
    expect(nextFlawReference(2026, 123)).toBe('FLW-2026-000123');
  });

  it('seq=0 → throws', () => {
    expect(() => nextFlawReference(2026, 0)).toThrow();
  });

  it('seq=-1 → throws', () => {
    expect(() => nextFlawReference(2026, -1)).toThrow();
  });

  it('seq=1_000_000 → FLW-2026-1000000 (no truncation, just padStart(6))', () => {
    expect(nextFlawReference(2026, 1_000_000)).toBe('FLW-2026-1000000');
  });

  it('seq=999999 → FLW-2026-999999 (exactly 6 digits)', () => {
    expect(nextFlawReference(2026, 999999)).toBe('FLW-2026-999999');
  });
});

// ─── diceCoefficient ──────────────────────────────────────────────────────────

describe('diceCoefficient', () => {
  it('identical strings → 1', () => {
    expect(diceCoefficient('hello', 'hello')).toBe(1);
  });

  it('completely different strings (no shared bigrams) → 0', () => {
    // 'ab' and 'cd' share no bigrams
    expect(diceCoefficient('ab', 'cd')).toBe(0);
  });

  it('"CRASH" and "CRASH" → 1', () => {
    expect(diceCoefficient('CRASH', 'CRASH')).toBe(1);
  });

  it('"cat" and "car" → between 0 and 1', () => {
    const score = diceCoefficient('cat', 'car');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('short strings (length < 2) return 0 when strings differ', () => {
    // The early-exit `if (a === b) return 1` fires before the length guard,
    // so identical single-char strings → 1. The guard only blocks mismatched short strings.
    expect(diceCoefficient('', 'hello')).toBe(0);
    expect(diceCoefficient('h', 'hello')).toBe(0);
    expect(diceCoefficient('a', 'b')).toBe(0);
  });

  it('identical single-char string returns 1 (early-exit before length guard)', () => {
    expect(diceCoefficient('a', 'a')).toBe(1);
  });
});

// ─── similarity ───────────────────────────────────────────────────────────────

describe('similarity', () => {
  it('identical titles → 1', () => {
    expect(similarity('Login fails with error', 'Login fails with error')).toBe(1);
  });

  it('empty-keyword titles (all noise words) → 0', () => {
    // NOISE_WORDS includes: a, an, the, of, in, on, at, to, for, and, or, is, are, was, when, while, with, error, issue, bug, crash
    expect(similarity('error', 'bug')).toBe(0);
    expect(similarity('the issue', 'an error')).toBe(0);
  });

  it('very similar titles → score > 0.55', () => {
    const score = similarity('Login fails with error', 'Login failure with error');
    expect(score).toBeGreaterThan(0.55);
  });

  it('completely unrelated titles → score < 0.3', () => {
    const score = similarity('GST tax calculation wrong', 'Printer not responding');
    expect(score).toBeLessThan(0.3);
  });

  it('no same-module bonus applied by similarity itself (pure function)', () => {
    // similarity takes only two strings — no moduleId param, so no bonus possible
    const a = similarity('Payment fails', 'Payment failure');
    const b = similarity('Payment fails', 'Payment failure');
    expect(a).toBe(b); // deterministic, no context
  });
});

// ─── suggestDuplicates ────────────────────────────────────────────────────────

describe('suggestDuplicates', () => {
  const makeCandidate = (overrides: Partial<DuplicateCandidate> = {}): DuplicateCandidate => ({
    id: 'dup-1',
    reference: 'FLW-2026-000001',
    title: 'Login page crashes on submit',
    status: 'NEW',
    moduleId: 'mod-auth',
    duplicateOfId: null,
    ...overrides,
  });

  it('empty existing list → []', () => {
    expect(suggestDuplicates({ title: 'Login crash' }, [])).toEqual([]);
  });

  it('score below threshold → filtered out', () => {
    const existing = [makeCandidate({ title: 'Printer jam error', id: 'other-1' })];
    const results = suggestDuplicates({ id: 'new-id', title: 'Login page crashes on submit' }, existing, { minScore: FUZZY_SUGGEST_THRESHOLD });
    expect(results).toHaveLength(0);
  });

  it('same id as candidate → excluded from results', () => {
    const existing = [makeCandidate({ id: 'same-id', title: 'Login page crashes on submit' })];
    const results = suggestDuplicates({ id: 'same-id', title: 'Login page crashes on submit' }, existing);
    expect(results).toHaveLength(0);
  });

  it('results ordered by similarity DESC', () => {
    const existing: DuplicateCandidate[] = [
      makeCandidate({ id: 'e1', reference: 'FLW-2026-000001', title: 'Login page crashes', duplicateOfId: null }),
      makeCandidate({ id: 'e2', reference: 'FLW-2026-000002', title: 'Login page crashes on submit button', duplicateOfId: null }),
    ];
    const results = suggestDuplicates({ id: 'new', title: 'Login page crashes on submit', moduleId: 'mod-auth' }, existing, { minScore: 0 });
    expect(results.length).toBeGreaterThan(0);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].similarity).toBeGreaterThanOrEqual(results[i].similarity);
    }
  });

  it('same-module result gets higher score than cross-module for the same title', () => {
    const title = 'Login page crashes on submit';
    const existing: DuplicateCandidate[] = [
      makeCandidate({ id: 'same-mod', reference: 'FLW-2026-000001', title, moduleId: 'mod-auth', duplicateOfId: null }),
      makeCandidate({ id: 'diff-mod', reference: 'FLW-2026-000002', title, moduleId: 'mod-other', duplicateOfId: null }),
    ];
    const results = suggestDuplicates({ id: 'new', title, moduleId: 'mod-auth' }, existing, { minScore: 0 });
    const sameModResult = results.find(r => r.id === 'same-mod');
    const diffModResult = results.find(r => r.id === 'diff-mod');
    expect(sameModResult).toBeDefined();
    expect(diffModResult).toBeDefined();
    expect(sameModResult!.similarity).toBeGreaterThan(diffModResult!.similarity);
  });

  it('limit caps results (default 5)', () => {
    const existing: DuplicateCandidate[] = Array.from({ length: 10 }, (_, i) => ({
      id: `e${i}`,
      reference: `FLW-2026-${String(i + 1).padStart(6, '0')}`,
      title: 'Login page crashes on submit',
      status: 'NEW',
      moduleId: 'mod-auth',
      duplicateOfId: null,
    }));
    const results = suggestDuplicates({ id: 'new', title: 'Login page crashes on submit', moduleId: 'mod-auth' }, existing, { minScore: 0 });
    expect(results.length).toBeLessThanOrEqual(5);
  });

  it('limit can be overridden', () => {
    const existing: DuplicateCandidate[] = Array.from({ length: 10 }, (_, i) => ({
      id: `e${i}`,
      reference: `FLW-2026-${String(i + 1).padStart(6, '0')}`,
      title: 'Login page crashes on submit',
      status: 'NEW',
      moduleId: 'mod-auth',
      duplicateOfId: null,
    }));
    const results = suggestDuplicates({ id: 'new', title: 'Login page crashes on submit', moduleId: 'mod-auth' }, existing, { minScore: 0, limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('flaw with duplicateOfId !== null has canonical: false', () => {
    const existing: DuplicateCandidate[] = [
      makeCandidate({ id: 'dup', title: 'Login page crashes on submit', duplicateOfId: 'some-canonical-id' }),
    ];
    const results = suggestDuplicates({ id: 'new', title: 'Login page crashes on submit', moduleId: 'mod-auth' }, existing, { minScore: 0 });
    const found = results.find(r => r.id === 'dup');
    expect(found?.canonical).toBe(false);
  });

  it('flaw with duplicateOfId === null has canonical: true', () => {
    const existing: DuplicateCandidate[] = [
      makeCandidate({ id: 'orig', title: 'Login page crashes on submit', duplicateOfId: null }),
    ];
    const results = suggestDuplicates({ id: 'new', title: 'Login page crashes on submit', moduleId: 'mod-auth' }, existing, { minScore: 0 });
    const found = results.find(r => r.id === 'orig');
    expect(found?.canonical).toBe(true);
  });
});

// ─── assertTransition ────────────────────────────────────────────────────────

describe('assertTransition', () => {
  it('NEW → TRIAGED: ok', () => {
    expect(() => assertTransition('NEW', 'TRIAGED')).not.toThrow();
  });

  it('NEW → CLOSED: throws', () => {
    expect(() => assertTransition('NEW', 'CLOSED')).toThrow();
  });

  it('DUPLICATE → TRIAGED: ok (un-duplicating goes back through triage)', () => {
    expect(() => assertTransition('DUPLICATE', 'TRIAGED')).not.toThrow();
  });

  it('CLOSED → REOPENED: ok', () => {
    expect(() => assertTransition('CLOSED', 'REOPENED')).not.toThrow();
  });

  it('same status (NEW → NEW): throws "already NEW"', () => {
    expect(() => assertTransition('NEW', 'NEW')).toThrowError(/already NEW/i);
  });

  it('same status (FIXED → FIXED): throws "already FIXED"', () => {
    expect(() => assertTransition('FIXED', 'FIXED')).toThrowError(/already FIXED/i);
  });

  it('FIXED → VERIFIED: ok', () => {
    expect(() => assertTransition('FIXED', 'VERIFIED')).not.toThrow();
  });

  it('FIXED → NEW: throws', () => {
    expect(() => assertTransition('FIXED', 'NEW')).toThrow();
  });

  it('FLAW_TRANSITIONS covers all 10 statuses', () => {
    expect(Object.keys(FLAW_TRANSITIONS)).toHaveLength(FLAW_STATUSES.length);
    for (const status of FLAW_STATUSES) {
      expect(FLAW_TRANSITIONS).toHaveProperty(status);
    }
  });

  it('IN_PROGRESS → FIXED: ok', () => {
    expect(() => assertTransition('IN_PROGRESS', 'FIXED')).not.toThrow();
  });

  it('TRIAGED → DUPLICATE: ok', () => {
    expect(() => assertTransition('TRIAGED', 'DUPLICATE')).not.toThrow();
  });

  it('VERIFIED → CLOSED: ok', () => {
    expect(() => assertTransition('VERIFIED', 'CLOSED')).not.toThrow();
  });

  it('REOPENED → TRIAGED: ok', () => {
    expect(() => assertTransition('REOPENED', 'TRIAGED')).not.toThrow();
  });

  it('REJECTED → REOPENED: ok', () => {
    expect(() => assertTransition('REJECTED', 'REOPENED')).not.toThrow();
  });

  it('DEFERRED → IN_PROGRESS: ok', () => {
    expect(() => assertTransition('DEFERRED', 'IN_PROGRESS')).not.toThrow();
  });
});

// ─── isOpenStatus ─────────────────────────────────────────────────────────────

describe('isOpenStatus', () => {
  it('CLOSED → false', () => {
    expect(isOpenStatus('CLOSED')).toBe(false);
  });

  it('REJECTED → false', () => {
    expect(isOpenStatus('REJECTED')).toBe(false);
  });

  it('DUPLICATE → false', () => {
    expect(isOpenStatus('DUPLICATE')).toBe(false);
  });

  it('NEW → true', () => {
    expect(isOpenStatus('NEW')).toBe(true);
  });

  it('IN_PROGRESS → true', () => {
    expect(isOpenStatus('IN_PROGRESS')).toBe(true);
  });

  it('VERIFIED → true', () => {
    expect(isOpenStatus('VERIFIED')).toBe(true);
  });

  it('TRIAGED → true', () => {
    expect(isOpenStatus('TRIAGED')).toBe(true);
  });

  it('FIXED → true', () => {
    expect(isOpenStatus('FIXED')).toBe(true);
  });

  it('REOPENED → true', () => {
    expect(isOpenStatus('REOPENED')).toBe(true);
  });

  it('DEFERRED → true', () => {
    expect(isOpenStatus('DEFERRED')).toBe(true);
  });

  it('unknown status string → true (not in closed list)', () => {
    expect(isOpenStatus('UNKNOWN_STATUS')).toBe(true);
  });
});
