/**
 * Integration-test harness: boots the real Fastify app against an in-memory PGlite
 * database with all migrations applied. Each test FILE gets its own fresh database
 * (vitest isolates modules per file).
 *
 * Usage:
 *   const ctx = await setupIntegration();
 *   const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/products', headers: ctx.auth('cashier') });
 */
process.env.DATABASE_URL ??= 'pglite://memory';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'integration_test_secret_at_least_32_chars!!';

import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';

export type Role = 'owner' | 'manager' | 'cashier' | 'steward';

export interface IntegrationContext {
  app: FastifyInstance;
  db: typeof import('../../src/db/client.js').db;
  schema: typeof import('../../src/db/schema.js');
  branchId: string;
  otherBranchId: string;           // a second branch, used for cross-branch denial tests
  syndicateId: string;
  users: Record<Role, { id: string; email: string }>;
  otherBranchManager: { id: string; email: string };
  products: { id: string; mrp: string; categoryId: string }[];
  /** Authorization header for a seeded user of the given role (in the main branch). */
  auth: (role: Role) => { authorization: string };
  /** Authorization header for an arbitrary user payload. */
  authFor: (payload: { sub: string; email: string; role: Role; branchId: string | null; syndicateId?: string | null }) => { authorization: string };
}

export async function setupIntegration(): Promise<IntegrationContext> {
  const { db } = await import('../../src/db/client.js');
  const schema = await import('../../src/db/schema.js');
  const { runMigrations } = await import('../../src/db/migrate.js');
  const { buildApp } = await import('../../src/app.js');

  await runMigrations();

  const [syndicate] = await db.insert(schema.syndicates).values({ name: 'Test Syndicate' }).returning();
  const [branch] = await db.insert(schema.branches).values({ name: 'Main', code: 'MAIN', syndicateId: syndicate.id }).returning();
  const [other] = await db.insert(schema.branches).values({ name: 'Other', code: 'OTH' }).returning();

  const passwordHash = await bcrypt.hash('Password@123', 4);
  const roles: Role[] = ['owner', 'manager', 'cashier', 'steward'];
  const users = {} as IntegrationContext['users'];
  for (const role of roles) {
    const [u] = await db.insert(schema.users).values({
      name: `Test ${role}`,
      email: `${role}@test.local`,
      passwordHash,
      role,
      branchId: role === 'owner' ? null : branch.id,
      syndicateId: role === 'owner' ? syndicate.id : null,
    }).returning();
    users[role] = { id: u.id, email: u.email };
  }
  const [om] = await db.insert(schema.users).values({
    name: 'Other manager', email: 'manager@other.local', passwordHash, role: 'manager', branchId: other.id,
  }).returning();

  const [cat] = await db.insert(schema.categories).values({ name: 'Whisky', taxRate: '18.00' }).returning();
  const [beerCat] = await db.insert(schema.categories).values({ name: 'Beer', taxRate: '12.00' }).returning();
  const prods = await db.insert(schema.products).values([
    { name: 'Test Whisky 750ml', brand: 'TW', barcode: '1000000000001', sku: 'TW750', mrp: '1000.00', costPrice: '800.00', categoryId: cat.id, volumeMl: 750, packQuantity: 12 },
    { name: 'Test Beer 650ml', brand: 'TB', barcode: '1000000000002', sku: 'TB650', mrp: '200.00', costPrice: '150.00', categoryId: beerCat.id, volumeMl: 650, packQuantity: 12 },
  ]).returning();
  for (const p of prods) {
    await db.insert(schema.stock).values([
      { branchId: branch.id, productId: p.id, quantity: 100 },
      { branchId: other.id, productId: p.id, quantity: 100 },
    ]);
  }

  const app = buildApp();
  await app.ready();

  const authFor: IntegrationContext['authFor'] = (payload) => ({
    authorization: `Bearer ${app.jwt.sign({ syndicateId: null, ...payload })}`,
  });
  const auth = (role: Role) => authFor({
    sub: users[role].id,
    email: users[role].email,
    role,
    branchId: role === 'owner' ? null : branch.id,
    syndicateId: role === 'owner' ? syndicate.id : null,
  });

  return {
    app, db, schema,
    branchId: branch.id,
    otherBranchId: other.id,
    syndicateId: syndicate.id,
    users,
    otherBranchManager: { id: om.id, email: om.email },
    products: prods.map((p) => ({ id: p.id, mrp: p.mrp, categoryId: p.categoryId! })),
    auth,
    authFor,
  };
}
