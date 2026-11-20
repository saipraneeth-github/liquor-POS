import { useMemo, useState } from 'react';
import { Modal } from '../components/ui';
import { api } from '../api/client';
import { errorMessage, showToast } from '../lib/print';

type Row = { productId: string; name: string; brand?: string; volumeMl?: number; quantity: number };

/**
 * Stock-take: type what was physically counted; only the bottles whose count differs are sent. The server sets the shop total
 * to the count and records every difference (who, when, why) in the stock movements.
 */
export function StockCount({ branchId, rows, onClose, onDone }: { branchId: string; rows: Row[]; onClose: () => void; onDone: () => void }) {
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changed = useMemo(() => rows.filter((r) => {
    const v = counts[r.productId];
    return v !== undefined && v.trim() !== '' && Number(v) !== r.quantity;
  }), [rows, counts]);

  const q = search.trim().toLowerCase();
  const visible = rows.filter((r) => !q || `${r.name} ${r.brand ?? ''}`.toLowerCase().includes(q));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (changed.length === 0) { setError('Nothing to correct: every count you typed matches the book.'); return; }
    setSaving(true);
    try {
      const res = await api.post<{ adjusted: unknown[]; unchanged: number }>(`/inventory/stock/${branchId}/adjust`, {
        note: note.trim(),
        lines: changed.map((r) => ({ productId: r.productId, countedQuantity: Number(counts[r.productId]) })),
      });
      showToast(`Stock corrected for ${res.adjusted.length} product${res.adjusted.length === 1 ? '' : 's'}`, 'success');
      onDone();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Stock count" onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-3">
        <p className="text-xs text-gray-600 dark:text-gray-300">
          Count the bottles on the shelf and godown and type the number against each product. Leave a product blank if you did not count it.
          Each correction is recorded with your name and the reason below.
        </p>
        {error && <div className="p-3 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-red-800 dark:text-red-200 text-xs rounded-lg">{error}</div>}
        <input id="scSearch" className="input-base w-full" placeholder="Search a product" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="max-h-[45vh] overflow-y-auto border rounded-lg dark:border-gray-700">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-gray-50 dark:bg-gray-800"><tr className="text-left text-gray-500">
              <th className="px-3 py-2">Product</th><th className="px-3 py-2 text-right">In the books</th><th className="px-3 py-2 text-right">Counted</th><th className="px-3 py-2 text-right">Difference</th>
            </tr></thead>
            <tbody>
              {visible.map((r) => {
                const v = counts[r.productId] ?? '';
                const diff = v.trim() === '' ? null : Number(v) - r.quantity;
                return (
                  <tr key={r.productId} className="border-t dark:border-gray-700">
                    <td className="px-3 py-1.5">{r.name}{r.volumeMl ? <span className="text-gray-500"> · {r.volumeMl} ml</span> : null}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{r.quantity}</td>
                    <td className="px-3 py-1.5 text-right">
                      <input
                        className="input-base w-20 text-right font-mono" inputMode="numeric" pattern="\d*" aria-label={`Counted ${r.name}`}
                        value={v} onChange={(e) => setCounts({ ...counts, [r.productId]: e.target.value.replace(/\D/g, '') })}
                      />
                    </td>
                    <td className={`px-3 py-1.5 text-right font-mono ${diff === null || diff === 0 ? 'text-gray-400' : diff < 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                      {diff === null ? '' : diff > 0 ? `+${diff}` : diff}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <label className="block text-xs font-semibold">Reason for the difference
          <textarea id="scNote" className="input-base w-full mt-1" rows={2} minLength={10} maxLength={300} required placeholder="e.g. Annual physical count; 3 bottles found broken in the godown" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-gray-500">{changed.length} product{changed.length === 1 ? '' : 's'} to correct</span>
          <div className="flex gap-3">
            <button type="button" className="px-4 py-2 text-sm border rounded-lg cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700" onClick={onClose}>Cancel</button>
            <button id="scSave" type="submit" disabled={saving || changed.length === 0} className="px-5 py-2 text-sm font-semibold bg-purple-600 hover:bg-purple-700 text-white rounded-lg cursor-pointer disabled:opacity-60">Save corrections</button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
