// Static query-pattern census: how often each `table.column` is used inside a filter / join / sort in src/.
// Used to decide WHICH of the unindexed foreign keys are actually hot. Read-only; reads source files only.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib.mjs';

const schema = fs.readFileSync(path.join(ROOT, 'src/db/schema.ts'), 'utf8');
const idents = {}; // drizzle identifier -> table name
for (const m of schema.matchAll(/export const (\w+) = pgTable\('(\w+)'/g)) idents[m[1]] = m[2];

function walk(d, o = []) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    if (f.isDirectory()) walk(path.join(d, f.name), o);
    else if (f.name.endsWith('.ts')) o.push(path.join(d, f.name));
  }
  return o;
}
const files = walk(path.join(ROOT, 'src')).filter((f) => !f.replace(/\\/g, '/').endsWith('db/schema.ts'));
const src = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

// operator( table.col  -> a predicate / join / ordering use
const ops = '(?:eq|ne|gt|gte|lt|lte|inArray|notInArray|isNull|isNotNull|like|ilike|between|desc|asc)';
const counts = {};
for (const m of src.matchAll(new RegExp(ops + '\\(\\s*(\\w+)\\.(\\w+)', 'g'))) {
  const t = idents[m[1]]; if (!t) continue;
  const key = `${t}.${m[2]}`; counts[key] = (counts[key] || 0) + 1;
}
const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
const only = process.argv[2];
for (const [k, n] of rows) if (!only || k.startsWith(only)) console.log(String(n).padStart(4), k);
