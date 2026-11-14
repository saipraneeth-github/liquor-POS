// Shared helper: builds a THROWAWAY in-memory PGlite database by applying ./drizzle/*.sql in journal order.
// It never reads DATABASE_URL, so it can not touch a real database.
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

export const ROOT = path.resolve(import.meta.dirname, '../../..');

export async function createMigratedDb({ upTo = Infinity } = {}) {
  const db = new PGlite(); // memory
  const journal = JSON.parse(fs.readFileSync(path.join(ROOT, 'drizzle/meta/_journal.json'), 'utf8'));
  let n = 0;
  for (const entry of journal.entries) {
    if (n++ >= upTo) break;
    const sqlText = fs.readFileSync(path.join(ROOT, 'drizzle', entry.tag + '.sql'), 'utf8');
    for (const stmt of sqlText.split('--> statement-breakpoint')) {
      if (stmt.trim()) await db.exec(stmt);
    }
  }
  return db;
}

export async function runSqlFile(db, file) {
  const text = fs.readFileSync(file, 'utf8');
  await db.exec(text);
}
