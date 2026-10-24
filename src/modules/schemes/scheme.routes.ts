/**
 * scheme.routes.ts — REST API for supplier scheme tracking.
 *
 * GET  /api/v1/schemes/:branchId          — list all schemes with progress
 * POST /api/v1/schemes/:branchId          — create a scheme (manager+)
 * GET  /api/v1/schemes/:branchId/alerts   — schemes near/at target threshold
 * POST /api/v1/schemes/:schemeId/purchase — record a purchase against a scheme
 */

import type { FastifyInstance } from 'fastify';
import { requireRole, getUser, assertBranchAccess } from '../../middleware/auth.guard.js';
import {
  getSchemesForBranch,
  getSchemeAlerts,
  createScheme,
  recordSchemePurchase,
  type CreateSchemeInput,
} from './scheme.service.js';

export async function schemeRoutes(app: FastifyInstance) {
  // List schemes
  app.get<{ Params: { branchId: string } }>(
    '/schemes/:branchId',
    { preHandler: [requireRole('manager')] },
    async (req, reply) => {
      const user = getUser(req);
      if (!assertBranchAccess(user, req.params.branchId, reply)) return;
      const list = await getSchemesForBranch(req.params.branchId);
      return reply.send({ schemes: list });
    }
  );

  // Create scheme
  app.post<{ Params: { branchId: string }; Body: Omit<CreateSchemeInput, 'branchId'> }>(
    '/schemes/:branchId',
    { preHandler: [requireRole('manager')] },
    async (req, reply) => {
      const user = getUser(req);
      if (!assertBranchAccess(user, req.params.branchId, reply)) return;
      const scheme = await createScheme({ ...req.body, branchId: req.params.branchId });
      return reply.status(201).send({ scheme });
    }
  );

  // Get alerts
  app.get<{ Params: { branchId: string } }>(
    '/schemes/:branchId/alerts',
    { preHandler: [requireRole('manager')] },
    async (req, reply) => {
      const user = getUser(req);
      if (!assertBranchAccess(user, req.params.branchId, reply)) return;
      const alerts = await getSchemeAlerts(req.params.branchId);
      return reply.send({ alerts });
    }
  );

  // Record purchase against scheme
  app.post<{
    Params: { schemeId: string };
    Body: { qty?: string; value?: string; referenceId?: string; notes?: string };
  }>(
    '/schemes/:schemeId/purchase',
    { preHandler: [requireRole('manager')] },
    async (req, reply) => {
      const { qty = '0', value = '0', referenceId, notes } = req.body;
      const purchase = await recordSchemePurchase(
        req.params.schemeId, qty, value, referenceId, notes
      );
      return reply.status(201).send({ purchase });
    }
  );
}
