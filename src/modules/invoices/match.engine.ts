/**
 * match.engine.ts — PURE: invoice line → catalog product.
 *
 * barcode exact → SKU exact (or exciseCode exact) → fuzzy name (weighted token Dice; brand tokens count double; OCR-tolerant tokens
 * and volumes). Confidence ≥ 0.85 → MATCHED, 0.60–0.85 → SUGGESTED (a person must confirm), else UNMATCHED.
 * Only active products are candidates.
 */

export type MatchStatus = 'MATCHED' | 'SUGGESTED' | 'UNMATCHED' | 'MANUAL';
export type MatchMethod = 'BARCODE' | 'SKU' | 'NAME' | 'MANUAL';

export const MATCHED_THRESHOLD = 0.85;
export const SUGGESTED_THRESHOLD = 0.6;

export interface CatalogProduct {
  id: string;
  name: string;
  brand: string;
  barcode: string | null;
  sku: string | null;
  exciseCode?: string | null;
  volumeMl: number | null;
  packQuantity: number | null;
  mrp: string;
  isActive: boolean;
}

export interface MatchInput {
  description: string;
  barcode?: string | null;
  sku?: string | null;
}

export interface MatchResult {
  productId: string | null;
  status: Exclude<MatchStatus, 'MANUAL'>;
  method: MatchMethod | null;
  confidence: number;
  /** Line flags raised by matching, e.g. VOLUME_DIFFERS. */
  flags: string[];
  /** Best alternatives (for the review UI). */
  candidates: Array<{ productId: string; name: string; confidence: number }>;
}

// Words that say little about WHICH product it is
const WEAK_TOKENS = new Set([
  'whisky', 'whiskey', 'rum', 'vodka', 'gin', 'brandy', 'beer', 'wine', 'lager', 'strong', 'premium', 'deluxe',
  'blended', 'special', 'reserve', 'classic', 'original', 'xxx', 'pet', 'bottle', 'btl', 'can', 'tin', 'pint',
  'quart', 'full', 'half', 'nip', 'ml', 'ltr', 'the', 'and', 'of', 'old', 'new', 'red', 'white', 'black', 'gold',
]);

/** Undo common OCR letter/digit swaps inside words that mix both ("01d" → "old", "5ignature" → "signature"). */
function deOcr(tok: string): string {
  if (!/[a-z]/.test(tok) || !/\d/.test(tok) || /^\d+(ml|l|ltr|cl)$/.test(tok)) return tok;
  return tok.replace(/0/g, 'o').replace(/1/g, 'l').replace(/5/g, 's').replace(/8/g, 'b');
}

/** Extracts a volume in ml ("750ml", "750 ml", "1L", "1.5 ltr", "75cl"). */
export function extractVolumeMl(text: string): number | null {
  const m = text.toLowerCase().match(/(\d+(?:\.\d+)?)\s*(ml|ltr|lt|l|cl)\b/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const ml = m[2] === 'ml' ? n : m[2] === 'cl' ? n * 10 : n * 1000;
  return ml > 0 && ml <= 20000 ? Math.round(ml) : null;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/(\d+(?:\.\d+)?)\s*(ml|ltr|lt|l|cl)\b/g, ' ')        // volumes handled separately
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length > 0)
    .map(deOcr)
    .filter((t) => !/^\d+$/.test(t) || t.length >= 3);
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** 1 = same token, 0.8 = one OCR-ish edit on a 5+ letter word, else 0. */
function tokenSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length >= 5 && b.length >= 5 && editDistance(a, b) <= 1) return 0.8;
  return 0;
}

/** Volumes equal → 1; one differing digit with same length (OCR: 720 vs 750) → 'ocr'; else 'diff'. */
export function compareVolumes(a: number | null, b: number | null): 'same' | 'unknown' | 'ocr' | 'diff' {
  if (a === null || b === null) return 'unknown';
  if (a === b) return 'same';
  const sa = String(a), sb = String(b);
  if (sa.length === sb.length && [...sa].filter((c, i) => c !== sb[i]).length === 1) return 'ocr';
  return 'diff';
}

