import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, Plus, Minus, Trash2 } from 'lucide-react';
import { getCategoryInfo, CategoryIcon } from '../components/category-icons';
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
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [queuedCount, setQueuedCount] = useState(0);
  const [lastSync, setLastSync] = useState('');
  const [servingPicker, setServingPicker] = useState<Product | null>(null);
  const [buyerGstin, setBuyerGstin] = useState('');
  const [paymentMode, setPaymentMode] = useState<'CASH' | 'CARD' | 'UPI' | 'CREDIT'>('CASH');
  const [discount, setDiscount] = useState('');
  const [creditQuery, setCreditQuery] = useState('');
  const [creditResults, setCreditResults] = useState<KhataCustomer[]>([]);
  const [creditCustomer, setCreditCustomer] = useState<KhataCustomer | null>(null);
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
  useEffect(() => {
    if (!user) return;
    const url = branchId ? `/api/v1/products?branchId=${branchId}` : '/api/v1/products';
    fetch(url, {
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
    })
      .then((r) => r.ok ? r.json() : [])
      .then(setProducts)
      .catch(() => { /* offline — products not available */ });
  }, [user, branchId]);

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
  }, [sub, branchId, refreshQueueCount]);

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

  const filteredProducts = products.filter(
    (p) =>
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      (p.brand ?? '').toLowerCase().includes(search.toLowerCase())
  );

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

  useEffect(() => {
    if (paymentMode !== 'CREDIT' || !branchId || !creditQuery.trim()) {
      setCreditResults([]);
      return;
    }
    const timer = setTimeout(() => {
      fetch(`/api/v1/customers/${branchId}?search=${encodeURIComponent(creditQuery.trim())}&limit=8`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
      })
        .then((r) => (r.ok ? r.json() : { customers: [] }))
        .then((d) => setCreditResults(d.customers || []))
        .catch(() => setCreditResults([]));
    }, 200);
    return () => clearTimeout(timer);
  }, [paymentMode, branchId, creditQuery]);

  const cartSubtotal = cart.reduce((sum, item) => sum + parseFloat(item.price) * item.qty, 0);
  const discountVal = Math.max(0, parseFloat(discount) || 0);
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
      if (!res.ok && res.status !== 200) throw new Error('checkout failed');
      const data = await res.json();
      const custName = creditCustomer?.name;
      setCart([]);
      setBuyerGstin('');
      setDiscount('');
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
        <input
          id="posSearch"
          type="search"
          placeholder="Search products..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full p-2 mb-4 border rounded dark:bg-gray-700 dark:border-gray-600"
        />
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
        <div className="p-4 border-t dark:border-gray-700 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <label htmlFor="discountInput" className="text-gray-500">Discount (₹)</label>
            <input
              id="discountInput"
              className="w-24 p-1 border rounded text-right font-mono text-xs dark:bg-gray-700 dark:border-gray-600"
              placeholder="0.00"
              value={discount}
              onChange={(e) => setDiscount(e.target.value)}
            />
          </div>
          <div className="flex justify-between font-bold">
            <span>Total</span>
            <span>₹{cartTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
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
            <div id="creditBox" className="space-y-1.5 text-xs">
              <input
                id="creditSearch"
                className="w-full p-1.5 border rounded text-xs dark:bg-gray-700 dark:border-gray-600"
                placeholder="Search khata customer…"
                value={creditQuery}
                onChange={(e) => setCreditQuery(e.target.value)}
              />
              {creditResults.length > 0 && (
                <div id="creditResults" className="max-h-28 overflow-y-auto border rounded divide-y dark:border-gray-700 dark:divide-gray-700">
                  {creditResults.map((c) => {
                    const rem = parseFloat(c.creditLimit) - parseFloat(c.currentCredit);
                    return (
                      <button
                        key={c.id}
                        type="button"
                        className="list-btn w-full p-1.5 text-left flex justify-between items-center hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer"
                        onClick={() => {
                          setCreditCustomer(c);
                          setCreditResults([]);
                          setCreditQuery('');
                        }}
                      >
                        <span>
                          <b>{c.name}</b> <span className="text-gray-500">({c.phone})</span>
                        </span>
                        <span className="font-mono">₹{rem.toFixed(2)}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              {creditCustomer && (
                <div id="creditCustomerCard" className="p-2 border rounded bg-gray-50 dark:bg-gray-900/50 space-y-0.5">
                  <div className="flex justify-between items-center">
                    <b>{creditCustomer.name}</b>
                    <button type="button" className="text-gray-500 hover:underline cursor-pointer" onClick={() => setCreditCustomer(null)}>
                      Change
                    </button>
                  </div>
                  <div className="text-gray-500">
                    Limit ₹{parseFloat(creditCustomer.creditLimit).toLocaleString('en-IN', { minimumFractionDigits: 2 })} · Remaining{' '}
                    <b id="creditRemaining">
                      ₹{(parseFloat(creditCustomer.creditLimit) - parseFloat(creditCustomer.currentCredit)).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </b>
                  </div>
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
              onClick={() => setCheckoutModal(null)}
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
                onClick={() => setCheckoutModal(null)}
                className="flex-1 bg-purple-600 text-white p-2 rounded"
              >
                New Bill
              </button>
              {checkoutModal.offline && (
                <button
                  id="checkoutHistoryBtn"
                  onClick={() => {
                    setCheckoutModal(null);
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
