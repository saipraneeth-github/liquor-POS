/**
 * bank.routes.ts — bank statement upload and reconciliation (manager+).
 *
 * GET    /bank/accounts?branchId=                       — accounts you can use
 * POST   /bank/accounts                                 — add one (scope BRANCH, or SYNDICATE for the owner)
 * PATCH  /bank/accounts/:id
 * POST   /bank/accounts/:id/statements/preview          — multipart: parse only, nothing saved (shows mapping + balance proof)
 * POST   /bank/accounts/:id/statements                  — multipart: same parse, then save and auto-match
 * GET    /bank/accounts/:id/statements
 * GET    /bank/statements/:id                           — statement + counts by status
 * GET    /bank/statements/:id/lines?status=&search=
 * GET    /bank/statements/:id/summary                   — bank reconciliation statement
 * POST   /bank/statements/:id/match                     — (re-)run auto-matching on unresolved lines
 * POST   /bank/statements/:id/accept-suggestions        — accept every high-confidence 1:1 / settlement suggestion
 * POST   /bank/statements/:id/finalize                  — mark RECONCILED when nothing is left open
 * DELETE /bank/statements/:id                           — only while nothing was posted from it
 * GET    /bank/lines/:id/candidates                     — unmatched book entries near a line
 * POST   /bank/lines/:id/accept | /match | /post | /ignore | /unmatch
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import { z } from 'zod';
import { requireRole, getUser, assertBranchAccess } from '../../middleware/auth.guard.js';
import { requirePermission } from '../permissions/permission.service.js';
import { sendError } from '../../lib/errors.js';
import { UnsupportedFileError, terminateOcr } from '../invoices/extraction/index.js';
import {
  AcceptSchema, BulkIgnoreSchema, CreateAccountSchema, CreateRuleSchema, CreateTypeSchema, UpdateTypeSchema, IgnoreSchema, LinesQuerySchema, ManualMatchSchema, PostLineSchema,
  UpdateAccountSchema, UpdateRuleSchema, UploadFieldsSchema,
  acceptSuggestion, acceptSuggestions, applyIgnoreSuggestions, createAccount, createRule, deleteRule, deleteStatement, finalizeStatement, getStatement,
  getSummary, ignoreBulk, ignoreLine, importStatement, listAccounts, createType, getLineDetail, listBookEntries, listTypes, updateType, listCandidates, listLines, listRules, listStatements, manualMatch, postLine,
  previewStatement, addDefaultCategories, runAutoMatch, unmatchLine, updateAccount, updateRule,
  type UploadFields,
} from './bank.service.js';
import { SearchSchema, searchTransactions } from './ledger-txn.service.js';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const IdParams = z.object({ id: z.string().uuid() });

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof UnsupportedFileError) return reply.code(err.statusCode).send({ error: err.message });
  return sendError(reply, err, 'Bank request failed');
}

async function readUpload(request: FastifyRequest, reply: FastifyReply): Promise<{ buffer: Buffer; filename: string; fields: UploadFields } | null> {
  if (!request.isMultipart()) {
    reply.code(415).send({ error: 'Send the statement as multipart/form-data with a "file" field' });
    return null;
  }
  let file: { buffer: Buffer; filename: string } | null = null;
  const raw: Record<string, string> = {};
  try {
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        const buffer = await part.toBuffer();
        file ??= { buffer, filename: part.filename };
      } else if (typeof part.value === 'string') {
        raw[part.fieldname] = part.value;
      }
    }
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'FST_REQ_FILE_TOO_LARGE') reply.code(413).send({ error: `File too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)` });
    else if (code === 'FST_FILES_LIMIT') reply.code(400).send({ error: 'Upload exactly one file' });
    else reply.code(400).send({ error: 'Malformed upload' });
    return null;
  }
  if (!file || file.buffer.length === 0) { reply.code(400).send({ error: 'A non-empty "file" field is required' }); return null; }
  const fields = UploadFieldsSchema.safeParse(raw);
  if (!fields.success) { reply.code(400).send({ error: 'Validation failed', details: fields.error.flatten() }); return null; }
  return { buffer: file.buffer, filename: file.filename, fields: fields.data };
}

export async function bankRoutes(app: FastifyInstance) {
  await app.register(fastifyMultipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 12, fieldSize: 4 * 1024, parts: 14 } });
  app.addHook('onClose', async () => { await terminateOcr(); });

  const manager = { preHandler: [requireRole('steward'), requirePermission('bank.reconcile')] };   // managers and above have it by default
  // Parsing a PDF is CPU-heavy: cap uploads per client in production (tests upload in bursts)
  const uploadConfig = process.env.NODE_ENV === 'production' ? { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } } : {};

  // ── Accounts ──
  app.get('/bank/accounts', manager, async (req, reply) => {
    const q = z.object({ branchId: z.string().uuid().optional() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'Invalid branchId' });
    try {
      if (q.data.branchId && !(await assertBranchAccess(getUser(req), q.data.branchId, reply))) return;
      return await listAccounts(getUser(req), q.data.branchId);
    } catch (err) { return fail(reply, err); }
  });

  app.post('/bank/accounts', manager, async (req, reply) => {
    const body = CreateAccountSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Validation failed', details: body.error.flatten() });
    const user = getUser(req);
    if (!(await assertBranchAccess(user, body.data.branchId, reply))) return;
    try { return reply.code(201).send(await createAccount(user, body.data)); } catch (err) { return fail(reply, err); }
  });

  app.patch('/bank/accounts/:id', manager, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    const body = UpdateAccountSchema.safeParse(req.body);
    if (!params.success) return reply.code(404).send({ error: 'Bank account not found' });
    if (!body.success) return reply.code(400).send({ error: 'Validation failed', details: body.error.flatten() });
    try { return await updateAccount(getUser(req), params.data.id, body.data); } catch (err) { return fail(reply, err); }
  });

  // ── Ignore rules ("ignore lines like this") ──
  app.get('/bank/accounts/:id/rules', manager, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Bank account not found' });
    try { return await listRules(getUser(req), params.data.id); } catch (err) { return fail(reply, err); }
  });

  app.post('/bank/accounts/:id/rules', manager, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    const body = CreateRuleSchema.safeParse(req.body);
    if (!params.success) return reply.code(404).send({ error: 'Bank account not found' });
    if (!body.success) return reply.code(400).send({ error: 'Validation failed', details: body.error.flatten() });
    try { return reply.code(201).send(await createRule(getUser(req), params.data.id, body.data)); } catch (err) { return fail(reply, err); }
  });

  app.patch('/bank/rules/:id', manager, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    const body = UpdateRuleSchema.safeParse(req.body);
    if (!params.success) return reply.code(404).send({ error: 'Rule not found' });
    if (!body.success) return reply.code(400).send({ error: 'Validation failed', details: body.error.flatten() });
    try { return await updateRule(getUser(req), params.data.id, body.data); } catch (err) { return fail(reply, err); }
  });

  app.delete('/bank/rules/:id', manager, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Rule not found' });
    try { return await deleteRule(getUser(req), params.data.id); } catch (err) { return fail(reply, err); }
  });

  // ── Statements ──
  app.post('/bank/accounts/:id/statements/preview', { ...manager, ...uploadConfig }, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Bank account not found' });
    const upload = await readUpload(req, reply);
    if (!upload) return;
    try { return await previewStatement(getUser(req), params.data.id, upload.buffer, upload.fields); } catch (err) { return fail(reply, err); }
  });

  app.post('/bank/accounts/:id/statements', { ...manager, ...uploadConfig }, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Bank account not found' });
    const upload = await readUpload(req, reply);
    if (!upload) return;
    try { return reply.code(201).send(await importStatement(getUser(req), params.data.id, upload.buffer, upload.fields, upload.filename)); }
    catch (err) { return fail(reply, err); }
  });

  app.get('/bank/accounts/:id/statements', manager, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Bank account not found' });
    try { return await listStatements(getUser(req), params.data.id); } catch (err) { return fail(reply, err); }
  });

  app.get('/bank/statements/:id', manager, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Statement not found' });
    try { return await getStatement(getUser(req), params.data.id); } catch (err) { return fail(reply, err); }
  });

  app.get('/bank/statements/:id/lines', manager, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    const query = LinesQuerySchema.safeParse(req.query);
    if (!params.success) return reply.code(404).send({ error: 'Statement not found' });
    if (!query.success) return reply.code(400).send({ error: 'Validation failed', details: query.error.flatten() });
    try { return await listLines(getUser(req), params.data.id, query.data); } catch (err) { return fail(reply, err); }
  });

  app.get('/bank/statements/:id/book', manager, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Statement not found' });
    try { return await listBookEntries(getUser(req), params.data.id); } catch (err) { return fail(reply, err); }
  });

  app.get('/bank/statements/:id/summary', manager, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Statement not found' });
    try { return await getSummary(getUser(req), params.data.id); } catch (err) { return fail(reply, err); }
  });

  app.post('/bank/statements/:id/match', manager, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Statement not found' });
    try { return await runAutoMatch(getUser(req), params.data.id); } catch (err) { return fail(reply, err); }
  });

  app.post('/bank/statements/:id/accept-suggestions', manager, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    const body = z.object({ minConfidence: z.number().min(0).max(1).optional() }).safeParse(req.body ?? {});
    if (!params.success) return reply.code(404).send({ error: 'Statement not found' });
    if (!body.success) return reply.code(400).send({ error: 'Validation failed' });
    try { return await acceptSuggestions(getUser(req), params.data.id, body.data.minConfidence); } catch (err) { return fail(reply, err); }
  });

  app.post('/bank/statements/:id/ignore', manager, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    const body = BulkIgnoreSchema.safeParse(req.body);
    if (!params.success) return reply.code(404).send({ error: 'Statement not found' });
    if (!body.success) return reply.code(400).send({ error: 'Validation failed', details: body.error.flatten() });
    try { return await ignoreBulk(getUser(req), params.data.id, body.data); } catch (err) { return fail(reply, err); }
  });

  app.post('/bank/statements/:id/apply-ignore-suggestions', manager, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Statement not found' });
    try { return await applyIgnoreSuggestions(getUser(req), params.data.id); } catch (err) { return fail(reply, err); }
  });

  app.post('/bank/statements/:id/finalize', manager, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Statement not found' });
    try { return await finalizeStatement(getUser(req), params.data.id); } catch (err) { return fail(reply, err); }
  });

  app.delete('/bank/statements/:id', manager, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Statement not found' });
    try { return await deleteStatement(getUser(req), params.data.id); } catch (err) { return fail(reply, err); }
  });

  // ── Lines ──
  app.get('/bank/lines/:id/candidates', manager, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Statement line not found' });
    try { return await listCandidates(getUser(req), params.data.id); } catch (err) { return fail(reply, err); }
  });

  // ── Customer-defined transaction types ──
  app.get('/bank/accounts/:id/types', manager, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Bank account not found' });
    try { return await listTypes(getUser(req), params.data.id); } catch (err) { return fail(reply, err); }
  });

  app.post('/bank/accounts/:id/types', manager, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    const body = CreateTypeSchema.safeParse(req.body);
    if (!params.success) return reply.code(404).send({ error: 'Bank account not found' });
    if (!body.success) return reply.code(400).send({ error: 'Validation failed', details: body.error.flatten() });
    try { return reply.code(201).send(await createType(getUser(req), params.data.id, body.data)); } catch (err) { return fail(reply, err); }
  });

  app.post('/bank/accounts/:id/types/defaults', manager, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Bank account not found' });
    try { return await addDefaultCategories(getUser(req), params.data.id); } catch (err) { return fail(reply, err); }
  });

  // ── Recorded transactions: search by category or keyword, with totals ──
  app.get('/bank/transactions/:branchId', manager, async (req, reply) => {
    const params = z.object({ branchId: z.string().uuid() }).safeParse(req.params);
    const query = SearchSchema.safeParse(req.query);
    if (!params.success) return reply.code(404).send({ error: 'Branch not found' });
    if (!query.success) return reply.code(400).send({ error: 'Validation failed', details: query.error.flatten() });
    try { return await searchTransactions(getUser(req), params.data.branchId, query.data); } catch (err) { return fail(reply, err); }
  });

  app.patch('/bank/types/:id', manager, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    const body = UpdateTypeSchema.safeParse(req.body);
    if (!params.success) return reply.code(404).send({ error: 'Transaction type not found' });
    if (!body.success) return reply.code(400).send({ error: 'Validation failed' });
    try { return await updateType(getUser(req), params.data.id, body.data); } catch (err) { return fail(reply, err); }
  });

  app.get('/bank/lines/:id/detail', manager, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Statement line not found' });
    try { return await getLineDetail(getUser(req), params.data.id); } catch (err) { return fail(reply, err); }
  });

  app.post('/bank/lines/:id/accept', manager, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    const body = AcceptSchema.safeParse(req.body ?? {});
    if (!params.success) return reply.code(404).send({ error: 'Statement line not found' });
    if (!body.success) return reply.code(400).send({ error: 'Validation failed' });
    try { return await acceptSuggestion(getUser(req), params.data.id, body.data); } catch (err) { return fail(reply, err); }
  });

  app.post('/bank/lines/:id/match', manager, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    const body = ManualMatchSchema.safeParse(req.body);
    if (!params.success) return reply.code(404).send({ error: 'Statement line not found' });
    if (!body.success) return reply.code(400).send({ error: 'Validation failed', details: body.error.flatten() });
    try { return await manualMatch(getUser(req), params.data.id, body.data); } catch (err) { return fail(reply, err); }
  });

  app.post('/bank/lines/:id/post', manager, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    const body = PostLineSchema.safeParse(req.body);
    if (!params.success) return reply.code(404).send({ error: 'Statement line not found' });
    if (!body.success) return reply.code(400).send({ error: 'Validation failed', details: body.error.flatten() });
    try { return reply.code(201).send(await postLine(getUser(req), params.data.id, body.data)); } catch (err) { return fail(reply, err); }
  });

  app.post('/bank/lines/:id/ignore', manager, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    const body = IgnoreSchema.safeParse(req.body ?? {});
    if (!params.success) return reply.code(404).send({ error: 'Statement line not found' });
    if (!body.success) return reply.code(400).send({ error: 'Validation failed' });
    try { return await ignoreLine(getUser(req), params.data.id, body.data); } catch (err) { return fail(reply, err); }
  });

  app.post('/bank/lines/:id/unmatch', manager, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Statement line not found' });
    try { return await unmatchLine(getUser(req), params.data.id); } catch (err) { return fail(reply, err); }
  });
}
