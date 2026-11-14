// Builds drizzle/0025_db_optimization.sql from the final Phase 1 + Phase 2 scripts and registers it in the Drizzle journal.
//   node docs/db-optimization/scripts/make-migration.mjs
// Idempotent: refuses to add a second journal entry. Plain CREATE INDEX (no CONCURRENTLY): the Drizzle migrator runs the whole
// pending batch in ONE transaction, where CONCURRENTLY is not allowed. Fine for test/staging; for a busy production
// database use the *_concurrent.sql files with psql instead (see 08-deployment-runbook.md).
import fs from 'node:fs'; import path from 'node:path';
import { ROOT } from './lib.mjs';

const TAG = '0025_db_optimization';
const sqlDir = path.join(ROOT, 'docs/db-optimization/sql');
const journalPath = path.join(ROOT, 'drizzle/meta/_journal.json');
const outPath = path.join(ROOT, 'drizzle', TAG + '.sql');

const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
const registered = journal.entries.some((e) => e.tag === TAG);

// split a script into statements, keeping the comment lines that precede each statement with it
const statements = (file) => {
  const out = []; let buf = [];
  for (const line of fs.readFileSync(path.join(sqlDir, file), 'utf8').split('\n')) {
    buf.push(line);
    if (/;\s*$/.test(line) && !/^\s*--/.test(line)) { out.push(buf.join('\n').trim()); buf = []; }
  }
  return out;
};
const header = `-- ${TAG}: database optimisation (docs/db-optimization).
-- Part 1: 41 indexes. Part 2: 11 CHECK constraints, 1 composite FK + 1 unique, 1 FK (added NOT VALID, then validated).
-- Adds indexes and rules. The ONLY data change: products.last_invoice_id values that point at a deleted invoice are copied to
-- products_last_invoice_orphans_backup and then set to NULL (what ON DELETE SET NULL would have done). If any other row violates a
-- rule, VALIDATE fails and this whole migration rolls back.
-- Undo by hand with docs/db-optimization/sql/002_integrity_down.sql then 001_indexes_down.sql.
-- Source of truth: docs/db-optimization/sql/001_indexes_up.sql and 002_integrity_up.sql (regenerate with scripts/make-migration.mjs).`;
const all = [...statements('001_indexes_up.sql'), ...statements('002_integrity_up.sql')];
fs.writeFileSync(outPath, header + '\n' + all.join('\n--> statement-breakpoint\n') + '\n');

if (registered) { console.log(`regenerated ${path.relative(ROOT, outPath)} (${all.length} statements); journal entry already present`); process.exit(0); }
const last = journal.entries[journal.entries.length - 1];
journal.entries.push({ idx: journal.entries.length, version: last.version, when: Math.max(Date.now(), last.when + 1), tag: TAG, breakpoints: true });
fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2));
console.log(`wrote ${path.relative(ROOT, outPath)} (${all.length} statements) and registered it as journal idx ${journal.entries.length - 1}`);
