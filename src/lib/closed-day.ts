import { and, eq, gte, lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { dailyClosings } from '../db/schema.js';
import type { Tx } from './domain-events.js';
import { BusinessRuleError } from './errors.js';
import { businessDateOf, businessDayBounds } from './business-day.js';

/**
 * A business day whose closing has been submitted is final: its cash, card, UPI and khata figures were counted and stored.
 * A bill rung in afterwards would never reach them. Refuse it; a manager who closed too early reopens the day first
 * (POST /closing/:id/reopen, which is audited).
 */
export async function assertBusinessDayOpen(runner: Tx | typeof db, branchId: string, businessDate: string = businessDateOf()): Promise<void> {
  const { start, end } = businessDayBounds(businessDate);
  const [closed] = await runner
    .select({ id: dailyClosings.id })
    .from(dailyClosings)
    .where(and(eq(dailyClosings.branchId, branchId), gte(dailyClosings.closingDate, start), lt(dailyClosings.closingDate, end)))
    .limit(1);
  if (closed) {
    throw new BusinessRuleError(`The day ${businessDate} is already closed for this branch, so nothing more can be recorded on it (no bills, no cash expenses). Ask an office admin or owner to reopen the day if it was closed by mistake.`);
  }
}
