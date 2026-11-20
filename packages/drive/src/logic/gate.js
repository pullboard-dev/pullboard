/** Names of the legacy gate-drive rows, which reclaim and the lapsed-job listing only end [C7]. */

/** The job kind of the drive job a submit gate runs under, kept apart from the 'gate' rows that hold hand-off records. */
export const GATE_DRIVE_KIND = 'gate-drive';

/**
 * The drive job id for one submit hand-off.
 *
 * @param {string} handoff - The hand-off job id (the gate job that holds the record).
 * @returns {string}
 */
export function gateDriveJobId(handoff) {
  return `gate-drive:${handoff}`;
}
