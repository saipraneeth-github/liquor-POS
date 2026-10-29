import { useState, useEffect } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';

interface StockRow {
  productId: string;
  name: string;
  brand?: string;
  volumeMl?: number;
  quantity: number;
  reorderLevel: number;
  mrp: string;
}

interface Product {
  id: string;
  name: string;
  barcode?: string;
  costPrice?: string;
  mrp: string;
}

interface InvoiceItem {
  id?: string;
  lineNumber: number;
  productId?: string | null;
  productName?: string;
  rawDescription: string;
  barcode?: string | null;
  quantity: number;
  costPrice: string;
  mrp: string;
  lineCostTotal: string;
  extractedAmount?: string;
  matchStatus: 'MATCHED' | 'MANUAL' | 'SUGGESTED' | 'UNMATCHED';
  flags: string[];
}

interface InvoiceHeader {
  id: string;
  supplierName: string;
  invoiceNumber: string;
  invoiceDate: string;
  totalAmount: string;
  linesTotal: string;
  status: 'DRAFT' | 'REVIEWED' | 'APPROVED' | 'REJECTED';
  source: string;
  notes?: string;
  extractionWarnings?: string[];
  rejectionReason?: string;
}

interface ActiveInvoiceData {
  invoice: InvoiceHeader;
  items: InvoiceItem[];
  attachment?: { filename: string } | null;
}

interface InvoiceHistoryRow {
  id: string;
  invoiceNumber: string;
  supplierName: string;
  invoiceDate: string;
  createdAt: string;
  source: string;
  lineCount: number;
  totalAmount: string;
  status: string;
  originalFilename?: string;
  unmatchedCount: number;
  flagCount: number;
}

