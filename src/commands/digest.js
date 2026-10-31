import { currentProofCounters } from '../../packages/verify/index.js';
import { proofCounter } from '../../packages/verify/index.js';
import { foreignBlockers } from '../board.js';
import { counterCaught } from '../proof-counter-read.js';
import { readCapacity as readCapacityWithPorts } from '../../packages/stats/index.js';
const readCapacity = (board, now) => readCapacityWithPorts(board, now, { currentProofCounters, proofCounter });
import { capacityLines } from '../../packages/stats/index.js';
import { milestones } from '../board.js';
import { openBoardReadOnly } from '../board.js';
import { rowDrafts } from '../board-query.js';
import { rowDecisions } from '../board-query.js';
import { automaticDecisionSource } from '../board-rigor-auto-source.js';
import { automaticSourceFromText } from '../board-rigor-auto-source.js';
import { rigorDecisionKey } from '../board-rigor-auto-source.js';
import { readAutomaticRigorSource } from '../board-rigor-auto-source.js';
/** The pullboard digest command, in its own module so an item adding another command never edits these lines. */
import {
  digestCommand,
} from '../digest.js';
import {
  context,
} from '../cli.js';
import { healthReport } from '../../packages/health/index.js';
import { loadMachineSettings } from '../settings-read.js';
import { dispatchHealth } from '../dispatch-health.js';

/** Bind the upper dispatch operation while preserving the digest reader's exact SQLite snapshot. */
function digestHealth(options) {
  return healthReport({ ...options, dispatchHealth, machineSettings: loadMachineSettings() });
}

/** Run `pullboard digest` and return its exit code. */
export function run(io, { first, second, rest, values }) {
  return digestCommand(io, { first, second, rest, values }, context(io), { foreignBlockers, counterCaught, readCapacity, capacityLines, milestones, openBoardReadOnly, healthReport: digestHealth, rowDrafts, rowDecisions, automaticDecisionSource, automaticSourceFromText, rigorDecisionKey, readAutomaticRigorSource });
}
