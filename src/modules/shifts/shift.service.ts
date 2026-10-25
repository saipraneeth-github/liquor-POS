import { z } from 'zod';
import { and, desc, eq, gte, lt } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { bills, shiftSessions, terminals, users } from '../../db/schema.js';
import type { Tx } from '../../lib/domain-events.js';
import { BusinessRuleError, ConflictError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { businessDayBounds, isIsoDate } from '../../lib/business-day.js';
import { canAccessBranch, roleRank, ROLE_RANK } from '../../middleware/auth.guard.js';
import type { JwtPayload } from '../auth/auth.service.js';
import {
  NOTE_VALUES,
  countDenominations,
  computeShiftSummary,
  computeDiscrepancy,
  type ShiftSummary,
} from './shift.engine.js';

// ─── SCHEMAS ─────────────────────────────────────────────────────────────────

// numeric(12,2): at most 10 integer digits, so oversized amounts are a 400, not a DB overflow
const MONEY = z.string().regex(/^\d{1,9}(\.\d{1,2})?$/, 'must be a non-negative amount below 1,000,000,000 with at most 2 decimals');
const COUNT = z.number().int().min(0).max(1_000_000);

export const OpenShiftSchema = z.object({
  terminalId:   z.string().uuid(),
  openingFloat: z.union([MONEY, z.number().nonnegative()]).transform(String).pipe(MONEY),
});

export const DenominationsSchema = z.object({
  ...Object.fromEntries(NOTE_VALUES.map((v) => [v, COUNT.optional()])) as Record<(typeof NOTE_VALUES)[number], z.ZodOptional<typeof COUNT>>,
  coins: z.union([MONEY, z.number().nonnegative()]).transform(String).pipe(MONEY).optional(),
}).strict();

export const CloseShiftSchema = z.object({
  denominations: DenominationsSchema,
  notes:         z.string().trim().max(1000).optional(),
});

export const ListShiftsQuerySchema = z.object({
  branchId: z.string().uuid().optional(),
  date:     z.string().refine(isIsoDate, 'date must be YYYY-MM-DD').optional(),
  status:   z.enum(['OPEN', 'CLOSED']).optional(),
});

export type OpenShiftInput = z.infer<typeof OpenShiftSchema>;
export type CloseShiftInput = z.infer<typeof CloseShiftSchema>;
export type ListShiftsQuery = z.infer<typeof ListShiftsQuerySchema>;
export type ShiftRow = typeof shiftSessions.$inferSelect;

// ─── HELPERS ─────────────────────────────────────────────────────────────────

async function shiftBills(shiftId: string, tx: Tx | typeof db = db) {
  return tx
    .select({ status: bills.status, paymentMode: bills.paymentMode, total: bills.total })
    .from(bills)
    .where(eq(bills.shiftSessionId, shiftId));
}

export async function getShift(id: string): Promise<ShiftRow | undefined> {
  const [row] = await db.select().from(shiftSessions).where(eq(shiftSessions.id, id)).limit(1);
  return row;
}

// ─── OPEN ────────────────────────────────────────────────────────────────────

/**
 * Opens a shift on a terminal. One OPEN shift per cashier and per terminal, enforced by
 * locking the cashier row and the terminal row (always in that order) before checking.
 */
export async function openShift(user: JwtPayload, input: OpenShiftInput): Promise<ShiftRow> {
  const [terminal] = await db.select().from(terminals).where(eq(terminals.id, input.terminalId)).limit(1);
  if (!terminal) throw new NotFoundError('Terminal not found');
  if (!(await canAccessBranch(user, terminal.branchId))) {
    throw new ForbiddenError('Forbidden: cross-branch access denied');
  }

  return db.transaction(async (tx) => {
    const [me] = await tx.select({ id: users.id, isActive: users.isActive }).from(users)
      .where(eq(users.id, user.sub)).for('update');
    if (!me || !me.isActive) throw new ForbiddenError('User is inactive');

    const [term] = await tx.select().from(terminals).where(eq(terminals.id, input.terminalId)).for('update');
    if (!term) throw new NotFoundError('Terminal not found');
    if (!term.isActive) throw new BusinessRuleError('Terminal is inactive');

    const [mine] = await tx.select({ id: shiftSessions.id }).from(shiftSessions)
      .where(and(eq(shiftSessions.cashierId, user.sub), eq(shiftSessions.status, 'OPEN'))).limit(1);
    if (mine) throw new ConflictError('You already have an open shift');

    const [onTerminal] = await tx.select({ id: shiftSessions.id }).from(shiftSessions)
      .where(and(eq(shiftSessions.terminalId, term.id), eq(shiftSessions.status, 'OPEN'))).limit(1);
    if (onTerminal) throw new ConflictError('Terminal already has an open shift');

    const [row] = await tx.insert(shiftSessions).values({
      branchId:     term.branchId,
      terminalId:   term.id,
      cashierId:    user.sub,
      status:       'OPEN',
      openingFloat: input.openingFloat,
    }).returning();
    return row;
  });
}

// ─── CURRENT ─────────────────────────────────────────────────────────────────

export async function getCurrentShift(user: JwtPayload): Promise<(ShiftRow & { terminalName: string; summary: ShiftSummary }) | null> {
  const [row] = await db
    .select({ shift: shiftSessions, terminalName: terminals.terminalName })
    .from(shiftSessions)
    .innerJoin(terminals, eq(terminals.id, shiftSessions.terminalId))
    .where(and(eq(shiftSessions.cashierId, user.sub), eq(shiftSessions.status, 'OPEN')))
    .orderBy(desc(shiftSessions.openedAt))
    .limit(1);
  if (!row) return null;
  const summary = computeShiftSummary(row.shift.openingFloat, await shiftBills(row.shift.id));
  return { ...row.shift, terminalName: row.terminalName, summary };
}

// ─── CLOSE ───────────────────────────────────────────────────────────────────

/** Owner of the shift, or a manager+ with access to the shift's branch. */
export async function canManageShift(user: JwtPayload, shift: ShiftRow): Promise<boolean> {
  if (shift.cashierId === user.sub) return true;
  return roleRank(user.role) >= ROLE_RANK.manager && (await canAccessBranch(user, shift.branchId));
}

export async function closeShift(user: JwtPayload, id: string, input: CloseShiftInput): Promise<ShiftRow & { summary: ShiftSummary }> {
  const existing = await getShift(id);
  if (!existing) throw new NotFoundError('Shift not found');
  if (!(await canManageShift(user, existing))) throw new ForbiddenError('Forbidden: not your shift');

  const countedCash = countDenominations(input.denominations);

  return db.transaction(async (tx) => {
    const [shift] = await tx.select().from(shiftSessions).where(eq(shiftSessions.id, id)).for('update');
    if (!shift) throw new NotFoundError('Shift not found');
    if (shift.status !== 'OPEN') throw new ConflictError('Shift is already closed');

    const summary = computeShiftSummary(shift.openingFloat, await shiftBills(id, tx));
    const discrepancy = computeDiscrepancy(countedCash, summary.expectedCash);

    const [closed] = await tx.update(shiftSessions).set({
      status:          'CLOSED',
      closedAt:        new Date(),
      cashCollected:   summary.cashCollected,
      cardCollected:   summary.cardCollected,
      upiCollected:    summary.upiCollected,
      creditCollected: summary.creditCollected,
      expectedCash:    summary.expectedCash,
      countedCash,
      denominations:   input.denominations,
      discrepancy,
      notes:           input.notes ?? null,
    }).where(and(eq(shiftSessions.id, id), eq(shiftSessions.status, 'OPEN'))).returning();
    if (!closed) throw new ConflictError('Shift is already closed');
    return { ...closed, summary };
  });
}

// ─── LIST ────────────────────────────────────────────────────────────────────

export async function listShifts(branchId: string, query: ListShiftsQuery) {
  const conditions = [eq(shiftSessions.branchId, branchId)];
  if (query.status) conditions.push(eq(shiftSessions.status, query.status));
  if (query.date) {
    const { start, end } = businessDayBounds(query.date);
    conditions.push(gte(shiftSessions.openedAt, start), lt(shiftSessions.openedAt, end));
  }
  const rows = await db
    .select({ shift: shiftSessions, terminalName: terminals.terminalName, cashierName: users.name })
    .from(shiftSessions)
    .innerJoin(terminals, eq(terminals.id, shiftSessions.terminalId))
    .innerJoin(users, eq(users.id, shiftSessions.cashierId))
    .where(and(...conditions))
    .orderBy(desc(shiftSessions.openedAt));
  return rows.map((r) => ({ ...r.shift, terminalName: r.terminalName, cashierName: r.cashierName }));
}
