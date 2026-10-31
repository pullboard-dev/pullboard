/** Compose the view projections required by the API at its application boundary. */
import { projectState } from './serve.js';
import { activeViewAgents, viewProofSummary, compactItemSummaries, viewFlowSummary } from './view-state-summary.js';

export const viewApiPorts = Object.freeze({ projectState, activeViewAgents, viewProofSummary, compactItemSummaries, viewFlowSummary });
