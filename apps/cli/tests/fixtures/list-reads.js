/** Count actual SQLite reads around a production CLI call, forwarding every statement to the real database [C7,#12932]. */
import { DatabaseSync } from 'node:sqlite';

/** Observe the two text-only metadata reads from the thin rendering door, leaving identity and setup reads outside this measurement. */
export async function recordListReads(work) {
  const reads = { merges: 0, agents: 0 };
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function recorded(sql, ...args) {
    const fromThinDoor = new Error().stack.includes('/apps/cli/src/io/list/thin.js:');
    if (fromThinDoor && sql.includes("event_kind IN ('reopen', 'accept', 'reject', 'merge-only-accept')")) reads.merges++;
    if (fromThinDoor && sql.includes('SELECT agent.*, model.meta_value AS agent_model')) reads.agents++;
    return prepare.call(this, sql, ...args);
  };
  try { return { result: await work(), reads }; }
  finally { DatabaseSync.prototype.prepare = prepare; }
}
