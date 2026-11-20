/**
 * The refusal codes that mean the machinery was busy or lost, never that the work failed: a board writer or slot
 * database held by another process, a resource capacity read that threw, accepted policy that moved mid-write, a landing
 * gate stopped only by runner refusals. Every retry site reads this one set, so a code added here is retried by the
 * dispatcher drain, the worker slot pool, the landing steps and the gate's infrastructure requeue alike [C7,#3779].
 * Why one set: five lists drifted, and the dispatcher retried SLOT_DB_LOCKED but not BAD_RESOURCE_CAPACITY.
 */
export const TRANSIENT_CODES = Object.freeze(new Set([
  'BOARD_BUSY', 'SLOT_DB_LOCKED', 'BAD_RESOURCE_CAPACITY', 'LAND_RUNNER_FAULT', 'POLICY_SNAPSHOT_STALE',
]));
