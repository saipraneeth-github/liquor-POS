/**
 * table.routes.ts — REST API for table management.
 *
 * GET  /api/v1/tables/:branchId          — list tables with status
 * POST /api/v1/tables/:branchId          — create a table (manager+)
 * POST /api/v1/tables/:tableId/open      — open/occupy a table
 * POST /api/v1/tables/:tableId/close     — close table and end session
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, getUser, assertBranchAccess } from '../../middleware/auth.guard.js';
import { sendError } from '../../lib/errors.js';
import {
  getTablesForBranch,
  openTable,
  closeTable,
  createTable,
} from './table.service.js';

const BranchParams = z.object({ branchId: z.string().uuid() });
const TableParams  = z.object({ tableId: z.string().uuid() });

const CreateTableSchema = z.object({
  name:     z.string().trim().min(1, 'Table name is required.').max(50),
  capacity: z.number().int().min(1).max(100).optional(),
  section:  z.string().trim().max(50).optional(),
});

const OpenTableSchema = z.object({
  branchId:   z.string().uuid(),
  stewardId:  z.string().uuid().optional().nullable(),
  guestCount: z.number().int().min(1).max(100).optional(),
  notes:      z.string().max(500).optional(),
});

const CloseTableSchema = z.object({
  branchId: z.string().uuid(),
  billId:   z.string().uuid().optional(),
});

export async function tableRoutes(app: FastifyInstance) {
  // List tables (steward+: floor staff need occupied tables and session ids to raise KOTs)
  app.get('/tables/:branchId', { preHandler: [requireRole('steward')] }, async (req, reply) => {
    const params = BranchParams.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ error: 'Invalid branchId' });
    const user = getUser(req);
    if (!(await assertBranchAccess(user, params.data.branchId, reply))) return;
    const list = await getTablesForBranch(params.data.branchId);
    return reply.send({ tables: list });
  });

  // Create table
  app.post('/tables/:branchId', { preHandler: [requireRole('manager')] }, async (req, reply) => {
    const params = BranchParams.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ error: 'Invalid branchId' });
    const body = CreateTableSchema.safeParse(req.body ?? {});
    if (!body.success) {
      return reply.status(400).send({ error: body.error.issues[0]?.message ?? 'Validation failed', details: body.error.flatten() });
    }
    const user = getUser(req);
    if (!(await assertBranchAccess(user, params.data.branchId, reply))) return;
    try {
      const table = await createTable(params.data.branchId, body.data.name, body.data.capacity, body.data.section);
      return reply.status(201).send({ table });
    } catch (err) {
      return sendError(reply, err, 'Table creation failed');
    }
  });

  // Open table
  app.post('/tables/:tableId/open', { preHandler: [requireRole('cashier')] }, async (req, reply) => {
    const params = TableParams.safeParse(req.params);
    if (!params.success) return reply.status(404).send({ error: 'Table not found' });
    const body = OpenTableSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: 'Validation failed', details: body.error.flatten() });
    const user = getUser(req);
    if (!(await assertBranchAccess(user, body.data.branchId, reply))) return;
    try {
      const session = await openTable({ tableId: params.data.tableId, ...body.data });
      return reply.status(201).send({ session });
    } catch (err) {
      return sendError(reply, err, 'Open table failed');
    }
  });

  // Close table
  app.post('/tables/:tableId/close', { preHandler: [requireRole('cashier')] }, async (req, reply) => {
    const params = TableParams.safeParse(req.params);
    if (!params.success) return reply.status(404).send({ error: 'Table not found' });
    const body = CloseTableSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: 'Validation failed', details: body.error.flatten() });
    const user = getUser(req);
    if (!(await assertBranchAccess(user, body.data.branchId, reply))) return;
    try {
      const session = await closeTable(params.data.tableId, body.data.branchId, body.data.billId);
      return reply.send({ session });
    } catch (err) {
      return sendError(reply, err, 'Close table failed');
    }
  });
}
