import type { FastifyReply } from 'fastify';

// ─── TYPED APPLICATION ERRORS ────────────────────────────────────────────────
//
// Services throw these; routes map them to HTTP status codes with sendError().
// Plain `Error`s thrown by engines are treated as business-rule violations (422).

export class AppError extends Error {
  constructor(public readonly statusCode: number, message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'AppError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found', details?: unknown) { super(404, message, details); }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden', details?: unknown) { super(403, message, details); }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict', details?: unknown) { super(409, message, details); }
}

export class BusinessRuleError extends AppError {
  constructor(message: string, details?: unknown) { super(422, message, details); }
}

/** True when `err` is a Postgres unique-violation (SQLSTATE 23505) from either driver. */
export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code === '23505' || e.cause?.code === '23505';
}

/** True when `err` is a Postgres foreign-key violation (SQLSTATE 23503). */
export function isForeignKeyViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code === '23503' || e.cause?.code === '23503';
}

/** True when `err` carries a Postgres SQLSTATE (any driver) — i.e. it came from the database, not business logic. */
function isDatabaseError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  const code = typeof e.code === 'string' ? e.code : typeof e.cause?.code === 'string' ? e.cause.code : undefined;
  return code !== undefined && /^[0-9A-Z]{5}$/.test(code);
}

/**
 * Maps an error thrown by a service to an HTTP response.
 * AppError → its status; unique violation → 409; FK violation → 422; other database error → 500
 * (logged, message hidden); other Error → 422 (engines throw plain Errors for business rules).
 */
export function sendError(reply: FastifyReply, err: unknown, fallback = 'Request failed') {
  if (err instanceof AppError) {
    return reply.code(err.statusCode).send({ error: err.message, ...(err.details !== undefined ? { details: err.details } : {}) });
  }
  if (isUniqueViolation(err)) {
    return reply.code(409).send({ error: 'Duplicate record' });
  }
  if (isForeignKeyViolation(err)) {
    return reply.code(422).send({ error: 'Referenced record does not exist' });
  }
  if (isDatabaseError(err)) {
    reply.log.error({ err }, 'Unhandled database error');
    return reply.code(500).send({ error: 'Internal server error' });
  }
  const msg = err instanceof Error ? err.message : fallback;
  return reply.code(422).send({ error: msg || fallback });
}
