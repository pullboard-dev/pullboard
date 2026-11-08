/** Supply missing review capacity through locally enrolled wake commands [C7]. */
import { createHash } from 'node:crypto';
import { repoInfo } from '../../../git/index.js';
import { Refused } from '../../../kernel/index.js';
import { takeResource } from '../../../resources/index.js';
import { hasSeatWake } from '../../../seats/index.js';
import { localSeatSessionDigest } from '../../../seats/index.js';
import { wakeRoutedSeat } from '../../../seats/index.js';
import { boardId } from '../../../store/index.js';
import { getItem } from '../../../store/index.js';
import { itemThread } from '../../../store/index.js';
import { listAgents } from '../../../store/index.js';
import { listItems } from '../../../store/index.js';
import { reviewHolder } from '../../../store/index.js';
import { withLocalSeatPresence } from '../../../store/index.js';
import { canonicalFamily } from '../../../store/index.js';
import { eligibilityProblem } from '../../../verify/index.js';
import { ownSessionReviews } from '../../../verify/index.js';

/** The declared review-capacity deadline, independent of a test's execution budget. */
export const REVIEW_WAKE_WAIT_MS = 5 * 60_000;

/** Stable action keys survive repeat scans and a new submitted head starts a fresh wake episode. */
function actionId(item, action, seat = '') {
  return 'review-wake-' + createHash('sha256').update(JSON.stringify([item.item_id, action === 'person' ? null : item.item_commit, action, seat])).digest('hex');
}

/** Keep vendor, material-author and authenticated local-session rules identical to native review. */
function eligible(board, item, seat, config) {
  if (seat.agent_id === 'coordinator' || eligibilityProblem(board, item, seat,
    { policy: config.verify?.policy, familyPolicy: config.verify?.family })) return false;
  try {
    const info = repoInfo(seat.agent_path);
    const digest = localSeatSessionDigest(info, seat.agent_id);
    return !ownSessionReviews(info, board, digest, { listItems }).includes(item.item_id);
  } catch (error) {
    if (error instanceof Refused || ['ENOENT', 'ENOTDIR'].includes(error.code)) return false;
    throw error;
  }
}

/** Observe only native green, unreserved submissions that reached the declared wait. */
function waitingReviews(board) {
  const now = board.clock.now().getTime();
  const submission = board.db.prepare("SELECT event_at,event_detail FROM event WHERE item_id=? AND event_kind='submit' ORDER BY event_id DESC LIMIT 1");
  return listItems(board).filter(item => item.item_status === 'submitted' && !reviewHolder(board, item)).flatMap(item => {
    const event = submission.get(item.item_id);
    if (!event || JSON.parse(event.event_detail).gateGreen !== true || now - Date.parse(event.event_at) < REVIEW_WAKE_WAIT_MS) return [];
    return [{ item, since: event.event_at }];
  }).sort((a, b) => a.since.localeCompare(b.since) || a.item.item_id - b.item.item_id).map(row => row.item);
}

/** A builder may review independently; exclude only seats already holding another review. */
function freeSeats(board) {
  const items = listItems(board);
  return withLocalSeatPresence(board, listAgents(board)).filter(seat => !items.some(item => reviewHolder(board, item) === seat.agent_id));
}

/** Record a native intent while the sweep's private resource lease excludes concurrent local dispatchers. */
async function reserveAction(ctx, board, ordered, item, action, seat = '') {
  const text = JSON.stringify({ reviewCapacity: { actionKey: actionId(item, action, seat), action,
    commit: action === 'person' ? null : item.item_commit, seat: seat || null } });
  if (itemThread(board, item.item_id).some(row => row.type === 'fact' && row.text === text)) return false;
  await ordered(ctx, board, 'appendFact', [item.item_id, { agentId: 'coordinator', kind: 'note', text }]);
  return true;
}

/** Ask once per item, only after local eligible wake commands are absent or have failed. */
async function askPerson(ctx, board, ordered, item, reason) {
  const prefix = `#${item.item_id} needs an independent reviewer:`;
  if (board.db.prepare('SELECT 1 FROM shout WHERE shout_from=? AND shout_to=? AND substr(shout_text,1,?)=?').get('coordinator', 'person', prefix.length, prefix)) return;
  await reserveAction(ctx, board, ordered, item, 'person');
  const builder = canonicalFamily(board, item.item_builder_family);
  const otherFamilies = [...new Set(listAgents(board).map(seat => canonicalFamily(board, seat.agent_family)).filter(family => family && family !== builder))];
  const required = otherFamilies.join(' or ') || `a declared vendor different from ${builder || 'the builder'}`;
  await ordered(ctx, board, 'shout', [{ from: 'coordinator', to: 'person', lanes: [], decision: true,
    text: `#${item.item_id} needs an independent reviewer: ${reason.slice(0, 80)}; required reviewer family: ${required.slice(0, 64)}. Enroll with pullboard join <lane> --family <vendor> --wake <executable>.` }]);
}

/** Run wake commands outside all board writes; only the primary coordinator supplies review capacity. */
export async function wakeReviewCapacity(ctx, board, ordered) {
  const lease = await takeResource({ name: 'review-capacity-wake', capacity: 1, scope: 'repo', root: ctx.info.root,
    agent: 'coordinator', kind: 'review-capacity' });
  try { await dispatchReviewCapacity(ctx, board, ordered); }
  finally { lease.release(); }
}

/** Match current queue demand to free eligible capacity inside this sweep's private dispatch lease. */
async function dispatchReviewCapacity(ctx, board, ordered) {
  const used = new Set();
  const identity = boardId(board);
  for (const item of waitingReviews(board)) {
    const seats = freeSeats(board).filter(seat => eligible(board, item, seat, ctx.config));
    const awake = seats.find(seat => seat.presence === 'live' && !used.has(seat.agent_id));
    if (awake) { used.add(awake.agent_id); continue; }
    const registered = seats.filter(seat => ['idle', 'gone'].includes(seat.presence) && hasSeatWake(ctx.info, { boardId: identity, seat }));
    if (!registered.length) { await askPerson(ctx, board, ordered, item, 'no eligible local wake command is registered'); continue; }
    let failed = false;
    for (const seat of registered.filter(seat => !used.has(seat.agent_id))) {
      const current = getItem(board, item.item_id);
      if (current.item_status !== 'submitted' || current.item_commit !== item.item_commit || reviewHolder(board, current)) break;
      if (!eligible(board, current, seat, ctx.config)) continue;
      if (!await reserveAction(ctx, board, ordered, current, 'attempt', seat.agent_id)) break;
      used.add(seat.agent_id);
      const result = await wakeRoutedSeat(ctx.info, { boardId: identity, seat, item: item.item_id });
      await ordered(ctx, board, 'appendFact', [item.item_id, { agentId: 'coordinator', kind: 'note',
        text: JSON.stringify({ reviewCapacity: { action: 'result', commit: item.item_commit, seat: seat.agent_id, ...result } }) }]);
      if (result.woke) { failed = false; break; }
      failed = true;
    }
    if (failed) await askPerson(ctx, board, ordered, item, 'the eligible registered reviewer wake commands failed');
  }
}
