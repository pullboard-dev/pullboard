/** Compose the view projections required by the API at its application boundary. */
import { projectState } from './serve.js';
import { activeViewAgents } from '../logic/summary/state.js';
import { viewProofSummary } from '../logic/summary/state.js';
import { compactItemSummaries } from '../logic/summary/state.js';
import { viewFlowSummary } from '../logic/summary/state.js';

export const viewApiPorts = Object.freeze({ projectState, activeViewAgents, viewProofSummary, compactItemSummaries, viewFlowSummary });
