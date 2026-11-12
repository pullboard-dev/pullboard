/** Computed-conflict evidence at the authenticated relay replay and sending boundaries [V4,H16]. */
import { createHash } from 'node:crypto';
import { withRecordedConflictContext } from '../../../../state/index.js';

/** Apply an already decrypted, engine-checked relay record inside its exact synchronous position. */
export function replay(board, move, record, apply) {
  const position = { sequence: record.event_id, at: record.event_at, sender: record.sender, kind: record.kind,
    digest: createHash('sha256').update(record.sealed).digest('hex'), registration: record.registration };
  return withRecordedConflictContext(board, move, position, () => apply(board, move, position));
}

/** Recheck a fresh computed return before opening its unchanged authenticated actor transport. */
export function transport(root, move, validateComputedConflict, open) {
  if (move.operation === 'reopen' && move.args[1]?.computedConflict !== undefined) {
    validateComputedConflict(root, move);
  }
  return open();
}
