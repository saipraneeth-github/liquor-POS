/**
 * payment.routes.ts — Paying subscription invoices online.
 *
 * POST /api/v1/tenant/invoices/renew             — raise the next invoice (Admin)
 * POST /api/v1/tenant/plan                       — choose a paid plan; returns its invoice (Admin)
 * POST /api/v1/tenant/invoices/:id/pay-online    — start checkout for an invoice (Admin)
 * POST /api/v1/tenant/payments/verify            — browser hands back the gateway signature (Admin)
 * POST /api/v1/tenant/payments/mock-pay          — test gateway only: simulate the customer paying (Admin)
 * POST /api/v1/webhooks/razorpay                 — Razorpay server-to-server confirmation (signature checked)
 * GET  /api/v1/platform/integrations             — which integrations are live / what is still missing (Super Admin)
 * GET  /api/v1/platform/outbox                   — recent e-mails (Super Admin)
 *
 * These stay open to a tenant whose trial ended or payment is overdue, otherwise it could never pay.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { desc } from 'drizzle-orm';
import { requireRole, getUser, isPlatformOwner } from '../../middleware/auth.guard.js';
import { sendError } from '../../lib/errors.js';
import { db } from '../../db/client.js';
import { emailOutbox } from '../../db/schema.js';
import { integrationStatus } from '../../config/integrations.js';
import { currentGateway } from './gateway.js';
import { confirmPayment, handleWebhook, mockPay, startPayment } from './payment.service.js';
import { changePlanSelfService, generateInvoice } from '../platform/platform.service.js';
import { runBillingCycle } from '../platform/dunning.service.js';

const IdParams = z.object({ id: z.string().uuid() });
const PlanSchema = z.object({ plan: z.enum(['STANDARD', 'PRO']) });
const VerifySchema = z.object({ orderId: z.string().min(1), paymentId: z.string().min(1), signature: z.string().min(1) });
const MockPaySchema = z.object({ orderId: z.string().min(1) });

export async function paymentRoutes(app: FastifyInstance) {
  const admin = requireRole('owner', { allowLocked: true });

  const tenantId = (req: Parameters<typeof getUser>[0]) => getUser(req).syndicateId ?? null;

  app.post('/tenant/invoices/renew', { preHandler: admin }, async (req, reply) => {
    const id = tenantId(req);
    if (!id) return reply.code(404).send({ error: 'No business is linked to this account' });
    try {
      return reply.code(201).send(await generateInvoice(id, getUser(req).sub));
    } catch (err) {
      return sendError(reply, err, 'Could not create the invoice');
    }
  });

  app.post('/tenant/plan', { preHandler: admin }, async (req, reply) => {
    const id = tenantId(req);
    if (!id) return reply.code(404).send({ error: 'No business is linked to this account' });
    const body = PlanSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Choose Standard or Pro' });
    try {
      return await changePlanSelfService(id, body.data.plan, getUser(req).sub);
    } catch (err) {
      return sendError(reply, err, 'Could not change the plan');
    }
  });

  app.post('/tenant/invoices/:id/pay-online', { preHandler: admin }, async (req, reply) => {
    const tenant = tenantId(req);
    const params = IdParams.safeParse(req.params);
    if (!tenant || !params.success) return reply.code(404).send({ error: 'Invoice not found' });
    try {
      return await startPayment(tenant, params.data.id);
    } catch (err) {
      return sendError(reply, err, 'Could not start the payment');
    }
  });

  app.post('/tenant/payments/verify', { preHandler: admin }, async (req, reply) => {
    const tenant = tenantId(req);
    const body = VerifySchema.safeParse(req.body);
    if (!tenant) return reply.code(404).send({ error: 'No business is linked to this account' });
    if (!body.success) return reply.code(400).send({ error: 'Validation failed' });
    try {
      return await confirmPayment(tenant, body.data);
    } catch (err) {
      return sendError(reply, err, 'Payment could not be confirmed');
    }
  });

  app.post('/tenant/payments/mock-pay', { preHandler: admin }, async (req, reply) => {
    const tenant = tenantId(req);
    const body = MockPaySchema.safeParse(req.body);
    if (!tenant || !body.success) return reply.code(404).send({ error: 'Not found' });
    try {
      return await mockPay(tenant, body.data.orderId);
    } catch (err) {
      return sendError(reply, err, 'Not found');
    }
  });

  // ── Super Admin ──
  const owner = requireRole('owner');

  app.get('/platform/integrations', { preHandler: owner }, async (req, reply) => {
    if (!(await isPlatformOwner(getUser(req)))) return reply.code(403).send({ error: 'Forbidden: Super Admin only' });
    return { integrations: integrationStatus() };
  });

  app.get('/platform/outbox', { preHandler: owner }, async (req, reply) => {
    if (!(await isPlatformOwner(getUser(req)))) return reply.code(403).send({ error: 'Forbidden: Super Admin only' });
    return { emails: await db.select().from(emailOutbox).orderBy(desc(emailOutbox.createdAt)).limit(30) };
  });

  app.post('/platform/billing/run', { preHandler: owner }, async (req, reply) => {
    if (!(await isPlatformOwner(getUser(req)))) return reply.code(403).send({ error: 'Forbidden: Super Admin only' });
    return runBillingCycle();
  });
}

/**
 * Webhooks need the raw request body to check the signature, so they live in their own scope with a
 * string body parser. Always answers 200 for valid signatures (gateways retry on any other status).
 */
export async function webhookRoutes(app: FastifyInstance) {
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  app.post('/webhooks/razorpay', async (req, reply) => {
    const raw = typeof req.body === 'string' ? req.body : '';
    const signature = String(req.headers['x-razorpay-signature'] ?? '');
    const gateway = currentGateway();
    if (!signature || !gateway.verifyWebhook(raw, signature)) return reply.code(400).send({ error: 'Invalid signature' });
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return reply.code(400).send({ error: 'Invalid body' });
    }
    try {
      return await handleWebhook(parsed);
    } catch (err) {
      req.log.error(err, 'payment webhook failed');
      return reply.code(500).send({ error: 'Webhook processing failed' });   // gateway will retry
    }
  });
}
