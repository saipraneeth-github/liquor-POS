import { Decimal } from 'decimal.js';

/**
 * PURE: product margin = what a bottle sold for (net of tax) less what it cost the outlet.
 *
 * Revenue is `line_total` minus the tax and minus this line's share of the bill discount (the tax column is on the
 * discounted net, so net-of-tax revenue = (gross - discount share) - tax). Customer returns in the period are taken off
 * both the quantity and the revenue; the cost of a returned bottle comes back with it. A product with no known cost is
 * reported with `cost: null` and its margin left blank: guessing a cost would make the figures look better than they are.
 */
export interface SoldRow { productId: string; name: string; quantity: number; gross: string; tax: string; discountShare: string }
export interface ReturnedRow { productId: string; quantity: number; gross: string; tax: string; discountShare: string }
export interface MarginRow {
  productId: string; name: string; quantity: number; revenue: string;
  unitCost: string | null; cost: string | null; margin: string | null; marginPct: string | null;
}
export interface MarginReport {
  rows: MarginRow[];
  totals: { revenue: string; cost: string; margin: string; marginPct: string | null; withoutCost: number };
}

const D = (v: Decimal.Value) => new Decimal(v);
const net = (r: { gross: string; tax: string; discountShare: string }) => D(r.gross).minus(r.discountShare).minus(r.tax);

export function buildMarginReport(sold: SoldRow[], returned: ReturnedRow[], unitCost: Map<string, string | null>): MarginReport {
  const acc = new Map<string, { name: string; qty: number; revenue: Decimal }>();
  for (const s of sold) {
    const a = acc.get(s.productId) ?? { name: s.name, qty: 0, revenue: D(0) };
    a.qty += s.quantity; a.revenue = a.revenue.plus(net(s));
    acc.set(s.productId, a);
  }
  for (const r of returned) {
    const a = acc.get(r.productId);
    if (!a) continue;   // returned in this period but sold before it: nothing of it in this period's figures
    a.qty -= r.quantity; a.revenue = a.revenue.minus(net(r));
  }

  const rows: MarginRow[] = [...acc.entries()].filter(([, a]) => a.qty !== 0 || !a.revenue.isZero()).map(([productId, a]) => {
    const uc = unitCost.get(productId) ?? null;
    const cost = uc === null ? null : D(uc).times(a.qty);
    const margin = cost === null ? null : a.revenue.minus(cost);
    return {
      productId, name: a.name, quantity: a.qty, revenue: a.revenue.toFixed(2),
      unitCost: uc === null ? null : D(uc).toFixed(2), cost: cost === null ? null : cost.toFixed(2),
      margin: margin === null ? null : margin.toFixed(2),
      marginPct: margin === null || a.revenue.lte(0) ? null : margin.div(a.revenue).times(100).toFixed(1),
    };
  }).sort((x, y) => D(y.margin ?? '-1e18').comparedTo(x.margin ?? '-1e18'));

  const known = rows.filter((r) => r.margin !== null);
  const revenue = known.reduce((n, r) => n.plus(r.revenue), D(0));
  const cost = known.reduce((n, r) => n.plus(r.cost!), D(0));
  const margin = revenue.minus(cost);
  return {
    rows,
    totals: {
      revenue: revenue.toFixed(2), cost: cost.toFixed(2), margin: margin.toFixed(2),
      marginPct: revenue.gt(0) ? margin.div(revenue).times(100).toFixed(1) : null,
      withoutCost: rows.length - known.length,
    },
  };
}
