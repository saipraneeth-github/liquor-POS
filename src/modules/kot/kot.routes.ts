/**
 * kot.routes.ts — REST API for KOT management.
 *
 * POST /api/v1/kot                                  — create KOT for a session
 * PATCH /api/v1/kot/:kotOrderId/items/:itemId       — update item status
 * GET  /api/v1/kot/session/:sessionId               — get all KOTs for session
 * GET  /api/v1/kot/session/:sessionId/bill          — consolidated bill summary
 */

import type { FastifyInstance } from 'fastify';
import { requireRole, getUser, assertBranchAccess } from '../../middleware/auth.guard.js';
import {
  createKotOrder,
  updateKotItemStatus,
  getKotOrdersForSession,
  getConsolidatedBill,
  type CreateKotInput,
} from './kot.service.js';
import { type KotItemStatus, type ConsolidatedLineItem } from './kot.engine.js';

export async function kotRoutes(app: FastifyInstance) {
  // Create KOT
  app.post<{ Body: Omit<CreateKotInput, 'createdById'> }>(
    '/kot',
    { preHandler: [requireRole('steward')] },
    async (req, reply) => {
      const user = getUser(req);
      if (!assertBranchAccess(user, req.body.branchId, reply)) return;
      const order = await createKotOrder({
        ...req.body,
        createdById: user.sub,
      });
      return reply.status(201).send({ kotOrder: order });
    }
  );

  // Update KOT item status
  app.patch<{
    Params: { kotOrderId: string; itemId: string };
    Body: { status: KotItemStatus; branchId: string };
  }>(
    '/kot/:kotOrderId/items/:itemId',
    { preHandler: [requireRole('steward')] },
    async (req, reply) => {
      const user = getUser(req);
      if (!assertBranchAccess(user, req.body.branchId, reply)) return;
      const item = await updateKotItemStatus(
        req.params.kotOrderId,
        req.params.itemId,
        req.body.status,
        req.body.branchId
      );
      return reply.send({ kotItem: item });
    }
  );

  // Get KOTs for a session
  app.get<{ Params: { sessionId: string }; Querystring: { branchId: string } }>(
    '/kot/session/:sessionId',
    { preHandler: [requireRole('steward')] },
    async (req, reply) => {
      const user = getUser(req);
      if (!assertBranchAccess(user, req.query.branchId, reply)) return;
      const orders = await getKotOrdersForSession(req.params.sessionId, req.query.branchId);
      return reply.send({ kotOrders: orders });
    }
  );

  // Consolidated bill for a session
  app.get<{ Params: { sessionId: string }; Querystring: { branchId: string } }>(
    '/kot/session/:sessionId/bill',
    { preHandler: [requireRole('cashier')] },
    async (req, reply) => {
      const user = getUser(req);
      if (!assertBranchAccess(user, req.query.branchId, reply)) return;
      const summary = await getConsolidatedBill(req.params.sessionId, req.query.branchId);
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
    }
  );
}
