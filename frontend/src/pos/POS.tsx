import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { inr } from '../components/ui';
import { useNavigate } from 'react-router-dom';
import { X, Plus, Minus, Trash2, RefreshCw, Search, Banknote, CreditCard, Smartphone, BookUser, ShoppingBag, Pause, Undo2, Keyboard, ChevronDown, Clock } from 'lucide-react';
import {
  CategoryIcon,
  classifyProductCategory,
  CATEGORY_DEFINITIONS,
  type LiquorCategoryKey,
} from '../components/category-icons';
import { useAuth } from '../auth/AuthProvider';
import { printInBrowser, sendToNetworkPrinter, showToast } from '../lib/print';
import { autoPrint } from '../lib/auto-print';
import { BeerBottleLoader } from '../components/BeerBottleLoader';
import { KhataPanel, type KhataCustomer } from './KhataPanel';
import {
  addParked, discountFromAmount, discountFromPercent, loadParked, quickCashOptions, recentProductIds, recordSale, removeParked,
  resolveScan, saveParked, tender, type ParkedBill,
} from './posLogic';

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

type SaleType = { id: string; code: string; name: string; isDefault: boolean };

type CartItem = Product & { qty: number; servingId?: string; servingLabel?: string; price: string };

const cartKey = (c: { id: string; servingId?: string }) => c.id + '|' + (c.servingId ?? '');
type PayMode = 'CASH' | 'CARD' | 'UPI' | 'CREDIT';

