/**
 * features.engine.ts — the features a Super Admin can switch off for one branch, and which URLs belong to each.
 * Pure: no database, no framework.
 *
 * Only features with a clean boundary are listed. POS billing, shifts, products, inventory and users are not
 * switchable, and neither are sale types or customer credit: the POS screen depends on them while billing.
 */

export interface FeatureDef {
  key: string;
  label: string;
  description: string;
  /** URL prefixes (after /api/v1) that belong to the feature. Matched on whole path segments. */
  prefixes: string[];
  /** Pages (frontend routes) that disappear when it is off. */
  pages: string[];
}

export const FEATURES: FeatureDef[] = [
  { key: 'bank', label: 'Bank reconciliation', description: 'Upload bank statements and match them to the books.', prefixes: ['/bank'], pages: ['/bank'] },
  { key: 'accounting', label: 'Accounting and expenses', description: 'Ledgers, vouchers, trial balance, Tally export and expenses.', prefixes: ['/accounting', '/expenses'], pages: ['/accounting'] },
  { key: 'bar', label: 'Bar tables and KOT', description: 'Table service and kitchen / bar order tickets.', prefixes: ['/tables', '/kot'], pages: ['/tables'] },
  { key: 'invoices', label: 'Supplier invoices', description: 'Upload, review and approve supplier bills (stock inward).', prefixes: ['/invoices'], pages: ['/invoices'] },
  { key: 'schemes', label: 'Supplier schemes', description: 'Scheme purchases, slabs and payouts.', prefixes: ['/schemes'], pages: ['/schemes'] },
  { key: 'counter_sheets', label: 'Counter stock sheets', description: 'Daily counter sheets for counter-sheet sales.', prefixes: ['/counter-sheets'], pages: ['/counter'] },
  { key: 'closing', label: 'Day closing', description: 'End-of-day cash, card, UPI and credit reconciliation.', prefixes: ['/closing'], pages: ['/closing'] },
  { key: 'compliance', label: 'Excise compliance', description: 'Excise quotas, lifting and the stock audit trail.', prefixes: ['/compliance/quotas', '/compliance/lifting', '/compliance/stock-audit'], pages: ['/compliance'] },
];

export const FEATURE_KEYS = FEATURES.map((f) => f.key);
export const isFeatureKey = (k: string) => FEATURE_KEYS.includes(k);

const API = '/api/v1';

/** The feature a request path belongs to, or null when it is not a switchable one. */
export function featureForPath(url: string): string | null {
  const path = url.split('?')[0];
  const rel = path.startsWith(API) ? path.slice(API.length) : path;
  for (const f of FEATURES) {
    if (f.prefixes.some((p) => rel === p || rel.startsWith(`${p}/`))) return f.key;
  }
  return null;
}

/** The feature a frontend page belongs to, or null. */
export function featureForPage(page: string): string | null {
  return FEATURES.find((f) => f.pages.includes(page))?.key ?? null;
}
