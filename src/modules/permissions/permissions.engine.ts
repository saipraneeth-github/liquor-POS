/**
 * permissions.engine.ts — PURE: who may do what.
 *
 * Roles give the defaults; a manager, office admin or owner can then switch single actions on or off for one user
 * (stored as overrides). Rules:
 *   - Owner and Office Admin (who runs the business on the owner's behalf) always have every permission: they cannot be restricted.
 *   - Manager defaults to everything, Cashier and Steward to nothing; any of them can be given or denied an action individually.
 *   - A CUSTOM role (made by the Super Admin) brings its own set of granted permissions instead of those defaults
 *     (`rolePerms`); the five built-in roles pass nothing and keep the defaults above.
 *   - Cashiers and stewards can additionally be limited to some sale types (Walk-in, Janata, ...).
 *   - Discounts above DISCOUNT_CAP_PCT need the `discount.unlimited` permission.
 *   - Cost prices (`cost.view`) are never shown to anyone without that permission.
 */
import type { UserRole } from '../auth/auth.service.js';

export const DISCOUNT_CAP_PCT = 5;

export const PERMISSIONS = [
  { key: 'cost.view', label: 'See cost prices and supplier invoices', description: 'Buying prices, margins, supplier invoices and the stock cost columns. Without it a user only sees selling prices.' },
  { key: 'prices.edit', label: 'Change selling prices', description: 'MRP and the prices of every sale type (Janata, ...).' },
  { key: 'sale_types.manage', label: 'Add, rename or switch off sale types', description: 'Business-wide: affects every outlet.' },
  { key: 'counter.opening', label: 'Change the opening stock on the counter sheet', description: 'For shops that do not bill every sale on the POS: correct the opening count of a bottle on a draft counter sheet. Every change is recorded with who made it.' },
  { key: 'stock.move', label: 'Split and move stock between sale types', description: 'Divide inventory between Walk-in, Janata and the other counters.' },
  { key: 'invoices.approve', label: 'Review, approve, reject or reverse supplier invoices', description: 'Also needs "See cost prices".' },
  { key: 'bills.void', label: 'Void bills', description: 'Reverses stock, credit and the books for a bill.' },
  { key: 'accounting.view', label: 'See accounting and reports', description: 'Ledgers, vouchers, trial balance, profit and loss, balance sheet, Tally export and the expense list.' },
  { key: 'accounting.post', label: 'Post journal entries and record expenses', description: 'Creates vouchers in the books. Also needs "See accounting and reports" to see the result.' },
  { key: 'bank.reconcile', label: 'Use bank reconciliation', description: 'Upload statements, match lines, post to the books and ignore lines.' },
  { key: 'day.close', label: 'Close the day', description: 'End-of-day closing: the cash, card, UPI and credit reconciliation.' },
  { key: 'discount.unlimited', label: `Give discounts above ${DISCOUNT_CAP_PCT}%`, description: `Without it a bill discount is capped at ${DISCOUNT_CAP_PCT}% of the bill.` },
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number]['key'];
export const PERMISSION_KEYS: readonly PermissionKey[] = PERMISSIONS.map((p) => p.key);
export type PermissionOverrides = Partial<Record<PermissionKey, boolean>>;

export function isPermissionKey(k: string): k is PermissionKey {
  return (PERMISSION_KEYS as readonly string[]).includes(k);
}

/** Owner and Office Admin: everything, always. */
export function isUnrestricted(role: string): boolean {
  return role === 'owner' || role === 'office_admin';
}

/**
 * What the role gets when nothing is overridden. `rolePerms` is the permission set of a custom role; leave it out (or null)
 * for a built-in role, which keeps the defaults: managers everything, cashiers and stewards nothing.
 */
export function defaultAllowed(role: string, key: PermissionKey, rolePerms?: readonly string[] | null): boolean {
  if (isUnrestricted(role)) return true;
  if (rolePerms) return rolePerms.includes(key);
  return role === 'manager';
}

export function can(role: string, overrides: PermissionOverrides, key: PermissionKey, rolePerms?: readonly string[] | null): boolean {
  if (isUnrestricted(role)) return true;
  const o = overrides[key];
  return o === undefined ? defaultAllowed(role, key, rolePerms) : o;
}

export function effectivePermissions(role: string, overrides: PermissionOverrides, rolePerms?: readonly string[] | null): Record<PermissionKey, boolean> {
  return Object.fromEntries(PERMISSION_KEYS.map((k) => [k, can(role, overrides, k, rolePerms)])) as Record<PermissionKey, boolean>;
}

/** Largest bill discount (% of the bill) the user may give; null = no cap. */
export function discountCapPct(role: string, overrides: PermissionOverrides, rolePerms?: readonly string[] | null): number | null {
  return can(role, overrides, 'discount.unlimited', rolePerms) ? null : DISCOUNT_CAP_PCT;
}

/** True when the discount is within the user's cap. Exact in paise: 5% of ₹1000.00 is ₹50.00. */
export function discountWithinCap(discount: string, subtotal: string, capPct: number | null): boolean {
  if (capPct === null) return true;
  const d = Math.round(Number(discount) * 100);
  const s = Math.round(Number(subtotal) * 100);
  if (!Number.isFinite(d) || !Number.isFinite(s)) return false;
  return d * 100 <= s * capPct;     // d/s <= cap/100, integers only
}

/** Only cashiers and stewards can be limited to some sale types; managers and above always see them all. */
export function restrictsSaleTypes(role: string): boolean {
  return role === 'cashier' || role === 'steward';
}

/** May this sale type be used? `allowed` = the user's restriction list (empty / null = no restriction). */
export function saleTypeAllowed(role: string, allowed: readonly string[] | null | undefined, saleTypeId: string): boolean {
  if (!restrictsSaleTypes(role)) return true;
  if (!allowed || allowed.length === 0) return true;
  return allowed.includes(saleTypeId);
}

/** An actor may only hand out permissions they hold themselves. Returns the keys they may not grant. */
export function notGrantable(actorRole: string, actorOverrides: PermissionOverrides, wanted: PermissionOverrides, actorRolePerms?: readonly string[] | null): PermissionKey[] {
  return PERMISSION_KEYS.filter((k) => wanted[k] === true && !can(actorRole, actorOverrides, k, actorRolePerms));
}

/** Combinations that make no sense, as messages. */
export function validateOverrides(role: string, overrides: PermissionOverrides, rolePerms?: readonly string[] | null): string[] {
  const problems: string[] = [];
  const eff = effectivePermissions(role, overrides, rolePerms);
  // Granting approval without cost access makes no sense. (A manager who merely loses cost access keeps the approval default,
  // but the routes need both, so they simply cannot approve.)
  if (overrides['invoices.approve'] === true && !eff['cost.view']) problems.push('Reviewing or approving supplier invoices also needs "See cost prices".');
  if (overrides['accounting.post'] === true && !eff['accounting.view']) problems.push('Posting entries also needs "See accounting and reports".');
  if (isUnrestricted(role) && Object.keys(overrides).length > 0) problems.push(`${role === 'owner' ? 'Owners' : 'Office admins'} always have every permission and cannot be restricted.`);
  return problems;
}

export type { UserRole };
