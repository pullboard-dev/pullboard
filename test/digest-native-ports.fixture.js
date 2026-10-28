import { foreignBlockers } from '../src/board.js';
/** Native read-only digest ports for private fixtures; no substitute proof or authority [C7,A2]. */
import { counterCaught } from '../src/proof-counter-read.js';
import { milestones } from '../src/board.js';
import { openBoardReadOnly } from '../src/board.js';
import { healthReport } from '../src/health.js';
import { rowDrafts } from '../src/board-query.js';
import { rowDecisions } from '../src/board-query.js';
import { automaticDecisionSource } from '../src/rigor-auto-source.js';
import { automaticSourceFromText } from '../src/rigor-auto-source.js';
import { rigorDecisionKey } from '../src/rigor-auto-source.js';
import { readAutomaticRigorSource } from '../src/rigor-auto-source.js';

export const digestNativePorts = { foreignBlockers, counterCaught, milestones, openBoardReadOnly, healthReport, rowDrafts, rowDecisions, automaticDecisionSource, automaticSourceFromText, rigorDecisionKey, readAutomaticRigorSource };
