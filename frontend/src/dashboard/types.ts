export type Severity = 'bad' | 'warn' | 'good';
export type PayMode = 'CASH' | 'UPI' | 'CARD' | 'CREDIT';

export interface AttentionItem { id: string; severity: Severity; title: string; detail: string; route: string; branchId?: string; branchName?: string }
export interface MixRow { mode: PayMode; total: string; share: number }
export interface LowStockRow { name: string; quantity: number; reorderLevel: number | null }

export interface MyShift {
  id: string; terminalName: string; openedAt: string; openingFloat: string; sales: string; bills: number; expectedCash: string; mix: MixRow[];
}

export interface CashierData {
  role: 'cashier';
  businessDate: string;
  generatedAt: string;
  myShift: MyShift | null;
  myRecentBills: Array<{ id: string; billNumber: string; createdAt: string; status: string; total: string; paymentMode: string | null }>;
  attention: AttentionItem[];
  lowStock: LowStockRow[];
  lowStockCount: number;
}

export interface ManagerData {
  role: 'manager' | 'owner';
  businessDate: string;
  generatedAt: string;
  currentHour: number;
  today: {
    sales: string; bills: number; averageBill: string; gst: string; hourly: number[]; mix: MixRow[];
    vsYesterday: { sameTimeSales: string; percent: number | null };
  };
  yesterday: { sales: string; hourly: number[] };
  tables: { occupied: number; total: number; oldestOpenMinutes: number | null };
  myShift: MyShift | null;
  attention: AttentionItem[];
  closing: { closedToday: boolean; steps: Array<{ id: string; label: string; done: boolean; route: string }> };
  topSellers: Array<{ name: string; units: number; sales: string }>;
  lowStock: LowStockRow[];
  lowStockCount: number;
}

export interface OwnerData {
  businessDate: string;
  generatedAt: string;
  branches: Array<{
    id: string; name: string; code: string; sales: string; bills: number; salesSameTimeYesterday: string; percent: number | null;
    lowStock: number; bankToReview: number;
  }>;
  totals: {
    sales: string;
    salesSameTimeYesterday: string;
    percent: number | null;
    bills: number;
    sheetRevenue?: string;
    totalBottlesSold?: number;
    physicalStockPresent?: number;
  };
  month: {
    sales: string;
    sameDaysLastMonth: string;
    lastMonthTotal: string;
    percent: number | null;
    percentOfLastMonth: number | null;
    history?: Array<{ month: string; label: string; sales: string }>;
  };
  khata: { owed: string; over30: string; customers: number; buckets: Array<{ key: string; label: string; amount: string }> };
  bank: { outlets: number; reconciled: number };
  attention: AttentionItem[];
}
