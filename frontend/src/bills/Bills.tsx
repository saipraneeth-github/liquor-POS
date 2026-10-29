import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';

type BillItem = {
  id: string;
  productId: string;
  productName?: string;
  quantity: number;
  unitPrice: string;
  taxAmount: string;
  lineTotal: string;
};

type Bill = {
  id: string;
  billNumber: string;
  createdAt: string;
  paymentMode: 'CASH' | 'CARD' | 'UPI' | 'CREDIT';
  status: 'PAID' | 'VOIDED';
  subtotal: string;
  taxAmount: string;
  discount: string;
  total: string;
  items: BillItem[];
  voidedAt?: string | null;
  voidReason?: string | null;
};

function todayIso(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

const roleRank = { steward: 1, cashier: 2, manager: 3, owner: 4 };

export function Bills() {
  const { user } = useAuth();
  const [date, setDate] = useState(todayIso());
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [bills, setBills] = useState<Bill[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);

  // Modal state
  const [modalType, setModalType] = useState<'view' | 'void' | null>(null);
  const [selectedBill, setSelectedBill] = useState<Bill | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [voidSubmitting, setVoidSubmitting] = useState(false);

  const canVoid = (roleRank[user?.role ?? 'cashier'] ?? 0) >= roleRank.manager;
  const sub = (user as any)?.sub ?? user?.id ?? '';
  const branchId = (user as any)?.branchId ?? '';

  const checkPendingQueue = useCallback(() => {
    if (!sub) return;
    try {
      const q = JSON.parse(localStorage.getItem(`lc_offline_bills:${sub}`) || '[]');
      setPendingCount(q.length);
    } catch {
      setPendingCount(0);
    }
  }, [sub]);

  const loadBills = useCallback(async () => {
    if (!branchId) return;
    checkPendingQueue();
    setLoading(true);
    try {
      const qs = new URLSearchParams({
        branchId,
        limit: '100',
        offset: '0',
      });
      if (date) qs.set('date', date);
      if (status) qs.set('status', status);
      const res = await api.get<{ bills: Bill[]; total: number }>(`/bills?${qs.toString()}`);
      setBills(res.bills || []);
      setTotalCount(res.total || 0);
    } catch {
      setBills([]);
    } finally {
      setLoading(false);
    }
  }, [branchId, date, status, checkPendingQueue]);

  useEffect(() => {
    loadBills();
  }, [loadBills]);

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearch(e.target.value);
  };

  const filteredBills = bills.filter((b) => {
    const q = search.trim().toLowerCase();
    return !q || b.billNumber.toLowerCase().includes(q);
  });

  const handleOpenVoid = (b: Bill) => {
    setSelectedBill(b);
    setVoidReason('');
    setModalType('void');
  };

  const handleViewBill = async (b: Bill) => {
    setSelectedBill(b);
    setModalType('view');
    try {
      const full = await api.get<Bill>(`/bills/${b.id}`);
      setSelectedBill(full);
    } catch {
      // keep current
    }
  };

  const handleConfirmVoid = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedBill) return;
    if (voidReason.trim().length < 5) return;

    setVoidSubmitting(true);
    try {
      await api.post(`/bills/${selectedBill.id}/void`, { voidReason: voidReason.trim() });
      setModalType(null);
      setSelectedBill(null);
      await loadBills();
    } catch {
      // handle error
    } finally {
      setVoidSubmitting(false);
    }
  };

  return (
    <div id="page-bills" className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold" id="billsTitle">🧾 Bill History</h2>
      </div>

      {/* Filter card */}
      <div className="bg-white dark:bg-gray-800 p-4 rounded-lg shadow-sm border dark:border-gray-700">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
          <div>
            <label className="block text-xs font-semibold mb-1 text-gray-500" htmlFor="billsDate">
              Business date
            </label>
            <input
              id="billsDate"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full p-2 border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1 text-gray-500" htmlFor="billsStatus">
              Status
            </label>
            <select
              id="billsStatus"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="w-full p-2 border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
            >
              <option value="">All</option>
              <option value="PAID">PAID</option>
              <option value="VOIDED">VOIDED</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1 text-gray-500" htmlFor="billsSearch">
              Bill number contains
            </label>
            <input
              id="billsSearch"
              placeholder="e.g. 000123"
              value={search}
              onChange={handleSearchChange}
              className="w-full p-2 border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
            />
          </div>
          <button
            type="button"
            id="billsLoadBtn"
            onClick={loadBills}
            className="bg-purple-600 text-white p-2 rounded font-medium hover:bg-purple-700"
          >
            Load
          </button>
        </div>
      </div>

      {/* Pending bills notification */}
      {pendingCount > 0 && (
        <div
          id="billsPending"
          className="bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 p-3 rounded-lg text-amber-800 dark:text-amber-200 text-sm flex justify-between items-center"
        >
          <span>⏳ Pending sync: {pendingCount} offline bill{pendingCount > 1 ? 's' : ''} queued locally.</span>
        </div>
      )}

      {/* Bills list */}
      <div id="billsList" className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border dark:border-gray-700 overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading bills...</div>
        ) : filteredBills.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            {bills.length ? 'No bills match the search.' : 'No bills for this date.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 dark:bg-gray-700/50 border-b dark:border-gray-700 text-gray-600 dark:text-gray-300">
                <tr>
                  <th className="p-3">Bill No.</th>
                  <th className="p-3">Time</th>
                  <th className="p-3">Payment</th>
                  <th className="p-3">Status</th>
                  <th className="p-3 text-right">GST</th>
                  <th className="p-3 text-right">Total</th>
                  <th className="p-3 text-center">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y dark:divide-gray-700">
                {filteredBills.map((b) => (
                  <tr key={b.id} className="bill-row hover:bg-gray-50 dark:hover:bg-gray-700/30" data-bill-number={b.billNumber}>
                    <td className="p-3 font-semibold">{b.billNumber}</td>
                    <td className="p-3 text-gray-500">
                      {new Date(b.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </td>
                    <td className="p-3">
                      <span className="px-2 py-0.5 text-xs rounded bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-300 font-medium">
                        {b.paymentMode}
                      </span>
                    </td>
                    <td className="p-3">
                      <span
                        className={`px-2 py-0.5 text-xs rounded font-medium ${
                          b.status === 'PAID'
                            ? 'bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-300'
                            : 'bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-300'
                        }`}
                      >
                        {b.status}
                      </span>
                    </td>
                    <td className="p-3 text-right font-mono text-gray-500">
                      ₹{parseFloat(b.taxAmount || '0').toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="p-3 text-right font-mono font-bold">
                      ₹{parseFloat(b.total || '0').toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="p-3 text-center space-x-2">
                      <button
                        type="button"
                        onClick={() => handleViewBill(b)}
                        className="px-2 py-1 text-xs border rounded hover:bg-gray-100 dark:hover:bg-gray-700"
                      >
                        View
                      </button>
                      {canVoid && b.status === 'PAID' && (
                        <button
                          type="button"
                          onClick={() => handleOpenVoid(b)}
                          className="px-2 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700"
                        >
                          Void
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="p-3 text-xs text-gray-500 border-t dark:border-gray-700">
              Showing {filteredBills.length} of {totalCount} bills
            </div>
          </div>
        )}
      </div>

      {/* Modal Dialog */}
      {modalType && (
        <div id="modal" className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-lg w-full overflow-hidden border dark:border-gray-700">
            <div className="flex justify-between items-center p-4 border-b dark:border-gray-700">
              <h2 className="text-lg font-bold" id="modalTitle">
                {modalType === 'void' ? `Void bill ${selectedBill?.billNumber}` : `Bill ${selectedBill?.billNumber}`}
              </h2>
              <button
                type="button"
                onClick={() => setModalType(null)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl font-bold"
                aria-label="Close dialog"
              >
                ✕
              </button>
            </div>

            <div id="modalBody" className="p-4 space-y-4 max-h-[75vh] overflow-y-auto">
              {modalType === 'void' && selectedBill && (
                <form onSubmit={handleConfirmVoid} className="space-y-4">
                  <div className="text-sm text-gray-600 dark:text-gray-300">
                    Total ₹{parseFloat(selectedBill.total).toLocaleString('en-IN', { minimumFractionDigits: 2 })} · {selectedBill.paymentMode}. Stock is returned and the sale is reversed in the accounts. This cannot be undone.
                  </div>
                  <div>
                    <label htmlFor="voidReason" className="block text-xs font-semibold text-gray-500 mb-1">
                      Reason (min 5 characters)
                    </label>
                    <textarea
                      id="voidReason"
                      rows={3}
                      minLength={5}
                      maxLength={500}
                      required
                      value={voidReason}
                      onChange={(e) => setVoidReason(e.target.value)}
                      className="w-full p-2 border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                      placeholder="Why is this bill being voided?"
                    />
                  </div>
                  <div className="flex justify-end gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => setModalType(null)}
                      className="px-4 py-2 border rounded text-sm hover:bg-gray-100 dark:hover:bg-gray-700"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      id="voidConfirmBtn"
                      disabled={voidReason.trim().length < 5 || voidSubmitting}
                      className="px-4 py-2 bg-red-600 text-white rounded text-sm font-semibold hover:bg-red-700 disabled:opacity-50"
                    >
                      {voidSubmitting ? 'Voiding...' : 'Void bill'}
                    </button>
                  </div>
                </form>
              )}

              {modalType === 'view' && selectedBill && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 text-xs rounded font-bold bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300">
                      {selectedBill.status}
                    </span>
                    <span className="px-2 py-0.5 text-xs rounded font-bold bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300">
                      {selectedBill.paymentMode}
                    </span>
                    <span className="text-xs text-gray-500">
                      {new Date(selectedBill.createdAt).toLocaleString()}
                    </span>
                  </div>

                  <div className="border rounded dark:border-gray-700 overflow-hidden">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-gray-50 dark:bg-gray-700/50">
                        <tr>
                          <th className="p-2">Item</th>
                          <th className="p-2 text-right">Qty</th>
                          <th className="p-2 text-right">Rate</th>
                          <th className="p-2 text-right">Amount</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y dark:divide-gray-700">
                        {(selectedBill.items || []).map((item, idx) => (
                          <tr key={idx}>
                            <td className="p-2">{item.productName || item.productId}</td>
                            <td className="p-2 text-right">{item.quantity}</td>
                            <td className="p-2 text-right font-mono">₹{parseFloat(item.unitPrice).toFixed(2)}</td>
                            <td className="p-2 text-right font-mono">₹{parseFloat(item.lineTotal).toFixed(2)}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot className="border-t font-semibold dark:border-gray-700">
                        <tr>
                          <td colSpan={3} className="p-2">Gross (MRP)</td>
                          <td className="p-2 text-right font-mono">₹{parseFloat(selectedBill.subtotal || '0').toFixed(2)}</td>
                        </tr>
                        <tr>
                          <td colSpan={3} className="p-2">GST Included</td>
                          <td className="p-2 text-right font-mono">₹{parseFloat(selectedBill.taxAmount || '0').toFixed(2)}</td>
                        </tr>
                        <tr>
                          <td colSpan={3} className="p-2">Total</td>
                          <td className="p-2 text-right font-mono">₹{parseFloat(selectedBill.total || '0').toFixed(2)}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>

                  {selectedBill.status === 'VOIDED' && (
                    <div className="p-3 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 rounded text-xs text-red-700 dark:text-red-300">
                      Voided {selectedBill.voidedAt ? new Date(selectedBill.voidedAt).toLocaleString() : ''} - {selectedBill.voidReason}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

