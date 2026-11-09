import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { getCategoryInfo } from '../components/category-icons';
import { X, Trash2, AlertTriangle, FileText, Camera, PackageOpen, Loader2, Pencil, Check, Eye } from 'lucide-react';
import { BeerBottleLoader } from '../components/BeerBottleLoader';
import { ProtectedButton, Modal } from '../components/ui';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { showToast } from '../lib/toast';
import { businessDate } from '../lib/business-day';
import ChallanTotals from './ChallanTotals';
import { StockSplit } from './StockSplit';

interface BrandMappingRow {
  id: string;
  brandCode: string;
  volumeMl?: number | null;
  productId: string;
  productName: string | null;
  categoryName: string | null;
}

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
  volumeMl?: number | null;
  productVolumeMl?: number | null;
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
  shopName?: string | null;
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
  status: 'DRAFT' | 'REVIEWED' | 'APPROVED' | 'REJECTED' | 'REVERSED';
  source: string;
  notes?: string;
  extractionWarnings?: string[];
  extractionMeta?: Record<string, unknown> | null;
  rejectionReason?: string;
  reviewedById?: string | null;
  reviewedAt?: string | null;
  approvedById?: string | null;
  approvedAt?: string | null;
}

function formatInvoiceDate(val?: string | null): string {
  if (!val) return '—';
  if (val.includes('T')) return val.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}/.test(val)) return val.slice(0, 10);
  try {
    const d = new Date(val);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  } catch {
    // fallback
  }
  return val;
}

