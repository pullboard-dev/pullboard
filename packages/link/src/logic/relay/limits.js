/** Shared decoded payload, request-body and pairing-package limits for every relay client. */
import { PAIR_PACKAGE_BYTES } from '../../../../person/index.js';

export const SEALED_SNAPSHOT_BYTES = 64_000_000;
export const SNAPSHOT_BODY_BYTES = 90_000_000;
/** The largest stored board whose presentation relay on builds: its JSON must stay under the engine's string limit (about 512 MB). */
export const RELAY_PRESENTATION_BYTES = 400_000_000;
export { PAIR_PACKAGE_BYTES };
export const PAIR_ENVELOPE_BYTES = PAIR_PACKAGE_BYTES + 28;
export const PAIR_PACKAGE_BODY_BYTES = Math.ceil(PAIR_ENVELOPE_BYTES * 4 / 3) + 32;
export const PAIR_STORED_BYTES = PAIR_ENVELOPE_BYTES * 3;
