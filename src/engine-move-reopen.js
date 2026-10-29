import { manualLandingFailureQuoted } from '../packages/state/src/core/manual-landing-failure-quoted.js';
import { Refused } from './refused.js';

/** Compute an automatic conflict return's arguments before anything is copied or sealed. */
export function prepareArgs(board, args, { ports }) { return ports.computedReturnArgs(board, args); }

/** Mark a quoted landing failure and seal a source-advance return at its origin [C7,H16]. */
export function prepareBefore(board, values, { args, ports }) {
  if (values[1] && typeof values[1] === 'object'
    && manualLandingFailureQuoted(values[1].note)) values[1].quotedLandingFailure = true;
  // Seal native stored facts at origin; replicas replay these bytes without the origin file.
  if (args[1]?.sourceAdvanceReturn !== undefined) values[1] = ports.sealSourceAdvanceReturn(board, values[0], args[1]);
}

/** Automatic conflict evidence must be the prepared receipt, never a caller's own assertion. */
export function prepareAfter(board, values, { ports }) {
  if (values[1]?.computedConflict !== undefined) {
    if (values[1].conflict !== undefined) throw new Refused('COORDINATOR_ONLY', 'automatic conflict evidence accepts no caller conflict assertion');
    ports.requirePreparedComputedConflict(board, values[0], values[1].agentId, values[1].computedConflict);
  }
}

/** Refuse missing immutable conflict objects before replay can publish any receipt or cursor. */
export function replayBefore(board, args, { ports }) {
  if (args[1]?.computedConflict !== undefined) ports.preflightComputedConflict(board, args[0], args[1].agentId, args[1].computedConflict);
}
