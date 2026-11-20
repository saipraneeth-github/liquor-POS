import { check, foreignKey, pgTable, uuid, text, timestamp, boolean, numeric, integer, pgEnum, unique, uniqueIndex, index, primaryKey, date, jsonb, customType, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ─── ENUMS ──────────────────────────────────────────────────────────────────

export const userRoleEnum = pgEnum('user_role', ['owner', 'manager', 'office_admin', 'cashier', 'steward']);
export const billStatusEnum = pgEnum('bill_status', ['OPEN', 'PAID', 'VOIDED']);
export const taxTypeEnum = pgEnum('tax_type', ['GST', 'VAT_EXCISE']);
export const menuTypeEnum = pgEnum('menu_type', ['RETAIL', 'KITCHEN', 'BAR']);
export const stockReasonEnum = pgEnum('stock_reason', ['SALE', 'MANUAL_ADJUST', 'PURCHASE', 'VOID_REVERSAL', 'DAMAGE', 'BREAKAGE', 'COUNTER_SHEET', 'SCHEME_FREE_GOODS', 'TYPE_TRANSFER', 'TRANSFER_OUT', 'TRANSFER_IN', 'SALES_RETURN', 'PURCHASE_RETURN']);

// ─── BRANCHES ───────────────────────────────────────────────────────────────

export const syndicates = pgTable('syndicates', {
  id:           uuid('id').primaryKey().defaultRandom(),
  name:         text('name').notNull(),
  gstin:        text('gstin'),
  pan:          text('pan'),
  contactPhone: text('contact_phone'),
  plan:         text('plan').notNull().default('TRIAL'),            // SaaS plan: TRIAL | STANDARD | PRO
  maxBranches:  integer('max_branches').notNull().default(3),       // plan limit enforced on branch creation
  trialEndsAt:  timestamp('trial_ends_at', { withTimezone: true }), // TRIAL plan: access ends here
  paidUntil:    timestamp('paid_until', { withTimezone: true }),    // paid plans: access runs to here (+ grace)
  isActive:     boolean('is_active').notNull().default(true),       // false = tenant suspended (nobody can sign in)
  nextPlan:     text('next_plan'),                                  // a plan change scheduled by the Super Admin …
  nextPlanFrom: date('next_plan_from'),                             // … that takes effect on this day
  archivedAt:   timestamp('archived_at', { withTimezone: true }),   // set = archived: blocked, hidden, and deletable 30 days later
  isDeleted:    boolean('is_deleted').notNull().default(false),     // soft delete: true = the business is gone from every screen but ALL its data is kept; only a Super Admin hard delete removes rows
  archiveReason: text('archive_reason'),
  exportedAt:   timestamp('exported_at', { withTimezone: true }),   // last time the Super Admin downloaded this business's data
  createdAt:    timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// The plans the Super Admin sells. `code` is what syndicates.plan stores. TRIAL is special (free, time-limited, always present).
// A retired plan (isActive = false) cannot be picked any more, but businesses already on it keep it and keep being billed its price.
export const saasPlans = pgTable('saas_plans', {
  code:        text('code').primaryKey(),
  name:        text('name').notNull(),
  price:       numeric('price', { precision: 10, scale: 2 }).notNull(),   // per billing cycle, GST included
  cycleDays:   integer('cycle_days').notNull().default(30),               // 30 = monthly, 90 = quarterly, 365 = yearly
  maxBranches: integer('max_branches').notNull(),
  features:    jsonb('features').$type<string[]>().notNull().default([]), // what the plan says it includes (shown on the price list)
  isActive:    boolean('is_active').notNull().default(true),
  sortOrder:   integer('sort_order').notNull().default(100),
  createdAt:   timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt:   timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export const branches = pgTable('branches', {
  id:              uuid('id').primaryKey().defaultRandom(),
  syndicateId:     uuid('syndicate_id').references(() => syndicates.id),
  parentBranchId:  uuid('parent_branch_id').references((): AnyPgColumn => branches.id), // For multi-tenancy parent/child stores
  name:            text('name').notNull(),
  code:            text('code').notNull().unique(),   // e.g., "MH1" — used in bill numbers
  address:         text('address'),
  stateCode:       text('state_code').notNull().default('TS'),    // which state's master catalog this shop draws from (master_products.state)
  gstin:           text('gstin'),
  exciseLicenseNo: text('excise_license_no'),
  printerHost:     text('printer_host'),                          // ESC/POS network printer (raw TCP)
  printerPort:     integer('printer_port').notNull().default(9100),
  paperWidth:      text('paper_width').notNull().default('58mm'), // '58mm' | '80mm'
  roundOff:        boolean('round_off').notNull().default(false), // round bill totals to the nearest rupee
  printViaAgent:   boolean('print_via_agent').notNull().default(false),   // send print jobs to the local print agent instead of TCP
  agentTokenHash:  text('agent_token_hash'),                              // sha256 of the agent's secret token
  agentLastSeenAt: timestamp('agent_last_seen_at', { withTimezone: true }),
  createdAt:       timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  // Agents authenticate on every poll by token hash; NULLs are distinct, so branches without an agent are fine
  uqAgentToken: uniqueIndex('uq_branch_agent_token').on(t.agentTokenHash),
  // ── mirrors of constraints / indexes created in raw SQL migrations (0025, 0040)
  idxBranchesSyndicate: index('idx_branches_syndicate').on(t.syndicateId),
}));

// ─── USERS ──────────────────────────────────────────────────────────────────

export const users = pgTable('users', {
  id:           uuid('id').primaryKey().defaultRandom(),
  branchId:     uuid('branch_id').references(() => branches.id),   // NULL = owner (all branches)
  syndicateId:  uuid('syndicate_id').references(() => syndicates.id), // owner scoped to one syndicate; NULL + NULL branch = platform owner
  name:         text('name').notNull(),
  email:        text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role:         userRoleEnum('role').notNull(),                       // the LEVEL every route guard sees (a custom role stores its level here)
  roleId:       uuid('role_id').references((): AnyPgColumn => roles.id),   // a custom role, or NULL = the built-in role named by `role`
  isActive:     boolean('is_active').notNull().default(true),
  createdAt:    timestamp('created_at', { withTimezone: true }).defaultNow(),
  lastLoginAt:  timestamp('last_login_at', { withTimezone: true }),   // set on every successful sign-in (Super Admin → Users)
  mustChangePassword: boolean('must_change_password').notNull().default(false),   // an administrator set the password: replace it before anything else
  passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),   // tokens issued before this are refused (password change / reset ends old sessions)
}, (t) => ({
  idxUsersBranch: index('idx_users_branch').on(t.branchId),
  idxUsersSyndicate: index('idx_users_syndicate').on(t.syndicateId),
}));

// Roles. The five built-in ones (isSystem) mirror the user_role enum and are always present; their permissions come from the
// code defaults, so a permission added later follows the usual rule for them. A custom role (made by the Super Admin) has a
// level (steward / cashier / manager: what the route guards see) and an explicit set of granted permissions.
export const roles = pgTable('roles', {
  id:          uuid('id').primaryKey().defaultRandom(),
  key:         text('key').notNull().unique(),                          // owner | office_admin | manager | cashier | steward, or a slug
  name:        text('name').notNull(),
  nameKey:     text('name_key').notNull().unique(),                     // lower-cased name: no two roles share one
  description: text('description'),
  level:       text('level').notNull(),                                 // owner | office_admin | manager | cashier | steward (text, so a migration can seed it)
  permissions: jsonb('permissions').$type<string[]>().notNull().default([]),   // custom roles only: the permission keys granted
  pages:       jsonb('pages').$type<string[] | null>(),                 // default menu pages; NULL = whatever the level allows
  isSystem:    boolean('is_system').notNull().default(false),
  isActive:    boolean('is_active').notNull().default(true),
  createdById: uuid('created_by_id').references((): AnyPgColumn => users.id),
  createdAt:   timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt:   timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

// Features the Super Admin can switch off for one branch (bank reconciliation, bar & KOT, …). No row = switched on.
// Only the switched-off ones are stored, so a new feature is on everywhere until someone turns it off.
export const branchFeatures = pgTable('branch_features', {
  branchId:    uuid('branch_id').notNull().references(() => branches.id, { onDelete: 'cascade' }),
  feature:     text('feature').notNull(),                                   // a key from platform/features.engine.ts
  updatedById: uuid('updated_by_id').references(() => users.id),
  updatedAt:   timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.branchId, t.feature] }),
}));

// ─── CATEGORIES ─────────────────────────────────────────────────────────────

// syndicate_id NULL = a PLATFORM category (the master list: Whisky, Beer, ...; only the Super Admin edits it, tenants read it).
// syndicate_id set = a tenant's own category (e.g. a kitchen "Starters" with its own GST). Names are unique per owner.
export const categories = pgTable('categories', {
  id:      uuid('id').primaryKey().defaultRandom(),
  name:    text('name').notNull(),              // e.g., "Whisky", "Beer"
  taxRate: numeric('tax_rate', { precision: 5, scale: 2 }).notNull(),  // GST %
  taxType: taxTypeEnum('tax_type').notNull().default('GST'),
  syndicateId: uuid('syndicate_id').references((): AnyPgColumn => syndicates.id),
}, (t) => ({
  uqOwnerName: uniqueIndex('uq_categories_owner_name').on(sql`coalesce(${t.syndicateId}, '00000000-0000-0000-0000-000000000000'::uuid)`, sql`lower(${t.name})`),
}));

// ─── MASTER PRODUCT CATALOG ──────────────────────────────────────────────────
// Immutable state-level reference catalog (e.g. Telangana TSBCL ICDC products).
// Owned by the platform, not by any tenant. Products in this table map to tenant
// store products via products.master_product_id. Tenant products inherit the
// canonical attributes (name, brand, volume, pack size, excise code) but own their
// own MRP, cost history, and stock records.

export const masterProducts = pgTable('master_products', {
  id:           uuid('id').primaryKey().defaultRandom(),
  state:        text('state').notNull().default('TS'),          // 'TS' = Telangana, 'AP' = Andhra Pradesh, etc.
  categoryName: text('category_name').notNull(),                // 'Whisky' | 'Beer' | 'Vodka' | 'Rum' | 'Brandy' | 'Gin' | 'Wine'
  name:         text('name').notNull(),                         // Official clean product name (no case tags)
  brand:        text('brand').notNull(),
  volumeMl:     integer('volume_ml').notNull(),
  packQuantity: integer('pack_quantity').notNull(),             // bottles per case
  exciseCode:   text('excise_code').notNull(),                  // 4-digit TSBCL brand code, e.g. '5028'
  sku:          text('sku').notNull().unique(),                 // canonical SKU e.g. 'TS-5028-650'
  // No price of any kind lives here: MRP and cost belong to the tenant (products / branch_product_prices / invoices).
  isActive:     boolean('is_active').notNull().default(true),     // false = discontinued
  revision:     integer('revision').notNull().default(1),           // +1 whenever brand / size / pack / excise / SKU / category changes
  createdAt:    timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt:    timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  // A state may publish the same excise code in multiple volumes (e.g. 180ml, 375ml, 750ml)
  // Each (state, exciseCode, volumeMl) must be unique.
  uqStateBrandVol: unique('uq_master_state_brand_vol').on(t.state, t.exciseCode, t.volumeMl),
}));

