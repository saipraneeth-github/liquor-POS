// APP1: run the project's own integration suite with Phase 1 + Phase 2 applied as a TEMPORARY migration.
//   node docs/db-optimization/scripts/app-regression.mjs <output-file>
// It adds drizzle/9999_dbopt_tmp.sql + a journal entry, runs `npm run test:integration`, and ALWAYS restores
// drizzle/meta/_journal.json byte-for-byte and deletes the temp file (try/finally). In-memory PGlite only.
import fs from 'node:fs'; import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './lib.mjs';

// usage: app-regression.mjs [outFile] [sqlFiles comma-separated] [vitest test path...]
const sqlFiles = (process.argv[3] || '001_indexes_up.sql,002_integrity_up.sql').split(',');
const testArgs = process.argv.slice(4);
const out = process.argv[2] || path.join(ROOT, 'docs/db-optimization/results/app-regression.txt');
const journalPath = path.join(ROOT, 'drizzle/meta/_journal.json');
const tmpSql = path.join(ROOT, 'drizzle/0025_dbopt_tmp.sql');
const original = fs.readFileSync(journalPath); // Buffer: restored exactly
try {
  const sql = sqlFiles.map((f) => fs.readFileSync(path.resolve(ROOT, 'docs/db-optimization/sql', f), 'utf8')).join('\n');
  fs.writeFileSync(tmpSql, sql.split(/;\s*\n/).filter((s) => s.replace(/--.*$/gm, '').trim()).join(';--> statement-breakpoint\n') + ';');
  const j = JSON.parse(original.toString('utf8'));
  j.entries.push({ idx: j.entries.length, version: '7', when: Date.now(), tag: '0025_dbopt_tmp', breakpoints: true });
  fs.writeFileSync(journalPath, JSON.stringify(j, null, 2));
  const r = spawnSync(...(testArgs.length ? ['npx', ['vitest', 'run', '--fileParallelism=false', ...testArgs]] : ['npm', ['run', 'test:integration']]), { cwd: ROOT, shell: true, encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, DATABASE_URL: 'pglite://memory', NO_COLOR: '1' } });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, (r.stdout || '') + (r.stderr || '') + `\nEXIT ${r.status}\n`);
  console.log('exit', r.status, '->', out);
} finally {
  fs.writeFileSync(journalPath, original);
  fs.rmSync(tmpSql, { force: true });
  console.log('journal restored:', fs.readFileSync(journalPath).equals(original), '| temp migration removed:', !fs.existsSync(tmpSql));
}
