/**
 * permissions.engine.ts — PURE: who may do what.
 *
 * Roles give the defaults; a manager, office admin or owner can then switch single actions on or off for one user
 * (stored as overrides). Rules:
 *   - Owner and Office Admin (who runs the business on the owner's behalf) always have every permission: they cannot be restricted.
 *   - Manager defaults to everything, Cashier and Steward to nothing; any of them can be given or denied an action individually.
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
  { key: 'stock.move', label: 'Split and move stock between sale types', description: 'Divide inventory between Walk-in, Janata and the other counters.' },
  { key: 'invoices.approve', label: 'Review, approve, reject or reverse supplier invoices', description: 'Also needs "See cost prices".' },
  { key: 'bills.void', label: 'Void bills', description: 'Reverses stock, credit and the books for a bill.' },
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

/** What the role gets when nothing is overridden. */
export function defaultAllowed(role: string, _key: PermissionKey): boolean {
  return isUnrestricted(role) || role === 'manager';
}

export function can(role: string, overrides: PermissionOverrides, key: PermissionKey): boolean {
  if (isUnrestricted(role)) return true;
  const o = overrides[key];
  return o === undefined ? defaultAllowed(role, key) : o;
}

export function effectivePermissions(role: string, overrides: PermissionOverrides): Record<PermissionKey, boolean> {
  return Object.fromEntries(PERMISSION_KEYS.map((k) => [k, can(role, overrides, k)])) as Record<PermissionKey, boolean>;
}

/** Largest bill discount (% of the bill) the user may give; null = no cap. */
export function discountCapPct(role: string, overrides: PermissionOverrides): number | null {
  return can(role, overrides, 'discount.unlimited') ? null : DISCOUNT_CAP_PCT;
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
export function notGrantable(actorRole: string, actorOverrides: PermissionOverrides, wanted: PermissionOverrides): PermissionKey[] {
  return PERMISSION_KEYS.filter((k) => wanted[k] === true && !can(actorRole, actorOverrides, k));
}

/** Combinations that make no sense, as messages. */
export function validateOverrides(role: string, overrides: PermissionOverrides): string[] {
  const problems: string[] = [];
  const eff = effectivePermissions(role, overrides);
  // Granting approval without cost access makes no sense. (A manager who merely loses cost access keeps the approval default,
  // but the routes need both, so they simply cannot approve.)
  if (overrides['invoices.approve'] === true && !eff['cost.view']) problems.push('Reviewing or approving supplier invoices also needs "See cost prices".');
  if (isUnrestricted(role) && Object.keys(overrides).length > 0) problems.push(`${role === 'owner' ? 'Owners' : 'Office admins'} always have every permission and cannot be restricted.`);
  return problems;
}

export type { UserRole };
