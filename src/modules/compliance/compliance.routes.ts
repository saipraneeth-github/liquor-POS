/**
 * compliance.routes.ts — Excise quota, stock lifting, breakage and stock reconciliation.
 *
 * POST /api/v1/compliance/quotas/:branchId       — create excise quota (manager+)
 * GET  /api/v1/compliance/quotas/:branchId       — list quotas (manager+)
 * GET  /api/v1/compliance/lifting/:branchId      — stock lifting vs quota report (manager+)
 * POST /api/v1/compliance/breakage/:branchId     — record breakage, decrements stock (cashier+)
 * GET  /api/v1/compliance/breakage/:branchId     — breakage log with totals (manager+)
 * GET  /api/v1/compliance/stock-audit/:branchId  — stock audit trail + per-product net change (manager+)
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, getUser, assertBranchAccess } from '../../middleware/auth.guard.js';
import { sendError } from '../../lib/errors.js';
import {
  CreateQuotaSchema,
  DateRangeQuerySchema,
  BreakageSchema,
  StockAuditQuerySchema,
  createQuota,
  listQuotas,
  getLiftingReport,
  recordBreakage,
  listBreakage,
  getStockAuditReport,
} from './compliance.service.js';

const BranchParams = z.object({ branchId: z.string().uuid() });

export async function complianceRoutes(app: FastifyInstance) {
  // ─── EXCISE QUOTAS ──────────────────────────────────────────────────────────
  app.post('/compliance/quotas/:branchId', { preHandler: [requireRole('manager')] }, async (req, reply) => {
    const params = BranchParams.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ error: 'Invalid branchId' });
    const body = CreateQuotaSchema.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: 'Validation failed', details: body.error.flatten() });
    const user = getUser(req);
    if (!(await assertBranchAccess(user, params.data.branchId, reply))) return;
    try {
      const quota = await createQuota(params.data.branchId, body.data);
      return reply.status(201).send({ quota });
    } catch (err) {
      return sendError(reply, err, 'Quota creation failed');
    }
  });

  app.get('/compliance/quotas/:branchId', { preHandler: [requireRole('manager')] }, async (req, reply) => {
    const params = BranchParams.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ error: 'Invalid branchId' });
    const user = getUser(req);
    if (!(await assertBranchAccess(user, params.data.branchId, reply))) return;
    return reply.send({ quotas: await listQuotas(params.data.branchId) });
  });

  // ─── STOCK LIFTING ──────────────────────────────────────────────────────────
  app.get('/compliance/lifting/:branchId', { preHandler: [requireRole('manager')] }, async (req, reply) => {
    const params = BranchParams.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ error: 'Invalid branchId' });
    const query = DateRangeQuerySchema.safeParse(req.query ?? {});
    if (!query.success) return reply.status(400).send({ error: 'Validation failed', details: query.error.flatten() });
    const user = getUser(req);
    if (!(await assertBranchAccess(user, params.data.branchId, reply))) return;
    return reply.send(await getLiftingReport(params.data.branchId, query.data.from, query.data.to));
  });

  // ─── BREAKAGE ───────────────────────────────────────────────────────────────
  app.post('/compliance/breakage/:branchId', { preHandler: [requireRole('cashier')] }, async (req, reply) => {
    const params = BranchParams.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ error: 'Invalid branchId' });
    const body = BreakageSchema.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: 'Validation failed', details: body.error.flatten() });
    const user = getUser(req);
    if (!(await assertBranchAccess(user, params.data.branchId, reply))) return;
    try {
      const result = await recordBreakage(params.data.branchId, body.data, user);
      return reply.status(201).send(result);
    } catch (err) {
      return sendError(reply, err, 'Recording breakage failed');
    }
  });

  app.get('/compliance/breakage/:branchId', { preHandler: [requireRole('manager')] }, async (req, reply) => {
    const params = BranchParams.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ error: 'Invalid branchId' });
    const query = DateRangeQuerySchema.safeParse(req.query ?? {});
    if (!query.success) return reply.status(400).send({ error: 'Validation failed', details: query.error.flatten() });
    const user = getUser(req);
    if (!(await assertBranchAccess(user, params.data.branchId, reply))) return;
    return reply.send(await listBreakage(params.data.branchId, query.data.from, query.data.to));
  });

  // ─── STOCK RECONCILIATION ───────────────────────────────────────────────────
  app.get('/compliance/stock-audit/:branchId', { preHandler: [requireRole('manager')] }, async (req, reply) => {
    const params = BranchParams.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ error: 'Invalid branchId' });
    const query = StockAuditQuerySchema.safeParse(req.query ?? {});
    if (!query.success) return reply.status(400).send({ error: 'Validation failed', details: query.error.flatten() });
    const user = getUser(req);
    if (!(await assertBranchAccess(user, params.data.branchId, reply))) return;
    return reply.send(await getStockAuditReport(params.data.branchId, query.data));
  });
}
