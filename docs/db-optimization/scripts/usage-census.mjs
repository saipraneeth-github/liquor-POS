import fs from 'node:fs'; import path from 'node:path';
import { ROOT } from './lib.mjs';
const root = ROOT;
const schema = fs.readFileSync(root + '/src/db/schema.ts', 'utf8');
function walk(d, o = []) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.pglite', '.pglite-e2e'].includes(f.name)) continue;
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p, o); else if (/\.(ts|tsx)$/.test(f.name)) o.push(p);
  }
  return o;
}
const files = [...walk(root + '/src'), ...walk(root + '/frontend/src')].filter(f => !f.replace(/\\/g, '/').endsWith('db/schema.ts'));
const texts = files.map(f => [f, fs.readFileSync(f, 'utf8')]);
const count = (word) => { const r = new RegExp('\\b' + word + '\\b', 'g'); let n = 0; for (const [, t] of texts) n += (t.match(r) || []).length; return n; };
const re = /export const (\w+) = pgTable\('(\w+)', \{([\s\S]*?)\n\}(?:, \(|\);)/g;
let m;
while ((m = re.exec(schema))) {
  const [, ident, tbl, body] = m;
  const cols = [...body.matchAll(/^\s{2}(\w+):\s+\w+\('(\w+)'/gm)].map(x => ({ f: x[1], c: x[2] }));
  const low = cols.map(({ f, c }) => [c, count(f)]).filter(([, n]) => n <= 2);
  console.log(`${tbl.padEnd(28)} tableRefs=${String(count(ident)).padEnd(4)} cols=${String(cols.length).padEnd(3)} ${low.length ? 'LOW: ' + low.map(([c, n]) => `${c}(${n})`).join(', ') : ''}`);
}
