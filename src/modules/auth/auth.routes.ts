import type { FastifyInstance } from 'fastify';
import { loginUser } from '../../modules/auth/auth.service.js';

export async function authRoutes(fastify: FastifyInstance) {
  fastify.post('/auth/login', {
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
    } catch {
      reply.code(401).send({ error: 'Invalid email or password' });
    }
  });
}
