import { pgTable, uuid, text, timestamp, boolean, numeric, integer, pgEnum, unique, uniqueIndex, index, date, jsonb, customType, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ─── ENUMS ──────────────────────────────────────────────────────────────────

export const userRoleEnum = pgEnum('user_role', ['owner', 'manager', 'cashier', 'steward']);
export const billStatusEnum = pgEnum('bill_status', ['OPEN', 'PAID', 'VOIDED']);
export const taxTypeEnum = pgEnum('tax_type', ['GST', 'VAT_EXCISE']);
export const stockReasonEnum = pgEnum('stock_reason', ['SALE', 'MANUAL_ADJUST', 'PURCHASE', 'VOID_REVERSAL', 'DAMAGE', 'BREAKAGE', 'COUNTER_SHEET', 'SCHEME_FREE_GOODS']);

// ─── BRANCHES ───────────────────────────────────────────────────────────────

export const syndicates = pgTable('syndicates', {
  id:           uuid('id').primaryKey().defaultRandom(),
  name:         text('name').notNull(),
  gstin:        text('gstin'),
  pan:          text('pan'),
  contactPhone: text('contact_phone'),
  isActive:     boolean('is_active').notNull().default(true),
  createdAt:    timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const branches = pgTable('branches', {
  id:              uuid('id').primaryKey().defaultRandom(),
  syndicateId:     uuid('syndicate_id').references(() => syndicates.id),
  parentBranchId:  uuid('parent_branch_id').references((): AnyPgColumn => branches.id), // For multi-tenancy parent/child stores
  name:            text('name').notNull(),
  code:            text('code').notNull().unique(),   // e.g., "MH1" — used in bill numbers
  address:         text('address'),
  gstin:           text('gstin'),
  exciseLicenseNo: text('excise_license_no'),
  createdAt:       timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ─── USERS ──────────────────────────────────────────────────────────────────

export const users = pgTable('users', {
  id:           uuid('id').primaryKey().defaultRandom(),
  branchId:     uuid('branch_id').references(() => branches.id),   // NULL = owner (all branches)
  syndicateId:  uuid('syndicate_id').references(() => syndicates.id), // owner scoped to one syndicate; NULL + NULL branch = platform owner
  name:         text('name').notNull(),
  email:        text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role:         userRoleEnum('role').notNull(),
  isActive:     boolean('is_active').notNull().default(true),
  createdAt:    timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ─── CATEGORIES ─────────────────────────────────────────────────────────────

export const categories = pgTable('categories', {
  id:      uuid('id').primaryKey().defaultRandom(),
  name:    text('name').notNull().unique(),     // e.g., "Whisky", "Beer"
  taxRate: numeric('tax_rate', { precision: 5, scale: 2 }).notNull(),  // GST %
  taxType: taxTypeEnum('tax_type').notNull().default('GST'),
});

// ─── PRODUCTS ───────────────────────────────────────────────────────────────

export const products = pgTable('products', {
  id:           uuid('id').primaryKey().defaultRandom(),
  categoryId:   uuid('category_id').references(() => categories.id),
  barcode:      text('barcode').unique(),
  sku:          text('sku').unique(),
  name:         text('name').notNull(),
  brand:        text('brand').notNull(),
  volumeMl:     integer('volume_ml'),
  exciseCode:   text('excise_code'), // e.g., 'Q', 'P', 'N'
  packQuantity: integer('pack_quantity'), // e.g., 12, 24, 48 bottles/case
  mrp:          numeric('mrp', { precision: 12, scale: 2 }).notNull(),
  costPrice:    numeric('cost_price', { precision: 12, scale: 2 }),
  isActive:     boolean('is_active').notNull().default(true),
  createdAt:    timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const userPagePermissions = pgTable('user_page_permissions', {
  id:        uuid('id').primaryKey().defaultRandom(),
  userId:    uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  routePath: text('route_path').notNull(), // e.g., 'dashboard', 'tabentry', 'ledger'
  canAccess: boolean('can_access').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqUserRoute: unique('uq_user_route').on(t.userId, t.routePath),
}));

// ─── STOCK ──────────────────────────────────────────────────────────────────

export const stock = pgTable('stock', {
  id:           uuid('id').primaryKey().defaultRandom(),
  branchId:     uuid('branch_id').notNull().references(() => branches.id),
  productId:    uuid('product_id').notNull().references(() => products.id),
  quantity:     integer('quantity').notNull().default(0),
  reorderLevel: integer('reorder_level').default(5),
}, (t) => ({
  uniqueBranchProduct: unique('uq_branch_product').on(t.branchId, t.productId),
}));

// ─── STOCK AUDIT ────────────────────────────────────────────────────────────

export const stockAudit = pgTable('stock_audit', {
  id:          uuid('id').primaryKey().defaultRandom(),
  branchId:    uuid('branch_id').notNull().references(() => branches.id),
  productId:   uuid('product_id').notNull().references(() => products.id),
  userId:      uuid('user_id').references(() => users.id),
  changeQty:   integer('change_qty').notNull(),   // negative for sales
  reason:      stockReasonEnum('reason').notNull(),
  referenceId: uuid('reference_id'),              // bill_id or purchase_id
  createdAt:   timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ─── BILLS ──────────────────────────────────────────────────────────────────

export const bills = pgTable('bills', {
  id:          uuid('id').primaryKey().defaultRandom(),
  branchId:    uuid('branch_id').notNull().references(() => branches.id),
  cashierId:   uuid('cashier_id').notNull().references(() => users.id),
  billNumber:  text('bill_number').notNull().unique(),
  status:      billStatusEnum('status').notNull().default('OPEN'),
  subtotal:    numeric('subtotal', { precision: 12, scale: 2 }).notNull(),
  taxAmount:   numeric('tax_amount', { precision: 12, scale: 2 }).notNull(),
  discount:    numeric('discount', { precision: 12, scale: 2 }).notNull().default('0'),
  total:       numeric('total', { precision: 12, scale: 2 }).notNull(),
  paymentMode: text('payment_mode'),   // 'CASH' | 'CARD' | 'UPI' | 'CREDIT'
  customerId:     uuid('customer_id').references((): AnyPgColumn => customers.id),           // set for CREDIT (khata) sales
  shiftSessionId: uuid('shift_session_id').references((): AnyPgColumn => shiftSessions.id),  // cashier shift the bill was rung in
  clientRef:      text('client_ref').unique(),   // idempotency key for offline-queued bills
  paidAt:      timestamp('paid_at', { withTimezone: true }),
  voidedAt:    timestamp('voided_at', { withTimezone: true }),
  voidReason:  text('void_reason'),
  createdAt:   timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// Per-branch, per-year bill sequence. Incremented atomically with UPDATE … RETURNING.
export const billCounters = pgTable('bill_counters', {
  branchId: uuid('branch_id').notNull().references(() => branches.id),
  year:     integer('year').notNull(),
  lastSeq:  integer('last_seq').notNull().default(0),
}, (t) => ({
  uqBranchYear: unique('uq_bill_counter_branch_year').on(t.branchId, t.year),
}));

// ─── BILL ITEMS ──────────────────────────────────────────────────────────────

export const billItems = pgTable('bill_items', {
  id:        uuid('id').primaryKey().defaultRandom(),
  billId:    uuid('bill_id').notNull().references(() => bills.id, { onDelete: 'cascade' }),
  productId: uuid('product_id').notNull().references(() => products.id),
  quantity:  integer('quantity').notNull(),
  unitPrice: numeric('unit_price', { precision: 12, scale: 2 }).notNull(),  // MRP at sale time
  taxRate:   numeric('tax_rate', { precision: 5, scale: 2 }).notNull(),
  taxType:   taxTypeEnum('tax_type').notNull().default('GST'),
  taxAmount: numeric('tax_amount', { precision: 12, scale: 2 }).notNull(),
  lineTotal: numeric('line_total', { precision: 12, scale: 2 }).notNull(),
});

// ─── PRICE AUDIT ────────────────────────────────────────────────────────────

export const priceAudit = pgTable('price_audit', {
  id:        uuid('id').primaryKey().defaultRandom(),
  productId: uuid('product_id').notNull().references(() => products.id),
  userId:    uuid('user_id').notNull().references(() => users.id),
  oldMrp:    numeric('old_mrp', { precision: 12, scale: 2 }),
  newMrp:    numeric('new_mrp', { precision: 12, scale: 2 }).notNull(),
  changedAt: timestamp('changed_at', { withTimezone: true }).defaultNow(),
});

// ─── DAILY CLOSING ──────────────────────────────────────────────────────────

export const closingStatusEnum = pgEnum('closing_status', ['OPEN', 'CLOSED']);

export const dailyClosings = pgTable('daily_closings', {
  id:                   uuid('id').primaryKey().defaultRandom(),
  branchId:             uuid('branch_id').notNull().references(() => branches.id),
  closedById:           uuid('closed_by_id').notNull().references(() => users.id),
  closingDate:          timestamp('closing_date', { withTimezone: true }).defaultNow(),
  openingCash:          numeric('opening_cash', { precision: 12, scale: 2 }).notNull(),
  cashSales:            numeric('cash_sales', { precision: 12, scale: 2 }).notNull(),
  cardSales:            numeric('card_sales', { precision: 12, scale: 2 }).notNull(),
  upiSales:             numeric('upi_sales', { precision: 12, scale: 2 }).notNull(),
  creditSales:          numeric('credit_sales', { precision: 12, scale: 2 }).notNull().default('0'),
  grossSales:           numeric('gross_sales', { precision: 12, scale: 2 }).notNull(),
  totalTax:             numeric('total_tax', { precision: 12, scale: 2 }).notNull(),
  cashWithdrawals:      numeric('cash_withdrawals', { precision: 12, scale: 2 }).notNull().default('0'),
  expectedCashInDrawer: numeric('expected_cash_in_drawer', { precision: 12, scale: 2 }).notNull(),
  actualCashCounted:    numeric('actual_cash_counted', { precision: 12, scale: 2 }).notNull(),
  cashDiscrepancy:      numeric('cash_discrepancy', { precision: 12, scale: 2 }).notNull(),
  isBalanced:           boolean('is_balanced').notNull(),
  totalBillsCount:      integer('total_bills_count').notNull(),
  paidBillsCount:       integer('paid_bills_count').notNull(),
  voidedBillsCount:     integer('voided_bills_count').notNull(),
  notes:                text('notes'),
  status:               closingStatusEnum('status').notNull().default('CLOSED'),
  createdAt:            timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ─── SUPPLIER INVOICES (PURCHASE ENTRY) ──────────────────────────────────────

export const invoiceStatusEnum = pgEnum('invoice_status', ['DRAFT', 'REVIEWED', 'APPROVED', 'REJECTED']);

export const supplierInvoices = pgTable('supplier_invoices', {
  id:            uuid('id').primaryKey().defaultRandom(),
  branchId:      uuid('branch_id').notNull().references(() => branches.id),
  createdById:   uuid('created_by_id').notNull().references(() => users.id),
  approvedById:  uuid('approved_by_id').references(() => users.id),
  supplierName:  text('supplier_name').notNull(),
  invoiceNumber: text('invoice_number').notNull(),
  invoiceDate:   timestamp('invoice_date', { withTimezone: true }),
  totalAmount:   numeric('total_amount', { precision: 12, scale: 2 }).notNull(),
  status:        invoiceStatusEnum('status').notNull().default('DRAFT'),
  notes:         text('notes'),
  createdAt:     timestamp('created_at', { withTimezone: true }).defaultNow(),
  approvedAt:    timestamp('approved_at', { withTimezone: true }),
  // Upload / review workflow (migration 0002)
  source:             text('source').notNull().default('MANUAL'),   // 'MANUAL' | 'CSV' | 'EXCEL' | 'PDF' | 'IMAGE'
  originalFilename:   text('original_filename'),
  reviewedById:       uuid('reviewed_by_id').references(() => users.id),
  reviewedAt:         timestamp('reviewed_at', { withTimezone: true }),
  rejectedById:       uuid('rejected_by_id').references(() => users.id),
  rejectedAt:         timestamp('rejected_at', { withTimezone: true }),
  rejectionReason:    text('rejection_reason'),
  extractionWarnings: jsonb('extraction_warnings').$type<string[]>(),
  extractionMeta:     jsonb('extraction_meta').$type<Record<string, unknown>>(),
}, (t) => ({
  // A live (non-rejected) invoice number is unique per branch+supplier; a rejected one may be re-submitted.
  uqLiveSupplierInvoice: uniqueIndex('uq_supplier_invoice_live_number')
    .on(t.branchId, t.supplierName, t.invoiceNumber)
    .where(sql`status <> 'REJECTED'`),
}));

export const supplierInvoiceItems = pgTable('supplier_invoice_items', {
  id:             uuid('id').primaryKey().defaultRandom(),
  invoiceId:      uuid('invoice_id').notNull().references(() => supplierInvoices.id, { onDelete: 'cascade' }),
  productId:      uuid('product_id').references(() => products.id), // null if new/unmatched
  rawDescription: text('raw_description').notNull(),
  quantity:       integer('quantity').notNull(),
  costPrice:      numeric('cost_price', { precision: 12, scale: 2 }).notNull(),
  mrp:            numeric('mrp', { precision: 12, scale: 2 }).notNull(),
  taxRate:        numeric('tax_rate', { precision: 5, scale: 2 }).notNull().default('18.00'),
  lineCostTotal:  numeric('line_cost_total', { precision: 12, scale: 2 }).notNull(),
  // Extraction / matching metadata (migration 0002)
  lineNumber:      integer('line_number'),
  barcode:         text('barcode'),
  matchStatus:     text('match_status'),    // 'MATCHED' | 'SUGGESTED' | 'UNMATCHED' | 'MANUAL'
  matchMethod:     text('match_method'),    // 'BARCODE' | 'SKU' | 'NAME' | 'MANUAL'
  matchConfidence: numeric('match_confidence', { precision: 4, scale: 3 }),
  extractedAmount: numeric('extracted_amount', { precision: 12, scale: 2 }),
  flags:           jsonb('flags').$type<string[]>(),
});

/** bytea column: Buffer in TS; accepts Buffer/Uint8Array (both drivers) or '\x…' hex text on read. */
const bytea = customType<{ data: Buffer; driverData: Buffer | Uint8Array | string }>({
  dataType() { return 'bytea'; },
  toDriver(value) { return value; },
  fromDriver(value) {
    if (typeof value === 'string') return Buffer.from(value.startsWith('\\x') ? value.slice(2) : value, 'hex');
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  },
});

// Original uploaded invoice file (kept for audit / re-download).
export const invoiceAttachments = pgTable('invoice_attachments', {
  id:        uuid('id').primaryKey().defaultRandom(),
  invoiceId: uuid('invoice_id').notNull().references(() => supplierInvoices.id, { onDelete: 'cascade' }),
  filename:  text('filename').notNull(),
  mimeType:  text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  sha256:    text('sha256').notNull(),
  data:      bytea('data').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  idxSha: index('idx_invoice_attachments_sha256').on(t.sha256),
  idxInvoice: index('idx_invoice_attachments_invoice').on(t.invoiceId),
}));

// ─── PHASE 3: TABLE MANAGEMENT ───────────────────────────────────────────────

export const tableStatusEnum = pgEnum('table_status', ['FREE', 'OCCUPIED', 'RESERVED']);

export const tables = pgTable('tables', {
  id:        uuid('id').primaryKey().defaultRandom(),
  branchId:  uuid('branch_id').notNull().references(() => branches.id),
  name:      text('name').notNull(),           // e.g., "T-1", "Bar Seat 3"
  capacity:  integer('capacity').notNull().default(4),
  status:    tableStatusEnum('status').notNull().default('FREE'),
  section:   text('section'),                  // e.g., "Indoor", "Outdoor", "Bar"
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const tableSessions = pgTable('table_sessions', {
  id:         uuid('id').primaryKey().defaultRandom(),
  tableId:    uuid('table_id').notNull().references(() => tables.id),
  branchId:   uuid('branch_id').notNull().references(() => branches.id),
  stewardId:  uuid('steward_id').references(() => users.id),
  billId:     uuid('bill_id').references(() => bills.id),  // set on final checkout
  openedAt:   timestamp('opened_at', { withTimezone: true }).defaultNow(),
  closedAt:   timestamp('closed_at', { withTimezone: true }),
  guestCount: integer('guest_count'),
  notes:      text('notes'),
});

// ─── PHASE 3: KOT (KITCHEN ORDER TICKET) ─────────────────────────────────────

export const kotStatusEnum    = pgEnum('kot_status',      ['PENDING', 'PREPARING', 'SERVED', 'CANCELLED']);
export const kotItemStatusEnum = pgEnum('kot_item_status', ['PENDING', 'PREPARING', 'SERVED', 'CANCELLED']);
export const kotDestEnum      = pgEnum('kot_destination',  ['KITCHEN', 'BAR']);

export const kotOrders = pgTable('kot_orders', {
  id:             uuid('id').primaryKey().defaultRandom(),
  tableSessionId: uuid('table_session_id').notNull().references(() => tableSessions.id),
  branchId:       uuid('branch_id').notNull().references(() => branches.id),
  createdById:    uuid('created_by_id').notNull().references(() => users.id),
  destination:    kotDestEnum('destination').notNull().default('KITCHEN'),
  status:         kotStatusEnum('status').notNull().default('PENDING'),
  notes:          text('notes'),
  createdAt:      timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt:      timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export const kotItems = pgTable('kot_items', {
  id:          uuid('id').primaryKey().defaultRandom(),
  kotOrderId:  uuid('kot_order_id').notNull().references(() => kotOrders.id, { onDelete: 'cascade' }),
  productId:   uuid('product_id').notNull().references(() => products.id),
  quantity:    integer('quantity').notNull(),
  unitPrice:   numeric('unit_price', { precision: 12, scale: 2 }).notNull(),   // MRP at order time
  taxRate:     numeric('tax_rate', { precision: 5, scale: 2 }).notNull(),
  status:      kotItemStatusEnum('status').notNull().default('PENDING'),
  notes:       text('notes'),                                                   // e.g., "No ice"
});

// ─── PHASE 3: SUPPLIER SCHEME TRACKING ───────────────────────────────────────

export const schemeTargetTypeEnum = pgEnum('scheme_target_type', ['QTY', 'VALUE']);
export const schemeStatusEnum     = pgEnum('scheme_status',      ['ACTIVE', 'COMPLETED', 'EXPIRED', 'CANCELLED']);

export const schemes = pgTable('schemes', {
  id:                 uuid('id').primaryKey().defaultRandom(),
  branchId:           uuid('branch_id').notNull().references(() => branches.id),
  supplierName:       text('supplier_name').notNull(),
  schemeName:         text('scheme_name').notNull(),
  targetType:         schemeTargetTypeEnum('target_type').notNull(),
  targetValue:        numeric('target_value', { precision: 12, scale: 2 }).notNull(),
  currentValue:       numeric('current_value', { precision: 12, scale: 2 }).notNull().default('0'),
  rewardDescription:  text('reward_description').notNull(),
  startDate:          timestamp('start_date', { withTimezone: true }).notNull(),
  endDate:            timestamp('end_date', { withTimezone: true }).notNull(),
  alertThresholdPct:  numeric('alert_threshold_pct', { precision: 5, scale: 2 }).notNull().default('80.00'),
  status:             schemeStatusEnum('status').notNull().default('ACTIVE'),
  notes:              text('notes'),
  createdAt:          timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const schemePurchases = pgTable('scheme_purchases', {
  id:          uuid('id').primaryKey().defaultRandom(),
  schemeId:    uuid('scheme_id').notNull().references(() => schemes.id),
  referenceId: uuid('reference_id'),   // supplier_invoice_id
  qty:         numeric('qty',   { precision: 12, scale: 2 }).notNull().default('0'),
  value:       numeric('value', { precision: 12, scale: 2 }).notNull().default('0'),
  recordedAt:  timestamp('recorded_at', { withTimezone: true }).defaultNow(),
  notes:       text('notes'),
});

// ─── PHASE 1: CONSOLIDATED (SYNDICATE) INVOICES ────────────────────────────────

export const consolidatedInvoices = pgTable('consolidated_invoices', {
  id:          uuid('id').primaryKey().defaultRandom(),
  syndicateId: uuid('syndicate_id').notNull().references(() => syndicates.id),
  periodStart: date('period_start').notNull(),
  periodEnd:   date('period_end').notNull(),
  grossSales:  numeric('gross_sales', { precision: 14, scale: 2 }).notNull(),
  totalTax:    numeric('total_tax',   { precision: 14, scale: 2 }).notNull(),
  billCount:   integer('bill_count').notNull(),
  breakdown:   jsonb('breakdown').notNull(),   // per-branch totals
  createdById: uuid('created_by_id').notNull().references(() => users.id),
  createdAt:   timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ─── PHASE 2: TERMINALS, SHIFTS & DAILY COUNTER SHEETS ─────────────────────────

export const terminals = pgTable('terminals', {
  id:           uuid('id').primaryKey().defaultRandom(),
  branchId:     uuid('branch_id').notNull().references(() => branches.id),
  terminalName: text('terminal_name').notNull(),
  deviceKey:    text('device_key').notNull().unique(),   // identifier the POS device presents (header X-Terminal-Key)
  isActive:     boolean('is_active').notNull().default(true),
  createdAt:    timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqBranchTerminalName: unique('uq_branch_terminal_name').on(t.branchId, t.terminalName),
}));

export const shiftStatusEnum = pgEnum('shift_status', ['OPEN', 'CLOSED']);

export const shiftSessions = pgTable('shift_sessions', {
  id:              uuid('id').primaryKey().defaultRandom(),
  branchId:        uuid('branch_id').notNull().references(() => branches.id),
  terminalId:      uuid('terminal_id').notNull().references(() => terminals.id),
  cashierId:       uuid('cashier_id').notNull().references(() => users.id),
  status:          shiftStatusEnum('status').notNull().default('OPEN'),
  openedAt:        timestamp('opened_at', { withTimezone: true }).defaultNow(),
  closedAt:        timestamp('closed_at', { withTimezone: true }),
  openingFloat:    numeric('opening_float',    { precision: 12, scale: 2 }).notNull().default('0'),
  expectedCash:    numeric('expected_cash',    { precision: 12, scale: 2 }),   // float + cash sales, computed at close
  countedCash:     numeric('counted_cash',     { precision: 12, scale: 2 }),   // from denominations
  cashCollected:   numeric('cash_collected',   { precision: 12, scale: 2 }).notNull().default('0'),
  upiCollected:    numeric('upi_collected',    { precision: 12, scale: 2 }).notNull().default('0'),
  cardCollected:   numeric('card_collected',   { precision: 12, scale: 2 }).notNull().default('0'),
  creditCollected: numeric('credit_collected', { precision: 12, scale: 2 }).notNull().default('0'),
  denominations:   jsonb('denominations'),     // { "500": 10, "200": 5, ..., "coins": "12.00" }
  discrepancy:     numeric('discrepancy', { precision: 12, scale: 2 }),       // counted - expected (negative = shortage)
  notes:           text('notes'),
}, (t) => ({
  // DB backstop for the app-level rule: one OPEN shift per cashier and per terminal
  uqOpenShiftCashier:  uniqueIndex('uq_open_shift_cashier').on(t.cashierId).where(sql`status = 'OPEN'`),
  uqOpenShiftTerminal: uniqueIndex('uq_open_shift_terminal').on(t.terminalId).where(sql`status = 'OPEN'`),
}));

export const counterSheetStatusEnum = pgEnum('counter_sheet_status', ['DRAFT', 'POSTED']);

export const dailyCounterSheets = pgTable('daily_counter_sheets', {
  id:           uuid('id').primaryKey().defaultRandom(),
  branchId:     uuid('branch_id').notNull().references(() => branches.id),
  sheetDate:    date('sheet_date').notNull(),
  status:       counterSheetStatusEnum('status').notNull().default('DRAFT'),
  totalRevenue: numeric('total_revenue', { precision: 14, scale: 2 }).notNull().default('0'),
  createdById:  uuid('created_by_id').notNull().references(() => users.id),
  postedById:   uuid('posted_by_id').references(() => users.id),
  postedAt:     timestamp('posted_at', { withTimezone: true }),
  createdAt:    timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqBranchDate: unique('uq_counter_sheet_branch_date').on(t.branchId, t.sheetDate),
}));

export const dailyCounterSheetLines = pgTable('daily_counter_sheet_lines', {
  id:             uuid('id').primaryKey().defaultRandom(),
  sheetId:        uuid('sheet_id').notNull().references(() => dailyCounterSheets.id, { onDelete: 'cascade' }),
  productId:      uuid('product_id').notNull().references(() => products.id),
  openingBottles: integer('opening_bottles').notNull(),
  inwardBottles:  integer('inward_bottles').notNull().default(0),
  closingBottles: integer('closing_bottles').notNull(),
  soldBottles:    integer('sold_bottles').notNull(),
  sellingRate:    numeric('selling_rate',  { precision: 12, scale: 2 }).notNull(),
  lineRevenue:    numeric('line_revenue',  { precision: 14, scale: 2 }).notNull(),
  adjustmentApprovedById: uuid('adjustment_approved_by_id').references(() => users.id), // manager override when closing > opening+inward
}, (t) => ({
  uqSheetProduct: unique('uq_counter_sheet_line_product').on(t.sheetId, t.productId),
}));

// ─── PHASE 3: CUSTOMER KHATA (CREDIT) ──────────────────────────────────────────

export const customers = pgTable('customers', {
  id:            uuid('id').primaryKey().defaultRandom(),
  branchId:      uuid('branch_id').notNull().references(() => branches.id),
  name:          text('name').notNull(),
  phone:         text('phone').notNull(),
  creditAllowed: boolean('credit_allowed').notNull().default(false),
  creditLimit:   numeric('credit_limit',   { precision: 12, scale: 2 }).notNull().default('0'),
  currentCredit: numeric('current_credit', { precision: 12, scale: 2 }).notNull().default('0'),  // outstanding balance owed
  isActive:      boolean('is_active').notNull().default(true),
  createdAt:     timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqBranchPhone: unique('uq_customer_branch_phone').on(t.branchId, t.phone),
}));

export const creditTxnTypeEnum = pgEnum('credit_txn_type', ['PURCHASE', 'REPAYMENT', 'ADJUSTMENT']);

export const creditTransactions = pgTable('credit_transactions', {
  id:           uuid('id').primaryKey().defaultRandom(),
  customerId:   uuid('customer_id').notNull().references(() => customers.id),
  type:         creditTxnTypeEnum('type').notNull(),
  amount:       numeric('amount',        { precision: 12, scale: 2 }).notNull(),  // always positive
  balanceAfter: numeric('balance_after', { precision: 12, scale: 2 }).notNull(),
  billId:       uuid('bill_id').references(() => bills.id),
  paymentMode:  text('payment_mode'),   // for REPAYMENT: CASH | CARD | UPI
  recordedById: uuid('recorded_by_id').notNull().references(() => users.id),
  clientRef:    text('client_ref').unique(),   // idempotency key for repayments (double-submit safe)
  notes:        text('notes'),
  recordedAt:   timestamp('recorded_at', { withTimezone: true }).defaultNow(),
});

// ─── PHASE 3: SCHEME SLABS ──────────────────────────────────────────────────────

export const schemeSlabs = pgTable('scheme_slabs', {
  id:              uuid('id').primaryKey().defaultRandom(),
  schemeId:        uuid('scheme_id').notNull().references(() => schemes.id, { onDelete: 'cascade' }),
  minCases:        integer('min_cases').notNull(),
  freeBottles:     integer('free_bottles').notNull().default(0),
  discountPerCase: numeric('discount_per_case', { precision: 12, scale: 2 }).notNull().default('0'),
}, (t) => ({
  uqSchemeMinCases: unique('uq_scheme_slab_min_cases').on(t.schemeId, t.minCases),
}));

// ─── PHASE 3: EXCISE QUOTA / STOCK LIFTING & BREAKAGE ──────────────────────────

export const exciseQuotas = pgTable('excise_quotas', {
  id:            uuid('id').primaryKey().defaultRandom(),
  branchId:      uuid('branch_id').notNull().references(() => branches.id),
  categoryId:    uuid('category_id').references(() => categories.id),   // NULL = applies to all categories
  periodStart:   date('period_start').notNull(),
  periodEnd:     date('period_end').notNull(),
  quotaCases:    integer('quota_cases').notNull(),
  notes:         text('notes'),
  createdAt:     timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const breakageLogs = pgTable('breakage_logs', {
  id:           uuid('id').primaryKey().defaultRandom(),
  branchId:     uuid('branch_id').notNull().references(() => branches.id),
  productId:    uuid('product_id').notNull().references(() => products.id),
  quantity:     integer('quantity').notNull(),   // bottles, positive
  reason:       text('reason').notNull(),
  costValue:    numeric('cost_value', { precision: 12, scale: 2 }).notNull().default('0'),
  recordedById: uuid('recorded_by_id').notNull().references(() => users.id),
  createdAt:    timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ─── PHASE 4: DOUBLE-ENTRY ACCOUNTING ───────────────────────────────────────────

export const ledgerGroupEnum   = pgEnum('ledger_group', ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE']);
export const voucherTypeEnum   = pgEnum('voucher_type', ['SALES', 'PURCHASE', 'PAYMENT', 'RECEIPT', 'JOURNAL', 'CONTRA']);

export const accountLedgers = pgTable('account_ledgers', {
  id:             uuid('id').primaryKey().defaultRandom(),
  branchId:       uuid('branch_id').notNull().references(() => branches.id),
  code:           text('code').notNull(),   // stable system key, e.g. 'CASH', 'SALES', 'OUTPUT_GST'
  name:           text('name').notNull(),
  group:          ledgerGroupEnum('group').notNull(),
  isSystem:       boolean('is_system').notNull().default(false),
  openingBalance: numeric('opening_balance', { precision: 14, scale: 2 }).notNull().default('0'),  // signed: + debit, - credit
  createdAt:      timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqBranchCode: unique('uq_ledger_branch_code').on(t.branchId, t.code),
}));

export const journalVouchers = pgTable('journal_vouchers', {
  id:            uuid('id').primaryKey().defaultRandom(),
  branchId:      uuid('branch_id').notNull().references(() => branches.id),
  voucherNumber: text('voucher_number').notNull().unique(),
  voucherDate:   date('voucher_date').notNull(),
  voucherType:   voucherTypeEnum('voucher_type').notNull(),
  narration:     text('narration').notNull(),
  sourceType:    text('source_type'),   // 'BILL' | 'BILL_VOID' | 'SUPPLIER_INVOICE' | 'EXPENSE' | 'CREDIT_REPAYMENT' | 'MANUAL'
  sourceId:      uuid('source_id'),
  createdById:   uuid('created_by_id').references(() => users.id),
  createdAt:     timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqSource: unique('uq_voucher_source').on(t.sourceType, t.sourceId),   // posting the same source twice is rejected
}));

export const journalLines = pgTable('journal_lines', {
  id:        uuid('id').primaryKey().defaultRandom(),
  voucherId: uuid('voucher_id').notNull().references(() => journalVouchers.id, { onDelete: 'cascade' }),
  ledgerId:  uuid('ledger_id').notNull().references(() => accountLedgers.id),
  debit:     numeric('debit',  { precision: 14, scale: 2 }).notNull().default('0'),
  credit:    numeric('credit', { precision: 14, scale: 2 }).notNull().default('0'),
});

export const expenses = pgTable('expenses', {
  id:           uuid('id').primaryKey().defaultRandom(),
  branchId:     uuid('branch_id').notNull().references(() => branches.id),
  category:     text('category').notNull(),   // e.g. 'Rent', 'Electricity', 'Salaries'
  amount:       numeric('amount', { precision: 12, scale: 2 }).notNull(),
  paymentMode:  text('payment_mode').notNull(),   // CASH | CARD | UPI | BANK
  expenseDate:  date('expense_date').notNull(),
  notes:        text('notes'),
  recordedById: uuid('recorded_by_id').notNull().references(() => users.id),
  createdAt:    timestamp('created_at', { withTimezone: true }).defaultNow(),
});

