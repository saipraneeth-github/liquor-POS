import { Decimal } from 'decimal.js';

// ─── TYPES ──────────────────────────────────────────────────────────────────

export interface BillLineInput {
  productId: string;
  quantity: number;
  unitPrice: string;   // Decimal string, e.g., "450.00"
  taxRate: string;     // Decimal string, e.g., "18.00"
  servingId?: string | null;      // peg / glass serving (unitPrice is then the serving price)
  servingLabel?: string | null;
  servingMl?: number | null;
}

export interface BillCalculation {
  lines: BillLineCalculated[];
  subtotal: string;
  taxAmount: string;
  discount: string;
  roundOff: string;    // paise added/removed to reach a whole rupee (0.00 unless rounding is on)
  total: string;       // subtotal - discount + roundOff
}

export interface BillLineCalculated {
  productId: string;
  quantity: number;
  unitPrice: string;
  taxRate: string;
  taxAmount: string;
  lineTotal: string;     // unit_price * qty + tax
  linePretax: string;    // unit_price * qty
  servingId: string | null;
  servingLabel: string | null;
  servingMl: number | null;
}

// ─── BILLING ENGINE ─────────────────────────────────────────────────────────

/**
 * Pure, side-effect-free billing calculation engine.
 * All arithmetic uses decimal.js to avoid floating-point errors.
 */
export function calculateBill(
  lines: BillLineInput[],
  discountAmount: string = '0',
  roundToRupee = false,
): BillCalculation {
  if (lines.length === 0) {
    throw new Error('Bill must contain at least one line item');
  }

  const discount = new Decimal(discountAmount);
  if (discount.isNegative()) {
    throw new Error('Discount cannot be negative');
  }

  const priced = lines.map((line) => {
    if (line.quantity <= 0) {
      throw new Error(`Invalid quantity ${line.quantity} for product ${line.productId}`);
    }

    const unitPrice = new Decimal(line.unitPrice);
    const taxRate = new Decimal(line.taxRate);
    const qty = new Decimal(line.quantity);

    if (unitPrice.isNegative() || unitPrice.isZero()) {
      throw new Error(`Invalid unit price ${line.unitPrice} for product ${line.productId}`);
    }
    if (taxRate.isNegative() || taxRate.greaterThan(100)) {
      throw new Error(`Invalid tax rate ${line.taxRate} for product ${line.productId}`);
    }

    return { line, unitPrice, taxRate, linePretax: unitPrice.mul(qty).toDecimalPlaces(2) };
  });

  const subtotal = priced
    .reduce((acc, l) => acc.plus(l.linePretax), new Decimal(0))
    .toDecimalPlaces(2);

  const payable = subtotal.minus(discount).toDecimalPlaces(2);

  if (payable.isNegative()) {
    throw new Error('Discount exceeds bill subtotal');
  }

  // Optional round-off to the nearest rupee; tax below is computed on the pre-rounding net
  const total = roundToRupee ? payable.toDecimalPlaces(0, Decimal.ROUND_HALF_UP) : payable;
  const roundOff = total.minus(payable);

  // A bill-level discount reduces the GST transaction value, so it is apportioned across
  // lines (pro rata, exact to the paisa) before the tax-inclusive split.
  const shares = allocateDiscount(priced.map((p) => p.linePretax), discount.toDecimalPlaces(2));

  const calculatedLines: BillLineCalculated[] = priced.map((p, idx) => {
    // MRP is tax-inclusive (Indian liquor): taxable = net / (1 + rate/100), tax = net - taxable
    const net = p.linePretax.minus(shares[idx]);
    const taxMultiplier = p.taxRate.div(100).plus(1);
    const taxableValue = net.div(taxMultiplier).toDecimalPlaces(2);
    const lineTaxAmount = net.minus(taxableValue).toDecimalPlaces(2);

    return {
      productId: p.line.productId,
      quantity: p.line.quantity,
      unitPrice: p.unitPrice.toFixed(2),
      taxRate: p.taxRate.toFixed(2),
      taxAmount: lineTaxAmount.toFixed(2),
      lineTotal: p.linePretax.toFixed(2),
      linePretax: p.linePretax.toFixed(2),
      servingId: p.line.servingId ?? null,
      servingLabel: p.line.servingLabel ?? null,
      servingMl: p.line.servingMl ?? null,
    };
  });

  const totalTax = calculatedLines
    .reduce((acc, l) => acc.plus(new Decimal(l.taxAmount)), new Decimal(0))
    .toDecimalPlaces(2);

  return {
    lines: calculatedLines,
    subtotal: subtotal.toFixed(2),
    taxAmount: totalTax.toFixed(2),
    discount: discount.toFixed(2),
    roundOff: roundOff.toFixed(2),
    total: total.toFixed(2),
  };
}

