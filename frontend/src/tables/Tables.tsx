import { useState, useEffect, useCallback, useMemo } from 'react';
import { X, Search, Plus, Minus, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import { autoPrint } from '../lib/auto-print';
import { useAuth } from '../auth/AuthProvider';
import { printInBrowser, sendToNetworkPrinter, errorMessage } from '../lib/print';
import { BeerBottleLoader } from '../components/BeerBottleLoader';
import {
  classifyProductCategory,
  CATEGORY_DEFINITIONS,
  getCategoryInfo,
  type LiquorCategoryKey,
} from '../components/category-icons';

type Table = {
  id: string;
  name: string;
  capacity?: number;
  section?: string | null;
  status: 'FREE' | 'OCCUPIED' | 'RESERVED';
  currentSessionId?: string | null;
  sessionOpenedAt?: string | null;
};

type Serving = { id: string; label: string; price: string };

type KhataCustomer = {
  id: string;
  name: string;
  phone: string;
  creditAllowed: boolean;
  creditLimit: string;
  currentCredit: string;
  isActive: boolean;
};

type Product = {
  id: string;
  name: string;
  mrp: string;
  isAvailable?: boolean;
  servings?: Serving[];
  menuType?: 'RETAIL' | 'KITCHEN' | 'BAR';
  categoryName?: string;
  currentStock?: number | null;
  stockQuantity?: number | null;
  openMl?: number | null;
  reorderLevel?: number | null;
  trackStock?: boolean;
};

type KotItem = {
  id: string;
  productId: string;
  productName?: string;
  menuType?: string;
  quantity: number;
  servingLabel?: string | null;
  status: 'PENDING' | 'PREPARING' | 'SERVED' | 'CANCELLED';
  notes?: string | null;
};

type KotOrder = {
  id: string;
  status: string;
  destination: 'KITCHEN' | 'BAR' | string;
  items: KotItem[];
};

export function isKitchenProduct(p: { menuType?: string; categoryName?: string; name?: string }): boolean {
  if (p.menuType === 'KITCHEN') return true;
  if (p.menuType === 'BAR' || p.menuType === 'RETAIL') return false;
  const cat = (p.categoryName || '').toLowerCase();
  return /food|starter|main|snack|kitchen|bread|dessert|tandoor|rice|curry|salad|soup|veg/.test(cat);
}

export function isBarProduct(p: { menuType?: string; categoryName?: string; name?: string }): boolean {
  return !isKitchenProduct(p);
}

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
  // How long each table has been open, refreshed once a minute
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // Modals
  const [activeModal, setActiveModal] = useState<'actions' | 'newKot' | 'viewKots' | 'closeConfirm' | 'checkout' | null>(null);
  const [checkout, setCheckout] = useState({ paymentMode: 'CASH', discount: '', gstin: '', roundOff: 'default' });
  const [discountPercent, setDiscountPercent] = useState('');
  const [billSummary, setBillSummary] = useState<{
    grandTotal: string;
    totalTaxable: string;
    totalTax: string;
    lineItems: Array<{
      productId: string;
      servingLabel?: string | null;
      quantity: number;
      unitPrice: string;
      lineTotal: string;
    }>;
  } | null>(null);
  const [loadingBill, setLoadingBill] = useState(false);
  const [serveAllBusy, setServeAllBusy] = useState(false);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  // Khata / Credit customer state
  const [creditCustomer, setCreditCustomer] = useState<KhataCustomer | null>(null);
  const [creditQuery, setCreditQuery] = useState('');
  const [creditResults, setCreditResults] = useState<KhataCustomer[]>([]);
  const [loadingCredit, setLoadingCredit] = useState(false);
  const [showAddCustomer, setShowAddCustomer] = useState(false);
  const [newCustName, setNewCustName] = useState('');
  const [newCustPhone, setNewCustPhone] = useState('');
  const [newCustLimit, setNewCustLimit] = useState('5000');
  const [newCustAllow, setNewCustAllow] = useState(true);
  const [creatingCust, setCreatingCust] = useState(false);
  const [checkoutDone, setCheckoutDone] = useState<{ billId: string; billNumber: string; total: string } | null>(null);
  const [selectedTable, setSelectedTable] = useState<Table | null>(null);

  // New KOT Form State
  const [kotDest, setKotDest] = useState<'BAR' | 'KITCHEN'>('BAR');
  const [kotCategoryFilter, setKotCategoryFilter] = useState<LiquorCategoryKey>('ALL');
  const [kotSearch, setKotSearch] = useState('');
  const [kotItems, setKotItems] = useState<{ productId: string; servingId?: string; quantity: number }[]>([]);
  const [kotNotes, setKotNotes] = useState('');
  const [kotSubmitting, setKotSubmitting] = useState(false);

  const addItemToKot = (product: Product, servingId?: string) => {
    setKotItems((prev) => {
      const idx = prev.findIndex((it) => it.productId === product.id && (it.servingId ?? '') === (servingId ?? ''));
      if (idx >= 0) {
        return prev.map((it, i) => (i === idx ? { ...it, quantity: it.quantity + 1 } : it));
      }
      return [...prev, { productId: product.id, servingId, quantity: 1 }];
    });
  };

  const updateKotItemQty = (index: number, delta: number) => {
    setKotItems((prev) =>
      prev.map((it, i) => (i === index ? { ...it, quantity: Math.max(1, it.quantity + delta) } : it))
    );
  };

  const availableKotProducts = useMemo(() => {
    const q = kotSearch.trim().toLowerCase();
    return products.filter((p) => {
      if (p.isAvailable === false) return false;

      const matchesDest = kotDest === 'KITCHEN' ? isKitchenProduct(p) : isBarProduct(p);
      if (!matchesDest) return false;

      if (kotCategoryFilter !== 'ALL') {
        const catKey = classifyProductCategory(p);
        if (catKey !== kotCategoryFilter) return false;
      }

      if (q) {
        const matchesQuery =
          p.name.toLowerCase().includes(q) ||
          ((p as any).brand ?? '').toLowerCase().includes(q) ||
          ((p as any).categoryName ?? '').toLowerCase().includes(q);
        if (!matchesQuery) return false;
      }

      return true;
    });
  }, [products, kotDest, kotCategoryFilter, kotSearch]);

  const kotCategoryTabs = useMemo(() => {
    const destProds = products.filter(
      (p) => p.isAvailable !== false && (kotDest === 'KITCHEN' ? isKitchenProduct(p) : isBarProduct(p))
    );

    const counts: Record<LiquorCategoryKey, number> = {
      ALL: destProds.length,
      WHISKY: 0,
      SCOTCH: 0,
      BEER: 0,
      WINE: 0,
      VODKA: 0,
      RUM: 0,
      GIN: 0,
      BRANDY: 0,
      FOOD: 0,
      OTHER: 0,
    };

    for (const p of destProds) {
      const k = classifyProductCategory(p);
      counts[k] = (counts[k] || 0) + 1;
    }

    if (kotDest === 'KITCHEN') {
      return [
        { id: 'ALL' as LiquorCategoryKey, label: 'All Dishes', emoji: '🍽️', count: counts.ALL },
        ...(counts.FOOD > 0 ? [{ id: 'FOOD' as LiquorCategoryKey, label: 'Kitchen Dishes', emoji: '🍳', count: counts.FOOD }] : []),
      ];
    }

    return CATEGORY_DEFINITIONS.filter((def) => def.id !== 'FOOD')
      .map((def) => ({ ...def, count: counts[def.id] || 0 }))
      .filter((def) => def.id === 'ALL' || def.count > 0);
  }, [products, kotDest]);

  // View KOTs State
  const [tableKots, setTableKots] = useState<KotOrder[]>([]);
  const [kotFilter, setKotFilter] = useState<'ALL' | 'KITCHEN' | 'BAR'>('ALL');

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

  const loadProducts = useCallback(async () => {
    if (!branchId) return;
    try {
      const url = `/products?branchId=${branchId}`;
      const prods = await api.get<Product[]>(url);
      setProducts(prods || []);
    } catch {
      // offline or error
    }
  }, [branchId]);

  useEffect(() => {
    loadTables();
    loadProducts();
  }, [loadTables, loadProducts]);

  // Listen for global stock updates
  useEffect(() => {
    const handleStockUpdate = () => {
      loadProducts();
    };
    window.addEventListener('app:stock_updated', handleStockUpdate);
    return () => window.removeEventListener('app:stock_updated', handleStockUpdate);
  }, [loadProducts]);

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

  const handleOpenKotModal = (dest: 'BAR' | 'KITCHEN' = 'BAR') => {
    setKotDest(dest);
    setKotCategoryFilter('ALL');
    setKotSearch('');
    setKotItems([]);
    setKotNotes('');
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
      const created = await api.post<{ kotOrder: { id: string } }>('/kot', {
        tableSessionId: selectedTable.currentSessionId,
        branchId,
        destination: kotDest,
        items: validItems.map((i) => ({ productId: i.productId, quantity: i.quantity, ...(i.servingId ? { servingId: i.servingId } : {}) })),
        ...(kotNotes ? { notes: kotNotes } : {}),
      });
      showToast(`KOT sent to ${kotDest.toLowerCase()} for ${selectedTable.name}`, 'success');
      // Best effort: print the ticket on the branch's network printer when one is configured
      void autoPrint(branchId, 'kot', created.kotOrder.id);
      setActiveModal(null);
      loadProducts();
      window.dispatchEvent(new CustomEvent('app:stock_updated', { detail: { branchId } }));
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
      const effectiveBranchId = branchId || (selectedTable as any)?.branchId || '';
      await api.patch(`/kot/${orderId}/items/${itemId}`, { status: newStatus, branchId: effectiveBranchId });
      showToast(`Item marked ${newStatus}`, 'success');
      // Refresh KOTs
      if (selectedTable?.currentSessionId) {
        const res = await api.get<{ kotOrders: KotOrder[] }>(
          `/kot/session/${selectedTable.currentSessionId}?branchId=${effectiveBranchId}`
        );
        setTableKots(res.kotOrders || []);
      }
    } catch (err: unknown) {
      showToast(`Update failed: ${errorMessage(err)}`, 'error');
    }
  };

  const handleServeAllSession = async (sessionId?: string | null) => {
    const sId = sessionId || selectedTable?.currentSessionId;
    if (!sId) {
      showToast('No active table session found', 'error');
      return;
    }
    setServeAllBusy(true);
    try {
      const effectiveBranchId = branchId || (selectedTable as any)?.branchId || '';
      const res = await api.post<{ count: number }>(`/kot/session/${sId}/serve-all`, {
        branchId: effectiveBranchId,
      });
      showToast(
        res.count > 0
          ? `All active items marked as SERVED (${res.count} items)`
          : 'All items are already served or cancelled.',
        'success'
      );
      // Refresh KOTs
      const kotRes = await api.get<{ kotOrders: KotOrder[] }>(
        `/kot/session/${sId}?branchId=${effectiveBranchId}`
      );
      setTableKots(kotRes.kotOrders || []);
      await loadTables();
      loadProducts();
      window.dispatchEvent(new CustomEvent('app:stock_updated', { detail: { branchId: effectiveBranchId } }));
    } catch (err: unknown) {
      showToast('Failed to mark all served: ' + errorMessage(err), 'error');
    } finally {
      setServeAllBusy(false);
    }
  };

  const handleServeAllKot = async (orderId: string) => {
    const sId = selectedTable?.currentSessionId;
    if (!orderId) return;
    setServeAllBusy(true);
    try {
      const effectiveBranchId = branchId || (selectedTable as any)?.branchId || '';
      const res = await api.post<{ count: number }>(`/kot/${orderId}/serve-all`, {
        branchId: effectiveBranchId,
      });
      showToast(
        res.count > 0
          ? `KOT items marked as SERVED (${res.count} items)`
          : 'All items in this KOT are already served or cancelled.',
        'success'
      );
      // Refresh KOTs
      if (sId) {
        const kotRes = await api.get<{ kotOrders: KotOrder[] }>(
          `/kot/session/${sId}?branchId=${effectiveBranchId}`
        );
        setTableKots(kotRes.kotOrders || []);
      }
      await loadTables();
      loadProducts();
      window.dispatchEvent(new CustomEvent('app:stock_updated', { detail: { branchId: effectiveBranchId } }));
    } catch (err: unknown) {
      showToast('Failed to serve KOT: ' + errorMessage(err), 'error');
    } finally {
      setServeAllBusy(false);
    }
  };

  const loadKhataCustomers = useCallback((q?: string) => {
    if (!branchId) return;
    setLoadingCredit(true);
    const searchParam = q?.trim() ? `?search=${encodeURIComponent(q.trim())}&limit=25` : '?limit=25';
    api.get<{ customers: KhataCustomer[] }>(`/customers/${branchId}${searchParam}`)
      .then((res) => setCreditResults(res.customers || []))
      .catch(() => setCreditResults([]))
      .finally(() => setLoadingCredit(false));
  }, [branchId]);

  useEffect(() => {
    if (activeModal !== 'checkout' || checkout.paymentMode !== 'CREDIT' || !branchId) {
      setCreditResults([]);
      return;
    }
    const timer = setTimeout(() => {
      loadKhataCustomers(creditQuery);
    }, creditQuery.trim() ? 250 : 0);
    return () => clearTimeout(timer);
  }, [activeModal, checkout.paymentMode, branchId, creditQuery, loadKhataCustomers]);

  const handleCreateCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!branchId) return;
    const phoneTrimmed = newCustPhone.trim();
    if (!/^[6-9]\d{9}$/.test(phoneTrimmed)) {
      showToast('Enter a valid 10-digit mobile number starting with 6–9.', 'error');
      return;
    }
    if (!newCustName.trim()) {
      showToast('Customer name is required.', 'error');
      return;
    }

    setCreatingCust(true);
    try {
      const isManager = ['manager', 'owner'].includes(user?.role || '');
      const body: any = {
        name: newCustName.trim(),
        phone: phoneTrimmed,
      };
      if (isManager) {
        if (newCustLimit.trim()) body.creditLimit = newCustLimit.trim();
        body.creditAllowed = newCustAllow;
      }
      const res = await api.post<{ customer: KhataCustomer }>(`/customers/${branchId}`, body);
      showToast(`Customer created: ${res.customer.name}`, 'success');
      setCreditCustomer(res.customer);
      setShowAddCustomer(false);
      setNewCustName('');
      setNewCustPhone('');
      setNewCustLimit('5000');
      setNewCustAllow(true);
      loadKhataCustomers();
    } catch (err) {
      showToast(errorMessage(err), 'error');
    } finally {
      setCreatingCust(false);
    }
  };

  const openCheckout = async () => {
    setCheckout({ paymentMode: 'CASH', discount: '', gstin: '', roundOff: 'default' });
    setDiscountPercent('');
    setCheckoutDone(null);
    setBillSummary(null);
    setCreditCustomer(null);
    setCreditQuery('');
    setCreditResults([]);
    setShowAddCustomer(false);
    setActiveModal('checkout');

    if (selectedTable?.currentSessionId) {
      setLoadingBill(true);
      try {
        const res = await api.get<{
          grandTotal: string;
          totalTaxable: string;
          totalTax: string;
          lineItems: any[];
        }>(`/kot/session/${selectedTable.currentSessionId}/bill?branchId=${branchId}`);
        setBillSummary(res);
      } catch (err: unknown) {
        console.error('Failed to load table bill summary:', err);
      } finally {
        setLoadingBill(false);
      }
    }
  };

  /** Bills every non-cancelled KOT item of the session (servings, GST, stock), then frees the table. */
  const handleCheckout = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTable) return;
    setCheckoutBusy(true);
    try {
      const tableSubtotal = billSummary ? parseFloat(billSummary.grandTotal || '0') : 0;
      const pctNum = Math.max(0, Math.min(100, parseFloat(discountPercent) || 0));
      const discountRupees = (tableSubtotal * pctNum) / 100;
      const discountToSend = discountRupees > 0 ? discountRupees.toFixed(2) : undefined;
      const payableAmount = Math.max(0, tableSubtotal - discountRupees);

      if (checkout.paymentMode === 'CREDIT') {
        if (!creditCustomer) {
          showToast('Pick a khata customer for a credit sale.', 'error');
          setCheckoutBusy(false);
          return;
        }
        if (!creditCustomer.creditAllowed || !creditCustomer.isActive) {
          showToast('Credit is not allowed for this customer.', 'error');
          setCheckoutBusy(false);
          return;
        }
        const limit = parseFloat(creditCustomer.creditLimit || '0');
        const used = parseFloat(creditCustomer.currentCredit || '0');
        if (limit > 0 && (used + payableAmount) > limit) {
          const rem = Math.max(0, limit - used);
          showToast(`Cannot proceed: Table total (₹${payableAmount.toFixed(2)}) exceeds customer's remaining credit (₹${rem.toFixed(2)}).`, 'error');
          setCheckoutBusy(false);
          return;
        }
      }

      const res = await api.post<{ bill: { id: string; billNumber: string; total: string } }>(`/tables/${selectedTable.id}/checkout`, {
        branchId,
        paymentMode: checkout.paymentMode,
        ...(checkout.paymentMode === 'CREDIT' && creditCustomer ? { customerId: creditCustomer.id } : {}),
        ...(discountToSend ? { discount: discountToSend } : {}),
        ...(checkout.gstin.trim() ? { customerGstin: checkout.gstin.trim().toUpperCase() } : {}),
        ...(checkout.roundOff === 'default' ? {} : { roundOff: checkout.roundOff === 'round' }),
      });
      setCheckoutDone({ billId: res.bill.id, billNumber: res.bill.billNumber, total: res.bill.total });
      showToast(`${selectedTable.name} billed: ${res.bill.billNumber}`, 'success');
      // Best effort: print on the branch's network printer when one is configured
      void autoPrint(branchId, 'bills', res.bill.id);
      await loadTables();
      loadProducts();
      window.dispatchEvent(new CustomEvent('app:stock_updated', { detail: { branchId } }));
    } catch (err: unknown) {
      showToast(errorMessage(err), 'error');
    } finally {
      setCheckoutBusy(false);
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
    <div id="page-tables" className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold" id="tablesTitle">Tables &amp; KOT</h2>
          <div className="text-sm text-gray-500 mt-0.5" id="tablesHelp">
            {canCashier
              ? 'Click a free table to open it, or an occupied one for KOT / bill actions.'
              : 'Click an occupied table to raise a KOT or update item status. A cashier opens and bills tables.'}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 font-medium" id="tablesSummary">
            <span className="size-2 rounded-full bg-green-500" aria-hidden="true" /> {tables.filter((t) => t.status === 'FREE').length} free
            <span className="size-2 rounded-full bg-red-500 ml-1.5" aria-hidden="true" /> {tables.filter((t) => t.status === 'OCCUPIED').length} occupied
            {tables.some((t) => t.status === 'RESERVED') && (
              <><span className="size-2 rounded-full bg-amber-500 ml-1.5" aria-hidden="true" /> {tables.filter((t) => t.status === 'RESERVED').length} reserved</>
            )}
          </span>
          <button
            type="button"
            onClick={loadTables}
            className="px-3 py-1.5 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 font-medium cursor-pointer"
          >
            ↻ Refresh
          </button>
        </div>
      </div>

      {/* Tables, grouped by section */}
      <div id="tableGrid" className="space-y-5">
        {loading ? (
          <div>
            <BeerBottleLoader inline size="sm" title="Loading Tables & Bar Seats…" subtitle="Checking open sessions and running orders…" />
          </div>
        ) : tables.length === 0 ? (
          <div className="p-8 text-center text-gray-500">No tables found.</div>
        ) : (
          [...new Set(tables.map((t) => t.section?.trim() || 'General'))].map((section) => (
            <section key={section} aria-label={`${section} tables`}>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2.5 flex items-center gap-2">
                {section}
                <span className="font-normal normal-case tracking-normal text-gray-400">
                  {tables.filter((t) => (t.section?.trim() || 'General') === section && t.status === 'OCCUPIED').length} of {tables.filter((t) => (t.section?.trim() || 'General') === section).length} in use
                </span>
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-3">
                {tables.filter((t) => (t.section?.trim() || 'General') === section).map((t) => {
                  const isOccupied = t.status === 'OCCUPIED';
                  const isFree = t.status === 'FREE';
                  const mins = isOccupied && t.sessionOpenedAt ? Math.max(0, Math.floor((now - new Date(t.sessionOpenedAt).getTime()) / 60000)) : null;
                  const long = mins !== null && mins >= 180;
                  return (
                    <div
                      key={t.id}
                      role="button"
                      tabIndex={0}
                      data-table={t.name}
                      onClick={() => handleTileClick(t)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleTileClick(t); } }}
                      className={`table-tile table-${t.status} relative p-3.5 rounded-xl border cursor-pointer transition hover:shadow-md hover:-translate-y-px flex flex-col justify-between h-32 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 ${
                        isOccupied
                          ? 'border-red-200 bg-red-50 dark:bg-red-950/20 dark:border-red-900/50'
                          : isFree
                          ? 'border-gray-200 bg-white dark:bg-gray-800 dark:border-gray-700 hover:border-purple-300'
                          : 'border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900/50'
                      }`}
                    >
                      <div className="flex justify-between items-start">
                        <span
                          className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-semibold rounded-full ${
                            isOccupied
                              ? 'bg-red-700 text-white'
                              : isFree
                              ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300'
                              : 'bg-amber-600 text-white'
                          }`}
                        >
                          {t.status}
                        </span>
                        <span className="text-xs text-gray-500 tabular-nums">{t.capacity || 4} seats</span>
                      </div>
                      <div>
                        <div className="font-display font-bold text-lg leading-tight truncate">{t.name}</div>
                        <div className={`text-xs tabular-nums ${long ? 'text-red-700 dark:text-red-300 font-semibold' : 'text-gray-500'}`}>
                          {mins !== null ? `Open ${mins >= 60 ? `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m` : `${mins} min`}${long ? ' · long sitting' : ''}` : isFree ? 'Ready to seat' : (t.section || 'General')}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))
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
        <div id="modal" className="fixed inset-0 bg-black/55 backdrop-blur-sm flex justify-center overflow-y-auto [&>*]:my-auto z-50 p-4" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
          <div className={`bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full overflow-hidden border border-gray-200 dark:border-gray-700 ${activeModal === 'newKot' ? 'max-w-3xl' : 'max-w-lg'}`}>
            <div className="flex justify-between items-center p-4 border-b dark:border-gray-700">
              <h2 className="text-lg font-bold" id="modalTitle">
                {activeModal === 'actions' && `${selectedTable?.name} - occupied`}
                {activeModal === 'newKot' && `New KOT - ${selectedTable?.name}`}
                {activeModal === 'viewKots' && `KOTs - ${selectedTable?.name}`}
                {activeModal === 'closeConfirm' && `Close ${selectedTable?.name} without billing?`}
                {activeModal === 'checkout' && `Checkout - ${selectedTable?.name}`}
              </h2>
              <button
                type="button"
                onClick={() => setActiveModal(null)}
                className="p-1 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                aria-label="Close dialog"
              >
                <X size={20} />
              </button>
            </div>

            <div id="modalBody" className="p-4 space-y-4 max-h-[75vh] overflow-y-auto">
              {/* Occupied Table Actions */}
              {activeModal === 'actions' && (
                <div className="space-y-4">
                  <div className="text-sm text-gray-600 dark:text-gray-300">
                    Session active. Select an action below:
                  </div>
                  <div className="space-y-2">
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Orders</div>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        id="tblActKot"
                        onClick={() => handleOpenKotModal('BAR')}
                        className="px-4 py-2.5 bg-purple-600 text-white rounded-lg font-semibold hover:bg-purple-700 text-sm cursor-pointer"
                      >
                        + Bar KOT
                      </button>
                      <button
                        type="button"
                        id="tblActKitchenKot"
                        onClick={() => handleOpenKotModal('KITCHEN')}
                        className="px-4 py-2.5 bg-amber-700 text-white rounded-lg font-semibold hover:bg-amber-800 text-sm cursor-pointer"
                      >
                        + Kitchen KOT
                      </button>
                      <button
                        type="button"
                        id="tblActKots"
                        onClick={() => {
                          setKotFilter('ALL');
                          handleViewKots();
                        }}
                        className="px-4 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg font-semibold hover:bg-gray-100 dark:hover:bg-gray-700 text-sm cursor-pointer"
                      >
                        View KOTs
                      </button>
                      <button
                        type="button"
                        id="tblActServeAll"
                        disabled={serveAllBusy}
                        onClick={() => handleServeAllSession(selectedTable?.currentSessionId)}
                        className="px-4 py-2.5 border border-purple-300 dark:border-purple-700 text-purple-800 dark:text-purple-200 bg-purple-50 dark:bg-purple-900/20 rounded-lg font-semibold hover:bg-purple-100 dark:hover:bg-purple-900/40 text-sm disabled:opacity-50 cursor-pointer"
                        title="Mark all pending and preparing items as SERVED with one click"
                      >
                        Serve All Items
                      </button>
                    </div>
                    {canCashier && (
                      <>
                        <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 pt-3 border-t border-gray-200 dark:border-gray-700 mt-3">Bill</div>
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            id="tblActBill"
                            onClick={openCheckout}
                            className="px-4 py-2.5 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 rounded-lg font-semibold hover:opacity-90 text-sm cursor-pointer"
                          >
                            Checkout &amp; bill
                          </button>
                          <button
                            type="button"
                            id="tblActClose"
                            onClick={() => setActiveModal('closeConfirm')}
                            className="px-4 py-2.5 border border-red-300 dark:border-red-800 text-red-700 dark:text-red-300 rounded-lg font-semibold hover:bg-red-50 dark:hover:bg-red-950/30 text-sm cursor-pointer"
                          >
                            Close without billing
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                  <div className="flex justify-end pt-3 border-t dark:border-gray-700">
                    <button
                      type="button"
                      id="tblActDoneBtn"
                      onClick={() => setActiveModal(null)}
                      className="px-4 py-2 bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-200 rounded-lg text-xs font-semibold transition cursor-pointer"
                    >
                      Done / Close
                    </button>
                  </div>
                </div>
              )}

              {/* Checkout: KOT items -> bill */}
              {activeModal === 'checkout' && !checkoutDone && (() => {
                const tableSubtotal = billSummary ? parseFloat(billSummary.grandTotal || '0') : 0;
                const pctNum = Math.max(0, Math.min(100, parseFloat(discountPercent) || 0));
                const discountRupees = (tableSubtotal * pctNum) / 100;
                const netPayable = Math.max(0, tableSubtotal - discountRupees);
                return (
                  <form onSubmit={handleCheckout} className="space-y-4" id="checkoutForm">
                    <p className="text-sm text-gray-600 dark:text-gray-300">
                      Every KOT item on this table (except cancelled ones) goes on one GST bill at the menu rates. The table is freed afterwards.
                    </p>

                    {/* Bill summary preview */}
                    {loadingBill ? (
                      <div className="p-3 bg-gray-50 dark:bg-gray-750 rounded border dark:border-gray-700">
                        <BeerBottleLoader inline size="sm" title="Calculating Table Bill…" subtitle="Applying pegs, dishes and GST breakdown…" />
                      </div>
                    ) : billSummary && (
                      <div className="p-3 bg-gray-50 dark:bg-gray-750 rounded-lg border dark:border-gray-700 text-xs space-y-1.5">
                        <div className="flex justify-between font-semibold text-gray-700 dark:text-gray-200">
                          <span>Items ({billSummary.lineItems.length})</span>
                          <span className="font-mono">Subtotal: ₹{tableSubtotal.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        </div>
                        <div className="max-h-24 overflow-y-auto divide-y dark:divide-gray-700 text-gray-500 dark:text-gray-400 pr-1">
                          {billSummary.lineItems.map((li, idx) => (
                            <div key={idx} className="py-1 flex justify-between items-center text-[11px]">
                              <span className="truncate pr-2">{productName(li.productId)}{li.servingLabel ? ` (${li.servingLabel})` : ''} × {li.quantity}</span>
                              <span className="font-mono shrink-0">₹{parseFloat(li.lineTotal).toFixed(2)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-3">
                      <label className="block text-xs font-semibold text-gray-500">
                        Payment
                        <select id="coPayment" className="mt-1 w-full p-2 border rounded text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" value={checkout.paymentMode} onChange={(e) => setCheckout({ ...checkout, paymentMode: e.target.value })}>
                          <option value="CASH">Cash</option>
                          <option value="CARD">Card</option>
                          <option value="UPI">UPI</option>
                          <option value="CREDIT">Khata / Credit</option>
                        </select>
                      </label>
                      <div>
                        <div className="flex justify-between items-center mb-1">
                          <label htmlFor="coDiscountPct" className="text-xs font-semibold text-gray-500">
                            Discount (%)
                          </label>
                          {pctNum > 0 && (
                            <span className="text-[11px] font-mono font-semibold text-emerald-600 dark:text-emerald-400">
                              -₹{discountRupees.toFixed(2)}
                            </span>
                          )}
                        </div>
                        <div className="relative">
                          <input
                            id="coDiscountPct"
                            type="number"
                            step="any"
                            min="0"
                            max="100"
                            placeholder="0"
                            value={discountPercent}
                            onChange={(e) => setDiscountPercent(e.target.value)}
                            className="w-full p-2 pr-7 border rounded text-sm font-mono dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                          />
                          <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 font-bold text-xs pointer-events-none">%</span>
                        </div>
                        <input id="coDiscount" type="hidden" value={discountRupees > 0 ? discountRupees.toFixed(2) : ''} readOnly />
                      </div>
                    </div>

                    {/* Khata / Credit Selection Section */}
                    {checkout.paymentMode === 'CREDIT' && (
                      <div id="tableCreditBox" className="space-y-2 text-xs bg-amber-50/50 dark:bg-amber-950/20 p-3 rounded-lg border border-amber-200 dark:border-amber-800">
                        <div className="flex justify-between items-center">
                          <span className="font-semibold text-amber-900 dark:text-amber-200 flex items-center gap-1">
                            Khata / Customer Credit
                          </span>
                          {!showAddCustomer && (
                            <button
                              type="button"
                              id="btnTableQuickAddCust"
                              onClick={() => setShowAddCustomer(true)}
                              className="text-[11px] font-semibold text-purple-600 dark:text-purple-400 hover:underline cursor-pointer flex items-center gap-0.5"
                            >
                              <span>+</span> Add Customer
                            </button>
                          )}
                        </div>

                        {/* Inline Quick Add Customer Form */}
                        {showAddCustomer && (
                          <div className="p-2.5 bg-white dark:bg-gray-800 rounded border border-purple-200 dark:border-purple-800 space-y-2">
                            <div className="flex justify-between items-center border-b pb-1 dark:border-gray-700">
                              <span className="font-bold text-xs text-purple-700 dark:text-purple-300">New Khata Customer</span>
                              <button
                                type="button"
                                onClick={() => setShowAddCustomer(false)}
                                className="text-gray-400 hover:text-gray-600 text-xs cursor-pointer"
                              >
                                ✕
                              </button>
                            </div>
                            <div>
                              <label htmlFor="tblCustName" className="block text-[10px] text-gray-500 font-semibold mb-0.5">Customer Name *</label>
                              <input
                                id="tblCustName"
                                placeholder="e.g. Ramesh Reddy"
                                value={newCustName}
                                onChange={(e) => setNewCustName(e.target.value)}
                                className="w-full p-1.5 border rounded text-xs dark:bg-gray-700 dark:border-gray-600"
                              />
                            </div>
                            <div>
                              <label htmlFor="tblCustPhone" className="block text-[10px] text-gray-500 font-semibold mb-0.5">Mobile Phone (10 digits) *</label>
                              <input
                                id="tblCustPhone"
                                maxLength={10}
                                placeholder="9876543210"
                                value={newCustPhone}
                                onChange={(e) => setNewCustPhone(e.target.value)}
                                className="w-full p-1.5 border rounded text-xs font-mono dark:bg-gray-700 dark:border-gray-600"
                              />
                            </div>
                            {['manager', 'owner'].includes(user?.role || '') ? (
                              <div className="grid grid-cols-2 gap-2 pt-1">
                                <div>
                                  <label htmlFor="tblCustLimit" className="block text-[10px] text-gray-500 font-semibold mb-0.5">Credit Limit (₹)</label>
                                  <input
                                    id="tblCustLimit"
                                    type="number"
                                    min="0"
                                    step="100"
                                    placeholder="5000"
                                    value={newCustLimit}
                                    onChange={(e) => setNewCustLimit(e.target.value)}
                                    className="w-full p-1.5 border rounded text-xs font-mono dark:bg-gray-700 dark:border-gray-600"
                                  />
                                </div>
                                <div className="flex items-center gap-1.5 pt-3">
                                  <input
                                    id="tblCustAllow"
                                    type="checkbox"
                                    checked={newCustAllow}
                                    onChange={(e) => setNewCustAllow(e.target.checked)}
                                    className="rounded text-purple-600"
                                  />
                                  <label htmlFor="tblCustAllow" className="text-[11px] font-semibold text-gray-700 dark:text-gray-300 cursor-pointer">
                                    Allow Credit
                                  </label>
                                </div>
                              </div>
                            ) : (
                              <div className="text-[10px] text-gray-500 bg-gray-50 dark:bg-gray-700 p-1.5 rounded">
                                Profile registered by cashier. Setting credit limit requires Manager authorization.
                              </div>
                            )}
                            <div className="flex justify-end gap-1.5 pt-1">
                              <button
                                type="button"
                                onClick={() => setShowAddCustomer(false)}
                                className="px-2 py-1 text-xs border rounded hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer"
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                id="tblCustSubmit"
                                disabled={creatingCust}
                                onClick={handleCreateCustomer}
                                className="px-2.5 py-1 text-xs bg-purple-600 text-white rounded font-semibold hover:bg-purple-700 disabled:opacity-50 cursor-pointer"
                              >
                                {creatingCust ? 'Saving...' : 'Save & Select'}
                              </button>
                            </div>
                          </div>
                        )}

                        {/* Customer selector */}
                        {!creditCustomer ? (
                          <div className="space-y-1.5">
                            <div className="relative">
                              <input
                                id="tableCreditSearch"
                                className="w-full p-1.5 pr-6 border rounded text-xs dark:bg-gray-700 dark:border-gray-600"
                                placeholder="Search name or phone…"
                                value={creditQuery}
                                onChange={(e) => setCreditQuery(e.target.value)}
                              />
                              {creditQuery && (
                                <button
                                  type="button"
                                  onClick={() => setCreditQuery('')}
                                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs cursor-pointer"
                                >
                                  ✕
                                </button>
                              )}
                            </div>

                            {loadingCredit ? (
                              <div className="p-2 text-center text-xs text-gray-500 animate-pulse">Loading khata customers...</div>
                            ) : creditResults.length > 0 ? (
                              <div id="tableCreditResults" className="max-h-36 overflow-y-auto border rounded divide-y dark:border-gray-700 dark:divide-gray-700 bg-white dark:bg-gray-800">
                                {creditResults.map((c) => {
                                  const limit = parseFloat(c.creditLimit || '0');
                                  const used = parseFloat(c.currentCredit || '0');
                                  const rem = Math.max(0, limit - used);
                                  const disabled = !c.creditAllowed || !c.isActive;
                                  return (
                                    <button
                                      key={c.id}
                                      type="button"
                                      className="list-btn w-full p-2 text-left flex justify-between items-center hover:bg-amber-50/60 dark:hover:bg-gray-700 cursor-pointer transition-colors"
                                      onClick={() => {
                                        setCreditCustomer(c);
                                        setCreditQuery('');
                                      }}
                                    >
                                      <div className="truncate pr-1">
                                        <b className="text-gray-800 dark:text-gray-200">{c.name}</b>{' '}
                                        <span className="text-[11px] text-gray-500 font-mono">({c.phone})</span>
                                      </div>
                                      <div className="shrink-0 text-right">
                                        {disabled ? (
                                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 dark:bg-gray-700 font-semibold">Disabled</span>
                                        ) : rem <= 0 ? (
                                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-600 dark:bg-red-900/40 font-semibold">Limit ₹0</span>
                                        ) : (
                                          <span className="text-xs font-mono font-semibold text-emerald-600 dark:text-emerald-400">₹{rem.toFixed(2)}</span>
                                        )}
                                      </div>
                                    </button>
                                  );
                                })}
                              </div>
                            ) : (
                              <div className="p-2 text-center text-xs text-gray-500 bg-white dark:bg-gray-800 border rounded">
                                No customer found. Click <b className="text-purple-600 cursor-pointer hover:underline" onClick={() => setShowAddCustomer(true)}>+ Add Customer</b>
                              </div>
                            )}
                          </div>
                        ) : (
                          <div id="tableCreditCustomerCard" className="p-2.5 border rounded bg-white dark:bg-gray-800 space-y-1.5 shadow-xs">
                            <div className="flex justify-between items-center border-b pb-1 dark:border-gray-700">
                              <div>
                                <b className="text-sm text-gray-800 dark:text-gray-100">{creditCustomer.name}</b>
                                <span className="text-xs text-gray-500 font-mono ml-1.5">({creditCustomer.phone})</span>
                              </div>
                              <button
                                type="button"
                                className="text-xs text-purple-600 dark:text-purple-400 hover:underline font-semibold cursor-pointer"
                                onClick={() => setCreditCustomer(null)}
                              >
                                Change
                              </button>
                            </div>

                            {(() => {
                              const limit = parseFloat(creditCustomer.creditLimit || '0');
                              const used = parseFloat(creditCustomer.currentCredit || '0');
                              const rem = Math.max(0, limit - used);
                              const projected = used + netPayable;
                              const exceeds = limit > 0 && projected > limit;

                              return (
                                <div className="space-y-1">
                                  <div className="grid grid-cols-3 gap-1 text-[11px] text-center pt-0.5">
                                    <div className="bg-gray-50 dark:bg-gray-700/50 p-1 rounded">
                                      <span className="text-gray-400 text-[10px] block">Limit</span>
                                      <span className="font-mono font-semibold">₹{limit.toFixed(2)}</span>
                                    </div>
                                    <div className="bg-gray-50 dark:bg-gray-700/50 p-1 rounded">
                                      <span className="text-gray-400 text-[10px] block">Used</span>
                                      <span className="font-mono font-semibold text-amber-600">₹{used.toFixed(2)}</span>
                                    </div>
                                    <div className="bg-gray-50 dark:bg-gray-700/50 p-1 rounded">
                                      <span className="text-gray-400 text-[10px] block">Available</span>
                                      <span id="tableCreditRemaining" className="font-mono font-bold text-emerald-600 dark:text-emerald-400">₹{rem.toFixed(2)}</span>
                                    </div>
                                  </div>

                                  {exceeds && (
                                    <div className="p-1.5 rounded bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-[11px] font-semibold flex items-center gap-1">
                                      Exceeds credit limit by ₹{(projected - limit).toFixed(2)}
                                    </div>
                                  )}
                                  {!creditCustomer.creditAllowed && (
                                    <div className="p-1.5 rounded bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-[11px] font-semibold flex items-center gap-1">
                                      Credit is disabled for this customer!
                                    </div>
                                  )}
                                </div>
                              );
                            })()}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Quick percentage chips */}
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[11px] text-gray-500 font-medium">Quick %:</span>
                      {[5, 10, 15, 20].map((pct) => (
                        <button
                          key={pct}
                          type="button"
                          onClick={() => setDiscountPercent(String(pct))}
                          className={`px-2 py-0.5 rounded text-xs font-semibold transition-colors cursor-pointer border ${
                            discountPercent === String(pct)
                              ? 'bg-purple-600 text-white border-purple-600 shadow-xs'
                              : 'bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 border-gray-200 dark:border-gray-600'
                          }`}
                        >
                          {pct}%
                        </button>
                      ))}
                      {discountPercent && (
                        <button
                          type="button"
                          onClick={() => setDiscountPercent('')}
                          className="px-2 py-0.5 rounded text-xs text-gray-500 hover:text-red-500 hover:underline cursor-pointer ml-auto"
                        >
                          Clear
                        </button>
                      )}
                    </div>

                    {/* Net Payable total */}
                    <div className="p-2.5 bg-purple-50 dark:bg-purple-950/30 rounded-lg border border-purple-200 dark:border-purple-800 flex justify-between items-center text-sm">
                      <div>
                        <span className="font-semibold text-purple-900 dark:text-purple-200">Total Payable:</span>
                        {pctNum > 0 && (
                          <div className="text-[11px] text-purple-600 dark:text-purple-400">
                            Includes {pctNum}% discount (-₹{discountRupees.toFixed(2)})
                          </div>
                        )}
                      </div>
                      <span className="font-mono font-bold text-base text-purple-700 dark:text-purple-300">
                        ₹{netPayable.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                    </div>

                    <label className="block text-xs font-semibold text-gray-500">
                      Round-off
                      <select id="coRound" className="mt-1 w-full p-2 border rounded text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" value={checkout.roundOff} onChange={(e) => setCheckout({ ...checkout, roundOff: e.target.value })}>
                        <option value="default">Branch default</option>
                        <option value="round">Round to the nearest rupee</option>
                        <option value="exact">Exact amount</option>
                      </select>
                    </label>
                    <label className="block text-xs font-semibold text-gray-500">
                      Buyer GSTIN (optional, for a B2B invoice)
                      <input id="coGstin" className="mt-1 w-full p-2 border rounded text-sm font-mono dark:bg-gray-700 dark:border-gray-600 dark:text-white" maxLength={15} value={checkout.gstin} onChange={(e) => setCheckout({ ...checkout, gstin: e.target.value })} />
                    </label>
                    <div className="flex justify-end gap-2">
                      <button type="button" onClick={() => setActiveModal('actions')} className="px-4 py-2 border rounded text-sm hover:bg-gray-100 dark:hover:bg-gray-700">Back</button>
                      <button type="submit" id="coConfirm" disabled={checkoutBusy} className="px-4 py-2 bg-emerald-600 text-white rounded text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50">
                        {checkoutBusy ? 'Billing…' : 'Confirm & bill'}
                      </button>
                    </div>
                  </form>
                );
              })()}
              {activeModal === 'checkout' && checkoutDone && (
                <div className="space-y-4 text-center" id="checkoutDone">
                  <div className="text-xs text-gray-500">Bill</div>
                  <div className="text-2xl font-mono text-purple-600" id="coBillNo">{checkoutDone.billNumber}</div>
                  <div className="text-lg font-semibold">₹{parseFloat(checkoutDone.total).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
                  <div className="flex gap-2 justify-center">
                    <button type="button" id="coPrint" onClick={() => printInBrowser('bills', checkoutDone.billId)} className="px-4 py-2 border rounded text-sm hover:bg-gray-100 dark:hover:bg-gray-700">Print bill</button>
                    <button type="button" onClick={() => sendToNetworkPrinter('bills', checkoutDone.billId)} className="px-4 py-2 border rounded text-sm hover:bg-gray-100 dark:hover:bg-gray-700">Send to printer</button>
                    <button type="button" id="coDone" onClick={() => { setActiveModal(null); setSelectedTable(null); setCheckoutDone(null); }} className="px-4 py-2 bg-purple-600 text-white rounded text-sm font-semibold">Done</button>
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
              {activeModal === 'newKot' && (() => {
                const availableProducts = products.filter(
                  (p) => p.isAvailable !== false && (kotDest === 'KITCHEN' ? isKitchenProduct(p) : isBarProduct(p))
                );
                return (
                  <form onSubmit={handleCreateKot} className="space-y-4">
                    {/* Destination toggle */}
                    <div className="flex items-center justify-between gap-3 bg-gray-50 dark:bg-gray-750 p-2.5 rounded-lg border dark:border-gray-700">
                      <div className="text-xs font-semibold text-gray-600 dark:text-gray-300">
                        Order Destination:
                      </div>
                      <div className="flex gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setKotDest('BAR');
                            setKotCategoryFilter('ALL');
                            setKotSearch('');
                          }}
                          className={`px-3 py-1.5 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer ${
                            kotDest === 'BAR'
                              ? 'bg-purple-600 text-white shadow-sm'
                              : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-gray-600 hover:bg-gray-100'
                          }`}
                        >
                          Bar (Drinks &amp; Liquor)
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setKotDest('KITCHEN');
                            setKotCategoryFilter('ALL');
                            setKotSearch('');
                          }}
                          className={`px-3 py-1.5 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer ${
                            kotDest === 'KITCHEN'
                              ? 'bg-purple-600 text-white shadow-sm'
                              : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-gray-600 hover:bg-gray-100'
                          }`}
                        >
                          Kitchen (Food &amp; Snacks)
                        </button>
                      </div>
                      <select
                        id="kotDest"
                        value={kotDest}
                        onChange={(e) => {
                          const newDest = e.target.value as 'BAR' | 'KITCHEN';
                          setKotDest(newDest);
                          setKotCategoryFilter('ALL');
                          setKotSearch('');
                        }}
                        className="sr-only"
                        aria-hidden="true"
                        tabIndex={-1}
                      >
                        <option value="BAR">BAR</option>
                        <option value="KITCHEN">KITCHEN</option>
                      </select>
                    </div>

                    {/* Category Filter Pills */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-xs font-semibold text-gray-500">
                        <span>Filter by Category</span>
                        {kotCategoryFilter !== 'ALL' && (
                          <button
                            type="button"
                            onClick={() => setKotCategoryFilter('ALL')}
                            className="text-purple-600 dark:text-purple-400 hover:underline cursor-pointer"
                          >
                            Show all categories
                          </button>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 overflow-x-auto pb-1.5 scrollbar-none" id="kotCategoryFilters">
                        {kotCategoryTabs.map((cat) => (
                          <button
                            key={cat.id}
                            type="button"
                            onClick={() => setKotCategoryFilter(cat.id)}
                            className={`px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-all flex items-center gap-1.5 border cursor-pointer ${
                              kotCategoryFilter === cat.id
                                ? 'bg-purple-600 text-white border-purple-600 shadow-sm font-semibold'
                                : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 border-gray-200 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-650'
                            }`}
                          >
                            <span>{cat.emoji}</span>
                            <span>{cat.label}</span>
                            <span
                              className={`text-[10px] px-1.5 py-0.2 rounded-full font-bold ${
                                kotCategoryFilter === cat.id
                                  ? 'bg-purple-700 text-white'
                                  : 'bg-gray-100 dark:bg-gray-600 text-gray-600 dark:text-gray-300'
                              }`}
                            >
                              {cat.count}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Search Bar */}
                    <div className="relative">
                      <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                      <input
                        type="search"
                        id="kotSearch"
                        value={kotSearch}
                        onChange={(e) => setKotSearch(e.target.value)}
                        placeholder={`Search ${kotDest === 'BAR' ? 'whisky, scotch, beer, wine, vodka, brands...' : 'food dishes, snacks...'}`}
                        className="w-full pl-9 pr-8 py-2 text-xs sm:text-sm border rounded-lg dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                      />
                      {kotSearch && (
                        <button
                          type="button"
                          onClick={() => setKotSearch('')}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 p-0.5 rounded cursor-pointer"
                        >
                          <X size={14} />
                        </button>
                      )}
                    </div>

                    {/* Quick-Add Drink Catalog Grid */}
                    <div>
                      <div className="text-xs font-semibold text-gray-500 mb-1.5 flex items-center justify-between">
                        <span>Available {kotDest === 'BAR' ? 'Drinks' : 'Kitchen Items'} ({availableKotProducts.length})</span>
                        <span className="text-[11px] text-gray-400">Click + Add to select</span>
                      </div>
                      {availableKotProducts.length === 0 ? (
                        <div className="p-4 text-center text-xs text-gray-500 bg-gray-50 dark:bg-gray-750 rounded-lg border border-dashed dark:border-gray-700">
                          No items match "{kotSearch}"
                          {kotCategoryFilter !== 'ALL' ? ` in ${kotCategoryFilter.toLowerCase()}` : ''}.
                        </div>
                      ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-48 overflow-y-auto p-1.5 border rounded-lg dark:border-gray-700 bg-gray-50/50 dark:bg-gray-750/30">
                          {availableKotProducts.map((p) => {
                            const stockQty = p.currentStock ?? p.stockQuantity ?? 0;
                            const isTracked = p.trackStock !== false;
                            const isOut = isTracked && stockQty <= 0;
                            const catInfo = getCategoryInfo(p.categoryName, p.name);
                            const inKotCount = kotItems.filter((i) => i.productId === p.id).reduce((sum, i) => sum + i.quantity, 0);

                            return (
                              <div
                                key={p.id}
                                className={`p-2 bg-white dark:bg-gray-800 rounded-lg border text-xs flex items-center justify-between gap-2 shadow-xs transition-colors ${
                                  isOut
                                    ? 'opacity-60 border-red-200 dark:border-red-900/50'
                                    : inKotCount > 0
                                    ? 'border-purple-300 dark:border-purple-600 bg-purple-50/20 dark:bg-purple-950/20'
                                    : 'border-gray-200 dark:border-gray-700 hover:border-purple-200'
                                }`}
                              >
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-1.5 mb-0.5">
                                    <span>{catInfo.emoji}</span>
                                    <span className="font-semibold truncate text-gray-800 dark:text-gray-100" title={p.name}>
                                      {p.name}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-2 text-[11px] text-gray-500">
                                    <span className="font-mono font-semibold text-purple-600 dark:text-purple-400">
                                      ₹{parseFloat(p.mrp || '0')}
                                    </span>
                                    {isTracked ? (
                                      isOut ? (
                                        <span className="text-red-600 dark:text-red-400 font-semibold">Out of stock</span>
                                      ) : (
                                        <span className="text-emerald-700 dark:text-emerald-400">
                                          Stock: {stockQty} btl{p.openMl ? `, ${p.openMl}ml open` : ''}
                                        </span>
                                      )
                                    ) : (
                                      <span className="text-gray-400">Kitchen</span>
                                    )}
                                  </div>
                                </div>

                                <div className="shrink-0 flex items-center gap-1.5">
                                  {inKotCount > 0 && (
                                    <span className="px-1.5 py-0.5 text-[10px] font-bold bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300 rounded">
                                      {inKotCount} in KOT
                                    </span>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => addItemToKot(p)}
                                    className="p-1 px-2.5 bg-purple-100 hover:bg-purple-200 dark:bg-purple-900/60 dark:hover:bg-purple-800 text-purple-700 dark:text-purple-300 rounded font-semibold text-xs transition-colors cursor-pointer flex items-center gap-1"
                                  >
                                    <Plus size={13} />
                                    <span>Add</span>
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    {/* Order Lines (View & Count) */}
                    <div>
                      <div className="flex items-center justify-between text-xs font-semibold text-gray-500 mb-1.5">
                        <span>Selected Items ({kotItems.filter((i) => i.productId).length} items, {kotItems.reduce((sum, i) => sum + (i.productId ? i.quantity : 0), 0)} total)</span>
                        <button
                          type="button"
                          onClick={() =>
                            setKotItems((prev) => [
                              ...prev,
                              { productId: availableProducts[0]?.id || products[0]?.id || '', quantity: 1 },
                            ])
                          }
                          className="text-xs text-purple-600 dark:text-purple-400 font-semibold hover:underline cursor-pointer"
                        >
                          + Add custom row
                        </button>
                      </div>

                      <div id="kotLines" className="space-y-2 max-h-52 overflow-y-auto pr-1">
                        {kotItems.length === 0 ? (
                          <div className="p-4 text-center text-xs text-gray-500 bg-gray-50 dark:bg-gray-750 rounded-lg border border-dashed dark:border-gray-700">
                            No items added yet. Click <span className="font-semibold text-purple-600 dark:text-purple-400">+ Add</span> on any {kotDest === 'BAR' ? 'drink' : 'dish'} above, or click <span className="font-semibold text-purple-600 dark:text-purple-400">+ Add custom row</span>.
                          </div>
                        ) : (
                          kotItems.map((item, idx) => {
                            const prod = products.find((p) => p.id === item.productId);
                            const hasServings = (prod?.servings ?? []).length > 0;

                            return (
                              <div
                                key={idx}
                                className="kot-line p-2.5 bg-white dark:bg-gray-750 border dark:border-gray-700 rounded-lg flex flex-wrap sm:flex-nowrap items-center gap-2"
                              >
                                <select
                                  className="kot-product flex-1 min-w-[180px] p-1.5 border rounded text-xs dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                                  aria-label="Product"
                                  value={item.productId}
                                  onChange={(e) => {
                                    const val = e.target.value;
                                    setKotItems((prev) =>
                                      prev.map((it, i) => (i === idx ? { ...it, productId: val, servingId: undefined } : it))
                                    );
                                  }}
                                >
                                  {availableProducts.map((p) => {
                                    const sQty = p.currentStock ?? p.stockQuantity ?? 0;
                                    const isTrk = p.trackStock !== false;
                                    const sLabel = isTrk
                                      ? sQty <= 0
                                        ? ' [Out of Stock]'
                                        : ` [Stock: ${sQty} btl${p.openMl ? `, ${p.openMl}ml open` : ''}]`
                                      : ' [Kitchen]';
                                    return (
                                      <option key={p.id} value={p.id}>
                                        {p.name} {p.mrp ? `(₹${parseFloat(p.mrp)})` : ''}{sLabel}
                                      </option>
                                    );
                                  })}
                                </select>

                                {hasServings && (
                                  <select
                                    className="kot-serving w-32 p-1.5 border rounded text-xs dark:bg-gray-700 dark:border-gray-600 dark:text-white shrink-0"
                                    aria-label="Serving"
                                    value={item.servingId ?? ''}
                                    onChange={(e) => {
                                      const val = e.target.value;
                                      setKotItems((prev) =>
                                        prev.map((it, i) => (i === idx ? { ...it, servingId: val || undefined } : it))
                                      );
                                    }}
                                  >
                                    <option value="">Bottle rate</option>
                                    {prod!.servings!.map((s) => (
                                      <option key={s.id} value={s.id}>
                                        {s.label} — ₹{parseFloat(s.price)}
                                      </option>
                                    ))}
                                  </select>
                                )}

                                {/* Stepper ([-] [ count ] [+]) for easy counting */}
                                <div className="flex items-center border rounded-lg dark:border-gray-600 overflow-hidden shrink-0 bg-gray-50 dark:bg-gray-700">
                                  <button
                                    type="button"
                                    onClick={() => updateKotItemQty(idx, -1)}
                                    className="p-1.5 px-2 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 transition-colors cursor-pointer"
                                    title="Decrease quantity"
                                    aria-label="Decrease quantity"
                                  >
                                    <Minus size={12} />
                                  </button>
                                  <input
                                    type="number"
                                    min={1}
                                    max={50}
                                    className="kot-qty w-12 p-1 text-xs text-center font-bold bg-transparent dark:text-white border-x dark:border-gray-600 focus:outline-none"
                                    value={item.quantity}
                                    onChange={(e) => {
                                      const q = parseInt(e.target.value) || 1;
                                      setKotItems((prev) =>
                                        prev.map((it, i) => (i === idx ? { ...it, quantity: Math.max(1, q) } : it))
                                      );
                                    }}
                                  />
                                  <button
                                    type="button"
                                    onClick={() => updateKotItemQty(idx, 1)}
                                    className="p-1.5 px-2 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 transition-colors cursor-pointer"
                                    title="Increase quantity"
                                    aria-label="Increase quantity"
                                  >
                                    <Plus size={12} />
                                  </button>
                                </div>

                                <button
                                  type="button"
                                  onClick={() => setKotItems((prev) => prev.filter((_, i) => i !== idx))}
                                  className="p-1.5 text-gray-400 hover:text-red-500 rounded text-xs transition-colors cursor-pointer shrink-0"
                                  aria-label="Remove line"
                                  title="Remove item"
                                >
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            );
                          })
                        )}
                      </div>
                    </div>

                    {/* Order Notes */}
                    <div>
                      <label htmlFor="kotNotes" className="block text-xs font-semibold mb-1 text-gray-500">
                        Order Notes / Instructions
                      </label>
                      <input
                        id="kotNotes"
                        maxLength={500}
                        value={kotNotes}
                        onChange={(e) => setKotNotes(e.target.value)}
                        placeholder="e.g. Less spicy, extra ice, soda on side"
                        className="w-full p-2 border rounded-lg dark:bg-gray-700 dark:border-gray-600 dark:text-white text-xs"
                      />
                    </div>

                    {/* Submit Actions */}
                    <div className="flex justify-between items-center pt-2 border-t dark:border-gray-700">
                      <div className="text-xs font-medium text-gray-500">
                        Total Quantity: <span className="font-bold text-gray-800 dark:text-gray-100">{kotItems.reduce((sum, i) => sum + (i.productId ? i.quantity : 0), 0)}</span>
                      </div>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => setActiveModal(null)}
                          className="px-4 py-2 border rounded-lg text-xs font-medium hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors cursor-pointer"
                        >
                          Cancel / Done
                        </button>
                        <button
                          type="submit"
                          id="kotCreateBtn"
                          disabled={kotSubmitting || !kotItems.some((i) => i.productId && i.quantity > 0)}
                          className="px-4 py-2 bg-purple-600 text-white rounded-lg text-xs font-semibold hover:bg-purple-700 disabled:opacity-50 transition-colors shadow-sm cursor-pointer flex items-center gap-1.5"
                        >
                          <span>✓</span> {kotSubmitting ? 'Submitting KOT...' : `Submit & Create ${kotDest === 'BAR' ? 'Bar' : 'Kitchen'} KOT (${kotItems.reduce((sum, i) => sum + (i.productId ? i.quantity : 0), 0)})`}
                        </button>
                      </div>
                    </div>
                  </form>
                );
              })()}

              {/* View KOTs List */}
              {activeModal === 'viewKots' && (() => {
                const filteredKots = tableKots.filter((o) => {
                  if (kotFilter === 'ALL') return true;
                  return o.destination === kotFilter;
                });
                const kitchenCount = tableKots.filter((o) => o.destination === 'KITCHEN').length;
                const barCount = tableKots.filter((o) => o.destination === 'BAR').length;
                return (
                  <div className="space-y-4">
                    {/* Destination filter tabs & Serve All button */}
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b dark:border-gray-700 pb-2">
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => setKotFilter('ALL')}
                          className={`px-3 py-1 text-xs rounded-full font-medium transition cursor-pointer ${
                            kotFilter === 'ALL'
                              ? 'bg-purple-600 text-white'
                              : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                          }`}
                        >
                          All ({tableKots.length})
                        </button>
                        <button
                          type="button"
                          onClick={() => setKotFilter('KITCHEN')}
                          className={`px-3 py-1 text-xs rounded-full font-medium transition cursor-pointer ${
                            kotFilter === 'KITCHEN'
                              ? 'bg-amber-600 text-white'
                              : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                          }`}
                        >
                          Kitchen ({kitchenCount})
                        </button>
                        <button
                          type="button"
                          onClick={() => setKotFilter('BAR')}
                          className={`px-3 py-1 text-xs rounded-full font-medium transition cursor-pointer ${
                            kotFilter === 'BAR'
                              ? 'bg-purple-600 text-white'
                              : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                          }`}
                        >
                          Bar ({barCount})
                        </button>
                      </div>
                      {tableKots.some((o) => o.items.some((i) => i.status === 'PENDING' || i.status === 'PREPARING')) && (
                        <button
                          type="button"
                          id="tblServeAllModalBtn"
                          disabled={serveAllBusy}
                          onClick={() => handleServeAllSession(selectedTable?.currentSessionId)}
                          className="px-3 py-1 bg-purple-600 hover:bg-purple-700 text-white text-xs rounded-lg font-semibold disabled:opacity-50 transition-colors cursor-pointer flex items-center gap-1 shadow-xs"
                          title="Mark all pending and preparing items across all KOTs as SERVED"
                        >
                          Serve All Items
                        </button>
                      )}
                    </div>

                    {filteredKots.length === 0 ? (
                      <div className="p-4 text-center text-gray-500">
                        {tableKots.length === 0
                          ? 'No KOTs for this table yet.'
                          : `No ${kotFilter.toLowerCase()} KOTs for this table.`}
                      </div>
                    ) : (
                      filteredKots.map((o, idx) => {
                        const isKitchen = o.destination === 'KITCHEN';
                        return (
                          <div key={o.id} className="p-3 border rounded-lg dark:border-gray-700 space-y-2">
                            <div className="flex justify-between items-center font-bold text-sm">
                              <span className="flex items-center gap-2">
                                <span
                                  className={`px-2 py-0.5 rounded text-xs font-semibold ${
                                    isKitchen
                                      ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 border border-amber-300 dark:border-amber-700'
                                      : 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300 border border-purple-300 dark:border-purple-700'
                                  }`}
                                >
                                  {isKitchen ? 'Kitchen Order' : 'Bar Order'}
                                </span>
                                <span>KOT #{idx + 1}</span>
                              </span>
                              <span className="flex items-center gap-2">
                                {o.items.some((i) => i.status === 'PENDING' || i.status === 'PREPARING') && (
                                  <button
                                    type="button"
                                    disabled={serveAllBusy}
                                    className="text-xs px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-700 text-white font-semibold cursor-pointer transition-colors flex items-center gap-1 shadow-xs"
                                    onClick={() => handleServeAllKot(o.id)}
                                    title="Mark all items in this KOT as SERVED"
                                  >
                                    <span>✓</span> Serve KOT
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="text-xs text-purple-600 hover:underline cursor-pointer"
                                  onClick={() => printInBrowser('kot', o.id)}
                                >
                                  Print KOT
                                </button>
                                <span className="text-xs px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-700">
                                  {o.status}
                                </span>
                              </span>
                            </div>
                            <div className="divide-y dark:divide-gray-700">
                              {o.items.map((i) => {
                                const nextOptions = KOT_NEXT[i.status] || [];
                                const allowed = [i.status, ...nextOptions];
                                const displayName = i.productName || productName(i.productId);
                                return (
                                  <div key={i.id} className="py-2 flex justify-between items-center text-sm">
                                    <div>
                                      <div className="font-medium">
                                        {displayName}
                                        {i.servingLabel ? ` (${i.servingLabel})` : ''} × {i.quantity}
                                      </div>
                                      {i.notes && (
                                        <div className="text-xs text-gray-400 italic">Note: {i.notes}</div>
                                      )}
                                    </div>
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
                        );
                      })
                    )}

                    {/* Bottom Action Footer for KOT View Modal */}
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t dark:border-gray-700 bg-white dark:bg-gray-800 sticky bottom-0">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          id="kotBackToActions"
                          onClick={() => setActiveModal('actions')}
                          className="px-3.5 py-2 border rounded-lg text-xs font-semibold text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition cursor-pointer"
                        >
                          ← Table Actions
                        </button>
                        <button
                          type="button"
                          id="kotAddNewBtn"
                          onClick={() => handleOpenKotModal('BAR')}
                          className="px-3 py-2 bg-purple-50 hover:bg-purple-100 dark:bg-purple-900/40 dark:hover:bg-purple-900/70 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-700 rounded-lg text-xs font-semibold transition cursor-pointer flex items-center gap-1"
                        >
                          <span>+</span> Add KOT
                        </button>
                      </div>

                      <div className="flex items-center gap-2">
                        {tableKots.some((o) => o.items.some((i) => i.status === 'PENDING' || i.status === 'PREPARING')) && (
                          <button
                            type="button"
                            id="kotSubmitAllBtn"
                            disabled={serveAllBusy}
                            onClick={async () => {
                              await handleServeAllSession(selectedTable?.currentSessionId);
                            }}
                            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold shadow-xs transition cursor-pointer flex items-center gap-1.5 disabled:opacity-50"
                          >
                            Submit All Served
                          </button>
                        )}
                        <button
                          type="button"
                          id="kotDoneBtn"
                          onClick={() => setActiveModal(null)}
                          className="px-5 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-xs font-bold shadow-sm transition cursor-pointer flex items-center gap-1.5"
                        >
                          <span>✓</span> Done
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

