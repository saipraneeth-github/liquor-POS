/**
 * table.engine.ts — Pure state machine for table status transitions.
 * No DB calls. All side-effects in table.service.ts.
 */

export type TableStatus = 'FREE' | 'OCCUPIED' | 'RESERVED';
export type TableAction = 'open' | 'close' | 'reserve' | 'unreserve';

// Valid transitions: from → allowed actions
const TRANSITIONS: Record<TableStatus, Partial<Record<TableAction, TableStatus>>> = {
  FREE:     { open: 'OCCUPIED', reserve: 'RESERVED' },
  OCCUPIED: { close: 'FREE' },
  RESERVED: { open: 'OCCUPIED', unreserve: 'FREE' },
};

/**
 * Returns true if the table can be opened (occupied) from its current status.
 */
export function canOpenTable(status: TableStatus): boolean {
  return status === 'FREE' || status === 'RESERVED';
}

/**
 * Returns true if the table can be closed (freed) from its current status.
 */
export function canCloseTable(status: TableStatus): boolean {
  return status === 'OCCUPIED';
}

/**
 * State-machine transition. Throws a descriptive error on illegal transitions.
 */
export function transitionTableStatus(
  current: TableStatus,
  action: TableAction
): TableStatus {
  const next = TRANSITIONS[current]?.[action];
  if (!next) {
    if (action === 'open' && current === 'OCCUPIED') {
      throw new Error(`Table is already occupied — cannot open again.`);
    }
    if (action === 'close' && current !== 'OCCUPIED') {
      throw new Error(`Table is not occupied — cannot close.`);
    }
    throw new Error(
      `Illegal table transition: ${current} → ${action}. ` +
      `Allowed actions from ${current}: ${Object.keys(TRANSITIONS[current]).join(', ') || 'none'}.`
    );
  }
  return next;
}

/**
 * Validates that a stewardId is either null (unassigned) or a non-empty string UUID.
 * Empty string is rejected as invalid.
 */
export function validateStewardAssignment(stewardId: string | null): void {
  if (stewardId === null) return;
  if (typeof stewardId !== 'string' || stewardId.trim().length === 0) {
    throw new Error(`Invalid steward ID: must be a non-empty UUID string or null.`);
  }
}
