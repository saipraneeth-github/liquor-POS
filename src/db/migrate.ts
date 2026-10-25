import { migrate as migratePg } from 'drizzle-orm/postgres-js/migrator';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { db, isPglite } from './client.js';

/** Applies all SQL migrations in ./drizzle to the configured database. */
export async function runMigrations(): Promise<void> {
  const config = { migrationsFolder: './drizzle' };
  if (isPglite) {
    await migratePglite(db as never, config);
  } else {
    await migratePg(db, config);
  }
}

const isEntryPoint = process.argv[1]?.replace(/\\/g, '/').endsWith('src/db/migrate.ts');
if (isEntryPoint) {
  runMigrations()
    .then(() => {
      console.log('Migrations applied');
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
