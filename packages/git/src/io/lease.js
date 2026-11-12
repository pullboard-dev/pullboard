import { randomUUID } from 'node:crypto';
import { headCommit } from "./main.js";
import { Refused } from "../../../kernel/light.js";

/** Keep only this queued command's live item lease, using ordinary ordered board moves. */
export function createQueuedItemLease(ctx, initial, agentId, kind, admission, { getItem, withBoard, ordered, claimFreezer, gateWaitReporter }) {
  const report = gateWaitReporter(ctx.io);
  // Naming somebody else's check remains read-only; it never extends their build claim.
  if (kind === 'build' && (initial.item_status !== 'claimed' || initial.item_owner !== agentId)) return report;
  const review = kind === 'review';
  // Accepted items retain their former reviewer as history, not a renewable reservation.
  if (review && (initial.item_status !== 'submitted' || initial.item_review_by !== agentId)) return report;
  const field = review ? 'item_review_until' : 'item_lease_until';
  const owner = review ? 'item_review_by' : 'item_owner';
  const status = review ? 'submitted' : 'claimed';
  const leaseMs = review ? ctx.config.reviewLeaseMs : ctx.config.leaseMs;
  const expected = { digest: initial.item_frozen_digest, commit: initial.item_commit };
  let confirmedLeaseUntil = '';
  return async (state) => {
    if (!state.admitted) report(state);
    const now = ctx.clock.now().getTime();
    // Queue polling is frequent; reopen the board only when renewal is due or admission starts.
    if (!state.admitted && Date.parse(confirmedLeaseUntil) - now > leaseMs / 2) {
      return { leaseUntil: confirmedLeaseUntil };
    }
    return await withBoard(ctx, async (board) => {
      const current = getItem(board, initial.item_id);
      const expires = Date.parse(current[field]);
      if (current.item_status !== status || current[owner] !== agentId || !Number.isFinite(expires) || expires <= now
        || current.item_frozen_digest !== expected.digest || current.item_commit !== expected.commit) {
        throw new Refused('ITEM_LEASE_LOST', `the queued ${review ? 'review' : 'build'} lease for #${initial.item_id} changed or expired; claim or reserve the item again before retrying`);
      }
      if (state.admitted || expires - now <= leaseMs / 2) {
        const witness = state.admitted && admission ? { id: randomUUID(), commit: admission.commit, tree: admission.tree } : null;
        const result = await ordered(ctx, board, review ? 'reserveReview' : 'claim', [initial.item_id, {
          agentId, leaseMs,
          ...(witness ? { submitAdmission: witness } : {}),
          ...(review ? { policy: ctx.config.verify.policy, familyPolicy: ctx.config.verify.family }
            : { lane: current.item_lane, freeze: claimFreezer(ctx), head: headCommit(ctx.info.root) }),
        }]);
        confirmedLeaseUntil = review ? result.item_review_until : result.leaseUntil;
        if (witness) admission.id = witness.id;
        return { leaseUntil: confirmedLeaseUntil };
      }
      confirmedLeaseUntil = current[field];
      return { leaseUntil: confirmedLeaseUntil };
    });
  };
}

