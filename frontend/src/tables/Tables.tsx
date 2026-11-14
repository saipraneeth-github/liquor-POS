import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  X,
  Search,
  Plus,
  Minus,
  Trash2,
  Clock,
  Users,
  ArrowRightLeft,
  Merge,
  RefreshCw,
  Receipt,
  CreditCard,
  Banknote,
  QrCode,
  Eye,
  Printer,
  Calendar,
} from 'lucide-react';
import { api } from '../api/client';
import { autoPrint } from '../lib/auto-print';
import { useAuth } from '../auth/AuthProvider';
import { printInBrowser, sendToNetworkPrinter, errorMessage, showToast } from '../lib/print';
import { BeerBottleLoader } from '../components/BeerBottleLoader';
import { quickCashOptions, tender } from '../pos/posLogic';
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
  sessionGuestCount?: number | null;
  sessionStewardName?: string | null;
  /** What the table has ordered so far (MRP, tax included), the items, and how many are still to serve. */
  sessionTotal?: string | null;
  sessionItems?: number | null;
  sessionToServe?: number | null;
  sessionLastOrderAt?: string | null;
};

const money = (v: number | string) => Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const minutesSince = (iso: string | null | undefined, now: number) => (iso ? Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000)) : null);
const duration = (mins: number) => (mins >= 60 ? `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m` : `${mins} min`);
const LONG_SITTING_MIN = 180;      // a table open this long is flagged
const SLOW_SERVE_MIN = 10;         // items waiting this long are flagged

export type TodayCollection = {
  total: string;
  cash: string;
  card: string;
  upi: string;
  credit: string;
  billCount: number;
  voidCount: number;
  guestCount: number;
  averageBill: string;
  bySection: { section: string; total: string; billCount: number }[];
  byPaymentMode: { mode: string; total: string; count: number }[];
};

export type TodayBillItem = {
  productName: string;
  servingLabel?: string | null;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
};

export type TodayTableBill = {
  id: string;
  billNumber: string;
  tableId: string;
  tableName: string;
  section?: string | null;
  stewardId?: string | null;
  stewardName?: string | null;
  guestCount?: number | null;
  paymentMode: string;
  status: string;
  subtotal: string;
  taxAmount: string;
  discount: string;
  total: string;
  createdAt: string;
  itemCount: number;
  items: TodayBillItem[];
};

