/**
 * table-checkout.service.ts — Turns an open table session's KOT items into a paid bill and closes the table.
 * Prices, GST, stock (including peg ml) and accounting all come from createBill, so a table bill is
 * identical to a counter bill. Idempotent: the bill's clientRef is derived from the session id.
 */

import { z } from 'zod';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { kotItems, kotOrders, tableSessions } from '../../db/schema.js';
import { BusinessRuleError, NotFoundError } from '../../lib/errors.js';
import type { JwtPayload } from '../auth/auth.service.js';
import { createBill, PAYMENT_MODES } from '../billing/billing.service.js';
import { closeTable } from './table.service.js';

export const CheckoutTableSchema = z.object({
  branchId:      z.string().uuid(),
  paymentMode:   z.enum(PAYMENT_MODES),
  discount:      z.string().regex(/^\d+(\.\d{1,2})?$/).optional().default('0'),
  roundOff:      z.boolean().optional(),
  customerId:    z.string().uuid().optional(),
  customerGstin: z.string().trim().toUpperCase().regex(/^[0-9A-Z]{15}$/, 'GSTIN must be 15 alphanumeric characters').optional(),
});
export type CheckoutTableInput = z.infer<typeof CheckoutTableSchema>;

export async function checkoutTable(tableId: string, input: CheckoutTableInput, user: JwtPayload) {
  const [session] = await db
    .select()
    .from(tableSessions)
    .where(and(
      eq(tableSessions.tableId, tableId),
      eq(tableSessions.branchId, input.branchId),
      isNull(tableSessions.closedAt),
    ))
    .limit(1);
  if (!session) throw new NotFoundError('No open session on this table');

  const orders = await db.select({ id: kotOrders.id }).from(kotOrders).where(eq(kotOrders.tableSessionId, session.id));
  const items = orders.length === 0 ? [] : await db
    .select()
    .from(kotItems)
    .where(inArray(kotItems.kotOrderId, orders.map((o) => o.id)));
  const billable = items.filter((i) => i.status !== 'CANCELLED');
  if (billable.length === 0) throw new BusinessRuleError('This table has no orders to bill');

  const { bill } = await createBill(
    {
      branchId:      input.branchId,
      paymentMode:   input.paymentMode,
      discount:      input.discount,
      roundOff:      input.roundOff,
      customerId:    input.customerId,
      customerGstin: input.customerGstin,
      clientRef:     `table-session:${session.id}`,
      items: billable.map((i) => ({
        productId: i.productId,
        ...(i.servingId ? { servingId: i.servingId } : {}),
        quantity: i.quantity,
      })),
    },
    user,
  );

  await closeTable(tableId, input.branchId, bill.id);
  return { bill, sessionId: session.id };
}
