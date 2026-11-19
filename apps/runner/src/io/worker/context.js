/** The runner worker's mutable process state, created once per loaded copy of its front door [C7]. */
import { environmentAdapter } from '../../../../../packages/env/index.js';
import { delimiter } from 'node:path';
import { dirname } from 'node:path';

/**
 * Create the state one loaded copy of the worker owns. Every step takes it as its first argument, so two
 * copies of the front door (the same file loaded under different URLs) never share a handle, timer or flag.
 */
export function createWorkerState(entryUrl) {
  const state = {
    entryUrl,
    safePath: [dirname(process.execPath), environmentAdapter().get('PATH') || '/usr/local/bin:/usr/bin:/bin'].join(delimiter),
    ownedChildren: new Map(),
    transportLost: false,
    transportDrain: null,
    signalCustodyInstalled: false,
    transportDrop: () => {},
    markTransportGone: undefined,
    transportGone: undefined,
    heartbeatTimer: null,
    workerId: 'starting',
    workSpecAccepted: false,
    rejectPendingFrame: null,
    activeDescendantTracker: null,
    sourcePreparation: null,
    recycleSource: null,
    cleanupDeadline: Infinity,
    phaseCleanupDeadline: Infinity,
    phaseCleanupTimer: null,
    cleanupTimedOut: false,
    cleanupTimer: null,
    cleanupStage: 'command exit',
    cleanupDirectory: null,
    cleanupDetails: null,
    setupPrivatePaths: new Set(),
  };
  // Settles when the transport is lost, so a write waiting on a dead stdout stops waiting (#888).
  state.transportGone = new Promise(resolveGone => { state.markTransportGone = resolveGone; });
  return state;
}
