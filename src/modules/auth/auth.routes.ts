import type { FastifyInstance } from 'fastify';
import {
  loginUser, SuspendedError, changeOwnPassword, ChangePasswordSchema,
  ForgotPasswordSchema, ResetPasswordSchema, requestPasswordReset, resetPasswordWithToken,
} from '../../modules/auth/auth.service.js';
import { requireRole, getUser } from '../../middleware/auth.guard.js';

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
          password: { type: 'string', minLength: 8 },
        },
      },
    },
  }, async (request, reply) => {
    const { email, password } = request.body as { email: string; password: string };
    try {
      const token = await loginUser(email, password, fastify);
      return { token };
    } catch (err: unknown) {
      if (err instanceof SuspendedError) return reply.code(403).send({ error: err.message });
      if (err instanceof Error && err.message === 'Invalid credentials') {
        return reply.code(401).send({ error: 'Invalid email or password' });
      }
      request.log.error(err, 'Database or unexpected error during login');
      return reply.code(500).send({ error: 'Authentication service temporarily unavailable. Check database connection.' });
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
  fastify.post('/auth/change-password', { preHandler: requireRole('steward') }, async (request, reply) => {
    const parsed = ChangePasswordSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Validation failed', details: parsed.error.flatten() });
    const ok = await changeOwnPassword(getUser(request).sub, parsed.data.currentPassword, parsed.data.newPassword);
    if (!ok) return reply.code(400).send({ error: 'Current password is incorrect' });
    return { success: true };
  });
}
