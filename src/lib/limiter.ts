/**
 * limiter.ts — caps how many CPU-heavy jobs (PDF parsing, OCR) run at once in this process, so a burst of uploads
 * queues up instead of starving the event loop. Excess jobs wait in order; past `maxQueue` waiting jobs a new one
 * is refused with QueueFullError (the route turns it into 503 + Retry-After).
 */
export class QueueFullError extends Error {
  constructor() { super('The server is busy reading other documents. Try again in a moment.'); }
}

export function createLimiter(maxConcurrent: number, maxQueue = 20) {
  let active = 0;
  const waiting: Array<() => void> = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next();          // hand the slot straight to the next waiter
    else active -= 1;
  };
  return async function run<T>(job: () => Promise<T>): Promise<T> {
    if (active >= maxConcurrent) {
      if (waiting.length >= maxQueue) throw new QueueFullError();
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      active += 1;
    }
    try { return await job(); } finally { release(); }
  };
}
