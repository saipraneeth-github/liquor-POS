import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';

type Table = {
  id: string;
  name: string;
  capacity?: number;
  section?: string | null;
  status: 'FREE' | 'OCCUPIED' | 'RESERVED';
  currentSessionId?: string | null;
  sessionOpenedAt?: string | null;
};

type Product = {
  id: string;
  name: string;
  mrp: string;
};

type KotItem = {
  id: string;
  productId: string;
  quantity: number;
  status: 'PENDING' | 'PREPARING' | 'SERVED' | 'CANCELLED';
};

type KotOrder = {
  id: string;
  status: string;
  destination: string;
  items: KotItem[];
};

const KOT_NEXT: Record<string, string[]> = {
  PENDING: ['PREPARING', 'CANCELLED'],
  PREPARING: ['SERVED', 'CANCELLED'],
  SERVED: [],
  CANCELLED: [],
};

const roleRank = { steward: 1, cashier: 2, manager: 3, owner: 4 };

function showToast(message: string, type: 'success' | 'error' | 'info' = 'info') {
  const host = document.getElementById('toastHost');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `p-3 rounded shadow text-sm font-medium ${
    type === 'success' ? 'bg-green-600 text-white' :
    type === 'error' ? 'bg-red-600 text-white' : 'bg-gray-800 text-white'
  }`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

export function Tables() {
  const { user } = useAuth();
  const [tables, setTables] = useState<Table[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(false);

  // Modals
  const [activeModal, setActiveModal] = useState<'actions' | 'newKot' | 'viewKots' | 'closeConfirm' | null>(null);
  const [selectedTable, setSelectedTable] = useState<Table | null>(null);

  // New KOT Form State
  const [kotDest, setKotDest] = useState<'BAR' | 'KITCHEN'>('BAR');
  const [kotItems, setKotItems] = useState<{ productId: string; quantity: number }[]>([
    { productId: '', quantity: 1 }
  ]);
  const [kotNotes, setKotNotes] = useState('');
  const [kotSubmitting, setKotSubmitting] = useState(false);

  // View KOTs State
  const [tableKots, setTableKots] = useState<KotOrder[]>([]);

  // Add Table Form (Manager)
  const [newTableName, setNewTableName] = useState('');
  const [newTableSeats, setNewTableSeats] = useState(4);
  const [newTableSection, setNewTableSection] = useState('Indoor');

  const branchId = (user as any)?.branchId ?? '';
  const canCashier = (roleRank[user?.role ?? 'steward'] ?? 0) >= roleRank.cashier;
  const canManager = (roleRank[user?.role ?? 'steward'] ?? 0) >= roleRank.manager;

  const loadTables = useCallback(async () => {
    if (!branchId) return;
    setLoading(true);
    try {
      const res = await api.get<{ tables: Table[] }>(`/tables/${branchId}`);
      setTables(res.tables || []);
    } catch {
      setTables([]);
    } finally {
      setLoading(false);
    }
  }, [branchId]);

  useEffect(() => {
    loadTables();
    api.get<Product[]>('/products')
      .then((prods) => {
        setProducts(prods || []);
        if (prods && prods.length > 0) {
          setKotItems([{ productId: prods[0].id, quantity: 1 }]);
        }
      })
      .catch(() => {});
  }, [loadTables]);

  const handleTileClick = async (table: Table) => {
    if (table.status === 'OCCUPIED') {
      setSelectedTable(table);
      setActiveModal('actions');
      return;
    }

    if (!canCashier) {
      showToast('A cashier or manager opens tables. You can raise KOTs once it is occupied.', 'info');
      return;
    }

    // Cashier opens free table
    try {
      await api.post(`/tables/${table.id}/open`, { branchId });
      showToast(`${table.name} opened`, 'success');
      await loadTables();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to open table';
      showToast(`Could not open ${table.name}: ${msg}`, 'error');
    }
  };

  const handleOpenKotModal = () => {
    setKotItems([{ productId: products[0]?.id || '', quantity: 1 }]);
    setKotNotes('');
    setKotDest('BAR');
    setActiveModal('newKot');
  };

  const handleCreateKot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTable || !selectedTable.currentSessionId) return;

    const validItems = kotItems.filter((i) => i.productId && i.quantity > 0);
    if (!validItems.length) {
      showToast('Each KOT line needs a valid product and quantity of at least 1.', 'error');
      return;
    }

    setKotSubmitting(true);
    try {
      await api.post('/kot', {
        tableSessionId: selectedTable.currentSessionId,
        branchId,
        destination: kotDest,
        items: validItems,
        ...(kotNotes ? { notes: kotNotes } : {}),
      });
      showToast(`KOT sent to ${kotDest.toLowerCase()} for ${selectedTable.name}`, 'success');
      setActiveModal(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'KOT failed';
      showToast('Failed to create KOT: ' + msg, 'error');
    } finally {
      setKotSubmitting(false);
    }
  };

  const handleViewKots = async () => {
    if (!selectedTable || !selectedTable.currentSessionId) return;
    try {
      const res = await api.get<{ kotOrders: KotOrder[] }>(
        `/kot/session/${selectedTable.currentSessionId}?branchId=${branchId}`
      );
      setTableKots(res.kotOrders || []);
      setActiveModal('viewKots');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Could not fetch KOTs';
      showToast(msg, 'error');
    }
  };

  const handleUpdateKotStatus = async (orderId: string, itemId: string, newStatus: string) => {
    try {
      await api.patch(`/kot/${orderId}/items/${itemId}`, { status: newStatus, branchId });
      showToast(`Item marked ${newStatus}`, 'success');
      // Refresh KOTs
      if (selectedTable?.currentSessionId) {
        const res = await api.get<{ kotOrders: KotOrder[] }>(
          `/kot/session/${selectedTable.currentSessionId}?branchId=${branchId}`
        );
        setTableKots(res.kotOrders || []);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Update failed';
      showToast(`Update failed: ${msg}`, 'error');
    }
  };

  const handleCloseWithoutBilling = async () => {
    if (!selectedTable) return;
    try {
      await api.post(`/tables/${selectedTable.id}/close`, { branchId });
      showToast(`${selectedTable.name} closed`, 'success');
      setActiveModal(null);
      setSelectedTable(null);
      await loadTables();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to close table';
      showToast(`Close failed: ${msg}`, 'error');
    }
  };

  const handleCreateTable = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTableName.trim()) return;
    try {
      await api.post(`/tables/${branchId}`, {
        name: newTableName.trim(),
        capacity: newTableSeats,
        section: newTableSection.trim(),
      });
      showToast(`Table ${newTableName} created`, 'success');
      setNewTableName('');
      await loadTables();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Create failed';
      showToast('Failed to create table: ' + msg, 'error');
    }
  };

  const productName = (id: string) => {
    const p = products.find((x) => x.id === id);
    return p ? p.name : id;
  };

  return (
    <div id="page-tables" className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold" id="tablesTitle">🪑 Tables &amp; KOT</h2>
          <div className="text-xs text-gray-500" id="tablesHelp">
            {canCashier
              ? 'Click a free table to open it, or an occupied one for KOT / bill actions.'
              : 'Click an occupied table to raise a KOT or update item status. A cashier opens and bills tables.'}
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-full bg-green-500 inline-block"></span> Free
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-full bg-red-500 inline-block"></span> Occupied
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-full bg-amber-500 inline-block"></span> Reserved
          </span>
          <button
            type="button"
            onClick={loadTables}
            className="px-3 py-1 border rounded hover:bg-gray-100 dark:hover:bg-gray-700 font-medium"
          >
            ↻ Refresh
          </button>
        </div>
      </div>

      {/* Grid of Tables */}
      <div id="tableGrid" className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
        {loading ? (
          <div className="col-span-full p-8 text-center text-gray-500">Loading tables...</div>
        ) : tables.length === 0 ? (
          <div className="col-span-full p-8 text-center text-gray-500">No tables found.</div>
        ) : (
          tables.map((t) => {
            const isOccupied = t.status === 'OCCUPIED';
            const isFree = t.status === 'FREE';
            return (
              <div
                key={t.id}
                role="button"
                tabIndex={0}
                data-table={t.name}
                onClick={() => handleTileClick(t)}
                className={`table-tile table-${t.status} p-4 rounded-lg border shadow-sm cursor-pointer transition hover:shadow-md flex flex-col justify-between h-32 ${
                  isOccupied
                    ? 'border-red-300 bg-red-50 dark:bg-red-950/20 dark:border-red-900/50'
                    : isFree
                    ? 'border-green-300 bg-green-50 dark:bg-green-950/20 dark:border-green-900/50'
                    : 'border-amber-300 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900/50'
                }`}
              >
                <div className="flex justify-between items-start">
                  <span
                    className={`px-2 py-0.5 text-xs font-bold rounded ${
                      isOccupied
                        ? 'bg-red-600 text-white'
                        : isFree
                        ? 'bg-green-600 text-white'
                        : 'bg-amber-600 text-white'
                    }`}
                  >
                    {t.status}
                  </span>
                  <span className="text-xs text-gray-500">{t.capacity || 4} seats</span>
                </div>
                <div>
                  <div className="font-bold text-base truncate">{t.name}</div>
                  <div className="text-xs text-gray-500">{t.section || 'General'}</div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Manager-only: Add Table Section */}
      <details className={canManager ? 'mgr-only bg-white dark:bg-gray-800 p-4 rounded-lg border dark:border-gray-700' : 'mgr-only hidden'}>
        <summary className="font-semibold cursor-pointer text-sm text-purple-600 dark:text-purple-400">
          + Add table
        </summary>
        <form onSubmit={handleCreateTable} className="mt-4 grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
          <div>
            <label htmlFor="tblName" className="block text-xs font-semibold mb-1 text-gray-500">Name</label>
            <input
              id="tblName"
              required
              maxLength={50}
              value={newTableName}
              onChange={(e) => setNewTableName(e.target.value)}
              placeholder="e.g. T-12"
              className="w-full p-2 border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
            />
          </div>
          <div>
            <label htmlFor="tblCap" className="block text-xs font-semibold mb-1 text-gray-500">Seats</label>
            <input
              id="tblCap"
              type="number"
              min={1}
              max={100}
              value={newTableSeats}
              onChange={(e) => setNewTableSeats(parseInt(e.target.value) || 4)}
              className="w-full p-2 border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
            />
          </div>
          <div>
            <label htmlFor="tblSection" className="block text-xs font-semibold mb-1 text-gray-500">Section</label>
            <input
              id="tblSection"
              maxLength={50}
              value={newTableSection}
              onChange={(e) => setNewTableSection(e.target.value)}
              placeholder="Indoor"
              className="w-full p-2 border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
            />
          </div>
          <button
            type="submit"
            className="p-2 bg-purple-600 text-white rounded font-medium hover:bg-purple-700"
          >
            Create table
          </button>
        </form>
      </details>

      {/* Global Modals for Table & KOT Actions */}
      {activeModal && (
        <div id="modal" className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-lg w-full overflow-hidden border dark:border-gray-700">
            <div className="flex justify-between items-center p-4 border-b dark:border-gray-700">
              <h2 className="text-lg font-bold" id="modalTitle">
                {activeModal === 'actions' && `${selectedTable?.name} - occupied`}
                {activeModal === 'newKot' && `New KOT - ${selectedTable?.name}`}
                {activeModal === 'viewKots' && `KOTs - ${selectedTable?.name}`}
                {activeModal === 'closeConfirm' && `Close ${selectedTable?.name} without billing?`}
              </h2>
              <button
                type="button"
                onClick={() => setActiveModal(null)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl font-bold"
                aria-label="Close dialog"
              >
                ✕
              </button>
            </div>

            <div id="modalBody" className="p-4 space-y-4 max-h-[75vh] overflow-y-auto">
              {/* Occupied Table Actions */}
              {activeModal === 'actions' && (
                <div className="space-y-4">
                  <div className="text-sm text-gray-600 dark:text-gray-300">
                    Session active. Select an action below:
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      id="tblActKot"
                      onClick={handleOpenKotModal}
                      className="px-4 py-2 bg-purple-600 text-white rounded font-medium hover:bg-purple-700 text-sm"
                    >
                      + KOT
                    </button>
                    <button
                      type="button"
                      id="tblActKots"
                      onClick={handleViewKots}
                      className="px-4 py-2 border rounded font-medium hover:bg-gray-100 dark:hover:bg-gray-700 text-sm"
                    >
                      KOTs
                    </button>
                    {canCashier && (
                      <>
                        <button
                          type="button"
                          id="tblActBill"
                          onClick={() => {
                            showToast('Direct to POS', 'info');
                            setActiveModal(null);
                          }}
                          className="px-4 py-2 border rounded font-medium hover:bg-gray-100 dark:hover:bg-gray-700 text-sm"
                        >
                          Bill at POS
                        </button>
                        <button
                          type="button"
                          id="tblActClose"
                          onClick={() => setActiveModal('closeConfirm')}
                          className="px-4 py-2 bg-red-600 text-white rounded font-medium hover:bg-red-700 text-sm"
                        >
                          Close without billing
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}

              {/* Close Table Confirmation */}
              {activeModal === 'closeConfirm' && (
                <div className="space-y-4">
                  <p className="text-sm text-gray-600 dark:text-gray-300">
                    There are no KOT items or live items will be dropped. The session will be closed without a bill.
                  </p>
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      id="confirmCancel"
                      onClick={() => setActiveModal(null)}
                      className="px-4 py-2 border rounded text-sm hover:bg-gray-100 dark:hover:bg-gray-700"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      id="confirmOk"
                      onClick={handleCloseWithoutBilling}
                      className="px-4 py-2 bg-red-600 text-white rounded text-sm font-semibold hover:bg-red-700"
                    >
                      Close table
                    </button>
                  </div>
                </div>
              )}

              {/* New KOT Form */}
              {activeModal === 'newKot' && (
                <form onSubmit={handleCreateKot} className="space-y-4">
                  <div>
                    <label htmlFor="kotDest" className="block text-xs font-semibold mb-1 text-gray-500">
                      Destination
                    </label>
                    <select
                      id="kotDest"
                      value={kotDest}
                      onChange={(e) => setKotDest(e.target.value as 'BAR' | 'KITCHEN')}
                      className="w-full p-2 border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                    >
                      <option value="BAR">🍸 Bar</option>
                      <option value="KITCHEN">🍳 Kitchen</option>
                    </select>
                  </div>

                  <div id="kotLines" className="space-y-3">
                    {kotItems.map((item, idx) => (
                      <div key={idx} className="kot-line flex gap-2 items-center">
                        <select
                          className="kot-product flex-1 p-2 border rounded text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                          aria-label="Product"
                          value={item.productId}
                          onChange={(e) => {
                            const val = e.target.value;
                            setKotItems((prev) =>
                              prev.map((it, i) => (i === idx ? { ...it, productId: val } : it))
                            );
                          }}
                        >
                          {products.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                        <input
                          type="number"
                          min={1}
                          max={50}
                          className="kot-qty w-20 p-2 border rounded text-sm text-right dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                          value={item.quantity}
                          onChange={(e) => {
                            const q = parseInt(e.target.value) || 1;
                            setKotItems((prev) =>
                              prev.map((it, i) => (i === idx ? { ...it, quantity: q } : it))
                            );
                          }}
                        />
                      </div>
                    ))}
                  </div>

                  <button
                    type="button"
                    onClick={() =>
                      setKotItems((prev) => [...prev, { productId: products[0]?.id || '', quantity: 1 }])
                    }
                    className="text-xs text-purple-600 dark:text-purple-400 font-semibold"
                  >
                    + Add item
                  </button>

                  <div>
                    <label htmlFor="kotNotes" className="block text-xs font-semibold mb-1 text-gray-500">
                      Notes
                    </label>
                    <input
                      id="kotNotes"
                      maxLength={500}
                      value={kotNotes}
                      onChange={(e) => setKotNotes(e.target.value)}
                      placeholder="e.g. Less spicy, extra ice"
                      className="w-full p-2 border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white text-sm"
                    />
                  </div>

                  <div className="flex justify-end gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => setActiveModal(null)}
                      className="px-4 py-2 border rounded text-sm hover:bg-gray-100 dark:hover:bg-gray-700"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      id="kotCreateBtn"
                      disabled={kotSubmitting}
                      className="px-4 py-2 bg-purple-600 text-white rounded text-sm font-semibold hover:bg-purple-700 disabled:opacity-50"
                    >
                      {kotSubmitting ? 'Sending...' : 'Create KOT'}
                    </button>
                  </div>
                </form>
              )}

              {/* View KOTs List */}
              {activeModal === 'viewKots' && (
                <div className="space-y-4">
                  {tableKots.length === 0 ? (
                    <div className="p-4 text-center text-gray-500">No KOTs for this table yet.</div>
                  ) : (
                    tableKots.map((o, idx) => (
                      <div key={o.id} className="p-3 border rounded-lg dark:border-gray-700 space-y-2">
                        <div className="flex justify-between items-center font-bold text-sm">
                          <span>KOT #{idx + 1} ({o.destination})</span>
                          <span className="text-xs px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-700">
                            {o.status}
                          </span>
                        </div>
                        <div className="divide-y dark:divide-gray-700">
                          {o.items.map((i) => {
                            const nextOptions = KOT_NEXT[i.status] || [];
                            const allowed = [i.status, ...nextOptions];
                            return (
                              <div key={i.id} className="py-2 flex justify-between items-center text-sm">
                                <span>{productName(i.productId)} x {i.quantity}</span>
                                <select
                                  id={`ks-${i.id}`}
                                  value={i.status}
                                  disabled={nextOptions.length === 0}
                                  onChange={(e) => handleUpdateKotStatus(o.id, i.id, e.target.value)}
                                  className="p-1 border rounded text-xs dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                                >
                                  {allowed.map((s) => (
                                    <option key={s} value={s}>
                                      {s}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))
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

