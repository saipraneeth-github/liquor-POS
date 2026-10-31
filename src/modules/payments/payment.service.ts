/**
 * payment.service.ts — Online payment of subscription invoices.
 * Start checkout → gateway order → browser pays → verify signature (and/or webhook) → invoice marked paid.
 * Settling is idempotent: the browser callback and the webhook can both arrive, only the first one counts.
 */

import { Decimal } from 'decimal.js';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { paymentOrders, subscriptionInvoices } from '../../db/schema.js';
import { BusinessRuleError, NotFoundError } from '../../lib/errors.js';
import { logAudit } from '../../lib/audit.js';
import { currentGateway, MockGateway, type CheckoutParams } from './gateway.js';
import { markInvoicePaid } from '../platform/platform.service.js';

export async function startPayment(syndicateId: string, invoiceId: string): Promise<CheckoutParams & { paymentOrderId: string; invoiceAmount: string }> {
  const [invoice] = await db.select().from(subscriptionInvoices)
    .where(and(eq(subscriptionInvoices.id, invoiceId), eq(subscriptionInvoices.syndicateId, syndicateId))).limit(1);
  if (!invoice) throw new NotFoundError('Invoice not found');
  if (invoice.status !== 'PENDING') throw new BusinessRuleError('This invoice is already settled');

  const amountPaise = new Decimal(invoice.amount).mul(100).toDecimalPlaces(0).toNumber();
  const gateway = currentGateway();
  const checkout = await gateway.createOrder({
    amountPaise,
    receipt: `inv_${invoice.id.slice(0, 8)}`,
    notes: { invoiceId: invoice.id, syndicateId },
  });

  const [order] = await db.insert(paymentOrders).values({
    syndicateId, invoiceId, provider: gateway.name, providerOrderId: checkout.orderId, amount: invoice.amount,
  }).returning();
  return { ...checkout, paymentOrderId: order.id, invoiceAmount: invoice.amount };
}

/** Marks the order and its invoice paid exactly once. Returns false when it was already settled. */
export async function settleOrder(providerOrderId: string, paymentId: string): Promise<boolean> {
  const [order] = await db.select().from(paymentOrders).where(eq(paymentOrders.providerOrderId, providerOrderId)).limit(1);
  if (!order) throw new NotFoundError('Unknown payment order');

  // The status flip is the lock: only one caller wins it
  const [won] = await db.update(paymentOrders)
    .set({ status: 'PAID', providerPaymentId: paymentId, paidAt: new Date() })
    .where(and(eq(paymentOrders.id, order.id), eq(paymentOrders.status, 'CREATED')))
    .returning();
  if (!won) return false;

  try {
    await markInvoicePaid(order.invoiceId, `${order.provider}:${paymentId}`, null);
  } catch {
    // Invoice was settled another way (e.g. the Super Admin recorded a bank transfer first): nothing more to do
  }
  await logAudit(null, 'payment.captured', { type: 'tenant', id: order.syndicateId }, { provider: order.provider, paymentId, invoiceId: order.invoiceId });
  return true;
}

/** Browser callback: verifies the gateway signature, then settles. */
export async function confirmPayment(syndicateId: string, input: { orderId: string; paymentId: string; signature: string }) {
  const [order] = await db.select().from(paymentOrders)
    .where(and(eq(paymentOrders.providerOrderId, input.orderId), eq(paymentOrders.syndicateId, syndicateId))).limit(1);
  if (!order) throw new NotFoundError('Unknown payment order');
  if (!currentGateway().verifyPayment(input)) throw new BusinessRuleError('Payment signature could not be verified');
  await settleOrder(input.orderId, input.paymentId);
  return { invoiceId: order.invoiceId, paid: true };
}

/** Test gateway only: produces the "payment" a real gateway would hand back, signed server-side. */
export async function mockPay(syndicateId: string, orderId: string) {
  const gateway = currentGateway();
  if (!(gateway instanceof MockGateway)) throw new NotFoundError('Not found');
  const [order] = await db.select().from(paymentOrders)
    .where(and(eq(paymentOrders.providerOrderId, orderId), eq(paymentOrders.syndicateId, syndicateId))).limit(1);
  if (!order) throw new NotFoundError('Unknown payment order');
  const paymentId = `mock_pay_${Math.random().toString(36).slice(2, 12)}`;
  return { orderId, paymentId, signature: gateway.sign(orderId, paymentId) };
}

/** Webhook entry point: signature already checked by the route. */
export async function handleWebhook(body: unknown): Promise<{ handled: boolean }> {
  const event = currentGateway().parseWebhook(body);
  if (!event || !event.paid) return { handled: false };
  try {
    await settleOrder(event.orderId, event.paymentId);
    return { handled: true };
  } catch (err) {
    if (err instanceof NotFoundError) return { handled: false };   // an order from another system: acknowledge, ignore
    throw err;
  }
}
