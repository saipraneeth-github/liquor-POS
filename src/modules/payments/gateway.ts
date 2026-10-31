/**
 * gateway.ts — Payment gateway contract. Razorpay is the live provider; "mock" is a test gateway with the
 * same shape so the whole flow (checkout → verify → webhook → invoice paid) works before any keys exist.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { paymentConfig } from '../../config/integrations.js';

export interface CheckoutParams {
  provider: 'razorpay' | 'mock';
  keyId: string | null;          // public key id for the browser checkout (null for mock)
  orderId: string;
  amountPaise: number;
  currency: string;
}

export interface WebhookEvent {
  orderId: string;
  paymentId: string;
  paid: boolean;
}

export interface PaymentGateway {
  readonly name: 'razorpay' | 'mock';
  createOrder(input: { amountPaise: number; receipt: string; notes?: Record<string, string> }): Promise<CheckoutParams>;
  /** Signature the browser hands back after checkout. */
  verifyPayment(input: { orderId: string; paymentId: string; signature: string }): boolean;
  verifyWebhook(rawBody: string, signature: string): boolean;
  parseWebhook(body: unknown): WebhookEvent | null;
}

/** Constant-time compare of two hex strings. */
export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

export const hmacHex = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('hex');

// ─── RAZORPAY ───────────────────────────────────────────────────────────────

export class RazorpayGateway implements PaymentGateway {
  readonly name = 'razorpay' as const;

  async createOrder(input: { amountPaise: number; receipt: string; notes?: Record<string, string> }): Promise<CheckoutParams> {
    const { keyId, keySecret } = paymentConfig().razorpay;
    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64'),
      },
      body: JSON.stringify({ amount: input.amountPaise, currency: 'INR', receipt: input.receipt.slice(0, 40), notes: input.notes ?? {} }),
    });
    if (!res.ok) throw new Error(`Razorpay order failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const order = (await res.json()) as { id: string };
    return { provider: 'razorpay', keyId, orderId: order.id, amountPaise: input.amountPaise, currency: 'INR' };
  }

  // Razorpay signs "<order_id>|<payment_id>" with the key secret
  verifyPayment({ orderId, paymentId, signature }: { orderId: string; paymentId: string; signature: string }): boolean {
    return safeEqualHex(hmacHex(paymentConfig().razorpay.keySecret, `${orderId}|${paymentId}`), signature);
  }

  // Webhooks are signed over the raw request body with the webhook secret
  verifyWebhook(rawBody: string, signature: string): boolean {
    const secret = paymentConfig().razorpay.webhookSecret;
    return !!secret && safeEqualHex(hmacHex(secret, rawBody), signature);
  }

  parseWebhook(body: unknown): WebhookEvent | null {
    const b = body as { event?: string; payload?: { payment?: { entity?: { id?: string; order_id?: string; status?: string } } } };
    const p = b?.payload?.payment?.entity;
    if (!p?.order_id || !p.id) return null;
    const paid = (b.event === 'payment.captured' || b.event === 'order.paid') && (p.status === 'captured' || b.event === 'order.paid');
    return { orderId: p.order_id, paymentId: p.id, paid };
  }
}

// ─── TEST GATEWAY ───────────────────────────────────────────────────────────

export class MockGateway implements PaymentGateway {
  readonly name = 'mock' as const;

  async createOrder(input: { amountPaise: number }): Promise<CheckoutParams> {
    return { provider: 'mock', keyId: null, orderId: `mock_order_${Math.random().toString(36).slice(2, 12)}`, amountPaise: input.amountPaise, currency: 'INR' };
  }

  /** Same scheme as Razorpay, signed with the test secret. */
  sign(orderId: string, paymentId: string): string {
    return hmacHex(paymentConfig().mockSecret, `${orderId}|${paymentId}`);
  }

  verifyPayment({ orderId, paymentId, signature }: { orderId: string; paymentId: string; signature: string }): boolean {
    return safeEqualHex(this.sign(orderId, paymentId), signature);
  }

  verifyWebhook(rawBody: string, signature: string): boolean {
    return safeEqualHex(hmacHex(paymentConfig().mockSecret, rawBody), signature);
  }

  parseWebhook(body: unknown): WebhookEvent | null {
    const b = body as { orderId?: string; paymentId?: string; paid?: boolean };
    return b?.orderId && b.paymentId ? { orderId: b.orderId, paymentId: b.paymentId, paid: b.paid !== false } : null;
  }
}

export function currentGateway(): PaymentGateway {
  return paymentConfig().provider === 'razorpay' ? new RazorpayGateway() : new MockGateway();
}
