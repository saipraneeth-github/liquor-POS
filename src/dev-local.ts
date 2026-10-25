/**
 * Zero-setup local runner: embedded PGlite database in ./.pglite, migrations applied,
 * demo data seeded on first run, then the API starts on PORT (default 3001).
 *
 *   npm run dev:local
 *
 * Set DATABASE_URL to a postgres URL to use a real server instead.
 */
process.env.DATABASE_URL ??= 'pglite://./.pglite';
process.env.JWT_SECRET ??= 'local_dev_only_secret_do_not_use_in_production';
process.env.PORT ??= '3001';

const { runMigrations } = await import('./db/migrate.js');
const { seedDatabase } = await import('./db/seed.js');
const { db } = await import('./db/client.js');
const { users } = await import('./db/schema.js');

await runMigrations();
const existing = await db.select({ id: users.id }).from(users).limit(1);
if (existing.length === 0) {
  await seedDatabase();
}

await import('./index.js');
