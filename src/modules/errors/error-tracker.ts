import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { errorEvents } from '../../db/schema.js';
import { fingerprintOf, scrub, stripQuery } from './error-scrub.js';

/**
 * Built-in error tracking: the server's unexpected errors and the browser's uncaught errors land in one table, one row per
 * distinct error, counted. No service to sign up for; the Super Admin reads it in the console. `ERROR_WEBHOOK_URL` (optional)
 * is POSTed once, when an error is seen for the FIRST time, so a Slack / Teams / ntfy webhook can raise an alert.
 *
 * Privacy: only the message, a stack trace, the route WITHOUT its query string, and the signed-in user / branch ids are kept.
 * Request bodies and headers are never stored, and e-mail addresses and long digit runs (phone / card numbers) are masked.
 */
export type ErrorSource = 'SERVER' | 'BROWSER';
export interface CapturedError {
  source: ErrorSource;
  message: string;
  stack?: string | null;
  route?: string | null;
  method?: string | null;
  status?: number | null;
  userId?: string | null;
  branchId?: string | null;
  userAgent?: string | null;
  release?: string | null;
}

async function notifyWebhook(e: CapturedError, fingerprint: string): Promise<void> {
  const url = process.env.ERROR_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(3000),
      // `text` is what Slack / Teams / ntfy-style incoming webhooks read
      body: JSON.stringify({ text: `New ${e.source.toLowerCase()} error: ${e.message.slice(0, 200)}${e.route ? ` (${e.method ?? ''} ${e.route})` : ''}`, fingerprint, source: e.source, route: e.route ?? null }),
    });
  } catch { /* an unreachable webhook must never matter */ }
}

/** Records an error. Never throws and never blocks the caller. Returns whether this error was new. */
export async function captureError(e: CapturedError): Promise<boolean> {
  try {
    const message = scrub((e.message || 'Unknown error').slice(0, 500));
    const stack = e.stack ? scrub(e.stack.slice(0, 4000)) : null;
    const fingerprint = fingerprintOf(e.source, message, stack);
    const [row] = await db.insert(errorEvents).values({
      fingerprint, source: e.source, message, stack, route: stripQuery(e.route), method: e.method?.slice(0, 10) ?? null, status: e.status ?? null,
      userId: e.userId ?? null, branchId: e.branchId ?? null, userAgent: e.userAgent?.slice(0, 200) ?? null, release: e.release?.slice(0, 40) ?? null,
    }).onConflictDoUpdate({
      target: errorEvents.fingerprint,
      // seen again: count it, remember the latest occurrence, and reopen it if someone had marked it resolved
      set: { occurrences: sql`${errorEvents.occurrences} + 1`, lastSeenAt: sql`now()`, resolvedAt: null, resolvedById: null, stack: stack, route: stripQuery(e.route), status: e.status ?? null, userId: e.userId ?? null, branchId: e.branchId ?? null },
    }).returning({ isNew: sql<boolean>`(xmax = 0)` });
    if (Math.random() < 0.01) await db.delete(errorEvents).where(sql`${errorEvents.lastSeenAt} < now() - interval '90 days'`).catch(() => undefined);
    const isNew = !!row?.isNew;
    // the webhook gets the same scrubbed message and the route WITHOUT its query string, like the stored row
    if (isNew) void notifyWebhook({ ...e, message, route: stripQuery(e.route) }, fingerprint);
    return isNew;
  } catch {
    return false;
  }
}

/** Fire-and-forget capture of a server-side failure (call from an error path). */
export function captureServerError(err: unknown, req?: { method?: string; url?: string; user?: unknown }, status = 500): void {
  const u = req?.user as { sub?: string; branchId?: string | null } | undefined;
  const error = err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'Non-error thrown');
  void captureError({
    source: 'SERVER', message: error.message, stack: error.stack, route: req?.url, method: req?.method, status,
    userId: u?.sub ?? null, branchId: u?.branchId ?? null, release: process.env.RELEASE ?? null,
  });
}
