/**
 * Reports uncaught browser errors to the app's own error tracker (POST /api/v1/client-errors). Nothing leaves the business's
 * own server. Sends only the message, the stack and the page path (no query string, no form data, no storage).
 *
 * Kept deliberately small and failure-proof: it never throws, never reports more than a handful a minute, and never
 * reports the same error twice in a session (the server counts repeats from other people's sessions itself).
 */
const MAX_PER_MINUTE = 5;
const seen = new Set<string>();
let sentAt: number[] = [];
let installed = false;

function post(body: { message: string; stack?: string; url: string }): void {
  try {
    const token = localStorage.getItem('token');
    void fetch('/api/v1/client-errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      keepalive: true,   // still delivered while the page is being closed or reloaded
    }).catch(() => undefined);
  } catch { /* reporting must never cause another error */ }
}

export function reportError(err: unknown, where?: string): void {
  try {
    const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'Unknown error');
    const message = (e.message || 'Unknown error').slice(0, 500);
    const key = `${message}|${(e.stack ?? '').split('\n')[1] ?? ''}`;
    if (seen.has(key)) return;
    const now = Date.now();
    sentAt = sentAt.filter((t) => now - t < 60_000);
    if (sentAt.length >= MAX_PER_MINUTE) return;
    seen.add(key);
    sentAt.push(now);
    post({ message, stack: e.stack?.slice(0, 4000), url: where ?? window.location.pathname });
  } catch { /* ignore */ }
}

/** Listens for errors nothing else caught. Call once at start-up. */
export function installErrorReporting(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (ev) => reportError(ev.error ?? ev.message));
  window.addEventListener('unhandledrejection', (ev) => reportError(ev.reason));
}
