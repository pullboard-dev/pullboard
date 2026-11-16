/** Turns the relay status cause into the phone's words and the one command that fixes it, as plain data [H5,H17,N26]. */

/** The name a message uses for a machine: its name when known, else "that computer". */
const nameOf = (cause) => [cause.label, cause.machine].find((value) => typeof value === 'string' && value) ?? 'that computer';

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
    case 'offline':
      return { message: `${machine[0].toUpperCase()}${machine.slice(1)} is asleep. Your boards catch up when it wakes.`, command: null };
    default:
      return { message: 'Check your connection.', command: null };
  }
}

/**
 * How the phone draws a relay status: asleep or offline is a calm note with the machine's name, not an error, and a status that is
 * fine (or gone, once the machine wakes) draws nothing, so the boards just show again as they catch up [H5,N26].
 *
 * @param {{cause?: string, machine?: string|null, label?: string|null}|null} [status] - The relay status cause, or null when fine.
 * @returns {{tone: 'asleep'|'trouble', message: string, command: string|null}|null} What to draw, or null to draw nothing.
 */
export function relayNoticeView(status = null) {
  if (!status || !status.cause) return null;
  const said = relayCauseMessage(status);
  return { tone: status.cause === 'asleep' || status.cause === 'offline' ? 'asleep' : 'trouble', ...said };
}
