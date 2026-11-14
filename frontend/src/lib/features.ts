/**
 * Which feature each page belongs to. Mirrors `pages` in src/modules/platform/features.engine.ts: a feature the Super Admin
 * switches off for a branch hides these pages there (the server refuses the requests as well).
 */
export const PAGE_FEATURE: Record<string, string> = {
  '/bank': 'bank',
  '/accounting': 'accounting',
  '/tables': 'bar',
  '/invoices': 'invoices',
  '/schemes': 'schemes',
  '/counter': 'counter_sheets',
  '/closing': 'closing',
  '/compliance': 'compliance',
};

/** Pages opened by a named permission rather than by rank: anyone who holds it can open the page, anyone who does not cannot. */
export const PAGE_PERMISSION: Record<string, string> = {
  '/accounting': 'accounting.view',
  '/bank': 'bank.reconcile',
  '/closing': 'day.close',
};

/** True when this page's feature is switched off for the branch. */
export function pageDisabled(path: string, disabledFeatures: string[] | undefined): boolean {
  const feature = PAGE_FEATURE[path];
  return !!feature && !!disabledFeatures?.includes(feature);
}
