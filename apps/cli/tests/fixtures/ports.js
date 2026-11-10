import { currentProofCounters } from '../../../../packages/verify/index.js';
import { proofCounter } from '../../../../packages/verify/index.js';
import { foreignBlockers } from '../../../../packages/store/index.js';
import { readCapacity as readCapacityWithPorts } from '../../../../packages/stats/index.js';
const readCapacity = (board, now) => readCapacityWithPorts(board, now, { currentProofCounters, proofCounter });
import { capacityLines } from '../../../../packages/stats/index.js';
/** Native read-only digest ports for private fixtures; no substitute proof or authority [C7,A2]. */
import { counterCaught } from '../../../../packages/verify/index.js';
import { milestones } from '../../../../packages/store/index.js';
import { openBoardReadOnly } from '../../../../packages/store/index.js';
import { rowDrafts } from '../../../../packages/store/index.js';
import { rowDecisions } from '../../../../packages/store/index.js';
import { automaticDecisionSource } from '../../../../packages/store/index.js';
import { automaticSourceFromText } from '../../../../packages/store/index.js';
import { rigorDecisionKey } from '../../../../packages/store/index.js';
import { readAutomaticRigorSource } from '../../../../packages/store/index.js';

export const digestNativePorts = { foreignBlockers, counterCaught, readCapacity, capacityLines, milestones, openBoardReadOnly, rowDrafts, rowDecisions, automaticDecisionSource, automaticSourceFromText, rigorDecisionKey, readAutomaticRigorSource };
