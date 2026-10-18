import Decimal from 'decimal.js';

// ─── TYPES ──────────────────────────────────────────────────────────────────

export interface BillLineInput {
  productId: string;
  quantity: number;
  unitPrice: string;   // Decimal string, e.g., "450.00"
  taxRate: string;     // Decimal string, e.g., "18.00"
}

export interface BillCalculation {
  lines: BillLineCalculated[];
  subtotal: string;
  taxAmount: string;
  discount: string;
  total: string;
}

export interface BillLineCalculated {
  productId: string;
  quantity: number;
  unitPrice: string;
  taxRate: string;
  taxAmount: string;
  lineTotal: string;     // unit_price * qty + tax
  linePretax: string;    // unit_price * qty
}

// ─── BILLING ENGINE ─────────────────────────────────────────────────────────

/**
 * Pure, side-effect-free billing calculation engine.
 * All arithmetic uses decimal.js to avoid floating-point errors.
 */
export function calculateBill(
  lines: BillLineInput[],
  discountAmount: string = '0',
): BillCalculation {
  if (lines.length === 0) {
    throw new Error('Bill must contain at least one line item');
  }

  const discount = new Decimal(discountAmount);
  if (discount.isNegative()) {
    throw new Error('Discount cannot be negative');
  }

  const calculatedLines: BillLineCalculated[] = lines.map((line) => {
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

    const linePretax = unitPrice.mul(qty);
    // Tax is calculated on the pre-tax base price (MRP is inclusive of tax in Indian liquor)
    // For GST: taxable_value = mrp / (1 + rate/100), tax = mrp - taxable_value
    // Here we treat MRP as tax-inclusive
    const taxMultiplier = taxRate.div(100).plus(1);
    const taxableValue = linePretax.div(taxMultiplier).toDecimalPlaces(2);
    const lineTaxAmount = linePretax.minus(taxableValue).toDecimalPlaces(2);
    const lineTotal = linePretax.toDecimalPlaces(2);

    return {
      productId: line.productId,
      quantity: line.quantity,
      unitPrice: unitPrice.toFixed(2),
      taxRate: taxRate.toFixed(2),
      taxAmount: lineTaxAmount.toFixed(2),
      lineTotal: lineTotal.toFixed(2),
      linePretax: linePretax.toFixed(2),
    };
  });

  const subtotal = calculatedLines
    .reduce((acc, l) => acc.plus(new Decimal(l.linePretax)), new Decimal(0))
    .toDecimalPlaces(2);

  const totalTax = calculatedLines
    .reduce((acc, l) => acc.plus(new Decimal(l.taxAmount)), new Decimal(0))
    .toDecimalPlaces(2);

  const total = subtotal.minus(discount).toDecimalPlaces(2);

  if (total.isNegative()) {
    throw new Error('Discount exceeds bill subtotal');
  }

  return {
    lines: calculatedLines,
    subtotal: subtotal.toFixed(2),
    taxAmount: totalTax.toFixed(2),
    discount: discount.toFixed(2),
    total: total.toFixed(2),
  };
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
