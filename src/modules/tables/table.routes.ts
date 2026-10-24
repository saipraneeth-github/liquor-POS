/**
 * table.routes.ts — REST API for table management.
 *
 * GET  /api/v1/tables/:branchId          — list tables with status
 * POST /api/v1/tables/:branchId          — create a table (manager+)
 * POST /api/v1/tables/:tableId/open      — open/occupy a table
 * POST /api/v1/tables/:tableId/close     — close table and end session
 */

import type { FastifyInstance } from 'fastify';
import { requireRole, getUser, assertBranchAccess } from '../../middleware/auth.guard.js';
import {
  getTablesForBranch,
  openTable,
  closeTable,
  createTable,
} from './table.service.js';

export async function tableRoutes(app: FastifyInstance) {
  // List tables
  app.get<{ Params: { branchId: string } }>(
    '/tables/:branchId',
    { preHandler: [requireRole('cashier')] },
    async (req, reply) => {
      const user = getUser(req);
      if (!assertBranchAccess(user, req.params.branchId, reply)) return;
      const list = await getTablesForBranch(req.params.branchId);
      return reply.send({ tables: list });
    }
  );

  // Create table
  app.post<{ Params: { branchId: string }; Body: { name: string; capacity?: number; section?: string } }>(
    '/tables/:branchId',
    { preHandler: [requireRole('manager')] },
    async (req, reply) => {
      const user = getUser(req);
      if (!assertBranchAccess(user, req.params.branchId, reply)) return;
      const { name, capacity, section } = req.body;
      if (!name?.trim()) return reply.status(400).send({ error: 'Table name is required.' });
      const table = await createTable(req.params.branchId, name, capacity, section);
      return reply.status(201).send({ table });
    }
  );

  // Open table
  app.post<{
    Params: { tableId: string };
    Body: { branchId: string; stewardId?: string; guestCount?: number; notes?: string };
  }>(
    '/tables/:tableId/open',
    { preHandler: [requireRole('cashier')] },
    async (req, reply) => {
      const user = getUser(req);
      const { branchId, stewardId, guestCount, notes } = req.body;
      if (!assertBranchAccess(user, branchId, reply)) return;
      const session = await openTable({
        tableId: req.params.tableId,
        branchId,
        stewardId,
        guestCount,
        notes,
      });
      return reply.status(201).send({ session });
    }
  );

  // Close table
  app.post<{
    Params: { tableId: string };
    Body: { branchId: string; billId?: string };
  }>(
    '/tables/:tableId/close',
    { preHandler: [requireRole('cashier')] },
    async (req, reply) => {
      const user = getUser(req);
      const { branchId, billId } = req.body;
      if (!assertBranchAccess(user, branchId, reply)) return;
      const session = await closeTable(req.params.tableId, branchId, billId);
      return reply.send({ session });
    }
  );
}
