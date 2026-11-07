import type { ReactNode } from 'react';
import { X } from 'lucide-react';

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
  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex justify-center p-4 z-50 overflow-y-auto [&>*]:my-auto"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={`bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full ${wide ? 'max-w-2xl' : 'max-w-xl'} p-6 border border-gray-200 dark:border-gray-700`}>
        <div className="flex items-start justify-between mb-4">
          <h2 className="text-lg font-bold text-gray-900 dark:text-white">{title}</h2>
          <button
            type="button"
            className="p-1 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors cursor-pointer"
            aria-label="Close"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
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
