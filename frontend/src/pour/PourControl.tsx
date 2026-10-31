import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { errorMessage, showToast } from '../lib/print';
import { Badge, Field, Stat, inr } from '../components/ui';

interface StockRow {
  productId: string;
  name: string;
  volumeMl: number | null;
  openMl: number;
  quantity: number;
}

interface ReportRow {
  productId: string;
  name: string;
  pegsSold: number;
  soldMl: number;
  counts: number;
  varianceMl: number;
  variancePercent: string;
  varianceValue: string;
  openMlNow: number;
  bottleMl: number | null;
}

interface Report {
  rows: ReportRow[];
  totals: { soldMl: number; varianceMl: number; varianceValue: string };
}

interface CountRow {
  id: string;
  name: string;
  expectedMl: number;
  countedMl: number;
  varianceMl: number;
  note: string | null;
  createdAt: string;
  by: string | null;
}

const isoDay = (offset = 0) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

/** Peg control: compare the open bottle with what the system expects and see where ml go missing. */
export function PourControl() {
  const { user } = useAuth();
  const branchId = user?.branchId;

  const [from, setFrom] = useState(isoDay(-6));
  const [to, setTo] = useState(isoDay());
  const [report, setReport] = useState<Report | null>(null);
  const [counts, setCounts] = useState<CountRow[]>([]);
  const [bottles, setBottles] = useState<StockRow[]>([]);
  const [productId, setProductId] = useState('');
  const [countedMl, setCountedMl] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!branchId) return;
    try {
      const [r, c, s, bar] = await Promise.all([
        api.get<Report>(`/compliance/pour-report/${branchId}?from=${from}&to=${to}`),
        api.get<{ counts: CountRow[] }>(`/compliance/pour-counts/${branchId}`),
        api.get<StockRow[]>(`/inventory/stock/${branchId}`),
        api.get<{ items: { id: string }[] }>('/menu/bar'),
      ]);
      const barIds = new Set(bar.items.map((i) => i.id));
      setReport(r);
      setCounts(c.counts);
      // Only drinks that are poured: on the bar menu, or with an opened bottle
      const pourable = s.filter((x) => x.volumeMl && (barIds.has(x.productId) || x.openMl > 0));
      setBottles(pourable);
      setProductId((cur) => cur || pourable[0]?.productId || '');
    } catch (err) {
      showToast('Could not load pour data: ' + errorMessage(err), 'error');
    }
  }, [branchId, from, to]);

  useEffect(() => {
    load();
  }, [load]);

  const selected = bottles.find((b) => b.productId === productId);

  const record = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!branchId || !selected) return;
    setSaving(true);
    try {
      const res = await api.post<{ varianceMl: number }>(`/compliance/pour-counts/${branchId}`, {
        productId,
        countedMl: Number(countedMl),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      showToast(
        res.varianceMl === 0
          ? 'Count matches the system.'
          : `Recorded ${res.varianceMl > 0 ? 'surplus' : 'shortage'} of ${Math.abs(res.varianceMl)} ml. Open-bottle ml updated.`,
        res.varianceMl < 0 ? 'info' : 'success',
      );
      setCountedMl('');
      setNote('');
      load();
    } catch (err) {
      showToast(errorMessage(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  const shortage = report ? report.totals.varianceMl < 0 : false;

  return (
    <section className="max-w-6xl mx-auto space-y-5" id="page-pour">
      <div>
        <h1 className="text-2xl font-bold">Pour Control</h1>
        <p className="text-sm text-gray-500 mt-1">
          Dip-check the open bottle at close of day. The system compares it with what the pegs sold should have left.
        </p>
      </div>

      <div className="grid lg:grid-cols-[360px_1fr] gap-5">
        <form onSubmit={record} className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-5 space-y-4 self-start" id="pourForm">
          <h2 className="font-semibold">Record a count</h2>
          <Field label="Bottle">
            <select id="pourProduct" className="input-base" value={productId} onChange={(e) => setProductId(e.target.value)} required>
              {bottles.map((b) => <option key={b.productId} value={b.productId}>{b.name}</option>)}
            </select>
          </Field>
          {selected && (
            <div className="text-xs text-gray-500 bg-gray-50 dark:bg-gray-900/40 rounded-lg p-3">
              System expects <b className="font-mono text-gray-900 dark:text-gray-100">{selected.openMl} ml</b> in the open bottle
              ({selected.quantity} sealed, {selected.volumeMl} ml each).
            </div>
          )}
          <Field label="Counted ml in the open bottle">
            <input id="pourCounted" className="input-base font-mono" type="number" min="0" max={selected?.volumeMl ?? 5000} value={countedMl} onChange={(e) => setCountedMl(e.target.value)} required />
          </Field>
          <Field label="Note (optional)">
            <input className="input-base" maxLength={300} placeholder="e.g. end of night dip" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <button id="pourSaveBtn" type="submit" disabled={saving || !selected} className="w-full py-2 text-sm font-semibold bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white rounded-lg cursor-pointer">
            {saving ? 'Saving…' : 'Record count'}
          </button>
        </form>

        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="From"><input className="input-base" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Field>
            <Field label="To"><input className="input-base" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
          </div>

          {report && (
            <div className="grid grid-cols-3 gap-3" id="pourStats">
              <Stat label="Poured (ml)" value={report.totals.soldMl.toLocaleString('en-IN')} />
              <Stat label="Variance (ml)" value={report.totals.varianceMl} tone={shortage ? 'bad' : undefined} />
              <Stat label="Variance value" value={inr(report.totals.varianceValue)} tone={shortage ? 'bad' : undefined} />
            </div>
          )}

          <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 overflow-x-auto">
            {!report || report.rows.length === 0 ? (
              <div className="p-8 text-center text-sm text-gray-500">No peg sales or counts in this period.</div>
            ) : (
              <table className="w-full text-left text-sm" id="pourTable">
                <thead>
                  <tr className="border-b text-[11px] uppercase tracking-wider text-gray-500 bg-gray-50 dark:bg-gray-900/40 dark:border-gray-700">
                    <th className="py-2.5 px-4">Drink</th>
                    <th className="py-2.5 px-4 text-right">Pegs</th>
                    <th className="py-2.5 px-4 text-right">Sold ml</th>
                    <th className="py-2.5 px-4 text-right">Counts</th>
                    <th className="py-2.5 px-4 text-right">Variance ml</th>
                    <th className="py-2.5 px-4 text-right">%</th>
                    <th className="py-2.5 px-4 text-right">Value</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {report.rows.map((r) => (
                    <tr key={r.productId} className="pour-row" data-product={r.name}>
                      <td className="py-3 px-4">
                        <div className="font-medium">{r.name}</div>
                        <div className="text-xs text-gray-500">{r.openMlNow} ml in open bottle now</div>
                      </td>
                      <td className="py-3 px-4 text-right font-mono">{r.pegsSold}</td>
                      <td className="py-3 px-4 text-right font-mono">{r.soldMl}</td>
                      <td className="py-3 px-4 text-right font-mono">{r.counts}</td>
                      <td className={`py-3 px-4 text-right font-mono font-semibold ${r.varianceMl < 0 ? 'text-red-600' : r.varianceMl > 0 ? 'text-emerald-600' : ''}`}>
                        {r.varianceMl > 0 ? '+' : ''}{r.varianceMl}
                      </td>
                      <td className="py-3 px-4 text-right font-mono text-xs">{r.counts ? `${r.variancePercent}%` : '—'}</td>
                      <td className="py-3 px-4 text-right font-mono">{r.counts ? inr(r.varianceValue) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-xl border dark:border-gray-700 p-4">
            <h3 className="text-sm font-semibold mb-2">Recent counts</h3>
            {counts.length === 0 ? (
              <div className="text-sm text-gray-500">None yet.</div>
            ) : (
              <ul className="divide-y divide-gray-100 dark:divide-gray-700 text-sm">
                {counts.slice(0, 8).map((c) => (
                  <li key={c.id} className="py-2 flex flex-wrap items-center justify-between gap-2">
                    <span>
                      <b>{c.name}</b> <span className="text-xs text-gray-500">{new Date(c.createdAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · {c.by ?? '—'}</span>
                      {c.note && <span className="block text-xs text-gray-500">{c.note}</span>}
                    </span>
                    <span className="font-mono text-xs">
                      {c.expectedMl} → {c.countedMl} ml{' '}
                      <Badge tone={c.varianceMl < 0 ? 'bad' : c.varianceMl > 0 ? 'good' : 'muted'}>{c.varianceMl > 0 ? '+' : ''}{c.varianceMl}</Badge>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
