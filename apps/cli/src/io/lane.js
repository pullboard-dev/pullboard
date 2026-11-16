/** Keep the CLI call stable while giving the shared ownership guard the seats cell's lane port [C7,#2908]. */
import { requireOwnLaneCheck as guard } from '../../../../packages/verify/index.js';
import { laneOf } from '../../../../packages/seats/index.js';

/** Refuse a seat's check naming a test file another lane owns. */
export function requireOwnLaneCheck(config, me, lane, check) {
  return guard(config, me, lane, check, laneOf);
}