// Barcodes (EAN) of a master product: a pack can carry several. Used to recognise a scan and to fill the Add Product form.
export const masterProductBarcodes = pgTable('master_product_barcodes', {
  id:              uuid('id').primaryKey().defaultRandom(),
  masterProductId: uuid('master_product_id').notNull().references(() => masterProducts.id, { onDelete: 'cascade' }),
  barcode:         text('barcode').notNull(),
}, (t) => ({
  uqBarcode: uniqueIndex('uq_master_barcode').on(t.masterProductId, t.barcode),
  idxBarcode: index('idx_master_barcode').on(t.barcode),
}));

// ─── PRODUCTS ───────────────────────────────────────────────────────────────
// A row here is a TENANT's item. master_product_id says which master product it maps to (NULL = the tenant's own item:
// bar menu, kitchen, a local brand). For a mapped item the identity (brand, volume, pack, excise code) belongs to the master.
// products.mrp is the tenant-wide selling price (0.00 = not priced yet); a branch can override it in branch_product_prices.

export const products = pgTable('products', {
  id:           uuid('id').primaryKey().defaultRandom(),
  categoryId:   uuid('category_id').references(() => categories.id),
  masterProductId: uuid('master_product_id').references((): AnyPgColumn => masterProducts.id), // NULL = custom product not in master catalog
  masterRevision:  integer('master_revision'),                     // the master revision this item was last synced to (lower than the master's = "update available")
  barcode:      text('barcode'),    // unique per tenant (see uq_products_tenant_barcode)
  sku:          text('sku'),
  name:         text('name').notNull(),
  brand:        text('brand').notNull(),
  volumeMl:     integer('volume_ml'),
  exciseCode:   text('excise_code'), // e.g., '5028'
  packQuantity: integer('pack_quantity'), // e.g., 12, 24, 48 bottles/case
  mrp:               numeric('mrp', { precision: 12, scale: 2 }).notNull().default('0.00'),
  costPrice:         numeric('cost_price', { precision: 14, scale: 6 }),
  previousCostPrice: numeric('previous_cost_price', { precision: 14, scale: 6 }),
  costPerCase:       numeric('cost_per_case', { precision: 12, scale: 2 }),
  lastInvoiceId:     uuid('last_invoice_id'),
  lastInvoiceNumber: text('last_invoice_number'),
  lastInvoiceDate:   timestamp('last_invoice_date', { withTimezone: true }),
  costUpdatedAt:     timestamp('cost_updated_at', { withTimezone: true }),
  menuType:     menuTypeEnum('menu_type').notNull().default('RETAIL'),   // RETAIL = counter liquor; KITCHEN / BAR = menu items
  description:  text('description'),
  isAvailable:  boolean('is_available').notNull().default(true),         // in stock / out of stock switch for menu items
  gstRate:      numeric('gst_rate', { precision: 5, scale: 2 }),         // per-item GST %; NULL = use category rate
  trackStock:   boolean('track_stock').notNull().default(true),          // kitchen items are not stock-tracked
  hsnCode:      text('hsn_code'),                                        // printed on GST invoices
  syndicateId:  uuid('syndicate_id').notNull().references((): AnyPgColumn => syndicates.id),   // owning tenant; every product has one
  isActive:     boolean('is_active').notNull().default(true),
  createdAt:    timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  // Two bars sell the same branded bottle, so barcode/SKU only need to be unique inside one tenant
  uqTenantBarcode: uniqueIndex('uq_products_tenant_barcode').on(t.syndicateId, t.barcode),
  uqTenantSku:     uniqueIndex('uq_products_tenant_sku').on(t.syndicateId, t.sku),
  // A tenant maps a master product once
  uqTenantMaster:  uniqueIndex('uq_products_tenant_master').on(t.syndicateId, t.masterProductId).where(sql`master_product_id is not null`),
  idxMaster:       index('idx_products_master_product_id').on(t.masterProductId),
  // ── mirrors of constraints / indexes created in raw SQL migrations (0025, 0040)
  idxProductsCategory: index('idx_products_category').on(t.categoryId),
  fkProductsLastInvoice: foreignKey({ name: 'fk_products_last_invoice', columns: [t.lastInvoiceId], foreignColumns: [supplierInvoices.id] }).onDelete('set null'),
}));

// What a branch last paid for a product (written when a supplier invoice is approved). Two outlets of one business buy at
// different rates, so cost is per branch; products.cost_* stays as the business-wide "latest" fallback for legacy rows.
export const branchProductCosts = pgTable('branch_product_costs', {
  id:                uuid('id').primaryKey().defaultRandom(),
  branchId:          uuid('branch_id').notNull().references(() => branches.id, { onDelete: 'cascade' }),
  productId:         uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  costPrice:         numeric('cost_price', { precision: 14, scale: 6 }).notNull(),
  previousCostPrice: numeric('previous_cost_price', { precision: 14, scale: 6 }),
  costPerCase:       numeric('cost_per_case', { precision: 12, scale: 2 }),
  lastInvoiceId:     uuid('last_invoice_id'),
  lastInvoiceNumber: text('last_invoice_number'),
  lastInvoiceDate:   timestamp('last_invoice_date', { withTimezone: true }),
  costUpdatedAt:     timestamp('cost_updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqBranchProduct: uniqueIndex('uq_branch_product_cost').on(t.branchId, t.productId),
  idxProduct: index('idx_branch_product_costs_product').on(t.productId),
  // ── mirrors of constraints / indexes created in raw SQL migrations (0025, 0040)
  fkBranchCostsLastInvoice: foreignKey({ name: 'fk_branch_costs_last_invoice', columns: [t.lastInvoiceId], foreignColumns: [supplierInvoices.id] }).onDelete('set null'),
}));

// A branch's own selling price for a product, over the tenant-wide price. saleTypeId NULL = the default type (overrides
// products.mrp); a sale type = overrides that type's product_prices row. No row = the branch uses the tenant's price.
export const branchProductPrices = pgTable('branch_product_prices', {
  id:         uuid('id').primaryKey().defaultRandom(),
  branchId:   uuid('branch_id').notNull().references(() => branches.id, { onDelete: 'cascade' }),
  productId:  uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  saleTypeId: uuid('sale_type_id').references(() => saleTypes.id, { onDelete: 'cascade' }),
  price:      numeric('price', { precision: 12, scale: 2 }).notNull(),   // tax-inclusive
  updatedById: uuid('updated_by_id').references(() => users.id),
  updatedAt:  timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqBranchProductType: uniqueIndex('uq_branch_product_price').on(t.branchId, t.productId, sql`coalesce(${t.saleTypeId}, '00000000-0000-0000-0000-000000000000'::uuid)`),
  idxProduct: index('idx_branch_product_prices_product').on(t.productId),
}));

// Serving sizes for a drink (30ml / 60ml / full bottle ...), each with its own fixed rate
export const productServings = pgTable('product_servings', {
  id:        uuid('id').primaryKey().defaultRandom(),
  productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  label:     text('label').notNull(),                                   // e.g. '60 ml', 'Full bottle'
  volumeMl:  integer('volume_ml'),                                      // NULL = whole unit (bottle)
  price:     numeric('price', { precision: 12, scale: 2 }).notNull(),   // tax-inclusive
  sortOrder: integer('sort_order').notNull().default(0),
  isActive:  boolean('is_active').notNull().default(true),
}, (t) => ({
  uqServingLabel: uniqueIndex('uq_serving_product_label').on(t.productId, t.label),
}));

export const servingPriceAudit = pgTable('serving_price_audit', {
  id:        uuid('id').primaryKey().defaultRandom(),
  servingId: uuid('serving_id').notNull().references(() => productServings.id, { onDelete: 'cascade' }),
  userId:    uuid('user_id').references(() => users.id),
  oldPrice:  numeric('old_price', { precision: 12, scale: 2 }),
  newPrice:  numeric('new_price', { precision: 12, scale: 2 }).notNull(),
  changedAt: timestamp('changed_at', { withTimezone: true }).defaultNow(),
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

// ─── SALE TYPES (Walk-in, Janata, ...) ───────────────────────────────────────
// A sale type is a price list + its own counter. The DEFAULT type (Walk-in) is priced by products.mrp and its stock is
// whatever is left of stock after the explicit counters in stock_by_type. Rows that reference a sale type use NULL
// for the default type, so everything recorded before sale types existed is default-type data.

export const saleTypes = pgTable('sale_types', {
  id:         uuid('id').primaryKey().defaultRandom(),
  syndicateId: uuid('syndicate_id').references((): AnyPgColumn => syndicates.id),   // owning tenant; NULL = standalone shops
  code:       text('code').notNull(),                       // 'WALK_IN', 'JANATA', ...
  name:       text('name').notNull(),
  sortOrder:  integer('sort_order').notNull().default(0),
  isDefault:  boolean('is_default').notNull().default(false),
  isActive:   boolean('is_active').notNull().default(true),
  createdAt:  timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqTenantCode:    uniqueIndex('uq_sale_types_tenant_code').on(sql`coalesce(${t.syndicateId}, '00000000-0000-0000-0000-000000000000'::uuid)`, t.code),
  uqTenantDefault: uniqueIndex('uq_sale_types_tenant_default').on(sql`coalesce(${t.syndicateId}, '00000000-0000-0000-0000-000000000000'::uuid)`).where(sql`is_default`),
}));

// Which sale types a shop sells under (a missing row means enabled)
export const branchSaleTypes = pgTable('branch_sale_types', {
  id:         uuid('id').primaryKey().defaultRandom(),
  branchId:   uuid('branch_id').notNull().references(() => branches.id, { onDelete: 'cascade' }),
  saleTypeId: uuid('sale_type_id').notNull().references(() => saleTypes.id, { onDelete: 'cascade' }),
  enabled:    boolean('enabled').notNull().default(true),
}, (t) => ({
  uqBranchType: unique('uq_branch_sale_type').on(t.branchId, t.saleTypeId),
}));

// Tax-inclusive selling price of a product under a NON-default sale type (the default type uses products.mrp).
// No row = the product is not sold under that type.
export const productPrices = pgTable('product_prices', {
  id:         uuid('id').primaryKey().defaultRandom(),
  productId:  uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  saleTypeId: uuid('sale_type_id').notNull().references(() => saleTypes.id, { onDelete: 'cascade' }),
  price:      numeric('price', { precision: 12, scale: 2 }).notNull(),
  updatedAt:  timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqProductType: unique('uq_product_price_type').on(t.productId, t.saleTypeId),
}));
// Per-user permission overrides on top of the role defaults (see modules/permissions/permissions.engine.ts).
// A row says "this user is explicitly allowed / denied this action"; no row = the role default.
export const userPermissions = pgTable('user_permissions', {
  id:         uuid('id').primaryKey().defaultRandom(),
  userId:     uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  permission: text('permission').notNull(),                 // e.g. 'prices.edit', 'cost.view'
  allowed:    boolean('allowed').notNull(),
  updatedById: uuid('updated_by_id').references(() => users.id),
  updatedAt:  timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqUserPermission: unique('uq_user_permission').on(t.userId, t.permission),
}));

