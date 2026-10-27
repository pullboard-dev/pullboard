/** Frozen coordinator releases of gone-seat claims require replay-aware readers [B3,H16]. */
import { unassignedEngine } from './engine-next.js';
export const GONE_CLAIM_ENGINE = unassignedEngine();
