import { useState, useEffect } from 'react';
import { X, RefreshCw, AlertCircle, CheckCircle2, TrendingUp, Package, Download, RotateCcw } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { BeerBottleLoader } from '../components/BeerBottleLoader';
import { ProtectedButton } from '../components/ui';
import { businessDate } from '../lib/business-day';

interface CounterLine {
  productId: string;
  productName: string;
  packQuantity?: number;
  closingSplit?: { cases: number; loose: number };
  openingBottles: number;
  inwardBottles: number;
  closingBottles: number;
  soldBottles: number;
  posSoldBottles?: number;
  sellingRate: string;
  lineRevenue: string;
  adjustmentApprovedById?: string | null;
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
  const { user, saasRole } = useAuth();
  const branchId = user?.branchId;
  const isManager = user?.role === 'manager' || user?.role === 'owner' || user?.role === 'office_admin';
  const isAdmin = user?.role === 'owner' || saasRole === 'admin' || saasRole === 'super_admin';

  const todayStr = businessDate();
  const [sheetDate, setSheetDate] = useState(todayStr);
  const [recentSheets, setRecentSheets] = useState<RecentSheet[]>([]);
  const [sheet, setSheet] = useState<CounterSheet | null>(null);
  const [loading, setLoading] = useState(false);
  const [isPosting, setIsPosting] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Local overrides for live input
  const [closingCounts, setClosingCounts] = useState<Record<string, string>>({});
  const [inwardCounts, setInwardCounts] = useState<Record<string, string>>({});
  const [approvals, setApprovals] = useState<Record<string, boolean>>({});
  const [filterStatus, setFilterStatus] = useState<'ALL' | 'SURPLUS' | 'SHORTAGE' | 'EXCESS' | 'MATCHED'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  // Confirmation modal
  const [confirmModal, setConfirmModal] = useState<{
    title: string;
    message: string;
    confirmButtonText?: string;
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

    const onStockUpdated = () => {
      // If a draft sheet is open and user isn't currently typing unsaved edits, auto-refresh it
      if (sheet?.id && !dirty) {
        openSheetById(sheet.id, true);
      } else {
        loadRecent();
      }
    };

    window.addEventListener('app:stock_updated', onStockUpdated);
    return () => window.removeEventListener('app:stock_updated', onStockUpdated);
  }, [branchId, sheet?.id, dirty]);


  useEffect(() => {
    if (!branchId || !sheetDate) return;
    let active = true;
    setLoading(true);
    api.get<RecentSheet[]>(`/counter-sheets/${branchId}?date=${sheetDate}`)
      .then(async (rows) => {
        if (!active) return;
        if (rows.length > 0) {
          if (!sheet || sheet.sheetDate !== sheetDate) {
            await openSheetById(rows[0].id, true);
          }
        } else if (sheetDate === todayStr) {
          // Automatically create/load today's sheet so user never gets stuck at "Pick a date"
          try {
            const sh = await api.post<CounterSheet>('/counter-sheets/' + branchId, { sheetDate });
            if (active) {
              loadSheet(sh);
              loadRecent();
            }
          } catch (err: any) {
            if (active && (err.status === 409 || err.message?.toLowerCase().includes('already exists'))) {
              const existingId = err.data?.details?.sheetId;
              if (existingId) {
                await openSheetById(existingId, true);
              }
            }
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [branchId, sheetDate]);


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
    const initialApprovals: Record<string, boolean> = {};
    for (const l of sh.lines) {
      if (l.adjustmentApprovedById || (isManager && l.closingBottles > l.openingBottles + l.inwardBottles)) {
        initialApprovals[l.productId] = true;
      }
    }
    setApprovals(initialApprovals);
  };

  const openSheetById = async (id: string, quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const sh = await api.get<CounterSheet>('/counter-sheets/sheet/' + id);
      loadSheet(sh);
    } catch (e: any) {
      if (!quiet) showToast('Could not open sheet: ' + e.message, 'error');
    } finally {
      if (!quiet) setLoading(false);
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
      showToast('Counter sheet created for ' + sheetDate + ' — auto-updated with sales', 'success');
      loadRecent();
    } catch (e: any) {
      if (e.status === 409 || e.message?.toLowerCase().includes('already exists')) {
        showToast('A sheet already exists for ' + sheetDate + ' — opening existing sheet.', 'info');
        const existingId = e.data?.details?.sheetId;
        if (existingId) {
          await openSheetById(existingId);
          return;
        }
        showToast('A sheet already exists for this date — opening it.', 'info');
        await handleOpenForDate();
      } else {
        showToast('Could not create sheet: ' + e.message, 'error');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadSheet = async (format: 'xlsx' | 'csv' = 'xlsx') => {
    if (!sheet) return;
    try {
      if (format === 'xlsx') {
        await api.download(
          `/counter-sheets/sheet/${sheet.id}/excel`,
          `counter-sheet-${sheet.sheetDate}.xlsx`
        );
        showToast('Counter sheet downloaded as styled Excel (.xlsx)', 'success');
      } else {
        await api.download(
          `/counter-sheets/sheet/${sheet.id}/csv`,
          `counter-sheet-${sheet.sheetDate}.csv`
        );
        showToast('Counter sheet downloaded as CSV', 'success');
      }
    } catch (e: any) {
      showToast('Download failed: ' + e.message, 'error');
    }
  };

  const handleSyncSales = async () => {
    if (!sheet) return;
    setLoading(true);
    try {
      const synced = await api.post<CounterSheet>(`/counter-sheets/sheet/${sheet.id}/sync`, {});
      loadSheet(synced);
      showToast('Counter sheet synchronized with live POS sales', 'success');
    } catch (e: any) {
      showToast('Sync failed: ' + e.message, 'error');
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

      const available = l.openingBottles + (linePayload.inwardBottles ?? l.inwardBottles);
      const isSurplus = closing > available;
      if (approvals[l.productId] || l.adjustmentApprovedById || (isManager && isSurplus)) {
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
    if (!sheet || isPosting) return;
    setConfirmModal({
      title: 'Post counter sheet?',
      message: 'Stock will be corrected to the closing counts as of the sheet day. Posted sheets cannot be edited.',
      onOk: async () => {
        setConfirmModal(null);
        setIsPosting(true);
        if (dirty) {
          const ok = await handleSaveSheet(true);
          if (!ok) {
            setIsPosting(false);
            return;
          }
        }
        try {
          const posted = await api.post<CounterSheet>(`/counter-sheets/sheet/${sheet.id}/post`, {});
          loadSheet(posted);
          showToast('Counter sheet posted — stock corrected', 'success');
          loadRecent();
          window.dispatchEvent(new CustomEvent('app:stock_updated', { detail: { branchId } }));
        } catch (e: any) {
          showToast('Post failed: ' + e.message, 'error');
        } finally {
          setIsPosting(false);
        }
      },
    });
  };

  const handleRevertToDraft = () => {
    if (!sheet) return;
    setConfirmModal({
      title: 'Revert counter sheet to Draft?',
      message: 'Stock adjustments applied when posting will be reversed back to their pre-post quantities. You will be able to edit closing counts and post again.',
      confirmButtonText: 'Revert to Draft',
      onOk: async () => {
        setConfirmModal(null);
        setLoading(true);
        try {
          const reverted = await api.post<CounterSheet>(`/counter-sheets/sheet/${sheet.id}/unpost`, {});
          loadSheet(reverted);
          showToast('Counter sheet reverted to Draft — stock corrections reversed', 'success');
          loadRecent();
          window.dispatchEvent(new CustomEvent('app:stock_updated', { detail: { branchId } }));
        } catch (e: any) {
          showToast('Revert failed: ' + e.message, 'error');
        } finally {
          setLoading(false);
        }
      },
    });
  };

  // Live calculation of lines
  let liveTotalRevenue = 0;
  let liveTotalSoldBottles = 0;
  let totalPosSoldBottles = 0;

  const computedLines = (sheet?.lines || []).map((l) => {
    const rawClosing = closingCounts[l.productId] ?? String(l.closingBottles);
    const rawInward = inwardCounts[l.productId] ?? String(l.inwardBottles);
    const closing = parseInt(rawClosing, 10);
    const inward = parseInt(rawInward, 10);

    const isInvalid = isNaN(closing) || isNaN(inward);
    const available = l.openingBottles + inward;
    const sold = isInvalid ? 0 : available - closing;
    const rate = parseFloat(l.sellingRate);
    const revenue = sold > 0 ? sold * rate : 0;
    if (!isInvalid && sold > 0) {
      liveTotalRevenue += revenue;
      liveTotalSoldBottles += sold;
    }

    const posSold = l.posSoldBottles ?? 0;
    totalPosSoldBottles += posSold;
    const expectedClosing = Math.max(0, available - posSold);
    const diffWithPos = sold - posSold;

    let diffType: 'SURPLUS' | 'SHORTAGE' | 'EXCESS' | 'MATCHED' = 'MATCHED';
    let diffAmount = 0;

    if (!isInvalid) {
      if (closing > available) {
        diffType = 'SURPLUS';
        diffAmount = closing - available;
      } else if (closing < expectedClosing) {
        diffType = 'SHORTAGE';
        diffAmount = expectedClosing - closing;
      } else if (closing > expectedClosing) {
        diffType = 'EXCESS';
        diffAmount = closing - expectedClosing;
      } else {
        diffType = 'MATCHED';
        diffAmount = 0;
      }
    }

    const rowClass = {
      SURPLUS: 'bg-amber-50/70 hover:bg-amber-100/80 dark:bg-amber-950/30 dark:hover:bg-amber-900/40 border-l-4 border-l-amber-500',
      SHORTAGE: 'bg-rose-50/70 hover:bg-rose-100/80 dark:bg-rose-950/30 dark:hover:bg-rose-900/40 border-l-4 border-l-rose-500',
      EXCESS: 'bg-sky-50/70 hover:bg-sky-100/80 dark:bg-sky-950/30 dark:hover:bg-sky-900/40 border-l-4 border-l-sky-500',
      MATCHED: 'hover:bg-gray-50/60 dark:hover:bg-gray-800/60 border-l-4 border-l-transparent',
    }[diffType];

    return {
      ...l,
      liveClosing: rawClosing,
      liveInward: rawInward,
      liveSold: isInvalid ? '?' : sold >= 0 ? String(sold) : `surplus ${-sold}`,
      numericSold: sold,
      posSold,
      diffWithPos,
      expectedClosing,
      diffType,
      diffAmount,
      rowClass,
      isSurplus: diffType === 'SURPLUS',
      isShortage: diffType === 'SHORTAGE',
      isExcess: diffType === 'EXCESS',
      isMatched: diffType === 'MATCHED',
      liveRevenue: isInvalid ? '—' : '₹' + revenue.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    };
  });



  const surplusCount = computedLines.filter((l) => l.diffType === 'SURPLUS').length;
  const shortageCount = computedLines.filter((l) => l.diffType === 'SHORTAGE').length;
  const excessCount = computedLines.filter((l) => l.diffType === 'EXCESS').length;
  const matchedCount = computedLines.filter((l) => l.diffType === 'MATCHED').length;

  const totalSurplusBottles = computedLines
    .filter((l) => l.diffType === 'SURPLUS')
    .reduce((sum, l) => sum + l.diffAmount, 0);
  const totalShortageBottles = computedLines
    .filter((l) => l.diffType === 'SHORTAGE')
    .reduce((sum, l) => sum + l.diffAmount, 0);
  const totalExcessBottles = computedLines
    .filter((l) => l.diffType === 'EXCESS')
    .reduce((sum, l) => sum + l.diffAmount, 0);
  const totalDiscrepancyCount = surplusCount + shortageCount + excessCount;
  const liveTotalClosingBottles = computedLines.reduce((sum, l) => sum + (parseInt(l.liveClosing, 10) || 0), 0);

  const displayLines = computedLines.filter((l) => {
    if (filterStatus !== 'ALL' && l.diffType !== filterStatus) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      return l.productName.toLowerCase().includes(q);
    }
    return true;
  });

  const isDraft = sheet?.status === 'DRAFT';
  const postedDate = sheet?.postedAt ? sheet.postedAt.slice(0, 10) : null;
  const isPostedToday = postedDate === todayStr || sheet?.sheetDate === todayStr;
  const canRevertToDraft = !isDraft && isManager && isPostedToday;
  const totalVariance = liveTotalSoldBottles - totalPosSoldBottles;

  return (
    <section className="page active" id="page-counter" aria-labelledby="counterTitle">
      <div className="mb-4">
        <h2 className="h1 text-2xl font-bold" id="counterTitle">Counter Stock</h2>
        <div className="muted small text-xs text-gray-500">
          Physical bottle counts: sold = opening + inward − {isAdmin ? 'physical stock present' : 'closing'}. Adjust counts and post to reconcile stock.
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
            className="btn-primary px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded font-medium cursor-pointer"
            type="button"
            id="counterCreateBtn"
            onClick={handleCreateSheet}
          >
            Counter Stock
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
          <BeerBottleLoader inline size="sm" title="Loading Counter Stock Sheet…" subtitle="Fetching opening, inward and physical bottle counts…" />
        ) : !sheet ? (
          <div className="state p-8 text-center text-gray-500">Loading Counter Stock for today...</div>
        ) : (
          <div>
            <div className="pad row between p-4 flex justify-between items-center border-b">
              <div>
                <div className="h2 text-lg font-bold">Counter Stock Sheet for {sheet.sheetDate}</div>
                <div className="muted small text-xs text-gray-500">
                  {sheet.lines.length} {sheet.lines.length === 1 ? 'product' : 'products'}
                  {sheet.postedAt ? ` · posted ${new Date(sheet.postedAt).toLocaleString('en-IN')}` : ''}
                </div>
              </div>
              <div className="flex items-center gap-3">
                {isDraft && (
                  <button
                    type="button"
                    id="counterSyncBtn"
                    className="btn-sec px-3 py-1.5 bg-blue-50 text-blue-700 hover:bg-blue-100 rounded border border-blue-200 text-xs font-semibold flex items-center gap-1.5"
                    onClick={handleSyncSales}
                    title="Recalculate expected closing counts and sold bottles from today's POS sales bills"
                  >
                    <RefreshCw size={13} />
                    Sync with POS Sales
                  </button>
                )}
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    id="counterDownloadBtn"
                    className="btn-sec px-3 py-1.5 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 rounded border border-emerald-200 dark:border-emerald-800 text-xs font-semibold flex items-center gap-1.5"
                    onClick={() => handleDownloadSheet('xlsx')}
                    title="Download counter sheet as formatted Excel spreadsheet (.xlsx) with tables, borders and color highlights"
                  >
                    <Download size={13} />
                    Download Excel
                  </button>
                  <button
                    type="button"
                    className="btn-sec px-2 py-1.5 bg-gray-50 text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 rounded border text-xs font-medium"
                    onClick={() => handleDownloadSheet('csv')}
                    title="Download raw CSV"
                  >
                    CSV
                  </button>
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
                {canRevertToDraft && (
                  <button
                    type="button"
                    id="counterRevertBtn"
                    className="btn-sec px-3 py-1.5 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-300 rounded border border-amber-300 dark:border-amber-700 text-xs font-semibold flex items-center gap-1.5 cursor-pointer shadow-sm transition"
                    onClick={handleRevertToDraft}
                    title="Revert this sheet to DRAFT so closing counts can be corrected (allowed because it was posted today)"
                  >
                    <RotateCcw size={13} />
                    Revert to Draft
                  </button>
                )}
              </div>
            </div>

            {/* KPI Summary Banner */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-4 bg-gray-50 border-b text-sm">
              <div className="p-3 bg-white rounded border flex flex-col">
                <span className="text-xs text-gray-500 flex items-center gap-1">
                  <TrendingUp size={13} className="text-blue-600" />
                  Total Sheet Revenue
                </span>
                <span className="text-lg font-bold text-gray-900 mt-1">
                  ₹{dirty
                    ? liveTotalRevenue.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                    : parseFloat(sheet.totalRevenue).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
              <div className="p-3 bg-white rounded border flex flex-col">
                <span className="text-xs text-gray-500 flex items-center gap-1">
                  <Package size={13} className="text-emerald-600" />
                  Total Bottles Sold
                </span>
                <span className="text-lg font-bold text-gray-900 mt-1">
                  {liveTotalSoldBottles} bottles
                </span>
              </div>
              <div className="p-3 bg-white dark:bg-gray-800 rounded border flex flex-col">
                <span className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1">
                  <Package size={13} className="text-purple-600" />
                  {isAdmin ? 'Physical Stock Present' : 'Total Closing Stock'}
                </span>
                <span className="text-lg font-bold text-gray-900 dark:text-gray-100 mt-1" id="counterTotalStockPresent">
                  {liveTotalClosingBottles} bottles
                </span>
              </div>
              <div className="p-3 bg-white dark:bg-gray-800 rounded border flex flex-col justify-between">
                <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
                  <span className="flex items-center gap-1 font-medium">
                    {totalDiscrepancyCount === 0 && totalVariance === 0 ? (
                      <CheckCircle2 size={13} className="text-emerald-600" />
                    ) : (
                      <AlertCircle size={13} className="text-amber-600" />
                    )}
                    Stock Reconciliation
                  </span>
                  {totalVariance !== 0 && (
                    <span
                      className="text-[11px] font-medium text-gray-500 bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded cursor-help"
                      title={`Sales comparison: Sheet sold (${liveTotalSoldBottles}) minus POS billed (${totalPosSoldBottles}) = ${totalVariance > 0 ? '+' : ''}${totalVariance} btls`}
                    >
                      Sales diff: {totalVariance > 0 ? `+${totalVariance}` : totalVariance}
                    </span>
                  )}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                  {totalDiscrepancyCount === 0 && totalVariance === 0 ? (
                    <span className="text-xs font-semibold px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">
                      ✓ Matches POS & Stock
                    </span>
                  ) : (
                    <>
                      {totalSurplusBottles > 0 && (
                        <span
                          className="text-xs font-semibold px-2 py-0.5 rounded bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200"
                          title={`${totalSurplusBottles} surplus bottles counted above available stock across ${surplusCount} product(s)`}
                        >
                          +{totalSurplusBottles} Surplus
                        </span>
                      )}
                      {totalShortageBottles > 0 && (
                        <span
                          className="text-xs font-semibold px-2 py-0.5 rounded bg-rose-100 text-rose-900 dark:bg-rose-950/60 dark:text-rose-200"
                          title={`${totalShortageBottles} unbilled bottles missing from shelf across ${shortageCount} product(s)`}
                        >
                          -{totalShortageBottles} Shortage
                        </span>
                      )}
                      {totalExcessBottles > 0 && (
                        <span
                          className="text-xs font-semibold px-2 py-0.5 rounded bg-sky-100 text-sky-900 dark:bg-sky-950/60 dark:text-sky-200"
                          title={`${totalExcessBottles} bottles found on shelf that POS billed across ${excessCount} product(s)`}
                        >
                          +{totalExcessBottles} Shelf Excess
                        </span>
                      )}
                      {totalDiscrepancyCount === 0 && totalVariance !== 0 && (
                        <span className="text-xs font-semibold px-2 py-0.5 rounded bg-amber-100 text-amber-800">
                          Diff: {totalVariance > 0 ? `+${totalVariance}` : totalVariance} btls
                        </span>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Quick Filter Chips & Discrepancy Legend */}
            <div className="p-3 bg-gray-50 dark:bg-gray-800/40 border-b flex flex-wrap items-center justify-between gap-3 text-xs">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-semibold text-gray-500 mr-1">Filter:</span>
                <button
                  type="button"
                  className={`px-2.5 py-1 rounded-full font-medium transition cursor-pointer ${
                    filterStatus === 'ALL'
                      ? 'bg-gray-800 text-white dark:bg-gray-200 dark:text-gray-900'
                      : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 border hover:bg-gray-100'
                  }`}
                  onClick={() => setFilterStatus('ALL')}
                >
                  All ({computedLines.length})
                </button>
                <button
                  type="button"
                  className={`px-2.5 py-1 rounded-full font-semibold transition cursor-pointer flex items-center gap-1 ${
                    filterStatus === 'SURPLUS'
                      ? 'bg-amber-600 text-white'
                      : 'bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200 border border-amber-300 dark:border-amber-700 hover:bg-amber-100'
                  }`}
                  onClick={() => setFilterStatus('SURPLUS')}
                >
                  Surplus ({surplusCount})
                </button>
                <button
                  type="button"
                  className={`px-2.5 py-1 rounded-full font-semibold transition cursor-pointer flex items-center gap-1 ${
                    filterStatus === 'SHORTAGE'
                      ? 'bg-rose-600 text-white'
                      : 'bg-rose-50 dark:bg-rose-950/40 text-rose-800 dark:text-rose-200 border border-rose-300 dark:border-rose-700 hover:bg-rose-100'
                  }`}
                  onClick={() => setFilterStatus('SHORTAGE')}
                >
                  Below Stock ({shortageCount})
                </button>
                <button
                  type="button"
                  className={`px-2.5 py-1 rounded-full font-semibold transition cursor-pointer flex items-center gap-1 ${
                    filterStatus === 'EXCESS'
                      ? 'bg-sky-600 text-white'
                      : 'bg-sky-50 dark:bg-sky-950/40 text-sky-800 dark:text-sky-200 border border-sky-300 dark:border-sky-700 hover:bg-sky-100'
                  }`}
                  onClick={() => setFilterStatus('EXCESS')}
                >
                  Shelf Excess ({excessCount})
                </button>
                <button
                  type="button"
                  className={`px-2.5 py-1 rounded-full font-medium transition cursor-pointer flex items-center gap-1 ${
                    filterStatus === 'MATCHED'
                      ? 'bg-emerald-600 text-white'
                      : 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-200 border border-emerald-300 dark:border-emerald-700 hover:bg-emerald-100'
                  }`}
                  onClick={() => setFilterStatus('MATCHED')}
                >
                  ✓ Matched ({matchedCount})
                </button>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  placeholder="Filter by product name..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="p-1 px-3 text-xs border rounded w-48 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100"
                />
              </div>
            </div>

            <div className="table-wrap overflow-x-auto">
              <table className="table w-full text-left">
                <thead>
                  <tr className="border-b text-sm bg-gray-50">
                    <th className="py-2 px-3">Product</th>
                    <th className="py-2 px-3 text-right">Opening</th>
                    <th className="py-2 px-3 text-right">Inward</th>
                    <th className="py-2 px-3 text-right">
                      {isAdmin ? 'Physical Stock Present' : 'Closing'}
                    </th>
                    <th className="py-2 px-3 text-right">Sold</th>
                    <th className="py-2 px-3 text-right">Rate</th>
                    <th className="py-2 px-3 text-right">Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {displayLines.map((l) => (
                    <tr key={l.productId} data-product={l.productId} className={`border-b text-sm transition-colors ${l.rowClass}`}>
                      <td className="py-2 px-3">
                        <div className="font-semibold text-gray-900 dark:text-gray-100">{l.productName}</div>
                        <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
                          {l.diffType === 'SURPLUS' && (
                            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-900 bg-amber-100 dark:bg-amber-900/60 dark:text-amber-200 px-2 py-0.5 rounded border border-amber-300 dark:border-amber-700">
                              Surplus (+{l.diffAmount} bottles)
                            </span>
                          )}
                          {l.diffType === 'SHORTAGE' && (
                            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-rose-900 bg-rose-100 dark:bg-rose-900/60 dark:text-rose-200 px-2 py-0.5 rounded border border-rose-300 dark:border-rose-700">
                              Below Stock (-{l.diffAmount} unbilled)
                            </span>
                          )}
                          {l.diffType === 'EXCESS' && (
                            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-sky-900 bg-sky-100 dark:bg-sky-900/60 dark:text-sky-200 px-2 py-0.5 rounded border border-sky-300 dark:border-sky-700">
                              Shelf Excess (+{l.diffAmount} vs POS)
                            </span>
                          )}
                          {l.diffType === 'MATCHED' && (
                            <span className="inline-flex items-center gap-1 text-[10px] text-emerald-800 bg-emerald-100 dark:bg-emerald-950/50 dark:text-emerald-300 px-1.5 py-0.5 rounded">
                              ✓ Matched POS
                            </span>
                          )}
                        </div>
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
                              aria-label={`${isAdmin ? 'Physical Stock Present' : 'Closing'} bottles for ${l.productName}`}
                              onChange={(e) => handleClosingChange(l.productId, e.target.value)}
                            />
                            {isManager && l.isSurplus && (
                              <label
                                className={`check small flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded border cursor-pointer mt-1 ${
                                  approvals[l.productId] || l.adjustmentApprovedById
                                    ? 'bg-emerald-100 text-emerald-900 border-emerald-400'
                                    : 'bg-amber-100 text-amber-900 border-amber-400 animate-pulse'
                                }`}
                                id={`ca-wrap-${l.productId}`}
                              >
                                <input
                                  type="checkbox"
                                  id={`ca-${l.productId}`}
                                  checked={!!(approvals[l.productId] || l.adjustmentApprovedById)}
                                  onChange={(e) =>
                                    setApprovals((prev) => ({ ...prev, [l.productId]: e.target.checked }))
                                  }
                                />
                                {approvals[l.productId] || l.adjustmentApprovedById ? '✓ Surplus approved' : 'Approve surplus'}
                              </label>
                            )}
                          </div>
                        ) : (
                          l.liveClosing
                        )}
                      </td>
                      <td
                        className={`py-2 px-3 text-right font-mono ${
                          l.isSurplus
                            ? 'text-amber-800 font-bold'
                            : l.isShortage
                            ? 'text-rose-800 font-bold'
                            : l.isExcess
                            ? 'text-sky-800 font-semibold'
                            : ''
                        }`}
                        id={`cs-${l.productId}`}
                      >
                        {l.liveSold}
                        {l.isShortage && (
                          <span className="text-[10px] text-rose-600 block font-normal">(-{l.diffAmount} missing)</span>
                        )}
                        {l.isExcess && (
                          <span className="text-[10px] text-sky-600 block font-normal">(+{l.diffAmount} in shelf)</span>
                        )}
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
              <div className="pad row p-4 flex items-center justify-between gap-3 border-t">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    className="btn-primary px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded font-medium"
                    id="counterSaveBtn"
                    onClick={() => handleSaveSheet()}
                  >
                    Save counts
                  </button>
                  <button
                    type="button"
                    className="btn-sec px-4 py-2 bg-blue-50 text-blue-700 hover:bg-blue-100 rounded border border-blue-200 font-medium flex items-center gap-1.5"
                    onClick={handleSyncSales}
                  >
                    <RefreshCw size={14} />
                    Sync from POS Sales
                  </button>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      className="btn-sec px-3 py-2 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 rounded border border-emerald-200 dark:border-emerald-800 font-medium text-xs flex items-center gap-1.5"
                      onClick={() => handleDownloadSheet('xlsx')}
                      title="Download formatted Excel (.xlsx)"
                    >
                      <Download size={14} />
                      Download Excel
                    </button>
                    <button
                      type="button"
                      className="btn-sec px-2 py-2 bg-gray-50 text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 rounded border text-xs font-medium"
                      onClick={() => handleDownloadSheet('csv')}
                      title="Download raw CSV"
                    >
                      CSV
                    </button>
                  </div>
                  {isManager ? (
                    <ProtectedButton
                      variant="secondary"
                      minRole="manager"
                      id="counterPostBtn"
                      className="px-4 py-2 font-medium"
                      confirmMessage="Are you sure you want to post this sheet? Posted sheets record stock adjustments and become read-only."
                      confirmLabel="Post sheet"
                      onClick={handlePostSheet}
                    >
                      Post sheet
                    </ProtectedButton>
                  ) : (
                    <span className="muted small text-xs text-gray-500">A manager posts the sheet.</span>
                  )}
                </div>
                <span id="counterDirty" className="muted small text-xs text-yellow-600 font-medium" aria-live="polite">
                  {dirty ? 'Unsaved changes — preview only until saved.' : ''}
                </span>
              </div>
            ) : (
              <div className="pad muted small p-4 text-xs text-gray-500 border-t flex justify-between items-center">
                <span>
                  Posted sheets are read-only.
                  {canRevertToDraft && (
                    <span className="ml-2 text-amber-600 dark:text-amber-400 font-medium">
                      (Posted today — you can revert to draft to make corrections)
                    </span>
                  )}
                </span>
                <div className="flex items-center gap-2">
                  {canRevertToDraft && (
                    <ProtectedButton
                      variant="secondary"
                      minRole="manager"
                      confirmMessage="Revert this posted sheet to draft? You will be able to make changes again."
                      confirmLabel="Revert to Draft"
                      className="px-3 py-2 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-300 rounded border border-amber-300 dark:border-amber-700 font-medium text-xs flex items-center gap-1.5 cursor-pointer"
                      onClick={handleRevertToDraft}
                    >
                      <RotateCcw size={14} />
                      Revert to Draft
                    </ProtectedButton>
                  )}
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      className="btn-sec px-3 py-2 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 rounded border border-emerald-200 dark:border-emerald-800 font-medium text-xs flex items-center gap-1.5"
                      onClick={() => handleDownloadSheet('xlsx')}
                      title="Download formatted Excel (.xlsx)"
                    >
                      <Download size={14} />
                      Download Excel
                    </button>
                    <button
                      type="button"
                      className="btn-sec px-2 py-2 bg-gray-50 text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 rounded border text-xs font-medium"
                      onClick={() => handleDownloadSheet('csv')}
                      title="Download raw CSV"
                    >
                      CSV
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {confirmModal && (
        <div id="modal" className="fixed inset-0 bg-black/50 flex justify-center overflow-y-auto [&>*]:my-auto p-4 z-50">
          <div className="bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-lg shadow-xl max-w-md w-full p-6">
            <div className="flex justify-between items-start mb-2">
              <h3 className="text-lg font-bold" id="confirmTitle">{confirmModal.title}</h3>
              <button
                type="button"
                onClick={() => setConfirmModal(null)}
                className="p-1 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                aria-label="Close dialog"
              >
                <X size={20} />
              </button>
            </div>
            <p className="text-gray-600 dark:text-gray-300 mb-6 text-sm" id="confirmText">{confirmModal.message}</p>
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
                className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded font-medium text-sm"
                onClick={confirmModal.onOk}
              >
                {confirmModal.confirmButtonText || 'Post sheet'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Beer Bottle Loader for Sheet Posting */}
      <BeerBottleLoader
        open={isPosting}
        title="Posting Counter Sheet…"
        subtitle="Correcting closing bottle stock & writing audit adjustments…"
        stage="inwarding"
      />
    </section>
  );
}