// Sale types a cashier / steward may bill and count under. No rows = every sale type of their shop.
export const userSaleTypes = pgTable('user_sale_types', {
  id:         uuid('id').primaryKey().defaultRandom(),
  userId:     uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  saleTypeId: uuid('sale_type_id').notNull().references(() => saleTypes.id, { onDelete: 'cascade' }),
}, (t) => ({
  uqUserSaleType: unique('uq_user_sale_type').on(t.userId, t.saleTypeId),
}));
// ─── STOCK ──────────────────────────────────────────────────────────────────

export const stock = pgTable('stock', {
  id:           uuid('id').primaryKey().defaultRandom(),
  branchId:     uuid('branch_id').notNull().references(() => branches.id),
  productId:    uuid('product_id').notNull().references(() => products.id),
  quantity:     integer('quantity').notNull().default(0),
  openMl:       integer('open_ml').notNull().default(0),   // ml left in the opened bottle (peg sales)
  reorderLevel: integer('reorder_level').default(5),
}, (t) => ({
  uniqueBranchProduct: unique('uq_branch_product').on(t.branchId, t.productId),
  // ── mirrors of constraints / indexes created in raw SQL migrations (0025, 0040)
  ckStockQtyNonneg: check('ck_stock_qty_nonneg', sql`quantity >= 0`),
}));

// Explicit counter of a NON-default sale type. Invariant: Σ stock_by_type.quantity <= stock.quantity for a product in a
// branch; the default type's counter is the remainder (stock.quantity - Σ explicit).
export const stockByType = pgTable('stock_by_type', {
  id:         uuid('id').primaryKey().defaultRandom(),
  branchId:   uuid('branch_id').notNull().references(() => branches.id),
  productId:  uuid('product_id').notNull().references(() => products.id),
  saleTypeId: uuid('sale_type_id').notNull().references(() => saleTypes.id),
  quantity:   integer('quantity').notNull().default(0),
}, (t) => ({
  uqBranchProductType: unique('uq_stock_by_type').on(t.branchId, t.productId, t.saleTypeId),
  // ── mirrors of constraints / indexes created in raw SQL migrations (0025, 0040)
  idxStockByTypeSaleType: index('idx_stock_by_type_sale_type').on(t.saleTypeId),
  ckStockByTypeQtyNonneg: check('ck_stock_by_type_qty_nonneg', sql`quantity >= 0`),
}));

// ─── STOCK AUDIT ────────────────────────────────────────────────────────────

export const stockAudit = pgTable('stock_audit', {
  id:          uuid('id').primaryKey().defaultRandom(),
  branchId:    uuid('branch_id').notNull().references(() => branches.id),
  productId:   uuid('product_id').notNull().references(() => products.id),
  userId:      uuid('user_id').references(() => users.id),
  changeQty:   integer('change_qty').notNull(),   // negative for sales
  changeMl:    integer('change_ml').notNull().default(0),   // ml sold/restored via peg servings
  reason:      stockReasonEnum('reason').notNull(),
  referenceId: uuid('reference_id'),              // bill_id or purchase_id
  saleTypeId:  uuid('sale_type_id').references(() => saleTypes.id),   // which counter moved; NULL = the default type
  createdAt:   timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  // Counter sheets and the excise stock-audit report read one product's movement in one branch over a day.
  idxStockAuditBranchProduct: index('idx_stock_audit_branch_product').on(t.branchId, t.productId, t.createdAt.desc()),
  // "what moved because of bill X" (void reversals, bill drill-down)
  idxStockAuditReference:     index('idx_stock_audit_reference').on(t.referenceId),
  // ── mirrors of constraints / indexes created in raw SQL migrations (0025, 0040)
  idxStockAuditBranchCreated: index('idx_stock_audit_branch_created').on(t.branchId, t.createdAt.desc()),
}));

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
  customerGstin:  text('customer_gstin'),                                                      // buyer GSTIN on a B2B invoice
  roundOff:       numeric('round_off', { precision: 12, scale: 2 }).notNull().default('0'),    // total = subtotal - discount + round_off
  shiftSessionId: uuid('shift_session_id').references((): AnyPgColumn => shiftSessions.id),  // cashier shift the bill was rung in
  clientRef:      text('client_ref').unique(),   // idempotency key for offline-queued bills
  saleTypeId:     uuid('sale_type_id').references(() => saleTypes.id),   // NULL = the default sale type (Walk-in)
  paidAt:      timestamp('paid_at', { withTimezone: true }),
  voidedAt:    timestamp('voided_at', { withTimezone: true }),
  voidReason:  text('void_reason'),
  createdAt:   timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  // Bill history and every dashboard read the newest bills of one branch (optionally one business day).
  // Postgres does not index foreign keys, and without this the list is a sequential scan.
  idxBillsBranchCreated: index('idx_bills_branch_created').on(t.branchId, t.createdAt.desc()),
  // "which bills are still open / were voided today" filters on branch + status
  idxBillsBranchStatus:  index('idx_bills_branch_status').on(t.branchId, t.status),
  // ── mirrors of constraints / indexes created in raw SQL migrations (0025, 0040)
  idxBillsShift: index('idx_bills_shift').on(t.shiftSessionId).where(sql`shift_session_id IS NOT NULL`),
  idxBillsCustomer: index('idx_bills_customer').on(t.customerId).where(sql`customer_id IS NOT NULL`),
  ckBillsPaymentMode: check('ck_bills_payment_mode', sql`payment_mode IS NULL OR payment_mode IN ('CASH','CARD','UPI','CREDIT')`),
  ckBillsTotalNonneg: check('ck_bills_total_nonneg', sql`total >= 0 AND subtotal >= 0 AND tax_amount >= 0`),
}));

