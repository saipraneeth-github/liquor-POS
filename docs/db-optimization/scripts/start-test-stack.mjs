// Starts API (3001) + Vite (5173) on a FRESH local PGlite database (./.pglite-dbopt) with Phase 1 + Phase 2 applied,
// so the UI can be tested through http://localhost:5173 without touching ./.pglite or any hosted database.
//   node docs/db-optimization/scripts/start-test-stack.mjs        (keeps running; Ctrl+C / kill stops both servers)
import fs from 'node:fs'; import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT } from './lib.mjs';

// BASELINE=1 -> the same stack WITHOUT the optimisation migration, on its own database, for A/B comparison
const BASELINE = process.env.BASELINE === '1';
const DB_DIR = BASELINE ? './.pglite-dbopt-base' : './.pglite-dbopt';
const journalPath = path.join(ROOT, 'drizzle/meta/_journal.json');
const tmpSql = path.join(ROOT, 'drizzle/0025_dbopt_tmp.sql');
const original = fs.readFileSync(journalPath);
const kids = [];
const cleanup = () => { fs.writeFileSync(journalPath, original); fs.rmSync(tmpSql, { force: true }); };
const stopAll = () => { kids.forEach((k) => { try { spawn('taskkill', ['/pid', String(k.pid), '/T', '/F']); } catch {} }); };
process.on('SIGINT', () => { stopAll(); process.exit(0); });

// refuse to run if something already listens on 3001 (never reuse a server that may point at a real database)
const busy = await fetch('http://localhost:3001/health').then(() => true, () => false);
if (busy) { console.error('PORT 3001 IS ALREADY IN USE - not starting (it may be pointed at a real database).'); process.exit(2); }

try {
  const sql = ['001_indexes_up.sql', '002_integrity_up.sql'].map((f) => fs.readFileSync(path.join(ROOT, 'docs/db-optimization/sql', f), 'utf8')).join('\n');
  if (!BASELINE) fs.writeFileSync(tmpSql, sql.split(/;\s*\n/).filter((s) => s.replace(/--.*$/gm, '').trim()).join(';--> statement-breakpoint\n') + ';');
  if (!BASELINE) {
    const j = JSON.parse(original.toString('utf8'));
    j.entries.push({ idx: j.entries.length, version: '7', when: Date.now(), tag: '0025_dbopt_tmp', breakpoints: true });
    fs.writeFileSync(journalPath, JSON.stringify(j, null, 2));
  }

  const api = spawn('node', ['--import', 'tsx', 'src/dev-local.ts'], { cwd: ROOT, shell: false, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, DATABASE_URL: `pglite://${DB_DIR}`, PORT: '3001', NODE_ENV: 'development' } });
  kids.push(api);
  for (let i = 0; i < 120; i++) { // wait for health (migrations + seed run first)
    if (await fetch('http://localhost:3001/health').then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log('API up on 3001 with', DB_DIR);
} finally {
  cleanup(); // migration is already applied to the scratch DB; the repo journal goes back byte-for-byte
  console.log('journal restored:', fs.readFileSync(journalPath).equals(original), '| temp migration removed:', !fs.existsSync(tmpSql));
}
const vite = spawn('npm', ['run', 'dev:frontend'], { cwd: ROOT, shell: true, stdio: ['ignore', 'inherit', 'inherit'] });
kids.push(vite);
process.stdin.resume();
