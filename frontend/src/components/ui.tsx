import type { ReactNode } from 'react';

export const inr = (v: string | number) =>
  `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-bold text-gray-700 dark:text-gray-300 mb-1">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-gray-500 mt-1">{hint}</span>}
    </label>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-start justify-center p-4 z-50 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={`bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full ${wide ? 'max-w-2xl' : 'max-w-xl'} p-6 my-8 border dark:border-gray-700`}>
        <div className="flex items-start justify-between mb-4">
          <h2 className="text-lg font-bold">{title}</h2>
          <button type="button" className="text-gray-400 hover:text-gray-700 cursor-pointer" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: 'warn' | 'bad' | 'good' }) {
  const color = tone === 'bad' ? 'text-red-600' : tone === 'warn' ? 'text-amber-600' : tone === 'good' ? 'text-emerald-600' : '';
  return (
    <div className="p-4 bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-semibold font-mono mt-1 ${color}`}>{value}</div>
    </div>
  );
}

export function Badge({ children, tone }: { children: ReactNode; tone: 'good' | 'warn' | 'bad' | 'info' | 'muted' }) {
  const cls = {
    good: 'bg-emerald-100 text-emerald-800',
    warn: 'bg-amber-100 text-amber-800',
    bad: 'bg-red-100 text-red-800',
    info: 'bg-blue-100 text-blue-800',
    muted: 'bg-gray-100 text-gray-700',
  }[tone];
  return <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${cls}`}>{children}</span>;
}
