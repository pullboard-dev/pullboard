/** The reason lines `pullboard next` prints beside a claim or an idle answer: folded, counted and read from the board [N2,C7]. */
import * as store from '../../../store/index.js';
import { REVIEW_COVER_PAUSE_TAIL } from '../../../health/light.js';

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
 * The shouts and rulings that name an item, oldest first, one line each (#8787): an item message sent to it, a decision
 * asked about it, and a decision fact recorded on it. Superseded facts are left out.
 * Why: next hands out one instruction, so the seat gets what was said about the item without reading the inbox.
 *
 * @param {any} board
 * @param {number} id the item number
 * @returns {string[]}
 */
export function itemNoticeLines(board, id) {
  const thread = store.itemThread(board, id);
  const replaced = new Set(thread.map(entry => entry.supersedes).filter(Boolean));
  const lines = [];
  for (const entry of thread) {
    if (entry.type === 'move' && ['shout', 'pass', 'answer'].includes(entry.kind) && typeof entry.detail?.text === 'string') {
      lines.push(`${entry.kind === 'answer' ? 'answer' : 'shout'} from ${entry.by}: ${entry.detail.text}`);
    } else if (entry.type === 'fact' && entry.kind === 'decision' && !replaced.has(entry.id)) lines.push(`ruling by ${entry.by}: ${entry.text}`);
  }
  return lines;
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
 * One line for each hold whose owner is this seat (by id, or by its lane) and whose deadline has passed, only while
 * holds.requireOwner is on; off (default) it names nothing, so `next` is unchanged [C7,#8541].
 *
 * @param {any} board
 * @param {{ id: string, lane?: string }} me the seat running next
 * @param {boolean} requireOwner the holds.requireOwner setting as the caller read it
 * @returns {string[]}
 */
export function lapsedHoldLines(board, me, requireOwner) {
  if (requireOwner !== true) return [];
  const at = Date.parse(store.now(board));
  return store.listItems(board).filter(entry => entry.item_hold_reason).flatMap(entry => {
    const record = store.itemHoldOwner(board, entry.item_id);
    const mine = record && (record.owner === me.id || (me.lane && (record.owner === me.lane || record.owner === `lane:${me.lane}`)));
    return mine && Date.parse(record.deadline) <= at
      ? [`#${entry.item_id} hold lapsed ${record.deadline}: it is yours to lift or renew (${entry.item_hold_reason.split('\n')[0]}); pullboard hold ${entry.item_id} --off`] : [];
  });
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
