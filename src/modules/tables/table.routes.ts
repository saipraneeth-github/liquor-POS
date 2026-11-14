/**
 * table.routes.ts — REST API for table management.
 *
 * GET  /api/v1/tables/:branchId          — list tables with status
 * POST /api/v1/tables/:branchId          — create a table (manager+)
 * POST /api/v1/tables/:tableId/open      — open/occupy a table
 * POST /api/v1/tables/:tableId/close     — close table and end session
 * POST /api/v1/tables/:tableId/checkout  — bill the table's KOT items, then close it (cashier+)
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, getUser, assertBranchAccess } from '../../middleware/auth.guard.js';
import { sendError } from '../../lib/errors.js';
import {
  getTablesForBranch,
  moveTable,
  mergeTables,
  openTable,
  closeTable,
  createTable,
  getTableBillsAndCollectionToday,
} from './table.service.js';
import { checkoutTable, CheckoutTableSchema } from './table-checkout.service.js';

const BranchParams = z.object({ branchId: z.string().uuid() });
const TableParams  = z.object({ tableId: z.string().uuid() });

const CreateTableSchema = z.object({
  name:     z.string().trim().min(1, 'Table name is required.').max(50).refine((s) => !/[<>]/.test(s), 'Table name must not contain < or >'),
  capacity: z.number().int().min(1).max(100).optional(),
  section:  z.string().trim().max(50).refine((s) => !/[<>]/.test(s), 'Section must not contain < or >').optional(),
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

const MoveTableSchema = z.object({ branchId: z.string().uuid(), toTableId: z.string().uuid() });
const MergeTableSchema = z.object({ branchId: z.string().uuid(), intoTableId: z.string().uuid() });

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

  // Today's table collection and bills (steward+)
  app.get('/tables/:branchId/today', { preHandler: [requireRole('steward')] }, async (req, reply) => {
    const params = BranchParams.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ error: 'Invalid branchId' });
    const query = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).safeParse(req.query);
    if (!query.success) return reply.status(400).send({ error: 'Invalid date parameter' });
    const user = getUser(req);
    if (!(await assertBranchAccess(user, params.data.branchId, reply))) return;
    try {
      const data = await getTableBillsAndCollectionToday(params.data.branchId, query.data.date);
      return reply.send(data);
    } catch (err) {
      return sendError(reply, err, 'Failed to fetch table collection and bills');
    }
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

  // Checkout: KOT items -> paid bill -> table closed
  app.post('/tables/:tableId/checkout', { preHandler: [requireRole('cashier')] }, async (req, reply) => {
    const params = TableParams.safeParse(req.params);
    if (!params.success) return reply.status(404).send({ error: 'Table not found' });
    const body = CheckoutTableSchema.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: 'Validation failed', details: body.error.flatten() });
    const user = getUser(req);
    if (!(await assertBranchAccess(user, body.data.branchId, reply))) return;
    try {
      return reply.status(201).send(await checkoutTable(params.data.tableId, body.data, user));
    } catch (err) {
      return sendError(reply, err, 'Table checkout failed');
    }
  });

  // Move a party to a free table
  app.post('/tables/:tableId/move', { preHandler: [requireRole('steward')] }, async (req, reply) => {
    const params = TableParams.safeParse(req.params);
    if (!params.success) return reply.status(404).send({ error: 'Table not found' });
    const body = MoveTableSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: 'Choose the table to move to', details: body.error.flatten() });
    const user = getUser(req);
    if (!(await assertBranchAccess(user, body.data.branchId, reply))) return;
    try {
      return await moveTable(params.data.tableId, body.data.toTableId, body.data.branchId, user.sub);
    } catch (err) {
      return sendError(reply, err, 'Move table failed');
    }
  });

  // Merge two occupied tables onto one bill
  app.post('/tables/:tableId/merge', { preHandler: [requireRole('cashier')] }, async (req, reply) => {
    const params = TableParams.safeParse(req.params);
    if (!params.success) return reply.status(404).send({ error: 'Table not found' });
    const body = MergeTableSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: 'Choose the table to merge into', details: body.error.flatten() });
    const user = getUser(req);
    if (!(await assertBranchAccess(user, body.data.branchId, reply))) return;
    try {
      return await mergeTables(params.data.tableId, body.data.intoTableId, body.data.branchId, user.sub);
    } catch (err) {
      return sendError(reply, err, 'Merge tables failed');
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
