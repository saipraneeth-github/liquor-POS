import { Decimal } from 'decimal.js';

/**
 * PURE: a customer returning bottles from a PAID bill (a credit note).
 *
 * `bill_items.line_total` is the GROSS line (MRP x qty, before the bill discount) and `tax_amount` is the tax on the
 * DISCOUNTED net, exactly as the sale voucher posted them (Dr cash | bank | debtors, Dr DISCOUNT_ALLOWED, Cr SALES, Cr
 * OUTPUT_GST). A return is the same voucher for the returned share, reversed: the customer gets back what they actually
 * paid, i.e. the gross share less the share of the bill discount.
 *
 * The last bottle of a line takes the exact remainder, so several part-returns add up to the line to the paisa.
 */
export interface ReturnableLine {
  billItemId: string;
  productId: string;
  name?: string;
  quantity: number;         // sold on the bill
  lineTotal: string;        // gross
  taxAmount: string;
  servingId: string | null; // peg / glass lines are not returnable (a poured drink cannot go back in the bottle)
  returnedQty: number;      // already returned in earlier returns
  returnedGross: string;
  returnedTax: string;
}
export interface BillMoney { subtotal: string; discount: string }
export interface ReturnRequestLine { billItemId: string; quantity: number }

export interface PlannedReturnLine {
  billItemId: string; productId: string; quantity: number;
  gross: string; tax: string; net: string; discount: string;
}
export interface SalesReturnPlan {
  lines: PlannedReturnLine[];
  totals: { gross: string; tax: string; discount: string; refund: string };
}

const D = (v: Decimal.Value) => new Decimal(v);

export function planSalesReturn(bill: BillMoney, lines: ReturnableLine[], request: ReturnRequestLine[]): SalesReturnPlan {
  if (request.length === 0) throw new Error('Choose at least one item to return');
  const byId = new Map(lines.map((l) => [l.billItemId, l]));
  const seen = new Set<string>();
  const subtotal = D(bill.subtotal);
  // the share of the gross a customer actually paid after the bill discount
  const paidShare = subtotal.gt(0) ? subtotal.minus(bill.discount).div(subtotal) : D(1);

  const planned: PlannedReturnLine[] = request.map((r) => {
    const line = byId.get(r.billItemId);
    if (!line) throw new Error('An item to return is not on this bill');
    if (seen.has(r.billItemId)) throw new Error('An item appears twice');
    seen.add(r.billItemId);
    if (line.servingId) throw new Error(`${line.name ?? 'A drink sold by the peg'} cannot be returned`);
    if (!Number.isInteger(r.quantity) || r.quantity <= 0) throw new Error('Return quantities must be whole numbers above zero');
    const remaining = line.quantity - line.returnedQty;
    if (r.quantity > remaining) throw new Error(`${line.name ?? 'An item'}: only ${remaining} left to return (sold ${line.quantity}, already returned ${line.returnedQty})`);

    const last = r.quantity === remaining;
    const gross = last ? D(line.lineTotal).minus(line.returnedGross) : D(line.lineTotal).times(r.quantity).div(line.quantity).toDecimalPlaces(2);
    const tax = last ? D(line.taxAmount).minus(line.returnedTax) : D(line.taxAmount).times(r.quantity).div(line.quantity).toDecimalPlaces(2);
    const net = gross.times(paidShare).toDecimalPlaces(2);
    return { billItemId: line.billItemId, productId: line.productId, quantity: r.quantity, gross: gross.toFixed(2), tax: tax.toFixed(2), net: net.toFixed(2), discount: gross.minus(net).toFixed(2) };
  });

  const sum = (pick: (l: PlannedReturnLine) => string) => planned.reduce((n, l) => n.plus(pick(l)), D(0)).toFixed(2);
  return { lines: planned, totals: { gross: sum((l) => l.gross), tax: sum((l) => l.tax), discount: sum((l) => l.discount), refund: sum((l) => l.net) } };
}

/** The ledger that gives the money back: the same one the sale was paid into. */
export function refundLedgerFor(paymentMode: string | null | undefined): 'CASH' | 'BANK' | 'SUNDRY_DEBTORS' {
  const m = (paymentMode ?? 'CASH').toUpperCase();
  if (m === 'CREDIT') return 'SUNDRY_DEBTORS';
  if (m === 'CARD' || m === 'UPI') return 'BANK';
  return 'CASH';
}

/** What a supplier return takes off the creditors ledger and the stock: quantity x unit cost per line. */
export interface ReturnCostLine { productId: string; quantity: number; unitCost: string }
export function purchaseReturnTotal(lines: ReturnCostLine[]): { lines: (ReturnCostLine & { amount: string })[]; total: string } {
  if (lines.length === 0) throw new Error('Choose at least one item to return');
  const out = lines.map((l) => {
    if (!Number.isInteger(l.quantity) || l.quantity <= 0) throw new Error('Return quantities must be whole numbers above zero');
    if (D(l.unitCost).lte(0)) throw new Error('Every returned item needs a cost price above zero');
    return { ...l, amount: D(l.unitCost).times(l.quantity).toDecimalPlaces(2).toFixed(2) };
  });
  return { lines: out, total: out.reduce((n, l) => n.plus(l.amount), D(0)).toFixed(2) };
}
