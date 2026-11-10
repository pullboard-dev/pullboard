/** The app layer's read of a submit hand-off record from its gate job rows, joining the jobs and store cells [C7]. */
import { handoffRecord } from '../../../../../packages/store/index.js';

/**
 * The item's current submit hand-off record: the record on the latest step of its gate jobs, as the store reads it.
 * Undefined when no gate job step carries a record.
 *
 * Why here: packages/jobs imports only the kernel, so the read that needs packages/store lives in the app that may
 * import both (#3495).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} item
 * @returns {Record<string, any> | undefined}
 */
export function submitHandoffRecord(db, item) {
  return handoffRecord(db, item);
}
