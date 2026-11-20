import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { setupIntegration, type IntegrationContext } from './helpers.js';
import { pendingMigrations } from '../../src/db/migration-status.js';

let ctx: IntegrationContext;
beforeAll(async () => { ctx = await setupIntegration(); }, 120_000);
afterAll(async () => { await ctx?.app.close(); });

describe('startup migration check', () => {
  it('a fully migrated database has nothing pending', async () => {
    expect(await pendingMigrations()).toEqual([]);
  });

  it('every journal entry has a SQL file and the journal is in order', () => {
    const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as { entries: { idx: number; tag: string; when: number }[] };
    journal.entries.forEach((e, i) => {
      expect(e.idx).toBe(i);
      expect(() => readFileSync(`drizzle/${e.tag}.sql`, 'utf8')).not.toThrow();
      if (i > 0) expect(e.when).toBeGreaterThan(journal.entries[i - 1].when);
    });
  });

  it('reports a migration as pending when the database has not recorded it', async () => {
    const { sql } = await import('drizzle-orm');
    const latest = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')).entries.at(-1);
    await ctx.db.execute(sql`delete from drizzle.__drizzle_migrations where created_at = ${latest.when}`);
    expect(await pendingMigrations()).toEqual([latest.tag]);
  });
});