// ─── LINE / NUMBERING HELPERS ───────────────────────────────────────────────

/**
 * Splits `discount` across `amounts` pro rata using the largest-remainder method, so the
 * shares are non-negative, never exceed their line, and sum exactly to `discount` (2dp).
 */
export function allocateDiscount(amounts: Decimal[], discount: Decimal): Decimal[] {
  const total = amounts.reduce((s, a) => s.plus(a), new Decimal(0));
  if (discount.isZero() || total.isZero()) return amounts.map(() => new Decimal(0));

  const discountPaise = discount.mul(100).toNumber();
  const exact = amounts.map((a) => discount.mul(100).mul(a).div(total));   // in paise
  const floors = exact.map((e) => e.floor());
  let remaining = discountPaise - floors.reduce((s, f) => s + f.toNumber(), 0);

  const order = exact
    .map((e, idx) => ({ idx, rem: e.minus(floors[idx]) }))
    .sort((a, b) => b.rem.comparedTo(a.rem) || a.idx - b.idx);
  const paise = floors.map((f) => f.toNumber());
  for (const { idx } of order) {
    if (remaining <= 0) break;
    paise[idx] += 1;
    remaining -= 1;
  }
  return paise.map((p) => new Decimal(p).div(100));
}

export const DEFAULT_TAX_RATE = '18.00';

/**
 * Tax rate: the product's own GST % when set (menu items), else its category rate;
 * 18% only when neither exists.
 */
export function resolveTaxRate(
  categoryTaxRate: string | null | undefined,
  productGstRate?: string | null,
): string {
  const rate = productGstRate ?? categoryTaxRate;
  return rate == null ? DEFAULT_TAX_RATE : new Decimal(rate).toFixed(2);
}

/**
 * Merges duplicate lines (same product and same serving) by summing quantities,
 * preserving first-seen order.
 */
export function mergeBillItems<T extends { productId: string; quantity: number; servingId?: string | null }>(
  items: T[],
): { productId: string; quantity: number; servingId?: string }[] {
  const merged = new Map<string, { productId: string; quantity: number; servingId?: string }>();
  for (const item of items) {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw new Error(`Invalid quantity ${item.quantity} for product ${item.productId}`);
    }
    const key = `${item.productId}|${item.servingId ?? ''}`;
    const existing = merged.get(key);
    if (existing) existing.quantity += item.quantity;
    else merged.set(key, item.servingId
      ? { productId: item.productId, servingId: item.servingId, quantity: item.quantity }
      : { productId: item.productId, quantity: item.quantity });
  }
  return Array.from(merged.values());
}

/** CODE-YYYY-000001 */
export function formatBillNumber(branchCode: string, year: number, seq: number): string {
  if (!Number.isInteger(seq) || seq <= 0) throw new Error(`Invalid bill sequence ${seq}`);
  return `${branchCode}-${year}-${String(seq).padStart(6, '0')}`;
}

/**
 * Validates that the MRP billed matches the registered product MRP.
 * Prevents manual price override at POS.
 */
export function assertMrpMatch(
  billedPrice: string,
  registeredMrp: string,
  productId: string,
): void {
  const billed = new Decimal(billedPrice);
  const registered = new Decimal(registeredMrp);
  if (!billed.equals(registered)) {
    throw new Error(
      `Price mismatch for product ${productId}: billed ${billedPrice}, MRP is ${registeredMrp}`,
    );
  }
}
