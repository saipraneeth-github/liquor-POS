import { buildApp } from './app.js';
import { isPglite } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { startPrintWorker } from './modules/printing/print-queue.service.js';
import { startBillingWorker } from './modules/platform/dunning.service.js';

// ─── ENTRY POINT ─────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 3001);

async function main() {
  // Embedded PGlite has no separate migration step in local dev, so apply migrations on boot.
  if (isPglite) await runMigrations();

  const app = buildApp();
  try {
    await app.listen({ port: PORT, host: '0.0.0.0' });
    startPrintWorker();   // retries print jobs that could not reach the printer
    startBillingWorker(); // renewal invoices and payment reminders
    console.log(`🍾 Liquor Counter API running on http://localhost:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
