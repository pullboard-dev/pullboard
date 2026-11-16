import { unassignedEngine } from './engine-next.js';
/** An item carries a readiness command, empty until authored; older replays read no such field [#2176,H16]. */
export const READINESS_ENGINE = unassignedEngine();
