import * as store from "./board.js";
import { nextWithReleaseCooldown } from "./cooldown.js";
import { heldClaim } from "./claim.js";
import { submitHandoff } from "./submit/handoff/records.js";

/**
 * Select one piece of work for the already-resolved native seat without opening another seat or
 * reserving anything. Existing live claims take precedence; expired leases are projected as open by the board
 * and may be reclaimed through the same eligibility guards as other open work.
 * A live review held by this seat precedes new review work; otherwise eligible reviews precede
 * builds, matching the interactive next command's review-first behavior.
 *
 * @param {any} board
 * @param {{ agent_id: string, agent_lane: string }} nativeSeat - The exact seat resolved by the caller.
 * @param {{ policy?: string, familyPolicy?: string, skipIds?: number[], assignedIds?: number[], reviewHeartbeats?: Map<string, string | null> | null, releaseCooldown?: { minutes: number, now: number } | null }} [options]
 * @returns {{ item: any | null, review: boolean, held: boolean, reasons: string[] }}
 */
export function dispatchWork(board, nativeSeat, { policy = 'any', familyPolicy = 'off', skipIds = [], assignedIds = [], priority = [], observeIdle = false, workingFiles = new Map(), reviewHeartbeats = null, releaseCooldown = null } = {}) {
  const agentId = nativeSeat.agent_id;
  const lane = nativeSeat.agent_lane;

  const held = heldClaim(board, agentId);
  // A claim whose own gate stopped on infrastructure waits on the machine, so the seat reviews meanwhile (#3103).
  const stopped = held && stoppedOnInfrastructure(board, held) ? held : null;
  const claim = stopped ? null : held;
  if (claim) return { item: claim, review: false, held: true, reasons: [] };

  const heldReview = store.listItems(board).find(item => item.item_status === 'submitted'
    && store.reviewHolder(board, item) === agentId);
  if (heldReview) return { item: heldReview, review: true, held: true, reasons: [] };
  const review = store.nextFor(board, { agentId, lane, verify: true, policy, familyPolicy, skipIds, sessionIds: skipIds, omitIds: assignedIds, priority, observeIdle, reviewHeartbeats });
  if (review.item) {
    return { item: review.item, review: true, held: store.reviewHolder(board, review.item) === agentId, reasons: review.reasons };
  }
  if (stopped) return { item: stopped, review: false, held: true, reasons: [] };

  // A seat's own recent releases wait out the cooldown unless nothing else is open for it (#2587); off when not passed.
  const build = nextWithReleaseCooldown(board, { agentId, lane, policy, familyPolicy, skipIds, omitIds: assignedIds, observeIdle, workingFiles },
    releaseCooldown?.minutes ?? 0, store.nextFor, releaseCooldown?.now);
  return { item: build.item, review: false, held: false, ...(observeIdle && !build.item ? { skips: [...(review.skips ?? []), ...(build.skips ?? [])].filter((row, index, rows) => rows.findIndex(other => other.item === row.item) === index).slice(0, 3), idleReason: [review.idleReason, build.idleReason].find(reason => ['held', 'review-family', 'main-red'].includes(reason)) ?? build.idleReason ?? 'unknown' } : {}), reasons: build.item ? build.reasons : [...new Set([...review.reasons, ...build.reasons])] };
}

/**
 * Whether this claim's own queued gate, for its frozen bar, ended GATE_INFRA_EXHAUSTED: the work is done and only
 * the machine owes a rerun, so holding the claim must not keep its seat from reviewing [C7,#3103].
 *
 * @param {any} board
 * @param {any} item - A claimed item.
 * @returns {boolean}
 */
function stoppedOnInfrastructure(board, item) {
  const job = submitHandoff(board, item.item_id);
  return Boolean(job && job.agentId === item.item_owner && job.digest === item.item_frozen_digest
    && job.state === 'infrastructure' && job.error?.code === 'GATE_INFRA_EXHAUSTED');
}
