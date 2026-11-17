import { unassignedEngine } from './engine-next.js';
/** An untouched INELIGIBLE or ROUTED_ELSEWHERE release counts toward the release-twice reroute, so older boards replay without it [C7,#2970]. */
export const RELEASE_UNTOUCHED_REROUTE_ENGINE = unassignedEngine();
