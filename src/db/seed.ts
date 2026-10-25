import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { db } from './client.js';
import {
  syndicates, branches, users, categories, products, stock, tables, terminals, customers,
} from './schema.js';

export const SEED_PASSWORD = 'Password@123';

/**
 * Idempotent demo seed: one syndicate with one branch, a user per role, categories,
 * products with opening stock, tables, a POS terminal and two khata customers.
 */
export async function seedDatabase(): Promise<void> {
  console.log('🌱 Starting database seeding...');

  // 1. Syndicate & branch
  let [syndicate] = await db.select().from(syndicates).where(eq(syndicates.name, 'Demo Liquor Syndicate')).limit(1);
  if (!syndicate) {
    [syndicate] = await db.insert(syndicates).values({
      name: 'Demo Liquor Syndicate',
      gstin: '36ABCDE1234F1Z5',
      contactPhone: '9000000000',
    }).returning();
  }

  await db.insert(branches).values({
    syndicateId: syndicate.id,
    name: 'Main Counter Branch',
    code: 'MAIN-01',
    address: 'Shop #12, Commercial Complex, Hyderabad',
    gstin: '36ABCDE1234F1Z5',
    exciseLicenseNo: 'EXC-TS-0001',
  }).onConflictDoNothing();
  const [branch] = await db.select().from(branches).where(eq(branches.code, 'MAIN-01')).limit(1);
  const branchId = branch.id;
  console.log(' Branch ready:', branchId);

  // 2. Users — owner is scoped to the syndicate (no single branch); others work in the branch
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 10);
  await db.insert(users).values([
    { name: 'Store Owner',     email: 'owner@liquor.com',   passwordHash, role: 'owner',   branchId: null, syndicateId: syndicate.id },
    { name: 'Branch Manager',  email: 'manager@liquor.com', passwordHash, role: 'manager', branchId },
    { name: 'Counter Cashier', email: 'cashier@liquor.com', passwordHash, role: 'cashier', branchId },
    { name: 'Floor Steward',   email: 'steward@liquor.com', passwordHash, role: 'steward', branchId },
  ]).onConflictDoNothing();
  console.log(` Users ready: owner@ / manager@ / cashier@ / steward@liquor.com (Password: ${SEED_PASSWORD})`);

  // 3. Categories
  await db.insert(categories).values([
    { name: 'Whisky', taxRate: '18.00' },
    { name: 'Beer',   taxRate: '18.00' },
    { name: 'Vodka',  taxRate: '18.00' },
    { name: 'Rum',    taxRate: '18.00' },
  ]).onConflictDoNothing();
  const allCats = await db.select().from(categories);
  const catId = (name: string) => allCats.find((c) => c.name === name)!.id;
  console.log(' Categories seeded:', allCats.length);

  // 4. Products & opening stock (looked up by barcode so re-runs attach stock to the right product)
  const productData = [
    { categoryId: catId('Whisky'), name: 'Royal Challenge Premium Whisky 750ml', brand: 'Royal Challenge', volumeMl: 750, packQuantity: 12, mrp: '850.00',  costPrice: '620.00', barcode: '890123456001', sku: 'RC-750' },
    { categoryId: catId('Whisky'), name: 'Blenders Pride Rare Premium 750ml',     brand: 'Blenders Pride',  volumeMl: 750, packQuantity: 12, mrp: '1050.00', costPrice: '780.00', barcode: '890123456002', sku: 'BP-750' },
    { categoryId: catId('Beer'),   name: 'Kingfisher Premium Lager Beer 650ml',   brand: 'Kingfisher',      volumeMl: 650, packQuantity: 12, mrp: '180.00',  costPrice: '130.00', barcode: '890123456003', sku: 'KF-650' },
    { categoryId: catId('Vodka'),  name: 'Magic Moments Vodka 750ml',             brand: 'Magic Moments',   volumeMl: 750, packQuantity: 12, mrp: '700.00',  costPrice: '520.00', barcode: '890123456004', sku: 'MM-750' },
    { categoryId: catId('Rum'),    name: 'Old Monk XXX Rum 750ml',                brand: 'Old Monk',        volumeMl: 750, packQuantity: 12, mrp: '450.00',  costPrice: '330.00', barcode: '890123456005', sku: 'OM-750' },
  ];

  for (const p of productData) {
    await db.insert(products).values(p).onConflictDoNothing();
    const [prod] = await db.select().from(products).where(eq(products.barcode, p.barcode)).limit(1);
    await db.insert(stock).values({ branchId, productId: prod.id, quantity: 100, reorderLevel: 10 }).onConflictDoNothing();
  }
  console.log(' Products & stock seeded (100 bottles each)');

  // 5. Tables
  const existingTables = await db.select().from(tables).where(eq(tables.branchId, branchId));
  if (existingTables.length === 0) {
    await db.insert(tables).values([
      { branchId, name: 'Table 1',       capacity: 4, section: 'Indoor' },
      { branchId, name: 'Table 2',       capacity: 4, section: 'Indoor' },
      { branchId, name: 'Bar Counter 1', capacity: 2, section: 'Bar' },
    ]);
  }
  console.log(' Tables seeded');

  // 6. POS terminal
  await db.insert(terminals).values({ branchId, terminalName: 'Counter 1', deviceKey: 'demo-counter-1' }).onConflictDoNothing();
  console.log(' Terminal seeded: Counter 1');

  // 7. Khata customers
  await db.insert(customers).values([
    { branchId, name: 'Ravi Kumar',  phone: '9876543210', creditAllowed: true,  creditLimit: '5000.00' },
    { branchId, name: 'Walk-in Regular', phone: '9123456780', creditAllowed: false, creditLimit: '0' },
  ]).onConflictDoNothing();
  console.log(' Customers seeded');

  console.log('✅ Seeding complete!');
}

const isEntryPoint = process.argv[1]?.replace(/\\/g, '/').endsWith('src/db/seed.ts');
if (isEntryPoint) {
  seedDatabase()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Seeding failed:', err);
      process.exit(1);
    });
}
