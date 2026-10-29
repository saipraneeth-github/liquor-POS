import { useState, useEffect } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';

const NOTE_VALUES = ['2000', '500', '200', '100', '50', '20', '10'];

interface Terminal {
  id: string;
  terminalName: string;
  isActive: boolean;
}

interface ShiftSummary {
  cashCollected: string;
  cardCollected: string;
  upiCollected: string;
  creditCollected: string;
  grossCollected: string;
  paidBillsCount: number;
  expectedCash: string;
}

interface ShiftSession {
  id: string;
  terminalId: string;
  terminalName: string;
  cashierName: string;
  status: 'OPEN' | 'CLOSED';
  openedAt: string;
  closedAt?: string;
  openingFloat: string;
  expectedCash?: string;
  countedCash?: string;
  discrepancy?: string;
  summary: ShiftSummary;
}

interface ShiftCloseResponse {
  cashCollected: string;
  cardCollected: string;
  upiCollected: string;
  creditCollected: string;
  expectedCash: string;
  countedCash: string;
  discrepancy: string;
}

export function Shift() {
  const { user } = useAuth();
  const branchId = user?.branchId;
  const isManager = user?.role === 'manager' || user?.role === 'owner';

  const [loading, setLoading] = useState(false);
  const [terminals, setTerminals] = useState<Terminal[]>([]);
  const [currentShift, setCurrentShift] = useState<ShiftSession | null>(null);
  const [history, setHistory] = useState<ShiftSession[]>([]);

  // Open shift form
  const [selectedTerminal, setSelectedTerminal] = useState('');
  const [openingFloat, setOpeningFloat] = useState('1000.00');
  const [opening, setOpening] = useState(false);

  // Close shift denominations
  const [denoms, setDenoms] = useState<Record<string, string>>({});
  const [coins, setCoins] = useState('');
  const [notes, setNotes] = useState('');
  const [closing, setClosing] = useState(false);
  const [closeResult, setCloseResult] = useState<ShiftCloseResponse | null>(null);

  // Confirmation modal
  const [confirmOpen, setConfirmOpen] = useState(false);

  const showToast = (msg: string, type: 'success' | 'error' | 'info' = 'success') => {
    const host = document.getElementById('toastHost');
    if (!host) return;
    const el = document.createElement('div');
    el.className = `toast ${type} ${
      type === 'error' ? 'bg-red-600' : type === 'info' ? 'bg-blue-600' : 'bg-emerald-600'
    } text-white p-3 rounded shadow`;
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  };

  const loadShiftPage = async () => {
    if (!branchId) return;
    setLoading(true);
    setCloseResult(null);
    try {
      const res = await api.get<{ shift: ShiftSession | null }>('/shifts/current');
      setCurrentShift(res.shift);
      if (!res.shift) {
        const terms = await api.get<Terminal[]>('/terminals/' + branchId);
        const activeTerms = terms.filter((t) => t.isActive);
        setTerminals(activeTerms);
        if (activeTerms.length && !selectedTerminal) {
          setSelectedTerminal(activeTerms[0].id);
        }
      }
    } catch (err: any) {
      showToast(err.message || 'Failed to load shift', 'error');
    } finally {
      setLoading(false);
    }

    if (isManager) {
      const today = new Date().toISOString().slice(0, 10);
      try {
        const rows = await api.get<ShiftSession[]>(`/shifts?branchId=${branchId}&date=${today}`);
        setHistory(rows);
      } catch {
        // quiet fail
      }
    }
  };

  useEffect(() => {
    loadShiftPage();
  }, [branchId]);

  // Denominations calculation
  let counted = 0;
  for (const v of NOTE_VALUES) {
    const count = parseInt(denoms[v] || '0', 10);
    if (!isNaN(count) && count > 0) {
      counted += count * parseInt(v, 10);
    }
  }
  const coinsFloat = parseFloat(coins.trim() || '0');
  if (!isNaN(coinsFloat) && coinsFloat > 0) {
    counted += coinsFloat;
  }

  const expectedCashFloat = currentShift ? parseFloat(currentShift.summary.expectedCash) : 0;
  const diff = counted - expectedCashFloat;

  const discrepancyLabel = (val: number) => {
    if (Math.abs(val) < 0.001) return 'Balanced';
    return val < 0 ? 'Shortage' : 'Excess';
  };

  const formattedDiscrepancy = (val: number) => {
    const prefix = val < 0 ? '-₹' : '₹';
    const absVal = Math.abs(val).toFixed(2);
    return `${prefix}${absVal} (${discrepancyLabel(val)})`;
  };

  const handleOpenShift = async (e: React.FormEvent) => {
    e.preventDefault();
    const fl = parseFloat(openingFloat.trim());
    if (isNaN(fl) || fl < 0) {
      showToast('Opening float must be an amount like 1000 or 1000.50.', 'error');
      return;
    }
    setOpening(true);
    try {
      await api.post('/shifts/open', { terminalId: selectedTerminal, openingFloat: openingFloat.trim() });
      showToast('Shift opened', 'success');
      setDenoms({});
      setCoins('');
      setNotes('');
      await loadShiftPage();
    } catch (err: any) {
      showToast('Could not open shift: ' + err.message, 'error');
    } finally {
      setOpening(false);
    }
  };

  const executeCloseShift = async () => {
    if (!currentShift) return;
    setClosing(true);
    try {
      const denomMap: Record<string, number | string> = {};
      for (const v of NOTE_VALUES) {
        const count = parseInt(denoms[v] || '0', 10);
        if (!isNaN(count) && count > 0) {
          denomMap[v] = count;
        }
      }
      if (coins.trim()) {
        denomMap.coins = coins.trim();
      }

      const body: any = { denominations: denomMap };
      if (notes.trim()) body.notes = notes.trim();

      const res = await api.post<ShiftCloseResponse>(`/shifts/${currentShift.id}/close`, body);
      setCloseResult(res);
      setCurrentShift(null);
      const disc = parseFloat(res.discrepancy);
      showToast(`Shift closed — discrepancy ₹${disc.toFixed(2)}`, disc === 0 ? 'success' : 'info');
      if (isManager) {
        const today = new Date().toISOString().slice(0, 10);
        const rows = await api.get<ShiftSession[]>(`/shifts?branchId=${branchId}&date=${today}`);
        setHistory(rows);
      }
    } catch (err: any) {
      showToast('Could not close shift: ' + err.message, 'error');
    } finally {
      setClosing(false);
      setConfirmOpen(false);
    }
  };

  return (
    <section className="page active" id="page-shift" aria-labelledby="shiftTitle">
      <div className="row between flex justify-between items-center mb-4">
        <div>
          <h2 className="h1 text-xl font-bold" id="shiftTitle">⏱ Cashier Shift</h2>
          <div className="muted small text-xs text-gray-500">
            Open a shift on a terminal, track live collections and close with a cash count.
          </div>
        </div>
        <button
          className="btn-sec px-3 py-1 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded border font-medium text-sm"
          type="button"
          onClick={loadShiftPage}
        >
          ↻ Refresh
        </button>
      </div>

      <div id="shiftBody">
        {loading ? (
          <div className="card pad p-8 text-center text-gray-500 bg-white rounded shadow">Loading shift…</div>
        ) : closeResult ? (
          <div className="card pad stack p-6 bg-white rounded shadow flex flex-col gap-4 max-w-lg" id="shiftCloseResult">
            <div className="row between flex justify-between items-center">
              <div className="h2 text-lg font-bold">Shift closed</div>
              <span className="badge purple bg-purple-100 text-purple-800 text-xs px-2 py-0.5 rounded font-medium">
                CLOSED
              </span>
            </div>
            <table className="table w-full text-left">
              <tbody>
                <tr className="border-b">
                  <td className="py-2 text-sm">Cash collected</td>
                  <td className="py-2 text-right font-mono text-sm">₹{parseFloat(closeResult.cashCollected).toFixed(2)}</td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 text-sm">Card / UPI / Credit</td>
                  <td className="py-2 text-right font-mono text-sm">
                    ₹{parseFloat(closeResult.cardCollected).toFixed(2)} / ₹{parseFloat(closeResult.upiCollected).toFixed(2)} / ₹{parseFloat(closeResult.creditCollected).toFixed(2)}
                  </td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 text-sm">Expected cash</td>
                  <td className="py-2 text-right font-mono text-sm" id="shiftResultExpected">
                    ₹{parseFloat(closeResult.expectedCash).toFixed(2)}
                  </td>
                </tr>
                <tr className="border-b">
                  <td className="py-2 text-sm">Counted cash</td>
                  <td className="py-2 text-right font-mono text-sm" id="shiftResultCounted">
                    ₹{parseFloat(closeResult.countedCash).toFixed(2)}
                  </td>
                </tr>
                <tr className="border-b font-bold">
                  <td className="py-2 text-sm">Discrepancy</td>
                  <td
                    className={`py-2 text-right font-mono text-sm ${
                      parseFloat(closeResult.discrepancy) === 0
                        ? 'text-green-600'
                        : parseFloat(closeResult.discrepancy) < 0
                        ? 'text-red-600'
                        : 'text-yellow-600'
                    }`}
                    id="shiftResultDiscrepancy"
                  >
                    {formattedDiscrepancy(parseFloat(closeResult.discrepancy))}
                  </td>
                </tr>
              </tbody>
            </table>
            <button
              type="button"
              className="btn-primary mt-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium"
              onClick={loadShiftPage}
            >
              Open a new shift
            </button>
          </div>
        ) : !currentShift ? (
          <div className="card pad stack p-6 bg-white rounded shadow flex flex-col gap-4 max-w-xl">
            <div className="h2 text-lg font-bold">Open a shift</div>
            {terminals.length === 0 ? (
              <div className="text-gray-500 text-sm">
                No active terminals in this branch. {isManager ? 'Add one under Admin → Terminals.' : 'Ask a manager to add a terminal.'}
              </div>
            ) : (
              <form className="row end flex flex-wrap items-end gap-3" onSubmit={handleOpenShift}>
                <label className="field grow flex flex-col gap-1 text-sm font-medium" htmlFor="shiftTerminal" style={{ minWidth: '180px' }}>
                  Terminal
                  <select
                    id="shiftTerminal"
                    className="input p-2 border rounded"
                    required
                    value={selectedTerminal}
                    onChange={(e) => setSelectedTerminal(e.target.value)}
                  >
                    {terminals.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.terminalName}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field flex flex-col gap-1 text-sm font-medium" htmlFor="shiftFloat" style={{ width: '160px' }}>
                  Opening float (₹)
                  <input
                    id="shiftFloat"
                    className="input p-2 border rounded font-mono"
                    inputMode="decimal"
                    required
                    value={openingFloat}
                    onChange={(e) => setOpeningFloat(e.target.value)}
                  />
                </label>
                <button
                  className="btn-primary px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium"
                  type="submit"
                  id="shiftOpenBtn"
                  style={{ minHeight: '38px' }}
                  disabled={opening}
                >
                  {opening ? 'Opening…' : 'Open Shift'}
                </button>
              </form>
            )}
          </div>
        ) : (
          <div className="two-col grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="card pad stack p-4 bg-white rounded shadow flex flex-col gap-4">
              <div className="row between flex justify-between items-center border-b pb-2">
                <div className="h2 text-lg font-bold">Shift on {currentShift.terminalName}</div>
                <span className="badge green bg-green-100 text-green-800 text-xs px-2 py-0.5 rounded font-medium">
                  OPEN
                </span>
              </div>
              <div className="muted small text-xs text-gray-500">
                Opened {new Date(currentShift.openedAt).toLocaleString('en-IN')} · Opening float ₹{parseFloat(currentShift.openingFloat).toFixed(2)}
              </div>
              <table className="table w-full text-left" aria-label="Live shift totals">
                <tbody id="shiftTotals">
                  <tr className="border-b">
                    <td className="py-2 text-sm">Cash</td>
                    <td className="py-2 text-right font-mono text-sm" id="shiftCash">
                      ₹{parseFloat(currentShift.summary.cashCollected).toFixed(2)}
                    </td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-2 text-sm">Card</td>
                    <td className="py-2 text-right font-mono text-sm">
                      ₹{parseFloat(currentShift.summary.cardCollected).toFixed(2)}
                    </td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-2 text-sm">UPI</td>
                    <td className="py-2 text-right font-mono text-sm">
                      ₹{parseFloat(currentShift.summary.upiCollected).toFixed(2)}
                    </td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-2 text-sm">Credit (khata)</td>
                    <td className="py-2 text-right font-mono text-sm">
                      ₹{parseFloat(currentShift.summary.creditCollected).toFixed(2)}
                    </td>
                  </tr>
                  <tr className="border-b font-bold">
                    <td className="py-2 text-sm">Gross collected</td>
                    <td className="py-2 text-right font-mono text-sm">
                      ₹{parseFloat(currentShift.summary.grossCollected).toFixed(2)}
                    </td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-2 text-sm">Paid bills</td>
                    <td className="py-2 text-right font-mono text-sm" id="shiftBillCount">
                      {currentShift.summary.paidBillsCount}
                    </td>
                  </tr>
                  <tr className="border-b font-bold">
                    <td className="py-2 text-sm">
                      Expected cash in drawer
                      <div className="muted small font-normal text-xs text-gray-500">float + cash sales</div>
                    </td>
                    <td className="py-2 text-right font-mono text-sm" id="shiftExpectedLive">
                      ₹{parseFloat(currentShift.summary.expectedCash).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                  </tr>
                </tbody>
              </table>
              <div className="muted small text-xs text-gray-500" id="shiftUpdated">
                Updated {new Date().toLocaleTimeString('en-IN')}
              </div>
            </div>

            <div className="card pad stack p-4 bg-white rounded shadow flex flex-col gap-4">
              <div className="h2 text-lg font-bold">Close shift — cash count</div>
              <div className="table-wrap overflow-x-auto">
                <table className="table w-full text-left">
                  <thead>
                    <tr className="border-b text-xs text-gray-500">
                      <th className="py-1">Note</th>
                      <th className="py-1">Count</th>
                      <th className="py-1 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {NOTE_VALUES.map((v) => {
                      const count = parseInt(denoms[v] || '0', 10);
                      const amt = isNaN(count) ? 0 : count * parseInt(v, 10);
                      return (
                        <tr key={v} className="border-b text-sm">
                          <td className="py-1.5 font-medium">₹{v}</td>
                          <td className="py-1.5">
                            <input
                              id={`denom-${v}`}
                              className="input input-sm denom p-1 border rounded text-right font-mono text-sm"
                              type="number"
                              min="0"
                              step="1"
                              inputMode="numeric"
                              style={{ width: '90px' }}
                              aria-label={`Number of ₹${v} notes`}
                              value={denoms[v] || ''}
                              onChange={(e) => setDenoms({ ...denoms, [v]: e.target.value })}
                            />
                          </td>
                          <td className="py-1.5 text-right font-mono" id={`denomAmt-${v}`}>
                            ₹{amt.toFixed(2)}
                          </td>
                        </tr>
                      );
                    })}
                    <tr className="border-b text-sm">
                      <td className="py-1.5 font-medium">Coins</td>
                      <td className="py-1.5">
                        <input
                          id="denomCoins"
                          className="input input-sm p-1 border rounded text-right font-mono text-sm"
                          inputMode="decimal"
                          style={{ width: '90px' }}
                          aria-label="Coins total in rupees"
                          placeholder="0.00"
                          value={coins}
                          onChange={(e) => setCoins(e.target.value)}
                        />
                      </td>
                      <td className="py-1.5"></td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="totals-line flex justify-between text-sm py-1 border-b">
                <span>Counted</span>
                <b id="shiftCounted" className="font-mono">
                  ₹{counted.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </b>
              </div>
              <div className="totals-line flex justify-between text-sm py-1 border-b">
                <span>Expected</span>
                <b id="shiftExpected" className="font-mono">
                  ₹{expectedCashFloat.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </b>
              </div>
              <div className="totals-line big flex justify-between text-base py-1 border-b font-bold">
                <span>Discrepancy</span>
                <span
                  id="shiftDiscrepancy"
                  className={`font-mono ${
                    Math.abs(diff) < 0.001
                      ? 'text-green-600'
                      : diff < 0
                      ? 'text-red-600'
                      : 'text-yellow-600'
                  }`}
                >
                  {formattedDiscrepancy(diff)}
                </span>
              </div>

              <label className="field flex flex-col gap-1 text-sm font-medium" htmlFor="shiftNotes">
                Notes (optional)
                <input
                  id="shiftNotes"
                  className="input p-2 border rounded"
                  maxLength={1000}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </label>

              <button
                className="btn-primary px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium disabled:opacity-50"
                type="button"
                id="shiftCloseBtn"
                disabled={closing}
                onClick={() => setConfirmOpen(true)}
              >
                {closing ? 'Closing…' : 'Close Shift'}
              </button>
            </div>
          </div>
        )}
      </div>

      <div id="shiftHistory" className="mt-6">
        {isManager && history.length > 0 && (
          <div className="card bg-white rounded shadow p-4">
            <div className="pad h2 text-lg font-bold pb-2 border-b">Shifts today (branch)</div>
            <div id="shiftHistoryBody" className="table-wrap overflow-x-auto pt-2">
              <table className="table w-full text-left text-sm">
                <thead>
                  <tr className="border-b text-xs text-gray-500">
                    <th className="py-2">Terminal</th>
                    <th className="py-2">Cashier</th>
                    <th className="py-2">Status</th>
                    <th className="py-2">Opened</th>
                    <th className="py-2 text-right">Expected</th>
                    <th className="py-2 text-right">Counted</th>
                    <th className="py-2 text-right">Discrepancy</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((s) => (
                    <tr key={s.id} className="border-b hover:bg-gray-50">
                      <td className="py-2 font-medium">{s.terminalName}</td>
                      <td className="py-2">{s.cashierName}</td>
                      <td className="py-2">
                        <span
                          className={`badge text-xs px-2 py-0.5 rounded font-medium ${
                            s.status === 'OPEN' ? 'bg-green-100 text-green-800' : 'bg-purple-100 text-purple-800'
                          }`}
                        >
                          {s.status}
                        </span>
                      </td>
                      <td className="py-2 text-xs text-gray-600">
                        {new Date(s.openedAt).toLocaleTimeString('en-IN')}
                      </td>
                      <td className="py-2 text-right font-mono">
                        {s.expectedCash ? `₹${parseFloat(s.expectedCash).toFixed(2)}` : '—'}
                      </td>
                      <td className="py-2 text-right font-mono">
                        {s.countedCash ? `₹${parseFloat(s.countedCash).toFixed(2)}` : '—'}
                      </td>
                      <td className={`py-2 text-right font-mono ${s.discrepancy && parseFloat(s.discrepancy) < 0 ? 'text-red-600' : ''}`}>
                        {s.discrepancy ? `₹${parseFloat(s.discrepancy).toFixed(2)}` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {confirmOpen && (
        <div id="modal" className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
            <h3 className="text-lg font-bold mb-2" id="confirmTitle">Close shift?</h3>
            <p className="text-gray-600 mb-6 text-sm" id="confirmText">
              Counted ₹{counted.toFixed(2)} against the server's expected cash. The shift cannot be reopened.
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
                onClick={executeCloseShift}
              >
                Close shift
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

