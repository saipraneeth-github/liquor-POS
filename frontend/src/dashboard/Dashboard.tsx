import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { BeerBottleLoader } from '../components/BeerBottleLoader';

interface Bill {
  id: string;
  billNumber: string;
  total: string;
  paymentMode: string;
  status: string;
  createdAt: string;
}

interface TableItem {
  id: string;
  status: string;
}

export function Dashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const branchId = user?.branchId;
  const isCashier = user?.role === 'cashier' || user?.role === 'manager' || user?.role === 'owner';
  const isManager = user?.role === 'manager' || user?.role === 'owner';

  const [sales, setSales] = useState('₹0.00');
  const [billsCount, setBillsCount] = useState(0);
  const [paidCount, setPaidCount] = useState(0);
  const [recentBills, setRecentBills] = useState<Bill[]>([]);
  const [tablesOccupied, setTablesOccupied] = useState(0);
  const [tablesTotal, setTablesTotal] = useState(0);
  const [lowStockCount, setLowStockCount] = useState(0);
  const [loading, setLoading] = useState(false);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const todayStr = new Date().toLocaleDateString('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  useEffect(() => {
    if (!branchId || !isCashier) return;
    setLoading(true);
    const today = new Date().toISOString().slice(0, 10);

    Promise.allSettled([
      api.get<{ bills: Bill[]; total: number }>(`/bills?branchId=${branchId}&date=${today}&limit=50`),
      api.get<{ tables: TableItem[] }>('/tables/' + branchId),
      api.get<any[]>('/inventory/stock/' + branchId).catch(() => []),
    ]).then(([billsRes, tablesRes, stockRes]) => {
      if (billsRes.status === 'fulfilled') {
        const bList = billsRes.value.bills || [];
        setBillsCount(billsRes.value.total || bList.length);
        const paid = bList.filter((b) => b.status === 'PAID');
        setPaidCount(paid.length);
        const sum = paid.reduce((s, b) => s + parseFloat(b.total), 0);
        setSales('₹' + sum.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
        setRecentBills(bList.slice(0, 6));
      }

      if (tablesRes.status === 'fulfilled') {
        const tList = tablesRes.value.tables || [];
        setTablesTotal(tList.length);
        setTablesOccupied(tList.filter((t) => t.status === 'OCCUPIED').length);
      }

      if (stockRes.status === 'fulfilled') {
        const sList = stockRes.value || [];
        setLowStockCount(sList.filter((s: any) => s.quantity <= (s.reorderLevel || 0)).length);
      }

      setLoading(false);
    });
  }, [branchId, isCashier]);

  return (
    <section className="page active" id="page-dashboard" aria-labelledby="dashTitle">
      <div className="row between flex justify-between items-center mb-6">
        <div>
          <h2 className="h1 text-2xl font-bold text-gray-900 dark:text-gray-100" id="dashTitle">
            {greeting}, {user?.name} 👋
          </h2>
          <div className="muted small text-xs text-gray-500 dark:text-gray-400" id="dashSub">
            {todayStr}
          </div>
        </div>
        {isCashier && (
          <button
            className="btn-primary px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium text-sm transition-colors"
            type="button"
            id="dashNewBill"
            onClick={() => navigate('/pos')}
          >
            + New Bill
          </button>
        )}
      </div>

      <div id="dashBody" className="stack flex flex-col gap-6">
        {!isCashier ? (
          <div className="card pad stack p-6 bg-white dark:bg-gray-800 rounded shadow border border-gray-200 dark:border-gray-700 flex flex-col gap-4 max-w-xl">
            <div className="h2 text-lg font-bold text-gray-900 dark:text-gray-100">Steward access</div>
            <div className="muted text-sm text-gray-600 dark:text-gray-300">
              You are signed in as a steward. Use <b>Tables &amp; KOT</b> to see occupied tables, raise KOTs and update
              item status. Opening tables, billing, inventory and reports need a cashier or manager login.
            </div>
            <div>
              <button
                type="button"
                className="btn-primary px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium text-sm transition-colors"
                id="dashTablesBtn"
                onClick={() => navigate('/tables')}
              >
                🪑 Open Tables &amp; KOT
              </button>
            </div>
          </div>
        ) : loading ? (
          <div className="card pad p-8 bg-white dark:bg-gray-800 rounded shadow">
            <BeerBottleLoader inline size="sm" title="Pouring Today's Figures…" subtitle="Calculating paid bills, revenue & table status…" />
          </div>
        ) : (
          <>
            <div className="stats grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="stat-card p-4 bg-white dark:bg-gray-800 rounded shadow border border-gray-200 dark:border-gray-700">
                <div className="stat-label text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wider font-semibold">Today's sales (paid)</div>
                <div className="stat-value font-mono text-2xl font-bold mt-1 text-emerald-600 dark:text-emerald-400" id="dashSales">{sales}</div>
                <div className="muted small text-xs text-gray-500 dark:text-gray-400 mt-1">{paidCount} paid bills</div>
              </div>

              <div className="stat-card p-4 bg-white dark:bg-gray-800 rounded shadow border border-gray-200 dark:border-gray-700">
                <div className="stat-label text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wider font-semibold">Bills today</div>
                <div className="stat-value font-mono text-2xl font-bold mt-1 text-gray-900 dark:text-gray-100" id="dashBills">{billsCount}</div>
                <div className="muted small text-xs text-gray-500 dark:text-gray-400 mt-1">Total recorded</div>
              </div>

              <div className="stat-card p-4 bg-white dark:bg-gray-800 rounded shadow border border-gray-200 dark:border-gray-700">
                <div className="stat-label text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wider font-semibold">Tables occupied</div>
                <div
                  className={`stat-value font-mono text-2xl font-bold mt-1 text-gray-900 dark:text-gray-100 ${tablesOccupied > 0 ? 'text-amber-600 dark:text-amber-400' : ''}`}
                  id="dashTables"
                >
                  {tablesOccupied} / {tablesTotal}
                </div>
                <div className="muted small text-xs text-gray-500 dark:text-gray-400 mt-1">{Math.max(0, tablesTotal - tablesOccupied)} free</div>
              </div>

              <div className="stat-card p-4 bg-white dark:bg-gray-800 rounded shadow border border-gray-200 dark:border-gray-700">
                <div className="stat-label text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wider font-semibold">Low stock SKUs</div>
                <div
                  className={`stat-value font-mono text-2xl font-bold mt-1 ${lowStockCount > 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}
                  id="dashLow"
                >
                  {lowStockCount}
                </div>
                <div className="muted small text-xs text-gray-500 dark:text-gray-400 mt-1">At or below reorder level</div>
              </div>
            </div>

            <div className="two-col grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="card bg-white dark:bg-gray-800 rounded shadow p-4 border border-gray-200 dark:border-gray-700 flex flex-col gap-3">
                <div className="row between flex justify-between items-center border-b border-gray-200 dark:border-gray-700 pb-2">
                  <div className="h2 text-base font-bold text-gray-900 dark:text-gray-100">Recent bills</div>
                  <button
                    type="button"
                    className="btn-ghost text-xs text-blue-600 dark:text-blue-400 hover:underline font-medium"
                    onClick={() => navigate('/bills')}
                  >
                    View all →
                  </button>
                </div>

                {recentBills.length === 0 ? (
                  <div className="state p-6 text-center text-gray-500 dark:text-gray-400 text-sm">No bills yet today.</div>
                ) : (
                  <div className="table-wrap overflow-x-auto text-sm">
                    <table className="table table-compact w-full text-left">
                      <thead>
                        <tr className="border-b border-gray-200 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900/50">
                          <th className="py-2 px-2">Bill</th>
                          <th className="py-2 px-2">Time</th>
                          <th className="py-2 px-2">Mode</th>
                          <th className="py-2 px-2">Status</th>
                          <th className="py-2 px-2 text-right">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {recentBills.map((b) => (
                          <tr
                            key={b.id}
                            className="border-b border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer text-gray-900 dark:text-gray-100"
                            onClick={() => navigate('/bills')}
                          >
                            <td className="py-2 px-2 font-medium">{b.billNumber}</td>
                            <td className="py-2 px-2 text-xs text-gray-500 dark:text-gray-400">
                              {new Date(b.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                            </td>
                            <td className="py-2 px-2">
                              <span className="badge text-xs px-2 py-0.5 rounded font-medium bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200">
                                {b.paymentMode}
                              </span>
                            </td>
                            <td className="py-2 px-2">
                              <span
                                className={`badge text-xs px-2 py-0.5 rounded font-medium ${
                                  b.status === 'PAID'
                                    ? 'bg-green-100 text-green-800 dark:bg-green-950/60 dark:text-green-300'
                                    : 'bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300'
                                }`}
                              >
                                {b.status}
                              </span>
                            </td>
                            <td className="py-2 px-2 text-right font-mono font-bold text-gray-900 dark:text-gray-100">
                              ₹{parseFloat(b.total).toFixed(2)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className="stack flex flex-col gap-4">
                <div className="card pad stack p-4 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded shadow flex flex-col gap-3">
                  <div className="h2 text-base font-bold text-gray-900 dark:text-gray-100 border-b border-gray-200 dark:border-gray-700 pb-2">Quick actions</div>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      className="btn-sec p-2.5 bg-gray-50 dark:bg-gray-700/50 hover:bg-gray-100 dark:hover:bg-gray-700 rounded border border-gray-200 dark:border-gray-600 text-left text-sm font-medium text-gray-900 dark:text-gray-100 transition-colors"
                      onClick={() => navigate('/pos')}
                    >
                      🛒 POS Billing
                    </button>
                    <button
                      type="button"
                      className="btn-sec p-2.5 bg-gray-50 dark:bg-gray-700/50 hover:bg-gray-100 dark:hover:bg-gray-700 rounded border border-gray-200 dark:border-gray-600 text-left text-sm font-medium text-gray-900 dark:text-gray-100 transition-colors"
                      onClick={() => navigate('/shift')}
                    >
                      ⏱ Cashier Shift
                    </button>
                    <button
                      type="button"
                      className="btn-sec p-2.5 bg-gray-50 dark:bg-gray-700/50 hover:bg-gray-100 dark:hover:bg-gray-700 rounded border border-gray-200 dark:border-gray-600 text-left text-sm font-medium text-gray-900 dark:text-gray-100 transition-colors"
                      onClick={() => navigate('/tables')}
                    >
                      🪑 Tables &amp; KOT
                    </button>
                    <button
                      type="button"
                      className="btn-sec p-2.5 bg-gray-50 dark:bg-gray-700/50 hover:bg-gray-100 dark:hover:bg-gray-700 rounded border border-gray-200 dark:border-gray-600 text-left text-sm font-medium text-gray-900 dark:text-gray-100 transition-colors"
                      onClick={() => navigate('/inventory')}
                    >
                      📦 Inventory
                    </button>
                    {isManager && (
                      <>
                        <button
                          type="button"
                          className="btn-sec p-2.5 bg-gray-50 dark:bg-gray-700/50 hover:bg-gray-100 dark:hover:bg-gray-700 rounded border border-gray-200 dark:border-gray-600 text-left text-sm font-medium text-gray-900 dark:text-gray-100 transition-colors"
                          onClick={() => navigate('/closing')}
                        >
                          🔒 Day Closing
                        </button>
                        <button
                          type="button"
                          className="btn-sec p-2.5 bg-gray-50 dark:bg-gray-700/50 hover:bg-gray-100 dark:hover:bg-gray-700 rounded border border-gray-200 dark:border-gray-600 text-left text-sm font-medium text-gray-900 dark:text-gray-100 transition-colors"
                          onClick={() => navigate('/accounting')}
                        >
                          📚 Accounting
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
