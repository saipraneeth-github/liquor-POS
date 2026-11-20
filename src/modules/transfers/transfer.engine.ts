/**
 * PURE: the rules of a stock transfer between two outlets of one business.
 *
 * Dispatch takes the bottles out of the sender at once and they are IN_TRANSIT until the receiver confirms. At receipt each
 * line is confirmed at what actually arrived: anything below what was sent is a shortage (lost or broken in transit), recorded
 * on the line; nothing can arrive that was not sent.
 */
export interface SentLine { productId: string; quantity: number }
export interface ReceivedLine { productId: string; receivedQuantity: number }

export interface ReceiptPlan {
  lines: { productId: string; sent: number; received: number; shortage: number }[];
  totalSent: number;
  totalReceived: number;
  totalShortage: number;
}

/** Validates a dispatch list: at least one line, whole positive quantities, no product twice. */
export function validateDispatch(items: SentLine[]): string[] {
  const problems: string[] = [];
  if (items.length === 0) problems.push('Add at least one product');
  const seen = new Set<string>();
  for (const i of items) {
    if (seen.has(i.productId)) problems.push('A product appears twice');
    seen.add(i.productId);
    if (!Number.isInteger(i.quantity) || i.quantity <= 0) problems.push('Quantities must be whole numbers above zero');
  }
  return [...new Set(problems)];
}

/**
 * What was received per line. `received` omitted = everything arrived. Throws a plain Error (mapped to 422 by the service)
 * on a product that was not sent or a quantity above what was sent.
 */
export function planReceipt(sent: SentLine[], received?: ReceivedLine[]): ReceiptPlan {
  const sentBy = new Map(sent.map((s) => [s.productId, s.quantity]));
  const got = new Map<string, number>();
  for (const r of received ?? []) {
    if (!sentBy.has(r.productId)) throw new Error('A product that was not sent cannot be received');
    if (got.has(r.productId)) throw new Error('A product appears twice');
    if (!Number.isInteger(r.receivedQuantity) || r.receivedQuantity < 0) throw new Error('Received quantities must be whole numbers, 0 or more');
    if (r.receivedQuantity > sentBy.get(r.productId)!) throw new Error('More arrived than was sent: correct the dispatch instead');
    got.set(r.productId, r.receivedQuantity);
  }
  const lines = sent.map((s) => {
    const received = got.has(s.productId) ? got.get(s.productId)! : s.quantity;   // unlisted line = all of it arrived
    return { productId: s.productId, sent: s.quantity, received, shortage: s.quantity - received };
  });
  return {
    lines,
    totalSent: lines.reduce((n, l) => n + l.sent, 0),
    totalReceived: lines.reduce((n, l) => n + l.received, 0),
    totalShortage: lines.reduce((n, l) => n + l.shortage, 0),
  };
}
