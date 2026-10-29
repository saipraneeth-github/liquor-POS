import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';

type Product = {
  id: string;
  name: string;
  brand: string;
  mrp: string;          // decimal string e.g. "1050.00"
  barcode: string;
  categoryId: string;
};

type CartItem = Product & { qty: number };

type QueuedBill = {
  clientRef: string;
  ownerSub: string;
  queuedAt: string;
  body: {
    branchId: string;
    items: { productId: string; quantity: number }[];
    paymentMode: 'CASH' | 'CARD' | 'UPI' | 'CREDIT';
    discount: string;
    clientRef: string;
  };
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
  const [checkoutModal, setCheckoutModal] = useState<{
    title: string;
    billNumber: string;
    total: string;
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

  // Load products
  useEffect(() => {
    if (!user) return;
    fetch('/api/v1/products', {
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
    })
      .then((r) => r.ok ? r.json() : [])
      .then(setProducts)
      .catch(() => { /* offline — products not available */ });
  }, [user]);

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

  const addToCart = (product: Product) => {
    setCart((prev) => {
      const existing = prev.find((item) => item.id === product.id);
      if (existing) return prev.map((item) => item.id === product.id ? { ...item, qty: item.qty + 1 } : item);
      return [...prev, { ...product, qty: 1 }];
    });
  };

  const cartTotal = cart.reduce((sum, item) => sum + parseFloat(item.mrp) * item.qty, 0);

  const checkout = async () => {
    const clientRef = genUUID();
    const body: QueuedBill['body'] = {
      branchId,
      items: cart.map((c) => ({ productId: c.id, quantity: c.qty })),
      paymentMode: 'CASH',
      discount: '0.00',
      clientRef,
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
      setCart([]);
      setCheckoutModal({ title: 'Bill Generated', billNumber: data.billNumber, total: data.total, offline: false });
    } catch {
      // Queue for offline sync
      const queued: QueuedBill = { clientRef, ownerSub: sub, queuedAt: new Date().toISOString(), body };
      saveQueue(sub, [...getQueue(sub), queued]);
      refreshQueueCount();
      setCart([]);
      setCheckoutModal({ title: 'Saved offline', billNumber: clientRef.slice(0, 8), total: cartTotal.toFixed(2), offline: true });
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
          {filteredProducts.map((p) => (
            <button
              key={p.id}
              className="pos-product p-4 bg-white dark:bg-gray-800 rounded shadow hover:shadow-md transition text-center"
              onClick={() => addToCart(p)}
            >
              <div className="text-2xl mb-2">🥃</div>
              <div className="font-semibold truncate">{p.name}</div>
              <div className="text-sm text-gray-500">
                ₹{parseFloat(p.mrp).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Cart + checkout */}
      <div className="w-80 bg-white dark:bg-gray-800 rounded shadow flex flex-col">
        <div className="p-4 font-bold border-b dark:border-gray-700">Current Order</div>
        <div className="flex-1 overflow-y-auto p-4 space-y-2" id="cartItems">
          {cart.map((item) => (
            <div key={item.id} className="flex justify-between items-center text-sm border-b pb-2 dark:border-gray-700 cart-line">
              <span className="truncate flex-1">{item.name}</span>
              <span className="w-12 text-right">x{item.qty}</span>
              <span className="w-20 text-right">
                ₹{(parseFloat(item.mrp) * item.qty).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
              </span>
            </div>
          ))}
        </div>
        <div className="p-4 border-t dark:border-gray-700">
          <div className="flex justify-between font-bold mb-2">
            <span>Total</span>
            <span>₹{cartTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
          </div>
          {/* lastSync shown inline for E2E assertions */}
          <div id="lastSync" className="text-xs text-gray-500 mb-2">{lastSync}</div>
          <button
            id="checkoutBtn"
            onClick={checkout}
            disabled={cart.length === 0}
            className="w-full bg-green-600 text-white p-3 rounded font-bold hover:bg-green-700 disabled:opacity-50"
          >
            Checkout &amp; Print
          </button>
        </div>
      </div>

      {/* Post-checkout modal */}
      {checkoutModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" id="checkoutModal">
          <div className="bg-white dark:bg-gray-800 p-6 rounded shadow-lg max-w-sm w-full text-center">
            <h2 className="text-xl font-bold mb-2" id="checkoutTitle">{checkoutModal.title}</h2>
            <div className="text-2xl text-purple-600 font-mono mb-4" id="checkoutBillNo">
              {checkoutModal.billNumber}
            </div>
            <div className="text-gray-500 mb-6" id="checkoutSummary">
              {checkoutModal.offline
                ? 'Queued — will sync automatically when back online'
                : `₹${parseFloat(checkoutModal.total).toLocaleString('en-IN', { minimumFractionDigits: 2 })} collected via CASH`}
            </div>
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
