import { rejectedWorkReturns } from '../packages/state/index.js';
import { Refused } from './refused.js';

/** Freeze local liveness only at the authenticated sender; receivers replay this observation. */
export function prepareAfter(board, values, { ports }) {
  if (values[0]?.returnRejected === true) {
    if (values[0].agentId !== 'coordinator') throw new Refused('COORDINATOR_ONLY', 'ask the coordinator to return unattended rejects');
    rejectedWorkReturns(board, values[0].findings, ports.withSeatPresence);
  }
}
