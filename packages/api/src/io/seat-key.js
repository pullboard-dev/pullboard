/**
 * Per-seat keys on the board API [P7,#10790]: a join over the API issues the new seat its own key, the board keeps only
 * its digest, and a move that names a seat with the shared board key must also carry that seat's own key.
 * Why: every runner and seat holds the one board key, so naming a seat was enough to act as it.
 */
import { createHash } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { timingSafeEqual } from 'node:crypto';
import { Refused } from '../../../kernel/index.js';
import { readBoardMeta } from '../../../store/index.js';
import { writeBoardMeta } from '../../../store/index.js';

/** The board_meta key that holds one seat's key digest. */
const PREFIX = 'seat_key:';

/** The SHA-256 digest of a key: the board never stores the key itself. */
function digest(key) {
  return createHash('sha256').update(String(key)).digest();
}

/**
 * Issue a seat its own key, replacing any it held, and return the key; only its digest is kept on the board.
 * @param {{ db: any }} board
 * @param {string} agent
 */
export function issueSeatKey(board, agent) {
  const key = randomBytes(32).toString('base64url');
  writeBoardMeta(board.db, PREFIX + agent, digest(key).toString('hex'));
  return key;
}

/**
 * The refusal for a move naming `agent` with `given` as its seat key, or null when `given` is that seat's own key.
 * A seat with no key on the board (one joined in a worktree here, or over the API before keys) is refused too.
 * @param {{ db: any }} board
 * @param {string} agent
 * @param {unknown} given
 */
export function seatKeyRefusal(board, agent, given) {
  const stored = Buffer.from(String(readBoardMeta(board.db, PREFIX + agent) ?? ''), 'hex');
  if (typeof given === 'string' && given && stored.length === 32 && timingSafeEqual(digest(given), stored)) return null;
  return new Refused('SEAT_CREDENTIAL', `a move as ${agent} needs that seat's own key; the shared board key, or another seat's key, never acts as it`,
    'send the key pullboard join issued this seat as x-pullboard-seat-key; a seat with none joins again with board.url set: pullboard join <lane> --model "<model name>"');
}