// Per-branch, per-year bill sequence. Incremented atomically with UPDATE … RETURNING.
export const billCounters = pgTable('bill_counters', {
  branchId: uuid('branch_id').notNull().references(() => branches.id),
  year:     integer('year').notNull(),
  lastSeq:  integer('last_seq').notNull().default(0),
}, (t) => ({
  pk: primaryKey({ name: 'bill_counters_pkey', columns: [t.branchId, t.year] }),
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
  servingId:    uuid('serving_id').references(() => productServings.id),   // peg / glass sales
  servingLabel: text('serving_label'),
  servingMl:    integer('serving_ml'),
}, (t) => ({
  // Every bill read joins its lines on bill_id; a void reverses stock by reading them back.
  idxBillItemsBill: index('idx_bill_items_bill').on(t.billId),
  // ── mirrors of constraints / indexes created in raw SQL migrations (0025, 0040)
  idxBillItemsProduct: index('idx_bill_items_product').on(t.productId),
  ckBillItemsQtyPos: check('ck_bill_items_qty_pos', sql`quantity > 0`),
  ckBillItemsAmountsNonneg: check('ck_bill_items_amounts_nonneg', sql`unit_price >= 0 AND line_total >= 0 AND tax_amount >= 0`),
}));

// ─── PRICE AUDIT ────────────────────────────────────────────────────────────

export const priceAudit = pgTable('price_audit', {
  id:        uuid('id').primaryKey().defaultRandom(),
  productId: uuid('product_id').notNull().references(() => products.id),
  userId:    uuid('user_id').notNull().references(() => users.id),
  oldMrp:    numeric('old_mrp', { precision: 12, scale: 2 }),
  newMrp:    numeric('new_mrp', { precision: 12, scale: 2 }).notNull(),
  saleTypeId: uuid('sale_type_id').references(() => saleTypes.id),   // NULL = the default type's price (products.mrp)
  branchId:  uuid('branch_id').references(() => branches.id),         // set = a branch override changed; NULL = the tenant-wide price
  changedAt: timestamp('changed_at', { withTimezone: true }).defaultNow(),
});

// ─── DAILY CLOSING ──────────────────────────────────────────────────────────

export const closingStatusEnum = pgEnum('closing_status', ['OPEN', 'CLOSED']);

export const dailyClosings = pgTable('daily_closings', {
  id:                   uuid('id').primaryKey().defaultRandom(),
  branchId:             uuid('branch_id').notNull().references(() => branches.id),
  closedById:           uuid('closed_by_id').notNull().references(() => users.id),
  // Unique per branch per calendar day; enforced by migration 0003 expression index on (branch_id, closing_date::date)
  closingDate:          timestamp('closing_date', { withTimezone: true }).defaultNow(),
  openingCash:          numeric('opening_cash', { precision: 12, scale: 2 }).notNull(),
  cashSales:            numeric('cash_sales', { precision: 12, scale: 2 }).notNull(),
  cardSales:            numeric('card_sales', { precision: 12, scale: 2 }).notNull(),
  upiSales:             numeric('upi_sales', { precision: 12, scale: 2 }).notNull(),
  creditSales:          numeric('credit_sales', { precision: 12, scale: 2 }).notNull().default('0'),
  grossSales:           numeric('gross_sales', { precision: 12, scale: 2 }).notNull(),
  totalTax:             numeric('total_tax', { precision: 12, scale: 2 }).notNull(),
  cashWithdrawals:      numeric('cash_withdrawals', { precision: 12, scale: 2 }).notNull().default('0'),
  cashRepayments:       numeric('cash_repayments',  { precision: 12, scale: 2 }).notNull().default('0'),   // cash khata repayments taken that day (into the drawer)
  cashExpenses:         numeric('cash_expenses',    { precision: 12, scale: 2 }).notNull().default('0'),   // expenses paid in cash that day (out of the drawer)
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
}, (table) => {
  return {
    uq_daily_closing_branch_date: uniqueIndex('uq_daily_closing_branch_date').on(table.branchId, table.closingDate)
  }
});

// ─── SUPPLIER INVOICES (PURCHASE ENTRY) ──────────────────────────────────────

export const invoiceStatusEnum = pgEnum('invoice_status', ['DRAFT', 'REVIEWED', 'APPROVED', 'REJECTED', 'REVERSED']);

export const supplierInvoices = pgTable('supplier_invoices', {
  id:            uuid('id').primaryKey().defaultRandom(),
  branchId:      uuid('branch_id').notNull().references(() => branches.id),
  createdById:   uuid('created_by_id').notNull().references(() => users.id),
  approvedById:  uuid('approved_by_id').references(() => users.id),
  supplierName:  text('supplier_name').notNull(),
  invoiceNumber: text('invoice_number').notNull(),
  invoiceDate:   timestamp('invoice_date', { withTimezone: true }),
  linesBasicTotal:    numeric('lines_basic_total', { precision: 14, scale: 2 }).default('0.00'),
  mrpRoundingOff:     numeric('mrp_rounding_off', { precision: 12, scale: 2 }).default('0.00'),
  roundingAdjustment: numeric('rounding_adjustment', { precision: 10, scale: 4 }).default('0.0000'),
  totalAmount:        numeric('total_amount', { precision: 14, scale: 2 }).notNull(),
  specialExciseCess:  numeric('special_excise_cess', { precision: 12, scale: 2 }),
  turnoverTax:        numeric('turnover_tax', { precision: 12, scale: 2 }),
  tcsAmount:          numeric('tcs_amount', { precision: 12, scale: 2 }),
  totalCases:         integer('total_cases').default(0),
  totalBottles:       integer('total_bottles').default(0),
  // Telangana / ICDC Depot Reconciliation fields
  challanAmount:         numeric('challan_amount', { precision: 14, scale: 2 }),
  challanNumber:         text('challan_number'),
  previousCredit:        numeric('previous_credit', { precision: 14, scale: 2 }),
  subTotal:              numeric('sub_total', { precision: 14, scale: 2 }),
  netInvoiceValue:       numeric('net_invoice_value', { precision: 14, scale: 2 }),
  totalInvoiceAmount:    numeric('total_invoice_amount', { precision: 14, scale: 2 }),
  retailerCreditBalance: numeric('retailer_credit_balance', { precision: 14, scale: 2 }),
  status:             invoiceStatusEnum('status').notNull().default('DRAFT'),
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
  // An APPROVED invoice is never deleted: it is reversed (reversing voucher + stock taken back out)
  reversedById:       uuid('reversed_by_id').references(() => users.id),
  reversedAt:         timestamp('reversed_at', { withTimezone: true }),
  reversalReason:     text('reversal_reason'),
  extractionWarnings: jsonb('extraction_warnings').$type<string[]>(),
  extractionMeta:     jsonb('extraction_meta').$type<Record<string, unknown>>(),
}, (t) => ({
  // A live (non-rejected) invoice number is unique per branch+supplier; a rejected one may be re-submitted.
  uqLiveSupplierInvoice: uniqueIndex('uq_supplier_invoice_live_number')
    .on(t.branchId, t.supplierName, t.invoiceNumber)
    .where(sql`status <> 'REJECTED' AND reversed_at IS NULL`),
  // ── mirrors of constraints / indexes created in raw SQL migrations (0025, 0040)
  idxSupplierInvoicesBranchCreated: index('idx_supplier_invoices_branch_created').on(t.branchId, t.createdAt.desc()),
}));

export const supplierInvoiceItems = pgTable('supplier_invoice_items', {
  id:             uuid('id').primaryKey().defaultRandom(),
  invoiceId:      uuid('invoice_id').notNull().references(() => supplierInvoices.id, { onDelete: 'cascade' }),
  productId:      uuid('product_id').references(() => products.id), // null if new/unmatched
  rawDescription:     text('raw_description').notNull(),
  casesDelivered:     integer('cases_delivered').default(0),
  bottlesDelivered:   integer('bottles_delivered').default(0),
  packQuantity:       integer('pack_quantity').default(12),
  volumeMl:           integer('volume_ml'),
  quantity:           integer('quantity').notNull(),
  caseRate:           numeric('case_rate', { precision: 12, scale: 2 }),
  costPrice:          numeric('cost_price', { precision: 14, scale: 6 }).notNull(),
  taxRate:        numeric('tax_rate', { precision: 5, scale: 2 }).notNull().default('18.00'),
  lineCostTotal:      numeric('line_cost_total', { precision: 12, scale: 2 }).notNull(),
  unitDerivedTotal:   numeric('unit_derived_total', { precision: 14, scale: 4 }),
  roundingAdjustment: numeric('rounding_adjustment', { precision: 10, scale: 4 }).default('0.0000'),
  previousCostPrice:  numeric('previous_cost_price', { precision: 14, scale: 6 }),
  costDifference:     numeric('cost_difference', { precision: 14, scale: 6 }),
  costIncreasePct:    numeric('cost_increase_pct', { precision: 6, scale: 2 }),
  // Extraction / matching metadata (migration 0002)
  lineNumber:      integer('line_number'),
  barcode:         text('barcode'),
  matchStatus:     text('match_status'),    // 'MATCHED' | 'SUGGESTED' | 'UNMATCHED' | 'MANUAL'
  matchMethod:     text('match_method'),    // 'BARCODE' | 'SKU' | 'NAME' | 'MANUAL'
  matchConfidence: numeric('match_confidence', { precision: 4, scale: 3 }),
  extractedAmount: numeric('extracted_amount', { precision: 12, scale: 2 }),
  flags:           jsonb('flags').$type<string[]>(),
}, (t) => ({
  idxSupplierInvoiceItemsInvoice: index('idx_supplier_invoice_items_invoice').on(t.invoiceId),
  idxSupplierInvoiceItemsProduct: index('idx_supplier_invoice_items_product').on(t.productId).where(sql`product_id IS NOT NULL`),
}));

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
}, (t) => ({
  idxTablesBranch: index('idx_tables_branch').on(t.branchId),
}));

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
}, (t) => ({
  idxTableSessionsTableOpen: index('idx_table_sessions_table_open').on(t.tableId, t.closedAt),
  idxTableSessionsBranchOpen: index('idx_table_sessions_branch_open').on(t.branchId, t.closedAt),
  idxTableSessionsBill: index('idx_table_sessions_bill').on(t.billId).where(sql`bill_id IS NOT NULL`),
}));

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
}, (t) => ({
  idxKotOrdersSession: index('idx_kot_orders_session').on(t.tableSessionId),
  idxKotOrdersBranchCreated: index('idx_kot_orders_branch_created').on(t.branchId, t.createdAt.desc()),
}));

export const kotItems = pgTable('kot_items', {
  id:          uuid('id').primaryKey().defaultRandom(),
  kotOrderId:  uuid('kot_order_id').notNull().references(() => kotOrders.id, { onDelete: 'cascade' }),
  productId:   uuid('product_id').notNull().references(() => products.id),
  quantity:    integer('quantity').notNull(),
  unitPrice:   numeric('unit_price', { precision: 12, scale: 2 }).notNull(),   // MRP at order time
  taxRate:     numeric('tax_rate', { precision: 5, scale: 2 }).notNull(),
  servingId:    uuid('serving_id').references(() => productServings.id),
  servingLabel: text('serving_label'),
  servingMl:    integer('serving_ml'),
  status:      kotItemStatusEnum('status').notNull().default('PENDING'),
  notes:       text('notes'),                                                   // e.g., "No ice"
}, (t) => ({
  // A KOT order's items are always read as a set (print ticket, table bill).
  idxKotItemsOrder: index('idx_kot_items_order').on(t.kotOrderId),
  // ── mirrors of constraints / indexes created in raw SQL migrations (0025, 0040)
  ckKotItemsQtyPos: check('ck_kot_items_qty_pos', sql`quantity > 0`),
}));

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
}, (t) => ({
  idxSchemesBranchStatus: index('idx_schemes_branch_status').on(t.branchId, t.status),
}));

export const schemePurchases = pgTable('scheme_purchases', {
  id:          uuid('id').primaryKey().defaultRandom(),
  schemeId:    uuid('scheme_id').notNull().references(() => schemes.id),
  referenceId: uuid('reference_id'),   // supplier_invoice_id
  qty:         numeric('qty',   { precision: 12, scale: 2 }).notNull().default('0'),
  value:       numeric('value', { precision: 12, scale: 2 }).notNull().default('0'),
  recordedAt:  timestamp('recorded_at', { withTimezone: true }).defaultNow(),
  notes:       text('notes'),
}, (t) => ({
  idxSchemePurchasesScheme: index('idx_scheme_purchases_scheme').on(t.schemeId),
}));

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
  // ── mirrors of constraints / indexes created in raw SQL migrations (0025, 0040)
  idxShiftSessionsBranchOpened: index('idx_shift_sessions_branch_opened').on(t.branchId, t.openedAt.desc()),
}));

export const counterSheetStatusEnum = pgEnum('counter_sheet_status', ['DRAFT', 'POSTED']);

export const dailyCounterSheets = pgTable('daily_counter_sheets', {
  id:           uuid('id').primaryKey().defaultRandom(),
  branchId:     uuid('branch_id').notNull().references(() => branches.id),
  sheetDate:    date('sheet_date').notNull(),
  saleTypeId:   uuid('sale_type_id').references(() => saleTypes.id),   // one sheet per branch, day and sale type; NULL = default type
  status:       counterSheetStatusEnum('status').notNull().default('DRAFT'),
  totalRevenue: numeric('total_revenue', { precision: 14, scale: 2 }).notNull().default('0'),
  createdById:  uuid('created_by_id').notNull().references(() => users.id),
  postedById:   uuid('posted_by_id').references(() => users.id),
  postedAt:     timestamp('posted_at', { withTimezone: true }),
  createdAt:    timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqBranchDateType: uniqueIndex('uq_counter_sheet_branch_date_type').on(t.branchId, t.sheetDate, sql`coalesce(${t.saleTypeId}, '00000000-0000-0000-0000-000000000000'::uuid)`),
}));

