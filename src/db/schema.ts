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
