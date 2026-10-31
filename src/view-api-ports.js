/** Compose the view projections required by the API at its application boundary. */
import { projectState } from './serve.js';
import { activeViewAgents } from './view-state-summary.js';
import { viewProofSummary } from './view-state-summary.js';
import { compactItemSummaries } from './view-state-summary.js';
import { viewFlowSummary } from './view-state-summary.js';

export const viewApiPorts = Object.freeze({ projectState, activeViewAgents, viewProofSummary, compactItemSummaries, viewFlowSummary });
