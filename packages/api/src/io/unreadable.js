import { Refused } from '../../../kernel/index.js';

/** When each board read failure was last logged, so a runner polling every few seconds logs it once a minute. */
const logged = new Map();

/**
 * The refusal for a board id no readable registered board carries. Each board that failed to read is logged with its
 * code, message and the asked id, and named in the refusal: the asked board may be the unreadable one (#6158).
 * Why: the 12 Nov runner stall answered only NO_BOARD while every read of the served board threw.
 *
 * @param {string} id the board id asked for
 * @param {{ root: string, error: any }[]} failures the registered boards whose read threw
 * @param {number} [now]
 * @returns {Refused}
 */
export function missingBoard(id, failures, now = Date.now()) {
  if (!failures.length) return new Refused('NO_BOARD', `no registered board ${id}; run pullboard serve in its repo and use GET /api/v1/boards`);
  const named = failures.map(({ root, error }) => {
    const code = error?.code ?? error?.name ?? 'Error';
    const message = error?.message ?? String(error);
    logReadFailure(`board read failed for board ${id} at ${root}: ${code} ${message}`, error?.stack, now);
    return `${root}: ${code} ${message}`;
  });
  return new Refused('BOARD_UNAVAILABLE', `board ${id} is not among the readable boards, and ${failures.length} registered board(s) could not be read (${named.join('; ')})`,
    'read the error in the board API log, fix it, then restart pullboard serve');
}

/** Write one read failure to the API's log, at most once a minute for the same failure. */
function logReadFailure(line, stack, now) {
  if (now - (logged.get(line) ?? -Infinity) < 60_000) return;
  logged.set(line, now);
  process.stderr.write(`pullboard: ${line}\n${stack ? stack + '\n' : ''}`);
}
