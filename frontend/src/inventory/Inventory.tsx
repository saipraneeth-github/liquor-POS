import { useState, useEffect, useRef, useCallback } from 'react';
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

interface Category {
  id: string;
  name: string;
  taxRate?: string;
}

interface Product {
  id: string;
  name: string;
  barcode?: string;
  sku?: string;
  costPrice?: string;
  mrp: string;
  categoryId?: string;
  categoryName?: string;
  volumeMl?: number;
  packQuantity?: number;
  brand?: string;
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
  taxRate?: string;
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

interface DuplicateCheckResult {
  exists: boolean;
  message?: string;
  invoice?: {
    id: string;
    invoiceNumber: string;
    supplierName: string;
    invoiceDate: string | null;
    createdAt: string | null;
    status: string;
    totalAmount: string;
  };
}

interface CreateProductModalState {
  lineIdx: number;
  rawDescription: string;
  categoryId: string;
  name: string;
  brand: string;
  volumeMl: string;
  packQuantity: string;
  mrp: string;
  costPrice: string;
  barcode: string;
  sku: string;
  exciseCode: string;
}

export function Inventory() {
  const { user } = useAuth();
  const branchId = user?.branchId;
  const isManager = user?.role === 'manager' || user?.role === 'owner';

  // Navigation tab: 'upload' = Bill Inward Wizard, 'history' = Bill History, 'stock' = Store Stock & Breakage
  const [activeTab, setActiveTab] = useState<'upload' | 'history' | 'stock'>('upload');

  // Wizard Step for Bill Inward:
  // Step 1: Upload / Choose Bill
  // Step 2: Check & Match Items
  // Step 3: Review & Confirm Inward
  const [wizardStep, setWizardStep] = useState<1 | 2 | 3>(1);

  // Store Stock State
  const [stockRows, setStockRows] = useState<StockRow[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loadingStock, setLoadingStock] = useState(false);

  // Breakage Form
  const [breakProduct, setBreakProduct] = useState('');
  const [breakQty, setBreakQty] = useState('1');
  const [breakReason, setBreakReason] = useState('');
  const [breakLog, setBreakLog] = useState<any[]>([]);

  // Supplier Invoices History
  const [invoices, setInvoices] = useState<InvoiceHistoryRow[]>([]);
  const [filterStatus, setFilterStatus] = useState('');
  const [filterQ, setFilterQ] = useState('');
  const [loadingInvoices, setLoadingInvoices] = useState(false);

  // Active Draft being reviewed/edited
  const [activeInvoice, setActiveInvoice] = useState<ActiveInvoiceData | null>(null);

  // Upload Form State (Step 1)
  const [uploadSupplier, setUploadSupplier] = useState('');
  const [uploadNumber, setUploadNumber] = useState('');
  const [uploadDate, setUploadDate] = useState('');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isDragActive, setIsDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Real-time Duplicate Invoice Check (Step 1)
  const [dupCheckStatus, setDupCheckStatus] = useState<'idle' | 'checking' | 'duplicate' | 'available'>('idle');
  const [dupCheckMsg, setDupCheckMsg] = useState<string>('');
  const [dupCheckExisting, setDupCheckExisting] = useState<DuplicateCheckResult['invoice'] | null>(null);
  const dupDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Real-time Duplicate Check in Editor (Step 2)
  const [editDupStatus, setEditDupStatus] = useState<'idle' | 'checking' | 'duplicate' | 'available'>('idle');
  const [editDupMsg, setEditDupMsg] = useState<string>('');
  const editDupDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Secondary details expansion toggle (per row index)
  const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({});

  // Add Missing Product Modal State
  const [createProductModal, setCreateProductModal] = useState<CreateProductModalState | null>(null);
  const [savingProduct, setSavingProduct] = useState(false);
  const [productFormError, setProductFormError] = useState<string | null>(null);

  // Confirmation Modal
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
    } text-white p-3 rounded-lg shadow-lg font-medium text-sm flex items-center gap-2 mb-2`;
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => el.remove(), 4500);
  };

  // ── Data Fetching ──────────────────────────────────────────────────────────

  const loadStock = async () => {
    if (!branchId) return;
    setLoadingStock(true);
    try {
      const [stockData, prodData, catData] = await Promise.all([
        api.get<StockRow[]>('/inventory/stock/' + branchId),
        api.get<any>('/products'),
        api.get<Category[]>('/categories').catch(() => []),
      ]);
      stockData.sort((a, b) => a.name.localeCompare(b.name));
      setStockRows(stockData);

      const productList: Product[] = Array.isArray(prodData) ? prodData : prodData?.products || [];
      setProducts(productList);

      // Populate categories from endpoint, or fallback to deriving from product list
      if (Array.isArray(catData) && catData.length > 0) {
        setCategories(catData);
      } else {
        const catMap = new Map<string, string>();
        for (const p of productList) {
          if (p.categoryId && p.categoryName) catMap.set(p.categoryId, p.categoryName);
        }
        setCategories([...catMap.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)));
      }

      if (stockData.length && !breakProduct) {
        setBreakProduct(stockData[0].productId);
      }
    } catch (err: any) {
      showToast('Failed to load store stock: ' + err.message, 'error');
    } finally {
      setLoadingStock(false);
    }
  };

  const loadInvoices = async () => {
    if (!branchId) return;
    setLoadingInvoices(true);
    const qs = new URLSearchParams({ limit: '50' });
    if (filterStatus) qs.set('status', filterStatus);
    if (filterQ.trim()) qs.set('q', filterQ.trim());
    try {
      const res = await api.get<{ items: InvoiceHistoryRow[] }>(`/invoices/${branchId}?${qs}`);
      setInvoices(res.items);
    } catch {
      // quiet fail
    } finally {
      setLoadingInvoices(false);
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

  // Sync wizard step when active invoice changes
  useEffect(() => {
    if (activeInvoice) {
      setWizardStep(2);
    } else {
      setWizardStep(1);
    }
  }, [activeInvoice]);

  // ── Duplicate Check Debounce: Step 1 (Upload Form) ─────────────────────────

  const checkDuplicateInvoiceNumber = useCallback(
    (invoiceNo: string) => {
      if (dupDebounceRef.current) clearTimeout(dupDebounceRef.current);

      const trimmed = invoiceNo.trim();
      if (!branchId || trimmed.length < 2 || trimmed.toUpperCase().startsWith('DRAFT-')) {
        setDupCheckStatus('idle');
        setDupCheckMsg('');
        setDupCheckExisting(null);
        return;
      }

      setDupCheckStatus('checking');
      dupDebounceRef.current = setTimeout(async () => {
        try {
          const res = await api.get<DuplicateCheckResult>(
            `/invoices/${branchId}/check-duplicate?invoiceNumber=${encodeURIComponent(trimmed)}`
          );
          if (res.exists) {
            setDupCheckStatus('duplicate');
            setDupCheckMsg(res.message || `Invoice number ${trimmed} has already been uploaded.`);
            setDupCheckExisting(res.invoice || null);
          } else {
            setDupCheckStatus('available');
            setDupCheckMsg('✓ Bill number is available (not uploaded before)');
            setDupCheckExisting(null);
          }
        } catch {
          setDupCheckStatus('idle');
        }
      }, 300);
    },
    [branchId]
  );

  const handleUploadNumberChange = (val: string) => {
    setUploadNumber(val);
    setUploadError(null);
    checkDuplicateInvoiceNumber(val);
  };

  // ── Duplicate Check Debounce: Step 2 (Edit Form) ───────────────────────────

  const checkEditDuplicateInvoiceNumber = useCallback(
    (invoiceNo: string, currentId?: string) => {
      if (editDupDebounceRef.current) clearTimeout(editDupDebounceRef.current);

      const trimmed = invoiceNo.trim();
      if (!branchId || trimmed.length < 2 || trimmed.toUpperCase().startsWith('DRAFT-')) {
        setEditDupStatus('idle');
        setEditDupMsg('');
        return;
      }

      setEditDupStatus('checking');
      editDupDebounceRef.current = setTimeout(async () => {
        try {
          const qs = new URLSearchParams({ invoiceNumber: trimmed });
          if (currentId) qs.set('excludeId', currentId);
          const res = await api.get<DuplicateCheckResult>(`/invoices/${branchId}/check-duplicate?${qs}`);
          if (res.exists) {
            setEditDupStatus('duplicate');
            setEditDupMsg(res.message || `Invoice number ${trimmed} has already been uploaded.`);
          } else {
            setEditDupStatus('available');
            setEditDupMsg('✓ Bill number is available');
          }
        } catch {
          setEditDupStatus('idle');
        }
      }, 300);
    },
    [branchId]
  );

  // ── File Selection & Validation ───────────────────────────────────────────

  const handleFileChosen = (file: File | null) => {
    setUploadError(null);
    if (!file) {
      setUploadFile(null);
      return;
    }

    const maxBytes = 10 * 1024 * 1024; // 10 MB
    if (file.size > maxBytes) {
      setUploadError(
        `This file is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Please select a file smaller than 10 MB.`
      );
      setUploadFile(null);
      return;
    }

    const validExts = ['.pdf', '.xlsx', '.csv', '.png', '.jpg', '.jpeg'];
    const lowerName = file.name.toLowerCase();
    const isValid = validExts.some((ext) => lowerName.endsWith(ext));
    if (!isValid) {
      setUploadError('Unsupported file type. Please upload a PDF bill, Excel spreadsheet (.xlsx), CSV, or photo (JPG/PNG).');
      setUploadFile(null);
      return;
    }

    setUploadFile(file);
  };

  // ── Upload Handler ────────────────────────────────────────────────────────

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!branchId) return;

    if (dupCheckStatus === 'duplicate') {
      showToast(dupCheckMsg || 'This invoice number already exists in the system.', 'error');
      return;
    }

    if (!uploadFile) {
      setUploadError('Please select a bill photo or document to upload.');
      return;
    }

    const fd = new FormData();
    if (uploadSupplier.trim()) fd.append('supplierName', uploadSupplier.trim());
    if (uploadNumber.trim()) fd.append('invoiceNumber', uploadNumber.trim());
    if (uploadDate) fd.append('invoiceDate', uploadDate);
    fd.append('file', uploadFile);

    setUploading(true);
    setUploadError(null);

    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`/api/v1/invoices/${branchId}/upload`, {
        method: 'POST',
        headers: token ? { Authorization: 'Bearer ' + token } : {},
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 409) {
          const errMsg = data.error || data.message || `Invoice has already been uploaded.`;
          setUploadError(errMsg);
          if (data.existingInvoiceId) {
            showToast(errMsg + ' Opening existing bill.', 'info');
            await openInvoice(data.existingInvoiceId);
            return;
          }
          throw new Error(errMsg);
        }
        throw new Error(data.message || data.error || 'Server error while reading the bill.');
      }

      showToast(`Successfully read ${data.items.length} items from ${uploadFile.name}`, 'success');
      setUploadFile(null);
      setUploadSupplier('');
      setUploadNumber('');
      setUploadDate('');
      setDupCheckStatus('idle');
      setActiveInvoice(data);
      setWizardStep(2);
      loadInvoices();
    } catch (err: any) {
      setUploadError(err.message || 'Upload failed. Please check your internet connection and try again.');
      showToast('Upload failed: ' + err.message, 'error');
    } finally {
      setUploading(false);
    }
  };

  const openInvoice = async (id: string) => {
    try {
      const data = await api.get<ActiveInvoiceData>('/invoices/detail/' + id);
      setActiveInvoice(data);
      setActiveTab('upload');
      setWizardStep(2);
    } catch (err: any) {
      showToast('Could not open bill: ' + err.message, 'error');
    }
  };

  const startManualDraft = () => {
    const first = products[0];
    const today = new Date().toISOString().slice(0, 10);
    setActiveInvoice({
      invoice: {
        id: '',
        supplierName: '',
        invoiceNumber: '',
        invoiceDate: today,
        totalAmount: '0.00',
        linesTotal: '0.00',
        status: 'DRAFT',
        source: 'MANUAL',
      },
      items: [
        {
          lineNumber: 1,
          productId: first?.id || null,
          productName: first?.name,
          rawDescription: first?.name || 'Item 1',
          quantity: 1,
          costPrice: first?.costPrice || '500.00',
          mrp: first?.mrp || '700.00',
          lineCostTotal: first?.costPrice || '500.00',
          matchStatus: first ? 'MANUAL' : 'UNMATCHED',
          flags: [],
        },
      ],
    });
    setActiveTab('upload');
    setWizardStep(2);
  };

  // ── Open Add Product to Catalog Modal for Line Item ───────────────────────

  const openAddProductModalForLine = (idx: number) => {
    if (!activeInvoice) return;
    const item = activeInvoice.items[idx];
    const desc = (item.rawDescription || '').trim();

    // 1. Detect Volume in ml (e.g., 1000ml, 750ml, 650ml, 500ml, 375ml, 180ml)
    const volMatch =
      desc.match(/\b(1000|750|650|500|375|330|275|250|180|90)\s*ml\b/i) ||
      desc.match(/\b(1000|750|650|500|375|330|275|250|180|90)ml\b/i);
    const volumeMl = volMatch ? volMatch[1] : '750';

    // 2. Detect Pack Quantity (bottles per case)
    let packQuantity = '12';
    if (volumeMl === '375') packQuantity = '24';
    else if (volumeMl === '180') packQuantity = '48';
    else if (volumeMl === '650' || volumeMl === '500') packQuantity = '12';

    // 3. Detect Category from description keywords
    let matchedCatId = categories[0]?.id || '';
    const lowerDesc = desc.toLowerCase();
    for (const cat of categories) {
      const catLower = cat.name.toLowerCase();
      if (lowerDesc.includes(catLower)) {
        matchedCatId = cat.id;
        break;
      }
    }
    if (!matchedCatId && categories.length > 0) {
      if (lowerDesc.includes('whisky') || lowerDesc.includes('whiskey')) {
        matchedCatId = categories.find((c) => c.name.toLowerCase().includes('whisky'))?.id || categories[0].id;
      } else if (lowerDesc.includes('beer') || lowerDesc.includes('lager') || lowerDesc.includes('pilsner')) {
        matchedCatId = categories.find((c) => c.name.toLowerCase().includes('beer'))?.id || categories[0].id;
      } else if (lowerDesc.includes('rum')) {
        matchedCatId = categories.find((c) => c.name.toLowerCase().includes('rum'))?.id || categories[0].id;
      } else if (lowerDesc.includes('vodka')) {
        matchedCatId = categories.find((c) => c.name.toLowerCase().includes('vodka'))?.id || categories[0].id;
      } else if (lowerDesc.includes('brandy')) {
        matchedCatId = categories.find((c) => c.name.toLowerCase().includes('brandy'))?.id || categories[0].id;
      } else if (lowerDesc.includes('gin')) {
        matchedCatId = categories.find((c) => c.name.toLowerCase().includes('gin'))?.id || categories[0].id;
      } else if (lowerDesc.includes('wine')) {
        matchedCatId = categories.find((c) => c.name.toLowerCase().includes('wine'))?.id || categories[0].id;
      }
    }

    // 4. Detect Brand (first 2 words before volume or standard liquor suffix)
    const cleanWords = desc.replace(/\b(1000|750|650|500|375|330|180|90)\s*ml\b/gi, '').trim().split(/\s+/);
    const brand = cleanWords.slice(0, Math.min(2, cleanWords.length)).join(' ') || desc;

    // 5. Pre-fill Cost & MRP if available
    const costPrice = parseFloat(item.costPrice) > 0 ? item.costPrice : '';
    const mrp = parseFloat(item.mrp) > 0 ? item.mrp : '';

    setProductFormError(null);
    setCreateProductModal({
      lineIdx: idx,
      rawDescription: desc,
      categoryId: matchedCatId,
      name: desc,
      brand,
      volumeMl,
      packQuantity,
      mrp,
      costPrice,
      barcode: item.barcode || '',
      sku: '',
      exciseCode: '',
    });
  };

  // ── Save New Product and Link to Line Item ────────────────────────────────

  const handleSaveNewProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!createProductModal) return;

    const {
      lineIdx, name, brand, categoryId, volumeMl, packQuantity, mrp, costPrice, barcode, sku, exciseCode,
    } = createProductModal;

    if (!name.trim()) {
      setProductFormError('Please enter a product name.');
      return;
    }
    if (!categoryId) {
      setProductFormError('Please select a category (e.g. Whisky, Beer).');
      return;
    }
    const mrpNum = parseFloat(mrp);
    if (isNaN(mrpNum) || mrpNum <= 0) {
      setProductFormError('Please enter a valid positive MRP (e.g. 750 or 750.00).');
      return;
    }
    if (costPrice && (isNaN(parseFloat(costPrice)) || parseFloat(costPrice) <= 0)) {
      setProductFormError('Cost price must be a valid positive amount.');
      return;
    }

    setSavingProduct(true);
    setProductFormError(null);

    try {
      const payload: any = {
        name: name.trim(),
        brand: brand.trim() || name.trim().split(' ')[0] || 'Generic',
        categoryId,
        mrp: mrpNum.toFixed(2),
      };
      if (costPrice.trim()) payload.costPrice = parseFloat(costPrice).toFixed(2);
      if (volumeMl.trim()) payload.volumeMl = parseInt(volumeMl, 10);
      if (packQuantity.trim()) payload.packQuantity = parseInt(packQuantity, 10);
      if (barcode.trim()) payload.barcode = barcode.trim();
      if (sku.trim()) payload.sku = sku.trim();
      if (exciseCode.trim()) payload.exciseCode = exciseCode.trim();

      const created = await api.post<Product>('/products', payload);

      // 1. Add to local catalog state so all dropdowns immediately have it
      setProducts((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));

      // 2. Automatically link the new product to this line item
      if (activeInvoice && lineIdx !== undefined && activeInvoice.items[lineIdx]) {
        const updatedItems = [...activeInvoice.items];
        const item = { ...updatedItems[lineIdx] };
        item.productId = created.id;
        item.productName = created.name;
        item.matchStatus = 'MANUAL';
        if (created.costPrice) item.costPrice = created.costPrice;
        if (created.mrp) item.mrp = created.mrp;
        item.lineCostTotal = (item.quantity * parseFloat(item.costPrice || '0')).toFixed(2);
        updatedItems[lineIdx] = item;
        setActiveInvoice({ ...activeInvoice, items: updatedItems });
      }

      showToast(`✓ Added "${created.name}" to store catalog and matched to line #${lineIdx + 1}!`, 'success');
      setCreateProductModal(null);
    } catch (err: any) {
      setProductFormError(err.message || 'Failed to save product to catalog');
    } finally {
      setSavingProduct(false);
    }
  };

  // ── Line Item Editors ─────────────────────────────────────────────────────

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
    const qty = Math.max(1, parseInt(qtyVal, 10) || 1);
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

  const toggleRowExpanded = (idx: number) => {
    setExpandedRows((prev) => ({ ...prev, [idx]: !prev[idx] }));
  };

  // ── Save, Review & Approve ────────────────────────────────────────────────

  const saveDraft = async (silent = false): Promise<boolean> => {
    if (!activeInvoice) return false;
    const inv = activeInvoice.invoice;

    if (editDupStatus === 'duplicate') {
      showToast(editDupMsg || 'This invoice number already exists.', 'error');
      return false;
    }

    const payload = {
      supplierName: inv.supplierName || 'Supplier Depot',
      invoiceNumber: inv.invoiceNumber || undefined,
      invoiceDate: inv.invoiceDate || undefined,
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
      if (inv.id) {
        const updated = await api.put<ActiveInvoiceData>('/invoices/detail/' + inv.id, payload);
        setActiveInvoice(updated);
      } else {
        const created = await api.post<ActiveInvoiceData>('/invoices/' + branchId, payload);
        setActiveInvoice(created);
      }
      loadInvoices();
      if (!silent) showToast('Bill draft saved successfully.', 'success');
      return true;
    } catch (err: any) {
      showToast('Save failed: ' + err.message, 'error');
      return false;
    }
  };

  const handleReview = async () => {
    if (!activeInvoice || !activeInvoice.invoice.id) return;
    const ok = await saveDraft(true);
    if (!ok) return;
    try {
      const updated = await api.post<ActiveInvoiceData>(`/invoices/detail/${activeInvoice.invoice.id}/review`, {});
      setActiveInvoice(updated);
      loadInvoices();
      showToast('Bill marked as reviewed and ready for inward.', 'success');
    } catch (err: any) {
      showToast('Review failed: ' + err.message, 'error');
    }
  };

  const handleApprove = () => {
    if (!activeInvoice || !activeInvoice.invoice.id) return;
    const totalBottles = activeInvoice.items.reduce((sum, it) => sum + (it.quantity || 0), 0);
    const totalCost = parseFloat(activeInvoice.invoice.linesTotal || activeInvoice.invoice.totalAmount).toFixed(2);

    setConfirmModal({
      title: 'Confirm Stock Inward',
      message: `Add ${totalBottles} bottles from Bill ${activeInvoice.invoice.invoiceNumber} to your store stock? This will post ₹${totalCost} to purchase accounts.`,
      onOk: async () => {
        setConfirmModal(null);
        const ok = await saveDraft(true);
        if (!ok) return;
        try {
          const updated = await api.post<ActiveInvoiceData>(`/invoices/detail/${activeInvoice.invoice.id}/approve`, {});
          setActiveInvoice(updated);
          showToast(`✓ Success: ${totalBottles} bottles added to store inventory!`, 'success');
          await loadStock();
          loadInvoices();
          setWizardStep(3);
        } catch (err: any) {
          showToast('Approval failed: ' + err.message, 'error');
        }
      },
    });
  };

  const handleRecordBreakage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!branchId) return;
    const qty = parseInt(breakQty, 10);
    if (isNaN(qty) || qty < 1) {
      showToast('Quantity must be at least 1 bottle.', 'error');
      return;
    }
    if (breakReason.trim().length < 3) {
      showToast('Please give a short reason (at least 3 characters).', 'error');
      return;
    }
    try {
      const res = await api.post<{ stockQuantity: number }>('/compliance/breakage/' + branchId, {
        productId: breakProduct,
        quantity: qty,
        reason: breakReason.trim(),
      });
      showToast(`Breakage recorded — new stock is ${res.stockQuantity} bottles.`, 'success');
      setBreakReason('');
      setBreakQty('1');
      await loadStock();
      if (isManager) loadBreakage();
    } catch (err: any) {
      showToast('Could not record breakage: ' + err.message, 'error');
    }
  };

  // Stock Metrics
  const lowCount = stockRows.filter((r) => r.quantity > 0 && r.quantity <= r.reorderLevel).length;
  const outCount = stockRows.filter((r) => r.quantity <= 0).length;
  const totalBottlesStock = stockRows.reduce((sum, r) => sum + r.quantity, 0);

  // Active Draft Metrics
  const draftTotalBottles = activeInvoice?.items.reduce((s, it) => s + (it.quantity || 0), 0) || 0;
  const draftLinesCostTotal =
    activeInvoice?.items.reduce((s, it) => s + parseFloat(it.lineCostTotal || '0'), 0).toFixed(2) || '0.00';
  const unmatchedItemCount = activeInvoice?.items.filter((it) => !it.productId).length || 0;

  return (
    <section className="page active p-4 md:p-6 max-w-7xl mx-auto" id="page-stock" aria-labelledby="stockTitle">
      {/* ── Top Header & Tab Navigation ────────────────────────────────────────── */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6 pb-4 border-b">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2" id="stockTitle">
            <span>📦</span> Store Inventory &amp; Supplier Bills
          </h1>
          <p className="text-sm text-gray-600 mt-1">
            Receive depot bills, check bottle counts, and manage live liquor inventory.
          </p>
        </div>

        {/* Tab Switcher */}
        <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-1 text-sm font-medium">
          <button
            type="button"
            className={`px-4 py-2 rounded-md transition-all flex items-center gap-2 cursor-pointer ${
              activeTab === 'upload'
                ? 'bg-blue-600 text-white shadow-sm font-semibold'
                : 'text-gray-700 hover:text-gray-900 hover:bg-gray-100'
            }`}
            onClick={() => setActiveTab('upload')}
          >
            <span>📥</span> Add Supplier Bill
          </button>
          <button
            type="button"
            className={`px-4 py-2 rounded-md transition-all flex items-center gap-2 cursor-pointer ${
              activeTab === 'history'
                ? 'bg-blue-600 text-white shadow-sm font-semibold'
                : 'text-gray-700 hover:text-gray-900 hover:bg-gray-100'
            }`}
            onClick={() => {
              setActiveTab('history');
              loadInvoices();
            }}
          >
            <span>📋</span> Bill History
            <span className="ml-1 text-xs px-2 py-0.5 rounded-full bg-gray-200 text-gray-800 font-mono">
              {invoices.length}
            </span>
          </button>
          <button
            type="button"
            className={`px-4 py-2 rounded-md transition-all flex items-center gap-2 cursor-pointer ${
              activeTab === 'stock'
                ? 'bg-blue-600 text-white shadow-sm font-semibold'
                : 'text-gray-700 hover:text-gray-900 hover:bg-gray-100'
            }`}
            onClick={() => {
              setActiveTab('stock');
              loadStock();
            }}
          >
            <span>🍾</span> Current Store Stock
          </button>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {/* TAB 1: ADD SUPPLIER BILL (STEP-BY-STEP WIZARD)                         */}
      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'upload' && (
        <div className="space-y-6">
          {/* Visual Step Indicator */}
          <div className="bg-white rounded-xl shadow-sm border p-4">
            <div className="flex items-center justify-between max-w-2xl mx-auto">
              {/* Step 1 */}
              <div className="flex items-center gap-3">
                <div
                  className={`w-9 h-9 rounded-full flex items-center justify-center font-bold text-sm ${
                    wizardStep === 1
                      ? 'bg-blue-600 text-white ring-4 ring-blue-100'
                      : wizardStep > 1
                      ? 'bg-emerald-600 text-white'
                      : 'bg-gray-100 text-gray-500'
                  }`}
                >
                  {wizardStep > 1 ? '✓' : '1'}
                </div>
                <div>
                  <div className="text-sm font-bold text-gray-900">Choose Bill</div>
                  <div className="text-xs text-gray-500">Photo, PDF or Excel</div>
                </div>
              </div>

              <div className={`h-1 flex-1 mx-4 rounded ${wizardStep >= 2 ? 'bg-emerald-600' : 'bg-gray-200'}`} />

              {/* Step 2 */}
              <div className="flex items-center gap-3">
                <div
                  className={`w-9 h-9 rounded-full flex items-center justify-center font-bold text-sm ${
                    wizardStep === 2
                      ? 'bg-blue-600 text-white ring-4 ring-blue-100'
                      : wizardStep > 2
                      ? 'bg-emerald-600 text-white'
                      : 'bg-gray-100 text-gray-500'
                  }`}
                >
                  {wizardStep > 2 ? '✓' : '2'}
                </div>
                <div>
                  <div className="text-sm font-bold text-gray-900">Check Items</div>
                  <div className="text-xs text-gray-500">Verify bottles &amp; rates</div>
                </div>
              </div>

              <div className={`h-1 flex-1 mx-4 rounded ${wizardStep >= 3 ? 'bg-emerald-600' : 'bg-gray-200'}`} />

              {/* Step 3 */}
              <div className="flex items-center gap-3">
                <div
                  className={`w-9 h-9 rounded-full flex items-center justify-center font-bold text-sm ${
                    wizardStep === 3
                      ? 'bg-emerald-600 text-white ring-4 ring-emerald-100'
                      : 'bg-gray-100 text-gray-500'
                  }`}
                >
                  3
                </div>
                <div>
                  <div className="text-sm font-bold text-gray-900">Add to Stock</div>
                  <div className="text-xs text-gray-500">Confirm &amp; inward</div>
                </div>
              </div>
            </div>
          </div>

          {/* ── STEP 1: Upload / Enter Bill ──────────────────────────────────── */}
          {wizardStep === 1 && !activeInvoice && (
            <div className="bg-white rounded-xl shadow-sm border p-6 max-w-3xl mx-auto space-y-6">
              <div>
                <h2 className="text-xl font-bold text-gray-900">Step 1: Upload Your Supplier Bill or Challan</h2>
                <p className="text-sm text-gray-600 mt-1">
                  Upload the bill from ICDC, TSBCL or your liquor distributor. We will read the bill number, date, and
                  bottles automatically.
                </p>
              </div>

              {/* Friendly Error Banner */}
              {uploadError && (
                <div className="p-4 rounded-lg bg-red-50 border border-red-200 text-red-800 text-sm flex items-start gap-3">
                  <span className="text-xl">⚠️</span>
                  <div className="flex-1">
                    <div className="font-bold">Check Required</div>
                    <p className="mt-0.5">{uploadError}</p>
                  </div>
                  <button
                    type="button"
                    className="text-xs px-2.5 py-1 bg-red-100 hover:bg-red-200 rounded font-medium text-red-800 cursor-pointer"
                    onClick={() => setUploadError(null)}
                  >
                    Dismiss
                  </button>
                </div>
              )}

              <form id="invUploadForm" onSubmit={handleUpload} className="space-y-6">
                {/* Large Drag-and-Drop Area */}
                <div>
                  <label className="block text-sm font-semibold text-gray-800 mb-2" htmlFor="invUploadFile">
                    Bill Document or Photo <span className="text-red-500">*</span>
                  </label>
                  <div
                    className={`border-2 border-dashed rounded-xl p-8 text-center transition-all cursor-pointer ${
                      isDragActive
                        ? 'border-blue-500 bg-blue-50'
                        : uploadFile
                        ? 'border-emerald-400 bg-emerald-50/40'
                        : 'border-gray-300 hover:border-gray-400 bg-gray-50/50'
                    }`}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setIsDragActive(true);
                    }}
                    onDragLeave={() => setIsDragActive(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setIsDragActive(false);
                      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                        handleFileChosen(e.dataTransfer.files[0]);
                      }
                    }}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <input
                      ref={fileInputRef}
                      id="invUploadFile"
                      type="file"
                      className="hidden"
                      accept=".csv,.xlsx,.pdf,.png,.jpg,.jpeg"
                      onChange={(e) => handleFileChosen(e.target.files?.[0] || null)}
                    />

                    {uploadFile ? (
                      <div className="space-y-2">
                        <div className="text-3xl">📄</div>
                        <div className="font-bold text-gray-900 text-base">{uploadFile.name}</div>
                        <div className="text-xs text-gray-500">
                          File size: {(uploadFile.size / 1024 / 1024).toFixed(2)} MB — Ready to read
                        </div>
                        <button
                          type="button"
                          className="mt-2 text-xs text-red-600 hover:text-red-800 font-medium underline cursor-pointer"
                          onClick={(e) => {
                            e.stopPropagation();
                            setUploadFile(null);
                          }}
                        >
                          Remove file
                        </button>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <div className="text-4xl">📸</div>
                        <div className="font-bold text-gray-900 text-base">
                          Click to select bill or drag file here
                        </div>
                        <p className="text-xs text-gray-500 max-w-md mx-auto">
                          Supports PDF challan, Excel spreadsheet (.xlsx), CSV, or a clear phone photo (JPG/PNG). Maximum file
                          size is 10 MB.
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                {/* Bill Header Info (With Inline Guidance) */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
                  {/* Bill Number */}
                  <div className="space-y-1">
                    <label className="block text-xs font-bold text-gray-700" htmlFor="invUploadNumber">
                      Bill / Invoice Number
                    </label>
                    <input
                      id="invUploadNumber"
                      className="w-full p-2.5 border rounded-lg text-sm bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                      maxLength={60}
                      placeholder="e.g. ICDC032070940 or INV-001"
                      value={uploadNumber}
                      onChange={(e) => handleUploadNumberChange(e.target.value)}
                    />
                    <div className="text-[11px] text-gray-500">
                      Printed at top right of the bill. Optional if in file.
                    </div>

                    {/* Real-time Debounce Feedback */}
                    {dupCheckStatus === 'checking' && (
                      <div className="text-xs text-blue-600 flex items-center gap-1 font-medium mt-1">
                        <span>⏳</span> Checking if bill was already added…
                      </div>
                    )}
                    {dupCheckStatus === 'available' && (
                      <div className="text-xs text-emerald-700 font-medium mt-1">
                        {dupCheckMsg}
                      </div>
                    )}
                    {dupCheckStatus === 'duplicate' && (
                      <div className="p-3 bg-red-50 border border-red-300 rounded-lg text-xs text-red-800 mt-2 space-y-1">
                        <div className="font-bold flex items-center gap-1">
                          <span>⚠️</span> Already Uploaded
                        </div>
                        <p>{dupCheckMsg}</p>
                        {dupCheckExisting?.id && (
                          <button
                            type="button"
                            className="mt-1 px-3 py-1 bg-red-600 hover:bg-red-700 text-white rounded font-medium text-xs flex items-center gap-1 cursor-pointer"
                            onClick={() => openInvoice(dupCheckExisting.id)}
                          >
                            <span>👁️</span> Open Existing Bill
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Supplier Name */}
                  <div className="space-y-1">
                    <label className="block text-xs font-bold text-gray-700" htmlFor="invUploadSupplier">
                      Depot / Supplier Name
                    </label>
                    <input
                      id="invUploadSupplier"
                      className="w-full p-2.5 border rounded-lg text-sm bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                      maxLength={200}
                      placeholder="e.g. ICDC Depot or TSBCL"
                      value={uploadSupplier}
                      onChange={(e) => setUploadSupplier(e.target.value)}
                    />
                    <div className="text-[11px] text-gray-500">
                      Who delivered the stock. Auto-detected from file if left blank.
                    </div>
                  </div>

                  {/* Bill Date */}
                  <div className="space-y-1">
                    <label className="block text-xs font-bold text-gray-700" htmlFor="invUploadDate">
                      Bill Date
                    </label>
                    <input
                      id="invUploadDate"
                      type="date"
                      className="w-full p-2.5 border rounded-lg text-sm bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                      value={uploadDate}
                      onChange={(e) => setUploadDate(e.target.value)}
                    />
                    <div className="text-[11px] text-gray-500">
                      The date printed on the delivery bill.
                    </div>
                  </div>
                </div>

                {/* Primary Action Button */}
                <div className="pt-4 border-t flex flex-col sm:flex-row items-center justify-between gap-4">
                  <button
                    type="button"
                    className="text-xs text-blue-600 hover:text-blue-800 font-semibold underline flex items-center gap-1 cursor-pointer"
                    onClick={startManualDraft}
                  >
                    <span>✍️</span> No digital file? Enter bill items manually
                  </button>

                  <button
                    id="invUploadBtn"
                    type="submit"
                    disabled={uploading || dupCheckStatus === 'duplicate' || !uploadFile}
                    className="w-full sm:w-auto min-h-[48px] px-8 py-3 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg font-bold text-base shadow-sm flex items-center justify-center gap-2 transition-all cursor-pointer"
                  >
                    {uploading ? (
                      <>
                        <span className="animate-spin">⏳</span> Reading Bill Items…
                      </>
                    ) : (
                      <>
                        <span>⬆</span> Upload &amp; Read Bill
                      </>
                    )}
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* ── STEP 2: Check & Match Items ─────────────────────────────────── */}
          {wizardStep === 2 && activeInvoice && (
            <div id="invDetailBox" className="bg-white rounded-xl shadow-sm border p-6 space-y-6">
              {/* Header Box */}
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-xl font-bold text-gray-900">
                      Step 2: Check Bottles &amp; Product Matching
                    </h2>
                    <span
                      className={`text-xs px-2.5 py-0.5 rounded-full font-bold ${
                        activeInvoice.invoice.status === 'APPROVED'
                          ? 'bg-emerald-100 text-emerald-800'
                          : activeInvoice.invoice.status === 'REVIEWED'
                          ? 'bg-blue-100 text-blue-800'
                          : 'bg-amber-100 text-amber-800'
                      }`}
                    >
                      {activeInvoice.invoice.status === 'APPROVED'
                        ? 'Added to Stock'
                        : activeInvoice.invoice.status === 'REVIEWED'
                        ? 'Reviewed'
                        : 'Draft'}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    We found <b>{activeInvoice.items.length} lines</b> ({draftTotalBottles} bottles). Ensure each item is
                    matched with the correct liquor in your store catalog.
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="px-3 py-1.5 text-xs text-gray-600 hover:text-gray-900 bg-gray-100 hover:bg-gray-200 rounded-lg font-medium cursor-pointer"
                    onClick={() => {
                      setActiveInvoice(null);
                      setWizardStep(1);
                    }}
                  >
                    ✕ Close &amp; Back
                  </button>
                </div>
              </div>

              {/* Bill Details Bar */}
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 p-4 bg-gray-50 rounded-xl border">
                <div>
                  <label className="block text-xs font-bold text-gray-600" htmlFor="invEditSupplier">
                    Depot / Supplier
                  </label>
                  <input
                    id="invEditSupplier"
                    className="w-full mt-1 p-2 border rounded text-sm bg-white font-medium"
                    value={activeInvoice.invoice.supplierName || ''}
                    onChange={(e) =>
                      setActiveInvoice({
                        ...activeInvoice,
                        invoice: { ...activeInvoice.invoice, supplierName: e.target.value },
                      })
                    }
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-gray-600" htmlFor="invEditNumber">
                    Bill / Challan No.
                  </label>
                  <input
                    id="invEditNumber"
                    className="w-full mt-1 p-2 border rounded text-sm bg-white font-mono font-medium"
                    value={activeInvoice.invoice.invoiceNumber || ''}
                    onChange={(e) => {
                      const val = e.target.value;
                      setActiveInvoice({
                        ...activeInvoice,
                        invoice: { ...activeInvoice.invoice, invoiceNumber: val },
                      });
                      checkEditDuplicateInvoiceNumber(val, activeInvoice.invoice.id);
                    }}
                  />
                  {editDupStatus === 'duplicate' && (
                    <div className="text-[11px] text-red-600 font-bold mt-1">
                      ⚠️ {editDupMsg}
                    </div>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-bold text-gray-600" htmlFor="invEditDate">
                    Bill Date
                  </label>
                  <input
                    id="invEditDate"
                    type="date"
                    className="w-full mt-1 p-2 border rounded text-sm bg-white font-medium"
                    value={activeInvoice.invoice.invoiceDate ? activeInvoice.invoice.invoiceDate.slice(0, 10) : ''}
                    onChange={(e) =>
                      setActiveInvoice({
                        ...activeInvoice,
                        invoice: { ...activeInvoice.invoice, invoiceDate: e.target.value },
                      })
                    }
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-gray-600" htmlFor="invEditTotal">
                    Document Total (₹)
                  </label>
                  <input
                    id="invEditTotal"
                    className="w-full mt-1 p-2 border rounded text-sm bg-white font-mono font-bold text-gray-900"
                    value={activeInvoice.invoice.totalAmount || '0.00'}
                    onChange={(e) =>
                      setActiveInvoice({
                        ...activeInvoice,
                        invoice: { ...activeInvoice.invoice, totalAmount: e.target.value },
                      })
                    }
                  />
                </div>
              </div>

              {/* Items Table */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-bold text-gray-900 flex items-center gap-2">
                    <span>📋</span> Bill Line Items
                    {unmatchedItemCount > 0 && (
                      <span className="text-xs px-2 py-0.5 bg-amber-100 text-amber-800 rounded font-bold">
                        {unmatchedItemCount} product{unmatchedItemCount > 1 ? 's' : ''} need selection
                      </span>
                    )}
                  </h3>
                  <div className="text-xs text-gray-500">
                    Calculated Total: <b className="text-gray-900">₹{draftLinesCostTotal}</b>
                  </div>
                </div>

                <div className="overflow-x-auto border rounded-xl">
                  <table className="w-full text-left bg-white text-sm" id="invEditTable">
                    <thead>
                      <tr className="border-b text-xs text-gray-600 bg-gray-50/80 uppercase tracking-wider">
                        <th className="py-3 px-3 w-10">#</th>
                        <th className="py-3 px-3">Description on Bill</th>
                        <th className="py-3 px-3" style={{ minWidth: '260px' }}>
                          Matched Store Liquor
                        </th>
                        <th className="py-3 px-3 text-right w-24">Bottles</th>
                        <th className="py-3 px-3 text-right w-28">Buy Price (₹)</th>
                        <th className="py-3 px-3 text-right w-28">Sale MRP (₹)</th>
                        <th className="py-3 px-3 text-right w-32">Total (₹)</th>
                        <th className="py-3 px-2 text-center w-16">Details</th>
                      </tr>
                    </thead>
                    <tbody id="invEditLines" className="divide-y divide-gray-100">
                      {activeInvoice.items.map((it, idx) => (
                        <tr
                          key={it.id || idx}
                          className="inv-edit-row hover:bg-gray-50/60 transition-colors"
                          data-item-id={it.id || ''}
                          data-match-status={it.matchStatus}
                        >
                          <td className="py-3 px-3 text-xs text-gray-400 font-mono">{idx + 1}</td>

                          {/* Raw description */}
                          <td className="py-3 px-3">
                            <input
                              className="input input-sm ie-desc p-1.5 border rounded text-xs w-full bg-white font-medium"
                              value={it.rawDescription}
                              onChange={(e) => handleLineDescChange(idx, e.target.value)}
                            />
                            {expandedRows[idx] && (
                              <div className="mt-1 text-[11px] text-gray-400 space-y-0.5">
                                {it.barcode && <div>Barcode: {it.barcode}</div>}
                                {it.extractedAmount && <div>Extracted total: ₹{it.extractedAmount}</div>}
                              </div>
                            )}
                          </td>

                          {/* Catalog Match Selector + Add New Product Action */}
                          <td className="py-3 px-3">
                            <select
                              className="input input-sm ie-prod p-1.5 border rounded text-xs w-full bg-white font-medium"
                              value={it.productId || ''}
                              onChange={(e) => {
                                if (e.target.value === '__NEW__') {
                                  openAddProductModalForLine(idx);
                                  return;
                                }
                                handleProductChange(idx, e.target.value);
                              }}
                            >
                              <option value="">— Select Store Liquor —</option>
                              <option value="__NEW__" className="font-bold text-blue-600 bg-blue-50">
                                ➕ Add New Product to Catalog…
                              </option>
                              {products.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.name} (MRP ₹{parseFloat(p.mrp).toFixed(2)})
                                </option>
                              ))}
                            </select>

                            <div className="mt-1.5 flex items-center justify-between gap-1">
                              <span className="ie-match-badge">
                                <span
                                  className={`text-[11px] px-2 py-0.5 rounded font-bold ${
                                    it.matchStatus === 'MATCHED' || it.matchStatus === 'MANUAL'
                                      ? 'bg-emerald-100 text-emerald-800'
                                      : it.matchStatus === 'SUGGESTED'
                                      ? 'bg-amber-100 text-amber-800'
                                      : 'bg-red-100 text-red-800'
                                  }`}
                                >
                                  {it.matchStatus === 'MATCHED' || it.matchStatus === 'MANUAL'
                                    ? '✓ Matched'
                                    : it.matchStatus === 'SUGGESTED'
                                    ? '⚡ Suggested'
                                    : '⚠️ Needs Selection'}
                                </span>
                              </span>

                              <button
                                type="button"
                                className="text-[11px] text-blue-600 hover:text-blue-800 font-bold hover:underline flex items-center gap-0.5 cursor-pointer"
                                title="Add this item as a new product in your store catalog"
                                onClick={() => openAddProductModalForLine(idx)}
                              >
                                <span>➕</span> Add to catalog
                              </button>
                            </div>
                          </td>

                          {/* Bottles */}
                          <td className="py-3 px-3 text-right">
                            <input
                              className="input input-sm ie-qty p-1.5 border rounded text-right font-mono text-sm w-20 font-bold bg-white"
                              type="number"
                              min="1"
                              value={it.quantity}
                              onChange={(e) => handleLineQtyChange(idx, e.target.value)}
                            />
                          </td>

                          {/* Cost per bottle */}
                          <td className="py-3 px-3 text-right">
                            <input
                              className="input input-sm ie-cost p-1.5 border rounded text-right font-mono text-sm w-24 bg-white"
                              value={it.costPrice}
                              onChange={(e) => handleLineCostChange(idx, e.target.value)}
                            />
                          </td>

                          {/* MRP */}
                          <td className="py-3 px-3 text-right">
                            <input
                              className="input input-sm ie-mrp p-1.5 border rounded text-right font-mono text-sm w-24 bg-white"
                              value={it.mrp}
                              onChange={(e) => handleLineMrpChange(idx, e.target.value)}
                            />
                          </td>

                          {/* Line total */}
                          <td className="py-3 px-3 text-right font-mono font-bold text-gray-900">
                            <span className="ie-linetotal">₹{parseFloat(it.lineCostTotal).toFixed(2)}</span>
                          </td>

                          {/* Expandable toggle */}
                          <td className="py-3 px-2 text-center">
                            <button
                              type="button"
                              className="text-xs text-gray-400 hover:text-gray-700 p-1 cursor-pointer"
                              title="Show secondary details"
                              onClick={() => toggleRowExpanded(idx)}
                            >
                              {expandedRows[idx] ? '▲' : '▼'}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Step 2 Actions Bar */}
              <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-4 border-t">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="min-h-[44px] px-4 py-2 text-xs font-semibold text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg border flex items-center gap-1.5 cursor-pointer"
                    onClick={() => {
                      setActiveInvoice(null);
                      setWizardStep(1);
                    }}
                  >
                    <span>⬅</span> Back to Upload
                  </button>

                  <button
                    id="invSaveDraftBtn"
                    type="button"
                    className="min-h-[44px] px-4 py-2 text-xs font-semibold text-gray-700 bg-white hover:bg-gray-50 rounded-lg border flex items-center gap-1.5 cursor-pointer"
                    onClick={() => saveDraft()}
                  >
                    <span>💾</span> Save Draft
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  {isManager && activeInvoice.invoice.status === 'DRAFT' && (
                    <button
                      id="invReviewBtn"
                      type="button"
                      className="min-h-[44px] px-4 py-2 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg border border-blue-200 cursor-pointer"
                      onClick={handleReview}
                    >
                      ✓ Mark as Reviewed
                    </button>
                  )}

                  {/* Proceed to Step 3 Confirmation Screen */}
                  <button
                    type="button"
                    className="min-h-[48px] px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-bold text-sm shadow-sm flex items-center gap-2 cursor-pointer"
                    onClick={() => setWizardStep(3)}
                  >
                    <span>➡️</span> Proceed to Inward Confirmation
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── STEP 3: Confirmation & Inward Screen ──────────────────────────── */}
          {wizardStep === 3 && activeInvoice && (
            <div className="bg-white rounded-xl shadow-sm border p-6 max-w-3xl mx-auto space-y-6">
              <div className="text-center space-y-1">
                <div className="text-4xl">📦</div>
                <h2 className="text-2xl font-bold text-gray-900">Step 3: Confirm Stock Inward</h2>
                <p className="text-sm text-gray-600">
                  Please verify the summary below before adding these bottles to your live store stock.
                </p>
              </div>

              {/* Big Metrics Cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="p-4 bg-blue-50/70 border border-blue-100 rounded-xl text-center">
                  <div className="text-xs text-blue-600 font-bold uppercase tracking-wider">Total Bottles</div>
                  <div className="text-2xl font-bold text-blue-900 mt-1 font-mono">{draftTotalBottles}</div>
                  <div className="text-[11px] text-blue-700">across {activeInvoice.items.length} lines</div>
                </div>

                <div className="p-4 bg-emerald-50/70 border border-emerald-100 rounded-xl text-center">
                  <div className="text-xs text-emerald-600 font-bold uppercase tracking-wider">Total Amount</div>
                  <div className="text-2xl font-bold text-emerald-900 mt-1 font-mono">
                    ₹{parseFloat(activeInvoice.invoice.linesTotal || activeInvoice.invoice.totalAmount).toFixed(2)}
                  </div>
                  <div className="text-[11px] text-emerald-700">purchase value</div>
                </div>

                <div className="p-4 bg-purple-50/70 border border-purple-100 rounded-xl text-center">
                  <div className="text-xs text-purple-600 font-bold uppercase tracking-wider">Bill Number</div>
                  <div className="text-base font-bold text-purple-900 mt-2 font-mono truncate" title={activeInvoice.invoice.invoiceNumber}>
                    {activeInvoice.invoice.invoiceNumber}
                  </div>
                  <div className="text-[11px] text-purple-700">delivery challan</div>
                </div>

                <div className="p-4 bg-amber-50/70 border border-amber-100 rounded-xl text-center">
                  <div className="text-xs text-amber-600 font-bold uppercase tracking-wider">Depot / Supplier</div>
                  <div className="text-base font-bold text-amber-900 mt-2 truncate" title={activeInvoice.invoice.supplierName}>
                    {activeInvoice.invoice.supplierName || 'Depot'}
                  </div>
                  <div className="text-[11px] text-amber-700">source</div>
                </div>
              </div>

              {/* Summary List */}
              <div className="border rounded-xl p-4 bg-gray-50/50 space-y-3">
                <div className="text-xs font-bold text-gray-700 uppercase tracking-wider">
                  Liquor Products to Add:
                </div>
                <div className="max-h-60 overflow-y-auto divide-y divide-gray-200 text-sm">
                  {activeInvoice.items.map((it, i) => (
                    <div key={i} className="py-2 flex items-center justify-between">
                      <div>
                        <div className="font-semibold text-gray-900">{it.productName || it.rawDescription}</div>
                        <div className="text-xs text-gray-500">
                          MRP ₹{parseFloat(it.mrp).toFixed(2)} · Rate ₹{parseFloat(it.costPrice).toFixed(2)}
                        </div>
                      </div>
                      <div className="text-right">
                        <span className="font-mono font-bold text-gray-900 text-base">+{it.quantity}</span>{' '}
                        <span className="text-xs text-gray-500">bottles</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Warning Notice */}
              <div className="p-4 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-900 text-xs flex items-start gap-2">
                <span>✓</span>
                <div>
                  <b>What happens next:</b> Live stock counts will be updated immediately. A purchase journal entry
                  will be recorded automatically.
                </div>
              </div>

              {/* Primary Actions */}
              <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-4 border-t">
                <button
                  type="button"
                  className="min-h-[48px] px-6 py-2.5 text-sm font-semibold text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg border flex items-center gap-1.5 cursor-pointer"
                  onClick={() => setWizardStep(2)}
                >
                  <span>✏️</span> Edit or Fix Items
                </button>

                {isManager ? (
                  <button
                    id="invApproveBtn"
                    type="button"
                    className="w-full sm:w-auto min-h-[48px] px-8 py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-bold text-base shadow-sm flex items-center justify-center gap-2 transition-all cursor-pointer"
                    onClick={handleApprove}
                  >
                    <span>✅</span> Confirm &amp; Add to Live Stock
                  </button>
                ) : (
                  <button
                    type="button"
                    className="w-full sm:w-auto min-h-[48px] px-8 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-bold text-base shadow-sm flex items-center justify-center gap-2 cursor-pointer"
                    onClick={async () => {
                      await saveDraft();
                      showToast('Bill submitted for manager review.', 'success');
                    }}
                  >
                    <span>✓</span> Submit for Manager Inward
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {/* TAB 2: INVOICE HISTORY                                                 */}
      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'history' && (
        <div className="bg-white rounded-xl shadow-sm border p-6 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b">
            <div>
              <h2 className="text-lg font-bold text-gray-900">Past Supplier Bills &amp; Inwards</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                Search and review previous delivery challans recorded for this branch.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <select
                id="invFilterStatus"
                className="p-2 border rounded-lg text-xs bg-white font-medium"
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
              >
                <option value="">All Statuses</option>
                <option value="APPROVED">Added to Stock (APPROVED)</option>
                <option value="REVIEWED">Ready for Inward (REVIEWED)</option>
                <option value="DRAFT">Incomplete Draft (DRAFT)</option>
                <option value="REJECTED">Cancelled (REJECTED)</option>
              </select>

              <input
                id="invFilterQ"
                className="p-2 border rounded-lg text-xs bg-white w-48 font-medium"
                placeholder="Search bill number or depot"
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
                type="button"
                className="px-3 py-2 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded-lg font-semibold text-xs border cursor-pointer"
                onClick={loadInvoices}
              >
                Search
              </button>
            </div>
          </div>

          <div id="invHistoryBox" className="overflow-x-auto">
            {loadingInvoices ? (
              <div className="p-8 text-center text-gray-500 text-sm">Loading bills…</div>
            ) : invoices.length === 0 ? (
              <div className="p-8 text-center text-gray-500 text-sm">No supplier bills found.</div>
            ) : (
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b text-xs text-gray-500 bg-gray-50/70 uppercase tracking-wider">
                    <th className="py-2.5 px-3">Bill Number</th>
                    <th className="py-2.5 px-3">Depot / Supplier</th>
                    <th className="py-2.5 px-3">Date</th>
                    <th className="py-2.5 px-3">Source</th>
                    <th className="py-2.5 px-3 text-right">Items</th>
                    <th className="py-2.5 px-3 text-right">Total Amount</th>
                    <th className="py-2.5 px-3">Status</th>
                    <th className="py-2.5 px-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {invoices.map((inv) => (
                    <tr
                      key={inv.id}
                      className="inv-history-row hover:bg-gray-50/70 transition-colors"
                      data-invoice-id={inv.id}
                      data-invoice-number={inv.invoiceNumber}
                    >
                      <td className="py-3 px-3">
                        <div className="font-bold text-gray-900 font-mono">{inv.invoiceNumber}</div>
                        {inv.originalFilename && (
                          <div className="text-[11px] text-gray-400 truncate max-w-xs">{inv.originalFilename}</div>
                        )}
                      </td>
                      <td className="py-3 px-3 text-gray-800 font-medium">{inv.supplierName || '—'}</td>
                      <td className="py-3 px-3 text-xs text-gray-600">
                        {inv.invoiceDate
                          ? new Date(inv.invoiceDate).toLocaleDateString('en-IN', {
                              day: 'numeric',
                              month: 'short',
                              year: 'numeric',
                            })
                          : new Date(inv.createdAt).toLocaleDateString('en-IN', {
                              day: 'numeric',
                              month: 'short',
                              year: 'numeric',
                            })}
                      </td>
                      <td className="py-3 px-3">
                        <span className="text-xs px-2 py-0.5 rounded font-medium bg-purple-100 text-purple-800">
                          {inv.source}
                        </span>
                      </td>
                      <td className="py-3 px-3 text-right font-mono font-medium">{inv.lineCount}</td>
                      <td className="py-3 px-3 text-right font-mono font-bold text-gray-900">
                        ₹{parseFloat(inv.totalAmount).toFixed(2)}
                      </td>
                      <td className="py-3 px-3">
                        <span
                          className={`text-xs px-2.5 py-0.5 rounded-full font-bold ${
                            inv.status === 'APPROVED'
                              ? 'bg-emerald-100 text-emerald-800'
                              : inv.status === 'REVIEWED'
                              ? 'bg-blue-100 text-blue-800'
                              : inv.status === 'REJECTED'
                              ? 'bg-red-100 text-red-800'
                              : 'bg-amber-100 text-amber-800'
                          }`}
                        >
                          {inv.status === 'APPROVED'
                            ? 'Added to Stock'
                            : inv.status === 'REVIEWED'
                            ? 'Reviewed'
                            : inv.status === 'REJECTED'
                            ? 'Cancelled'
                            : 'Draft'}
                        </span>
                      </td>
                      <td className="py-3 px-3 text-right">
                        <button
                          type="button"
                          className="px-3 py-1 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded font-semibold text-xs border cursor-pointer"
                          onClick={() => openInvoice(inv.id)}
                        >
                          Open Bill
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {/* TAB 3: CURRENT STORE STOCK & BREAKAGE                                  */}
      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'stock' && (
        <div className="space-y-6">
          {/* Top Stock Metrics */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4" id="stockStats">
            <div className="p-4 bg-white rounded-xl shadow-sm border">
              <div className="text-xs text-gray-500 font-medium">SKUs in Store</div>
              <div className="text-2xl font-bold font-mono mt-1 text-gray-900">{stockRows.length}</div>
            </div>
            <div className="p-4 bg-white rounded-xl shadow-sm border">
              <div className="text-xs text-gray-500 font-medium">Total Bottles on Hand</div>
              <div className="text-2xl font-bold font-mono mt-1 text-gray-900">
                {totalBottlesStock.toLocaleString('en-IN')}
              </div>
            </div>
            <div className="p-4 bg-white rounded-xl shadow-sm border">
              <div className="text-xs text-amber-600 font-medium">⚠️ Low Stock Alerts</div>
              <div className="text-2xl font-bold font-mono mt-1 text-amber-600">{lowCount}</div>
            </div>
            <div className="p-4 bg-white rounded-xl shadow-sm border">
              <div className="text-xs text-red-600 font-medium">🚫 Out of Stock</div>
              <div className="text-2xl font-bold font-mono mt-1 text-red-600">{outCount}</div>
            </div>
          </div>

          {/* Current Stock Table */}
          <div className="bg-white rounded-xl shadow-sm border p-6">
            <div className="flex items-center justify-between pb-4 border-b mb-4">
              <div>
                <h2 className="text-lg font-bold text-gray-900">Current Liquor Stock Levels</h2>
                <p className="text-xs text-gray-500 mt-0.5">Live bottle balance by product in this store.</p>
              </div>
              <button
                type="button"
                className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded-lg border text-xs font-semibold cursor-pointer"
                onClick={loadStock}
              >
                ↻ Refresh Stock
              </button>
            </div>

            <div className="overflow-x-auto" id="stockTable">
              {loadingStock ? (
                <div className="p-8 text-center text-gray-500 text-sm">Loading stock levels…</div>
              ) : (
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b text-xs text-gray-500 bg-gray-50/70 uppercase tracking-wider">
                      <th className="py-2.5 px-3">Product</th>
                      <th className="py-2.5 px-3 text-right">In Stock</th>
                      <th className="py-2.5 px-3 text-right">Reorder Level</th>
                      <th className="py-2.5 px-3">Status</th>
                      <th className="py-2.5 px-3 text-right">MRP (₹)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {stockRows.map((r) => (
                      <tr key={r.productId} className="hover:bg-gray-50/70 transition-colors">
                        <td className="py-3 px-3">
                          <div className="font-bold text-gray-900">{r.name}</div>
                          {r.brand && (
                            <div className="text-xs text-gray-500">
                              {r.brand} {r.volumeMl ? `· ${r.volumeMl}ml` : ''}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-3 text-right font-mono font-bold text-gray-900">{r.quantity}</td>
                        <td className="py-3 px-3 text-right font-mono text-gray-500">{r.reorderLevel}</td>
                        <td className="py-3 px-3">
                          {r.quantity <= 0 ? (
                            <span className="text-xs px-2 py-0.5 rounded-full font-bold bg-red-100 text-red-800">
                              Out of stock
                            </span>
                          ) : r.quantity <= r.reorderLevel ? (
                            <span className="text-xs px-2 py-0.5 rounded-full font-bold bg-amber-100 text-amber-800">
                              Low
                            </span>
                          ) : (
                            <span className="text-xs px-2 py-0.5 rounded-full font-bold bg-emerald-100 text-emerald-800">
                              OK
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-3 text-right font-mono font-semibold text-gray-900">
                          ₹{parseFloat(r.mrp).toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* Breakage Recording Section */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="bg-white rounded-xl shadow-sm border p-6 space-y-4">
              <div>
                <h3 className="text-lg font-bold text-gray-900">💥 Record Broken Bottle</h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  Record accidental bottle breakage to keep physical stock accurate.
                </p>
              </div>

              <form onSubmit={handleRecordBreakage} className="space-y-4">
                <div>
                  <label className="block text-xs font-bold text-gray-700" htmlFor="breakProduct">
                    Product
                  </label>
                  <select
                    id="breakProduct"
                    className="w-full mt-1 p-2.5 border rounded-lg text-sm bg-white font-medium"
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
                </div>

                <div>
                  <label className="block text-xs font-bold text-gray-700" htmlFor="breakQty">
                    Broken Bottles
                  </label>
                  <input
                    id="breakQty"
                    type="number"
                    min="1"
                    className="w-full mt-1 p-2.5 border rounded-lg text-sm bg-white font-mono"
                    value={breakQty}
                    onChange={(e) => setBreakQty(e.target.value)}
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-gray-700" htmlFor="breakReason">
                    Reason
                  </label>
                  <input
                    id="breakReason"
                    className="w-full mt-1 p-2.5 border rounded-lg text-sm bg-white"
                    placeholder="e.g. Slipped from carton while shelving"
                    value={breakReason}
                    onChange={(e) => setBreakReason(e.target.value)}
                    required
                    minLength={3}
                  />
                </div>

                <button
                  id="breakSubmit"
                  type="submit"
                  className="w-full min-h-[44px] px-4 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-lg font-bold text-sm shadow-sm transition-all cursor-pointer"
                >
                  Record Breakage
                </button>
              </form>
            </div>

            {isManager && (
              <div className="bg-white rounded-xl shadow-sm border p-6 space-y-4">
                <div>
                  <h3 className="text-lg font-bold text-gray-900">Breakage History (Last 30 Days)</h3>
                  <p className="text-xs text-gray-500 mt-0.5">Manager compliance log of recorded breakages.</p>
                </div>

                <div id="breakLog" className="overflow-x-auto">
                  {breakLog.length === 0 ? (
                    <div className="p-8 text-center text-gray-400 text-xs">
                      No breakage recorded in the last 30 days.
                    </div>
                  ) : (
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b text-gray-500 bg-gray-50">
                          <th className="py-2 px-2">Date</th>
                          <th className="py-2 px-2">Product</th>
                          <th className="py-2 px-2 text-right">Qty</th>
                          <th className="py-2 px-2 text-right">Cost (₹)</th>
                          <th className="py-2 px-2">Reason</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {breakLog.map((b) => (
                          <tr key={b.id}>
                            <td className="py-2 px-2 text-gray-500">
                              {new Date(b.createdAt).toLocaleDateString('en-IN', {
                                day: 'numeric',
                                month: 'short',
                              })}
                            </td>
                            <td className="py-2 px-2 font-medium text-gray-900">{b.productName}</td>
                            <td className="py-2 px-2 text-right font-mono font-bold text-gray-900">{b.quantity}</td>
                            <td className="py-2 px-2 text-right font-mono text-gray-700">
                              ₹{parseFloat(b.costValue).toFixed(2)}
                            </td>
                            <td className="py-2 px-2 text-gray-500 truncate max-w-xs">{b.reason}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {/* ADD MISSING PRODUCT TO CATALOG MODAL                                   */}
      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {createProductModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full p-6 space-y-4 my-8">
            <div className="flex items-start justify-between border-b pb-3">
              <div>
                <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                  <span>➕</span> Add Missing Product to Catalog
                </h3>
                <p className="text-xs text-gray-500 mt-1">
                  Line #{createProductModal.lineIdx + 1}: &ldquo;{createProductModal.rawDescription}&rdquo;
                </p>
              </div>
              <button
                type="button"
                className="text-gray-400 hover:text-gray-700 text-lg p-1 cursor-pointer"
                onClick={() => setCreateProductModal(null)}
              >
                ✕
              </button>
            </div>

            {productFormError && (
              <div className="p-3 bg-red-50 border border-red-200 text-red-800 text-xs rounded-lg font-medium">
                ⚠️ {productFormError}
              </div>
            )}

            <form onSubmit={handleSaveNewProduct} className="space-y-4">
              {/* Product Title */}
              <div>
                <label className="block text-xs font-bold text-gray-700" htmlFor="newProdName">
                  Product Name <span className="text-red-500">*</span>
                </label>
                <input
                  id="newProdName"
                  className="w-full mt-1 p-2.5 border rounded-lg text-sm bg-white font-medium focus:ring-2 focus:ring-blue-500 outline-none"
                  value={createProductModal.name}
                  onChange={(e) => setCreateProductModal({ ...createProductModal, name: e.target.value })}
                  placeholder="e.g. Royal Challenge Premium Whisky 750ml"
                  required
                  maxLength={200}
                />
              </div>

              {/* Brand & Category in 2 columns */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-gray-700" htmlFor="newProdCategory">
                    Category <span className="text-red-500">*</span>
                  </label>
                  <select
                    id="newProdCategory"
                    className="w-full mt-1 p-2.5 border rounded-lg text-sm bg-white font-medium"
                    value={createProductModal.categoryId}
                    onChange={(e) => setCreateProductModal({ ...createProductModal, categoryId: e.target.value })}
                    required
                  >
                    <option value="">— Select Category —</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-gray-700" htmlFor="newProdBrand">
                    Brand Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    id="newProdBrand"
                    className="w-full mt-1 p-2.5 border rounded-lg text-sm bg-white font-medium"
                    value={createProductModal.brand}
                    onChange={(e) => setCreateProductModal({ ...createProductModal, brand: e.target.value })}
                    placeholder="e.g. Royal Challenge"
                    required
                    maxLength={200}
                  />
                </div>
              </div>

              {/* Volume & Pack Quantity */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-gray-700" htmlFor="newProdVolume">
                    Bottle Volume (ml)
                  </label>
                  <input
                    id="newProdVolume"
                    type="number"
                    min="1"
                    className="w-full mt-1 p-2.5 border rounded-lg text-sm bg-white font-mono"
                    value={createProductModal.volumeMl}
                    onChange={(e) => setCreateProductModal({ ...createProductModal, volumeMl: e.target.value })}
                    placeholder="e.g. 750 or 650"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-gray-700" htmlFor="newProdPack">
                    Bottles / Case
                  </label>
                  <input
                    id="newProdPack"
                    type="number"
                    min="1"
                    className="w-full mt-1 p-2.5 border rounded-lg text-sm bg-white font-mono"
                    value={createProductModal.packQuantity}
                    onChange={(e) => setCreateProductModal({ ...createProductModal, packQuantity: e.target.value })}
                    placeholder="e.g. 12, 24, 48"
                  />
                </div>
              </div>

              {/* Price Row: Cost Price & MRP */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-gray-700" htmlFor="newProdCost">
                    Buy / Cost Price (₹)
                  </label>
                  <input
                    id="newProdCost"
                    className="w-full mt-1 p-2.5 border rounded-lg text-sm bg-white font-mono font-medium"
                    value={createProductModal.costPrice}
                    onChange={(e) => setCreateProductModal({ ...createProductModal, costPrice: e.target.value })}
                    placeholder="e.g. 620.00"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-gray-700" htmlFor="newProdMrp">
                    Selling MRP (₹) <span className="text-red-500">*</span>
                  </label>
                  <input
                    id="newProdMrp"
                    className="w-full mt-1 p-2.5 border rounded-lg text-sm bg-white font-mono font-bold text-gray-900"
                    value={createProductModal.mrp}
                    onChange={(e) => setCreateProductModal({ ...createProductModal, mrp: e.target.value })}
                    placeholder="e.g. 850.00"
                    required
                  />
                </div>
              </div>

              {/* Barcode & SKU (Optional) */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-gray-700" htmlFor="newProdBarcode">
                    Barcode (Optional)
                  </label>
                  <input
                    id="newProdBarcode"
                    className="w-full mt-1 p-2 border rounded-lg text-xs bg-white font-mono"
                    value={createProductModal.barcode}
                    onChange={(e) => setCreateProductModal({ ...createProductModal, barcode: e.target.value })}
                    placeholder="e.g. 890123456001"
                    maxLength={64}
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-gray-700" htmlFor="newProdSku">
                    Excise / SKU Code (Optional)
                  </label>
                  <input
                    id="newProdSku"
                    className="w-full mt-1 p-2 border rounded-lg text-xs bg-white font-mono"
                    value={createProductModal.sku}
                    onChange={(e) => setCreateProductModal({ ...createProductModal, sku: e.target.value })}
                    placeholder="e.g. 1010 or SKU"
                    maxLength={64}
                  />
                </div>
              </div>

              <div className="p-3 bg-blue-50 border border-blue-100 rounded-lg text-xs text-blue-800">
                ℹ️ Saving this product will add it to your store catalog and immediately link it to line #{createProductModal.lineIdx + 1} with ₹{parseFloat(createProductModal.mrp || '0').toFixed(2)} MRP.
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  className="min-h-[44px] px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg border font-semibold text-xs cursor-pointer"
                  onClick={() => setCreateProductModal(null)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingProduct}
                  className="min-h-[44px] px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg font-bold text-xs shadow-sm flex items-center gap-2 cursor-pointer"
                >
                  {savingProduct ? 'Saving to Catalog…' : '💾 Save to Catalog & Link Line'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Confirmation Modal */}
      {confirmModal && (
        <div id="modal" className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 space-y-4">
            <h3 className="text-lg font-bold text-gray-900" id="confirmTitle">
              {confirmModal.title}
            </h3>
            <p className="text-gray-600 text-sm leading-relaxed" id="confirmText">
              {confirmModal.message}
            </p>
            <div className="flex justify-end gap-3 pt-2">
              <button
                id="confirmCancel"
                type="button"
                className="min-h-[44px] px-5 py-2 text-gray-700 hover:bg-gray-100 rounded-lg border font-semibold text-sm transition-colors cursor-pointer"
                onClick={() => setConfirmModal(null)}
              >
                Cancel
              </button>
              <button
                id="confirmOk"
                type="button"
                className="min-h-[44px] px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-bold text-sm shadow-sm transition-colors cursor-pointer"
                onClick={confirmModal.onOk}
              >
                Confirm Inward
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
