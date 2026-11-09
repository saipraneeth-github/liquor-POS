/**
 * user.engine.ts — Pure user-management permission rules. No DB calls.
 */

import type { UserRole } from '../auth/auth.service.js';

const RANK: Record<UserRole, number> = { steward: 1, cashier: 2, manager: 3, office_admin: 4, owner: 5 };

function rank(role: string): number {
  return RANK[role as UserRole] ?? 0;
}

/**
 * Which roles an actor may grant (on create or role change).
 *   owner        → any role
 *   office_admin → manager, cashier, steward   (runs the business for the owner, but cannot create another office admin or an owner)
 *   manager      → cashier, steward            (an office admin has owner-level power, so a manager cannot create one)
 *   others       → none
 */
export function assignableRoles(actorRole: string): UserRole[] {
  if (actorRole === 'owner') return ['owner', 'manager', 'office_admin', 'cashier', 'steward'];
  if (actorRole === 'office_admin') return ['manager', 'cashier', 'steward'];
  if (actorRole === 'manager') return ['cashier', 'steward'];
  return [];
}

export function assertCanAssignRole(actorRole: string, targetRole: string): void {
  if (!assignableRoles(actorRole).includes(targetRole as UserRole)) {
    throw new Error(`Role ${actorRole} cannot assign role ${targetRole}`);
  }
}

/**
 * Whether an actor may modify another user's account (role / status / pages).
 * Owners may manage anyone in scope (scope checked separately); everyone else only
 * users strictly below their own rank. Nobody manages themselves through this path.
 */
export function canManageUser(
  actor: { id: string; role: string },
  target: { id: string; role: string },
): boolean {
  if (actor.id === target.id) return false;
  if (actor.role === 'owner') return true;
  return rank(target.role) < rank(actor.role);
}

export interface UserPatch {
  name?: string;
  role?: string;
  isActive?: boolean;
}

/**
 * Validates a PATCH against the rules; throws with a descriptive message on violation.
 * Self-service is limited to changing one's own name.
 */
export function assertUserPatchAllowed(
  actor: { id: string; role: string },
  target: { id: string; role: string; branchId: string | null },
  patch: UserPatch,
): void {
  const isSelf = actor.id === target.id;
  if (isSelf) {
    if (patch.role !== undefined && patch.role !== target.role) throw new Error('You cannot change your own role');
    if (patch.isActive !== undefined) throw new Error('You cannot change your own active status');
    return;
  }
  if (!canManageUser(actor, target)) {
    throw new Error('You cannot modify a user at or above your own role');
  }
  if (patch.role !== undefined && patch.role !== target.role) {
    assertCanAssignRole(actor.role, patch.role);
    if (patch.role !== 'owner' && !target.branchId) {
      throw new Error('A branch-less owner cannot be demoted; assign a branch first');
    }
  }
}
