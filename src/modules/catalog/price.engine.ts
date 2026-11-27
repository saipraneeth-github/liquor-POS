/**
 * price.engine.ts — Which selling price applies. PURE (no DB).
 *
 * Prices are the tenant's, never the master catalog's:
 *   tenant default price   products.mrp               (0.00 = not priced yet)
 *   tenant sale-type price product_prices             (non-default sale types)
 *   branch override        branch_product_prices      (default type: sale_type_id NULL; or one sale type)
 *
 * Order of preference for one product at one branch:
 *   default type:      branch default override  →  tenant mrp
 *   other sale type:   branch override for that type  →  tenant price for that type
 * A price of 0 / empty never counts. null = the product has no usable price (it cannot be sold).
 */
import { Decimal } from 'decimal.js';

export interface BranchPriceEntry {
  /** Override of the default type's price (sale_type_id NULL). */
  base?: string | null;
  /** Overrides keyed by sale type id. */
  byType?: Record<string, string>;
}

/** A positive money string as 2dp, or null for anything else (null, '', '0', '0.00', junk). */
export function positivePrice(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === '') return null;
  try {
    const d = new Decimal(s);
    return d.isFinite() && d.gt(0) ? d.toFixed(2) : null;
  } catch {
    return null;
  }
}

/** Default-type price at a branch: its override, else the tenant's MRP. null = not priced. */
export function defaultPrice(tenantMrp: string | null | undefined, branch?: BranchPriceEntry): string | null {
  return positivePrice(branch?.base) ?? positivePrice(tenantMrp);
}

/**
 * Tax-inclusive unit price for a sale type. `type` is the bill's sale type ({ id, isDefault }); `typePrice` is the tenant's
 * price for that type (product_prices). null = no price at all (block the sale).
 */
export function resolveUnitPrice(
  type: { id?: string; isDefault: boolean },
  tenantMrp: string | null | undefined,
  typePrice: string | null | undefined,
  branch?: BranchPriceEntry,
): string | null {
  if (type.isDefault) return defaultPrice(tenantMrp, branch);
  return positivePrice(type.id ? branch?.byType?.[type.id] : null) ?? positivePrice(typePrice);
}

/** True when the tenant's own price is missing, i.e. the product still "needs a price" for every branch without an override. */
export function needsTenantPrice(tenantMrp: string | null | undefined): boolean {
  return positivePrice(tenantMrp) === null;
}

/** Folds override rows (saleTypeId null = default) into a per-product map. */
export function foldBranchPrices(
  rows: Array<{ productId: string; saleTypeId: string | null; price: string }>,
): Map<string, BranchPriceEntry> {
  const out = new Map<string, BranchPriceEntry>();
  for (const r of rows) {
    const e = out.get(r.productId) ?? {};
    if (r.saleTypeId === null) e.base = r.price;
    else e.byType = { ...(e.byType ?? {}), [r.saleTypeId]: r.price };
    out.set(r.productId, e);
  }
  return out;
}
