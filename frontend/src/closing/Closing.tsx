import { useState, useEffect, useCallback } from 'react';
import { X, RefreshCw, CheckCircle, DollarSign, Smartphone, CreditCard, BookOpen } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { BeerBottleLoader } from '../components/BeerBottleLoader';
import { businessDate } from '../lib/business-day';

interface ClosingRow {
  id: string;
  closingDate: string;
  paidBillsCount: number;
  voidedBillsCount?: number;
  totalBillsCount?: number;
  grossSales: string;
  cashSales?: string;
  cardSales?: string;
  upiSales?: string;
  creditSales?: string;
  totalTax?: string;
  openingCash: string;
  cashWithdrawals: string;
  expectedCashInDrawer: string;
  actualCashCounted: string;
  cashDiscrepancy: string;
  isBalanced: boolean;
  notes?: string | null;
}

interface ClosingPreviewResponse {
  branchId: string;
  businessDate: string;
  isAlreadyClosed: boolean;
  existingClosing: ClosingRow | null;
  suggestedOpeningCash: string;
  sales: {
    cashSales: string;
    cardSales: string;
    upiSales: string;
    creditSales: string;
    grossSales: string;
    totalTax: string;
    paidBillsCount: number;
    voidedBillsCount: number;
    totalBillsCount: number;
  };
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

  const todayStr = businessDate();
  const [closingDate, setClosingDate] = useState(todayStr);

  // Auto-calculated live sales from system bills
  const [autoSales, setAutoSales] = useState<{
    cashSales: string;
    cardSales: string;
    upiSales: string;
    creditSales: string;
    grossSales: string;
    totalTax: string;
    paidBillsCount: number;
    voidedBillsCount: number;
    totalBillsCount: number;
  } | null>(null);

  const [loadingPreview, setLoadingPreview] = useState(false);
  const [isAlreadyClosed, setIsAlreadyClosed] = useState(false);
  const [existingClosing, setExistingClosing] = useState<ClosingRow | null>(null);

  // Form inputs (auto-filled and editable)
  const [openingCash, setOpeningCash] = useState('2000.00');
  const [actualCash, setActualCash] = useState('2000.00');
  const [withdrawals, setWithdrawals] = useState('0.00');
  const [cashSales, setCashSales] = useState('0.00');
  const [upiSales, setUpiSales] = useState('0.00');
  const [cardSales, setCardSales] = useState('0.00');
  const [creditSales, setCreditSales] = useState('0.00');
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

  const loadHistory = useCallback(async () => {
    if (!branchId) return;
    try {
      const rows = await api.get<ClosingRow[]>('/closing?branchId=' + branchId);
      setHistory(rows);
    } catch {
      // quiet fail
    }
  }, [branchId]);

  const loadPreview = useCallback(async (date?: string) => {
    if (!branchId) return;
    const d = date || closingDate || todayStr;
    setLoadingPreview(true);
    try {
      const res = await api.get<ClosingPreviewResponse>(`/closing/preview?branchId=${branchId}&date=${d}`);
      setIsAlreadyClosed(res.isAlreadyClosed);
      setExistingClosing(res.existingClosing);
      setAutoSales(res.sales);

      if (res.isAlreadyClosed && res.existingClosing) {
        // Locked closing: fill from audit record
        setOpeningCash(res.existingClosing.openingCash || '0.00');
        setActualCash(res.existingClosing.actualCashCounted || '0.00');
        setWithdrawals(res.existingClosing.cashWithdrawals || '0.00');
        setCashSales(res.existingClosing.cashSales || '0.00');
        setUpiSales(res.existingClosing.upiSales || '0.00');
        setCardSales(res.existingClosing.cardSales || '0.00');
        setCreditSales(res.existingClosing.creditSales || '0.00');
        setNotes(res.existingClosing.notes || '');
      } else {
        // Auto-update from live bills
        setCashSales(res.sales.cashSales);
        setUpiSales(res.sales.upiSales);
        setCardSales(res.sales.cardSales);
        setCreditSales(res.sales.creditSales);
        const op = res.suggestedOpeningCash || '2000.00';
        setOpeningCash(op);
        setWithdrawals('0.00');
        // Pre-fill actual cash counted with expected cash: opening + cashSales
        const expected = Math.max(0, (parseFloat(op) || 0) + (parseFloat(res.sales.cashSales) || 0));
        setActualCash(expected.toFixed(2));
      }
    } catch (err: any) {
      console.error('Failed to load closing preview:', err);
    } finally {
      setLoadingPreview(false);
    }
  }, [branchId, closingDate, todayStr]);

