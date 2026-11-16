/** Turns the relay status cause into the phone's words and the one command that fixes it, as plain data [H5,H17,N26]. */

/** The name a message uses for a machine: its name when known, else "that computer". */
const nameOf = (cause) => (typeof cause.machine === 'string' && cause.machine ? cause.machine : 'that computer');

/**
 * Map one relay-unavailable cause (the shape relayUnavailableCause returns) to what the phone shows. A network failure stays
 * "Check your connection"; sharing off and an excluded board each name their own cause and the one command that fixes it, with
 * who excluded the board and why only when they are known. Pure: no relay import, no I/O.
 *
 * @param {{cause?: string, machine?: string|null, by?: string|null, reason?: string|null, name?: string|null}} [cause] - The cause.
 * @returns {{message: string, command: string|null}} The message and its fix command, or null when no command helps.
 */
export function relayCauseMessage(cause = {}) {
  const machine = nameOf(cause ?? {});
  switch (cause?.cause) {
    case 'relay_off':
      return { message: `Sharing is off on ${machine}.`, command: 'pullboard relay on' };
    case 'excluded': {
      const who = cause.by ? ` by ${cause.by}` : '';
      const why = cause.reason && cause.reason !== 'unknown historical exclusion' ? `: ${cause.reason}` : '';
      return { message: `This board is excluded from sharing${who}${why}.`, command: 'pullboard relay on' };
    }
    case 'asleep':
      return { message: `${machine} is asleep. Your boards catch up when it wakes.`, command: null };
    default:
      return { message: 'Check your connection.', command: null };
  }
}
