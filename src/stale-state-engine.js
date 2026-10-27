/** Ordered stale-state maintenance must retain its authority and observations during replay [B4,C7]. */
import { unassignedEngine } from './engine-next.js';

export const STALE_STATE_ENGINE = unassignedEngine();
