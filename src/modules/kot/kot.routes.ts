/**
 * kot.routes.ts — REST API for KOT management.
 *
 * POST /api/v1/kot                                  — create KOT for a session
 * PATCH /api/v1/kot/:kotOrderId/items/:itemId       — update item status
 * GET  /api/v1/kot/session/:sessionId               — get all KOTs for session
 * GET  /api/v1/kot/session/:sessionId/bill          — consolidated bill summary
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, getUser, assertBranchAccess } from '../../middleware/auth.guard.js';
import { sendError } from '../../lib/errors.js';
import {
  createKotOrder,
  updateKotItemStatus,
  getKotOrdersForSession,
  getConsolidatedBill,
} from './kot.service.js';
import { type ConsolidatedLineItem } from './kot.engine.js';

// unitPrice / taxRate are intentionally NOT accepted: they come from the DB.
const CreateKotSchema = z.object({
  tableSessionId: z.string().uuid(),
  branchId:       z.string().uuid(),
  destination:    z.enum(['KITCHEN', 'BAR']).optional(),
  notes:          z.string().max(500).optional(),
  items: z.array(z.object({
    productId: z.string().uuid(),
    quantity:  z.number().int().positive().max(1000),
    notes:     z.string().max(200).optional(),
  })).min(1).max(200),
});

const UpdateItemParams = z.object({ kotOrderId: z.string().uuid(), itemId: z.string().uuid() });
const UpdateItemSchema = z.object({
  status:   z.enum(['PENDING', 'PREPARING', 'SERVED', 'CANCELLED']),
  branchId: z.string().uuid(),
});

const SessionParams = z.object({ sessionId: z.string().uuid() });
const BranchQuery   = z.object({ branchId: z.string().uuid() });

export async function kotRoutes(app: FastifyInstance) {
  // Create KOT
  app.post('/kot', { preHandler: [requireRole('steward')] }, async (req, reply) => {
    const parsed = CreateKotSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Validation failed', details: parsed.error.flatten() });
    const user = getUser(req);
    if (!(await assertBranchAccess(user, parsed.data.branchId, reply))) return;
    try {
      const order = await createKotOrder({ ...parsed.data, createdById: user.sub });
      return reply.status(201).send({ kotOrder: order });
    } catch (err) {
      return sendError(reply, err, 'KOT creation failed');
    }
  });

  // Update KOT item status
  app.patch('/kot/:kotOrderId/items/:itemId', { preHandler: [requireRole('steward')] }, async (req, reply) => {
    const params = UpdateItemParams.safeParse(req.params);
    if (!params.success) return reply.status(404).send({ error: 'KOT item not found' });
    const body = UpdateItemSchema.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: 'Validation failed', details: body.error.flatten() });
    const user = getUser(req);
    if (!(await assertBranchAccess(user, body.data.branchId, reply))) return;
    try {
      const item = await updateKotItemStatus(params.data.kotOrderId, params.data.itemId, body.data.status, body.data.branchId);
      return reply.send({ kotItem: item });
    } catch (err) {
      return sendError(reply, err, 'KOT update failed');
    }
  });

  // Get KOTs for a session
  app.get('/kot/session/:sessionId', { preHandler: [requireRole('steward')] }, async (req, reply) => {
    const params = SessionParams.safeParse(req.params);
    const query = BranchQuery.safeParse(req.query);
    if (!params.success || !query.success) return reply.status(400).send({ error: 'sessionId and branchId (uuid) are required' });
    const user = getUser(req);
    if (!(await assertBranchAccess(user, query.data.branchId, reply))) return;
    const orders = await getKotOrdersForSession(params.data.sessionId, query.data.branchId);
    return reply.send({ kotOrders: orders });
  });

  // Consolidated bill for a session
  app.get('/kot/session/:sessionId/bill', { preHandler: [requireRole('cashier')] }, async (req, reply) => {
    const params = SessionParams.safeParse(req.params);
    const query = BranchQuery.safeParse(req.query);
    if (!params.success || !query.success) return reply.status(400).send({ error: 'sessionId and branchId (uuid) are required' });
    const user = getUser(req);
    if (!(await assertBranchAccess(user, query.data.branchId, reply))) return;
    const summary = await getConsolidatedBill(params.data.sessionId, query.data.branchId);
    return reply.send({
      grandTotal:   summary.grandTotal.toFixed(2),
      totalTaxable: summary.totalTaxable.toFixed(2),
      totalTax:     summary.totalTax.toFixed(2),
      lineItems: summary.lineItems.map((l: ConsolidatedLineItem) => ({
        ...l,
        unitPrice:    l.unitPrice.toFixed(2),
        lineTotal:    l.lineTotal.toFixed(2),
        taxableValue: l.taxableValue.toFixed(2),
        taxAmount:    l.taxAmount.toFixed(2),
        taxRate:      l.taxRate.toFixed(2),
      })),
    });
  });
}
