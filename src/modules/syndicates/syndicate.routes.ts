import { FastifyInstance } from 'fastify';
import { SyndicateService } from './syndicate.service.js';
import { pageGuard } from '../auth/page-guard.js';

export async function syndicateRoutes(fastify: FastifyInstance) {
  const service = new SyndicateService();

  fastify.get('/syndicates', async (request, reply) => {
    // Basic route fetching the syndicates (In a real scenario, this would be wrapped with pageGuard properly mapped)
    const list = await service.listSyndicates();
    return list;
  });

  fastify.post('/syndicates', async (request, reply) => {
    const data = request.body as any;
    const syndicate = await service.createSyndicate(data);
    return syndicate;
  });

  fastify.get('/syndicates/:id/branches', async (request, reply) => {
    const { id } = request.params as { id: string };
    const branches = await service.getSyndicateBranches(id);
    return branches;
  });
}
