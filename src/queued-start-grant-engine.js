/** A queued gate whose claim lapsed while it waited still starts for the seat that queued it [C7,H16]. */
import { unassignedEngine } from './engine-next.js';
export const QUEUED_START_GRANT_ENGINE = unassignedEngine();
