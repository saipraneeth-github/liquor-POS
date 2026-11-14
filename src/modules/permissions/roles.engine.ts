/**
 * roles.engine.ts — PURE: the rules for roles.
 *
 * A role is a LEVEL (what the 138 route guards see: steward, cashier or manager for a custom role), a set of granted
 * PERMISSIONS, and default PAGES for the menu. The five built-in roles are fixed; the Super Admin can add custom ones,
 * up to manager level, so a custom role can never be more than a business Admin allows.
 */
import { PERMISSIONS, PERMISSION_KEYS, isPermissionKey, type PermissionKey } from './permissions.engine.js';

/** The levels a custom role may have. Never office admin or owner. */
export const CUSTOM_LEVELS = ['steward', 'cashier', 'manager'] as const;
export type CustomLevel = (typeof CUSTOM_LEVELS)[number];
export const isCustomLevel = (v: string): v is CustomLevel => (CUSTOM_LEVELS as readonly string[]).includes(v);

export const BUILT_IN_ROLE_KEYS = ['owner', 'office_admin', 'manager', 'cashier', 'steward'] as const;

/** The permissions, grouped the way the role editor shows them. Every permission is in exactly one group. */
export const PERMISSION_GROUPS: { id: string; label: string; keys: PermissionKey[] }[] = [
  { id: 'costs', label: 'Costs and prices', keys: ['cost.view', 'prices.edit', 'discount.unlimited'] },
  { id: 'billing', label: 'Billing', keys: ['bills.void'] },
  { id: 'stock', label: 'Stock and sale types', keys: ['sale_types.manage', 'stock.move', 'counter.opening'] },
  { id: 'invoices', label: 'Supplier invoices', keys: ['invoices.approve'] },
  { id: 'accounting', label: 'Accounting', keys: ['accounting.view', 'accounting.post'] },
  { id: 'bank', label: 'Bank reconciliation', keys: ['bank.reconcile'] },
  { id: 'closing', label: 'Day closing', keys: ['day.close'] },
];

/** The pages a role can be given by default. (Business Settings and the Platform console are never in a custom role.) */
export const ROLE_PAGES: { key: string; label: string }[] = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'pos', label: 'Billing (POS)' },
  { key: 'shift', label: 'Cashier Shift' },
  { key: 'bills', label: 'Bills' },
  { key: 'tables', label: 'Tables & Orders (KOT)' },
  { key: 'customers', label: 'Customers' },
  { key: 'menu/kitchen', label: 'Kitchen Menu' },
  { key: 'menu/bar', label: 'Bar Menu' },
  { key: 'products', label: 'Products' },
  { key: 'inventory', label: 'Inventory and invoices' },
  { key: 'counter', label: 'Counter Stock Sheet' },
  { key: 'pour', label: 'Peg Control' },
  { key: 'schemes', label: 'Supplier Schemes' },
  { key: 'compliance', label: 'Excise & Breakage' },
  { key: 'accounting', label: 'Accounting' },
  { key: 'bank', label: 'Match Bank Statement' },
  { key: 'closing', label: 'Day Closing' },
  { key: 'admin', label: 'Staff & Billing Counters' },
];
const PAGE_KEYS = ROLE_PAGES.map((p) => p.key);
export const isRolePage = (k: string) => PAGE_KEYS.includes(k);

export interface RoleDraft {
  name: string;
  level: string;
  permissions: string[];
  pages: string[] | null;
}

/** Why a role cannot be saved as it stands (empty = fine). */
export function validateRole(d: RoleDraft): string[] {
  const problems: string[] = [];
  if (!isCustomLevel(d.level)) problems.push('A custom role can be steward, cashier or manager level only.');
  const unknown = d.permissions.filter((k) => !isPermissionKey(k));
  if (unknown.length) problems.push(`Unknown permission: ${unknown.join(', ')}.`);
  const set = new Set(d.permissions);
  // Same rule as for a single person: approving supplier invoices means seeing their costs
  if (set.has('invoices.approve') && !set.has('cost.view')) problems.push('Reviewing or approving supplier invoices also needs "See cost prices".');
  if (set.has('accounting.post') && !set.has('accounting.view')) problems.push('Posting entries also needs "See accounting and reports".');
  if (d.pages) {
    const badPages = d.pages.filter((k) => !isRolePage(k));
    if (badPages.length) problems.push(`Unknown page: ${badPages.join(', ')}.`);
  }
  return problems;
}

/** The granted permissions in a stable order, without duplicates. */
export function normalisePermissions(keys: string[]): PermissionKey[] {
  const set = new Set(keys);
  return PERMISSION_KEYS.filter((k) => set.has(k));
}

/** The stable code a custom role is stored under: "Counter Lead!" → "counter_lead". */
export function roleKeyFromName(name: string): string {
  const key = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
  return key || 'role';
}

/** What a role gives, as a summary the list can show: "3 of 7 permissions". */
export function permissionSummary(granted: readonly string[]): { granted: number; total: number } {
  return { granted: PERMISSION_KEYS.filter((k) => granted.includes(k)).length, total: PERMISSION_KEYS.length };
}

/** For the editor: which group each permission is in, with its label. */
export function permissionCatalog() {
  return PERMISSION_GROUPS.map((g) => ({
    id: g.id, label: g.label,
    permissions: g.keys.map((k) => { const p = PERMISSIONS.find((x) => x.key === k)!; return { key: p.key, label: p.label, description: p.description }; }),
  }));
}
