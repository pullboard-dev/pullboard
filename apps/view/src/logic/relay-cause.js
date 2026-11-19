/** Turns the relay status cause into the phone's words and the one command that fixes it, as plain data [H5,H17,N26]. */

/**
 * Map one relay-unavailable cause (the shape relayUnavailableCause returns) to what the phone shows. A network failure stays
 * "Check your connection"; sharing off and an excluded board each name their own cause and the one command that fixes it, with
 * who excluded the board and why only when they are known. A named excluded board gets the exact command that relinks just it (relay on --all --only <name>). Pure: no relay import, no I/O.
 *
 * @param {{cause?: string, machine?: string|null, by?: string|null, reason?: string|null, name?: string|null}} [cause] - The cause.
 * @returns {{message: string, command: string|null}} The message and its fix command, or null when no command helps.
 */
export function relayCauseMessage(cause = {}) {
  // Inline, not a module helper, so the page can embed this function's source on its own [C7].
  const machine = [cause?.label, cause?.machine].find((value) => typeof value === 'string' && value) ?? 'that computer';
  switch (cause?.cause) {
    case 'relay_off':
      return { message: `Sharing is off on ${machine}.`, command: 'pullboard relay on' };
    case 'excluded': {
      const who = cause.by ? ` by ${cause.by}` : '';
      const why = cause.reason && cause.reason !== 'unknown historical exclusion' ? `: ${cause.reason}` : '';
      if (typeof cause.name === 'string' && cause.name) {
        const arg = /^[\w.@-]+$/u.test(cause.name) ? cause.name : `'${cause.name.replace(/'/gu, `'\\''`)}'`;
        return { message: `The board ${cause.name} is excluded from sharing${who}${why}.`, command: `pullboard relay on --all --only ${arg}` };
      }
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

/**
 * The line the page's startup shows when the relay client fails to load. A failure carrying a relayCause of relay_off or excluded
 * says that cause and its one fix command; any other failure keeps its message and "Check your connection". Self-contained
 * (the formatter is passed in) so the page embeds it as source [C7,#9457].
 *
 * @param {Error & {relayCause?: {cause?: string}}} error - The failure from loading the transport.
 * @param {(cause: object) => {message: string, command: string|null}} format - relayCauseMessage.
 * @returns {string} The startup line.
 */
export function startupFailureLine(error, format) {
  const cause = error?.relayCause;
  if (cause && (cause.cause === 'relay_off' || cause.cause === 'excluded')) {
    const said = format(cause);
    return said.message + (said.command ? ' Run ' + said.command + ', then reload this page.' : ' Reload this page.');
  }
  return error.message + ' Check your connection, then reload this page.';
}
