import { currentProofCounters } from '../../../../../packages/verify/index.js';
import { proofCounter } from '../../../../../packages/verify/index.js';
import { foreignBlockers } from '../../../../../packages/store/index.js';
import { counterCaught } from '../../../../../packages/verify/index.js';
import { readCapacity as readCapacityWithPorts } from '../../../../../packages/stats/index.js';
const readCapacity = (board, now) => readCapacityWithPorts(board, now, { currentProofCounters, proofCounter });
import { capacityLines } from '../../../../../packages/stats/index.js';
import { milestones } from '../../../../../packages/store/index.js';
import { openBoardReadOnly } from '../../../../../packages/store/index.js';
import { rowDrafts } from '../../../../../packages/store/index.js';
import { rowDecisions } from '../../../../../packages/store/index.js';
import { automaticDecisionSource } from '../../../../../packages/store/index.js';
import { automaticSourceFromText } from '../../../../../packages/store/index.js';
import { rigorDecisionKey } from '../../../../../packages/store/index.js';
import { readAutomaticRigorSource } from '../../../../../packages/store/index.js';
/** The pullboard digest command, in its own module so an item adding another command never edits these lines. */
import {
  digestCommand,
} from '../../../../../packages/items/index.js';
import {
  context,
} from '../entry.js';
import { healthReport } from '../../../../../packages/health/index.js';
import { loadMachineSettings } from '../../../../../packages/config/index.js';
import { dispatchHealth } from '../../../../../packages/sentinels/index.js';

/** Bind the upper dispatch operation while preserving the digest reader's exact SQLite snapshot. */
function digestHealth(options) {
  return healthReport({ ...options, dispatchHealth, machineSettings: loadMachineSettings() });
}

/** Run `pullboard digest` and return its exit code. */
export function run(io, { first, second, rest, values }) {
  return digestCommand(io, { first, second, rest, values }, context(io), { foreignBlockers, counterCaught, readCapacity, capacityLines, milestones, openBoardReadOnly, healthReport: digestHealth, rowDrafts, rowDecisions, automaticDecisionSource, automaticSourceFromText, rigorDecisionKey, readAutomaticRigorSource });
}
