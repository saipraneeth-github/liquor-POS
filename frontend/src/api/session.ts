// One place that learns "the server no longer accepts this token" and tells the app, so a token that expires or is
// revoked mid-shift signs the person out cleanly instead of every screen showing a different error.
type Listener = () => void;
const listeners = new Set<Listener>();
let lastNotified = 0;

export function onSessionExpired(cb: Listener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Called when a request that carried a token came back 401. Several requests failing at once notify once. */
export function notifySessionExpired(): void {
  const now = Date.now();
  if (now - lastNotified < 2000) return;
  lastNotified = now;
  listeners.forEach((cb) => { try { cb(); } catch { /* a listener must not break the caller */ } });
}