export const dailyCounterSheetLines = pgTable('daily_counter_sheet_lines', {
  id:             uuid('id').primaryKey().defaultRandom(),
  sheetId:        uuid('sheet_id').notNull().references(() => dailyCounterSheets.id, { onDelete: 'cascade' }),
  productId:      uuid('product_id').notNull().references(() => products.id),
  openingBottles: integer('opening_bottles').notNull(),
  inwardBottles:  integer('inward_bottles').notNull().default(0),
  transferBottles: integer('transfer_bottles').notNull().default(0),   // net moved between sale-type counters that day (+ in, - out)
  closingBottles: integer('closing_bottles').notNull(),
  soldBottles:    integer('sold_bottles').notNull(),
  sellingRate:    numeric('selling_rate',  { precision: 12, scale: 2 }).notNull(),
  lineRevenue:    numeric('line_revenue',  { precision: 14, scale: 2 }).notNull(),
  adjustmentApprovedById: uuid('adjustment_approved_by_id').references(() => users.id), // manager override when closing > opening+inward
  openingSystem:  integer('opening_system'),                                              // the opening the system worked out, kept when someone changed it
  openingEditedById: uuid('opening_edited_by_id').references(() => users.id),            // who changed the opening (needs the counter.opening permission)
  closingManual:  boolean('closing_manual').notNull().default(false),                     // closing was counted by hand: bills must not recompute it
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
  gstin:         text('gstin'),                                                                   // B2B customers: drives CGST+SGST vs IGST
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
}, (t) => ({
  // A customer's khata statement is their whole ledger, newest first.
  idxCreditTxCustomer: index('idx_credit_tx_customer').on(t.customerId, t.recordedAt.desc()),
  // ── mirrors of constraints / indexes created in raw SQL migrations (0025, 0040)
  idxCreditTxnCustomerRecorded: index('idx_credit_txn_customer_recorded').on(t.customerId, t.recordedAt.desc()),
  idxCreditTxnBill: index('idx_credit_txn_bill').on(t.billId).where(sql`bill_id IS NOT NULL`),
  ckCreditTxnPayMode: check('ck_credit_txn_pay_mode', sql`payment_mode IS NULL OR payment_mode IN ('CASH','CARD','UPI')`),
  ckCreditTxnAmountPos: check('ck_credit_txn_amount_pos', sql`amount > 0`),
}));

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
}, (t) => ({
  idxExciseQuotasBranch: index('idx_excise_quotas_branch').on(t.branchId, t.periodStart),
}));

export const breakageLogs = pgTable('breakage_logs', {
  id:           uuid('id').primaryKey().defaultRandom(),
  branchId:     uuid('branch_id').notNull().references(() => branches.id),
  productId:    uuid('product_id').notNull().references(() => products.id),
  quantity:     integer('quantity').notNull(),   // bottles, positive
  reason:       text('reason').notNull(),
  costValue:    numeric('cost_value', { precision: 12, scale: 2 }).notNull().default('0'),
  recordedById: uuid('recorded_by_id').notNull().references(() => users.id),
  createdAt:    timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  idxBreakageBranchCreated: index('idx_breakage_branch_created').on(t.branchId, t.createdAt.desc()),
}));

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
  // ── mirrors of constraints / indexes created in raw SQL migrations (0025, 0040)
  idxJournalVouchersBranchDate: index('idx_journal_vouchers_branch_date').on(t.branchId, t.voucherDate),
}));

export const journalLines = pgTable('journal_lines', {
  id:        uuid('id').primaryKey().defaultRandom(),
  voucherId: uuid('voucher_id').notNull().references(() => journalVouchers.id, { onDelete: 'restrict' }),   // a posted line never vanishes with its voucher
  ledgerId:  uuid('ledger_id').notNull().references(() => accountLedgers.id),
  debit:     numeric('debit',  { precision: 14, scale: 2 }).notNull().default('0'),
  credit:    numeric('credit', { precision: 14, scale: 2 }).notNull().default('0'),
}, (t) => ({
  // A voucher's lines are read as a set (trial balance, Tally export, voucher drill-down).
  idxJournalLinesVoucher: index('idx_journal_lines_voucher').on(t.voucherId),
  // A ledger's entries (cash book, bank book) are read by ledger + date.
  idxJournalLinesLedger:  index('idx_journal_lines_ledger').on(t.ledgerId),
  // ── mirrors of constraints / indexes created in raw SQL migrations (0025, 0040)
  ckJournalLineOneSide: check('ck_journal_line_one_side', sql`debit >= 0 AND credit >= 0 AND (debit = 0 OR credit = 0)`),
}));

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
  voidedAt:     timestamp('voided_at', { withTimezone: true }),                 // an expense is voided, never deleted
  voidedById:   uuid('voided_by_id').references(() => users.id),
  voidReason:   text('void_reason'),
}, (t) => ({
  idxExpensesBranchDate: index('idx_expenses_branch_date').on(t.branchId, t.expenseDate),
  ckExpensesPaymentMode: check('ck_expenses_payment_mode', sql`payment_mode IN ('CASH','CARD','UPI','BANK')`),
  ckExpensesAmountPos: check('ck_expenses_amount_pos', sql`amount > 0`),
}));


// ─── BANK STATEMENT RECONCILIATION ──────────────────────────────────────────

// One real-world bank account. `scope` decides which books it is reconciled against:
//   BRANCH    → the BANK ledger of `branchId` only
//   SYNDICATE → the BANK ledgers of every branch in the syndicate (one account serving several outlets);
//               `branchId` is then the branch whose books receive the vouchers posted from the statement.
export const bankAccounts = pgTable('bank_accounts', {
  id:          uuid('id').primaryKey().defaultRandom(),
  branchId:    uuid('branch_id').notNull().references(() => branches.id),
  syndicateId: uuid('syndicate_id').references(() => syndicates.id),
  scope:       text('scope').notNull().default('BRANCH'),        // 'BRANCH' | 'SYNDICATE'
  name:        text('name').notNull(),                            // free label, e.g. "HDFC Current"
  bankName:    text('bank_name'),
  accountLast4: text('account_last4'),                            // never the full number
  isActive:    boolean('is_active').notNull().default(true),
  createdById: uuid('created_by_id').references(() => users.id),
  createdAt:   timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqBranchName: uniqueIndex('uq_bank_account_branch_name').on(t.branchId, t.name),
  // ── mirrors of constraints / indexes created in raw SQL migrations (0025, 0040)
  ckBankAccountScope: check('ck_bank_account_scope', sql`scope IN ('BRANCH','SYNDICATE')`),
}));

export const bankStatements = pgTable('bank_statements', {
  id:               uuid('id').primaryKey().defaultRandom(),
  accountId:        uuid('account_id').notNull().references(() => bankAccounts.id, { onDelete: 'cascade' }),
  uploadedById:     uuid('uploaded_by_id').references(() => users.id),
  originalFilename: text('original_filename'),
  fileHash:         text('file_hash').notNull(),                  // sha256 of the file: the same file twice is refused
  source:           text('source').notNull(),                     // 'CSV' | 'EXCEL' | 'PDF' | 'OFX' | 'QIF'
  periodStart:      date('period_start'),
  periodEnd:        date('period_end'),
  openingBalance:   numeric('opening_balance', { precision: 16, scale: 2 }),
  closingBalance:   numeric('closing_balance', { precision: 16, scale: 2 }),
  lineCount:        integer('line_count').notNull().default(0),
  duplicateCount:   integer('duplicate_count').notNull().default(0),   // lines skipped because an earlier upload had them
  status:           text('status').notNull().default('IMPORTED'),      // 'IMPORTED' | 'RECONCILED'
  balanceCheck:     jsonb('balance_check').$type<Record<string, unknown>>(),
  mapping:          jsonb('mapping').$type<Record<string, unknown>>(),
  warnings:         jsonb('warnings').$type<string[]>(),
  createdAt:        timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqAccountFile: uniqueIndex('uq_bank_statement_account_file').on(t.accountId, t.fileHash),
  // ── mirrors of constraints / indexes created in raw SQL migrations (0025, 0040)
  uqBankStatementIdAccount: unique('uq_bank_statement_id_account').on(t.id, t.accountId),
}));

export const bankStatementLines = pgTable('bank_statement_lines', {
  id:          uuid('id').primaryKey().defaultRandom(),
  statementId: uuid('statement_id').notNull().references(() => bankStatements.id, { onDelete: 'cascade' }),
  accountId:   uuid('account_id').notNull().references(() => bankAccounts.id, { onDelete: 'cascade' }),
  lineNo:      integer('line_no').notNull(),
  txnDate:     date('txn_date').notNull(),
  valueDate:   date('value_date'),
  narration:   text('narration').notNull().default(''),
  reference:   text('reference'),
  debit:       numeric('debit',  { precision: 16, scale: 2 }).notNull().default('0'),    // money out of the account
  credit:      numeric('credit', { precision: 16, scale: 2 }).notNull().default('0'),    // money into the account
  balance:     numeric('balance', { precision: 16, scale: 2 }),
  hash:        text('hash').notNull(),                            // identity of the transaction across overlapping statements
  status:      text('status').notNull().default('UNMATCHED'),     // UNMATCHED | SUGGESTED | MATCHED | IGNORED
  category:    text('category'),                                  // how it was resolved (SETTLEMENT, CASH_DEPOSIT, BANK_CHARGE, …)
  suggestion:  jsonb('suggestion').$type<Record<string, unknown>>(),
  confidence:  numeric('confidence', { precision: 4, scale: 3 }),
  feeAmount:   numeric('fee_amount', { precision: 16, scale: 2 }).notNull().default('0'),
  note:        text('note'),
  voucherId:   uuid('voucher_id').references(() => journalVouchers.id),   // set when accepting this line posted a voucher
  ignoreReason: text('ignore_reason'),                            // PERSONAL | OTHER_BUSINESS | NOT_OURS | OTHER — why it is not the store's
  ignoredByRuleId: uuid('ignored_by_rule_id'),                    // the rule that ignored it automatically (null = a person did)
  ruleExempt:  boolean('rule_exempt').notNull().default(false),   // a person un-ignored it: ignore rules must leave it alone from now on
  resolvedById: uuid('resolved_by_id').references(() => users.id),
  resolvedAt:  timestamp('resolved_at', { withTimezone: true }),
  createdAt:   timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqAccountHash: uniqueIndex('uq_bank_line_account_hash').on(t.accountId, t.hash),
  idxStatement:  index('idx_bank_line_statement').on(t.statementId, t.status),
  // ── mirrors of constraints / indexes created in raw SQL migrations (0025, 0040)
  idxBankLinesVoucher: index('idx_bank_lines_voucher').on(t.voucherId).where(sql`voucher_id IS NOT NULL`),
  ckBankLineStatus: check('ck_bank_line_status', sql`status IN ('UNMATCHED','SUGGESTED','MATCHED','IGNORED')`),
  fkBankLineStatementAccount: foreignKey({ name: 'fk_bank_line_statement_account', columns: [t.statementId, t.accountId], foreignColumns: [bankStatements.id, bankStatements.accountId] }).onDelete('cascade'),
}));

// "Ignore lines like this" for one bank account: personal spend, another business's money, and so on.
// SUGGEST rules only propose ignoring; AUTO rules ignore on import (and say which rule did it). A line that matches
// something in the books is never auto-ignored.
export const bankIgnoreRules = pgTable('bank_ignore_rules', {
  id:          uuid('id').primaryKey().defaultRandom(),
  accountId:   uuid('account_id').notNull().references(() => bankAccounts.id, { onDelete: 'cascade' }),
  pattern:     text('pattern').notNull(),                         // case-insensitive text found in the narration / reference
  side:        text('side').notNull().default('ANY'),             // ANY | IN (credits) | OUT (debits)
  minAmount:   numeric('min_amount', { precision: 16, scale: 2 }),
  maxAmount:   numeric('max_amount', { precision: 16, scale: 2 }),
  reason:      text('reason').notNull(),                          // PERSONAL | OTHER_BUSINESS | NOT_OURS | OTHER
  action:      text('action').notNull().default('SUGGEST'),       // SUGGEST | AUTO
  isActive:    boolean('is_active').notNull().default(true),
  createdById: uuid('created_by_id').references(() => users.id),
  createdAt:   timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  idxAccount: index('idx_bank_ignore_rule_account').on(t.accountId),
}));

