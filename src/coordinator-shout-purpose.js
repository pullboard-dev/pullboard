/** Keep routine item updates out of the coordinator's decision channel [C7]. */
import { Refused } from './refused.js';

/** Require agent coordinator kinds while preserving person and coordinator messages. */
export function requireCoordinatorShoutPurpose({ from, to, kind }) {
  if (from === 'person' || from === 'coordinator' || to !== 'coordinator') return;
  if (['question', 'blocker', 'decision', 'exception', 'idea'].includes(kind)) return;
  if (kind !== undefined && kind !== 'status') throw new Refused('BAD_MESSAGE_KIND', 'use --kind question, blocker, decision, exception or idea');
  throw new Refused('COORDINATOR_STATUS_FACT',
    'record item progress and results with pullboard fact <id> note "<progress or result>"; to shout the coordinator use --kind question, blocker, decision, exception or idea');
}
