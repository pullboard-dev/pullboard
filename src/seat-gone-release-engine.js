import { unassignedEngine } from './engine-next.js';

/** The coordinator releases a claim at once when its holder's registered worktree folder no longer exists [C7]. */
export const SEAT_GONE_RELEASE_ENGINE = unassignedEngine();
