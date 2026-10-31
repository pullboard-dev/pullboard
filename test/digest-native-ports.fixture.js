import { currentProofCounters } from '../packages/verify/index.js';
import { proofCounter } from '../packages/verify/index.js';
import { foreignBlockers } from '../src/board.js';
import { readCapacity as readCapacityWithPorts } from '../packages/stats/index.js';
const readCapacity = (board, now) => readCapacityWithPorts(board, now, { currentProofCounters, proofCounter });
import { capacityLines } from '../packages/stats/index.js';
/** Native read-only digest ports for private fixtures; no substitute proof or authority [C7,A2]. */
import { counterCaught } from '../src/proof-counter-read.js';
import { milestones } from '../src/board.js';
import { openBoardReadOnly } from '../src/board.js';
import { rowDrafts } from '../src/board-query.js';
import { rowDecisions } from '../src/board-query.js';
import { automaticDecisionSource } from '../src/board-rigor-auto-source.js';
import { automaticSourceFromText } from '../src/board-rigor-auto-source.js';
import { rigorDecisionKey } from '../src/board-rigor-auto-source.js';
import { readAutomaticRigorSource } from '../src/board-rigor-auto-source.js';

export const digestNativePorts = { foreignBlockers, counterCaught, readCapacity, capacityLines, milestones, openBoardReadOnly, rowDrafts, rowDecisions, automaticDecisionSource, automaticSourceFromText, rigorDecisionKey, readAutomaticRigorSource };