function extractVolumeMl(desc: string): number | null {
  const m = desc.match(/\b(2000|1000|750|700|650|500|375|330|275|250|200|180|90|60)\s*ml\b/i) ||
            desc.match(/\b(2000|1000|750|700|650|500|375|330|275|250|200|180|90|60)ml\b/i);
  return m ? parseInt(m[1], 10) : null;
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

/** What the bill's lines add up to. A bill typed in by hand carries a stale "0.00" until it is saved, so work it out from the lines. */
function invoiceLinesTotal(data: ActiveInvoiceData | null): string {
  if (!data) return '0.00';
  const saved = parseFloat(data.invoice.linesTotal || '0');
  if (data.invoice.id && saved > 0) return saved.toFixed(2);
  const computed = data.items.reduce((sum, it) => sum + (it.quantity || 0) * parseFloat(it.costPrice || '0'), 0);
  return computed.toFixed(2);
}

export function Inventory() {
  const { user, branches, activeBranchId } = useAuth();
  const branchId = activeBranchId ?? user?.branchId;
  const currentBranch = branches?.find((b) => b.id === branchId);
  const shopName = currentBranch?.name || 'Main Store';
  const isManager = user?.role === 'manager' || user?.role === 'owner';

  // Navigation tab: 'upload' = Bill Inward Wizard, 'history' = Invoices History, 'all-invoices' = All Uploaded Invoices, 'stock' = Store Stock & Breakage
  const [activeTab, setActiveTab] = useState<'upload' | 'history' | 'all-invoices' | 'stock'>('upload');
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string>('');
  const [viewSnapshot, setViewSnapshot] = useState<ActiveInvoiceData | null>(null);
  const [loadingSnapshot, setLoadingSnapshot] = useState(false);

  // Brand Code Mapping State
  const [brandMappings, setBrandMappings] = useState<BrandMappingRow[]>([]);
  const [editingRowIdx, setEditingRowIdx] = useState<number | null>(null);
  const [newMappingNames, setNewMappingNames] = useState<Record<string, string>>({});
  const [newMappingCats, setNewMappingCats] = useState<Record<string, string>>({});
  const [savingMappingCode, setSavingMappingCode] = useState<string | null>(null);

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
  const [stockFilter, setStockFilter] = useState<'all' | 'in' | 'low' | 'out'>('all');
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
    const today = businessDate();
    const past = businessDate(-30);
    try {
      const res = await api.get<{ entries: any[] }>(`/compliance/breakage/${branchId}?from=${past}&to=${today}`);
      setBreakLog(res.entries);
    } catch {
      // quiet fail
    }
  };

  const loadBrandMappings = async () => {
    try {
      const res = await api.get<{ mappings: BrandMappingRow[] }>('/inventory/brand-mappings');
      setBrandMappings(res.mappings || []);
    } catch {
      // quiet fail
    }
  };

  const openSnapshot = async (id: string) => {
    if (!id) return;
    setLoadingSnapshot(true);
    try {
      const data = await api.get<ActiveInvoiceData>('/invoices/detail/' + id);
      setViewSnapshot(data);
    } catch (err: any) {
      showToast('Could not load invoice snapshot: ' + err.message, 'error');
    } finally {
      setLoadingSnapshot(false);
    }
  };

  const getBrandCode = (it: InvoiceItem) => {
    if (it.barcode && it.barcode.trim()) return it.barcode.trim();
    if ((it as any).exciseCode && (it as any).exciseCode.trim()) return (it as any).exciseCode.trim();
    const m = it.rawDescription.match(/^[A-Za-z0-9_-]{3,12}/);
    return m ? m[0] : it.rawDescription.slice(0, 8);
  };

  const handleSaveBrandMapping = async (lineIdx: number, brandCode: string, volumeMl?: number | null) => {
    const mapKey = volumeMl ? `${brandCode}_${volumeMl}` : brandCode;
    setSavingMappingCode(mapKey);
    try {
      const it = activeInvoice?.items[lineIdx];
      const pName = newMappingNames[mapKey]?.trim() || (it?.rawDescription ? (volumeMl && !it.rawDescription.includes(`${volumeMl}ml`) ? `${it.rawDescription} ${volumeMl}ml` : it.rawDescription) : brandCode);
      const cName = newMappingCats[mapKey] || 'Whisky';
      const created = await api.post<BrandMappingRow>('/inventory/brand-mappings', {
        brandCode,
        volumeMl,
        productName: pName,
        categoryName: cName,
        branchId,
        packQuantity: it?.packQuantity ?? (volumeMl === 180 ? 48 : volumeMl === 375 ? 24 : volumeMl === 90 ? 96 : 12),
        costPrice: it?.costPrice,
        mrp: it?.mrp,
      });
      showToast(`Brand code "${brandCode}" ${volumeMl ? `(${volumeMl}ml)` : ''} mapped to "${pName}"`, 'success');
      await loadBrandMappings();
      await loadStock();
      if (activeInvoice) {
        const nextItems = [...activeInvoice.items];
        nextItems[lineIdx] = {
          ...nextItems[lineIdx],
          productId: created.productId,
          productName: created.productName || pName,
          matchStatus: 'MATCHED',
        };
        setActiveInvoice({ ...activeInvoice, items: nextItems });
      }
    } catch (err: any) {
      showToast('Failed to save mapping: ' + err.message, 'error');
    } finally {
      setSavingMappingCode(null);
    }
  };

  useEffect(() => {
    loadStock();
    loadInvoices();
    loadBreakage();
    loadBrandMappings();
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
    const today = businessDate();
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

  const _handleProductChange = (idx: number, prodId: string) => {
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
  void _handleProductChange;

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

  // The id of the bill after the latest successful save. A bill typed in by hand has no id until its first save, and the
  // state set by that save is not visible to the handler that asked for it, so callers read the id from here.
  const savedInvoiceIdRef = useRef<string>('');

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
      // Depot-challan figures (edited in the Challan totals panel); '' clears a figure
      ...((inv.extractionMeta as { engine?: string } | null | undefined)?.engine === 'icdc-extractor'
        ? Object.fromEntries(
            (['linesBasicTotal', 'mrpRoundingOff', 'netInvoiceValue', 'turnoverTax', 'specialExciseCess', 'tcsAmount',
              'challanAmount', 'previousCredit', 'subTotal', 'retailerCreditBalance'] as const)
              .map((k) => [k, inv[k] === undefined ? undefined : (inv[k] === null || String(inv[k]).trim() === '' ? null : String(inv[k]))]),
          )
        : {}),
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
        savedInvoiceIdRef.current = updated.invoice.id || inv.id;
        setActiveInvoice(updated);
      } else {
        const created = await api.post<ActiveInvoiceData>('/invoices/' + branchId, payload);
        savedInvoiceIdRef.current = created.invoice.id;
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
    if (!activeInvoice || isReviewing) return;
    setIsReviewing(true);
    const ok = await saveDraft(true);
    if (!ok) {
      setIsReviewing(false);
      return;
    }
    try {
      const updated = await api.post<ActiveInvoiceData>(`/invoices/detail/${savedInvoiceIdRef.current || activeInvoice.invoice.id}/review`, {});
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
    if (!activeInvoice) return;
    const totalBottles = activeInvoice.items.reduce((sum, it) => sum + (it.quantity || 0), 0);
    const linesCost = invoiceLinesTotal(activeInvoice);
    // A depot challan posts more than its lines: MRP rounding off, turnover tax, special excise cess and TCS are added to
    // what is owed to the depot, so say the amount that will really be booked.
    const inv = activeInvoice.invoice;
    const isChallan = (inv.extractionMeta as { engine?: string } | null | undefined)?.engine === 'icdc-extractor';
    const num = (v?: string | null) => (v ? parseFloat(v) || 0 : 0);
    const payable = isChallan && inv.netInvoiceValue
      ? num(inv.netInvoiceValue) + num(inv.turnoverTax) + num(inv.specialExciseCess) + num(inv.tcsAmount)
      : null;
    const postedText = payable !== null
      ? `This will post ₹${payable.toFixed(2)} to purchase accounts (lines ₹${linesCost} + rounding, taxes and TCS).`
      : `This will post ₹${linesCost} to purchase accounts.`;

    setConfirmModal({
      title: 'Confirm Stock Inward',
      message: `Add ${totalBottles} bottles from Bill ${activeInvoice.invoice.invoiceNumber} to your store stock? ${postedText}`,
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
          await api.post<ActiveInvoiceData>(`/invoices/detail/${savedInvoiceIdRef.current || activeInvoice.invoice.id}/approve`, {});
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

  // An approved invoice is never deleted: it is reversed (stock taken back out, reversing vouchers posted, trail kept)
  const [reverseTarget, setReverseTarget] = useState<{ id: string; number: string } | null>(null);
  const [reverseReason, setReverseReason] = useState('');
  const [reversing, setReversing] = useState(false);

  const handleReverseInvoice = async () => {
    if (!reverseTarget) return;
    if (reverseReason.trim().length < 5) {
      showToast('Give a reason of at least 5 characters.', 'error');
      return;
    }
    setReversing(true);
    try {
      await api.post(`/invoices/detail/${reverseTarget.id}/reverse`, { reason: reverseReason.trim() });
      showToast(`Invoice ${reverseTarget.number || ''} reversed — stock and books restored.`, 'success');
      if (activeInvoice?.invoice.id === reverseTarget.id) {
        setActiveInvoice(null);
        setWizardStep(1);
      }
      setReverseTarget(null);
      setReverseReason('');
      loadInvoices();
    } catch (err: any) {
      showToast('Could not reverse: ' + err.message, 'error');
    } finally {
      setReversing(false);
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
  const inStockCount = stockRows.filter((r) => r.quantity > 0).length;
  const lowCount = stockRows.filter((r) => r.quantity > 0 && r.quantity <= r.reorderLevel).length;
  const outCount = stockRows.filter((r) => r.quantity <= 0).length;
  const totalBottlesStock = stockRows.reduce((sum, r) => sum + r.quantity, 0);

  const q = stockSearch.trim().toLowerCase();
  const visibleStock = stockRows.filter((r) => {
    if (stockFilter === 'in' && r.quantity <= 0) return false;
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
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-6 pb-4 border-b border-gray-200 dark:border-gray-700">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-50" id="stockTitle">
            Supplier Invoices
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {activeTab === 'all-invoices' ? 'All uploaded supplier invoices with immutable snapshots and history.'
              : activeTab === 'upload' ? 'Upload or create a supplier invoice, map brand codes, and submit.'
              : activeTab === 'history' ? 'Every supplier invoice, with its review and inward status.'
              : 'Live bottle counts, cost and margin for this store.'}
          </p>
        </div>

        {/* Tab Switcher */}
        <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-1 text-sm font-medium">
          <button
            type="button"
            className={`px-4 py-2 rounded-md transition-all flex items-center gap-2 cursor-pointer ${
              activeTab === 'upload'
                ? 'bg-purple-600 text-white shadow-sm font-semibold'
                : 'text-gray-700 hover:text-gray-900 hover:bg-gray-100'
            }`}
            onClick={() => setActiveTab('upload')}
          >
            Add Supplier Bill
          </button>
          <button
            type="button"
            className={`px-4 py-2 rounded-md transition-all flex items-center gap-2 cursor-pointer ${
              activeTab === 'history'
                ? 'bg-purple-600 text-white shadow-sm font-semibold'
                : 'text-gray-700 hover:text-gray-900 hover:bg-gray-100'
            }`}
            onClick={() => {
              setActiveTab('history');
              loadInvoices();
            }}
          >
            Invoices History
          </button>
          <button
            type="button"
            className={`px-4 py-2 rounded-md transition-all flex items-center gap-2 cursor-pointer ${
              activeTab === 'all-invoices'
                ? 'bg-purple-600 text-white shadow-sm font-semibold'
                : 'text-gray-700 hover:text-gray-900 hover:bg-gray-100'
            }`}
            onClick={() => {
              setActiveTab('all-invoices');
              loadInvoices();
            }}
          >
            All Invoices
            <span className="ml-1 text-xs px-2 py-0.5 rounded-full bg-gray-200 text-gray-800 font-mono">
              {invoices.length}
            </span>
          </button>
          <button
            type="button"
            className={`px-4 py-2 rounded-md transition-all flex items-center gap-2 cursor-pointer ${
              activeTab === 'stock'
                ? 'bg-purple-600 text-white shadow-sm font-semibold'
                : 'text-gray-700 hover:text-gray-900 hover:bg-gray-100'
            }`}
            onClick={() => {
              setActiveTab('stock');
              loadStock();
            }}
          >
            Current Store Stock
          </button>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {/* TAB 0: ALL INVOICES (DEFAULT)                                           */}
      {/* ═══════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'all-invoices' && (
        <div className="bg-white dark:bg-slate-900 rounded-xl shadow-sm border dark:border-slate-800 p-6 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b dark:border-slate-800">
            <div>
              <h2 className="text-lg font-bold text-gray-900 dark:text-slate-100">All Uploaded Invoices</h2>
              <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">
                Select an invoice number to view its immutable snapshot, or browse all recorded invoices below.
              </p>
            </div>
            <button
              type="button"
              className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-xs font-semibold shadow-sm flex items-center gap-2 cursor-pointer self-start sm:self-auto"
              onClick={() => {
                setActiveInvoice(null);
                setWizardStep(1);
                setActiveTab('upload');
              }}
            >
              <span>＋</span> Upload New Invoice
            </button>
          </div>

          {/* Invoice Number Dropdown & View Button */}
          <div className="flex flex-wrap items-center gap-3 p-4 bg-gray-50 dark:bg-slate-800/60 rounded-xl border dark:border-slate-700">
            <div className="flex-1 min-w-[260px]">
              <label htmlFor="allInvoicesDropdown" className="text-xs font-semibold text-gray-600 dark:text-slate-300 uppercase tracking-wider block mb-1">
                Select Invoice Number
              </label>
              <select
                id="allInvoicesDropdown"
                className="w-full p-2.5 border dark:border-slate-700 rounded-lg text-sm bg-white dark:bg-slate-900 text-gray-900 dark:text-slate-100 font-mono"
                value={selectedInvoiceId}
                onChange={(e) => setSelectedInvoiceId(e.target.value)}
              >
                <option value="">-- Choose an invoice to view snapshot --</option>
                {invoices.map((inv) => (
                  <option key={inv.id} value={inv.id}>
                    {inv.invoiceNumber} · {inv.supplierName} ({inv.invoiceDate || inv.createdAt.slice(0, 10)}) — ₹{parseFloat(inv.totalAmount).toFixed(2)} [{inv.status}]
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              id="viewSelectedInvoiceBtn"
              disabled={!selectedInvoiceId || loadingSnapshot}
              className="px-5 py-2.5 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white rounded-lg font-bold text-sm shadow-sm flex items-center gap-2 cursor-pointer transition-all self-end"
              onClick={() => openSnapshot(selectedInvoiceId)}
            >
              <Eye size={16} /> {loadingSnapshot ? 'Loading Snapshot…' : 'View Snapshot'}
            </button>
          </div>

          {/* Invoices List Table */}
          <div className="overflow-x-auto border dark:border-slate-800 rounded-xl">
            {loadingInvoices ? (
              <BeerBottleLoader inline size="sm" title="Loading Invoices…" subtitle="Fetching all uploaded supplier invoices…" />
            ) : invoices.length === 0 ? (
              <div className="p-8 text-center text-gray-500 text-sm">No invoices found. Click "Upload New Invoice" to begin.</div>
            ) : (
              <table className="w-full text-left text-sm" id="allInvoicesTable">
                <thead>
                  <tr className="border-b text-xs text-gray-500 dark:text-slate-400 bg-gray-50/70 dark:bg-slate-800/70 uppercase tracking-wider">
                    <th className="py-2.5 px-3">Invoice Number</th>
                    <th className="py-2.5 px-3">Depot / Supplier</th>
                    <th className="py-2.5 px-3">Invoice Date</th>
                    <th className="py-2.5 px-3 text-right">Items</th>
                    <th className="py-2.5 px-3 text-right">Total Amount</th>
                    <th className="py-2.5 px-3">Status</th>
                    <th className="py-2.5 px-3 text-right">Snapshot</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
                  {invoices.map((inv) => (
                    <tr key={inv.id} className="hover:bg-gray-50/70 dark:hover:bg-slate-800/60 transition-colors">
                      <td className="py-3 px-3">
                        <div className="font-bold text-gray-900 dark:text-slate-100 font-mono">{inv.invoiceNumber}</div>
                        {inv.originalFilename && (
                          <div className="text-[11px] text-gray-400 truncate max-w-xs">{inv.originalFilename}</div>
                        )}
                      </td>
                      <td className="py-3 px-3 text-gray-800 dark:text-slate-200 font-medium">{inv.supplierName || '—'}</td>
                      <td className="py-3 px-3 text-xs text-gray-600 dark:text-slate-400">
                        {inv.invoiceDate ? new Date(inv.invoiceDate).toLocaleDateString('en-IN') : new Date(inv.createdAt).toLocaleDateString('en-IN')}
                      </td>
                      <td className="py-3 px-3 text-right font-mono font-medium">{inv.lineCount}</td>
                      <td className="py-3 px-3 text-right font-mono font-bold text-gray-900 dark:text-slate-100">
                        ₹{parseFloat(inv.totalAmount).toFixed(2)}
                      </td>
                      <td className="py-3 px-3">
                        <span
                          className={`text-xs px-2.5 py-0.5 rounded-full font-bold ${
                            inv.status === 'APPROVED'
                              ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300'
                              : inv.status === 'REVIEWED'
                              ? 'bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300'
                              : inv.status === 'REJECTED'
                              ? 'bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300'
                              : 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300'
                          }`}
                        >
                          {inv.status}
                        </span>
                      </td>
                      <td className="py-3 px-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-gray-800 dark:text-slate-200 rounded-lg text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
                            onClick={() => openSnapshot(inv.id)}
                            title="View read-only immutable snapshot"
                          >
                            <Eye size={13} /> View
                          </button>
                          <button
                            type="button"
                            className="px-3 py-1.5 bg-purple-50 text-purple-700 hover:bg-purple-100 dark:bg-purple-950/50 dark:text-purple-300 rounded-lg text-xs font-semibold cursor-pointer"
                            onClick={() => openInvoice(inv.id)}
                            title="Open in Wizard / Inward review"
                          >
                            Open
                          </button>
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
                    wizardStep === n ? 'bg-purple-600 text-white' : wizardStep > n ? 'bg-emerald-500 text-white' : 'bg-gray-200 text-gray-500'
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
                  <AlertTriangle size={20} className="shrink-0 mt-0.5" aria-hidden="true" />
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
                        ? 'border-purple-500 bg-purple-50'
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
                        <FileText size={32} className="mx-auto text-gray-400" aria-hidden="true" />
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
                        <Camera size={36} className="mx-auto text-gray-400" aria-hidden="true" />
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
                      className="w-full p-2.5 border rounded-lg text-sm bg-white focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none"
                      maxLength={60}
                      placeholder="e.g. ICDC032070940 or INV-001"
                      value={uploadNumber}
                      onChange={(e) => handleUploadNumberChange(e.target.value)}
                    />

                    {/* Real-time Debounce Feedback */}
                    {dupCheckStatus === 'checking' && (
                      <div className="text-xs text-blue-600 flex items-center gap-1 font-medium mt-1">
                        Checking if bill was already added…
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
                          Already Uploaded
                        </div>
                        <p>{dupCheckMsg}</p>
                        {dupCheckExisting?.id && (
                          <button
                            type="button"
                            className="mt-1 px-3 py-1 bg-red-600 hover:bg-red-700 text-white rounded font-medium text-xs flex items-center gap-1 cursor-pointer"
                            onClick={() => openInvoice(dupCheckExisting.id)}
                          >
                            Open Existing Bill
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
                      className="w-full p-2.5 border rounded-lg text-sm bg-white focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none"
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
                      className="w-full p-2.5 border rounded-lg text-sm bg-white focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none"
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
                    Enter bill items manually
                  </button>

                  <button
                    id="invUploadBtn"
                    type="submit"
                    disabled={uploading || dupCheckStatus === 'duplicate' || !uploadFile}
                    className="w-full sm:w-auto min-h-[48px] px-8 py-3 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white rounded-lg font-bold text-base shadow-sm flex items-center justify-center gap-2 transition-all cursor-pointer"
                  >
                    {uploading ? (
                      <>
                        <Loader2 size={16} className="animate-spin" aria-hidden="true" /> Reading Bill Items…
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
                  {activeInvoice.invoice.status === 'APPROVED' ? (
                    <ProtectedButton
                      type="button"
                      minRole="manager"
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-amber-800 bg-amber-50 hover:bg-amber-100 border border-amber-300 rounded-lg font-medium cursor-pointer transition-colors"
                      onClick={() => { setReverseReason(''); setReverseTarget({ id: activeInvoice.invoice.id, number: activeInvoice.invoice.invoiceNumber }); }}
                      title="An approved invoice cannot be deleted. Reversing takes the stock back out and posts reversing entries."
                    >
                      Reverse invoice
                    </ProtectedButton>
                  ) : (
                    <ProtectedButton
                      variant="danger"
                      minRole="manager"
                      confirmMessage={`Are you sure you want to delete invoice ${activeInvoice.invoice.invoiceNumber || 'draft'}? This action cannot be undone.`}
                      confirmLabel="Delete"
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-600 dark:text-red-400 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/40 border border-red-200 dark:border-red-800 rounded-lg font-medium cursor-pointer transition-colors"
                      onClick={() => handleDeleteInvoice(activeInvoice.invoice.id, activeInvoice.invoice.invoiceNumber)}
                    >
                      <Trash2 size={14} /> Delete Bill
                    </ProtectedButton>
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
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-4 p-4 bg-gray-50 rounded-xl border">
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
                  <label className="block text-xs font-bold text-gray-600">
                    Shop / Licensee Name
                  </label>
                  <div
                    className="w-full mt-1 p-2 border rounded text-sm bg-gray-100 font-medium text-gray-800 truncate"
                    title={(activeInvoice.invoice.extractionMeta?.shopName as string) || activeInvoice.invoice.shopName || shopName}
                  >
                    {(activeInvoice.invoice.extractionMeta?.shopName as string) || activeInvoice.invoice.shopName || shopName}
                  </div>
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
                      {editDupMsg}
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
                        <th className="py-2.5 px-3">Item &amp; Brand Code Match</th>
                        <th className="py-2.5 px-2 text-right w-28">Qty</th>
                        <th className="py-2.5 px-2 text-right w-24">Case Rate</th>
                        <th className="py-2.5 px-2 text-right w-28">Unit Cost ₹</th>
                        <th className="py-2.5 px-2 text-right w-24">MRP ₹</th>
                        <th className="py-2.5 px-3 text-right w-28">Total</th>
                        <th className="py-2.5 px-2 text-center w-12">Edit</th>
                      </tr>
                    </thead>
                    <tbody id="invEditLines" className="divide-y divide-gray-100">
                      {activeInvoice.items.map((it, idx) => {
                        const code = getBrandCode(it);
                        const vol = it.volumeMl ?? extractVolumeMl(it.rawDescription) ?? null;
                        const mappedMapping = brandMappings.find((m) => {
                          if (m.brandCode.toLowerCase().trim() !== code.toLowerCase().trim()) return false;
                          if (vol && m.volumeMl) return m.volumeMl === vol;
                          if (!vol && !m.volumeMl) return true;
                          return false;
                        });
                        const matchedProd = it.productId ? productMap.get(it.productId) : mappedMapping?.productId ? productMap.get(mappedMapping.productId) : null;
                        const isMatched = !!(matchedProd && (!vol || !matchedProd.volumeMl || matchedProd.volumeMl === vol));
                        const mapKey = vol ? `${code}_${vol}` : code;
                        const isEditing = editingRowIdx === idx;

                        if (onlyIssues && isMatched) return null;
                        return (
                          <tr
                            key={it.id || idx}
                            className={`inv-edit-row align-top ${isMatched ? 'hover:bg-gray-50/60' : 'bg-amber-50/40'}`}
                            data-item-id={it.id || ''}
                            data-match-status={it.matchStatus}
                          >
                            <td className="py-3 px-3 text-xs text-gray-400 font-mono">{idx + 1}</td>
                            <td className="py-3 px-3 space-y-1.5">
                              <div className="flex items-center gap-2">
                                {(() => {
                                  const lineCat = getCategoryInfo(matchedProd?.categoryName || mappedMapping?.categoryName, it.rawDescription);
                                  const { Icon } = lineCat;
                                  return (
                                    <div className={`w-6 h-6 rounded flex items-center justify-center shrink-0 border ${lineCat.badgeClass}`} title={lineCat.label}>
                                      <Icon size={12} />
                                    </div>
                                  );
                                })()}
                                {isEditing ? (
                                  <input
                                    className="ie-desc w-full px-2 py-1 rounded text-sm font-medium text-gray-900 bg-white border border-purple-400 outline-none"
                                    value={it.rawDescription}
                                    onChange={(e) => handleLineDescChange(idx, e.target.value)}
                                    title="Description as printed on the bill"
                                  />
                                ) : (
                                  <div className="font-medium text-gray-900 text-sm">{it.rawDescription}</div>
                                )}
                              </div>

                              {/* Brand Code Mapping Section */}
                              {isMatched ? (
                                <div className="flex items-center gap-1.5 text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 px-2 py-1 rounded-md">
                                  <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                                  <span className="font-semibold">{matchedProd?.name || mappedMapping?.productName || it.productName}</span>
                                  <span className="text-[10px] font-mono text-gray-500">[{code}]{vol ? ` • ${vol}ml` : ''}</span>
                                </div>
                              ) : (
                                <div className="p-2.5 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 rounded-lg space-y-2 text-xs">
                                  <div className="font-semibold text-amber-800 dark:text-amber-200 flex items-center justify-between">
                                    <span>Unknown Brand Code: <code className="font-mono bg-white dark:bg-gray-800 px-1.5 py-0.5 rounded border">{code}</code>{vol ? <span className="ml-1 text-amber-700 font-mono">({vol}ml)</span> : null}</span>
                                  </div>
                                  <div className="flex flex-wrap items-center gap-2">
                                    <input
                                      type="text"
                                      placeholder="Product name (optional)"
                                      className="p-1.5 border rounded text-xs bg-white flex-1 min-w-[130px]"
                                      value={newMappingNames[mapKey] ?? (it.rawDescription + (vol && !it.rawDescription.includes(`${vol}ml`) ? ` ${vol}ml` : ''))}
                                      onChange={(e) => setNewMappingNames((prev) => ({ ...prev, [mapKey]: e.target.value }))}
                                    />
                                    <select
                                      className="p-1.5 border rounded text-xs bg-white font-medium"
                                      value={newMappingCats[mapKey] ?? 'Whisky'}
                                      onChange={(e) => setNewMappingCats((prev) => ({ ...prev, [mapKey]: e.target.value }))}
                                    >
                                      {['Beer', 'Rum', 'Whisky', 'Vodka', 'Brandy', 'Gin', 'Wine', 'Ready to Drink', 'Other'].map((c) => (
                                        <option key={c} value={c}>{c}</option>
                                      ))}
                                    </select>
                                    <button
                                      type="button"
                                      disabled={savingMappingCode === mapKey}
                                      className="px-3 py-1.5 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white rounded font-medium text-xs shadow-sm cursor-pointer"
                                      onClick={() => handleSaveBrandMapping(idx, code, vol)}
                                    >
                                      {savingMappingCode === mapKey ? 'Saving…' : 'Save to Mapping'}
                                    </button>
                                    <button
                                      type="button"
                                      className="text-[11px] text-purple-600 dark:text-purple-400 hover:underline cursor-pointer"
                                      onClick={() => openAddProductModalForLine(idx)}
                                    >
                                      + Advanced
                                    </button>
                                  </div>
                                </div>
                              )}

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

                              {/* Flags without cases_converted */}
                              {(it.flags || []).filter((f) => f.toLowerCase() !== 'cases_converted').length > 0 && (
                                <div className="text-[11px] text-amber-700">
                                  {(it.flags || []).filter((f) => f.toLowerCase() !== 'cases_converted').join(', ')}
                                </div>
                              )}
                            </td>

                            <td className="py-3 px-2 text-right">
                              {isEditing ? (
                                <input
                                  className="ie-qty w-16 p-1.5 border rounded-md text-right font-mono text-sm bg-white"
                                  type="number"
                                  min="1"
                                  value={it.quantity}
                                  onChange={(e) => handleLineQtyChange(idx, e.target.value)}
                                />
                              ) : (
                                <div className="font-mono font-bold text-gray-900 text-sm">
                                  {it.quantity} <span className="text-xs text-gray-500 font-normal">btls</span>
                                </div>
                              )}
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
                              {isEditing ? (
                                <input
                                  className="ie-cost w-24 p-1.5 border rounded-md text-right font-mono text-sm bg-white"
                                  value={it.costPrice}
                                  onChange={(e) => handleLineCostChange(idx, e.target.value)}
                                  title={`Unit cost: ₹${parseFloat(it.costPrice || '0').toFixed(6)}`}
                                />
                              ) : (
                                <div className="font-mono text-sm text-gray-900 font-medium">
                                  ₹{parseFloat(it.costPrice || '0').toFixed(2)}
                                </div>
                              )}
                            </td>

                            <td className="py-3 px-2 text-right">
                              {isEditing ? (
                                <input
                                  className="ie-mrp w-20 p-1.5 border rounded-md text-right font-mono text-sm bg-white"
                                  value={it.mrp}
                                  onChange={(e) => handleLineMrpChange(idx, e.target.value)}
                                />
                              ) : (
                                <div className="font-mono text-sm text-gray-900">
                                  ₹{parseFloat(it.mrp || '0').toFixed(2)}
                                </div>
                              )}
                            </td>

                            <td className="py-3 px-3 text-right font-mono font-semibold text-gray-900">
                              <span className="ie-linetotal">₹{parseFloat(it.lineCostTotal).toFixed(2)}</span>
                            </td>

                            <td className="py-3 px-2 text-center">
                              <button
                                type="button"
                                className={`p-1.5 rounded-lg border cursor-pointer transition-colors ${
                                  isEditing
                                    ? 'bg-emerald-50 text-emerald-700 border-emerald-300 hover:bg-emerald-100'
                                    : 'bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100'
                                }`}
                                onClick={() => setEditingRowIdx(isEditing ? null : idx)}
                                title={isEditing ? 'Save and make read-only' : 'Edit row fields'}
                              >
                                {isEditing ? <Check size={14} /> : <Pencil size={14} />}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Challan totals sit after the products: e-challan / DD, previous credit, sub total, rounding, taxes, balance.
                  Invoices that are not depot challans keep the compact reconciliation bar. */}
              {(activeInvoice.invoice.extractionMeta as { engine?: string } | null | undefined)?.engine === 'icdc-extractor' ? (
                <ChallanTotals
                  figures={activeInvoice.invoice}
                  linesSum={parseFloat(draftLinesCostTotal)}
                  editable={activeInvoice.invoice.status === 'DRAFT' || activeInvoice.invoice.status === 'REVIEWED'}
                  onChange={(field, value) =>
                    setActiveInvoice({ ...activeInvoice, invoice: { ...activeInvoice.invoice, [field]: value } })
                  }
                />
              ) : (() => {
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
                            Diff: ₹{diff.toFixed(2)}
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
                    Save Draft
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  {activeInvoice.invoice.status === 'DRAFT' && (
                    <ProtectedButton
                      id="invReviewBtn"
                      type="button"
                      minRole="manager"
                      loading={isReviewing}
                      disabled={isReviewing || isApproving}
                      className="min-h-[44px] px-4 py-2 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 dark:bg-blue-950/50 dark:hover:bg-blue-900/50 dark:text-blue-300 rounded-lg border border-blue-200 dark:border-blue-800 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 transition-all shadow-sm"
                      onClick={handleReview}
                    >
                      <span>✓</span> {isReviewing ? 'Reviewing…' : 'Mark as Reviewed'}
                    </ProtectedButton>
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
                      className="min-h-[48px] px-6 py-2.5 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg font-bold text-sm shadow-sm flex items-center gap-2 cursor-pointer transition-all"
                      onClick={() => setWizardStep(3)}
                    >
                      Submit Invoice
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
                <PackageOpen size={36} className="mx-auto text-gray-400" aria-hidden="true" />
                <h2 className="text-2xl font-bold text-gray-900 dark:text-slate-100">Confirm Stock Inward</h2>
              </div>

              {/* Big Metrics Cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="p-3.5 bg-blue-50/70 dark:bg-blue-950/40 border border-blue-100 dark:border-blue-900/50 rounded-xl text-center">
                  <div className="text-xs text-blue-600 dark:text-blue-400 font-bold uppercase tracking-wider">Total Quantity</div>
                  <div className="text-2xl font-bold text-blue-900 dark:text-blue-100 mt-1 font-mono">
                    {draftTotalBottles} <span className="text-sm font-normal text-blue-700">btls</span>
                  </div>
                  <div className="text-xs text-blue-600 dark:text-blue-400 font-medium font-mono mt-0.5">
                    {activeInvoice.invoice.totalCases ?? activeInvoice.items.reduce((s, it) => s + (it.casesDelivered || 0), 0)} cases
                  </div>
                </div>

                <div className="p-3.5 bg-emerald-50/70 dark:bg-emerald-950/40 border border-emerald-100 dark:border-emerald-900/50 rounded-xl text-center">
                  <div className="text-xs text-emerald-600 dark:text-emerald-400 font-bold uppercase tracking-wider">Total Amount</div>
                  <div className="text-2xl font-bold text-emerald-900 dark:text-emerald-100 mt-1 font-mono">
                    ₹{invoiceLinesTotal(activeInvoice)}
                  </div>
                </div>

                <div className="p-3.5 bg-purple-50/70 dark:bg-purple-950/40 border border-purple-100 dark:border-purple-900/50 rounded-xl text-center">
                  <div className="text-xs text-purple-600 dark:text-purple-400 font-bold uppercase tracking-wider">Bill Number</div>
                  <div className="text-base font-bold text-purple-900 dark:text-purple-100 mt-2 font-mono truncate" title={activeInvoice.invoice.invoiceNumber}>
                    {activeInvoice.invoice.invoiceNumber}
                  </div>
                </div>

                <div className="p-3.5 bg-amber-50/70 dark:bg-amber-950/40 border border-amber-100 dark:border-amber-900/50 rounded-xl text-center">
                  <div className="text-xs text-amber-600 dark:text-amber-400 font-bold uppercase tracking-wider">Shop &amp; Depot</div>
                  <div className="text-xs font-bold text-amber-900 dark:text-amber-100 mt-1 truncate" title={`Shop: ${(activeInvoice.invoice.extractionMeta?.shopName as string) || activeInvoice.invoice.shopName || shopName}`}>
                    Shop: {(activeInvoice.invoice.extractionMeta?.shopName as string) || activeInvoice.invoice.shopName || shopName}
                  </div>
                  <div className="text-xs text-amber-700 dark:text-amber-300 truncate" title={`Depot: ${activeInvoice.invoice.supplierName || 'Depot'}`}>
                    Depot: {activeInvoice.invoice.supplierName || 'Depot'}
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
                  Edit or Fix Items
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
                        <ProtectedButton
                          type="button"
                          minRole="manager"
                          loading={isReviewing}
                          disabled={isReviewing || isApproving}
                          className="min-h-[48px] px-5 py-2.5 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 dark:bg-blue-950/50 dark:hover:bg-blue-900/50 dark:text-blue-300 rounded-lg border border-blue-200 dark:border-blue-800 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 transition-all shadow-sm"
                          onClick={handleReview}
                        >
                          <span>✓</span> {isReviewing ? 'Reviewing…' : 'Mark as Reviewed'}
                        </ProtectedButton>
                      )}
                      <ProtectedButton
                        id="invApproveBtn"
                        type="button"
                        minRole="manager"
                        loading={isApproving}
                        disabled={isApproving}
                        className="w-full sm:w-auto min-h-[48px] px-8 py-3 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg font-bold text-base shadow-sm flex items-center justify-center gap-2 transition-all cursor-pointer"
                        onClick={handleApprove}
                      >
                        {isApproving ? 'Pouring into Live Stock...' : 'Confirm & Add to Live Stock'}
                      </ProtectedButton>
                  </div>
                )
                ) : (
                  <button
                    type="button"
                    className="w-full sm:w-auto min-h-[48px] px-8 py-3 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-bold text-base shadow-sm flex items-center justify-center gap-2 cursor-pointer"
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
                              : inv.status === 'REVERSED'
                              ? 'bg-gray-200 text-gray-700'
                              : 'bg-amber-100 text-amber-800'
                          }`}
                        >
                          {inv.status === 'APPROVED'
                            ? 'Added to Stock'
                            : inv.status === 'REVIEWED'
                            ? 'Reviewed'
                            : inv.status === 'REJECTED'
                            ? 'Cancelled'
                            : inv.status === 'REVERSED'
                            ? 'Reversed'
                            : 'Draft'}
                        </span>
                      </td>
                      <td className="py-3 px-3 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          {inv.status === 'DRAFT' && (
                            <ProtectedButton
                              type="button"
                              minRole="manager"
                              className="px-2.5 py-1 bg-blue-50 hover:bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:hover:bg-blue-900/50 dark:text-blue-300 border border-blue-200 dark:border-blue-800 rounded font-semibold text-xs cursor-pointer flex items-center gap-1 shadow-xs transition-colors"
                              onClick={() => handleReviewInvoiceById(inv.id, inv.invoiceNumber)}
                              title="Mark bill as reviewed"
                            >
                              <span>✓</span> Review
                            </ProtectedButton>
                          )}
                          <button
                            type="button"
                            className="px-3 py-1 bg-gray-100 hover:bg-gray-200 text-gray-800 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-gray-200 rounded font-semibold text-xs border dark:border-slate-700 cursor-pointer"
                            onClick={() => openInvoice(inv.id)}
                          >
                            Open Bill
                          </button>
                          {inv.status === 'APPROVED' ? (
                            <ProtectedButton
                              type="button"
                              minRole="manager"
                              title="Reverse this invoice: takes the stock back out and posts reversing entries"
                              className="px-2.5 py-1 bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-300 rounded font-semibold text-xs cursor-pointer"
                              onClick={() => { setReverseReason(''); setReverseTarget({ id: inv.id, number: inv.invoiceNumber }); }}
                            >
                              Reverse
                            </ProtectedButton>
                          ) : inv.status === 'REVERSED' ? null : (
                            <ProtectedButton
                              variant="ghost"
                              minRole="manager"
                              title="Delete bill"
                              confirmMessage={`Delete invoice ${inv.invoiceNumber || 'draft'}? This action cannot be undone.`}
                              confirmLabel="Delete"
                              className="p-1 text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/40 rounded transition-colors cursor-pointer"
                              onClick={() => handleDeleteInvoice(inv.id, inv.invoiceNumber)}
                            >
                              <Trash2 size={16} />
                            </ProtectedButton>
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
          {isManager && branchId && (
            <StockSplit branchId={branchId} stockRows={stockRows.map((r) => ({ productId: r.productId, name: r.name, brand: r.brand, volumeMl: r.volumeMl }))} />
          )}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3" id="stockStats">
            {[
              { k: 'all', label: 'All Products', val: stockRows.length, cls: 'text-gray-900 dark:text-gray-100' },
              { k: 'in', label: 'In stock', val: inStockCount, cls: 'text-emerald-600 dark:text-emerald-400' },
              { k: 'low', label: 'Low stock', val: lowCount, cls: 'text-amber-600 dark:text-amber-400' },
              { k: 'out', label: 'Out of stock', val: outCount, cls: 'text-red-600 dark:text-red-400' },
              { k: 'bottles', label: 'Bottles on hand', val: totalBottlesStock.toLocaleString('en-IN'), cls: 'text-gray-700 dark:text-gray-300' },
            ].map((s) => (
              <button
                key={s.k}
                type="button"
                disabled={s.k === 'bottles'}
                onClick={() => setStockFilter(s.k === 'bottles' ? 'all' : (stockFilter === s.k ? 'all' : s.k as any))}
                className={`text-left p-4 bg-white dark:bg-slate-900 rounded-xl border dark:border-slate-800 transition-colors ${
                  stockFilter === s.k ? 'ring-2 ring-purple-500 border-purple-500' : s.k !== 'bottles' ? 'hover:border-gray-400 dark:hover:border-slate-700 cursor-pointer' : ''
                }`}
              >
                <div className="text-xs text-gray-500 dark:text-slate-400">{s.label}</div>
                <div className={`text-2xl font-bold font-display tabular-nums mt-1 ${s.cls}`}>{s.val}</div>
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
                  <option value="all">All Types</option>
                  <option value="beer">Beer</option>
                  <option value="whisky">Whisky</option>
                  <option value="wine">Wine</option>
                  <option value="vodka">Vodka</option>
                  <option value="rum">Rum</option>
                  <option value="gin">Gin</option>
                  <option value="brandy">Brandy</option>
                </select>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <div className="inline-flex rounded-lg border dark:border-slate-700 bg-white dark:bg-slate-900 p-0.5 text-xs">
                  {(['all', 'in', 'low', 'out'] as const).map((f) => (
                    <button
                      key={f}
                      type="button"
                      id={`invStockFilter-${f}`}
                      onClick={() => setStockFilter(f)}
                      className={`px-3 py-1.5 rounded-md cursor-pointer font-medium transition-colors ${
                        stockFilter === f
                          ? 'bg-purple-600 text-white font-semibold shadow-xs'
                          : 'text-gray-600 dark:text-slate-400 hover:text-gray-900 dark:hover:text-slate-100'
                      }`}
                    >
                      {f === 'all' ? 'All' : f === 'in' ? 'In Stock' : f === 'low' ? 'Low Stock' : 'Out of Stock'}
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
                  {showBreakage ? '✕ Hide Breakage' : 'Record Breakage'}
                </button>

                <ProtectedButton
                  variant="danger"
                  minRole="manager"
                  className="px-3 py-1.5 text-xs font-semibold rounded-lg border text-red-600 dark:text-red-400 border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/40 hover:bg-red-100 dark:hover:bg-red-900/60 cursor-pointer flex items-center gap-1 transition-colors"
                  onClick={handleClearCompleteInventory}
                  title="Delete all stock and previous bills to start fresh"
                >
                  <Trash2 size={13} /> Clear Store Stock
                </ProtectedButton>
              </div>
            </div>

            <div className="overflow-x-auto" id="stockTable">
              {loadingStock ? (
                <BeerBottleLoader inline size="sm" title="Loading Store Stock…" subtitle="Fetching live bottle counts, cost prices & reorder levels…" />
              ) : visibleStock.length === 0 ? (
                <div className="p-8 text-center text-gray-500 text-sm space-y-2">
                  <PackageOpen size={32} className="mx-auto text-gray-400" aria-hidden="true" />
                  <div className="font-semibold text-gray-700 dark:text-gray-300">
                    {stockRows.length === 0 ? 'No products in store stock' : 'No products match the selected filters'}
                  </div>
                  <div className="text-xs text-gray-400">
                    {stockRows.length === 0
                      ? 'Upload and confirm a supplier invoice in the "Add Supplier Bill" tab to inward bottles into stock.'
                      : `No items found ${stockFilter !== 'all' ? `with ${stockFilter === 'in' ? 'In Stock' : stockFilter === 'low' ? 'Low Stock' : 'Out of Stock'} status` : ''}${stockCategoryFilter !== 'all' ? ` in ${stockCategoryFilter}` : ''}.`}
                  </div>
                  {stockRows.length === 0 ? (
                    <button
                      type="button"
                      className="mt-2 inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-purple-600 hover:bg-purple-700 rounded-lg cursor-pointer"
                      onClick={() => {
                        setActiveTab('upload');
                        setWizardStep(1);
                      }}
                    >
                      <span>＋</span> Upload Bill Now
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-purple-700 bg-purple-100 hover:bg-purple-200 dark:bg-purple-900/40 dark:text-purple-300 rounded-lg cursor-pointer"
                      onClick={() => {
                        setStockSearch('');
                        setStockCategoryFilter('all');
                        setStockFilter('all');
                      }}
                    >
                      Reset filters
                    </button>
                  )}
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
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex justify-center [&>*]:my-auto p-4 z-50 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full p-6 space-y-4 my-8">
            <div className="flex items-start justify-between border-b pb-3">
              <div>
                <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                  Add Missing Product to Catalog
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
                {productFormError}
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
                  className="w-full mt-1 p-2.5 border rounded-lg text-sm bg-white font-medium focus:ring-2 focus:ring-purple-500 outline-none"
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
                Saving this product will add it to your store catalog and immediately link it to line #{createProductModal.lineIdx + 1} with ₹{parseFloat(createProductModal.mrp || '0').toFixed(2)} MRP.
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
                  className="min-h-[44px] px-6 py-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white rounded-lg font-bold text-xs shadow-sm flex items-center gap-2 cursor-pointer"
                >
                  {savingProduct ? 'Saving to Catalog…' : 'Save to Catalog & Link Line'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Reverse an approved invoice */}
      {reverseTarget && (
        <div className="fixed inset-0 bg-black/50 flex justify-center overflow-y-auto [&>*]:my-auto p-4 z-50" role="dialog" aria-modal="true" aria-labelledby="reverseTitle" id="reverseModal">
          <div className="bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-lg shadow-xl max-w-md w-full p-6">
            <h3 className="text-lg font-bold mb-1" id="reverseTitle">Reverse invoice {reverseTarget.number}</h3>
            <p className="text-xs text-gray-500 mb-3">
              The bottles this invoice added are taken back out of stock (refused if some were already sold), reversing entries are
              posted for the purchase and the e-challan payment, and supplier-scheme credit is removed. Nothing is deleted — the
              original entries stay in the books. The invoice number can be uploaded again.
            </p>
            <label className="block text-sm font-medium mb-4">
              Reason
              <textarea
                className="mt-1 w-full p-2 border rounded bg-white dark:bg-gray-900"
                rows={3}
                value={reverseReason}
                onChange={(e) => setReverseReason(e.target.value)}
                placeholder="e.g. Uploaded against the wrong depot"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" className="px-4 py-2 rounded border bg-gray-100 hover:bg-gray-200" onClick={() => setReverseTarget(null)}>Cancel</button>
              <button
                type="button"
                id="reverseSubmit"
                className="px-4 py-2 rounded bg-amber-600 hover:bg-amber-700 text-white font-medium disabled:opacity-50"
                disabled={reversing || reverseReason.trim().length < 5}
                onClick={handleReverseInvoice}
              >
                {reversing ? 'Reversing…' : 'Reverse invoice'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Modal */}
      {confirmModal && (
        <div id="modal" className="fixed inset-0 bg-black/60 backdrop-blur-sm flex justify-center overflow-y-auto [&>*]:my-auto p-4 z-50">
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
                className="min-h-[44px] px-6 py-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white rounded-lg font-bold text-sm shadow-sm transition-colors cursor-pointer flex items-center gap-2"
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
        totalCost={invoiceLinesTotal(activeInvoice ?? null)}
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

      {/* ── IMMUTABLE INVOICE SNAPSHOT MODAL ────────────────────────────── */}
      {viewSnapshot && (
        <Modal
          title={`Invoice Snapshot: ${viewSnapshot.invoice.invoiceNumber}`}
          onClose={() => setViewSnapshot(null)}
          wide
        >
          <div className="space-y-4">
            {/* Header info */}
            <div className="p-3.5 bg-gray-50 dark:bg-slate-800 rounded-xl border dark:border-slate-700 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div>
                <span className="text-gray-500 dark:text-slate-400 block font-semibold uppercase text-[10px]">Shop Name</span>
                <span className="font-bold text-gray-900 dark:text-slate-100 text-sm">{(viewSnapshot.invoice.extractionMeta?.shopName as string) || viewSnapshot.invoice.shopName || shopName}</span>
              </div>
              <div>
                <span className="text-gray-500 dark:text-slate-400 block font-semibold uppercase text-[10px]">Depot / Supplier</span>
                <span className="font-bold text-gray-900 dark:text-slate-100 text-sm">{viewSnapshot.invoice.supplierName || 'Depot'}</span>
              </div>
              <div>
                <span className="text-gray-500 dark:text-slate-400 block font-semibold uppercase text-[10px]">Invoice Date</span>
                <span className="font-bold text-gray-900 dark:text-slate-100 text-sm">{formatInvoiceDate(viewSnapshot.invoice.invoiceDate)}</span>
              </div>
              <div>
                <span className="text-gray-500 dark:text-slate-400 block font-semibold uppercase text-[10px]">Status</span>
                <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-bold ${
                  viewSnapshot.invoice.status === 'APPROVED'
                    ? 'bg-emerald-100 text-emerald-800'
                    : viewSnapshot.invoice.status === 'REVIEWED'
                    ? 'bg-blue-100 text-blue-800'
                    : 'bg-amber-100 text-amber-800'
                }`}>
                  {viewSnapshot.invoice.status}
                </span>
              </div>
            </div>

            {/* Metrics */}
            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="p-3 bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 rounded-xl">
                <span className="text-[11px] text-blue-600 dark:text-blue-400 font-bold uppercase block">Total Bottles</span>
                <span className="text-xl font-bold font-mono text-blue-900 dark:text-blue-100">
                  {viewSnapshot.items.reduce((s, it) => s + (it.quantity || 0), 0)}
                </span>
              </div>
              <div className="p-3 bg-purple-50 dark:bg-purple-950/40 border border-purple-200 dark:border-purple-800 rounded-xl">
                <span className="text-[11px] text-purple-600 dark:text-purple-400 font-bold uppercase block">Total Cases</span>
                <span className="text-xl font-bold font-mono text-purple-900 dark:text-purple-100">
                  {viewSnapshot.invoice.totalCases ?? viewSnapshot.items.reduce((s, it) => s + (it.casesDelivered || 0), 0)}
                </span>
              </div>
              <div className="p-3 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 rounded-xl">
                <span className="text-[11px] text-emerald-600 dark:text-emerald-400 font-bold uppercase block">Total Amount</span>
                <span className="text-xl font-bold font-mono text-emerald-900 dark:text-emerald-100">
                  ₹{parseFloat(viewSnapshot.invoice.totalAmount || '0').toFixed(2)}
                </span>
              </div>
            </div>

            {/* Read-only items table */}
            <div className="overflow-x-auto max-h-80 border dark:border-slate-800 rounded-xl">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b bg-gray-50 dark:bg-slate-800 text-gray-500 uppercase tracking-wider">
                    <th className="py-2 px-3">#</th>
                    <th className="py-2 px-3">Product / Description</th>
                    <th className="py-2 px-3 text-right">Qty</th>
                    <th className="py-2 px-3 text-right">Case Rate</th>
                    <th className="py-2 px-3 text-right">Unit Cost ₹</th>
                    <th className="py-2 px-3 text-right">MRP ₹</th>
                    <th className="py-2 px-3 text-right">Line Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-slate-800 font-mono">
                  {viewSnapshot.items.map((it, idx) => (
                    <tr key={idx} className="hover:bg-gray-50 dark:hover:bg-slate-800/50">
                      <td className="py-2 px-3 text-gray-400">{idx + 1}</td>
                      <td className="py-2 px-3 font-sans font-medium text-gray-900 dark:text-slate-100">
                        {it.productName || it.rawDescription}
                      </td>
                      <td className="py-2 px-3 text-right font-bold">
                        {it.quantity} btls {it.casesDelivered ? `(${it.casesDelivered} cs)` : ''}
                      </td>
                      <td className="py-2 px-3 text-right text-gray-600">
                        {it.caseRate ? `₹${parseFloat(it.caseRate).toFixed(0)}` : '—'}
                      </td>
                      <td className="py-2 px-3 text-right">₹{parseFloat(it.costPrice || '0').toFixed(2)}</td>
                      <td className="py-2 px-3 text-right">₹{parseFloat(it.mrp || '0').toFixed(2)}</td>
                      <td className="py-2 px-3 text-right font-bold text-gray-900 dark:text-slate-100">
                        ₹{parseFloat(it.lineCostTotal).toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="p-3 bg-emerald-50/60 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 rounded-lg text-xs text-emerald-800 dark:text-emerald-300">
              ✓ <b>Immutable Snapshot:</b> This invoice record is permanently preserved as originally recorded and is unaffected by subsequent sales or stock movements.
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="button"
                className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded-lg font-semibold text-xs border cursor-pointer"
                onClick={() => setViewSnapshot(null)}
              >
                Close Snapshot
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
