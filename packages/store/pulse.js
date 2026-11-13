/** Pulse door: one seat heartbeat write, reaching only node: built-ins so a bare heartbeat loads no board graph [C7,#3847]. */
import { DatabaseSync } from 'node:sqlite';
import { heartbeatSeat } from './src/io/presence.js';

/**
 * Refresh `seat`'s private presence observation for the board at `file`; the board itself is opened read-only.
 *
 * @param {string} file the board database
 * @param {string} seat
 * @returns {void}
 */
export function writePulse(file, seat) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { heartbeatSeat({ db, clock: { now: () => new Date() } }, seat); } finally { db.close(); }
}
