import { pgTable, uuid, text, timestamp, boolean, numeric, integer, pgEnum, unique } from 'drizzle-orm/pg-core';

// ─── ENUMS ──────────────────────────────────────────────────────────────────

export const userRoleEnum = pgEnum('user_role', ['owner', 'manager', 'cashier', 'steward']);
export const billStatusEnum = pgEnum('bill_status', ['OPEN', 'PAID', 'VOIDED']);
export const stockReasonEnum = pgEnum('stock_reason', ['SALE', 'MANUAL_ADJUST', 'PURCHASE', 'VOID_REVERSAL', 'DAMAGE']);

// ─── BRANCHES ───────────────────────────────────────────────────────────────

export const branches = pgTable('branches', {
  id:        uuid('id').primaryKey().defaultRandom(),
  name:      text('name').notNull(),
  code:      text('code').notNull().unique(),   // e.g., "MH1" — used in bill numbers
  address:   text('address'),
  gstin:     text('gstin'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ─── USERS ──────────────────────────────────────────────────────────────────

export const users = pgTable('users', {
  id:           uuid('id').primaryKey().defaultRandom(),
  branchId:     uuid('branch_id').references(() => branches.id),   // NULL = owner (all branches)
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
});

// ─── PRODUCTS ───────────────────────────────────────────────────────────────

export const products = pgTable('products', {
  id:         uuid('id').primaryKey().defaultRandom(),
  categoryId: uuid('category_id').references(() => categories.id),
  barcode:    text('barcode').unique(),
  sku:        text('sku').unique(),
  name:       text('name').notNull(),
  brand:      text('brand').notNull(),
  volumeMl:   integer('volume_ml'),
  mrp:        numeric('mrp', { precision: 12, scale: 2 }).notNull(),
  costPrice:  numeric('cost_price', { precision: 12, scale: 2 }),
  isActive:   boolean('is_active').notNull().default(true),
  createdAt:  timestamp('created_at', { withTimezone: true }).defaultNow(),
});

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
  paymentMode: text('payment_mode'),   // 'CASH' | 'CARD' | 'UPI'
  paidAt:      timestamp('paid_at', { withTimezone: true }),
  voidedAt:    timestamp('voided_at', { withTimezone: true }),
  voidReason:  text('void_reason'),
  createdAt:   timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ─── BILL ITEMS ──────────────────────────────────────────────────────────────

export const billItems = pgTable('bill_items', {
  id:        uuid('id').primaryKey().defaultRandom(),
  billId:    uuid('bill_id').notNull().references(() => bills.id, { onDelete: 'cascade' }),
  productId: uuid('product_id').notNull().references(() => products.id),
  quantity:  integer('quantity').notNull(),
  unitPrice: numeric('unit_price', { precision: 12, scale: 2 }).notNull(),  // MRP at sale time
  taxRate:   numeric('tax_rate', { precision: 5, scale: 2 }).notNull(),
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
});

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
});

