/**
 * Compose the view projections required by the API at its application boundary. The API's state read takes the
 * live projection, so row ages refresh off the request path rather than walking Git history while the person waits (#8480).
 */
import { liveProjectState as projectState } from './serve.js';
import { projectSummary } from '../logic/summary/project.js';
import { activeViewAgents } from '../logic/summary/state.js';
import { viewProofSummary } from '../logic/summary/state.js';
import { compactItemSummaries } from '../logic/summary/state.js';
import { viewFlowSummary } from '../logic/summary/state.js';

export const viewApiPorts = Object.freeze({ projectState, activeViewAgents, viewProofSummary, compactItemSummaries, viewFlowSummary, projectSummary });