// A transaction type the customer adds for one bank account (e.g. "Hotel rent", "Gold loan EMI"): a name, which side of
// the statement it appears on, and the ledger it posts to. Posting a line "as" this type creates the voucher against that ledger.
export const bankTransactionTypes = pgTable('bank_transaction_types', {
  id:          uuid('id').primaryKey().defaultRandom(),
  accountId:   uuid('account_id').notNull().references(() => bankAccounts.id, { onDelete: 'cascade' }),
  name:        text('name').notNull(),
  nameKey:     text('name_key').notNull(),                        // lower-cased name: one per account
  direction:   text('direction').notNull(),                       // IN (credits) | OUT (debits) | EITHER
  ledgerId:    uuid('ledger_id').notNull().references(() => accountLedgers.id),
  matchText:   text('match_text'),                                // optional: narration/reference text that suggests this type
  isActive:    boolean('is_active').notNull().default(true),
  createdById: uuid('created_by_id').references(() => users.id),
  createdAt:   timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqAccountName: uniqueIndex('uq_bank_type_account_name').on(t.accountId, t.nameKey),
}));

// Which book entries (BANK-ledger journal lines) a statement line accounts for. A card/UPI settlement is one
// statement line matching many sale entries, so this is one-to-many; a book entry is reconciled at most once.
export const bankLineMatches = pgTable('bank_line_matches', {
  id:            uuid('id').primaryKey().defaultRandom(),
  lineId:        uuid('line_id').notNull().references(() => bankStatementLines.id, { onDelete: 'cascade' }),
  journalLineId: uuid('journal_line_id').notNull().references(() => journalLines.id),
  createdAt:     timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqJournalLine: uniqueIndex('uq_bank_match_journal_line').on(t.journalLineId),
  idxLine:       index('idx_bank_match_line').on(t.lineId),
}));

// ─── MENU AVAILABILITY PER BRANCH ───────────────────────────────────────────

// A branch can switch a menu item off without touching the shared menu
export const branchMenuAvailability = pgTable('branch_menu_availability', {
  id:          uuid('id').primaryKey().defaultRandom(),
  branchId:    uuid('branch_id').notNull().references(() => branches.id),
  productId:   uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  isAvailable: boolean('is_available').notNull(),
  updatedAt:   timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqBranchProduct: uniqueIndex('uq_branch_menu_availability').on(t.branchId, t.productId),
}));

// ─── POUR COUNTS (peg variance) ─────────────────────────────────────────────

// Physical dip-stick / measure of the open bottle compared with what the system expects
export const pourCounts = pgTable('pour_counts', {
  id:         uuid('id').primaryKey().defaultRandom(),
  branchId:   uuid('branch_id').notNull().references(() => branches.id),
  productId:  uuid('product_id').notNull().references(() => products.id),
  userId:     uuid('user_id').references(() => users.id),
  expectedMl: integer('expected_ml').notNull(),
  countedMl:  integer('counted_ml').notNull(),
  varianceMl: integer('variance_ml').notNull(),   // counted - expected (negative = short)
  note:       text('note'),
  createdAt:  timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  idxPourCountsBranchCreated: index('idx_pour_counts_branch_created').on(t.branchId, t.createdAt.desc()),
}));

// ─── SaaS BACK OFFICE ───────────────────────────────────────────────────────

export const subscriptionInvoices = pgTable('subscription_invoices', {
  id:          uuid('id').primaryKey().defaultRandom(),
  syndicateId: uuid('syndicate_id').notNull().references(() => syndicates.id),
  plan:        text('plan').notNull(),
  amount:      numeric('amount', { precision: 12, scale: 2 }).notNull(),   // plan price incl. GST
  periodStart: date('period_start').notNull(),
  periodEnd:   date('period_end').notNull(),
  status:      text('status').notNull().default('PENDING'),                // PENDING | PAID | VOID
  paidAt:      timestamp('paid_at', { withTimezone: true }),
  paymentRef:  text('payment_ref'),                                        // UTR / cheque / gateway reference
  createdAt:   timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  idxSubscriptionInvoicesSyn: index('idx_subscription_invoices_syn').on(t.syndicateId, t.status),
  ckSubInvoiceStatus: check('ck_sub_invoice_status', sql`status IN ('PENDING','PAID','VOID')`),
}));

// Who did what on the platform: support sign-ins, plan changes, suspensions, password resets
export const auditLog = pgTable('audit_log', {
  id:         uuid('id').primaryKey().defaultRandom(),
  actorId:    uuid('actor_id').references(() => users.id),
  action:     text('action').notNull(),
  targetType: text('target_type'),
  targetId:   text('target_id'),
  meta:       jsonb('meta'),
  createdAt:  timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  idxAuditLogCreated: index('idx_audit_log_created').on(t.createdAt.desc()),
  idxAuditLogActor: index('idx_audit_log_actor').on(t.actorId).where(sql`actor_id IS NOT NULL`),
}));

// Print jobs that could not reach the printer are kept and retried
export const printJobs = pgTable('print_jobs', {
  id:            uuid('id').primaryKey().defaultRandom(),
  branchId:      uuid('branch_id').notNull().references(() => branches.id),
  kind:          text('kind').notNull(),                  // 'bill' | 'kot'
  refId:         uuid('ref_id').notNull(),
  status:        text('status').notNull().default('PENDING'),   // PENDING | SENT | FAILED
  attempts:      integer('attempts').notNull().default(0),
  lastError:     text('last_error'),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow(),
  target:        text('target').notNull().default('NETWORK'),   // NETWORK (server sends over TCP) | AGENT (picked up by the local print agent)
  payload:       text('payload'),                               // AGENT jobs: ESC/POS bytes, base64
  claimedAt:     timestamp('claimed_at', { withTimezone: true }),
  createdAt:     timestamp('created_at', { withTimezone: true }).defaultNow(),
  sentAt:        timestamp('sent_at', { withTimezone: true }),
}, (t) => ({
  idxPrintJobsPending: index('idx_print_jobs_pending').on(t.target, t.nextAttemptAt).where(sql`status = 'PENDING'`),
  ckPrintJobsStatus: check('ck_print_jobs_status', sql`status IN ('PENDING','SENT','FAILED') AND target IN ('NETWORK','AGENT')`),
}));

// ─── PAYMENTS, E-MAIL, PASSWORD RESET, BILLING REMINDERS ────────────────────

// One row per checkout started for a subscription invoice (provider order id is unique)
export const paymentOrders = pgTable('payment_orders', {
  id:                uuid('id').primaryKey().defaultRandom(),
  syndicateId:       uuid('syndicate_id').notNull().references(() => syndicates.id),
  invoiceId:         uuid('invoice_id').notNull().references(() => subscriptionInvoices.id),
  provider:          text('provider').notNull(),                 // 'razorpay' | 'mock'
  providerOrderId:   text('provider_order_id').notNull().unique(),
  providerPaymentId: text('provider_payment_id'),
  amount:            numeric('amount', { precision: 12, scale: 2 }).notNull(),
  currency:          text('currency').notNull().default('INR'),
  status:            text('status').notNull().default('CREATED'), // CREATED | PAID | FAILED
  createdAt:         timestamp('created_at', { withTimezone: true }).defaultNow(),
  paidAt:            timestamp('paid_at', { withTimezone: true }),
}, (t) => ({
  idxPaymentOrdersInvoice: index('idx_payment_orders_invoice').on(t.invoiceId),
}));

// Every e-mail the system produced; status LOGGED means no SMTP server was configured
export const emailOutbox = pgTable('email_outbox', {
  id:        uuid('id').primaryKey().defaultRandom(),
  toEmail:   text('to_email').notNull(),
  subject:   text('subject').notNull(),
  body:      text('body').notNull(),
  kind:      text('kind'),                                       // 'password_reset' | 'billing_due_7' | ...
  status:    text('status').notNull().default('LOGGED'),         // SENT | LOGGED | FAILED
  error:     text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const passwordResets = pgTable('password_resets', {
  id:        uuid('id').primaryKey().defaultRandom(),
  userId:    uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),              // sha256 of the emailed token
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt:    timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// Which billing reminders went out for which period, so each is sent once
export const dunningLog = pgTable('dunning_log', {
  id:          uuid('id').primaryKey().defaultRandom(),
  syndicateId: uuid('syndicate_id').notNull().references(() => syndicates.id),
  kind:        text('kind').notNull(),
  periodKey:   text('period_key').notNull(),
  sentAt:      timestamp('sent_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqDunning: uniqueIndex('uq_dunning_once').on(t.syndicateId, t.kind, t.periodKey),
}));

export const brandCodeMappings = pgTable('brand_code_mappings', {
  id:           uuid('id').primaryKey().defaultRandom(),
  brandCode:    text('brand_code').notNull(),
  volumeMl:     integer('volume_ml'),
  productId:    uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  productName:  text('product_name'),
  categoryName: text('category_name'),
  branchId:     uuid('branch_id').references(() => branches.id, { onDelete: 'cascade' }),
  syndicateId:  uuid('syndicate_id').notNull().references(() => syndicates.id),   // the tenant that owns the mapping (= its product's tenant)
  createdAt:    timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt:    timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  uqBrandCodeVolBranch: uniqueIndex('uq_brand_code_vol_branch').on(
    t.syndicateId,
    t.brandCode,
    sql`coalesce(${t.volumeMl}, 0)`,
    sql`coalesce(${t.branchId}, '00000000-0000-0000-0000-000000000000'::uuid)`
  ),
}));


// Every recorded money movement of a branch in one searchable table: a bank statement line that was posted to the books
// (source BANK_STATEMENT, one row per line) or, later, one typed in by hand (MANUAL). `category` is what the user calls it
// (Rent, Wages, Utilities, ...); `categoryKey` is its lower-cased form for searching. DEBIT = money out, CREDIT = money in.
export const ledgerTransactions = pgTable('ledger_transactions', {
  id:          uuid('id').primaryKey().defaultRandom(),
  branchId:    uuid('branch_id').notNull().references(() => branches.id),
  txnDate:     date('txn_date').notNull(),
  description: text('description').notNull(),
  amount:      numeric('amount', { precision: 12, scale: 2 }).notNull(),
  direction:   text('direction').notNull(),                       // DEBIT | CREDIT
  category:    text('category').notNull(),
  categoryKey: text('category_key').notNull(),
  reference:   text('reference'),
  source:      text('source').notNull(),                          // BANK_STATEMENT | MANUAL
  bankLineId:  uuid('bank_line_id').references(() => bankStatementLines.id, { onDelete: 'set null' }),
  voucherId:   uuid('voucher_id').references(() => journalVouchers.id),
  reconStatus: text('recon_status').notNull().default('MATCHED'), // MATCHED | UNMATCHED
  createdById: uuid('created_by_id').references(() => users.id),
  createdAt:   timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt:   timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  uqBankLine:  uniqueIndex('uq_ledger_txn_bank_line').on(t.bankLineId),
  idxCategory: index('idx_ledger_txn_branch_category').on(t.branchId, t.categoryKey, t.txnDate),
  // ── mirrors of constraints / indexes created in raw SQL migrations (0025, 0040)
  ckLedgerTxnDirection: check('ck_ledger_txn_direction', sql`direction IN ('DEBIT','CREDIT')`),
}));

// ─── QUALITY: FLAWS / DEFECTS ────────────────────────────────────────────────
//
// A multi-tenant defect tracker. Every row carries `tenantId` = the owning business (syndicates.id)
// and is protected by Row-Level Security (see src/db/tenant-rls.ts): a query that forgets to filter
// by tenant sees nothing, because the policy checks the `app.tenant_id` setting the service sets
// inside the transaction. The service *also* filters explicitly — RLS is the backstop, not the plan.

export const flawSeverityEnum = pgEnum('flaw_severity', ['BLOCKER', 'CRITICAL', 'MAJOR', 'MINOR', 'TRIVIAL']);
export const flawStatusEnum   = pgEnum('flaw_status', ['NEW', 'TRIAGED', 'IN_PROGRESS', 'FIXED', 'VERIFIED', 'CLOSED', 'REOPENED', 'DUPLICATE', 'REJECTED', 'DEFERRED']);
export const flawLinkTypeEnum = pgEnum('flaw_link_type', ['BLOCKS', 'BLOCKED_BY', 'RELATES_TO']);
export const flawRelationEnum = pgEnum('flaw_relation', ['DUPLICATE_OF', 'SPLIT_FROM', 'MERGED_INTO']);

/** A product area a flaw belongs to. A tree (parentId), unique per tenant. */
export const qualityModules = pgTable('quality_modules', {
  id:          uuid('id').primaryKey().defaultRandom(),
  tenantId:    uuid('tenant_id').notNull().references(() => syndicates.id),
  parentId:    uuid('parent_id').references((): AnyPgColumn => qualityModules.id),
  key:         text('key').notNull(),                              // stable slug: 'billing', 'bank-recon'
  name:        text('name').notNull(),
  description: text('description'),
  ownerId:     uuid('owner_id').references(() => users.id),         // who triages this area
  isActive:    boolean('is_active').notNull().default(true),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:   timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uqQualityModuleKey: unique('uq_quality_modules_tenant_key').on(t.tenantId, t.key),
  idxQualityModuleParent: index('idx_quality_modules_parent').on(t.tenantId, t.parentId),
}));