  useEffect(() => {
    loadPreview();
    loadHistory();
  }, [branchId, closingDate, loadPreview, loadHistory]);

  // Listen to live bill completions / stock changes to auto-update sales
  useEffect(() => {
    const handleUpdate = () => {
      loadPreview();
      loadHistory();
    };
    window.addEventListener('app:stock_updated', handleUpdate);
    return () => window.removeEventListener('app:stock_updated', handleUpdate);
  }, [loadPreview, loadHistory]);

  // Calculations
  const numOpening = parseFloat(openingCash) || 0;
  const numCashSales = parseFloat(cashSales) || 0;
  const numWithdrawals = parseFloat(withdrawals) || 0;
  const numActualCash = parseFloat(actualCash) || 0;
  const numUpiSales = parseFloat(upiSales) || 0;
  const numCardSales = parseFloat(cardSales) || 0;
  const numCreditSales = parseFloat(creditSales) || 0;

  // Expected Cash in Drawer = Opening + Cash Sales - Withdrawals
  const expectedCashInDrawer = numOpening + numCashSales - numWithdrawals;
  const cashDiscrepancy = numActualCash - expectedCashInDrawer;
  const isBalanced = Math.abs(cashDiscrepancy) < 0.005;

  // Final Total Sales for Day Closing = Cash + UPI + Card + Credit
  const finalDayGrossSales = numCashSales + numUpiSales + numCardSales + numCreditSales;
  const totalDigitalCollected = numUpiSales + numCardSales;
  // Money taken from customers today. The opening float is not a collection, so it is excluded
  // (the drawer count below still includes it, because that is what physically sits in the till).
  const totalMoneyCollectedToday = numCashSales + totalDigitalCollected;

  // Figures the manager changed away from what the system computed from bills. The server requires a
  // written reason for these and keeps the variance on the closing record.
  const sameMoney = (a: string, b: string) => Math.abs((parseFloat(a) || 0) - (parseFloat(b) || 0)) < 0.005;
  const overriddenChannels: string[] = autoSales && !isAlreadyClosed
    ? ([
        ['Cash', cashSales, autoSales.cashSales],
        ['UPI', upiSales, autoSales.upiSales],
        ['Card', cardSales, autoSales.cardSales],
        ['Credit', creditSales, autoSales.creditSales],
      ] as const).filter(([, mine, system]) => !sameMoney(mine, system)).map(([name]) => name)
    : [];
  const overrideNeedsNote = overriddenChannels.length > 0 && notes.trim().length < 10;

  const resetToAutoSales = () => {
    if (!autoSales) return;
    setCashSales(autoSales.cashSales);
    setUpiSales(autoSales.upiSales);
    setCardSales(autoSales.cardSales);
    setCreditSales(autoSales.creditSales);
    const expected = Math.max(0, numOpening + (parseFloat(autoSales.cashSales) || 0) - numWithdrawals);
    setActualCash(expected.toFixed(2));
    showToast('Reset all channels to system live sales', 'success');
  };

  const matchExpectedCash = () => {
    setActualCash(expectedCashInDrawer.toFixed(2));
  };

