/**
 * Centralized High-Visibility Right-Side Toast Notification System
 * Appears top-right on the right side with large prominent typography, high-contrast badges, and slide-in animation.
 */

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export function showToast(msg: string, type: ToastType = 'success', durationMs = 4500) {
  const now = Date.now();
  const g = typeof window !== 'undefined' ? (window as any) : (globalThis as any);

  // Global window-level suppression within 1.5 seconds for identical message
  if (g.__lastToast && g.__lastToast.msg === msg && now - g.__lastToast.time < 1500) {
    return;
  }
  g.__lastToast = { msg, time: now };

  let host = document.getElementById('toastHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toastHost';
    host.className = 'fixed top-6 right-6 z-[10000] flex flex-col items-end gap-3 pointer-events-none w-auto max-w-lg';
    document.body.appendChild(host);
  }

  // DOM-level deduplication: if this exact toast message is already displayed on screen, do not stack a duplicate
  const activeToasts = host.querySelectorAll('.toast');
  for (const existing of Array.from(activeToasts)) {
    if (existing.textContent?.includes(msg)) {
      return;
    }
  }

  const el = document.createElement('div');
  const isError = type === 'error';
  const isInfo = type === 'info';
  const isWarning = type === 'warning';

  const icon = isError ? '⚠️' : isWarning ? '⚡' : isInfo ? 'ℹ️' : '✓';

  const typeClasses = isError
    ? 'bg-rose-600 text-white border-2 border-rose-400 shadow-rose-950/40'
    : isWarning
    ? 'bg-amber-600 text-white border-2 border-amber-400 shadow-amber-950/40'
    : isInfo
    ? 'bg-blue-600 text-white border-2 border-blue-400 shadow-blue-950/40'
    : 'bg-emerald-600 text-white border-2 border-emerald-400 shadow-emerald-950/40';

  el.className = `toast ${type} ${typeClasses} pointer-events-auto flex items-center justify-start gap-3.5 px-6 py-4 rounded-2xl shadow-2xl text-base sm:text-lg font-bold tracking-wide select-none cursor-pointer transition-all transform animate-toastSlideInRight max-w-lg w-auto text-left`;
  el.setAttribute('role', 'alert');
  el.setAttribute('aria-live', 'assertive');

  const iconSpan = document.createElement('span');
  iconSpan.className = 'text-xl sm:text-2xl shrink-0';
  iconSpan.textContent = icon;
  el.appendChild(iconSpan);

  const textSpan = document.createElement('span');
  textSpan.className = 'flex-1 text-left leading-snug';
  textSpan.textContent = msg;
  el.appendChild(textSpan);

  // Click to dismiss immediately
  el.onclick = () => {
    el.style.opacity = '0';
    el.style.transform = 'translateX(24px) scale(0.95)';
    setTimeout(() => el.remove(), 200);
  };

  host.appendChild(el);

  setTimeout(() => {
    if (el.parentNode) {
      el.style.opacity = '0';
      el.style.transform = 'translateX(24px) scale(0.95)';
      setTimeout(() => el.remove(), 250);
    }
  }, durationMs);
}

