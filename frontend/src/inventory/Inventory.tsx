import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { getCategoryInfo } from '../components/category-icons';
import { X, Trash2 } from 'lucide-react';
import { BeerBottleLoader } from '../components/BeerBottleLoader';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { showToast } from '../lib/toast';

interface StockRow {
  productId: string;
  name: string;
  brand?: string;
  volumeMl?: number;
  packQuantity?: number;
  quantity: number;
  openMl?: number;
  reorderLevel: number;
  mrp: string;
  costPrice?: string;
  previousCostPrice?: string;
  costPerCase?: string;
  lastInvoiceNumber?: string;
  lastInvoiceDate?: string;
  categoryId?: string;
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
  previousCostPrice?: string;
  costPerCase?: string;
  lastInvoiceNumber?: string;
  lastInvoiceDate?: string;
  costUpdatedAt?: string;
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
  casesDelivered?: number | null;
  bottlesDelivered?: number | null;
  packQuantity?: number | null;
  caseRate?: string | null;
  costPrice: string;
  mrp: string;
  taxRate?: string;
  lineCostTotal: string;
  unitDerivedTotal?: string | null;
  roundingAdjustment?: string | null;
  previousCostPrice?: string | null;
  costDifference?: string | null;
  costIncreasePct?: string | null;
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
  linesBasicTotal?: string | null;
  mrpRoundingOff?: string | null;
  roundingAdjustment?: string | null;
  specialExciseCess?: string | null;
  turnoverTax?: string | null;
  tcsAmount?: string | null;
  totalCases?: number | null;
  totalBottles?: number | null;
  challanAmount?: string | null;
  challanNumber?: string | null;
  previousCredit?: string | null;
  subTotal?: string | null;
  netInvoiceValue?: string | null;
  totalInvoiceAmount?: string | null;
  retailerCreditBalance?: string | null;
  status: 'DRAFT' | 'REVIEWED' | 'APPROVED' | 'REJECTED';
  source: string;
  notes?: string;
  extractionWarnings?: string[];
  rejectionReason?: string;
  reviewedById?: string | null;
  reviewedAt?: string | null;
  approvedById?: string | null;
  approvedAt?: string | null;
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
  const [stockCategoryFilter, setStockCategoryFilter] = useState<string>('all');
  const productMap = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

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

  const [onlyIssues, setOnlyIssues] = useState(false);
  const [stockSearch, setStockSearch] = useState('');
  const [stockFilter, setStockFilter] = useState<'all' | 'low' | 'out'>('all');
  const [showBreakage, setShowBreakage] = useState(false);

  // Add Missing Product Modal State
  const [createProductModal, setCreateProductModal] = useState<CreateProductModalState | null>(null);
  const [savingProduct, setSavingProduct] = useState(false);
  const [productFormError, setProductFormError] = useState<string | null>(null);

  // Inward & Approval Progress State
  const [isApproving, setIsApproving] = useState(false);
  const [approvalStage, setApprovalStage] = useState<'saving' | 'inwarding' | 'refreshing'>('saving');
  const [isClearing, setIsClearing] = useState(false);

  // Confirmation Modal
  const [confirmModal, setConfirmModal] = useState<{
    title: string;
    message: string;
    onOk: () => void;
  } | null>(null);

