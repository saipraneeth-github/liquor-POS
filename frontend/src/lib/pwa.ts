/**
 * Offline support: registers the service worker (public/sw.js) in the built app only, and lets the app wipe the data it keeps
 * for offline use when someone signs out. Everything here is best-effort: the app works the same without a service worker.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}

/** Called on sign-out: the next person on this device must not be offered the previous person's saved lists. */
export function clearOfflineData(): void {
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.controller?.postMessage({ type: 'clear-data' });
    if ('caches' in window) void caches.delete('lc-data-v1');
  } catch { /* nothing to clear */ }
}
