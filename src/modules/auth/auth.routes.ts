import type { FastifyInstance } from 'fastify';
import { loginUser } from '../../modules/auth/auth.service.js';

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
      if (err instanceof Error && err.message === 'Invalid credentials') {
        return reply.code(401).send({ error: 'Invalid email or password' });
      }
      request.log.error(err, 'Database or unexpected error during login');
      return reply.code(500).send({ error: 'Authentication service temporarily unavailable. Check database connection.' });
    }
  });
}