  const handleSubmitClick = () => {
    if (!branchId) {
      setStatusMsg({ type: 'error', text: 'Select a branch first.' });
      return;
    }
    if (isAlreadyClosed) {
      showToast(`Day ${closingDate} is already closed and locked.`, 'error');
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
    if (overrideNeedsNote) {
      showToast(`You changed ${overriddenChannels.join(', ')} from the system figure. Add a note (10+ characters) explaining why.`, 'error');
      document.getElementById('closingNotes')?.focus();
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
        cashSales: cashSales.trim(),
        cardSales: cardSales.trim(),
        upiSales: upiSales.trim(),
        creditSales: creditSales.trim(),
        businessDate: closingDate || todayStr,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      };

      const res = await api.post<ClosingResponse>('/closing', body);
      setStatusMsg({ type: 'success', data: res });
      showToast('Day closed — report saved', 'success');
      setConfirmOpen(false);
      loadPreview();
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
    <section className="page active space-y-6" id="page-closing" aria-labelledby="closingTitle">
      {/* Top Header & Date Selector */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-white dark:bg-gray-800 p-4 rounded-lg shadow-sm border dark:border-gray-700">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2 text-gray-900 dark:text-gray-100" id="closingTitle">
            Daily Closing &amp; Sales Reconciliation
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            Auto-calculated sales breakdown from bills today. Review, verify, or adjust Cash, UPI, and Card before locking.
          </p>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <label className="flex items-center gap-2 text-xs font-semibold text-gray-600 dark:text-gray-300" htmlFor="closingDate">
            <span>Date:</span>
            <input
              id="closingDate"
              className="p-1.5 border rounded text-xs font-medium dark:bg-gray-700 dark:border-gray-600 dark:text-white"
              type="date"
              max={todayStr}
              value={closingDate}
              onChange={(e) => setClosingDate(e.target.value)}
            />
          </label>

          <button
            type="button"
            id="btnRefreshSales"
            onClick={() => loadPreview()}
            disabled={loadingPreview}
            className="px-3 py-1.5 border rounded text-xs font-medium bg-gray-50 hover:bg-gray-100 dark:bg-gray-700 dark:hover:bg-gray-600 flex items-center gap-1.5 cursor-pointer transition-colors"
            title="Refresh latest sales from live bills"
          >
            <RefreshCw size={13} className={loadingPreview ? 'animate-spin text-purple-600' : 'text-gray-500'} />
            <span>{loadingPreview ? 'Fetching…' : 'Refresh Sales'}</span>
          </button>

          {autoSales && !isAlreadyClosed && (
            <button
              type="button"
              id="btnResetToAuto"
              onClick={resetToAutoSales}
              className="px-2.5 py-1.5 text-xs text-purple-600 dark:text-purple-400 hover:underline font-medium cursor-pointer"
              title="Reset all fields to system-calculated sales"
            >
              Reset to Auto
            </button>
          )}
        </div>
      </div>

      {/* Already Closed Banner */}
      {isAlreadyClosed && existingClosing && (
        <div className="p-4 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-300 dark:border-emerald-800 rounded-lg flex items-start gap-3">
          <CheckCircle className="text-emerald-600 shrink-0 mt-0.5" size={20} />
          <div className="text-xs space-y-1">
            <div className="font-bold text-sm text-emerald-900 dark:text-emerald-200">
              Business Day {closingDate} is Closed &amp; Locked
            </div>
            <div className="text-emerald-800 dark:text-emerald-300">
              Audit ID: <span className="font-mono">{existingClosing.id.slice(0, 8)}…</span> · Gross Sales:{' '}
              <span className="font-mono font-bold">₹{parseFloat(existingClosing.grossSales).toFixed(2)}</span> · Counted Cash:{' '}
              <span className="font-mono font-bold">₹{parseFloat(existingClosing.actualCashCounted).toFixed(2)}</span> · Discrepancy:{' '}
              <span className={`font-mono font-bold ${existingClosing.isBalanced ? 'text-emerald-700' : 'text-red-600'}`}>
                ₹{parseFloat(existingClosing.cashDiscrepancy).toFixed(2)}
              </span>
            </div>
            <div className="text-emerald-700 dark:text-emerald-400 text-[11px]">
              Cash ₹{parseFloat(existingClosing.cashSales || '0').toFixed(2)} · UPI ₹{parseFloat(existingClosing.upiSales || '0').toFixed(2)} · Card ₹{parseFloat(existingClosing.cardSales || '0').toFixed(2)} · Credit ₹{parseFloat(existingClosing.creditSales || '0').toFixed(2)}
            </div>
          </div>
        </div>
      )}

      {/* Main 2-Column Section */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column (7 cols): Channel Editors */}
        <div className="lg:col-span-7 space-y-4">
          {/* Channel 1: Cash Sales & Drawer Reconciliation */}
          <div className="bg-white dark:bg-gray-800 p-5 rounded-lg shadow-sm border dark:border-gray-700 space-y-3">
            <div className="flex justify-between items-center border-b pb-2 dark:border-gray-700">
              <span className="font-bold text-sm flex items-center gap-1.5 text-gray-800 dark:text-gray-200">
                <DollarSign size={16} className="text-emerald-600" />
                <span>Cash Sales &amp; Drawer Count</span>
              </span>
              {autoSales && (
                <span className="text-[11px] font-mono text-gray-500">
                  System billed: <b>₹{parseFloat(autoSales.cashSales).toFixed(2)}</b>
                </span>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <div className="flex justify-between items-center mb-1">
                  <label htmlFor="closingCashSales" className="text-xs font-semibold text-gray-600 dark:text-gray-300">
                    Cash Sales Today (₹)
                  </label>
                  {autoSales && cashSales !== autoSales.cashSales && (
                    <span className="text-[10px] text-amber-600 font-medium">Modified</span>
                  )}
                </div>
                <input
                  id="closingCashSales"
                  type="number"
                  step="any"
                  min="0"
                  disabled={isAlreadyClosed}
                  className="w-full p-2 border rounded font-mono text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white disabled:opacity-60"
                  value={cashSales}
                  onChange={(e) => setCashSales(e.target.value)}
                />
              </div>

              <div>
                <label htmlFor="closingOpeningCash" className="block text-xs font-semibold text-gray-600 dark:text-gray-300 mb-1">
                  Opening Cash in Drawer (₹)
                </label>
                <input
                  id="closingOpeningCash"
                  type="number"
                  step="any"
                  min="0"
                  disabled={isAlreadyClosed}
                  className="w-full p-2 border rounded font-mono text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white disabled:opacity-60"
                  placeholder="0.00"
                  required
                  value={openingCash}
                  onChange={(e) => setOpeningCash(e.target.value)}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              <div>
                <label htmlFor="closingWithdrawals" className="block text-xs font-semibold text-gray-600 dark:text-gray-300 mb-1">
                  Cash Withdrawals / Expenses (₹)
                </label>
                <input
                  id="closingWithdrawals"
                  type="number"
                  step="any"
                  min="0"
                  disabled={isAlreadyClosed}
                  className="w-full p-2 border rounded font-mono text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white disabled:opacity-60"
                  placeholder="0.00"
                  value={withdrawals}
                  onChange={(e) => setWithdrawals(e.target.value)}
                />
              </div>

              <div>
                <div className="flex justify-between items-center mb-1">
                  <label htmlFor="closingActualCash" className="text-xs font-semibold text-gray-600 dark:text-gray-300">
                    Actual Cash Counted (₹) *
                  </label>
                  {!isAlreadyClosed && (
                    <button
                      type="button"
                      id="btnMatchExpectedCash"
                      onClick={matchExpectedCash}
                      className="text-[10px] text-purple-600 hover:underline font-semibold cursor-pointer"
                    >
                      Match Expected
                    </button>
                  )}
                </div>
                <input
                  id="closingActualCash"
                  type="number"
                  step="any"
                  min="0"
                  disabled={isAlreadyClosed}
                  className="w-full p-2 border rounded font-mono text-sm font-bold dark:bg-gray-700 dark:border-gray-600 dark:text-white disabled:opacity-60"
                  placeholder="0.00"
                  required
                  value={actualCash}
                  onChange={(e) => setActualCash(e.target.value)}
                />
              </div>
            </div>

            {/* Expected vs Counted Formula Bar */}
            <div className="p-2.5 bg-gray-50 dark:bg-gray-750 rounded border dark:border-gray-700 text-xs flex justify-between items-center flex-wrap gap-2">
              <div className="text-gray-600 dark:text-gray-300">
                Opening (₹{numOpening.toFixed(2)}) + Cash Sales (₹{numCashSales.toFixed(2)}) - Withdrawals (₹{numWithdrawals.toFixed(2)}) =
                <span className="font-mono font-bold text-gray-800 dark:text-gray-100 ml-1">
                  Expected ₹{expectedCashInDrawer.toFixed(2)}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-gray-500 font-medium">Drawer Diff:</span>
                <span
                  className={`font-mono font-bold text-xs px-2 py-0.5 rounded ${
                    isBalanced
                      ? 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300'
                      : cashDiscrepancy < 0
                      ? 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300'
                      : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                  }`}
                >
                  {cashDiscrepancy >= 0 ? '+' : ''}₹{cashDiscrepancy.toFixed(2)} ({isBalanced ? 'Balanced' : cashDiscrepancy < 0 ? 'Shortage' : 'Excess'})
                </span>
              </div>
            </div>
          </div>

          {/* Channel 2 & 3: UPI & Card Sales */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* UPI Sales Card */}
            <div className="bg-white dark:bg-gray-800 p-4 rounded-lg shadow-sm border dark:border-gray-700 space-y-2">
              <div className="flex justify-between items-center border-b pb-1.5 dark:border-gray-700">
                <span className="font-bold text-xs flex items-center gap-1.5 text-gray-800 dark:text-gray-200">
                  <Smartphone size={14} className="text-blue-500" />
                  <span>UPI Sales (₹)</span>
                </span>
                {autoSales && (
                  <span className="text-[10px] font-mono text-gray-400">
                    Billed: ₹{parseFloat(autoSales.upiSales).toFixed(2)}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-gray-500">
                Auto-updated from UPI QR/Soundbox bills. Edit to match bank collection statement if needed.
              </p>
              <input
                id="closingUpiSales"
                type="number"
                step="any"
                min="0"
                disabled={isAlreadyClosed}
                className="w-full p-2 border rounded font-mono text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white disabled:opacity-60"
                value={upiSales}
                onChange={(e) => setUpiSales(e.target.value)}
              />
              {autoSales && upiSales !== autoSales.upiSales && (
                <div className="text-[10px] text-amber-600 flex justify-between">
                  <span>Modified from system: ₹{parseFloat(autoSales.upiSales).toFixed(2)}</span>
                  <button type="button" onClick={() => setUpiSales(autoSales.upiSales)} className="hover:underline">Reset</button>
                </div>
              )}
            </div>

            {/* Card Sales Card */}
            <div className="bg-white dark:bg-gray-800 p-4 rounded-lg shadow-sm border dark:border-gray-700 space-y-2">
              <div className="flex justify-between items-center border-b pb-1.5 dark:border-gray-700">
                <span className="font-bold text-xs flex items-center gap-1.5 text-gray-800 dark:text-gray-200">
                  <CreditCard size={14} className="text-purple-500" />
                  <span>Card Sales (₹)</span>
                </span>
                {autoSales && (
                  <span className="text-[10px] font-mono text-gray-400">
                    Billed: ₹{parseFloat(autoSales.cardSales).toFixed(2)}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-gray-500">
                Auto-updated from card bills. Edit to match EDC machine batch settlement summary.
              </p>
              <input
                id="closingCardSales"
                type="number"
                step="any"
                min="0"
                disabled={isAlreadyClosed}
                className="w-full p-2 border rounded font-mono text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white disabled:opacity-60"
                value={cardSales}
                onChange={(e) => setCardSales(e.target.value)}
              />
              {autoSales && cardSales !== autoSales.cardSales && (
                <div className="text-[10px] text-amber-600 flex justify-between">
                  <span>Modified from system: ₹{parseFloat(autoSales.cardSales).toFixed(2)}</span>
                  <button type="button" onClick={() => setCardSales(autoSales.cardSales)} className="hover:underline">Reset</button>
                </div>
              )}
            </div>
          </div>

          {/* Channel 4: Khata / Credit Sales & Notes */}
          <div className="bg-white dark:bg-gray-800 p-4 rounded-lg shadow-sm border dark:border-gray-700 space-y-3">
            <div className="flex justify-between items-center border-b pb-1.5 dark:border-gray-700">
              <span className="font-bold text-xs flex items-center gap-1.5 text-gray-800 dark:text-gray-200">
                <BookOpen size={14} className="text-amber-500" />
                <span>Khata / Customer Credit Sales (₹)</span>
              </span>
              {autoSales && (
                <span className="text-[10px] font-mono text-gray-400">
                  Billed: ₹{parseFloat(autoSales.creditSales).toFixed(2)}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <p className="text-[11px] text-gray-500 mb-1">
                  Customer credit (Udhar) sales rung up today. Recorded as revenue, but not in drawer cash.
                </p>
                <input
                  id="closingCreditSales"
                  type="number"
                  step="any"
                  min="0"
                  disabled={isAlreadyClosed}
                  className="w-full p-2 border rounded font-mono text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white disabled:opacity-60"
                  value={creditSales}
                  onChange={(e) => setCreditSales(e.target.value)}
                />
              </div>
            </div>

            <div>
              <label htmlFor="closingNotes" className="block text-xs font-semibold text-gray-600 dark:text-gray-300 mb-1">
                Closing Remarks / Notes {overriddenChannels.length > 0 ? '(required: figures changed)' : '(optional)'}
              </label>
              {overriddenChannels.length > 0 && (
                <div id="closingOverrideWarning" role="alert" className="mb-1.5 text-[11px] rounded border border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:border-amber-700 dark:text-amber-200 p-2">
                  {overriddenChannels.join(', ')} differ from the system's billed figure. This is recorded on the closing
                  and in the audit log. Explain why (e.g. bank / EDC settlement slip number).
                </div>
              )}
              <input
                id="closingNotes"
                disabled={isAlreadyClosed}
                className="w-full p-2 border rounded text-xs dark:bg-gray-700 dark:border-gray-600 dark:text-white disabled:opacity-60"
                maxLength={1000}
                placeholder="e.g. Card batch reconciled with bank slip #482; Cash exact."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>

            <button
              id="btnSubmitClosing"
              disabled={submitting || isAlreadyClosed}
              onClick={handleSubmitClick}
              className="w-full py-3 px-4 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-bold text-sm shadow cursor-pointer disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
            >
                            <span>{isAlreadyClosed ? 'Day Already Closed & Locked' : submitting ? 'Closing day…' : 'Close Day & Save Report'}</span>
            </button>

            <div id="closingStatusMsg" role="status">
              {statusMsg && statusMsg.type === 'error' && (
                <div className="p-3 bg-red-50 text-red-700 rounded text-xs">{statusMsg.text}</div>
              )}
              {statusMsg && statusMsg.type === 'success' && statusMsg.data && (
                <div className="p-3.5 bg-emerald-50 text-emerald-900 rounded-lg border border-emerald-200 text-xs space-y-1">
                  <div>
                    <b>Day Closed &amp; Locked</b> (Audit ID: {String(statusMsg.data.id).slice(0, 8)}…)
                  </div>
                  <div>
                    Business date {statusMsg.data.businessDate} · Gross ₹{parseFloat(statusMsg.data.grossSales).toFixed(2)} (
                    {statusMsg.data.paidBillsCount} paid, {statusMsg.data.voidedBillsCount} voided)
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
                      className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
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
        </div>

        {/* Right Column (5 cols): Final Total Amount For Day Closing & History */}
        <div className="lg:col-span-5 space-y-4">
          {/* FINAL TOTAL AMOUNT FOR DAY CLOSING CARD */}
          <div className="bg-gradient-to-br from-purple-900 to-indigo-900 text-white p-5 rounded-xl shadow-md space-y-4">
            <div className="flex justify-between items-start border-b border-purple-800/80 pb-3">
              <div>
                <span className="text-[11px] uppercase tracking-wider text-purple-300 font-semibold">
                  Final Summary
                </span>
                <h3 className="text-lg font-extrabold text-white">
                  Total Amount for Day Closing
                </h3>
              </div>
              <span
                className={`px-2.5 py-1 rounded text-xs font-bold uppercase tracking-wider ${
                  isBalanced ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                }`}
              >
                {isBalanced ? 'Balanced' : 'Diff: ₹' + Math.abs(cashDiscrepancy).toFixed(2)}
              </span>
            </div>

            {/* Huge Gross Sales Display */}
            <div className="space-y-1">
              <span className="text-xs text-purple-200">Total Day Gross Sales:</span>
              <div id="closingGrossTotal" className="text-3xl font-mono font-black text-white tracking-tight">
                ₹{finalDayGrossSales.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
              <div className="text-[11px] text-purple-300 flex items-center gap-1">
                <span>Cash + UPI + Card + Credit Revenue</span>
              </div>
            </div>

            {/* Detailed Sales Channels Grid */}
            <div className="grid grid-cols-2 gap-2 pt-2 border-t border-purple-800/60 text-xs">
              <div className="bg-white/10 p-2.5 rounded-lg">
                <span className="text-purple-300 text-[11px] block">Cash Sales</span>
                <span className="font-mono font-bold text-sm">₹{numCashSales.toFixed(2)}</span>
              </div>
              <div className="bg-white/10 p-2.5 rounded-lg">
                <span className="text-purple-300 text-[11px] block">UPI Sales</span>
                <span className="font-mono font-bold text-sm">₹{numUpiSales.toFixed(2)}</span>
              </div>
              <div className="bg-white/10 p-2.5 rounded-lg">
                <span className="text-purple-300 text-[11px] block">Card Sales</span>
                <span className="font-mono font-bold text-sm">₹{numCardSales.toFixed(2)}</span>
              </div>
              <div className="bg-white/10 p-2.5 rounded-lg">
                <span className="text-purple-300 text-[11px] block">Khata Sales</span>
                <span className="font-mono font-bold text-sm">₹{numCreditSales.toFixed(2)}</span>
              </div>
            </div>

            {/* Total Money Collected Today */}
            <div className="bg-white/10 p-3 rounded-lg border border-white/10 space-y-1.5 text-xs">
              <div className="flex justify-between items-center text-purple-200">
                <span title="Cash + UPI + Card sales. Excludes the opening float and credit (khata) sales.">Total Collected from Customers (Cash + UPI + Card):</span>
                <span id="closingTotalCollected" className="font-mono font-bold text-emerald-300 text-sm">
                  ₹{totalMoneyCollectedToday.toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between text-[11px] text-purple-300">
                <span>Cash in Drawer (Counted, incl. opening float):</span>
                <span className="font-mono font-semibold">₹{numActualCash.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-[11px] text-purple-300">
                <span>Digital Collections (UPI + Card):</span>
                <span className="font-mono font-semibold">₹{totalDigitalCollected.toFixed(2)}</span>
              </div>
            </div>

            {/* Bill Counts & Tax info */}
            <div className="flex justify-between items-center text-[11px] text-purple-300 pt-1 border-t border-purple-800/60">
              <span>
                Bills: <b>{autoSales?.paidBillsCount ?? 0} paid</b>
                {autoSales?.voidedBillsCount ? ` · ${autoSales.voidedBillsCount} voided` : ''}
              </span>
              <span>
                GST Tax: <b>₹{autoSales ? parseFloat(autoSales.totalTax).toFixed(2) : '0.00'}</b>
              </span>
            </div>
          </div>

          {/* Closing History Table */}
          <div className="bg-white dark:bg-gray-800 p-5 rounded-lg shadow-sm border dark:border-gray-700 space-y-3">
            <div className="flex justify-between items-center border-b pb-2 dark:border-gray-700">
              <h3 className="font-bold text-sm text-gray-800 dark:text-gray-200">Closing History</h3>
              <span className="text-xs text-gray-500">{history.length} records</span>
            </div>

            <div id="closingHistory" className="overflow-x-auto text-xs">
              {history.length === 0 ? (
                <div className="text-gray-400 p-4 text-center">No past closings recorded yet.</div>
              ) : (
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b text-[11px] text-gray-500 bg-gray-50 dark:bg-gray-700/50">
                      <th className="py-2 px-2">Date</th>
                      <th className="py-2 px-2 text-right">Gross</th>
                      <th className="py-2 px-2 text-right">Expected</th>
                      <th className="py-2 px-2 text-right">Counted</th>
                      <th className="py-2 px-2 text-right">Diff</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y dark:divide-gray-700">
                    {history.slice(0, 15).map((c) => (
                      <tr key={c.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/40">
                        <td className="py-2 px-2">
                          <span className="font-medium text-gray-800 dark:text-gray-200">{c.closingDate?.slice(0, 10)}</span>
                          <div className="text-[10px] text-gray-400">{c.paidBillsCount} bills</div>
                        </td>
                        <td className="py-2 px-2 text-right font-mono font-semibold">₹{parseFloat(c.grossSales).toFixed(2)}</td>
                        <td className="py-2 px-2 text-right font-mono text-gray-500">₹{parseFloat(c.expectedCashInDrawer).toFixed(2)}</td>
                        <td className="py-2 px-2 text-right font-mono font-medium">₹{parseFloat(c.actualCashCounted).toFixed(2)}</td>
                        <td
                          className={`py-2 px-2 text-right font-mono font-bold ${
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
      </div>

      {/* Confirmation Modal */}
      {confirmOpen && (
        <div id="modal" className="fixed inset-0 bg-black/50 flex justify-center overflow-y-auto [&>*]:my-auto p-4 z-50">
          <div className="bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-lg shadow-xl max-w-md w-full p-6 space-y-4">
            <div className="flex justify-between items-start">
              <h3 className="text-lg font-bold" id="modalTitle">Close day {closingDate}?</h3>
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="p-1 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                aria-label="Close dialog"
              >
                <X size={20} />
              </button>
            </div>

            <p className="text-gray-600 dark:text-gray-300 text-xs" id="confirmText">
              Opening ₹{parseFloat(openingCash).toFixed(2)} · Counted ₹{parseFloat(actualCash).toFixed(2)} · Withdrawals ₹
              {parseFloat(withdrawals || '0').toFixed(2)}. This locks the business day and cannot be undone.
            </p>

            <div className="p-3 bg-purple-50 dark:bg-purple-950/40 rounded-lg border border-purple-200 dark:border-purple-800 text-xs space-y-1.5">
              <div className="flex justify-between font-bold text-purple-900 dark:text-purple-200">
                <span>Total Day Gross Sales:</span>
                <span className="font-mono text-sm">₹{finalDayGrossSales.toFixed(2)}</span>
              </div>
              <div className="grid grid-cols-2 gap-1 text-[11px] text-gray-600 dark:text-gray-300 pt-1 border-t dark:border-purple-800">
                <span>Cash Sales: <b>₹{numCashSales.toFixed(2)}</b></span>
                <span>UPI Sales: <b>₹{numUpiSales.toFixed(2)}</b></span>
                <span>Card Sales: <b>₹{numCardSales.toFixed(2)}</b></span>
                <span>Khata Sales: <b>₹{numCreditSales.toFixed(2)}</b></span>
              </div>
              <div className="flex justify-between text-[11px] font-semibold text-gray-700 dark:text-gray-200 pt-1 border-t dark:border-purple-800">
                <span>Cash Discrepancy:</span>
                <span className={isBalanced ? 'text-green-600' : 'text-red-600'}>
                  {cashDiscrepancy >= 0 ? '+' : ''}₹{cashDiscrepancy.toFixed(2)} ({isBalanced ? 'Balanced' : 'Unbalanced'})
                </span>
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                id="confirmCancel"
                className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded border font-medium text-sm cursor-pointer"
                onClick={() => setConfirmOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                id="confirmOk"
                disabled={submitting}
                className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded font-medium text-sm cursor-pointer disabled:opacity-50"
                onClick={executeClosing}
              >
                {submitting ? 'Closing…' : 'Close day'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Beer Bottle Loader for Day Closing */}
      <BeerBottleLoader
        open={submitting}
        title="Closing Business Day…"
        subtitle="Balancing register tenders, locking shifts, and posting day closing vouchers…"
        stage="inwarding"
      />
    </section>
  );
}
