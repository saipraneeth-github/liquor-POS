/**
 * PURE: the stock register an excise inspector asks for: per product, what the outlet held at the start of the period, what
 * came in, what went out and how, and what it holds at the end.
 *
 * The closing figure is anchored to the live `stock` quantity (closing = quantity now - everything moved after the period), so
 * stock that was seeded before audit rows existed cannot throw the register off. Opening = closing - the net movement of the
 * period, which makes the identity below hold by construction:
 *
 *   opening + received + transferIn - transferOut - returnedToSupplier - sold - counterSheetSales - breakage + adjustments = closing
 *
 * Counts are in bottles. (Peg sales draw millilitres from an opened bottle; the register counts whole bottles only.)
 */
export type Bucket = 'received' | 'transferIn' | 'transferOut' | 'returnedToSupplier' | 'sold' | 'counterSheetSales' | 'breakage' | 'adjustments';

/** Which register column a stock-movement reason feeds. Anything not listed (manual corrections, counter transfers) is an adjustment. */
export const REASON_BUCKET: Record<string, Bucket> = {
  PURCHASE: 'received', SCHEME_FREE_GOODS: 'received',
  TRANSFER_IN: 'transferIn', TRANSFER_OUT: 'transferOut', PURCHASE_RETURN: 'returnedToSupplier',
  SALE: 'sold', VOID_REVERSAL: 'sold', SALES_RETURN: 'sold',      // a void or a customer return takes bottles back OFF the sold figure
  COUNTER_SHEET: 'counterSheetSales',                              // bottles that left without a POS bill, found when a counter sheet is posted
  BREAKAGE: 'breakage', DAMAGE: 'breakage',
};

export type Moves = Record<string, number>;   // reason -> signed change

export interface RegisterInput {
  productId: string; name: string; brand: string | null; volumeMl: number | null; packQuantity: number | null;
  current: number;          // stock.quantity now
  after: number;            // net movement AFTER the period (to anchor the closing)
  moves: Moves;             // net movement per reason INSIDE the period
}
export interface RegisterRow {
  productId: string; name: string; brand: string | null; volumeMl: number | null; packQuantity: number | null;
  opening: number; closing: number;
  received: number; transferIn: number; transferOut: number; returnedToSupplier: number; sold: number; counterSheetSales: number; breakage: number; adjustments: number;
  closingLitres: number;
}
export interface Register { rows: RegisterRow[]; totals: Omit<RegisterRow, 'productId' | 'name' | 'brand' | 'volumeMl' | 'packQuantity'> }

const COLUMNS: Bucket[] = ['received', 'transferIn', 'transferOut', 'returnedToSupplier', 'sold', 'counterSheetSales', 'breakage', 'adjustments'];

function bucketize(moves: Moves): Record<Bucket, number> {
  const b: Record<Bucket, number> = { received: 0, transferIn: 0, transferOut: 0, returnedToSupplier: 0, sold: 0, counterSheetSales: 0, breakage: 0, adjustments: 0 };
  for (const [reason, change] of Object.entries(moves)) {
    const bucket = REASON_BUCKET[reason] ?? 'adjustments';
    // incoming columns count what came in; outgoing columns count what went out, so they are shown as positive numbers
    if (bucket === 'received' || bucket === 'transferIn' || bucket === 'adjustments') b[bucket] += change;
    else b[bucket] -= change;
  }
  return b;
}

export const netOf = (moves: Moves) => Object.values(moves).reduce((n, c) => n + c, 0);

export function buildRegister(inputs: RegisterInput[]): Register {
  const rows: RegisterRow[] = inputs.map((i) => {
    const closing = i.current - i.after;
    const opening = closing - netOf(i.moves);
    const b = bucketize(i.moves);
    return { productId: i.productId, name: i.name, brand: i.brand, volumeMl: i.volumeMl, packQuantity: i.packQuantity, opening, closing, ...b, closingLitres: i.volumeMl ? (closing * i.volumeMl) / 1000 : 0 };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const totals = { opening: 0, closing: 0, received: 0, transferIn: 0, transferOut: 0, returnedToSupplier: 0, sold: 0, counterSheetSales: 0, breakage: 0, adjustments: 0, closingLitres: 0 };
  for (const r of rows) {
    totals.opening += r.opening; totals.closing += r.closing; totals.closingLitres += r.closingLitres;
    for (const c of COLUMNS) totals[c] += r[c];
  }
  totals.closingLitres = Math.round(totals.closingLitres * 100) / 100;
  return { rows, totals };
}

/** One product day by day: each day that had movement, with the balance carried from the day before. */
export interface DayRow { date: string; opening: number; received: number; transferIn: number; transferOut: number; returnedToSupplier: number; sold: number; counterSheetSales: number; breakage: number; adjustments: number; closing: number }
export function buildDailyRegister(openingOfPeriod: number, byDay: Map<string, Moves>): DayRow[] {
  let running = openingOfPeriod;
  return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, moves]) => {
    const b = bucketize(moves);
    const opening = running;
    running += netOf(moves);
    return { date, opening, ...b, closing: running };
  });
}

const csvCell = (v: string | number | null) => {
  const s = v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function registerToCsv(reg: Register): string {
  const head = ['Product', 'Brand', 'Size (ml)', 'Opening', 'Received', 'Transfer in', 'Transfer out', 'Returned to supplier', 'Sold', 'Sold without a bill (counter sheet)', 'Breakage', 'Adjustments', 'Closing', 'Closing litres'];
  const lines = [head.map(csvCell).join(',')];
  for (const r of reg.rows) {
    lines.push([r.name, r.brand, r.volumeMl, r.opening, r.received, r.transferIn, r.transferOut, r.returnedToSupplier, r.sold, r.counterSheetSales, r.breakage, r.adjustments, r.closing, r.closingLitres.toFixed(2)].map(csvCell).join(','));
  }
  const t = reg.totals;
  lines.push(['TOTAL', '', '', t.opening, t.received, t.transferIn, t.transferOut, t.returnedToSupplier, t.sold, t.counterSheetSales, t.breakage, t.adjustments, t.closing, t.closingLitres.toFixed(2)].map(csvCell).join(','));
  return lines.join('\r\n') + '\r\n';
}
