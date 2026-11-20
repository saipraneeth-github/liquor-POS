import type { FastifyInstance } from 'fastify';
import {
  loginUser, SuspendedError, TooManyAttemptsError, InvalidCredentialsError, changeOwnPassword, ChangePasswordSchema,
  ForgotPasswordSchema, ResetPasswordSchema, requestPasswordReset, resetPasswordWithToken,
} from '../../modules/auth/auth.service.js';
import { requireRole, getUser } from '../../middleware/auth.guard.js';
import { db } from '../../db/client.js';
import { users } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { logAudit } from '../../lib/audit.js';

export async function authRoutes(fastify: FastifyInstance) {
  // Rate-limit login attempts in production; skip in dev/test to avoid
  // hitting the limit during parallel E2E test runs.
  const isProduction = process.env.NODE_ENV === 'production';

  fastify.post('/auth/login', {
    config: isProduction
      ? { rateLimit: { max: 5, timeWindow: '1 minute' } }
      : {},
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email:    { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 1, maxLength: 100 },
        },
      },
    },
  }, async (request, reply) => {
    const { email, password } = request.body as { email: string; password: string };
    try {
      const token = await loginUser(email, password, fastify, request.ip);
      return { token };
    } catch (err: unknown) {
      if (err instanceof SuspendedError) return reply.code(403).send({ error: err.message });
      if (err instanceof TooManyAttemptsError) {
        return reply.code(429).header('Retry-After', String(err.retryAfterSeconds)).send({ error: err.message, retryAfterSeconds: err.retryAfterSeconds });
      }
      if (err instanceof InvalidCredentialsError) {
        return reply.code(401).send({ error: 'Invalid email or password', attemptsLeft: err.attemptsLeft });
      }
      request.log.error(err, 'Database or unexpected error during login');
      return reply.code(500).send({ error: 'Authentication service temporarily unavailable. Please try again.' });
    }
  });

  // Forgot password: always answers the same way so addresses cannot be probed
  fastify.post('/auth/forgot-password', {
    config: isProduction ? { rateLimit: { max: 5, timeWindow: '1 minute' } } : {},
  }, async (request, reply) => {
    const parsed = ForgotPasswordSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Enter a valid e-mail address' });
    await requestPasswordReset(parsed.data.email).catch((err) => request.log.error(err, 'password reset request failed'));
    return { success: true, message: 'If that address has an account, a reset link is on its way.' };
  });

  fastify.post('/auth/reset-password', {
    config: isProduction ? { rateLimit: { max: 10, timeWindow: '1 minute' } } : {},
  }, async (request, reply) => {
    const parsed = ResetPasswordSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Validation failed' });
    const ok = await resetPasswordWithToken(parsed.data.token, parsed.data.newPassword);
    if (!ok) return reply.code(400).send({ error: 'This reset link is invalid or has expired. Ask for a new one.' });
    return { success: true };
  });

  // Any signed-in user changes their own password
  fastify.post('/auth/change-password', {
    config: isProduction ? { rateLimit: { max: 10, timeWindow: '1 minute' } } : {},
    preHandler: requireRole('steward'),
  }, async (request, reply) => {
    const parsed = ChangePasswordSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Validation failed', details: parsed.error.flatten() });
    const ok = await changeOwnPassword(getUser(request).sub, parsed.data.currentPassword, parsed.data.newPassword);
    if (!ok) return reply.code(400).send({ error: 'Current password is incorrect' });
    // Every other session of this account just ended; hand back a fresh token so THIS one carries on.
    const { iat: _iat, exp: _exp, ...claims } = getUser(request);
    return { success: true, token: fastify.jwt.sign(claims) };
  });

  // End a Super Admin support sign-in. The support token itself proves who is behind it (`impersonatedBy`), so the browser
  // never has to keep the Super Admin's own token while support is looking at a tenant: a fresh one is issued here, only if
  // that person is still an active platform owner.
  fastify.post('/auth/support-return', { preHandler: requireRole('owner') }, async (request, reply) => {
    const claims = getUser(request);
    if (!claims.impersonatedBy) return reply.code(400).send({ error: 'This is not a support sign-in' });
    const [sa] = await db.select().from(users).where(eq(users.id, claims.impersonatedBy)).limit(1);
    if (!sa || !sa.isActive || sa.role !== 'owner' || sa.branchId || sa.syndicateId) {
      return reply.code(403).send({ error: 'The Super Admin who started this support session can no longer sign back in. Sign in again.' });
    }
    await logAudit(sa.id, 'support.sign_out_as', { type: 'user', id: claims.sub });
    return { token: fastify.jwt.sign({ sub: sa.id, email: sa.email, role: sa.role, branchId: null, syndicateId: null }) };
  });
}