type QueuedBill = {
  clientRef: string;
  ownerSub: string;
  queuedAt: string;
  body: {
    branchId: string;
    items: { productId: string; servingId?: string; quantity: number }[];
    customerGstin?: string;
    customerId?: string;
    saleTypeId?: string;
    paymentMode: PayMode;
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

const money = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const finePointer = () => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: fine)').matches;

export type PosStockFilter = 'ALL' | 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK';

const PAY_MODES = [
  ['CASH', Banknote, 'Cash', '1'],
  ['UPI', Smartphone, 'UPI', '2'],
  ['CARD', CreditCard, 'Card', '3'],
  ['CREDIT', BookUser, 'Khata', '4'],
] as const;

const SHORTCUTS: [string, string][] = [
  ['F2', 'Search / scan'], ['Enter', 'Add the scanned or only matching item'], ['+  −  Del', 'More, fewer, remove (last touched line)'],
  ['Alt + 1–4', 'Cash, UPI, Card, Khata'], ['F4', 'Park this bill'], ['F8', 'Parked bills'], ['F9', 'Checkout'], ['Esc', 'Clear search / close'],
];

export function POS() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<LiquorCategoryKey>('ALL');
  const [hideOut, setHideOut] = useState<boolean>(() => { try { return localStorage.getItem('lc_pos_hide_out') === '1'; } catch { return false; } });
  const [rawProducts, setRawProducts] = useState<Product[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [queuedCount, setQueuedCount] = useState(0);
  const [lastSync, setLastSync] = useState('');
  const [servingPicker, setServingPicker] = useState<Product | null>(null);
  const [buyerGstin, setBuyerGstin] = useState('');
  const [paymentMode, setPaymentMode] = useState<PayMode>('CASH');
  const [discountMode, setDiscountMode] = useState<'PCT' | 'AMT'>('PCT');
  const [discountPercent, setDiscountPercent] = useState('');
  const [discountAmount, setDiscountAmount] = useState('');
  const [received, setReceived] = useState('');
  const [creditCustomer, setCreditCustomer] = useState<KhataCustomer | null>(null);
  const [isPaying, setIsPaying] = useState(false);
  const [cartOpen, setCartOpen] = useState(false);              // phone: the cart is a sheet over the catalog
  const [activeKey, setActiveKey] = useState<string | null>(null);   // the line + / − / Delete act on
  const [undo, setUndo] = useState<{ label: string; lines: CartItem[] } | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [parked, setParked] = useState<ParkedBill[]>([]);
  const [parkedOpen, setParkedOpen] = useState(false);
  const [resuming, setResuming] = useState<ParkedBill | null>(null);
  const [recentTick, setRecentTick] = useState(0);
  // Stable clientRef per cart session — reset when the cart is cleared so each new cart gets a fresh UUID. This guarantees
  // the server's idempotency guard works even if checkout is pressed twice in quick succession.
  const cartClientRef = useRef<string>(genUUID());
  const searchRef = useRef<HTMLInputElement>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [checkoutModal, setCheckoutModal] = useState<{
    title: string;
    billId?: string;
    billNumber: string;
    total: string;
    paymentMode: string;
    customerName?: string;
    received?: number;
    change?: number;
    offline: boolean;
  } | null>(null);

  const sub = (user as any)?.sub ?? user?.id ?? '';
  const branchId = (user as any)?.branchId ?? '';
  const canSetLimit = ['manager', 'owner', 'office_admin'].includes(user?.role || '');

  const focusSearch = useCallback((select = false) => {
    if (!finePointer()) return;           // on a touch screen the keyboard should not pop up by itself
    searchRef.current?.focus();
    if (select) searchRef.current?.select();
  }, []);

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
      const r = await fetch(url, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
      if (r.ok) setRawProducts((await r.json()) || []);
    } catch {
      /* offline — products not available */
    } finally {
      setLoadingProducts(false);
    }
  }, [user, branchId]);

  useEffect(() => { loadProducts(); }, [loadProducts]);
  useEffect(() => { focusSearch(); }, [focusSearch]);
  useEffect(() => { if (sub) setParked(loadParked(localStorage, sub)); }, [sub]);

  // ── Sale types (Walk-in, Janata, ...): each has its own price list and its own counter of bottles ──
  const [saleTypes, setSaleTypes] = useState<SaleType[]>([]);
  const [saleTypeId, setSaleTypeId] = useState<string>(() => {
    try { return localStorage.getItem(`lc_pos_sale_type:${(user as any)?.branchId ?? ''}`) ?? ''; } catch { return ''; }
  });
  const [typePrices, setTypePrices] = useState<Record<string, Record<string, string>>>({});   // productId → saleTypeId → price
  const [counters, setCounters] = useState<Record<string, Record<string, number>>>({});       // productId → saleTypeId → bottles

  const loadSaleTypes = useCallback(async () => {
    if (!branchId) return;
    const headers = { Authorization: `Bearer ${localStorage.getItem('token')}` };
    try {
      const [t, p, s] = await Promise.all([
        fetch(`/api/v1/sale-types/${branchId}`, { headers }),
        fetch(`/api/v1/sale-types/${branchId}/prices`, { headers }),
        fetch(`/api/v1/sale-types/${branchId}/stock`, { headers }),
      ]);
      if (t.ok) {
        const types: SaleType[] = await t.json();
        setSaleTypes(types);
        setSaleTypeId((cur) => {
          if (!cur) return '';
          if (types.some((x) => x.id === cur)) return cur;
          try { localStorage.removeItem(`lc_pos_sale_type:${branchId}`); } catch { /* private mode */ }
          return '';
        });
      }
      if (p.ok) {
        const m = await p.json() as { products: { id: string; prices: Record<string, string> }[] };
        setTypePrices(Object.fromEntries(m.products.map((x) => [x.id, x.prices])));
      }
      if (s.ok) {
        const c = await s.json() as { products: { productId: string; counters: Record<string, number> }[] };
        setCounters(Object.fromEntries(c.products.map((x) => [x.productId, x.counters])));
      }
    } catch {
      /* offline — the default type keeps working from the cached catalog */
    }
  }, [branchId]);

  useEffect(() => {
    loadSaleTypes();
    window.addEventListener('app:stock_updated', loadSaleTypes);
    return () => window.removeEventListener('app:stock_updated', loadSaleTypes);
  }, [loadSaleTypes]);

  // The chosen type; if it is not one this user may use (e.g. limited to Janata only), the first allowed one.
  const activeType = saleTypes.find((t) => (t.isDefault ? '' : t.id) === saleTypeId) ?? saleTypes.find((t) => t.isDefault) ?? saleTypes[0];

  /** What the cashier can sell under the chosen type: its price, and only the bottles in its own counter. */
  const products = useMemo<Product[]>(() => {
    // a shop with only the default type (or nothing loaded yet) sells the plain catalog, exactly as before
    if (!activeType || (activeType.isDefault && saleTypes.length < 2)) return rawProducts;
    return rawProducts.flatMap((p) => {
      const q = counters[p.id]?.[activeType.id];
      const stock = p.trackStock === false || q === undefined ? {} : { currentStock: q, stockQuantity: q };
      if (activeType.isDefault) return [{ ...p, ...stock }];
      if (p.menuType === 'BAR' || p.menuType === 'KITCHEN') return [];
      const price = typePrices[p.id]?.[activeType.id] || p.mrp;
      return [{ ...p, ...stock, mrp: price, servings: [] }];
    });
  }, [rawProducts, activeType, saleTypes.length, counters, typePrices]);
  const limitedToOneType = saleTypes.length === 1 && !saleTypes[0].isDefault;   // e.g. a cashier who may only sell as Janata

  useEffect(() => {
    const handleStockUpdate = () => { loadProducts(); };
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
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
          body: JSON.stringify(item.body),
        });
        const data = await res.json();
        // Remove from queue whether 201 (new) or 200 (idempotent replay)
        saveQueue(sub, getQueue(sub).filter((x) => x.clientRef !== item.clientRef));
        const isReplay = res.status === 200;
        localStorage.setItem(`lc_last_sync:${sub}`, JSON.stringify({ billNumber: data.billNumber, total: data.total, at: new Date().toISOString(), replay: isReplay }));
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
    const counts = { ALL: products.length } as Record<LiquorCategoryKey, number>;
    for (const p of products) { const k = classifyProductCategory(p); counts[k] = (counts[k] || 0) + 1; }
    return CATEGORY_DEFINITIONS.map((def) => ({ ...def, count: counts[def.id] || 0 })).filter((def) => def.id === 'ALL' || def.count > 0);
  }, [products]);

  const stockOf = (p: Product) => p.currentStock ?? p.stockQuantity ?? 0;
  const isOutOfStock = (p: Product) => p.trackStock !== false && stockOf(p) <= 0;

  const filteredProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      if (q && !(p.name.toLowerCase().includes(q) || (p.brand ?? '').toLowerCase().includes(q) || (p.barcode ?? '').toLowerCase().includes(q) || (p.categoryName ?? '').toLowerCase().includes(q))) return false;
      if (selectedCategory !== 'ALL' && classifyProductCategory(p) !== selectedCategory) return false;
      if (hideOut && p.trackStock !== false && (p.currentStock ?? p.stockQuantity ?? 0) <= 0) return false;
      return true;
    });
  }, [products, search, selectedCategory, hideOut]);

  const outCount = useMemo(() => products.filter((p) => p.trackStock !== false && (p.currentStock ?? p.stockQuantity ?? 0) <= 0).length, [products]);

  // Recently sold: a quick row above the catalog while nothing is being searched
  const recentProducts = useMemo(() => {
    void recentTick;
    const byId = new Map(products.map((p) => [p.id, p]));
    return recentProductIds(localStorage, branchId, 8).map((id) => byId.get(id)).filter((p): p is Product => !!p && p.isAvailable !== false && !isOutOfStock(p));
  }, [products, branchId, recentTick]); // eslint-disable-line react-hooks/exhaustive-deps

  const inCart = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cart) m.set(c.id, (m.get(c.id) ?? 0) + c.qty);
    return m;
  }, [cart]);

  // ── cart ──────────────────────────────────────────────────────────────────
  const rememberUndo = (label: string, lines: CartItem[]) => {
    setUndo({ label, lines });
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setUndo(null), 8000);
  };

  const addToCart = (product: Product, serving?: Serving) => {
    const stockQty = stockOf(product);
    const isTracked = product.trackStock !== false;
    if (isTracked && stockQty <= 0) {
      showToast(`Cannot add "${product.name}". It is currently out of stock.`, 'error');
      return;
    }
    const line: CartItem = { ...product, qty: 1, price: serving?.price ?? product.mrp, servingId: serving?.id, servingLabel: serving?.label };
    const key = cartKey(line);
    const existing = cart.find((item) => cartKey(item) === key);
    if (isTracked && (existing ? existing.qty : 0) + 1 > stockQty) {
      showToast(`Cannot add more "${product.name}". Only ${stockQty} available in stock.`, 'error');
      return;
    }
    setCart((prev) => {
      const ex = prev.find((item) => cartKey(item) === key);
      if (ex) return prev.map((item) => (cartKey(item) === key ? { ...item, qty: item.qty + 1 } : item));
      return [...prev, line];
    });
    setActiveKey(key);
    setUndo(null);
  };

  const pickProduct = (product: Product) => {
    if (product.isAvailable === false) return;
    if (isOutOfStock(product)) {
      showToast(`"${product.name}" is currently out of stock.`, 'error');
      return;
    }
    if (product.servings && product.servings.length > 0) setServingPicker(product);
    else { addToCart(product); focusSearch(); }
  };

  const updateCartQty = (key: string, delta: number) => {
    const target = cart.find((item) => cartKey(item) === key);
    if (!target) return;
    setActiveKey(key);
    if (delta <= 0) {
      // Reducing quantity or removing never checks the stock limit
      if (target.qty + delta <= 0) rememberUndo(target.name, [target]);
      setCart((prev) => prev.map((item) => (cartKey(item) === key ? { ...item, qty: item.qty + delta } : item)).filter((item) => item.qty > 0));
      return;
    }
    // Only validate against stock when INCREASING quantity
    const p = products.find((prod) => prod.id === target.id);
    const stockQty = p?.currentStock ?? p?.stockQuantity ?? 0;
    if (p?.trackStock !== false && target.qty + delta > stockQty) {
      showToast(`Cannot exceed available stock (${stockQty} bottles) for "${target.name}".`, 'error');
      return;
    }
    setCart((prev) => prev.map((item) => (cartKey(item) === key ? { ...item, qty: item.qty + delta } : item)));
  };

  const removeLine = (key: string) => {
    const target = cart.find((item) => cartKey(item) === key);
    if (!target) return;
    rememberUndo(target.name, [target]);
    setCart((prev) => prev.filter((item) => cartKey(item) !== key));
  };

  const doUndo = () => {
    if (!undo) return;
    setCart((prev) => {
      const next = [...prev];
      for (const l of undo.lines) {
        const i = next.findIndex((x) => cartKey(x) === cartKey(l));
        if (i >= 0) next[i] = { ...next[i], qty: next[i].qty + l.qty }; else next.push(l);
      }
      return next;
    });
    setUndo(null);
  };

  const resetBillFields = () => {
    setBuyerGstin('');
    setDiscountPercent('');
    setDiscountAmount('');
    setCreditCustomer(null);
    setReceived('');
    setActiveKey(null);
  };

  const clearCart = () => {
    if (cart.length === 0) return;
    rememberUndo(cart.length === 1 ? cart[0].name : `${cart.length} items`, cart);
    setCart([]);
    resetBillFields();
  };

  // ── totals ────────────────────────────────────────────────────────────────
  const cartSubtotal = cart.reduce((sum, item) => sum + parseFloat(item.price) * item.qty, 0);
  // Without the 'discounts above 5%' permission the server caps a bill discount (user.discountCapPct; null = unlimited)
  const discountCap = user?.discountCapPct ?? null;
  const disc = discountMode === 'AMT'
    ? discountFromAmount(cartSubtotal, parseFloat(discountAmount) || 0, discountCap)
    : discountFromPercent(cartSubtotal, parseFloat(discountPercent) || 0, discountCap);
  const discountVal = disc.amount;
  const discountPctNum = disc.pct;
  const cartTotal = Math.max(0, cartSubtotal - discountVal);
  const itemCount = cart.reduce((n, i) => n + i.qty, 0);
  const cash = paymentMode === 'CASH' ? tender(cartTotal, received) : null;
  const cashShort = cash?.state === 'short';

  // ── park / resume ─────────────────────────────────────────────────────────
  const parkCurrent = useCallback(() => {
    if (cart.length === 0) return false;
    const bill: ParkedBill = {
      id: genUUID(), parkedAt: new Date().toISOString(), saleTypeId, paymentMode, discountPercent: discountMode === 'PCT' ? discountPercent : '',
      buyerGstin, customer: creditCustomer, items: itemCount, total: cartTotal.toFixed(2),
      lines: cart.map((c) => ({ productId: c.id, ...(c.servingId ? { servingId: c.servingId } : {}), qty: c.qty })),
    };
    const next = addParked(parked, bill);
    setParked(next);
    saveParked(localStorage, sub, next);
    setCart([]);
    resetBillFields();
    cartClientRef.current = genUUID();
    showToast('Bill parked. Resume it from “Parked” (F8).', 'success');
    focusSearch();
    return true;
  }, [cart, saleTypeId, paymentMode, discountMode, discountPercent, buyerGstin, creditCustomer, itemCount, cartTotal, parked, sub, focusSearch]);

  const resume = (b: ParkedBill) => {
    if (cart.length > 0) parkCurrent();            // never lose the bill that is on the screen
    setParkedOpen(false);
    const known = b.saleTypeId === '' || saleTypes.some((t) => t.id === b.saleTypeId);
    if (known && b.saleTypeId !== saleTypeId) {
      setSaleTypeId(b.saleTypeId);
      try { localStorage.setItem(`lc_pos_sale_type:${branchId}`, b.saleTypeId); } catch { /* private mode */ }
    }
    setResuming(b);
  };

  // Rebuild the parked bill's lines from the CURRENT catalog (prices and stock may have moved on) once the right sale type is showing
  useEffect(() => {
    if (!resuming) return;
    const wanted = saleTypes.length === 0 ? true : (activeType?.isDefault ? '' : activeType?.id ?? '') === resuming.saleTypeId || !saleTypes.some((t) => t.id === resuming.saleTypeId);
    if (!wanted || products.length === 0) return;
    const lines: CartItem[] = [];
    let skipped = 0;
    for (const l of resuming.lines) {
      const p = products.find((x) => x.id === l.productId);
      const serving = p?.servings?.find((s) => s.id === l.servingId);
      if (!p || p.isAvailable === false || (l.servingId && !serving)) { skipped++; continue; }
      const qty = p.trackStock === false ? l.qty : Math.min(l.qty, Math.max(0, stockOf(p)));
      if (qty <= 0) { skipped++; continue; }
      if (qty < l.qty) skipped++;
      lines.push({ ...p, qty, price: serving?.price ?? p.mrp, servingId: serving?.id, servingLabel: serving?.label });
    }
    setCart(lines);
    setPaymentMode(resuming.paymentMode);
    setDiscountMode('PCT');
    setDiscountPercent(resuming.discountPercent);
    setBuyerGstin(resuming.buyerGstin);
    setCreditCustomer(resuming.customer);
    const next = removeParked(parked, resuming.id);
    setParked(next);
    saveParked(localStorage, sub, next);
    cartClientRef.current = genUUID();
    if (skipped > 0) showToast(`${skipped} item${skipped === 1 ? ' was' : 's were'} no longer available at the same quantity and ${skipped === 1 ? 'was' : 'were'} left out or reduced.`, 'info');
    setResuming(null);
    focusSearch();
  }, [resuming, products, saleTypes, activeType]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── checkout ──────────────────────────────────────────────────────────────
  const checkout = async () => {
    if (isPaying || cart.length === 0) return;        // guard against double-click / re-entrancy
    if (cashShort) {
      showToast(`The customer has handed over ₹${money(cash!.received)}: ₹${money(cash!.short)} short.`, 'error');
      return;
    }
    setIsPaying(true);
    try {
      if (paymentMode === 'CREDIT') {
        if (!creditCustomer) { showToast('Pick a khata customer for a credit sale.', 'error'); return; }
        if (!creditCustomer.creditAllowed || !creditCustomer.isActive) { showToast('Credit is not allowed for this customer.', 'error'); return; }
        const limit = parseFloat(creditCustomer.creditLimit || '0');
        const used = parseFloat(creditCustomer.currentCredit || '0');
        if (limit > 0 && (used + cartTotal) > limit) {
          showToast(`Cannot proceed: Bill (₹${cartTotal.toFixed(2)}) exceeds customer's remaining credit (₹${Math.max(0, limit - used).toFixed(2)}).`, 'error');
          return;
        }
      }

      // Validate each item against available stock
      for (const item of cart) {
        const p = products.find((prod) => prod.id === item.id);
        const stockQty = p?.currentStock ?? p?.stockQuantity ?? 0;
        if (p?.trackStock !== false && item.qty > stockQty) {
          showToast(`Insufficient stock for "${item.name}": requested ${item.qty}, only ${stockQty} available.`, 'error');
          return;
        }
      }

      // Use the stable per-cart clientRef so the server's idempotency guard fires if this runs twice with the same cart.
      const clientRef = cartClientRef.current;
      const body: QueuedBill['body'] = {
        branchId,
        items: cart.map((c) => ({ productId: c.id, ...(c.servingId ? { servingId: c.servingId } : {}), quantity: c.qty })),
        paymentMode,
        discount: discountVal.toFixed(2),
        clientRef,
        ...(activeType && !activeType.isDefault ? { saleTypeId: activeType.id } : {}),
        ...(paymentMode === 'CREDIT' && creditCustomer ? { customerId: creditCustomer.id } : {}),
        ...(buyerGstin.trim() ? { customerGstin: buyerGstin.trim().toUpperCase() } : {}),
      };
      const tendered = cash && cash.state === 'ok' ? { received: cash.received, change: cash.change } : {};
      const soldIds = cart.map((c) => c.id);

      let res: Response;
      try {
        res = await fetch('/api/v1/bills', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
          body: JSON.stringify(body),
        });
      } catch {
        // Network error — queue for offline sync
        saveQueue(sub, [...getQueue(sub), { clientRef, ownerSub: sub, queuedAt: new Date().toISOString(), body }]);
        refreshQueueCount();
        setCart([]);
        resetBillFields();
        setCartOpen(false);
        recordSale(localStorage, branchId, soldIds);
        setRecentTick((n) => n + 1);
        cartClientRef.current = genUUID();   // the next cart gets a fresh UUID
        setCheckoutModal({ title: 'Saved offline', billNumber: clientRef.slice(0, 8), total: cartTotal.toFixed(2), paymentMode, offline: true, ...tendered });
        return;
      }

      if (!res.ok && res.status !== 200) {
        const errJson = await res.json().catch(() => null);
        showToast(errJson?.error || errJson?.message || 'Checkout failed', 'error');
        return;
      }
      const data = await res.json();
      const custName = creditCustomer?.name;
      setCart([]);
      resetBillFields();
      setCartOpen(false);
      recordSale(localStorage, branchId, soldIds);
      setRecentTick((n) => n + 1);
      cartClientRef.current = genUUID();
      setCheckoutModal({ title: 'Bill Generated', billId: data.id, billNumber: data.billNumber, total: data.total, paymentMode, customerName: custName, offline: false, ...tendered });
      // Best effort: kick the receipt out to the branch's network printer if one is set up
      void autoPrint(branchId ?? '', 'bills', data.id);
      // Refresh live stock on the POS screen and notify any other tabs/screens
      window.dispatchEvent(new CustomEvent('app:stock_updated', { detail: { branchId } }));
    } finally {
      setIsPaying(false);
    }
  };

  const closeCheckoutModal = () => {
    setCheckoutModal(null);
    setTimeout(() => focusSearch(), 0);
  };

  // ── search box: Enter adds the scanned / only matching item ───────────────
  const onSearchEnter = () => {
    const r = resolveScan(products, filteredProducts, search);
    if (r.kind === 'match') {
      pickProduct(r.product);
      setSearch('');
    } else if (r.kind === 'many') {
      showToast('More than one item matches. Tap the one you want.', 'info');
    } else if (search.trim()) {
      showToast(`Nothing matches “${search.trim()}”.`, 'error');
    }
  };

  // ── keyboard ──────────────────────────────────────────────────────────────
  // The handlers change with every render; the listener is added once and always calls the latest ones.
  const keys = useRef({ checkout, parkCurrent, updateCartQty, removeLine });
  keys.current = { checkout, parkCurrent, updateCartQty, removeLine };
  const state = useRef({ activeKey, servingPicker, checkoutModal, parkedOpen, search });
  state.current = { activeKey, servingPicker, checkoutModal, parkedOpen, search };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      const s = state.current;
      const overlay = !!s.servingPicker || !!s.checkoutModal || s.parkedOpen;

      if (e.key === 'Escape') {
        if (s.servingPicker) setServingPicker(null);
        else if (s.parkedOpen) setParkedOpen(false);
        else if (s.checkoutModal) setCheckoutModal(null);
        else if (s.search) setSearch('');
        else setCartOpen(false);
        return;
      }
      if (overlay) {
        // the serving picker is chosen by number
        if (s.servingPicker && /^[1-9]$/.test(e.key) && !e.altKey && !e.ctrlKey) {
          const serving = s.servingPicker.servings?.[Number(e.key) - 1];
          if (serving) { e.preventDefault(); addToCartRef.current(s.servingPicker, serving); setServingPicker(null); }
        }
        return;
      }
      if (e.key === 'F2') { e.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); return; }
      if (e.key === 'F4') { e.preventDefault(); keys.current.parkCurrent(); return; }
      if (e.key === 'F8') { e.preventDefault(); setParkedOpen((v) => !v); return; }
      if (e.key === 'F9' || ((e.ctrlKey || e.metaKey) && e.key === 'Enter')) { e.preventDefault(); void keys.current.checkout(); return; }
      if (e.altKey && /^[1-4]$/.test(e.key)) {
        e.preventDefault();
        setPaymentMode((['CASH', 'UPI', 'CARD', 'CREDIT'] as const)[Number(e.key) - 1]);
        return;
      }
      if (typing || e.ctrlKey || e.altKey || e.metaKey) return;
      const key = s.activeKey;
      if (key && (e.key === '+' || e.key === '=')) { e.preventDefault(); keys.current.updateCartQty(key, 1); return; }
      if (key && (e.key === '-' || e.key === '_')) { e.preventDefault(); keys.current.updateCartQty(key, -1); return; }
      if (key && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); keys.current.removeLine(key); return; }
      // a scanner types into whatever is focused: any letter or digit goes to the search box
      if (e.key.length === 1 && /[0-9a-zA-Z]/.test(e.key)) searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const addToCartRef = useRef(addToCart);
  addToCartRef.current = addToCart;

  const offlineVisible = !isOnline || queuedCount > 0;
  const noFilters = !search && selectedCategory === 'ALL' && !hideOut;
  const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });

  return (
    <div className="flex flex-col md:flex-row md:h-full gap-4 pb-20 md:pb-0" id="page-pos">
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

      {/* ───────────── Catalog ───────────── */}
      <div className="md:flex-1 flex flex-col min-w-0 md:h-full">
        {/* Sale type, parked bills, shortcuts */}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          {limitedToOneType && (
            <div className="text-sm" id="posSaleTypeFixed">
              <span className="text-xs font-semibold text-gray-500 mr-2">Selling as:</span>
              <span className="px-3.5 py-1.5 rounded-full text-sm font-semibold bg-purple-600 text-white">{saleTypes[0].name}</span>
            </div>
          )}
          {saleTypes.length > 1 && (
            <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Sale type" id="posSaleTypes">
              <span className="text-xs font-semibold text-gray-500">Sell as:</span>
              {saleTypes.map((t) => {
                const selected = activeType?.id === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    id={`posType-${t.code}`}
                    className={`px-3.5 py-2 rounded-full text-sm font-semibold border transition cursor-pointer ${
                      selected ? 'bg-purple-600 text-white border-purple-600 shadow-xs' : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 border-gray-200 dark:border-gray-700 hover:bg-gray-50'
                    }`}
                    onClick={() => {
                      if (selected) return;
                      if (cart.length > 0) { showToast('Finish, park or clear the current bill before switching sale type — prices differ.', 'error'); return; }
                      const next = t.isDefault ? '' : t.id;
                      setSaleTypeId(next);
                      try { localStorage.setItem(`lc_pos_sale_type:${branchId}`, next); } catch { /* private mode */ }
                    }}
                  >
                    {t.name}
                  </button>
                );
              })}
            </div>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              id="posParkedBtn"
              onClick={() => setParkedOpen(true)}
              title="Parked bills (F8)"
              className="relative inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm font-semibold text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer"
            >
              <Clock size={16} aria-hidden="true" /> Parked
              {parked.length > 0 && <span id="parkedCount" className="min-w-5 h-5 px-1 grid place-items-center rounded-full bg-amber-500 text-white text-[11px] font-bold">{parked.length}</span>}
            </button>
            <div className="relative">
              <button type="button" id="posHelpBtn" aria-expanded={helpOpen} onClick={() => setHelpOpen((v) => !v)} title="Keyboard shortcuts" aria-label="Keyboard shortcuts" className="p-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer hidden md:block">
                <Keyboard size={17} />
              </button>
              {helpOpen && (
                <div id="posHelp" className="absolute right-0 mt-2 w-72 z-30 p-3 rounded-xl border bg-white dark:bg-gray-800 dark:border-gray-700 shadow-xl text-xs">
                  <div className="font-bold mb-2 text-sm">Keyboard shortcuts</div>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                    {SHORTCUTS.map(([k, d]) => (<div key={k} className="contents"><dt><kbd className="px-1.5 py-0.5 rounded border bg-gray-50 dark:bg-gray-900 font-mono text-[11px]">{k}</kbd></dt><dd className="text-gray-600 dark:text-gray-300">{d}</dd></div>))}
                  </dl>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Search: always ready for a scanner */}
        <div className="flex items-center gap-2 mb-3">
          <div className="relative flex-1">
            <Search size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" aria-hidden="true" />
            <input
              id="posSearch"
              ref={searchRef}
              type="search"
              enterKeyHint="search"
              autoComplete="off"
              placeholder="Scan a barcode, or search name or brand (F2)"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSearchEnter(); } }}
              className="w-full py-3 pl-11 pr-3 border border-gray-200 dark:border-gray-700 rounded-xl bg-white dark:bg-gray-800 text-base shadow-xs focus:outline-none focus:ring-2 focus:ring-purple-500/40"
            />
          </div>
          <button
            type="button"
            id="refreshStockBtn"
            title="Refresh stock and catalog"
            aria-label="Refresh stock"
            onClick={() => loadProducts()}
            disabled={loadingProducts}
            className="p-3 border border-gray-200 dark:border-gray-700 rounded-xl bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 transition-colors flex items-center justify-center shrink-0 disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw size={18} className={loadingProducts ? 'animate-spin' : ''} />
          </button>
        </div>

        {/* Recently sold */}
        {noFilters && recentProducts.length > 0 && (
          <div className="flex items-center gap-2 mb-3 overflow-x-auto [scrollbar-width:none]" id="posRecent">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-500 shrink-0">Recent</span>
            {recentProducts.map((p) => (
              <button key={p.id} type="button" data-recent={p.id} onClick={() => pickProduct(p)} className="shrink-0 inline-flex items-center gap-2 px-3 py-2 rounded-full border border-emerald-200 dark:border-emerald-900 bg-emerald-50/60 dark:bg-emerald-950/20 text-sm hover:bg-emerald-100 dark:hover:bg-emerald-900/30 cursor-pointer">
                <span className="font-medium max-w-[11rem] truncate">{p.name}</span>
                <span className="font-mono text-xs text-gray-600 dark:text-gray-300 tabular-nums">₹{parseFloat(p.servings?.length ? p.servings[0].price : p.mrp).toLocaleString('en-IN')}</span>
              </button>
            ))}
          </div>
        )}

        {/* One row: categories, and one switch for stock */}
        <div className="flex items-center gap-2 mb-3 shrink-0">
          <div className="flex items-center gap-1.5 overflow-x-auto flex-1 [scrollbar-width:thin]" id="posCategoryFilters">
            {categoriesList.map((cat) => (
              <button
                key={cat.id}
                type="button"
                id={`catFilter-${cat.id.toLowerCase()}`}
                onClick={() => setSelectedCategory(cat.id)}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-full border text-sm font-medium whitespace-nowrap transition cursor-pointer ${
                  selectedCategory === cat.id
                    ? 'bg-purple-600 text-white border-purple-600 shadow-xs'
                    : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:border-purple-300 dark:hover:border-purple-700'
                }`}
              >
                <span>{cat.label}</span>
                <span className={`text-[11px] px-1.5 rounded-full font-semibold tabular-nums ${selectedCategory === cat.id ? 'bg-white/20 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300'}`}>{cat.count}</span>
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-xs font-medium text-gray-600 dark:text-gray-300 shrink-0 cursor-pointer select-none" title={`${outCount} item${outCount === 1 ? '' : 's'} out of stock`}>
            <input
              id="posHideOut"
              type="checkbox"
              role="switch"
              checked={hideOut}
              onChange={(e) => { setHideOut(e.target.checked); try { localStorage.setItem('lc_pos_hide_out', e.target.checked ? '1' : '0'); } catch { /* private mode */ } }}
              className="size-4 accent-purple-600"
            />
            Hide out of stock{outCount > 0 ? ` (${outCount})` : ''}
          </label>
        </div>

        {loadingProducts && rawProducts.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 bg-white dark:bg-gray-800 rounded-lg border dark:border-gray-700">
            <BeerBottleLoader inline size="sm" title="Pouring POS Catalog…" subtitle="Fetching live counter stock & prices…" />
          </div>
        ) : filteredProducts.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-gray-500 bg-white dark:bg-gray-800 rounded-lg border border-dashed border-gray-300 dark:border-gray-600">
            <Search size={32} className="mb-2 text-gray-400" aria-hidden="true" />
            <p className="font-semibold text-gray-700 dark:text-gray-200">No products found</p>
            <p className="text-xs mt-1">{search ? `No items matching "${search}"` : ''}{selectedCategory !== 'ALL' ? ` in ${selectedCategory.toLowerCase()}` : ''}{hideOut ? ' (out-of-stock items are hidden)' : ''}</p>
            {!noFilters && (
              <button type="button" onClick={() => { setSearch(''); setSelectedCategory('ALL'); setHideOut(false); }} className="mt-3 px-3 py-2 text-xs bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-300 rounded font-medium hover:bg-purple-200 cursor-pointer">Reset filters</button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3 md:overflow-y-auto content-start pb-2" id="posCatalog">
            {filteredProducts.map((p) => {
              const stockQty = stockOf(p);
              const isTracked = p.trackStock !== false;
              const isOut = isTracked && stockQty <= 0;
              const isLow = isTracked && !isOut && stockQty <= (p.reorderLevel ?? 5);
              const picked = inCart.get(p.id) ?? 0;
              const hasServings = !!p.servings && p.servings.length > 0;
              return (
                <button
                  key={p.id}
                  className={`pos-product group relative text-left p-3 bg-white dark:bg-gray-800 rounded-xl border transition flex flex-col justify-between gap-2 min-h-[148px] cursor-pointer disabled:cursor-not-allowed ${
                    picked > 0 ? 'border-purple-500 ring-1 ring-purple-400' : 'border-gray-200 dark:border-gray-700'
                  } ${isOut ? 'opacity-55' : 'hover:border-purple-400 dark:hover:border-purple-500 hover:shadow-md active:scale-[0.98]'} ${p.isAvailable === false ? 'opacity-50' : ''}`}
                  onClick={() => pickProduct(p)}
                  disabled={p.isAvailable === false}
                >
                  {picked > 0 && <span className="absolute -top-2 -right-2 min-w-6 h-6 px-1.5 grid place-items-center rounded-full bg-purple-600 text-white text-xs font-bold shadow">×{picked}</span>}
                  <div className="flex items-start justify-between gap-2">
                    <span className="grid place-items-center size-8 rounded-lg bg-gray-100 dark:bg-gray-700/60">
                      <CategoryIcon categoryName={p.categoryName} productName={p.name} size={18} />
                    </span>
                    {isTracked ? (
                      isOut ? <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300">Out of stock</span>
                        : isLow ? <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300">Low: {stockQty}</span>
                        : <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300">{stockQty} in stock</span>
                    ) : (
                      <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300">Kitchen</span>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-sm leading-snug line-clamp-2" title={p.name}>{p.name}</div>
                    <div className="text-xs text-gray-500 truncate mt-0.5">{p.brand}</div>
                  </div>
                  <div className="flex items-end justify-between gap-2">
                    <span className="font-display font-bold text-[17px] leading-none tabular-nums text-gray-900 dark:text-gray-100 group-hover:text-purple-700 dark:group-hover:text-purple-300">
                      {hasServings ? 'From ₹' + Math.min(...p.servings!.map((s) => parseFloat(s.price))).toLocaleString('en-IN') : '₹' + parseFloat(p.mrp).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </span>
                    {hasServings ? (
                      <span className="text-[11px] font-semibold text-purple-700 dark:text-purple-300">{p.servings!.length} sizes ›</span>
                    ) : isTracked && p.openMl ? (
                      <span className="text-[11px] text-gray-500 font-mono" title="Peg ml open in current bottle">{p.openMl}ml open</span>
                    ) : null}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* ───────────── Cart (a pinned panel on a screen, a sheet on a phone) ───────────── */}
      {cartOpen && <div className="md:hidden fixed inset-0 z-30 bg-black/40" onClick={() => setCartOpen(false)} aria-hidden="true" />}
      <aside
        id="cartPanel"
        className={`bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-xs flex flex-col min-h-0
          fixed inset-x-0 bottom-0 z-40 max-h-[90dvh] rounded-t-2xl transition-transform duration-200 ${cartOpen ? 'translate-y-0' : 'translate-y-full'}
          md:static md:translate-y-0 md:z-auto md:max-h-none md:rounded-xl md:w-96 xl:w-[25rem] md:shrink-0`}
      >
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <button type="button" className="md:hidden p-1 -ml-1 text-gray-500 cursor-pointer" onClick={() => setCartOpen(false)} aria-label="Close the cart"><ChevronDown size={22} /></button>
            <span className="font-display font-bold text-base">Current order</span>
            {cart.length > 0 && <span id="cartCount" className="text-[11px] font-semibold px-2 py-px rounded-full bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200 tabular-nums">{itemCount} {itemCount === 1 ? 'item' : 'items'}</span>}
          </div>
          <div className="flex items-center gap-1">
            <button type="button" id="parkBtn" onClick={() => parkCurrent()} disabled={cart.length === 0} title="Park this bill (F4)" className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-40 cursor-pointer">
              <Pause size={13} aria-hidden="true" /> Park
            </button>
            {cart.length > 0 && <button type="button" id="clearCartBtn" onClick={clearCart} className="px-2.5 py-1.5 text-xs font-medium text-gray-500 hover:text-red-600 cursor-pointer">Clear</button>}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-1 min-h-[7rem]" id="cartItems">
          {cart.length === 0 && (
            <div className="h-full min-h-32 flex flex-col items-center justify-center text-center text-gray-500 gap-2 py-6">
              <ShoppingBag size={30} className="text-gray-300 dark:text-gray-600" aria-hidden="true" />
              <p className="text-sm font-medium text-gray-600 dark:text-gray-300">Nothing in this order yet</p>
              <p className="text-xs">Scan an item, or tap one to add it.</p>
              {parked.length > 0 && <button type="button" onClick={() => setParkedOpen(true)} className="text-xs font-semibold text-purple-700 dark:text-purple-300 hover:underline cursor-pointer">{parked.length} parked bill{parked.length === 1 ? '' : 's'} waiting</button>}
            </div>
          )}
          {cart.map((item) => {
            const k = cartKey(item);
            return (
              <div key={k} onClick={() => setActiveKey(k)} className={`flex items-center gap-2.5 text-sm py-2.5 border-b border-gray-100 dark:border-gray-700/60 last:border-b-0 cart-line rounded ${activeKey === k ? 'bg-purple-50/60 dark:bg-purple-950/20' : ''}`}>
                <div className="flex-1 min-w-0">
                  <div className="font-medium leading-snug line-clamp-2" title={item.name}>{item.name}</div>
                  <div className="text-xs text-gray-500 tabular-nums">{item.servingLabel ? `${item.servingLabel} · ` : ''}₹{parseFloat(item.price).toLocaleString('en-IN', { minimumFractionDigits: 2 })} each</div>
                </div>
                <div className="inline-flex items-center rounded-lg border border-gray-200 dark:border-gray-600 shrink-0">
                  <button type="button" aria-label="Decrease quantity" onClick={(e) => { e.stopPropagation(); updateCartQty(k, -1); }} className="size-10 md:size-8 grid place-items-center rounded-l-lg hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer">
                    {item.qty === 1 ? <Trash2 size={14} className="text-red-500" /> : <Minus size={14} />}
                  </button>
                  <span className="min-w-8 text-center font-mono text-sm font-semibold px-1">×{item.qty}</span>
                  <button type="button" aria-label="Increase quantity" onClick={(e) => { e.stopPropagation(); updateCartQty(k, 1); }} className="size-10 md:size-8 grid place-items-center rounded-r-lg hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer"><Plus size={14} /></button>
                </div>
                <span className="w-[4.75rem] text-right font-mono text-[13px] font-semibold shrink-0 tabular-nums">₹{(parseFloat(item.price) * item.qty).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
              </div>
            );
          })}
        </div>

        {undo && (
          <div id="undoBar" className="mx-4 mb-2 px-3 py-2 rounded-lg bg-gray-900 text-white text-xs flex items-center justify-between gap-2">
            <span className="truncate">Removed “{undo.label}”</span>
            <button type="button" id="undoBtn" onClick={doUndo} className="inline-flex items-center gap-1 font-bold text-emerald-300 hover:text-emerald-200 cursor-pointer shrink-0"><Undo2 size={13} aria-hidden="true" /> Undo</button>
          </div>
        )}

        <div className="p-4 border-t border-gray-200 dark:border-gray-700 space-y-3 bg-gray-50/60 dark:bg-gray-900/30 md:rounded-b-xl overflow-y-auto">
          <div className="flex justify-between text-xs text-gray-500">
            <span>Subtotal</span>
            <span className="font-mono">₹{money(cartSubtotal)}</span>
          </div>

          {/* Discount: a percentage or a rupee amount */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs">
              <span className="font-semibold text-gray-600 dark:text-gray-300 shrink-0">Discount</span>
              {discountMode === 'PCT' && (
                <div className="flex items-center gap-1 flex-1 min-w-0">
                  {[5, 10, 15, 20].filter((pct) => discountCap === null || pct <= discountCap).map((pct) => (
                    <button key={pct} type="button" aria-pressed={discountPercent === String(pct)} onClick={() => setDiscountPercent(discountPercent === String(pct) ? '' : String(pct))}
                      className={`px-2.5 py-1.5 rounded-md text-[11px] font-semibold transition-colors cursor-pointer border tabular-nums ${discountPercent === String(pct) ? 'bg-purple-600 text-white border-purple-600' : 'bg-white hover:bg-gray-100 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 border-gray-200 dark:border-gray-600'}`}>
                      {pct}%
                    </button>
                  ))}
                </div>
              )}
              <div className={`relative shrink-0 ${discountMode === 'PCT' ? 'w-20' : 'flex-1'}`}>
                {discountMode === 'PCT' ? (
                  <>
                    <input id="discountInput" type="number" inputMode="decimal" step="any" min="0" max={discountCap ?? 100}
                      className="w-full py-1.5 pl-2 pr-6 border border-gray-200 dark:border-gray-600 rounded-md text-right font-mono text-xs bg-white dark:bg-gray-700" placeholder="0" value={discountPercent}
                      onChange={(e) => { const v = e.target.value; setDiscountPercent(discountCap !== null && parseFloat(v) > discountCap ? String(discountCap) : v); }} />
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 font-semibold text-xs pointer-events-none">%</span>
                  </>
                ) : (
                  <>
                    <input id="discountAmount" type="number" inputMode="decimal" step="any" min="0"
                      className="w-full py-1.5 pl-6 pr-2 border border-gray-200 dark:border-gray-600 rounded-md text-right font-mono text-xs bg-white dark:bg-gray-700" placeholder="0" value={discountAmount}
                      onChange={(e) => setDiscountAmount(e.target.value)} />
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 font-semibold text-xs pointer-events-none">₹</span>
                  </>
                )}
              </div>
              <button type="button" id="discountModeBtn" title={discountMode === 'PCT' ? 'Enter the discount in rupees' : 'Enter the discount as a percentage'}
                onClick={() => { setDiscountMode(discountMode === 'PCT' ? 'AMT' : 'PCT'); setDiscountPercent(''); setDiscountAmount(''); }}
                className="px-2 py-1.5 rounded-md border border-gray-200 dark:border-gray-600 text-[11px] font-bold text-gray-600 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer">
                {discountMode === 'PCT' ? '₹' : '%'}
              </button>
            </div>
            {discountCap !== null && <div className="text-[11px] text-gray-500" id="discountCapHint">Discounts up to {discountCap}%. A bigger discount needs a manager.</div>}
            {discountVal > 0 && (
              <div className="flex justify-between items-center text-xs">
                <span className="text-gray-500">Discount applied ({discountPctNum.toFixed(discountPctNum % 1 === 0 ? 0 : 1)}%)
                  <button type="button" onClick={() => { setDiscountPercent(''); setDiscountAmount(''); }} className="ml-2 text-gray-400 hover:text-red-500 hover:underline cursor-pointer">Clear</button>
                </span>
                <span className="font-mono font-semibold text-emerald-700 dark:text-emerald-400 tabular-nums">−{inr(discountVal)}</span>
              </div>
            )}
          </div>

          <div className="flex justify-between items-baseline pt-1">
            <span className="font-semibold text-gray-600 dark:text-gray-300">Total</span>
            <span id="totalAmount" className="font-display font-bold text-[30px] leading-none tabular-nums text-gray-900 dark:text-gray-50">₹{money(cartTotal)}</span>
          </div>

          {/* How they pay */}
          <div className="grid grid-cols-4 gap-1.5" role="group" aria-label="Payment mode">
            {PAY_MODES.map(([m, Icon, label, hot]) => (
              <button key={m} type="button" id={`pay-${m}`} aria-pressed={paymentMode === m} aria-label={m} title={`${label} (Alt+${hot})`} onClick={() => setPaymentMode(m)}
                className={`py-2.5 px-1 text-xs font-semibold rounded-lg border cursor-pointer transition-colors flex flex-col items-center gap-1 ${paymentMode === m ? 'bg-purple-600 text-white border-purple-600 shadow-xs' : 'bg-white dark:bg-gray-700/60 border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:border-purple-300 dark:hover:border-purple-600'}`}>
                <Icon size={18} aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>

          {/* Cash: what they hand over and the change */}
          {paymentMode === 'CASH' && cart.length > 0 && (
            <div id="tenderBox" className="space-y-2 p-2.5 rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50/50 dark:bg-emerald-950/20">
              <div className="flex items-center gap-2">
                <label htmlFor="tenderInput" className="text-xs font-semibold text-gray-600 dark:text-gray-300 shrink-0">Cash received</label>
                <div className="relative flex-1">
                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-sm pointer-events-none">₹</span>
                  <input id="tenderInput" type="number" inputMode="decimal" min="0" step="any" placeholder={money(cartTotal)} value={received} onChange={(e) => setReceived(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void checkout(); } }}
                    className="w-full py-2 pl-6 pr-2 border border-gray-200 dark:border-gray-600 rounded-lg text-right font-mono text-sm bg-white dark:bg-gray-700" />
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {quickCashOptions(cartTotal).map((v, i) => (
                  <button key={v} type="button" data-tender={v} onClick={() => setReceived(i === 0 ? '' : String(v))}
                    className={`px-3 py-2 rounded-lg border text-xs font-semibold tabular-nums cursor-pointer ${(i === 0 && received === '') || received === String(v) ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white dark:bg-gray-700 border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:border-emerald-400'}`}>
                    {i === 0 ? 'Exact' : `₹${v.toLocaleString('en-IN')}`}
                  </button>
                ))}
              </div>
              <div id="changeDue" data-state={cash?.state} className={`flex items-baseline justify-between rounded-lg px-3 py-2 ${cash?.state === 'short' ? 'bg-red-100 dark:bg-red-950/40 text-red-800 dark:text-red-200' : cash?.state === 'ok' && cash.change > 0 ? 'bg-emerald-600 text-white' : 'bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300'}`}>
                <span className="text-xs font-semibold">{cash?.state === 'short' ? 'Still to collect' : cash?.state === 'ok' && cash.change > 0 ? 'Give back' : 'Exact amount'}</span>
                <span className="font-display font-bold text-xl tabular-nums">{cash?.state === 'short' ? `₹${money(cash.short)}` : cash?.state === 'ok' && cash.change > 0 ? `₹${money(cash.change)}` : '—'}</span>
              </div>
            </div>
          )}

          {paymentMode === 'CREDIT' && (
            <KhataPanel branchId={branchId} canSetLimit={canSetLimit} total={cartTotal} customer={creditCustomer} onSelect={setCreditCustomer} />
          )}

          <input id="posBuyerGstin" className="w-full px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg text-xs font-mono bg-white dark:bg-gray-700" placeholder="Buyer GSTIN (optional, B2B)" maxLength={15} value={buyerGstin} onChange={(e) => setBuyerGstin(e.target.value)} />
          {lastSync && <div id="lastSync" className="text-xs text-gray-500">{lastSync}</div>}
          <button
            id="checkoutBtn"
            onClick={checkout}
            disabled={cart.length === 0 || isPaying || cashShort}
            title="Checkout (F9)"
            className="w-full bg-purple-600 text-white py-4 rounded-xl text-base font-bold hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer shadow-xs transition-colors flex items-center justify-center gap-2"
          >
            {isPaying ? 'Processing…' : <>Checkout &amp; Print <span className="font-mono tabular-nums opacity-90">· ₹{money(cartTotal)}</span></>}
          </button>
        </div>
      </aside>

      {/* Phone: the cart is a bar at the bottom; tap it to open the sheet */}
      {!cartOpen && (
        <button type="button" id="cartBar" onClick={() => setCartOpen(true)} className="md:hidden fixed bottom-3 inset-x-3 z-30 flex items-center justify-between gap-3 px-4 py-3.5 rounded-2xl bg-purple-600 text-white shadow-lg cursor-pointer">
          <span className="flex items-center gap-2 font-semibold"><ShoppingBag size={18} aria-hidden="true" /> {itemCount === 0 ? 'Cart is empty' : `${itemCount} item${itemCount === 1 ? '' : 's'}`}</span>
          <span className="font-mono font-bold tabular-nums">₹{money(cartTotal)} <span className="font-sans font-semibold opacity-80">· View ›</span></span>
        </button>
      )}

      {/* Parked bills */}
      {parkedOpen && (
        <div className="fixed inset-0 bg-black/55 backdrop-blur-sm flex justify-center overflow-y-auto [&>*]:my-auto z-50 p-4" id="parkedList" onClick={() => setParkedOpen(false)}>
          <div className="bg-white dark:bg-gray-800 p-5 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 max-w-md w-full" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-3">
              <h2 className="text-lg font-bold">Parked bills</h2>
              <button type="button" onClick={() => setParkedOpen(false)} className="p-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer" aria-label="Close dialog"><X size={18} /></button>
            </div>
            {parked.length === 0 ? (
              <p className="text-sm text-gray-500 py-6 text-center">No parked bills. Press <kbd className="px-1.5 py-0.5 rounded border font-mono text-xs">F4</kbd> or “Park” to put the current bill on hold while you serve someone else.</p>
            ) : (
              <ul className="divide-y dark:divide-gray-700 max-h-[60dvh] overflow-y-auto">
                {parked.map((b) => (
                  <li key={b.id} data-parked={b.id} className="py-3 flex items-center gap-3">
                    <div className="flex-1 min-w-0 text-sm">
                      <div className="font-semibold">₹{parseFloat(b.total).toLocaleString('en-IN', { minimumFractionDigits: 2 })} <span className="font-normal text-gray-500">· {b.items} item{b.items === 1 ? '' : 's'}</span></div>
                      <div className="text-xs text-gray-500">Parked {fmtTime(b.parkedAt)}{b.customer ? ` · ${b.customer.name}` : ''}</div>
                    </div>
                    <button type="button" className="parked-resume px-3 py-2 text-xs font-semibold bg-purple-600 hover:bg-purple-700 text-white rounded-lg cursor-pointer" onClick={() => resume(b)}>Resume</button>
                    <button type="button" aria-label="Delete parked bill" className="parked-delete p-2 text-gray-400 hover:text-red-600 cursor-pointer" onClick={() => { const next = removeParked(parked, b.id); setParked(next); saveParked(localStorage, sub, next); }}><Trash2 size={16} /></button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* Serving (peg / glass / bottle) picker */}
      {servingPicker && (
        <div className="fixed inset-0 bg-black/55 backdrop-blur-sm flex justify-center overflow-y-auto [&>*]:my-auto z-50 p-4" id="servingPicker" onClick={() => setServingPicker(null)}>
          <div className="bg-white dark:bg-gray-800 p-5 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-2">
              <h2 className="text-lg font-bold">{servingPicker.name}</h2>
              <button type="button" onClick={() => setServingPicker(null)} className="p-1 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors" aria-label="Close dialog"><X size={18} /></button>
            </div>
            <div className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300 mb-3 bg-gray-50 dark:bg-gray-900/40 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700">
              <span>Sealed bottles: <strong className="text-gray-900 dark:text-white font-mono">{servingPicker.currentStock ?? servingPicker.stockQuantity ?? 0}</strong></span>
              <span>·</span>
              <span>Open bottle: <strong className="text-gray-900 dark:text-white font-mono">{servingPicker.openMl ?? 0} ml</strong></span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {servingPicker.servings!.map((s, i) => (
                <button key={s.id} type="button" className="serving-option relative p-4 border border-gray-200 dark:border-gray-600 rounded-xl hover:border-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20 text-center transition-colors cursor-pointer"
                  onClick={() => { addToCart(servingPicker, s); setServingPicker(null); focusSearch(); }}>
                  {i < 9 && <kbd className="absolute top-1.5 left-1.5 px-1 rounded border bg-gray-50 dark:bg-gray-900 text-[10px] font-mono text-gray-500">{i + 1}</kbd>}
                  <div className="font-semibold">{s.label}</div>
                  <div className="text-sm text-gray-500 tabular-nums">₹{parseFloat(s.price).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
                </button>
              ))}
            </div>
            <button type="button" className="mt-3 w-full py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 cursor-pointer" onClick={() => setServingPicker(null)}>Cancel</button>
          </div>
        </div>
      )}

      {/* Post-checkout modal */}
      {checkoutModal && (
        <div className="fixed inset-0 bg-black/55 backdrop-blur-sm flex justify-center overflow-y-auto [&>*]:my-auto z-50 p-4" id="checkoutModal">
          <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 max-w-sm w-full text-center relative">
            <button type="button" onClick={closeCheckoutModal} className="absolute top-4 right-4 p-1 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors" aria-label="Close dialog"><X size={18} /></button>
            <h2 className="text-xl font-bold mb-2" id="checkoutTitle">{checkoutModal.title}</h2>
            <div className="text-2xl text-purple-700 dark:text-purple-300 font-mono font-semibold mb-4" id="checkoutBillNo">{checkoutModal.billNumber}</div>
            <div className="text-gray-500 mb-4" id="checkoutSummary">
              {checkoutModal.offline
                ? 'Queued — will sync automatically when back online'
                : `₹${parseFloat(checkoutModal.total).toLocaleString('en-IN', { minimumFractionDigits: 2 })} collected via ${checkoutModal.paymentMode}${checkoutModal.customerName ? ` (${checkoutModal.customerName})` : ''}`}
            </div>
            {checkoutModal.change !== undefined && checkoutModal.change > 0 && (
              <div id="checkoutChange" className="mb-4 rounded-xl bg-emerald-600 text-white py-3">
                <div className="text-xs font-semibold opacity-90">Received ₹{money(checkoutModal.received ?? 0)} · give back</div>
                <div className="font-display font-bold text-3xl tabular-nums">₹{money(checkoutModal.change)}</div>
              </div>
            )}
            {!checkoutModal.offline && checkoutModal.billId && (
              <div className="flex gap-2 mb-3">
                <button type="button" id="printBillBtn" onClick={() => printInBrowser('bills', checkoutModal.billId!)} className="flex-1 border p-2.5 rounded text-sm hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer">Print bill</button>
                <button type="button" onClick={() => sendToNetworkPrinter('bills', checkoutModal.billId!)} className="flex-1 border p-2.5 rounded text-sm hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer">Send to printer</button>
              </div>
            )}
            <div className="flex gap-2">
              <button id="newBillBtn" autoFocus onClick={closeCheckoutModal} className="flex-1 bg-purple-600 hover:bg-purple-700 text-white py-3 rounded-lg font-semibold cursor-pointer">New Bill</button>
              {checkoutModal.offline && (
                <button id="checkoutHistoryBtn" onClick={() => { closeCheckoutModal(); navigate('/bills'); }} className="flex-1 bg-gray-200 text-gray-800 p-2 rounded cursor-pointer">View pending</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
