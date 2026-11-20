/**
 * PURE: turns a physical count into stock movements.
 *
 * `stock.quantity` is the shop total. Other counters (Janata, ...) hold `otherCounters` of it explicitly and the default
 * counter is the remainder, so a count that is lower than what the other counters hold cannot be right: the bottles must be
 * moved between counters first. A line whose count equals the book figure changes nothing.
 */
export interface CountLine { productId: string; counted: number }
export interface CurrentStock { quantity: number; otherCounters: number; name?: string }
export interface StockChange { productId: string; before: number; after: number; delta: number }

export interface AdjustmentPlan {
  changes: StockChange[];
  unchanged: number;
  problems: string[];
}

export function planAdjustments(lines: CountLine[], current: Map<string, CurrentStock>): AdjustmentPlan {
  const changes: StockChange[] = [];
  const problems: string[] = [];
  let unchanged = 0;
  const seen = new Set<string>();

  for (const line of lines) {
    const label = current.get(line.productId)?.name ?? line.productId;
    if (seen.has(line.productId)) { problems.push(`${label}: counted twice`); continue; }
    seen.add(line.productId);
    if (!Number.isInteger(line.counted) || line.counted < 0) { problems.push(`${label}: the count must be a whole number, 0 or more`); continue; }

    const cur = current.get(line.productId) ?? { quantity: 0, otherCounters: 0 };
    if (line.counted < cur.otherCounters) {
      problems.push(`${label}: counted ${line.counted}, but the other counters (Janata etc.) hold ${cur.otherCounters}. Move stock between counters first.`);
      continue;
    }
    const delta = line.counted - cur.quantity;
    if (delta === 0) { unchanged++; continue; }
    changes.push({ productId: line.productId, before: cur.quantity, after: line.counted, delta });
  }
  return { changes, unchanged, problems };
}
