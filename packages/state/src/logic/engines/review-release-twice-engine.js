import { unassignedEngine } from './engine-next.js';
/** A submitted item whose reviewers release it twice without a verdict is held for the coordinator, as two blocked builder releases are; older replays are not [C7]. */
export const REVIEW_RELEASE_TWICE_ENGINE = unassignedEngine();
