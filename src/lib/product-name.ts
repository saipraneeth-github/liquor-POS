/**
 * src/lib/product-name.ts
 *
 * Cleans product descriptions and names by stripping case/bottle quantity notations.
 * Examples:
 *   "BUDWEISER KING OF BEERS [29 cs + 10 btls]" -> "BUDWEISER KING OF BEERS"
 *   "KING FISHER PREMIUM LAGER BEER [50 cs]"     -> "KING FISHER PREMIUM LAGER BEER"
 *   "HAYWARDS 5000 SUPER STRONG BEER (50 cs)"   -> "HAYWARDS 5000 SUPER STRONG BEER"
 *   "ROYAL STAG DELUXE 50 cs"                   -> "ROYAL STAG DELUXE"
 */

export function cleanProductName(desc: string | null | undefined): string {
  if (!desc) return '';
  return desc
    // [29 cs + 10 btls], [50 cs], [10cs+5b], etc.
    .replace(/\s*\[\s*\d+\s*cs(?:\s*\+\s*\d+\s*(?:btls?|b|bottles?)?)?\s*\]/gi, '')
    // (29 cs + 10 btls), (50 cs), etc.
    .replace(/\s*\(\s*\d+\s*cs(?:\s*\+\s*\d+\s*(?:btls?|b|bottles?)?)?\s*\)/gi, '')
    // Trailing "50 cs", "50cs", "29 cs + 10 btls"
    .replace(/\s+\d+\s*cs(?:\s*\+\s*\d+\s*(?:btls?|b|bottles?)?)?\b/gi, '')
    .trim();
}
