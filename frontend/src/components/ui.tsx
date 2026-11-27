import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useT } from '../i18n';

export const inr = (v: string | number) =>
  `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">{label}</span>
      {children}
      {error && <span className="block text-xs text-red-600 dark:text-red-400 font-medium mt-1">{error}</span>}
      {hint && !error && <span className="block text-[11px] text-gray-500 dark:text-gray-400 mt-1">{hint}</span>}
    </label>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const { t } = useT();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  // Rendered on <body>: a `.lc` page (container-type) would otherwise become the containing block of this fixed
  // overlay, so the dialog opened somewhere down the page, out of sight.
  return createPortal(
    <dialog
      ref={dialogRef}
      role="dialog"
      aria-labelledby={titleId}
      className="fixed inset-0 m-0 w-full h-full max-w-none max-h-none bg-transparent open:flex justify-center p-4 overflow-y-auto backdrop:bg-black/60 backdrop:backdrop-blur-sm [&>*]:my-auto"
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={`bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-xl shadow-2xl w-full ${wide ? 'max-w-2xl' : 'max-w-xl'} p-6 border border-gray-200 dark:border-gray-700`}>
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <h2 id={titleId} className="min-w-0 break-words text-lg font-bold text-gray-900 dark:text-white">{title}</h2>
          <button
            type="button"
            className="min-h-11 inline-flex shrink-0 items-center gap-2 px-3 rounded-lg text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors cursor-pointer"
            aria-label={t('Close')}
            onClick={onClose}
          >
            <X size={20} aria-hidden="true" />
            <span>{t('Close')}</span>
          </button>
        </div>
        {children}
      </div>
    </dialog>,
    document.body,
  );
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: 'warn' | 'bad' | 'good' }) {
  const color = tone === 'bad' ? 'text-red-600 dark:text-red-400' : tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : tone === 'good' ? 'text-emerald-600 dark:text-emerald-400' : '';
  return (
    <div className="p-4 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
      <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
      <div className={`text-2xl font-bold font-display tabular-nums mt-1 ${color}`}>{value}</div>
    </div>
  );
}

export function Badge({ children, tone }: { children: ReactNode; tone: 'good' | 'warn' | 'bad' | 'info' | 'muted' }) {
  const cls = {
    good: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300',
    warn: 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300',
    bad: 'bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300',
    info: 'bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300',
    muted: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  }[tone];
  return <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${cls}`}>{children}</span>;
}

export { BeerBottleLoader, type BeerBottleLoaderProps } from './BeerBottleLoader';
export { ProtectedButton } from './ProtectedButton';
export type { ProtectedButtonProps, ButtonVariant, AppRole } from './ProtectedButton';
