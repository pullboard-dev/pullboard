/** Which shouts to the coordinator are still open, and the one line next prints about them [N2,C7]. */

/** A call-out older than this makes next speak up. */
export const CALLOUT_AGE_MS = 15 * 60 * 1000;

/** Item events that mean the subject of a call-out moved on: a hold lifted, an edit, a withdrawal, a requeue. */
export const SUBJECT_CHANGE_KINDS = Object.freeze(['unhold_item', 'unhold', 'withdraw', 'release', 'reopen', 'refreeze', 'edit', 'edit_item', 'merged', 'claim', 'submit', 'accept', 'reject']);

/** The item states a call-out can still be about: held, open or claimed; anything verified, submitted, merged or withdrawn has moved on. */
export const OPEN_SUBJECT_STATUSES = Object.freeze(['open', 'claimed']);

/**
 * The four kinds of shout to the coordinator that need a coordinator action: a sentinel needs-a-sharper-bar, a dead
 * queued gate, two send-backs at the strongest route, and a builder decision request. Takeover notices, released-claim
 * notices, health notes and every Resolved: line never count.
 * Why: counting the whole shout history printed 10,740 unanswered call-outs, the oldest 784 h, on 8 Nov (#3735).
 */
const ACTIONABLE = [/needs a sharper bar/u, /^Queued gate for #\d+ /u, /has two send-backs/u, /^Stuck: decision #\d+ unanswered/u, /\bdecision request\b/iu];

/** Whether a shout's text asks the coordinator to act. */
export function actionableCallout(text) {
  const value = String(text ?? '');
  return !/^Resolved:/u.test(value) && ACTIONABLE.some(rule => rule.test(value));
}

/** The item a call-out is about: the first #id in its text, or null. */
export function calloutSubject(text) {
  const match = /#(\d+)/u.exec(String(text ?? ''));
  return match ? Number(match[1]) : null;
}

/**
 * Keep the call-outs still open: not answered, and (when they name an item) that item has not changed since.
 *
 * @param {{ id: number, at: string, text: string }[]} callouts shouts addressed to the coordinator
 * @param {Set<number>} answered shout ids that have an answer
 * @param {(item: number, since: string) => boolean} changedSince whether the item changed after the shout
 * @param {(item: number) => boolean} [subjectOpen] whether the named item is still held, open or claimed
 * @returns {{ id: number, at: string, text: string, item: number | null }[]}
 */
export function openCallouts(callouts, answered, changedSince, subjectOpen = () => true) {
  return callouts.map(callout => ({ ...callout, item: calloutSubject(callout.text) })).filter(callout =>
    !answered.has(callout.id) && !(callout.item !== null && (changedSince(callout.item, callout.at) || !subjectOpen(callout.item))));
}

/** Age as the shortest plain words: 20 min, 2 h 10 min. */
export function plainAge(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/**
 * The one line for builders, or null while none is open past the threshold.
 *
 * @param {{ at: string }[]} open
 * @param {number} nowMs
 * @param {boolean} hasCoordinatorSeat whether the board has a coordinator seat; without one the person is told
 * @returns {string | null}
 */
export function calloutLine(open, nowMs, hasCoordinatorSeat) {
  if (!open.length) return null;
  const oldest = Math.max(...open.map(callout => nowMs - Date.parse(callout.at)));
  if (!(oldest > CALLOUT_AGE_MS)) return null;
  const who = hasCoordinatorSeat ? 'whoever runs the coordinator' : 'the person who owns this board';
  return `${open.length} unanswered ${open.length === 1 ? 'call-out' : 'call-outs'} to the coordinator, oldest ${plainAge(oldest)}; the coordinator runs pullboard inbox to see ${open.length === 1 ? 'it' : 'them'}; tell ${who}`;
}