  const [isReviewing, setIsReviewing] = useState(false);
  const [showExciseBreakdown, setShowExciseBreakdown] = useState(false);

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
        casesDelivered: it.casesDelivered,
        bottlesDelivered: it.bottlesDelivered,
        packQuantity: it.packQuantity,
        quantity: it.quantity,
        caseRate: it.caseRate,
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
    if (!activeInvoice || !activeInvoice.invoice.id || isReviewing) return;
    setIsReviewing(true);
    const ok = await saveDraft(true);
    if (!ok) {
      setIsReviewing(false);
      return;
    }
    try {
      const updated = await api.post<ActiveInvoiceData>(`/invoices/detail/${activeInvoice.invoice.id}/review`, {});
      setActiveInvoice(updated);
      await loadInvoices();
      showToast(`✓ Invoice #${activeInvoice.invoice.invoiceNumber || 'Draft'} marked as REVIEWED. Ready for inward confirmation.`, 'success');
    } catch (err: any) {
      showToast('Review failed: ' + err.message, 'error');
    } finally {
      setIsReviewing(false);
    }
  };

  const handleReviewInvoiceById = async (invoiceId: string, invoiceNumber: string) => {
    try {
      await api.post(`/invoices/detail/${invoiceId}/review`, {});
      await loadInvoices();
      showToast(`✓ Invoice #${invoiceNumber || 'Draft'} marked as REVIEWED`, 'success');
    } catch (err: any) {
      showToast('Review failed: ' + err.message, 'error');
    }
  };

  const handleClearCompleteInventory = () => {
    if (!branchId || isClearing) return;
    setConfirmModal({
      title: 'Delete Complete Store Inventory?',
      message:
        'Are you sure you want to delete all current stock, breakage logs, and bills for this store? All bottle counts will be reset to 0 so you can inward fresh stock from invoices.',
      onOk: async () => {
        setConfirmModal(null);
        setIsClearing(true);
        try {
          const res = await api.delete<{ success: boolean; deletedStock: number; deletedInvoices: number }>(
            `/inventory/stock/${branchId}/clear`
          );
          showToast(`✓ Inventory cleared: ${res.deletedStock} stock lines and ${res.deletedInvoices} bills removed.`, 'success');
          await Promise.all([loadStock(), loadInvoices()]);
          setActiveInvoice(null);
          setWizardStep(1);
        } catch (err: any) {
          showToast('Failed to clear inventory: ' + err.message, 'error');
        } finally {
          setIsClearing(false);
        }
      },
    });
  };

  const handleApprove = () => {
    if (isApproving) return;
    if (!activeInvoice || !activeInvoice.invoice.id) return;
    const totalBottles = activeInvoice.items.reduce((sum, it) => sum + (it.quantity || 0), 0);
    const totalCost = parseFloat(activeInvoice.invoice.linesTotal || activeInvoice.invoice.totalAmount).toFixed(2);

    setConfirmModal({
      title: 'Confirm Stock Inward',
      message: `Add ${totalBottles} bottles from Bill ${activeInvoice.invoice.invoiceNumber} to your store stock? This will post ₹${totalCost} to purchase accounts.`,
      onOk: async () => {
        setConfirmModal(null);
        setIsApproving(true);
        setApprovalStage('saving');
        try {
          const ok = await saveDraft(true);
          if (!ok) {
            setIsApproving(false);
            return;
          }
          setApprovalStage('inwarding');
          await api.post<ActiveInvoiceData>(`/invoices/detail/${activeInvoice.invoice.id}/approve`, {});
          showToast(`✓ Success: ${totalBottles} bottles added to store inventory!`, 'success');
          setApprovalStage('refreshing');
          await Promise.all([loadStock(), loadInvoices()]);
          window.dispatchEvent(new CustomEvent('app:stock_updated', { detail: { branchId } }));
          setActiveInvoice(null);
          setWizardStep(1);
          setActiveTab('stock');
        } catch (err: any) {
          showToast('Approval failed: ' + err.message, 'error');
        } finally {
          setIsApproving(false);
        }
      },
    });
  };


  const handleDeleteInvoice = async (id: string, invoiceNumber: string) => {
    if (!window.confirm(`Are you sure you want to delete invoice ${invoiceNumber || 'draft'}? This action cannot be undone.`)) {
      return;
    }
    try {
      await api.delete(`/invoices/detail/${id}`);
      showToast(`Invoice ${invoiceNumber || 'draft'} deleted.`, 'success');
      if (activeInvoice?.invoice.id === id) {
        setActiveInvoice(null);
        setWizardStep(1);
      }
      loadInvoices();
    } catch (err: any) {
      showToast('Failed to delete invoice: ' + err.message, 'error');
    }
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

  const q = stockSearch.trim().toLowerCase();
  const visibleStock = stockRows.filter((r) => {
    if (stockFilter === 'out' && r.quantity > 0) return false;
    if (stockFilter === 'low' && !(r.quantity > 0 && r.quantity <= r.reorderLevel)) return false;
    const prod = productMap.get(r.productId);
    const cat = getCategoryInfo(prod?.categoryName, r.name);
    if (stockCategoryFilter !== 'all' && cat.type !== stockCategoryFilter) return false;
    return !q || r.name.toLowerCase().includes(q) || (r.brand || '').toLowerCase().includes(q);
  });

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
          {/* Step indicator */}
          <ol className="flex items-center gap-2 text-sm">
            {([['Upload', 1], ['Review items', 2], ['Confirm', 3]] as const).map(([label, n], i) => (
              <li key={n} className="flex items-center gap-2">
                {i > 0 && <span className={`h-px w-8 sm:w-14 ${wizardStep >= n ? 'bg-emerald-500' : 'bg-gray-300'}`} />}
                <span
                  className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                    wizardStep === n ? 'bg-blue-600 text-white' : wizardStep > n ? 'bg-emerald-500 text-white' : 'bg-gray-200 text-gray-500'
                  }`}
                >
                  {wizardStep > n ? '✓' : n}
                </span>
                <span className={wizardStep === n ? 'font-semibold text-gray-900' : 'text-gray-500'}>{label}</span>
              </li>
            ))}
          </ol>

          {/* ── STEP 1: Upload / Enter Bill ──────────────────────────────────── */}
          {wizardStep === 1 && !activeInvoice && (
            <div className="bg-white rounded-xl shadow-sm border p-6 max-w-3xl mx-auto space-y-6">
              <div>
                <h2 className="text-xl font-bold text-gray-900">Step 1: Upload Supplier Bill</h2>
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
                        ? 'border-emerald-400 bg-emerald-50/40 dark:bg-emerald-900/20'
                        : 'border-gray-300 dark:border-gray-600 hover:border-gray-400 bg-gray-50/50 dark:bg-gray-800/40'
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
                        <p className="text-xs text-gray-500">
                          PDF, Excel (.xlsx), CSV, or Photo (max 10 MB)
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                {/* Bill Header Info */}
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
                      placeholder="e.g. ICDC / TSBCL"
                      value={uploadSupplier}
                      onChange={(e) => setUploadSupplier(e.target.value)}
                    />
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
                  </div>
                </div>

                {/* Primary Action Button */}
                <div className="pt-4 border-t flex flex-col sm:flex-row items-center justify-between gap-4">
                  <button
                    type="button"
                    className="text-xs text-blue-600 hover:text-blue-800 font-semibold underline flex items-center gap-1 cursor-pointer"
                    onClick={startManualDraft}
                  >
                    <span>✍️</span> Enter bill items manually
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
                  <div className="text-xs text-gray-500 font-medium mt-1">
                    <b>{activeInvoice.items.length} lines</b> ({draftTotalBottles} bottles)
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {isManager && (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-600 dark:text-red-400 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/40 border border-red-200 dark:border-red-800 rounded-lg font-medium cursor-pointer transition-colors"
                      onClick={() => handleDeleteInvoice(activeInvoice.invoice.id, activeInvoice.invoice.invoiceNumber)}
                    >
                      <Trash2 size={14} /> Delete Bill
                    </button>
                  )}
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg font-medium cursor-pointer transition-colors"
                    onClick={() => {
                      setActiveInvoice(null);
                      setWizardStep(1);
                    }}
                  >
                    <X size={14} /> Close &amp; Back
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

              {/* Compact Invoice Reconciliation Bar */}
              {(() => {
                const wholesaleBasic = activeInvoice.invoice.linesBasicTotal
                  ? parseFloat(activeInvoice.invoice.linesBasicTotal)
                  : parseFloat(draftLinesCostTotal);
                const mrpRounding = activeInvoice.invoice.mrpRoundingOff
                  ? parseFloat(activeInvoice.invoice.mrpRoundingOff)
                  : 0;
                const docTotal = parseFloat(activeInvoice.invoice.totalAmount || '0');
                const diff = docTotal - (wholesaleBasic + mrpRounding);
                const isReconciled = Math.abs(diff) < 0.05;
                const hasDepotLedger = !!(activeInvoice.invoice.previousCredit || activeInvoice.invoice.challanAmount || activeInvoice.invoice.retailerCreditBalance);

                return (
                  <div className="p-3 bg-slate-50 dark:bg-slate-900/60 rounded-xl border border-slate-200 dark:border-slate-800">
                    <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
                      <div className="flex flex-wrap items-center gap-4">
                        <div>
                          <span className="text-gray-500 dark:text-slate-400">Lines Cost:</span>{' '}
                          <b className="font-mono text-gray-900 dark:text-gray-100">₹{wholesaleBasic.toFixed(2)}</b>
                        </div>
                        {Math.abs(mrpRounding) > 0.001 && (
                          <div>
                            <span className="text-gray-500 dark:text-slate-400">Rounding:</span>{' '}
                            <b className="font-mono text-blue-600 dark:text-blue-400">{mrpRounding >= 0 ? '+' : ''}₹{mrpRounding.toFixed(2)}</b>
                          </div>
                        )}
                        <div>
                          <span className="text-gray-500 dark:text-slate-400">Document Total:</span>{' '}
                          <b className="font-mono text-emerald-700 dark:text-emerald-400 font-bold">₹{docTotal.toFixed(2)}</b>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        {isReconciled ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800 border border-emerald-300 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800">
                            ✓ Reconciled
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-100 text-amber-800 border border-amber-300 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-800">
                            ⚠️ Diff: ₹{diff.toFixed(2)}
                          </span>
                        )}
                        {hasDepotLedger && (
                          <button
                            type="button"
                            onClick={() => setShowExciseBreakdown((v) => !v)}
                            className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline font-medium cursor-pointer"
                          >
                            {showExciseBreakdown ? 'Hide Details ▴' : 'Excise Details ▾'}
                          </button>
                        )}
                      </div>
                    </div>

                    {showExciseBreakdown && hasDepotLedger && (
                      <div className="mt-3 pt-3 border-t dark:border-slate-800 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                        <div className="p-2 bg-indigo-50/50 dark:bg-indigo-950/30 rounded border border-indigo-100 dark:border-indigo-900/50">
                          <span className="text-gray-500 dark:text-slate-400 text-[10px] block">Opening Credit</span>
                          <span className="font-mono font-bold">₹{parseFloat(activeInvoice.invoice.previousCredit || '0').toFixed(2)}</span>
                        </div>
                        <div className="p-2 bg-indigo-50/50 dark:bg-indigo-950/30 rounded border border-indigo-100 dark:border-indigo-900/50">
                          <span className="text-gray-500 dark:text-slate-400 text-[10px] block">Challan Paid</span>
                          <span className="font-mono font-bold text-emerald-600">+₹{parseFloat(activeInvoice.invoice.challanAmount || '0').toFixed(2)}</span>
                        </div>
                        <div className="p-2 bg-indigo-50/50 dark:bg-indigo-950/30 rounded border border-indigo-100 dark:border-indigo-900/50">
                          <span className="text-gray-500 dark:text-slate-400 text-[10px] block">Total Deducted</span>
                          <span className="font-mono font-bold text-rose-600">-₹{parseFloat(activeInvoice.invoice.totalInvoiceAmount || activeInvoice.invoice.totalAmount || '0').toFixed(2)}</span>
                        </div>
                        <div className="p-2 bg-indigo-50/50 dark:bg-indigo-950/30 rounded border border-indigo-100 dark:border-indigo-900/50">
                          <span className="text-gray-500 dark:text-slate-400 text-[10px] block">Retailer Balance</span>
                          <span className="font-mono font-bold text-indigo-900 dark:text-indigo-200">₹{parseFloat(activeInvoice.invoice.retailerCreditBalance || '0').toFixed(2)}</span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Items */}
              <div>
                <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-gray-900">Line items</h3>
                    {unmatchedItemCount > 0 ? (
                      <span className="text-xs px-2 py-0.5 bg-amber-50 text-amber-700 border border-amber-200 rounded-full">
                        {unmatchedItemCount} to match
                      </span>
                    ) : (
                      <span className="text-xs px-2 py-0.5 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full">
                        All matched
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-4 text-xs text-gray-500">
                    {unmatchedItemCount > 0 && (
                      <label className="flex items-center gap-1.5 cursor-pointer select-none">
                        <input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} />
                        Show only unmatched
                      </label>
                    )}
                    <span>
                      Calculated <b className="text-gray-900 font-mono">₹{draftLinesCostTotal}</b>
                    </span>
                  </div>
                </div>

                <div className="overflow-x-auto border rounded-xl">
                  <table className="w-full text-left text-sm" id="invEditTable">
                    <thead>
                      <tr className="border-b text-[11px] text-gray-500 bg-gray-50 dark:bg-gray-800 uppercase tracking-wider">
                        <th className="py-2.5 px-3 w-8">#</th>
                        <th className="py-2.5 px-3">Item &amp; catalog match</th>
                        <th className="py-2.5 px-2 text-right w-28">Cases / Qty</th>
                        <th className="py-2.5 px-2 text-right w-24">Case Rate</th>
                        <th className="py-2.5 px-2 text-right w-28">Unit Cost ₹</th>
                        <th className="py-2.5 px-2 text-right w-24">MRP ₹</th>
                        <th className="py-2.5 px-3 text-right w-28">Total</th>
                      </tr>
                    </thead>
                    <tbody id="invEditLines" className="divide-y divide-gray-100">
                      {activeInvoice.items.map((it, idx) => {
                        const matched = !!it.productId;
                        if (onlyIssues && matched) return null;
                        return (
                          <tr
                            key={it.id || idx}
                            className={`inv-edit-row align-top ${matched ? 'hover:bg-gray-50/60' : 'bg-amber-50/40'}`}
                            data-item-id={it.id || ''}
                            data-match-status={it.matchStatus}
                          >
                            <td className="py-3 px-3 text-xs text-gray-400 font-mono">{idx + 1}</td>
                            <td className="py-3 px-3 space-y-1.5">
                              <div className="flex items-center gap-2">
                                {(() => {
                                  const matchedProd = it.productId ? productMap.get(it.productId) : null;
                                  const lineCat = getCategoryInfo(matchedProd?.categoryName, it.rawDescription);
                                  const { Icon } = lineCat;
                                  return (
                                    <div className={`w-6 h-6 rounded flex items-center justify-center shrink-0 border ${lineCat.badgeClass}`} title={lineCat.label}>
                                      <Icon size={12} />
                                    </div>
                                  );
                                })()}
                                <input
                                  className="ie-desc w-full px-1 py-0.5 rounded text-sm font-medium text-gray-900 bg-transparent border border-transparent hover:border-gray-200 focus:border-blue-400 focus:bg-white outline-none"
                                  value={it.rawDescription}
                                  onChange={(e) => handleLineDescChange(idx, e.target.value)}
                                  title="Description as printed on the bill"
                                />
                              </div>
                              <div className="flex items-center gap-2">
                                <span
                                  className={`ie-match-badge shrink-0 w-2 h-2 rounded-full ${
                                    matched ? 'bg-emerald-500' : it.matchStatus === 'SUGGESTED' ? 'bg-amber-400' : 'bg-red-500'
                                  }`}
                                  title={matched ? 'Matched' : it.matchStatus === 'SUGGESTED' ? 'Suggested' : 'Needs selection'}
                                />
                                <select
                                  className="ie-prod flex-1 min-w-0 max-w-md w-full p-1.5 border rounded-md text-xs bg-white text-gray-700"
                                  value={it.productId || ''}
                                  onChange={(e) => {
                                    if (e.target.value === '__NEW__') {
                                      openAddProductModalForLine(idx);
                                      return;
                                    }
                                    handleProductChange(idx, e.target.value);
                                  }}
                                >
                                  <option value="">Select catalog product…</option>
                                  <option value="__NEW__">＋ Add new product…</option>
                                  {products.map((p) => {
                                    const pCat = getCategoryInfo(p.categoryName, p.name);
                                    return (
                                      <option key={p.id} value={p.id}>
                                        {pCat.emoji} {p.name} · ₹{parseFloat(p.mrp).toFixed(0)}
                                      </option>
                                    );
                                  })}
                                </select>
                                {!matched && (
                                  <button
                                    type="button"
                                    className="shrink-0 text-xs text-blue-600 hover:underline cursor-pointer"
                                    onClick={() => openAddProductModalForLine(idx)}
                                  >
                                    + New
                                  </button>
                                )}
                              </div>
                              {/* Compact Price Change Pill */}
                              {(() => {
                                const curCost = parseFloat(it.costPrice);
                                const prevCost = it.previousCostPrice ? parseFloat(it.previousCostPrice) : null;
                                if (!curCost || !prevCost || Math.abs(curCost - prevCost) < 0.001) return null;
                                const diff = curCost - prevCost;
                                const pct = prevCost > 0 ? (diff / prevCost) * 100 : 0;
                                const isInc = diff > 0;
                                return (
                                  <div className="mt-1 flex items-center">
                                    <span
                                      title={`Previous rate: ₹${prevCost.toFixed(2)} → New rate: ₹${curCost.toFixed(2)} (${isInc ? '+' : ''}₹${diff.toFixed(2)})`}
                                      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold border cursor-help ${
                                        isInc
                                          ? 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800'
                                          : 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800'
                                      }`}
                                    >
                                      <span>{isInc ? '▲' : '▼'}</span>
                                      <span>{isInc ? '+' : ''}{pct.toFixed(0)}%</span>
                                    </span>
                                  </div>
                                );
                              })()}
                              {(it.flags || []).length > 0 && (
                                <div className="text-[11px] text-amber-700">⚠ {it.flags.join(', ')}</div>
                              )}
                            </td>
                            <td className="py-3 px-2 text-right">
                              <input
                                className="ie-qty w-16 p-1.5 border rounded-md text-right font-mono text-sm bg-white"
                                type="number"
                                min="1"
                                value={it.quantity}
                                onChange={(e) => handleLineQtyChange(idx, e.target.value)}
                              />
                              {(it.casesDelivered !== undefined && it.casesDelivered !== null && it.casesDelivered > 0) && (
                                <div className="text-[10px] text-gray-500 font-mono mt-0.5">
                                  {it.casesDelivered} cs{it.bottlesDelivered ? ` + ${it.bottlesDelivered}b` : ''}
                                </div>
                              )}
                            </td>
                            <td className="py-3 px-2 text-right">
                              {it.caseRate ? (
                                <div className="font-mono text-xs text-gray-900 dark:text-gray-100 font-medium">
                                  ₹{parseFloat(it.caseRate).toFixed(0)}
                                  <div className="text-[9px] text-gray-400">/case</div>
                                </div>
                              ) : (
                                <span className="text-gray-400 text-xs">—</span>
                              )}
                            </td>
                            <td className="py-3 px-2 text-right">
                              <input
                                className="ie-cost w-24 p-1.5 border rounded-md text-right font-mono text-sm bg-white"
                                value={it.costPrice}
                                onChange={(e) => handleLineCostChange(idx, e.target.value)}
                                title={`Unit cost: ₹${parseFloat(it.costPrice || '0').toFixed(6)}`}
                              />
                            </td>
                            <td className="py-3 px-2 text-right">
                              <input
                                className="ie-mrp w-20 p-1.5 border rounded-md text-right font-mono text-sm bg-white"
                                value={it.mrp}
                                onChange={(e) => handleLineMrpChange(idx, e.target.value)}
                              />
                            </td>
                            <td className="py-3 px-3 text-right font-mono font-semibold text-gray-900">
                              <span className="ie-linetotal">₹{parseFloat(it.lineCostTotal).toFixed(2)}</span>
                            </td>
                          </tr>
                        );
                      })}
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
                      disabled={isReviewing || isApproving}
                      className="min-h-[44px] px-4 py-2 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 dark:bg-blue-950/50 dark:hover:bg-blue-900/50 dark:text-blue-300 rounded-lg border border-blue-200 dark:border-blue-800 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 transition-all shadow-sm"
                      onClick={handleReview}
                    >
                      <span>✓</span> {isReviewing ? 'Reviewing…' : 'Mark as Reviewed'}
                    </button>
                  )}

                  {activeInvoice.invoice.status === 'REVIEWED' && (
                    <div className="flex items-center gap-1.5 px-3 py-2 bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 rounded-lg text-xs font-bold shadow-sm">
                      <span>✓</span>
                      <span>Reviewed &amp; Verified</span>
                      {activeInvoice.invoice.reviewedAt && (
                        <span className="text-[11px] font-normal opacity-80">
                          ({new Date(activeInvoice.invoice.reviewedAt).toLocaleDateString()})
                        </span>
                      )}
                    </div>
                  )}

                  {/* Proceed to Step 3 Confirmation Screen */}
                  {activeInvoice.invoice.status === 'APPROVED' ? (
                    <button
                      type="button"
                      className="min-h-[48px] px-6 py-2.5 bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg font-bold text-sm shadow-sm flex items-center gap-2 cursor-pointer"
                      onClick={() => {
                        setActiveInvoice(null);
                        setWizardStep(1);
                        setActiveTab('stock');
                      }}
                    >
                      <span>✓</span> View in Store Stock
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={isApproving}
                      className="min-h-[48px] px-6 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg font-bold text-sm shadow-sm flex items-center gap-2 cursor-pointer transition-all"
                      onClick={() => setWizardStep(3)}
                    >
                      <span>➡️</span> Proceed to Inward Confirmation
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ── STEP 3: Confirmation & Inward Screen ──────────────────────────── */}
          {wizardStep === 3 && activeInvoice && (
            <div className="bg-white dark:bg-slate-900 rounded-xl shadow-sm border dark:border-slate-800 p-6 max-w-3xl mx-auto space-y-6">
              <div className="text-center space-y-1">
                <div className="text-4xl">📦</div>
                <h2 className="text-2xl font-bold text-gray-900 dark:text-slate-100">Confirm Stock Inward</h2>
              </div>

              {/* Big Metrics Cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="p-3.5 bg-blue-50/70 dark:bg-blue-950/40 border border-blue-100 dark:border-blue-900/50 rounded-xl text-center">
                  <div className="text-xs text-blue-600 dark:text-blue-400 font-bold uppercase tracking-wider">Total Bottles</div>
                  <div className="text-2xl font-bold text-blue-900 dark:text-blue-100 mt-1 font-mono">{draftTotalBottles}</div>
                </div>

                <div className="p-3.5 bg-emerald-50/70 dark:bg-emerald-950/40 border border-emerald-100 dark:border-emerald-900/50 rounded-xl text-center">
                  <div className="text-xs text-emerald-600 dark:text-emerald-400 font-bold uppercase tracking-wider">Total Amount</div>
                  <div className="text-2xl font-bold text-emerald-900 dark:text-emerald-100 mt-1 font-mono">
                    ₹{parseFloat(activeInvoice.invoice.linesTotal || activeInvoice.invoice.totalAmount).toFixed(2)}
                  </div>
                </div>

                <div className="p-3.5 bg-purple-50/70 dark:bg-purple-950/40 border border-purple-100 dark:border-purple-900/50 rounded-xl text-center">
                  <div className="text-xs text-purple-600 dark:text-purple-400 font-bold uppercase tracking-wider">Bill Number</div>
                  <div className="text-base font-bold text-purple-900 dark:text-purple-100 mt-2 font-mono truncate" title={activeInvoice.invoice.invoiceNumber}>
                    {activeInvoice.invoice.invoiceNumber}
                  </div>
                </div>

                <div className="p-3.5 bg-amber-50/70 dark:bg-amber-950/40 border border-amber-100 dark:border-amber-900/50 rounded-xl text-center">
                  <div className="text-xs text-amber-600 dark:text-amber-400 font-bold uppercase tracking-wider">Depot / Supplier</div>
                  <div className="text-base font-bold text-amber-900 dark:text-amber-100 mt-2 truncate" title={activeInvoice.invoice.supplierName}>
                    {activeInvoice.invoice.supplierName || 'Depot'}
                  </div>
                </div>
              </div>

              {/* Summary List */}
              <div className="border dark:border-slate-800 rounded-xl p-4 bg-gray-50/50 dark:bg-slate-800/40 space-y-3">
                <div className="text-xs font-bold text-gray-700 dark:text-slate-300 uppercase tracking-wider">
                  Liquor Products to Add:
                </div>
                <div className="max-h-60 overflow-y-auto divide-y divide-gray-200 dark:divide-slate-800 text-sm">
                  {activeInvoice.items.map((it, i) => (
                    <div key={i} className="py-2 flex items-center justify-between">
                      <div>
                        <div className="font-semibold text-gray-900 dark:text-slate-100">{it.productName || it.rawDescription}</div>
                        <div className="text-xs text-gray-500 dark:text-slate-400">
                          MRP ₹{parseFloat(it.mrp).toFixed(2)} · Rate ₹{parseFloat(it.costPrice).toFixed(2)}
                        </div>
                      </div>
                      <div className="text-right">
                        <span className="font-mono font-bold text-gray-900 dark:text-slate-100 text-base">+{it.quantity}</span>{' '}
                        <span className="text-xs text-gray-500 dark:text-slate-400">bottles</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Primary Actions */}
              <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-4 border-t dark:border-slate-800">
                <button
                  type="button"
                  className="min-h-[48px] px-6 py-2.5 text-sm font-semibold text-gray-700 dark:text-slate-200 bg-gray-100 dark:bg-slate-800 hover:bg-gray-200 dark:hover:bg-slate-700 rounded-lg border dark:border-slate-700 flex items-center gap-1.5 cursor-pointer"
                  onClick={() => setWizardStep(2)}
                >
                  <span>✏️</span> Edit or Fix Items
                </button>

                {isManager ? (
                  activeInvoice.invoice.status === 'APPROVED' ? (
                    <button
                      type="button"
                      className="w-full sm:w-auto min-h-[48px] px-8 py-3 bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg font-bold text-base shadow-sm flex items-center justify-center gap-2 cursor-pointer"
                      onClick={() => {
                        setActiveInvoice(null);
                        setWizardStep(1);
                        setActiveTab('stock');
                      }}
                    >
                      <span>✓</span> Inwarded — View Store Stock
                    </button>
                  ) : (
                    <div className="flex items-center gap-3 w-full sm:w-auto">
                      {activeInvoice.invoice.status === 'DRAFT' && (
                        <button
                          type="button"
                          disabled={isReviewing || isApproving}
                          className="min-h-[48px] px-5 py-2.5 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 dark:bg-blue-950/50 dark:hover:bg-blue-900/50 dark:text-blue-300 rounded-lg border border-blue-200 dark:border-blue-800 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 transition-all shadow-sm"
                          onClick={handleReview}
                        >
                          <span>✓</span> {isReviewing ? 'Reviewing…' : 'Mark as Reviewed'}
                        </button>
                      )}
                      <button
                        id="invApproveBtn"
                        type="button"
                        disabled={isApproving}
                        className="w-full sm:w-auto min-h-[48px] px-8 py-3 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg font-bold text-base shadow-sm flex items-center justify-center gap-2 transition-all cursor-pointer"
                        onClick={handleApprove}
                      >
                      {isApproving ? (
                        <>
                          <span className="animate-spin text-lg">🍺</span> Pouring into Live Stock...
                        </>
                      ) : (
                        <>
                          <span>✅</span> Confirm &amp; Add to Live Stock
                        </>
                      )}
                    </button>
                  </div>
                )
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
              <BeerBottleLoader inline size="sm" title="Loading Supplier Bills…" subtitle="Fetching bill history, review status & inward totals…" />
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
                        <div className="flex items-center justify-end gap-1.5">
                          {isManager && inv.status === 'DRAFT' && (
                            <button
                              type="button"
                              className="px-2.5 py-1 bg-blue-50 hover:bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:hover:bg-blue-900/50 dark:text-blue-300 border border-blue-200 dark:border-blue-800 rounded font-semibold text-xs cursor-pointer flex items-center gap-1 shadow-xs transition-colors"
                              onClick={() => handleReviewInvoiceById(inv.id, inv.invoiceNumber)}
                              title="Mark bill as reviewed"
                            >
                              <span>✓</span> Review
                            </button>
                          )}
                          <button
                            type="button"
                            className="px-3 py-1 bg-gray-100 hover:bg-gray-200 text-gray-800 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-gray-200 rounded font-semibold text-xs border dark:border-slate-700 cursor-pointer"
                            onClick={() => openInvoice(inv.id)}
                          >
                            Open Bill
                          </button>
                          {isManager && (
                            <button
                              type="button"
                              title="Delete bill"
                              className="p-1 text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/40 rounded transition-colors cursor-pointer"
                              onClick={() => handleDeleteInvoice(inv.id, inv.invoiceNumber)}
                            >
                              <Trash2 size={16} />
                            </button>
                          )}
                        </div>
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
        <div className="space-y-5">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3" id="stockStats">
            {[
              { k: 'all', label: 'Products', val: stockRows.length, cls: 'text-gray-900' },
              { k: 'bottles', label: 'Bottles on hand', val: totalBottlesStock.toLocaleString('en-IN'), cls: 'text-gray-900' },
              { k: 'low', label: 'Low stock', val: lowCount, cls: 'text-amber-600' },
              { k: 'out', label: 'Out of stock', val: outCount, cls: 'text-red-600' },
            ].map((s) => (
              <button
                key={s.k}
                type="button"
                disabled={s.k === 'bottles'}
                onClick={() => setStockFilter(s.k === 'low' || s.k === 'out' ? (stockFilter === s.k ? 'all' : s.k) : 'all')}
                className={`text-left p-4 bg-white rounded-xl border transition-colors ${
                  stockFilter === s.k ? 'ring-2 ring-blue-500' : s.k !== 'bottles' ? 'hover:border-gray-400 cursor-pointer' : ''
                }`}
              >
                <div className="text-xs text-gray-500">{s.label}</div>
                <div className={`text-2xl font-semibold font-mono mt-1 ${s.cls}`}>{s.val}</div>
              </button>
            ))}
          </div>

          <div className="bg-white dark:bg-slate-900 rounded-xl border dark:border-slate-800">
            {/* Streamlined Single-Row Toolbar */}
            <div className="flex flex-wrap items-center justify-between gap-3 p-3.5 border-b dark:border-slate-800 bg-gray-50/50 dark:bg-slate-800/40">
              <div className="flex items-center gap-2 flex-1 min-w-[260px]">
                <input
                  className="flex-1 p-2 border dark:border-slate-700 rounded-lg text-sm bg-white dark:bg-slate-900 text-gray-900 dark:text-slate-100 placeholder-gray-400"
                  placeholder="Search product or brand…"
                  value={stockSearch}
                  onChange={(e) => setStockSearch(e.target.value)}
                />
                <select
                  value={stockCategoryFilter}
                  onChange={(e) => setStockCategoryFilter(e.target.value)}
                  className="p-2 border dark:border-slate-700 rounded-lg text-sm bg-white dark:bg-slate-900 text-gray-700 dark:text-slate-200 cursor-pointer font-medium"
                >
                  <option value="all">🍷 All Types</option>
                  <option value="beer">🍺 Beer</option>
                  <option value="whisky">🥃 Whisky</option>
                  <option value="wine">🍷 Wine</option>
                  <option value="vodka">🍸 Vodka</option>
                  <option value="rum">🍹 Rum</option>
                  <option value="gin">🌿 Gin</option>
                  <option value="brandy">🍇 Brandy</option>
                </select>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <div className="inline-flex rounded-lg border dark:border-slate-700 bg-white dark:bg-slate-900 p-0.5 text-xs">
                  {(['all', 'low', 'out'] as const).map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setStockFilter(f)}
                      className={`px-3 py-1.5 rounded-md cursor-pointer font-medium transition-colors ${
                        stockFilter === f
                          ? 'bg-blue-600 text-white font-semibold shadow-xs'
                          : 'text-gray-600 dark:text-slate-400 hover:text-gray-900 dark:hover:text-slate-100'
                      }`}
                    >
                      {f === 'all' ? 'All' : f === 'low' ? 'Low Stock' : 'Out of Stock'}
                    </button>
                  ))}
                </div>

                <button
                  type="button"
                  className="px-2.5 py-1.5 text-xs text-gray-600 hover:text-gray-900 dark:text-slate-400 dark:hover:text-slate-200 cursor-pointer border dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900"
                  onClick={loadStock}
                  title="Refresh store stock"
                >
                  ↻ Refresh
                </button>

                <button
                  type="button"
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg border text-rose-700 border-rose-200 bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800 cursor-pointer transition-colors"
                  onClick={() => setShowBreakage((v) => !v)}
                >
                  {showBreakage ? '✕ Hide Breakage' : '💥 Record Breakage'}
                </button>

                {isManager && (
                  <button
                    type="button"
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg border text-red-600 dark:text-red-400 border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/40 hover:bg-red-100 dark:hover:bg-red-900/60 cursor-pointer flex items-center gap-1 transition-colors"
                    onClick={handleClearCompleteInventory}
                    title="Delete all stock and previous bills to start fresh"
                  >
                    <Trash2 size={13} /> Clear Store Stock
                  </button>
                )}
              </div>
            </div>

            <div className="overflow-x-auto" id="stockTable">
              {loadingStock ? (
                <BeerBottleLoader inline size="sm" title="Loading Store Stock…" subtitle="Fetching live bottle counts, cost prices & reorder levels…" />
              ) : visibleStock.length === 0 ? (
                <div className="p-8 text-center text-gray-500 text-sm space-y-2">
                  <div className="text-3xl">📦</div>
                  <div className="font-semibold text-gray-700 dark:text-gray-300">No products in store stock</div>
                  <div className="text-xs text-gray-400">
                    Upload and confirm a supplier invoice in the "Add Supplier Bill" tab to inward bottles into stock.
                  </div>
                  <button
                    type="button"
                    className="mt-2 inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-lg cursor-pointer"
                    onClick={() => {
                      setActiveTab('upload');
                      setWizardStep(1);
                    }}
                  >
                    <span>＋</span> Upload Bill Now
                  </button>
                </div>
              ) : (
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b text-[11px] text-gray-500 bg-gray-50 dark:bg-gray-800 uppercase tracking-wider">
                      <th className="py-2.5 px-4">Product</th>
                      <th className="py-2.5 px-4 w-56">Stock level</th>
                      <th className="py-2.5 px-3 text-right">Cost Price</th>
                      <th className="py-2.5 px-3 text-right">MRP</th>
                      <th className="py-2.5 px-3 text-right">Margin</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {visibleStock.map((r) => {
                      const out = r.quantity <= 0;
                      const low = !out && r.quantity <= r.reorderLevel;
                      const pct = Math.min(100, r.reorderLevel > 0 ? (r.quantity / (r.reorderLevel * 3)) * 100 : r.quantity > 0 ? 100 : 0);
                      return (
                        <tr key={r.productId} className="hover:bg-gray-50/70">
                          <td className="py-3 px-4">
                            {(() => {
                              const prod = productMap.get(r.productId);
                              const cat = getCategoryInfo(prod?.categoryName, r.name);
                              const { Icon } = cat;
                              return (
                                <div className="flex items-start gap-2.5">
                                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border ${cat.badgeClass}`}>
                                    <Icon size={16} />
                                  </div>
                                  <div>
                                    <div className="font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
                                      <span>{r.name}</span>
                                    </div>
                                    <div className="text-xs text-gray-500 mt-0.5 flex items-center gap-1.5 flex-wrap">
                                      <span>
                                        {r.brand || ''}
                                        {r.volumeMl ? ` · ${r.volumeMl}ml` : ''}
                                        {r.packQuantity ? ` · ${r.packQuantity}/cs` : ''}
                                      </span>
                                      {/* Compact Price Increase/Decrease Indicator */}
                                      {(() => {
                                        const prodObj = productMap.get(r.productId);
                                        const curCost = r.costPrice ? parseFloat(r.costPrice) : (prodObj?.costPrice ? parseFloat(prodObj.costPrice) : null);
                                        const prevCost = r.previousCostPrice ? parseFloat(r.previousCostPrice) : (prodObj?.previousCostPrice ? parseFloat(prodObj.previousCostPrice) : null);
                                        if (!curCost || !prevCost || Math.abs(curCost - prevCost) < 0.001) return null;
                                        const diff = curCost - prevCost;
                                        const pctInc = prevCost > 0 ? (diff / prevCost) * 100 : 0;
                                        const isInc = diff > 0;
                                        const invNum = r.lastInvoiceNumber || prodObj?.lastInvoiceNumber;
                                        return (
                                          <span
                                            className={`inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded text-[10px] font-bold font-mono cursor-help ${
                                              isInc
                                                ? 'bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300'
                                                : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
                                            }`}
                                            title={`Cost ${isInc ? 'increased' : 'decreased'}: ₹${prevCost.toFixed(2)} ➔ ₹${curCost.toFixed(2)} (${isInc ? '+' : ''}₹${diff.toFixed(2)}, ${isInc ? '+' : ''}${pctInc.toFixed(1)}%)${invNum ? ` from Inv #${invNum}` : ''}`}
                                          >
                                            {isInc ? '▲' : '▼'} {isInc ? '+' : ''}{pctInc.toFixed(0)}%
                                          </span>
                                        );
                                      })()}
                                    </div>
                                  </div>
                                </div>
                              );
                            })()}
                          </td>
                          <td className="py-3 px-4">
                            <div className="flex items-center gap-3">
                              <span className={`font-mono font-semibold w-10 text-right ${out ? 'text-red-600' : low ? 'text-amber-600' : 'text-gray-900'}`}>
                                {r.quantity}
                              </span>
                              {!!r.openMl && r.volumeMl && (
                                <span className="open-ml text-[11px] text-purple-700 bg-purple-50 border border-purple-200 rounded-full px-2 py-0.5 whitespace-nowrap" title="Opened bottle, poured by the peg">
                                  +{r.openMl} ml open
                                </span>
                              )}
                              <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden" title={`Reorder at ${r.reorderLevel}`}>
                                <div className={`h-full ${out ? 'bg-red-500' : low ? 'bg-amber-400' : 'bg-emerald-500'}`} style={{ width: `${pct}%` }} />
                              </div>
                              {(out || low) && (
                                <span className={`text-[11px] font-semibold ${out ? 'text-red-600' : 'text-amber-600'}`}>{out ? 'Out' : 'Low'}</span>
                              )}
                            </div>
                          </td>
                          <td className="py-3 px-3 text-right">
                            {(() => {
                              const prodObj = productMap.get(r.productId);
                              const cost = r.costPrice || prodObj?.costPrice;
                              const caseCost = r.costPerCase || prodObj?.costPerCase;
                              if (!cost) return <span className="text-gray-400 text-xs">—</span>;
                              return (
                                <div>
                                  <span className="font-mono font-semibold text-gray-900 dark:text-gray-100">
                                    ₹{parseFloat(cost).toFixed(2)}
                                  </span>
                                  {caseCost && (
                                    <div className="text-[10px] text-gray-500 font-mono">
                                      ₹{parseFloat(caseCost).toFixed(0)}/cs
                                    </div>
                                  )}
                                </div>
                              );
                            })()}
                          </td>
                          <td className="py-3 px-3 text-right font-mono font-bold text-gray-900 dark:text-gray-100">
                            ₹{parseFloat(r.mrp).toFixed(2)}
                          </td>
                          <td className="py-3 px-3 text-right">
                            {(() => {
                              const prodObj = productMap.get(r.productId);
                              const cost = r.costPrice ? parseFloat(r.costPrice) : (prodObj?.costPrice ? parseFloat(prodObj.costPrice) : null);
                              const mrp = parseFloat(r.mrp);
                              if (!cost || !mrp) return <span className="text-gray-400 text-xs">—</span>;
                              const margin = ((mrp - cost) / mrp) * 100;
                              return (
                                <span className={`inline-flex px-1.5 py-0.5 rounded text-[11px] font-bold ${
                                  margin >= 20
                                    ? 'text-emerald-700 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-950/30'
                                    : 'text-amber-700 bg-amber-50 dark:text-amber-300 dark:bg-amber-950/30'
                                }`}>
                                  {margin.toFixed(1)}%
                                </span>
                              );
                            })()}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {showBreakage && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <div className="bg-white rounded-xl border p-5 space-y-4">
                <h3 className="text-sm font-semibold text-gray-900">Record broken bottle</h3>
                <form onSubmit={handleRecordBreakage} className="space-y-3">
                  <select
                    id="breakProduct"
                    aria-label="Product"
                    className="w-full p-2 border rounded-lg text-sm bg-white"
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
                  <div className="grid grid-cols-[100px_1fr] gap-3">
                    <input
                      id="breakQty"
                      aria-label="Broken bottles"
                      type="number"
                      min="1"
                      className="p-2 border rounded-lg text-sm font-mono"
                      value={breakQty}
                      onChange={(e) => setBreakQty(e.target.value)}
                      required
                    />
                    <input
                      id="breakReason"
                      aria-label="Reason"
                      className="p-2 border rounded-lg text-sm"
                      placeholder="Reason, e.g. slipped while shelving"
                      value={breakReason}
                      onChange={(e) => setBreakReason(e.target.value)}
                      required
                      minLength={3}
                    />
                  </div>
                  <button
                    id="breakSubmit"
                    type="submit"
                    className="w-full min-h-[40px] bg-red-600 hover:bg-red-700 text-white rounded-lg font-semibold text-sm cursor-pointer"
                  >
                    Record breakage
                  </button>
                </form>
              </div>

              {isManager && (
                <div className="bg-white rounded-xl border p-5 space-y-3">
                  <h3 className="text-sm font-semibold text-gray-900">Breakage, last 30 days</h3>
                  <div id="breakLog" className="overflow-x-auto max-h-64 overflow-y-auto">
                    {breakLog.length === 0 ? (
                      <div className="p-6 text-center text-gray-400 text-xs">No breakage recorded.</div>
                    ) : (
                      <table className="w-full text-left text-xs">
                        <tbody className="divide-y divide-gray-100">
                          {breakLog.map((b) => (
                            <tr key={b.id}>
                              <td className="py-2 pr-2 text-gray-500 whitespace-nowrap">
                                {new Date(b.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                              </td>
                              <td className="py-2 pr-2">
                                <div className="font-medium text-gray-900">{b.productName}</div>
                                <div className="text-gray-500 truncate max-w-[220px]">{b.reason}</div>
                              </td>
                              <td className="py-2 text-right font-mono">
                                ×{b.quantity}
                                <div className="text-gray-500">₹{parseFloat(b.costValue).toFixed(0)}</div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
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
                className="p-1 rounded-md text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer transition-colors"
                onClick={() => setCreateProductModal(null)}
                aria-label="Close dialog"
              >
                <X size={20} />
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
          <div className="bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-2xl shadow-2xl max-w-md w-full p-6 space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="text-lg font-bold" id="confirmTitle">
                {confirmModal.title}
              </h3>
              <button
                type="button"
                className="p-1 rounded-md text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer transition-colors"
                onClick={() => setConfirmModal(null)}
                aria-label="Close dialog"
              >
                <X size={20} />
              </button>
            </div>
            <p className="text-gray-600 text-sm leading-relaxed" id="confirmText">
              {confirmModal.message}
            </p>
            <div className="flex justify-end gap-3 pt-2">
              <button
                id="confirmCancel"
                type="button"
                disabled={isApproving}
                className="min-h-[44px] px-5 py-2 text-gray-700 hover:bg-gray-100 rounded-lg border font-semibold text-sm transition-colors cursor-pointer disabled:opacity-50"
                onClick={() => setConfirmModal(null)}
              >
                Cancel
              </button>
              <button
                id="confirmOk"
                type="button"
                disabled={isApproving}
                className="min-h-[44px] px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg font-bold text-sm shadow-sm transition-colors cursor-pointer flex items-center gap-2"
                onClick={confirmModal.onOk}
              >
                {isApproving ? 'Pouring...' : 'Confirm Inward'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Animated Themed Beer Bottle Loaders ────────────────────────── */}
      {/* 1. During Stock Inward & Approval */}
      <BeerBottleLoader
        open={isApproving}
        title="Pouring Stock into Live Inventory..."
        subtitle="Adding bottles to store stock, updating ledgers, and securing audit logs..."
        stage={approvalStage}
        bottlesCount={activeInvoice?.items.reduce((sum, it) => sum + (it.quantity || 0), 0)}
        totalCost={parseFloat(activeInvoice?.invoice.linesTotal || activeInvoice?.invoice.totalAmount || '0').toFixed(2)}
      />

      {/* 2. During Invoice Upload & PDF/Image Extraction */}
      <BeerBottleLoader
        open={uploading}
        title="Uncapping & Scanning Supplier Bill..."
        subtitle="Extracting invoice details, pack quantities, unit rates and matching items..."
        stage="saving"
      />

      {/* 3. During Store Inventory Reset */}
      <BeerBottleLoader
        open={isClearing}
        title="Emptying Store Shelves..."
        subtitle="Resetting store stock and purchase records to zero..."
        stage="inwarding"
      />
    </section>
  );
}
