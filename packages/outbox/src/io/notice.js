/**
 * The one Needs-you notice for uploads waiting in the outbox [C7,#9412].
 * However many moves are queued, the person sees a single notice that names the cause in plain words and the one command
 * that fixes it; it is gone when the outbox drains. The cause comes in as data (the shape relayUnavailableCause returns),
 * because this cell never imports the relay app.
 *
 * Why: ten queued moves that each said "the relay is down" would bury the one thing the person can do about it.
 */
import {
  outboxParkedOnly,
  readOutboxSummary,
} from './relay.js';

/** The notice id: one per board, so a second queued move updates it instead of adding a row. */
export const OUTBOX_NOTICE_ID = 'outbox-waiting';

const CAUSE_WORDS = {
  connection: { why: 'this computer cannot reach the relay', fix: 'pullboard relay' },
  relay_off: { why: 'the relay is turned off on that computer', fix: 'pullboard relay on' },
  excluded: { why: 'this computer was removed from the board\'s relay', fix: 'pullboard relay on' },
  asleep: { why: 'the computer the relay waits on is asleep', fix: 'pullboard relay' },
  unknown: { why: 'the relay is not answering', fix: 'pullboard relay' },
};

/** `1 upload` or `10 uploads`. */
function uploads(count) {
  return `${count} upload${count === 1 ? '' : 's'}`;
}

/**
 * The Needs-you notices for a count of waiting moves: none when nothing waits, otherwise exactly one.
 *
 * @param {{count: number, parkedOnly?: boolean, cause?: {cause?: string, fix?: string|null}|null}} waiting - Moves waiting, whether all are parked, and the cause as relayUnavailableCause names it.
 * @returns {{id: string, text: string, fix: string}[]} Zero or one notice.
 */
export function outboxNoticeRows({ count, parkedOnly = false, cause = null }) {
  if (!Number.isInteger(count) || count < 1) return [];
  if (parkedOnly) return [{ id: OUTBOX_NOTICE_ID, text: `${uploads(count)} cannot go up until you recover this board: run pullboard relay recover.`, fix: 'pullboard relay recover' }];
  const words = CAUSE_WORDS[cause?.cause] ?? CAUSE_WORDS.unknown;
  const fix = typeof cause?.fix === 'string' && /pullboard [^.]+/u.test(cause.fix) ? /pullboard [^.]+/u.exec(cause.fix)[0].trim() : words.fix;
  return [{ id: OUTBOX_NOTICE_ID, text: `${uploads(count)} waiting: ${words.why}. Fix it with ${fix}; they go up on their own once it answers.`, fix }];
}

/**
 * The notices for a board's link file, read from the key-free summary beside it: gone once the outbox drains.
 *
 * @param {string} linkFile - The board's relay link file.
 * @param {{cause?: object|null}} [options] - The cause, as relayUnavailableCause names it.
 * @returns {{id: string, text: string, fix: string}[]} Zero or one notice.
 */
export function outboxNeedsYou(linkFile, { cause = null } = {}) {
  const moves = readOutboxSummary(linkFile)?.moves ?? [];
  return outboxNoticeRows({ count: moves.length, parkedOnly: outboxParkedOnly(linkFile), cause });
}