/** Weighted Dice similarity of the line's tokens vs the product's brand+name tokens (0..1). */
export function nameScore(description: string, product: Pick<CatalogProduct, 'name' | 'brand'>): number {
  const lineTokens = [...new Set(tokenize(description))];
  const brandTokens = new Set(tokenize(product.brand));
  const prodTokens = [...new Set([...tokenize(product.brand), ...tokenize(product.name)])];
  if (lineTokens.length === 0 || prodTokens.length === 0) return 0;
  const weight = (t: string) => (brandTokens.has(t) ? 2 : WEAK_TOKENS.has(t) ? 0.5 : 1);
  const total = lineTokens.reduce((s, t) => s + weight(prodTokens.find((p) => tokenSimilarity(t, p) > 0) ?? t), 0)
    + prodTokens.reduce((s, t) => s + weight(t), 0);
  let common = 0;
  const used = new Set<string>();
  for (const t of lineTokens) {
    let best = 0, bestTok = '';
    for (const p of prodTokens) {
      if (used.has(p)) continue;
      const s = tokenSimilarity(t, p);
      if (s > best) { best = s; bestTok = p; }
    }
    if (best > 0) { used.add(bestTok); common += best * weight(bestTok) * 2; }
  }
  return Math.min(1, common / total);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function matchLine(line: MatchInput, catalog: CatalogProduct[]): MatchResult {
  const active = catalog.filter((p) => p.isActive);
  const barcode = line.barcode?.replace(/\s/g, '');
  if (barcode) {
    const p = active.find((c) => c.barcode && c.barcode === barcode);
    if (p) return { productId: p.id, status: 'MATCHED', method: 'BARCODE', confidence: 1, flags: [], candidates: [] };
  }
  const sku = line.sku?.trim().toLowerCase();
  if (sku) {
    const p = active.find((c) => (c.sku && c.sku.trim().toLowerCase() === sku) || (c.exciseCode && c.exciseCode.trim().toLowerCase() === sku));
    if (p) return { productId: p.id, status: 'MATCHED', method: 'SKU', confidence: 1, flags: [], candidates: [] };
  }

  const lineVol = extractVolumeMl(line.description);
  const scored = active.map((p) => {
    const base = nameScore(line.description, p);
    const vol = compareVolumes(lineVol, p.volumeMl ?? extractVolumeMl(p.name));
    let factor = 1;
    if (vol === 'unknown') factor = 0.95;
    else if (vol === 'ocr') factor = base >= 0.9 ? 0.92 : 0.6;   // tolerate a misread digit only when the name is a strong match
    else if (vol === 'diff') factor = 0.5;
    return { p, vol, confidence: round3(base * factor) };
  }).sort((a, b) => b.confidence - a.confidence);

  const candidates = scored.slice(0, 3).filter((s) => s.confidence > 0.3)
    .map((s) => ({ productId: s.p.id, name: s.p.name, confidence: s.confidence }));
  const best = scored[0];
  if (!best || best.confidence < SUGGESTED_THRESHOLD) {
    return { productId: null, status: 'UNMATCHED', method: null, confidence: best ? best.confidence : 0, flags: [], candidates };
  }
  const flags: string[] = [];
  if (best.vol === 'ocr') flags.push('VOLUME_DIFFERS');
  let status: MatchResult['status'] = best.confidence >= MATCHED_THRESHOLD ? 'MATCHED' : 'SUGGESTED';
  // Ambiguous: a runner-up almost as good → a person must choose
  const second = scored[1];
  if (status === 'MATCHED' && second && best.confidence - second.confidence < 0.05) status = 'SUGGESTED';
  return { productId: best.p.id, status, method: 'NAME', confidence: best.confidence, flags, candidates };
}
