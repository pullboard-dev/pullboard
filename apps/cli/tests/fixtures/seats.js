/** Seats registered as history from before agent grants (#348), for replays of older engines [E21,H16]. */
import * as store from '../../../../packages/store/index.js';
import { AGENT_GRANT_ENGINE } from '../../../../packages/state/light.js';
import assert from 'node:assert/strict';
import { applyEngineMove } from '../../../../packages/state/index.js';
import { appliedSequence } from '../../../../packages/state/index.js';

/** Replay a real historical join/claim prefix, retaining its receipts and cursor instead of erasing modern grant markers. */
export function replayHistoricalSeatMove(board, engine, operation, args) {
  assert.ok(Number.isSafeInteger(engine) && engine > 0 && engine < AGENT_GRANT_ENGINE);
  assert.ok(['register', 'claim'].includes(operation));
  const values = [...args];
  if (operation === 'claim') {
    const options = { ...values[1] };
    const frozen = options.freeze(store.getItem(board, values[0]));
    delete options.freeze;
    values[1] = { ...options, frozen, freezeError: null };
  }
  const sequence = appliedSequence(board) + 1;
  const move = { version: 1, engine, id: `historical-${operation}-${sequence}`,
    operation, args: JSON.parse(JSON.stringify(values)) };
  const outcome = applyEngineMove(board, move, { sequence, at: board.clock.now().toISOString() });
  assert.equal(outcome.error, undefined, `historical ${operation} must reach its real operation: ${JSON.stringify(outcome.error)}`);
  assert.equal(board.executionEngineVersion, undefined, 'historical replay restores the current execution context');
  return outcome.result;
}

/**
 * Register each [lane, path, optional explicit fixture declarations] seat as an engine before AGENT_GRANT_ENGINE wrote it, and return the seat ids.
 * A seat a newer client registered rightly refuses old-engine moves, so a board that replays an older
 * client's moves must hold seats that client could have written.
 */
export function registerPreGrant(board, seats) {
  const recorded = Object.hasOwn(board, 'executionEngineVersion') ? board.executionEngineVersion : undefined;
  board.executionEngineVersion = AGENT_GRANT_ENGINE - 1;
  try { return seats.map(([lane, path, declarations = {}]) => store.register(board, { lane, path, ...declarations })); } finally {
    if (recorded === undefined) delete board.executionEngineVersion; else board.executionEngineVersion = recorded;
  }
}
