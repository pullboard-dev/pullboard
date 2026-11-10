/**
 * Frozen version gate from the published 0.9.1 engine, ac03eef74ef85e23820bc6dd9afb6735d4d65f9d.
 * Keep the released guard unchanged: importing today's engine would not test an older reader.
 * This fixture retains its version gate only; it never replays or changes board state.
 */
import { Refused } from '../../light.js';

const ENGINE_VERSION = 55;

/** Stop before interpreting actors or operations that a newer engine may have changed. */
export function requireSupportedEngine(move) {
  if (Number.isSafeInteger(move?.engine) && move.engine > ENGINE_VERSION) throw new Refused('ENGINE_VERSION', `move engine version ${move.engine} is newer than this pullboard engine version ${ENGINE_VERSION}; upgrade pullboard before applying the relay order`);
}
