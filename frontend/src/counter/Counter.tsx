import { useState, useEffect } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';

interface CounterLine {
  productId: string;
  productName: string;
  packQuantity?: number;
  closingSplit?: { cases: number; loose: number };
  openingBottles: number;
  inwardBottles: number;
  closingBottles: number;
  soldBottles: number;
  sellingRate: string;
  lineRevenue: string;
}

interface CounterSheet {
  id: string;
  branchId: string;
  sheetDate: string;
  status: 'DRAFT' | 'POSTED';
  postedAt?: string;
  totalRevenue: string;
  lines: CounterLine[];
}

interface RecentSheet {
  id: string;
  sheetDate: string;
  status: string;
}

export function Counter() {
  const { user } = useAuth();
  const branchId = user?.branchId;
  const isManager = user?.role === 'manager' || user?.role === 'owner';

  const todayStr = new Date().toISOString().slice(0, 10);
  const [sheetDate, setSheetDate] = useState(todayStr);
  const [recentSheets, setRecentSheets] = useState<RecentSheet[]>([]);
  const [sheet, setSheet] = useState<CounterSheet | null>(null);
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Local overrides for live input
  const [closingCounts, setClosingCounts] = useState<Record<string, string>>({});
  const [inwardCounts, setInwardCounts] = useState<Record<string, string>>({});
  const [approvals, setApprovals] = useState<Record<string, boolean>>({});

  // Confirmation modal
  const [confirmModal, setConfirmModal] = useState<{
    title: string;
    message: string;
    onOk: () => void;
  } | null>(null);

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

  const loadRecent = async () => {
    if (!branchId) return;
    try {
      const rows = await api.get<RecentSheet[]>('/counter-sheets/' + branchId);
      setRecentSheets(rows);
    } catch {
      // quiet fail
    }
  };

  useEffect(() => {
    loadRecent();
  }, [branchId]);

  const loadSheet = (sh: CounterSheet) => {
    setSheet(sh);
    setDirty(false);
    setSheetDate(sh.sheetDate);

    const initialClosing: Record<string, string> = {};
    const initialInward: Record<string, string> = {};
    for (const l of sh.lines) {
      initialClosing[l.productId] = String(l.closingBottles);
      initialInward[l.productId] = String(l.inwardBottles);
    }
    setClosingCounts(initialClosing);
    setInwardCounts(initialInward);
    setApprovals({});
  };

  const openSheetById = async (id: string) => {
    setLoading(true);
    try {
      const sh = await api.get<CounterSheet>('/counter-sheets/sheet/' + id);
      loadSheet(sh);
    } catch (e: any) {
      showToast('Could not open sheet: ' + e.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleOpenForDate = async () => {
    if (!branchId || !sheetDate) return;
    setLoading(true);
    try {
      const rows = await api.get<RecentSheet[]>(`/counter-sheets/${branchId}?date=${sheetDate}`);
      if (!rows.length) {
        showToast(`No sheet for ${sheetDate}. Use "Create sheet".`, 'info');
        setSheet(null);
        return;
      }
      await openSheetById(rows[0].id);
    } catch (e: any) {
      showToast('Error loading sheet: ' + e.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateSheet = async () => {
    if (!branchId) {
      showToast('Select a branch first.', 'error');
      return;
    }
    if (!sheetDate) {
      showToast('Pick a date.', 'error');
      return;
    }
    setLoading(true);
    try {
      const sh = await api.post<CounterSheet>('/counter-sheets/' + branchId, { sheetDate });
      loadSheet(sh);
      showToast('Counter sheet created for ' + sheetDate, 'success');
      loadRecent();
    } catch (e: any) {
      if (e.status === 409) {
        showToast('A sheet already exists for this date — opening it.', 'info');
        await handleOpenForDate();
      } else {
        showToast('Could not create sheet: ' + e.message, 'error');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleClosingChange = (productId: string, val: string) => {
    setClosingCounts((prev) => ({ ...prev, [productId]: val }));
    setDirty(true);
  };

  const handleInwardChange = (productId: string, val: string) => {
    setInwardCounts((prev) => ({ ...prev, [productId]: val }));
    setDirty(true);
  };

  const handleSaveSheet = async (silent = false): Promise<boolean> => {
    if (!sheet) return false;
    const lines: any[] = [];
    for (const l of sheet.lines) {
      const rawClosing = closingCounts[l.productId] ?? String(l.closingBottles);
      const closing = parseInt(rawClosing, 10);
      if (isNaN(closing)) {
        showToast(`Closing count for ${l.productName} must be a whole number.`, 'error');
        return false;
      }
      const linePayload: any = {
        productId: l.productId,
        closingBottles: closing,
      };

      if (isManager) {
        const rawInward = inwardCounts[l.productId] ?? String(l.inwardBottles);
        const inward = parseInt(rawInward, 10);
        if (isNaN(inward)) {
          showToast(`Inward for ${l.productName} must be a whole number.`, 'error');
          return false;
        }
        if (inward !== l.inwardBottles) {
          linePayload.inwardBottles = inward;
        }
      }

      if (approvals[l.productId]) {
        linePayload.approveAdjustment = true;
      }
      lines.push(linePayload);
    }

    try {
      const updated = await api.put<CounterSheet>(`/counter-sheets/sheet/${sheet.id}/lines`, { lines });
      loadSheet(updated);
      if (!silent) {
        showToast('Counts saved — revenue ₹' + parseFloat(updated.totalRevenue).toFixed(2), 'success');
      }
      return true;
    } catch (e: any) {
      showToast('Save failed: ' + e.message, 'error');
      return false;
    }
  };

  const handlePostSheet = () => {
    if (!sheet) return;
    setConfirmModal({
      title: 'Post counter sheet?',
      message: 'Stock will be corrected to the closing counts as of the sheet day. Posted sheets cannot be edited.',
      onOk: async () => {
        setConfirmModal(null);
        if (dirty) {
          const ok = await handleSaveSheet(true);
          if (!ok) return;
        }
        try {
          const posted = await api.post<CounterSheet>(`/counter-sheets/sheet/${sheet.id}/post`, {});
          loadSheet(posted);
          showToast('Counter sheet posted — stock corrected', 'success');
          loadRecent();
        } catch (e: any) {
          showToast('Post failed: ' + e.message, 'error');
        }
      },
    });
  };

  // Live calculation of lines
  let liveTotalRevenue = 0;
  const computedLines = (sheet?.lines || []).map((l) => {
    const rawClosing = closingCounts[l.productId] ?? String(l.closingBottles);
    const rawInward = inwardCounts[l.productId] ?? String(l.inwardBottles);
    const closing = parseInt(rawClosing, 10);
    const inward = parseInt(rawInward, 10);

    const isInvalid = isNaN(closing) || isNaN(inward);
    const sold = isInvalid ? 0 : l.openingBottles + inward - closing;
    const rate = parseFloat(l.sellingRate);
    const revenue = sold > 0 ? sold * rate : 0;
    if (!isInvalid && sold > 0) {
      liveTotalRevenue += revenue;
    }

    return {
      ...l,
      liveClosing: rawClosing,
      liveInward: rawInward,
      liveSold: isInvalid ? '?' : sold >= 0 ? String(sold) : `surplus ${-sold}`,
      isSurplus: sold < 0,
      liveRevenue: isInvalid ? '—' : '₹' + revenue.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    };
  });

  const isDraft = sheet?.status === 'DRAFT';

  return (
    <section className="page active" id="page-counter" aria-labelledby="counterTitle">
      <div className="mb-4">
        <h2 className="h1 text-xl font-bold" id="counterTitle">📋 Daily Counter Sheet</h2>
        <div className="muted small text-xs text-gray-500">
          Count closing bottles; sold = opening + inward − closing. A manager posts the sheet to correct stock.
        </div>
      </div>

      <div className="card pad p-4 bg-white rounded shadow mb-4 flex flex-col gap-3">
        <div className="row end flex flex-wrap items-end gap-3">
          <label className="field flex flex-col gap-1 text-sm font-medium" htmlFor="counterDate" style={{ width: '200px' }}>
            Sheet date
            <input
              id="counterDate"
              className="input p-2 border rounded"
              type="date"
              max={todayStr}
              value={sheetDate}
              onChange={(e) => setSheetDate(e.target.value)}
            />
          </label>
          <button
            className="btn-sec px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded border font-medium"
            type="button"
            onClick={handleOpenForDate}
          >
            Open
          </button>
          <button
            className="btn-primary px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium"
            type="button"
            id="counterCreateBtn"
            onClick={handleCreateSheet}
          >
            Create sheet
          </button>
        </div>

        <div id="counterRecent" className="row small flex flex-wrap items-center gap-2 text-xs pt-2">
          {recentSheets.length > 0 ? (
            <>
              <span className="muted text-gray-500">Recent:</span>
              {recentSheets.slice(0, 8).map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="tag px-2 py-1 bg-gray-100 hover:bg-gray-200 border rounded"
                  onClick={() => openSheetById(s.id)}
                >
                  {s.sheetDate} · {s.status}
                </button>
              ))}
            </>
          ) : (
            <span className="muted text-gray-500">No sheets yet.</span>
          )}
        </div>
      </div>

      <div className="card bg-white rounded shadow" id="counterSheet">
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading sheet…</div>
        ) : !sheet ? (
          <div className="state p-8 text-center text-gray-500">Pick a date and create or open a sheet.</div>
        ) : (
          <div>
            <div className="pad row between p-4 flex justify-between items-center border-b">
              <div>
                <div className="h2 text-lg font-bold">Sheet for {sheet.sheetDate}</div>
                <div className="muted small text-xs text-gray-500">
                  {sheet.lines.length} {sheet.lines.length === 1 ? 'product' : 'products'}
                  {sheet.postedAt ? ` · posted ${new Date(sheet.postedAt).toLocaleString('en-IN')}` : ''}
                </div>
              </div>
              <span id="counterStatus">
                <span
                  className={`badge px-2 py-1 text-xs rounded font-medium ${
                    sheet.status === 'POSTED' ? 'bg-blue-100 text-blue-800' : 'bg-yellow-100 text-yellow-800'
                  }`}
                >
                  {sheet.status}
                </span>
              </span>
            </div>

            <div className="table-wrap overflow-x-auto">
              <table className="table w-full text-left">
                <thead>
                  <tr className="border-b text-sm bg-gray-50">
                    <th className="py-2 px-3">Product</th>
                    <th className="py-2 px-3 text-right">Opening</th>
                    <th className="py-2 px-3 text-right">Inward</th>
                    <th className="py-2 px-3 text-right">Closing</th>
                    <th className="py-2 px-3 text-right">Sold</th>
                    <th className="py-2 px-3 text-right">Rate</th>
                    <th className="py-2 px-3 text-right">Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {computedLines.map((l) => (
                    <tr key={l.productId} data-product={l.productId} className="border-b hover:bg-gray-50 text-sm">
                      <td className="py-2 px-3">
                        <b>{l.productName}</b>
                        {l.closingSplit && l.packQuantity ? (
                          <div className="muted small text-xs text-gray-500">
                            {l.closingSplit.cases} cases + {l.closingSplit.loose} loose
                          </div>
                        ) : null}
                      </td>
                      <td className="py-2 px-3 text-right font-mono">{l.openingBottles}</td>
                      <td className="py-2 px-3 text-right font-mono">
                        {isDraft && isManager ? (
                          <input
                            id={`ci-${l.productId}`}
                            className="input input-sm counter-inward p-1 border rounded text-right font-mono text-sm"
                            type="number"
                            min="0"
                            value={l.liveInward}
                            style={{ width: '80px' }}
                            aria-label={`Inward bottles for ${l.productName}`}
                            onChange={(e) => handleInwardChange(l.productId, e.target.value)}
                          />
                        ) : (
                          l.liveInward
                        )}
                      </td>
                      <td className="py-2 px-3 text-right font-mono">
                        {isDraft ? (
                          <div className="flex flex-col items-end gap-1">
                            <input
                              id={`cc-${l.productId}`}
                              className="input input-sm counter-closing p-1 border rounded text-right font-mono text-sm"
                              type="number"
                              min="0"
                              value={l.liveClosing}
                              style={{ width: '80px' }}
                              aria-label={`Closing bottles for ${l.productName}`}
                              onChange={(e) => handleClosingChange(l.productId, e.target.value)}
                            />
                            {isManager && l.isSurplus && (
                              <label className="check small flex items-center gap-1 text-xs text-yellow-700" id={`ca-wrap-${l.productId}`}>
                                <input
                                  type="checkbox"
                                  id={`ca-${l.productId}`}
                                  checked={!!approvals[l.productId]}
                                  onChange={(e) =>
                                    setApprovals((prev) => ({ ...prev, [l.productId]: e.target.checked }))
                                  }
                                />
                                approve surplus
                              </label>
                            )}
                          </div>
                        ) : (
                          l.liveClosing
                        )}
                      </td>
                      <td className={`py-2 px-3 text-right font-mono ${l.isSurplus ? 'text-yellow-600 font-bold' : ''}`} id={`cs-${l.productId}`}>
                        {l.liveSold}
                      </td>
                      <td className="py-2 px-3 text-right font-mono">₹{parseFloat(l.sellingRate).toFixed(2)}</td>
                      <td className="py-2 px-3 text-right font-mono" id={`cr-${l.productId}`}>
                        {dirty
                          ? l.liveRevenue
                          : '₹' + parseFloat(l.lineRevenue).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t font-bold bg-gray-50">
                    <td colSpan={6} className="py-3 px-3">Total revenue</td>
                    <td className="py-3 px-3 text-right font-mono" id="counterTotal">
                      ₹{dirty
                        ? liveTotalRevenue.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                        : parseFloat(sheet.totalRevenue).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {isDraft ? (
              <div className="pad row p-4 flex items-center gap-3 border-t">
                <button
                  type="button"
                  className="btn-primary px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium"
                  id="counterSaveBtn"
                  onClick={() => handleSaveSheet()}
                >
                  Save counts
                </button>
                {isManager ? (
                  <button
                    type="button"
                    className="btn-sec px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded border font-medium"
                    id="counterPostBtn"
                    onClick={handlePostSheet}
                  >
                    Post sheet
                  </button>
                ) : (
                  <span className="muted small text-xs text-gray-500">A manager posts the sheet.</span>
                )}
                <span id="counterDirty" className="muted small text-xs text-yellow-600 font-medium" aria-live="polite">
                  {dirty ? 'Unsaved changes — preview only until saved.' : ''}
                </span>
              </div>
            ) : (
              <div className="pad muted small p-4 text-xs text-gray-500 border-t">Posted sheets are read-only.</div>
            )}
          </div>
        )}
      </div>

      {confirmModal && (
        <div id="modal" className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
            <h3 className="text-lg font-bold mb-2" id="confirmTitle">{confirmModal.title}</h3>
            <p className="text-gray-600 mb-6 text-sm" id="confirmText">{confirmModal.message}</p>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                id="confirmCancel"
                className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded border font-medium text-sm"
                onClick={() => setConfirmModal(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                id="confirmOk"
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium text-sm"
                onClick={confirmModal.onOk}
              >
                Post sheet
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

