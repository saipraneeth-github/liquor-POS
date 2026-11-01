import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, Plus, Minus, Trash2, RefreshCw } from 'lucide-react';
import {
  getCategoryInfo,
  CategoryIcon,
  classifyProductCategory,
  CATEGORY_DEFINITIONS,
  type LiquorCategoryKey,
} from '../components/category-icons';
import { useAuth } from '../auth/AuthProvider';
import { printInBrowser, sendToNetworkPrinter, showToast } from '../lib/print';

type Serving = { id: string; label: string; volumeMl: number | null; price: string };

type Product = {
  id: string;
  name: string;
  brand: string;
  mrp: string;          // decimal string e.g. "1050.00"
  barcode: string;
  categoryId: string;
  categoryName?: string;
  isAvailable?: boolean;
  trackStock?: boolean;
  currentStock?: number | null;
  stockQuantity?: number | null;
  openMl?: number | null;
  reorderLevel?: number | null;
  menuType?: 'RETAIL' | 'KITCHEN' | 'BAR';
  servings?: Serving[]; // peg / glass / bottle rates (bar items)
};

type CartItem = Product & { qty: number; servingId?: string; servingLabel?: string; price: string };

const cartKey = (c: { id: string; servingId?: string }) => c.id + '|' + (c.servingId ?? '');

type QueuedBill = {
  clientRef: string;
  ownerSub: string;
  queuedAt: string;
  body: {
    branchId: string;
    items: { productId: string; servingId?: string; quantity: number }[];
    customerGstin?: string;
    customerId?: string;
    paymentMode: 'CASH' | 'CARD' | 'UPI' | 'CREDIT';
    discount: string;
    clientRef: string;
  };
};

type KhataCustomer = {
  id: string;
  name: string;
  phone: string;
  creditAllowed: boolean;
  isActive: boolean;
  creditLimit: string;
  currentCredit: string;
};

function queueKey(sub: string) { return `lc_offline_bills:${sub}`; }
function getQueue(sub: string): QueuedBill[] {
  try { return JSON.parse(localStorage.getItem(queueKey(sub)) || '[]'); } catch { return []; }
}
function saveQueue(sub: string, q: QueuedBill[]) {
  localStorage.setItem(queueKey(sub), JSON.stringify(q));
}

function genUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function POS() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<LiquorCategoryKey>('ALL');
  const [products, setProducts] = useState<Product[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [queuedCount, setQueuedCount] = useState(0);
  const [lastSync, setLastSync] = useState('');
  const [servingPicker, setServingPicker] = useState<Product | null>(null);
  const [buyerGstin, setBuyerGstin] = useState('');
  const [paymentMode, setPaymentMode] = useState<'CASH' | 'CARD' | 'UPI' | 'CREDIT'>('CASH');
  const [discountPercent, setDiscountPercent] = useState('');
  const [creditQuery, setCreditQuery] = useState('');
  const [creditResults, setCreditResults] = useState<KhataCustomer[]>([]);
  const [creditCustomer, setCreditCustomer] = useState<KhataCustomer | null>(null);
  const [loadingCredit, setLoadingCredit] = useState(false);
  const [showAddCustomer, setShowAddCustomer] = useState(false);
  const [newCustName, setNewCustName] = useState('');
  const [newCustPhone, setNewCustPhone] = useState('');
  const [newCustLimit, setNewCustLimit] = useState('5000');
  const [newCustAllow, setNewCustAllow] = useState(true);
  const [creatingCust, setCreatingCust] = useState(false);
  const [checkoutModal, setCheckoutModal] = useState<{
    title: string;
    billId?: string;
    billNumber: string;
    total: string;
    paymentMode: string;
    customerName?: string;
    offline: boolean;
  } | null>(null);

  const sub = (user as any)?.sub ?? user?.id ?? '';
  const branchId = (user as any)?.branchId ?? '';

  const refreshQueueCount = useCallback(() => {
    setQueuedCount(getQueue(sub).length);
  }, [sub]);

  // Expose helpers for E2E tests (offline-billing.spec.ts)
  useEffect(() => {
    (window as any).queueKey = () => queueKey(sub);
    (window as any).renderOffline = refreshQueueCount;
  }, [sub, refreshQueueCount]);

  // Load products (with branch-specific stock levels)
  const loadProducts = useCallback(async () => {
    if (!user) return;
    const url = branchId ? `/api/v1/products?branchId=${branchId}` : '/api/v1/products';
    setLoadingProducts(true);
    try {
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
      });
      if (r.ok) {
        const data = await r.json();
        setProducts(data || []);
      }
    } catch {
      /* offline — products not available */
    } finally {
      setLoadingProducts(false);
    }
  }, [user, branchId]);

  useEffect(() => {
    loadProducts();
  }, [loadProducts]);

  // Listen to global stock updates (e.g. from table billing, invoice inward, or counter sheets)
  useEffect(() => {
    const handleStockUpdate = () => {
      loadProducts();
    };
    window.addEventListener('app:stock_updated', handleStockUpdate);
    return () => window.removeEventListener('app:stock_updated', handleStockUpdate);
  }, [loadProducts]);

  // Restore last sync label from localStorage
  useEffect(() => {
    if (!sub) return;
    refreshQueueCount();
    const stored = localStorage.getItem(`lc_last_sync:${sub}`);
    if (stored) {
      try {
        const d = JSON.parse(stored);
        const dup = d.replay ? ' - duplicate submission ignored' : '';
        setLastSync(`Last offline sync: ${d.billNumber} (₹${parseFloat(d.total).toLocaleString('en-IN', { minimumFractionDigits: 2 })})${dup}`);
      } catch { /* ignore */ }
    }
  }, [sub, refreshQueueCount]);

  const syncQueue = useCallback(async () => {
    if (!sub || !branchId) return;
    const q = getQueue(sub);
    if (!q.length) { refreshQueueCount(); return; }
    for (const item of [...q]) {
      if (item.ownerSub !== sub) continue;
      try {
        const res = await fetch('/api/v1/bills', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${localStorage.getItem('token')}`,
          },
          body: JSON.stringify(item.body),
        });
        const data = await res.json();
        // Remove from queue whether 201 (new) or 200 (idempotent replay)
        saveQueue(sub, getQueue(sub).filter((x) => x.clientRef !== item.clientRef));
        const isReplay = res.status === 200;
        const syncRecord = {
          billNumber: data.billNumber,
          total: data.total,
          at: new Date().toISOString(),
          replay: isReplay,
        };
        localStorage.setItem(`lc_last_sync:${sub}`, JSON.stringify(syncRecord));
        const dup = isReplay ? ' - duplicate submission ignored' : '';
        setLastSync(`Last offline sync: ${data.billNumber} (₹${parseFloat(data.total).toLocaleString('en-IN', { minimumFractionDigits: 2 })})${dup}`);
      } catch {
        break; // network still down
      }
    }
    refreshQueueCount();
    loadProducts();
  }, [sub, branchId, refreshQueueCount, loadProducts]);

  // Online/offline event listeners + periodic auto-sync
  useEffect(() => {
    const goOnline = () => { setIsOnline(true); syncQueue(); };
    const goOffline = () => setIsOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    const interval = setInterval(() => { if (navigator.onLine) syncQueue(); }, 30000);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      clearInterval(interval);
    };
  }, [syncQueue]);

  const categoriesList = useMemo(() => {
    const counts: Record<LiquorCategoryKey, number> = {
      ALL: products.length,
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

    for (const p of products) {
      const k = classifyProductCategory(p);
      counts[k] = (counts[k] || 0) + 1;
    }

    return CATEGORY_DEFINITIONS.map((def) => ({
      ...def,
      count: counts[def.id] || 0,
    })).filter((def) => def.id === 'ALL' || def.count > 0);
  }, [products]);

  const filteredProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      const matchesSearch =
        !q ||
        p.name.toLowerCase().includes(q) ||
        (p.brand ?? '').toLowerCase().includes(q) ||
        (p.barcode ?? '').toLowerCase().includes(q) ||
        (p.categoryName ?? '').toLowerCase().includes(q);

      if (!matchesSearch) return false;

      if (selectedCategory === 'ALL') return true;
      const catKey = classifyProductCategory(p);
      return catKey === selectedCategory;
    });
  }, [products, search, selectedCategory]);

  const addToCart = (product: Product, serving?: Serving) => {
    const line: CartItem = {
      ...product,
      qty: 1,
      price: serving?.price ?? product.mrp,
      servingId: serving?.id,
      servingLabel: serving?.label,
    };
    setCart((prev) => {
      const existing = prev.find((item) => cartKey(item) === cartKey(line));
      if (existing) return prev.map((item) => cartKey(item) === cartKey(line) ? { ...item, qty: item.qty + 1 } : item);
      return [...prev, line];
    });
  };

  const pickProduct = (product: Product) => {
    if (product.isAvailable === false) return;
    if (product.servings && product.servings.length > 0) setServingPicker(product);
    else addToCart(product);
  };

  const updateCartQty = (key: string, delta: number) => {
    setCart((prev) =>
      prev
        .map((item) => (cartKey(item) === key ? { ...item, qty: item.qty + delta } : item))
        .filter((item) => item.qty > 0)
    );
  };

  const loadCustomers = useCallback((q?: string) => {
    if (!branchId) return;
    setLoadingCredit(true);
    const searchParam = q?.trim() ? `?search=${encodeURIComponent(q.trim())}&limit=25` : '?limit=25';
    fetch(`/api/v1/customers/${branchId}${searchParam}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
    })
      .then((r) => (r.ok ? r.json() : { customers: [] }))
      .then((d) => setCreditResults(d.customers || []))
      .catch(() => setCreditResults([]))
      .finally(() => setLoadingCredit(false));
  }, [branchId]);

  useEffect(() => {
    if (paymentMode !== 'CREDIT' || !branchId) {
      setCreditResults([]);
      return;
    }
    const timer = setTimeout(() => {
      loadCustomers(creditQuery);
    }, creditQuery.trim() ? 250 : 0);
    return () => clearTimeout(timer);
  }, [paymentMode, branchId, creditQuery, loadCustomers]);

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
      const res = await fetch(`/api/v1/customers/${branchId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('token')}`,
        },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to create customer');
      }
      showToast(`Customer created: ${data.customer.name}`, 'success');
      setCreditCustomer(data.customer);
      setShowAddCustomer(false);
      setNewCustName('');
      setNewCustPhone('');
      setNewCustLimit('5000');
      setNewCustAllow(true);
      loadCustomers();
    } catch (err: any) {
      showToast(err.message || 'Could not create customer', 'error');
    } finally {
      setCreatingCust(false);
    }
  };

  const cartSubtotal = cart.reduce((sum, item) => sum + parseFloat(item.price) * item.qty, 0);
  const discountPctNum = Math.max(0, Math.min(100, parseFloat(discountPercent) || 0));
  const discountVal = (cartSubtotal * discountPctNum) / 100;
  const cartTotal = Math.max(0, cartSubtotal - discountVal);

  const checkout = async () => {
    if (paymentMode === 'CREDIT') {
      if (!creditCustomer) {
        showToast('Pick a khata customer for a credit sale.', 'error');
        return;
      }
      if (!creditCustomer.creditAllowed || !creditCustomer.isActive) {
        showToast('Credit is not allowed for this customer.', 'error');
        return;
      }
      const limit = parseFloat(creditCustomer.creditLimit || '0');
      const used = parseFloat(creditCustomer.currentCredit || '0');
      if (limit > 0 && (used + cartTotal) > limit) {
        const rem = Math.max(0, limit - used);
        showToast(`Cannot proceed: Bill (₹${cartTotal.toFixed(2)}) exceeds customer's remaining credit (₹${rem.toFixed(2)}).`, 'error');
        return;
      }
    }
    const clientRef = genUUID();
    const body: QueuedBill['body'] = {
      branchId,
      items: cart.map((c) => ({ productId: c.id, ...(c.servingId ? { servingId: c.servingId } : {}), quantity: c.qty })),
      paymentMode,
      discount: discountVal.toFixed(2),
      clientRef,
      ...(paymentMode === 'CREDIT' && creditCustomer ? { customerId: creditCustomer.id } : {}),
      ...(buyerGstin.trim() ? { customerGstin: buyerGstin.trim().toUpperCase() } : {}),
    };

    try {
      const res = await fetch('/api/v1/bills', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('token')}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok && res.status !== 200) {
        const errJson = await res.json().catch(() => null);
        const errMsg = errJson?.error || errJson?.message || 'Checkout failed';
        showToast(errMsg, 'error');
        return;
      }
      const data = await res.json();
      const custName = creditCustomer?.name;
      setCart([]);
      setBuyerGstin('');
      setDiscountPercent('');
      setCreditCustomer(null);
      setCreditQuery('');
      setCheckoutModal({
        title: 'Bill Generated',
        billId: data.id,
        billNumber: data.billNumber,
        total: data.total,
        paymentMode,
        customerName: custName,
        offline: false,
      });
      // Best effort: kick the receipt out to the branch's network printer if one is set up
      fetch('/api/v1/print/bills/' + data.id + '/send?queue=true', {
        method: 'POST',
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
      }).catch(() => { /* no printer reachable — the Print button still works */ });
      // Immediately refresh live stock on the POS screen and notify any other tabs/screens
      loadProducts();
      window.dispatchEvent(new CustomEvent('app:stock_updated', { detail: { branchId } }));
    } catch {
      // Queue for offline sync
      const queued: QueuedBill = { clientRef, ownerSub: sub, queuedAt: new Date().toISOString(), body };
      saveQueue(sub, [...getQueue(sub), queued]);
      refreshQueueCount();
      setCart([]);
      setCheckoutModal({
        title: 'Saved offline',
        billNumber: clientRef.slice(0, 8),
        total: cartTotal.toFixed(2),
        paymentMode,
        offline: true,
      });
    }
  };

  const closeCheckoutModal = () => {
    setCheckoutModal(null);
    loadProducts();
  };

  const offlineVisible = !isOnline || queuedCount > 0;

  return (
    <div className="flex h-full gap-4" id="page-pos">
      {/* Offline / queue indicator */}
      <div
        id="offlineIndicator"
        style={{
          display: offlineVisible ? 'block' : 'none',
          position: 'fixed', top: 16, right: 16, zIndex: 100,
          padding: '4px 12px', borderRadius: 20,
          background: '#ef4444', color: '#fff', fontSize: 12, fontWeight: 700,
        }}
      >
        {!isOnline ? 'Offline' : 'Online'}
        {queuedCount > 0 ? ` · ${queuedCount} bill${queuedCount > 1 ? 's' : ''} queued` : ''}
      </div>

      {/* Product search + catalog */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex items-center gap-2 mb-4">
          <input
            id="posSearch"
            type="search"
            placeholder="Search products..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 p-2 border rounded dark:bg-gray-700 dark:border-gray-600"
          />
          <button
            type="button"
            id="refreshStockBtn"
            title="Refresh stock and catalog"
            aria-label="Refresh stock"
            onClick={() => loadProducts()}
            disabled={loadingProducts}
            className="p-2 border rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 transition-colors flex items-center justify-center shrink-0 disabled:opacity-50"
          >
            <RefreshCw size={18} className={loadingProducts ? 'animate-spin' : ''} />
          </button>
        </div>

        {/* Category Filter Pills (Whisky, Scotch, Beer, Wine, Vodka, Rum, etc.) */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-2 mb-3 shrink-0" id="posCategoryFilters">
          {categoriesList.map((cat) => (
            <button
              key={cat.id}
              type="button"
              id={`catFilter-${cat.id.toLowerCase()}`}
              onClick={() => setSelectedCategory(cat.id)}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition-all flex items-center gap-1.5 border cursor-pointer ${
                selectedCategory === cat.id
                  ? 'bg-purple-600 text-white border-purple-600 shadow-sm'
                  : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700'
              }`}
            >
              <span>{cat.emoji}</span>
              <span>{cat.label}</span>
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${
                  selectedCategory === cat.id
                    ? 'bg-purple-700 text-white'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300'
                }`}
              >
                {cat.count}
              </span>
            </button>
          ))}
          {selectedCategory !== 'ALL' && (
            <button
              type="button"
              onClick={() => setSelectedCategory('ALL')}
              className="text-xs text-purple-600 dark:text-purple-400 hover:underline px-2 py-1 whitespace-nowrap font-medium cursor-pointer"
            >
              Clear filter
            </button>
          )}
        </div>

        {filteredProducts.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-gray-500 bg-white dark:bg-gray-800 rounded-lg border border-dashed border-gray-300 dark:border-gray-700">
            <span className="text-3xl mb-2">🍹</span>
            <p className="font-semibold text-gray-700 dark:text-gray-200">No products found</p>
            <p className="text-xs mt-1">
              {search ? `No items matching "${search}"` : ''}
              {selectedCategory !== 'ALL' ? ` in ${selectedCategory.toLowerCase()}` : ''}
            </p>
            {(search || selectedCategory !== 'ALL') && (
              <button
                type="button"
                onClick={() => {
                  setSearch('');
                  setSelectedCategory('ALL');
                }}
                className="mt-3 px-3 py-1.5 text-xs bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-300 rounded font-medium hover:bg-purple-200 cursor-pointer"
              >
                Reset filters
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 overflow-y-auto" id="posCatalog">
          {filteredProducts.map((p) => {
            const stockQty = p.currentStock ?? p.stockQuantity ?? 0;
            const isTracked = p.trackStock !== false;
            const isOut = isTracked && stockQty <= 0;
            const isLow = isTracked && !isOut && stockQty <= (p.reorderLevel ?? 5);

            return (
              <button
                key={p.id}
                className={`pos-product p-3.5 bg-white dark:bg-gray-800 rounded-lg shadow hover:shadow-md transition text-center flex flex-col items-center justify-between min-h-[145px] border border-transparent hover:border-purple-300 dark:hover:border-purple-600 ${
                  p.isAvailable === false || isOut ? 'opacity-60 bg-gray-50 dark:bg-gray-800/60' : ''
                }`}
                onClick={() => pickProduct(p)}
                disabled={p.isAvailable === false}
              >
                <div className="w-full flex items-center justify-between text-xs mb-1">
                  <div className="flex items-center gap-1">
                    <CategoryIcon categoryName={(p as any).categoryName} productName={p.name} size={18} />
                    <span>{getCategoryInfo((p as any).categoryName, p.name).emoji}</span>
                  </div>
                  {/* Stock Badge */}
                  {isTracked ? (
                    isOut ? (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300">
                        Out of stock
                      </span>
                    ) : isLow ? (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300">
                        Low: {stockQty} btl
                      </span>
                    ) : (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300">
                        Stock: {stockQty}
                      </span>
                    )
                  ) : (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-300">
                      Kitchen
                    </span>
                  )}
                </div>

                <div className="w-full my-auto py-1">
                  <div className="font-semibold text-sm truncate" title={p.name}>{p.name}</div>
                  <div className="text-xs text-gray-500 truncate">{p.brand}</div>
                </div>

                <div className="w-full pt-1.5 border-t dark:border-gray-700/60 flex items-center justify-between text-xs">
                  <span className="font-bold font-mono text-purple-600 dark:text-purple-400">
                    {p.servings && p.servings.length > 0
                      ? 'From ₹' + Math.min(...p.servings.map((s) => parseFloat(s.price))).toLocaleString('en-IN')
                      : '₹' + parseFloat(p.mrp).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </span>
                  {isTracked && p.openMl ? (
                    <span className="text-[10px] text-blue-600 dark:text-blue-400 font-mono" title="Peg ml open in current bottle">
                      💧{p.openMl}ml
                    </span>
                  ) : null}
                </div>
              </button>
            );
          })}
          </div>
        )}
      </div>

      {/* Cart + checkout */}
      <div className="w-80 bg-white dark:bg-gray-800 rounded shadow flex flex-col">
        <div className="p-4 font-bold border-b dark:border-gray-700 flex items-center justify-between">
          <span>Current Order</span>
          {cart.length > 0 && (
            <button
              type="button"
              onClick={() => setCart([])}
              className="text-xs font-medium text-gray-500 hover:text-red-600 cursor-pointer"
            >
              Clear
            </button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-2" id="cartItems">
          {cart.map((item) => (
            <div key={cartKey(item)} className="flex justify-between items-center gap-1.5 text-sm border-b pb-2 dark:border-gray-700 cart-line">
              <span className="truncate flex-1" title={item.name}>
                {item.name}
                {item.servingLabel && <span className="text-xs text-gray-500"> · {item.servingLabel}</span>}
              </span>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  aria-label="Decrease quantity"
                  onClick={() => updateCartQty(cartKey(item), -1)}
                  className="p-0.5 rounded border hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer"
                >
                  {item.qty === 1 ? <Trash2 size={12} /> : <Minus size={12} />}
                </button>
                <span className="w-7 text-center font-mono text-xs">x{item.qty}</span>
                <button
                  type="button"
                  aria-label="Increase quantity"
                  onClick={() => updateCartQty(cartKey(item), 1)}
                  className="p-0.5 rounded border hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer"
                >
                  <Plus size={12} />
                </button>
              </div>
              <span className="w-16 text-right font-mono text-xs shrink-0">
                ₹{(parseFloat(item.price) * item.qty).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
              </span>
            </div>
          ))}
        </div>
        <div className="p-4 border-t dark:border-gray-700 space-y-2.5">
          {/* Subtotal row */}
          <div className="flex justify-between text-xs text-gray-500">
            <span>Subtotal</span>
            <span className="font-mono">₹{cartSubtotal.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          </div>

          {/* Discount Percentage Input & Live Value */}
          <div className="space-y-1.5 bg-gray-50 dark:bg-gray-750 p-2 rounded-lg border dark:border-gray-700">
            <div className="flex items-center justify-between text-xs">
              <label htmlFor="discountInput" className="font-semibold text-gray-600 dark:text-gray-300">
                Discount (%)
              </label>
              <div className="relative w-24">
                <input
                  id="discountInput"
                  type="number"
                  step="any"
                  min="0"
                  max="100"
                  className="w-full p-1 pr-6 border rounded text-right font-mono text-xs dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                  placeholder="0"
                  value={discountPercent}
                  onChange={(e) => setDiscountPercent(e.target.value)}
                />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 font-bold text-xs pointer-events-none">%</span>
              </div>
            </div>

            {/* Quick percentage chips */}
            <div className="flex items-center gap-1 flex-wrap">
              <span className="text-[10px] text-gray-400 font-medium">Quick %:</span>
              {[5, 10, 15, 20].map((pct) => (
                <button
                  key={pct}
                  type="button"
                  onClick={() => setDiscountPercent(String(pct))}
                  className={`px-1.5 py-0.5 rounded text-[11px] font-semibold transition-colors cursor-pointer border ${
                    discountPercent === String(pct)
                      ? 'bg-purple-600 text-white border-purple-600 shadow-xs'
                      : 'bg-white hover:bg-gray-100 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 border-gray-200 dark:border-gray-600'
                  }`}
                >
                  {pct}%
                </button>
              ))}
              {discountPercent && (
                <button
                  type="button"
                  onClick={() => setDiscountPercent('')}
                  className="px-1.5 py-0.5 text-[11px] text-gray-400 hover:text-red-500 hover:underline cursor-pointer ml-auto"
                >
                  Clear
                </button>
              )}
            </div>

            {/* Live Discount Rupee Value */}
            <div className="flex justify-between items-center text-xs pt-1 border-t dark:border-gray-700/60">
              <span className="text-gray-500">Discount Amount:</span>
              <span className="font-mono font-bold text-emerald-600 dark:text-emerald-400">
                -₹{discountVal.toFixed(2)} {discountPctNum > 0 ? `(${discountPctNum}%)` : ''}
              </span>
            </div>
          </div>

          <div className="flex justify-between font-bold text-base">
            <span>Total</span>
            <span className="font-mono text-purple-700 dark:text-purple-300">
              ₹{cartTotal.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>
          <div className="grid grid-cols-4 gap-1" role="group" aria-label="Payment mode">
            {(['CASH', 'CARD', 'UPI', 'CREDIT'] as const).map((m) => (
              <button
                key={m}
                type="button"
                id={`pay-${m}`}
                aria-pressed={paymentMode === m}
                onClick={() => setPaymentMode(m)}
                className={`py-1.5 px-1 text-xs font-semibold rounded border cursor-pointer transition-colors ${
                  paymentMode === m
                    ? 'bg-purple-600 text-white border-purple-600'
                    : 'bg-gray-50 dark:bg-gray-700/60 hover:bg-gray-100 dark:hover:bg-gray-700'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
          {paymentMode === 'CREDIT' && (
            <div id="creditBox" className="space-y-2 text-xs bg-amber-50/50 dark:bg-amber-950/20 p-2.5 rounded-lg border border-amber-200 dark:border-amber-800">
              <div className="flex justify-between items-center">
                <span className="font-semibold text-amber-900 dark:text-amber-200 flex items-center gap-1">
                  <span>📖</span> Khata / Customer Credit
                </span>
                {!showAddCustomer && (
                  <button
                    type="button"
                    id="btnQuickAddCust"
                    onClick={() => setShowAddCustomer(true)}
                    className="text-[11px] font-semibold text-purple-600 dark:text-purple-400 hover:underline cursor-pointer flex items-center gap-0.5"
                  >
                    <span>+</span> Add Customer
                  </button>
                )}
              </div>

              {/* Inline Quick Add Customer Form */}
              {showAddCustomer && (
                <form onSubmit={handleCreateCustomer} className="p-2 bg-white dark:bg-gray-800 rounded border border-purple-200 dark:border-purple-800 space-y-2">
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
                    <label htmlFor="newCustName" className="block text-[10px] text-gray-500 font-semibold mb-0.5">Customer Name *</label>
                    <input
                      id="newCustName"
                      required
                      placeholder="e.g. Ramesh Reddy"
                      value={newCustName}
                      onChange={(e) => setNewCustName(e.target.value)}
                      className="w-full p-1.5 border rounded text-xs dark:bg-gray-700 dark:border-gray-600"
                    />
                  </div>
                  <div>
                    <label htmlFor="newCustPhone" className="block text-[10px] text-gray-500 font-semibold mb-0.5">Mobile Phone (10 digits) *</label>
                    <input
                      id="newCustPhone"
                      required
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
                        <label htmlFor="newCustLimit" className="block text-[10px] text-gray-500 font-semibold mb-0.5">Credit Limit (₹)</label>
                        <input
                          id="newCustLimit"
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
                          id="newCustAllow"
                          type="checkbox"
                          checked={newCustAllow}
                          onChange={(e) => setNewCustAllow(e.target.checked)}
                          className="rounded text-purple-600"
                        />
                        <label htmlFor="newCustAllow" className="text-[11px] font-semibold text-gray-700 dark:text-gray-300 cursor-pointer">
                          Allow Credit
                        </label>
                      </div>
                    </div>
                  ) : (
                    <div className="text-[10px] text-gray-500 bg-gray-50 dark:bg-gray-700 p-1.5 rounded">
                      ℹ️ Profile registered by cashier. Setting credit limit requires Manager authorization.
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
                      type="submit"
                      id="newCustSubmit"
                      disabled={creatingCust}
                      className="px-2.5 py-1 text-xs bg-purple-600 text-white rounded font-semibold hover:bg-purple-700 disabled:opacity-50 cursor-pointer"
                    >
                      {creatingCust ? 'Saving...' : 'Save & Select'}
                    </button>
                  </div>
                </form>
              )}

              {/* Customer selection */}
              {!creditCustomer ? (
                <div className="space-y-1.5">
                  <div className="relative">
                    <input
                      id="creditSearch"
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
                    <div id="creditResults" className="max-h-36 overflow-y-auto border rounded divide-y dark:border-gray-700 dark:divide-gray-700 bg-white dark:bg-gray-800">
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
                <div id="creditCustomerCard" className="p-2.5 border rounded bg-white dark:bg-gray-800 space-y-1.5 shadow-xs">
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
                    const projected = used + cartTotal;
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
                            <span id="creditRemaining" className="font-mono font-bold text-emerald-600 dark:text-emerald-400">₹{rem.toFixed(2)}</span>
                          </div>
                        </div>

                        {exceeds && (
                          <div className="p-1.5 rounded bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-[11px] font-semibold flex items-center gap-1">
                            <span>⚠️</span> Exceeds credit limit by ₹{(projected - limit).toFixed(2)}
                          </div>
                        )}
                        {!creditCustomer.creditAllowed && (
                          <div className="p-1.5 rounded bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-[11px] font-semibold flex items-center gap-1">
                            <span>⚠️</span> Credit is disabled for this customer!
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          )}
          {/* lastSync shown inline for E2E assertions */}
          <input
            id="posBuyerGstin"
            className="w-full p-2 border rounded text-xs font-mono dark:bg-gray-700 dark:border-gray-600"
            placeholder="Buyer GSTIN (optional, B2B)"
            maxLength={15}
            value={buyerGstin}
            onChange={(e) => setBuyerGstin(e.target.value)}
          />
          {lastSync && <div id="lastSync" className="text-xs text-gray-500">{lastSync}</div>}
          <button
            id="checkoutBtn"
            onClick={checkout}
            disabled={cart.length === 0}
            className="w-full bg-green-600 text-white p-3 rounded font-bold hover:bg-green-700 disabled:opacity-50 cursor-pointer"
          >
            Checkout &amp; Print
          </button>
        </div>
      </div>

      {/* Serving (peg / glass / bottle) picker */}
      {servingPicker && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" id="servingPicker" onClick={() => setServingPicker(null)}>
          <div className="bg-white dark:bg-gray-800 p-5 rounded shadow-lg max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-2">
              <h2 className="text-lg font-bold">{servingPicker.name}</h2>
              <button
                type="button"
                onClick={() => setServingPicker(null)}
                className="p-1 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                aria-label="Close dialog"
              >
                <X size={18} />
              </button>
            </div>
            <div className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300 mb-3 bg-gray-50 dark:bg-gray-750 p-2 rounded border dark:border-gray-700">
              <span>📦 Sealed Bottles: <strong className="text-gray-900 dark:text-white font-mono">{servingPicker.currentStock ?? servingPicker.stockQuantity ?? 0}</strong></span>
              <span>·</span>
              <span>💧 Open Bottle: <strong className="text-blue-600 dark:text-blue-400 font-mono">{servingPicker.openMl ?? 0} ml</strong></span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {servingPicker.servings!.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="serving-option p-3 border rounded hover:bg-purple-50 dark:hover:bg-purple-900/20 text-center"
                  onClick={() => { addToCart(servingPicker, s); setServingPicker(null); }}
                >
                  <div className="font-semibold">{s.label}</div>
                  <div className="text-sm text-gray-500">₹{parseFloat(s.price).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
                </button>
              ))}
            </div>
            <button type="button" className="mt-3 w-full text-sm text-gray-500" onClick={() => setServingPicker(null)}>Cancel</button>
          </div>
        </div>
      )}

      {/* Post-checkout modal */}
      {checkoutModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" id="checkoutModal">
          <div className="bg-white dark:bg-gray-800 p-6 rounded shadow-lg max-w-sm w-full text-center relative">
            <button
              type="button"
              onClick={closeCheckoutModal}
              className="absolute top-4 right-4 p-1 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              aria-label="Close dialog"
            >
              <X size={18} />
            </button>
            <h2 className="text-xl font-bold mb-2" id="checkoutTitle">{checkoutModal.title}</h2>
            <div className="text-2xl text-purple-600 font-mono mb-4" id="checkoutBillNo">
              {checkoutModal.billNumber}
            </div>
            <div className="text-gray-500 mb-6" id="checkoutSummary">
              {checkoutModal.offline
                ? 'Queued — will sync automatically when back online'
                : `₹${parseFloat(checkoutModal.total).toLocaleString('en-IN', { minimumFractionDigits: 2 })} collected via ${checkoutModal.paymentMode}${checkoutModal.customerName ? ` (${checkoutModal.customerName})` : ''}`}
            </div>
            {!checkoutModal.offline && checkoutModal.billId && (
              <div className="flex gap-2 mb-3">
                <button type="button" id="printBillBtn" onClick={() => printInBrowser('bills', checkoutModal.billId!)} className="flex-1 border p-2 rounded text-sm hover:bg-gray-100 dark:hover:bg-gray-700">
                  Print bill
                </button>
                <button type="button" onClick={() => sendToNetworkPrinter('bills', checkoutModal.billId!)} className="flex-1 border p-2 rounded text-sm hover:bg-gray-100 dark:hover:bg-gray-700">
                  Send to printer
                </button>
              </div>
            )}
            <div className="flex gap-2">
              <button
                id="newBillBtn"
                onClick={closeCheckoutModal}
                className="flex-1 bg-purple-600 text-white p-2 rounded"
              >
                New Bill
              </button>
              {checkoutModal.offline && (
                <button
                  id="checkoutHistoryBtn"
                  onClick={() => {
                    closeCheckoutModal();
                    navigate('/bills');
                  }}
                  className="flex-1 bg-gray-200 text-gray-800 p-2 rounded"
                >
                  View pending
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
