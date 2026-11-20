# Operations runbook

## Deploying

1. Build: `npm run build` (frontend + `tsc`). Start: `npm start`.
2. **Migrate the database before the new code serves traffic**: `npm run db:migrate`. Every schema change ships a
   `drizzle/` migration, and a missing column fails real requests (a bill fails if `closing_manual` is missing; every
   sign-in fails without `login_throttle`; every authenticated request fails without `users.password_changed_at`).
   - The server **refuses to start** against a PostgreSQL that is behind the migrations (it prints which ones are missing).
   - `AUTO_MIGRATE=1` makes the server apply pending migrations itself at boot. Use it for a single instance only: with
     several instances, run `npm run db:migrate` once from the release pipeline instead.
3. Set in production: `NODE_ENV=production`, `DATABASE_URL`, `JWT_SECRET` (32+ random chars; the server refuses the `.env.example` placeholder), `CORS_ORIGIN` (the web origin, not `*`), `TRUST_PROXY` (a hop count such as `1`; the server refuses `true`). Configure SMTP too: with none, password-reset links exist only in the outbox, which hides them in production. On a shared hosted install set `PRINTER_BLOCK_PRIVATE=1`.
   placeholder), `CORS_ORIGIN` (the web origin, not `*`), `TRUST_PROXY` (a hop count such as `1`, **not** `true`).

## Error tracking

Errors are collected by the app itself (Platform -> Errors, Super Admin): server 500s and uncaught browser errors, one row per
distinct error with a count. Optional alerting: set `ERROR_WEBHOOK_URL` to a Slack / Teams / ntfy-style incoming webhook; it is
called once for each NEW error (never for repeats) with the scrubbed message and the route without its query string.
Rows not seen for 90 days are removed. Set `RELEASE` to your version string to see which release an error came from.

## Offline use (PWA)

The built app registers a service worker (`/sw.js`) so a counter tablet restarted while the internet is down still opens, and
the product list, outlets and sale types are served from the last good copy. Bills made offline are queued by the POS and sent
when the connection returns. If you change `frontend/public/sw.js`, bump `VERSION` at its top so old caches are dropped.
Serve the app over HTTPS in production (browsers only run service workers on HTTPS or localhost).

## Shutdown

The server handles `SIGTERM` / `SIGINT`: it stops accepting connections, lets in-flight requests (and their database
transactions) finish, stops the background workers, then exits. Give the process manager a stop timeout of at least 30 s
(`SHUTDOWN_TIMEOUT_MS`, default 25 000, is the point at which it exits anyway).

## Backups

The books live in one PostgreSQL database. Losing it loses every bill and voucher, so:

- **Nightly logical backup** (keep 14 days, copy off the host):
  `pg_dump --format=custom --file=liquor-$(date +%F).dump "$DATABASE_URL"`
- **Point-in-time recovery**: on a managed database (Neon, RDS, Cloud SQL) switch on PITR / continuous backup; it is the only
  way to recover to "just before the mistake".
- **Restore test, monthly**: `createdb restore_test && pg_restore --no-owner -d restore_test liquor-YYYY-MM-DD.dump`, then run
  `DATABASE_URL=postgresql://.../restore_test npm run db:migrate` (a no-op if the backup is current) and open the app against it.
- **Before a migration that drops or rewrites data** (for example `0036` drops `supplier_invoice_items.mrp`, `0040`
  replaces the `bill_counters` key): take a dump first.
- Uploaded supplier-invoice files are stored in the database, so a database backup covers them.

## After a migration with constraints (0040)

Constraints that found old rows breaking them print a WARNING and stay `NOT VALID` (new writes are still guarded). List and
fix the offenders, then validate:

```sql
SELECT * FROM stock WHERE quantity < 0;
SELECT * FROM stock_by_type WHERE quantity < 0;
SELECT * FROM expenses WHERE amount <= 0;
SELECT * FROM credit_transactions WHERE amount <= 0;
SELECT * FROM bills WHERE total < 0;
-- then, per constraint:
ALTER TABLE stock VALIDATE CONSTRAINT ck_stock_qty_nonneg;
```

## Reopening a closed day

A closed business day takes no more bills. An office admin or owner reopens it from Day Closing ("Reopen this day", reason
required). The closing record is removed and kept in full in the audit log (`closing.reopen`); close the day again afterwards.

## Health

`GET /health` and `GET /api/v1/health` run `select 1` (503 `degraded` when the database is unreachable). Use `/health` for
the load balancer check.
