/**
 * posLogic.ts — the counter's rules that need no screen: discounts within the cap, cash tender and change, barcode scans,
 * parked bills and recently sold items. Pure (storage is passed in), so it is unit-tested without a browser.
 *
 * Money here is only for the screen. The server prices the bill from the database and enforces the discount cap again.
 */

const cents = (n: number) => Math.round(n * 100) / 100;

// ─── DISCOUNT ───────────────────────────────────────────────────────────────

export interface Discount { pct: number; amount: number }

/**
 * A percentage of the subtotal. A capped user is rounded DOWN to the paisa so the amount can never land half a paisa
 * over the cap the server checks; `cap` null means no cap.
 */
export function discountFromPercent(subtotal: number, pct: number, cap: number | null): Discount {
  const p = Math.max(0, Math.min(cap ?? 100, Number.isFinite(pct) ? pct : 0));
  const amount = cap !== null ? Math.floor(subtotal * p + 1e-9) / 100 : cents((subtotal * p) / 100);
  return { pct: p, amount };
}

/** A rupee amount, held to the subtotal and to the cap. `pct` is what it comes to, for display. */
export function discountFromAmount(subtotal: number, amount: number, cap: number | null): Discount {
  const limit = cap === null ? subtotal : Math.floor(subtotal * cap + 1e-9) / 100;
  const a = cents(Math.max(0, Math.min(limit, Number.isFinite(amount) ? amount : 0)));
  return { pct: subtotal > 0 ? (a / subtotal) * 100 : 0, amount: a };
}

// ─── CASH TENDER ────────────────────────────────────────────────────────────

/** The buttons under the cash box: the exact amount, then the next round figures a customer is likely to hand over. */
export function quickCashOptions(total: number): number[] {
  if (!(total > 0)) return [];
  const exact = cents(total);
  const rounds = [10, 50, 100, 500, 1000, 2000]
    .map((step) => Math.ceil(exact / step) * step)
    .filter((v) => v > exact + 0.001);
  const unique = [...new Set(rounds)].sort((a, b) => a - b);
  return [exact, ...unique.slice(0, 4)];
}

export type TenderState = 'none' | 'short' | 'ok';
export interface Tender { state: TenderState; received: number; change: number; short: number }

/** What the customer handed over against what is due. Nothing typed means "exactly right" and is not an error. */
export function tender(total: number, received: string): Tender {
  const raw = received.trim();
  if (raw === '') return { state: 'none', received: total, change: 0, short: 0 };
  const r = Number(raw);
  if (!Number.isFinite(r) || r < 0) return { state: 'short', received: 0, change: 0, short: cents(total) };
  if (r + 0.001 < total) return { state: 'short', received: r, change: 0, short: cents(total - r) };
  return { state: 'ok', received: r, change: cents(r - total), short: 0 };
}

// ─── BARCODE / ENTER IN THE SEARCH BOX ──────────────────────────────────────

export type ScanResult<T> = { kind: 'match'; product: T } | { kind: 'many' } | { kind: 'none' };

/**
 * What pressing Enter in the search box means. A scanner types the barcode and Enter: an exact barcode wins. Otherwise,
 * if only one product is showing, that is the one; more than one is left for the person to pick.
 */
export function resolveScan<T extends { barcode?: string | null }>(all: readonly T[], visible: readonly T[], typed: string): ScanResult<T> {
  const text = typed.trim().toLowerCase();
  if (!text) return { kind: 'none' };
  const exact = all.filter((p) => (p.barcode ?? '').trim().toLowerCase() === text);
  if (exact.length === 1) return { kind: 'match', product: exact[0] };
  if (exact.length > 1) return { kind: 'many' };
  if (visible.length === 1) return { kind: 'match', product: visible[0] };
  return visible.length > 1 ? { kind: 'many' } : { kind: 'none' };
}

// ─── PARKED BILLS (put one on hold to serve the next customer) ──────────────

export interface ParkedLine { productId: string; servingId?: string; qty: number }
export interface ParkedBill {
  id: string;
  parkedAt: string;
  saleTypeId: string;
  paymentMode: 'CASH' | 'CARD' | 'UPI' | 'CREDIT';
  discountPercent: string;
  buyerGstin: string;
  customer: { id: string; name: string; phone: string; creditAllowed: boolean; isActive: boolean; creditLimit: string; currentCredit: string } | null;
  lines: ParkedLine[];
  items: number;
  total: string;
}
export const MAX_PARKED = 10;

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const parkedKey = (sub: string) => `lc_pos_parked:${sub}`;

export function loadParked(store: Store, sub: string): ParkedBill[] {
  try {
    const list = JSON.parse(store.getItem(parkedKey(sub)) || '[]');
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}
export function saveParked(store: Store, sub: string, list: ParkedBill[]): void {
  try { store.setItem(parkedKey(sub), JSON.stringify(list.slice(0, MAX_PARKED))); } catch { /* private mode: parking is a convenience */ }
}
/** Newest first; the oldest falls off beyond ten. */
export function addParked(list: ParkedBill[], bill: ParkedBill): ParkedBill[] {
  return [bill, ...list.filter((b) => b.id !== bill.id)].slice(0, MAX_PARKED);
}
export function removeParked(list: ParkedBill[], id: string): ParkedBill[] {
  return list.filter((b) => b.id !== id);
}

// ─── RECENTLY SOLD ──────────────────────────────────────────────────────────

const recentKey = (branchId: string) => `lc_pos_recent:${branchId}`;
interface RecentRow { id: string; at: number; n: number }

export function recordSale(store: Store, branchId: string, productIds: readonly string[], now = Date.now()): void {
  try {
    const rows: RecentRow[] = JSON.parse(store.getItem(recentKey(branchId)) || '[]');
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of productIds) { const r = byId.get(id); byId.set(id, { id, at: now, n: (r?.n ?? 0) + 1 }); }
    const kept = [...byId.values()].sort((a, b) => b.at - a.at).slice(0, 40);
    store.setItem(recentKey(branchId), JSON.stringify(kept));
  } catch { /* a convenience only */ }
}

/** The products sold most recently; a product sold often outranks one sold once at the same moment. */
export function recentProductIds(store: Store, branchId: string, limit = 8): string[] {
  try {
    const rows: RecentRow[] = JSON.parse(store.getItem(recentKey(branchId)) || '[]');
    return rows.sort((a, b) => b.at - a.at || b.n - a.n).slice(0, limit).map((r) => r.id);
  } catch { return []; }
}
