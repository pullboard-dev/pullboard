/** A landing reopen whose own accept and green gate still hold returns to verified without new work [C7]. */
import { createHash } from 'node:crypto';
import { atomic } from '../../io/board.js';
import { getItem } from '../../io/board.js';
import { logEvent } from '../../io/board.js';
import { moveItem } from '../../io/board.js';
import { acceptedVerdict } from '../../io/board.js';
import { appendFact } from '../../io/board.js';
import { IN_STATE } from '../../../../state/index.js';
import { COORDINATOR } from '../../../../config/index.js';
import { Refused } from '../../../../kernel/index.js';

const HEX = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const LIFECYCLE = ['claim', 'submit', 'release', 'accept', 'reject', 'reopen', 'refreeze', 'withdraw', 'merged', 'merge-only-accept', 'reland'];

/**
 * The accept an open item can land on again, or null.
 * Why: a landing-failure reopen keeps the accept at the head (only --withdraw-verdict withdraws it), but it sent the
 * item back to open even when its own gate was green and the red was batch-wide, so accepted work stopped landing.
 * Each accept relands at most once, so a second landing failure leaves the item open for its builder.
 *
 * @param {any} board
 * @param {any} item
 * @returns {{ accept: any, reopenEvent: number } | null}
 */
export function acceptedRelandCandidate(board, item) {
  if (item?.item_status !== 'open' || item.item_merged_commit || !HEX.test(item.item_commit ?? '') || !item.item_frozen_digest) return null;
  const marks = LIFECYCLE.map(() => '?').join(',');
  const last = board.db.prepare(`SELECT event_id, event_kind, event_detail FROM event WHERE item_id=? AND event_kind IN (${marks}) ORDER BY event_id DESC LIMIT 1`)
    .get(item.item_id, ...LIFECYCLE);
  if (last?.event_kind !== 'reopen') return null;
  const reopened = JSON.parse(last.event_detail);
  if (!reopened.landingFailure || reopened.withdrawnVerdict || reopened.commit !== item.item_commit) return null;
  const accept = acceptedVerdict(board, item);
  if (!accept || accept.verdict_decision !== 'ACCEPT' || accept.verdict_commit !== item.item_commit
    || accept.verdict_digest !== item.item_frozen_digest || !accept.verdict_by || accept.verdict_by === item.item_built_by) return null;
  const relanded = board.db.prepare("SELECT 1 FROM event WHERE item_id=? AND event_kind='reland' AND json_extract(event_detail,'$.accept')=? LIMIT 1")
    .get(item.item_id, accept.verdict_id);
  if (relanded) return null;
  const submit = board.db.prepare("SELECT event_detail FROM event WHERE item_id=? AND event_kind='submit' ORDER BY event_id DESC LIMIT 1").get(item.item_id);
  const submitted = submit ? JSON.parse(submit.event_detail) : null;
  if (submitted?.commit !== item.item_commit || submitted.criterionDigest !== item.item_frozen_digest || submitted.gateGreen !== true) return null;
  return { accept, reopenEvent: last.event_id };
}

/** One stable fact identity per item head and conflicting path set, so a repeated landing records it once. */
function relandConflictFactId(item, conflicts) {
  return 'reland-' + createHash('sha256').update(JSON.stringify([item.item_id, item.item_commit, conflicts])).digest('hex').slice(0, 40);
}

/** Whether this head's conflict with these paths is already on the item, so landing need not write it again. */
export function relandConflictRecorded(board, item, conflicts) {
  return Boolean(board.db.prepare("SELECT 1 FROM event WHERE item_id=? AND event_kind='fact' AND json_extract(event_detail,'$.id')=? LIMIT 1")
    .get(item.item_id, relandConflictFactId(item, conflicts)));
}

/**
 * Return a candidate to verified when its head merges cleanly onto `main`, or leave it open with a fact naming the
 * files Git reported as conflicting. The caller ran the merge; the move records its result.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, main: string, conflicts?: string[] }} request
 */
export function relandAccepted(board, id, { agentId, main, conflicts = [] }) {
  return atomic(board, () => {
    if (agentId !== COORDINATOR) throw new Refused('COORDINATOR_ONLY', 'only the coordinator returns landed work to verified; landing does it');
    if (!HEX.test(main ?? '') || !Array.isArray(conflicts) || conflicts.some(file => typeof file !== 'string' || !file || file.includes('\0'))
      || JSON.stringify(conflicts) !== JSON.stringify([...new Set(conflicts)].sort())) {
      throw new Refused('BAD_RELAND', 'name the trunk commit and the sorted unique conflicting paths Git reported');
    }
    const item = getItem(board, id);
    const candidate = acceptedRelandCandidate(board, item);
    if (!candidate) throw new Refused('RELAND_NOT_ELIGIBLE', `item #${id} is not an open landing return whose own accept and green gate still hold; see pullboard show ${id}`);
    const { accept } = candidate;
    if (conflicts.length) {
      if (!relandConflictRecorded(board, item, conflicts)) appendFact(board, id, { agentId, kind: 'measurement', factId: relandConflictFactId(item, conflicts),
        text: `Accepted head ${item.item_commit} conflicts with main ${main} in ${conflicts.join(', ')}; it stays open for its builder to merge main and resubmit` });
      return { id, relanded: false, conflicts };
    }
    moveItem(board, id, 'reland', {
      checks: {
        coordinatorOnly: () => (agentId === COORDINATOR ? null : new Refused('COORDINATOR_ONLY', 'only the coordinator returns landed work to verified')),
        [IN_STATE]: () => new Refused('RELAND_NOT_ELIGIBLE', `item #${id} is no longer open`),
        atSubmittedCommit: found => found.item_commit === accept.verdict_commit ? null : new Refused('NOT_AT_COMMIT', 'the accept names another commit'),
        notBuilder: found => found.item_built_by !== accept.verdict_by ? null : new Refused('SELF_VERIFY', 'the accept is the builder\'s own'),
        criterionUnchanged: found => found.item_frozen_digest === accept.verdict_digest ? null : new Refused('CRITERIA_CHANGED', 'the bar changed since the accept'),
        // The accept being relanded must carry the note that proved it; an accept without one proves nothing.
        proofNoted: () => String(accept.verdict_note ?? '').trim() ? null : new Refused('PROOF_REQUIRED', 'the accept being relanded records no proof note'),
      },
      set: () => ({ item_verdict: 'ACCEPT', item_verified_by: accept.verdict_by }),
    });
    logEvent(board, agentId, 'reland', id, { commit: item.item_commit, accept: accept.verdict_id, verifiedBy: accept.verdict_by,
      digest: accept.verdict_digest, reopen: candidate.reopenEvent, main });
    return { id, relanded: true, commit: item.item_commit, accept: accept.verdict_id };
  });
}
