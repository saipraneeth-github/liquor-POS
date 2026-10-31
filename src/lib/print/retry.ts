// Backoff schedule for print jobs that could not reach the printer.
export const MAX_PRINT_ATTEMPTS = 5;

const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 3_600_000];

/** Delay before attempt number `attempts + 1`; null once the job should be given up on. */
export function nextAttemptDelayMs(attempts: number): number | null {
  if (attempts >= MAX_PRINT_ATTEMPTS) return null;
  return BACKOFF_MS[Math.max(0, attempts - 1)] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
}
