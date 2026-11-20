/**
 * quality.engine.ts — PURE rules for the flaw (defect) tracker. No DB, no I/O.
 *
 * Everything here is deterministic and unit-tested: title normalisation, the exact-duplicate
 * fingerprint, fuzzy similarity scoring and the status machine. The service owns persistence.
 */

import { createHash } from 'node:crypto';

// ─── TITLES ──────────────────────────────────────────────────────────────────

/** Words that carry no signal when deciding whether two titles describe the same defect. */
const NOISE_WORDS = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'is', 'are', 'was', 'when', 'while', 'with', 'error', 'issue', 'bug', 'crash']);

/**
 * Normalises a title for comparison: lower-cased, accents folded, punctuation removed and runs of
 * whitespace collapsed. "GST shows 18% on A4 bill!" and "gst shows 18 on a4 bill" normalise alike.
 */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')          // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9%\s]/g, ' ')            // drop punctuation (keep % for tax rates)
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalised title with the noise words removed — used for fuzzy comparison, not for identity. */
export function titleKeywords(title: string): string[] {
  return normalizeTitle(title)
    .split(' ')
    .filter((w) => w.length > 0 && !NOISE_WORDS.has(w));
}

// ─── IDENTITY (exact duplicate blocking) ─────────────────────────────────────

/**
 * A flaw is identified by its tenant + module + normalised title + affected version. Two records
 * with the same fingerprint ARE the same defect, so the database rejects the second one (409).
 * The version is part of the identity so "crashes on login" in 1.0 and in 2.0 stay separate.
 */
export function flawFingerprint(tenantId: string, moduleId: string | null, title: string, affectedVersion?: string | null): string {
  const parts = [tenantId, moduleId ?? 'none', normalizeTitle(title), (affectedVersion ?? '').trim().toLowerCase()];
  return createHash('sha1').update(parts.join('|')).digest('hex');
}

/** FLW-2026-000123 — per tenant, per year. */
export function nextFlawReference(year: number, seq: number): string {
  if (!Number.isInteger(seq) || seq <= 0) throw new Error(`Invalid flaw sequence ${seq}`);
  return `FLW-${year}-${String(seq).padStart(6, '0')}`;
}

// ─── FUZZY MATCHING (suggestions only — a human decides) ─────────────────────

/** Sørensen–Dice over character bigrams: good at catching small typos in otherwise equal titles. */
export function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ba = bigrams(a);
  const bb = bigrams(b);
  let overlap = 0;
  for (const [g, n] of ba) overlap += Math.min(n, bb.get(g) ?? 0);
  return (2 * overlap) / (a.length - 1 + b.length - 1);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Similarity in [0, 1]: the average of token-set overlap (Jaccard) and bigram dice distance. */
export function similarity(a: string, b: string): number {
  const ka = titleKeywords(a);
  const kb = titleKeywords(b);
  if (ka.length === 0 || kb.length === 0) return 0;
  if (ka.join(' ') === kb.join(' ')) return 1;

  const sa = new Set(ka);
  const sb = new Set(kb);
  const intersection = [...sa].filter((x) => sb.has(x)).length;
  const union = new Set([...sa, ...sb]).size;
  const jaccard = union === 0 ? 0 : intersection / union;

  return round3((jaccard + diceCoefficient(normalizeTitle(a), normalizeTitle(b))) / 2);
}

/** At or above this score a record is offered as a possible duplicate (never applied automatically). */
export const FUZZY_SUGGEST_THRESHOLD = 0.55;

export interface DuplicateCandidate {
  id: string;
  reference: string;
  title: string;
  status: string;
  moduleId: string | null;
  duplicateOfId: string | null;
}

export interface DuplicateSuggestion extends DuplicateCandidate {
  similarity: number;
  /** The suggestion points at an already-canonical record. */
  canonical: boolean;
}

/**
 * Scores `existing` against `candidate` and returns the plausible duplicates, best first.
 * `limit` caps the list; `minScore` lets a caller ask for a wider net.
 */
export function suggestDuplicates(
  candidate: { id?: string; title: string; moduleId?: string | null },
  existing: DuplicateCandidate[],
  opts: { limit?: number; minScore?: number } = {},
): DuplicateSuggestion[] {
  const minScore = opts.minScore ?? FUZZY_SUGGEST_THRESHOLD;
  const limit = opts.limit ?? 5;
  return existing
    .filter((e) => e.id !== candidate.id)
    .map((e) => {
      // The same module is a strong signal; a different module weakens an otherwise good title match.
      const sameModule = candidate.moduleId != null && e.moduleId === candidate.moduleId;
      const base = similarity(candidate.title, e.title);
      const score = round3(sameModule ? base : base * 0.9);
      return { ...e, similarity: score, canonical: e.duplicateOfId === null };
    })
    .filter((e) => e.similarity >= minScore)
    .sort((a, b) => b.similarity - a.similarity || a.reference.localeCompare(b.reference))
    .slice(0, limit);
}

// ─── STATUS MACHINE ──────────────────────────────────────────────────────────

export const FLAW_STATUSES = ['NEW', 'TRIAGED', 'IN_PROGRESS', 'FIXED', 'VERIFIED', 'CLOSED', 'REOPENED', 'DUPLICATE', 'REJECTED', 'DEFERRED'] as const;
export type FlawStatus = (typeof FLAW_STATUSES)[number];

export const FLAW_SEVERITIES = ['BLOCKER', 'CRITICAL', 'MAJOR', 'MINOR', 'TRIVIAL'] as const;
export type FlawSeverity = (typeof FLAW_SEVERITIES)[number];

/** Which status a flaw may move to next. Anything not listed is refused (422). */
export const FLAW_TRANSITIONS: Record<FlawStatus, readonly FlawStatus[]> = {
  NEW:         ['TRIAGED', 'IN_PROGRESS', 'DUPLICATE', 'REJECTED', 'DEFERRED'],
  TRIAGED:     ['IN_PROGRESS', 'DUPLICATE', 'REJECTED', 'DEFERRED'],
  IN_PROGRESS: ['FIXED', 'TRIAGED', 'DEFERRED'],
  FIXED:       ['VERIFIED', 'IN_PROGRESS', 'REOPENED'],
  VERIFIED:    ['CLOSED', 'REOPENED', 'IN_PROGRESS'],
  CLOSED:      ['REOPENED'],
  REOPENED:    ['TRIAGED', 'IN_PROGRESS'],
  DUPLICATE:   ['TRIAGED'],          // un-duplicating goes back through triage
  REJECTED:    ['TRIAGED', 'REOPENED'],
  DEFERRED:    ['TRIAGED', 'IN_PROGRESS'],
};

/** Throws a plain Error (mapped to 422 by the service) when the move is not allowed. */
export function assertTransition(from: FlawStatus, to: FlawStatus): void {
  if (from === to) throw new Error(`Flaw is already ${to}`);
  if (!FLAW_TRANSITIONS[from].includes(to)) {
    throw new Error(`Cannot move a flaw from ${from} to ${to}`);
  }
}

/** Statuses that mean "nobody is working on this any more" — excluded from open-work counts. */
export const CLOSED_STATUSES: readonly FlawStatus[] = ['CLOSED', 'REJECTED', 'DUPLICATE'];

export function isOpenStatus(status: string): boolean {
  return !CLOSED_STATUSES.includes(status as FlawStatus);
}