export type TodaySummary = {
  date: string;
  collection: TodayCollection;
  bills: TodayTableBill[];
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
  const [activeModal, setActiveModal] = useState<'actions' | 'newKot' | 'viewKots' | 'closeConfirm' | 'checkout' | 'move' | 'merge' | null>(null);
  const [view, setView] = useState<'ALL' | 'FREE' | 'OCCUPIED' | 'SERVE' | 'COLLECTION' | 'BILLS'>('ALL');
  const [todaySummary, setTodaySummary] = useState<TodaySummary | null>(null);
  const [loadingToday, setLoadingToday] = useState(false);
  const [billsSearch, setBillsSearch] = useState('');
  const [billsPaymentFilter, setBillsPaymentFilter] = useState<'ALL' | 'CASH' | 'CARD' | 'UPI' | 'CREDIT'>('ALL');
  const [selectedBillForModal, setSelectedBillForModal] = useState<TodayTableBill | null>(null);
  const [floorSearch, setFloorSearch] = useState('');
  const [received, setReceived] = useState('');
  const [moveBusy, setMoveBusy] = useState(false);
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
  const [checkoutDone, setCheckoutDone] = useState<{ billId: string; billNumber: string; total: string; received?: number; change?: number } | null>(null);
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const selectedTable = useMemo(
    () => tables.find((t) => t.id === selectedTableId) ?? null,
    [tables, selectedTableId]
  );
  const setSelectedTable = useCallback((t: Table | null) => {
    setSelectedTableId(t?.id ?? null);
  }, []);

  // New KOT Form State
  const [kotDest, setKotDest] = useState<'BAR' | 'KITCHEN'>('BAR');
  const [kotCategoryFilter, setKotCategoryFilter] = useState<LiquorCategoryKey>('ALL');
  const [kotStockFilter, setKotStockFilter] = useState<'ALL' | 'IN_STOCK' | 'OUT_OF_STOCK'>('ALL');
  const [kotSearch, setKotSearch] = useState('');
  const [kotItems, setKotItems] = useState<{ productId: string; servingId?: string; quantity: number }[]>([]);
  const [kotNotes, setKotNotes] = useState('');
  const [kotSubmitting, setKotSubmitting] = useState(false);

  const addItemToKot = (product: Product, servingId?: string) => {
    const stockQty = product.currentStock ?? product.stockQuantity ?? 0;
    const isTracked = product.trackStock !== false;
    if (isTracked && stockQty <= 0) {
      showToast(`Cannot add "${product.name}". It is currently out of stock.`, 'error');
      return;
    }
    const existing = kotItems.find((it) => it.productId === product.id && (it.servingId ?? '') === (servingId ?? ''));
    if (existing && isTracked && existing.quantity + 1 > stockQty) {
      showToast(`Cannot add more "${product.name}". Only ${stockQty} available in stock.`, 'error');
      return;
    }
    setKotItems((prev) => {
      const idx = prev.findIndex((it) => it.productId === product.id && (it.servingId ?? '') === (servingId ?? ''));
      if (idx >= 0) {
        return prev.map((it, i) => (i === idx ? { ...it, quantity: it.quantity + 1 } : it));
      }
      return [...prev, { productId: product.id, servingId, quantity: 1 }];
    });
  };

  const updateKotItemQty = (index: number, delta: number) => {
    if (delta <= 0) {
      setKotItems((prev) =>
        prev.map((it, i) => (i === index ? { ...it, quantity: Math.max(1, it.quantity + delta) } : it))
      );
      return;
    }
    const item = kotItems[index];
    if (!item) return;
    const p = products.find((prod) => prod.id === item.productId);
    const stockQty = p?.currentStock ?? p?.stockQuantity ?? 0;
    const isTracked = p?.trackStock !== false;
    if (isTracked && item.quantity + delta > stockQty) {
      showToast(`Cannot exceed available stock (${stockQty} bottles) for "${p?.name}".`, 'error');
      return;
    }
    setKotItems((prev) =>
      prev.map((it, i) => (i === index ? { ...it, quantity: it.quantity + delta } : it))
    );
  };

  const kotEstimatedTotal = useMemo(() => {
    let sum = 0;
    for (const item of kotItems) {
      if (!item.productId || item.quantity <= 0) continue;
      const p = products.find((prod) => prod.id === item.productId);
      if (!p) continue;
      if (item.servingId && p.servings?.length) {
        const s = p.servings.find((srv) => srv.id === item.servingId);
        if (s) {
          sum += Number(s.price || 0) * item.quantity;
          continue;
        }
      }
      sum += Number(p.mrp || 0) * item.quantity;
    }
    return sum;
  }, [kotItems, products]);

  const kotStockCounts = useMemo(() => {
    const destProds = products.filter(
      (p) => p.isAvailable !== false && (kotDest === 'KITCHEN' ? isKitchenProduct(p) : isBarProduct(p))
    );
    let inStock = 0;
    let outOfStock = 0;
    for (const p of destProds) {
      const stockQty = p.currentStock ?? p.stockQuantity ?? 0;
      const isTracked = p.trackStock !== false;
      if (!isTracked || stockQty > 0) {
        inStock++;
      } else {
        outOfStock++;
      }
    }
    return { all: destProds.length, inStock, outOfStock };
  }, [products, kotDest]);

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

      if (kotStockFilter !== 'ALL') {
        const stockQty = p.currentStock ?? p.stockQuantity ?? 0;
        const isTracked = p.trackStock !== false;
        if (kotStockFilter === 'IN_STOCK') {
          if (isTracked && stockQty <= 0) return false;
        } else if (kotStockFilter === 'OUT_OF_STOCK') {
          if (!isTracked || stockQty > 0) return false;
        }
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
  }, [products, kotDest, kotCategoryFilter, kotStockFilter, kotSearch]);

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

  const loadTables = useCallback(async (silent = false) => {
    if (!branchId) return;
    if (!silent) setLoading(true);
    try {
      const res = await api.get<{ tables: Table[] }>(`/tables/${branchId}`);
      setTables(res.tables || []);
    } catch {
      if (!silent) setTables([]);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [branchId]);

  // The floor refreshes itself (a bill grows while you look at it); not while a dialog is open
  useEffect(() => {
    const timer = window.setInterval(() => { if (!document.hidden) void loadTables(true); }, 30_000);
    return () => window.clearInterval(timer);
  }, [loadTables]);

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

  const loadTodaySummary = useCallback(async (silent = false) => {
    if (!branchId) return;
    if (!silent) setLoadingToday(true);
    try {
      const res = await api.get<TodaySummary>(`/tables/${branchId}/today`);
      setTodaySummary(res);
    } catch {
      // offline or error
    } finally {
      if (!silent) setLoadingToday(false);
    }
  }, [branchId]);

  useEffect(() => {
    loadTables();
    loadProducts();
    loadTodaySummary();
  }, [loadTables, loadProducts, loadTodaySummary]);

  // Listen for global stock updates
  useEffect(() => {
    const handleStockUpdate = () => {
      loadProducts();
      void loadTodaySummary(true);
    };
    window.addEventListener('app:stock_updated', handleStockUpdate);
    return () => window.removeEventListener('app:stock_updated', handleStockUpdate);
  }, [loadProducts, loadTodaySummary]);

  const handleTileClick = async (table: Table) => {
    if (table.status === 'OCCUPIED') {
      setSelectedTableId(table.id);
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
      setSelectedTableId(table.id);
      await loadTables(true);
      setActiveModal('actions');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to open table';
      showToast(`Could not open ${table.name}: ${msg}`, 'error');
    }
  };

  const handleOpenKotModal = (dest: 'BAR' | 'KITCHEN' = 'BAR') => {
    setKotDest(dest);
    setKotCategoryFilter('ALL');
    setKotStockFilter('ALL');
    setKotSearch('');
    setKotItems([]);
    setKotNotes('');
    setActiveModal('newKot');
  };

  const handleCreateKot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTable || !selectedTable.currentSessionId) {
      showToast('No active table session found. Please open the table first.', 'error');
      return;
    }

    const validItems = kotItems.filter((i) => i.productId && i.quantity > 0);
    if (!validItems.length) {
      showToast('Each KOT line needs a valid product and quantity of at least 1.', 'error');
      return;
    }

    for (const item of validItems) {
      const p = products.find((prod) => prod.id === item.productId);
      const isKitchen = p ? isKitchenProduct(p) : kotDest === 'KITCHEN';
      const isTracked = !isKitchen && p?.trackStock === true;
      if (isTracked) {
        const stockQty = p?.currentStock ?? p?.stockQuantity ?? 0;
        if (item.quantity > stockQty) {
          showToast(`Insufficient stock for "${p?.name}": requested ${item.quantity}, only ${stockQty} available.`, 'error');
          return;
        }
      }
    }

    setKotSubmitting(true);
    try {
      // Partition items by destination so drinks go to BAR and food goes to KITCHEN
      const barItems = validItems.filter((i) => {
        const p = products.find((prod) => prod.id === i.productId);
        return p ? isBarProduct(p) : kotDest === 'BAR';
      });
      const kitchenItems = validItems.filter((i) => {
        const p = products.find((prod) => prod.id === i.productId);
        return p ? isKitchenProduct(p) : kotDest === 'KITCHEN';
      });

      const batches: Array<{ destination: 'BAR' | 'KITCHEN'; items: typeof validItems }> = [];
      if (barItems.length > 0 && kitchenItems.length > 0) {
        batches.push({ destination: 'BAR', items: barItems });
        batches.push({ destination: 'KITCHEN', items: kitchenItems });
      } else if (barItems.length > 0) {
        batches.push({ destination: 'BAR', items: barItems });
      } else {
        batches.push({ destination: 'KITCHEN', items: kitchenItems });
      }

      for (const batch of batches) {
        const created = await api.post<{ kotOrder: { id: string } }>('/kot', {
          tableSessionId: selectedTable.currentSessionId,
          branchId,
          destination: batch.destination,
          items: batch.items.map((i) => ({ productId: i.productId, quantity: i.quantity, ...(i.servingId ? { servingId: i.servingId } : {}) })),
          ...(kotNotes ? { notes: kotNotes } : {}),
        });
        showToast(`KOT sent to ${batch.destination.toLowerCase()} for ${selectedTable.name}`, 'success');
        // Best effort: print the ticket on the branch's network printer when one is configured
        void autoPrint(branchId, 'kot', created.kotOrder.id);
      }

      setActiveModal(null);
      await loadTables(true);
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
      await loadTables();
      loadProducts();
      window.dispatchEvent(new CustomEvent('app:stock_updated', { detail: { branchId: effectiveBranchId } }));
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

  const openCheckout = async (tbl?: Table | null) => {
    const target = tbl ?? selectedTable;
    if (!target) return;
    setSelectedTableId(target.id);
    setReceived('');
    setCheckout({ paymentMode: 'CASH', discount: '', gstin: '', roundOff: 'default' });
    setDiscountPercent('');
    setCheckoutDone(null);
    setBillSummary(null);
    setCreditCustomer(null);
    setCreditQuery('');
    setCreditResults([]);
    setShowAddCustomer(false);
    setActiveModal('checkout');

    if (target.currentSessionId) {
      setLoadingBill(true);
      try {
        const res = await api.get<{
          grandTotal: string;
          totalTaxable: string;
          totalTax: string;
          lineItems: any[];
        }>(`/kot/session/${target.currentSessionId}/bill?branchId=${branchId}`);
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
      const handed = checkout.paymentMode === 'CASH' ? tender(payableAmount, received) : null;
      if (handed?.state === 'short') {
        showToast(`The customer has handed over ₹${money(handed.received)}: ₹${money(handed.short)} short.`, 'error');
        setCheckoutBusy(false);
        return;
      }

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
      setCheckoutDone({ billId: res.bill.id, billNumber: res.bill.billNumber, total: res.bill.total, ...(handed?.state === 'ok' ? { received: handed.received, change: handed.change } : {}) });
      showToast(`${selectedTable.name} billed: ${res.bill.billNumber}`, 'success');
      // Best effort: print on the branch's network printer when one is configured
      void autoPrint(branchId, 'bills', res.bill.id);
      await loadTables();
      loadProducts();
      void loadTodaySummary(true);
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

  const doMove = async (to: Table) => {
    if (!selectedTable) return;
    setMoveBusy(true);
    try {
      await api.post(`/tables/${selectedTable.id}/move`, { branchId, toTableId: to.id });
      showToast(`${selectedTable.name} moved to ${to.name}`, 'success');
      setActiveModal(null);
      setSelectedTable(null);
      await loadTables(true);
    } catch (err: unknown) {
      showToast(errorMessage(err), 'error');
    } finally {
      setMoveBusy(false);
    }
  };

  const doMerge = async (into: Table) => {
    if (!selectedTable) return;
    setMoveBusy(true);
    try {
      await api.post(`/tables/${selectedTable.id}/merge`, { branchId, intoTableId: into.id });
      showToast(`${selectedTable.name} merged into ${into.name}: one bill`, 'success');
      setActiveModal(null);
      setSelectedTable(null);
      await loadTables(true);
    } catch (err: unknown) {
      showToast(errorMessage(err), 'error');
    } finally {
      setMoveBusy(false);
    }
  };

  /** A tile's quick buttons act on that table without first opening the actions dialog. */
  const quickOrder = (t: Table) => { setSelectedTableId(t.id); handleOpenKotModal('BAR'); };
  const quickBill = (t: Table) => { setSelectedTableId(t.id); void openCheckout(t); };

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

  // ── the floor: what is open, what it has spent, what is waiting ──
  const occupied = tables.filter((t) => t.status === 'OCCUPIED');
  const openTotal = occupied.reduce((sum, t) => sum + Number(t.sessionTotal ?? 0), 0);
  const toServeTotal = occupied.reduce((sum, t) => sum + (t.sessionToServe ?? 0), 0);
  const needsAttention = occupied
    .map((t) => {
      const sittingMin = minutesSince(t.sessionOpenedAt, now);
      const waitingMin = (t.sessionToServe ?? 0) > 0 ? minutesSince(t.sessionLastOrderAt, now) : null;
      return { t, sittingMin, waitingMin, slow: waitingMin !== null && waitingMin >= SLOW_SERVE_MIN, long: sittingMin !== null && sittingMin >= LONG_SITTING_MIN };
    })
    .filter((x) => x.slow || x.long);
  const needle = floorSearch.trim().toLowerCase();
  const shown = tables.filter((t) => {
    if (needle && !t.name.toLowerCase().includes(needle) && !(t.sessionStewardName ?? '').toLowerCase().includes(needle)) return false;
    if (view === 'FREE') return t.status === 'FREE';
    if (view === 'OCCUPIED') return t.status === 'OCCUPIED';
    if (view === 'SERVE') return t.status === 'OCCUPIED' && (t.sessionToServe ?? 0) > 0;
    return true;
  });
  const sections = [...new Set(shown.map((t) => t.section?.trim() || 'General'))];

  return (
    <div id="page-tables" className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold" id="tablesTitle">Tables &amp; KOT</h2>
          <div className="text-sm text-gray-500 mt-0.5" id="tablesHelp">
            {canCashier
              ? 'Tap a free table to open it, or an occupied one for orders, billing, move and merge.'
              : 'Tap an occupied table to raise a KOT or update item status. A cashier opens and bills tables.'}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button type="button" id="tablesRefresh" onClick={() => { void loadTables(); void loadTodaySummary(); }} className="inline-flex items-center gap-1.5 px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 font-medium cursor-pointer">
            <RefreshCw size={14} aria-hidden="true" /> Refresh
          </button>
        </div>
      </div>

      {/* The day at a glance */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2" id="tablesSummary">
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Open bills</div>
          <div className="font-display font-bold text-xl tabular-nums" id="sumOpenTotal">₹{money(openTotal)}</div>
        </div>
        <button
          type="button"
          onClick={() => setView(view === 'COLLECTION' ? 'ALL' : 'COLLECTION')}
          className={`text-left rounded-xl border px-3 py-2.5 cursor-pointer transition ${view === 'COLLECTION' ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30 ring-1 ring-emerald-500' : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:border-emerald-300'}`}
        >
          <div className="text-[11px] font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">Collection today</div>
          <div className="font-display font-bold text-xl tabular-nums text-emerald-700 dark:text-emerald-300" id="sumCollectionToday">
            ₹{money(todaySummary?.collection.total ?? '0.00')}
          </div>
        </button>
        <button
          type="button"
          onClick={() => setView(view === 'BILLS' ? 'ALL' : 'BILLS')}
          className={`text-left rounded-xl border px-3 py-2.5 cursor-pointer transition ${view === 'BILLS' ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30 ring-1 ring-blue-500' : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:border-blue-300'}`}
        >
          <div className="text-[11px] font-semibold uppercase tracking-wider text-blue-600 dark:text-blue-400">Bills today</div>
          <div className="font-display font-bold text-xl tabular-nums text-blue-700 dark:text-blue-300" id="sumBillsToday">
            {todaySummary?.collection.billCount ?? 0} <span className="text-xs font-sans font-medium text-gray-500">settled</span>
          </div>
        </button>
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Tables</div>
          <div className="text-sm font-semibold flex items-center gap-3 mt-1">
            <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-emerald-500" aria-hidden="true" />{tables.filter((t) => t.status === 'FREE').length} free</span>
            <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-red-500" aria-hidden="true" />{occupied.length} occupied</span>
            {tables.some((t) => t.status === 'RESERVED') && <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-amber-500" aria-hidden="true" />{tables.filter((t) => t.status === 'RESERVED').length} reserved</span>}
          </div>
        </div>
        <button type="button" onClick={() => setView(view === 'SERVE' ? 'ALL' : 'SERVE')} className={`text-left rounded-xl border px-3 py-2.5 cursor-pointer ${view === 'SERVE' ? 'border-purple-500 bg-purple-50 dark:bg-purple-950/30' : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:border-purple-300'}`}>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">To serve</div>
          <div className="font-display font-bold text-xl tabular-nums" id="sumToServe">{toServeTotal} <span className="text-xs font-sans font-medium text-gray-500">item{toServeTotal === 1 ? '' : 's'} waiting</span></div>
        </button>
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Guests seated</div>
          <div className="font-display font-bold text-xl tabular-nums">{occupied.reduce((n, t) => n + (t.sessionGuestCount ?? 0), 0) || '—'}</div>
        </div>
      </div>

      {/* Needs attention: slow to serve, or sitting a long time */}
      {needsAttention.length > 0 && (
        <div id="tablesAttention" className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 dark:border-amber-900/50 bg-amber-50/70 dark:bg-amber-950/20 px-3 py-2">
          <span className="text-xs font-bold uppercase tracking-wider text-amber-800 dark:text-amber-300">Needs attention</span>
          {needsAttention.map(({ t, slow, long, waitingMin, sittingMin }) => (
            <button key={t.id} type="button" data-attention={t.name} onClick={() => handleTileClick(t)} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-white dark:bg-gray-800 border border-amber-300 dark:border-amber-800 text-xs font-semibold cursor-pointer hover:bg-amber-100 dark:hover:bg-amber-900/30">
              {t.name}
              <span className="font-normal text-gray-600 dark:text-gray-300">{slow ? `${t.sessionToServe} waiting ${duration(waitingMin ?? 0)}` : `open ${duration(sittingMin ?? 0)}`}{slow && long ? ' · long sitting' : ''}</span>
            </button>
          ))}
        </div>
      )}

      {/* Search & view tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {view !== 'COLLECTION' && view !== 'BILLS' ? (
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" aria-hidden="true" />
            <input id="tablesSearch" type="search" value={floorSearch} onChange={(e) => setFloorSearch(e.target.value)} placeholder="Find a table or steward" className="w-56 py-2 pl-9 pr-3 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm" />
          </div>
        ) : (
          <div className="text-xs font-medium text-gray-500">
            {view === 'COLLECTION' ? 'Revenue summary for table sessions and KOT orders today' : 'All settled table bills for today'}
          </div>
        )}
        <div className="inline-flex flex-wrap rounded-lg border border-gray-200 dark:border-gray-700 p-0.5 bg-white dark:bg-gray-800 text-xs font-semibold" role="group" aria-label="Show">
          {([
            ['ALL', 'All Tables'],
            ['OCCUPIED', 'Occupied'],
            ['FREE', 'Free'],
            ['SERVE', 'To serve'],
            ['COLLECTION', 'Collection today'],
            ['BILLS', 'Bills today'],
          ] as const).map(([k, label]) => (
            <button
              key={k}
              type="button"
              data-view={k}
              aria-pressed={view === k}
              onClick={() => {
                setView(k);
                if ((k === 'COLLECTION' || k === 'BILLS') && !todaySummary) {
                  void loadTodaySummary();
                }
              }}
              className={`px-3 py-1.5 rounded-md cursor-pointer transition ${view === k ? 'bg-purple-600 text-white shadow-sm' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ─── COLLECTION TODAY VIEW ────────────────────────────────────────── */}
      {view === 'COLLECTION' && (
        <div id="viewCollectionToday" className="space-y-5">
          {/* Header & Date */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-bold">Tables &amp; KOT Revenue Today</h3>
                <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800 dark:bg-purple-950/60 dark:text-purple-300">
                  <Calendar size={12} /> {todaySummary?.date || 'Today'}
                </span>
              </div>
              <p className="text-xs text-gray-500 mt-1">
                Reflects exclusively settled bills from table dine-in and KOT orders. Counter sales are not included.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void loadTodaySummary()}
                disabled={loadingToday}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium bg-gray-50 dark:bg-gray-700 hover:bg-gray-100 dark:hover:bg-gray-600 cursor-pointer disabled:opacity-50"
              >
                <RefreshCw size={13} className={loadingToday ? 'animate-spin' : ''} /> Refresh
              </button>
              <button
                type="button"
                onClick={() => setView('BILLS')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-purple-600 text-white hover:bg-purple-700 cursor-pointer"
              >
                <Receipt size={13} /> View Bills Today ({todaySummary?.collection.billCount ?? 0})
              </button>
            </div>
          </div>

          {loadingToday ? (
            <BeerBottleLoader inline size="sm" title="Loading collection summary…" subtitle="Calculating payments by mode and section…" />
          ) : (
            <>
              {/* Grand Total Hero Card */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="md:col-span-2 rounded-2xl border border-emerald-200 dark:border-emerald-900/50 bg-gradient-to-br from-emerald-500/10 via-emerald-500/5 to-transparent p-5">
                  <div className="text-xs font-bold uppercase tracking-wider text-emerald-800 dark:text-emerald-300">
                    Total Tables Revenue Today
                  </div>
                  <div className="font-display font-bold text-4xl tabular-nums text-emerald-700 dark:text-emerald-300 mt-2">
                    ₹{money(todaySummary?.collection.total ?? '0.00')}
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-xs text-gray-600 dark:text-gray-300 mt-3 pt-3 border-t border-emerald-200/60 dark:border-emerald-800/60">
                    <span><strong>{todaySummary?.collection.billCount ?? 0}</strong> bills settled</span>
                    <span>•</span>
                    <span><strong>{todaySummary?.collection.guestCount ?? 0}</strong> guests served</span>
                    <span>•</span>
                    <span>Avg bill: <strong>₹{money(todaySummary?.collection.averageBill ?? '0.00')}</strong></span>
                    {(todaySummary?.collection.voidCount ?? 0) > 0 && (
                      <span className="text-red-600 dark:text-red-400 font-semibold">
                        • {todaySummary?.collection.voidCount} voided
                      </span>
                    )}
                  </div>
                </div>

                <div className="rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 flex flex-col justify-between">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wider text-gray-500">Average Ticket</div>
                    <div className="font-display font-bold text-3xl tabular-nums mt-2">
                      ₹{money(todaySummary?.collection.averageBill ?? '0.00')}
                    </div>
                  </div>
                  <div className="text-xs text-gray-500 mt-2">
                    Per settled table bill
                  </div>
                </div>

                <div className="rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 flex flex-col justify-between">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wider text-gray-500">Guests Served</div>
                    <div className="font-display font-bold text-3xl tabular-nums mt-2">
                      {todaySummary?.collection.guestCount ?? 0}
                    </div>
                  </div>
                  <div className="text-xs text-gray-500 mt-2">
                    Cover count across all tables
                  </div>
                </div>
              </div>

              {/* Payment Mode Breakdown */}
              <div>
                <h4 className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-3">
                  Collection by Payment Mode
                </h4>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  {/* CASH */}
                  <div className="p-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Cash</span>
                      <span className="p-1.5 rounded-lg bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">
                        <Banknote size={16} />
                      </span>
                    </div>
                    <div className="font-display font-bold text-2xl tabular-nums mt-2">
                      ₹{money(todaySummary?.collection.cash ?? '0.00')}
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      {todaySummary?.collection.byPaymentMode.find((m) => m.mode === 'CASH')?.count ?? 0} bills
                    </div>
                  </div>

                  {/* CARD */}
                  <div className="p-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Card</span>
                      <span className="p-1.5 rounded-lg bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300">
                        <CreditCard size={16} />
                      </span>
                    </div>
                    <div className="font-display font-bold text-2xl tabular-nums mt-2">
                      ₹{money(todaySummary?.collection.card ?? '0.00')}
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      {todaySummary?.collection.byPaymentMode.find((m) => m.mode === 'CARD')?.count ?? 0} bills
                    </div>
                  </div>

                  {/* UPI */}
                  <div className="p-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">UPI / QR</span>
                      <span className="p-1.5 rounded-lg bg-purple-100 text-purple-800 dark:bg-purple-950/60 dark:text-purple-300">
                        <QrCode size={16} />
                      </span>
                    </div>
                    <div className="font-display font-bold text-2xl tabular-nums mt-2">
                      ₹{money(todaySummary?.collection.upi ?? '0.00')}
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      {todaySummary?.collection.byPaymentMode.find((m) => m.mode === 'UPI')?.count ?? 0} bills
                    </div>
                  </div>

                  {/* CREDIT (KHATA) */}
                  <div className="p-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Khata / Credit</span>
                      <span className="p-1.5 rounded-lg bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
                        <Users size={16} />
                      </span>
                    </div>
                    <div className="font-display font-bold text-2xl tabular-nums mt-2">
                      ₹{money(todaySummary?.collection.credit ?? '0.00')}
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      {todaySummary?.collection.byPaymentMode.find((m) => m.mode === 'CREDIT')?.count ?? 0} bills
                    </div>
                  </div>
                </div>
              </div>

              {/* Section Breakdown */}
              <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-gray-500">
                    Revenue by Section / Floor
                  </h4>
                </div>
                {(!todaySummary?.collection.bySection || todaySummary.collection.bySection.length === 0) ? (
                  <div className="p-8 text-center text-sm text-gray-500">
                    No table bills recorded for today yet.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-gray-50 dark:bg-gray-900/50 text-xs uppercase text-gray-500 border-b border-gray-200 dark:border-gray-700">
                        <tr>
                          <th className="px-4 py-2.5">Section</th>
                          <th className="px-4 py-2.5">Bills Settled</th>
                          <th className="px-4 py-2.5 text-right">Total Revenue</th>
                          <th className="px-4 py-2.5 text-right">% of Total</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                        {todaySummary.collection.bySection.map((sec) => {
                          const totalNum = Number(todaySummary.collection.total) || 1;
                          const secNum = Number(sec.total) || 0;
                          const pct = Math.round((secNum / totalNum) * 100);
                          return (
                            <tr key={sec.section} className="hover:bg-gray-50/50 dark:hover:bg-gray-750">
                              <td className="px-4 py-3 font-semibold">{sec.section}</td>
                              <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{sec.billCount}</td>
                              <td className="px-4 py-3 text-right font-display font-semibold tabular-nums">
                                ₹{money(sec.total)}
                              </td>
                              <td className="px-4 py-3 text-right text-gray-500 text-xs">
                                <div className="inline-flex items-center gap-2">
                                  <div className="w-16 h-2 rounded-full bg-gray-100 dark:bg-gray-700 overflow-hidden">
                                    <div className="h-full bg-purple-600 rounded-full" style={{ width: `${pct}%` }} />
                                  </div>
                                  <span>{pct}%</span>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* ─── BILLS TODAY VIEW ─────────────────────────────────────────────── */}
      {view === 'BILLS' && (
        <div id="viewBillsToday" className="space-y-4">
          {/* Header & Filter Controls */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-bold">Table Bills Settled Today</h3>
                <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300">
                  {todaySummary?.bills.length ?? 0} Bills
                </span>
              </div>
              <p className="text-xs text-gray-500 mt-1">
                Showing all bills settled from tables &amp; bar/kitchen sessions for today ({todaySummary?.date || 'Today'}).
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void loadTodaySummary()}
                disabled={loadingToday}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium bg-gray-50 dark:bg-gray-700 hover:bg-gray-100 dark:hover:bg-gray-600 cursor-pointer disabled:opacity-50"
              >
                <RefreshCw size={13} className={loadingToday ? 'animate-spin' : ''} /> Refresh
              </button>
              <button
                type="button"
                onClick={() => setView('COLLECTION')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 cursor-pointer"
              >
                <Banknote size={13} /> View Collection (₹{money(todaySummary?.collection.total ?? '0.00')})
              </button>
            </div>
          </div>

          {/* Search & Payment Mode Filters */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="relative">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" aria-hidden="true" />
              <input
                id="billsSearch"
                type="search"
                value={billsSearch}
                onChange={(e) => setBillsSearch(e.target.value)}
                placeholder="Search bill #, table, steward..."
                className="w-64 py-2 pl-9 pr-3 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-sm"
              />
            </div>

            <div className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 p-0.5 bg-white dark:bg-gray-800 text-xs font-semibold">
              {(['ALL', 'CASH', 'CARD', 'UPI', 'CREDIT'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setBillsPaymentFilter(mode)}
                  className={`px-3 py-1.5 rounded-md cursor-pointer transition ${billsPaymentFilter === mode ? 'bg-purple-600 text-white' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'}`}
                >
                  {mode === 'ALL' ? 'All Modes' : mode}
                </button>
              ))}
            </div>
          </div>

          {loadingToday ? (
            <BeerBottleLoader inline size="sm" title="Loading today's bills…" subtitle="Fetching settled table receipts…" />
          ) : (
            (() => {
              const q = billsSearch.trim().toLowerCase();
              const filtered = (todaySummary?.bills ?? []).filter((b) => {
                if (billsPaymentFilter !== 'ALL' && b.paymentMode !== billsPaymentFilter) return false;
                if (!q) return true;
                return (
                  b.billNumber.toLowerCase().includes(q) ||
                  b.tableName.toLowerCase().includes(q) ||
                  (b.section || '').toLowerCase().includes(q) ||
                  (b.stewardName || '').toLowerCase().includes(q)
                );
              });

              if (filtered.length === 0) {
                return (
                  <div className="p-12 text-center text-gray-500 border border-dashed rounded-xl bg-white dark:bg-gray-800">
                    <Receipt size={32} className="mx-auto mb-2 text-gray-400" />
                    <p className="font-semibold text-gray-700 dark:text-gray-300">No table bills match</p>
                    <p className="text-xs text-gray-400 mt-1">
                      {todaySummary?.bills.length === 0
                        ? 'No tables have been billed today yet.'
                        : 'Try adjusting your search query or payment mode filter.'}
                    </p>
                  </div>
                );
              }

              return (
                <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-gray-50 dark:bg-gray-900/50 text-xs uppercase text-gray-500 border-b border-gray-200 dark:border-gray-700">
                        <tr>
                          <th className="px-4 py-3">Bill #</th>
                          <th className="px-4 py-3">Table / Area</th>
                          <th className="px-4 py-3">Steward</th>
                          <th className="px-4 py-3">Items</th>
                          <th className="px-4 py-3">Payment</th>
                          <th className="px-4 py-3 text-right">Total</th>
                          <th className="px-4 py-3 text-center">Time</th>
                          <th className="px-4 py-3 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                        {filtered.map((bill) => {
                          const timeStr = bill.createdAt ? new Date(bill.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—';
                          return (
                            <tr key={bill.id} className="hover:bg-gray-50/60 dark:hover:bg-gray-750 transition">
                              <td className="px-4 py-3">
                                <div className="font-mono font-bold text-gray-900 dark:text-gray-100">{bill.billNumber}</div>
                                {bill.status === 'VOIDED' && (
                                  <span className="text-[10px] uppercase font-bold text-red-600 bg-red-100 dark:bg-red-950/60 px-1.5 py-0.5 rounded">VOIDED</span>
                                )}
                              </td>
                              <td className="px-4 py-3">
                                <div className="font-semibold text-gray-900 dark:text-gray-100">{bill.tableName}</div>
                                <div className="text-xs text-gray-500">
                                  {bill.section || 'General'}
                                  {bill.guestCount ? ` · ${bill.guestCount} guests` : ''}
                                </div>
                              </td>
                              <td className="px-4 py-3 text-gray-600 dark:text-gray-300 text-xs">
                                {bill.stewardName || '—'}
                              </td>
                              <td className="px-4 py-3">
                                <div className="text-xs text-gray-700 dark:text-gray-300 font-medium">
                                  {bill.itemCount} items
                                </div>
                                <div className="text-[11px] text-gray-400 truncate max-w-[14rem]" title={bill.items.map(it => `${it.productName} (${it.quantity})`).join(', ')}>
                                  {bill.items.map((it) => it.productName).slice(0, 2).join(', ')}
                                  {bill.items.length > 2 ? ` +${bill.items.length - 2} more` : ''}
                                </div>
                              </td>
                              <td className="px-4 py-3">
                                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${
                                  bill.paymentMode === 'CASH'
                                    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300'
                                    : bill.paymentMode === 'CARD'
                                    ? 'bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300'
                                    : bill.paymentMode === 'UPI'
                                    ? 'bg-purple-100 text-purple-800 dark:bg-purple-950/60 dark:text-purple-300'
                                    : 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300'
                                }`}>
                                  {bill.paymentMode}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-right">
                                <div className="font-display font-bold text-base tabular-nums text-gray-900 dark:text-gray-100">
                                  ₹{money(bill.total)}
                                </div>
                                {Number(bill.discount || 0) > 0 && (
                                  <div className="text-[11px] text-emerald-600">
                                    -₹{money(bill.discount)} off
                                  </div>
                                )}
                              </td>
                              <td className="px-4 py-3 text-center text-xs text-gray-500 tabular-nums">
                                {timeStr}
                              </td>
                              <td className="px-4 py-3 text-right">
                                <div className="inline-flex items-center gap-1.5">
                                  <button
                                    type="button"
                                    onClick={() => setSelectedBillForModal(bill)}
                                    title="View Receipt Details"
                                    className="p-1.5 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 cursor-pointer"
                                  >
                                    <Eye size={14} />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => printInBrowser('bills', bill.id)}
                                    title="Print Bill"
                                    className="p-1.5 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 text-purple-600 dark:text-purple-400 cursor-pointer"
                                  >
                                    <Printer size={14} />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })()
          )}
        </div>
      )}

      {/* ─── FLOOR / TABLE GRID VIEW ──────────────────────────────────────── */}
      {view !== 'COLLECTION' && view !== 'BILLS' && (
        <>
          {/* Tables, grouped by section */}
          <div id="tableGrid" className="space-y-5">
        {loading ? (
          <div>
            <BeerBottleLoader inline size="sm" title="Loading Tables & Bar Seats…" subtitle="Checking open sessions and running orders…" />
          </div>
        ) : tables.length === 0 ? (
          <div className="p-8 text-center text-gray-500">No tables found.</div>
        ) : shown.length === 0 ? (
          <div className="p-8 text-center text-gray-500 border border-dashed rounded-xl" id="tablesNone">
            No tables match. <button type="button" className="text-purple-700 font-semibold hover:underline cursor-pointer" onClick={() => { setView('ALL'); setFloorSearch(''); }}>Show all</button>
          </div>
        ) : (
          sections.map((section) => {
            const inSection = shown.filter((t) => (t.section?.trim() || 'General') === section);
            const sectionTotal = inSection.reduce((sum, t) => sum + Number(t.sessionTotal ?? 0), 0);
            return (
              <section key={section} aria-label={`${section} tables`}>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2.5 flex items-center gap-2">
                  {section}
                  <span className="font-normal normal-case tracking-normal text-gray-400">
                    {inSection.filter((t) => t.status === 'OCCUPIED').length} of {inSection.length} in use{sectionTotal > 0 ? ` · ₹${money(sectionTotal)} open` : ''}
                  </span>
                </h3>
                <div className="grid grid-cols-1 min-[440px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
                  {inSection.map((t) => {
                    const isOccupied = t.status === 'OCCUPIED';
                    const isFree = t.status === 'FREE';
                    const mins = isOccupied ? minutesSince(t.sessionOpenedAt, now) : null;
                    const long = mins !== null && mins >= LONG_SITTING_MIN;
                    const waiting = (t.sessionToServe ?? 0) > 0 ? minutesSince(t.sessionLastOrderAt, now) : null;
                    const slow = waiting !== null && waiting >= SLOW_SERVE_MIN;
                    const total = Number(t.sessionTotal ?? 0);
                    return (
                      <div
                        key={t.id}
                        role="button"
                        tabIndex={0}
                        data-table={t.name}
                        onClick={() => handleTileClick(t)}
                        onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); handleTileClick(t); } }}
                        className={`table-tile table-${t.status} relative p-3.5 rounded-xl border cursor-pointer transition hover:shadow-md flex flex-col gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 ${isOccupied ? 'min-h-[11.5rem]' : 'min-h-[7.5rem]'} ${
                          isOccupied
                            ? `bg-white dark:bg-gray-800 border-l-4 ${slow ? 'border-l-red-500 border-red-200 dark:border-red-900/50' : 'border-l-emerald-600 border-gray-200 dark:border-gray-700'}`
                            : isFree
                            ? 'border-dashed border-gray-300 bg-gray-50/60 dark:bg-gray-800/40 dark:border-gray-700 hover:border-purple-300'
                            : 'border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900/50'
                        }`}
                      >
                        <div className="flex justify-between items-start gap-2">
                          <div className="min-w-0">
                            <div className="font-display font-bold text-lg leading-tight truncate">{t.name}</div>
                            <div className="text-[11px] text-gray-500 inline-flex items-center gap-1"><Users size={11} aria-hidden="true" />{isOccupied && t.sessionGuestCount ? `${t.sessionGuestCount} of ${t.capacity || 4}` : `${t.capacity || 4} seats`}</div>
                          </div>
                          <span className={`inline-flex items-center px-2 py-0.5 text-[11px] font-semibold rounded-full shrink-0 ${
                            isOccupied ? 'bg-emerald-700 text-white' : isFree ? 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200' : 'bg-amber-600 text-white'
                          }`}>
                            {t.status}
                          </span>
                        </div>

                        {isOccupied ? (
                          <>
                            {/* What they have spent so far */}
                            <div>
                              <div className="font-display font-bold text-2xl leading-none tabular-nums text-gray-900 dark:text-gray-50" data-bill={t.name}>₹{money(total)}</div>
                              <div className="text-xs text-gray-500 mt-1">
                                {(t.sessionItems ?? 0) === 0 ? 'Nothing ordered yet' : `${t.sessionItems} item${t.sessionItems === 1 ? '' : 's'} ordered`}
                              </div>
                            </div>
                            <div className="flex flex-wrap gap-1.5 text-[11px]">
                              {(t.sessionToServe ?? 0) > 0 ? (
                                <span className={`px-2 py-0.5 rounded-full font-semibold ${slow ? 'bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300' : 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300'}`} data-toserve={t.name}>
                                  {t.sessionToServe} to serve{waiting !== null ? ` · ${duration(waiting)}` : ''}
                                </span>
                              ) : (t.sessionItems ?? 0) > 0 ? (
                                <span className="px-2 py-0.5 rounded-full font-semibold bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300">All served</span>
                              ) : null}
                              {mins !== null && <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full ${long ? 'bg-red-100 text-red-800 font-semibold dark:bg-red-950/50 dark:text-red-300' : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'}`}><Clock size={10} aria-hidden="true" />{duration(mins)}{long ? ' · long sitting' : ''}</span>}
                              {t.sessionStewardName && <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300 truncate max-w-[9rem]">{t.sessionStewardName}</span>}
                            </div>
                            <div className="mt-auto flex gap-2">
                              <button type="button" data-quick="order" onClick={(e) => { e.stopPropagation(); quickOrder(t); }} className="flex-1 py-2 rounded-lg bg-purple-600 hover:bg-purple-700 text-white text-xs font-semibold cursor-pointer">+ Order</button>
                              {canCashier && (
                                <button type="button" data-quick="bill" onClick={(e) => { e.stopPropagation(); quickBill(t); }} className="flex-1 py-2 rounded-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-xs font-semibold cursor-pointer hover:opacity-90">Bill ₹{money(total)}</button>
                              )}
                            </div>
                          </>
                        ) : (
                          <div className="mt-auto text-xs text-gray-500">{isFree ? (canCashier ? 'Tap to open' : 'Ready to seat') : (t.section || 'General')}</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
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
    </>
  )}

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
                {activeModal === 'move' && `Move ${selectedTable?.name}`}
                {activeModal === 'merge' && `Merge ${selectedTable?.name} with…`}
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
                  {selectedTable && (
                    <div id="tblSummary" className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 p-3 flex items-center justify-between gap-3">
                      <div>
                        <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">Bill so far</div>
                        <div className="font-display font-bold text-2xl tabular-nums" id="tblSummaryTotal">₹{money(Number(selectedTable.sessionTotal ?? 0))}</div>
                      </div>
                      <div className="text-xs text-gray-600 dark:text-gray-300 text-right space-y-0.5">
                        <div>{selectedTable.sessionItems ?? 0} item{selectedTable.sessionItems === 1 ? '' : 's'}{(selectedTable.sessionToServe ?? 0) > 0 ? ` · ${selectedTable.sessionToServe} to serve` : ''}</div>
                        <div>{selectedTable.sessionStewardName ?? 'No steward'}{selectedTable.sessionGuestCount ? ` · ${selectedTable.sessionGuestCount} guests` : ''}</div>
                        {minutesSince(selectedTable.sessionOpenedAt, now) !== null && <div>Open {duration(minutesSince(selectedTable.sessionOpenedAt, now) ?? 0)}</div>}
                      </div>
                    </div>
                  )}
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
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 pt-3 border-t border-gray-200 dark:border-gray-700 mt-3">Table</div>
                    <div className="grid grid-cols-2 gap-2">
                      <button type="button" id="tblActMove" onClick={() => setActiveModal('move')} className="inline-flex items-center justify-center gap-2 px-4 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg font-semibold hover:bg-gray-100 dark:hover:bg-gray-700 text-sm cursor-pointer">
                        <ArrowRightLeft size={15} aria-hidden="true" /> Move table
                      </button>
                      {canCashier && (
                        <button type="button" id="tblActMerge" onClick={() => setActiveModal('merge')} className="inline-flex items-center justify-center gap-2 px-4 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg font-semibold hover:bg-gray-100 dark:hover:bg-gray-700 text-sm cursor-pointer">
                          <Merge size={15} aria-hidden="true" /> Merge with…
                        </button>
                      )}
                    </div>
                    {canCashier && (
                      <>
                        <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 pt-3 border-t border-gray-200 dark:border-gray-700 mt-3">Bill</div>
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            id="tblActBill"
                            onClick={() => void openCheckout()}
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
                const cashInfo = checkout.paymentMode === 'CASH' && netPayable > 0 ? tender(netPayable, received) : null;
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

                    {/* Cash: what they hand over, and the change to give back */}
                    {cashInfo && (
                      <div id="coTender" className="space-y-2 p-3 rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50/50 dark:bg-emerald-950/20">
                        <div className="flex items-center gap-2">
                          <label htmlFor="coReceived" className="text-xs font-semibold text-gray-600 dark:text-gray-300 shrink-0">Cash received</label>
                          <div className="relative flex-1">
                            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-sm pointer-events-none">₹</span>
                            <input id="coReceived" type="number" inputMode="decimal" min="0" step="any" placeholder={money(netPayable)} value={received} onChange={(e) => setReceived(e.target.value)} className="w-full py-2 pl-6 pr-2 border rounded-lg text-right font-mono text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white" />
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {quickCashOptions(netPayable).map((v, i) => (
                            <button key={v} type="button" data-tender={v} onClick={() => setReceived(i === 0 ? '' : String(v))} className={`px-3 py-2 rounded-lg border text-xs font-semibold tabular-nums cursor-pointer ${(i === 0 && received === '') || received === String(v) ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white dark:bg-gray-700 border-gray-200 dark:border-gray-600 hover:border-emerald-400'}`}>
                              {i === 0 ? 'Exact' : `₹${v.toLocaleString('en-IN')}`}
                            </button>
                          ))}
                        </div>
                        <div id="coChange" data-state={cashInfo.state} className={`flex items-baseline justify-between rounded-lg px-3 py-2 ${cashInfo.state === 'short' ? 'bg-red-100 dark:bg-red-950/40 text-red-800 dark:text-red-200' : cashInfo.state === 'ok' && cashInfo.change > 0 ? 'bg-emerald-600 text-white' : 'bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300'}`}>
                          <span className="text-xs font-semibold">{cashInfo.state === 'short' ? 'Still to collect' : cashInfo.state === 'ok' && cashInfo.change > 0 ? 'Give back' : 'Exact amount'}</span>
                          <span className="font-display font-bold text-xl tabular-nums">{cashInfo.state === 'short' ? `₹${money(cashInfo.short)}` : cashInfo.state === 'ok' && cashInfo.change > 0 ? `₹${money(cashInfo.change)}` : '—'}</span>
                        </div>
                      </div>
                    )}

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
                      <button type="submit" id="coConfirm" disabled={checkoutBusy || (checkout.paymentMode === 'CASH' && tender(netPayable, received).state === 'short')} className="px-4 py-2 bg-emerald-600 text-white rounded text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50">
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
                  {checkoutDone.change !== undefined && checkoutDone.change > 0 && (
                    <div id="coChangeDone" className="rounded-xl bg-emerald-600 text-white py-3">
                      <div className="text-xs font-semibold opacity-90">Received ₹{money(checkoutDone.received ?? 0)} · give back</div>
                      <div className="font-display font-bold text-3xl tabular-nums">₹{money(checkoutDone.change)}</div>
                    </div>
                  )}
                  <div className="flex gap-2 justify-center">
                    <button type="button" id="coPrint" onClick={() => printInBrowser('bills', checkoutDone.billId)} className="px-4 py-2 border rounded text-sm hover:bg-gray-100 dark:hover:bg-gray-700">Print bill</button>
                    <button type="button" onClick={() => sendToNetworkPrinter('bills', checkoutDone.billId)} className="px-4 py-2 border rounded text-sm hover:bg-gray-100 dark:hover:bg-gray-700">Send to printer</button>
                    <button type="button" id="coDone" onClick={() => { setActiveModal(null); setSelectedTable(null); setCheckoutDone(null); }} className="px-4 py-2 bg-purple-600 text-white rounded text-sm font-semibold">Done</button>
                  </div>
                </div>
              )}

              {/* Move the party to a free table */}
              {activeModal === 'move' && (
                <div className="space-y-3" id="moveBody">
                  <p className="text-sm text-gray-600 dark:text-gray-300">Pick a free table. Everything {selectedTable?.name} has ordered goes with them, and {selectedTable?.name} becomes free.</p>
                  {tables.filter((t) => t.status === 'FREE').length === 0 ? (
                    <div className="p-4 text-center text-sm text-gray-500 border border-dashed rounded-lg">No free table right now.</div>
                  ) : (
                    <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 max-h-72 overflow-y-auto">
                      {tables.filter((t) => t.status === 'FREE').map((t) => (
                        <button key={t.id} type="button" data-move-to={t.name} disabled={moveBusy} onClick={() => void doMove(t)} className="py-3 rounded-lg border border-gray-200 dark:border-gray-600 hover:border-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20 text-sm font-semibold disabled:opacity-50 cursor-pointer">
                          {t.name}<span className="block text-[10px] font-normal text-gray-500">{t.section || 'General'} · {t.capacity || 4} seats</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="flex justify-end"><button type="button" onClick={() => setActiveModal('actions')} className="px-4 py-2 border rounded text-sm hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer">Back</button></div>
                </div>
              )}

              {/* Merge two occupied tables onto one bill */}
              {activeModal === 'merge' && (
                <div className="space-y-3" id="mergeBody">
                  <p className="text-sm text-gray-600 dark:text-gray-300">Put {selectedTable?.name}&apos;s orders on another occupied table&apos;s bill. {selectedTable?.name} becomes free and the two tables are billed together.</p>
                  {tables.filter((t) => t.status === 'OCCUPIED' && t.id !== selectedTable?.id).length === 0 ? (
                    <div className="p-4 text-center text-sm text-gray-500 border border-dashed rounded-lg">There is no other occupied table to merge with.</div>
                  ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-72 overflow-y-auto">
                      {tables.filter((t) => t.status === 'OCCUPIED' && t.id !== selectedTable?.id).map((t) => (
                        <button key={t.id} type="button" data-merge-into={t.name} disabled={moveBusy} onClick={() => void doMerge(t)} className="py-3 px-2 rounded-lg border border-gray-200 dark:border-gray-600 hover:border-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20 text-sm font-semibold disabled:opacity-50 cursor-pointer">
                          {t.name}<span className="block text-[11px] font-normal text-gray-500 tabular-nums">₹{money(Number(t.sessionTotal ?? 0))} so far</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="flex justify-end"><button type="button" onClick={() => setActiveModal('actions')} className="px-4 py-2 border rounded text-sm hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer">Back</button></div>
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
                const barProducts = products.filter(
                  (p) => p.isAvailable !== false && isBarProduct(p)
                );
                const kitchenProducts = products.filter(
                  (p) => p.isAvailable !== false && isKitchenProduct(p)
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
                      <div className="text-xs font-semibold text-gray-500 mb-2 flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span>{kotDest === 'BAR' ? 'Drinks' : 'Kitchen Items'} ({availableKotProducts.length})</span>
                          {/* Stock Availability Filter for Bar KOT */}
                          {kotDest === 'BAR' && (
                            <div className="inline-flex rounded-lg border dark:border-gray-700 bg-gray-100 dark:bg-gray-750 p-0.5 text-[11px]" id="kotStockFilters">
                              {[
                                { id: 'ALL' as const, label: 'All', count: kotStockCounts.all },
                                { id: 'IN_STOCK' as const, label: 'In Stock', count: kotStockCounts.inStock, dot: 'bg-emerald-500' },
                                { id: 'OUT_OF_STOCK' as const, label: 'Out of Stock', count: kotStockCounts.outOfStock, dot: 'bg-red-500' },
                              ].map((sf) => (
                                <button
                                  key={sf.id}
                                  type="button"
                                  id={`kotStockFilter-${sf.id.toLowerCase()}`}
                                  onClick={() => setKotStockFilter(sf.id)}
                                  className={`px-2 py-0.5 rounded-md font-medium transition-colors cursor-pointer flex items-center gap-1 ${
                                    kotStockFilter === sf.id
                                      ? 'bg-white dark:bg-gray-800 text-purple-700 dark:text-purple-300 font-semibold shadow-xs'
                                      : 'text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200'
                                  }`}
                                >
                                  {sf.dot && <span className={`size-1.5 rounded-full ${sf.dot}`} />}
                                  <span>{sf.label}</span>
                                  <span className="text-[10px] tabular-nums opacity-75 font-normal">({sf.count})</span>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                        <span className="text-[11px] text-gray-400">Click + Add to select</span>
                      </div>
                      {availableKotProducts.length === 0 ? (
                        <div className="p-4 text-center text-xs text-gray-500 bg-gray-50 dark:bg-gray-750 rounded-lg border border-dashed dark:border-gray-700">
                          No items match
                          {kotSearch ? ` "${kotSearch}"` : ''}
                          {kotCategoryFilter !== 'ALL' ? ` in ${kotCategoryFilter.toLowerCase()}` : ''}
                          {kotStockFilter !== 'ALL' ? ` (${kotStockFilter === 'IN_STOCK' ? 'in stock' : 'out of stock'})` : ''}.
                          {(kotSearch || kotCategoryFilter !== 'ALL' || kotStockFilter !== 'ALL') && (
                            <button
                              type="button"
                              onClick={() => {
                                setKotSearch('');
                                setKotCategoryFilter('ALL');
                                setKotStockFilter('ALL');
                              }}
                              className="ml-2 text-purple-600 dark:text-purple-400 hover:underline font-semibold cursor-pointer"
                            >
                              Reset filters
                            </button>
                          )}
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
                          onClick={() => {
                            const defaultProd =
                              (kotDest === 'BAR' ? barProducts[0] : kitchenProducts[0]) ||
                              barProducts[0] ||
                              kitchenProducts[0] ||
                              products[0];
                            if (defaultProd) {
                              setKotItems((prev) => [
                                ...prev,
                                { productId: defaultProd.id, quantity: 1 },
                              ]);
                            }
                          }}
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
                            const isKitchen = prod ? isKitchenProduct(prod) : false;
                            const hasServings = (prod?.servings ?? []).length > 0;

                            return (
                              <div
                                key={idx}
                                className="kot-line p-2.5 bg-white dark:bg-gray-750 border dark:border-gray-700 rounded-lg flex flex-wrap sm:flex-nowrap items-center gap-2"
                              >
                                <span
                                  className={`px-2 py-1 rounded text-[10px] font-bold shrink-0 flex items-center gap-1 ${
                                    isKitchen
                                      ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300'
                                      : 'bg-purple-100 text-purple-800 dark:bg-purple-950/60 dark:text-purple-300'
                                  }`}
                                  title={isKitchen ? 'Routed to Kitchen' : 'Routed to Bar'}
                                >
                                  <span>{isKitchen ? '🍽️' : '🍸'}</span>
                                  <span>{isKitchen ? 'Kitchen' : 'Bar'}</span>
                                </span>

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
                                  <optgroup label="Bar (Drinks & Liquor)">
                                    {barProducts.map((p) => {
                                      const sQty = p.currentStock ?? p.stockQuantity ?? 0;
                                      const isTrk = p.trackStock !== false;
                                      const sLabel = isTrk
                                        ? sQty <= 0
                                          ? ' [Out of Stock]'
                                          : ` [Stock: ${sQty} btl${p.openMl ? `, ${p.openMl}ml open` : ''}]`
                                        : '';
                                      return (
                                        <option key={p.id} value={p.id}>
                                          🍸 {p.name} {p.mrp ? `(₹${parseFloat(p.mrp)})` : ''}{sLabel}
                                        </option>
                                      );
                                    })}
                                  </optgroup>
                                  <optgroup label="Kitchen (Food & Snacks)">
                                    {kitchenProducts.map((p) => (
                                      <option key={p.id} value={p.id}>
                                        🍽️ {p.name} {p.mrp ? `(₹${parseFloat(p.mrp)})` : ''} [Kitchen]
                                      </option>
                                    ))}
                                  </optgroup>
                                  {prod && !barProducts.some((p) => p.id === prod.id) && !kitchenProducts.some((p) => p.id === prod.id) && (
                                    <option key={prod.id} value={prod.id}>
                                      {prod.name} {prod.mrp ? `(₹${parseFloat(prod.mrp)})` : ''}
                                    </option>
                                  )}
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
                    <div className="flex flex-wrap justify-between items-center gap-2 pt-2 border-t dark:border-gray-700">
                      <div className="text-xs text-gray-500 space-y-0.5">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span>
                            Items: <strong className="text-gray-800 dark:text-gray-100">{kotItems.reduce((sum, i) => sum + (i.productId ? i.quantity : 0), 0)} qty</strong>
                          </span>
                          {(() => {
                            const barCount = kotItems.filter((i) => {
                              const p = products.find((prod) => prod.id === i.productId);
                              return p && isBarProduct(p);
                            }).reduce((sum, i) => sum + i.quantity, 0);
                            const kitchenCount = kotItems.filter((i) => {
                              const p = products.find((prod) => prod.id === i.productId);
                              return p && isKitchenProduct(p);
                            }).reduce((sum, i) => sum + i.quantity, 0);

                            if (barCount > 0 && kitchenCount > 0) {
                              return (
                                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300 font-semibold text-[11px]">
                                  <span>🍸 {barCount} Bar</span>
                                  <span>+</span>
                                  <span>🍽️ {kitchenCount} Kitchen</span>
                                </span>
                              );
                            }
                            return null;
                          })()}
                        </div>
                        <div className="text-sm font-bold text-purple-700 dark:text-purple-300 font-mono">
                          Estimated Total: ₹{money(kotEstimatedTotal)}
                        </div>
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
                          <span>✓</span> {kotSubmitting ? 'Submitting KOT...' : `Submit KOT (${kotItems.reduce((sum, i) => sum + (i.productId ? i.quantity : 0), 0)} items · ₹${money(kotEstimatedTotal)})`}
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
      {/* Bill Receipt Details Modal */}
      {selectedBillForModal && (
        <div className="fixed inset-0 z-50 bg-black/55 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-gray-800 rounded-2xl max-w-md w-full shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden flex flex-col max-h-[90vh]">
            <div className="p-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
              <div>
                <h3 className="font-bold text-base">Receipt · {selectedBillForModal.billNumber}</h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  {selectedBillForModal.tableName} {selectedBillForModal.section ? `(${selectedBillForModal.section})` : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedBillForModal(null)}
                className="p-1 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>
            <div className="p-4 overflow-y-auto space-y-4 text-sm">
              <div className="flex justify-between text-xs text-gray-500">
                <span>Steward: {selectedBillForModal.stewardName || '—'}</span>
                <span>{selectedBillForModal.createdAt ? new Date(selectedBillForModal.createdAt).toLocaleString('en-IN') : ''}</span>
              </div>
              <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 dark:bg-gray-700/50 text-gray-500">
                    <tr>
                      <th className="p-2 text-left">Item</th>
                      <th className="p-2 text-center">Qty</th>
                      <th className="p-2 text-right">Price</th>
                      <th className="p-2 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                    {selectedBillForModal.items.map((it, idx) => (
                      <tr key={idx}>
                        <td className="p-2">
                          <div className="font-semibold">{it.productName}</div>
                          {it.servingLabel && <div className="text-[10px] text-gray-400">{it.servingLabel}</div>}
                        </td>
                        <td className="p-2 text-center">{it.quantity}</td>
                        <td className="p-2 text-right tabular-nums">₹{money(it.unitPrice)}</td>
                        <td className="p-2 text-right font-semibold tabular-nums">₹{money(it.lineTotal)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="space-y-1.5 text-xs border-t border-gray-200 dark:border-gray-700 pt-3">
                <div className="flex justify-between text-gray-500">
                  <span>Subtotal</span>
                  <span className="tabular-nums">₹{money(selectedBillForModal.subtotal)}</span>
                </div>
                {Number(selectedBillForModal.discount || 0) > 0 && (
                  <div className="flex justify-between text-emerald-600">
                    <span>Discount</span>
                    <span className="tabular-nums">-₹{money(selectedBillForModal.discount)}</span>
                  </div>
                )}
                <div className="flex justify-between text-gray-500">
                  <span>Tax (included in MRP)</span>
                  <span className="tabular-nums">₹{money(selectedBillForModal.taxAmount)}</span>
                </div>
                <div className="flex justify-between text-base font-bold text-gray-900 dark:text-gray-100 border-t border-gray-200 dark:border-gray-700 pt-2">
                  <span>Grand Total</span>
                  <span className="tabular-nums">₹{money(selectedBillForModal.total)}</span>
                </div>
                <div className="flex justify-between text-xs font-semibold text-purple-600 pt-1">
                  <span>Payment Mode</span>
                  <span className="uppercase">{selectedBillForModal.paymentMode}</span>
                </div>
              </div>
            </div>
            <div className="p-3 bg-gray-50 dark:bg-gray-750 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => printInBrowser('bills', selectedBillForModal.id)}
                className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-xs font-medium hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-1.5 cursor-pointer"
              >
                <Printer size={13} /> Print Bill
              </button>
              <button
                type="button"
                onClick={() => setSelectedBillForModal(null)}
                className="px-3 py-1.5 rounded-lg bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900 text-xs font-semibold hover:opacity-90 cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

