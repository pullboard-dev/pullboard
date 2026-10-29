/** The native command prepares external work before its final ordered writer [B2,C7]. */
import * as store from './board.js';
import { requireHandoffActive } from '../packages/state/src/core/handoff-state.js';
import { requireAgentGrant } from './agent-grant.js';
import { ENGINE_VERSION } from './engine-metadata.js';

// Like the writer dispatch, each preparation belongs to its exact native operation, never the wire.
const PREPARATIONS = Object.freeze({ claim: store.prepareClaim });

/**
 * Preserve native authority before preparation and revalidate it under the actual writer lock.
 * @param {any} board
 * @param {string} operation
 * @param {any[]} args
 * @param {string|undefined} actor
 * @returns {any}
 */
export function writeBoardCommand(board, operation, args, actor) {
  requireHandoffActive(board, actor, operation, args);
  requireAgentGrant(board, { operation, args, engine: ENGINE_VERSION });
  const prepare = PREPARATIONS[operation];
  const prepared = prepare ? [args[0], prepare(board, args[0], args[1])] : args;
  return store.atomic(board, () => {
    requireHandoffActive(board, actor, operation, prepared);
    requireAgentGrant(board, { operation, args: prepared, engine: ENGINE_VERSION });
    return board.enginePorts.store[operation](board, ...prepared);
  });
}
