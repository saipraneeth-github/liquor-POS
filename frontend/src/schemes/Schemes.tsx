import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { BeerBottleLoader } from '../components/BeerBottleLoader';
import { businessDate } from '../lib/business-day';

interface Scheme {
  id: string;
  supplierName: string;
  schemeName: string;
  targetType: 'QTY' | 'VALUE';
  targetValue: string;
  currentValue: string;
  progressPct: string;
  rewardDescription: string;
  startDate: string;
  endDate: string;
  status: string;
  alertActive?: boolean;
  branchId?: string;
  alertThresholdPct?: string | number;
  notes?: string | null;
}

interface SchemeAlert {
  schemeName: string;
  supplierName: string;
  progressPct: string;
}

export function Schemes() {
  const { user } = useAuth();
  const branchId = user?.branchId;

  const [schemes, setSchemes] = useState<Scheme[]>([]);
  const [alerts, setAlerts] = useState<SchemeAlert[]>([]);
  const [loading, setLoading] = useState(false);

  // New scheme form
  const [supplier, setSupplier] = useState('');
  const [schemeName, setSchemeName] = useState('');
  const [targetType, setTargetType] = useState<'QTY' | 'VALUE'>('QTY');
  const [targetValue, setTargetValue] = useState('');
  const [startDate, setStartDate] = useState(businessDate());
  const [endDate, setEndDate] = useState(businessDate(30));
  const [alertThreshold, setAlertThreshold] = useState('80');
  const [reward, setReward] = useState('');
  const [creating, setCreating] = useState(false);

  // Purchase modal
  const [purchaseScheme, setPurchaseScheme] = useState<Scheme | null>(null);
  const [pQty, setPQty] = useState('0');
  const [pValue, setPValue] = useState('0');
  const [pNotes, setPNotes] = useState('');

  // Edit Scheme modal (Super Admin / Admin / Manager)
  const [editScheme, setEditScheme] = useState<Scheme | null>(null);
  const [editForm, setEditForm] = useState({
    supplierName: '',
    schemeName: '',
    targetType: 'QTY' as 'QTY' | 'VALUE',
    targetValue: '',
    startDate: '',
    endDate: '',
    alertThresholdPct: '80',
    rewardDescription: '',
    status: 'ACTIVE',
    notes: '',
  });
  const [editSlabs, setEditSlabs] = useState<{ minCases: number; freeBottles: number; discountPerCase: string }[]>([]);
  const [updating, setUpdating] = useState(false);

  const openEditModal = async (scheme: Scheme) => {
    setEditScheme(scheme);
    setEditForm({
      supplierName: scheme.supplierName,
      schemeName: scheme.schemeName,
      targetType: scheme.targetType,
      targetValue: scheme.targetValue,
      startDate: scheme.startDate ? scheme.startDate.slice(0, 10) : '',
      endDate: scheme.endDate ? scheme.endDate.slice(0, 10) : '',
      alertThresholdPct: scheme.alertThresholdPct ? String(scheme.alertThresholdPct) : '80',
      rewardDescription: scheme.rewardDescription,
      status: scheme.status,
      notes: scheme.notes || '',
    });
    try {
      const res = await api.get<{ slabs: { minCases: number; freeBottles: number; discountPerCase: string }[] }>(`/schemes/${scheme.id}/slabs`);
      setEditSlabs(res.slabs || []);
    } catch {
      setEditSlabs([]);
    }
  };

  const handleUpdateScheme = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editScheme) return;
    const tgt = parseFloat(editForm.targetValue.trim());
    if (isNaN(tgt) || tgt <= 0) {
      showToast('Target must be a positive number.', 'error');
      return;
    }
    if (Date.parse(editForm.endDate) < Date.parse(editForm.startDate)) {
      showToast('End date must be on or after start date.', 'error');
      return;
    }

    setUpdating(true);
    try {
      await api.patch('/schemes/' + editScheme.id, {
        supplierName: editForm.supplierName.trim(),
        schemeName: editForm.schemeName.trim(),
        targetType: editForm.targetType,
        targetValue: editForm.targetValue.trim(),
        rewardDescription: editForm.rewardDescription.trim(),
        startDate: editForm.startDate,
        endDate: editForm.endDate,
        alertThresholdPct: editForm.alertThresholdPct.trim(),
        status: editForm.status,
        notes: editForm.notes.trim() || undefined,
      });

      // Update slabs if scheme is active
      if (editForm.status === 'ACTIVE' && editSlabs.length > 0) {
        await api.post('/schemes/' + editScheme.id + '/slabs', {
          slabs: editSlabs.map((s) => ({
            minCases: Number(s.minCases),
            freeBottles: Number(s.freeBottles || 0),
            discountPerCase: String(s.discountPerCase || '0'),
          })),
        });
      }

      showToast('Scheme updated successfully.');
      setEditScheme(null);
      loadData();
    } catch (err: any) {
      showToast('Failed to update scheme: ' + (err.message || 'Error'), 'error');
    } finally {
      setUpdating(false);
    }
  };

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
      const [scRes, alRes] = await Promise.all([
        api.get<{ schemes: Scheme[] }>('/schemes/' + branchId),
        api.get<{ alerts: SchemeAlert[] }>(`/schemes/${branchId}/alerts`),
      ]);
      setSchemes(scRes.schemes);
      setAlerts(alRes.alerts);
    } catch (err: any) {
      showToast('Failed to load schemes: ' + err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [branchId]);

  const handleCreateScheme = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!branchId) return;
    const tgt = parseFloat(targetValue.trim());
    if (isNaN(tgt) || tgt <= 0) {
      showToast('Target must be a positive number.', 'error');
      return;
    }
    setCreating(true);
    try {
      await api.post('/schemes/' + branchId, {
        supplierName: supplier.trim(),
        schemeName: schemeName.trim(),
        targetType,
        targetValue: targetValue.trim(),
        rewardDescription: reward.trim(),
        startDate,
        endDate,
        ...(alertThreshold ? { alertThresholdPct: alertThreshold.trim() } : {}),
      });
      showToast('Scheme created', 'success');
      setSupplier('');
      setSchemeName('');
      setTargetValue('');
      setReward('');
      await loadData();
    } catch (err: any) {
      showToast('Could not create scheme: ' + err.message, 'error');
    } finally {
      setCreating(false);
    }
  };

  const handleSavePurchase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!purchaseScheme) return;
    try {
      await api.post(`/schemes/${purchaseScheme.id}/purchase`, {
        qty: pQty.trim() || '0',
        value: pValue.trim() || '0',
        ...(pNotes.trim() ? { notes: pNotes.trim() } : {}),
      });
      showToast('Purchase recorded', 'success');
      setPurchaseScheme(null);
      await loadData();
    } catch (err: any) {
      showToast('Failed to record purchase: ' + err.message, 'error');
    }
  };

  return (
    <section className="page active" id="page-schemes" aria-labelledby="schemesTitle">
      <div className="row between flex justify-between items-center mb-4">
        <div>
          <h2 className="h1 text-2xl font-bold" id="schemesTitle">Supplier Schemes</h2>
          <div className="muted small text-xs text-gray-500">Targets, case slabs and payouts.</div>
        </div>
        <button
          className="btn-sec px-3 py-1 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded border font-medium text-sm"
          type="button"
          onClick={loadData}
        >
          ↻ Refresh
        </button>
      </div>

      <div id="schemeAlerts" className="mb-4">
        {alerts.length > 0 && (
          <div className="card pad p-4 bg-emerald-50 text-emerald-900 rounded border border-emerald-300">
            <b className="pos font-bold">{alerts.length} {alerts.length === 1 ? 'scheme' : 'schemes'} near target</b>
            <div className="small text-xs mt-1">
              {alerts.map((a) => `${a.schemeName} (${a.supplierName}) — ${parseFloat(a.progressPct).toFixed(1)}%`).join(' · ')}
            </div>
          </div>
        )}
      </div>

      <div id="schemeList" className="two-col grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        {loading ? (
          <div className="col-span-full">
            <BeerBottleLoader inline size="sm" title="Loading Supplier Schemes…" subtitle="Evaluating purchase slabs and target rewards…" />
          </div>
        ) : schemes.length === 0 ? (
          <div className="card state col-span-full p-8 text-center text-gray-500 bg-white rounded shadow">
            No schemes yet. Create one below.
          </div>
        ) : (
          schemes.map((s) => {
            const pct = Math.min(100, Math.max(0, parseFloat(s.progressPct) || 0));
            const fmt = (v: string) =>
              s.targetType === 'VALUE' ? `₹${parseFloat(v).toFixed(2)}` : `${parseFloat(v).toLocaleString('en-IN')} cases`;

            return (
              <div key={s.id} className="card pad stack p-4 bg-white rounded shadow flex flex-col gap-3">
                <div className="row between flex justify-between items-start border-b pb-2">
                  <div>
                    <div className="h2 text-base font-bold">{s.schemeName}</div>
                    <div className="muted small text-xs text-gray-500">
                      {s.supplierName} · {s.targetType === 'VALUE' ? 'Value' : 'Quantity'} target
                    </div>
                  </div>
                  <div className="flex gap-1 items-center">
                    <span className="badge px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800">
                      {s.status}
                    </span>
                    {s.alertActive && (
                      <span className="badge px-2 py-0.5 rounded text-xs font-medium bg-yellow-100 text-yellow-800">
                        Alert
                      </span>
                    )}
                  </div>
                </div>

                <div className="row between small flex justify-between text-xs">
                  <span className="muted text-gray-500">Progress</span>
                  <b className="font-mono">{fmt(s.currentValue)} / {fmt(s.targetValue)}</b>
                </div>

                <div className="progress-bar w-full bg-gray-200 rounded-full h-2.5 overflow-hidden">
                  <div
                    className="progress-fill bg-emerald-600 h-2.5 rounded-full"
                    style={{ width: `${pct}%` }}
                  ></div>
                </div>

                <div className="row between small muted flex justify-between text-xs text-gray-500">
                  <span>{new Date(s.startDate).toLocaleDateString()} → {new Date(s.endDate).toLocaleDateString()}</span>
                  <b>{parseFloat(s.progressPct).toFixed(1)}%</b>
                </div>

                <div className="small text-xs bg-amber-50 text-amber-900 rounded p-2 border border-amber-200">
                  {s.rewardDescription}
                </div>

                <div className="row flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    className="btn-sec btn-sm px-2.5 py-1 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-200 rounded border border-gray-300 dark:border-gray-600 text-xs font-medium"
                    onClick={() => {
                      setPurchaseScheme(s);
                      setPQty('0');
                      setPValue('0');
                      setPNotes('');
                    }}
                  >
                    + Purchase
                  </button>
                  <button
                    type="button"
                    id={`editSchemeBtn-${s.id}`}
                    className="btn-sec btn-sm px-2.5 py-1 bg-purple-50 dark:bg-purple-950/40 hover:bg-purple-100 dark:hover:bg-purple-900/60 text-purple-700 dark:text-purple-300 rounded border border-purple-200 dark:border-purple-800 text-xs font-medium flex items-center gap-1"
                    onClick={() => openEditModal(s)}
                  >
                    Edit Scheme
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      <details className="card bg-white rounded shadow p-4">
        <summary className="font-semibold text-sm cursor-pointer">+ New scheme</summary>
        <div className="pad pt-4">
          <form className="form-grid grid grid-cols-1 sm:grid-cols-2 gap-4" onSubmit={handleCreateScheme}>
            <label className="field flex flex-col gap-1 text-xs font-medium" htmlFor="scSupplier">
              Supplier
              <input
                id="scSupplier"
                className="input p-2 border rounded text-sm"
                required
                value={supplier}
                onChange={(e) => setSupplier(e.target.value)}
              />
            </label>

            <label className="field flex flex-col gap-1 text-xs font-medium" htmlFor="scName">
              Scheme name
              <input
                id="scName"
                className="input p-2 border rounded text-sm"
                required
                value={schemeName}
                onChange={(e) => setSchemeName(e.target.value)}
              />
            </label>

            <label className="field flex flex-col gap-1 text-xs font-medium" htmlFor="scType">
              Target type
              <select
                id="scType"
                className="input p-2 border rounded text-sm"
                value={targetType}
                onChange={(e) => setTargetType(e.target.value as 'QTY' | 'VALUE')}
              >
                <option value="QTY">Quantity (cases)</option>
                <option value="VALUE">Value (₹)</option>
              </select>
            </label>

            <label className="field flex flex-col gap-1 text-xs font-medium" htmlFor="scTarget">
              Target
              <input
                id="scTarget"
                className="input p-2 border rounded text-sm font-mono"
                required
                inputMode="decimal"
                value={targetValue}
                onChange={(e) => setTargetValue(e.target.value)}
              />
            </label>

            <label className="field flex flex-col gap-1 text-xs font-medium" htmlFor="scStart">
              Start
              <input
                id="scStart"
                className="input p-2 border rounded text-sm"
                type="date"
                required
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </label>

            <label className="field flex flex-col gap-1 text-xs font-medium" htmlFor="scEnd">
              End
              <input
                id="scEnd"
                className="input p-2 border rounded text-sm"
                type="date"
                required
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </label>

            <label className="field flex flex-col gap-1 text-xs font-medium" htmlFor="scAlert">
              Alert at %
              <input
                id="scAlert"
                className="input p-2 border rounded text-sm font-mono"
                inputMode="decimal"
                value={alertThreshold}
                onChange={(e) => setAlertThreshold(e.target.value)}
              />
            </label>

            <label className="field flex flex-col gap-1 text-xs font-medium sm:col-span-2" htmlFor="scReward">
              Reward
              <input
                id="scReward"
                className="input p-2 border rounded text-sm"
                required
                placeholder="e.g. ₹500 discount per case"
                value={reward}
                onChange={(e) => setReward(e.target.value)}
              />
            </label>

            <div className="sm:col-span-2">
              <button
                className="btn-primary px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded font-medium text-sm disabled:opacity-50"
                type="submit"
                disabled={creating}
              >
                {creating ? 'Creating…' : 'Create scheme'}
              </button>
            </div>
          </form>
        </div>
      </details>

      {purchaseScheme && (
        <div id="modal" className="fixed inset-0 bg-black/50 flex justify-center overflow-y-auto [&>*]:my-auto p-4 z-50">
          <div className="bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-lg shadow-xl max-w-md w-full p-6">
            <div className="flex justify-between items-start mb-4">
              <h3 className="text-lg font-bold" id="modalTitle">Record purchase — {purchaseScheme.schemeName}</h3>
              <button
                type="button"
                onClick={() => setPurchaseScheme(null)}
                className="p-1 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                aria-label="Close dialog"
              >
                <X size={20} />
              </button>
            </div>
            <form onSubmit={handleSavePurchase} className="flex flex-col gap-3">
              <label className="field flex flex-col gap-1 text-xs font-medium" htmlFor="spQty">
                Cases
                <input
                  id="spQty"
                  className="input p-2 border rounded text-sm font-mono"
                  inputMode="decimal"
                  value={pQty}
                  onChange={(e) => setPQty(e.target.value)}
                />
              </label>
              <label className="field flex flex-col gap-1 text-xs font-medium" htmlFor="spValue">
                Value (₹)
                <input
                  id="spValue"
                  className="input p-2 border rounded text-sm font-mono"
                  inputMode="decimal"
                  value={pValue}
                  onChange={(e) => setPValue(e.target.value)}
                />
              </label>
              <label className="field flex flex-col gap-1 text-xs font-medium" htmlFor="spNotes">
                Notes
                <input
                  id="spNotes"
                  className="input p-2 border rounded text-sm"
                  maxLength={1000}
                  value={pNotes}
                  onChange={(e) => setPNotes(e.target.value)}
                />
              </label>
              <div className="flex justify-end gap-3 pt-3">
                <button
                  type="button"
                  className="btn-sec px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded border text-sm font-medium"
                  onClick={() => setPurchaseScheme(null)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  id="spSave"
                  className="btn-primary px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded text-sm font-medium"
                >
                  Save
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {editScheme && (
        <div id="modal" className="fixed inset-0 bg-black/60 backdrop-blur-sm flex justify-center overflow-y-auto [&>*]:my-auto p-4 z-50">
          <div className="bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-2xl shadow-2xl max-w-xl w-full p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-start border-b dark:border-gray-700 pb-3">
              <div>
                <h3 className="text-lg font-bold" id="modalTitle">Edit Scheme — {editScheme.schemeName}</h3>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  Update supplier scheme targets, timelines, rewards, and case slabs.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditScheme(null)}
                className="p-1 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                aria-label="Close dialog"
              >
                <X size={20} />
              </button>
            </div>

            <form onSubmit={handleUpdateScheme} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs font-medium">
                <label className="flex flex-col gap-1">
                  Supplier
                  <input
                    className="input p-2 border rounded text-sm dark:bg-gray-700 dark:border-gray-600"
                    required
                    value={editForm.supplierName}
                    onChange={(e) => setEditForm({ ...editForm, supplierName: e.target.value })}
                  />
                </label>

                <label className="flex flex-col gap-1">
                  Scheme Name
                  <input
                    className="input p-2 border rounded text-sm dark:bg-gray-700 dark:border-gray-600"
                    required
                    value={editForm.schemeName}
                    onChange={(e) => setEditForm({ ...editForm, schemeName: e.target.value })}
                  />
                </label>

                <label className="flex flex-col gap-1">
                  Target Type
                  <select
                    className="input p-2 border rounded text-sm dark:bg-gray-700 dark:border-gray-600"
                    value={editForm.targetType}
                    onChange={(e) => setEditForm({ ...editForm, targetType: e.target.value as 'QTY' | 'VALUE' })}
                  >
                    <option value="QTY">Quantity (Cases)</option>
                    <option value="VALUE">Value (₹)</option>
                  </select>
                </label>

                <label className="flex flex-col gap-1">
                  Target {editForm.targetType === 'VALUE' ? '(₹)' : '(Cases)'}
                  <input
                    className="input p-2 border rounded text-sm font-mono dark:bg-gray-700 dark:border-gray-600"
                    required
                    inputMode="decimal"
                    value={editForm.targetValue}
                    onChange={(e) => setEditForm({ ...editForm, targetValue: e.target.value })}
                  />
                </label>

                <label className="flex flex-col gap-1">
                  Start Date
                  <input
                    className="input p-2 border rounded text-sm dark:bg-gray-700 dark:border-gray-600"
                    type="date"
                    required
                    value={editForm.startDate}
                    onChange={(e) => setEditForm({ ...editForm, startDate: e.target.value })}
                  />
                </label>

                <label className="flex flex-col gap-1">
                  End Date
                  <input
                    className="input p-2 border rounded text-sm dark:bg-gray-700 dark:border-gray-600"
                    type="date"
                    required
                    value={editForm.endDate}
                    onChange={(e) => setEditForm({ ...editForm, endDate: e.target.value })}
                  />
                </label>

                <label className="flex flex-col gap-1">
                  Alert at %
                  <input
                    className="input p-2 border rounded text-sm font-mono dark:bg-gray-700 dark:border-gray-600"
                    inputMode="decimal"
                    value={editForm.alertThresholdPct}
                    onChange={(e) => setEditForm({ ...editForm, alertThresholdPct: e.target.value })}
                  />
                </label>

                <label className="flex flex-col gap-1">
                  Status
                  <select
                    className="input p-2 border rounded text-sm dark:bg-gray-700 dark:border-gray-600"
                    value={editForm.status}
                    onChange={(e) => setEditForm({ ...editForm, status: e.target.value })}
                  >
                    <option value="ACTIVE">ACTIVE</option>
                    <option value="COMPLETED">COMPLETED</option>
                    <option value="EXPIRED">EXPIRED</option>
                    <option value="CANCELLED">CANCELLED</option>
                  </select>
                </label>

                <label className="flex flex-col gap-1 sm:col-span-2">
                  Reward Description
                  <input
                    className="input p-2 border rounded text-sm dark:bg-gray-700 dark:border-gray-600"
                    required
                    value={editForm.rewardDescription}
                    onChange={(e) => setEditForm({ ...editForm, rewardDescription: e.target.value })}
                  />
                </label>

                <label className="flex flex-col gap-1 sm:col-span-2">
                  Notes
                  <textarea
                    rows={2}
                    className="input p-2 border rounded text-sm dark:bg-gray-700 dark:border-gray-600"
                    value={editForm.notes}
                    onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                    placeholder="Optional scheme terms, contract notes, or distributor instructions"
                  />
                </label>
              </div>

              {/* Slabs section */}
              <div className="border-t dark:border-gray-700 pt-3">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-xs font-bold text-gray-700 dark:text-gray-300">Case Slabs & Rewards</span>
                  <button
                    type="button"
                    className="text-xs px-2.5 py-1 bg-purple-100 dark:bg-purple-900/40 text-purple-800 dark:text-purple-300 rounded font-medium"
                    onClick={() => setEditSlabs([...editSlabs, { minCases: (editSlabs.length + 1) * 10, freeBottles: 1, discountPerCase: '0.00' }])}
                  >
                    + Add Slab
                  </button>
                </div>
                {editSlabs.length === 0 ? (
                  <p className="text-xs text-gray-500 italic">No slabs configured (flat target scheme).</p>
                ) : (
                  <div className="space-y-2">
                    {editSlabs.map((sl, idx) => (
                      <div key={idx} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 items-center text-xs">
                        <div>
                          <span className="text-[10px] text-gray-500 block">Min Cases</span>
                          <input
                            type="number"
                            min="0"
                            className="w-full p-1.5 border rounded font-mono dark:bg-gray-700 dark:border-gray-600"
                            value={sl.minCases}
                            onChange={(e) => {
                              const next = [...editSlabs];
                              next[idx].minCases = Number(e.target.value);
                              setEditSlabs(next);
                            }}
                          />
                        </div>
                        <div>
                          <span className="text-[10px] text-gray-500 block">Free Bottles</span>
                          <input
                            type="number"
                            min="0"
                            className="w-full p-1.5 border rounded font-mono dark:bg-gray-700 dark:border-gray-600"
                            value={sl.freeBottles}
                            onChange={(e) => {
                              const next = [...editSlabs];
                              next[idx].freeBottles = Number(e.target.value);
                              setEditSlabs(next);
                            }}
                          />
                        </div>
                        <div>
                          <span className="text-[10px] text-gray-500 block">Discount / Case (₹)</span>
                          <input
                            type="text"
                            inputMode="decimal"
                            className="w-full p-1.5 border rounded font-mono dark:bg-gray-700 dark:border-gray-600"
                            value={sl.discountPerCase}
                            onChange={(e) => {
                              const next = [...editSlabs];
                              next[idx].discountPerCase = e.target.value;
                              setEditSlabs(next);
                            }}
                          />
                        </div>
                        <button
                          type="button"
                          className="text-red-500 hover:text-red-700 p-1 text-base mt-3"
                          onClick={() => setEditSlabs(editSlabs.filter((_, i) => i !== idx))}
                          aria-label="Remove slab"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-3 pt-3 border-t dark:border-gray-700">
                <button
                  type="button"
                  className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-100 dark:hover:bg-gray-700"
                  onClick={() => setEditScheme(null)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={updating}
                  className="px-5 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-sm font-semibold disabled:opacity-50"
                >
                  {updating ? 'Saving Changes…' : 'Save Scheme Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
