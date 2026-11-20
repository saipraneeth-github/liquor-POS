import { buildApp } from './app.js';
import { isPglite } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { pendingMigrations } from './db/migration-status.js';
import { startPrintWorker } from './modules/printing/print-queue.service.js';
import { startBillingWorker } from './modules/platform/dunning.service.js';

// ─── ENTRY POINT ─────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 3001);
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 25_000);

async function main() {
  // Embedded PGlite has no separate migration step in local dev, so apply migrations on boot.
  // On a real PostgreSQL migrations are applied on purpose (npm run db:migrate, or AUTO_MIGRATE=1 for a single instance);
  // starting against a database that is behind would fail real bills and sign-ins, so refuse and say what is missing.
  if (isPglite || process.env.AUTO_MIGRATE === '1') {
    await runMigrations();
  } else {
    const pending = await pendingMigrations();
    if (pending.length > 0) {
      console.error(`Database is behind the code: ${pending.length} migration(s) not applied (${pending.join(', ')}).`);
      console.error('Run `npm run db:migrate` first (or start with AUTO_MIGRATE=1 on a single instance).');
      process.exit(1);
    }
  }

  const app = buildApp();

  // Graceful shutdown: stop taking connections, let in-flight requests (and their transactions) finish, then exit.
  // Without this a deploy or restart could cut a bill in the middle of its transaction.
  let shuttingDown = false;
  const shutdown = async (reason: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`${reason}: shutting down, finishing in-flight requests`);
    setTimeout(() => { app.log.error('Shutdown timed out, exiting'); process.exit(1); }, SHUTDOWN_TIMEOUT_MS).unref();
    try {
      await app.close();
    } catch (err) {
      app.log.error(err);
      exitCode = 1;
    }
    process.exit(exitCode);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  // A rejected promise nobody awaited must be seen, but should not kill a server that may be mid-bill.
  process.on('unhandledRejection', (reason) => { app.log.error({ err: reason }, 'unhandledRejection'); });
  // After an uncaught exception the process state is unknown: finish what is running and exit non-zero.
  process.on('uncaughtException', (err) => { app.log.fatal({ err }, 'uncaughtException'); void shutdown('uncaughtException', 1); });

  try {
    await app.listen({ port: PORT, host: '0.0.0.0' });
    startPrintWorker();   // retries print jobs that could not reach the printer
    startBillingWorker(); // renewal invoices and payment reminders
    app.log.info(`Liquor Counter API running on http://localhost:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
