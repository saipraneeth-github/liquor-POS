/**
 * scheme.routes.ts — REST API for supplier scheme tracking.
 *
 * GET  /api/v1/schemes/:branchId          — list all schemes with progress
 * POST /api/v1/schemes/:branchId          — create a scheme (manager+)
 * GET  /api/v1/schemes/:branchId/alerts   — schemes near/at target threshold
 * POST /api/v1/schemes/:schemeId/purchase — record a purchase against a scheme
 * POST /api/v1/schemes/:schemeId/slabs    — replace case slabs atomically
 * GET  /api/v1/schemes/:schemeId/slabs    — list case slabs
 * GET  /api/v1/schemes/:schemeId/payout   — evaluate recorded purchases against slabs
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, getUser, assertBranchAccess } from '../../middleware/auth.guard.js';
import { sendError } from '../../lib/errors.js';
import {
  getSchemesForBranch,
  getSchemeAlerts,
  getSchemeById,
  createScheme,
  recordSchemePurchase,
  getSchemeSlabs,
  replaceSchemeSlabs,
  getSchemePayout,
} from './scheme.service.js';

// numeric(12,2): at most 10 integer digits, so oversized values fail validation (400), not the DB.
const DECIMAL = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, 'must be a decimal string with up to 10 integer digits and 2dp');
const DATE = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'invalid date');

const BranchParams = z.object({ branchId: z.string().uuid() });
const SchemeParams = z.object({ schemeId: z.string().uuid() });

const CreateSchemeSchema = z.object({
  supplierName:      z.string().trim().min(1).max(200),
  schemeName:        z.string().trim().min(1).max(200),
  targetType:        z.enum(['VALUE', 'QTY']),
  targetValue:       DECIMAL.refine((v) => Number(v) > 0, 'targetValue must be positive'),
  rewardDescription: z.string().trim().min(1).max(1000),
  startDate:         DATE,
  endDate:           DATE,
  alertThresholdPct: DECIMAL.refine((v) => Number(v) <= 100, 'alertThresholdPct must be <= 100').optional(),
  notes:             z.string().max(1000).optional(),
}).refine((d) => Date.parse(d.endDate) >= Date.parse(d.startDate), {
  message: 'endDate must be on or after startDate',
  path: ['endDate'],
});

const PurchaseSchema = z.object({
  qty:         DECIMAL.optional().default('0'),
  value:       DECIMAL.optional().default('0'),
  referenceId: z.string().uuid().optional(),
  notes:       z.string().max(1000).optional(),
});

const SlabsSchema = z.object({
  slabs: z.array(z.object({
    minCases:        z.number().int().min(0).max(1_000_000),
    freeBottles:     z.number().int().min(0).max(1_000_000).optional().default(0),
    discountPerCase: DECIMAL.optional().default('0'),
  })).max(50),
}).refine((d) => new Set(d.slabs.map((s) => s.minCases)).size === d.slabs.length, {
  message: 'minCases must be unique across slabs',
  path: ['slabs'],
});

export async function schemeRoutes(app: FastifyInstance) {
  // List schemes
  app.get('/schemes/:branchId', { preHandler: [requireRole('manager')] }, async (req, reply) => {
    const params = BranchParams.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ error: 'Invalid branchId' });
    const user = getUser(req);
    if (!(await assertBranchAccess(user, params.data.branchId, reply))) return;
    const list = await getSchemesForBranch(params.data.branchId);
    return reply.send({ schemes: list });
  });

  // Create scheme
  app.post('/schemes/:branchId', { preHandler: [requireRole('manager')] }, async (req, reply) => {
    const params = BranchParams.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ error: 'Invalid branchId' });
    const body = CreateSchemeSchema.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: 'Validation failed', details: body.error.flatten() });
    const user = getUser(req);
    if (!(await assertBranchAccess(user, params.data.branchId, reply))) return;
    try {
      const scheme = await createScheme({ ...body.data, branchId: params.data.branchId });
      return reply.status(201).send({ scheme });
    } catch (err) {
      return sendError(reply, err, 'Scheme creation failed');
    }
  });

  // Get alerts
  app.get('/schemes/:branchId/alerts', { preHandler: [requireRole('manager')] }, async (req, reply) => {
    const params = BranchParams.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ error: 'Invalid branchId' });
    const user = getUser(req);
    if (!(await assertBranchAccess(user, params.data.branchId, reply))) return;
    const alerts = await getSchemeAlerts(params.data.branchId);
    return reply.send({ alerts });
  });

  // Record purchase against scheme (scheme's branch must be accessible)
  app.post('/schemes/:schemeId/purchase', { preHandler: [requireRole('manager')] }, async (req, reply) => {
    const params = SchemeParams.safeParse(req.params);
    if (!params.success) return reply.status(404).send({ error: 'Scheme not found' });
    const body = PurchaseSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: 'Validation failed', details: body.error.flatten() });

    const scheme = await getSchemeById(params.data.schemeId);
    if (!scheme) return reply.status(404).send({ error: 'Scheme not found' });
    const user = getUser(req);
    if (!(await assertBranchAccess(user, scheme.branchId, reply))) return;

    try {
      const { qty, value, referenceId, notes } = body.data;
      const purchase = await recordSchemePurchase(params.data.schemeId, qty, value, referenceId, notes);
      return reply.status(201).send({ purchase });
    } catch (err) {
      return sendError(reply, err, 'Recording purchase failed');
    }
  });

  // ─── SLABS ──────────────────────────────────────────────────────────────────

  // Replace slabs atomically
  app.post('/schemes/:schemeId/slabs', { preHandler: [requireRole('manager')] }, async (req, reply) => {
    const params = SchemeParams.safeParse(req.params);
    if (!params.success) return reply.status(404).send({ error: 'Scheme not found' });
    const body = SlabsSchema.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: 'Validation failed', details: body.error.flatten() });

    const scheme = await getSchemeById(params.data.schemeId);
    if (!scheme) return reply.status(404).send({ error: 'Scheme not found' });
    const user = getUser(req);
    if (!(await assertBranchAccess(user, scheme.branchId, reply))) return;

    try {
      const slabs = await replaceSchemeSlabs(params.data.schemeId, body.data.slabs);
      return reply.send({ slabs });
    } catch (err) {
      return sendError(reply, err, 'Saving slabs failed');
    }
  });

  // List slabs
  app.get('/schemes/:schemeId/slabs', { preHandler: [requireRole('manager')] }, async (req, reply) => {
    const params = SchemeParams.safeParse(req.params);
    if (!params.success) return reply.status(404).send({ error: 'Scheme not found' });
    const scheme = await getSchemeById(params.data.schemeId);
    if (!scheme) return reply.status(404).send({ error: 'Scheme not found' });
    const user = getUser(req);
    if (!(await assertBranchAccess(user, scheme.branchId, reply))) return;
    return reply.send({ slabs: await getSchemeSlabs(scheme.id) });
  });

  // Evaluate recorded purchases against slabs
  app.get('/schemes/:schemeId/payout', { preHandler: [requireRole('manager')] }, async (req, reply) => {
    const params = SchemeParams.safeParse(req.params);
    if (!params.success) return reply.status(404).send({ error: 'Scheme not found' });
    const scheme = await getSchemeById(params.data.schemeId);
    if (!scheme) return reply.status(404).send({ error: 'Scheme not found' });
    const user = getUser(req);
    if (!(await assertBranchAccess(user, scheme.branchId, reply))) return;
    return reply.send({ payout: await getSchemePayout(scheme) });
  });
}
