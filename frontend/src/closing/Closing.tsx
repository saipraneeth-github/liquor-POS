import { useState, useEffect } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';

interface ClosingRow {
  id: string;
  closingDate: string;
  paidBillsCount: number;
  grossSales: string;
  expectedCashInDrawer: string;
  actualCashCounted: string;
  cashDiscrepancy: string;
  isBalanced: boolean;
}

interface ClosingResponse {
  id: string;
  businessDate: string;
  grossSales: string;
  paidBillsCount: number;
  voidedBillsCount: number;
  cashSales: string;
  cardSales: string;
  upiSales: string;
  creditSales: string;
  expectedCashInDrawer: string;
  actualCashCounted: string;
  cashDiscrepancy: string;
  isBalanced: boolean;
}

export function Closing() {
  const { user } = useAuth();
  const branchId = user?.branchId;

  const todayStr = new Date().toISOString().slice(0, 10);
  const [closingDate, setClosingDate] = useState(todayStr);
  const [openingCash, setOpeningCash] = useState('2000.00');
  const [actualCash, setActualCash] = useState('2000.00');
  const [withdrawals, setWithdrawals] = useState('0');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [history, setHistory] = useState<ClosingRow[]>([]);
  const [statusMsg, setStatusMsg] = useState<{
    type: 'success' | 'error';
    data?: ClosingResponse;
    text?: string;
  } | null>(null);

  // Confirmation modal
  const [confirmOpen, setConfirmOpen] = useState(false);

  const showToast = (msg: string, type: 'success' | 'error' = 'success') => {
    const host = document.getElementById('toastHost');
    if (!host) return;
    const el = document.createElement('div');
    el.className = `toast ${type} ${type === 'error' ? 'bg-red-600' : 'bg-emerald-600'} text-white p-3 rounded shadow`;
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  };

  const loadHistory = async () => {
    if (!branchId) return;
    try {
      const rows = await api.get<ClosingRow[]>('/closing?branchId=' + branchId);
      setHistory(rows);
    } catch {
      // quiet fail
    }
  };

  useEffect(() => {
    loadHistory();
  }, [branchId]);

  const handleSubmitClick = () => {
    if (!branchId) {
      setStatusMsg({ type: 'error', text: 'Select a branch first.' });
      return;
    }
    const op = parseFloat(openingCash.trim());
    if (isNaN(op)) {
      showToast('Enter the opening cash in the drawer.', 'error');
      return;
    }
    const act = parseFloat(actualCash.trim());
    if (isNaN(act)) {
      showToast('Enter the cash you counted.', 'error');
      return;
    }
    setConfirmOpen(true);
  };

  const executeClosing = async () => {
    if (!branchId) return;
    setSubmitting(true);
    setStatusMsg(null);
    try {
      const body = {
        branchId,
        openingCash: openingCash.trim(),
        actualCashCounted: actualCash.trim(),
        cashWithdrawals: withdrawals.trim() || '0',
        businessDate: closingDate || todayStr,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      };

      const res = await api.post<ClosingResponse>('/closing', body);
      setStatusMsg({ type: 'success', data: res });
      showToast('Day closed — report saved', 'success');
      setConfirmOpen(false);
      loadHistory();
    } catch (err: any) {
      setStatusMsg({ type: 'error', text: 'Failed: ' + err.message });
      showToast('Closing failed: ' + err.message, 'error');
      setConfirmOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="page active" id="page-closing" aria-labelledby="closingTitle">
      <h2 className="h1 text-xl font-bold mb-4" id="closingTitle">🔒 Daily Closing</h2>
      <div className="two-col grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="card pad stack p-6 bg-white rounded shadow flex flex-col gap-4">
          <div className="h2 text-lg font-bold border-b pb-2">💰 Cash reconciliation</div>

          <label className="field flex flex-col gap-1 text-sm font-medium" htmlFor="closingDate">
            Business date
            <input
              id="closingDate"
              className="input p-2 border rounded"
              type="date"
              max={todayStr}
              value={closingDate}
              onChange={(e) => setClosingDate(e.target.value)}
            />
          </label>

          <label className="field flex flex-col gap-1 text-sm font-medium" htmlFor="closingOpeningCash">
            Opening cash (₹)
            <input
              id="closingOpeningCash"
              className="input p-2 border rounded font-mono"
              inputMode="decimal"
              placeholder="0.00"
              required
              value={openingCash}
              onChange={(e) => setOpeningCash(e.target.value)}
            />
          </label>

          <label className="field flex flex-col gap-1 text-sm font-medium" htmlFor="closingActualCash">
            Actual cash counted (₹)
            <input
              id="closingActualCash"
              className="input p-2 border rounded font-mono"
              inputMode="decimal"
              placeholder="0.00"
              required
              value={actualCash}
              onChange={(e) => setActualCash(e.target.value)}
            />
          </label>

          <label className="field flex flex-col gap-1 text-sm font-medium" htmlFor="closingWithdrawals">
            Cash withdrawals (₹)
            <input
              id="closingWithdrawals"
              className="input p-2 border rounded font-mono"
              inputMode="decimal"
              placeholder="0.00"
              value={withdrawals}
              onChange={(e) => setWithdrawals(e.target.value)}
            />
          </label>

          <label className="field flex flex-col gap-1 text-sm font-medium" htmlFor="closingNotes">
            Notes (optional)
            <input
              id="closingNotes"
              className="input p-2 border rounded"
              maxLength={1000}
              placeholder="Anything unusual today"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>

          <button
            id="btnSubmitClosing"
            className="btn-primary mt-2 px-4 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium disabled:opacity-50"
            type="button"
            style={{ padding: '12px' }}
            disabled={submitting}
            onClick={handleSubmitClick}
          >
            {submitting ? 'Closing day…' : 'Close Day & Save Report'}
          </button>

          <div id="closingStatusMsg" role="status">
            {statusMsg && statusMsg.type === 'error' && (
              <div className="neg p-3 bg-red-50 text-red-700 rounded text-sm">{statusMsg.text}</div>
            )}
            {statusMsg && statusMsg.type === 'success' && statusMsg.data && (
              <div className="card pad small p-4 bg-emerald-50 text-emerald-900 rounded border border-emerald-200 text-sm flex flex-col gap-1">
                <div>
                  ✅ <b>Day Closed &amp; Locked</b> (Audit ID: {String(statusMsg.data.id).slice(0, 8)}…)
                </div>
                <div>
                  Business date {statusMsg.data.businessDate} · Gross ₹{parseFloat(statusMsg.data.grossSales).toFixed(2)} (
                  {statusMsg.data.paidBillsCount} paid {statusMsg.data.paidBillsCount === 1 ? 'bill' : 'bills'},{' '}
                  {statusMsg.data.voidedBillsCount} voided)
                </div>
                <div>
                  Cash ₹{parseFloat(statusMsg.data.cashSales).toFixed(2)} · Card ₹{parseFloat(statusMsg.data.cardSales).toFixed(2)} · UPI ₹
                  {parseFloat(statusMsg.data.upiSales).toFixed(2)} · Credit ₹{parseFloat(statusMsg.data.creditSales).toFixed(2)}
                </div>
                <div>
                  Expected in drawer ₹{parseFloat(statusMsg.data.expectedCashInDrawer).toFixed(2)} · Counted ₹
                  {parseFloat(statusMsg.data.actualCashCounted).toFixed(2)} · Discrepancy{' '}
                  <b className={parseFloat(statusMsg.data.cashDiscrepancy) === 0 ? 'text-green-600' : 'text-red-600'}>
                    ₹{parseFloat(statusMsg.data.cashDiscrepancy).toFixed(2)}
                  </b>{' '}
                  <span
                    className={`badge text-xs px-2 py-0.5 rounded font-medium ${
                      statusMsg.data.isBalanced ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                    }`}
                  >
                    {statusMsg.data.isBalanced ? 'Balanced' : 'Not balanced'}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="card pad stack p-6 bg-white rounded shadow flex flex-col gap-4">
          <div className="h2 text-lg font-bold border-b pb-2">Closing history</div>
          <div id="closingHistory" className="table-wrap overflow-x-auto text-sm">
            {history.length === 0 ? (
              <div className="muted small text-gray-500">No closings yet.</div>
            ) : (
              <table className="table w-full text-left">
                <thead>
                  <tr className="border-b text-xs text-gray-500 bg-gray-50">
                    <th className="py-2 px-2">Date</th>
                    <th className="py-2 px-2 text-right">Gross</th>
                    <th className="py-2 px-2 text-right">Expected cash</th>
                    <th className="py-2 px-2 text-right">Counted</th>
                    <th className="py-2 px-2 text-right">Discrepancy</th>
                  </tr>
                </thead>
                <tbody>
                  {history.slice(0, 15).map((c) => (
                    <tr key={c.id} className="border-b hover:bg-gray-50">
                      <td className="py-2 px-2">
                        {c.closingDate}
                        <div className="muted small text-xs text-gray-500">{c.paidBillsCount} bills</div>
                      </td>
                      <td className="py-2 px-2 text-right font-mono">₹{parseFloat(c.grossSales).toFixed(2)}</td>
                      <td className="py-2 px-2 text-right font-mono">₹{parseFloat(c.expectedCashInDrawer).toFixed(2)}</td>
                      <td className="py-2 px-2 text-right font-mono">₹{parseFloat(c.actualCashCounted).toFixed(2)}</td>
                      <td
                        className={`py-2 px-2 text-right font-mono ${
                          c.isBalanced ? 'text-green-600' : 'text-red-600'
                        }`}
                      >
                        ₹{parseFloat(c.cashDiscrepancy).toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {confirmOpen && (
        <div id="modal" className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
            <h3 className="text-lg font-bold mb-2" id="modalTitle">Close day {closingDate}?</h3>
            <p className="text-gray-600 mb-6 text-sm" id="confirmText">
              Opening ₹{parseFloat(openingCash).toFixed(2)} · Counted ₹{parseFloat(actualCash).toFixed(2)} · Withdrawals ₹
              {parseFloat(withdrawals || '0').toFixed(2)}. This locks the business day and cannot be undone.
            </p>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                id="confirmCancel"
                className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded border font-medium text-sm"
                onClick={() => setConfirmOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                id="confirmOk"
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium text-sm"
                onClick={executeClosing}
              >
                Close day
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