export const flaws = pgTable('flaws', {
  id:          uuid('id').primaryKey().defaultRandom(),
  tenantId:    uuid('tenant_id').notNull().references(() => syndicates.id),
  reference:   text('reference').notNull(),                        // FLW-<year>-000123, unique per tenant
  title:       text('title').notNull(),
  titleKey:    text('title_key').notNull(),                        // normalised title (see quality.engine.ts)
  fingerprint: text('fingerprint').notNull(),                      // sha1(tenant|module|titleKey|version): exact-duplicate block
  description: text('description'),
  severity:    flawSeverityEnum('severity').notNull().default('MINOR'),
  priority:    integer('priority').notNull().default(3),            // 1 = highest … 5 = lowest
  status:      flawStatusEnum('status').notNull().default('NEW'),
  moduleId:    uuid('module_id').references(() => qualityModules.id),
  environment: text('environment'),                                // DEV | QA | STAGING | PROD
  affectedVersion: text('affected_version'),
  fixedVersion:    text('fixed_version'),
  reporterId:  uuid('reporter_id').notNull().references(() => users.id),
  assigneeId:  uuid('assignee_id').references(() => users.id),
  // Denormalised fast path: "this record IS a duplicate of that one". The graph (flawDuplicates)
  // is authoritative; this column exists so a board query does not need a join.
  duplicateOfId: uuid('duplicate_of_id').references((): AnyPgColumn => flaws.id),
  dueAt:      timestamp('due_at', { withTimezone: true }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  closedAt:   timestamp('closed_at', { withTimezone: true }),
  createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uqFlawsReference: unique('uq_flaws_tenant_reference').on(t.tenantId, t.reference),
  // Layer 1 of duplicate detection: the same normalised title in the same module/version IS the same
  // flaw, so the second insert is refused (409) with the existing reference.
  uqFlawsFingerprint: unique('uq_flaws_fingerprint').on(t.tenantId, t.fingerprint),
  idxFlawsBoard:      index('idx_flaws_board').on(t.tenantId, t.status, t.severity),
  idxFlawsAssignee:   index('idx_flaws_assignee').on(t.tenantId, t.assigneeId, t.status),
  idxFlawsReporter:   index('idx_flaws_reporter').on(t.tenantId, t.reporterId, t.createdAt.desc()),
  idxFlawsModule:     index('idx_flaws_module').on(t.tenantId, t.moduleId, t.status),
  idxFlawsCreated:    index('idx_flaws_created').on(t.tenantId, t.createdAt.desc()),
  idxFlawsTitleKey:   index('idx_flaws_title_key').on(t.tenantId, t.titleKey),
  idxFlawsDuplicateOf: index('idx_flaws_duplicate_of').on(t.duplicateOfId),
}));

/**
 * The duplicate graph. `canonicalId` is the surviving flaw, `duplicateId` the one folded into it.
 * UNIQUE(duplicateId) is the important constraint: a flaw can be a duplicate of exactly ONE canonical
 * flaw, so two duplicate chains can never silently diverge.
 */
export const flawDuplicates = pgTable('flaw_duplicates', {
  tenantId:    uuid('tenant_id').notNull().references(() => syndicates.id),
  canonicalId: uuid('canonical_id').notNull().references(() => flaws.id, { onDelete: 'cascade' }),
  duplicateId: uuid('duplicate_id').notNull().references(() => flaws.id, { onDelete: 'cascade' }),
  relation:    flawRelationEnum('relation').notNull().default('DUPLICATE_OF'),
  confidence:  numeric('confidence', { precision: 4, scale: 3 }),   // 0.000–1.000, from the matcher
  matchedBy:   text('matched_by').notNull().default('USER'),        // USER | EXACT | FUZZY | IMPORT
  similarity:  numeric('similarity', { precision: 4, scale: 3 }),
  createdById: uuid('created_by_id').references(() => users.id),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pkFlawDuplicates:    primaryKey({ columns: [t.canonicalId, t.duplicateId] }),
  uqFlawDuplicateOnce: unique('uq_flaw_duplicates_once').on(t.duplicateId),
  idxFlawDuplicatesCanonical: index('idx_flaw_duplicates_canonical').on(t.canonicalId),
}));

export const flawComments = pgTable('flaw_comments', {
  id:         uuid('id').primaryKey().defaultRandom(),
  tenantId:   uuid('tenant_id').notNull().references(() => syndicates.id),
  flawId:     uuid('flaw_id').notNull().references(() => flaws.id, { onDelete: 'cascade' }),
  authorId:   uuid('author_id').notNull().references(() => users.id),
  body:       text('body').notNull(),
  isInternal: boolean('is_internal').notNull().default(false),      // notes not shown to the reporter
  createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxFlawCommentsFlaw: index('idx_flaw_comments_flaw').on(t.flawId, t.createdAt),
}));

export const flawAttachments = pgTable('flaw_attachments', {
  id:           uuid('id').primaryKey().defaultRandom(),
  tenantId:     uuid('tenant_id').notNull().references(() => syndicates.id),
  flawId:       uuid('flaw_id').notNull().references(() => flaws.id, { onDelete: 'cascade' }),
  commentId:    uuid('comment_id').references(() => flawComments.id, { onDelete: 'set null' }),
  fileName:     text('file_name').notNull(),
  contentType:  text('content_type'),
  byteSize:     integer('byte_size').notNull().default(0),
  sha256:       text('sha256').notNull(),                           // de-duplicates the same screenshot twice
  storageKey:   text('storage_key').notNull(),                     // where the blob lives (not this database)
  uploadedById: uuid('uploaded_by_id').notNull().references(() => users.id),
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxFlawAttachmentsFlaw: index('idx_flaw_attachments_flaw').on(t.flawId),
  uqFlawAttachmentOnce:   unique('uq_flaw_attachment_sha').on(t.flawId, t.sha256),
}));

export const flawTags = pgTable('flaw_tags', {
  id:       uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => syndicates.id),
  name:     text('name').notNull(),
  color:    text('color'),
}, (t) => ({
  uqFlawTagName: unique('uq_flaw_tags_tenant_name').on(t.tenantId, t.name),
}));

export const flawTagMap = pgTable('flaw_tag_map', {
  flawId: uuid('flaw_id').notNull().references(() => flaws.id, { onDelete: 'cascade' }),
  tagId:  uuid('tag_id').notNull().references(() => flawTags.id, { onDelete: 'cascade' }),
}, (t) => ({
  pkFlawTagMap: primaryKey({ columns: [t.flawId, t.tagId] }),
  idxFlawTagMapTag: index('idx_flaw_tag_map_tag').on(t.tagId),
}));
/** Append-only audit trail. The app role gets no UPDATE/DELETE grant on this table. */
export const flawHistory = pgTable('flaw_history', {
  id:          uuid('id').primaryKey().defaultRandom(),
  tenantId:    uuid('tenant_id').notNull().references(() => syndicates.id),
  flawId:      uuid('flaw_id').notNull().references(() => flaws.id, { onDelete: 'cascade' }),
  changedById: uuid('changed_by_id').references(() => users.id),
  action:      text('action').notNull(),                            // CREATED | STATUS_CHANGED | FIELD_CHANGED | ASSIGNED | COMMENTED | DUPLICATE_MARKED | DUPLICATE_UNMARKED
  fieldName:   text('field_name'),
  oldValue:    jsonb('old_value'),
  newValue:    jsonb('new_value'),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxFlawHistoryFlaw: index('idx_flaw_history_flaw').on(t.flawId, t.createdAt.desc()),
}));

export const flawWatchers = pgTable('flaw_watchers', {
  flawId:    uuid('flaw_id').notNull().references(() => flaws.id, { onDelete: 'cascade' }),
  userId:    uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pkFlawWatcher: primaryKey({ columns: [t.flawId, t.userId] }),
  idxFlawWatcherUser: index('idx_flaw_watcher_user').on(t.userId),
}));

