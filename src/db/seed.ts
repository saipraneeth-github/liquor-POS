import bcrypt from 'bcryptjs';
import { db } from './client.js';
import { branches, users, categories, products, stock, tables } from './schema.js';

async function seed() {
  console.log('🌱 Starting database seeding...');

  // 1. Create Default Branch
  const [branch] = await db
    .insert(branches)
    .values({
      name: 'Main Counter Branch',
      code: 'MAIN-01',
      address: 'Shop #12, Commercial Complex, Hyderabad',
      gstin: '36ABCDE1234F1Z5',
    })
    .onConflictDoNothing()
    .returning();

  const branchId = branch?.id ?? (await db.select().from(branches).limit(1))[0]?.id;
  if (!branchId) throw new Error('Failed to resolve branch ID');
  console.log(' Branch ready:', branchId);

  // 2. Create Default Users (Owner & Cashier)
  const passwordHash = await bcrypt.hash('Password@123', 10);

  const [owner] = await db
    .insert(users)
    .values({
      name: 'Store Owner',
      email: 'owner@liquor.com',
      passwordHash,
      role: 'owner',
      branchId,
    })
    .onConflictDoNothing()
    .returning();

  const [cashier] = await db
    .insert(users)
    .values({
      name: 'Counter Cashier',
      email: 'cashier@liquor.com',
      passwordHash,
      role: 'cashier',
      branchId,
    })
    .onConflictDoNothing()
    .returning();

  console.log(' Users ready: owner@liquor.com / cashier@liquor.com (Password: Password@123)');

  // 3. Create Categories
  const categoryData = [
    { name: 'Whisky', taxRate: '18.00' },
    { name: 'Beer', taxRate: '18.00' },
    { name: 'Vodka', taxRate: '18.00' },
    { name: 'Rum', taxRate: '18.00' },
  ];

  for (const cat of categoryData) {
    await db.insert(categories).values(cat).onConflictDoNothing();
  }
  const allCats = await db.select().from(categories);
  const whisky = allCats.find((c) => c.name === 'Whisky')!;
  const beer = allCats.find((c) => c.name === 'Beer')!;
  console.log(' Categories seeded:', allCats.length);

  // 4. Create Products & Initial Stock
  const productData = [
    {
      categoryId: whisky.id,
      name: 'Royal Challenge Premium Whisky 750ml',
      brand: 'Royal Challenge',
      volumeMl: 750,
      mrp: '850.00',
      costPrice: '620.00',
      barcode: '890123456001',
      sku: 'RC-750',
    },
    {
      categoryId: whisky.id,
      name: "Blenders Pride Rare Premium 750ml",
      brand: "Blenders Pride",
      volumeMl: 750,
      mrp: '1050.00',
      costPrice: '780.00',
      barcode: '890123456002',
      sku: 'BP-750',
    },
    {
      categoryId: beer.id,
      name: 'Kingfisher Premium Lager Beer 650ml',
      brand: 'Kingfisher',
      volumeMl: 650,
      mrp: '180.00',
      costPrice: '130.00',
      barcode: '890123456003',
      sku: 'KF-650',
    },
  ];

  for (const p of productData) {
    const [inserted] = await db.insert(products).values(p).onConflictDoNothing().returning();
    const prodId = inserted?.id ?? (await db.select().from(products).limit(1))[0]?.id;
    if (prodId) {
      await db
        .insert(stock)
        .values({
          branchId,
          productId: prodId,
          quantity: 100, // 100 bottles in opening stock
          reorderLevel: 10,
        })
        .onConflictDoNothing();
    }
  }
  console.log(' Products & Stock seeded (100 units each)');

  // 5. Create Bar & Floor Tables
  const tableData = [
    { name: 'Table 1', capacity: 4, section: 'Indoor' },
    { name: 'Table 2', capacity: 4, section: 'Indoor' },
    { name: 'Bar Counter 1', capacity: 2, section: 'Bar' },
  ];

  for (const t of tableData) {
    await db.insert(tables).values({ ...t, branchId }).onConflictDoNothing();
  }
  console.log(' Tables seeded');

  console.log('✅ Seeding complete!');
  process.exit(0);
}

seed().catch((err) => {
  console.error('❌ Seeding failed:', err);
  process.exit(1);
});

