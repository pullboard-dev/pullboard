/** The reason lines `pullboard next` prints beside a claim or an idle answer: folded, counted and read from the board [N2,C7]. */
import * as store from '../../../store/index.js';
import { REVIEW_COVER_PAUSE_TAIL } from '../../../health/index.js';

/**
 * Preview governing messages without acknowledging them or changing explicit watch audiences [B7,N2].
 *
 * @param {any} board
 * @param {{ id: string }} me the seat running next
 * @returns {string[]}
 */
export function inboxReasons(board, me) {
  const count = store.unreadCount(board, me.id);
  if (!count) return [];
  return [`${count} unread ${count === 1 ? 'message' : 'messages'}; read pullboard inbox`,
    ...store.peekShouts(board, me.id, 2).map(shout => `${shout.shout_from} -> ${shout.shout_to}: ${shout.shout_text}`)];
}

/**
 * Name this seat's own items that are submitted or in their gate, so the seat knows why next offered other work.
 * Why: next skips them and a seat that saw nothing about them stopped after re-checking, with work still open [C7,#3532].
 *
 * @param {any} board
 * @param {{ id: string }} me the seat running next
 * @returns {string[]}
 */
export function ownWaitingLines(board, me) {
  return store.listItems(board).filter(entry => entry.item_owner === me.id && (entry.item_status === 'submitted' || store.awaitingGateOrReview(board, entry)))
    .map(entry => `#${entry.item_id} is waiting on its ${entry.item_status === 'submitted' ? 'reviewer' : 'gate'}; next offers other work`);
}

/**
 * Put the no-item answer first and compress a large held queue without hiding other wait reasons.
 *
 * @param {string[]} reasons
 * @returns {string[]}
 */
export function answerFirstReasons(reasons) {
  return ['no item is free', ...heldCounted(reasons)];
}

/**
 * Replace each 'is held by coordinator' line with one count line, keeping every other reason [C7,#2895].
 *
 * @param {string[]} reasons
 * @returns {string[]}
 */
export function heldCounted(reasons) {
  // The review-cover pause explains why new builds stop, so it leads every count line and is never folded away [#3741].
  const paused = reasons.filter(reason => reason.endsWith(REVIEW_COVER_PAUSE_TAIL));
  reasons = reasons.filter(reason => !reason.endsWith(REVIEW_COVER_PAUSE_TAIL));
  const held = reasons.filter(reason => /^#\d+ is held by coordinator:/u.test(reason));
  const remaining = reasons.filter(reason => !/^#\d+ is held by coordinator:/u.test(reason));
  return [...paused, ...(held.length ? [`${held.length} ${held.length === 1 ? 'item is' : 'items are'} held by coordinator`] : []), ...remaining];
}

/**
 * Keep the first few reason lines and fold the rest into one counted line naming where to read them [C7,#2895].
 * Why: a long hold or skip list pushed the claim's action off the first screen, and small models lost it.
 *
 * @param {string[]} lines
 * @param {string} more the command that lists every reason
 * @param {number} [keep]
 * @returns {string[]}
 */
export function foldedReasons(lines, more, keep = 5) {
  return lines.length <= keep ? lines : [...lines.slice(0, keep), `+${lines.length - keep} more reasons: ${more}`];
}
