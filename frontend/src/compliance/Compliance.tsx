import { useState, useEffect } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';

interface Category {
  id: string;
  name: string;
}

interface Quota {
  id: string;
  categoryId?: string;
  categoryName?: string;
  periodStart: string;
  periodEnd: string;
  quotaCases: number;
}

interface LiftingRow {
  categoryId?: string;
  categoryName: string;
  periodStart: string;
  periodEnd: string;
  quotaCases: number;
  liftedCases: string;
  utilisationPct: string;
  remainingCases: string;
  daysLeft: number;
  flags: string[];
}

export function Compliance() {
  const { user } = useAuth();
  const branchId = user?.branchId;

  const todayStr = new Date().toISOString().slice(0, 10);
  const monthStartStr = todayStr.slice(0, 8) + '01';

  const [categories, setCategories] = useState<Category[]>([]);
  const [quotas, setQuotas] = useState<Quota[]>([]);
  const [liftingRows, setLiftingRows] = useState<LiftingRow[]>([]);
  const [loading, setLoading] = useState(false);

  // Filter
  const [liftFrom, setLiftFrom] = useState(monthStartStr);
  const [liftTo, setLiftTo] = useState(todayStr);

  // New quota form
  const [qCategory, setQCategory] = useState('');
  const [qStart, setQStart] = useState(monthStartStr);
  const [qEnd, setQEnd] = useState(todayStr);
  const [qCases, setQCases] = useState('');
  const [creating, setCreating] = useState(false);

  const showToast = (msg: string, type: 'success' | 'error' = 'success') => {
    const host = document.getElementById('toastHost');
    if (!host) return;
    const el = document.createElement('div');
    el.className = `toast ${type} ${type === 'error' ? 'bg-red-600' : 'bg-emerald-600'} text-white p-3 rounded shadow`;
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  };

  const loadData = async () => {
    if (!branchId) return;
    setLoading(true);
    try {
      const [catRes, quotaRes, liftRes] = await Promise.all([
        api.get<{ categories?: Category[] }>('/products').catch(() => ({ categories: [] })),
        api.get<{ quotas: Quota[] }>('/compliance/quotas/' + branchId),
        api.get<{ quotas: LiftingRow[] }>(`/compliance/lifting/${branchId}?from=${liftFrom}&to=${liftTo}`),
      ]);
      if (catRes.categories) setCategories(catRes.categories);
      setQuotas(quotaRes.quotas);
      setLiftingRows(liftRes.quotas);
    } catch (err: any) {
      showToast('Failed to load compliance data: ' + err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [branchId]);

  const handleCreateQuota = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!branchId) return;
    const cases = parseInt(qCases.trim(), 10);
    if (isNaN(cases) || cases <= 0) {
      showToast('Quota must be a whole number of cases.', 'error');
      return;
    }
    setCreating(true);
    try {
      await api.post('/compliance/quotas/' + branchId, {
        periodStart: qStart,
        periodEnd: qEnd,
        quotaCases: cases,
        ...(qCategory ? { categoryId: qCategory } : {}),
      });
      showToast('Quota added', 'success');
      setQCases('');
      await loadData();
    } catch (err: any) {
      showToast('Could not add quota: ' + err.message, 'error');
    } finally {
      setCreating(false);
    }
  };

  return (
    <section className="page active" id="page-compliance" aria-labelledby="complianceTitle">
      <div className="row between flex justify-between items-center mb-4">
        <div>
          <h2 className="h1 text-xl font-bold" id="complianceTitle">⚖ Excise Compliance &amp; Lifting</h2>
          <div className="muted small text-xs text-gray-500">
            Excise quotas, lifting progress, breakage and stock audit ledger.
          </div>
        </div>
        <button
          className="btn-sec px-3 py-1 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded border font-medium text-sm"
          type="button"
          onClick={loadData}
        >
          ↻ Refresh
        </button>
      </div>

      <div className="card pad p-4 bg-white rounded shadow mb-6">
        <div className="row between flex flex-wrap items-end gap-3 border-b pb-3 mb-4">
          <div className="h2 text-base font-bold">Lifting report</div>
          <div className="row flex items-end gap-2 text-sm">
            <label className="field flex flex-col gap-1 text-xs font-medium" htmlFor="liftFrom">
              From
              <input
                id="liftFrom"
                className="input p-1.5 border rounded text-xs"
                type="date"
                value={liftFrom}
                onChange={(e) => setLiftFrom(e.target.value)}
              />
            </label>
            <label className="field flex flex-col gap-1 text-xs font-medium" htmlFor="liftTo">
              To
              <input
                id="liftTo"
                className="input p-1.5 border rounded text-xs"
                type="date"
                value={liftTo}
                onChange={(e) => setLiftTo(e.target.value)}
              />
            </label>
            <button
              className="btn-primary px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium text-xs"
              type="button"
              onClick={loadData}
            >
              Filter
            </button>
          </div>
        </div>

        <div id="liftingReport" className="table-wrap overflow-x-auto text-sm">
          {loading ? (
            <div className="p-4 text-center text-gray-500">Loading lifting report…</div>
          ) : liftingRows.length === 0 ? (
            <div className="p-4 text-center text-gray-500">No quotas overlap this range.</div>
          ) : (
            <table className="table w-full text-left">
              <thead>
                <tr className="border-b text-xs text-gray-500 bg-gray-50">
                  <th className="py-2 px-2">Category</th>
                  <th className="py-2 px-2">Period</th>
                  <th className="py-2 px-2 text-right">Quota</th>
                  <th className="py-2 px-2 text-right">Lifted</th>
                  <th className="py-2 px-2">Utilisation</th>
                  <th className="py-2 px-2 text-right">Remaining</th>
                  <th className="py-2 px-2 text-right">Days left</th>
                  <th className="py-2 px-2">Flags</th>
                </tr>
              </thead>
              <tbody>
                {liftingRows.map((q, idx) => {
                  const pct = Math.min(100, Math.max(0, parseFloat(q.utilisationPct) || 0));
                  return (
                    <tr key={idx} className="border-b hover:bg-gray-50">
                      <td className="py-2 px-2 font-medium">{q.categoryName}</td>
                      <td className="py-2 px-2 text-xs text-gray-600">
                        {q.periodStart} → {q.periodEnd}
                      </td>
                      <td className="py-2 px-2 text-right font-mono">{q.quotaCases}</td>
                      <td className="py-2 px-2 text-right font-mono">{q.liftedCases}</td>
                      <td className="py-2 px-2" style={{ minWidth: '120px' }}>
                        <div className="progress-bar w-full bg-gray-200 rounded-full h-2 overflow-hidden mb-1">
                          <div
                            className="progress-fill bg-blue-600 h-2 rounded-full"
                            style={{ width: `${pct}%` }}
                          ></div>
                        </div>
                        <span className="text-xs text-gray-600">{q.utilisationPct}%</span>
                      </td>
                      <td className="py-2 px-2 text-right font-mono">{q.remainingCases}</td>
                      <td className="py-2 px-2 text-right font-mono">{q.daysLeft}</td>
                      <td className="py-2 px-2">
                        {q.flags && q.flags.length > 0 ? (
                          <div className="flex gap-1 flex-wrap">
                            {q.flags.map((f, i) => (
                              <span
                                key={i}
                                className={`badge text-xs px-2 py-0.5 rounded font-medium ${
                                  f === 'EXCEEDED' || f === 'EXPIRED_UNMET'
                                    ? 'bg-red-100 text-red-800'
                                    : 'bg-yellow-100 text-yellow-800'
                                }`}
                              >
                                {f}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="badge text-xs px-2 py-0.5 rounded font-medium bg-green-100 text-green-800">
                            On track
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="two-col grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="card pad stack p-4 bg-white rounded shadow flex flex-col gap-3">
          <div className="h2 text-base font-bold border-b pb-2">Active quotas</div>
          <div id="quotaList" className="table-wrap overflow-x-auto text-sm">
            {quotas.length === 0 ? (
              <div className="muted small text-gray-500">No quotas yet.</div>
            ) : (
              <table className="table w-full text-left">
                <thead>
                  <tr className="border-b text-xs text-gray-500 bg-gray-50">
                    <th className="py-2 px-2">Category</th>
                    <th className="py-2 px-2">Period</th>
                    <th className="py-2 px-2 text-right">Cases</th>
                  </tr>
                </thead>
                <tbody>
                  {quotas.map((q) => (
                    <tr key={q.id} className="border-b">
                      <td className="py-2 px-2 font-medium">{q.categoryName || 'All'}</td>
                      <td className="py-2 px-2 text-xs text-gray-600">
                        {q.periodStart} → {q.periodEnd}
                      </td>
                      <td className="py-2 px-2 text-right font-mono">{q.quotaCases}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <details className="card bg-white rounded shadow p-4">
          <summary className="font-semibold text-sm cursor-pointer">+ Add quota</summary>
          <div className="pad pt-4">
            <form className="form-grid flex flex-col gap-3" onSubmit={handleCreateQuota}>
              <label className="field flex flex-col gap-1 text-xs font-medium" htmlFor="qCategory">
                Category
                <select
                  id="qCategory"
                  className="input p-2 border rounded text-sm"
                  value={qCategory}
                  onChange={(e) => setQCategory(e.target.value)}
                >
                  <option value="">All categories</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>

              <div className="grid grid-cols-2 gap-2">
                <label className="field flex flex-col gap-1 text-xs font-medium" htmlFor="qStart">
                  Period start
                  <input
                    id="qStart"
                    className="input p-2 border rounded text-sm"
                    type="date"
                    required
                    value={qStart}
                    onChange={(e) => setQStart(e.target.value)}
                  />
                </label>
                <label className="field flex flex-col gap-1 text-xs font-medium" htmlFor="qEnd">
                  Period end
                  <input
                    id="qEnd"
                    className="input p-2 border rounded text-sm"
                    type="date"
                    required
                    value={qEnd}
                    onChange={(e) => setQEnd(e.target.value)}
                  />
                </label>
              </div>

              <label className="field flex flex-col gap-1 text-xs font-medium" htmlFor="qCases">
                Cases
                <input
                  id="qCases"
                  className="input p-2 border rounded text-sm font-mono"
                  type="number"
                  min="1"
                  required
                  placeholder="e.g. 500"
                  value={qCases}
                  onChange={(e) => setQCases(e.target.value)}
                />
              </label>

              <button
                className="btn-primary mt-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium text-sm disabled:opacity-50"
                type="submit"
                disabled={creating}
              >
                {creating ? 'Adding…' : 'Add quota'}
              </button>
            </form>
          </div>
        </details>
      </div>
    </section>
  );
}

