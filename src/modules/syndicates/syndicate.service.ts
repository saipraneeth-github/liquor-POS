import { db } from '../../db/client.js';
import { syndicates, branches, userPagePermissions } from '../../db/schema.js';
import { eq, inArray } from 'drizzle-orm';

export class SyndicateService {
  /**
   * List all syndicates.
   */
  async listSyndicates() {
    return db.select().from(syndicates);
  }

  /**
   * Get all branches for a given syndicate, including parent/child relationships.
   */
  async getSyndicateBranches(syndicateId: string) {
    return db
      .select()
      .from(branches)
      .where(eq(branches.syndicateId, syndicateId));
  }

  /**
   * Create a new syndicate.
   */
  async createSyndicate(data: { name: string; gstin?: string; pan?: string; contactPhone?: string }) {
    const result = await db.insert(syndicates).values(data).returning();
    return result[0];
  }
}