/** Non-duplicate relationships: "this blocks that", "relates to". */
export const flawLinks = pgTable('flaw_links', {
  id:          uuid('id').primaryKey().defaultRandom(),
  tenantId:    uuid('tenant_id').notNull().references(() => syndicates.id),
  sourceId:    uuid('source_id').notNull().references(() => flaws.id, { onDelete: 'cascade' }),
  targetId:    uuid('target_id').notNull().references(() => flaws.id, { onDelete: 'cascade' }),
  linkType:    flawLinkTypeEnum('link_type').notNull().default('RELATES_TO'),
  createdById: uuid('created_by_id').references(() => users.id),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uqFlawLink: unique('uq_flaw_link').on(t.sourceId, t.targetId, t.linkType),
  idxFlawLinkTarget: index('idx_flaw_link_target').on(t.targetId),
}));

/** Per-tenant, per-year flaw reference sequence (FLW-2026-000123), incremented atomically. */
export const flawCounters = pgTable('flaw_counters', {
  tenantId: uuid('tenant_id').notNull().references(() => syndicates.id),
  year:     integer('year').notNull(),
  lastSeq:  integer('last_seq').notNull().default(0),
}, (t) => ({
  pkFlawCounter: primaryKey({ columns: [t.tenantId, t.year] }),
}));
// Failed sign-in counters shared by every API instance (see auth.service.ts, LOGIN THROTTLE)
export const loginThrottle = pgTable('login_throttle', {
  key:     text('key').primaryKey(),
  count:   integer('count').notNull().default(1),
  firstAt: timestamp('first_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─── STOCK TRANSFERS (between the outlets of one business) ──────────────────────
// Dispatch takes the bottles out of the sender's default counter at once (TRANSFER_OUT); they are IN_TRANSIT, in neither
// shop, until the receiver confirms (TRANSFER_IN, into the receiver's default counter). A sender can cancel while in transit
// (the bottles go back). A shortfall at receipt (received < sent) stays recorded on the transfer line as lost in transit.
export const stockTransfers = pgTable('stock_transfers', {
  id:             uuid('id').primaryKey().defaultRandom(),
  transferNumber: text('transfer_number').notNull().unique(),
  fromBranchId:   uuid('from_branch_id').notNull().references(() => branches.id),
  toBranchId:     uuid('to_branch_id').notNull().references(() => branches.id),
  status:         text('status').notNull().default('IN_TRANSIT'),   // IN_TRANSIT | RECEIVED | CANCELLED
  note:           text('note'),
  createdById:    uuid('created_by_id').notNull().references(() => users.id),
  createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  receivedById:   uuid('received_by_id').references(() => users.id),
  receivedAt:     timestamp('received_at', { withTimezone: true }),
  cancelledById:  uuid('cancelled_by_id').references(() => users.id),
  cancelledAt:    timestamp('cancelled_at', { withTimezone: true }),
  cancelReason:   text('cancel_reason'),
}, (t) => ({
  idxFrom: index('idx_stock_transfers_from').on(t.fromBranchId, t.status),
  idxTo:   index('idx_stock_transfers_to').on(t.toBranchId, t.status),
  ckStatus:   check('ck_stock_transfers_status', sql`status IN ('IN_TRANSIT','RECEIVED','CANCELLED')`),
  ckDistinct: check('ck_stock_transfers_distinct', sql`from_branch_id <> to_branch_id`),
}));

export const stockTransferItems = pgTable('stock_transfer_items', {
  id:               uuid('id').primaryKey().defaultRandom(),
  transferId:       uuid('transfer_id').notNull().references(() => stockTransfers.id, { onDelete: 'restrict' }),
  productId:        uuid('product_id').notNull().references(() => products.id),
  quantity:         integer('quantity').notNull(),
  receivedQuantity: integer('received_quantity'),   // NULL until received
}, (t) => ({
  uqItem: unique('uq_transfer_item_product').on(t.transferId, t.productId),
  idxTransfer: index('idx_stock_transfer_items_transfer').on(t.transferId),
  ckQty: check('ck_transfer_items_qty', sql`quantity > 0`),
  ckReceived: check('ck_transfer_items_received', sql`received_quantity IS NULL OR (received_quantity >= 0 AND received_quantity <= quantity)`),
}));

// ─── SUPPLIER PAYMENTS ───────────────────────────────────────────────────────────
// Money paid to a supplier against what the outlet owes (Dr SUNDRY_CREDITORS, Cr CASH | BANK). Voided, never deleted.
export const supplierPayments = pgTable('supplier_payments', {
  id:           uuid('id').primaryKey().defaultRandom(),
  branchId:     uuid('branch_id').notNull().references(() => branches.id),
  supplierName: text('supplier_name').notNull(),
  amount:       numeric('amount', { precision: 14, scale: 2 }).notNull(),
  paymentMode:  text('payment_mode').notNull(),   // CASH | UPI | CARD | BANK
  paymentDate:  date('payment_date').notNull(),
  reference:    text('reference'),                // UTR / cheque / DD number
  notes:        text('notes'),
  recordedById: uuid('recorded_by_id').notNull().references(() => users.id),
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  voidedAt:     timestamp('voided_at', { withTimezone: true }),
  voidedById:   uuid('voided_by_id').references(() => users.id),
  voidReason:   text('void_reason'),
}, (t) => ({
  idxBranchDate: index('idx_supplier_payments_branch_date').on(t.branchId, t.paymentDate),
  ckAmount: check('ck_supplier_payments_amount', sql`amount > 0`),
  ckMode: check('ck_supplier_payments_mode', sql`payment_mode IN ('CASH','UPI','CARD','BANK')`),
}));

// ─── RETURNS ─────────────────────────────────────────────────────────────────────
// A customer returning bottles from a PAID bill (credit note) and an outlet returning bottles to a supplier (debit note).
// Neither is ever deleted. A sales return is the sale voucher reversed for the returned share; a purchase return takes the
// cost off what is owed to the supplier.
export const salesReturns = pgTable('sales_returns', {
  id:             uuid('id').primaryKey().defaultRandom(),
  returnNumber:   text('return_number').notNull().unique(),
  branchId:       uuid('branch_id').notNull().references(() => branches.id),
  billId:         uuid('bill_id').notNull().references(() => bills.id),
  reason:         text('reason').notNull(),
  refundMode:     text('refund_mode').notNull(),            // CASH | CARD | UPI | CREDIT (khata balance reduced)
  grossAmount:    numeric('gross_amount',    { precision: 12, scale: 2 }).notNull(),
  taxAmount:      numeric('tax_amount',      { precision: 12, scale: 2 }).notNull(),
  discountAmount: numeric('discount_amount', { precision: 12, scale: 2 }).notNull(),
  refundAmount:   numeric('refund_amount',   { precision: 12, scale: 2 }).notNull(),
  createdById:    uuid('created_by_id').notNull().references(() => users.id),
  createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxBill: index('idx_sales_returns_bill').on(t.billId),
  idxBranchCreated: index('idx_sales_returns_branch_created').on(t.branchId, t.createdAt),
  ckMode: check('ck_sales_returns_mode', sql`refund_mode IN ('CASH','CARD','UPI','CREDIT')`),
  ckAmounts: check('ck_sales_returns_amounts', sql`gross_amount >= 0 AND tax_amount >= 0 AND discount_amount >= 0 AND refund_amount >= 0`),
}));

export const salesReturnItems = pgTable('sales_return_items', {
  id:          uuid('id').primaryKey().defaultRandom(),
  returnId:    uuid('return_id').notNull().references(() => salesReturns.id, { onDelete: 'restrict' }),
  billItemId:  uuid('bill_item_id').notNull().references(() => billItems.id),
  productId:   uuid('product_id').notNull().references(() => products.id),
  quantity:    integer('quantity').notNull(),
  grossAmount: numeric('gross_amount', { precision: 12, scale: 2 }).notNull(),
  taxAmount:   numeric('tax_amount',   { precision: 12, scale: 2 }).notNull(),
}, (t) => ({
  idxReturn: index('idx_sales_return_items_return').on(t.returnId),
  idxBillItem: index('idx_sales_return_items_bill_item').on(t.billItemId),
  ckQty: check('ck_sales_return_items_qty', sql`quantity > 0`),
}));

export const purchaseReturns = pgTable('purchase_returns', {
  id:           uuid('id').primaryKey().defaultRandom(),
  returnNumber: text('return_number').notNull().unique(),
  branchId:     uuid('branch_id').notNull().references(() => branches.id),
  supplierName: text('supplier_name').notNull(),
  invoiceId:    uuid('invoice_id').references(() => supplierInvoices.id, { onDelete: 'set null' }),
  reason:       text('reason').notNull(),
  amount:       numeric('amount', { precision: 14, scale: 2 }).notNull(),
  createdById:  uuid('created_by_id').notNull().references(() => users.id),
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxBranchCreated: index('idx_purchase_returns_branch_created').on(t.branchId, t.createdAt),
  ckAmount: check('ck_purchase_returns_amount', sql`amount > 0`),
}));

export const purchaseReturnItems = pgTable('purchase_return_items', {
  id:        uuid('id').primaryKey().defaultRandom(),
  returnId:  uuid('return_id').notNull().references(() => purchaseReturns.id, { onDelete: 'restrict' }),
  productId: uuid('product_id').notNull().references(() => products.id),
  quantity:  integer('quantity').notNull(),
  unitCost:  numeric('unit_cost', { precision: 14, scale: 6 }).notNull(),
  amount:    numeric('amount',    { precision: 14, scale: 2 }).notNull(),
}, (t) => ({
  idxReturn: index('idx_purchase_return_items_return').on(t.returnId),
  ckQty: check('ck_purchase_return_items_qty', sql`quantity > 0`),
}));

// ─── ERROR TRACKING (built in, no outside service) ───────────────────────────────────
// One row per distinct error (fingerprint), counted. Written by lib/errors.ts (server 500s) and POST /client-errors (browser).
export const errorEvents = pgTable('error_events', {
  id:           uuid('id').primaryKey().defaultRandom(),
  fingerprint:  text('fingerprint').notNull().unique(),
  source:       text('source').notNull(),                 // SERVER | BROWSER
  message:      text('message').notNull(),
  stack:        text('stack'),
  route:        text('route'),                            // path only: never the query string
  method:       text('method'),
  status:       integer('status'),
  userId:       uuid('user_id'),                          // plain ids, no FK: an error row must survive the user being deleted
  branchId:     uuid('branch_id'),
  userAgent:    text('user_agent'),
  release:      text('release'),
  occurrences:  integer('occurrences').notNull().default(1),
  firstSeenAt:  timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt:   timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt:   timestamp('resolved_at', { withTimezone: true }),
  resolvedById: uuid('resolved_by_id'),
}, (t) => ({
  idxLastSeen: index('idx_error_events_last_seen').on(t.lastSeenAt),
  ckSource: check('ck_error_events_source', sql`source IN ('SERVER','BROWSER')`),
}));
