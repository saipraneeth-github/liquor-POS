import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

/**
 * Raw-SQL migrations (0025, 0040, ...) create indexes, CHECKs and FKs that Drizzle cannot see unless schema.ts also
 * declares them: a later `db:generate` or `db:push` would then try to drop or duplicate them. Every named object in
 * those migrations must appear in schema.ts.
 */
describe('hand-written migration objects are mirrored in schema.ts', () => {
  const schema = readFileSync('src/db/schema.ts', 'utf8');
  const files = readdirSync('drizzle').filter((f) => /^00(25|40|44|45|46|47)_.*\.sql$/.test(f));

  for (const file of files) {
    const sql = readFileSync(`drizzle/${file}`, 'utf8');
    const names = new Set<string>();
    for (const m of sql.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/g)) names.add(m[1]);
    // names ending in _fk are Drizzle's own generated foreign-key names: schema.ts declares those by column, not by name
    for (const m of sql.matchAll(/ADD CONSTRAINT (\w+)/g)) if (!m[1].endsWith('_fk')) names.add(m[1]);
    for (const m of sql.matchAll(/add_check\('\w+',\s+'(\w+)'/g)) names.add(m[1]);

    it(`${file}: ${names.size} named objects`, () => {
      const missing = [...names].filter((n) => !schema.includes(`'${n}'`) && !schema.includes(`"${n}"`));
      expect(missing).toEqual([]);
    });
  }
});
