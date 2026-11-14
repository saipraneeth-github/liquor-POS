/**
 * ledger-txn.service.ts — the searchable transactions table and the standard categories (Rent, Wages, Utilities, Supplies).
 *
 * A statement line that is posted to the books is also written here (same database transaction), with the name the user
 * gave it. Lines posted before this table existed are filled in the first time anyone searches (idempotent).
 */
import { z } from 'zod';
import { and, asc, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { Decimal } from 'decimal.js';
import { db } from '../../db/client.js';
import { accountLedgers, bankAccounts, bankStatementLines, bankTransactionTypes, ledgerTransactions } from '../../db/schema.js';
import { ForbiddenError } from '../../lib/errors.js';
import type { Tx } from '../../lib/domain-events.js';
import { canAccessBranch } from '../../middleware/auth.guard.js';
import type { JwtPayload } from '../auth/auth.service.js';
import { DEFAULT_CATEGORIES, categoryKey, categoryLabel, searchWords } from './ledger-txn.engine.js';

type Account = typeof bankAccounts.$inferSelect;
type Line = typeof bankStatementLines.$inferSelect;

const CUSTOM_PREFIX = 'CUSTOM:';

/** Write the transaction row for a line that was just posted. Call inside the posting transaction. */
export async function recordPostedLine(tx: Tx, args: { account: Account; line: Line; category: string; voucherId: string; userId: string }) {
  const { account, line, category, voucherId, userId } = args;
  const out = Number(line.debit) > 0;
  await tx.insert(ledgerTransactions).values({
    branchId: account.branchId, txnDate: line.txnDate, description: line.narration || category, amount: out ? line.debit : line.credit,
    direction: out ? 'DEBIT' : 'CREDIT', category, categoryKey: categoryKey(category), reference: line.reference ?? null,
    source: 'BANK_STATEMENT', bankLineId: line.id, voucherId, reconStatus: 'MATCHED', createdById: userId,
  }).onConflictDoNothing({ target: ledgerTransactions.bankLineId });
}

/** The label a posted line is stored under: its own type's name, or the built-in category's wording. */
export function labelForPostedLine(category: string, typeNames: Map<string, string>): string {
  if (category.startsWith(CUSTOM_PREFIX)) return typeNames.get(category.slice(CUSTOM_PREFIX.length)) ?? 'Custom type';
  return categoryLabel(category);
}

/** Fill in transactions for lines posted before the table existed. Safe to call any time. */
async function backfill(branchId: string): Promise<void> {
  const missing = await db.select({ line: bankStatementLines })
    .from(bankStatementLines)
    .innerJoin(bankAccounts, eq(bankAccounts.id, bankStatementLines.accountId))
    .where(and(
      eq(bankAccounts.branchId, branchId), eq(bankStatementLines.status, 'MATCHED'),
      sql`${bankStatementLines.voucherId} is not null`, sql`${bankStatementLines.category} is not null`,
      sql`not exists (select 1 from ledger_transactions lt where lt.bank_line_id = ${bankStatementLines.id})`,
    ));
  if (!missing.length) return;
  const types = await db.select({ id: bankTransactionTypes.id, name: bankTransactionTypes.name }).from(bankTransactionTypes)
    .innerJoin(bankAccounts, eq(bankAccounts.id, bankTransactionTypes.accountId)).where(eq(bankAccounts.branchId, branchId));
  const names = new Map(types.map((t) => [t.id, t.name]));
  await db.transaction(async (tx) => {
    for (const { line } of missing) {
      const out = Number(line.debit) > 0;
      const category = labelForPostedLine(line.category!, names);
      await tx.insert(ledgerTransactions).values({
        branchId, txnDate: line.txnDate, description: line.narration || category, amount: out ? line.debit : line.credit,
        direction: out ? 'DEBIT' : 'CREDIT', category, categoryKey: categoryKey(category), reference: line.reference ?? null,
        source: 'BANK_STATEMENT', bankLineId: line.id, voucherId: line.voucherId, reconStatus: 'MATCHED', createdById: line.resolvedById ?? null,
      }).onConflictDoNothing({ target: ledgerTransactions.bankLineId });
    }
  });
}

export const SearchSchema = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.string().trim().max(60).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  direction: z.enum(['DEBIT', 'CREDIT']).optional(),
  accountId: z.string().uuid().optional(),     // only what was recorded from this bank account's statements
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const money = (v: unknown) => new Decimal(String(v ?? 0)).toFixed(2);

/** Transactions of a branch matching a keyword and/or category and date range, with totals, plus every category's total. */
export async function searchTransactions(user: JwtPayload, branchId: string, input: z.infer<typeof SearchSchema>) {
  if (!(await canAccessBranch(user, branchId))) throw new ForbiddenError('You do not have access to this branch');
  await backfill(branchId);
  const T = ledgerTransactions;
  const base: SQL[] = [eq(T.branchId, branchId)];
  if (input.from) base.push(gte(T.txnDate, input.from));
  if (input.to) base.push(lte(T.txnDate, input.to));
  if (input.direction) base.push(eq(T.direction, input.direction));
  if (input.accountId) base.push(sql`${T.bankLineId} in (select id from bank_statement_lines where account_id = ${input.accountId})`);
  for (const w of searchWords(input.q)) {
    const like = `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    base.push(sql`(lower(${T.description}) like ${like} or ${T.categoryKey} like ${like} or lower(coalesce(${T.reference}, '')) like ${like})`);
  }
  const filtered: SQL[] = input.category ? [...base, eq(T.categoryKey, categoryKey(input.category))] : base;

  const [rows, totals, byCategory] = await Promise.all([
    db.select().from(T).where(and(...filtered)).orderBy(desc(T.txnDate), desc(T.createdAt)).limit(input.limit).offset(input.offset),
    db.select({
      count: sql<number>`count(*)::int`,
      debit: sql<string>`coalesce(sum(${T.amount}) filter (where ${T.direction} = 'DEBIT'), 0)`,
      credit: sql<string>`coalesce(sum(${T.amount}) filter (where ${T.direction} = 'CREDIT'), 0)`,
    }).from(T).where(and(...filtered)),
    // every category inside the same keyword / date range, whichever one is picked, so the totals can be compared
    db.select({
      category: sql<string>`min(${T.category})`, key: T.categoryKey,
      count: sql<number>`count(*)::int`,
      debit: sql<string>`coalesce(sum(${T.amount}) filter (where ${T.direction} = 'DEBIT'), 0)`,
      credit: sql<string>`coalesce(sum(${T.amount}) filter (where ${T.direction} = 'CREDIT'), 0)`,
    }).from(T).where(and(...base)).groupBy(T.categoryKey).orderBy(asc(T.categoryKey)),
  ]);
  const t = totals[0];
  return {
    transactions: rows,
    totals: { count: t?.count ?? 0, debit: money(t?.debit), credit: money(t?.credit), net: new Decimal(String(t?.credit ?? 0)).minus(String(t?.debit ?? 0)).toFixed(2) },
    byCategory: byCategory.map((c) => ({ category: c.category, key: c.key, count: c.count, debit: money(c.debit), credit: money(c.credit) })),
  };
}

/** Rent, Wages, Utilities and Supplies for an account: an expense ledger each, and a type that posts to it. Idempotent. */
export async function ensureDefaultCategories(user: JwtPayload, account: Account): Promise<{ created: string[] }> {
  const created: string[] = [];
  await db.transaction(async (tx) => {
    for (const name of DEFAULT_CATEGORIES) {
      const key = categoryKey(name);
      const [have] = await tx.select({ id: bankTransactionTypes.id }).from(bankTransactionTypes)
        .where(and(eq(bankTransactionTypes.accountId, account.id), eq(bankTransactionTypes.nameKey, key))).limit(1);
      if (have) continue;
      const code = `CAT_${name.toUpperCase()}`;
      await tx.insert(accountLedgers).values({ branchId: account.branchId, code, name, group: 'EXPENSE', isSystem: false }).onConflictDoNothing();
      const [ledger] = await tx.select({ id: accountLedgers.id }).from(accountLedgers)
        .where(and(eq(accountLedgers.branchId, account.branchId), eq(accountLedgers.code, code))).limit(1);
      await tx.insert(bankTransactionTypes).values({
        accountId: account.id, name, nameKey: key, direction: 'OUT', ledgerId: ledger!.id, createdById: user.sub,
      }).onConflictDoNothing();
      created.push(name);
    }
  });
  return { created };
}
