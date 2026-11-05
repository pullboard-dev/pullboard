/** A typed ledger flake files its own repair and quarantine, and backfills earlier proven rows that never got one [C7,H16]. */
import { unassignedEngine } from './engine-next.js';
export const LEDGER_QUARANTINE_ENGINE = unassignedEngine();
