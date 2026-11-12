/** A red queued gate leads its builder's next, inbox and claim with the exact refusal [V4,H16,N2]. */
import { current } from '../board/query.js';
import { submitHandoff } from '../submit/handoff/records.js';
import { submitHandoffFailure } from '../submit/handoff/records.js';

/**
 * The seat's own claimed items whose queued gate went red, each with its retained refusal.
 * Why: the cause sat unread in refusal.json while builders saw only a generic release note (#2454).
 *
 * @param {any} board
 * @param {string} seat
 * @returns {{ id: number, title: string, leaseUntil: string, error: { code: string, message: string, next: string } }[]}
 */
export function queuedReds(board, seat) {
  const observedThrough = board.db.prepare('SELECT COALESCE(MAX(event_id),0) AS id FROM event').get().id;
  return board.db.prepare("SELECT * FROM item WHERE item_status='claimed' AND item_owner=? ORDER BY item_id").all(seat)
    .map(item => ({ item, error: submitHandoffFailure(board, item), job: submitHandoff(board, item.item_id),
      eventId: board.db.prepare('SELECT MAX(event_id) AS id FROM event WHERE item_id=?').get(item.item_id).id }))
    .filter(row => row.error)
    .map(({ item, error, job, eventId }) => ({ id: item.item_id, title: item.item_title, leaseUntil: item.item_lease_until,
      lapsed: current(board, item).item_status !== 'claimed', commit: job.commit, eventId, observedThrough, error }));
}

/**
 * What the notice says about the seat's hold on a red item: still held until the lease, or lapsed.
 * Why: a past lease read "stays claimed by you until <past time>" though the claim was gone (SM13).
 *
 * @param {{ id: number, leaseUntil: string, lapsed?: boolean }} red - lapsed is the board's own reading through current()
 * @param {number} now - epoch milliseconds, used only when the red carries no reading
 * @returns {string}
 */
function holdSentence(red, now) {
  const lapsed = red.lapsed ?? (Number.isFinite(Date.parse(red.leaseUntil)) && Date.parse(red.leaseUntil) <= now);
  return lapsed
    ? `#${red.id} claim lapsed at ${red.leaseUntil}; re-claim it with pullboard claim ${red.id}, fix it, commit, then pullboard submit ${red.id}`
    : `#${red.id} stays claimed by you until ${red.leaseUntil}; fix it, commit, then pullboard submit ${red.id}`;
}

/**
 * The lines that put each red first: code, full message and next step, then how to resume.
 *
 * @param {ReturnType<typeof queuedReds>} reds
 * @param {number} [now] - epoch milliseconds the lease is compared with
 * @returns {string[]}
 */
export function queuedRedLines(reds, now = Date.now()) {
  return reds.flatMap(red => [
    `red queued gate on #${red.id} ${red.title}: ${red.error.code}: ${red.error.message}`,
    `next: ${red.error.next}`,
    holdSentence(red, now),
  ]);
}

/**
 * A bounded notice for the default loop: one line per red and a pointer to the full refusal, within a byte budget.
 * Why: the default `pullboard next` must stay under 2 KB; the full refusal stays one `pullboard show` away.
 *
 * @param {ReturnType<typeof queuedReds>} reds
 * @param {number} [budget] - the most bytes the notice may take
 * @param {number} [now] - epoch milliseconds the lease is compared with
 * @returns {string[]}
 */
export function boundedQueuedRedLines(reds, budget = 1024, now = Date.now()) {
  const lines = [];
  let used = 0;
  for (const [index, red] of reds.entries()) {
    const head = `red queued gate on #${red.id}: ${red.error.code}; pullboard show ${red.id} for the full refusal`;
    const resume = holdSentence(red, now);
    const size = Buffer.byteLength(head) + Buffer.byteLength(resume);
    if (used + size > budget) {
      lines.push(`${reds.length - index} more red queued gates: pullboard show <id> for each`);
      break;
    }
    lines.push(head, resume);
    used += size;
  }
  return lines;
}

/**
 * Print this seat's reds before anything else a command says; a seat that cannot be read prints nothing.
 * Why: a missing seat is the command's own refusal to make, never this notice's. The default loop prints the bounded form.
 *
 * @param {any} io
 * @param {any} board
 * @param {(() => { id: string }) } seat
 * @param {{ bounded?: boolean }} [options]
 * @returns {number} how many reds were printed
 */
export function sayQueuedReds(io, board, seat, { bounded = false } = {}) {
  let me;
  try { me = seat(); }
  catch { return 0; }
  const reds = queuedReds(board, me.id);
  const now = board.clock.now().getTime();
  for (const line of bounded ? boundedQueuedRedLines(reds, 1024, now) : queuedRedLines(reds, now)) io.say(line);
  return reds.length;
}
