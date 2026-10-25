import { buildApp } from './app.js';
import { isPglite } from './db/client.js';
import { runMigrations } from './db/migrate.js';

// ─── ENTRY POINT ─────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 3001);

async function main() {
  // Embedded PGlite has no separate migration step in local dev, so apply migrations on boot.
  if (isPglite) await runMigrations();

  const app = buildApp();
  try {
    await app.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`🍾 Liquor Counter API running on http://localhost:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