export function Inventory() {
  const { user } = useAuth();
  const branchId = user?.branchId;
  const isManager = user?.role === 'manager' || user?.role === 'owner';

  const [stockRows, setStockRows] = useState<StockRow[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loadingStock, setLoadingStock] = useState(false);

  // Breakage form
  const [breakProduct, setBreakProduct] = useState('');
  const [breakQty, setBreakQty] = useState('1');
  const [breakReason, setBreakReason] = useState('');
  const [breakLog, setBreakLog] = useState<any[]>([]);

  // Supplier Invoices
  const [invoices, setInvoices] = useState<InvoiceHistoryRow[]>([]);
  const [filterStatus, setFilterStatus] = useState('');
  const [filterQ, setFilterQ] = useState('');
  const [activeInvoice, setActiveInvoice] = useState<ActiveInvoiceData | null>(null);

  // Upload state
  const [uploadSupplier, setUploadSupplier] = useState('');
  const [uploadNumber, setUploadNumber] = useState('');
  const [uploadDate, setUploadDate] = useState('');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  // Modal
  const [confirmModal, setConfirmModal] = useState<{
    title: string;
    message: string;
    onOk: () => void;
  } | null>(null);

  const showToast = (msg: string, type: 'success' | 'error' | 'info' = 'success') => {
    const host = document.getElementById('toastHost');
    if (!host) return;
    const el = document.createElement('div');
    el.className = `toast ${type} ${
      type === 'error' ? 'bg-red-600' : type === 'info' ? 'bg-blue-600' : 'bg-emerald-600'
    } text-white p-3 rounded shadow`;
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  };

  const loadStock = async () => {
    if (!branchId) return;
    setLoadingStock(true);
    try {
      const [stockData, prodData] = await Promise.all([
        api.get<StockRow[]>('/inventory/stock/' + branchId),
        api.get<{ products: Product[] }>('/products'),
      ]);
      stockData.sort((a, b) => a.name.localeCompare(b.name));
      setStockRows(stockData);
      setProducts(prodData.products);
      if (stockData.length && !breakProduct) {
        setBreakProduct(stockData[0].productId);
      }
    } catch (err: any) {
      showToast('Failed to load stock: ' + err.message, 'error');
    } finally {
      setLoadingStock(false);
    }
  };

  const loadInvoices = async () => {
    if (!branchId) return;
    const qs = new URLSearchParams({ limit: '50' });
    if (filterStatus) qs.set('status', filterStatus);
    if (filterQ.trim()) qs.set('q', filterQ.trim());
    try {
      const res = await api.get<{ items: InvoiceHistoryRow[] }>(`/invoices/${branchId}?${qs}`);
      setInvoices(res.items);
    } catch {
      // quiet fail
    }
  };

  const loadBreakage = async () => {
    if (!branchId || !isManager) return;
    const today = new Date().toISOString().slice(0, 10);
    const past = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    try {
      const res = await api.get<{ entries: any[] }>(`/compliance/breakage/${branchId}?from=${past}&to=${today}`);
      setBreakLog(res.entries);
    } catch {
      // quiet fail
    }
  };

  useEffect(() => {
    loadStock();
    loadInvoices();
    loadBreakage();
  }, [branchId]);

  const handleRecordBreakage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!branchId) return;
    const qty = parseInt(breakQty, 10);
    if (isNaN(qty) || qty < 1) {
      showToast('Quantity must be at least 1.', 'error');
      return;
    }
    if (breakReason.trim().length < 3) {
      showToast('Give a reason (3+ characters).', 'error');
      return;
    }
    try {
      const res = await api.post<{ stockQuantity: number }>('/compliance/breakage/' + branchId, {
        productId: breakProduct,
        quantity: qty,
        reason: breakReason.trim(),
      });
      showToast(`Breakage recorded — stock now ${res.stockQuantity}`, 'success');
      setBreakReason('');
      await loadStock();
      if (isManager) loadBreakage();
    } catch (err: any) {
      showToast('Breakage failed: ' + err.message, 'error');
    }
  };

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!branchId) return;
    if (!uploadFile) {
      showToast('Choose an invoice file to upload.', 'error');
      return;
    }
    const fd = new FormData();
    if (uploadSupplier.trim()) fd.append('supplierName', uploadSupplier.trim());
    if (uploadNumber.trim()) fd.append('invoiceNumber', uploadNumber.trim());
    if (uploadDate) fd.append('invoiceDate', uploadDate);
    fd.append('file', uploadFile);

    setUploading(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`/api/v1/invoices/${branchId}/upload`, {
        method: 'POST',
        headers: token ? { Authorization: 'Bearer ' + token } : {},
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 409 && data.existingInvoiceId) {
          showToast(data.error + ' — opening existing invoice.', 'info');
          await openInvoice(data.existingInvoiceId);
          return;
        }
        throw new Error(data.message || data.error || 'Upload error');
      }
      showToast(`Extracted ${data.items.length} lines from ${uploadFile.name}`, 'success');
      setUploadFile(null);
      setUploadSupplier('');
      setUploadNumber('');
      setUploadDate('');
      setActiveInvoice(data);
      loadInvoices();
    } catch (err: any) {
      showToast('Upload failed: ' + err.message, 'error');
    } finally {
      setUploading(false);
    }
  };

  const openInvoice = async (id: string) => {
    try {
      const data = await api.get<ActiveInvoiceData>('/invoices/detail/' + id);
      setActiveInvoice(data);
    } catch (err: any) {
      showToast('Failed to load invoice: ' + err.message, 'error');
    }
  };

  const handleProductChange = (idx: number, prodId: string) => {
    if (!activeInvoice) return;
    const items = [...activeInvoice.items];
    const item = { ...items[idx] };
    const p = products.find((x) => x.id === prodId);
    if (p) {
      item.productId = p.id;
      item.productName = p.name;
      item.matchStatus = 'MANUAL';
      if (!item.costPrice || item.costPrice === '0.00') item.costPrice = p.costPrice || '500.00';
      if (!item.mrp || item.mrp === '0.00') item.mrp = p.mrp;
      item.lineCostTotal = (item.quantity * parseFloat(item.costPrice)).toFixed(2);
    } else {
      item.productId = null;
      item.productName = undefined;
      item.matchStatus = 'UNMATCHED';
    }
    items[idx] = item;
    setActiveInvoice({ ...activeInvoice, items });
  };

  const handleLineQtyChange = (idx: number, qtyVal: string) => {
    if (!activeInvoice) return;
    const items = [...activeInvoice.items];
    const qty = parseInt(qtyVal, 10) || 0;
    const item = { ...items[idx], quantity: qty };
    item.lineCostTotal = (qty * parseFloat(item.costPrice || '0')).toFixed(2);
    items[idx] = item;
    setActiveInvoice({ ...activeInvoice, items });
  };

  const handleLineCostChange = (idx: number, costVal: string) => {
    if (!activeInvoice) return;
    const items = [...activeInvoice.items];
    const cost = parseFloat(costVal) || 0;
    const item = { ...items[idx], costPrice: costVal };
    item.lineCostTotal = (item.quantity * cost).toFixed(2);
    items[idx] = item;
    setActiveInvoice({ ...activeInvoice, items });
  };

  const handleLineMrpChange = (idx: number, mrpVal: string) => {
    if (!activeInvoice) return;
    const items = [...activeInvoice.items];
    items[idx] = { ...items[idx], mrp: mrpVal };
    setActiveInvoice({ ...activeInvoice, items });
  };

  const handleLineDescChange = (idx: number, descVal: string) => {
    if (!activeInvoice) return;
    const items = [...activeInvoice.items];
    items[idx] = { ...items[idx], rawDescription: descVal };
    setActiveInvoice({ ...activeInvoice, items });
  };

  const saveDraft = async (silent = false): Promise<boolean> => {
    if (!activeInvoice) return false;
    const inv = activeInvoice.invoice;
    const payload = {
      supplierName: inv.supplierName,
      invoiceNumber: inv.invoiceNumber,
      invoiceDate: inv.invoiceDate,
      totalAmount: inv.totalAmount,
      items: activeInvoice.items.map((it) => ({
        ...(it.id ? { id: it.id } : {}),
        productId: it.productId || null,
        confirmMatch: it.matchStatus === 'MANUAL',
        rawDescription: it.rawDescription,
        quantity: it.quantity,
        costPrice: it.costPrice,
        mrp: it.mrp,
      })),
    };
    try {
      const updated = await api.put<ActiveInvoiceData>('/invoices/detail/' + inv.id, payload);
      setActiveInvoice(updated);
      loadInvoices();
      if (!silent) showToast('Invoice draft saved', 'success');
      return true;
    } catch (err: any) {
      showToast('Save failed: ' + err.message, 'error');
      return false;
    }
  };

  const handleReview = async () => {
    if (!activeInvoice) return;
    const ok = await saveDraft(true);
    if (!ok) return;
    try {
      const updated = await api.post<ActiveInvoiceData>(`/invoices/detail/${activeInvoice.invoice.id}/review`, {});
      setActiveInvoice(updated);
      loadInvoices();
      showToast('Invoice marked as reviewed', 'success');
    } catch (err: any) {
      showToast('Review failed: ' + err.message, 'error');
    }
  };

  const handleApprove = () => {
    if (!activeInvoice) return;
    const totalBottles = activeInvoice.items.reduce((sum, it) => sum + (it.quantity || 0), 0);
    setConfirmModal({
      title: 'Approve supplier invoice?',
      message: `Approves invoice ${activeInvoice.invoice.invoiceNumber}, adds ${totalBottles} bottles to stock and posts a purchase voucher for ₹${parseFloat(activeInvoice.invoice.linesTotal || activeInvoice.invoice.totalAmount).toFixed(2)}.`,
      onOk: async () => {
        setConfirmModal(null);
        const ok = await saveDraft(true);
        if (!ok) return;
        try {
          const updated = await api.post<ActiveInvoiceData>(`/invoices/detail/${activeInvoice.invoice.id}/approve`, {});
          setActiveInvoice(updated);
          showToast('Supplier invoice approved — stock & accounts updated', 'success');
          await loadStock();
          loadInvoices();
        } catch (err: any) {
          showToast('Approval failed: ' + err.message, 'error');
        }
      },
    });
  };

  const lowCount = stockRows.filter((r) => r.quantity > 0 && r.quantity <= r.reorderLevel).length;
  const outCount = stockRows.filter((r) => r.quantity <= 0).length;
  const totalBottles = stockRows.reduce((sum, r) => sum + r.quantity, 0);

  return (
    <section className="page active" id="page-stock" aria-labelledby="stockTitle">
      <div className="row between flex justify-between items-center mb-4">
        <div>
          <h2 className="h1 text-xl font-bold" id="stockTitle">📦 Inventory</h2>
          <div className="muted small text-xs text-gray-500">
            Live stock levels, reorder suggestions, breakage and supplier inward.
          </div>
        </div>
        <button
          className="btn-sec px-3 py-1 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded border font-medium text-sm"
          type="button"
          onClick={loadStock}
        >
          ↻ Refresh
        </button>
      </div>

      <div className="stats grid grid-cols-2 md:grid-cols-4 gap-4 mb-4" id="stockStats">
        <div className="stat-card p-3 bg-white rounded shadow border">
          <div className="stat-label text-xs text-gray-500">SKUs stocked</div>
          <div className="stat-value font-mono text-xl font-bold">{stockRows.length}</div>
        </div>
        <div className="stat-card p-3 bg-white rounded shadow border">
          <div className="stat-label text-xs text-gray-500">Bottles on hand</div>
          <div className="stat-value font-mono text-xl font-bold">{totalBottles.toLocaleString('en-IN')}</div>
        </div>
        <div className="stat-card p-3 bg-white rounded shadow border">
          <div className="stat-label text-xs text-gray-500">⚠ Low stock</div>
          <div className="stat-value font-mono text-xl font-bold text-yellow-600">{lowCount}</div>
        </div>
        <div className="stat-card p-3 bg-white rounded shadow border">
          <div className="stat-label text-xs text-gray-500">🚫 Out of stock</div>
          <div className="stat-value font-mono text-xl font-bold text-red-600">{outCount}</div>
        </div>
      </div>

      <div className="card bg-white rounded shadow mb-6">
        <div className="pad h2 p-4 pb-2 text-lg font-bold border-b">Current stock</div>
        <div className="table-wrap overflow-x-auto p-4" id="stockTable">
          {loadingStock ? (
            <div className="text-gray-500 text-sm">Loading stock…</div>
          ) : (
            <table className="table w-full text-left">
              <thead>
                <tr className="border-b text-xs text-gray-500 bg-gray-50">
                  <th className="py-2 px-3">Product</th>
                  <th className="py-2 px-3 text-right">In stock</th>
                  <th className="py-2 px-3 text-right">Reorder level</th>
                  <th className="py-2 px-3">Status</th>
                  <th className="py-2 px-3 text-right">MRP</th>
                </tr>
              </thead>
              <tbody>
                {stockRows.map((r) => (
                  <tr key={r.productId} className="border-b hover:bg-gray-50 text-sm">
                    <td className="py-2 px-3">
                      <b>{r.name}</b>
                      {r.brand && (
                        <div className="muted small text-xs text-gray-500">
                          {r.brand} {r.volumeMl ? `· ${r.volumeMl}ml` : ''}
                        </div>
                      )}
                    </td>
                    <td className="py-2 px-3 text-right font-mono font-bold">{r.quantity}</td>
                    <td className="py-2 px-3 text-right font-mono">{r.reorderLevel}</td>
                    <td className="py-2 px-3">
                      {r.quantity <= 0 ? (
                        <span className="badge red bg-red-100 text-red-800 text-xs px-2 py-0.5 rounded">
                          Out of stock
                        </span>
                      ) : r.quantity <= r.reorderLevel ? (
                        <span className="badge yellow bg-yellow-100 text-yellow-800 text-xs px-2 py-0.5 rounded">
                          Low
                        </span>
                      ) : (
                        <span className="badge green bg-green-100 text-green-800 text-xs px-2 py-0.5 rounded">
                          OK
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-3 text-right font-mono">₹{parseFloat(r.mrp).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Breakage */}
      <div className="two-col grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
        <div className="card pad stack p-4 bg-white rounded shadow flex flex-col gap-3">
          <div className="h2 text-lg font-bold">💥 Record breakage</div>
          <form className="form-grid flex flex-col gap-3" onSubmit={handleRecordBreakage}>
            <label className="field flex flex-col gap-1 text-sm font-medium" htmlFor="breakProduct">
              Product
              <select
                id="breakProduct"
                className="input p-2 border rounded"
                value={breakProduct}
                onChange={(e) => setBreakProduct(e.target.value)}
                required
              >
                {stockRows.map((r) => (
                  <option key={r.productId} value={r.productId}>
                    {r.name} ({r.quantity} in stock)
                  </option>
                ))}
              </select>
            </label>
            <label className="field flex flex-col gap-1 text-sm font-medium" htmlFor="breakQty">
              Bottles
              <input
                id="breakQty"
                className="input p-2 border rounded"
                type="number"
                min="1"
                value={breakQty}
                onChange={(e) => setBreakQty(e.target.value)}
                required
              />
            </label>
            <label className="field flex flex-col gap-1 text-sm font-medium" htmlFor="breakReason">
              Reason
              <input
                id="breakReason"
                className="input p-2 border rounded"
                required
                minLength={3}
                maxLength={500}
                placeholder="Dropped while shelving"
                value={breakReason}
                onChange={(e) => setBreakReason(e.target.value)}
              />
            </label>
            <button
              className="btn-primary mt-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium"
              type="submit"
              id="breakSubmit"
            >
              Record breakage
            </button>
          </form>
        </div>

        {isManager && (
          <div className="card pad stack mgr-only p-4 bg-white rounded shadow flex flex-col gap-3">
            <div className="h2 text-lg font-bold">Breakage log (last 30 days)</div>
            <div id="breakLog" className="table-wrap overflow-x-auto text-sm">
              {breakLog.length === 0 ? (
                <div className="muted small text-gray-500">No breakage recorded in the last 30 days.</div>
              ) : (
                <table className="table w-full text-left">
                  <thead>
                    <tr className="border-b text-xs text-gray-500">
                      <th className="py-1">When</th>
                      <th className="py-1">Product</th>
                      <th className="py-1 text-right">Qty</th>
                      <th className="py-1 text-right">Cost</th>
                      <th className="py-1">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {breakLog.map((b) => (
                      <tr key={b.id} className="border-b">
                        <td className="py-1 text-xs">{new Date(b.createdAt).toLocaleDateString()}</td>
                        <td className="py-1">{b.productName}</td>
                        <td className="py-1 text-right font-mono">{b.quantity}</td>
                        <td className="py-1 text-right font-mono">₹{parseFloat(b.costValue).toFixed(2)}</td>
                        <td className="py-1 text-xs text-gray-500">{b.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Supplier Invoices */}
      <div className="card pad stack p-4 bg-white rounded shadow mb-6 flex flex-col gap-4" id="supplierInvoicesCard">
        <div className="row between flex justify-between items-center border-b pb-3">
          <div>
            <div className="h2 text-lg font-bold">📄 Supplier invoices (upload, review &amp; inward)</div>
            <div className="muted small text-xs text-gray-500">
              Upload CSV, Excel (.xlsx), PDF or invoice photo for local extraction &amp; catalog matching.
            </div>
          </div>
        </div>

        <form className="row end flex flex-wrap items-end gap-3" id="invUploadForm" onSubmit={handleUpload}>
          <label className="field grow flex flex-col gap-1 text-sm font-medium" htmlFor="invUploadFile" style={{ minWidth: '220px' }}>
            Invoice file (CSV, XLSX, PDF, PNG, JPG ≤ 10 MB)
            <input
              id="invUploadFile"
              className="input input-sm p-1.5 border rounded text-sm"
              type="file"
              accept=".csv,.xlsx,.pdf,.png,.jpg,.jpeg"
              required
              onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
            />
          </label>
          <label className="field flex flex-col gap-1 text-sm font-medium" htmlFor="invUploadSupplier" style={{ width: '180px' }}>
            Supplier (optional)
            <input
              id="invUploadSupplier"
              className="input input-sm p-1.5 border rounded text-sm"
              maxLength={200}
              placeholder="Auto-detected"
              value={uploadSupplier}
              onChange={(e) => setUploadSupplier(e.target.value)}
            />
          </label>
          <label className="field flex flex-col gap-1 text-sm font-medium" htmlFor="invUploadNumber" style={{ width: '150px' }}>
            Invoice no. (optional)
            <input
              id="invUploadNumber"
              className="input input-sm p-1.5 border rounded text-sm"
              maxLength={60}
              placeholder="Auto-detected"
              value={uploadNumber}
              onChange={(e) => setUploadNumber(e.target.value)}
            />
          </label>
          <label className="field flex flex-col gap-1 text-sm font-medium" htmlFor="invUploadDate" style={{ width: '145px' }}>
            Date (optional)
            <input
              id="invUploadDate"
              className="input input-sm p-1.5 border rounded text-sm"
              type="date"
              value={uploadDate}
              onChange={(e) => setUploadDate(e.target.value)}
            />
          </label>
          <button
            className="btn-primary btn-sm px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium text-sm disabled:opacity-50"
            type="submit"
            id="invUploadBtn"
            disabled={uploading}
            style={{ minHeight: '34px' }}
          >
            {uploading ? 'Extracting…' : '⬆ Upload & extract'}
          </button>
        </form>

        {/* Invoice Detail Box */}
        {activeInvoice && (
          <div id="invDetailBox" className="card pad stack p-4 bg-gray-50 rounded border flex flex-col gap-4 mt-2">
            <div className="row between flex justify-between items-center border-b pb-2">
              <div className="row flex items-center gap-2">
                <div className="h2 text-base font-bold">
                  {activeInvoice.invoice.id ? `Invoice ${activeInvoice.invoice.invoiceNumber}` : 'New invoice draft'}
                </div>
                <span className="badge px-2 py-0.5 rounded text-xs font-semibold bg-yellow-100 text-yellow-800">
                  {activeInvoice.invoice.status}
                </span>
                <span className="badge px-2 py-0.5 rounded text-xs font-semibold bg-purple-100 text-purple-800">
                  {activeInvoice.invoice.source || 'MANUAL'}
                </span>
              </div>
              <button
                type="button"
                className="btn-ghost text-gray-500 hover:text-gray-800 text-sm"
                onClick={() => setActiveInvoice(null)}
              >
                ✕ Close
              </button>
            </div>

            <div className="form-grid grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
              <label className="field flex flex-col gap-1 text-xs font-medium" htmlFor="invEditSupplier">
                Supplier
                <input
                  id="invEditSupplier"
                  className="input input-sm p-1.5 border rounded text-sm bg-white"
                  value={activeInvoice.invoice.supplierName || ''}
                  onChange={(e) =>
                    setActiveInvoice({
                      ...activeInvoice,
                      invoice: { ...activeInvoice.invoice, supplierName: e.target.value },
                    })
                  }
                />
              </label>
              <label className="field flex flex-col gap-1 text-xs font-medium" htmlFor="invEditNumber">
                Invoice number
                <input
                  id="invEditNumber"
                  className="input input-sm p-1.5 border rounded text-sm bg-white"
                  value={activeInvoice.invoice.invoiceNumber || ''}
                  onChange={(e) =>
                    setActiveInvoice({
                      ...activeInvoice,
                      invoice: { ...activeInvoice.invoice, invoiceNumber: e.target.value },
                    })
                  }
                />
              </label>
              <label className="field flex flex-col gap-1 text-xs font-medium" htmlFor="invEditDate">
                Invoice date
                <input
                  id="invEditDate"
                  className="input input-sm p-1.5 border rounded text-sm bg-white"
                  type="date"
                  value={activeInvoice.invoice.invoiceDate ? activeInvoice.invoice.invoiceDate.slice(0, 10) : ''}
                  onChange={(e) =>
                    setActiveInvoice({
                      ...activeInvoice,
                      invoice: { ...activeInvoice.invoice, invoiceDate: e.target.value },
                    })
                  }
                />
              </label>
              <label className="field flex flex-col gap-1 text-xs font-medium" htmlFor="invEditTotal">
                Document total (₹)
                <input
                  id="invEditTotal"
                  className="input input-sm p-1.5 border rounded text-sm font-mono bg-white"
                  value={activeInvoice.invoice.totalAmount || '0.00'}
                  onChange={(e) =>
                    setActiveInvoice({
                      ...activeInvoice,
                      invoice: { ...activeInvoice.invoice, totalAmount: e.target.value },
                    })
                  }
                />
              </label>
            </div>

            <div className="table-wrap overflow-x-auto">
              <table className="table table-compact w-full text-left bg-white rounded border" id="invEditTable">
                <thead>
                  <tr className="border-b text-xs text-gray-500 bg-gray-50">
                    <th className="py-2 px-2">#</th>
                    <th className="py-2 px-2">Description</th>
                    <th className="py-2 px-2">Catalog product</th>
                    <th className="py-2 px-2 text-right">Bottles</th>
                    <th className="py-2 px-2 text-right">Cost</th>
                    <th className="py-2 px-2 text-right">MRP</th>
                    <th className="py-2 px-2 text-right">Line total</th>
                  </tr>
                </thead>
                <tbody id="invEditLines">
                  {activeInvoice.items.map((it, idx) => (
                    <tr
                      key={it.id || idx}
                      className="inv-edit-row border-b text-sm"
                      data-item-id={it.id || ''}
                      data-match-status={it.matchStatus}
                    >
                      <td className="py-2 px-2 text-xs text-gray-500">{idx + 1}</td>
                      <td className="py-2 px-2">
                        <input
                          className="input input-sm ie-desc p-1 border rounded text-sm w-full"
                          value={it.rawDescription}
                          onChange={(e) => handleLineDescChange(idx, e.target.value)}
                        />
                      </td>
                      <td className="py-2 px-2">
                        <select
                          className="input input-sm ie-prod p-1 border rounded text-sm w-full"
                          value={it.productId || ''}
                          onChange={(e) => handleProductChange(idx, e.target.value)}
                        >
                          <option value="">— Select product —</option>
                          {products.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name} (₹{parseFloat(p.mrp).toFixed(2)})
                            </option>
                          ))}
                        </select>
                        <div className="mt-1">
                          <span className="ie-match-badge">
                            <span
                              className={`badge text-xs px-2 py-0.5 rounded font-medium ${
                                it.matchStatus === 'MATCHED' || it.matchStatus === 'MANUAL'
                                  ? 'bg-green-100 text-green-800'
                                  : it.matchStatus === 'SUGGESTED'
                                  ? 'bg-yellow-100 text-yellow-800'
                                  : 'bg-red-100 text-red-800'
                              }`}
                            >
                              {it.matchStatus}
                            </span>
                          </span>
                        </div>
                      </td>
                      <td className="py-2 px-2 text-right">
                        <input
                          className="input input-sm ie-qty p-1 border rounded text-right font-mono text-sm w-20"
                          type="number"
                          min="1"
                          value={it.quantity}
                          onChange={(e) => handleLineQtyChange(idx, e.target.value)}
                        />
                      </td>
                      <td className="py-2 px-2 text-right">
                        <input
                          className="input input-sm ie-cost p-1 border rounded text-right font-mono text-sm w-24"
                          value={it.costPrice}
                          onChange={(e) => handleLineCostChange(idx, e.target.value)}
                        />
                      </td>
                      <td className="py-2 px-2 text-right">
                        <input
                          className="input input-sm ie-mrp p-1 border rounded text-right font-mono text-sm w-24"
                          value={it.mrp}
                          onChange={(e) => handleLineMrpChange(idx, e.target.value)}
                        />
                      </td>
                      <td className="py-2 px-2 text-right font-mono font-bold">
                        <span className="ie-linetotal">₹{parseFloat(it.lineCostTotal).toFixed(2)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="row between flex justify-between items-center pt-2">
              <span className="small muted text-xs text-gray-500" id="invEditComputed">
                Lines total: <b>₹{activeInvoice.items.reduce((s, it) => s + parseFloat(it.lineCostTotal || '0'), 0).toFixed(2)}</b>
              </span>
              <div className="row flex items-center gap-2">
                <button
                  type="button"
                  className="btn-sec px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded border font-medium text-sm"
                  id="invSaveDraftBtn"
                  onClick={() => saveDraft()}
                >
                  💾 Save draft
                </button>
                {isManager && activeInvoice.invoice.status === 'DRAFT' && (
                  <button
                    type="button"
                    className="btn-sec px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded border border-blue-200 font-medium text-sm"
                    id="invReviewBtn"
                    onClick={handleReview}
                  >
                    ✓ Mark reviewed
                  </button>
                )}
                {isManager && (
                  <button
                    type="button"
                    className="btn-primary px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-medium text-sm"
                    id="invApproveBtn"
                    onClick={handleApprove}
                  >
                    ✅ Approve &amp; add stock
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Invoice History */}
        <div className="stack flex flex-col gap-2 mt-4">
          <div className="row between flex justify-between items-center">
            <div className="h2 text-base font-bold">Invoice history</div>
            <div className="row flex items-center gap-2">
              <select
                id="invFilterStatus"
                className="input input-sm p-1.5 border rounded text-xs"
                style={{ width: '130px' }}
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
              >
                <option value="">All</option>
                <option value="DRAFT">DRAFT</option>
                <option value="REVIEWED">REVIEWED</option>
                <option value="APPROVED">APPROVED</option>
                <option value="REJECTED">REJECTED</option>
              </select>
              <input
                id="invFilterQ"
                className="input input-sm p-1.5 border rounded text-xs"
                style={{ width: '180px' }}
                placeholder="Supplier or invoice no."
                value={filterQ}
                onChange={(e) => setFilterQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    loadInvoices();
                  }
                }}
              />
              <button
                className="btn-sec btn-sm px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded border font-medium text-xs"
                type="button"
                onClick={loadInvoices}
              >
                Filter
              </button>
            </div>
          </div>

          <div id="invHistoryBox" className="table-wrap overflow-x-auto text-sm">
            {invoices.length === 0 ? (
              <div className="p-4 text-center text-gray-500">No supplier invoices found.</div>
            ) : (
              <table className="table table-compact w-full text-left">
                <thead>
                  <tr className="border-b text-xs text-gray-500 bg-gray-50">
                    <th className="py-2 px-2">Invoice No.</th>
                    <th className="py-2 px-2">Supplier</th>
                    <th className="py-2 px-2">Date</th>
                    <th className="py-2 px-2">Source</th>
                    <th className="py-2 px-2 text-right">Lines</th>
                    <th className="py-2 px-2 text-right">Total</th>
                    <th className="py-2 px-2">Status</th>
                    <th className="py-2 px-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv) => (
                    <tr
                      key={inv.id}
                      className="inv-history-row border-b hover:bg-gray-50"
                      data-invoice-id={inv.id}
                      data-invoice-number={inv.invoiceNumber}
                    >
                      <td className="py-2 px-2">
                        <b>{inv.invoiceNumber}</b>
                        {inv.originalFilename && (
                          <div className="muted small text-xs text-gray-500">{inv.originalFilename}</div>
                        )}
                      </td>
                      <td className="py-2 px-2">{inv.supplierName || '—'}</td>
                      <td className="py-2 px-2 text-xs text-gray-600">
                        {inv.invoiceDate ? new Date(inv.invoiceDate).toLocaleDateString() : new Date(inv.createdAt).toLocaleDateString()}
                      </td>
                      <td className="py-2 px-2">
                        <span className="badge text-xs px-2 py-0.5 rounded bg-purple-100 text-purple-800">
                          {inv.source}
                        </span>
                      </td>
                      <td className="py-2 px-2 text-right font-mono">{inv.lineCount}</td>
                      <td className="py-2 px-2 text-right font-mono font-bold">₹{parseFloat(inv.totalAmount).toFixed(2)}</td>
                      <td className="py-2 px-2">
                        <span
                          className={`badge text-xs px-2 py-0.5 rounded font-medium ${
                            inv.status === 'APPROVED'
                              ? 'bg-green-100 text-green-800'
                              : inv.status === 'REVIEWED'
                              ? 'bg-blue-100 text-blue-800'
                              : inv.status === 'REJECTED'
                              ? 'bg-red-100 text-red-800'
                              : 'bg-yellow-100 text-yellow-800'
                          }`}
                        >
                          {inv.status}
                        </span>
                      </td>
                      <td className="py-2 px-2 text-right">
                        <button
                          type="button"
                          className="btn-sec btn-sm px-2 py-1 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded border text-xs"
                          onClick={() => openInvoice(inv.id)}
                        >
                          Open
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {confirmModal && (
        <div id="modal" className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
            <h3 className="text-lg font-bold mb-2" id="confirmTitle">{confirmModal.title}</h3>
            <p className="text-gray-600 mb-6 text-sm" id="confirmText">{confirmModal.message}</p>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                id="confirmCancel"
                className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded border font-medium text-sm"
                onClick={() => setConfirmModal(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                id="confirmOk"
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium text-sm"
                onClick={confirmModal.onOk}
              >
                Approve
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

