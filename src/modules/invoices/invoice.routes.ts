import type { FastifyInstance, FastifyReply } from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import { z } from 'zod';
import { requireRole, getUser, assertBranchAccess } from '../../middleware/auth.guard.js';
import { sendError } from '../../lib/errors.js';
import { db } from '../../db/client.js';
import { isPlaceholderNumber } from './validate.engine.js';
import { NothingExtractableError, UnsupportedFileError, terminateOcr } from './extraction/index.js';
import { InvoiceInputSchema, ListQuerySchema, RejectSchema, UploadFieldsSchema } from './invoice.schemas.js';
import {
  DuplicateInvoiceError, createDraftFromUpload, createManualDraft, findLiveDuplicate, formatInvoiceDate, getInvoiceAttachment, getInvoiceBranchId,
  getInvoiceDetail, listInvoices,
} from './invoice.service.js';
import { approveInvoice, rejectInvoice, reviewInvoice, updateDraft } from './invoice-workflow.service.js';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_DOWNLOAD_TYPES = new Set([
  'application/pdf', 'image/png', 'image/jpeg', 'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const BranchParams = z.object({ branchId: z.string().uuid() });
const IdParams = z.object({ id: z.string().uuid() });

function sendInvoiceError(reply: FastifyReply, err: unknown) {
  if (err instanceof DuplicateInvoiceError) {
    return reply.code(409).send({ error: err.message, message: err.message, existingInvoiceId: err.existingInvoiceId, invoiceNumber: err.invoiceNumber });
  }
  if (err instanceof UnsupportedFileError || err instanceof NothingExtractableError) {
    return reply.code(err.statusCode).send({ error: err.message });
  }
  return sendError(reply, err, 'Invoice request failed');
}

/** RFC 6266 Content-Disposition with an ASCII fallback and a UTF-8 filename*. */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_') || 'invoice';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function invoiceRoutes(fastify: FastifyInstance) {
  // Multipart only for this plugin (encapsulated): one file ≤ 10 MB, a few small text fields
  await fastify.register(fastifyMultipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10, fieldSize: 8 * 1024, parts: 12 },
  });
  fastify.addHook('onClose', async () => { await terminateOcr(); });

  // POST /invoices/:branchId/upload — CSV / XLSX / PDF / image → DRAFT invoice (cashier+)
  fastify.post('/invoices/:branchId/upload', { preHandler: requireRole('cashier') }, async (request, reply) => {
    const params = BranchParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid branchId' });
    const user = getUser(request);
    if (!(await assertBranchAccess(user, params.data.branchId, reply))) return;
    if (!request.isMultipart()) {
      return reply.code(415).send({ error: 'Send the invoice as multipart/form-data with a "file" field' });
    }

    let file: { buffer: Buffer; filename: string } | null = null;
    const fields: Record<string, string> = {};
    try {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          const buffer = await part.toBuffer();
          file ??= { buffer, filename: part.filename };
        } else if (typeof part.value === 'string') {
          fields[part.fieldname] = part.value;
        }
      }
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: `File too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)` });
      if (code === 'FST_FILES_LIMIT') return reply.code(400).send({ error: 'Upload exactly one file' });
      if (code === 'FST_FIELDS_LIMIT' || code === 'FST_PARTS_LIMIT') return reply.code(400).send({ error: 'Too many form fields' });
      request.log.warn({ err }, 'multipart parse failed');
      return reply.code(400).send({ error: 'Malformed multipart body' });
    }
    if (!file || file.buffer.length === 0) return reply.code(400).send({ error: 'A non-empty "file" field is required' });

    const parsed = UploadFieldsSchema.safeParse(fields);
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten() });

    try {
      const result = await createDraftFromUpload({
        branchId: params.data.branchId, user, buffer: file.buffer, filename: file.filename, fields: parsed.data,
      });
      return reply.code(201).send(result);
    } catch (err) {
      return sendInvoiceError(reply, err);
    }
  });

  // POST /invoices/:branchId — manual DRAFT (cashier+)
  fastify.post('/invoices/:branchId', { preHandler: requireRole('cashier') }, async (request, reply) => {
    const params = BranchParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid branchId' });
    const user = getUser(request);
    if (!(await assertBranchAccess(user, params.data.branchId, reply))) return;
    const body = InvoiceInputSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Validation failed', details: body.error.flatten() });
    try {
      return reply.code(201).send(await createManualDraft(params.data.branchId, user, body.data));
    } catch (err) {
      return sendInvoiceError(reply, err);
    }
  });

  // GET /invoices/:branchId/check-duplicate?invoiceNumber=...&excludeId=... (cashier+)
  fastify.get('/invoices/:branchId/check-duplicate', { preHandler: requireRole('cashier') }, async (request, reply) => {
    const params = BranchParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid branchId' });
    const user = getUser(request);
    if (!(await assertBranchAccess(user, params.data.branchId, reply))) return;

    const query = z.object({
      invoiceNumber: z.string().default(''),
      excludeId: z.string().uuid().optional(),
    }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'Validation failed', details: query.error.flatten() });

    const num = query.data.invoiceNumber.trim();
    if (!num || num.length < 2 || isPlaceholderNumber(num)) {
      return reply.send({ exists: false });
    }

    const existing = await findLiveDuplicate(db, params.data.branchId, num, query.data.excludeId);
    if (!existing) {
      return reply.send({ exists: false });
    }

    const dateStr = formatInvoiceDate(existing.invoiceDate ?? existing.createdAt);
    return reply.send({
      exists: true,
      message: `Invoice number ${existing.invoiceNumber} has already been uploaded on ${dateStr}.`,
      invoice: {
        id: existing.id,
        invoiceNumber: existing.invoiceNumber,
        supplierName: existing.supplierName,
        invoiceDate: existing.invoiceDate ? existing.invoiceDate.toISOString().slice(0, 10) : null,
        createdAt: existing.createdAt?.toISOString() ?? null,
        status: existing.status,
        totalAmount: existing.totalAmount,
      },
    });
  });

  // GET /invoices/:branchId — history, newest first (cashier+)
  fastify.get('/invoices/:branchId', { preHandler: requireRole('cashier') }, async (request, reply) => {
    const params = BranchParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid branchId' });
    const user = getUser(request);
    if (!(await assertBranchAccess(user, params.data.branchId, reply))) return;
    const query = ListQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'Validation failed', details: query.error.flatten() });
    return listInvoices(params.data.branchId, query.data);
  });

  /** Resolves :id, enforces branch access; returns the id or null when a response was already sent. */
  async function authorizeInvoice(request: { params: unknown }, reply: FastifyReply, user: ReturnType<typeof getUser>): Promise<string | null> {
    const params = IdParams.safeParse(request.params);
    if (!params.success) { reply.code(400).send({ error: 'Invalid invoice id' }); return null; }
    try {
      const branchId = await getInvoiceBranchId(params.data.id);
      if (!(await assertBranchAccess(user, branchId, reply))) return null;
    } catch (err) {
      sendInvoiceError(reply, err);
      return null;
    }
    return params.data.id;
  }

  // GET /invoices/detail/:id (cashier+)
  fastify.get('/invoices/detail/:id', { preHandler: requireRole('cashier') }, async (request, reply) => {
    const id = await authorizeInvoice(request, reply, getUser(request));
    if (!id) return;
    try { return await getInvoiceDetail(id); } catch (err) { return sendInvoiceError(reply, err); }
  });

  // GET /invoices/detail/:id/file — original upload (cashier+)
  fastify.get('/invoices/detail/:id/file', { preHandler: requireRole('cashier') }, async (request, reply) => {
    const id = await authorizeInvoice(request, reply, getUser(request));
    if (!id) return;
    try {
      const file = await getInvoiceAttachment(id);
      return reply
        .header('Content-Type', ALLOWED_DOWNLOAD_TYPES.has(file.mimeType) ? file.mimeType : 'application/octet-stream')
        .header('Content-Disposition', contentDisposition(file.filename))
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header('Cache-Control', 'private, no-store')
        .send(file.data);
    } catch (err) {
      return sendInvoiceError(reply, err);
    }
  });

  // PUT /invoices/detail/:id — edit header + lines while DRAFT/REVIEWED; back to DRAFT (cashier+)
  fastify.put('/invoices/detail/:id', { preHandler: requireRole('cashier') }, async (request, reply) => {
    const user = getUser(request);
    const id = await authorizeInvoice(request, reply, user);
    if (!id) return;
    const body = InvoiceInputSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Validation failed', details: body.error.flatten() });
    try { return await updateDraft(id, user, body.data); } catch (err) { return sendInvoiceError(reply, err); }
  });

  // POST /invoices/detail/:id/review — DRAFT → REVIEWED (manager+)
  fastify.post('/invoices/detail/:id/review', { preHandler: requireRole('manager') }, async (request, reply) => {
    const user = getUser(request);
    const id = await authorizeInvoice(request, reply, user);
    if (!id) return;
    try { return await reviewInvoice(id, user); } catch (err) { return sendInvoiceError(reply, err); }
  });

  // POST /invoices/detail/:id/approve — DRAFT|REVIEWED → APPROVED; stock, prices, accounting (manager+)
  fastify.post('/invoices/detail/:id/approve', { preHandler: requireRole('manager') }, async (request, reply) => {
    const user = getUser(request);
    const id = await authorizeInvoice(request, reply, user);
    if (!id) return;
    try { return await approveInvoice(id, user); } catch (err) { return sendInvoiceError(reply, err); }
  });

  // POST /invoices/detail/:id/reject {reason} — DRAFT|REVIEWED → REJECTED (manager+)
  fastify.post('/invoices/detail/:id/reject', { preHandler: requireRole('manager') }, async (request, reply) => {
    const user = getUser(request);
    const id = await authorizeInvoice(request, reply, user);
    if (!id) return;
    const body = RejectSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Validation failed', details: body.error.flatten() });
    try { return await rejectInvoice(id, user, body.data.reason); } catch (err) { return sendInvoiceError(reply, err); }
  });
}
