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
  costPrice?: string | null;
  isActive: boolean;
}

export interface MatchInput {
  description: string;
  barcode?: string | null;
  sku?: string | null;
  /** Volume in ml extracted from the invoice table (e.g. the Qty/Size(ml) column in ICDC).
   *  Used as a fallback when the product description does not contain a volume string. */
  volumeMl?: number | null;
}

export interface MatchResult {
  productId: string | null;
  status: Exclude<MatchStatus, 'MANUAL'>;
  method: MatchMethod | null;
  confidence: number;
  /** Line flags raised by matching, e.g. VOLUME_DIFFERS. */
  flags: string[];
  /** Best alternatives (for the review UI). */
  candidates: Array<{ productId: string; name: string; confidence: number; volumeMl?: number | null }>;
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
export function extractVolumeMl(text: string | null | undefined): number | null {
  if (!text) return null;
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

/** Catalog volume: the column, else an "NNNml" in the product name. */
function catalogVolume(p: CatalogProduct): number | null {
  return p.volumeMl ?? extractVolumeMl(p.name);
}

function candidateOf(p: CatalogProduct, confidence: number) {
  return { productId: p.id, name: p.name, confidence, volumeMl: catalogVolume(p) };
}

export function normalizeBrandCode(code: string): string {
  return code.trim().toLowerCase().replace(/^0+/, '') || '0';
}

export function isBrandCodeEqual(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  const aClean = a.trim().toLowerCase();
  const bClean = b.trim().toLowerCase();
  if (aClean === bClean) return true;
  return normalizeBrandCode(aClean) === normalizeBrandCode(bClean);
}

/**
 * Matching rules (every path that matches an invoice line — upload, new line, manual draft — must pass the brand
 * code and volume it has, so the same rules apply everywhere):
 *  1. Brand code (sku / excise code) + volume is the hard key. The same code exists in several sizes, so a code
 *     with a different (or unknown) volume NEVER auto-matches.
 *  2. A name match can only auto-MATCH when the volume is known on both sides and equal. An unknown volume or a
 *     one-digit "typo" volume (650/750, 275/375 are real sizes!) is at most SUGGESTED — a person must confirm.
 *  3. Two catalog products with the same code and volume are ambiguous → nothing is picked.
 */
export function matchLine(line: MatchInput, catalog: CatalogProduct[]): MatchResult {
  const active = catalog.filter((p) => p.isActive !== false);
  // Prefer volume from the description; fall back to the structured volumeMl field
  // (e.g. the Qty/Size(ml) column in Telangana ICDC invoices where the brand name has no ml suffix).
  const lineVol = extractVolumeMl(line.description) ?? line.volumeMl ?? null;
  const barcode = line.barcode?.replace(/\s/g, '');
  if (barcode) {
    const hits = active.filter((c) => c.barcode && c.barcode === barcode);
    // A real barcode identifies one pack; if the volumes are both known and differ it is not this product
    const p = hits.find((c) => {
      const v = catalogVolume(c);
      return lineVol === null || v === null || v === lineVol;
    });
    if (p && hits.length === 1) return { productId: p.id, status: 'MATCHED', method: 'BARCODE', confidence: 1, flags: [], candidates: [] };
  }
  const sku = line.sku?.trim().toLowerCase();
  if (sku) {
    const exactSku = active.filter((c) => c.sku && isBrandCodeEqual(c.sku, sku));
    const skuMatches = active.filter(
      (c) =>
        (c.sku && isBrandCodeEqual(c.sku, sku)) ||
        (c.exciseCode && isBrandCodeEqual(c.exciseCode, sku)),
    );
    if (skuMatches.length > 0) {
      const all = skuMatches.map((p) => candidateOf(p, 0.5));
      if (lineVol) {
        // Hard rule: along with brand number (exciseCode), you also MUST verify ML!
        // Same brand number can have different ML (e.g. 180ml vs 750ml).
        const volMatches = skuMatches.filter((c) => catalogVolume(c) === lineVol);
        if (volMatches.length === 1) {
          return { productId: volMatches[0].id, status: 'MATCHED', method: 'SKU', confidence: 1, flags: [], candidates: [] };
        }
        if (volMatches.length > 1) {
          return { productId: null, status: 'UNMATCHED', method: null, confidence: 0, flags: ['AMBIGUOUS_MATCH'], candidates: volMatches.map((p) => candidateOf(p, 0.9)) };
        }
        // Brand code matched but volume differs: DO NOT match a different ML!
        return { productId: null, status: 'UNMATCHED', method: null, confidence: 0, flags: ['VOLUME_DIFFERS'], candidates: all };
      }
      // No volume on the line: only an exact product SKU (a unique key) may match on its own; a brand code alone
      // cannot say which size it is.
      if (exactSku.length === 1) {
        return { productId: exactSku[0].id, status: 'MATCHED', method: 'SKU', confidence: 1, flags: [], candidates: [] };
      }
      return { productId: null, status: 'UNMATCHED', method: null, confidence: 0, flags: ['VOLUME_MISSING'], candidates: all };
    }
  }
  const scored = active.map((p) => {
    const base = nameScore(line.description, p);
    const vol = compareVolumes(lineVol, catalogVolume(p));
    let factor = 1;
    if (vol === 'unknown') factor = 0.95;
    else if (vol === 'ocr') factor = base >= 0.9 ? 0.92 : 0.6;   // a misread digit is possible in free text — suggest only
    else if (vol === 'diff') factor = 0.5;
    return { p, vol, confidence: round3(base * factor) };
  }).sort((a, b) => b.confidence - a.confidence);

  const candidates = scored.slice(0, 3).filter((s) => s.confidence > 0.3)
    .map((s) => candidateOf(s.p, s.confidence));
  const best = scored[0];
  if (!best || best.confidence < SUGGESTED_THRESHOLD) {
    return { productId: null, status: 'UNMATCHED', method: null, confidence: best ? best.confidence : 0, flags: [], candidates };
  }
  const flags: string[] = [];
  if (best.vol === 'ocr') flags.push('VOLUME_DIFFERS');
  if (best.vol === 'unknown') flags.push('VOLUME_UNVERIFIED');
  let status: MatchResult['status'] = best.confidence >= MATCHED_THRESHOLD ? 'MATCHED' : 'SUGGESTED';
  // Only a name match whose volume is known and equal may be auto-confirmed
  if (status === 'MATCHED' && best.vol !== 'same') status = 'SUGGESTED';
  // Ambiguous: a runner-up almost as good → a person must choose
  const second = scored[1];
  if (status === 'MATCHED' && second && best.confidence - second.confidence < 0.05) status = 'SUGGESTED';
  return { productId: best.p.id, status, method: 'NAME', confidence: best.confidence, flags, candidates };
}
